#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  本地服务 —— 管理后台后端 · AI 规划通道 · 账号与额度 · 未来的 DXF 导出落点
 *
 *  零依赖（只用 node:http / node:fs / node:crypto / 全局 fetch），因为：
 *   · 这台机器没有 VPS，服务就是本机的一个进程，装依赖是纯负担
 *   · Fastify 等框架等真的需要路由/校验时再引入，现在不需要
 *
 *  ── 安全底线（从第一版起没变，改代码的人先读这三条）──
 *   1. 只监听 127.0.0.1，**绝不 bind 0.0.0.0**。
 *      绑 0.0.0.0 意味着同一个 WiFi 下任何人都能调用你的 API Key。
 *      上线时正确做法是反代 + TLS 终止，而不是把本进程暴露出去。
 *   2. API Key 只存在服务端文件里，HTTP 响应里永远只回**后四位**。
 *      前端拿不到完整 key —— 纯前端保管 key 等于把 key 发给浏览器。
 *   3. 一旦存在账号，**所有** /api 接口都要 Bearer token。没有"忘记加鉴权"的接口。
 *      鉴权判定集中在 `requireAuth()` 一处，不在每个 handler 里各写一遍。
 *
 *  ── 两种模式 ──
 *   local-open  还没有任何账号。全部接口免 token，行为与"没有账号体系"时一致。
 *   accounts    存在账号。除健康检查与注册/登录外全部要求 token。
 *   切换是单向的：建了第一个账号就回不去 —— 这是有意的，避免"删了账号库就绕过鉴权"。
 *
 *  ── 关于"自动拉取模型" ──
 *    内置清单是**静态的，一定会过期**。所以：
 *      · 内置清单只用于离线可用 / 探测失败时的兜底
 *      · 真正的权威来源是服务商的 GET {baseUrl}/models
 *      · 响应里必须带 source 字段（live / builtin），让界面如实告诉用户
 *        "这是服务商实时返回的" 还是 "这是内置的旧清单，可能已过期"
 * ══════════════════════════════════════════════════════════════════════
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, createReadStream, mkdtempSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { AuthStore, PLANS, ROLES, securityPolicy } from './auth.mjs';
import { auditCsv } from './auditCsv.mjs';
import { csvCell } from './csvCell.mjs';
import * as mailer from './mailer.mjs';
import { RegistrationStore, EMAIL_RE } from './registration.mjs';
import { buildChatRequest, extractJson, validatePlan, DEFAULT_MAX_TOKENS } from '../shared/aiContract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');

/**
 * 数据落点可以外部覆盖（APP_ENV_PATH / APP_MEM_PATH / APP_ACCOUNTS_PATH / APP_AUDIT_PATH）。
 *
 * 这不是为了测试便利而留的后门 —— 它本身就是必需的配置项：
 *   · 换一台机器 / 换一个项目目录，配置和记忆不该跟着代码走
 *   · 自动化验收必须在**临时目录**里跑，否则一次验收就把仓库里的
 *     memory/corrections.jsonl 覆盖成浏览器里的时间戳版本，diff 全是噪音，
 *     更糟的是会往真实账号库里塞测试账号
 * 默认值与之前完全一致，不设这些变量时行为不变。
 */
const ENV_PATH = process.env.APP_ENV_PATH ? resolve(process.env.APP_ENV_PATH) : join(ROOT, '.env');
const MEM_PATH = process.env.APP_MEM_PATH ? resolve(process.env.APP_MEM_PATH) : join(ROOT, 'memory', 'corrections.jsonl');
const ACCOUNTS_PATH = process.env.APP_ACCOUNTS_PATH ? resolve(process.env.APP_ACCOUNTS_PATH) : join(ROOT, 'memory', 'accounts.json');
const AUDIT_PATH = process.env.APP_AUDIT_PATH ? resolve(process.env.APP_AUDIT_PATH) : join(ROOT, 'memory', 'audit.jsonl');
const REGISTRATIONS_PATH = process.env.APP_REGISTRATIONS_PATH ? resolve(process.env.APP_REGISTRATIONS_PATH) : join(ROOT, 'memory', 'pending-registrations.json');
const MEM_DIR = dirname(MEM_PATH);
const DIST = join(ROOT, 'dist');

// ── 导出链路的外部程序 ──
const EMIT_NEUTRAL_TS = join(ROOT, 'scripts', 'emit-neutral.ts');
const EMIT_ROOMBOOK_TS = join(ROOT, 'scripts', 'emit-roombook.ts');
const EXPORT_DXF_PY = join(ROOT, 'py', 'export_dxf.py');

/**
 * Python 解释器：优先环境变量，其次项目根的 .venv（spike 用的就是它，ezdxf 装在那里）。
 * 找不到就如实报错，不许"假装导出成功"。
 */
function pythonExe() {
  // 注意 .venv 在**项目根**，不是 app/ 下（ROOT = app）。spike/run.sh 用的也是 ../.venv。
  const cand = [
    process.env.APP_PYTHON,
    join(ROOT, '.venv', 'Scripts', 'python.exe'),
    join(ROOT, '..', '.venv', 'Scripts', 'python.exe'),
    join(ROOT, '..', '.venv', 'bin', 'python'),
    'python',
  ]
    .filter(Boolean)
    // 显式给的路径必须真的存在才用；裸命令名（'python'）无法 existsSync，直接保留作兜底
    .filter((c) => (c.includes('/') || c.includes('\\') ? existsSync(c) : true));
  return cand[0] ?? 'python';
}

/** 跑一个子进程并收齐 stdout/stderr。cwd 固定到项目根，相对路径才不会飘。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, ...opts });
    let out = '';
    let err = '';
    if (opts.input !== undefined) p.stdin.end(opts.input);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} 退出码 ${code}：${(err || out).slice(0, 600)}`))
    );
  });
}

const PORT = Number(process.env.PORT ?? 8787);
/**
 * 监听地址：默认**只绑回环**（127.0.0.1）——本地优先，接口不出网。
 * 这是安全模型的一部分（无 TLS、JSON 文件存储都建立在"不出网"的前提上），
 * 所以没有 APP_HOST 显式指定时绝不变。容器化部署是唯一例外：
 * Docker 的端口发布要求进程绑 0.0.0.0（容器网络边界由 Docker NAT 承担，
 * 公网 TLS 必须由前置反代终止——见 DEPLOY.md）。非回环启动时横幅会大声警告。
 */
const HOST = process.env.APP_HOST?.trim() || '127.0.0.1';
const IS_LOOPBACK = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';

/**
 * ── 「只监听 127.0.0.1」管的是**入站**，和"能不能连局域网的模型"是两件事 ──
 *
 *   入站（别人连我们）：只绑回环 —— 同一个 WiFi 下没有第二个人能调用我们的接口。
 *   出站（我们连别人）：**不受任何限制**。要连 `http://192.168.2.2:3002/v1`
 *                       这样的局域网端点，直接连就行。
 *
 *   把这两件事混起来的人会得出一个错误的结论："接了局域网模型就得 bind 0.0.0.0"——
 *   那等于把本机的全部接口连同 API Key 一起敞开给整个局域网，
 *   而换来的东西（能连内网模型）**本来就不需要它**。
 *
 * ── 顺带一个真实的坑：环境里的 HTTP 代理 ──
 *   这台机器上设了 `HTTP_PROXY=http://127.0.0.1:5642`。要连的如果是**局域网**地址，
 *   代理会把它当外网域名去解析，结果是"明明通、却报连不上"，排查起来极费时间
 *   （实测：命令行用的 curl 走了代理，拿到一个假的 502；而服务进程内的 fetch 没走，
 *   直连是 200 —— 同一条地址、同一分钟、两个相反的结果）。
 *   更别说把 API Key 交给一个非必要的第三方代理本来就不该发生。
 *
 *   Node 22 的 fetch 不读这些变量，所以下面这几行现在**是空操作**；
 *   但 Node 24 起可以用 `NODE_USE_ENV_PROXY=1` 打开，一旦有人打开，链路就会静默断掉。
 *   与其等那一天，不如在这里一次性切断 —— 这个进程的出站只该有一条路：直连。
 */
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  delete process.env[k];
}

/**
 * 账号库加载失败时**直接退出**，不降级。
 *
 * 降级意味着"文件坏了 = 系统不设防"，任何人打开页面又成了主人。
 * 启动失败很吵、但看得见；静默降级很安静、但没救。
 */
let auth;
try {
  auth = new AuthStore({ accountsPath: ACCOUNTS_PATH, auditPath: AUDIT_PATH });
} catch (e) {
  console.error(`\n[致命] ${e.message}\n`);
  console.error('账号库是鉴权的唯一依据，损坏时无法安全运行。请修复或移走该文件后重启。');
  process.exit(1);
}

/** 邮箱注册验证码库 —— 损坏同样拒绝启动（清零重来等于绕过限频） */
let registrations;
try {
  registrations = new RegistrationStore({ storePath: REGISTRATIONS_PATH, audit: (e) => auth.audit(e) });
} catch (e) {
  console.error(`\n[致命] ${e.message}\n`);
  console.error('注册验证码库损坏会破坏注册限频的公正性，请修复或移走该文件后重启。');
  process.exit(1);
}


const PROVIDERS = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o4-mini'] },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  moonshot: {
    label: 'Moonshot 月之暗面',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'],
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
  },
  dashscope: {
    label: '阿里通义千问（兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct'],
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-4', 'google/gemini-2.5-pro'],
  },
  ollama: { label: 'Ollama（本机）', baseUrl: 'http://127.0.0.1:11434/v1', models: ['qwen2.5:14b', 'llama3.1:8b'] },
  /**
   * 局域网 / 内网端点（单独一档，不让人去凑合填「自定义」）。
   *
   * 见过很多形态 —— vLLM、Ollama、LM Studio、one-api / new-api / gpt-load 这类网关、
   * 公司内网的模型服务 —— 但它们**都是 OpenAI 兼容的**，配置动作完全一样，
   * 只有地址不同。所以值得单列一档并给出正确的心理预期：
   *
   *   · 不需要 HTTPS、不需要出网 —— `http://192.168.x.x:端口/v1` 是正常形态
   *   · 常见故障和云端**相反**：不是"Key 不对"，多是"IP 不通"或"被代理挡了"
   *   · 模型清单一定**用「⟳ 自动拉取」拿** —— 内网挂的模型名无从预设
   *   · 若那台机器挂的是**推理模型**，单次可能要十几秒，注意 AI_TIMEOUT_MS 与 AI_MAX_TOKENS
   */
  lan: {
    label: '局域网 / 内网（OpenAI 兼容）',
    baseUrl: '',
    models: [],
  },
  custom: { label: '自定义（OpenAI 兼容端点）', baseUrl: '', models: [] },
};

// ───────────────────────────── .env 读写 ─────────────────────────────

function readEnv() {
  if (!existsSync(ENV_PATH)) return {};
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

function writeEnv(patch) {
  const cur = readEnv();
  const next = { ...cur, ...patch };
  const lines = [
    '# 家具 CAD 本地服务配置 —— 这个文件不要提交到 git',
    '# API Key 只留在这里；前端只能看到后四位',
    '',
    ...Object.entries(next)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`),
    '',
  ];
  writeFileSync(ENV_PATH, lines.join('\n'), 'utf8');
  return next;
}

/** 只回后四位 —— 前端永远拿不到完整 key */
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 4) return '****';
  return `${'*'.repeat(Math.min(8, k.length - 4))}${k.slice(-4)}`;
}

function currentSettings() {
  const env = readEnv();
  const provider = env.AI_PROVIDER || 'deepseek';
  const preset = PROVIDERS[provider] ?? PROVIDERS.custom;
  return {
    provider,
    providerLabel: preset.label,
    baseUrl: env.AI_BASE_URL || preset.baseUrl,
    model: env.AI_MODEL || preset.models[0] || '',
    apiKeyMasked: maskKey(env.AI_API_KEY),
    apiKeySet: Boolean(env.AI_API_KEY),
    temperature: Number(env.AI_TEMPERATURE ?? 0.2),
    /** 输出预算。推理模型上这个值直接决定"有没有正文" —— 所以它必须可见、可改 */
    maxTokens: Number(env.AI_MAX_TOKENS ?? DEFAULT_MAX_TOKENS),
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 60000),
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, baseUrl: v.baseUrl, models: v.models }])),
    envPath: ENV_PATH,
  };
}

// ───────────────────────────── HTTP 工具 ─────────────────────────────

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, body) {
  cors(res);
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw new Error('请求体超过 4MB');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw };
  }
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ───────────────────────────── 鉴权 ─────────────────────────────

/**
 * 免鉴权白名单（**精确**匹配，不用前缀 —— 前缀匹配是"忘记加鉴权"的温床）。
 * 只有在 accounts 模式下才有意义；local-open 模式下一切都不需要 token。
 */
const PUBLIC_API = new Set([
  '/api/health',
  '/api/auth/register',
  '/api/auth/register-email',
  '/api/auth/register-email/verify',
  '/api/auth/login',
  '/api/auth/mode',
]);

/** 取 Bearer token */
function bearer(req) {
  const h = req.headers?.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : '';
}

/** 客户端标识：只用于审计，不做信任判断 */
function clientMeta(req) {
  return { ip: req.socket?.remoteAddress ?? '', ua: req.headers?.['user-agent'] ?? '' };
}

/**
 * 唯一的鉴权判定入口。
 *
 * 返回 { ok } 或 { ok:false, code, error }。**所有** handler 都必须过这里，
 * 不许出现"这个接口反正是只读的，先不加了"——那就是漏洞的起点。
 */
function requireAuth(req, res, pathname, opts = {}) {
  if (!auth.enabled) {
    // local-open：没有账号，就没有鉴权对象。如实把模式摆在响应里，不让界面猜。
    return { ok: true, account: null, mode: 'local-open' };
  }
  if (PUBLIC_API.has(pathname)) return { ok: true, account: null, mode: 'accounts' };
  const token = bearer(req);
  const acc = auth.authenticate(token);
  if (!acc) {
    json(res, 401, { ok: false, error: '未登录或会话已过期', code: 'UNAUTHORIZED', mode: 'accounts' });
    return { ok: false };
  }
  if (opts.manage && !ROLES[acc.role]?.canManage) {
    json(res, 403, { ok: false, error: `身份「${ROLES[acc.role]?.label ?? acc.role}」不能执行管理操作`, code: 'FORBIDDEN' });
    return { ok: false };
  }
  if (opts.design && !ROLES[acc.role]?.canDesign) {
    json(res, 403, { ok: false, error: '只读账号不能修改模型', code: 'FORBIDDEN' });
    return { ok: false };
  }
  return { ok: true, account: acc, token, mode: 'accounts' };
}

// ───────────────────────────── 路由 ─────────────────────────────

async function handleApi(req, res, pathname) {
  const env = readEnv();
  const s = currentSettings();

  // ── 鉴权前置：除白名单外一律先过门（管理模式额外要求 canManage）──
  const managePaths = pathname.startsWith('/api/account/') || pathname.startsWith('/api/security/');
  const gate = requireAuth(req, res, pathname, { manage: managePaths });
  if (!gate.ok) return;
  const actor = gate.account ? gate.account.id : null;

  if (pathname === '/api/health' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      service: 'furniture-cad-local',
      version: '0.1.0',
      host: HOST,
      port: PORT,
      envFileExists: existsSync(ENV_PATH),
      memoryFile: existsSync(MEM_PATH),
      authMode: auth.mode,
      accountCount: auth.data.accounts.length,
      /** 数据目录可写性。写不进去时登录照样 200，这里必须能被机器查见 */
      dataWritable: DATA_WRITABLE,
      time: new Date().toISOString(),
    });
  }

  if (pathname === '/api/auth/mode' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      mode: auth.mode,
      accountCount: auth.data.accounts.length,
      /** 注册入口开关：local-open 时邮箱注册天然可用（建的就是 owner）；账号模式下由管理员控制 */
      signupOpen: !auth.enabled || readEnv().SIGNUP_OPEN === '1',
      note:
        auth.mode === 'local-open'
          ? '还没有账号。此时全部接口免登录 —— 这是"先自用"的默认状态。建立第一个账号后，所有接口都会要求登录，且不可回退。'
          : '已启用账号体系：除健康检查与登录/注册外，所有接口都要求 Bearer token。',
    });
  }

  // ───────────────────────── 账号：注册 / 登录 / 会话 ─────────────────────────

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    const body = await readBody(req);
    /**
     * 自助注册的窗口**只有一次**：没有任何账号时。
     * 之后建账号必须由 owner/admin 操作（走 /api/account/accounts）。
     * 否则"注册接口"等于一个后门。
     */
    if (auth.enabled) return json(res, 403, { ok: false, error: '已存在账号，新建账号请由管理员在「账号与安全」里操作', code: 'REGISTER_CLOSED' });
    const r = auth.create({
      username: body.username,
      password: body.password,
      displayName: body.displayName,
      actor: 'bootstrap',
    });
    if (!r.ok) return json(res, 400, { ok: false, error: r.error });
    const l = auth.login(body.username, body.password, clientMeta(req));
    return json(res, 200, { ok: true, account: r.account, token: l.token ?? null, expiresAt: l.expiresAt ?? null, mode: auth.mode });
  }

  // ── 邮箱验证码注册（两步：请求验证码 → 凭码建号）──
  //
  // 开放性判定与「建第一个账号」共用一把尺子：
  //   · 没有任何账号：邮箱注册天然可用（建的是 owner，与 /api/auth/register 同为 bootstrap 通道）
  //   · 已有账号：必须由管理员在管理后台显式开启 SIGNUP_OPEN —— 否则注册接口就是后门
  const signupAllowed = () => (!auth.enabled ? true : readEnv().SIGNUP_OPEN === '1');

  if (pathname === '/api/auth/register-email' && req.method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确', code: 'BAD_EMAIL' });
    if (!signupAllowed()) {
      return json(res, 403, { ok: false, error: '当前未开放注册：已存在账号体系，需管理员在「管理后台 → 邮件 / SMTP」里开启', code: 'SIGNUP_CLOSED' });
    }
    if (!mailer.isConfigured(env)) {
      return json(res, 503, { ok: false, error: '邮件服务未配置：请由管理员在「管理后台 → 邮件 / SMTP」里填写设置（本地调试可设 SMTP_MODE=file 落盘模式）', code: 'SMTP_NOT_CONFIGURED' });
    }
    const meta = clientMeta(req);
    const r = registrations.issue(email, meta.ip);
    if (!r.ok) return json(res, r.code === 'BAD_EMAIL' ? 400 : 429, { ok: false, error: r.error, code: r.code });
    const sent = await mailer.sendVerificationCode(env, email, r.code, r.expiresInMin);
    if (!sent.ok) {
      // 发送失败就撤掉刚签发的记录 —— 用户修好配置后能立刻重试，而不是干等 60 秒限频
      registrations.revoke(email, sent.error ?? 'send_failed');
      return json(res, 502, { ok: false, error: sent.error ?? '验证码发送失败', code: 'SMTP_SEND_FAILED' });
    }
    return json(res, 200, { ok: true, expiresInMin: r.expiresInMin, sendMode: sent.mode });
  }

  if (pathname === '/api/auth/register-email/verify' && req.method === 'POST') {
    const body = await readBody(req);
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return json(res, 400, { ok: false, error: '邮箱格式不正确', code: 'BAD_EMAIL' });
    if (!signupAllowed()) return json(res, 403, { ok: false, error: '当前未开放注册', code: 'SIGNUP_CLOSED' });
    // hold=true：验证码核对通过先保留，等账号真正落库再 consume ——
    // 否则口令不合规则时会白吃掉一条验证码，用户还得干等 60 秒重拿
    const v = registrations.verify(email, body.code, clientMeta(req).ip, { hold: true });
    if (!v.ok) return json(res, 400, { ok: false, error: v.error, code: v.code });
    // 用户名缺省 = 邮箱本身（username 规则允许 @；带 + 号等特殊字符的邮箱会在这里被拦下，请用户显式给一个）
    const username = String(body.username ?? '').trim() || email;
    const displayName = String(body.displayName ?? '').trim() || username.split('@')[0];
    const cr = auth.create({ username, password: body.password, displayName, email, actor: 'email-registration' });
    if (!cr.ok) return json(res, 400, { ok: false, error: cr.error });
    registrations.consume(email);
    const l = auth.login(username, body.password, clientMeta(req));
    return json(res, 200, { ok: true, account: cr.account, token: l.token ?? null, expiresAt: l.expiresAt ?? null, mode: auth.mode });
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const r = auth.login(body.username, body.password, clientMeta(req));
    if (!r.ok) return json(res, 401, { ok: false, error: r.error, code: r.code });
    return json(res, 200, { ok: true, token: r.token, expiresAt: r.expiresAt, account: r.account, mode: auth.mode });
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    if (!gate.account) return json(res, 200, { ok: true, mode: 'local-open', account: null, signedIn: false });
    return json(res, 200, {
      ok: true,
      mode: 'accounts',
      signedIn: true,
      account: AuthStore.publicView(gate.account),
      sessions: auth.sessionCount(gate.account.id),
      permissions: ROLES[gate.account.role] ?? null,
    });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    auth.logout(gate.token, actor);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/auth/password' && req.method === 'POST') {
    if (!gate.account) return json(res, 400, { ok: false, error: '未启用账号体系' });
    const body = await readBody(req);
    const r = auth.changePassword(gate.account.id, body.currentPassword, body.newPassword);
    if (!r.ok) return json(res, 400, { ok: false, error: r.error });
    return json(res, 200, { ok: true, note: '口令已修改，所有登录会话（含当前这条）都已失效，请重新登录。' });
  }

  // ───────────────────────── 账号管理（owner/admin）─────────────────────────

  if (pathname === '/api/account/accounts' && req.method === 'GET') {
    return json(res, 200, {
      ok: true,
      roles: Object.entries(ROLES).map(([id, r]) => ({ id, ...r })),
      plans: Object.entries(PLANS).map(([id, p]) => ({
        id,
        label: p.label,
        monthlyTokens: p.monthlyTokens,
        dailyCalls: p.dailyCalls,
        models: p.models,
      })),
      accounts: auth.list(),
    });
  }

  if (pathname === '/api/account/accounts' && req.method === 'POST') {
    const body = await readBody(req);
    const r = auth.create({ ...body, actor });
    if (!r.ok) return json(res, 400, { ok: false, error: r.error });
    return json(res, 200, { ok: true, account: r.account });
  }

  if (pathname === '/api/account/account' && (req.method === 'PATCH' || req.method === 'POST')) {
    const body = await readBody(req);
    const id = String(body.id ?? '');
    if (body.role !== undefined) {
      const r = auth.setRole(id, body.role, actor);
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
    }
    if (body.plan !== undefined) {
      const r = auth.setPlan(id, body.plan, actor);
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
    }
    if (body.status !== undefined) {
      const r = auth.setStatus(id, body.status, actor);
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
    }
    /**
     * 重置口令同样要 canManage。
     *
     * 这条不能只靠 resetPassword 内部自觉：`actor` 只用来写审计，不代表这次请求
     * 有权限动别人。缺了这层，任何一条普通账号（哪怕 role=viewer）只要带着 token
     * 就能 `PATCH /api/account/account {id:"<owner>", newPassword:"…"}` 接管整个系统。
     * role/status 那两个分支有 setRole/setStatus 内部兜底，resetPassword 没有 ——
     * 所以兜底只能加在这里。
     */
    if (body.newPassword !== undefined) {
      if (!gate.account || !ROLES[gate.account.role]?.canManage) {
        return json(res, 403, { ok: false, error: '只有所有者/管理员能重置别人的口令', code: 'FORBIDDEN' });
      }
      const r = auth.resetPassword(id, body.newPassword, actor);
      if (!r.ok) return json(res, 400, { ok: false, error: r.error });
    }
    const acc = auth.findById(id);
    return json(res, 200, { ok: true, account: acc ? AuthStore.publicView(acc) : null });
  }

  // ───────────────────────── 会话轮换（管理员踢下线） ─────────────────────────

  if (pathname === '/api/account/sessions' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://x');
    const id = String(url.searchParams.get('id') ?? '');
    const r = auth.listSessions(id);
    if (!r.ok) return json(res, 404, { ok: false, error: '账号不存在' });
    return json(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/account/revoke-session' && req.method === 'POST') {
    const body = await readBody(req);
    const r = auth.revokeSession(String(body.id ?? ''), String(body.sessionId ?? ''), actor);
    if (!r.ok) return json(res, r.error === 'ACCOUNT_NOT_FOUND' ? 404 : 400, { ok: false, error: r.error });
    return json(res, 200, { ok: true, ...r });
  }

  if (pathname === '/api/account/revoke-all-sessions' && req.method === 'POST') {
    const body = await readBody(req);
    const r = auth.revokeAllSessions(String(body.id ?? ''), actor);
    if (!r.ok) return json(res, 404, { ok: false, error: r.error });
    return json(res, 200, { ok: true, ...r });
  }

  // ───────────────────────── 用量 / 审计 / 安全自述 ─────────────────────────

  if (pathname === '/api/usage' && req.method === 'GET') {
    const accounts = auth.enabled ? (gate.account && ROLES[gate.account.role]?.canManage ? auth.list() : [AuthStore.publicView(gate.account)]) : [];
    return json(res, 200, {
      ok: true,
      mode: auth.mode,
      accounts: accounts.map((a) => ({ id: a.id, username: a.username, plan: a.plan, quota: a.quota, lastLoginAt: a.lastLoginAt })),
    });
  }

  if (pathname === '/api/security/policy' && req.method === 'GET') {
    const p = securityPolicy({ mode: auth.mode, accountsPath: ACCOUNTS_PATH, auditPath: AUDIT_PATH, host: HOST });
    return json(res, 200, { ok: true, ...p, apiKeyMasked: maskKey(env.AI_API_KEY), apiKeyLocation: ENV_PATH });
  }

  if (pathname === '/api/security/audit' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://x');
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') ?? 200)));
    const entries = auth.readAudit(limit);
    // CSV 导出：给表格软件的第二种消费方式。序列化抽到 auditCsv.mjs —— Node 级验收直接断它。
    if (url.searchParams.get('format') === 'csv') {
      const text = auditCsv(entries);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="audit-${Date.now()}.csv"`,
        'Content-Length': Buffer.byteLength(text),
      });
      return res.end(text);
    }
    return json(res, 200, { ok: true, path: AUDIT_PATH, entries });
  }

  if (pathname === '/api/settings' && req.method === 'GET') {
    return json(res, 200, s);
  }

  if (pathname === '/api/settings' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    const patch = {};
    if (typeof body.provider === 'string') {
      patch.AI_PROVIDER = body.provider;
      // 换服务商时如果没显式给 baseUrl，就用该服务商的预设，避免沿用上一家的地址
      if (!body.baseUrl && PROVIDERS[body.provider]) patch.AI_BASE_URL = PROVIDERS[body.provider].baseUrl;
    }
    if (typeof body.baseUrl === 'string') patch.AI_BASE_URL = body.baseUrl.trim().replace(/\/+$/, '');
    if (typeof body.model === 'string') patch.AI_MODEL = body.model.trim();
    if (typeof body.temperature === 'number') patch.AI_TEMPERATURE = String(body.temperature);
    if (typeof body.maxTokens === 'number' && body.maxTokens > 0) patch.AI_MAX_TOKENS = String(Math.round(body.maxTokens));
    // apiKey 缺省 = 不修改（前端只显示后四位，不可能把原文再发回来）
    if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') patch.AI_API_KEY = body.apiKey.trim();

    writeEnv(patch);
    return json(res, 200, { ok: true, ...currentSettings() });
  }

  // ── SMTP 设置（管理后台「邮件 / SMTP」区块的数据源）──
  // 与 AI API Key 同一纪律：口令只落 .env，GET 只回打码值，PUT 留空 = 不修改。
  if (pathname === '/api/settings/smtp' && req.method === 'GET') {
    return json(res, 200, { ok: true, ...mailer.describe(env) });
  }

  if (pathname === '/api/settings/smtp' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    const patch = {};
    if (typeof body.host === 'string') patch.SMTP_HOST = body.host.trim();
    if (body.port === null || body.port === undefined || body.port === '') patch.SMTP_PORT = '';
    else if (Number.isFinite(Number(body.port)) && Number(body.port) > 0) patch.SMTP_PORT = String(Math.round(Number(body.port)));
    if (body.secure === true || body.secure === false) patch.SMTP_SECURE = body.secure ? '1' : '0';
    if (typeof body.user === 'string') patch.SMTP_USER = body.user.trim();
    if (typeof body.from === 'string') patch.SMTP_FROM = body.from.trim();
    if (body.mode === 'smtp' || body.mode === 'file') patch.SMTP_MODE = body.mode;
    if (typeof body.pass === 'string' && body.pass.trim() !== '') patch.SMTP_PASS = body.pass.trim(); // 缺省 = 不修改
    if (body.signupOpen === true || body.signupOpen === false) patch.SIGNUP_OPEN = body.signupOpen ? '1' : '0';
    writeEnv(patch);
    auth.audit({ actor: gate.account?.id ?? 'local-open', action: 'settings.smtp', result: 'ok', host: patch.SMTP_HOST ?? '(unchanged)' });
    return json(res, 200, { ok: true, ...mailer.describe(readEnv()) });
  }

  if (pathname === '/api/settings/smtp/test' && req.method === 'POST') {
    const body = await readBody(req);
    const to = String(body.to ?? '').trim() || mailer.readConfig(env).from;
    if (!to) return json(res, 400, { ok: false, error: '没有收件地址：请在表单里填一个收件邮箱，或先配置发件人' });
    const r = await mailer.sendTest(env, to);
    auth.audit({ actor: gate.account?.id ?? 'local-open', action: 'settings.smtp.test', target: to, result: r.ok ? 'ok' : 'fail', error: r.ok ? undefined : r.error });
    if (!r.ok) return json(res, 502, { ok: false, error: r.error });
    return json(res, 200, { ok: true, mode: r.mode, to, messageId: r.messageId ?? null, file: r.file ?? null });
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    const provider = env.AI_PROVIDER || s.provider;
    const preset = PROVIDERS[provider] ?? PROVIDERS.custom;
    return json(res, 200, {
      source: 'builtin',
      provider,
      models: preset.models,
      note: '内置清单是静态的，会过期。点「自动拉取」以服务商实时返回为准。',
    });
  }

  if (pathname === '/api/models/refresh' && req.method === 'POST') {
    const provider = env.AI_PROVIDER || s.provider;
    const preset = PROVIDERS[provider] ?? PROVIDERS.custom;
    const baseUrl = (env.AI_BASE_URL || preset.baseUrl || '').replace(/\/+$/, '');
    const key = env.AI_API_KEY || '';
    if (!baseUrl) return json(res, 200, { source: 'builtin', models: preset.models, error: '还没有填写 Base URL' });
    try {
      const r = await fetchWithTimeout(
        `${baseUrl}/models`,
        { headers: key ? { Authorization: `Bearer ${key}` } : {} },
        Number(env.AI_TIMEOUT_MS ?? 20000)
      );
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        return json(res, 200, {
          source: 'builtin',
          models: preset.models,
          error: `服务商返回 ${r.status} ${r.statusText}${t ? ` · ${t.slice(0, 200)}` : ''}`,
        });
      }
      const data = await r.json();
      const list = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter(Boolean) : [];
      if (list.length === 0) {
        return json(res, 200, { source: 'builtin', models: preset.models, error: '服务商返回了空的模型列表' });
      }
      list.sort();
      return json(res, 200, { source: 'live', provider, count: list.length, models: list });
    } catch (e) {
      return json(res, 200, {
        source: 'builtin',
        models: preset.models,
        error: `拉取失败：${e.name === 'AbortError' ? '超时' : e.message}`,
      });
    }
  }

  /**
   * ─────────────── 连通性测试 ───────────────
   *
   *  ── 这个接口的语义，比它看起来的要紧 ──
   *    用户点它是想问一件事：**"我这样配好之后，能用了吗？"**
   *    所以必须分清三个不同的结论，不能让它们糊成一个 ok：
   *
   *      reachable = HTTP 通了（地址、网络、鉴权都对）
   *      spoke     = **模型真的回了话**（正文非空）
   *      ok        = spoke —— 因为"能用"的标准是后者，不是前者
   *
   *  ── 早先这里是假阳性 ──
   *    原实现发的是 `{ content: 'ping', max_tokens: 1 }`，然后只要 HTTP 200 就报
   *    「连通性正常。这一条请求只消耗 1 个 token。」。
   *    对推理模型，那 1 个 token 会被**思考过程**全部吃掉，正文是空字符串。
   *    实测这个局域网模型：测试"通过"（ok:true），耗时 17.9 秒，
   *    用掉 completion_tokens=1 / reasoning_tokens=1 —— **一个字都没说出来**。
   *    用户于是以为配好了，接着在规划里收到"模型返回了空内容"，
   *    而那条报错指不到真正的原因。**通过一个什么都没验证的测试，比测试失败更坏。**
   *
   *    顺带一处事实错误：那句"只消耗 1 个 token"也不对 —— 实测 total_tokens 是 6
   *    （prompt 5 + completion 1），而且推理 token 一样计费。
   */
  if (pathname === '/api/test' && req.method === 'POST') {
    const baseUrl = (env.AI_BASE_URL || s.baseUrl || '').replace(/\/+$/, '');
    const key = env.AI_API_KEY || '';
    const model = env.AI_MODEL || s.model;
    if (!baseUrl) return json(res, 200, { ok: false, reachable: false, spoke: false, error: '还没有填写 Base URL' });
    if (!key) return json(res, 200, { ok: false, reachable: false, spoke: false, error: '还没有填写 API Key' });
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            // 问一个**必须回话**的问题：既是连通性测试，也是"它听得懂指令吗"的测试。
            // 用 'ping' 的话模型回什么都算过，甚至可能回一大段解释。
            messages: [{ role: 'user', content: '只回复两个字：正常' }],
            temperature: 0,
            /**
             * 输出预算必须给足。给 1 的结果是模型在思考阶段就把额度用完，
             * 正文为空 —— 而 HTTP 仍然是 200，于是测试"通过"了。
             * 512 足够这类短回答（实测同一模型回答两个字用掉 54）。
             */
            max_tokens: 512,
          }),
        },
        Number(env.AI_TIMEOUT_MS ?? 60000)
      );
      const latencyMs = Date.now() - t0;
      const text = await r.text();
      if (!r.ok) {
        return json(res, 200, {
          ok: false,
          /**
           * **收到 HTTP 响应本身就说明地址是通的。**
           *
           * 401 只是"鉴权没过"，不是"连不上" —— 这两件事的修法完全不同
           * （一个去查 API Key，一个去查 IP / 端口 / 防火墙），
           * 混成一句"连不上"会把人引到错的方向上查半天。
           * 只有网络层异常（ECONNREFUSED / DNS / 超时）才算 reachable: false。
           */
          reachable: true,
          spoke: false,
          latencyMs,
          model,
          error: `HTTP ${r.status}：${text.slice(0, 300)}`,
          note:
            r.status === 401 || r.status === 403
              ? '地址通了，但鉴权没过 —— 检查 API Key。'
              : `地址通了，但服务商拒绝了这次请求（HTTP ${r.status}）。`,
        });
      }
      let parsed = {};
      try {
        parsed = JSON.parse(text);
      } catch {
        /* 非 JSON：HTTP 层是通的，但拿不到模型回复 —— 下面按"没说成话"处理 */
      }
      const choice = parsed?.choices?.[0] ?? {};
      const content = String(choice?.message?.content ?? '').trim();
      const reasoning = String(choice?.message?.reasoning_content ?? '');
      const usage = parsed?.usage ?? null;
      const spoke = content.length > 0;
      return json(res, 200, {
        ok: spoke,
        reachable: true,
        spoke,
        latencyMs,
        model: parsed?.model ?? model,
        text: content.slice(0, 120),
        reasoningChars: reasoning.length,
        usage,
        finishReason: choice?.finish_reason,
        note: spoke
          ? `连通正常，而且模型确实回了话（耗时 ${latencyMs}ms，用掉 ${usage?.total_tokens ?? '?'} token${
              usage?.reasoning_tokens ? `，其中推理 ${usage.reasoning_tokens}` : ''
            }）。`
          : '地址通了、鉴权也过了，但**模型这次没产出正文** —— 所以还不能说"能用"。',
        error: spoke
          ? undefined
          : choice?.finish_reason === 'length'
            ? '模型的输出预算在思考阶段就用完了，还没开始写正文。把 .env 里的 AI_MAX_TOKENS 调大再试。'
            : reasoning
              ? '模型只产出了思考过程，没有产出正文。'
              : '模型返回了空正文。',
      });
    } catch (e) {
      const timedOut = e.name === 'AbortError';
      return json(res, 200, {
        ok: false,
        reachable: false,
        spoke: false,
        latencyMs: Date.now() - t0,
        model,
        error: timedOut ? `超时（超过 ${Number(env.AI_TIMEOUT_MS ?? 60000)}ms）` : e.message,
        note: timedOut ? '推理模型单次可能要十几秒到几十秒 —— 若确实很慢，把 AI_TIMEOUT_MS 调大。' : '连不上这个地址。',
      });
    }
  }

  if (pathname === '/api/ai/chat' && req.method === 'POST') {
    const body = await readBody(req);
    const baseUrl = (env.AI_BASE_URL || '').replace(/\/+$/, '');
    const key = env.AI_API_KEY || '';
    const model = body.model || env.AI_MODEL || s.model;
    if (!baseUrl || !key) return json(res, 400, { ok: false, error: '尚未配置 Base URL / API Key' });
    if (!Array.isArray(body.messages) || body.messages.length === 0) return json(res, 400, { ok: false, error: 'messages 不能为空' });
    const t0 = Date.now();
    try {
      const payload = {
        model,
        messages: body.messages,
        temperature: typeof body.temperature === 'number' ? body.temperature : Number(env.AI_TEMPERATURE ?? 0.2),
        /**
         * 默认给足输出预算。推理模型会**先把预算花在思考上** ——
         * 留空交给服务商默认值时，一个"上限偏小"的网关就能让对话整整返回空正文，
         * 而界面上只会显示"AI 没有回答"。见 aiContract 里 DEFAULT_MAX_TOKENS 的说明。
         */
        max_tokens: typeof body.maxTokens === 'number' ? body.maxTokens : Number(env.AI_MAX_TOKENS ?? DEFAULT_MAX_TOKENS),
      };
      if (body.json) payload.response_format = { type: 'json_object' };
      const r = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(payload),
        },
        Number(env.AI_TIMEOUT_MS ?? 120000)
      );
      const text = await r.text();
      if (!r.ok) return json(res, 200, { ok: false, error: `HTTP ${r.status}：${text.slice(0, 400)}` });
      const data = JSON.parse(text);
      const choice = data?.choices?.[0] ?? {};
      const content = String(choice?.message?.content ?? '');
      const reasoning = String(choice?.message?.reasoning_content ?? '');
      const finish = choice?.finish_reason;
      const usage = data?.usage ?? null;
      return json(res, 200, {
        ok: true,
        text: content,
        /**
         * 思考过程（R1 一系）。**它不是模型的回答**，但它是"为什么等了 18 秒"
         * 以及"为什么正文是空的"的唯一解释 —— 丢掉它，用户面对的就是
         * 一段漫长的等待 + 一个空白的回答框。
         */
        reasoning,
        finishReason: finish,
        /**
         * 正文为空时给一个**可操作的**原因。
         * "AI 没有回答"是零信息量的一句话：用户不知道是该改配置、换模型、还是自己说错了。
         */
        emptyReason: content.trim()
          ? undefined
          : finish === 'length'
            ? `模型把 ${usage?.completion_tokens ?? '?'} 个输出 token 用完了还没开始写正文（推理模型的典型形态）。把 .env 里的 AI_MAX_TOKENS 调大就会好转。`
            : reasoning
              ? '模型只产出了思考过程，没有产出正文。'
              : '模型返回了空的正文。',
        model: data?.model ?? model,
        usage,
        /** 服务端实测耗时（不含浏览器往返）—— 界面要如实显示"这次等了多久" */
        ms: Date.now() - t0,
      });
    } catch (e) {
      const timedOut = e.name === 'AbortError';
      return json(res, 200, {
        ok: false,
        ms: Date.now() - t0,
        error: timedOut ? `超时（超过 ${Number(env.AI_TIMEOUT_MS ?? 120000)}ms）` : e.message,
        note: timedOut ? '推理模型单次可能要十几秒到几十秒 —— 若那台机器确实很慢，把 AI_TIMEOUT_MS 调大。' : '连不上这个地址。',
      });
    }
  }

  /**
   * ─────────────── AI 规划：自然语言 → 动作清单 ───────────────
   *
   *  与 /api/ai/chat 的关键区别：这个接口**不是通用转发**。
   *  它拒绝任何非契约动作，并把 AI 输出原地过一遍 validatePlan。
   *
   *  为什么把校验放在服务端而不只放前端：
   *   · 这是不受信任的 AI 输出**第一次进入系统**的地方，边界就在这儿拦
   *   · 拦下的内容要进审计（"AI 想做但被拒绝的事"是最值得复盘的一类记录）
   *   · 事后换前端实现、加 MCP 通道时，这道门不会跟着消失
   *
   *  注意**没有**做的事：这个接口不编译命令、不碰模型、更不产出几何。
   *  动作 → Command 的编译在前端的 compile.ts，那里才是唯一写入口的邻居。
   */
  if (pathname === '/api/ai/plan' && req.method === 'POST') {
    const body = await readBody(req);
    if (!auth.enabled) {
      // local-open：免登录，不计量。如实回一个标记，让界面能说清"当前没有额度限制"
    }
    // ① 额度（在**发起调用之前**判定，不是事后统计）
    if (gate.account) {
      const q = auth.checkQuota(gate.account.id);
      if (!q.ok) return json(res, 429, { ok: false, error: q.error, code: q.code });
    }

    const baseUrl = (env.AI_BASE_URL || '').replace(/\/+$/, '');
    const key = env.AI_API_KEY || '';
    const model = body.model || env.AI_MODEL || s.model;
    if (!baseUrl || !key) return json(res, 400, { ok: false, error: '尚未配置 Base URL / API Key —— 请在「管理后台」里填好再试' });
    if (gate.account) {
      const m = auth.checkModel(gate.account.id, model);
      if (!m.ok) return json(res, 403, { ok: false, error: m.error, code: m.code });
    }

    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return json(res, 400, { ok: false, error: 'text 不能为空' });
    if (text.length > 2000) return json(res, 400, { ok: false, error: '这句话太长了（上限 2000 字），请拆开说' });
    if (!body.snapshot || typeof body.snapshot !== 'object') {
      return json(res, 400, { ok: false, error: '缺少 snapshot —— 前端必须显式给出项目快照，服务端不替它去读模型' });
    }

    const t0 = Date.now();
    try {
      const payload = buildChatRequest(model, text, body.snapshot, {
        history: Array.isArray(body.history) ? body.history : [],
        temperature: Number(env.AI_TEMPERATURE ?? 0.1),
      });
      const r = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(payload) },
        Number(env.AI_TIMEOUT_MS ?? 120000)
      );
      const raw = await r.text();
      const ms = Date.now() - t0;
      if (!r.ok) {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms, note: `HTTP ${r.status}` });
        return json(res, 200, { ok: false, error: `服务商返回 HTTP ${r.status}：${raw.slice(0, 400)}`, ms });
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms, note: 'bad_envelope' });
        return json(res, 200, { ok: false, error: '服务商返回的不是 JSON', raw: raw.slice(0, 400), ms });
      }
      const choice = data?.choices?.[0] ?? {};
      const content = choice?.message?.content ?? '';
      /**
       * `reasoning_content` 是 R1 一系推理模型的"思考过程"字段（DeepSeek / 多数网关都透传）。
       * 它**不是**模型的回答，但它是"为什么等了 18 秒""为什么正文是空的"的唯一线索，
       * 所以不能丢 —— 要原样带回去让界面能显示。
       */
      const reasoning = String(choice?.message?.reasoning_content ?? '');
      const finish = choice?.finish_reason;
      const usage = data?.usage ?? null;
      if (gate.account) {
        auth.recordUsage(gate.account.id, {
          model: data?.model ?? model,
          promptTokens: Number(usage?.prompt_tokens ?? 0),
          completionTokens: Number(usage?.completion_tokens ?? 0),
          ok: true,
          ms,
        });
      }

      /**
       * ── 正文为空：单独一条诊断，别让它掉进"不是可解析的 JSON"里 ──
       *
       * 这两件事的原因完全不同，修法也完全不同：
       *   · 正文非空但不是 JSON → 提示词/模型能力问题
       *   · **正文为空** → 大多是推理模型把输出预算吃光了（`finish_reason: length`）
       * 早先两种情况都落到 `extractJson` 的"模型返回了空内容"上，
       * 用户拿到这句话完全无从下手 —— 真相是"把 AI_MAX_TOKENS 调大就能用"。
       */
      if (!String(content).trim()) {
        const comp = usage?.completion_tokens;
        const reas = usage?.reasoning_tokens;
        const why =
          finish === 'length'
            ? `模型的输出预算用完了却没产出正文（输出 ${comp ?? '?'} token${reas ? `，其中推理 ${reas}` : ''}）—— 推理模型很容易这样：思考过程先把预算吃光了。把 .env 里的 AI_MAX_TOKENS 调大，或换一个非推理模型。`
            : reasoning
              ? `模型只产出了"思考过程"（${reasoning.length} 字）而没有产出正文 —— 它可能把计划写在思考里了，或者中途被截断。`
              : '模型返回的正文是空的。';
        auth.audit({
          actor,
          action: 'ai.plan',
          result: 'empty',
          model: data?.model ?? model,
          note: finish === 'length' ? 'budget_exhausted' : 'empty_content',
        });
        return json(res, 200, {
          ok: false,
          error: why,
          // raw 保持"正文"的语义不放思考过程 —— 每个字段只有一个意思
          raw: String(content).slice(0, 800),
          reasoning: reasoning.slice(0, 4000),
          finishReason: finish,
          model: data?.model ?? model,
          usage,
          ms,
        });
      }

      const extracted = extractJson(content);
      if (!extracted.ok) {
        auth.audit({ actor, action: 'ai.plan', result: 'unparsable', model, note: extracted.error });
        return json(res, 200, {
          ok: false,
          error: `${extracted.error}（原始回复已附在下面，可直接看模型到底说了什么）`,
          raw: extracted.raw ?? String(content).slice(0, 800),
          reasoning: reasoning.slice(0, 4000),
          finishReason: finish,
          model: data?.model ?? model,
          usage,
          ms,
        });
      }

      /**
       * 枚举取值来自**调用方给的快照**（服务端不去读模型/规则集，那是前端的事）。
       * 能力标志由快照携带，所以"哪个材质能当柜体板"在服务端也判得出来 ——
       * 契约是静态的，运行时上下文是动态注入的，两边共用同一个校验器。
       */
      const mats = Array.isArray(body.snapshot.materials) ? body.snapshot.materials : [];
      const ctx = {
        bodyMaterials: mats.filter((m) => m?.canBeBodyBoard).map((m) => m.id),
        backMaterials: mats.filter((m) => m?.canBeBack).map((m) => m.id),
        roomCount: Array.isArray(body.snapshot.rooms) ? body.snapshot.rooms.length : 0,
      };
      const plan = validatePlan(extracted.value, ctx);
      auth.audit({
        actor,
        action: 'ai.plan',
        /**
         * 三态，不是两态。
         *
         * `plan.ok === true` 只表示"有动作通过了"，**不表示整份计划会被执行** ——
         * 只要有一条被拒，前端就会整份拒绝（半执行的模型比不执行更危险）。
         * 早先这里只记 ok / rejected，于是"部分被拒"在账上显示为 ok，
         * 与界面上那句"整份计划不予执行"直接矛盾。审计是事后唯一能查的东西，
         * 它不能和界面各说一套。
         */
        result: !plan.ok ? 'rejected' : plan.rejected?.length ? 'partial' : 'ok',
        model: data?.model ?? model,
        actions: plan.actions?.map((a) => a.action) ?? [],
        rejected: plan.rejected?.map((x) => x.code) ?? [],
      });
      return json(res, 200, {
        ok: plan.ok,
        error: plan.ok ? undefined : plan.error,
        reply: plan.reply,
        actions: plan.actions,
        rejected: plan.rejected,
        contractVersion: '1.0.0',
        model: data?.model ?? model,
        usage,
        ms,
      });
    } catch (e) {
      const ms = Date.now() - t0;
      if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms, note: e.name });
      return json(res, 200, { ok: false, error: e.name === 'AbortError' ? '调用超时' : `调用失败：${e.message}`, ms });
    }
  }

  // ── 记忆：与浏览器 localStorage 互为备份，也可以直接进 git ──
  if (pathname === '/api/memory' && req.method === 'GET') {
    const jsonl = existsSync(MEM_PATH) ? readFileSync(MEM_PATH, 'utf8') : '';
    return json(res, 200, {
      ok: true,
      path: MEM_PATH,
      count: jsonl.split(/\r?\n/).filter((l) => l.trim()).length,
      jsonl,
    });
  }

  if (pathname === '/api/memory' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    const text = typeof body.jsonl === 'string' ? body.jsonl : typeof body.__raw === 'string' ? body.__raw : '';
    if (!text.trim()) return json(res, 400, { ok: false, error: 'jsonl 不能为空' });
    if (!existsSync(MEM_DIR)) mkdirSync(MEM_DIR, { recursive: true });
    // 覆盖前先留一份上一版，误操作可回退
    if (existsSync(MEM_PATH)) writeFileSync(`${MEM_PATH}.bak`, readFileSync(MEM_PATH));
    writeFileSync(MEM_PATH, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
    return json(res, 200, { ok: true, path: MEM_PATH, bytes: Buffer.byteLength(text), backup: `${MEM_PATH}.bak` });
  }

  // ───────────────────────────── 导出 ─────────────────────────────
  //
  // 几何**必须由后端从语义模型重算**，不接受浏览器上传的图元：
  // 接受上传等于接受一份没人校验过的几何，"图 = 料" 这条线当场断掉。
  // 所以链路是：project(JSON，几 KB) → node 跑 TS 生成中立格式 → python 序列化成 DXF。
  // Python 只做序列化，不做任何计算 —— 这是这条链路存在的理由。

  if (pathname === '/api/export/dxf' && req.method === 'POST') {
    const body = await readBody(req);
    const project = body.project;
    if (!project || typeof project !== 'object') return json(res, 400, { ok: false, error: '缺少 project' });
    const which = Array.isArray(body.which) && body.which.length ? body.which.filter((x) => x === 'plan' || x === 'sheet') : ['plan', 'sheet'];
    if (which.length === 0) return json(res, 400, { ok: false, error: 'which 只能是 plan / sheet' });
    const version = body.version === 'R2000' ? 'R2000' : 'R2007'; // R2000/GBK 只作兼容备用

    const dir = mkdtempSync(join(tmpdir(), 'furniture-dxf-'));
    const neutralPath = join(dir, 'neutral.json');
    const dxfPath = join(dir, 'out.dxf');
    try {
      const neutralOut = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', EMIT_NEUTRAL_TS], {
        input: JSON.stringify({ project, which, modelVersion: String(body.modelVersion ?? 'unknown') }),
      });
      writeFileSync(neutralPath, neutralOut.out, 'utf8');
      const infoRaw = await run(pythonExe(), [EXPORT_DXF_PY, neutralPath, dxfPath, version]);
      const info = JSON.parse(infoRaw.out || '{}');
      const stamp = new Date().toISOString().slice(0, 10);
      const base = `${String(project.name || 'project')}_${which.join('-')}_${stamp}_${version}.dxf`;
      res.writeHead(200, {
        'Content-Type': 'application/dxf',
        // 中文文件名必须走 RFC 5987，否则浏览器下载下来是乱码
        'Content-Disposition': `attachment; filename="export.dxf"; filename*=UTF-8''${encodeURIComponent(base)}`,
        'X-Export-Info': encodeURIComponent(JSON.stringify(info)),
      });
      createReadStream(dxfPath).pipe(res);
      return;
    } catch (e) {
      return json(res, 500, { ok: false, error: `DXF 导出失败：${e.message}` });
    }
  }

  /** 开料单（板件清单）。纯文本 CSV，Excel 直接能开 —— 加 BOM 否则中文乱码。 */
  if (pathname === '/api/export/cutlist' && req.method === 'POST') {
    const body = await readBody(req);
    const project = body.project;
    if (!project || typeof project !== 'object') return json(res, 400, { ok: false, error: '缺少 project' });
    try {
      const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', EMIT_NEUTRAL_TS], {
        input: JSON.stringify({ project, which: [], modelVersion: String(body.modelVersion ?? 'unknown') }),
      });
      const n = JSON.parse(r.out);
      const rows = [
        ['序号', '板件ID', '名称', '角色', '所属', '材质', '厚(mm)', '长(mm)', '宽(mm)', '数量', '纹理', '单件面积(m²)'],
      ];
      // 开料习惯：先按材质 + 厚度分组，组内按面积从大到小 —— 排版时一眼看到大板
      const panels = [...n.panels].sort(
        (a, b) => a.material.localeCompare(b.material) || a.thickness - b.thickness || b.length * b.width - a.length * a.width
      );
      panels.forEach((p, i) => {
        rows.push([
          i + 1, p.id, p.nameZh, p.role, p.belongsTo, p.material, p.thickness, p.length, p.width, p.qty, p.grain,
          ((p.length * p.width) / 1e6).toFixed(3),
        ]);
      });
      // 甲购/外采件（玻璃门等）单独一节 —— 它们不走开料机，混进板件清单会误导排产
      if (n.purchased && n.purchased.length > 0) {
        rows.push([]);
        rows.push(['—— 甲购/外采件（不进开料）——']);
        rows.push(['序号', '件ID', '名称', '类型', '所属', '材质', '规格/工艺要求', '数量']);
        n.purchased.forEach((x, i) => {
          rows.push([i + 1, x.id, x.nameZh, x.kind, x.belongsTo, x.material, x.spec, x.qty]);
        });
      }
      const csv = '\uFEFF' + rows.map((r2) => r2.map(csvCell).join(',')).join('\r\n') + '\r\n';
      const base = `${String(project.name || 'project')}_开料单_${new Date().toISOString().slice(0, 10)}.csv`;
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="cutlist.csv"; filename*=UTF-8''${encodeURIComponent(base)}`,
        'X-Export-Stats': encodeURIComponent(JSON.stringify(n.stats)),
      });
      res.end(csv);
      return;
    } catch (e) {
      return json(res, 500, { ok: false, error: `开料单生成失败：${e.message}` });
    }
  }

  /** 按房间排序的图纸册（HTML 打印版）。浏览器打开后「打印 → 另存为 PDF」。 */
  if (pathname === '/api/export/roombook' && req.method === 'POST') {
    const body = await readBody(req);
    const project = body.project;
    if (!project || typeof project !== 'object') return json(res, 400, { ok: false, error: '缺少 project' });
    try {
      const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', EMIT_ROOMBOOK_TS], {
        input: JSON.stringify({ project, modelVersion: String(body.modelVersion ?? 'unknown') }),
      });
      const html = r.out || '';
      if (!html.trim()) throw new Error(r.err || '生成器无输出');
      const base = `${String(project.name || 'project')}_图纸册_${new Date().toISOString().slice(0, 10)}.html`;
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="roombook.html"; filename*=UTF-8''${encodeURIComponent(base)}`,
      });
      res.end(html);
      return;
    } catch (e) {
      return json(res, 500, { ok: false, error: `图纸册生成失败：${e.message}` });
    }
  }

  return json(res, 404, { ok: false, error: `未知接口 ${req.method} ${pathname}` });
}

/** CSV 单元格转义：含逗号/引号/换行时必须包起来，内部引号翻倍 */

// ───────────────────────────── 静态文件 ─────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  if (!existsSync(DIST)) {
    return json(res, 404, {
      ok: false,
      error: '还没有构建产物。开发时请用 npm run dev（vite 会把 /api 代理到这里）；生产预览请先 npm run build。',
    });
  }
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(DIST, rel));
  // 目录穿越防线：解析后的路径必须仍在 dist 内
  if (!file.startsWith(DIST)) return json(res, 403, { ok: false, error: 'forbidden' });

  const target = existsSync(file) && statSync(file).isFile() ? file : join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
  createReadStream(target).pipe(res);
}

// ───────────────────────────── 启动 ─────────────────────────────

const server = createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    return res.end();
  }
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => json(res, 500, { ok: false, error: e.message }));
    return;
  }
  serveStatic(req, res, pathname);
});

/**
 * 数据目录能不能写 —— 启动时实测一次，不靠猜。
 *
 * 这件事曾真的咬过人：一次部署之后 `data/` 被换成了 root 属主、mode 551，
 * 容器里跑的是 uid 1000 的 node，**从此一个字节都写不进去**。而登录照样返回
 * 200 —— 因为改动只存在于内存里。表面一切正常，实际上账号库、审计、用量
 * 从那次部署起就没再更新过；排查时"审计里没有失败记录"反而被当成"没输错过"，
 * 差点把方向带跑。
 *
 * 所以这里做两件事：
 *   1. 启动时往数据目录写一个探针文件，成功再删掉；
 *   2. 结果同时报进 /api/health（Fields 断言能查），界面上也能看见。
 * 写不进去就要**照实说**，不能让"登录成功"变成一个骗人的动作。
 */
function probeWritable() {
  try {
    const f = join(dirname(ACCOUNTS_PATH), '.write-probe');
    writeFileSync(f, 'x', 'utf8');
    unlinkSync(f);
    return true;
  } catch {
    return false;
  }
}
const DATA_WRITABLE = probeWritable();

server.listen(PORT, HOST, () => {
  const env = readEnv();
  console.log('家具 CAD 本地服务');
  console.log(`  监听      http://${HOST}:${PORT}   （只监听本机，局域网访问不到）`);
  console.log(`  配置文件  ${ENV_PATH}${existsSync(ENV_PATH) ? '' : '  ← 还不存在，保存设置时会自动创建'}`);
  console.log(`  API Key   ${env.AI_API_KEY ? maskKey(env.AI_API_KEY) : '（未配置）'}`);
  console.log(`  模型      ${env.AI_MODEL || '（未配置）'}`);
  console.log(`  记忆文件  ${MEM_PATH}`);
  console.log(`  账号库    ${ACCOUNTS_PATH}`);
  console.log(`  审计日志  ${AUDIT_PATH}`);
  console.log(`  账号模式  ${auth.mode}${auth.enabled ? `（${auth.data.accounts.length} 个账号）` : '  ← 还没有账号，全部接口免登录'}`);
  console.log(
    DATA_WRITABLE
      ? `  数据目录  可写 —— 账号/审计/用量都能落盘`
      : `  数据目录  ⚠ 写不进去！${dirname(ACCOUNTS_PATH)} 对 uid ${process.getuid?.() ?? '运行用户'} 不可写。\n` +
          `            现在登录仍会返回成功，但**改动只存在于内存，重启就没了**。\n` +
          `            修法：chown -R <运行用户>:<组> ${dirname(ACCOUNTS_PATH)} —— 常见于部署时把 data/ 换成了 root 属主。`
  );
  console.log(`  静态产物  ${existsSync(DIST) ? DIST : '（还没有 dist，开发时走 vite）'}`);
  console.log('');
  console.log('  接口：GET /api/health · GET|PUT /api/settings · GET /api/models · POST /api/models/refresh');
  console.log('        POST /api/test · POST /api/ai/chat · POST /api/ai/plan · GET|PUT /api/memory');
  console.log('        POST /api/auth/register|login|logout|password · GET /api/auth/me|mode');
  console.log('        POST /api/auth/register-email · POST /api/auth/register-email/verify');
  console.log('        GET|POST /api/account/accounts · PATCH /api/account/account');
  console.log('        GET /api/usage · GET /api/security/policy · GET /api/security/audit');
  console.log('        GET|PUT /api/settings/smtp · POST /api/settings/smtp/test');
  if (process.env.APP_ENV_PATH || process.env.APP_MEM_PATH || process.env.APP_ACCOUNTS_PATH || process.env.APP_AUDIT_PATH) {
    console.log('  （本次运行使用了 APP_*_PATH 覆盖，未落在项目默认位置）');
  }
  if (!IS_LOOPBACK) {
    console.log('');
    console.log('  ⚠⚠⚠ 正在监听非回环地址：接口已暴露到容器/网络。');
    console.log('  ⚠ 本服务没有 TLS —— 公网部署必须由反向代理终止 HTTPS（见 DEPLOY.md）。');
    console.log('  ⚠ 请确认已建立第一个账号（accounts 模式），否则全部接口免登录。');
  }
});
