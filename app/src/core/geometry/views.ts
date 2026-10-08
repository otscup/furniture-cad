import type { BBox, Cabinet, Prim, Project, RuleSet, Vec2 } from '../types.ts';
import { equalSpacing } from '../allocate.ts';
import { computeCabinetLayout, doorWidths, drawerCellHeights } from './layout.ts';
import { buildFrontPickLines, buildSideTopPickLines } from './pickLines.ts';
import type { PickLine } from './pickLines.ts';
import { bboxOf } from './transform.ts';
import { LabelPlacer, primVisualExtent } from './labels.ts';

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
        const s = axial(it) - textHalf(it);
        const e = axialEnd(it) + textHalf(it);
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

  // ═══════════════ 2. 俯视图（从上往下看）═══════════════
  // 俯视图看到的"顶面"就是顶板；两侧是侧板；最后面是背板；
  // 最前面一条带是门 / 抽面；层板与挂衣杆在顶板之下，用虚线表达。
  T.rect(0, W, 0, D, L_FRAME, 2.4);
  T.rect(0, t, 0, bodyD, layerOfThickness(t), 1); // 左侧板
  T.rect(W - t, W, 0, bodyD, layerOfThickness(t), 1); // 右侧板
  T.rect(t, W - t, 0, bodyD, layerOfThickness(t), 1); // 顶板
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
        const rz = z0 + u.rod.heightFromBottom;
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
  drawLifestyleItems(I);
  const labelUnfitted = drawInternalLabels(I);

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

  // ── 内部结构图的生活物品示意（生活化展示）──
  // 只在内部图画（internal），外观图（front）不画。
  // 用细线（0.7），图层 L_HW，不遮挡结构线。所有坐标均为柜体局部（X, Z），经 P 映射。
  function drawLifestyleItems(P: ViewPainter): void {
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

        // ── 1. 挂衣区：2-3 件挂着的衣服（衣架 + 衣服轮廓）──
        if (u.rod && u.rod.count > 0) {
          const rodZ = rowZ0 + u.rod.heightFromBottom;
          const n = Math.min(3, Math.max(2, Math.floor(netW / 350)));
          const isLong = rowNH >= 1200; // 长衣/短衣按净高区分
          const garmentH = isLong ? Math.min(900, rowNH - u.rod.heightFromBottom - 50) : Math.min(600, rowNH - u.rod.heightFromBottom - 50);
          if (garmentH > 200) {
            for (let k = 0; k < n; k++) {
              const hx = x0 + (netW * (k + 1)) / (n + 1);
              const hw = Math.min(90, netW / (n + 1) / 2); // 半宽
              // 衣架钩（杆上小竖线）
              P.line(hx, hx, rodZ, rodZ + 25, L_HW, LW);
              // 衣架肩（两条斜线）
              P.line(hx, hx - hw, rodZ + 25, rodZ + 70, L_HW, LW);
              P.line(hx, hx + hw, rodZ + 25, rodZ + 70, L_HW, LW);
              // 衣服轮廓（梯形：肩宽 → 下摆稍宽）
              const shoulderZ = rodZ + 70;
              const hemZ = shoulderZ + garmentH;
              const hemHW = hw + 25;
              P.poly(
                [
                  { x: hx - hw, y: shoulderZ },
                  { x: hx + hw, y: shoulderZ },
                  { x: hx + hemHW, y: hemZ },
                  { x: hx - hemHW, y: hemZ },
                ],
                L_HW,
                LW,
                true
              );
            }
          }
        }

        // ── 2. 叠放区：层板上画 2-3 条横线表示叠放衣物（无杆的层板格）──
        if (u.shelves && u.shelves.count > 0 && !(u.rod && u.rod.count > 0)) {
          const positions = equalSpacing(rowNH, u.shelves.count);
          // 在每块层板上方画一叠（取前 2 块板，避免画满）
          const stackCount = Math.min(2, positions.length);
          for (let s = 0; s < stackCount; s++) {
            const shelfZ = rowZ0 + positions[s]! + t; // 层板顶面
            const stackW = Math.min(220, netW * 0.5);
            const sx = x0 + (netW - stackW) / 2;
            // 3 条横线 = 一叠衣服
            for (let l = 0; l < 3; l++) {
              const lz = shelfZ + 15 + l * 28;
              // 别顶到上一块板
              const nextShelfZ = s + 1 < positions.length ? rowZ0 + positions[s + 1]! : rowZ0 + rowNH;
              if (lz + 10 < nextShelfZ) {
                P.line(sx, sx + stackW, lz, lz, L_HW, LW);
              }
            }
          }
          // 顶柜（高处层板格）：画被子/枕头示意（圆角矩形用 poly 近似）
          if (isTallCab && rowZ0 > 1500) {
            const qw = Math.min(300, netW * 0.6);
            const qx = x0 + (netW - qw) / 2;
            const qz0 = rowZ0 + 20;
            const qz1 = Math.min(rowZ0 + 220, rowZ0 + rowNH - 20);
            if (qz1 - qz0 > 80) {
              // 被子：矩形 + 中间一道折痕线
              P.rect(qx, qx + qw, qz0, qz1, L_HW, LW);
              P.line(qx, qx + qw, (qz0 + qz1) / 2, (qz0 + qz1) / 2, L_HW, LW);
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
    const isApplianceCab = L.rows.every((r) => r.units.length > 0 && r.units.every((u) => u.kind === 'appliance'));
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
        if (u.shelves && u.shelves.count > 0 && (!withFronts || openUnit)) {
          const s = shelfSpanXIn(ctx, i);
          const tilt = u.shelves.tilt ?? 0;
          const span = s.b - s.a;
          // 斜层板（Phase E 图元扩展）：右端按 tan(tilt) 下沉，画成平行四边形。
          // tilt=0 时 shift=0 → 退化为普通矩形，与旧行为一致（不留隐式分支）。
          const shift = tilt > 0 ? Math.round(span * Math.tan((tilt * Math.PI) / 180)) : 0;
          equalSpacing(rowNH, u.shelves.count).forEach((pos) => {
            const yb = rowZ0 + pos;
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
          for (const ch of cellH) {
            P.rect(x0 + d.gap, x0 + netW - d.gap, z, z + ch, L_FRONT, withFronts ? 1.8 : 1.2, hidden);
            z += ch + d.gap;
          }
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
              // 斜线只表示材质（灰玻），不表示开向 —— 开向仍由下方对角线表达。
              // 45° 斜线在门洞矩形内截断，两道，避开与开向 X 的视觉混淆。
              P.fillRect(left, right, zTop, zBot, L_FRONT, 0.12);
              const hatch = (f: number): void => {
                const hx = left + w * f;
                const run = Math.min(right - hx, zBot - zTop);
                if (run > 0) P.line(hx, hx + run, zBot, zBot - run, L_FRONT, 0.7);
              };
              hatch(0.33);
              hatch(0.66);
            }

            if (withFronts) {
              /**
               * 开向对角线 —— 与销售图纸同款：
               *   · 双扇对开画 X 形（左扇 ↘、右扇 ↗，两条线在门缝处交叉）；
               *   · 单扇按 hingeSide：铰链在左 → 门往右开 → 线从右上到左下（指向开门侧）；
               *   · 三扇及以上：全部同向（行业简画；逐扇铰链标注待数据细化）。
               * 注意 PickLine 不受影响：点的是门缝/外轮廓，对角线只是表达符号。
               * 2026-10-04 v8：X 线加回来（v7 误删），对标参考 PDF 门板 X 交叉线
               */
              // v8：恢复 diag 函数（画门板 X 交叉线，实线）
              const diag = (x1: number, y1: number, x2: number, y2: number): void => {
                P.line(x1, x2, y1, y2, L_FRONT, 0.8);
              };
              if (widths.length === 2) {
                // 对开 X 形：v8 恢复（对标参考 PDF）
                if (k === 0) {
                  const openL = x0 + dr.gapOuter;
                  const openR = openL + widths[0]! + dr.gapMid + widths[1]!;  // v8 恢复
                  diag(openL, zBot, openR, zTop);  // v8 恢复：X 实线
                  diag(openL, zTop, openR, zBot);  // v8 恢复：X 实线
                  // v8：双扇门虚线箭头改竖向（上下开门方向，对标参考 PDF）
                  // 用户要求：虚线双向 <> 覆盖整个门板
                  const w0 = widths[0]!, w1 = widths[1]!;
                  // 左扇：虚线双向箭头，覆盖整个门板高度
                  const l_cx = openL + w0 / 2;
                  P.line(l_cx, l_cx, zTop, zBot, L_HW, 0.9, HINGE_DASH);
                  P.line(l_cx, l_cx - 35, zTop, zTop + 60, L_HW, 0.9, HINGE_DASH);
                  P.line(l_cx, l_cx + 35, zTop, zTop + 60, L_HW, 0.9, HINGE_DASH);
                  P.line(l_cx, l_cx - 35, zBot, zBot - 60, L_HW, 0.9, HINGE_DASH);
                  P.line(l_cx, l_cx + 35, zBot, zBot - 60, L_HW, 0.9, HINGE_DASH);
                  // 右扇：虚线双向箭头，覆盖整个门板高度
                  const r_x0 = openL + w0 + dr.gapMid;
                  const r_cx = r_x0 + w1 / 2;
                  P.line(r_cx, r_cx, zTop, zBot, L_HW, 0.9, HINGE_DASH);
                  P.line(r_cx, r_cx - 35, zTop, zTop + 60, L_HW, 0.9, HINGE_DASH);
                  P.line(r_cx, r_cx + 35, zTop, zTop + 60, L_HW, 0.9, HINGE_DASH);
                  P.line(r_cx, r_cx - 35, zBot, zBot - 60, L_HW, 0.9, HINGE_DASH);
                  P.line(r_cx, r_cx + 35, zBot, zBot - 60, L_HW, 0.9, HINGE_DASH);
                }
              } else if (widths.length === 1) {
                // 单扇门：v8 恢复 X 对角线（对标参考 PDF）
                const hingeLeft = (dr.hingeSide ?? 'left') === 'left';
                if (hingeLeft) diag(right, zTop, left, zBot);  // v8 恢复
                else diag(left, zTop, right, zBot);  // v8 恢复
                // v8：虚线箭头改竖向（上下开门方向，对标参考 PDF）
                // 用户要求：虚线双向 <> 覆盖整个门板
                const cx = (left + right) / 2;
                // 竖向虚线，覆盖整个门板高度
                P.line(cx, cx, zTop, zBot, L_HW, 0.9, HINGE_DASH);
                // 上箭头（指向上），虚线
                P.line(cx, cx - 35, zTop, zTop + 60, L_HW, 0.9, HINGE_DASH);
                P.line(cx, cx + 35, zTop, zTop + 60, L_HW, 0.9, HINGE_DASH);
                // 下箭头（指向下），虚线
                P.line(cx, cx - 35, zBot, zBot - 60, L_HW, 0.9, HINGE_DASH);
                P.line(cx, cx + 35, zBot, zBot - 60, L_HW, 0.9, HINGE_DASH);
              } else {
                const side = (dr.hingeSide ?? 'left') === 'left';
                for (let j = 0; j < widths.length; j++) {
                  const l2 = j === 0 ? left : x0 + dr.gapOuter + widths.slice(0, j).reduce((a, w2) => a + w2 + dr.gapMid, 0);
                  const r2 = l2 + widths[j];
                  if (side) diag(r2, zTop, l2, zBot);  // v8 恢复：X 实线
                  else diag(l2, zTop, r2, zBot);  // v8 恢复：X 实线
                  // v8：多扇门虚线箭头改竖向（上下开门方向，对标参考 PDF）
                  // 用户要求：虚线双向 <> 覆盖整个门板
                  const j_cx = (l2 + r2) / 2;
                  P.line(j_cx, j_cx, zTop, zBot, L_HW, 0.9, HINGE_DASH);
                  P.line(j_cx, j_cx - 35, zTop, zTop + 60, L_HW, 0.9, HINGE_DASH);
                  P.line(j_cx, j_cx + 35, zTop, zTop + 60, L_HW, 0.9, HINGE_DASH);
                  P.line(j_cx, j_cx - 35, zBot, zBot - 60, L_HW, 0.9, HINGE_DASH);
                  P.line(j_cx, j_cx + 35, zBot, zBot - 60, L_HW, 0.9, HINGE_DASH);
                }
              }
            }
            x += w + dr.gapMid;
          }
        }

        // 挂衣杆：只在开放格可见（门后的杆在外观图上不画，内部图照画）。高度按本行内空底起算。
        if (u.rod && u.rod.count > 0 && (!withFronts || openUnit)) {
          const rz = rowZ0 + u.rod.heightFromBottom;
          P.line(x0 + 2, x0 + netW - 2, rz, rz, L_HW, 1.6, ROD_DASH);
        }

        // 电器格洞口：虚线框 + 名称与洞口尺寸（外观图上机器就在洞里，内部图同样标）。洞口自本行内空底起算。
        if (u.kind === 'appliance' && u.appliance) {
          const a = u.appliance;
          const ow = Math.min(a.openingWidth, netW);
          const ax0 = x0 + (netW - ow) / 2;
          const az = apertureZIn(ctx, u);
          if (az) {
            P.rect(ax0, ax0 + ow, az.z0, az.z1, L_HW, 1.2, HIDDEN_DASH);
            P.text(ax0 + ow / 2, (az.z0 + az.z1) / 2, `${a.name} ${a.openingWidth}×${a.openingHeight}`, 80, L_TEXT, 'c');
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
  function drawInternalLabels(P: ViewPainter): string[] {
    const midZ = (bodyLift + H) / 2;
    const placer = new LabelPlacer();
    const put = (x: number, y: number, s: string, size: number, layer: string, align: Align, rot = 0): void => {
      const ny = placer.fit(x, y, s, size, align, rot, 0, H);
      P.text(x, ny, s, size, layer, align, rot);
    };

    // ① 各分区净宽属于顶部那条尺寸链，位置由尺寸链定死：只登记占位，不参与让路。
    //    **逐行**：尺寸链挂在该行顶面之下（单行柜 = 内空顶面之下，与 v0.2 同位置）。
    rowCtxs.forEach((ctx) => {
      const dimZ = ctx.z0 + ctx.netH - 250;
      for (let i = 0; i < ctx.units.length; i++) {
        const cx = ctx.unitX0[i]! + ctx.nets[i]! / 2;
        placer.reserve(cx, dimZ, `${ctx.nets[i]}`, 108, 'c');
        P.text(cx, dimZ, `${ctx.nets[i]}`, 108, L_DIM, 'c');
      }
    });

    // ② 侧板：板件又高又窄，横排文字必然伸进分区里压住抽屉说明 —— 竖排贴在板上
    put(t / 2, midZ, '左侧板', 118, L_TEXT, 'c', 90);
    put(W - t / 2, midZ, '右侧板', 118, L_TEXT, 'c', 90);

    // ②b 见光板（Phase E 表达异形）：外露端板做 R36 圆弧，标签贴在该端板顶部
    const feLbl = p.finishedEnds ?? 'none';
    if (feLbl === 'left' || feLbl === 'both') put(t / 2, H - 220, '见光板 R36', 95, L_TEXT, 'c');
    if (feLbl === 'right' || feLbl === 'both') put(W - t / 2, H - 220, '见光板 R36', 95, L_TEXT, 'c');

    // ③ 踢脚板 → 底板 → 顶板：**先放下面的**。
    // 避让器优先向上让，如果先放底板，踢脚板的标签会被顶到 245 那条线以上，
    // 于是图上出现"踢脚板在底板上面"的倒序 —— 那是会误导人的。先放踢脚板，
    // 被顶上去的就变成底板，读数顺序与实物上下一致。
    put(W / 2, bodyLift / 2, `踢脚板 H=${bodyLift}`, 108, L_TEXT, 'c');
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

        if (u.shelves && u.shelves.count > 0) {
          const positions = equalSpacing(ctx.netH, u.shelves.count);
          const zLow = ctx.z0 + positions[0]!;
          const tilt = u.shelves.tilt ?? 0;
          put(cx, zLow + t + 180, `${rowTag}${tilt > 0 ? `斜层板 ×${u.shelves.count}（${tilt}°）` : `层板 ×${u.shelves.count}`}`, 108, L_TEXT, 'c');
        }
        if (u.drawers) {
          put(cx, ctx.z0 + ctx.netH * 0.55, `${rowTag}抽屉面板 ×${u.drawers.count}`, 112, L_TEXT, 'c');
        }
        if (u.rod && u.rod.count > 0) {
          put(cx, ctx.z0 + u.rod.heightFromBottom + 190, `挂衣杆 · 距内底 ${u.rod.heightFromBottom}`, 108, L_HW, 'c');
        }
        if (u.doors) {
          put(cx, ctx.z0 + ctx.netH - 620, `${rowTag}门板 ×${u.doors.count}（已移开）`, 108, L_TEXT, 'c');
        }
      });
    });

    // ⑥ 最长的一句补充说明最后放：它是解释性的，最该给别人让路。
    // 另外把字数压到 8 个字 —— 原来的"（虚线 = 移去抽屉面板后所见）"
    // 算出来 1496mm 宽，而抽屉分区净宽只有 582mm，文字会溢出视图左边界 400 多毫米。
    rowCtxs.forEach((ctx, ri) => {
      ctx.units.forEach((u, i) => {
        if (!u.drawers) return;
        const cx = ctx.unitX0[i]! + ctx.nets[i]! / 2;
        put(cx, ctx.z0 + ctx.netH * 0.55 - 200, multiRow ? `R${ri + 1} 虚线 = 移去后所见` : '虚线 = 移去后所见', 95, L_TEXT, 'c');
      });
    });

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
export function buildProjectViews(project: Project, rules: RuleSet): ProjectViewSet {
  const prims: Prim[] = [];
  const pickLines: PickLine[] = [];
  const placements: Record<string, Vec2> = {};
  const titles: ProjectViewSet['titles'] = [];
  const seen = new Map<string, number>();
  // PDF 式排版：每个柜子一个块（立面外观 + 立面结构并排），块与块上下叠放，
  // 不再是所有柜子挤成一横排。
  let cursorY = 0;

  for (const cab of project.cabinets) {
    let vs: ViewSet;
    try {
      vs = buildCabinetViews(cab, rules, { x: 0, y: cursorY });
    } catch {
      continue; // 单柜派生失败不能拖垮整幅图（与 generateProject 同样的容错策略）
    }
    const { W, H } = vs.dims;
    // 块内：立面外观在左，立面结构在右（PDF 排版）
    const blockW = W + vs.gaps.gapInt + W;
    const blockH = H;

    // 只取 front + internal 的图元；labels/hinge 按位置过滤掉顶视图/侧视图的
    // （buildCabinetViews 仍生成四视图的 labels，但三视图模式下只用其中两视图的）
    const fx = 0, fy = cursorY;
    const ix0 = fx + W + vs.gaps.gapInt;
    const M = 700; // 过滤边距：小于最小视图间距 780，确保顶/侧视图的标注被排除
    const inFrontOrInternal = (x: number, y: number): boolean => {
      const inFront = x >= fx - M && x <= fx + W + M && y >= fy - M && y <= fy + H + 1200;
      const inInternal = x >= ix0 - M && x <= ix0 + W + M && y >= fy - M && y <= fy + H + 1200;
      return inFront || inInternal;
    };
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
      return pos ? inFrontOrInternal(pos.x, pos.y) : true;
    });
    // hinge：只保留正视图的垂直对正线和正视/内部的高平齐线，去掉顶/侧视图的宽相等线
    const filteredHinge = vs.hinge.filter(pr => {
      const pos = labelPos(pr);
      return pos ? inFrontOrInternal(pos.x, pos.y) : true;
    });

    prims.push(...vs.prims.front, ...vs.prims.internal, ...filteredHinge, ...filteredLabels);
    pickLines.push(...vs.pickLines);

    placements[cab.id] = { x: 0, y: cursorY };
    titles.push({ cabinetId: cab.id, name: cab.name, at: { x: blockW / 2, y: cursorY } });
    for (const a of vs.assumptions) seen.set(a, (seen.get(a) ?? 0) + 1);

    cursorY += blockH + CABINET_VIEW_GAP;
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
    bbox,
    placements,
    titles,
    assumptions,
    commonAssumptions: assumptions.filter((a) => (seen.get(a) ?? 0) > 1),
    pickLines,
  };
}
