import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CommandBus } from '../../core/commandBus.ts';
import type { Project, RuleSet } from '../../core/types.ts';
import { renderScene } from '../../viewport/renderer.ts';
import { defaultHiddenLayers } from '../../viewport/layers.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  草案缩略图 —— 对话里那张"大体结构"图
 *
 *  ── 为什么直接调主渲染器 `renderScene`，而不是另写一套简笔画 ──
 *    另写一套意味着：墙怎么画、柜体什么颜色、旋转怎么落位，全都有第二份实现。
 *    第二份实现一定会在某次改动后和主视图分叉 —— 用户在这张小图上看到"摆得下"，
 *    点开主视图却是另一回事，那这张图就成了骗人的图。
 *    现在它吃的 `scene` 与主视图是同一种结构（`{ project, geom }`），
 *    只是换了一个相机：**同一份派生几何，两个视图**。
 *
 *  ── 这张图是"大体结构"，不是生产图 ──
 *    它不画标注、不画尺寸线、不画板件分缝。它只回答一件事：
 *    "房间和柜子大概摆在什么位置、比例对不对"。
 *    要出图请用四视图；要改细节请在定稿后的可编辑模型上改。
 *
 *  ── 空草案不许画成一个空白色块 ──
 *    空白画布会被读成"画失败了"。没有东西可画时明确写一句话。
 * ══════════════════════════════════════════════════════════════════════
 */

export function DraftPreview(props: {
  project: Project;
  rules: RuleSet;
  /** 画布高度（CSS 像素） */
  height?: number;
}): ReactNode {
  const height = props.height ?? 168;
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [w, setW] = useState(300);

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

  /**
   * 用一根沙盒总线派生几何 —— 与真总线同一个 derive，同一套规则。
   * 草案不是真总线里的东西，只能这样拿派生结果；好在这是纯计算，不产生副作用。
   */
  const scene = useMemo(() => {
    const bus = new CommandBus(props.project, props.rules);
    return { project: props.project, geom: bus.derive().geom };
  }, [props.project, props.rules]);

  const stats = useMemo(() => {
    const cabs = props.project.cabinets;
    const rooms = props.project.rooms;
    const errs = Object.values(scene.geom.cabinets).reduce(
      (n, g) => n + g.issues.filter((i) => i.severity === 'ERROR').length,
      0,
    );
    return { cabCount: cabs.length, roomCount: rooms.length, errs, cabs };
  }, [props.project, scene]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    el.width = Math.max(1, Math.round(w * dpr));
    el.height = Math.max(1, Math.round(height * dpr));
    const ctx = el.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bbox = scene.geom.bbox;
    if (!bbox || stats.cabCount + stats.roomCount === 0) {
      ctx.clearRect(0, 0, w, height);
      return;
    }
    const bw = Math.max(1, bbox.max.x - bbox.min.x);
    const bh = Math.max(1, bbox.max.y - bbox.min.y);
    // 留 12% 边距，否则贴边的墙会被裁掉半条，看起来像"少画了一面墙"
    const scale = Math.min((w * 0.88) / bw, (height * 0.88) / bh);

    renderScene({
      ctx,
      vw: w,
      vh: height,
      cam: { cx: (bbox.min.x + bbox.max.x) / 2, cy: (bbox.min.y + bbox.max.y) / 2, scale },
      scene,
      mode: 'plan',
      selection: [],
      hover: null,
      hoverGrip: null,
      activeGrip: null,
      hiddenLayers: defaultHiddenLayers(),
      showGrid: false,
      snap: null,
      marquee: null,
      draftWall: null,
      explodePrims: [],
    });
  }, [w, height, scene, stats]);

  return (
    <div className="draft-preview">
      <div className="draft-canvas-wrap" style={{ height }}>
        <canvas ref={ref} className="draft-canvas" style={{ width: '100%', height }} />
        {stats.cabCount + stats.roomCount === 0 ? (
          <div className="draft-canvas-empty">草案里还没有房间和柜体</div>
        ) : null}
      </div>
      <div className="draft-summary">
        <span>
          {stats.roomCount} 房间 · {stats.cabCount} 柜体
        </span>
        {stats.errs > 0 ? <span className="draft-err">{stats.errs} 条 ERROR</span> : null}
      </div>
      {stats.cabCount > 0 ? (
        <ul className="draft-cab-list">
          {stats.cabs.map((c) => (
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
