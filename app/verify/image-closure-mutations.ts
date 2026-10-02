/**
 * ══════════════════════════════════════════════════════════════════════
 *  P10.0 · S0 镜像闭包验收的**变异验收**（MS1–MS10）
 *
 *  ── 它做什么 ──
 *    对每一项：**把 Dockerfile / .dockerignore / 源码改回"出事状态"** →
 *    跑 `image-closure-acceptance.ts` → 要求它**跑完且判红**（≠ 崩溃）→
 *    `finally` 从磁盘还原原始字节。
 *
 *  ── 判红标准（★ 与"测试通过"同样重要）──
 *    必须出现汇总行 `P10.0 S0 镜像闭包验收：通过 N / 失败 M` 且 `M > 0`。
 *    只看 exit code 是错的：**崩溃（未捕获异常）也返回 1**，那说明变异本身写坏了，
 *    不代表"断言抓到了问题" —— 那种"红"没有意义。
 *    **跑本套件时不要把输出管道给 `head`**：SIGPIPE 会在 finally 之前退出，把源码留在变异态。
 *
 *  ── 纪律 ──
 *    · 锚点必须落**实码**且**唯一命中**（0 次或 >1 次都判这条变异失败，不静默跳过）；
 *    · Dockerfile / .dockerignore 是 LF；源码是 CRLF —— 统一"归一化匹配、原字节还原"；
 *    · 变异**永不进仓库**：finally 还原 + 启动时用已知 to 文本反推还原残留。
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const APP = join(import.meta.dirname, '..');

const DOCKERFILE = join(APP, 'Dockerfile');
const DOCKERIGNORE = join(APP, '.dockerignore');
const BRIDGE = join(APP, 'src', 'core', 'manufacturing', 'bridge.ts');
const EMIT_NEUTRAL = join(APP, 'scripts', 'emit-neutral.ts');
const EMIT_ROOMBOOK = join(APP, 'scripts', 'emit-roombook.ts');

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
    const p = spawn(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, 'image-closure-acceptance.ts')], { cwd: APP });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (out += d));
    p.on('error', (e) => (out += String(e)));
    p.on('close', () => {
      // 判据：**跑完且判红**。汇总行的存在 = 真的跑完了（不是崩在 import 阶段）。
      const m = out.match(/P10\.0 S0 镜像闭包验收：通过 (\d+) \/ 失败 (\d+)/);
      resolve({ completed: m !== null, failedCount: m ? Number(m[2]) : -1, out });
    });
  });
}

interface Mutant {
  id: string;
  what: string;
  file: string;
  from: string;
  to: string;
  expect: string;
}

const MUTANTS: Mutant[] = [
  {
    id: 'MS1',
    what: 'Dockerfile 又漏掉 COPY src/core（= 退回生产缺陷状态）',
    file: DOCKERFILE,
    from: 'COPY src/core ./src/core\n',
    to: '',
    expect: 'B1 / B2 / B2b',
  },
  {
    id: 'MS2',
    what: 'Dockerfile 又漏掉 COPY scripts（emit 入口整个不在镜像里）',
    file: DOCKERFILE,
    from: 'COPY scripts ./scripts\n',
    to: '',
    expect: 'B1 / B3',
  },
  {
    id: 'MS3',
    what: '图省事写成 COPY src ./src（把前端源码也带进运行镜像）',
    file: DOCKERFILE,
    from: 'COPY src/core ./src/core\n',
    to: 'COPY src ./src\n',
    expect: 'C1 / C2',
  },
  {
    id: 'MS4',
    what: '额外把 src/ui 拷进运行镜像',
    file: DOCKERFILE,
    from: 'COPY py ./py\n',
    to: 'COPY py ./py\nCOPY src/ui ./src/ui\n',
    expect: 'C1',
  },
  {
    id: 'MS5',
    what: '.dockerignore 把 src 排除了（COPY 就没有源了）',
    file: DOCKERIGNORE,
    from: '\nverify\ndocs\n',
    to: '\nverify\nsrc\ndocs\n',
    expect: 'D1',
  },
  {
    id: 'MS6',
    what: '.dockerignore 不再排除 memory（本地账号/审计/记忆会进镜像）',
    file: DOCKERIGNORE,
    from: '\ndata\nmemory\nverify\n',
    to: '\ndata\nverify\n',
    expect: 'D2',
  },
  {
    id: 'MS7',
    what: '导出链引入前端源码依赖（bridge.ts → src/ui/panels/common.tsx）',
    file: BRIDGE,
    from: "import { generateProject } from '../geometry/project.ts';",
    to: "import { generateProject } from '../geometry/project.ts';\nimport { Pill } from '../../ui/panels/common.tsx';",
    expect: 'A3（前端泄漏进闭包）',
  },
  {
    id: 'MS8',
    what: 'Dockerfile 漏掉 COPY src/ai/memory.ts（与 commandBus 不再成对）',
    file: DOCKERFILE,
    from: 'COPY src/ai/memory.ts ./src/ai/memory.ts\n',
    to: '',
    expect: 'F4',
  },
  {
    id: 'MS9',
    what: 'emit 入口把规则集文件名改错（按路径读的资源不存在）',
    file: EMIT_NEUTRAL,
    from: "'ruleset', 'factory-default.json'",
    to: "'ruleset', 'factory-default_v2.json'",
    expect: 'F2 / B2b',
  },
  {
    id: 'MS10',
    what: 'emit 入口新增一条逃出被拷目录的运行期依赖（→ src/ai/compileProposal.ts）',
    file: EMIT_ROOMBOOK,
    from: "import { buildRoomBook, roomBookHtml } from '../src/export/roomBook.ts';",
    to: "import { buildRoomBook, roomBookHtml } from '../src/export/roomBook.ts';\nimport { compileProposal } from '../src/ai/compileProposal.ts';",
    expect: 'B1（新依赖不在镜像覆盖内）',
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

// ── 启动自检 + 自动还原：上一次若被 SIGTERM/崩溃打断，finally 不会跑，文件会留在变异态 ──
section('启动自检：工作区无残留变异（有则自动还原）');
{
  let repaired = 0;
  for (const m of MUTANTS) {
    const raw = readFileSync(m.file, 'utf8');
    for (const [a, b] of [
      [m.to.replace(/\n/g, '\r\n'), m.from.replace(/\n/g, '\r\n')],
      [m.to, m.from],
    ] as const) {
      if (m.to && a && raw.includes(a)) {
        writeFileSync(m.file, raw.replace(a, b));
        console.log(`  · 已还原残留变异：${m.id} @ ${m.file.replace(APP, '')}`);
        repaired++;
        break;
      }
    }
  }
  console.log(`  · 本次自检还原 ${repaired} 处残留`);
  for (const f of [DOCKERFILE, DOCKERIGNORE, BRIDGE, EMIT_NEUTRAL, EMIT_ROOMBOOK]) {
    const src = readFileSync(f, 'utf8');
    const clean = !MUTANTS.some((m) => m.file === f && m.to && src.includes(m.to));
    ok(`无残留变异：${f.replace(APP, '')}`, clean);
  }
}

section('基线：未变异时验收必须全绿（否则"判红"无从谈起）');
{
  const r = await runAcceptance();
  ok('基线全绿（失败 0）', r.completed && r.failedCount === 0, `completed=${r.completed} failed=${r.failedCount}\n${r.out.slice(-300)}`);
}

section('MS1–MS10：每项改坏后都必须被抓住');
for (const m of MUTANTS) await mutate(m);

console.log(`\n══════════════════════════════════════════════`);
console.log(`  P10.0 S0 变异验收：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log(`失败项：\n  · ${failures.join('\n  · ')}`);
  process.exit(1);
}
console.log('全部通过：每一项变异都被断言抓住（且基线全绿）。');
