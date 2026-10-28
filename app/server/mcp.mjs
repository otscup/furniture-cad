/**
 * ══════════════════════════════════════════════════════════════════════
 *  MCP 基础层（P10.0 · S2）+ 写工具（S4/S5）—— Streamable HTTP `/mcp`，官方 TypeScript MCP SDK
 *
 *  ── 范围 ──
 *   MCP客户端 → Streamable HTTP /mcp → AuthStore/requireAuth → 真实 Workspace →
 *   只读工具（S2）+ 写工具（S4/S5，见 mcpWrite.mjs）。
 *   只读：`cad.get_state` / `cad.validate`。
 *   写（S4，designer+，只写 draft 不碰 live）：
 *     `cad.create_cabinet` / `cad.place_cabinet` / `cad.update_object` /
 *     `cad.delete_object` / `cad.submit_proposal` / `cad.list_drafts`。
 *   写（S5）：`cad.apply_draft`（admin+，乐观锁）/ `cad.discard_draft`（按归属）。
 *   故意不做：MCP 导出、OAuth、browser 自动化、实时推送。
 *
 *  ── 三条不变量 ──
 *   1. 同进程：挂在既有 8787 Node 服务的请求处理链上，**不新增服务进程**。
 *   2. 权限只有一条路：Bearer token → `AuthStore` → 账号 role。
 *      **不新增 MCP 专用角色/权限体系**；只读工具任何已认证角色皆可读
 *      （与既有 canView 一致）；写工具按 §11 权限矩阵收紧
 *      （写 draft=designer+，apply=admin+，discard 按归属）。
 *   3. 写工具**只写 draft**：取数/改数一律经 WorkspaceStore 的既有出口，
 *      绝不 `project.foo = ...`、绝不自建第二套模型或第二套 validator；
 *      唯一的 live 写入口是 `apply_draft` 的乐观锁提交。
 *
 *  ── token 安全 ──
 *   明文 token 从不出现在：审计、日志、错误响应、工具结果。审计只记
 *   actor / action / tool / result —— 不记 token、不记完整 project JSON。
 * ══════════════════════════════════════════════════════════════════════
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { registerWriteTools, WRITE_TOOLS } from './mcpWrite.mjs';
import { registerExportTools, EXPORT_TOOLS } from './mcpExport.mjs';
import { lintDrawing, drawingViews, renderView } from './exportCore.mjs';
import { findDuplicateUnitIds, WORKSPACE_UNIT_ID_CONFLICT } from '../src/core/unitIdentity.mjs';

/**
 * 两个工具都**没有输入参数**，但 `inputSchema` 不能就此省掉：
 *   · MCP 的 Tool 类型要求 inputSchema（省掉会得到一个不合规的工具描述）；
 *   · 而 SDK 的默认写法 `z.object({})` 会把"客户端没带 `arguments`"判成
 *     校验失败（`expected object, received undefined`），可是协议里
 *     `arguments` 是**可选**的 —— 只写 `client.callTool({name})` 的客户端
 *     会平白收到 -32602。`.default({})` 正好补上这一格：缺省即空对象，
 *     而"传了非法类型"仍然照旧结构化报错（不是把坏输入悄悄当空）。
 */
const NO_ARGS = z.object({}).default({});

export const TOOL_GET_STATE = 'cad.get_state';
export const TOOL_VALIDATE = 'cad.validate';
export const TOOL_LINT_DRAWING = 'cad.lint_drawing';
export const TOOL_GET_VIEWS = 'cad.get_views';
export const TOOL_RENDER = 'cad.render';

/** 允许暴露的 CAD 工具（只读 S2 + 写 S4/S5；新增必须走新一轮方案）。 */
export const ALLOWED_TOOLS = [TOOL_GET_STATE, TOOL_VALIDATE, TOOL_LINT_DRAWING, TOOL_GET_VIEWS, TOOL_RENDER, ...WRITE_TOOLS, ...EXPORT_TOOLS];

const SERVER_INFO = { name: 'furniture-cad', version: '0.1.0' };

/** 取 Bearer token。独立实现（不反向 import server.mjs），口径与 server.mjs 的 bearer() 一致。 */
function bearerOf(req) {
  const h = req.headers?.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(String(h));
  return m ? m[1].trim() : '';
}

function clientIp(req) {
  return req.socket?.remoteAddress ?? '';
}

/** 结构化 JSON-RPC 错误（HTTP 层）。不含任何 token / 内部堆栈。 */
function jsonRpcError(res, httpStatus, code, message) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code, message } }, null, 2);
  res.writeHead(httpStatus, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

async function readJsonBody(req, limit = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error(`请求体超过 ${Math.floor(limit / 1024 / 1024)}MB`);
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  return JSON.parse(raw); // 失败抛错 → 调用方回 -32700 Parse error
}

/**
 * 解析调用者身份。
 *  · local-open（还没有任何账号）：与既有 /api 完全一致 —— 不要求 token，actor='local-open'。
 *  · accounts：必须带有效 Bearer token。优先**长期 token/PAT**，其次登录会话 token；
 *    两条路径都落在同一个 AuthStore 上，身份最终都是**一个既有 account**（权限只由它的 role 决定）。
 */
export function resolvePrincipal(req, auth) {
  if (!auth.enabled) return { ok: true, account: null, actor: 'local-open', role: null, mode: 'local-open' };
  const token = bearerOf(req);
  const acc = auth.authenticateToken(token) ?? auth.authenticate(token);
  if (!acc) return { ok: false, mode: 'accounts' };
  return { ok: true, account: acc, actor: acc.id, role: acc.role, mode: 'accounts' };
}

/** 只读工具共用的取数：Workspace 不可用时如实回报（不假装成功、不重建）。 */
function workspaceOrError(workspaceState) {
  if (!workspaceState || workspaceState.ok !== true || !workspaceState.workspace) {
    const detail = workspaceState?.error ?? '未装载';
    return {
      error: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { ok: false, code: 'WORKSPACE_UNAVAILABLE', message: `服务端工作区不可用：${detail}`, filePath: workspaceState?.filePath ?? null },
              null,
              2
            ),
          },
        ],
        isError: true,
      },
    };
  }
  return { workspace: workspaceState.workspace };
}

function toolText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * 构建一次 MCP server 实例（stateless：每个 HTTP 请求一份，用完即弃，不携带跨请求会话状态）。
 * 工具处理器**闭包捕获**本次请求解析出的 principal，因此权限判定与调用者是同一份事实。
 */
function buildServer({ getWorkspaceState, principal, auditToolCall }) {
  const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });

  server.registerTool(
    TOOL_GET_STATE,
    {
      title: '读取当前工作区状态',
      description:
        '只读：返回服务端 Workspace 持有的语义模型（Semantic Model / projectFile 状态）与版本信息。不修改任何数据，也不重新定义模型 schema。',
      inputSchema: NO_ARGS,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const r = workspaceOrError(await getWorkspaceState(principal.actor));
      if (r.error) {
        auditToolCall(principal, TOOL_GET_STATE, 'fail', { code: 'WORKSPACE_UNAVAILABLE' });
        return r.error;
      }
      const ws = r.workspace;
      const project = ws.getProjectSnapshot();
      const payload = {
        ok: true,
        workspaceId: ws.workspaceId,
        owner: ws.owner,
        account: ws.account,
        /** Workspace 并发版本（draft 乐观锁依据） */
        liveModelVersion: ws.getLiveModelVersion(),
        /** 底层 CommandBus 的内部版本（每次提交 +1）；与上者是两层，都如实报出 */
        modelVersion: ws.getModelVersion(),
        updatedAt: ws.getUpdatedAt(),
        schemaVersion: project?.schemaVersion ?? null,
        ruleSetId: project?.ruleSetId ?? null,
        identityDiagnostics: ws.getUnitIdentityDiagnostics?.() ?? {
          readOnly: Boolean(ws.getUnitIdentityConflict?.()),
          code: ws.getUnitIdentityConflict?.() ? WORKSPACE_UNIT_ID_CONFLICT : null,
          message: ws.getUnitIdentityConflict?.() ?? null,
          duplicateUnitIds: findDuplicateUnitIds(project).map((item) => ({ ...item, scope: 'live project' })),
        },
        project,
      };
      auditToolCall(principal, TOOL_GET_STATE, 'ok', { workspaceId: ws.workspaceId, liveModelVersion: ws.getLiveModelVersion() });
      return toolText(payload);
    }
  );

  server.registerTool(
    TOOL_VALIDATE,
    {
      title: '校验当前工作区',
      description:
        '只读：对 live 或指定 draft 运行既有 CommandBus.derive（含柜体、装配、空间和碰撞校验），返回问题清单与派生汇总，不修改数据。',
      inputSchema: z.object({ draftId: z.string().optional() }).default({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const r = workspaceOrError(await getWorkspaceState(principal.actor));
      if (r.error) {
        auditToolCall(principal, TOOL_VALIDATE, 'fail', { code: 'WORKSPACE_UNAVAILABLE' });
        return r.error;
      }
      const ws = r.workspace;
      let v;
      if (args.draftId) {
        const handle = ws.getDraft(args.draftId);
        if (!handle) return toolError('DRAFT_NOT_FOUND', `draft 不存在：${args.draftId}`);
        if (principal.mode !== 'local-open' && handle.owner !== principal.actor) return toolError('FORBIDDEN', '只能校验自己创建的 draft');
        v = ws.validateDraft(args.draftId);
        if (!v) return toolError('DRAFT_NOT_FOUND', `draft 不存在：${args.draftId}`);
      } else {
        v = ws.validate();
      }
      const payload = {
        ok: true,
        workspaceId: ws.workspaceId,
        liveModelVersion: ws.getLiveModelVersion(),
        modelVersion: ws.getModelVersion(),
        identityDiagnostics: ws.getUnitIdentityDiagnostics?.() ?? {
          readOnly: Boolean(ws.getUnitIdentityConflict?.()),
          code: ws.getUnitIdentityConflict?.() ? WORKSPACE_UNIT_ID_CONFLICT : null,
          message: ws.getUnitIdentityConflict?.() ?? null,
          duplicateUnitIds: [],
        },
        /** ERROR 总数 —— 决定"能不能交付/导出"，与既有语义一致 */
        blockingErrors: v.blockingErrors,
        derived: v.derived,
        issues: v.issues.map((i) => ({
          code: i.code,
          severity: i.severity,
          message: i.message,
          target: i.target ?? null,
          ...(i.hint ? { hint: i.hint } : {}),
        })),
      };
      auditToolCall(principal, TOOL_VALIDATE, 'ok', {
        workspaceId: ws.workspaceId,
        blockingErrors: v.blockingErrors,
        issues: v.issues.length,
      });
      return toolText(payload);
    }
  );

  server.registerTool(
    TOOL_LINT_DRAWING,
    {
      title: '检查图纸可读性',
      description:
        '只读：把当前工作区的柜体重新派生一遍 2D 图元，检查**图纸印出来能不能读**（文字压在衣物/五金示意线条上、文字互相压字）。' +
        '与 cad.validate 分工不同：validate 回答"柜子做不做得出"，lint_drawing 回答"图纸清不清楚"。不修改任何数据。',
      inputSchema: NO_ARGS,
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const r = workspaceOrError(await getWorkspaceState(principal.actor));
      if (r.error) {
        auditToolCall(principal, TOOL_LINT_DRAWING, 'fail', { code: 'WORKSPACE_UNAVAILABLE' });
        return r.error;
      }
      const ws = r.workspace;
      try {
        const result = await lintDrawing(ws.getProjectSnapshot());
        auditToolCall(principal, TOOL_LINT_DRAWING, 'ok', {
          workspaceId: ws.workspaceId,
          liveModelVersion: ws.getLiveModelVersion(),
          issues: result.issues.length,
        });
        return toolText({
          ok: true,
          workspaceId: ws.workspaceId,
          liveModelVersion: ws.getLiveModelVersion(),
          ...result,
        });
      } catch (error) {
        auditToolCall(principal, TOOL_LINT_DRAWING, 'fail', { code: 'LINT_FAILED' });
        return toolError('LINT_FAILED', `图纸检查失败：${error?.message ?? error}`);
      }
    }
  );

  server.registerTool(
    TOOL_GET_VIEWS,
    {
      title: '读回图纸图元',
      description:
        '只读：把柜体的 2D 视图图元读回来。不带参数 → 列出每只柜有哪些视图、各多少图元；' +
        '带 view（front/top/side/internal）→ 返回该视图全部图元（折线/填充/文字，模型毫米坐标）。' +
        '这是 cad.create_cabinet 等写工具的**回读口**：画完先读一遍，别靠猜。不修改任何数据。',
      inputSchema: z.object({
        cabinetId: z.string().optional().describe('柜体 id；缺省取第一只'),
        view: z.enum(['front', 'top', 'side', 'internal']).optional().describe('视图；缺省列清单'),
        prims: z.boolean().optional().describe('true=返回图元（等价于给了 view）'),
      }).default({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const r = workspaceOrError(await getWorkspaceState(principal.actor));
      if (r.error) {
        auditToolCall(principal, TOOL_GET_VIEWS, 'fail', { code: 'WORKSPACE_UNAVAILABLE' });
        return r.error;
      }
      const ws = r.workspace;
      const wantPrims = Boolean(args.view || args.prims);
      try {
        const result = await drawingViews(ws.getProjectSnapshot(), {
          op: wantPrims ? 'prims' : 'list',
          ...(args.cabinetId ? { cabinetId: args.cabinetId } : {}),
          ...(args.view ? { view: args.view } : {}),
        });
        auditToolCall(principal, TOOL_GET_VIEWS, 'ok', { workspaceId: ws.workspaceId, prims: result.primCount ?? 0 });
        return toolText({ ok: true, workspaceId: ws.workspaceId, liveModelVersion: ws.getLiveModelVersion(), ...result });
      } catch (error) {
        auditToolCall(principal, TOOL_GET_VIEWS, 'fail', { code: 'VIEWS_FAILED' });
        return toolError('VIEWS_FAILED', `读回图元失败：${error?.message ?? error}`);
      }
    }
  );

  server.registerTool(
    TOOL_RENDER,
    {
      title: '把图纸渲成 PNG',
      description:
        '只读：把某个柜的某个 2D 视图渲染成 PNG 并**落盘**，返回文件路径（不返回 base64，避免把上下文吃干）。' +
        '这是唯一能"看见"效果图的通道 —— 几何对不对用 cad.lint_drawing / cad.validate 判断，好不好看只能用这个看。' +
        '需要服务端机器上有 Chrome/Edge（可用 FURNICAD_CHROME 指定路径）。不修改工作区数据，只在磁盘上写图。',
      inputSchema: z.object({
        cabinetId: z.string().optional().describe('柜体 id；缺省取第一只'),
        view: z.enum(['front', 'top', 'side', 'internal']).optional().describe('视图；缺省 front（立面外观图）'),
        widthPx: z.number().int().min(400).max(4000).optional().describe('图片像素宽；缺省 1600'),
      }).default({}),
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const r = workspaceOrError(await getWorkspaceState(principal.actor));
      if (r.error) {
        auditToolCall(principal, TOOL_RENDER, 'fail', { code: 'WORKSPACE_UNAVAILABLE' });
        return r.error;
      }
      const ws = r.workspace;
      try {
        const result = await renderView(ws.getProjectSnapshot(), {
          ...(args.cabinetId ? { cabinetId: args.cabinetId } : {}),
          ...(args.view ? { view: args.view } : {}),
          ...(args.widthPx ? { widthPx: args.widthPx } : {}),
        });
        auditToolCall(principal, TOOL_RENDER, 'ok', { workspaceId: ws.workspaceId, view: result.view, bytes: result.bytes });
        return toolText({ ok: true, workspaceId: ws.workspaceId, liveModelVersion: ws.getLiveModelVersion(), ...result });
      } catch (error) {
        auditToolCall(principal, TOOL_RENDER, 'fail', { code: 'RENDER_FAILED' });
        return toolError('RENDER_FAILED', `渲染失败：${error?.message ?? error}`);
      }
    }
  );

  // S4/S5 写工具（权限与 draft 纪律见 mcpWrite.mjs 文件头）。
  // auditToolCall 在这里绑定 principal：mcpWrite 侧只传 (tool, result, extra)。
  registerWriteTools(server, {
    getWorkspaceState,
    principal,
    auditToolCall: (tool, result, extra) => auditToolCall(principal, tool, result, extra),
  });

  // S6 导出工具（只读，复用 exportCore.mjs 三条链）。
  registerExportTools(server, {
    getWorkspaceState,
    principal,
    auditToolCall: (tool, result, extra) => auditToolCall(principal, tool, result, extra),
  });

  return server;
}

/**
 * 生成 `/mcp` 的请求处理器。
 * @param {object} opts
 * @param {object} opts.auth              AuthStore 实例
 * @param {() => Promise<object>} opts.getWorkspaceState
 *        取服务端工作区状态（`{ok:true, workspace}` 或 `{ok:false, error, filePath}`）。
 *        是个**函数**、且会 await 到装载结束 —— 服务为了不拖慢 /api/* 采用并行装载，
 *        所以这里必须能等到最终状态，而不是构造时抓一份可能还"在装载中"的快照。
 * @param {(entry: object) => void} [opts.audit] 审计写入（失败调用也要记）
 */
export function createMcpHandler({ auth, getWorkspaceState, audit = () => {} }) {
  /**
   * 审计写不进去（数据目录只读 / 磁盘满）不是新故障，**绝不能变成第二次失败**：
   * 它在 401 路径上被调用，一抛就会顺着 handleMcp 冒成未处理的拒绝 ⇒ 服务被杀。
   * 这里只负责"尽力记下"，落不下盘的事实由 /api/health 的 dataWritable 如实报出。
   */
  const safeAudit = (entry) => {
    try {
      audit(entry);
    } catch {
      /* 审计写入失败不改变 /mcp 响应；健康接口另报 dataWritable。 */
    }
  };

  const auditToolCall = (principal, tool, result, extra = {}) => {
    // 只记 actor / tool / result —— 绝不记 token、绝不记完整 project JSON
    safeAudit({
      actor: principal.actor,
      action: 'mcp.tool',
      tool,
      result,
      role: principal.role ?? null,
      ...extra,
    });
  };

  return async function handleMcp(req, res) {
    // CORS：MCP 客户端会带 Authorization 与 Mcp-Session-Id，预检必须放行它们
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }
    if (req.method !== 'POST') {
      return jsonRpcError(res, 405, -32000, `Method Not Allowed：/mcp 只接受 POST（stateless Streamable HTTP），收到 ${req.method}`);
    }

    const principal = resolvePrincipal(req, auth);
    if (!principal.ok) {
      safeAudit({ actor: null, action: 'mcp.auth', result: 'rejected', code: 'UNAUTHORIZED', ip: clientIp(req) });
      return jsonRpcError(res, 401, -32001, 'UNAUTHORIZED：/mcp 需要有效的 Bearer token（长期 token/PAT 或既有登录会话）');
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      safeAudit({ actor: principal.actor, action: 'mcp.request', result: 'bad_request', error: String(e?.message ?? e) });
      return jsonRpcError(res, 400, -32700, `Parse error：${e.message}`);
    }

    const server = buildServer({ getWorkspaceState, principal, auditToolCall });
    const transport = new StreamableHTTPServerTransport({
      // stateless：不生成会话 id、不保存跨请求状态（适合 API 型服务，也不制造额外会话）
      sessionIdGenerator: undefined,
      // 用普通 JSON 响应而不是 SSE 流：调用方拿到的就是一条 JSON-RPC 结果
      enableJsonResponse: true,
    });
    res.on('close', () => {
      try {
        transport.close();
      } catch {
        /* 已关闭 */
      }
      try {
        server.close();
      } catch {
        /* 已关闭 */
      }
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      safeAudit({ actor: principal.actor, action: 'mcp.request', result: 'error', error: String(e?.message ?? e) });
      if (!res.headersSent) {
        // 500 响应脱敏（Codex 验收§三⑤）：详情只进审计（上一行），不透传给客户端 ——
        // e.message 可能含内部路径/堆栈，固定文案 + audit 留痕才是正确姿势。
        jsonRpcError(res, 500, -32603, 'Internal error：服务端处理失败，详情见服务端审计日志');
      } else {
        try {
          res.end();
        } catch {
          /* 已结束 */
        }
      }
    }
  };
}
