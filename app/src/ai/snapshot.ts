import type { Cabinet, Project, RuleSet, UnitSpec } from '../core/types.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  项目快照 —— 发给 AI 的**唯一**一份项目信息
 *
 *  这个文件的全部意义在于：**白名单投影**。
 *
 *  为什么不能用黑名单（"把 derived / panels / issues 删掉再发"）：
 *    模型会长出新字段。今天 `project.cabinets[i].derived` 里有面板清单，
 *    下个月可能叫 `assembly`，再下个月叫 `parts`。黑名单每漏一个名字，
 *    就把一批派生数据喂回了 AI —— 而 AI 一旦"看到"了板件尺寸，
 *    它就会开始输出板件尺寸。这是最容易发生、也最难察觉的腐蚀。
 *
 *  白名单的写法保证：**没显式列出来的字段，结构上不可能出现在快照里**。
 *  连 `derived` 这个字段长什么样都不需要知道。
 *
 *  ── 三条不变量（由 verify/ai-acceptance.ts 常驻断言）──
 *    I1 快照里不存在任何派生字段名（derived / panels / issues / geom / views / assembly / explode / hardware / legend）
 *    I2 往项目里塞一个假的 derived.panels，快照里不许出现它的任何内容
 *    I3 快照里不存在几何数值（任何长度为 2/6 的坐标数组、任何 "pts"/"path"/"poly" 字段）
 *
 *  ── 另一件必须做的事：数字要"够用但不精确到假" ──
 *    快照给的尺寸全部是**四舍五入到 1mm 的整数**（模型里本来就是整数）。
 *    AI 需要的是"这个柜子 2400 宽"，不是 2399.9997。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 规则集里对 AI **只读**可见的部分 —— 目的是让它知道边界，而不是让它有得改 */
export interface AiRuleLimits {
  /**
   * 板材幅面。**刻意写成 {long, short} 而不是 [2440, 1220]** ——
   * 裸的二元数字数组与"坐标点"在结构上无法区分，
   * 而验收里有一条断言专门在快照里搜"长度为 2 的数字数组"（那是几何泄漏的信号）。
   * 与其给那条断言开一个例外，不如把数据形状改得没有歧义。
   */
  maxSheetSize: { long: number; short: number };
  minPanelSize: number;
  maxDoorWidth: number;
  maxDoorHeight: number;
  maxShelfSpan: number;
  maxSingleCabinetHeight: number;
  maxSingleCabinetWidth: number;
  hingeSpacingMax: number;
  remainderPolicy: string;
}

export interface AiSnapshot {
  contractVersion: string;
  projectName: string;
  rooms: Array<{ index: number; id: string; name: string; wallCount: number }>;
  /**
   * 材质 id → 中文名 / 厚度 / 能力。
   *
   * 为什么能力要分两个标志而不是一个 canSelect：
   * 规则集里的 kind 只有 'board' / 'back' 两种，而 5mm 抽底板和 9mm 背板
   * **kind 都是 'back'** —— 只用 kind 会把"拿 5mm 板当柜体板"放行。
   * 能力由规则集的 kind 推导，但推导规则写在一处（本文件），
   * 契约、校验器、编译器三方都读它，谁都不许自己再判一遍。
   */
  materials: Array<{
    id: string;
    name: string;
    thickness: number;
    kind: string;
    canBeBodyBoard: boolean;
    canBeBack: boolean;
  }>;
  limits: AiRuleLimits;
  cabinets: AiCabinetView[];
}

export interface AiCabinetView {
  index: number;
  id: string;
  name: string;
  roomId: string;
  placement: { x: number; y: number; rotation: number };
  params: {
    width: number;
    height: number;
    depth: number;
    bodyLift: number;
    boardMaterial: string;
    backPanelMaterial: string;
  };
  layout: {
    widthMode: 'fit_total' | 'fit_units';
    units: AiUnitView[];
  };
}

export interface AiUnitView {
  /** 1 起的序号 —— 给 AI 看的引用口径，与 target.unit 对应 */
  index: number;
  id: string;
  kind: UnitSpec['kind'];
  nickname: string | null;
  requestedWidth: number;
  drawers: { count: number; runnerLength: number } | null;
  shelves: { count: number } | null;
  doors: { count: number; gapOuter: number; gapMid: number } | null;
  rod: { count: number; heightFromBottom: number } | null;
}

export const CONTRACT_VERSION_FOR_SNAPSHOT = '1.0.0';

/** 四舍五入到 1mm —— 见文件头"另一件必须做的事" */
const mm = (v: number): number => Math.round(v);

/**
 * 项目 + 规则集 → 快照。
 *
 * ⚠ 本函数**一个字段一个字段地手写**，不许用 `{...cab}` 展开。
 *   展开会把未来新增的字段一起带出去 —— 那正是白名单想防的事。
 */
export function buildSnapshot(project: Project, rules: RuleSet): AiSnapshot {
  const rooms = project.rooms.map((r, i) => ({
    index: i + 1,
    id: r.id,
    name: r.name,
    wallCount: r.walls?.length ?? 0,
  }));

  const materials = Object.entries(rules.materials).map(([id, m]) => ({
    id,
    name: m.name,
    thickness: m.thickness,
    kind: m.kind,
    // 柜体结构板必须来自 kind === 'board' 的板；背板可以是 board 或 back
    canBeBodyBoard: m.kind === 'board',
    canBeBack: m.kind === 'board' || m.kind === 'back',
  }));

  return {
    contractVersion: CONTRACT_VERSION_FOR_SNAPSHOT,
    projectName: project.name,
    rooms,
    materials,
    limits: {
      maxSheetSize: { long: rules.limits.maxSheetSize[0], short: rules.limits.maxSheetSize[1] },
      minPanelSize: rules.limits.minPanelSize,
      maxDoorWidth: rules.limits.maxDoorWidth,
      maxDoorHeight: rules.limits.maxDoorHeight,
      maxShelfSpan: rules.limits.maxShelfSpan,
      maxSingleCabinetHeight: rules.limits.maxSingleCabinetHeight,
      maxSingleCabinetWidth: rules.limits.maxSingleCabinetWidth,
      hingeSpacingMax: rules.limits.hingeSpacingMax,
      remainderPolicy: rules.policy.remainderPolicy,
    },
    cabinets: project.cabinets.map((cab, i) => cabinetView(cab, i)),
  };
}

function cabinetView(cab: Cabinet, i: number): AiCabinetView {
  return {
    index: i + 1,
    id: cab.id,
    name: cab.name,
    roomId: cab.roomId,
    placement: {
      x: mm(cab.placement.x),
      y: mm(cab.placement.y),
      rotation: cab.placement.rotation,
    },
    params: {
      width: mm(cab.params.width),
      height: mm(cab.params.height),
      depth: mm(cab.params.depth),
      bodyLift: mm(cab.params.bodyLift),
      boardMaterial: cab.params.boardMaterial,
      backPanelMaterial: cab.params.backPanel.material,
    },
    layout: {
      widthMode: cab.layout.widthMode,
      units: cab.layout.units.map((u, j) => unitView(u, j)),
    },
  };
}

function unitView(u: UnitSpec, j: number): AiUnitView {
  return {
    index: j + 1,
    id: u.id,
    kind: u.kind,
    nickname: u.nickname ?? null,
    requestedWidth: mm(u.requestedWidth),
    // 每一个子规格都显式列出"没有就是 null"，让模型能判断"这个分区没有抽屉"
    drawers: u.drawers ? { count: u.drawers.count, runnerLength: mm(u.drawers.runnerLength) } : null,
    shelves: u.shelves ? { count: u.shelves.count } : null,
    doors: u.doors ? { count: u.doors.count, gapOuter: u.doors.gapOuter, gapMid: u.doors.gapMid } : null,
    rod: u.rod ? { count: u.rod.count, heightFromBottom: mm(u.rod.heightFromBottom) } : null,
  };
}

/**
 * 校验函数的运行时上下文：枚举取值来自规则集，而规则集是可换的，
 * 所以契约（静态）只声明"这是材质 id"，真正的取值在这里注入。
 */
export function snapshotContext(snapshot: AiSnapshot): { bodyMaterials: string[]; backMaterials: string[]; roomCount: number } {
  return {
    bodyMaterials: snapshot.materials.filter((m) => m.canBeBodyBoard).map((m) => m.id),
    backMaterials: snapshot.materials.filter((m) => m.canBeBack).map((m) => m.id),
    roomCount: snapshot.rooms.length,
  };
}

/** 快照的字节数 —— 界面要如实显示"这次给模型发了多少"，超了让人自己判断 */
export function snapshotBytes(snapshot: AiSnapshot): number {
  return new TextEncoder().encode(JSON.stringify(snapshot)).length;
}
