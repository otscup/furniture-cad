/**
 * ══════════════════════════════════════════════════════════════════════
 *  P10.0 · S2 验收的**变异验收**（M1–M8）
 *
 *  ── 它做什么 ──
 *  对每一项：把 S2 的关键保护改回「出事状态」→ 跑 mcp-acceptance.ts →
 *  要求它**跑完且判红**（失败数 > 0），finally 从磁盘还原原始字节。
 *
 *  ── 为什么必须做 ──
 *  MCP + token 这一层的断言最容易写成恒真：
 *   · "/mcp 需要认证" —— 如果 local-open 夹具恰好也在跑，断言可能永远绿；
 *   · "只读" —— 如果工具根本没真的读工作区，测试照样可能绿；
 *   · "token 不出现在日志" —— 如果 token 压根没落盘，搜什么都搜不到。
 *  这一组给每条关键断言做一次「它到底看不看得见事故」的体检。
 *
 *  ── 判红标准 ──
 *   必须出现汇总行 `P10.0 S2 验收：通过 N / 失败 M` 且 `M > 0`。
 *   只看 exit code 是错的：崩溃（未捕获异常）也返回 1，那是「变异写坏了」，
 *   不代表「断言抓到了问题」。
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(import.meta.dirname, '..');
const MCP = join(APP, 'server', 'mcp.mjs');
const SRV = join(APP, 'server', 'server.mjs');
const AUTH = join(APP, 'server', 'auth.mjs');
const HOST = join(APP, 'server', 'workspaceHost.mjs');

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
    const p = spawn(process.execPath, ['--experimental-strip-types', join(import.meta.dirname, 'mcp-acceptance.ts')], { cwd: APP });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (out += d));
    p.on('error', (e) => (out += String(e)));
    p.on('close', () => {
      const m = out.match(/P10\.0 S2 验收：通过 (\d+) \/ 失败 (\d+)/);
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
  expectFailedLabels?: string[];
}

const MUTANTS: Mutant[] = [
  {
    id: 'M1',
    what: '绕过认证：无效/缺失 token 也放行（把第一个账号当成调用者）',
    file: MCP,
    from:
      '  const acc = auth.authenticateToken(token) ?? auth.authenticate(token);\n' + '  if (!acc) return { ok: false, mode: \'accounts\' };',
    to:
      '  // 变异：认证失败也放行，冒充第一个账号\n' +
      '  const acc = auth.authenticateToken(token) ?? auth.authenticate(token) ?? auth.data.accounts[0];\n' +
      "  if (!acc) return { ok: false, mode: 'accounts' };",
    expect: '④1/④2/④2b（无 token / 错 token 调用 /mcp 不再 401）',
  },
  {
    id: 'M2',
    what: '绕过 requireAuth 的角色闸：/api/account/* 不再要求 canManage',
    file: SRV,
    from:
      '  const managePaths =\n' + "    pathname.startsWith('/api/account/') ||\n" + "    pathname.startsWith('/api/security/') ||",
    to: '  const managePaths =\n' + "    pathname.startsWith('/api/security/') ||",
    expect: '④6/④6b/④6c/④7（viewer / designer 的 token 能进管理面）',
  },
  {
    id: 'M3',
    what: '工具直接改 live model（不取深拷贝，拿到内部引用就地改）',
    file: MCP,
    from: '      const project = ws.getProjectSnapshot();',
    to: "      // 变异：直接改 live 对象（绕过只读约束）\n      const project = ws.getState();\n      project.name = 'MCP 改过的名字';",
    expect: '②2（get_state 的 project 与本地独立解析不一致）、⑦4',
  },
  {
    id: 'M4',
    what: '建第二套 model：工具自造一份模型对象，不读工作区',
    file: MCP,
    from: '      const project = ws.getProjectSnapshot();',
    to:
      "      // 变异：MCP 自建第二套模型，不读工作区\n" +
      "      const project = { schemaVersion: '0.2', id: 'mcp_made_up', name: 'MCP 自建', ruleSetId: 'factory_default_v1', rooms: [], cabinets: [] };",
    expect: '②2/②2b（project 与真实工作区不一致）、⑦4',
  },
  {
    id: 'M5',
    what: 'validate 直接替换现有 validator（返回自造的"没问题"）',
    file: MCP,
    from: '        v = ws.validate();',
    to:
      "        // 变异：绕过既有 CommandBus.derive，自造一份实时校验结果\n" +
      "        v = { issues: [], derived: { panels: 0, pieces: 0, areaM2: 0, weightKg: 0 }, blockingErrors: 0 };",
    expect: '②3/②3b/②3c（派生汇总与 issues 与既有 validator 不一致）',
  },
  {
    id: 'M6',
    what: '未授权 viewer 访问管理能力：PAT 校验时把角色悄悄升成 owner',
    file: AUTH,
    from:
      '      const t = (a.tokens ?? []).find((x) => x.hash === h);\n' +
      '      if (!t) continue;\n' +
      "      if (a.status !== 'active') return null;\n" +
      '      if (a.lockedUntil && new Date(a.lockedUntil).getTime() > now) return null;\n' +
      '      return a;',
    to:
      '      const t = (a.tokens ?? []).find((x) => x.hash === h);\n' +
      '      if (!t) continue;\n' +
      "      if (a.status !== 'active') return null;\n" +
      '      if (a.lockedUntil && new Date(a.lockedUntil).getTime() > now) return null;\n' +
      '      // 变异：token 一验通过就把角色抬成 owner\n' +
      "      return { ...a, role: 'owner' };",
    expect: '④6（viewer 的 PAT 访问管理接口不再是 403）',
  },
  // ── ⑧ 段（"记不下来"不得升级成"服务没了"）的反恒真变异 ──
  {
    id: 'M7',
    what: '工作区装载通知不再受保护（审计旁路异常 ⇒ 工作区被误判为装载失败）',
    file: HOST,
    from:
      '  const notify = (event) => {\n' +
      '    try {\n' +
      '      onEvent(event);\n' +
      '    } catch {\n' +
      '      /* 见上：通知失败不改变装载结果 */\n' +
      '    }\n' +
      '  };',
    to: '  const notify = (event) => onEvent(event);',
    expect: '⑧B3（审计不可写时工作区被误判装载失败）',
  },
  {
    id: 'M8',
    what: '/mcp 的审计不再受保护（认证失败路径上的 audit 抛出即杀掉服务）',
    file: MCP,
    from:
      '  const safeAudit = (entry) => {\n' +
      '    try {\n' +
      '      audit(entry);\n' +
      '    } catch {\n' +
      '      /* 审计写入失败不改变 /mcp 响应；健康接口另报 dataWritable。 */\n' +
      '    }\n' +
      '  };',
    to: '  const safeAudit = (entry) => audit(entry);',
    expect: '⑧B2/⑧B2b（审计不可写时 /mcp 的 401 把服务带走）',
    expectFailedLabels: ['⑧A5', '⑧B2', '⑧B3'],
  },
];

async function mutate(m: Mutant): Promise<void> {
  const raw = readFileSync(m.file, 'utf8');
  const norm = raw.replace(/\r\n/g, '\n');
  const hits = norm.split(m.from).length - 1;
  if (hits !== 1) {
    ok(
      `变异【${m.id}】锚点唯一命中（${m.what}）`,
      false,
      `在 ${m.file.replace(APP, '')} 命中 ${hits} 次（必须恰好 1 次）：\n${m.from.slice(0, 240)}`
    );
    return;
  }
  const mutated = norm.replace(m.from, m.to);
  // 还原保证：无论验收结果如何，finally 把原始字节写回
  try {
    writeFileSync(m.file, mutated, 'utf8');
    const r = await runAcceptance();
    const missingExpected = (m.expectFailedLabels ?? []).filter(label => !r.out.includes(`✗ ${label}`));
    const caught = r.completed && r.failedCount > 0 && missingExpected.length === 0;
    const redLines = (r.out.match(/^\s+\u2717 .+$/gm) ?? []).slice(0, 4).join('\n      ');
    ok(`变异【${m.id}】被验收抓到（${m.what}）`, caught, `completed=${r.completed} 失败数=${r.failedCount}\n      期望红的断言：${m.expect}${missingExpected.length ? `\n      缺少行为失败：${missingExpected.join(', ')}` : ''}\n${redLines}`);
  } finally {
    writeFileSync(m.file, raw, 'utf8');
  }
}

section('M. S2 关键保护变异验收');
for (const m of MUTANTS) {
  await mutate(m);
}

console.log(`\n══════════════════════════════════════════════════════`);
console.log(`  P10.0 S2 变异验收：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log(`失败项：\n  · ${failures.join('\n  · ')}`);
  process.exit(1);
}
console.log(`全部通过：${MUTANTS.length} 个变异均被 S2 验收断言捕获（断言非恒真）。`);
