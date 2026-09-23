import type { BBox, Cabinet, HardwareItem, Prim, Project, RuleSet, Vec2 } from '../types.ts';
import { bboxOf } from './transform.ts';
import { LabelPlacer, estimateTextWidth, primVisualExtent } from './labels.ts';
import {
  EXPLODE_LANE_STEP,
  EXPLODE_TIER_BASE,
  buildAssembly,
  buildProjectAssembly,
  type Assembly,
  type AssemblyCheck,
  type Box3,
  type ExplodeDir,
  type PartInstance,
} from './assembly.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  分解图（爆炸图）—— 供生产使用的第五张图
 *
 *  ── 为什么用轴测投影而不是再加一张正投影 ──
 *    正投影四视图已经完整表达了结构与尺寸。分解图要回答的是**另一个问题**：
 *    "这些板是怎么叠在一起、拆开之后各是哪一块"。这个问题需要第三个方向的
 *    可见性 —— 只有轴测投影能在同一张图里同时看到顶面 / 前面 / 侧面，
 *    让人一眼读出空间关系。所以这里用等轴测（30°），而不是再加一个投影方向。
 *
 *  ── 三面可见的判据 ──
 *    投影 u = (X − Y)·cos30°，v = Z − (X + Y)·sin30°
 *      → +X 轴投到"右下"，+Y 轴投到"左下"，+Z 轴投到"正上"
 *    等价于视点在 (+X, +Y, +Z) 卦限，因此恒能看到
 *      z = z1 的顶面、y = y1 的前面、x = x1 的右侧面
 *    只画这三面：不需要任何隐藏线算法，也不可能画到背面去。
 *
 *  ── 与四视图、开料清单的关系（本文件最重要的约束）──
 *    · 每一块的**三维位置**来自 assembly.ts，而 assembly.ts 的位置又全部由与
 *      生成器同一份 layout 派生量算出 —— 不存在第二套尺寸计算。
 *    · 每一块的**裁切尺寸**逐字取自开料清单，明细栏与清单一一对应。
 *    · 件号（明细栏序号）＝ 清单里的板件顺序；图上气泡里写的就是这个号。
 *
 *  ── 位移量的性质 ──
 *    tier / lane 决定的爆炸距离是**图面表达**，与真实装配顺序、拆卸行程无关。
 *    这句话必须在图上与假设清单里都写出来，否则一定有人拿它当工艺参数。
 * ══════════════════════════════════════════════════════════════════════
 */

// ── 图层（与 viewport/layers.ts 一一对应）──
const L_DIM = 'F-DIM';
const L_TEXT = 'F-TEXT';
const L_EXPLODE = 'F-EXPLODE';
const L_EXPLODE_BG = 'F-EXPLODE-BG';
const L_HW = 'F-CAB-HW';

const layerOfThickness = (th: number): string => `PANEL_${th}`;

// ── 等轴测投影 ──
const ISO_C = Math.cos(Math.PI / 6);
const ISO_S = Math.sin(Math.PI / 6);

/** 柜体三维 → 图纸二维（+v 向上，与四视图的坐标习惯一致） */
function iso(x: number, y: number, z: number): Vec2 {
  return { x: (x - y) * ISO_C, y: z - (x + y) * ISO_S };
}

/** 爆炸位移量（mm）—— 分层基准 + 层内错开 */
function explodeDist(tier: number, lane: number): number {
  return EXPLODE_TIER_BASE[Math.min(tier, EXPLODE_TIER_BASE.length - 1)] + lane * EXPLODE_LANE_STEP;
}

function offsetBox(b: Box3, dir: ExplodeDir, dist: number): Box3 {
  const d = dist * dir.sign;
  if (dir.axis === 'x') return { x0: b.x0 + d, x1: b.x1 + d, y0: b.y0, y1: b.y1, z0: b.z0, z1: b.z1 };
  if (dir.axis === 'y') return { x0: b.x0, x1: b.x1, y0: b.y0 + d, y1: b.y1 + d, z0: b.z0, z1: b.z1 };
  return { x0: b.x0, x1: b.x1, y0: b.y0, y1: b.y1, z0: b.z0 + d, z1: b.z1 + d };
}

function cornersOf(b: Box3): Vec2[] {
  const out: Vec2[] = [];
  for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) out.push(iso(x, y, z));
  return out;
}

function centroid(pts: Vec2[]): Vec2 {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/** 圆（用正 12 边形近似 —— 图元层没有 arc，也不该为它单独加一种图元） */
function circlePts(c: Vec2, r: number, n = 12): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
  }
  return out;
}

/**
 * 按估算宽度折行。中文没有词边界，所以按"字"贪心累加即可。
 * 为什么必须折行：假设清单里最长的一句 200 多个字，不折行会拉到两万多毫米宽，
 * 整张图幅的包围盒会被这一句话撑爆，"缩放到图幅"之后什么都看不清。
 */
function wrapByWidth(s: string, size: number, maxW: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of s) {
    if (cur && estimateTextWidth(cur + ch, size) > maxW) {
      out.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out.length > 0 ? out : [''];
}

// ── 版式常量 ──
const LEGEND_COLS = [
  { label: '件号', w: 440, align: 'c' as const },
  { label: '名称', w: 1180, align: 'l' as const },
  { label: '裁切尺寸 长×宽×厚 (mm)', w: 1500, align: 'l' as const },
  { label: '数量', w: 380, align: 'c' as const },
  { label: '材料', w: 1160, align: 'l' as const },
];
const HW_COLS = [
  { label: '名称', w: 900, align: 'l' as const },
  { label: '规格', w: 2200, align: 'l' as const },
  { label: '数量', w: 380, align: 'c' as const },
];
const LEGEND_W = LEGEND_COLS.reduce((a, c) => a + c.w, 0);
const LEGEND_ROW = 250;
const LEGEND_HEAD = 340;
const LEGEND_GAP = 1400;
const BLOCK_PAD = 620;
const TITLE_H = 760;
const ASSUME_ROW = 250;
const BUBBLE_MARGIN = 120;

export interface ExplodeViewSet {
  cabinetId: string;
  cabinetName: string;
  prims: Prim[];
  bbox: BBox | null;
  origin: Vec2;
  /** 该图幅占用的宽 / 高（用于并排与"缩放到图幅"） */
  w: number;
  h: number;
  dims: { W: number; H: number; D: number };
  legend: Assembly['legend'];
  hardware: HardwareItem[];
  /** 图上真正画出来的件号（== 明细栏行号）。验收拿它和开料清单逐项对 */
  drawnNos: number[];
  /** 摆不下的件号气泡（正常应为空） */
  unfitted: string[];
  /** 每个件号气泡的落点（图纸坐标）—— 验收用来说"气泡确实落在图内、且没压住别人" */
  bubbles: Array<{ no: number; at: Vec2; r: number; moved: boolean }>;
  /**
   * 每一件实例在图纸上的落点（含爆炸位移与轴测投影）。
   *
   * 为什么要把这个暴露出来，而不是留在函数内部：
   *   "爆炸位移是否真的把件分开了""件号与件是否一一对应"这类断言，
   *   只有对着**图上真实画出来的那一个件**才成立。若验收脚本自己再算一遍
   *   位移量，就等于在测"另一份实现"，测不出 offsetBox 写错方向这种事故。
   */
  drawn: Array<{
    no: number;
    panelId: string;
    seq: number;
    nameZh: string;
    tier: number;
    lane: number;
    /** 爆炸位移量（mm，恒为正） */
    dist: number;
    axis: 'x' | 'y' | 'z';
    sign: 1 | -1;
    center: Vec2;
    corners: Vec2[];
  }>;
  check: AssemblyCheck;
  assumptions: string[];
}

export interface ExplodeOpts {
  /** 图幅原点（多柜并排时由调用方平移） */
  x?: number;
  y?: number;
}

/**
 * 单个柜体 → 分解图图幅。纯函数。
 *
 * 三个阶段，顺序不能颠倒：
 *   ① 在等轴测坐标系里把**几何**摆出来（此时还不知道图幅多大）
 *   ② 量出几何包围盒，才敢算版式（明细栏行数决定高度、几何宽决定栏位起点）
 *   ③ 统一平移到最终位置，再画明细栏 / 标题 / 假设清单
 * 先画图例再摆几何的写法一定会在换柜型时错位 —— 图例宽是常量，几何宽不是。
 */
export function buildCabinetExplode(cab: Cabinet, rules: RuleSet, opts: ExplodeOpts = {}): ExplodeViewSet {
  const as = buildAssembly(cab, rules);
  const geo: Prim[] = [];
  const layouts: Array<{ part: PartInstance; corners: Vec2[]; center: Vec2; dist: number }> = [];

  // ── ① 几何（等轴测局部坐标）──
  for (const part of as.parts) {
    const dist = explodeDist(part.tier, part.lane);
    const box = offsetBox(part.box, part.dir, dist);
    const corners = cornersOf(box);
    layouts.push({ part, corners, center: centroid(corners), dist });

    /**
     * 只画三个可见面。用**同一个板厚图层**、不同 alpha 表达明暗：
     * 这样"关掉 PANEL_18 图层"仍然等于"关掉全部 18mm 板件"，
     * 不会出现"线没了颜色块还在"这种半死不活的状态。
     */
    const L = layerOfThickness(part.thickness);
    const q = (pts: Array<[number, number, number]>): Vec2[] => pts.map(([x, y, z]) => iso(x, y, z));
    const top: Array<[number, number, number]> = [[box.x0, box.y0, box.z1], [box.x1, box.y0, box.z1], [box.x1, box.y1, box.z1], [box.x0, box.y1, box.z1]];
    const front: Array<[number, number, number]> = [[box.x0, box.y1, box.z0], [box.x1, box.y1, box.z0], [box.x1, box.y1, box.z1], [box.x0, box.y1, box.z1]];
    const right: Array<[number, number, number]> = [[box.x1, box.y0, box.z0], [box.x1, box.y1, box.z0], [box.x1, box.y1, box.z1], [box.x1, box.y0, box.z1]];
    geo.push({ k: 'fill', pts: q(top), layer: L, alpha: 0.1 });
    geo.push({ k: 'fill', pts: q(front), layer: L, alpha: 0.2 });
    geo.push({ k: 'fill', pts: q(right), layer: L, alpha: 0.3 });
    geo.push({ k: 'poly', pts: q(top), closed: true, layer: L, lw: 1.2 });
    geo.push({ k: 'poly', pts: q(front), closed: true, layer: L, lw: 1.2 });
    geo.push({ k: 'poly', pts: q(right), closed: true, layer: L, lw: 1.2 });
  }

  const geoPts: Vec2[] = layouts.flatMap((l) => l.corners);
  const geoBox: BBox = geoPts.length ? bboxOf(geoPts) : { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };

  // ── 件号气泡：只在气泡之间避让（气泡压在板件上是制图惯例，不算冲突）──
  const placer = new LabelPlacer(BUBBLE_MARGIN);
  const bubbles: Array<{ part: PartInstance; from: Vec2; at: Vec2; r: number; moved: boolean }> = [];
  for (const l of layouts) {
    const r = l.part.no < 10 ? 155 : l.part.no < 100 ? 180 : 205;
    const at = placer.fitXY(l.center.x, l.center.y, r, r, `${l.part.no}`);
    bubbles.push({ part: l.part, from: l.center, at, r, moved: Math.hypot(at.x - l.center.x, at.y - l.center.y) > 1 });
  }
  // 气泡让到几何之外时图幅会变宽 → 用"含气泡"的范围量几何区，避免气泡压到明细栏上
  const bubblePts: Vec2[] = bubbles.flatMap((b) => circlePts(b.at, b.r));
  const geoWithBubbles = bubblePts.length ? bboxOf([...geoPts, ...bubblePts]) : geoBox;

  // ── ② 版式（此时几何尺寸已确定）──
  const drawW = geoWithBubbles.max.x - geoWithBubbles.min.x + 2 * BLOCK_PAD;
  const drawH = geoWithBubbles.max.y - geoWithBubbles.min.y + 2 * BLOCK_PAD;
  const legendH = LEGEND_HEAD + as.legend.length * LEGEND_ROW + (as.hardware.length > 0 ? LEGEND_HEAD + as.hardware.length * LEGEND_ROW : 0) + 260;
  const contentH = Math.max(drawH, legendH);
  const totalW = drawW + LEGEND_GAP + LEGEND_W;
  const assumeMaxW = totalW - 400;
  const assumptionLines = [...as.assumptions, extraAssumptionA(as), extraAssumptionB(as)]
    .filter((s) => s !== '')
    .flatMap((s) => wrapByWidth(s, 116, assumeMaxW));
  const assumeH = 340 + assumptionLines.length * ASSUME_ROW;
  const totalH = TITLE_H + contentH + assumeH + 320;

  // ── ③ 平移：水平让几何左边界落在 BLOCK_PAD，竖直让几何顶对齐内容区顶部 ──
  const ox = opts.x ?? 0;
  const oy = opts.y ?? 0;
  const topY = oy + totalH;
  const contentTop = topY - TITLE_H;
  const tx = ox + BLOCK_PAD - geoWithBubbles.min.x;
  const ty = contentTop - BLOCK_PAD - geoWithBubbles.max.y;

  const prims: Prim[] = [];
  for (const p of geo) {
    if (p.k === 'text') prims.push({ ...p, p: { x: p.p.x + tx, y: p.p.y + ty } });
    else prims.push({ ...p, pts: p.pts.map((pt) => ({ x: pt.x + tx, y: pt.y + ty })) });
  }
  const bubbleOut: ExplodeViewSet['bubbles'] = [];
  for (const b of bubbles) {
    const from = { x: b.from.x + tx, y: b.from.y + ty };
    const at = { x: b.at.x + tx, y: b.at.y + ty };
    if (b.moved) prims.push({ k: 'poly', pts: [from, at], closed: false, layer: L_EXPLODE, lw: 0.9 });
    // 白底 + 圈 + 数字：气泡要压在板件色块上也读得清
    prims.push({ k: 'fill', pts: circlePts(at, b.r), layer: L_EXPLODE_BG, alpha: 0.94 });
    prims.push({ k: 'poly', pts: circlePts(at, b.r), closed: true, layer: L_EXPLODE, lw: 1.1 });
    prims.push({ k: 'text', p: at, text: `${b.part.no}`, size: b.part.no < 100 ? 118 : 100, layer: L_EXPLODE, align: 'c' });
    bubbleOut.push({ no: b.part.no, at, r: b.r, moved: b.moved });
  }

  // ── 标题 ──
  prims.push({ k: 'text', p: { x: ox + drawW / 2, y: topY - 260 }, text: `${cab.name}　分解图（爆炸图）`, size: 260, layer: L_TEXT, align: 'c' });
  prims.push({
    k: 'text',
    p: { x: ox + drawW / 2, y: topY - 560 },
    text: `${as.dims.W} × ${as.dims.H} × ${as.dims.D} mm（宽 × 高 × 深）· 等轴测投影 30° · 模型空间 1:1 · 仅供装配关系阅读，不用于量取尺寸`,
    size: 140,
    layer: L_TEXT,
    align: 'c',
  });

  // ── 明细栏 ──
  const legendX = ox + drawW + LEGEND_GAP;
  let ly = contentTop;
  const cell = (x: number, y: number, w: number, h: number): void => {
    prims.push({ k: 'poly', pts: [{ x, y }, { x: x + w, y }, { x: x + w, y: y - h }, { x, y: y - h }], closed: true, layer: L_DIM, lw: 0.9 });
  };
  const rowText = (x: number, y: number, w: number, s: string, size: number, layer: string, align: 'l' | 'c' | 'r'): void => {
    prims.push({ k: 'text', p: { x: x + (align === 'l' ? 30 : w / 2), y: y - LEGEND_ROW / 2 }, text: s, size, layer, align });
  };

  prims.push({ k: 'text', p: { x: legendX, y: ly - LEGEND_HEAD / 2 }, text: `板件明细（与开料清单逐项一致：${as.legend.length} 种 / ${as.check.pieces} 件）`, size: 150, layer: L_TEXT, align: 'l' });
  ly -= LEGEND_HEAD;
  let cx = legendX;
  for (const c of LEGEND_COLS) {
    cell(cx, ly, c.w, LEGEND_ROW);
    rowText(cx, ly, c.w, c.label, 118, L_TEXT, c.align);
    cx += c.w;
  }
  ly -= LEGEND_ROW;

  const matName = (id: string): string => rules.materials[id]?.name ?? id;
  for (const row of as.legend) {
    cx = legendX;
    const vals = [String(row.no), row.nameZh, `${row.cut.length} × ${row.cut.width} × ${row.thickness}`, String(row.qty), matName(row.material)];
    LEGEND_COLS.forEach((c, i) => {
      cell(cx, ly, c.w, LEGEND_ROW);
      rowText(cx, ly, c.w, vals[i], 118, L_TEXT, c.align);
      cx += c.w;
    });
    ly -= LEGEND_ROW;
  }

  if (as.hardware.length > 0) {
    prims.push({ k: 'text', p: { x: legendX, y: ly - LEGEND_HEAD / 2 }, text: '五金（不参与爆炸分解，故图上无件号）', size: 150, layer: L_TEXT, align: 'l' });
    ly -= LEGEND_HEAD;
    cx = legendX;
    for (const c of HW_COLS) {
      cell(cx, ly, c.w, LEGEND_ROW);
      rowText(cx, ly, c.w, c.label, 118, L_TEXT, c.align);
      cx += c.w;
    }
    ly -= LEGEND_ROW;
    for (const h of as.hardware) {
      cx = legendX;
      const vals = [h.nameZh, h.spec, String(h.qty)];
      HW_COLS.forEach((c, i) => {
        cell(cx, ly, c.w, LEGEND_ROW);
        prims.push({ k: 'text', p: { x: cx + (c.align === 'l' ? 30 : c.w / 2), y: ly - LEGEND_ROW / 2 }, text: vals[i], size: 112, layer: L_HW, align: c.align });
        cx += c.w;
      });
      ly -= LEGEND_ROW;
    }
  }

  // ── 假设清单 ──
  let ay = contentTop - contentH - 340;
  prims.push({ k: 'text', p: { x: ox, y: ay }, text: `派生假设与如实说明`, size: 150, layer: L_TEXT, align: 'l' });
  ay -= ASSUME_ROW;
  for (const s of assumptionLines) {
    prims.push({ k: 'text', p: { x: ox, y: ay }, text: s, size: 116, layer: s.startsWith('⚠') ? L_DIM : L_TEXT, align: 'l' });
    ay -= ASSUME_ROW;
  }
  prims.push({ k: 'poly', pts: [{ x: ox, y: contentTop + 80 }, { x: ox + totalW, y: contentTop + 80 }], closed: false, layer: L_EXPLODE, lw: 1.4 });

  const allPts: Vec2[] = prims.flatMap(primVisualExtent);
  const bbox: BBox = allPts.length ? bboxOf(allPts) : { min: { x: ox, y: oy }, max: { x: ox + totalW, y: oy + totalH } };

  return {
    cabinetId: cab.id,
    cabinetName: cab.name,
    prims,
    bbox,
    origin: { x: ox, y: oy },
    w: totalW,
    h: totalH,
    dims: as.dims,
    legend: as.legend,
    hardware: as.hardware,
    drawnNos: [...new Set(as.parts.map((p) => p.no))].sort((a, b) => a - b),
    unfitted: [...placer.unfitted],
    bubbles: bubbleOut,
    drawn: layouts.map((l) => ({
      no: l.part.no,
      panelId: l.part.panelId,
      seq: l.part.seq,
      nameZh: l.part.nameZh,
      tier: l.part.tier,
      lane: l.part.lane,
      dist: l.dist,
      axis: l.part.dir.axis,
      sign: l.part.dir.sign,
      center: { x: l.center.x + tx, y: l.center.y + ty },
      corners: l.corners.map((c) => ({ x: c.x + tx, y: c.y + ty })),
    })),
    check: as.check,
    assumptions: assumptionLines,
  };
}

/**
 * 由 buildAssembly 拿到装配数据。
 *
 * 单独抽一层是因为 explode.ts 只依赖"装配数据"这个契约，不关心它怎么来的 ——
 * 将来如果装配数据改成由 AI 补齐（例如补上抽屉箱的三维基准），
 * 只要契约不变，这个文件一行都不用改。
 */
function extraAssumptionA(as: Assembly): string {
  return as.check.conventionalPlacement.length > 0
    ? `⚠ 有 ${as.check.conventionalPlacement.length} 类板件的**装配基准在模型里没有定义**，本图按显式约定摆放：${as.check.conventionalPlacement.map((c) => `${c.nameZh}（${c.role}）`).join('、')}。约定内容：${as.check.conventionalPlacement[0].why}`
    : '';
}

function extraAssumptionB(as: Assembly): string {
  return as.check.dimMismatches.length > 0
    ? `⚠ 明细栏共 ${as.check.dimMismatches.length} 块的裁切进深与图上落位进深不同（见上面的 depth 语义说明）。**生产以明细栏（开料清单）尺寸为准**，图上落位只表达装配关系。`
    : '';
}

// ─────────────────────────── 多柜并排 ───────────────────────────

export interface ProjectExplodeSet {
  /** 是否开启分解图（false 时 prims 为空、bbox 为 null） */
  enabled: boolean;
  prims: Prim[];
  bbox: BBox | null;
  perCabinet: ExplodeViewSet[];
  assumptions: string[];
  commonAssumptions: string[];
  /** 全部柜体的核对汇总 —— 「分解图与开料清单一一对应」的可执行证据 */
  check: {
    cabinets: number;
    panelKinds: number;
    pieces: number;
    instances: number;
    drawnNos: number;
    mismatches: number;
    unplaced: string[];
    ok: boolean;
  };
  /** 与四视图图幅之间的间距（实际用了多少） */
  gap: number;
}

export const EXPLODE_SHEET_GAP = 2200;
/** 同一张图上并排两个柜体分解图的水平间距 */
export const EXPLODE_CABINET_GAP = 2000;

/**
 * 整个项目 → 一张分解图图幅（多柜左右并排）。
 *
 * `below`：四视图图幅的包围盒。给了就把分解图整体摆到它**正下方**，
 * 于是"两张图永不重叠"是算出来的，不是调参数调出来的。
 *
 * `enabled = false` 时**不做任何派生**（连 buildAssembly 都不跑）——
 * 默认关闭就意味着默认零开销，这跟"开关"这个词的字面意思一致。
 */
export function buildProjectExplode(
  project: Project,
  rules: RuleSet,
  opts: { enabled?: boolean; below?: BBox | null; gap?: number } = {}
): ProjectExplodeSet {
  const enabled = opts.enabled ?? false;
  const gap = opts.gap ?? EXPLODE_SHEET_GAP;
  const empty: ProjectExplodeSet = {
    enabled: false,
    prims: [],
    bbox: null,
    perCabinet: [],
    assumptions: [],
    commonAssumptions: [],
    check: { cabinets: 0, panelKinds: 0, pieces: 0, instances: 0, drawnNos: 0, mismatches: 0, unplaced: [], ok: true },
    gap,
  };
  if (!enabled) return empty;
  if (project.cabinets.length === 0) {
    return { ...empty, enabled: true, assumptions: ['项目里还没有柜体，没有可分解的对象。'] };
  }

  const assemblies = buildProjectAssembly(project, rules);

  /**
   * 先按 (0,0) 建一遍量出最高的一张 —— 图幅高度由明细栏行数决定，
   * 各柜明细行数不同，不能用固定值估。之后统一按"底部对齐基准线"重新摆。
   */
  const probe = assemblies.map((a) => buildCabinetExplode(cabinetById(project, a.cabinetId), rules));
  const maxH = Math.max(...probe.map((v) => v.h));
  const baseY = opts.below ? opts.below.min.y - gap - maxH : 0;

  const prims: Prim[] = [];
  const perCabinet: ExplodeViewSet[] = [];
  const seen = new Map<string, number>();
  let cursor = 0;

  for (const a of assemblies) {
    const vs = buildCabinetExplode(cabinetById(project, a.cabinetId), rules, { x: cursor, y: baseY });
    prims.push(...vs.prims);
    perCabinet.push(vs);
    for (const s of vs.assumptions) seen.set(s, (seen.get(s) ?? 0) + 1);
    cursor += vs.w + EXPLODE_CABINET_GAP;
  }

  const allPts: Vec2[] = prims.flatMap(primVisualExtent);
  const assumptions = [...seen.keys()];

  return {
    enabled: true,
    prims,
    bbox: allPts.length ? bboxOf(allPts) : null,
    perCabinet,
    assumptions,
    commonAssumptions: assumptions.filter((s) => (seen.get(s) ?? 0) > 1),
    check: {
      cabinets: perCabinet.length,
      panelKinds: perCabinet.reduce((n, v) => n + v.check.panelKinds, 0),
      pieces: perCabinet.reduce((n, v) => n + v.check.pieces, 0),
      instances: perCabinet.reduce((n, v) => n + v.check.instances, 0),
      drawnNos: perCabinet.reduce((n, v) => n + v.drawnNos.length, 0),
      mismatches: perCabinet.reduce((n, v) => n + v.check.dimMismatches.length, 0),
      unplaced: [...new Set(perCabinet.flatMap((v) => v.check.unplaced))],
      ok: perCabinet.every((v) => v.check.ok),
    },
    gap,
  };
}

function cabinetById(project: Project, id: string): Cabinet {
  const cab = project.cabinets.find((c) => c.id === id);
  if (!cab) throw new Error(`找不到柜体 ${id}`);
  return cab;
}
