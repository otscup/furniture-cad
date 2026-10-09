import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, PointerEvent as RPointerEvent, SetStateAction, MouseEvent as ReactMouseEvent } from 'react';
import type { Cabinet, DrawingEntity, DrawingSpace, DrawingView, Prim, Project, Vec2, Wall } from '../core/types.ts';
import type { Command, CommandBus } from '../core/commandBus.ts';
import { generateProject } from '../core/geometry/project.ts';
import { doorSwingPrimsOf } from '../viewport/doorSwingPrims.ts';
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
import { conflictsWithProductionDimension, drawingEntityPrims, editIdFromSelection, editSelectionId, replaceDrawingEdits, sourceKeysInRect, sourceOverride, sourceSelectionId, translateDrawingEntity } from '../core/drawingEdits.ts';
import { newCommandId } from '../core/ids.ts';
import { buildCabinetViews } from '../core/geometry/views.ts';
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
    }
  | { kind: 'drawing'; startWorld: Vec2; edits: DrawingEntity[]; selectedIds: string[]; source?: { key: string; prim: Prim; id: string; meta: Partial<DrawingEntity> } };

export interface ViewportProps {
  bus: CommandBus;
  version: number;
  cam: Camera;
  setCam: Dispatch<SetStateAction<Camera>>;
  fitSignal: number;
  cancelSignal: number;
  /** 聚焦房间：sig 变化时把视口缩放到该房间包围盒（id 为空表示不聚焦） */
  focusRoom: { id: string; sig: number };
  /** 'plan' 平面图 | 'sheet' 四视图图幅（派生投影；尺寸线可编辑、空白处可平移） */
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
  readOnly?: boolean;
}

function findWall(project: Project, id: string): Wall | null {
  for (const r of project.rooms) {
    const w = r.walls.find((x) => x.id === id);
    if (w) return w;
  }
  return null;
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function primHit(p: Prim, at: Vec2, tol: number): boolean {
  if (p.k === 'text') return Math.hypot(p.p.x - at.x, p.p.y - at.y) <= Math.max(tol, (p.size ?? 100) * 0.6);
  if (p.k !== 'poly' || p.pts.length < 2) return false;
  const segments = p.closed ? p.pts.length : p.pts.length - 1;
  for (let i = 0; i < segments; i++) if (pointSegmentDistance(at, p.pts[i]!, p.pts[(i + 1) % p.pts.length]!) <= tol) return true;
  return false;
}
function hitDrawingEntity(entities: DrawingEntity[], space: DrawingSpace, at: Vec2, tol: number): DrawingEntity | null {
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i]!;
    if (e.space === space && drawingEntityPrims(e).some(p => primHit(p, at, tol))) return e;
  }
  return null;
}
function hitGeneratedPrim(prims: Prim[], keys: string[], suppressed: Set<string>, at: Vec2, tol: number): { prim: Prim; key: string } | null {
  for (let i = prims.length - 1; i >= 0; i--) {
    const prim = prims[i]!;
    const key = keys[i];
    if (!key || suppressed.has(key) || !primHit(prim, at, tol)) continue;
    return { prim, key };
  }
  return null;
}
function nearestRoomId(project: Project, p: Vec2): string | undefined {
  let best: { id: string; d: number } | undefined;
  for (const room of project.rooms) {
    if (!room.walls.length) continue;
    const pts = room.walls.flatMap(w => [w.start, w.end]);
    const c = { x: pts.reduce((s, q) => s + q.x, 0) / pts.length, y: pts.reduce((s, q) => s + q.y, 0) / pts.length };
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (!best || d < best.d) best = { id: room.id, d };
  }
  return best?.id;
}
function sheetTarget(project: Project, geom: ReturnType<CommandBus['derive']>['geom'], rules: ReturnType<CommandBus['getRules']>, p: Vec2): { cabinetId?: string; view?: DrawingView } {
  let best: { cabinetId: string; view: DrawingView; d: number } | undefined;
  for (const cab of project.cabinets) {
    const placement = geom.views.placements[cab.id];
    if (!placement) continue;
    let views;
    try { views = buildCabinetViews(cab, rules); } catch { continue; }
    const dx = placement.x - views.meta.front.origin.x;
    for (const view of ['top', 'front', 'internal'] as const) {
      const pts = views.prims[view].flatMap(q => q.k === 'text' ? [q.p] : q.pts).map(q => ({ x: q.x + dx, y: q.y }));
      if (!pts.length) continue;
      const minX = Math.min(...pts.map(q => q.x)), maxX = Math.max(...pts.map(q => q.x));
      const minY = Math.min(...pts.map(q => q.y)), maxY = Math.max(...pts.map(q => q.y));
      const ox = Math.max(minX - p.x, 0, p.x - maxX), oy = Math.max(minY - p.y, 0, p.y - maxY);
      const d = Math.hypot(ox, oy);
      if (!best || d < best.d) best = { cabinetId: cab.id, view, d };
    }
  }
  return best ? { cabinetId: best.cabinetId, view: best.view } : {};
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
  /** 图纸模式悬停到的那条线 —— 仅用于高亮；具体读数只在明确拖动操作中显示。 */
  const [sheetHoverPl, setSheetHoverPl] = useState<PickLine | null>(null);
  const [preview, setPreview] = useState<Scene | null>(null);
  const [readout, setReadout] = useState('');
  const [drawPoints, setDrawPoints] = useState<Vec2[]>([]);
  const [drawDraft, setDrawDraft] = useState<DrawingEntity | null>(null);
  const [editPreview, setEditPreview] = useState<DrawingEntity[] | null>(null);

  const snapNodes = useMemo(() => collectSnapNodes(bus.getState()), [bus, version]);
  const sheet = props.mode === 'sheet';

  useEffect(() => {
    setHover(null);
    setHoverGrip(null);
    setSheetHoverPl(null);
    setActiveGrip(null);
    setSnap(null);
    setCursor(null);
    setReadout('');
    setDrag(null);
    setDraft(null);
    setDrawPoints([]);
    setDrawDraft(null);
    setEditPreview(null);
    setPreview(null);
  }, [props.mode, tool]);

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

  // ── 聚焦某个房间：把视口缩放到该房间包围盒（解决"多房间分不清哪个是哪个"） ──
  useEffect(() => {
    if (!props.focusRoom.id || props.focusRoom.sig === 0 || size.w < 120) return;
    const room = bus.getState().rooms.find((r) => r.id === props.focusRoom.id);
    if (!room || room.walls.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const wll of room.walls) {
      for (const pt of [wll.start, wll.end]) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
      }
    }
    if (!(maxX > minX) || !(maxY > minY)) return;
    setCam(() => fitBBox({ min: { x: minX, y: minY }, max: { x: maxX, y: maxY } }, size.w, size.h, 80));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focusRoom.sig]);

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
    const baseScene: Scene = preview ?? { project: bus.getState(), geom: derived.geom };
    const previewEdits = editPreview ?? baseScene.project.drawingEdits ?? [];
    const shownEdits = drawDraft ? [...previewEdits, drawDraft] : previewEdits;
    const scene: Scene = editPreview || drawDraft
      ? { project: { ...baseScene.project, drawingEdits: shownEdits }, geom: baseScene.geom }
      : baseScene;

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
      doorSwingPrims: props.mode === 'plan' ? doorSwingPrimsOf(scene.project) : [],
      sheetHover: sheetHoverPl ? { pts: sheetHoverPl.pts, draggable: dragPlanOf(sheetHoverPl).ok } : null,
    });
  }, [size, cam, version, preview, editPreview, drawDraft, selection, hover, hoverGrip, activeGrip, hiddenLayers, showGrid, snap, drag, draft, bus, props.mode, explodeSet, sheetHoverPl]);

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
      if (props.readOnly) {
        props.onToast('warn', '历史重复 Unit ID 项目只读；CAD 图元与模型写入已禁用，需显式修复/迁移后恢复。');
        return;
      }
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

  const persistDrawing = (edits: DrawingEntity[], label: string): void => {
    const project = bus.getState();
    const previousById = new Map((project.drawingEdits ?? []).map((entity) => [entity.id, entity]));
    const changedDimensions = edits.filter((entity) => entity.kind === 'dimension' && JSON.stringify(previousById.get(entity.id)) !== JSON.stringify(entity));
    runCommand(replaceDrawingEdits(project, edits, label));
    if (changedDimensions.length > 0) {
      const geom = bus.derive().geom;
      const conflict = changedDimensions.some((entity) => {
        const generated = entity.space === 'plan'
          ? geom.roomPlans[entity.roomId ?? ''] ?? []
          : geom.views.prims.filter((_, i) => geom.views.sourceKeys[i]?.startsWith(`sheet:${entity.cabinetId ?? ''}:${entity.view ?? ''}:`));
        return conflictsWithProductionDimension(entity, generated);
      });
      if (conflict) props.onToast('warn', '注意：此手工尺寸与同视图模型生产尺寸端点重合。手工标注不会替代生产尺寸，请检查是否重复或数值矛盾。');
    }
  };
  const drawingMetaAt = (p: Vec2, space: DrawingSpace): Partial<DrawingEntity> => {
    const project = bus.getState();
    if (space === 'plan') return { roomId: nearestRoomId(project, p) };
    return sheetTarget(project, bus.derive().geom, bus.getRules(), p);
  };
  const makeDrawing = (kind: DrawingEntity['kind'], points: Vec2[], text = ''): DrawingEntity => {
    const space = props.mode as DrawingSpace;
    const meta = drawingMetaAt(points[0] ?? { x: 0, y: 0 }, space);
    return {
      id: newCommandId('edit'), space, kind, points: points.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
      text: text || undefined, textSize: 180, lineWidth: 1.4,
      layer: kind === 'text' || kind === 'leader' ? 'F-TEXT' : kind === 'dimension' ? 'F-DIM' : 'F-CAD-EDIT',
      provenance: 'manual', ...meta,
    };
  };

  // ───────────────────────── 指针事件 ─────────────────────────

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>): void => {
    const el = wrapRef.current;
    if (!el) return;
    if (props.readOnly && e.button === 0 && !spaceRef.current) {
      if (tool !== 'select' || pendingMove || drawPoints.length > 0) {
        props.onToast('warn', '历史重复 Unit ID 项目只读；画布图元与模型写入已拦截，需显式修复/迁移后恢复。');
      }
      const raw = toWorld(toCanvas(e));
      const project = bus.getState();
      const tolerance = snapToleranceWorld(8, cam.scale);
      if (sheet) {
        const manual = hitDrawingEntity(project.drawingEdits ?? [], 'sheet', raw, tolerance);
        if (manual) { setSelection([editSelectionId(manual.id)]); return; }
        const semantic = hitPart(bus.derive().geom.views.pickLines, raw, tolerance);
        if (semantic) { props.onPickPart?.(semantic); return; }
        const hidden = new Set((project.drawingEdits ?? []).filter((entity) => entity.space === 'sheet' && entity.replacesSource).map((entity) => entity.replacesSource!));
        const source = hitGeneratedPrim(bus.derive().geom.views.prims, bus.derive().geom.views.sourceKeys, hidden, raw, tolerance);
        if (source) { setSelection([sourceSelectionId(source.key)]); return; }
      } else {
        const hit = hitTest(project, raw, tolerance, selection);
        if ('id' in hit && typeof hit.id === 'string') {
          if (selection.includes(hit.id)) props.onToast('warn', '历史重复 Unit ID 项目只读；画布拖拽/编辑已拦截。');
          setSelection([hit.id]);
        }
        else setSelection([]);
      }
      return;
    }
    el.setPointerCapture(e.pointerId);
    const sp = toCanvas(e);
    const raw = toWorld(sp);
    setCursor(sp);

    if (e.button === 0 && !spaceRef.current && ['line', 'polyline', 'text', 'dimension', 'leader'].includes(tool)) {
      const snapped = resolveAt(raw, drawPoints.at(-1) ?? null).p;
      if (tool === 'text') {
        const text = window.prompt('输入文字内容');
        if (text?.trim()) {
          const entity = makeDrawing('text', [snapped], text.trim());
          persistDrawing([...(bus.getState().drawingEdits ?? []), entity], '添加文字');
          setSelection([editSelectionId(entity.id)]);
        }
        setDrawPoints([]); setDrawDraft(null); return;
      }
      if (tool === 'polyline') {
        if (e.detail > 1 && drawPoints.length >= 2) {
          const pts = [...drawPoints];
          if (Math.hypot(snapped.x - pts.at(-1)!.x, snapped.y - pts.at(-1)!.y) > 2) pts.push(snapped);
          const entity = makeDrawing('polyline', pts);
          persistDrawing([...(bus.getState().drawingEdits ?? []), entity], '绘制多段线');
          setSelection([editSelectionId(entity.id)]); setDrawPoints([]); setDrawDraft(null); return;
        }
        const pts = [...drawPoints, snapped];
        setDrawPoints(pts);
        setDrawDraft(makeDrawing('polyline', [...pts, pts.at(-1)!]));
        return;
      }
      if (drawPoints.length === 0) {
        setDrawPoints([snapped]);
        const kind = tool === 'line' ? 'line' : tool === 'dimension' ? 'dimension' : 'leader';
        setDrawDraft(makeDrawing(kind, [snapped, snapped, snapped]));
        return;
      }
      const a = drawPoints[0]!;
      let entity: DrawingEntity;
      if (tool === 'dimension') {
        const dx = snapped.x - a.x, dy = snapped.y - a.y, len = Math.hypot(dx, dy) || 1;
        const off = { x: (a.x + snapped.x) / 2 - (dy / len) * 220, y: (a.y + snapped.y) / 2 + (dx / len) * 220 };
        entity = makeDrawing('dimension', [a, snapped, off], `${Math.round(len)} mm`);
      } else if (tool === 'leader') {
        const text = window.prompt('输入引线注释', '注释');
        if (!text?.trim()) { setDrawPoints([]); setDrawDraft(null); return; }
        entity = makeDrawing('leader', [a, snapped], text.trim());
      } else entity = makeDrawing('line', [a, snapped]);
      persistDrawing([...(bus.getState().drawingEdits ?? []), entity], tool === 'line' ? '绘制直线' : tool === 'dimension' ? '添加尺寸' : '添加引线');
      setSelection([editSelectionId(entity.id)]); setDrawPoints([]); setDrawDraft(null); return;
    }

    // 图幅曾经是只读视图；现在允许"拖一条线 = 改一个语义参数"，走的仍是
    // 与平面图拖夹点完全相同的一条链路（preview → 确认 → 提交），
    // 所以它依然是**派生自同一份模型**的白盒操作，不是偷偷改图元。
    // 注意顺序：点选判断必须在平移分支**之前**，否则左键永远先进平移。
    if (sheet) {
      if (e.button === 0 && !spaceRef.current) {
        const project = bus.getState();
        const edits = project.drawingEdits ?? [];
        const tol = snapToleranceWorld(8, cam.scale);
        const manualHit = hitDrawingEntity(edits, 'sheet', raw, tol);
        if (manualHit) {
          const sid = editSelectionId(manualHit.id);
          const ids = e.shiftKey
            ? selection.includes(sid) ? selection.filter(x => x !== sid) : [...selection, sid]
            : selection.includes(sid) ? selection : [sid];
          setSelection(ids);
          if (ids.includes(sid)) setDrag({ kind: 'drawing', startWorld: raw, edits: structuredClone(edits), selectedIds: ids.filter(x => editIdFromSelection(x)) });
          return;
        }
        const derived = bus.derive();
        if (!e.altKey) {
          const semantic = hitPart(derived.geom.views.pickLines, raw, tol);
          if (semantic) {
            props.onPickPart?.(semantic);
            const plan = dragPlanOf(semantic);
            if (!plan.ok) {
              // 语义识别成功但该边不可拖（例如尺寸基准端）时，必须遵守
              // sheetDrag 的 NoDrag 契约；不能把它当普通生成图元继续建覆盖。
              props.onToast('info', `${plan.labelZh}：${plan.reason}`);
              return;
            }
            const cab = project.cabinets.find(c => c.id === semantic.cabinetId);
            if (!cab) {
              props.onToast('error', `无法拖动${plan.spec.labelZh}：柜体不存在`);
              return;
            }
            setDrag({ kind: 'sheetDim', pl: semantic, spec: plan.spec, cab, startWorld: raw, value: plan.spec.read(cab) });
            setReadout(`${plan.spec.labelZh} ${Math.round(plan.spec.read(cab))}mm · ${plan.spec.hintZh}`);
            return;
          }
        }
        const suppressed = new Set(edits.filter(x => x.space === 'sheet' && x.replacesSource).map(x => x.replacesSource!));
        const source = hitGeneratedPrim(derived.geom.views.prims, derived.geom.views.sourceKeys, suppressed, raw, tol);
        if (source) {
          const sid = sourceSelectionId(source.key);
          setSelection([sid]);
          const parts = source.key.split(':');
          const meta: Partial<DrawingEntity> = parts[0] === 'sheet' ? { cabinetId: parts[1], view: parts[2] as DrawingView } : {};
          setDrag({ kind: 'drawing', startWorld: raw, edits: structuredClone(edits), selectedIds: [], source: { key: source.key, prim: source.prim, id: newCommandId('edit'), meta } });
          return;
        }
        setSelection([]);
      }
      if (e.altKey && e.button === 0) setDrag({ kind: 'marquee', a: raw, b: raw });
      else setDrag({ kind: 'pan', last: sp });
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
    const edits = project.drawingEdits ?? [];
    if (!e.altKey) {
      const manualHit = hitDrawingEntity(edits, 'plan', raw, tol);
      if (manualHit) {
        const sid = editSelectionId(manualHit.id);
        const ids = e.shiftKey
          ? selection.includes(sid) ? selection.filter(x => x !== sid) : [...selection, sid]
          : selection.includes(sid) ? selection : [sid];
        setSelection(ids);
        if (ids.includes(sid)) setDrag({ kind: 'drawing', startWorld: raw, edits: structuredClone(edits), selectedIds: ids.filter(x => editIdFromSelection(x)) });
        return;
      }
    } else {
      const derived = bus.derive();
      const suppressed = new Set(edits.filter(x => x.space === 'plan' && x.replacesSource).map(x => x.replacesSource!));
      const source = hitGeneratedPrim(derived.geom.plan, derived.geom.planSourceKeys, suppressed, raw, tol);
      if (source) {
        const parts = source.key.split(':');
        const meta: Partial<DrawingEntity> = parts[1] === 'wall'
          ? { roomId: project.rooms.find(r => r.walls.some(w => w.id === parts[2]))?.id }
          : { cabinetId: parts[2], roomId: project.cabinets.find(c => c.id === parts[2])?.roomId };
        const sid = sourceSelectionId(source.key);
        setSelection([sid]);
        setDrag({ kind: 'drawing', startWorld: raw, edits: structuredClone(edits), selectedIds: [], source: { key: source.key, prim: source.prim, id: newCommandId('edit'), meta } });
        return;
      }
    }
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
      if (drawPoints.length > 0 && ['line', 'polyline', 'dimension', 'leader'].includes(tool)) {
        const snapped = resolveAt(raw, drawPoints.at(-1) ?? null).p;
        let points = [...drawPoints, snapped];
        const kind = tool === 'line' ? 'line' : tool === 'polyline' ? 'polyline' : tool === 'dimension' ? 'dimension' : 'leader';
        if (kind === 'dimension' && drawPoints.length > 0) {
          const a = drawPoints[0]!, dx = snapped.x - a.x, dy = snapped.y - a.y, len = Math.hypot(dx, dy) || 1;
          points = [a, snapped, { x: (a.x + snapped.x) / 2 - dy / len * 220, y: (a.y + snapped.y) / 2 + dx / len * 220 }];
        }
        setDrawDraft(makeDrawing(kind, points));
      }
      if (sheet) {
        // 图幅模式下悬停只高亮线条，不显示会被误认为编辑结果的尺寸或位移读数。
        const tol = snapToleranceWorld(8, cam.scale);
        const hit = hitPart(bus.derive().geom.views.pickLines, raw, tol);
        setHover(null);
        setHoverGrip(null);
        setSnap(null);
        setSheetHoverPl(hit);
        // 悬停只负责高亮可交互线条；尺寸/位移读数仅在实际进入拖动等操作后显示。
        setReadout('');
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
      case 'drawing': {
        const dx = Math.round(raw.x - drag.startWorld.x), dy = Math.round(raw.y - drag.startWorld.y);
        if (Math.abs(dx) + Math.abs(dy) < 2) { setEditPreview(null); return; }
        const next = drag.edits.filter(e => !drag.selectedIds.includes(e.id));
        if (drag.source) {
          const entity = sourceOverride(drag.source.key, drag.source.prim, sheet ? 'sheet' : 'plan', drag.source.id, drag.source.meta);
          if (!entity) { setEditPreview(null); return; }
          next.push(translateDrawingEntity(entity, dx, dy));
          setReadout(`视图覆盖 Δ(${dx}, ${dy}) mm`);
        } else {
          for (const id of drag.selectedIds) {
            const original = drag.edits.find(e => e.id === id);
            if (original) next.push(translateDrawingEntity(original, dx, dy));
          }
          setReadout(`图元移动 Δ(${dx}, ${dy}) mm`);
        }
        setEditPreview(next);
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
      const project = bus.getState();
      const ids = sheet ? [] : boxSelect(project, drag.a, drag.b);
      const minX = Math.min(drag.a.x, drag.b.x), maxX = Math.max(drag.a.x, drag.b.x);
      const minY = Math.min(drag.a.y, drag.b.y), maxY = Math.max(drag.a.y, drag.b.y);
      for (const entity of project.drawingEdits ?? []) {
        if (entity.space !== (sheet ? 'sheet' : 'plan') || !entity.points.length) continue;
        if (entity.points.every(p => p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY)) ids.push(editSelectionId(entity.id));
      }
      const derived = bus.derive().geom;
      const space: DrawingSpace = sheet ? 'sheet' : 'plan';
      const prims = sheet ? derived.views.prims : derived.plan;
      const keys = sheet ? derived.views.sourceKeys : derived.planSourceKeys;
      const hidden = new Set((project.drawingEdits ?? []).filter(x => x.space === space && x.replacesSource).map(x => x.replacesSource!));
      ids.push(...sourceKeysInRect(prims, keys, { minX, minY, maxX, maxY }, hidden).map(sourceSelectionId));
      setSelection(ids);
    } else if (drag.kind === 'sheetDim') {
      // 松手时的最终值：与刚才预览用的是同一个算法、同一个模型，
      // 所以"预览 === 提交"是结构性保证，不是巧合。
      const value = dragValueOf(drag.spec, drag.cab, drag.startWorld, raw);
      const before = drag.spec.read(drag.cab);
      if (value !== before) {
        if (props.readOnly) {
          props.onToast('warn', '历史重复 Unit ID 项目只读；图纸尺寸编辑已禁用。');
          return;
        }
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
      } else if (drag.kind === 'drawing') {
        const dx = Math.round(raw.x - drag.startWorld.x), dy = Math.round(raw.y - drag.startWorld.y);
        if (Math.abs(dx) + Math.abs(dy) >= 2) {
          const next = drag.edits.filter(e => !drag.selectedIds.includes(e.id));
          if (drag.source) {
            const entity = sourceOverride(drag.source.key, drag.source.prim, sheet ? 'sheet' : 'plan', drag.source.id, drag.source.meta);
            if (!entity) { setEditPreview(null); return; }
            next.push(translateDrawingEntity(entity, dx, dy));
          setSelection([editSelectionId(entity.id)]);
          props.onToast('info', '已创建当前视图覆盖；柜体生产参数未更改');
        } else {
          const moved: string[] = [];
          for (const id of drag.selectedIds) {
            const original = drag.edits.find(e => e.id === id);
            if (original) { next.push(translateDrawingEntity(original, dx, dy)); moved.push(editSelectionId(id)); }
          }
          setSelection(moved);
        }
        persistDrawing(next, drag.source ? '覆盖并移动生成线' : '移动二维图元');
      }
    }

    setDrag(null);
    setPreview(null);
    setEditPreview(null);
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
    setSheetHoverPl(null);
    setReadout('');
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
              图纸视图（俯视 / 正视 / 内部）{props.explode ? ' + 分解图（下方）' : ''} · 可编辑：图元覆盖 / 蓝线拖尺寸 · 拖动平移 / 滚轮缩放
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
