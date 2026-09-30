/**
 * ══════════════════════════════════════════════════════════════════════
 *  P4 验收 —— 统一 Import 架构（External Data → Adapter → Normalized → Semantic）
 *
 *  文档 P4 定的出口判据：边界设计正确，让外部数据**不绕过** Semantic Model /
 *  Rules / CommandBus / 确定性 Geometry，来源/置信度/不确定项有明确归属。
 *
 *  ── 这批断言在防什么（按危险程度排）──
 *
 *  ① **导入成了绕过 CommandBus 的后门。** 编译产物是 AiAction，必须过契约校验
 *     （validateAction），只有走 commitPlan 才落模型；预览前后真总线逐值相同。
 *
 *  ② **导入直接变成板件坐标 / DXF primitives。** 归一化结果里不许出现 atX / atY；
 *     落位必须由 pickFreeSpot 定（DXF 适配器连 DXF 坐标都不许进落位）。
 *
 *  ③ **来源/置信度/不确定项没归属。** 落库后的 Cabinet 必须带 origin（source /
 *     batchId / confidence / uncertainty），且与导入批次一致 —— 可审计、可追溯。
 *
 *  ④ **不确定项被静默猜掉。** 有 uncertainty / questions 的导入**必须**拒绝应用；
 *     尺寸没给只能用规则集默认，并写进 notes。
 *
 *  ⑤ **失败/不完整/未验证能力被静默。** 形状错→IMPORT-SHAPE；待确认→
 *     IMPORT-OPEN-QUESTIONS；不确定→IMPORT-UNCERTAINTY；未验证能力→
 *     IMPORT-UNVERIFIED-CAPABILITY（必须显示，不假装成功）。
 *
 *  ⑥ **报错不带数字，被兜底值顶替成假绿。** 每条 IMPORT-* 的 message 必须含
 *     **喂进去的真实值**（uncertainty 第一条 / question 第一条 / capability 文本 /
 *     source），只断言 /\d/ 会被兜底值 0 骗过。
 *
 *  ⑦ **旧项目被改坏。** 导入前旧柜一条不少，新柜追加；项目结构（房间 / schema）不变。
 *
 *  ⑧ **酷家乐 / 图片识别假装已接入。** 二者只是边界占位：非法输入诚实反问、
 *     合法输入标 low 置信度 + unverifiedCapabilities，绝不出现"我解析了"。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { buildIssue } from '../src/core/rules/issueCatalog.ts';
import { ACTIONS, validateAction } from '../shared/aiContract.mjs';
import { parseImport } from '../src/ai/import/adapters.ts';
import { compileImport } from '../src/ai/import/compileImport.ts';
import { importBlocked, validateNormalized, type NormalizedDesign } from '../src/ai/import/normalized.ts';
import { commitPlan, dryRunPlan } from '../src/ai/planRunner.ts';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(title: string): void {
  console.log(`\n【${title}】`);
}
const eq = (label: string, a: unknown, b: unknown): void =>
  ok(label, JSON.stringify(a) === JSON.stringify(b), `实际 ${JSON.stringify(a)} ｜ 期望 ${JSON.stringify(b)}`);

const base = (): Project => JSON.parse(JSON.stringify(sampleProject(rules))) as Project;
const roomOf = (p: Project): string => p.rooms[0]!.id;

// ═══════════════════════ A JSON 端到端：解析→编译→落库，origin 跟随 ═══════════════════════
section('A JSON 端到端：经同一条链路落模型，来源归属落到 Cabinet.origin');
{
  const p = base();
  const bus = new CommandBus(p, rules);
  const room = roomOf(p);
  const before = {
    ids: bus.getState().cabinets.map((c) => c.id),
    version: bus.getVersion(),
  };

  const json = JSON.stringify({
    title: '玄关鞋柜导入',
    room,
    cabinets: [{ ref: 'shoe', name: '玄关鞋柜', width: 900, height: 2400, depth: 350, confidence: 'high' }],
  });
  const nd = parseImport('json', json);
  eq('JSON 适配器识别来源', nd.source, 'json');
  eq('JSON 适配器确定性给出 batchId', typeof nd.batchId, 'string');

  const compiled = compileImport(nd, bus.getState(), rules);
  ok('JSON 导入编译成功', compiled.ok, compiled.blockedReason ?? '');
  ok('编译出一条 cabinet.create', compiled.actions.length === 1 && compiled.actions[0]!.action === 'cabinet.create');

  // 动作过契约（不是后门）
  const a = compiled.actions[0]!;
  const v = validateAction({ action: a.action, target: a.target ?? {}, params: a.params, reason: a.reason }, { rules, project: bus.getState() });
  ok('编译出的动作过契约校验（Import 不是绕过校验的后门）', v.ok, v.ok ? '' : v.error);
  ok('动作里没有任何坐标（atX / atY）—— 落位由系统定', !('atX' in a.params) && !('atY' in a.params), JSON.stringify(a.params));
  ok('origin 已注入动作（provenance 随编译透传）', a.origin?.source === 'json' && a.origin?.batchId === nd.batchId);

  const run = dryRunPlan({ bus, actions: compiled.actions, gate: null });
  eq('干跑无失败', run.errorCount, 0);
  // 预览不动真模型
  eq('预览后真总线柜体数没变', bus.getState().cabinets.length, before.ids.length);
  eq('预览后版本没变', bus.getVersion(), before.version);

  const outcome = commitPlan(run, bus);
  ok('提交成功', outcome.ok, outcome.ok ? '' : outcome.error);
  eq('真总线多了 1 个柜', bus.getState().cabinets.length, before.ids.length + 1);
  eq('版本只 +1', bus.getVersion(), before.version + 1);

  const made = bus.getState().cabinets.find((c) => c.name === '玄关鞋柜')!;
  ok('参数与导入一致（900×2400×350）', made.params.width === 900 && made.params.height === 2400 && made.params.depth === 350);
  ok('落位由系统定（placement 存在、无导入坐标）', typeof made.placement.x === 'number' && typeof made.placement.y === 'number');
  ok('origin 落到模型（source / batchId / confidence）', made.origin?.source === 'json' && made.origin?.batchId === nd.batchId && made.origin?.confidence === 'high', JSON.stringify(made.origin));

  // 旧项目兼容：导入前的旧柜一条不少
  ok('旧柜全部保留（导入不破坏旧项目）', before.ids.every((id) => bus.getState().cabinets.some((c) => c.id === id)));
}

// ═══════════════════════ B DXF：保守意图提取，不产坐标、标 low ═══════════════════════
section('B DXF 适配器：只提取块引用，不产坐标，诚实标 low 置信度');
{
  const dxf = [
    '0', 'SECTION', '2', 'BLOCKS',
    '0', 'INSERT', '2', 'BLK1', '10', '1000', '20', '2000', '41', '1.2', '43', '2.4',
    '0', 'INSERT', '2', 'BLK2', '10', '3000', '20', '2000', '41', '0.9', '43', '2.4',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');
  const nd = parseImport('dxf', dxf);
  eq('DXF 适配器识别来源', nd.source, 'dxf');
  eq('DXF 提取到 2 个块（柜体意图）', nd.cabinets.length, 2);
  ok('每个柜置信度 low（诚实弱解析）', nd.cabinets.every((c) => c.confidence === 'low'));
  ok('未验证能力列出（几何识别待 P5）', (nd.unverifiedCapabilities ?? []).some((c) => c.includes('dxf-block-recognition')));

  // DXF 弱解析诚实：提取到块引用但内部未知 → 标 uncertainty → 必须阻断（不静默建柜）
  ok('DXF 归一化结果里没有坐标字段（atX / atY / placement）—— DXF 坐标不进标准模型', !/"atX"|"atY"|"placement"/.test(JSON.stringify(nd)), JSON.stringify(nd).slice(0, 200));
  const p = base();
  const bus = new CommandBus(p, rules);
  const compiled = compileImport(nd, bus.getState(), rules);
  ok('DXF 含不确定项 → 诚实阻断（不静默建柜）', !compiled.ok, compiled.blockedReason ?? '');
  ok('DXF 阻断由 IMPORT-UNCERTAINTY 触发（uncertainty 拦住）', compiled.issues.some((i) => i.code === 'IMPORT-UNCERTAINTY'));
  ok('DXF 阻断原因复述真实不确定内容（非兜底）', (compiled.blockedReason ?? '').includes('未识别内部结构'), compiled.blockedReason);
  ok('未应用时真总线柜体数不变（阻断 = 没建）', bus.getState().cabinets.length === p.cabinets.length);

  // low 置信度本身不阻断：只有 uncertainty / questions 才拦（用 JSON 低置信度、无不确定项验证）
  {
    const lowJson = JSON.stringify({
      title: '低置信度但确定',
      room: roomOf(p),
      cabinets: [{ ref: 'low1', name: '低置信度柜', width: 1200, height: 2400, depth: 600, confidence: 'low' }],
    });
    const lowNd = parseImport('json', lowJson);
    const lowCompiled = compileImport(lowNd, bus.getState(), rules);
    ok('低置信度但无不确定项 → 仍能编译（low 不阻断，只有 uncertainty/questions 拦）', lowCompiled.ok, lowCompiled.blockedReason ?? '');
  }
}

// ═══════════════════════ C 不确定项阻断：不替用户猜 ═══════════════════════
section('C 不确定项阻断：uncertainty 非空必须拦住应用');
{
  const p = base();
  const bus = new CommandBus(p, rules);
  const before = bus.getState().cabinets.length;
  const uj = JSON.stringify({ title: '含不确定项', cabinets: [{ ref: 'a', width: 900, height: 2400, uncertainty: ['深度未知，需你确认按 350 还是 600'] }] });
  const nd = parseImport('json', uj);
  const issues = validateNormalized(nd, bus.getState());
  const unc = issues.find((i) => i.code === 'IMPORT-UNCERTAINTY');
  ok('有 uncertainty → IMPORT-UNCERTAINTY', Boolean(unc), JSON.stringify(issues.map((i) => i.code)));
  // 防假绿：message 必须含喂进去的那条真实文本，而非只 /\d/
  ok('IMPORT-UNCERTAINTY 的 message 含真实不确定内容（非兜底）', /深度未知，需你确认按 350 还是 600/.test(unc?.message ?? ''), unc?.message ?? '');

  const compiled = compileImport(nd, bus.getState(), rules);
  ok('含 uncertainty → 拒绝编译出可执行动作', !compiled.ok, JSON.stringify(compiled.actions.length));
  ok('阻断原因指向 IMPORT-UNCERTAINTY（issues 标记，非靠 message 文本猜）', compiled.issues.some((i) => i.code === 'IMPORT-UNCERTAINTY'));
  // 模型没被碰
  eq('未应用时真总线柜体数不变', bus.getState().cabinets.length, before);
}

// ═══════════════════════ D 待确认问题阻断 ═══════════════════════
section('D 待确认问题阻断：questions 非空必须拦住');
{
  const p = base();
  const qj = JSON.stringify({ title: '含问题', cabinets: [{ ref: 'a', width: 900 }], questions: ['柜深按 350 还是 600？'] });
  const nd = parseImport('json', qj);
  const issues = validateNormalized(nd, p);
  const q = issues.find((i) => i.code === 'IMPORT-OPEN-QUESTIONS');
  ok('有 questions → IMPORT-OPEN-QUESTIONS', Boolean(q), JSON.stringify(issues.map((i) => i.code)));
  ok('IMPORT-OPEN-QUESTIONS 的 message 含真实问题文本（非兜底）', /柜深按 350 还是 600/.test(q?.message ?? ''), q?.message ?? '');
  const compiled = compileImport(nd, p, rules);
  ok('含 questions → 拒绝编译', !compiled.ok);
  ok('阻断原因指向 IMPORT-OPEN-QUESTIONS（issues 标记，非靠 message 文本猜）', compiled.issues.some((i) => i.code === 'IMPORT-OPEN-QUESTIONS'));
}

// ═══════════════════════ E 酷家乐：仅边界占位，不假装接入 ═══════════════════════
section('E 酷家乐适配器：边界占位，绝不假装已解析');
{
  const bad = parseImport('kujiale', { foo: 'bar' } as unknown);
  ok('酷家乐非法输入 → 不静默，诚实反问（cabinets 空 + questions 非空）', bad.cabinets.length === 0 && (bad.questions?.length ?? 0) > 0);
  ok('酷家乐未验证能力列出', (bad.unverifiedCapabilities ?? []).some((c) => c.includes('kujiale')));

  const okData = parseImport('kujiale', { title: 'kj', cabinets: [{ ref: 'a', width: 900, height: 2400 }] });
  eq('酷家乐合法草稿被收下', okData.cabinets.length, 1);
  eq('酷家乐柜体置信度 low（未经真实验证）', okData.cabinets[0]!.confidence, 'low');
  ok('酷家乐 uncertainty 标"未经真实格式/API 验证"', (okData.cabinets[0]!.uncertainty ?? []).some((u) => u.includes('未经真实格式')), JSON.stringify(okData.cabinets[0]!.uncertainty));
  ok('酷家乐 unverified 明确', (okData.unverifiedCapabilities ?? []).includes('kujiale-format-parsing'));
}

// ═══════════════════════ F 图片识别：仅接收 Vision 结果，不执行视觉识别 ═══════════════════════
section('F 图片识别适配器：只收结构化结果，不假装能看图');
{
  const okData = parseImport('imageVision', { title: 'vis', cabinets: [{ ref: 'a', width: 900 }] });
  eq('图片识别收下结构化结果', okData.cabinets.length, 1);
  eq('图片识别置信度默认 low', okData.cabinets[0]!.confidence, 'low');
  ok('图片识别 uncertainty 标"未经人工确认"', (okData.cabinets[0]!.uncertainty ?? []).some((u) => u.includes('未经人工确认')), JSON.stringify(okData.cabinets[0]!.uncertainty));
  ok('图片识别 unverified 明确', (okData.unverifiedCapabilities ?? []).includes('vision-floor-plan-recognition'));

  const bad = parseImport('imageVision', { foo: 1 } as unknown);
  ok('图片识别非法输入 → 不假装识别（cabinets 空 + questions）', bad.cabinets.length === 0 && (bad.questions?.length ?? 0) > 0);
}

// ═══════════════════════ G 形状门带数字（防假绿）══════════════════════
section('G IMPORT-SHAPE：形状门报得出具体原因，不被兜底值顶替');
{
  const p = base();
  const bad = parseImport('json', '这根本不是 json');
  const issues = validateNormalized(bad, p);
  const shape = issues.find((i) => i.code === 'IMPORT-SHAPE');
  ok('非法 JSON → IMPORT-SHAPE', Boolean(shape), JSON.stringify(issues.map((i) => i.code)));
  ok('IMPORT-SHAPE 的 message 含真实解析错误（而非空话）', /JSON 解析失败|不是「柜体清单」/.test(shape?.message ?? ''), shape?.message ?? '');
}

// ═══════════════════════ H 未登记错误码直接抛错（issueCatalog 唯一真相源）══════════════════════
section('H 错误码必须登记：未登记码直接抛错，绝不产出无人看得懂的 Issue');
{
  let threw = false;
  try {
    buildIssue('IMPORT-NOT-A-REAL-CODE' as never, { target: 'x', targetKind: 'project' });
  } catch {
    threw = true;
  }
  ok('未登记码 buildIssue 抛错', threw);
  // 反向：已登记的 IMPORT-* 必须能正常产出
  const registered = buildIssue('IMPORT-LOW-CONFIDENCE', { target: 'import', targetKind: 'project', ctx: { count: 2, sources: 'dxf' } });
  ok('已登记的 IMPORT-LOW-CONFIDENCE 正常产出且带数字', registered.code === 'IMPORT-LOW-CONFIDENCE' && /2/.test(registered.message), registered.message);
}

// ═══════════════════════ I 多柜 + 组合引用：ref → 真 id（与 DesignProposal 同链路）══════════════════════
section('I 多柜导入 + 组合：ref 在建成的那一刻换成真 id');
{
  const p = base();
  const bus = new CommandBus(p, rules);
  const room = roomOf(p);
  const before = bus.getState().cabinets.length;
  const json = JSON.stringify({
    title: 'L 型导入',
    room,
    cabinets: [
      { ref: 'a', name: '长臂', width: 1800, height: 2400, depth: 600, units: [{ kind: 'hanging', width: 1800, rodHeight: 1700 }] },
      { ref: 'b', name: '短臂', width: 900, height: 2400, depth: 600, units: [{ kind: 'shelves', width: 900, count: 4 }], rotation: 90 },
    ],
    // kind 按**实际落位**声明为 butt（与 proposal-acceptance §E 同一条理由）：
    // 系统落出来的这两柜是 600mm 的**面接触**（续接），不是只共用角点的角接。
    // P8.2 修掉 edgesFlush 的"点到线段"缺陷后，这里必须照实声明，否则严格模式拒收。
    assemblies: [{ ref: 'g', name: '玄关柜组', members: ['a', 'b'], connections: [{ a: 'a', b: 'b', kind: 'butt' }] }],
  });
  const nd = parseImport('json', json);
  const compiled = compileImport(nd, bus.getState(), rules);
  ok('多柜 + 组合编译成功', compiled.ok, compiled.blockedReason ?? '');
  ok('3 条动作（两柜 + 一组）', compiled.actions.length === 3);
  const memberIds = (compiled.actions[2]!.params as unknown as Record<string, unknown>).memberIds as unknown as string[];
  ok('组合成员还是 $ref 占位（编译期拿不到 id）', memberIds.every((m) => m.startsWith('$ref:')), JSON.stringify(memberIds));

  const run = dryRunPlan({ bus, actions: compiled.actions, gate: null });
  eq('干跑无失败', run.errorCount, 0);
  const outcome = commitPlan(run, bus);
  ok('提交成功', outcome.ok, outcome.ok ? '' : outcome.error);
  eq('真模型多 2 柜', bus.getState().cabinets.length, before + 2);
  const realAsm = (bus.getState().assemblies ?? [])[0];
  ok('组合成员换成真 id（非 $ref 残留）', realAsm ? realAsm.memberIds.every((m) => !m.startsWith('$ref:')) : false, JSON.stringify(realAsm?.memberIds));
  // 两个导入柜都带 origin
  const imported = bus.getState().cabinets.filter((c) => c.origin?.source === 'json');
  eq('两个导入柜都带 origin', imported.length, 2);
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
if (fail > 0) {
  console.log('失败项：\n - ' + failures.join('\n - '));
  process.exit(1);
}
process.exit(0);
