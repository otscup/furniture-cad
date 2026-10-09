import { displayGroupsForRoom } from '../src/core/roomIndex.ts';
import { confirmedAssemblySnapshot } from '../src/core/assemblyConfirmation.ts';
import type { Cabinet, Project } from '../src/core/types.ts';

const roomId = 'room-kitchen';
const cabinet = (id: string, cabinetType: 'base' | 'wall' | 'tall'): Cabinet => ({
  id,
  name: id,
  roomId,
  placement: { x: 0, y: 0, rotation: 0 },
  params: { cabinetType, width: 600, height: cabinetType === 'wall' ? 700 : 850, depth: 350 } as Cabinet['params'],
  layout: {} as Cabinet['layout'],
});

const cabinets = [
  cabinet('base-1', 'base'),
  cabinet('wall-left', 'wall'),
  cabinet('wall-center', 'wall'),
  cabinet('wall-right', 'wall'),
  cabinet('tall-1', 'tall'),
];
const project = {
  rooms: [{ id: roomId, name: '厨房', walls: [] }],
  cabinets,
  assemblies: [
    { id: 'asm-left', name: '左吊柜组', roomId, memberIds: ['wall-left'], connections: [] },
    { id: 'asm-center', name: '中吊柜组', roomId, memberIds: ['wall-center'], connections: [] },
    { id: 'asm-right', name: '右吊柜组', roomId, memberIds: ['wall-right'], connections: [] },
  ],
} as unknown as Project;

const groups = displayGroupsForRoom(project, roomId, cabinets);
const wallGroups = groups.filter((group) => group.name === '吊柜');
const shownIds = groups.flatMap((group) => group.cabinets.map((item) => item.id));
const inputIds = cabinets.map((item) => item.id);
const shownCounts = new Map<string, number>();
for (const id of shownIds) shownCounts.set(id, (shownCounts.get(id) ?? 0) + 1);
const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
};

assert(groups.map((group) => group.name).join(',') === '地柜,吊柜,高柜', '外层展示固定按地柜/吊柜/高柜分类');
assert(wallGroups.length === 1 && wallGroups[0]!.cabinets.length === 3, '三个分别建组的左/中/右吊柜仍聚合为一个吊柜展示组');
assert(new Set(inputIds).size === inputIds.length, 'room input cabinetId 本身无重复');
assert(inputIds.length === shownIds.length && [...inputIds].sort().join('\0') === [...shownIds].sort().join('\0'), 'UI 分组输出 cabinetId 多重集合与 room input 完全相同（无漏项、无替换、无额外项）', `input=${inputIds.join(',')}; shown=${shownIds.join(',')}`);
assert(inputIds.every((id) => shownCounts.get(id) === 1) && shownCounts.size === inputIds.length, '每个输入 cabinetId 在所有展示组中恰好出现一次', [...shownCounts].map(([id, count]) => `${id}×${count}`).join(', '));
assert(wallGroups[0]!.assemblyNames.length === 0, '仅有名称和相邻柜体的旧装配默认未确认，不显示装配名称/连续组');
const confirmedProject = structuredClone(project);
Object.assign(confirmedProject.assemblies![0]!, confirmedAssemblySnapshot(confirmedProject.assemblies![0]!));
const confirmedWallGroup = displayGroupsForRoom(confirmedProject, roomId, cabinets).find((group) => group.name === '吊柜');
assert(confirmedWallGroup?.assemblyNames.join(',') === '左吊柜组', '成员/连接快照显式确认后，才显示对应装配名称');

console.log('\n房间柜型分组验收通过。');
