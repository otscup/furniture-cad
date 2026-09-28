import type { Cabinet, Project, Vec2 } from './types.ts';
import { bboxOf, projectParamOnSegment } from './geometry/transform.ts';
import { getCabinetFootprint } from './geometry/generate.ts';
import { detectCollisions, wallPolygon } from './geometry/project.ts';

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

/**
 * 拼接候选：把新柜的某一个角锚到房间里**已有柜体**的角点，贴着它形成 L 或续接。
 *
 * ── 这条是"拼接操作"能不能成立的关键 ──
 *   没给 atX / atY（让系统自己找落位）时，早先只从「贴墙候选」里挑，
 *   于是两条互相垂直的臂会各自贴一面墙、中间留一道缝 —— 用户要的是拐弯成 L，
 *   拿到的是两个互不相连的柜子。这里补上"贴着已有柜体"的候选：
 *   新柜落位优先与已有的柜体共用角点，两段才真的拼到一起。
 *
 * ── 判据仍然只有一份（校验器）──
 *   生成的候选逐个丢进 `detectCollisions`，撞墙（RULE-CABINET-IN-WALL）
 *   或撞柜（RULE-CABINET-OVERLAP）一律不要。沿用 `pickFreeSpot` 同款过滤，
 *   不在这里再写一遍"是否相接"的判定 —— 那是第二份真相源，本项目不允许。
 *
 * ── 锚点偏移按 rotation 取 ──
 *   柜体 footprint 随 rotation 不同：0° 宽沿 +x、深沿 +y；90° 宽沿 +y、深沿 −x；
 *   其余类推。4 个锚点（左上/右上/左下/右下）相对原点的偏移由此推出，
 *   把某个锚点放到已有柜体的某个角上，就得到一种拼接摆法。碰撞校验会筛掉
 *   那些其实压进旧柜里的摆法，只留真正"贴边相接"的。
 */
export function joinSpots(project: Project, cab: Cabinet): Spot[] {
  const room = project.rooms.find((r) => r.id === cab.roomId);
  if (!room) return [];
  const others = project.cabinets.filter((c) => c.id !== cab.id && c.roomId === room.id);
  if (others.length === 0) return [];
  const W = cab.params.width;
  const D = cab.params.depth;
  const rot = ((Math.round(cab.placement.rotation) % 360) + 360) % 360;
  const anchors: Array<[number, number]> =
    rot === 0
      ? [[0, 0], [W, 0], [0, D], [W, D]]
      : rot === 90
        ? [[-D, 0], [0, 0], [-D, W], [0, W]]
        : rot === 180
          ? [[-W, -D], [0, -D], [-W, 0], [0, 0]]
          : [[0, -W], [D, -W], [0, 0], [D, 0]];
  const out: Spot[] = [];
  for (const c of others) {
    const cb = bboxOf(getCabinetFootprint(c));
    const corners: Array<[number, number]> = [
      [cb.min.x, cb.min.y],
      [cb.max.x, cb.min.y],
      [cb.min.x, cb.max.y],
      [cb.max.x, cb.max.y],
    ];
    for (const [px, py] of corners) {
      for (const [ax, ay] of anchors) {
        const ox = px - ax;
        const oy = py - ay;
        const trial: Cabinet = { ...cab, placement: { x: ox, y: oy, rotation: rot } };
        const bad = detectCollisions({ ...project, cabinets: [...project.cabinets.filter((x) => x.id !== cab.id), trial] }).filter(
          (i) =>
            (i.code === 'RULE-CABINET-IN-WALL' || i.code === 'RULE-CABINET-OVERLAP') &&
            i.target.split(' / ').includes(trial.id)
        );
        if (bad.length === 0) out.push({ x: Math.round(ox), y: Math.round(oy), rotation: rot, wallId: null, wallName: '拼接' });
      }
    }
  }
  return out;
}

/**
 * 把柜体**沿最小位移方向**推出墙体，推到与墙面相切。
 *
 * ── 为什么必须有这个 ──
 *   AI 给 `atX / atY` 时，它手上没有墙的坐标，只能"照着房间名猜一个角点"。
 *   实测：房间2 的南墙中心线在 y=0、墙厚 120，模型给的 atY 就是 0 ——
 *   柜体正好扎进墙里 60mm，记忆门 mem_002 当场拒收，整份计划一条不执行。
 *   用户看到的就是"AI 说什么都建不出来"，而错的是**我们让 AI 去猜坐标**。
 *
 * ── 判据仍然只有一份 ──
 *   本函数只**提议**位移方向（用 bbox 算出"往哪个方向挪多少才能分开"），
 *   挪完之后到底算不算干涉，一律交回 `detectCollisions` 复核。
 *   在这里再写一遍"是否相切"的判定就是第二份真相源，本项目不允许。
 *
 * ── 为什么取"最小位移"而不是"沿墙法线" ──
 *   最小位移 = 对 AI 意图改动最小的那一种改法。它保证"AI 想放哪就尽量还在哪"，
 *   同时满足"贴墙相切即可，不必退开更多"。多面墙时逐面推，最多推 MAX_PUSH 轮。
 *
 * @returns 修正后的落位；推不出来（例如房间本身比柜子小）返回 null
 */
export function nudgeOutOfWalls(project: Project, cab: Cabinet): { x: number; y: number } | null {
  const MAX_PUSH = 8;
  let x = cab.placement.x;
  let y = cab.placement.y;

  for (let round = 0; round < MAX_PUSH; round++) {
    const probe: Cabinet = { ...cab, placement: { ...cab.placement, x, y } };
    const hit = detectCollisions({ ...project, cabinets: [...project.cabinets.filter((c) => c.id !== cab.id), probe] }).filter(
      (i) => i.code === 'RULE-CABINET-IN-WALL' && i.target.split(' / ').includes(probe.id)
    );
    if (hit.length === 0) return { x: Math.round(x), y: Math.round(y) };

    const cb = bboxOf(getCabinetFootprint(probe));
    // 在所有"能让它与某面墙分开"的平移里挑绝对值最小的那个 —— 改动最小的修法
    let best: { dx: number; dy: number; cost: number } | null = null;
    for (const room of project.rooms) {
      for (const w of room.walls) {
        const poly = wallPolygon(w);
        if (poly.length === 0) continue;
        const wb = bboxOf(poly);
        if (!(cb.min.x < wb.max.x && cb.max.x > wb.min.x && cb.min.y < wb.max.y && cb.max.y > wb.min.y)) continue;
        const cands = [
          { dx: wb.max.x - cb.min.x, dy: 0 }, // 往 +X 推出墙的右/上边界
          { dx: wb.min.x - cb.max.x, dy: 0 }, // 往 -X
          { dx: 0, dy: wb.max.y - cb.min.y }, // 往 +Y
          { dx: 0, dy: wb.min.y - cb.max.y }, // 往 -Y
        ];
        for (const c of cands) {
          const cost = Math.abs(c.dx) + Math.abs(c.dy);
          if (cost <= 0) continue;
          if (!best || cost < best.cost) best = { dx: c.dx, dy: c.dy, cost };
        }
      }
    }
    if (!best) return null;
    x += best.dx;
    y += best.dy;
  }
  return null;
}
