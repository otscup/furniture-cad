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
import { PLACEMENT_KINDS, placementContextZh, type KnowledgeEntry } from './model.ts';

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
  orientation: '柜体朝向',
};

/**
 * 落位偏好的免责条款 —— 必须跟偏好一起出现，一次都不能省。
 *
 * 没有它，模型会把"右转角偏好 270°"读成"转角一律 270°"，然后把左转角的
 * 方案也写成 270 —— 偏好就退化成了它最不该成为的东西：一条硬编码的设计习惯。
 */
const PLACEMENT_NOTE =
  '【落位偏好】上面带「适用情形」的朝向只是**偏好**：只在同类情形（同样的接触形态与转角方向）下才作参考，' +
  '换个转角方向就不一定成立，更不覆盖任何硬规则。它不改变几何 —— 最终位置仍由系统确定性解析，' +
  '仍要过设计语义校验。若存在多个同样合法的朝向，请保留 ambiguity（把候选都列出来），不要替用户挑一个。';

export function knowledgeDigest(res: KnowledgeResolution): string {
  const usable = res.applicable.filter((r) => r.entry.layer !== 'hardRule' || r.entry.predicate);
  if (usable.length === 0 && res.conflicts.length === 0) return '';

  const lines: string[] = ['【设计知识参考】以下是可复用的知识，供你规划时参考：'];

  for (const { entry, why, confirmed } of usable) {
    const p = entry.predicate;
    const unit = p?.kind === 'orientation' ? '°' : '';
    const opZh = p ? (p.op === 'prefer' ? '建议' : p.op === 'min' ? '≥' : p.op === 'max' ? '≤' : '禁止') : '';
    const ctx = p?.context ? `〔适用情形：${placementContextZh(p.context)}〕` : '';
    const pred = p ? `（${PRED_ZH[p.kind] ?? p.kind} ${opZh} ${p.value}${unit}）` : '';
    lines.push(`· [${LAYER_ZH[entry.layer]}] ${entry.statement}${ctx}${pred}${confirmed ? '' : '〔未确认〕'} —— ${why}`);
  }

  const hasPlacement = usable.some(({ entry }) => entry.predicate && PLACEMENT_KINDS.includes(entry.predicate.kind));
  if (hasPlacement) lines.push(PLACEMENT_NOTE);

  if (res.conflicts.length > 0) {
    lines.push('【知识冲突 —— 必须遵守硬规则一方，不得绕过】');
    for (const c of res.conflicts) lines.push(`· ${c.reason}`);
  }

  lines.push('硬规则永远优先于以上一切建议；你的方案仍将通过规则校验，违反即被拒。');
  return lines.join('\n');
}
