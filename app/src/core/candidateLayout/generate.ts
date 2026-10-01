/**
 * ══════════════════════════════════════════════════════════════════════
 *  候选布局生成（P9.3）—— 确定性枚举：不调 AI、不改模型、不写盘
 *
 *  ── 这条链就是本层的全部 ──
 *      Intent → Candidate Placement → resolvePlacement → validation
 *    · 输入：`activeDesignIntents(project)`（**读侧唯一入口**）+ 可选 CandidateRequest
 *    · 落位候选：复用 `candidateSpots`（贴墙族枚举器，与 Variant 同一份）
 *    · 坐标出口：每条候选落位都是一份 `PlacementIntent`，**必须**过 `resolvePlacement`
 *    · 冲突判定：复用 `detectCollisions`（与 CommandBus 同一份，零第二份 AABB）
 *    · 满足判定：复用 `deriveSpatialFacts` / `deriveContacts`（事实层，零第二份判定）
 *
 *  ── 绝不做什么（本阶段红线）──
 *    · 不改 `Cabinet.placement`：只在**克隆副本**上试算，入参 project 一个字节都不动；
 *    · 不做随机搜索：同一份输入永远给出同一批候选（可复现）；
 *    · 不做 LLM 自己生成坐标：AI 只能给 `CandidateRequest`，里面没有坐标；
 *    · 不 import 命令总线 / AI / 导出 / 制造：候选**没有写路径**；
 *    · 不做 adopt：候选只描述"会得到什么结果"，落地是未来的事。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Cabinet, Issue, Project } from '../types.ts';
import { activeDesignIntents, type DesignIntent } from '../designIntent/model.ts';
import { designIntentGoalZh, type DesignIntentGoal } from '../designIntent/vocabulary.ts';
import { candidateSpots, type Spot } from '../snapPlace.ts';
import {
  resolvePlacement,
  sceneFromProject,
  type PlacementIntent,
  type PlacementScene,
  type ResolvedPlacement,
} from '../placement.ts';
import { detectCollisions } from '../geometry/project.ts';
import { deriveSpatialFacts, type SpatialFacts } from '../spatial/derive.ts';
import { deriveContacts, type Contact } from '../relations.ts';
import {
  MAX_CANDIDATES_PER_TARGET,
  candidateLayoutId,
  type CandidateLayout,
  type CandidateLayoutSet,
  type CandidatePlacement,
  type CandidateRequest,
  type CandidateSatisfies,
  type CandidateUnresolved,
} from './model.ts';

/**
 * 本阶段**只对这两个目标**做确定性构造。
 * 别的词要么是取舍方向（判不出对错），要么需要另外的构造器
 * （近洞口 / 开门净空 / 房间内外 …）—— 现在硬造就是拍脑袋。
 * 造不出来的**如实**进 `unresolved`，不假装造出来了。
 */
const CONSTRUCTIVE_GOALS: readonly DesignIntentGoal[] = ['wall-contact', 'standalone'];

/** 策略的人话（三档候选 A/B/C 的来源；顺序即优先级） */
const STRATEGY_ZH: Record<string, string> = {
  'wall-same': '贴墙 · 保持朝向',
  'wall-other': '贴墙 · 换个朝向',
  satisfy: '贴墙 · 满足目标',
};

type Evaluated = {
  spot: Spot;
  intent: PlacementIntent;
  resolved: ResolvedPlacement;
  issues: Issue[];
  satisfies: CandidateSatisfies[];
};

/** 归一到 [0,360) 的整数角（只用于判断"朝向变没变"，不做几何计算） */
const normDeg = (d: number): number => ((Math.round(d) % 360) + 360) % 360;

/** 夹取候选上限：非法值一律回落到默认值（不静默给 0 个候选） */
function clampMax(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return MAX_CANDIDATES_PER_TARGET;
  return Math.max(1, Math.min(MAX_CANDIDATES_PER_TARGET, Math.floor(v)));
}

/**
 * 只读克隆：把某只柜摆到 `p`，其余原样。
 * **不改入参** —— 这是"候选不污染 Model"在代码里的落点。
 */
function cloneWithPlacement(project: Project, cabId: string, p: ResolvedPlacement): Project {
  return {
    ...project,
    cabinets: project.cabinets.map((c) =>
      c.id === cabId ? { ...c, placement: { x: p.x, y: p.y, rotation: p.rotation } } : c
    ),
  };
}

/**
 * 目标满足性 —— **只翻译既有事实，不新增判定**。
 *   wall-contact：柜体对任一面墙的关系是 `touching`（贴墙）→ 满足；
 *   standalone  ：柜体与任何其它柜体都没有接触（`deriveContacts` 为空）→ 满足；
 *   其余目标本阶段不产生候选，这里一律 false（不会被问到）。
 */
function satisfiesGoal(goal: DesignIntentGoal, cabId: string, facts: SpatialFacts, contacts: Contact[]): boolean {
  switch (goal) {
    case 'wall-contact': {
      const f = facts.cabinets.find((c) => c.cabId === cabId);
      return f?.walls.some((w) => w.relation === 'touching') ?? false;
    }
    case 'standalone':
      return !contacts.some((c) => c.a === cabId || c.b === cabId);
    default:
      return false;
  }
}

/**
 * 评估一个贴墙落点：**先过 resolver**，再在克隆副本上做冲突 + 满足判定。
 * 解析失败返回 null（由调用方如实记进 unresolved，绝不"失败当成功"）。
 */
function evaluateSpot(
  project: Project,
  cab: Cabinet,
  spot: Spot,
  scene: PlacementScene,
  intents: DesignIntent[]
): Evaluated | null {
  const intent: PlacementIntent = {
    relation: 'absolute',
    targetId: cab.id,
    x: spot.x,
    y: spot.y,
    rotation: spot.rotation,
    origin: 'authored',
  };
  // ★ 唯一的坐标出口：候选的坐标**只能**来自这里，不许旁路直接写 x/y
  const r = resolvePlacement(intent, scene);
  if (!r.ok) return null;
  const clone = cloneWithPlacement(project, cab.id, r.placement);
  const issues = detectCollisions(clone).filter((i) => i.target.split(' / ').includes(cab.id));
  const facts = deriveSpatialFacts(clone);
  const contacts = deriveContacts(clone);
  const satisfies = intents.map((i) => ({ goal: i.goal, ok: satisfiesGoal(i.goal, cab.id, facts, contacts) }));
  return { spot, intent, resolved: r.placement, issues, satisfies };
}

/** 把一条被选中的落点包装成一份候选布局（A/B/C 之一） */
function makeCandidate(id: string, intent: DesignIntent, cab: Cabinet, ev: Evaluated, strategy: string): CandidateLayout {
  const ok = ev.satisfies[0]?.ok ?? false;
  const placement: CandidatePlacement = {
    targetId: cab.id,
    intent: ev.intent,
    resolved: ev.resolved,
    issues: ev.issues,
    satisfies: ev.satisfies,
  };
  const whereZh = ev.spot.wallId ? `贴「${ev.spot.wallName}」` : '未贴墙';
  return {
    id,
    status: 'draft',
    sourceIntent: [intent.id],
    placements: [placement],
    explanations: [
      `策略「${STRATEGY_ZH[strategy] ?? strategy}」：把「${cab.name}」${whereZh}，落位 (${ev.resolved.x}, ${ev.resolved.y}) @ ${normDeg(ev.resolved.rotation)}°`,
      ev.issues.length === 0 ? '与墙体、已有柜体均无冲突' : `有 ${ev.issues.length} 处冲突`,
      `对目标「${designIntentGoalZh(intent.goal)}」：${ok ? '满足' : '不满足'}`,
    ],
    unresolved: ok
      ? []
      : [{ intentId: intent.id, cabinetId: cab.id, reason: `本候选未满足「${designIntentGoalZh(intent.goal)}」` }],
  };
}

/** 意图作用到哪些柜体（显式 cabinetIds > cabinet scope > room 内全部柜体） */
function targetCabinets(project: Project, intent: DesignIntent, request?: CandidateRequest): Cabinet[] {
  if (request?.cabinetIds && request.cabinetIds.length > 0) {
    const want = new Set(request.cabinetIds);
    return project.cabinets.filter((c) => want.has(c.id));
  }
  const scope = intent.scope; // 取成局部常量再收窄（scope 是可变属性，回调里不会被 TS 收窄）
  if (scope.kind === 'cabinet') {
    const c = project.cabinets.find((x) => x.id === scope.cabinetId);
    return c ? [c] : [];
  }
  return project.cabinets.filter((c) => c.roomId === scope.roomId);
}

/**
 * 为一个（意图，目标柜）生成候选：遍历贴墙落点，按**策略**各取第一个合格的落点。
 *
 * 三档候选（与用户给的 A/B/C 对应）：
 *   wall-same ：第一个"放得下 + 朝向与现状相同"的贴墙落点；
 *   wall-other：第一个"放得下 + 朝向与现状不同"的贴墙落点（换朝向）；
 *   satisfy   ：第一个"放得下 + 真正满足该意图"的贴墙落点。
 * 每个策略只取一个（同一策略不重复），总上限 maxCandidates。
 * "放得下"的判据**只有一份**：`detectCollisions`（撞墙 / 撞柜都筛掉）。
 */
function candidatesForTarget(
  project: Project,
  intent: DesignIntent,
  cab: Cabinet,
  taken: Set<string>,
  maxCandidates: number
): { candidates: CandidateLayout[]; unresolved: CandidateUnresolved[] } {
  const scene = sceneFromProject(project);
  const spots = candidateSpots(project, cab.roomId, cab.params.width);
  const unresolved: CandidateUnresolved[] = [];
  if (spots.length === 0) {
    unresolved.push({
      intentId: intent.id,
      cabinetId: cab.id,
      reason: `房间「${cab.roomId}」没有可用的贴墙落点（没有墙或墙退化）`,
    });
    return { candidates: [], unresolved };
  }

  const curRot = normDeg(cab.placement.rotation);
  const used = new Set<string>();
  const candidates: CandidateLayout[] = [];
  let unresolvedSpots = 0;

  for (const spot of spots) {
    if (candidates.length >= maxCandidates) break;
    const ev = evaluateSpot(project, cab, spot, scene, [intent]);
    if (!ev) {
      unresolvedSpots++;
      continue;
    }
    if (ev.issues.length > 0) continue; // 放不下：判据只有 detectCollisions 一份
    const rot = normDeg(ev.resolved.rotation);
    let strategy: string | null = null;
    if (!used.has('wall-same') && rot === curRot) strategy = 'wall-same';
    else if (!used.has('wall-other') && rot !== curRot) strategy = 'wall-other';
    else if (!used.has('satisfy') && (ev.satisfies[0]?.ok ?? false)) strategy = 'satisfy';
    if (!strategy) continue;
    used.add(strategy);
    const id = candidateLayoutId(taken);
    taken.add(id);
    candidates.push(makeCandidate(id, intent, cab, ev, strategy));
  }

  if (candidates.length === 0) {
    unresolved.push({
      intentId: intent.id,
      cabinetId: cab.id,
      reason: `枚举了 ${spots.length} 个贴墙落点，但没有一个能成为候选（放不下 ${spots.length - unresolvedSpots} 个、解析失败 ${unresolvedSpots} 个）—— 本阶段不猜、不随机搜`,
    });
  }
  return { candidates, unresolved };
}

/**
 * 生成候选布局（**纯函数**：同输入同输出，不改 project）。
 *
 * @param project 当前项目（只读；函数内部绝不修改它）
 * @param request 可选的候选请求（AI 或界面给的，只含 id / 枚举，无坐标）
 */
export function generateCandidateLayouts(project: Project, request?: CandidateRequest): CandidateLayoutSet {
  const active = activeDesignIntents(project);
  const byId = new Map(active.map((i) => [i.id, i] as const));
  const unresolved: CandidateUnresolved[] = [];

  // ① 选出要处理的意图 —— **只认 active**（未确认 / 已否掉 / 不存在的都不产生候选）
  let intents: DesignIntent[];
  if (request?.intentIds && request.intentIds.length > 0) {
    intents = [];
    for (const id of request.intentIds) {
      const it = byId.get(id);
      if (!it) {
        unresolved.push({
          intentId: id,
          reason: `意图 ${id} 不在生效集合里 —— 只有 active 意图能驱动候选（未确认的 candidate / 已否掉的 rejected / 不存在的都不产生候选）`,
        });
        continue;
      }
      intents.push(it);
    }
  } else {
    intents = [...active];
  }

  // ② 只有"可构造目标"能产候选，其余如实说清为什么不产
  const maxCandidates = clampMax(request?.maxCandidates);
  const constructive: DesignIntent[] = [];
  for (const i of intents) {
    if (CONSTRUCTIVE_GOALS.includes(i.goal)) {
      constructive.push(i);
    } else {
      unresolved.push({
        intentId: i.id,
        reason: `目标「${designIntentGoalZh(i.goal)}」本阶段不产生候选 —— 只有「抵墙」「独立摆放」能由确定性枚举构造；取舍方向类与需要其它构造器的目标，现在硬造就是拍脑袋`,
      });
    }
  }

  // ③ 逐意图 × 逐目标柜（确定性顺序：意图按入参顺序，柜体按 project.cabinets 顺序）
  const taken = new Set<string>();
  const candidates: CandidateLayout[] = [];
  for (const intent of constructive) {
    const targets = targetCabinets(project, intent, request);
    if (targets.length === 0) {
      unresolved.push({ intentId: intent.id, reason: `意图 ${intent.id} 没有可作用的柜体（scope 指向的对象不存在？）` });
      continue;
    }
    for (const cab of targets) {
      const made = candidatesForTarget(project, intent, cab, taken, maxCandidates);
      candidates.push(...made.candidates);
      unresolved.push(...made.unresolved);
    }
  }

  return { status: 'draft', candidates, unresolved };
}
