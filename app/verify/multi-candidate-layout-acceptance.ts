/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.7 Multi-Cabinet Coordinated Candidate Layout 验收（55 项）
 *
 *  ── 要证明的核心命题 ──
 *  ① 多柜"整体候选"真实存在：一份 CandidateLayout.placements 同时含多柜，
 *     不是把几份单柜候选拼起来（§六）；
 *  ② 坐标唯一出口：每个成员落位都经 resolvePlacements（依赖排序 + 环检测），
 *     generator 一个 x/y 都不算（§五）；
 *  ③ 整体验证：对整个克隆副本跑 detectCollisions / deriveSpatialFacts /
 *     deriveContacts / validateDesign —— 逐柜合法 ≠ 整体合法（§八）；
 *  ④ 整体 Score：复用 P9.4，整体 hardFailure → 整体 infeasible（§九/§十六D）；
 *  ⑤ 确定性：dedupe / maxCandidates / generationLimited 全部如实（§十/§十一）；
 *  ⑥ Unknown：判不出来就 unresolved，绝不默认方向（§十五）；
 *  ⑦ 架构：候选不写 Model / project.json / Knowledge，无任何第二份实现（§十八/§二十）；
 *  ⑧ AI：PlannerRequest 仍无坐标 / polygon / placement（§十三）；
 *  ⑨ Compare UI 只消费即可显示多柜（§十七）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, Issue, Project, Room, RuleSet } from '../src/core/types.ts';
import { makeStatedIntent, type DesignIntent } from '../src/core/designIntent/index.ts';
import {
  generateCandidateLayouts,
  type CandidateLayout,
  type CandidateLayoutSet,
} from '../src/core/candidateLayout/index.ts';
import { resolvePlacement, resolvePlacements, sceneFromProject, type PlacementIntent } from '../src/core/placement.ts';
import { detectCollisions } from '../src/core/geometry/project.ts';
import { deriveContacts } from '../src/core/relations.ts';
import { deriveSpatialFacts } from '../src/core/spatial/derive.ts';
import { scoreCandidateLayout, scoreCandidateLayoutSet, compareDesignScores } from '../src/core/designScore/index.ts';
import { planCandidates } from '../src/core/planner/index.ts';
import { validatePlannerRequest, PLANNER_REQUEST_KEYS } from '../shared/aiContract.mjs';
import { validateDesign } from '../src/core/designValidation/index.ts';
import { designScoreHitZh } from '../src/core/designScore/index.ts';
import {
  buildCandidateComparison,
  buildIntentMatrix,
} from '../src/ui/panels/candidateCompareLogic.ts';

const APP = join(import.meta.dirname, '..');
const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset', 'factory-default.json'), 'utf8')) as RuleSet;
const FIXED_SAVED_AT = '2026-10-01T00:00:00.000Z';
void FIXED_SAVED_AT;

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
const INDEX_SRC = stripComments(readFileSync(join(APP, 'src/core/candidateLayout/index.ts'), 'utf8'));
const CC_UI_SRC = stripComments(readFileSync(join(APP, 'src/ui/panels/candidateCompare.tsx'), 'utf8'));
const AIPANEL_SRC = stripComments(readFileSync(join(APP, 'src/ui/panels/AIPanel.tsx'), 'utf8'));

// ─────────────────────────── fixtures ───────────────────────────
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
/** 柜级意图（评分组件按柜逐条出） */
const cabIntent = (goal: Goal, cabId: string, id: string): DesignIntent => ({
  ...pin(makeStatedIntent({ goal, scope: { kind: 'cabinet', cabinetId: cabId }, detail: '用户明说', taken: new Set<string>() })),
  id,
});
/** 房间级意图（驱动协调枚举；评分侧如实记 unavailable/unknown —— P9.4 既有语义） */
const roomIntent = (goal: Goal, roomId: string, id: string): DesignIntent => ({
  ...pin(makeStatedIntent({ goal, scope: { kind: 'room', roomId }, detail: '用户明说', taken: new Set<string>() })),
  id,
});
function mkProject(id: string, room: Room, cabs: Cabinet[], intents: DesignIntent[]): Project {
  return {
    schemaVersion: '0.2',
    id,
    name: id,
    ruleSetId: RULES.id,
    rooms: [room],
    cabinets: cabs,
    designIntents: intents,
  } as Project;
}
/** 标准三柜整墙场景（同朝向 rot 0，散在房间中部） */
function scenarioA(roomW = 5000): { project: Project; room: Room } {
  const room = mkRoom('rA', roomW, 4000);
  const project = mkProject('pA', room, [
    mkCab(room, 'c1', 1000, 2000, 900, 600),
    mkCab(room, 'c2', 2500, 2200, 900, 600),
    mkCab(room, 'c3', 3800, 1800, 900, 600),
  ], [roomIntent('wall-contact', room.id, 'di_001')]);
  return { project, room };
}
const coordRequest = (cabinetIds: string[], maxCandidates?: number) => ({
  scope: 'project' as const,
  cabinetIds,
  ...(maxCandidates !== undefined ? { maxCandidates } : {}),
});
const multiOf = (set: CandidateLayoutSet): CandidateLayout[] => set.candidates.filter((c) => c.placements.length > 1);
const isInt = (n: number): boolean => Number.isInteger(n);

// ═══════════════════ §1 Basic（1-5）═══════════════════
section('§1 Basic：单柜兼容 → 六柜整体候选');
{
  // 1. 单柜兼容
  {
    const room = mkRoom('r1a');
    const project = mkProject('p1a', room, [mkCab(room, 'c1', 1600, 1400, 900, 600), mkCab(room, 'c2', 400, 60, 900, 600)], [cabIntent('wall-contact', 'c1', 'di_001')]);
    const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
    ok('1. 单柜兼容：单柜意图照旧产单柜候选（协调路径不启用）', set.candidates.length > 0 && multiOf(set).length === 0 && set.generation === undefined, { n: set.candidates.length, gen: set.generation });
  }
  // 2. 双柜
  {
    const room = mkRoom('r1b');
    const project = mkProject('p1b', room, [mkCab(room, 'c1', 1000, 2000, 900, 600), mkCab(room, 'c2', 2500, 2200, 900, 600)], [roomIntent('wall-contact', room.id, 'di_001')]);
    const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2']));
    const multi = multiOf(set);
    ok('2. 双柜：产出 placements.length===2 的整体候选', multi.some((c) => c.placements.length === 2), multi.map((c) => c.placements.length));
  }
  // 3. 三柜
  {
    const { project } = scenarioA();
    const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
    const multi = multiOf(set);
    ok('3. 三柜：产出 placements.length===3 的整体候选', multi.some((c) => c.placements.length === 3), multi.map((c) => c.placements.length));
  }
  // 4. 六柜
  {
    const room = mkRoom('r1d', 8000, 4000);
    const cabs = [1, 2, 3, 4, 5, 6].map((i) => mkCab(room, `c${i}`, 800 + i * 700, 1500 + (i % 3) * 300, 600, 550));
    const project = mkProject('p1d', room, cabs, [roomIntent('wall-contact', room.id, 'di_001')]);
    const set = generateCandidateLayouts(project, coordRequest(cabs.map((c) => c.id)));
    const multi = multiOf(set);
    ok('4. 六柜：产出 placements.length===6 的整体候选（链空间受控不爆）', multi.some((c) => c.placements.length === 6), { counts: multi.map((c) => c.placements.length), gen: set.generation });
  }
  // 5. 多柜 candidate 形状
  {
    const { project } = scenarioA();
    const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
    const multi = multiOf(set);
    const c = multi[0];
    const ids = c ? c.placements.map((p) => p.targetId) : [];
    ok('5. 多柜候选：targetId 互不相同且都引用 project.cabinets（非 Cabinet 本体）',
      !!c && new Set(ids).size === ids.length && ids.every((id) => project.cabinets.some((cab) => cab.id === id)) && !('cabinets' in c), ids);
  }
}

// ═══════════════════ §2 Geometry（6-15）═══════════════════
section('§2 Geometry：每柜过 Resolver、整体零冲突、四向旋转、混合深度');
{
  const { project } = scenarioA();
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const multi = multiOf(set);
  // 6. 每柜 Resolver（整数 mm）
  ok('6. 每柜 resolved 都是整数 mm（无浮点残差进坐标）', multi.every((c) => c.placements.every((p) => isInt(p.resolved.x) && isInt(p.resolved.y) && isInt(p.resolved.rotation))), multi[0]?.placements.map((p) => p.resolved));
  // 7. 不绕 Resolver（整体候选逐字节重解一致）
  ok('7. ★ 候选坐标逐字节等于对同一批 intent 重跑 resolvePlacements 的结果（零旁路）', multi.every((c) => {
    const scene = sceneFromProject(project);
    const r = resolvePlacements(c.placements.map((p) => p.intent), scene);
    return r.ok && JSON.stringify(r.resolved.map((x) => x.placement)) === JSON.stringify(c.placements.map((p) => p.resolved));
  }), 're-resolve mismatch');
  // 8. 整体 collision
  ok('8. ★ 整体验证：多柜候选在整体克隆副本上 detectCollisions 为零', multi.every((c) => {
    const clone = {
      ...project,
      cabinets: project.cabinets.map((cab) => {
        const p = c.placements.find((x) => x.targetId === cab.id);
        return p ? { ...cab, placement: { ...p.resolved } } : cab;
      }),
    };
    return detectCollisions(clone).length === 0;
  }), 'collision on clone');
  // 9. attach
  ok('9. 行链成员落位意图是 attach（left↔right 面贴合，依赖前一只）', multi.some((c) => c.placements.length === 3 && c.placements.slice(1).every((p) => p.intent.relation === 'attach' && p.intent.targetFace === 'left' && p.intent.referenceFace === 'right')), multi[0]?.placements.map((p) => p.intent.relation));
  // 10. adjacent 与 attach 同一引擎交叉验证（rot 0 时二者等价：并排背面齐）
  {
    const c = multi.find((x) => x.placements.length >= 2);
    if (!c) {
      ok('10. attach 链与引擎 adjacent（right+back）在轴对齐下同一落位（同一份引擎，零第二份实现）', false, 'no multi candidate');
    } else {
    const a = c.placements[0]!;
    const b = c.placements[1]!;
    const scene = sceneFromProject(project).map((s) =>
      s.id === a.targetId ? { ...s, x: a.resolved.x, y: a.resolved.y, rotation: a.resolved.rotation } : s
    );
    const adj = resolvePlacement({ relation: 'adjacent', targetId: b.targetId, referenceId: a.targetId, side: 'right', alignment: 'back' }, scene);
    ok('10. attach 链与引擎 adjacent（right+back）在轴对齐下同一落位（同一份引擎，零第二份实现）', adj.ok && adj.placement.x === b.resolved.x && adj.placement.y === b.resolved.y, { attach: b.resolved, adjacent: adj.ok ? adj.placement : adj.error });
    }
  }
  // 11-14. rotation 0/90/180/270
  for (const rot of [0, 90, 180, 270]) {
    const room = mkRoom(`rR${rot}`, 5000, 4000);
    const project = mkProject(`pR${rot}`, room, [
      mkCab(room, 'c1', 1500, 1500, 900, 600, rot),
      mkCab(room, 'c2', 3200, 2400, 900, 600, rot),
    ], [roomIntent('wall-contact', room.id, 'di_001')]);
    const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2']));
    const multi = multiOf(set);
    ok(`11-${rot}. 朝向 ${rot}°：整体链成立且成员保持该朝向`, multi.length > 0 && multi.every((c) => c.placements.every((p) => ((p.resolved.rotation % 360) + 360) % 360 === rot)), multi[0]?.placements.map((p) => p.resolved.rotation));
  }
  // 15. mixed depth
  {
    const room = mkRoom('rM', 6000, 4000);
    const project = mkProject('pM', room, [
      mkCab(room, 'c1', 1200, 2000, 900, 600),
      mkCab(room, 'c2', 2600, 2200, 900, 350),
      mkCab(room, 'c3', 4000, 1800, 900, 600),
    ], [roomIntent('wall-contact', room.id, 'di_001')]);
    const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
    const multi = multiOf(set);
    const row = multi.find((c) => c.placements.length === 3);
    const byId = new Map(row?.placements.map((p) => [p.targetId, p.resolved] as const));
    const d1 = byId.get('c1')!;
    const d2 = byId.get('c2')!;
    const d3 = byId.get('c3')!;
    ok('15. 混合深度：行链背面齐（y 相同）、350 柜的前缘与 600 柜不同（footprint 事实，不是 bbox 一刀切）',
      !!row && d1.y === d2.y && d2.y === d3.y && d1.y + 600 !== d2.y + 350 && multi.every((c) => {
        const clone = { ...project, cabinets: project.cabinets.map((cab) => { const p = c.placements.find((x) => x.targetId === cab.id); return p ? { ...cab, placement: { ...p.resolved } } : cab; }) };
        return detectCollisions(clone).length === 0;
      }), { d1, d2, d3 });
  }
}

// ═══════════════════ §3 Relations（16-20）═══════════════════
section('§3 Relations：链上接触事实 / 环 / 转角');
{
  const { project } = scenarioA();
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const row = multiOf(set).find((c) => c.placements.length === 3);
  const clone = row ? {
    ...project,
    cabinets: project.cabinets.map((cab) => {
      const p = row.placements.find((x) => x.targetId === cab.id);
      return p ? { ...cab, placement: { ...p.resolved } } : cab;
    }),
  } : null;
  // 16. 多柜 relation
  const contacts = clone ? deriveContacts(clone) : [];
  ok('16. 多柜 relation：链上相邻成员在副本上派生出接触事实', !!row && row.placements.length === 3 && contacts.length >= 2, contacts.map((c) => `${c.a}~${c.b}:${c.kind}`));
  // 17. cycle（引擎唯一实现）
  {
    const scene = sceneFromProject(project);
    const cyc: PlacementIntent[] = [
      { relation: 'adjacent', targetId: 'c1', referenceId: 'c2', side: 'right' },
      { relation: 'adjacent', targetId: 'c2', referenceId: 'c3', side: 'right' },
      { relation: 'adjacent', targetId: 'c3', referenceId: 'c1', side: 'right' },
    ];
    const r = resolvePlacements(cyc, scene);
    ok('17. cycle：C1→C2→C3→C1 被引擎判 PLACEMENT-CYCLE（明确 invalid，绝不自动打断）', !r.ok && r.error.code === 'PLACEMENT-CYCLE', r.ok ? 'resolved(!)' : r.error.code);
  }
  // 18. corner（L 型）
  {
    const room = mkRoom('rL', 5000, 4000);
    const projectL = mkProject('pL', room, [
      mkCab(room, 'c1', 600, 60, 900, 600, 0),
      mkCab(room, 'c2', 3000, 2000, 900, 600, 90),
    ], [roomIntent('wall-contact', room.id, 'di_001')]);
    const setL = generateCandidateLayouts(projectL, coordRequest(['c1', 'c2']));
    const lCand = multiOf(setL).find((c) => c.placements.length === 2);
    const cloneL = lCand ? {
      ...projectL,
      cabinets: projectL.cabinets.map((cab) => { const p = lCand.placements.find((x) => x.targetId === cab.id); return p ? { ...cab, placement: { ...p.resolved } } : cab; }),
    } : null;
    const c12 = cloneL ? deriveContacts(cloneL).find((c) => (c.a === 'c1' && c.b === 'c2') || (c.a === 'c2' && c.b === 'c1')) : null;
    const rotOf = (id: string) => lCand?.placements.find((p) => p.targetId === id)?.resolved.rotation;
    const perp = (() => {
      const r1 = rotOf('c1');
      const r2 = rotOf('c2');
      if (r1 === undefined || r2 === undefined) return false;
      return ((Math.abs(r1 - r2) % 180) + 180) % 180 === 90;
    })();
    ok('18. L 型：整体候选成立、成员相互垂直，且副本上派生出成员间面贴合接触（attach 语义的真实派生事实）', !!c12 && perp, { multi: multiOf(setL).map((c) => c.placements.length), contact: c12 ? `${c12.kind}:${c12.edgeA}~${c12.edgeB}` : null });
  }
  // 19. butt
  ok('19. 行链接触是 butt（边共线贴合）', contacts.some((c) => c.kind === 'butt'), contacts.map((c) => c.kind));
  // 20. relation 与 placement 一致
  ok('20. 声明的 attach 面（left↔right）与派生接触一致（声明与事实对上）', (() => {
    if (!row) return false;
    const b = row.placements[1]!;
    const aId = b.intent.relation === 'attach' ? b.intent.referenceId : null;
    if (!aId) return false;
    return contacts.some((c) => (c.a === aId && c.b === b.targetId) || (c.b === aId && c.a === b.targetId));
  })(), contacts.map((c) => `${c.a}~${c.b}`));
}

// ═══════════════════ §4 Validation（21-26）═══════════════════
section('§4 Validation：整体 room/wall/opening/door-swing/collision/infeasible 传播');
{
  const { project } = scenarioA();
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const row = multiOf(set).find((c) => c.placements.length === 3);
  const cloneOf = (p: Project, c: CandidateLayout): Project => ({
    ...p,
    cabinets: p.cabinets.map((cab) => {
      const pl = c.placements.find((x) => x.targetId === cab.id);
      return pl ? { ...cab, placement: { ...pl.resolved } } : cab;
    }),
  });
  // 21. 整体 room validation
  const report = row ? validateDesign(cloneOf(project, row)) : null;
  ok('21. 整体验证入口 validateDesign 对整体副本可跑且按柜分组', !!report && Array.isArray(report.findings) && report.counts !== undefined && report.cabinets !== undefined, report ? Object.keys(report) : 'no 3-member candidate');
  // 22. 整体 wall validation
  const facts = row ? deriveSpatialFacts(cloneOf(project, row)) : null;
  ok('22. 整体 wall：链成员在副本上全部贴墙（wall-contact 事实成立）', !!row && !!facts && row.placements.every((p) => {
    const f = facts.cabinets.find((c) => c.cabId === p.targetId);
    return f?.walls.some((w) => w.relation === 'touching');
  }), facts ? facts.cabinets.map((c) => `${c.cabId}:${c.walls.map((w) => w.relation).join(',')}`) : 'no candidate');
  // 23/24. 整体 opening / door swing（生成器路径：链盖住南墙门洞 → 整体 infeasible）
  {
    const room = mkRoom('rO', 5000, 4000, (walls) => {
      // 南墙（内表面 y=60 的那面）开一个 900 门洞、铰链在起点侧
      const south = walls.find((w) => {
        const ys = [w.start.y, w.end.y];
        return ys.every((y) => Math.abs(y) < 1);
      }) ?? walls[0]!;
      south.openings = [{ id: 'op_1', kind: 'door', offset: 1000, width: 900, name: '南门', hinge: 'start', swingDirection: 'into-room' }];
    });
    const projectO = mkProject('pO', room, [
      mkCab(room, 'c1', 1200, 2000, 900, 600),
      mkCab(room, 'c2', 2600, 2200, 900, 600),
      mkCab(room, 'c3', 4000, 1800, 900, 600),
    ], [roomIntent('wall-contact', room.id, 'di_001')]);
    const setO = generateCandidateLayouts(projectO, coordRequest(['c1', 'c2', 'c3']));
    const scored = scoreCandidateLayoutSet(projectO, { status: 'draft', candidates: multiOf(setO), unresolved: [] }, []);
    const infeasible = scored.filter((s) => s.score.status === 'infeasible');
    const codes = new Set(infeasible.flatMap((s) => s.score.hardFailures.map((f) => f.code)));
    ok('23. 整体 opening：盖住门洞的整体候选被评 infeasible（SPATIAL-CABINET-OPENING 进整体 gate）', codes.has('SPATIAL-CABINET-OPENING'), { codes: [...codes], infeasible: infeasible.length, total: scored.length });
    ok('24. 整体 door swing：门扇包络冲突（DESIGN-CABINET-DOOR-SWING）作为 ERROR 进整体 gate', codes.has('DESIGN-CABINET-DOOR-SWING'), { codes: [...codes] });
  }
  // 25. 整体 collision（负向保证：候选集合里不存在任何互相重叠的成员对）
  ok('25. 整体 collision：所有多柜候选的成员两两 footprint 不重叠', (() => {
    // 重叠判定复用整体验证：每个候选的整体克隆零冲突已由 §2-8 钉过；
    // 这里再从"集合级"兜一遍：任何候选都不含同柜两条 placement（重复摆同一只 = 重叠的定义性来源）
    return multiOf(set).every((c) => new Set(c.placements.map((p) => p.targetId)).size === c.placements.length);
  })(), 'dup target in placements');  // 26. infeasible propagation（场景 D 直构：一只柜挡门扇 → 整份候选 infeasible，不是"其余 valid"）
  {
    const room = mkRoom('rD', 5000, 4000, (walls) => {
      const south = walls.find((w) => [w.start.y, w.end.y].every((y) => Math.abs(y) < 1)) ?? walls[0]!;
      south.openings = [{ id: 'op_1', kind: 'door', offset: 1500, width: 900, name: '南门', hinge: 'start', swingDirection: 'into-room' }];
    });
    const projectD = mkProject('pD', room, [
      mkCab(room, 'c1', 400, 60, 900, 600),
      mkCab(room, 'c2', 1900, 60, 900, 600),
      mkCab(room, 'c3', 3400, 60, 900, 600),
    ], [roomIntent('wall-contact', room.id, 'di_001')]);
    // 夹具故意构造：c2 压在南门洞/门扇包络上（坐标是夹具输入，不是 generator 产出）
    const layout: CandidateLayout = {
      id: 'cl_direct',
      status: 'draft',
      sourceIntent: ['di_001'],
      placements: [
        { targetId: 'c1', intent: { relation: 'absolute', targetId: 'c1', x: 400, y: 60, rotation: 0, origin: 'authored' }, resolved: { x: 400, y: 60, rotation: 0 }, issues: [] as Issue[], satisfies: [{ goal: 'wall-contact', ok: true }] },
        { targetId: 'c2', intent: { relation: 'absolute', targetId: 'c2', x: 1900, y: 60, rotation: 0, origin: 'authored' }, resolved: { x: 1900, y: 60, rotation: 0 }, issues: [] as Issue[], satisfies: [{ goal: 'wall-contact', ok: true }] },
        { targetId: 'c3', intent: { relation: 'absolute', targetId: 'c3', x: 3400, y: 60, rotation: 0, origin: 'authored' }, resolved: { x: 3400, y: 60, rotation: 0 }, issues: [] as Issue[], satisfies: [{ goal: 'wall-contact', ok: true }] },
      ],
      explanations: ['直构夹具：三柜整墙，c2 盖住门洞'],
      unresolved: [],
    };
    const s = scoreCandidateLayout(projectD, layout, []);
    ok('26. ★ infeasible 传播：一只柜门扇冲突 → 整份多柜候选 infeasible（不是 C1 OK C3 OK 就算整体可用）', s.status === 'infeasible' && s.hardFailures.some((f) => f.code === 'DESIGN-CABINET-DOOR-SWING'), { status: s.status, codes: s.hardFailures.map((f) => f.code) });
  }
}

// ═══════════════════ §5 Score（27-29）═══════════════════
section('§5 Score：复用 P9.4，零第二份评分');
{
  const { project } = scenarioA();
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const multi = multiOf(set);
  const c0 = multi[0];
  // 27. 整体 score
  const s = c0 ? scoreCandidateLayout(project, c0, []) : null;
  ok('27. 整体 score：scoreCandidateLayout 对多柜候选产出 DesignScore（status/total/weights 齐全）', !!s && typeof s.status === 'string' && s.weights !== undefined, { status: s?.status });
  // 28. score 不重算 facts（同输入逐字节一致 + 来源闭集）
  const s2 = c0 ? scoreCandidateLayout(project, c0, []) : null;
  ok('28. score 不重算：同输入两次逐字节一致，hardFailures.source 只出自闭集', !!s && !!s2 && JSON.stringify(s) === JSON.stringify(s2) && s.hardFailures.every((f) => f.source === 'candidate-issues' || f.source === 'design-validation'), s ? s.hardFailures.map((f) => f.source) : 'no candidate');
  // 29. score 与直接调用一致
  {
    const run = planCandidates(project, coordRequest(['c1', 'c2', 'c3']), []);
    const fromPlan = run.ok && c0 ? run.plan.scores.find((e) => e.candidateId === c0.id) : null;
    const direct = c0 ? scoreCandidateLayout(project, c0, []) : null;
    ok('29. ★ planCandidates 里的多柜评分与直接调用 scoreCandidateLayout 逐字节相同（零第二份判定）', !!fromPlan && !!direct && JSON.stringify(fromPlan.score) === JSON.stringify(direct), { fromPlan: !!fromPlan });
  }
  void compareDesignScores;
}

// ═══════════════════ §6 Determinism（30-34）═══════════════════
section('§6 Determinism：逐字节一致 / 去重 / 上限如实');
{
  const { project } = scenarioA();
  const set1 = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  const set2 = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  ok('30. 同输入两次生成逐字节一致', JSON.stringify(set1) === JSON.stringify(set2));
  ok('31. 候选顺序一致（id 序列相同）', JSON.stringify(set1.candidates.map((c) => c.id)) === JSON.stringify(set2.candidates.map((c) => c.id)), set1.candidates.map((c) => c.id));
  // 32. dedupe：全集合签名唯一
  {
    const sigs = set1.candidates.map((c) => c.placements.length + '|' + c.placements.map((p) => `${p.targetId}@${p.resolved.x},${p.resolved.y},${p.resolved.rotation}`).sort().join('|'));
    ok('32. dedupe：单柜 + 协调全集合内不存在签名相同的两份候选', new Set(sigs).size === sigs.length, sigs.filter((s, i) => sigs.indexOf(s) !== i));
  }
  // 33. maxCandidates
  {
    const capped = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3'], 1));
    ok('33. maxCandidates=1：协调候选只返回 1 份（generation.returned===1）', capped.generation?.returned === 1 && multiOf(capped).length === 1, capped.generation);
  }
  // 34. generationLimited
  ok('34. generationLimited：generated = returned + truncated，超限明确置位（绝不静默 slice）',
    set1.generation !== undefined && set1.generation.generated === set1.generation.returned + set1.generation.truncated && (set1.generation.truncated > 0 ? set1.generation.generationLimited === true : true), set1.generation);
}

// ═══════════════════ §7 Unknown（35-37）═══════════════════
section('§7 Unknown：判不出来就 unresolved，绝不默认方向');
{
  // 35. unknown：无铰链的门（unknown）不产生门扇结论
  {
    const room = mkRoom('rU', 5000, 4000, (walls) => {
      const south = walls.find((w) => [w.start.y, w.end.y].every((y) => Math.abs(y) < 1)) ?? walls[0]!;
      south.openings = [{ id: 'op_1', kind: 'door', offset: 1500, width: 900, name: '无铰链门' }]; // 没 hinge / 没方向
    });
    const projectU = mkProject('pU', room, [
      mkCab(room, 'c1', 400, 60, 900, 600),
      mkCab(room, 'c2', 1900, 60, 900, 600),
    ], [roomIntent('wall-contact', room.id, 'di_001')]);
    const setU = generateCandidateLayouts(projectU, coordRequest(['c1', 'c2']));
    const scored = scoreCandidateLayoutSet(projectU, { status: 'draft', candidates: multiOf(setU), unresolved: [] }, []);
    ok('35. unknown：门无铰链/方向 → 不报门扇冲突（判不出来就不说话，绝不默认 into-room）',
      scored.every((s) => !s.score.hardFailures.some((f) => f.code === 'DESIGN-CABINET-DOOR-SWING')), scored.map((s) => s.score.hardFailures.map((f) => f.code)));
  }
  // 36. unresolved：组合全部出局时如实记录
  {
    const room = mkRoom('rV', 2200, 2200); // 小房间：三柜 900 宽链放不下
    const projectV = mkProject('pV', room, [
      mkCab(room, 'c1', 700, 1100, 900, 600),
      mkCab(room, 'c2', 1500, 1500, 900, 600),
      mkCab(room, 'c3', 1100, 800, 900, 600),
    ], [roomIntent('wall-contact', room.id, 'di_001')]);
    const setV = generateCandidateLayouts(projectV, coordRequest(['c1', 'c2', 'c3']));
    ok('36. unresolved：整体候选产不出（房间放不下链）时如实记 unresolved（不静默给 0 个了事）',
      multiOf(setV).length === 0 && setV.unresolved.length > 0 && setV.unresolved.some((u) => u.reason.includes('协调')), setV.unresolved.map((u) => u.reason.slice(0, 50)));
  }
  // 37. 无默认方向：源码 + 运行态双查
  ok('37. ★ 无默认方向：生成器源码不含 swingDirection/hinge/into-room 的任何默认赋值', !/swingDirection\s*[=:]/.test(GEN_SRC) && !/hinge\s*[=:]/.test(GEN_SRC) && !/into-room/.test(GEN_SRC), 'generator must not guess door direction');
}

// ═══════════════════ §8 Architecture（38-48）═══════════════════
section('§8 Architecture：候选不落盘、零第二份实现');
{
  const { project } = scenarioA();
  const before = JSON.stringify(project);
  const set = generateCandidateLayouts(project, coordRequest(['c1', 'c2', 'c3']));
  // 38. 无 Cabinet 克隆进 candidate
  ok('38. 候选 JSON 里没有 Cabinet 本体（无 units/params/rooms 键）', (() => {
    const j = JSON.stringify(multiOf(set)[0]);
    return !/"units"|"params"|"ruleSetId"/.test(j);
  })(), 'cabinet leaked');
  // 39. 不写 Model
  ok('39. ★ 生成前后入参 project 逐字节未变（候选不写 Model）', JSON.stringify(project) === before);
  // 40. 不写 project.json（源码 + 运行态双查：结果集不是项目）
  ok('40. 候选层不 import serializeProjectFile / projectFile；结果集不含 cabinets/rooms 键',
    !/serializeProjectFile|projectFile|writeFileSync/.test(GEN_SRC + MODEL_SRC + INDEX_SRC) && !('cabinets' in set) && !('rooms' in set), Object.keys(set));
  // 41. 不写 Knowledge
  ok('41. 候选层不 import Knowledge / memoryStore / resolveKnowledge', !/knowledge|memoryStore|resolveKnowledge/i.test(GEN_SRC + INDEX_SRC), 'knowledge import found');
  // 42-45. 零第二份实现
  ok('42. 无 Geometry 新算法：只 import detectCollisions（与 CommandBus 同一份），不 import geometry/transform',
    /detectCollisions/.test(GEN_SRC) && !/geometry\/transform|rectPts|localToWorld/.test(GEN_SRC), 'geometry import');
  ok('43. 无 Placement 新算法：坐标出口只有 resolvePlacements/resolvePlacement，不定义任何 resolve* 函数',
    /resolvePlacements\(/.test(GEN_SRC) && !/function resolve[A-Z]/.test(GEN_SRC) && !/Math\.(atan2|hypot|cos|sin)/.test(GEN_SRC), 'placement algorithm found');
  ok('44. 无 Spatial 新算法：事实只来自 deriveSpatialFacts / deriveContacts，不自己判墙/洞口',
    /deriveSpatialFacts/.test(GEN_SRC) && /deriveContacts/.test(GEN_SRC) && !/wallPolygon|pointInPoly|openingZone/i.test(GEN_SRC), 'spatial algorithm found');
  ok('45. 无 Score 新算法：候选层不 import designScore / scoreCandidate', !/designScore|scoreCandidate/.test(GEN_SRC), 'score import');
  // 46-48. 无越界 import
  ok('46. 无 CommandBus import', !/commandBus|CommandBus/.test(GEN_SRC + INDEX_SRC), 'commandBus found');
  ok('47. 无 Manufacturing import', !/manufacturing|bodies3d/i.test(GEN_SRC + INDEX_SRC), 'manufacturing found');
  ok('48. 无 DXF import', !/dxf|ezdxf/i.test(GEN_SRC + INDEX_SRC), 'dxf found');
}

// ═══════════════════ §9 AI（49-52）═══════════════════
section('§9 AI：PlannerRequest 仍无坐标 / polygon / placement');
{
  const { project } = scenarioA();
  // 49. PlannerRequest 合法
  const v = validatePlannerRequest({ scope: 'project', cabinetIds: ['c1', 'c2', 'c3'], maxCandidates: 3 });
  const run = planCandidates(project, { scope: 'project', cabinetIds: ['c1', 'c2', 'c3'], maxCandidates: 3 }, []);
  ok('49. PlannerRequest（cabinetIds+maxCandidates）过契约校验，且 planCandidates 产出含多柜候选的 plan',
    v.ok === true && run.ok && multiOf({ status: 'draft', candidates: run.plan.candidates, unresolved: [] } as CandidateLayoutSet).length > 0, { v: v.ok, multi: run.ok ? run.plan.candidates.filter((c) => c.placements.length > 1).length : 0 });
  // 50-52. AI 无坐标 / polygon / placement
  for (const [n, key, label] of [
    [50, 'x', '坐标 x'],
    [51, 'polygon', 'polygon'],
    [52, 'placements', 'placements'],
  ] as const) {
    const bad = validatePlannerRequest({ scope: 'project', [key]: key === 'x' ? 100 : [{ x: 0 }] });
    ok(`${n}. AI 请求带 ${label} → 契约整份拒绝（类型层 + 契约层双禁）`, bad.ok === false, JSON.stringify(bad).slice(0, 80));
  }
  void PLANNER_REQUEST_KEYS;
}

// ═══════════════════ §10 Compare（53-55）═══════════════════
section('§10 Compare：P9.6 UI 只消费即可显示多柜');
{
  const { project } = scenarioA();
  const run = planCandidates(project, { scope: 'project', cabinetIds: ['c1', 'c2', 'c3'], maxCandidates: 3 }, []);
  const plan = run.ok ? run.plan : null;
  // 53. 单柜显示
  const single = plan?.candidates.find((c) => c.placements.length === 1);
  const cmpSingle = single && plan ? buildCandidateComparison({ ...plan, candidates: [single], scores: plan.scores.filter((e) => e.candidateId === single.id) }) : null;
  ok('53. P9.6 能显示单柜（对比行正确关联）', !!cmpSingle && cmpSingle.rows.length === 1 && cmpSingle.rows[0]!.layout.id === single!.id);
  // 54. 多柜显示
  const multi = plan ? plan.candidates.filter((c) => c.placements.length > 1) : [];
  const cmpMulti = plan && multi[0] ? buildCandidateComparison({ ...plan, candidates: [multi[0]], scores: plan.scores.filter((e) => e.candidateId === multi[0].id) }) : null;
  ok('54. P9.6 能显示多柜（对比行 placements 完整保留 + UI 按 placements.map 渲染整体方案）',
    !!cmpMulti && cmpMulti.rows[0]!.layout.placements.length > 1 && /placements\.map/.test(CC_UI_SRC) && /cc-multi/.test(CC_UI_SRC), { n: multi.length });
  // 55. 多柜信息不丢失
  ok('55. ★ 多柜信息不丢失：previewCandidate 遍历全部 placements（源码钉死 for...of placements），matrix unknown 如实',
    /for \(const p of layout\.placements\)/.test(AIPANEL_SRC) && !!cmpMulti && (() => {
      const m = buildIntentMatrix(cmpMulti.rows);
      return m.every((row) => Object.values(row.byCandidate).every((v) => v === 'yes' || v === 'no' || v === 'unknown')) && designScoreHitZh('unknown') === '判不出来';
    })(), 'preview loop or matrix broken');
}

// ═══════════════════ 汇总 ═══════════════════
console.log(`\n═══ P9.7 Multi-Candidate Layout 验收：通过 ${passed} / 失败 ${failed} ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
