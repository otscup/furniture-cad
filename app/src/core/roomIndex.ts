import type { Cabinet, FurnitureAssembly, Project, Room } from './types.ts';
import { isAssemblyConfirmed } from './assemblyConfirmation.ts';

export interface RoomCabinetGroup {
  room: Room;
  cabinets: Cabinet[];
  unassigned: boolean;
}

export interface CabinetDisplayGroup {
  id: string;
  name: string;
  cabinets: Cabinet[];
  assemblyNames: string[];
  confirmedAssemblies: FurnitureAssembly[];
}

const CABINET_DISPLAY_TYPES = [
  { id: 'base', label: '地柜' },
  { id: 'wall', label: '吊柜' },
  { id: 'tall', label: '高柜' },
  { id: 'island', label: '岛台' },
] as const;

function cabinetDisplayType(cabinet: Cabinet): (typeof CABINET_DISPLAY_TYPES)[number]['id'] {
  const type = cabinet.params.cabinetType ?? ((cabinet.params.mountHeight ?? 0) > 0 ? 'wall' : 'base');
  return type === 'base' || type === 'wall' || type === 'tall' || type === 'island' ? type : 'base';
}

/** 外层视图只按柜型合组；装配语义作为组内说明，不把同类柜拆成多张卡片。 */
export function displayGroupsForRoom(project: Project, roomId: string, roomCabinets: Cabinet[]): CabinetDisplayGroup[] {
  const cabinetIds = new Set(roomCabinets.map((cabinet) => cabinet.id));
  const confirmedAssemblies = (project.assemblies ?? []).filter((assembly) =>
    assembly.roomId === roomId &&
    isAssemblyConfirmed(assembly) &&
    assembly.memberIds.every((id) => cabinetIds.has(id)),
  );
  const groups: CabinetDisplayGroup[] = [];
  for (const category of CABINET_DISPLAY_TYPES) {
    const cabinets = roomCabinets.filter((cabinet) => cabinetDisplayType(cabinet) === category.id);
    if (!cabinets.length) continue;
    const categoryIds = new Set(cabinets.map((cabinet) => cabinet.id));
    const categoryAssemblies = confirmedAssemblies
      .filter((assembly) => assembly.memberIds.some((id) => categoryIds.has(id)));
    const assemblyNames = categoryAssemblies
      .map((assembly) => assembly.name);
    groups.push({
      id: `display-${roomId}-${category.id}`,
      name: category.label,
      cabinets,
      assemblyNames,
      // 跨柜型 assembly 只在其首个成员所属的类别中呈现一次连续组预览。
      confirmedAssemblies: categoryAssemblies.filter((assembly) => categoryIds.has(assembly.memberIds[0] ?? '')),
    });
  }
  return groups;
}

/**
 * 从唯一语义模型派生稳定的房间 → 柜体索引。
 * 已知房间始终按 rooms[] 顺序返回（包括空房间）；房内柜体按世界位置 y、x 排序，
 * 原数组顺序作为平局裁决。悬空 roomId 的柜体统一放到最后的“未分配房间”，绝不
 * 默默塞进第一个房间或丢弃。
 */
export function indexProjectRooms(project: Project): RoomCabinetGroup[] {
  const buckets = new Map<string, Array<{ cabinet: Cabinet; index: number }>>();
  for (const room of project.rooms) buckets.set(room.id, []);

  const unassigned: Array<{ cabinet: Cabinet; index: number }> = [];
  project.cabinets.forEach((cabinet, index) => {
    const bucket = buckets.get(cabinet.roomId);
    if (bucket) bucket.push({ cabinet, index });
    else unassigned.push({ cabinet, index });
  });

  const ordered = (items: Array<{ cabinet: Cabinet; index: number }>): Cabinet[] =>
    items
      .sort((a, b) => a.cabinet.placement.y - b.cabinet.placement.y || a.cabinet.placement.x - b.cabinet.placement.x || a.index - b.index)
      .map(({ cabinet }) => cabinet);

  const groups: RoomCabinetGroup[] = project.rooms.map((room) => ({
    room,
    cabinets: ordered(buckets.get(room.id) ?? []),
    unassigned: false,
  }));

  if (unassigned.length > 0) {
    let id = '__unassigned__';
    while (buckets.has(id)) id = `_${id}`;
    groups.push({
      room: { id, name: '未分配房间', walls: [] },
      cabinets: ordered(unassigned),
      unassigned: true,
    });
  }
  return groups;
}
