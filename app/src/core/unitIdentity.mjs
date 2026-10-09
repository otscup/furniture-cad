/**
 * Pure identity scan shared by the browser CommandBus, WorkspaceStore and production exports.
 * It follows the canonical layout shape: rows are authoritative when present, so layout.units
 * (the legacy mirror of rows[0]) is never counted a second time.
 */
export function findDuplicateUnitIds(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) return [];
  const cabinets = Array.isArray(project.cabinets) ? project.cabinets : [];
  const locationsById = new Map();
  const addUnits = (units, prefix) => {
    if (!Array.isArray(units)) return;
    units.forEach((unit, index) => {
      if (!unit || typeof unit !== 'object' || Array.isArray(unit)) return;
      const id = typeof unit.id === 'string' ? unit.id : '';
      if (!id) return;
      const locations = locationsById.get(id) ?? [];
      locations.push(`${prefix}[${index}]`);
      locationsById.set(id, locations);
    });
  };
  cabinets.forEach((cabinet, cabinetIndex) => {
    if (!cabinet || typeof cabinet !== 'object' || Array.isArray(cabinet)) return;
    const layout = cabinet.layout;
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) return;
    const cabinetId = typeof cabinet.id === 'string' && cabinet.id ? cabinet.id : `#${cabinetIndex}`;
    if (Array.isArray(layout.rows)) {
      layout.rows.forEach((row, rowIndex) => {
        if (!row || typeof row !== 'object' || Array.isArray(row)) return;
        const rowId = typeof row.id === 'string' ? `row:${row.id}` : `row:${rowIndex}`;
        addUnits(row.units, `cabinet:${cabinetId}.layout.rows[${rowIndex}](${rowId}).units`);
      });
    } else {
      addUnits(layout.units, `cabinet:${cabinetId}.layout.units`);
    }
    addUnits(layout.backUnits, `cabinet:${cabinetId}.layout.backUnits`);
  });
  return [...locationsById.entries()]
    .filter(([, locations]) => locations.length > 1)
    .map(([id, locations]) => ({ id, locations }));
}

export const WORKSPACE_UNIT_ID_CONFLICT = 'WORKSPACE_UNIT_ID_CONFLICT';

export function unitIdentityConflictMessage(scope, duplicates) {
  const details = duplicates.map(({ id, locations }) => `${id}（${locations.join('、')}）`).join('；');
  return `身份冲突：${scope}存在重复 Unit/backUnit ID：${details}。当前仅允许只读查看；所有项目、草稿、receipt、SharedPanel、二维图元与生产写入/导出均已拒绝。不会自动重编号或改写文件；需要显式修复/迁移后重试。`;
}

export function unitIdentityConflictError(scope, duplicates) {
  return Object.assign(new Error(unitIdentityConflictMessage(scope, duplicates)), { code: WORKSPACE_UNIT_ID_CONFLICT });
}
