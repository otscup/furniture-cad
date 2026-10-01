import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, RuleSet, UnitSpec } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { emptyProject, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { buildCabinetBodies } from '../src/core/geometry/bodies3d.ts';
import { compileAction, type AiAction } from '../src/ai/compile.ts';
import { dryRunPlan, commitPlan } from '../src/ai/planRunner.ts';
import { ACTIONS, UNIT_INTENT_ITEM, buildSystemPrompt, validatePlan } from '../shared/aiContract.mjs';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  AI「按描述生成柜体」验收
 *
 *  用户原话：
 *    "目前ai功能太少，只能修改长宽高等一些基础参数……能不能利用AI更具描述生成"
 *    "生成完能不能手动改"（已在 sheetDrag 那一轮交付）
 *
 *  ── 这批断言要证明什么 ──
 *    ① AI 能用**一句话**搭出内部结构（几个分区、每个分区是什么、多少个抽屉、
 *       几扇门），而不是只能改长宽高。
 *    ② 它给出来的仍然**只有语义意图**：没有坐标、没有板件、没有图元。
 *       所以契约里加了 unitIntents 这种新参数类型，而不是放宽成"随便嵌套"。
 *    ③ 建出来的柜体宽度是**精确**的：Σ分区净宽 + 立板 + 两侧板 === 柜宽。
 *       "差 1mm"是本项目最不能接受的一类问题，这条必须常驻。
 *    ④ 说错话（给挂衣区塞 count、字段拼错、分区太多）要被**逐条拒收并说明原因**，
 *       而不是整份计划报废，也不是悄悄忽略。
 *
 *  ── 分组 ──
 *    A 契约：unitIntents 的校验与负样本
 *    B 编译：意图 → 真实分区（kind / count / doors / rodHeight）
 *    C 派生恒等式：宽度加得起来，不差 1mm
 *    D 多步计划：create 之后接着改它（沙盒里依赖要解析到**新建的那个**柜）
 *    E 提示词：新能力必须出现在给模型看的提示词里（不手写，靠生成保证不漂移）
 * ══════════════════════════════════════════════════════════════════════
 */

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

const ctx = { bodyMaterials: [], backMaterials: [] };

/** 走一遍真实链路：契约校验 → 编译 → 提交；返回刚建出来的那个柜 */
function build(a: AiAction & { params: Record<string, unknown> }): { cab: Cabinet | null; error?: string; bus: CommandBus } {
  // 注意：index 是**校验之后**才附上的（validateAction 对多余键零容忍），
  // 直接把带 index 的对象塞回去会被当成"契约外字段"整条丢掉。
  const { index: _drop, ...raw } = a;
  const v = validatePlan({ reply: '', actions: [raw] }, ctx);
  if (!v.ok || v.actions.length === 0) {
    return { cab: null, error: v.error ?? JSON.stringify(v.rejected), bus: new CommandBus(sampleProject(rules), rules) };
  }
  const bus = new CommandBus(sampleProject(rules), rules);
  const c = compileAction({ ...v.actions[0], index: 0 }, bus.getState(), rules, 'ai');
  if (!c.ok) return { cab: null, error: c.error, bus };
  const r = bus.execute(c.command, { commitLabel: 'AI 建柜' });
  if (!r.ok) return { cab: null, error: r.error, bus };
  // 按名字找回来：示例工程里已经有一个柜，按下标取容易取错对象
  const cab = bus.getState().cabinets.find((c) => c.name === String(raw.params?.name ?? '')) ?? null;
  return { cab, bus };
}

// ═══════════════════════════════ A 契约 ═══════════════════════════════

section('A 契约：unitIntents 的校验');

function validate(actions: unknown[]): ReturnType<typeof validatePlan> {
  return validatePlan({ reply: '', actions }, ctx);
}

const goodUnits = [
  { kind: 'drawerBank', width: 500, count: 3, nickname: '左抽' },
  { kind: 'shelves', width: 800, count: 2, doorCount: 2, nickname: '中门格' },
  { kind: 'open', width: 500, nickname: '右开放' },
];

ok('A1 正常的一列分区意图通过校验', validate([{ action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: goodUnits } }]).ok === true);

const tooMany = validate([
  {
    action: 'cabinet.create',
    target: { roomName: '主卧' },
    params: { name: 'X', units: Array.from({ length: 9 }, (_, i) => ({ kind: 'shelves', width: 200, nickname: `格${i}` })) },
  },
]);
ok('A2 分区数超上限 → 拒，并说"描述得太碎，请合并"',
  tooMany.ok === false && /描述得太碎|最多/.test(JSON.stringify(tooMany.rejected) + (tooMany.error ?? '')),
  JSON.stringify(tooMany.rejected));

const unknownField = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [{ kind: 'shelves', width: 500, panels: [] }] } },
]);
ok('A3 分区里夹带派生字段 → 拒（AI 依然碰不到几何）',
  unknownField.ok === false && /panels/.test(JSON.stringify(unknownField.rejected)),
  JSON.stringify(unknownField.rejected));

const hangingCount = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [{ kind: 'hanging', width: 800, count: 3 }] } },
]);
ok('A4 挂衣区给了 count → 拒，并告诉他该用 rodHeight',
  hangingCount.ok === false && /rodHeight/.test(JSON.stringify(hangingCount.rejected)),
  JSON.stringify(hangingCount.rejected));

const shelfRod = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [{ kind: 'shelves', width: 800, rodHeight: 1800 }] } },
]);
ok('A5 层板区给了 rodHeight → 拒（只有挂衣区有杆）',
  shelfRod.ok === false && /rodHeight/.test(JSON.stringify(shelfRod.rejected)),
  JSON.stringify(shelfRod.rejected));

const openCount = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [{ kind: 'open', width: 800, count: 2 }] } },
]);
ok('A6 空区给了 count → 拒，并提示想要层板就改用 shelves',
  openCount.ok === false && /shelves/.test(JSON.stringify(openCount.rejected)),
  JSON.stringify(openCount.rejected));

const emptyUnits = validate([{ action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [] } }]);
ok('A7 units 给空数组 → 拒（要么别说，要么说清楚）',
  emptyUnits.ok === false && /空数组/.test(JSON.stringify(emptyUnits.rejected)),
  JSON.stringify(emptyUnits.rejected));

const badWidth = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [{ kind: 'shelves', width: 10 }] } },
]);
ok('A8 分区宽低于下限 → 拒', badWidth.ok === false, JSON.stringify(badWidth.rejected));

const badDoor = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [{ kind: 'shelves', width: 500, doorCount: 7 }] } },
]);
ok('A9 门扇数超上限 → 拒', badDoor.ok === false, JSON.stringify(badDoor.rejected));

ok('A10 每一项字段都登记在册（不许出现没有校验的字段）',
  (() => {
    // 电器格五字段加入后清单变长 —— 断言的意图不变：字段清单封闭，且每个都有类型声明。
    // P9.6 §二十七：doorMaterial（玻璃门材质 id）入册 —— 契约有类型、编译期 checkDoorMaterial
    // 校验存在性（未知材质拒收），real-furniture-request 验收 §2 钉住负样本。
    const KNOWN = ['kind', 'width', 'count', 'rodHeight', 'doorCount', 'doorMaterial', 'nickname', 'applianceName', 'openingWidth', 'openingHeight', 'openingDepth', 'topDrawers'];
    const keys = Object.keys(UNIT_INTENT_ITEM);
    return keys.every((k) => KNOWN.includes(k)) && keys.every((k) => UNIT_INTENT_ITEM[k] && typeof UNIT_INTENT_ITEM[k].type === 'string');
  })(),
  Object.keys(UNIT_INTENT_ITEM).join(','));

const addUnitDoor = validate([
  { action: 'cabinet.addUnit', target: { cabinetName: '主卧衣柜' }, params: { kind: 'shelves', requestedWidth: 500, doorCount: 2 } },
]);
ok('A11 addUnit 也支持 doorCount（增量描述同样能长出柜门）', addUnitDoor.ok === true, JSON.stringify(addUnitDoor.rejected));

// ═══════════════════════════════ B 编译 ═══════════════════════════════

section('B 编译：一句话 → 真实分区');

const r1 = build({
  action: 'cabinet.create',
  target: { roomName: '主卧' },
  params: { name: '餐边柜', width: 1800, height: 900, depth: 400, units: goodUnits },
  reason: '',
  index: 0,
});

ok('B1 建出来了', r1.cab !== null, r1.error ?? '');
const cab1 = r1.cab as Cabinet;
ok('B2 分区数量与意图一致（没有偷偷补默认三分区）', cab1?.layout.units.length === 3, `${cab1?.layout.units.length} 个`);
ok('B3 分区类型与顺序落地',
  cab1?.layout.units.map((u: UnitSpec) => u.kind).join(',') === 'drawerBank,shelves,open',
  cab1?.layout.units.map((u: UnitSpec) => u.kind).join(','));
ok('B4 昵称落地', cab1?.layout.units.map((u: UnitSpec) => u.nickname).join('|') === '左抽|中门格|右开放');
ok('B5 抽屉数落地（count 在该解释为抽屉数的地方解释为抽屉数）', cab1?.layout.units[0]?.drawers?.count === 3, String(cab1?.layout.units[0]?.drawers?.count));
ok('B6 层板数落地', cab1?.layout.units[1]?.shelves?.count === 2, String(cab1?.layout.units[1]?.shelves?.count));
ok('B7 说的两扇门真的做出来了', cab1?.layout.units[1]?.doors?.count === 2 && cab1?.layout.units[1]?.doors?.type === 'hinged');
ok('B8 门五金来自规则集（不是 AI 编的型号）', Boolean(rules.hardware?.[cab1?.layout.units[1]?.doors?.hinge ?? '']), cab1?.layout.units[1]?.doors?.hinge);
ok('B9 开放格就是不带门（不是"忘了填"）', cab1?.layout.units[2]?.doors === undefined);
ok('B10 分区 id 各不相同（否则板件会撞 id → 清单少一块 → 生产下错料）',
  new Set(cab1?.layout.units.map((u: UnitSpec) => u.id)).size === cab1?.layout.units.length,
  cab1?.layout.units.map((u: UnitSpec) => u.id).join(','));

const rodCab = build({
  action: 'cabinet.create',
  target: { roomName: '主卧' },
  params: { name: '衣柜2', width: 1200, units: [{ kind: 'hanging', width: 1200, rodHeight: 1650 }] },
  reason: '',
  index: 0,
});
ok('B11 挂衣区杆高落地', (rodCab.cab as Cabinet)?.layout.units[0]?.rod?.heightFromBottom === 1650, String((rodCab.cab as Cabinet)?.layout.units[0]?.rod?.heightFromBottom));

ok('B12 不给 units 时仍是默认三分区（老行为没被破坏）',
  build({ action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: '老样子', width: 2400 }, reason: '', index: 0 }).cab?.layout.units.length === 3);

// ═══════════════════════════ C 派生恒等式 ═══════════════════════════

section('C 宽度恒等式：分区加得起来的精确');

function widthId(cab: Cabinet): { sum: number; width: number; t: number; n: number } {
  const L = computeCabinetLayout(cab, rules);
  const sum = L.nets.reduce((a, b) => a + b, 0) + (L.nets.length - 1) * L.boardT + 2 * L.boardT;
  return { sum, width: cab.params.width, t: L.boardT, n: L.nets.length };
}

const w1 = widthId(cab1);
ok('C1 Σ分区净宽 + 立板 + 两侧板 === 柜宽（差 1mm 都不行）', w1.sum === w1.width, `${w1.sum} vs ${w1.width}`);

// AI 给的宽之和**不等于**柜宽的情况才最危险 —— 它必须被按比例摊平，而不是报错或溢出
const mismatch = build({
  action: 'cabinet.create',
  target: { roomName: '主卧' },
  params: { name: '比例柜', width: 1800, units: [{ kind: 'shelves', width: 300, count: 2 }, { kind: 'drawerBank', width: 600, count: 2 }] },
  reason: '',
  index: 0,
});
ok('C2a 意图宽之和不必等于柜宽也能建（300+600 ≠ 1800）', mismatch.cab !== null, mismatch.error ?? '');
const requestedSum = (mismatch.cab as Cabinet)?.layout.units.reduce((a, u) => a + u.requestedWidth, 0) ?? 0;
ok('C2b 记录的仍是 AI 说的原始意图（没有被悄悄改写成别的数）', requestedSum === 900, String(requestedSum));
const w2 = widthId(mismatch.cab as Cabinet);
ok('C2 按比例摊完仍然精确（不因为"AI 没做对加法"就差 1mm）', w2.sum === w2.width, `${w2.sum} vs ${w2.width}`);
const netsBook = computeCabinetLayout(mismatch.cab as Cabinet, rules).nets;
ok('C3 1:2 的意图真的摊成 1:2（允许 1mm 取整余量）',
  Math.abs(netsBook[1] - 2 * netsBook[0]) <= 1, netsBook.join('/'));

const threeUneven = build({
  action: 'cabinet.create',
  target: { roomName: '主卧' },
  params: { name: '三五二', width: 2000, units: [{ kind: 'open', width: 300 }, { kind: 'open', width: 500 }, { kind: 'open', width: 200 }] },
  reason: '',
  index: 0,
});
const w3 = widthId(threeUneven.cab as Cabinet);
ok('C4 三个不等宽分区同样精确（300:500:200）', w3.sum === w3.width, `${w3.sum} vs ${w3.width}`);

const issuesAfter = r1.bus.derive().issues.filter((i) => i.severity === 'ERROR');
ok('C5 建出来的柜体没有硬错（结构自洽）', issuesAfter.length === 0, JSON.stringify(issuesAfter.slice(0, 3)));

// ═══════════════════════════ D 多步计划 ═══════════════════════════

section('D 多步计划：create 之后接着改它');

const bus2 = new CommandBus(sampleProject(rules), rules);
const before2 = bus2.getState().cabinets.length;
const plan2 = [
  {
    action: 'cabinet.create',
    target: { roomName: '主卧' },
    params: { name: '生成柜', width: 1500, units: [{ kind: 'drawerBank', width: 600, count: 2 }, { kind: 'shelves', width: 900, count: 3, doorCount: 2 }] },
    reason: '',
    index: 0,
  },
  {
    action: 'cabinet.setUnitParam',
    target: { cabinetName: '生成柜', unit: 1 },
    params: { param: 'drawers.count', value: 4 },
    reason: '',
    index: 1,
  },
] as AiAction[];
const run = dryRunPlan({ bus: bus2, actions: plan2 });
ok('D1 两步都成立（第②步引用的是第①步刚建出来的那个柜）', run.errorCount === 0 && run.okCount === 2, JSON.stringify(run.steps.map((s) => s.error ?? s.label)));
ok('D2 第②步改的是新柜，不是既有柜（改错对象比报错危险得多）',
  (run.draft.cabinets.find((c) => c.name === '生成柜')?.layout.units[0]?.drawers?.count ?? 0) === 4,
  String(run.draft.cabinets.find((c) => c.name === '生成柜')?.layout.units[0]?.drawers?.count));
ok('D3 干跑不动真模型', bus2.getVersion() === 0 && bus2.getState().cabinets.length === before2);

const committed = commitPlan(run, bus2);
ok('D4 提交一次到位（两个分区 + 4 只抽屉）', committed && bus2.getState().cabinets.length === before2 + 1);

// 逐条拒收而不是整份报废
const planBad = [
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: '好柜', width: 1200, units: [{ kind: 'shelves', width: 1200, count: 2 }] }, reason: '', index: 0 },
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: '坏柜', width: 1200, units: [{ kind: 'hanging', width: 1200, count: 2 }] }, reason: '', index: 1 },
] as AiAction[];
const busBad = new CommandBus(sampleProject(rules), rules);
const runBad = dryRunPlan({ bus: busBad, actions: planBad });
ok('D5 一条坏、一条好时：好的照跑、坏的连原因摊出来（不是整份作废）',
  runBad.okCount === 1 && runBad.errorCount === 1,
  JSON.stringify(runBad.steps.map((s) => (s.ok ? `OK:${s.label}` : `ERR:${s.error}`))));
ok('D6 成功的步骤不许自带 error 文案（字段自带假信息比没有信息更危险）',
  runBad.steps.filter((s) => s.ok).every((s) => s.error === undefined),
  JSON.stringify(runBad.steps.map((s) => [s.ok, s.error ?? '(空)'])));

// ═══════════════ F 真缺陷回归 ═══════════════

section('F 两条真缺陷的回归（都是写这轮验收时现出来的）');

// 缺陷一：自动落位会把新柜塞进墙里，用户刚说完一句话就收到一条干涉 ERROR
const busEmpty = new CommandBus(sampleProject(rules), rules);
const runFit = dryRunPlan({ bus: busEmpty, actions: [
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: '窄柜', width: 600, units: [{ kind: 'shelves', width: 600, count: 2 }] }, reason: '', index: 0 },
] as AiAction[] });
const fitCab = runFit.draft.cabinets.find((c) => c.name === '窄柜');
const afterIssues = runFit.steps[runFit.steps.length - 1]?.newIssues ?? [];
ok('F1 不给落位时，系统自己找的位置不撞墙（不是"放进去再报错"）',
  (fitCab !== undefined) && afterIssues.filter((i) => i.code === 'RULE-CABINET-IN-WALL').length === 0,
  JSON.stringify(afterIssues.map((i) => i.code)));

const busHuge = new CommandBus(sampleProject(rules), rules);
const runHuge = dryRunPlan({ bus: busHuge, actions: [
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: '巨柜', width: 6000, units: [{ kind: 'shelves', width: 6000 }] }, reason: '', index: 0 },
] as AiAction[] });
const hugeErr = runHuge.steps[0]?.error ?? '';
ok('F2 真的放不下时必须说人话 + 说清怎么改（不许退化成"按 (0,0) 放进去再说"）',
  /找不到放得下/.test(hugeErr) && /atX/.test(hugeErr) && runHuge.draft.cabinets.length === 1,
  hugeErr);

// 缺陷二：语义互斥只在服务端拦 → dryRunPlan 直接编译时坏分区能被真的建出来
const busAgain = new CommandBus(sampleProject(rules), rules);
const runAgain = dryRunPlan({ bus: busAgain, actions: [
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: '错柜', width: 1200, units: [{ kind: 'hanging', width: 1200, count: 2 }] }, reason: '', index: 0 },
] as AiAction[] });
ok('F3 语义互斥在编译器里也拦得住（服务端不是唯一的门）',
  runAgain.steps[0]?.ok === false && /rodHeight/.test(runAgain.steps[0]?.error ?? '') && runAgain.draft.cabinets.length === 1,
  runAgain.steps[0]?.error ?? '(竟然建出来了)');

// ═══════════════════════════ E 提示词 ═══════════════════════════

section('E 提示词：新能力必须能被模型看见');

const prompt = buildSystemPrompt();
ok('E1 提示词里出现了 units 参数的写法', /units: 数组/.test(prompt));
ok('E2 提示词里出现了 doorCount（模型才知道"说得出来"）', /doorCount/.test(prompt));
ok('E3 提示词明确"不要先 create 再 removeUnit 拆默认分区"（否则模型会去绕远路）', /removeUnit/.test(prompt));
ok('E4 契约里声明了 units 这个动作参数', Boolean((ACTIONS as Record<string, { params?: Record<string, unknown> }>)['cabinet.create']?.params?.units));

// ══════════ G 形体组合：L 形橱柜真的建得出来 ══════════
// 用户原话：「L 新橱柜，长2200，台面宽750，高1000，另外一边长1200」
// 他当时拿到的回答是"需要两个柜体配合，但目前我只能创建单个柜体，无法直接生成
// L 形结构。请问你希望把这两个柜体分别放到哪个房间里？"。
//
// 那段话不是代码里的固定文案（全仓库 grep 无匹配），是模型自己说出口的。而契约里
// **本来就能拼出 L 形** —— 只是有两处没人说清楚，于是在动作层面真的拼不出来：
//   ① 提示词只把动作一个个列出来，从没说过它们**能组合**；模型于是按"清单里没有
//      L 形这个动作"推断出"系统做不到"。它甚至没注意到正上方就有 cabinet.rotate。
//   ② cabinet.create 不带 rotation，第二条臂只能"先以 0° 建、再转"。中间态是没转
//      的那个朝向，位置多半当场撞墙，被严格模式整条拒掉（实测："嵌进了墙体 1390mm"）
//      —— 那条报错看上去就像"系统不支持转角"。
// 两条一起修，下面这组断言把它们钉死。

section('G 形体组合：L 形橱柜真的建得出来');

const kitchen = emptyProject({ name: '厨房', ruleSetId: rules.id });
kitchen.rooms.push(rectRoom({ name: '厨房', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 }));
const kitchenBus = new CommandBus(kitchen, rules);

/** 两臂共用的角点：一条向左上长、一条向上长 —— 这就是那个 L */
const PIVOT = { atX: 3330, atY: 2730 };

const lRaw = [
  { action: 'cabinet.create', target: { roomName: '厨房' }, params: { name: 'L橱柜-长边', width: 2200, height: 1000, depth: 750, ...PIVOT, rotation: 180 }, reason: '长边 2200 沿墙' },
  { action: 'cabinet.create', target: { roomName: '厨房' }, params: { name: 'L橱柜-短边', width: 1200, height: 1000, depth: 750, ...PIVOT, rotation: 270 }, reason: '短边 1200，转成第二条臂' },
] as unknown as AiAction[];
const lValid = validatePlan({ reply: '', actions: lRaw }, ctx);
ok('G1 用户那四个数（2200/750/1000/1200）能通过契约校验 —— 不再是"无法生成"',
  lValid.ok && lValid.actions.length === 2, lValid.error ?? '(0 条动作)');

const lRun = dryRunPlan({ bus: kitchenBus, actions: lValid.actions });
const badSteps = lRun.steps.filter((s) => !s.ok).map((s) => s.error).join(' / ');
ok('G2 每一步都过编译（没有一步被严格模式拒掉）',
  lRun.steps.length === 2 && lRun.steps.every((s) => s.ok), badSteps || '(竟然一步没跑)');
ok('G3 干跑没有新引入 ERROR（落位没撞墙、两臂没重叠）', lRun.blockingErrors === 0, String(lRun.blockingErrors));

const arms = lRun.draft.cabinets.filter((c) => c.name.startsWith('L橱柜'));
const longArm = arms.find((c) => c.name === 'L橱柜-长边');
const shortArm = arms.find((c) => c.name === 'L橱柜-短边');
ok('G4 两个柜体都建出来了', arms.length === 2, `实到 ${arms.length} 个`);
ok('G5 尺寸就是用户说的那四个数，一个不丢也不自作主张',
  Boolean(longArm?.params.width === 2200 && longArm?.params.height === 1000 && longArm?.params.depth === 750 &&
           shortArm?.params.width === 1200 && shortArm?.params.height === 1000 && shortArm?.params.depth === 750),
  JSON.stringify(arms.map((a) => [a.params.width, a.params.height, a.params.depth])));

/**
 * 世界 AABB。
 *
 * 坑：`Box3D` 里的 `sx / sy` 是**局部**尺寸，世界 AABB 必须把局部四角按 rot 转出去再取包络。
 * 直接拿 `cx ± sx / 2` 会在转过 90° 的柜子上量出完全错误的盒子 —— 我第一次就是这么量错
 * 的，量出"短边伸到 x=4653、穿墙 570mm"，差点据此去改一个并不存在的 bug。
 */
function worldAABB(cab: Cabinet): { minX: number; maxX: number; minY: number; maxY: number } {
  const boxes = buildCabinetBodies(cab, rules);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const b of boxes) {
    const r = (b.rot * Math.PI) / 180;
    for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const lx = (b.sx / 2) * dx;
      const ly = (b.sy / 2) * dy;
      const wx = b.cx + lx * Math.cos(r) - ly * Math.sin(r);
      const wy = b.cy + lx * Math.sin(r) + ly * Math.cos(r);
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
      minY = Math.min(minY, wy); maxY = Math.max(maxY, wy);
    }
  }
  return { minX, maxX, minY, maxY };
}

const A = longArm ? worldAABB(longArm) : null;
const B = shortArm ? worldAABB(shortArm) : null;
ok('G6 两条臂互相垂直（差 90°）',
  Boolean(longArm && shortArm) && Math.abs((Math.abs(longArm!.placement.rotation - shortArm!.placement.rotation) % 180) - 90) < 1e-6,
  longArm && shortArm ? `${longArm.placement.rotation}° vs ${shortArm.placement.rotation}°` : '');
ok('G7 两条臂共用角点（世界 AABB 贴着，中间没有缝）',
  Boolean(A && B) && (Math.abs(A!.maxX - B!.minX) < 1 || Math.abs(A!.maxY - B!.minY) < 1) &&
  Math.min(Math.abs(A!.maxX - B!.minX), Math.abs(A!.maxY - B!.minY)) < 1,
  A && B ? `A x[${A.minX.toFixed(0)}~${A.maxX.toFixed(0)}] y[${A.minY.toFixed(0)}~${A.maxY.toFixed(0)}] / B x[${B.minX.toFixed(0)}~${B.maxX.toFixed(0)}] y[${B.minY.toFixed(0)}~${B.maxY.toFixed(0)}]` : '');
ok('G8 两条臂不重叠 —— 这是 L 形，不是两条平行的柜',
  Boolean(A && B) && (Math.min(A!.maxX, B!.maxX) - Math.max(A!.minX, B!.minX) <= 0.5 || Math.min(A!.maxY, B!.maxY) - Math.max(A!.minY, B!.minY) <= 0.5),
  A && B ? `x 重叠 ${(Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX)).toFixed(0)} / y 重叠 ${(Math.min(A.maxY, B.maxY) - Math.max(A.minY, B.minY)).toFixed(0)}` : '');

/**
 * 负样本自证：把 rotation 撤掉，退回 AI 当初走的「先建、再转」那条老路。
 *
 * ── 2026-09-28 这条的判据改过，理由要留下来 ──
 *   原先断言的是"不带 rotation 的 create 会被撞墙**整条拒掉**"。
 *   那天之后，AI 猜的落位撞墙不再等于失败：系统会沿最小位移把它**推到与墙面相切**
 *   （见 core/snapPlace.ts 的 nudgeOutOfWalls —— 用户现场被"未并入草案"卡住，
 *   根因正是我们让 AI 去猜它根本拿不到的墙坐标）。所以老路现在**建得出来**，
 *   原判据失效。
 *
 *   但 `rotation` 依然承重，只是承重的方式变了，必须换成新的判据：
 *     不带 rotation → 中间态撞墙 → 被系统**挪开**兜底 → 转完之后
 *     它已经不在 AI 说的那个角点上 → 两臂拼不出共用角点的 L。
 *   也就是说：老路能"建成一个柜"，但拼不出用户要的 L。
 *
 *   谁以后把 rotation 删了，这两条会告诉他这个洞有多深。
 */
const naiveRaw = [
  { action: 'cabinet.create', target: { roomName: '厨房' }, params: { name: '旧路-短边', width: 1200, height: 1000, depth: 750, ...PIVOT }, reason: '' },
  { action: 'cabinet.rotate', target: { cabinetName: '旧路-短边' }, params: { deg: 270 }, reason: '' },
] as unknown as AiAction[];
const naiveValid = validatePlan({ reply: '', actions: naiveRaw }, ctx);
const naiveRun = dryRunPlan({ bus: new CommandBus(kitchen, rules), actions: naiveValid.actions });

ok('G9 负样本：不带 rotation 的中间态确实撞墙 —— 系统只能挪位兜底，且把"挪了多少"写进摘要',
  /自动贴墙修正/.test(naiveRun.steps[0]?.label ?? ''),
  naiveRun.steps[0]?.label ?? '(中间态没撞墙？那 PIVOT 这个反例就选错了)');
const naiveCab = naiveRun.draft.cabinets.find((c) => c.name === '旧路-短边');
ok('G10 负样本：兜底之后落位已经不是 AI 说的角点（x 被挪开了）—— 于是两臂拼不出共用角点的 L',
  naiveCab !== undefined && naiveCab.placement.x !== PIVOT.atX,
  JSON.stringify(naiveCab?.placement ?? null));
ok('G10b 正样本对照：create 里就给 rotation 的两条臂落位**分毫未动**（不需要系统兜底，这才是 L 拼得齐的原因）',
  Boolean(longArm && shortArm) && longArm!.placement.x === PIVOT.atX && shortArm!.placement.x === PIVOT.atX &&
    longArm!.placement.y === PIVOT.atY && shortArm!.placement.y === PIVOT.atY,
  longArm && shortArm ? `${JSON.stringify(longArm.placement)} / ${JSON.stringify(shortArm.placement)}` : '');

// ── 提示词：模型必须看得见这些规矩 ──
ok('G11 提示词写明"L 形用多个柜体拼出来"（不写这句模型就会自我否定）',
  /L 形/.test(prompt) && /用多个柜体拼出来/.test(prompt));
ok('G12 提示词要求第二条臂在 create 里直接给 rotation，而不是建完再转',
  /第二条一定要在 cabinet.create 里就给 rotation/.test(prompt));
ok('G13 提示词不许再把"做不到"当挡箭牌（旧文案：做不到就不要产生动作）',
  !/做不到[^\n]*不要产生动作/.test(prompt));
ok('G14 提示词不许因为"有歧义"就整体反问（旧文案会这么干）',
  !/有歧义[^\n]*问清楚/.test(prompt));
ok('G15 提示词不许反问"放到哪个房间"', /永远不要反问用户/.test(prompt));
ok('G16 cabinet.create 的清单里出现了 rotation', /rotation: 枚举\{0\|90\|180\|270\}/.test(prompt));

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  ·', f);
} else {
  console.log('\nAI 按描述生成柜体成立：意图是语义的、几何仍是派生的、宽度精确到 1mm。');
}
process.exit(fail > 0 ? 1 : 0);
