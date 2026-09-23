import type { Vec2 } from '../types.ts';

/**
 * 旋转矩阵里"本该是 0 / ±1"的分量必须**精确**取成 0 / ±1。
 *
 * 为什么（一次真实缺陷）：
 *   `Math.cos(Math.PI)` 是 -1，但 `Math.sin(Math.PI)` 是 1.2246e-16 —— 不是 0。
 *   于是一个旋转 180°、背靠北墙内表面（y=2540）的柜体，算出来的足迹
 *   max.y = 2540.0000000000005，比墙面大了 **4.5e-13 mm**。
 *   碰撞判定用的是严格小于（"相切不算干涉"），于是这一点点浮点残差
 *   把"贴墙"判成了"扎进墙里" —— 表现为：带旋转的柜体永远贴不上墙。
 *
 *   这类错误的坏处在于它**只在旋转角非 0 时出现**，而手工测试几乎总是转 0°，
 *   所以它能一直躺着，直到某个自动落点功能第一次尝试"贴着某面墙放"。
 *
 * 只对 90° 的整数倍做吸附：这些是 CAD 里真实会被用到的角度，
 * 而它们的三角函数值本该是精确的 0 / ±1。其余角度原样保留。
 */
function snapTrig(v: number): number {
  if (Math.abs(v) < 1e-12) return 0;
  if (Math.abs(v - 1) < 1e-12) return 1;
  if (Math.abs(v + 1) < 1e-12) return -1;
  return v;
}

/** 局部坐标 → 世界坐标。局部：+X 沿柜宽，+Y 沿进深（背面→正面）。 */
export function localToWorld(p: Vec2, origin: Vec2, rotationDeg: number): Vec2 {
  const r = (rotationDeg * Math.PI) / 180;
  const c = snapTrig(Math.cos(r));
  const s = snapTrig(Math.sin(r));
  return { x: origin.x + p.x * c - p.y * s, y: origin.y + p.x * s + p.y * c };
}

export function polyLocalToWorld(pts: Vec2[], origin: Vec2, rotationDeg: number): Vec2[] {
  return pts.map((p) => localToWorld(p, origin, rotationDeg));
}

export function rectPts(x: number, y: number, w: number, h: number): Vec2[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 点到线段的最短距离 */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 点是否在多边形内（射线法） */
export function pointInPoly(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export function bboxOf(pts: Vec2[]): { min: Vec2; max: Vec2 } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/** 两个角度差（deg），用于正交/极轴约束 */
export function snapAngle(dx: number, dy: number, stepDeg: number): { dx: number; dy: number } {
  const len = Math.hypot(dx, dy);
  if (len === 0) return { dx: 0, dy: 0 };
  const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
  const snapped = Math.round(ang / stepDeg) * stepDeg;
  const r = (snapped * Math.PI) / 180;
  return { dx: Math.cos(r) * len, dy: Math.sin(r) * len };
}

/** 点在直线段上的垂足参数（可能落在段外），t=0 在 a，t=1 在 b */
export function projectParamOnSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  return ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
}

/** 两条线段求交（含端点），平行/共线返回 null */
export function segIntersect(
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2
): Vec2 | null {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / den;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / den;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
  return { x: a1.x + t * d1x, y: a1.y + t * d1y };
}

/** 点到多边形的最近边上的最近点（用于"最近点"捕捉） */
export function nearestPointOnPoly(p: Vec2, poly: Vec2[]): Vec2 | null {
  if (poly.length < 2) return null;
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const t = Math.max(0, Math.min(1, projectParamOnSegment(p, a, b)));
    const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    const d = dist(p, q);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  return best;
}

