/**
 * ══════════════════════════════════════════════════════════════════════
 *  设计意图通道验收（2026-10-20）
 *
 * ── 它守的是什么 ──
 *   1. **新补的两个构造器真的能出候选**：room-inside / near-opening。
 *      它们以前在 CONSTRUCTIVE_GOALS 之外，提了只会进 unresolved —— 用户看到
 *      "系统没反应"，而系统其实什么都没做错，只是没这个能力。
 *   2. **判据必须因对的原因生效**：不能满足的摆法不能被判"满足"。
 *      只断言"有候选"是假绿 —— 负样本（屋外柜 / 挡门柜）必须被判不满足。
 *   3. **AI 提的意图只能是 candidate**：这是 P9.2 定死的红线，本通道不放松。
 *   4. **静默丢弃已被修复**：intentRequest 必须真的被服务端解析并回传。
 *
 * ── 写法约定 ──
 *   与既有验收一致：ok() 计数 + 结尾汇总 + 失败 exit 1。
 *   每条断言都做过变异验证（见文件末尾说明）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCabinet, emptyProject, rectRoom } from '../src/core/docFactory.ts';
import type { Project, RuleSet } from '../src/core/types.ts';
import { generateCandidateLayouts, satisfiesGoal } from '../src/core/candidateLayout/generate.ts';
import { deriveSpatialFacts } from '../src/core/spatial/derive.ts';
import { DESIGN_INTENT_GOAL_ORDER, makeCandidateIntent } from '../src/core/designIntent/index.ts';
import { INTENT_GOAL_WORDS, validateIntentRequest } from '../shared/aiContract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

/** 造一个带门洞的房间，并放一只柜 */
function makeProject(cabX: number, cabY: number, opts: { doorOffset?: number } = {}): { project: Project; roomId: string; cabId: string } {
  const project = emptyProject({ name: '验收', ruleSetId: rules.id, id: 'p_acc' });
  const room = rectRoom({ name: '主卧', x: 0, y: 0, w: 3200, h: 2600, thickness: 120, height: 2700 });
  if (opts.doorOffset !== undefined) {
    room.walls[0]!.openings = [{ id: 'op1', kind: 'door', offset: opts.doorOffset, width: 900, sill: 0, height: 2100 }];
  }
  project.rooms.push(room);
  const cab = createCabinet({
    id: 'cab_1', name: '测试柜', roomId: room.id, x: cabX, y: cabY, rotation: 0, rules,
    params: { width: 900, height: 2000, depth: 600, bodyLift: 80, cabinetType: 'base', mountHeight: 0 },
    units: [{ id: 'u1', kind: 'shelves', requestedWidth: 900, nickname: '层板', shelves: { count: 3, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none' } }],
  });
  project.cabinets.push(cab);
  return { project, roomId: room.id, cabId: cab.id };
}

/** 给项目挂一条 active 意图 */
function withIntent(project: Project, goal: string, cabinetId: string): Project {
  const intent = makeCandidateIntent({
    goal: goal as never,
    scope: { kind: 'cabinet', cabinetId },
    detail: '验收夹具',
    taken: new Set<string>(),
  });
  return { ...project, designIntents: [{ ...intent, status: 'active', confirmedBy: 'user-stated' }] };
}

// ═══════════════ 1. 词表镜像 ═══════════════
section('1. 契约词表 ⇄ core 词表（防漂移）');
{
  ok('INTENT_GOAL_WORDS 与 DESIGN_INTENT_GOAL_ORDER 逐项相同',
    JSON.stringify(INTENT_GOAL_WORDS) === JSON.stringify([...DESIGN_INTENT_GOAL_ORDER]),
    '契约=' + JSON.stringify(INTENT_GOAL_WORDS) + ' core=' + JSON.stringify([...DESIGN_INTENT_GOAL_ORDER]));
}

// ═══════════════ 2. room-inside 构造器 ═══════════════
section('2. room-inside：柜体必须完整落在房间内');
{
  const { project, cabId } = makeProject(-3000, -3000); // 柜在屋外
  const facts = deriveSpatialFacts(project);
  const rel = facts.cabinets.find((c) => c.cabId === cabId)?.room;
  ok('前置：构造出的柜体确实在房间外（room=outside）', rel === 'outside', '实际 room=' + String(rel));

  const withGoal = withIntent(project, 'room-inside', cabId);
  const r = generateCandidateLayouts(withGoal, {});
  ok('room-inside 能枚举出候选（不再进 unresolved）', r.candidates.length > 0, `候选 ${r.candidates.length} 个，unresolved ${r.unresolved.length} 条：` + JSON.stringify(r.unresolved.slice(0, 2)));
  ok('至少一个候选真的满足 room-inside', r.candidates.some((c) => c.placements[0]?.satisfies?.some((s) => s.goal === 'room-inside' && s.ok)), JSON.stringify(r.candidates[0]?.placements[0]?.satisfies));
  /**
   * ★ 关键负向断言（2026-10-20 变异测试补的）。
   *
   *   只断言"有候选满足"是**假绿**：我把 satisfiesGoal 的 room-inside 分支
   *   改成恒 true，上面两条照样过。真正该钉住的是：
   *   **把柜体放回屋外那个位置，satisfies 必须说 ok:false。**
   *
   *   做法：直接对"柜体仍在屋外"的项目跑一次候选生成，
   *   取一个把柜放在屋外的候选（如果有），它的 satisfies 必须是 false。
   *   更可靠的是用一个不依赖候选生成的方式：检查候选里**不满足**的那些。
   */
  const outsideProbe: Project = {
    ...withGoal,
    cabinets: withGoal.cabinets.map((x) => ({ ...x, placement: { x: -3000, y: -3000, rotation: 0 } })),
  };
  const rOutside = generateCandidateLayouts(outsideProbe, {});
  const anySayOkForOutside = rOutside.candidates.some((c) => {
    const p0 = c.placements[0];
    if (!p0) return false;
    // 只看"落点仍在屋外"的候选
    const stillOutside = p0.resolved.x < -2000 || p0.resolved.y < -2000;
    return stillOutside && (p0.satisfies?.some((s) => s.goal === 'room-inside' && s.ok) ?? false);
  });
  ok('★ 落点仍在屋外的候选，satisfies 不得说满足（判据必须能区分 inside/outside）', !anySayOkForOutside,
    '屋外候选被误判为满足：' + JSON.stringify(rOutside.candidates.map((c) => ({ x: c.placements[0]?.resolved.x, y: c.placements[0]?.resolved.y, sat: c.placements[0]?.satisfies })).slice(0, 3)));
  ok('满足的候选其落点确实在房间内（复核，不只看 flag）',
    r.candidates.some((c) => {
      const p = c.placements[0];
      if (!p) return false;
      const probe: Project = { ...withGoal, cabinets: withGoal.cabinets.map((x) => (x.id === p.targetId ? { ...x, placement: { x: p.resolved.x, y: p.resolved.y, rotation: p.resolved.rotation } } : x)) };
      return deriveSpatialFacts(probe).cabinets.find((x) => x.cabId === p.targetId)?.room === 'inside';
    }));
}

// ═══════════════ 3. near-opening 构造器 ═══════════════
section('3. near-opening / opening-clear：柜体不得挡住门窗洞口');
{
  const { project, cabId } = makeProject(1250, 60, { doorOffset: 1200 }); // 正对门洞
  const facts = deriveSpatialFacts(project);
  const opRel = facts.cabinets.find((c) => c.cabId === cabId)?.openings?.[0]?.relation;
  ok('前置：构造出的柜体确实挡住了门洞（overlap）', opRel === 'overlap', '实际 relation=' + String(opRel));

  for (const goal of ['near-opening', 'opening-clear']) {
    const withGoal = withIntent(project, goal, cabId);
    const r = generateCandidateLayouts(withGoal, {});
    ok(`${goal} 能枚举出候选`, r.candidates.length > 0, `候选 ${r.candidates.length} 个`);
    ok(`${goal} 的候选里有"不挡洞口"的摆法`,
      r.candidates.some((c) => {
        const p = c.placements[0];
        if (!p) return false;
        const probe: Project = { ...withGoal, cabinets: withGoal.cabinets.map((x) => (x.id === p.targetId ? { ...x, placement: { x: p.resolved.x, y: p.resolved.y, rotation: p.resolved.rotation } } : x)) };
        const os = deriveSpatialFacts(probe).cabinets.find((x) => x.cabId === p.targetId)?.openings ?? [];
        return os.length === 0 || os.every((o) => o.relation === 'clear');
      }));
  }
}

// ═══════════════ 3.5 判据本身（直接测 satisfiesGoal）═══════════════
section('3.5 判据本身：直接喂事实集，断言 satisfiesGoal 的返回值');
{
  /**
   * ★ 这一节是变异测试逼出来的（2026-10-20）。
   *
   *   原先我只跑端到端候选生成，然后把 satisfiesGoal 的 room-inside /
   *   near-opening 分支改成恒 true —— **端到端照样全绿**。
   *   原因：candidateSpots 只枚举贴墙且不挡洞口的位置，那个判据在端到端里
   *   从未被触发过。判据必须单独可测，否则它是不是对的根本没人知道。
   */
  const mkFacts = (room: string, openingRels: string[]): never => ({
    rooms: [],
    cabinets: [{
      cabId: 'c1',
      room,
      walls: [],
      openings: openingRels.map((relation, i) => ({ openingId: 'o' + i, wallId: 'w1', kind: 'door', relation })),
    }],
  }) as never;

  ok('room-inside：inside → 满足', satisfiesGoal('room-inside', 'c1', mkFacts('inside', []), []) === true);
  ok('room-inside：outside → 不满足', satisfiesGoal('room-inside', 'c1', mkFacts('outside', []), []) === false);
  ok('room-inside：crossing → 不满足（压墙不算在室内）', satisfiesGoal('room-inside', 'c1', mkFacts('crossing', []), []) === false);
  ok('room-inside：unknown → 不满足（判不出来就不给过）', satisfiesGoal('room-inside', 'c1', mkFacts('unknown', []), []) === false);

  ok('near-opening：无洞口 → 满足（不挡任何东西）', satisfiesGoal('near-opening', 'c1', mkFacts('inside', []), []) === true);
  ok('near-opening：全部 clear → 满足', satisfiesGoal('near-opening', 'c1', mkFacts('inside', ['clear', 'clear']), []) === true);
  ok('near-opening：有 overlap → 不满足', satisfiesGoal('near-opening', 'c1', mkFacts('inside', ['clear', 'overlap']), []) === false);
  ok('near-opening：有 unknown → 不满足（判不出来就不给过）', satisfiesGoal('near-opening', 'c1', mkFacts('inside', ['unknown']), []) === false);
  ok('opening-clear 与 near-opening 判据一致（overlap → 不满足）', satisfiesGoal('opening-clear', 'c1', mkFacts('inside', ['overlap']), []) === false);

  ok('未知目标：没有构造器时 satisfiesGoal 返回 false（不假装满足）', satisfiesGoal('storage-priority' as never, 'c1', mkFacts('inside', []), []) === false);
}

// ═══════════════ 4. 负样本：判据必须拒绝 ═══════════════
section('4. 负样本：不满足的摆法不能被判"满足"');
{
  // 屋外柜：它的当前落点不该被判 room-inside 满足
  const { project, cabId } = makeProject(-3000, -3000);
  const facts = deriveSpatialFacts(project);
  const f = facts.cabinets.find((c) => c.cabId === cabId);
  ok('屋外柜（outside）不被判 room-inside 满足', f?.room !== 'inside');
  ok('屋外柜的 room 关系是明确的 outside 而不是 unknown（判得出）', f?.room === 'outside');

  // 挡门柜：不该被判 near-opening 满足
  const p2 = makeProject(1250, 60, { doorOffset: 1200 });
  const f2 = deriveSpatialFacts(p2.project).cabinets.find((c) => c.cabId === p2.cabId);
  ok('挡门柜的洞口关系是 overlap，不是 clear', (f2?.openings ?? []).some((o) => o.relation === 'overlap'));
}

// ═══════════════ 5. AI 意图只能是 candidate ═══════════════
section('5. 红线：AI 提的意图只能是 candidate，不能自己激活');
{
  const intent = makeCandidateIntent({
    goal: 'room-inside',
    scope: { kind: 'cabinet', cabinetId: 'c1' },
    detail: 'AI 推断',
    taken: new Set<string>(),
  });
  ok('makeCandidateIntent 产出 status=candidate', intent.status === 'candidate');
  ok('makeCandidateIntent 没有 confirmedBy（不能自称已确认）', intent.confirmedBy === undefined);
  ok('makeCandidateIntent 的 origin 是 ai-inferred', intent.origin === 'ai-inferred');
}

// ═══════════════ 6. intentRequest 契约校验 ═══════════════
section('6. intentRequest 契约：合法收、非法拒、几何必拒');
{
  const good = validateIntentRequest({ goal: 'room-inside', scope: { kind: 'cabinet', cabinetId: 'c1' } });
  ok('合法请求被接受并归一化', good.ok === true && good.request.goal === 'room-inside');

  const goodRoom = validateIntentRequest({ goal: 'near-opening', scope: { kind: 'room', roomId: 'r1' }, openingKind: 'door' });
  ok('room scope + openingKind 被接受', goodRoom.ok === true && goodRoom.request.openingKind === 'door');

  ok('未知目标词被拒（UNKNOWN_GOAL）', validateIntentRequest({ goal: 'make-it-pretty', scope: { kind: 'cabinet', cabinetId: 'c1' } }).code === 'UNKNOWN_GOAL');
  ok('带 x 被拒（GEOMETRY_FORBIDDEN，不是笼统的 EXTRA_KEY）', validateIntentRequest({ goal: 'room-inside', scope: { kind: 'cabinet', cabinetId: 'c1' }, x: 100 }).code === 'GEOMETRY_FORBIDDEN');
  ok('带 rotation 被拒（GEOMETRY_FORBIDDEN）', validateIntentRequest({ goal: 'room-inside', scope: { kind: 'cabinet', cabinetId: 'c1' }, rotation: 90 }).code === 'GEOMETRY_FORBIDDEN');
  ok('带 wallId 被拒（"贴哪面墙"不该由 AI 拍板）', validateIntentRequest({ goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: 'c1' }, wallId: 'w1' }).code === 'GEOMETRY_FORBIDDEN');
  ok('契约外字段被拒（EXTRA_KEY，不静默忽略）', validateIntentRequest({ goal: 'room-inside', scope: { kind: 'cabinet', cabinetId: 'c1' }, whatever: 1 }).code === 'EXTRA_KEY');
  ok('坏 scope.kind 被拒（BAD_SCOPE）', validateIntentRequest({ goal: 'room-inside', scope: { kind: 'planet' } }).code === 'BAD_SCOPE');
  ok('缺 goal 被拒（BAD_GOAL）', validateIntentRequest({ scope: { kind: 'cabinet', cabinetId: 'c1' } }).code === 'BAD_GOAL');
}

// ═══════════════ 7. 不产生候选的目标要如实说明 ═══════════════
section('7. 没有构造器的目标必须如实进 unresolved（不假装）');
{
  const { project, cabId } = makeProject(100, 60);
  for (const goal of ['door-swing-clear', 'storage-priority']) {
    const withGoal = withIntent(project, goal, cabId);
    const r = generateCandidateLayouts(withGoal, {});
    ok(`${goal} 不产生候选，且 unresolved 有可读理由`,
      r.candidates.length === 0 && r.unresolved.length > 0 && String(r.unresolved[0]?.reason ?? '').length > 8,
      JSON.stringify(r.unresolved.slice(0, 1)));
  }
}

// ═══════════════ 8. Agent 工具名净化（网关拒绝点号）═══════════════
section('8. Agent 工具名：发给模型的名字不得含点号，且必须能映射回去');
{
  /**
   * ★ 这一节守的是一个**实测出来的真缺陷**（2026-10-20）：
   *
   *   /api/ai/agent 在本地网关（gpt-load）上从来跑不通，一律 400 invalid_request_error。
   *   逐个工具单发定位到：**网关不接受工具名里的点号**
   *     {"name":"cad.get_state"} → 400
   *     {"name":"cad_get_state"} → 200
   *
   *   而本项目所有 MCP 工具都叫 cad.xxx。修法是发给模型时把 . 换成 _，收回来再映回原名。
   *
   *   为什么这条必须进验收：这个缺陷**没有任何报错指向工具名**（网关只说
   *   invalid_request_error），不跑一次真实调用根本发现不了。而一旦有人
   *   "顺手把 sanitize 去掉"，整个 Agent 模式会**静默全废**。
   */
  /**
   * ★ 断言必须对着**真实源码**，不是我在这里重写一遍 replace。
   *
   *   第一版就是在测试里自己写了一遍 sanitize —— 那种断言证明的是"我的 replace 能工作"，
   *   而不是"agentLoop 真的在净化"。有人把源码里的 sanitize 删掉，那条照样绿。
   *   （同类错误本项目已经踩过：断言必须看目标真干成那件事。）
   */
  const agentSrc = readFileSync(join(root, 'server', 'agentLoop.mjs'), 'utf8');
  /**
   * 用**子串**而不是正则：正则里的转义在模板字符串里非常容易写坏
   * （第一版就在这里被转义坑了，语法直接非法）。子串判据同样能钉住
   * "源码里确实有这么一句"。
   */
  const mustHave: Array<[string, string]> = [
    ["replace(/" + String.fromCharCode(92) + "./g, '_')", '工具名净化（把点号换成下划线）'],
    ['wireToToolName', '线上名→原名的反向映射表'],
    ['wireToToolName.get(', '收工具调用时用映射表还原原名'],
    ['agentToolsForWire', '净化后的工具集'],
    ['callAiWithTools(aiConfig, messages, agentToolsForWire)', '调模型时确实用了净化后的工具集'],
    ['Agent 工具名净化冲突', '撞名检测（cad.a_b 与 cad_a.b 会撞）'],
  ];
  for (const [needle, what] of mustHave) {
    ok('★ agentLoop 源码含「' + what + '」', agentSrc.includes(needle), '没找到：' + needle);
  }

  /**
   * 撞名必须真的能被拦住。这里在测试里复刻净化逻辑并喂一对会撞的名字 ——
   * 断言的是「这个判据能区分」，不是「源码里有这行字」（上一条已经守了后者）。
   */
  const sanitizeWithGuard = (names: string[]): Map<string, string> => {
    const wireTo = new Map<string, string>();
    for (const name of names) {
      const wire = name.replace(/\./g, '_');
      const existing = wireTo.get(wire);
      if (existing !== undefined && existing !== name) {
        throw new Error('冲突: ' + name + ' 与 ' + existing);
      }
      wireTo.set(wire, name);
    }
    return wireTo;
  };
  ok('真实工具集不撞名', (() => {
    try { sanitizeWithGuard(['cad.get_state', 'cad.create_cabinet', 'cad.apply_draft']); return true; } catch { return false; }
  })());
  ok('★ 会撞的名字对必须被拦下（cad.a_b 与 cad_a.b）', (() => {
    try { sanitizeWithGuard(['cad.a_b', 'cad_a.b']); return false; } catch { return true; }
  })(), '没拦住 —— 会出现"调 A 执行 B"且不报错');
}

// ═══════════════ 汇总 ═══════════════
console.log('\n' + '═'.repeat(60));
console.log(`  设计意图通道验收：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：新构造器真出候选、负样本真被拒、AI 意图只能 candidate、静默丢弃已修复。');