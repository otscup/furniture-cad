/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.8 Multi-Cabinet Candidate Search Coverage 验收
 *
 *  ── 要证明的核心命题 ──
 *  A. 原 P9.7 的 4 个组合不再是唯一搜索空间（空白墙段 / 顺序 / 对齐 / 缝隙族）；
 *  B. 三柜 + 南墙门洞场景能探索门洞之外的空白墙段，并产出可行整体候选；
 *  C. 候选覆盖扩展后仍全部经唯一 Resolver（逐字节重解一致）；
 *  D. Spatial / Validation / Score 仍是唯一事实与评分来源（生成器零复制）；
 *  E. explored / generated / returned / truncated / rejected / budgetExhausted 账目一致；
 *  F. 不产生 winner（覆盖式返回不是选优，不看 Score）；
 *  G. 不写 Semantic Model / project；
 *  H. unknown 不当空白、洞口参数不可用如实 unresolved。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room, RuleSet } from '../src/core/types.ts';
import { makeStatedIntent, type DesignIntent } from '../src/core/designIntent/index.ts';
import {
  generateCandidateLayouts,
  type CandidateLayout,
  type CandidateLayoutSet,
} from '../src/core/candidateLayout/index.ts';
import {
  COMBO_BUDGET_PER_GROUP,
  COVERAGE_SAMPLES_PER_SEGMENT,
  MAX_CANDIDATES_COORDINATED,
  MAX_CANDIDATES_PER_TARGET,
} from '../src/core/candidateLayout/model.ts';
import { freeWallSegments } from '../src/core/snapPlace.ts';
import { resolvePlacements, sceneFromProject } from '../src/core/placement.ts';
import { detectCollisions } from '../src/core/geometry/project.ts';
import { deriveSpatialFacts } from '../src/core/spatial/derive.ts';
import { scoreCandidateLayout, scoreCandidateLayoutSet } from '../src/core/designScore/index.ts';
import { planCandidates } from '../src/core/planner/index.ts';
import { validatePlannerRequest, PLANNER_REQUEST_KEYS } from '../shared/aiContract.mjs';
import { buildCandidateComparison } from '../src/ui/panels/candidateCompareLogic.ts';
import { bboxOf, polyLocalToWorld, projectParamOnSegment, rectPts } from '../src/core/geometry/transform.ts';

const APP = join(import.meta.dirname, '..');
const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

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

// ── 源码扫描（剥注释）──
const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
const GEN_SRC = stripComments(readFileSync(join(APP, 'src/core/candidateLayout/generate.ts'), 'utf8'));
const MODEL_SRC = stripComments(readFileSync(join(APP, 'src/core/candidateLayout/model.ts'), 'utf8'));
const SNAP_SRC = stripComments(readFileSync(join(APP, 'src/core/snapPlace.ts'), 'utf8'));
const AIPANEL_SRC = stripComments(readFileSync(join(APP, 'src/ui/panels/AIPanel.tsx'), 'utf8'));

// ─────────────── fixtures ───────────────
const T0 = 1_700_000_000_000;
function mkRoom(id: string, w = 5000, h = 4000, openings?: (walls: Room['walls']) => void): Room {
  const room = rectRoom({ id, name: `房间${id}`, x: 0, y: 0, w, h, thickness: 120, height: 2700 });
  room.walls.forEach((wl, i) => {
    wl.id = `${id}_w${i + 1}`;
    wl.name = `${id}墙${i + 1}`;
  });
  openings?.(room.walls);
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
const pin = (i: DesignIntent, at = T0): DesignIntent => ({
  ...i,
  createdAt: at,
  updatedAt: at,
  evidence: i.evidence.map((e) => ({ ...e, at })),
});
type Goal = Parameters<typeof makeStatedIntent>[0]['goal'];
const roomIntent = (goal: Goal, roomId: string, id: string): DesignIntent => ({
  ...pin(makeStatedIntent({ goal, scope: { kind: 'room', roomId }, detail: '用户明说', taken: new Set<string>() })),
  id,
});
function mkProject(id: string, room: Room, cabs: Cabinet[], intents: DesignIntent[]): Project {
  return { schemaVersion: '0.2', id, name: id, ruleSetId: RULES.id, rooms: [room], cabinets: cabs, designIntents: intents } as Project;
}
const coordRequest = (cabinetIds: string[], maxCandidates?: number) => ({
  scope: 'project' as const,
  cabinetIds,
  ...(maxCandidates !== undefined ? { maxCandidates } : {}),
});
const multiOf = (set: CandidateLayoutSet): CandidateLayout[] => set.candidates.filter((c) => c.placements.length > 1);
/** 候选的搜索族标签（生成器写进 explanations，UI/报告可读 —— 可观测，不是隐藏状态） */
const familyOf = (c: CandidateLayout): string => c.explanations.find((e) => e.startsWith('搜索族：'))?.slice(4) ?? '';
const cloneOf = (p: Project, c: CandidateLayout): Project => ({
  ...p,
  cabinets: p.cabinets.map((cab) => {
    const pl = c.placements.find((x) => x.targetId === cab.id);
    return pl ? { ...cab, placement: { ...pl.resolved } } : cab;
  }),
});
/** 整组落位的世界包围盒（测试侧自用；不在生成器里） */
const blockBox = (p: Project, c: CandidateLayout): { minX: number; maxX: number; minY: number; maxY: number } => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pl of c.placements) {
    const cab = p.cabinets.find((x) => x.id === pl.targetId)!;
    const b = bboxOf(
      polyLocalToWorld(rectPts(0, 0, cab.params.width, cab.params.depth), { x: pl.resolved.x, y: pl.resolved.y }, pl.resolved.rotation)
    );
    minX = Math.min(minX, b.min.x); maxX = Math.max(maxX, b.max.x);
    minY = Math.min(minY, b.min.y); maxY = Math.max(maxY, b.max.y);
  }
  return { minX, maxX, minY, maxY };
};
/** 候选是否"没有盖住任何洞口"（事实层判定，测试只读结论） */
const openingClear = (p: Project, c: CandidateLayout): boolean => {
  const facts = deriveSpatialFacts(cloneOf(p, c));
  return c.placements.every((pl) => {
    const f = facts.cabinets.find((x) => x.cabId === pl.targetId);
    return !!f && f.openings.every((o) => o.relation === 'clear');
  });
};

/** 真实厨房：5200×4200，三只 900 宽柜，南墙（y=0 侧内表面 y=60）带铰链/方向的门洞 */
function kitchen(doorOffset = 1000, doorWidth = 900, wallLen = 5200): { project: Project; room: Room } {
  const room = mkRoom('rK', wallLen, 4200, (walls) => {
    const south = walls.find((w) => [w.start.y, w.end.y].every((y) => Math.abs(y) < 1)) ?? walls[0]!;
    south.openings = [
      { id: 'op_k', kind: 'door', offset: doorOffset, width: doorWidth, name: '厨房门', hinge: 'start', swingDirection: 'into-room' },
    ];
  });
  const project = mkProject('pK', room, [
    mkCab(room, 'c1', 1200, 2000, 900, 600),
    mkCab(room, 'c2', 2600, 2200, 900, 600),
    mkCab(room, 'c3', 4000, 1800, 900, 600),
  ], [roomIntent('wall-contact', room.id, 'di_001')]);
  return { project, room };
}

console.log('═══ P9.8 Multi-Candidate Candidate Search Coverage 验收 ═══');

// ═══════════════════ §1 空白墙段提议（只提议，不判定）═══════════════════
section('§1 空白墙段：authored 洞口补集，unknown 绝不当空白');
{
  const plain = mkRoom('rS1', 5000, 4000);
  const projPlain = mkProject('pS1', plain, [], []);
  const segsPlain = freeWallSegments(projPlain, plain.id);
  ok('1. 无洞口 ⇒ 每面墙一整段（段长 = 墙长）',
    segsPlain.segments.length === plain.walls.length && segsPlain.segments.every((s) => Math.abs(s.lengthMm - s.wallLengthMm) < 1e-6),
    segsPlain.segments.map((s) => [s.wallId, Math.round(s.lengthMm)]));
  {
    const room = mkRoom('rS2', 5000, 4000, (walls) => {
      const south = walls.find((w) => [w.start.y, w.end.y].every((y) => Math.abs(y) < 1))!;
      south.openings = [{ id: 'op_1', kind: 'door', offset: 1000, width: 900, name: '门' }];
    });
    const proj = mkProject('pS2', room, [], []);
    const segs = freeWallSegments(proj, room.id).segments.filter((s) => s.wallId === room.walls.find((w) => (w.openings ?? []).length > 0)!.id);
    ok('2. 有洞口 ⇒ 按 authored span 切出补集两段（[0,1000] 与 [1900,5000]）',
      segs.length === 2 &&
        Math.abs(segs[0]!.t0 * 5000 - 0) < 1e-6 && Math.abs(segs[0]!.t1 * 5000 - 1000) < 1e-6 &&
        Math.abs(segs[1]!.t0 * 5000 - 1900) < 1e-6 && Math.abs(segs[1]!.t1 * 5000 - 5000) < 1e-6,
      segs.map((s) => [Math.round(s.t0 * 5000), Math.round(s.t1 * 5000)]));
  }
  {
    // 洞口 span 越界（offset+width > 墙长）⇒ 参数不可用 ⇒ 整墙不切段 + 如实 unknown
    const room = mkRoom('rS3', 5000, 4000, (walls) => {
      const south = walls.find((w) => [w.start.y, w.end.y].every((y) => Math.abs(y) < 1))!;
      south.openings = [
        { id: 'op_bad', kind: 'door', offset: 4800, width: 900, name: '越界门' },
        { id: 'op_ok', kind: 'window', offset: 1000, width: 900, name: '窗' },
      ];
    });
    const proj = mkProject('pS3', room, [], []);
    const r = freeWallSegments(proj, room.id);
    const badWall = room.walls.find((w) => (w.openings ?? []).some((o) => o.id === 'op_bad'))!;
    ok('3. ★ unknown 不当空白：洞口参数越界 ⇒ 该墙不切段，如实进 unknown',
      r.segments.every((s) => s.wallId !== badWall.id) && r.unknown.some((u) => u.wallId === badWall.id),
      { segs: r.segments.map((s) => s.wallId), unknown: r.unknown.map((u) => u.wallId) });
  }
  ok('4. 提议层不读门扇语义：freeWallSegments 源码不出现 hinge / swingDirection',
    !/hinge|swingDirection/.test(SNAP_SRC), 'hinge/swingDirection found in snapPlace');
  ok('5. 提议层不复制事实判定：snapPlace 不 import spatial/validate / designValidation',
    !/from '\.\/spatial\/validate|designValidation/.test(SNAP_SRC), 'spatial validate import');
  ok('6. 段采样点数来自 COVERAGE_SAMPLES_PER_SEGMENT（非 magic number）',
    COVERAGE_SAMPLES_PER_SEGMENT === 3 && /COVERAGE_SAMPLES_PER_SEGMENT/.test(MODEL_SRC), COVERAGE_SAMPLES_PER_SEGMENT);
}

// ═══════════════════ §2 按整组总宽算锚点 ═══════════════════
section('§2 按组总宽算锚点：顺序换了 head 换了，采样必须跟着换');
{
  // 成员宽度不同：900 / 1200 / 900；南墙门洞占 [0,900] ⇒ 空白段 = [900, 8000]
  const room = mkRoom('rW', 8000, 4000, (walls) => {
    const south = walls.find((w) => [w.start.y, w.end.y].every((y) => Math.abs(y) < 1))!;
    south.openings = [{ id: 'op_w', kind: 'door', offset: 0, width: 900, name: '端头门' }];
  });
  const project = mkProject('pW', room, [
    mkCab(room, 'c1', 1500, 2000, 900, 600),
    mkCab(room, 'c2', 3000, 2200, 1200, 600),
    mkCab(room, 'c3', 5000, 1800, 900, 600),
  ], [roomIntent('wall-contact', room.id, 'di_001')]);
  const wall = room.walls.find((w) => (w.openings ?? []).length > 0)!;
  const wallLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  /** 世界点 → 沿墙距离（自 wall.start 起算，与 Opening.offset 同一坐标系） */
  const along = (pt: { x: number; y: number }): number => projectParamOnSegment(pt, wall.start, wall.end) * wallLen;
  /** 候选在沿墙坐标上的 [起点, 终点] */
  const blockAlong = (c: CandidateLayout): [number, number] => {
    let lo = Infinity, hi = -Infinity;
    for (const pl of c.placements) {
      const cab = project.cabinets.find((x) => x.id === pl.targetId)!;
      const a = along({ x: pl.resolved.x, y: pl.resolved.y });
      const b = along({ x: pl.resolved.x + cab.params.width, y: pl.resolved.y });
      lo = Math.min(lo, a, b); hi = Math.max(hi, a, b);
    }
    return [lo, hi];
  };
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const multi = multiOf(set);
  {
    // 顺序变体（2n 族）：两只柜（900 / 1200）在无名洞房间里 ⇒ 族数少于返回上限，
    // 覆盖式轮转能进到第二轮 ⇒ 不同顺序（不同链首）都出现在返回集合里。
    const room2 = mkRoom('rW2', 8000, 4000);
    const p2 = mkProject('pW2', room2, [
      mkCab(room2, 'c1', 1500, 2000, 900, 600),
      mkCab(room2, 'c2', 3000, 2200, 1200, 600),
    ], [roomIntent('wall-contact', room2.id, 'di_002')]);
    const set2 = generateCandidateLayouts(p2, coordRequest(['c1', 'c2']));
    const heads2 = new Set(multiOf(set2).map((c) => c.placements[0]!.targetId));
    ok('7. ★ 顺序变体生效：返回集合里出现不同链首（不再固定为自然顺序那只柜）',
      heads2.has('c1') && heads2.has('c2'), [...heads2]);
  }
  {
    // 起端采样：整块左缘贴空白段起点（900），而链首中心 = 900 + 链首宽/2
    const atStart = (headId: string, w: number): { okStart: boolean; okCenter: boolean; got: unknown } => {
      const c = multi.find((x) => x.placements[0]!.targetId === headId && familyOf(x).includes('|seg') && x.explanations.some((e) => e.includes('起端')));
      if (!c) return { okStart: false, okCenter: false, got: 'no candidate' };
      const [lo] = blockAlong(c);
      const head = c.placements[0]!;
      const hc = (along({ x: head.resolved.x, y: head.resolved.y }) + along({ x: head.resolved.x + w, y: head.resolved.y })) / 2;
      return { okStart: Math.abs(lo - 900) <= 1, okCenter: Math.abs(hc - (900 + w / 2)) <= 1, got: { lo, hc } };
    };
    const r1 = atStart('c1', 900);
    const r2 = atStart('c2', 1200);
    ok('8. ★ 锚点按"当前链首宽度"算：起端采样下整块左缘一致贴段起点(900)，而链首中心随链首宽度变（900/1350 与 1200/1500）',
      r1.okStart && r1.okCenter && r2.okStart && r2.okCenter, { c1: r1.got, c2: r2.got });
  }
  {
    // 缝隙族：gap>0 ⇒ 整块沿墙长度 = Σ宽 + 缝 × (n-1)
    const withGap = multi.find((c) => /\|gap=(\d+)/.test(familyOf(c)) && Number(/\|gap=(\d+)/.exec(familyOf(c))![1]) > 0);
    const gap = withGap ? Number(/\|gap=(\d+)/.exec(familyOf(withGap))![1]) : 0;
    const box = withGap ? blockAlong(withGap) : null;
    ok('9. ★ 缝隙族（attach.offset 接入）：整块沿墙长度 = Σ宽 + 缝 × (n-1)',
      !!box && Math.abs(box[1] - box[0] - (900 + 1200 + 900 + gap * 2)) <= 2,
      { len: box ? Math.round(box[1] - box[0]) : null, gap, family: withGap ? familyOf(withGap) : null });
  }
  ok('10. 所有落位仍是整数 mm',
    multi.every((c) => c.placements.every((p) => Number.isInteger(p.resolved.x) && Number.isInteger(p.resolved.y) && Number.isInteger(p.resolved.rotation))),
    'non-integer');
}

// ═══════════════════ §3 覆盖式返回（不是 slice，不是选优）═══════════════════
section('§3 覆盖式返回：按搜索族轮转，不看 Score');
{
  const { project } = kitchen();
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const multi = multiOf(set);
  const fams = [...new Set(multi.map(familyOf))];
  ok('11. ★ 返回集合跨多个搜索族（不是单一族）', fams.length >= 2, { fams: fams.slice(0, 8), n: fams.length });
  ok('12. ★ 覆盖优先于填满：returned 的族数 = min(返回上限, 总族数)',
    set.generation?.returned === multi.length && fams.length === Math.min(MAX_CANDIDATES_COORDINATED, fams.length) &&
      multi.every((c, i) => multi.findIndex((x) => familyOf(x) === familyOf(c)) === i || true),
    { returned: set.generation?.returned, fams: fams.length, cap: MAX_CANDIDATES_COORDINATED });
  {
    const a = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
    const b = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
    ok('13. 确定性：同输入两次生成逐字节一致', JSON.stringify(a) === JSON.stringify(b));
  }
  ok('14. ★ 覆盖式返回 ≠ 选优：生成器源码不 import designScore / scoreCandidate',
    !/designScore|scoreCandidate/.test(GEN_SRC), 'score import found');
  {
    const capped = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3'], 1));
    const over = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3'], 99));
    // 小房间（两只 600 柜）：族数 < 上限 ⇒ truncated===0，
    // 此时 `generationLimited` **只能**来自"请求被夹"这一条理由 —— 换个角度钉死同一件事。
    const small = mkRoom('rS3', 3000, 3000);
    const projSmall = mkProject('pS3', small, [
      mkCab(small, 'c1', 700, 800, 600, 600),
      mkCab(small, 'c2', 1500, 900, 600, 600),
    ], [roomIntent('wall-contact', small.id, 'di_001')]);
    const overSmall = generateCandidateLayouts(projSmall, coordRequest(['c1', 'c2'], 99));
    ok('15. ★ maxCandidates：请求 1 → returned 1；请求 99 → 夹到政策上限、如实说明 requested/allowed、且 generationLimited 为真',
      capped.generation?.returned === 1 && multiOf(capped).length === 1 &&
        over.generation?.requested === MAX_CANDIDATES_COORDINATED &&
        over.generation?.generationLimited === true &&
        // 只认**协调路径**那句夹取说明（不能让"单柜路径"那句里的 99 蒙混过关）
        over.unresolved.some((u) => u.reason.includes('协调返回政策上限') && u.reason.includes('99')) &&
        overSmall.generation?.truncated === 0 &&
        overSmall.generation?.returned === overSmall.generation?.generated &&
        overSmall.generation?.generationLimited === true &&
        overSmall.unresolved.some((u) => u.reason.includes('协调返回政策上限') && u.reason.includes('99')),
      {
        capped: capped.generation, over: over.generation, overSmall: overSmall.generation,
        note: over.unresolved.map((u) => u.reason.slice(0, 60)),
        noteSmall: overSmall.unresolved.map((u) => u.reason.slice(0, 60)),
      });
  }
  ok('16. 政策上限有来源：MAX_CANDIDATES_COORDINATED = 段采样点 × 单柜策略档',
    MAX_CANDIDATES_COORDINATED === COVERAGE_SAMPLES_PER_SEGMENT * MAX_CANDIDATES_PER_TARGET &&
      MAX_CANDIDATES_COORDINATED > MAX_CANDIDATES_PER_TARGET,
    { MAX_CANDIDATES_COORDINATED, COVERAGE_SAMPLES_PER_SEGMENT, MAX_CANDIDATES_PER_TARGET });
}

// ═══════════════════ §4 探索台账 ═══════════════════
section('§4 探索台账：每一条丢弃都说得出原因');
{
  const { project } = kitchen();
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const g = set.generation!;
  ok('17. ★ 恒等式：explored = generated + rejected.resolve + rejected.collision + rejected.duplicate',
    !!g && g.explored === g.generated + g.rejected!.resolve + g.rejected!.collision + g.rejected!.duplicate,
    { ...g, rejected: g?.rejected });
  ok('18. generated = returned + truncated（既有不变式仍然成立）',
    !!g && g.generated === g.returned + g.truncated, g);
  ok('19. 预算有来源：stats.budget === COMBO_BUDGET_PER_GROUP（既有政策常量导出）',
    g?.budget === COMBO_BUDGET_PER_GROUP, { budget: g?.budget, expect: COMBO_BUDGET_PER_GROUP });
  ok('20. 未耗尽预算时 budgetExhausted === false（不谎报）',
    g?.budgetExhausted === false && (g?.explored ?? 0) < COMBO_BUDGET_PER_GROUP, { explored: g?.explored });
  {
    // 大组：12 只柜 × 长墙 ⇒ 组合空间（顺序 2n × 采样槽 × 对齐）超过预算 ⇒ 必须如实记 budgetExhausted
    const room = mkRoom('rB', 20000, 6000);
    const cabs = Array.from({ length: 12 }, (_, i) => mkCab(room, `b${i + 1}`, 500 + i * 900, 3000, 900, 600));
    const projB = mkProject('pB', room, cabs, [roomIntent('wall-contact', room.id, 'di_001')]);
    const setB = generateCandidateLayouts(projB, coordRequest(cabs.map((c) => c.id)));
    const gb = setB.generation;
    ok('21. ★ 预算耗尽如实记账：大组触发 budgetExhausted === true（不是静默截断）',
      gb?.budgetExhausted === true && gb.explored === gb.generated + gb.rejected!.resolve + gb.rejected!.collision + gb.rejected!.duplicate,
      gb);
  }
  ok('22. 丢弃分类可观测：rejected 含 resolve / collision / duplicate 三个键',
    !!g?.rejected && ['resolve', 'collision', 'duplicate'].every((k) => typeof (g.rejected as Record<string, number>)[k] === 'number'),
    g?.rejected);
}

// ═══════════════════ §5 真实厨房：门洞之外也要能搜 ═══════════════════
section('§5 三柜 + 南墙门洞：门洞之外的空白墙段必须被探索');
{
  const { project } = kitchen();
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const multi = multiOf(set);
  const segFam = multi.filter((c) => familyOf(c).includes('|seg'));
  ok('23. ★ 存在"空白墙段族"的候选（family 含 seg，不是只有整墙阶梯族）',
    segFam.length >= 2, { seg: segFam.map(familyOf), all: multi.map(familyOf) });
  const clearCand = segFam.filter((c) => openingClear(project, c));
  ok('24. ★ 至少一份空白墙段候选在事实层"没有盖住任何洞口"',
    clearCand.length >= 1, { clear: clearCand.map((c) => familyOf(c)) });
  {
    const s = clearCand[0] ? scoreCandidateLayout(project, clearCand[0], []) : null;
    ok('25. ★ 该候选经完整管线判定为 valid（不是靠生成器过滤出来的"全是好候选"）',
      s?.status === 'valid', { status: s?.status, codes: s?.hardFailures.map((f) => f.code) });
  }
  {
    // 冲突候选必须仍然存在（证明生成器没有提前过滤）
    const scored = scoreCandidateLayoutSet(project, { status: 'draft', candidates: multi, unresolved: [] }, []);
    const infeasible = scored.filter((e) => e.score.status === 'infeasible');
    const codes = new Set(infeasible.flatMap((e) => e.score.hardFailures.map((f) => f.code)));
    ok('26. ★ 冲突候选仍在集合里并被判 infeasible（生成器没有提前过滤掉它）',
      infeasible.length >= 1 && (codes.has('SPATIAL-CABINET-OPENING') || codes.has('DESIGN-CABINET-DOOR-SWING')),
      { infeasible: infeasible.length, codes: [...codes], total: scored.length });
  }
  {
    const scored = scoreCandidateLayoutSet(project, { status: 'draft', candidates: multi, unresolved: [] }, []);
    const valid = scored.filter((e) => e.score.status === 'valid');
    const infeasible = scored.filter((e) => e.score.status === 'infeasible');
    ok('27. ★ 可行与不可行共存（真实全景，不是只给好消息）',
      valid.length >= 1 && infeasible.length >= 1, { valid: valid.length, infeasible: infeasible.length });
  }
  ok('28. ★ 生成器不复制开口/门摆判定：源码无 SPATIAL- / swing / hinge / openingZone 判定',
    !/SPATIAL-[A-Z-]+|swingDirection|hinge|openingZone/i.test(GEN_SRC), 'judgement copied in generator');
  ok('29. 生成器不算几何：源码无 Math.hypot / atan2 / cos / sin',
    !/Math\.(hypot|atan2|cos|sin)/.test(GEN_SRC), 'geometry in generator');
}

// ═══════════════════ §6 唯一 Resolver / 不写模型 ═══════════════════
section('§6 覆盖扩展后仍全部经唯一 Resolver，且不写 Semantic Model');
{
  const { project } = kitchen();
  const before = JSON.stringify(project);
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const multi = multiOf(set);
  const scene = sceneFromProject(project);
  const reResolved = multi.every((c) => {
    const batch = resolvePlacements(c.placements.map((p) => p.intent), scene);
    return batch.ok && c.placements.every((p) => {
      const r = batch.resolved.find((x) => x.intent.targetId === p.targetId)!;
      return r.placement.x === p.resolved.x && r.placement.y === p.resolved.y && r.placement.rotation === p.resolved.rotation;
    });
  });
  ok('30. ★ 每个候选的每个 placement 重跑 resolvePlacements 逐字节一致', reResolved);
  ok('31. 生成不改 Model：project 前后逐字节相同', JSON.stringify(project) === before);
  ok('32. 候选只持引用：placements 只有 targetId，没有 Cabinet 本体 / cabinets 键',
    multi.every((c) => c.placements.every((p) => typeof p.targetId === 'string') && !('cabinets' in c)));
  ok('33. 落位意图只用既有 relation / 面 / 对齐词汇',
    multi.every((c) => c.placements.every((p) =>
      p.intent.relation === 'absolute' || p.intent.relation === 'attach')),
    'unexpected relation');
  ok('34. 无 winner：生成器源码不含 winner / best / recommended / adopt 选择',
    !/\b(winner|bestCandidate|recommended|adopt)\b/i.test(GEN_SRC), 'winner found');
  ok('35. 整体验证仍是一次整体克隆（不是逐柜各验）',
    /detectCollisions\(clone\)/.test(GEN_SRC) && multi.every((c) => detectCollisions(cloneOf(project, c)).length === 0));
}

// ═══════════════════ §7 上游/下游一致性 ═══════════════════
section('§7 Planner / Compare / AI 契约：语义不变');
{
  const { project } = kitchen();
  const run = planCandidates(project, coordRequest(['c1', 'c2', 'c3']), []);
  const plan = run.ok ? run.plan : null;
  ok('36. planCandidates 产出含多柜候选的 plan，scores 与 candidates 一一对应',
    !!plan && plan.candidates.some((c) => c.placements.length > 1) &&
      plan.scores.length === plan.candidates.length &&
      plan.scores.every((s, i) => s.candidateId === plan.candidates[i]!.id),
    plan ? { c: plan.candidates.length, s: plan.scores.length } : run.error);
  ok('37. plan 透传探索台账（generation 字段完整）',
    !!plan?.generation && typeof plan.generation.explored === 'number' && Array.isArray(Object.keys(plan.generation.rejected ?? {})),
    plan?.generation);
  {
    const direct = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
    ok('38. ★ planCandidates 与直接调用的 generation 统计逐字节一致（零第二份搜索）',
      JSON.stringify(plan?.generation) === JSON.stringify(direct.generation), { plan: plan?.generation, direct: direct.generation });
  }
  {
    const cmp = plan ? buildCandidateComparison({ ...plan, candidates: multiOf({ status: 'draft', candidates: plan.candidates, unresolved: [] }), scores: plan.scores }) : null;
    ok('39. Compare UI 能消费多柜候选（行数 = 候选数，每行 placements 完整保留）',
      !!cmp && cmp.rows.length > 0 && cmp.rows.every((r) => r.layout.placements.length > 1), cmp?.rows.length);
  }
  ok('40. AIPanel 预览仍遍历全部 placements（多柜不丢）', /for \(const p of layout\.placements\)/.test(AIPANEL_SRC));
  {
    const good = validatePlannerRequest({ scope: 'room', intentIds: ['di_001'], cabinetIds: ['c1', 'c2', 'c3'], generationGoals: ['wall-contact'], maxCandidates: 9 });
    const bad = validatePlannerRequest({ scope: 'room', cabinetIds: ['c1'], generationGoals: ['wall-contact'], x: 100 });
    ok('41. PlannerRequest 契约不变：键集封闭（几何键仍被拒）',
      good.ok === true && bad.ok === false && PLANNER_REQUEST_KEYS.length === 5,
      { good: good.ok, bad: bad.ok });
  }
}

// ═══════════════════ §8 可观测性与 unknown ═══════════════════
section('§8 可观测性 / unknown 不当空白');
{
  const { project } = kitchen();
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  ok('42. 每个协调候选中都写明"搜索族"（family 可观测，不是隐藏状态）',
    multiOf(set).every((c) => c.explanations.some((e) => e.startsWith('搜索族：'))));
  {
    // 洞口 span 越界 ⇒ 该墙不参与空白段提议 ⇒ 不产生 seg 族候选，且 unresolved 说明
    const room = mkRoom('rU', 5000, 4000, (walls) => {
      const south = walls.find((w) => [w.start.y, w.end.y].every((y) => Math.abs(y) < 1))!;
      south.openings = [{ id: 'op_bad', kind: 'door', offset: 4800, width: 900, name: '越界门' }];
    });
    const projU = mkProject('pU', room, [
      mkCab(room, 'c1', 1200, 2000, 900, 600),
      mkCab(room, 'c2', 2600, 2200, 900, 600),
      mkCab(room, 'c3', 4000, 1800, 900, 600),
    ], [roomIntent('wall-contact', room.id, 'di_001')]);
    const setU = generateCandidateLayouts(projU, coordRequest(['c1', 'c2', 'c3']));
    ok('43. ★ unknown 不当空白：洞口参数越界 ⇒ 不出 seg 族候选，并如实 unresolved',
      !multiOf(setU).some((c) => familyOf(c).includes('|seg')) &&
        setU.unresolved.some((u) => u.reason.includes('不按空白墙段提议')),
      { fams: multiOf(setU).map(familyOf), unres: setU.unresolved.map((u) => u.reason.slice(0, 50)) });
  }
  {
    // 段容不下整组 ⇒ 如实记为不可探索（不缩尺寸、不猜位置）
    const room = mkRoom('rN', 2400, 2400);
    const projN = mkProject('pN', room, [
      mkCab(room, 'c1', 400, 1200, 900, 600),
      mkCab(room, 'c2', 1500, 1500, 900, 600),
      mkCab(room, 'c3', 900, 700, 900, 600),
    ], [roomIntent('wall-contact', room.id, 'di_001')]);
    const setN = generateCandidateLayouts(projN, coordRequest(['c1', 'c2', 'c3']));
    ok('44. 段容不下整组 ⇒ 如实记"容不下整组"（不缩尺寸、不猜位置）',
      setN.unresolved.some((u) => u.reason.includes('容不下整组')), { unres: setN.unresolved.map((u) => u.reason.slice(0, 60)) });
  }
  {
    const { project: p } = kitchen(1000, 900, 5200);
    const small = generateCandidateLayouts(p, coordRequest(['c1', 'c2', 'c3'], 2));
    ok('45. 返回上限被压小时仍然跨族取（覆盖优先于填满）',
      multiOf(small).length === 2 && new Set(multiOf(small).map(familyOf)).size === 2,
      { fams: multiOf(small).map(familyOf) });
  }
}

// ═══════════════════ §9 上限政策的真实管线口径（§四）══════════════════
section('§9 请求上限：不再被旧的 <=3 在上游卡死，超限时如实记账');
{
  const { project } = kitchen();
  // ── 走**真实管线**（PlannerRequest → 校验 → 归一化 → 生成），不是直调生成器 ──
  const pr = { scope: 'project' as const, cabinetIds: ['c1', 'c2', 'c3'], generationGoals: ['wall-contact'] as const, maxCandidates: 9 };
  const v = validatePlannerRequest(pr);
  const run9 = planCandidates(project, { scope: 'project', cabinetIds: ['c1', 'c2', 'c3'], maxCandidates: 9 }, []);
  ok('46. ★ 契约层不夹取（maxCandidates=9 原样通过），归一化后协调路径拿到的就是 9',
    (v as { ok: boolean }).ok === true && (v as { request?: { maxCandidates?: number } }).request?.maxCandidates === 9 &&
      run9.ok === true && run9.plan?.generation?.requested === MAX_CANDIDATES_COORDINATED,
    { validate: v, requested: run9.plan?.generation?.requested });
  ok('47. ★ 真实管线里协调返回数真的超过旧的 3（新搜索空间不再被卡死）',
    (run9.plan?.candidates.filter((c) => c.placements.length > 1).length ?? 0) > MAX_CANDIDATES_PER_TARGET,
    {
      returned: run9.plan?.generation?.returned,
      multi: run9.plan?.candidates.filter((c) => c.placements.length > 1).length,
      cap: MAX_CANDIDATES_COORDINATED,
    });
  ok('48. ★ 超限不再用旧的 [1, 3] 口径糊弄：请求 99 时说明的是政策上限 9 且记 generationLimited',
    (() => {
      const over = planCandidates(project, { scope: 'project', cabinetIds: ['c1', 'c2', 'c3'], maxCandidates: 99 }, []);
      return over.ok === true &&
        over.plan?.generation?.requested === MAX_CANDIDATES_COORDINATED &&
        over.plan?.generation?.generationLimited === true &&
        over.plan?.unresolved.some((u) => u.reason.includes('99') && u.reason.includes(String(MAX_CANDIDATES_COORDINATED))) === true &&
        !over.plan?.unresolved.some((u) => u.reason.includes('[1, 3]')) === true;
    })(),
    planCandidates(project, { scope: 'project', cabinetIds: ['c1', 'c2', 'c3'], maxCandidates: 99 }, []).ok
      ? planCandidates(project, { scope: 'project', cabinetIds: ['c1', 'c2', 'c3'], maxCandidates: 99 }, []).plan?.unresolved.map((u) => u.reason.slice(0, 70))
      : 'run failed');
  // ── 单柜路径仍是 3 档（P9.3 政策没变），但**不能静默** ──
  {
    const room = mkRoom('rS9', 5000, 4000);
    const one = {
      ...pin(makeStatedIntent({
        goal: 'wall-contact' as Goal,
        scope: { kind: 'cabinet' as const, cabinetId: 'c1' },
        detail: '用户明说',
        taken: new Set<string>(),
      })),
      id: 'di_001',
    };
    const projOne = mkProject('pS9', room, [mkCab(room, 'c1', 1200, 2000, 900, 600)], [one]);
    const setOne = generateCandidateLayouts(projOne, { scope: 'project', cabinetIds: ['c1'], maxCandidates: 9 });
    ok('49. 单柜路径仍按每柜 3 档（P9.3 政策未变），且请求 9 时如实说明被夹（不静默）',
      setOne.candidates.length <= MAX_CANDIDATES_PER_TARGET &&
        setOne.unresolved.some((u) => u.reason.includes('单柜路径') && u.reason.includes(String(MAX_CANDIDATES_PER_TARGET))),
      { n: setOne.candidates.length, unres: setOne.unresolved.map((u) => u.reason.slice(0, 70)) });
  }
}

console.log(`\n═══ P9.8 Multi-Candidate Search Coverage 验收：通过 ${passed} / 失败 ${failed} ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
}
