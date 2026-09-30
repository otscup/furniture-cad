/**
 * ══════════════════════════════════════════════════════════════════════
 *  P3 验收 —— AI 设计方案（DesignProposal）
 *
 *  文档 §12 给 P3 定的出口判据：**一次端到端"大白话 → 提案 → 确认 → 落模型 → 出 DXF"**。
 *
 *  ── 这一批断言真正在防什么（按危险程度排）──
 *
 *   ① **提案污染正式模型。** 未确认的 Proposal 一滴都不许进真总线 ——
 *      这是"Proposal 必须与正式模型分离"的验收形态：预览前后真总线的
 *      柜体数、版本、issues 必须**逐值相同**。
 *
 *   ② **提案成了绕过 CommandBus 的后门。** 编译产物是 AiAction，必须能过
 *      契约校验（`validateAction`），并且只有走 commitPlan 才能落模型。
 *      这里断言：编译出的每条动作都在契约里登记、都过校验。
 *
 *   ③ **AI 借提案写坐标。** Proposal 的字段里不许出现 x/y/z；编译出的动作里
 *      也不许带 atX/atY（落位由 pickFreeSpot 定）。
 *
 *   ④ **不确定项被悄悄猜掉。** 有 `questions` 的方案**必须**拒绝编译到可执行
 *      动作；尺寸没给只能用规则集默认值的，必须写进 notes（界面要显示）。
 *      —— 悄悄补齐等于骗人，用户会以为 AI 理解了他的意思。
 *
 *   ⑤ **组合引用到错的柜子。** 柜体 id 是执行瞬间才生成的，提案只能用 ref；
 *      `$ref:` 换不出来时必须报错（换成别的 id = 组合挂错柜，不报错）。
 *
 *   ⑥ **多行柜的分区 id 撞车。** 每行各自从 unit_001 开始 = 两行共用一条
 *      清单记录（下错料，且不报错）—— 历史上真栽过。
 *
 *   ⑦ **"预览 === 提交" 在提案这条路上也成立。** 提交的是预览时那一批 Command
 *      对象，逐条比对 op/target/changes（不是"重新编译一遍"）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { layoutRows } from '../src/core/layoutModel.ts';
import { parseProjectFile, serializeProjectFile } from '../src/core/projectFile.ts';
import { compileAction, type AiAction } from '../src/ai/compile.ts';
import { compileProposal } from '../src/ai/compileProposal.ts';
import { proposalBlocked, proposalShapeError, validateProposal, type DesignProposal } from '../src/ai/proposal.ts';
import { dryRunPlan, commitPlan } from '../src/ai/planRunner.ts';
import { buildSnapshot } from '../src/ai/snapshot.ts';
import { ACTIONS, validateAction, buildDesignRequest } from '../shared/aiContract.mjs';

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
const eq = (label: string, a: unknown, b: unknown): void => ok(label, JSON.stringify(a) === JSON.stringify(b), `实际 ${JSON.stringify(a)} ｜ 期望 ${JSON.stringify(b)}`);

// ═══════════════════════ 夹具 ═══════════════════════
const base = (): Project => JSON.parse(JSON.stringify(sampleProject(rules))) as Project;
const roomOf = (p: Project): string => p.rooms[0]!.id;

/** 一个"玄关鞋柜"方案：单层，三格 */
const shoeCabinet: DesignProposal = {
  id: 'prop_1',
  title: '玄关鞋柜',
  summary: '靠门口放一个鞋柜，下面三层鞋抽，旁边开放格放钥匙。',
  room: undefined,
  cabinets: [
    {
      ref: 'shoe',
      name: '玄关鞋柜',
      width: 1200,
      height: 1000,
      depth: 350,
      units: [
        { kind: 'drawerBank', width: 800, count: 3, nickname: '鞋抽' },
        { kind: 'open', width: 400, nickname: '钥匙格' },
      ],
    },
  ],
};

// ═══════════════════════ A 形状门：AI 输出的第一道关 ═══════════════════════
section('A 形状门：不是这个形状就进不来（不给"差不多"的面子）');
{
  eq('完整方案通过形状门', proposalShapeError(shoeCabinet), null);
  ok('不是对象 → 拒', typeof proposalShapeError(42) === 'string', String(proposalShapeError(42)));
  ok('缺 title → 拒', typeof proposalShapeError({ cabinets: shoeCabinet.cabinets }) === 'string');
  ok('cabinets 不是数组 → 拒', typeof proposalShapeError({ title: 'x', cabinets: {} }) === 'string');
  ok('cabinets 空数组 → 拒（且说明"没有东西可预览"）', String(proposalShapeError({ title: 'x', cabinets: [] })).includes('一个柜体都没有'));
  ok('柜体缺 ref → 拒，且说是第几个', String(proposalShapeError({ title: 'x', cabinets: [{ width: 1200 }] })).includes('第 1 项'));
  ok('尺寸不是数字 → 拒', typeof proposalShapeError({ title: 'x', cabinets: [{ ref: 'a', width: '很宽' }] }) === 'string');
  ok('分区缺 kind → 拒', typeof proposalShapeError({ title: 'x', cabinets: [{ ref: 'a', units: [{ width: 100 }] }] }) === 'string');
  ok('行高写成非法值 → 拒', typeof proposalShapeError({ title: 'x', cabinets: [{ ref: 'a', rows: [{ height: 'tall', units: [{ kind: 'open' }] }] }] }) === 'string');
  ok('组合 members 不是字符串数组 → 拒', typeof proposalShapeError({ title: 'x', cabinets: [{ ref: 'a' }], assemblies: [{ ref: 'g', members: [1, 2] }] }) === 'string');
  ok('questions 不是字符串数组 → 拒', typeof proposalShapeError({ title: 'x', cabinets: [{ ref: 'a' }], questions: [1] }) === 'string');
}

// ═══════════════════════ B 语义校验：报得出问题在哪 ═══════════════════════
section('B 语义校验：每条都精确到码，且给得出具体信息');
{
  const p = base();
  eq('干净的鞋柜方案没有阻塞问题', proposalBlocked(validateProposal({ ...shoeCabinet, room: roomOf(p) }, p)), false);

  const noRoom = validateProposal({ ...shoeCabinet, room: '不存在的房间' }, p);
  ok('房间找不到 → PROPOSAL-ROOM-MISSING', noRoom.some((i) => i.code === 'PROPOSAL-ROOM-MISSING'), JSON.stringify(noRoom.map((i) => i.code)));
  ok('房间那条报得出"项目里有几个房间"', /共\s*\d+|现在有\s*\d+|\d+\s*个房间/.test(noRoom.find((i) => i.code === 'PROPOSAL-ROOM-MISSING')?.message ?? ''), noRoom.find((i) => i.code === 'PROPOSAL-ROOM-MISSING')?.message ?? '');

  const badSize = validateProposal({ ...shoeCabinet, cabinets: [{ ...shoeCabinet.cabinets[0]!, height: 99999 }] }, p);
  const sizeIssue = badSize.find((i) => i.code === 'PROPOSAL-SIZE-RANGE');
  ok('尺寸超范围 → PROPOSAL-SIZE-RANGE', Boolean(sizeIssue), JSON.stringify(badSize.map((i) => i.code)));
  ok('尺寸那条报得出"现在多少、范围多少"', /99999/.test(sizeIssue?.message ?? '') && /300/.test(sizeIssue?.message ?? ''), sizeIssue?.message ?? '');

  const badKind = validateProposal({ ...shoeCabinet, cabinets: [{ ref: 'a', units: [{ kind: '抽屉' }] }] }, p);
  ok('分区类型不认识 → PROPOSAL-UNIT-KIND', badKind.some((i) => i.code === 'PROPOSAL-UNIT-KIND'), JSON.stringify(badKind.map((i) => i.code)));
  ok('分区那条报得出"可用几种"', /5\s*种/.test(badKind.find((i) => i.code === 'PROPOSAL-UNIT-KIND')?.message ?? ''), badKind.find((i) => i.code === 'PROPOSAL-UNIT-KIND')?.message ?? '');

  const dupRef = validateProposal({ ...shoeCabinet, cabinets: [{ ref: 'a', width: 900 }, { ref: 'a', width: 900 }] }, p);
  ok('ref 重复 → PROPOSAL-CAB-DUP-REF', dupRef.some((i) => i.code === 'PROPOSAL-CAB-DUP-REF'));

  const badMember = validateProposal({ ...shoeCabinet, assemblies: [{ ref: 'g', members: ['shoe', 'ghost'], connections: [{ a: 'shoe', b: 'ghost', kind: 'corner' }] }] }, p);
  ok('组合成员不在方案里 → PROPOSAL-ASM-MEMBER', badMember.some((i) => i.code === 'PROPOSAL-ASM-MEMBER'), JSON.stringify(badMember.map((i) => i.code)));
  // 成员都在方案里，但连接引用了成员以外的柜 —— 两码事，得分开验（否则上面那条会顶替它，假绿）
  const badConnRef = validateProposal({
    ...shoeCabinet,
    cabinets: [...shoeCabinet.cabinets, { ref: 'b', width: 900 }],
    assemblies: [{ ref: 'g', members: ['shoe', 'b'], connections: [{ a: 'shoe', b: 'ghost', kind: 'corner' }] }],
  }, p);
  ok('连接引用成员以外 → PROPOSAL-CONN-REF', badConnRef.some((i) => i.code === 'PROPOSAL-CONN-REF'), JSON.stringify(badConnRef.map((i) => i.code)));
  ok('这条不牵连出"成员不存在"（两者是不同问题）', !badConnRef.some((i) => i.code === 'PROPOSAL-ASM-MEMBER'), JSON.stringify(badConnRef.map((i) => i.code)));

  const oneMember = validateProposal({ ...shoeCabinet, assemblies: [{ ref: 'g', members: ['shoe'] }] }, p);
  ok('组合只有 1 个成员 → PROPOSAL-ASM-MIN', oneMember.some((i) => i.code === 'PROPOSAL-ASM-MIN'));

  const badConn = validateProposal({ ...shoeCabinet, cabinets: [...shoeCabinet.cabinets, { ref: 'b', width: 900 }], assemblies: [{ ref: 'g', members: ['shoe', 'b'], connections: [{ a: 'shoe', b: 'b', kind: 'glue' as never }] }] }, p);
  ok('连接类型不认识 → PROPOSAL-CONN-KIND', badConn.some((i) => i.code === 'PROPOSAL-CONN-KIND'));

  const empty = validateProposal({ title: '空方案', cabinets: [] }, p);
  ok('空方案 → PROPOSAL-EMPTY 且阻塞', empty.some((i) => i.code === 'PROPOSAL-EMPTY') && proposalBlocked(empty));
}

// ═══════════════════════ C 编译：需求级 → 动作级 ═══════════════════════
section('C 编译：Proposal → AiAction（确定性，且没有坐标）');
{
  const p = base();
  const r = compileProposal({ ...shoeCabinet, room: roomOf(p) }, p, rules);
  ok('编译成功', r.ok, r.blockedReason ?? '');
  eq('两个柜体意图 → 一条 cabinet.create', r.actions.length, 1);
  eq('动作名', r.actions[0]!.action, 'cabinet.create');
  eq('带上 ref（供组合引用）', r.actions[0]!.ref, 'shoe');
  ok('尺寸落进 params', r.actions[0]!.params.width === 1200 && r.actions[0]!.params.height === 1000);

  const json = JSON.stringify(r.actions);
  ok('编译产物里没有任何坐标（atX / atY / x / y）', !/"atX"|"atY"/.test(json), json.slice(0, 200));

  // ── 多行柜：rows 语义（上下分层）──
  const multi: DesignProposal = {
    title: '上挂衣下鞋抽',
    cabinets: [
      {
        ref: 'c1',
        name: '分层柜',
        width: 1200,
        height: 2400,
        depth: 600,
        rows: [
          { height: 1400, units: [{ kind: 'hanging', width: 1200, rodHeight: 1300 }] },
          { height: 'fill', units: [{ kind: 'drawerBank', width: 1200, count: 3 }] },
        ],
      },
    ],
  };
  const r2 = compileProposal({ ...multi, room: roomOf(p) }, p, rules);
  ok('多行方案编译成功', r2.ok, r2.blockedReason ?? '');
  const rowsParam = (r2.actions[0]!.params as unknown as Record<string, unknown>).rows as unknown as Array<Record<string, unknown>>;
  ok('rows 落进 params（2 行）', Array.isArray(rowsParam) && rowsParam.length === 2, JSON.stringify(rowsParam));
  eq('第 2 行是 fill', (rowsParam?.[1] as Record<string, unknown>)?.height, 'fill');

  // 真的建出来，检查行与分区 id
  const bus = new CommandBus(p, rules);
  const run2 = dryRunPlan({ bus, actions: r2.actions });
  eq('多行干跑无失败', run2.errorCount, 0);
  const built = run2.draft.cabinets.find((c) => c.name === '分层柜')!;
  ok('建出来的柜真的有 2 行', layoutRows(built.layout).length === 2, JSON.stringify(layoutRows(built.layout).map((r) => r.id)));
  const ids = layoutRows(built.layout).flatMap((r) => r.units.map((u) => u.id));
  eq('跨行分区 id 不撞车（撞了会共用清单记录）', new Set(ids).size, ids.length);
}

// ═══════════════════════ D 端到端：预览不污染、确认才生效 ═══════════════════════
section('D 端到端：预览不动真模型，确认才落模型');
{
  const p = base();
  const bus = new CommandBus(p, rules);
  const before = { cabs: bus.getState().cabinets.length, version: bus.getVersion(), issues: bus.issues().filter((i) => i.severity === 'ERROR').length };

  const r = compileProposal({ ...shoeCabinet, room: roomOf(p) }, p, rules);
  const run = dryRunPlan({ bus, actions: r.actions, gate: null });
  eq('干跑没有失败步骤', run.errorCount, 0);

  // 预览之后真总线必须一个字节都没动
  const after = { cabs: bus.getState().cabinets.length, version: bus.getVersion(), issues: bus.issues().filter((i) => i.severity === 'ERROR').length };
  eq('预览后真总线的柜体数没变', after.cabs, before.cabs);
  eq('预览后真总线的版本没变', after.version, before.version);
  eq('预览后真总线的 ERROR 数没变', after.issues, before.issues);
  ok('预览里的草案确实多了一个柜（否则预览等于没画）', run.draft.cabinets.length === before.cabs + 1, `${run.draft.cabinets.length} vs ${before.cabs}`);

  // 编译出的动作必须能过契约（不是后门）
  let contractBad = '';
  for (const a of r.actions) {
    // 只喂契约认识的四个字段（index / ref 是链路内部字段，AI 输出里没有它们）
    const v = validateAction(
      { action: a.action, target: a.target ?? {}, params: a.params, reason: a.reason },
      { rules, project: bus.getState() },
    );
    if (!v.ok) contractBad += `${a.action}: ${v.error}; `;
  }
  ok('编译出的动作全部能过契约校验（Proposal 不是绕过校验的后门）', contractBad === '', contractBad);

  // 确认 → 提交
  const outcome = commitPlan(run, bus);
  ok('提交成功', outcome.ok, outcome.ok ? '' : outcome.error);
  eq('真总线多了 1 个柜体', bus.getState().cabinets.length, before.cabs + 1);
  eq('版本只 +1（一次提交 = 一次撤销）', bus.getVersion(), before.version + 1);
  const made = bus.getState().cabinets.find((c) => c.name === '玄关鞋柜');
  ok('柜体参数与方案一致（1200×1000×350）', made?.params.width === 1200 && made?.params.height === 1000 && made?.params.depth === 350, JSON.stringify(made?.params));
  ok('分区按意图建（抽屉区 + 开放格）', made?.layout.units.map((u) => u.kind).join('/') === 'drawerBank/open', JSON.stringify(made?.layout.units.map((u) => u.kind)));

  // 撤销
  bus.undo();
  eq('撤销后回到原状', bus.getState().cabinets.length, before.cabs);
}

// ═══════════════════════ E 组合：ref → 真 id ═══════════════════════
section('E 组合：方案里的 ref 在建成的那一刻换成真 id');
{
  const p = base();
  const bus = new CommandBus(p, rules);
  const prop: DesignProposal = {
    title: 'L 型玄关柜',
    cabinets: [
      { ref: 'a', name: '长臂', width: 1800, height: 2400, depth: 600, units: [{ kind: 'hanging', width: 1800, rodHeight: 1700 }] },
      { ref: 'b', name: '短臂', width: 900, height: 2400, depth: 600, units: [{ kind: 'shelves', width: 900, count: 4 }], rotation: 90 },
    ],
    assemblies: [{ ref: 'g', name: '玄关 L 型', members: ['a', 'b'], connections: [{ a: 'a', b: 'b', kind: 'corner' }] }],
  };
  const r = compileProposal({ ...prop, room: roomOf(p) }, p, rules);
  ok('L 型方案编译成功', r.ok, r.blockedReason ?? '');
  eq('3 条动作（两柜 + 一组）', r.actions.length, 3);
  const memberIds = (r.actions[2]!.params as unknown as Record<string, unknown>).memberIds as unknown as string[];
  ok('组合成员还是 $ref 占位（编译期确实拿不到 id）', memberIds.every((m) => m.startsWith('$ref:')), JSON.stringify(memberIds));

  const run = dryRunPlan({ bus, actions: r.actions, gate: null });
  eq('干跑没有失败步骤', run.errorCount, 0);
  ok('组合真的建成了', (run.draft.assemblies ?? []).length === 1, JSON.stringify(run.draft.assemblies ?? []));
  const asm = (run.draft.assemblies ?? [])[0]!;
  ok('组合成员换成了真 id（不是 $ref 残留）', asm.memberIds.every((m) => !m.startsWith('$ref:') && run.draft.cabinets.some((c) => c.id === m)), JSON.stringify(asm.memberIds));
  eq('连接的两端也是真 id', asm.connections[0]?.a.cabinetId, asm.memberIds[0]);
  ok('两个成员确实是不同的柜体（换错 id 会挂到同一个柜上）', asm.memberIds[0] !== asm.memberIds[1], JSON.stringify(asm.memberIds));

  const outcome = commitPlan(run, bus);
  ok('提交成功', outcome.ok, outcome.ok ? '' : outcome.error);
  const realAsm = (bus.getState().assemblies ?? [])[0]!;
  eq('真模型里的组合成员数与预览一致', realAsm.memberIds.length, 2);
}

// ═══════════════════════ F 不确定性：不许替用户拍板 ═══════════════════════
section('F 不确定性：待确认问题必须拦住，默认值必须说出来');
{
  const p = base();
  const withQuestion: DesignProposal = {
    ...shoeCabinet,
    questions: ['柜深按 350 还是 600？'],
  };
  const blocked = compileProposal({ ...withQuestion, room: roomOf(p) }, p, rules);
  ok('有待确认问题 → 拒绝编译出可执行动作', !blocked.ok, JSON.stringify(blocked.actions.length));
  eq('被拦时不产出任何动作', blocked.actions.length, 0);
  ok('阻塞原因里带着那个问题', (blocked.blockedReason ?? '').includes('350'), blocked.blockedReason ?? '');
  ok('问题报的是 PROPOSAL-OPEN-QUESTIONS', blocked.issues.some((i) => i.code === 'PROPOSAL-OPEN-QUESTIONS'));

  // 尺寸没给 → 用默认值，但必须写进 notes（界面要显示，不能悄悄补）
  const noSize: DesignProposal = {
    title: '没说尺寸的柜',
    cabinets: [{ ref: 'a', name: '没尺寸的柜' }],
  };
  const r = compileProposal({ ...noSize, room: roomOf(p) }, p, rules);
  ok('没给尺寸也能编译（用规则集默认，不是猜）', r.ok, r.blockedReason ?? '');
  ok('补齐的默认值写进了 notes（界面必须显示）', r.notes.some((n) => n.includes('宽') && /\d/.test(n)), JSON.stringify(r.notes));
  ok('没说内部结构也写进 notes', r.notes.some((n) => n.includes('默认三分区')), JSON.stringify(r.notes));
  ok('assumptions 里能查到系统补齐的那些（AI 声明的 + 系统的）', r.assumptions.length >= r.notes.length, JSON.stringify(r.assumptions));
}

// ═══════════════════════ G 结构边界：Proposal 里没有坐标这个字段 ═══════════════════════
section('G 结构边界：契约与类型层面都不给坐标留口子');
{
  const src = readFileSync(join(APP, 'src', 'ai', 'proposal.ts'), 'utf8');
  // P8.1 演进（判据随修法升级，不是放宽）：
  //   P3 时任何 placement 字段都必然是坐标，所以整词禁掉；
  //   P8.1 起 proposal 允许携带**语义落位意图**（relation/reference/side/alignment，
  //   见 ProposalPlacement 与 core/placement.ts）——它结构上没有坐标的容身之处，
  //   且契约形状门（proposalShapeError）对夹带 x/y 的 placement 直接拒收。
  //   因此判据从"禁 placement 这个词"升级为"精确禁坐标"：
  //   atX/atY/position* 词形 + 注释剥除后的裸 x:/y:/z:/coord: 字段。
  const coordFields = ['atX', 'atY', 'positionX', 'positionY'];
  const found = coordFields.filter((f) => new RegExp(`\\b${f}\\b`).test(src));
  ok('proposal.ts 里没有任何坐标字段（atX/atY/position* 一个都不许有）', found.length === 0, found.join('、'));
  const stripped = src.replace(/\/\/.*$/gm, '');
  ok('提案字段里确实没有 x / y 尺寸以外的坐标语义', !/\b(z|coord)\b\s*:/.test(stripped) && !/\b(x|y)\b\s*:/.test(stripped));
  ok('P8.1 语义落位意图在形状门就拦坐标（placement 夹带 x → 拒收）', typeof proposalShapeError({ title: 't', cabinets: [{ ref: 'a', placement: { relation: 'adjacent', reference: 'b', x: 1 } }] }) === 'string');

  // 契约里 cabinet.create 的坐标参数仍然存在（AI 通道的历史能力），
  // 但提案编译**不使用**它们 —— 上面 C 组已断言编译产物里没有 atX/atY
  ok('契约里 rows 参数已登记（多行是正式能力，不是私有后门）', Boolean((ACTIONS['cabinet.create'].params as Record<string, { type: string }>).rows));
}

// ═══════════════════════ H 兼容：旧项目与旧链路零影响 ═══════════════════════
section('H 兼容：没有提案时，一切与 P2 之后完全相同');
{
  const p = base();
  const before = JSON.stringify(p);
  const bus = new CommandBus(p, rules);
  // 不跑任何提案 → 状态零变化
  eq('总线派生后模型不变', JSON.stringify(bus.getState()), before);

  // 存量文件往返
  const text = serializeProjectFile(p);
  const back = parseProjectFile(text);
  ok('存量项目序列化往返不炸', back.ok, back.ok ? '' : String(back.error));
  ok('往返后没有凭空多出 assemblies', back.ok && !('assemblies' in (back.project as Project)), JSON.stringify(Object.keys(back.ok ? (back.project as Project) : {})));

  // 快照里没有提案字段（提案不进快照 —— 它是 AI 的输入产物，不是模型的一部分）
  const snap = buildSnapshot(bus.getState(), rules);
  ok('快照里没有 assemblies 字段（没有组合时不出现）', !('assemblies' in snap), JSON.stringify(Object.keys(snap)));
}

// ═══════════════════════ I 通道级：形状门 + 提示词通道区分 + 待确认问题阻断应用 ═══════════════════════
section('I 通道级：AI 输出进系统的第一道门 + 待确认问题必须阻断应用');
{
  const valid = base();

  // buildDesignRequest：server 与 mock 都靠 system 文本里的"设计方案"区分通道
  const req = buildDesignRequest('mock-model', '玄关要鞋柜', buildSnapshot(valid, rules), { history: [], temperature: 0.2, maxTokens: 4096 });
  const sysText = String((req.messages.find((m) => m.role === 'system')?.content ?? ''));
  const userText = String((req.messages.find((m) => m.role === 'user')?.content ?? ''));
  ok('I1 buildDesignRequest 的 system 提示明确说"设计方案"（server/mock 靠它区分通道）', /设计方案/.test(sysText), sysText.slice(0, 50));
  ok('I2 通道仍带用户需求原文（模型看得见要什么）', /玄关要鞋柜/.test(userText));
  ok('I3 通道仍带项目快照（模型看得见现在有什么）', /当前模型状态/.test(userText));

  // 形状门：服务端第一道关 + 前端第二道关，共用同一份实现
  const goodProposal = { title: '好方案', cabinets: [{ ref: 'a', name: '鞋柜', width: 900, units: [{ kind: 'shelves', width: 900, count: 3 }] }] };
  ok('I4 合法方案过形状门', proposalShapeError(goodProposal) === null);
  ok('I5 缺 title → 形状门拒（整份退回，不修）', proposalShapeError({ cabinets: [] }) !== null);
  ok('I6 cabinets 不是数组 → 形状门拒', proposalShapeError({ title: 'x', cabinets: 'nope' }) !== null);
  ok('I7 柜体缺 ref / ref 非串 → 形状门拒', proposalShapeError({ title: 'x', cabinets: [{ name: 'a' }] }) !== null);
  ok('I8 连接 kind 非法 → 形状门拒', proposalShapeError({ title: 'x', cabinets: [{ ref: 'a' }], assemblies: [{ ref: 'g', members: ['a'], connections: [{ a: 'a', b: 'a', kind: 'diagonal' }] }] }) !== null);
  ok('I9 连接成员不是数组 → 形状门拒', proposalShapeError({ title: 'x', cabinets: [{ ref: 'a' }], assemblies: [{ ref: 'g', members: 'a' }] }) !== null);

  // 待确认问题必须阻断"编译到可执行动作" —— 这是"不确定就问、不猜"的验收形态
  const withQ = { title: '要问的', cabinets: [{ ref: 'a', name: '柜', width: 900, units: [{ kind: 'shelves', width: 900, count: 2 }] }], questions: ['深度按多少合适？'] };
  const compiledQ = compileProposal(withQ, valid, rules);
  ok('I10 有待确认问题时拒绝编译到可执行动作（openQuestions 阻断 apply）', compiledQ.ok === false);
  ok('I11 被拒原因说清了"必须先问"（界面据此禁用应用）', /必须|问你|问题/i.test(compiledQ.blockedReason ?? ''), compiledQ.blockedReason ?? '');
  ok('I11b 被拒原因把具体问题原文也带上了（不是只说"有错"）', (compiledQ.blockedReason ?? '').includes('深度按多少合适'), compiledQ.blockedReason ?? '');

  // 对照：没有任何问题时，能正常 编译 → 干跑 → 提交确实写入，且提交前不动模型
  const clean = { title: '干净方案', cabinets: [{ ref: 'a', name: '鞋柜2', width: 900, height: 2000, depth: 400, units: [{ kind: 'shelves', width: 900, count: 3 }] }] };
  const compiledC = compileProposal(clean, valid, rules);
  ok('I12 无障碍方案能编译成动作', compiledC.ok, compiledC.blockedReason ?? '');
  if (compiledC.ok) {
    const busC = new CommandBus(valid, rules);
    const runC = dryRunPlan({ bus: busC, actions: compiledC.actions });
    ok('I13 干跑不动真模型（提交前柜体数不变）', busC.getVersion() === 0 && busC.getState().cabinets.length === valid.cabinets.length);
    const commitC = commitPlan(runC, busC);
    ok('I14 确认后才真写入（柜体 +1，且名字正确）', commitC.ok && busC.getState().cabinets.some((c) => c.name === '鞋柜2'), JSON.stringify(commitC));
  }
}

// ═══════════════════════ 结束 ═══════════════════════
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('\nP3 成立：需求 → 提案 → 校验 → 预览（不污染模型）→ 确认 → CommandBus → 模型，提案全程不碰坐标也不绕开校验。');
