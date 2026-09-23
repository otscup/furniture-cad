#!/usr/bin/env node
/**
 * 一条命令跑完浏览器端验收：起本地服务 + dev server → 跑探针 → 全部收掉。
 *
 * 为什么不让用户手动开终端：Windows 上很容易出现
 * "vite 起来了但探针连的是上一次留下的僵尸端口" 这类假失败。
 * 把生命周期绑在一起，验收结果就只有"真"和"假"，没有"环境不对"。
 *
 * 为什么本地服务（server/server.mjs）也要由这里拉起：
 *  1. 「管理后台」面板在没有服务时会走"未启动"分支 —— 那条分支只证明了
 *     界面对故障是诚实的，没证明它能连上。两件事都得验。
 *  2. 服务必须跑在**独立端口 + 临时 .env / 临时记忆文件**上：
 *     否则一次验收就会把 app/.env 里的真 key 改写掉、把仓库里的
 *     memory/corrections.jsonl 覆盖成浏览器时间戳版本。
 *  3. 临时 .env 里放一个**假 key**（sk-verify-…）。这样"保存 → 只回后四位"
 *     "自动拉取模型失败必须如实说失败"两条断言才有确定的期望值，
 *     而且永远不会拿用户的真 key 去发请求。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.APP_PORT || 5273);
const CDP_PORT = Number(process.env.CDP_PORT || 6273);
const API_PORT = Number(process.env.API_PORT || 8791);

// vite 的 package.json 没有导出 ./bin/vite.js，只能按真实路径找（vite 8 / rolldown 同样是这个布局）
const viteJs = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
if (!fs.existsSync(viteJs)) {
  console.error(`ERR: 找不到 ${viteJs}，请先在 app/ 下执行 npm install`);
  process.exit(1);
}

const TMP = path.join(os.tmpdir(), `furniture-cad-verify-${Date.now()}`);
const TMP_ENV = path.join(TMP, 'env', '.env');
const TMP_MEM = path.join(TMP, 'memory', 'corrections.jsonl');
/**
 * 账号库与审计日志也必须落在临时目录。
 *
 * 不这么做的后果很具体：验收里要真的**建一个账号**（那正是"上线前的账号体系"
 * 唯一值得验的地方），默认路径是 app/memory/accounts.json —— 于是每跑一次验收，
 * 仓库里就多出一个所有者账号、一份假的登录历史。那不只是脏，是**危险**：
 * 下次真在自己机器上启动时，服务会以为"已经有账号了"，直接把注册窗口关掉，
 * 而那个账号的口令是验收脚本随手写的。
 */
const TMP_ACCOUNTS = path.join(TMP, 'memory', 'accounts.json');
const TMP_AUDIT = path.join(TMP, 'memory', 'audit.jsonl');
fs.mkdirSync(path.dirname(TMP_ENV), { recursive: true });
fs.mkdirSync(path.dirname(TMP_MEM), { recursive: true });

/** 探针与这里必须用同一个假 key —— 通过环境变量传过去，避免两处各写一遍漂移 */
const FAKE_KEY = 'sk-verify-000111222333444';
/** 验收过程中"从界面上填进去"的那个：用来验证保存链路 + 只回后四位 */
const FAKE_KEY2 = 'sk-verify-second-9998887776665555';
fs.writeFileSync(
  TMP_ENV,
  [
    '# 自动化验收专用配置（临时目录，验收结束即丢弃）',
    'AI_PROVIDER=deepseek',
    'AI_BASE_URL=https://api.deepseek.com/v1',
    'AI_MODEL=deepseek-chat',
    'AI_API_KEY=' + FAKE_KEY,
    'AI_TEMPERATURE=0.2',
    // 假 key 必然被服务商拒绝。压短超时，让"拉取失败必须如实说失败"这条断言
    // 在无网络的环境下也能快速收敛，而不是把验收卡 20 秒。
    'AI_TIMEOUT_MS=6000',
    '',
  ].join('\n'),
  'utf8'
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitUp(url, timeoutMs) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    if (await ping(url)) return true;
    await sleep(400);
  }
  return false;
}

const procs = [];
function spawnProc(name, args, env) {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
  p._log = '';
  p.stdout.on('data', (d) => (p._log += d));
  p.stderr.on('data', (d) => (p._log += d));
  p._name = name;
  procs.push(p);
  return p;
}

// ══════════════════════════════════════════════════════════════════
//  mock 服务商 —— 一个"任何 OpenAI 兼容端点"的替身
//
//  为什么必须有它：AI 通路要验的是**整条链真的能跑通**
//  （说一句话 → 计划 → 干跑预览 → 应用 → 模型真的变了），
//  而真服务商需要真 key、真网络、且回复不可复现。用假 key 打真服务商
//  只能验"失败路径"，验不了成功路径 —— 而成功路径才是这条功能的全部价值。
//
//  它只实现 `/v1/chat/completions`，**不实现 `/v1/models`**：
//  这条 404 是故意的，管理后台那组断言（"拉取失败必须如实说失败"）
//  依赖它保持失败语义。两种场景互不干扰。
//
//  mock 的计划从**请求里带的快照**推出来（读 cabinets[0] 现在的踢脚高），
//  所以它不依赖种子的具体数值，模型被前面的用例改过也照样对得上。
// ══════════════════════════════════════════════════════════════════
const MOCK_PORT = Number(process.env.MOCK_PORT || 8792);
const MOCK_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

function mockPlan(ask, snap) {
  const cab = snap?.cabinets?.[0];
  if (!cab) return { reply: '快照里没有柜体，我不知道该改谁。', actions: [] };
  const name = cab.name;
  if (ask.includes('越界')) {
    // 负例：第二条动作故意多带一个契约里没有的参数 volume
    return {
      reply: '两条动作：把踢脚改成 140，再改个名。第二条我故意多写了一个参数。',
      actions: [
        { action: 'cabinet.setBodyLift', target: { cabinetName: name }, params: { mm: 140 }, reason: '用户要求踢脚 140' },
        { action: 'cabinet.rename', target: { cabinetName: name }, params: { name: `${name}·越界`, volume: 3 }, reason: '顺手改名（多带一个参数）' },
      ],
    };
  }
  const lift = Math.round(cab.params.bodyLift);
  const to = lift === 120 ? 100 : 120;
  return {
    reply: `把「${name}」的踢脚从 ${lift} 改成 ${to}，并把它改名为「${name}·AI」。`,
    actions: [
      { action: 'cabinet.setBodyLift', target: { cabinetName: name }, params: { mm: to }, reason: `用户要求踢脚 ${to}` },
      { action: 'cabinet.rename', target: { cabinetName: name }, params: { name: `${name}·AI` }, reason: '用户要求改个名字' },
    ],
  };
}

/**
 * mock 的**对话**回答。
 *
 * ── 为什么必须把两条通道分开 ──
 *   `/api/ai/plan` 的 user 消息里带 `【用户这一句要求】` 标记 + 一个 ```json 快照块；
 *   `/api/ai/chat` 的 user 消息**就是用户原话**（快照在 system 消息里）。
 *
 *   早先这个 mock 只认规划请求：对话请求进来后 `ask` 是空串、`snap` 是 null，
 *   于是它老老实实回了一句"快照里没有柜体，我不知道该改谁" —— 而那其实是一次提问。
 *   **通道没分开，mock 就会给出"看起来有回答、其实答错了题"的东西**，
 *   而这类"假成功"比直接报错更难发现。
 *
 * 顺带回一个 `reasoning_content`：推理模型的思考过程是要在界面上折叠显示的，
 * 没有这个字段那条路就永远验不到。
 */
function mockChat(userText) {
  return {
    content: `（mock 回答）你问的是「${userText.slice(-40)}」。这条通道只回答问题，不会修改模型。`,
    reasoning: '先把用户这句话归一下类：它走的是对话通道而不是规划通道，所以按提问处理；答复里要明确说清"不改模型"。',
  };
}

/**
 * 故意慢一点再回。
 *
 * 为什么需要这个延迟：要验证的是"等待期间界面有没有如实告诉用户它在等"。
 * mock 秒回的话，那个状态在探针能读到之前就已经结束了 ——
 * 于是这条断言只能写成"存在即可"（恒真），等于没验。
 * 800ms 足够探针在下一次读取时抓到"AI 正在思考… 1s"这个中间态。
 */
const MOCK_DELAY_MS = Number(process.env.MOCK_DELAY_MS || 800);

const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = (req.url || '').split('?')[0];
    if (!url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `mock 只实现了 /chat/completions，收到的是 ${url}` } }));
      return;
    }
    let envelope = {};
    try {
      envelope = JSON.parse(raw || '{}');
    } catch {
      /* 元数据读不出来也照样回，验的是计划而不是解析 */
    }
    const msgs = envelope.messages || [];
    const user = msgs.find((m) => m.role === 'user')?.content || '';
    /** 通道判定：只有规划通道的 user 消息带这个标记 */
    const isPlan = /【用户这一句要求】/.test(user);

    let message;
    let usage;
    if (isPlan) {
      const snapM = /```json\s*([\s\S]*?)```/.exec(user);
      let snap = null;
      try {
        snap = snapM ? JSON.parse(snapM[1]) : null;
      } catch {
        /* 快照读不出来 → mockPlan 会如实说"我不知道该改谁" */
      }
      const ask = (user.split('【用户这一句要求】')[1] || '').trim();
      message = { role: 'assistant', content: JSON.stringify(mockPlan(ask, snap)) };
      usage = { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 };
    } else {
      const { content, reasoning } = mockChat(user);
      message = { role: 'assistant', content, reasoning_content: reasoning };
      usage = { prompt_tokens: 92, completion_tokens: 44, total_tokens: 136, reasoning_tokens: 19 };
    }

    const payload = {
      id: `chatcmpl-mock-${isPlan ? 'plan' : 'chat'}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-model-1',
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage,
    };
    const text = JSON.stringify(payload);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
      res.end(text);
    }, MOCK_DELAY_MS);
  });
});
await new Promise((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
console.log(`mock    : ${MOCK_URL} 就绪（两条通道：规划 / 对话；故意不实现 /models）`);
mock._name = 'mock';

/**
 * 回收**历次运行**留下的残留。
 *
 * 为什么需要它：`stop()` 挂在 `process.on('exit')` 上，但验收脚本被杀
 * （SIGINT / 浏览器崩 / 终端关掉）时**根本走不到 exit hook**，
 * 于是每崩一次就在 `%TEMP%` 下攒一个目录 —— 里面还躺着一个假 key 的 `.env`。
 * 实测攒过 9 个。清理逻辑不能只在"顺利跑完"这条路径上生效。
 *
 * 只在 `furniture-cad-*` 这个本工具独占的命名空间里动手，且只碰**超过 6 小时**的：
 * 这样既收得掉陈旧垃圾，也不会误伤另一个正在并发运行的验收。
 */
const sweepOldTmp = () => {
  try {
    const parent = os.tmpdir();
    const now = Date.now();
    const SIX_HOURS = 6 * 3600 * 1000;
    for (const name of fs.readdirSync(parent)) {
      if (!/^furniture-cad-(verify|ai|cdp)/.test(name)) continue;
      const full = path.join(parent, name);
      if (full === TMP) continue;
      const m = /-(\d{13})$/.exec(name);
      let age;
      try {
        age = m ? now - Number(m[1]) : now - fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      if (age > SIX_HOURS) fs.rmSync(full, { recursive: true, force: true });
    }
  } catch {
    /* 收不掉只说明留了点垃圾，不影响验收结论 */
  }
};

const stop = () => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  try {
    mock.close();
  } catch {
    /* already closed */
  }
  // 临时目录里放着一个假 key 的 .env 和一份临时记忆文件，跑完就带走。
  // 删不掉也不影响结论（只是留了点垃圾），所以失败不抛。
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 被 safe-delete 保护层拦下也没关系 */
  }
  sweepOldTmp();
};
process.on('exit', stop);

// ── 1. 本地 Node 服务（管理后台的后端）──
const api = spawnProc('server', ['server/server.mjs'], {
  ...process.env,
  PORT: String(API_PORT),
  APP_ENV_PATH: TMP_ENV,
  APP_MEM_PATH: TMP_MEM,
  APP_ACCOUNTS_PATH: TMP_ACCOUNTS,
  APP_AUDIT_PATH: TMP_AUDIT,
});
const apiUrl = `http://127.0.0.1:${API_PORT}/api/health`;
if (!(await waitUp(apiUrl, 15000))) {
  console.error(`ERR: 本地服务未能在 15s 内起来（端口 ${API_PORT}）`);
  console.error(api._log.slice(-1500));
  stop();
  process.exit(1);
}
console.log(`server  : ${apiUrl} 就绪（临时数据目录 ${TMP}）`);

// ── 2. vite dev server ──
const vite = spawnProc('vite', [viteJs, '--port', String(PORT), '--host', '127.0.0.1', '--strictPort'], {
  ...process.env,
  API_PORT: String(API_PORT),
});

const base = `http://127.0.0.1:${PORT}/`;
if (!(await waitUp(base, 30000))) {
  console.error(`ERR: vite 未能在 30s 内起来（端口 ${PORT}）`);
  console.error(vite._log.slice(-1500));
  stop();
  process.exit(1);
}
console.log(`vite    : ${base} 就绪`);

// ── 3. 探针 ──
const probe = spawn(process.execPath, ['verify/browser-probe.cjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    APP_PORT: String(PORT),
    CDP_PORT: String(CDP_PORT),
    API_PORT: String(API_PORT),
    EXPECT_API: '1',
    VERIFY_ENV_PATH: TMP_ENV,
    VERIFY_MEM_PATH: TMP_MEM,
    VERIFY_ACCOUNTS_PATH: TMP_ACCOUNTS,
    VERIFY_AUDIT_PATH: TMP_AUDIT,
    VERIFY_FAKE_KEY: FAKE_KEY,
    VERIFY_FAKE_KEY2: FAKE_KEY2,
    VERIFY_MOCK_URL: MOCK_URL,
  },
});

const code = await new Promise((resolve) => probe.on('exit', (c) => resolve(c ?? 1)));
stop();

if (code !== 0) {
  console.log('\nvite 最近输出（排查用）：');
  console.log(vite._log.split('\n').slice(-12).join('\n'));
  console.log('\nserver 最近输出（排查用）：');
  console.log(api._log.split('\n').slice(-12).join('\n'));
}
process.exit(code);
