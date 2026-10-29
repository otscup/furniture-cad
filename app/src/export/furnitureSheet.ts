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
import type { Cabinet, DrawingEntity, Prim, Project, Room, RuleSet, Vec2 } from '../core/types.ts';
import { buildCabinetViews, buildProjectViews, DimLayout, type ProjectViewSet } from '../core/geometry/views.ts';
import { drawingEntityPrims } from '../core/drawingEdits.ts';
import { computeCabinetLayout, doorWidths } from '../core/geometry/layout.ts';
import { estimateTextWidth } from '../core/geometry/labels.ts';
import { allUnits } from '../core/layoutModel.ts';
import { indexProjectRooms } from '../core/roomIndex.ts';

// ── 图层 ──
const L_TEXT = 'F-TEXT';
const L_ANNOT_RED = 'F-ANNOT-RED';
const L_BORDER = 'F-BORDER';
const L_DIM = 'F-DIM';

// ── 图幅（单位：1/10mm）──
const SHEET_W = 14000;
const SHEET_H = 10000;
const BIND_W = 400;
const SIDE_W = 2400;          // 72mm 信息栏：足够容纳标签/规格值而不压叠
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
const SZ_TABLE = 120;
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

export function classifyCabinet(cab: Cabinet): 'base' | 'wall' | 'tall' {
  const h = cab.params.height;
  const mountH = cab.params.mountHeight ?? 0;
  if (cab.params.cabinetType === 'wall' || mountH > 300) return 'wall';
  if (cab.params.cabinetType === 'tall' || h > 1800) return 'tall';
  return 'base';
}

/**
 * 计算整墙/整房多柜体展开 X 坐标（防遮挡 + L/U 型转角墙展开）：
 *  1. 同一墙面方向（rotation 0°/180° 按 X，90°/270° 按 Y）保持真实相对间距；
 *  2. 不同墙面方向（L 型/U 型转角）按墙分组依次展开，组间留 260mm 转角分隔，不再跳过旋转柜；
 *  3. 若同墙内两只柜体在水平 [x0, x1] 与垂直 [mountHeight, mountHeight+height] 同时发生重叠
 *     （例如未落位的新建柜、前后排岛台遮挡），自动将后一柜向右顺延避让，彻底消除柜体互相遮挡；
 *     而地柜（mountHeight=0）与正上方吊柜（mountHeight>0）因垂直标高不重叠，保持相同 X 上下对齐！
 */
export function computeUnfoldedWallX(cabinets: Cabinet[]): Map<string, number> {
  const result = new Map<string, number>();
  if (cabinets.length === 0) return result;
  if (cabinets.length === 1) {
    result.set(cabinets[0]!.id, cabinets[0]!.placement.x);
    return result;
  }

  const rotNorm = (rot: number): number => {
    const r = ((Math.round(rot / 90) * 90) % 360 + 360) % 360;
    return r;
  };
  const alongWallCoord = (cab: Cabinet): number => {
    const r = rotNorm(cab.placement.rotation);
    return r === 90 || r === 270 ? cab.placement.y : cab.placement.x;
  };
  const depthCoord = (cab: Cabinet): number => {
    const r = rotNorm(cab.placement.rotation);
    return r === 90 || r === 270 ? cab.placement.x : cab.placement.y;
  };

  // 按墙面朝向分组（0 -> 90 -> 180 -> 270）
  const wallOrder = [0, 90, 180, 270];
  const groups = new Map<number, Cabinet[]>();
  for (const cab of cabinets) {
    const g = rotNorm(cab.placement.rotation);
    const list = groups.get(g) ?? [];
    list.push(cab);
    groups.set(g, list);
  }

  const singleWallOnly = groups.size === 1 && groups.has(0);
  let wallCursorX = singleWallOnly ? Math.min(...cabinets.map((c) => c.placement.x)) : 0;

  for (const gKey of wallOrder) {
    const list = groups.get(gKey);
    if (!list || list.length === 0) continue;
    const sorted = [...list].sort((a, b) => {
      const da = alongWallCoord(a) - alongWallCoord(b);
      if (Math.abs(da) > 1) return da;
      const dd = depthCoord(a) - depthCoord(b);
      if (Math.abs(dd) > 1) return dd;
      return (a.params.mountHeight ?? 0) - (b.params.mountHeight ?? 0);
    });
    const minAlong = Math.min(...sorted.map(alongWallCoord));
    const placedSpans: Array<{ x0: number; x1: number; z0: number; z1: number; depth: number }> = [];
    let groupMaxX = wallCursorX;

    for (const cab of sorted) {
      let desiredX = wallCursorX + (alongWallCoord(cab) - minAlong);
      const w = cab.params.width;
      const z0 = cab.params.mountHeight ?? 0;
      const z1 = z0 + cab.params.height;
      const d = depthCoord(cab);

      // 若与已放置的同标高段柜体在水平方向重叠，向右顺延防遮挡
      let conflict = placedSpans.find(
        (s) => desiredX < s.x1 - 1 && desiredX + w > s.x0 + 1 && z0 < s.z1 - 1 && z1 > s.z0 + 1,
      );
      while (conflict) {
        const gap = Math.abs(d - conflict.depth) > 80 ? 160 : 0;
        desiredX = conflict.x1 + gap;
        conflict = placedSpans.find(
          (s) => desiredX < s.x1 - 1 && desiredX + w > s.x0 + 1 && z0 < s.z1 - 1 && z1 > s.z0 + 1,
        );
      }

      result.set(cab.id, desiredX);
      placedSpans.push({ x0: desiredX, x1: desiredX + w, z0, z1, depth: d });
      groupMaxX = Math.max(groupMaxX, desiredX + w);
    }
    wallCursorX = groupMaxX + 260;
  }
  return result;
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
  yOffset: (cab: Cabinet) => number = () => 0,
  drawingEdits: DrawingEntity[] = [],
  viewPlacements: Record<string, Vec2> = {},
  unfoldedX?: Map<string, number>,
): RawView {
  const prims: Prim[] = [];
  if (cabinets.length === 0) return { prims, w: 0, h: 0 };

  const xOf = (c: Cabinet): number => unfoldedX?.get(c.id) ?? c.placement.x;
  const sorted = [...cabinets].sort((a, b) => xOf(a) - xOf(b));
  const x0 = xOf(sorted[0]!);
  let maxX = 0;
  let maxH = 0;

  for (const cab of sorted) {
    let vs;
    try {
      vs = buildCabinetViews(cab, rules, { x: 0, y: 0, gapTop: 0, gapSide: 0, gapInt: 0 });
    } catch {
      continue;
    }
    const cabEdits = drawingEdits.filter(e => e.space === 'sheet' && e.cabinetId === cab.id && e.view === viewKind);
    const hiddenIndices = new Set(cabEdits.flatMap(e => {
      const parts = e.replacesSource?.split(':');
      return parts?.[0] === 'sheet' && parts[1] === cab.id && parts[2] === viewKind && Number.isInteger(Number(parts[3])) ? [Number(parts[3])] : [];
    }));
    let viewPrims = vs.prims[viewKind].filter((_, i) => !hiddenIndices.has(i));
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
    const px = xOf(cab) - x0;
    let placed = translatePrims(viewPrims, px - origin.x, dy - origin.y);
    if (viewKind === 'top' && placed.length > 0) {
      // 俯视图的外置预留标签落在原始视图 bbox 下方；整体归一到 y=0，
      // 并把扩展高度计入后续排版，避免标签被裁切或与尺寸链挤在同一行。
      const rawBox = primsBBox(placed);
      if (rawBox.minY < 0) placed = translatePrims(placed, 0, -rawBox.minY);
    }
    if (cabEdits.length) {
      let projectViews;
      try { projectViews = buildCabinetViews(cab, rules); } catch { projectViews = null; }
      const projectX = viewPlacements[cab.id]?.x;
      if (projectViews && projectX !== undefined) {
        const worldOffsetX = projectX - projectViews.meta.front.origin.x;
        const extras = cabEdits.flatMap(entity => {
          const mapped: DrawingEntity = {
            ...entity,
            points: entity.points.map(p => ({
              x: p.x - worldOffsetX - projectViews!.meta[viewKind].origin.x + origin.x,
              y: p.y - projectViews!.meta[viewKind].origin.y + origin.y,
            })),
          };
          return drawingEntityPrims(mapped);
        });
        placed = [...placed, ...translatePrims(extras, px, dy)];
      }
    }
    prims.push(...placed);
    const placedBox = primsBBox(placed);
    maxX = Math.max(maxX, px + vs.meta[viewKind].w, placedBox.maxX);
    maxH = Math.max(maxH, vs.meta[viewKind].h + dy, placedBox.maxY);
  }
  return { prims, w: maxX, h: maxH };
}

// ─────────────────────────── 主函数 ───────────────────────────

export interface FurnitureSheetResult {
  prims: Prim[];
  bbox: { min: Vec2; max: Vec2 };
  furnitureName: string;
  roomName: string;
  /** 各视图在图纸上的位置（世界坐标 bbox）—— 用于把单个视图裁出来给视觉模型 */
  views: {
    plan: { x: number; y: number; w: number; h: number } | null;
    front: { x: number; y: number; w: number; h: number };
    internal: { x: number; y: number; w: number; h: number };
  };
}

export interface RoomGroup {
  room: Room;
  cabinets: Cabinet[];
}

export function groupByRoom(project: Project): RoomGroup[] {
  return indexProjectRooms(project).map(({ room, cabinets }) => ({ room, cabinets }));
}

/** 背板注记只读取该柜体选用材料的规则厚度；缺失/非法厚度与双面柜均不标注。 */
export function backPanelThicknessNote(cabinet: Cabinet, rules: RuleSet): string | null {
  if (cabinet.layout.type === 'double' && Array.isArray(cabinet.layout.backUnits) && cabinet.layout.backUnits.length > 0) {
    return null;
  }
  const thickness = rules.materials[cabinet.params.backPanel.material]?.thickness;
  if (typeof thickness !== 'number' || !Number.isFinite(thickness) || thickness <= 0) return null;
  return `${thickness}mm背板`;
}

interface DoorLeafDimension {
  cabinet: Cabinet;
  face: 'front' | 'back';
  rowIndex: number;
  rowCount: number;
  unitIndex: number;
  leafIndex: number;
  width: number;
  height: number;
  x0: number;
  x1: number;
}

interface CabinetPartitionDimension {
  cabinet: Cabinet;
  face: 'front' | 'back';
  rowIndex: number;
  rowCount: number;
  unitIndex: number;
  x0: number;
  x1: number;
  partitionKind: string;
  label: string;
}

/** 门板宽高只从共享布局与 doorWidths() 派生，不在导出层重算制造尺寸。 */
function deriveDoorDimensions(cabinets: Cabinet[], rules: RuleSet): {
  leaves: DoorLeafDimension[];
  partitions: CabinetPartitionDimension[];
  schedule: Array<{ label: string; value: string }>;
} {
  const leaves: DoorLeafDimension[] = [];
  const partitions: CabinetPartitionDimension[] = [];

  for (const cabinet of cabinets) {
    const layout = computeCabinetLayout(cabinet, rules);
    const addUnit = (
      face: 'front' | 'back',
      rowIndex: number,
      rowCount: number,
      unitIndex: number,
      unit: Cabinet['layout']['units'][number],
      x0: number,
      netW: number,
      netH: number,
    ): void => {
      const partitionKind = unit.doors
        ? `${unit.doors.count}扇`
        : unit.drawers
          ? `${unit.drawers.count}抽`
          : unit.kind === 'appliance'
            ? '电器格'
            : '开放格';
      const rowTag = rowCount > 1 ? `R${rowIndex + 1}` : '';
      partitions.push({
        cabinet,
        face,
        rowIndex,
        rowCount,
        unitIndex,
        x0,
        x1: x0 + netW,
        partitionKind,
        label: `${face === 'front' ? '正' : '背'}${rowTag ? `${rowTag}·` : ''}${partitionKind}/${Math.round(netW)}`,
      });

      if (!unit.doors || unit.kind === 'appliance') return;
      const widths = doorWidths(unit, netW, rules);
      const height = netH - 2 * unit.doors.gapOuter;
      let x = x0 + unit.doors.gapOuter;
      widths.forEach((width, leafIndex) => {
        leaves.push({
          cabinet,
          face,
          rowIndex,
          rowCount,
          unitIndex,
          leafIndex,
          width,
          height,
          x0: x,
          x1: x + width,
        });
        x += width + unit.doors!.gapMid;
      });
    };

    for (const [rowIndex, row] of layout.rows.entries()) {
      row.units.forEach((unit, unitIndex) => {
        addUnit('front', rowIndex, layout.rows.length, unitIndex, unit, row.unitX0[unitIndex]!, row.nets[unitIndex]!, row.netH);
      });
    }

    // 双面柜的后排不出现在正立面，但它的门板仍须有可生产尺寸标注。
    const backUnits = cabinet.layout.backUnits;
    const backLayout = layout.double;
    if (backUnits && backLayout) {
      backUnits.forEach((unit, unitIndex) => {
        addUnit('back', 0, 1, unitIndex, unit, backLayout.backUnitX0[unitIndex]!, backLayout.backNets[unitIndex]!, layout.innerH);
      });
    }
  }

  // 尺寸表不按相同尺寸合并：每扇门均有独立行号及生产 W×H，尺寸链可去重，单扇清单不可去重。
  const schedule = leaves.map((leaf) => ({
    label: `${leaf.face === 'front' ? '正面' : '背面'}${leaf.rowCount > 1 ? `·R${leaf.rowIndex + 1}` : ''}·分区${leaf.unitIndex + 1}·门${leaf.leafIndex + 1}`,
    value: `${Math.round(leaf.width)}×${Math.round(leaf.height)}mm`,
  }));
  return { leaves, partitions, schedule };
}

function addFrontPartitionAndDoorDims(
  dims: DimLayout,
  box: { x: number; y: number; w: number; h: number },
  rawBounds: { minX: number; minY: number; maxX: number; maxY: number },
  cabinets: Cabinet[],
  dimensions: ReturnType<typeof deriveDoorDimensions>,
  scale: number,
  cabinetX0: number,
  unfoldedX?: Map<string, number>,
): void {
  const topY = box.y + box.h;
  const xOf = (c: Cabinet): number => unfoldedX?.get(c.id) ?? c.placement.x;
  const mapX = (cabinet: Cabinet, modelX: number): number =>
    box.x + (xOf(cabinet) - cabinetX0 + modelX - rawBounds.minX) * scale;

  const partitionGroups = new Map<string, { partition: CabinetPartitionDimension; rows: Set<number>; kinds: Set<string> }>();
  for (const partition of dimensions.partitions) {
    if (partition.face !== 'front' || !cabinets.includes(partition.cabinet)) continue;
    const mx0 = Math.round(mapX(partition.cabinet, partition.x0));
    const mx1 = Math.round(mapX(partition.cabinet, partition.x1));
    const key = cabinets.length > 1
      ? `${mx0}|${mx1}`
      : `${partition.cabinet.id}|${Math.round(partition.x0)}|${Math.round(partition.x1)}|${partition.partitionKind}`;
    const group = partitionGroups.get(key) ?? { partition, rows: new Set<number>(), kinds: new Set<string>() };
    group.rows.add(partition.rowIndex);
    group.kinds.add(partition.partitionKind);
    partitionGroups.set(key, group);
  }
  for (const { partition, rows, kinds } of partitionGroups.values()) {
    const kindStr = [...kinds].join('+');
    const label = cabinets.length > 1 && kinds.size > 1
      ? `正${kindStr}/${Math.round(partition.x1 - partition.x0)}`
      : rows.size > 1
        ? `正${[...rows].sort((a, b) => a - b).map((row) => `R${row + 1}`).join('+')}·${partition.partitionKind}/${Math.round(partition.x1 - partition.x0)}`
        : partition.label;
    dims.add({
      p0: { x: mapX(partition.cabinet, partition.x0), y: topY },
      p1: { x: mapX(partition.cabinet, partition.x1), y: topY },
      txt: label,
      orientation: 'h', side: 'top', chain: 'ef-partitions',
      baseOffset: 850, textOffset: 150,
    });
  }

  const leafGroups = new Map<string, DoorLeafDimension>();
  for (const leaf of dimensions.leaves) {
    if (leaf.face !== 'front' || !cabinets.includes(leaf.cabinet)) continue;
    const mx0 = Math.round(mapX(leaf.cabinet, leaf.x0));
    const mx1 = Math.round(mapX(leaf.cabinet, leaf.x1));
    const key = cabinets.length > 1
      ? `${mx0}|${mx1}|${Math.round(leaf.width)}`
      : `${leaf.cabinet.id}|${Math.round(leaf.x0)}|${Math.round(leaf.x1)}|${Math.round(leaf.width)}`;
    if (!leafGroups.has(key)) leafGroups.set(key, leaf);
  }
  for (const leaf of leafGroups.values()) {
    dims.add({
      p0: { x: mapX(leaf.cabinet, leaf.x0), y: topY },
      p1: { x: mapX(leaf.cabinet, leaf.x1), y: topY },
      // 位置本身唯一对应门扇；链上只标净宽值，门扇编号/宽×高完整列在侧栏，避免窄门的长文字逼出多层尺寸带。
      txt: `${Math.round(leaf.width)}`,
      orientation: 'h', side: 'top', chain: 'ef-door-leaves',
      baseOffset: 1450, textOffset: 150,
    });
  }
}

export function buildFurnitureSheet(
  room: Room,
  cabinets: Cabinet[],
  project: Project,
  rules: RuleSet,
  opts: { furnitureName?: string; projectViews?: ProjectViewSet } = {}
): FurnitureSheetResult {
  const furnitureName = opts.furnitureName ?? room.name;
  const prims: Prim[] = [];

  const unfoldedX = computeUnfoldedWallX(cabinets);
  const xOf = (c: Cabinet): number => unfoldedX.get(c.id) ?? c.placement.x;
  /**
   * ★ 整份项目的全部视图（供 drawingEdits 坐标换算用）──
   *
   * ★ 性能：这里曾经是 O(R×N²) 爆炸的根源 ──
   *   buildProjectViews 会给**项目里每只柜**各跑一次 buildCabinetViews，
   *   而 buildRoomBook 对每个房间调一次 buildFurnitureSheet、
   *   对每个叠放组再调一次 ⇒ 总调用 = (房间数 + 组数) × 柜数。
   *
   *   实测（10 柜/房）：
   *     1 房 183 ms → 2 房 480 ms → 4 房 3090 ms → 8 房 **22133 ms**
   *   8 房 80 柜要 22 秒，纯属灾难。
   *
   * ★ 修法：让调用方算一次，传进来 ──
   *   opts.projectViews 存在就用它，不存在才自己算（保持函数自足）。
   *   调用方（roomBook / neutralSheet）在整次导出开头算一次 ⇒ 降到 O(N)。
   */
  const projectViews = opts.projectViews ?? buildProjectViews(project, rules);
  const drawings = project.drawingEdits ?? [];

  // 只出单个俯视图：内容 = 全部柜体的 top 视图，居中置于上排
  const planSingle = buildRawView(cabinets, 'top', rules, () => 0, drawings, projectViews.placements, unfoldedX);
  const mountY = (cab: Cabinet) => cab.params.mountHeight ?? 0;
  const elevFront = buildRawView(cabinets, 'front', rules, mountY, drawings, projectViews.placements, unfoldedX);
  const elevInternal = buildRawView(cabinets, 'internal', rules, mountY, drawings, projectViews.placements, unfoldedX);

  // ── 缩放：三视图统一缩放，确保占满 70%+ 页面 ──
  const availViewW = (DRAW_W - VIEW_GAP_X) / 2;
  const contentMaxW = Math.max(planSingle.w, elevFront.w, elevInternal.w, 1);
  const contentPlanH = Math.max(planSingle.h, 1);
  const contentElevH = Math.max(elevFront.h, elevInternal.h, 1);

  const sW = availViewW / contentMaxW;
  const sPlanH = PLAN_H / contentPlanH;
  const sElevH = ELEV_H / contentElevH;
  let s = Math.max(Math.min(sW, sPlanH, sElevH, 2.0), 0.1);
  const doorDimensions = deriveDoorDimensions(cabinets, rules);
  const elevFrontRawBounds = primsBBox(elevFront.prims);
  const frontCabinetX0 = cabinets.length > 0 ? Math.min(...cabinets.map((cabinet) => xOf(cabinet))) : 0;
  const buildFrontDimensionProbe = (candidateScale: number): DimLayout => {
    const probe = new DimLayout();
    if (elevFront.w <= 0) return probe;
    const probeBox = {
      x: DRAW_X,
      y: DRAW_Y,
      w: (elevFrontRawBounds.maxX - elevFrontRawBounds.minX) * candidateScale,
      h: (elevFrontRawBounds.maxY - elevFrontRawBounds.minY) * candidateScale,
    };
    const topY = probeBox.y + probeBox.h;
    probe.add({
      p0: { x: probeBox.x, y: topY }, p1: { x: probeBox.x + probeBox.w, y: topY },
      txt: `${Math.round(probeBox.w / candidateScale)}`, orientation: 'h', side: 'top', chain: 'ef-total', baseOffset: 350, textOffset: 150,
    });
    addFrontPartitionAndDoorDims(probe, probeBox, elevFrontRawBounds, cabinets, doorDimensions, candidateScale, frontCabinetX0, unfoldedX);
    return probe;
  };

  const BASE_FRONT_DIM_BAND = 250 + 350 + 500 + ROW_GAP_Y;
  const PLAN_BOTTOM_RESERVE = 1180; // 俯视图底部尺寸线(350) + 俯视图标题(820) + 安全间距(360)
  const PLAN_TOP_RESERVE = 700; // 350mm 尺寸线 + 延伸线/文字/外边距的安全空间
  let frontDimensionProbe = buildFrontDimensionProbe(s);
  let frontDimBand = Math.max(BASE_FRONT_DIM_BAND, frontDimensionProbe.outermostOffset('top') + PLAN_BOTTOM_RESERVE);
  // 门数越多，文字避让可能增加若干层尺寸链；把这些层级计入缩放上限，保证俯视图仍落在 A3 内。
  for (let pass = 0; pass < 12; pass++) {
    const pageScaleLimit = (SHEET_H - MARGIN - DRAW_Y - frontDimBand - PLAN_TOP_RESERVE) / (contentElevH + contentPlanH);
    if (pageScaleLimit >= s - 1e-6) break;
    s = Math.max(0.1, Math.min(s, pageScaleLimit));
    frontDimensionProbe = buildFrontDimensionProbe(s);
    frontDimBand = Math.max(BASE_FRONT_DIM_BAND, frontDimensionProbe.outermostOffset('top') + PLAN_BOTTOM_RESERVE);
  }

  // 三视图布局：
  //   上排：plan（单个俯视图，整幅居中）
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
  // 最多门扇链由实际文字避让层数决定；需要时扩展前视图与俯视图间距，绝不让尺寸带撞上俯视图。
  const planY = elevY + contentElevH * s + frontDimBand;

  const placeScaled = (view: RawView, tx: number, ty: number): { x: number; y: number; w: number; h: number } => {
    if (view.prims.length === 0) return { x: tx, y: ty, w: 0, h: 0 };
    const bb = primsBBox(view.prims);
    let p = translatePrims(view.prims, -bb.minX, -bb.minY);
    p = scalePrims(p, s);
    p = translatePrims(p, tx, ty);
    prims.push(...p);
    return { x: tx, y: ty, w: (bb.maxX - bb.minX) * s, h: (bb.maxY - bb.minY) * s };
  };

  const pbBox = placeScaled(planSingle, DRAW_X + (DRAW_W - planSingle.w * s) / 2, planY);
  const efBox = placeScaled(elevFront, DRAW_X, elevY);
  const eiBox = placeScaled(elevInternal, DRAW_X + availViewW + VIEW_GAP_X, elevY);

  // ── 视图标题（在视图下方，与尺寸链间距 ≥300）──
  // v9 修复：标题 Y 动态计算，见 dims.emit() 之后。

  // ── 尺寸链（稀疏：每视图 3 条 —— 顶部总宽、底部各段、两侧）──
  const dims = new DimLayout();
  const DIM_OFF = 350;  // 尺寸线与视图的间距

  // 水平尺寸链：顶部总宽 + 底部各段（上下对齐的地柜+吊柜共享同一 X 段时自动去重，避免重复叠字）
  const addHDims = (
    cabs: Cabinet[], box: { x: number; y: number; w: number; h: number }, prefix: string
  ): void => {
    if (cabs.length === 0 || box.w <= 0) return;
    const sorted = [...cabs].sort((a, b) => xOf(a) - xOf(b));
    const x0 = xOf(sorted[0]!);
    // 顶部：总宽
    dims.add({
      p0: { x: box.x, y: box.y + box.h }, p1: { x: box.x + box.w, y: box.y + box.h },
      txt: `${Math.round(box.w / s)}`, orientation: 'h', side: 'top',
      chain: `${prefix}-total`, baseOffset: DIM_OFF, textOffset: 150,
    });
    // 底部：各段（按水平区间去重）
    const seenSegs = new Set<string>();
    for (const cab of sorted) {
      const rawX = xOf(cab) - x0;
      const segKey = `${Math.round(rawX)}:${Math.round(rawX + cab.params.width)}`;
      if (seenSegs.has(segKey)) continue;
      seenSegs.add(segKey);
      const cx = box.x + rawX * s;
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
    addHDims(cabinets, pbBox, 'pb');
    const maxD = Math.max(...cabinets.map((c) => c.params.depth));
    addVDims(pbBox, `${maxD}`, 'pb');
  }
  addHDims(cabinets, efBox, 'ef');
  addFrontPartitionAndDoorDims(dims, efBox, elevFrontRawBounds, cabinets, doorDimensions, s, frontCabinetX0, unfoldedX);
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
  // 俯视图标题固定在该视图自身尺寸链下方；不能把较低的立面底部尺寸算进来。
  const planTitleY = planY - 820;
  if (pbBox.w > 0) {
    prims.push(textPrim(pbBox.x + pbBox.w / 2, planTitleY, '俯视图', SZ_VIEW_TITLE, L_TEXT, 'c'));
  }
  const elevTitleY = Math.max(BOT_H + 180, minDimYBelow(elevY) - 400);
  prims.push(textPrim(efBox.x + efBox.w / 2, elevTitleY, '外观正面图', SZ_VIEW_TITLE, L_TEXT, 'c'));
  prims.push(textPrim(eiBox.x + eiBox.w / 2, elevTitleY, '内部结构图', SZ_VIEW_TITLE, L_TEXT, 'c'));

  prims.push(...dimPrims);

  // ── 红色工艺标注（短引线，标注放在目标附近）──
  // 每个标注的文字放在目标点上方 400 处，引线垂直向下不超过 800

  const hasGlass = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => {
      const m = (u.doors as any)?.material as string ?? '';
      return m.toLowerCase().includes('glass');
    }));
  // 灯带两个来源：层板上的灯槽（shelves.ledStrip）与柜底外挂灯条（params.underLight）。
  // 这里原来读的是 unit.ledStrip —— 字段其实在 u.shelves.ledStrip 上，走查了两年没红过，
  // 因为"灯带居中"这条标注从来没有被画出来过。
  const hasUnderLight = cabinets.some((cab) => cab.params.underLight === true);
  const hasLed = hasUnderLight || cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => (u.shelves?.ledStrip ?? 'none') !== 'none'));
  const hasDrawer = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => (u as any).drawers));
  const hasShelf = cabinets.some((cab) =>
    allUnits(cab.layout).some((u: any) => ((u as any).shelves ?? []).length > 0));
  const backPanelNote = [...new Set(cabinets
    .map((cabinet) => backPanelThicknessNote(cabinet, rules))
    .filter((note): note is string => note !== null))].join(' / ');

  // 引线目标：立面外观图/结构图内的对应位置（短引线，垂直为主）
  const efCX = efBox.x + efBox.w / 2;
  const eiCX = eiBox.x + eiBox.w / 2;
  const efMidY = efBox.y + efBox.h * 0.55;
  const efBotY = efBox.y + efBox.h * 0.25;
  const efTopInY = efBox.y + efBox.h * 0.85;

  // 短引线标注：文字在目标正上方 350 处，引线垂直，长度 350
  //
  // 红字之间也会互相压字：字高 17mm，正视图上沿那条带只放得下两三行，
  // 两条标注的目标点挨得近就叠在一起（实测「黑框灰玻」压在「灯带居中」上）。
  // 所以文字位置要占位：撞了就往上挪一行，引线跟着变长 —— 引线本身就是这么用的。
  const annotBoxes: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
  const annotFree = (b: { x0: number; x1: number; y0: number; y1: number }): boolean =>
    !annotBoxes.some((o) => !(b.x1 < o.x0 || b.x0 > o.x1 || b.y1 < o.y0 || b.y0 > o.y1));
  const shortAnnot = (px: number, py: number, text: string): void => {
    const tx = px;
    const halfW = estimateTextWidth(text, SZ_ANNOT) / 2 + 30;
    let ty = py + 350;
    for (let k = 0; k < 6; k++) {
      const box = { x0: tx - halfW, x1: tx + halfW, y0: ty - SZ_ANNOT * 0.8, y1: ty + SZ_ANNOT * 0.8 };
      if (annotFree(box)) { annotBoxes.push(box); break; }
      ty += SZ_ANNOT * 1.4;
    }
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
    // 0.1 倍高度不够：实测与「黑框灰玻」只差 22mm，两条红字挤成一行读不清
    shortAnnot(efCX, efTopInY - efBox.h * 0.22, hasUnderLight ? '柜底灯带' : '灯带居中');
  }
  if (hasDrawer) {
    shortAnnot(efCX + efBox.w * 0.2, efBotY, '托底抽');
  }
  if (hasShelf) {
    shortAnnot(eiCX, efMidY, '活动层板');
  }
  // ── 图框 ──
  drawFrame(prims, furnitureName, project, room.name, doorDimensions.schedule, backPanelNote);

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
    /**
     * ★ 各视图在图纸上的位置（世界坐标 bbox）。
     *
     *   用途：把「外观正面图」那一块**单独裁出来**给视觉模型看
     *   （三段式识别的第一步）。
     *
     *   ★ 为什么要有这个 ──
     *   整图是「俯视+正视+内部」拼版，模型容易把**同一只柜的多个视图**
     *   当成多个柜体（实测 kimi-k3 就把一只衣柜认成 C1+C2）。
     *   而单视图没有这个歧义。
     *
     *   坐标来自 placeScaled 的返回值 —— 与实际画出来的位置**同一份计算**，
     *   不会和图纸对不上。
     */
    views: {
      plan: pbBox.w > 0 ? { x: pbBox.x, y: pbBox.y, w: pbBox.w, h: pbBox.h } : null,
      front: { x: efBox.x, y: efBox.y, w: efBox.w, h: efBox.h },
      internal: { x: eiBox.x, y: eiBox.y, w: eiBox.w, h: eiBox.h },
    },
  };
}

function drawFrame(
  prims: Prim[],
  furnitureName: string,
  project: Project,
  roomName: string,
  doorSchedule: Array<{ label: string; value: string }> = [],
  backPanelNote = '',
): void {
  const W = SHEET_W, H = SHEET_H;
  prims.push(rectPrim(60, 60, W - 60, H - 60, L_BORDER, 2));
  prims.push(rectPrim(100, 100, W - 100, H - 100, L_BORDER, 1));

  // 装订线：只保留虚线，不在贴纸边缘排竖字；位于边框内侧，中心距纸边约 9mm。
  const bx = 300;
  prims.push(linePrim(bx, 200, bx, H - 200, L_BORDER, 0.8, true));

  // ── 右侧边栏（右边缘与内框对齐 W-100，不超出）──
  const sx = W - SIDE_W;
  const SIDE_R = W - 100;  // 侧边栏右边缘 = 内框线
  const sy = H - 100;
  // 侧边栏左侧竖线（与主区隔开），从顶部到底部客户栏
  prims.push(linePrim(sx, 100, sx, H - 100, L_BORDER, 1));
  const titleSize = furnitureName.length > 6 ? Math.max(190, Math.floor(2000 / furnitureName.length)) : SZ_TITLE;
  prims.push(textPrim(sx + (SIDE_R - sx) / 2, sy - 300, furnitureName, titleSize, L_TEXT, 'c'));
  prims.push(linePrim(sx, sy - 550, SIDE_R, sy - 550, L_BORDER, 1));

  let ty = sy - 700;
  const rowH = 260;  // 7.8mm 行距，避免多行字段粘连

  const drawRow = (label: string, value: string = '', layer = L_TEXT): void => {
    prims.push(textPrim(sx + 80, ty, label, SZ_TABLE, layer, 'l'));
    if (value) prims.push(textPrim(sx + 650, ty, value, SZ_TABLE, layer, 'l'));
    prims.push(linePrim(sx, ty - 100, SIDE_R, ty - 100, L_BORDER, 0.6));
    ty -= rowH;
  };

  // 分区标题：竖排小字在左侧（对标参考 PDF），内容行右移
  // 参考 PDF：柜体/移门/掩门/线条 竖排在分区左侧作标题
  const drawSection = (
    title: string,
    rows: Array<[string, string?]>,
    opts: { rowHeight?: number; fontSize?: number } = {},
  ): void => {
    const sectionRowH = opts.rowHeight ?? rowH;
    const sectionFont = opts.fontSize ?? SZ_TABLE;
    const n = title.length;
    const sectionH = rows.length * sectionRowH;
    /**
     * ── 竖排标题必须整段落在本分区内（2026-10-20 重叠事故修复）──
     *
     * 历史实现两处错：
     *   ① vSize 固定 150、与分区实际高度无关 —— 分区行数一多，标题只覆盖上半截，
     *      剩下的字掉到下一个分区（甚至掉到底部客户栏）造成压字；
     *   ② startY 用 ty + 40 - (n * vSize * 0.6) 这个魔数，不以分区底为界。
     *
     * 现在：
     *   · 字号按分区高度自适应（sectionH / n），夹在 [90, 150] 保持可读；
     *   · 起点 = 分区顶减半个字格，逐字向下，**保证不越出分区底**；
     *   · 分区太矮放不下全部标题字时**少画字**而不是溢出去压别的东西
     *     （宁可标题显示「门板」也不能压住下单/交货日期）。
     */
    const vX = sx + 250;
    const vSize = Math.max(90, Math.min(150, Math.floor(sectionH / Math.max(1, n))));
    const fits = Math.max(1, Math.floor(sectionH / vSize));
    const shownTitle = title.slice(0, fits);
    const startY = ty - Math.floor(vSize / 2);
    for (let i = 0; i < shownTitle.length; i++) {
      prims.push(textPrim(vX, startY - i * vSize, shownTitle[i]!, vSize, L_TEXT, 'c'));
    }
    // 分区左侧竖线（标题与内容分隔）
    const secTop = ty + 80;
    const secBot = ty - sectionH + 40;
    prims.push(linePrim(vX + 110, secTop, vX + 110, secBot, L_BORDER, 0.8));
    // 内容行：标签和值分列，给“同色带字□ 同色□”等长值留足空间。
    for (const [label, value] of rows) {
      prims.push(textPrim(vX + 320, ty, label, sectionFont, L_TEXT, 'l'));
      if (value) prims.push(textPrim(sx + 1150, ty, value, sectionFont, L_TEXT, 'l'));
      prims.push(linePrim(vX + 110, ty - sectionRowH * 0.38, SIDE_R, ty - sectionRowH * 0.38, L_BORDER, 0.6));
      ty -= sectionRowH;
    }
    /**
     * ── 竖排标题的纵向占位必须被"消化"掉（2026-10-20 第二处重叠）──
     *
     * 上面把标题字限制在分区内是对的，但分区结束后 ty 只减了内容行的高度，
     * 没有扣掉标题最后一字的**下半个字格**。后续 drawRow 的文字以 y 为中心、
     * 上下各占 size/2，于是"门板尺寸"的"寸"（底边 ty-30）会咬住紧随其后的
     * "下单日期"（顶边 ty+60）—— 实测交叠 30 单位（3mm）。
     *
     * 这里把 ty 压到「最后一字底边 - 半个字格 - 下一行半高 - 安全间距」之下，
     * 保证分区之后的任何文字都不会与竖排标题相交。空间不足时后续行自然被
     * 下面的余量判断放弃（宁可少一行，不能压字）。
     */
    if (shownTitle.length > 0) {
      const lastCharY = startY - (shownTitle.length - 1) * vSize;
      const titleFloor = lastCharY - vSize / 2 - SZ_TABLE / 2 - 40;
      ty = Math.min(ty, titleFloor);
    }
  };

  drawRow('房间', roomName);
  drawRow('项目', project.name);
  drawRow('设计师');
  drawRow('联系电话');
  drawRow('销售地址');
  drawRow('销售人员');
  drawRow('柜体工艺', '标准□  新工艺□');
  if (backPanelNote) drawRow('背板厚度', backPanelNote, L_ANNOT_RED);
  drawSection('柜体', [
    ['颜色'], ['材质'], ['规格', '25□ 18□ 9□ 5□'], ['封边', '同色带字□ 同色□'],
  ]);
  if (doorSchedule.length > 0) {
    // 掩门/移门的占位栏改为逐扇净尺寸表；每扇独立编号，不把相同尺寸折叠成总宽或数量。
    const available = Math.max(120, ty - BOT_H - 180);
    const scheduleRowH = Math.min(210, Math.max(90, Math.floor(available / doorSchedule.length)));
    const scheduleFont = Math.min(105, Math.max(58, Math.floor(scheduleRowH * 0.52)));
    drawSection('门板尺寸', doorSchedule.map((row) => [`${row.label} ${row.value}`]), {
      rowHeight: scheduleRowH,
      fontSize: scheduleFont,
    });
    if (ty - rowH * 2 >= BOT_H + 100) {
      drawRow('下单日期');
      drawRow('交货日期');
    }
  } else {
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
  }

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
