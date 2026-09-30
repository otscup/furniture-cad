/**
 * ══════════════════════════════════════════════════════════════════════
 *  Knowledge Model（P6）—— 硬规则 / 设计知识 / 用户偏好 的分层表达
 *
 *  ── 与 Correction（Phase 2 记忆）的关系 ──
 *    Correction 是**拦阻性**记忆：编译成可执行检查挂在 CommandBus 门上，
 *    对 AI / UI / 脚本一切来源生效 —— 它本质是 hardRule 层的动态补充。
 *    Knowledge 是**建议性**知识：供 AI 规划 / Vision 映射参考，**永远不
 *    直接写模型**，产出仍走 Proposal → validation → dryRun → CommandBus。
 *    两者互补，不互替：Resolver 把 active 的 Correction 作为 hardRule 层
 *    引用进来（引用 id，不复制实现），保证「硬规则」只有一个执行体。
 *
 *  ── 三层优先级（确定性，不由 AI 决定）──
 *      Hard Rule  >  Design Knowledge  >  User Preference
 *    冲突时不静默覆盖：conflicts 双向登记、保留双方来源、被压制的偏好
 *    从 applicable 里排除但出现在冲突列表里 —— 让 AI 和人都看得见。
 *
 *  ── 生命周期（不是"大模型记忆库"）──
 *      事实/观察（observe）→ candidate → 用户确认 → active →（可 rejected）
 *    · 观察只能产生 candidate，永远不自动升级（改过一次 ≠ 永久偏好）
 *    · user-stated（用户明说"以后都这样"）→ 直接 active + confirmed
 *    · candidate 不进 Resolver 的 applicable —— 没确认的知识不参与规划
 *
 *  ── 不保存几何 ──
 *    Knowledge 不存 geometry / panel coordinates / DXF primitive。
 *    可判定部分只允许有限集合的结构化谓词（Predicate），文本陈述照原样
 *    保留做 provenance 本体。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { Correction } from '../memory.ts';

/** 知识三层 —— 优先级 hardRule > designKnowledge > userPreference（确定性） */
export type KnowledgeLayer = 'hardRule' | 'designKnowledge' | 'userPreference';

export type KnowledgeStatus = 'candidate' | 'active' | 'rejected';

/** 证据来源 —— 必须能区分"AI 推测 / 行为观察 / 用户明说 / 系统登记" */
export type KnowledgeOrigin = 'ai-inferred' | 'user-observed' | 'user-stated' | 'system';

/**
 * 可判定的谓词维度 —— **有限集合**。
 * 观察器只认这些维度；冲突检测只对可判定维度做数值/枚举比较。
 * 不在集合里的修改（第一版不试图自动总结所有修改）不产生知识。
 */
export type PredicateKind =
  | 'drawerCount'   // 抽屉数量（数值）
  | 'rowHeight'     // 行高 mm（数值）
  | 'cabinetWidth'  // 柜宽 mm（数值）
  | 'cabinetDepth'  // 柜深 mm（数值）
  | 'unitKind'      // 分区类型（枚举：drawerBank/hanging/shelves/open/appliance）
  | 'layoutStyle'   // 布局风格（枚举：moreDrawers/moreHanging/moreOpen）
  /** 柜体朝向 deg（0/90/180/270）—— **只在 PlacementContext 下有意义**，见下 */
  | 'orientation';

/** 比较方向：prefer = 软建议值；min/max = 范围边界（hardRule 用）；forbid = 禁止 */
export type PredicateOp = 'prefer' | 'min' | 'max' | 'forbid';

/**
 * 落位上下文（P8.4）—— 朝向偏好**必须带上下文**，否则它就是设计习惯冒充规则。
 *
 * 「corner 副臂一律 rotation=270」是把一次观察写死成规则：左转角、镜像结构、
 * 不同家具都能有别的合理朝向。同一条柜体朝向，在**右转角**里合适、在**左转角**
 * 里可能正是被 P8.3 报可疑的那个 —— 所以偏好只在**同样的上下文**里才叫偏好。
 *
 * 字段一个都不新造，全部来自已有确定性事实：
 *   · contact  ← P2 `Connection.kind`（声明）/ `deriveContacts().kind`（派生）
 *   · turnSide ← P8.3 `cornerTurnSide()`，且**以对方柜为视角**（转自己时它不变）
 *
 *  ── 为什么没有 relation（adjacent / align / attach）──
 *    语义模型里 `Cabinet.placement` 只有 {x, y, rotation} —— **不存落位意图**。
 *    "这次并排是按背面齐还是按中心齐"落盘即消失，事后无法从模型反推。
 *    硬造一个 relation 字段等于拿猜测当证据，所以对齐类偏好本阶段不做。
 */
export interface PlacementContext {
  /** 接触形态：corner = 角接（L 型）；butt = 并排/前后续接 */
  contact?: 'corner' | 'butt';
  /** 转角方向（仅 corner 有意义）：站在**参照柜**背面朝它门脸看，目标柜在哪侧 */
  turnSide?: 'left' | 'right';
}

/** 有上下文的落位类维度（这些维度**不接受**无上下文的谓词） */
export const PLACEMENT_KINDS: PredicateKind[] = ['orientation'];

export interface KnowledgePredicate {
  kind: PredicateKind;
  op: PredicateOp;
  /** prefer/min/max 的值（数值维度为 mm/个数，枚举维度为字符串） */
  value: number | string;
  /** 落位类谓词的上下文（见 PlacementContext）；非落位维度不带 */
  context?: PlacementContext;
}

/** 上下文的稳定键（用于"是不是同一类情形"的比较，不用于展示） */
export function contextKey(c?: PlacementContext): string {
  if (!c) return '';
  return `contact=${c.contact ?? '*'};turn=${c.turnSide ?? '*'}`;
}

/**
 * 偏好上下文是否**覆盖**当前情形 —— 偏好里写了的字段必须逐项相等，
 * 没写的字段不限（"右转角偏好 270"不要求 contact 也一致 —— 它自己就写了）。
 */
export function contextCovers(pc: PlacementContext | undefined, ctx: PlacementContext): boolean {
  if (!pc) return true;
  if (pc.contact !== undefined && pc.contact !== ctx.contact) return false;
  if (pc.turnSide !== undefined && pc.turnSide !== ctx.turnSide) return false;
  return true;
}

const CONTACT_ZH: Record<string, string> = { corner: '角接（L 型）', butt: '并排/前后续接' };
const TURN_ZH: Record<string, string> = { left: '左转角', right: '右转角' };

/** 上下文的人话（展示与摘要用；空上下文如实说"不限定情形"） */
export function placementContextZh(c?: PlacementContext): string {
  if (!c || (c.contact === undefined && c.turnSide === undefined)) return '不限定情形';
  const parts: string[] = [];
  if (c.contact) parts.push(CONTACT_ZH[c.contact] ?? c.contact);
  if (c.turnSide) parts.push(TURN_ZH[c.turnSide] ?? c.turnSide);
  return parts.join(' · ');
}

/** 适用范围 —— 第一版只做柜体名/房间名的精确匹配，'any' = 不限 */
export interface KnowledgeScope {
  cabinet?: string;
  room?: string;
}

/** 一条证据：谁在什么时候基于什么产生了这条知识（provenance 本体） */
export interface KnowledgeEvidence {
  at: number;
  source: KnowledgeOrigin;
  /** 原话 / 命令 label / diff 描述（照原样保留，任何改写都可能曲解原意） */
  detail: string;
  /** 证据涉及的柜体 id（观察类证据必带） */
  cabinetId?: string;
}

export interface KnowledgeEntry {
  id: string;
  layer: KnowledgeLayer;
  /** 人话陈述（展示与审计用；可判定部分另见 predicate） */
  statement: string;
  /** 可判定谓词（可选 —— 无谓词的知识只作展示，不参与冲突检测） */
  predicate?: KnowledgePredicate;
  scope: KnowledgeScope;
  evidence: KnowledgeEvidence[];
  /** 0~1：观察次数与来源可靠性共同决定，确认后置 1 */
  confidence: number;
  status: KnowledgeStatus;
  /** 用户确认时刻（userPreference/designKnowledge 的 active 必须有） */
  confirmedAt?: number;
  /** 与之冲突的其他知识 id（双向登记 —— 冲突必须留痕，不许静默覆盖） */
  conflicts: string[];
  createdAt: number;
  updatedAt: number;
}

/** hardRule 层的静态引用：现有规则码（issueCatalog / validate） */
export interface HardRuleRef {
  /** 规则码，例如 'RULE-DRAWER-Runner-Depth'（引用，不重新实现约束） */
  code: string;
  /** 该规则对人话陈述 */
  statement: string;
  /** 可判定边界（用于与偏好/知识做数值冲突检测） */
  predicate?: KnowledgePredicate;
  scope: KnowledgeScope;
}

// ───────────────────────────── 构造 / 生命周期 ─────────────────────────────

export function knowledgeId(seq: number): string {
  return `kn_${String(seq).padStart(3, '0')}_${Date.now().toString(36)}`;
}

/** 观察产生的 candidate：低置信、无确认、永不自动升级 */
export function makeCandidate(input: {
  layer: KnowledgeLayer;
  statement: string;
  predicate?: KnowledgePredicate;
  scope?: KnowledgeScope;
  evidence: KnowledgeEvidence;
  confidence: number;
  seq: number;
}): KnowledgeEntry {
  const now = Date.now();
  return {
    id: knowledgeId(input.seq),
    layer: input.layer,
    statement: input.statement,
    ...(input.predicate ? { predicate: input.predicate } : {}),
    scope: input.scope ?? {},
    evidence: [input.evidence],
    confidence: Math.max(0, Math.min(1, input.confidence)),
    status: 'candidate',
    conflicts: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 用户明说的偏好：直接 active + confirmed（用户原话就是最高证据） */
export function makeStatedPreference(input: {
  statement: string;
  predicate?: KnowledgePredicate;
  scope?: KnowledgeScope;
  detail: string;
  seq: number;
}): KnowledgeEntry {
  const now = Date.now();
  return {
    id: knowledgeId(input.seq),
    layer: 'userPreference',
    statement: input.statement,
    ...(input.predicate ? { predicate: input.predicate } : {}),
    scope: input.scope ?? {},
    evidence: [{ at: now, source: 'user-stated', detail: input.detail }],
    confidence: 1,
    status: 'active',
    confirmedAt: now,
    conflicts: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** 用户确认一条 candidate → active（唯一的人工升级通道） */
export function confirmKnowledge(list: KnowledgeEntry[], id: string): KnowledgeEntry[] {
  const now = Date.now();
  return list.map((e) =>
    e.id === id && e.status === 'candidate'
      ? {
          ...e,
          status: 'active',
          confidence: 1,
          confirmedAt: now,
          evidence: [...e.evidence, { at: now, source: 'user-stated' as const, detail: '用户在知识面板确认生效' }],
          updatedAt: now,
        }
      : e,
  );
}

export function rejectKnowledge(list: KnowledgeEntry[], id: string): KnowledgeEntry[] {
  const now = Date.now();
  return list.map((e) => (e.id === id ? { ...e, status: 'rejected' as const, updatedAt: now } : e));
}

/** 累积同类观察（同 layer+predicate+scope → 追加证据、涨置信，但状态不变） */
export function appendEvidence(list: KnowledgeEntry[], id: string, ev: KnowledgeEvidence, bump: number): KnowledgeEntry[] {
  return list.map((e) =>
    e.id === id
      ? {
          ...e,
          evidence: [...e.evidence, ev],
          confidence: Math.min(1, e.confidence + bump),
          updatedAt: Date.now(),
        }
      : e,
  );
}

// ───────────────────────────── hardRule 层装配 ─────────────────────────────

/**
 * 装配 hardRule 层：现有规则 + active Correction（可执行的动态硬约束）。
 * 只引用不复制 —— 约束的执行体仍然只有 Rules Engine 和记忆门两处，
 * Resolver 拿引用做**提前暴露**（在提交前就告诉 AI/用户"会撞硬规则"），
 * 最终拦截仍由原执行体负责（单一真相源，不在知识层重复实现约束）。
 */
export function hardRuleEntries(ruleCodes: HardRuleRef[], corrections: Correction[]): KnowledgeEntry[] {
  const now = Date.now();
  const fromRules: KnowledgeEntry[] = ruleCodes.map((r) => ({
    id: `hard_rule_${r.code}`,
    layer: 'hardRule' as const,
    statement: r.statement,
    ...(r.predicate ? { predicate: r.predicate } : {}),
    scope: r.scope ?? {},
    evidence: [{ at: now, source: 'system' as const, detail: `规则集硬规则 ${r.code}` }],
    confidence: 1,
    status: 'active' as const,
    confirmedAt: now,
    conflicts: [],
    createdAt: now,
    updatedAt: now,
  }));
  const fromCorrections: KnowledgeEntry[] = corrections
    .filter((c) => c.status === 'active')
    .map((c) => ({
      id: `hard_mem_${c.id}`,
      layer: 'hardRule' as const,
      statement: c.nl,
      scope: {},
      evidence: [{ at: c.at, source: c.origin === 'user' ? ('user-stated' as const) : ('system' as const), detail: `记忆门 ${c.id}` }],
      confidence: 1,
      status: 'active' as const,
      confirmedAt: c.at,
      conflicts: [],
      createdAt: c.at,
      updatedAt: c.at,
    }));
  return [...fromRules, ...fromCorrections];
}
