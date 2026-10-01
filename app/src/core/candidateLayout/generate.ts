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
import {
  candidateSpots,
  freeWallSegments,
  legacyWallParams,
  spotOnWall,
  type Spot,
  type WallFreeSegment,
} from '../snapPlace.ts';
import {
  ATTACH_ALIGNMENTS,
  ATTACH_DEFAULT_ALIGNMENT,
  resolvePlacement,
  resolvePlacements,
  sceneFromProject,
  type AttachAlignment,
  type PlacementIntent,
  type PlacementScene,
  type ResolvedPlacement,
} from '../placement.ts';
import { detectCollisions } from '../geometry/project.ts';
import { deriveSpatialFacts, type SpatialFacts } from '../spatial/derive.ts';
import { deriveContacts, type Contact } from '../relations.ts';
import {
  COMBO_BUDGET_PER_GROUP,
  COVERAGE_SAMPLES_PER_SEGMENT,
  MAX_CANDIDATES_COORDINATED,
  MAX_CANDIDATES_PER_TARGET,
  candidateLayoutId,
  type CandidateGenerationStats,
  type CandidateLayout,
  type CandidateLayoutSet,
  type CandidatePlacement,
  type CandidateRejectedCounts,
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
 * 夹取**协调路径**的返回上限（P9.8 §四）。
 * 上限来源 `MAX_CANDIDATES_COORDINATED`（= 段内采样点 × 单柜策略档，见 model.ts）。
 * 超过上限时由调用方写 unresolved（如实说明 requested / allowed），这里只负责夹紧。
 */
function clampCoordinated(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return MAX_CANDIDATES_COORDINATED;
  return Math.max(1, Math.min(MAX_CANDIDATES_COORDINATED, Math.floor(v)));
}

/**
 * 覆盖式选择（P9.8 §一.3）：按**搜索族**轮转取，而不是 `slice(0, N)`。
 *
 * ── 为什么 ──
 *   `slice(0, N)` 取的是"枚举顺序的前 N 条"，而枚举顺序天然成簇（同一墙段、
 *   同一对齐族连在一起）⇒ 返回集合会退化成单一族，真实厨房就是这样只拿到
 *   "门洞处那一族"的。轮转保证"每族各出一条"优先于"某族出满"。
 *
 * ── 它不是什么 ──
 *   **不是选优**：不看评分、不比较候选好坏、不挑 winner；只是确定性地
 *   铺开覆盖面。优劣一律由 DesignScore / 用户判断。
 *
 * 确定性：族的次序 = 首次出现次序；族内次序 = 枚举次序。
 */
function coverageOrder<T>(items: T[], familyOf: (t: T) => string): T[] {
  const buckets = new Map<string, T[]>();
  for (const it of items) {
    const k = familyOf(it);
    const list = buckets.get(k);
    if (list) list.push(it);
    else buckets.set(k, [it]);
  }
  const keys = [...buckets.keys()];
  const out: T[] = [];
  for (let i = 0; out.length < items.length; i++) {
    let added = false;
    for (const k of keys) {
      const b = buckets.get(k)!;
      if (i < b.length) {
        out.push(b[i]!);
        added = true;
        if (out.length >= items.length) break;
      }
    }
    if (!added) break;
  }
  return out;
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

// ═══════════════ P9.7 多柜协调候选（P9.8 扩为空白墙段搜索）═════════════════════

/**
 * 多柜协调枚举的**确定性有限空间**（§十一：候选空间本身受控，不生成一万再 slice）：
 *
 *   P9.7：行链 = 锚点(每墙前 2 档固定阶梯) × 顺序(自然/倒序)
 *   P9.8：行链 = 空白墙段(authored 洞口补集) × 段内采样(起端/中部/末端)
 *                × 顺序(循环移位 + 倒序族 ≤ 2n) × 面内对齐(3) × 缝隙(1 + 该墙洞口净宽)
 *         L 型 = 有序对 × 面组合(2)（P9.7 原样保留）
 *
 * 全部组合逐个过 Resolver 与整体碰撞；组合预算触顶即停且**记账**
 * （`explored` / `rejected{resolve,collision,duplicate}` / `budgetExhausted`）。
 */

/** 候选去重键（§十）：柜 id + resolver 输出 —— 只是 resolved result 的比较键，不是新真相源 */
function candidateSignature(c: CandidateLayout): string {
  return c.placements.length +
    '|' + c.placements.map((p) => `${p.targetId}@${p.resolved.x},${p.resolved.y},${p.resolved.rotation}`).sort().join('|');
}

/**
 * 旧阶梯族每面墙取几档（沿用 P9.7 的 `SPOTS_PER_WALL`：从 `candidateSpots` 的
 * 确定性阶梯里取前 2 档）。保留它的唯一理由：P9.7 的搜索空间仍要能出现
 * （含"压在洞口上"的摆法），让管线去判 infeasible —— 不是生成器替它过滤。
 */
const SPOTS_PER_WALL = 2;

/**
 * 组内成员顺序变体（确定性，**2n 级别**，不是 n!）：
 *   循环移位 n 个 + 倒序族 n 个（去重后 ≤ 2n）。
 */
function orderVariants(members: Cabinet[]): Cabinet[][] {
  const n = members.length;
  const seen = new Set<string>();
  const out: Cabinet[][] = [];
  const push = (arr: Cabinet[]): void => {
    const key = arr.map((c) => c.id).join('>');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(arr);
  };
  for (let k = 0; k < n; k++) push([...members.slice(k), ...members.slice(0, k)]);
  for (let k = 0; k < n; k++) push([...members.slice(k), ...members.slice(0, k)].reverse());
  return out;
}

/**
 * 链内缝隙候选（P9.8 S2：`attach.offset` 接入）。
 * 取值来源只有两处，都是 authored 数据 / 既有默认：
 *   · `0` —— 既有默认（真正贴合，P9.7 的行为作为一个族保留）；
 *   · 该墙上每个洞口的 **authored 净宽** —— 数据派生，不是拍脑袋的 mm 常数。
 * 本函数不判断"哪个缝更好"（那是评分层的事），只把它们作为不同的候选族提出来。
 */
function offsetVariants(wall: { openings?: Array<{ width: number }> }): number[] {
  const out = new Set<number>([0]);
  for (const o of wall.openings ?? []) {
    if (Number.isFinite(o.width) && o.width > 0) out.add(o.width);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * 一个空白墙段上"整组放得下"的锚点采样（沿墙归一化参数 t）。
 * 起端 / 中部 / 末端三点 —— 与 `COVERAGE_SAMPLES_PER_SEGMENT` 一一对应。
 *
 * 为什么按"组总跨度"算：`placeAgainstNearestWall` 把**首成员**的中心对准锚点，
 * 所以整块（Σ 宽 + 缝）要么从段起点开始、要么刚好贴到段末端，中间是连续区间。
 * 顺序换了首成员就换了宽度 —— 必须按当前顺序重算（P9.8 §一.2 修的结构性错配）。
 */
function anchorParamsOfSegment(
  wallLength: number,
  seg: WallFreeSegment,
  headWidth: number,
  groupSpan: number
): Array<{ t: number; label: string }> {
  const segStart = seg.t0 * wallLength;
  const segEnd = seg.t1 * wallLength;
  const footMin = segStart + headWidth / 2; // 首成员左缘贴段起点
  const footMax = segEnd - groupSpan + headWidth / 2; // 整块右缘贴段末端
  if (footMax < footMin) return []; // 这一段的空白容不下整组 —— 如实不提议（不缩尺寸、不猜位置）
  const raw: Array<{ v: number; label: string }> = [
    { v: footMin, label: '起端' },
    { v: (footMin + footMax) / 2, label: '中部' },
    { v: footMax, label: '末端' },
  ];
  const out: Array<{ t: number; label: string }> = [];
  const seenT = new Set<number>();
  for (const r of raw) {
    const t = Math.round((r.v / wallLength) * 1e6) / 1e6;
    if (seenT.has(t)) continue; // 退化（段长 == 组宽）时三点重合，只留一个
    seenT.add(t);
    out.push({ t, label: r.label });
  }
  return out;
}

interface CoordinatedEntry {
  candidate: CandidateLayout;
  /** 搜索族标签（墙段 + 对齐 + 缝隙）—— 只用于确定性覆盖式返回，不参与任何评分 */
  family: string;
}

interface CoordinatedResult {
  entries: CoordinatedEntry[];
  unresolved: CandidateUnresolved[];
  explored: number;
  rejected: CandidateRejectedCounts;
  budget: number;
  budgetExhausted: boolean;
  cycleDetected: boolean;
}

/**
 * 对一个（意图，同房间 ≥2 柜）的组合枚举**整体候选**：
 *
 *  ── 行链模板（P9.8）──
 *    按成员当前共同朝向取旋转类（≥2 只）→ 该朝向对应的墙 → **空白墙段**
 *    （authored 洞口补集，只用于提议）→ 段内三处采样 → 首成员 absolute，
 *    其余 `attach`（left↔right，对齐/缝隙按候选族取值）
 *    —— **成员坐标全部由 resolvePlacements 依赖排序算出**，本函数一个 x/y 都不算（§五）。
 *
 *  ── L 型模板（P9.7 原样保留）──
 *    有序对 (A,B) 相对旋转 ±90°：B 以 back/front 面贴合 A 的 left/right 面，
 *    A 显式保持原位（no-op absolute）。
 *
 *  ── 整体验证（§八）──
 *    每个组合先 `resolvePlacements`（依赖排序 + 环检测，复用唯一实现），
 *    再 `cloneWithPlacements` 整体克隆，对**整个副本**跑一次 `detectCollisions`
 *    —— 任何一处冲突（含撞到没被移动的柜）都让整个组合出局，并记 `rejected.collision`。
 *
 *  ── 不做什么（P9.8 边界）──
 *    不读洞口语义（hinge/swingDirection）、不复制开口/门摆判定、
 *    不读 DesignScore、不按"好坏"排序或淘汰。
 */
function coordinatedCandidates(
  project: Project,
  intent: DesignIntent,
  group: Cabinet[],
  taken: Set<string>,
  budget: number
): CoordinatedResult {
  const scene = sceneFromProject(project);
  const out: CoordinatedResult = {
    entries: [],
    unresolved: [],
    explored: 0,
    rejected: { resolve: 0, collision: 0, duplicate: 0 },
    budget,
    budgetExhausted: false,
    cycleDetected: false,
  };
  const signatureSeen = new Set<string>();

  /** ★ 预算：到顶即停且记账（绝不静默截断） */
  const overBudget = (): boolean => {
    if (out.explored >= budget) {
      out.budgetExhausted = true;
      return true;
    }
    return false;
  };

  /** 一个组合 → 整体验证 → 合格则包装成整体候选；返回 null = 组合出局（rejected 已计数） */
  const tryCombo = (
    placements: Array<{ targetId: string; intent: PlacementIntent }>,
    explain: string[],
    family: string
  ): CoordinatedEntry | null => {
    out.explored++;
    const batch = resolvePlacements(placements.map((p) => p.intent), scene);
    if (!batch.ok) {
      out.rejected.resolve++;
      if (batch.error.code === 'PLACEMENT-CYCLE') {
        out.cycleDetected = true;
        out.unresolved.push({
          reason: `组合「${explain[0] ?? ''}」的落位意图互相参照成环（${batch.error.message}）—— 整体候选按 invalid 丢弃，绝不自动打断循环（§七）`,
        });
      }
      return null;
    }
    const resolvedList = batch.resolved.map((r) => ({ targetId: r.intent.targetId, resolved: r.placement }));
    const clone = cloneWithPlacements(project, resolvedList);
    const allIssues = detectCollisions(clone); // ★ 整体验证：不是逐柜验完就算整体合法
    if (allIssues.length > 0) {
      out.rejected.collision++;
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
    const cand: CandidateLayout = {
      id,
      status: 'draft',
      sourceIntent: [intent.id],
      placements: cps,
      explanations: [
        ...explain,
        `搜索族：${family}`,
        `对目标「${designIntentGoalZh(intent.goal)}」：${cps.filter((cp) => cp.satisfies[0]?.ok).length}/${cps.length} 只柜满足`,
        '整体验证已通过（整体克隆上 detectCollisions 零冲突）；空间/门扇净空等设计语义由评分层对同一副本判定',
      ],
      unresolved: unsat.map((cp) => ({
        intentId: intent.id,
        cabinetId: cp.targetId,
        reason: `本整体候选未满足「${designIntentGoalZh(intent.goal)}」（${cp.targetId}）`,
      })),
    };
    const sig = candidateSignature(cand);
    if (signatureSeen.has(sig)) {
      out.rejected.duplicate++;
      return null;
    }
    signatureSeen.add(sig);
    return { candidate: cand, family };
  };

  // ── 空白墙段（只按 authored 洞口切段；参数不可用 ⇒ 该墙不参与，unknown 不当空白）──
  const roomId = group[0]!.roomId;
  const room = project.rooms.find((r) => r.id === roomId);
  if (!room) {
    out.unresolved.push({ intentId: intent.id, reason: `协调枚举找不到房间 ${roomId}（组里柜体的 roomId 无效？）` });
    return out;
  }
  const segProposal = freeWallSegments(project, roomId);
  for (const u of segProposal.unknown) {
    out.unresolved.push({ intentId: intent.id, reason: u.reason });
  }

  // ── 行链模板：按朝向分类，类内 ≥2 只才有链（attach 要求同朝向）──
  const rotClasses: Array<{ rot: number; members: Cabinet[] }> = [];
  for (const cab of group) {
    const rot = normDeg(cab.placement.rotation);
    const cls = rotClasses.find((c) => c.rot === rot);
    if (cls) cls.members.push(cab);
    else rotClasses.push({ rot, members: [cab] });
  }

  const tooNarrow: string[] = [];
  // 参与搜索的墙 = 有空白区段的墙（顺序：区段首次出现次序，确定性）
  const wallIds: string[] = [];
  for (const seg of segProposal.segments) {
    if (!wallIds.includes(seg.wallId)) wallIds.push(seg.wallId);
  }
  for (const cls of rotClasses) {
    if (cls.members.length < 2) continue;
    const orders = orderVariants(cls.members);
    for (const wallId of wallIds) {
      const wall = room.walls.find((w) => w.id === wallId);
      if (!wall) continue;
      const segs = segProposal.segments.filter((s) => s.wallId === wallId);
      const wallLength = segs[0]!.wallLengthMm; // 墙长由提议层给出，本层不再自己量一次
      // 这面墙贴出来的朝向是否等于本类朝向：用一次提议探测（不另写一套朝向算法）
      const probe = spotOnWall(project, wall, 0.5, cls.members[0]!.params.width);
      if (!probe || normDeg(probe.rotation) !== cls.rot) continue;
      const offsets = offsetVariants(wall);
      /**
       * 某个顺序下的锚点提议：空白墙段三点 + 旧阶梯族两档。
       * **按当前顺序的链首宽度重算**（P9.8 §一.2：修掉"倒序后 head 换了、采样没换"的错配）。
       */
      const anchorsForOrder = (order: Cabinet[], gap: number, align: AttachAlignment): Array<{ spot: Spot; family: string; zh: string }> => {
        const head = order[0]!;
        const spanSum = order.reduce((acc, c) => acc + c.params.width, 0);
        const groupSpan = spanSum + gap * (order.length - 1);
        const list: Array<{ spot: Spot; family: string; zh: string }> = [];
        segs.forEach((seg, segIdx) => {
          for (const a of anchorParamsOfSegment(wallLength, seg, head.params.width, groupSpan)) {
            const sp = spotOnWall(project, wall, a.t, head.params.width);
            if (sp) {
              list.push({
                spot: sp,
                family: `${wallId}|seg${segIdx}|align=${align}|gap=${gap}`,
                zh: `空白墙段 #${segIdx}·${a.label}（沿墙 ${Math.round(seg.t0 * wallLength)}~${Math.round(seg.t1 * wallLength)}mm）`,
              });
            }
          }
        });
        if (list.length === 0) {
          const note = `协调枚举：墙「${wall.name ?? wall.id}」的空白区段容不下整组（组总宽 ${Math.round(groupSpan)}mm，缝 ${gap}mm）`;
          if (!tooNarrow.includes(note)) tooNarrow.push(note);
        }
        /**
         * 旧阶梯族（P9.7 的空间，保留为一个族）：整墙固定阶梯前 `SPOTS_PER_WALL` 档，
         * 同样按"当前链首宽度"重算，且**整块不得越出墙的两端**（否则会摆到房间外，
         * 那就不是"另一种摆法"而是"跑出去了"）。
         * 它可能落在洞口上 —— 这正是要的：冲突候选照样产出，由管线判 infeasible，
         * 而不是被生成器提前过滤掉。
         */
        legacyWallParams(SPOTS_PER_WALL).forEach((t, li) => {
          const startMm = t * wallLength - head.params.width / 2;
          if (startMm < 0 || startMm + groupSpan > wallLength) return; // 整块越出墙两端 ⇒ 不提议
          const sp = spotOnWall(project, wall, t, head.params.width);
          if (!sp || normDeg(sp.rotation) !== cls.rot) return;
          list.push({
            spot: sp,
            family: `${wallId}|legacy${li}|align=${align}|gap=${gap}`,
            zh: `整墙阶梯锚点 #${li}（P9.7 既有空间，保留为一个族）`,
          });
        });
        return list;
      };

      for (const gap of offsets) {
        for (const align of ATTACH_ALIGNMENTS) {
          // 先按每个顺序算好锚点（依赖链首宽度），再按"采样槽位 → 顺序"枚举：
          // 让**顺序**成为快变维度，覆盖式返回才不会把整个返回集合餵给同一个顺序。
          const perOrder = orders.map((order) => anchorsForOrder(order, gap, align));
          const slotCount = Math.max(...perOrder.map((l) => l.length));
          for (let si = 0; si < slotCount; si++) {
            for (let oi = 0; oi < orders.length; oi++) {
              const prop = perOrder[oi]![si];
              if (!prop) continue;
              if (overBudget()) return out;
              const order = orders[oi]!;
              const head = order[0]!;
              const spot = prop.spot;
              const intents: Array<{ targetId: string; intent: PlacementIntent }> = [
                {
                  targetId: head.id,
                  intent: { relation: 'absolute', targetId: head.id, x: spot.x, y: spot.y, rotation: spot.rotation, origin: 'authored' },
                },
              ];
              for (let i = 1; i < order.length; i++) {
                intents.push({
                  targetId: order[i]!.id,
                  intent: {
                    relation: 'attach',
                    targetId: order[i]!.id,
                    referenceId: order[i - 1]!.id,
                    targetFace: 'left',
                    referenceFace: 'right',
                    alignment: align,
                    offset: gap,
                  },
                });
              }
              const namesZh = order.map((c) => c.name).join('→');
              const entry = tryCombo(intents, [
                `整墙链（协调候选 · ${prop.zh} · 缝隙 ${gap}mm · 对齐 ${align}）：${namesZh} 沿「${spot.wallName}」续接，锚点 (${spot.x}, ${spot.y}) @ ${normDeg(spot.rotation)}°`,
              ], prop.family);
              if (entry) out.entries.push(entry);
              if (out.cycleDetected) return out; // 成环：整体按 invalid 明确丢弃，不继续枚举同构组合
            }
          }
        }
      }
    }
  }
  for (const note of tooNarrow) {
    out.unresolved.push({ intentId: intent.id, reason: `${note} —— 不缩尺寸、不猜位置（如实记为不可探索）` });
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
        if (overBudget()) return out;
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
              alignment: ATTACH_DEFAULT_ALIGNMENT,
              offset: 0,
            },
          },
        ];
        const family = `L:${a.id}>${b.id}|${v.tf}-${v.rf}`;
        const entry = tryCombo(intents, [
          `L 型拼接（协调候选）：「${b.name}」以${v.tf === 'back' ? '背面' : '正面'}贴合「${a.name}」的${v.rf === 'left' ? '左' : '右'}面（相对转角 ${rel}°），「${a.name}」保持原位`,
        ], family);
        if (entry) out.entries.push(entry);
        if (out.cycleDetected) return out;
      }
    }
  }

  if (out.entries.length === 0 && (out.rejected.resolve > 0 || out.rejected.collision > 0) && !out.cycleDetected) {
    out.unresolved.push({
      intentId: intent.id,
      reason: `协调枚举试了 ${out.explored} 个组合（解析失败 ${out.rejected.resolve}、整体冲突 ${out.rejected.collision}、重复 ${out.rejected.duplicate}），没有产出一个无冲突的整体候选 —— 不猜、不随机搜`,
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
  // P9.8 §四：协调路径的返回上限（不再被 MAX_CANDIDATES_PER_TARGET=3 卡死）
  const maxCoordinated = clampCoordinated(request?.maxCandidates);
  const clampedMax = typeof request?.maxCandidates === 'number' && request.maxCandidates > MAX_CANDIDATES_COORDINATED;
  if (clampedMax) {
    unresolved.push({
      reason: `maxCandidates 请求 ${request?.maxCandidates} 超过协调返回政策上限 ${MAX_CANDIDATES_COORDINATED}（来源：段内采样点 ${COVERAGE_SAMPLES_PER_SEGMENT} × 单柜策略档 ${MAX_CANDIDATES_PER_TARGET}），已夹到 ${MAX_CANDIDATES_COORDINATED} —— 如实说明 requested/allowed，不静默截断`,
    });
  }
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

  // ③b P9.8 §四：单柜路径的请求上限也如实说明。
  //     `clampMax` 是"每只目标柜最多几档"（= MAX_CANDIDATES_PER_TARGET，P9.3 起就没变），
  //     请求超过它就是**真被夹了**；以前这一句没人说，等于静默截断。
  //     只在单柜路径确实产出了候选时才记（没走这条路就别凭空挂一条 unresolved）。
  if (
    candidates.length > 0 &&
    typeof request?.maxCandidates === 'number' &&
    Number.isFinite(request.maxCandidates) &&
    request.maxCandidates > MAX_CANDIDATES_PER_TARGET
  ) {
    unresolved.push({
      reason: `maxCandidates 请求 ${request.maxCandidates} 超过单柜路径政策上限 ${MAX_CANDIDATES_PER_TARGET}（每只目标柜的档数），单柜候选已夹到 ${MAX_CANDIDATES_PER_TARGET} —— 如实说明 requested/allowed，不静默截断`,
    });
  }

  // ③c P9.7 多柜协调候选：同一意图作用到同房间 ≥2 只柜时，额外枚举**整体**候选。
  //     "协调"不是把几份单柜候选拼起来 —— 这里产出的是一份 placements 多项的候选（§六）。
  let generation: CandidateGenerationStats | undefined;
  {
    const takenIds = taken; // 与单柜路径共享编号空间，保证全集合候选 id 唯一
    const coordEntries: CoordinatedEntry[] = [];
    const coordUnresolved: CandidateUnresolved[] = [];
    const rejected: CandidateRejectedCounts = { resolve: 0, collision: 0, duplicate: 0 };
    let explored = 0;
    let budget = COMBO_BUDGET_PER_GROUP;
    let budgetExhausted = false;
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
        const made = coordinatedCandidates(project, intent, group, takenIds, budget - explored);
        coordEntries.push(...made.entries);
        coordUnresolved.push(...made.unresolved);
        rejected.resolve += made.rejected.resolve;
        rejected.collision += made.rejected.collision;
        rejected.duplicate += made.rejected.duplicate;
        explored += made.explored;
        if (made.budgetExhausted) budgetExhausted = true;
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
    const uniqueCoord = coordEntries.filter((e) => {
      const sig = candidateSignature(e.candidate);
      if (seen.has(sig)) {
        rejected.duplicate++; // 与单柜路径撞车也如实计数（恒等式要把每一条丢弃说清楚）
        return false;
      }
      seen.add(sig);
      return true;
    });
    // P9.8 覆盖式返回：按搜索族轮转（**不是** slice(0,N)，也**不是**择优 —— 不看 Score、不做取舍）
    const covered = coverageOrder(uniqueCoord, (e) => e.family).map((e) => e.candidate);
    const returned = covered.slice(0, maxCoordinated);
    const truncated = covered.length - returned.length;
    // 统计只描述协调路径：协调路径没启用 / 没产出时如实缺席（不挂全 0 的假统计）
    if (covered.length > 0) {
      generation = {
        requested: maxCoordinated,
        generated: covered.length,
        returned: returned.length,
        truncated,
        generationLimited: truncated > 0 || clampedMax,
        explored,
        rejected: { ...rejected },
        budget,
        budgetExhausted,
      };
    }
    // ★ 替换而非追加：candidates 里此刻是去重前的 ③ 产出，用 deduped 整体换掉
    candidates.length = 0;
    candidates.push(...deduped, ...returned);
    unresolved.push(...coordUnresolved);
  }

  return { status: 'draft', candidates, unresolved, ...(generation ? { generation } : {}) };
}
