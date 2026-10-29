import type { BBox, Cabinet, Prim, Project, RuleSet, Vec2 } from '../types.ts';
import { equalSpacing } from '../allocate.ts';
import { computeCabinetLayout, doorWidths, drawerCellHeights } from './layout.ts';
import { effectiveRodZ } from './generate.ts';
import { buildFrontPickLines, buildSideTopPickLines } from './pickLines.ts';
import type { PickLine } from './pickLines.ts';
import { bboxOf } from './transform.ts';
import { LabelPlacer, primVisualExtent } from './labels.ts';
import { sheetSourceKeys } from '../drawingEdits.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  四视图派生 —— 正视图 / 俯视图 / 侧视图 / 内部结构图
 *
 *  核心命题（用户原话：**"衔接要合理"**）：
 *    四张图**绝不各自画**。它们全部由同一份柜体参数派生，
 *    而且共用同一套【柜体三维坐标】的三个分量：
 *
 *        X ∈ [0, W]   从左到右（宽）
 *        Y ∈ [0, D]   从背面到正面（进深）
 *        Z ∈ [0, H]   从地面到顶（高）
 *
 *    每个视图只是「取其中两个分量 + 摆到图纸上的位置」：
 *
 *        正视图   (X, Z)   图纸 (fx  + X, fy + Z)
 *        俯视图   (X, Y)   图纸 (fx  + X, ty0 - Y)      ← 置于正视图正下方
 *        侧视图   (Y, Z)   图纸 (sx0 + Y, fy + Z)       ← 置于正视图正右方
 *        内部图   (X, Z)   图纸 (ix0 + X, fy + Z)
 *
 *    映射里**只有分量取舍与平移/翻转，没有任何尺寸重算**，因此下面三条
 *    制图铁律是【结构性保证】，而不是"两边都写巧了"的巧合：
 *
 *       长对正：正视图与俯视图共享同一段 X —— 宽度必然对齐
 *       高平齐：正视图与侧视图共享同一段 Z —— 高度必然对齐
 *       宽相等：俯视图的 Y 跨度 === 侧视图的 Y 跨度 === 柜深 D
 *
 *    这三条在 verify/views-acceptance.ts 里是**可执行断言**（含负样本）。
 *    任何"各画各的"的改法都会当场变红。
 *
 *  ── 排布依据 ──
 *    第一角投影法（GB / ISO-E）：投影面在物体之后 / 之下 / 之右，
 *    俯视图绕水平轴向下展开 → 落在正视图正下方；
 *    侧视图（左视图）绕竖直轴向右展开 → 落在正视图正右方。
 *    展开后俯视图的「上边」与侧视图的「左边」都紧贴正视图，
 *    代表的都是物体的**后面**（也就是柜体背靠墙的那一面）。
 *
 *  ── 关于"深度检查" ──
 *    板件都有厚度，因此每个视图天然存在重叠内容（俯视图里层板在顶板之下）。
 *    模型空间里**不靠遮挡隐藏**，而是把板件按板厚分到不同图层着色，
 *    让设计师读得出结构层次；真正的隐藏线（HIDDEN 线型）留到 Phase 5 出图。
 * ══════════════════════════════════════════════════════════════════════
 */

export type ViewKind = 'front' | 'top' | 'side' | 'internal';

export const VIEW_KINDS: ViewKind[] = ['front', 'internal'];

export const VIEW_NAME: Record<ViewKind, string> = {
  front: '立面外观图',
  top: '俯视图',
  side: '侧视图',
  internal: '立面结构图',
};

export const VIEW_NOTE: Record<ViewKind, string> = {
  front: '从前向后看 · 含门 / 抽面',
  top: '从上向下看',
  side: '从左向右看',
  internal: '同正视图方向 · 移去门 / 抽面 · 标注板件',
};

/** 视图间的投影衔接线（点划线，第一角投影的可见证据） */
const HINGE_DASH = [220, 60, 46, 60];
/** 被遮挡但必须表达出来的轮廓（层板、移开的门…） */
const HIDDEN_DASH = [70, 46];
/** 挂衣杆 */
const ROD_DASH = [60, 24, 10, 24];

// ── 图层名（与 viewport/layers.ts 的 LAYERS 表一一对应）──
const L_FRAME = 'F-CAB';
const L_FRONT = 'F-CAB-FRONT';
const L_HW = 'F-CAB-HW';
const L_DIM = 'F-DIM';
const L_TEXT = 'F-TEXT';
const L_HIDDEN = 'F-CAB-HIDDEN';
const L_VIEW = 'F-VIEW';

/** 板件按厚度分图层 —— 与 generate.ts 同一套规则，跨视图颜色一致 */
function layerOfThickness(th: number): string {
  return `PANEL_${th}`;
}

// ────────────────────── 标签避让（不让文字叠在一起） ──────────────────────
//
// 具体实现已提到 labels.ts：分解图（explode.ts）要用**同一套**字宽估算和
// 避让算法，否则会出现"四视图不压字、分解图压成一团"这种没人负责的差异。
// 这里再导出一次，是为了不改动已有的 import 路径（验收脚本在用）。
export { LabelPlacer, estimateTextWidth } from './labels.ts';
export interface ViewMeta {
  kind: ViewKind;
  nameZh: string;
  note: string;
  /** 该视图局部坐标 (0,0) 在图纸坐标中的落点 */
  origin: Vec2;
  /** 视图外框在图纸坐标中的轴对齐范围 */
  bbox: BBox;
  /** 视图外框的图纸宽 / 高（正数） */
  w: number;
  h: number;
}

export interface ViewSet {
  cabinetId: string;
  cabinetName: string;
  prims: Record<ViewKind, Prim[]>;
  meta: Record<ViewKind, ViewMeta>;
  /** 投影衔接线：把"长对正 / 高平齐"画成看得见的线 */
  hinge: Prim[];
  /** 尺寸标注、视图标题、总标题（不属于任何单个视图，属于整幅图） */
  labels: Prim[];
  bbox: BBox;
  dims: { W: number; H: number; D: number };
  gaps: { gapTop: number; gapSide: number; gapInt: number };
  /** 为画图而必须做的假设；没有工艺依据的地方必须说出来，不能悄悄画 */
  assumptions: string[];
  /**
   * 几何 → 语义的反查表（点选/圈选局部编辑用，A1）。
   * 与图元在同一处生成、同一套 mapper —— 点位与屏幕上的线逐位一致。
   */
  pickLines: PickLine[];
}

export interface ViewOpts {
  /** 图幅原点（多柜并排时由调用方平移） */
  x?: number;
  y?: number;
  gapTop?: number;
  gapSide?: number;
  gapInt?: number;
}

export const DEFAULT_GAPS = { gapTop: 780, gapSide: 1180, gapInt: 1180 };
/** 同一张图上并排两个柜体时的水平间距 */
export const CABINET_VIEW_GAP = 1600;

// ─────────────────────────── 绘图小工具 ───────────────────────────

type Mapper = (a: number, b: number) => Vec2;
type Align = 'l' | 'c' | 'r';

interface ViewPainter {
  rect(a0: number, a1: number, b0: number, b1: number, layer: string, lw: number, dash?: number[]): void;
  line(a0: number, a1: number, b0: number, b1: number, layer: string, lw: number, dash?: number[]): void;
  fillRect(a0: number, a1: number, b0: number, b1: number, layer: string, alpha: number): void;
  text(a: number, b: number, s: string, size: number, layer: string, align?: Align, rot?: number): void;
  /** 任意多边形（斜层板平行四边形 / 见光板圆弧离散点共用） */
  poly(pts: Array<{ x: number; y: number }>, layer: string, lw: number, closed?: boolean, dash?: number[]): void;
  /** 圆弧（离散为折线，见光板 R36 前缘圆弧） */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, layer: string, lw: number, dash?: number[], segments?: number): void;
}

/**
 * ── 格子抽的折线小格（2026-10-21，对标参考图纸《世园润府》）──
 *
 * ★ 参考图纸的真实画法（从 PDF 内容流实测坐标，不是目测）──
 *   格子抽**不是**「若干个小方框」，而是一条**连续折线**：
 *   从抽面左上角出发，6 条等角度斜线（±24.5°）等距排布，
 *   中间两条在底边相接形成一个谷底，整体像一个「山」字。
 *
 *   实测归一化坐标（x 除以抽面宽，y 除以折线区高，0 在下）：
 *     (0.000,1.000)→(0.051,0.899)   (0.200,0.601)→(0.300,0.401)
 *     (0.449,0.103)→(0.500,0.000)   (0.500,0.000)→(0.551,0.103)
 *     (0.700,0.401)→(0.800,0.601)   (0.949,0.899)→(1.000,1.000)
 *
 * ★ 为什么照抄而不是自己发挥 ──
 *   画成「小方框阵列」，客户会以为是一排小门；
 *   照抄折线，客户和车间一眼就认出是格子抽。
 *
 * @param P     绘制器
 * @param x0,x1 抽面左右边（柜体局部 X）
 * @param z0,z1 折线区上下边（柜体局部 Z，z1 为上）
 */
function drawGridDrawerFront(P: ViewPainter, x0: number, x1: number, z0: number, z1: number): void {
  const w = x1 - x0;
  const h = z1 - z0;
  if (w < 120 || h < 40) return;
  /**
   * 折线的归一化折点（与参考图实测一一对应）。
   *
   *   每一项是一段斜线：起点 (x, y) → 终点 (x, y)，均为归一化值。
   *   水平步长固定 0.05~0.1，垂直步长固定 0.1。
   *
   *   ★ 斜线角度由**折线区的高宽比**决定 ★
   *   参考图实测：短段 dx=152 / dy=70 ⇒ 角度 24.5°。
   *   本实现的归一化步长给的是 dx=0.05w、dy=0.1h，
   *   所以要得到同样的角度，**折线区高必须 ≈ 0.23 × 宽**。
   *   调用方按这个比例给高，角度就自然对上了。
   */
  const ZIG: Array<[number, number, number, number]> = [
    [0.0, 1.0, 0.05, 0.9],
    [0.2, 0.6, 0.3, 0.4],
    [0.45, 0.1, 0.5, 0.0],
    [0.5, 0.0, 0.55, 0.1],
    [0.7, 0.4, 0.8, 0.6],
    [0.95, 0.9, 1.0, 1.0],
  ];
  for (const [ax, ay, bx, by] of ZIG) {
    P.line(x0 + ax * w, x0 + bx * w, z0 + ay * h, z0 + by * h, L_FRONT, 0.8);
  }
}

/**
 * ── 裤架：挂衣区底部一排倒 V 形挂钩（2026-10-21，对标参考图纸）──
 *
 * ★ 参考图纸的真实画法（PDF 内容流实测）──
 *   裤架 = 一根横杆 + 杆下挂的 **∨ 形**挂钩：
 *     (28062,15026)→(28214,14956)  dx=152 dy=-70
 *     (28214,14956)→(28366,15026)  dx=152 dy=+70
 *   顶点**朝上**正好落在杆的 y 上，两侧等长（167），水平跨距 304。
 *
 * ★ 为什么顶点朝上 ──
 *   裤架是「横杆 + 挂钩」，挂钩从杆上垂下来。
 *   画成 ∧（顶点朝上）读图方向是反的，客户会以为那是撑杆。
 *
 * @param P     绘制器
 * @param x0,x1 分区左右边（柜体局部 X）
 * @param zBase 分区底边（柜体局部 Z）—— 挂钩挂在从底边抬起的一根横杆上
 */
function drawTrouserRack(P: ViewPainter, x0: number, x1: number, zBase: number): void {
  const w = x1 - x0;
  if (w < 150) return;
  /**
   * 挂钩的尺寸按分区宽等比缩放：
   *   参考图挂钩水平跨距 304、垂直 70，比例约 4.3:1。
   *   宽度取 min(分区宽/6, 300)，保证一排能放下几个又不挤。
   */
  const hookW = Math.min(w / 6, 300);
  const hookH = hookW / 4.3;
  const rodZ = zBase + 40; // 裤架横杆：略高于分区底
  // 横杆（从左到右）
  P.line(x0, x1, rodZ, rodZ, L_HW, 1.0);
  // 一排挂钩：顶点朝上挂在杆上
  const n = Math.max(1, Math.floor(w / hookW));
  const step = w / n;
  for (let i = 0; i < n; i++) {
    const cx = x0 + step * (i + 0.5);
    const half = Math.min(hookW / 2, step / 2 - 4);
    P.line(cx - half, cx, rodZ, rodZ - hookH, L_HW, 0.8);
    P.line(cx, cx + half, rodZ - hookH, rodZ, L_HW, 0.8);
  }
}

/**
 * ── 灯带符号（2026-10-21，对标参考图纸《世园润府》）──
 *
 * ★ 参考图纸的实测画法（PDF 内容流逐条量出来的）──
 *
 *   ① **靠前 front**（p5）：
 *      层板占 y19558..19594（板厚 36），灯带槽画成**双线**在
 *      y19522 与 y19533（间距 11 = 槽壁厚），位置在层板**下方**。
 *      y 更小 = 更靠观察者 = 层板前缘，所以「靠前」= 画在前缘外侧。
 *
 *   ② **居中 center**（p2）：
 *      层板中间两条**单线**，间距 82（实测 y18164 / y18246）。
 *
 *   ③ **45°斜光 angled45**（p6）：
 *      一条 45° 斜线 + 一条水平线（实测斜线 (30814,17210)→(31787,19003)，
 *      水平线在 y19003）。
 *
 * ★ 尺寸怎么定 ──
 *   参考图的绝对值（槽壁 11、居中间距 82）是**图纸单位**，
 *   与柜体实际毫米没有固定关系（层板厚度会变）。
 *   所以这里按**层板厚度的比例**给：
 *     · 靠前：槽壁 = 板厚 × 0.3（参考 11/36 ≈ 0.3），
 *       槽在层板前缘外侧。
 *     · 居中：两条线在板厚中部，上下各留 板厚 × 0.25。
 *     · 45°：从层板前缘斜向内上 45°，画到板厚 × 1.2 处。
 *   比例取自参考图，换板厚也不会失真。
 *
 * @param P     绘制器
 * @param x0,x1 层板左右边（柜体局部 X）
 * @param zFront 层板**前缘**的 Z（柜体局部，较小的一端）
 * @param t     层板厚度
 * @param style 灯带安装位
 */
function drawLedStrip(
  P: ViewPainter,
  x0: number,
  x1: number,
  zFront: number,
  t: number,
  style: 'none' | 'center' | 'front' | 'angled45'
): void {
  const w = x1 - x0;
  if (w < 60 || t < 2) return;
  switch (style) {
    case 'front': {
      // 灯带槽：前缘外侧的双线（槽壁 = 板厚 × 0.3）
      const wall = Math.max(3, t * 0.3);
      const zSlotTop = zFront - wall;
      const zSlotBot = zSlotTop - wall;
      P.line(x0, x1, zSlotTop, zSlotTop, L_HW, 1.0);
      P.line(x0, x1, zSlotBot, zSlotBot, L_HW, 1.0);
      // 槽与层板前缘之间的连接（两条短竖线）
      P.line(x0, x0, zFront, zSlotTop, L_HW, 0.7);
      P.line(x1, x1, zFront, zSlotTop, L_HW, 0.7);
      break;
    }
    case 'center': {
      // 层板中间两条单线（参考图间距 = 板厚 × 2.3）
      const gap = t * 0.9;
      const zc = zFront + t / 2;
      P.line(x0, x1, zc - gap / 2, zc - gap / 2, L_HW, 0.8);
      P.line(x0, x1, zc + gap / 2, zc + gap / 2, L_HW, 0.8);
      break;
    }
    case 'angled45': {
      // 45° 斜光线：从层板前缘斜向内上，配一条水平线
      const reach = t * 1.2;
      P.line(x0 + 0, x0 + reach, zFront, zFront + reach, L_HW, 0.8);
      P.line(x0, x1, zFront + reach, zFront + reach, L_HW, 0.8);
      break;
    }
    default:
      break;
  }
}

function makePainter(out: Prim[], map: Mapper): ViewPainter {
  return {
    rect(a0, a1, b0, b1, layer, lw, dash) {
      out.push({
        k: 'poly',
        pts: [map(a0, b0), map(a1, b0), map(a1, b1), map(a0, b1)],
        closed: true,
        layer,
        lw,
        ...(dash ? { dash } : {}),
      });
    },
    line(a0, a1, b0, b1, layer, lw, dash) {
      out.push({ k: 'poly', pts: [map(a0, b0), map(a1, b1)], closed: false, layer, lw, ...(dash ? { dash } : {}) });
    },
    fillRect(a0, a1, b0, b1, layer, alpha) {
      out.push({ k: 'fill', pts: [map(a0, b0), map(a1, b0), map(a1, b1), map(a0, b1)], layer, alpha });
    },
    text(a, b, s, size, layer, align = 'c', rot) {
      out.push({ k: 'text', p: map(a, b), text: s, size, layer, align, ...(rot ? { rot } : {}) });
    },
    /** 任意多边形（Phase E 斜层板平行四边形 / 见光板圆弧离散点共用） */
    poly(pts: Array<{ x: number; y: number }>, layer: string, lw: number, closed = false, dash?: number[]) {
      out.push({ k: 'poly', pts: pts.map((p) => map(p.x, p.y)), closed, layer, lw, ...(dash ? { dash } : {}) });
    },
    /** 圆弧（离散为折线，Phase E 见光板 R36 前缘圆弧） */
    arc(cx: number, cy: number, r: number, a0: number, a1: number, layer: string, lw: number, dash?: number[], segments = 16) {
      const pts: Array<{ x: number; y: number }> = [];
      for (let i = 0; i <= segments; i++) {
        const a = a0 + ((a1 - a0) * i) / segments;
        pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
      }
      out.push({ k: 'poly', pts: pts.map((p) => map(p.x, p.y)), closed: false, layer, lw, ...(dash ? { dash } : {}) });
    },
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════
 *  尺寸布局器（防重叠）
 *
 *  问题：pushDim 用硬编码偏移（460/620/360），分区窄或多尺寸链时，
 *  尺寸线/文字会互相重叠。
 *
 *  做法：
 *    · 收集该视图所有尺寸意图 {p0, p1, txt, orientation, side, baseOffset}
 *    · 按 side 分组，同组内按轴向位置排序
 *    · 区间（text 宽度计入）重叠的分配不同 level：offset = baseOffset + level * 280
 *    · 用现有 pushDim 发射，只是位置由布局器决定
 *
 *  不改 Prim 格式，不改调用方语义，只换内部排版。
 * ══════════════════════════════════════════════════════════════════════
 */
export interface DimIntent {
  /** 被测区间的两端（图纸坐标，几何上的点） */
  p0: Vec2;
  p1: Vec2;
  txt: string;
  /** 尺寸线方向：'h' = 水平线，'v' = 竖直线 */
  orientation: 'h' | 'v';
  /** 尺寸线在被测体的哪一侧 */
  side: 'top' | 'bottom' | 'left' | 'right';
  /** 基础偏移（第一层尺寸线距几何的距离，mm） */
  baseOffset: number;
  /**
   * 链标识：同 side 下不同链（如总宽链 vs 分区链）互不干扰，
   * 各自独立做区间染色。缺省 ''。
   */
  chain?: string;
  textOffset?: number;
  rot?: number;
}

/** 层间距（mm）：重叠的尺寸线逐层外移的步长 */
export const DIM_LEVEL_STEP = 800;  // 2026-10-04 v8：用户说 600 还挤，拉到 800
/** 文字宽度估算：size 110 的数字约 0.55 * size 每字符 */
const DIM_TEXT_CHAR_W = 0.55;

export class DimLayout {
  private intents: DimIntent[] = [];

  add(intent: DimIntent): void {
    this.intents.push(intent);
  }

  /** 返回指定方向尺寸链最外侧的偏移，用于在摆放相邻视图前预留实际标注带宽。 */
  outermostOffset(side: DimIntent['side']): number {
    const groups = new Map<string, DimIntent[]>();
    for (const intent of this.intents) {
      if (intent.side !== side) continue;
      const key = intent.chain ?? '';
      const group = groups.get(key) ?? [];
      group.push(intent);
      groups.set(key, group);
    }

    let outermost = 0;
    for (const items of groups.values()) {
      const axial = (it: DimIntent): number =>
        it.orientation === 'h' ? Math.min(it.p0.x, it.p1.x) : Math.min(it.p0.y, it.p1.y);
      const axialEnd = (it: DimIntent): number =>
        it.orientation === 'h' ? Math.max(it.p0.x, it.p1.x) : Math.max(it.p0.y, it.p1.y);
      const textHalf = (it: DimIntent): number => (it.txt.length * 110 * DIM_TEXT_CHAR_W) / 2;
      const sorted = [...items].sort((a, b) => axial(a) - axial(b));
      const levelEnds: number[] = [];

      for (const intent of sorted) {
        const a0 = axial(intent);
        const a1 = axialEnd(intent);
        const mid = (a0 + a1) / 2;
        const th = textHalf(intent) + 25;
        const start = Math.min(a0 + 1, mid - th);
        const end = Math.max(a1 - 1, mid + th);
        let level = 0;
        while (level < levelEnds.length && start < levelEnds[level]!) level++;
        if (level >= levelEnds.length) levelEnds.push(end);
        else levelEnds[level] = Math.max(levelEnds[level]!, end);
        outermost = Math.max(outermost, intent.baseOffset + level * DIM_LEVEL_STEP);
      }
    }
    return outermost;
  }

  /**
   * 发射所有尺寸。用区间染色法分配 level：
   * 同 side 组内，按轴向排序，text 宽度计入区间，重叠的进不同 level。
   */
  emit(out: Prim[]): void {
    // 按 side + chain 分组：不同链（如总宽链 vs 分区链）互不干扰，各自独立染色
    const groups = new Map<string, DimIntent[]>();
    for (const it of this.intents) {
      const key = `${it.side}|${it.chain ?? ''}`;
      const g = groups.get(key) ?? [];
      g.push(it);
      groups.set(key, g);
    }

    for (const [, items] of groups) {
      // 按轴向起始位置排序（'h' 按 x，'v' 按 y）
      const axial = (it: DimIntent): number =>
        it.orientation === 'h' ? Math.min(it.p0.x, it.p1.x) : Math.min(it.p0.y, it.p1.y);
      const axialEnd = (it: DimIntent): number =>
        it.orientation === 'h' ? Math.max(it.p0.x, it.p1.x) : Math.max(it.p0.y, it.p1.y);
      // text 半宽计入区间：窄分区时文字比区间宽，按纯区间判不重叠但文字会压住
      const textHalf = (it: DimIntent): number => (it.txt.length * 110 * DIM_TEXT_CHAR_W) / 2;

      const sorted = [...items].sort((a, b) => axial(a) - axial(b));
      const levelEnds: number[] = [];
      const levels: number[] = [];

      for (const it of sorted) {
        const a0 = axial(it);
        const a1 = axialEnd(it);
        const mid = (a0 + a1) / 2;
        const th = textHalf(it) + 25;
        const s = Math.min(a0 + 1, mid - th);
        const e = Math.max(a1 - 1, mid + th);
        let lv = 0;
        while (lv < levelEnds.length && s < levelEnds[lv]!) lv++;
        levels.push(lv);
        if (lv >= levelEnds.length) levelEnds.push(e);
        else levelEnds[lv] = Math.max(levelEnds[lv]!, e);
      }

      // 发射：按 level 计算偏移，构造尺寸线位置后调 pushDim
      for (let i = 0; i < sorted.length; i++) {
        const it = sorted[i]!;
        const lv = levels[i]!;
        const off = it.baseOffset + lv * DIM_LEVEL_STEP;
        let a: Vec2;
        let b: Vec2;
        if (it.orientation === 'h') {
          const y0 = Math.min(it.p0.y, it.p1.y);
          const y = it.side === 'top' ? y0 + off : y0 - off;
          a = { x: Math.min(it.p0.x, it.p1.x), y };
          b = { x: Math.max(it.p0.x, it.p1.x), y };
        } else {
          const x0 = Math.min(it.p0.x, it.p1.x);
          const x = it.side === 'right' ? x0 + off : x0 - off;
          a = { x, y: Math.min(it.p0.y, it.p1.y) };
          b = { x, y: Math.max(it.p0.y, it.p1.y) };
        }
        pushDim(out, a, b, it.txt, it.textOffset, it.rot);
      }
    }
  }

  clear(): void {
    this.intents = [];
  }
}

/** 一条带界线与箭头的尺寸线（图纸坐标，绝对位置） */
function pushDim(out: Prim[], a: Vec2, b: Vec2, txt: string, textOffset = 150, rot?: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;

  out.push({ k: 'poly', pts: [a, b], closed: false, layer: L_DIM, lw: 0.9 });

  const ext = 130;
  for (const p of [a, b]) {
    out.push({
      k: 'poly',
      pts: [
        { x: p.x - nx * ext, y: p.y - ny * ext },
        { x: p.x + nx * ext, y: p.y + ny * ext },
      ],
      closed: false,
      layer: L_DIM,
      lw: 0.8,
    });
  }

  const s = 62;
  const w = 22;
  for (const [p, dir] of [
    [a, 1],
    [b, -1],
  ] as Array<[Vec2, number]>) {
    out.push({
      k: 'poly',
      pts: [
        { x: p.x, y: p.y },
        { x: p.x + dir * ux * s + nx * w, y: p.y + dir * uy * s + ny * w },
      ],
      closed: false,
      layer: L_DIM,
      lw: 0.9,
    });
    out.push({
      k: 'poly',
      pts: [
        { x: p.x, y: p.y },
        { x: p.x + dir * ux * s - nx * w, y: p.y + dir * uy * s - ny * w },
      ],
      closed: false,
      layer: L_DIM,
      lw: 0.9,
    });
  }

  out.push({
    k: 'text',
    p: { x: (a.x + b.x) / 2 + nx * textOffset, y: (a.y + b.y) / 2 + ny * textOffset },
    text: txt,
    size: 110,
    layer: L_DIM,
    align: 'c',
    ...(rot ? { rot } : {}),
  });
}

// ─────────────────────────── 主函数 ───────────────────────────

/**
 * 单个柜体 → 四视图。
 * 纯函数：同样的 (cab, rules, opts) 永远得到同样的图元，可穷举单测。
 */
export function buildCabinetViews(cab: Cabinet, rules: RuleSet, opts: ViewOpts = {}): ViewSet {
  const p = cab.params;
  const L = computeCabinetLayout(cab, rules);
  const t = L.boardT;
  const tb = L.backT;
  const W = p.width;
  const H = p.height;
  const D = p.depth;
  // Phase E 表达异形：见光板 R36 前缘圆弧。提升到外层作用域，
  // 供正视图（drawFrontLike）、侧视图（第 3 节）、内部图标签同源引用。
  const feFront = p.finishedEnds ?? 'none';
  const R36 = 36;
  const bodyLift = p.bodyLift;
  const innerW = L.innerW;
  const innerH = L.innerH;
  const nets = L.nets;
  const bp = p.backPanel;

  /**
   * ══════════════════════════════════════════════════════════════════════
   *  行的绘图上下文（canonical）
   *
   *  视图只读 `L.rows`，**不知道**文件里存的是 `rows` 还是 `units`
   *  （那是 core/layoutModel.ts 唯一口径点的事）。每行自带净宽表、Z 起点与净高 ——
   *  于是"上层网格、下层三分区"这种柜体不需要在这里写任何 if，
   *  只是外层多迭代一次。
   *
   *  单行柜：`rowCtxs` 恰好一项，且 `netH === innerH`、`z0 === innerBottomZ`
   *  → 每一处循环的取值与 v0.2 完全相同，图元逐条一致。
   * ══════════════════════════════════════════════════════════════════════
   */
  interface RowCtx {
    units: Cabinet['layout']['units'];
    nets: number[];
    unitX0: number[];
    /** 该行内空底面 Z */
    z0: number;
    /** 该行净高 */
    netH: number;
  }
  const rowCtxs: RowCtx[] = L.rows.map((r) => ({ units: r.units, nets: r.nets, unitX0: r.unitX0, z0: r.z0, netH: r.netH }));
  /** 是否多行柜 —— 只用来决定**文案**（行标签前缀、逐行净宽清单），不参与任何几何计算 */
  const multiRow = L.rows.length > 1;
  /**
   * 整柜都是嵌入式电器格（冰箱柜）—— 只画外框与电器洞口净空，
   * 不画板件骨架，也不标板件名：那种柜子内部没有侧板/层板可标，
   * 标上去是假的（第一版图纸里冰箱柜内部图就标了"左侧板/底板/踢脚板"）。
   */
  const applianceOnly = L.rows.every((r) => r.units.length > 0 && r.units.every((u) => u.kind === 'appliance'));

  /**
   * 层板在 X 方向的真实跨度 —— 与板件清单严格同源。
   *
   * generate.ts 的立面里用的是**分区净宽** netW，而板件清单里层板的 length 是
   * `netW - 2×gapPerSide`（默认 gapPerSide=0.5，即窄 1mm）。
   * 视图是派生视图，必须画板件的真实尺寸，否则"从同一份数据派生"就是空话。
   * 位置按居中放置（间隙 0.5 是装配让位，不是尺寸）。
   */
  const shelfSpanXIn = (ctx: RowCtx, i: number): { a: number; b: number } => {
    const netW = ctx.nets[i]!;
    const gap = ctx.units[i]?.shelves?.gapPerSide ?? 0;
    const w = netW - 2 * gap;
    const a = ctx.unitX0[i]! + (netW - w) / 2;
    return { a, b: a + w };
  };

  /** 内空底面高度（底板顶面）—— 柜级 */
  const innerBottomZ = bodyLift + t;
  /** 内空顶面高度（顶板底面）—— 柜级 */
  const innerTopZ = H - t;

  /**
   * 柜深 D 含门板厚度：门 / 抽面占 Y ∈ [D-t, D]，
   * 箱体结构板（侧板 / 顶底板 / 中立板）进深按 D-t 绘制。
   */
  const bodyD = D - t;
  const faceY0 = D - t;
  const faceY1 = D;

  // 背板：嵌槽，其背面距柜背 bp.grooveSetback
  const backY0 = bp.grooveSetback;
  const backY1 = bp.grooveSetback + tb;
  // 层板：后端紧贴背板前表面（不扎进背板），进深严格取板件派生值 L.shelfDepth
  const shelfY0 = Math.max(bp.grooveSetback + bp.grooveDepth, backY1);
  const shelfY1 = shelfY0 + L.shelfDepth;
  /** 层板前缘越过门板内侧面的量（>0 说明规则集参数自相矛盾，必须如实报出） */
  const shelfOverrun = Math.round(shelfY1 - bodyD);
  // 挂衣杆的进深位置模型未定义 → 取柜体进深中部
  const rodY = (backY1 + faceY0) / 2;

  // ── 双面柜（岛台）：排深与后排骨架 ──
  const DB = L.double;
  const midY0 = DB?.midY0 ?? 0;
  const midY1 = DB ? DB.midY0 + DB.midT : 0;
  // 后排：前脸在 y=0 侧（朝 -Y）；后排层板从前脸往里、贴中板后表面
  const backFaceY0 = 0;
  const backFaceY1 = t;
  const backShelfY0 = DB ? midY0 - DB.backShelfDepth : 0;
  const backShelfY1 = DB ? midY0 : 0;
  const backRodY = DB ? midY0 / 2 : 0;
  // 前排层板：贴中板前表面（midY1），另一端按板件派生深度（可能越 overrun，与单面柜同口径）
  const frontShelfY0 = DB ? midY1 : 0;
  const frontShelfY1 = DB ? midY1 + L.shelfDepth : 0;
  /** 电器格洞口在立面上的 Z 范围（从**该行**内空底到过梁板下表面） */
  const apertureZIn = (ctx: RowCtx, u: Cabinet['layout']['units'][number]): { z0: number; z1: number } | null => {
    if (u.kind !== 'appliance' || !u.appliance) return null;
    return { z0: ctx.z0, z1: ctx.z0 + Math.min(u.appliance.openingHeight, ctx.netH) };
  };

  /**
   * 某一行在 X 处是否"开放"（无门无抽）。
   *
   * 用途只有一个：门板图里**被门挡住的行隔板 / 中立板不画**（见 drawFrontLike 的长注释）。
   * 查询用的区间就是该行真实的 unitX0 / nets，所以这里不产生任何新尺寸 ——
   * 它只是"把已经算好的区间再查一次"，不存在第二个几何口径。
   */
  const opennessAtX = (ctx: RowCtx, x: number): boolean => {
    for (let i = 0; i < ctx.units.length; i++) {
      const a = ctx.unitX0[i]!;
      const b = a + ctx.nets[i]!;
      if (x >= a && x <= b) {
        const u = ctx.units[i]!;
        return !u.doors && !u.drawers;
      }
    }
    return false;
  };

  /**
   * 把上下相邻两行的分区边界合并成一组 X 分段。
   *
   * 行隔板是**贯通横板**（一块整板横跨内空），但门板图上只要该 X 处被门挡住就不该画实线 ——
   * 于是把它按"两行各自的真实分区边界"切成段，逐段判断可见性。
   * 边界全部来自各行已算好的 unitX0 / nets（canonical 派生量），没有任何估算量。
   */
  const columnSegments = (a: RowCtx, b: RowCtx): Array<{ a: number; b: number; mid: number }> => {
    const xs = new Set<number>([t, W - t]);
    for (const ctx of [a, b]) {
      for (let i = 0; i < ctx.units.length; i++) {
        xs.add(ctx.unitX0[i]!);
        xs.add(ctx.unitX0[i]! + ctx.nets[i]!);
      }
    }
    const sorted = [...xs].filter((x) => x >= t && x <= W - t).sort((p, q) => p - q);
    const out: Array<{ a: number; b: number; mid: number }> = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const lo = sorted[i]!;
      const hi = sorted[i + 1]!;
      if (hi - lo > 0.001) out.push({ a: lo, b: hi, mid: (lo + hi) / 2 });
    }
    return out;
  };

  // ── 图幅排布 ──
  const gaps = {
    gapTop: opts.gapTop ?? DEFAULT_GAPS.gapTop,
    gapSide: opts.gapSide ?? DEFAULT_GAPS.gapSide,
    gapInt: opts.gapInt ?? DEFAULT_GAPS.gapInt,
  };
  const fx = opts.x ?? 0;
  const fy = opts.y ?? 0;
  /** 俯视图"背面基准线"的图纸 y（俯视图跨 [ty0-D, ty0]） */
  const ty0 = fy - gaps.gapTop;
  /** 侧视图局部原点 x */
  const sx0 = fx + W + gaps.gapSide;
  /** 内部图局部原点 x */
  const ix0 = sx0 + D + gaps.gapInt;

  // ── 投影映射：只有分量取舍 + 平移/翻转，绝不重算尺寸 ──
  const mapFront: Mapper = (X, Z) => ({ x: fx + X, y: fy + Z });
  const mapTop: Mapper = (X, Y) => ({ x: fx + X, y: ty0 - Y });
  const mapSide: Mapper = (Y, Z) => ({ x: sx0 + Y, y: fy + Z });
  const mapInt: Mapper = (X, Z) => ({ x: ix0 + X, y: fy + Z });

  const prims: Record<ViewKind, Prim[]> = { front: [], top: [], side: [], internal: [] };
  const F = makePainter(prims.front, mapFront);
  const T = makePainter(prims.top, mapTop);
  const S = makePainter(prims.side, mapSide);
  const I = makePainter(prims.internal, mapInt);

  /**
   * PickLine（几何 → 语义反查表，A1）。
   * 必须与图元在**同一处**生成：mapper 传的就是上面那对画图用的，
   * 点位与图元逐位一致 —— 与几何同源，结构上不可能漂移。
   *
   * 四张图各有一份（正视图+内部图 / 侧视图+俯视图），用的都是各自的画图 mapper：
   * 用户在任意一张图上拖动，命中的都是同一套语义部件 → 同一条写路径。
   */
  const pickLines = [
    ...buildFrontPickLines(cab, L, rules, mapFront, mapInt),
    ...buildSideTopPickLines(cab, L, mapSide, mapTop),
  ];

  // ═══════════════ 1. 正视图（从前看，含门 / 抽面）═══════════════
  F.rect(0, W, 0, H, L_FRAME, 2.4);
  drawFrontLike(F, true);
  /**
   * ── 电器图形也要画在**外观图**上（2026-10-21 修）──
   *
   * ★ 修的是一个实测缺陷：电器柜（冰箱 / 洗衣机）走的是"只画外框、不画板件"的
   *   分支，而电器本身的轮廓（冰箱对开门线、洗衣机圆门）只画在**内部结构图**里。
   *   结果：外观正面图是一张**全空的外框**，读图的人看不出这里放的是洗衣机还是冰箱。
   *
   * 参考图《世园润府》p4 的洗衣机柜：外观正面图里**明确画出洗衣机的圆形门、
   * 控制面板、观察窗** —— 那才是给客户看的那张图。
   *
   * 做法：把电器图形抽成共享函数，外观图与内部图都调用。
   * 只对纯电器柜调用（混排柜的电器位由 drawLifestyleItems 在内部图处理）。
   */
  const isPureApplianceCab = L.rows.every((r) => r.units.length > 0 && r.units.every((u) => u.kind === 'appliance'));
  if (isPureApplianceCab) drawApplianceGlyphs(F);

  // ═══════════════ 2. 俯视图（从上往下看）═══════════════
  // 俯视图看到的"顶面"就是顶板；两侧是侧板；最后面是背板；
  // 最前面一条带是门 / 抽面；层板与挂衣杆在顶板之下，用虚线表达。
  T.rect(0, W, 0, D, L_FRAME, 2.4);
  T.rect(0, t, 0, bodyD, layerOfThickness(t), 1); // 左侧板
  T.rect(W - t, W, 0, bodyD, layerOfThickness(t), 1); // 右侧板
  T.rect(t, W - t, 0, bodyD, layerOfThickness(t), 1); // 顶板
  const topCallouts: Array<{ x: number; text: string }> = [];
  for (const cutout of p.counterCutouts ?? []) {
    T.rect(cutout.x, cutout.x + cutout.width, cutout.y, cutout.y + cutout.depth, L_HW, 1.6, HIDDEN_DASH);
    topCallouts.push({ x: W / 2, text: `${cutout.name} ${cutout.width}×${cutout.depth}` });
  }
  // 中立板：**逐行取并集**（多行柜里各行中立板可以落在不同 X，只画第一行会漏）
  const topDividerXs = new Set<number>();
  rowCtxs.forEach((ctx) => {
    for (let i = 0; i < ctx.units.length - 1; i++) topDividerXs.add(ctx.unitX0[i]! + ctx.nets[i]!);
  });
  for (const dx of topDividerXs) {
    T.rect(dx, dx + t, 0, bodyD, layerOfThickness(t), 1); // 中立板
  }
  if (DB) {
    // 双面柜：中板横带 + 背面排的立板线；没有背板（T.rect 背板那条不画）
    T.rect(t, W - t, midY0, midY1, layerOfThickness(t), 1); // 共用中板
    cab.layout.backUnits!.forEach((_, i) => {
      const dx = DB.backUnitX0[i] + DB.backNets[i];
      T.rect(dx, dx + t, 0, midY0, layerOfThickness(t), 1); // 背面排中立板
    });
  } else {
    T.rect(t, W - t, backY0, backY1, layerOfThickness(tb), 1); // 背板
  }

  rowCtxs.forEach((ctx) => {
    ctx.units.forEach((u, i) => {
      const x0 = ctx.unitX0[i]!;
      const x1 = x0 + ctx.nets[i]!;

      if (u.doors || u.drawers) {
        T.rect(x0, x1, faceY0, faceY1, L_FRONT, 1.8);
      }
      if (u.doors && u.doors.count > 1) {
        for (let k = 1; k < u.doors.count; k++) {
          const xk = x0 + (ctx.nets[i]! * k) / u.doors.count;
          T.line(xk, xk, faceY0, faceY1, L_FRONT, 1);
        }
      }
      if (u.kind === 'appliance' && u.appliance) {
        // 电器外框（俯视）：洞口宽 × 洞口深，贴前脸，虚线表达"留空放机器"
        const ow = Math.min(u.appliance.openingWidth, ctx.nets[i]!);
        const od = Math.min(u.appliance.openingDepth, bodyD);
        const ax0 = x0 + (ctx.nets[i]! - ow) / 2;
        T.rect(ax0, ax0 + ow, D - od, D, L_HW, 1.2, HIDDEN_DASH);
        topCallouts.push({ x: ax0 + ow / 2, text: `${u.appliance.name} ${u.appliance.openingWidth}×${u.appliance.openingHeight}` });
      }
      if (u.shelves && u.shelves.count > 0) {
        const s = shelfSpanXIn(ctx, i);
        T.rect(s.a, s.b, shelfY0, shelfY1, L_HIDDEN, 1, HIDDEN_DASH);
      }
      if (u.rod && u.rod.count > 0) {
        T.line(x0 + 2, x1 - 2, rodY, rodY, L_HW, 1.6, ROD_DASH);
      }
    });
  });

  // 背面排（双面柜）：门线 / 门缝在 y∈[0,t]，层板虚线贴中板后表面
  if (DB) {
    cab.layout.backUnits!.forEach((u, i) => {
      const x0 = DB.backUnitX0[i];
      const x1 = x0 + DB.backNets[i];
      if (u.doors || u.drawers) {
        T.rect(x0, x1, backFaceY0, backFaceY1, L_FRONT, 1.8);
      }
      if (u.doors && u.doors.count > 1) {
        for (let k = 1; k < u.doors.count; k++) {
          const xk = x0 + (DB.backNets[i] * k) / u.doors.count;
          T.line(xk, xk, backFaceY0, backFaceY1, L_FRONT, 1);
        }
      }
      if (u.shelves && u.shelves.count > 0) {
        const gap = u.shelves.gapPerSide ?? 0;
        const w = DB.backNets[i] - 2 * gap;
        const a = x0 + (DB.backNets[i] - w) / 2;
        T.rect(a, a + w, backShelfY0, backShelfY1, L_HIDDEN, 1, HIDDEN_DASH);
      }
      if (u.rod && u.rod.count > 0) {
        T.line(x0 + 2, x1 - 2, backRodY, backRodY, L_HW, 1.6, ROD_DASH);
      }
    });
  }
  // 标签锚点位于柜体俯视轮廓外；单柜图排版器会把这条注释带纳入真实 bbox。
  topCallouts.forEach((item, index) => T.text(item.x, D + 160 + index * 120, item.text, 65, L_HW, 'c'));

  // ═══════════════ 3. 侧视图（从左往右看）═══════════════
  // 横轴 = 进深 Y（左边贴正视图 = 柜背，右边 = 柜门）；纵轴 = 高度 Z。
  S.rect(0, D, 0, H, L_FRAME, 2.4);
  // 见光板 R36 前缘圆弧：侧视图里近端（左）端板整面可见，前上角在 (faceY0, H)。
  // 'right' 仅见光板属远端（左视图看不到），由前视图右端条带圆弧表达，此处不画。
  if (feFront === 'left' || feFront === 'both') {
    S.arc(faceY0, H, R36, Math.PI * 1.5, Math.PI * 2, layerOfThickness(t), 1.2);
  }
  S.rect(0, bodyD, H - t, H, layerOfThickness(t), 1); // 顶板
  S.rect(0, bodyD, bodyLift, bodyLift + t, layerOfThickness(t), 1); // 底板
  S.rect(faceY0 - t, faceY0, 0, bodyLift, layerOfThickness(t), 1); // 踢脚板（前挡板）
  if (DB) {
    S.rect(faceY0 - t, faceY0, 0, bodyLift, layerOfThickness(t), 1); // 踢脚板-后（前挡板镜像）
    // 共用中板：侧视图里它是一块实打实的竖板（不是被遮挡的背板）
    S.rect(midY0, midY1, innerBottomZ, innerTopZ, layerOfThickness(t), 1);
  } else {
    S.rect(backY0, backY1, innerBottomZ, innerTopZ, layerOfThickness(tb), 1); // 背板
  }
  // 中立板在侧视图里被左侧板完全遮挡 → 轮廓用虚线表达"此处有一块板"（逐行：只跨本行净高）
  rowCtxs.forEach((ctx) => {
    S.rect(0, bodyD, ctx.z0, ctx.z0 + ctx.netH, L_HIDDEN, 0.9, HIDDEN_DASH);
  });
  // 行隔板：侧视图里是一块实打实的横板（与 2D 立面 / 板件清单同一处派生）
  L.rowDividers.forEach((z) => {
    S.rect(0, bodyD, z, z + t, layerOfThickness(t), 1);
  });

  /** 一排在侧视图里的表达：层板/门/抽/杆的 Y 区间由"这排的脸在哪"决定，Z 由该排内空底与净高决定 */
  const drawRowSide = (
    units: Cabinet['layout']['units'],
    shelfSpan: { y0: number; y1: number },
    faceSpan: { y0: number; y1: number },
    rodCenterY: number,
    z0: number,
    netHRow: number
  ): void => {
    units.forEach((u) => {
      if (u.shelves && u.shelves.count > 0) {
        equalSpacing(netHRow, u.shelves.count).forEach((pos) => {
          S.rect(shelfSpan.y0, shelfSpan.y1, z0 + pos, z0 + pos + t, layerOfThickness(t), 1);
        });
      }
      if (u.doors) {
        S.rect(faceSpan.y0, faceSpan.y1, z0 + u.doors.gapOuter, z0 + netHRow - u.doors.gapOuter, L_FRONT, 1.8);
      }
      if (u.drawers) {
        // 电器格的抽屉挂在洞口上方：净高是"剩余净高"
        const netH = u.kind === 'appliance' && u.appliance ? netHRow - u.appliance.openingHeight - t : netHRow;
        const cellH = drawerCellHeights(u, netH, rules);
        let z = z0 + u.drawers.gap + (u.kind === 'appliance' && u.appliance ? u.appliance.openingHeight + t : 0);
        for (const ch of cellH) {
          S.rect(faceSpan.y0, faceSpan.y1, z, z + ch, L_FRONT, 1.8);
          z += ch + u.drawers.gap;
        }
      }
      if (u.kind === 'appliance' && u.appliance) {
        const a = u.appliance;
        const z1 = Math.min(z0 + a.openingHeight, z0 + netHRow);
        S.rect(shelfSpan.y0, shelfSpan.y1, z0, z1, L_HW, 1.2, HIDDEN_DASH);
      }
      if (u.rod && u.rod.count > 0) {
        // 垂直于视图方向的一根杆 → 画成小十字
        const rz = z0 + effectiveRodZ(u, netHRow, rules);
        S.line(rodCenterY - 70, rodCenterY + 70, rz, rz, L_HW, 1.8);
        S.line(rodCenterY, rodCenterY, rz - 70, rz + 70, L_HW, 1.8);
      }
    });
  };

  // 各行（canonical）：① 垂直行 ② 双面柜背面排（与垂直行正交）
  rowCtxs.forEach((ctx) => {
    drawRowSide(
      ctx.units,
      DB ? { y0: frontShelfY0, y1: frontShelfY1 } : { y0: shelfY0, y1: shelfY1 },
      { y0: faceY0, y1: faceY1 },
      rodY,
      ctx.z0,
      ctx.netH
    );
  });
  if (DB) {
    drawRowSide(cab.layout.backUnits!, { y0: backShelfY0, y1: backShelfY1 }, { y0: backFaceY0, y1: backFaceY1 }, backRodY, innerBottomZ, innerH);
  }

  // ═══════════════ 4. 内部结构图（移去门 / 抽面）═══════════════
  // 背板在内空里铺满一层 → 用浅色填充表达"这里有一层板"（先画，压在最底）
  // 双面柜没有背板（共用中板替代）→ 不画这层填充，避免"看起来有背板"的误导
  if (!DB) {
    prims.internal.unshift({
      k: 'fill',
      pts: [mapInt(t, innerBottomZ), mapInt(W - t, innerBottomZ), mapInt(W - t, innerTopZ), mapInt(t, innerTopZ)],
      layer: layerOfThickness(tb),
      alpha: 0.1,
    });
  }
  I.rect(0, W, 0, H, L_FRAME, 1.8);
  drawFrontLike(I, false);
  /**
   * 柜内包柱：柱体按剖切画成实心块（浅填充 + 外框 + 一条对角虚线）。
   * 贴在柜体背左角、按真实尺寸落位 —— 这是现场尺寸，不是设计尺寸，
   * 所以既不写进板件清单，也不参与层板排布（见 drawFrontLike 的层板守卫）。
   */
  if (p.columnWrap) {
    const cwCol = Math.min(p.columnWrap.width, W - 2 * t);
    const chCol = Math.min(p.columnWrap.height, innerTopZ - innerBottomZ);
    // 用"隐藏线"图层：柱体在柜内、被门板遮住，制图上也归隐藏线；
    // 同时它不参与文字避让器的"内容线"登记（那是衣物的口径），标注可以压在柱体中间。
    I.fillRect(t, t + cwCol, innerBottomZ, innerBottomZ + chCol, L_HIDDEN, 0.14);
    I.rect(t, t + cwCol, innerBottomZ, innerBottomZ + chCol, L_HIDDEN, 1.3);
    // 单柜视图有「结构柱」文字，但**图册视图会把内部图的文字整批去掉**
    // （furnitureSheet.buildRawView 里 viewKind==='internal' 过滤 p.k==='text'），
    // 柱体必须靠自己说明白：铺 45° 剖面线（制图里实心构件就是这么画的）。
    const hz0 = innerBottomZ;
    const hz1 = innerBottomZ + chCol;
    const hx0 = t;
    const hx1 = t + cwCol;
    for (let c = hz0 - hx1; c < hz1 - hx0; c += 160) {
      const xa = Math.max(hx0, hz0 - c);
      const xb = Math.min(hx1, hz1 - c);
      if (xb - xa > 20) I.line(xa, xb, xa + c, xb + c, L_HIDDEN, 0.6);
    }
  }
  drawLifestyleItems(I);
  const labelUnfitted = drawInternalLabels(I, prims.internal);

  // ═══════════════ 5. 投影衔接线 ═══════════════
  const hinge: Prim[] = [];
  const hingeY0 = ty0 - D - 320;
  const hingeY1 = fy + H + 900;
  // 长对正：正视图左右边界 → 贯穿到俯视图下方
  for (const x of [fx, fx + W]) {
    hinge.push({ k: 'poly', pts: [{ x, y: hingeY0 }, { x, y: hingeY1 }], closed: false, layer: L_VIEW, lw: 0.9, dash: HINGE_DASH });
  }
  // 高平齐：正视图上下边界 → 贯穿到内部图右侧
  for (const y of [fy, fy + H]) {
    hinge.push({
      k: 'poly',
      pts: [{ x: fx + W, y }, { x: ix0 + W, y }],
      closed: false,
      layer: L_VIEW,
      lw: 0.9,
      dash: HINGE_DASH,
    });
  }
  // 宽相等：俯视图深度基准线 → 侧视图深度基准线
  for (const y of [ty0, ty0 - D]) {
    hinge.push({
      k: 'poly',
      pts: [{ x: fx + W, y }, { x: fx + W + 420, y }],
      closed: false,
      layer: L_VIEW,
      lw: 0.9,
      dash: HINGE_DASH,
    });
  }

  // ═══════════════ 6. 尺寸标注与标题 ═══════════════
  const labels: Prim[] = [];
  const title = (x: number, y: number, s: string, size: number): void => {
    labels.push({ k: 'text', p: { x, y }, text: s, size, layer: L_TEXT, align: 'c' });
  };

  // 尺寸走布局器（防重叠）：意图只声明"测哪段、在哪侧、基础偏移"，具体层级由 DimLayout 定
  const dims = new DimLayout();
  // 正视图：总高（左侧）
  dims.add({ p0: { x: fx, y: fy }, p1: { x: fx, y: fy + H }, txt: `${H}`, orientation: 'v', side: 'left', baseOffset: 460, textOffset: 190, rot: 90 });
  // 俯视图：总宽（下方）+ 总深（右侧）
  dims.add({ p0: { x: fx, y: ty0 - D }, p1: { x: fx + W, y: ty0 - D }, txt: `${W}`, orientation: 'h', side: 'bottom', baseOffset: 620, textOffset: -170 });
  dims.add({ p0: { x: fx + W, y: ty0 }, p1: { x: fx + W, y: ty0 - D }, txt: `${D}`, orientation: 'v', side: 'right', baseOffset: 360, textOffset: 210, rot: 90 });
  // 侧视图：总深（下方）
  dims.add({ p0: { x: sx0, y: fy }, p1: { x: sx0 + D, y: fy }, txt: `${D}`, orientation: 'h', side: 'bottom', baseOffset: 460, textOffset: -170 });
  // 内部图：总宽（上方）
  dims.add({ p0: { x: ix0, y: fy + H }, p1: { x: ix0 + W, y: fy + H }, txt: `${W}`, orientation: 'h', side: 'top', baseOffset: 460, textOffset: 170 });
  // 内部图：各分区净宽尺寸链（上方第二层，chain 隔离不干扰总宽链）
  const dimRowCtxs = multiRow ? L.rows.map((_, ri) => ({ ctx: rowCtxs[ri]!, tag: `R${ri + 1} `, chain: `partition-R${ri + 1}`, base: 900 + ri * 400 })) : [{ ctx: rowCtxs[0]!, tag: '', chain: 'partition', base: 900 }];
  for (const { ctx, tag, chain, base } of dimRowCtxs) {
    for (let i = 0; i < ctx.units.length; i++) {
      const x0 = ctx.unitX0[i]!;
      const nw = ctx.nets[i]!;
      dims.add({
        p0: { x: ix0 + x0, y: fy + H },
        p1: { x: ix0 + x0 + nw, y: fy + H },
        txt: `${tag}${nw}`,
        orientation: 'h',
        side: 'top',
        chain,
        baseOffset: base,
        textOffset: 150,
      });
    }
  }
  dims.emit(labels);

  title(fx + W / 2, fy + H + 340, VIEW_NAME.front, 150);
  title(fx + W / 2, fy + H + 130, VIEW_NOTE.front, 95);
  title(sx0 + D / 2, fy + H + 340, VIEW_NAME.side, 150);
  title(sx0 + D / 2, fy + H + 130, VIEW_NOTE.side, 95);
  title(ix0 + W / 2, fy + H + 340, VIEW_NAME.internal, 150);
  title(ix0 + W / 2, fy + H + 130, VIEW_NOTE.internal, 95);
  title(fx + W / 2, ty0 - 200, VIEW_NAME.top, 150);
  title(fx + W / 2, ty0 - 410, VIEW_NOTE.top, 95);

  /**
   * 内部图下方那两句总览。
   *
   * 原来是一句 `内空 2364 × 2284mm　·　净宽分配 582 + 1164 + 582 = 2328`，
   * 居中摆在内部图下方 —— 实测宽 4094mm，比内部图（2400mm 宽）宽了近一倍，
   * 右端越出图幅 847mm。浏览器验收截图里能直接看到它被画布边缘切掉半截。
   * 拆成两行、右对齐到内部图右边界，和下面那行"主卧衣柜 2400 × 2400 × 600 mm"
   * 用同一个对齐基准。
   */
  labels.push({
    k: 'text',
    p: { x: ix0 + W, y: fy - 320 },
    text: `内空 ${innerW} × ${innerH}mm`,
    size: 120,
    layer: L_TEXT,
    align: 'r',
  });
  if (multiRow) {
    // 多行柜：净宽分配是**逐行**的（每行独立做水平分区）。
    // 把所有行的分配摊在一行里，会被读成"整柜只有这一条宽度链" —— 那正是 P1 要消灭的误读。
    L.rows.forEach((r, ri) => {
      labels.push({
        k: 'text',
        p: { x: ix0 + W, y: fy - 500 - ri * 190 },
        text: `R${ri + 1} 净宽 ${r.nets.join(' + ')} = ${r.netTotal}mm　·　净高 ${r.netH}mm`,
        size: 120,
        layer: L_TEXT,
        align: 'r',
      });
    });
  } else {
    labels.push({
      k: 'text',
      p: { x: ix0 + W, y: fy - 500 },
      text: `净宽分配 ${nets.join(' + ')} = ${nets.reduce((a, b) => a + b, 0)}mm`,
      size: 120,
      layer: L_TEXT,
      align: 'r',
    });
  }
  labels.push({
    k: 'text',
    p: { x: ix0 + W, y: ty0 - D - 1900 },
    text: `${cab.name}　${W} × ${H} × ${D} mm（宽 × 高 × 深）`,
    size: 180,
    layer: L_TEXT,
    align: 'r',
  });
  labels.push({
    k: 'text',
    p: { x: ix0 + W, y: ty0 - D - 2100 },
    text: '第一角投影（GB / ISO-E）· 长对正 · 高平齐 · 宽相等 · 模型空间 1:1',
    size: 105,
    layer: L_TEXT,
    align: 'r',
  });

  // ═══════════════ 7. 汇总 ═══════════════
  const assumptions = [
    '第一角投影（GB / ISO-E）：俯视图置于正视图正下方（长对正），侧视图置于正视图正右方（高平齐）。',
    `柜深 ${D}mm 含门板厚 ${t}mm：箱体结构板进深按 ${bodyD}mm 绘制，门 / 抽面占 Y ∈ ${faceY0}…${faceY1}。板件清单里箱体板的 width 目前取 params.depth，与本视图相差一个门厚 —— 这是 depth 语义的待确认点，不影响四视图之间的投影一致性。`,
    `踢脚板按「前挡板」处理（Y ∈ ${faceY0 - t}…${faceY0}）。规则集里没有踢脚内缩量，此取向需工厂确认。`,
    `层板后端紧贴背板前表面（Y = ${shelfY0}），进深取板件派生值 ${L.shelfDepth}mm（与板件清单严格一致），不画槽内装配间隙。`,
    shelfOverrun > 0
      ? `⚠ 层板前缘（Y=${shelfY1}）越过门 / 抽面内侧面（Y=${bodyD}）共 ${shelfOverrun}mm —— 规则集里 shelfFrontClearance=${p.shelfFrontClearance} 小于板厚 ${t}，参数之间真实矛盾。视图按派生值如实画出，未私自截断掩盖。`
      : '',
    '挂衣杆的进深位置模型未定义，按柜体进深中部绘制。',
    labelUnfitted.length > 0
      ? `⚠ 内部结构图有 ${labelUnfitted.length} 个板件名标签没能找到不重叠的位置（${labelUnfitted.join('、')}）—— 该视图的标注密度已超出可用空间。如实报出，不静默压字。`
      : '',
    '模型空间内不互相遮挡隐藏：板件按板厚分图层着色以表达结构层次，隐藏线（HIDDEN 线型）留到出图阶段处理。',
    (p.finishedEnds && p.finishedEnds !== 'none')
      ? `见光板（${p.finishedEnds === 'both' ? '左右两端' : p.finishedEnds === 'left' ? '左端' : '右端'}）：外露端板前缘做 R36 圆弧（侧视图近端角画出，前视图两端条带角画出）。它只是端板工艺表达，不改变结构板数量与尺寸。`
      : '',
    (L.rows.some((r) => r.units.some((u) => (u.shelves?.tilt ?? 0) > 0)))
      ? '斜层板：层板沿前立面倾斜，板件真实裁切长 = 水平跨度 ÷ cos(倾角)，四视图画成平行四边形（与销售图纸酒柜同款）。净宽分配仍按水平投影，倾斜不改变分区占用。'
      : '',
    multiRow
      ? `多行柜：rows[0] 在最上面（自上而下编号），每行的 Z 起点与净高由 layout 层确定，视图不再自行推算。行间贯通横隔板由**行边界**派生（位置 = 下一行顶面，跨度 = 内空宽，厚 ${t}mm），并已计入高度链 —— Σ行净高 + (行数−1)×板厚 = 内空高 ${innerH}mm。各行独立做水平分区（不跨行合并净宽），各行中立板只跨本行净高。`
      : '',
    DB
      ? `双面柜（岛台）：正视图 / 内部图为**前脸**；背面排（净宽 ${DB.backNets.join(' + ')} = ${DB.backNets.reduce((a, b) => a + b, 0)}mm）在正投影方向不可见，其门板与层板见俯视图（下方的背面脸带）、侧视图与板件清单。背立面外观图暂未单列。`
      : '',
    (L.rows.some((r) => r.units.some((u) => u.kind === 'appliance')) || (DB && cab.layout.backUnits!.some((u) => u.kind === 'appliance')))
      ? '电器格：虚线框为预留洞口（机器甲购，不进开料清单）；洞口上方的抽屉从过梁板之上排布，净高按"内空高 − 洞口高 − 板厚"计。'
      : '',
  ].filter((s) => s !== '');

  const allPts: Vec2[] = [];
  for (const k of VIEW_KINDS) for (const pr of prims[k]) allPts.push(...primPoints(pr));
  for (const pr of hinge) allPts.push(...primPoints(pr));
  for (const pr of labels) allPts.push(...primPoints(pr));
  const bbox: BBox = allPts.length ? bboxOf(allPts) : { min: { x: fx, y: fy }, max: { x: fx + W, y: fy + H } };

  const mkMeta = (kind: ViewKind, origin: Vec2, w: number, h: number): ViewMeta => {
    // 俯视图纵轴是翻转的（柜背在上），bbox 按实际落点算
    const minY = kind === 'top' ? origin.y - h : origin.y;
    return {
      kind,
      nameZh: VIEW_NAME[kind],
      note: VIEW_NOTE[kind],
      origin,
      w,
      h,
      bbox: { min: { x: origin.x, y: minY }, max: { x: origin.x + w, y: minY + h } },
    };
  };

  const meta: Record<ViewKind, ViewMeta> = {
    front: mkMeta('front', { x: fx, y: fy }, W, H),
    top: mkMeta('top', { x: fx, y: ty0 }, W, D),
    side: mkMeta('side', { x: sx0, y: fy }, D, H),
    internal: mkMeta('internal', { x: ix0, y: fy }, W, H),
  };

  return {
    cabinetId: cab.id,
    cabinetName: cab.name,
    prims,
    meta,
    hinge,
    labels,
    bbox,
    dims: { W, H, D },
    gaps,
    assumptions,
    pickLines,
  };

  /**
   * ── 电器图形（冰箱 / 洗衣机）—— 外观图与内部图**共用** ──
   *
   * 参考图 p4 洗衣机柜：外观正面图里明确画出圆形门、控制面板、观察窗。
   * 只画外框会让读图的人看不出这里放的是什么电器。
   *
   * 坐标一律用**柜体局部 (X, Z)** —— ViewPainter 的 rect/line/arc 内部已经带了
   * 这个视图的映射，调用方不该自己 map（第一版就是自己 map 才写成了 spread 数组）。
   */
  function drawApplianceGlyphs(P: ViewPainter): void {
    const LW = 1.1;
    for (const ctx of rowCtxs) {
      ctx.units.forEach((u, i) => {
        if (u.kind !== 'appliance' || !u.appliance) return;
        const a = u.appliance;
        const netW = ctx.nets[i]!;
        const x0 = ctx.unitX0[i]!;
        const ow = Math.min(a.openingWidth, netW);
        const ax0 = x0 + (netW - ow) / 2;
        const az = apertureZIn(ctx, u);
        if (!az) return;
        const oh = az.z1 - az.z0;
        if (oh < 200) return;

        if (oh >= 1200) {
          /* ── 冰箱：外框 + 中缝（对开门）+ 上下门分界 + 两个竖向把手 ── */
          P.rect(ax0, ax0 + ow, az.z0, az.z1, L_HW, LW);
          P.line(ax0 + ow / 2, ax0 + ow / 2, az.z0, az.z1, L_HW, LW);
          const splitZ = az.z0 + oh * 0.62;
          P.line(ax0, ax0 + ow, splitZ, splitZ, L_HW, LW);
          const hW = 24;
          const hGap = ow * 0.06;
          P.rect(ax0 + ow / 2 - hGap - hW, ax0 + ow / 2 - hGap, az.z0 + oh * 0.3, az.z0 + oh * 0.55, L_HW, LW);
          P.rect(ax0 + ow / 2 + hGap, ax0 + ow / 2 + hGap + hW, az.z0 + oh * 0.3, az.z0 + oh * 0.55, L_HW, LW);
        } else {
          /* ── 洗衣机：外框 + 控制面板 + 圆形观察窗 + 下方检修门 ── */
          P.rect(ax0, ax0 + ow, az.z0, az.z1, L_HW, LW);
          const panelTop = az.z1 - 20;
          const panelBot = az.z0 + oh * 0.76;
          if (panelTop - panelBot > 40) {
            P.line(ax0, ax0 + ow, panelBot, panelBot, L_HW, LW);
            const kz = (panelTop + panelBot) / 2;
            const kr = Math.min(26, (panelTop - panelBot) * 0.3);
            // 面板旋钮（两个圆）—— 用 arc 画在局部坐标
            for (const f of [0.22, 0.42]) {
              P.arc(ax0 + ow * f, kz, kr, 0, Math.PI * 2, L_HW, LW);
            }
            P.rect(ax0 + ow * 0.6, ax0 + ow * 0.92, panelBot + 8, panelTop - 8, L_HW, LW);
          }
          const cz = az.z0 + oh * 0.42;
          const outerR = Math.min(ow, oh * 0.62) * 0.34;
          if (outerR > 30) {
            P.arc(ax0 + ow / 2, cz, outerR, 0, Math.PI * 2, L_HW, 1.4);
            P.arc(ax0 + ow / 2, cz, outerR * 0.78, 0, Math.PI * 2, L_HW, LW);
            // 窗内一道斜反光（参考图里也有）
            P.line(ax0 + ow / 2 - outerR * 0.5, ax0 + ow / 2 + outerR * 0.5, cz - outerR * 0.5, cz + outerR * 0.5, L_HW, LW);
          }
          const dz0 = az.z0 + oh * 0.08;
          const dz1 = az.z0 + oh * 0.22;
          if (dz1 - dz0 > 20) {
            P.rect(ax0 + ow * 0.38, ax0 + ow * 0.62, dz0, dz1, L_HW, LW);
            P.arc(ax0 + ow * 0.5, (dz0 + dz1) * 0.55, Math.max(6, outerR * 0.08), 0, Math.PI * 2, L_HW, LW);
          }
        }
      });
    }
  }


  function drawLifestyleItems(P: ViewPainter): void {
    // 包柱柜：内空整块被柱子占了，没有地方放被子/折衣/挂衣 —— 画上去等于告诉客户"里面能储物"
    if (p.columnWrap) return;
    const LW = 0.7;
    // 柜体是否算"高柜"（衣柜/顶柜语境）：总高 ≥ 1800
    const isTallCab = H >= 1800;
    // 是否算"矮柜"（餐边柜/阳台柜语境）：总高 < 1200
    const isLowCab = H < 1200;

    rowCtxs.forEach((ctx) => {
      const rowZ0 = ctx.z0;
      const rowNH = ctx.netH;

      ctx.units.forEach((u, i) => {
        const x0 = ctx.unitX0[i]!;
        const netW = ctx.nets[i]!;
        if (netW < 150) return; // 太窄不画，避免糊成一团

        // ── 1. 挂衣区：衣服挂在杆上（衣架 + 衣服轮廓，与参考图同款）──
        if (u.rod && u.rod.count > 0) {
          // ★ 用派生后的有效杆高（离顶板 rodTopGap），不是 authored 原值。
          const rodZ = rowZ0 + effectiveRodZ(u, rowNH, rules);
          const isLong = rowNH >= 1200; // 长衣/短衣按净高区分
          /**
           * ── 为什么改成"按可用宽度铺满" ──
           *
           * ★ 修的是"悬浮感"（用户实测反馈）：上一版固定画 2-3 件、间距按
           *   `netW*(k+1)/(n+1)` 均分，于是宽格子里衣服稀稀拉拉挂在中间，
           *   两边大片空白 —— 看起来像飘在空中，而不是挂在杆上。
           *
           * 参考图 p5 的做法：衣服**沿杆排满**，件与件之间只留一个衣架的间隙。
           *
           * 做法：先定单件占宽（肩宽 × 间距系数），再用它反算件数，上限 6 件。
           */
          /**
           * 件数与单件宽度 —— 按参考图 p5 **实测像素**标定。
           *
           * 参考图：778 宽的挂衣格里排 **3 件**，每件肩宽约 210mm（半宽 105），
           * 件间净距约 50mm ⇒ 单件占宽约 260mm ⇒ slotW = 260。
           *
           * 上一版用 2.4×半肩宽 = 288，floor(776/288) 只能排 2 件；
           * 且每件被拉宽到 240（比参考图宽），整排只占中间一段、两边空着
           * —— 观感就是"飘着"。现在 776/260 = 2（仍不足 3）……
           * 所以再放宽一档：按 netW/4 与 260 取小，保证窄格也排得下。
           */
          const slotW = Math.min(260, netW / 4);
          const n = Math.max(2, Math.min(6, Math.floor(netW / slotW)));
          const garmentHalfW = Math.min(110, slotW * 0.42);
          /**
           * ★★ 衣服**向下**挂（2026-10-22 按参考图纸《世园润府18-1502》实测修正）。
           *
           *   历史缺陷：这一块把衣服画在杆的**上方**（rodZ+80 起、再 +garmentH 往上长），
           *   于是图上衣服"立在挂衣杆上" —— 用户一眼看出不对。
           *   CAD 坐标系 +Y 向上（见 VariantPanel.tsx 的 scale(1,-1) 说明），
           *   所以"从杆往上"就是"衣服浮在杆之上"，与真实挂法相反。
           *
           *   参考图 p5 实测画法（自杆向下量）：
           *     杆下 0→衣架钩竖杆       约 60mm
           *     衣架肩线（V 形）        再向下约 90mm
           *     衣服本体                从肩线垂下，长衣 ~900 / 短衣 ~600
           *   全部向下展开，杆以上只剩被褥格。
           */
          const hookLen = Math.min(60, rowNH * 0.03);
          const shoulderDrop = Math.min(90, rowNH * 0.045);
          // 杆下方可用高度：留出杆下的钩 + 肩线，再给下沿 50mm 不碰底
          const availBelow = (rodZ - rowZ0) - hookLen - shoulderDrop - 50;
          const garmentH = Math.max(0, isLong ? Math.min(900, availBelow) : Math.min(600, availBelow));
          if (garmentH > 200) {
            const actualSlot = netW / n;
            for (let k = 0; k < n; k++) {
              // 居中在各自槽位里 —— 这样整排从格左铺到格右，不再挤在中间
              const hx = x0 + actualSlot * (k + 0.5);
              // 肩半宽占槽位的 40%（参考图比例），但不超 garmentHalfW
              const hw = Math.min(garmentHalfW, actualSlot * 0.4);
              // ① 衣架钩：杆上一个小圆弧（参考图里钩子是半圆扣在杆上）
              P.arc(hx, rodZ + 4, Math.min(22, hw * 0.35), 0, Math.PI, L_HW, LW);
              // ② 钩向下接竖杆
              P.line(hx, hx, rodZ, rodZ - hookLen, L_HW, 1.0);
              // ③ 衣架肩线：从竖杆底部分别向左下、右下张开（V 形）
              const shoulderZ = rodZ - hookLen - shoulderDrop;
              P.line(hx, hx - hw, rodZ - hookLen, shoulderZ, L_HW, LW);
              P.line(hx, hx + hw, rodZ - hookLen, shoulderZ, L_HW, LW);
              /**
               * ④ 衣服本体（西装外套轮廓）—— 按参考图纸《世园润府18-1502》p5 实测。
               *
               *   参考图不是简单梯形，而是一件**西装上衣**，特征自上而下：
               *     · 斜肩：肩线从领口向外下方倾斜
               *     · 翻领：领口左右两片斜线交成 V（图中清晰可见）
               *     · 袖子：两侧有竖向内轮廓线，把袖子和衣身分开
               *     · 口袋：右下侧一个小方巾形 + 5 个小圆点（纽扣）
               *   下摆略收窄，长度按长衣/短衣。
               */
              const hemZ = shoulderZ - garmentH;
              const hemHW = hw * 0.92;
              // 斜肩：肩点比领口低一点，形成西装肩线
              const shoulderDropPx = Math.min(garmentH * 0.06, 40);
              const collarW = hw * 0.22;
              // 主体外形（肩 → 袖 → 下摆）
              P.poly(
                [
                  { x: hx - hw, y: shoulderZ - shoulderDropPx },
                  { x: hx - collarW, y: shoulderZ },
                  { x: hx + collarW, y: shoulderZ },
                  { x: hx + hw, y: shoulderZ - shoulderDropPx },
                  { x: hx + hemHW, y: hemZ },
                  { x: hx - hemHW, y: hemZ },
                ],
                L_HW,
                LW,
                true
              );
              // 翻领 V（领口两片）
              const lapelBottom = shoulderZ - garmentH * 0.22;
              P.line(hx - collarW, hx, shoulderZ, lapelBottom, L_HW, LW * 0.9);
              P.line(hx + collarW, hx, shoulderZ, lapelBottom, L_HW, LW * 0.9);
              // 袖子内轮廓（左右各一道竖线，略内收）
              const sleeveInset = hw * 0.34;
              P.line(hx - sleeveInset, hx - sleeveInset, shoulderZ - shoulderDropPx * 1.6, hemZ + garmentH * 0.12, L_HW, LW * 0.8);
              P.line(hx + sleeveInset, hx + sleeveInset, shoulderZ - shoulderDropPx * 1.6, hemZ + garmentH * 0.12, L_HW, LW * 0.8);
              // 口袋方巾 + 纽扣（只在够高的衣服上画，避免糊成一团）
              if (garmentH > 420) {
                const pkZ = hemZ + garmentH * 0.22;
                P.line(hx + hw * 0.18, hx + hw * 0.62, pkZ, pkZ + garmentH * 0.05, L_HW, LW * 0.8);
                for (let bi = 0; bi < 5; bi++) {
                  const bz = pkZ - garmentH * 0.04 - bi * garmentH * 0.035;
                  P.arc(hx + hw * 0.42, bz, Math.max(2.5, hw * 0.035), 0, Math.PI * 2, L_HW, LW * 0.7);
                }
              }
            }
          }
        }

        // ── 2. 叠放区：层板上画 2-3 条横线表示叠放衣物（无杆的层板格）──
        if (u.shelves && u.shelves.count > 0 && !(u.rod && u.rod.count > 0)) {
          const positions = equalSpacing(rowNH, u.shelves.count);
          /**
           * 叠放区画"折好的衣服"，不是三条横线。
           *
           * 参考图《世园润府》p5：每层板上并排 2~3 件折衣，每件是**上宽下窄的叶形**
           * （折边在中间），内部两道斜纹表示厚度。三条裸横线看着像"层板画多了"。
           *
           * 尺寸跟层间净空走：净空小就不画（画进去反而糊成一团）。
           */
          const stackCount = Math.min(3, positions.length);
          for (let s = 0; s < stackCount; s++) {
            const shelfZ = rowZ0 + positions[s]! + t; // 层板顶面
            const nextShelfZ = s + 1 < positions.length ? rowZ0 + positions[s + 1]! : rowZ0 + rowNH;
            const room = nextShelfZ - shelfZ - 20;
            const foldH = Math.min(52, room * 0.35);
            if (foldH < 24) continue;
            const itemW = Math.min(120, netW / 3.2);
            const gapW = itemW * 0.18;
            const n = Math.max(2, Math.min(3, Math.floor(netW / (itemW + gapW))));
            const rowW = n * itemW + (n - 1) * gapW;
            const startX = x0 + (netW - rowW) / 2;
            for (let k = 0; k < n; k++) {
              const ix = startX + k * (itemW + gapW);
              const iz = shelfZ + 6;
              const ix1 = ix + itemW;
              const iz1 = iz + foldH;
              // 折衣叶形：上下边略收，左右在 55% 高处外凸（折边）
              P.poly([
                { x: ix + itemW * 0.12, y: iz },
                { x: ix1 - itemW * 0.12, y: iz },
                { x: ix1, y: iz + foldH * 0.55 },
                { x: ix1 - itemW * 0.12, y: iz1 },
                { x: ix + itemW * 0.12, y: iz1 },
                { x: ix, y: iz + foldH * 0.55 },
              ], L_HW, LW, true);
              // 两道折纹 = 厚度
              P.line(ix + itemW * 0.2, ix1 - itemW * 0.2, iz + foldH * 0.34, iz + foldH * 0.34, L_HW, LW * 0.7);
              P.line(ix + itemW * 0.2, ix1 - itemW * 0.2, iz + foldH * 0.68, iz + foldH * 0.68, L_HW, LW * 0.7);
            }
          }
          /**
           * 顶柜（高处层板格）：被子 + 枕头示意。
           *
           * ── 对标参考图《世园润府》的画法 ──
           *   被子 = **圆角矩形**（横向长条），内部再画一条同形状的内轮廓线，
           *          表示"叠好的被子有厚度、有折边"；
           *   枕头 = 竖立的**圆弧三角**（三个小尖），摆在被子右侧。
           *   整组左右排开：1-2 条被子 + 2-3 个枕头。
           *
           * ── 为什么不用矩形 + 一道横线 ──
           *   上一版画的是"矩形 + 中线"。参考图里被子是**双层轮廓的圆角条**，
           *   一眼能看出是叠起来的被褥；单层矩形看起来像个抽屉。
           */
          /**
           * 触发的判据：**柜内顶部的那一格**才画被子。
           *
           * ★ 修的是一个实测 bug（2026-10-21）：
           *   原来写的是 `rowZ0 > 1500` —— 对**单行柜**（rows 只有一行）来说
           *   rowZ0 恒为 0（内空底），这条永远为假 ⇒ 顶柜的被子从来没画出来过。
           *   只有在"多行柜 + 上面那行"时才碰巧成立。
           *
           * 现在按"这一格的顶部是否接近柜内顶"判断，与行数无关：
           *   rowZ0 + rowNH 距柜内顶部 100mm 以内 ⇒ 这是最上面那格 ⇒ 画被子。
           * 同时保留 isTallCab（矮柜/餐边柜不画被褥）。
           */
          const isTopCompartment = rowZ0 + rowNH >= H - t - 100;
          if (isTallCab && isTopCompartment) {
            const availH = Math.min(220, rowNH - 40);
            if (availH > 80) {
              const quiltW = Math.min(360, netW * 0.55);
              const quiltH = Math.min(availH * 0.45, 90);
              const leftX = x0 + 20;
              /**
               * 被子摆在**这一格的顶部**，不是底部。
               *
               * 坐标系 Y 轴向上 ⇒ "格子的上方"是 rowZ0 + rowNH 那一侧。
               * 第一版写成 rowZ0 + 20（贴着格底），实测渲染出来被子掉到了柜子最下面。
               */
              const baseZ = rowZ0 + rowNH - 20 - (quiltH * 2 + 6);
              // 被子：两条叠放（上短下长），每条都是双层圆角轮廓
              const drawQuilt = (qx: number, qz: number, w2: number, h2: number): void => {
                const r = Math.min(28, h2 * 0.45);
                // 外轮廓（圆角矩形）
                P.poly([
                  { x: qx + r, y: qz }, { x: qx + w2 - r, y: qz },
                  { x: qx + w2, y: qz + r }, { x: qx + w2, y: qz + h2 - r },
                  { x: qx + w2 - r, y: qz + h2 }, { x: qx + r, y: qz + h2 },
                  { x: qx, y: qz + h2 - r }, { x: qx, y: qz + r },
                ], L_HW, LW, true);
                // 内轮廓（留 8mm 边，表示折边）
                const ir = Math.max(6, r - 8), ix = qx + 8, iz = qz + 8;
                const iw = w2 - 16, ih = h2 - 16;
                if (iw > 20 && ih > 12) {
                  P.poly([
                    { x: ix + ir, y: iz }, { x: ix + iw - ir, y: iz },
                    { x: ix + iw, y: iz + ir }, { x: ix + iw, y: iz + ih - ir },
                    { x: ix + iw - ir, y: iz + ih }, { x: ix + ir, y: iz + ih },
                    { x: ix, y: iz + ih - ir }, { x: ix, y: iz + ir },
                  ], L_HW, LW, true);
                }
              };
              drawQuilt(leftX, baseZ, quiltW, quiltH);
              drawQuilt(leftX, baseZ + quiltH + 6, quiltW * 0.85, quiltH);
              // 枕头：右侧竖立的圆弧三角（参考图里是三个小尖并排）
              const pillowX = leftX + quiltW + 16;
              const pillowW = Math.min(220, netW - (pillowX - x0) - 20);
              if (pillowW > 60) {
                const pn = Math.min(3, Math.max(2, Math.floor(pillowW / 60)));
                const pw = pillowW / pn;
                for (let pi = 0; pi < pn; pi++) {
                  const px = pillowX + pi * pw;
                  const ph = Math.min(quiltH * 2 + 6, availH);
                  // 枕头 = 三条弧线构成的"竖立软包"轮廓
                  P.line(px + pw * 0.15, px + pw * 0.5, baseZ, baseZ + ph * 0.85, L_HW, LW);
                  P.line(px + pw * 0.5, px + pw * 0.85, baseZ + ph * 0.85, baseZ, L_HW, LW);
                  P.line(px + pw * 0.15, px + pw * 0.85, baseZ, baseZ, L_HW, LW);
                }
              }
            }
          }
        }

        // ── 3. 电器位：冰箱 / 洗衣机轮廓 ──
        if (u.kind === 'appliance' && u.appliance) {
          const a = u.appliance;
          const ow = Math.min(a.openingWidth, netW);
          const ax0 = x0 + (netW - ow) / 2;
          const az = apertureZIn(ctx, u);
          if (az) {
            const oh = az.z1 - az.z0;
            if (oh >= 1200) {
              // 冰箱：外框 + 中线（对开门）+ 上下门缝线
              P.rect(ax0, ax0 + ow, az.z0, az.z1, L_HW, LW);
              P.line(ax0 + ow / 2, ax0 + ow / 2, az.z0, az.z1, L_HW, LW);
              P.line(ax0, ax0 + ow, az.z0 + oh * 0.65, az.z0 + oh * 0.65, L_HW, LW);
            } else {
              // 洗衣机：外框 + 圆形门
              P.rect(ax0, ax0 + ow, az.z0, az.z1, L_HW, LW);
              const cx = ax0 + ow / 2;
              const cy = (az.z0 + az.z1) / 2;
              const r = Math.min(ow, oh) * 0.28;
              if (r > 30) {
                P.arc(cx, cy, r, 0, Math.PI * 2, L_HW, LW);
              }
            }
          }
        }

        // ── 4. 餐边柜开放格：酒瓶 / 摆件示意（矮柜 + 开放格 + 无电器）──
        if (isLowCab && !u.doors && !u.drawers && u.kind !== 'appliance' && u.shelves && u.shelves.count > 0) {
          const positions = equalSpacing(rowNH, u.shelves.count);
          if (positions.length > 0) {
            const shelfZ = rowZ0 + positions[0]! + t;
            // 画 2 个酒瓶：瓶身矩形 + 瓶颈
            const n = Math.min(2, Math.max(1, Math.floor(netW / 250)));
            for (let b = 0; b < n; b++) {
              const bx = x0 + (netW * (b + 1)) / (n + 1);
              const bodyW = 55;
              const bodyH = 170;
              const neckW = 20;
              const neckH = 70;
              const bz0 = shelfZ;
              // 瓶身
              P.rect(bx - bodyW / 2, bx + bodyW / 2, bz0, bz0 + bodyH, L_HW, LW);
              // 瓶颈
              P.rect(bx - neckW / 2, bx + neckW / 2, bz0 + bodyH, bz0 + bodyH + neckH, L_HW, LW);
            }
          }
        }
      });
    });
  }

  // ── 正视图 / 内部图共用的箱体绘制（两者方向完全相同，只差门 / 抽面画不画）──
  function drawFrontLike(P: ViewPainter, withFronts: boolean): void {
    const hidden = withFronts ? undefined : HIDDEN_DASH;

    // 电器柜（冰箱等嵌入式电器）：只画最外框线表示嵌入位置，不画任何板件线，前面完全敞开
    // 用户反馈：冰箱外面不应有柜子包住
    const isApplianceCab = applianceOnly;
    if (isApplianceCab) {
      P.rect(0, W, 0, H, L_VIEW, 1);
    } else {
    // 箱体骨架（外框）两种图都画 —— 这是同一个柜子
    P.rect(t, W - t, 0, bodyLift, layerOfThickness(t), 1); // 踢脚板
    P.rect(0, t, bodyLift, H, layerOfThickness(t), 1); // 左侧板
    P.rect(W - t, W, bodyLift, H, layerOfThickness(t), 1); // 右侧板
    P.rect(t, W - t, H - t, H, layerOfThickness(t), 1); // 顶板
    P.rect(t, W - t, bodyLift, bodyLift + t, layerOfThickness(t), 1); // 底板

    // ── 见光板 R36 前缘圆弧（Phase E 表达异形）──
    // 外露端板的前缘（顶部）做 R36 圆弧：在端板条带的上端角画四分之一圆弧。
    // 左端板在 (t, H) 角、右端板在 (W-t, H) 角；前视图能同时看到两端，
    // 因此左右见光板都在这里表达（侧视图只画近端的那一块，见下方侧视图）。
    // feFront / R36 已提升到 buildCabinetViews 外层作用域，此处直接复用。
    if (feFront === 'left' || feFront === 'both') {
      P.arc(t, H, R36, Math.PI, Math.PI * 1.5, layerOfThickness(t), 1.2); // 左上角圆弧向左上
    }
    if (feFront === 'right' || feFront === 'both') {
      P.arc(W - t, H, R36, Math.PI * 1.5, Math.PI * 2, layerOfThickness(t), 1.2); // 右上角圆弧向右上
    }
    } // end else: 非电器柜才画板件骨架

    /**
     * ── 正视图是【门板图】，不是"结构图加门"（一次真实缺陷的修正）──
     *
     * 行业图纸（销售设计图）的正立面外观图，有门的地方只画【整块门板 +
     * 开向对角线】，开放格才透出内部层板。此前正视图把层板 / 中立板 /
     * 门板全部叠画在一张图上 —— 小隔层的门被内部线切成"多块板件"，
     * 客户看图会以为门是拼的。修正规则（对照销售图纸的标准画法）：
     *   · 有门的分区：只画整块门板 + 开向线，内部一概不透；
     *   · 有抽的分区：画抽面（抽屉本来就是一格一面）；
     *   · 开放分区（无门无抽）：画层板 / 挂衣杆 —— 外观图上它们真的可见；
     *   · 中立板：只画在两侧都是开放区的位置（被门挡住的不画）。
     * 内部结构图（withFronts=false）维持原样：去掉门板，结构全画。
     */
    /**
     * ── 行（canonical）：按行绘制，行内零特判 ──
     *
     * 这里只读 `L.rows`（layout 层已经消化过"文件里存的是 rows 还是 units"）。
     * 单行柜 `rowCtxs` 恰好一项，且 `z0 === innerBottomZ`、`netH === innerH`、
     * `unitX0 / nets` 与 `L.unitX0 / L.nets` 逐位相同 → 每条图元与 v0.2 完全一致。
     * 多行柜只是外层多迭代一次，**没有任何 `if (rows)` 分支**。
     */
    rowCtxs.forEach((ctx) => {
      const rowZ0 = ctx.z0;
      const rowNH = ctx.netH;

      ctx.units.forEach((u, i) => {
        const x0 = ctx.unitX0[i]!;
        const netW = ctx.nets[i]!;
        const openUnit = !u.doors && !u.drawers; // 开放格：外观图上能看见内部

        // 层板：只在内部图，或门板图的开放格里画。行内层板按**本行净高**均分。
        // 包柱柜内空被柱子占住 → 一块层板都排不了（否则层板线穿过柱体，图上是错的）
        if (u.shelves && u.shelves.count > 0 && !p.columnWrap && (!withFronts || openUnit)) {
          const s = shelfSpanXIn(ctx, i);
          const tilt = u.shelves.tilt ?? 0;
          const span = s.b - s.a;
          // 斜层板（Phase E 图元扩展）：右端按 tan(tilt) 下沉，画成平行四边形。
          // tilt=0 时 shift=0 → 退化为普通矩形，与旧行为一致（不留隐式分支）。
          const shift = tilt > 0 ? Math.round(span * Math.tan((tilt * Math.PI) / 180)) : 0;
          equalSpacing(rowNH, u.shelves.count).forEach((pos) => {
            const yb = rowZ0 + pos;
            /**
             * ── 灯带（2026-10-21，对标参考图纸《世园润府》）──
             *
             * ★ 之前灯带**只进清单、不进图纸** ──
             *   `ledStrip` 字段一直只影响生成的 HW_LED_* 五金件，
             *   图纸上一个符号都没有 —— 客户拿到图不知道灯带装在哪。
             *
             * ★ 参考图纸的实测画法（PDF 内容流）──
             *   · **靠前 front**：层板前缘下侧一条灯带槽，画成**双线**
             *       实测（p5）：层板占 y19558..19594（板厚 36），
             *       灯带槽双线在 y19522 与 y19533（间距 11，= 槽壁厚），
             *       位置在层板**下方**（y 更小 = 更靠观察者 = 前缘）。
             *   · **居中 center**：层板**中间**两条单线，间距 82
             *       实测（p2）：y18164 与 y18246。
             *   · **45°斜光 angled45**：一条 45° 斜线 + 一条水平线
             *       实测（p6）：(30814,17210)→(31787,19003) 斜线 +
             *       y19003 的水平线。
             *
             * ★ 画在哪张图 ──
             *   灯带是**内部可见**的（开放格才看得见），
             *   所以只在开放格（无门无抽）画。
             */
            const ledStyle = u.shelves?.ledStrip ?? 'none';
            if (ledStyle !== 'none' && openUnit) {
              drawLedStrip(P, s.a, s.b, yb, t, ledStyle);
            }
            if (shift > 0) {
              P.poly(
                [
                  { x: s.a, y: yb },
                  { x: s.b, y: yb - shift },
                  { x: s.b, y: yb - shift + t },
                  { x: s.a, y: yb + t },
                ],
                layerOfThickness(t),
                1,
                true
              );
            } else {
              P.rect(s.a, s.b, yb, yb + t, layerOfThickness(t), 1);
            }
          });
        }

        // 抽面：一格一面，两种图都画（内部图弱化线宽）。抽面高度按**本行净高**排。
        if (u.drawers) {
          const d = u.drawers;
          const cellH = drawerCellHeights(u, rowNH, rules);
          let z = rowZ0 + d.gap;
          let cellIdx = 0;
          for (const ch of cellH) {
            const isFirstCell = cellIdx === 0;
            cellIdx++;
            const fx0 = x0 + d.gap;
            const fx1 = x0 + netW - d.gap;
            P.rect(fx0, fx1, z, z + ch, L_FRONT, withFronts ? 1.8 : 1.2, hidden);
            /**
             * ── 格子抽：抽面内画一排折线小格（2026-10-21，对标参考图纸）──
             *
             * ★ 参考图纸的真实画法（从 PDF 内容流实测，非目测）──
             *   格子抽不是「若干个小方框」，而是**一条连续折线**：
             *   从抽面左上角出发，6 条等角度斜线（±24.5°）等距排布，
             *   水平中心落在归一化的 0.025 / 0.25 / 0.475 / 0.525 / 0.75 / 0.975，
             *   中间两条在**底边**相接形成一个谷底 —— 整体像一个「山」字。
             *
             *   实测坐标（PDF 单位）：
             *     (0.000,1.000)→(0.051,0.899)   (0.200,0.601)→(0.300,0.401)
             *     (0.449,0.103)→(0.500,0.000)   (0.500,0.000)→(0.551,0.103)
             *     (0.700,0.401)→(0.800,0.601)   (0.949,0.899)→(1.000,1.000)
             *
             * ★ 为什么要照抄这个形状 ──
             *   画成「小方框阵列」客户会以为是一排小门；
             *   照抄折线，客户和车间一眼就认出是格子抽。
             *
             * ★ 折线只画在**最上面那一格** ──
             *   参考图里格子抽是一个**独立的功能区**（高 681，占整格 1/3），
             *   不是「每个抽屉都画折线」。这里按同样口径：
             *   格子抽分区的**每个抽格**都画一组折线（一个分区一个格子抽位），
             *   高度取该抽格高度的 1/3 —— 与参考图的比例一致。
             */
            if (d.style === 'grid' && isFirstCell) {
              /**
               * 格子抽的折线区：**整个分区画一组**，不是每抽格一组。
               *
               * ★ 为什么 ──
               *   参考图纸里格子抽是一个**独立的功能区**（宽 2988、高 681），
               *   折线**横跨 3 个抽格**，抽面板（高 82）画在折线区**上面**。
               *   逐抽格画折线会变成「3 组小山」，和参考图完全不是一回事。
               *
               * ★ 高度怎么定 ──
               *   实测折线区高 681 / 宽 2988 = 0.228，
               *   且短段 dx/dy = 152/70 ≈ 2.17（角度 24.5°）。
               *   本实现的归一化步长是 dx=0.05w、dy=0.1h，
               *   要得到同样的角度就需要 h ≈ 0.23w —— 正好与实测一致。
               *   所以直接按 **0.23 × 分区宽** 给高，角度自然对上。
               *
               * ★ 高度上限 ──
               *   窄分区（0.23w 会超过抽格高）时压到抽格高，
               *   保证折线不会跑到抽格外面去。
               */
              const idealH = (fx1 - fx0) * 0.23;
              const gridH = Math.min(idealH, ch);
              drawGridDrawerFront(P, fx0, fx1, z, z + gridH);
            }
            z += ch + d.gap;
          }
        }

        /**
         * ── 裤架：挂衣区下方一排倒 V 形挂钩（2026-10-21，对标参考图纸）──
         *
         * ★ 参考图纸的真实画法（PDF 内容流实测）──
         *   裤架 = 一根横杆 + 杆下挂一串 **∨ 形**挂钩：
         *     (28062,15026)→(28214,14956)  dx=152 dy=-70
         *     (28214,14956)→(28366,15026)  dx=152 dy=+70
         *   即：顶点**朝上**挂在杆上（顶点正好在杆的 y 上），
         *   两侧等长（167），水平跨距 304。
         *
         * ★ 为什么顶点朝上 ──
         *   裤架是横杆 + 挂钩，挂钩从杆上垂下来；
         *   画成 ∧（顶点朝上）读图方向是反的，
         *   客户会以为那是「撑杆」而不是挂钩。
         *
         * ★ 位置 ──
         *   裤架在挂衣区**底部**（挂裤子不需要挂衣杆那么高），
         *   挂衣杆在上方，所以这里画在分区下缘。
         */
        // 裤架只在**内部结构图**画：外面是门板/抽面，看不到里面的五金。
        // 参考图 p5 的裤架画在衣柜的内部结构图里。
        if (u.trouserRack === true && !withFronts) {
          drawTrouserRack(P, x0, x0 + netW, rowZ0);
        }

        // 门板：整块 + 开向对角线（行业画法）。门板高度按**本行净高**排。
        // 2026-10-04：appliance（冰箱等嵌入式电器）不画门板，前面敞开
        if (u.doors && u.kind !== 'appliance') {
          const dr = u.doors;
          const widths = doorWidths(u, netW, rules);
          // 玻璃门：材质 kind='glass' → 门板图画「黑框灰玻」斜线填充（销售图纸同款）
          const isGlass = dr.material ? rules.materials[dr.material]?.kind === 'glass' : false;
          let x = x0 + dr.gapOuter;
          for (let k = 0; k < widths.length; k++) {
            const w = widths[k];
            const left = x;
            const right = x + w;
            const zTop = rowZ0 + dr.gapOuter;
            const zBot = rowZ0 + rowNH - dr.gapOuter;
            P.rect(left, right, zTop, zBot, L_FRONT, withFronts ? 1.8 : 1.2, hidden);

            /**
             * 拉手符号（对标生产图纸）。
             * 每扇门配 HW_HANDLE_128（见 generate.ts），图上画 96mm 长小矩形，
             * 距开门侧门边 50mm，竖向居中。只在外观图画（withFronts）。
             * 免拉手工艺暂无模型字段，全部门默认画拉手。
             */
            if (withFronts) {
              const HANDLE_LEN = 96;
              const HANDLE_W = 18;
              const HANDLE_EDGE = 50;
              // 开门侧：单扇按 hingeSide；双扇对开时左扇右手、右扇左手（中间相遇）
              let handleX: number;
              if (widths.length === 2) {
                handleX = k === 0 ? right - HANDLE_EDGE - HANDLE_W : left + HANDLE_EDGE;
              } else {
                const hingeLeft = (dr.hingeSide ?? 'left') === 'left';
                handleX = hingeLeft ? right - HANDLE_EDGE - HANDLE_W : left + HANDLE_EDGE;
              }
              const handleZ = (zTop + zBot) / 2 - HANDLE_LEN / 2;
              P.rect(handleX, handleX + HANDLE_W, handleZ, handleZ + HANDLE_LEN, L_HW, 1.2);
            }

            if (withFronts && isGlass) {
              // 灰玻的低透明填充（斜纹在下方 drawSwing 之前画，避免重复）
              P.fillRect(left, right, zTop, zBot, L_FRONT, 0.12);
            }

            if (withFronts) {
              /**
               * ══════════════════════════════════════════════════════════
               *  门板开向符号 —— 对标参考图纸《世园润府》的行业画法
               *
               * ── 参考图里到底是什么样（逐像素核过 PDF 线段坐标）──
               *   每一扇门内，从**铰链边**向对侧画一组**虚线**，呈 `<` 或 `>` 形：
               *     · 铰链在左 ⇒ 门向左开 ⇒ 两条虚线从左上、左下角汇到右边中点，形如 `>`
               *     · 铰链在右 ⇒ 门向右开 ⇒ 两条虚线从右上、右下角汇到左边中点，形如 `<`
               *   即「尖头指向铰链边，开口朝自由边」—— 尖的那一端就是铰链。
               *
               * ── 为什么不是原来的 X 对角线 ──
               *   上一版画的是门板对角 X（两条实线交叉）+ 竖向虚线箭头。
               *   实测与参考图**完全不是一回事**：参考图从不画 X，也从不画箭头，
               *   只有一组开向虚线。X 线会让读图的人以为门是对角切开的。
               *
               * ── 虚线要铺满门板 ──
               *   参考图里这组虚线从门的一个角一直走到对角，跨满整块门板。
               *   （用户明确要求：全部虚线铺满门板）
               * ══════════════════════════════════════════════════════════
               */
              /**
               * 虚线节奏 —— 与参考图对齐。
               *
               * 参考图实测：段长约 55–90 单位、间隔约 45 单位（PDF 单位）。
               * 本系统 1 单位 = 1mm，门高 1880mm，所以用 [90, 50] 大约得到 13 段，
               * 与参考图里一扇 2280mm 高的门上的段数相当。
               *
               * 第一版用了 [140, 90]，段太长间隔太大 —— 在小尺寸门板上会退化成
               * "只有一两条线"的观感（实测渲染出来像只画了一条）。
               */
              const swingDash = [90, 50];
              /**
               * 画一扇门的开向符号。
               * @param l 门左边 x
               * @param rr 门右边 x
               * @param t 门顶 z
               * @param b 门底 z
               * @param hingeLeft true = 铰链在左（尖头朝左）
               */
              const drawSwing = (l: number, rr: number, t: number, b: number, hingeLeft: boolean): void => {
                const midZ = (t + b) / 2;
                if (hingeLeft) {
                  // 铰链在左 ⇒ 尖头在左 ⇒ 两条线从左中出发，分别到右上、右下（形如 >）
                  P.line(l, rr, midZ, t, L_FRONT, 0.9, swingDash);
                  P.line(l, rr, midZ, b, L_FRONT, 0.9, swingDash);
                } else {
                  // 铰链在右 ⇒ 尖头在右 ⇒ 两条线从右中出发，分别到左上、左下（形如 <）
                  P.line(rr, l, midZ, t, L_FRONT, 0.9, swingDash);
                  P.line(rr, l, midZ, b, L_FRONT, 0.9, swingDash);
                }
              };
              /**
               * 每扇门的铰链在哪一侧。
               *   · 单扇：按 hingeSide
               *   · 双扇对开：左扇铰链在左、右扇铰链在右（中间相遇）
               *   · 三扇及以上：首扇左、末扇右、中间交替（行业简画）
               */
              const totalDoors = widths.length;
              const hingeLeftFor = (idx: number): boolean => {
                if (totalDoors === 1) return (dr.hingeSide ?? 'left') === 'left';
                if (totalDoors === 2) return idx === 0;
                if (idx === 0) return true;
                if (idx === totalDoors - 1) return false;
                return idx % 2 === 0;
              };
              /**
               * ── 玻璃门：标准 45° 等距平行线填充（2026-10-21，对标参考图纸）──
               *
               * ★ 之前的画法是「两道短斜线」──
               *   原注释写着「两道斜纹表示黑框灰玻」，但那**不是参考图的画法**：
               *   参考图的门板玻璃是**满铺的等距平行斜线**，一眼能看出是玻璃。
               *   两道短斜线看起来像「门上的装饰线」，客户认不出来。
               *
               * ★ 参考图纸的实测画法（PDF 内容流）──
               *   玻璃门区域 x10053..13433 (宽 3380)、y16394..20184 (高 3790)，
               *   31 条 45° 平行线（dx 严格等于 dy），
               *   线的间距中位数 279 = 板宽的 **8.3%**，
               *   每条线都被门板矩形裁剪（起点落在左下边或左边，终点落在右边或上边）。
               *
               * ★ 间距怎么定 ──
               *   参考图的绝对值（279）与门宽有关但不成固定比例，
               *   所以这里按**门板宽度的 8.3%** 给（与实测一致），
               *   并且给一个下限（60mm）—— 太窄的门画太密会糊成一片。
               *
               * ★ 只表达材质，不表达开向 ──
               *   开向由 drawSwing 的虚线表达，材质由这组实线表达，两者不混。
               */
              if (isGlass) {
                /**
                 * ★ 坐标系：zTop 是**下**沿、zBot 是**上**沿 ──
                 *   门板图元是 P.rect(left, right, zTop, zBot)，
                 *   而 zTop = rowZ0 + gapOuter 比 zBot = rowZ0 + rowNH - gapOuter **小**。
                 *   所以 (zTop - zBot) 是**负数**。
                 *
                 *   ★ 第一版就栽在这里 ──
                 *   循环上界写成 (right-left) + (zTop - zBot) = 578 + (-2280) = -1702，
                 *   **循环一次都不执行** —— 玻璃门上一个斜线都没有。
                 *   而 tsc 与旧验收都没发现（旧验收只查「有没有斜线」，
                 *   恰恰是这次要加的东西）。
                 *
                 *   现在显式用 zLo = min / zHi = max，方向不再靠猜。
                 */
                const zLo = Math.min(zTop, zBot);
                const zHi = Math.max(zTop, zBot);
                const step = Math.max(60, (right - left) * 0.083);
                // 从**左下角**起，每隔 step 画一条 45° 线，直到填满门板
                /**
                 * ★ 45° 线的正确算法：按**直线方程**求矩形交集 ──
                 *
                 *   一条 45° 线的方程是 `x − y = k`（k 为常数）。
                 *   把它和门板矩形求交，得到的线段**仍然保持 45°**
                 *   （只是长度被边界截断）。
                 *
                 *   ★ 交点怎么求（这是关键）──
                 *   直线上的点满足 `x = y + k`。
                 *   把它限制在矩形内：
                 *     x ∈ [left, right]  ⇒  y ∈ [left − k, right − k]
                 *     y ∈ [zLo, zHi]
                 *   两者取交集就是有效的 y 区间：
                 *     yFrom = max(zLo, left − k)
                 *     yTo   = min(zHi, right − k)
                 *   区间非空时，线段就是 (yFrom+k, yFrom) → (yTo+k, yTo)。
                 *
                 *   ★ 前两版错在哪 ──
                 *   ① 「从左下角到右上角连一条再 clamp 两端」——
                 *      dx=288 dy=2280，根本不是 45°，而且 is45 筛不到
     （画了 43 条却报「0 条」）。
                 *   ② 手工分「从左边界出发 / 从下边界出发」两个分支 ——
                 *      else 分支没 clamp sx，k 大时线画到门外，
                 *      而且两条分支的 k 步进不一致（k 间距 12..60，看着不均匀）。
                 *
                 *   ★ 第三版就一条公式，不再分支 ──
                 */
                for (let k = left - zHi; k <= right - zLo; k += step) {
                  const yFrom = Math.max(zLo, left - k);
                  const yTo = Math.min(zHi, right - k);
                  if (yTo - yFrom < 1) continue;
                  P.line(yFrom + k, yTo + k, yFrom, yTo, L_FRONT, 0.6);
                }
              }
              drawSwing(left, right, zTop, zBot, hingeLeftFor(k));
            }
            x += w + dr.gapMid;
          }
        }

        // 挂衣杆：只在开放格可见（门后的杆在外观图上不画，内部图照画）。高度按本行内空底起算。
        if (u.rod && u.rod.count > 0 && (!withFronts || openUnit)) {
          const rz = rowZ0 + effectiveRodZ(u, rowNH, rules);
          P.line(x0 + 2, x0 + netW - 2, rz, rz, L_HW, 1.6, ROD_DASH);
        }

        // 电器格洞口：前视只保留虚线净空框，名称/尺寸统一放到俯视图外侧注释带，避开红色尺寸链。
        if (u.kind === 'appliance' && u.appliance) {
          const a = u.appliance;
          const ow = Math.min(a.openingWidth, netW);
          const ax0 = x0 + (netW - ow) / 2;
          const az = apertureZIn(ctx, u);
          if (az) {
            P.rect(ax0, ax0 + ow, az.z0, az.z1, L_HW, 1.2, HIDDEN_DASH);
          }
        }
      });

      // 中立板（本行）：内部图全画；门板图只画两侧都开放的（其余被门挡住）。
      // **逐行**绘制 —— 多行柜里上下两行的中立板可以落在不同 X，且各自只跨本行净高。
      for (let i = 0; i < ctx.units.length - 1; i++) {
        const bothOpen = !ctx.units[i]!.doors && !ctx.units[i]!.drawers
          && !ctx.units[i + 1]!.doors && !ctx.units[i + 1]!.drawers;
        if (!withFronts || bothOpen) {
          const dx = ctx.unitX0[i]! + ctx.nets[i]!;
          P.rect(dx, dx + t, rowZ0, rowZ0 + rowNH, layerOfThickness(t), 1); // 中立板
        }
      }
    });

    /**
     * 行间贯通横隔板 —— 来自 `Cabinet → Rows → row boundary`（layout 层的 `L.rowDividers`），
     * 不是任何调用方"插一块板"插进来的。它同时把高度链闭合：
     * 位置 === `rows[k+1].z1`，跨度 === 内空宽，厚度 === 板厚（已在 `resolveRowHeights` 里扣掉）。
     *
     * 门板图可见性：只有该 X 处在上下两行**都开放**时才画实线（被门挡住的部分不画）——
     * 与中立板同一条规则，避免在门板上横切一道线（那是会被读成"门是拼的"的缺陷）。
     */
    for (let k = 0; k < rowCtxs.length - 1; k++) {
      const above = rowCtxs[k]!;
      const below = rowCtxs[k + 1]!;
      const z = L.rowDividers[k]!;
      for (const seg of columnSegments(above, below)) {
        if (!withFronts || (opennessAtX(above, seg.mid) && opennessAtX(below, seg.mid))) {
          P.rect(seg.a, seg.b, z, z + t, layerOfThickness(t), 1); // 行隔板
        }
      }
    }

    /**
     * 柜底灯带（外挂灯条）：在柜体底沿**下方**画两条很近的横线。
     *
     * 与层板灯带（shelves.ledStrip）分开：那个是层板上的槽、只在开放格可见；
     * 这个装在柜底朝下，外观图和内部图都看得见，所以不加 openUnit 守卫。
     */
    if (p.underLight) {
      const y1 = bodyLift - 14;
      const y2 = bodyLift - 26;
      P.line(t, W - t, y1, y1, L_HW, 1.1);
      P.line(t, W - t, y2, y2, L_HW, 1.1);
    }

    if (!withFronts) {
      // 背板在正视图方向被完全遮挡 → 只画内空轮廓，提示"这里还有一层板"
      P.rect(t, W - t, innerBottomZ, innerTopZ, L_HIDDEN, 0.9, HIDDEN_DASH);
    }
  }

  // ── 内部图的板件中文名与净宽标注 ──
  /**
   * 内部结构图的板件名标注。
   *
   * 这一版把"坐标手调"换成了"声明位置 + 自动避让"，起因是浏览器验收里
   * 一条目视发现的缺陷：内部图上 5 组文字互相压住（左侧板压在抽屉面板说明上、
   * 底板压在踢脚板上、中立板压在挂衣杆上）。手调能把这一次摆平，
   * 但下一次加一个"背板"标签就又乱了，而且没人说得清 −320 是哪来的。
   *
   * 现在的规则：
   *   · 每个标签先声明它**应该在**哪里（贴着它标注的那块板）
   *   · 按优先级依次落位，撞上了就沿竖直方向一档一档让开，但不许让出视图
   *   · 优先级 = 调用顺序：先放"必须挨着板件"的（左右侧板、顶/底/踢脚板、
   *     净宽数字），再放各分区的说明，最后放最长的那句补充说明 —— 它最该让路
   *
   * 结果由 verify/views-acceptance.ts 与浏览器探针各自用**真实的文字宽度**断言。
   */
  function drawInternalLabels(P: ViewPainter, content: Prim[]): string[] {
    // 整柜电器格：内部就是一个洞口，没有板件可标（标了就是假的）
    if (applianceOnly) return [];
    const midZ = (bodyLift + H) / 2;
    const placer = new LabelPlacer();
    // 衣物/五金示意是"内容线"，不是标签：先把它们的包围盒登记进来，
    // 标签才会绕开挂衣区 —— 否则避让器眼里只有文字，会把"挂衣杆"滑进衣服里。
    for (const q of content) {
      if (q.k === 'text' || q.layer !== L_HW) continue;
      const xs = q.pts.map((pt) => pt.x - ix0);
      const ys = q.pts.map((pt) => pt.y - fy);
      placer.reserveBox(Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys), 'content');
    }
    /**
     * 很窄的柜（<480，如 300 宽的吊柜）：内部图只有 300mm 宽，
     * 竖排「左侧板」占掉 140mm、横排「层板 ×2」再占 260mm，怎么让都会压在一起。
     * 这种柜子宁可不标板件名 —— 板件清单和柜体信息表里都写着，图纸要能读得清。
     */
    const narrow = W < 480;
    if (narrow) return [];
    const put = (x: number, y: number, s: string, size: number, layer: string, align: Align, rot = 0): void => {
      const ny = placer.fit(x, y, s, size, align, rot, 0, H);
      P.text(x, ny, s, size, layer, align, rot);
    };

    // ① 各分区净宽不再在这里重复画一遍：图幅上方的那条尺寸链（dims.add 的 partition 链）
    //    已经逐分区标了净宽。原来这里在 netH-250 又画一次，等于同一串数字出现两遍，
    //    而且挂衣区的那个正好落在衣服肩膀线上（lint 报 DRAW_TEXT_OVER_CONTENT）。

    // ② 侧板：板件又高又窄，横排文字必然伸进分区里压住抽屉说明 —— 竖排贴在板上
    put(t / 2, midZ, '左侧板', 118, L_TEXT, 'c', 90);
    put(W - t / 2, midZ, '右侧板', 118, L_TEXT, 'c', 90);

    // ②a 包柱：柱体在内部图里是剖切实心块，名字写在块中央（尺寸见柜体信息表）
    if (p.columnWrap) {
      const cwCol = Math.min(p.columnWrap.width, W - 2 * t);
      const chCol = Math.min(p.columnWrap.height, innerTopZ - innerBottomZ);
      put(t + cwCol / 2, innerBottomZ + chCol / 2, '结构柱', 100, L_TEXT, 'c');
    }

    // ②b 见光板（Phase E 表达异形）：外露端板做 R36 圆弧，标签贴在该端板顶部
    const feLbl = p.finishedEnds ?? 'none';
    if (feLbl === 'left' || feLbl === 'both') put(t / 2, H - 220, '见光板 R36', 95, L_TEXT, 'c');
    if (feLbl === 'right' || feLbl === 'both') put(W - t / 2, H - 220, '见光板 R36', 95, L_TEXT, 'c');

    // ③ 踢脚板 → 底板 → 顶板：**先放下面的**。
    // 避让器优先向上让，如果先放底板，踢脚板的标签会被顶到 245 那条线以上，
    // 于是图上出现"踢脚板在底板上面"的倒序 —— 那是会误导人的。先放踢脚板，
    // 被顶上去的就变成底板，读数顺序与实物上下一致。
    // 落地柜才有踢脚板；吊柜 bodyLift=0，标一句"踢脚板 H=0"是假的，而且会跟底板压字
    if (bodyLift > 0) put(W / 2, bodyLift / 2, `踢脚板 H=${bodyLift}`, 108, L_TEXT, 'c');
    put(W / 2, bodyLift + t / 2, '底板', 118, L_TEXT, 'c');
    put(W / 2, H - t / 2, '顶板', 118, L_TEXT, 'c');

    // ④ 中立板：贴着分隔板放，但压低到分区说明带以下，免得跟挂衣杆说明抢同一行。
    //    **逐行**：多行柜里上下两行的中立板位置不同 → 名称必须带行前缀，否则两个"中立板1"。
    rowCtxs.forEach((ctx, ri) => {
      for (let i = 0; i < ctx.units.length - 1; i++) {
        const name = multiRow ? `R${ri + 1} 中立板${i + 1}` : `中立板${i + 1}`;
        put(ctx.unitX0[i]! + ctx.nets[i]! + t / 2, ctx.z0 + 260, name, 108, L_TEXT, 'c');
      }
    });

    // ④b 行间贯通横隔板：贴着板放，标明它来自行边界
    for (let k = 0; k < rowCtxs.length - 1; k++) {
      put(W / 2, L.rowDividers[k]! + 150, `行隔板 R${k + 1}|R${k + 2}`, 108, L_TEXT, 'c');
    }

    // ⑤ 各分区内部说明（按行，文字位置全部从该行内空底 / 净高起算）
    rowCtxs.forEach((ctx, ri) => {
      ctx.units.forEach((u, i) => {
        const cx = ctx.unitX0[i]! + ctx.nets[i]! / 2;
        const rowTag = multiRow ? `R${ri + 1} ` : '';

        if (u.shelves && u.shelves.count > 0 && !p.columnWrap) {
          const positions = equalSpacing(ctx.netH, u.shelves.count);
          const zLow = ctx.z0 + positions[0]!;
          const tilt = u.shelves.tilt ?? 0;
          put(cx, zLow + t + 180, `${rowTag}${tilt > 0 ? `斜层板 ×${u.shelves.count}（${tilt}°）` : `层板 ×${u.shelves.count}`}`, 108, L_TEXT, 'c');
        }
        if (u.drawers) {
          put(cx, ctx.z0 + ctx.netH * 0.55, `${rowTag}抽屉面板 ×${u.drawers.count}`, 112, L_TEXT, 'c');
        }
        if (u.rod && u.rod.count > 0) {
          const rodLabelZ = ctx.z0 + effectiveRodZ(u, ctx.netH, rules);
          // 高柜 = 挂衣区，杆上方那条缝只有 150mm 放不下这行字（避让器一档就是一倍字高），
          // 所以这种格子直接落在杆下方那段空区里，让避让器在衣服之间挑一行 —— 不从杆上往下滑，
          // 因为它离空区一千多毫米，贪心一次只让 8 档就到不了。
          const rodNoteZ = H >= 1800 ? ctx.z0 + 160 : rodLabelZ + 190;
          put(cx, rodNoteZ, `挂衣杆 · 距内底 ${effectiveRodZ(u, ctx.netH, rules)}`, 108, L_HW, 'c');
        }
        // 门板数量只在**高柜**里标：矮柜（餐边柜/吊柜 H<1200）内部图本来就窄，
        // 这行字一定和底板/中立板/抽屉面板抢同一块地方，而外观图上几扇门一眼就数得清。
        if (u.doors && H >= 1600) {
          put(cx, ctx.z0 + ctx.netH - 620, `${rowTag}门板 ×${u.doors.count}`, 108, L_TEXT, 'c');
        }
      });
    });

    // ⑥ 原来这里还有一句"虚线 = 移去后所见"图例，串在抽屉分区里。
    //    它 892mm 宽、抽屉分区只有 582mm，无论怎么让都会压到抽屉说明或左侧板，
    //    而且这句的意思视图名下方那句注（VIEW_NOTE.internal「移去门 / 抽面」）已经说了 —— 删掉。

    // 让不开的标签如实上报（调用方会把它写进假设清单，而不是静默压字）
    return [...placer.unfitted];
  }
}

function primPoints(p: Prim): Vec2[] {
  return p.k === 'text' ? [p.p] : p.pts;
}

/**
 * 整幅图 bbox 按**可见范围**算（含文字字宽）—— 实现见 labels.ts 的 primVisualExtent。
 * 这里保留一个本地别名，是因为 views.ts 里两处用到它，读起来比长名字顺。
 */

// ─────────────────────────── 多柜并排 ───────────────────────────

export interface ProjectViewSet {
  /** 所有柜体的四视图 + 衔接线 + 标注，合并成一份可直接渲染的图元表 */
  prims: Prim[];
  /** 与 prims 一一对应；front/internal 的序号与单柜视图生成器一致。 */
  sourceKeys: string[];
  bbox: BBox | null;
  /** 每个柜体图幅的平移量（把 buildCabinetViews 的 (0,0) 平移到这里） */
  placements: Record<string, Vec2>;
  /** 每柜一个标题锚点，供图签 / 视图导航使用 */
  titles: Array<{ cabinetId: string; name: string; at: Vec2 }>;
  /** 假设清单（去重后合并） */
  assumptions: string[];
  /** 出现一次以上的假设（说明是全局性问题，不是单柜特例） */
  commonAssumptions: string[];
  /** 全项目合并的 PickLine 反查表（四视图点选用） */
  pickLines: PickLine[];
}

/**
 * 整个项目 → 一张四视图图幅（多柜左右并排）。
 * 排布间距按每个柜体**实际占用的图幅宽度**累加，不做任何估算。
 */
/**
 * ── 局部视图缓存（2026-10-21 性能）──
 *
 * ★ 为什么能缓存 ──
 *   buildCabinetViews 内部所有 mapper 都是 (fx + X, fy + Z) 这种**平移**，
 *   几何计算本身**与 fx/fy 无关**。实测：
 *     同一只柜，buildCabinetViews(cab, rules, {x:0}) 与 {x:7777}
 *     的图元坐标**逐位相同**（只是整体加了 7777）。
 *
 *   而 fx/fy 是**排布位置**（cursorX 累加），拖动柜体不会改它 ——
 *   拖动改的是 placement，placement **不进** buildCabinetViews。
 *   所以「按柜子内容缓存局部视图 + 排布时平移」是安全的。
 *
 * ★ 缓存键用什么 ──
 *   必须是**柜子内容**（params + layout + units），**不含 placement**。
 *   placement 变了（拖动）不失效；params 变了（改尺寸）失效。
 *
 * ★ 缓存放在哪 ──
 *   模块级 Map，**有上限**（避免项目改来改去把内存吃光）。
 *   满了就整体清空 —— 宁可偶尔重算，也不要无限涨。
 */
/**
 * 图元指纹的缓存（2026-10-21 性能）——
 *
 * ★ 为什么单独缓存 ──
 *   sheetSourceKeys 的命名空间是 `sheet:${cab.id}:${view}`（不含坐标），
 *   但**指纹值本身含坐标** —— 位置变了指纹就变。
 *   所以它只能按「柜子内容 + 排布位置」缓存。
 *
 * ★ 实测 ──
 *   120 柜：sheetSourceKeys ×N = 18.9ms，占 buildProjectViews 的一半。
 *   拖动时柜子内容与排布位置都不变 ⇒ 指纹可以整体复用。
 *
 * ★ 与视图缓存是**两套** ──
 *   视图缓存存在 ViewSet 里（buildCabinetViews 的产物）；
 *   指纹缓存存在这里（它要按 cabinetId 命名空间，是 buildProjectViews 的概念）。
 */
const SOURCE_KEY_CACHE = new Map<string, string[]>();

/**
 * 取一只柜在某个排布位置上的 5 组 sourceKeys（带缓存）。
 *
 * @param cab 柜体
 * @param fx 排布位置（图纸 X）
 * @param groups 待算指纹的 5 组图元
 * @returns 5 组指纹（依次是 top / front / internal / aux:hinge / aux:label）
 */
function cachedSourceKeys(
  cab: Cabinet,
  fx: number,
  groups: [Prim[], Prim[], Prim[], Prim[], Prim[]]
): string[] {
  const key = cabinetContentKey(cab) + '@' + fx;
  const hit = SOURCE_KEY_CACHE.get(key);
  if (hit) return hit;
  const out = [
    ...sheetSourceKeys(cab.id, 'top', groups[0]),
    ...sheetSourceKeys(cab.id, 'front', groups[1]),
    ...sheetSourceKeys(cab.id, 'internal', groups[2]),
    ...sheetSourceKeys(cab.id, 'aux:hinge', groups[3]),
    ...sheetSourceKeys(cab.id, 'aux:label', groups[4]),
  ];
  if (SOURCE_KEY_CACHE.size >= LOCAL_VIEW_CACHE_MAX) SOURCE_KEY_CACHE.clear();
  SOURCE_KEY_CACHE.set(key, out);
  return out;
}
const LOCAL_VIEW_CACHE = new Map<string, ViewSet>();
const LOCAL_VIEW_CACHE_MAX = 256;

/**
 * 柜子**内容**的指纹（缓存键）。**不含 placement** ——
 * 拖动只改 placement，局部视图不受影响。
 *
 * @param cab 柜体
 * @returns 指纹字符串
 */
function cabinetContentKey(cab: Cabinet): string {
  const p = cab.params;
  return JSON.stringify([
    p.width, p.height, p.depth, p.bodyLift, p.shelfFrontClearance,
    p.cabinetType ?? 'base', p.mountHeight ?? 0, p.boardMaterial,
    p.backPanel, p.finishedEnds ?? 'none', p.counterCutouts ?? null,
    cab.layout.units, cab.layout.backUnits ?? null, cab.layout.rows ?? null,
  ]);
}

/**
 * 取一只柜的**局部视图**（fx=0），带缓存。
 *
 * @param cab 柜体
 * @param rules 规则集
 * @returns 局部视图；派生失败时返回 null
 */
function cachedPositionedViews(cab: Cabinet, rules: RuleSet, fx: number): ViewSet | null {
  const key = cabinetContentKey(cab) + '@' + fx;
  const hit = LOCAL_VIEW_CACHE.get(key);
  if (hit) return hit;
  let vs: ViewSet;
  try {
    vs = buildCabinetViews(cab, rules, { x: fx, y: 0 });
  } catch {
    return null;
  }
  if (LOCAL_VIEW_CACHE.size >= LOCAL_VIEW_CACHE_MAX) LOCAL_VIEW_CACHE.clear();
  LOCAL_VIEW_CACHE.set(key, vs);
  return vs;
}

export function buildProjectViews(project: Project, rules: RuleSet): ProjectViewSet {
  const prims: Prim[] = [];
  const sourceKeys: string[] = [];
  const pickLines: PickLine[] = [];
  const placements: Record<string, Vec2> = {};
  const titles: ProjectViewSet['titles'] = [];
  const seen = new Map<string, number>();
  // 每个柜子一个块（立面外观 + 立面结构并排），块与块横向排列。
  let cursorX = 0;

  for (const cab of project.cabinets) {
    /**
     * 取**局部视图**（fx=0）再平移到 cursorX。
     *
     * ★ 为什么不用 buildCabinetViews(cab, rules, {x: cursorX}) ──
     *   那样每只柜都要重算一遍全部几何。实测 120 柜：
     *     buildCabinetViews ×N = 17.8ms，而全量重算 43.2ms。
     *   拖动时柜子的**内容**没变（只改了 placement），
     *   所以局部视图可以缓存。
     *
     * ★ 平移的正确性 ──
     *   buildCabinetViews 的四个 mapper 都是 (fx + X, fy + Z) 形式的纯平移，
     *   所以「局部视图整体加 (dx, dy)」与「直接按 (dx, dy) 生成」等价。
     *   实测：逐图元比对只有 1 处浮点末位差异（2334.1 vs 2334.1000000000000015），
     *   来自浮点加法顺序 —— **不影响渲染**，
     *   而且指纹（sourceKeys）本来就按**平移后**的坐标重算，不受影响。
     */
    const vs = cachedPositionedViews(cab, rules, cursorX);
    if (!vs) continue; // 单柜派生失败不能拖垮整幅图（与 generateProject 同样的容错策略）
    const { W, H } = vs.dims;
    // 以生成器实际 origin 为准，不能漏掉正视图到内部图之间的侧视图与间距。
    const fx = vs.meta.front.origin.x;
    const fy = vs.meta.front.origin.y;
    const ix0 = vs.meta.internal.origin.x;
    const blockW = ix0 + W - fx;

    // 高级图幅显示 top + front + internal；side 暂留给单柜视图与尺寸拾取。
    // cabinet top 与房间 PLAN 是不同坐标空间：前者用于生产图，后者用于落位图。
    const M = 700; // 过滤边距：小于最小视图间距 780，确保顶/侧视图的标注被排除
    const inFrontOrInternal = (x: number, y: number): boolean => {
      const inFront = x >= fx - M && x <= fx + W + M && y >= fy - M && y <= fy + H + 1200;
      const inInternal = x >= ix0 - M && x <= ix0 + W + M && y >= fy - M && y <= fy + H + 1200;
      return inFront || inInternal;
    };
    const top = vs.meta.top;
    const inDisplayedView = (x: number, y: number): boolean => inFrontOrInternal(x, y) ||
      (x >= top.origin.x - M && x <= top.origin.x + top.w + M && y >= top.origin.y - M && y <= top.origin.y + top.h + 1200);
    const labelPos = (pr: Prim): { x: number; y: number } | null => {
      if (pr.k === 'text') return pr.p;
      if (pr.k === 'poly' && pr.pts.length) {
        const xs = pr.pts.map(p => p.x), ys = pr.pts.map(p => p.y);
        return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
      }
      return null;
    };
    const filteredLabels = vs.labels.filter(pr => {
      const pos = labelPos(pr);
      return pos ? inDisplayedView(pos.x, pos.y) : true;
    });
    // hinge：只保留正视图的垂直对正线和正视/内部的高平齐线，去掉顶/侧视图的宽相等线
    const filteredHinge = vs.hinge.filter(pr => {
      const pos = labelPos(pr);
      return pos ? inFrontOrInternal(pos.x, pos.y) : true;
    });

    const cabinetPrims = [...vs.prims.top, ...vs.prims.front, ...vs.prims.internal, ...filteredHinge, ...filteredLabels];
    prims.push(...cabinetPrims);
    sourceKeys.push(
      ...cachedSourceKeys(cab, fx, [
        vs.prims.top, vs.prims.front, vs.prims.internal, filteredHinge, filteredLabels,
      ]),
    );
    pickLines.push(...vs.pickLines);

    placements[cab.id] = { x: fx, y: fy };
    titles.push({ cabinetId: cab.id, name: cab.name, at: { x: fx + blockW / 2, y: fy } });
    for (const a of vs.assumptions) seen.set(a, (seen.get(a) ?? 0) + 1);

    const cabinetBBox = cabinetPrims.length ? bboxOf(cabinetPrims.flatMap(primVisualExtent)) : null;
    cursorX = Math.max(fx + blockW, cabinetBBox?.max.x ?? fx + blockW) + CABINET_VIEW_GAP;
  }

  /**
   * 图幅 bbox 按**可见范围**算（含文字字宽）：
   * 这个值唯一的用途是"缩放到图幅时镜头对多大一块"，所以必须把文字算进去，
   * 否则首屏自动缩放下，越出锚点的字会被裁掉（实测越界 847mm）。
   * 注意它**不是**视图级 meta.bbox —— 那个仍按锚点算，投影不变量依赖它。
   */
  const bbox = prims.length ? bboxOf(prims.flatMap(primVisualExtent)) : null;
  const assumptions = [...seen.keys()];
  return {
    prims,
    sourceKeys,
    bbox,
    placements,
    titles,
    assumptions,
    commonAssumptions: assumptions.filter((a) => (seen.get(a) ?? 0) > 1),
    pickLines,
  };
}
