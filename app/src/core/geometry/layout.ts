import type { Cabinet, CabinetDerived, DrawerSpec, RuleSet, UnitSpec } from '../types.ts';
import { allocateWidths, splitEqual } from '../allocate.ts';

/**
 * 柜体派生骨架 —— 生成器、校验器、属性面板、UI 全部共用这一份。
 * 任何"再算一遍"的重复实现，都是图料不一致的种子。禁止。
 */
export type CabinetLayoutResult = CabinetDerived;

export function computeCabinetLayout(cab: Cabinet, rules: RuleSet): CabinetDerived {
  const p = cab.params;
  const boardT = rules.materials[p.boardMaterial].thickness;
  const backT = rules.materials[p.backPanel.material].thickness;
  const bodyH = p.height - p.bodyLift;
  const innerW = p.width - 2 * boardT;
  const innerH = bodyH - 2 * boardT;
  const n = cab.layout.units.length;
  const netTotal = innerW - (n - 1) * boardT;
  const nets = allocateWidths(netTotal, cab.layout.units.map((u) => u.requestedWidth));

  const unitX0: number[] = [];
  let x = boardT;
  for (let i = 0; i < n; i++) {
    unitX0.push(x);
    x += nets[i];
    if (i < n - 1) x += boardT;
  }

  return {
    boardT,
    backT,
    bodyH,
    innerW,
    innerH,
    netTotal,
    nets,
    unitX0,
    shelfDepth: p.depth - (p.backPanel.grooveSetback + p.backPanel.grooveDepth) - p.shelfFrontClearance,
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
