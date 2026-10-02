/**
 * ══════════════════════════════════════════════════════════════════════
 *  MCP 写工具（P10.0 · S4/S5）
 *
 *  ── 范围 ──
 *   S4（designer+，只写 draft，绝不碰 live）：
 *     cad.create_cabinet / cad.place_cabinet / cad.update_object /
 *     cad.delete_object / cad.submit_proposal
 *   S5：
 *     cad.apply_draft（admin+，乐观锁，不对版本就 DRAFT_STALE 拒绝）
 *     cad.discard_draft（draft 归属者或 manage 角色）
 *   S3 补齐：cad.list_drafts（读，viewer+）
 *
 *  ── 不变量（违反任何一条即为实现事故）──
 *   1. 写工具只调 WorkspaceStore 的 draft 方法（createDraft/draftExecute/
 *      applyDraft/discardDraft），**绝不**直接 bus.execute 改 live，
 *      **绝不** project.foo = ...，**绝不**自建第二套 mutation。
 *   2. 每条命令都经**同一套**编译/执行链：
 *      柜体类 → 复用 AI 编译器 compileAction（与内置 AI 逐字节同一条路）；
 *      墙/房间 → 复用 commands.ts 既有构造器；全部走 draft 的 CommandBus.execute
 *     （含 WRITABLE/DENY 白名单），MCP 不新增任何命令、不放宽任何正则。
 *   3. 坐标：语义落位走 placement 引擎（MCP 不算坐标）；显式 x/y 走
 *      cabinet.move + cabinet.rotate（用户授权输入语义）。
 *   4. 审计只记 actor/tool/result，不记 token、不记 project。
 *   5. 每次 draft 变更后必须 await saveDraft 落盘；apply/discard 后删文件。
 *      没落盘就不算成功 —— 与 Workspace.execute() 同一条纪律。
 * ══════════════════════════════════════════════════════════════════════
 */
import { z } from 'zod';
import { ROLES } from './auth.mjs';

export const TOOL_CREATE_CABINET = 'cad.create_cabinet';
export const TOOL_PLACE_CABINET = 'cad.place_cabinet';
export const TOOL_UPDATE_OBJECT = 'cad.update_object';
export const TOOL_DELETE_OBJECT = 'cad.delete_object';
export const TOOL_SUBMIT_PROPOSAL = 'cad.submit_proposal';
export const TOOL_LIST_DRAFTS = 'cad.list_drafts';
export const TOOL_APPLY_DRAFT = 'cad.apply_draft';
export const TOOL_DISCARD_DRAFT = 'cad.discard_draft';

/** S4/S5 新增的全部写工具（ALLOWED_TOOLS 的扩展，走同一套方案纪律）。 */
export const WRITE_TOOLS = [
  TOOL_CREATE_CABINET,
  TOOL_PLACE_CABINET,
  TOOL_UPDATE_OBJECT,
  TOOL_DELETE_OBJECT,
  TOOL_SUBMIT_PROPOSAL,
  TOOL_LIST_DRAFTS,
  TOOL_APPLY_DRAFT,
  TOOL_DISCARD_DRAFT,
];

// ── .ts 核心模块懒加载（--experimental-strip-types，与 workspaceHost 同一条路）──
let _mod = null;
async function core() {
  if (!_mod) {
    const [commands, compile, planRunner, proposal, compileProposalMod] = await Promise.all([
      import('../src/core/commands.ts'),
      import('../src/ai/compile.ts'),
      import('../src/ai/planRunner.ts'),
      import('../src/ai/proposal.ts'),
      import('../src/ai/compileProposal.ts'),
    ]);
    _mod = { commands, compile, planRunner, proposal, compileProposalMod };
  }
  return _mod;
}

function toolText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function toolError(code, message, extra = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, code, message, ...extra }, null, 2) }],
    isError: true,
  };
}

/**
 * 权限判定（§11 权限矩阵）。
 * local-open（还没建账号）：与既有 /api 一致 —— 单用户全权，不设闸。
 * accounts 模式：只读 ROLES 表，不在别处另写 if (role === ...)。
 */
function requirePerm(principal, need) {
  if (principal.mode === 'local-open') return null;
  const r = ROLES[principal.role];
  const ok = need === 'manage' ? r?.canManage === true : need === 'design' ? r?.canDesign === true : r?.canView === true;
  if (!ok) {
    return toolError(
      'FORBIDDEN',
      `权限不足：${need === 'manage' ? '管理' : need === 'design' ? '设计' : '查看'}权限 required，当前角色 ${principal.role ?? '未知'}`
    );
  }
  return null;
}

function workspaceOrError(workspaceState) {
  if (!workspaceState || workspaceState.ok !== true || !workspaceState.workspace) {
    const detail = workspaceState?.error ?? '未装载';
    return { error: toolError('WORKSPACE_UNAVAILABLE', `服务端工作区不可用：${detail}`) };
  }
  return { workspace: workspaceState.workspace };
}

/**
 * 取 draft：给了 draftId 就校验存在；没给就新建并落盘。
 * 返回 {ws, draftId, isNew} 或 {error}。
 */
async function withDraft(ws, draftId, actor) {
  if (draftId) {
    const h = ws.getDraft(draftId);
    if (!h) return { error: toolError('DRAFT_NOT_FOUND', `draft 不存在：${draftId}`) };
    return { ws, draftId, isNew: false, handle: h };
  }
  const h = ws.createDraft(actor);
  await ws.saveDraft(h.draftId);
  return { ws, draftId: h.draftId, isNew: true, handle: h };
}

/** 新建的 draft 若首条命令就失败，顺手清理，避免草稿堆积。 */
async function cleanupNewDraft(ws, draftId) {
  ws.discardDraft(draftId);
  await ws.deleteDraftFile(draftId);
}

/** 在 draft 上编译并执行一条 AI 动作（复用 compileAction —— 与内置 AI 同一条编译路）。 */
async function draftRunAction(ws, draftId, aiAction) {
  const { compile } = await core();
  const rules = ws.getRules();
  const project = ws.draftState(draftId);
  if (!project) return { ok: false, error: `draft 不存在：${draftId}` };
  const c = compile.compileAction({ ...aiAction, origin: 'mcp' }, project, rules);
  if (!c.ok) return { ok: false, error: c.error ?? '编译失败' };
  const r = ws.draftExecute(draftId, c.command);
  if (!r.ok) return { ok: false, error: r.error ?? '命令被拒绝', issues: r.newIssues ?? [] };
  await ws.saveDraft(draftId);
  return { ok: true, label: c.summary ?? c.command.label ?? '', command: c.command };
}

/** draft 版本新鲜度提示（append 到过期 draft 上是白干，apply 一定会被拒）。 */
function staleHint(ws, handle) {
  const live = ws.getLiveModelVersion();
  if (handle.baseModelVersion !== live) {
    return {
      baseStale: true,
      baseModelVersion: handle.baseModelVersion,
      liveModelVersion: live,
      hint: '这份草稿基于旧版本，apply 时会被 DRAFT_STALE 拒绝；建议 discard 后重建',
    };
  }
  return { baseStale: false, baseModelVersion: handle.baseModelVersion, liveModelVersion: live };
}

/**
 * 注册 S4/S5 写工具。
 * @param {object} server  McpServer 实例
 * @param {object} ctx
 * @param {() => Promise<object>} ctx.getWorkspaceState
 * @param {object} ctx.principal  本次请求的调用者（闭包捕获，与调用者同一份事实）
 * @param {(tool: string, result: string, extra?: object) => void} ctx.auditToolCall
 */
export function registerWriteTools(server, { getWorkspaceState, principal, auditToolCall }) {
  const needDesign = () => requirePerm(principal, 'design');

  // ── cad.create_cabinet ──────────────────────────────────────────
  server.registerTool(
    TOOL_CREATE_CABINET,
    {
      title: '新建柜体（进 draft）',
      description:
        '在 draft 里新建一个柜体（未落位或按给定位置初建），不碰 live 模型。' +
        '落位请随后调 cad.place_cabinet（语义落位走 placement 引擎）。返回 draftId 与 cabinetId。',
      inputSchema: z.object({
        name: z.string().min(1).describe('柜体名，须唯一'),
        roomId: z.string().optional().describe('房间 id；缺省取第一个房间'),
        roomName: z.string().optional().describe('房间名（roomId 缺省时可用）'),
        width: z.number().optional().describe('mm，缺省按规则默认'),
        height: z.number().optional().describe('mm'),
        depth: z.number().optional().describe('mm'),
        rotation: z.number().optional().describe('度，缺省 0'),
        x: z.number().optional().describe('初始 x（mm），缺省自动避让已有柜'),
        y: z.number().optional().describe('初始 y（mm）'),
        draftId: z.string().optional().describe('追加到已有 draft；缺省新建'),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const deny = needDesign();
      if (deny) return deny;
      const r = workspaceOrError(await getWorkspaceState());
      if (r.error) return r.error;
      const ws = r.workspace;
      const d = await withDraft(ws, args.draftId, principal.actor);
      if (d.error) return d.error;
      const params = { name: args.name };
      if (args.width !== undefined) params.width = args.width;
      if (args.height !== undefined) params.height = args.height;
      if (args.depth !== undefined) params.depth = args.depth;
      if (args.rotation !== undefined) params.rotation = args.rotation;
      if (args.x !== undefined) params.atX = args.x;
      if (args.y !== undefined) params.atY = args.y;
      const target = {};
      if (args.roomId) target.roomId = args.roomId;
      else if (args.roomName) target.roomName = args.roomName;
      else {
        const proj = ws.draftState(d.draftId);
        const firstRoom = proj?.rooms?.[0];
        if (!firstRoom) {
          if (d.isNew) await cleanupNewDraft(ws, d.draftId);
          return toolError('NO_ROOM', '项目里没有房间，请先建房间（或指定 roomId）');
        }
        target.roomId = firstRoom.id;
      }
      const run = await draftRunAction(ws, d.draftId, { action: 'cabinet.create', target, params });
      if (!run.ok) {
        if (d.isNew) await cleanupNewDraft(ws, d.draftId);
        auditToolCall(TOOL_CREATE_CABINET, 'fail', { draftId: d.draftId, error: run.error });
        return toolError('COMMAND_REJECTED', run.error);
      }
      // cabinet.create 的命令 payload 里带 cabinet（含服务端生成的 id）
      const cabinetId = run.command?.payload?.cabinet?.id ?? run.command?.target?.id ?? null;
      auditToolCall(TOOL_CREATE_CABINET, 'ok', { draftId: d.draftId, cabinetId });
      return toolText({ ok: true, draftId: d.draftId, cabinetId, label: run.label, ...staleHint(ws, d.handle) });
    }
  );

  // ── cad.place_cabinet ───────────────────────────────────────────
  server.registerTool(
    TOOL_PLACE_CABINET,
    {
      title: '柜体落位（进 draft）',
      description:
        '把 draft 里的柜体落位，不碰 live。两种模式：' +
        'auto（默认）：语义落位，relation=adjacent|align|attach + reference（参照柜体 id 或唯一名），坐标由 placement 引擎算，MCP 不传坐标；' +
        'explicit：直接给 x/y（mm）+ rotation（度），走 cabinet.move + cabinet.rotate（用户授权输入语义）。',
      inputSchema: z.object({
        cabinetId: z.string().min(1),
        draftId: z.string().optional(),
        mode: z.enum(['auto', 'explicit']).default('auto'),
        relation: z.enum(['adjacent', 'align', 'attach']).optional(),
        reference: z.string().optional().describe('参照柜体 id 或唯一名'),
        side: z.enum(['left', 'right', 'front', 'back']).optional(),
        alignment: z.string().optional(),
        targetFace: z.enum(['left', 'right', 'front', 'back']).optional(),
        referenceFace: z.enum(['left', 'right', 'front', 'back']).optional(),
        offset: z.number().optional().describe('attach 缝隙 mm，≥0'),
        x: z.number().optional(),
        y: z.number().optional(),
        rotation: z.number().optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const deny = needDesign();
      if (deny) return deny;
      const r = workspaceOrError(await getWorkspaceState());
      if (r.error) return r.error;
      const ws = r.workspace;
      const d = await withDraft(ws, args.draftId, principal.actor);
      if (d.error) return d.error;
      const fail = async (msg) => {
        if (d.isNew) await cleanupNewDraft(ws, d.draftId);
        auditToolCall(TOOL_PLACE_CABINET, 'fail', { draftId: d.draftId, error: msg });
        return toolError('COMMAND_REJECTED', msg);
      };
      if (args.mode === 'explicit') {
        if (args.x === undefined || args.y === undefined) return fail('explicit 模式必须给 x 和 y（mm）');
        const mv = await draftRunAction(ws, d.draftId, {
          action: 'cabinet.move',
          target: { cabinetId: args.cabinetId },
          params: { x: args.x, y: args.y },
        });
        if (!mv.ok) return fail(mv.error);
        let label = mv.label;
        if (args.rotation !== undefined) {
          const rt = await draftRunAction(ws, d.draftId, {
            action: 'cabinet.rotate',
            target: { cabinetId: args.cabinetId },
            params: { deg: args.rotation },
          });
          if (!rt.ok) return fail(rt.error);
          label = `${label}；${rt.label}`;
        }
        auditToolCall(TOOL_PLACE_CABINET, 'ok', { draftId: d.draftId, mode: 'explicit' });
        return toolText({ ok: true, draftId: d.draftId, label, ...staleHint(ws, d.handle) });
      }
      // auto：语义落位
      if (!args.relation) return fail('auto 模式必须给 relation（adjacent|align|attach）');
      if (!args.reference) return fail('auto 模式必须给 reference（参照柜体 id 或唯一名）');
      const params = { relation: args.relation, reference: args.reference };
      if (args.side !== undefined) params.side = args.side;
      if (args.alignment !== undefined) params.alignment = args.alignment;
      if (args.targetFace !== undefined) params.targetFace = args.targetFace;
      if (args.referenceFace !== undefined) params.referenceFace = args.referenceFace;
      if (args.offset !== undefined) params.offset = args.offset;
      const run = await draftRunAction(ws, d.draftId, {
        action: 'cabinet.place',
        target: { cabinetId: args.cabinetId },
        params,
      });
      if (!run.ok) return fail(run.error);
      auditToolCall(TOOL_PLACE_CABINET, 'ok', { draftId: d.draftId, mode: 'auto', relation: args.relation });
      return toolText({ ok: true, draftId: d.draftId, label: run.label, ...staleHint(ws, d.handle) });
    }
  );

  // ── cad.update_object ───────────────────────────────────────────
  // field 白名单 → AI 动作映射。WRITABLE 是总线侧的第二道防线（draftExecute 内），
  // 这里的第一道是"只允许这些 field"，未知 field 直接拒绝，不存在"改了再回滚"。
  const CABINET_FIELDS = {
    width: { action: 'cabinet.resize', param: 'width' },
    height: { action: 'cabinet.resize', param: 'height' },
    depth: { action: 'cabinet.resize', param: 'depth' },
    bodyLift: { action: 'cabinet.setBodyLift', param: 'mm' },
    name: { action: 'cabinet.rename', param: 'name' },
    x: { action: 'cabinet.move', param: 'x' },
    y: { action: 'cabinet.move', param: 'y' },
    rotation: { action: 'cabinet.rotate', param: 'deg' },
    boardMaterial: { action: 'cabinet.setBoardMaterial', param: 'material' },
    backMaterial: { action: 'cabinet.setBackMaterial', param: 'material' },
    widthMode: { action: 'cabinet.setWidthMode', param: 'mode' },
  };
  server.registerTool(
    TOOL_UPDATE_OBJECT,
    {
      title: '改对象字段（进 draft）',
      description:
        '改 draft 里对象的单个字段，不碰 live。' +
        'cabinet 可改：width/height/depth/bodyLift/name/x/y/rotation/boardMaterial/backMaterial/widthMode；' +
        'wall 可改：thickness/name；room 可改：name。field 不在白名单直接拒绝。',
      inputSchema: z.object({
        targetId: z.string().min(1),
        targetType: z.enum(['cabinet', 'wall', 'room']),
        field: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean()]),
        draftId: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const deny = needDesign();
      if (deny) return deny;
      const r = workspaceOrError(await getWorkspaceState());
      if (r.error) return r.error;
      const ws = r.workspace;
      const d = await withDraft(ws, args.draftId, principal.actor);
      if (d.error) return d.error;
      const fail = async (msg) => {
        if (d.isNew) await cleanupNewDraft(ws, d.draftId);
        auditToolCall(TOOL_UPDATE_OBJECT, 'fail', { draftId: d.draftId, error: msg });
        return toolError('COMMAND_REJECTED', msg);
      };
      let run;
      if (args.targetType === 'cabinet') {
        const m = CABINET_FIELDS[args.field];
        if (!m) return fail(`cabinet 不支持改 field「${args.field}」（白名单：${Object.keys(CABINET_FIELDS).join('/')})`);
        run = await draftRunAction(ws, d.draftId, {
          action: m.action,
          target: { cabinetId: args.targetId },
          params: { [m.param]: args.value },
        });
      } else if (args.targetType === 'wall') {
        // 墙没有 AI 动作，走既有构造器（命令仍经 draft 总线 WRITABLE 校验）
        const { commands } = await core();
        const proj = ws.draftState(d.draftId);
        const wall = proj?.walls?.find((w) => w.id === args.targetId);
        if (!wall) return fail(`找不到墙：${args.targetId}`);
        let cmd;
        if (args.field === 'thickness') {
          const t = Number(args.value);
          if (!Number.isFinite(t) || t <= 0) return fail('thickness 必须是 >0 的数字（mm）');
          cmd = commands.setWallThickness(wall.id, wall.name, t, 'mcp');
        } else if (args.field === 'name') {
          cmd = commands.renameWall(wall.id, wall.name, String(args.value), 'mcp');
        } else {
          return fail('wall 只支持改 thickness/name');
        }
        const er = ws.draftExecute(d.draftId, cmd);
        if (!er.ok) return fail(er.error ?? '命令被拒绝');
        await ws.saveDraft(d.draftId);
        run = { ok: true, label: cmd.label ?? '' };
      } else {
        const { commands } = await core();
        const proj = ws.draftState(d.draftId);
        const idx = proj?.rooms?.findIndex((rm) => rm.id === args.targetId) ?? -1;
        if (idx < 0) return fail(`找不到房间：${args.targetId}`);
        if (args.field !== 'name') return fail('room 只支持改 name');
        const room = proj.rooms[idx];
        const cmd = commands.renameRoomCommand(idx, room.name, String(args.value), 'mcp');
        const er = ws.draftExecute(d.draftId, cmd);
        if (!er.ok) return fail(er.error ?? '命令被拒绝');
        await ws.saveDraft(d.draftId);
        run = { ok: true, label: cmd.label ?? '' };
      }
      if (!run.ok) return fail(run.error);
      auditToolCall(TOOL_UPDATE_OBJECT, 'ok', { draftId: d.draftId, target: args.targetId, field: args.field });
      return toolText({ ok: true, draftId: d.draftId, label: run.label, ...staleHint(ws, d.handle) });
    }
  );

  // ── cad.delete_object ───────────────────────────────────────────
  server.registerTool(
    TOOL_DELETE_OBJECT,
    {
      title: '删除对象（进 draft）',
      description: '从 draft 里删除柜体/墙/房间，不碰 live。删除房间会连带其内容（与既有语义一致）。',
      inputSchema: z.object({
        targetId: z.string().min(1),
        targetType: z.enum(['cabinet', 'wall', 'room']),
        draftId: z.string().optional(),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const deny = needDesign();
      if (deny) return deny;
      const r = workspaceOrError(await getWorkspaceState());
      if (r.error) return r.error;
      const ws = r.workspace;
      const d = await withDraft(ws, args.draftId, principal.actor);
      if (d.error) return d.error;
      const fail = async (msg) => {
        if (d.isNew) await cleanupNewDraft(ws, d.draftId);
        auditToolCall(TOOL_DELETE_OBJECT, 'fail', { draftId: d.draftId, error: msg });
        return toolError('COMMAND_REJECTED', msg);
      };
      const { commands } = await core();
      const proj = ws.draftState(d.draftId);
      let cmd;
      if (args.targetType === 'cabinet') {
        const cab = proj?.cabinets?.find((c) => c.id === args.targetId);
        if (!cab) return fail(`找不到柜体：${args.targetId}`);
        cmd = commands.deleteCabinet(cab, 'mcp');
      } else if (args.targetType === 'wall') {
        const wall = proj?.walls?.find((w) => w.id === args.targetId);
        if (!wall) return fail(`找不到墙：${args.targetId}`);
        cmd = commands.deleteWall(wall.id, wall.name, 'mcp');
      } else {
        const room = proj?.rooms?.find((rm) => rm.id === args.targetId);
        if (!room) return fail(`找不到房间：${args.targetId}`);
        cmd = commands.deleteRoomCommand(room.id, room.name, 'mcp');
      }
      const er = ws.draftExecute(d.draftId, cmd);
      if (!er.ok) return fail(er.error ?? '命令被拒绝');
      await ws.saveDraft(d.draftId);
      auditToolCall(TOOL_DELETE_OBJECT, 'ok', { draftId: d.draftId, target: args.targetId });
      return toolText({ ok: true, draftId: d.draftId, label: cmd.label ?? '', ...staleHint(ws, d.handle) });
    }
  );

  // ── cad.submit_proposal ─────────────────────────────────────────
  server.registerTool(
    TOOL_SUBMIT_PROPOSAL,
    {
      title: '提交 AI 设计方案（进 draft）',
      description:
        '把一份 DesignProposal 编译后进 draft，不碰 live。' +
        '复用既有链：compileProposal → validateProposal → dryRunPlan，MCP 只做参数搬运，不重写编译器。' +
        '校验不通过直接结构化返回，不产生 draft。',
      inputSchema: z.object({
        proposal: z.record(z.unknown()).describe('DesignProposal 对象'),
        draftId: z.string().optional().describe('追加到已有 draft；缺省新建'),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const deny = needDesign();
      if (deny) return deny;
      const r = workspaceOrError(await getWorkspaceState());
      if (r.error) return r.error;
      const ws = r.workspace;
      const { compileProposalMod, proposal: proposalMod, planRunner, compile } = await core();
      const rules = ws.getRules();
      const project = ws.getProjectSnapshot();
      let compiled;
      try {
        compiled = compileProposalMod.compileProposal(args.proposal, project, rules);
      } catch (e) {
        auditToolCall(TOOL_SUBMIT_PROPOSAL, 'fail', { error: 'PROPOSAL_COMPILE_THROW' });
        return toolError('PROPOSAL_INVALID', `方案编译抛错：${e?.message ?? e}`);
      }
      const issues = proposalMod.validateProposal(args.proposal, project);
      if (proposalMod.proposalBlocked(issues)) {
        const blocking = issues.filter((i) => i.severity === 'ERROR');
        auditToolCall(TOOL_SUBMIT_PROPOSAL, 'fail', { error: 'PROPOSAL_BLOCKED', blocking: blocking.length });
        return toolError(
          'PROPOSAL_BLOCKED',
          '方案校验不通过，未产生 draft',
          { issues: blocking.map((i) => ({ code: i.code, message: i.message })) }
        );
      }
      const d = await withDraft(ws, args.draftId, principal.actor);
      if (d.error) return d.error;
      const fail = async (msg, extra = {}) => {
        if (d.isNew) await cleanupNewDraft(ws, d.draftId);
        auditToolCall(TOOL_SUBMIT_PROPOSAL, 'fail', { draftId: d.draftId, error: msg });
        return toolError('COMMAND_REJECTED', msg, extra);
      };
      // dryRunPlan 自带内部沙盒（不碰传入 bus），逐条编译；取每步的 command 落到 draft
      const { CommandBus } = await import('../src/core/commandBus.ts');
      const sandboxBus = new CommandBus(project, rules);
      let run;
      try {
        run = planRunner.dryRunPlan({ bus: sandboxBus, actions: compiled.actions ?? [] });
      } catch (e) {
        return fail(`干跑抛错：${e?.message ?? e}`);
      }
      const failed = run.steps.filter((s) => !s.ok);
      if (failed.length > 0) {
        return fail(
          `${failed.length}/${run.steps.length} 步编译/执行失败，未产生有效改动`,
          { steps: failed.map((s) => ({ label: s.label, error: s.error })) }
        );
      }
      const labels = [];
      for (const s of run.steps) {
        if (!s.command) continue;
        const er = ws.draftExecute(d.draftId, s.command);
        if (!er.ok) return fail(`draft 执行失败「${s.label}」：${er.error ?? '被拒绝'}`);
        labels.push(s.label);
      }
      await ws.saveDraft(d.draftId);
      auditToolCall(TOOL_SUBMIT_PROPOSAL, 'ok', { draftId: d.draftId, steps: labels.length });
      return toolText({ ok: true, draftId: d.draftId, steps: labels.length, labels, ...staleHint(ws, d.handle) });
    }
  );

  // ── cad.list_drafts ─────────────────────────────────────────────
  server.registerTool(
    TOOL_LIST_DRAFTS,
    {
      title: '列出草稿',
      description: '只读：列出当前 workspace 的全部 draft（含归属、基版本、创建时间）。',
      inputSchema: z.object({}).default({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const deny = requirePerm(principal, 'view');
      if (deny) return deny;
      const r = workspaceOrError(await getWorkspaceState());
      if (r.error) return r.error;
      const ws = r.workspace;
      const drafts = ws.listDrafts();
      auditToolCall(TOOL_LIST_DRAFTS, 'ok', { count: drafts.length });
      return toolText({ ok: true, liveModelVersion: ws.getLiveModelVersion(), drafts });
    }
  );

  // ── cad.apply_draft ─────────────────────────────────────────────
  server.registerTool(
    TOOL_APPLY_DRAFT,
    {
      title: '应用草稿（写 live）',
      description:
        '把 draft 应用到 live 模型。乐观锁：仅当 liveModelVersion == draft.baseModelVersion 才应用；' +
        '否则返回结构化 DRAFT_STALE（不自动 merge、不静默覆盖），由调用方决定重建还是放弃。',
      inputSchema: z.object({ draftId: z.string().min(1) }),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (args) => {
      const deny = requirePerm(principal, 'manage');
      if (deny) return deny;
      const r = workspaceOrError(await getWorkspaceState());
      if (r.error) return r.error;
      const ws = r.workspace;
      const h = ws.getDraft(args.draftId);
      if (!h) {
        auditToolCall(TOOL_APPLY_DRAFT, 'fail', { draftId: args.draftId, error: 'DRAFT_NOT_FOUND' });
        return toolError('DRAFT_NOT_FOUND', `draft 不存在：${args.draftId}`);
      }
      const liveBefore = ws.getLiveModelVersion();
      const ar = await ws.applyDraft(args.draftId);
      if (!ar.ok) {
        auditToolCall(TOOL_APPLY_DRAFT, 'fail', { draftId: args.draftId, error: ar.code });
        // §10.2 结构化错误形状
        return toolError('DRAFT_STALE', ar.message, {
          baseVersion: h.baseModelVersion,
          currentVersion: liveBefore,
          draftId: args.draftId,
          hint: `这份草案基于模型版本 ${h.baseModelVersion}，模型已更新到 ${liveBefore}。请重新出草案，或放弃这份。`,
        });
      }
      await ws.deleteDraftFile(args.draftId);
      auditToolCall(TOOL_APPLY_DRAFT, 'ok', { draftId: args.draftId, newVersion: ar.newVersion });
      return toolText({ ok: true, draftId: args.draftId, newVersion: ar.newVersion });
    }
  );

  // ── cad.discard_draft ───────────────────────────────────────────
  server.registerTool(
    TOOL_DISCARD_DRAFT,
    {
      title: '丢弃草稿',
      description:
        '丢弃 draft（不碰 live）。权限按归属：draft 的创建者可丢自己的；' +
        '丢别人的需要 manage 权限。',
      inputSchema: z.object({ draftId: z.string().min(1) }),
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const r = workspaceOrError(await getWorkspaceState());
      if (r.error) return r.error;
      const ws = r.workspace;
      const h = ws.getDraft(args.draftId);
      if (!h) {
        auditToolCall(TOOL_DISCARD_DRAFT, 'fail', { draftId: args.draftId, error: 'DRAFT_NOT_FOUND' });
        return toolError('DRAFT_NOT_FOUND', `draft 不存在：${args.draftId}`);
      }
      // §11.1 取向 (c)：归属者或 manage
      const mine = principal.mode === 'local-open' || h.owner === principal.actor;
      if (!mine) {
        const deny = requirePerm(principal, 'manage');
        if (deny) {
          auditToolCall(TOOL_DISCARD_DRAFT, 'fail', { draftId: args.draftId, error: 'FORBIDDEN' });
          return deny;
        }
      }
      ws.discardDraft(args.draftId);
      await ws.deleteDraftFile(args.draftId);
      auditToolCall(TOOL_DISCARD_DRAFT, 'ok', { draftId: args.draftId });
      return toolText({ ok: true, draftId: args.draftId });
    }
  );
}
