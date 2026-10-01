/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.3 Candidate Layout Foundation 验收
 *
 *  ── 要证明的核心命题 ──
 *    ① 候选**不是** Cabinet / 不是 Project / 不是 File schema：
 *       候选落位里只有引用（id）+ 语义意图 + resolver 输出，长不出 Cabinet；
 *    ② 候选**不污染模型**：生成前后 `project` 逐字节不变、`project.json` 逐字节不变、
 *       不升 `schemaVersion`、序列化结果里不出现任何候选 id；
 *    ③ 候选**只能过 Resolver**：每条落位的坐标必须等于 `resolvePlacement` 对一个
 *       `PlacementIntent` 的输出（源码里也必须真的存在这个调用）；
 *    ④ 候选的校验**与真实校验同一份**：把柜按候选摆到副本上跑 `detectCollisions`
 *       （与 CommandBus 同一来源）应与候选里的 `issues` 逐字节相同；
 *    ⑤ 多候选**独立存在**且互不相同的摆法（A/B/C 三档策略）；
 *    ⑥ **没有 adopt**：导出面里没有 adopt / apply / commit / persist 任何名字；
 *    ⑦ AI 契约里候选请求**没有几何**（x/y/rotation 一律拒收），动作清单仍 21 条；
 *    ⑧ 未生效的意图（rejected / 不存在 / 未确认）**不产生候选**。
 *
 *  ── 判据纪律（本项目反复钉过的）──
 *    · 每条失败先打原始值 —— **先假定断言自己写错**；
 *    · 夹具每次自己造（共享对象引用会让用例互相污染 → 假绿）；
 *    · 参与逐字节比较的意图**钉死时间戳**（Date.now 每毫秒都在变）；
 *    · 哨兵必须**做过自检**（用一个"故意写坏的样本"确认哨兵真能红，
 *      否则它可能永远是绿的 —— 断言不可信比失败更危险）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room, RuleSet } from '../src/core/types.ts';
import { parseProjectFile, serializeProjectFile } from '../src/core/projectFile.ts';
import { resolvePlacement, sceneFromProject } from '../src/core/placement.ts';
import { detectCollisions } from '../src/core/geometry/project.ts';
import { activeDesignIntents, makeStatedIntent, rejectIntent, type DesignIntent } from '../src/core/designIntent/index.ts';
import {
  ACTION_NAMES,
  CANDIDATE_REQUEST_KEYS as CONTRACT_CANDIDATE_KEYS,
  buildUserMessage,
  validateCandidateRequest,
} from '../shared/aiContract.mjs';
import {
  CANDIDATE_REQUEST_KEYS as MODEL_CANDIDATE_KEYS,
  MAX_CANDIDATES_PER_TARGET,
  generateCandidateLayouts,
  type CandidateLayout,
  type CandidatePlacement,
} from '../src/core/candidateLayout/index.ts';
import * as candidateMod from '../src/core/candidateLayout/index.ts';

const APP = join(import.meta.dirname, '..');
const SRC_DIR = join(APP, 'src/core/candidateLayout');
const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset', 'factory-default.json'), 'utf8')) as RuleSet;
/** 逐字节比较前必须固定 savedAt（serializeProjectFile 默认用当前时间） */
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
/**
 * 每次调用都是全新对象（共享引用会让用例互相污染）。
 * c1 刻意放在房间**中间**（不贴墙）—— 这样 wall-contact 至少有得挑；
 * c2 贴在南墙上，作为"某些贴墙落点会撞到它"的障碍物。
 */
function baseProject(): Project {
  const room = mkRoom('r1');
  return {
    schemaVersion: '0.2',
    id: 'p_cl',
    name: 'P93',
    ruleSetId: RULES.id,
    rooms: [room],
    cabinets: [mkCab(room, 'c1', 1600, 1400, 900, 600, 0), mkCab(room, 'c2', 400, 60, 900, 600, 0)],
  } as Project;
}
/** 钉死时间戳：逐字节比较 / 确定性比较的前提 */
const T0 = 1_700_000_000_000;
const pin = (i: DesignIntent, at = T0): DesignIntent => ({
  ...i,
  createdAt: at,
  updatedAt: at,
  evidence: i.evidence.map((e) => ({ ...e, at })),
});
/**
 * 造意图时**显式指定 id**：两个夹具若都从空集合取号就都会拿到 `di_001`，
 * 而撞 id 不会报错、只会让两条意图共用一条记录（本项目反复钉过的坑）。
 */
const wallIntent = (cabId: string, id = 'di_001'): DesignIntent => ({
  ...pin(
    makeStatedIntent({ goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: cabId }, detail: '用户：这个柜贴墙', taken: new Set<string>() })
  ),
  id,
});
const standaloneIntent = (cabId: string, id = 'di_002'): DesignIntent => ({
  ...pin(
    makeStatedIntent({ goal: 'standalone', scope: { kind: 'cabinet', cabinetId: cabId }, detail: '用户：这个柜独立摆', taken: new Set<string>() })
  ),
  id,
});
const priorityIntent = (id = 'di_003'): DesignIntent => ({
  ...pin(makeStatedIntent({ goal: 'storage-priority', scope: { kind: 'room', roomId: 'r1' }, detail: '用户：以储物为主', taken: new Set<string>() })),
  id,
});
const projWithIntents = (intents: DesignIntent[]): Project => ({ ...baseProject(), designIntents: intents });

// ─────────────────────── 哨兵（会被自检的判据） ───────────────────────

const PLACEMENT_KEYS = new Set(['targetId', 'intent', 'resolved', 'issues', 'satisfies']);
/** 候选落位里**只有**这 5 个键 —— 混进 `cabinet` 就说明"候选里长出了 Cabinet" */
const placementClean = (p: object): boolean => Object.keys(p).every((k) => PLACEMENT_KEYS.has(k));
/** 候选坐标必须**等于 Resolver 的输出**（唯一坐标出口） */
const resolvedMatchesResolver = (p: CandidatePlacement, project: Project): boolean => {
  const r = resolvePlacement(p.intent, sceneFromProject(project));
  return r.ok && JSON.stringify(r.placement) === JSON.stringify(p.resolved);
};
/** 导出面里不许出现任何"让候选生效"的名字 */
const FORBIDDEN_EXPORT = /^(adopt|apply|commit|persist|write|execute|save|sync)/i;
const hasForbiddenExportName = (names: string[]): boolean => names.some((n) => FORBIDDEN_EXPORT.test(n));

/** 把某只柜按候选落位摆到**副本**上，再跑真实校验（与 CommandBus 同一来源） */
function collisionIssuesFor(project: Project, p: CandidatePlacement) {
  const clone: Project = {
    ...project,
    cabinets: project.cabinets.map((c) => (c.id === p.targetId ? { ...c, placement: { ...p.resolved } } : c)),
  };
  return detectCollisions(clone).filter((i) => i.target.split(' / ').includes(p.targetId));
}

function allPlacements(set: { candidates: CandidateLayout[] }): CandidatePlacement[] {
  return set.candidates.flatMap((c) => c.placements);
}

// ═══════════════════════ §1 候选的"形状"：不是 Cabinet / Project / File schema ═══════════════════════
section('§1 候选的形状：引用而非拷贝，长不出 Cabinet');
{
  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  ok('1. 生成结果的状态是 draft（类型层也只有 draft）', set.status === 'draft' && set.candidates.every((c) => c.status === 'draft'), set.status);
  ok('2. 至少产出了候选（否则后面全是假绿）', set.candidates.length >= 1, set.candidates.length);

  const ps = allPlacements(set);
  ok('3. ★ 候选落位只有 {targetId, intent, resolved, issues, satisfies} 五个键', ps.length > 0 && ps.every(placementClean), ps.map((p) => Object.keys(p)));

  const withCab = ps.find((p) => 'cabinet' in (p as Record<string, unknown>));
  ok('4. ★ 候选落位里**没有** `cabinet` 字段（候选不是 Cabinet）', withCab === undefined, withCab);

  const badField = ps.find((p) => JSON.stringify(p).includes('"params"') || JSON.stringify(p).includes('"layout"'));
  ok('5. 候选落位里**没有** Cabinet 的 params / layout（引用而非拷贝）', badField === undefined, badField);

  ok(
    '6. CandidateLayout 的键恰好是 {id,status,sourceIntent,placements,explanations,unresolved}',
    set.candidates.every(
      (c) => JSON.stringify(Object.keys(c).sort()) === JSON.stringify(['explanations', 'id', 'placements', 'sourceIntent', 'status', 'unresolved'])
    ),
    set.candidates.map((c) => Object.keys(c))
  );

  ok(
    '7. 落位的 targetId 是**引用**：都能在 project.cabinets 里找到',
    ps.every((p) => project.cabinets.some((c) => c.id === p.targetId)),
    ps.map((p) => p.targetId)
  );
  ok(
    '8. 候选不新增也不复制柜体：project.cabinets 长度不变',
    project.cabinets.length === 2
  );
  ok(
    '9. model 的 CANDIDATE_REQUEST_KEYS 与 AI 契约逐字一致（防漂移）',
    JSON.stringify([...MODEL_CANDIDATE_KEYS]) === JSON.stringify([...CONTRACT_CANDIDATE_KEYS]),
    { model: [...MODEL_CANDIDATE_KEYS], contract: [...CONTRACT_CANDIDATE_KEYS] }
  );
}

// ═══════════════════════ §2 候选不污染 Model / 不进入 project.json / 不进入 schemaVersion ═══════════════════════
section('§2 候选不污染模型、不进 project.json、不升 schemaVersion');
{
  const project = projWithIntents([wallIntent('c1')]);
  const beforeJson = JSON.stringify(project);
  const beforeFile = serializeProjectFile(project, FIXED_SAVED_AT);
  const svBefore = project.schemaVersion;

  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });

  ok('10. ★ 生成不修改入参：project 逐字节不变', JSON.stringify(project) === beforeJson, { before: beforeJson.length, after: JSON.stringify(project).length });
  ok('11. ★ project.json 逐字节不变（候选不进文件）', serializeProjectFile(project, FIXED_SAVED_AT) === beforeFile);
  ok('12. schemaVersion 不变（候选不着版本号）', project.schemaVersion === svBefore && project.schemaVersion === '0.2', project.schemaVersion);
  ok('13. project 顶层没有 candidates / candidateLayouts 这类键', !('candidates' in project) && !('candidateLayouts' in project) && !('candidate' in project), Object.keys(project));

  const ids = set.candidates.map((c) => c.id);
  const file = serializeProjectFile(project, FIXED_SAVED_AT);
  ok('14. 序列化结果里不出现任何候选 id（cl_xxx）', ids.length > 0 && ids.every((id) => !file.includes(id)), ids);
  ok('15. 序列化结果里不出现 "candidate" 字样', !/candidate/i.test(file));

  // 二次运行必须给出逐字节相同的结果（确定性 / 纯函数）
  const again = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  ok('16. 同一输入两次生成，结果逐字节相同（确定性，无随机/无时钟）', JSON.stringify(again) === JSON.stringify(set));

  // 解析侧：候选根本不是文件格式的一部分
  const rt = parseProjectFile(beforeFile);
  ok('17. 存盘再解析，模型里仍然没有任何候选概念', rt.ok === true && !('candidates' in (rt.ok ? rt.project : {})) && (rt.ok ? rt.project.cabinets.length : -1) === 2);
}

// ═══════════════════════ §3 候选必须过 Resolver（唯一坐标出口） ═══════════════════════
section('§3 候选落位必须经 resolvePlacement（不能旁路写 x/y）');
{
  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  const ps = allPlacements(set);

  ok(
    '18. ★ 每条候选的 resolved 都等于 resolvePlacement(intent, scene) 的输出（坐标只能来自 Resolver）',
    ps.length > 0 && ps.every((p) => resolvedMatchesResolver(p, project)),
    ps.map((p) => ({ resolved: p.resolved, byResolver: resolvePlacement(p.intent, sceneFromProject(project)) }))
  );
  ok(
    '19. 每条候选都携带语义意图（intent 的 relation=absolute、origin=authored、targetId 指向该柜）',
    ps.every(
      (p) =>
        p.intent.relation === 'absolute' &&
        p.intent.origin === 'authored' &&
        p.intent.targetId === p.targetId
    ),
    ps.map((p) => p.intent)
  );
  ok('20. resolved 三个分量都是整数（Resolver 取整，浮点不进候选）', ps.every((p) => [p.resolved.x, p.resolved.y, p.resolved.rotation].every(Number.isInteger)));

  const genSrc = readFileSync(join(SRC_DIR, 'generate.ts'), 'utf8');
  ok('21. ★ generate.ts 源码里**真的存在** resolvePlacement 调用（不是靠巧合）', /resolvePlacement\s*\(/.test(genSrc) && /sceneFromProject\s*\(/.test(genSrc));

  // 写保证：候选层不 import 命令总线 / AI / 导出 / 制造（没有写路径）
  const DENY = ['commandBus', '/ai/', 'export/', 'manufacturing'];
  const files = ['model.ts', 'generate.ts', 'index.ts'];
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(SRC_DIR, f), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');
    for (const m of code.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1]!;
      if (DENY.some((t) => spec.includes(t))) offenders.push(`${f}: ${spec}`);
    }
  }
  ok('22. ★ 候选层不 import commandBus / ai / export / manufacturing（候选没有写路径）', offenders.length === 0, offenders);
}

// ═══════════════════════ §4 候选的校验与真实校验同一份 ═══════════════════════
section('§4 候选校验与真实校验同一份（detectCollisions）');
{
  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  const ps = allPlacements(set);

  ok(
    '23. ★ 候选里记的 issues 与"把柜摆过去再跑 detectCollisions"逐字节相同',
    ps.length > 0 && ps.every((p) => JSON.stringify(p.issues) === JSON.stringify(collisionIssuesFor(project, p))),
    ps.map((p) => ({ inCandidate: p.issues, recomputed: collisionIssuesFor(project, p) }))
  );
  ok(
    '24. 候选只挑"放得下"的落点：所有候选 issues 均为空（撞墙/撞柜的落点被筛掉）',
    ps.length > 0 && ps.every((p) => p.issues.length === 0),
    ps.map((p) => p.issues)
  );
  ok(
    '25. satisfies 的条数等于 sourceIntent 的条数，且 goal 与意图一致',
    set.candidates.every((c) => c.placements.every((p) => p.satisfies.length === c.sourceIntent.length)) &&
      set.candidates.every((c) => c.placements.every((p) => p.satisfies.every((s) => s.goal === 'wall-contact'))),
    set.candidates.map((c) => c.placements.map((p) => p.satisfies))
  );
}

// ═══════════════════════ §5 多候选独立存在 ═══════════════════════
section('§5 多候选独立存在、互不相同（A/B/C 三档）');
{
  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project', maxCandidates: 3 });
  ok('26. 一个 wall-contact 意图产出 ≥2 个候选', set.candidates.length >= 2, set.candidates.length);

  const ids = set.candidates.map((c) => c.id);
  ok('27. 候选 id 互不相同', new Set(ids).size === ids.length, ids);

  const keys = set.candidates.map((c) => JSON.stringify(c.placements[0]!.resolved));
  ok('28. 候选落位互不相同（不是同一处摆法的重复）', new Set(keys).size === keys.length, keys);

  ok(
    '29. 每条候选都可独立校验通过（issues 均为空）',
    set.candidates.every((c) => c.placements.every((p) => p.issues.length === 0))
  );

  const text = set.candidates.map((c) => c.explanations.join(' ')).join(' | ');
  ok(
    '30. 三档策略都出现（保持朝向 / 换个朝向 / 满足目标）',
    text.includes('保持朝向') && text.includes('换个朝向') && text.includes('满足目标'),
    text
  );

  const capped = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project', maxCandidates: 1 });
  ok('31. maxCandidates 生效（请求 1 个就只给 1 个）', capped.candidates.length === 1, capped.candidates.length);
  const overCap = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project', maxCandidates: 99 });
  ok('32. maxCandidates 被夹到上限（不给无限个候选）', overCap.candidates.length <= MAX_CANDIDATES_PER_TARGET, overCap.candidates.length);

  // standalone 也是可构造目标
  const proj2 = projWithIntents([standaloneIntent('c1')]);
  const set2 = generateCandidateLayouts(proj2, { intentIds: ['di_002'], scope: 'project' });
  ok('33. standalone 意图同样能产出候选（第二个构造目标）', set2.candidates.length >= 1, set2.candidates.length);
}

// ═══════════════════════ §6 没有 adopt：候选不会自己生效 ═══════════════════════
section('§6 adopt 未实现、不可调用');
{
  const names = Object.keys(candidateMod);
  ok('34. ★ 候选层导出面里没有任何 adopt / apply / commit / persist 名字', !hasForbiddenExportName(names), names);
  ok('35. 显式：adoptCandidate / applyCandidate / commitCandidate 都不是函数', ['adoptCandidate', 'applyCandidate', 'commitCandidate'].every((n) => typeof (candidateMod as Record<string, unknown>)[n] === 'undefined'));

  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  ok('36. 候选对象上没有 adopt/apply/commit 方法（数据不是命令）', set.candidates.every((c) => !hasForbiddenExportName(Object.keys(c))));
  const idxSrc = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8');
  const genSrc = readFileSync(join(SRC_DIR, 'generate.ts'), 'utf8');
  ok('37. 源码里没有 export 任何 adopt/apply/commit 函数', !/export\s+(async\s+)?function\s+(adopt|apply|commit|persist)/i.test(idxSrc + genSrc));
}

// ═══════════════════════ §7 AI 契约：候选请求无几何，动作清单不增 ═══════════════════════
section('§7 AI 契约：候选请求无几何、动作清单仍 21 条');
{
  ok('38. 动作清单仍是 21 条（候选请求不是动作）', ACTION_NAMES.length === 21, ACTION_NAMES.length);
  ok('39. 动作清单里没有任何 candidate / geometry 相关名字', !ACTION_NAMES.some((n: string) => /candidate|geometry|coord/i.test(n)), ACTION_NAMES.filter((n: string) => /candidate|geometry|coord/i.test(n)));

  const good = validateCandidateRequest({ intentIds: ['di_001'], cabinetIds: ['c1'], scope: 'room', maxCandidates: 3 });
  ok('40. 合法候选请求被接受并归一化', good.ok === true && good.request.scope === 'room' && good.request.maxCandidates === 3, good);

  const withX = validateCandidateRequest({ intentIds: ['di_001'], scope: 'project', x: 100 });
  ok('41. ★ 候选请求带 x → 拒收，且原因是 GEOMETRY_FORBIDDEN（不是别的检查顶替）', withX.ok === false && withX.code === 'GEOMETRY_FORBIDDEN', withX);
  const withRot = validateCandidateRequest({ scope: 'project', rotation: 90 });
  ok('42. ★ 候选请求带 rotation → 拒收（无几何输出）', withRot.ok === false && withRot.code === 'GEOMETRY_FORBIDDEN', withRot);
  const withPlacements = validateCandidateRequest({ scope: 'project', placements: [] });
  ok('43. ★ 候选请求带 placements → 拒收（无几何输出）', withPlacements.ok === false && withPlacements.code === 'GEOMETRY_FORBIDDEN', withPlacements);

  const extra = validateCandidateRequest({ scope: 'project', foo: 1 });
  ok('44. 候选请求带未知键 → EXTRA_KEY 整条拒收（白名单，不静默忽略）', extra.ok === false && extra.code === 'EXTRA_KEY', extra);
  const noScope = validateCandidateRequest({ intentIds: ['di_001'] });
  ok('45. 缺 scope → 归一为 project', noScope.ok === true && noScope.request.scope === 'project', noScope);
  const badScope = validateCandidateRequest({ scope: 'wall' });
  ok('46. 非法 scope → BAD_SCOPE', badScope.ok === false && badScope.code === 'BAD_SCOPE', badScope);
  const badMax = validateCandidateRequest({ scope: 'project', maxCandidates: 0 });
  ok('47. maxCandidates 非正整数 → BAD_MAX', badMax.ok === false && badMax.code === 'BAD_MAX', badMax);
  const notObj = validateCandidateRequest('oops');
  ok('48. 非对象 → NOT_OBJECT', notObj.ok === false && notObj.code === 'NOT_OBJECT', notObj);

  const snap = { spatialContext: {}, designIntent: { readOnly: true, count: 0, intents: [] } };
  const msg = buildUserMessage('帮我看几个摆法', snap, []);
  ok('49. 提示词里出现 candidateRequest 的说明', msg.includes('candidateRequest'), msg.includes('candidateRequest'));
  ok('50. ★ 提示词明说候选请求"只给 id、不要给坐标"（不给模型猜几何的机会）', msg.includes('不要给') && /x\s*\/\s*y\s*\/\s*rotation/.test(msg), msg.slice(msg.indexOf('candidateRequest'), msg.indexOf('candidateRequest') + 220));
  ok('51. 提示词明说候选"不会被自动采用"（本阶段没有 adopt）', msg.includes('不会被自动采用'));
  ok('52. 不回归：P9.2 的 designIntent 两句仍在提示词里', msg.includes('designIntent') && msg.includes('不能新增或修改设计意图') && msg.includes('写了也不会生效'));
}

// ═══════════════════════ §8 rejected / unknown / 非构造目标不产生候选 ═══════════════════════
section('§8 未生效意图不产生候选');
{
  // rejected：意图存在但被否掉 → activeDesignIntents 里没有它
  const rejected = rejectIntent([wallIntent('c1')], 'di_001')[0]!;
  const project = projWithIntents([rejected]);
  ok('53. rejected 意图不在 active 集合里', activeDesignIntents(project).length === 0, activeDesignIntents(project).map((i) => i.id));

  const noReq = generateCandidateLayouts(project);
  ok('54. ★ 不传 intentIds 时，rejected 意图不产生任何候选', noReq.candidates.length === 0, noReq.candidates.map((c) => c.sourceIntent));

  const withReq = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  ok('55. ★ 显式点名一个 rejected 意图 → 仍不产生候选', withReq.candidates.length === 0, withReq.candidates);
  ok('56. 并且如实说明原因（不是静默丢弃）', withReq.unresolved.some((u) => u.intentId === 'di_001' && /不在生效集合/.test(u.reason)), withReq.unresolved);

  // unknown：根本不存在的 id
  const proj2 = projWithIntents([wallIntent('c1')]);
  const unknown = generateCandidateLayouts(proj2, { intentIds: ['di_999'], scope: 'project' });
  ok('57. ★ 不存在的意图 id → 不产生候选', unknown.candidates.length === 0, unknown.candidates);
  ok('58. 且如实说明原因', unknown.unresolved.some((u) => u.intentId === 'di_999' && /不在生效集合/.test(u.reason)), unknown.unresolved);

  // 未确认（candidate 状态）也不产生候选 —— 只有 active 算数
  const cand = { ...wallIntent('c1'), status: 'candidate' as const };
  const proj3 = projWithIntents([cand]);
  const st = generateCandidateLayouts(proj3, { intentIds: ['di_001'], scope: 'project' });
  ok('59. ★ 未确认（candidate）的意图不产生候选', st.candidates.length === 0 && st.unresolved.some((u) => u.intentId === 'di_001'), { cands: st.candidates.length, un: st.unresolved });

  // 非构造目标：priority 类不产候选，且如实说明
  const proj4 = projWithIntents([priorityIntent()]);
  const pri = generateCandidateLayouts(proj4, { intentIds: ['di_003'], scope: 'project' });
  ok('60. ★ 取舍方向类目标（storage-priority）不产生候选', pri.candidates.length === 0, pri.candidates);
  ok('61. 且如实说明"本阶段不产生候选"', pri.unresolved.some((u) => u.intentId === 'di_003' && /不产生候选/.test(u.reason)), pri.unresolved);

  // 混合：一个 active 构造目标 + 一个 rejected → 只对前者产候选
  const mixed = projWithIntents([wallIntent('c1', 'di_010'), rejectIntent([standaloneIntent('c1', 'di_011')], 'di_011')[0]!]);
  const ms = generateCandidateLayouts(mixed);
  ok('62. ★ 混合场景：只对 active 的构造目标产候选，被否掉的那条一条也不产', ms.candidates.length >= 1 && ms.candidates.every((c) => c.sourceIntent.includes('di_010') && !c.sourceIntent.includes('di_011')), ms.candidates.map((c) => c.sourceIntent));
}

// ═══════════════════════ §9 变异哨兵（常驻判据 + 自检必须能红） ═══════════════════════
section('§9 变异哨兵：三条判据必须能真的变红');
{
  const project = projWithIntents([wallIntent('c1')]);
  const set = generateCandidateLayouts(project, { intentIds: ['di_001'], scope: 'project' });
  const real = set.candidates[0]!.placements[0]!;

  // 哨兵 A：candidate 写入 Cabinet
  const goodClean = placementClean(real);
  const poisoned = { ...real, cabinet: { id: 'x', params: {}, layout: {} } } as unknown as CandidatePlacement;
  const sentinelA = !placementClean(poisoned);
  ok('63. ★ 哨兵A：真实候选通过"无 cabinet"检查', goodClean, Object.keys(real));
  ok('64. ★ 哨兵A 自检：往候选里塞一个 cabinet 后，判据必须变红（哨兵不是空的）', sentinelA);

  // 哨兵 B：candidate 生成 x/y 绕过 resolver
  const goodResolved = resolvedMatchesResolver(real, project);
  const faked = { ...real, resolved: { ...real.resolved, x: real.resolved.x + 7 } } as CandidatePlacement;
  const sentinelB = !resolvedMatchesResolver(faked, project);
  ok('65. ★ 哨兵B：真实候选的 resolved 等于 Resolver 输出', goodResolved);
  ok('66. ★ 哨兵B 自检：手改 x 之后（= 绕过 resolver），判据必须变红', sentinelB, { real: real.resolved, faked: faked.resolved });

  // 哨兵 C：candidate 自动 adopt
  const goodExports = !hasForbiddenExportName(Object.keys(candidateMod));
  const sentinelC = hasForbiddenExportName(['adoptCandidate', 'generateCandidateLayouts']);
  ok('67. ★ 哨兵C：真实导出面没有 adopt 类名字', goodExports, Object.keys(candidateMod));
  ok('68. ★ 哨兵C 自检：导出面里一旦出现 adoptCandidate，判据必须变红', sentinelC);
}

// ═══════════════════════ §10 接线：脚本必须进 verify:all ═══════════════════════
section('§10 接线');
{
  const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  ok(
    '69. ★ 已接进 verify:all（脚本没接进链路等于不存在）',
    typeof pkg.scripts['verify:candidate-layout'] === 'string' && /verify:candidate-layout/.test(pkg.scripts['verify:all'] ?? ''),
    { hasScript: typeof pkg.scripts['verify:candidate-layout'], inAll: /verify:candidate-layout/.test(pkg.scripts['verify:all'] ?? '') }
  );
}

console.log(`\n═══ P9.3 Candidate Layout Foundation 验收：通过 ${passed} / 失败 ${failed} ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
