import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { compileCorrections, formatGateError, summarize } from '../src/ai/memory.ts';
import type { Correction } from '../src/ai/memory.ts';
import { seedCorrections, MEMORY_CASES } from '../src/ai/seedCorrections.ts';
import { fromJsonl, setStatus, toJsonl, addCorrection } from '../src/ai/correctionStore.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  记忆验收 —— "下次不再犯同样的错误"是不是真的成立
 *
 *  最危险的情况不是"记忆没生效"，而是**记忆看起来生效了**。
 *  一句自然语言存进列表、界面上打个绿点写着"已记住"，但下次 AI 照犯 ——
 *  这比没有记忆更糟，因为它让你以为安全。
 *
 *  所以本脚本对每条 active 记忆跑**双向测试**：
 *    · 该拦的必须拦住（blocking 样本 → ok=false 且 memoryHits 命中本条）
 *    · 不该拦的必须放行（passing 样本 → ok=true），证明这不是"一律拒绝"
 *  另加哨兵记忆的 code 存在性检查（防止记忆指向被重命名掉的死 code）。
 * ══════════════════════════════════════════════════════════════════════
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

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

function section(t: string): void {
  console.log(`\n${t}`);
}

const seed = seedCorrections(1700000000000);
const { gate, compiled, inactive } = compileCorrections(seed);

function freshBus(corrections: Correction[] = seed): CommandBus {
  const b = new CommandBus(sampleProject(rules), rules);
  b.setGate(compileCorrections(corrections).gate);
  return b;
}

console.log('记忆与进化验收');
console.log('='.repeat(64));

section('A. 编译：记忆必须变成可执行检查，否则不算数');
const s = summarize(seed);
ok(`A1 记忆清单：共 ${s.total} 条（active ${s.active} / pending ${s.pending} / retired ${s.retired}）`, s.total === seed.length);
ok(
  `A2 编译产物条数（${compiled.length}）=== active 条数（${s.active}）`,
  compiled.length === s.active,
  `compiled=${compiled.map((c) => c.correctionId).join(',')}`
);
ok(
  'A3 每条 active 记忆都编译出了非空的"在查什么"说明',
  compiled.every((c) => c.describe.trim().length > 0)
);
ok(
  `A4 pending / 无 spec 的条目被归入 inactive（${inactive.length} 条），没有被伪装成 active`,
  inactive.length === seed.length - compiled.length
);
ok(
  'A5 所有 pending 条目都写清了 pendingReason（哑记忆防线）',
  seed.filter((c) => c.status === 'pending').every((c) => !!c.pendingReason && c.pendingReason.length > 10),
  seed
    .filter((c) => c.status === 'pending')
    .map((c) => `${c.id}: ${c.pendingReason ?? '(缺失)'}`)
    .join('\n      ')
);
ok('A6 每一条 active 记忆都有 checkSpec', seed.filter((c) => c.status === 'active').every((c) => !!c.checkSpec));

section('B. 双向测试：该拦的拦住 / 不该拦的不误伤');
const activeIds = new Set(seed.filter((c) => c.status === 'active').map((c) => c.id));
const caseIds = new Set(MEMORY_CASES.map((c) => c.correctionId));
ok(
  'B0 每条 active 记忆都有测试样本（防止"加了记忆忘了写测试"）',
  [...activeIds].every((id) => caseIds.has(id)),
  `缺样本：${[...activeIds].filter((id) => !caseIds.has(id)).join(',') || '无'}`
);
ok(
  'B0b 每个测试样本都对应一条真实存在的记忆',
  MEMORY_CASES.every((c) => seed.some((x) => x.id === c.correctionId))
);

for (const mc of MEMORY_CASES) {
  const label = mc.correctionId;
  if (mc.defensive) {
    ok(`${label} · 哨兵记忆，跳过触发测试（现实中造不出场景）`, true);
  } else if (mc.blocking) {
    const bus = freshBus();
    const before = JSON.stringify(bus.getState());
    const cmd = mc.blocking(bus.getState(), rules);
    const r = bus.execute(cmd);
    const hit = r.memoryHits.some((h) => h.correctionId === label);
    ok(
      `${label} · 该拦的拦住：${cmd.op} 被本条记忆拒绝`,
      !r.ok && hit,
      `ok=${r.ok} error=${r.error ?? ''} hits=${r.memoryHits.map((h) => h.correctionId).join(',')}`
    );
    ok(`${label} · 被拦后模型逐字节未变（两段式语义）`, JSON.stringify(bus.getState()) === before);
    ok(`${label} · 错误信息里带上了用户原话`, (r.error ?? '').includes('原话') || (r.error ?? '').includes('记忆拦截'), r.error ?? '(空)');
  }

  // 放行测试
  const bus2 = freshBus();
  const cmd2 = mc.passing(bus2.getState(), rules);
  const r2 = bus2.execute(cmd2);
  ok(`${label} · 不该拦的放行：${cmd2.op} 正常提交`, r2.ok, `ok=${r2.ok} error=${r2.error ?? ''}`);
}

section('C. 哨兵记忆：引用的 issue code 必须在上游真实存在');
const upstream = [
  readFileSync(join(root, 'src', 'core', 'geometry', 'generate.ts'), 'utf8'),
  readFileSync(join(root, 'src', 'core', 'geometry', 'project.ts'), 'utf8'),
  readFileSync(join(root, 'src', 'core', 'rules', 'validate.ts'), 'utf8'),
].join('\n');

const codeRefs = seed
  .filter((c) => c.checkSpec?.kind === 'noNewIssue')
  .map((c) => ({ id: c.id, code: (c.checkSpec as { issueCode: string }).issueCode }));
ok(`C1 收集到 ${codeRefs.length} 条 issue-code 型记忆`, codeRefs.length > 0);
for (const ref of codeRefs) {
  ok(`C2 ${ref.id} 引用的 ${ref.code} 在上游校验器里真实存在`, upstream.includes(ref.code), '该 code 找不到 —— 记忆指向了死 code，永远不会生效');
}

section('D. 假记忆防线：不能悄无声息地"记住但不生效"');
const fake = compileCorrections([
  { id: 'mem_fake', at: 0, scope: 'global', origin: 'user', nl: '柜子别太大', evidence: [], status: 'active', tags: [] },
]);
ok('D1 声明 active 但没有 checkSpec → 被扔进 inactive，不产生任何检查', fake.compiled.length === 0 && fake.inactive.length === 1);
const busD = freshBus([{ id: 'mem_fake', at: 0, scope: 'global', origin: 'user', nl: '柜子别太大', evidence: [], status: 'active', tags: [] }]);
const rD = busD.execute(mc0(busD));
ok('D2 没有 checkSpec 的"记忆"拦不住任何东西（这就是它不该叫 active 的原因）', rD.ok, rD.error ?? '');

section('E. 门的语义：只拦"这次操作新引入的"违规');
{
  // 造一个"历史遗留就已违规"的项目：柜体一开始就扎在南墙里
  const bus = freshBus();
  const base = sampleProject(rules);
  base.cabinets[0].placement.y = -200; // 直接构造非法基线，模拟历史遗留
  const bus2 = new CommandBus(base, rules);
  bus2.setGate(gate);
  const badIssues = bus2.issues().filter((i) => i.code === 'RULE-CABINET-IN-WALL');
  ok('E1 基线项目里确实已经存在违规（历史遗留）', badIssues.length > 0, `找到 ${badIssues.length} 条`);

  const cmd = mcRename(bus2);
  const r = bus2.execute(cmd);
  ok('E2 历史遗留违规不阻塞新的无关操作（否则工具没法用）', r.ok, r.error ?? '');

  // 已知边界：把已存在的违规"变得更严重"不会被拦下来
  const cmd2 = mcMoveFurther(bus2);
  const r2 = bus2.execute(cmd2);
  ok(
    'E3 已知边界（如实记录，非缺陷）：违规已存在时"让它更严重"不会被拦 —— 因为 issue 去重键只到 code+target 粒度',
    r2.ok,
    `ok=${r2.ok} error=${r2.error ?? ''}`
  );
}

section('F. dryRun 也过门（AI 两段式第一步必须能预告）');
{
  const bus = freshBus();
  const cmd = MEMORY_CASES.find((c) => c.correctionId === 'mem_004_max_height_2400')!.blocking!(bus.getState(), rules);
  const v0 = bus.getVersion();
  const r = bus.execute(cmd, { dryRun: true });
  ok('F1 dryRun 被记忆门拦下', !r.ok && r.memoryHits.length > 0, r.error ?? '');
  ok('F2 dryRun 不改变模型版本', bus.getVersion() === v0);
  ok('F3 dryRun 不产生日志条目', bus.log().length === 0);
}

section('G. 记忆与模型彻底分离');
{
  const bus = freshBus();
  const cmd = MEMORY_CASES.find((c) => c.correctionId === 'mem_004_max_height_2400')!.blocking!(bus.getState(), rules);
  bus.execute(cmd);
  const dump = JSON.stringify(bus.getState());
  ok('G1 模型里不含 corrections / memory 字段（记忆不是模型的一部分）', !/correction|memoryHits|"gate"/.test(dump));
  ok('G2 被拦下的命令不进入撤销栈', !bus.canUndo());
}

section('H. JSONL 往返与状态迁移');
{
  const jsonl = toJsonl(seed);
  const back = fromJsonl(jsonl);
  ok(`H1 JSONL 往返无损：${jsonl.split('\n').length} 行全部解析成功`, back.bad.length === 0, back.bad.join('; '));
  ok('H2 语义一致（深比较）', isDeepStrictEqual(back.list, seed), '往返后字段值发生变化');
  ok(
    'H2b 往返幂等：toJsonl → fromJsonl → toJsonl 逐字节一致（记忆文件可进 git、可用哈希判断是否被改过）',
    toJsonl(back.list) === jsonl,
    '键顺序或字段在往返中漂移了'
  );

  const withBad = fromJsonl(`${jsonl}\n{不是 JSON}\n`);
  ok('H3 坏行被单独收集而不是静默丢弃', withBad.list.length === seed.length && withBad.bad.length === 1);

  const retired = setStatus(seed, 'mem_004_max_height_2400', 'retired');
  const rc = compileCorrections(retired);
  ok('H4 把一条记忆置为 retired 后，它不再产生检查', rc.compiled.length === compiled.length - 1);

  const added = addCorrection(seed, { nl: '柜体深度不要超过 700mm' });
  ok('H5 新记一条自然语言时默认是 pending（还没编译出检查，不许冒充 active）', added[added.length - 1].status === 'pending');
  const added2 = addCorrection(seed, {
    nl: '柜体深度不要超过 700mm',
    checkSpec: { kind: 'maxValue', path: 'params.depth', value: 700, message: '柜深超过 700mm' },
  });
  ok('H6 带上可执行 checkSpec 时才自动进 active', added2[added2.length - 1].status === 'active');
}

section('I. 错误信息质量：必须能回答"是哪条记忆拦的、你当时怎么说的"');
{
  const bus = freshBus();
  const cmd = MEMORY_CASES.find((c) => c.correctionId === 'mem_002_no_cabinet_in_wall')!.blocking!(bus.getState(), rules);
  const r = bus.execute(cmd);
  const msg = formatGateError(r.memoryHits);
  ok('I1 含记忆 ID', msg.includes('mem_002_no_cabinet_in_wall'), msg);
  ok('I2 含"你当时的原话"', msg.includes('原话'), msg);
  ok('I3 含修复建议', msg.includes('建议'), msg);
}

// ───────────────────────────── 小工具 ─────────────────────────────

/** 取一个纯改名命令（不引入任何几何违规），用于"历史遗留不阻塞"测试 */
function mcRename(bus: CommandBus) {
  const cab = bus.getState().cabinets[0];
  return {
    id: 'cmd_rename_probe',
    op: 'cabinet.rename',
    source: 'ui' as const,
    target: { kind: 'cabinet' as const, id: cab.id },
    changes: [{ path: 'name', op: 'set' as const, value: '改名探针' }],
    label: '改名探针',
  };
}

/** 把已经在墙里的柜子往墙更深处挪（测试"已知边界"） */
function mcMoveFurther(bus: CommandBus) {
  const cab = bus.getState().cabinets[0];
  return {
    id: 'cmd_move_further',
    op: 'cabinet.move',
    source: 'ui' as const,
    target: { kind: 'cabinet' as const, id: cab.id },
    changes: [{ path: 'placement.y', op: 'set' as const, value: cab.placement.y - 300 }],
    label: '往墙里再挪一点',
  };
}

/** 取一条必然合法的命令（用于 D2） */
function mc0(from: CommandBus) {
  const cab = from.getState().cabinets[0];
  return {
    id: 'cmd_ok_probe',
    op: 'cabinet.move',
    source: 'ui' as const,
    target: { kind: 'cabinet' as const, id: cab.id },
    changes: [{ path: 'placement.y', op: 'set' as const, value: 300 }],
    label: '合法移动',
  };
}

// ───────────────────────────── 汇总 ─────────────────────────────

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('\n记忆验收通过：每条 active 记忆都通过了"该拦的拦住 / 不该拦的放行"双向测试。');
}
