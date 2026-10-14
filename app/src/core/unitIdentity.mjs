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

/**
 * 显式修复项目内的重复 Unit/backUnit ID（仅在用户点击「一键修复」或调用修复 API 时执行）。
 * 遵循 canonical 规则：若存在 layout.rows，先修复 rows[i].units，再将 rows[0].units 同步镜像回 layout.units。
 */
export function repairDuplicateUnitIdsInProject(inputProject) {
  if (!inputProject || typeof inputProject !== 'object' || Array.isArray(inputProject)) {
    return { project: inputProject, repairedCount: 0 };
  }
  const project = structuredClone(inputProject);
  const cabinets = Array.isArray(project.cabinets) ? project.cabinets : [];
  const seen = new Set();
  let repairedCount = 0;

  const allocUnitId = () => {
    let n = 1;
    while (seen.has(`unit_${String(n).padStart(3, '0')}`)) n += 1;
    const id = `unit_${String(n).padStart(3, '0')}`;
    seen.add(id);
    return id;
  };

  const fixUnitList = (units) => {
    if (!Array.isArray(units)) return;
    for (const unit of units) {
      if (!unit || typeof unit !== 'object' || Array.isArray(unit)) continue;
      const id = typeof unit.id === 'string' ? unit.id.trim() : '';
      if (!id || seen.has(id)) {
        unit.id = allocUnitId();
        repairedCount += 1;
      } else {
        seen.add(id);
      }
    }
  };

  for (const cabinet of cabinets) {
    if (!cabinet || typeof cabinet !== 'object' || Array.isArray(cabinet)) continue;
    const layout = cabinet.layout;
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) continue;
    if (Array.isArray(layout.rows) && layout.rows.length > 0) {
      for (const row of layout.rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        fixUnitList(row.units);
      }
      if (Array.isArray(layout.rows[0]?.units)) {
        layout.units = structuredClone(layout.rows[0].units);
      }
    } else {
      fixUnitList(layout.units);
    }
    if (Array.isArray(layout.backUnits)) {
      fixUnitList(layout.backUnits);
    }
  }

  return { project, repairedCount };
}

/**
 * 检测并自动错开平面坐标重叠的房间（连同归属该房间的柜体一并平移）。
 */
export function deoverlapProjectRooms(inputProject, gapMm = 800) {
  if (!inputProject || typeof inputProject !== 'object' || Array.isArray(inputProject)) {
    return { project: inputProject, movedRooms: [] };
  }
  const project = structuredClone(inputProject);
  const rooms = Array.isArray(project.rooms) ? project.rooms : [];
  const cabinets = Array.isArray(project.cabinets) ? project.cabinets : [];
  const placedBoxes = [];
  const movedRooms = [];

  const roomBBox = (room) => {
    if (!room || !Array.isArray(room.walls) || room.walls.length === 0) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const w of room.walls) {
      if (!w?.start || !w?.end) continue;
      for (const pt of [w.start, w.end]) {
        if (typeof pt.x === 'number' && pt.x < minX) minX = pt.x;
        if (typeof pt.y === 'number' && pt.y < minY) minY = pt.y;
        if (typeof pt.x === 'number' && pt.x > maxX) maxX = pt.x;
        if (typeof pt.y === 'number' && pt.y > maxY) maxY = pt.y;
      }
    }
    if (!(maxX > minX && maxY > minY)) return null;
    return { minX, minY, maxX, maxY };
  };

  for (const room of rooms) {
    const box = roomBBox(room);
    if (!box) continue;
    const overlapsExisting = placedBoxes.some(
      (b) => box.minX < b.maxX && box.maxX > b.minX && box.minY < b.maxY && box.maxY > b.minY
    );
    if (overlapsExisting) {
      const maxExistingX = placedBoxes.reduce((m, b) => Math.max(m, b.maxX), 0);
      const dx = Math.round(maxExistingX + gapMm - box.minX);
      const dy = Math.round(0 - box.minY);
      for (const w of room.walls) {
        w.start = { x: Math.round(w.start.x + dx), y: Math.round(w.start.y + dy) };
        w.end = { x: Math.round(w.end.x + dx), y: Math.round(w.end.y + dy) };
      }
      for (const cab of cabinets) {
        if (cab && cab.roomId === room.id && cab.placement) {
          cab.placement = {
            ...cab.placement,
            x: Math.round(cab.placement.x + dx),
            y: Math.round(cab.placement.y + dy),
          };
        }
      }
      const nextBox = {
        minX: box.minX + dx,
        minY: box.minY + dy,
        maxX: box.maxX + dx,
        maxY: box.maxY + dy,
      };
      placedBoxes.push(nextBox);
      movedRooms.push({ roomId: room.id, roomName: room.name, dx, dy });
    } else {
      placedBoxes.push(box);
    }
  }

  return { project, movedRooms };
}
