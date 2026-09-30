/**
 * Resolver 结果 → 给 AI 规划的文本摘要。
 *
 * 这是知识进入 AI 的**唯一**方式：作为 system prompt 的一段上下文，
 * AI 的产出仍然是 DesignProposal，仍要走 validateProposal → dryRun →
 * 确认 → CommandBus。知识不给 AI 任何特权，也不给它坐标。
 *
 * 摘要里明确写着「不能违反硬规则」—— 即便模型忽略，Rules 也会拦；
 * 这段话是教，Gate 是拦，Test 是钉（纠错三通道各司其职）。
 */

import type { KnowledgeResolution } from './resolver.ts';
import type { KnowledgeEntry } from './model.ts';

const LAYER_ZH: Record<KnowledgeEntry['layer'], string> = {
  hardRule: '硬规则（必须遵守，违反会被拒绝）',
  designKnowledge: '设计知识（通常这样做）',
  userPreference: '用户偏好（该用户习惯这样做）',
};

const PRED_ZH: Record<string, string> = {
  drawerCount: '分区件数',
  rowHeight: '行高',
  cabinetWidth: '柜宽',
  cabinetDepth: '柜深',
  unitKind: '分区类型',
  layoutStyle: '布局风格',
};

export function knowledgeDigest(res: KnowledgeResolution): string {
  const usable = res.applicable.filter((r) => r.entry.layer !== 'hardRule' || r.entry.predicate);
  if (usable.length === 0 && res.conflicts.length === 0) return '';

  const lines: string[] = ['【设计知识参考】以下是可复用的知识，供你规划时参考：'];

  for (const { entry, why, confirmed } of usable) {
    const pred = entry.predicate ? `（${PRED_ZH[entry.predicate.kind] ?? entry.predicate.kind} ${entry.predicate.op === 'prefer' ? '建议' : entry.predicate.op === 'min' ? '≥' : entry.predicate.op === 'max' ? '≤' : '禁止'} ${entry.predicate.value}）` : '';
    lines.push(`· [${LAYER_ZH[entry.layer]}] ${entry.statement}${pred}${confirmed ? '' : '〔未确认〕'} —— ${why}`);
  }

  if (res.conflicts.length > 0) {
    lines.push('【知识冲突 —— 必须遵守硬规则一方，不得绕过】');
    for (const c of res.conflicts) lines.push(`· ${c.reason}`);
  }

  lines.push('硬规则永远优先于以上一切建议；你的方案仍将通过规则校验，违反即被拒。');
  return lines.join('\n');
}
