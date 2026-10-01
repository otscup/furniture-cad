/**
 * ══════════════════════════════════════════════════════════════════════
 *  候选评分的 AI 只读上下文（P9.4，§十二）
 *
 *  ── 这一块回答什么 ──
 *    "如果把这批柜子重摆一下，系统算出来的那几份候选分别会得到什么结果？"
 *    给的是**结论摘要**（可用 / 不可行、命中几项、有哪些阻断错误码），
 *    不是一个裸分数，更不是"哪份最好"。
 *
 *  ── 三条纪律（少一条这块就变成 AI 的第二真相源）──
 *    ① **只读**：`readOnly: true`。AI 可以据此理解现状，**不能据此决策**
 *       —— "AI 看到评分 ≠ AI 自动选择"（§十二）。落地必须走 CommandBus 且由用户拍板，
 *       而本块连 Command 都不产生（这里根本没有写路径）。
 *    ② **零坐标**：投影里没有任何 `{x,y}`、任何 x/y/rotation、任何多边形。
 *       候选的坐标本来就只在 `CandidateLayout`（运行态）里，且由 `resolvePlacement` 唯一产出；
 *       这一块是**再投影一层**，只留结论，坐标一个字都不出去
 *       （与 P9.1 `spatialContext` / P9.2 `designIntent` 同一条纪律）。
 *    ③ **不做第二份判定**：候选由 `generateCandidateLayouts`（P9.3 确定性枚举）产出，
 *       分数由 `scoreCandidateLayoutSet`（P9.4 纯组合层）产出 ——
 *       本文件一次判定都不做，只把结果重塑形。
 *
 *  ── 为什么 `preferencesApplied: false` ──
 *    偏好要经 `resolveKnowledge(entries)` 才能判定，而快照构建这条路上**没有** Knowledge
 *    条目（读 store 会把存储/环境耦合进快照构建，且在无浏览器的验收环境里会假失败）。
 *    与其在这里"顺手读一下"，不如**如实标注**：这份投影不含偏好命中。
 *    宁可少说一句，也不能让模型以为"没列出来的偏好就是没命中"。
 *
 *  ── 运行态，不落盘 ──
 *    本块是**每次构建快照时现算**的，不进 `project.json`、不进 Semantic Model、
 *    不进 Knowledge —— 与候选本身（§十一）同一条纪律。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Project } from '../core/types.ts';
import { generateCandidateLayouts } from '../core/candidateLayout/index.ts';
import { scoreCandidateLayoutSet } from '../core/designScore/index.ts';

/** 一块投影里最多列几条候选（快照是要发出去的，不能把整批枚举塞进 prompt） */
export const MAX_PROJECTED_CANDIDATES = 6;

/** 一条候选的结论摘要（**没有坐标、没有分数权重**） */
export interface AiEvaluatedCandidateSummary {
  id: string;
  /** 生命周期（§十一）：枚举出来是 draft，评过就是 evaluated —— 类型层没有 adopted */
  lifecycle: 'evaluated';
  /** 闸门结论：valid = 过了硬约束；infeasible = 有阻断错误（**不评分**） */
  status: 'valid' | 'infeasible';
  /** 总分 = 命中项数（无权重）；infeasible 时是 null —— 注意 null ≠ 0 分 */
  total: number | null;
  /** 有几条判据当前**判不出来**（如实登记，不算作"没命中"） */
  unavailable: number;
  /** 阻断错误码（只有 code，不带文案；infeasible 时非空） */
  hardFailures: string[];
}

export interface AiCandidateScoreContext {
  /** 显式声明只读（给模型看的）—— 它**不是**可改的对象，也不是决策依据 */
  readOnly: true;
  note: string;
  /** 本投影是否算入了用户偏好（恒 false，见文件头） */
  preferencesApplied: false;
  /** 计数（`truncated` = 实际候选比这里列出的多） */
  counts: { evaluated: number; feasible: number; infeasible: number; truncated: boolean };
  evaluated: AiEvaluatedCandidateSummary[];
}

/**
 * 构建只读投影（**纯函数**：不改 project、不读存储、无随机无时钟）。
 *
 * 没有 active 设计意图 ⇒ 产不出候选 ⇒ `evaluated: []`（不是错误，是如实）。
 * 所以这一块**永远出现**，形状稳定（与 `spatialContext` / `designIntent` 一致）。
 */
export function buildCandidateScoreContext(project: Project): AiCandidateScoreContext {
  // ① 确定性枚举（P9.3）—— 只认 active 意图；没有 active 意图时天然是空集
  const set = generateCandidateLayouts(project, { scope: 'project' });
  // ② 确定性评分（P9.4）—— Gate → 条件命中（偏好不在本投影里，见文件头）
  const all = scoreCandidateLayoutSet(project, set, []);
  const projected = all.slice(0, MAX_PROJECTED_CANDIDATES);

  const evaluated: AiEvaluatedCandidateSummary[] = projected.map((e) => ({
    id: e.candidateId,
    lifecycle: e.lifecycle,
    status: e.score.status,
    total: e.score.total,
    unavailable: e.score.components.filter((c) => c.kind === 'unavailable').length,
    hardFailures: e.score.hardFailures.map((f) => f.code),
  }));

  return {
    readOnly: true,
    note:
      '候选评分（只读）：系统对当前设计意图确定性枚举出的候选布局各打了一份分。' +
      'total = 命中项数（无权重；null = 有阻断错误、不评分）。' +
      '你可以据此理解现状，但**不能**据此选择方案或落地：选哪个必须由用户拍板，' +
      '任何改动都要走动作清单。',
    preferencesApplied: false,
    counts: {
      evaluated: evaluated.length,
      feasible: evaluated.filter((c) => c.status === 'valid').length,
      infeasible: evaluated.filter((c) => c.status === 'infeasible').length,
      truncated: all.length > evaluated.length,
    },
    evaluated,
  };
}
