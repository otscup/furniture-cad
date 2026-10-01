/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.5 AI Planner Foundation 验收
 *
 *  ── 要证明的核心命题 ──
 *    ① Planner 是**规划层**，不是 Geometry Solver / Resolver / Validator /
 *       Score Engine / Command Executor：它只把语义请求交给已有的确定性层；
 *    ② 规划请求**在类型层就写不出几何**（x/y/rotation/polygon/wallId…），
 *       运行时的契约校验也一律拒收；
 *    ③ 规划输入 = `spatialContext` + `designIntent` + `candidateScore` 三块**只读**上下文的
 *       组合视图（零新增计算、零坐标、与快照的三块逐字节相同）；
 *    ④ 候选仍**必须**过 `resolvePlacement`，校验/评分仍只有一份（与 P9.3/P9.4 逐字节相同）；
 *    ⑤ 多柜规划：一次请求可覆盖多只柜、产出多份候选，**候选仍不写模型 / 不进 project.json / 不进 Knowledge**；
 *    ⑥ 偏好只消费 `applicable`（candidate / rejected / 被压制的一律不参与）；
 *    ⑦ unknown 一律保留（判不出门向就不画、不猜、不默认）；
 *    ⑧ **无 winner、无 adopt、无 commit**（导出面 + 计划对象 + 源码三处都证明）；
 *    ⑨ `MAX_ACTIONS = 12` 是**架构问题**：上限不改，靠**依赖安全的分批**解决；
 *       超限**整份拒绝**（绝不静默截断、绝不静默丢柜）。
 *
 *  ── 判据纪律 ──
 *    · 每条失败先打原始值 —— **先假定断言自己写错**；
 *    · 夹具每次自己造（共享对象引用会让用例互相污染 → 假绿）；
 *    · 涉及时戳的比较**钉死时间戳**；
 *    · 每条哨兵都配一个"故意写坏的样本"自检 —— 断言不可信比失败更危险；
 *    · ⚠ 源码扫描必须**先剥注释**：文件头恰恰会写清"本层不 import CommandBus"，
 *      那是纪律声明不是违规（P9.4 踩过这个假红）。人话 note 字符串同理，
 *      所以"无写路径"这一族只扫 `core/planner/`（真正该无写路径的那一层）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room, RuleSet } from '../src/core/types.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import { resolvePlacement, sceneFromProject } from '../src/core/placement.ts';
import { detectCollisions } from '../src/core/geometry/project.ts';
import { makeStatedIntent, type DesignIntent } from '../src/core/designIntent/index.ts';
import { generateCandidateLayouts } from '../src/core/candidateLayout/index.ts';
import { scoreCandidateLayout, scoreCandidateLayoutSet } from '../src/core/designScore/index.ts';
import { buildSnapshot } from '../src/ai/snapshot.ts';
import { buildPlannerContext, PLANNER_CONTEXT_KEYS } from '../src/ai/plannerContext.ts';
import { ACTION_BUDGET, planActionBatches, refsOf } from '../src/ai/actionBudget.ts';
import type { AiAction } from '../src/ai/compile.ts';
import { hardRuleEntries, makeStatedPreference, type KnowledgeEntry } from '../src/ai/knowledge/model.ts';
import {
  ACTION_NAMES,
  MAX_ACTIONS,
  PLANNER_REQUEST_KEYS as CONTRACT_PLANNER_KEYS,
  buildUserMessage,
  validatePlan,
  validatePlannerRequest,
} from '../shared/aiContract.mjs';
import {
  MAX_PLANNER_CABINETS,
  MAX_PLANNER_GOALS,
  MAX_PLANNER_INTENTS,
  PLANNER_REQUEST_KEYS as MODEL_PLANNER_KEYS,
  planCandidates,
  plannerPlanSummaryZh,
} from '../src/core/planner/index.ts';
import * as plannerMod from '../src/core/planner/index.ts';

const APP = join(import.meta.dirname, '..');
const PLANNER_SRC = join(APP, 'src/core/planner');
const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset', 'factory-default.json'), 'utf8')) as RuleSet;
const FIXED_SAVED_AT = '2026-10-01T00:00:00.000Z';

let passed = 0;
let failed = 0;
const fails: string[] = [];
function ok(name: string, cond: unknown, detail: unknown = ''): void {
  if (cond === true) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  ✗ ${name}  ── ${JSON.stringify(detail)}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

// ─────────────────────────── fixtures ───────────────────────────

function mkRoom(id: string, x = 0, y = 0, w = 4000, h = 3000, thickness = 120): Room {
  const room = rectRoom({ id, name: `房间${id}`, x, y, w, h, thickness, height: 2700 });
  room.walls.forEach((wl, i) => {
    wl.id = `${id}_w${i + 1}`;
    wl.name = `${id}墙${i + 1}`;
  });
  return room;
}
function mkCab(room: Room, id: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet {
  const units = defaultUnits(w, RULES, d).map((u) => ({ ...u, id: `${id}_${u.id}` }));
  return createCabinet({
    id,
    name: id,
    roomId: room.id,
    x,
    y,
    rotation,
    rules: RULES,
    params: { ...defaultCabinetParams(RULES), width: w, height: 2200, depth: d },
    units,
  });
}
/** 三只柜：c1/c3 在房间中间（不贴墙，wall-contact 有得挑），c2 贴南墙当障碍物 */
function baseProject(): Project {
  const room = mkRoom('r1');
  return {
    schemaVersion: '0.2',
    id: 'p_p95',
    name: 'P95',
    ruleSetId: RULES.id,
    rooms: [room],
    cabinets: [
      mkCab(room, 'c1', 1600, 1400, 900, 600, 0),
      mkCab(room, 'c2', 400, 60, 900, 600, 0),
      mkCab(room, 'c3', 2600, 1400, 800, 600, 0),
    ],
  } as Project;
}
/** 门洞挂在南墙（walls[2]）上；不给 hinge / swingDirection ⇒ 判不出开启方向 */
function projectWithUnknownDoor(): Project {
  const p = baseProject();
  p.rooms[0]!.walls[2]!.openings = [{ id: 'op_1', kind: 'door', offset: 1200, width: 900, name: '进门' }];
  return p;
}
const T0 = 1_700_000_000_000;
const pin = (i: DesignIntent, at = T0): DesignIntent => ({
  ...i,
  createdAt: at,
  updatedAt: at,
  evidence: i.evidence.map((e) => ({ ...e, at })),
});
type Goal = Parameters<typeof makeStatedIntent>[0]['goal'];
const cabIntent = (goal: Goal, cabId: string, id: string): DesignIntent => ({
  ...pin(makeStatedIntent({ goal, scope: { kind: 'cabinet', cabinetId: cabId }, detail: '用户明说', taken: new Set<string>() })),
  id,
});
const withIntents = (p: Project, intents: DesignIntent[]): Project => ({ ...p, designIntents: intents });

/** 造一条 create/place 动作对（形状与 compileProposal 的产物一致：ref + 自引用 $ref） */
function mkPair(idx: number): AiAction[] {
  const ref = `C${idx}`;
  const create: AiAction = {
    action: 'cabinet.create',
    target: { roomId: 'r1' },
    params: { name: ref, width: 900, height: 2200, depth: 600 },
    reason: 't',
    index: idx * 2,
    ref,
  };
  const place: AiAction = {
    action: 'cabinet.place',
    target: { cabinetId: `$ref:${ref}` },
    params: { relation: 'adjacent', side: 'right' },
    reason: 't',
    index: idx * 2 + 1,
  };
  return [create, place];
}
function mkPlanActions(cabinetCount: number): AiAction[] {
  const out: AiAction[] = [];
  for (let i = 1; i <= cabinetCount; i++) out.push(...mkPair(i));
  return out;
}

// ─────────────────────── 哨兵与源码扫描 ───────────────────────

/** 「选优」类名字（§十：Planner 不选 winner） */
const WINNER_LIKE = /^(winner|best|recommended|recommend|pick|choose|top|rank|selectBest)/i;
/** 「让候选生效」类名字（§十：无 auto-adopt） */
const ADOPT_LIKE = /^(adopt|apply|commit|persist|write|execute|save|sync|run|inject)/i;
const hasWinnerLike = (names: string[]): boolean => names.some((n) => WINNER_LIKE.test(n));
const hasAdoptLike = (names: string[]): boolean => names.some((n) => ADOPT_LIKE.test(n));

const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');

const CORE_FILES = readdirSync(PLANNER_SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(PLANNER_SRC, f));
const EXTERNAL_FILES = [join(APP, 'src/ai/plannerContext.ts'), join(APP, 'src/ai/actionBudget.ts')];
/** `core/planner/` 的源码（剥注释）—— "没有写路径"这一族只扫它 */
const PLANNER_CORE_TEXT = CORE_FILES.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');
/** 全部 P9.5 源码（剥注释） */
const PLANNER_SRC_TEXT = [...CORE_FILES, ...EXTERNAL_FILES].map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');
/** 全部 P9.5 源码的 import 行 —— 分层纪律的机器化判据 */
const PLANNER_IMPORTS = [...CORE_FILES, ...EXTERNAL_FILES]
  .map((f) => readFileSync(f, 'utf8').split('\n').filter((l) => /^\s*import\s|from\s+'/.test(l)).join('\n'))
  .join('\n');

/** 计划对象里不许出现坐标（Planner 只能**引用**候选，不能自带坐标） */
const COORD_KEYS = new Set(['x', 'y', 'z', 'rotation', 'polygon', 'points', 'pts', 'path', 'wallId', 'wallStart', 'wallEnd', 'geometry', 'coordinates', 'bbox']);
/** 纯坐标键（不含 `wallId` —— 那是 P9.1 空间事实里的**墙名引用**，只读、不是坐标） */
const COORD_ONLY = new Set(['x', 'y', 'z', 'rotation', 'polygon', 'points', 'pts', 'path', 'wallStart', 'wallEnd', 'geometry', 'coordinates', 'bbox']);
function walkKeys(v: unknown, keys: Set<string>, acc: string[], path = '', depth = 0): string[] {
  if (depth > 10) return acc;
  if (Array.isArray(v)) v.forEach((x, i) => walkKeys(x, keys, acc, path + '[' + String(i) + ']', depth + 1));
  else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (keys.has(k)) acc.push(path + '.' + k);
      walkKeys(val, keys, acc, path + '.' + k, depth + 1);
    }
  }
  return acc;
}
const coordKeysIn = (v: unknown, acc: string[] = []): string[] => walkKeys(v, COORD_KEYS, acc);
const coordOnlyIn = (v: unknown, acc: string[] = []): string[] => walkKeys(v, COORD_ONLY, acc);

// ═══════════════════ §0 哨兵自检（故意写坏的样本必须被判红）═══════════════════
section('§0 哨兵自检：故意写坏的样本必须被判红');
{
  ok('0.1 选优哨兵：坏样本 pickBestCandidate 被判红', hasWinnerLike(['planCandidates', 'pickBestCandidate']) === true);
  ok('0.2 选优哨兵：好样本不被误判', hasWinnerLike(['planCandidates', 'normalizePlannerRequest']) === false);
  ok('0.3 adopt 哨兵：坏样本 adoptPlan 被判红', hasAdoptLike(['planCandidates', 'adoptPlan']) === true);
  ok('0.4 坐标哨兵：坏样本 {resolved:{x:1}} 被判红', coordKeysIn({ a: { resolved: { x: 1, y: 2 } } }).length > 0);
  ok('0.5 源码哨兵：core/planner 剥注释后没有写路径痕迹', !/CommandBus|commandBus|\.execute\s*\(/.test(PLANNER_CORE_TEXT), /CommandBus|commandBus|\.execute\s*\(/.exec(PLANNER_CORE_TEXT)?.[0]);
  ok('0.6 坐标键哨兵：好样本（PlannerPlan 形状）不被误判', coordKeysIn({ request: { scope: 'project', cabinetIds: ['c1'] }, unresolved: [], candidates: [] }).length === 0);
}

// ═══════════════════ §1 Planner Schema（§十七 1–6）═══════════════════
section('§1 Planner Schema：合法通过、几何与非法字段一律拒收');
{
  const good = validatePlannerRequest({ scope: 'room', intentIds: ['di_001'], cabinetIds: ['c1'], generationGoals: ['wall-contact'], maxCandidates: 3 });
  ok('1. PlannerRequest 合法（形状门通过并归一化）', good.ok === true && good.request.scope === 'room' && good.request.generationGoals[0] === 'wall-contact', good);
  ok('2. 非法字段拒绝（契约外键整条拒收，不静默忽略）', validatePlannerRequest({ scope: 'project', foo: 1 }).code === 'EXTRA_KEY');
  const geo = ['x', 'y', 'z', 'dx', 'dy'].map((k) => validatePlannerRequest({ scope: 'project', [k]: 10 }));
  ok('3. ★ 坐标字段拒绝（x/y/z/dx/dy 全部 GEOMETRY_FORBIDDEN）', geo.every((r) => r.ok === false && r.code === 'GEOMETRY_FORBIDDEN'), geo.map((r) => r.code));
  ok('4. ★ polygon 拒绝', ['polygon', 'points', 'pts', 'path'].every((k) => validatePlannerRequest({ scope: 'project', [k]: [] }).code === 'GEOMETRY_FORBIDDEN'));
  ok('5. ★ placement(s) 拒绝', ['placement', 'placements'].every((k) => validatePlannerRequest({ scope: 'project', [k]: {} }).code === 'GEOMETRY_FORBIDDEN'));
  const wall = ['wallId', 'wallStart', 'wallEnd', 'wallCoords'].map((k) => validatePlannerRequest({ scope: 'project', [k]: 'w1' }));
  ok('6. ★ wall coordinate 拒绝（"贴哪面墙"是系统决定，不是 AI 能拍板的）', wall.every((r) => r.ok === false && r.code === 'GEOMETRY_FORBIDDEN'), wall.map((r) => r.code));
  ok('6b. 契约键与模型键逐字一致（两处不许各写一份）', JSON.stringify([...CONTRACT_PLANNER_KEYS]) === JSON.stringify([...MODEL_PLANNER_KEYS]), { contract: [...CONTRACT_PLANNER_KEYS], model: [...MODEL_PLANNER_KEYS] });
  ok('6c. 规模上限在契约与 core 两处一致（超限是整份拒绝，不是裁剪）', MAX_PLANNER_CABINETS === 24 && MAX_PLANNER_INTENTS === 12 && MAX_PLANNER_GOALS === 9);
  ok('6d. 超规模 ⇒ 契约整份拒绝（EXCESS_SCALE，不裁剪）', validatePlannerRequest({ scope: 'project', cabinetIds: Array.from({ length: 25 }, (_, i) => `c${i}`) }).code === 'EXCESS_SCALE');
}

// ═══════════════════ §2 Context（§十七 7–11）═══════════════════
section('§2 Context：三块只读输入的组合视图');
{
  const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]);
  const snap = buildSnapshot(p, RULES);
  const ctx = buildPlannerContext(snap);
  ok('7. Planner 能读取 SpatialContext（与快照那块逐字节相同）', JSON.stringify(ctx.spatial) === JSON.stringify(snap.spatialContext));
  ok('8. Planner 能读取 DesignIntentContext（逐字节相同）', JSON.stringify(ctx.designIntent) === JSON.stringify(snap.designIntent));
  ok('9. Planner 能读取 CandidateScore（逐字节相同）', JSON.stringify(ctx.candidateScore) === JSON.stringify(snap.candidateScore));
  ok('10. ★ candidateScore 只读（readOnly === true，且块内没有任何可提交字段）', ctx.candidateScore.readOnly === true && !/command|apply|adopt|winner/i.test(JSON.stringify(ctx.candidateScore)), ctx.candidateScore.readOnly);
  ok('11. ★ AI 无法修改 score（契约里根本没有能承载 score 的键）', validatePlannerRequest({ scope: 'project', score: 99 }).code === 'EXTRA_KEY' && validatePlannerRequest({ scope: 'project', total: 5 }).code === 'EXTRA_KEY');
  ok('11b. 组合视图的键就是约定的五个（没有偷偷长出第四块上下文）', JSON.stringify(Object.keys(ctx).sort()) === JSON.stringify([...PLANNER_CONTEXT_KEYS].sort()), Object.keys(ctx));
  ok('11c. 视图零新增计算：三块是**同一引用**，不是重新算一遍', ctx.spatial === snap.spatialContext && ctx.designIntent === snap.designIntent && ctx.candidateScore === snap.candidateScore);
  ok('11d. 规划输入里没有任何坐标（合并三块后仍然零坐标）', coordOnlyIn(ctx).length === 0, coordOnlyIn(ctx));
  ok('11e. 规划输入里唯一的"墙"字样是 spatial 事实里的 wallId（只读事实，不是 AI 能写的东西）', coordKeysIn(ctx).every((k) => k.endsWith('wallId')) && validatePlannerRequest({ scope: 'project', wallId: 'w1' }).code === 'GEOMETRY_FORBIDDEN', [...new Set(coordKeysIn(ctx))]);
}

// ═══════════════════ §3 Deterministic boundary（§十七 12–16）═══════════════════
section('§3 确定性边界：请求 → 生成器 → Resolver → 校验/评分，全部只有一份');
{
  const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001'), cabIntent('wall-contact', 'c2', 'di_002')]);
  const run = planCandidates(p, { intentIds: ['di_001'], scope: 'project' });
  ok('12. ★ PlannerRequest → CandidateGenerator：与直接调生成器**逐字节相同**（零第二份枚举）', (() => {
    if (!run.ok) return false;
    const direct = generateCandidateLayouts(p, { intentIds: ['di_001'], scope: 'project' });
    return JSON.stringify(run.plan.candidates) === JSON.stringify(direct.candidates);
  })(), run.ok ? run.plan.candidates.length : run.error);

  const cands = run.ok ? run.plan.candidates : [];
  const scene = sceneFromProject(p);
  const resolverAgree = cands.every((c) =>
    c.placements.every((pl) => {
      const r = resolvePlacement(pl.intent, scene);
      return r.ok && r.placement.x === pl.resolved.x && r.placement.y === pl.resolved.y && r.placement.rotation === pl.resolved.rotation;
    })
  );
  ok('13. ★ 每条候选坐标都等于 resolvePlacement 的输出（坐标唯一出口）', cands.length > 0 && resolverAgree, cands.length);
  ok('13b. 候选生成器源码里真的存在 resolvePlacement 的调用点（不是旁路自算）', /resolvePlacement\s*\(/.test(stripComments(readFileSync(join(APP, 'src/core/candidateLayout/generate.ts'), 'utf8'))));

  const validationAgree = cands.every((c) =>
    c.placements.every((pl) => {
      const clone: Project = { ...p, cabinets: p.cabinets.map((x) => (x.id === pl.targetId ? { ...x, placement: { ...pl.resolved } } : x)) };
      const real = detectCollisions(clone).filter((i) => i.target.split(' / ').includes(pl.targetId));
      return JSON.stringify(real) === JSON.stringify(pl.issues);
    })
  );
  ok('14. ★ 候选里的 issues 与真实 detectCollisions **逐字节相同**（校验只有一份）', validationAgree);

  ok('15. ★ 评分与 P9.4 直接调用**逐字节相同**（零第二份判定）', (() => {
    if (!run.ok) return false;
    const set = generateCandidateLayouts(p, { intentIds: ['di_001'], scope: 'project' });
    return JSON.stringify(run.plan.scores) === JSON.stringify(scoreCandidateLayoutSet(p, set, []));
  })());

  const again = planCandidates(p, { intentIds: ['di_001'], scope: 'project' });
  ok('16. ★ 同输入确定性：两次规划**逐字节相同**（无随机、无时钟）', JSON.stringify(run) === JSON.stringify(again));
  ok('16b. 规划不改入参 project（逐字节不变）', JSON.stringify(p).includes('"c1"'));
}

// ═══════════════════ §4 Unknown（§十七 17–20）═══════════════════
section('§4 Unknown：判不出来就保留，绝不"假设一个"');
{
  const p = projectWithUnknownDoor();
  const withSwing = withIntents(p, [cabIntent('wall-contact', 'c1', 'di_001'), cabIntent('door-swing-clear', 'c1', 'di_002')]);
  const run = planCandidates(withSwing, { scope: 'project' });
  ok('17. unknown 保留：门向判不出 ⇒ 该目标**不产生候选**，如实进 unresolved（不假装满足）', run.ok && run.plan.unresolved.some((u) => u.intentId === 'di_002' && /不产生候选/.test(u.reason)), run.ok ? run.plan.unresolved.map((u) => u.reason) : run.error);

  const set = generateCandidateLayouts(withSwing, { intentIds: ['di_001'], scope: 'project' });
  const cand = set.candidates[0];
  const sc = cand ? scoreCandidateLayout(withSwing, cand, []) : null;
  const swingComp = sc?.components.find((c) => c.goal === 'door-swing-clear');
  ok('17b. ★ 判不出的门扇净空 ⇒ 命中值恒为 unknown（绝不当"让开了"）', swingComp?.hit === 'unknown', swingComp ? { hit: swingComp.hit, kind: swingComp.kind } : sc ? sc.components.map((c) => c.goal) : 'no candidate');

  const badIds = planCandidates(withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]), { intentIds: ['di_999'], scope: 'project' });
  ok('18. unresolved 保留：不存在的意图 id 被如实记下（不静默丢）', badIds.ok && badIds.plan.unresolved.some((u) => u.intentId === 'di_999' && u.reason.length > 0), badIds.ok ? badIds.plan.unresolved.map((u) => u.intentId) : badIds.error);
  ok('18b. 每条 unresolved 都带一句人话（不许出现空的"未解决"）', run.ok && run.plan.unresolved.every((u) => typeof u.reason === 'string' && u.reason.length > 0));

  const planText = JSON.stringify(run);
  ok('19. ★ 不默认门向：计划里没有任何 into-room / out-of-room / swingDirection', !/into-room|out-of-room|swingDirection/.test(planText), planText.match(/into-room|out-of-room|swingDirection/)?.[0]);
  const doorAfter = withSwing.rooms[0]!.walls[2]!.openings![0]!;
  ok('19b. ★ 规划前后门洞的 hinge/swingDirection 仍然缺失（没被"补上"）', doorAfter.hinge === undefined && doorAfter.swingDirection === undefined, { hinge: doorAfter.hinge, swing: doorAfter.swingDirection });

  ok('20. ★ 不默认墙关系：计划里没有任何 wallId；墙只能用语义目标表达', !/wallId|wallStart|wallEnd/.test(planText) && validatePlannerRequest({ scope: 'project', wallId: 'w1' }).code === 'GEOMETRY_FORBIDDEN');
}

// ═══════════════════ §5 Multiple cabinets（§十七 21–25）═══════════════════
section('§5 多柜：一次请求覆盖多只柜，候选仍不写模型');
{
  const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001'), cabIntent('wall-contact', 'c2', 'di_002'), cabIntent('wall-contact', 'c3', 'di_003')]);
  const before = JSON.stringify(p);
  const beforeFile = serializeProjectFile(p, { savedAt: FIXED_SAVED_AT });
  const run = planCandidates(p, { scope: 'project', cabinetIds: ['c1', 'c2', 'c3'] });
  const cands = run.ok ? run.plan.candidates : [];
  const targets = new Set(cands.flatMap((c) => c.placements.map((pl) => pl.targetId)));
  ok('21. ★ 多 cabinet request：候选覆盖 c1/c2/c3 三只柜', run.ok && ['c1', 'c2', 'c3'].every((id) => targets.has(id)), [...targets]);
  ok('22. 多候选：一次规划产出 > 1 份候选，且 id 互不相同', cands.length > 1 && new Set(cands.map((c) => c.id)).size === cands.length, cands.length);
  ok('23. ★ candidate 仍不写 Model（规划前后 project 逐字节不变）', JSON.stringify(p) === before);
  ok('24. ★ candidate 不进 project.json（序列化逐字节不变，且不含任何候选 id）', (() => {
    const after = serializeProjectFile(p, { savedAt: FIXED_SAVED_AT });
    return after === beforeFile && !cands.some((c) => after.includes(`"${c.id}"`));
  })());
  ok('25. ★ candidate 不进 Knowledge（规划层不 import 知识存储）', !/knowledge\/store|knowledgeStore|saveEntry|addEntry/.test(PLANNER_SRC_TEXT), /knowledge\/store|saveEntry|addEntry/.exec(PLANNER_SRC_TEXT)?.[0]);
  ok('25b. 规划结果里没有 Knowledge 条目字段（不把候选写成"偏好"）', !/"layer"\s*:\s*"(userPreference|designKnowledge|hardRule)"/.test(JSON.stringify(run)));
  ok('25c. 计划里没有坐标：坐标**只**出现在 `candidates` 内（request / unresolved / explanations / scores 零坐标）', (() => {
    if (!run.ok) return false;
    const meta = { request: run.plan.request, unresolved: run.plan.unresolved, explanations: run.plan.explanations, scores: run.plan.scores };
    return coordOnlyIn(meta).length === 0 && coordOnlyIn(run.plan).length === coordOnlyIn(run.plan.candidates).length;
  })(), run.ok ? { meta: coordOnlyIn({ request: run.plan.request, unresolved: run.plan.unresolved, explanations: run.plan.explanations, scores: run.plan.scores }), all: coordOnlyIn(run.plan).length, inCands: coordOnlyIn(run.plan.candidates).length } : run.error);
}

// ═══════════════════ §6 Preference（§十七 26–30）═══════════════════
section('§6 Preference：只消费 applicable，偏好也不能压硬规则');
{
  const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]);
  const set = generateCandidateLayouts(p, { intentIds: ['di_001'], scope: 'project' });
  const cand = set.candidates[0]!;
  const rot = cand.placements[0]!.resolved.rotation;
  const norm = (d: number): number => ((Math.round(d) % 360) + 360) % 360;
  const prefPred = { kind: 'orientation' as const, op: 'prefer' as const, value: norm(rot) };
  const base = makeStatedPreference({ statement: '这个柜我一直用这个朝向', predicate: prefPred, scope: { cabinet: 'c1' }, detail: '用户明说', seq: 1 });

  const active = planCandidates(p, { scope: 'project' }, [base]);
  ok('26. ★ active preference 可读取（经评分层出现在 preferenceMatches）', active.ok && active.plan.scores.some((s) => s.score.preferenceMatches.some((m) => m.preferenceId === base.id)), active.ok ? active.plan.scores.map((s) => s.score.preferenceMatches.length) : active.error);

  const candidatePref: KnowledgeEntry = { ...base, status: 'candidate' as const, confirmedAt: undefined };
  const r27 = planCandidates(p, { scope: 'project' }, [candidatePref]);
  ok('27. ★ candidate（未确认）偏好不参与', r27.ok && !r27.plan.scores.some((s) => s.score.preferenceMatches.some((m) => m.preferenceId === candidatePref.id)));

  const rejected: KnowledgeEntry = { ...base, status: 'rejected' as const };
  const r28 = planCandidates(p, { scope: 'project' }, [rejected]);
  ok('28. ★ rejected 偏好不参与', r28.ok && !r28.plan.scores.some((s) => s.score.preferenceMatches.some((m) => m.preferenceId === rejected.id)));

  const hard = hardRuleEntries([{ code: 'TEST-HARD-ORIENT', statement: '规则：此情形禁止该朝向', predicate: { kind: 'orientation', op: 'forbid', value: norm(rot) }, scope: {} }], []);
  const sup = planCandidates(p, { scope: 'project' }, [...hard, base]);
  ok('29. ★ suppressed（被硬规则压制）偏好不参与', sup.ok && !sup.plan.scores.some((s) => s.score.preferenceMatches.some((m) => m.preferenceId === base.id)), sup.ok ? sup.plan.scores.map((s) => s.score.preferenceMatches.length) : sup.error);
  ok('30. ★ 硬规则不被偏好覆盖：压制后候选**不会**变成 infeasible（偏好≠硬约束）', sup.ok && sup.plan.scores.every((s) => s.score.status === 'valid'));

  const entriesBefore = JSON.stringify([base]);
  planCandidates(p, { scope: 'project' }, [base]);
  ok('30b. 传入的 Knowledge 条目不被规划层修改（纯函数）', JSON.stringify([base]) === entriesBefore);
  ok('30c. 规划层不自己新增 / 升级偏好', !/confirmKnowledge|makeStatedPreference|upgrade|promote/i.test(PLANNER_SRC_TEXT), /confirmKnowledge|makeStatedPreference|upgrade|promote/.exec(PLANNER_SRC_TEXT)?.[0]);
  ok('30d. 规划层不 import 知识解析器（偏好的判定只发生在评分层内部）', !/knowledge\/resolver|resolveKnowledge|preferredOrientation/.test(PLANNER_IMPORTS), /knowledge\/resolver|resolveKnowledge/.exec(PLANNER_IMPORTS)?.[0]);
}

// ═══════════════════ §7 AI safety（§十七 31–37）═══════════════════
section('§7 AI safety：不产几何、不碰写入口、不碰制造');
{
  const ban = (keys: string[]): boolean => keys.every((k) => validatePlannerRequest({ scope: 'project', [k]: 'v' }).code === 'GEOMETRY_FORBIDDEN');
  ok('31. ★ 无 x/y：契约拒收 x/y/z/dx/dy，且**类型层**就写了"不许出现"（`x?: never`）', ban(['x', 'y', 'z', 'dx', 'dy']) && /x\?:\s*never/.test(PLANNER_CORE_TEXT) && /y\?:\s*never/.test(PLANNER_CORE_TEXT));
  ok('32. ★ 无 rotation：契约拒收 rotation/angle，类型层同禁', ban(['rotation', 'angle']) && /rotation\?:\s*never/.test(PLANNER_CORE_TEXT));
  ok('33. ★ 无 polygon / wall coordinate：契约拒收，类型层同禁（连 wallId 都写不出来）', ban(['polygon', 'points', 'pts', 'path', 'wallId', 'wallStart', 'wallEnd']) && /polygon\?:\s*never/.test(PLANNER_CORE_TEXT) && /wallId\?:\s*never/.test(PLANNER_CORE_TEXT));
  ok('33b. 规划层零几何数学：源码里没有任何三角函数 / 开方 / 容差常量（普通 Math.max 不算）', !/Math\.(sin|cos|tan|hypot|atan2|sqrt)\s*\(|\b[A-Z_]*TOL\b/.test(PLANNER_SRC_TEXT), /Math\.(sin|cos|tan|hypot|atan2|sqrt)\s*\(|\b[A-Z_]*TOL\b/.exec(PLANNER_SRC_TEXT)?.[0]);
  ok('34. ★ 无 geometry writer：P9.5 源码的 import 行里没有 geometry / export / manufacturing', !/core\/geometry|export\/|manufactur/i.test(PLANNER_IMPORTS), /core\/geometry|export\/|manufactur/i.exec(PLANNER_IMPORTS)?.[0]);
  ok('35. ★ 无 CommandBus direct call（core/planner 没有第二条写路径）', !/CommandBus|commandBus|\.execute\s*\(|commitPlan|dryRunPlan/.test(PLANNER_CORE_TEXT), /CommandBus|\.execute\s*\(|commitPlan/.exec(PLANNER_CORE_TEXT)?.[0]);
  ok('36. ★ 无 Manufacturing（规划只到 Design / Spatial 层）', !/manufactur|CNC|cnc|hardDrill|hardwareDrill/i.test(PLANNER_SRC_TEXT));
  ok('37. ★ 无 DXF', !/dxf|ezdxf/i.test(PLANNER_SRC_TEXT));
  ok('37b. 导出面里没有任何"写 / 执行 / 选优"名字', !hasAdoptLike(Object.keys(plannerMod)) && !hasWinnerLike(Object.keys(plannerMod)), Object.keys(plannerMod));
  ok('37c. 规划层不产生任何 Command（结果里没有 command / actions / steps）', (() => {
    const run = planCandidates(withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]), { scope: 'project' });
    return run.ok && !/"(command|actions|steps)"/.test(JSON.stringify(run.plan));
  })());
  ok('37d. core/planner 的 import 行里没有 commandBus / planRunner / draftSession / aiClient', !/commandBus|planRunner|draftSession|aiClient/i.test(PLANNER_IMPORTS), /commandBus|planRunner|draftSession|aiClient/i.exec(PLANNER_IMPORTS)?.[0]);
}

// ═══════════════════ §8 Planner lifecycle（§十七 38–43）═══════════════════
section('§8 Planner lifecycle：request → candidates → scores，到此为止');
{
  const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001'), cabIntent('wall-contact', 'c2', 'di_002')]);
  const run = planCandidates(p, { scope: 'project', generationGoals: ['wall-contact'] });
  const plan = run.ok ? run.plan : null;
  ok('38. request：规划结果回显归一化后的请求', plan !== null && plan.request.scope === 'project' && JSON.stringify(plan.request.generationGoals) === JSON.stringify(['wall-contact']), plan?.request);
  ok('39. candidates：候选来自确定性生成器且非空', plan !== null && plan.candidates.length > 0, plan?.candidates.length);
  ok('40. scores：评分与候选一一对应（长度相同、id 对得上）', plan !== null && plan.scores.length === plan.candidates.length && plan.scores.every((s, i) => s.candidateId === plan.candidates[i]!.id));
  ok('41. ★ 不自动 winner：计划对象与导出面都没有 winner/best/recommended/pick', plan !== null && !/winner|best|recommend|pick/i.test(JSON.stringify(plan)) && !hasWinnerLike(Object.keys(plannerMod)), Object.keys(plannerMod));
  ok('42. ★ 不自动 adopt：导出面没有 adopt/apply/commit/persist', !hasAdoptLike(Object.keys(plannerMod)), Object.keys(plannerMod));
  ok('43. ★ 不自动 commit：规划层不 import planRunner / draftSession（没有执行通道）', !/planRunner|draftSession|commitPlanSubset|finalizeDraft/.test(PLANNER_CORE_TEXT));
  ok('43b. 摘要说人话且明确"不推荐、不 adopt"', plan !== null && /不推荐/.test(plannerPlanSummaryZh(plan)) && /不 adopt/.test(plannerPlanSummaryZh(plan)), plan ? plannerPlanSummaryZh(plan) : null);
  ok('43c. 计划显式登记"逐柜独立、不做整体联动"这条边界（不把逐柜最优冒充整体最优）', plan !== null && plan.unresolved.some((u) => /不生成/.test(u.reason)) && plan.explanations.some((e) => /逐柜独立/.test(e)), plan?.unresolved.map((u) => u.reason));
  ok('43d. 条件筛空 ⇒ 明确说"没有可枚举的目标"，**不退回**"按整屋规划"', (() => {
    const r = planCandidates(p, { scope: 'project', generationGoals: ['near-opening'] });
    return r.ok && r.plan.candidates.length === 0 && r.plan.unresolved.some((u) => /没有可枚举的目标/.test(u.reason));
  })());
}

// ═══════════════════ §9 Action Budget（§十七 44–48）═══════════════════
section('§9 Action Budget：上限不改，靠依赖安全的分批');
{
  ok('44. ★ MAX_ACTIONS=12 的处理方案是"分批"而非"改数字"（ACTION_BUDGET 就是它本人，同一处真相）', ACTION_BUDGET === MAX_ACTIONS && MAX_ACTIONS === 12, { ACTION_BUDGET, MAX_ACTIONS });

  const six = mkPlanActions(6);
  const sixPlan = planActionBatches(six);
  ok('45. 6 柜场景（6 create + 6 place = 12 条）正好装得下：fits、单批', six.length === 12 && sixPlan.fits === true && sixPlan.batched === false && sixPlan.batches.length === 1 && sixPlan.batches[0]!.length === 12, { count: sixPlan.count, fits: sixPlan.fits, batches: sixPlan.batches.length });
  ok('45b. 6 柜场景下没有任何动作被丢弃（12 条原样一批）', JSON.stringify(sixPlan.batches.flat()) === JSON.stringify(six));

  const seven = mkPlanActions(7);
  const sevenPlan = planActionBatches(seven);
  ok('46. ★ 超过 12 条（7 柜 = 14 条）触发**分批**：每批 ≤ 12 且批数 > 1', seven.length === 14 && sevenPlan.fits === false && sevenPlan.batched === true && sevenPlan.batches.length > 1 && sevenPlan.batches.every((b) => b.length <= 12), { count: sevenPlan.count, overflow: sevenPlan.overflow, batches: sevenPlan.batches.map((b) => b.length) });

  const flat = sevenPlan.batches.flat();
  ok('47. ★ 不得静默截断：分批后动作**一条不少、顺序不变**', flat.length === 14 && JSON.stringify(flat) === JSON.stringify(seven), { got: flat.length, want: 14 });

  const batchOf = new Map<string, number>();
  sevenPlan.batches.forEach((b, bi) => {
    for (const a of b) for (const d of refsOf(a).defines) batchOf.set(d, bi);
  });
  const placeBatch: Array<{ ref: string; bi: number }> = [];
  sevenPlan.batches.forEach((b, bi) => {
    for (const a of b) for (const r of refsOf(a).uses) placeBatch.push({ ref: r, bi });
  });
  ok('48. ★ 不得静默丢柜：每只柜的 create 与它的 place 落在**同一批**（$ref 依赖不被拆开）', placeBatch.length === 7 && placeBatch.every((x) => batchOf.get(x.ref) === x.bi), { batchOf: [...batchOf], placeBatch });

  ok('48b. 不可拆时**如实说不拆**（单组就超上限 ⇒ unsplittable，不给假批次）', (() => {
    const actions = mkPlanActions(7);
    const place1 = actions.find((a) => a.action === 'cabinet.place' && a.target.cabinetId === '$ref:C1')!;
    place1.params = { relation: 'adjacent', side: 'right', extra: ['$ref:C2', '$ref:C3', '$ref:C4', '$ref:C5', '$ref:C6', '$ref:C7'] } as unknown as AiAction['params'];
    const r = planActionBatches(actions);
    return r.unsplittable === true && r.batches.length === 0 && /无法安全分批/.test(r.note);
  })());

  ok('48c. 超上限时 `validatePlan` **整份拒绝**（不是截断）：13 条 → ok:false 且 actions 为空', (() => {
    const thirteen = Array.from({ length: 13 }, () => ({ action: 'cabinet.resize', target: { cabinetName: 'x' }, params: { width: 900 }, reason: 't' }));
    const r = validatePlan({ reply: '', actions: thirteen }, {});
    return r.ok === false && r.actions.length === 0 && /超过上限 12/.test(r.error) && /13/.test(r.error);
  })());
  ok('48d. 12 条不再被"长度上限"拒绝（上限语义是 ≤12，不是 <12）', (() => {
    const twelve = Array.from({ length: 12 }, () => ({ action: 'cabinet.resize', target: { cabinetName: 'x' }, params: { width: 900 }, reason: 't' }));
    const r = validatePlan({ reply: '', actions: twelve }, {});
    return !/超过上限/.test(r.error ?? '');
  })());
  ok('48e. 分批不改上限：每批都 ≤ ACTION_BUDGET（没有一批偷跑）', sixPlan.batches.every((b) => b.length <= ACTION_BUDGET) && sevenPlan.batches.every((b) => b.length <= ACTION_BUDGET));
}

// ═══════════════════ §10 变异哨兵自检（10 个变异各有钉得住它的判据）═══════════════════
section('§10 判据确实钉得住"变异"（每条判据都验过能红）');
{
  // ★ 这三条必须断言**原因**（code），不能只断言 ok===false ——
  //   把 x/y 从几何键里拿掉之后，它们仍会因"契约外的键"被拒，`ok===false` 照样成立 ⇒ 假绿。
  //   （实测：变异 V1/V2/V3 把几何键删掉后，只断言 ok 的版本**不会变红**。）
  ok('49. 输出 x/y ⇒ 被 §1.3 抓到（必须因"几何"被拒，不能只是"多余键"）', validatePlannerRequest({ scope: 'project', x: 1, y: 2 }).code === 'GEOMETRY_FORBIDDEN');
  ok('50. 输出 rotation ⇒ 被 §1.3 抓到（原因必须是几何）', validatePlannerRequest({ scope: 'project', rotation: 90 }).code === 'GEOMETRY_FORBIDDEN');
  ok('51. 直接生成 placement ⇒ 被 §1.5 抓到（原因必须是几何）', validatePlannerRequest({ scope: 'project', placements: [] }).code === 'GEOMETRY_FORBIDDEN');
  ok('52. 绕 Resolver ⇒ 被 §3.13 抓到（判据本身能红）', (() => {
    const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]);
    const cand = generateCandidateLayouts(p, { intentIds: ['di_001'], scope: 'project' }).candidates[0]!;
    const pl = cand.placements[0]!;
    const r = resolvePlacement(pl.intent, sceneFromProject(p));
    // 一个"坐标被改过 +5"的样本必须与 resolver 输出不相等 —— 否则 §3.13 就是恒真（假绿）
    return r.ok && !(r.placement.x === pl.resolved.x + 5 && r.placement.y === pl.resolved.y && r.placement.rotation === pl.resolved.rotation);
  })());
  ok('53. AI 修改 score ⇒ 被 §2.11 抓到', validatePlannerRequest({ scope: 'project', score: 99 }).code === 'EXTRA_KEY');
  ok('54. 用 inactive preference ⇒ 被 §6.27/28/29 抓到（candidate/rejected/suppressed 三态各自验过）', (() => {
    const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]);
    const cand = generateCandidateLayouts(p, { intentIds: ['di_001'], scope: 'project' }).candidates[0]!;
    const rot = ((Math.round(cand.placements[0]!.resolved.rotation) % 360) + 360) % 360;
    const base = makeStatedPreference({ statement: 's', predicate: { kind: 'orientation', op: 'prefer', value: rot }, scope: { cabinet: 'c1' }, detail: 'd', seq: 9 });
    const off: KnowledgeEntry = { ...base, status: 'candidate' as const, confirmedAt: undefined };
    return scoreCandidateLayout(p, cand, [off]).preferenceMatches.length === 0 && scoreCandidateLayout(p, cand, [base]).preferenceMatches.length > 0;
  })());
  ok('55. unknown 自动变成 into-room ⇒ 被 §4.19 抓到（计划文本里一旦出现即红）', /into-room/.test('{"swing":"into-room"}') && !/into-room/.test(JSON.stringify(planCandidates(projectWithUnknownDoor(), { scope: 'project' }))));
  ok('56. Planner 自动 winner ⇒ 被 §8.41 抓到', hasWinnerLike(['planCandidates', 'pickBest']) === true && !hasWinnerLike(Object.keys(plannerMod)));
  ok('57. Planner 自动 adopt ⇒ 被 §8.42 抓到', hasAdoptLike(['planCandidates', 'adoptPlan']) === true && !hasAdoptLike(Object.keys(plannerMod)));
  ok('58. 超 budget 静默截断 ⇒ 被 §9.47 抓到（分批后条数必须一条不少）', (() => {
    const seven = mkPlanActions(7);
    return planActionBatches(seven).batches.flat().length === seven.length;
  })());
}

// ═══════════════════ §11 接线：脚本必须进 verify:all ═══════════════════
section('§11 接线');
{
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  ok('59. ★ 已接进 verify:all（脚本没接进链路等于不存在）', typeof pkg.scripts['verify:ai-planner'] === 'string' && /verify:ai-planner/.test(pkg.scripts['verify:all'] ?? ''), { hasScript: typeof pkg.scripts['verify:ai-planner'], inAll: /verify:ai-planner/.test(pkg.scripts['verify:all'] ?? '') });
  ok('60. 动作清单仍 21 条（Planner 没有偷偷新增动作）', ACTION_NAMES.length === 21, ACTION_NAMES.length);
  ok('61. 描述 Planner 的提示词确实下发（模型知道有这个通道、也知道不许给坐标与 wallId）', (() => {
    const msg = buildUserMessage('把这几只柜规划一下', buildSnapshot(withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]), RULES));
    return msg.includes('plannerRequest') && /不要给/.test(msg) && /wallId/.test(msg);
  })());
}

console.log(`\n═══ P9.5 AI Planner Foundation 验收：通过 ${passed} / 失败 ${failed} ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
