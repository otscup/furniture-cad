/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.9 · 变异验收（M1–M17）—— 证明"验收不是假的"
 *
 *  ── 它做什么 ──
 *    对每一项：**把源码改回"出错状态"** → 跑 `candidate-explanation-acceptance.ts` →
 *    要求它**跑完且判红**（≠ 崩溃）→ `finally` 从磁盘还原原始字节。
 *
 *  ── 判红标准（★ 与"测试通过"同样重要）──
 *    必须出现汇总行 `P9.9 Explanation & Selection 验收：通过 N / 失败 M` 且 `M > 0`。
 *    只看 exit code 是错的：**崩溃（未捕获异常）也返回 1**，那说明变异本身写坏了，
 *    不代表"断言抓到了 bug" —— 那种"红"没有意义。
 *
 *  ── 纪律 ──
 *    · 锚点必须落**实码**（不能只落在头注释：注释会被 `stripComments` 剥掉 ⇒ 假绿）；
 *    · 每个锚点在目标文件里必须**唯一命中**（找不到就判这条变异失败，不静默跳过）；
 *    · 源码是 CRLF：先在归一化行尾的副本上匹配/替换，还原时写回**原始字节**；
 *    · 变异**永不进仓库**：所有写操作都在 finally 里还原，且启动时先扫残留。
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');

const EXPLAIN = join(APP, 'src', 'core', 'candidateLayout', 'explain.ts');
const LOGIC = join(APP, 'src', 'ui', 'panels', 'candidateCompareLogic.ts');
const AIPANEL = join(APP, 'src', 'ui', 'panels', 'AIPanel.tsx');
const PROPOSAL = join(APP, 'src', 'ai', 'proposal.ts');
const COMPILE = join(APP, 'src', 'ai', 'compileProposal.ts');

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
function section(t: string): void {
  console.log(`\n【${t}】`);
}

/** 跑一次验收（child）：返回 {completed, failedCount, out} */
function runAcceptance(): Promise<{ completed: boolean; failedCount: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--experimental-strip-types', join(here, 'candidate-explanation-acceptance.ts')], { cwd: APP });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (out += d));
    p.on('error', (e) => (out += String(e)));
    p.on('close', () => {
      // 判据：**跑完且判红**。汇总行的存在 = 真的跑完了（不是崩在 import 阶段）。
      const m = out.match(/P9\.9 Explanation & Selection 验收：通过 (\d+) \/ 失败 (\d+)/);
      resolve({ completed: m !== null, failedCount: m ? Number(m[2]) : -1, out });
    });
  });
}

interface Mutant {
  id: string;
  /** 变异意图（人话） */
  what: string;
  file: string;
  from: string;
  to: string;
  /** 期望抓住它的断言（说明用；不参与判定） */
  expect: string;
}

const MUTANTS: Mutant[] = [
  {
    id: 'M1',
    what: '解释层引入判定层（detectCollisions）',
    file: EXPLAIN,
    from: "import type { CandidateLayout, CandidateUnresolved } from './model.ts';",
    to: "import type { CandidateLayout, CandidateUnresolved } from './model.ts';\n// 变异：解释层碰判定层\nconst __mutForbidden1 = typeof detectCollisions === 'undefined' ? '' : 'detectCollisions';",
    expect: 'A1（不 import 判定层的源码扫描）',
  },
  {
    id: 'M2',
    what: 'status 自己从 components 反推（绕过 score.status）',
    file: EXPLAIN,
    from: '    status: score.status,',
    to: "    status: score.components.some((c) => c.hit === 'no') ? 'infeasible' : 'valid',",
    expect: 'A3 / A3b',
  },
  {
    id: 'M3',
    what: '把 hit:unknown 写成"未满足"',
    file: EXPLAIN,
    from: '  if (hitUnknown > 0) parts.push(`、${hitUnknown} 条判不出来`);',
    to: '  if (hitUnknown > 0) parts.push(`、${hitUnknown} 条未满足`);',
    expect: 'D12b / D13',
  },
  {
    id: 'M4',
    what: '把生成期 satisfies 信号混进 items（冒充事实项）',
    file: EXPLAIN,
    from: '    items: [],\n    generatorSignals: (p.satisfies ?? []).map((s) => ({ goal: s.goal, ok: s.ok })),',
    to: "    items: (p.satisfies ?? []).map((s) => ({ code: `sig:${s.goal}`, kind: 'condition' as const, source: 'rule' as const, hit: (s.ok ? 'yes' : 'no') as const, label: s.goal, why: '变异' })),\n    generatorSignals: (p.satisfies ?? []).map((s) => ({ goal: s.goal, ok: s.ok })),",
    expect: 'A5 / C10c',
  },
  {
    id: 'M5',
    what: 'summaryZh 里标"最佳"（措辞层面造 winner）',
    file: EXPLAIN,
    from: '  parts.push(`候选「${e.candidateId}」：${STATUS_ZH[e.status]}`);',
    to: '  parts.push(`候选「${e.candidateId}」：${STATUS_ZH[e.status]}（最佳）`);',
    expect: 'B8',
  },
  {
    id: 'M6',
    what: '正则解析 generationNotes 后重组',
    file: EXPLAIN,
    from: '    generationNotes: layout.explanations, // ★ 原样引用（A6：逐字节相同）',
    to: "    generationNotes: layout.explanations.map((s) => s.match(/搜索族：(.*)/)?.[1] ?? s),",
    expect: 'A6（逐字节）+ A6b（源码无 .match）',
  },
  {
    id: 'M7',
    what: 'resolveSelection 只看 id 不看内容键（退化成现状 bug）',
    file: LOGIC,
    from: '  if (key !== stored.key) return null; // 内容变了 ⇒ 失效，不回退',
    to: '  // 变异：只看 id',
    expect: 'F17',
  },
  {
    id: 'M8',
    what: 'selection 失配时静默回退到第一条（而不是清除）',
    file: LOGIC,
    from: '  if (!c) return null;',
    to: '  if (!c) return { candidateId: plan.candidates[0]!.id, key: candidateKey(plan.candidates[0]!) };',
    expect: 'F17b',
  },
  {
    id: 'M9',
    what: 'previewCandidate 改读 selectedCandidate（选中变指令）',
    file: AIPANEL,
    from: '      const layout = plan0.candidates.find((c) => c.id === candidateId);',
    to: '      const layout = plan0.candidates.find((c) => c.id === (selectedCandidate?.candidateId ?? candidateId));',
    expect: 'F22',
  },
  {
    id: 'M10',
    what: '解释层把偏好自己再判一次（碰 Resolver）',
    file: EXPLAIN,
    from: "import type { CandidateLayout, CandidateUnresolved } from './model.ts';",
    to: "import type { CandidateLayout, CandidateUnresolved } from './model.ts';\n// 变异：解释层碰 Resolver\nconst __mutForbidden2 = typeof resolveKnowledge === 'undefined' ? '' : 'resolveKnowledge';",
    expect: 'A1（不 import 判定层的源码扫描）',
  },
  {
    id: 'M11',
    what: '多柜候选把所有 items 塞进第一个 placement（不按柜归因）',
    file: EXPLAIN,
    from: '    if (block) block.items.push(item);\n    else crossCutting.push(item);',
    to: '    placements[0]!.items.push(item);',
    expect: 'E14b / E16',
  },
  {
    id: 'M12',
    what: '房间级 unavailable 被硬塞进某只柜',
    file: EXPLAIN,
    from: "    const targetId = c.kind === 'preference' && c.preferenceId !== undefined ? prefCabinet.get(c.preferenceId) : undefined;",
    to: "    const targetId = c.kind === 'preference' && c.preferenceId !== undefined ? prefCabinet.get(c.preferenceId) : (c.kind === 'unavailable' ? placements[0]?.targetId : undefined);",
    expect: 'E16',
  },
  {
    id: 'M13',
    what: '解释对象里悄悄长出 rank 字段',
    file: EXPLAIN,
    from: "    codes,\n    summaryZh: '',",
    to: "    codes,\n    rank: 0,\n    summaryZh: '',",
    expect: 'B7（键集）',
  },
  {
    id: 'M14',
    what: '解释层碰持久化（serializeProjectFile）',
    file: EXPLAIN,
    from: "import type { CandidateLayout, CandidateUnresolved } from './model.ts';",
    to: "import type { CandidateLayout, CandidateUnresolved } from './model.ts';\n// 变异：解释层碰持久化\nconst __mutForbidden3 = typeof serializeProjectFile === 'undefined' ? '' : 'serializeProjectFile';",
    expect: 'G23',
  },
  {
    id: 'M15',
    what: 'items 里带出坐标（resolved.x/y）',
    file: EXPLAIN,
    from: '    code: c.id,',
    to: '    resolved: { x: 0, y: 0, rotation: 0 },\n    code: c.id,',
    expect: 'G24',
  },
  {
    id: 'M16',
    what: '编译投影：doorMaterial 又被静默丢弃（约束一）',
    file: COMPILE,
    from: '  if (u.doorMaterial !== undefined && u.doorMaterial !== null) out.doorMaterial = String(u.doorMaterial);',
    to: '  // 变异：静默丢弃 doorMaterial',
    expect: 'H1',
  },
  {
    id: 'M17',
    what: '表外字段不再显式拒绝（约束一 / 四）',
    file: PROPOSAL,
    from: '          if (!UNIT_FIELDS.has(field)) {',
    to: '          if (false && !UNIT_FIELDS.has(field)) {',
    expect: 'H3',
  },
];

async function mutate(m: Mutant): Promise<void> {
  const raw = readFileSync(m.file, 'utf8');
  const norm = raw.replace(/\r\n/g, '\n');
  const hits = norm.split(m.from).length - 1;
  if (hits !== 1) {
    ok(`变异【${m.id}】锚点唯一命中（${m.what}）`, false, `在 ${m.file} 命中 ${hits} 次（必须恰好 1 次）:\n${m.from.slice(0, 140)}`);
    return;
  }
  writeFileSync(m.file, norm.replace(m.from, m.to));
  let r: { completed: boolean; failedCount: number; out: string };
  try {
    r = await runAcceptance();
  } finally {
    writeFileSync(m.file, raw); // 原始字节还原
  }
  const caught = r.completed && r.failedCount > 0;
  ok(
    `变异【${m.id}】${m.what} ⇒ 被抓住（期望：${m.expect}）`,
    caught,
    r.completed
      ? `变异后仍全绿 —— 断言是瞎的：${m.expect} 没抓住它`
      : `变异后验收**没跑完**（崩了 ≠ 判红，这条变异无效）：\n${r.out.slice(0, 500)}`,
  );
}

// ── 启动自检 + 自动还原：上一次若被 SIGTERM/崩溃打断，finally 不会跑，源码会留在变异态 ──
//   判据不靠"记得清理"，而是**用已知的 from→to 对照表反推还原**（to 唯一可识别）。
section('启动自检：工作区无残留变异（有则自动还原，保留 CRLF）');
{
  let repaired = 0;
  for (const m of MUTANTS) {
    const raw = readFileSync(m.file, 'utf8');
    for (const [a, b] of [
      [m.to.replace(/\n/g, '\r\n'), m.from.replace(/\n/g, '\r\n')],
      [m.to, m.from],
    ] as const) {
      if (raw.includes(a)) {
        writeFileSync(m.file, raw.replace(a, b));
        console.log(`  · 已还原残留变异：${m.id} @ ${m.file.replace(APP, '')}`);
        repaired++;
        break;
      }
    }
  }
  console.log(`  · 本次自检还原 ${repaired} 处残留`);
  for (const f of [EXPLAIN, LOGIC, AIPANEL, PROPOSAL, COMPILE]) {
    const src = readFileSync(f, 'utf8');
    const clean = !MUTANTS.some((m) => m.file === f && src.includes(m.to));
    ok(`无残留变异：${f.replace(APP, '')}`, clean);
  }
}

section('基线：未变异时验收必须全绿（否则"判红"无从谈起）');
{
  const r = await runAcceptance();
  ok('基线全绿（失败 0）', r.completed && r.failedCount === 0, `completed=${r.completed} failed=${r.failedCount}\n${r.out.slice(-300)}`);
}

section('M1–M17：每项改坏后都必须被抓住');
for (const m of MUTANTS) await mutate(m);

console.log(`\n══════════════════════════════════════════════`);
console.log(`  P9.9 变异验收：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log(`失败项：\n  · ${failures.join('\n  · ')}`);
  process.exit(1);
}
console.log('全部通过：每一项变异都被断言抓住（且基线全绿）。');
