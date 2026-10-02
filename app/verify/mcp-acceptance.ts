/**
 * ══════════════════════════════════════════════════════════════════════
 *  P10.0 · S2 专项验收（MCP 基础层 + 长期 Token/PAT）
 *
 *  ── 为什么全部走**真 HTTP** ──
 *   S2 的每一条要求都只活在 HTTP 层：MCP 的 JSON-RPC 协议流程、Bearer 认证、
 *   既有 requireAuth 的 manage 闸、以及"两个只读工具从**真实 Workspace** 读"。
 *   在函数级测（直接 new McpServer / 直调 handler）测不到其中任何一条：
 *   协议流程由 transport 决定，认证由请求头决定，权限由路由前缀决定。
 *   所以这里是 spawn 真实 server.mjs + 真 fetch，不 mock 任何一层。
 *
 *  ── 反假绿（本套件最容易写成恒真的几处，逐一钉死）──
 *   ① "tools/list 只含两个只读工具"：期望清单**硬编码在本文件里**，
 *      不 import 被测的 ALLOWED_TOOLS —— 否则把写工具加进源码，期望值跟着变，断言恒真。
 *      并且额外断言工具名不匹配任何写工具词根（create/draw/place/update/delete/…）。
 *   ② "只读"：不是"没看到写"，而是 (a) 调用前后工作区文件**逐字节相同**，
 *      (b) get_state 返回的 project 与本地独立解析出的模型**逐值相同**（证明读的是真工作区），
 *      (c) validate 的结果与本地独立跑既有 CommandBus 的派生**逐值相同**（证明没另立 validator）。
 *   ③ "token 不泄漏"：把同一枚明文 token 当成针，去**每一处**可能的泄漏面里搜
 *      （审计文件、审计接口、token 列表接口、健康检查、工具结果、错误响应、服务端日志）。
 *   ④ "撤销即时生效"：撤销前必须 200（证明这枚 token 本来是活的），撤销后才判 401。
 *
 *  变异版 verify/mcp-mutations.ts 会改坏本文件依赖的源码，要求本套件「跑完且判红」。
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthStore } from '../server/auth.mjs';
import { CommandBus } from '../src/core/commandBus.ts';
import { serializeProjectFile, parseProjectFile } from '../src/core/projectFile.ts';
import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
import type { Project, RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const RULES = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

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
/** 剥注释只扫代码（文件头常写"本层不做写操作"这类声明，扫它会造成误判） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// ───────────────────────── 规格（硬编码，不 import 被测源码） ─────────────────────────

/** S2+S4/S5 允许暴露的工具（方案 §六/§七）。**这是规格，不是从源码读来的。** */
const EXPECTED_TOOLS = [
  'cad.get_state',
  'cad.validate',
  'cad.create_cabinet',
  'cad.place_cabinet',
  'cad.update_object',
  'cad.delete_object',
  'cad.submit_proposal',
  'cad.list_drafts',
  'cad.apply_draft',
  'cad.discard_draft',
];
/** 明令禁止的工具词根：IR-3 未定（create_room/draw_wall）与 S6 未做（export_*）。 */
const FORBIDDEN_ROOTS = ['create_room', 'draw_wall', 'export_dxf', 'export_bom', 'export_cutlist', 'export_roombook'];

// ───────────────────────── 夹具 ─────────────────────────

const TMP = mkdtempSync(join(tmpdir(), 'furnicad-s2-'));
let nextPort = 8940;
const children: ChildProcess[] = [];
const logs: string[] = [];

interface Fixture {
  port: number;
  child: ChildProcess;
  dir: string;
  auditPath: string;
  accountsPath: string;
  wsPath: string;
}

/**
 * 起一个真实 server.mjs。
 * 顺序很重要：账号文件与工作区文件都**必须在 server 启动前**落盘（都只在启动时读一次）。
 */
async function startServer(opts: {
  envFile: string;
  accounts?: boolean;
  seedWorkspace?: boolean;
  extraEnv?: Record<string, string>;
}): Promise<Fixture> {
  const dir = mkdtempSync(join(TMP, 'srv-'));
  const accountsPath = join(dir, 'accounts.json');
  const auditPath = join(dir, 'audit.jsonl');
  const wsPath = join(dir, 'workspace.json');

  if (opts.accounts) {
    const a = new AuthStore({ accountsPath, auditPath });
    a.create({ username: 'owner', password: 'owner-pass-1234', actor: 'bootstrap' });
    a.create({ username: 'designer', password: 'des-pass-1234', role: 'designer', actor: 'owner' });
    a.create({ username: 'viewer', password: 'view-pass-1234', role: 'viewer', actor: 'owner' });
  }
  if (opts.seedWorkspace) writeWorkspaceFixture(wsPath);

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
      APP_WORKSPACE_PATH: wsPath,
      ...(opts.extraEnv ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  // server 自己的 stdout/stderr 也是"日志"的一部分 —— token 不得出现，所以要留档
  const idx = logs.length;
  logs.push('');
  child.stdout?.on('data', (d: Buffer) => (logs[idx] += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (logs[idx] += d.toString()));

  for (let i = 0; i < 150; i++) {
    await wait(100);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { port, child, dir, auditPath, accountsPath, wsPath };
    } catch {}
  }
  throw new Error(`server 未在预期时间内就绪（port=${port}）\n${logs[idx]}`);
}

/** 落一份**确定的**工作区文件（用应用自己的序列化器，不手搓信封）。 */
function writeWorkspaceFixture(path: string): Project {
  const project = buildProject();
  const env = JSON.parse(serializeProjectFile(project)) as Record<string, unknown>;
  env.workspaceId = 'ws_fixture_s2';
  env.owner = 'owner';
  env.account = 'owner';
  env.liveModelVersion = 3;
  env.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(env, null, 2), 'utf8');
  return project;
}

function buildProject(): Project {
  const p = emptyProject({ ruleSetId: 'factory_default_v1' });
  p.name = 'S2 只读夹具';
  p.rooms.push(rectRoom({ name: '厨房', x: 0, y: 0, w: 4000, h: 3000, id: 'room_1' }));
  p.cabinets.push(
    createCabinet({
      id: 'cab_1',
      name: '柜A',
      roomId: 'room_1',
      x: 100,
      y: 100,
      rules: RULES,
      params: { width: 800, height: 2000, depth: 600 },
    })
  );
  return p;
}

// ───────────────────────── HTTP 小工具 ─────────────────────────

function headers(token?: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function api(
  port: number,
  path: string,
  init: { method?: string; token?: string | null; body?: unknown } = {}
): Promise<{ status: number; json: any; text: string }> {
  /**
   * 连不上（服务被杀掉）必须返回一个**结构化结果**，不能抛。
   * 为什么：⑧ 段判的正是"进程还在不在" —— 一旦服务被未处理的拒绝带走，
   * fetch 会 ECONNREFUSED。若这里让它抛，验收脚本自己就崩了，于是
   * 汇总行永远不会出现，按本仓库的判据"崩溃 ≠ 判红"这条变异会被判为**没抓到**。
   * 把它变成 status=0 的普通结果，红的就是断言本身，因果才对得上。
   */
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? 'POST',
      headers: headers(init.token),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {}
    return { status: r.status, json: j, text };
  } catch (e) {
    return { status: 0, json: null, text: `连接失败（服务可能已退出）：${String((e as Error)?.message ?? e)}` };
  }
}

/** MCP 一次 JSON-RPC 往返（Streamable HTTP：POST + JSON 响应）。 */
async function mcp(
  port: number,
  body: unknown,
  opts: { token?: string | null; method?: string; raw?: string } = {}
): Promise<{ status: number; json: any; text: string; res: Response }> {
  const method = opts.method ?? 'POST';
  const sendBody = method !== 'GET' && method !== 'HEAD';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method,
      headers: headers(opts.token, { Accept: 'application/json, text/event-stream' }),
      ...(sendBody ? { body: opts.raw ?? JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {}
    return { status: res.status, json: j, text, res };
  } catch (e) {
    // 同上：服务没了要变成一个可被判定的结果，而不是把验收脚本一起带走
    const text = `连接失败（服务可能已退出）：${String((e as Error)?.message ?? e)}`;
    return { status: 0, json: null, text, res: { status: 0, headers: new Headers() } as unknown as Response };
  }
}

/** tools/call 的返回体在 result.content[0].text 里（是一段 JSON 字符串）。 */
function toolPayload(json: any): any {
  const t = json?.result?.content?.[0]?.text;
  if (typeof t !== 'string') return null;
  try {
    return JSON.parse(t);
  } catch {
    return { __unparsed: t };
  }
}

async function login(port: number, username: string, password: string): Promise<string> {
  const r = await api(port, '/api/auth/login', { body: { username, password } });
  return r.json?.token ?? '';
}

/**
 * 起一台服务（env 由调用方给全），返回是否起来、以及进程有没有**死掉**。
 * 返回值里带 exitCode/signalCode 是关键：⑧ 段要判的不是"请求失败"，
 * 而是"服务进程还在不在" —— 这两件事在 fetch 层面长得一样，必须分开看。
 */
async function startServerWithEnv(env: Record<string, string>): Promise<{ port: number; child: ChildProcess; up: boolean; log: string }> {
  const port = nextPort++;
  const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), APP_HOST: '127.0.0.1', APP_ENV_PATH: envFile, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const idx = logs.length;
  logs.push('');
  child.stdout?.on('data', (d: Buffer) => (logs[idx] += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (logs[idx] += d.toString()));
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await wait(100);
    try {
      up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {}
  }
  return { port, child, up, log: logs[idx] };
}
/**
 * 等 /api/health 报出工作区装载结束（`loading:false`）。
 * 为什么需要：服务**不等**工作区装载就 listen（否则一个与 /api 无关的后台任务会拖慢
 * 每一次启动，实测在负载高的机器上会顶破别的验收脚本给的启动预算）。
 * 所以验收要先确认"装载已收敛"，后续对 workspace.ok 的断言才有意义 ——
 * 否则可能只是恰好在中间态上取了一次快照。
 */
async function waitWorkspaceLoaded(port: number): Promise<{ loaded: boolean; health: any }> {
  for (let i = 0; i < 200; i++) {
    const h = await api(port, '/api/health', { method: 'GET' });
    if (h.json?.workspace && h.json.workspace.loading === false) return { loaded: true, health: h.json };
    await wait(50);
  }
  return { loaded: false, health: (await api(port, '/api/health', { method: 'GET' })).json };
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

const envFile = join(TMP, '.env');
writeFileSync(envFile, 'AI_API_KEY=\nAI_MODEL=\n', 'utf8');

// ═══════════════════════ ① 协议（local-open：无账号，与既有 /api 口径一致）═══════════════════════

section('① Protocol：initialize / tools/list / tools/call / 结构化错误（真 HTTP）');

const L = await startServer({ envFile, seedWorkspace: true });
console.log(`\n夹具 L（local-open）server :${L.port}  workspace=${L.wsPath}`);

{
  // 启动是"先 listen、后装载"：先证明 /api/* 不等它（这就是不 await 的意义），
  // 再证明装载确实会收敛（收敛之后对 workspace.ok 的断言才有意义）。
  const wsL = await waitWorkspaceLoaded(L.port);
  ok('①0 工作区装载会收敛（/api/health 的 workspace.loading 变成 false）', wsL.loaded && wsL.health?.workspace?.ok === true, JSON.stringify(wsL.health?.workspace));
  const init = await mcp(L.port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 's2-acceptance', version: '1' } },
  });
  ok('①1 initialize → HTTP 200 且返回 serverInfo.name=furniture-cad', init.status === 200 && init.json?.result?.serverInfo?.name === 'furniture-cad', `status=${init.status} ${init.text.slice(0, 200)}`);
  ok('①1b initialize 协商出 protocolVersion', typeof init.json?.result?.protocolVersion === 'string', JSON.stringify(init.json?.result?.protocolVersion));
  ok('①1c initialize 声明 tools 能力', init.json?.result?.capabilities?.tools !== undefined, JSON.stringify(init.json?.result?.capabilities));

  const list = await mcp(L.port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const names: string[] = (list.json?.result?.tools ?? []).map((t: any) => t.name);
  ok('①2 tools/list → 200', list.status === 200, `status=${list.status}`);
  ok(
    `①3 tools/list 恰好 = ${JSON.stringify(EXPECTED_TOOLS)}（规格硬编码在验收里，不读源码的 ALLOWED_TOOLS）`,
    JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS),
    JSON.stringify(names)
  );
  ok(
    '①3b 没有任何写/管理工具泄漏进来（词根黑名单）',
    names.every((n) => !FORBIDDEN_ROOTS.some((r) => n.includes(r))),
    JSON.stringify(names)
  );
  const tools = list.json?.result?.tools ?? [];
  const READ_TOOLS = ['cad.get_state', 'cad.validate', 'cad.list_drafts'];
  ok(
    '①3c 读工具声明 readOnlyHint=true、写工具声明 readOnlyHint=false（只读是**声明**出来的，不是口头的）',
    tools.filter((t: any) => READ_TOOLS.includes(t.name)).every((t: any) => t.annotations?.readOnlyHint === true) &&
      tools.filter((t: any) => !READ_TOOLS.includes(t.name)).every((t: any) => t.annotations?.readOnlyHint === false),
    JSON.stringify(tools.map((t: any) => [t.name, t.annotations]))
  );

  // get_state
  const gs = await mcp(L.port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cad.get_state', arguments: {} } });
  const gsP = toolPayload(gs.json);
  ok('①4 tools/call cad.get_state → 200 且 ok=true', gs.status === 200 && gsP?.ok === true, `status=${gs.status} ${gs.text.slice(0, 260)}`);
  ok('①4b get_state 报出 workspaceId（来自真实工作区文件）', gsP?.workspaceId === 'ws_fixture_s2', String(gsP?.workspaceId));
  ok('①4c get_state 报出持久化的 liveModelVersion=3', gsP?.liveModelVersion === 3, String(gsP?.liveModelVersion));
  ok('①4d get_state 带完整 project（含 room_1 / cab_1）', gsP?.project?.rooms?.some((r: any) => r.id === 'room_1') && gsP?.project?.cabinets?.some((c: any) => c.id === 'cab_1'), JSON.stringify({ rooms: gsP?.project?.rooms?.length, cabs: gsP?.project?.cabinets?.length }));

  // validate
  const vl = await mcp(L.port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cad.validate', arguments: {} } });
  const vlP = toolPayload(vl.json);
  ok('①5 tools/call cad.validate → 200 且 ok=true', vl.status === 200 && vlP?.ok === true, `status=${vl.status} ${vl.text.slice(0, 260)}`);
  ok('①5b validate 报出 blockingErrors 与 issues 数组', typeof vlP?.blockingErrors === 'number' && Array.isArray(vlP?.issues), JSON.stringify({ b: vlP?.blockingErrors, n: vlP?.issues?.length }));
  ok('①5c validate 报出派生汇总（panels/pieces/areaM2/weightKg）', ['panels', 'pieces', 'areaM2', 'weightKg'].every((k) => typeof vlP?.derived?.[k] === 'number'), JSON.stringify(vlP?.derived));

  // 非法工具 / 非法方法 / 非法参数 —— 都要结构化错误，不能 500 也不能静默成功
  const badTool = await mcp(L.port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'cad.delete_object', arguments: {} } });
  ok('①6 调不存在的（写）工具 → 结构化失败（isError=true）', badTool.json?.result?.isError === true, JSON.stringify(badTool.json).slice(0, 240));
  ok('①6b 错误信息点名了工具名（不含任何内部堆栈/路径）', String(badTool.json?.result?.content?.[0]?.text ?? '').includes('cad.delete_object'), JSON.stringify(badTool.json).slice(0, 240));

  const badMethod = await mcp(L.port, { jsonrpc: '2.0', id: 6, method: 'cad/does_not_exist', params: {} });
  ok('①7 未知方法 → JSON-RPC 错误 -32601 Method not found', badMethod.json?.error?.code === -32601, JSON.stringify(badMethod.json).slice(0, 240));

  const badArgs = await mcp(L.port, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'cad.get_state', arguments: 'not-an-object' } });
  ok(
    '①8 参数类型不合法（arguments 给了字符串）→ 结构化 JSON-RPC 错误（负错误码），不是 500、不是静默成功',
    badArgs.status === 200 && typeof badArgs.json?.error?.code === 'number' && badArgs.json.error.code < 0 && badArgs.json?.result === undefined,
    `status=${badArgs.status} code=${badArgs.json?.error?.code} ${badArgs.text.slice(0, 200)}`
  );
  ok('①8b 该错误里不含任何 token / 内部路径（SDK 的 zod 报文只描述期望类型）', !badArgs.text.includes('.mjs') && !badArgs.text.includes('E:\\'), badArgs.text.slice(0, 200));

  // 协议里 arguments 是**可选**的（只写 client.callTool({name}) 的客户端很常见），不能因此收到校验错
  const noArgs = await mcp(L.port, { jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'cad.get_state' } });
  ok('①8c 完全不带 arguments → 仍然只读成功（arguments 在协议里可选，工具 schema 以 default 补齐空对象）', toolPayload(noArgs.json)?.ok === true, JSON.stringify(noArgs.json).slice(0, 240));

  const extraArgs = await mcp(L.port, { jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'cad.get_state', arguments: { unexpected: 1 } } });
  ok('①8d 多余未知参数被忽略（不改变只读结果，也不被当成"成功写入"）', extraArgs.json?.result?.isError !== true && toolPayload(extraArgs.json)?.ok === true, JSON.stringify(extraArgs.json).slice(0, 200));
  ok('①8e 三条异常参数路径都没有 500（协议层始终结构化应答）', [badArgs, noArgs, extraArgs].every((r) => r.status === 200), JSON.stringify([badArgs.status, noArgs.status, extraArgs.status]));

  const badJson = await mcp(L.port, { jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }, { raw: '{ 这不是 JSON' });
  ok('①9 请求体不是合法 JSON → 400 + JSON-RPC -32700 Parse error', badJson.status === 400 && badJson.json?.error?.code === -32700, `status=${badJson.status} ${badJson.text.slice(0, 200)}`);

  const getMcp = await mcp(L.port, null, { method: 'GET' });
  ok('①10 GET /mcp → 405（stateless Streamable HTTP 只走 POST，且是结构化错误）', getMcp.status === 405 && getMcp.json?.error?.code === -32000, `status=${getMcp.status} ${getMcp.text.slice(0, 200)}`);

  // 浏览器型 MCP 客户端的预检必须放行 Authorization / Mcp-Session-Id
  const pre = await fetch(`http://127.0.0.1:${L.port}/mcp`, { method: 'OPTIONS' });
  const allow = String(pre.headers.get('access-control-allow-headers') ?? '');
  ok('①11 OPTIONS /mcp 预检放行 Authorization 与 Mcp-Session-Id（未被通用 CORS 短路）', pre.status === 204 && /authorization/i.test(allow) && /mcp-session-id/i.test(allow), `status=${pre.status} allow=${allow}`);
}

// ═══════════════════════ ② 只读（不用"没看到写"当证据）═══════════════════════

section('② Read-only：文件逐字节不变 + 与本地独立派生逐值一致 + 不绕过工作区');

{
  const before = readFileSync(L.wsPath, 'utf8');

  // 与本地独立计算比对：用**应用自己的**解析器 + CommandBus，不自己拼期望值
  const parsed = parseProjectFile(before);
  ok('②0 夹具工作区文件合法（本地解析成功）', parsed.ok === true, !parsed.ok ? parsed.error : '');
  const localBus = new CommandBus((parsed as { project: Project }).project, RULES);
  const localDerive = localBus.derive();
  const localSummary = localBus.derivedSummary();
  const localBlocking = localDerive.issues.filter((i) => i.severity === 'ERROR').length;

  // 反复只读调用（含非法调用）都不许改动工作区
  for (let i = 0; i < 3; i++) {
    await mcp(L.port, { jsonrpc: '2.0', id: 100 + i, method: 'tools/call', params: { name: 'cad.get_state', arguments: {} } });
    await mcp(L.port, { jsonrpc: '2.0', id: 200 + i, method: 'tools/call', params: { name: 'cad.validate', arguments: {} } });
    await mcp(L.port, { jsonrpc: '2.0', id: 300 + i, method: 'tools/call', params: { name: 'cad.delete_object', arguments: {} } });
  }
  const after = readFileSync(L.wsPath, 'utf8');
  ok('②1 【关键】6 次 tools/call（含 3 次非法写工具调用）之后工作区文件逐字节相同', before === after, `before=${before.length}B after=${after.length}B`);

  const gs = await mcp(L.port, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'cad.get_state', arguments: {} } });
  const gsP = toolPayload(gs.json);
  ok(
    '②2 get_state 的 project 与本地**独立**解析同一文件得到的模型逐值相同（读的是真工作区，不是自建模型）',
    JSON.stringify(gsP?.project) === JSON.stringify(localBus.getState()),
    `mcpLen=${JSON.stringify(gsP?.project).length} localLen=${JSON.stringify(localBus.getState()).length}`
  );
  ok(
    '②2b get_state 报出的柜体参数与夹具一致（width=800）',
    gsP?.project?.cabinets?.find((c: any) => c.id === 'cab_1')?.params?.width === 800,
    JSON.stringify(gsP?.project?.cabinets?.find((c: any) => c.id === 'cab_1')?.params?.width)
  );

  const vl = await mcp(L.port, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'cad.validate', arguments: {} } });
  const vlP = toolPayload(vl.json);
  ok(
    '②3 validate 的派生汇总与本地独立跑既有 CommandBus 的结果逐值相同（没有第二套 validator）',
    JSON.stringify(vlP?.derived) === JSON.stringify(localSummary),
    `mcp=${JSON.stringify(vlP?.derived)} local=${JSON.stringify(localSummary)}`
  );
  ok('②3b validate 的 blockingErrors 与本地独立计算相同', vlP?.blockingErrors === localBlocking, `mcp=${vlP?.blockingErrors} local=${localBlocking}`);
  ok('②3c validate 的 issues 条数与本地独立计算相同', vlP?.issues?.length === localDerive.issues.length, `mcp=${vlP?.issues?.length} local=${localDerive.issues.length}`);
  ok(
    '②3d validate 的 issues 逐条带 code/severity/message（不是空壳）',
    vlP?.issues?.every((i: any) => typeof i.code === 'string' && typeof i.severity === 'string' && typeof i.message === 'string'),
    JSON.stringify(vlP?.issues?.[0])
  );
  ok(
    '②4 只读调用不改 liveModelVersion / modelVersion（版本号是"有没有被改"的直接读数）',
    gsP?.liveModelVersion === 3 && gsP?.modelVersion === 0 && vlP?.liveModelVersion === 3,
    JSON.stringify({ live: gsP?.liveModelVersion, bus: gsP?.modelVersion, vlLive: vlP?.liveModelVersion })
  );
}

// ═══════════════════════ ③ 工作区不可用时不假装成功 ═══════════════════════

section('③ 工作区装载失败 ⇒ 结构化 WORKSPACE_UNAVAILABLE（**不静默重建**）');

{
  const badDir = mkdtempSync(join(TMP, 'badws-'));
  const badWs = join(badDir, 'workspace.json');
  writeFileSync(badWs, '{ 这不是合法项目文件', 'utf8');
  const badAccounts = join(badDir, 'accounts.json');
  const badAudit = join(badDir, 'audit.jsonl');
  const port = nextPort++;
  const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_ENV_PATH: envFile,
      APP_MEM_PATH: join(badDir, 'corrections.jsonl'),
      APP_ACCOUNTS_PATH: badAccounts,
      APP_AUDIT_PATH: badAudit,
      APP_WORKSPACE_PATH: badWs,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let up = false;
  for (let i = 0; i < 150 && !up; i++) {
    await wait(100);
    try {
      up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
    } catch {}
  }
  ok('③1 工作区文件损坏时服务**仍然启动**（工作区故障不拖垮 /api 与鉴权）', up, `port=${port}`);
  const wsBad = await waitWorkspaceLoaded(port);
  ok('③1b 装载失败也是"收敛"的（loading=false，不是永远挂在中间态）', wsBad.loaded === true, JSON.stringify(wsBad.health?.workspace));
  const h = await api(port, '/api/health', { method: 'GET' });
  ok('③2 /api/health 如实报 workspace.ok=false 与错误原因', h.json?.workspace?.ok === false && typeof h.json?.workspace?.error === 'string', JSON.stringify(h.json?.workspace));
  const gs = await mcp(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'cad.get_state', arguments: {} } });
  const p = toolPayload(gs.json);
  ok('③3 cad.get_state 返回 isError + code=WORKSPACE_UNAVAILABLE（不假装成功）', gs.json?.result?.isError === true && p?.code === 'WORKSPACE_UNAVAILABLE', JSON.stringify(gs.json).slice(0, 300));
  ok('③4 【关键】损坏的工作区文件**未被重建/覆盖**（静默重建等于换掉用户数据）', readFileSync(badWs, 'utf8') === '{ 这不是合法项目文件', readFileSync(badWs, 'utf8').slice(0, 60));
  const vl = await mcp(port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cad.validate', arguments: {} } });
  ok('③5 cad.validate 同样返回 WORKSPACE_UNAVAILABLE', toolPayload(vl.json)?.code === 'WORKSPACE_UNAVAILABLE', JSON.stringify(vl.json).slice(0, 300));
  child.kill();
}

// ═══════════════════════ ④ 认证 + 权限（accounts 模式）═══════════════════════

section('④ Auth：无 token / 错 token 被拒；PAT 与会话 token 都能用；权限仍由既有 ROLES 决定');

const A = await startServer({ envFile, accounts: true, seedWorkspace: true });
console.log(`\n夹具 A（accounts）server :${A.port}`);

const T_OWNER_SESSION = await login(A.port, 'owner', 'owner-pass-1234');
const T_DES_SESSION = await login(A.port, 'designer', 'des-pass-1234');
const T_VIEW_SESSION = await login(A.port, 'viewer', 'view-pass-1234');
ok('④0 夹具：三个角色的会话 token 都拿到了', [T_OWNER_SESSION, T_DES_SESSION, T_VIEW_SESSION].every((t) => t.length > 20));

/** 账号 id（owner 有权读账号列表） */
const accList = await api(A.port, '/api/account/accounts', { method: 'GET', token: T_OWNER_SESSION });
const accounts: any[] = accList.json?.accounts ?? accList.json?.data?.accounts ?? [];
const idOf = (u: string) => accounts.find((a: any) => a.username === u)?.id ?? '';
const OWNER_ID = idOf('owner');
const VIEWER_ID = idOf('viewer');
ok('④0b 夹具：owner / viewer 账号 id 可解析', Boolean(OWNER_ID) && Boolean(VIEWER_ID), JSON.stringify({ OWNER_ID, VIEWER_ID, n: accounts.length }));

// ── 无 token / 错 token ──
{
  const noTok = await mcp(A.port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  ok('④1 无 token 调 /mcp → 401（accounts 模式下不允许未认证请求）', noTok.status === 401, `status=${noTok.status} ${noTok.text.slice(0, 200)}`);
  ok('④1b 拒绝码是 -32001 UNAUTHORIZED（因对的原因被拒，不是恰好 401）', noTok.json?.error?.code === -32001, JSON.stringify(noTok.json));
  ok('④1c 被拒响应里出现的是"长期 token/PAT 或既有登录会话"的说明，不含任何 token', /Bearer/i.test(noTok.text) && !noTok.text.includes('Bearerundefined'), noTok.text.slice(0, 200));

  const badTok = await mcp(A.port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, { token: 'definitely-not-a-valid-token' });
  ok('④2 错误 token → 401 且码为 -32001', badTok.status === 401 && badTok.json?.error?.code === -32001, `status=${badTok.status}`);

  const badTokCall = await mcp(A.port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cad.get_state', arguments: {} } }, { token: 'wrong' });
  ok('④2b 未认证请求**不能调用 CAD 工具**（tools/call 同样 401，工具一次都没被执行）', badTokCall.status === 401 && badTokCall.json?.result === undefined, `status=${badTokCall.status} ${badTokCall.text.slice(0, 200)}`);

  const rej = auditLines(A.auditPath).filter((l) => l.action === 'mcp.auth' && l.result === 'rejected');
  ok('④2c 被拒的 /mcp 认证尝试进了审计（mcp.auth/rejected）', rej.length >= 2, `count=${rej.length}`);
}

// ── 创建 PAT（owner 才有权）──
let PAT_OWNER = '';
let PAT_VIEWER = '';
let PAT_DESIGNER = '';
let TOKEN_ID_OWNER = '';
{
  const made = await api(A.port, '/api/account/tokens', { token: T_OWNER_SESSION, body: { accountId: OWNER_ID, label: 's2-owner-pat' } });
  ok('④3 owner 创建长期 token → 200', made.status === 200 && typeof made.json?.token === 'string', `status=${made.status} ${made.text.slice(0, 200)}`);
  PAT_OWNER = made.json?.token ?? '';
  TOKEN_ID_OWNER = made.json?.tokenInfo?.id ?? '';
  ok('④3b 明文 token 是 32 字节高熵串（base64url 43 字符）', /^[A-Za-z0-9_-]{43}$/.test(PAT_OWNER), `len=${PAT_OWNER.length}`);
  ok('④3c 响应里带"只返回这一次"的提示与短 id', /只返回这一次/.test(String(made.json?.note ?? '')) && String(TOKEN_ID_OWNER).startsWith('pat_'), JSON.stringify(made.json?.tokenInfo));

  const madeV = await api(A.port, '/api/account/tokens', { token: T_OWNER_SESSION, body: { accountId: VIEWER_ID, label: 's2-viewer-pat' } });
  PAT_VIEWER = madeV.json?.token ?? '';
  ok('④3d owner 为 viewer 账号创建 token（token 不是新身份，仍绑定那个 viewer 账号）', madeV.status === 200 && PAT_VIEWER.length > 20, `status=${madeV.status}`);

  const madeD = await api(A.port, '/api/account/tokens', { token: T_OWNER_SESSION, body: { accountId: idOf('designer'), label: 's2-designer-pat' } });
  PAT_DESIGNER = madeD.json?.token ?? '';
  ok('④3e owner 为 designer 账号创建 token', madeD.status === 200 && PAT_DESIGNER.length > 20, `status=${madeD.status}`);
}

// ── 有效 PAT / 会话 token 都能过 /mcp ──
{
  const viaPat = await mcp(A.port, { jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }, { token: PAT_OWNER });
  ok('④4 长期 token 可通过 /mcp 认证（tools/list 200）', viaPat.status === 200 && Array.isArray(viaPat.json?.result?.tools), `status=${viaPat.status} ${viaPat.text.slice(0, 200)}`);
  const viaSession = await mcp(A.port, { jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }, { token: T_OWNER_SESSION });
  ok('④4b 既有登录会话 token 也能过（**没有**新增第二套身份体系）', viaSession.status === 200, `status=${viaSession.status}`);
  const callViaPat = await mcp(A.port, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'cad.get_state', arguments: {} } }, { token: PAT_OWNER });
  ok('④4c PAT 能真正调用只读工具并拿到真实工作区', callViaPat.status === 200 && toolPayload(callViaPat.json)?.workspaceId === 'ws_fixture_s2', `status=${callViaPat.status} ${callViaPat.text.slice(0, 200)}`);
}

// ── viewer / designer 权限与既有链一致 ──
{
  const vList = await mcp(A.port, { jsonrpc: '2.0', id: 20, method: 'tools/list', params: {} }, { token: PAT_VIEWER });
  ok('④5 viewer 的 PAT 可读工具清单（只读能力与既有 canView 一致）', vList.status === 200, `status=${vList.status}`);
  const vCall = await mcp(A.port, { jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'cad.validate', arguments: {} } }, { token: PAT_VIEWER });
  ok('④5b viewer 的 PAT 可调只读工具（本阶段两个工具都是只读，不额外收窄）', vCall.status === 200 && toolPayload(vCall.json)?.ok === true, `status=${vCall.status} ${vCall.text.slice(0, 200)}`);

  const vAccounts = await api(A.port, '/api/account/accounts', { method: 'GET', token: PAT_VIEWER });
  ok('④6 【关键】viewer 的 PAT 访问管理接口 → 403 FORBIDDEN（token 不是提权通道）', vAccounts.status === 403 && vAccounts.json?.code === 'FORBIDDEN', `status=${vAccounts.status} ${vAccounts.text.slice(0, 160)}`);
  const vCreate = await api(A.port, '/api/account/tokens', { token: PAT_VIEWER, body: { accountId: VIEWER_ID, label: 'self-made' } });
  ok('④6b viewer 的 PAT **不能**自己造长期 token（造 token 是管理操作）', vCreate.status === 403 && vCreate.json?.code === 'FORBIDDEN', `status=${vCreate.status} ${vCreate.text.slice(0, 160)}`);
  const vRevoke = await api(A.port, '/api/account/tokens', { method: 'DELETE', token: PAT_VIEWER, body: { accountId: OWNER_ID, tokenId: TOKEN_ID_OWNER } });
  ok('④6c viewer 的 PAT 不能撤销别人的 token', vRevoke.status === 403, `status=${vRevoke.status}`);

  const dCreate = await api(A.port, '/api/account/tokens', { token: PAT_DESIGNER, body: { accountId: idOf('designer'), label: 'x' } });
  ok('④7 designer（有 canDesign、无 canManage）不能造 token → 403', dCreate.status === 403 && dCreate.json?.code === 'FORBIDDEN', `status=${dCreate.status}`);

  const vSec = await api(A.port, '/api/security/policy', { method: 'GET', token: PAT_VIEWER });
  ok('④7b viewer 的 PAT 也进不了 /api/security/*（管理面整体一致）', vSec.status === 403, `status=${vSec.status}`);
}

// ── 撤销即时生效 + 并发创建不丢写 ──
{
  const alive = await mcp(A.port, { jsonrpc: '2.0', id: 30, method: 'tools/list', params: {} }, { token: PAT_VIEWER });
  ok('④8 撤销前：这枚 viewer PAT 本来是活的（先证明它有效，否则后面的 401 无意义）', alive.status === 200, `status=${alive.status}`);

  const rv = await api(A.port, '/api/account/tokens', { method: 'DELETE', token: T_OWNER_SESSION, body: { accountId: VIEWER_ID, tokenId: 'pat_does_not_exist' } });
  ok('④8b 撤销一个不存在的 id 不是错误，但要如实报 removed=0（不假装撤掉了）', rv.status === 200 && rv.json?.removed === 0, JSON.stringify(rv.json));

  // 短前缀拒绝（Codex 验收§三③）：传 `pat_`（4 字符）会命中该账号下所有 token。
  // 判据 = 400 + TOKEN_ID_TOO_SHORT，且此前有效的 PAT 必须还活着（没被误删）。
  const shortRv = await api(A.port, '/api/account/tokens', { method: 'DELETE', token: T_OWNER_SESSION, body: { accountId: VIEWER_ID, tokenId: 'pat_' } });
  ok('④8c 短前缀（<8 字符）撤销被 400 拒绝（TOKEN_ID_TOO_SHORT，不许一把全清）', shortRv.status === 400 && shortRv.json?.error === 'TOKEN_ID_TOO_SHORT', `status=${shortRv.status} ${shortRv.text.slice(0, 160)}`);
  const stillAlive = await mcp(A.port, { jsonrpc: '2.0', id: 32, method: 'tools/list', params: {} }, { token: PAT_VIEWER });
  ok('④8d 被拒的短前缀撤销没有任何副作用（那枚 PAT 还活着）', stillAlive.status === 200, `status=${stillAlive.status}`);

  const list = await api(A.port, `/api/account/tokens?accountId=${VIEWER_ID}`, { method: 'GET', token: T_OWNER_SESSION });
  const viewerTokId = list.json?.tokens?.[0]?.id ?? '';
  const rv2 = await api(A.port, '/api/account/tokens', { method: 'DELETE', token: T_OWNER_SESSION, body: { accountId: VIEWER_ID, tokenId: viewerTokId } });
  ok('④9 撤销 viewer 的 token → removed=1', rv2.status === 200 && rv2.json?.removed === 1, JSON.stringify(rv2.json));

  const dead = await mcp(A.port, { jsonrpc: '2.0', id: 31, method: 'tools/list', params: {} }, { token: PAT_VIEWER });
  ok('④9b 【关键】撤销后**立即**失效（/mcp 401），不需要等会话 TTL', dead.status === 401 && dead.json?.error?.code === -32001, `status=${dead.status} ${dead.text.slice(0, 160)}`);

  // 并发创建：写必须经 S1 串行队列 ⇒ 8 枚 token 一枚都不能丢
  const N = 8;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => api(A.port, '/api/account/tokens', { token: T_OWNER_SESSION, body: { accountId: OWNER_ID, label: `burst-${i}` } }))
  );
  ok(`④10 并发创建 ${N} 枚 token 全部 200`, results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));
  const after = await api(A.port, `/api/account/tokens?accountId=${OWNER_ID}`, { method: 'GET', token: T_OWNER_SESSION });
  const labels = (after.json?.tokens ?? []).map((t: any) => t.label);
  const present = Array.from({ length: N }, (_, i) => `burst-${i}`).filter((l) => labels.includes(l));
  ok(`④10b 并发写经 S1 串行队列、无丢写（${N} 枚全在）`, present.length === N, JSON.stringify(labels));
  const onDisk = JSON.parse(readFileSync(A.accountsPath, 'utf8'));
  const ownerTokens = onDisk.accounts.find((a: any) => a.id === OWNER_ID)?.tokens ?? [];
  ok(`④10c 账号库文件里也确实有 ${N} 枚 burst token（落盘不是只存在于内存）`, ownerTokens.filter((t: any) => String(t.label).startsWith('burst-')).length === N, String(ownerTokens.length));
}

// ═══════════════════════ ⑤ token 安全（每一处泄漏面都搜一遍）═══════════════════════

section('⑤ Token 安全：明文不出现在日志/审计/接口/工具结果/错误响应/配置回显');

{
  const NEEDLE = PAT_OWNER; // 仍然活着的那枚 owner PAT
  ok('⑤0 针是有效的（撤销已生效后仍能用它调工具）', (await mcp(A.port, { jsonrpc: '2.0', id: 40, method: 'tools/list', params: {} }, { token: NEEDLE })).status === 200);

  // 制造若干可能泄漏的路径
  const badCall = await mcp(A.port, { jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'cad.nope', arguments: {} } }, { token: NEEDLE });
  const badAuth = await mcp(A.port, { jsonrpc: '2.0', id: 42, method: 'tools/list', params: {} }, { token: 'invalid-token-xyz' });
  const health = await api(A.port, '/api/health', { method: 'GET', token: NEEDLE });
  const policy = await api(A.port, '/api/security/policy', { method: 'GET', token: NEEDLE });
  const auditApi = await api(A.port, '/api/security/audit', { method: 'GET', token: NEEDLE });
  const settings = await api(A.port, '/api/settings', { method: 'GET', token: NEEDLE });
  const tokenList = await api(A.port, `/api/account/tokens?accountId=${OWNER_ID}`, { method: 'GET', token: NEEDLE });
  const selfState = await mcp(A.port, { jsonrpc: '2.0', id: 43, method: 'tools/call', params: { name: 'cad.get_state', arguments: {} } }, { token: NEEDLE });

  const surfaces: [string, string][] = [
    ['工具调用结果（get_state）', selfState.text],
    ['工具调用结果（未知工具）', badCall.text],
    ['认证失败响应', badAuth.text],
    ['/api/health', health.text],
    ['/api/security/policy', policy.text],
    ['/api/security/audit', auditApi.text],
    ['/api/settings 回显', settings.text],
    ['token 列表接口', tokenList.text],
    ['审计文件 audit.jsonl', existsSync(A.auditPath) ? readFileSync(A.auditPath, 'utf8') : ''],
    ['账号库文件 accounts.json（应只存哈希）', readFileSync(A.accountsPath, 'utf8')],
    ['服务端 stdout/stderr 日志', logs.join('\n')],
  ];
  for (const [name, text] of surfaces) {
    ok(`⑤1 明文 token 不出现在「${name}」`, !text.includes(NEEDLE), `在 ${name} 里找到了明文 token`);
  }

  // 反过来：账号库里必须**存了哈希**，否则 ⑤1 可能只是因为"根本没落盘"
  const needleHash = sha256(NEEDLE);
  const disk = readFileSync(A.accountsPath, 'utf8');
  ok('⑤2 账号库里存的是 sha256(token)（证明落盘了，只是落的是哈希）', disk.includes(needleHash), `期望 hash=${needleHash.slice(0, 16)}…`);
  const onDisk = JSON.parse(disk);
  const ownerTokens = onDisk.accounts.find((a: any) => a.id === OWNER_ID)?.tokens ?? [];
  const rec = ownerTokens.find((t: any) => t.hash === needleHash);
  ok('⑤2b 该哈希落在 owner 账号的 tokens[].hash 上（PAT 存储边界＝既有账号库，没有第三套存储）', Boolean(rec) && rec.hash !== NEEDLE, JSON.stringify(rec));
  ok('⑤2c 记录里只有 id/label/createdAt/createdBy/hash（没有明文、没有额外密码学字段）', rec && ['id', 'label', 'createdAt', 'createdBy', 'hash'].every((k) => k in rec), JSON.stringify(Object.keys(rec ?? {})));

  // 审计：只记 actor/action/tool/result，不记 token、也不整份 dump 模型
  const lines = auditLines(A.auditPath);
  const toolLines = lines.filter((l) => l.action === 'mcp.tool');
  ok('⑤3 审计里有 mcp.tool 条目（工具调用留痕）', toolLines.length > 0, `count=${toolLines.length}`);
  ok('⑤3b mcp.tool 条目记了 actor / tool / result / role', toolLines.every((l) => 'actor' in l && 'tool' in l && 'result' in l), JSON.stringify(toolLines.at(-1)));
  ok('⑤3c 审计里的 tool 名都是允许清单里的（无计划外工具）', toolLines.every((l) => EXPECTED_TOOLS.includes(l.tool)), JSON.stringify([...new Set(toolLines.map((l) => l.tool))]));
  ok('⑤3d 审计条目不含完整 model dump（没有把 project/cabinets 写进审计）', !/cabinets/.test(JSON.stringify(lines)), '审计里出现了 cabinets');
  ok('⑤3e 审计条目里的 tokenId 是短 id（pat_xxx），不是 token 本身', lines.filter((l) => l.action === 'account.createToken').every((l) => /^pat_[0-9a-f]+$/.test(String(l.tokenId))), JSON.stringify(lines.filter((l) => l.action === 'account.createToken').map((l) => l.tokenId)));

  // 安全自述里应已把 PAT 从"缺口"里移走
  const impl = policy.json?.implemented ?? [];
  ok('⑤4 /api/security/policy 把 PAT（长期 token）列为**已实现**', JSON.stringify(impl).includes('长期') || JSON.stringify(impl).includes('PAT'), JSON.stringify(impl).slice(0, 300));
}

// ═══════════════════════ ⑥ 回归：既有 /api/* 行为未变 ═══════════════════════

section('⑥ Regression：/api/* 行为未被 /mcp 改动');

{
  await waitWorkspaceLoaded(A.port);
  const h = await api(A.port, '/api/health', { method: 'GET' });
  ok('⑥1 /api/health 仍免鉴权 200（白名单没动）', h.status === 200 && h.json?.ok === true, `status=${h.status}`);
  ok('⑥1b /api/health 新增 mcp 自述且工具清单=10 个工具', JSON.stringify(h.json?.mcp?.tools) === JSON.stringify(EXPECTED_TOOLS) && h.json?.mcp?.path === '/mcp', JSON.stringify(h.json?.mcp));
  ok('⑥1c /api/health 报 workspace.ok=true（真实工作区已装载）且 loading=false', h.json?.workspace?.ok === true && h.json?.workspace?.loading === false && h.json?.workspace?.workspaceId === 'ws_fixture_s2', JSON.stringify(h.json?.workspace));

  const mode = await api(A.port, '/api/auth/mode', { method: 'GET' });
  ok('⑥2 /api/auth/mode 仍免鉴权且报 accounts 模式', mode.status === 200 && mode.json?.mode === 'accounts', `status=${mode.status} ${mode.text.slice(0, 120)}`);

  const noAuthAccounts = await api(A.port, '/api/account/accounts', { method: 'GET' });
  ok('⑥3 无 token 访问 /api/account/accounts → 401 且码 UNAUTHORIZED（既有闸未被放宽）', noAuthAccounts.status === 401 && noAuthAccounts.json?.code === 'UNAUTHORIZED', `status=${noAuthAccounts.status} ${noAuthAccounts.text.slice(0, 160)}`);
  ok('⑥3b /api/account/accounts 仍返回 accounts 数组（未破坏既有形状）', (await api(A.port, '/api/account/accounts', { method: 'GET', token: T_OWNER_SESSION })).json?.accounts?.length === 3, '');

  const notFound = await api(A.port, '/api/nope', { method: 'GET', token: T_OWNER_SESSION });
  ok('⑥4 未知 /api 路径仍是 404 且形状不变', notFound.status === 404 && notFound.json?.ok === false, `status=${notFound.status}`);
  const notFoundNoAuth = await api(A.port, '/api/nope', { method: 'GET' });
  ok('⑥4b 未登录访问未知 /api 路径仍是 401（鉴权在路由匹配之前）', notFoundNoAuth.status === 401, `status=${notFoundNoAuth.status}`);

  const viewerMe = await api(A.port, '/api/auth/me', { method: 'GET', token: T_VIEW_SESSION });
  ok('⑥5 既有会话鉴权未被 MCP 改动（/api/auth/me 200）', viewerMe.status === 200, `status=${viewerMe.status}`);
}

// ═══════════════════════ ⑧ 数据目录 / 审计不可用：服务必须活着 ═══════════════════════

section('⑧ 数据目录或审计不可用时，服务与 /mcp 都必须活着（这一格真的把服务打死过）');

/**
 * ── 为什么专门有这一段 ──
 * S2 第一版把工作区装载接进启动链后，admin-acceptance 的"只读数据目录"场景下
 * **服务进程凭空消失**（/api/health 直接 ECONNREFUSED）。因果链是：
 *   数据目录不可写 → 工作区 save 失败 → 进 `.catch()` → 里面调 `auth.audit()`
 *   → **audit 自己也要写盘，于是它也抛** → 抛在 `.catch()` 回调里 ⇒
 *   promise 变成 rejected 且无人接 ⇒ Node 把"未处理的 promise 拒绝"当致命错误
 *   ⇒ 整个进程被杀。
 * 这条链的教训不是"补个 try"，而是：**"记不下来"绝不能升级成"服务没了"**。
 * 所以这里把两种不可写都真造出来，并且判据落在「进程还在不在」上 ——
 * 只看 fetch 有没有报错是不够的（请求被拒与进程消失长得一样）。
 *
 * 造法：路径某一层是**文件**（ENOTDIR），在任何系统上都确定性复现，
 * 不像 chmod 那样在 Windows 上验的是空气。
 */
{
  const blockedRoot = mkdtempSync(join(TMP, 'blocked-'));
  const blocker = join(blockedRoot, 'not-a-dir');
  writeFileSync(blocker, 'I am a file', 'utf8');
  const notADir = join(blocker, 'sub');

  // ── ⑧A 数据目录整个不可用（账号库/审计/记忆/工作区都在它下面）──
  const A8 = await startServerWithEnv({
    APP_ACCOUNTS_PATH: join(notADir, 'accounts.json'),
    APP_AUDIT_PATH: join(notADir, 'audit.jsonl'),
    APP_MEM_PATH: join(notADir, 'corrections.jsonl'),
  });
  const liveA = () => {
    try {
      return A8.child.exitCode === null && A8.child.signalCode === null;
    } catch {
      return false;
    }
  };
  ok('⑧A1 数据目录整条路径不可写时，服务**仍然起得来**（进程没有因未处理的拒绝而自杀）', A8.up === true && liveA(), `up=${A8.up} exit=${A8.child.exitCode} signal=${A8.child.signalCode}\n${A8.log.slice(-400)}`);
  const hA = await api(A8.port, '/api/health', { method: 'GET' }).catch(() => ({ status: 0, json: null as any, text: '' }));
  ok('⑧A2 /api/health 如实报 dataWritable=false（不许假装一切正常）', hA.json?.dataWritable === false, JSON.stringify(hA.json)?.slice(0, 200));
  const wsA = await waitWorkspaceLoaded(A8.port);
  ok('⑧A3 工作区装载失败也是收敛的（loading=false + 有错误原因），不是永远挂在中间态', wsA.loaded === true && wsA.health?.workspace?.ok === false && typeof wsA.health?.workspace?.error === 'string', JSON.stringify(wsA.health?.workspace));
  const listA = await mcp(A8.port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  ok('⑧A4 工作区坏了不影响 /mcp 协议本身（tools/list 仍 200）', listA.status === 200 && Array.isArray(listA.json?.result?.tools), `status=${listA.status}`);
  const gsA = await mcp(A8.port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cad.get_state', arguments: {} } });
  ok('⑧A5 cad.get_state 如实回报 WORKSPACE_UNAVAILABLE（不是 500、不是崩溃）', gsA.status === 200 && toolPayload(gsA.json)?.code === 'WORKSPACE_UNAVAILABLE', `status=${gsA.status} ${gsA.text.slice(0, 200)}`);
  ok('⑧A6 走完上面这一串之后，服务仍然活着（进程未退出）', liveA() && (await api(A8.port, '/api/health', { method: 'GET' })).status === 200, `exit=${A8.child.exitCode} signal=${A8.child.signalCode}`);
  A8.child.kill();

  // ── ⑧B 账号库可写、**审计**不可写（比 ⑧A 更刁：账号体系能工作，只有留痕写不下去）──
  const dirB = mkdtempSync(join(TMP, 'audit-broken-'));
  const accountsB = join(dirB, 'accounts.json');
  const store = new AuthStore({ accountsPath: accountsB, auditPath: join(dirB, 'audit.jsonl') });
  store.create({ username: 'owner', password: 'owner-pass-1234', actor: 'bootstrap' });
  const ownerB = store.data.accounts[0].id;
  const patB = store.createToken(ownerB, { label: 'audit-broken-pat' }).token ?? '';

  const B8 = await startServerWithEnv({
    APP_ACCOUNTS_PATH: accountsB,
    APP_AUDIT_PATH: join(notADir, 'audit.jsonl'),
    APP_MEM_PATH: join(dirB, 'corrections.jsonl'),
    APP_WORKSPACE_PATH: join(dirB, 'workspace.json'),
  });
  const liveB = () => B8.child.exitCode === null && B8.child.signalCode === null;
  ok('⑧B1 审计不可写时服务照常启动（审计不是启动的必要条件）', B8.up === true && liveB(), `up=${B8.up} exit=${B8.child.exitCode}\n${B8.log.slice(-300)}`);
  await waitWorkspaceLoaded(B8.port);
  const badTokB = await mcp(B8.port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { token: 'not-a-real-token' });
  ok('⑧B2 审计写不下去时，认证失败仍是 401（"记不下来"没有升级成 500 或崩溃）', badTokB.status === 401 && badTokB.json?.error?.code === -32001, `status=${badTokB.status} ${badTokB.text.slice(0, 160)}`);
  ok('⑧B2b 该次 401 之后服务仍活着（未处理的拒绝会在这里把进程带走）', liveB() && (await api(B8.port, '/api/health', { method: 'GET' })).status === 200, `exit=${B8.child.exitCode} signal=${B8.child.signalCode}`);
  const toolB = await mcp(B8.port, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cad.get_state', arguments: {} } }, { token: patB });
  ok('⑧B3 工具调用在审计不可写时仍能取到真实工作区（ok:true）', toolB.status === 200 && toolPayload(toolB.json)?.ok === true, `status=${toolB.status} ${toolB.text.slice(0, 200)}`);
  ok('⑧B4 全程结束服务仍然活着', liveB() && (await api(B8.port, '/api/health', { method: 'GET' })).status === 200, `exit=${B8.child.exitCode}`);
  B8.child.kill();
}

// ═══════════════════════ ⑦ 源码纪律（结构不变量）═══════════════════════

section('⑦ 源码纪律：同进程挂载、官方 SDK、一处鉴权、工具层无写路径');

{
  const mcpSrc = stripComments(readFileSync(join(root, 'server', 'mcp.mjs'), 'utf8'));
  const srvSrc = stripComments(readFileSync(join(root, 'server', 'server.mjs'), 'utf8'));
  const hostSrc = stripComments(readFileSync(join(root, 'server', 'workspaceHost.mjs'), 'utf8'));

  ok('⑦1 /mcp 用官方 MCP SDK（不是手写协议）', /@modelcontextprotocol\/sdk\/server\/mcp\.js/.test(mcpSrc) && /@modelcontextprotocol\/sdk\/server\/streamableHttp\.js/.test(mcpSrc), 'mcp.mjs 未引用官方 SDK');
  ok('⑦1b 采用 stateless（sessionIdGenerator: undefined）+ JSON 响应，不制造额外会话状态', /sessionIdGenerator:\s*undefined/.test(mcpSrc) && /enableJsonResponse:\s*true/.test(mcpSrc), '');
  ok('⑦2 /mcp 只在 server.mjs 挂载一处（同进程、非第二服务）', (srvSrc.match(/pathname === '\/mcp'/g) ?? []).length === 1, `count=${(srvSrc.match(/pathname === '\/mcp'/g) ?? []).length}`);
  ok('⑦2b /mcp 未被加进免鉴权白名单 PUBLIC_API', !/PUBLIC_API\s*=\s*new Set\(\[[^\]]*\/mcp/.test(srvSrc), 'PUBLIC_API 里出现了 /mcp');

  // 工具层不得出现任何写路径
  ok('⑦3 传输层（mcp.mjs）不直接碰 draft/执行入口（写工具住在 mcpWrite.mjs）', !/\.(execute|draftExecute|applyDraft|createDraft|discardDraft)\(/.test(mcpSrc), 'mcp.mjs 里出现了执行入口');
  ok('⑦3b 工具层不直接操作文件系统（不自己落盘）', !/from 'node:fs'|require\('node:fs'\)/.test(mcpSrc), 'mcp.mjs 引入了 node:fs');
  ok('⑦3c 工具层不直接改 project 字段（无 obj.field = 赋值）', !/\b(project|payload|state)\.\w+\s*=[^=]/.test(mcpSrc), 'mcp.mjs 里出现了字段赋值');

  // 取数只经 Workspace 的只读出口
  ok('⑦4 get_state 用 WorkspaceStore.getProjectSnapshot（深拷贝，不递出内部引用）', /getProjectSnapshot\(\)/.test(mcpSrc), '');
  ok('⑦4b validate 用 WorkspaceStore.validate（内部走既有 CommandBus.derive）', /\.validate\(\)/.test(mcpSrc), '');
  ok('⑦4c 工作区装载只在 workspaceHost 一处（不散落在 mcp/server 里各装一份）', /WorkspaceStore\.load|WorkspaceStore\.create/.test(hostSrc) && !/WorkspaceStore\.(load|create)/.test(mcpSrc), '');

  // 身份与权限只有一条路
  ok('⑦5 mcp.mjs 的身份解析复用 AuthStore（authenticateToken / authenticate），不自建账号体系', /auth\.authenticateToken\(/.test(mcpSrc) && /auth\.authenticate\(/.test(mcpSrc), '');
  ok('⑦5b token 校验实现只在 auth.mjs 一处（mcp/server 不自己算哈希比对）', !/createHash|timingSafeEqual|sha256\(/.test(mcpSrc), 'mcp.mjs 里出现了自己的哈希校验');
  ok('⑦5c server.mjs 的 token 路由落在 /api/account/ 前缀下（自动继承既有 canManage 闸）', /'\/api\/account\/tokens'/.test(srvSrc), '');
}

// ───────────────────────── 收尾 ─────────────────────────

for (const c of children) {
  try {
    c.kill();
  } catch {}
}
try {
  rmSync(TMP, { recursive: true, force: true });
} catch {}

console.log(`\n══════════════════════════════════════════════════════`);
console.log(`  P10.0 S2 验收：通过 ${pass} / 失败 ${fail}`);
if (fail > 0) {
  console.log(`失败项：\n  · ${failures.join('\n  · ')}`);
  process.exit(1);
}
console.log('全部通过：MCP 协议、PAT 认证与权限链、只读保证、token 安全、/api 回归均满足。');
