import type { DrawingEntity, DrawingSpace, Prim, Project, Vec2 } from './types.ts';
import type { Command } from './commandBus.ts';
import { newCommandId } from './ids.ts';

/**
 * 给生成图元建立与数组顺序无关的来源 key。
 * 指纹包含全部可见几何/样式；完全相同的源图元共享指纹，因而会被视为多个候选而非伪造区分。
 * 其他图元插入、删除或重排不会挪动 key；几何或样式改变则会产生新 key。
 */
function canonicalPrim(prim: Prim): string {
  if (prim.k === 'poly') return JSON.stringify(['poly', prim.pts.map(p => [p.x, p.y]), prim.closed, prim.layer, prim.lw, prim.dash ?? null]);
  if (prim.k === 'fill') return JSON.stringify(['fill', prim.pts.map(p => [p.x, p.y]), prim.layer, prim.alpha]);
  return JSON.stringify(['text', prim.p.x, prim.p.y, prim.text, prim.size, prim.layer, prim.align, prim.rot ?? 0]);
}

function fingerprintPrim(prim: Prim): string {
  const value = canonicalPrim(prim);
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}-${value.length.toString(36)}`;
}

export function sourceKeysForPrims(namespace: string, prims: Prim[]): string[] {
  return prims.map(prim => `${namespace}:g:${fingerprintPrim(prim)}`);
}

export const planSourceKeys = (ownerId: string, prims: Prim[]): string[] => sourceKeysForPrims(`plan:${ownerId}`, prims);
export const sheetSourceKeys = (cabinetId: string, view: string, prims: Prim[]): string[] => sourceKeysForPrims(`sheet:${cabinetId}:${view}`, prims);

export type DrawingSourceProblem = {
  entity: DrawingEntity;
  code: 'DRAWING-SOURCE-STALE' | 'DRAWING-SOURCE-AMBIGUOUS';
};

/** 无匹配或不能唯一对应的覆盖；调用方须展示 ERROR 并阻断正式导出。 */
export function drawingSourceProblems(project: Project, planKeys: string[], sheetKeys: string[]): DrawingSourceProblem[] {
  const references = (project.drawingEdits ?? []).filter(entity => Boolean(entity.replacesSource));
  const counts = {
    plan: countKeys(planKeys),
    sheet: countKeys(sheetKeys),
  };
  const referenceCounts = new Map<string, number>();
  for (const entity of references) {
    const key = `${entity.space}:${entity.replacesSource}`;
    referenceCounts.set(key, (referenceCounts.get(key) ?? 0) + 1);
  }
  const problems: DrawingSourceProblem[] = [];
  for (const entity of references) {
    const sourceKey = entity.replacesSource!;
    const candidates = counts[entity.space].get(sourceKey) ?? 0;
    const refs = referenceCounts.get(`${entity.space}:${sourceKey}`) ?? 0;
    if (candidates === 0) problems.push({ entity, code: 'DRAWING-SOURCE-STALE' });
    else if (candidates !== 1 || refs !== 1) problems.push({ entity, code: 'DRAWING-SOURCE-AMBIGUOUS' });
  }
  return problems;
}

function countKeys(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** 兼容专用验收及调用方：只返回已无候选源图元的覆盖实体。 */
export function staleDrawingOverrides(project: Project, planKeys: string[], sheetKeys: string[]): DrawingEntity[] {
  return drawingSourceProblems(project, planKeys, sheetKeys)
    .filter(problem => problem.code === 'DRAWING-SOURCE-STALE')
    .map(problem => problem.entity);
}
export const sourceSelectionId = (key: string): string => `source:${encodeURIComponent(key)}`;
export const sourceKeyFromSelection = (id: string): string | null => {
  if (!id.startsWith('source:')) return null;
  try { return decodeURIComponent(id.slice(7)); } catch { return null; }
};
export const editSelectionId = (id: string): string => `edit:${id}`;
export const editIdFromSelection = (id: string): string | null => id.startsWith('edit:') ? id.slice(5) : null;

export function drawingEntityPrims(entity: DrawingEntity): Prim[] {
  const p = entity.points;
  const line = (a: Vec2, b: Vec2, layer = entity.layer, lw = entity.lineWidth): Prim => ({ k: 'poly', pts: [{ ...a }, { ...b }], closed: false, layer, lw, ...(entity.dash ? { dash: [...entity.dash] } : {}) });
  if (entity.kind === 'text') {
    return p.length ? [{ k: 'text', p: { ...p[0]! }, text: entity.text ?? '', size: entity.textSize, layer: entity.layer, align: entity.align ?? 'l', ...(entity.rot !== undefined ? { rot: entity.rot } : {}) }] : [];
  }
  if (entity.kind === 'line') return p.length >= 2 ? [line(p[0]!, p[1]!)] : [];
  if (entity.kind === 'polyline') return p.length >= 2 ? [{ k: 'poly', pts: p.map(q => ({ ...q })), closed: entity.closed ?? false, layer: entity.layer, lw: entity.lineWidth, ...(entity.dash ? { dash: [...entity.dash] } : {}) }] : [];
  if (entity.kind === 'dimension') {
    if (p.length < 3) return [];
    const [a, b, offset] = p as [Vec2, Vec2, Vec2];
    const vx = b.x - a.x, vy = b.y - a.y;
    const length = Math.hypot(vx, vy) || 1;
    const nx = -vy / length, ny = vx / length;
    const side = Math.sign((offset.x - a.x) * nx + (offset.y - a.y) * ny) || 1;
    const gap = 36;
    const d1 = { x: a.x + nx * side * gap, y: a.y + ny * side * gap };
    const d2 = { x: b.x + nx * side * gap, y: b.y + ny * side * gap };
    const tick = 48;
    const mid = { x: (d1.x + d2.x) / 2 + nx * side * entity.textSize * 0.8, y: (d1.y + d2.y) / 2 + ny * side * entity.textSize * 0.8 };
    const value = entity.text || `${Math.round(length)} mm`;
    return [line(a, d1), line(b, d2), line(d1, d2), line({ x: d1.x - nx * tick / 2, y: d1.y - ny * tick / 2 }, { x: d1.x + nx * tick / 2, y: d1.y + ny * tick / 2 }), line({ x: d2.x - nx * tick / 2, y: d2.y - ny * tick / 2 }, { x: d2.x + nx * tick / 2, y: d2.y + ny * tick / 2 }), { k: 'text', p: mid, text: value, size: entity.textSize, layer: entity.layer, align: 'c' }];
  }
  if (entity.kind === 'leader') {
    if (p.length < 2) return [];
    const out: Prim[] = [];
    for (let i = 0; i + 1 < p.length; i++) out.push(line(p[i]!, p[i + 1]!));
    const [tip, next] = p;
    const angle = Math.atan2(next!.y - tip!.y, next!.x - tip!.x);
    const size = Math.max(40, entity.textSize * 0.45);
    out.push(line(tip!, { x: tip!.x + Math.cos(angle + 0.45) * size, y: tip!.y + Math.sin(angle + 0.45) * size }));
    out.push(line(tip!, { x: tip!.x + Math.cos(angle - 0.45) * size, y: tip!.y + Math.sin(angle - 0.45) * size }));
    out.push({ k: 'text', p: { ...next! }, text: entity.text ?? '注释', size: entity.textSize, layer: entity.layer, align: 'l' });
    return out;
  }
  return [];
}

/** 手工尺寸端点与同视图模型生产尺寸重合时提示用户，避免双重或相互矛盾的标注。 */
export function conflictsWithProductionDimension(entity: DrawingEntity, generatedPrims: Prim[], tolerance = 18): boolean {
  if (entity.kind !== 'dimension' || entity.points.length < 2) return false;
  const [a, b] = entity.points;
  if (!a || !b) return false;
  const close = (p: Vec2, q: Vec2): boolean => Math.hypot(p.x - q.x, p.y - q.y) <= tolerance;
  return generatedPrims.some((prim) => {
    if (prim.k !== 'poly' || !prim.layer.startsWith('F-DIM') || prim.pts.length !== 2) return false;
    const [x, y] = prim.pts;
    if (!x || !y) return false;
    return (close(a, x) && close(b, y)) || (close(a, y) && close(b, x));
  });
}

export function drawingPrims(project: Project, space: DrawingSpace, sourcePrims: Prim[], sourceKeys: string[]): Prim[] {
  const edits = (project.drawingEdits ?? []).filter(e => e.space === space);
  const candidates = countKeys(sourceKeys);
  const references = new Map<string, number>();
  for (const edit of edits) {
    if (!edit.replacesSource) continue;
    references.set(edit.replacesSource, (references.get(edit.replacesSource) ?? 0) + 1);
  }
  const suppressed = new Set(edits.flatMap(e => {
    const key = e.replacesSource;
    return key && candidates.get(key) === 1 && references.get(key) === 1 ? [key] : [];
  }));
  const base = sourcePrims.filter((_, i) => !suppressed.has(sourceKeys[i] ?? ''));
  return [...base, ...edits.flatMap(drawingEntityPrims)];
}

/** Window select for editable model sources. Fill primitives intentionally remain read-only. */
export function sourceKeysInRect(
  prims: Prim[], keys: string[], rect: { minX: number; minY: number; maxX: number; maxY: number }, hidden: Set<string> = new Set(),
): string[] {
  const selected: string[] = [];
  prims.forEach((prim, i) => {
    const key = keys[i];
    if (!key || hidden.has(key) || (prim.k !== 'poly' && prim.k !== 'text')) return;
    const points = prim.k === 'text' ? [prim.p] : prim.pts;
    if (points.length && points.every(p => p.x >= rect.minX && p.x <= rect.maxX && p.y >= rect.minY && p.y <= rect.maxY)) selected.push(key);
  });
  return selected;
}

export function replaceDrawingEdits(project: Project, drawingEdits: DrawingEntity[], label = '编辑二维图元'): Command {
  return {
    id: newCommandId('drawing.edits.replace'), op: 'drawing.edits.replace', source: 'ui',
    target: { kind: 'project', id: project.id }, changes: [], payload: { drawingEdits: structuredClone(drawingEdits) }, label,
  };
}

export function translateDrawingEntity(entity: DrawingEntity, dx: number, dy: number, id = entity.id): DrawingEntity {
  return { ...structuredClone(entity), id, points: entity.points.map(p => ({ x: Math.round(p.x + dx), y: Math.round(p.y + dy) })) };
}

export function sourceOverride(sourceKey: string, prim: Prim, space: DrawingSpace, id: string, meta: Partial<DrawingEntity> = {}): DrawingEntity | null {
  if (prim.k === 'fill') return null;
  const points = prim.k === 'text' ? [prim.p] : prim.pts;
  const kind: DrawingEntity['kind'] = prim.k === 'text' ? 'text' : 'polyline';
  return {
    id, space, kind, points: points.map(p => ({ ...p })),
    text: prim.k === 'text' ? prim.text : undefined,
    textSize: prim.k === 'text' ? prim.size : 180,
    rot: prim.k === 'text' ? prim.rot : undefined,
    lineWidth: prim.k === 'poly' ? prim.lw : 1,
    closed: prim.k === 'poly' ? prim.closed : undefined,
    dash: prim.k === 'poly' && prim.dash ? [...prim.dash] : undefined,
    layer: prim.layer,
    provenance: 'model-override', replacesSource: sourceKey,
    ...(prim.k === 'text' ? { align: prim.align } : {}), ...meta,
  };
}
