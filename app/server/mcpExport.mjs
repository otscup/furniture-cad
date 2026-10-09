/**
 * MCP S6 导出工具（P10.0-S6）。
 *
 * 三个只读工具，复用 `exportCore.mjs` 的三条导出链（与 HTTP `/api/export/*`
 * 逐字节同一套逻辑），区别只在交付方式：HTTP 流式下载，MCP 返回 base64 JSON。
 *
 *   cad.export_dxf      : DXF 生产图纸（plan/sheet，可选 R2000/R2007）
 *   cad.export_bom_csv  : 开料单 CSV（板件清单 + 甲购件）
 *   cad.export_roombook : 图纸册 HTML（打印另存为 PDF）
 *
 * 权限：只读，viewer+ 可调（§11 矩阵：读操作不设 designer 门槛）。
 * 数据源：live 工作区（服务端真相源，不接受客户端传 project —— 避免
 * "我导的和我看的不是同一份"的幽灵问题）。
 * 审计：只记元数据（文件名/大小），不记文件内容。
 */
import { z } from 'zod';
import { exportDxf, exportCutlist, exportRoombook, exportPdf } from './exportCore.mjs';
import { ROLES } from './auth.mjs';

export const TOOL_EXPORT_DXF = 'cad.export_dxf';
export const TOOL_EXPORT_BOM_CSV = 'cad.export_bom_csv';
export const TOOL_EXPORT_ROOMBOOK = 'cad.export_roombook';
export const TOOL_EXPORT_PDF = 'cad.export_pdf';

/** S6 导出的全部工具（接 ALLOWED_TOOLS / WRITE_TOOLS 之后）。 */
export const EXPORT_TOOLS = [TOOL_EXPORT_DXF, TOOL_EXPORT_BOM_CSV, TOOL_EXPORT_ROOMBOOK, TOOL_EXPORT_PDF];

/**
 * @param server  McpServer
 * @param ctx  { principal, getWorkspaceState, auditToolCall }
 *   auditToolCall 已在 mcp.mjs 绑定 principal，这里只传 (tool, result, extra)。
 */
export function registerExportTools(server, ctx) {
  const { principal, getWorkspaceState, auditToolCall } = ctx;

  // ── 本地 helpers（与 mcpWrite.mjs 同纪律，不依赖 mcp.mjs 传） ──
  function toolText(payload) {
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }
  function toolError(code, message, extra = {}) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, code, message, ...extra }, null, 2) }],
      isError: true,
    };
  }
  function exportToolError(prefix, error) {
    const blocked = error?.code === 'EXPORT_BLOCKED';
    const identityConflict = error?.code === 'WORKSPACE_UNIT_ID_CONFLICT';
    return toolError(
      blocked ? 'EXPORT_BLOCKED' : identityConflict ? 'WORKSPACE_UNIT_ID_CONFLICT' : 'EXPORT_FAILED',
      `${prefix}${error?.message ?? error}`,
      blocked ? { blockingErrors: error.issues.length, issues: error.issues } : {}
    );
  }
  /** 权限判定（§11 权限矩阵，与 mcpWrite.mjs 一致：只读 ROLES 表）。 */
  function requirePerm(principal, need) {
    if (principal.mode === 'local-open') return null;
    const r = ROLES[principal.role];
    const ok = need === 'view' ? r?.canView === true : false;
    if (!ok) {
      return toolError('FORBIDDEN', `权限不足：查看权限 required，当前角色 ${principal.role ?? '未知'}`);
    }
    return null;
  }
  function workspaceOrError(workspaceState) {
    if (!workspaceState || workspaceState.ok !== true || !workspaceState.workspace) {
      const detail = workspaceState?.error ?? '未装载';
      return { error: toolError(workspaceState?.code ?? 'WORKSPACE_UNAVAILABLE', `服务端工作区不可用：${detail}`) };
    }
    return { workspace: workspaceState.workspace };
  }

  /** viewer+ 即可（只读）。返回 null 表示通过，返回响应表示拒绝。 */
  const needRead = () => requirePerm(principal, 'view');

  /** 取 live project 快照（服务端真相源；structuredClone 拷贝，不会成为写旁路）。 */
  const liveProject = async () => {
    const r = workspaceOrError(await getWorkspaceState(principal.actor));
    if (r.error) return { error: r.error };
    const ws = r.workspace;
    const project = ws.getProjectSnapshot?.();
    if (!project) return { error: toolError('WORKSPACE_UNAVAILABLE', 'live 工作区不可用') };
    return { project, ws };
  };

  const fileResult = (filename, mimeType, buffer) => ({
    ok: true,
    filename,
    mimeType,
    size: buffer.length,
    base64: buffer.toString('base64'),
  });
  const scopedProject = (project, roomId) => {
    if (!roomId) return project;
    const room = project.rooms.find((item) => item.id === roomId);
    if (!room) return null;
    const cabinets = project.cabinets.filter((cabinet) => cabinet.roomId === roomId);
    const cabinetIds = new Set(cabinets.map((cabinet) => cabinet.id));
    const sharedPanels = Array.isArray(project.sharedPanels)
      ? project.sharedPanels.filter((panel) => !Array.isArray(panel?.memberCabinetIds) || panel.memberCabinetIds.every((id) => cabinetIds.has(id)))
      : project.sharedPanels;
    return { ...project, rooms: [room], cabinets, assemblies: (project.assemblies ?? []).filter((assembly) => assembly.roomId === roomId), sharedPanels };
  };

  // ── cad.export_dxf ──────────────────────────────────────────────
  server.registerTool(
    TOOL_EXPORT_DXF,
    {
      title: '导出 DXF 生产图纸',
      description:
        '从 live 工作区导出 DXF（复用 /api/export/dxf 全链：emit-neutral → export_dxf.py）。' +
        '返回 base64 文件内容，可直接存盘。只读，不碰 draft/live。',
      inputSchema: z.object({
        which: z.array(z.enum(['plan', 'sheet'])).optional().describe('plan=平面图, sheet=板件图；缺省都要'),
        planRoomIds: z.array(z.string()).optional().describe('PLAN 只导出这些房间 ID；缺省导出全部房间'),
        roomId: z.string().optional().describe('限定导出该房间的布局与柜体图纸'),
        version: z.enum(['R2007', 'R2000']).optional().describe('DXF 版本；缺省 R2007'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const deny = needRead();
      if (deny) return deny;
      const lp = await liveProject();
      if (lp.error) return lp.error;
      const project = scopedProject(lp.project, args.roomId);
      if (!project) return toolError('ROOM_NOT_FOUND', `找不到房间：${args.roomId}`);
      try {
        const { buffer, filename, info } = await exportDxf(project, {
          which: args.which?.length ? args.which : ['plan', 'sheet'],
          planRoomIds: args.roomId ? [args.roomId] : args.planRoomIds,
          version: args.version ?? 'R2007',
          modelVersion: lp.ws.getLiveModelVersion?.(),
        });
        auditToolCall(TOOL_EXPORT_DXF, 'ok', { filename, size: buffer.length });
        return toolText({ ...fileResult(filename, 'application/dxf', buffer), info });
      } catch (e) {
        auditToolCall(TOOL_EXPORT_DXF, 'fail', { error: e?.message ?? String(e) });
        return exportToolError('DXF 导出失败：', e);
      }
    }
  );

  // ── cad.export_bom_csv ──────────────────────────────────────────
  server.registerTool(
    TOOL_EXPORT_BOM_CSV,
    {
      title: '导出开料单 CSV',
      description:
        '从 live 工作区导出开料单（复用 /api/export/cutlist 全链）。' +
        '返回 base64 文件内容（UTF-8 BOM，Excel 直接开）。只读，不碰 draft/live。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const deny = needRead();
      if (deny) return deny;
      const lp = await liveProject();
      if (lp.error) return lp.error;
      try {
        const { csv, filename, stats } = await exportCutlist(lp.project, {
          modelVersion: lp.ws.getLiveModelVersion?.(),
        });
        const buffer = Buffer.from(csv, 'utf8');
        auditToolCall(TOOL_EXPORT_BOM_CSV, 'ok', { filename, size: buffer.length });
        return toolText({ ...fileResult(filename, 'text/csv; charset=utf-8', buffer), stats });
      } catch (e) {
        auditToolCall(TOOL_EXPORT_BOM_CSV, 'fail', { error: e?.message ?? String(e) });
        return exportToolError('开料单导出失败：', e);
      }
    }
  );

  // ── cad.export_roombook ─────────────────────────────────────────
  server.registerTool(
    TOOL_EXPORT_ROOMBOOK,
    {
      title: '导出图纸册 HTML',
      description:
        '从 live 工作区导出图纸册（复用 /api/export/roombook 全链）。' +
        '返回 base64 文件内容，浏览器打开后打印另存为 PDF。只读，不碰 draft/live。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const deny = needRead();
      if (deny) return deny;
      const lp = await liveProject();
      if (lp.error) return lp.error;
      try {
        const { html, filename } = await exportRoombook(lp.project, {
          modelVersion: lp.ws.getLiveModelVersion?.(),
        });
        const buffer = Buffer.from(html, 'utf8');
        auditToolCall(TOOL_EXPORT_ROOMBOOK, 'ok', { filename, size: buffer.length });
        return toolText(fileResult(filename, 'text/html; charset=utf-8', buffer));
      } catch (e) {
        auditToolCall(TOOL_EXPORT_ROOMBOOK, 'fail', { error: e?.message ?? String(e) });
        return exportToolError('图纸册导出失败：', e);
      }
    }
  );

  // ── cad.export_pdf ───────────────────────────────────────────────
  server.registerTool(
    TOOL_EXPORT_PDF,
    {
      title: '导出房间 PDF 图纸册',
      description: '只读：可选择房间导出 A3 横向 PDF，默认仅含逐柜尺寸/结构图页；layoutRoomIds 中的房间会在本房间首张柜体页前附加布局页。',
      inputSchema: z.object({
        roomId: z.string().optional().describe('限定房间；缺省导出全部房间'),
        layoutRoomIds: z.array(z.string()).optional().describe('为这些房间附加布局页；缺省为空，不生成布局页'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const deny = needRead();
      if (deny) return deny;
      const lp = await liveProject();
      if (lp.error) return lp.error;
      const project = scopedProject(lp.project, args.roomId);
      if (!project) return toolError('ROOM_NOT_FOUND', `找不到房间：${args.roomId}`);
      try {
        const layoutRoomIds = args.layoutRoomIds ?? [];
        const { pdf, pageCount, filename } = await exportPdf(project, { modelVersion: lp.ws.getLiveModelVersion?.(), layoutRoomIds });
        auditToolCall(TOOL_EXPORT_PDF, 'ok', { filename, size: pdf.length, pages: pageCount, roomId: args.roomId ?? null, layoutRoomIds });
        return toolText({ ...fileResult(filename, 'application/pdf', pdf), pageCount });
      } catch (e) {
        auditToolCall(TOOL_EXPORT_PDF, 'fail', { error: e?.message ?? String(e) });
        return exportToolError('PDF 导出失败：', e);
      }
    }
  );
}
