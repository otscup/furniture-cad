import type {
  Cabinet,
  CabinetDerived,
  CabinetRow,
  DerivedRow,
  DrawerSpec,
  RowHeightCheck,
  RuleSet,
  UnitSpec,
} from '../types.ts';
import { allocateWidths, splitEqual, type RemainderPolicy } from '../allocate.ts';
import { ROW_HEIGHT_FILL, SINGLE_ROW_ID, canonicalUnits, layoutRows } from '../layoutModel.ts';

/**
 * 柜体派生骨架 —— 生成器、校验器、属性面板、UI 全部共用这一份。
 * 任何"再算一遍"的重复实现，都是图料不一致的种子。禁止。
 */
export type CabinetLayoutResult = CabinetDerived;

/**
 * ══════════════════════════════════════════════════════════════════════
 *  行高解算 —— 高度维度的**唯一**分配实现
 *
 *  与宽度维度对称：宽度由 `allocateWidths` 分（**每行独立执行**），
 *  高度由这里分。两者都在派生层，谁都不许在别处再写一遍。
 *
 *  ── 高度链 ──
 *    `Σ(行净高) + (行数−1)×板厚 === 内空高`
 *    自由项只有一个：`'fill'` 行吃掉 `可用总高 − 固定行高之和`。
 *    这条恒等式成立时，行隔板、各行净高、图上的 Z 位置三者互相锁死，不会漂。
 *
 *  ── 为什么"非法配置"也要给出确定的数字 ──
 *    校验器只能校验**生成器的输出**（铁律：不许自己另算一遍再判）。
 *    所以非法配置下这里不抛错、也不返回 NaN，而是给一份 best-effort 布局
 *    （保证每行净高 ≥1mm）让柜体照常可画，同时把原因码交出去由校验器翻成人话。
 *    "画不出来 + 界面空白"比"画出来 + 一条说清差多少 mm 的报错"糟得多。
 * ══════════════════════════════════════════════════════════════════════
 */
export function resolveRowHeights(
  rows: CabinetRow[],
  innerH: number,
  boardT: number,
  policy: RemainderPolicy = 'bottom'
): { netH: number[]; check: RowHeightCheck } {
  const n = rows.length;
  const dividerTotal = Math.max(0, n - 1) * boardT;
  const available = innerH - dividerTotal;
  const numeric: Array<number | null> = rows.map((r) => (typeof r.height === 'number' ? r.height : null));
  const badCount = numeric.filter((v) => v !== null && (!Number.isInteger(v) || v <= 0)).length;
  const fillIdx = rows.map((r, i) => (r.height === ROW_HEIGHT_FILL ? i : -1)).filter((i) => i >= 0);
  const fixedSum = numeric.reduce<number>((a, v) => a + (v ?? 0), 0);
  const fillIndex = fillIdx.length === 1 ? fillIdx[0]! : -1;

  const netH = new Array<number>(n).fill(0);
  const sane = (v: number | null): number => (v !== null && Number.isInteger(v) && v >= 1 ? v : 0);
  if (fillIndex >= 0) {
    const rest = available - fixedSum;
    // 溢出时夹到 1mm：图面仍画得出来，报错由校验器给（不静默把柜子做小）
    netH[fillIndex] = rest >= 1 ? rest : 1;
    for (let i = 0; i < n; i++) {
      if (i === fillIndex) continue;
      netH[i] = sane(numeric[i]) || 1;
    }
  } else {
    // 没有 'fill'：逐行用固定高；高度值本身非法的行用等分兜底（HEIGHT-BAD 会报）
    const eq = splitEqual(Math.max(1, available), n, 0, policy);
    for (let i = 0; i < n; i++) netH[i] = sane(numeric[i]) || eq[i]!;
  }

  let code: RowHeightCheck['code'];
  if (badCount > 0) code = 'HEIGHT-BAD';
  else if (fillIdx.length > 1) code = 'FILL-DUP';
  else if (fillIndex >= 0 && fillIndex !== n - 1) code = 'FILL-NOT-LAST';
  else if (fillIndex >= 0 && available - fixedSum < 1) code = 'FILL-OVERFLOW';
  else if (fillIndex < 0 && fixedSum !== available) code = 'SUM-MISMATCH';

  const check: RowHeightCheck = {
    ok: code === undefined,
    ...(code ? { code } : {}),
    rowCount: n,
    fixedSum,
    available,
    diff: fixedSum - available,
    fillIndex,
    fillCount: fillIdx.length,
  };
  return { netH, check };
}

/**
 * 一行的水平分区分配。
 *
 * **每行独立执行** —— 不把多行的分区展平成一个数组再算：
 * 展平会让"上行 2 格、下行 3 格"算成 5 格分同一段净宽，净宽全部错，
 * 而错得毫无征兆（宽度链恒等式只在"整柜"口径下检查，展平后照样成立）。
 */
function allocateRowWidths(
  units: UnitSpec[],
  innerW: number,
  boardT: number
): { netTotal: number; nets: number[]; unitX0: number[] } {
  const n = units.length;
  const netTotal = innerW - (n - 1) * boardT;
  const nets = allocateWidths(netTotal, units.map((u) => u.requestedWidth));
  const unitX0: number[] = [];
  let x = boardT;
  for (let i = 0; i < n; i++) {
    unitX0.push(x);
    x += nets[i]!;
    if (i < n - 1) x += boardT;
  }
  return { netTotal, nets, unitX0 };
}

export function computeCabinetLayout(cab: Cabinet, rules: RuleSet): CabinetDerived {
  const p = cab.params;
  const boardT = rules.materials[p.boardMaterial].thickness;
  const backT = rules.materials[p.backPanel.material].thickness;
  const bodyH = p.height - p.bodyLift;
  const innerW = p.width - 2 * boardT;
  const innerH = bodyH - 2 * boardT;
  /** 柜内底面 Z（底板上表面）—— 行 Z 累加的起点 */
  const innerBottomZ = p.bodyLift + boardT;

  /**
   * 双面柜（岛台）：backUnits 存在才按双面派生。
   * type='double' 但 backUnits 缺失 = 自相矛盾的模型 —— 这里**不猜**，
   * 按 row 派生让柜体保持可画，由校验器报 ERROR 说清差在哪。
   */
  const isDouble = cab.layout.type === 'double' && Array.isArray(cab.layout.backUnits) && cab.layout.backUnits.length > 0;

  /**
   * 垂直行的来源。**双面柜按单行处理**：行隔板会与共用中板抢同一段空间，
   * 而"两排 × 多行"的语义（行隔板要不要穿中板、两排的行要不要对齐）本阶段
   * 没有定义 —— 与其猜一个画出来，不如让校验器明确报"本阶段不支持"
   * （RULE-ROW-DOUBLE-UNSUPPORTED）。宁可报错，不可安静地画错。
   */
  const rowSource: CabinetRow[] = isDouble
    /**
     * 用 **canonical 的第一行**（而不是 `cab.layout.units`）：
     * 多行柜按约定不写 units 镜像，直接读 `layout.units` 会拿到空数组 ——
     * 于是 `allocateRowWidths([], …)` 算出 `netTotal = innerW + 板厚`（n−1 = −1），
     * 派生给出一个**荒谬的数字**，柜体变成 0 分区。虽然校验器仍会报"不支持"，
     * 但界面读数是错的。取第一行：柜体照常可画，报错由校验器给。
     */
    ? [{ id: SINGLE_ROW_ID, height: ROW_HEIGHT_FILL, units: canonicalUnits(cab.layout) }]
    : layoutRows(cab.layout);

  const { netH, check } = resolveRowHeights(rowSource, innerH, boardT, rules.policy.remainderPolicy);

  /**
   * 行的 Z 位置：`rows[0]` 在最上面，所以从**最后一行往上**累加。
   * 底行内空底 = 柜内底；每往上一层加 `上行净高 + 一块行隔板`。
   */
  const z0s = new Array<number>(rowSource.length).fill(innerBottomZ);
  {
    let cursor = innerBottomZ;
    for (let i = rowSource.length - 1; i >= 0; i--) {
      z0s[i] = cursor;
      cursor += netH[i]! + boardT;
    }
  }

  const rows: DerivedRow[] = rowSource.map((r, i) => {
    const w = allocateRowWidths(r.units, innerW, boardT);
    const z0 = z0s[i]!;
    return {
      id: r.id,
      panelTag: rowSource.length > 1 ? `R${i + 1}_` : '',
      height: r.height,
      units: r.units,
      netH: netH[i]!,
      ...w,
      z0,
      z1: z0 + netH[i]!,
    };
  });
  /** 行隔板（贯通横隔板）的 Z 区间下沿，自上而下：第 k 块在 rows[k] 与 rows[k+1] 之间 */
  const rowDividers: number[] = [];
  for (let k = 0; k < rows.length - 1; k++) rowDividers.push(rows[k + 1]!.z1);

  /** 兼容视图：`rows[0]`（单行柜 = 整柜）。多行柜下它只代表最上面那一行，见 types.ts */
  const first = rows[0]!;

  if (isDouble) {
    // 排深：总深扣掉中板后前后对半；D-t 为奇数时前排（前脸）多 1mm，
    // 保证 frontRowDepth + midT + backRowDepth === depth 严格成立。
    const rest = p.depth - boardT;
    const backRowDepth = Math.floor(rest / 2);
    const frontRowDepth = rest - backRowDepth;
    const midY0 = backRowDepth;

    const backUnits = cab.layout.backUnits!;
    const m = backUnits.length;
    const backNetTotal = innerW - (m - 1) * boardT;
    const backNets = allocateWidths(backNetTotal, backUnits.map((u) => u.requestedWidth));

    const backUnitX0: number[] = [];
    let bx = boardT;
    for (let i = 0; i < m; i++) {
      backUnitX0.push(bx);
      bx += backNets[i]!;
      if (i < m - 1) bx += boardT;
    }

    return {
      boardT,
      backT,
      bodyH,
      innerW,
      innerH,
      netTotal: first.netTotal,
      nets: first.nets,
      unitX0: first.unitX0,
      // 双面柜没有背板槽：层板/过梁板直接贴到前脸让位为止（后排对称）
      shelfDepth: frontRowDepth - p.shelfFrontClearance,
      rows,
      rowDividers,
      heightChain: check,
      double: {
        frontRowDepth,
        backRowDepth,
        midT: boardT,
        midY0,
        backNets,
        backUnitX0,
        backNetTotal,
        backShelfDepth: backRowDepth - p.shelfFrontClearance,
      },
    };
  }

  return {
    boardT,
    backT,
    bodyH,
    innerW,
    innerH,
    netTotal: first.netTotal,
    nets: first.nets,
    unitX0: first.unitX0,
    shelfDepth: p.depth - (p.backPanel.grooveSetback + p.backPanel.grooveDepth) - p.shelfFrontClearance,
    rows,
    rowDividers,
    heightChain: check,
  };
}

/** 抽屉分格高度（从下往上）。余量归属由规则集 policy.remainderPolicy 决定。 */
export function drawerCellHeights(
  unit: UnitSpec,
  innerH: number,
  rules: RuleSet
): number[] {
  const d = unit.drawers!;
  return splitEqual(innerH, d.count, (d.count + 1) * d.gap, rules.policy.remainderPolicy);
}

/** 门板宽度（从左往右，已扣缝隙） */
export function doorWidths(unit: UnitSpec, netW: number, rules: RuleSet): number[] {
  const dr = unit.doors!;
  const availW = netW - 2 * dr.gapOuter - (dr.count - 1) * dr.gapMid;
  return splitEqual(availW, dr.count, 0, rules.policy.remainderPolicy);
}

/** 背板尺寸（含嵌入槽的装配余量） */
export function backPanelSize(cab: Cabinet, layout: CabinetLayoutResult): { w: number; h: number } {
  const bp = cab.params.backPanel;
  return {
    w: layout.innerW + 2 * bp.grooveDepth - 2 * bp.clearance,
    h: layout.innerH + 2 * bp.grooveDepth - 2 * bp.clearance,
  };
}

/**
 * ══════════════════════════════════════════════════════════════════════
 *  背板超幅拆分方案
 *
 *  为什么必须放在这里而不是留在 generate.ts 里：
 *    分解图（爆炸图）要按"实际会生产出来的那几块背板"逐块摆放并编号。
 *    如果 assembly.ts 自己再算一遍 nW/nH，"清单里 6 块、图上画 4 块"
 *    这类不一致就会在没有任何人察觉的情况下产生 —— 而它正是本项目
 *    第一条铁律要防的东西。**同一份尺寸只许有一处实现。**
 *
 *  算法（与 Phase 0 实测一致）：
 *    两种摆放方式算块数，取总块数更少的一种
 *      A：块宽 ≤ 短板边，块高 ≤ 长板边
 *      B：块宽 ≤ 长板边，块高 ≤ 短板边
 *    只拆一个方向是不够的：宽高都超幅时（例如 2442×2327）单方向拆完
 *    仍然放不下，正确的行为是拆成网格。见 mem_001_backsplit_grid。
 * ══════════════════════════════════════════════════════════════════════
 */
export interface BackSplit {
  /** 背板展开尺寸（未拆分前） */
  w: number;
  h: number;
  /** 拆分后的列数 / 行数 */
  nW: number;
  nH: number;
  /** 总块数 = nW × nH */
  pieces: number;
  /** 每列的宽度（从左到右），和 === w */
  colW: number[];
  /** 每行的高度（从下到上），和 === h */
  rowH: number[];
  /** 是否真的拆了（pieces > 1） */
  split: boolean;
  /**
   * 摆放取向（开料时工人需要知道"块对板材的哪条边"）：
   *   'A' = 块宽对短板边、块高对长板边（planA，列更多）
   *   'B' = 块宽对长板边、块高对短板边（planB，行更多）
   * 不拆块（pieces === 1）时同样给出取向 —— 单块背板进板材也有方向问题。
   */
  orientation: 'A' | 'B';
}

export function backPanelSplit(cab: Cabinet, layout: CabinetLayoutResult, rules: RuleSet): BackSplit {
  const size = backPanelSize(cab, layout);
  const [sheetL, sheetS] = rules.limits.maxSheetSize;
  const planA = { nW: Math.ceil(size.w / sheetS), nH: Math.ceil(size.h / sheetL) };
  const planB = { nW: Math.ceil(size.w / sheetL), nH: Math.ceil(size.h / sheetS) };
  const useA = planA.nW * planA.nH <= planB.nW * planB.nH;
  const nW = Math.max(1, useA ? planA.nW : planB.nW);
  const nH = Math.max(1, useA ? planA.nH : planB.nH);
  const pieces = nW * nH;
  return {
    w: size.w,
    h: size.h,
    nW,
    nH,
    pieces,
    // 余量归属按规则集 policy —— 与 generate.ts 原实现同为 'bottom'
    colW: splitEqual(size.w, nW, 0, rules.policy.remainderPolicy),
    rowH: splitEqual(size.h, nH, 0, rules.policy.remainderPolicy),
    split: pieces > 1,
    orientation: useA ? 'A' : 'B',
  };
}

/**
 * 抽屉箱体滑轨侧的安装间隙（每侧扣减量的两倍）。
 *
 * 这个 25 原本是散在 generate.ts 里的一个魔法数，现在提出来命名并集中，
 * 因为分解图也要用它把抽屉侧板摆到正确位置。**它是工厂参数**，
 * 应该由规则集提供；在规则集补上之前，这里如实标明是内置默认值。
 */
export const DRAWER_BOX_SIDE_CLEARANCE = 25;

/** 抽屉箱体的派生尺寸（生成器与分解图共用这一份，禁止各自再算） */
export interface DrawerBoxParts {
  /** 箱体外高 */
  boxH: number;
  /** 箱体外宽（两外侧板外表面之间） */
  boxW: number;
  /** 侧板长（= 滑轨长度，沿进深方向） */
  sideLen: number;
  /** 后板长 */
  backLen: number;
  /** 底板裁切长 */
  bottomL: number;
  /** 底板裁切宽 */
  bottomW: number;
}

export function drawerBoxParts(d: DrawerSpec, frontH: number, netW: number): DrawerBoxParts {
  const boxW = netW - DRAWER_BOX_SIDE_CLEARANCE;
  const backLen = boxW - 2 * d.sideThickness;
  return {
    boxH: frontH - d.boxHeightDeduct,
    boxW,
    sideLen: d.runnerLength,
    backLen,
    bottomL: d.runnerLength + 2 * d.bottomGrooveDepth - 1,
    bottomW: backLen + 2 * d.bottomGrooveDepth - 1,
  };
}
