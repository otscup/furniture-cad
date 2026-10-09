import type { Cabinet, CabinetGeometry, Issue, RuleSet } from '../core/types.ts';
import { validateCabinet } from '../core/rules/validate.ts';
import { ruleCard } from '../core/rules/issueCatalog.ts';

/**
 * Return production warnings from the same cabinet validator used by workspace
 * validation. Panel targets are attributed by stable generated Panel.id, never
 * by cabinet-name guesses or geometry-list positions.
 */
export function cabinetWarningIssues(
  cabinet: Cabinet,
  geometry: CabinetGeometry,
  rules: RuleSet,
): Issue[] {
  const panelIds = new Set(geometry.panels.map((panel) => panel.id));
  return validateCabinet(cabinet, geometry, rules).filter((issue) => issue.severity === 'WARNING' && (
    (issue.targetKind === 'cabinet' && issue.target === cabinet.id)
    || (issue.targetKind === 'panel' && panelIds.has(issue.target))
  ));
}

/** A self-contained, printable warning line; preserve source rule text verbatim. */
export function formatCabinetWarning(cabinet: Cabinet, issue: Issue): string {
  const title = ruleCard(issue.code)?.title;
  const rule = title ? `${issue.code} · ${title}` : issue.code;
  return `生产警告 [${rule}] ${cabinet.name}：${issue.message}`;
}
