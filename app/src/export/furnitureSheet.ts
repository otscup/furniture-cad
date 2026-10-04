/**
 * ══════════════════════════════════════════════════════════════════════
 *  家具生产图纸 v4（一页一件家具，对标工厂标准版式）
 *
 *  ── 版式（横向 A3，Y 轴向上，单位：1/10mm）──
 *
 *      ┌──────┬─────────────────────────────┬──────────────┐
 *      │装订线 │ 地柜平面结构图 │ 吊柜平面结构图 │              │
 *      │      ├─────────────────────────────┤  标题 + 规格表 │
 *      │      │ 立面外观图    │ 立面结构图    │   （右侧边栏）  │
 *      │      ├─────────────────────────────┤              │
 *      │      │ 客户信息栏（底部通栏）        │              │
 *      └──────┴─────────────────────────────┴──────────────┘
 *
 *  ── 核心设计 ──
 *    1. **缩放**：柜体按实际 mm 生成视图，然后按内容尺寸动态缩放，
 *       确保图幅总宽 ≤14000（任务要求 0~15000 内）。
 *    2. **图要大**：四个视图占页面 70%+ 面积，单视图宽 ≈ 可用宽度 45%。
 *    3. **尺寸稀疏**：每视图 3-4 条尺寸链（顶部总宽、底部各段、两侧）。
 *    4. **零新几何**：视图图元来自 buildCabinetViews，只做提取+缩放+摆位。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Cabinet, Prim, Project, Room, RuleSet, Vec2 } from '../core/types.ts';
import { buildCabinetViews, DimLayout } from '../core/geometry/views.ts';
import { allUnits } from '../core/layoutModel.ts';

// ── 图层 ──
const L_TEXT = 'F-TEXT';
const L_ANNOT_RED = 'F-ANNOT-RED';
const L_BORDER = 'F-BORDER';
const L_DIM = 'F-DIM';

// ── 图幅（单位：1/10mm）──
const SHEET_W = 14000;
const SHEET_H = 10000;
const BIND_W = 400;
const SIDE_W = 2200;
const BOT_H = 1400;
const MARGIN = 300;

const DRAW_X = BIND_W + MARGIN;
const DRAW_W = SHEET_W - BIND_W - MARGIN - SIDE_W - MARGIN;
const DRAW_Y = BOT_H + MARGIN;
const DRAW_H = SHEET_H - BOT_H - MARGIN - MARGIN;

const PLAN_H = Math.floor(DRAW_H * 0.32);
const ELEV_H = Math.floor(DRAW_H * 0.55);
const GAP_Y = DRAW_H - PLAN_H - ELEV_H;
const VIEW_GAP_X = 600;

const SZ_TITLE = 320;
const SZ_VIEW_TITLE = 220;
const SZ_TABLE = 150;
const SZ_ANNOT = 160;

// ─────────────────────────── 基础工具 ───────────────────────────

function translatePrims(prims: Prim[], dx: number, dy: number): Prim[] {
  return prims.map((p) => {
    if (p.k === 'text') {
      return { ...p, p: { x: p.p.x + dx, y: p.p.y + dy } };
    }
    if (p.k === 'poly' || p.k === 'fill') {
      return { ...p, pts: p.pts.map((pt) => ({ x: pt.x + dx, y: pt.y + dy })) };
    }
    return p;
  });
}

function scalePrims(prims: Prim[], s: number): Prim[] {
  return prims.map((p) => {
    if (p.k === 'text') {
      return { ...p, p: { x: p.p.x * s, y: p.p.y * s }, size: (p.size ?? 90) * s };
    }
    if (p.k === 'poly' || p.k === 'fill') {
      return { ...p, pts: p.pts.map((pt) => ({ x: pt.x * s, y: pt.y * s })) };
    }
    return p;
  });
}

function primsBBox(prims: Prim[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of prims as any[]) {
    const pts: Array<{x:number;y:number}> = [];
    if (p.pts) pts.push(...p.pts);
    if (p.p) pts.push(p.p);
    for (const pt of pts) {
      if (pt.x < minX) minX = pt.x;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.y > maxY) maxY = pt.y;
    }
  }
  if (!isFinite(minX)) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}

function rectPrim(x1: number, y1: number, x2: number, y2: number, layer: string, lw: number): Prim {
  return {
    k: 'poly',
    pts: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }],
    closed: true, layer, lw,
  } as Prim;
}

function textPrim(x: number, y: number, text: string, size: number, layer: string, align: 'l'|'c'|'r' = 'l'): Prim {
  return { k: 'text', p: { x, y }, text, size, layer, align } as Prim;
}

function linePrim(x1: number, y1: number, x2: number, y2: number, layer: string, lw: number, dash = false): Prim {
  const p: any = { k: 'poly', pts: [{ x: x1, y: y1 }, { x: x2, y: y2 }], closed: false, layer, lw };
  if (dash) p.dash = [6, 4];
  return p as Prim;
}

// ─────────────────────────── 柜体分类 ───────────────────────────

function classifyCabinet(cab: Cabinet): 'base' | 'wall' | 'tall' {
  const h = cab.params.height;
  const mountH = cab.params.mountHeight ?? 0;
  if (mountH > 500) return 'wall';
  if (h > 1800) return 'tall';
  return 'base';
}

// ─────────────────────────── 视图生成（1:1 mm） ───────────────────────────

interface RawView {
  prims: Prim[];
  w: number;
  h: number;
}

// 结构图里不需要的板件名称标签（图形已足够表达，去掉避免文字堆叠）
const PANEL_LABEL_RE = /^(顶板|底板|左侧板|右侧板|踢脚板|中立板\d*|行隔板|层板|斜层板|见光板)/;

function buildRawView(
  cabinets: Cabinet[],
  viewKind: 'top' | 'front' | 'internal',
  rules: RuleSet,
  yOffset: (cab: Cabinet) => number = () => 0
): RawView {
  const prims: Prim[] = [];
  if (cabinets.length === 0) return { prims, w: 0, h: 0 };

  const sorted = [...cabinets].sort((a, b) => a.placement.x - b.placement.x);
  const x0 = sorted[0]!.placement.x;
  let maxX = 0;
  let maxH = 0;

  for (const cab of sorted) {
    let vs;
    try {
      vs = buildCabinetViews(cab, rules, { x: 0, y: 0, gapTop: 0, gapSide: 0, gapInt: 0 });
    } catch {
      continue;
    }
    let viewPrims = vs.prims[viewKind];
    // 问题1修复：internal 视图去掉板件名称标签（避免"顶板/左侧板/..."堆叠）
    if (viewKind === 'internal') {
      viewPrims = viewPrims.filter((p) => {
        if (p.k !== 'text') return true;
        const t = (p as any).text as string ?? '';
        // 保留尺寸数字（纯数字）和重要标注，去掉板件名称
        if (/^\d+$/.test(t.trim())) return true;
        return !PANEL_LABEL_RE.test(t.trim());
      });
    }
    const origin = vs.meta[viewKind].origin;
    const dy = yOffset(cab);
    const px = cab.placement.x - x0;
    const placed = translatePrims(viewPrims, px - origin.x, dy - origin.y);
    prims.push(...placed);
    maxX = Math.max(maxX, px + vs.meta[viewKind].w);
    maxH = Math.max(maxH, vs.meta[viewKind].h + dy);
  }
  return { prims, w: maxX, h: maxH };
}

// ─────────────────────────── 主函数 ───────────────────────────

export interface FurnitureSheetResult {
  prims: Prim[];
  bbox: { min: Vec2; max: Vec2 };
  furnitureName: string;
  roomName: string;
}

export interface RoomGroup {
  room: Room;
  cabinets: Cabinet[];
}

export function groupByRoom(project: Project): RoomGroup[] {
  const map = new Map<string, Cabinet[]>();
  for (const cab of project.cabinets) {
    const rid = (cab as any).roomId ?? project.rooms[0]?.id ?? 'default';
    if (!map.has(rid)) map.set(rid, []);
    map.get(rid)!.push(cab);
  }
  const groups: RoomGroup[] = [];
  for (const [rid, cabs] of map) {
    const room = project.rooms.find((r) => r.id === rid) ?? { id: rid, name: '未命名房间' } as Room;
    groups.push({ room, cabinets: cabs });
  }
  return groups;
}

export function buildFurnitureSheet(
  room: Room,
  cabinets: Cabinet[],
  project: Project,
  rules: RuleSet,
  opts: { furnitureName?: string } = {}
): FurnitureSheetResult {
  const furnitureName = opts.furnitureName ?? room.name;
  const prims: Prim[] = [];

  const baseCabs = cabinets.filter((c) => classifyCabinet(c) === 'base');
  const wallCabs = cabinets.filter((c) => classifyCabinet(c) === 'wall');
  const tallCabs = cabinets.filter((c) => classifyCabinet(c) === 'tall');
  const planCabs = [...baseCabs, ...tallCabs];

  const planBase = buildRawView(planCabs, 'top', rules);
  const planWall = buildRawView(wallCabs, 'top', rules);
  const mountY = (cab: Cabinet) => cab.params.mountHeight ?? 0;
  const elevFront = buildRawView(cabinets, 'front', rules, mountY);
  const elevInternal = buildRawView(cabinets, 'internal', rules, mountY);

  // ── 缩放 ──
  const availViewW = (DRAW_W - VIEW_GAP_X) / 2;
  const contentMaxW = Math.max(planBase.w, planWall.w, elevFront.w, elevInternal.w, 1);
  const contentPlanH = Math.max(planBase.h, planWall.h, 1);
  const contentElevH = Math.max(elevFront.h, elevInternal.h, 1);

  const sW = availViewW / contentMaxW;
  const sPlanH = PLAN_H / contentPlanH;
  const sElevH = ELEV_H / contentElevH;
  const scale = Math.min(sW, sPlanH, sElevH, 2.0);
  const s = Math.max(scale, 0.1);

  const planY = DRAW_Y + ELEV_H + GAP_Y;
  const elevY = DRAW_Y;

  const placeScaled = (view: RawView, tx: number, ty: number): void => {
    if (view.prims.length === 0) return;
    const bb = primsBBox(view.prims);
    let p = translatePrims(view.prims, -bb.minX, -bb.minY);
    p = scalePrims(p, s);
    p = translatePrims(p, tx, ty);
    prims.push(...p);
  };

  placeScaled(planBase, DRAW_X, planY);
  placeScaled(planWall, DRAW_X + availViewW + VIEW_GAP_X, planY);
  placeScaled(elevFront, DRAW_X, elevY);
  placeScaled(elevInternal, DRAW_X + availViewW + VIEW_GAP_X, elevY);

  const vW = contentMaxW * s;
  const vPlanH = contentPlanH * s;
  const vElevH = contentElevH * s;

  // ── 视图标题 ──
  if (planBase.prims.length > 0) {
    prims.push(textPrim(DRAW_X + vW / 2, planY - 260, '地柜平面结构图', SZ_VIEW_TITLE, L_TEXT, 'c'));
  }
  if (planWall.prims.length > 0) {
    prims.push(textPrim(DRAW_X + availViewW + VIEW_GAP_X + vW / 2, planY - 260, '吊柜平面结构图', SZ_VIEW_TITLE, L_TEXT, 'c'));
  }
  prims.push(textPrim(DRAW_X + vW / 2, elevY - 260, '立面外观图', SZ_VIEW_TITLE, L_TEXT, 'c'));
  prims.push(textPrim(DRAW_X + availViewW + VIEW_GAP_X + vW / 2, elevY - 260, '立面结构图', SZ_VIEW_TITLE, L_TEXT, 'c'));

  // ── 尺寸链（稀疏）──
  const dims = new DimLayout();
  const addHDims = (
    cabs: Cabinet[], viewX: number, y: number, side: 'top' | 'bottom', prefix: string
  ): void => {
    if (cabs.length === 0) return;
    const sorted = [...cabs].sort((a, b) => a.placement.x - b.placement.x);
    const x0 = sorted[0]!.placement.x;
    let minX = Infinity, maxX = -Infinity;
    for (const cab of sorted) {
      const wMm = cab.params.width;
      const cx = viewX + (cab.placement.x - x0) * s;
      const cw = wMm * s;
      dims.add({
        p0: { x: cx, y }, p1: { x: cx + cw, y },
        txt: `${Math.round(wMm)}`, orientation: 'h', side,
        chain: `${prefix}-seg`, baseOffset: 250, textOffset: side === 'top' ? 150 : -150,
      });
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx + cw);
    }
    dims.add({
      p0: { x: viewX, y }, p1: { x: viewX + (maxX - minX), y },
      txt: `${Math.round((maxX - minX) / s)}`, orientation: 'h', side,
      chain: `${prefix}-total`, baseOffset: 700, textOffset: side === 'top' ? 150 : -150,
    });
  };

  if (planCabs.length > 0) {
    const bx = DRAW_X, by = planY;
    addHDims(planCabs, bx, by + vPlanH + 100, 'top', 'pb');
    addHDims(planCabs, bx, by - 100, 'bottom', 'pb-b');
    const maxD = Math.max(...planCabs.map((c) => c.params.depth));
    dims.add({ p0: { x: bx - 100, y: by }, p1: { x: bx - 100, y: by + maxD * s },
      txt: `${maxD}`, orientation: 'v', side: 'left', baseOffset: 250, textOffset: 150, rot: 90 });
    dims.add({ p0: { x: bx + vW + 100, y: by }, p1: { x: bx + vW + 100, y: by + maxD * s },
      txt: `${maxD}`, orientation: 'v', side: 'right', baseOffset: 250, textOffset: 150, rot: 90 });
  }
  if (wallCabs.length > 0) {
    const bx = DRAW_X + availViewW + VIEW_GAP_X, by = planY;
    addHDims(wallCabs, bx, by + vPlanH + 100, 'top', 'pw');
    addHDims(wallCabs, bx, by - 100, 'bottom', 'pw-b');
  }
  {
    const bx = DRAW_X, by = elevY;
    addHDims(cabinets, bx, by + vElevH + 100, 'top', 'ef');
    addHDims(cabinets, bx, by - 100, 'bottom', 'ef-b');
    const maxH = Math.max(...cabinets.map((c) => c.params.height + (c.params.mountHeight ?? 0)));
    dims.add({ p0: { x: bx - 100, y: by }, p1: { x: bx - 100, y: by + maxH * s },
      txt: `${maxH}`, orientation: 'v', side: 'left', baseOffset: 250, textOffset: 150, rot: 90 });
    const ex = DRAW_X + availViewW + VIEW_GAP_X;
    dims.add({ p0: { x: ex + vW + 100, y: by }, p1: { x: ex + vW + 100, y: by + maxH * s },
      txt: `${maxH}`, orientation: 'v', side: 'right', baseOffset: 250, textOffset: 150, rot: 90 });
  }
  const dimPrims: Prim[] = [];
  dims.emit(dimPrims);
  prims.push(...dimPrims);

  // ── 红色工艺标注 ──
  const annotY = elevY + vElevH / 2;
  const hasGlass = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => {
      const m = (u.doors as any)?.material as string ?? '';
      return m.toLowerCase().includes('glass');
    }));
  if (hasGlass) prims.push(textPrim(DRAW_X + vW / 2, annotY + 400, '黑框灰玻', SZ_ANNOT, L_ANNOT_RED, 'c'));
  const hasLed = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => (u as any).ledStrip && (u as any).ledStrip !== 'none'));
  if (hasLed) prims.push(textPrim(DRAW_X + vW / 2, annotY + 200, '灯带居中', SZ_ANNOT, L_ANNOT_RED, 'c'));
  const hasDrawer = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => (u as any).drawers));
  if (hasDrawer) prims.push(textPrim(DRAW_X + vW / 2, annotY, '托底抽', SZ_ANNOT, L_ANNOT_RED, 'c'));
  const hasShelf = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => ((u as any).shelves ?? []).length > 0));
  if (hasShelf) prims.push(textPrim(DRAW_X + availViewW + VIEW_GAP_X + vW / 2, annotY, '活动层板', SZ_ANNOT, L_ANNOT_RED, 'c'));
  prims.push(textPrim(DRAW_X + availViewW + VIEW_GAP_X + vW / 2, annotY - 200, '18mm背板', SZ_ANNOT, L_ANNOT_RED, 'c'));

  // ── 图框 ──
  drawFrame(prims, furnitureName, project);

  // 防御：检查数字图层名（疑似某处把尺寸数值当成了 layer）
  for (const p of prims as any[]) {
    const layer = p.layer as string;
    if (typeof layer === 'string' && /^\d+$/.test(layer.trim())) {
      console.warn(`[furnitureSheet] 发现数字图层名 '${layer}'，已修正为 F-CAB (text=${p.text ?? ''})`);
      p.layer = 'F-CAB';
    }
  }

  return {
    prims,
    bbox: { min: { x: 0, y: 0 }, max: { x: SHEET_W, y: SHEET_H } },
    furnitureName,
    roomName: room.name,
  };
}

function drawFrame(prims: Prim[], furnitureName: string, _project: Project): void {
  const W = SHEET_W, H = SHEET_H;
  prims.push(rectPrim(60, 60, W - 60, H - 60, L_BORDER, 2));
  prims.push(rectPrim(100, 100, W - 100, H - 100, L_BORDER, 1));

  const bx = BIND_W / 2;
  prims.push(linePrim(bx, 200, bx, H - 200, L_BORDER, 0.8, true));
  const chars = ['装', '订', '线'];
  chars.forEach((ch, i) => {
    prims.push(textPrim(bx, H / 2 + 200 - i * 320, ch, 260, L_TEXT, 'c'));
  });

  const sx = W - SIDE_W;
  const sy = H - 100;
  prims.push(textPrim(sx + SIDE_W / 2, sy - 300, furnitureName, SZ_TITLE, L_TEXT, 'c'));
  prims.push(linePrim(sx, sy - 550, sx + SIDE_W, sy - 550, L_BORDER, 1));

  let ty = sy - 700;
  const rowH = 240;  // 问题6修复：从280降到240，侧边栏不超出图幅
  const drawSpecRow = (label: string, value: string = ''): void => {
    prims.push(textPrim(sx + 60, ty, label, SZ_TABLE, L_TEXT, 'l'));
    if (value) prims.push(textPrim(sx + 700, ty, value, SZ_TABLE, L_TEXT, 'l'));
    prims.push(linePrim(sx, ty - 90, sx + SIDE_W, ty - 90, L_BORDER, 0.6));
    ty -= rowH;
  };

  drawSpecRow('设计师');
  drawSpecRow('联系电话');
  drawSpecRow('销售地址');
  drawSpecRow('销售人员');
  drawSpecRow('柜体工艺', '标准□  新工艺□');
  // 大标题独占两行高度，避免与规格行重叠
  prims.push(textPrim(sx + 60, ty + 40, '柜', 280, L_TEXT, 'l'));
  prims.push(textPrim(sx + 60, ty - 240, '体', 280, L_TEXT, 'l'));
  ty -= 560;  // 大标题占用的垂直空间（问题6修复：从620降到560）
  drawSpecRow('  颜色');
  drawSpecRow('  材质');
  drawSpecRow('  规格', '25□ 18□ 9□ 5□');
  drawSpecRow('  封边', '同色带字□ 同色□');
  prims.push(textPrim(sx + 60, ty + 40, '移', 280, L_TEXT, 'l'));
  prims.push(textPrim(sx + 60, ty - 240, '门', 280, L_TEXT, 'l'));
  ty -= 620;
  drawSpecRow('  型号');
  drawSpecRow('  颜色');
  drawSpecRow('  边框');
  drawSpecRow('  芯板');
  drawSpecRow('  玻璃');
  prims.push(textPrim(sx + 60, ty + 40, '掩', 280, L_TEXT, 'l'));
  prims.push(textPrim(sx + 60, ty - 240, '门', 280, L_TEXT, 'l'));
  ty -= 620;
  drawSpecRow('  型号');
  drawSpecRow('  材质');
  drawSpecRow('  颜色');
  drawSpecRow('  看面');
  drawSpecRow('  玻璃');
  prims.push(textPrim(sx + 60, ty + 40, '线', 280, L_TEXT, 'l'));
  prims.push(textPrim(sx + 60, ty - 240, '条', 280, L_TEXT, 'l'));
  ty -= 620;
  drawSpecRow('  罗马柱');
  drawSpecRow('  顶线');
  drawSpecRow('  楣板');
  drawSpecRow('  围脚', '平板□ 造型□');
  drawSpecRow('下单日期');
  drawSpecRow('交货日期');

  const by = BOT_H;
  prims.push(linePrim(100, by, W - 100, by, L_BORDER, 1.2));
  let byy = by - 260;
  const browH = 250;  // 问题6修复：行高从320降到250，确保4行不超出 BOT_H
  const drawBotRow = (cells: Array<[string, string]>): void => {
    let cx = 160;
    for (const [label, val] of cells) {
      prims.push(textPrim(cx, byy, label, SZ_TABLE, L_TEXT, 'l'));
      if (val) prims.push(textPrim(cx + 420, byy, val, SZ_TABLE, L_TEXT, 'l'));
      cx += 1400;
    }
    prims.push(linePrim(100, byy - 110, W - 100, byy - 110, L_BORDER, 0.6));
    byy -= browH;
  };
  drawBotRow([['客户姓名', ''], ['联系电话', ''], ['客户地址', ''], ['发货□ 送货□ 安装□', '']]);
  drawBotRow([['滑轨', '标配□'], ['试衣镜', '标配□'], ['平开门拉手', ''], ['备注', '']]);
  drawBotRow([['门铰', '标配□'], ['内抽拉手', ''], ['榻榻米铺板拉手', '']]);
  drawBotRow([['衣杆', '标配□'], ['外抽拉手', ''], ['页码', '']]);
  // 签名放在底部栏右下角，确保 y > 0
  const sigY = Math.max(byy + 40, 120);
  prims.push(textPrim(W - 400, sigY, '客户签字：', SZ_TABLE, L_TEXT, 'l'));

  // 引用 L_DIM 避免未使用警告（尺寸链图层在 DimLayout 内部使用）
  void L_DIM;
}
