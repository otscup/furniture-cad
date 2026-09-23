import type { Project, Vec2 } from '../core/types.ts';
import { getCabinetFootprint } from '../core/geometry/generate.ts';
import { segIntersect, snapAngle } from '../core/geometry/transform.ts';

/**
 * 捕捉系统（主方案 §L2）
 *
 * 优先级：对象捕捉 > 正交/极轴 > 栅格 > 原始点
 *   —— 为什么对象捕捉最高：CAD 里"对齐到已有对象的端点"是最高意图，
 *      正交只是为了快速画直，不应该覆盖一个明确的几何意图。
 *
 * 这个模块是纯函数：不改模型，不持有状态，可以被单测穷举。
 */

export type SnapKind = 'end' | 'mid' | 'center' | 'quad' | 'intersect' | 'grid' | 'ortho' | 'polar' | 'none';

export interface SnapNode {
  p: Vec2;
  kind: SnapKind;
  /** 归属对象 id，用于界面提示"捕捉到 主卧衣柜 的端点" */
  ref: string;
}

export interface SnapSettings {
  enabled: boolean;
  ortho: boolean;
  polar: boolean;
  /** 极轴增量角（deg） */
  polarStep: number;
  gridSnap: boolean;
  /** 像素容差 */
  tolPx: number;
}

export const DEFAULT_SNAP: SnapSettings = {
  enabled: true,
  ortho: false,
  polar: true,
  polarStep: 15,
  gridSnap: false,
  tolPx: 12,
};

export interface SnapResult {
  p: Vec2;
  kind: SnapKind;
  ref: string;
  /** 极轴/正交追踪线（渲染用），null 表示不画 */
  tracking: { from: Vec2; to: Vec2 } | null;
}

const KEY = (k: SnapKind): string =>
  ({ end: '端点', mid: '中点', center: '中心', quad: '象限点', intersect: '交点', grid: '栅格', ortho: '正交', polar: '极轴', none: '' })[k];

export function snapKindLabel(k: SnapKind): string {
  return KEY(k);
}

/** 收集所有可捕捉的特征点（结果可按 modelVersion 缓存） */
export function collectSnapNodes(project: Project): SnapNode[] {
  const out: SnapNode[] = [];

  for (const room of project.rooms) {
    for (const w of room.walls) {
      out.push({ p: w.start, kind: 'end', ref: w.name });
      out.push({ p: w.end, kind: 'end', ref: w.name });
      out.push({ p: { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 }, kind: 'mid', ref: w.name });
    }
    // 同一房间内的墙-墙交点
    for (let i = 0; i < room.walls.length; i++) {
      for (let j = i + 1; j < room.walls.length; j++) {
        const x = segIntersect(room.walls[i].start, room.walls[i].end, room.walls[j].start, room.walls[j].end);
        if (x) out.push({ p: x, kind: 'intersect', ref: `${room.walls[i].name}×${room.walls[j].name}` });
      }
    }
  }

  for (const cab of project.cabinets) {
    const fp = getCabinetFootprint(cab);
    if (fp.length === 0) continue;
    for (const p of fp) out.push({ p, kind: 'quad', ref: cab.name });
    for (let i = 0; i < fp.length; i++) {
      const a = fp[i];
      const b = fp[(i + 1) % fp.length];
      out.push({ p: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'mid', ref: cab.name });
    }
    const cx = fp.reduce((a, p) => a + p.x, 0) / fp.length;
    const cy = fp.reduce((a, p) => a + p.y, 0) / fp.length;
    out.push({ p: { x: cx, y: cy }, kind: 'center', ref: cab.name });
  }

  return out;
}

function nearestNode(raw: Vec2, nodes: SnapNode[], tolWorld: number): SnapNode | null {
  let best: SnapNode | null = null;
  let bestD = tolWorld;
  for (const n of nodes) {
    const d = Math.hypot(n.p.x - raw.x, n.p.y - raw.y);
    if (d <= bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

const r0 = (v: number): number => Math.round(v);

/**
 * 解析最终点。
 * @param base 橡皮筋起点（画墙/移动的基点）。没有基点时正交/极轴不生效。
 * @param gridStep 当前自适应栅格步长（mm）
 */
export function resolveSnap(
  raw: Vec2,
  nodes: SnapNode[],
  s: SnapSettings,
  tolWorld: number,
  gridStep: number,
  base?: Vec2 | null
): SnapResult {
  // ① 对象捕捉
  if (s.enabled) {
    const n = nearestNode(raw, nodes, tolWorld);
    if (n) return { p: n.p, kind: n.kind, ref: n.ref, tracking: null };
  }

  // ② 正交 / 极轴（需要基点）
  if (base && (s.ortho || s.polar)) {
    const step = s.ortho ? 90 : s.polarStep;
    const d = snapAngle(raw.x - base.x, raw.y - base.y, step);
    if (Math.hypot(d.dx, d.dy) > 1e-6) {
      const p = { x: r0(base.x + d.dx), y: r0(base.y + d.dy) };
      // 极轴方向延伸的追踪线（渲染层画长一点）
      const len = Math.hypot(p.x - base.x, p.y - base.y) || 1;
      const ext = 6000 / len;
      return {
        p,
        kind: s.ortho ? 'ortho' : 'polar',
        ref: '',
        tracking: { from: base, to: { x: base.x + (p.x - base.x) * ext, y: base.y + (p.y - base.y) * ext } },
      };
    }
  }

  // ③ 栅格
  if (s.gridSnap && gridStep > 0) {
    return { p: { x: r0(raw.x / gridStep) * gridStep, y: r0(raw.y / gridStep) * gridStep }, kind: 'grid', ref: '', tracking: null };
  }

  return { p: { x: r0(raw.x), y: r0(raw.y) }, kind: 'none', ref: '', tracking: null };
}

/** 屏幕像素容差 → 世界容差，并夹在合理范围（避免缩得很小时把所有点都吸过去） */
export function snapToleranceWorld(tolPx: number, scale: number): number {
  return Math.min(Math.max(tolPx / scale, 1), 400);
}
