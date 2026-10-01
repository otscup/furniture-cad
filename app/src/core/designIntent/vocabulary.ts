/**
 * ══════════════════════════════════════════════════════════════════════
 *  设计意图词表（P9.2）—— 封闭、可判定、不含坐标
 *
 *  ── 这一层是什么 ──
 *    「用户到底想要什么」的**有限词汇表**。它回答的是"想要什么效果"，
 *    不是"放在哪"，也不是"和谁连着"。
 *
 *  ── 与 PlacementIntent 的分工（名字像，位置完全不同）──
 *      PlacementIntent（P8.1/P8.2，已有）：**怎么放** —— 贴谁 / 对齐谁 / 哪两个面贴合。
 *                                          它是指令，进 Resolver，**输出坐标**。
 *      DesignIntent（本层，新增）：          **想要什么** —— 贴墙 / 让开门口 / 别挡住开门。
 *                                          它是目标，**不进 Resolver**，今天只被读。
 *    两者是上下游：DesignIntent →（P9.3 枚举）→ PlacementIntent → Resolver → 坐标。
 *    凡是已经能由 PlacementIntent 表达的（放在哪、和谁对齐、和谁贴合），
 *    **一律不属于设计意图** —— 见 §词表里"为什么某些常见的词不收"。
 *
 *  ── 三条准入纪律（少一个词，好过多一个假词）──
 *    ① **可判定**：每一条都给出它将来对账时读哪个**既有**事实维度（`fact`），
 *       并指名该维度的产出文件与信号串；验收会去那个文件里核对信号串真的存在。
 *       指向不存在的事实的词 = 判不出来的词 = 不许进词表。
 *    ② **不重复**：已经能由 PlacementIntent 说的（相邻 / 对齐 / 贴合 / 朝向）不收。
 *       再定义一份 = 第二套对齐真相源（placement.ts 已经为这件事写过一次警告）。
 *    ③ **不含数**：词表里没有任何阈值、距离、尺寸。
 *       "多近算贴墙"是 SPATIAL_TOL.TOUCH；"离洞口多近算靠太近"是 DESIGN_TOL.APPROACH。
 *       阈值是**规则**，不是每条意图各写一个数 —— 否则同一个词在两条意图里意思不同。
 *
 *  ── 唯一的例外：三个"取舍方向" ──
 *    kitchen-workflow / storage-priority / circulation-priority 是**优先级**，
 *    不是事实断言：它们没有 `fact`（判定不出来），作用只体现在后续取舍上。
 *    这是**唯一**允许 `fact === null` 的一类，且必须显式标 class:'priority' ——
 *    验收会断言"fact 为空的词恰好就是 priority 这一类"，防住"随手加个判不出的词"。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { OpeningKind } from '../types.ts';

/**
 * 设计意图的词（闭集）。
 *
 * 命名用**事实维度**（`wall-contact`）而不是祈使句（`prefer-wall`）：
 * 祈使句会诱导下一个人顺手把"多近算贴上"写进意图里 —— 那正是本层最该防的事。
 */
export type DesignIntentGoal =
  // ── 取舍方向（不可判定，只影响后面的取舍）──
  | 'kitchen-workflow'
  | 'storage-priority'
  | 'circulation-priority'
  // ── 空间条件（可判定，依据既有事实维度）──
  | 'wall-contact'
  | 'opening-clear'
  | 'door-swing-clear'
  | 'near-opening'
  | 'standalone'
  | 'room-inside';

/** priority = 取舍方向（无判定依据）；condition = 对既有事实的期望（可判定） */
export type DesignIntentGoalClass = 'priority' | 'condition';

/**
 * 事实维度名（闭集）—— 名字**逐字取既有产出方的字段名**，
 * 不另起一套叫法（`cabinet.wallContacts` 就是 P9.1 空间上下文里的那个字段）。
 */
export type DesignIntentFactDimension =
  /** P9.1 `cabinetFacts[].wallContacts`（上游 P8.7 facts.walls.relation） */
  | 'cabinet.wallContacts'
  /** P9.1 `cabinetFacts[].openingProximity`（上游 P8.7 facts.openings.relation） */
  | 'cabinet.openingProximity'
  /** P9.1 `cabinetFacts[].doorClearances`（上游 P8.9 door.ts） */
  | 'cabinet.doorClearances'
  /** P9.1 `cabinetFacts[].roomRelation`（上游 P8.7 facts.rooms） */
  | 'cabinet.roomRelation'
  /** P2 `relations.deriveContacts()` —— 柜↔柜（P9.1 的快照里没有这一项，见 note） */
  | 'cabinet.contacts';

export interface DesignIntentGoalSpec {
  kind: DesignIntentGoal;
  class: DesignIntentGoalClass;
  /** 这个目标说的是"哪个层级"的事 */
  scope: 'room' | 'cabinet';
  /** 人话（界面与提示共用一处出口） */
  zh: string;
  /** 对账时读哪个既有事实维度；priority 类为 null（判定不出来，如实说） */
  fact: DesignIntentFactDimension | null;
  /**
   * 事实的**产出方**：相对 `src/` 的文件 + 必须逐字出现的信号串。
   * 验收会去那个文件里核对信号串真的在 —— 这是"词表不许指向不存在的事实"的机器化。
   * priority 类没有产出方。
   */
  producer?: { file: string; signal: string[] };
  /** 该事实维度的哪些取值算"满足"。空数组 = 没有可枚举的取值（如"无接触记录"） */
  satisfiedValues: string[];
  /** "什么算满足"的人话（给界面和报告用；阈值一律指向规则，不在这里写数） */
  expect: string;
  note: string;
}

/**
 * 词表本体。
 *
 * 每一条 note 都要回答"**为什么它在这里**"，或者"**为什么它不在这里**"——
 * 后者同样重要：`align-with` / `adjacent-to` / `near` / `face` 都不在词表里，
 * 理由写在 DESIGN_INTENT_NOT_HELD 里，免得下一个人再把它们加回来。
 */
export const DESIGN_INTENT_GOALS: Record<DesignIntentGoal, DesignIntentGoalSpec> = {
  'kitchen-workflow': {
    kind: 'kitchen-workflow',
    class: 'priority',
    scope: 'room',
    zh: '动线优先（洗—切—炒顺序顺手）',
    fact: null,
    satisfiedValues: [],
    expect: '不可判定：这是取舍方向，不是事实断言。',
    note:
      '厨房动线是**关于顺序**的目标，不是一个"空间上真或假"的命题 —— 硬要判定只能发明一个评分函数，' +
      '那就等于把设计习惯冒充成可判定事实（P8.3 已经为此拒绝过"L 型必须 270°"）。它的作用体现在后续候选的取舍上。',
  },
  'storage-priority': {
    kind: 'storage-priority',
    class: 'priority',
    scope: 'room',
    zh: '储物优先',
    fact: null,
    satisfiedValues: [],
    expect: '不可判定：这是取舍方向，不是事实断言。',
    note: '同上。储物量可以算，但"储物够不够"取决于用户放什么 —— 那是评分类的事（P9.4），不是本阶段的词。',
  },
  'circulation-priority': {
    kind: 'circulation-priority',
    class: 'priority',
    scope: 'room',
    zh: '通行优先（留出走得开的通道）',
    fact: null,
    satisfiedValues: [],
    expect: '不可判定：这是取舍方向，不是事实断言。',
    note: '同上。通道宽度与 600mm 洞口影响带（人流）不是同一件事，本层不去替它们挂钩。',
  },

  'wall-contact': {
    kind: 'wall-contact',
    class: 'condition',
    scope: 'cabinet',
    zh: '希望贴着墙',
    fact: 'cabinet.wallContacts',
    producer: { file: 'core/designValidation/model.ts', signal: ['back-wall-contact', 'side-wall-contact', 'front-wall-contact'] },
    satisfiedValues: ['back-wall-contact', 'side-wall-contact'],
    expect: '背面贴墙或侧面顶墙（依据 P8.8 的墙接触语义分类；阈值同 SPATIAL_TOL.TOUCH）。',
    note:
      '为什么只认背面/侧面两类、不认 `front-wall-contact`：门脸怼着墙等于门开不了。' +
      '这也是"面朝哪边"这一类意图的**替代写法** —— 用期望取值集合表达，而不是引入朝向（朝向就是 rotation 本身，' +
      '一旦能写进意图就多出一条旋转真相源）。',
  },
  'opening-clear': {
    kind: 'opening-clear',
    class: 'condition',
    scope: 'cabinet',
    zh: '希望让开门窗洞口（不落进影响带）',
    fact: 'cabinet.openingProximity',
    producer: { file: 'core/spatial/derive.ts', signal: ["'clear'", 'CabOpeningRelation'] },
    satisfiedValues: ['clear'],
    expect: '柜体不落进洞口影响带（P8.7 的 600mm 通行带 = 人流，与柜间通道不是一回事）。',
    note:
      '洞口影响带（通行）与门扇开启扇区（扫过的面积）**互不替代**（P8.9 的结论），所以让开洞口与让开门扇是两条词，不合并。',
  },
  'door-swing-clear': {
    kind: 'door-swing-clear',
    class: 'condition',
    scope: 'cabinet',
    zh: '希望让开门扇开启范围',
    fact: 'cabinet.doorClearances',
    producer: { file: 'core/spatial/door.ts', signal: ['DoorClearanceStatus', "'overlap'"] },
    satisfiedValues: ['clear'],
    expect: '柜体不进入门扇 90° 开启包络（判不出开启方向时**不判**：unknown 既不算满足也不算违反）。',
    note:
      '门扇缺 hinge / swingDirection 时事实层是 unknown（P8.9 绝不默认向内开）—— 本层同样保持沉默，' +
      '不把"判不出来"当成"满足"（那是假绿，见 P9.1 用「判不出就得说出来」处理同类问题）。',
  },
  'near-opening': {
    kind: 'near-opening',
    class: 'condition',
    scope: 'cabinet',
    zh: '希望靠近门窗（采光 / 出入方便）',
    fact: 'cabinet.openingProximity',
    producer: { file: 'core/rules/issueCatalog.ts', signal: ['DESIGN-CABINET-NEAR-DOOR', 'DESIGN-WINDOW-BEHIND-CABINET'] },
    satisfiedValues: ['DESIGN-CABINET-NEAR-DOOR', 'DESIGN-WINDOW-BEHIND-CABINET'],
    expect: '柜体没盖住洞口、且离影响带的距离 ≤ DESIGN_TOL.APPROACH（阈值只有一个出处，不在这里写数）。',
    note:
      '这条用的是 P8.8 已有的"离洞口有多近"判定（interpret.ts 里现算的那个距离），本层**不重算**。' +
      '注意 P8.8 把它报成 WARNING（"站到进出通道上了"），而这里用它表达"我**想**靠近窗" —— ' +
      '同一个几何事实，两种用途；本层只借它的**事实口径**，不借它的褒贬。可选 `openingKind` 用来限定只算门或只算窗。',
  },
  standalone: {
    kind: 'standalone',
    class: 'condition',
    scope: 'cabinet',
    zh: '希望独立摆放（不与其它柜相接）',
    fact: 'cabinet.contacts',
    producer: { file: 'core/relations.ts', signal: ['deriveContacts'] },
    satisfiedValues: [],
    expect: '与项目里任何其它柜都不产生接触记录（P2 deriveContacts 里查不到涉及它的行）。',
    note:
      '岛台/独立柜的典型诉求；与"没靠墙"（P8.8 的 floating）不是一回事 —— 那只说墙，这只说柜。' +
      '这一维在 P9.1 的 AI 快照里**还没有**（快照只给了柜↔墙/洞口/门扇），将来要不要补进快照是另一件事，本层只登记依据。',
  },
  'room-inside': {
    kind: 'room-inside',
    class: 'condition',
    scope: 'cabinet',
    zh: '希望留在房间里（不出房间、不压墙线）',
    fact: 'cabinet.roomRelation',
    producer: { file: 'core/spatial/derive.ts', signal: ['CabRoomRelation', "'inside'"] },
    satisfiedValues: ['inside'],
    expect: '柜体完整落在所属房间的边界回路内、且不跨越房间边界。',
    note:
      '这是最弱也最基础的一条：它几乎总是已经被硬规则（RULE-CABINET-IN-WALL / 干涉）保证。' +
      '之所以仍然收进词表：**"不出房间"是用户会明说的目标**，而且它是 P9.3 枚举候选时的第一道筛子 —— ' +
      '没有它，枚举器只能靠"反正会被规则拦住"来兜。房间判不出内外（回路不闭合）时保持沉默。',
  },
};

/** 词表的稳定顺序（界面、提示、报告都按这一个顺序列） */
export const DESIGN_INTENT_GOAL_ORDER: DesignIntentGoal[] = Object.keys(DESIGN_INTENT_GOALS) as DesignIntentGoal[];

/** 取舍方向类（**唯一**允许没有判定依据的一类） */
export const PRIORITY_GOALS: DesignIntentGoal[] = DESIGN_INTENT_GOAL_ORDER.filter((g) => DESIGN_INTENT_GOALS[g].class === 'priority');

/** 条件类（必须给出判定依据） */
export const CONDITION_GOALS: DesignIntentGoal[] = DESIGN_INTENT_GOAL_ORDER.filter((g) => DESIGN_INTENT_GOALS[g].class === 'condition');

/** 事实维度闭集（顺序固定） */
export const DESIGN_INTENT_FACT_DIMENSIONS: DesignIntentFactDimension[] = [
  'cabinet.wallContacts',
  'cabinet.openingProximity',
  'cabinet.doorClearances',
  'cabinet.roomRelation',
  'cabinet.contacts',
];

export function isDesignIntentGoal(v: unknown): v is DesignIntentGoal {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(DESIGN_INTENT_GOALS, v);
}

export function isDesignIntentFactDimension(v: unknown): v is DesignIntentFactDimension {
  return typeof v === 'string' && (DESIGN_INTENT_FACT_DIMENSIONS as string[]).includes(v);
}

export function designIntentGoalSpec(g: DesignIntentGoal): DesignIntentGoalSpec {
  return DESIGN_INTENT_GOALS[g];
}

export const designIntentGoalZh = (g: DesignIntentGoal): string => DESIGN_INTENT_GOALS[g]?.zh ?? String(g);

// ─────────────────────────── 取值：唯一的一个 ───────────────────────────

/**
 * `openingKind` —— **整个词表里唯一允许出现的取值字段**。
 *
 * 为什么只留一个：意图上的每一个"参数"都是下一次"顺手把布局决定写进意图"的入口。
 * 只允许"靠近哪种洞口"这一个取值，是因为没有它 `near-opening` 就分不出门和窗
 * （用户举例里的 `near-window` 正是这个意思），而它仍然只是一个**枚举过滤**，
 * 不是阈值、不是坐标、不是尺寸。
 */
export const DESIGN_INTENT_VALUE_KEY = 'openingKind';
export const DESIGN_INTENT_OPENING_KINDS: OpeningKind[] = ['door', 'window'];

/** 只有这一条词用得上取值字段 —— 其余的词给了它必须被拒（而不是静默忽略） */
export const DESIGN_INTENT_VALUE_OWNER: DesignIntentGoal = 'near-opening';

/** 意图的"有效载荷"字段（goal / scope 之外的部分）：闭集，多一个键就是越界 */
export const DESIGN_INTENT_PAYLOAD_KEYS: string[] = ['goal', 'scope', DESIGN_INTENT_VALUE_KEY];

// ─────────────────────────── 为什么某些常见的词**不**在这里 ───────────────────────────

/**
 * 明确"不收"的词与理由。**不是注释，是给人看的判定记录** ——
 * 下一个人想加 `align-with` 时，先看到的就是这一段。
 */
export const DESIGN_INTENT_NOT_HELD: Array<{ word: string; owner: string; why: string }> = [
  {
    word: 'align-with / 与某柜对齐',
    owner: "PlacementIntent.relation === 'align'（core/placement.ts，P8.1）",
    why:
      '对齐是**落位指令**，已经进 Resolver 并输出坐标。再定义一个同义的意图词，就会出现' +
      '"声明的 center"与"几何的 center"各指一条轴 —— placement.ts 的类注释为这件事写过警告；' +
      'P8.5-C1 也已经把 alignment 登记成 Knowledge 的一个维度，第三份抄本只会漂移。',
  },
  {
    word: 'adjacent-to / 与某柜相邻',
    owner: "PlacementIntent.relation === 'adjacent'（core/placement.ts，P8.1）",
    why: '同上。P8.2 明确写过"相邻本身就是面贴合，不再设第四个同义词"。',
  },
  {
    word: 'near / 靠近某只柜',
    owner: '（无 —— 今天判不出来）',
    why:
      '事实层里柜↔柜只有"接触 / 不接触"（deriveContacts），**没有"两柜距离"这个量**；' +
      'SPATIAL_TOL.NEAR 是柜↔**墙**的。定义它等于发明一个谁都算不出来的词：' +
      '将来对账时它永远返回"不知道"，而用户以为自己提了一个会被满足的要求。',
  },
  {
    word: 'face / 面朝某方向',
    owner: 'Cabinet.placement.rotation（Geometry Truth）',
    why:
      '"面朝"就是朝向，写进意图即第二条旋转真相源。它真正想说的事（门脸别怼着墙）由 ' +
      '`wall-contact` 的**期望取值集合**表达：只认背面/侧面贴墙，不认门脸朝墙。',
  },
  {
    word: 'prefer-wall 里的"多近算贴墙"',
    owner: 'SPATIAL_TOL.TOUCH（core/spatial/model.ts）',
    why: '阈值是规则、只有一个出处。若允许每条意图各写一个数，同一个词在两条意图里意思就不同了。',
  },
];
