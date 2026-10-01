/**
 * ══════════════════════════════════════════════════════════════════════
 *  规划编排（P9.5 Phase B）—— 把**语义请求**变成**候选 + 评分**
 *
 *  ── 这条链就是本文件的全部 ──
 *      PlannerRequest
 *        ↓  （语义归一化：id 是否真的存在 / 是否 active / 规模是否超限）
 *      确定性候选枚举  ← 复用 P9.3 `generateCandidateLayouts`（零第二份枚举）
 *        ↓  （每条落位仍**必须**过 `resolvePlacement` —— 那是 P9.3 内部的事）
 *      CandidateLayout[]
 *        ↓
 *      确定性评分      ← 复用 P9.4 `scoreCandidateLayoutSet`（零第二份判定）
 *        ↓
 *      DesignScore[]
 *
 *  ── 绝不做什么（§一 的禁令逐条落在这里）──
 *    · 不生成 x / y / rotation（本文件里没有任何坐标计算）—— 坐标只出自 P9.3 内的 `resolvePlacement`；
 *    · 不生成 polygon / wall coordinate（不 import 任何几何模块）；
 *    · 不改 Opening、不调 CommandBus、不改 Semantic Model（本文件不 import 它们）；
 *    · 不自己判 collision / door swing / score（全部读既有层的结论）；
 *    · 不自动选 winner、不自动 adopt（`PlannerPlan` 里没有这类字段）；
 *    · 不改入参 project（生成器在克隆副本上试算，本文件只读它）。
 *
 *  ── 偏好（§十一）──
 *    Planner **不自己读** Knowledge：它把 `entries` 原样转发给 P9.4 评分层，
 *    由 `resolveKnowledge` 决定谁能进 `applicable`（candidate / rejected /
 *    被硬规则压制的天然进不去）。本文件不 import 存储、不新增、不升级偏好。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Project } from '../types.ts';
import { generateCandidateLayouts, type CandidateRequest } from '../candidateLayout/index.ts';
import { scoreCandidateLayoutSet } from '../designScore/index.ts';
import { activeDesignIntents } from '../designIntent/model.ts';
import { designIntentGoalZh, type DesignIntentGoal } from '../designIntent/vocabulary.ts';
import type { KnowledgeEntry } from '../../ai/knowledge/model.ts';
import { normalizePlannerRequest } from './request.ts';
import type { PlannerPlan, PlannerRunResult, PlannerUnresolved } from './model.ts';

/**
 * 规划并枚举候选（**纯函数**：同输入同输出，不改 `project`）。
 *
 * @param project 当前项目（**只读**）
 * @param raw     AI 或界面给的规划请求（形状已过契约；语义在这里查）
 * @param entries Knowledge 条目（可选）。**只转发给评分层**，本层不读它
 */
export function planCandidates(project: Project, raw: unknown, entries: KnowledgeEntry[] = []): PlannerRunResult {
  const norm = normalizePlannerRequest(raw, project);
  if (!norm.ok) return { ok: false, error: norm.error, unresolved: norm.unresolved };
  const { request } = norm;
  const unresolved: PlannerUnresolved[] = [...norm.unresolved];
  const explanations: string[] = [];

  // ── ① 决定这次规划要按哪几条意图枚举 ──
  //   · 显式给了 intentIds → 就用它（归一化时已滤成 active）
  //   · 否则 → 全部 active 意图
  //   · 给了 generationGoals → 再按"目标方向"收窄（**本次没要求的方向**如实记，不静默丢）
  const active = activeDesignIntents(project);
  const base = request.intentIds && request.intentIds.length > 0
    ? active.filter((i) => request.intentIds!.includes(i.id))
    : [...active];

  let effectiveIds = base.map((i) => i.id);
  if (request.generationGoals && request.generationGoals.length > 0) {
    const want = new Set<DesignIntentGoal>(request.generationGoals);
    const kept = base.filter((i) => want.has(i.goal));
    for (const i of base) {
      if (!want.has(i.goal)) {
        unresolved.push({
          intentId: i.id,
          goal: i.goal,
          reason: `本次规划没有要求「${designIntentGoalZh(i.goal)}」这个方向，所以没有为它枚举候选`,
        });
      }
    }
    // 问了方向，但项目里没有对应的生效意图 —— 如实说（不替它编一条意图出来）
    const covered = new Set(base.map((i) => i.goal));
    for (const g of request.generationGoals) {
      if (!covered.has(g)) {
        unresolved.push({
          goal: g,
          reason: `要求了方向「${designIntentGoalZh(g)}」，但项目里没有对应的生效意图 —— 本层不会替你造一条意图`,
        });
      }
    }
    effectiveIds = kept.map((i) => i.id);
  }

  /**
   * ── 阈值陷阱：`generateCandidateLayouts` 把"intentIds 为空"读成"用全部 active" ──
   * 那是它对"没给筛选条件"的合理口径，但在这里会变成**静默扩大范围**
   * （用户筛掉了全部方向，系统却按整屋规划）。所以这里**提前返回**，
   * 明确说"按你的条件一条都没剩下"，而不是把请求改写成另一件事。
   */
  if (effectiveIds.length === 0) {
    const plan: PlannerPlan = {
      request,
      unresolved: [
        ...unresolved,
        { reason: '按本次请求的条件，没有任何 active 意图被选中 —— 没有可枚举的目标（本层不会退回"按整屋规划"）' },
      ],
      candidates: [],
      scores: [],
      explanations: ['本次规划没有选中任何设计意图，因此没有枚举候选。'],
    };
    return { ok: true, plan };
  }

  // ── ② 确定性枚举（P9.3）—— 零第二份枚举 ──
  const candidateRequest: CandidateRequest = {
    scope: request.scope,
    ...(effectiveIds.length > 0 ? { intentIds: effectiveIds } : {}),
    ...(request.cabinetIds && request.cabinetIds.length > 0 ? { cabinetIds: request.cabinetIds } : {}),
    ...(request.maxCandidates !== undefined ? { maxCandidates: request.maxCandidates } : {}),
  };
  const set = generateCandidateLayouts(project, candidateRequest);
  // 生成器的 unresolved 形状是 `{intentId?, cabinetId?, reason}` —— 与规划层同构，原样带上（不重述、不改写）
  unresolved.push(...set.unresolved);

  // ── ③ 确定性评分（P9.4）—— 零第二份判定；entries 只转发，本层不读 ──
  const scores = scoreCandidateLayoutSet(project, set, entries);

  // ── ④ 如实说明本层的边界（P9.7 起按是否产出了整体候选条件化）──
  const cabinetCount = request.cabinetIds?.length ?? 0;
  const hasCoordinated = set.candidates.some((c) => c.placements.length > 1);
  if (hasCoordinated) {
    explanations.push(
      '本层包含**多柜整体候选**：一份候选同时重摆多只柜（整墙链 / L 型拼接），' +
        '成员落位由批量 Resolver 依赖排序算出、整体在克隆副本上验证 —— 不是把几份单柜候选拼起来。'
    );
  } else if (cabinetCount > 1 || set.candidates.length > 1) {
    explanations.push(
      '本层是**逐柜独立**枚举：每份候选只重摆一只柜，多只柜只是并列地各出几份。' +
        '它**不生成**"把这几只柜作为一个整体同时挪"的联动方案（那需要组合搜索，本阶段不做）。'
    );
    unresolved.push({
      reason: '本层逐柜独立枚举，不生成"多只柜整体联动"的方案（组合搜索留待后续；不把"逐柜各自最优"冒充成"整墙最优"）',
    });
  }
  explanations.push(
    `本次规划：按 ${effectiveIds.length} 条意图 × ${set.candidates.length} 份候选产出 ${scores.length} 份评分。` +
      '候选的坐标全部来自落位引擎（唯一出口），评分全部来自 P9.4 的确定性评分层 —— 本层没有第二份判定。'
  );
  explanations.push('本层**不选方案**：给出多份候选时只说明各份满足了什么、还有什么没满足；选哪份由用户拍板。');

  const plan: PlannerPlan = {
    request,
    unresolved,
    candidates: set.candidates,
    scores,
    explanations,
    ...(set.generation ? { generation: set.generation } : {}),
  };
  return { ok: true, plan };
}

/**
 * 人话摘要（界面 / 报告共用一处；**不返回"推荐哪一份"**）。
 * 与 P9.4 `designScoreSummaryZh` 同一条纪律：摘要只说事实，不做推荐。
 */
export function plannerPlanSummaryZh(plan: PlannerPlan): string {
  const okCount = plan.scores.filter((s) => s.score.status === 'valid').length;
  const bad = plan.scores.length - okCount;
  const un = plan.unresolved.length;
  return (
    `规划：${plan.candidates.length} 份候选（可用 ${okCount} / 不可行 ${bad}）` +
    (un > 0 ? `，另有 ${un} 件未解决事项` : '') +
    ' —— 不推荐、不 adopt'
  );
}
