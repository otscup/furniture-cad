import { useCallback, useEffect, useLayoutEffect, useRef, useState, lazy, Suspense } from 'react';
import type { DrawingView, Issue, Project, Vec2 } from '../core/types.ts';
import { CommandBus, type Command, type ExecResult } from '../core/commandBus.ts';
import * as CMD from '../core/commands.ts';
import { bus, useBusVersion, RULESET } from '../state/store.ts';
import { createWall as makeWall, createCabinetFromTemplate, DEFAULT_WALL_THICKNESS, DEFAULT_WALL_HEIGHT, sampleProject } from '../core/docFactory.ts';
import { CABINET_TEMPLATES } from '../core/templates.ts';
import { placeAgainstNearestWall } from '../core/snapPlace.ts';
import { candidateSpots } from '../core/snapPlace.ts';
import { indexProjectRooms } from '../core/roomIndex.ts';
import { DEFAULT_SNAP } from '../viewport/snapping.ts';
import type { SnapSettings } from '../viewport/snapping.ts';
import { defaultHiddenLayers } from '../viewport/layers.ts';
import type { Camera } from '../viewport/camera.ts';
import { Viewport } from './Viewport.tsx';
/**
 * 3D 视口懒加载：three.js 约 1MB（gzip ~300KB），静态引入会把只看 2D 的用户
 * 也拖下水。lazy 后 three 只在首次切到 3D 模式时才下载 —— 首屏主包立即减重。
 */
const ThreeViewport = lazy(() => import('./ThreeViewport.tsx').then((m) => ({ default: m.ThreeViewport })));
import { Toolbar } from './Toolbar.tsx';
import type { RightTab } from './Toolbar.tsx';
import { observeCommand, recordObservation, loadKnowledge, saveKnowledge, placementContextOf } from '../ai/knowledge/index.ts';
import { ContextMenu } from './ContextMenu.tsx';
import type { CtxItem } from './ContextMenu.tsx';
import { StatusBar } from './StatusBar.tsx';
import { CommandLine } from './CommandLine.tsx';
import { ObjectTree } from './panels/ObjectTree.tsx';
import { LayersPanel } from './panels/LayersPanel.tsx';
import { PropertiesPanel } from './panels/PropertiesPanel.tsx';
import { IssuesPanel } from './panels/IssuesPanel.tsx';
import { HistoryPanel } from './panels/HistoryPanel.tsx';
import { ViewsPanel } from './panels/ViewsPanel.tsx';
import { MemoryPanel } from './panels/MemoryPanel.tsx';
import { AdminPanel } from './panels/AdminPanel.tsx';
import { AIPanel } from './panels/AIPanel.tsx';
import { DraftsPanel } from './panels/DraftsPanel.tsx';
import { ImportPanel } from './panels/ImportPanel.tsx';
import { KnowledgePanel } from './panels/KnowledgePanel.tsx';
import { ManufacturingPanel } from './panels/ManufacturingPanel.tsx';
import { ProjectsPanel } from './panels/ProjectsPanel.tsx';
import { RoomsPanel } from './panels/RoomsPanel.tsx';
import { AccountPanel } from './panels/AccountPanel.tsx';
import { VariantPanel } from './panels/VariantPanel.tsx';
import { ExportPanel } from './panels/ExportPanel.tsx';
import { RoomWorkspace, WorkspaceTopBar } from './RoomWorkspace.tsx';
import { agentEventFromSsePayload, appendAgentEvent } from './liveAgentLog.ts';
import type { AgentStreamEvent, AgentStreamEventInput } from './liveAgentLog.ts';
import { api, loadToken, saveToken } from '../ai/aiClient.ts';
import { loadDraft, saveDraft, clearDraft, fmtSavedAt, hasStoredDuplicateUnitIds, setProjectStorageReadOnly } from '../state/draftStore.ts';
import type { PickLine } from '../core/geometry/pickLines.ts';
import { noteHit, useCorrections } from '../state/memoryStore.ts';
import { nextToastId } from './types.ts';
import { newCommandId } from '../core/ids.ts';
import { editIdFromSelection, editSelectionId, filterValidDrawingEdits, replaceDrawingEdits, sourceKeyFromSelection, sourceOverride, translateDrawingEntity } from '../core/drawingEdits.ts';
import { findDuplicateUnitIds, unitIdentityConflictMessage, repairDuplicateUnitIdsInProject, deoverlapProjectRooms } from '../core/unitIdentity.mjs';
import type { Toast, ToastKind, Tool } from './types.ts';

const WORKSPACE_CONTEXT_STORAGE_KEY = 'furniture-cad.workspace-context';
const LEGACY_WORKSPACE_ROOM_ID_STORAGE_KEY = 'furniture-cad.workspace-room-id';
const UNIT_IDENTITY_READONLY_LOCK_KEY = 'furniture-cad.unit-identity-readonly-lock';
const UNIT_IDENTITY_DRAFT_BACKUP_PREFIX = 'furnicad.draft.identity-conflict-backup';

function readPersistedIdentityLock(): { message: string; diagnostics: IdentityDiagnostics } | null {
  try {
    const raw = localStorage.getItem(UNIT_IDENTITY_READONLY_LOCK_KEY);
    const value = raw ? JSON.parse(raw) as {
      code?: unknown; message?: unknown; diagnostics?: Partial<IdentityDiagnostics>;
    } : null;
    if (value?.code !== 'WORKSPACE_UNIT_ID_CONFLICT' || typeof value.message !== 'string' || !value.message.trim()) return null;
    const diagnostics: IdentityDiagnostics = {
      readOnly: true,
      code: typeof value.diagnostics?.code === 'string' ? value.diagnostics.code : 'WORKSPACE_UNIT_ID_CONFLICT',
      message: value.message,
      duplicateUnitIds: Array.isArray(value.diagnostics?.duplicateUnitIds) ? value.diagnostics.duplicateUnitIds : [],
    };
    return { message: value.message, diagnostics };
  } catch { return null; }
}

function persistIdentityLock(message: string, diagnostics: IdentityDiagnostics): void {
  try {
    const raw = JSON.stringify({ code: 'WORKSPACE_UNIT_ID_CONFLICT', message, diagnostics });
    if (localStorage.getItem(UNIT_IDENTITY_READONLY_LOCK_KEY) !== raw) localStorage.setItem(UNIT_IDENTITY_READONLY_LOCK_KEY, raw);
  } catch { /* CommandBus 内存锁仍然有效；不可用时不允许通过健康轮询清锁 */ }
}

function clearPersistedIdentityLockAfterHealthySwitch(): void {
  try { localStorage.removeItem(UNIT_IDENTITY_READONLY_LOCK_KEY); } catch { /* 当前会话已通过 CommandBus 健康切换解锁 */ }
}

function preserveDuplicateDraftBeforeHealthySwitch(): boolean {
  try {
    if (!hasStoredDuplicateUnitIds()) return true;
    const raw = localStorage.getItem('furnicad.draft.v1');
    if (!raw) return true;
    let backupKey = `${UNIT_IDENTITY_DRAFT_BACKUP_PREFIX}.v1`;
    let index = 1;
    while (localStorage.getItem(backupKey) !== null && localStorage.getItem(backupKey) !== raw) {
      backupKey = `${UNIT_IDENTITY_DRAFT_BACKUP_PREFIX}.v1.${index++}`;
    }
    if (localStorage.getItem(backupKey) === null) localStorage.setItem(backupKey, raw);
    localStorage.removeItem('furnicad.draft.v1');
    return true;
  } catch { return false; }
}

// 必须在 React 首次 render / 任意写 handler 安装前恢复锁；刷新只恢复锁，不恢复解锁。
const persistedIdentityLock = readPersistedIdentityLock();
if (persistedIdentityLock?.message) {
  bus.setExternalReadOnly(persistedIdentityLock.message);
  setProjectStorageReadOnly(true);
}

type WorkspaceContext = { projectId: string; roomId: string };
type IdentityDiagnostics = {
  readOnly: boolean;
  code: string | null;
  message: string | null;
  duplicateUnitIds: Array<{ id: string; scope?: string; locations: string[] }>;
};
type RemoteWorkspaceStatus = {
  draftCount: number;
  differs: boolean;
  liveModelVersion: number;
  stale: boolean;
  snapshotReady: boolean;
  confirmedProject: Project;
  projectSnapshotId: string | null;
  projectSnapshotHash: string | null;
  projectSnapshotVersion: number | null;
  identityDiagnostics?: IdentityDiagnostics;
};

function readWorkspaceContext(): WorkspaceContext | null {
  try {
    const raw = localStorage.getItem(WORKSPACE_CONTEXT_STORAGE_KEY);
    if (raw) {
      const value = JSON.parse(raw) as { projectId?: unknown; roomId?: unknown };
      if (typeof value.projectId === 'string' && typeof value.roomId === 'string' && value.roomId) {
        return { projectId: value.projectId, roomId: value.roomId };
      }
    }
    const legacyRoomId = localStorage.getItem(LEGACY_WORKSPACE_ROOM_ID_STORAGE_KEY);
    if (legacyRoomId) return { projectId: '', roomId: legacyRoomId };
  } catch { /* localStorage may be unavailable or contain malformed context */ }
  return null;
}

function workspaceGroupExists(project: Project, roomId: string): boolean {
  return indexProjectRooms(project).some((group) => group.room.id === roomId);
}

function projectUnitIds(project: Pick<Project, 'cabinets'>): string[] {
  return project.cabinets.flatMap((cabinet) => [
    ...cabinet.layout.units.map((unit) => unit.id),
    ...(cabinet.layout.backUnits ?? []).map((unit) => unit.id),
    ...(cabinet.layout.rows ?? []).flatMap((row) => row.units.map((unit) => unit.id)),
  ]);
}

function stableProjectJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableProjectJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableProjectJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * ══════════════════════════════════════════════════════════════════════
 *  App —— 编排层
 *
 *  职责边界（很重要，防止架构在这层腐蚀）：
 *   · App 只持有【视图状态】（相机、选择、工具、面板开关、图层可见性）
 *   · 模型状态 100% 归 CommandBus，App 只是订阅者
 *   · App 想改模型时，唯一的动作是构造 Command 并 execute —— 和 AI 走同一条路
 * ══════════════════════════════════════════════════════════════════════
 */

export function App() {
  const version = useBusVersion();
  /**
   * 记忆列表要订阅：tab 上那个"待编译"角标必须在新增记忆后立刻更新。
   * 记忆变化极低频，订阅它的代价可以忽略。
   */
  const corrections = useCorrections();
  const memoryPending = corrections.filter((c) => c.status === 'pending').length;

  const [cam, setCam] = useState<Camera>({ cx: 900, cy: 1000, scale: 0.26 });
  const [mode, setModeRaw] = useState<'plan' | 'sheet' | '3d'>('plan');
  /**
   * 分解图开关。**默认关闭** —— 用户的说法是"4 视图调整好后**可以选择**生成
   * 分解图用于生产，也可以选择关闭"。所以默认状态必须是"关"，
   * 而不是"开着但你可以关"。打开时自动切到图幅模式：分解图是图幅的一部分，
   * 在平面图里打开它什么也看不见，那会让人以为开关坏了。
   */
  const [explode, setExplodeRaw] = useState(false);
  const [tool, setToolRaw] = useState<Tool>('select');
  /** 放置柜体使用的柜型预设（工具栏下拉 / 命令行 TPL 共用同一个状态） */
  const [templateId, setTemplateId] = useState<string>('default');
  const [selection, setSelection] = useState<string[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<boolean>(() => {
    try { return localStorage.getItem('furniture-cad.workspace-mode') !== 'cad'; } catch { return true; }
  });
  const [workspaceContextSeed] = useState(() => readWorkspaceContext());
  const [workspaceProjectId, setWorkspaceProjectId] = useState(() => workspaceContextSeed?.projectId ?? '');
  const [workspaceRoomId, setWorkspaceRoomId] = useState(() => workspaceContextSeed?.roomId ?? bus.getState().rooms[0]?.id ?? '');
  const [sharedPanelDraftOpen, setSharedPanelDraftOpen] = useState(false);
  const [workspaceContextNotice, setWorkspaceContextNotice] = useState('');
  const workspaceContextValidatedRef = useRef(false);
  const unitIdentityReadOnlyRef = useRef(Boolean(hasStoredDuplicateUnitIds() || bus.getUnitIdentityConflict()));
  const [accountOpen, setAccountOpen] = useState(false);
  const [snap, setSnap] = useState<SnapSettings>(DEFAULT_SNAP);
  const [showGrid, setShowGrid] = useState(true);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(() => defaultHiddenLayers());
  const [pendingMove, setPendingMove] = useState<{ base: Vec2 | null } | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('ai');
  /** 房间页的两种状态：列表 / 新建表单。放在这里是因为面板按需挂载，卸载会丢 state */
  const [roomsView, setRoomsView] = useState<'list' | 'new'>('list');
  const [leftTab, setLeftTab] = useState<'tree' | 'layers'>('tree');
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fitSignal, setFitSignal] = useState(0);
  const [cancelSignal, setCancelSignal] = useState(0);
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const setTool = useCallback((nextTool: Tool) => {
    if (toolRef.current === nextTool) return;
    toolRef.current = nextTool;
    setToolRaw(nextTool);
    setSelection([]);
    setPendingMove(null);
  }, []);
  /** 聚焦某个房间：切到平面图并把视口缩放到该房间的包围盒（解决"多个房间分不清哪个是哪个"） */
  const [focusRoom, setFocusRoom] = useState<{ id: string; sig: number }>({ id: '', sig: 0 });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [lastMsg, setLastMsg] = useState('');
  /**
   * 登录 token 放在 localStorage（2026-10-03 从 sessionStorage 迁过来）：
   * 关掉标签页重开、新标签页、浏览器自动化都不再要求重复登录。
   * 代价是共用这台电脑的人能拿到会话 —— 个人 NAS 部署可接受，
   * 不想要就点「退出登录」（会清掉）。
   */
  const [token, setTokenRaw] = useState<string | null>(() => loadToken());
  const [remoteWorkspaceStatus, setRemoteWorkspaceStatus] = useState<RemoteWorkspaceStatus | null>(null);
  /**
   * P1-5：PUT 被服务端以 WORKSPACE_VERSION_CONFLICT 拒绝时，把**云端项目原样**存下来，
   * 让用户显式二选一（用云端覆盖本地 / 保留本地强制覆盖云端）。
   * 绝不在这里自动决定 —— 静默覆盖正是这次要修掉的缺陷。
   */
  const [workspaceVersionConflict, setWorkspaceVersionConflict] = useState<{
    project: Project;
    liveModelVersion: number | null;
    message: string;
  } | null>(null);
  const [liveDraftPreview, setLiveDraftPreview] = useState<{
    draftId: string;
    project: Project;
    liveModelVersion: number;
    baseModelVersion: number;
    blockingErrors: number;
    stepText?: string;
  } | null>(null);
  /**
   * A3：MCP / Agent 实时事件流（最新在前，最多 50 条）。
   *
   * 纪律：这里只记录**看见**了什么（SSE 推过来的 step / draft / workspace 事件），
   * 绝不回写 bus —— 事件流是旁路观测，草稿与正式模型都只由各自的既有写入口变更。
   * 用户正在拖动、正在改尺寸时，多一条日志不会打断任何编辑操作。
   */
  const [agentEvents, setAgentEvents] = useState<AgentStreamEvent[]>([]);
  /** 去重指纹：EventSource 断线重连会重推同一步，同一条事件不能记两遍。 */
  const agentEventKeysRef = useRef<Set<string>>(new Set());
  /**
   * 归约本身是纯函数（ui/liveAgentLog.ts 的 appendAgentEvent）：倒序、去重、
   * 上限 50 条三条语义都在那里被 verify 脚本直接断言，这里只负责把 state 换掉。
   */
  const pushAgentEvent = useCallback((input: AgentStreamEventInput): void => {
    const seen = agentEventKeysRef.current;
    const now = Date.now();
    setAgentEvents((previous) => appendAgentEvent(previous, input, seen, now).events);
  }, []);
  const hasLocalDraftRef = useRef<boolean>(false);
  const hydratedFromCloudRef = useRef<boolean>(false);
  const validatedHealthyProjectFingerprintRef = useRef<string | null>(null);
  /**
   * P1-5 乐观锁基线：最近一次 GET/PUT /api/workspace 成功返回的 liveModelVersion。
   * PUT 时作为 expectedLiveVersion 发出，服务端据此拒绝"用旧基线覆盖新云端"。
   * null = 首屏 GET 还没回来，此时不发该字段（服务端视作无从比较），
   * 而不是发 0 —— 发 0 会把一次正常的首次同步误判成版本冲突。
   */
  const lastLiveVersionRef = useRef<number | null>(null);
  /**
   * P1-5：最近一次确认的**服务端侧**项目指纹。clientHasLocalEdits 由
   * "本地模型 vs 这份指纹"比较得出，不再恒为 true —— 恒 true 等于把
   * 服务端的空/无编辑防覆盖水位线保护也一并废掉。
   */
  const lastServerProjectFingerprintRef = useRef<string | null>(null);
  const [stickyIdentityDiagnostics, setStickyIdentityDiagnostics] = useState<IdentityDiagnostics | null>(persistedIdentityLock?.diagnostics ?? null);
  const currentProjectFingerprint = stableProjectJson(bus.getState());
  const remoteIdentityReadOnly = Boolean(remoteWorkspaceStatus?.identityDiagnostics?.readOnly
    && validatedHealthyProjectFingerprintRef.current !== currentProjectFingerprint);
  const unitIdentityReadOnly = Boolean(bus.getUnitIdentityConflict() || remoteIdentityReadOnly);
  unitIdentityReadOnlyRef.current = unitIdentityReadOnly;
  useLayoutEffect(() => {
    const remoteReason = remoteIdentityReadOnly
      ? remoteWorkspaceStatus?.identityDiagnostics?.message || '服务端检测到历史重复 Unit ID；项目只读，需显式修复/迁移。'
      : null;
    const reason = remoteReason ?? bus.getUnitIdentityConflict();
    if (reason) {
      bus.setExternalReadOnly(reason);
      const diagnostics = remoteIdentityReadOnly && remoteWorkspaceStatus?.identityDiagnostics
        ? remoteWorkspaceStatus.identityDiagnostics
        : stickyIdentityDiagnostics ?? {
          readOnly: true,
          code: 'UNIT_IDENTITY_CONFLICT',
          message: reason,
          duplicateUnitIds: findDuplicateUnitIds(bus.getState()),
        };
      persistIdentityLock(reason, diagnostics);
      if (!stickyIdentityDiagnostics || stableProjectJson(stickyIdentityDiagnostics) !== stableProjectJson(diagnostics)) {
        setStickyIdentityDiagnostics(diagnostics);
      }
    }
    setProjectStorageReadOnly(Boolean(reason || bus.getUnitIdentityConflict()));
  }, [bus, remoteIdentityReadOnly, remoteWorkspaceStatus?.identityDiagnostics?.message, stickyIdentityDiagnostics, unitIdentityReadOnly]);
  useEffect(() => {
    if (unitIdentityReadOnly || hasStoredDuplicateUnitIds() || bus.getUnitIdentityConflict()) return;
    try { localStorage.setItem('furniture-cad.workspace-mode', workspaceMode ? 'chat' : 'cad'); } catch { /* 浏览器存储不可用时仍可正常使用 */ }
  }, [workspaceMode, unitIdentityReadOnly]);
  const setToken = useCallback((t: string | null) => {
    setTokenRaw(t);
    saveToken(t);
  }, []);

  /**
   * P1-5 第二部分：SSE 订阅 + 兜底轮询。
   *
   * 依赖数组里**不能有 version**。原先写的是 [token, version]，而 version 每次
   * 命令提交（拖动松手、改一个尺寸）都会 +1 —— 于是每改一次就：销毁 EventSource
   * → 新建 EventSource → 服务端重跑一次 captureLiveProjectSnapshot 全量快照并 push init。
   * 这是纯粹的浪费，而且会造成"正在推的草稿预览被刚建的连接打断"这类竞态。
   * 现在 effect 只在 token 变化时重建；version 通过 versionRef 在回调里按需读最新值。
   */
  useEffect(() => {
    let cancelled = false;
    /**
     * in-flight 去重：SSE 事件连发时（draft.updated 与 workspace.updated 常前后脚到）
     * 以及"SSE 刚推完，兜底定时器又到点"时，只允许一次 GET 在飞。
     * 参考 AIPanel.tsx 里同一套写法。
     */
    let refreshInFlight = false;
    let refreshAgain = false;
    const refreshOnce = async (): Promise<void> => {
      const [workspaceResult, draftsResult] = await Promise.all([
        api<{
          project?: Project;
          liveModelVersion?: number;
          projectSnapshotId?: string;
          projectSnapshotHash?: string;
          projectSnapshotVersion?: number;
          identityDiagnostics?: IdentityDiagnostics;
        }>('/api/workspace', { token }),
        api<{ drafts?: unknown[] }>('/api/drafts', { token }),
      ]);
      if (cancelled) return;
      if (!workspaceResult.ok || !draftsResult.ok || !workspaceResult.data.project) {
        setRemoteWorkspaceStatus((previous) => previous ? { ...previous, stale: true } : null);
        return;
      }
      const snapshotId = workspaceResult.data.projectSnapshotId;
      const snapshotHash = workspaceResult.data.projectSnapshotHash;
      const snapshotVersion = workspaceResult.data.projectSnapshotVersion;
      const liveModelVersion = workspaceResult.data.liveModelVersion;
      const snapshotReady = typeof snapshotId === 'string' && snapshotId.length > 0
        && typeof snapshotHash === 'string' && /^[a-f0-9]{64}$/i.test(snapshotHash)
        && Number.isInteger(snapshotVersion) && (snapshotVersion ?? -1) >= 0
        && Number.isInteger(liveModelVersion) && snapshotVersion === liveModelVersion;

      // 云端防空覆盖自动注水：若本地浏览器没有任何已保存草稿（!hasLocalDraftRef.current）、
      // 本地模型仍处于初始未编辑状态（bus.getVersion() === 0），且服务端已有 MCP/Agent 提交的模型（liveModelVersion > 0），
      // 自动用服务端模型注水到本地画布，绝不用空本地状态冲掉云端成果！
      if (
        !hydratedFromCloudRef.current &&
        !hasLocalDraftRef.current &&
        bus.getVersion() === 0 &&
        !(window as any).__syncOnlyBus &&
        !unitIdentityReadOnlyRef.current &&
        !workspaceResult.data.identityDiagnostics?.readOnly &&
        (liveModelVersion ?? 0) > 0 &&
        stableProjectJson(workspaceResult.data.project) !== stableProjectJson(bus.getState())
      ) {
        hydratedFromCloudRef.current = true;
        try {
          bus.replaceProject(workspaceResult.data.project, `从云端工作区 v${liveModelVersion} 自动同步恢复`);
        } catch {
          /* ignore */
        }
      }

      // P1-5：把这次确认到的服务端基线记下来，供 PUT 的 expectedLiveVersion 与
      // clientHasLocalEdits 使用。只认"服务端亲口说的"版本号与指纹。
      lastLiveVersionRef.current = Number.isInteger(liveModelVersion) ? liveModelVersion! : null;
      lastServerProjectFingerprintRef.current = stableProjectJson(workspaceResult.data.project);
      setRemoteWorkspaceStatus({
        draftCount: draftsResult.data.drafts?.length ?? 0,
        differs: stableProjectJson(workspaceResult.data.project) !== stableProjectJson(bus.getState()),
        liveModelVersion: liveModelVersion ?? 0,
        stale: false,
        snapshotReady,
        confirmedProject: workspaceResult.data.project,
        projectSnapshotId: typeof snapshotId === 'string' ? snapshotId : null,
        projectSnapshotHash: typeof snapshotHash === 'string' ? snapshotHash : null,
        projectSnapshotVersion: Number.isInteger(snapshotVersion) ? snapshotVersion! : null,
        identityDiagnostics: workspaceResult.data.identityDiagnostics,
      });
    };
    /**
     * 统一的 refresh 入口：同一时刻最多一个 GET 在飞。
     * 期间又来一次请求就记一个 refreshAgain，等这次回来再补一次 ——
     * 既不会把请求打爆，也不会漏掉最后一次状态变化。
     */
    const refresh = async (): Promise<void> => {
      if (cancelled) return;
      if (refreshInFlight) { refreshAgain = true; return; }
      refreshInFlight = true;
      try {
        await refreshOnce();
      } finally {
        refreshInFlight = false;
      }
      if (refreshAgain && !cancelled) {
        refreshAgain = false;
        void refresh();
      }
    };
    void refresh();
    let es: EventSource | null = null;
    /** SSE 是否已连上；连上时 4s 定时器降级为 30s 兜底，断开时立刻恢复 4s。 */
    let streamConnected = false;
    let pollTimer: number | null = null;
    const setFallbackInterval = (ms: number): void => {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      pollTimer = window.setInterval(() => { void refresh(); }, ms);
    };
    if (typeof EventSource !== 'undefined') {
      try {
        const streamUrl = token
          ? `/api/workspace/stream?token=${encodeURIComponent(token)}`
          : '/api/workspace/stream';
        es = new EventSource(streamUrl);
        // 连接建立即说明推送通道活着，轮询能从 4s 退到 30s；onerror 时退回 4s 兜底。
        es.onopen = () => {
          if (cancelled) return;
          streamConnected = true;
          setFallbackInterval(30000);
        };
        es.onerror = () => {
          if (cancelled) return;
          // EventSource 自带重连，这里只负责把兜底轮询提回 4s，别让用户盯着旧状态。
          if (streamConnected) {
            streamConnected = false;
            setFallbackInterval(4000);
          }
        };
        es.onmessage = (evt) => {
          if (cancelled) return;
          try {
            const payload = JSON.parse(evt.data);
            /**
             * A3：**所有**事件都先过一遍这条纯函数翻译，再决定要不要动 UI。
             * 翻译规则（哪种事件算一条、键怎么拼、文本怎么写）全在
             * ui/liveAgentLog.ts 的 agentEventFromSsePayload 里，被 verify 脚本逐条断言；
             * 这里不重复拼字符串，避免"面板说的"和"预览说的"两套口径。
             */
            const agentEvent = agentEventFromSsePayload(payload);
            if (agentEvent) pushAgentEvent(agentEvent);
            if (payload.type === 'init' && payload.latestDraft?.project) {
              setLiveDraftPreview({
                draftId: payload.latestDraft.draftId,
                project: payload.latestDraft.project,
                liveModelVersion: payload.liveModelVersion ?? 0,
                baseModelVersion: payload.latestDraft.baseModelVersion ?? 0,
                blockingErrors: 0,
              });
            } else if ((payload.type === 'draft.updated' || payload.type === 'agent.step') && (payload.project || payload.draftProject)) {
              const proj = payload.project ?? payload.draftProject;
              setLiveDraftPreview({
                draftId: payload.draftId,
                project: proj,
                liveModelVersion: payload.liveModelVersion ?? payload.freshness?.liveModelVersion ?? 0,
                baseModelVersion: payload.baseModelVersion ?? payload.freshness?.baseModelVersion ?? 0,
                blockingErrors: payload.validation?.blockingErrors ?? 0,
                stepText: payload.step ? `${payload.step.tool}${payload.step.ok ? ' ✓' : ' ✗'}` : undefined,
              });
              void refresh();
            } else if (payload.type === 'draft.deleted') {
              setLiveDraftPreview(null);
              void refresh();
            } else if (payload.type === 'workspace.updated') {
              void refresh();
              // push 里已经带了版本号时直接用，省掉一次往返。
              if (Number.isInteger(payload.liveModelVersion)) lastLiveVersionRef.current = payload.liveModelVersion;
            }
          } catch {
            /* ignore */
          }
        };
      } catch {
        /* fallback to timer */
      }
    }
    setFallbackInterval(4000);
    return () => {
      cancelled = true;
      if (pollTimer !== null) window.clearInterval(pollTimer);
      if (es) es.close();
    };
    // 故意**不含 version**：version 每提交一条命令就 +1，放进依赖会让 EventSource
    // 每次编辑都重建并让服务端重跑全量快照。version 的读取需求见 versionRef。
    // pushAgentEvent 是 useCallback([]) 的稳定引用，放进来不会引起重建。
  }, [token, pushAgentEvent]);

  /**
   * 最新 version 的 ref。SSE 的 effect 不能依赖 version（见上），
   * 但回调里偶发需要读到"此刻"的总线版本时从这里取，而不是靠闭包快照。
   */
  const versionRef = useRef(version);
  versionRef.current = version;

  /**
   * 本地模型一变只重算 `differs`（"网页/服务器不同步"角标与同步按钮的开关）。
   * **纯本地计算，不打 API** —— 这一点很关键：
   * 原先这个角标靠 SSE effect 依赖 version 顺带刷新，去掉依赖后如果什么都不做，
   * 用户改完模型最多要等 30s 兜底轮询才看得到同步按钮，那是明显的体感退化。
   */
  useEffect(() => {
    const serverFingerprint = lastServerProjectFingerprintRef.current;
    if (serverFingerprint === null) return;
    const nextDiffers = stableProjectJson(bus.getState()) !== serverFingerprint;
    setRemoteWorkspaceStatus((previous) => {
      if (!previous || previous.differs === nextDiffers) return previous;
      return { ...previous, differs: nextDiffers };
    });
    // versionRef 只是为了让这条依赖显式化：真正变化的是 version。
  }, [version]);

  /**
   * 退出登录只有这一份实现（顶栏按钮与账号面板那个共用）。
   * 曾经 AccountPanel 里也写了一遍，结果顶栏再加一个按钮就意味着两处逻辑
   * 要同步改 —— 而"改了一处、忘了另一处"是不会报错的。
   */
  const doLogout = useCallback(() => {
    void (async () => {
      if (token) {
        const r = await api('/api/auth/logout', { method: 'POST', token });
        // 服务端拒绝也要退出来：本地会话清掉以后，剩下的只有服务端那条记录，
        // 让用户卡在一个"本地已登出、界面还当已登录"的状态更糟
        if (!r.ok) toast('warn', `服务端未确认登出（${r.error ?? r.status}），本地会话已清除`);
      }
      setToken(null);
      toast('ok', '已退出登录');
    })();
  }, [token, setToken]);

  // ── 本地草稿 ──
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /**
   * 启动时恢复草稿。
   *
   * 放在自动保存 effect **之前**声明不是随意的：mount 时两个 effect 按声明序执行，
   * 恢复先把旧项目装回总线，随后自动保存才会以恢复后的项目为准 ——
   * 否则第一次自动保存会把默认示例项目写回去，把真草稿冲掉。
   *
   * 恢复采用「直接回来 + 气泡告知」而不是弹窗询问：用户上一句话是
   * "现在刷新就丢，等于没法真正用" —— 恢复是默认期望，丢弃才需要用户主动做
   * （命令行 NEW）。弹窗在自动化验收与日常使用里都是噪音。
   */
  useEffect(() => {
    const d = loadDraft();
    if (!d) return;
    hasLocalDraftRef.current = true;
    const activeIdentityLock = bus.getUnitIdentityConflict();
    if (d.identityConflict || activeIdentityLock) {
      bus.loadProjectReadOnly(d.project);
      setSavedAt(d.savedAt);
      toast('warn', d.identityConflict ?? activeIdentityLock ?? '项目身份冲突锁定；当前草稿仅以只读方式恢复。');
      return;
    }
    bus.replaceProject(d.project, `恢复本地草稿（${fmtSavedAt(d.savedAt)}）`);
    setSavedAt(d.savedAt);
    toast(
      'info',
      `已恢复上次草稿「${d.project.name}」：${d.project.rooms.length} 房间 / ${d.project.cabinets.length} 柜体（保存于 ${fmtSavedAt(d.savedAt)}）。想要全新项目，按 \` 打开命令行输入 NEW`,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 房间上下文按 projectId + roomId 持久化。无效上下文时留在当前项目并要求重选，绝不静默切首房间。
  useEffect(() => {
    const project = bus.getState();
    if (!workspaceContextValidatedRef.current) {
      workspaceContextValidatedRef.current = true;
      if (workspaceContextSeed) {
        if (workspaceContextSeed.projectId && workspaceContextSeed.projectId !== project.id) {
          setWorkspaceRoomId('');
          setWorkspaceContextNotice('上次选择的房间属于另一个项目。当前项目未更改，请从左侧房间列表重新选择。');
          return;
        }
        if (!workspaceGroupExists(project, workspaceContextSeed.roomId)) {
          setWorkspaceRoomId('');
          setWorkspaceContextNotice('上次选择的房间已不存在。当前项目未更改，请从左侧房间列表重新选择。');
          return;
        }
        setWorkspaceProjectId(project.id);
        setWorkspaceRoomId(workspaceContextSeed.roomId);
        setWorkspaceContextNotice('');
        return;
      }
      const firstRoomId = indexProjectRooms(project).find((group) => !group.unassigned)?.room.id ?? '';
      setWorkspaceProjectId(project.id);
      setWorkspaceRoomId(firstRoomId);
      setWorkspaceContextNotice('');
      return;
    }
    if (workspaceProjectId && workspaceProjectId !== project.id) {
      setWorkspaceRoomId('');
      setWorkspaceContextNotice('当前项目与已保存的房间上下文不一致。项目未切换，请从左侧房间列表重新选择。');
      return;
    }
    if (workspaceRoomId && !workspaceGroupExists(project, workspaceRoomId)) {
      setWorkspaceRoomId('');
      setWorkspaceContextNotice('当前房间已不存在。项目未切换，请从左侧房间列表重新选择。');
      return;
    }
    if (!workspaceProjectId && project.id) setWorkspaceProjectId(project.id);
  }, [version, workspaceRoomId, workspaceProjectId, workspaceContextSeed]);

  useEffect(() => {
    try {
      if (unitIdentityReadOnly || hasStoredDuplicateUnitIds() || bus.getUnitIdentityConflict()) return;
      const projectId = bus.getState().id;
      if (!workspaceRoomId || !workspaceProjectId || workspaceProjectId !== projectId || !workspaceGroupExists(bus.getState(), workspaceRoomId)) return;
      localStorage.setItem(WORKSPACE_CONTEXT_STORAGE_KEY, JSON.stringify({ projectId: workspaceProjectId, roomId: workspaceRoomId }));
      localStorage.removeItem(LEGACY_WORKSPACE_ROOM_ID_STORAGE_KEY);
    } catch { /* localStorage may be unavailable */ }
  }, [workspaceProjectId, workspaceRoomId, unitIdentityReadOnly]);

  // 模型一变就排一次自动保存（去抖 800ms：连拖几个夹点只写一次）
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (unitIdentityReadOnlyRef.current || bus.getUnitIdentityConflict() || hasStoredDuplicateUnitIds()) return;
      // toFileSnapshot()：保存出口物化落位 provenance（内存模型不带，见 CommandBus.toFileSnapshot）
      const at = saveDraft(bus.toFileSnapshot());
      if (at) setSavedAt(at);
      // 存不进去（隐私模式 / 超配额）就不更新时间 —— 界面不说"已保存"的谎
    }, 800);
    return () => window.clearTimeout(t);
  }, [version]);

  // 关标签页前把没来得及去抖的那份冲进 localStorage
  useEffect(() => {
    const flush = () => {
      if (bus.getUnitIdentityConflict() || hasStoredDuplicateUnitIds()) return;
      saveDraft(bus.toFileSnapshot());
    };
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, []);

  // ── 右键上下文菜单（Task #24）──
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const onViewportContextMenu = useCallback(
    (p: { x: number; y: number }) => {
      // 有命令进行中（画墙画到一半 / 移动等第二点 / 其它工具）时，右键 = 取消，不弹菜单 —— 与 Esc 同义
      if (tool !== 'select' || pendingMove) {
        setTool('select');
        setPendingMove(null);
        setCancelSignal((v) => v + 1);
        setCtxMenu(null);
        return;
      }
      setCtxMenu(p);
    },
    [tool, pendingMove]
  );

  // ── 提示气泡 ──
  const toast = useCallback((kind: ToastKind, text: string) => {
    const id = nextToastId();
    setToasts((t) => [...t, { id, kind, text }].slice(-4));
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);

  // ── 唯一的"改模型"入口 ──
  /**
   * 命令执行之后的**统一**收尾：记忆拦截记录 / ERROR 提示 / 钳制提示 / 行内消息。
   *
   * 抽出来的原因（一次真实缺陷）：
   * 命令行的 Command JSON 通道（AI / MCP 走这条）原先自己写了一遍失败处理，
   * 直接调 bus.execute —— 于是**记忆拦下 AI 命令时不记 lastHit**，
   * 「最近一次拦截」在记忆面板上永远是空的。
   * 而"AI 下次不要再犯同样的错误"正是这条记忆最该留下痕迹的场景。
   *
   * 现在四条路（鼠标 / 命令行字母 / Command JSON / MCP）都收敛到这一个函数，
   * 失败处理只有一份实现，"某条路少做了一步"这类缺陷在结构上不再可能。
   */
  const afterExec = useCallback(
    (cmd: Command, r: ExecResult): boolean => {
      if (!r.ok) {
        if (r.memoryHits.length > 0) {
          const h = r.memoryHits[0];
          noteHit(h.correctionId, cmd.label ?? cmd.op, h.message);
          toast('error', r.error ?? '被记忆拦住');
        } else {
          toast('error', r.error ?? '操作被拒绝');
        }
        setLastMsg(r.error ?? '操作被拒绝');
        return false;
      }
      const errs = r.newIssues.filter((i) => i.severity === 'ERROR');
      if (errs.length > 0) {
        toast('warn', `已应用，但新增 ${errs.length} 条 ERROR：${errs[0].message}`);
      }
      if (r.clamped.length > 0) toast('info', r.clamped[0]);
      setLastMsg(cmd.label ?? cmd.op);
      return true;
    },
    [toast]
  );

  const run = useCallback(
    (cmd: Command): boolean => {
      if (unitIdentityReadOnly) {
        toast('warn', '历史重复 Unit ID 项目处于只读浏览模式；须显式修复/迁移后才能写入。');
        return false;
      }
      return afterExec(cmd, bus.execute(cmd, { commitLabel: cmd.label }));
    },
    [afterExec, toast, unitIdentityReadOnly]
  );

  /**
   * 一键修复：把报错自带的修复计划还原成一条命令走总线。
   *
   * 走总线而不是直接改模型，是为了让修复和手动编辑**同权同位**：
   * 同样是一次撤销、同样过记忆闸门、同样记进审计。
   * 修复后的副作用通过 toast 如实交代（"抽屉会浅 40mm"这类）。
   */
  const applyFix = useCallback(
    (i: Issue): boolean => {
      if (unitIdentityReadOnly) {
        toast('warn', '历史重复 Unit ID 项目处于只读浏览模式；须显式修复/迁移后才能写入。');
        return false;
      }
      const plan = i.autoFix;
      if (!plan) {
        toast('warn', '这条只能你来定：没有唯一的修法，系统不替你选。');
        return false;
      }
      const cmd: Command = {
        ...plan,
        id: newCommandId(plan.op),
        source: 'ui',
      } as Command;
      const r = bus.execute(cmd, { commitLabel: cmd.label });
      if (!r.ok) {
        toast('error', `没能自动修：${r.error ?? '这个改动被总线拒绝了'}`);
        setLastMsg(r.error ?? '没能自动修');
        return false;
      }
      toast('info', `${plan.label} —— ${plan.note}`);
      setLastMsg(plan.label);
      return true;
    },
    [bus, toast, setLastMsg, unitIdentityReadOnly]
  );

  // ── 撤销 / 重做 ──
  const doUndo = useCallback(() => {
    if (unitIdentityReadOnlyRef.current) {
      toast('warn', '历史重复 Unit ID 项目只读；撤销/重做写入已禁用。');
      return;
    }
    const identityConflict = bus.getUnitIdentityConflict();
    if (identityConflict) toast('error', identityConflict);
    else if (!bus.undo()) toast('info', '没有可撤销的操作');
    setPendingMove(null);
  }, [toast]);
  const doRedo = useCallback(() => {
    if (unitIdentityReadOnlyRef.current) {
      toast('warn', '历史重复 Unit ID 项目只读；撤销/重做写入已禁用。');
      return;
    }
    const identityConflict = bus.getUnitIdentityConflict();
    if (identityConflict) toast('error', identityConflict);
    else if (!bus.redo()) toast('info', '没有可重做的操作');
  }, [toast]);

  // ── 视图模式：切换时清掉旧选择和编辑态，避免后续操作误指向离开的对象 ──
  /**
   * 普通视图切换会清空旧选择；只有流程明确指定新目标时才保留该目标。
   */
  const selectionOnModeChange = useRef<string[] | null>(null);

  const setMode = useCallback((m: 'plan' | 'sheet' | '3d') => {
    setModeRaw(m);
  }, []);

  /** 分解图开关。打开时顺带切到图幅 —— 分解图只在图幅里有意义 */
  const setExplode = useCallback((v: boolean) => {
    setExplodeRaw(v);
    if (v) setModeRaw('sheet');
  }, []);

  /**
   * 切模式时默认清空选择；只有流程显式指定的新目标才由下面这个 ref 保留。
   *
   * 为什么需要它（一次真实缺陷）：采用方案后要 `setSelection([新柜体id])` + `setMode('sheet')`，
   * 两条 setState 在同一批里提交，随后这个 effect 因为 mode 变了而跑起来，
   * 把刚设上去的选中又清成空 —— 于是"采用后新柜体是选中的"这件事静默失效。
   * 这类缺陷在只比对文本的断言里看不见：界面上什么都没报错，只是选中没了。
   */
  useEffect(() => {
    setTool('select');
    setPendingMove(null);
    setSelection(selectionOnModeChange.current ?? []);
    selectionOnModeChange.current = null; // 只在切换这一次生效
    // 复用 Esc 的取消通道，让视口自己把 draft / drag / preview / grip / readout 一起清掉。
    // 不这么做的话，从「画墙画到一半」切到四视图，草稿墙会跟着画到图幅上。
    setCancelSignal((v) => v + 1);
  }, [mode]);

  // ── 选择集随模型收敛（撤销后可能指向已不存在的对象）──
  useEffect(() => {
    const p = bus.getState();
    setSelection((prev) => {
      const next = prev.filter(
        (id) => p.cabinets.some((c) => c.id === id) || p.rooms.some((r) => r.walls.some((w) => w.id === id))
      );
      return next.length === prev.length ? prev : next;
    });
  }, [version]);

  // ── P6 修改观察：每次命令落账后，从命令日志提取有限语义事实 → 知识候选 ──
  // 只观察、不升级：candidate 永远等用户在知识面板确认（观察 ≠ 偏好）。
  const observedSeqRef = useRef(0);
  useEffect(() => {
    const log = bus.log();
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i]!;
      if (e.seq <= observedSeqRef.current) break;
      // 撤销/重做/被丢弃的分支不是新事实
      if (!e.applied || e.command.source === 'system') continue;
      const cab = e.command.target?.kind === 'cabinet' ? bus.getState().cabinets.find((c) => c.id === e.command.target?.id) : undefined;
      // 落位上下文（P8.4）：朝向类观察必须带"发生在哪一类情形里"，拿不到就不观察
      const pCtx = cab ? placementContextOf(bus.getState(), cab.id) : null;
      const prov = e.placementProvenance;
      const authority = Array.isArray(prov) ? prov[0]?.authority : prov?.authority;
      for (const obs of observeCommand(e.command, e.diff, cab?.name, pCtx, authority)) {
        saveKnowledge(recordObservation(loadKnowledge(), obs));
      }
    }
    if (log.length > 0) observedSeqRef.current = Math.max(observedSeqRef.current, log[log.length - 1]!.seq);
  }, [version]);

  // ── 工具动作 ──
  const onPlaceCabinet = useCallback(
    (p: Vec2) => {
      const project = bus.getState();
      if (project.rooms.length === 0) {
        toast('info', '还没有房间，先在工具栏点「+ 房间」，或直接用「画墙」工具画一面墙（会自动建房间）');
        return;
      }
      // 柜型预设：外形尺寸来自模板（鞋柜浅进深 / 吊柜矮 / 电视柜宽矮），
      // 分区骨架由模板声明、经 docFactory 唯一构造点落地 —— UI 不自己拼 UnitSpec
      const tpl = CABINET_TEMPLATES.find((t) => t.id === templateId) ?? CABINET_TEMPLATES[0]!;
      const placed = placeAgainstNearestWall(project, p, tpl.params.width);
      // 柜体必须归属"吸附到的那面墙所在的房间"，否则会出现跨房间归属混乱
      const ownerRoom =
        project.rooms.find((r) => placed.wallId && r.walls.some((w) => w.id === placed.wallId)) ?? project.rooms[0];
      const cab = createCabinetFromTemplate({
        templateId: tpl.id,
        name: `${tpl.name} ${project.cabinets.length + 1}`,
        roomId: ownerRoom.id,
        x: placed.x,
        y: placed.y,
        rotation: placed.rotation,
        rules: bus.getRules(),
        takenIds: project.cabinets.map((c) => c.id),
        takenUnitIds: projectUnitIds(project),
      });
      if (run(CMD.createCabinet(cab))) {
        setTool('select');
        setSelection([cab.id]);
        setRightTab('props');
        setLastMsg(
          placed.wallId
            ? `已贴「${placed.wallName}」放置（距离 ${placed.distance}mm，旋转 ${placed.rotation}°）`
            : '已放置（未找到附近墙体，按原始点放置）'
        );
      }
    },
    [run, templateId, toast]
  );

  const onCreateWall = useCallback(
    (a: Vec2, b: Vec2) => {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1) {
        toast('warn', '墙长为 0，已忽略');
        return;
      }
      const project = bus.getState();
      const used = project.rooms.flatMap((r) => r.walls.map((w) => w.id));
      const wall = makeWall({
        name: `墙 ${used.length + 1}`,
        start: a,
        end: b,
        thickness: DEFAULT_WALL_THICKNESS,
        height: DEFAULT_WALL_HEIGHT,
        takenIds: used,
      });
      if (run(CMD.drawWall(wall))) {
        setLastMsg(`已画墙 ${Math.round(len)}mm（厚 ${DEFAULT_WALL_THICKNESS}mm）`);
      }
    },
    [run, toast]
  );

  /**
   * 「+ 房间」**不再当场造一个房间出来**。
   *
   * 旧做法：点一下就在列表里并排多出一张默认卡片 —— 名字没填、尺寸没定，
   * 跟已有房间混在一起，房间一多根本分不清哪个是新加的。
   * 现在：切到房间页并打开**独立的「新建房间」表单页**，填好确认后才真的建。
   */
  const onNewRoom = useCallback(() => {
    if (unitIdentityReadOnly) return;
    setRightTab('rooms');
    setRoomsView('new');
  }, [unitIdentityReadOnly]);

  /** 房间真被创建出来之后：立即切换上下文、聚焦新房间并返回列表 */
  const onRoomCreated = useCallback((roomId?: string) => {
    if (roomId) {
      setWorkspaceProjectId(bus.getState().id);
      setWorkspaceRoomId(roomId);
      setWorkspaceContextNotice('');
      setFocusRoom((prev) => ({ id: roomId, sig: prev.sig + 1 }));
    }
    setTool('select');
    setMode('plan');
    setFitSignal((v) => v + 1);
    setRoomsView('list');
  }, [setMode, setTool]);

  /** 聚焦某个房间：切到平面图并把视口缩放到该房间包围盒 */
  const focusRoomById = useCallback((id: string) => {
    setMode('plan');
    setFocusRoom((prev) => ({ id, sig: prev.sig + 1 }));
  }, [setMode]);

  // ── 选中对象操作 ──
  const selectedCabs = useCallback(() => bus.getState().cabinets.filter((c) => selection.includes(c.id)), [selection]);
  const selectedWalls = useCallback(
    () => bus.getState().rooms.flatMap((r) => r.walls.filter((w) => selection.includes(w.id))),
    [selection]
  );

  const onDelete = useCallback(() => {
    const cabs = selectedCabs();
    const walls = selectedWalls();
    const project = bus.getState();
    const editIds = selection.map(editIdFromSelection).filter((id): id is string => Boolean(id));
    const sourceKeys = selection.map(sourceKeyFromSelection).filter((key): key is string => Boolean(key));
    if (cabs.length === 0 && walls.length === 0 && editIds.length === 0 && sourceKeys.length === 0) {
      toast('info', '没有选中任何可删除的对象');
      return;
    }
    let count = 0;
    if (editIds.length || sourceKeys.length) {
      const next = (project.drawingEdits ?? []).filter(e => !editIds.includes(e.id));
      const geom = bus.derive().geom;
      for (const key of sourceKeys) {
        const planIndex = geom.planSourceKeys.indexOf(key);
        const sheetIndex = geom.views.sourceKeys.indexOf(key);
        const prim = planIndex >= 0 ? geom.plan[planIndex] : sheetIndex >= 0 ? geom.views.prims[sheetIndex] : undefined;
        if (!prim) continue;
        const parts = key.split(':');
        const meta = parts[0] === 'sheet' ? { cabinetId: parts[1], view: parts[2] as DrawingView } : {};
        const suppression = sourceOverride(key, prim, parts[0] === 'sheet' ? 'sheet' : 'plan', newCommandId('edit'), meta);
        if (!suppression) continue;
        next.push({ ...suppression, points: [] });
      }
      if (run(replaceDrawingEdits(project, next, '删除二维图元'))) count += editIds.length + sourceKeys.length;
    }
    for (const c of cabs) if (run(CMD.deleteCabinet(c))) count++;
    for (const w of walls) if (run(CMD.deleteWall(w.id, w.name))) count++;
    if (count > 0) {
      setSelection([]);
      toast('ok', `已删除 ${count} 个对象（可撤销）`);
    }
  }, [bus, run, selection, selectedCabs, selectedWalls, toast]);

  const onDuplicate = useCallback(() => {
    const cabs = selectedCabs();
    const project = bus.getState();
    const editIds = selection.map(editIdFromSelection).filter((id): id is string => Boolean(id));
    const sourceKeys = selection.map(sourceKeyFromSelection).filter((key): key is string => Boolean(key));
    if (cabs.length === 0 && editIds.length === 0 && sourceKeys.length === 0) {
      toast('info', '请先选中柜体或二维图元');
      return;
    }
    const created: string[] = [];
    if (editIds.length || sourceKeys.length) {
      const next = [...(project.drawingEdits ?? [])];
      for (const id of editIds) {
        const entity = next.find(e => e.id === id);
        if (entity) {
          const clone = translateDrawingEntity(entity, 400, 0, newCommandId('edit'));
          next.push({ ...clone, provenance: 'manual', replacesSource: undefined });
          created.push(editSelectionId(clone.id));
        }
      }
      const geom = bus.derive().geom;
      for (const key of sourceKeys) {
        const pi = geom.planSourceKeys.indexOf(key), si = geom.views.sourceKeys.indexOf(key);
        const prim = pi >= 0 ? geom.plan[pi] : si >= 0 ? geom.views.prims[si] : undefined;
        if (!prim) continue;
        const parts = key.split(':');
        const meta = parts[0] === 'sheet' ? { cabinetId: parts[1], view: parts[2] as DrawingView } : {};
        const base = sourceOverride(key, prim, parts[0] === 'sheet' ? 'sheet' : 'plan', newCommandId('edit'), meta);
        if (!base) continue;
        const clone = translateDrawingEntity({ ...base, provenance: 'manual', replacesSource: undefined }, 400, 0);
        next.push(clone); created.push(editSelectionId(clone.id));
      }
      if (next.length !== (project.drawingEdits ?? []).length) run(replaceDrawingEdits(project, next, '复制二维图元'));
    }
    for (const c of cabs) {
      const before = bus.getState();
      if (run(CMD.duplicateCabinet(c, 700 + before.cabinets.length * 20))) {
        const after = bus.getState();
        const nid = after.cabinets[after.cabinets.length - 1]?.id;
        if (nid && nid !== c.id) created.push(nid);
      }
    }
    if (created.length > 0) setSelection(created);
  }, [bus, run, selection, selectedCabs, toast]);

  const onRotate90 = useCallback(() => {
    const cabs = selectedCabs();
    if (cabs.length === 0) {
      toast('info', '请先选中柜体');
      return;
    }
    for (const c of cabs) {
      let next = (c.placement.rotation + 90) % 360;
      if (next > 180) next -= 360;
      run(CMD.rotateCabinet(c, next));
    }
  }, [run, selectedCabs, toast]);

  /** MI 镜像：语义化 = 分区左右反序。单分区被总线拒绝时 afterExec 统一报原因 */
  const onMirror = useCallback(() => {
    const cabs = selectedCabs();
    if (cabs.length === 0) {
      toast('info', '请先选中柜体');
      return;
    }
    for (const c of cabs) run(CMD.mirrorCabinet(c));
  }, [run, selectedCabs, toast]);

  const onMovePick = useCallback(
    (p: Vec2) => {
      if (!pendingMove) return;
      if (!pendingMove.base) {
        setPendingMove({ base: p });
        setLastMsg(`基点已定 (${p.x}, ${p.y})，请指定第二点`);
        return;
      }
      const dx = p.x - pendingMove.base.x;
      const dy = p.y - pendingMove.base.y;
      setPendingMove(null);
      const cabs = selectedCabs();
      if (cabs.length === 0) {
        toast('warn', '选中的对象已不存在，移动取消');
        return;
      }
      if (dx === 0 && dy === 0) {
        setLastMsg('位移为 0，未产生变更');
        return;
      }
      run(CMD.moveCabinetBatch(cabs, bus.getState().cabinets, dx, dy));
    },
    [pendingMove, run, selectedCabs, toast]
  );

  const startMove = useCallback(() => {
    const cabs = selectedCabs();
    if (cabs.length === 0) {
      toast('info', '请先选中柜体，再执行移动');
      return;
    }
    setTool('select');
    setPendingMove({ base: null });
    setLastMsg('指定基点');
  }, [selectedCabs, toast]);

  // ── 四视图点选部件（Task #25 A 组）──
  const onPickPart = useCallback(
    (pl: PickLine) => {
      const cab = bus.getState().cabinets.find((c) => c.id === pl.cabinetId);
      setSelection([pl.cabinetId]);
      setLastMsg(`点选部件：${cab?.name ?? pl.cabinetId} · ${pl.labelZh} · ${pl.paramPath}`);
      toast('info', `这是「${cab?.name ?? pl.cabinetId}」的${pl.labelZh} —— 由参数 ${pl.paramPath} 决定。改参数请到属性面板，或让 AI 改（会先干跑预览）`);
    },
    [toast]
  );

  // ── 命令行解释器 ──
  const runText = useCallback(
    (raw: string): string | null => {
      const text = raw.trim();
      if (!text) return null;
      if (unitIdentityReadOnlyRef.current) {
        const command = text.split(/\s+/u)[0]?.toUpperCase() ?? '';
        const viewOnlyCommands = new Set(['HELP', 'ZE', 'Z', 'VIEWS', 'VV', '4V', 'AI', 'ACCT', 'ACCOUNT', 'EXPLODE', 'EXP', 'PLAN', 'PL', '3D', 'V3D', 'GRID', 'SNAP', 'ORTHO', 'DUMP', 'SAVE', 'QSAVE']);
        if (text.startsWith('{') || !viewOnlyCommands.has(command)) {
          return '历史重复 Unit ID 项目处于只读浏览模式；写入命令已禁用，需显式修复/迁移后恢复。';
        }
      }

      // ① AI / 外部通道：直接吃 Command JSON
      if (text.startsWith('{')) {
        try {
          const obj = JSON.parse(text) as Partial<Command>;
          if (!obj.op) throw new Error('缺少 op 字段');
          const cmd: Command = {
            id: obj.id ?? `cmd_ext_${Date.now().toString(36)}`,
            op: String(obj.op),
            source: obj.source ?? 'mcp',
            target: obj.target,
            changes: obj.changes ?? [],
            payload: obj.payload,
            label: obj.label ?? `外部指令 ${obj.op}`,
            intent: obj.intent,
          };
          // 走同一条收尾（含记忆拦截记录）—— AI 通道不许有自己的一套失败处理
          const r = bus.execute(cmd, { commitLabel: cmd.label });
          const ok = afterExec(cmd, r);
          if (ok) {
            setRightTab('history');
            toast('ok', `已执行 ${cmd.op}，${r.diff.length} 处变更（与鼠标操作走同一条路径）`);
            return null;
          }
          return r.error ?? '命令被拒绝';
        } catch (e) {
          const m = (e as Error).message;
          toast('error', `JSON 解析失败：${m}`);
          return m;
        }
      }

      const parts = text.split(/\s+/);
      const head = parts[0].toUpperCase();
      const arg = parts[1] ?? '';
      const num = Number(arg);
      const cabs = selectedCabs();

      const needCab = (): boolean => {
        if (cabs.length === 0) {
          toast('info', `${head} 需要先选中柜体`);
          return false;
        }
        return true;
      };

      switch (head) {
        case 'HELP':
        case '?':
        case '帮助':
          return '见下方命令列表';
        case 'L':
        case 'WALL':
          setTool('wall');
          setLastMsg('画墙：点起点，再点终点');
          return null;
        case 'CAB':
        case 'C':
          setTool('cabinet');
          setLastMsg('放柜体：在墙上点一下会自动贴墙');
          return null;
        // ── TPL：柜型预设切换。裸 TPL 列出全部，TPL <id> 切换当前放置柜型 ──
        // 与工具栏下拉共用 templateId 状态，四条通道同权同位。
        case 'TPL':
        case 'TEMPLATE': {
          if (!arg) {
            const list = CABINET_TEMPLATES.map((t) => `${t.id === templateId ? '▶' : '　'}${t.id}（${t.name}，${t.params.width}×${t.params.height}×${t.params.depth}）`);
            return [`当前柜型：${CABINET_TEMPLATES.find((t) => t.id === templateId)?.name ?? templateId}`, ...list].join('\n');
          }
          const tpl = CABINET_TEMPLATES.find((t) => t.id === arg.toLowerCase() || t.name === arg);
          if (!tpl) {
            return `未知柜型「${arg}」—— 可用：${CABINET_TEMPLATES.map((t) => t.id).join('、')}`;
          }
          setTemplateId(tpl.id);
          setLastMsg(`放置柜型已切到「${tpl.name}」`);
          return `放置柜型已切到「${tpl.name}」：${tpl.hint}`;
        }
        case 'S':
        case 'SELECT':
          setTool('select');
          return null;
        case 'M':
        case 'MOVE':
          startMove();
          return null;
        case 'CO':
        case 'COPY':
          onDuplicate();
          return null;
        case 'RO':
        case 'ROTATE':
          onRotate90();
          return null;
        case 'MI':
        case 'MIRROR':
          onMirror();
          return null;
        // ── O / TR / EX：AutoCAD 习惯键位，但语义模型里没有线条可操作 ──
        // 诚实拒绝 + 指路，不做"假装支持"：偏移一条不存在的线是违背
        // "严禁改线条"铁律的空壳功能。用户敲了别名至少要知道去哪。
        case 'O':
        case 'OFFSET':
          toast('info', '语义模型没有线条可偏移 —— 改柜宽用属性面板或 WIDTH；离墙距离用移动（M）');
          return null;
        case 'TR':
        case 'TRIM':
          toast('info', '语义模型没有线条可修剪 —— 改分区宽在属性面板拖分区夹点，或让 AI 改 requestedWidth');
          return null;
        case 'EX':
        case 'EXTEND':
          toast('info', '语义模型没有线条可延伸 —— 柜高顶到墙用属性面板改 height，加分区用 addUnit');
          return null;
        case 'E':
        case 'DEL':
        case 'ERASE':
          onDelete();
          return null;
        case 'U':
        case 'UNDO':
          doUndo();
          return null;
        case 'REDO':
          doRedo();
          return null;
        case 'ZE':
        case 'Z':
          setFitSignal((v) => v + 1);
          return '已缩放到图幅';
        case 'VIEWS':
        case 'VV':
        case '4V': {
          setMode('sheet');
          setRightTab('views');
          const g = bus.derive().geom;
          return `已切到图纸视图（俯视 / 正视 / 内部）：${g.views.prims.length} 个图元 / ${bus.getState().cabinets.length} 个柜体 / ${g.views.assumptions.length} 条派生假设（均为同一份模型投影派生）`;
        }
        case 'AI':
          setRightTab('ai');
          return arg ? '请在上方「AI 规划」输入框里说这句话（那里才有干跑预览与逐条应用）' : '已打开 AI 面板';
        case 'ACCT':
        case 'ACCOUNT':
          setRightTab('account');
          return '已打开「账号与安全」';
        case 'EXPLODE':
        case 'EXP': {
          if (arg.toUpperCase() === 'OFF' || arg === '0') {
            setExplode(false);
            return '分解图已关闭（图纸视图仍可看）';
          }
          setExplode(true);
          const e = bus.deriveExplode(true);
          const warn = e.check.ok ? '' : `　⚠ ${e.check.unplaced.length} 类板件摆不出来`;
          return `已生成分解图：${e.check.cabinets} 个柜体 / 清单 ${e.check.panelKinds} 种 ${e.check.pieces} 件 / 图上 ${e.check.instances} 件 / ${e.check.drawnNos} 个件号${warn}`;
        }
        case 'PLAN':
        case 'PL':
          setMode('plan');
          return '已切回平面图（房间与柜体落位）';
        case '3D':
        case 'V3D':
          setMode('3d');
          return '已切到 3D 视图（只读体块预览：拖动旋转 / 点击选中）';
        case 'GRID':
          setShowGrid((v) => !v);
          return null;
        case 'SNAP':
          setSnap((s) => ({ ...s, enabled: !s.enabled }));
          return null;
        case 'ORTHO':
          setSnap((s) => ({ ...s, ortho: !s.ortho, polar: s.ortho ? s.polar : false }));
          return null;
        case 'ROOM':
          onNewRoom();
          return null;
        case 'W':
        case 'WIDTH': {
          if (!needCab()) return '需要先选中柜体';
          const delta = /^[+-]/.test(arg);
          const v = Number(arg.replace(/[+-]/, ''));
          if (!Number.isFinite(v)) return '用法：W 2400 或 W+100 / W-100';
          for (const c of cabs) run(CMD.resizeCabinet(c, { width: delta ? c.params.width + v * (arg.startsWith('-') ? -1 : 1) : v }));
          return null;
        }
        case 'H':
        case 'HEIGHT': {
          if (!needCab()) return '需要先选中柜体';
          if (!Number.isFinite(num)) return '用法：H 2200';
          for (const c of cabs) run(CMD.resizeCabinet(c, { height: num }));
          return null;
        }
        case 'D':
        case 'DEPTH': {
          if (!needCab()) return '需要先选中柜体';
          if (!Number.isFinite(num)) return '用法：D 600';
          for (const c of cabs) run(CMD.resizeCabinet(c, { depth: num }));
          return null;
        }
        case 'N':
        case 'NUDGE': {
          if (!needCab()) return '需要先选中柜体';
          const d = Number(arg);
          if (!Number.isFinite(d)) return '用法：N 100（沿 +X 平移）';
          for (const c of cabs) run(CMD.nudgeCabinet(c, d, 0));
          return null;
        }
        case 'DUMP': {
          const json = JSON.stringify(bus.getState(), null, 2);
          // eslint-disable-next-line no-console
          console.log('[model.json]', json);
          toast('info', `已把模型 JSON 打印到控制台（${json.length} 字符）—— 这就是唯一的真相源`);
          return '已输出到控制台';
        }
        case 'SAVE':
        case 'QSAVE':
          setRightTab('export');
          return savedAt
            ? `草稿已自动保存于 ${fmtSavedAt(savedAt)}。要拿走文件，「导出」页签 → 项目存档 → 存为 .json`
            : '草稿还没存过 —— 已打开「导出」页签，从项目存档导出 .json';
        case 'NEW': {
          try {
            bus.replaceProject(sampleProject(RULESET), '新建项目');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast('error', message);
            return message;
          }
          clearDraft();
          setSelection([]);
          setFitSignal((v) => v + 1);
          toast('ok', '已新建项目（草稿已清空，之前的模型可在历史里找回）');
          return '已新建项目';
        }
        default:
          toast('warn', `未知命令：${head}（输入 HELP 查看）`);
          return `未知命令：${head}`;
      }
    },
    [afterExec, doRedo, doUndo, onDelete, onDuplicate, onMirror, onNewRoom, onRotate90, run, savedAt, selectedCabs, setExplode, setMode, startMove, templateId, toast]
  );

  // ── 键盘 ──
  useEffect(() => {
    const isTyping = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey;
      if (unitIdentityReadOnlyRef.current && !isTyping(e.target)
        && ((mod && ['z', 'y', 'd'].includes(e.key.toLowerCase())) || (!mod && ['Delete', 'e', 'E', 'm', 'M'].includes(e.key)))) {
        toast('warn', '历史重复 Unit ID 项目只读；CAD 写操作快捷键已禁用。');
        e.preventDefault();
        return;
      }

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        doRedo();
        return;
      }
      if (mod && e.key === '1') {
        e.preventDefault();
        setRightTab('props');
        return;
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        onDuplicate();
        return;
      }

      // 下面这些键在输入框里不应该生效
      if (isTyping(e.target)) return;
      if (mod || e.altKey) return;

      switch (e.key) {
        case 'Escape':
          setPendingMove(null);
          setCancelSignal((v) => v + 1);
          setSelection([]);
          setTool('select');
          break;
        case 'Delete':
        case 'e':
        case 'E':
          e.preventDefault();
          onDelete();
          break;
        case 'm':
        case 'M':
          e.preventDefault();
          startMove();
          break;
        case 'l':
        case 'L':
          setTool('wall');
          break;
        case 'c':
        case 'C':
          setTool('cabinet');
          break;
        case 's':
        case 'S':
          setTool('select');
          break;
        case 'F3':
          e.preventDefault();
          setSnap((s) => ({ ...s, enabled: !s.enabled }));
          break;
        case 'F7':
          e.preventDefault();
          setShowGrid((v) => !v);
          break;
        case 'F8':
          e.preventDefault();
          setSnap((s) => ({ ...s, ortho: !s.ortho, polar: s.ortho ? s.polar : false }));
          break;
        case 'F9':
          e.preventDefault();
          setSnap((s) => ({ ...s, gridSnap: !s.gridSnap }));
          break;
        case 'F4':
          e.preventDefault();
          setMode(mode === 'plan' ? 'sheet' : 'plan');
          break;
        case 'Home':
          e.preventDefault();
          setFitSignal((v) => v + 1);
          break;
        case '`':
          e.preventDefault();
          setCmdOpen((v) => !v);
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doRedo, doUndo, onDelete, onDuplicate, setMode, startMove, mode]);

  const issues = bus.issues();
  const errCount = issues.filter((i) => i.severity === 'ERROR').length;
  const projectRooms = bus.getState().rooms.length;

  // ── 右键菜单项：按「当前选中了什么」算 —— 选中态不同，菜单就不同 ──
  const buildCtxItems = (): CtxItem[] => {
    const cabs = selectedCabs();
    const walls = selectedWalls();
    const items: CtxItem[] = [];
    if (cabs.length > 0) {
      items.push(
        { key: 'props', label: '属性', hint: 'Ctrl+1', onSelect: () => setRightTab('props') },
        { key: 'dup', label: cabs.length > 1 ? `复制 ${cabs.length} 个柜体` : '复制', hint: 'Ctrl+D', onSelect: onDuplicate },
        { key: 'rot', label: '旋转 90°', hint: '逆时针', onSelect: onRotate90 },
        { key: 'mir', label: '镜像（分区反序）', hint: 'MI', onSelect: onMirror },
      );
    } else if (walls.length > 0) {
      items.push({ key: 'props', label: '属性', hint: 'Ctrl+1', onSelect: () => setRightTab('props') });
    }
    if (selection.length > 0) {
      items.push({ key: 'del', label: `删除（${selection.length} 项）`, hint: 'Delete', danger: true, onSelect: onDelete });
      items.push({ key: 'sep1', label: '' });
    }
    items.push(
      {
        key: 'selall',
        label: '全选',
        hint: '柜体 + 墙',
        onSelect: () => {
          const p = bus.getState();
          setSelection([...p.cabinets.map((c) => c.id), ...p.rooms.flatMap((r) => r.walls.map((w) => w.id))]);
        },
      },
      { key: 'room', label: '新建房间', onSelect: onNewRoom },
      { key: 'zoom', label: '适应窗口', hint: 'Home', onSelect: () => setFitSignal((v) => v + 1) },
      { key: 'cmd', label: '命令行…', hint: '`', onSelect: () => setCmdOpen(true) },
    );
    return items;
  };

  const toggleLayer = useCallback((name: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const changeWorkspaceRoom = useCallback((roomId: string) => {
    setWorkspaceProjectId(bus.getState().id);
    setWorkspaceRoomId(roomId);
    setWorkspaceContextNotice('');
    setSelection([]);
    selectionOnModeChange.current = null;
  }, []);

  const createCabinetInRoom = useCallback((request: {
    roomId: string;
    name: string;
    templateId: string;
    params: { width: number; height: number; depth: number };
  }): boolean => {
    if (unitIdentityReadOnly) {
      toast('warn', '历史重复 Unit ID 项目处于只读浏览模式；须显式修复/迁移后才能写入。');
      return false;
    }
    const project = bus.getState();
    const room = project.rooms.find((candidate) => candidate.id === request.roomId);
    if (!room) {
      toast('error', '当前房间已不存在，请重新选择房间后再添加柜体');
      return false;
    }
    const name = request.name.trim();
    if (!name || project.cabinets.some((cabinet) => cabinet.name === name)) {
      toast('warn', '柜体名称不能为空，且不能与项目中的其他柜体重名');
      return false;
    }
    const template = CABINET_TEMPLATES.find((candidate) => candidate.id === request.templateId);
    if (!template) {
      toast('error', '所选柜型已不可用，请重新选择');
      return false;
    }

    const spots = candidateSpots(project, room.id, request.params.width);
    if (spots.length === 0 && room.walls.length === 0) {
      const sameRoom = project.cabinets.filter((cabinet) => cabinet.roomId === room.id);
      const nextX = sameRoom.reduce((max, cabinet) => Math.max(max, cabinet.placement.x + cabinet.params.width), 0) + 200;
      spots.push({ x: nextX, y: 0, rotation: 0, wallId: null, wallName: '' });
    }
    if (spots.length === 0) {
      toast('warn', '当前房间找不到可放置该尺寸柜体的墙位；可调整尺寸或使用高级 CAD 手动落位');
      return false;
    }

    const existingErrors = new Set(bus.issues().filter((issue) => issue.severity === 'ERROR').map((issue) => `${issue.code}|${issue.target}|${issue.severity}`));
    for (const spot of spots) {
      const cabinet = createCabinetFromTemplate({
        templateId: template.id,
        name,
        roomId: room.id,
        x: spot.x,
        y: spot.y,
        rotation: spot.rotation,
        rules: bus.getRules(),
        takenIds: project.cabinets.map((item) => item.id),
        takenUnitIds: projectUnitIds(project),
        params: request.params,
      });
      const command = CMD.createCabinet(cabinet);
      const preview = bus.preview(command);
      if (!preview.ok) continue;
      const nextIssues = new CommandBus(preview.project, bus.getRules()).issues();
      const newCabinetError = nextIssues.find((issue) =>
        issue.severity === 'ERROR' &&
        (issue.target?.includes(cabinet.id) || issue.target?.includes(cabinet.name)) &&
        !existingErrors.has(`${issue.code}|${issue.target}|${issue.severity}`)
      );
      if (newCabinetError) continue;
      if (!run(command)) return false;
      setSelection([cabinet.id]);
      setLastMsg(`已在「${room.name}」添加「${cabinet.name}」`);
      toast('ok', `已在「${room.name}」添加「${cabinet.name}」`);
      return true;
    }
    toast('warn', '没有找到通过规则校验的落位；请调整柜体尺寸或改用高级 CAD');
    return false;
  }, [run, toast, unitIdentityReadOnly]);

  const switchToWorkspace = (): void => {
    const project = bus.getState();
    if (workspaceGroupExists(project, workspaceRoomId)) {
      setWorkspaceProjectId(project.id);
      setWorkspaceContextNotice('');
    } else if (!workspaceContextNotice && project.rooms.length > 0) {
      setWorkspaceContextNotice('请从左侧房间列表选择要打开的房间。');
    }
    setSelection([]);
    selectionOnModeChange.current = null;
    setRightTab('ai');
    setWorkspaceMode(true);
  };
  /**
   * 本地 → 服务端同步（PUT /api/workspace）。
   *
   * P1-5 修复点（这次的重点）：原先写死 `clientHasLocalEdits: true, force: true`，
   * 结果 server 端 workspace.ts:764-777 的版本冲突闸被 force 完全绕过，
   * 文档里明令禁止的 last-write-wins 反而成了默认路径 ——
   * A 端改了模型，B 端一点"同步"就能把它静默冲掉。
   *
   * 现在：
   *  · expectedLiveVersion 发的是最近一次确认到的服务端基线（ref，非闭包旧值）；
   *  · 不带 force —— 基线落后时服务端会真的拒绝，这才是我们要的；
   *  · clientHasLocalEdits 反映真实情况（本地模型与最后一次确认的服务端项目是否不同），
   *    恒 true 会把服务端"空本地不覆盖云端"那道水位线保护也一起废掉；
   *  · WORKSPACE_VERSION_CONFLICT 不当异常吞掉，转成显式冲突态交给用户二选一。
   */
  const syncLocalToServer = useCallback(async (force = false): Promise<boolean> => {
    if (unitIdentityReadOnly) return false;
    const localProject = bus.getState();
    const serverFingerprint = lastServerProjectFingerprintRef.current;
    /**
     * 只有"确实和最后确认过的服务端项目不同"才声明本地有编辑。
     * 还没有任何服务端基线（serverFingerprint 为 null，首屏 GET 未回）时按 true 处理：
     * 宁可让服务端走冲突判定，也不要谎称"无本地编辑"导致自己的修改被云端静默注水覆盖。
     */
    const clientHasLocalEdits = serverFingerprint === null || stableProjectJson(localProject) !== serverFingerprint;
    /** 基线版本；null = 首屏 GET 还没回来，此时不带该字段。 */
    const expectedLiveVersion = lastLiveVersionRef.current;
    /** PUT 在飞期间用户可能继续编辑；回来时用它判断本地是否又变了。 */
    const modelVersionAtRequest = versionRef.current;
    const res = await api<{
      ok?: boolean;
      code?: string;
      error?: string;
      project?: Project;
      liveModelVersion?: number;
      projectSnapshotId?: string;
      projectSnapshotHash?: string;
      projectSnapshotVersion?: number;
      identityDiagnostics?: IdentityDiagnostics;
    }>('/api/workspace', {
      method: 'PUT',
      token,
      body: {
        project: localProject,
        clientHasLocalEdits,
        ...(force ? { force: true } : {}),
        /**
         * null 时**不发**该字段：发 0 会让一次正常的首次同步被误判为"基线落后"。
         */
        ...(expectedLiveVersion === null ? {} : { expectedLiveVersion }),
        reason: force ? '网页端确认强制覆盖云端（用户显式选择）' : '网页端手动修改同步到服务器',
      },
    });
    /**
     * 版本冲突**必须**单独处理，且绝不能静默覆盖：
     * 服务端返回 409 + code='WORKSPACE_VERSION_CONFLICT' + 整份云端 project。
     * 把它存进 workspaceVersionConflict 让用户在界面上明确二选一；
     * 同时把基线版本更新成服务端当前版本，避免用户下一次点同步还是同一份旧基线。
     */
    if (res.data?.code === 'WORKSPACE_VERSION_CONFLICT' || (res.status === 409 && res.data?.project)) {
      const serverProject = res.data?.project ?? null;
      const serverVersion = typeof res.data?.liveModelVersion === 'number'
        ? res.data.liveModelVersion
        : (typeof res.data?.projectSnapshotVersion === 'number' ? res.data.projectSnapshotVersion : null);
      if (serverVersion !== null) lastLiveVersionRef.current = serverVersion;
      if (serverProject) {
        lastServerProjectFingerprintRef.current = stableProjectJson(serverProject);
        setWorkspaceVersionConflict({
          project: serverProject,
          liveModelVersion: serverVersion,
          message: res.data?.error ?? res.error ?? '云端已被其他端修改，本地未覆盖。',
        });
        toast('warn', `云端已被其他端修改（v${serverVersion ?? '?'}），本地未覆盖；请选择要保留的版本。`);
      } else {
        toast('error', `同步被服务端拒绝：${res.data?.error ?? res.error ?? '版本冲突'}`);
      }
      return false;
    }
    if (!res.ok || !res.data.project) {
      toast('error', `同步到服务器失败：${res.error ?? '未知错误'}`);
      return false;
    }
    // 成功后用服务端确认的版本与项目指纹更新基线 —— 下一次 PUT 才算"对得上号"。
    const confirmedVersion = typeof res.data.liveModelVersion === 'number'
      ? res.data.liveModelVersion
      : (typeof res.data.projectSnapshotVersion === 'number' ? res.data.projectSnapshotVersion : null);
    if (confirmedVersion !== null) lastLiveVersionRef.current = confirmedVersion;
    lastServerProjectFingerprintRef.current = stableProjectJson(res.data.project);
    setWorkspaceVersionConflict(null);
    const snapId = res.data.projectSnapshotId ?? null;
    const snapHash = res.data.projectSnapshotHash ?? null;
    const snapVer = res.data.projectSnapshotVersion ?? res.data.liveModelVersion ?? 0;
    setRemoteWorkspaceStatus((prev) => ({
      draftCount: prev?.draftCount ?? 0,
      /**
       * 正常情况下同步完就是不同步了；但若 PUT 在飞期间用户又改了模型，
       * 标成 differs=true 才是诚实的——否则角标会说"已同步"而本地其实更新。
       */
      differs: versionRef.current !== modelVersionAtRequest,
      liveModelVersion: snapVer,
      stale: false,
      snapshotReady: Boolean(snapId && snapHash),
      confirmedProject: res.data.project!,
      projectSnapshotId: snapId,
      projectSnapshotHash: snapHash,
      projectSnapshotVersion: snapVer,
      identityDiagnostics: res.data.identityDiagnostics,
    }));
    toast('ok', `已将当前网页修改同步到服务器（v${snapVer}），现在可直接导出 PDF / DXF`);
    return true;
  }, [token, unitIdentityReadOnly]);

  /**
   * 冲突二选一 · 选项 A：放弃本地修改，装回服务端版本。
   * 用户明确点了才执行 —— 这是"不要静默覆盖"的另一半：
   * 我们既不静默用本地盖云端，也不静默用云端盖本地。
   */
  const adoptServerVersionOnConflict = useCallback((): void => {
    const conflict = workspaceVersionConflict;
    if (!conflict) return;
    try {
      bus.replaceProject(conflict.project, `载入云端版本 v${conflict.liveModelVersion ?? '?'}（冲突时用户选择保留云端）`);
      setWorkspaceVersionConflict(null);
      toast('ok', `已载入云端版本 v${conflict.liveModelVersion ?? '?'}，本地未保存的修改已放弃`);
    } catch (error) {
      // replaceProject 会做完整校验；被拒时保留冲突态让用户改走"强制覆盖"，不假装成功。
      toast('error', `载入云端版本失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [workspaceVersionConflict, toast]);

  /**
   * 冲突二选一 · 选项 B：明确用本地覆盖云端。
   * 这是**唯一**还会发 force:true 的路径，且必须由用户在冲突界面里点确认，
   * 不再是每次同步的无条件默认。
   */
  const forceOverwriteServerOnConflict = useCallback((): void => {
    void (async () => {
      const conflict = workspaceVersionConflict;
      if (!conflict) return;
      const ok = await syncLocalToServer(true);
      // 成功时 syncLocalToServer 内部已清空冲突态；失败则保留，让用户能看见并重试。
      if (ok) toast('ok', '已按你的选择用本地版本覆盖云端');
    })();
  }, [workspaceVersionConflict, syncLocalToServer, toast]);

  const repairWorkspaceUnitIds = useCallback(async (): Promise<void> => {
    preserveDuplicateDraftBeforeHealthySwitch();
    const res = await api<{
      ok?: boolean;
      repairedLive?: number;
      repairedDrafts?: number;
      repairedReceipts?: number;
      deoverlappedRooms?: number;
      project?: Project;
      liveModelVersion?: number;
      projectSnapshotId?: string;
      projectSnapshotHash?: string;
      projectSnapshotVersion?: number;
      identityDiagnostics?: IdentityDiagnostics;
    }>('/api/workspace/repair-unit-ids', {
      method: 'POST',
      token,
      body: {},
    });

    const localFixed = deoverlapProjectRooms(repairDuplicateUnitIdsInProject(bus.getState()).project).project;
    const targetProject = (res.ok && res.data?.project && findDuplicateUnitIds(res.data.project).length === 0)
      ? res.data.project
      : localFixed;

    try {
      validatedHealthyProjectFingerprintRef.current = stableProjectJson(targetProject);
      bus.switchToValidatedHealthyProject(targetProject, '一键自动修复重复 Unit ID 并解除只读锁定', true);
      clearPersistedIdentityLockAfterHealthySwitch();
      setStickyIdentityDiagnostics(null);
      setProjectStorageReadOnly(false);
      saveDraft(bus.toFileSnapshot());
      const snapVer = res.data?.projectSnapshotVersion ?? res.data?.liveModelVersion ?? remoteWorkspaceStatus?.liveModelVersion ?? 1;
      setRemoteWorkspaceStatus((prev) => prev ? {
        ...prev,
        differs: false,
        liveModelVersion: snapVer,
        confirmedProject: structuredClone(targetProject),
        projectSnapshotId: res.data?.projectSnapshotId ?? prev.projectSnapshotId,
        projectSnapshotHash: res.data?.projectSnapshotHash ?? prev.projectSnapshotHash,
        projectSnapshotVersion: snapVer,
        identityDiagnostics: { readOnly: false, code: null, message: null, duplicateUnitIds: [] },
      } : prev);
      toast('ok', '已自动重编号修复重复 Unit ID 并解除只读锁定，现在可正常编辑、删除房间与导出图纸！');
    } catch (error) {
      toast('error', `修复失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [token, remoteWorkspaceStatus?.liveModelVersion, toast]);

  const applyLiveDraftQuick = useCallback(async (draftId: string): Promise<void> => {
    if (unitIdentityReadOnly) return;
    const detail = await api<{
      draftId: string;
      runId: string;
      revision: number;
      draftHash: string;
      liveModelVersion: number;
      baseModelVersion: number;
      baseProjectHash: string;
      project: Project;
    }>(`/api/drafts/${encodeURIComponent(draftId)}`, { token });
    if (!detail.ok || !detail.data?.project) {
      toast('error', `读取草稿失败：${detail.error ?? '草稿不存在'}`);
      return;
    }
    const d = detail.data;
    const syncId = `quick:${d.draftId}:${d.runId}:r${d.revision}:l${bus.getVersion()}`;
    const applied = await api<{
      project: Project;
      liveModelVersion: number;
    }>(`/api/drafts/${encodeURIComponent(draftId)}/apply`, {
      method: 'POST',
      token,
      body: {
        syncId,
        runId: d.runId,
        draftId: d.draftId,
        revision: d.revision,
        draftHash: d.draftHash,
        localVersion: bus.getVersion(),
        remoteVersion: d.liveModelVersion,
        baseModelVersion: d.baseModelVersion,
        baseProjectHash: d.baseProjectHash,
      },
    });
    if (!applied.ok || !applied.data?.project) {
      toast('error', `应用草稿失败：${applied.error ?? '请打开草稿页查看详情'}`);
      return;
    }
    bus.replaceProject(applied.data.project, `应用 MCP/Agent 草稿 ${draftId}`);
    setLiveDraftPreview(null);
    toast('ok', `已采纳草稿 ${draftId} 并同步到当前画布（live v${applied.data.liveModelVersion}）`);
  }, [token, unitIdentityReadOnly]);

  const cleanStaleOverrides = useCallback((): void => {
    if (unitIdentityReadOnly) return;
    const derived = bus.derive();
    const planKeys = Object.values(derived.geom.roomPlanSourceKeys ?? {}).flat();
    const sheetKeys = derived.geom.views.sourceKeys ?? [];
    const cleaned = filterValidDrawingEdits(bus.getState(), planKeys, sheetKeys);
    bus.execute(replaceDrawingEdits(bus.getState(), cleaned, '清理已失效的二维图元覆盖'));
    toast('ok', '已清理失效的二维图元覆盖');
  }, [unitIdentityReadOnly]);

  const openRemoteDrafts = (): void => {
    setSelection([]);
    selectionOnModeChange.current = null;
    setRightTab('drafts');
    setWorkspaceMode(false);
  };
  const enterCadFromWorkspace = (): void => {
    if (unitIdentityReadOnly) return;
    setSelection([]);
    selectionOnModeChange.current = null;
    setRightTab('ai');
    setWorkspaceMode(false);
  };
  const openCadFor = (cabinetId?: string, roomId?: string): void => {
    if (unitIdentityReadOnly) return;
    if (cabinetId) {
      setSelection([cabinetId]);
      selectionOnModeChange.current = mode === 'plan' ? null : [cabinetId];
    }
    else {
      setSelection([]);
      selectionOnModeChange.current = null;
    }
    setWorkspaceMode(false);
    setRightTab('ai');
    setMode('plan');
    if (roomId) focusRoomById(roomId);
  };

  const localUnitIdentityConflict = bus.getUnitIdentityConflict();
  const remoteUnitIdentityConflict = remoteIdentityReadOnly
    ? (remoteWorkspaceStatus?.identityDiagnostics?.message ?? '检测到远端历史 Unit/backUnit 身份冲突，需要显式修复/迁移。')
    : null;
  const unitIdentityConflict = [...new Set([localUnitIdentityConflict, remoteUnitIdentityConflict].filter((message): message is string => Boolean(message)))].join(' ');
  const visibleIdentityDiagnostics = remoteIdentityReadOnly
    ? remoteWorkspaceStatus?.identityDiagnostics
    : localUnitIdentityConflict
      ? stickyIdentityDiagnostics ?? { readOnly: true, code: 'UNIT_IDENTITY_CONFLICT', message: localUnitIdentityConflict, duplicateUnitIds: findDuplicateUnitIds(bus.getState()) }
      : null;
  const unitIdentityBannerLabel = localUnitIdentityConflict ? '只读浏览模式：发现历史 Unit/backUnit 身份冲突。' : '远端工作区只读：发现历史 Unit/backUnit 身份冲突。';
  return (
    <div className="app" data-project-id={bus.getState().id} data-model-version={version}>
      {unitIdentityConflict ? (
        <div
          className="unit-identity-readonly-banner"
          role="alert"
          data-testid="unit-identity-readonly-banner"
          style={{ background: '#fff4e5', borderBottom: '1px solid #e6a23c', color: '#6b4300', padding: '10px 16px', fontSize: 13, lineHeight: 1.5 }}
        >
          <strong>{unitIdentityBannerLabel}只读浏览；写入已禁用，需显式修复/迁移后才能恢复。</strong>{' '}
          <span data-testid="unit-identity-readonly-details">
            诊断码：{visibleIdentityDiagnostics?.code ?? 'UNIT_IDENTITY_CONFLICT'}；{visibleIdentityDiagnostics?.message ?? unitIdentityConflict}
            {visibleIdentityDiagnostics?.duplicateUnitIds?.map((duplicate) => `；重复 ID ${duplicate.id} 冲突位置：${duplicate.locations.join('、')}`).join('')}
          </span>
          <span data-testid="unit-identity-copy-advice" style={{ marginLeft: 8 }}>
            旧项目与原始 Unit ID 已保留只读，不会自动重编号或覆盖；建议先保留副本。只有在 ProjectsPanel 确认载入并通过重复 ID 校验的健康 Project 后，才解除锁定。
          </span>
          <button
            type="button"
            data-testid="unit-identity-auto-repair"
            style={{ marginLeft: 12, border: '1px solid #1d4ed8', borderRadius: 4, padding: '4px 10px', background: '#2563eb', color: '#ffffff', fontWeight: 600, cursor: 'pointer' }}
            title="自动为所有重复的分区/背板分区分配全局唯一 ID（含服务端草稿与历史收据），立即解除只读锁定"
            onClick={() => void repairWorkspaceUnitIds()}
          >
            🔧 一键自动修复重复 Unit ID 并解除只读锁定
          </button>
          <button
            type="button"
            data-testid="unit-identity-switch-healthy-project"
            style={{ marginLeft: 8, border: '1px solid currentColor', borderRadius: 4, padding: '3px 8px', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
            title="跳转到 ProjectsPanel；确认载入后会验证重复 Unit ID，仅健康项目可解除只读锁"
            onClick={() => { setWorkspaceMode(false); setRightTab('projects'); setSelection([]); }}
          >
            打开 ProjectsPanel 并选择健康项目…
          </button>
        </div>
      ) : null}
      {workspaceVersionConflict ? (
        <div
          className="workspace-version-conflict-banner"
          role="alertdialog"
          data-testid="workspace-version-conflict-banner"
          style={{ background: '#fef2f2', borderBottom: '1px solid #ef4444', color: '#7f1d1d', padding: '10px 16px', fontSize: 13, lineHeight: 1.5 }}
        >
          <strong>云端已被其他端修改，本地未覆盖。</strong>{' '}
          <span data-testid="workspace-version-conflict-detail">
            云端当前 v{workspaceVersionConflict.liveModelVersion ?? '?'}；{workspaceVersionConflict.message}
          </span>{' '}
          <button
            type="button"
            data-testid="workspace-version-conflict-adopt-server"
            style={{ marginLeft: 12, border: '1px solid currentColor', borderRadius: 4, padding: '3px 10px', background: 'transparent', color: 'inherit', fontWeight: 600, cursor: 'pointer' }}
            title="放弃本地未保存的修改，载入云端版本"
            onClick={adoptServerVersionOnConflict}
          >
            用云端版本覆盖本地（v{workspaceVersionConflict.liveModelVersion ?? '?'}）
          </button>
          <button
            type="button"
            data-testid="workspace-version-conflict-force-local"
            style={{ marginLeft: 8, border: '1px solid #b91c1c', borderRadius: 4, padding: '3px 10px', background: '#dc2626', color: '#ffffff', fontWeight: 600, cursor: 'pointer' }}
            title="以服务端当前版本为基线，明确用本地修改覆盖云端（会丢弃云端那次修改）"
            onClick={forceOverwriteServerOnConflict}
          >
            ⚠ 用本地版本强制覆盖云端
          </button>
          <button
            type="button"
            data-testid="workspace-version-conflict-dismiss"
            style={{ marginLeft: 8, border: '1px solid currentColor', borderRadius: 4, padding: '3px 8px', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
            title="先不管，保持本地状态（云端保持原样，不做任何写入）"
            onClick={() => setWorkspaceVersionConflict(null)}
          >
            稍后再说
          </button>
        </div>
      ) : null}
      {workspaceMode ? (
        <WorkspaceTopBar
          project={bus.getState()}
          onOpenCad={enterCadFromWorkspace}
          onNewRoom={() => { if (unitIdentityReadOnly) return; setWorkspaceMode(false); onNewRoom(); }}
          readOnly={unitIdentityReadOnly}
          productionExportBlocked={sharedPanelDraftOpen}
          onExport={() => {
            if (unitIdentityReadOnly) return;
            if (sharedPanelDraftOpen) {
              toast('error', '正式生产导出已阻止：共享件规格仍在编辑，须先确认保存或取消编辑。');
              return;
            }
            setWorkspaceMode(false);
            setRightTab('export');
          }}
          onOpenRemoteDrafts={openRemoteDrafts}
          remoteStatus={remoteWorkspaceStatus}
        />
      ) : <Toolbar
        tool={tool}
        setTool={setTool}
        templateId={templateId}
        setTemplateId={setTemplateId}
        mode={mode}
        setMode={setMode}
        explode={explode}
        setExplode={setExplode}
        canUndo={bus.canUndo()}
        canRedo={bus.canRedo()}
        onUndo={doUndo}
        onRedo={doRedo}
        onZoomExtents={() => setFitSignal((v) => v + 1)}
        showGrid={showGrid}
        setShowGrid={setShowGrid}
        snap={snap}
        setSnap={setSnap}
        onNewRoom={onNewRoom}
        onDuplicate={onDuplicate}
        onDelete={onDelete}
        hasSelection={selection.length > 0}
        canDuplicate={selectedCabs().length > 0 || selection.some(id => id.startsWith('edit:') || id.startsWith('source:'))}
        canDelete={selection.length > 0}
        loggedIn={Boolean(token)}
        onLogout={doLogout}
        onWorkspace={switchToWorkspace}
        readOnly={unitIdentityReadOnly}
      />}

      <div className={workspaceMode ? 'body chat-workspace-body' : 'body'}>
      {workspaceMode ? (
        <main className="workspace-main">
          <RoomWorkspace
            project={bus.getState()}
            rules={RULESET}
            bus={bus}
            version={version}
            selection={selection}
            setSelection={setSelection}
            selectedRoomId={workspaceRoomId}
            roomSelectionMessage={workspaceContextNotice}
            onRoomChange={changeWorkspaceRoom}
            onOpenCad={openCadFor}
            readOnly={unitIdentityReadOnly}
            onCreateCabinet={createCabinetInRoom}
            onSaveSharedPanels={(sharedPanels, label) => {
              if (unitIdentityReadOnly) return;
              try { bus.replaceProject({ ...bus.getState(), sharedPanels }, label); }
              catch (error) { toast('error', error instanceof Error ? error.message : String(error)); }
            }}
            onSharedPanelDraftChange={setSharedPanelDraftOpen}
            accountConnected={Boolean(token)}
            onAccountOpen={() => setAccountOpen(true)}
            liveDraftPreview={liveDraftPreview}
            agentEvents={agentEvents}
            onApplyLiveDraft={(dId) => void applyLiveDraftQuick(dId)}
            onOpenRemoteDrafts={openRemoteDrafts}
            onSyncLocalToServer={() => void syncLocalToServer()}
            remoteDiffers={remoteWorkspaceStatus?.differs ?? false}
          >
            <AIPanel
              bus={bus}
              version={version}
              token={token}
              selection={selection}
              onToast={toast}
              workspaceRoomId={workspaceRoomId}
              onWorkspaceRoomChange={changeWorkspaceRoom}
              onOpenRemoteDrafts={openRemoteDrafts}
              onQuickApplyDraft={(dId) => void applyLiveDraftQuick(dId)}
              onLiveDraftChange={setLiveDraftPreview}
              readOnly={unitIdentityReadOnly}
              workspaceContext
            />
          </RoomWorkspace>
        </main>
      ) : (
        <>
        <aside className="side-left">
          <div className="tabs">
            <button type="button" className={leftTab === 'tree' ? 'on' : ''} onClick={() => setLeftTab('tree')}>
              对象树
            </button>
            <button type="button" className={leftTab === 'layers' ? 'on' : ''} onClick={() => setLeftTab('layers')}>
              图层
            </button>
          </div>
          {leftTab === 'tree' ? (
            <ObjectTree bus={bus} version={version} selection={selection} setSelection={setSelection} readOnly={unitIdentityReadOnly} />
          ) : (
            <LayersPanel
              hiddenLayers={hiddenLayers}
              toggle={toggleLayer}
              setAll={(hidden) => setHiddenLayers(hidden ? new Set(defaultHiddenLayers()) : new Set())}
            />
          )}
        </aside>

        <main className="stage">
          {mode === '3d' ? (
            <Suspense fallback={<div className="loading3d">3D 视口加载中…</div>}>
              <ThreeViewport bus={bus} version={version} selection={selection} setSelection={setSelection} />
            </Suspense>
          ) : (
            <Viewport
              bus={bus}
              version={version}
              cam={cam}
              setCam={setCam}
              fitSignal={fitSignal}
              cancelSignal={cancelSignal}
              focusRoom={focusRoom}
              mode={mode}
              explode={explode}
              tool={tool}
              selection={selection}
              setSelection={setSelection}
              snapSettings={snap}
              showGrid={showGrid}
              hiddenLayers={hiddenLayers}
              pendingMove={pendingMove}
              onMovePick={onMovePick}
              onPlaceCabinet={onPlaceCabinet}
              onCreateWall={onCreateWall}
              onContextMenu={onViewportContextMenu}
              onPickPart={onPickPart}
              onToast={toast}
              cursorStyle={tool === 'select' ? 'default' : 'crosshair'}
              readOnly={unitIdentityReadOnly}
            />
          )}
          {cmdOpen ? <CommandLine onCommand={runText} onClose={() => setCmdOpen(false)} lastMessage={lastMsg} /> : null}
        </main>

        <aside className="side-right">
          <div className="tabs">
            <button type="button" className={rightTab === 'props' ? 'on' : ''} onClick={() => setRightTab('props')}>
              属性
            </button>
            <button type="button" className={rightTab === 'issues' ? 'on' : ''} onClick={() => setRightTab('issues')}>
              问题{errCount > 0 ? <span className="tab-badge">{errCount}</span> : null}
            </button>
            <button type="button" className={rightTab === 'history' ? 'on' : ''} onClick={() => setRightTab('history')}>
              历史
            </button>
            {/* 图层已在左侧对象树旁，不再重复 */}
            <button type="button" className={rightTab === 'views' ? 'on' : ''} onClick={() => setRightTab('views')}>
              视图
            </button>
            <button type="button" className={rightTab === 'rooms' ? 'on' : ''} onClick={() => setRightTab('rooms')}>
              房间{projectRooms > 0 ? <span className="tab-badge">{projectRooms}</span> : null}
            </button>
            <button type="button" className={rightTab === 'projects' ? 'on' : ''} onClick={() => setRightTab('projects')}>
              项目
            </button>
            <button type="button" className={rightTab === 'variant' ? 'on' : ''} onClick={() => setRightTab('variant')}>
              方案
            </button>
            <button type="button" className={rightTab === 'export' ? 'on' : ''} onClick={() => setRightTab('export')}>
              导出
            </button>
            <button type="button" className={rightTab === 'ai' ? 'on' : ''} onClick={() => setRightTab('ai')}>
              AI
            </button>
            <button type="button" className={rightTab === 'drafts' ? 'on' : ''} onClick={() => setRightTab('drafts')}>
              草稿
            </button>
            <button type="button" className={rightTab === 'import' ? 'on' : ''} onClick={() => setRightTab('import')}>
              导入
            </button>
            <button type="button" className={rightTab === 'knowledge' ? 'on' : ''} onClick={() => setRightTab('knowledge')}>
              知识
            </button>
            <button type="button" className={rightTab === 'manufacturing' ? 'on' : ''} onClick={() => setRightTab('manufacturing')}>
              制造
            </button>
            <button type="button" className={rightTab === 'memory' ? 'on' : ''} onClick={() => setRightTab('memory')}>
              记忆
              {memoryPending > 0 ? <span className="tab-badge tab-badge-warn">{memoryPending}</span> : null}
            </button>
            <button type="button" className={rightTab === 'admin' ? 'on' : ''} onClick={() => setRightTab('admin')}>
              后台
            </button>
            <button type="button" className={rightTab === 'account' ? 'on' : ''} onClick={() => setRightTab('account')}>
              账号
            </button>
          </div>
          <div className="panel-scroll">
          {rightTab === 'props' ? (
            <div data-testid="properties-readonly-boundary">
              {unitIdentityReadOnly ? <div className="alert alert-warn" role="note">歷史重复 Unit ID 项目只读；CAD 参数与图元属性不可编辑。</div> : null}
              <fieldset disabled={unitIdentityReadOnly} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                <PropertiesPanel bus={bus} version={version} selection={selection} setSelection={setSelection} onToast={toast} readOnly={unitIdentityReadOnly} />
              </fieldset>
            </div>
          ) : null}
          {rightTab === 'issues' ? (
            <IssuesPanel bus={bus} version={version} setSelection={setSelection} applyFix={applyFix} />
          ) : null}
          {rightTab === 'history' ? <HistoryPanel bus={bus} version={version} /> : null}
          {rightTab === 'views' ? (
            <ViewsPanel bus={bus} version={version} mode={mode} setMode={setMode} explode={explode} setExplode={setExplode} />
          ) : null}
          {rightTab === 'rooms' ? (
            <RoomsPanel
              bus={bus}
              version={version}
              run={run}
              onToast={toast}
              onFocusRoom={focusRoomById}
              view={roomsView}
              onViewChange={setRoomsView}
              onCreated={onRoomCreated}
              onSyncToServer={syncLocalToServer}
              remoteDiffers={remoteWorkspaceStatus?.differs ?? false}
              readOnly={unitIdentityReadOnly}
            />
          ) : null}
          {rightTab === 'projects' ? (
            <ProjectsPanel
              token={token}
              readOnly={unitIdentityReadOnly}
              rooms={bus.getState().rooms.map(r => ({ id: r.id, name: r.name }))}
              onToast={toast}
              onFocusRoom={focusRoomById}
              onCreateRoom={(name) => {
                if (unitIdentityReadOnly) return;
                // 在当前项目下新建房间（默认 4000×3000mm，用户可后续调整）
                const project = bus.getState();
                const takenIds = new Set<string>();
                for (const r of project.rooms) {
                  takenIds.add(r.id);
                  for (const wl of r.walls) takenIds.add(wl.id);
                }
                // 找个空位：放在现有房间右侧
                let x = 0;
                for (const r of project.rooms) {
                  for (const w of r.walls) {
                    x = Math.max(x, w.start.x, w.end.x);
                  }
                }
                x += 500; // 间隔 500mm
                import('../core/docFactory.ts').then(({ rectRoom }) => {
                  const room = rectRoom({ name, x, y: 0, w: 4000, h: 3000, takenIds });
                  if (run(CMD.createRoomCommand(room))) {
                    toast('ok', `已在当前项目下新建房间「${name}」`);
                    onRoomCreated(room.id);
                  } else {
                    toast('error', '新建房间被总线拒绝');
                  }
                });
              }}
              onWorkspaceLoaded={(project) => {
                // GET 只读加载允许浏览旧项目，但不能借此覆盖/改写本地历史 duplicate。
                const duplicates = findDuplicateUnitIds(project);
                if (duplicates.length) {
                  validatedHealthyProjectFingerprintRef.current = null;
                  bus.loadProjectReadOnly(project);
                  toast('warn', unitIdentityConflictMessage('server workspace project', duplicates));
                  return;
                }
                try {
                  // 此 handler 只由用户在 ProjectsPanel 明确确认载入/切换后触发。
                  // 目标先做 duplicate 身份扫描，再显式切换；普通 refresh/hydrate 没有解锁权限。
                  if (!preserveDuplicateDraftBeforeHealthySwitch()) {
                    throw new Error('无法保留本地历史只读草稿副本；请先确保有可恢复副本，再重试健康项目切换。');
                  }
                  validatedHealthyProjectFingerprintRef.current = stableProjectJson(project);
                  bus.switchToValidatedHealthyProject(project, '从服务端载入已校验的健康工作区', true);
                  clearPersistedIdentityLockAfterHealthySwitch();
                  setStickyIdentityDiagnostics(null);
                  setProjectStorageReadOnly(false);
                  setRemoteWorkspaceStatus((previous) => previous ? {
                    ...previous,
                    confirmedProject: structuredClone(project),
                    identityDiagnostics: undefined,
                    differs: false,
                  } : previous);
                } catch (error) {
                  validatedHealthyProjectFingerprintRef.current = null;
                  toast('error', error instanceof Error ? error.message : String(error));
                }
              }}
            />
          ) : null}
          {rightTab === 'variant' ? (
            <VariantPanel
              bus={bus}
              version={version}
              run={run}
              onToast={toast}
              onAdopted={(id) => {
                // 两处都写：切模式会触发上面的 effect（它会按 ref 重设选中）；
                // 若模式本来就是图幅、effect 不触发，这里的直接赋值才是生效的那一次。
                setSelection([id]);
                selectionOnModeChange.current = mode === 'sheet' ? null : [id];
                // 采用之后直接切到四视图 —— 这正是"选完再出四视图"的那一步
                setMode('sheet');
                setRightTab('views');
              }}
              readOnly={unitIdentityReadOnly}
            />
          ) : null}
          {rightTab === 'export' ? (
            <ExportPanel
              bus={bus}
              version={version}
              token={token}
              savedAt={savedAt}
              remoteStatusReady={remoteWorkspaceStatus !== null && !remoteWorkspaceStatus.stale && remoteWorkspaceStatus.snapshotReady}
              remoteStatusDiffers={remoteWorkspaceStatus?.differs ?? false}
              remoteLiveModelVersion={remoteWorkspaceStatus?.liveModelVersion ?? 0}
              confirmedProject={remoteWorkspaceStatus?.confirmedProject ?? null}
              projectSnapshotId={remoteWorkspaceStatus?.projectSnapshotId ?? null}
              projectSnapshotHash={remoteWorkspaceStatus?.projectSnapshotHash ?? null}
              projectSnapshotVersion={remoteWorkspaceStatus?.projectSnapshotVersion ?? null}
              unconfirmedSharedPanelDraft={sharedPanelDraftOpen}
              onOpenRemoteDrafts={openRemoteDrafts}
              onSyncLocalToServer={syncLocalToServer}
              onCleanStaleOverrides={cleanStaleOverrides}
              onToast={toast}
              readOnly={unitIdentityReadOnly}
            />
          ) : null}
          {rightTab === 'memory' ? <MemoryPanel /> : null}
          {rightTab === 'admin' ? <AdminPanel token={token} /> : null}
          {rightTab === 'ai' ? <AIPanel bus={bus} version={version} token={token} selection={selection} onToast={toast} workspaceRoomId={workspaceRoomId} onWorkspaceRoomChange={changeWorkspaceRoom} onOpenRemoteDrafts={openRemoteDrafts} readOnly={unitIdentityReadOnly} /> : null}
          {rightTab === 'drafts' ? <DraftsPanel bus={bus} token={token} version={version} onToast={toast} onApplied={switchToWorkspace} readOnly={unitIdentityReadOnly} /> : null}
          {rightTab === 'import' ? <ImportPanel bus={bus} version={version} onToast={toast} unitIdentityReadOnly={unitIdentityReadOnly} /> : null}
          {rightTab === 'knowledge' ? <KnowledgePanel bus={bus} version={version} onToast={toast} /> : null}
          {rightTab === 'manufacturing' ? <ManufacturingPanel bus={bus} version={version} /> : null}
          {rightTab === 'account' ? <AccountPanel token={token} setToken={setToken} onToast={toast} onLogout={doLogout} /> : null}
          </div>
        </aside>
        </>
      )}
      </div>

      {accountOpen ? (
        <div className="workspace-account-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAccountOpen(false); }}>
          <section className="workspace-account-dialog" role="dialog" aria-modal="true" aria-label="登录与账户设置">
            <header className="workspace-3d-header">
              <div>
                <strong>{token ? '账户设置' : '登录 / 账户设置'}</strong>
                <span>登录、退出与账户相关设置</span>
              </div>
              <button type="button" className="workspace-button workspace-button-quiet" onClick={() => setAccountOpen(false)} aria-label="关闭账户设置">关闭</button>
            </header>
            <AccountPanel token={token} setToken={setToken} onToast={toast} onLogout={doLogout} />
          </section>
        </div>
      ) : null}

      {/* 命令行打开时不再重复这条提示 */}
      {!workspaceMode && !cmdOpen ? (
        <div className="cmd-hint">
          按 <kbd>`</kbd> 打开命令行 · 输入 <b>HELP</b> 查看全部命令 · 以 <b>{'{'}</b> 开头可粘贴一段 Command JSON 直接执行
        </div>
      ) : null}

      {!workspaceMode ? <StatusBar bus={bus} version={version} cam={cam} snap={snap} tool={tool} selectionCount={selection.length} savedAt={savedAt} /> : null}

      {ctxMenu ? <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={buildCtxItems()} onClose={() => setCtxMenu(null)} /> : null}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
