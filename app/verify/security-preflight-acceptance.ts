/**
 * P10.0 安全前置验收（S0.5 之后、不进 MCP）。
 *
 * 这一组钉的是四条"防线 + 留痕"，全部走**真 HTTP**（spawn 真实 server.mjs），
 * 因为被修的缺陷全部只存在于 HTTP 层：鉴权判定、请求体闸门、审计落盘。
 * 任何一条在"store 级 / 函数级"测都测不到。
 *
 * ── 危险度排序（也就是断言强度的排序）──
 *   ① `/api/settings` 改 AI Key / provider / baseUrl / model **必须留痕**，
 *      且审计里**绝不能出现 key 明文**（否则"加了审计"反而制造了新的泄露面）。
 *   ② `/api/memory` 的**写**必须要求 canManage —— 它覆盖的 corrections.jsonl
 *      会被当**规则**消费；viewer/designer 能覆盖 = 只读账号可以替换整套规则。
 *   ③④ 输出预算必须有服务端硬顶，且**请求体抬不高它**。
 *      这里最容易写成假绿：只断言"超顶被拒 400"不够 —— 必须同时断言
 *      (a) 拒绝码就是 MAX_TOKENS_EXCEEDED、(b) 上游**一次都没被调用**（闸门在上游之前）、
 *      (c) 合法请求确实把值**原样**转发给上游（证明这个计数器是活的，不是永远 0）。
 *
 * ── 反假绿 ──
 *   · 每条"被拒"都断言 `code`，不只断言 `ok===false`；
 *   · "没被调用"与"被调用了一次"成对出现（计数器自证）；
 *   · 喂进去的数字必须能与观测值对上（cap=1000 时拒的确实是 2000）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthStore } from '../server/auth.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

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
/** 剥注释只扫代码（源码纪律类断言：文件头常写"本层不 import X"这种声明） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── 夹具 ─────────────────────────

const TMP = mkdtempSync(join(tmpdir(), 'furnicad-secpre-'));
let nextPort = 8930;
const children: ChildProcess[] = [];
const servers: Server[] = [];

/** 上游桩：只记录"被调用了几次、收的 max_tokens 是多少"，返回合法 OpenAI 信封 */
function makeUpstream(): { srv: Server; rec: { total: number; maxTokens: unknown[] } } {
  const rec = { total: 0, maxTokens: [] as unknown[] };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      rec.total++;
      let p: Record<string, unknown> = {};
      try {
        p = JSON.parse(body) as Record<string, unknown>;
      } catch {}
      rec.maxTokens.push(p.max_tokens);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'stub',
          model: p.model ?? 'stub',
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      );
    });
  });
  servers.push(srv);
  return { srv, rec };
}
function listen(srv: Server): Promise<number> {
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as { port: number }).port)));
}

interface Fixture {
  port: number;
  child: ChildProcess;
  dir: string;
  auditPath: string;
  accountsPath: string;
}

/**
 * 起一个真实 server.mjs。
 * 顺序很重要：**账号文件必须在 server 启动前就存在** —— 它只在启动时读一次。
 * createAccounts=true 时先落盘 owner/designer/viewer 三个角色。
 */
async function startServer(opts: { envFile: string; extraEnv?: Record<string, string>; createAccounts?: boolean }): Promise<Fixture> {
  const dir = mkdtempSync(join(TMP, 'srv-'));
  const accountsPath = join(dir, 'accounts.json');
  const auditPath = join(dir, 'audit.jsonl');
  if (opts.createAccounts) {
    const a = new AuthStore({ accountsPath, auditPath });
    a.create({ username: 'owner', password: 'owner-pass-1234', actor: 'bootstrap' });
    a.create({ username: 'designer', password: 'des-pass-1234', role: 'designer', actor: 'owner' });
    a.create({ username: 'viewer', password: 'view-pass-1234', role: 'viewer', actor: 'owner' });
  }
  const port = nextPort++;
  const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_ENV_PATH: opts.envFile,
      APP_MEM_PATH: join(dir, 'corrections.jsonl'),
      APP_ACCOUNTS_PATH: accountsPath,
      APP_AUDIT_PATH: auditPath,
      ...(opts.extraEnv ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  for (let i = 0; i < 100; i++) {
    await wait(100);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { port, child, dir, auditPath, accountsPath };
    } catch {}
  }
  throw new Error(`server 未在预期时间内就绪（port=${port}）`);
}

async function api(
  port: number,
  path: string,
  init: { method?: string; token?: string | null; body?: unknown } = {}
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(text);
  } catch {}
  return { status: r.status, json: j, text };
}
async function login(port: number, username: string, password: string): Promise<string> {
  const r = await api(port, '/api/auth/login', { body: { username, password } });
  return r.json?.token ?? '';
}
function auditLines(auditPath: string): any[] {
  if (!existsSync(auditPath)) return [];
  return readFileSync(auditPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { action: 'parse_error', raw: l };
      }
    });
}

const up = makeUpstream();
const upstreamPort = await listen(up.srv);

/** 夹具 .env：故意把 AI_MAX_TOKENS 写到"无穷大"意图，验证它抬不高硬顶 */
const envFileA = join(TMP, '.env');
writeFileSync(
  envFileA,
  [
    `AI_BASE_URL=http://127.0.0.1:${upstreamPort}/v1`,
    'AI_API_KEY=sk-test-SECRET-abcdefghijklmnop',
    'AI_MODEL=stub-model',
    'AI_MAX_TOKENS=999999999',
    'AI_TEMPERATURE=0.2',
    '',
  ].join('\n'),
  'utf8'
);

const M = await startServer({ envFile: envFileA, createAccounts: true });
const T_OWNER = await login(M.port, 'owner', 'owner-pass-1234');
const T_DES = await login(M.port, 'designer', 'des-pass-1234');
const T_VIEW = await login(M.port, 'viewer', 'view-pass-1234');
console.log(`\n夹具：server :${M.port}  上游桩 :${upstreamPort}`);
console.log(`      token owner=${T_OWNER.slice(0, 6)}… designer=${T_DES.slice(0, 6)}… viewer=${T_VIEW.slice(0, 6)}…`);

// ═══════════════════════ ① /api/settings 审计 ═══════════════════════

section('① /api/settings 敏感设置修改必须留痕（且绝不泄露 key 明文）');
{
  const SECRET = 'sk-live-DEADBEEF-do-not-log-0123456789';
  const before = auditLines(M.auditPath).length;
  /**
   * ⚠ 夹具纪律：这一段会**真的改写 .env**（writeEnv 是整文件重写），
   * 而 server 每次请求都重新 readEnv()。所以 baseUrl 必须仍指向**上游桩**，
   * 不能随手写一个"看起来像被改了"的死地址（例如 :1）——
   * 否则后面的合法 AI 调用会全部以 "fetch failed" 收场，而那是夹具自己造的假故障。
   * 这里改的是"写了一次 baseUrl"这件事（审计看的是 hasOwnProperty，不看值变没变）。
   */
  const r1 = await api(M.port, '/api/settings', {
    method: 'PUT',
    token: T_OWNER,
    body: { apiKey: SECRET, model: 'new-model-x', provider: 'openai', baseUrl: `http://127.0.0.1:${upstreamPort}/v1` },
  });
  ok('owner 改 AI 设置 → 200', r1.status === 200, `status=${r1.status} ${r1.text.slice(0, 120)}`);

  const lines = auditLines(M.auditPath);
  const entry = [...lines].reverse().find((l) => l.action === 'settings.ai' && l.result === 'ok');
  ok('审计里出现 settings.ai 条目（以前这条路径完全不留痕）', Boolean(entry), `新增 ${lines.length - before} 条`);
  ok(
    '记录"改了哪几项"：apiKey/model/provider/baseUrl 均为 true 的布尔（不给值）',
    entry?.changed?.apiKey === true && entry?.changed?.model === true && entry?.changed?.provider === true && entry?.changed?.baseUrl === true,
    JSON.stringify(entry?.changed)
  );
  ok('审计条目带操作者 id（不是匿名的）', typeof entry?.actor === 'string' && entry.actor.startsWith('acc_'), String(entry?.actor));

  const allAudit = existsSync(M.auditPath) ? readFileSync(M.auditPath, 'utf8') : '';
  ok('【关键】整份审计文件里不含 key 明文（加审计不能变成新的泄露面）', !allAudit.includes(SECRET), 'FOUND SECRET IN AUDIT');
  ok('审计里也没有 key 的后 8 位片段', !allAudit.includes(SECRET.slice(-8)), 'leaked tail');

  // 只改温度时 apiKey 必须记 false —— 防止"恒 true"的假绿
  await api(M.port, '/api/settings', { method: 'PUT', token: T_OWNER, body: { temperature: 0.7 } });
  const e2 = [...auditLines(M.auditPath)].reverse().find((l) => l.action === 'settings.ai' && l.result === 'ok');
  ok('只改 temperature 时 changed.apiKey=false（布尔是真实的，不是恒 true）', e2?.changed?.apiKey === false && e2?.changed?.temperature === true, JSON.stringify(e2?.changed));
}

// ═══════════════════════ ② /api/memory 写权限 ═══════════════════════

section('② /api/memory 的写必须要求 canManage（viewer/designer 不得覆盖共享规则）');
{
  const memPath = join(M.dir, 'corrections.jsonl');
  const LEGIT = JSON.stringify({ id: 'c1', scope: 'rule', text: '原始规则' }) + '\n';
  writeFileSync(memPath, LEGIT, 'utf8');

  const vPut = await api(M.port, '/api/memory', { method: 'PUT', token: T_VIEW, body: { jsonl: JSON.stringify({ id: 'evil', scope: 'rule' }) } });
  ok('viewer PUT /api/memory → 403', vPut.status === 403, `status=${vPut.status} ${vPut.text.slice(0, 120)}`);
  ok('拒绝码是 FORBIDDEN（因对的原因被拒，不是恰好 403）', vPut.json?.code === 'FORBIDDEN', JSON.stringify(vPut.json));
  ok('【关键】文件内容一字未变（"被拒"必须等于"没写进去"）', readFileSync(memPath, 'utf8') === LEGIT, readFileSync(memPath, 'utf8').slice(0, 80));

  const dPut = await api(M.port, '/api/memory', { method: 'PUT', token: T_DES, body: { jsonl: JSON.stringify({ id: 'evil2', scope: 'rule' }) } });
  ok('designer（有 canDesign、无 canManage）PUT → 403', dPut.status === 403, `status=${dPut.status}`);
  ok('designer 同样因 FORBIDDEN 被拒', dPut.json?.code === 'FORBIDDEN', JSON.stringify(dPut.json));
  ok('designer 也被挡在文件之外', readFileSync(memPath, 'utf8') === LEGIT, '');

  const dPost = await api(M.port, '/api/memory', { method: 'POST', token: T_DES, body: { jsonl: 'x\n' } });
  ok('POST 走同一道闸（不是只挡了 PUT）', dPost.status === 403, `status=${dPost.status}`);

  const vGet = await api(M.port, '/api/memory', { method: 'GET', token: T_VIEW });
  ok('viewer GET /api/memory 仍然 200（读的能力没被顺手砍掉）', vGet.status === 200 && typeof vGet.json?.jsonl === 'string', `status=${vGet.status}`);

  const oPut = await api(M.port, '/api/memory', { method: 'PUT', token: T_OWNER, body: { jsonl: JSON.stringify({ id: 'c2', scope: 'rule', text: '由 owner 更新' }) } });
  ok('owner PUT → 200（合法写入没有被一起挡掉）', oPut.status === 200, `status=${oPut.status} ${oPut.text.slice(0, 120)}`);
  ok('owner 的写入确实落盘了', readFileSync(memPath, 'utf8').includes('由 owner 更新'), '');
  const mw = [...auditLines(M.auditPath)].reverse().find((l) => l.action === 'memory.write');
  ok(
    'memory.write 留痕（字节数 + 行数，不含内容）',
    mw && typeof mw.bytes === 'number' && typeof mw.lines === 'number' && !JSON.stringify(mw).includes('由 owner 更新'),
    JSON.stringify(mw)
  );
}

// ═══════════════════════ ③④ 输出预算服务端硬顶 ═══════════════════════

section('③④ 输出预算硬顶：请求体抬不高它，且闸门在上游之前');
{
  // 基线：先证明计数器是活的 —— 一个合法请求必须让上游收到 1 次
  up.rec.total = 0;
  up.rec.maxTokens.length = 0;
  const good = await api(M.port, '/api/ai/chat', { token: T_OWNER, body: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 4096 } });
  ok('合法请求（maxTokens=4096）→ 200', good.status === 200, `status=${good.status} ${good.text.slice(0, 100)}`);
  ok('上游恰好被调用 1 次（计数器是活的，后面的"0 次"才有意义）', up.rec.total === 1, `total=${up.rec.total} body=${good.text.slice(0, 300)}`);
  ok('4096 被原样转发给上游（不是被悄悄改写成别的数）', up.rec.maxTokens[0] === 4096, JSON.stringify(up.rec.maxTokens));

  // 核心：请求体传入远超硬顶的值 → 必须被拒，且上游一次都不能被调用
  up.rec.total = 0;
  up.rec.maxTokens.length = 0;
  const huge = await api(M.port, '/api/ai/chat', { token: T_OWNER, body: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 10_000_000 } });
  ok('maxTokens=10,000,000 → 400（请求体不能绕过硬顶）', huge.status === 400, `status=${huge.status}`);
  ok('拒绝码是 MAX_TOKENS_EXCEEDED', huge.json?.code === 'MAX_TOKENS_EXCEEDED', JSON.stringify(huge.json));
  ok('【关键】被拒的那次上游调用次数=0（闸门在上游之前，不是"先发出去再报错"）', up.rec.total === 0, `total=${up.rec.total}`);
  ok('错误里如实给出服务端硬顶值 65536', huge.json?.cap === 65536, JSON.stringify({ cap: huge.json?.cap }));
  ok('错误里回显被拒的请求值 10000000（不是含糊其辞）', String(huge.json?.error ?? '').includes('10000000'), String(huge.json?.error));

  // 边界：恰好等于硬顶必须放行
  up.rec.total = 0;
  up.rec.maxTokens.length = 0;
  const atCap = await api(M.port, '/api/ai/chat', { token: T_OWNER, body: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 65536 } });
  ok('恰好 =65536（边界）→ 200 且上游收到 65536', atCap.status === 200 && up.rec.total === 1 && up.rec.maxTokens[0] === 65536, `status=${atCap.status} mt=${JSON.stringify(up.rec.maxTokens)}`);

  // 不给 maxTokens 时用 .env 默认；.env 写的是 999999999 → 必须被夹到硬顶
  up.rec.total = 0;
  up.rec.maxTokens.length = 0;
  const noMt = await api(M.port, '/api/ai/chat', { token: T_OWNER, body: { messages: [{ role: 'user', content: 'hi' }] } });
  ok('.env 写 999999999、请求不带 maxTokens → 上游收到被夹到 65536 的值', noMt.status === 200 && up.rec.maxTokens[0] === 65536, `mt=${JSON.stringify(up.rec.maxTokens)}`);

  const st = await api(M.port, '/api/settings', { method: 'GET', token: T_OWNER });
  ok('/api/settings 下发 maxTokensCap=65536（前端不再自己写死 65536）', st.json?.maxTokensCap === 65536, JSON.stringify({ cap: st.json?.maxTokensCap }));

  // 写路径也要过闸：把超顶值写进 .env 必须被拒，且 .env 里不能留下超顶值
  const w = await api(M.port, '/api/settings', { method: 'PUT', token: T_OWNER, body: { maxTokens: 999999 } });
  ok('PUT /api/settings maxTokens=999999 → 400 MAX_TOKENS_EXCEEDED', w.status === 400 && w.json?.code === 'MAX_TOKENS_EXCEEDED', `status=${w.status} ${w.text.slice(0, 120)}`);
  const envNow = readFileSync(envFileA, 'utf8');
  ok('【关键】.env 里没有被写入 999999（拒绝 = 真的没落盘）', !/AI_MAX_TOKENS\s*=\s*999999\b/.test(envNow), envNow.split(/\r?\n/).find((l) => l.startsWith('AI_MAX_TOKENS')) ?? '');
  const rejAudit = [...auditLines(M.auditPath)].reverse().find((l) => l.action === 'settings.ai' && l.result === 'rejected');
  ok('被拒的写设置也留痕（result=rejected + code）', rejAudit?.code === 'MAX_TOKENS_EXCEEDED', JSON.stringify(rejAudit));

  // 其余三个 AI 端点也走同一道闸（单一实现，不在各端点各写一遍）
  up.rec.total = 0;
  const vision = await api(M.port, '/api/ai/vision', { token: T_OWNER, body: { image: 'data:image/png;base64,iVBORw0KGgo=', maxTokens: 10_000_000 } });
  ok('/api/ai/vision 同样拒超顶（400 + MAX_TOKENS_EXCEEDED）', vision.status === 400 && vision.json?.code === 'MAX_TOKENS_EXCEEDED', `status=${vision.status}`);
  const plan = await api(M.port, '/api/ai/plan', { token: T_OWNER, body: { text: '做一个衣柜', snapshot: {}, maxTokens: 10_000_000 } });
  ok('/api/ai/plan 同样拒超顶', plan.status === 400 && plan.json?.code === 'MAX_TOKENS_EXCEEDED', `status=${plan.status} ${plan.text.slice(0, 120)}`);
  const design = await api(M.port, '/api/ai/design', { token: T_OWNER, body: { text: '做一个衣柜', snapshot: {}, maxTokens: 10_000_000 } });
  ok('/api/ai/design 同样拒超顶', design.status === 400 && design.json?.code === 'MAX_TOKENS_EXCEEDED', `status=${design.status}`);
  ok('四个端点全被拒时上游总调用数仍为 0', up.rec.total === 0, `total=${up.rec.total}`);
  const rej = auditLines(M.auditPath).filter((l) => l.action === 'ai.call.rejected');
  ok('被拒的 AI 调用都进了审计（ai.call.rejected）', rej.length >= 3, `count=${rej.length}`);
}

// ═══════════════════════ ⑤ 环境变量只能收紧，不能提权 ═══════════════════════

section('⑤ AI_HARD_MAX_TOKENS 只能收紧硬顶，永远不能抬高到 cap 之上');
{
  const envFileB = join(TMP, '.env.b');
  writeFileSync(envFileB, `AI_BASE_URL=http://127.0.0.1:${upstreamPort}/v1\nAI_API_KEY=k\nAI_MODEL=m\n`, 'utf8');

  // 收紧到 1000（无账号 ⇒ local-open，AI 端点不要求登录，正好验证闸门本身）
  const tight = await startServer({ envFile: envFileB, extraEnv: { AI_HARD_MAX_TOKENS: '1000' } });
  const t1 = await api(tight.port, '/api/ai/chat', { body: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 2000 } });
  ok('把硬顶收到 1000 后，maxTokens=2000 → 400（环境变量可收紧）', t1.status === 400 && t1.json?.code === 'MAX_TOKENS_EXCEEDED', `status=${t1.status} ${t1.text.slice(0, 120)}`);
  ok('收紧后的 cap 如实回显为 1000', t1.json?.cap === 1000, JSON.stringify({ cap: t1.json?.cap }));
  const stT = await api(tight.port, '/api/settings', { method: 'GET' });
  ok('GET /api/settings 报告 maxTokensCap=1000（不是仍然 65536）', stT.json?.maxTokensCap === 1000, JSON.stringify({ cap: stT.json?.maxTokensCap }));
  up.rec.total = 0;
  const t2 = await api(tight.port, '/api/ai/chat', { body: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1000 } });
  ok('收紧后恰好 =1000 仍然放行（收紧的是上界，不是把功能关掉）', t2.status === 200 && up.rec.total === 1, `status=${t2.status} total=${up.rec.total}`);
  tight.child.kill();

  // 试图抬高到 99999999 → 必须仍是 65536
  const loose = await startServer({ envFile: envFileB, extraEnv: { AI_HARD_MAX_TOKENS: '99999999' } });
  const stL = await api(loose.port, '/api/settings', { method: 'GET' });
  ok('把 AI_HARD_MAX_TOKENS 写到 99999999，硬顶仍停在 65536（不能提权）', stL.json?.maxTokensCap === 65536, JSON.stringify({ cap: stL.json?.maxTokensCap }));
  up.rec.total = 0;
  const l1 = await api(loose.port, '/api/ai/chat', { body: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100000 } });
  ok('抬高失败后，maxTokens=100000 仍被拒（cap 没被撬开）', l1.status === 400 && l1.json?.code === 'MAX_TOKENS_EXCEEDED', `status=${l1.status}`);
  loose.child.kill();
}

// ═══════════════════════ ⑥ 源码纪律 ═══════════════════════

section('⑥ 源码纪律：闸门只有一处实现，旧的透传写法必须绝迹');
{
  const src = stripComments(readFileSync(join(root, 'server', 'server.mjs'), 'utf8'));
  ok('server.mjs 不再有 "body.maxTokens > 0 ? body.maxTokens : ..." 原值透传', !/body\.maxTokens\s*>\s*0\s*\?\s*body\.maxTokens/.test(src), '仍存在透传');
  const guards = (src.match(/enforceMaxTokens\(/g) ?? []).length;
  ok('enforceMaxTokens 出现次数 = 6（1 定义 + 4 AI 端点 + 1 设置写），一处实现', guards === 6, `count=${guards}`);
  ok('硬顶数值只从契约真源来（剥注释后 server.mjs 里没有裸写 65536）', !/\b65536\b/.test(src), '发现裸写的 65536');
  const aiContract = stripComments(readFileSync(join(root, 'shared', 'aiContract.mjs'), 'utf8'));
  ok('MAX_OUTPUT_TOKENS_CAP=65536 是唯一真源（仍在契约文件里）', /MAX_OUTPUT_TOKENS_CAP\s*=\s*65536/.test(aiContract), '契约里找不到');
  const admin = stripComments(readFileSync(join(root, 'src', 'ui', 'panels', 'AdminPanel.tsx'), 'utf8'));
  ok('AdminPanel 不再把 65536 当作输入上限的硬编码上界（改用服务端下发的 cap）', !/max=\{65536\}/.test(admin), '仍有 max={65536}');
}

// ───────────────────────── 收尾 ─────────────────────────

for (const c of children) {
  try {
    c.kill();
  } catch {}
}
for (const s of servers) {
  try {
    s.close();
  } catch {}
}
try {
  rmSync(TMP, { recursive: true, force: true });
} catch {}

console.log(`\nP10.0 安全前置验收：通过 ${pass} / 失败 ${fail}`);
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
