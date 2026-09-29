/**
 * ══════════════════════════════════════════════════════════════════════
 *  报错人话化 + 一键修复验收
 *
 *  用户原话：「报错信息看不懂」（master 反馈五件事里的第 4 件）。
 *
 *  ── 为什么要这样验 ──
 *    fixHint 覆盖率从 30% 提到 100%，如果写成"给每条补一句提示"，
 *    那么下次加规则就又回到 30%。所以这里验的是**结构**：
 *      ① 所有报错只能经 issueCatalog 构造（buildIssue 未登记的码直接抛错 → 编译/运行即炸）
 *      ② 源码扫描：每个真实发出的规则码都在目录里登记（**新增规则忘了登记 = 验收红**）
 *      ③ 每条卡的 message / hint 都过"人话质量关"：带得出具体数、说得出怎么办，
 *         不许"检查一下""调整一下"这种零信息量的空话
 *      ④ 一键修复只对"修法唯一可判定"的规则开放；程序缺陷类一律不给按钮
 *      ⑤ 一键修复走的是总线：一次修复 = 一条命令 = 一次撤销，且错误真的消失
 *
 *  ── 一个反复出现的教训 ──
 *    断言失败先假定**断言自己写错**（本项目已经出现过两轮"探针自己写错"）。
 *    所以下面凡是取值多一步的，都把原始值打进 detail。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, makeUnit, sampleProject } from '../src/core/docFactory.ts';
import * as CMD from '../src/core/commands.ts';
import { generateCabinet } from '../src/core/geometry/generate.ts';
import { doorWidths } from '../src/core/geometry/layout.ts';
import { validateCabinet } from '../src/core/rules/validate.ts';
import { RULE_CODES, buildIssue, ruleCard, type RuleCard } from '../src/core/rules/issueCatalog.ts';

/** 取一张规则卡（少了它，下面几处断言会退化成"能取到就绿"） */
const BUILD = (code: string) => {
  const c = ruleCard(code);
  if (!c) throw new Error(`目录里没有这张卡：${code}`);
  return c;
};

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

/**
 * 造一台真实柜体做**修复命令**的素材：目录里的 fix 要能构造出命令，
 * 就得有柜体对象（命令是"改哪个柜的哪个字段"，不是凭空产生的）。
 * 用工厂造真柜而不是塞一个假对象，是为了让"修复计划"和界面上点到的那个一模一样。
 */
const FIXTURE = createCabinet({
  id: 'cab_fix',
  name: '样柜',
  roomId: sampleProject(rules).rooms[0]!.id,
  x: 0,
  y: 0,
  units: [makeUnit({ kind: 'drawerBank', requestedWidth: 600, count: 2, nickname: '抽屉格', rules, depth: 500 }, new Set(['cab_fix']))],
  params: { width: 1200, height: 900, depth: 500 },
  rules,
});
/** 每处 fix 都拿这台真柜（引用同一份，断言之间不会互相污染） */
const wideCabinetFixture = (): Cabinet => FIXTURE;

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

// ═══════════════════════ A 结构性覆盖：报错只能经目录产出 ═══════════════════════
section('A 结构性覆盖：目录是唯一出口，报错不可能漏带人话');

/**
 * 源码扫描：所有真实发出的规则码都必须登记。
 * 这是"以后新增规则忘了写卡片"的唯一防线 —— 单看目录看不出来谁没登记。
 */
const SRC_DIRS = ['src/core/rules', 'src/core/geometry'];
const srcText = SRC_DIRS.map((d) => readdirSync(join(APP, d)).filter((f) => f.endsWith('.ts')).map((f) => readFileSync(join(APP, d, f), 'utf8'))).flat().join('\n');
const emitted = new Set<string>();
for (const m of srcText.matchAll(/['"`]([A-Z][A-Z0-9-]{4,})['"`]/g)) {
  const code = m[1]!;
  // 只收"形如规则码"的标识符，避免把普通字符串误判成规则码
  if (/^(RULE|IDENTITY|MISSING|DUP|PANEL|LAYOUT|ALLOC|GEN|CORNER|DOUBLE)/.test(code)) emitted.add(code);
}
const unregistered = [...emitted].filter((c) => !RULE_CODES.includes(c));
ok('源码里发出的每个规则码都在目录中登记（新增规则忘登记 = 这里红）', unregistered.length === 0, `未登记：${JSON.stringify(unregistered)}`);
ok('目录里的码不是摆设（每种至少曾经被用过 / 至少都可构造人话）', RULE_CODES.length >= 30, `目录条目 ${RULE_CODES.length} 个`);

// buildIssue：未登记的码不许静默产出一条没人看得懂的报错
let threw = false;
try {
  buildIssue('RULE-THIS-DOES-NOT-EXIST', { target: 'x', targetKind: 'cabinet', ctx: {} });
} catch {
  threw = true;
}
ok('用没登记的码造报错会直接抛错（宁可炸，也不许产出一条看不懂的报错）', threw);

const sampleCtx = { cabName: '测试柜', unitName: '左抽', unitId: 'unit_1', unitIndex: 0 };
const anyIssue = buildIssue('RULE-DOOR-MAX-WIDTH', { target: 'c1.unit_1', targetKind: 'unit', ctx: { ...sampleCtx, maxW: 1380, limit: 1200, count: 2, netW: 2760 } });
ok('普通报错也带得出 fixHint（这是 100% 覆盖的落点）', typeof anyIssue.fixHint === 'string' && (anyIssue.fixHint ?? '').length >= 8, String(anyIssue.fixHint));

// ═══════════════════════ B 人话质量：每条卡都要说得清 "差多少 / 怎么办" ═══════════════════════
section('B 人话质量：差多少 + 怎么办，两样都得有');

/** 空话清单：出现这些词说明提示没给信息量，用户看了等于没看 */
const VAGUE = ['检查一下', '调整一下', '自行处理', '请确认后处理', 'TODO', 'TBD', '待补充'];

/**
 * 人话质量的**分档口径**（程序缺陷类本来就"没有差多少"，硬要数字反而不诚实）：
 *   · 设计类（用户能改出来的问题）：必须给出具体数字（差多少 / 改到多少）
 *   · 程序缺陷类：必须明说"这是程序缺陷 / 生成器缺陷"，不许让用户以为是自己的锅
 * 两类都不许出现 undefined / NaN / "[object ...]"，都不许是"检查一下"这类空话。
 */
/**
 * 报不出数字的例外：这几条是**语义/结构矛盾**，根本没有"差多少 mm"这个概念
 * （电器洞口本就不该有门、双面柜本就该有背面、单面柜本就不该有背面）。
 * 对它们硬要求数字反而是塞水；但要求它们明说"这是你要定的事"。
 */
const NO_NUMBER_OK = new Set(['RULE-APPLIANCE-DOOR', 'RULE-DOUBLE-NO-BACK', 'RULE-ROW-WITH-BACK']);

/**
 * 数字型 ctx：这几条卡的"差多少"来自派生（间隙 mm / 夹角 / 成员数 / 高度），
 * 通用 sampleCtx 里没有，光靠 `/\d/` 会**因为兜底 0 而假绿**
 * （num() 缺值时返回 0，于是"成员数 0 个"也算带数字 —— 这正是本项目反复踩的假绿）。
 *
 * 所以这里给每条这类卡喂一组**有辨识度的真实值**，并在下面断言
 * 「这个值确实出现在 message 里」—— 光有数字不行，得是对的那个数字。
 * 数值刻意取成 137 / 45 / 3 这种不会与模板里其他数字混淆的。
 */
const NUM_CTX: Record<string, Record<string, unknown>> = {
  'ASSEMBLY-NOT-TOUCHING': { asmName: 'L 型组', nameA: '左柜', nameB: '右柜', kindZh: '角接', gap: 137 },
  'ASSEMBLY-KIND-MISMATCH': { asmName: 'L 型组', nameA: '左柜', nameB: '右柜', declared: '角接', actual: '续接', angle: 45 },
  'ASSEMBLY-EDGE-MISMATCH': { asmName: 'L 型组', cabName: '左柜', declared: '左侧', actual: '正面', angle: 45 },
  'ASSEMBLY-EDGE-AMBIGUOUS': { asmName: 'L 型组', cabName: '左柜', declared: '左侧', actual: '正面', angle: 45 },
  'ASSEMBLY-CONN-OUTSIDE': { asmName: 'L 型组', cabId: 'cab_x', count: 3 },
  'ASSEMBLY-CONN-SELF': { asmName: 'L 型组', cabId: 'cab_x', count: 3 },
  'ASSEMBLY-CONN-DUP': { asmName: 'L 型组', nameA: '左柜', nameB: '右柜', count: 3 },
  'ASSEMBLY-MEMBER-MISSING': { asmName: 'L 型组', cabId: 'cab_x', count: 3 },
  'ASSEMBLY-MEMBER-DUP': { asmName: 'L 型组', cabId: 'cab_x', count: 3 },
  'ASSEMBLY-MEMBER-ROOM': { asmName: 'L 型组', cabName: '左柜', roomName: '次卧', count: 3 },
  'ASSEMBLY-ROOM-MISSING': { asmName: 'L 型组', roomId: 'room_x', count: 4 },
  'ASSEMBLY-EMPTY': { asmName: 'L 型组', count: 0 },
  'ASSEMBLY-ID-DUP': { asmId: 'asm_001', asmName: 'L 型组', count: 2 },
  'ASSEMBLY-DISCONNECTED': { asmName: 'L 型组', count: 3 },
  'ASSEMBLY-MEMBER-SHARED': { cabName: '左柜', names: 'A 组、B 组', count: 2 },
  'ASSEMBLY-STACK-UNVERIFIED': { asmName: '叠放组', nameA: '下柜', nameB: '上柜', hA: 900, hB: 600, total: 1500 },
  // ── P3 设计方案（还在纸上的方案：引用用 ref，尺寸说"能不能建"）──
  'PROPOSAL-EMPTY': { count: 0 },
  'PROPOSAL-ROOM-MISSING': { room: '次卧', count: 3, names: '主卧、次卧、客厅' },
  'PROPOSAL-CAB-NO-REF': { index: 2 },
  'PROPOSAL-CAB-DUP-REF': { ref: 'cab1', count: 2 },
  'PROPOSAL-SIZE-RANGE': { ref: '鞋柜', dim: '高', value: 5200, min: 300, max: 4000 },
  'PROPOSAL-UNIT-KIND': { where: '柜体「鞋柜」', index: 1, kind: 'drawer', count: 5, kinds: 'drawerBank / hanging / shelves / open / appliance' },
  'PROPOSAL-ASM-MIN': { ref: 'L 型组', count: 1 },
  'PROPOSAL-ASM-MEMBER': { ref: 'L 型组', member: 'cab9', count: 3 },
  'PROPOSAL-CONN-KIND': { ref: 'L 型组', kind: 'glue', count: 3, kinds: 'corner / butt / stack' },
  'PROPOSAL-CONN-REF': { ref: 'L 型组', side: 'a 端', member: 'cab9', count: 2 },
  'PROPOSAL-OPEN-QUESTIONS': { count: 2, first: '柜深按 350 还是 600？' },
};

const rows: Array<{ code: string; ok: boolean; why: string }> = [];
const numberShown: Array<{ code: string; why: string }> = [];
for (const code of RULE_CODES) {
  const isProgram = BUILD(code).program === true;
  const ctx = { ...sampleCtx, ...(NUM_CTX[code] ?? {}) };
  let issue;
  try {
    issue = buildIssue(code, { target: 'c_test.unit_1', targetKind: 'unit', ctx });
  } catch (e) {
    rows.push({ code, ok: false, why: `构造失败：${(e as Error).message}` });
    continue;
  }
  const why: string[] = [];
  const msg = issue.message;
  const hint = issue.fixHint ?? '';
  const manual = BUILD(code).manual ?? '';
  if (!msg || msg.length < 8) why.push('message 太短');
  // "undefined" / "[object" 出现在界面上等于没说话，任何情况都不许有
  if (/undefined|\[object/.test(msg + hint)) why.push('message 里有 undefined / [object');
  if (!hint || hint.length < 8) why.push('fixHint 太短或缺失');
  if (VAGUE.some((v) => hint.includes(v))) why.push('fixHint 是空话');
  if (isProgram) {
    if (!/程序|生成器/.test(msg + hint + manual)) why.push('没说明这是程序缺陷（会误导用户以为是自己的问题）');
    // 程序缺陷类用 NaN 作"没有值"的显示是有意的（比 ? 更容易暴露问题），不断言 NaN
  } else {
    if (NO_NUMBER_OK.has(code)) {
      // 这几条与尺寸无关（结构矛盾 / 语义错误）：
      // 要么给得出一键修（电器洞口那格去掉门），要么明说"要你定" —— 不许两头都没有
      if (!manual && !BUILD(code).fix) why.push('这条本就报不出数字，就该明说"要你决定"或给个按钮，不能两头都没有');
    } else if (!/\d/.test(msg + hint)) {
      why.push('没给出任何具体数字（说不清差多少）');
    }
  }
  // 派生喂进去的**每个**数字都必须真的出现在 message 上：
  // 只断言"有数字"会被 num() 的兜底 0 顶替（"成员数 0 个"也算有数字 = 假绿）
  const extra = NUM_CTX[code];
  if (extra) {
    const missing = Object.entries(extra)
      .filter(([, v]) => typeof v === 'number' && !msg.includes(String(v)))
      .map(([k, v]) => `${k}=${v}`);
    if (missing.length > 0) numberShown.push({ code, why: `message 没写派生给出的值 ${missing.join('、')}｜msg=${msg}` });
  }
  rows.push({ code, ok: why.length === 0, why: why.join('；') });
}
const bad = rows.filter((r) => !r.ok);
ok('每条设计类报错都给出具体数字（差多少 / 改到多少）', bad.length === 0, JSON.stringify(bad));
ok(
  `喂给派生卡的数字都真写进了 message（${Object.keys(NUM_CTX).length} 条：gap/angle/count/hA/hB/total 一个都不能被兜底 0 顶替）`,
  numberShown.length === 0,
  JSON.stringify(numberShown)
);
ok('每条程序缺陷类都明说了"这是程序缺陷"（不让用户背锅）', rows.filter((r) => BUILD(r.code).program === true).every((r) => r.ok), JSON.stringify(rows.filter((r) => BUILD(r.code).program === true && !r.ok)));

// 人话的核心：说"差多少"，而不是"参数不合法"
const runnerCtx = { ...sampleCtx, cab: undefined, runnerLength: 550, depth: 400 };
const runnerCard = buildIssue('RULE-RUNNER-TOO-LONG', { target: 'c1.a', targetKind: 'unit', ctx: runnerCtx });
ok('滑轨那条报的是"滑轨长 550 / 柜深 400"，不是"参数不合法"',
  runnerCard.message.includes('550') && runnerCard.message.includes('400'),
  runnerCard.message);
const runnerFixPlan = buildIssue('RULE-RUNNER-TOO-LONG', { target: 'c1.a', targetKind: 'unit', ctx: { ...runnerCtx, cab: wideCabinetFixture() } }).autoFix;
ok('滑轨那条给出了一键修复计划（缩短滑轨到柜体深度 400）', Boolean(runnerFixPlan) && runnerFixPlan!.changes[0]?.value === 400, JSON.stringify(runnerFixPlan));

// ═══════════════════════ C 一键修复：只对"修法唯一"开放 ═══════════════════════
section('C 一键修复：只对修法唯一的规则开放，程序缺陷一律不给');

/**
 * ⚠️ 卡片上的字段叫 `fix`，不叫 `autoFix` —— 第一版这里写成 BUILD(c).autoFix，
 * 取到恒为 undefined，于是"有几条能一键修"永远是 0、"都没偷偷加按钮"永远绿。
 * **一条永远为真的断言比一条失败的断言危险得多**，所以下面统一走 hasFix()，
 * 并且顺手断言"目录里确实存在可修的卡"（0 条 = 断言退化，不算通过）。
 */
const hasFix = (code: string): boolean => Boolean(BUILD(code).fix);

/** 目录里标了 program 的码：一律不许有一键修复 —— 修了只是把 bug 盖住 */
const programCodes = RULE_CODES.filter((c) => BUILD(c).program === true);
const leaky = programCodes.filter(hasFix);
ok(`程序缺陷类（恒等式/缓存/悬空板件等 ${programCodes.length} 条）一条都没被偷偷加上一键修复`, leaky.length === 0, JSON.stringify(leaky));
ok('程序缺陷类明说了"这是程序缺陷"（不许用户以为是自己设计的问题）',
  programCodes.every((c) => (BUILD(c).manual ?? '').includes('程序') || (BUILD(c).hint(sampleCtx) ?? '').includes('程序')),
  JSON.stringify(programCodes.map((c) => BUILD(c).manual)));

const fixable = RULE_CODES.filter(hasFix);
ok(`目录里确实有可一键修的规则（${fixable.length} 条 —— 为 0 说明这条断言已退化）`, fixable.length >= 3, JSON.stringify(fixable));

/**
 * 跑一遍修复计划：卡片上的 fix 都要能真的造出一条命令。
 * 造命令需要柜体对象（"改哪个柜的哪个字段"不是凭空来的），所以带上 FIXTURE；
 * 直接调 fix() 而不是 buildIssue()，是为了把"造不出计划"这条也逮住
 * （buildFix 里有 try/catch，异常会被吞成"没有计划"，掩盖掉真正的问题）。
 */
const planOf = (code: string): { plan?: ReturnType<NonNullable<RuleCard['fix']>>; err?: string } => {
  try {
    return { plan: BUILD(code).fix!({ ...sampleCtx, cab: wideCabinetFixture() }) };
  } catch (e) {
    return { err: (e as Error).message };
  }
};
const plans = new Map(fixable.map((c) => [c, planOf(c)]));
const badPlan = [...plans].filter(([, r]) => r.err || !r.plan || r.plan.changes.length === 0);
ok(`可一键修的规则（${fixable.length} 条）都造得出一条真命令（不是空计划/抛异常）`, badPlan.length === 0, JSON.stringify(badPlan));
ok('修复计划都带话术（界面上要说明改了什么、会连带影响什么）',
  [...plans].every(([, r]) => (r.plan?.note.length ?? 0) > 4 && (r.plan?.label.length ?? 0) > 2),
  JSON.stringify([...plans].map(([c, r]) => [c, r.plan?.label, r.plan?.note])));
ok('一键修复的计划里没有 id（id 由执行时生成，否则修两次会撞 id）',
  [...plans].every(([, r]) => r.plan !== undefined && !('id' in r.plan)));

// ═══════════════════════ D 端到端：一键修复真能消错，且是一次撤销 ═══════════════════════
section('D 端到端：一键修复走总线、真消错、一次撤销收回');

/**
 * 造一个"门板太宽"的柜：只留一个分区、门扇数 = 1，
 * 于是单扇门宽 ≈ 整格净宽，必然超过 maxDoorWidth。
 *
 * 这一步必须先确认"错误确实存在"，否则后面"修复后错误消失了"可以是假的
 * （本来就没有，修了个寂寞 —— 本项目吃过这种亏）。
 */
/**
 * 造柜：一个分区、一扇门、柜宽 2200mm —— 单扇门宽 2200-2t ≈ 2196mm，
 * 远超 maxDoorWidth（600mm），必然触发 RULE-DOOR-MAX-WIDTH。
 *
 * 注意用文档工厂 + createCabinet（payload 型命令）落进模型，
 * 而不是直接写 layout.units[0] —— 那条路径不在可写白名单里，
 * 直接写会被总线拒掉，于是一个"本该报错"的柜子静默过关（上一版就栽在这）。
 */
const busB = new CommandBus(sampleProject(rules), rules);
const proto = busB.getState().cabinets[0]!;
/**
 * boardT 是**派生量**（在 geom.layout 上），不是 model 上的字段 ——
 * 从 proto.layout.boardT 取是 undefined，一个 undefined 会把整柜宽度算成 NaN，
 * 于是一个本该报错的柜子静默过关（上一版就栽在这）。
 * 板厚只认一个来源：规则集里的材质厚度（与 geometry/layout.ts 同源）。
 */
const boardT = rules.materials[proto.params.boardMaterial].thickness;
ok('探针拿到了板厚（NaN 进去、报错不出来，这一关必须过）', Number.isFinite(boardT) && boardT > 0, `boardT=${boardT}`);
const wideCab = createCabinet({
  id: 'cab_wide',
  name: '宽门柜',
  roomId: busB.getState().rooms[0]!.id,
  x: proto.placement.x,
  y: proto.placement.y - 900,
  units: [
    makeUnit(
      {
        id: 'unit_001',
        kind: 'shelves',
        requestedWidth: 2200 - 2 * boardT,
        count: 1,
        nickname: '宽门格',
        rules,
        depth: proto.params.depth,
        // 门扇数走 UnitSpec.doors.count，没有 doorCount 这个字段
        doors: { count: 1 },
      },
      new Set(['cab_wide'])
    ),
  ],
  params: { width: 2200, height: proto.params.height, depth: proto.params.depth, bodyLift: proto.params.bodyLift },
  rules,
});
const created = busB.execute(CMD.createCabinet(wideCab, 'ui'), { commitLabel: '探针：建一个宽门柜' });
ok('探针的宽门柜建进模型了（建不进去后面全白测）', created.ok, created.error ?? '');

const beforeB = busB.derive().issues.filter((i) => i.code === 'RULE-DOOR-MAX-WIDTH' && i.severity === 'ERROR');
ok('探针造出了"门板太宽"这条硬错（没有负样本，后面的一键修复就验不到东西）', beforeB.length > 0, JSON.stringify(busB.derive().issues.map((i) => `${i.code}:${i.message}`).slice(0, 6)));

const first = beforeB[0]!;
const verBefore = busB.getVersion();
ok('这条报错带得出修复计划（没有计划却给按钮 = 假按钮）', Boolean(first.autoFix), JSON.stringify(first));

let applied = false;
if (first.autoFix) {
  const cmd = { ...first.autoFix, id: `fix_${Date.now()}`, source: 'ui' as const };
  const r = busB.execute(cmd, { commitLabel: first.autoFix.label });
  applied = r.ok;
  ok('一键修复的指令真的被总线接受（走同一条写入口，不是偷偷改模型）', applied, r.error ?? '');
}
/**
 * 关键负样本：「点了按钮，门还是那么宽」是**最坏的一种假按钮** ——
 * 用户以为处理过了，出货时才发现问题。所以这里不只看"这条报错还在不在"，
 * 而是重新算一遍门宽，确认它真的落到了上限以内。
 */
const fixedUnit = busB.getState().cabinets.find((c) => c.id === 'cab_wide')!.layout.units[0]!;
const fixedWidths = doorWidths(fixedUnit, 2200 - 2 * boardT, rules);
ok(
  '一键修复真的把门宽压到了上限以内（不是"点了门还那么宽"）',
  Math.max(...fixedWidths) <= rules.limits.maxDoorWidth,
  `${JSON.stringify(fixedWidths)} vs 上限 ${rules.limits.maxDoorWidth}`
);
const afterB = busB.derive().issues.filter((i) => i.code === 'RULE-DOOR-MAX-WIDTH' && i.severity === 'ERROR');
ok('修复后这条硬错真的消失了（不是"点了没反应"）', applied && afterB.length < beforeB.length, `${beforeB.length} → ${afterB.length}`);
ok('一次修复 = 一次撤销（版本只 +1，撤销一次回到原状）',
  busB.getVersion() === verBefore + 1,
  `v${verBefore} → v${busB.getVersion()}`);
busB.undo();
const afterUndo = busB.derive().issues.filter((i) => i.code === 'RULE-DOOR-MAX-WIDTH' && i.severity === 'ERROR');
ok('撤销后错误回来了（历史是线性的，不是"修了就回不去"）', afterUndo.length === beforeB.length, `${afterUndo.length} vs ${beforeB.length}`);

// 负样本：程序缺陷类不许给修复计划（否则一键"修"会把 bug 盖住）
const identityIssue = buildIssue('IDENTITY-FAIL', { target: 'c1', targetKind: 'cabinet', ctx: { label: '宽度链', detail: 't + Σ净宽 = width', a: 1, b: 2 } });
ok('程序缺陷类没有一键修复计划', !identityIssue.autoFix);
ok('程序缺陷类明说了"这是程序缺陷"（不许用户以为是自己的问题）', Boolean(identityIssue.fixHint?.includes('程序')), String(identityIssue.fixHint));

// ═══════════════════════ 结束 ═══════════════════════
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('\n报错人话化成立：每条报错都带人话解释与可执行建议，一键修复只对唯一修法开放。');
