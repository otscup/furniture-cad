#!/usr/bin/env node
/**
 * 远程 MCP 冒烟 —— P10.0 S2 的**部署验收**专用（真实容器 / 真实网络 HTTP）。
 *
 * 与 `verify:mcp` 的分工：
 *   · verify/mcp-acceptance.ts —— 回归防线，进程内起服务，进 verify:all，天天跑。
 *   · 本脚本 —— 部署时对着**已经跑起来的容器**打真实 HTTP，证明"发出去的那个镜像"
 *     真的在 8787 上提供了 /mcp，而不是只有源码树里能跑。
 *
 * 用法：
 *   node scripts/smoke-mcp-remote.mjs <baseUrl> readonly
 *       —— 生产容器口径：只断言健康位 + 未认证必须 401。**不写任何数据。**
 *   node scripts/smoke-mcp-remote.mjs <baseUrl> full
 *       —— 隔离容器口径：从零 bootstrap 一个 owner，走完
 *          会话 token / PAT / 权限矩阵 / 只读工具 / 撤销即时生效。
 *          会往目标容器写账号与 token，**只能对一次性容器使用**。
 *
 * 退出码：全部通过 = 0，否则 = 1。
 */

const BASE = (process.argv[2] ?? '').replace(/\/+$/, '');
const MODE = process.argv[3] ?? 'readonly';

if (!BASE) {
  console.error('用法: node scripts/smoke-mcp-remote.mjs <baseUrl> [readonly|full]');
  process.exit(2);
}

/** 期望的只读工具清单**硬编码**在这里：不 import 源码的 ALLOWED_TOOLS，否则同源必绿。 */
const EXPECTED_TOOLS = ['cad.get_state', 'cad.validate'];
/** 本阶段明确不开放的工具（写工具）。必须由服务器拒绝，而不是碰巧没写。 */
const FORBIDDEN_TOOLS = [
  'cad.create_room',
  'cad.draw_wall',
  'cad.place_cabinet',
  'cad.update_object',
  'cad.delete_object',
];

let pass = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(`${name}${detail ? `  <<< ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? `  <<< ${detail}` : ''}`);
  }
}
const section = (t) => console.log(`\n\u2500\u2500 ${t} \u2500\u2500`);

async function req(pathname, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    // 服务没了要变成"可判定的结果"，而不是把冒烟脚本自己带走。
    // 连 `cause` 一起报：只写 "fetch failed" 会把 ECONNREFUSED / ECONNRESET / 超时
    // 三种完全不同的原因压成同一句话 —— 曾经因此把"容器还没开始监听"误判成别的问题。
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { status: 0, json: null, text: `连接失败：${String(e?.message ?? e)}${cause ? ` (${cause})` : ''}` };
  }
}

async function mcp(body, { token, method = 'POST', raw } = {}) {
  const headers = { Accept: 'application/json, text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const sendBody = method !== 'GET' && method !== 'HEAD';
  if (sendBody) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(`${BASE}/mcp`, {
      method,
      headers,
      ...(sendBody ? { body: raw ?? JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? '';
    return { status: 0, json: null, text: `连接失败：${String(e?.message ?? e)}${cause ? ` (${cause})` : ''}` };
  }
}

const rpc = (id, method, params) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});
const toolPayload = (j) => {
  const t = j?.result?.content?.[0]?.text;
  if (typeof t !== 'string') return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};

console.log(`\n\u2550\u2550\u2550 远程 MCP 冒烟 ${BASE} · mode=${MODE} \u2550\u2550\u2550`);

// ── 就绪闸门 ─────────────────────────────────────────────────────────
// 容器 `docker run -d` 返回 ≠ 端口已经在监听。没有这道闸门，脚本会在容器开始
// 监听之前把上百个请求瞬间跑完（每次 ECONNREFUSED 是立即返回的，全程不到 1 秒），
// 于是"全是红"看起来像产品坏了 —— 实际上只是我起跑太早。
// 这里等到 /api/health 200 **且** 工作区后台装载结束才开始判定。
{
  const deadline = Date.now() + 60_000;
  let ready = false;
  let lastText = '';
  while (Date.now() < deadline) {
    const h = await req('/api/health');
    lastText = `status=${h.status} ${h.text.slice(0, 120)}`;
    if (h.status === 200 && h.json?.workspace?.loading === false) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  ok(
    '就绪闸门：服务已监听且工作区后台装载已结束（未在 60s 内就绪）',
    ready,
    ready ? '' : lastText
  );
  if (!ready) {
    console.log(`\n\u2550\u2550\u2550 远程 MCP 冒烟：通过 ${pass} 项，失败 ${failures.length} 项（服务未就绪，后续断言无意义） \u2550\u2550\u2550`);
    process.exit(1);
  }
}

// ══════════════════════════════════════════════════════════════════
// A. 健康位（两种模式都跑）：镜像里的服务真的把 /mcp 与工作区接上了
// ══════════════════════════════════════════════════════════════════
section('A. /api/health：MCP 与工作区已接线');
{
  const h = await req('/api/health');
  ok('A1 /api/health 200', h.status === 200, `status=${h.status}`);
  ok('A2 mcp.enabled=true', h.json?.mcp?.enabled === true, JSON.stringify(h.json?.mcp));
  ok('A2b mcp.path=/mcp', h.json?.mcp?.path === '/mcp', JSON.stringify(h.json?.mcp?.path));
  ok(
    'A2c mcp.transport=streamable-http',
    h.json?.mcp?.transport === 'streamable-http',
    JSON.stringify(h.json?.mcp?.transport)
  );
  ok(
    `A3 mcp.tools 恰好 = ${JSON.stringify(EXPECTED_TOOLS)}`,
    JSON.stringify(h.json?.mcp?.tools) === JSON.stringify(EXPECTED_TOOLS),
    JSON.stringify(h.json?.mcp?.tools)
  );
  ok('A4 workspace.ok=true（工作区已从卷里装载，没被静默重建）', h.json?.workspace?.ok === true, JSON.stringify(h.json?.workspace));
  ok('A4b workspace.loading=false（后台装载已结束）', h.json?.workspace?.loading === false, JSON.stringify(h.json?.workspace));
  ok(
    'A5 workspace.filePath 指向卷内（不许落在镜像里，重建容器 = 工作区消失）',
    /\/app\/data\//.test(String(h.json?.workspace?.filePath ?? '')),
    JSON.stringify(h.json?.workspace?.filePath)
  );
  ok('A6 dataWritable=true（账号/审计/工作区都落得下去）', h.json?.dataWritable === true, `dataWritable=${h.json?.dataWritable}`);
}

if (MODE === 'readonly') {
  // ════════════════════════════════════════════════════════════════
  // B. 生产口径：未认证必须被拒，且不写任何数据
  // ════════════════════════════════════════════════════════════════
  section('B. 生产口径：/mcp 未认证必须 401（不修改任何数据）');
  {
    const noTok = await mcp(rpc(1, 'tools/list', {}));
    ok(
      'B1 无 token 调 /mcp → 401（accounts 模式下不允许未认证请求）',
      noTok.status === 401,
      `status=${noTok.status} ${noTok.text.slice(0, 200)}`
    );
    ok(
      'B1b 拒绝码 -32001 UNAUTHORIZED（因对的原因被拒，不是恰好 401）',
      noTok.json?.error?.code === -32001,
      JSON.stringify(noTok.json)
    );

    const badTokCall = await mcp(rpc(2, 'tools/call', { name: 'cad.get_state', arguments: {} }), {
      token: 'definitely-not-a-valid-token',
    });
    ok('B2 错误 token 调工具 → 401（工具一次都没被执行）', badTokCall.status === 401, `status=${badTokCall.status}`);
    ok('B2b 401 响应里不含工具结果 (result undefined)', badTokCall.json?.result === undefined, JSON.stringify(badTokCall.json));
  }
}

if (MODE === 'full') {
  // ════════════════════════════════════════════════════════════════
  // C. local-open 阶段（还没有任何账号）
  // ════════════════════════════════════════════════════════════════
  section('C. local-open 阶段：口径与 /api/* 一致');
  let bootstrapTok = '';
  {
    const before = await mcp(rpc(1, 'tools/list', {}));
    ok(
      'C1 尚无账号时 /mcp 免登录（与既有 local-open 口径一致，不是 MCP 自己开的后门）',
      before.status === 200 && Array.isArray(before.json?.result?.tools),
      `status=${before.status} ${before.text.slice(0, 200)}`
    );

    const reg = await req('/api/auth/register', {
      method: 'POST',
      body: { username: 'smoke-owner', password: 'smoke-pass-1234', displayName: 'smoke owner' },
    });
    bootstrapTok = String(reg.json?.token ?? '');
    ok('C2 bootstrap 建第一个账号（owner）成功', reg.status === 200 && bootstrapTok.length > 10, `status=${reg.status} ${reg.text.slice(0, 200)}`);
    ok('C2b 第一个账号角色 = owner', reg.json?.account?.role === 'owner', JSON.stringify(reg.json?.account?.role));

    const afterReg = await mcp(rpc(2, 'tools/list', {}));
    ok('C3 【关键】建号之后同一条 /mcp 立刻要求认证（401）—— 免登录只属于"还没账号"那一刻', afterReg.status === 401, `status=${afterReg.status}`);
  }

  // ════════════════════════════════════════════════════════════════
  // D. 认证矩阵：会话 token / PAT / 无 token / 错 token
  // ════════════════════════════════════════════════════════════════
  section('D. 认证矩阵');
  let PAT_OWNER = '';
  let OWNER_ID = '';
  {
    const me = await req('/api/auth/me', { token: bootstrapTok });
    OWNER_ID = String(me.json?.account?.id ?? '');
    ok('D0 会话 token 可用（/api/auth/me 200）', me.status === 200 && Boolean(OWNER_ID), `status=${me.status}`);

    const noTok = await mcp(rpc(1, 'tools/list', {}));
    ok('D1 无 token → 401 且码 -32001', noTok.status === 401 && noTok.json?.error?.code === -32001, `status=${noTok.status} ${JSON.stringify(noTok.json?.error)}`);

    const viaSession = await mcp(rpc(2, 'tools/list', {}), { token: bootstrapTok });
    ok('D2 会话 token 可过 /mcp（tools/list 200）', viaSession.status === 200 && Array.isArray(viaSession.json?.result?.tools), `status=${viaSession.status}`);

    const made = await req('/api/account/tokens', {
      method: 'POST',
      token: bootstrapTok,
      body: { accountId: OWNER_ID, label: 'smoke-remote-pat' },
    });
    PAT_OWNER = String(made.json?.token ?? '');
    ok('D3 owner 造长期 token（PAT）成功', made.status === 200 && PAT_OWNER.length > 20, `status=${made.status} ${made.text.slice(0, 200)}`);
    ok('D3b 明文 token 只在创建响应里出现一次（响应里带说明）', typeof made.json?.note === 'string', '');

    const viaPat = await mcp(rpc(3, 'tools/list', {}), { token: PAT_OWNER });
    ok('D4 【关键】PAT 可过 /mcp（机器凭据走的是**同一个**鉴权入口）', viaPat.status === 200 && Array.isArray(viaPat.json?.result?.tools), `status=${viaPat.status} ${viaPat.text.slice(0, 200)}`);

    const list = await req(`/api/account/tokens?accountId=${encodeURIComponent(OWNER_ID)}`, { token: bootstrapTok });
    const tokDump = JSON.stringify(list.json ?? {});
    ok('D5 GET tokens 200 且列出这枚 token', list.status === 200 && (list.json?.tokens ?? []).length >= 1, `status=${list.status}`);
    ok('D5b 【安全】列表响应里没有哈希字段（hash/sha256 一律不出现）', !/hash|sha256/i.test(tokDump), tokDump.slice(0, 300));
    ok('D5c 【安全】列表响应里没有明文 token 本身', !tokDump.includes(PAT_OWNER), tokDump.slice(0, 300));
  }

  // ════════════════════════════════════════════════════════════════
  // E. 协议：initialize / tools/list / tools/call（真实 HTTP）
  // ════════════════════════════════════════════════════════════════
  section('E. 协议 + 只读工具（真实 HTTP）');
  {
    const init = await mcp(
      rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke-remote', version: '1' },
      }),
      { token: PAT_OWNER }
    );
    ok('E1 initialize → 200 且 serverInfo.name=furniture-cad', init.status === 200 && init.json?.result?.serverInfo?.name === 'furniture-cad', `status=${init.status} ${init.text.slice(0, 200)}`);
    ok('E1b 协商出 protocolVersion', typeof init.json?.result?.protocolVersion === 'string', JSON.stringify(init.json?.result?.protocolVersion));
    ok('E1c 声明 tools 能力', init.json?.result?.capabilities?.tools !== undefined, JSON.stringify(init.json?.result?.capabilities));

    const list = await mcp(rpc(2, 'tools/list', {}), { token: PAT_OWNER });
    const names = (list.json?.result?.tools ?? []).map((t) => t.name);
    ok('E2 tools/list → 200', list.status === 200, `status=${list.status}`);
    ok(`E3 工具清单恰好 = ${JSON.stringify(EXPECTED_TOOLS)}`, JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), JSON.stringify(names));
    ok(
      'E3b 每个工具都带 inputSchema（客户端可自检参数）',
      (list.json?.result?.tools ?? []).every((t) => t.inputSchema !== undefined),
      JSON.stringify((list.json?.result?.tools ?? []).map((t) => t.inputSchema))
    );
    for (const bad of FORBIDDEN_TOOLS) {
      ok(`E4 写工具 ${bad} 未被暴露`, !names.includes(bad), JSON.stringify(names));
    }

    // cad.get_state —— 带 arguments 与**完全不带 arguments** 两种都要能过
    const gs = await mcp(rpc(3, 'tools/call', { name: 'cad.get_state', arguments: {} }), { token: PAT_OWNER });
    const gsP = toolPayload(gs.json);
    ok('E5 cad.get_state 200 且 payload.ok=true', gs.status === 200 && gsP?.ok === true, `status=${gs.status} ${gs.text.slice(0, 240)}`);
    ok('E5b payload 透出 workspaceId', typeof gsP?.workspaceId === 'string' && gsP.workspaceId.length > 0, JSON.stringify(gsP?.workspaceId));
    ok('E5c payload 透出 liveModelVersion（数值）', typeof gsP?.liveModelVersion === 'number', JSON.stringify(gsP?.liveModelVersion));

    const gsNoArgs = await mcp(rpc(4, 'tools/call', { name: 'cad.get_state' }), { token: PAT_OWNER });
    ok('E5d 完全不带 arguments 也能调（零参工具缺省补齐空对象）', gsNoArgs.status === 200 && toolPayload(gsNoArgs.json)?.ok === true, `status=${gsNoArgs.status} ${gsNoArgs.text.slice(0, 240)}`);

    const vd = await mcp(rpc(5, 'tools/call', { name: 'cad.validate', arguments: {} }), { token: PAT_OWNER });
    const vdP = toolPayload(vd.json);
    ok('E6 cad.validate 200 且 payload.ok=true', vd.status === 200 && vdP?.ok === true, `status=${vd.status} ${vd.text.slice(0, 240)}`);
    ok('E6b payload 带 issues 数组', Array.isArray(vdP?.issues), JSON.stringify(vdP?.issues));
    ok('E6c payload 带 blockingErrors（数值）', typeof vdP?.blockingErrors === 'number', JSON.stringify(vdP?.blockingErrors));

    // 写工具即便被点名也必须拒绝。
    //
    // 判据必须落在 `result.isError === true` 上：MCP 规范里"工具存在但执行失败"和
    // "工具根本不认识"都是**调用结果**，包在 result.content 里，不会走 JSON-RPC 的 error 字段。
    // 我第一版按 `status>=400 || json.error` 判，结果真拒绝被读成了失败 —— 断言写错比失败更危险，
    // 这里改成与 verify/mcp-acceptance.ts ①6 完全一致的判据。
    const gsBefore = toolPayload((await mcp(rpc(60, 'tools/call', { name: 'cad.get_state', arguments: {} }), { token: PAT_OWNER })).json);
    const callWrite = await mcp(rpc(6, 'tools/call', { name: 'cad.create_room', arguments: { roomId: 'r1' } }), { token: PAT_OWNER });
    const wText = String(callWrite.json?.result?.content?.[0]?.text ?? '');
    ok(
      'E7 点名调用未注册的写工具 cad.create_room → 结构化失败 isError=true（不是"没实现就静默成功"）',
      callWrite.json?.result?.isError === true,
      `status=${callWrite.status} ${callWrite.text.slice(0, 240)}`
    );
    ok('E7b 失败信息指明该工具不存在（"被拒了"不等于"因对的原因被拒"）', /not found/i.test(wText), wText.slice(0, 200));
    ok('E7c 被拒时没有返回任何成功 payload', toolPayload(callWrite.json) === null, JSON.stringify(callWrite.json));
    const gsAfter = toolPayload((await mcp(rpc(61, 'tools/call', { name: 'cad.get_state', arguments: {} }), { token: PAT_OWNER })).json);
    ok(
      'E7d 这次被拒的写调用没有任何副作用（liveModelVersion 前后一致）',
      gsBefore?.liveModelVersion === gsAfter?.liveModelVersion && typeof gsBefore?.liveModelVersion === 'number',
      `${JSON.stringify(gsBefore?.liveModelVersion)} → ${JSON.stringify(gsAfter?.liveModelVersion)}`
    );

    const bad = await mcp(rpc(7, 'tools/list', {}), { token: PAT_OWNER, raw: '{ 这不是 JSON' });
    ok('E8 非法 JSON → 结构化错误（不是 500 崩掉）', bad.json?.error !== undefined && bad.status >= 400, `status=${bad.status} ${bad.text.slice(0, 200)}`);

    const pre = await fetch(`${BASE}/mcp`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://x', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,mcp-session-id' },
    }).catch(() => null);
    const allow = pre ? String(pre.headers.get('access-control-allow-headers') ?? '') : '';
    ok('E9 OPTIONS /mcp 预检放行 Authorization 与 Mcp-Session-Id（未被通用 CORS 短路）', pre?.status === 204 && /authorization/i.test(allow) && /mcp-session-id/i.test(allow), `status=${pre?.status} allow=${allow}`);
  }

  // ════════════════════════════════════════════════════════════════
  // F. 权限矩阵：token 不是提权通道
  // ════════════════════════════════════════════════════════════════
  section('F. 权限矩阵：viewer / designer 的 token 不越权');
  {
    const mkViewer = await req('/api/account/accounts', {
      method: 'POST',
      token: bootstrapTok,
      body: { username: 'smoke-viewer', password: 'smoke-view-1234', role: 'viewer' },
    });
    const VIEWER_ID = String(mkViewer.json?.account?.id ?? '');
    ok('F1 owner 建 viewer 账号成功', mkViewer.status === 200 && Boolean(VIEWER_ID), `status=${mkViewer.status} ${mkViewer.text.slice(0, 160)}`);

    const mkDes = await req('/api/account/accounts', {
      method: 'POST',
      token: bootstrapTok,
      body: { username: 'smoke-designer', password: 'smoke-des-1234', role: 'designer' },
    });
    const DES_ID = String(mkDes.json?.account?.id ?? '');
    ok('F1b owner 建 designer 账号成功', mkDes.status === 200 && Boolean(DES_ID), `status=${mkDes.status} ${mkDes.text.slice(0, 160)}`);

    const login = async (username, password) => {
      const r = await req('/api/auth/login', { method: 'POST', body: { username, password } });
      return { status: r.status, token: String(r.json?.token ?? '') };
    };
    const vLogin = await login('smoke-viewer', 'smoke-view-1234');
    const dLogin = await login('smoke-designer', 'smoke-des-1234');
    ok('F2 viewer / designer 登录成功', vLogin.status === 200 && dLogin.status === 200, `viewer=${vLogin.status} designer=${dLogin.status}`);

    // 会话 token 不能自己造 long token（造 token 是管理操作）
    const vSelf = await req('/api/account/tokens', { method: 'POST', token: vLogin.token, body: { accountId: VIEWER_ID, label: 'self' } });
    ok('F3 viewer 不能给自己造 token → 403 FORBIDDEN', vSelf.status === 403 && vSelf.json?.code === 'FORBIDDEN', `status=${vSelf.status} ${vSelf.text.slice(0, 160)}`);

    const dSelf = await req('/api/account/tokens', { method: 'POST', token: dLogin.token, body: { accountId: DES_ID, label: 'self' } });
    ok('F3b designer（有 canDesign、无 canManage）不能造 token → 403', dSelf.status === 403 && dSelf.json?.code === 'FORBIDDEN', `status=${dSelf.status} ${dSelf.text.slice(0, 160)}`);

    // owner 代造
    const vPatR = await req('/api/account/tokens', { method: 'POST', token: bootstrapTok, body: { accountId: VIEWER_ID, label: 'viewer-pat' } });
    const PAT_VIEWER = String(vPatR.json?.token ?? '');
    ok('F4 owner 为 viewer 代造 token 成功（token 不是新身份，仍绑 viewer 账号）', vPatR.status === 200 && PAT_VIEWER.length > 20, `status=${vPatR.status}`);

    const vCall = await mcp(rpc(1, 'tools/call', { name: 'cad.get_state', arguments: {} }), { token: PAT_VIEWER });
    ok('F5 viewer 的 PAT 可调只读工具（只读能力与既有 canView 一致，不额外收窄）', vCall.status === 200 && toolPayload(vCall.json)?.ok === true, `status=${vCall.status} ${vCall.text.slice(0, 200)}`);

    const vAcct = await req('/api/account/accounts', { token: PAT_VIEWER });
    ok('F6 【关键】viewer 的 PAT 访问管理接口 → 403（token 绝不提权）', vAcct.status === 403 && vAcct.json?.code === 'FORBIDDEN', `status=${vAcct.status} ${vAcct.text.slice(0, 160)}`);

    const vSec = await req('/api/security/policy', { token: PAT_VIEWER });
    ok('F6b viewer 的 PAT 进不了 /api/security/*', vSec.status === 403, `status=${vSec.status}`);

    // 撤销即时生效
    const alive = await mcp(rpc(2, 'tools/list', {}), { token: PAT_VIEWER });
    ok('F7 撤销前这枚 viewer PAT 本来是活的（否则后面的 401 没有意义）', alive.status === 200, `status=${alive.status}`);

    const tokList = await req(`/api/account/tokens?accountId=${encodeURIComponent(VIEWER_ID)}`, { token: bootstrapTok });
    const vTokId = String(tokList.json?.tokens?.[0]?.id ?? '');
    const rv = await req('/api/account/tokens', { method: 'DELETE', token: bootstrapTok, body: { accountId: VIEWER_ID, tokenId: vTokId } });
    ok('F8 撤销 viewer 的 token → removed=1', rv.status === 200 && rv.json?.removed === 1, JSON.stringify(rv.json));

    const dead = await mcp(rpc(3, 'tools/list', {}), { token: PAT_VIEWER });
    ok('F8b 【关键】撤销后**立即**失效（/mcp 401），不用等会话 TTL', dead.status === 401 && dead.json?.error?.code === -32001, `status=${dead.status} ${dead.text.slice(0, 160)}`);
  }
}

// ══════════════════════════════════════════════════════════════════
console.log(`\n\u2550\u2550\u2550 远程 MCP 冒烟：通过 ${pass} 项，失败 ${failures.length} 项 \u2550\u2550\u2550`);
if (failures.length) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  \u2717 ${f}`);
  process.exit(1);
}
process.exit(0);
