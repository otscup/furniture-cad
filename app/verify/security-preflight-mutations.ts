/**
 * ══════════════════════════════════════════════════════════════════════
 *  P10.0 · 安全前置验收的**变异验收**（SM1–SM10）
 *
 *  ── 它做什么 ──
 *    对每一项：**把安全改动改回"出事状态"** → 跑 `security-preflight-acceptance.ts`
 *    → 要求它**跑完且判红**（≠ 崩溃）→ `finally` 从磁盘还原原始字节。
 *
 *  ── 为什么必须做 ──
 *    "新增/改断言须临时改坏确认真会红"是仓库纪律。安全类断言尤其危险：
 *    它很容易写成恒真（例如只断言 status===403 —— 而"恰好因为别的原因 403"也会绿）。
 *    这一组变异就是给每条断言做一次"它到底看不看得见事故"的体检。
 *
 *  ── 判红标准 ──
 *    必须出现汇总行 `P10.0 安全前置验收：通过 N / 失败 M` 且 `M > 0`。
 *    只看 exit code 是错的：**崩溃（未捕获异常）也返回 1**，那是"变异写坏了"，
 *    不代表"断言抓到了问题"。
 *    **跑本套件时不要把输出管道给 `head`**：SIGPIPE 会在 finally 之前退出，
 *    把源码留在变异态（本套件启动时会用已知 `to` 文本反推还原）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const APP = join(import.meta.dirname, '..');
const SERVER = join(APP, 'server', 'server.mjs');
const ADMIN = join(APP, 'src', 'ui', 'panels', 'AdminPanel.tsx');

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
    const p = spawn(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, 'security-preflight-acceptance.ts')], { cwd: APP });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (out += d));
    p.on('error', (e) => (out += String(e)));
    p.on('close', () => {
      const m = out.match(/P10\.0 安全前置验收：通过 (\d+) \/ 失败 (\d+)/);
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
    id: 'SM1',
    what: '/api/memory 的写不再要求 canManage（退回"只过已登录"）',
    file: SERVER,
    from: "    isSettingsWrite ||\n    isMemoryWrite;",
    to: '    isSettingsWrite;',
    expect: '②（viewer/designer PUT 变 200）',
  },
  {
    id: 'SM2',
    what: '/api/settings 的成功审计动作名改掉（= 等于没留痕）',
    file: SERVER,
    from: "      action: 'settings.ai',\n      result: 'ok',",
    to: "      action: 'settings.ai',\n      result: 'ok-disabled',",
    expect: '①（找不到 settings.ai/ok 条目）',
  },
  {
    id: 'SM3',
    what: '审计里把 key 明文写进去（加审计反而造出新的泄露面）',
    file: SERVER,
    from: '        apiKey: apiKeyChanged,',
    to: '        apiKey: patch.AI_API_KEY ?? apiKeyChanged,',
    expect: '①（审计文件里出现 key 明文）',
  },
  {
    id: 'SM4',
    what: 'chat 端点退回 body.maxTokens 原值透传（硬顶被绕过）',
    file: SERVER,
    from: "      const mt = enforceMaxTokens(body, env.AI_MAX_TOKENS);\n      if (!mt.ok) return rejectMaxTokens(res, actor, 'chat', mt);",
    to: '      const mt = { ok: true, value: typeof body.maxTokens === \'number\' && body.maxTokens > 0 ? body.maxTokens : resolveMaxTokens(env.AI_MAX_TOKENS) };',
    expect: '③④（10,000,000 不再被拒）+ ⑥（透传写法复活）',
  },
  {
    id: 'SM5',
    what: '超顶改成"静默夹取"而不是拒绝（用户以为设置生效了）',
    file: SERVER,
    from: "      ok: false,\n      code: 'MAX_TOKENS_EXCEEDED',\n      cap,\n      requested: want,\n      error: `输出上限 ${want} 超过服务端硬顶 ${cap}，已拒绝（该硬顶只能由服务端收紧，请求体不能抬高）`,\n    };",
    to: '      ok: true,\n      value: cap,\n    };',
    expect: '③④（超顶不再 400）',
  },
  {
    id: 'SM6',
    what: 'AI_HARD_MAX_TOKENS 可以抬高硬顶（提权）',
    file: SERVER,
    from: '  return Math.min(HARD_MAX_TOKENS_CAP, Math.max(1, Math.round(raw)));',
    to: '  return Math.max(1, Math.round(raw));',
    expect: '⑤（99999999 把 cap 撬到 99999999）',
  },
  {
    id: 'SM7',
    what: '被拒的设置写不再留痕（result 改掉）',
    file: SERVER,
    from: "          action: 'settings.ai',\n          result: 'rejected',",
    to: "          action: 'settings.ai',\n          result: 'rejected-disabled',",
    expect: '③④（找不到 result=rejected 条目）',
  },
  {
    id: 'SM8',
    what: 'changed.apiKey 恒为 true（"布尔是真实的"这条断言变瞎）',
    file: SERVER,
    from: "    const apiKeyChanged = typeof body.apiKey === 'string' && body.apiKey.trim() !== '';",
    to: '    const apiKeyChanged = true;',
    expect: '①（只改 temperature 时 apiKey 仍为 true）',
  },
  {
    id: 'SM9',
    what: 'AdminPanel 又把 65536 写死成输入上限',
    file: ADMIN,
    from: '                    max={maxTokensCap}',
    to: '                    max={65536}',
    expect: '⑥（前端硬编码上界复活）',
  },
  {
    id: 'SM10',
    what: '/api/memory 的写不再留痕（动作名改掉）',
    file: SERVER,
    from: "      action: 'memory.write',",
    to: "      action: 'memory.write-disabled',",
    expect: '②（找不到 memory.write 条目）',
  },
];

const FILES = [SERVER, ADMIN];

async function mutate(m: Mutant): Promise<void> {
  const raw = readFileSync(m.file, 'utf8');
  const norm = raw.replace(/\r\n/g, '\n');
  const hits = norm.split(m.from).length - 1;
  if (hits !== 1) {
    ok(`变异【${m.id}】锚点唯一命中（${m.what}）`, false, `在 ${m.file.replace(APP, '')} 命中 ${hits} 次（必须恰好 1 次）:\n${m.from.slice(0, 160)}`);
    return;
  }
  writeFileSync(m.file, norm.replace(m.from, m.to));
  let r: { completed: boolean; failedCount: number; out: string };
  try {
    r = await runAcceptance();
  } finally {
    writeFileSync(m.file, raw);
  }
  const caught = r.completed && r.failedCount > 0;
  ok(
    `变异【${m.id}】${m.what} ⇒ 被抓住（期望：${m.expect}）`,
    caught,
    r.completed
      ? `变异后仍全绿 —— 断言是瞎的：${m.expect} 没抓住它`
      : `变异后验收**没跑完**（崩了 ≠ 判红，这条变异无效）：\n${r.out.slice(0, 500)}`
  );
}

// ── 启动自检 + 自动还原 ──
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
  for (const f of FILES) {
    const src = readFileSync(f, 'utf8');
    const clean = !MUTANTS.some((m) => m.file === f && m.to && src.includes(m.to));
    ok(`无残留变异：${f.replace(APP, '')}`, clean);
  }
}

section('基线：未变异时验收必须全绿（否则"判红"无从谈起）');
{
  const r = await runAcceptance();
  ok('基线全绿（失败 0）', r.completed && r.failedCount === 0, `completed=${r.completed} failed=${r.failedCount}\n${r.out.slice(-400)}`);
}

section('SM1–SM10：每项改坏后都必须被抓住');
for (const m of MUTANTS) await mutate(m);

console.log(`\n══════════════════════════════════════════════`);
console.log(`  P10.0 安全前置变异验收：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log(`失败项：\n  · ${failures.join('\n  · ')}`);
  process.exit(1);
}
console.log('全部通过：每一项变异都被断言抓住（且基线全绿）。');
