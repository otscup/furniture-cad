import { emptyProject, createCabinet, rectRoom } from '../src/core/docFactory.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { addAssemblyMember, confirmAssembly, connectInAssembly, createAssembly, disconnectInAssembly, removeAssemblyMember, renameAssembly } from '../src/core/commands.ts';
import { assemblyConfirmationStatus, confirmedAssemblySnapshot, isAssemblyConfirmed } from '../src/core/assemblyConfirmation.ts';
import { displayGroupsForRoom } from '../src/core/roomIndex.ts';
import { allUnits } from '../src/core/layoutModel.ts';
import { buildFurnitureSheet } from '../src/export/furnitureSheet.ts';
import { parseProjectFile, serializeProjectFile } from '../src/core/projectFile.ts';
import type { Cabinet, FurnitureAssembly } from '../src/core/types.ts';

const rules = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../src/core/ruleset/factory-default.json', import.meta.url), 'utf8'));
const room = rectRoom({ id: 'room_assembly_confirm', name: '确认测试厨房', x: 0, y: 0, w: 5000, h: 3500, thickness: 120, height: 2700 });
const project = emptyProject({ id: 'project_assembly_confirm', name: '装配确认测试', ruleSetId: rules.id });
project.rooms = [room];
const cabinets: Cabinet[] = [
  createCabinet({ id: 'cab_confirm_a', name: '相邻柜 A', roomId: room.id, x: 300, y: 100, rules, params: { width: 900, height: 850, depth: 600 } }),
  createCabinet({ id: 'cab_confirm_b', name: '相邻柜 B', roomId: room.id, x: 1200, y: 100, rules, params: { width: 900, height: 850, depth: 600 } }),
  createCabinet({ id: 'cab_confirm_c', name: '相邻柜 C', roomId: room.id, x: 2100, y: 100, rules, params: { width: 900, height: 850, depth: 600 } }),
];
for (const cabinet of cabinets) {
  cabinet.params.cabinetType = 'base';
  allUnits(cabinet.layout).forEach((unit, index) => { unit.id = `unit_${cabinet.id}_${index + 1}`; });
  cabinet.layout.backUnits?.forEach((unit, index) => { unit.id = `back_${cabinet.id}_${index + 1}`; });
}
project.cabinets = cabinets;
const assembly: FurnitureAssembly = {
  id: 'asm_confirm_row', name: '有名字但未确认的相邻柜组', roomId: room.id,
  memberIds: [cabinets[0]!.id, cabinets[1]!.id], connections: [],
};
project.assemblies = [assembly];
let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const groupsBefore = displayGroupsForRoom(project, room.id, cabinets);
const baseGroupBefore = groupsBefore.find((group) => group.name === '地柜');
check('相邻且有装配名称的缺省旧数据仍未确认', assemblyConfirmationStatus(assembly) === 'unconfirmed');
check('未确认装配名不进入 room grouping 连续组，柜型仍自动按地柜分类', baseGroupBefore?.assemblyNames.length === 0 && baseGroupBefore?.cabinets.length === 3);
check('未确认的每台柜仍单独保留在分类成员集合中', baseGroupBefore?.cabinets.map((cabinet) => cabinet.id).sort().join(',') === cabinets.map((cabinet) => cabinet.id).sort().join(','));

const legacyRoundTrip = parseProjectFile(serializeProjectFile(project, '2026-10-09T00:00:00.000Z'));
check('旧格式 assembly 缺省 confirmed 经保存/重载仍保持未确认', legacyRoundTrip.ok && legacyRoundTrip.project.assemblies?.[0]?.confirmed === undefined && !isAssemblyConfirmed(legacyRoundTrip.project.assemblies![0]!), legacyRoundTrip.ok ? '' : legacyRoundTrip.error);
const legacyConfirmedWithoutGeneration: FurnitureAssembly = { ...structuredClone(assembly), confirmed: true, confirmedMemberIds: [...assembly.memberIds], confirmedConnections: [], relationGeneration: undefined, confirmedRelationGeneration: undefined };
check('旧 confirmed=true 即使带快照但缺少代次仍按未确认处理', assemblyConfirmationStatus(legacyConfirmedWithoutGeneration) === 'unconfirmed');

const bus = new CommandBus(project, rules);
const mcpConfirmation = bus.execute(confirmAssembly(assembly.id, assembly.name, 'mcp'));
check('MCP 来源不能调用显式用户确认命令', !mcpConfirmation.ok && bus.getState().assemblies?.[0]?.confirmed !== true);
const beforeCabinetIds = bus.getState().cabinets.map((cabinet) => cabinet.id).join(',');
const singleSheetBefore = JSON.stringify(buildFurnitureSheet(room, [cabinets[0]!], project, rules));
const userConfirmation = bus.execute(confirmAssembly(assembly.id, assembly.name, 'ui'));
const confirmed = bus.getState().assemblies?.[0]!;
check('健康项目用户通过 UI 来源确认一次后写入 confirmed=true 和当前成员/连接快照', userConfirmation.ok && confirmed.confirmed === true && isAssemblyConfirmed(confirmed), userConfirmation.ok ? '' : userConfirmation.error);
check('确认后柜型分组才展示装配名称并生成已确认连续组', (() => {
  const group = displayGroupsForRoom(bus.getState(), room.id, bus.getState().cabinets).find((item) => item.name === '地柜');
  return group?.assemblyNames.includes(assembly.name) === true && group.confirmedAssemblies.some((item) => item.id === assembly.id);
})());
const serializedConfirmed = parseProjectFile(serializeProjectFile(bus.getState(), '2026-10-09T00:00:01.000Z'));
check('保存/重载后 confirmed 与成员/连接快照完整保留', serializedConfirmed.ok && isAssemblyConfirmed(serializedConfirmed.project.assemblies![0]!));
const singleSheetAfter = JSON.stringify(buildFurnitureSheet(room, [bus.getState().cabinets[0]!], bus.getState(), rules));
check('确认不改变单柜生产页图元、单柜柜体 ID 与柜体参数', singleSheetBefore === singleSheetAfter && beforeCabinetIds === bus.getState().cabinets.map((cabinet) => cabinet.id).join(',') && JSON.stringify(cabinets[0]!.params) === JSON.stringify(bus.getState().cabinets[0]!.params));

const addMember = bus.execute(addAssemblyMember(assembly.id, assembly.name, cabinets[2]!.id, cabinets[2]!.name));
const afterMemberChange = bus.getState().assemblies?.[0]!;
check('增加成员会使此前确认快照过期，连续组名称立即隐藏', addMember.ok && assemblyConfirmationStatus(afterMemberChange) === 'stale' && !displayGroupsForRoom(bus.getState(), room.id, bus.getState().cabinets).find((group) => group.name === '地柜')?.assemblyNames.includes(assembly.name), addMember.ok ? '' : addMember.error);
const reConfirmAfterMembers = bus.execute(confirmAssembly(assembly.id, assembly.name, 'ui'));
check('成员变化后通过 UI 再确认可恢复有效连续组', reConfirmAfterMembers.ok && isAssemblyConfirmed(bus.getState().assemblies![0]!));
const newConnection = { id: 'conn_confirm_bc', kind: 'butt' as const, a: { cabinetId: cabinets[1]!.id }, b: { cabinetId: cabinets[2]!.id }, origin: 'authored' as const };
const connectResult = bus.execute(connectInAssembly(assembly.id, assembly.name, newConnection));
check('新增或调整 connection 会使先前确认失效', connectResult.ok && assemblyConfirmationStatus(bus.getState().assemblies![0]!) === 'stale', connectResult.ok ? '' : connectResult.error);
const finalConfirmation = bus.execute(confirmAssembly(assembly.id, assembly.name, 'ui'));
check('连接变化后必须再次由 UI 显式确认才能恢复连续组', finalConfirmation.ok && isAssemblyConfirmed(bus.getState().assemblies![0]!));

const roundTripBus = new CommandBus(structuredClone(project), rules);
const roundTripAssembly = roundTripBus.getState().assemblies![0]!;
const roundTripConfirmed = roundTripBus.execute(confirmAssembly(roundTripAssembly.id, roundTripAssembly.name, 'ui'));
const originalMemberIds = [...roundTripAssembly.memberIds];
const roundTripAdd = roundTripBus.execute(addAssemblyMember(roundTripAssembly.id, roundTripAssembly.name, cabinets[2]!.id, cabinets[2]!.name));
const generationAfterAdd = roundTripBus.getState().assemblies![0]!.relationGeneration;
const roundTripRemove = roundTripBus.execute(removeAssemblyMember(roundTripAssembly.id, roundTripAssembly.name, cabinets[2]!.id, cabinets[2]!.name));
const memberRoundTrip = roundTripBus.getState().assemblies![0]!;
check('确认后 add→remove 回到原 memberIds 仍因单调代次保持 stale', roundTripConfirmed.ok && roundTripAdd.ok && roundTripRemove.ok && memberRoundTrip.memberIds.join(',') === originalMemberIds.join(',') && memberRoundTrip.confirmed === false && assemblyConfirmationStatus(memberRoundTrip) === 'stale' && memberRoundTrip.relationGeneration! > generationAfterAdd!);
const memberStaleReload = parseProjectFile(serializeProjectFile(roundTripBus.getState(), '2026-10-09T00:00:02.000Z'));
check('成员往返 stale 的确认失效代次保存/重载后仍 stale', memberStaleReload.ok && assemblyConfirmationStatus(memberStaleReload.project.assemblies![0]!) === 'stale' && memberStaleReload.project.assemblies![0]!.relationGeneration === memberRoundTrip.relationGeneration);
const memberExplicitReconfirm = roundTripBus.execute(confirmAssembly(roundTripAssembly.id, roundTripAssembly.name, 'ui'));
check('成员往返后只有再次显式确认才恢复连续组', memberExplicitReconfirm.ok && isAssemblyConfirmed(roundTripBus.getState().assemblies![0]!));
const generationBeforeRename = roundTripBus.getState().assemblies![0]!.relationGeneration;
const renameWithoutRelationChange = roundTripBus.execute(renameAssembly(roundTripAssembly.id, '重命名但关系不变'));
check('仅改装配名称不会误失效或递增关系代次', renameWithoutRelationChange.ok && isAssemblyConfirmed(roundTripBus.getState().assemblies![0]!) && roundTripBus.getState().assemblies![0]!.relationGeneration === generationBeforeRename);

const roundTripConnection = { id: 'conn_confirm_roundtrip', kind: 'butt' as const, a: { cabinetId: cabinets[0]!.id }, b: { cabinetId: cabinets[1]!.id }, origin: 'authored' as const };
const roundTripConnect = roundTripBus.execute(connectInAssembly(roundTripAssembly.id, roundTripAssembly.name, roundTripConnection));
const generationAfterConnect = roundTripBus.getState().assemblies![0]!.relationGeneration;
const roundTripDisconnect = roundTripBus.execute(disconnectInAssembly(roundTripAssembly.id, roundTripAssembly.name, roundTripConnection.id));
const connectionRoundTrip = roundTripBus.getState().assemblies![0]!;
check('确认后 connect→disconnect 回到原 connections 仍因单调代次保持 stale', roundTripConnect.ok && roundTripDisconnect.ok && connectionRoundTrip.connections.length === 0 && connectionRoundTrip.confirmed === false && assemblyConfirmationStatus(connectionRoundTrip) === 'stale' && connectionRoundTrip.relationGeneration! > generationAfterConnect!);
const connectionStaleReload = parseProjectFile(serializeProjectFile(roundTripBus.getState(), '2026-10-09T00:00:03.000Z'));
check('连接往返 stale 的确认失效代次保存/重载后仍 stale', connectionStaleReload.ok && assemblyConfirmationStatus(connectionStaleReload.project.assemblies![0]!) === 'stale' && connectionStaleReload.project.assemblies![0]!.relationGeneration === connectionRoundTrip.relationGeneration);
const connectionExplicitReconfirm = roundTripBus.execute(confirmAssembly(roundTripAssembly.id, roundTripAssembly.name, 'ui'));
check('连接往返后只有再次显式确认才恢复连续组', connectionExplicitReconfirm.ok && isAssemblyConfirmed(roundTripBus.getState().assemblies![0]!));

const undoBus = new CommandBus(structuredClone(project), rules);
const undoAssembly = undoBus.getState().assemblies![0]!;
undoBus.execute(confirmAssembly(undoAssembly.id, undoAssembly.name, 'ui'));
const undoAdd = undoBus.execute(addAssemblyMember(undoAssembly.id, undoAssembly.name, cabinets[2]!.id, cabinets[2]!.name));
const generationBeforeUndo = undoBus.getState().assemblies![0]!.relationGeneration!;
const undoRelation = undoBus.undo();
const afterUndoRelation = undoBus.getState().assemblies![0]!;
const undoKeepsStale = undoRelation && afterUndoRelation.memberIds.join(',') === originalMemberIds.join(',') && assemblyConfirmationStatus(afterUndoRelation) === 'stale' && afterUndoRelation.relationGeneration! > generationBeforeUndo;
const generationBeforeRedo = afterUndoRelation.relationGeneration!;
const redoRelation = undoBus.redo();
const afterRedoRelation = undoBus.getState().assemblies![0]!;
check('undo/redo 关系变更只推进代次且绝不恢复旧 confirmed', undoAdd.ok && undoKeepsStale && redoRelation && afterRedoRelation.memberIds.length === originalMemberIds.length + 1 && assemblyConfirmationStatus(afterRedoRelation) === 'stale' && afterRedoRelation.relationGeneration! > generationBeforeRedo && afterRedoRelation.confirmed === false);
const undoRedoReload = parseProjectFile(serializeProjectFile(undoBus.getState(), '2026-10-09T00:00:04.000Z'));
check('undo/redo 后 stale 状态经项目序列化/重载保留', undoRedoReload.ok && assemblyConfirmationStatus(undoRedoReload.project.assemblies![0]!) === 'stale');
const afterUndoRedoReconfirm = undoBus.execute(confirmAssembly(undoAssembly.id, undoAssembly.name, 'ui'));
check('undo/redo 后重新显式确认可恢复已确认状态', afterUndoRedoReconfirm.ok && isAssemblyConfirmed(undoBus.getState().assemblies![0]!));

const replaceBus = new CommandBus(structuredClone(project), rules);
const replaceAssembly = replaceBus.getState().assemblies![0]!;
replaceBus.execute(confirmAssembly(replaceAssembly.id, replaceAssembly.name, 'ui'));
const replacement = structuredClone(replaceBus.getState());
replacement.assemblies![0]!.memberIds.push(cabinets[2]!.id);
replaceBus.replaceProject(replacement, '测试替换 Project 改变成员关系');
const afterReplace = replaceBus.getState().assemblies![0]!;
check('replaceProject 成员关系变化走统一失效边界', assemblyConfirmationStatus(afterReplace) === 'stale' && afterReplace.confirmed === false && afterReplace.relationGeneration! > 0);
const replacedUndo = replaceBus.undo();
const afterReplaceUndo = replaceBus.getState().assemblies![0]!;
check('替换 Project 的 undo 回到原 memberIds 仍 stale', replacedUndo && afterReplaceUndo.memberIds.join(',') === originalMemberIds.join(',') && assemblyConfirmationStatus(afterReplaceUndo) === 'stale');
const replacedRedo = replaceBus.redo();
const afterReplaceRedo = replaceBus.getState().assemblies![0]!;
check('替换 Project 的 redo 关系继续变化仍 stale', replacedRedo && afterReplaceRedo.memberIds.length === originalMemberIds.length + 1 && assemblyConfirmationStatus(afterReplaceRedo) === 'stale');

const nonRelationReplaceBus = new CommandBus(structuredClone(project), rules);
const nonRelationAssembly = nonRelationReplaceBus.getState().assemblies![0]!;
nonRelationReplaceBus.execute(confirmAssembly(nonRelationAssembly.id, nonRelationAssembly.name, 'ui'));
const nonRelationReplacement = structuredClone(nonRelationReplaceBus.getState());
nonRelationReplacement.cabinets[0]!.params.height += 10;
nonRelationReplaceBus.replaceProject(nonRelationReplacement, '测试替换 Project 仅修改柜体属性');
check('replaceProject 只改柜体非关系字段不误失效确认', isAssemblyConfirmed(nonRelationReplaceBus.getState().assemblies![0]!));

const hydrateBus = new CommandBus(structuredClone(project), rules);
const hydrateAssembly = hydrateBus.getState().assemblies![0]!;
hydrateBus.execute(confirmAssembly(hydrateAssembly.id, hydrateAssembly.name, 'ui'));
const hydratedProject = structuredClone(hydrateBus.getState());
hydratedProject.assemblies![0]!.connections.push(roundTripConnection);
hydrateBus.loadProjectReadOnly(hydratedProject);
check('只读载入/hydrate 的 connection 变化也由统一边界 stale', assemblyConfirmationStatus(hydrateBus.getState().assemblies![0]!) === 'stale' && hydrateBus.getState().assemblies![0]!.confirmed === false);

const createBus = new CommandBus({ ...project, assemblies: [] }, rules);
const forgedAssembly: FurnitureAssembly = {
  ...structuredClone(assembly),
  ...confirmedAssemblySnapshot(assembly),
};
const mcpCreate = createBus.execute(createAssembly(forgedAssembly, 'mcp'));
check('MCP 创建 assembly 即使携带 confirmed=true 与快照也会被剥离，不自动推断确认', mcpCreate.ok && createBus.getState().assemblies?.[0]?.confirmed !== true && !isAssemblyConfirmed(createBus.getState().assemblies![0]!), mcpCreate.ok ? '' : mcpCreate.error);

const badProject = structuredClone(project);
const firstUnit = badProject.cabinets[0]!.layout.rows?.[0]?.units?.[0] ?? badProject.cabinets[0]!.layout.units?.[0];
const duplicateUnit = badProject.cabinets[1]!.layout.rows?.[0]?.units?.[0] ?? badProject.cabinets[1]!.layout.units?.[0];
if (firstUnit && duplicateUnit) duplicateUnit.id = firstUnit.id;
const badBus = new CommandBus(badProject, rules);
const badConfirmation = badBus.execute(confirmAssembly(assembly.id, assembly.name, 'ui'));
check('重复 Unit ID 坏项目的统一只读锁阻断 UI 确认写入', !badConfirmation.ok && badBus.getState().assemblies?.[0]?.confirmed !== true && Boolean(badBus.getUnitIdentityConflict()));

console.log(`\n装配确认纯逻辑验收：${passed} 通过，${failed} 失败。`);
if (failed > 0) process.exitCode = 1;
