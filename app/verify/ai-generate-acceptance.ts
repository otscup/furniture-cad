import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, RuleSet, UnitSpec } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
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
    // 电器格五字段加入后清单变长 —— 断言的意图不变：字段清单封闭，且每个都有类型声明
    const KNOWN = ['kind', 'width', 'count', 'rodHeight', 'doorCount', 'nickname', 'applianceName', 'openingWidth', 'openingHeight', 'openingDepth', 'topDrawers'];
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

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log('  ·', f);
} else {
  console.log('\nAI 按描述生成柜体成立：意图是语义的、几何仍是派生的、宽度精确到 1mm。');
}
process.exit(fail > 0 ? 1 : 0);
