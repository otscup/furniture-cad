/**
 * ══════════════════════════════════════════════════════════════════════
 *  Multi-Candidate Compare —— 纯逻辑层（P9.6）
 *
 *  ══════════════════════════════════════════════════════════════════════
 *  这一层**没有任何 JSX、没有任何 React**：它只把 P9.3 `CandidateLayout` +
 *  P9.4 `DesignScore` + P9.5 `PlannerPlan` 的**运行态**整理成一份可展示的
 *  DTO（关联候选与评分、翻译设计意图命中矩阵、决定显示排序）。
 *
 *  ── 三条不变量（与渲染层同一纪律）──
 *  ① 不造 winner：`sortComparisonRows` 只排显示顺序，且只用 `compareDesignScores()`；
 *     它**返回**一个重排行数组，不标注"哪份最好"，也不写任何 winner 字段。
 *  ② 不重算：collision / wall contact / score / preference 全部直接读 `plan`，
 *     本层不调任何判定函数、不 import 任何几何 / 校验 / 评分模块（只读类型与排序器）。
 *  ③ 不写模型：这里只产生投影对象，没有 Command、没有 sessionStorage、没有 project.json。
 *
 *  ── 为什么独立成 .ts（不是 .tsx）──
 *  验收脚本（`verify/candidate-compare-acceptance.ts`）是 Node 直接跑的，
 *  不能 import 带 JSX 的 .tsx；纯逻辑抽到 .ts 才能被双方复用，
 *  也逼出"展示投影"与"渲染"的边界（与 `placementIntent.ts` 同一手法）。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { PlannerPlan } from '../../core/planner/model.ts';
import type { CandidateGenerationStats, CandidateLayout } from '../../core/candidateLayout/model.ts';
import type { DesignScore, EvaluatedCandidate } from '../../core/designScore/model.ts';
import { SCORE_WEIGHT_POLICY, compareDesignScores } from '../../core/designScore/index.ts';
import { candidateKey } from '../../core/candidateLayout/generate.ts';
import { buildCandidateExplanation, type CandidateExplanation } from '../../core/candidateLayout/explain.ts';

/** 稳定显示序号 A/B/C…（按 `plan.candidates` 的稳定顺序） */
export function candidateLabel(index: number): string {
  const LETTERS = 'ABCDEFGHIJKLMNOPQRST';
  return LETTERS[index] ?? `C${index + 1}`;
}

/** 一份对比行：一个候选 + 它的评分（按 candidateId 关联）+ 它的**只读解释投影** */
export interface CandidateComparisonRow {
  label: string;
  layout: CandidateLayout;
  score: DesignScore;
  /**
   * 解释（P9.9 S1）：`(layout, score)` 的**只读投影**，与 UI 展示逐字同源。
   * 放在 DTO 里（而不是渲染层现算）的理由：① 渲染层保持"只渲染不判断"；
   * ② 验收与界面消费**同一份**对象，不会出现"验收绿、界面显示另一套"。
   */
  explanation: CandidateExplanation;
}

/** 跨候选的设计意图对比：每条 intent → 每个候选的命中（yes/no/unknown） */
export interface IntentMatrixRow {
  intentId: string;
  goal: string;
  label: string;
  byCandidate: Record<string, 'yes' | 'no' | 'unknown'>;
}

/** 纯 UI/运行态 DTO：只引用既有 layout/score，不持有几何 */
export interface CandidateComparison {
  plan: PlannerPlan;
  rows: CandidateComparisonRow[];
  intentMatrix: IntentMatrixRow[];
  /** 候选搜索台账（P9.8 运行态 `plan.generation`）的**转述**；undefined = 本轮未启用协调枚举 */
  generation: CandidateGenerationStats | undefined;
}

/** 缺失评分的兜底：必须是 infeasible（不假成 valid / 不折算 0 分） */
function missingScore(targetId: string): DesignScore {
  return {
    status: 'infeasible',
    total: null,
    totalKind: 'none',
    weights: SCORE_WEIGHT_POLICY,
    components: [],
    hardFailures: [
      {
        code: 'MISSING-SCORE',
        severity: 'ERROR',
        target: targetId,
        message: '该候选没有对应的评分（候选与评分未关联）—— 按不可行处理，不假装可用',
        source: 'candidate-issues',
      },
    ],
    preferenceMatches: [],
    explanations: ['候选与评分未关联，按 infeasible 处理'],
  };
}

/** 把 PlannerPlan 的 candidates[] 与 scores[] 按 candidateId 关联成展示行 */
export function buildCandidateComparison(plan: PlannerPlan): CandidateComparison {
  const scoreById = new Map<string, DesignScore>();
  for (const e of plan.scores as EvaluatedCandidate[]) scoreById.set(e.candidateId, e.score);
  const rows: CandidateComparisonRow[] = plan.candidates.map((layout, i) => {
    const score = scoreById.get(layout.id) ?? missingScore(layout.placements[0]?.targetId ?? '');
    return {
      label: candidateLabel(i),
      layout,
      score,
      explanation: buildCandidateExplanation(layout, score),
    };
  });
  return { plan, rows, intentMatrix: buildIntentMatrix(rows), generation: plan.generation };
}

/**
 * 跨候选的"满足哪些设计意图"对比：只翻译 `score.components` 里带 intentId 的项，
 * 不重新解释、不重判。某候选缺某条 intent 的 component ⇒ 该格记 unknown（判不出来 ≠ 没满足）。
 */
export function buildIntentMatrix(rows: CandidateComparisonRow[]): IntentMatrixRow[] {
  const byIntent = new Map<string, IntentMatrixRow>();
  for (const row of rows) {
    for (const c of row.score.components) {
      if (!c.intentId) continue;
      let m = byIntent.get(c.intentId);
      if (!m) {
        m = { intentId: c.intentId, goal: c.goal ?? c.intentId ?? '', label: c.label, byCandidate: {} };
        byIntent.set(c.intentId, m);
      }
      m.byCandidate[row.layout.id] = c.hit === 'yes' ? 'yes' : c.hit === 'no' ? 'no' : 'unknown';
    }
  }
  return [...byIntent.values()];
}

/**
 * 显示排序：只用 `compareDesignScores()`，且是"显示排序、非 winner 判定"。
 * 默认（sortByScore=false）保留 Candidate Generator 的稳定顺序（A/B/C）。
 * 本函数不返回"哪份最好"，只返回一个重排后的行数组；labels 随行走。
 */
export function sortComparisonRows(rows: CandidateComparisonRow[], sortByScore: boolean): CandidateComparisonRow[] {
  if (!sortByScore) return rows;
  return [...rows].sort((a, b) => compareDesignScores(a.score, b.score));
}

// ═══════════════════════════ 探索台账转述（P9.9 S1）═══════════════════════════

/**
 * 把 P9.8 的 `CandidateGenerationStats` 转述成人话行 —— **只转述，不重算、不推断**。
 *
 * 纪律：
 *   · 每个数字都**直接来自** `stats`，不做任何四则运算（不做百分比、不做差值）；
 *   · 不判断"够不够好"，不做优劣排序 —— 它只回答"搜了多少、为什么没搜完"；
 *   · `budgetExhausted` 必须如实说成"没搜完"，**不许**说成"没有候选"（两者天差地别）。
 */
export function generationLedgerZh(stats: CandidateGenerationStats | undefined): string[] {
  if (!stats) return [];
  const out: string[] = [];

  out.push(`本次请求最多 ${stats.requested} 条候选；枚举产出有效候选 ${stats.generated} 条，实际返回 ${stats.returned} 条。`);
  if (stats.truncated > 0) {
    out.push(
      `有 ${stats.truncated} 条因上限没返回` +
        (stats.generationLimited ? '（枚举空间被上限截断 —— 不是搜不出，是没让返回）。' : '。'),
    );
  }

  if (stats.explored !== undefined) {
    const r = stats.rejected;
    const rejectedZh = r ? `解析失败 ${r.resolve} 条、有冲突 ${r.collision} 条、与已得候选重复 ${r.duplicate} 条` : '原因未分类';
    out.push(`一共评估过 ${stats.explored} 个组合；其中被丢弃：${rejectedZh}。`);
  }

  if (stats.budget !== undefined) {
    out.push(
      `本次评估预算上限 ${stats.budget} 个组合` +
        (stats.budgetExhausted ? '—— 预算已耗尽、提前停止：这是"没搜完"，不是"搜不出"。' : '（未耗尽）。'),
    );
  }

  return out;
}

// ═══════════════════════════ Selection 身份（P9.9 S3）═══════════════════════════
/**
 * 一条被选中的候选（**session 运行态**）：位置性 `candidateId` + 内容键 `key`。
 *
 * ── 为什么必须两个一起（§9.2 的真实错指）──
 *  候选 id 是**位置性**的（每轮从 `cl_001` 起，见 `candidateLayoutId`），
 *  所以"选中 cl_003"在**重新生成**后会指到**另一个候选**。稳定身份只能来自**内容** ——
 *  即既有的 `candidateKey`（内容签名）。两个一起存，恢复时**双重校验**。
 */
export interface StoredCandidateSelection {
  candidateId: string;
  key: string;
}

/**
 * 恢复选中：`{candidateId, key}` 必须**同时**成立 ——
 *  - id 在本次 plan 里找得到，**且**
 *  - 该候选的当前 `candidateKey` 与存下来的 key **逐字符相同**。
 *
 * 任一不成立 ⇒ 返回 `null`（**失效**）。调用方必须据此**清除**选中，
 * **绝不回退**到"id 相同就认"（那正是旧 bug：内容变了还高亮着别人）。
 *
 * 纯函数：不写 sessionStorage、不碰 bus、不读 project —— 便于验收直测。
 */
export function resolveSelection(
  plan: PlannerPlan | null,
  stored: StoredCandidateSelection | null | undefined,
): StoredCandidateSelection | null {
  if (!plan || !stored) return null;
  const c = plan.candidates.find((x) => x.id === stored.candidateId);
  if (!c) return null;
  const key = candidateKey(c);
  if (key !== stored.key) return null; // 内容变了 ⇒ 失效，不回退
  return { candidateId: c.id, key };
}
