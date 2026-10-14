export interface DuplicateUnitIdLocation {
  id: string;
  locations: string[];
}
export function findDuplicateUnitIds(project: any): DuplicateUnitIdLocation[];
export const WORKSPACE_UNIT_ID_CONFLICT: 'WORKSPACE_UNIT_ID_CONFLICT';
export function unitIdentityConflictMessage(scope: string, duplicates: DuplicateUnitIdLocation[]): string;
export function unitIdentityConflictError(scope: string, duplicates: DuplicateUnitIdLocation[]): Error & { code: 'WORKSPACE_UNIT_ID_CONFLICT' };
export function repairDuplicateUnitIdsInProject(inputProject: any): { project: any; repairedCount: number };
export function deoverlapProjectRooms(inputProject: any, gapMm?: number): { project: any; movedRooms: Array<{ roomId: string; roomName: string; dx: number; dy: number }> };
