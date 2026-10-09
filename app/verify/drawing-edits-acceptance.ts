import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DrawingEntity, Prim, Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { buildCabinetViews, buildProjectViews } from '../src/core/geometry/views.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { conflictsWithProductionDimension, drawingEntityPrims, drawingPrims, drawingSourceProblems, planSourceKeys, replaceDrawingEdits, sourceKeysInRect, sourceOverride, staleDrawingOverrides, translateDrawingEntity } from '../src/core/drawingEdits.ts';
import { serializeProjectFile, parseProjectFile } from '../src/core/projectFile.ts';
import { buildFurnitureSheet } from '../src/export/furnitureSheet.ts';
import { toNeutralExport } from '../src/export/neutralSheet.ts';
import { buildRoomBook } from '../src/export/roomBook.ts';

const rules = JSON.parse(readFileSync('src/core/ruleset/factory-default.json', 'utf8')) as RuleSet;
const original = sampleProject(rules);
const cab = original.cabinets[0]!;
const room = original.rooms.find(r => r.id === cab.roomId)!;
assert.ok(room, 'fixture cabinet must belong to a room');

let checks = 0;
const ok = (condition: unknown, message: string): void => {
  assert.ok(condition, message);
  checks++;
};

// Source conversion must preserve styles used by the CAD renderer/exporters.
const closedDashed: Prim = {
  k: 'poly', pts: [{ x: 10, y: 20 }, { x: 90, y: 20 }, { x: 90, y: 80 }, { x: 10, y: 80 }],
  closed: true, dash: [8, 4], layer: 'QA-CLOSED-DASH', lw: 2,
};
const converted = sourceOverride('sheet:test:top:0', closedDashed, 'sheet', 'qa-closed', { cabinetId: cab.id, view: 'top' });
assert.ok(converted);
ok(converted.kind === 'polyline' && converted.closed === true && JSON.stringify(converted.dash) === '[8,4]', 'source override preserves closed and dash');
const selected = sourceKeysInRect([closedDashed], ['sheet:test:top:0'], { minX: 0, minY: 0, maxX: 100, maxY: 100 });
ok(selected.length === 1 && selected[0] === 'sheet:test:top:0', 'window selection includes a fully enclosed closed polygon');
const sourceLine = (x: number): Prim => ({ k: 'poly', pts: [{ x, y: 10 }, { x: x + 5, y: 10 }], closed: false, layer: 'QA-SOURCE', lw: 1 });
const firstSource = sourceLine(10), targetSource = sourceLine(20), insertedSource = sourceLine(0);
const keysBeforeInsert = planSourceKeys('wall:qa-order', [firstSource, targetSource]);
const targetKey = keysBeforeInsert[1]!;
const targetOverlayBase = sourceOverride(targetKey, targetSource, 'plan', 'qa-order-overlay', { roomId: room.id, layer: 'QA-OVERRIDE' });
assert.ok(targetOverlayBase);
const targetOverlay = { ...targetOverlayBase, points: [{ x: 200, y: 200 }, { x: 205, y: 200 }] };
const keysAfterInsert = planSourceKeys('wall:qa-order', [insertedSource, firstSource, targetSource]);
ok(keysAfterInsert[1] === keysBeforeInsert[0] && keysAfterInsert[2] === targetKey, 'inserting an earlier source does not change existing geometry keys');
const sourceEditProject: Project = { ...original, drawingEdits: [targetOverlay] };
const afterInsertCanvas = drawingPrims(sourceEditProject, 'plan', [insertedSource, firstSource, targetSource], keysAfterInsert);
const visibleSourceXs = afterInsertCanvas.filter(p => p.k === 'poly' && p.layer === 'QA-SOURCE').map(p => p.k === 'poly' ? p.pts[0]?.x : undefined);
ok(visibleSourceXs.includes(0) && visibleSourceXs.includes(10) && !visibleSourceXs.includes(20), 'insertion suppresses only the covered x=20 source, not the new x=0 or old x=10 source');
ok(afterInsertCanvas.some(p => p.k === 'poly' && p.layer === 'QA-OVERRIDE'), 'the moved overlay remains visible after an earlier source is inserted');
const reorderedSources = [targetSource, insertedSource, firstSource];
const reorderedCanvas = drawingPrims(sourceEditProject, 'plan', reorderedSources, planSourceKeys('wall:qa-order', reorderedSources));
const reorderedVisibleXs = reorderedCanvas.filter(p => p.k === 'poly' && p.layer === 'QA-SOURCE').map(p => p.k === 'poly' ? p.pts[0]?.x : undefined);
ok(reorderedVisibleXs.includes(0) && reorderedVisibleXs.includes(10) && !reorderedVisibleXs.includes(20), 'reordering source primitives does not redirect the suppression key');
const changedTarget = sourceLine(21);
const keysAfterGeometryChange = planSourceKeys('wall:qa-order', [firstSource, changedTarget]);
ok(staleDrawingOverrides(sourceEditProject, keysAfterGeometryChange, []).some(e => e.id === targetOverlay.id), 'changing covered source geometry explicitly marks its old override stale');
const deletedCanvas = drawingPrims(sourceEditProject, 'plan', [firstSource], planSourceKeys('wall:qa-order', [firstSource]));
ok(deletedCanvas.some(p => p.k === 'poly' && p.layer === 'QA-SOURCE' && p.pts[0]?.x === 10), 'deleting the covered source cannot suppress a remaining source');
ok(drawingSourceProblems(sourceEditProject, planSourceKeys('wall:qa-order', [firstSource]), []).some(problem => problem.code === 'DRAWING-SOURCE-STALE' && problem.entity.id === targetOverlay.id), 'deleting the covered target creates an explicit stale-source problem');
const duplicateSources = [targetSource, { ...targetSource }];
const duplicateKeys = planSourceKeys('wall:qa-order', duplicateSources);
ok(duplicateKeys[0] === duplicateKeys[1], 'completely identical source primitives are represented as multiple candidates for one fingerprint');
const duplicateCanvas = drawingPrims(sourceEditProject, 'plan', duplicateSources, duplicateKeys);
ok(duplicateCanvas.filter(p => p.k === 'poly' && p.layer === 'QA-SOURCE').length === 2, 'one override never suppresses either of two identical source candidates');
ok(drawingSourceProblems(sourceEditProject, duplicateKeys, []).some(problem => problem.code === 'DRAWING-SOURCE-AMBIGUOUS' && problem.entity.id === targetOverlay.id), 'multiple identical source candidates classify the override as ambiguous');
const fill: Prim = { k: 'fill', pts: closedDashed.pts, layer: 'QA-FILL', alpha: 0.35 };
ok(sourceOverride('sheet:test:fill:1', fill, 'sheet', 'qa-fill') === null, 'fill source is explicitly read-only');
ok(sourceKeysInRect([fill], ['sheet:test:fill:1'], { minX: 0, minY: 0, maxX: 100, maxY: 100 }).length === 0, 'window selection excludes fill primitives');
const generatedDimension: Prim = { k: 'poly', pts: [{ x: 0, y: 0 }, { x: 1000, y: 0 }], closed: false, layer: 'F-DIM', lw: 0.9 };
const manualDimension: DrawingEntity = { id: 'qa-dim-conflict', space: 'sheet', cabinetId: cab.id, view: 'front', kind: 'dimension', points: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 500, y: 200 }], textSize: 120, lineWidth: 1, layer: 'F-DIM', provenance: 'manual' };
ok(conflictsWithProductionDimension(manualDimension, [generatedDimension]), 'manual dimension matching production endpoints is detected for a warning');
ok(!conflictsWithProductionDimension({ ...manualDimension, points: [{ x: 0, y: 30 }, { x: 1000, y: 30 }, { x: 500, y: 200 }] }, [generatedDimension]), 'a separate manual measurement does not trigger the endpoint-conflict warning');
const movedSource = translateDrawingEntity(converted, 125, -75);
const copiedSource = translateDrawingEntity({ ...movedSource, id: 'qa-copy', provenance: 'manual', replacesSource: undefined }, 400, 0);
for (const [label, entity] of [['move', movedSource], ['copy', copiedSource]] as const) {
  const prim = drawingEntityPrims(entity)[0];
  ok(prim?.k === 'poly' && prim.closed && JSON.stringify(prim.dash) === '[8,4]', `${label} retains closed dashed geometry`);
}
const rotated: Prim = { k: 'text', p: { x: 5, y: 7 }, text: 'ROT', size: 120, layer: 'QA-TEXT', align: 'c', rot: 90 };
const rotatedEntity = sourceOverride('sheet:test:front:0', rotated, 'sheet', 'qa-rot', { cabinetId: cab.id, view: 'front' });
assert.ok(rotatedEntity);
ok(rotatedEntity.rot === 90 && drawingEntityPrims(rotatedEntity)[0]?.k === 'text' && drawingEntityPrims(rotatedEntity)[0]?.k === 'text' && drawingEntityPrims(rotatedEntity)[0].rot === 90, 'source override and reconstructed text preserve rot');

// Give one moved, uniquely identifiable drawing to each shared delivery space/view.
const baseViews = buildCabinetViews(cab, rules);
const placements = buildProjectViews(original, rules).placements;
const placement = placements[cab.id]!;
const dx = placement.x - baseViews.meta.front.origin.x;
const dy = placement.y - baseViews.meta.front.origin.y;
const pointOn = (view: 'top' | 'front' | 'internal', x: number, y: number) => ({
  x: baseViews.meta[view].origin.x + x + dx,
  y: baseViews.meta[view].origin.y + y + dy,
});
const topBase = pointOn('top', 240, 180);
const topEdit: DrawingEntity = {
  id: 'qa-top-closed', space: 'sheet', cabinetId: cab.id, view: 'top', kind: 'polyline',
  points: [topBase, { x: topBase.x + 140, y: topBase.y }, { x: topBase.x + 140, y: topBase.y + 90 }, { x: topBase.x, y: topBase.y + 90 }],
  textSize: 90, lineWidth: 2, closed: true, dash: [8, 4], layer: 'QA-EDIT-TOP', provenance: 'manual',
};
const frontEdit: DrawingEntity = {
  id: 'qa-front-rotated', space: 'sheet', cabinetId: cab.id, view: 'front', kind: 'text',
  points: [pointOn('front', 310, 430)], text: 'QA-FRONT-ROT-90', textSize: 125, rot: 90,
  lineWidth: 1, layer: 'QA-EDIT-FRONT', provenance: 'manual', align: 'c',
};
const internalEdit: DrawingEntity = {
  id: 'qa-internal-line', space: 'sheet', cabinetId: cab.id, view: 'internal', kind: 'line',
  points: [pointOn('internal', 170, 210), pointOn('internal', 280, 260)], textSize: 90,
  lineWidth: 2, layer: 'QA-EDIT-INTERNAL', provenance: 'manual',
};
const roomEdit: DrawingEntity = {
  id: 'qa-room-plan', space: 'plan', roomId: room.id, kind: 'line',
  points: [{ x: 150, y: 170 }, { x: 310, y: 230 }], textSize: 90, lineWidth: 2,
  layer: 'QA-EDIT-ROOM-PLAN', provenance: 'manual',
};
const movedTop = translateDrawingEntity(topEdit, 125, -75);
original.drawingEdits = [movedTop, frontEdit, internalEdit, roomEdit];

// A normal editor command, undo/redo and file round trip all keep the data in Project.
const bus = new CommandBus(sampleProject(rules), rules);
const accepted = bus.execute(replaceDrawingEdits(bus.getState(), [movedTop], 'acceptance: add drawing entity'));
ok(accepted.ok && bus.getState().drawingEdits?.[0]?.closed === true, 'drawing edit enters the command bus without touching cabinet parameters');
ok(bus.undo() && !bus.getState().drawingEdits?.length, 'drawing edit is undoable');
ok(bus.redo() && bus.getState().drawingEdits?.[0]?.dash?.[0] === 8, 'drawing edit is redoable with style intact');
const parsed = parseProjectFile(serializeProjectFile(original, '2026-10-09T00:00:00.000Z'));
ok(parsed.ok, 'drawing edits survive project save and reload validation');
if (!parsed.ok) throw new Error(parsed.error);
const project: Project = parsed.project;
const beforeGeometry = generateProject(project, rules);
const geometryChangedProject = structuredClone(project);
geometryChangedProject.cabinets.find(candidate => candidate.id === cab.id)!.params.width += 120;
const afterGeometry = generateProject(geometryChangedProject, rules);
const oldCabinetPlan = beforeGeometry.cabinets[cab.id]!.plan;
const oldCabinetKeys = planSourceKeys(`cabinet:${cab.id}`, oldCabinetPlan);
const newCabinetKeys = new Set(planSourceKeys(`cabinet:${cab.id}`, afterGeometry.cabinets[cab.id]!.plan));
const changedSourceIndex = oldCabinetPlan.findIndex((prim, index) => (prim.k === 'poly' || prim.k === 'text') && !newCabinetKeys.has(oldCabinetKeys[index]!));
assert.ok(changedSourceIndex >= 0, 'changing cabinet width must change at least one supported source primitive');
const changedSourceKey = oldCabinetKeys[changedSourceIndex]!;
const changedSourceOverride = sourceOverride(changedSourceKey, oldCabinetPlan[changedSourceIndex]!, 'plan', 'qa-stale-source', { roomId: cab.roomId, cabinetId: cab.id });
assert.ok(changedSourceOverride);
geometryChangedProject.drawingEdits = [...(project.drawingEdits ?? []), changedSourceOverride];
const staleOverlayProject: Project = geometryChangedProject;
const staleBus = new CommandBus(staleOverlayProject, rules);
const staleIssue = staleBus.issues().find(issue => issue.code === 'DRAWING-SOURCE-STALE' && issue.target === 'qa-stale-source');
ok(staleIssue?.severity === 'ERROR', 'regenerating changed cabinet geometry makes its former source override explicitly stale');
ok(staleBus.hasBlockingErrors(), 'a source override stale after geometry recomputation blocks production export until reviewed');
const generatedForAmbiguity = generateProject(project, rules);
const uniquePlanIndex = generatedForAmbiguity.planSourceKeys.findIndex((key, index, keys) => generatedForAmbiguity.plan[index]?.k === 'poly' && keys.filter(candidate => candidate === key).length === 1);
assert.ok(uniquePlanIndex >= 0);
const uniquePlanKey = generatedForAmbiguity.planSourceKeys[uniquePlanIndex]!;
const ambiguousEdits = [
  { ...targetOverlay, id: 'qa-ambiguous-source-a', replacesSource: uniquePlanKey },
  { ...targetOverlay, id: 'qa-ambiguous-source-b', replacesSource: uniquePlanKey },
];
const ambiguousProject: Project = { ...project, drawingEdits: [...(project.drawingEdits ?? []), ...ambiguousEdits] };
const ambiguousCanvas = drawingPrims(ambiguousProject, 'plan', generatedForAmbiguity.plan, generatedForAmbiguity.planSourceKeys);
ok(ambiguousCanvas.slice(0, generatedForAmbiguity.plan.length).every((prim, index) => JSON.stringify(prim) === JSON.stringify(generatedForAmbiguity.plan[index])), 'two overlays referencing one source preserve every generated candidate without suppression');
const ambiguousBus = new CommandBus(ambiguousProject, rules);
ok(ambiguousBus.issues().filter(issue => issue.code === 'DRAWING-SOURCE-AMBIGUOUS').length === 2, 'duplicate references produce explicit ambiguous ERROR issues');
ok(ambiguousBus.hasBlockingErrors(), 'ambiguous source references block production export until cleaned');
const exportModule = await import(new URL('../server/exportCore.mjs', import.meta.url).href) as {
  exportDxf: (candidate: Project, options: { which: Array<'plan' | 'sheet'> }) => Promise<unknown>;
};
const officialExportBlocks = async (candidate: Project, expectedCode: string): Promise<boolean> => {
  try {
    await exportModule.exportDxf(candidate, { which: ['plan'] });
    return false;
  } catch (error) {
    const blocked = error as { code?: string; statusCode?: number; issues?: Array<{ code?: string }> };
    return blocked.code === 'EXPORT_BLOCKED' && blocked.statusCode === 422 && (blocked.issues ?? []).some(issue => issue.code === expectedCode);
  }
};
ok(await officialExportBlocks(geometryChangedProject, 'DRAWING-SOURCE-STALE'), 'official DXF export returns 422 for an override stale after rule-driven geometry recomputation');
ok(await officialExportBlocks(ambiguousProject, 'DRAWING-SOURCE-AMBIGUOUS'), 'official DXF export returns 422 for multiple overlays claiming one source');
const deletedCabinetProject: Project = {
  ...project,
  cabinets: project.cabinets.filter(candidate => candidate.id !== cab.id),
  drawingEdits: [{ ...changedSourceOverride, cabinetId: undefined }],
};
const afterDeleteGeometry = generateProject(deletedCabinetProject, rules);
ok(!afterDeleteGeometry.planSourceKeys.includes(changedSourceKey), 'deleting the source cabinet removes the formerly covered source identity key');
const afterDeleteCanvas = drawingPrims(deletedCabinetProject, 'plan', afterDeleteGeometry.plan, afterDeleteGeometry.planSourceKeys);
ok(afterDeleteCanvas.slice(0, afterDeleteGeometry.plan.length).every((prim, index) => JSON.stringify(prim) === JSON.stringify(afterDeleteGeometry.plan[index])), 'a stale overlay after source deletion suppresses no remaining generated geometry');
const afterDeleteBus = new CommandBus(deletedCabinetProject, rules);
ok(afterDeleteBus.issues().some(issue => issue.code === 'DRAWING-SOURCE-STALE' && issue.target === changedSourceOverride.id && issue.severity === 'ERROR'), 'deleting the source cabinet produces a stale ERROR requiring rebind or cleanup');
ok(await officialExportBlocks(deletedCabinetProject, 'DRAWING-SOURCE-STALE'), 'official DXF export returns 422 after the covered source entity is deleted');
const restoredTop = project.drawingEdits?.find(e => e.id === movedTop.id);
ok(Boolean(restoredTop && restoredTop.points[0]?.x === movedTop.points[0]?.x && restoredTop.points[0]?.y === movedTop.points[0]?.y && restoredTop.closed && restoredTop.dash?.[0] === 8), 'moved top-view coordinates and style survive save/reload');
const unsupportedSheetEdit = { ...frontEdit, id: 'qa-unsupported-side', view: 'side' as const };
const unsupportedBus = new CommandBus(project, rules);
const rejectedWrite = unsupportedBus.execute(replaceDrawingEdits(project, [...(project.drawingEdits ?? []), unsupportedSheetEdit], 'reject unsupported view'));
ok(!rejectedWrite.ok, 'command bus rejects sheet side edits not present in the shared screen/PDF/DXF view set');
const invalidEnvelope = JSON.parse(serializeProjectFile(project, '2026-10-09T00:00:00.000Z'));
invalidEnvelope.project.drawingEdits[0].view = 'side';
const rejectedLoad = parseProjectFile(JSON.stringify(invalidEnvelope));
ok(!rejectedLoad.ok && rejectedLoad.error.includes('未支持的 sheet 视图') && rejectedLoad.error.includes('避免静默丢图'), 'project loader refuses unsupported sheet view instead of silently dropping it');

// Screen-derived geometry and room PLAN export consume the same reloaded drawingEdits.
const geom = generateProject(project, rules);
const sheetCanvas = drawingPrims(project, 'sheet', geom.views.prims, geom.views.sourceKeys);
const planCanvas = drawingPrims(project, 'plan', geom.plan, geom.planSourceKeys);
const screenTop = sheetCanvas.find(p => p.k === 'poly' && p.layer === 'QA-EDIT-TOP');
ok(screenTop?.k === 'poly' && screenTop.closed && JSON.stringify(screenTop.dash) === '[8,4]' && screenTop.pts[0]?.x === movedTop.points[0]?.x && screenTop.pts[0]?.y === movedTop.points[0]?.y, 'top overlay is visible on the advanced CAD sheet at the saved canvas coordinates');
ok(planCanvas.some(p => p.k === 'poly' && p.layer === 'QA-EDIT-ROOM-PLAN'), 'room PLAN overlay is visible on the canvas');
ok(geom.views.sourceKeys.some(key => key.startsWith(`sheet:${cab.id}:top:`)), 'advanced CAD registers stable cabinet-top source keys');

const furniture = buildFurnitureSheet(room, [cab], project, rules, { furnitureName: cab.name });
const sheetTop = furniture.prims.find(p => p.k === 'poly' && p.layer === 'QA-EDIT-TOP');
const sheetFrontText = furniture.prims.find(p => p.k === 'text' && p.text === 'QA-FRONT-ROT-90');
ok(sheetTop?.k === 'poly' && sheetTop.closed && JSON.stringify(sheetTop.dash) === '[8,4]', 'cabinet top manual geometry enters the furniture-sheet/PDF source with closed+dash intact');
ok(sheetFrontText?.k === 'text' && sheetFrontText.rot === 90, 'front text rotation enters the furniture-sheet/PDF source');
ok(furniture.prims.some(p => p.k === 'poly' && p.layer === 'QA-EDIT-INTERNAL'), 'internal view manual line enters the furniture-sheet/PDF source');

const neutral = toNeutralExport(project, rules, ['plan', 'sheet'], 'drawing-edits-acceptance');
const neutralCabinet = neutral.sheets.find(s => s.kind === 'cabinet' && s.cabinetId === cab.id);
const neutralPlan = neutral.sheets.find(s => s.kind === 'room-plan' && s.roomId === room.id);
const neutralTop = neutralCabinet?.prims.find(p => p.k === 'poly' && p.layer === 'QA-EDIT-TOP');
const neutralFront = neutralCabinet?.prims.find(p => p.k === 'text' && p.k === 'text' && p.text === 'QA-FRONT-ROT-90');
ok(Boolean(neutralPlan?.prims.some(p => p.k === 'poly' && p.layer === 'QA-EDIT-ROOM-PLAN')), 'room PLAN edit reaches neutral DXF sheet');
ok(neutralTop?.k === 'poly' && sheetTop?.k === 'poly' && JSON.stringify(neutralTop.pts) === JSON.stringify(sheetTop.pts) && neutralTop.closed === sheetTop.closed && JSON.stringify(neutralTop.dash) === JSON.stringify(sheetTop.dash), 'neutral DXF coordinates match the shared furniture-sheet geometry exactly');
ok(neutralFront?.k === 'text' && neutralFront.rot === 90 && sheetFrontText?.k === 'text' && neutralFront.p.x === sheetFrontText.p.x && neutralFront.p.y === sheetFrontText.p.y, 'neutral DXF rotation and insertion coordinate match the PDF sheet geometry');

const book = buildRoomBook(project, rules, 'drawing-edits-acceptance');
const bookSheet = book.sections.flatMap(s => s.cabinets).find(c => c.id === cab.id)?.sheetSvg;
const pointsAttribute = sheetTop?.k === 'poly' ? `points="${sheetTop.pts.map(p => `${p.x},${p.y}`).join(' ')}"` : '';
ok(Boolean(bookSheet && bookSheet.includes(pointsAttribute) && bookSheet.includes('stroke-dasharray="8 4"')), 'PDF room-book SVG contains the exact top polyline coordinates and dashed style');
ok(Boolean(bookSheet?.includes('QA-FRONT-ROT-90') && bookSheet.includes('rotate(-90)')), 'PDF room-book SVG keeps the rotated front annotation');

// DXF serialization and read-back: verifier compares all coordinates under one page transform,
// and checks closed state, text rotation, and dash style.
const temp = mkdtempSync(join(tmpdir(), 'furniture-drawing-edits-'));
try {
  const neutralPath = join(temp, 'neutral.json');
  const dxfPath = join(temp, 'drawing-edits.dxf');
  writeFileSync(neutralPath, JSON.stringify(neutral), 'utf8');
  const exported = spawnSync('python3', ['py/export_dxf.py', neutralPath, dxfPath, 'R2007'], { encoding: 'utf8' });
  ok(exported.status === 0, `DXF export succeeds: ${(exported.stderr || exported.stdout).slice(0, 400)}`);
  const verified = spawnSync('python3', ['py/verify_dxf.py', dxfPath, neutralPath], { encoding: 'utf8' });
  ok(verified.status === 0, `DXF read-back verifier runs: ${(verified.stderr || verified.stdout).slice(0, 400)}`);
  const report = JSON.parse(verified.stdout);
  ok(report.neutralSemantics?.ok === true, `DXF read-back preserves all page coordinates, closure and rotation: ${JSON.stringify(report.neutralSemantics?.errors ?? [])}`);
  const sheetLayouts = report.paperLayouts.filter((layout: { entityCount: number }) => layout.entityCount > 0);
  ok(sheetLayouts.every((layout: { fitsPrintableArea: boolean }) => layout.fitsPrintableArea), 'DXF pages with drawing overrides fit printable bounds');
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`二维绘图编辑验收通过：${checks} 项。`);
