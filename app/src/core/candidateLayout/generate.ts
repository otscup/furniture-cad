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
  resolvePlacements,
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
  type CandidateGenerationStats,
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
 * 多柜只读克隆（P9.7）：把**一批**柜各自摆到 resolved，其余原样。
 * 这是整体验证（§八：整体 collision / spatial / relation）在代码里的落点 ——
 * 先整体克隆，再对**整个副本**跑一次 `detectCollisions`，绝不是逐柜各自验完就算整体合法。
 */
function cloneWithPlacements(project: Project, list: Array<{ targetId: string; resolved: ResolvedPlacement }>): Project {
  const byId = new Map(list.map((p) => [p.targetId, p.resolved] as const));
  return {
    ...project,
    cabinets: project.cabinets.map((c) => {
      const p = byId.get(c.id);
      return p ? { ...c, placement: { x: p.x, y: p.y, rotation: p.rotation } } : c;
    }),
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

// ═══════════════ P9.7 多柜协调候选（确定性有限枚举）═════════════════════

/** 锚点落点预算：每面墙最多取几个（candidateSpots 自带确定性顺序），整组最多取几个 */
const SPOTS_PER_WALL = 2;
const MAX_ANCHOR_SPOTS = 8;

/**
 * 多柜协调枚举的**确定性有限空间**（§十一：候选空间本身受控，不生成一万再 slice）：
 *   行链 = 锚点落点(≤8) × 成员顺序(自然/倒序 = 2)
 *   L 型 = 有序对(≤ n·(n-1)) × 面组合(2)
 * 全部组合逐个过 Resolver 与整体碰撞，组合总数有界，generated/returned/truncated 如实统计。
 */

/** 锚点落点：按墙分组、每墙取前 SPOTS_PER_WALL 个、总量封顶 —— 顺序完全确定 */
function anchorSpots(project: Project, roomId: string, width: number, classRot: number): Spot[] {
  const perWall = new Map<string, Spot[]>();
  for (const s of candidateSpots(project, roomId, width)) {
    if (normDeg(s.rotation) !== classRot) continue; // 链保持成员当前共同朝向（orientation 保持）
    const list = perWall.get(s.wallId ?? '') ?? [];
    if (list.length >= SPOTS_PER_WALL) continue;
    list.push(s);
    perWall.set(s.wallId ?? '', list);
  }
  return [...perWall.values()].flat().slice(0, MAX_ANCHOR_SPOTS);
}

/** 候选去重键（§十）：柜 id + resolver 输出 —— 只是 resolved result 的比较键，不是新真相源 */
function candidateSignature(c: CandidateLayout): string {
  return c.placements.length +
    '|' + c.placements.map((p) => `${p.targetId}@${p.resolved.x},${p.resolved.y},${p.resolved.rotation}`).sort().join('|');
}

interface CoordinatedResult {
  candidates: CandidateLayout[];
  unresolved: CandidateUnresolved[];
  generated: number;
  rejected: number;
  cycleDetected: boolean;
}

/**
 * 对一个（意图，同房间 ≥2 柜）的组合枚举**整体候选**：
 *
 *  ── 行链模板 ──
 *    按成员当前共同朝向取一个旋转类（≥2 只），锚点贴墙（落点来自 candidateSpots，
 *    过滤出与类朝向一致的墙），其余成员用 `attach`（left↔right，start 对齐 = 背面齐）
 *    依次续接到前一只 —— **成员坐标全部由 resolvePlacements 依赖排序算出**，
 *    本函数一个 x/y 都不算（§五）。
 *
 *  ── L 型模板 ──
 *    有序对 (A,B) 相对旋转 ±90°：B 以 back/front 面贴合 A 的 left/right 面，
 *    A 显式保持原位（no-op absolute）—— 整份候选表达的是"L 拼接"这个整体。
 *
 *  ── 整体验证（§八）──
 *    每个组合先 `resolvePlacements`（依赖排序 + 环检测，复用唯一实现），
 *    再 `cloneWithPlacements` 整体克隆，对**整个副本**跑一次 `detectCollisions`
 *    —— 任何一处冲突（含撞到没被移动的柜）都让整个组合出局。
 */
function coordinatedCandidates(
  project: Project,
  intent: DesignIntent,
  group: Cabinet[],
  taken: Set<string>
): CoordinatedResult {
  const scene = sceneFromProject(project);
  const out: CoordinatedResult = { candidates: [], unresolved: [], generated: 0, rejected: 0, cycleDetected: false };
  const signatureSeen = new Set<string>();

  /** 一个组合 → 整体验证 → 合格则包装成整体候选；返回 null = 组合出局（rejected 已计数） */
  const tryCombo = (placements: Array<{ targetId: string; intent: PlacementIntent }>, explain: string[]): CandidateLayout | null => {
    const batch = resolvePlacements(placements.map((p) => p.intent), scene);
    if (!batch.ok) {
      if (batch.error.code === 'PLACEMENT-CYCLE') {
        out.cycleDetected = true;
        out.unresolved.push({
          reason: `组合「${explain[0] ?? ''}」的落位意图互相参照成环（${batch.error.message}）—— 整体候选按 invalid 丢弃，绝不自动打断循环（§七）`,
        });
        return null;
      }
      out.rejected++;
      return null;
    }
    const resolvedList = batch.resolved.map((r) => ({ targetId: r.intent.targetId, resolved: r.placement }));
    const clone = cloneWithPlacements(project, resolvedList);
    const allIssues = detectCollisions(clone); // ★ 整体验证：不是逐柜验完就算整体合法
    if (allIssues.length > 0) {
      out.rejected++;
      return null;
    }
    const facts = deriveSpatialFacts(clone);
    const contacts = deriveContacts(clone);
    const byId = new Map(resolvedList.map((r) => [r.targetId, r.resolved] as const));
    const cps: CandidatePlacement[] = placements.map((p) => {
      const resolved = byId.get(p.targetId)!;
      const cab = group.find((c) => c.id === p.targetId)!;
      return {
        targetId: p.targetId,
        intent: p.intent,
        resolved,
        issues: [],
        satisfies: [{ goal: intent.goal, ok: satisfiesGoal(intent.goal, cab.id, facts, contacts) }],
      };
    });
    const id = candidateLayoutId(taken);
    taken.add(id);
    const unsat = cps.filter((cp) => !cp.satisfies[0]?.ok);
    return {
      id,
      status: 'draft',
      sourceIntent: [intent.id],
      placements: cps,
      explanations: [
        ...explain,
        `对目标「${designIntentGoalZh(intent.goal)}」：${cps.filter((cp) => cp.satisfies[0]?.ok).length}/${cps.length} 只柜满足`,
        '整体验证已通过（整体克隆上 detectCollisions 零冲突）；空间/门扇净空等设计语义由评分层对同一副本判定',
      ],
      unresolved: unsat.map((cp) => ({
        intentId: intent.id,
        cabinetId: cp.targetId,
        reason: `本整体候选未满足「${designIntentGoalZh(intent.goal)}」（${cp.targetId}）`,
      })),
    };
  };

  // ── 行链模板：按朝向分类，类内 ≥2 只才有链 ──
  const rotClasses: Array<{ rot: number; members: Cabinet[] }> = [];
  for (const cab of group) {
    const rot = normDeg(cab.placement.rotation);
    const cls = rotClasses.find((c) => c.rot === rot);
    if (cls) cls.members.push(cab);
    else rotClasses.push({ rot, members: [cab] });
  }
  for (const cls of rotClasses) {
    if (cls.members.length < 2) continue;
    const spots = anchorSpots(project, group[0].roomId, cls.members[0].params.width, cls.rot);
    for (const spot of spots) {
      for (const reversed of [false, true]) {
        const chain = reversed ? [...cls.members].reverse() : cls.members;
        const head = chain[0];
        const intents: Array<{ targetId: string; intent: PlacementIntent }> = [
          {
            targetId: head.id,
            intent: { relation: 'absolute', targetId: head.id, x: spot.x, y: spot.y, rotation: spot.rotation, origin: 'authored' },
          },
        ];
        for (let i = 1; i < chain.length; i++) {
          intents.push({
            targetId: chain[i].id,
            intent: {
              relation: 'attach',
              targetId: chain[i].id,
              referenceId: chain[i - 1].id,
              targetFace: 'left',
              referenceFace: 'right',
              alignment: 'start',
            },
          });
        }
        const namesZh = chain.map((c) => c.name).join('→');
        const cand = tryCombo(intents, [
          `整墙链（协调候选${reversed ? ' · 倒序' : ''}）：${namesZh} 沿「${spot.wallName}」背面齐平续接，锚点 (${spot.x}, ${spot.y}) @ ${normDeg(spot.rotation)}°`,
        ]);
        if (cand) {
          const sig = candidateSignature(cand);
          if (!signatureSeen.has(sig)) {
            signatureSeen.add(sig);
            out.candidates.push(cand);
            out.generated++;
          }
        }
        if (out.cycleDetected) return out; // 成环：整体按 invalid 明确丢弃，不继续枚举同构组合
      }
    }
  }

  // ── L 型模板：有序对 (A,B)，相对旋转 ±90°，A 显式保持原位 ──
  for (const a of group) {
    for (const b of group) {
      if (a.id === b.id) continue;
      const rel = normDeg(b.placement.rotation - a.placement.rotation);
      const variants: Array<{ tf: 'back' | 'front'; rf: 'left' | 'right' }> =
        rel === 90 ? [{ tf: 'back', rf: 'left' }, { tf: 'front', rf: 'right' }]
        : rel === 270 ? [{ tf: 'back', rf: 'right' }, { tf: 'front', rf: 'left' }]
        : [];
      for (const v of variants) {
        const intents: Array<{ targetId: string; intent: PlacementIntent }> = [
          {
            targetId: a.id,
            intent: {
              relation: 'absolute',
              targetId: a.id,
              x: a.placement.x,
              y: a.placement.y,
              rotation: a.placement.rotation,
              origin: 'authored',
            },
          },
          {
            targetId: b.id,
            intent: {
              relation: 'attach',
              targetId: b.id,
              referenceId: a.id,
              targetFace: v.tf,
              referenceFace: v.rf,
              alignment: 'start',
            },
          },
        ];
        const cand = tryCombo(intents, [
          `L 型拼接（协调候选）：「${b.name}」以${v.tf === 'back' ? '背面' : '正面'}贴合「${a.name}」的${v.rf === 'left' ? '左' : '右'}面（相对转角 ${rel}°），「${a.name}」保持原位`,
        ]);
        if (cand) {
          const sig = candidateSignature(cand);
          if (!signatureSeen.has(sig)) {
            signatureSeen.add(sig);
            out.candidates.push(cand);
            out.generated++;
          }
        }
        if (out.cycleDetected) return out;
      }
    }
  }

  if (out.candidates.length === 0 && out.rejected > 0 && !out.cycleDetected) {
    out.unresolved.push({
      intentId: intent.id,
      reason: `协调枚举试了若干组合（${out.rejected} 个因解析失败或整体冲突出局），没有产出一个无冲突的整体候选 —— 不猜、不随机搜`,
    });
  }
  return out;
}

/**
 * 生成候选布局（**纯函数**：同输入同输出，不改 project）。
 *
 * P9.7 起在逐柜候选之外新增**多柜协调**路径：同一意图作用到同房间 ≥2 只柜时，
 * 额外枚举"整体候选"（整墙链 / L 型）—— 详见 `coordinatedCandidates`。
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

  // ③b P9.7 多柜协调候选：同一意图作用到同房间 ≥2 只柜时，额外枚举**整体**候选。
  //     "协调"不是把几份单柜候选拼起来 —— 这里产出的是一份 placements 多项的候选（§六）。
  let generation: CandidateGenerationStats | undefined;
  {
    const takenIds = taken; // 与单柜路径共享编号空间，保证全集合候选 id 唯一
    let rejectedTotal = 0;
    const coordCandidates: CandidateLayout[] = [];
    const coordUnresolved: CandidateUnresolved[] = [];
    for (const intent of constructive) {
      const targets = targetCabinets(project, intent, request);
      // 按房间分组（确定性：project.cabinets 顺序；跨房间的柜不构成一个"整体"）
      const byRoom = new Map<string, Cabinet[]>();
      for (const cab of targets) {
        const list = byRoom.get(cab.roomId) ?? [];
        list.push(cab);
        byRoom.set(cab.roomId, list);
      }
      for (const [, group] of byRoom) {
        if (group.length < 2) continue;
        const made = coordinatedCandidates(project, intent, group, takenIds);
        coordCandidates.push(...made.candidates);
        coordUnresolved.push(...made.unresolved);
        rejectedTotal += made.rejected;
        if (made.cycleDetected) break;
      }
      if (coordUnresolved.some((u) => u.reason.includes('成环'))) break;
    }
    // §十 去重：跨"单柜路径 + 协调路径"按 resolved 结果签名去重（重复候选只留一份，顺序保持）
    const seen = new Set<string>();
    const deduped: CandidateLayout[] = [];
    for (const c of candidates) {
      const sig = candidateSignature(c);
      if (!seen.has(sig)) {
        seen.add(sig);
        deduped.push(c);
      }
    }
    const uniqueCoord = coordCandidates.filter((c) => {
      const sig = candidateSignature(c);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
    // §十一 上限：协调候选也受 maxCandidates 约束 —— 超出如实统计，绝不静默 slice
    const returned = uniqueCoord.slice(0, maxCandidates);
    const truncated = uniqueCoord.length - returned.length;
    // 统计只描述协调路径：协调路径没启用 / 没产出时如实缺席（不挂全 0 的假统计）
    if (uniqueCoord.length > 0) {
      generation = {
        requested: maxCandidates,
        generated: uniqueCoord.length,
        returned: returned.length,
        truncated,
        generationLimited: truncated > 0,
      };
    }
    // ★ 替换而非追加：candidates 里此刻是去重前的 ③ 产出，用 deduped 整体换掉
    candidates.length = 0;
    candidates.push(...deduped, ...returned);
    unresolved.push(...coordUnresolved);
    if (rejectedTotal > 0 && returned.length > 0) {
      unresolved.push({
        reason: `协调枚举另有 ${rejectedTotal} 个组合因解析失败或整体冲突出局（如实计数，不参与候选）`,
      });
    }
  }

  return { status: 'draft', candidates, unresolved, ...(generation ? { generation } : {}) };
}
