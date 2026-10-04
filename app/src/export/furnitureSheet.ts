/**
 * ══════════════════════════════════════════════════════════════════════
 *  家具生产图纸 v5（一页一件家具，对标工厂标准版式）
 *
 *  ── 版式（横向，Y 轴向上，单位：1/10mm）──
 *
 *      ┌──────┬─────────────────────────────┬──────────────┐
 *      │装订线 │ 地柜平面结构图 │ 吊柜平面结构图 │              │
 *      │      │   (标题在下方)  │   (标题在下方)  │  标题 + 规格表 │
 *      │      ├─────────────────────────────┤   （右侧边栏）  │
 *      │      │ 立面外观图    │ 立面结构图    │              │
 *      │      │   (标题在下方)  │   (标题在下方)  │              │
 *      │      ├─────────────────────────────┤              │
 *      │      │ 客户信息栏（底部通栏）        │              │
 *      └──────┴─────────────────────────────┴──────────────┘
 *
 *  ── 核心设计 ──
 *    1. **2x2 布局**：上=两平面图，下=两立面图，无中间行。
 *    2. **图要大**：四视图占页面 70%+，单视图宽 ≈ 可用宽度 45%。
 *    3. **标题在视图下方**，与尺寸链间距 ≥300。
 *    4. **红色标注带引线**：指向视图内对应位置，不浮空。
 *    5. **结构图无数字**：只保留红色工艺标注，定位尺寸只出现在尺寸链。
 *    6. **零新几何**：视图图元来自 buildCabinetViews，只做提取+缩放+摆位。
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
const SIDE_W = 1800;          // 缩窄边栏，给视图让空间
const BOT_H = 1600;
const MARGIN = 250;

const DRAW_X = BIND_W + MARGIN;
const DRAW_W = SHEET_W - BIND_W - MARGIN - SIDE_W - MARGIN;
// v8 修复：底部从 600 加到 1200，给立面底部两排尺寸链留空间，避免压住客户信息表格
const DRAW_Y = BOT_H + 1200;
const DRAW_H = SHEET_H - BOT_H - 1200 - MARGIN;

// 2x2 布局：上下两排，左右两列
const VIEW_GAP_X = 500;       // 左右视图间距
const ROW_GAP_Y = 900;        // 上下排间距（含标题+尺寸链空间）

const PLAN_H = Math.floor((DRAW_H - ROW_GAP_Y) * 0.36);
const ELEV_H = Math.floor((DRAW_H - ROW_GAP_Y) * 0.64);

const SZ_TITLE = 320;
const SZ_VIEW_TITLE = 240;
const SZ_TABLE = 150;
const SZ_ANNOT = 170;
// SZ_SIDEBAR_SECTION 已废弃：2026-10-04 改竖排小字，不再用横排大标题

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

// 结构图里去掉所有文字（数字+板件名），只保留图形；红色标注由我们统一加引线
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
    // internal 视图：去掉所有文字（定位尺寸 679/970、板件名等），只留图形
    // 红色工艺标注由 buildFurnitureSheet 统一加引线标注
    if (viewKind === 'internal') {
      viewPrims = viewPrims.filter((p) => p.k !== 'text');
      // 层板线稀疏化：只保留每柜 1-2 条关键横线（顶部、底部、中部），其余横线去掉
      // 参考 PDF 风格：留白+稀疏，不堆砌
      const isHorizontalLine = (p: Prim): boolean => {
        const pp = p as any;
        if (p.k !== 'poly' || pp.closed || pp.dash) return false;
        if (!pp.pts || pp.pts.length !== 2) return false;
        const [a, b] = pp.pts;
        return Math.abs(a.y - b.y) < 5 && Math.abs(a.x - b.x) > 100;
      };
      const horiz = viewPrims.filter(isHorizontalLine);
      if (horiz.length > 3) {
        // 按 Y 排序，保留顶部、底部、中部各一条
        const sorted = [...horiz].sort((a, b) => {
          const ya = (a as any).pts[0].y;
          const yb = (b as any).pts[0].y;
          return ya - yb;
        });
        const keep = new Set<Prim>();
        keep.add(sorted[0]!);
        keep.add(sorted[sorted.length - 1]!);
        keep.add(sorted[Math.floor(sorted.length / 2)]!);
        viewPrims = viewPrims.filter((p) => !isHorizontalLine(p) || keep.has(p));
      }
    }
    // front 视图：去掉门板 X 交叉实线，只保留虚线开向箭头
    // 用户要求：门板开向用虚线箭头，不用 X 实线
    if (viewKind === 'front') {
      viewPrims = viewPrims.filter((p) => {
        const pp = p as any;
        // 保留虚线（箭头），去掉实线对角线（X）
        if (p.k !== 'poly' || pp.closed || pp.dash) return true;
        if (!pp.pts || pp.pts.length !== 2) return true;
        const [a, b] = pp.pts;
        const dx = Math.abs(a.x - b.x);
        const dy = Math.abs(a.y - b.y);
        // 对角线：dx 和 dy 都显著 → X 线，去掉
        if (dx > 150 && dy > 150) return false;
        return true;
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

  // ── 缩放：四视图统一缩放，确保占满 70%+ 页面 ──
  const availViewW = (DRAW_W - VIEW_GAP_X) / 2;
  const contentMaxW = Math.max(planBase.w, planWall.w, elevFront.w, elevInternal.w, 1);
  const contentPlanH = Math.max(planBase.h, planWall.h, 1);
  const contentElevH = Math.max(elevFront.h, elevInternal.h, 1);

  const sW = availViewW / contentMaxW;
  const sPlanH = PLAN_H / contentPlanH;
  const sElevH = ELEV_H / contentElevH;
  const scale = Math.min(sW, sPlanH, sElevH, 2.0);
  const s = Math.max(scale, 0.1);

  // 2x2 布局：
  //   上排：planBase (左) | planWall (右)
  //   下排：elevFront (左) | elevInternal (右)
  //
  // 垂直排布（Y 轴向上，从下往上）：
  //   DRAW_Y                                    立面视图底部
  //   DRAW_Y + vElevH                           立面视图顶部
  //   + 250                                     立面顶部尺寸链
  //   + 350                                     红色标注（引线指向立面视图）
  //   + ROW_GAP_Y                               间距
  //   planY                                     平面视图底部
  //   planY + vPlanH                            平面视图顶部
  //   + 250                                     平面顶部尺寸链
  //
  // 标题在视图下方：
  //   平面标题 at planY - 550（平面底部尺寸链在 planY - 250，标题再往下 300）
  //   立面标题 at DRAW_Y - 550（立面底部无尺寸链，直接放标题）
  const elevY = DRAW_Y;
  const ANNOT_H = 500;  // 红色标注区高度
  const planY = elevY + contentElevH * s + 250 + 350 + ANNOT_H + ROW_GAP_Y;

  const placeScaled = (view: RawView, tx: number, ty: number): { x: number; y: number; w: number; h: number } => {
    if (view.prims.length === 0) return { x: tx, y: ty, w: 0, h: 0 };
    const bb = primsBBox(view.prims);
    let p = translatePrims(view.prims, -bb.minX, -bb.minY);
    p = scalePrims(p, s);
    p = translatePrims(p, tx, ty);
    prims.push(...p);
    return { x: tx, y: ty, w: (bb.maxX - bb.minX) * s, h: (bb.maxY - bb.minY) * s };
  };

  const pbBox = placeScaled(planBase, DRAW_X, planY);
  const pwBox = placeScaled(planWall, DRAW_X + availViewW + VIEW_GAP_X, planY);
  const efBox = placeScaled(elevFront, DRAW_X, elevY);
  const eiBox = placeScaled(elevInternal, DRAW_X + availViewW + VIEW_GAP_X, elevY);

  // ── 视图标题（在视图下方，与尺寸链间距 ≥300）──
  // v9 修复：标题 Y 动态计算，见 dims.emit() 之后。

  // ── 尺寸链（稀疏：每视图 3 条 —— 顶部总宽、底部各段、两侧）──
  const dims = new DimLayout();
  const DIM_OFF = 350;  // 尺寸线与视图的间距

  // 水平尺寸链：顶部总宽 + 底部各段
  const addHDims = (
    cabs: Cabinet[], box: { x: number; y: number; w: number; h: number }, prefix: string
  ): void => {
    if (cabs.length === 0 || box.w <= 0) return;
    const sorted = [...cabs].sort((a, b) => a.placement.x - b.placement.x);
    const x0 = sorted[0]!.placement.x;
    // 顶部：总宽
    dims.add({
      p0: { x: box.x, y: box.y + box.h }, p1: { x: box.x + box.w, y: box.y + box.h },
      txt: `${Math.round(box.w / s)}`, orientation: 'h', side: 'top',
      chain: `${prefix}-total`, baseOffset: DIM_OFF, textOffset: 150,
    });
    // 底部：各段
    for (const cab of sorted) {
      const cx = box.x + (cab.placement.x - x0) * s;
      const cw = cab.params.width * s;
      dims.add({
        p0: { x: cx, y: box.y }, p1: { x: cx + cw, y: box.y },
        txt: `${Math.round(cab.params.width)}`, orientation: 'h', side: 'bottom',
        chain: `${prefix}-seg`, baseOffset: DIM_OFF, textOffset: -150,
      });
    }
  };

  // 垂直尺寸链：左侧高度/深度
  const addVDims = (
    box: { x: number; y: number; w: number; h: number }, totalTxt: string, prefix: string
  ): void => {
    if (box.w <= 0) return;
    dims.add({
      p0: { x: box.x, y: box.y }, p1: { x: box.x, y: box.y + box.h },
      txt: totalTxt, orientation: 'v', side: 'left',
      chain: `${prefix}-v`, baseOffset: DIM_OFF, textOffset: 150, rot: 90,
    });
  };

  if (pbBox.w > 0) {
    addHDims(planCabs, pbBox, 'pb');
    const maxD = Math.max(...planCabs.map((c) => c.params.depth));
    addVDims(pbBox, `${maxD}`, 'pb');
  }
  if (pwBox.w > 0) {
    addHDims(wallCabs, pwBox, 'pw');
    const maxD = Math.max(...wallCabs.map((c) => c.params.depth));
    addVDims(pwBox, `${maxD}`, 'pw');
  }
  addHDims(cabinets, efBox, 'ef');
  {
    const maxH = Math.max(...cabinets.map((c) => c.params.height + (c.params.mountHeight ?? 0)));
    addVDims(efBox, `${maxH}`, 'ef');
  }
  // 立面结构图：只加顶部总宽和左侧高度，不加底部各段（避免与外观图重复）
  if (eiBox.w > 0) {
    dims.add({
      p0: { x: eiBox.x, y: eiBox.y + eiBox.h }, p1: { x: eiBox.x + eiBox.w, y: eiBox.y + eiBox.h },
      txt: `${Math.round(eiBox.w / s)}`, orientation: 'h', side: 'top',
      chain: 'ei-total', baseOffset: DIM_OFF, textOffset: 150,
    });
  }

  const dimPrims: Prim[] = [];
  dims.emit(dimPrims);

  // ── 视图标题（v9 修复）：按实际尺寸链最低位置动态定 Y ──
  // 取所有 Y < planY（平面视图下方）的尺寸图元最低点，标题放在其下方 450 处，
  // 确保标题（字号240）与最近的尺寸线/文字之间 ≥300 间距。
  // 之前硬编码 planY-1400，但 L1 尺寸文字在 planY-1300，直接压标题。
  const minDimYBelow = (refY: number): number => {
    let m = refY;
    for (const p of dimPrims) {
      if ((p as any).k === 'poly') {
        const pts = (p as any).pts as Array<{ x: number; y: number }>;
        for (const q of pts) if (q.y < refY && q.y < m) m = q.y;
      } else if ((p as any).k === 'text') {
        const y = (p as any).p.y as number;
        // 尺寸文字字号110，半高~55，往下再探 60
        if (y < refY && y - 60 < m) m = y - 60;
      }
    }
    return m;
  };
  const planTitleY = minDimYBelow(planY) - 450;
  if (pbBox.w > 0) {
    prims.push(textPrim(pbBox.x + pbBox.w / 2, planTitleY, '地柜平面结构图', SZ_VIEW_TITLE, L_TEXT, 'c'));
  }
  if (pwBox.w > 0) {
    prims.push(textPrim(pwBox.x + pwBox.w / 2, planTitleY, '吊柜平面结构图', SZ_VIEW_TITLE, L_TEXT, 'c'));
  }
  const elevTitleY = minDimYBelow(elevY) - 450;
  prims.push(textPrim(efBox.x + efBox.w / 2, elevTitleY, '立面外观图', SZ_VIEW_TITLE, L_TEXT, 'c'));
  prims.push(textPrim(eiBox.x + eiBox.w / 2, elevTitleY, '立面结构图', SZ_VIEW_TITLE, L_TEXT, 'c'));

  prims.push(...dimPrims);

  // ── 红色工艺标注（短引线，标注放在目标附近）──
  // 每个标注的文字放在目标点上方 400 处，引线垂直向下不超过 800

  const hasGlass = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => {
      const m = (u.doors as any)?.material as string ?? '';
      return m.toLowerCase().includes('glass');
    }));
  const hasLed = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => (u as any).ledStrip && (u as any).ledStrip !== 'none'));
  const hasDrawer = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => (u as any).drawers));
  const hasShelf = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => ((u as any).shelves ?? []).length > 0));

  // 引线目标：立面外观图/结构图内的对应位置（短引线，垂直为主）
  const efCX = efBox.x + efBox.w / 2;
  const eiCX = eiBox.x + eiBox.w / 2;
  const efMidY = efBox.y + efBox.h * 0.55;
  const efBotY = efBox.y + efBox.h * 0.25;
  const efTopInY = efBox.y + efBox.h * 0.85;

  // 短引线标注：文字在目标正上方 350 处，引线垂直，长度 350
  const shortAnnot = (px: number, py: number, text: string): void => {
    const tx = px, ty = py + 350;
    // 短垂直引线
    prims.push(linePrim(tx, ty - 40, px, py, L_ANNOT_RED, 0.8));
    // 目标点小圆点
    const dot = 50;
    prims.push({
      k: 'poly',
      pts: [
        { x: px - dot, y: py }, { x: px, y: py + dot },
        { x: px + dot, y: py }, { x: px, y: py - dot },
      ],
      closed: true, layer: L_ANNOT_RED, lw: 0.8,
    } as Prim);
    prims.push(textPrim(tx, ty, text, SZ_ANNOT, L_ANNOT_RED, 'c'));
  };

  if (hasGlass) {
    shortAnnot(efCX - efBox.w * 0.25, efTopInY, '黑框灰玻');
  }
  if (hasLed) {
    shortAnnot(efCX, efTopInY - efBox.h * 0.1, '灯带居中');
  }
  if (hasDrawer) {
    shortAnnot(efCX + efBox.w * 0.2, efBotY, '托底抽');
  }
  if (hasShelf) {
    shortAnnot(eiCX, efMidY, '活动层板');
  }
  if (eiBox.w > 0) {
    shortAnnot(eiCX + eiBox.w * 0.15, efMidY + 300, '18mm背板');
  }

  // ── 图框 ──
  drawFrame(prims, furnitureName, project);

  // 防御：检查数字图层名
  for (const p of prims as any[]) {
    const layer = p.layer as string;
    if (typeof layer === 'string' && /^\d+$/.test(layer.trim())) {
      console.warn(`[furnitureSheet] 发现数字图层名 '${layer}'，已修正为 F-CAB`);
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

  // 装订线：纸张最左边缘，不压图（在外框 60 之外）
  // v8 修复：x 从 30 移到 10，避开左侧 700/1800 垂直尺寸线
  const bx = 10;
  prims.push(linePrim(bx, 200, bx, H - 200, L_BORDER, 0.8, true));
  const chars = ['装', '订', '线'];
  chars.forEach((ch, i) => {
    prims.push(textPrim(bx, H / 2 + 200 - i * 320, ch, 260, L_TEXT, 'c'));
  });

  // ── 右侧边栏（右边缘与内框对齐 W-100，不超出）──
  const sx = W - SIDE_W;
  const SIDE_R = W - 100;  // 侧边栏右边缘 = 内框线
  const sy = H - 100;
  // 侧边栏左侧竖线（与主区隔开），从顶部到底部客户栏
  prims.push(linePrim(sx, 100, sx, H - 100, L_BORDER, 1));
  prims.push(textPrim(sx + (SIDE_R - sx) / 2, sy - 300, furnitureName, SZ_TITLE, L_TEXT, 'c'));
  prims.push(linePrim(sx, sy - 550, SIDE_R, sy - 550, L_BORDER, 1));

  let ty = sy - 700;
  const rowH = 220;  // 压缩行高，填满侧边栏

  const drawRow = (label: string, value: string = ''): void => {
    prims.push(textPrim(sx + 80, ty, label, SZ_TABLE, L_TEXT, 'l'));
    if (value) prims.push(textPrim(sx + 650, ty, value, SZ_TABLE, L_TEXT, 'l'));
    prims.push(linePrim(sx, ty - 100, SIDE_R, ty - 100, L_BORDER, 0.6));
    ty -= rowH;
  };

  // 分区标题：竖排小字在左侧（对标参考 PDF），内容行右移
  // 参考 PDF：柜体/移门/掩门/线条 竖排在分区左侧作标题
  const drawSection = (title: string, rows: Array<[string, string?]>): void => {
    const vSize = 150;  // 竖排小字
    const vX = sx + 60;  // 左侧竖排位置
    const n = title.length;
    // 竖排：逐字从上往下，垂直居中于整个分区
    const sectionH = rows.length * rowH;
    const startY = ty + 40 - (n * vSize * 0.6);  // 居中偏移
    for (let i = 0; i < n; i++) {
      prims.push(textPrim(vX, startY - i * vSize, title[i]!, vSize, L_TEXT, 'c'));
    }
    // 分区左侧竖线（标题与内容分隔）
    const secTop = ty + 80;
    const secBot = ty - sectionH + 40;
    prims.push(linePrim(vX + 110, secTop, vX + 110, secBot, L_BORDER, 0.8));
    // 内容行：x 右移避开竖排标题
    const saveSx = sx;
    for (const [label, value] of rows) {
      prims.push(textPrim(vX + 190, ty, '  ' + label, SZ_TABLE, L_TEXT, 'l'));
      // v8 修复：值从 vX+740 左移到 vX+450，"25□ 18□ 9□ 5□"等长文本不再超出右框线
      if (value) prims.push(textPrim(vX + 450, ty, value, SZ_TABLE, L_TEXT, 'l'));
      prims.push(linePrim(vX + 110, ty - 100, SIDE_R, ty - 100, L_BORDER, 0.6));
      ty -= rowH;
    }
    void saveSx;
  };

  drawRow('设计师');
  drawRow('联系电话');
  drawRow('销售地址');
  drawRow('销售人员');
  drawRow('柜体工艺', '标准□  新工艺□');
  drawSection('柜体', [
    ['颜色'], ['材质'], ['规格', '25□ 18□ 9□ 5□'], ['封边', '同色带字□ 同色□'],
  ]);
  drawSection('移门', [
    ['型号'], ['颜色'], ['边框'], ['芯板'], ['玻璃'],
  ]);
  drawSection('掩门', [
    ['型号'], ['材质'], ['颜色'], ['看面'], ['玻璃'],
  ]);
  drawSection('线条', [
    ['罗马柱'], ['顶线'], ['楣板'], ['围脚', '平板□ 造型□'],
  ]);
  drawRow('下单日期');
  drawRow('交货日期');

  // ── 底部客户信息栏 ──
  const by = BOT_H;
  prims.push(linePrim(100, by, W - 100, by, L_BORDER, 1.2));
  const botCols = [150, 3600, 7100, 10600];
  let byy = by - 300;
  const browH = 300;
  const drawBotRow = (cells: Array<[string, string]>): void => {
    cells.forEach(([label, val], i) => {
      const cx = botCols[i]!;
      if (i > 0) prims.push(linePrim(cx - 80, byy + 80, cx - 80, byy - 200, L_BORDER, 0.6));
      prims.push(textPrim(cx, byy, label, 140, L_TEXT, 'l'));
      if (val) prims.push(textPrim(cx + 950, byy, val, 140, L_TEXT, 'l'));
    });
    prims.push(linePrim(100, byy - 140, W - 100, byy - 140, L_BORDER, 0.6));
    byy -= browH;
  };
  drawBotRow([['客户姓名', ''], ['联系电话', ''], ['客户地址', ''], ['发货□ 送货□ 安装□', '']]);
  drawBotRow([['滑轨', '标配□'], ['试衣镜', '标配□'], ['平开门拉手', ''], ['备注', '']]);
  drawBotRow([['门铰', '标配□'], ['内抽拉手', ''], ['榻榻米铺板拉手', ''], ['客户签字：', '']]);
  drawBotRow([['衣杆', '标配□'], ['外抽拉手', ''], ['页码', '1/1'], ['下单日期', '']]);

  void L_DIM;
}
