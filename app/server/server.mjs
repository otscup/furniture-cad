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
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync, createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { hashProjectSnapshot } from './projectHash.mjs';
import { findDuplicateUnitIds, unitIdentityConflictMessage, WORKSPACE_UNIT_ID_CONFLICT, repairDuplicateUnitIdsInProject, deoverlapProjectRooms } from '../src/core/unitIdentity.mjs';
import { AuthStore, PLANS, ROLES, securityPolicy } from './auth.mjs';
import { auditCsv } from './auditCsv.mjs';
import { csvCell } from './csvCell.mjs';
import { exportDxf, exportCutlist, exportRoombook, exportPdf } from './exportCore.mjs';
import * as mailer from './mailer.mjs';
import { RegistrationStore, EMAIL_RE } from './registration.mjs';
import { assertPublicUrl } from './ssrfGuard.mjs';
import { resolvePythonExe } from './pythonExe.mjs';
// P10.0 S2：MCP 基础层（Streamable HTTP /mcp）与它读取的服务端 Workspace 实体。
// 两者都挂在**本进程**上 —— 不新增服务进程（方案 §二.1）。
import { createMcpHandler, ALLOWED_TOOLS } from './mcp.mjs';
import { openWorkspace } from './workspaceHost.mjs';
import {
  buildChatRequest,
  buildDesignRequest,
  extractJson,
  proposalShapeError,
  validatePlan,
  DEFAULT_MAX_TOKENS,
  resolveMaxTokens,
  MAX_OUTPUT_TOKENS_CAP,
  validateIntentRequest,
} from '../shared/aiContract.mjs';
import { quotaView } from '../shared/quota.mjs';

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
/**
 * 服务端 Workspace 落点（P10.0 S1 建立的持久实体；S2 起由 /mcp 只读消费）。
 *
 * 默认与账号库同目录（都在数据卷 `data/` 里），可用 APP_WORKSPACE_PATH 覆盖 ——
 * 与其余 APP_*_PATH 同一条规则：换机器/换目录不该跟着代码走，自动化验收也必须
 * 能在临时目录里跑，不碰真实工作区。
 */
const WORKSPACE_PATH = process.env.APP_WORKSPACE_PATH ? resolve(process.env.APP_WORKSPACE_PATH) : join(dirname(ACCOUNTS_PATH), 'workspace.json');
const MEM_DIR = dirname(MEM_PATH);
const DIST = join(ROOT, 'dist');

/**
 * ══════════════════════════════════════════════════════════════════════
 *  本项目既定约定（纠正记忆）→ 提示词
 *
 * ── 它修的是什么（2026-10-21）──
 *   这个系统早就有"纠正记忆"：管理后台可编辑 corrections.jsonl、memoryStore 有投影、
 *   currentKnowledge() 也汇总好了 —— 但它**从来没传给 LLM**。
 *   用户在管理后台写的每一条纠正（"面板整板不拆""侧板就是 1 块"），
 *   AI 完全看不到，每次都得在对话里重新说一遍。
 *
 * ── 为什么在这里读文件，而不是在 aiContract 里 ──
 *   aiContract.mjs 是三方 import 的**纯函数**真源（server / src / verify 都引它）。
 *   让它去读文件 = 把它变成有副作用的模块，浏览器与验收环境都会难测。
 *   读文件是服务端的事，所以落在服务端。
 *
 * ── 读数失败怎么办 ──
 *   返回空数组，**绝不因为记忆文件读不了就让 AI 通道失败**。
 *   记忆是"加分项"，不是"前置条件" —— 这个取舍与 workspaceHost 的
 *   "通知失败不改变装载结果"是同一条纪律。
 *
 * ── 只取 status=active ──
 *   pending（还没编译出可执行检查）、rejected 的条目不进提示词。
 *   把未确认的东西当既定约定念给模型，等于让它按半成品规矩办事。
 * ══════════════════════════════════════════════════════════════════════
 */
function activeProjectRules() {
  try {
    if (!existsSync(MEM_PATH)) return [];
    const out = [];
    for (const line of readFileSync(MEM_PATH, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let item;
      try { item = JSON.parse(t); } catch { continue; }
      if (!item || typeof item !== 'object') continue;
      if (item.status !== 'active') continue;
      const nl = String(item.nl ?? '').trim();
      if (!nl) continue;
      out.push({ nl, tags: Array.isArray(item.tags) ? item.tags.slice(0, 6) : [] });
    }
    return out;
  } catch {
    return [];
  }
}

// ── 导出链路的外部程序 ──
const EMIT_NEUTRAL_TS = join(ROOT, 'scripts', 'emit-neutral.ts');
const EMIT_ROOMBOOK_TS = join(ROOT, 'scripts', 'emit-roombook.ts');
const EXPORT_DXF_PY = join(ROOT, 'py', 'export_dxf.py');

// ══════════════ AI 输出预算的服务端硬顶（P10.0 安全前置 ③ / ④）══════════════
//
// ── 它防的是什么（真实缺陷，见 P10.0 §2.3）──
//   `resolveMaxTokens` 只在"把 .env 的值解析成默认值时"做过一次 Math.min；
//   而 /api/ai/chat 与 /api/ai/vision 过去把 `body.maxTokens` **原值透传**给上游
//   （`max_tokens: body.maxTokens > 0 ? body.maxTokens : resolveMaxTokens(...)`），
//   客户端传 maxTokens: 100000000 会被原样转发 —— MAX_OUTPUT_TOKENS_CAP 完全不参与，
//   于是"上限"只是一句注释而不是闸门；/api/settings 的写入路径同样不夹取，
//   造成"落盘 100000 / 界面显示 65536 / 永不提示"的两套口径。
//
// ── 本闸门的形状 ──
//   · 上界 = MAX_OUTPUT_TOKENS_CAP（shared/aiContract.mjs 的**唯一真源**）；
//   · 环境变量 AI_HARD_MAX_TOKENS 只能**收紧**（写大了也夹回 cap，永不提权）；
//   · 四个 AI 端点**统一**走 enforceMaxTokens()（一处判断，不在各端点各写一遍）；
//   · 请求体超顶 ⇒ 明确结构化错误 MAX_TOKENS_EXCEEDED(400)，**不静默改写**
//     （P10.0 §2.3(e)：静默改写会制造"用户以为设置生效了、其实没有"的假象）。
const HARD_MAX_TOKENS_CAP = MAX_OUTPUT_TOKENS_CAP;

/** 服务端硬顶。AI_HARD_MAX_TOKENS 只允许把上限收紧，永远不能抬高到 cap 之上。 */
function hardMaxTokens() {
  const raw = Number(process.env.AI_HARD_MAX_TOKENS);
  if (!Number.isFinite(raw) || raw <= 0) return HARD_MAX_TOKENS_CAP;
  return Math.min(HARD_MAX_TOKENS_CAP, Math.max(1, Math.round(raw)));
}

/**
 * 算出本次请求真正发给上游的 max_tokens。
 * 返回 { ok:true, value } 或 { ok:false, code, error, cap, requested }。
 * 请求体没给/非法 ⇒ 用 .env 的默认（经 resolveMaxTokens 解析后再夹一次 cap）。
 */
function enforceMaxTokens(body, envFallback) {
  const cap = hardMaxTokens();
  const want =
    typeof body?.maxTokens === 'number' && Number.isFinite(body.maxTokens) && body.maxTokens > 0
      ? Math.round(body.maxTokens)
      : null;
  if (want === null) return { ok: true, value: Math.min(cap, resolveMaxTokens(envFallback)) };
  if (want > cap) {
    return {
      ok: false,
      code: 'MAX_TOKENS_EXCEEDED',
      cap,
      requested: want,
      error: `输出上限 ${want} 超过服务端硬顶 ${cap}，已拒绝（该硬顶只能由服务端收紧，请求体不能抬高）`,
    };
  }
  return { ok: true, value: want };
}

/** 统一的超顶拒绝：结构化错误 + 审计（失败调用也要留痕）。 */
function rejectMaxTokens(res, actor, endpoint, mt) {
  auth.audit({
    actor: actor ?? 'local-open',
    action: 'ai.call.rejected',
    result: 'rejected',
    code: mt.code,
    endpoint,
    requested: mt.requested,
    cap: mt.cap,
  });
  return json(res, 400, { ok: false, code: mt.code, error: mt.error, cap: mt.cap });
}

/**
 * 下载图片并转 data URL（供 /api/ai/vision/fetch）。
 * 跟随重定向最多 3 次；限 10MB；超时 15 秒；只接受 image/*。
 */
async function fetchImageAsDataUrl(urlStr, maxRedirects = 3) {
  let url = urlStr;
  for (let i = 0; i <= maxRedirects; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let resp;
    try {
      resp = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { 'User-Agent': 'furniture-cad/1.0 (image-fetch)' },
      });
    } finally {
      clearTimeout(timer);
    }
    // 手动跟随重定向（以便每跳都做 SSRF 检查）
    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      const loc = new URL(resp.headers.get('location'), url).toString();
      /**
       * ★ 每一跳都重新过 SSRF 判定（2026-10-20 审计 P1-1）。
       *   旧实现这里还有一条独立正则，与入口那条各写一遍 —— 而两条都漏了 IPv6
       *   （`URL.hostname` 返回 `[::1]`，正则里的 `::1` 永远匹配不上）。
       *   现在统一走 assertPublicUrl：字面量网段 + DNS 解析后校验，一处判断。
       */
      const hop = await assertPublicUrl(loc);
      if (!hop.ok) throw new Error(`重定向到了不可访问的地址：${hop.reason}`);
      url = loc;
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const ct = resp.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) throw new Error(`不是图片（Content-Type: ${ct || '未知'}）`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > 10 * 1024 * 1024) throw new Error('图片超过 10MB');
    if (buf.length === 0) throw new Error('图片为空');
    return `data:${ct.split(';')[0]};base64,${buf.toString('base64')}`;
  }
  throw new Error('重定向次数过多');
}

/**
 * Python 解释器：优先环境变量，其次项目根的 .venv（spike 用的就是它，ezdxf 装在那里）。
 * 找不到就如实报错，不许"假装导出成功"。
 */
function pythonExe() {
  // 唯一实现在 server/pythonExe.mjs —— 那里记录了这个函数的历史缺陷
  // （裸命令名 python3 在 Windows 上不存在却永远被优先选中，导致导出链路整体不可用）。
  const py = resolvePythonExe(ROOT);
  if (!py) {
    throw new Error(
      '找不到可用的 Python 解释器。导出 DXF/PDF 需要 Python + ezdxf。安装方法：\n' +
      '  python -m venv .venv  &&  .venv/Scripts/pip install ezdxf   （Windows）\n' +
      '  python3 -m venv .venv && .venv/bin/pip install ezdxf        （macOS/Linux）\n' +
      '或设置环境变量 APP_PYTHON 指向解释器的绝对路径。'
    );
  }
  return py;
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

/**
 * ── 服务端工作区（P10.0 · S2）──
 *
 * S1 已经把 `WorkspaceStore`（持有 Semantic Model 的持久实体）建好了，但**没人用它**。
 * S2 要挂 MCP 只读工具，工具必须从**真实工作区**取数 —— 所以这里把该实体接进服务：
 *   · 装载/新建的都是 `src/workspace/workspace.ts` 里那**同一个** WorkspaceStore，
 *     不是 MCP 专用内存模型（方案 §六：工具禁止自建第二套模型）；
 *   · 落盘走 S1 已有的进程内串行写队列（workspaceHost 注入 writeFileAtomic），
 *     与账号库共用同一套并发写保护，不另造。
 *
 * ── 装载失败**不静默重建** ──
 *   文件存在但读不出来（损坏/schema 不认识）时，如实报 `{ok:false}` 并让工具返回
 *   `WORKSPACE_UNAVAILABLE`。**绝不能** catch 之后 create 一个新的 —— 那等于把用户的
 *   工作区悄悄换成一张白纸，而界面上看不出来。宁可让 MCP 工具报错，不要静默换掉数据。
 *
 * ── 与浏览器模型的关系（本阶段已知边界，写在这里免得后人误判）──
 *   浏览器目前仍把语义模型存在本地（S1 保留"浏览器本地所有权"）。服务端工作区是**持有**
 *   而非**定义**，Phase 1 也没有 server→browser 推送通道 —— 所以此刻两者尚未接线：
 *   `cad.get_state` 读到的是服务端工作区自身的状态，不是浏览器里那份。这份"尚未接线"
 *   是有意的现状（S2 只做基础层），不是缺陷掩盖，已写进 S2 执行报告的遗留项。
 *
 * ── 为什么不 await（这一步曾经真的踩到）──
 *   第一版写成顶层 `await openWorkspace(...)`：于是**所有** /api/* 都要等
 *   「动态 import workspace.ts + 解析整张 core 依赖图 + 读规则集 + 建示例项目」跑完
 *   才可能 listen。空载约 1.9 s，看着没事；但全量验收里机器一忙就顶破
 *   验收脚本给的 9 s 启动预算，ai-acceptance 的 G0 当场变红 ——
 *   一个和 AI 通路毫无关系的功能，把 AI 通路的验收拖红了。
 *   所以这里改成**并行**：立刻 listen，工作区在后台装载，只有 /mcp 才 await 它。
 *   工作的边界是：/api/* 与工作区无关 ⇒ 一秒都不该为它等；/mcp 与它有关 ⇒ 必须等到底。
 */
/**
 * 多租户工作区：每个账号独立一份 workspace（数据隔离）。
 * - 路径：data/workspaces/{accountId}/workspace.json
 * - 懒加载：首次访问该账号时才打开
 * - 旧单文件 data/workspace.json 首次由 admin 账号认领（迁移）
 */
const workspaceStates = new Map(); // accountId -> {state, loading}
const workspaceStreams = new Map(); // accountId -> Set<ServerResponse>

/** 向当前账号下的所有浏览器 SSE 连接实时推送草稿/工作区/Agent 步骤事件 */
function broadcastWorkspaceEvent(accountId, payload) {
  const aid = accountId || "local-open";
  const clients = workspaceStreams.get(aid);
  if (!clients || clients.size === 0) return;
  const line = `data: ${JSON.stringify({ ...payload, accountId: aid, timestamp: new Date().toISOString() })}\n\n`;
  for (const clientRes of [...clients]) {
    try {
      clientRes.write(line);
    } catch {
      clients.delete(clientRes);
    }
  }
}

/** 账号的工作区目录 */
function accountWorkspaceDir(accountId) {
  const safeId = String(accountId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(dirname(ACCOUNTS_PATH), 'workspaces', safeId);
}

/** 账号的工作区文件路径 */
function accountWorkspacePath(accountId) {
  return join(accountWorkspaceDir(accountId), 'workspace.json');
}

/**
 * 打开指定账号的工作区（懒加载 + 缓存）。
 * 旧版单文件 data/workspace.json 在首次被认领时迁移到 admin 账号下。
 */
async function openAccountWorkspace(accountId, { allowCreate = true } = {}) {
  const aid = accountId || 'local-open';
  if (workspaceStates.has(aid)) {
    const entry = workspaceStates.get(aid);
    await entry.loading;
    return entry.state;
  }
  /**
   * 未鉴权的调用方（allowCreate:false）不许把一个工作区**凭空创建**出来。
   * 但"文件存在但读不出来"必须照常回报失败 —— 那是要运维看见的故障，
   * 不能因为调用方匿名就假装"还没有工作区"。
   */
  const fileAbsent = !existsSync(accountWorkspacePath(aid));

  const filePath = accountWorkspacePath(aid);
  const entry = {
    state: { ok: false, loading: true, error: '装载中', filePath },
    loading: null,
  };
  workspaceStates.set(aid, entry);

  // 迁移：旧单文件 → 第一个访问的账号（只执行一次，成功后重命名旧文件防重复）
  const { existsSync: _exists, copyFileSync: _copy, mkdirSync: _mkdir, renameSync: _rename } = await import('node:fs');
  try {
    if (!_exists(filePath) && _exists(WORKSPACE_PATH)) {
      _mkdir(dirname(filePath), { recursive: true });
      _copy(WORKSPACE_PATH, filePath);
      // 重命名旧文件，防止其他账号重复认领
      try { _rename(WORKSPACE_PATH, WORKSPACE_PATH + '.migrated'); } catch {}
      try { auth.audit({ actor: aid, action: 'workspace.migrate', result: 'ok', from: WORKSPACE_PATH }); } catch {}
    }
  } catch {
    /* 迁移失败不阻塞，后面 openWorkspace 会如实报错 */
  }

  entry.loading = openWorkspace({
    filePath,
    owner: aid,
    account: aid,
    allowCreate,
    onEvent: (e) => auth.audit(e),
    onDraftChange: (draftId, content) => {
      if (content === null) {
        broadcastWorkspaceEvent(aid, { type: "draft.deleted", draftId });
        return;
      }
      try {
        const parsed = JSON.parse(content);
        const wsObj = entry.state?.workspace;
        const freshness = wsObj?.getDraftFreshness?.(draftId) ?? null;
        const validation = wsObj?.validateDraft?.(draftId) ?? null;
        broadcastWorkspaceEvent(aid, {
          type: "draft.updated",
          draftId,
          runId: parsed.runId ?? freshness?.runId,
          revision: parsed.revision ?? freshness?.revision ?? 0,
          baseModelVersion: parsed.baseModelVersion,
          baseProjectHash: parsed.baseProjectHash,
          liveModelVersion: wsObj?.getLiveModelVersion?.() ?? parsed.baseModelVersion,
          draftHash: freshness?.draftHash ?? "",
          canApply: freshness?.canApply ?? true,
          isStale: freshness?.isStale ?? false,
          project: parsed.project ?? null,
          validation: validation ? { blockingErrors: validation.blockingErrors, issues: validation.issues } : undefined,
        });
      } catch {
        broadcastWorkspaceEvent(aid, { type: "draft.updated", draftId });
      }
    },
    onWorkspaceChange: () => {
      try {
        const wsObj = entry.state?.workspace;
        if (!wsObj) return;
        const snap = captureLiveProjectSnapshot(wsObj);
        broadcastWorkspaceEvent(aid, {
          type: "workspace.updated",
          liveModelVersion: snap.projectSnapshotVersion,
          projectSnapshotId: snap.projectSnapshotId,
          projectSnapshotHash: snap.projectSnapshotHash,
          projectSnapshotVersion: snap.projectSnapshotVersion,
          project: snap.project,
        });
      } catch {
        broadcastWorkspaceEvent(aid, { type: "workspace.updated" });
      }
    },
  })
    .then((s) => {
      entry.state = s;
      return s;
    })
    .catch((e) => {
      entry.state = { ok: false, error: String(e?.message ?? e), filePath };
      try {
        auth.audit({ actor: aid, action: 'workspace.load', result: 'fail', error: entry.state.error });
      } catch {
        /* 审计落不下盘不是新故障 */
      }
      return entry.state;
    });

  await entry.loading;
  return entry.state;
}

/**
 * /mcp 取工作区状态的唯一入口：按账号隔离，await 到底再返回。
 */
const getWorkspaceState = async (accountId, opts) => {
  return openAccountWorkspace(accountId || 'local-open', opts);
};

/** `/mcp` 的唯一处理器（同进程挂载，不新增服务进程）。 */
const handleMcp = createMcpHandler({ auth, getWorkspaceState, audit: (e) => auth.audit(e) });


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
    maxTokens: resolveMaxTokens(env.AI_MAX_TOKENS),
    /**
     * 服务端硬顶（安全前置 ③/④）。前端必须用这个值做输入上限，
     * 不要再自己写死 65536 —— 否则又是"两处各一个数"的老毛病。
     */
    maxTokensCap: hardMaxTokens(),
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 60000),
    providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, baseUrl: v.baseUrl, models: v.models }])),
    envPath: ENV_PATH,
  };
}

// ───────────────────────────── HTTP 工具 ─────────────────────────────

/**
 * ── CORS + 跨站防护（2026-10-20 审计 P1-3）──
 *
 * 历史缺陷：`Access-Control-Allow-Origin: *` 无条件下发，且没有任何 Origin 校验。
 * 后果是一个可复现的攻击链：用户访问恶意页面 → 页面 JS 直接
 * `fetch('http://127.0.0.1:8787/api/auth/register', ...)` → 响应可读、并且带回 token
 * → 在"还没有第一个账号"的窗口期里，攻击者直接成为 owner。
 *
 * 现在的口径：
 *   · 默认只允许**同源**（浏览器不带 Origin 头 / Origin 与 Host 一致）；
 *   · 需要跨源（例如把前端单独部署）时，在 data/.env 里配 `ALLOWED_ORIGINS`
 *     （逗号分隔的**完整 origin**，如 `https://cad.example.com`）；
 *   · 不留 `*` 这个口子 —— 它把一个本地工具变成了任意网页可调用的 API。
 */
function allowedOrigins() {
  const raw = String(process.env.ALLOWED_ORIGINS ?? '').trim();
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 判断某次请求的 Origin 是否被允许。没有 Origin（同源导航/curl）算允许。 */
function originAllowed(req) {
  const origin = String(req.headers?.origin ?? '').trim();
  if (!origin) return true; // 非浏览器或同源导航
  const list = allowedOrigins();
  if (list.includes(origin)) return true;
  // 同源判定：Origin 的 host 与本请求 Host 一致
  try {
    const o = new URL(origin);
    const host = String(req.headers?.host ?? '').trim();
    if (host && o.host === host) return true;
    // 回环地址互认（127.0.0.1 与 localhost 视为同一台机器）
    const loopback = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
    const oHost = o.hostname;
    const reqHost = host.split(':')[0];
    if (loopback.has(oHost) && loopback.has(reqHost)) return true;
  } catch {
    return false;
  }
  return false;
}

function cors(res, req) {
  // 只在确实允许时才回 ACAO；不再无条件 '*'。
  const origin = String(req?.headers?.origin ?? '').trim();
  if (origin && originAllowed(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function json(res, code, body, req) {
  cors(res, req);
  const text = JSON.stringify(body, null, 2);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function workspaceUnavailable(res, state, fallbackStatus = 500) {
  const identityConflict = state?.code === 'WORKSPACE_UNIT_ID_CONFLICT';
  return json(res, identityConflict ? 409 : fallbackStatus, {
    ok: false,
    error: state?.error ?? '服务端工作区不可用',
    code: state?.code ?? 'WORKSPACE_UNAVAILABLE',
  });
}

function workspaceIdentityConflict(res, workspace) {
  const message = workspace?.getUnitIdentityConflict?.();
  if (!message) return false;
  json(res, 409, { ok: false, code: 'WORKSPACE_UNIT_ID_CONFLICT', error: message });
  return true;
}

function exportFailure(res, prefix, error) {
  const blocked = error?.code === 'EXPORT_BLOCKED';
  const identityConflict = error?.code === 'WORKSPACE_UNIT_ID_CONFLICT';
  return json(res, blocked || identityConflict ? 422 : 500, {
    ok: false,
    code: error?.code ?? 'EXPORT_FAILED',
    error: `${prefix}${error?.message ?? String(error)}`,
    ...(blocked ? { blockingErrors: error.issues.length, issues: error.issues } : {}),
  });
}

function freezeProjectSnapshot(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeProjectSnapshot(child);
  }
  return value;
}

/** 在无 await 的同步区间一次性读取版本与深拷贝，后续导出不得回读可变 live。 */
function captureLiveProjectSnapshot(workspace) {
  const project = freezeProjectSnapshot(workspace.getProjectSnapshot());
  const projectSnapshotVersion = workspace.getLiveModelVersion();
  const projectSnapshotHash = hashProjectSnapshot(project);
  return Object.freeze({
    project,
    projectSnapshotId: `${workspace.workspaceId}:v${projectSnapshotVersion}:${projectSnapshotHash}`,
    projectSnapshotHash,
    projectSnapshotVersion,
  });
}

/** 正式导出共用的 fail-closed 门槛。成功后仅返回刚捕获的不可变服务器副本。 */
function confirmExportSnapshot(body, workspace) {
  const live = captureLiveProjectSnapshot(workspace);
  const required = ['projectSnapshotId', 'projectSnapshotHash', 'projectSnapshotVersion'];
  const missing = required.filter((field) => body?.[field] === undefined || body[field] === null || body[field] === '');
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'EXPORT_SNAPSHOT_REQUIRED',
      error: `正式导出缺少已确认快照元数据：${missing.join('、')}。请先读取当前服务器 live 快照后重试。`,
      mismatchFields: missing,
      live,
    };
  }

  const mismatchFields = [];
  if (body.projectSnapshotId !== live.projectSnapshotId) mismatchFields.push('projectSnapshotId');
  if (body.projectSnapshotHash !== live.projectSnapshotHash) mismatchFields.push('projectSnapshotHash');
  if (body.projectSnapshotVersion !== live.projectSnapshotVersion) mismatchFields.push('projectSnapshotVersion');
  if (!body.project || typeof body.project !== 'object' || Array.isArray(body.project) || hashProjectSnapshot(body.project) !== live.projectSnapshotHash) {
    mismatchFields.push('project');
  }
  if (mismatchFields.length > 0) {
    return {
      ok: false,
      code: 'EXPORT_SNAPSHOT_CONFLICT',
      error: '提交内容或快照元数据与服务器当前 live 项目不一致，正式导出已拒绝。请重新读取服务器快照并确认后重试。',
      mismatchFields,
      live,
    };
  }
  return { ok: true, snapshot: live };
}

function exportSnapshotConflict(res, check) {
  cors(res);
  const payload = {
    ok: false,
    code: check.code,
    error: check.error,
    mismatchFields: check.mismatchFields,
    projectSnapshotId: check.live.projectSnapshotId,
    projectSnapshotHash: check.live.projectSnapshotHash,
    projectSnapshotVersion: check.live.projectSnapshotVersion,
  };
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(409, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function exportSnapshotHeaders(snapshot) {
  return {
    'Cache-Control': 'no-store',
    'X-Project-Snapshot-Id': snapshot.projectSnapshotId,
    'X-Project-Snapshot-Hash': snapshot.projectSnapshotHash,
    'X-Project-Snapshot-Version': String(snapshot.projectSnapshotVersion),
  };
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
  if (m) return m[1].trim();
  if (typeof req.url === 'string' && req.url.startsWith('/api/workspace/stream')) {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      return (u.searchParams.get('token') ?? '').trim();
    } catch {
      return '';
    }
  }
  return '';
}

/** 客户端标识：只用于审计，不做信任判断 */
/**
 * 客户端标识。
 *
 * ── 关于 `X-Forwarded-For`（2026-10-20 审计 P1-4 配套）──
 *   登录锁定按 (账号, 来源) 维度生效，来源默认取直连 IP。但生产部署形态是
 *   "nginx/caddy 终止 TLS → 反代到本进程"（见 DEPLOY.md），此时所有请求的
 *   remoteAddress 都是 127.0.0.1 ⇒ 一个人爆破就锁住全公司。
 *
 *   因此：**仅在显式开启反向代理信任时**才采信 XFF（`TRUST_PROXY=1`）。
 *   默认不信任 —— 否则任何人都能伪造该头来绕开锁定（那等于把限流关掉）。
 *   反代单独部署时请在 data/.env 里写 `TRUST_PROXY=1` 并确保反代**覆盖**
 *   （而不是追加）该头。
 */
function clientMeta(req) {
  const direct = req.socket?.remoteAddress ?? '';
  let ip = direct;
  if (process.env.TRUST_PROXY === '1') {
    const xff = req.headers?.['x-forwarded-for'];
    const first = Array.isArray(xff) ? xff[0] : String(xff ?? '').split(',')[0];
    const candidate = String(first ?? '').trim();
    if (candidate) ip = candidate.slice(0, 64);
  }
  return { ip, ua: req.headers?.['user-agent'] ?? '' };
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
  /**
   * 凭据只有两种，且**都在这里**认：
   *   ① 会话 token（登录得到，12h TTL）—— authenticate()
   *   ② 长期 token / PAT（机器用，P10.0 S2）—— authenticateToken()
   * 两者映射到的都是**同一个 account**，之后的 role/canManage/canDesign 判定完全共用下面的代码。
   *
   * 为什么 PAT 必须也走这里，而不是只在 /mcp 认：
   *   如果 PAT 只能在 /mcp 使用，就等于存在第二条认证路径 —— 而权限一旦有两处判定，
   *   两处迟早会不一致。让同一种凭据过同一道门，是本文件开头那条"鉴权判定集中在一处"的延续。
   *
   * 附注：拿 PAT 调 /api/auth/logout 不会撤销自己（logout 只清会话），返回 ok 但实际 no-op；
   * 撤销长期 token 的正确动作是 DELETE /api/account/tokens。
   */
  const acc = auth.authenticate(token) ?? auth.authenticateToken(token);
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

  /**
   * ★ 跨站请求必须先过 Origin 闸（2026-10-20 审计 P1-3）。
   *
   * 放在鉴权**之前**：因为要拦的正是"还没有账号、本来不需要 token"的窗口期
   * —— 那时 requireAuth 一律放行，只有 Origin 能区分"用户自己"和"用户访问的恶意页面"。
   * 写方法（非 GET/HEAD/OPTIONS）一律要求 Origin 可被允许；读方法同样检查，
   * 避免恶意页面读取 /api/security/audit、/api/memory、/api/workspace 里的客户数据。
   */
  if (!originAllowed(req)) {
    return json(res, 403, {
      ok: false,
      code: 'ORIGIN_FORBIDDEN',
      error: '这个来源的跨站请求不被允许。若需要跨源访问，请在服务端 data/.env 配置 ALLOWED_ORIGINS。',
    }, req);
  }

  // ── 鉴权前置：除白名单外一律先过门 ──
  // 管理模式（账号 / 安全 / 系统设置**写操作**）额外要求 canManage；
  // 设计修改类接口（生成方案 / 设计 / AIGC 视觉识别）额外要求 canDesign，禁止只读账号改动模型。
  const isSettingsWrite =
    (pathname === '/api/settings' || pathname.startsWith('/api/settings/')) &&
    (req.method === 'PUT' || req.method === 'POST');
  /**
   * 安全前置 ②（P10.0 §2.2）：/api/memory 的**写**必须要求 canManage。
   *
   * 此前它既不在 managePaths 也不在 designPaths ⇒ 只过"已登录"这一层，
   * **viewer 账号即可整文件覆盖共享的 corrections.jsonl**。而那个文件不是普通配置 ——
   * 它的条目会被当作**纠错规则**消费（scope:"rule" + checkSpec），
   * 覆盖它等于替换整套规则，且覆盖前只留一份同名 .bak。
   * GET 保持"已登录可读"（面板要显示内容），所以只对 PUT/POST 收紧。
   */
  const isMemoryWrite = pathname === '/api/memory' && (req.method === 'PUT' || req.method === 'POST');
  const managePaths =
    pathname.startsWith('/api/account/') ||
    pathname.startsWith('/api/security/') ||
    isSettingsWrite ||
    isMemoryWrite;
  const designPaths =
    pathname === '/api/ai/plan' ||
    pathname === '/api/ai/design' ||
    pathname === '/api/ai/vision' ||
    pathname === '/api/ai/vision/fetch' ||
    pathname === '/api/ai/agent' ||
    (pathname === '/api/workspace' && (req.method === 'PUT' || req.method === 'POST')) ||
    pathname === '/api/projects' ||
    pathname.startsWith('/api/projects/');
  const gate = requireAuth(req, res, pathname, { manage: managePaths, design: designPaths });
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
      /**
       * MCP 基础层自述（P10.0 S2）：如实报出**本阶段**暴露了哪两个只读工具，
       * 而不是让客户端去猜。写工具在本阶段一律没有 —— 列表就是证据。
       */
      mcp: { enabled: true, path: '/mcp', transport: 'streamable-http', tools: ALLOWED_TOOLS },
      /**
       * 服务端工作区状态（按账号隔离，这里查当前账号的）。
       * `ok:false` 表示装载失败（损坏/不可读），此时 MCP 只读工具
       * 会返回 WORKSPACE_UNAVAILABLE —— **不静默重建**，所以这里必须能查见。
       *
       * ── 与 2026-10-20 审计 M1 的取舍 ──
       *   原始缺陷是：/api/health 在 PUBLIC_API 里，未登录也能调，而它会走
       *   getWorkspaceState('local-open') ⇒ 文件不存在就 create + save
       *   ⇒ **一个未鉴权请求就能在磁盘上创建 workspace**，并把**绝对路径**回传给任何人。
       *
       *   现在分两种情形：
       *     · 已登录：照旧装载并回报（这是运维真正要看的状态，MCP 验收也依赖它）；
       *     · 未登录：**只读已装载的缓存，不触发懒加载**，且绝不回传 filePath。
       *   这样既堵住了"未鉴权写盘 + 路径泄露"，又保留了登录用户的诊断能力。
       */
      workspace: await (async () => {
        try {
          const aid = gate.account?.id || 'local-open';
          /**
           * 未登录 ⇒ allowCreate:false：**装载已有的，绝不凭空新建**。
           * 这样既能让运维看到"文件损坏/不可读"这类真故障（那必须收敛成 ok:false + error），
           * 又堵住了"一个匿名请求就把 workspaces/local-open/workspace.json 造出来"的副作用。
           */
          const ws = await getWorkspaceState(aid, { allowCreate: Boolean(gate.account) });
          return {
            ok: ws.ok === true,
            loading: ws.loading === true,
            absent: ws.absent === true,
            // 只有已登录才回传路径 —— 未鉴权请求不该知道服务器目录结构
            ...(gate.account ? { filePath: ws.filePath } : {}),
            workspaceId: ws.workspace?.workspaceId ?? null,
            error: ws.ok === true ? null : (ws.error ?? null),
          };
        } catch (e) {
          return { ok: false, loading: false, workspaceId: null, error: String(e?.message ?? e) };
        }
      })(),
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
        // 原样下发档位定义，界面据此生成"每档给多少"的说明 —— 不手写第二份
        tokens: p.tokens,
        generations: p.generations,
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

  /**
   * 长期 API token（PAT，P10.0 S2）。
   *
   * 为什么需要：MCP 客户端是**机器**，不能拿"人登录一次得到的 12 小时会话"当长期凭据。
   *
   * 权限：这三条路由都落在 `/api/account/` 前缀下 ⇒ 自动继承既有的 canManage 闸
   * （见上方 managePaths 判定），viewer/designer 一律 403 —— **不新增任何权限分支**。
   * token 的创建/校验/撤销全部由 AuthStore 一处实现，HTTP 只是它的一个适配器。
   *
   * 明文 token 只在 POST 响应里出现**一次**；GET 只回短 id 与标签，**永不含哈希**。
   */
  if (pathname === '/api/account/tokens' && req.method === 'GET') {
    const url = new URL(req.url ?? '/', 'http://x');
    const id = String(url.searchParams.get('accountId') ?? '').trim();
    if (!id) return json(res, 400, { ok: false, error: '缺少 accountId' });
    const r = auth.listTokens(id);
    if (!r.ok) return json(res, 404, { ok: false, error: r.error });
    return json(res, 200, { ok: true, accountId: id, ...r });
  }

  if (pathname === '/api/account/tokens' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.accountId ?? '').trim();
    if (!id) return json(res, 400, { ok: false, error: '缺少 accountId' });
    const r = auth.createToken(id, { label: body.label ?? '', actor });
    if (!r.ok) return json(res, r.error === 'ACCOUNT_NOT_FOUND' ? 404 : 400, { ok: false, error: r.error });
    return json(res, 200, {
      ok: true,
      accountId: id,
      token: r.token,
      tokenInfo: r.record,
      note: '明文 token 只返回这一次，请立即保存；服务端只存哈希（记录写进审计的是 tokenId，不是 token）。',
    });
  }

  if (pathname === '/api/account/tokens' && req.method === 'DELETE') {
    const body = await readBody(req);
    const id = String(body.accountId ?? '').trim();
    const tokenId = String(body.tokenId ?? '').trim();
    if (!id || !tokenId) return json(res, 400, { ok: false, error: '缺少 accountId / tokenId' });
    const r = auth.revokeToken(id, tokenId, actor);
    if (!r.ok) return json(res, r.error === 'TOKEN_ID_TOO_SHORT' ? 400 : 404, { ok: false, error: r.error });
    return json(res, 200, { ok: true, accountId: id, ...r });
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
    // 安全前置 ③/④：写入路径也要过闸 —— 否则 .env 里会留下超过硬顶的值，
    // 界面回显却被 resolveMaxTokens 夹到 cap，形成"两个说法"且不提示。
    if (typeof body.maxTokens === 'number' && body.maxTokens > 0) {
      const mt = enforceMaxTokens(body, env.AI_MAX_TOKENS);
      if (!mt.ok) {
        auth.audit({
          actor: gate.account?.id ?? 'local-open',
          action: 'settings.ai',
          result: 'rejected',
          code: mt.code,
          requested: mt.requested,
          cap: mt.cap,
        });
        return json(res, 400, { ok: false, code: mt.code, error: mt.error, cap: mt.cap });
      }
      patch.AI_MAX_TOKENS = String(mt.value);
    }
    // apiKey 缺省 = 不修改（前端只显示后四位，不可能把原文再发回来）
    const apiKeyChanged = typeof body.apiKey === 'string' && body.apiKey.trim() !== '';
    if (apiKeyChanged) patch.AI_API_KEY = body.apiKey.trim();

    writeEnv(patch);
    // 安全前置 ①（P10.0 §2.1）：改 AI Key / Provider / baseUrl / model 过去**完全不留痕**，
    // 而同文件里的 SMTP 设置却有 audit —— 与仓库自身纪律不一致。
    // 只记"改了哪几项"（布尔）与 provider/model 取值；**绝不记 key 明文**。
    auth.audit({
      actor: gate.account?.id ?? 'local-open',
      action: 'settings.ai',
      result: 'ok',
      changed: {
        provider: Object.prototype.hasOwnProperty.call(patch, 'AI_PROVIDER'),
        baseUrl: Object.prototype.hasOwnProperty.call(patch, 'AI_BASE_URL'),
        model: Object.prototype.hasOwnProperty.call(patch, 'AI_MODEL'),
        temperature: Object.prototype.hasOwnProperty.call(patch, 'AI_TEMPERATURE'),
        maxTokens: Object.prototype.hasOwnProperty.call(patch, 'AI_MAX_TOKENS'),
        apiKey: apiKeyChanged,
      },
      provider: patch.AI_PROVIDER ?? '(unchanged)',
      model: patch.AI_MODEL ?? '(unchanged)',
    });
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
    /**
     * ① 额度 —— 对话**也**要计。
     *
     * 以前这条通道既不查额度也不记账：问一句"踢脚线一般多高"同样要花钱（prompt +
     * completion 都得计费），而账上显示是 0。用量是账单，少记比不显示更糟 ——
     * 用户照着界面上的数字估"还能用多久"，估出来的是假的。
     *
     * 但对话**不算一次"生成"**（generation 不传）：生成次数是给"出图"那件事留的，
     * 提问不该吃掉它，否则免费档每天那 1 次会被几个常识问题用光。
     */
    if (gate.account) {
      const q = auth.checkQuota(gate.account.id, { generation: false });
      if (!q.ok) return json(res, 429, { ok: false, error: q.error, code: q.code });
      const m = auth.checkModel(gate.account.id, model);
      if (!m.ok) return json(res, 403, { ok: false, error: m.error, code: m.code });
    }
    const t0 = Date.now();
    try {
      // 安全前置 ③/④：输出预算过服务端硬顶闸（此前 body.maxTokens 原值透传，可被绕过）
      const mt = enforceMaxTokens(body, env.AI_MAX_TOKENS);
      if (!mt.ok) return rejectMaxTokens(res, actor, 'chat', mt);
      const payload = {
        model,
        messages: body.messages,
        temperature: typeof body.temperature === 'number' ? body.temperature : Number(env.AI_TEMPERATURE ?? 0.2),
        /**
         * 默认给足输出预算。推理模型会**先把预算花在思考上** ——
         * 留空交给服务商默认值时，一个"上限偏小"的网关就能让对话整整返回空正文，
         * 而界面上只会显示"AI 没有回答"。见 aiContract 里 DEFAULT_MAX_TOKENS 的说明。
         */
        max_tokens: mt.value,
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
      if (!r.ok) {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms: Date.now() - t0, note: `HTTP ${r.status}` });
        return json(res, 200, { ok: false, error: `HTTP ${r.status}：${text.slice(0, 400)}` });
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms: Date.now() - t0, note: 'bad_envelope' });
        return json(res, 200, { ok: false, error: '服务商返回的不是 JSON', raw: text.slice(0, 400), ms: Date.now() - t0 });
      }
      const choice = data?.choices?.[0] ?? {};
      const content = String(choice?.message?.content ?? '');
      const reasoning = String(choice?.message?.reasoning_content ?? '');
      const finish = choice?.finish_reason;
      const usage = data?.usage ?? null;
      if (gate.account) {
        auth.recordUsage(gate.account.id, {
          model: data?.model ?? model,
          promptTokens: Number(usage?.prompt_tokens ?? 0),
          completionTokens: Number(usage?.completion_tokens ?? 0),
          ok: true,
          ms: Date.now() - t0,
          generation: false,
        });
      }
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
        /**
         * 口径与 /api/ai/plan 保持一致：**不建议靠调大 AI_MAX_TOKENS 解决**。
         * 早先两条通道一个说"调大就好转"、一个说"不建议调大"，同一个故障
         * 在同一个界面上给出两套相反的建议 —— 那比不给建议更糟。
         */
        emptyReason: content.trim()
          ? undefined
          : finish === 'length'
            ? `模型把 ${usage?.completion_tokens ?? '?'} 个输出 token 全花在思考上、还没开始写正文。调大 AI_MAX_TOKENS 通常只是把"空回答"换成"超时"；更可靠的办法是在管理后台换一个非推理模型。`
            : reasoning
              ? '模型只产出了思考过程，没有产出正文。'
              : '模型返回了空的正文。',
        model: data?.model ?? model,
        usage,
        /** 服务端实测耗时（不含浏览器往返）—— 界面要如实显示"这次等了多久" */
        ms: Date.now() - t0,
        /**
         * 这一次花完之后还剩多少。带上它的理由很实际：
         * 界面上的"今日还能生成几次"必须跟着真实消耗走，而每次问 /api/auth/me
         * 重新拉一次是第二次往返 —— 顺手带回是最省事也最不容易漂的做法。
         */
        quota: gate.account ? quotaView(gate.account.plan, gate.account.usage) : undefined,
      });
    } catch (e) {
      const timedOut = e.name === 'AbortError';
      if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms: Date.now() - t0, note: e.name });
      return json(res, 200, {
        ok: false,
        ms: Date.now() - t0,
        error: timedOut ? `超时（超过 ${Number(env.AI_TIMEOUT_MS ?? 120000)}ms）` : e.message,
        note: timedOut ? '推理模型单次可能要十几秒到几十秒 —— 若那台机器确实很慢，把 AI_TIMEOUT_MS 调大。' : '连不上这个地址。',
      });
    }
  }

  /**
   * ─────────────── AI 视觉识别：图片/效果图 → 结构化候选（P5）───────────────
   *
   *  复用 server.mjs 既有的 AI 网关配置（env.AI_BASE_URL / AI_API_KEY / AI_MODEL），
   *  与 /api/ai/chat 同源、换服务商 = 填 baseUrl 不改代码。具体视觉能力由模型决定
   *  （OpenAI / Gemini / Claude / 本地模型 / 兼容网关均可，只要支持 image_url）。
   *
   *  职责边界（与 core 解耦）：
   *   · 本路由**只做识别**，把图 + 指令发给 OpenAI 兼容 /chat/completions，
   *     拿回一个描述「看见了什么」的 JSON；
   *   · **不碰几何、不写模型**—— JSON 回到前端后，由 visionResultToNormalized
   *     诚实映射成 NormalizedDesign，再走 P4 统一链路（compileImport → 预览 → 确认
   *     → CommandBus）。换 Vision 服务商 / 模型，Semantic Model / Geometry / Rules 一行不动。
   */
  /**
   * 图片链接转 data URL（P10.1 识图）。
   * 用户粘贴效果图链接 → 服务端下载 → 返回 data URL → 再调 /api/ai/vision。
   * SSRF 防护：只允许 http/https；禁内网 IP（127/10/172.16-31/192.168/::1 等）；
   * 跟随重定向最多 3 次；限 10MB；超时 15 秒。
   */
  if (pathname === '/api/ai/vision/fetch' && req.method === 'POST') {
    const body = await readBody(req);
    const urlStr = typeof body.url === 'string' ? body.url.trim() : '';
    if (!urlStr) return json(res, 400, { ok: false, error: 'url 不能为空' });
    let url;
    try {
      url = new URL(urlStr);
    } catch {
      return json(res, 400, { ok: false, error: 'url 格式不正确' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return json(res, 400, { ok: false, error: '只支持 http/https 链接' });
    }
    /**
     * ★ SSRF 防护（2026-10-20 审计 P1-1）。旧实现是一条正则，两个已实测的洞：
     *   ① `::1` 分支永远匹配不上 —— URL.hostname 对 IPv6 返回带方括号的 `[::1]`；
     *      `[::ffff:127.0.0.1]` 返回 `[::ffff:7f00:1]`，同样放行。
     *   ② 只比对主机名字符串，不做 DNS 解析后校验 ⇒ 任意域名解析到内网即绕过。
     *   现在统一走 server/ssrfGuard.mjs：字面量网段 + 所有解析结果必须公网。
     */
    const guard = await assertPublicUrl(url);
    if (!guard.ok) {
      return json(res, 400, { ok: false, error: guard.reason });
    }
    try {
      const dataUrl = await fetchImageAsDataUrl(urlStr);
      return json(res, 200, { ok: true, dataUrl, size: dataUrl.length });
    } catch (e) {
      return json(res, 500, { ok: false, error: `图片下载失败：${e.message}` });
    }
  }

  /**
   * 尺寸图专用 system prompt（P10.1）。
   * 尺寸图 = 带尺寸标注的平面布置图/立面图/大样图。与效果图的区别：
   *   · 尺寸是**读标注**，不是估计 —— 每个数字都要注明是从哪条标注线读到的；
   *   · 重点是房间轮廓、墙体位置、门窗洞口、柜体占位（矩形+标注），不是材质质感；
   *   · 标注单位通常是 mm，若图上是 cm/m 要换算并注明。
   */
  const DIMENSION_SYSTEM_PROMPT = [
    '你是定制家具设计软件里的视觉识别助手。用户会发一张**带尺寸标注的图纸**（平面布置图/立面图/大样图），',
    '你要识别并**只输出**一个 JSON 对象，符合下面的 TypeScript 形状（不要输出任何多余文字，也不要用 markdown 代码块包裹）：',
    '',
    'interface VisionResult {',
    '  cabinets: VisionCabinet[];',
    '  relations?: { from: string; to: string; kind: "L-shape" | "side-by-side" | "stacked" | "adjacent"; confidence: "high"|"medium"|"low" }[];',
    '  scale?: { known: boolean; text?: string; referenceMm?: number; confidence: "high"|"medium"|"low" };',
    '  overallConfidence: "high"|"medium"|"low";',
    '  notes?: string[];',
    '  ambiguous?: string[];',
    '}',
    'interface VisionCabinet {',
    '  ref: string; name?: string;',
    '  width?: { value: number; confidence: "high"|"medium"|"low"; source: "annotation"|"reference"|"estimate" };',
    '  height?: { value: number; confidence: "high"|"medium"|"low"; source: "annotation"|"reference"|"estimate" };',
    '  depth?: { value: number; confidence: "high"|"medium"|"low"; source: "annotation"|"reference"|"estimate" };',
    '  rows?: { heightMm?: number; heightRatio?: number; units?: VisionUnit[]; confidence: "high"|"medium"|"low" }[];',
    '  units?: VisionUnit[];',
    '  components?: { type: "door"|"drawer"|"open-shelf"|"shelf"|"appliance-cavity"; location?: string; confidence: "high"|"medium"|"low" }[];',
    '  rotation?: number; room?: string; confidence: "high"|"medium"|"low";',
    '  notVisible?: ("depth"|"board-thickness"|"inner-partitions"|"connection"|"real-size")[];',
    '}',
    'interface VisionUnit { kind: "shelves"|"drawerBank"|"hanging"|"open"|"appliance"; widthMm?: number; widthRatio?: number; count?: number; doorCount?: number; confidence: "high"|"medium"|"low" }',
    '',
    '读图纪律（最重要）：',
    '· 这是**尺寸图**，尺寸以**标注数字**为准 —— 每个 width/height/depth 的 source 能填 "annotation" 就填 "annotation"，并在 notes 里写清"宽 3600 取自底部标注线"。',
    '· 单位换算：图上若是 cm/m（如 360），一律换算成 mm（3600）再填 value，并在 notes 注明原标注。',
    '· 房间轮廓优先：先认房间的外框和墙体，再认房间里的柜体占位矩形。门窗洞口的位置和宽度也要读出来写进 notes。',
    '· 立面图：高度方向的标注（如 2400 通顶、吊柜 800）填 height；平面图：只给 width/depth，height 填 notVisible。',
    '· 标注模糊/被遮挡的数字：不要猜，写进 ambiguous（如"右下角 12xx 看不清"），对应字段 source 填 "estimate" 且 confidence 填 "low"。',
    '· 和效果图一样：看不见内部结构的不脑补，看不清数量的写 ambiguous。',
  ];

  /**
   * 服务端工作区读取（P10.2）。
   * 前端工作台启动时从 localStorage 恢复草稿，与服务端（MCP 写入的）数据不一致。
   * 这个接口让前端能拉取服务端当前账号的 live 项目。
   * 权限：登录即可（只能看自己的）。
   */
  if (pathname === '/api/workspace' && req.method === 'GET') {
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const snapshot = captureLiveProjectSnapshot(ws.workspace);
    const identityDiagnostics = ws.workspace.getUnitIdentityDiagnostics?.() ?? {
      readOnly: Boolean(ws.workspace.getUnitIdentityConflict?.()),
      code: ws.workspace.getUnitIdentityConflict?.() ? WORKSPACE_UNIT_ID_CONFLICT : null,
      message: ws.workspace.getUnitIdentityConflict?.() ?? null,
      duplicateUnitIds: findDuplicateUnitIds(snapshot.project).map((item) => ({ ...item, scope: 'live project' })),
    };
    return json(res, 200, {
      ok: true,
      project: snapshot.project,
      identityDiagnostics,
      liveModelVersion: ws.workspace.getLiveModelVersion(),
      workspaceId: ws.workspace.workspaceId,
      projectSnapshotId: snapshot.projectSnapshotId,
      projectSnapshotHash: snapshot.projectSnapshotHash,
      projectSnapshotVersion: snapshot.projectSnapshotVersion,
    });
  }

  /**
   * 浏览器本地修改同步至服务端工作区（PUT /api/workspace）。
   * 含防空覆盖水位线保护：若本地声明 clientHasLocalEdits=false 且云端已有版本演进，
   * 不覆盖云端，直接将云端快照回传给前端注水。
   */
  if (pathname === '/api/workspace' && (req.method === 'PUT' || req.method === 'POST')) {
    const body = await readBody(req);
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const syncRes = await ws.workspace.syncClientProject(body?.project, {
      expectedLiveVersion: typeof body?.expectedLiveVersion === 'number' ? body.expectedLiveVersion : undefined,
      clientHasLocalEdits: typeof body?.clientHasLocalEdits === 'boolean' ? body.clientHasLocalEdits : true,
      force: body?.force === true,
      reason: typeof body?.reason === 'string' ? body.reason : 'browser sync',
    });
    if (!syncRes.ok) {
      const snapshot = captureLiveProjectSnapshot(ws.workspace);
      return json(res, syncRes.code === 'PROJECT_INVALID' ? 400 : 409, {
        ok: false,
        code: syncRes.code,
        error: syncRes.message,
        liveModelVersion: snapshot.projectSnapshotVersion,
        projectSnapshotId: snapshot.projectSnapshotId,
        projectSnapshotHash: snapshot.projectSnapshotHash,
        projectSnapshotVersion: snapshot.projectSnapshotVersion,
        project: snapshot.project,
      });
    }
    const snapshot = captureLiveProjectSnapshot(ws.workspace);
    const identityDiagnostics = ws.workspace.getUnitIdentityDiagnostics?.() ?? {
      readOnly: Boolean(ws.workspace.getUnitIdentityConflict?.()),
      code: ws.workspace.getUnitIdentityConflict?.() ? WORKSPACE_UNIT_ID_CONFLICT : null,
      message: ws.workspace.getUnitIdentityConflict?.() ?? null,
      duplicateUnitIds: findDuplicateUnitIds(snapshot.project).map((item) => ({ ...item, scope: 'live project' })),
    };
    auth.audit({
      actor: gate.account?.id ?? 'local-open',
      action: 'workspace.sync',
      result: syncRes.hydratedFromServer ? 'hydrated_from_server' : syncRes.unchanged ? 'unchanged' : 'updated',
      liveModelVersion: snapshot.projectSnapshotVersion,
    });
    return json(res, 200, {
      ok: true,
      unchanged: syncRes.unchanged,
      hydratedFromServer: syncRes.hydratedFromServer,
      project: snapshot.project,
      identityDiagnostics,
      liveModelVersion: snapshot.projectSnapshotVersion,
      workspaceId: ws.workspace.workspaceId,
      projectSnapshotId: snapshot.projectSnapshotId,
      projectSnapshotHash: snapshot.projectSnapshotHash,
      projectSnapshotVersion: snapshot.projectSnapshotVersion,
    });
  }

  /**
   * 服务端工作区与 MCP/Agent 草稿实时流（GET /api/workspace/stream，SSE）。
   * 浏览器打开后保持长连接，MCP 或内置 Agent 每画一步立即推送到浏览器主视口预览。
   */

  /**
   * 显式一键修复工作区（含 live project、草稿、syncReceipts 与历史项目文件）的重复 Unit/backUnit ID
   * 并自动错开重叠房间，解除 WORKSPACE_UNIT_ID_CONFLICT 只读锁定（POST /api/workspace/repair-unit-ids）。
   */
  if (pathname === '/api/workspace/repair-unit-ids' && req.method === 'POST') {
    /**
     * ★ 这是一个**会改项目文件**的写操作，必须要求设计权限（2026-10-20 审计 P1-6）。
     *   历史缺陷：该路由既不在 managePaths 也不在 designPaths，
     *   实测只读账号（viewer）调用返回 200 —— 只读账号不该能触发任何落盘改动。
     */
    if (gate.mode !== 'local-open' && !ROLES[gate.account?.role]?.canDesign) {
      return json(res, 403, { ok: false, error: '只读账号不能执行修复操作', code: 'FORBIDDEN' });
    }
    const aid = gate.account?.id || 'local-open';
    const ws = await getWorkspaceState(aid);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const repairRes = await ws.workspace.repairUnitIdentityConflicts();
    // 同步检查并修复该账号下多项目目录里的历史项目文件（若有）
    try {
      const dataDir = accountWorkspaceDir(aid);
      const projectsDir = join(dataDir, 'projects');
      if (existsSync(projectsDir)) {
        const { readdirSync: rdSync } = await import('node:fs');
        for (const f of rdSync(projectsDir)) {
          if (!f.endsWith('.json')) continue;
          const fp = join(projectsDir, f);
          try {
            const rawEnv = JSON.parse(readFileSync(fp, 'utf8'));
            const targetProj = rawEnv?.project ?? rawEnv;
            if (targetProj && typeof targetProj === 'object' && Array.isArray(targetProj.cabinets)) {
              const { project: fixedProj, repairedCount } = repairDuplicateUnitIdsInProject(targetProj);
              const { project: cleanProj, movedRooms } = deoverlapProjectRooms(fixedProj);
              if (repairedCount > 0 || movedRooms.length > 0) {
                if (rawEnv?.project) rawEnv.project = cleanProj;
                else Object.assign(rawEnv, cleanProj);
                writeFileSync(fp, JSON.stringify(rawEnv, null, 2) + '\n', 'utf8');
              }
            }
          } catch {
            /* ignore malformed auxiliary project file */
          }
        }
      }
    } catch {
      /* ignore */
    }
    const snapshot = captureLiveProjectSnapshot(ws.workspace);
    const identityDiagnostics = ws.workspace.getUnitIdentityDiagnostics?.() ?? {
      readOnly: false,
      code: null,
      message: null,
      duplicateUnitIds: [],
    };
    auth.audit({
      actor: aid,
      action: 'workspace.repair_unit_ids',
      result: 'ok',
      repairedLive: repairRes.repairedLive,
      repairedDrafts: repairRes.repairedDrafts,
      repairedReceipts: repairRes.repairedReceipts,
      deoverlappedRooms: repairRes.deoverlappedRooms,
      liveModelVersion: snapshot.projectSnapshotVersion,
    });
    broadcastWorkspaceEvent(aid, {
      type: 'workspace.updated',
      liveModelVersion: snapshot.projectSnapshotVersion,
      projectSnapshotId: snapshot.projectSnapshotId,
      projectSnapshotHash: snapshot.projectSnapshotHash,
      projectSnapshotVersion: snapshot.projectSnapshotVersion,
      project: snapshot.project,
    });
    return json(res, 200, {
      ok: true,
      repairedLive: repairRes.repairedLive,
      repairedDrafts: repairRes.repairedDrafts,
      repairedReceipts: repairRes.repairedReceipts,
      deoverlappedRooms: repairRes.deoverlappedRooms,
      project: snapshot.project,
      identityDiagnostics,
      liveModelVersion: snapshot.projectSnapshotVersion,
      workspaceId: ws.workspace.workspaceId,
      projectSnapshotId: snapshot.projectSnapshotId,
      projectSnapshotHash: snapshot.projectSnapshotHash,
      projectSnapshotVersion: snapshot.projectSnapshotVersion,
    });
  }

  if (pathname === '/api/workspace/stream' && req.method === 'GET') {
    const aid = gate.account?.id || 'local-open';
    const ws = await getWorkspaceState(aid);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    let clients = workspaceStreams.get(aid);
    if (!clients) {
      clients = new Set();
      workspaceStreams.set(aid, clients);
    }
    clients.add(res);
    const snapshot = captureLiveProjectSnapshot(ws.workspace);
    const drafts = ws.workspace.listDrafts();
    const latestDraftMeta = drafts.length > 0 ? drafts[drafts.length - 1] : null;
    const latestDraftProject = latestDraftMeta ? ws.workspace.draftState(latestDraftMeta.draftId) : null;
    const initEvent = {
      type: 'init',
      workspaceId: ws.workspace.workspaceId,
      liveModelVersion: snapshot.projectSnapshotVersion,
      projectSnapshotId: snapshot.projectSnapshotId,
      projectSnapshotHash: snapshot.projectSnapshotHash,
      projectSnapshotVersion: snapshot.projectSnapshotVersion,
      project: snapshot.project,
      drafts,
      latestDraft: latestDraftMeta && latestDraftProject
        ? { ...latestDraftMeta, project: latestDraftProject }
        : null,
      timestamp: new Date().toISOString(),
    };
    res.write(`data: ${JSON.stringify(initEvent)}\n\n`);
    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
        clients.delete(res);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }

  /**
   * 草稿管理 HTTP 接口（P10.1）。
   * MCP 的 draft 在服务端，工作台之前没有入口看 —— 这三个接口补上。
   * 权限与 MCP 工具对齐：list=登录即可看；apply=manage（admin+）；
   * discard=草稿归属者或 manage。
   */
  if (pathname === '/api/drafts' && req.method === 'GET') {
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const drafts = ws.workspace.listDrafts().map((d) => ({
      draftId: d.draftId,
      runId: d.runId,
      revision: d.revision,
      owner: d.owner,
      createdAt: d.createdAt,
      baseModelVersion: d.baseModelVersion,
      baseProjectHash: d.baseProjectHash,
      liveModelVersion: d.liveModelVersion,
      liveProjectHash: d.liveProjectHash,
      draftHash: d.draftHash,
      isStale: d.isStale,
      staleReason: d.staleReason,
      canApply: d.canApply,
    }));
    return json(res, 200, {
      ok: true,
      drafts,
      liveModelVersion: ws.workspace.getLiveModelVersion(),
      identityDiagnostics: ws.workspace.getUnitIdentityDiagnostics?.() ?? {
        readOnly: Boolean(ws.workspace.getUnitIdentityConflict?.()),
        code: ws.workspace.getUnitIdentityConflict?.() ? WORKSPACE_UNIT_ID_CONFLICT : null,
        message: ws.workspace.getUnitIdentityConflict?.() ?? null,
        duplicateUnitIds: [],
      },
    });
  }

  // 实时预览只读服务端 draft；草稿仍未写入 live，应用仍须走既有确认入口。
  if (pathname.startsWith('/api/drafts/') && req.method === 'GET') {
    let draftId;
    try { draftId = decodeURIComponent(pathname.slice('/api/drafts/'.length)); }
    catch { return json(res, 400, { ok: false, error: 'draftId 编码无效', code: 'DRAFT_ID_INVALID' }); }
    if (!draftId || draftId.includes('/')) return json(res, 400, { ok: false, error: 'draftId 无效', code: 'DRAFT_ID_INVALID' });
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const handle = ws.workspace.getDraft(draftId);
    if (handle && gate.mode !== 'local-open' && handle.owner !== gate.account?.id && !ROLES[gate.account?.role]?.canManage) {
      return json(res, 403, { ok: false, error: '只能预览自己的草稿', code: 'FORBIDDEN' });
    }
    const project = ws.workspace.draftState(draftId);
    const validation = ws.workspace.validateDraft(draftId);
    if (!handle || !project || !validation) return json(res, 404, { ok: false, error: `草稿不存在：${draftId}`, code: 'DRAFT_NOT_FOUND' });
    const freshness = ws.workspace.getDraftFreshness(draftId);
    const identityDiagnostics = ws.workspace.getUnitIdentityDiagnostics?.() ?? {
      readOnly: Boolean(ws.workspace.getUnitIdentityConflict?.()),
      code: ws.workspace.getUnitIdentityConflict?.() ? WORKSPACE_UNIT_ID_CONFLICT : null,
      message: ws.workspace.getUnitIdentityConflict?.() ?? null,
      duplicateUnitIds: findDuplicateUnitIds(project).map((item) => ({ ...item, scope: `draft ${draftId}` })),
    };
    return json(res, 200, {
      ok: true,
      draftId,
      owner: handle.owner,
      baseModelVersion: handle.baseModelVersion,
      baseProjectHash: handle.baseProjectHash,
      ...freshness,
      workspaceId: ws.workspace.workspaceId,
      project,
      identityDiagnostics,
      validation: { blockingErrors: validation.blockingErrors, issues: validation.issues },
    });
  }

  if (pathname.startsWith('/api/drafts/') && pathname.endsWith('/apply') && req.method === 'POST') {
    // local-open 模式没有账号体系，直接放行；accounts 模式需要 manage（admin+）
    if (gate.mode !== 'local-open' && !ROLES[gate.account?.role]?.canManage) {
      return json(res, 403, { ok: false, error: '需要管理权限', code: 'FORBIDDEN' });
    }
    let draftId;
    try { draftId = decodeURIComponent(pathname.slice('/api/drafts/'.length, -'/apply'.length)); }
    catch { return json(res, 400, { ok: false, error: 'draftId 编码无效', code: 'DRAFT_ID_INVALID' }); }
    if (!draftId || draftId.includes('/')) return json(res, 400, { ok: false, error: 'draftId 无效', code: 'DRAFT_ID_INVALID' });
    const body = await readBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.__raw !== undefined) {
      return json(res, 400, { ok: false, error: 'apply 请求体必须是合法 JSON 对象。', code: 'REQUEST_INVALID' });
    }
    if (typeof body.syncId !== 'undefined' && (typeof body.syncId !== 'string' || !body.syncId.trim() || body.syncId.length > 200)) {
      return json(res, 400, { ok: false, error: 'syncId 必须是 1–200 个字符的非空字符串。', code: 'SYNC_ID_INVALID' });
    }
    const confirmationFields = ['runId', 'draftId', 'revision', 'draftHash', 'localVersion', 'remoteVersion'];
    const missing = confirmationFields.filter((field) => body[field] === undefined || body[field] === null || body[field] === '');
    if (missing.length > 0) {
      return json(res, 400, {
        ok: false,
        error: `apply 必须提供完整确认元数据，缺少：${missing.join('、')}。请重新读取预览并明确确认。`,
        code: 'APPLY_METADATA_REQUIRED',
        missingFields: missing,
      });
    }
    if (typeof body.runId !== 'string' || !body.runId.trim() || body.runId.length > 200
      || typeof body.draftId !== 'string' || !body.draftId.trim()
      || !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.draftHash !== 'string' || !/^[a-f0-9]{64}$/i.test(body.draftHash)
      || !Number.isSafeInteger(body.localVersion) || body.localVersion < 0
      || !Number.isSafeInteger(body.remoteVersion) || body.remoteVersion < 0) {
      return json(res, 400, { ok: false, error: 'runId/draftId/draftHash 必须有效，revision/localVersion/remoteVersion 必须是非负安全整数。', code: 'APPLY_METADATA_INVALID' });
    }
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    let r;
    try {
      r = await ws.workspace.applyDraft(draftId, {
        syncId: body.syncId,
        runId: body.runId,
        draftId: body.draftId,
        revision: body.revision,
        draftHash: body.draftHash,
        localVersion: body.localVersion,
        remoteVersion: body.remoteVersion,
        ...(body.baseModelVersion === undefined ? {} : { baseModelVersion: body.baseModelVersion }),
        ...(body.baseProjectHash === undefined ? {} : { baseProjectHash: body.baseProjectHash }),
      });
    } catch (error) {
      if (error?.code === 'APPLY_COMMITTED_CLEANUP_FAILED') {
        auth.audit({ action: 'draft.apply', actor: gate.account?.id, draftId, result: 'committed_cleanup_failed', syncId: error.syncId });
        return json(res, 500, {
          ok: false,
          code: error.code,
          committed: true,
          retryable: true,
          syncId: error.syncId,
          draftId: error.draftId,
          newVersion: error.newVersion,
          liveModelVersion: ws.workspace.getLiveModelVersion(),
          receipt: error.receipt,
          error: error.message,
        });
      }
      throw error;
    }
    if (!r.ok) {
      return json(res, r.code === 'SYNC_ID_INVALID' ? 400 : 409, {
        ok: false,
        error: r.message,
        code: r.code,
        draftId: r.draftId,
        baseVersion: r.baseVersion,
        currentVersion: r.currentVersion,
        baseProjectHash: r.baseProjectHash,
        currentProjectHash: r.currentProjectHash,
      });
    }
    auth.audit({ action: 'draft.apply', actor: gate.account?.id, draftId, result: 'ok' });
    return json(res, 200, {
      ok: true,
      syncId: r.syncId,
      draftId: r.draftId,
      runId: r.runId,
      revision: r.revision,
      draftHash: r.hash,
      ...(r.localVersion === undefined ? {} : { localVersion: r.localVersion }),
      remoteVersion: r.remoteVersion,
      baseModelVersion: r.baseModelVersion,
      baseProjectHash: r.baseProjectHash,
      newVersion: r.newVersion,
      liveModelVersion: r.newVersion,
      workspaceId: r.workspaceId,
      project: r.project,
    });
  }

  if (pathname.startsWith('/api/drafts/') && pathname.endsWith('/discard') && req.method === 'POST') {
    const draftId = pathname.split('/')[3];
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const identityRejected = workspaceIdentityConflict(res, ws.workspace);
    if (identityRejected) return identityRejected;
    const h = ws.workspace.getDraft(draftId);
    if (!h) return json(res, 404, { ok: false, error: `draft 不存在：${draftId}`, code: 'DRAFT_NOT_FOUND' });
    // 归属者或 manage（与 MCP cad.discard_draft 一致）；local-open 直接放行
    if (gate.mode !== 'local-open') {
      const mine = h.owner === gate.account?.id;
      if (!mine && !ROLES[gate.account?.role]?.canManage) {
        return json(res, 403, { ok: false, error: '只能丢弃自己的草稿', code: 'FORBIDDEN' });
      }
    }
    await ws.workspace.discardDraft(draftId);
    auth.audit({ action: 'draft.discard', actor: gate.account?.id, draftId, result: 'ok' });
    return json(res, 200, { ok: true });
  }

  /**
   * Agent 循环（内置 AI Agent 模式）。
   * 用户意图 → AI 调 MCP 工具 → 失败重试（3 轮）→ validate → 返回步骤+总结。
   * 复用 MCP 工具链（localhost HTTP）、vision 链路、AI 网关配置。
   */
  if (pathname === '/api/ai/agent' && req.method === 'POST') {
    const body = await readBody(req);
    const requestedRoomId = typeof body.roomId === 'string' ? body.roomId.trim() : '';
    const unassignedSentinel = /^_+unassigned__$/.test(requestedRoomId);
    if (body.roomContext === 'unassigned' || body.unassignedRoom === true || unassignedSentinel) {
      return json(res, 409, {
        ok: false,
        code: 'ROOM_CONTEXT_REQUIRED',
        error: '未分配房间中的柜体不能执行 Agent 创建或修改操作，请先选择真实房间或将柜体分配到房间。',
      });
    }
    if (!requestedRoomId) {
      return json(res, 409, {
        ok: false,
        code: 'ROOM_CONTEXT_REQUIRED',
        error: 'Agent 操作需要一个真实房间上下文，请先选择房间后重试。',
      });
    }
    // 浏览器的本地语义模型与 MCP 服务端工作区尚未自动接线。不能只相信前端 roomId：
    // 先在当前账号的服务端项目里核验，错位时在模型/MCP 执行前失败关闭，防止单房间回退错放。
    const agentWorkspace = await getWorkspaceState(gate.account?.id);
    if (!agentWorkspace.ok) {
      return workspaceUnavailable(res, {
        ...agentWorkspace,
        error: `服务端工作区不可用，Agent 操作已拒绝：${agentWorkspace.error ?? '未知错误'}`,
      }, 503);
    }
    const agentIdentityRejected = workspaceIdentityConflict(res, agentWorkspace.workspace);
    if (agentIdentityRejected) return agentIdentityRejected;
    let agentProject = agentWorkspace.workspace.getProjectSnapshot();
    let serverRoom = agentProject.rooms.find((room) => room.id === requestedRoomId);
    if (!serverRoom && body.autoSyncProject && typeof body.autoSyncProject === 'object') {
      const syncRes = await agentWorkspace.workspace.syncClientProject(body.autoSyncProject, {
        clientHasLocalEdits: true,
        force: true,
        reason: 'agent auto-sync room context',
      });
      if (syncRes.ok) {
        agentProject = agentWorkspace.workspace.getProjectSnapshot();
        serverRoom = agentProject.rooms.find((room) => room.id === requestedRoomId);
      }
    }
    if (!serverRoom) {
      return json(res, 409, {
        ok: false,
        code: 'ROOM_CONTEXT_MISMATCH',
        error: `当前房间 ID「${requestedRoomId}」不属于服务端工作区。浏览器本地项目与服务端工作区尚未同步；为避免柜体进入错误房间，Agent 操作已拒绝。请先同步/选择服务端工作区中的房间。`,
      });
    }
    const baseUrl = (env.AI_BASE_URL || '').replace(/\/+$/, '');
    const key = env.AI_API_KEY || '';
    const model = body.model || env.AI_MODEL || s.model;
    if (!baseUrl || !key) return json(res, 400, { ok: false, error: '尚未配置 Base URL / API Key' });
    if (typeof body.intent !== 'string' || !body.intent.trim()) {
      return json(res, 400, { ok: false, error: 'intent 不能为空' });
    }
    // 额度检查（走对话额度，不算生成次数）
    if (gate.account) {
      const q = auth.checkQuota(gate.account.id, { generation: false });
      if (!q.ok) return json(res, 429, { ok: false, error: q.error, code: q.code });
    }
    const { runAgentLoop } = await import('./agentLoop.mjs');
    // MCP 地址：本机回环
    const mcpBaseUrl = `http://127.0.0.1:${PORT}`;
    // 用户 token：从 Authorization 头透传给 MCP
    const userToken = bearer(req);
    try {
      const result = await runAgentLoop({
        intent: body.intent.trim(),
        images: Array.isArray(body.images) ? body.images : null,
        visionResult: body.visionResult || null,
        draftId: body.draftId || null,
        history: Array.isArray(body.history) ? body.history : null,
        roomId: serverRoom.id,
        // 服务端 workspace 的房间名是真源，避免前端传入 stale/mismatched name。
        roomName: serverRoom.name,
        workspaceProject: agentProject,
        token: userToken,
        mcpBaseUrl,
        aiConfig: {
          baseUrl,
          apiKey: key,
          model,
          timeoutMs: Number(env.AI_TIMEOUT_MS ?? 120000),
        },
        onStep: (step, activeDraftId) => {
          const aid = gate.account?.id || 'local-open';
          const dId = activeDraftId || step?.draftId || null;
          const draftProject = dId ? agentWorkspace.workspace.draftState(dId) : null;
          const freshness = dId ? agentWorkspace.workspace.getDraftFreshness(dId) : null;
          broadcastWorkspaceEvent(aid, {
            type: 'agent.step',
            step,
            draftId: dId,
            draftProject,
            freshness,
          });
        },
      });
      // 记账
      if (gate.account) auth.recordUsage(gate.account.id, { generation: false });
      /**
       * ── 设计意图：校验后如实回传（2026-10-20）──
       *
       * Agent 循环已经从最终回答里捞出了 intentRequestRaw（未校验）。
       * 这里过唯一的那份校验器：
       *   · 合法 → 回 intentRequest，前端建 candidate 意图并请用户确认；
       *   · 非法 → 回 intentRequestError，让用户知道"AI 写了但不合契约"，
       *     而不是让他以为 AI 没反应。
       * 校验规则只有一份（shared/aiContract.mjs），这里不重复实现。
       */
      let agentIntent;
      let agentIntentError;
      if (result.intentRequestRaw !== undefined) {
        const v = validateIntentRequest(result.intentRequestRaw);
        if (v.ok) agentIntent = v.request;
        else agentIntentError = { code: v.code, error: v.error };
        auth.audit({
          actor: gate.account?.id ?? 'local-open',
          action: 'ai.agent.intent',
          result: v.ok ? 'accepted' : 'rejected',
          code: v.ok ? undefined : v.code,
        });
      }
      const { intentRequestRaw: _rawIntent, ...agentRest } = result;
      return json(res, 200, {
        ok: true,
        ...agentRest,
        ...(agentIntent ? { intentRequest: agentIntent } : {}),
        ...(agentIntentError ? { intentRequestError: agentIntentError } : {}),
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: `Agent 执行失败：${e?.message ?? e}`, code: 'AGENT_FAILED' });
    }
  }

  /**
   * 项目目录管理（多项目）。
   * GET  /api/projects              列出项目
   * POST /api/projects              创建项目 {name}
   * POST /api/projects/:id/activate 先校验目标身份，再原子切换当前项目
   * DELETE /api/projects/:id        删除项目
   */
  // 项目目录按账号隔离
  const DATA_DIR = accountWorkspaceDir(gate.account?.id || 'local-open');
  if (pathname === '/api/projects' && req.method === 'GET') {
    const { listProjects, migrateIfNeeded } = await import('./projects.mjs');
    await migrateIfNeeded(DATA_DIR, WORKSPACE_PATH);
    const projects = listProjects(DATA_DIR);
    return json(res, 200, { ok: true, projects });
  }
  if (pathname === '/api/projects' && req.method === 'POST') {
    const body = await readBody(req);
    const { createProject, listProjects, migrateIfNeeded } = await import('./projects.mjs');
    await migrateIfNeeded(DATA_DIR, WORKSPACE_PATH);
    if (typeof body.name !== 'string' || !body.name.trim()) {
      return json(res, 400, { ok: false, error: '项目名称不能为空' });
    }
    const p = await createProject(DATA_DIR, body.name);
    return json(res, 200, { ok: true, project: p, projects: listProjects(DATA_DIR) });
  }
  const activateMatch = pathname.match(/^\/api\/projects\/([^/]+)\/activate$/);
  if (activateMatch && req.method === 'POST') {
    const { setActiveProject, getProjectFilePath, migrateIfNeeded, parseProjectId } = await import('./projects.mjs');
    await migrateIfNeeded(DATA_DIR, WORKSPACE_PATH);
    // projectId 的唯一解析口径：parseProjectId（字符白名单 + 解析后不出 projectsDir 的断言）。
    // 三条 /api/projects/:id 路由共用这一处，不许各写一遍 —— 历史事故见 projects.mjs 文件头。
    const parsedId = parseProjectId(DATA_DIR, activateMatch[1]);
    if (!parsedId.ok) return json(res, 400, { ok: false, error: parsedId.error, code: parsedId.code });
    const projectId = parsedId.id;
    const accountId = gate.account?.id || 'local-open';
    const projectFilePath = getProjectFilePath(DATA_DIR, projectId);
    if (!existsSync(projectFilePath)) return json(res, 404, { ok: false, error: `项目不存在：${projectId}`, code: 'PROJECT_NOT_FOUND' });
    try {
      const targetEnvelope = JSON.parse(readFileSync(projectFilePath, 'utf8'));
      const targetProject = targetEnvelope?.project ?? targetEnvelope;
      if (!targetProject || typeof targetProject !== 'object' || Array.isArray(targetProject)) {
        return json(res, 422, { ok: false, error: '目标项目文件格式无效', code: 'PROJECT_LOAD_FAILED' });
      }
      if (targetProject.id && targetProject.id !== projectId) {
        return json(res, 409, { ok: false, error: '目标文件中的 Project ID 与目录不一致', code: 'PROJECT_ID_MISMATCH' });
      }
      const duplicateUnitIds = findDuplicateUnitIds(targetProject);
      if (duplicateUnitIds.length > 0) {
        const message = unitIdentityConflictMessage('project', duplicateUnitIds);
        return json(res, 409, {
          ok: false,
          code: WORKSPACE_UNIT_ID_CONFLICT,
          error: message,
          identityDiagnostics: { readOnly: true, code: WORKSPACE_UNIT_ID_CONFLICT, message, duplicateUnitIds },
        });
      }
      // 在单独候选 Workspace 中读取目标并验证。直到所有检查通过前，不改 active-project.json，
      // 也不替换当前账号的 workspaceStates entry。
      const currentState = await openAccountWorkspace(accountId);
      if (!currentState.ok) return workspaceUnavailable(res, currentState);
      const candidateState = await openWorkspace({
        filePath: projectFilePath,
        owner: accountId,
        account: accountId,
        onEvent: (event) => auth.audit(event),
      });
      if (!candidateState.ok) return json(res, 422, { ok: false, error: candidateState.error || '目标项目无法载入', code: 'PROJECT_LOAD_FAILED' });
      const candidate = candidateState.workspace;
      const identityDiagnostics = candidate.getUnitIdentityDiagnostics?.() ?? {
        readOnly: Boolean(candidate.getUnitIdentityConflict?.()),
        code: candidate.getUnitIdentityConflict?.() ? WORKSPACE_UNIT_ID_CONFLICT : null,
        message: candidate.getUnitIdentityConflict?.() ?? '',
        duplicateUnitIds: findDuplicateUnitIds(candidate.getProjectSnapshot?.() ?? {}),
      };
      const identityConflict = candidate.getUnitIdentityConflict?.();
      if (identityConflict || identityDiagnostics.readOnly || identityDiagnostics.duplicateUnitIds?.length) {
        const message = identityConflict || identityDiagnostics.message || '目标项目存在历史重复 Unit ID；当前项目保持不变。';
        return json(res, 409, {
          ok: false,
          code: WORKSPACE_UNIT_ID_CONFLICT,
          error: message,
          identityDiagnostics: { ...identityDiagnostics, readOnly: true, code: WORKSPACE_UNIT_ID_CONFLICT },
        });
      }

      await setActiveProject(DATA_DIR, projectId);
      const nextState = { ...candidateState, ok: true };
      const entry = workspaceStates.get(accountId) ?? { state: nextState, loading: Promise.resolve(nextState) };
      entry.state = nextState;
      entry.loading = Promise.resolve(nextState);
      workspaceStates.set(accountId, entry);
      const snapshot = captureLiveProjectSnapshot(candidate);
      return json(res, 200, {
        ok: true,
        activeId: projectId,
        project: snapshot.project,
        liveModelVersion: snapshot.projectSnapshotVersion,
        projectSnapshotId: snapshot.projectSnapshotId,
        projectSnapshotHash: snapshot.projectSnapshotHash,
        projectSnapshotVersion: snapshot.projectSnapshotVersion,
        identityDiagnostics: candidate.getUnitIdentityDiagnostics?.() ?? { readOnly: false, code: null, message: '', duplicateUnitIds: [] },
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: e?.message ?? '切换失败', code: 'PROJECT_SWITCH_FAILED' });
    }
  }
  const deleteMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const { deleteProject, listProjects, parseProjectId } = await import('./projects.mjs');
    /**
     * ★ 安全闸（2026-10-20 审计 P0-1）：这里曾经直接 decodeURIComponent 就进 join()，
     *   而 projects.mjs 用 `join(dir, id + '.json')` 拼路径 —— `..` 被 join 吃掉，
     *   于是 `DELETE /api/projects/..%2F..%2F..%2Faccounts` 能删掉账号库，
     *   重启后 auth.mjs 把"文件不存在"当成"还没有账号"，全站降级免鉴权。
     *   现在与 activate 共用 parseProjectId（白名单 + 解析后不出目录的双断言）。
     */
    const parsedId = parseProjectId(DATA_DIR, deleteMatch[1]);
    if (!parsedId.ok) return json(res, 400, { ok: false, error: parsedId.error, code: parsedId.code });
    const projectId = parsedId.id;
    try {
      await deleteProject(DATA_DIR, projectId);
      return json(res, 200, { ok: true, projects: listProjects(DATA_DIR) });
    } catch (e) {
      return json(res, 400, { ok: false, error: e?.message ?? '删除失败' });
    }
  }

  if (pathname === '/api/ai/vision' && req.method === 'POST') {
    const body = await readBody(req);
    const baseUrl = (env.AI_BASE_URL || '').replace(/\/+$/, '');
    const key = env.AI_API_KEY || '';
    const model = body.model || env.AI_MODEL || s.model;
    if (!baseUrl || !key) return json(res, 400, { ok: false, error: '尚未配置 Base URL / API Key' });
    const multiImages = Array.isArray(body.images)
      ? body.images.filter((img) => img && typeof img.dataUrl === 'string' && img.dataUrl)
      : [];
    const primaryImage = typeof body.image === 'string' && body.image ? body.image : (multiImages[0]?.dataUrl ?? '');
    if (!primaryImage) return json(res, 400, { ok: false, error: 'image 不能为空（应为 data URL）' });
    const hasDimensionImg = body.mode === 'dimension' || multiImages.some((img) => img.mode === 'dimension');
    const hasRenderImg = body.mode === 'render' || multiImages.some((img) => img.mode !== 'dimension');
    // mode: 'render'（效果图，默认）| 'dimension'（尺寸图/平面布置图，带标注）| 'fusion'（效果图+尺寸图联合识别）
    const visionMode = (multiImages.length > 1 && hasDimensionImg && hasRenderImg)
      ? 'fusion'
      : (body.mode === 'dimension' ? 'dimension' : 'render');
    if (gate.account) {
      const q = auth.checkQuota(gate.account.id, { generation: true });
      if (!q.ok) return json(res, 429, { ok: false, error: q.error, code: q.code, quota: q.view });
      const m = auth.checkModel(gate.account.id, model);
      if (!m.ok) return json(res, 403, { ok: false, error: m.error, code: m.code });
    }
    const t0 = Date.now();
    const systemPrompt = visionMode === 'dimension' ? DIMENSION_SYSTEM_PROMPT : [
      '你是定制家具设计软件里的视觉识别助手。用户会发一张柜体效果图/截图，',
      '你要识别并**只输出**一个 JSON 对象，符合下面的 TypeScript 形状（不要输出任何多余文字，也不要用 markdown 代码块包裹）：',
      '',
      'interface VisionResult {',
      '  cabinets: VisionCabinet[];',
      '  relations?: { from: string; to: string; kind: "L-shape" | "side-by-side" | "stacked" | "adjacent"; confidence: "high"|"medium"|"low" }[];',
      '  scale?: { known: boolean; text?: string; referenceMm?: number; confidence: "high"|"medium"|"low" };',
      '  overallConfidence: "high"|"medium"|"low";',
      '  notes?: string[];',
      '  ambiguous?: string[];',
      '}',
      'interface VisionCabinet {',
      '  ref: string; name?: string;',
      '  width?: { value: number; confidence: "high"|"medium"|"low"; source: "annotation"|"reference"|"estimate" };',
      '  height?: { value: number; confidence: "high"|"medium"|"low"; source: "annotation"|"reference"|"estimate" };',
      '  depth?: { value: number; confidence: "high"|"medium"|"low"; source: "annotation"|"reference"|"estimate" };',
      '  rows?: { heightMm?: number; heightRatio?: number; units?: VisionUnit[]; confidence: "high"|"medium"|"low" }[];',
      '  units?: VisionUnit[];',
      '  components?: { type: "door"|"drawer"|"open-shelf"|"shelf"|"appliance-cavity"; location?: string; confidence: "high"|"medium"|"low" }[];',
      '  rotation?: number; room?: string; confidence: "high"|"medium"|"low";',
      '  notVisible?: ("depth"|"board-thickness"|"inner-partitions"|"connection"|"real-size")[];',
      '}',
      'interface VisionUnit { kind: "shelves"|"drawerBank"|"hanging"|"open"|"appliance"; widthMm?: number; widthRatio?: number; count?: number; doorCount?: number; confidence: "high"|"medium"|"low" }',
      '',
      '诚实纪律（最重要）：',
      '· 图片里**看不见**真实深度、板厚、隐藏隔板、柜体连接方式、整柜真实尺寸（无标注时只是视觉估计）—— 一律写进 notVisible，不要编造具体数值。',
      '· 整柜尺寸若无标注，source 必须填 "estimate"，并在 scale.known 填 false；有尺寸标注/可识别参考物才填 "annotation"/"reference" 且 scale.known=true。',
      '· 只把你**确实看见**的左右分区(units) / 上下分层(rows) / 门·抽屉·开放格(components) 写进去；看不见内部结构的别脑补层板。',
      '· 若连柜体数量都判断不清，把疑问写进 ambiguous（字符串数组），cabinets 可留空。',
    ].join('\n');
    const userText = typeof body.hint === 'string' && body.hint.trim()
      ? body.hint
      : '请识别这张柜体效果图，给出结构化 JSON。';
    try {
      // 安全前置 ③/④：输出预算过服务端硬顶闸（此前 body.maxTokens 原值透传，可被绕过）
      const mt = enforceMaxTokens(body, env.AI_MAX_TOKENS);
      if (!mt.ok) return rejectMaxTokens(res, actor, 'vision', mt);
      const payload = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: multiImages.length > 1
                  ? `${userText}\n（已附 ${multiImages.length} 张图：${multiImages.map((img, i) => `图${i + 1}[${img.mode === 'dimension' ? '尺寸图-优先提取精确尺寸标注' : '效果图-提取柜体分格与门抽外观'}]`).join('、')}；请将效果图外观结构与尺寸图标注数值融合为同一套柜体列表，精确尺寸以尺寸图标注为准，source 填 "annotation"，scale.known 填 true。）`
                  : userText,
              },
              ...(multiImages.length > 1
                ? multiImages.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } }))
                : [{ type: 'image_url', image_url: { url: primaryImage } }]),
            ],
          },
        ],
        temperature: 0.2,
        max_tokens: mt.value,
      };
      const r = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify(payload),
        },
        Number(env.AI_TIMEOUT_MS ?? 120000),
      );
      const text = await r.text();
      if (!r.ok) {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms: Date.now() - t0, note: `HTTP ${r.status}` });
        return json(res, 200, { ok: false, error: `HTTP ${r.status}：${text.slice(0, 400)}` });
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms: Date.now() - t0, note: 'bad_envelope' });
        return json(res, 200, { ok: false, error: '服务商返回的不是 JSON', raw: text.slice(0, 400), ms: Date.now() - t0 });
      }
      const content = String(data?.choices?.[0]?.message?.content ?? '');
      const usage = data?.usage ?? null;
      // 兼容模型把 JSON 包在 ```json ... ``` 里的情况
      const jsonStr = content.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();
      let parsed;
      try {
        parsed = JSON.parse(jsonStr || content);
      } catch {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms: Date.now() - t0, note: 'bad_vision_json' });
        return json(res, 200, { ok: false, error: '模型未返回可解析的 JSON', raw: content.slice(0, 400), model: data?.model ?? model, usage, ms: Date.now() - t0 });
      }
      if (!Array.isArray(parsed?.cabinets) || parsed.cabinets.length === 0) {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: true, ms: Date.now() - t0 });
        return json(res, 200, { ok: false, error: '模型未识别出任何柜体（cabinets 为空）', raw: content.slice(0, 400), model: data?.model ?? model, usage, ms: Date.now() - t0 });
      }
      if (gate.account) {
        auth.recordUsage(gate.account.id, {
          model: data?.model ?? model,
          promptTokens: Number(usage?.prompt_tokens ?? 0),
          completionTokens: Number(usage?.completion_tokens ?? 0),
          ok: true,
          ms: Date.now() - t0,
          generation: true,
        });
      }
      return json(res, 200, {
        ok: true,
        result: parsed,
        model: data?.model ?? model,
        usage,
        ms: Date.now() - t0,
        quota: gate.account ? quotaView(gate.account.plan, gate.account.usage) : undefined,
      });
    } catch (e) {
      const timedOut = e.name === 'AbortError';
      if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms: Date.now() - t0, note: e.name });
      return json(res, 200, {
        ok: false,
        ms: Date.now() - t0,
        error: timedOut ? `超时（超过 ${Number(env.AI_TIMEOUT_MS ?? 120000)}ms）` : e.message,
        note: timedOut ? '视觉识别模型单次可能要十几秒；若确实很慢，把 AI_TIMEOUT_MS 调大。' : '连不上这个地址。',
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
    // ① 额度（在**发起调用之前**判定，不是事后统计）。规划 = 一次"生成"
    if (gate.account) {
      const q = auth.checkQuota(gate.account.id, { generation: true });
      if (!q.ok) return json(res, 429, { ok: false, error: q.error, code: q.code, quota: q.view });
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
      // 安全前置 ③/④：输出预算过服务端硬顶闸（本端点过去忽略 body.maxTokens，
      // 但统一走同一道闸门，避免"某个端点漏装闸"的老毛病）
      const mt = enforceMaxTokens(body, env.AI_MAX_TOKENS);
      if (!mt.ok) return rejectMaxTokens(res, actor, 'plan', mt);
      const payload = buildChatRequest(model, text, body.snapshot, {
        history: Array.isArray(body.history) ? body.history : [],
        /**
         * 把管理后台确认过的纠正记忆念给模型（2026-10-21）。
         * 这是"说一次就够"的落点：用户在管理后台写一遍，
         * 之后每个请求都自动带上，不必在对话里反复强调。
         */
        projectRules: activeProjectRules(),
        temperature: Number(env.AI_TEMPERATURE ?? 0.1),
        // 关键点：规划请求必须尊重 .env 里的 AI_MAX_TOKENS。
        // 早先这里没传 maxTokens，buildChatRequest 永远落到 DEFAULT(4096)，
        // 导致推理模型把预算吃光在思考上、正文为空 —— "调到无限也不管用"的真凶。
        maxTokens: mt.value,
      });
      const r = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(payload) },
        Number(env.AI_TIMEOUT_MS ?? 120000)
      );
      const raw = await r.text();
      const ms = Date.now() - t0;
      if (!r.ok) {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms, note: `HTTP ${r.status}`, generation: true });
        return json(res, 200, { ok: false, error: `服务商返回 HTTP ${r.status}：${raw.slice(0, 400)}`, ms });
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms, note: 'bad_envelope', generation: true });
        return json(res, 200, { ok: false, error: '服务商返回的不是 JSON', raw: raw.slice(0, 400), ms });
      }
      const choice = data?.choices?.[0] ?? {};
      let content = choice?.message?.content ?? '';
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
          generation: true,
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
      /**
       * ── 正文为空：先试着从"思考过程"里把计划救出来，再谈报错 ──
       *
       * 推理模型（R1 一系）的典型形态：整个输出预算都花在 `reasoning_content` 上，
       * 一个字的 `content` 都没写就被截断（finish_reason=length）。
       * 而**计划往往已经写在思考里了**。
       *
       * 早先这里直接报错让用户"把 max_tokens 调大"，于是 4096→8192→65536 一路加，
       * 加到超时、加回 8192 还是空 —— 因为预算永远追不上模型的思考长度，
       * 调数字是治标，而且会引入超时。正确顺序是：
       *   ① 先从思考里抠 JSON（抠出来照样走 extractJson + validatePlan，不是"尽力理解"）
       *   ② 抠不出来再如实报错，并且**不再建议盲目调大预算**
       *
       * 救援出来的内容仍然要过完整的契约校验，不合法的照样被拒 —— 这与
       * "AI 输出是第一次进入系统的不受信任内容，边界必须在这儿拦"是一致的。
       */
      let salvagedFromReasoning = false;
      if (!String(content).trim() && reasoning.trim()) {
        const salv = extractJson(reasoning);
        if (salv.ok) {
          content = reasoning;
          salvagedFromReasoning = true;
          auth.audit({
            actor,
            action: 'ai.plan',
            result: 'salvaged',
            model: data?.model ?? model,
            note: 'empty_content_salvaged_from_reasoning',
          });
        }
      }

      if (!String(content).trim()) {
        const comp = usage?.completion_tokens;
        const reas = usage?.reasoning_tokens;
        const why =
          finish === 'length'
            ? `模型把 ${comp ?? '?'} 个输出 token 全花在思考上、一个字正文都没写出来${reas ? `（其中推理 ${reas}）` : ''}，并且思考里也没抠出可解析的计划。**不建议靠调大 AI_MAX_TOKENS 解决**：预算永远追不上模型的思考长度，调大了又会变成"调用超时"。最可靠的办法是**在管理后台换一个非推理模型**（或换一个不随机路由的服务商）；其次是把需求说得更短、减少需要推理的步骤。`
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
      /**
       * ── 设计意图请求（2026-10-20 新增）──
       *
       * ★ 这里是在修一个**真实的"静默丢弃"缺陷**：
       *   提示词从 P9.3 起就告诉模型"你可以额外输出 candidateRequest / plannerRequest"，
       *   但服务端只读 reply / actions / rejected —— 那两个请求**从来没被解析过**，
       *   模型认真写了，用户以为生效了，实际直接蒸发。这正是本文件铁律禁止的行为。
       *
       * 现在把 intentRequest 真的解析出来并校验形状：
       *   · 非法（带坐标 / 未知目标词 / 坏 scope）→ 进 intentRequestError，如实回报；
       *   · 合法 → 原样回给前端，由前端建 candidate 意图并弹确认（AI 无法自己激活）。
       */
      let intentRequest;
      let intentRequestError;
      if (extracted.value && typeof extracted.value === 'object' && extracted.value.intentRequest !== undefined) {
        const v = validateIntentRequest(extracted.value.intentRequest);
        if (v.ok) intentRequest = v.request;
        else intentRequestError = { code: v.code, error: v.error };
        auth.audit({
          actor,
          action: 'ai.plan.intent',
          result: v.ok ? 'accepted' : 'rejected',
          code: v.ok ? undefined : v.code,
        });
      }
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
        /** AI 提的设计意图（**待用户确认**，不会自动生效） */
        ...(intentRequest ? { intentRequest } : {}),
        ...(intentRequestError ? { intentRequestError } : {}),
        contractVersion: '1.0.0',
        /**
         * 这份计划是**从模型的思考过程里救出来的**（正文为空时的兜底）。
         * 必须如实告诉前端 —— 它是"模型边想边写下的草稿"，可信度低于正式正文，
         * 界面应当提示用户重点复核，而不是和普通结果一个待遇。
         */
        salvagedFromReasoning,
        model: data?.model ?? model,
        usage,
        ms,
        quota: gate.account ? quotaView(gate.account.plan, gate.account.usage) : undefined,
      });
    } catch (e) {
      const ms = Date.now() - t0;
      if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms, note: e.name, generation: true });
      return json(res, 200, { ok: false, error: e.name === 'AbortError' ? '调用超时' : `调用失败：${e.message}`, ms });
    }
  }

  /**
   * ── /api/ai/design：**需求 → 设计方案**（P3）──
   *
   * 与 /api/ai/plan 的关系（这是本阶段最重要的一条边界）：
   *   plan   = 动作级：照这句话去**改现有的模型**（动作直接指向已有柜体）；
   *   design = 需求级：照这句需求**设计一个新方案**（产出的柜体还不存在）。
   *
   * 这个接口**不编译命令、不碰模型、不产出几何** —— 与 plan 完全同一条纪律。
   * 方案回到前端后由 `compileProposal` 编译成动作，再走既有的
   * 干跑 → 预览 → 确认 → commitPlan。写入口始终只有一个（CommandBus）。
   *
   * ── 服务端能验什么、不能验什么 ──
   *   能验：**形状**（字段类型、必填、枚举形状）—— 契约是静态的，不需要项目数据；
   *   不能验：**语义**（房间存不存在、尺寸合不合理）—— 那需要项目与规则集，
   *   而服务端手上只有快照。所以语义校验在前端 `validateProposal` 做，
   *   这里是"AI 输出进入系统的第一道门"，不是最后一道。
   */
  if (pathname === '/api/ai/design' && req.method === 'POST') {
    const body = await readBody(req);
    if (gate.account) {
      const q = auth.checkQuota(gate.account.id, { generation: true });
      if (!q.ok) return json(res, 429, { ok: false, error: q.error, code: q.code, quota: q.view });
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
      // 安全前置 ③/④：输出预算过服务端硬顶闸（与其它三个端点同一道闸门）
      const mt = enforceMaxTokens(body, env.AI_MAX_TOKENS);
      if (!mt.ok) return rejectMaxTokens(res, actor, 'design', mt);
      const payload = buildDesignRequest(model, text, body.snapshot, {
        history: Array.isArray(body.history) ? body.history : [],
        // P6：前端算好的知识摘要（Resolver 是纯前端确定性函数，服务端只透传文本）
        knowledgeDigest: typeof body.knowledgeDigest === 'string' ? body.knowledgeDigest.slice(0, 4000) : '',
        /** 管理后台确认过的纠正记忆（与 /api/ai/plan 同一份来源） */
        projectRules: activeProjectRules(),
        temperature: Number(env.AI_TEMPERATURE ?? 0.2),
        maxTokens: mt.value,
      });
      const r = await fetchWithTimeout(
        `${baseUrl}/chat/completions`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(payload) },
        Number(env.AI_TIMEOUT_MS ?? 120000)
      );
      const raw = await r.text();
      const ms = Date.now() - t0;
      if (!r.ok) {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms, note: `HTTP ${r.status}`, generation: true });
        return json(res, 200, { ok: false, error: `服务商返回 HTTP ${r.status}：${raw.slice(0, 400)}`, ms });
      }
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms, note: 'bad_envelope', generation: true });
        return json(res, 200, { ok: false, error: '服务商返回的不是 JSON', raw: raw.slice(0, 400), ms });
      }
      const choice = data?.choices?.[0] ?? {};
      let content = choice?.message?.content ?? '';
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
          generation: true,
        });
      }

      /** 与 plan 同一套救援：推理模型常把预算吃在 reasoning_content 上 */
      let salvagedFromReasoning = false;
      if (!String(content).trim() && reasoning.trim()) {
        const salv = extractJson(reasoning);
        if (salv.ok) {
          content = reasoning;
          salvagedFromReasoning = true;
          auth.audit({ actor, action: 'ai.design', result: 'salvaged', model: data?.model ?? model, note: 'empty_content_salvaged_from_reasoning' });
        }
      }
      if (!String(content).trim()) {
        const comp = usage?.completion_tokens;
        const why =
          finish === 'length'
            ? `模型把 ${comp ?? '?'} 个输出 token 全花在思考上、一个字正文都没写出来，并且思考里也没抠出可解析的方案。**不建议靠调大 AI_MAX_TOKENS 解决**：调大了会变成"调用超时"。建议换一个非推理模型，或把需求说得更短。`
            : reasoning
              ? `模型只产出了"思考过程"（${reasoning.length} 字）而没有产出正文。`
              : '模型返回的正文是空的。';
        auth.audit({ actor, action: 'ai.design', result: 'empty', model: data?.model ?? model, note: finish === 'length' ? 'budget_exhausted' : 'empty_content' });
        return json(res, 200, { ok: false, error: why, raw: String(content).slice(0, 800), reasoning: reasoning.slice(0, 4000), finishReason: finish, model: data?.model ?? model, usage, ms });
      }

      const extracted = extractJson(content);
      if (!extracted.ok) {
        auth.audit({ actor, action: 'ai.design', result: 'unparsable', model, note: extracted.error });
        return json(res, 200, { ok: false, error: `${extracted.error}（原始回复已附在下面）`, raw: extracted.raw ?? String(content).slice(0, 800), reasoning: reasoning.slice(0, 4000), finishReason: finish, model: data?.model ?? model, usage, ms });
      }

      /**
       * 形状门：**拒了就整份退回**，不"尽力修补"。
       * 半份被修过的方案会被拿去预览，而预览出来的东西和用户说的不是一回事 ——
       * 那比"没拿到方案"更糟。
       */
      const bad = proposalShapeError(extracted.value);
      auth.audit({
        actor,
        action: 'ai.design',
        result: bad ? 'rejected' : salvagedFromReasoning ? 'salvaged' : 'ok',
        model: data?.model ?? model,
        note: bad ? `shape:${bad.slice(0, 80)}` : undefined,
      });
      if (bad) {
        return json(res, 200, {
          ok: false,
          error: `AI 给的方案形状不对，已整份退回：${bad}`,
          raw: JSON.stringify(extracted.value).slice(0, 800),
          reasoning: reasoning.slice(0, 4000),
          finishReason: finish,
          model: data?.model ?? model,
          usage,
          ms,
          quota: gate.account ? quotaView(gate.account.plan, gate.account.usage) : undefined,
        });
      }
      return json(res, 200, {
        ok: true,
        proposal: extracted.value,
        salvagedFromReasoning,
        model: data?.model ?? model,
        usage,
        ms,
        quota: gate.account ? quotaView(gate.account.plan, gate.account.usage) : undefined,
      });
    } catch (e) {
      const ms = Date.now() - t0;
      if (gate.account) auth.recordUsage(gate.account.id, { model, ok: false, ms, note: e.name, generation: true });
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
    // 安全前置 ②：整文件覆盖"纠错规则"，改动必须留痕（只记字节数与行数，不记内容）。
    auth.audit({
      actor: gate.account?.id ?? 'local-open',
      action: 'memory.write',
      result: 'ok',
      bytes: Buffer.byteLength(text),
      lines: text.split(/\r?\n/).filter((l) => l.trim()).length,
    });
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
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const confirmed = confirmExportSnapshot(body, ws.workspace);
    if (!confirmed.ok) return exportSnapshotConflict(res, confirmed);
    const { project, ...snapshot } = confirmed.snapshot;
    const which = Array.isArray(body.which) && body.which.length ? body.which.filter((x) => x === 'plan' || x === 'sheet') : ['plan', 'sheet'];
    if (which.length === 0) return json(res, 400, { ok: false, error: 'which 只能是 plan / sheet' });
    const planRoomIds = Array.isArray(body.planRoomIds) ? body.planRoomIds.filter((id) => typeof id === 'string') : undefined;
    const version = body.version === 'R2000' ? 'R2000' : 'R2007'; // R2000/GBK 只作兼容备用
    try {
      const sheetMode = ['room', 'cabinet', 'both'].includes(body.sheetMode) ? body.sheetMode : undefined;
      const { buffer, filename: base, info } = await exportDxf(project, { which, version, modelVersion: `v${snapshot.projectSnapshotVersion}`, planRoomIds, sheetMode });
      res.writeHead(200, {
        'Content-Type': 'application/dxf',
        ...exportSnapshotHeaders(snapshot),
        // 中文文件名必须走 RFC 5987，否则浏览器下载下来是乱码
        'Content-Disposition': `attachment; filename="export.dxf"; filename*=UTF-8''${encodeURIComponent(base)}`,
        'X-Export-Info': encodeURIComponent(JSON.stringify(info)),
      });
      res.end(buffer);
      return;
    } catch (e) {
      return exportFailure(res, 'DXF 导出失败：', e);
    }
  }

  /** 开料单（板件清单）。纯文本 CSV，Excel 直接能开 —— 加 BOM 否则中文乱码。 */
  if (pathname === '/api/export/cutlist' && req.method === 'POST') {
    const body = await readBody(req);
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const confirmed = confirmExportSnapshot(body, ws.workspace);
    if (!confirmed.ok) return exportSnapshotConflict(res, confirmed);
    const { project, ...snapshot } = confirmed.snapshot;
    try {
      const { csv, filename: base, stats } = await exportCutlist(project, { modelVersion: `v${snapshot.projectSnapshotVersion}` });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        ...exportSnapshotHeaders(snapshot),
        'Content-Disposition': `attachment; filename="cutlist.csv"; filename*=UTF-8''${encodeURIComponent(base)}`,
        'X-Export-Stats': encodeURIComponent(JSON.stringify(stats)),
      });
      res.end(csv);
      return;
    } catch (e) {
      return exportFailure(res, '开料单生成失败：', e);
    }
  }

  /** 按房间排序的图纸册（HTML 打印版）。浏览器打开后「打印 → 另存为 PDF」。 */
  if (pathname === '/api/export/roombook' && req.method === 'POST') {
    const body = await readBody(req);
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const confirmed = confirmExportSnapshot(body, ws.workspace);
    if (!confirmed.ok) return exportSnapshotConflict(res, confirmed);
    const { project, ...snapshot } = confirmed.snapshot;
    try {
      const sheetMode = ['room', 'cabinet', 'both'].includes(body.sheetMode) ? body.sheetMode : undefined;
      const { html, filename: base } = await exportRoombook(project, { modelVersion: `v${snapshot.projectSnapshotVersion}`, sheetMode });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...exportSnapshotHeaders(snapshot),
        'Content-Disposition': `attachment; filename="roombook.html"; filename*=UTF-8''${encodeURIComponent(base)}`,
      });
      res.end(html);
      return;
    } catch (e) {
      return exportFailure(res, '图纸册生成失败：', e);
    }
  }

  /** 真正的横向 PDF：由服务端固定 A3 纸幅/边距/字体渲染，不依赖用户打印设置。 */
  if (pathname === '/api/export/pdf' && req.method === 'POST') {
    const body = await readBody(req);
    const ws = await getWorkspaceState(gate.account?.id);
    if (!ws.ok) return workspaceUnavailable(res, ws);
    const confirmed = confirmExportSnapshot(body, ws.workspace);
    if (!confirmed.ok) return exportSnapshotConflict(res, confirmed);
    const { project, ...snapshot } = confirmed.snapshot;
    try {
      const layoutRoomIds = Array.isArray(body.layoutRoomIds) ? body.layoutRoomIds.filter((id) => typeof id === 'string') : [];
      const sheetMode = ['room', 'cabinet', 'both'].includes(body.sheetMode) ? body.sheetMode : undefined;
      const { pdf, pageCount, filename: base } = await exportPdf(project, { modelVersion: `v${snapshot.projectSnapshotVersion}`, layoutRoomIds, sheetMode });
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        ...exportSnapshotHeaders(snapshot),
        'Content-Length': String(pdf.length),
        'X-PDF-Page-Count': String(pageCount),
        'Content-Disposition': `attachment; filename="drawing.pdf"; filename*=UTF-8''${encodeURIComponent(base)}`,
        'Cache-Control': 'no-store',
      });
      res.end(pdf);
      return;
    } catch (e) {
      return exportFailure(res, 'PDF 图纸生成失败：', e);
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
  /**
   * 目录穿越防线：解析后的路径必须仍在 dist 内。
   *
   * 用 `DIST + sep` 而不是裸 `DIST` 做前缀 —— 后者是字符串前缀而非路径边界，
   * 若存在 `dist-backup` 这类同前缀兄弟目录，`/../dist-backup/x` 会通过。
   * 同时保留对 DIST 自身（index.html 情形）的放行。
   */
  const distRoot = resolve(DIST);
  const resolvedFile = resolve(file);
  if (resolvedFile !== distRoot && !resolvedFile.startsWith(distRoot + sep)) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }

  let target = join(distRoot, 'index.html');
  try {
    if (existsSync(resolvedFile) && statSync(resolvedFile).isFile()) target = resolvedFile;
  } catch {
    /* 前端产物在检查与读取之间被替换：走 SPA 兜底 */
  }
  if (!existsSync(target)) {
    return json(res, 404, { ok: false, error: '前端产物缺失（dist 不完整）' });
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' });
  /**
   * ★ 必须挂 'error'（2026-10-20 审计 P1-6）。
   *   existsSync 与 createReadStream 之间存在 TOCTOU：产物在两者之间被替换/删除时，
   *   没有 'error' 监听的流会抛 unhandled 'error' 事件，**整个 Node 进程直接退出**。
   *   （本进程也一直没有 uncaughtException 兜底，见文件末尾的进程级护栏。）
   */
  const stream = createReadStream(target);
  stream.on('error', () => {
    if (!res.headersSent) {
      try {
        json(res, 500, { ok: false, error: '静态文件读取失败' });
      } catch { /* 响应已结束 */ }
    } else {
      try { res.end(); } catch { /* 已结束 */ }
    }
  });
  stream.pipe(res);
}

// ───────────────────────────── 启动 ─────────────────────────────

const server = createServer((req, res) => {
  const pathname = (req.url ?? '/').split('?')[0];
  /**
   * `/mcp` 必须先于下面那道全局 OPTIONS 短路 —— 否则 MCP 客户端的预检会被
   * 通用的 `Access-Control-Allow-Headers: Content-Type` 答掉，而它需要的是
   * `Authorization` / `Mcp-Session-Id`。让 MCP 处理器自己回预检（见 mcp.mjs）。
   * 这不是新接口，只是把同一台服务上的另一个入口排在正确的位置。
   */
  if (pathname === '/mcp') {
    /**
     * 与 /api/* 同一条纪律：**不允许出现未处理的异步拒绝**。
     * 一个没人接的 rejected promise 在 Node 15+ 上会直接终结进程 ——
     * 而"审计写不进去 / 请求半途断开"这类事，恰恰最可能在 /mcp 里发生。
     */
    handleMcp(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { ok: false, error: String(e?.message ?? e) });
      else {
        try {
          res.end();
        } catch {
          /* 已结束 */
        }
      }
    });
    return;
  }
  if (req.method === 'OPTIONS') {
    // 预检也要过 Origin 闸：不允许的来源直接拒绝，而不是回 204 放行。
    if (!originAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, code: 'ORIGIN_FORBIDDEN', error: '这个来源的跨站请求不被允许' }));
    }
    cors(res, req);
    res.writeHead(204);
    return res.end();
  }
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch((e) => {
      if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
      else {
        console.error(`[api] handler failed after response: ${e?.message ?? e}`);
        try { res.end(); } catch { /* response already closed */ }
      }
    });
    return;
  }
  serveStatic(req, res, pathname);
});

/**
 * ── 进程级护栏（2026-10-20 审计 P1-6）──
 *
 * 之前全仓没有 `process.on('uncaughtException'|'unhandledRejection')`。
 * 后果：任何一处漏掉的异步拒绝或流错误（例如静态文件在 existsSync 与
 * createReadStream 之间被替换）都会让 **整个服务直接退出**，而且没有日志线索。
 *
 * 口径：
 *   · unhandledRejection / uncaughtException ⇒ **记日志 + 审计，但进程继续**；
 *     单次请求的失败不该变成全站宕机（本服务是多用户共用的）。
 *   · 只记录，不改写任何业务状态；真正的故障仍然通过 /api/health 的 dataWritable
 *     与审计日志暴露出来。
 *   · 连续崩太多次（进程级异常 20 次/分钟）才主动退出 —— 那种情况下继续跑
 *     只会不断产生半截写入，退出让编排层（docker restart）接管更安全。
 */
const CRASH_WINDOW_MS = 60_000;
const CRASH_MAX = 20;
const crashTimes = [];
function recordProcessFault(kind, err) {
  const now = Date.now();
  crashTimes.push(now);
  while (crashTimes.length > 0 && now - crashTimes[0] > CRASH_WINDOW_MS) crashTimes.shift();
  const detail = err?.stack ?? String(err ?? '');
  console.error(`[致命?] ${kind}: ${detail}`);
  try {
    auth.audit({ actor: null, action: 'process.fault', kind, error: String(err?.message ?? err).slice(0, 300) });
  } catch {
    /* 审计落不下盘不是新故障 */
  }
  if (crashTimes.length >= CRASH_MAX) {
    console.error(`[致命] 一分钟内 ${CRASH_MAX} 次进程级异常，主动退出交给编排层重启。`);
    process.exit(1);
  }
}
process.on('uncaughtException', (err) => recordProcessFault('uncaughtException', err));
process.on('unhandledRejection', (reason) => recordProcessFault('unhandledRejection', reason));

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
  console.log(`  工作区    ${WORKSPACE_PATH}（后台装载中，/mcp 取数前会等到装载结束）`);
  console.log(`  MCP       http://${HOST}:${PORT}/mcp  · ${ALLOWED_TOOLS.length} 个工具：${ALLOWED_TOOLS.join(' / ')}`);
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
  console.log('        GET|POST|DELETE /api/account/tokens  ·  POST /mcp（MCP 只读工具，P10.0 S2）');
  console.log('        GET|PUT /api/settings/smtp · POST /api/settings/smtp/test');
  if (process.env.APP_ENV_PATH || process.env.APP_MEM_PATH || process.env.APP_ACCOUNTS_PATH || process.env.APP_AUDIT_PATH) {
    console.log('  （本次运行使用了 APP_*_PATH 覆盖，未落在项目默认位置）');
  }
  // 工作区按账号懒加载：首次访问该账号时才打开，这里只说明模式。
  console.log('  ✓ 工作区按账号隔离（data/workspaces/{accountId}/），首次访问时懒加载');
  if (!IS_LOOPBACK) {
    console.log('');
    console.log('  ⚠⚠⚠ 正在监听非回环地址：接口已暴露到容器/网络。');
    console.log('  ⚠ 本服务没有 TLS —— 公网部署必须由反向代理终止 HTTPS（见 DEPLOY.md）。');
    console.log('  ⚠ 请确认已建立第一个账号（accounts 模式），否则全部接口免登录。');
  }
});
