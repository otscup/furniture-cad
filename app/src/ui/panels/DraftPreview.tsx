import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CommandBus } from '../../core/commandBus.ts';
import type { BBox, Prim, Project, RuleSet, Vec2 } from '../../core/types.ts';
import { buildCabinetViews, VIEW_NAME, type ViewKind } from '../../core/geometry/views.ts';
import { drawPrims } from '../../viewport/renderer.ts';
import { defaultHiddenLayers } from '../../viewport/layers.ts';
import { fitBBox, worldToScreen } from '../../viewport/camera.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  草案草图 —— 对话里那张图
 *
 *  ── 为什么默认画**正面图**，不画俯视平面图 ──
 *     （一次真实反馈：用户在"房间2生成一个 L 形橱柜"，回来看到的是
 *      **房间的轮廓图**，于是以为"AI 把房间的图形复制出来了"。）
 *     原因就是缺口和实际体验相反：
 *       · 俯视图的画框是整个项目（房间 4000×3000），新柜只有 2200×850 ——
 *         画面被房间占满，柜子成为两条细边；
 *       · 而**这一轮有没有真的建成柜子**，在俯视图里几乎看不出来 ——
 *         一旦这一轮没并进草案，画面就和上一轮一模一样，等于"什么都不说"。
 *     立面图（正面图）反过来：画框是柜体自己，宽高就是用户说的那两个数，
 *     一眼能核对"是不是 2200×900"，也一眼能看出"这一轮有没有东西"。
 *
 *  ── 仍然不给墙 ——
 *     房间不是这次要改的对象。画出来只会让人以为 AI 动了房间。
 *     要看房间里的落位请用主视图，「俯视」那一档也是只画柜体、不画墙。
 *
 *  ── 仍然用同一套画法（不是在这里另写一套简笔画）──
 *     图元来自 `buildCabinetViews`（四视图用的那个生成器），
 *     落笔用的是 `drawPrims` —— 与主视图、出图共用同一份画法。
 *     只有"怎么在画布上排"是这里的事，而排版本来也不该由生成器决定。
 *
 *  ── 空草案不许画成一个空白色块 ──
 *    空白画布会被读成"画失败了"。没有东西可画时明确写一句话。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 草图可选的三种看法 —— 与四视图里的 ViewKind 同源，不另起一套名字 */
const DRAFT_VIEWS: ViewKind[] = ['front', 'internal', 'top'];

export function DraftPreview(props: {
  project: Project;
  rules: RuleSet;
  /**
   * 只画这个房间里的柜体。传了就不画别处的柜体 ——
   * 会话是"跟某个房间一对一"，草图跟着同一个范围，免得让人怀疑改了别处。
   */
  roomId?: string;
  /** 房间名，仅用于"这个房间里还没有柜体"时把话说清楚 */
  roomLabel?: string;
  /** 画布高度（CSS 像素） */
  height?: number;
}): ReactNode {
  const height = props.height ?? 176;
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [w, setW] = useState(300);
  const [view, setView] = useState<ViewKind>('front');
  /** 生成失败的柜体要说出来 —— 静默跳过会被读成"AI 没画" */
  const [buildErr, setBuildErr] = useState('');

  // 面板宽度随窗口变化；读不到就退回 300，不让画布塌成 0 宽
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setW(el.clientWidth || 300);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cabs = useMemo(
    () => (props.roomId ? props.project.cabinets.filter((c) => c.roomId === props.roomId) : props.project.cabinets),
    [props.project, props.roomId],
  );
  /** 别的房间里有几个 —— 房间级会话里"本房间没柜体"必须说清是"没有"还是"不在这" */
  const otherCount = props.roomId ? props.project.cabinets.length - cabs.length : 0;

  /**
   * 派生一次拿到俯视图元（side / front 那几份由 buildCabinetViews 现算）。
   * 用沙盒总线派生：草案不是真总线里的东西，只能这样拿派生结果，纯计算无副作用。
   */
  const geom = useMemo(() => {
    const bus = new CommandBus(props.project, props.rules);
    return bus.derive().geom;
  }, [props.project, props.rules]);

  /** 这一屏要画的图元 —— 已经排好左右的版，坐标可直接喂 fitBBox */
  const laid = useMemo(() => layoutDraftView({ project: props.project, rules: props.rules, geomPlanOf: (id) => geom.cabinets[id]?.plan ?? [], cabs, view }), [props.project, props.rules, geom, cabs, view]);

  useEffect(() => {
    setBuildErr(laid.err);
  }, [laid]);

  const stats = useMemo(() => {
    const errs = cabs.reduce((n, c) => n + (geom.cabinets[c.id]?.issues ?? []).filter((i) => i.severity === 'ERROR').length, 0);
    return { cabCount: cabs.length, errs };
  }, [cabs, geom]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.max(1, Math.round(w * dpr));
    el.height = Math.max(1, Math.round(height * dpr));
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!laid.bbox || laid.prims.length === 0) {
      ctx.clearRect(0, 0, w, height);
      return;
    }
    const cam = fitBBox(laid.bbox, w, height, 10);
    const to = (p: Vec2): Vec2 => worldToScreen(p, cam, w, height);
    drawPrims(ctx, laid.prims, to, defaultHiddenLayers(), cam.scale);
  }, [w, height, laid]);

  return (
    <div className="draft-preview">
      <div className="draft-viewbar">
        {DRAFT_VIEWS.map((k) => (
          <button
            key={k}
            type="button"
            className={`draft-view-btn ${view === k ? 'on' : ''}`}
            onClick={() => setView(k)}
            title={VIEW_NAME[k]}
          >
            {VIEW_NAME[k]}
          </button>
        ))}
        <span className="draft-view-count">{stats.cabCount} 个柜体</span>
        {stats.errs > 0 ? <span className="draft-err">{stats.errs} 条 ERROR</span> : null}
      </div>

      <div className="draft-canvas-wrap" style={{ height }}>
        <canvas ref={ref} className="draft-canvas" style={{ width: '100%', height }} />
        {stats.cabCount === 0 ? (
          <div className="draft-canvas-empty">
            {otherCount > 0
              ? `「${props.roomLabel ?? '这个房间'}」里还没有柜体 —— 草案里那 ${otherCount} 个在别的房间`
              : '草案里还没有柜体'}
          </div>
        ) : null}
        {stats.cabCount > 0 && laid.prims.length === 0 && !laid.err ? (
          <div className="draft-canvas-empty">这张图没有可画的图元</div>
        ) : null}
      </div>

      {buildErr ? <div className="draft-build-err">有柜体画不出来：{buildErr}</div> : null}

      {cabs.length > 0 ? (
        <ul className="draft-cab-list">
          {cabs.map((c) => (
            <li key={c.id}>
              <b>{c.name}</b>
              <span className="mono">
                {c.params.width}×{c.params.height}×{c.params.depth}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ─────────────────────────── 排版（只做"怎么摆"，图元本身来自生成器）───────────────────────────

const VIEW_GAP = 240;

function translatePrims(prims: Prim[], dx: number, dy: number): Prim[] {
  return prims.map((p) => {
    if (p.k === 'poly' || p.k === 'fill') {
      return { ...p, pts: p.pts.map((q) => ({ x: q.x + dx, y: q.y + dy })) };
    }
    return { ...p, p: { x: p.p.x + dx, y: p.p.y + dy } };
  });
}

function primsBBox(prims: Prim[]): BBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const eat = (p: Vec2): void => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };
  for (const p of prims) {
    if (p.k === 'poly' || p.k === 'fill') for (const q of p.pts) eat(q);
    else eat(p.p);
  }
  if (!Number.isFinite(minX)) return null;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function layoutDraftView(opts: {
  project: Project;
  rules: RuleSet;
  geomPlanOf: (cabinetId: string) => Prim[];
  cabs: Project['cabinets'];
  view: ViewKind;
}): { prims: Prim[]; bbox: BBox | null; err: string } {
  const out: Prim[] = [];
  let err = '';
  let cursor = 0;

  for (const cab of opts.cabs) {
    // 俯视：直接用已经派生好的平面图元（世界坐标，原样画，不摆 cam 到别的房间去）
    if (opts.view === 'top') {
      const plan = opts.geomPlanOf(cab.id);
      if (plan.length === 0) continue;
      out.push(...plan);
      continue;
    }
    try {
      const vs = buildCabinetViews(cab, opts.rules);
      const local = vs.prims[opts.view] ?? [];
      if (local.length === 0) continue;
      const bb = primsBBox(local);
      if (!bb) continue;
      // 逐柜把左下角对齐到 cursor：不同高度的柜体按底边齐平，才看得出"谁更高"
      out.push(...translatePrims(local, cursor - bb.min.x, -bb.min.y));
      cursor += bb.max.x - bb.min.x + VIEW_GAP;
    } catch (e) {
      err = err || `「${cab.name}」${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return { prims: out, bbox: primsBBox(out), err };
}
