import type { FurnitureAssembly } from './types.ts';

export type AssemblyConfirmationStatus = 'unconfirmed' | 'confirmed' | 'stale';

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

export function isAssemblyRelationGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 比较关系事实，不把名称或其它非关系字段纳入确认失效条件。 */
export function assemblyRelationsEqual(a: FurnitureAssembly, b: FurnitureAssembly): boolean {
  return stableValue(a.memberIds) === stableValue(b.memberIds) &&
    stableValue(a.connections) === stableValue(b.connections);
}

/**
 * 只有同一关系代次上的显式确认有效。旧项目缺少任一代次时 fail-closed 为未确认；
 * 关系代次推进后，即使成员/连接集合恢复原状也保持 stale，直至再次显式确认。
 */
export function assemblyConfirmationStatus(assembly: FurnitureAssembly): AssemblyConfirmationStatus {
  if (!isAssemblyRelationGeneration(assembly.relationGeneration) ||
      !isAssemblyRelationGeneration(assembly.confirmedRelationGeneration)) {
    return 'unconfirmed';
  }
  if (assembly.confirmedRelationGeneration !== assembly.relationGeneration || assembly.confirmed !== true) {
    return 'stale';
  }
  if (!Array.isArray(assembly.confirmedMemberIds) || !Array.isArray(assembly.confirmedConnections) || assembly.memberIds.length === 0) {
    return 'unconfirmed';
  }
  const membersMatch = stableValue(assembly.memberIds) === stableValue(assembly.confirmedMemberIds);
  const connectionsMatch = stableValue(assembly.connections) === stableValue(assembly.confirmedConnections);
  return membersMatch && connectionsMatch ? 'confirmed' : 'stale';
}

export function isAssemblyConfirmed(assembly: FurnitureAssembly): boolean {
  return assemblyConfirmationStatus(assembly) === 'confirmed';
}

export function confirmedAssemblySnapshot(assembly: FurnitureAssembly): Pick<FurnitureAssembly, 'confirmed' | 'relationGeneration' | 'confirmedRelationGeneration' | 'confirmedMemberIds' | 'confirmedConnections'> {
  const relationGeneration = isAssemblyRelationGeneration(assembly.relationGeneration) ? assembly.relationGeneration : 0;
  return {
    confirmed: true,
    relationGeneration,
    confirmedRelationGeneration: relationGeneration,
    confirmedMemberIds: [...assembly.memberIds],
    confirmedConnections: structuredClone(assembly.connections),
  };
}
