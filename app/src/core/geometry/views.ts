import type { BBox, Cabinet, Prim, Project, RuleSet, Vec2 } from '../types.ts';
import { equalSpacing } from '../allocate.ts';
import { computeCabinetLayout, doorWidths, drawerCellHeights } from './layout.ts';
import { buildFrontPickLines } from './pickLines.ts';
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

export const VIEW_KINDS: ViewKind[] = ['front', 'top', 'side', 'internal'];

export const VIEW_NAME: Record<ViewKind, string> = {
  front: '正视图',
  top: '俯视图',
  side: '侧视图',
  internal: '内部结构图',
};

export const VIEW_NOTE: Record<ViewKind, string> = {
  front: '从前向后看 · 含门 / 抽面',
  top: '从上向下看 · 置于正视图正下方（长对正）',
  side: '从左向右看 · 置于正视图正右方（高平齐）',
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
  text(a: number, b: number, s: string, size: number, layer: string, align?: Align, rot?: number): void;
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
    text(a, b, s, size, layer, align = 'c', rot) {
      out.push({ k: 'text', p: map(a, b), text: s, size, layer, align, ...(rot ? { rot } : {}) });
    },
  };
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
  const bodyLift = p.bodyLift;
  const innerW = L.innerW;
  const innerH = L.innerH;
  const nets = L.nets;
  const unitX0 = L.unitX0;
  const unitCount = cab.layout.units.length;
  const bp = p.backPanel;

  /**
   * 层板在 X 方向的真实跨度 —— 与板件清单严格同源。
   *
   * generate.ts 的立面里用的是**分区净宽** netW，而板件清单里层板的 length 是
   * `netW - 2×gapPerSide`（默认 gapPerSide=0.5，即窄 1mm）。
   * 视图是派生视图，必须画板件的真实尺寸，否则"从同一份数据派生"就是空话。
   * 位置按居中放置（间隙 0.5 是装配让位，不是尺寸）。
   */
  const shelfSpanX = (i: number): { a: number; b: number } => {
    const netW = nets[i];
    const gap = cab.layout.units[i]?.shelves?.gapPerSide ?? 0;
    const w = netW - 2 * gap;
    const a = unitX0[i] + (netW - w) / 2;
    return { a, b: a + w };
  };

  /** 内空底面高度（底板顶面） */
  const innerBottomZ = bodyLift + t;
  /** 内空顶面高度（顶板底面） */
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
   * 必须与正视图图元在**同一处**生成：mapper 传的就是上面那对画图用的，
   * 点位与图元逐位一致 —— 与几何同源，结构上不可能漂移。
   */
  const pickLines = buildFrontPickLines(cab, L, rules, mapFront, mapInt);

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
  for (let i = 0; i < unitCount - 1; i++) {
    const dx = unitX0[i] + nets[i];
    T.rect(dx, dx + t, 0, bodyD, layerOfThickness(t), 1); // 中立板
  }
  T.rect(t, W - t, backY0, backY1, layerOfThickness(tb), 1); // 背板

  cab.layout.units.forEach((u, i) => {
    const x0 = unitX0[i];
    const x1 = x0 + nets[i];

    if (u.doors || u.drawers) {
      T.rect(x0, x1, faceY0, faceY1, L_FRONT, 1.8);
    }
    if (u.doors && u.doors.count > 1) {
      for (let k = 1; k < u.doors.count; k++) {
        const xk = x0 + (nets[i] * k) / u.doors.count;
        T.line(xk, xk, faceY0, faceY1, L_FRONT, 1);
      }
    }
    if (u.shelves && u.shelves.count > 0) {
      const s = shelfSpanX(i);
      T.rect(s.a, s.b, shelfY0, shelfY1, L_HIDDEN, 1, HIDDEN_DASH);
    }
    if (u.rod && u.rod.count > 0) {
      T.line(x0 + 2, x1 - 2, rodY, rodY, L_HW, 1.6, ROD_DASH);
    }
  });

  // ═══════════════ 3. 侧视图（从左往右看）═══════════════
  // 横轴 = 进深 Y（左边贴正视图 = 柜背，右边 = 柜门）；纵轴 = 高度 Z。
  S.rect(0, D, 0, H, L_FRAME, 2.4);
  S.rect(0, bodyD, H - t, H, layerOfThickness(t), 1); // 顶板
  S.rect(0, bodyD, bodyLift, bodyLift + t, layerOfThickness(t), 1); // 底板
  S.rect(faceY0 - t, faceY0, 0, bodyLift, layerOfThickness(t), 1); // 踢脚板（前挡板）
  S.rect(backY0, backY1, innerBottomZ, innerTopZ, layerOfThickness(tb), 1); // 背板
  // 中立板在侧视图里被左侧板完全遮挡 → 轮廓用虚线表达"此处有一块板"
  S.rect(0, bodyD, innerBottomZ, innerTopZ, L_HIDDEN, 0.9, HIDDEN_DASH);

  cab.layout.units.forEach((u) => {
    if (u.shelves && u.shelves.count > 0) {
      equalSpacing(innerH, u.shelves.count).forEach((pos) => {
        S.rect(shelfY0, shelfY1, innerBottomZ + pos, innerBottomZ + pos + t, layerOfThickness(t), 1);
      });
    }
    if (u.doors) {
      S.rect(faceY0, faceY1, innerBottomZ + u.doors.gapOuter, innerBottomZ + innerH - u.doors.gapOuter, L_FRONT, 1.8);
    }
    if (u.drawers) {
      const cellH = drawerCellHeights(u, innerH, rules);
      let z = innerBottomZ + u.drawers.gap;
      for (const ch of cellH) {
        S.rect(faceY0, faceY1, z, z + ch - 2 * u.drawers.gap, L_FRONT, 1.8);
        z += ch + u.drawers.gap;
      }
    }
    if (u.rod && u.rod.count > 0) {
      // 垂直于视图方向的一根杆 → 画成小十字
      const rz = innerBottomZ + u.rod.heightFromBottom;
      S.line(rodY - 70, rodY + 70, rz, rz, L_HW, 1.8);
      S.line(rodY, rodY, rz - 70, rz + 70, L_HW, 1.8);
    }
  });

  // ═══════════════ 4. 内部结构图（移去门 / 抽面）═══════════════
  // 背板在内空里铺满一层 → 用浅色填充表达"这里有一层板"（先画，压在最底）
  prims.internal.unshift({
    k: 'fill',
    pts: [mapInt(t, innerBottomZ), mapInt(W - t, innerBottomZ), mapInt(W - t, innerTopZ), mapInt(t, innerTopZ)],
    layer: layerOfThickness(tb),
    alpha: 0.1,
  });
  I.rect(0, W, 0, H, L_FRAME, 1.8);
  drawFrontLike(I, false);
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

  // 正视图：总高（左侧）
  pushDim(labels, { x: fx - 460, y: fy }, { x: fx - 460, y: fy + H }, `${H}`, 190, 90);
  // 俯视图：总宽（下方）+ 总深（右侧）
  pushDim(labels, { x: fx, y: ty0 - D - 620 }, { x: fx + W, y: ty0 - D - 620 }, `${W}`, -170);
  pushDim(labels, { x: fx + W + 360, y: ty0 }, { x: fx + W + 360, y: ty0 - D }, `${D}`, 210, 90);
  // 侧视图：总深（下方）
  pushDim(labels, { x: sx0, y: fy - 460 }, { x: sx0 + D, y: fy - 460 }, `${D}`, -170);
  // 内部图：总宽（上方）
  pushDim(labels, { x: ix0, y: fy + H + 460 }, { x: ix0 + W, y: fy + H + 460 }, `${W}`, 170);

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
  labels.push({
    k: 'text',
    p: { x: ix0 + W, y: fy - 500 },
    text: `净宽分配 ${nets.join(' + ')} = ${nets.reduce((a, b) => a + b, 0)}mm`,
    size: 120,
    layer: L_TEXT,
    align: 'r',
  });
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

  // ── 正视图 / 内部图共用的箱体绘制（两者方向完全相同，只差门 / 抽面画不画）──
  function drawFrontLike(P: ViewPainter, withFronts: boolean): void {
    const hidden = withFronts ? undefined : HIDDEN_DASH;

    P.rect(t, W - t, 0, bodyLift, layerOfThickness(t), 1); // 踢脚板
    P.rect(0, t, bodyLift, H, layerOfThickness(t), 1); // 左侧板
    P.rect(W - t, W, bodyLift, H, layerOfThickness(t), 1); // 右侧板
    P.rect(t, W - t, H - t, H, layerOfThickness(t), 1); // 顶板
    P.rect(t, W - t, bodyLift, bodyLift + t, layerOfThickness(t), 1); // 底板

    for (let i = 0; i < unitCount - 1; i++) {
      const dx = unitX0[i] + nets[i];
      P.rect(dx, dx + t, innerBottomZ, innerTopZ, layerOfThickness(t), 1); // 中立板
    }

    cab.layout.units.forEach((u, i) => {
      const x0 = unitX0[i];
      const netW = nets[i];

      if (u.shelves && u.shelves.count > 0) {
        const s = shelfSpanX(i);
        equalSpacing(innerH, u.shelves.count).forEach((pos) => {
          P.rect(s.a, s.b, innerBottomZ + pos, innerBottomZ + pos + t, layerOfThickness(t), 1);
        });
      }

      if (u.drawers) {
        const d = u.drawers;
        const cellH = drawerCellHeights(u, innerH, rules);
        let z = innerBottomZ + d.gap;
        for (const ch of cellH) {
          P.rect(x0 + d.gap, x0 + netW - d.gap, z, z + ch - 2 * d.gap, L_FRONT, withFronts ? 1.8 : 1.2, hidden);
          z += ch + d.gap;
        }
      }

      if (u.doors) {
        const dr = u.doors;
        const widths = doorWidths(u, netW, rules);
        let x = x0 + dr.gapOuter;
        for (const w of widths) {
          P.rect(
            x,
            x + w,
            innerBottomZ + dr.gapOuter,
            innerBottomZ + innerH - dr.gapOuter,
            L_FRONT,
            withFronts ? 1.8 : 1.2,
            hidden
          );
          x += w + dr.gapMid;
        }
      }

      if (u.rod && u.rod.count > 0) {
        const rz = innerBottomZ + u.rod.heightFromBottom;
        P.line(x0 + 2, x0 + netW - 2, rz, rz, L_HW, 1.6, ROD_DASH);
      }
    });

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

    // ① 各分区净宽属于顶部那条尺寸链，位置由尺寸链定死：只登记占位，不参与让路
    const dimZ = innerTopZ - 250;
    for (let i = 0; i < unitCount; i++) {
      const cx = unitX0[i] + nets[i] / 2;
      placer.reserve(cx, dimZ, `${nets[i]}`, 108, 'c');
      P.text(cx, dimZ, `${nets[i]}`, 108, L_DIM, 'c');
    }

    // ② 侧板：板件又高又窄，横排文字必然伸进分区里压住抽屉说明 —— 竖排贴在板上
    put(t / 2, midZ, '左侧板', 118, L_TEXT, 'c', 90);
    put(W - t / 2, midZ, '右侧板', 118, L_TEXT, 'c', 90);

    // ③ 踢脚板 → 底板 → 顶板：**先放下面的**。
    // 避让器优先向上让，如果先放底板，踢脚板的标签会被顶到 245 那条线以上，
    // 于是图上出现"踢脚板在底板上面"的倒序 —— 那是会误导人的。先放踢脚板，
    // 被顶上去的就变成底板，读数顺序与实物上下一致。
    put(W / 2, bodyLift / 2, `踢脚板 H=${bodyLift}`, 108, L_TEXT, 'c');
    put(W / 2, bodyLift + t / 2, '底板', 118, L_TEXT, 'c');
    put(W / 2, H - t / 2, '顶板', 118, L_TEXT, 'c');

    // ④ 中立板：贴着分隔板放，但压低到分区说明带以下，免得跟挂衣杆说明抢同一行
    for (let i = 0; i < unitCount - 1; i++) {
      put(unitX0[i] + nets[i] + t / 2, innerBottomZ + 260, `中立板${i + 1}`, 108, L_TEXT, 'c');
    }

    // ⑤ 各分区内部说明
    cab.layout.units.forEach((u, i) => {
      const cx = unitX0[i] + nets[i] / 2;

      if (u.shelves && u.shelves.count > 0) {
        const positions = equalSpacing(innerH, u.shelves.count);
        const zLow = innerBottomZ + positions[0];
        put(cx, zLow + t + 180, `层板 ×${u.shelves.count}`, 108, L_TEXT, 'c');
      }
      if (u.drawers) {
        put(cx, innerBottomZ + innerH * 0.55, `抽屉面板 ×${u.drawers.count}`, 112, L_TEXT, 'c');
      }
      if (u.rod && u.rod.count > 0) {
        put(cx, innerBottomZ + u.rod.heightFromBottom + 190, `挂衣杆 · 距内底 ${u.rod.heightFromBottom}`, 108, L_HW, 'c');
      }
      if (u.doors) {
        put(cx, innerTopZ - 620, `门板 ×${u.doors.count}（已移开）`, 108, L_TEXT, 'c');
      }
    });

    // ⑥ 最长的一句补充说明最后放：它是解释性的，最该给别人让路。
    // 另外把字数压到 8 个字 —— 原来的"（虚线 = 移去抽屉面板后所见）"
    // 算出来 1496mm 宽，而抽屉分区净宽只有 582mm，文字会溢出视图左边界 400 多毫米。
    cab.layout.units.forEach((u, i) => {
      if (!u.drawers) return;
      const cx = unitX0[i] + nets[i] / 2;
      put(cx, innerBottomZ + innerH * 0.55 - 200, '虚线 = 移去后所见', 95, L_TEXT, 'c');
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
  let cursor = 0;

  for (const cab of project.cabinets) {
    let vs: ViewSet;
    try {
      vs = buildCabinetViews(cab, rules, { x: cursor, y: 0 });
    } catch {
      continue; // 单柜派生失败不能拖垮整幅图（与 generateProject 同样的容错策略）
    }
    const { W, D } = vs.dims;
    const occupied = W + vs.gaps.gapSide + D + vs.gaps.gapInt + W;

    prims.push(...vs.prims.front, ...vs.prims.top, ...vs.prims.side, ...vs.prims.internal, ...vs.hinge, ...vs.labels);
    pickLines.push(...vs.pickLines);

    placements[cab.id] = { x: cursor, y: 0 };
    titles.push({ cabinetId: cab.id, name: cab.name, at: { x: cursor + occupied / 2, y: 0 } });
    for (const a of vs.assumptions) seen.set(a, (seen.get(a) ?? 0) + 1);

    cursor += occupied + CABINET_VIEW_GAP;
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
