/**
 * ══════════════════════════════════════════════════════════════════════
 *  候选解释（CandidateExplanation）—— **只读投影**（P9.9）
 *
 *  ── 它是什么 ──
 *    "这条候选为什么存在、它到底满足了什么、哪里不行、哪里判不出来" ——
 *    把**已经算好的**结论（P9.4 `DesignScore` + P9.3/P9.7 `CandidateLayout`）
 *    整理成一份形状稳定、给人看的解释对象（UI 与验收同时消费）。
 *
 *  ── 它不是第二真相源（P9.9 第一红线）──
 *    本文件**不做任何判定**：不重算空间 / 碰撞 / 评分，不生成新规则 / 偏好，
 *    不 import 任何判定函数（**只 import 类型**）。它只**引用**下面这些既有字段：
 *      · `score.status` / `components` / `hardFailures` / `preferenceMatches` / `explanations`
 *      · `layout.explanations`（逐字节透传）/ `unresolved`（原样引用）
 *      · `layout.placements[].satisfies`（标为**生成期信号**，与事实分区，绝不并入结论）
 *    解释文本**绝不**反向影响评分或选择 —— 它只是最外层皮肤。
 *
 *  ── 归因口径（§5.3 注 / §十六 开放问题 ② 的裁定：选路 ①）──
 *    `DesignScoreComponent` 本身没有 `cabinetId`。本层按"能追到柜才追"的原则归因：
 *      · `blocking`  → 按 `hardFailure.target` 归入对应柜；
 *      · `preference` → 按 `preferenceMatches[].cabinetId`（经 `preferenceId` 对上）归入；
 *      · 其余（condition / unavailable）→ 落 `crossCutting`（**不硬塞给某只柜**，
 *        尤其房间级 `unavailable`：E16 明令不许塞进任一 placement）。
 *    **严禁靠解析 `label` 中文串反推柜名。**
 * ══════════════════════════════════════════════════════════════════════
 */
import type { CandidateLayout, CandidateUnresolved } from './model.ts';
import type {
  DesignScore,
  DesignScoreComponent,
  DesignScoreHit,
  DesignScoreSource,
  DesignScoreStatus,
} from '../designScore/model.ts';
import type { DesignIntentGoal } from '../designIntent/vocabulary.ts';

/**
 * 一条解释项 —— 每个字段都是对既有对象的**引用/重塑**，没有新事实。
 *
 * `kind` 保留 `'blocking'`（形状与审查 §5.2 一致），但**阻断项实际住在 `blocking[]`**：
 * 验收 A5 要求 `placements[].items + crossCutting` 的 code 集合**恰好等于** `components` 的 id 集合，
 * 所以解释项只承载 `components`（condition / preference / unavailable）三族。
 */
export interface CandidateExplanationItem {
  /** 解释码：直接引用既有 id / code，不自造新码表（`cond:di_001` / `pref:c1:kn_003`） */
  code: string;
  kind: 'condition' | 'preference' | 'unavailable' | 'blocking';
  /** 引自 `component.source`；blocking 项住在 `blocking[]`，其 source 为硬事实链名 */
  source: DesignScoreSource | 'candidate-issues' | 'design-validation';
  /** 命中情况；`unknown` = **判不出来**（如实说，不当"未满足"） */
  hit: DesignScoreHit;
  /** 人话标签（引自 `component.label`） */
  label: string;
  /** 为什么（引自 `component.why`） */
  why: string;
  /** 归属：能追到柜就追到柜（引用 `targetId`，**不复制坐标**） */
  targetId?: string;
  intentId?: string;
  goal?: DesignIntentGoal;
  preferenceId?: string;
}

/** 逐柜解释块 —— 每块**只含该柜**的项（多柜候选按柜分组） */
export interface CandidateExplanationPlacement {
  targetId: string;
  items: CandidateExplanationItem[];
  /** 生成期信号（★ 与 items / 事实分区）：来自 `placement.satisfies`，**不是**事实判定 */
  generatorSignals: Array<{ goal: DesignIntentGoal; ok: boolean }>;
}

/** 一处阻断（逐条引自 `score.hardFailures`，五项逐字一致） */
export interface CandidateExplanationBlocking {
  code: string;
  severity: 'ERROR';
  target: string;
  message: string;
  source: 'candidate-issues' | 'design-validation';
}

export interface CandidateExplanation {
  /** 引用候选 id（注意：id 是位置性的，稳定身份见 `candidateKey`） */
  candidateId: string;
  /** 引用 `score.status`（**唯一**，不得自推） */
  status: DesignScoreStatus;
  /** 按 placement 组织（多柜候选按柜分组；blocking 按 `hardFailure.target` 归因） */
  placements: CandidateExplanationPlacement[];
  /** 不归属任何单柜的项（如房间级 `unavailable`） */
  crossCutting: CandidateExplanationItem[];
  /** 阻断错误（逐条引自 `score.hardFailures`） */
  blocking: CandidateExplanationBlocking[];
  /**
   * 生成侧自述：**原样透传** `layout.explanations`（不解析、不改写、不排序）。
   * 搜索族仍以自由文本形态住在其中（`搜索族：…` 那一行）—— 见决策 D1（M1 未落地）。
   */
  generationNotes: string[];
  /** 原样引用 `layout.unresolved` */
  unresolved: CandidateUnresolved[];
  /** 归一化码表（component id + hardFailure code），供验收与 UI 角标使用（不改变任何判定） */
  codes: string[];
  /** 确定性自然语言：由 formatter 从上面这些字段拼出（见 `explainCandidateSummaryZh`） */
  summaryZh: string;
}

const HIT_ZH: Record<DesignScoreHit, string> = { yes: '命中', no: '未命中', unknown: '判不出来' };

const STATUS_ZH: Record<DesignScoreStatus, string> = {
  valid: '可用',
  infeasible: '被硬约束否决（不评分）',
};

function itemOf(c: DesignScoreComponent, targetId?: string): CandidateExplanationItem {
  return {
    code: c.id,
    kind: c.kind,
    source: c.source,
    hit: c.hit,
    label: c.label,
    why: c.why,
    ...(targetId !== undefined ? { targetId } : {}),
    ...(c.intentId !== undefined ? { intentId: c.intentId } : {}),
    ...(c.goal !== undefined ? { goal: c.goal } : {}),
    ...(c.preferenceId !== undefined ? { preferenceId: c.preferenceId } : {}),
  };
}

/**
 * 把 `(layout, score)` 投影成一份解释。**纯函数、确定性**（同输入两次逐字节相同）。
 *
 * `project` 目前**不参与归因** —— 归因只用 `score` 自带的信息（`preferenceMatches[].cabinetId`
 * 与 `hardFailures[].target`）；`condition`/`unavailable` 一律落 `crossCutting`（诚实优先）。
 * 参数保留是为了与审查 §5.2 的签名一致，并为将来"按 intent.scope 细化归因"留位（**不改变本次行为**）。
 */
export function buildCandidateExplanation(layout: CandidateLayout, score: DesignScore): CandidateExplanation {
  // ── blocking：逐条引自 hardFailures，按 target 归因 ──
  const blocking: CandidateExplanationBlocking[] = score.hardFailures.map((h) => ({
    code: h.code,
    severity: h.severity,
    target: h.target,
    message: h.message,
    source: h.source,
  }));

  // ── preference 归因表：preferenceId → cabinetId（唯一来源 score.preferenceMatches）──
  const prefCabinet = new Map<string, string>();
  for (const m of score.preferenceMatches) prefCabinet.set(m.preferenceId, m.cabinetId);

  // ── 逐柜块：每个 placement 一块（顺序 = layout.placements 顺序，确定性）──
  //   `satisfies` 取 `?? []`：候选可能来自**手工构造的最小对象**（验收夹具 / 老快照），
  //   此时"没有生成期信号"就是 `[]`。**不许**把"没有信号"当成 `false`（那会把
  //   "没被问过"读成"不满足"—— P9.4 头注释里点名的那个坑）。
  const placements: CandidateExplanationPlacement[] = layout.placements.map((p) => ({
    targetId: p.targetId,
    items: [],
    generatorSignals: (p.satisfies ?? []).map((s) => ({ goal: s.goal, ok: s.ok })),
  }));
  const blockByTarget = new Map(placements.map((b) => [b.targetId, b] as const));

  const crossCutting: CandidateExplanationItem[] = [];
  for (const c of score.components) {
    // 只有 preference 项能凭既有事实追到柜；其余（condition/unavailable）落跨柜区
    const targetId = c.kind === 'preference' && c.preferenceId !== undefined ? prefCabinet.get(c.preferenceId) : undefined;
    const item = itemOf(c, targetId);
    const block = targetId !== undefined ? blockByTarget.get(targetId) : undefined;
    if (block) block.items.push(item);
    else crossCutting.push(item);
  }

  const codes = [...score.components.map((c) => c.id), ...score.hardFailures.map((h) => h.code)];

  const e: CandidateExplanation = {
    candidateId: layout.id,
    status: score.status,
    placements,
    crossCutting,
    blocking,
    generationNotes: layout.explanations, // ★ 原样引用（A6：逐字节相同）
    unresolved: layout.unresolved,
    codes,
    summaryZh: '',
  };
  e.summaryZh = explainCandidateSummaryZh(e);
  return e;
}

/**
 * 确定性人话 formatter。**只**由 `e` 里的字段拼出，不引入任何新变量（§5.3）。
 *
 * 措辞纪律（验收 B8 / C10 / D13）：
 *   · 不出现 "最好 / 最优 / 推荐 / 建议选" —— 本层**不做优劣判定**；
 *   · 不出现 `对目标「…」` 这种**把生成期 satisfies 当结论**的句子；
 *   · `hit:'unknown'` 一律写成 **"判不出来"**，绝不写成"未满足"。
 */
export function explainCandidateSummaryZh(e: CandidateExplanation): string {
  const parts: string[] = [];
  parts.push(`候选「${e.candidateId}」：${STATUS_ZH[e.status]}`);
  if (e.blocking.length > 0) {
    const codes = [...new Set(e.blocking.map((b) => b.code))].join('、');
    parts.push(`，有 ${e.blocking.length} 处阻断（${codes}）`);
  }
  parts.push('。');

  const allItems = [...e.placements.flatMap((p) => p.items), ...e.crossCutting];
  const hitYes = allItems.filter((i) => i.hit === 'yes').length;
  const hitNo = allItems.filter((i) => i.hit === 'no').length;
  const hitUnknown = allItems.filter((i) => i.hit === 'unknown').length;

  parts.push(`共 ${allItems.length} 条依据：命中 ${hitYes} 条、未命中 ${hitNo} 条`);
  if (hitUnknown > 0) parts.push(`、${hitUnknown} 条判不出来`);
  parts.push('。');

  // 生成期信号只报数量，且**明确标注是生成期粗判**，不写成对目标的结论
  const signals = e.placements.flatMap((p) => p.generatorSignals);
  if (signals.length > 0) {
    const okCount = signals.filter((s) => s.ok).length;
    parts.push(`（生成期粗判：${okCount}/${signals.length} 只按几何接触初判为"疑似满足"，仅供追溯，非最终结论）`);
  }
  if (e.unresolved.length > 0) parts.push(`另有 ${e.unresolved.length} 条未解决项。`);
  return parts.join('');
}

/** 逐条依据的人话（UI 展开一条时用；确定性，不新增判定） */
export function explanationItemZh(i: CandidateExplanationItem): string {
  const where = i.targetId !== undefined ? `「${i.targetId}」` : '（跨柜）';
  return `${where}[${i.source}] ${i.label} —— ${HIT_ZH[i.hit]}${i.why ? `：${i.why}` : ''}`;
}
