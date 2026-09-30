import type { Cabinet, OpeningKind, Project, Vec2, Wall } from '../types.ts';
import { getCabinetFootprint } from '../geometry/generate.ts';
import { bboxOf } from '../geometry/transform.ts';
import { wallPolygon } from '../geometry/project.ts';
import {
  SPATIAL_TOL,
  openingZoneRect,
  polyDistance,
  pointInPoly,
  polysOverlapInterior,
  roomLoop,
  segsProperCross,
  wallNormalUnit,
} from './model.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  空间事实派生（P8.7）—— 柜体 ↔ 空间实体的确定性关系
 *
 *  职责边界（架构纪律）：
 *   ① 只产事实（facts），**绝不修改模型**、不自动移柜、不自动贴合 ——
 *      "发现撞墙就自动挪"是本阶段明确禁止的行为（issue + 事实，仅此而已）。
 *   ② 不调 AI、不产 DXF / BOM —— 空间层是纯派生。
 *   ③ 旋转几何全部复用 geometry 层的 getCabinetFootprint（唯一旋转实现），
 *      bbox 只用于**剪枝**（不可能相交的先跳过），判定用 footprint 多边形。
 *
 *  与既有规则的关系（不重复报、不抢归属）：
 *   - 柜体嵌墙的硬错误仍是 geometry 层的 RULE-CABINET-IN-WALL（bbox 级；
 *     bbox ⊇ footprint，凡 footprint 穿墙它必报）—— 空间层**不发重复 issue**，
 *     只在 facts 里给出更细的 touching / near / crossing 分类。
 *   - 空间层独有的 issue（见 validate.ts）：房间形状问题、洞口 span 非法、
 *     柜在房间外、柜盖洞口。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 柜体 ↔ 房间：inside = 全在边界内；outside = 全在外；crossing = 压边界；unknown = 边界不成回路 */
export type CabRoomRelation = 'inside' | 'outside' | 'crossing' | 'unknown';
/** 柜体 ↔ 墙：touching = 贴着（≤TOUCH）；near = 附近（≤NEAR）；crossing = 穿入墙体；none = 无关 */
export type CabWallRelation = 'touching' | 'near' | 'crossing' | 'none';
/** 柜体 ↔ 洞口：clear = 不相干；overlap = 盖住了洞口区域；unknown = 洞口 span 非法或墙退化 */
export type CabOpeningRelation = 'clear' | 'overlap' | 'unknown';

export interface SpatialFacts {
  rooms: Array<{ roomId: string; closed: boolean; problem: string | null }>;
  cabinets: Array<{
    cabId: string;
    room: CabRoomRelation;
    walls: Array<{ wallId: string; relation: CabWallRelation; gap: number }>;
    openings: Array<{ openingId: string; wallId: string; kind: OpeningKind; relation: CabOpeningRelation }>;
  }>;
}

/** 单只柜体对一面墙的分类（footprint 多边形 vs 墙矩形，bbox 只做剪枝） */
export function classifyCabWall(
  fp: Vec2[],
  wallRect: Vec2[]
): { relation: CabWallRelation; gap: number } {
  const cb = bboxOf(fp);
  const wb = bboxOf(wallRect);
  // bbox 剪枝：分离盒先算间距，间距 > NEAR 直接 none（多边形距离必然更大）
  const dx = Math.max(wb.min.x - cb.max.x, cb.min.x - wb.max.x, 0);
  const dy = Math.max(wb.min.y - cb.max.y, cb.min.y - wb.max.y, 0);
  const bboxGap = dx > 0 && dy > 0 ? Math.hypot(dx, dy) : Math.max(dx, dy);
  if (bboxGap > SPATIAL_TOL.NEAR) return { relation: 'none', gap: Math.round(bboxGap) };
  if (polysOverlapInterior(fp, wallRect)) return { relation: 'crossing', gap: 0 };
  const gap = polyDistance(fp, wallRect);
  if (gap <= SPATIAL_TOL.TOUCH) return { relation: 'touching', gap: Math.round(gap) };
  if (gap <= SPATIAL_TOL.NEAR) return { relation: 'near', gap: Math.round(gap) };
  return { relation: 'none', gap: Math.round(gap) };
}

/**
 * 单只柜体对一个洞口的分类（用洞口**影响带**：墙体空腔 + 室内侧 OPENING_ZONE 通行带）。
 *
 * 为什么不是只拿洞口空腔判重叠：贴墙摆放的柜体永远只会与墙体带"贴线"，
 * 纯空腔几何永远检不出"柜子挡门"。影响带把"柜站在洞口正前方"变成
 * 可判定的平面重叠 —— 深度集中定义在 SPATIAL_TOL.OPENING_ZONE。
 *
 * @param side 室内侧方向（+1 = 墙法线正向朝室内）；null = 回路不闭合/墙退化，
 *             此时退化为只查洞口空腔（塞进墙里的柜仍能查出，贴墙挡洞查不出 —— 如实降级）。
 */
export function classifyCabOpening(
  fp: Vec2[],
  wall: Wall,
  span: { offset: number; width: number },
  side: 1 | -1 | null
): CabOpeningRelation {
  const r = side === null ? openingZoneRect(wall, span, 1) : openingZoneRect(wall, span, side);
  if (r.status === 'badspan') return 'unknown';
  if (r.status !== 'ok') return 'unknown';
  return polysOverlapInterior(fp, r.rect) ? 'overlap' : 'clear';
}

/**
 * 判定墙的哪一侧是房间内侧（+1 = 墙法线正向 / -1 = 反向 / null = 判不出）。
 * 用房间回路 + 中点两侧采样点做点在多边形判定 —— 确定性，不是猜。
 */
export function wallInteriorSide(loop: Vec2[], wall: Wall): 1 | -1 | null {
  const nu = wallNormalUnit(wall);
  if (!nu) return null;
  const mx = (wall.start.x + wall.end.x) / 2;
  const my = (wall.start.y + wall.end.y) / 2;
  const off = wall.thickness / 2 + 10;
  const a = pointInPoly({ x: mx + nu.x * off, y: my + nu.y * off }, loop);
  const b = pointInPoly({ x: mx - nu.x * off, y: my - nu.y * off }, loop);
  if (a === 'in' || a === 'on') return 1;
  if (b === 'in' || b === 'on') return -1;
  return null;
}

/** 柜体对房间回路的分类（footprint 四角 + 边穿越） */
export function classifyCabRoom(fp: Vec2[], loop: Vec2[]): CabRoomRelation {
  if (loop.length < 3) return 'unknown';
  let inCount = 0;
  let outCount = 0;
  for (const p of fp) {
    const pos = pointInPoly(p, loop);
    if (pos === 'in' || pos === 'on') inCount++; // 边界算在内：贴墙内侧摆放是合法态
    else outCount++;
  }
  // 边穿越：任何 footprint 边与任何边界边正交穿过 → 压边界
  for (let i = 0; i < fp.length; i++) {
    for (let j = 0; j < loop.length; j++) {
      if (segsProperCross(fp[i]!, fp[(i + 1) % fp.length]!, loop[j]!, loop[(j + 1) % loop.length]!)) {
        return 'crossing';
      }
    }
  }
  if (inCount === fp.length) return 'inside';
  if (outCount === fp.length) return 'outside';
  return 'crossing';
}

/** 墙矩形（四角）；零长墙返回 null（由 validate 报 SPATIAL-WALL-ZERO） */
function wallRectOf(w: Wall): Vec2[] | null {
  if (w.start.x === w.end.x && w.start.y === w.end.y) return null;
  return wallPolygon(w);
}

/**
 * 派生整个项目的空间事实。纯函数：不改 project、不调 AI、不产几何/清单。
 * facts.cabinets 覆盖**所有**柜体（与空间无关的柜 relation 全 none/unknown 也是事实）。
 */
export function deriveSpatialFacts(project: Project): SpatialFacts {
  const loopByRoom = new Map<string, ReturnType<typeof roomLoop>>();
  const rooms = project.rooms.map((r) => {
    const loop = roomLoop(r.walls);
    loopByRoom.set(r.id, loop);
    return { roomId: r.id, closed: loop.status === 'ok', problem: loop.status === 'ok' ? null : loop.status };
  });

  const cabinets = project.cabinets.map((cab: Cabinet) => {
    const room = project.rooms.find((r) => r.id === cab.roomId);
    const fp = getCabinetFootprint(cab);
    const walls: SpatialFacts['cabinets'][number]['walls'] = [];
    const openings: SpatialFacts['cabinets'][number]['openings'] = [];
    if (fp.length > 0) {
      for (const r of project.rooms) {
        const loop = loopByRoom.get(r.id);
        const loopOk = loop?.status === 'ok';
        for (const w of r.walls) {
          const rect = wallRectOf(w);
          if (rect) {
            const { relation, gap } = classifyCabWall(fp, rect);
            if (relation !== 'none') walls.push({ wallId: w.id, relation, gap });
          }
          if (w.openings) {
            // 室内侧只取决于墙与房间回路（与柜无关），先算一次
            const side: 1 | -1 | null = loopOk ? wallInteriorSide(loop!.poly, w) : null;
            for (const o of w.openings) {
              openings.push({ openingId: o.id, wallId: w.id, kind: o.kind, relation: classifyCabOpening(fp, w, o, side) });
            }
          }
        }
      }
    }
    const loop = room ? loopByRoom.get(room.id) : undefined;
    const roomRel: CabRoomRelation = !room || !loop || loop.status !== 'ok' ? 'unknown' : classifyCabRoom(fp, loop.poly);
    return { cabId: cab.id, room: roomRel, walls, openings };
  });
  return { rooms, cabinets };
}
