/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.4 Deterministic Design Score 验收
 *
 *  ── 要证明的核心命题 ──
 *    ① **硬约束闸门在前**：有 blocking error ⇒ `status:'infeasible'` +
 *       `total:null` + `components:[]`（不是"扣很多分"继续装有效候选）；
 *    ② **不污染模型**：评分前后 `project` 逐字节不变、`project.json` 逐字节不变、
 *       不升 `schemaVersion`、序列化结果里不出现任何评分/候选痕迹；
 *    ③ **只消费既有事实**：门槛结论与 `detectCollisions` / `validateDesign` 的 ERROR 集
 *       逐条一致；条件命中与词表 spec 的 `satisfiedValues` 对账；
 *    ④ **无新判定**：源码里没有三角函数、没有容差字面量、没有 bbox/polygon/距离实现，
 *       也不 import geometry / spatial 的几何原语；
 *    ⑤ **来源闭集**：每个 component 的 source ∈ {fact, rule, preference}（没有第四种）；
 *    ⑥ **偏好纪律**：只消费 Resolver 的 applicable —— candidate 偏好与被硬规则压制的
 *       偏好都不参与，且偏好**永不**进 hardFailures；
 *    ⑦ **判不出就说判不出**：priority 类意图 → `unavailable`，不计入 total；
 *    ⑧ **无 adopt / 无 winner**：导出面里没有 winner / best / recommended / adopt / apply；
 *       AI 动作清单仍 21 条；
 *    ⑨ **确定性**：同一份输入重复评分逐字节相同；候选之间互不影响；compare 可复现。
 *
 *  ── 判据纪律（本项目反复钉过的）──
 *    · 每条失败先打原始值 —— **先假定断言自己写错**；
 *    · 夹具每次自己造（共享对象引用会让用例互相污染 → 假绿）；
 *    · 参与逐字节比较的意图/项目**钉死时间戳**；
 *    · 哨兵必须**做过自检**（用一个"故意写坏的样本"确认哨兵真能红）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room, RuleSet } from '../src/core/types.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import { resolvePlacement, sceneFromProject } from '../src/core/placement.ts';
import { detectCollisions } from '../src/core/geometry/project.ts';
import { validateDesign } from '../src/core/designValidation/index.ts';
import {
  makeCandidateIntent,
  makeStatedIntent,
  rejectIntent,
  type DesignIntent,
} from '../src/core/designIntent/index.ts';
import { generateCandidateLayouts, type CandidateLayout, type CandidatePlacement } from '../src/core/candidateLayout/index.ts';
import { designIntentGoalSpec, type DesignIntentGoal } from '../src/core/designIntent/vocabulary.ts';
import { buildSnapshot } from '../src/ai/snapshot.ts';
import {
  SCORE_WEIGHT_POLICY,
  compareDesignScores,
  designScoreSummaryZh,
  evaluateCandidateLayout,
  scoreCandidateLayout,
  scoreCandidateLayoutSet,
  type DesignScore,
  type DesignScoreComponent,
} from '../src/core/designScore/index.ts';
import * as scoreMod from '../src/core/designScore/index.ts';
import type { KnowledgeEntry, KnowledgePredicate } from '../src/ai/knowledge/model.ts';
import { hardRuleEntries, makeStatedPreference } from '../src/ai/knowledge/model.ts';
import { ACTION_NAMES } from '../shared/aiContract.mjs';

const APP = join(import.meta.dirname, '..');
const SCORE_SRC = join(APP, 'src/core/designScore');
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
/** c1 放房间中间（不贴墙）—— wall-contact 有得挑；c2 贴南墙，作为障碍物 */
function baseProject(): Project {
  const room = mkRoom('r1');
  return {
    schemaVersion: '0.2',
    id: 'p_ds',
    name: 'P94',
    ruleSetId: RULES.id,
    rooms: [room],
    cabinets: [mkCab(room, 'c1', 1600, 1400, 900, 600, 0), mkCab(room, 'c2', 400, 60, 900, 600, 0)],
  } as Project;
}
const T0 = 1_700_000_000_000;
const pin = (i: DesignIntent, at = T0): DesignIntent => ({
  ...i,
  createdAt: at,
  updatedAt: at,
  evidence: i.evidence.map((e) => ({ ...e, at })),
});
const wallIntent = (cabId: string, id = 'di_001'): DesignIntent => ({
  ...pin(makeStatedIntent({ goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: cabId }, detail: '用户：这个柜贴墙', taken: new Set<string>() })),
  id,
});
const standaloneIntent = (cabId: string, id = 'di_002'): DesignIntent => ({
  ...pin(makeStatedIntent({ goal: 'standalone', scope: { kind: 'cabinet', cabinetId: cabId }, detail: '用户：这个柜独立摆', taken: new Set<string>() })),
  id,
});
const priorityIntent = (id = 'di_003'): DesignIntent => ({
  ...pin(makeStatedIntent({ goal: 'storage-priority', scope: { kind: 'room', roomId: 'r1' }, detail: '用户：以储物为主', taken: new Set<string>() })),
  id,
});
/** 任意目标 + 指定柜的 active 意图（事实指标用） */
const cabIntent = (goal: DesignIntentGoal, cabId: string, id: string): DesignIntent => ({
  ...pin(makeStatedIntent({ goal, scope: { kind: 'cabinet', cabinetId: cabId }, detail: '用户明说', taken: new Set<string>() })),
  id,
});
const projWithIntents = (intents: DesignIntent[]): Project => ({ ...baseProject(), designIntents: intents });

/** 把某只柜按 `resolved` 摆到副本上，再跑真实冲突判定（与 CommandBus 同一来源） */
function issuesFor(project: Project, targetId: string, resolved: { x: number; y: number; rotation: number }) {
  const clone: Project = {
    ...project,
    cabinets: project.cabinets.map((c) => (c.id === targetId ? { ...c, placement: { ...resolved } } : c)),
  };
  return detectCollisions(clone).filter((i) => i.target.split(' / ').includes(targetId));
}
/** 手工构造一份候选（形状与 P9.3 产出相同；用于造"必然冲突"的坏候选） */
function mkLayout(id: string, targetId: string, resolved: { x: number; y: number; rotation: number }, project: Project, sourceIntent: string[] = []): CandidateLayout {
  const placement: CandidatePlacement = {
    targetId,
    intent: { relation: 'absolute', targetId, x: resolved.x, y: resolved.y, rotation: resolved.rotation, origin: 'authored' },
    resolved,
    issues: issuesFor(project, targetId, resolved),
    satisfies: [],
  };
  return { id, status: 'draft', sourceIntent, placements: [placement], explanations: [], unresolved: [] };
}
/** c1 摆到 c2 的位置上 —— 必然 RULE-CABINET-OVERLAP（ERROR） */
function overlappingLayout(project: Project): CandidateLayout {
  const c2 = project.cabinets.find((c) => c.id === 'c2')!;
  return mkLayout('cl_bad', 'c1', { x: c2.placement.x, y: c2.placement.y, rotation: c2.placement.rotation }, project, ['di_001']);
}
function firstCandidate(project: Project, intentId = 'di_001'): CandidateLayout {
  const set = generateCandidateLayouts(project, { intentIds: [intentId], scope: 'project' });
  if (set.candidates.length === 0) throw new Error('夹具失效：没有产出候选（后续全是假绿）');
  return set.candidates[0]!;
}

// ─────────────────────── 哨兵（会被自检的判据） ───────────────────────

const FORBIDDEN_EXPORT = /^(winner|best|recommended|recommend|adopt|apply|commit|persist|write|execute|save|sync|pick)/i;
/** 「让候选生效」类名字（§十五.30 无 auto-adopt） */
const ADOPT_LIKE = /^(adopt|apply|commit|persist|write|execute|save|sync)/i;
/** 「选优」类名字（§十五.29 无 winner API） */
const WINNER_LIKE = /^(winner|best|recommended|recommend|pick|top|rank|choose)/i;
const hasForbiddenExport = (names: string[]): boolean => names.some((n) => FORBIDDEN_EXPORT.test(n));
/** 评分层源码里不许出现的几何/三角/容差痕迹（§八） */
const GEOMETRY_SMELL = /Math\.(sin|cos|tan|hypot|atan2|sqrt)\s*\(|\b[A-Z_]*TOL\b|polyDistance|polysOverlapInterior|segsProperCross|pointInPoly|openingZoneRect|wallPolygon|getCabinetFootprint|bboxOf|polysOverlap/;
const hasGeometrySmell = (src: string): boolean => GEOMETRY_SMELL.test(src);
/**
 * 剥掉注释再扫源码。
 * ⚠ 必须这么做：文件头**恰恰会写清**"本层不 import commandBus / 不用 SPATIAL_TOL" ——
 *   那是纪律声明，不是违规。拿全文扫会把"解释"当成"实现"，是本项目反复钉过的假红来源。
 */
const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
/** 评分结果里不许出现坐标字段（它只能**读**坐标，不能**带**坐标） */
const COORD_KEYS = new Set(['x', 'y', 'rotation', 'resolved', 'intent', 'placements', 'geometry', 'poly', 'polygon', 'bbox']);
function coordKeysIn(v: unknown, acc: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => coordKeysIn(x, acc));
  else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (COORD_KEYS.has(k)) acc.push(k);
      coordKeysIn(val, acc);
    }
  }
  return acc;
}

// ═══════════════════ §0 哨兵自检（用故意写坏的样本确认它们真能红）═══════════════════
section('§0 哨兵自检：故意写坏的样本必须被判红');
{
  ok('0.1 导出名哨兵：坏样本 adoptScore 被判红', hasForbiddenExport(['scoreCandidateLayout', 'adoptScore']) === true);
  ok('0.2 导出名哨兵：好样本不被误判', hasForbiddenExport(['scoreCandidateLayout', 'compareDesignScores']) === false);
  ok('0.3 几何痕迹哨兵：坏样本 Math.hypot( 被判红', hasGeometrySmell('const d = Math.hypot(a.x-b.x, a.y-b.y);') === true);
  ok('0.4 几何痕迹哨兵：坏样本 SPATIAL_TOL 被判红', hasGeometrySmell('if (gap <= SPATIAL_TOL.TOUCH) return true;') === true);
  ok('0.5 几何痕迹哨兵：好样本不被误判', hasGeometrySmell('const hit = kinds.some((k) => spec.satisfiedValues.includes(k));') === false);
  ok('0.6 坐标哨兵：带 resolved 的样本被判红', coordKeysIn({ a: { resolved: { x: 1, y: 2 } } }).length > 0);
  ok('0.7 剥注释：注释里提到的违规词不算违规', !stripComments('/** 本层不 import commandBus / SPATIAL_TOL */\nconst a = 1;').includes('commandBus'));
  ok('0.8 剥注释后，真正的代码违规仍被抓住', hasGeometrySmell(stripComments('/** 说明 */\nconst d = Math.hypot(1, 2);')) === true);
}

// ═══════════════════ §1 §四 硬约束闸门：valid / infeasible ═══════════════════
section('§1 硬约束闸门：有 blocking error ⇒ infeasible + 不评分');
{
  const project = projWithIntents([wallIntent('c1')]);
  const bad = overlappingLayout(project);
  ok('1. 坏候选确实带 ERROR 级 issues（否则本用例假绿）', bad.placements[0]!.issues.some((i) => i.severity === 'ERROR'), bad.placements[0]!.issues.map((i) => i.code));

  const s = scoreCandidateLayout(project, bad);
  ok('2. 状态是 infeasible（不是 valid）', s.status === 'infeasible', s.status);
  ok('3. total 为 null —— **没有**"扣很多分"的总分', s.total === null, s.total);
  ok('4. totalKind 是 none', s.totalKind === 'none', s.totalKind);
  ok('5. components 为空 —— 硬约束不过就不进入软评分', s.components.length === 0, s.components.length);
  ok('6. hardFailures 非空且只有 ERROR', s.hardFailures.length > 0 && s.hardFailures.every((f) => f.severity === 'ERROR'), s.hardFailures);
  ok('7. explanations 里说清了"未通过闸门"', s.explanations.some((e) => e.includes('未通过')), s.explanations[0]);

  const good = firstCandidate(project);
  const sg = scoreCandidateLayout(project, good);
  ok('8. 好候选状态是 valid', sg.status === 'valid', sg.status);
  ok('9. valid 时 total 是数字且 = 命中数', typeof sg.total === 'number' && sg.total === sg.components.filter((c) => c.hit === 'yes').length, { total: sg.total, comps: sg.components.map((c) => [c.id, c.hit]) });
  ok('10. valid 时 totalKind 是 hit-count（不是"权重和"）', sg.totalKind === 'hit-count', sg.totalKind);
}

// ═══════════════════ §2 不污染模型 / 不进 project.json / 不升 schemaVersion ═══════════════════
section('§2 评分不污染模型、不进 project.json');
{
  const project = projWithIntents([wallIntent('c1'), priorityIntent('di_003')]);
  const cand = firstCandidate(project);
  const before = JSON.stringify(project);
  const beforeFile = serializeProjectFile(project, FIXED_SAVED_AT);
  const beforeVersion = project.schemaVersion;

  const s = scoreCandidateLayout(project, cand);

  ok('11. project 对象逐字节不变', JSON.stringify(project) === before, 'project 被改动了');
  ok('12. c1 的 placement 一个字节没动', project.cabinets.find((c) => c.id === 'c1')!.placement.x === 1600);
  ok('13. project.json 序列化逐字节不变', serializeProjectFile(project, FIXED_SAVED_AT) === beforeFile);
  ok('14. schemaVersion 不变', project.schemaVersion === beforeVersion && beforeVersion === '0.2', project.schemaVersion);

  const file = serializeProjectFile(project, FIXED_SAVED_AT);
  ok('15. 序列化结果里不出现任何候选 id', !file.includes(cand.id), cand.id);
  ok('16. 序列化结果里不出现 score / designScore 键', !/"designScore"|"hardFailures"|"preferenceMatches"/.test(file));
  ok('17. 评分结果对象里没有任何坐标字段', coordKeysIn(s).length === 0, coordKeysIn(s));

  // 反向自检：评分**确实**读了模型（不是拿空数据算出来的假绿）
  ok('18. 评分确实基于真实模型（有 component 或 failure）', s.components.length + s.hardFailures.length > 0, { c: s.components.length, f: s.hardFailures.length });
}

// ═══════════════════ §3 与 Resolver 一致（评分不自己算坐标）═══════════════════
section('§3 候选坐标仍来自 Resolver，评分只是读它');
{
  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  ok('19. 有候选可查（否则假绿）', set.candidates.length > 0, set.candidates.length);
  let allMatch = true;
  for (const c of set.candidates) {
    for (const p of c.placements) {
      const r = resolvePlacement(p.intent, sceneFromProject(project));
      if (!r.ok || JSON.stringify(r.placement) !== JSON.stringify(p.resolved)) allMatch = false;
    }
  }
  ok('20. 每条候选落位的坐标 == Resolver 输出', allMatch);
  const s = scoreCandidateLayout(project, set.candidates[0]!);
  ok('21. 评分结果里不带坐标（只带"读哪条事实"的名字）', coordKeysIn(s).length === 0 && s.components.every((c) => !/(^|\.)x$|(^|\.)y$/.test(c.fact ?? '')), s.components.map((c) => c.fact));
}

// ═══════════════════ §4 validation 一致（门槛结论与既有层逐条相同）═══════════════════
section('§4 门槛结论与既有校验层一致（不重判）');
{
  const project = projWithIntents([wallIntent('c1')]);
  const bad = overlappingLayout(project);
  const s = scoreCandidateLayout(project, bad);

  // 既有层：detectCollisions 的 ERROR + validateDesign 的 error（挂在目标柜上）
  const clone: Project = {
    ...project,
    cabinets: project.cabinets.map((c) => (c.id === 'c1' ? { ...c, placement: { ...bad.placements[0]!.resolved } } : c)),
  };
  const expectCodes = new Set<string>([
    ...detectCollisions(clone).filter((i) => i.severity === 'ERROR' && i.target.split(' / ').includes('c1')).map((i) => i.code),
    ...validateDesign(clone).findings.filter((f) => f.status === 'error' && f.cabId === 'c1').map((f) => f.code),
  ]);
  const gotCodes = new Set(s.hardFailures.map((f) => f.code));
  ok('22. hardFailures 的码集与既有层 ERROR 码集一致', [...expectCodes].every((c) => gotCodes.has(c)) && [...gotCodes].every((c) => expectCodes.has(c)), { expect: [...expectCodes], got: [...gotCodes] });

  const srcIssue = detectCollisions(clone).find((i) => i.severity === 'ERROR' && i.target.split(' / ').includes('c1'))!;
  const got = s.hardFailures.find((f) => f.code === srcIssue.code)!;
  ok('23. 文案原样来自 issueCatalog（逐字节相同，不自己拼）', got.message === srcIssue.message, { got: got.message, src: srcIssue.message });
  ok('24. 门槛来源标注正确（candidate-issues）', got.source === 'candidate-issues', got.source);

  // valid 的候选：门槛为空
  const sg = scoreCandidateLayout(project, firstCandidate(project));
  ok('25. 无阻断错误时 hardFailures 为空', sg.hardFailures.length === 0, sg.hardFailures);
}

// ═══════════════════ §5 多候选独立 + 确定性 ═══════════════════
section('§5 多候选独立存在、评分确定性可复现');
{
  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  ok('26. 至少两份候选（否则"独立"无从谈起）', set.candidates.length >= 2, set.candidates.length);

  const scores = scoreCandidateLayoutSet(project, set);
  ok('27. 每份候选各自一份评分', scores.length === set.candidates.length, { s: scores.length, c: set.candidates.length });
  ok('28. 评分与候选一一对应（id 顺序一致）', scores.every((x, i) => x.candidateId === set.candidates[i]!.id));
  ok('29. 候选 id 互不相同', new Set(set.candidates.map((c) => c.id)).size === set.candidates.length);

  const s0a = scoreCandidateLayout(project, set.candidates[0]!);
  const s1 = scoreCandidateLayout(project, set.candidates[1]!);
  const s0b = scoreCandidateLayout(project, set.candidates[0]!);
  ok('30. 同一候选重复评分逐字节相同（无随机、无时钟）', JSON.stringify(s0a) === JSON.stringify(s0b));
  ok('31. 评分另一份候选不影响这一份', JSON.stringify(scoreCandidateLayout(project, set.candidates[0]!)) === JSON.stringify(s0a), { after: scoreCandidateLayout(project, set.candidates[0]! ).total, s1: s1.total });
}

// ═══════════════════ §6 无 adopt / 无 winner ═══════════════════
section('§6 导出面：没有 winner / best / recommended / adopt');
{
  const names = Object.keys(scoreMod);
  ok('32. 导出面不含任何"让候选生效/选优"的名字', !hasForbiddenExport(names), names.filter((n) => FORBIDDEN_EXPORT.test(n)));
  ok('33. 导出面确实有评分与比较（不是空模块）', names.includes('scoreCandidateLayout') && names.includes('compareDesignScores'), names);
  ok('34. 摘要文案不自称"推荐/最佳"', !/推荐|最佳|winner|best/i.test(designScoreSummaryZh(scoreCandidateLayout(projWithIntents([wallIntent('c1')]), firstCandidate(projWithIntents([wallIntent('c1')]))))));

  // 源码级：不 import 任何写路径 / AI 客户端 / 知识存储（剥注释后扫**代码**）
  const src = stripComments(readFileSync(join(SCORE_SRC, 'score.ts'), 'utf8'));
  ok('35. score.ts 不 import commandBus / aiClient / knowledge store', !/commandBus|aiClient|knowledge\/store|manufacturing|\/export/.test(src), (src.match(/^import .*$/gm) ?? []).join(' | '));
}

// ═══════════════════ §7 AI 契约：无 geometry、动作清单不增 ═══════════════════
section('§7 AI 契约：动作仍 21 条，评分不进契约');
{
  ok('36. ACTION_NAMES 仍是 21 条', ACTION_NAMES.length === 21, ACTION_NAMES.length);
  ok('37. 动作清单里没有任何 score 相关动作', !ACTION_NAMES.some((a) => /score|rank|winner|best/i.test(a)), ACTION_NAMES.filter((a) => /score|rank/i.test(a)));
  const contract = readFileSync(join(APP, 'shared/aiContract.mjs'), 'utf8');
  ok('38. AI 契约里没有评分**入口**（模型不能调用评分、更不能据评分决策）', !/scoreCandidateLayout|DesignScore|compareDesignScores/.test(contract));
}

// ═══════════════════ §8 rejected / candidate / 未生效意图不产生 component ═══════════════════
section('§8 未生效意图不参与评分');
{
  const rejected = { ...pin(makeStatedIntent({ goal: 'room-inside', scope: { kind: 'cabinet', cabinetId: 'c1' }, detail: '被否', taken: new Set<string>() })), id: 'di_rej' };
  const rejectedList = rejectIntent([rejected], 'di_rej');
  const candidateOne = { ...pin(makeCandidateIntent({ goal: 'opening-clear', scope: { kind: 'cabinet', cabinetId: 'c1' }, detail: 'AI 猜', taken: new Set<string>() })), id: 'di_cand' };
  const project = projWithIntents([wallIntent('c1'), ...rejectedList, candidateOne]);
  const s = scoreCandidateLayout(project, firstCandidate(project));

  const ids = s.components.map((c) => c.intentId).filter(Boolean) as string[];
  ok('39. 只有 active 意图产生 component', s.components.every((c) => c.intentId === undefined || c.intentId === 'di_001'), ids);
  ok('40. rejected 意图不产生 component', !ids.includes('di_rej'));
  ok('41. 未确认（candidate）意图不产生 component', !ids.includes('di_cand'));
  ok('42. 恰有一条条件 component（active 的那条）', s.components.filter((c) => c.kind === 'condition').length === 1, s.components.filter((c) => c.kind === 'condition').length);
}

// ═══════════════════ §9 §七 判不出来 = unavailable，不计入 total ═══════════════════
section('§9 取舍方向类意图 → unavailable（不猜、不塞进 score）');
{
  const project = projWithIntents([wallIntent('c1'), priorityIntent('di_003')]);
  const s = scoreCandidateLayout(project, firstCandidate(project));
  const un = s.components.filter((c) => c.kind === 'unavailable');
  ok('43. priority 意图产出一条 unavailable component', un.length === 1 && un[0]!.intentId === 'di_003', un.map((c) => c.intentId));
  ok('44. unavailable 的 hit 是 unknown（不是 no）', un[0]!.hit === 'unknown', un[0]!.hit);
  ok('45. unavailable **不计入** total', s.total === s.components.filter((c) => c.hit === 'yes').length && s.components.find((c) => c.id === 'unavail:di_003')!.hit !== 'yes', { total: s.total });
  ok('46. unavailable 的 why 说清"判不出来"', /判不出来/.test(un[0]!.why), un[0]!.why);
}

// ═══════════════════ §10 §五 来源闭集 + §八 源码纪律 ═══════════════════
section('§10 来源闭集（无第四种）+ 源码无新几何判定');
{
  const project = projWithIntents([wallIntent('c1'), priorityIntent('di_003')]);
  const s = scoreCandidateLayout(project, firstCandidate(project));
  const SOURCES = new Set(['fact', 'rule', 'preference']);
  ok('47. 每个 component 的 source ∈ {fact, rule, preference}', s.components.every((c) => SOURCES.has(c.source)), s.components.map((c) => c.source));
  ok('48. 没有 llm / ai / model 之类的来源', !s.components.some((c) => /llm|ai|model|guess/i.test(c.source)), s.components.map((c) => c.source));

  const src = stripComments(
    readFileSync(join(SCORE_SRC, 'score.ts'), 'utf8') + '\n' + readFileSync(join(SCORE_SRC, 'model.ts'), 'utf8')
  );
  ok('49. 源码里没有三角函数 / 新容差 / bbox·polygon 实现', !hasGeometrySmell(src), GEOMETRY_SMELL.exec(src)?.[0]);
  ok('50. 条件 component 都注明依据哪个 fact 与哪条 rule', s.components.filter((c) => c.kind === 'condition').every((c) => Boolean(c.fact) && Boolean(c.rule)), s.components.filter((c) => c.kind === 'condition').map((c) => [c.fact, c.rule]));
}

// ═══════════════════ §11 §六 偏好纪律（复用 Resolver）═══════════════════
section('§11 偏好：只消费 applicable、被硬规则压制的不参与、永不进 hardFailures');
{
  const project = projWithIntents([wallIntent('c1')]);
  const cand = firstCandidate(project);
  const rot = cand.placements[0]!.resolved.rotation;
  const norm = (d: number): number => ((Math.round(d) % 360) + 360) % 360;

  const prefPred: KnowledgePredicate = { kind: 'orientation', op: 'prefer', value: norm(rot) };
  const pref = makeStatedPreference({ statement: '这个柜我一直用这个朝向', predicate: prefPred, scope: { cabinet: 'c1' }, detail: '用户明说', seq: 1 });

  const withPref = scoreCandidateLayout(project, cand, [pref]);
  ok('51. applicable 的偏好被计为 preference component', withPref.components.some((c) => c.kind === 'preference' && c.preferenceId === pref.id), withPref.components.map((c) => c.id));
  ok('52. 朝向与偏好一致 → 命中', withPref.preferenceMatches[0]?.matched === 'yes', withPref.preferenceMatches);
  ok('53. 偏好 component 的 source 是 preference、isPreference 为真', withPref.components.find((c) => c.preferenceId === pref.id)!.source === 'preference' && withPref.components.find((c) => c.preferenceId === pref.id)!.isPreference === true);
  ok('54. 偏好**永不**进 hardFailures', withPref.hardFailures.length === 0);

  // 硬规则压制：hardRule forbid 同一个值 ⇒ 该偏好被 suppressed，不参与
  const hard = hardRuleEntries([{ code: 'TEST-HARD-ORIENT', statement: '规则：此情形禁止该朝向', predicate: { kind: 'orientation', op: 'forbid', value: norm(rot) }, scope: {} }], []);
  const suppressed = scoreCandidateLayout(project, cand, [...hard, pref]);
  ok('55. 被硬规则压制时不作为偏好参与', !suppressed.components.some((c) => c.preferenceId === pref.id), suppressed.components.map((c) => c.id));
  ok('56. 压制后 preferenceMatches 为空', suppressed.preferenceMatches.length === 0, suppressed.preferenceMatches);
  ok('57. 压制**不会**把候选判成 infeasible（偏好≠硬约束）', suppressed.status === 'valid', suppressed.status);

  // candidate 偏好（未确认）不参与
  const candPref = { ...makeStatedPreference({ statement: 'AI 猜的偏好', predicate: prefPred, scope: { cabinet: 'c1' }, detail: 'AI', seq: 2 }), status: 'candidate' as const };
  const withCand = scoreCandidateLayout(project, cand, [candPref]);
  ok('58. 未确认（candidate）偏好不参与评分', !withCand.components.some((c) => c.preferenceId === candPref.id), withCand.components.map((c) => c.id));

  // 情形不匹配的偏好被跳过（且有说明）
  const cornerOnly = makeStatedPreference({ statement: '只在角接时用这个朝向', predicate: { kind: 'orientation', op: 'prefer', value: 270, context: { contact: 'corner' } }, scope: { cabinet: 'c1' }, detail: '用户明说', seq: 3 });
  const withCorner = scoreCandidateLayout(project, cand, [cornerOnly]);
  ok('59. 情形不匹配的偏好被跳过（不硬塞进 score）', !withCorner.components.some((c) => c.preferenceId === cornerOnly.id), withCorner.components.map((c) => c.id));
  ok('60. 跳过有可见说明', withCorner.explanations.some((e) => e.includes('情形不匹配')), withCorner.explanations.filter((e) => e.includes('情形')));

  // 传入的 entries 不被修改（Resolver 是纯函数；本层也不写 store）
  const entriesBefore = JSON.stringify([pref]);
  scoreCandidateLayout(project, cand, [pref]);
  ok('61. 传入的知识条目不被修改', JSON.stringify([pref]) === entriesBefore);
}

// ═══════════════════ §12 §九 权重归属 ═══════════════════
section('§12 权重：本阶段不设（不写死 magic number）');
{
  const project = projWithIntents([wallIntent('c1')]);
  const s = scoreCandidateLayout(project, firstCandidate(project));
  ok('62. weights.assigned 为 false', s.weights.assigned === false, s.weights);
  ok('63. 每个 component 的 weight 为 null', s.components.every((c) => c.weight === null), s.components.map((c) => c.weight));
  ok('64. 每个 component 的 weightSource 是 unassigned', s.components.every((c) => c.weightSource === 'unassigned'), s.components.map((c) => c.weightSource));
  ok('65. 权重政策写明"留待后续"', /留待后续|后续阶段/.test(SCORE_WEIGHT_POLICY.note), SCORE_WEIGHT_POLICY.note.slice(0, 40));
}

// ═══════════════════ §13 §十 compare：确定性、不选 winner ═══════════════════
section('§13 compare：确定性比较，不产生 winner');
{
  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  const a = scoreCandidateLayout(project, set.candidates[0]!);
  const b = scoreCandidateLayout(project, set.candidates[1]!);
  const bad = scoreCandidateLayout(project, overlappingLayout(project));

  ok('66. compare(a, a) === 0', compareDesignScores(a, a) === 0);
  ok('67. 反对称：compare(a,b) === -compare(b,a)', compareDesignScores(a, b) === -compareDesignScores(b, a) || compareDesignScores(a, b) === 0);
  ok('68. infeasible < valid', compareDesignScores(bad, a) === -1 && compareDesignScores(a, bad) === 1, { bad_vs_a: compareDesignScores(bad, a) });
  const r1 = compareDesignScores(a, b);
  const r2 = compareDesignScores(a, b);
  const r3 = compareDesignScores(a, b);
  ok('69. 可复现（三次结果一致）', r1 === r2 && r2 === r3, [r1, r2, r3]);
  ok('70. 导出面没有"选优"入口', !hasForbiddenExport(Object.keys(scoreMod)), Object.keys(scoreMod));
}

// ═══════════════════ §14 §十五.1–3 硬闸门（补：error 不能靠低分伪装） ═══════════════════
section('§14 硬闸门：blocking error 不能靠"扣很多分"伪装成有效候选');
{
  const project = projWithIntents([wallIntent('c1')]);
  const good = firstCandidate(project);
  const sg = scoreCandidateLayout(project, good);
  ok('71. 无 blocking error ⇒ valid（feasible）', sg.status === 'valid' && sg.hardFailures.length === 0, sg.status);

  const bad = overlappingLayout(project);
  const sb = scoreCandidateLayout(project, bad);
  ok('72. ★ 有 blocking error 时软评分**一条都不产出**（不是 ERROR=-100 继续算）', sb.components.length === 0 && sb.total === null, { comps: sb.components.length, total: sb.total });
  ok('73. ★ 坏候选不可能出现在 valid 名单里（不能靠低分混进来）', sb.status === 'infeasible' && sg.status === 'valid', [sb.status, sg.status]);
  ok('74. "不评分(null)" 与 "得 0 分" 是两回事（闸门显式区分）', sb.total === null && typeof sg.total === 'number', { bad: sb.total, good: sg.total });
}

// ═══════════════════ §15 §十五.4–7 四项事实指标：全部读既有事实 ═══════════════════
section('§15 事实指标：wall-contact / opening-clear / door-swing-clear / room-inside');

/** 北墙(w3)挂一扇门的房间（房间先深拷贝 —— 用例之间不许共用 Room 对象） */
function roomWithDoor(patch: Record<string, unknown> = {}): Room {
  const room = mkRoom('r1');
  room.walls[2]!.openings = [
    { id: 'open_001', kind: 'door', offset: 1000, width: 900, hinge: 'start', swingDirection: 'into-room', ...patch } as never,
  ];
  return room;
}
/** 房间级夹具：只放 c1（位置由调用方定），可选挂门 / 去掉一面墙 */
function factProject(c1: Cabinet, opts: { door?: boolean; noDoorSwing?: boolean; unclosed?: boolean } = {}): Project {
  const room = opts.door || opts.noDoorSwing ? roomWithDoor(opts.noDoorSwing ? { swingDirection: undefined } : {}) : mkRoom('r1');
  if (opts.unclosed) room.walls = room.walls.slice(0, 3);
  const moved: Cabinet = { ...c1, roomId: room.id, placement: { ...c1.placement } };
  return { ...baseProject(), rooms: [room], cabinets: [moved] } as Project;
}
const factIntents = (): DesignIntent[] => [
  cabIntent('wall-contact', 'c1', 'di_f1'),
  cabIntent('opening-clear', 'c1', 'di_f2'),
  cabIntent('door-swing-clear', 'c1', 'di_f3'),
  cabIntent('room-inside', 'c1', 'di_f4'),
];
const compOf = (s: DesignScore, goal: string): DesignScoreComponent | undefined =>
  s.components.find((c) => c.kind === 'condition' && c.goal === goal);
/** 只把某只柜摆到指定位置的手工候选（形状与 P9.3 产出相同） */
function laidOut(p: Project, x: number, y: number, rotation: number): CandidateLayout {
  return mkLayout('cl_fact', 'c1', { x, y, rotation }, p, ['di_f1']);
}

{
  // ① 贴南墙 (1600,60) rot0 —— 背面贴墙 / 洞口 clear / 门扇 clear / 房间 inside
  const good = factProject(mkCab(mkRoom('r1'), 'c1', 1600, 60, 900, 600, 0), { door: true });
  const sg = scoreCandidateLayout({ ...good, designIntents: factIntents() } as Project, laidOut(good, 1600, 60, 0));
  ok('75. wall-contact：背面贴墙 ⇒ 命中', compOf(sg, 'wall-contact')?.hit === 'yes', compOf(sg, 'wall-contact'));
  ok('76. opening-clear：洞口关系 clear ⇒ 命中', compOf(sg, 'opening-clear')?.hit === 'yes', compOf(sg, 'opening-clear'));
  ok('77. door-swing-clear：门扇净空 clear ⇒ 命中', compOf(sg, 'door-swing-clear')?.hit === 'yes', compOf(sg, 'door-swing-clear'));
  ok('78. room-inside：房间关系 inside ⇒ 命中', compOf(sg, 'room-inside')?.hit === 'yes', compOf(sg, 'room-inside'));
  ok('79. ★ 四条事实 component 的 fact 名字与词表 spec 逐字一致（不另起叫法）',
    ['wall-contact', 'opening-clear', 'door-swing-clear', 'room-inside'].every((g) => compOf(sg, g)?.fact === designIntentGoalSpec(g as never).fact),
    ['wall-contact', 'opening-clear', 'door-swing-clear', 'room-inside'].map((g) => [g, compOf(sg, g)?.fact]));

  // ② 房间正中 —— 没靠墙 ⇒ 未命中（其余仍是 clear/inside）
  const mid = factProject(mkCab(mkRoom('r1'), 'c1', 1600, 1400, 900, 600, 0), { door: true });
  const sm = scoreCandidateLayout({ ...mid, designIntents: factIntents() } as Project, laidOut(mid, 1600, 1400, 0));
  ok('80. wall-contact：房间正中（floating）⇒ 未命中', compOf(sm, 'wall-contact')?.hit === 'no', compOf(sm, 'wall-contact'));
  ok('81. 同一份候选里其余事实照常命中（不是"一否全否"）', compOf(sm, 'room-inside')?.hit === 'yes' && compOf(sm, 'door-swing-clear')?.hit === 'yes', compOf(sm, 'room-inside'));
}
{
  // ③ 压在洞口影响带上 —— 这是**硬错误**（SPATIAL-CABINET-OPENING），不是"软失败"
  const p = factProject(mkCab(mkRoom('r1'), 'c1', 2400, 2200, 900, 600, 0), { door: true });
  const s = scoreCandidateLayout({ ...p, designIntents: factIntents() } as Project, laidOut(p, 2400, 2200, 0));
  ok('82. ★ 压在洞口上 ⇒ infeasible + 硬失败码是 SPATIAL-CABINET-OPENING（不是软 "no"）',
    s.status === 'infeasible' && s.hardFailures.some((f) => f.code === 'SPATIAL-CABINET-OPENING'),
    { status: s.status, codes: s.hardFailures.map((f) => f.code) });

  // ④ 压在门扇开启包络里 —— 同样是硬错误
  const p2 = factProject(mkCab(mkRoom('r1'), 'c1', 2400, 2340, 900, 600, 180), { door: true });
  const s2 = scoreCandidateLayout({ ...p2, designIntents: factIntents() } as Project, laidOut(p2, 2400, 2340, 180));
  ok('83. ★ 压在门扇开启包里 ⇒ infeasible + 硬失败码是 DESIGN-CABINET-DOOR-SWING',
    s2.status === 'infeasible' && s2.hardFailures.some((f) => f.code === 'DESIGN-CABINET-DOOR-SWING'),
    { status: s2.status, codes: s2.hardFailures.map((f) => f.code) });
  ok('84. 硬错误**不会**被降级成一条 hit:"no" 的条件 component', s.components.length === 0 && s2.components.length === 0, [s.components.length, s2.components.length]);
}

// ═══════════════════ §16 §十四 unknown ≠ failed ≠ clear ═══════════════════
section('§16 §十四 unknown ≠ failed ≠ clear：判不出来就说判不出来');
{
  // 门缺 swingDirection ⇒ 事实层**根本不产出**净空行（P8.9 绝不默认向内开）
  const p = factProject(mkCab(mkRoom('r1'), 'c1', 1600, 1400, 900, 600, 0), { noDoorSwing: true });
  const s = scoreCandidateLayout({ ...p, designIntents: factIntents() } as Project, laidOut(p, 1600, 1400, 0));
  const c = compOf(s, 'door-swing-clear');
  ok('85. ★ 判不出开启方向的门 ⇒ hit 是 unknown（**不是** yes）', c?.hit === 'unknown', c);
  ok('86. 该 component 的 why 里说清了"判不出来"（unknown 不伪装成结论）', /判不出|unknown/.test(c?.why ?? ''), c?.why);
  ok('87. unknown 不计入 total（total 仍等于命中数）', s.total === s.components.filter((x) => x.hit === 'yes').length, { total: s.total });

  // 房间不闭合 ⇒ 房间关系 unknown
  const p2 = factProject(mkCab(mkRoom('r1'), 'c1', 1600, 1400, 900, 600, 0), { unclosed: true });
  const s2 = scoreCandidateLayout({ ...p2, designIntents: factIntents() } as Project, laidOut(p2, 1600, 1400, 0));
  const c2 = compOf(s2, 'room-inside');
  ok('88. ★ 房间不闭合 ⇒ room-inside 是 unknown（不是 no —— 不把判不出当失败）', c2?.hit === 'unknown', c2);
  ok('89. ★ 不得假设默认值：unknown 既没被算成命中、也没被算成未命中', c2?.hit !== 'yes' && c2?.hit !== 'no', c2?.hit);
  ok('90. 房间不闭合是 WARNING（不阻断）⇒ 候选仍是 valid，unknown 才看得见', s2.status === 'valid', s2.status);
}

// ═══════════════════ §17 §十五.8–12 偏好：只有 applicable 参与 ═══════════════════
section('§17 偏好：rejected / candidate 都不参与；硬规则压制优先');
{
  const project = projWithIntents([wallIntent('c1')]);
  const cand = firstCandidate(project);
  const rot = cand.placements[0]!.resolved.rotation;
  const norm = (d: number): number => ((Math.round(d) % 360) + 360) % 360;
  const prefPred: KnowledgePredicate = { kind: 'orientation', op: 'prefer', value: norm(rot) };
  const base = makeStatedPreference({ statement: '这个柜我一直用这个朝向', predicate: prefPred, scope: { cabinet: 'c1' }, detail: '用户明说', seq: 9 });

  ok('91. active（已确认）偏好 ⇒ 参与', scoreCandidateLayout(project, cand, [base]).components.some((c) => c.preferenceId === base.id));

  const rejected = { ...base, status: 'rejected' as const };
  ok('92. ★ rejected 偏好不参与评分', !scoreCandidateLayout(project, cand, [rejected]).components.some((c) => c.preferenceId === rejected.id));

  const candidatePref = { ...base, status: 'candidate' as const, confirmedAt: undefined };
  ok('93. ★ candidate（未确认）偏好不参与评分', !scoreCandidateLayout(project, cand, [candidatePref]).components.some((c) => c.preferenceId === candidatePref.id));

  const hard = hardRuleEntries([{ code: 'TEST-HARD-ORIENT', statement: '规则：此情形禁止该朝向', predicate: { kind: 'orientation', op: 'forbid', value: norm(rot) }, scope: {} }], []);
  const sup = scoreCandidateLayout(project, cand, [...hard, base]);
  ok('94. ★ 被硬规则压制时偏好不参与，且**不覆盖**硬规则', !sup.components.some((c) => c.preferenceId === base.id) && sup.hardFailures.length === 0, sup.preferenceMatches);
  ok('95. 偏好**永远**进不了 hardFailures（偏好≠硬约束）', sup.status === 'valid', sup.status);
}

// ═══════════════════ §18 §十五.13–16 确定性：同输入同输出 / 不改 Candidate / 不改 Project ═══════════════════
section('§18 确定性：顺序无关、不改入参');
{
  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  ok('96. 至少两份候选（否则"顺序无关"无从谈起）', set.candidates.length >= 2, set.candidates.length);
  const A = set.candidates[0]!;
  const B = set.candidates[1]!;

  const forward = scoreCandidateLayoutSet(project, set);
  const reversedSet = { ...set, candidates: [...set.candidates].reverse() };
  const reversed = scoreCandidateLayoutSet(project, reversedSet);
  const scoreOf = (list: typeof forward, id: string): string =>
    JSON.stringify(list.find((x) => x.candidateId === id)?.score);
  ok('97. ★ 候选顺序变化不改变单候选的 score（A 在前或在后，结果逐字节相同）',
    scoreOf(forward, A.id) === scoreOf(reversed, A.id) && scoreOf(forward, B.id) === scoreOf(reversed, B.id));

  const candBefore = JSON.stringify(A);
  const projBefore = JSON.stringify(project);
  scoreCandidateLayout(project, A);
  scoreCandidateLayoutSet(project, set);
  ok('98. ★ 评分不修改 Candidate（逐字节不变）', JSON.stringify(A) === candBefore);
  ok('99. 评分不修改 Project（逐字节不变）', JSON.stringify(project) === projBefore);
  ok('100. 重复评分逐字节可复现', JSON.stringify(scoreCandidateLayout(project, A)) === JSON.stringify(scoreCandidateLayout(project, A)));

  // ⚠ 上面 98 抓不住"评分把候选改了"的一类写法：它在**已经被评过**的候选上取快照。
  //    所以另起一份**全新、从未被评分过**的候选来钉这一条（否则断言是瞎的 —— 实测 M5 时只有 108 变红）。
  const fresh = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' }).candidates[0]!;
  const freshBefore = JSON.stringify(fresh);
  const freshStatus = fresh.status;
  scoreCandidateLayout(project, fresh);
  ok('100b. ★ 全新候选评完分后逐字节不变（且状态仍是 draft）', JSON.stringify(fresh) === freshBefore && fresh.status === freshStatus && fresh.status === 'draft', { now: fresh.status });
}

// ═══════════════════ §19 §十五.20–26 架构：不 import 写路径 / 不产几何 / 不新增容差 ═══════════════════
section('§19 架构：不 import 写路径，不生成几何与 placement，不新增容差与旋转数学');
{
  const code = stripComments(
    readFileSync(join(SCORE_SRC, 'score.ts'), 'utf8') + '\n' + readFileSync(join(SCORE_SRC, 'model.ts'), 'utf8')
  );
  ok('101. 不 import CommandBus', !/commandBus/.test(code));
  ok('102. 不 import AI 客户端', !/aiClient|buildDesignRequest|chat\/completions/.test(code));
  ok('103. 不 import Manufacturing / 导出', !/manufacturing|\/export|dxf|bom/i.test(code));
  ok('104. 不生成 geometry（无三角函数 / 无 bbox·polygon 原语 / 无新容差）', !hasGeometrySmell(code), GEOMETRY_SMELL.exec(code)?.[0]);
  ok('105. ★ 不出现新的旋转数学（Math 只用于 round/min/max/floor/abs）',
    !/Math\.(sin|cos|tan|atan|atan2|asin|acos|hypot|sqrt|pow)\s*\(/.test(code) && !/rotation\s*[-+*/]\s*\d/.test(code),
    (code.match(/Math\.\w+\s*\(/g) ?? []).join(' '));

  const project = projWithIntents([wallIntent('c1')]);
  const s = scoreCandidateLayout(project, firstCandidate(project));
  ok('106. ★ 评分结果里没有 placement / resolved / intent（不产落位、只读事实）',
    !coordKeysIn(s).length && !/\bplacements?\b|\bresolved\b|\bintent\b/.test(JSON.stringify(s)),
    coordKeysIn(s));
}

// ═══════════════════ §20 §十一 生命周期 + §十二 AI 只读块 ═══════════════════
section('§20 候选生命周期（draft → evaluated）与 AI 只读候选评分块');
{
  const project = projWithIntents([wallIntent('c1')]);
  const cand = firstCandidate(project);

  const ev = evaluateCandidateLayout(project, cand);
  ok('107. ★ draft → evaluated：评估结果记录 fromStatus=draft、lifecycle=evaluated',
    ev.fromStatus === 'draft' && ev.lifecycle === 'evaluated' && ev.candidateId === cand.id, ev);
  ok('108. 评估**不修改**候选本身（它仍然是一份 status=draft 的产出物）', cand.status === 'draft', cand.status);
  ok('109. evaluated 是运行态：不进 project.json（序列化里查不到 evaluated 与候选 id）',
    !serializeProjectFile(project, FIXED_SAVED_AT).includes('evaluated') && !serializeProjectFile(project, FIXED_SAVED_AT).includes(cand.id));
  ok('110. 生命周期类型层没有 adopted（源码里剥掉注释后不存在这个词）',
    !/adopted/.test(stripComments(readFileSync(join(SCORE_SRC, 'model.ts'), 'utf8'))));

  const names = Object.keys(scoreMod);
  ok('111. ★ 无 auto-adopt：导出面没有 adopt / apply / commit / persist 类名字', !names.some((n) => ADOPT_LIKE.test(n)), names.filter((n) => ADOPT_LIKE.test(n)));
  ok('112. ★ 无 winner API：导出面没有 winner / best / recommended / pick 类名字', !names.some((n) => WINNER_LIKE.test(n)), names.filter((n) => WINNER_LIKE.test(n)));

  // ── §十二 AI 只读块 ──
  const snap = buildSnapshot(project, RULES);
  ok('113. 快照新增只读候选评分块（candidateScore.readOnly === true）', snap.candidateScore?.readOnly === true);
  ok('114. ★ 该块**零坐标**（没有任何 x/y/rotation/resolved/多边形）', coordKeysIn(snap.candidateScore).length === 0, coordKeysIn(snap.candidateScore));
  ok('115. 该块**不含用户偏好**且如实标注（preferencesApplied === false，免得把"没列"读成"没命中"）', snap.candidateScore.preferencesApplied === false);
  ok('116. ★ 该块里没有 winner / best / recommended / "推荐" 字样', !/winner|best|recommend|推荐/i.test(JSON.stringify(snap.candidateScore)));
  ok('117. 该块里没有任何"让候选生效"的字段（apply / adopt / commit / write）',
    !/apply|adopt|commit|write|execute/i.test(JSON.stringify(snap.candidateScore)));

  const empty = buildSnapshot(projWithIntents([]), RULES);
  ok('118. 无 active 意图时该块仍然出现（空表 + 计数 0 —— 形状稳定）',
    Array.isArray(empty.candidateScore.evaluated) && empty.candidateScore.evaluated.length === 0 && empty.candidateScore.counts.evaluated === 0,
    empty.candidateScore.counts);
  ok('119. 有 active 意图时该块确实有内容（否则"只读通道"是空的）', snap.candidateScore.evaluated.length > 0, snap.candidateScore.counts);

  const contract = readFileSync(join(APP, 'shared/aiContract.mjs'), 'utf8');
  ok('120. ★ AI 契约里写清了 candidateScore 的只读读法（看到评分 ≠ 可以据此决策）',
    contract.includes('candidateScore') && /只读/.test(contract) && /不能.{0,6}据此选择/.test(contract));
  ok('121. 动作清单仍 21 条（AI 没有获得任何"选方案 / 落地"的动作）', ACTION_NAMES.length === 21, ACTION_NAMES.length);

  // 哨兵自检（"断言不可信比失败更危险"）：用故意写坏的样本确认它们真能判红
  ok('122. 哨兵自检：ADOPT_LIKE 认得出 adoptScore', ADOPT_LIKE.test('adoptScore') === true);
  ok('123. 哨兵自检：WINNER_LIKE 认得出 pickBestCandidate', WINNER_LIKE.test('pickBestCandidate') === true);
  ok('124. 哨兵自检：两个哨兵不误伤正常导出名', ADOPT_LIKE.test('scoreCandidateLayout') === false && WINNER_LIKE.test('compareDesignScores') === false);
}

// ─────────────────────────── 汇总 ───────────────────────────
console.log(`\n═══════════ P9.4 Design Score 验收：通过 ${passed} / 失败 ${failed} ═══════════`);
if (failed > 0) {
  console.log('失败清单：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
