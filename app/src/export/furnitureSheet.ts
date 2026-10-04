/**
 * ══════════════════════════════════════════════════════════════════════
 *  家具生产图纸（一页一件家具，对标工厂标准版式）
 *
 *  ── 版式（横向，Y 轴向上）──
 *
 *      ┌──────┬─────────────────────────────┬──────────────┐
 *      │装订线 │ 地柜平面结构图 │ 吊柜平面结构图 │              │
 *      │      ├─────────────────────────────┤  标题 + 规格表 │
 *      │      │ 立面外观图    │ 立面结构图    │   （右侧边栏）  │
 *      │      ├─────────────────────────────┤              │
 *      │      │ 客户信息栏（底部通栏）        │              │
 *      └──────┴─────────────────────────────┴──────────────┘
 *
 *  ── 设计原则 ──
 *    1. **一页一件家具**：按房间分组，一个房间一张图。
 *       旧的 buildProjectViews 把所有柜子横向排成一排，DXF 坐标飞到 X: -650~56140 ——
 *       那是 bug，不是特性。这里每个房间独立成图，坐标范围控制在 0~10000 内。
 *    2. **零新几何**：四个视图的图元全部来自 buildCabinetViews（同一套派生链），
 *       本文件只做"提取 + 平移 + 摆到图幅位置"。尺寸数字全部取自模型参数，
 *       不做任何重算（"图 = 料"的架构线）。
 *    3. **红色工艺标注**：ledStrip / 玻璃门 / 见光板等，从模型派生，用 F-ANNOT-RED 图层，
 *       DXF 侧映射为红色，HTML 侧渲染为红色。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Cabinet, Prim, Project, Room, RuleSet, Vec2 } from '../core/types.ts';
import { buildCabinetViews, DimLayout } from '../core/geometry/views.ts';
import { allUnits } from '../core/layoutModel.ts';

// ── 图层 ──
const L_TEXT = 'F-TEXT';
/** 红色工艺标注（DXF 映射为红色，HTML 渲染为红色） */
const L_ANNOT_RED = 'F-ANNOT-RED';
/** 图框线 */
const L_BORDER = 'F-BORDER';

// ── 版式常量（mm，Y 向上）──
const BIND_W = 500;      // 左侧装订线区域宽
const SIDE_W = 2600;     // 右侧边栏宽
const BOT_H = 1500;      // 底部客户信息栏高
const MARGIN = 400;      // 视图区边距
const VIEW_GAP_X = 800;  // 两视图间水平间距（含尺寸链空间）
const VIEW_GAP_Y = 1200; // 平面图与立面图间垂直间距（含尺寸链空间）
const CAB_GAP = 120;     // 同一视图内柜体间距

// ── 文字尺寸 ──
const SZ_TITLE = 220;      // 家具名标题
const SZ_VIEW_TITLE = 170; // 视图标题（地柜平面结构图等）
const SZ_TABLE_H = 130;    // 表格表头
const SZ_TABLE = 120;      // 表格内容
const SZ_ANNOT = 130;      // 红色工艺标注

// ─────────────────────────── 基础工具 ───────────────────────────

/** 图元平移 */
function translatePrims(prims: Prim[], dx: number, dy: number): Prim[] {
  return prims.map((p) => {
    if (p.k === 'text') {
      return { ...p, p: { x: p.p.x + dx, y: p.p.y + dy } };
    }
    return { ...p, pts: p.pts.map((q) => ({ x: q.x + dx, y: q.y + dy })) };
  });
}

/** 矩形框 */
function rectPrim(x0: number, y0: number, x1: number, y1: number, layer: string, lw: number, dash?: number[]): Prim {
  return {
    k: 'poly',
    pts: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    closed: true,
    layer,
    lw,
    ...(dash ? { dash } : {}),
  };
}

/** 直线 */
function linePrim(x0: number, y0: number, x1: number, y1: number, layer: string, lw: number, dash?: number[]): Prim {
  return {
    k: 'poly',
    pts: [
      { x: x0, y: y0 },
      { x: x1, y: y1 },
    ],
    closed: false,
    layer,
    lw,
    ...(dash ? { dash } : {}),
  };
}

/** 文字（空字符串不生成图元，避免 DXF 侧跳过导致计数对不上） */
function textPrim(x: number, y: number, text: string, size: number, layer: string, align: 'l' | 'c' | 'r' = 'c', rot?: number): Prim | null {
  if (!text) return null;
  return { k: 'text', p: { x, y }, text, size, layer, align, ...(rot !== undefined ? { rot } : {}) };
}

/** 安全推送文字（null 自动跳过） */
function pushText(prims: Prim[], x: number, y: number, text: string, size: number, layer: string, align: 'l' | 'c' | 'r' = 'c', rot?: number): void {
  const p = textPrim(x, y, text, size, layer, align, rot);
  if (p) prims.push(p);
}

// ─────────────────────────── 柜体分类 ───────────────────────────

export type CabinetClass = 'base' | 'wall';

/**
 * 柜体分类：
 *   wall = 吊柜（mountHeight > 0，壁挂）
 *   base = 地柜（含高柜，落地）
 */
export function classifyCabinet(cab: Cabinet): CabinetClass {
  return (cab.params.mountHeight ?? 0) > 0 ? 'wall' : 'base';
}

// ─────────────────────────── 工艺标注派生 ───────────────────────────

/**
 * 从柜体模型派生红色工艺标注（对标生产图纸）。
 * 返回 { text, cabinetId } 数组，调用方负责摆到图上合适位置。
 */
export function deriveCraftNotes(cab: Cabinet, rules: RuleSet): string[] {
  const notes: string[] = [];
  const units = allUnits(cab.layout);

  // 灯带
  const ledPositions = new Set<string>();
  for (const u of units) {
    const ls = u.shelves?.ledStrip;
    if (ls && ls !== 'none') ledPositions.add(ls);
  }
  const LED_ZH: Record<string, string> = { center: '灯带居中', front: '灯带靠前', angled45: '45°灯带' };
  for (const pos of ledPositions) {
    if (LED_ZH[pos]) notes.push(LED_ZH[pos]);
  }

  // 玻璃门 → 黑框灰玻
  const doorUnit = units.find((u) => u.doors);
  if (doorUnit?.doors?.material) {
    const mat = rules.materials[doorUnit.doors.material];
    if (mat?.kind === 'glass') notes.push('黑框灰玻');
  }

  // 背板
  const bp = cab.params.backPanel;
  if (bp) {
    // 18mm 背板特别标注（参考图中有"18mm背板"）
    // 这里简化：只要有背板信息就标注厚度
    notes.push(`${bp.grooveDepth > 0 ? bp.grooveDepth : 18}mm背板`);
  }

  // 抽屉 → 托底抽
  const hasDrawers = units.some((u) => u.drawers);
  if (hasDrawers) notes.push('托底抽');

  // 层板 → 活动层板
  const hasShelves = units.some((u) => u.shelves && u.shelves.count > 0);
  if (hasShelves) notes.push('活动层板');

  // 见光板
  const fe = cab.params.finishedEnds;
  if (fe === 'left' || fe === 'right') notes.push(`${fe === 'left' ? '左' : '右'}见光板`);
  else if (fe === 'both') notes.push('双侧见光板');

  return notes;
}

// ─────────────────────────── 视图提取与排布 ───────────────────────────

interface PlacedView {
  prims: Prim[];
  /** 在图幅上的位置（左下角） */
  x: number;
  y: number;
  /** 内容宽高 */
  w: number;
  h: number;
}

/**
 * 把一组柜体的指定视图横向排成一排。
 * @param cabinets 柜体数组
 * @param viewKind 'top' | 'front' | 'internal'
 * @param rules 规则集
 * @param yOffset 每个柜体在 Y 方向的偏移（立面图里吊柜按 mountHeight 抬高）
 */
function layoutRow(
  cabinets: Cabinet[],
  viewKind: 'top' | 'front' | 'internal',
  rules: RuleSet,
  yOffset: (cab: Cabinet) => number = () => 0
): PlacedView {
  const prims: Prim[] = [];
  let maxH = 0;
  let minX = Infinity;
  let maxX = -Infinity;

  // 按柜体在房间里的实际 placement.x 定位，不按宽度首尾相接硬排
  // （否则 10 个 2000mm 的柜子会排成 20000mm，DXF 坐标飞掉）
  const sorted = [...cabinets].sort((a, b) => a.placement.x - b.placement.x);
  // 归一化：最左边的柜子从 x=0 开始
  const x0 = sorted.length > 0 ? sorted[0]!.placement.x : 0;

  for (const cab of sorted) {
    let vs;
    try {
      // 用 0 间距生成，然后按 meta.origin 归一化到原点
      vs = buildCabinetViews(cab, rules, { x: 0, y: 0, gapTop: 0, gapSide: 0, gapInt: 0 });
    } catch {
      continue;
    }
    const viewPrims = vs.prims[viewKind];
    const origin = vs.meta[viewKind].origin;
    const dy = yOffset(cab);

    // 归一化到原点，再摆到实际房间 X 位置（减去 x0 归一化）
    const px = cab.placement.x - x0;
    const placed = translatePrims(viewPrims, px - origin.x, dy - origin.y);
    prims.push(...placed);

    const w = vs.meta[viewKind].w;
    const h = vs.meta[viewKind].h;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px + w);
    maxH = Math.max(maxH, h + dy);
  }

  const totalW = sorted.length > 0 ? maxX - minX : 0;

  return { prims, x: 0, y: 0, w: totalW, h: maxH };
}

// ─────────────────────────── 图框 ───────────────────────────

interface SheetLayout {
  /** 图幅总宽高 */
  W: number;
  H: number;
  /** 各区域位置 */
  planBase: { x: number; y: number; w: number; h: number };
  planWall: { x: number; y: number; w: number; h: number };
  elevFront: { x: number; y: number; w: number; h: number };
  elevInternal: { x: number; y: number; w: number; h: number };
}

/**
 * 计算图幅布局（动态尺寸，基于内容）。
 */
function computeLayout(
  planBase: PlacedView,
  planWall: PlacedView,
  elevFront: PlacedView,
  elevInternal: PlacedView
): SheetLayout {
  // 内容区宽度：取最宽的一行
  const contentW = Math.max(planBase.w + VIEW_GAP_X + planWall.w, elevFront.w + VIEW_GAP_X + elevInternal.w, 2000);

  const W = BIND_W + MARGIN + contentW + MARGIN + SIDE_W;
  // 高度：底部栏 + 立面区 + 间距 + 平面区 + 边距
  const planH = Math.max(planBase.h, planWall.h);
  const elevH = Math.max(elevFront.h, elevInternal.h);
  const H = BOT_H + MARGIN + elevH + VIEW_GAP_Y + planH + MARGIN;

  const drawX = BIND_W + MARGIN;
  const elevY = BOT_H + MARGIN;
  const planY = elevY + elevH + VIEW_GAP_Y;

  return {
    W,
    H,
    planBase: { x: drawX, y: planY, w: planBase.w, h: planBase.h },
    planWall: { x: drawX + planBase.w + VIEW_GAP_X, y: planY, w: planWall.w, h: planWall.h },
    elevFront: { x: drawX, y: elevY, w: elevFront.w, h: elevFront.h },
    elevInternal: { x: drawX + elevFront.w + VIEW_GAP_X, y: elevY, w: elevInternal.w, h: elevInternal.h },
  };
}

// ─────────────────────────── 主函数 ───────────────────────────

export interface FurnitureSheetResult {
  /** 图元（含图框、标注） */
  prims: Prim[];
  bbox: { min: Vec2; max: Vec2 };
  /** 家具名（用于图框标题） */
  furnitureName: string;
  /** 房间名 */
  roomName: string;
}

/**
 * 一个房间 → 一张家具生产图纸。
 *
 * @param room 房间
 * @param cabinets 该房间的柜体
 * @param project 项目（取项目名、客户信息等）
 * @param rules 规则集
 * @param opts 家具名（缺省用房间名）
 */
export function buildFurnitureSheet(
  room: Room,
  cabinets: Cabinet[],
  project: Project,
  rules: RuleSet,
  opts: { furnitureName?: string } = {}
): FurnitureSheetResult {
  const furnitureName = opts.furnitureName ?? room.name;
  const prims: Prim[] = [];

  // ── 1. 分类 ──
  const baseCabs = cabinets.filter((c) => classifyCabinet(c) === 'base');
  const wallCabs = cabinets.filter((c) => classifyCabinet(c) === 'wall');

  // ── 2. 生成四个视图 ──
  // 平面图：top 视图横向排列
  const planBase = layoutRow(baseCabs, 'top', rules);
  const planWall = layoutRow(wallCabs, 'top', rules);
  // 立面图：front/internal 视图横向排列，吊柜按 mountHeight 抬高
  const mountY = (cab: Cabinet) => cab.params.mountHeight ?? 0;
  const elevFront = layoutRow(cabinets, 'front', rules, mountY);
  const elevInternal = layoutRow(cabinets, 'internal', rules, mountY);

  // ── 3. 计算图幅布局 ──
  const L = computeLayout(planBase, planWall, elevFront, elevInternal);

  // ── 4. 放置视图图元 ──
  const placeView = (v: PlacedView, tx: number, ty: number): void => {
    prims.push(...translatePrims(v.prims, tx - v.x, ty - v.y));
  };
  placeView(planBase, L.planBase.x, L.planBase.y);
  placeView(planWall, L.planWall.x, L.planWall.y);
  placeView(elevFront, L.elevFront.x, L.elevFront.y);
  placeView(elevInternal, L.elevInternal.x, L.elevInternal.y);

  // ── 5. 尺寸链 ──
  const dims = new DimLayout();

  // 辅助：在指定位置为一排柜体加水平尺寸链
  const addRowHDims = (
    cabs: Cabinet[],
    startX: number,
    y: number,
    side: 'top' | 'bottom',
    baseOffset: number,
    chainPrefix: string
  ): void => {
    if (cabs.length === 0) return;
    // 按 placement.x 排序并归一化，与 layoutRow 的摆位一致
    const sorted = [...cabs].sort((a, b) => a.placement.x - b.placement.x);
    const x0 = sorted[0]!.placement.x;
    let minX = Infinity;
    let maxX = -Infinity;
    sorted.forEach((cab) => {
      const w = cab.params.width;
      const cx = startX + (cab.placement.x - x0);
      dims.add({
        p0: { x: cx, y },
        p1: { x: cx + w, y },
        txt: `${w}`,
        orientation: 'h',
        side,
        chain: `${chainPrefix}-seg`,
        baseOffset,
        textOffset: side === 'top' ? 170 : -170,
      });
      minX = Math.min(minX, cx);
      maxX = Math.max(maxX, cx + w);
    });
    const totalW = maxX - minX;
    // 总宽
    dims.add({
      p0: { x: startX, y },
      p1: { x: startX + totalW, y },
      txt: `${Math.round(totalW)}`,
      orientation: 'h',
      side,
      chain: `${chainPrefix}-total`,
      baseOffset: baseOffset + 400,
      textOffset: side === 'top' ? 170 : -170,
    });
  };

  // 平面图尺寸：顶部总宽 + 底部各段宽 + 两侧深度
  if (baseCabs.length > 0) {
    const bx = L.planBase.x;
    const by = L.planBase.y;
    // 顶部总宽
    addRowHDims(baseCabs, bx, by + planBase.h, 'top', 300, 'planBase');
    // 底部各段
    addRowHDims(baseCabs, bx, by, 'bottom', 300, 'planBase-b');
    // 两侧深度（取最大深度）
    const maxD = Math.max(...baseCabs.map((c) => c.params.depth));
    dims.add({
      p0: { x: bx, y: by },
      p1: { x: bx, y: by + maxD },
      txt: `${maxD}`,
      orientation: 'v',
      side: 'left',
      baseOffset: 300,
      textOffset: 200,
      rot: 90,
    });
    dims.add({
      p0: { x: bx + planBase.w, y: by },
      p1: { x: bx + planBase.w, y: by + maxD },
      txt: `${maxD}`,
      orientation: 'v',
      side: 'right',
      baseOffset: 300,
      textOffset: 200,
      rot: 90,
    });
  }

  if (wallCabs.length > 0) {
    const wx = L.planWall.x;
    const wy = L.planWall.y;
    addRowHDims(wallCabs, wx, wy + planWall.h, 'top', 300, 'planWall');
    addRowHDims(wallCabs, wx, wy, 'bottom', 300, 'planWall-b');
    const maxD = Math.max(...wallCabs.map((c) => c.params.depth));
    dims.add({
      p0: { x: wx, y: wy },
      p1: { x: wx, y: wy + maxD },
      txt: `${maxD}`,
      orientation: 'v',
      side: 'left',
      baseOffset: 300,
      textOffset: 200,
      rot: 90,
    });
    dims.add({
      p0: { x: wx + planWall.w, y: wy },
      p1: { x: wx + planWall.w, y: wy + maxD },
      txt: `${maxD}`,
      orientation: 'v',
      side: 'right',
      baseOffset: 300,
      textOffset: 200,
      rot: 90,
    });
  }

  // 立面图尺寸：顶部总宽 + 底部各段宽 + 两侧总高
  if (cabinets.length > 0) {
    const fx = L.elevFront.x;
    const fy = L.elevFront.y;
    addRowHDims(cabinets, fx, fy + elevFront.h, 'top', 300, 'elevFront');
    addRowHDims(cabinets, fx, fy, 'bottom', 300, 'elevFront-b');
    // 总高（左侧）
    dims.add({
      p0: { x: fx, y: fy },
      p1: { x: fx, y: fy + elevFront.h },
      txt: `${Math.round(elevFront.h)}`,
      orientation: 'v',
      side: 'left',
      baseOffset: 400,
      textOffset: 220,
      rot: 90,
    });

    const ix = L.elevInternal.x;
    const iy = L.elevInternal.y;
    addRowHDims(cabinets, ix, iy + elevInternal.h, 'top', 300, 'elevInternal');
    addRowHDims(cabinets, ix, iy, 'bottom', 300, 'elevInternal-b');
    dims.add({
      p0: { x: ix + elevInternal.w, y: iy },
      p1: { x: ix + elevInternal.w, y: iy + elevInternal.h },
      txt: `${Math.round(elevInternal.h)}`,
      orientation: 'v',
      side: 'right',
      baseOffset: 400,
      textOffset: 220,
      rot: 90,
    });
  }

  dims.emit(prims);

  // ── 6. 视图标题 ──
  const viewTitle = (x: number, y: number, w: number, text: string): void => {
    pushText(prims, x + w / 2, y, text, SZ_VIEW_TITLE, L_TEXT, 'c');
  };
  // 平面图标题在图下方，立面图标题在图下方（参考图：标题在视图下方）
  if (baseCabs.length > 0) {
    viewTitle(L.planBase.x, L.planBase.y - 700, planBase.w, '地柜平面结构图');
  }
  if (wallCabs.length > 0) {
    viewTitle(L.planWall.x, L.planWall.y - 700, planWall.w, '吊柜平面结构图');
  }
  if (cabinets.length > 0) {
    viewTitle(L.elevFront.x, L.elevFront.y - 700, elevFront.w, '立面外观图');
    viewTitle(L.elevInternal.x, L.elevInternal.y - 700, elevInternal.w, '立面结构图');
  }

  // ── 7. 红色工艺标注 ──
  // 在立面外观图上方标注每个柜体的工艺要点
  {
    let cx = L.elevFront.x;
    for (const cab of cabinets) {
      const notes = deriveCraftNotes(cab, rules);
      const w = cab.params.width;
      const topY = L.elevFront.y + elevFront.h + 900;
      // 每个柜体的标注纵向排列，避免重叠
      notes.slice(0, 3).forEach((note, i) => {
        pushText(prims, cx + w / 2, topY - i * 220, note, SZ_ANNOT, L_ANNOT_RED, 'c');
      });
      cx += w + CAB_GAP;
    }
  }

  // ── 8. 图框 ──
  drawFrame(prims, L, furnitureName, room.name, project, cabinets, rules);

  // ── 9. bbox ──
  const bbox = {
    min: { x: 0, y: 0 },
    max: { x: L.W, y: L.H },
  };

  return { prims, bbox, furnitureName, roomName: room.name };
}

// ─────────────────────────── 图框绘制 ───────────────────────────

/**
 * 绘制图框：装订线 + 右侧边栏 + 底部客户信息栏 + 外框。
 */
function drawFrame(
  prims: Prim[],
  L: SheetLayout,
  furnitureName: string,
  _roomName: string,
  project: Project,
  cabinets: Cabinet[],
  rules: RuleSet
): void {
  const { W, H } = L;

  // ── 外框（双线）──
  prims.push(rectPrim(20, 20, W - 20, H - 20, L_BORDER, 2.0));
  prims.push(rectPrim(60, 60, W - 60, H - 60, L_BORDER, 0.8));

  // ── 装订线（左侧垂直虚线 + 文字）──
  const bindX = BIND_W / 2;
  prims.push(linePrim(bindX, 100, bindX, H - 100, L_BORDER, 0.8, [80, 60]));
  // "装订线"竖排文字
  const bindChars = ['装', '订', '线'];
  bindChars.forEach((ch, i) => {
    pushText(prims, bindX, H / 2 + 200 - i * 260, ch, 200, L_TEXT, 'c');
  });

  // ── 右侧边栏 ──
  const sideX = W - SIDE_W;
  drawSidebar(prims, sideX, 60, SIDE_W - 120, H - 120, furnitureName, cabinets, rules);

  // ── 底部客户信息栏 ──
  const botW = sideX - BIND_W - 120;
  drawBottomBar(prims, BIND_W + 60, 60, botW, BOT_H - 120, project);
}

/**
 * 右侧边栏：标题 + 规格表。
 */
function drawSidebar(
  prims: Prim[],
  x: number,
  y: number,
  w: number,
  h: number,
  furnitureName: string,
  cabinets: Cabinet[],
  rules: RuleSet
): void {
  // 边栏外框
  prims.push(rectPrim(x, y, x + w, y + h, L_BORDER, 1.5));

  let cy = y + h; // 从上往下画

  // ── 标题 ──
  const titleH = 600;
  prims.push(linePrim(x, cy - titleH, x + w, cy - titleH, L_BORDER, 1.2));
  pushText(prims, x + w / 2, cy - titleH / 2, furnitureName, SZ_TITLE, L_TEXT, 'c');
  cy -= titleH;

  // ── 表格行辅助 ──
  const rowH = 320;
  const labelW = 700; // 左列（标签）宽

  const drawRow = (label: string, content: string = '', opts: { labelSize?: number } = {}): void => {
    prims.push(linePrim(x, cy - rowH, x + w, cy - rowH, L_BORDER, 0.8));
    prims.push(linePrim(x + labelW, cy, x + labelW, cy - rowH, L_BORDER, 0.8));
    // 标签（可能竖排，如"柜体"）
    if (label.length <= 2) {
      // 短标签横排
      pushText(prims, x + labelW / 2, cy - rowH / 2, label, SZ_TABLE_H, L_TEXT, 'c');
    } else {
      pushText(prims, x + labelW / 2, cy - rowH / 2, label, opts.labelSize ?? SZ_TABLE, L_TEXT, 'c');
    }
    if (content) {
      pushText(prims, x + labelW + 80, cy - rowH / 2, content, SZ_TABLE, L_TEXT, 'l');
    }
    cy -= rowH;
  };

  // 从第一个柜体取材质信息
  const firstCab = cabinets[0];
  const boardMat = firstCab ? (rules.materials[firstCab.params.boardMaterial]?.name ?? '') : '';

  drawRow('设计师');
  drawRow('联系电话');
  drawRow('销售地址');
  drawRow('销售人员');
  drawRow('柜体工艺', '标准 □  新工艺 □');

  // 柜体（多行）
  drawRow('柜体', `颜色：`);
  drawRow('', `材质：${boardMat}`);
  drawRow('', `规格：25 □  18 □  9 □  5 □`);
  drawRow('', `封边：同色带字 □  同色 □`);

  // 移门
  drawRow('移门', `型号：`);
  drawRow('', `颜色：`);
  drawRow('', `边框：`);
  drawRow('', `芯板：`);
  drawRow('', `玻璃：`);

  // 掩门
  drawRow('掩门', `型号：`);
  drawRow('', `材质：`);
  drawRow('', `颜色：`);
  drawRow('', `看面：`);
  drawRow('', `玻璃：`);

  // 线条
  drawRow('线条', `罗马柱：`);
  drawRow('', `顶线：`);
  drawRow('', `楣板：`);
  drawRow('', `围脚：平板 □  造型 □`);

  drawRow('下单日期');
  drawRow('交货日期');

  // 剩余空间填充（如果表格没填满）
  if (cy > y) {
    // 不画线，保持空白
  }
}

/**
 * 底部客户信息栏。
 */
function drawBottomBar(prims: Prim[], x: number, y: number, w: number, h: number, _project: Project): void {
  prims.push(rectPrim(x, y, x + w, y + h, L_BORDER, 1.5));

  const rowH = h / 4;
  let cy = y + h;

  // 第1行：客户姓名 | 联系电话 | 客户地址 | ... | 发货□ 送货□ 安装□ | 客户签字
  const cols1 = [
    { label: '客户姓名', w: 0.12 },
    { label: '联系电话', w: 0.14 },
    { label: '客户地址', w: 0.30 },
    { label: '发货 □ 送货 □ 安装 □', w: 0.22 },
    { label: '客户签字：', w: 0.22 },
  ];
  drawTableRow(prims, x, cy - rowH, w, rowH, cols1.map((c) => ({ ...c, w: c.w * w })));
  cy -= rowH;

  // 第2行：滑轨 标配□ | 试衣镜 标配□ | 平开门拉手 | 备注：
  const cols2 = [
    { label: '滑轨 标配 □', w: 0.12 },
    { label: '试衣镜 标配 □', w: 0.14 },
    { label: '平开门拉手', w: 0.30 },
    { label: '备注：', w: 0.44 },
  ];
  drawTableRow(prims, x, cy - rowH, w, rowH, cols2.map((c) => ({ ...c, w: c.w * w })));
  cy -= rowH;

  // 第3行：门铰 标配□ | 内抽拉手 | 榻榻米铺板拉手 |
  const cols3 = [
    { label: '门铰 标配 □', w: 0.12 },
    { label: '内抽拉手', w: 0.14 },
    { label: '榻榻米铺板拉手', w: 0.30 },
    { label: '', w: 0.44 },
  ];
  drawTableRow(prims, x, cy - rowH, w, rowH, cols3.map((c) => ({ ...c, w: c.w * w })));
  cy -= rowH;

  // 第4行：衣杆 标配□ | 外抽拉手 | 页码 |
  const cols4 = [
    { label: '衣杆 标配 □', w: 0.12 },
    { label: '外抽拉手', w: 0.14 },
    { label: '页码', w: 0.30 },
    { label: '', w: 0.44 },
  ];
  drawTableRow(prims, x, cy - rowH, w, rowH, cols4.map((c) => ({ ...c, w: c.w * w })));
}

/** 绘制表格行 */
function drawTableRow(
  prims: Prim[],
  x: number,
  y: number,
  totalW: number,
  rowH: number,
  cols: Array<{ label: string; w: number }>
): void {
  prims.push(linePrim(x, y, x + totalW, y, L_BORDER, 0.8));
  let cx = x;
  for (const col of cols) {
    if (cx > x) {
      prims.push(linePrim(cx, y, cx, y + rowH, L_BORDER, 0.8));
    }
    if (col.label) {
      pushText(prims, cx + 40, y + rowH / 2, col.label, SZ_TABLE, L_TEXT, 'l');
    }
    cx += col.w;
  }
}

// ─────────────────────────── 房间分组 ───────────────────────────

export interface RoomGroup {
  room: Room;
  cabinets: Cabinet[];
}

/**
 * 按房间分组柜体（房间按 rooms 数组顺序；无归属的进"未分配"组）。
 */
export function groupByRoom(project: Project): RoomGroup[] {
  const groups: RoomGroup[] = [];
  for (const room of project.rooms) {
    const inRoom = project.cabinets
      .filter((c) => c.roomId === room.id)
      .sort((a, b) => a.placement.y - b.placement.y || a.placement.x - b.placement.x);
    if (inRoom.length > 0) {
      groups.push({ room, cabinets: inRoom });
    }
  }
  const orphans = project.cabinets.filter((c) => !project.rooms.some((r) => r.id === c.roomId));
  if (orphans.length > 0) {
    groups.push({
      room: { id: '', name: '未分配房间', walls: [] },
      cabinets: orphans,
    });
  }
  return groups;
}
