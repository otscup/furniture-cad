/**
 * ══════════════════════════════════════════════════════════════════════
 *  确定性设计评分（DesignScore）—— 纯临时对象模型（P9.4）
 *
 *  ── 它回答什么 ──
 *    「这份候选布局，如果真按它摆，会得到什么结果？」
 *    回答方式**不是**一个裸数字（`score = 82` 是明令禁止的输出），
 *    而是一串**可解释的 component**：每一条都答得出
 *      ① 分数来自什么（source）② 依据哪条 fact ③ 依据哪条 rule
 *      ④ 是不是 preference ⑤ 权重是多少 ⑥ 为什么加/减。
 *
 *  ── 它是什么 / 不是什么 ──
 *    是：一份**只读的评估结果**（`{status, total, components[], hardFailures[],
 *        preferenceMatches[], explanations[]}`），活在本会话内存里。
 *    不是：不是 Project（不进 `project.json`、不升 `schemaVersion`）、
 *          不是 Cabinet、不是 Command（**不能**让任何候选生效）、
 *          更不是第二真相源 —— 它连坐标都不算，只**读**别人算好的结论。
 *
 *  ── 三条来源纪律（§五：不许有第四种）──
 *    source 是**闭集联合类型** `'fact' | 'rule' | 'preference'`：
 *      fact       = 已派生的确定性事实（P8.7 空间事实 / P8.9 门扇净空 / P2 接触…）
 *      rule       = 既有规则（设计意图词表的 goal spec：什么算满足）
 *      preference = 用户确认过的软件偏好（Knowledge，经 Resolver 过滤）
 *    LLM 判断**不在**这三者里，所以它在类型上就写不出来
 *    （评分层也不 import `ai/aiClient`）。
 *
 *  ── 硬约束不是"扣很多分"（§四）──
 *    有明确 blocking error（ERROR 级）⇒ `status:'infeasible'`、
 *    `total: null`、`components: []` —— **不假装它还是一个有效候选**
 *    （`ERROR = -100` 那种写法正是本节要防的）。
 *    评分链是：Hard Constraint Gate → valid / infeasible → **valid 才进入软评分**。
 *
 *  ── 权重为什么是 null（§九）──
 *    权重是**配置**，配置要有归属。审查过：唯一像样的归属地是 `RuleSet`，
 *    而它当前**没有任何评分配置**（只有 limits / policy / materials /
 *    edgebanding / hardware / stylePresets）。为一个"看起来完整"的评分引擎去
 *    扩展被 `factory-default.json` + 解析 + 迁移锁定的生产配置，是用错归属地。
 *    所以本阶段：`weight: null` + `weightSource:'unassigned'`，
 *    `total` = **命中数**（确定性、可解释、无 magic number），
 *    权重系统留待后续阶段（见 `SCORE_WEIGHT_POLICY.note`）。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { DesignIntentGoal } from '../designIntent/vocabulary.ts';
import type { PredicateKind, PredicateOp } from '../../ai/knowledge/model.ts';

/** 闸门结果：valid = 过了硬约束、进入软评分；infeasible = 有阻断错误，不评分 */
export type DesignScoreStatus = 'valid' | 'infeasible';

/**
 * 分数来源（**闭集**，§五）—— 没有第四种，尤其没有 "llm"。
 * 类型层写不出来 = 不可能悄悄混进一个"模型觉得还行"。
 */
export type DesignScoreSource = 'fact' | 'rule' | 'preference';

/** 一条判据的命中情况。`unknown` = **判不出来**（如实说，不当成"不满足"，也不塞进分数） */
export type DesignScoreHit = 'yes' | 'no' | 'unknown';

/**
 * component 的种类：
 *   condition   —— 对一条设计意图（设计规则）的满足情况
 *   preference  —— 对一条用户偏好的命中情况（**加权偏好**，不是硬约束）
 *   unavailable —— 这条判据当前**判不出来**（例如取舍方向类意图没有判定依据）
 *                  —— 如实登记，**不计入 total**
 */
export type DesignScoreComponentKind = 'condition' | 'preference' | 'unavailable';

/**
 * 一条可解释的评分依据 —— §三 要求它答得出那 6 个问题。
 * 刻意**没有** `score: number` 这种裸分数字段：分数只能由 `hit` + `weight` 表达。
 */
export interface DesignScoreComponent {
  /** 稳定 id（同一份输入永远同一个 id，便于确定性比较）：`cond:di_001` / `pref:c1:kn_003` */
  id: string;
  kind: DesignScoreComponentKind;
  /** 人话（界面/报告直接显示） */
  label: string;
  /** ① 分数来自什么 */
  source: DesignScoreSource;
  /** ② 依据哪个 fact（既有事实维度名 / 具体读法）；判不出来时可缺省 */
  fact?: string;
  /** ③ 依据哪个 rule（设计意图词表的 goal spec 引用）；preference 类指向偏好条目 */
  rule?: string;
  /** 这条判据说的是哪条设计意图（condition / unavailable 时） */
  intentId?: string;
  /** 这条判据说的是哪个目标词（condition / unavailable 时） */
  goal?: DesignIntentGoal;
  /** 这条判据说的是哪条偏好（preference 时，= KnowledgeEntry.id） */
  preferenceId?: string;
  /** ④ 是不是 preference（显式冗余，方便消费方筛选） */
  isPreference: boolean;
  /** ⑤ 权重 —— 本阶段恒 `null`（见文件头 §九） */
  weight: number | null;
  /** 权重的归属：`'unassigned'` = 还没有归属地（不伪造一个来源） */
  weightSource: 'unassigned';
  /** ⑥ 命中情况 */
  hit: DesignScoreHit;
  /** ⑥ 为什么加/减/不判（带上实测到的那个值 —— "只输出 score=82" 是最糟的） */
  why: string;
}

/**
 * 一处阻断错误（**只有 ERROR 级**才进这里）。
 *
 * 文案与等级**原样来自既有层**（`issueCatalog` 经 `detectCollisions` /
 * `validateDesign` 透传）—— 评分层不自己拼一句话、不自己定等级。
 */
export interface DesignScoreHardFailure {
  code: string;
  /** 恒为 'ERROR' —— 这一族是"已被证明非法"，不是"看起来不好" */
  severity: 'ERROR';
  /** 挂在哪只柜上 */
  target: string;
  /** 文案（来自 issueCatalog，经既有层透传） */
  message: string;
  /** 从哪条链读到的：候选自带冲突 / 统一设计验证报告 */
  source: 'candidate-issues' | 'design-validation';
}

/** 一条偏好的命中情况（§六：**只**消费 Resolver 的 applicable，未被硬规则压制） */
export interface DesignScorePreferenceMatch {
  preferenceId: string;
  statement: string;
  kind: PredicateKind;
  op: PredicateOp;
  value: number | string;
  /** 命中的是哪只柜（偏好按柜比对） */
  cabinetId: string;
  matched: DesignScoreHit;
  why: string;
}

/** 权重策略（本阶段：**没有**配权重 —— 如实标注，而不是编一串 magic number） */
export interface DesignScoreWeightPolicy {
  /** 恒 `false`（本阶段不设权重） */
  assigned: false;
  note: string;
}

export const SCORE_WEIGHT_POLICY: DesignScoreWeightPolicy = {
  assigned: false,
  note:
    '本阶段不设权重：唯一像样的归属地 RuleSet 尚无评分配置，不为"完整"去扩展被 factory-default.json / 解析 / 迁移锁定的生产配置（§九）。' +
    'total = 命中条件数（确定性、可解释、无 magic number）；权重系统与其归属留待后续阶段。',
};

/** 一条候选布局的评分结果（纯临时对象） */
export interface DesignScore {
  status: DesignScoreStatus;
  /**
   * 总分。`null` = **不评分** —— 只在 infeasible 时出现
   * （"不要 ERROR=-100 然后继续假装它是有效候选"）。
   * valid 时 = 命中数（见 `totalKind`）。
   */
  total: number | null;
  /** 总分的口径：`'hit-count'` = 命中数（无权重）；`'none'` = 没有总分 */
  totalKind: 'hit-count' | 'none';
  weights: DesignScoreWeightPolicy;
  /** 可解释的评分依据（infeasible 时为空 —— 硬约束不过，不进入软评分） */
  components: DesignScoreComponent[];
  /** 阻断错误（只有 ERROR） */
  hardFailures: DesignScoreHardFailure[];
  /** 偏好命中（只含 Resolver 判定为 applicable 的 userPreference） */
  preferenceMatches: DesignScorePreferenceMatch[];
  /** 人话说明（含闸门结论、逐条 why、权重政策） */
  explanations: string[];
}

export const designScoreStatusZh = (s: DesignScoreStatus): string => (s === 'valid' ? '可用（进入软评分）' : '被硬约束否决（不评分）');

export const designScoreHitZh = (h: DesignScoreHit): string => (h === 'yes' ? '命中' : h === 'no' ? '未命中' : '判不出来');

/**
 * 命中/未命中/判不出来 → 是否计入总分。
 * 只有 `yes` 计入；`unknown` **绝不**被当成"未命中"（那是把判不出来当结论 —— 假绿）。
 */
export const designScoreCounts = (h: DesignScoreHit): boolean => h === 'yes';
