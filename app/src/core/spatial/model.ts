import type { Opening, Vec2, Wall } from '../types.ts';
import { wallPolygon } from '../geometry/project.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  空间层的确定性几何助手（P8.7）
 *
 *  ── 这里只有"形状判定"，没有一处三角函数 ──
 *    柜体旋转后的 footprint 由 geometry 层唯一给出（getCabinetFootprint，
 *    旋转数学的唯一实现）。本模块只消费它的结果：点在多边形内、边是否
 *    正交穿过、两多边形距离 —— 全是整数坐标上的定向叉积与比较，
 *    不重复实现任何 cos/sin/transform（架构红线：空间层不做第二套旋转）。
 *
 *  ── 容差集中定义 ──
 *    本模块所有"多近算贴着 / 多近算附近"的阈值都出自 SPATIAL_TOL 一处；
 *    任何函数不许自己写 magic number（教训：tolerance 一散落，
 *    touching/near/crossing 的口径就开始各说各话）。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 空间容差（mm，项目级唯一出处）：
 *  - TOUCH：间距 ≤ 1mm 视为"贴着"（整数 mm 坐标下，真实贴合 gap=0；
 *    1mm 吸收装配语义上的"齐"与数值上差 1 的边缘情形）。
 *  - NEAR：间距 ≤ 50mm 视为"附近"（不影响任何硬规则，只是事实层标注）。
 *  - OPENING_ZONE：洞口室内侧影响带深度。洞口本体是墙体厚度里的一段空腔，
 *    贴墙摆放的柜体永远只会与它"贴线"——按几何永远检不出"柜子挡门"。
 *    所以判定"柜站在洞口正前方"用的是从墙内表面往屋里延伸 OPENING_ZONE
 *    的矩形：这段范围是人/光通过门洞要用的空间（600mm ≈ 一臂深）。
 *    本阶段不做门扇开启包络（P8.3 留作后续事实层），这里是保守的固定深度，
 *    集中定义、注释用途，不允许调用方各自再放大缩小。
 * 两个距离阈值之间严格分段，不互相吞；区域阈值只服务洞口一处。
 */
export const SPATIAL_TOL = { TOUCH: 1, NEAR: 50, OPENING_ZONE: 600 } as const;

/** 叉积 (b-a)×(c-a) 的符号：>0 c 在 ab 左侧，<0 右侧，=0 共线 */
function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/** 点是否在线段上（共线且落在端点范围内）—— 整数坐标下精确判定，无浮点 */
export function pointOnSeg(p: Vec2, a: Vec2, b: Vec2): boolean {
  if (cross(a.x, a.y, b.x, b.y, p.x, p.y) !== 0) return false;
  return (
    p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
  );
}

/**
 * 点对简单多边形的位置。边界上的点算 "on"（调用方按语义归入内/外）。
 * 射线法：整数坐标下用严格符号判断，确定性成立（没有 epsilon）。
 */
export function pointInPoly(p: Vec2, poly: Vec2[]): 'in' | 'out' | 'on' {
  for (let i = 0; i < poly.length; i++) {
    if (pointOnSeg(p, poly[i]!, poly[(i + 1) % poly.length]!)) return 'on';
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]!.x;
    const yi = poly[i]!.y;
    const xj = poly[j]!.x;
    const yj = poly[j]!.y;
    if (yi > p.y !== yj > p.y) {
      // 交点横坐标与 p.x 比较：整数运算转成交叉乘，避免除法。
      // xIntersect = xi + (p.y - yi)*(xj - xi)/(yj - yi) > p.x
      // 移项后不等号方向由 (yj - yi) 的符号决定（ yi≠yj 由外层 if 保证）。
      const lhs = (xj - xi) * (p.y - yi);
      const rhs = (p.x - xi) * (yj - yi);
      if (yj > yi ? lhs > rhs : lhs < rhs) inside = !inside;
    }
  }
  return inside ? 'in' : 'out';
}

/** 两线段是否**正交穿过**（严格相交于各自内部；共点/共线不算 —— 那是"接触"） */
export function segsProperCross(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d1 = cross(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const d2 = cross(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
  const d3 = cross(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const d4 = cross(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 点到线段的距离（整数坐标，返回浮点距离值；只用于"最近多少 mm"的排序级比较） */
export function distPointSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 两多边形的最近距离（顶点-对边距离的最小值；凸四边形场景够用且确定） */
export function polyDistance(a: Vec2[], b: Vec2[]): number {
  let best = Infinity;
  for (const poly of [a, b] as const) {
    const other = poly === a ? b : a;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      for (let j = 0; j < other.length; j++) {
        best = Math.min(best, distPointSeg(p, other[j]!, other[(j + 1) % other.length]!));
      }
    }
  }
  return best;
}

/**
 * 多边形 A 是否与多边形 B 发生**内部重叠**（面积级相交，区别于贴边接触）：
 * 任一顶点严格落入对方内部，或任一对边正交穿过。
 * 只有贴边/共点接触（面积 0）时返回 false —— 那归 "touching"。
 */
export function polysOverlapInterior(a: Vec2[], b: Vec2[]): boolean {
  for (const p of a) if (pointInPoly(p, b) === 'in') return true;
  for (const p of b) if (pointInPoly(p, a) === 'in') return true;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segsProperCross(a[i]!, a[(i + 1) % a.length]!, b[j]!, b[(j + 1) % b.length]!)) return true;
    }
  }
  return false;
}

// ─────────────────────────── 房间边界（墙回路） ───────────────────────────

export type RoomLoopStatus = 'ok' | 'empty' | 'open' | 'dup' | 'branch' | 'selfx';

export interface RoomLoop {
  status: RoomLoopStatus;
  /** status === 'ok' 时给出沿墙中心线的闭合回路顶点（按走墙顺序） */
  poly: Vec2[];
}

/**
 * 把房间的墙串成一条闭合回路（房间边界 = 墙中心线回路，唯一口径）。
 *
 * 确定性走法：从第一面墙的 start 出发，每次找一条尚未使用、且端点与当前点
 * 重合的墙走过去；回到起点即闭合。任何一步走不下去（open）、顶点重复（dup）、
 * 还有墙没进回路（branch：分支 / 多个环）都如实报状态 —— **不静默修复**，
 * 由 validate 层翻成结构化 issue。
 */
export function roomLoop(walls: Wall[]): RoomLoop {
  const segs = walls.filter((w) => w.start.x !== w.end.x || w.start.y !== w.end.y);
  if (segs.length === 0) return { status: walls.length > 0 ? 'ok' : 'empty', poly: [] };
  const key = (p: Vec2): string => `${p.x},${p.y}`;
  const poly: Vec2[] = [segs[0]!.start, segs[0]!.end];
  const used = new Set<number>([0]);
  let cur = segs[0]!.end;
  const startKey = key(segs[0]!.start);
  while (key(cur) !== startKey) {
    let next = -1;
    let nextEnd: Vec2 | null = null;
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue;
      const s = segs[i]!;
      if (key(s.start) === key(cur) && key(s.end) !== key(cur)) {
        next = i;
        nextEnd = s.end;
        break;
      }
      if (key(s.end) === key(cur) && key(s.start) !== key(cur)) {
        next = i;
        nextEnd = s.start;
        break;
      }
    }
    if (next < 0 || !nextEnd) return { status: 'open', poly: [] };
    used.add(next);
    if (key(nextEnd) === startKey) break; // 闭合：起点不重复入列（poly 是纯环，无首尾重复）
    if (key(nextEnd) === key(cur)) return { status: 'dup', poly: [] };
    poly.push(nextEnd);
    cur = nextEnd;
    if (used.size > segs.length) return { status: 'branch', poly: [] };
  }
  if (used.size < segs.length) return { status: 'branch', poly: [] };
  // 顶点重复（非首尾）：回路自我折叠
  for (let i = 0; i < poly.length - 1; i++) {
    if (key(poly[i]!) === key(poly[i + 1]!)) return { status: 'dup', poly: [] };
  }
  // 自交：非相邻边正交穿过（共享端点的相邻边不算）
  const n = poly.length; // 顶点数 == 边数（闭合）
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (adjacent) continue;
      if (segsProperCross(poly[i]!, poly[(i + 1) % n]!, poly[j]!, poly[(j + 1) % n]!)) {
        return { status: 'selfx', poly: [] };
      }
    }
  }
  return { status: 'ok', poly };
}

/**
 * 洞口在墙上的世界矩形（P8.7）。
 *
 * 不写第二份法线数学：wallPolygon 的四个角就是 [start+n, end+n, end-n, start-n]，
 * 洞口矩形 = 沿上下两边按 offset/width **插值**既有角点 —— 洞口的世界位置
 * 是墙几何的派生值，这里零新增旋转/法线计算。
 *
 * @returns status 'ok' 给矩形；'badwall' 墙长为 0；'badspan' 洞口 span 不在墙内
 */
export function openingRect(
  wall: Wall,
  span: { offset: number; width: number }
): { status: 'ok'; rect: Vec2[] } | { status: 'badwall' } | { status: 'badspan' } {
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return { status: 'badwall' };
  if (span.offset < 0 || span.width <= 0 || span.offset + span.width > len) {
    return { status: 'badspan' };
  }
  const poly = wallPolygon(wall);
  const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const t0 = span.offset / len;
  const t1 = (span.offset + span.width) / len;
  const top = [lerp(poly[0]!, poly[1]!, t0), lerp(poly[0]!, poly[1]!, t1)];
  const bottom = [lerp(poly[3]!, poly[2]!, t0), lerp(poly[3]!, poly[2]!, t1)];
  return { status: 'ok', rect: [top[0]!, top[1]!, bottom[1]!, bottom[0]!] };
}

/**
 * 洞口的"影响带"矩形（P8.7）：洞口 span × [墙外侧 −t/2 … 室内侧 +t/2+OPENING_ZONE]。
 *
 * @param side 室内侧方向：+1 = 墙单位法线（wallPolygon 的 +n 侧）指向室内；-1 = 相反。
 *             由 derive 层用房间回路的点在多边形判定得出（确定性，不是猜）。
 * @returns status 'ok' 给矩形；'badwall' 墙长为 0；'badspan' 洞口 span 不在墙内
 */
export function openingZoneRect(
  wall: Wall,
  span: { offset: number; width: number },
  side: 1 | -1
): { status: 'ok'; rect: Vec2[] } | { status: 'badwall' } | { status: 'badspan' } {
  const base = openingRect(wall, span);
  if (base.status !== 'ok') return base;
  const poly = wallPolygon(wall);
  // 单位法线可由 wallPolygon 的角点差纯派生：poly[0]=start+n、poly[3]=start-n
  const nx = poly[0]!.x - poly[3]!.x;
  const ny = poly[0]!.y - poly[3]!.y;
  const nl = Math.hypot(nx, ny);
  const ext = { x: (nx / nl) * side * SPATIAL_TOL.OPENING_ZONE, y: (ny / nl) * side * SPATIAL_TOL.OPENING_ZONE };
  const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const len = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const t0 = span.offset / len;
  const t1 = (span.offset + span.width) / len;
  const innerA = side === 1 ? lerp(poly[0]!, poly[1]!, t0) : lerp(poly[3]!, poly[2]!, t0);
  const innerB = side === 1 ? lerp(poly[0]!, poly[1]!, t1) : lerp(poly[3]!, poly[2]!, t1);
  const outerA = side === 1 ? lerp(poly[3]!, poly[2]!, t0) : lerp(poly[0]!, poly[1]!, t0);
  const outerB = side === 1 ? lerp(poly[3]!, poly[2]!, t1) : lerp(poly[0]!, poly[1]!, t1);
  return {
    status: 'ok',
    rect: [outerA, outerB, { x: innerB.x + ext.x, y: innerB.y + ext.y }, { x: innerA.x + ext.x, y: innerA.y + ext.y }],
  };
}

/** 墙的单位法线（wallPolygon 的 +n 方向，纯派生自其角点差） */
export function wallNormalUnit(w: Wall): Vec2 | null {
  const poly = wallPolygon(w);
  if (poly.length < 4) return null;
  const nx = poly[0]!.x - poly[3]!.x;
  const ny = poly[0]!.y - poly[3]!.y;
  const l = Math.hypot(nx, ny);
  return l === 0 ? null : { x: nx / l, y: ny / l };
}

/** 洞口的中文显示名（kind 词汇表的人话出口，UI / issue 共用一处） */
export function openingName(o: Opening): string {
  return o.name ?? (o.kind === 'door' ? '门洞' : '窗洞');
}
