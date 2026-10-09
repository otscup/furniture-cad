export interface DuplicateUnitIdLocation {
  id: string;
  locations: string[];
}
export function findDuplicateUnitIds(project: unknown): DuplicateUnitIdLocation[];
export const WORKSPACE_UNIT_ID_CONFLICT: 'WORKSPACE_UNIT_ID_CONFLICT';
export function unitIdentityConflictMessage(scope: string, duplicates: DuplicateUnitIdLocation[]): string;
export function unitIdentityConflictError(scope: string, duplicates: DuplicateUnitIdLocation[]): Error & { code: 'WORKSPACE_UNIT_ID_CONFLICT' };
