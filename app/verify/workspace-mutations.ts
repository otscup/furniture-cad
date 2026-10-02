/**
 * ══════════════════════════════════════════════════════════════════════
 *  P10.0 · S1 验收的**变异验收**（M1–M5）
 *
 *  ── 它做什么 ──
 *  对每一项：**把 S1 的关键保护改回「出事状态」** → 跑 workspace-acceptance.ts
 *  → 要求它**跑完且判红**（失败数 > 0）≠ 崩溃 → finally 从磁盘还原原始字节。
 *
 *  ── 为什么必须做 ──
 *   "新增/改断言须临时改坏确认真会红"是仓库纪律。S1 的断言尤其容易写成恒真：
 *   · "draft 与 live 隔离"——若 apply 根本没接乐观锁，C 组可能照样绿；
 *   · "并发无丢写"——若队列被删但测试用的是内存真相，根本看不出事故。
 *   这一组变异给每条关键断言做一次「它到底看不看得见事故」的体检。
 *
 *  ── 判红标准 ──
 *   必须出现汇总行 `P10.0 S1 验收：通过 N / 失败 M` 且 `M > 0`。
 *   只看 exit code 是错的：崩溃（未捕获异常）也返回 1，那是「变异写坏了」，
 *   不代表「断言抓到了问题」。
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const APP = join(import.meta.dirname, '..');
const WS = join(APP, 'src', 'workspace', 'workspace.ts');
const QUEUE = join(APP, 'server', 'writeQueue.mjs');

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
  console.log(`\n【${t}】`);
}

function runAcceptance(): Promise<{ completed: boolean; failedCount: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, 'workspace-acceptance.ts')], { cwd: APP });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (out += d));
    p.on('error', (e) => (out += String(e)));
    p.on('close', () => {
      const m = out.match(/P10\.0 S1 验收：通过 (\d+) \/ 失败 (\d+)/);
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
    id: 'M1',
    what: '写模型绕过 CommandBus（直接假装成功，不经白名单校验）',
    file: WS,
    from:
      '    // ── 唯一写入口：模型变更只允许经 CommandBus（其 plan() 内含 WRITABLE/DENY 白名单）──\n' +
      '    const r = this.bus.execute(cmd);',
    to:
      '    // 变异：绕过 CommandBus 直接假装成功（破坏写路径白名单）\n' +
      '    const r = { ok: true, diff: [], newIssues: [], resolvedIssues: [], derived: { panels: 0, pieces: 0 }, clamped: [], blockingErrors: 0, memoryHits: [] } as ExecResult;',
    expect: 'B4/B5（非法 op、越权路径 panels.* 不再被拒）',
  },
  {
    id: 'M2',
    what: 'apply 的乐观锁（stale 检查）被整段删除',
    file: WS,
    from:
      '    if (this.liveModelVersion !== d.baseModelVersion) {\n' +
      '      return {\n' +
      '        ok: false,\n' +
      '        code: DRAFT_STALE,\n' +
      '        message: `live=${this.liveModelVersion} ≠ base=${d.baseModelVersion}：draft 已过期，拒绝应用（需 rebase 后重试）`,\n' +
      '      };\n' +
      '    }',
    to: '    /* 变异：乐观锁已删除，stale 不再拒绝 */',
    expect: 'C9/C10（旧 draft apply 不再结构化拒绝、live 被覆盖）',
  },
  {
    id: 'M3',
    what: 'stale 时自动 merge / last-write-wins（不拒绝、直接应用）',
    file: WS,
    from:
      '      return {\n' +
      '        ok: false,\n' +
      '        code: DRAFT_STALE,\n' +
      '        message: `live=${this.liveModelVersion} ≠ base=${d.baseModelVersion}：draft 已过期，拒绝应用（需 rebase 后重试）`,\n' +
      '      };',
    to: '      /* 变异：stale 但自动 merge（last-write-wins），不拒绝 */',
    expect: 'C9（stale 仍被拒绝）',
  },
  {
    id: 'M4',
    what: 'draft 命令直接作用于 live 总线（破坏 draft/live 隔离）',
    file: WS,
    from:
      '    // draft 命令只作用于 draft 自己的总线；绝不写 live\n' +
      '    return d.execute(cmd);',
    to:
      '    // 变异：draft 命令直接作用于 live 总线（破坏隔离）\n' +
      '    return this.bus.execute(cmd);',
    expect: 'C4（draft 内修改后 live 仍保持原值）',
  },
  {
    id: 'M5',
    what: '并发写队列被移除（写不再串行化）',
    file: QUEUE,
    from:
      '  const next = prev.then(task, task).finally(() => {\n' +
      '    if (chains.get(path) === next) chains.delete(path);\n' +
      '  });',
    to: '  const next = (task(), Promise.resolve());',
    expect: 'D1/D2（并发读-改-写出现丢写，最终计数 < N）',
  },
];

async function mutate(m: Mutant): Promise<void> {
  const raw = readFileSync(m.file, 'utf8');
  const norm = raw.replace(/\r\n/g, '\n');
  const hits = norm.split(m.from).length - 1;
  if (hits !== 1) {
    ok(`变异【${m.id}】锚点唯一命中（${m.what}）`, false, `在 ${m.file.replace(APP, '')} 命中 ${hits} 次（必须恰好 1 次）:\n${m.from.slice(0, 200)}`);
    return;
  }
  const mutated = norm.replace(m.from, m.to);
  // 还原保证：无论验收结果如何，finally 把原始字节写回
  try {
    writeFileSync(m.file, mutated, 'utf8');
    const r = await runAcceptance();
    const caught = r.completed && r.failedCount > 0;
    ok(`变异【${m.id}】被验收抓到（${m.what}）`, caught, {
      completed: r.completed,
      failedCount: r.failedCount,
      expect: m.expect,
      tail: r.out.split('\n').slice(-6).join('\n'),
    });
  } finally {
    writeFileSync(m.file, raw, 'utf8');
  }
}

section('M. S1 关键保护变异验收');
for (const m of MUTANTS) {
  await mutate(m);
}

console.log(`\n══════════════════════════════════════════════════════`);
console.log(`  P10.0 S1 变异验收：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log(`失败项：\n  · ${failures.join('\n  · ')}`);
  process.exit(1);
}
console.log('全部通过：5 个变异均被 S1 验收断言捕获（断言非恒真）。');
