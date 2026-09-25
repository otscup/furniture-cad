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
import { createMockServer } from './mock-openai.mjs';

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
    // 邮箱注册验收走落盘发信模式：不碰真 SMTP，验证码写到这个文件里供探针读取
    'SMTP_MODE=file',
    `SMTP_FILE_OUT=${path.join(TMP, 'memory', 'outbox.jsonl')}`,
    'SMTP_FROM=cad-verify@example.com',
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

// mock 服务商抽成了 verify/mock-openai.mjs —— 与 B37 用的是同一份，
// 否则"AI 到底回了什么"会在两处漂移。两条通道（规划 / 对话）都在里面。
const mock = createMockServer();
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

/**
 * 开跑前先确认端口没人占。
 *
 * 踩过一次，代价是**整次验收都在跑假**：上次跑留下的一台旧服务先占住了
 * 本地服务端口，这次新起的进程直接 EADDRINUSE 退出，而 `waitUp()` 探到的
 * 200 是**那台旧服务**回的 —— 于是探针一路打在旧构建上，
 * 得到的"通过"与这次改动毫无关系，页面上却显示全绿。
 * 这比断言写错更危险：写错的断言会红，跑在错的服务上不会。
 *
 * vite 那边有 `--strictPort`，占位会直接报错；本地服务没有这道保险。
 */
const assertPortFree = async (port, who) => {
  if (await ping(`http://127.0.0.1:${port}/api/health`)) {
    console.error(
      `\nERR: ${who} 端口 ${port} 已经被占住 —— 十有八九是上次跑残留的旧服务。` +
        `\n     它跑的是**旧代码**，这一轮验收会打在它身上，结论全是假的。` +
        `\n     先把它收掉（Windows：netstat -ano | findstr :${port}，再 taskkill //PID <pid> //F），再重跑。\n`
    );
    process.exit(1);
  }
};
await assertPortFree(API_PORT, '本地服务');

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
/**
 * 探针开始前，先确认**这一轮自己拉起的那台服务还活着**。
 *
 * 上面那道端口检查挡的是"别人占着"，这道挡的是"自己这台半路死了"：
 * 服务崩了而端口还没被回收时，`waitUp` 照样探到 200（旧连接仍在 TIME_WAIT
 * 或内核还没释放），接着整轮验收打在一台死服务上。
 * 活着的判据用 `exitCode`/`signalCode` —— 不用 ping，ping 只会让人更放心。
 */
if (api.exitCode !== null || api.signalCode !== null) {
  console.error(`\nERR: 本地服务在验收开始前就已经退出（exit=${api.exitCode} signal=${api.signalCode}）：`);
  console.error(api._log.slice(-1500));
  stop();
  process.exit(1);
}

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
    VERIFY_SMTP_OUTBOX: path.join(TMP, 'memory', 'outbox.jsonl'),
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
