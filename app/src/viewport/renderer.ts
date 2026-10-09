import type { DrawingEntity, Prim, Project, ProjectGeometry, Vec2 } from '../core/types.ts';
import { getCabinetFootprint } from '../core/geometry/generate.ts';
import { wallPolygon } from '../core/geometry/project.ts';
import type { Camera } from './camera.ts';
import { niceGridStep, screenToWorld, worldToScreen } from './camera.ts';
import { UI_COLORS, layerOf } from './layers.ts';
import type { Grip } from './hitTest.ts';
import { gripsFor } from './hitTest.ts';
import type { SnapResult } from './snapping.ts';
import { snapKindLabel } from './snapping.ts';
import { drawingEntityPrims, drawingPrims, editSelectionId, sourceSelectionId } from '../core/drawingEdits.ts';

/**
 * Canvas 2D 渲染器 —— 只读，且只认一个「场景」。
 *
 * 设计取舍：
 *  1. **不用 ctx.setTransform 缩放坐标系**，而是手工把每个点转成屏幕坐标。
 *     理由：线宽、文字、夹点、标注必须保持恒定屏幕尺寸（这是 CAD 的常态，
 *     也是"图上文字永远看得清"的前提）。用变换矩阵会让它们随缩放一起放大。
 *  2. 场景由调用方给出（真实模型 或 拖动中的试探模型），渲染器不关心区别。
 *     因此拖动的预览画面 = 真实管线跑在试探模型上的输出，与提交结果必然一致。
 *  3. 不认识的图元类型直接忽略，不抛异常 —— 渲染层永远不能让整个界面白屏。
 */

/**
 * 字体栈导出给验收脚本用。
 * 理由：要判定"图上两组文字有没有压在一起"，就必须用**和渲染器完全一样**的
 * 字体去 measureText —— 换一个字重、换一家中文字体，宽度差几十毫米，
 * 断言就会时对时错。字体在这里是一份契约，不是随手写的字符串。
 */
export const FONT_STACK = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif';

/** 要绘制的东西：模型 + 它的派生几何。两者必须来自同一个 modelVersion。 */
export interface Scene {
  project: Project;
  geom: ProjectGeometry;
}

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  vw: number;
  vh: number;
  cam: Camera;
  scene: Scene;
  /**
   * 'plan' 平面图 | 'sheet' 四视图图幅（派生投影；尺寸线可编辑、空白处可平移）。
   *
   * 两种模式读的是**同一次 derive 的产物**：plan 读 geom.plan，sheet 读 geom.views。
   * 渲染器不改任何东西，模式只是"看哪一份派生视图"。
   */
  mode: 'plan' | 'sheet';
  selection: string[];
  hover: string | null;
  hoverGrip: Grip | null;
  activeGrip: Grip | null;
  hiddenLayers: Set<string>;
  showGrid: boolean;
  snap: SnapResult | null;
  marquee: { a: Vec2; b: Vec2 } | null;
  draftWall: { a: Vec2; b: Vec2; thickness: number } | null;
  /**
   * 分解图（爆炸图）图元。
   *
   * 它是**独立的一份派生结果**，不塞进 `geom.views`：
   * 分解图是开关控制的可选视图，默认关闭；如果把它并进四视图的图元表，
   * "关掉分解图"就会变成"图元表里少了一截"，与"这张图本来就没有分解图"
   * 再也分不开。这里只负责画，布局仍然完全由 explode.ts 决定。
   */
  explodePrims: Prim[];
  /**
   * 门扇开启范围的图元（P8.9）。
   *
   * 与 explodePrims 同一条理由：它是**独立的一份派生结果**（来自
   * core/spatial/door.ts 的确定性包络，不是 UI 自己画的），所以不塞进
   * `geom.plan`。渲染器只负责画，包络怎么算、算出来是不是 unknown，
   * 全在空间层说了算 —— 界面不许自己再画一条弧。
   */
  doorSwingPrims?: Prim[];
  /**
   * 图纸模式下鼠标悬停到的可点线段（PickLine）。
   *
   * 为什么要画它：**"看不出来能点"等于没有这个功能。**
   * 可拖的线画成蓝色高亮，不可拖的画成淡红 —— 用户在动手之前就知道结果，
   * 而不是拖了半天没反应才怀疑软件坏了。
   */
  sheetHover?: { pts: Vec2[]; draggable: boolean } | null;
  drawingPreview?: DrawingEntity[];
}

export type P2S = (p: Vec2) => Vec2;

export function renderScene(inp: RenderInput): void {
  const { ctx, vw, vh } = inp;
  const to = (p: Vec2): Vec2 => worldToScreen(p, inp.cam, vw, vh);

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.clearRect(0, 0, vw, vh);
  ctx.fillStyle = UI_COLORS.bg;
  ctx.fillRect(0, 0, vw, vh);

  // 图幅模式：只画四视图，不画栅格 / 夹点 / 捕捉 / 追踪线（那是编辑反馈，不是图）
  if (inp.mode === 'sheet') {
    drawSheet(inp, to);
    ctx.restore();
    return;
  }

  if (inp.showGrid) drawGrid(inp, to);
  if (inp.scene.project.drawingEdits?.some(e => e.space === 'plan')) {
    drawPrims(ctx, drawingPrims(inp.scene.project, 'plan', inp.scene.geom.plan, inp.scene.geom.planSourceKeys), to, inp.hiddenLayers, inp.cam.scale);
  } else {
    drawWalls(inp, to);
    drawDoorSwing(inp, to);
    drawCabinets(inp, to);
  }
  drawSelectionHighlight(inp, to);
  drawDrawingSelection(inp, to, 'plan');
  drawGrips(inp, to);
  drawDraftWall(inp, to);
  drawMarquee(inp, to);
  drawTracking(inp, to);
  drawSnapMarker(inp, to);

  ctx.restore();
}

// ───────────────────────────── 四视图图幅 ─────────────────────────────

/**
 * 图幅模式只做一件事：把 project.views 里已经算好的图元画出来。
 * 这里**不做任何布局计算** —— 视图怎么排、衔接线画在哪，都是 views.ts 的事。
 * 渲染器一旦开始"帮忙摆位置"，就又多了一个真相源。
 */
function drawDrawingSelection(inp: RenderInput, to: P2S, space: 'plan' | 'sheet'): void {
  const { ctx, scene, selection } = inp;
  const entities = (scene.project.drawingEdits ?? []).filter(e => e.space === space);
  ctx.save();
  ctx.strokeStyle = '#f97316'; ctx.fillStyle = '#f97316'; ctx.lineWidth = 2.8;
  for (const e of entities) if (selection.includes(editSelectionId(e.id))) {
    for (const p of drawingEntityPrims(e)) highlightPrim(ctx, p, to);
  }
  const sourceKeys = space === 'plan' ? scene.geom.planSourceKeys : scene.geom.views.sourceKeys;
  const sourcePrims = space === 'plan' ? scene.geom.plan : scene.geom.views.prims;
  const replaced = new Set(entities.flatMap(e => e.replacesSource ? [e.replacesSource] : []));
  sourceKeys.forEach((key, i) => {
    if (!key || replaced.has(key) || !selection.includes(sourceSelectionId(key))) return;
    const p = sourcePrims[i]; if (p) highlightPrim(ctx, p, to);
  });
  ctx.restore();
}

function highlightPrim(ctx: CanvasRenderingContext2D, p: Prim, to: P2S): void {
  if (p.k === 'text') { const s = to(p.p); ctx.beginPath(); ctx.arc(s.x, s.y, 7, 0, Math.PI * 2); ctx.fill(); }
  else if (p.k === 'poly' && p.pts.length > 1) {
    ctx.beginPath(); p.pts.forEach((q, i) => { const s = to(q); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
    if (p.closed) ctx.closePath(); ctx.stroke();
  }
}

function drawSheet(inp: RenderInput, to: P2S): void {
  const { ctx, cam, hiddenLayers } = inp;
  const views = inp.scene.geom.views;
  const explode = inp.explodePrims ?? [];
  if ((!views || views.prims.length === 0) && explode.length === 0) {
    ctx.save();
    ctx.fillStyle = UI_COLORS.rubber;
    ctx.font = `14px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('没有可生成的视图（项目里还没有柜体）', inp.vw / 2, inp.vh / 2);
    ctx.restore();
    return;
  }
  if (views && views.prims.length > 0) {
    drawPrims(ctx, drawingPrims(inp.scene.project, 'sheet', views.prims, views.sourceKeys), to, hiddenLayers, cam.scale);
    drawDrawingSelection(inp, to, 'sheet');
  }
  // 分解图最后画：它在下方的独立图幅里，与四视图的图元本来就不重叠，
  // 顺序只影响"万一以后两者贴到一起"时的叠压关系 —— 分解图应该在上面。
  if (explode.length > 0) drawPrims(ctx, explode, to, hiddenLayers, cam.scale);
  drawSheetHover(inp, to);
}

/**
 * 悬停到的那条线的反馈。
 * 可拖（蓝，实线）+ 两端端帽：告诉用户"抓住的是这一条，方向是延长/缩短"；
 * 不可拖（红，虚线）：告诉用户"这条看得见但动手没用"，配合状态栏的理由文字。
 */
function drawSheetHover(inp: RenderInput, to: P2S): void {
  const h = inp.sheetHover;
  if (!h || h.pts.length < 2) return;
  const { ctx } = inp;
  const pts = h.pts.map(to);
  ctx.save();
  ctx.strokeStyle = h.draggable ? UI_COLORS.grip : UI_COLORS.problem;
  ctx.lineWidth = h.draggable ? 3.2 : 2;
  ctx.globalAlpha = 0.95;
  if (!h.draggable) ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
  if (h.draggable) {
    ctx.setLineDash([]);
    ctx.fillStyle = UI_COLORS.grip;
    for (const p of [pts[0], pts[pts.length - 1]]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ───────────────────────────── 栅格 ─────────────────────────────

function drawGrid(inp: RenderInput, to: P2S): void {
  const { ctx, vw, vh, cam } = inp;
  const step = niceGridStep(cam.scale);
  const stepPx = step * cam.scale;
  if (stepPx < 5) return;

  const tl = screenToWorld({ x: 0, y: 0 }, cam, vw, vh);
  const br = screenToWorld({ x: vw, y: vh }, cam, vw, vh);
  const minX = Math.floor(tl.x / step) * step;
  const maxX = Math.ceil(br.x / step) * step;
  const minY = Math.floor(br.y / step) * step;
  const maxY = Math.ceil(tl.y / step) * step;
  const maxLines = 800;

  const drawSet = (multiple: number, color: string): void => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    let count = 0;
    for (let x = minX; x <= maxX; x += step) {
      if (Math.round(x / step) % multiple !== 0) continue;
      if (++count > maxLines) break;
      const sx = Math.round(to({ x, y: 0 }).x) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, vh);
    }
    for (let y = minY; y <= maxY; y += step) {
      if (Math.round(y / step) % multiple !== 0) continue;
      if (++count > maxLines) break;
      const sy = Math.round(to({ x: 0, y }).y) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(vw, sy);
    }
    ctx.stroke();
  };

  drawSet(1, UI_COLORS.gridMinor);
  if (stepPx * 5 >= 8) drawSet(5, UI_COLORS.gridMajor);

  // 世界原点轴：在无限平面上提供方向感
  const o = to({ x: 0, y: 0 });
  ctx.lineWidth = 1;
  if (o.y >= 0 && o.y <= vh) {
    ctx.strokeStyle = UI_COLORS.axisX;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(o.y) + 0.5);
    ctx.lineTo(vw, Math.round(o.y) + 0.5);
    ctx.stroke();
  }
  if (o.x >= 0 && o.x <= vw) {
    ctx.strokeStyle = UI_COLORS.axisY;
    ctx.beginPath();
    ctx.moveTo(Math.round(o.x) + 0.5, 0);
    ctx.lineTo(Math.round(o.x) + 0.5, vh);
    ctx.stroke();
  }
}

// ───────────────────────────── 图元 ─────────────────────────────

function drawPrim(ctx: CanvasRenderingContext2D, p: Prim, to: P2S, scale: number): void {
  const ld = layerOf(p.layer);
  switch (p.k) {
    case 'poly': {
      if (p.pts.length < 2) return;
      ctx.strokeStyle = ld.color;
      ctx.lineWidth = Math.max(0.6, p.lw);
      ctx.setLineDash(p.dash ? p.dash.map((d) => d * scale) : []);
      ctx.beginPath();
      p.pts.forEach((pt, i) => {
        const s = to(pt);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      if (p.closed) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
      return;
    }
    case 'fill': {
      if (p.pts.length < 3) return;
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.fillStyle = ld.color;
      ctx.beginPath();
      p.pts.forEach((pt, i) => {
        const s = to(pt);
        if (i === 0) ctx.moveTo(s.x, s.y);
        else ctx.lineTo(s.x, s.y);
      });
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return;
    }
    case 'text': {
      const sizePx = p.size * scale;
      if (sizePx < 5.5) return;
      const s = to(p.p);
      ctx.save();
      ctx.translate(s.x, s.y);
      if (p.rot) ctx.rotate((-p.rot * Math.PI) / 180);
      ctx.font = `${sizePx.toFixed(1)}px ${FONT_STACK}`;
      ctx.fillStyle = ld.color;
      ctx.textAlign = p.align === 'l' ? 'left' : p.align === 'r' ? 'right' : 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, 0, 0);
      ctx.restore();
      return;
    }
    default:
      return; // 未知图元：忽略。渲染层绝不能让界面白屏。
  }
}

/**
 * 画一批图元 —— **唯一**的画法。
 *
 * 导出它，是为了让别处（草案缩略图）能复用同一份画法去画**单张立面**，
 * 而不是另写一套简笔画：两份实现一定会在某次改动后分叉，届时
 * "小图上看着对、点开大图却是另一回事"，小图就成了骗人的图。
 */
export function drawPrims(ctx: CanvasRenderingContext2D, prims: Prim[], to: P2S, hidden: Set<string>, scale: number): void {
  for (const p of prims) {
    if (hidden.has(p.layer)) continue;
    drawPrim(ctx, p, to, scale);
  }
}

// ───────────────────────────── 墙 / 柜 ─────────────────────────────

function drawWalls(inp: RenderInput, to: P2S): void {
  const { ctx, cam, hiddenLayers, hover } = inp;
  const { project } = inp.scene;

  for (const room of project.rooms) {
    for (const w of room.walls) {
      const poly = wallPolygon(w);
      if (poly.length === 0) continue;
      drawPrims(
        ctx,
        [
          { k: 'fill', pts: poly, layer: 'A-WALL', alpha: 0.22 },
          { k: 'poly', pts: poly, closed: true, layer: 'A-WALL', lw: 2 },
        ],
        to,
        hiddenLayers,
        cam.scale
      );

      const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
      if (len * cam.scale > 46) {
        const mx = (w.start.x + w.end.x) / 2;
        const my = (w.start.y + w.end.y) / 2;
        let rot = (Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x) * 180) / Math.PI;
        if (rot > 90 || rot < -90) rot += 180;
        drawPrim(ctx, { k: 'text', p: { x: mx, y: my }, text: `${Math.round(len)}`, size: 100, layer: 'A-TEXT', align: 'c', rot }, to, cam.scale);
      }

      if (hover === w.id) {
        const s = to(w.start);
        const e = to(w.end);
        ctx.save();
        ctx.strokeStyle = UI_COLORS.hover;
        ctx.lineWidth = 4;
        ctx.globalAlpha = 0.7;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }
}

/**
 * 门扇开启范围（P8.9）：把空间层算好的包络图元画出来，画在墙**之上**、柜**之下**。
 *
 * 这里只做"画"—— 包络是扇区还是 unknown、铰链在哪、半径多少，
 * 全由 core/spatial/door.ts 决定。渲染器一旦自己动手算弧，
 * 图上看到的就未必是校验用的那一个了。
 */
function drawDoorSwing(inp: RenderInput, to: P2S): void {
  const prims = inp.doorSwingPrims ?? [];
  if (prims.length === 0) return;
  drawPrims(inp.ctx, prims, to, inp.hiddenLayers, inp.cam.scale);
}

function drawCabinets(inp: RenderInput, to: P2S): void {
  const { ctx, cam, hiddenLayers, hover } = inp;
  const { project, geom } = inp.scene;

  for (const cab of project.cabinets) {
    const g = geom.cabinets[cab.id];
    if (!g) continue;
    drawPrims(ctx, g.plan, to, hiddenLayers, cam.scale);

    if (hover === cab.id) {
      const fp = getCabinetFootprint(cab).map(to);
      ctx.save();
      ctx.strokeStyle = UI_COLORS.hover;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      fp.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawSelectionHighlight(inp: RenderInput, to: P2S): void {
  const { ctx, selection } = inp;
  if (selection.length === 0) return;
  const { project } = inp.scene;

  for (const id of selection) {
    const cab = project.cabinets.find((c) => c.id === id);
    if (cab) {
      const fp = getCabinetFootprint(cab).map(to);
      ctx.save();
      ctx.strokeStyle = UI_COLORS.selection;
      ctx.lineWidth = 2;
      ctx.setLineDash([7, 4]);
      ctx.fillStyle = UI_COLORS.selectionFill;
      ctx.beginPath();
      fp.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      continue;
    }
    for (const room of project.rooms) {
      const w = room.walls.find((x) => x.id === id);
      if (!w) continue;
      const s = to(w.start);
      const e = to(w.end);
      ctx.save();
      ctx.strokeStyle = UI_COLORS.selection;
      ctx.lineWidth = 6;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(e.x, e.y);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// ───────────────────────────── 夹点 ─────────────────────────────

function drawGrips(inp: RenderInput, to: P2S): void {
  const { ctx, selection, hoverGrip, activeGrip } = inp;
  if (selection.length === 0) return;
  const { project } = inp.scene;

  for (const id of selection) {
    for (const g of gripsFor(project, id)) {
      const isActive = !!activeGrip && activeGrip.role === g.role && activeGrip.ownerId === g.ownerId;
      const isHot = !isActive && !!hoverGrip && hoverGrip.role === g.role && hoverGrip.ownerId === g.ownerId;
      const isMove = g.role === 'cab-move';
      const size = isActive ? 11 : isHot ? 10 : 8;
      const s = to(g.p);

      ctx.save();
      ctx.strokeStyle = isActive || isHot ? UI_COLORS.gripHot : UI_COLORS.grip;
      ctx.lineWidth = isActive ? 2.4 : 1.5;
      if (isMove) {
        // 移动夹点画成十字，避免与"改尺寸"的方块在视觉上混淆
        ctx.beginPath();
        ctx.moveTo(s.x - size, s.y);
        ctx.lineTo(s.x + size, s.y);
        ctx.moveTo(s.x, s.y - size);
        ctx.lineTo(s.x, s.y + size);
        ctx.stroke();
      } else {
        ctx.fillStyle = isActive || isHot ? UI_COLORS.gripHot : UI_COLORS.gripFill;
        ctx.fillRect(s.x - size / 2, s.y - size / 2, size, size);
        ctx.strokeRect(s.x - size / 2, s.y - size / 2, size, size);
      }
      ctx.restore();

      if (isActive) drawChip(ctx, s, g.hint);
    }
  }
}

/** 统一的小气泡提示 */
function drawChip(ctx: CanvasRenderingContext2D, at: Vec2, text: string): void {
  ctx.save();
  ctx.font = `11px ${FONT_STACK}`;
  const w = ctx.measureText(text).width + 14;
  const x = at.x + 14;
  const y = at.y - 28;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, 20, 5);
  else ctx.rect(x, y, w, 20);
  ctx.fill();
  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 7, y + 10);
  ctx.restore();
}

// ───────────────────────────── 交互反馈 ─────────────────────────────

function drawDraftWall(inp: RenderInput, to: P2S): void {
  const { ctx, draftWall } = inp;
  if (!draftWall) return;
  const { a, b, thickness } = draftWall;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const sa = to(a);
  const sb = to(b);

  ctx.save();
  ctx.strokeStyle = UI_COLORS.draft;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 5]);
  ctx.beginPath();
  ctx.moveTo(sa.x, sa.y);
  ctx.lineTo(sb.x, sb.y);
  ctx.stroke();
  ctx.setLineDash([]);

  if (len > 1) {
    const nx = (-dy / len) * (thickness / 2);
    const ny = (dx / len) * (thickness / 2);
    const poly = [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ].map(to);
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
    drawChip(ctx, { x: (sa.x + sb.x) / 2, y: (sa.y + sb.y) / 2 }, `墙长 ${Math.round(len)}mm  厚 ${thickness}`);
  }
  ctx.restore();
}

function drawMarquee(inp: RenderInput, to: P2S): void {
  const { ctx, marquee } = inp;
  if (!marquee) return;
  const a = to(marquee.a);
  const b = to(marquee.b);
  const crossing = marquee.b.x < marquee.a.x; // 右→左 = 交叉选择（AutoCAD 约定）
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  ctx.save();
  ctx.fillStyle = crossing ? 'rgba(16,185,129,0.12)' : 'rgba(59,130,246,0.10)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = crossing ? '#10b981' : UI_COLORS.marquee;
  ctx.lineWidth = 1;
  ctx.setLineDash(crossing ? [6, 4] : [4, 3]);
  ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  ctx.restore();
}

function drawTracking(inp: RenderInput, to: P2S): void {
  const { ctx, snap } = inp;
  if (!snap?.tracking) return;
  const a = to(snap.tracking.from);
  const b = to(snap.tracking.to);
  ctx.save();
  ctx.strokeStyle = UI_COLORS.tracking;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.setLineDash([10, 6]);
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

const SNAP_SHAPE: Record<string, 'square' | 'triangle' | 'circle' | 'cross'> = {
  end: 'square',
  quad: 'square',
  mid: 'triangle',
  center: 'circle',
  intersect: 'cross',
  grid: 'cross',
  ortho: 'cross',
  polar: 'cross',
  none: 'cross',
};

function drawSnapMarker(inp: RenderInput, to: P2S): void {
  const { ctx, snap } = inp;
  if (!snap || snap.kind === 'none') return;
  const s = to(snap.p);
  const shape = SNAP_SHAPE[snap.kind] ?? 'cross';

  ctx.save();
  ctx.strokeStyle = UI_COLORS.snap;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  if (shape === 'square') {
    ctx.rect(s.x - 5, s.y - 5, 10, 10);
  } else if (shape === 'triangle') {
    ctx.moveTo(s.x, s.y - 6);
    ctx.lineTo(s.x + 6, s.y + 4);
    ctx.lineTo(s.x - 6, s.y + 4);
    ctx.closePath();
  } else if (shape === 'circle') {
    ctx.arc(s.x, s.y, 5.5, 0, Math.PI * 2);
  } else {
    ctx.moveTo(s.x - 6, s.y);
    ctx.lineTo(s.x + 6, s.y);
    ctx.moveTo(s.x, s.y - 6);
    ctx.lineTo(s.x, s.y + 6);
  }
  ctx.stroke();
  ctx.restore();

  const text = snap.ref ? `${snapKindLabel(snap.kind)}（${snap.ref}）` : snapKindLabel(snap.kind);
  if (text) drawChip(ctx, { x: s.x, y: s.y - 16 }, text);
}
