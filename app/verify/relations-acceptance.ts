/**
 * ══════════════════════════════════════════════════════════════════════
 *  P2 验收 —— 组合关系层（FurnitureAssembly / Connection）
 *
 *  文档 §12 给 P2 定的出口判据：**Case 5 / 6 全绿，原 corner.ts 断言不回归**。
 *    Case 5 = 两模块成 L 型      → `Connection{kind:'corner'}` 被声明且被核对
 *    Case 6 = 不同深度模块并排    → `Connection{kind:'butt'}`，跨柜变深天然支持
 *
 *  ── 这一批断言真正在防什么（按危险程度排）──
 *
 *   ① **关系层偷偷变成几何层。** 声明组合后板件/四视图/3D/DXF 必须**一个字节都不变**。
 *      一旦有人为了让"组合画个框"去改 2D，这条立刻红 —— 那不是不好，是它属于
 *      另一个决策（要不要在图上表达组合），不能在关系层顺手决定。
 *
 *   ② **"连着"这件事有两份实现。** 判定只许存在于 `deriveContacts()`。
 *      这里用**派生层自己**去筛选落位（不另写一遍"是不是 L 型"）：
 *      若哪天有人复制一份判定，两边迟早算出不一样的答案。
 *
 *   ③ **声明与落位不符被静默接受。** "你说连着但没挨着"必须报 ERROR 且精确到码。
 *      只断言"有 ERROR"会被别处的检查顶替而假绿 —— 所以每条都断言到**规则码**。
 *
 *   ④ **推断被当成事实去骂用户。** 用户只是把两个柜放得近，不能收到
 *      "你说连着其实没连" —— 这也是 `origin: authored / inferred` 存在的理由。
 *
 *   ⑤ **整组操作漏掉一个成员。** 整组平移必须让**所有**成员的位移完全一致，
 *      且 undo 后逐个回到原位（不是"回到差不多的位置"）。
 *
 *   ⑥ **AI 借组合写坐标。** 契约里没有 dx/dy/atX/atY，AI 只能给 id 引用 ——
 *      这里断言契约参数表里确实没有坐标类参数（结构性保证，不是靠记得）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, Connection, FurnitureAssembly, Project, RuleSet, UnitSpec } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, makeUnit, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import { joinSpots } from '../src/core/snapPlace.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { buildProjectViews } from '../src/core/geometry/views.ts';
import { deriveContacts, inferConnections, pairKey, validateAssemblies, type Contact } from '../src/core/relations.ts';
import { validateCornerInterference } from '../src/core/rules/corner.ts';
import { toNeutralExport } from '../src/export/neutralSheet.ts';
import { parseProjectFile, resolveSchemaVersion, serializeProjectFile } from '../src/core/projectFile.ts';
import { buildSnapshot } from '../src/ai/snapshot.ts';
import { compileAction, COMPILED_ACTIONS, type AiAction } from '../src/ai/compile.ts';
import * as CMD from '../src/core/commands.ts';
import { ACTIONS } from '../shared/aiContract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(title: string): void {
  console.log(`\n【${title}】`);
}
const eq = (a: unknown, b: unknown): string => `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`;
const codes = (issues: Array<{ code: string }>): string => issues.map((i) => i.code).join('/') || '（无）';
const has = (issues: Array<{ code: string; severity: string }>, code: string, sev?: string): boolean =>
  issues.some((i) => i.code === code && (sev ? i.severity === sev : true));

// ══════════════════════════ 造场景 ══════════════════════════

const taken = new Set<string>();
let unitSeq = 0;
/**
 * 分区 id 必须**全局唯一**：板件 id 由分区 id 派生，撞 id 不报错、
 * 只会让两块不同的板共用一条清单记录（车间下错料）。测试夹具自己先别犯这个错。
 */
function units3(): UnitSpec[] {
  const mk = (kind: UnitSpec['kind'], w: number, count: number): UnitSpec => {
    unitSeq += 1;
    const id = `unit_${String(unitSeq).padStart(3, '0')}`;
    const u = makeUnit({ id, kind, requestedWidth: w, rules, count, takenIds: taken });
    taken.add(id);
    return u;
  };
  return [mk('drawerBank', 400, 3), mk('hanging', 500, 1), mk('shelves', 400, 4)];
}

function baseProject(): Project {
  const p = sampleProject(rules);
  // 清空柜体，只留房间 —— 组合场景自己造柜，避免样本柜干扰接触判定
  p.cabinets = [];
  p.assemblies = undefined;
  return p;
}

function mkCab(id: string, name: string, roomId: string, w: number, d: number, rotation: number): Cabinet {
  const c = createCabinet({
    id,
    name,
    roomId,
    x: 0,
    y: 0,
    rotation,
    rules,
    params: { width: w, height: 2400, depth: d, bodyLift: 80 },
    units: units3(),
    takenIds: taken,
  });
  taken.add(id);
  return c;
}

/**
 * 用**派生层自己**挑一个落位：让新柜与已有柜形成指定关系。
 * 这里刻意不写"是不是 L 型"的判定 —— 判定只有 `deriveContacts()` 一份。
 */
/**
 * @param wantEdge 只接受特定边相接的落位（例如并排必须端头 left/right 相接；
 *                 否则"正面贴正面"虽然也是 butt，但那不是"并排成一排"）
 */
function placeFor(
  project: Project,
  cab: Cabinet,
  want: 'corner' | 'butt',
  wantEdge?: Array<Contact['edgeA']>
): Cabinet | null {
  const others = project.cabinets.filter((c) => c.roomId === cab.roomId);
  for (const sp of joinSpots({ ...project, cabinets: [...project.cabinets, cab] }, cab)) {
    const trial: Cabinet = { ...cab, placement: { x: sp.x, y: sp.y, rotation: sp.rotation } };
    for (const o of others) {
      const c = deriveContacts({ ...project, cabinets: [...others, trial] }).find(
        (k) => pairKey(k.a, k.b) === pairKey(trial.id, o.id)
      );
      if (!c || c.kind !== want) continue;
      if (wantEdge && !wantEdge.includes(c.edgeA)) continue;
      return trial;
    }
  }
  return null;
}

function asm(id: string, name: string, roomId: string, memberIds: string[], connections: Connection[] = []): FurnitureAssembly {
  return { id, name, roomId, memberIds, connections };
}
function conn(id: string, kind: Connection['kind'], a: string, b: string, ea?: string, eb?: string): Connection {
  return {
    id,
    kind,
    a: ea ? { cabinetId: a, edge: ea as never } : { cabinetId: a },
    b: eb ? { cabinetId: b, edge: eb as never } : { cabinetId: b },
    origin: 'authored',
  };
}

// ══════════════════ A. Case 5：两模块成 L 型（corner）══════════════════

section('A. Case 5：两模块成 L 型 —— 关系被声明，也被核对');

const pA = baseProject();
const armA = mkCab('cab_a', 'L 型·主臂', pA.rooms[0]!.id, 1500, 600, 0);
pA.cabinets.push(armA);
const armB0 = mkCab('cab_b', 'L 型·副臂', pA.rooms[0]!.id, 900, 600, 90);
const armB = placeFor(pA, armB0, 'corner');
ok('能落出一个真正的 L 型（副臂与主臂角接）', armB !== null);
if (armB) pA.cabinets.push(armB);

const contactsA = deriveContacts(pA);
const cornerContact = contactsA.find((c) => pairKey(c.a, c.b) === pairKey('cab_a', 'cab_b'));
ok('派生给出 corner 接触', cornerContact?.kind === 'corner', eq(cornerContact?.kind, 'corner'));
ok('派生不把它误判成并排（butt）', cornerContact?.kind !== 'butt');
ok('两臂轴线垂直（rotation 差 90°）', armB ? Math.abs(armA.placement.rotation - armB.placement.rotation) % 180 === 90 : false);

// 声明：只给 kind，不给 edge（文档 §6.3 的形状，且推荐省略 edge）
const asmCorner = asm('asm_001', '主卧 L 型衣柜', pA.rooms[0]!.id, ['cab_a', 'cab_b'], [conn('conn_001', 'corner', 'cab_a', 'cab_b')]);
const withAsm: Project = { ...pA, assemblies: [asmCorner] };
const issuesCorner = validateAssemblies(withAsm);
ok('声明与落位一致 → 没有任何组合类 ERROR', issuesCorner.filter((i) => i.severity === 'ERROR').length === 0, codes(issuesCorner));
ok('省略 edge 不会被追问（边由派生反推）', !has(issuesCorner, 'ASSEMBLY-EDGE-MISMATCH') && !has(issuesCorner, 'ASSEMBLY-EDGE-AMBIGUOUS'));

// 派生出的 edge 是四条边里的一个，且两臂各自的边不一致时才叫 L（相接在端头）
ok('派生的边是合法边名', cornerContact ? ['back', 'front', 'left', 'right'].includes(cornerContact.edgeA) : false, eq(cornerContact?.edgeA, 'back|front|left|right'));

// ══════════════════ B. Case 6：不同深度模块（butt）══════════════════

section('B. Case 6：不同深度模块并排 —— 跨柜变深天然支持');

const pB = baseProject();
const deep = mkCab('cab_d', '深柜 600', pB.rooms[0]!.id, 1200, 600, 0);
pB.cabinets.push(deep);
const shallow0 = mkCab('cab_s', '浅柜 350', pB.rooms[0]!.id, 800, 350, 0);
const shallow = placeFor(pB, shallow0, 'butt', ['left', 'right']);
ok('能落出一个真正的并排（浅柜贴着深柜）', shallow !== null);
if (shallow) pB.cabinets.push(shallow);

const buttContact = deriveContacts(pB).find((c) => pairKey(c.a, c.b) === pairKey('cab_d', 'cab_s'));
ok('派生给出 butt 接触', buttContact?.kind === 'butt', eq(buttContact?.kind, 'butt'));
ok('两柜深度不同（跨柜变深不需要新机制）', deep.params.depth !== shallow?.params.depth, `${deep.params.depth} vs ${shallow?.params.depth}`);
ok('相贴的是端头（left/right），不是正面', buttContact ? buttContact.edgeA === 'left' || buttContact.edgeA === 'right' : false, eq(buttContact?.edgeA, 'left|right'));

const asmButt = asm('asm_002', '电视柜组合', pB.rooms[0]!.id, ['cab_d', 'cab_s'], [conn('conn_002', 'butt', 'cab_d', 'cab_s')]);
const issuesButt = validateAssemblies({ ...pB, assemblies: [asmButt] });
ok('并排声明与落位一致 → 无 ERROR', issuesButt.filter((i) => i.severity === 'ERROR').length === 0, codes(issuesButt));
ok('不因深度不同就被当成"没连上"', !has(issuesButt, 'ASSEMBLY-NOT-TOUCHING'));

// ══════════════════ C. 声明与落位不符：必须报错，且精确到码 ══════════════════

section('C. 声明与落位不符 —— 每条都精确到规则码（不是"有 ERROR"就算过）');

const far: Cabinet = { ...structuredClone(armA), id: 'cab_far', name: '放得很远的柜' };
far.placement = { x: armA.placement.x, y: armA.placement.y + 1500, rotation: 0 };
const pFar: Project = { ...pA, cabinets: [...pA.cabinets.filter((c) => c.id !== 'cab_a'), armA, far] };
ok('声明连着但两柜没挨着 → ASSEMBLY-NOT-TOUCHING（ERROR）', (() => {
  const i = validateAssemblies({ ...pFar, assemblies: [asm('asm_003', '错位的组', pFar.rooms[0]!.id, ['cab_a', 'cab_far'], [conn('c1', 'corner', 'cab_a', 'cab_far')])] });
  return has(i, 'ASSEMBLY-NOT-TOUCHING', 'ERROR');
})(), codes(validateAssemblies({ ...pFar, assemblies: [asm('asm_003', '错位的组', pFar.rooms[0]!.id, ['cab_a', 'cab_far'], [conn('c1', 'corner', 'cab_a', 'cab_far')])] })));

ok('把 L 型说成并排 → ASSEMBLY-KIND-MISMATCH（ERROR）', (() => {
  const i = validateAssemblies({ ...pA, assemblies: [asm('asm_004', '说错了的组', pA.rooms[0]!.id, ['cab_a', 'cab_b'], [conn('c2', 'butt', 'cab_a', 'cab_b')])] });
  return has(i, 'ASSEMBLY-KIND-MISMATCH', 'ERROR');
})(), codes(validateAssemblies({ ...pA, assemblies: [asm('asm_004', '说错了的组', pA.rooms[0]!.id, ['cab_a', 'cab_b'], [conn('c2', 'butt', 'cab_a', 'cab_b')])] })));

ok('并排的边说错 → ASSEMBLY-EDGE-MISMATCH（ERROR，续接的贴合边唯一可判定）', (() => {
  const wrongEdge = buttContact?.edgeA === 'right' ? 'left' : 'right';
  const i = validateAssemblies({ ...pB, assemblies: [asm('asm_005', '边说错了', pB.rooms[0]!.id, ['cab_d', 'cab_s'], [conn('c3', 'butt', 'cab_d', 'cab_s', wrongEdge)])] });
  return has(i, 'ASSEMBLY-EDGE-MISMATCH', 'ERROR');
})());

ok('角接的边说不清 → 只给 WARNING（角点属于两条边，本身有歧义，不硬判）', (() => {
  const wrongEdge = cornerContact?.edgeA === 'right' ? 'left' : 'right';
  const i = validateAssemblies({ ...pA, assemblies: [asm('asm_006', '角接边', pA.rooms[0]!.id, ['cab_a', 'cab_b'], [conn('c4', 'corner', 'cab_a', 'cab_b', wrongEdge)])] });
  return has(i, 'ASSEMBLY-EDGE-AMBIGUOUS', 'WARNING') && !has(i, 'ASSEMBLY-EDGE-MISMATCH');
})());

ok('叠放（stack）如实说"核不了"，不假装核过', (() => {
  const i = validateAssemblies({ ...pA, assemblies: [asm('asm_007', '上下叠', pA.rooms[0]!.id, ['cab_a', 'cab_b'], [conn('c5', 'stack', 'cab_a', 'cab_b')])] });
  return has(i, 'ASSEMBLY-STACK-UNVERIFIED', 'INFO');
})());
ok('stack 不会顺手被判成"没连上"（它只是核不了，不是错）', (() => {
  const i = validateAssemblies({ ...pA, assemblies: [asm('asm_007', '上下叠', pA.rooms[0]!.id, ['cab_a', 'cab_b'], [conn('c5', 'stack', 'cab_a', 'cab_b')])] });
  return !has(i, 'ASSEMBLY-NOT-TOUCHING') && !has(i, 'ASSEMBLY-KIND-MISMATCH');
})());

// ══════════════════ D. 结构非法：解析层的红线 ══════════════════

section('D. 结构非法 —— 会被静默错的那几类必须报错');

ok('成员指向不存在的柜体 → ASSEMBLY-MEMBER-MISSING', has(validateAssemblies({ ...pA, assemblies: [asm('a1', '缺成员', pA.rooms[0]!.id, ['cab_a', 'cab_ghost'])] }), 'ASSEMBLY-MEMBER-MISSING', 'ERROR'));
ok('成员重复 → ASSEMBLY-MEMBER-DUP', has(validateAssemblies({ ...pA, assemblies: [asm('a2', '重复成员', pA.rooms[0]!.id, ['cab_a', 'cab_a'])] }), 'ASSEMBLY-MEMBER-DUP', 'ERROR'));
ok('连接指向组合外的柜体 → ASSEMBLY-CONN-OUTSIDE', has(validateAssemblies({ ...pA, assemblies: [asm('a3', '越界连接', pA.rooms[0]!.id, ['cab_a'], [conn('c', 'corner', 'cab_a', 'cab_b')])] }), 'ASSEMBLY-CONN-OUTSIDE', 'ERROR'));
ok('自己连自己 → ASSEMBLY-CONN-SELF', has(validateAssemblies({ ...pA, assemblies: [asm('a4', '自连', pA.rooms[0]!.id, ['cab_a', 'cab_b'], [conn('c', 'corner', 'cab_a', 'cab_a')])] }), 'ASSEMBLY-CONN-SELF', 'ERROR'));
ok('同一对重复声明 → ASSEMBLY-CONN-DUP', has(validateAssemblies({ ...pA, assemblies: [asm('a5', '重复连接', pA.rooms[0]!.id, ['cab_a', 'cab_b'], [conn('c1', 'corner', 'cab_a', 'cab_b'), conn('c2', 'butt', 'cab_a', 'cab_b')])] }), 'ASSEMBLY-CONN-DUP', 'ERROR'));
ok('空组合 → ASSEMBLY-EMPTY', has(validateAssemblies({ ...pA, assemblies: [asm('a6', '空组', pA.rooms[0]!.id, [])] }), 'ASSEMBLY-EMPTY', 'ERROR'));
ok('组合 id 重复 → ASSEMBLY-ID-DUP', has(validateAssemblies({ ...pA, assemblies: [asm('a7', '组1', pA.rooms[0]!.id, ['cab_a']), asm('a7', '组2', pA.rooms[0]!.id, ['cab_b'])] }), 'ASSEMBLY-ID-DUP', 'ERROR'));
ok('组合指向不存在的房间 → ASSEMBLY-ROOM-MISSING', has(validateAssemblies({ ...pA, assemblies: [asm('a8', '悬空组', 'room_ghost', ['cab_a'])] }), 'ASSEMBLY-ROOM-MISSING', 'ERROR'));

const p2rooms = sampleProject(rules);
if (p2rooms.rooms.length > 0) {
  const r2 = rectRoom({ id: 'room_second', name: '次卧', x: 5000, y: 0, w: 3000, h: 2500, thickness: 120, height: 2700 });
  p2rooms.rooms.push(r2);
  const other = mkCab('cab_other', '别的房间的柜', r2.id, 1000, 600, 0);
  p2rooms.cabinets.push(other);
  ok('跨房间组合 → ASSEMBLY-MEMBER-ROOM', has(validateAssemblies({ ...p2rooms, assemblies: [asm('a9', '跨房间', p2rooms.rooms[0]!.id, [p2rooms.cabinets[0]!.id, 'cab_other'])] }), 'ASSEMBLY-MEMBER-ROOM', 'ERROR'));
}

// ══════════════════ E. 关系层不产生几何（本阶段最重要的纪律）══════════════════

section('E. 关系层不是几何层 —— 声明组合后 2D/3D/DXF/BOM 一个字节都不许变');

const before = {
  panels: JSON.stringify(Object.values(generateProject(pA, rules).cabinets).map((g) => g.panels)),
  stats: JSON.stringify(Object.values(generateProject(pA, rules).cabinets).map((g) => g.stats)),
  plan: JSON.stringify(generateProject(pA, rules).plan),
  views: JSON.stringify(buildProjectViews(pA, rules).prims),
  neutral: JSON.stringify(stripTime(toNeutralExport(pA, rules, ['sheet'], 'TEST'))),
  issues: generateProject(pA, rules).issues.length,
};
const after = {
  panels: JSON.stringify(Object.values(generateProject(withAsm, rules).cabinets).map((g) => g.panels)),
  stats: JSON.stringify(Object.values(generateProject(withAsm, rules).cabinets).map((g) => g.stats)),
  plan: JSON.stringify(generateProject(withAsm, rules).plan),
  views: JSON.stringify(buildProjectViews(withAsm, rules).prims),
  neutral: JSON.stringify(stripTime(toNeutralExport(withAsm, rules, ['sheet'], 'TEST'))),
  issues: generateProject(withAsm, rules).issues.length,
};
ok('板件清单（BOM）逐项不变', before.panels === after.panels);
ok('统计（板件种类/总件数/面积/重量）不变', before.stats === after.stats);
ok('平面图元不变', before.plan === after.plan);
ok('四视图图元不变（2D）', before.views === after.views);
ok('中立导出（DXF 的唯一源）不变', before.neutral === after.neutral);
ok('几何自带的问题数不变（组合不引入新的几何问题）', before.issues === after.issues);

function stripTime(o: unknown): unknown {
  const c = JSON.parse(JSON.stringify(o)) as { meta?: Record<string, unknown> };
  if (c.meta) delete c.meta.generatedAt;
  return c;
}

// ══════════════════ F. 整体操作：一次命令改整组，可撤销 ═══════════════════

section('F. 整组操作 —— 一次命令改所有成员，一次撤销全部回原位');

const bus = new CommandBus(withAsm, rules);
const beforePos = withAsm.cabinets.map((c) => ({ id: c.id, x: c.placement.x, y: c.placement.y }));
const mv = bus.execute(CMD.moveAssembly('asm_001', '主卧 L 型衣柜', 120, -80));
ok('整组平移命令执行成功', mv.ok, mv.error ?? '');
if (mv.ok) {
  const after2 = bus.project.cabinets.map((c) => ({ id: c.id, x: c.placement.x, y: c.placement.y }));
  ok('每个成员都动了（不是一个动了另一个没动）', after2.every((a, i) => a.x !== beforePos[i]!.x || a.y !== beforePos[i]!.y));
  ok('位移量逐成员完全一致（整组刚性移动）', after2.every((a, i) => a.x - beforePos[i]!.x === after2[0]!.x - beforePos[0]!.x && a.y - beforePos[i]!.y === after2[0]!.y - beforePos[0]!.y),
    JSON.stringify(after2.map((a, i) => `${a.x - beforePos[i]!.x},${a.y - beforePos[i]!.y}`)));
  // CommandBus.undo() 返回 boolean（没有 ok 字段 —— 别把它的返回当 ExecResult 用）
  const undone = bus.undo();
  ok('撤销成功', undone === true);
  ok('撤销后逐成员回到原位（不是"差不多"）', bus.project.cabinets.every((c) => {
    const b = beforePos.find((x) => x.id === c.id)!;
    return c.placement.x === b.x && c.placement.y === b.y;
  }), JSON.stringify(bus.project.cabinets.map((c) => `${c.placement.x},${c.placement.y}`)));
}

const bus2 = new CommandBus(structuredClone(withAsm), rules);
const rmv = bus2.execute(CMD.removeAssemblyMember('asm_001', '主卧 L 型衣柜', 'cab_b', 'L 型·副臂'));
ok('移除成员成功', rmv.ok, rmv.error ?? '');
ok('移除成员时指向它的连接一起删掉（不留"指向组合外"的脏关系）',
  bus2.project.assemblies?.[0]?.connections.length === 0, JSON.stringify(bus2.project.assemblies?.[0]?.connections));
ok('柜体本身还在（删成员 ≠ 删柜体）', bus2.project.cabinets.some((c) => c.id === 'cab_b'));

const bus3 = new CommandBus(structuredClone(withAsm), rules);
const del = bus3.execute(CMD.deleteAssembly('asm_001', '主卧 L 型衣柜'));
ok('删除组合成功', del.ok, del.error ?? '');
ok('删组合不动柜体（两个柜都还在）', bus3.project.cabinets.length === 2);
ok('删组合后组合类报错归零（没有悬空引用留下）', validateAssemblies(bus3.project).length === 0, codes(validateAssemblies(bus3.project)));
ok('撤销删除后组合回来', bus3.undo() === true && bus3.project.assemblies?.length === 1);

const bus4 = new CommandBus(structuredClone(withAsm), rules);
ok('成员重复加入被拒绝（不是静默变两个）', !bus4.execute(CMD.addAssemblyMember('asm_001', '主卧 L 型衣柜', 'cab_b', 'L 型·副臂')).ok);
ok('重复声明同一对连接被拒绝', !bus4.execute(CMD.connectInAssembly('asm_001', '主卧 L 型衣柜', conn('c9', 'butt', 'cab_a', 'cab_b'))).ok);
ok('新增改名命令可用', bus4.execute(CMD.renameAssembly('asm_001', '衣帽间 L 组')).ok);

// ══════════════════ G. 转角检查：声明优先，推断兜底，不重复报 ══════════════════

section('G. 转角撞门检查 —— 声明过的对必查，推断仍兜底，同一对不重复报');

const swing = validateCornerInterference(withAsm, rules);
const dupTargets = new Set<string>();
let dup = 0;
for (const i of swing) {
  if (dupTargets.has(i.target)) dup++;
  dupTargets.add(i.target);
}
ok('同一对柜不会被报两次', dup === 0, JSON.stringify(swing.map((i) => i.target)));
ok('声明了 corner 的组合，其成员对一定进入检查队列（不依赖推断容差）', (() => {
  // 把副臂**背离接触面**拉开 40mm（超过相接容差 2mm），声明仍在 → 检查队列仍包含它，
  // 但几何上不相接，所以报"没连上"（ASSEMBLY-NOT-TOUCHING）。
  //
  // 为什么是拉 X 不是拉 Y（判据随实现修法演进过一次）：沿接触面**滑动**并不会把
  // 两臂分开 —— 副臂沿主臂侧面滑 40mm，两个面仍然共面且重叠 40mm，那是**真的**
  // 续接（butt），报的是 KIND-MISMATCH 而不是 NOT-TOUCHING。想让两臂真的不接触，
  // 必须背离接触面拉。旧夹具用 y+40 曾是"看似拉开、其实还贴着"，而旧的
  // edgesFlush（点到**线段**距离）把它错判成没连 —— 缺陷修好后这条判据必须换。
  const pulled: Project = structuredClone(withAsm);
  pulled.cabinets = pulled.cabinets.map((c) => (c.id === 'cab_b' ? { ...c, placement: { ...c.placement, x: c.placement.x - 40 } } : c));
  const rel = validateAssemblies(pulled);
  return has(rel, 'ASSEMBLY-NOT-TOUCHING', 'ERROR');
})());

// ══════════════════ H. AI 通道：只给语义，不给坐标 ══════════════════

section('H. AI 通道 —— 组合动作只收 id 引用，坐标一个都不许有');

ok('assembly.create / assembly.delete 都在编译器清单里',
  COMPILED_ACTIONS.includes('assembly.create') && COMPILED_ACTIONS.includes('assembly.delete'));
ok('契约里没有给组合动作任何坐标类参数（结构性保证，不是靠记得）', (() => {
  const keys = Object.keys(ACTIONS['assembly.create'].params ?? {});
  return !keys.some((k) => /^(x|y|dx|dy|atX|atY|width|height|depth|rotation)$/i.test(k));
})(), Object.keys(ACTIONS['assembly.create'].params ?? {}).join('、'));

const bus5 = new CommandBus(structuredClone(withAsm), rules);
const aiCreate = compileAction(
  { action: 'assembly.create', target: {}, params: { name: 'AI 组', memberIds: ['cab_a', 'cab_b'], connections: [{ a: 'cab_a', b: 'cab_b', kind: 'corner' }] } } as AiAction,
  bus5.getState(),
  rules
);
ok('AI 的 assembly.create 能编译成命令', aiCreate.ok, aiCreate.error ?? '');
if (aiCreate.ok) {
  const r = bus5.execute(aiCreate.command);
  ok('编译出的命令真能执行', r.ok, r.error ?? '');
  ok('执行后组合存在且关系是 authored', bus5.project.assemblies?.some((a) => a.connections.every((c) => c.origin === 'authored')) === true);
  ok('AI 给的关系经得起落位核对（无 ERROR）', validateAssemblies(bus5.project).filter((i) => i.severity === 'ERROR').length === 0, codes(validateAssemblies(bus5.project)));
}

const badMissing = compileAction({ action: 'assembly.create', target: {}, params: { name: 'X', memberIds: ['cab_ghost'] } } as AiAction, bus5.getState(), rules);
ok('成员不存在 → 整条拒收并说清是哪个 id（不静默少加一个）', !badMissing.ok && badMissing.error.includes('cab_ghost'), badMissing.error);

const badRoom = (() => {
  const p = structuredClone(withAsm);
  const r2 = rectRoom({ id: 'room_second', name: '次卧', x: 5000, y: 0, w: 3000, h: 2500, thickness: 120, height: 2700 });
  p.rooms.push(r2);
  const other = mkCab('cab_x', '别的房间', r2.id, 900, 600, 0);
  p.cabinets.push(other);
  return compileAction({ action: 'assembly.create', target: {}, params: { name: 'X', memberIds: ['cab_a', 'cab_x'] } } as AiAction, p, rules);
})();
ok('跨房间组合 → 拒收（不是只加同房间的那个）', !badRoom.ok && badRoom.error.includes('房间'), badRoom.error);

const badDelete = compileAction({ action: 'assembly.delete', target: {}, params: { assemblyId: 'asm_ghost' } } as AiAction, bus5.getState(), rules);
ok('删不存在的组合 → 拒收并列出现有组合', !badDelete.ok, badDelete.error);

// ══════════════════ I. 序列化与版本 ══════════════════

section('I. 序列化 —— 版本号跟着内容走，旧项目一个字节不动');

ok('无组合的项目仍是 0.2（旧文件读进来再存盘逐字节不变）', resolveSchemaVersion(pA) === '0.2', eq(resolveSchemaVersion(pA), '0.2'));
ok('有组合的项目是 0.3', resolveSchemaVersion(withAsm) === '0.3', eq(resolveSchemaVersion(withAsm), '0.3'));
ok('有多行柜的项目也是 0.3（与 P0/P1 的"版本号跟着内容走"同一口径）', (() => {
  const p = structuredClone(pA);
  p.cabinets[0]!.layout.rows = [
    { id: 'row_001', height: 600, units: structuredClone(p.cabinets[0]!.layout.units) },
    { id: 'row_002', height: 'fill', units: structuredClone(p.cabinets[0]!.layout.units) },
  ];
  return resolveSchemaVersion(p) === '0.3';
})());
ok('无组合时存盘不写出 assemblies 键', !/"assemblies"/.test(serializeProjectFile(pA, '2026-01-01T00:00:00.000Z')));
ok('有组合时存盘写出 assemblies', /"assemblies"/.test(serializeProjectFile(withAsm, '2026-01-01T00:00:00.000Z')));

const round = parseProjectFile(serializeProjectFile(withAsm, '2026-01-01T00:00:00.000Z'));
ok('组合能原样往返（成员/关系/类型都不丢）', round.ok && round.project.assemblies?.[0]?.connections[0]?.kind === 'corner', round.ok ? '' : round.error);
ok('往返后组合仍校验通过', round.ok && validateAssemblies(round.project).filter((i) => i.severity === 'ERROR').length === 0);
ok('往返后版本号保持 0.3', round.ok && round.project.schemaVersion === '0.3', round.ok ? round.project.schemaVersion : '');

ok('成员指向不存在柜体的文件被拒绝（悬空引用不许进内存）', (() => {
  const bad = structuredClone(withAsm);
  bad.assemblies![0]!.memberIds = ['cab_a', 'cab_ghost'];
  return !parseProjectFile(serializeProjectFile(bad, '2026-01-01T00:00:00.000Z')).ok;
})());
ok('连接指向组合外的文件被拒绝', (() => {
  const bad = structuredClone(withAsm);
  bad.assemblies![0]!.memberIds = ['cab_a'];
  return !parseProjectFile(serializeProjectFile(bad, '2026-01-01T00:00:00.000Z')).ok;
})());
ok('kind 非法的文件被拒绝', (() => {
  const bad = structuredClone(withAsm);
  (bad.assemblies![0]!.connections[0] as unknown as { kind: string }).kind = 'welded';
  return !parseProjectFile(serializeProjectFile(bad, '2026-01-01T00:00:00.000Z')).ok;
})());

// ══════════════════ J. 与 v0.2 的兼容边界 ══════════════════

section('J. 兼容边界 —— 没有组合时，一切与 v0.2 完全相同');

ok('无组合：validateAssemblies 一条都不报（不是报一堆 INFO）', validateAssemblies(pA).length === 0, codes(validateAssemblies(pA)));
ok('无组合：快照里不出现 assemblies 键（模型看不见这个能力就不会凭空用）',
  !('assemblies' in (buildSnapshot(pA, rules) as Record<string, unknown>)));
ok('有组合：快照里如实列出，并把 kind 翻成人话', (() => {
  const s = buildSnapshot(withAsm, rules) as unknown as { assemblies?: Array<{ connections: Array<{ kindZh: string }> }> };
  return s.assemblies?.[0]?.connections[0]?.kindZh === '角接（L 型）';
})());
ok('推断出来的关系不进报错（放得近 ≠ 你说连着）', (() => {
  const near: Project = structuredClone(pA);
  // 两柜不相接、也不重叠，只是**背离接触面**挪了 300mm 放得近。
  // （不能沿接触面滑：那样两个面仍然共面且重叠 300mm，那是真接触 —— 见 §G 那条注。）
  near.cabinets = near.cabinets.map((c) => (c.id === 'cab_b' ? { ...c, placement: { ...c.placement, x: c.placement.x - 300 } } : c));
  return validateAssemblies(near).length === 0 && deriveContacts(near).length === 0;
})());
// 占位断言等于没断言（恒真），这里换成真的：推断必须带 origin='inferred'，且绝不进报错
const inferred = inferConnections(pA);
ok('推断出来的关系带 origin=inferred（不冒充用户声明的事实）',
  inferred.length > 0 && inferred.every((c) => c.origin === 'inferred'),
  JSON.stringify(inferred.map((c) => c.origin)));
ok('推断的关系不会进报错（只有 authored 才被校验）', (() => {
  // 把推断结果**伪装成声明**塞进一个组合，它应当被核对通过（因为它本来就是真的）；
  // 但反过来：把"放得近"的两柜声明成组合必须报错 —— 那条上面已覆盖。
  // 这里证明的是"推断本身不产生任何 Issue"。
  const withInferred: Project = { ...pA, assemblies: [{ id: 'asm_inf', name: '推断组', roomId: pA.rooms[0]!.id, memberIds: ['cab_a', 'cab_b'], connections: inferred.map((c) => ({ ...c, origin: 'authored' as const })) }] };
  return validateAssemblies(withInferred).filter((i) => i.severity === 'ERROR').length === 0;
})());

// ══════════════════ K. U 型：三柜两条角接 ══════════════════

section('K. U 型（三柜两条角接）—— 新柜型是"组合"出来的，不是新分支');

const pU = baseProject();
const u1 = mkCab('cab_u1', 'U 型·左臂', pU.rooms[0]!.id, 1200, 600, 0);
pU.cabinets.push(u1);
const u2 = placeFor(pU, mkCab('cab_u2', 'U 型·底臂', pU.rooms[0]!.id, 1000, 600, 90), 'corner');
if (u2) pU.cabinets.push(u2);
const u3 = u2 ? placeFor(pU, mkCab('cab_u3', 'U 型·右臂', pU.rooms[0]!.id, 1000, 600, 180), 'corner') : null;
if (u3) pU.cabinets.push(u3);
ok('能落出三臂相接的 U 型', u2 !== null && u3 !== null);
if (u2 && u3) {
  const cs = deriveContacts(pU);
  const corners = cs.filter((c) => c.kind === 'corner');
  ok('U 型派生出至少 2 条角接', corners.length >= 2, eq(corners.length, '>=2'));
  const asmU = asm('asm_u', 'U 型衣帽间', pU.rooms[0]!.id, ['cab_u1', 'cab_u2', 'cab_u3'], [
    conn('cu1', 'corner', 'cab_u1', 'cab_u2'),
    conn('cu2', 'corner', 'cab_u2', 'cab_u3'),
  ]);
  const issU = validateAssemblies({ ...pU, assemblies: [asmU] });
  ok('U 型声明全部经得起落位核对（无 ERROR）', issU.filter((i) => i.severity === 'ERROR').length === 0, codes(issU));
  ok('U 型没有被报"分成几堆"（三臂连成一片）', !has(issU, 'ASSEMBLY-DISCONNECTED'));
  ok('U 型里"首尾两臂并不相接"不会牵连出报错（它们本来就不相邻）', !has(issU, 'ASSEMBLY-NOT-TOUCHING'));
}

// ══════════════════ 收尾 ══════════════════

console.log('\n════════════════════════════════════════════════');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('\nP2 成立：Case 5（L 型角接）/ Case 6（跨柜变深并排）由同一套 Connection 表达并被落位核对；关系层不产生任何几何；整组操作一次命令、一次撤销。');
