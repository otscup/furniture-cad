import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, PointerEvent as RPointerEvent, SetStateAction, MouseEvent as ReactMouseEvent } from 'react';
import type { Cabinet, Project, Vec2, Wall } from '../core/types.ts';
import type { Command, CommandBus } from '../core/commandBus.ts';
import { generateProject } from '../core/geometry/project.ts';
import { DEFAULT_WALL_THICKNESS } from '../core/docFactory.ts';
import type { Camera } from '../viewport/camera.ts';
import { fitBBox, niceGridStep, panByScreen, screenToWorld, zoomAt } from '../viewport/camera.ts';
import type { SnapResult, SnapSettings } from '../viewport/snapping.ts';
import { collectSnapNodes, resolveSnap, snapKindLabel, snapToleranceWorld } from '../viewport/snapping.ts';
import type { Grip } from '../viewport/hitTest.ts';
import { boxSelect, hitPart, hitTest } from '../viewport/hitTest.ts';
import { camDebug } from '../viewport/camDebug.ts';
import type { PickLine } from '../core/geometry/pickLines.ts';
import { planCabinetGripDrag, planWallGripDrag } from '../viewport/gripDrag.ts';
import type { SheetDragSpec } from '../viewport/sheetDrag.ts';
import { dragPlanOf, dragValueOf, dragClamped } from '../viewport/sheetDrag.ts';
import type { Scene } from '../viewport/renderer.ts';
import { renderScene } from '../viewport/renderer.ts';
import * as CMD from '../core/commands.ts';
import type { Tool, ToastKind } from './types.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  2D 工作台视口
 *
 *  这一层的唯一职责：把"指针事件"翻译成"语义命令"。
 *  它【不写模型】——所有写操作都通过 props.bus.execute(cmd)。
 *  它【也不画几何】——只是把 Scene 交给 renderer。
 *
 *  拖动过程中屏幕上的变化来自 bus.preview(cmd)，即
 *  "真实管线跑在试探模型上"。因此拖动看到的结果 == 松手提交后的结果。
 * ══════════════════════════════════════════════════════════════════════
 */

type Drag =
  | { kind: 'pan'; last: Vec2 }
  | { kind: 'marquee'; a: Vec2; b: Vec2 }
  | { kind: 'grip'; grip: Grip; cab: Cabinet | null; wall: Wall | null; startPointer: Vec2 }
  | { kind: 'body'; cabs: Cabinet[]; startPointer: Vec2 }
  /**
   * 图纸上拖动一条线 = 改一个语义参数（Task #48）。
   *
   * 与平面图拖夹点走的是**同一条链路**：bus.preview 把命令跑在试探模型上，
   * 屏幕上看到的就是将要写入的结果；松手时才真正提交。
   * 这里存的是语义部件（part/spec），从来没有"这条线的坐标"。
   */
  | {
      kind: 'sheetDim';
      pl: PickLine;
      spec: SheetDragSpec;
      cab: Cabinet;
      startWorld: Vec2;
      value: number;
    };

export interface ViewportProps {
  bus: CommandBus;
  version: number;
  cam: Camera;
  setCam: Dispatch<SetStateAction<Camera>>;
  fitSignal: number;
  cancelSignal: number;
  /** 'plan' 平面图（可编辑） | 'sheet' 四视图图幅（只读看图） */
  mode: 'plan' | 'sheet';
  /**
   * 分解图（爆炸图）开关。**默认关闭**。
   * 开启后分解图图幅会出现在四视图图幅的正下方（位置由 deriveExplode 算出来，
   * 见 core/geometry/explode.ts），与四视图共用同一套相机与缩放。
   */
  explode: boolean;
  tool: Tool;
  selection: string[];
  setSelection: (ids: string[]) => void;
  snapSettings: SnapSettings;
  showGrid: boolean;
  hiddenLayers: Set<string>;
  /** 已经选了基点、正在等第二点的移动操作 */
  pendingMove: { base: Vec2 | null } | null;
  onMovePick: (p: Vec2) => void;
  onPlaceCabinet: (p: Vec2) => void;
  onCreateWall: (a: Vec2, b: Vec2) => void;
  /**
   * 右键上下文菜单（Task #24）。Viewport 只做三件事：
   * 阻止浏览器默认菜单、把右键落点处的对象选上（CAD 惯例：右键即选中）、
   * 把屏幕坐标交回 App —— 菜单里有什么项，由 App 按当前选择算。
   */
  onContextMenu?: (p: { x: number; y: number }) => void;
  /**
   * 四视图里点选一条线（Task #25 A 组）。Viewport 只负责命中，
   * 解析结果 PickLine 交回 App —— 界面与 AI 拿到的都是 {cabinetId, part, paramPath}，不是坐标。
   */
  onPickPart?: (pl: PickLine) => void;
  onToast: (kind: ToastKind, text: string) => void;
  cursorStyle: string;
}

function findWall(project: Project, id: string): Wall | null {
  for (const r of project.rooms) {
    const w = r.walls.find((x) => x.id === id);
    if (w) return w;
  }
  return null;
}

export function Viewport(props: ViewportProps) {
  const { bus, version, cam, setCam, tool, selection, setSelection, snapSettings, showGrid, hiddenLayers, pendingMove } = props;

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spaceRef = useRef(false);
  const didFit = useRef(false);

  const [size, setSize] = useState({ w: 900, h: 600 });
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<{ a: Vec2; b: Vec2 } | null>(null);
  const [snap, setSnap] = useState<SnapResult | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [hoverGrip, setHoverGrip] = useState<Grip | null>(null);
  const [activeGrip, setActiveGrip] = useState<Grip | null>(null);
  /** 图纸模式悬停到的那条线 —— 决定能不能拖、拖了改什么（悬停即告知，不等用户试错） */
  const [sheetHoverPl, setSheetHoverPl] = useState<PickLine | null>(null);
  const [preview, setPreview] = useState<Scene | null>(null);
  const [readout, setReadout] = useState('');

  const snapNodes = useMemo(() => collectSnapNodes(bus.getState()), [bus, version]);
  const sheet = props.mode === 'sheet';

  /**
   * 分解图（按需派生视图）。只在图幅模式下、且开关打开时才真的去算。
   * `enabled === false` 时 prims 为空 —— 与"算出来是空的"在类型上分得开。
   */
  const explodeSet = useMemo(
    () => (sheet ? bus.deriveExplode(props.explode) : null),
    [bus, sheet, props.explode, version]
  );

  /**
   * 缩放到图幅：平面图看模型 bbox，图幅模式看"四视图 bbox ∪ 分解图 bbox"。
   * 必须取并集 —— 分解图摆在四视图正下方，只看四视图 bbox 的话，
   * 一按"全图"分解图就整个跑到视口外面去了。
   */
  const fitGeom = useCallback(
    (w: number, h: number): void => {
      const d = bus.derive();
      let target = sheet ? d.geom.views.bbox : d.geom.bbox;
      if (sheet && props.explode) {
        const e = bus.deriveExplode(true).bbox;
        if (e) {
          target = target
            ? { min: { x: Math.min(target.min.x, e.min.x), y: Math.min(target.min.y, e.min.y) }, max: { x: Math.max(target.max.x, e.max.x), y: Math.max(target.max.y, e.max.y) } }
            : e;
        }
      }
      setCam(() => fitBBox(target, w, h, 64));
    },
    [bus, sheet, props.explode, setCam]
  );

  // 相机调试出口（仅供验收探针读数）：图幅模式按设计无 HUD 坐标读数（B20），
  // 探针在 sheet 内无法做 HUD 两点标定，只能从这里读真实相机换算。
  // 双向都写是因为 fit/滚轮/平移都改 cam —— 跟着 render cycle 走最不容易漏。
  useEffect(() => {
    camDebug.cam = cam;
    camDebug.vw = size.w;
    camDebug.vh = size.h;
  }, [cam, size]);


  // ── 尺寸观察 ──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.max(240, Math.round(r.width)), h: Math.max(180, Math.round(r.height)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── 首次自动缩放到图幅 ──
  useEffect(() => {
    if (didFit.current || size.w < 120) return;
    didFit.current = true;
    fitGeom(size.w, size.h);
  }, [size, fitGeom]);

  // ── 外部请求 Zoom Extents ──
  useEffect(() => {
    if (props.fitSignal === 0) return;
    fitGeom(size.w, size.h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fitSignal]);

  // ── 切换模式（平面 ⇄ 图幅）后重新取景：两种图幅的范围完全不同 ──
  useEffect(() => {
    if (size.w < 120) return;
    fitGeom(size.w, size.h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.mode]);

  // ── 分解图开关切换后重新取景：图幅范围变了，不重取景会以为"开关没反应" ──
  useEffect(() => {
    if (size.w < 120 || !sheet) return;
    fitGeom(size.w, size.h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.explode]);

  // ── Esc / 取消 ──
  useEffect(() => {
    if (props.cancelSignal === 0) return;
    setDraft(null);
    setDrag(null);
    setPreview(null);
    setActiveGrip(null);
    setReadout('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.cancelSignal]);

  // ── 空格 = 临时平移 ──
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceRef.current = true;
    };
    const up = (e: KeyboardEvent): void => {
      if (e.code === 'Space') spaceRef.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // ── 滚轮缩放（必须用非 passive 原生监听，否则 preventDefault 无效）──
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sp = { x: e.clientX - r.left, y: e.clientY - r.top };
      const factor = Math.exp(-e.deltaY * 0.0016);
      setCam((c) => zoomAt(c, factor, sp, size.w, size.h));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setCam, size.w, size.h]);

  // ── 绘制 ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const derived = bus.derive();
    const scene: Scene = preview ?? { project: bus.getState(), geom: derived.geom };

    renderScene({
      ctx,
      vw: size.w,
      vh: size.h,
      cam,
      scene,
      mode: props.mode,
      selection,
      hover,
      hoverGrip,
      activeGrip,
      hiddenLayers,
      showGrid,
      snap,
      marquee: drag?.kind === 'marquee' ? { a: drag.a, b: drag.b } : null,
      draftWall: draft ? { a: draft.a, b: draft.b, thickness: DEFAULT_WALL_THICKNESS } : null,
      explodePrims: explodeSet?.prims ?? [],
      sheetHover: sheetHoverPl ? { pts: sheetHoverPl.pts, draggable: dragPlanOf(sheetHoverPl).ok } : null,
    });
  }, [size, cam, version, preview, selection, hover, hoverGrip, activeGrip, hiddenLayers, showGrid, snap, drag, draft, bus, props.mode, explodeSet, sheetHoverPl]);

  // ── 坐标换算 ──
  const toCanvas = useCallback((e: { clientX: number; clientY: number }): Vec2 => {
    const r = wrapRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const toWorld = useCallback((sp: Vec2): Vec2 => screenToWorld(sp, cam, size.w, size.h), [cam, size.w, size.h]);

  const resolveAt = useCallback(
    (raw: Vec2, base: Vec2 | null): SnapResult => {
      const tol = snapToleranceWorld(snapSettings.tolPx, cam.scale);
      const step = niceGridStep(cam.scale);
      return resolveSnap(raw, snapNodes, snapSettings, tol, step, base);
    },
    [snapNodes, snapSettings, cam.scale]
  );

  const runCommand = useCallback(
    (cmd: Command): void => {
      const r = bus.execute(cmd, { commitLabel: cmd.label });
      if (!r.ok) {
        props.onToast('error', r.error ?? '操作被拒绝');
        return;
      }
      const newErr = r.newIssues.filter((i) => i.severity === 'ERROR');
      if (newErr.length > 0) {
        props.onToast('warn', `已应用，但新增 ${newErr.length} 条 ERROR：${newErr[0].message}`);
      }
      if (r.clamped.length > 0) props.onToast('info', r.clamped[0]);
    },
    [bus, props]
  );

  const previewCommand = useCallback(
    (cmd: Command): void => {
      const r = bus.preview(cmd);
      if (!r.ok) {
        setPreview(null);
        return;
      }
      setPreview({ project: r.project, geom: generateProject(r.project, bus.getRules()) });
    },
    [bus]
  );

  // ───────────────────────── 指针事件 ─────────────────────────

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>): void => {
    const el = wrapRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const sp = toCanvas(e);
    const raw = toWorld(sp);
    setCursor(sp);

    // 图幅曾经是只读视图；现在允许"拖一条线 = 改一个语义参数"，走的仍是
    // 与平面图拖夹点完全相同的一条链路（preview → 确认 → 提交），
    // 所以它依然是**派生自同一份模型**的白盒操作，不是偷偷改图元。
    // 注意顺序：点选判断必须在平移分支**之前**，否则左键永远先进平移。
    if (sheet) {
      if (e.button === 0 && !spaceRef.current) {
        const tol = snapToleranceWorld(8, cam.scale);
        const hit = hitPart(bus.derive().geom.views.pickLines, raw, tol);
        if (hit) {
          // 交给 AI 助攻（把语义部件喂给 AI 面板），任何时候都保留
          props.onPickPart?.(hit);
          const plan = dragPlanOf(hit);
          if (plan.ok) {
            const cab = bus.getState().cabinets.find((c) => c.id === hit.cabinetId);
            if (cab) {
              setDrag({ kind: 'sheetDim', pl: hit, spec: plan.spec, cab, startWorld: raw, value: plan.spec.read(cab) });
              setReadout(`${plan.spec.labelZh} ${Math.round(plan.spec.read(cab))}mm · ${plan.spec.hintZh}`);
              return;
            }
          } else {
            // 能点但拖不动 —— 必须当场说清为什么，静默无反应是最伤信任的交互
            props.onToast('info', `${plan.labelZh}：${plan.reason}`);
            return;
          }
        }
      }
      // 空白处照旧平移 —— 图幅的左键平移不能因为有点选就消失
      setDrag({ kind: 'pan', last: sp });
      setPreview(null);
      return;
    }

    // 中键 或 空格+左键 → 平移（图幅模式下左键也可以直接拖动平移）
    if (e.button === 1 || (e.button === 0 && (spaceRef.current || sheet))) {
      setDrag({ kind: 'pan', last: sp });
      setPreview(null);
      return;
    }
    if (e.button !== 0) return;

    const project = bus.getState();
    const base = draft ? draft.a : (pendingMove?.base ?? null);
    const s = resolveAt(raw, base);
    setSnap(s);

    // ① 等待第二点的移动操作优先级最高
    if (pendingMove) {
      props.onMovePick(s.p);
      return;
    }

    // ② 工具
    if (tool === 'wall') {
      if (!draft) setDraft({ a: s.p, b: s.p });
      else {
        props.onCreateWall(draft.a, s.p);
        setDraft(null);
      }
      return;
    }
    if (tool === 'cabinet') {
      props.onPlaceCabinet(s.p);
      return;
    }

    // ③ 选择工具
    const tol = snapToleranceWorld(8, cam.scale);
    const hit = hitTest(project, raw, tol, selection);

    if (hit.kind === 'grip' && hit.grip) {
      const g = hit.grip;
      setActiveGrip(g);
      setDrag({
        kind: 'grip',
        grip: g,
        cab: g.ownerKind === 'cabinet' ? (project.cabinets.find((c) => c.id === g.ownerId) ?? null) : null,
        wall: g.ownerKind === 'wall' ? findWall(project, g.ownerId) : null,
        startPointer: s.p,
      });
      return;
    }

    if (hit.kind === 'cabinet' || hit.kind === 'wall') {
      const id = hit.id as string;
      let next = selection;
      if (e.shiftKey) next = selection.includes(id) ? selection.filter((x) => x !== id) : [...selection, id];
      else if (!selection.includes(id)) next = [id];

      if (next !== selection) setSelection(next);

      if (hit.kind === 'cabinet' && next.includes(id)) {
        setDrag({ kind: 'body', cabs: project.cabinets.filter((c) => next.includes(c.id)), startPointer: s.p });
      }
      return;
    }

    // ④ 空白 → 框选
    setDrag({ kind: 'marquee', a: s.p, b: s.p });
    if (!e.shiftKey) setSelection([]);
  };

  const onPointerMove = (e: RPointerEvent<HTMLDivElement>): void => {
    const sp = toCanvas(e);
    const raw = toWorld(sp);
    setCursor(sp);

    if (!drag) {
      if (sheet) {
        // 图幅模式下悬停到一条线：高亮它，并预告"拖它会改什么"或"为什么不能拖"。
        // 让用户在动手**之前**就知道结果 —— 这比拖了没反应再去看文档强得多。
        const tol = snapToleranceWorld(8, cam.scale);
        const hit = hitPart(bus.derive().geom.views.pickLines, raw, tol);
        setHover(null);
        setHoverGrip(null);
        setSnap(null);
        setSheetHoverPl(hit);
        if (hit) {
          const plan = dragPlanOf(hit);
          const cab = bus.getState().cabinets.find((c) => c.id === hit.cabinetId);
          if (plan.ok && cab) setReadout(`${plan.spec.labelZh} ${Math.round(plan.spec.read(cab))}mm · ${plan.spec.hintZh}`);
          else setReadout(plan.ok ? plan.spec.hintZh : `${plan.labelZh}：${plan.reason}`);
        } else {
          setReadout('');
        }
        return;
      }
      const base = draft ? draft.a : (pendingMove?.base ?? null);
      const s = resolveAt(raw, base);
      setSnap(s);
      if (draft) setDraft({ a: draft.a, b: s.p });

      const project = bus.getState();
      const tol = snapToleranceWorld(7, cam.scale);
      const hit = hitTest(project, raw, tol, selection);
      if (hit.kind === 'grip' && hit.grip) {
        setHoverGrip(hit.grip);
        setHover(hit.grip.ownerId);
      } else {
        setHoverGrip(null);
        setHover(hit.id ?? null);
      }
      setReadout('');
      return;
    }

    switch (drag.kind) {
      case 'pan': {
        setCam((c) => panByScreen(c, sp.x - drag.last.x, sp.y - drag.last.y));
        setDrag({ kind: 'pan', last: sp });
        return;
      }
      case 'marquee': {
        const s = resolveAt(raw, null);
        setSnap(null);
        setDrag({ kind: 'marquee', a: drag.a, b: s.p });
        return;
      }
      case 'grip': {
        const s = resolveAt(raw, drag.startPointer);
        setSnap(s);
        const plan = drag.cab
          ? planCabinetGripDrag(drag.cab, drag.grip.role, s.p, drag.startPointer)
          : drag.wall
            ? planWallGripDrag(drag.wall, drag.grip.role, s.p)
            : null;
        if (!plan) return;
        setReadout(plan.readout);
        previewCommand(plan.command);
        return;
      }
      case 'sheetDim': {
        const value = dragValueOf(drag.spec, drag.cab, drag.startWorld, raw);
        setDrag({ ...drag, value });
        // 读数必须是**真正会被写入的那个值**（项目原则第 9 条：所见即所得）
        const clampedNote = dragClamped(drag.spec, value) ? `（已到边界 ${drag.spec.min}~${drag.spec.max}mm）` : '';
        setReadout(`${drag.spec.labelZh} → ${value}mm${clampedNote}`);
        previewCommand(drag.spec.build(drag.cab, drag.pl.unitIndex, value));
        return;
      }
      case 'body': {
        const s = resolveAt(raw, drag.startPointer);
        setSnap(s);
        const dx = s.p.x - drag.startPointer.x;
        const dy = s.p.y - drag.startPointer.y;
        if (dx === 0 && dy === 0) {
          setPreview(null);
          setReadout('');
          return;
        }
        setReadout(`Δ(${dx >= 0 ? '+' : ''}${Math.round(dx)}, ${dy >= 0 ? '+' : ''}${Math.round(dy)})`);
        previewCommand(CMD.moveCabinetBatch(drag.cabs, bus.getState().cabinets, dx, dy));
        return;
      }
    }
  };

  const onPointerUp = (e: RPointerEvent<HTMLDivElement>): void => {
    const el = wrapRef.current;
    if (el?.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!drag) return;

    const sp = toCanvas(e);
    const raw = toWorld(sp);

    if (drag.kind === 'marquee') {
      const ids = boxSelect(bus.getState(), drag.a, drag.b);
      if (ids.length > 0) setSelection(ids);
    } else if (drag.kind === 'sheetDim') {
      // 松手时的最终值：与刚才预览用的是同一个算法、同一个模型，
      // 所以"预览 === 提交"是结构性保证，不是巧合。
      const value = dragValueOf(drag.spec, drag.cab, drag.startWorld, raw);
      const before = drag.spec.read(drag.cab);
      if (value !== before) {
        const r = bus.execute(drag.spec.build(drag.cab, drag.pl.unitIndex, value), { commitLabel: `${drag.spec.labelZh} 拖动` });
        if (!r.ok) props.onToast('error', `改${drag.spec.labelZh}失败：${r.error ?? '被规则拒绝'}`);
        else if (dragClamped(drag.spec, value)) props.onToast('info', `${drag.spec.labelZh}已到上下限（${drag.spec.min}~${drag.spec.max}mm）：这是规则允许的边界`);
      }
    } else if (drag.kind === 'grip') {
      const s = resolveAt(raw, drag.startPointer);
      const plan = drag.cab
        ? planCabinetGripDrag(drag.cab, drag.grip.role, s.p, drag.startPointer)
        : drag.wall
          ? planWallGripDrag(drag.wall, drag.grip.role, s.p)
          : null;
      if (plan) runCommand(plan.command);
    } else if (drag.kind === 'body') {
      const s = resolveAt(raw, drag.startPointer);
      const dx = s.p.x - drag.startPointer.x;
      const dy = s.p.y - drag.startPointer.y;
      if (dx !== 0 || dy !== 0) {
        runCommand(CMD.moveCabinetBatch(drag.cabs, bus.getState().cabinets, dx, dy));
      }
    }

    setDrag(null);
    setPreview(null);
    setActiveGrip(null);
    setReadout('');
    // 必须一起清掉捕捉结果：拖动过程中它带着极轴/正交的「追踪线」，
    // 不清的话松手后屏幕上会留下一条指向虚空的橡皮筋和一个失效的捕捉标记，
    // 直到用户再次移动鼠标才消失。真实 CAD 在命令结束时会立刻收掉追踪线。
    setSnap(null);
  };

  const onPointerLeave = (): void => {
    if (drag) return;
    setHover(null);
    setHoverGrip(null);
    setSnap(null);
  };

  // ── 右键上下文菜单：先"右键即选中"，再把屏幕坐标交回 App ──
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (!props.onContextMenu) return;
    const sp = toCanvas(e as unknown as RPointerEvent<HTMLDivElement>);
    const raw = toWorld(sp);
    // 右键落在对象上且尚未选中 → 先把它选中（真实 CAD 的惯例），菜单项才说得通
    if (!sheet) {
      const project = bus.getState();
      const tol = snapToleranceWorld(8, cam.scale);
      const hit = hitTest(project, raw, tol, selection);
      if ((hit.kind === 'cabinet' || hit.kind === 'wall') && !selection.includes(hit.id as string)) {
        props.setSelection([hit.id as string]);
      }
    }
    props.onContextMenu({ x: e.clientX, y: e.clientY });
  };

  // ── HUD ──
  /**
   * 坐标读数必须是【最终会被用到的那个点】，不是原始指针点。
   *
   * 捕捉生效时如果还显示原始点，用户会看到 "X 741"，而实际落到 700 ——
   * 这就是"所见非所得"，是 CAD 里最不能容忍的一类问题，也是本项目
   * "预览 === 提交" 原则在读数上的延伸。捕捉生效时直接显示捕捉点，
   * 旁边的捕捉标记负责解释"为什么是这个点"。
   */
  const cursorWorld = cursor ? toWorld(cursor) : null;
  const world = snap && snap.kind !== 'none' ? snap.p : cursorWorld;
  const derived = bus.derive();
  const scene = preview ?? { project: bus.getState(), geom: derived.geom };
  const hoverName = hover ? (scene.project.cabinets.find((c) => c.id === hover)?.name ?? wallPolygonName(scene.project, hover)) : null;

  return (
    <div
      ref={wrapRef}
      className="vp"
      style={{ cursor: sheet ? 'grab' : props.cursorStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={onPointerLeave}
      onContextMenu={onContextMenu}
    >
      <canvas ref={canvasRef} className="vp-canvas" />

      <div className="vp-hud">
        {sheet ? (
          <>
            <span className="vp-hud-item vp-hud-sheet">
              四视图图幅{props.explode ? ' + 分解图（下方）' : ''} · 可编辑：蓝线可拖改尺寸 · 拖动平移 / 滚轮缩放
            </span>
            {/*
              读数在图纸模式下**必须**出现：拖动时它会显示"柜宽 → 2400mm"，
              也就是松手真正写入的那个值。没有它，"所见即所得"这条原则在图纸上就断了。
            */}
            {readout ? <span className="vp-hud-item vp-hud-read">{readout}</span> : null}
          </>
        ) : (
          <>
            <span className="vp-hud-item">
              X <b>{world ? Math.round(world.x) : '—'}</b> Y <b>{world ? Math.round(world.y) : '—'}</b> mm
            </span>
            {snap && snap.kind !== 'none' ? <span className="vp-hud-item vp-hud-snap">{snapLabel(snap)}</span> : null}
            {readout ? <span className="vp-hud-item vp-hud-read">{readout}</span> : null}
            {hoverName ? <span className="vp-hud-item vp-hud-hover">{hoverName}</span> : null}
          </>
        )}
      </div>

      {/* 图纸拖动同样走 bus.preview，所以同样要显示预览徽标 —— 否则用户不知道"还没落定" */}
      {preview ? <div className="vp-preview-badge">预览中 · 松手提交</div> : null}

      {!sheet && pendingMove ? (
        <div className="vp-prompt">
          {pendingMove.base ? '指定第二点（位移终点）   [Esc] 取消' : '指定基点   [Esc] 取消'}
        </div>
      ) : null}

      {!sheet && tool === 'wall' && draft ? <div className="vp-prompt">指定墙终点   [Esc] 取消</div> : null}

      <div className="vp-scale">1 : {Math.round(1 / cam.scale)}</div>
    </div>
  );
}

/**
 * 注意用 snapKindLabel 而不是 s.kind：
 * s.kind 是给程序看的英文枚举（'quad' / 'polar'），画布上的捕捉标记已经用中文，
 * 两边不一致会让用户在"画布上写象限点、HUD 上写 quad"之间对不上号。
 */
function snapLabel(s: SnapResult): string {
  const zh = snapKindLabel(s.kind);
  return s.ref ? `${zh} · ${s.ref}` : zh;
}

function wallPolygonName(project: Project, id: string): string | null {
  for (const r of project.rooms) {
    const w = r.walls.find((x) => x.id === id);
    if (w) return w.name;
  }
  return null;
}
