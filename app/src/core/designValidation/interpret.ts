import type { Cabinet, Issue, Project, Room, Vec2, Wall } from '../types.ts';
import { getCabinetFootprint } from '../geometry/generate.ts';
import { wallPolygon } from '../geometry/project.ts';
import { bboxOf } from '../geometry/transform.ts';
import { faceDirectionOf, faceSegmentOf, sceneItemOf, type PlacementFace } from '../placement.ts';
import { buildIssue, type IssueCtx } from '../rules/issueCatalog.ts';
import {
  DESIGN_TOL,
  type DesignValidationFinding,
  type WallContactFact,
  type WallContactKind,
} from './model.ts';
import {
  SPATIAL_TOL,
  deriveSpatialFacts,
  openingName,
  openingZoneRect,
  polyDistance,
  roomLoop,
  wallInteriorSide,
  wallNormalUnit,
  type CabWallRelation,
  type SpatialFacts,
} from '../spatial/index.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  空间语义解释层（P8.8）—— 事实 → 设计语义
 *
 *  ── 一件事只说一遍（本层的纪律）──
 *    · "柜与墙贴不贴着 / 穿不穿墙"：**只有 P8.7 的 facts 能判**。本层一律从
 *      `facts.cabinets[].walls[].relation` 读结论，绝不自己再判一次。
 *    · "柜盖没盖住洞口"：同样只读 `facts...openings[].relation`。
 *    · "是哪一个面"：用 `placement.faceSegmentOf` —— 全项目唯一的面几何实现
 *      （旋转数学只有 geometry/transform.ts 一份），本文件没有三角函数。
 *
 *  ── 本层**新增**的判断只有两类，都是"事实之上的解释"，不是事实本身 ──
 *    ① 柜的哪一面在抵墙（背面 / 侧面 / 门脸）—— 由 facts 的 touching + 面法线
 *       与墙法线的夹角推出；
 *    ② "离洞口影响带还有多远"（P8.7 只记录 overlap/clear，不记录距离）——
 *       用空间层的同一批原语（polyDistance + openingZoneRect）量一次，**只用于
 *       报数与提示**，不参与任何 touching / overlap 的判定。
 *
 *  ── 不做的事 ──
 *    不自动移柜、不自动贴墙、不自动转朝向（P8.8 明令禁止）；不调 AI；
 *    不改模型、不改 placement；不出几何 / DXF / BOM。
 * ══════════════════════════════════════════════════════════════════════
 */

const centerOf = (fp: Vec2[]): Vec2 => {
  if (fp.length === 0) return { x: 0, y: 0 };
  const b = bboxOf(fp);
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
};

const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/**
 * 唯一的结论构造口：文案与 fixHint **一律**由 issueCatalog 产出，本层只负责
 * "哪一层 / 哪个等级 / 挂在哪只柜/哪面墙上"。自己拼文案 = 界面上的话与目录分家，
 * 这是本项目反复钉过的一条（buildIssue 是唯一出口）。
 */
function mkFinding(args: {
  code: string;
  status: 'warning' | 'error';
  target: string;
  ctx: IssueCtx;
  targetKind?: Issue['targetKind'];
  extra?: Partial<DesignValidationFinding>;
}): DesignValidationFinding {
  const issue = buildIssue(args.code, { target: args.target, targetKind: args.targetKind ?? 'cabinet', ctx: args.ctx });
  return {
    layer: 'semantic',
    status: args.status,
    code: args.code,
    message: issue.message,
    ...(issue.fixHint !== undefined ? { hint: issue.fixHint } : {}),
    ...(args.extra ?? {}),
  };
}

/**
 * 判定柜体抵墙的是**哪一面**（背 / 前脸 / 左端 / 右端）。
 *
 * 确定性走法（不写第二套旋转数学）：
 *   ① 主判据 —— 面法线 ∥ 墙法线，且方向**指向墙**的那一面。
 *      设 n 为墙的单位法线、s 为"墙中心 → 柜中心"在 n 上的符号：柜在墙的 +n 侧
 *      时，抵墙那一面的外法线必与 +n 反向（dot < 0）。四个面里恰好一个满足
 *      （|dot| ≈ 1 且符号相反）—— 这就是唯一解，不靠猜。
 *   ② 回退 —— 柜体斜向旋转时（法线对不上墙法线，比如 45°），改用"面中点离墙
 *      矩形最近的面的"（仍是确定性的距离比较，仍然是同一批几何原语）。
 *      回退时 `rotated = true`，调用方必须如实说明"是按最近面推的"。
 *
 * @returns face = null 仅当墙退化（零长、法线算不出）
 */
export function contactFaceOf(cab: Cabinet, wall: Wall): { face: PlacementFace | null; rotated: boolean } {
  const nu = wallNormalUnit(wall);
  const faces: PlacementFace[] = ['back', 'front', 'left', 'right'];
  if (nu) {
    const mid: Vec2 = { x: (wall.start.x + wall.end.x) / 2, y: (wall.start.y + wall.end.y) / 2 };
    const c = centerOf(getCabinetFootprint(cab));
    const s = dot2({ x: c.x - mid.x, y: c.y - mid.y }, nu);
    if (s !== 0) {
      const it = sceneItemOf(cab);
      for (const f of faces) {
        const d = faceDirectionOf(it, f);
        // 面法线与"指向墙"的方向一致（= 与 s·n 反向），且几乎平行于墙法线
        if (dot2(d, nu) * s < 0 && Math.abs(dot2(d, nu)) > 0.9) return { face: f, rotated: false };
      }
    }
  }
  // 回退：离墙矩形最近的那个面中点
  const rect = wallPolygon(wall);
  if (rect.length < 4) return { face: null, rotated: false };
  const it = sceneItemOf(cab);
  let best: { face: PlacementFace; dist: number } | null = null;
  for (const f of faces) {
    const seg = faceSegmentOf(it, f);
    const m: Vec2 = { x: (seg.start.x + seg.end.x) / 2, y: (seg.start.y + seg.end.y) / 2 };
    const dist = polyDistance([m], rect);
    if (!best || dist < best.dist) best = { face: f, dist };
  }
  return { face: best?.face ?? null, rotated: true };
}

/** 事实层的 relation + 抵墙面 → 设计语义（这是"解释"，不是判定） */
export function wallContactKind(relation: CabWallRelation, face: PlacementFace | null): WallContactKind {
  if (relation === 'crossing') return 'wall-conflict';
  if (relation === 'near') return 'wall-near';
  if (relation === 'touching') {
    if (face === 'front') return 'front-wall-contact';
    if (face === 'left' || face === 'right') return 'side-wall-contact';
    return 'back-wall-contact';
  }
  return 'floating';
}

/** 某面的人话（用在"声明面 vs 实际面"这类必须说清是哪一面的地方） */
export const FACE_ZH: Record<PlacementFace, string> = { back: '背面', front: '前脸', left: '左端', right: '右端' };

export interface WallContactResult {
  contacts: WallContactFact[];
  findings: DesignValidationFinding[];
}

/**
 * 派生全部柜 ↔ 墙的设计语义，并把"需要提请注意"的那几种翻成 finding。
 *
 * 正面事实（背面贴墙 / 侧面顶墙）**不发 finding** —— 靠墙摆放是常态，
 * 把它报成"问题"等于制造噪音，也违背"错的是问题、对的不吵人"。
 */
export function describeWallContacts(project: Project, facts: SpatialFacts): WallContactResult {
  const contacts: WallContactFact[] = [];
  const findings: DesignValidationFinding[] = [];
  const roomById = new Map(project.rooms.map((r) => [r.id, r]));
  const closedRoom = new Set(facts.rooms.filter((r) => r.closed).map((r) => r.roomId));

  for (const cab of project.cabinets) {
    const cf = facts.cabinets.find((c) => c.cabId === cab.id);
    if (!cf) continue;
    const room = roomById.get(cab.roomId);
    const wallById = new Map<string, Wall>((room?.walls ?? []).map((w) => [w.id, w]));

    for (const wf of cf.walls) {
      const wall = wallById.get(wf.wallId);
      if (!wall) continue;
      const { face, rotated } = wf.relation === 'touching' ? contactFaceOf(cab, wall) : { face: null, rotated: false };
      const kind = wallContactKind(wf.relation, face);
      contacts.push({
        cabId: cab.id,
        kind,
        wallId: wall.id,
        wallName: wall.name,
        ...(face ? { face } : {}),
        relation: wf.relation,
        gap: wf.gap,
        ...(rotated ? { rotated: true } : {}),
      });

      if (kind === 'wall-conflict') {
        findings.push(
          mkFinding({
            code: 'DESIGN-CABINET-WALL-CONFLICT',
            status: 'error',
            target: cab.id,
            ctx: {
              cabName: cab.name,
              roomName: room?.name ?? cab.roomId,
              wallName: wall.name,
              thickness: wall.thickness,
              depth: cab.params.depth,
            },
            extra: { cabId: cab.id, wallId: wall.id },
          })
        );
      } else if (kind === 'front-wall-contact') {
        findings.push(
          mkFinding({
            code: 'DESIGN-CABINET-FRONT-WALL',
            status: 'warning',
            target: cab.id,
            ctx: {
              cabName: cab.name,
              wallName: wall.name,
              thickness: wall.thickness,
              faceWidth: Math.round(cab.params.width),
              rotation: Math.round(cab.placement.rotation),
            },
            extra: { cabId: cab.id, wallId: wall.id },
          })
        );
      } else if (kind === 'wall-near') {
        findings.push(
          mkFinding({
            code: 'DESIGN-CABINET-NEAR-WALL',
            status: 'warning',
            target: cab.id,
            ctx: { cabName: cab.name, wallName: wall.name, gap: wf.gap },
            extra: { cabId: cab.id, wallId: wall.id },
          })
        );
      }
    }

    // floating：房间边界闭合、房间确实有墙，而这柜与**任何**一面墙都没有关系
    // （P8.7 的 facts 里连一条 entering 记录都没有 = 最近的墙也在 NEAR 之外）。
    // 注意"门脸朝墙"不算 floating（它确实挨着墙，只是面用错了）—— 那种由
    // front-wall-contact 单独说，不再叠一条"没靠墙"的自相矛盾结论。
    // 边界不闭合（判不出内外）或房间没有墙时**保持沉默** —— 判不出来就不说。
    if (cf.walls.length === 0 && room && closedRoom.has(room.id) && room.walls.length > 0) {
      contacts.push({ cabId: cab.id, kind: 'floating', relation: 'none' });
      findings.push(
        mkFinding({
          code: 'DESIGN-CABINET-FLOATING',
          status: 'warning',
          target: cab.id,
          ctx: { cabName: cab.name, roomName: room.name, wallCount: room.walls.length },
          extra: { cabId: cab.id },
        })
      );
    }
  }
  return { contacts, findings };
}

/**
 * 柜 ↔ 洞口的设计语义提示（P8.8 §六：只加解释，不做门扇开启半径 / 人流分析）。
 *
 * 硬事实"柜盖住洞口"仍由 P8.7 报（SPATIAL-CABINET-OPENING，ERROR）——
 * 本层不重复报；这里只处理 **没盖住但离得近** 的情况：
 *   门洞 → 门前通行可能不足；窗洞 → 采光通风可能受影响。
 */
export function describeOpeningProximity(project: Project, facts: SpatialFacts): DesignValidationFinding[] {
  const findings: DesignValidationFinding[] = [];
  const loopByRoom = new Map<string, ReturnType<typeof roomLoop>>();
  for (const r of project.rooms) loopByRoom.set(r.id, roomLoop(r.walls));

  for (const cab of project.cabinets) {
    const cf = facts.cabinets.find((c) => c.cabId === cab.id);
    if (!cf || cf.openings.length === 0) continue;
    const room = project.rooms.find((r) => r.id === cab.roomId);
    if (!room) continue;
    const loop = loopByRoom.get(room.id);
    const fp = getCabinetFootprint(cab);
    if (fp.length === 0) continue;

    for (const of_ of cf.openings) {
      // 只有 P8.7 判成 clear（没盖住）的才谈"离得近"；overlap 由 P8.7 报，unknown 就不猜
      if (of_.relation !== 'clear') continue;
      const wall = room.walls.find((w) => w.id === of_.wallId);
      const opening = wall?.openings?.find((o) => o.id === of_.openingId);
      if (!wall || !opening) continue;
      // 室内侧判不出（房间边界不成回路）时**沉默**：影响带可能整个画在屋外，
      // 量出来的距离不成立，宁可不提示也不猜一个方向。
      const side = loop && loop.status === 'ok' ? wallInteriorSide(loop.poly, wall) : null;
      if (side === null) continue;
      const zone = openingZoneRect(wall, opening, side);
      if (zone.status !== 'ok') continue;
      const gap = Math.round(polyDistance(fp, zone.rect));
      if (gap > DESIGN_TOL.APPROACH) continue;
      const isDoor = opening.kind === 'door';
      const code = isDoor ? 'DESIGN-CABINET-NEAR-DOOR' : 'DESIGN-WINDOW-BEHIND-CABINET';
      findings.push(
        mkFinding({
          code,
          status: 'warning',
          target: cab.id,
          ctx: {
            cabName: cab.name,
            roomName: room.name,
            wallName: wall.name,
            openingName: openingName(opening),
            width: opening.width,
            gap,
          },
          extra: { cabId: cab.id, wallId: wall.id, openingId: opening.id },
        })
      );
    }
  }
  return findings;
}

// ─────────────────────────── 墙贴合声明验证（§五） ───────────────────────────

/**
 * 「贴墙」声明（authored 输入）。
 *
 * ⚠ 为什么**没有 wallId**：哪一面墙是**派生事实**（由落位与房间结构算出来），
 *   不是 authored 语义；把 wallId 写进声明就等于给柜子挂 `Cabinet.wallId` 那种
 *   第二份真相（P8.8 §四明令禁止）。声明只说"这只柜应该靠墙、用哪面、留多宽的缝"，
 *   "靠的是哪面墙"由验证器从事实里读出来告诉用户。
 *
 * ⚠ 声明从哪来：P8.8 **不新增** authored 模型字段（不写 Cabinet、不升 schema）。
 *   验证器接受显式声明参数，任何授权来源（用户操作 / 导入 / 未来的 AI 提案）
 *   都可以调用；Knowledge 只能学"用户明确选过的偏好"（§八），不能把
 *   error / system-resolved 的结果当成声明。
 */
export interface WallAttachDecl {
  cabId: string;
  /** 期望抵墙的那一面；缺省 = 任意面都接受 */
  face?: PlacementFace;
  /** 期望缝隙 mm；缺省 = 只要贴上即可，不校验缝宽 */
  offset?: number;
}

/** 声明验证读到的**事实**（无论成败都给，便于界面把话说全） */
export interface WallAttachFact {
  cabId: string;
  relation: CabWallRelation;
  touching: boolean;
  wallId?: string;
  wallName?: string;
  face?: PlacementFace;
  /** 实测缝隙（touching 时来自 P8.7 facts；否则为"离最近一面墙"的实测距离） */
  gap: number;
  rotated: boolean;
}

export interface WallAttachVerdict {
  ok: boolean;
  cabId: string;
  fact: WallAttachFact;
  findings: DesignValidationFinding[];
}

/**
 * "离最近一面墙到底多远" —— **只为报数**用的量法。
 *
 * P8.7 的 facts 只记录 ≤NEAR 的关系（更远的墙根本不进 facts）；
 * 而"声明了贴墙却没贴上"必须说得出**差多少**，否则报错等于没说。
 * 所以这里用空间层的同一批原语（polyDistance + wallPolygon）量一次最距。
 *
 * 红线：这个数**不参与** touching / near / crossing 的判定（那个判定唯一出处
 * 仍是 P8.7 的 classifyCabWall）；它只出现在文案里。
 */
export function nearestWallDistance(cab: Cabinet, room: Room | undefined): { wallId: string; wallName: string; gap: number } | null {
  if (!room || room.walls.length === 0) return null;
  const fp = getCabinetFootprint(cab);
  if (fp.length === 0) return null;
  let best: { wallId: string; wallName: string; gap: number } | null = null;
  for (const w of room.walls) {
    if (w.start.x === w.end.x && w.start.y === w.end.y) continue; // 零长墙量不出东西
    const gap = Math.round(polyDistance(fp, wallPolygon(w)));
    if (!best || gap < best.gap) best = { wallId: w.id, wallName: w.name, gap };
  }
  return best;
}

/**
 * 验证一条「贴墙」声明与事实是否一致（纯函数，只读）。
 *
 * 纪律（与 P2 的 validateAssemblies 同一条）：**只校验声明过的**。
 * 没声明就不判"该不该靠墙"——那是设计决定，不是系统能替他下的结论。
 * 声明与事实不符 = 硬错误（ERROR）：声明过的就要做到，与 P2 对连接声明的态度一致。
 */
export function verifyWallAttachment(project: Project, decl: WallAttachDecl, factsIn?: SpatialFacts): WallAttachVerdict {
  // 没传就自己派生一次（**不是**退化成"空事实"—— 空事实会把"没贴上"误判成"没声明"）
  const facts = factsIn ?? deriveSpatialFacts(project);
  const cab = project.cabinets.find((c) => c.id === decl.cabId);
  const room = cab ? project.rooms.find((r) => r.id === cab.roomId) : undefined;
  const cf = facts.cabinets.find((c) => c.cabId === decl.cabId);
  const wallById = new Map<string, Wall>((room?.walls ?? []).map((w) => [w.id, w]));
  const entries = cf?.walls ?? [];

  // 穿墙优先：柜子都在墙里了，"贴没贴上"已经不是主要问题
  const conflict = entries.find((e) => e.relation === 'crossing');
  const touch = entries.find((e) => e.relation === 'touching');
  const nearest = entries.slice().sort((a, b) => a.gap - b.gap)[0];
  const fallback = cab ? nearestWallDistance(cab, room) : null;

  const fact: WallAttachFact = {
    cabId: decl.cabId,
    relation: conflict ? 'crossing' : touch ? 'touching' : nearest ? (nearest.relation as CabWallRelation) : 'none',
    touching: Boolean(touch),
    gap: touch ? touch.gap : (nearest?.gap ?? fallback?.gap ?? 0),
    rotated: false,
  };
  const findings: DesignValidationFinding[] = [];

  if (!cab) return { ok: false, cabId: decl.cabId, fact, findings };

  if (conflict) {
    const wall = wallById.get(conflict.wallId);
    fact.wallId = conflict.wallId;
    fact.wallName = wall?.name;
    findings.push(
      mkFinding({
        code: 'DESIGN-CABINET-WALL-CONFLICT',
        status: 'error',
        target: cab.id,
        ctx: {
          cabName: cab.name,
          roomName: room?.name ?? cab.roomId,
          wallName: wall?.name ?? conflict.wallId,
          thickness: wall?.thickness ?? 0,
          depth: cab.params.depth,
        },
        extra: { cabId: cab.id, wallId: conflict.wallId },
      })
    );
    return { ok: false, cabId: decl.cabId, fact, findings };
  }

  if (!touch) {
    const wall = nearest ? wallById.get(nearest.wallId) : undefined;
    fact.wallId = nearest?.wallId ?? fallback?.wallId;
    fact.wallName = wall?.name ?? fallback?.wallName;
    findings.push(
      mkFinding({
        code: 'DESIGN-ATTACH-NOT-TOUCHING',
        status: 'error',
        target: cab.id,
        ctx: { cabName: cab.name, wallName: fact.wallName ?? '最近一面墙', gap: fact.gap },
        extra: { cabId: cab.id, ...(fact.wallId ? { wallId: fact.wallId } : {}) },
      })
    );
    return { ok: false, cabId: decl.cabId, fact, findings };
  }

  const wall = wallById.get(touch.wallId);
  const { face, rotated } = wall ? contactFaceOf(cab, wall) : { face: null, rotated: false };
  fact.wallId = touch.wallId;
  fact.wallName = wall?.name;
  fact.face = face ?? undefined;
  fact.rotated = rotated;

  if (decl.face && face && decl.face !== face) {
    findings.push(
      mkFinding({
        code: 'DESIGN-ATTACH-FACE-MISMATCH',
        status: 'error',
        target: cab.id,
        ctx: {
          cabName: cab.name,
          declaredZh: FACE_ZH[decl.face],
          actualZh: FACE_ZH[face],
          rotation: Math.round(cab.placement.rotation),
        },
        extra: { cabId: cab.id, wallId: touch.wallId },
      })
    );
  }
  if (decl.offset !== undefined && Math.abs(touch.gap - decl.offset) > SPATIAL_TOL.TOUCH) {
    findings.push(
      mkFinding({
        code: 'DESIGN-ATTACH-OFFSET-MISMATCH',
        status: 'error',
        target: cab.id,
        ctx: { cabName: cab.name, declared: decl.offset, actual: touch.gap },
        extra: { cabId: cab.id, wallId: touch.wallId },
      })
    );
  }

  return { ok: findings.length === 0, cabId: decl.cabId, fact, findings };
}
