import type { BBox, Cabinet, Project, Vec2, Wall } from '../core/types.ts';
import { getCabinetFootprint } from '../core/geometry/generate.ts';
import { wallPolygon } from '../core/geometry/project.ts';
import { bboxOf, dist, distToSegment, localToWorld, pointInPoly } from '../core/geometry/transform.ts';

/**
 * 命中测试与夹点（主方案 §L5 / §L7）
 *
 * 命中优先级：夹点 > 柜体 > 墙。
 * 夹点必须最高：用户已经选中了对象、手指放在夹点上时，
 * 意图 100% 是"改这个夹点"，不该被"这个位置恰好落在柜体里"抢走。
 */

export type GripRole = 'cab-move' | 'cab-width-l' | 'cab-width-r' | 'cab-depth-f' | 'wall-start' | 'wall-end';

export interface Grip {
  p: Vec2;
  role: GripRole;
  ownerId: string;
  ownerKind: 'cabinet' | 'wall';
  /** 界面提示文字 */
  hint: string;
}

const GRIP_HINT: Record<GripRole, string> = {
  'cab-move': '移动柜体',
  'cab-width-l': '改宽度（右边缘固定）',
  'cab-width-r': '改宽度（左边缘固定）',
  'cab-depth-f': '改深度（背面固定）',
  'wall-start': '改墙起点',
  'wall-end': '改墙终点',
};

export function cabinetGrips(cab: Cabinet): Grip[] {
  const { x, y, rotation } = cab.placement;
  const W = cab.params.width;
  const D = cab.params.depth;
  const local: Array<[Vec2, GripRole]> = [
    [{ x: 0, y: D / 2 }, 'cab-width-l'],
    [{ x: W, y: D / 2 }, 'cab-width-r'],
    [{ x: W / 2, y: D }, 'cab-depth-f'],
    [{ x: W / 2, y: D / 2 }, 'cab-move'],
  ];
  return local.map(([p, role]) => ({
    p: localToWorld(p, { x, y }, rotation),
    role,
    ownerId: cab.id,
    ownerKind: 'cabinet' as const,
    hint: GRIP_HINT[role],
  }));
}

export function wallGrips(w: Wall): Grip[] {
  return [
    { p: w.start, role: 'wall-start', ownerId: w.id, ownerKind: 'wall', hint: GRIP_HINT['wall-start'] },
    { p: w.end, role: 'wall-end', ownerId: w.id, ownerKind: 'wall', hint: GRIP_HINT['wall-end'] },
  ];
}

export function gripsFor(project: Project, id: string): Grip[] {
  const cab = project.cabinets.find((c) => c.id === id);
  if (cab) return cabinetGrips(cab);
  for (const r of project.rooms) {
    const w = r.walls.find((x) => x.id === id);
    if (w) return wallGrips(w);
  }
  return [];
}

export interface HitResult {
  kind: 'grip' | 'cabinet' | 'wall' | 'empty';
  id?: string;
  grip?: Grip;
}

/**
 * @param tolWorld 世界坐标容差（由屏幕 8px 换算而来）
 * @param selectedIds 已选中对象 —— 它们的夹点参与命中
 */
export function hitTest(project: Project, world: Vec2, tolWorld: number, selectedIds: string[]): HitResult {
  // ① 夹点（只对已选中对象）
  const gripTol = tolWorld * 1.6;
  let bestGrip: Grip | null = null;
  let bestGripD = gripTol;
  for (const id of selectedIds) {
    for (const g of gripsFor(project, id)) {
      const d = dist(world, g.p);
      if (d <= bestGripD) {
        bestGripD = d;
        bestGrip = g;
      }
    }
  }
  if (bestGrip) return { kind: 'grip', id: bestGrip.ownerId, grip: bestGrip };

  // ② 柜体（后画的在上层，所以倒序）
  for (let i = project.cabinets.length - 1; i >= 0; i--) {
    const cab = project.cabinets[i];
    const fp = getCabinetFootprint(cab);
    if (fp.length && pointInPoly(world, fp)) return { kind: 'cabinet', id: cab.id };
  }

  // ③ 墙（按半墙厚 + 容差判定）
  for (const room of project.rooms) {
    for (let i = room.walls.length - 1; i >= 0; i--) {
      const w = room.walls[i];
      if (distToSegment(world, w.start, w.end) <= w.thickness / 2 + tolWorld) return { kind: 'wall', id: w.id };
    }
  }

  return { kind: 'empty' };
}

function bboxIntersect(a: BBox, b: BBox): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y;
}

function bboxOfWall(w: Wall): BBox {
  const poly = wallPolygon(w);
  if (poly.length === 0) {
    return { min: { ...w.start }, max: { ...w.end } };
  }
  return bboxOf(poly);
}

export function normalizeRect(a: Vec2, b: Vec2): BBox {
  return {
    min: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) },
    max: { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) },
  };
}

/**
 * 框选。
 * 从左往右拖（a.x < b.x）= 窗口选择：完全落在框内才选中
 * 从右往左拖 = 交叉选择：碰到就选中
 * —— 这是 AutoCAD 的既有约定，用户手指已经记住了。
 */
export function boxSelect(project: Project, a: Vec2, b: Vec2): string[] {
  const box = normalizeRect(a, b);
  const crossing = b.x < a.x;
  const out: string[] = [];

  for (const cab of project.cabinets) {
    const fp = getCabinetFootprint(cab);
    if (!fp.length) continue;
    const cb = bboxOf(fp);
    const hit = crossing
      ? bboxIntersect(cb, box)
      : cb.min.x >= box.min.x && cb.max.x <= box.max.x && cb.min.y >= box.min.y && cb.max.y <= box.max.y;
    if (hit) out.push(cab.id);
  }

  for (const room of project.rooms) {
    for (const w of room.walls) {
      const wb = bboxOfWall(w);
      const hit = crossing
        ? bboxIntersect(wb, box)
        : wb.min.x >= box.min.x && wb.max.x <= box.max.x && wb.min.y >= box.min.y && wb.max.y <= box.max.y;
      if (hit) out.push(w.id);
    }
  }

  return out;
}

/** 框选方向是否交叉（用于状态栏提示） */
export function boxSelectMode(a: Vec2, b: Vec2): 'window' | 'crossing' {
  return b.x < a.x ? 'crossing' : 'window';
}
