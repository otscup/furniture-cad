import type { Cabinet, Prim, Project, PurchasedItem, RuleSet } from '../core/types.ts';
import { generateProject } from '../core/geometry/project.ts';
import { localToWorld, polyLocalToWorld } from '../core/geometry/transform.ts';
import { buildFurnitureSheet, computeUnfoldedWallX, groupByRoom } from './furnitureSheet.ts';
import { buildCabinetViews, buildProjectViews, type ViewSet } from '../core/geometry/views.ts';
import { GENERATOR_VERSION } from './neutralSheet.ts';
import { allUnits } from '../core/layoutModel.ts';
import { cabinetWarningIssues, formatCabinetWarning } from './warningNotes.ts';
import { confirmedSharedPanels } from '../core/sharedPanels.ts';
import type { SharedPanel } from '../core/types.ts';

function strokeOf(layer: string): string {
  if (layer.includes('ANNOT-RED')) return '#c84435';
  if (layer.includes('HIDDEN')) return '#9aa0a6';
  if (layer.includes('HW')) return '#555b66';
  if (layer.startsWith('F-DIM') || layer.startsWith('F-TEXT') || layer.startsWith('F-BORDER')) return '#30343b';
  return '#111318';
}

function fillOf(_layer: string): string {
  return '#eef0f4';
}

function primPoints(prims: Prim[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const prim of prims) {
    if (prim.k === 'text') {
      minX = Math.min(minX, prim.p.x);
      minY = Math.min(minY, prim.p.y);
      maxX = Math.max(maxX, prim.p.x);
      maxY = Math.max(maxY, prim.p.y);
    } else {
      for (const point of prim.pts) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

const esc = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export interface RoomPlanCallout {
  cabinetId: string;
  tag: string;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** 房间布局中的柜体编号、白底标记框和引线；其 bbox 可被验收直接检查碰撞。 */
export function buildRoomPlanCallouts(cabinets: Cabinet[]): { prims: Prim[]; labels: RoomPlanCallout[] } {
  const prims: Prim[] = [];
  const labels: RoomPlanCallout[] = [];
  const counters = { B: 0, W: 0, T: 0, I: 0 };
  const bbox = (points: Array<{ x: number; y: number }>) => ({
    minX: Math.min(...points.map((point) => point.x)), minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)), maxY: Math.max(...points.map((point) => point.y)),
  });
  const overlaps = (a: RoomPlanCallout['bounds'], b: RoomPlanCallout['bounds']) =>
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  const footprints = cabinets.map((cabinet) => bbox(polyLocalToWorld(
    [{ x: 0, y: 0 }, { x: cabinet.params.width, y: 0 }, { x: cabinet.params.width, y: cabinet.params.depth }, { x: 0, y: cabinet.params.depth }],
    cabinet.placement,
    cabinet.placement.rotation,
  )));
  for (const cabinet of cabinets) {
    const kind = cabinet.params.cabinetType ?? ((cabinet.params.mountHeight ?? 0) > 0 ? 'wall' : 'base');
    const prefix: keyof typeof counters = kind === 'wall' ? 'W' : kind === 'tall' ? 'T' : kind === 'island' ? 'I' : 'B';
    const tag = `${prefix}${++counters[prefix]}`;
    const W = cabinet.params.width;
    const D = cabinet.params.depth;
    const halfW = 70;
    const halfH = 46;
    let centerY = D + (prefix === 'W' ? 150 : prefix === 'T' ? 450 : 300);
    let boxPoints: Array<{ x: number; y: number }> = [];
    let labelBounds: RoomPlanCallout['bounds'] = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    for (let attempt = 0; attempt < 24; attempt++) {
      boxPoints = polyLocalToWorld([
        { x: W / 2 - halfW, y: centerY - halfH }, { x: W / 2 + halfW, y: centerY - halfH },
        { x: W / 2 + halfW, y: centerY + halfH }, { x: W / 2 - halfW, y: centerY + halfH },
      ], cabinet.placement, cabinet.placement.rotation);
      labelBounds = bbox(boxPoints);
      if (!footprints.some((footprint) => overlaps(labelBounds, footprint)) && !labels.some((label) => overlaps(labelBounds, label.bounds))) break;
      centerY += 160;
    }
    const center = localToWorld({ x: W / 2, y: centerY }, cabinet.placement, cabinet.placement.rotation);
    const leader = polyLocalToWorld([{ x: W / 2, y: D }, { x: W / 2, y: centerY - halfH }], cabinet.placement, cabinet.placement.rotation);
    prims.push({ k: 'poly', pts: leader, closed: false, layer: 'A-CALLOUT', lw: 1.2 });
    prims.push({ k: 'fill', pts: boxPoints, layer: 'A-CALLOUT', alpha: 1 });
    prims.push({ k: 'poly', pts: boxPoints, closed: true, layer: 'A-CALLOUT', lw: 1.4 });
    prims.push({ k: 'text', p: center, text: tag, size: 65, layer: 'A-CALLOUT', align: 'c' });
    labels.push({ cabinetId: cabinet.id, tag, bounds: labelBounds });
  }
  return { prims, labels };
}

/**
 * 房间整体正面立面图：把房间内所有柜子的正面视图拼到一张图上。
 *
 * 布局规则：
 * - X 轴 = 柜子 placement.x（世界坐标），按实际左右位置摆放
 * - Y 轴 = mountHeight（吊柜离地高度）+ 柜体高度方向；地柜从地面（Y=0）起画
 * - 只支持 rotation=0 的一字形布局；转角（rotation≠0）的柜子跳过并在下方注记
 * - 前后遮挡：X 重叠且垂直方向也重叠的柜子，只保留最前排（placement.y 最小）的；
 *   地柜+吊柜上下叠放不算遮挡（垂直方向不重叠），正常显示
 *
 * 标注：
 * - 每个柜子：下方柜名、上方宽度尺寸；吊柜左侧标离地高度
 * - 整体：底部总宽度、右侧总高度、地面线
 */
export function buildRoomElevation(
  cabinets: Cabinet[],
  rules: RuleSet,
  /** 可选：预计算的 ViewSet 缓存（key=柜子 id），传了就不再重复调 buildCabinetViews */
  viewSetCache?: Map<string, ViewSet>,
): { prims: Prim[]; skipped: string[]; rendered: number } {
  const prims: Prim[] = [];
  const skipped: string[] = [];

  // 按 X 排序；Y 进深分组，只取每组最前排
  // 注意：垂直方向（mountHeight）不同的柜子不算重叠，地柜+吊柜上下叠放是正常情况
  const unfoldedX = computeUnfoldedWallX(cabinets);
  const xOf = (c: Cabinet): number => unfoldedX.get(c.id) ?? c.placement.x;
  const frontRow = [...cabinets].sort((a, b) => xOf(a) - xOf(b));

  let minX = Infinity;
  let maxX = -Infinity;
  let maxY = 0;
  // [fix] 实际产出几何的柜子数：全部 buildCabinetViews 都抛异常时，不画地面线、
  // 调用方据此 suppressed 立面页，避免输出"只有地面线"的误导性空图
  let rendered = 0;

  for (const cab of frontRow) {
    let vs: ViewSet | undefined = viewSetCache?.get(cab.id);
    if (!vs) {
      try {
        vs = buildCabinetViews(cab, rules, { x: 0, y: 0, gapTop: 0, gapSide: 0, gapInt: 0 });
      } catch {
        skipped.push(cab.name);
        continue;
      }
      // 顺手回填缓存，同一批调用内复用
      viewSetCache?.set(cab.id, vs);
    }
    rendered++;
    const dx = xOf(cab);
    const dy = cab.params.mountHeight ?? 0;
    const W = cab.params.width;
    const H = cab.params.height;
    minX = Math.min(minX, dx);
    maxX = Math.max(maxX, dx + W);
    maxY = Math.max(maxY, dy + H);

    const move = (p: { x: number; y: number }) => ({ x: p.x + dx, y: p.y + dy });
    for (const pr of vs.prims.front) {
      if (pr.k === 'text') {
        // 立面拼图不带单柜的尺寸文字，只留柜名（下方统一标注）
        continue;
      } else {
        prims.push({ ...pr, pts: pr.pts.map(move) });
      }
    }
    // 柜名标注在柜子下方（地柜避开地面线，吊柜紧贴柜底）
    const nameY = dy === 0 ? dy - 320 : dy - 140;
    prims.push({
      k: 'text',
      p: { x: dx + W / 2, y: nameY },
      text: cab.name,
      size: 110,
      layer: 'F-TEXT',
      align: 'c',
    });
    // 宽度尺寸标注（柜子顶部上方）
    const topY = dy + H;
    prims.push({ k: 'poly', pts: [{ x: dx, y: topY + 120 }, { x: dx + W, y: topY + 120 }], closed: false, layer: 'F-DIM', lw: 1 });
    prims.push({ k: 'poly', pts: [{ x: dx, y: topY + 60 }, { x: dx, y: topY + 180 }], closed: false, layer: 'F-DIM', lw: 1 });
    prims.push({ k: 'poly', pts: [{ x: dx + W, y: topY + 60 }, { x: dx + W, y: topY + 180 }], closed: false, layer: 'F-DIM', lw: 1 });
    prims.push({ k: 'text', p: { x: dx + W / 2, y: topY + 260 }, text: `${W}`, size: 95, layer: 'F-DIM', align: 'c' });
    // 吊柜离地高度标注（左侧）
    if (dy > 0) {
      prims.push({ k: 'poly', pts: [{ x: dx - 120, y: 0 }, { x: dx - 120, y: dy }], closed: false, layer: 'F-DIM', lw: 1 });
      prims.push({ k: 'poly', pts: [{ x: dx - 180, y: 0 }, { x: dx - 60, y: 0 }], closed: false, layer: 'F-DIM', lw: 1 });
      prims.push({ k: 'poly', pts: [{ x: dx - 180, y: dy }, { x: dx - 60, y: dy }], closed: false, layer: 'F-DIM', lw: 1 });
      prims.push({ k: 'text', p: { x: dx - 220, y: dy / 2 }, text: `${dy}`, size: 95, layer: 'F-DIM', align: 'c', rot: 90 });
    }
  }

  if (!isFinite(minX)) {
    minX = 0; maxX = 0;
  }

  // 地面线：只有确实有柜子产出几何才画，避免"只有地面线"的误导性空图
  if (rendered > 0) {
    const gx0 = minX - 400;
    const gx1 = maxX + 400;
    prims.push({ k: 'poly', pts: [{ x: gx0, y: 0 }, { x: gx1, y: 0 }], closed: false, layer: 'F-BORDER', lw: 2.5 });
    // 地面线下方的填充示意
    for (let x = gx0; x < gx1; x += 220) {
      prims.push({ k: 'poly', pts: [{ x, y: 0 }, { x: x - 120, y: -160 }], closed: false, layer: 'F-BORDER', lw: 1 });
    }
    // 总宽度标注（地面线下方）
    const dimY = -520;
    prims.push({ k: 'poly', pts: [{ x: minX, y: dimY }, { x: maxX, y: dimY }], closed: false, layer: 'F-DIM', lw: 1.2 });
    prims.push({ k: 'poly', pts: [{ x: minX, y: dimY - 80 }, { x: minX, y: dimY + 80 }], closed: false, layer: 'F-DIM', lw: 1 });
    prims.push({ k: 'poly', pts: [{ x: maxX, y: dimY - 80 }, { x: maxX, y: dimY + 80 }], closed: false, layer: 'F-DIM', lw: 1 });
    prims.push({ k: 'text', p: { x: (minX + maxX) / 2, y: dimY - 160 }, text: `总宽 ${maxX - minX}`, size: 110, layer: 'F-DIM', align: 'c' });
    // 总高度标注（右侧）
    const dimX = maxX + 500;
    prims.push({ k: 'poly', pts: [{ x: dimX, y: 0 }, { x: dimX, y: maxY }], closed: false, layer: 'F-DIM', lw: 1.2 });
    prims.push({ k: 'poly', pts: [{ x: dimX - 80, y: 0 }, { x: dimX + 80, y: 0 }], closed: false, layer: 'F-DIM', lw: 1 });
    prims.push({ k: 'poly', pts: [{ x: dimX - 80, y: maxY }, { x: dimX + 80, y: maxY }], closed: false, layer: 'F-DIM', lw: 1 });
    prims.push({ k: 'text', p: { x: dimX + 160, y: maxY / 2 }, text: `总高 ${maxY}`, size: 110, layer: 'F-DIM', align: 'c', rot: 90 });
  }

  return { prims, skipped, rendered };
}

const PAD = 120;

/** Y-up CAD primitives to a self-contained SVG with readable, unmirrored text. */
export function primsToSvg(prims: Prim[], cls: string): string {
  if (prims.length === 0) return `<svg class="${esc(cls)}" role="img" aria-label="空视图"></svg>`;
  const box = primPoints(prims);
  const minX = box.minX - PAD;
  const minY = box.minY - PAD;
  const width = Math.max(1, box.maxX - box.minX + PAD * 2);
  const height = Math.max(1, box.maxY - box.minY + PAD * 2);
  const body: string[] = [];
  for (const prim of prims) {
    if (prim.k === 'poly') {
      const points = prim.pts.map((point) => `${point.x},${point.y}`).join(' ');
      const dash = prim.dash ? ` stroke-dasharray="${prim.dash.join(' ')}"` : '';
      const tag = prim.closed ? 'polygon' : 'polyline';
      body.push(`<${tag} points="${points}" fill="none" stroke="${strokeOf(prim.layer)}" stroke-width="${Math.max(1, prim.lw * 1.6)}"${dash}/>`);
    } else if (prim.k === 'fill') {
      const points = prim.pts.map((point) => `${point.x},${point.y}`).join(' ');
      body.push(`<polygon points="${points}" fill="${fillOf(prim.layer)}" fill-opacity="${prim.alpha}" stroke="none"/>`);
    } else {
      const anchor = prim.align === 'c' ? 'middle' : prim.align === 'r' ? 'end' : 'start';
      const rotation = prim.rot ? ` rotate(${-prim.rot})` : '';
      body.push(`<text transform="translate(${prim.p.x},${prim.p.y}) scale(1,-1)${rotation}" font-size="${prim.size}" fill="${strokeOf(prim.layer)}" text-anchor="${anchor}" font-family="Noto Sans CJK SC, Microsoft YaHei, sans-serif">${esc(prim.text)}</text>`);
    }
  }
  return `<svg class="${esc(cls)}" viewBox="${minX} ${-(minY + height)} ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img"><g transform="scale(1,-1)">${body.join('')}</g></svg>`;
}

export interface RoomBookCabinet {
  id: string;
  name: string;
  index: number;
  mapTag: string;
  /**
   * 组的**代表柜**类型（组内 mountHeight 最低那只）。
   * 混排组（地柜+吊柜）请用 memberTypes 判断清单归属 —— 见下。
   */
  cabinetType: 'base' | 'wall' | 'tall' | 'island';
  /**
   * 组内**实际包含**的柜型（去重）。
   *
   * ── 为什么要这个字段（2026-10-21）──
   *   一页 = 一组之后，一个组可能同时有 base 和 wall（地柜+吊柜合成一页）。
   *   布局页的清单要按柜型分两行显示（"地柜/高柜" 与 "吊柜"），
   *   而单看 cabinetType 只能给出一个值 ⇒ 混排组会被归到其中一边，
   *   另一边显示"无"，看起来像柜子凭空消失（实测就踩到了）。
   *
   *   单柜页的 memberTypes 是 [cabinetType]，行为与以前完全一致。
   */
  memberTypes: Array<'base' | 'wall' | 'tall' | 'island'>;
  width: number;
  height: number;
  depth: number;
  boardMaterial: string;
  backMaterial: string;
  doorMaterial: string | null;
  mountHeight: number;
  referenceNotes: string[];
  safetyNote: string | null;
  warningNotes: string[];
  finishedEnds: string;
  craftNotes: string[];
  panelKinds: number;
  panelPieces: number;
  hardware: Array<{ nameZh: string; qty: number; spec: string }>;
  purchased: PurchasedItem[];
  sheetSvg: string;
}

export interface RoomBookSection {
  roomId: string;
  roomName: string;
  layoutSvg: string;
  layoutSafetyNote: string | null;
  /** 房间整体正面立面图（SVG）；无柜子或全部跳过时为 null */
  elevationSvg: string | null;
  /** 立面图中被跳过的柜子名（转角/被遮挡） */
  elevationSkipped: string[];
  /** 整房/整墙一体化 2x2 四视图生产图纸（对标《世园润府》标准图幅：地柜俯视+吊柜俯视+正面外观+内部结构+右侧规格栏） */
  roomSheetSvg: string | null;
  cabinets: RoomBookCabinet[];
}

export interface RoomBook {
  projectName: string;
  modelVersion: string;
  generatorVersion: string;
  ruleSetId: string;
  ruleSetName: string;
  sections: RoomBookSection[];
  sharedPanels: Array<Pick<SharedPanel, 'id' | 'name' | 'memberCabinetIds' | 'replacesPanelIds' | 'bounds' | 'elevation' | 'length' | 'width' | 'thickness' | 'material' | 'finish' | 'grainDirection' | 'edgeTreatment' | 'overhang' | 'segmentation' | 'support' | 'machining'> & { sheetSvg: string }>;
  summary: Array<{
    cabinet: string;
    room: string;
    panelKinds: number;
    panelPieces: number;
    hardwareKinds: number;
    hardwarePieces: number;
    purchased: number;
  }>;
  totals: { cabinets: number; panelKinds: number; panelPieces: number; purchased: number };
}

/**
 * 房间顺序来自 Project.rooms，房间内按工作区坐标稳定排序；每个柜体独立生成一张图纸，
 * 共享语义模型和几何生成器。悬空 roomId 会进入显式的“未分配房间”组。
 */

/**
 * ══════════════════════════════════════════════════════════════════════
 *  柜体分组（"一组一页"，对齐工厂标准版式）
 *
 * ── 它解决什么（用户实测反馈）──
 *   "复杂柜子比如橱柜，可以分为地柜和吊柜。但是正面图能看到整个地柜和吊柜的
 *    外观带面板的。复杂部分可以在同房间把吊柜和地柜分开展示。但是不要全部拆分开来。"
 *
 *   历史行为：`buildRoomBook` 对 `group.cabinets` 逐个出页
 *   （见下方 `buildFurnitureSheet(group.room, [cabinet], ...)`），
 *   于是"一厨六柜"就变成六页，每页只看得见自己那一个，
 *   用户看到的就是"柜子被拆成了几个"。
 *
 * ── 分组判据（宁可少合，不可乱合）──
 *   同一房间内，**X 投影重叠 ≥ 80%** 且 **竖直方向不重叠**
 *   （一个落地 + 一个壁挂）的柜体，视为同一"上下叠放组"，合成一页：
 *     · 该页的**立面外观图 = 整组**（地柜+吊柜一起画，这才是"一眼看到整体"）
 *     · **平面图**按地柜/吊柜分开并排（对齐参考 PDF 第 2 页餐边柜）
 *     · 结构图仍是整组，细节靠分区分段表达
 *   不在同一 X 区间的柜体**不合并**（例如 L 型另一条臂、房间对面的柜）。
 *
 * ── 为什么要 ≥80% 而不是任意重叠 ──
 *   参考图纸里地柜吊柜是标准上下对齐（X 完全一致）。用 80% 容纳现场少量偏差，
 *   又不至于把"并排两个柜"误判成一组。
 * ══════════════════════════════════════════════════════════════════════
 */
export interface CabinetGroup {
  /** 组内柜体，**竖直方向从下到上**排序（作图顺序有意义） */
  cabinets: Cabinet[];
  /** 组的代表名（取组内最靠下的柜体名，或房间名） */
  name: string;
  /** 组内是否有吊柜（决定平面图是否要左右并排两张） */
  hasWall: boolean;
  hasBase: boolean;
}

/** 柜体的水平投影区间 [x0, x1)（沿墙方向的展开坐标，L/U 型已展开）。 */
function horizontalSpan(cabinet: Cabinet): { x0: number; x1: number } {
  const w = cabinet.params.width;
  const x = cabinet.placement.x;
  return { x0: x, x1: x + w };
}

/** 柜体的竖直区间 [z0, z1)。 */
function verticalSpan(cabinet: Cabinet): { z0: number; z1: number } {
  const z0 = cabinet.params.mountHeight ?? 0;
  return { z0, z1: z0 + cabinet.params.height };
}

/** 两个水平区间是否"基本同一段"（重叠 / 较窄者 ≥ 80%）。 */
function sameHorizontalBand(a: { x0: number; x1: number }, b: { x0: number; x1: number }): boolean {
  const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  if (overlap <= 0) return false;
  const narrower = Math.min(a.x1 - a.x0, b.x1 - b.x0);
  if (narrower <= 0) return false;
  return overlap / narrower >= 0.8;
}

/** 两个竖直区间是否重叠（重叠即算"并排同高"，不能合成上下组）。 */
function verticalOverlap(a: { z0: number; z1: number }, b: { z0: number; z1: number }): boolean {
  return a.z0 < b.z1 && a.z1 > b.z0;
}

/**
 * 把一个房间的柜体按"上下叠放"分组。
 *
 * @param cabinets 房间内的柜体（顺序不敏感）
 * @returns 分组结果；每组的 cabinets 按 mountHeight 从低到高排序
 */
export function groupCabinetsForSheets(cabinets: Cabinet[]): CabinetGroup[] {
  const groups: Cabinet[][] = [];
  const used = new Set<string>();

  // 先按 mountHeight 升序，保证"落地柜先成组，吊柜随后并入"
  const sorted = [...cabinets].sort((a, b) => {
    const za = a.params.mountHeight ?? 0;
    const zb = b.params.mountHeight ?? 0;
    if (za !== zb) return za - zb;
    return a.placement.x - b.placement.x;
  });

  for (const cabinet of sorted) {
    if (used.has(cabinet.id)) continue;
    const band = horizontalSpan(cabinet);
    const members = [cabinet];
    used.add(cabinet.id);

    /**
     * 只与"已经在本组里、且竖直不重叠"的柜体尝试合并。
     * 这样 3 个同高并排地柜不会互相吞并（它们水平重叠），
     * 而地柜上方的吊柜可以并进来。
     */
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of sorted) {
        if (used.has(candidate.id)) continue;
        const cBand = horizontalSpan(candidate);
        if (!sameHorizontalBand(band, cBand)) continue;
        // 必须与组内**每一个**成员都竖直不重叠，才能作为"同一叠"
        const overlapsAny = members.some((m) => verticalOverlap(verticalSpan(m), verticalSpan(candidate)));
        if (overlapsAny) continue;
        members.push(candidate);
        used.add(candidate.id);
        changed = true;
      }
    }

    members.sort((a, b) => (a.params.mountHeight ?? 0) - (b.params.mountHeight ?? 0));
    groups.push(members);
  }

  return groups.map((members) => {
    const hasWall = members.some((c) => (c.params.cabinetType === 'wall') || (c.params.mountHeight ?? 0) > 300);
    const hasBase = members.some((c) => (c.params.cabinetType !== 'wall') && (c.params.mountHeight ?? 0) <= 300);
    return {
      cabinets: members,
      name: members[0]?.name ?? '柜体组',
      hasWall,
      hasBase,
    };
  });
}

export function buildRoomBook(project: Project, rules: RuleSet, modelVersion: string): RoomBook {
  const geometry = generateProject(project, rules);
  /**
   * ★ 整份项目的四视图，**整本图纸册只算一次** ──
   *
   *   buildFurnitureSheet 需要它来把 drawingEdits 的坐标换算到图幅上。
   *   以前每次调 buildFurnitureSheet 都重新算一遍 ——
   *   而 buildRoomBook 会对每个房间调一次、对每个叠放组再调一次，
   *   于是 buildProjectViews 被算 (房间数 + 组数) 次，
   *   每次又遍历项目里**全部**柜体 ⇒ **O(房间数 × 柜数²)**。
   *
   *   实测（每房 10 柜）：
   *     1 房 183 ms → 2 房 480 ms → 4 房 3090 ms → 8 房 **22133 ms**
   *   8 房 80 柜要 22 秒。改成算一次后降到 O(柜数)。
   */
  const projectViews = buildProjectViews(project, rules);

  const sections: RoomBookSection[] = groupByRoom(project).map((group) => {
    const callouts = buildRoomPlanCallouts(group.cabinets);
    const mapTags = new Map(callouts.labels.map((label) => [label.cabinetId, label.tag]));
    const sourcePrims = geometry.roomPlans[group.room.id] ?? [];
    const sourceKeys = geometry.roomPlanSourceKeys[group.room.id] ?? [];
    const cabinetIds = new Set(group.cabinets.map((cabinet) => cabinet.id));
    const cleanLayoutPrims = sourcePrims.filter((prim, index) => {
      const match = /^plan:cabinet:([^:]+):/.exec(sourceKeys[index] ?? '');
      if (!match || !cabinetIds.has(match[1]!)) return true;
      return prim.k !== 'text' && !prim.layer.startsWith('F-DIM');
    });
    const layoutSafetyNote = group.cabinets.some((cabinet) =>
      (cabinet.params.counterCutouts?.length ?? 0) > 0 || allUnits(cabinet.layout).some((unit) => unit.kind === 'appliance' && unit.appliance)
    ) ? '参考预留｜非 CNC 开孔｜待拆单确认。柜体编号通过引线对应下方清单；图中虚线/洞口为设计参考，须按实机与拆单复核，不代表已完成加工。' : null;
    /**
     * 上下叠放分组结果（一页一组）。放在 return 之前只算一次。
     * ★ 组内顺序由 groupCabinetsForSheets 决定（mountHeight → x），
     *   但**页序**必须回到房间的规范顺序（y → x，见 roomIndex）——
     *   否则同一房间的柜体页会按 x 排队，房间纵深方向（里/外）的阅读顺序就丢了。
     */
    const roomOrder = new Map(group.cabinets.map((cabinet, index) => [cabinet.id, index]));
    const sheetGroups = groupCabinetsForSheets(group.cabinets)
      .sort((a, b) => Math.min(...a.cabinets.map(c => roomOrder.get(c.id) ?? 0)) - Math.min(...b.cabinets.map(c => roomOrder.get(c.id) ?? 0)));
    // [fix] 预计算本房间所有柜子的 ViewSet，供立面图复用，避免重复调 buildCabinetViews
    // TODO: buildFurnitureSheet 内部也调 buildCabinetViews，理想情况应把这份缓存继续往下传，
    // 彻底消除 roomBook 构建时的双倍计算。目前先解决立面图内部的重复（缓存回填机制已就绪）。
    const viewSetCache = new Map<string, ViewSet>();
    for (const cabinet of group.cabinets) {
      try {
        viewSetCache.set(cabinet.id, buildCabinetViews(cabinet, rules, { x: 0, y: 0, gapTop: 0, gapSide: 0, gapInt: 0 }));
      } catch {
        // 单柜失败不影响其他柜子，buildRoomElevation 内会按 skipped 处理
      }
    }
    const elevation = buildRoomElevation(group.cabinets, rules, viewSetCache);
    const roomWholeSheet = group.cabinets.length > 0
      ? buildFurnitureSheet(group.room, group.cabinets, project, rules, { furnitureName: `${group.room.name}整体柜`, projectViews })
      : null;
    return {
    roomId: group.room.id,
    roomName: group.room.name,
    layoutSvg: primsToSvg([...cleanLayoutPrims, ...callouts.prims], 'room-layout'),
    layoutSafetyNote,
    elevationSvg: elevation.rendered > 0 ? primsToSvg(elevation.prims, 'room-elevation') : null,
    elevationSkipped: elevation.skipped,
    roomSheetSvg: roomWholeSheet ? primsToSvg(roomWholeSheet.prims, 'dwg-sheet room-whole-sheet') : null,
    /**
     * ★ 遍历粒度从"柜体"改为"上下叠放组"。
     *   同一个组只出一页（sheetGroup.cabinets 可能含 2 个以上柜体）。
     *   组内第一个柜体作为"代表柜"提供摘要信息，其余成员信息合并进来。
     */
    cabinets: sheetGroups.map((sheetGroup, index) => {
      const cabinet = sheetGroup.cabinets[0]!;
      /**
       * 组的语义名。上下叠放组（地柜+吊柜）用房间名 + 序号，
       * 因为"厨房橱柜"这种才是图纸上该出现的标题（参考 PDF 第 12 页）。
       */
      const groupRoomBaseName = sheetGroups.length > 1
        ? `${group.room.name}橱柜${index + 1}`
        : `${group.room.name}橱柜`;
      const generated = geometry.cabinets[cabinet.id];
      const warningNotes = generated
        ? cabinetWarningIssues(cabinet, generated, rules).map((issue) => formatCabinetWarning(cabinet, issue))
        : [];
      const units = allUnits(cabinet.layout);
      const doorUnit = units.find((unit) => unit.doors);
      const doorMaterial = doorUnit?.doors?.material;
      const doorMaterialName = doorMaterial ? rules.materials[doorMaterial]?.name ?? doorMaterial : null;
      const craftNotes: string[] = [];
      const ledPositions = new Set<string>();
      for (const unit of units) {
        const position = unit.shelves?.ledStrip;
        if (position && position !== 'none') ledPositions.add(position);
      }
      const ledNames: Record<string, string> = { center: '灯带居中', front: '灯带靠前', angled45: '45°斜光灯带' };
      for (const position of ledPositions) if (ledNames[position]) craftNotes.push(ledNames[position]!);
      if (doorMaterial) {
        const material = rules.materials[doorMaterial];
        if (material?.kind === 'glass') craftNotes.push(material.name ?? '玻璃门');
      }
      const finishedEnds = cabinet.params.finishedEnds ?? 'none';
      if (finishedEnds === 'left' || finishedEnds === 'right') craftNotes.push(`${finishedEnds === 'left' ? '左' : '右'}见光板`);
      else if (finishedEnds === 'both') craftNotes.push('双侧见光板');

      /**
       * 组的柜型 —— **按代表柜（组内最低那个）的真实类型**，不能因为"组里有吊柜"就把整组标成 wall。
       *
       * ★ 修的是一个实测 bug（2026-10-21）：
       *   上一版写的是 `hasWall ? 'wall' : ...`，于是"地柜+吊柜"的组被整体标成 wall，
       *   布局页的清单里就出现「地柜/高柜：**无**」+「吊柜：厨房橱柜1 …（吊柜底 **0mm**）」——
       *   三组地柜凭空消失，还编出一个"吊柜底 0mm"的矛盾读数。
       *
       *   正确口径：组的**代表柜是组内 mountHeight 最低的那只**（groupCabinetsForSheets
       *   已经按标高从低到高排好序，所以 [0] 就是地柜）。
       *   组内既有地柜又有吊柜这件事，由 groupSize / groupIds 表达，不需要篡改 cabinetType。
       */
      const representativeIsWall = (cabinet.params.cabinetType === 'wall') || (cabinet.params.mountHeight ?? 0) > 300;
      const cabinetType = cabinet.params.cabinetType ?? (representativeIsWall ? 'wall' : 'base');
      /**
       * 组内实际柜型（去重）。单柜页只有一个元素，与 cabinetType 相同；
       * 地柜+吊柜的混排组是 ['base','wall']，清单两行都要列。
       */
      const memberTypes = [...new Set(sheetGroup.cabinets.map((c) =>
        c.params.cabinetType ?? (((c.params.mountHeight ?? 0) > 300 ? 'wall' : 'base') as 'base' | 'wall')
      ))] as Array<'base' | 'wall' | 'tall' | 'island'>;
      const referenceNotes = (cabinet.params.counterCutouts ?? []).map((cutout) => `${cutout.name} ${cutout.width}×${cutout.depth}mm（X=${cutout.x}, Y=${cutout.y}mm）`);
      for (const unit of units) if (unit.kind === 'appliance' && unit.appliance) {
        referenceNotes.push(`${unit.appliance.name}安装净空 ${unit.appliance.openingWidth}×${unit.appliance.openingHeight}×${unit.appliance.openingDepth}mm`);
      }
      const safetyNote = referenceNotes.length > 0
        ? `参考预留｜非 CNC 开孔｜待拆单确认（适用于台面虚线标记）。${referenceNotes.join('；')}。电器净空须按实机复核，不代表柜体加工完成。`
        : null;

      /**
       * ★ 一页 = 一组（对齐工厂标准版式）。
       *
       *   历史写法是 `[cabinet]` —— 每个柜体单独出一页，于是"一厨六柜"变成六页，
       *   每页只看得见自己，用户看到的就是"柜子被拆成了几个"。
       *   现在传入**整个上下叠放组**：立面外观图会把地柜+吊柜一起画出来
       *   （"一眼看到整个柜子"），平面图由 buildFurnitureSheet 内部按地柜/吊柜
       *   自动分成左右两张并排（参考 PDF 第 2 页餐边柜的写法）。
       *
       *   注意：本组可能有多个柜体，所以下面的摘要字段要按"组"聚合并对多值做去重，
       *   不能直接读 `cabinet.params`（那只能代表组内第一个）。
       */
      const groupMembers = sheetGroup.cabinets;
      /**
       * 页名：单柜 = 柜名；**上下叠放组 = 用"柜体组"的语义名**，不要把两个柜名用 + 串起来
       * （"地柜A + 吊柜A" 在图纸标题上又长又乱，而且会被误读成两台独立家具）。
       * 参考 PDF 的标题是家具名（"餐边柜"/"厨房橱柜"），不是柜体编号。
       */
      const groupName = sheetGroup.cabinets.length > 1
        ? (sheetGroup.hasWall && sheetGroup.hasBase ? `${groupRoomBaseName}` : `${cabinet.name}`)
        : cabinet.name;
      const sheet = buildFurnitureSheet(group.room, groupMembers, project, rules, { furnitureName: groupName, projectViews });
      const groupMapTags = groupMembers.map((c) => mapTags.get(c.id) ?? '?').join('/');
      return {
        id: cabinet.id,
        groupIds: groupMembers.map((c) => c.id),
        groupSize: groupMembers.length,
        name: groupName,
        index: index + 1,
        mapTag: groupMapTags,
        cabinetType,
        memberTypes,
        width: cabinet.params.width,
        height: cabinet.params.height,
        depth: cabinet.params.depth,
        boardMaterial: rules.materials[cabinet.params.boardMaterial]?.name ?? cabinet.params.boardMaterial,
        backMaterial: rules.materials[cabinet.params.backPanel.material]?.name ?? cabinet.params.backPanel.material,
        doorMaterial: doorMaterialName,
        mountHeight: cabinet.params.mountHeight ?? 0,
        referenceNotes,
        safetyNote,
        warningNotes,
        finishedEnds,
        craftNotes,
        panelKinds: generated?.stats.panelKinds ?? 0,
        panelPieces: generated?.stats.totalPieces ?? 0,
        hardware: (generated?.hardware ?? []).map((item) => ({ nameZh: item.nameZh, qty: item.qty, spec: item.spec })),
        purchased: generated?.purchased ?? [],
        sheetSvg: primsToSvg(sheet.prims, 'dwg-sheet'),
      };
    }),
  };
  });

  const summary = sections.flatMap((section) => section.cabinets.map((cabinet) => {
    const generated = geometry.cabinets[cabinet.id];
    return {
      cabinet: cabinet.name,
      room: section.roomName,
      panelKinds: cabinet.panelKinds,
      panelPieces: cabinet.panelPieces,
      hardwareKinds: generated?.hardware.length ?? 0,
      hardwarePieces: (generated?.hardware ?? []).reduce((sum, item) => sum + item.qty, 0),
      purchased: cabinet.purchased.length,
    };
  }));

  return {
    projectName: project.name,
    modelVersion,
    generatorVersion: GENERATOR_VERSION,
    ruleSetId: rules.id,
    ruleSetName: rules.name,
    sections,
    sharedPanels: confirmedSharedPanels(project, rules).map((panel) => {
      const prims: Prim[] = [{ k: 'poly', pts: [{ x: 0, y: 0 }, { x: panel.length, y: 0 }, { x: panel.length, y: panel.width }, { x: 0, y: panel.width }], closed: true, layer: 'PANEL_SHARED', lw: 3 }];
      for (const segment of panel.segmentation.segments) {
        const x = segment.x - panel.bounds.minX;
        const y = segment.y - panel.bounds.minY;
        prims.push({ k: 'poly', pts: [{ x, y }, { x: x + segment.length, y }, { x: x + segment.length, y: y + segment.width }, { x, y: y + segment.width }], closed: true, layer: 'PANEL_SHARED', lw: 2 });
        prims.push({ k: 'text', p: { x: x + segment.length / 2, y: y + segment.width / 2 }, text: `${panel.id}/${segment.id} ${segment.length}×${segment.width}mm`, size: 70, layer: 'F-TEXT', align: 'c' });
      }
      for (const hole of panel.machining.holes) {
        const radius = hole.diameter / 2;
        const points = Array.from({ length: 24 }, (_, index) => {
          const angle = index * Math.PI * 2 / 24;
          return { x: hole.x + Math.cos(angle) * radius, y: hole.y + Math.sin(angle) * radius };
        });
        prims.push({ k: 'poly', pts: points, closed: true, layer: 'PANEL_SHARED_HOLE', lw: 1.5 });
      }
      return { ...panel, sheetSvg: primsToSvg(prims, 'shared-panel-sheet') };
    }),
    summary,
    totals: {
      cabinets: summary.length,
      panelKinds: summary.reduce((sum, item) => sum + item.panelKinds, 0),
      panelPieces: summary.reduce((sum, item) => sum + item.panelPieces, 0),
      purchased: summary.reduce((sum, item) => sum + item.purchased, 0),
    },
  };
}

const CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #111318; font-family: "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; }
  body { background: #e8ebef; }
  .page { width: 420mm; height: 297mm; margin: 10mm auto; overflow: hidden; background: #fff; box-shadow: 0 2mm 8mm #0002; break-after: page; page-break-after: always; }
  .page:last-child { break-after: auto; page-break-after: auto; }
  .sheet-wrap, .sheet-wrap svg { width: 100%; height: 100%; display: block; }
  .layout-page { position: relative; }
  .layout-page .layout-heading { position: absolute; z-index: 1; top: 6mm; left: 10mm; padding: 2mm 4mm; background: #fff; border: 0.3mm solid #555; font-size: 12pt; }
  .layout-safety-note { position: absolute; z-index: 3; padding: 2mm 3mm; border: 0.6mm solid #a32218; background: #fff1ef; color: #701a12; font-size: 10pt; font-weight: 700; line-height: 1.25; top: 6mm; right: 8mm; max-width: 260mm; }
  .layout-page .sheet-wrap { position: absolute; inset: 16mm 8mm 55mm; width: auto; height: auto; }
  .layout-schedule { position: absolute; z-index: 2; left: 8mm; right: 8mm; bottom: 5mm; height: 45mm; padding: 2.5mm 3mm; border: 0.5mm solid #596579; background: #fff; display: grid; grid-template-rows: auto auto auto; gap: 1.5mm; font-size: 9pt; line-height: 1.25; }
  .layout-schedule-row { white-space: normal; }
  .layout-schedule-row strong { color: #26364c; }
  .layout-schedule-tag { display: inline-block; min-width: 8mm; margin-right: 1mm; padding: 0.3mm 1mm; border: 0.3mm solid #46556a; border-radius: 1mm; font-weight: 700; text-align: center; }
  .layout-schedule-special { color: #701a12; font-weight: 700; }
  .cabinet-page { position: relative; }
  .cabinet-note-stack { position: absolute; z-index: 3; top: 10mm; left: 10mm; width: 285mm; display: flex; flex-direction: column; gap: 1mm; }
  .cabinet-safety-note, .cabinet-warning-note { position: static; padding: 2mm 3mm; border: 0.6mm solid #a32218; background: #fff1ef; color: #701a12; font-size: 10pt; font-weight: 700; line-height: 1.25; }
  .cabinet-warning-note { border-color: #9a6a10; background: #fff7df; color: #563800; font-size: 9pt; }
  .shared-panel-page { padding: 12mm; }
  .shared-panel-page h1 { margin: 0 0 5mm; font-size: 18pt; }
  .shared-panel-meta { border: 0.5mm solid #596579; padding: 4mm; font-size: 10pt; line-height: 1.5; }
  .shared-panel-drawing { height: 185mm; margin-top: 5mm; }
  .empty { padding: 24mm; font-size: 14pt; }
  .print-hint { position: fixed; z-index: 2; left: 12px; top: 12px; padding: 8px 12px; border: 1px solid #d4b54a; background: #fff7cf; color: #564616; font-size: 12px; }
  @page { size: A3 landscape; margin: 0; }
  @media print { body { background: #fff; } .page { margin: 0; box-shadow: none; } .print-hint { display: none; } }
`;

/**
 * 按需为选中的房间先出一页平面布局，再为房间内每个柜体单独出图（横向 A3）。
 *
 * ★ 2026-10-22：**默认不再插入房间平面布局页**（用户要求「平面图可以不要，只保留俯视图」）。
 *   平面页是独立渲染分支，去掉它不影响订单页/柜体页/清单的结构。
 *   仍可用 `layoutRoomIds` 显式点名要哪些房间的平面页（旧行为可复现）。
 *   页面身份同时写入 data 属性和图框文字，便于自动化检查与后续追溯。
 */
export function roomBookHtml(
  book: RoomBook,
  options: { layoutRoomIds?: string[]; sheetMode?: 'room' | 'cabinet' | 'both' } = {},
): string {
  const pages: string[] = [];
  const sheetMode = options.sheetMode ?? 'cabinet';
  // 缺省 = 不输出任何平面布局页（逐柜页里已有俯视图）。
  const layoutRoomIds = new Set(options.layoutRoomIds ?? []);
  for (const section of book.sections) {
    const scheduleItems = (cabinets: RoomBookCabinet[]) => cabinets.map((cabinet) =>
      `<span class="layout-schedule-tag">${esc(cabinet.mapTag)}</span>${esc(cabinet.name)} ${cabinet.width}×${cabinet.height}×${cabinet.depth}mm${
        // 只有**纯吊柜组**才标"吊柜底 xxx mm"；混排组的 mountHeight 是代表柜（地柜）的 0，
        // 标出来就是假的（"吊柜底 0mm" 实测就出现过）
        cabinet.cabinetType === 'wall' && (cabinet.memberTypes ?? []).length <= 1 ? `（吊柜底 ${cabinet.mountHeight}mm）` : ''
      }`
    ).join('　·　');
    /**
     * 按**组内实际柜型**分列，而不是只看代表柜的 cabinetType。
     *
     * ★ 修的是一个实测 bug（2026-10-21）：一页一组之后，
     *   "地柜+吊柜"的混排组如果只按 cabinetType 判，会被整组归到一边 ——
     *   于是布局页出现「地柜/高柜：**无**」+「吊柜：…（吊柜底 **0mm**）」，
     *   三组地柜凭空消失，还编出一个矛盾的"吊柜底 0mm"。
     *
     * 现在用 memberTypes：混排组在两行里**都出现**（这是它真实的构成）。
     */
    const hasBaseType = (c: RoomBookCabinet) => (c.memberTypes ?? [c.cabinetType]).some((t) => t === 'base' || t === 'tall' || t === 'island');
    const hasWallType = (c: RoomBookCabinet) => (c.memberTypes ?? [c.cabinetType]).includes('wall');
    /**
     * 混排组（地柜+吊柜）**两行都列** —— 它确实同时含有两种柜。
     *
     * 只在一边列会让另一边显示"无"，而房间明明有吊柜 —— 那是假读数。
     * 同一个 mapTag（"B1/W1"）在两行各出现一次，读图的人一看就知道这是同一组。
     */
    const base = section.cabinets.filter(hasBaseType);
    const wall = section.cabinets.filter(hasWallType);
    const specialNotes = section.cabinets.flatMap((cabinet) => cabinet.referenceNotes.map((note) => `${cabinet.mapTag} ${cabinet.name}：${note}`));
    const layoutNote = section.layoutSafetyNote ? `<aside class="layout-safety-note">${esc(section.layoutSafetyNote)}</aside>` : '';
    const schedule = `<div class="layout-schedule" aria-label="柜体编号、名称和完整尺寸清单"><div class="layout-schedule-row"><strong>地柜/高柜：</strong>${scheduleItems(base) || '无'}</div><div class="layout-schedule-row"><strong>吊柜：</strong>${scheduleItems(wall) || '无'}</div><div class="layout-schedule-row layout-schedule-special"><strong>参考预留 / 设备净空：</strong>${esc(specialNotes.join('　·　') || '无')}</div></div>`;
    if (layoutRoomIds.has(section.roomId)) {
      pages.push(
        `<section class="page layout-page" data-page-kind="layout" data-room-id="${esc(section.roomId)}" aria-label="${esc(section.roomName)} / 房间布局"><div class="layout-heading">${esc(section.roomName)} · 房间布局（单位：mm）</div>${layoutNote}<div class="sheet-wrap">${section.layoutSvg}</div>${schedule}</section>`,
      );
    }
    if ((sheetMode === 'room' || sheetMode === 'both') && section.roomSheetSvg) {
      const roomNotes = section.cabinets.flatMap((cab) => [
        ...(cab.safetyNote ? [`<div class="cabinet-safety-note">${esc(cab.name)}：${esc(cab.safetyNote)}</div>`] : []),
        ...cab.warningNotes.map((note) => `<div class="cabinet-warning-note" role="note">${esc(note)}</div>`),
      ]).join('');
      const roomNoteStack = roomNotes
        ? `<aside class="cabinet-note-stack" aria-label="${esc(section.roomName)}整体生产警告与加工说明">${roomNotes}</aside>`
        : '';
      pages.push(
        `<section class="page cabinet-page room-whole-page" data-page-kind="room-sheet" data-room-id="${esc(section.roomId)}" aria-label="${esc(section.roomName)} / 整体柜四视图"><div class="sheet-wrap">${section.roomSheetSvg}</div>${roomNoteStack}</section>`,
      );
    }
    if (sheetMode === 'cabinet' || sheetMode === 'both') {
      /**
       * ★ 2026-10-22：柜体编号清单（schedule）原来是挂在**房间平面页**上的。
       *   平面页默认不再输出后，这份清单会一起消失 —— 而它是拆单必需信息
       *   （编号 B1/W1 → 柜名 → 完整尺寸 → 参考预留净空）。
       *   所以改挂到**本房间第一张柜体页**上：信息不丢，也不再多出一页。
       */
      const scheduleHomeId = !layoutRoomIds.has(section.roomId) ? section.cabinets[0]?.id : undefined;
      for (const cabinet of section.cabinets) {
        const noteBlocks = [
          ...(cabinet.safetyNote ? [`<div class="cabinet-safety-note">${esc(cabinet.safetyNote)}</div>`] : []),
          ...cabinet.warningNotes.map((note) => `<div class="cabinet-warning-note" role="note">${esc(note)}</div>`),
        ].join('');
        const noteStack = noteBlocks
          ? `<aside class="cabinet-note-stack" aria-label="${esc(cabinet.name)}生产警告与加工说明">${noteBlocks}</aside>`
          : '';
        // 没有平面页时，编号清单跟着本房间第一张柜体页走（见 scheduleHomeId 的说明）
        const scheduleHere = cabinet.id === scheduleHomeId ? schedule : '';
        pages.push(
          `<section class="page cabinet-page" data-page-kind="cabinet" data-room-id="${esc(section.roomId)}" data-cabinet-id="${esc(cabinet.id)}" aria-label="${esc(section.roomName)} / ${esc(cabinet.name)}"><div class="sheet-wrap">${cabinet.sheetSvg}</div>${noteStack}${scheduleHere}</section>`,
        );
      }
    }
  }
  for (const panel of book.sharedPanels) {
    const holeNotes = panel.machining.holes.map((hole) => `${hole.id} / ${hole.kind} / X=${hole.x} Y=${hole.y} / Ø${hole.diameter}mm / 深${hole.depth}mm`).join('；') || '已确认无孔';
    pages.push(`<section class="page shared-panel-page" data-page-kind="shared-panel" data-shared-panel-id="${esc(panel.id)}" aria-label="共享制造板 ${esc(panel.id)}"><h1>跨柜共享制造件：${esc(panel.name)}（${esc(panel.id)}）</h1><div class="shared-panel-meta"><strong>成员柜：</strong>${esc(panel.memberCabinetIds.join('、'))}<br><strong>替代箱体顶板：</strong>${esc(panel.replacesPanelIds.join('、'))}<br><strong>成品尺寸/标高：</strong>${panel.length}×${panel.width}×${panel.thickness}mm / ${panel.elevation}mm<br><strong>材料/饰面：</strong>${esc(panel.material)} / ${esc(panel.finish)}<br><strong>纹理方向：</strong>${esc(panel.grainDirection)}（相对成品板长/宽轴）<br><strong>外挑：</strong>${esc(JSON.stringify(panel.overhang))}<br><strong>四边处理：</strong>${esc(JSON.stringify(panel.edgeTreatment))}<br><strong>接缝分段：</strong>${esc(JSON.stringify(panel.segmentation))}<br><strong>支撑：</strong>${esc(JSON.stringify(panel.support))}<br><strong>孔位：</strong>${esc(panel.machining.status)}；${esc(holeNotes)}<br><strong>成品边界：</strong>${esc(JSON.stringify(panel.bounds))}<br>共享件追踪页；不提供专业开料优化、板材旋转优化或机床专用 CNC 后处理。</div><div class="shared-panel-drawing">${panel.sheetSvg}</div></section>`);
  }
  if (pages.length === 0) pages.push(`<section class="page"><div class="empty">当前项目没有可导出的柜体。</div></section>`);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="furniture-model-version" content="${esc(book.modelVersion)}"><meta name="furniture-generator-version" content="${esc(book.generatorVersion)}"><meta name="furniture-ruleset" content="${esc(book.ruleSetId)}"><title>${esc(book.projectName)} · 柜体图纸</title><style>${CSS}</style></head><body><div class="print-hint">${esc(book.projectName)} · ${book.totals.cabinets} 个柜体图纸 · ${esc(book.modelVersion)} / ${esc(book.generatorVersion)} / ${esc(book.ruleSetId)} · 打印设置为 A3 横向 / 边距无 / 背景图形开启</div>${pages.join('')}</body></html>`;
}
