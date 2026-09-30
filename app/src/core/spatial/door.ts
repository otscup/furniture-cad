import type { Cabinet, DoorHinge, DoorSwingDirection, Opening, Project, Vec2, Wall } from '../types.ts';
import { getCabinetFootprint } from '../geometry/generate.ts';
import {
  SPATIAL_TOL,
  openingRect,
  polyDistance,
  polysOverlapInterior,
  roomLoop,
  wallNormalUnit,
} from './model.ts';
import { wallInteriorSide } from './derive.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  门扇开启语义（P8.9）—— 确定性派生，全是只读事实
 *
 *      Door Opening ─→ 门扇（铰链 + 净宽 + 室内外方向）─→ 90° 开启扇区
 *                                                          │
 *                                            柜体 footprint ∩ 扇区 ─→ clear/touch/overlap
 *
 *  ── 这一层回答的问题 ──
 *    「这个柜子虽然没有挡住门洞，但门打开以后会不会撞柜？」
 *    P8.7 的洞口影响带（OPENING_ZONE = 600mm 通行带）回答的是"门口有没有被占住"，
 *    那是**人流通道**；这里是**门扇真正扫过的面积**。两者是不同概念，
 *    所以各用各的阈值，绝不复用同一个数（§十七）。
 *
 *  ── 四条纪律 ──
 *    ① **不写回模型**：包络 / 门扇 / 半径 / 面积全是派生；authored 只有
 *       `Opening.hinge` 与 `Opening.swingDirection` 两个字段（可为缺省 = 未指定）。
 *    ② **没有三角函数**：90° 扇形的弧用**向量加法二分**取角平分线
 *       （`normalize(a + b)` 就是角平分线方向），弧上每个点都是确定性的。
 *       门扇的关闭/开启两个方向直接来自墙的自身方向与墙法线，
 *       而"墙法线 ⊥ 墙方向"是构造性的恒等关系 —— 无需再算任何角度。
 *    ③ **判不出来就说判不出来**：没指定铰链/方向、房间不成回路、
 *       墙退化、洞口 span 非法 —— 一律 `unknown`，**绝不默认向内开**，
 *       也绝不从柜体位置反推开门方向（§十一）。
 *    ④ **不做**：门开启动画、3D 门扇、任意角度（45°/120°）、人流模拟。
 *       本阶段只有一种开启：**标准 90°**（角度是规则，不是 authored 几何）。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 门扇开启的固定规则参数（**不是** authored 几何：角度由规则定，不由用户存） */
export const DOOR_SWING = {
  /** 本阶段只支持标准开启：关闭 → 90° */
  OPEN_ANGLE_DEG: 90,
  /**
   * 扇区弧的折线段数。8 段 = 每 11.25° 一段（2 的幂，二分法天然对齐）。
   * 折线是**内接近似**：最大内缩 = r·(1 − cos(5.625°)) ≈ 0.48% 半径
   * （900mm 门 ≈ 4.3mm）。这个量级远小于任何设计判断的分辨力，
   * 但报告与文档必须如实说明它是近似，不许假装是精确圆弧。
   */
  ARC_SEGMENTS: 8,
} as const;

export type DoorSwingUnknownReason =
  /** 用户没指定铰链或没指定开启方向（"没说"≠"默认向内开"） */
  | 'no-swing'
  /** 房间的墙没连成闭合回路 → 判不出哪一侧是室内 */
  | 'open-room'
  /** 墙退化（零长），画不出墙几何 */
  | 'bad-wall'
  /** 洞口 span 不在墙内（offset/width 非法） */
  | 'bad-span';

/** 门扇 90° 开启覆盖的扇区（世界坐标；全部派生） */
export interface DoorSwingEnvelope {
  /** 铰链点：位于**开启侧**的墙面上，门扇绕它旋转 */
  hinge: Vec2;
  /** 门扇宽度 = 洞口净宽（半径） */
  radius: number;
  /** 关闭位置时门扇自由端 */
  closedTip: Vec2;
  /** 开启 90° 后门扇自由端 */
  openTip: Vec2;
  /** 扇区多边形：[铰链, 弧上折线点…]（隐式闭合回铰链）；内接近似见 ARC_SEGMENTS */
  poly: Vec2[];
  arcSegments: number;
}

/** 一扇门的开启语义事实（authored 输入原样透传 + 派生包络） */
export interface DoorSwingFact {
  openingId: string;
  wallId: string;
  roomId: string;
  hinge?: DoorHinge;
  direction?: DoorSwingDirection;
  /** 'unknown' = 判不出开启区域（原因见 unknownReason），此时没有 envelope */
  status: 'ok' | 'unknown';
  unknownReason?: DoorSwingUnknownReason;
  envelope?: DoorSwingEnvelope;
}

/**
 * 柜体 ↔ 某一扇门开启扇区的净空判定。
 *   `clear`   = 与扇区不相交（distance 给出实测最近距离）
 *   `touch`   = 只贴到扇区边界（≤ SPATIAL_TOL.TOUCH，与"贴着"同一把尺子）
 *   `overlap` = 与扇区**内部**有重叠（门扇一定撞上它）
 *   `unknown` = 柜体几何为空，判不出
 */
export type DoorClearanceStatus = 'clear' | 'touch' | 'overlap' | 'unknown';

export interface DoorClearanceFact {
  openingId: string;
  wallId: string;
  cabinetId: string;
  status: DoorClearanceStatus;
  /** 柜体离扇区多近（mm，四舍五入）；overlap 时为 0 */
  distance?: number;
  /**
   * 柜体离**铰链**最近多少 mm（只在 overlap 时有意义）。
   * 它说明"门扇转到这个角度时，叶片从铰链算起有 (radius − hitRadius) 那么长会打在柜上"。
   */
  hitRadius?: number;
  /**
   * 柜体从**洞口所在墙面**朝开启侧探出多少 mm（只在 overlap 时有意义）。
   *
   * 为什么报这个数而不是只报"撞了"：门扇与柜体的碰撞面就发生在"探出墙面"的那一段上
   * —— 探出 600mm、门扇半径 900mm，用户一眼就能判断"这柜子确实把门挡住了多少"。
   * 它沿开启方向（扇区的中轴）量，与柜体是否旋转无关。
   */
  intrusion?: number;
}

export interface DoorSwingDerivation {
  doors: DoorSwingFact[];
  clearances: DoorClearanceFact[];
}

// ─────────────────────────── 几何原语（无三角函数） ───────────────────────────

const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
const neg = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y });

/** 单位化（只用到 hypot，不是三角函数） */
function unit(v: Vec2): Vec2 {
  const l = Math.hypot(v.x, v.y);
  return l === 0 ? { x: 0, y: 0 } : { x: v.x / l, y: v.y / l };
}

/**
 * 把两个单位方向之间的弧用**二分角平分线**细分出 n 段（n 必须是 2 的幂）。
 *
 * 为什么这样做而不是 cos/sin 采样：`normalize(a + b)` 就是 a 与 b 的角平分线
 * —— 连续二分就能得到 45° / 22.5° / 11.25°… 上任意精度的方向，
 * 全程只有向量加法与 hypot。空间层的红线是"不实现第二套旋转数学"，
 * 这里连旋转都没用到：门扇的两个边界方向直接来自墙方向与墙法线。
 */
export function subdivideArc(from: Vec2, to: Vec2, segments: number): Vec2[] {
  let dirs: Vec2[] = [from, to];
  while (dirs.length - 1 < segments) {
    const next: Vec2[] = [dirs[0]!];
    for (let i = 0; i < dirs.length - 1; i++) {
      next.push(unit(add(dirs[i]!, dirs[i + 1]!)), dirs[i + 1]!);
    }
    dirs = next;
  }
  return dirs;
}

/**
 * 求一扇门 90° 开启时覆盖的扇区。
 *
 * @param side 室内侧：+1 = 墙法线正向朝室内；-1 = 反向；null = 判不出（房间不闭合/墙退化）
 * @returns status 'unknown' 时给出原因码，调用方据此保持沉默（不猜方向）
 */
export function doorEnvelopeOf(
  wall: Wall,
  opening: Opening,
  side: 1 | -1 | null
): { status: 'ok'; envelope: DoorSwingEnvelope } | { status: 'unknown'; reason: DoorSwingUnknownReason } {
  // ① 未指定：authored 意图缺失 ⇒ 判不出。**绝不默认向内开**。
  if (opening.kind !== 'door' || !opening.hinge || !opening.swingDirection) return { status: 'unknown', reason: 'no-swing' };

  // ② 洞口必须真的落在墙上（否则"洞口在哪"本身就是问题，先由 SPATIAL-OPENING-SPAN 报）
  const span = openingRect(wall, opening);
  if (span.status === 'badwall') return { status: 'unknown', reason: 'bad-wall' };
  if (span.status === 'badspan') return { status: 'unknown', reason: 'bad-span' };

  // ③ 室内侧判不出来（墙没连成闭合回路）⇒ 判不出往哪边开
  if (side === null) return { status: 'unknown', reason: 'open-room' };

  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  const n = wallNormalUnit(wall);
  if (len === 0 || !n) return { status: 'unknown', reason: 'bad-wall' };

  const u: Vec2 = { x: dx / len, y: dy / len }; // 沿墙 start→end
  const nRoom: Vec2 = { x: n.x * side, y: n.y * side }; // 墙法线，指向**室内**
  const m = opening.swingDirection === 'into-room' ? nRoom : neg(nRoom); // 门扇往哪一侧扫

  // ④ 铰链点：门垛位置（沿墙量）+ 开启侧的墙面（墙厚一半）
  const along = opening.hinge === 'start' ? opening.offset : opening.offset + opening.width;
  const jamb: Vec2 = { x: wall.start.x + u.x * along, y: wall.start.y + u.y * along };
  const hinge = add(jamb, scale(m, wall.thickness / 2));

  // ⑤ 关闭位置：门扇躺平在墙里，从铰链指向另一侧门垛
  const closedDir = opening.hinge === 'start' ? u : neg(u);
  const radius = opening.width;
  const arcDirs = subdivideArc(closedDir, m, DOOR_SWING.ARC_SEGMENTS);

  return {
    status: 'ok',
    envelope: {
      hinge,
      radius,
      closedTip: add(hinge, scale(closedDir, radius)),
      openTip: add(hinge, scale(m, radius)),
      poly: [hinge, ...arcDirs.map((d) => add(hinge, scale(d, radius)))],
      arcSegments: DOOR_SWING.ARC_SEGMENTS,
    },
  };
}

/**
 * 柜体 ↔ 门扇扇区的净空判定。
 *
 * 判定口径与 P8.7 的柜↔墙完全一致（同一把尺子）：
 *   **内部重叠**才算撞上（`polysOverlapInterior`），贴边接触（面积 0）算 `touch`，
 *   两者之间按 SPATIAL_TOL.TOUCH 分段 —— 本函数**不许自己写 epsilon**。
 */
export function classifyDoorClearance(
  cab: Cabinet,
  openingId: string,
  wallId: string,
  envelope: DoorSwingEnvelope
): DoorClearanceFact {
  const fp = getCabinetFootprint(cab);
  if (fp.length === 0) return { openingId, wallId, cabinetId: cab.id, status: 'unknown' };
  if (polysOverlapInterior(fp, envelope.poly)) {
    // 探出墙面多少：沿开启方向（中轴 m）量柜体各角到"过铰链的墙面"的最大距离
    const m = unit({ x: envelope.openTip.x - envelope.hinge.x, y: envelope.openTip.y - envelope.hinge.y });
    let intrusion = 0;
    for (const v of fp) intrusion = Math.max(intrusion, (v.x - envelope.hinge.x) * m.x + (v.y - envelope.hinge.y) * m.y);
    return {
      openingId,
      wallId,
      cabinetId: cab.id,
      status: 'overlap',
      distance: 0,
      hitRadius: Math.round(polyDistance([envelope.hinge], fp)),
      intrusion: Math.round(intrusion),
    };
  }
  const distance = Math.round(polyDistance(fp, envelope.poly));
  return {
    openingId,
    wallId,
    cabinetId: cab.id,
    status: distance <= SPATIAL_TOL.TOUCH ? 'touch' : 'clear',
    distance,
  };
}

/**
 * 派生整个项目的门扇开启事实与柜体净空判定（纯函数，只读）。
 *
 * 覆盖**所有** kind='door' 的洞口（没指定开启语义的也算一条 unknown 事实 ——
 * "用户还没说"本身是事实，界面要照实显示"未指定"，而不是假装没这回事）。
 * 柜体对所有已判出扇区的门逐扇判定，**不限房间**：朝外开时扇区正落在隔壁空间里，
 * 只在自己房间里找柜反而会漏掉真正会撞上的那一只。
 */
export function deriveDoorSwing(project: Project): DoorSwingDerivation {
  const doors: DoorSwingFact[] = [];
  const clearances: DoorClearanceFact[] = [];
  const loopByRoom = new Map<string, ReturnType<typeof roomLoop>>();
  for (const r of project.rooms) loopByRoom.set(r.id, roomLoop(r.walls));

  for (const room of project.rooms) {
    const loop = loopByRoom.get(room.id);
    const loopOk = loop?.status === 'ok';
    for (const wall of room.walls) {
      for (const opening of wall.openings ?? []) {
        if (opening.kind !== 'door') continue;
        const side = loopOk ? wallInteriorSide(loop!.poly, wall) : null;
        const r = doorEnvelopeOf(wall, opening, side);
        doors.push({
          openingId: opening.id,
          wallId: wall.id,
          roomId: room.id,
          ...(opening.hinge ? { hinge: opening.hinge } : {}),
          ...(opening.swingDirection ? { direction: opening.swingDirection } : {}),
          status: r.status,
          ...(r.status === 'ok' ? { envelope: r.envelope } : { unknownReason: r.reason }),
        });
        if (r.status !== 'ok') continue;
        for (const cab of project.cabinets) {
          clearances.push(classifyDoorClearance(cab, opening.id, wall.id, r.envelope));
        }
      }
    }
  }
  return { doors, clearances };
}

/** 某扇门的开启事实（找不到就 null —— 洞口可能已被删除） */
export function doorFactOf(doors: DoorSwingFact[], openingId: string): DoorSwingFact | null {
  return doors.find((d) => d.openingId === openingId) ?? null;
}

/** 某面墙上的门开启事实（界面按墙渲染用） */
export function doorFactsOfWall(doors: DoorSwingFact[], wallId: string): DoorSwingFact[] {
  return doors.filter((d) => d.wallId === wallId);
}

/** 某扇门的柜体净空（界面按门渲染用） */
export function clearancesOfDoor(clearances: DoorClearanceFact[], openingId: string): DoorClearanceFact[] {
  return clearances.filter((c) => c.openingId === openingId);
}

/** 未知原因的人话（报告 / 界面共用一处，UI 不许自己翻译） */
export const DOOR_UNKNOWN_ZH: Record<DoorSwingUnknownReason, string> = {
  'no-swing': '门还没指定铰链/开启方向 —— 判不出开启范围（不猜方向）',
  'open-room': '房间的墙没连成闭合回路，判不出哪一侧是室内',
  'bad-wall': '墙退化（零长），画不出开启范围',
  'bad-span': '洞口的 offset/width 不在墙内，先把它改合法',
};

/** 铰链侧的人话（起点/终点是**墙自身**的定义，不是屏幕上的左右） */
export const DOOR_HINGE_ZH: Record<DoorHinge, string> = { start: '起点侧', end: '终点侧' };

/** 开启朝向的人话 */
export const DOOR_DIRECTION_ZH: Record<DoorSwingDirection, string> = {
  'into-room': '室内',
  'out-of-room': '室外',
};
