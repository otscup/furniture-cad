#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  局域网 / 内网 OpenAI 兼容端点实测（`npm run verify:lan`）
 *
 *  ── 为什么单独一个脚本、且**不进 verify:all** ──
 *    它依赖一个具体的局域网地址与一台具体的机器上的具体模型。
 *    并进常驻验收，等于让"代码有没有错"取决于"那台机器今天开没开机" ——
 *    那样的红不是信息，是噪音。它验的是**你的环境**，不是代码。
 *
 *  ── 它验的是链路，不是界面 ──
 *    起本地服务 → 直连端点 → 依次打真实的四个接口。
 *    三个重点：
 *      1. 能不能**拉**到模型（source=live，而不是退回内置清单）
 *      2. 连通性测试是否**真的验证了"这个模型会说话"**（而不是只 ping 通）
 *      3. 真实的一句话能不能走到**契约动作** —— 这是 AI 通路的全部价值
 *
 *  ── 为什么每一行都要打印耗时 ──
 *    推理模型的单次往返可能是十几秒。这个数字必须被看见：
 *    它是"界面要不要给等待反馈""超时该设多少"这些决定的唯一依据。
 *
 *  用法：node verify/lan-probe.mjs      （在 app/ 下）
 *        想要别的端口：PROBE_PORT=8796 node verify/lan-probe.mjs
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PROBE_PORT || 8795);
const BASE = `http://127.0.0.1:${PORT}`;

/** 单次请求上限 —— 推理模型慢，给足；但仍要有上限，否则脚本会挂死 */
const CALL_TIMEOUT_MS = Number(process.env.LAN_TIMEOUT_MS || 240000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `\n      ${detail}` : ''}`);
}
function note(msg) {
  console.log(`      ${msg}`);
}

// ───────────────────────── 读 .env（直连要用它） ─────────────────────────

function parseEnv(p) {
  if (!fs.existsSync(p)) return {};
  const out = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
const ENV_PATH = process.env.APP_ENV_PATH || path.join(ROOT, '.env');
const env = parseEnv(ENV_PATH);
const BASE_URL = (env.AI_BASE_URL || '').replace(/\/+$/, '');
const API_KEY = env.AI_API_KEY || '';
const MODEL = env.AI_MODEL || '';
const TIMEOUT_MS = Number(env.AI_TIMEOUT_MS || 0);

console.log('═'.repeat(62));
console.log('  局域网 AI 端点实测');
console.log('═'.repeat(62));
console.log(`  配置文件  ${ENV_PATH}`);
console.log(`  端点      ${BASE_URL || '(未配置)'}`);
console.log(`  模型      ${MODEL || '(未配置)'}`);
console.log(`  Key       ${API_KEY ? `**${API_KEY.slice(-4)}` : '(未配置)'}`);
console.log(`  超时设置  ${TIMEOUT_MS ? `${TIMEOUT_MS}ms` : '(用默认值)'}`);
console.log('');

/**
 * 出站请求一律绕开环境里的 HTTP 代理。
 *
 * 为什么必须显式做：这台机器上有 `HTTP_PROXY=http://127.0.0.1:5642`，
 * 而本服务要连的是**局域网**地址 —— 代理会把它当成外网域名去解析，直接失败。
 * Node 22 的 fetch 还不读代理变量，但 Node 24 起可以用 `NODE_USE_ENV_PROXY=1`
 * 打开；一旦有人打开，链路就会以一种极难排查的方式断掉。
 * 另外：把 API Key 交给一个不必要的第三方代理，本身就是不该发生的事。
 */
const NO_PROXY_ENV = { ...process.env };
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete NO_PROXY_ENV[k];
}
NO_PROXY_ENV.NO_PROXY = '*';
NO_PROXY_ENV.no_proxy = '*';

const api = async (p, init) => {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + p, { ...init, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    let body;
    const text = await r.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { __notJson: text.slice(0, 400) };
    }
    return { status: r.status, body, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, body: { error: e.name === 'TimeoutError' ? `超过 ${CALL_TIMEOUT_MS}ms` : e.message }, ms: Date.now() - t0 };
  }
};

// ───────────────────────────── 起服务 ─────────────────────────────

const procs = [];
const stop = () => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
};
process.on('exit', stop);

const server = spawn(process.execPath, ['server/server.mjs'], {
  cwd: ROOT,
  env: { ...NO_PROXY_ENV, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server._log = '';
server.stdout.on('data', (d) => (server._log += d));
server.stderr.on('data', (d) => (server._log += d));
procs.push(server);

const ping = () =>
  new Promise((resolve) => {
    const req = http.get(`${BASE}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1200, () => {
      req.destroy();
      resolve(false);
    });
  });

let up = false;
for (let i = 0; i < 30 && !up; i++) {
  up = await ping();
  if (!up) await sleep(400);
}
if (!up) {
  console.error(`\nERR: 本地服务未能在 12s 内起来（端口 ${PORT}）\n`);
  console.error(server._log.slice(-1200));
  process.exit(1);
}

/** 全局计数器，用于汇总 */
let n = 0;
const step = (t) => console.log(`\n── ${++n}. ${t} ──`);

// ═══════════════════════ ① 配置读取无误 ═══════════════════════

step('服务读到的配置（Key 只回后四位）');
const settings = await api('/api/settings');
check(
  '服务读到了局域网端点，且 Key 没有回传明文',
  settings.body.baseUrl === BASE_URL && settings.body.model === MODEL && /^\*+/.test(settings.body.apiKeyMasked ?? ''),
  `provider=${settings.body.provider} · baseUrl=${settings.body.baseUrl} · model=${settings.body.model} · key=${settings.body.apiKeyMasked}`
);
check(
  '整段配置响应里搜不到完整 Key',
  JSON.stringify(settings.body).includes(API_KEY) === false,
  `响应 ${JSON.stringify(settings.body).length} 字节，未出现 "${API_KEY.slice(0, 2)}…"`
);

// ═══════════════════════ ② 直连端点（区分"网不通"和"代码不对"） ═══════════════════════

step('直连端点（绕过本服务，证明网络本身是通的）');
{
  const t0 = Date.now();
  let direct = { ok: false, note: '' };
  try {
    const r = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(20000),
    });
    const body = await r.json().catch(() => null);
    const ids = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean) : [];
    direct = { ok: r.ok, status: r.status, ids };
  } catch (e) {
    direct = { ok: false, note: e.name === 'TimeoutError' ? '超时' : e.message };
  }
  check(
    `直连 ${BASE_URL}/models 成功`,
    direct.ok,
    direct.ok ? `HTTP ${direct.status} · ${Date.now() - t0}ms · 模型 ${JSON.stringify(direct.ids)}` : `失败：${direct.note ?? ''}`
  );
  check(
    `直连拿到的模型里有配置中的「${MODEL}」`,
    (direct.ids ?? []).includes(MODEL),
    `端点返回 ${(direct.ids ?? []).length} 个：${JSON.stringify(direct.ids)}`
  );
}

// ═══════════════════════ ③ 经本服务拉模型 ═══════════════════════

step('经本服务自动拉取模型（source 必须如实标注）');
const refresh = await api('/api/models/refresh', { method: 'POST' });
check(
  '拉取成功，且来源标注为 live（不是退回内置清单）',
  refresh.body.source === 'live' && (refresh.body.models ?? []).includes(MODEL),
  `source=${refresh.body.source} · ${refresh.ms}ms · ${JSON.stringify(refresh.body.models ?? refresh.body.error)}`
);

// ═══════════════════════ ④ 连通性测试的**语义** ═══════════════════════

step('连通性测试：它到底验证了什么？');
const test = await api('/api/test', { method: 'POST' });
check('测试返回 ok', test.body.ok === true, `ok=${test.body.ok} · ${test.ms}ms · ${JSON.stringify(test.body.error ?? '')}`);
note('下面是这条测试的完整结论 —— 注意它是否真的证明了"这个模型会说话"：');
note(JSON.stringify({ ok: test.body.ok, latencyMs: test.body.latencyMs, model: test.body.model, usage: test.body.usage, note: test.body.note }, null, 1).replace(/\n/g, '\n      '));

// ═══════════════════════ ⑤ 真实对话 ═══════════════════════

step('真实对话（/api/ai/chat）：这个模型到底会不会说话');
const chat = await api('/api/ai/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    messages: [
      { role: 'system', content: '你是定制家具设计软件的助手。回答要短。' },
      { role: 'user', content: '一句话：踢脚线一般多高？' },
    ],
  }),
});
{
  const text = String(chat.body.text ?? '');
  check('对话接口返回成功', chat.body.ok === true, `ok=${chat.body.ok} · ${chat.ms}ms · ${JSON.stringify(chat.body.error ?? '')}`);
  check(
    '正文非空（这才是"模型会说话"的证据）',
    text.trim().length > 0,
    text.trim() ? `正文 ${text.length} 字：「${text.slice(0, 120)}」` : '正文是**空的** —— 见下方 usage'
  );
  if (chat.body.usage) note(`usage: ${JSON.stringify(chat.body.usage)}`);
  if (!text.trim() && chat.body.usage?.completion_tokens) {
    note(
      `⚠ 正文为空但用掉了 ${chat.body.usage.completion_tokens} 个 completion token` +
        `${chat.body.usage.reasoning_tokens ? `（其中推理 ${chat.body.usage.reasoning_tokens}）` : ''}` +
        ' —— 这是推理模型把预算吃完的典型形态'
    );
  }
}

// ═══════════════════════ ⑥ 真实规划（AI 通路的全部价值） ═══════════════════════

step('真实规划（/api/ai/plan）：一句话 → 契约动作');
const { sampleProject } = await import(pathToFileURL(path.join(ROOT, 'src/core/docFactory.ts')).href);
const { buildSnapshot } = await import(pathToFileURL(path.join(ROOT, 'src/ai/snapshot.ts')).href);
const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/core/ruleset/factory-default.json'), 'utf8'));
const snapshot = buildSnapshot(sampleProject(rules), rules);
note(`快照：${snapshot.cabinets.length} 个柜体 · ${snapshot.materials.length} 种材质 · ${new TextEncoder().encode(JSON.stringify(snapshot)).length} 字节`);

const ASK = '把主卧衣柜的踢脚高度改成 120mm';
const plan = await api('/api/ai/plan', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: ASK, snapshot }),
});
{
  const actions = plan.body.actions ?? [];
  check('规划接口返回成功', plan.body.ok === true, `ok=${plan.body.ok} · ${plan.ms}ms · ${JSON.stringify(plan.body.error ?? '')}`);
  check(
    '返回了至少一条契约动作',
    actions.length > 0,
    actions.length
      ? actions.map((a) => `${a.action}(${JSON.stringify(a.params)})`).join(' · ')
      : `返回 0 条动作。reply=${JSON.stringify(plan.body.reply ?? '')} raw=${JSON.stringify((plan.body.raw ?? '').slice(0, 200))}`
  );
  check(
    '动作落在"改踢脚"这件事上',
    actions.some((a) => a.action === 'cabinet.setBodyLift' && Number(a.params?.mm) === 120),
    JSON.stringify(actions.map((a) => ({ action: a.action, params: a.params })))
  );
  if (plan.body.reply) note(`AI 的说明：「${String(plan.body.reply).slice(0, 200)}」`);
  if (plan.body.usage) note(`usage: ${JSON.stringify(plan.body.usage)}`);
  if (plan.body.rejected?.length) note(`被拒动作：${JSON.stringify(plan.body.rejected)}`);
}

// ═══════════════════════════ 汇总 ═══════════════════════════

stop();

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log('\n' + '='.repeat(62));
console.log(`局域网端点实测：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const r of results.filter((x) => !x.pass)) console.log(`  · ${r.name}`);
  process.exitCode = 1;
} else {
  console.log('\n链路成立：拉模型 / 连通性 / 对话 / 规划四条路都通了。');
}
