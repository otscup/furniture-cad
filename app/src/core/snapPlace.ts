import type { Project, Vec2 } from './types.ts';
import { projectParamOnSegment } from './geometry/transform.ts';

/**
 * 放置吸附：把"在墙上点一下"翻译成"柜体背靠该墙面且与之平行"。
 *
 * 为什么值得单独做一个纯函数：
 *   用户点墙时的真实意图几乎总是"贴着这面墙放"，而不是"以这个像素点为背左角"。
 *   如果不做这一步，每个柜子都要手动调 x/y/rotation —— 那正是本项目想消灭的体验。
 *
 * 输出的是语义结果（位置 + 旋转角），最终仍然由 CommandBus 写进 placement。
 */

export interface PlacementResult {
  x: number;
  y: number;
  rotation: number;
  /** 吸附到了哪面墙（null 表示没有吸附，按原始点放置） */
  wallId: string | null;
  wallName: string;
  /** 到该墙中心线的距离（mm） */
  distance: number;
}

const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/**
 * @param p 点击处的世界坐标（背左角意图点）
 * @param width 柜体宽（用于沿墙居中）
 * @param tolerance 超出该距离就不吸附（mm）
 */
export function placeAgainstNearestWall(
  project: Project,
  p: Vec2,
  width: number,
  tolerance = 600
): PlacementResult {
  let best: { wallId: string; name: string; thickness: number; start: Vec2; end: Vec2; t: number; dist: number } | null = null;

  for (const room of project.rooms) {
    for (const w of room.walls) {
      const dx = w.end.x - w.start.x;
      const dy = w.end.y - w.start.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;
      const t = Math.max(0, Math.min(1, projectParamOnSegment(p, w.start, w.end)));
      const foot = { x: w.start.x + t * dx, y: w.start.y + t * dy };
      const dist = Math.hypot(p.x - foot.x, p.y - foot.y);
      if (dist > tolerance) continue;
      if (!best || dist < best.dist) {
        best = { wallId: w.id, name: w.name, thickness: w.thickness, start: w.start, end: w.end, t, dist };
      }
    }
  }

  if (!best) {
    return { x: Math.round(p.x), y: Math.round(p.y), rotation: 0, wallId: null, wallName: '', distance: Infinity };
  }

  const dx = best.end.x - best.start.x;
  const dy = best.end.y - best.start.y;
  const len = Math.hypot(dx, dy);
  const u: Vec2 = { x: dx / len, y: dy / len };
  const perp: Vec2 = { x: -u.y, y: u.x };

  const foot = { x: best.start.x + best.t * dx, y: best.start.y + best.t * dy };
  const side = dot({ x: p.x - foot.x, y: p.y - foot.y }, perp) >= 0 ? 1 : -1;

  // 让局部 +Y（背→前）指向点击所在那一侧，柜体就"贴在这面墙上朝外"
  const ay: Vec2 = { x: perp.x * side, y: perp.y * side };
  const rotation = normalizeDeg((Math.atan2(ay.y, ay.x) * 180) / Math.PI - 90);
  const ax: Vec2 = { x: u.x * side, y: u.y * side };

  const face = { x: foot.x + perp.x * side * (best.thickness / 2), y: foot.y + perp.y * side * (best.thickness / 2) };
  const origin = { x: face.x - ax.x * (width / 2), y: face.y - ax.y * (width / 2) };

  return {
    x: Math.round(origin.x),
    y: Math.round(origin.y),
    rotation: Math.round(rotation),
    wallId: best.wallId,
    wallName: best.name,
    distance: Math.round(best.dist),
  };
}

function normalizeDeg(d: number): number {
  let v = Math.round(d) % 360;
  if (v <= -180) v += 360;
  if (v > 180) v -= 360;
  return v;
}

// ═══════════════════════════════════════════════════════════════════════════
//  自动落点：给一个"没有指定位置"的新柜体找一串可试的贴墙位置
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 为什么需要它（一次真缺陷）：
 *
 * 「方案对比」的候选柜体在**对比阶段是没有位置的** —— 正面图里没有进深，
 * 也不需要落点，所以候选一律建在 (0,0)。但一旦采用进项目，
 * 默认项目里 `cab_001` 就在 (400,60)、南墙内表面也在 y=60，
 * 于是 (0,0) **既扎进墙里、又和已有柜体重叠** —— 采用必定被记忆门拦下。
 * 用户在界面上看到的是一句"被记忆拦住"，而第一次点「采用这个方案」就失败了。
 *
 * 这类缺陷在 Node 验收里**看不见**：候选是孤立校验的，不参与项目级干涉检查。
 * 只有真的点一次才会暴露 —— 所以落点必须由**项目级**的判据来挑。
 */
export interface Spot {
  x: number;
  y: number;
  rotation: number;
  wallId: string | null;
  wallName: string;
}

/** 墙按长度从长到短试：长墙放得下的机会最大 */
const SLIDE = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88, 0.05, 0.95];

/**
 * 沿房间的每一面墙给出一串落点：贴墙、朝房间内、沿墙从中间向两端滑。
 *
 * 只负责"生成候选"，**不负责判断放不放得下** —— 那个判据只有一份（校验器），
 * 在这里再写一遍 AABB 就是第二份真相源，两边迟早算出不一样的答案。
 * 调用方拿这串落点逐个去试算（见 variants.ts 的 placeVariant）。
 */
export function candidateSpots(project: Project, roomId: string, width: number): Spot[] {
  const room = project.rooms.find((r) => r.id === roomId) ?? project.rooms[0];
  if (!room || room.walls.length === 0) return [];

  // 房间"内部"的方向：用墙端点平均求一个大致在房间里的点，只对矩形房间精确，
  // 但对任意多边形也足够稳定地指出"哪一侧是屋里"。
  let cx = 0;
  let cy = 0;
  let n = 0;
  for (const w of room.walls) {
    cx += w.start.x + w.end.x;
    cy += w.start.y + w.end.y;
    n += 2;
  }
  if (n === 0) return [];
  const inside = { x: cx / n, y: cy / n };

  const walls = room.walls
    .map((w) => ({ w, len: Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y) }))
    .filter((e) => e.len > 0)
    .sort((a, b) => b.len - a.len);

  const out: Spot[] = [];
  for (const { w, len } of walls) {
    if (len < width * 0.5) continue; // 明显放不下的墙直接跳过（判据仍以试算为准）
    for (const t of SLIDE) {
      const foot = { x: w.start.x + (w.end.x - w.start.x) * t, y: w.start.y + (w.end.y - w.start.y) * t };
      // 把种子点从墙中心线往屋里推一点，placeAgainstNearestWall 才会挑中这面墙、且朝屋里
      const toIn = { x: inside.x - foot.x, y: inside.y - foot.y };
      const lenIn = Math.hypot(toIn.x, toIn.y) || 1;
      const push = w.thickness / 2 + 30;
      const seed = { x: foot.x + (toIn.x / lenIn) * push, y: foot.y + (toIn.y / lenIn) * push };
      const r = placeAgainstNearestWall(project, seed, width);
      out.push({ x: r.x, y: r.y, rotation: r.rotation, wallId: r.wallId, wallName: r.wallName });
    }
  }
  return out;
}
