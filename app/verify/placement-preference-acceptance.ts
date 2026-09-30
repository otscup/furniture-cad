/**
 * ══════════════════════════════════════════════════════════════════════
 *  P8.4 验收 —— Placement Preference / Design Knowledge Integration
 *
 *  出口判据：**偏好只能影响"建议什么"，永远不能影响"几何怎么算"**。
 *
 *  ── 这一批断言真正在防什么 ──
 *   ① **观察越界。** 只有"能证明是用户选择的朝向改动"才能成为证据 ——
 *      AI 给的、系统解析的、同值写入的、纯移动的，一律不产生偏好。
 *      否则系统会把自己的输出当用户的习惯，自我强化成一圈死循环。
 *   ② **无上下文的朝向偏好。** 「corner 一律 270」是把设计习惯硬编码成规则。
 *      偏好必须带 {contact, turnSide}，换情形就不适用 —— 这条由
 *      `PlacementContext` 在类型层与冲突检测层同时钉住。
 *   ③ **preference 进 Resolver。** `placement.ts` 里不许出现 knowledge
 *      （源码扫描）；有偏好 / 没偏好，同一个 intent 的解析结果必须逐值相同。
 *   ④ **candidate 自动升级。** 没确认的知识不进 applicable，
 *      `preferredOrientation` 也读不到它（读不到才是"没依据就别说"）。
 *   ⑤ **偏好消灭 P8.3 结论。** 有偏好时 warning 仍是 warning、error 仍是 error，
 *      alternatives 与 ambiguity 一个都不能少 —— 偏好不删除多解。
 *   ⑥ **偏好改模型。** knowledge 层跑完，project 逐字节不变。
 *
 *  注：场景沿用 P8.3 的真实 L 型（主臂 + 副臂 rot90 贴门脸），不另造夹具。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, DiffEntry, FurnitureAssembly, Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import * as CMD from '../src/core/commands.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import { resolvePlacement, sceneFromProject, type PlacementIntent } from '../src/core/placement.ts';
import { cornerTurnSide, validatePlacementDesign } from '../src/core/placementDesign.ts';
import { deriveContacts } from '../src/core/relations.ts';
import { compileProposal, type ProposalCompile } from '../src/ai/compileProposal.ts';
import { commitPlan, dryRunPlan } from '../src/ai/planRunner.ts';
import type { DesignProposal } from '../src/ai/proposal.ts';
import {
  confirmKnowledge,
  hardRuleEntries,
  knowledgeDigest,
  makeStatedPreference,
  observeCommand,
  placementContextOf,
  preferredOrientation,
  recordObservation,
  rejectKnowledge,
  resolveKnowledge,
  saveKnowledge,
  type HardRuleRef,
  type KnowledgeEntry,
  type PlacementContext,
} from '../src/ai/knowledge/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
let section_ = '';
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`[${section_}] ${name}`);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(t: string): void {
  section_ = t;
  console.log(`\n【${t}】`);
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ───────────────────────── 场景 ─────────────────────────

const ROOM = rectRoom({ name: '测试房', x: 0, y: 0, w: 9000, h: 6000, thickness: 100, height: 2700 });

function mkCab(id: string, name: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet {
  return createCabinet({
    id,
    name,
    roomId: ROOM.id,
    x,
    y,
    rotation,
    rules,
    params: { ...defaultCabinetParams(rules), width: w, height: 2200, depth: d },
    units: defaultUnits(w, rules, d),
  });
}

function mkProject(cabs: Cabinet[], assemblies?: FurnitureAssembly[]): Project {
  return {
    schemaVersion: '0.3',
    id: 'proj_p84',
    name: 'P8.4 落位偏好验收',
    ruleSetId: rules.id,
    rooms: [ROOM],
    cabinets: cabs,
    ...(assemblies ? { assemblies } : {}),
  };
}

const asmOf = (id: string, a: string, b: string, kind: 'corner' | 'butt' | 'stack' = 'corner'): FurnitureAssembly => ({
  id,
  name: 'L 型组合',
  roomId: ROOM.id,
  memberIds: [a, b],
  connections: [{ id: `${id}_c1`, kind, a: { cabinetId: a }, b: { cabinetId: b }, origin: 'authored' }],
});

/** 主臂 A：rot0，(2000,60) 1500×600 ⇒ x[2000,3500] y[60,660]，门脸朝 +Y */
const armA = (): Cabinet => mkCab('cab_A', '主臂A', 2000, 60, 1500, 600, 0);
/** 副臂 rot90 贴死 A 的右端 —— 几何成立但贴的是门脸（P8.2 真实案例） */
const armBBad = (): Cabinet => mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90);

const CTX_RIGHT: PlacementContext = { contact: 'corner', turnSide: 'right' };
const CTX_LEFT: PlacementContext = { contact: 'corner', turnSide: 'left' };

const rotDiff = (from: number, to: number): DiffEntry[] => [{ path: 'placement.rotation', from, to }];
const xyDiff = (): DiffEntry[] => [
  { path: 'placement.x', from: 4100, to: 4200 },
  { path: 'placement.y', from: 60, to: 60 },
];

// ═══════════════ §1 用户真实修改 → candidate ═══════════════
section('§1 用户改朝向 → 产生 candidate（带上下文）');
let observed: KnowledgeEntry[] = [];
{
  const project = mkProject([armA(), armBBad()], [asmOf('asm_1', 'cab_A', 'cab_B')]);
  const ctx = placementContextOf(project, 'cab_B');
  ok('上下文可判定（声明的 corner 组合里）', ctx !== null && ctx.contact === 'corner', JSON.stringify(ctx));
  ok('转角方向来自 P8.3 的确定性事实（以对方柜为视角）',
    ctx?.turnSide === cornerTurnSide(project.cabinets[0]!, project.cabinets[1]!), JSON.stringify(ctx));

  const cmd = CMD.rotateCabinet(project.cabinets[1]!, 270, 'ui');
  const obs = observeCommand(cmd, rotDiff(90, 270), '副臂B', ctx);
  ok('人的朝向改动产生 1 条观察', obs.length === 1, JSON.stringify(obs));
  ok('观察是 user-observed，不是 ai-inferred', obs[0]?.evidence.source === 'user-observed', JSON.stringify(obs[0]?.evidence));
  ok('谓词带上下文（不是裸的"喜欢 270"）', eq(obs[0]?.predicate.context, ctx), JSON.stringify(obs[0]?.predicate));
  ok('谓词维度是 orientation / op=prefer', obs[0]?.predicate.kind === 'orientation' && obs[0]?.predicate.op === 'prefer');
  ok('值 = 改成的那个朝向（270）', obs[0]?.predicate.value === 270, JSON.stringify(obs[0]?.predicate.value));
  ok('陈述里点明是哪一类情形（人话里看得见上下文）',
    String(obs[0]?.statement).includes('角接') && String(obs[0]?.statement).includes('90') && String(obs[0]?.statement).includes('270'),
    String(obs[0]?.statement));

  observed = recordObservation([], obs[0]!);
  ok('观察只产生 candidate（永不自动升级）', observed[0]?.status === 'candidate', JSON.stringify(observed[0]?.status));
  ok('candidate 置信度低（<0.5，最后一步留给用户）', (observed[0]?.confidence ?? 1) < 0.5, String(observed[0]?.confidence));
  ok('未确认的 candidate 不进 applicable（不参与规划）',
    resolveKnowledge({}, observed).applicable.length === 0);
  ok('未确认时 preferredOrientation 返回 null（没依据就别说）', preferredOrientation(resolveKnowledge({}, observed), CTX_RIGHT) === null);

  // 重复同类观察：只累积证据，不升级
  const twice = recordObservation(observed, { ...obs[0]!, evidence: { ...obs[0]!.evidence, at: Date.now() + 1 } });
  ok('同类观察累积到同一条（不新增条目）', twice.length === 1 && twice[0]!.evidence.length === 2);
  ok('累积也**不会**自动升级为 active', twice[0]?.status === 'candidate');
}

// ═══════════════ §2 AI / 系统 / Resolver 不冒充用户 ═══════════════
section('§2 AI 改动 / 系统解析不产生用户偏好证据');
{
  const project = mkProject([armA(), armBBad()], [asmOf('asm_1', 'cab_A', 'cab_B')]);
  const ctx = placementContextOf(project, 'cab_B');

  const aiCmd = CMD.rotateCabinet(project.cabinets[1]!, 270, 'ai');
  ok('AI 给的朝向：一条观察都不产生（不得冒充 user-observed）',
    observeCommand(aiCmd, rotDiff(90, 270), '副臂B', ctx).length === 0);
  const aiCand = recordObservation([], {
    predicate: { kind: 'orientation', op: 'prefer', value: 270, context: ctx! },
    statement: 'AI 给的朝向',
    evidence: { at: Date.now(), source: 'ai-inferred', detail: 'AI 提案里写的 270' },
  });
  ok('即便登记了 ai-inferred 条目，也读不到"用户偏好"（来源是硬证据）',
    aiCand[0]!.evidence[0]!.source === 'ai-inferred' && resolveKnowledge({}, aiCand).applicable.length === 0);
  ok('AI 来源的条目只是 candidate，永不自动 active（观察 ≠ 偏好）', aiCand[0]!.status === 'candidate');
  ok('用户的朝向偏好不挂在柜子名上（挂情形，才可复用）',
    (observed[0]?.scope.cabinet ?? null) === null, JSON.stringify(observed[0]?.scope));

  const sysCmd = CMD.rotateCabinet(project.cabinets[1]!, 270, 'system');
  ok('撤销 / 系统命令不观察', observeCommand(sysCmd, rotDiff(90, 270), '副臂B', ctx).length === 0);

  // Resolver 自己算出来的位置：cabinet.place 一律不观察（哪怕是 ui 触发）
  const placeCmd = CMD.placeCabinet(project.cabinets[1]!, { x: 3500, y: 1560, rotation: 270 }, 'ui');
  ok('cabinet.place（Resolver 算的坐标）不产生偏好',
    observeCommand(placeCmd, rotDiff(90, 270), '副臂B', ctx).length === 0);
}

// ═══════════════ §3 同值写入 / 普通移动不产生 ═══════════════
section('§3 同值写入、纯移动不产生朝向偏好');
{
  const project = mkProject([armA(), armBBad()], [asmOf('asm_1', 'cab_A', 'cab_B')]);
  const ctx = placementContextOf(project, 'cab_B');
  const cab = project.cabinets[1]!;

  ok('270 → 270 同值写入不产生观察', observeCommand(CMD.rotateCabinet(cab, 270, 'ui'), rotDiff(270, 270), '副臂B', ctx).length === 0);
  ok('等价角（-90 ≡ 270）不算改动', observeCommand(CMD.rotateCabinet(cab, 270, 'ui'), rotDiff(-90, 270), '副臂B', ctx).length === 0);
  ok('只挪 x/y（cabinet.move）不产生朝向偏好',
    observeCommand(CMD.moveCabinet(cab, 4200, 60, 'ui'), xyDiff(), '副臂B', ctx).length === 0);
  ok('cabinet.update 只改 x/y 也不产生朝向偏好',
    observeCommand({ ...CMD.rotateCabinet(cab, 270, 'ui'), op: 'cabinet.update' } as never, xyDiff(), '副臂B', ctx).length === 0);
  ok('没有上下文（孤立柜体）时不产生朝向偏好',
    observeCommand(CMD.rotateCabinet(cab, 270, 'ui'), rotDiff(90, 270), '副臂B', null).length === 0);
  ok('无上下文的孤立柜：placementContextOf 返回 null', placementContextOf(mkProject([mkCab('solo', '孤柜', 1000, 1000, 900, 600)]), 'solo') === null);
}

// ═══════════════ §4 上下文不同 = 两类情形 ═══════════════
section('§4 上下文不同不合并、不互相冲突');
{
  const right = makeStatedPreference({
    statement: '右转角的副臂我习惯朝 270°',
    predicate: { kind: 'orientation', op: 'prefer', value: 270, context: CTX_RIGHT },
    detail: '用户明说',
    seq: 1,
  });
  const left = makeStatedPreference({
    statement: '左转角的副臂我习惯朝 90°',
    predicate: { kind: 'orientation', op: 'prefer', value: 90, context: CTX_LEFT },
    detail: '用户明说',
    seq: 2,
  });
  const res = resolveKnowledge({}, [right, left]);
  ok('两条不同上下文的朝向偏好**都**进 applicable（不是二选一）', res.applicable.length === 2, JSON.stringify(res.applicable.length));
  ok('它们不被判成冲突（右转角 270 ≠ 左转角 90 并不矛盾）', res.conflicts.length === 0, JSON.stringify(res.conflicts.map((c) => c.reason)));
  ok('按上下文取建议：右转角 → 270', preferredOrientation(res, CTX_RIGHT) === 270);
  ok('按上下文取建议：左转角 → 90', preferredOrientation(res, CTX_LEFT) === 90);

  // 同一上下文两条不同值 = 真冲突（双方都保留，不静默覆盖）
  const clash = makeStatedPreference({
    statement: '右转角我又要 90°',
    predicate: { kind: 'orientation', op: 'prefer', value: 90, context: CTX_RIGHT },
    detail: '用户明说',
    seq: 3,
  });
  const res2 = resolveKnowledge({}, [right, clash]);
  ok('同一上下文的两条不同朝向 = 冲突（不静默覆盖）', res2.conflicts.length === 1);
  ok('冲突双方都保留在 applicable（请人工裁决，系统不替选）', res2.applicable.length === 2);

  // 累积时也按上下文分开
  const acc = recordObservation(
    recordObservation([], { predicate: { kind: 'orientation', op: 'prefer', value: 270, context: CTX_RIGHT }, statement: 'a', evidence: { at: 1, source: 'user-observed', detail: 'a' } }),
    { predicate: { kind: 'orientation', op: 'prefer', value: 270, context: CTX_LEFT }, statement: 'b', evidence: { at: 2, source: 'user-observed', detail: 'b' } },
  );
  ok('同值不同上下文 → 两条独立候选（不合并成一条"永远 270"）', acc.length === 2, JSON.stringify(acc.map((e) => e.predicate?.context)));
}

// ═══════════════ §5 candidate → active / rejected ═══════════════
section('§5 生命周期：确认才 active，拒绝后不得生效');
let activeList: KnowledgeEntry[] = [];
{
  const confirmed = confirmKnowledge(observed, observed[0]!.id);
  ok('确认后状态 = active', confirmed[0]?.status === 'active', JSON.stringify(confirmed[0]?.status));
  ok('确认后置信度置 1', confirmed[0]?.confidence === 1);
  ok('确认时刻已登记', typeof confirmed[0]?.confirmedAt === 'number');
  ok('确认后 preferredOrientation 读到 270（右转角情形）', preferredOrientation(resolveKnowledge({}, confirmed), CTX_RIGHT) === 270);
  ok('确认后**换情形**就读不到（左转角不给建议）', preferredOrientation(resolveKnowledge({}, confirmed), CTX_LEFT) === null);
  activeList = confirmed;

  const rejected = rejectKnowledge(observed, observed[0]!.id);
  ok('拒绝后状态 = rejected', rejected[0]?.status === 'rejected');
  ok('拒绝后不进 applicable', resolveKnowledge({}, rejected).applicable.length === 0);
  ok('拒绝后 preferredOrientation 返回 null', preferredOrientation(resolveKnowledge({}, rejected), CTX_RIGHT) === null);
  ok('确认 / 拒绝都不改原数组（返回新列表）',
    observed[0]?.status === 'candidate' && confirmed !== observed && rejected !== observed);
}

// ═══════════════ §6 偏好不改 Resolver ═══════════════
section('§6 偏好不改 Resolver（几何仍然纯确定性）');
{
  const placementSrc = readFileSync(join(APP, 'src', 'core', 'placement.ts'), 'utf8');
  ok('placement.ts 里没有 knowledge（落位层读不到偏好，结构上就不可能）',
    !/knowledge/i.test(placementSrc), '出现 knowledge 字样');
  ok('placement.ts 不 import ai 层', !/from '\.\.\/ai\//.test(placementSrc));
  const designSrc = readFileSync(join(APP, 'src', 'core', 'placementDesign.ts'), 'utf8');
  ok('placementDesign.ts 不 import knowledge（设计校验同样不看偏好）', !/from '.*knowledge/.test(designSrc));
  ok('placement.ts 不 import knowledge 模块（落位层读不到偏好）', !/from '.*knowledge/.test(placementSrc));

  const project = mkProject([armA(), mkCab('cab_B', '副臂B', 6000, 60, 900, 600, 90)]);
  const intent: PlacementIntent = { relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' };
  saveKnowledge([]);
  const without = resolvePlacement(intent, sceneFromProject(project));
  saveKnowledge(activeList);
  const with_ = resolvePlacement(intent, sceneFromProject(project));
  ok('有偏好 / 没偏好：同一 intent 的解析结果逐值相同',
    eq(without, with_), JSON.stringify([without, with_]));
  ok('解析结果仍然不带"建议"字段（ResolvedPlacement 只有 x/y/rotation）',
    without.ok && eq(Object.keys(without.placement).sort(), ['rotation', 'x', 'y']), JSON.stringify(without));
  saveKnowledge([]);
}

// ═══════════════ §7 偏好不改 Semantic Model ═══════════════
section('§7 knowledge 层跑完，Semantic Model 逐字节不变');
{
  const project = mkProject([armA(), armBBad()], [asmOf('asm_1', 'cab_A', 'cab_B')]);
  const before = JSON.stringify(project);
  const ctx = placementContextOf(project, 'cab_B');
  const res = resolveKnowledge({}, activeList);
  const d = knowledgeDigest(res);
  preferredOrientation(res, ctx!);
  ok('project 未被修改', JSON.stringify(project) === before);
  ok('柜体字段没多出偏好之类的东西', eq(Object.keys(project.cabinets[0]!), Object.keys(armA())));
  ok('knowledge 输出里没有 command / action / patch（不产生可执行物）',
    !('command' in res) && !('actions' in res) && !('patch' in res));
  ok('摘要里明确写着这是偏好不是约束', d.includes('适用情形') && d.includes('偏好'), d.slice(0, 200));
}

// ═══════════════ §8 Hard Rule > Preference ═══════════════
section('§8 Hard Rule 优先于 Preference（两条路径都验）');
{
  // ① Resolver 层：硬规则禁止的朝向，偏好被压制且不进 applicable
  const HARD: HardRuleRef[] = [
    {
      code: 'RULE-P84-ORIENTATION-FORBIDDEN',
      statement: '该组合的 270° 朝向被规则集禁止（验收用硬规则）',
      predicate: { kind: 'orientation', op: 'forbid', value: 270, context: CTX_RIGHT },
      scope: {},
    },
  ];
  const hard = hardRuleEntries(HARD, []);
  const pref = activeList[0]!;
  const res = resolveKnowledge({}, [...hard, pref]);
  ok('与硬规则冲突的偏好被压制（不进 applicable）', res.applicable.filter((r) => r.entry.id === pref.id).length === 0);
  ok('被压制的偏好仍在 suppressed 里（保留来源，不静默丢）', res.suppressed.length === 1);
  ok('冲突 kind = hard-rule-beats-preference', res.conflicts[0]?.kind === 'hard-rule-beats-preference');
  ok('硬规则压制时 preferredOrientation 读不到（不返回被禁的 270）', preferredOrientation(res, CTX_RIGHT) === null);

  // ② 流水线层：偏好在，但 P8.3 的硬事实结论不变（声明 corner 实际 butt → 仍 error）
  const lying = mkProject(
    [armA(), mkCab('cab_B', '副臂B', 3500, 60, 900, 600, 0)],
    [asmOf('asm_1', 'cab_A', 'cab_B', 'corner')],
  );
  const repNoPref = validatePlacementDesign(lying);
  saveKnowledge(activeList);
  const repWithPref = validatePlacementDesign(lying);
  saveKnowledge([]);
  ok('声明 corner 实际 butt ⇒ P8.3 给出 error（硬事实）', repNoPref.status === 'error', JSON.stringify(repNoPref.status));
  ok('有偏好的情况下结论**完全一样**（偏好不绕过 P8.3）', eq(repNoPref, repWithPref));
}

// ═══════════════ §9 P8.3 warning 不被偏好消灭 ═══════════════
section('§9 偏好不消灭 P8.3 结论，也不删除多解');
{
  // 真实场景：副臂 rot90 贴死主臂右端 —— 几何严丝合缝，但贴的是**门脸**
  const project = mkProject([armA(), armBBad()]);
  saveKnowledge([]);
  const noPref = validatePlacementDesign(project);
  saveKnowledge(activeList);
  const withPref = validatePlacementDesign(project);
  saveKnowledge([]);

  ok('几何合法但门脸朝内 ⇒ 仍是 warning', noPref.status === 'warning', JSON.stringify(noPref.status));
  ok('报的正是 DESIGN-FRONT-BLOCKED（用户点名的那条）',
    noPref.findings.some((f) => f.code === 'DESIGN-FRONT-BLOCKED'), JSON.stringify(noPref.findings.map((f) => f.code)));
  ok('有偏好时结论逐值相同（偏好不把 warning 抹成 valid）', eq(noPref, withPref));
  const f = noPref.findings.find((x) => x.code === 'DESIGN-FRONT-BLOCKED');
  ok('结论里仍带候选朝向', (f?.alternatives?.length ?? 0) > 0, JSON.stringify(f?.alternatives));
  ok('多解仍然保留 ambiguous（偏好不替用户挑一个）', f?.ambiguous === true);
  ok('偏好的 270 确实在候选里（偏好只是候选之一，不是"唯一正确答案"）',
    (f?.alternatives ?? []).some((a) => a.rotation === 270), JSON.stringify(f?.alternatives?.map((a) => a.rotation)));
  ok('系统没有自动改 rotation（模型里副臂仍是 90）',
    project.cabinets[1]!.placement.rotation === 90, String(project.cabinets[1]!.placement.rotation));
  ok('P2 的接触事实仍在（deriveContacts 说这两柜相接）', deriveContacts(project).length > 0);
}

// ═══════════════ §10 带偏好的 Proposal：preview == commit ═══════════════
section('§10 偏好只进提案（rotation 语义意图），preview 仍 === commit');
{
  const project = mkProject([armA()]);
  const res = resolveKnowledge({}, activeList);
  const want = preferredOrientation(res, CTX_RIGHT);
  ok('偏好给出的建议朝向 = 270', want === 270, String(want));

  // 项目里已有主臂 A，方案只提"给它接一条副臂"—— 偏好决定副臂朝哪边
  const proposal: DesignProposal = {
    title: '主卧 L 型',
    summary: '主臂旁接一条副臂，成 L 型',
    room: '测试房',
    cabinets: [
      {
        ref: 'b',
        name: '副臂B',
        width: 900,
        height: 2200,
        depth: 600,
        rotation: want ?? undefined,
        placement: { relation: 'adjacent', reference: '主臂A', side: 'right' },
      },
    ],
    assumptions: [],
    questions: [],
  };
  const compiled: ProposalCompile = compileProposal(proposal, project, rules);
  ok('方案编译成功', compiled.ok, compiled.blockedReason ?? '');
  const createB = compiled.actions.find((a) => a.action === 'cabinet.create');
  ok('偏好只影响"建议什么"：它变成提案里的语义 rotation 意图', Number(createB?.params?.rotation) === 270, JSON.stringify(createB?.params?.rotation));
  ok('提案里没有任何坐标字段（AI 仍不直接决定 x/y）',
    !compiled.actions.some((a) => ['atX', 'atY', 'x', 'y'].some((k) => k in (a.params ?? {}))), JSON.stringify(compiled.actions.map((a) => a.params)));

  const bus = new CommandBus(project, rules);
  const run = dryRunPlan({ bus, actions: compiled.actions });
  const draftPlacements = run.draft.cabinets.map((c) => [c.name, c.placement]).sort();
  const cm = commitPlan(run, bus);
  ok('提交成功', cm.ok, cm.error ?? '');
  const finalPlacements = bus.getState().cabinets.map((c) => [c.name, c.placement]).sort();
  ok('preview === commit（带偏好的方案也一样）', eq(draftPlacements, finalPlacements), JSON.stringify([draftPlacements, finalPlacements]));
  ok('建出来的副臂 rotation = 270（偏好只是被采纳，不是被强制执行）',
    bus.getState().cabinets.find((c) => c.name === '副臂B')?.placement.rotation === 270,
    JSON.stringify(bus.getState().cabinets.find((c) => c.name === '副臂B')?.placement));
  ok('干跑预览仍带 P8.3 设计结论（偏好不跳过校验）', run.design !== undefined, JSON.stringify(run.design?.status));

  // 同一份提案**不带**偏好：位置解析必须一致（偏好只改建议，不改几何算法）
  const noPrefProposal: DesignProposal = { ...proposal, cabinets: proposal.cabinets.map((c) => ({ ...c, rotation: null })) };
  saveKnowledge([]);
  const compiled2 = compileProposal(noPrefProposal, project, rules);
  const bus2 = new CommandBus(project, rules);
  const run2 = dryRunPlan({ bus: bus2, actions: compiled2.actions });
  saveKnowledge(activeList);
  ok('没偏好时编译也成功（旧项目行为不变）', compiled2.ok, compiled2.blockedReason ?? '');
  ok('没有偏好 → 不写 rotation 意图（缺省，不是硬塞 270）',
    compiled2.actions.find((a) => a.action === 'cabinet.create')?.params?.rotation === undefined);
  ok('有/无偏好两条链路都走同一条 dry-run（不是两套）', run.design !== undefined && run2.design !== undefined);
  ok('没偏好时副臂 rotation 保持缺省（系统不替用户挑朝向）',
    run2.draft.cabinets.find((c) => c.name === '副臂B')?.placement.rotation === 0,
    JSON.stringify(run2.draft.cabinets.find((c) => c.name === '副臂B')?.placement));

  // 偏好换一个值，位置也跟着**重新解析** —— 证明确实是"偏好改意图、Resolver 算几何"
  const pref90: DesignProposal = { ...proposal, cabinets: proposal.cabinets.map((c) => ({ ...c, rotation: 90 })) };
  const bus3 = new CommandBus(project, rules);
  const run3 = dryRunPlan({ bus: bus3, actions: compileProposal(pref90, project, rules).actions });
  const b270 = bus.getState().cabinets.find((c) => c.name === '副臂B')!.placement;
  const b90 = run3.draft.cabinets.find((c) => c.name === '副臂B')!.placement;
  ok('偏好不同 ⇒ 解析出的位置不同（朝向变了 footprint 就变了，位置重算）',
    b270.x !== b90.x || b270.y !== b90.y, JSON.stringify([b270, b90]));
  ok('两种偏好都只是"建议"（都能落地，系统不宣称 270 是唯一正确答案）', run3.design !== undefined);
  ok('按 270 落地后：P2 判定两柜确实相接（几何由 Resolver 保证，不是偏好保证）',
    deriveContacts(bus.getState()).length > 0);
}

// ═══════════════ §11 knowledge 层纯函数 ═══════════════
section('§11 knowledge 层纯函数（输入不被修改）');
{
  const snapshot = JSON.stringify(activeList);
  const res = resolveKnowledge({}, activeList);
  knowledgeDigest(res);
  preferredOrientation(res, CTX_RIGHT);
  confirmKnowledge(activeList, activeList[0]!.id);
  rejectKnowledge(activeList, activeList[0]!.id);
  ok('resolveKnowledge / digest / confirm / reject 都不改入参', JSON.stringify(activeList) === snapshot);

  const p = mkProject([armA(), armBBad()], [asmOf('asm_1', 'cab_A', 'cab_B')]);
  const pBefore = JSON.stringify(p);
  placementContextOf(p, 'cab_B');
  ok('placementContextOf 不改 project', JSON.stringify(p) === pBefore);

  const again = resolveKnowledge({}, activeList);
  ok('同一输入两次解析结果相同（确定性）', eq(again, res));
}

// ═══════════════ §12 旧项目兼容（没有落位知识 → 原行为） ═══════════════
section('§12 没有落位知识的项目保持原行为');
{
  saveKnowledge([]);
  const legacy = resolveKnowledge({}, []);
  ok('空知识：applicable 为空', legacy.applicable.length === 0);
  ok('空知识：preferredOrientation 返回 null（不猜默认值）', preferredOrientation(legacy, CTX_RIGHT) === null);
  ok('空知识：摘要为空字符串（不往提示词里塞空话）', knowledgeDigest(legacy) === '');

  // 旧维度（行高/抽屉数）的观察行为完全没变
  const legacyCmd = { id: 'c', op: 'cabinet.update', source: 'ui', target: { kind: 'cabinet', id: 'x' }, changes: [], label: '改行高' } as never;
  ok('旧维度观察未受影响（行高改动仍产生观察）',
    observeCommand(legacyCmd, [{ path: 'layout.rows.0.height', from: 550, to: 600 }] as DiffEntry[], '主卧衣柜').length === 1);
  ok('旧维度观察未受影响（挪位置仍不产生观察）',
    observeCommand(legacyCmd, [{ path: 'placement.x', from: 0, to: 700 }] as DiffEntry[], '主卧衣柜').length === 0);
  ok('旧的数值冲突判定未受影响（450 硬规则 vs 400 偏好仍被压制）', (() => {
    const HARD: HardRuleRef[] = [{ code: 'X', statement: '最小净宽 450', predicate: { kind: 'rowHeight', op: 'min', value: 450 }, scope: {} }];
    const p400 = makeStatedPreference({ statement: '喜欢 400', predicate: { kind: 'rowHeight', op: 'prefer', value: 400 }, detail: 'x', seq: 9 });
    const r = resolveKnowledge({}, [...hardRuleEntries(HARD, []), p400]);
    return r.suppressed.length === 1 && r.conflicts[0]?.kind === 'hard-rule-beats-preference';
  })());
}

// ═══════════════ §13 上下文来源：声明优先 / 派生退化 / stack 不可判定 ═══════════════
section('§13 上下文只取自 P2 / P8.3 的既有事实');
{
  // ① 无声明 → 退化到 deriveContacts 的派生事实
  const noDecl = mkProject([armA(), mkCab('cab_B', '副臂B', 3500, 60, 900, 600, 0)]);
  const derived = placementContextOf(noDecl, 'cab_B');
  ok('无声明时上下文来自派生接触（P2 deriveContacts）', derived?.contact === 'butt', JSON.stringify(derived));
  ok('派生接触的 kind 与 deriveContacts 一致',
    derived?.contact === (deriveContacts(noDecl).find((c) => c.a === 'cab_B' || c.b === 'cab_B')?.kind ?? null), JSON.stringify(derived));

  // ② stack 需要 Z —— 本阶段不可判定，绝不退化成 corner
  const stacked = mkProject([armA(), armBBad()], [asmOf('asm_1', 'cab_A', 'cab_B', 'stack')]);
  ok('声明 stack ⇒ 上下文不可判定（本阶段不做 Z，不偷换）', placementContextOf(stacked, 'cab_B') === null);
  ok('stack 组合里改朝向也不产生偏好（说不清是哪一类情形就不记）',
    observeCommand(CMD.rotateCabinet(stacked.cabinets[1]!, 270, 'ui'), rotDiff(90, 270), '副臂B', placementContextOf(stacked, 'cab_B')).length === 0);

  // ③ 上下文不是新造的字段：模型里没有 orientation / facing 之类的第二真相
  ok('柜体上不挂朝向偏好字段（偏好住知识层，不住模型）',
    eq(Object.keys(armA().placement).sort(), ['rotation', 'x', 'y']));
  ok('柜体顶层没有 facing / orientation 字段', !('facing' in armA()) && !('orientation' in armA()));
}

// ═══════════════════ 汇总 ═══════════════════
console.log(`\n总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败断言：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
