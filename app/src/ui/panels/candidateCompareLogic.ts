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
import type { CandidateLayout } from '../../core/candidateLayout/model.ts';
import type { DesignScore, EvaluatedCandidate } from '../../core/designScore/model.ts';
import { SCORE_WEIGHT_POLICY, compareDesignScores } from '../../core/designScore/index.ts';

/** 稳定显示序号 A/B/C…（按 `plan.candidates` 的稳定顺序） */
export function candidateLabel(index: number): string {
  const LETTERS = 'ABCDEFGHIJKLMNOPQRST';
  return LETTERS[index] ?? `C${index + 1}`;
}

/** 一份对比行：一个候选 + 它的评分（按 candidateId 关联） */
export interface CandidateComparisonRow {
  label: string;
  layout: CandidateLayout;
  score: DesignScore;
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
  const rows: CandidateComparisonRow[] = plan.candidates.map((layout, i) => ({
    label: candidateLabel(i),
    layout,
    score: scoreById.get(layout.id) ?? missingScore(layout.placements[0]?.targetId ?? ''),
  }));
  return { plan, rows, intentMatrix: buildIntentMatrix(rows) };
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
