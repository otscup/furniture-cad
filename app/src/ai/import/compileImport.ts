import type { ImportOrigin, Project, RuleSet } from '../../core/types.ts';
import type { DesignProposal } from '../proposal.ts';
import { compileProposal, type ProposalCompile } from '../compileProposal.ts';
import {
  importBlocked,
  normalizedToProposal,
  validateNormalized,
  type NormalizedDesign,
} from './normalized.ts';

/**
 * NormalizedDesign → AiAction[]（确定性编译，复用 P3 DesignProposal 同链路）。
 *
 * 与 compileProposal 的关系：本函数 = compileProposal + 来源归属注入。
 *   · 先 validateNormalized（形状门 IMPORT-SHAPE + 通用 PROPOSAL-* + IMPORT-* 专属）；
 *   · 阻断条件（ERROR / OPEN-QUESTIONS / UNCERTAINTY）直接返回 ok:false；
 *   · 否则投影成 DesignProposal 交给 compileProposal（房间 / 尺寸 / 分区的确定性编译）；
 *   · 最后把每个 cabinet.create 动作的 origin 补上（来自 ND 的 source/label/batchId/confidence/uncertainty）。
 *
 * 产物仍走 dryRunPlan → 预览 → commitPlan → CommandBus，与 AI 设计通道同权同位。
 * 这是「Import 不绕过 Semantic Model / Rules / CommandBus」的结构性兑现。
 */
export interface ImportCompile extends ProposalCompile {
  /** ref → 该柜的来源归属（UI 可用来逐柜展示，落库时随 action.origin 写入 Cabinet） */
  origins: Map<string, ImportOrigin>;
}

export function compileImport(nd: NormalizedDesign, project: Project, rules: RuleSet): ImportCompile {
  const issues = validateNormalized(nd, project);
  if (importBlocked(issues)) {
    const blocking = issues.filter(
      (i) => i.severity === 'ERROR' || i.code === 'IMPORT-OPEN-QUESTIONS' || i.code === 'IMPORT-UNCERTAINTY',
    );
    return {
      ok: false,
      actions: [],
      issues,
      notes: [],
      assumptions: nd.assumptions ?? [],
      blockedReason: blocking.map((i) => i.message).join('；') || '这份导入有拦不住的问题',
      origins: new Map(),
    };
  }

  const proposal: DesignProposal = normalizedToProposal(nd);
  const compiled = compileProposal(proposal, project, rules);
  if (!compiled.ok) {
    return { ...compiled, origins: new Map() };
  }

  // 注入 origin：按 ref 对应 cabinet.create 动作
  const origins = new Map<string, ImportOrigin>();
  for (const c of nd.cabinets) {
    const ref = String(c.ref);
    origins.set(ref, {
      source: c.source ?? nd.source,
      label: nd.label,
      batchId: nd.batchId,
      confidence: c.confidence,
      uncertainty: c.uncertainty,
    });
  }
  const actions = compiled.actions.map((a) => {
    if (a.action === 'cabinet.create' && a.ref && origins.has(a.ref)) {
      return { ...a, origin: origins.get(a.ref) };
    }
    return a;
  });

  return { ...compiled, actions, origins };
}
