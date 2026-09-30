import type { DoorHinge, DoorSwingDirection, OpeningKind, Project } from '../core/types.ts';
import { bboxOf } from '../core/geometry/transform.ts';
import {
  deriveSpatial,
  roomLoop,
  type CabOpeningRelation,
  type CabRoomRelation,
  type CabWallRelation,
  type DoorClearanceFact,
  type DoorSwingFact,
  type DoorSwingUnknownReason,
  type RoomLoopStatus,
  type SpatialFacts,
} from '../core/spatial/index.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  空间上下文（P9.1）—— 发给 AI 的**只读派生块**
 *
 *  ── 它解决的是什么问题 ──
 *    P9.0 审查的阻塞级缺口 R1：`AiSnapshot.rooms` 只有 `{index,id,name,wallCount}`，
 *    也就是 **AI 在完全看不见房间的情况下被要求做室内设计** ——
 *    它不知道这柜贴着哪面墙、房间多大、门往哪边开、洞口有多宽。
 *    补上这块之后，AI 才算"看得见空间"。
 *
 *  ── 三条纪律（与 P9.0 §11.3 对 P9.1 的要求逐条对应）──
 *
 *    ① **纯投影，不新增判定**。
 *       本文件**没有一条自己的几何判定**：房间闭合与否来自 `roomLoop`，
 *       柜↔房间 / 柜↔墙 / 柜↔洞口来自 `deriveSpatial().facts`，
 *       门扇语义与净空来自同一份 `deriveSpatial()` 的 `doors`/`clearances`。
 *       本文件只做"读出来 + 换个形状摆好" —— 一个 `if` 都不判"算不算贴着"。
 *       （唯一的算术是长度/包围范围的标量化，以及 `|dx|`/`|dy|` 比较判走向。）
 *
 *    ② **派生事实与 authored 明确分开**。
 *       它是一块**独立的顶层块**（`AiSnapshot.spatialContext`），不混进 rooms/cabinets。
 *       块内 `readOnly: true` 显式声明"这是给你看的，不是给你改的"。
 *       其中 authored 的投影（房间名 / 墙名 / 洞口尺寸 / 门扇开启意图）只是**照抄**，
 *       不存在第二份真相 —— 它们本来就住在模型里。
 *
 *    ③ **零坐标**。
 *       不出现任何 `{x,y}`、任何长度为 2/6 的数字数组、任何 polygon 字段。
 *       墙只给 `length` 与 `axis`（走向），房间只给 `extent`（包围范围的两个标量），
 *       门扇只给"判得出 / 判不出"与原因码，**绝不给包络多边形**。
 *       坐标仍然只属于 Geometry Truth；AI 仍然不许输出坐标（契约里的形状门照旧拦）。
 *
 *  ── 为什么不投影规则码与文案 ──
 *    `deriveSpatial().issues` 里的文案与码是"问题列表"，是明确规定不给 AI 的一类
 *    （`buildSystemPrompt` 第 4 条）。本块把事实枚举翻成**闭集 concern 词**
 *    （`crossing-wall` / `blocks-opening` / …）：AI 因此知道"哪里不对劲"，
 *    却学不到一套可以拿去复述或当参数用的规则词汇。
 *
 *  ── 不做 ──
 *    不做人流模拟、不做候选布局、不做评分、不接 LLM、不改模型、不产几何/DXF/BOM。
 *    unknown 一律**保持 unknown**（门没指定开启语义就是 `status:'unknown'`，不猜方向）。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 墙的走向（由端点差派生：`|dx|` 与 `|dy|` 的比较，无三角函数） */
export type AiWallAxis =
  /** 沿 X 轴（两端 y 相同） */
  | 'horizontal'
  /** 沿 Y 轴（两端 x 相同） */
  | 'vertical'
  /** 斜墙（两端 x、y 都不同） */
  | 'diagonal'
  /**
   * 零长墙（两端重合）—— **没有方向可言**。
   * 为什么不让它落进 `horizontal`：那是在报一个不存在的方向。
   * 这种墙由 `SPATIAL-WALL-ZERO` 报错，快照里如实标 degenerate，不编一个走向出来。
   */
  | 'degenerate';

/** 门扇开启语义（已确认的部分 + 系统判得出的部分；缺省 = 用户还没说） */
export interface AiOpeningSwing {
  status: 'ok' | 'unknown';
  /** 铰链侧（`start`/`end` 是**墙自身**的定义，不是屏幕左右）；未指定则缺省 */
  hinge?: DoorHinge;
  /** 开启朝向；未指定则缺省 */
  direction?: DoorSwingDirection;
  /** 仅 status='unknown'：为什么判不出（no-swing / open-room / bad-wall / bad-span） */
  unknownReason?: DoorSwingUnknownReason;
}

export interface AiSpatialRoom {
  id: string;
  name: string;
  /** 边界（墙中心线回路）能不能连成一个闭合环 —— 不闭合时一切"屋内/屋外"结论都不可信 */
  boundary: {
    closed: boolean;
    /** 回路走法的结果：ok / empty / open / dup / branch / selfx */
    status: RoomLoopStatus;
    wallCount: number;
    /** 回路顶点数（= 边数）；不闭合时为 0 */
    cornerCount: number;
  };
  /**
   * 闭合回路的**包围范围**（mm 整数，X 向 × Y 向）。
   * ⚠ 它是外接矩形的两个标量，**不是面积**，非矩形房间下也只是"占地范围"；
   *   项目里没有确定性面积实现，所以这里如实只给范围，不给面积（不新造一个派生量）。
   *   边界不闭合或顶点不足 3 时**不出现这个键**（判不出就不编一个出来）。
   */
  extent?: { width: number; depth: number };
}

export interface AiSpatialWall {
  id: string;
  /** 所属房间（墙挂在房间下，归属由结构本身回答） */
  roomId: string;
  /** 墙名（authored 投影；默认项目里就是"主卧南墙"这类人话） */
  name: string;
  /** 墙中心线长度（mm 整数） */
  length: number;
  /** 走向（派生） */
  axis: AiWallAxis;
  /** 这面墙上有几个洞口（0 = 实墙） */
  openingCount: number;
}

export interface AiSpatialOpening {
  id: string;
  wallId: string;
  roomId: string;
  kind: OpeningKind;
  /** 洞口显示名（authored，可选；缺省时人话由界面/规则层按 kind 给） */
  name?: string;
  /** 沿墙中心线从墙起点到洞口起点边缘的距离（mm） */
  offset: number;
  /** 洞口净宽（mm） */
  width: number;
  /** 仅门洞：开启语义。缺省（窗洞）时没有这个键 */
  swing?: AiOpeningSwing;
}

/** 柜 ↔ 墙的关系（只在确有关系时列出；gap 是与墙矩形的实测最近距离 mm） */
export interface AiWallContact {
  wallId: string;
  relation: CabWallRelation;
  gap: number;
}

/** 柜 ↔ 洞口的关系（只在不是 clear 时列出 —— 列出来的都是有事的） */
export interface AiOpeningProximity {
  openingId: string;
  kind: OpeningKind;
  relation: CabOpeningRelation;
}

/** 柜 ↔ 门扇开启扇区的净空（只在 overlap / touch 时列出） */
export interface AiDoorClearance {
  openingId: string;
  status: 'overlap' | 'touch';
  /** overlap 时：柜体从洞口所在墙面朝开启侧探出多少 mm（门扇真正撞上的就是这一段） */
  intrusion?: number;
}

/**
 * 设计关切（闭集 token）。
 * 每个 token 都是**事实枚举的直接投影**，不是新的判定 —— 见 `concernsOf`。
 */
export type AiSpaceConcern =
  /** 房间边界没连成闭合回路 → 判不出屋内屋外 */
  | 'room-not-closed'
  /** 柜体整体落在房间边界之外 */
  | 'outside-room'
  /** 柜体压着房间边界（一部分在里、一部分在外） */
  | 'crossing-room'
  /** 柜体与墙体重叠（穿墙） */
  | 'crossing-wall'
  /** 柜体贴着墙（常态，不是问题） */
  | 'touching-wall'
  /** 柜体离墙有缝（≤ NEAR） */
  | 'near-wall'
  /** 柜体确实在房间内、房间也确实有墙，但它与任何墙都不在 NEAR 之内（悬空） */
  | 'floating'
  /** 柜体占住了洞口本体 + 室内侧通行带 */
  | 'blocks-opening'
  /** 柜体落在门扇 90° 开启扫过的扇区里 */
  | 'in-door-swing'
  /** 本房间有门、但开启语义未指定或判不出 → **没有**任何净空结论（不是"已确认没问题"） */
  | 'door-swing-unknown';

export interface AiSpatialCabinet {
  cabinetId: string;
  name: string;
  roomId: string;
  /** 相对本房间闭合边界的位置（unknown = 边界不成回路，判不出就说判不出） */
  roomRelation: CabRoomRelation;
  /** 只在有关系时列出；空数组 = NEAR（50mm）内没有任何一面墙 */
  wallContacts: AiWallContact[];
  /** 只在不是 clear 时列出；空数组 = 与任何洞口都不相干 */
  openingProximity: AiOpeningProximity[];
  /** 只在 overlap / touch 时列出；空数组 = 没有一扇已判出的门会碰到它 */
  doorClearances: AiDoorClearance[];
  /** 上面的关系汇总成"设计关切"（闭集 token，顺序稳定） */
  concerns: AiSpaceConcern[];
}

export interface AiSpatialContext {
  /** 显式声明：这一块是**只读事实**，不是可以被动作改写的对象 */
  readOnly: true;
  rooms: AiSpatialRoom[];
  walls: AiSpatialWall[];
  openings: AiSpatialOpening[];
  cabinetFacts: AiSpatialCabinet[];
}

/** 走向：两端重合 = 零长（无方向）；两端 y 相同 = 沿 X；两端 x 相同 = 沿 Y；否则斜墙。纯比较，无三角函数 */
function axisOf(dx: number, dy: number): AiWallAxis {
  if (dx === 0 && dy === 0) return 'degenerate';
  if (dy === 0) return 'horizontal';
  if (dx === 0) return 'vertical';
  return 'diagonal';
}

const mm = (v: number): number => Math.round(v);

/**
 * 门扇语义 → 快照形状。
 *
 * ⚠ 只搬"判得出/判不出 + 铰链侧 + 朝向 + 原因码"，
 *   **绝不搬 envelope**（那是含坐标的多边形）。unknown 保持 unknown。
 */
function swingOf(door: DoorSwingFact | undefined): AiOpeningSwing {
  if (!door) return { status: 'unknown', unknownReason: 'no-swing' };
  return {
    status: door.status,
    ...(door.hinge ? { hinge: door.hinge } : {}),
    ...(door.direction ? { direction: door.direction } : {}),
    ...(door.status === 'unknown' ? { unknownReason: door.unknownReason ?? 'no-swing' } : {}),
  };
}

/**
 * 事实 → 设计关切（**直接投影，不新增判定**）。
 *
 * 每个分支只读一个已经算好的枚举值，没有任何新的几何/容差判断：
 *   · roomRelation            → room-not-closed / outside-room / crossing-room
 *   · wallContacts.relation   → crossing-wall / touching-wall / near-wall
 *   · 确实在屋里 + 确实有墙 + 一条墙关系都没有 → floating
 *   · openingProximity.relation → blocks-opening
 *   · doorClearances.status   → in-door-swing
 *   · 本房间存在判不出的门     → door-swing-unknown
 *
 * ⚠ floating 的门槛刻意**收紧**到 `roomRelation === 'inside'`：
 *   "这柜没靠任何一面墙"只有在"确实知道它在屋里"时才是一个成立的结论
 *   （P8.8 解释层用的是 `facts.rooms[].closed`，在"房间里全是零长墙"这种退化态下
 *   会与 room-not-closed 同时报出来；这里不复制那个边角，判不出就只说判不出）。
 */
function concernsOf(args: {
  roomRelation: CabRoomRelation;
  hasWalls: boolean;
  contacts: AiWallContact[];
  proximity: AiOpeningProximity[];
  clearances: AiDoorClearance[];
  roomHasUnknownDoor: boolean;
}): AiSpaceConcern[] {
  const out: AiSpaceConcern[] = [];
  if (args.roomRelation === 'unknown') out.push('room-not-closed');
  else if (args.roomRelation === 'outside') out.push('outside-room');
  else if (args.roomRelation === 'crossing') out.push('crossing-room');
  if (args.contacts.some((c) => c.relation === 'crossing')) out.push('crossing-wall');
  if (args.contacts.some((c) => c.relation === 'touching')) out.push('touching-wall');
  if (args.contacts.some((c) => c.relation === 'near')) out.push('near-wall');
  if (args.roomRelation === 'inside' && args.hasWalls && args.contacts.length === 0) out.push('floating');
  if (args.proximity.some((p) => p.relation === 'overlap')) out.push('blocks-opening');
  if (args.clearances.some((c) => c.status === 'overlap')) out.push('in-door-swing');
  if (args.roomHasUnknownDoor) out.push('door-swing-unknown');
  return out;
}

/**
 * 项目 → 空间上下文（纯函数：不改 project、不调 AI、不产几何、无随机无时钟）。
 *
 * 一切结论都来自**同一次** `deriveSpatial(project)`：
 *   facts（房间闭合 / 柜↔房间 / 柜↔墙 / 柜↔洞口）+ doors + clearances（门扇与净空）。
 * 外加 `roomLoop` 一次（房间回路顶点，用于 cornerCount 与包围范围）。
 */
export function buildSpatialContext(project: Project): AiSpatialContext {
  const report = deriveSpatial(project);
  const facts: SpatialFacts = report.facts;

  // ── 索引（只做搬运，不做判断） ──
  const doorsByOpening = new Map<string, DoorSwingFact>(report.doors.map((d) => [d.openingId, d]));
  const clearancesByCab = new Map<string, DoorClearanceFact[]>();
  for (const c of report.clearances) {
    const arr = clearancesByCab.get(c.cabinetId);
    if (arr) arr.push(c);
    else clearancesByCab.set(c.cabinetId, [c]);
  }
  /** 每个房间是否存在"判不出开启区域"的门（unknown 保持 unknown，且要让 AI 知道判不出） */
  const roomHasUnknownDoor = new Set<string>();
  for (const d of report.doors) {
    if (d.status === 'unknown') roomHasUnknownDoor.add(d.roomId);
  }

  // ── 房间 ──
  const rooms: AiSpatialRoom[] = project.rooms.map((r) => {
    // `roomLoop` 是房间边界的**唯一**口径（deriveSpatial 内部用的也是它，验收里断言两者一致）
    const loop = roomLoop(r.walls);
    const closed = loop.status === 'ok';
    // 顶点不足 3 个（例如整间房都是零长墙）时画不出范围 —— 不给 extent，不编一个出来
    const extent =
      closed && loop.poly.length >= 3
        ? (() => {
            const b = bboxOf(loop.poly);
            return { width: mm(b.max.x - b.min.x), depth: mm(b.max.y - b.min.y) };
          })()
        : undefined;
    return {
      id: r.id,
      name: r.name,
      boundary: {
        closed,
        status: loop.status,
        wallCount: r.walls.length,
        cornerCount: loop.poly.length,
      },
      ...(extent ? { extent } : {}),
    };
  });

  // ── 墙 ──
  const walls: AiSpatialWall[] = project.rooms.flatMap((r) =>
    r.walls.map((w) => ({
      id: w.id,
      roomId: r.id,
      name: w.name,
      length: mm(Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y)),
      axis: axisOf(w.end.x - w.start.x, w.end.y - w.start.y),
      openingCount: w.openings?.length ?? 0,
    }))
  );

  // ── 洞口 ──
  const openings: AiSpatialOpening[] = project.rooms.flatMap((r) =>
    r.walls.flatMap((w) =>
      (w.openings ?? []).map((o) => ({
        id: o.id,
        wallId: w.id,
        roomId: r.id,
        kind: o.kind,
        ...(o.name ? { name: o.name } : {}),
        offset: mm(o.offset),
        width: mm(o.width),
        // 只有门有"开启"这回事；窗洞带上门扇字段是非法数据（projectFile 已抹除 + 警告）
        ...(o.kind === 'door' ? { swing: swingOf(doorsByOpening.get(o.id)) } : {}),
      }))
    )
  );

  // ── 柜体的空间事实 ──
  const cabinetFacts: AiSpatialCabinet[] = project.cabinets.map((cab) => {
    const cf = facts.cabinets.find((c) => c.cabId === cab.id);
    const wallContacts: AiWallContact[] = (cf?.walls ?? []).map((wf) => ({
      wallId: wf.wallId,
      relation: wf.relation,
      gap: mm(wf.gap),
    }));
    const openingProximity: AiOpeningProximity[] = (cf?.openings ?? [])
      // 只列"有事的"：clear 是默认态，不列（列出来会让快照被无信息量的条目撑大）
      .filter((o) => o.relation !== 'clear')
      .map((o) => ({ openingId: o.openingId, kind: o.kind, relation: o.relation }));
    const doorClearances: AiDoorClearance[] = (clearancesByCab.get(cab.id) ?? [])
      .filter((c) => c.status === 'overlap' || c.status === 'touch')
      .map((c) => ({
        openingId: c.openingId,
        status: c.status === 'overlap' ? 'overlap' : 'touch',
        ...(c.intrusion !== undefined ? { intrusion: mm(c.intrusion) } : {}),
      }));
    const room = project.rooms.find((r) => r.id === cab.roomId);
    return {
      cabinetId: cab.id,
      name: cab.name,
      roomId: cab.roomId,
      roomRelation: cf?.room ?? 'unknown',
      wallContacts,
      openingProximity,
      doorClearances,
      concerns: concernsOf({
        roomRelation: cf?.room ?? 'unknown',
        hasWalls: (room?.walls.length ?? 0) > 0,
        contacts: wallContacts,
        proximity: openingProximity,
        clearances: doorClearances,
        roomHasUnknownDoor: roomHasUnknownDoor.has(cab.roomId),
      }),
    };
  });

  return { readOnly: true, rooms, walls, openings, cabinetFacts };
}
