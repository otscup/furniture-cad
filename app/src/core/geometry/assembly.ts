import type { Cabinet, HardwareItem, Panel, RuleSet, UnitSpec } from '../types.ts';
import { equalSpacing } from '../allocate.ts';
import {
  backPanelSplit,
  doorWidths,
  drawerBoxParts,
  drawerCellHeights,
  type CabinetLayoutResult,
} from './layout.ts';
import { generateCabinet } from './generate.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  装配分解数据源 —— 每块板在柜体三维空间里的确切位置
 *
 *  为什么需要这样一个东西：
 *    开料清单（Panel[]）只有**裁切尺寸**，没有位置 —— 它是给开料机看的，
 *    天然不需要位置。而"分解图用于生产"要求每块板出现在它**将要被装到**
 *    的地方，还得能跟清单逐项对上号。于是必须在派生层补一层三维装配信息。
 *
 *  ── 三条不可违背的规矩 ──
 *   1. **清单是输入，不是重算对象**。本文件调用 generateCabinet(cab, rules)
 *      直接拿它产出的 panels[]，遍历顺序就当作件号顺序。
 *      所以"分解图件数 = 清单件数"是结构性的，不靠两边写对。
 *   2. **一个尺寸只许有一处实现**。背板拆几块、抽屉箱体多高多宽，都取自
 *      layout.ts 的 backPanelSplit / drawerBoxParts —— 与开料清单同一份。
 *      本文件里没有任何一处 `p.width - 2 * t` 这样的新算式。
 *   3. **模型没定义的东西不许编**。摆位基准缺失时用**显式声明的约定**，
 *      并把约定写进 assumptions / conventionalPlacement 直达界面；
 *      裁切尺寸与摆位尺寸对不上时列进 dimMismatches，不静默对齐。
 *
 *  ── 坐标系（与 views.ts 完全一致，这是"分解图与四视图同源"的前提）──
 *      X ∈ [0, W]  从左到右
 *      Y ∈ [0, D]  从背面到正面（柜体背靠墙的那面是 Y = 0）
 *      Z ∈ [0, H]  从地面到顶
 * ══════════════════════════════════════════════════════════════════════
 */

/** 轴对齐三维包围盒（柜体局部坐标，mm） */
export interface Box3 {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

export interface ExplodeDir {
  axis: 'x' | 'y' | 'z';
  sign: 1 | -1;
}

/** 单个板件实例（qty > 1 的板件会展开成多个实例） */
export interface PartInstance {
  panelId: string;
  /** 件号（1-based）。同一 panel 的多件共用同一个件号 —— 与明细栏一致 */
  no: number;
  /** 该板件在本柜内的第几件（1-based） */
  seq: number;
  role: string;
  nameZh: string;
  group: string;
  material: string;
  thickness: number;
  /** 裁切尺寸：**逐字取自开料清单**，不做任何换算 */
  cut: { length: number; width: number };
  /** 三维包围盒（未爆炸的原位） */
  box: Box3;
  /** 拆卸方向 */
  dir: ExplodeDir;
  /** 爆炸分层（0 = 箱体板，往后依次是内部件 / 抽屉箱 / 抽面 / 门板） */
  tier: number;
  /** 同层同方向内的错开档位（避免多件叠在一条线上） */
  lane: number;
}

/**
 * 爆炸位移方案。
 *
 * 分层（tier）而不是"每件各自随机挪"：真实分解图读起来是一层一层的 ——
 * 先是箱体板向外散开，然后是内部件，再是抽屉箱，再是抽面，最后是门板。
 * 层内再多件同向时用 lane 错开。
 *
 * 方向本身是有语义的：
 *   · 侧板向左右、顶板向上、底板与踢脚板向下 —— 把箱体"剥开"
 *   · 背板向后退（-Y）—— 它本来就在最后面
 *   · 中立板 / 层板 / 抽屉箱 / 抽面 / 门板向前拉（+Y）—— 依次从柜里"抽出来"
 */
const EXPLODE_PLAN: Record<string, { dir: ExplodeDir; tier: number }> = {
  LeftSidePanel: { dir: { axis: 'x', sign: -1 }, tier: 0 },
  RightSidePanel: { dir: { axis: 'x', sign: 1 }, tier: 0 },
  TopPanel: { dir: { axis: 'z', sign: 1 }, tier: 0 },
  BottomPanel: { dir: { axis: 'z', sign: -1 }, tier: 0 },
  KickBoard: { dir: { axis: 'z', sign: -1 }, tier: 0 },
  DividerPanel: { dir: { axis: 'y', sign: 1 }, tier: 0 },
  /**
   * 行隔板（行与行之间的贯通横隔板）。
   * 方向与中立板同（往前拉出来）：它是一块横板，只能从前脸那个方向取出来 ——
   * 往左右拉会和侧板撞、往上/下会和它上下两行的板件混在一条线上。
   */
  RowDividerPanel: { dir: { axis: 'y', sign: 1 }, tier: 0 },
  BackPanel: { dir: { axis: 'y', sign: -1 }, tier: 0 },
  ShelfPanel: { dir: { axis: 'y', sign: 1 }, tier: 1 },
  DrawerSide: { dir: { axis: 'y', sign: 1 }, tier: 2 },
  DrawerBack: { dir: { axis: 'y', sign: 1 }, tier: 2 },
  DrawerBottom: { dir: { axis: 'y', sign: 1 }, tier: 2 },
  DrawerFront: { dir: { axis: 'y', sign: 1 }, tier: 3 },
  DoorPanel: { dir: { axis: 'y', sign: 1 }, tier: 4 },
};

/** 每一层的基准爆炸距离（mm）。索引 = tier */
export const EXPLODE_TIER_BASE = [620, 1500, 2500, 3300, 4300];
/** 同层同向多件之间的错开步长（mm） */
export const EXPLODE_LANE_STEP = 380;

export interface AssemblyCheck {
  /** 明细栏里的板件种类数（应 === 开料清单 panels.length） */
  panelKinds: number;
  /** 明细栏里的总件数（Σ qty，应 === 实际摆出来的实例数） */
  pieces: number;
  /** 实际摆出来的实例数 */
  instances: number;
  /** 认不出 role、摆不出来的板件（必须为空，否则分解图会少件） */
  unplaced: string[];
  /** 摆位槽位数与 qty 不一致的板件（必须为空）—— 这是"qty 忘记展开"的哨兵 */
  slotMismatches: Array<{ panelId: string; nameZh: string; qty: number; slots: number }>;
  /** 用了"约定摆位"（模型未定义装配基准）的板件 */
  conventionalPlacement: Array<{ role: string; nameZh: string; why: string }>;
  /** 裁切尺寸与摆位尺寸对不上的项 —— 如实列出，由人决定改哪一边 */
  dimMismatches: Array<{ panelId: string; nameZh: string; axis: 'depth'; cutMm: number; builtMm: number; deltaMm: number }>;
  /** 结构性核对是否通过（件号 / 件数 / 尺寸轴对齐） */
  ok: boolean;
}

export interface Assembly {
  cabinetId: string;
  cabinetName: string;
  parts: PartInstance[];
  /** 件号 → 明细行（与开料清单逐项对应） */
  legend: Array<{ no: number; panelId: string; nameZh: string; role: string; group: string; material: string; thickness: number; cut: { length: number; width: number }; qty: number }>;
  /**
   * 五金。**不参与爆炸分解** —— 铰链 / 滑轨没有板件那样的装配基准，
   * 把它们按猜测的位置画进爆炸图只会制造假精度。分解图只在明细表下方单列一节。
   */
  hardware: HardwareItem[];
  dims: { W: number; H: number; D: number };
  check: AssemblyCheck;
  assumptions: string[];
}

/** 箱体结构板：裁切清单里的 width 取整柜深，而装配进深不含门板厚 —— 这是已知的语义待确认点 */
const DEPTH_CONFLICT_ROLES = new Set(['LeftSidePanel', 'RightSidePanel', 'TopPanel', 'BottomPanel', 'DividerPanel', 'RowDividerPanel']);

/**
 * 分区定位：分区 id → **它在哪一行**、行内下标，以及该行的几何（净宽 / X 起点 / 内空底 Z / 净高）。
 *
 * ── 为什么必须按行定位（而不是像 v0.2 那样在 `layout.units` 里搜）──
 *   v0.3 起分区有两个坐标：行 + 行内下标。若仍按"整柜一个 units 数组"来搜，
 *   多行柜里**每一行都会命中第 0 行的几何** —— 分解图上所有抽屉箱、层板、门板
 *   全部叠到最上面那一行去，件数照样对得上（所以断言查不出来），
 *   只有人眼看图才会发现"下面那层的板都跑到上面去了"。
 *   本函数是装配侧唯一的"分区 → 几何"入口，所有落位分支都从这里取数。
 */
interface UnitLoc {
  rowIndex: number;
  unitIndex: number;
  unit: UnitSpec;
  /** 该分区净宽 */
  netW: number;
  /** 该分区左边缘 X */
  x0: number;
  /** 该行内空底面 Z */
  z0: number;
  /** 该行净高 */
  netH: number;
  label: string;
}

function locateUnit(L: CabinetLayoutResult, unitId: string): UnitLoc | null {
  for (let ri = 0; ri < L.rows.length; ri++) {
    const r = L.rows[ri]!;
    const ui = r.units.findIndex((u) => u.id === unitId);
    if (ui >= 0) {
      return {
        rowIndex: ri,
        unitIndex: ui,
        unit: r.units[ui]!,
        netW: r.nets[ui]!,
        x0: r.unitX0[ui]!,
        z0: r.z0,
        netH: r.netH,
        label: L.rows.length > 1 ? `第${ri + 1}行·第${ui + 1}区` : `第${ui + 1}区`,
      };
    }
  }
  return null;
}

/**
 * 单个柜体 → 装配分解数据。纯函数，无副作用。
 *
 * ⚠ 注意调用顺序：本函数内部会跑一遍 generateCabinet 以取得开料清单。
 *    它**不缓存**（命令行的 derive 缓存在 CommandBus 里）。分解图是按需派生的，
 *    不要把它塞进每次 derive 都跑的那条路。
 */
export function buildAssembly(cab: Cabinet, rules: RuleSet): Assembly {
  const g = generateCabinet(cab, rules);
  const panels: Panel[] = g.panels;
  const L: CabinetLayoutResult = g.layout;
  const p = cab.params;

  const W = p.width;
  const H = p.height;
  const D = p.depth;
  const t = L.boardT;
  const tb = L.backT;
  const bodyLift = p.bodyLift;
  const innerH = L.innerH;
  const bp = p.backPanel;

  const bodyD = D - t;
  const faceY0 = D - t;
  const faceY1 = D;
  const backY0 = bp.grooveSetback;
  const backY1 = backY0 + tb;
  const shelfY0 = Math.max(bp.grooveSetback + bp.grooveDepth, backY1);
  const shelfY1 = shelfY0 + L.shelfDepth;
  const innerBottomZ = bodyLift + t;

  const backSplit = backPanelSplit(cab, L, rules);
  /** 背板每列的起点 X（从左到右） */
  const colX0: number[] = [];
  {
    let x = t;
    for (const cw of backSplit.colW) {
      colX0.push(x);
      x += cw;
    }
  }
  /** 背板每行的起点 Z（从下到上） */
  const rowZ0: number[] = [];
  {
    let z = innerBottomZ;
    for (const rh of backSplit.rowH) {
      rowZ0.push(z);
      z += rh;
    }
  }

  const parts: PartInstance[] = [];
  const legend: Assembly['legend'] = [];
  const unplaced: string[] = [];
  const conventional = new Map<string, { role: string; nameZh: string; why: string }>();
  const dimMismatches: AssemblyCheck['dimMismatches'] = [];
  const mismatchSlots: AssemblyCheck['slotMismatches'] = [];
  const assumptions: string[] = [];

  const noOf = new Map<string, number>();
  const seqOf = new Map<string, number>();
  const laneKeys = new Map<string, number>();

  const laneFor = (tier: number, dir: ExplodeDir): number => {
    const key = `${tier}|${dir.axis}|${dir.sign}`;
    const n = laneKeys.get(key) ?? 0;
    laneKeys.set(key, n + 1);
    return n;
  };

  const placed = (
    panel: Panel,
    box: Box3,
    opts: { lane?: number; depthConflict?: boolean; conventionalWhy?: string } = {}
  ): void => {
    const plan = EXPLODE_PLAN[panel.role];
    if (!plan) {
      if (!unplaced.includes(panel.role)) unplaced.push(panel.role);
      return;
    }
    if (opts.conventionalWhy && !conventional.has(panel.role)) {
      conventional.set(panel.role, { role: panel.role, nameZh: panel.nameZh, why: opts.conventionalWhy });
    }
    if (!noOf.has(panel.id)) {
      noOf.set(panel.id, noOf.size + 1);
      legend.push({
        no: noOf.get(panel.id)!,
        panelId: panel.id,
        nameZh: panel.nameZh,
        role: panel.role,
        group: panel.group,
        material: panel.material,
        thickness: panel.thickness,
        cut: { length: panel.length, width: panel.width },
        qty: panel.qty,
      });
    }
    const seq = (seqOf.get(panel.id) ?? 0) + 1;
    seqOf.set(panel.id, seq);

    if (opts.depthConflict) {
      const built = box.y1 - box.y0;
      if (Math.round(built) !== Math.round(panel.width)) {
        dimMismatches.push({
          panelId: panel.id,
          nameZh: panel.nameZh,
          axis: 'depth',
          cutMm: panel.width,
          builtMm: built,
          deltaMm: round2(built - panel.width),
        });
      }
    }

    parts.push({
      panelId: panel.id,
      no: noOf.get(panel.id)!,
      seq,
      role: panel.role,
      nameZh: panel.nameZh,
      group: panel.group,
      material: panel.material,
      thickness: panel.thickness,
      cut: { length: panel.length, width: panel.width },
      box: box,
      dir: plan.dir,
      tier: plan.tier,
      lane: opts.lane ?? laneFor(plan.tier, plan.dir),
    });
  };

  // ───────── 逐件遍历开料清单（顺序 === 件号顺序）─────────
  /**
   * 两种"第几件"必须分清，混用会静默错位：
   *   k    —— 分区内的序号（第几个层板 / 第几格抽屉 / 第几扇门），来自 panel.id 的数字后缀
   *   inst —— 同一 panel 的第几个实例（0-based），即 qty 展开的序号
   *
   * **qty 必须展开**：开料清单里"抽屉侧板 ×2"是一行，但分解图上是两块板。
   * 不展开就会静默少件（实测过：清单 31 件、图上 28 件），
   * 而"图上件数 = 清单件数"正是这张图能用于生产的前提。
   */
  const idIndex = (panel: Panel): number => Math.max(0, Number(/(\d+)$/.exec(panel.id)?.[1] ?? '1') - 1);

  /**
   * 中立板 / 行隔板的面板 id → 它在哪一行、行内第几块。
   *
   * 为什么是"查表"而不是"解析 id 字符串"：
   *   这两类板件的 id 由 generate.ts 用 `panelTag` 拼出来（`P_cab_R1_DIV2`），
   *   而 `panelTag` 是派生层保证唯一性的手段（单行 = `''`）。若这里自己写正则去猜
   *   "id 里第几段是行号"，就出现了**第二处**对同一编码的解释 ——
   *   一旦 tag 规则变了（比如行号到两位数），两处一起错而不报错。
   *   直接按生成器的拼法建表，两边结构性地锁死。
   */
  const dividerSlots = new Map<string, { rowIndex: number; unitIndex: number }>();
  const rowDividerSlots = new Map<string, number>();
  L.rows.forEach((r, ri) => {
    for (let i = 0; i < r.units.length - 1; i++) {
      dividerSlots.set(`P_${cab.id}_${r.panelTag}DIV${i + 1}`, { rowIndex: ri, unitIndex: i });
    }
  });
  L.rowDividers.forEach((_, k) => rowDividerSlots.set(`P_${cab.id}_RD${k + 1}`, k));

  for (const panel of panels) {
    const uid = panel.belongsTo.includes('.') ? panel.belongsTo.slice(panel.belongsTo.indexOf('.') + 1) : '';
    const loc = uid ? locateUnit(L, uid) : null;
    const unit = loc?.unit;
    const netW = loc?.netW ?? 0;
    const x0 = loc?.x0 ?? 0;
    /** 该分区所在行的内空底面 Z 与净高 —— 单行柜 = `innerBottomZ` / `innerH`（与 v0.2 逐位相同） */
    const rowBaseZ = loc?.z0 ?? innerBottomZ;
    const rowNetH = loc?.netH ?? innerH;
    const k = idIndex(panel);
    const qty = Math.max(1, panel.qty);

    /** 该板件每一个实例的落位框 + 错开档位；长度必须 === qty */
    const slots: Array<{ box: Box3; lane?: number; conventionalWhy?: string }> = [];

    switch (panel.role) {
      case 'LeftSidePanel':
        slots.push({ box: { x0: 0, x1: t, y0: 0, y1: bodyD, z0: bodyLift, z1: H } });
        break;
      case 'RightSidePanel':
        slots.push({ box: { x0: W - t, x1: W, y0: 0, y1: bodyD, z0: bodyLift, z1: H } });
        break;
      case 'TopPanel':
        slots.push({ box: { x0: t, x1: W - t, y0: 0, y1: bodyD, z0: H - t, z1: H } });
        break;
      case 'BottomPanel':
        slots.push({ box: { x0: t, x1: W - t, y0: 0, y1: bodyD, z0: bodyLift, z1: bodyLift + t } });
        break;
      case 'KickBoard':
        // 前挡板：贴在底板上方的前沿（与 views.ts 的侧视图取向一致）
        slots.push({ box: { x0: t, x1: W - t, y0: faceY0 - t, y1: faceY0, z0: 0, z1: bodyLift } });
        break;
      case 'DividerPanel': {
        // 逐行定位：多行柜里上下两行的中立板落在不同 X，且高度只跨本行净高
        const slot = dividerSlots.get(panel.id);
        if (!slot) {
          if (!unplaced.includes(panel.role)) unplaced.push(panel.role);
          break;
        }
        const rr = L.rows[slot.rowIndex]!;
        const j = Math.min(slot.unitIndex, rr.unitX0.length - 2);
        const dx = rr.unitX0[j]! + rr.nets[j]!;
        slots.push({ box: { x0: dx, x1: dx + t, y0: 0, y1: bodyD, z0: rr.z0, z1: rr.z1 } });
        break;
      }
      case 'RowDividerPanel': {
        // 行隔板：位置直接取自 `L.rowDividers`（同一份派生量，不在这里重算 z）
        const kk = rowDividerSlots.get(panel.id);
        if (kk === undefined) {
          if (!unplaced.includes(panel.role)) unplaced.push(panel.role);
          break;
        }
        const z = L.rowDividers[kk]!;
        slots.push({ box: { x0: t, x1: W - t, y0: 0, y1: bodyD, z0: z, z1: z + t } });
        break;
      }
      case 'BackPanel': {
        /**
         * 背板是**嵌槽件**：裁切尺寸 = 内空 + 2×(槽深 − 单边余量)，也就是**比内空每侧大**
         * `grooveDepth − clearance`。所以装配时必须**居中于内空开口** ——
         * 每侧伸进槽里 `grooveDepth − clearance`，而不是从内空的左上角起算。
         *
         * （最初就是按"从 t 起算"写的：背板整体偏移 7.5mm，一头捅进侧板 15mm、
         *   另一头差 7.5mm 没进槽。图上看着"差不多"，量一下就露。
         *   B10/B11 的**对称性**断言把它抓了出来。）
         *
         * 注：四视图（views.ts）把背板画成"填满内空开口"（T.rect(t, W−t, …)），
         * 那是立面/剖面图的示意画法，与本处的装配落位不是同一个用途 ——
         * 两处的**裁切尺寸都逐字取自开料清单**，读数不会打架。
         */
        const over = bp.grooveDepth - bp.clearance;
        const r = Math.floor(k / backSplit.nW);
        const c = k % backSplit.nW;
        const cw = backSplit.colW[Math.min(c, backSplit.colW.length - 1)];
        const rh = backSplit.rowH[Math.min(r, backSplit.rowH.length - 1)];
        const cx = colX0[Math.min(c, colX0.length - 1)] - over;
        const cz = rowZ0[Math.min(r, rowZ0.length - 1)] - over;
        slots.push({ box: { x0: cx, x1: cx + cw, y0: backY0, y1: backY1, z0: cz, z1: cz + rh } });
        break;
      }
      case 'ShelfPanel': {
        if (!unit?.shelves || !loc) {
          if (!unplaced.includes(panel.role)) unplaced.push(panel.role);
          break;
        }
        const gap = unit.shelves.gapPerSide;
        const sw = netW - 2 * gap;
        const sa = x0 + (netW - sw) / 2;
        const positions = equalSpacing(rowNetH, unit.shelves.count);
        const pos = positions[Math.min(k, positions.length - 1)]!;
        slots.push({ box: { x0: sa, x1: sa + sw, y0: shelfY0, y1: shelfY1, z0: rowBaseZ + pos, z1: rowBaseZ + pos + t } });
        break;
      }
      case 'DoorPanel': {
        if (!unit?.doors || !loc) {
          if (!unplaced.includes(panel.role)) unplaced.push(panel.role);
          break;
        }
        const dr = unit.doors;
        const widths = doorWidths(unit, netW, rules);
        let cx = x0 + dr.gapOuter;
        for (let j = 0; j < k && j < widths.length; j++) cx += widths[j]! + dr.gapMid;
        slots.push({
          box: {
            x0: cx,
            x1: cx + widths[Math.min(k, widths.length - 1)]!,
            y0: faceY0,
            y1: faceY1,
            z0: rowBaseZ + dr.gapOuter,
            z1: rowBaseZ + dr.gapOuter + (rowNetH - 2 * dr.gapOuter),
          },
        });
        break;
      }
      case 'DrawerFront':
      case 'DrawerSide':
      case 'DrawerBack':
      case 'DrawerBottom': {
        if (!unit?.drawers || !loc) {
          if (!unplaced.includes(panel.role)) unplaced.push(panel.role);
          break;
        }
        const d = unit.drawers;
        const cellH = drawerCellHeights(unit, rowNetH, rules);
        const cell = cellH[Math.min(k, cellH.length - 1)]!;
        let zFront = rowBaseZ + d.gap;
        for (let j = 0; j < k && j < cellH.length; j++) zFront += cellH[j]! + d.gap;
        // 与 generate.ts 的抽屉面板高度口径一致：cell 已由 drawerCellHeights 扣除
        // 全部 (n+1) 道缝，这里直接作为箱体高度，不得再扣 2×gap（否则 3D 落位箱体比
        // 开料清单的裁切尺寸矮 2×gap，B2 的 box/cut 同构检查会失配）。
        const frontH = cell;
        const box = drawerBoxParts(d, frontH, netW);
        /** 箱体在 X 向居中于分区（模型未定义横向基准） */
        const bx0 = x0 + (netW - box.boxW) / 2;
        const bx1 = bx0 + box.boxW;
        const by0 = faceY0 - box.sideLen; // 箱体前端面贴住抽面内侧
        const by1 = faceY0;
        const bz0 = zFront; // 箱体底部与抽面底边对齐（模型未定义，见 conventionalPlacement）
        const bz1 = zFront + box.boxH;

        const why =
          '抽屉箱体（侧板 / 后板 / 底板）的装配基准在模型中未定义：generate.ts 只算出了箱体的裁切尺寸，没有给三维基准。分解图按『X 向在分区内居中、前端面贴住抽面内侧、箱底与抽面底边对齐、底板嵌槽深度 bottomGrooveDepth』的约定摆放；裁切尺寸仍逐字取自开料清单。';

        if (panel.role === 'DrawerFront') {
          slots.push({ box: { x0: x0 + d.gap, x1: x0 + netW - d.gap, y0: faceY0, y1: faceY1, z0: zFront, z1: zFront + frontH }, lane: k });
          break;
        }
        if (panel.role === 'DrawerSide') {
          // qty = 2：0 = 左侧板，1 = 右侧板。**两件都要摆出来**，这是本文件最容易漏的一处。
          for (let s = 0; s < qty; s++) {
            const sx = s === 0 ? bx0 : bx1 - d.sideThickness;
            slots.push({
              box: { x0: sx, x1: sx + d.sideThickness, y0: by0, y1: by1, z0: bz0, z1: bz1 },
              lane: k * 2 + s,
              conventionalWhy: why,
            });
          }
          break;
        }
        if (panel.role === 'DrawerBack') {
          slots.push({
            box: { x0: bx0 + d.sideThickness, x1: bx1 - d.sideThickness, y0: by0, y1: by0 + d.sideThickness, z0: bz0, z1: bz1 },
            lane: k * 2,
            conventionalWhy: why,
          });
          break;
        }
        // DrawerBottom：嵌在两面侧板的槽里，上表面距箱底 bottomGrooveDepth；进深居中于箱体
        const gd = d.bottomGrooveDepth;
        const byPad = (box.sideLen - box.bottomL) / 2;
        slots.push({
          box: {
            x0: bx0 + d.sideThickness - gd,
            x1: bx1 - d.sideThickness + gd,
            y0: by0 + byPad,
            y1: by0 + byPad + box.bottomL,
            z0: bz0 + gd,
            z1: bz0 + gd + d.bottomThickness,
          },
          lane: k * 2 + 1,
          conventionalWhy: why,
        });
        break;
      }
      default:
        if (!unplaced.includes(panel.role)) unplaced.push(panel.role);
        break;
    }

    /** 声明了槽位却与 qty 对不上 → 必须说出来，不能少摆几件了事 */
    if (slots.length > 0 && slots.length !== qty) {
      mismatchSlots.push({ panelId: panel.id, nameZh: panel.nameZh, qty, slots: slots.length });
    }
    for (const s of slots) {
      placed(panel, s.box, {
        lane: s.lane,
        depthConflict: DEPTH_CONFLICT_ROLES.has(panel.role),
        conventionalWhy: s.conventionalWhy,
      });
    }
  }

  // ───────── 核对 ─────────
  const pieces = panels.reduce((a, x) => a + x.qty, 0);
  if (unplaced.length > 0) {
    assumptions.push(
      `⚠ 有 ${unplaced.length} 种板件在装配分解里没有对应的摆位规则（${unplaced.join('、')}）—— 分解图会**少件**，明细栏却仍然列着它们。新增板件类型时必须同时补 EXPLODE_PLAN 与摆位分支。`
    );
  }
  if (mismatchSlots.length > 0) {
    assumptions.push(
      `⚠ 有 ${mismatchSlots.length} 种板件的摆位槽位数与开料清单数量对不上（${mismatchSlots.map((m) => `${m.nameZh} 清单 ${m.qty} 件 / 摆位 ${m.slots} 件`).join('；')}）—— 分解图件数与清单不一致，必须先修摆位分支。`
    );
  }
  if (dimMismatches.length > 0) {
    const sample = dimMismatches[0];
    assumptions.push(
      `⚠ ${dimMismatches.length} 块箱体板的**裁切进深**与**装配进深**相差 ${Math.abs(sample.deltaMm)}mm：裁切清单取 params.depth = ${D}mm，装配按不含门板厚的 ${bodyD}mm 落位。这是 Phase 1 起就记录在案的 depth 语义待确认点（params.depth 到底是含门总深还是箱体深），分解图按装配进深绘制但**照抄清单尺寸**，两边差异如实列出。`
    );
  }
  assumptions.push(
    '分解图只分解**板件**。五金（铰链 / 滑轨 / 挂衣杆 / 层板托 / 拉手）在件号表下方单列一节「五金（不分解）」—— 它们没有板件那样的装配基准，画成爆炸件只会制造假精度。'
  );
  assumptions.push(
    `爆炸位移是按层给定值（${EXPLODE_TIER_BASE.map((v, i) => `第${i + 1}层 ${v}mm`).join(' / ')}），层内多件同向时按 ${EXPLODE_LANE_STEP}mm 递增错开。**位移量是图面表达，没有任何工艺含义** —— 不要把它当成装配顺序或拆卸行程。`
  );

  const ok = unplaced.length === 0 && mismatchSlots.length === 0 && parts.length === pieces && legend.length === panels.length;

  return {
    cabinetId: cab.id,
    cabinetName: cab.name,
    parts,
    legend,
    hardware: g.hardware,
    dims: { W, H, D },
    check: {
      panelKinds: panels.length,
      pieces,
      instances: parts.length,
      unplaced,
      slotMismatches: mismatchSlots,
      conventionalPlacement: [...conventional.values()],
      dimMismatches,
      ok,
    },
    assumptions,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 项目里全部柜体的装配分解（按 cabinets 顺序） */
export function buildProjectAssembly(project: { cabinets: Cabinet[] }, rules: RuleSet): Assembly[] {
  const out: Assembly[] = [];
  for (const cab of project.cabinets) {
    try {
      out.push(buildAssembly(cab, rules));
    } catch {
      // 单柜派生失败不能拖垮整张分解图（与 generateProject / buildProjectViews 同样的容错策略）
    }
  }
  return out;
}
