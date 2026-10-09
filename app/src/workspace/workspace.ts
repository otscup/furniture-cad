/**
 * ══════════════════════════════════════════════════════════════════════
 *  P10.0 · S1：Workspace 持久实体 + 服务端草稿（Draft）+ 并发写接入
 *
 *  ── 在 P10.0 架构审查（方案 A′）里的位置 ──
 *   Workspace 是服务端持久实体，**持有** Semantic Model，但**不重新定义**它。
 *   · Semantic Model 仍是唯一真相源（Project，src/core/types.ts）；
 *   · 持久化复用现有 projectFile 信封（serializeProjectFile / parseProjectFile），
 *     不发明第二套模型 schema、不发明第二套持久化格式；
 *   · 所有写模型操作**只经现有 CommandBus**（含其路径白名单校验），
 *     没有第二个 CommandBus、第二个 validator、MCP 专用 mutation、直接 object.foo= 绕过；
 *   · draft 复用 CommandBus 的沙盒语义（plan 返回的 draft = 一份独立 fork），
 *     不新建 ServerDraftSession 引擎；
 *   · 一致性靠 liveModelVersion（Workspace 并发版本）+ 结构化 DRAFT_STALE；
 *   · 禁止自动 merge / last-write-wins / 静默覆盖。
 *
 *  ── 持久化怎么接（DI）──
 *   WorkspaceStore 不 import 任何文件系统 / .mjs。落盘通过构造时注入的
 *   `persist(content: string): Promise<void>` 完成 —— 生产侧与测试侧都注入
 *   同一个进程内串行写队列（server/writeQueue.mjs 的 writeJsonAtomic），
 *   从而天然满足 S1-E 的「并发写保护」且不把 .mjs 拖进 tsc 检查面。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Issue, Project, RuleSet } from '../core/types.ts';
import { CommandBus } from '../core/commandBus.ts';
import type { Command, DerivedSummary, ExecResult } from '../core/commandBus.ts';
import { serializeProjectFile, parseProjectFile } from '../core/projectFile.ts';
import { sampleProject } from '../core/docFactory.ts';
import { findDuplicateUnitIds, unitIdentityConflictError, unitIdentityConflictMessage, WORKSPACE_UNIT_ID_CONFLICT } from '../core/unitIdentity.mjs';
export { findDuplicateUnitIds, WORKSPACE_UNIT_ID_CONFLICT } from '../core/unitIdentity.mjs';

/** 落盘函数：调用方把「内存真相」序列化成字符串传入，队列只负责原子有序写。 */
export type PersistFn = (content: string) => Promise<void>;
/** 读盘函数：返回 Workspace 文件的原始字符串（读不进队列，失败由调用方处理）。 */
export type ReadRawFn = () => string;
/** 生产 host 注入 SHA-256；独立内存测试使用确定性 fallback。 */
export type ProjectHashFn = (project: Project) => string;

function fallbackProjectHash(project: Project): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  };
  // WorkspaceStore 的生产入口总会注入 SHA-256；此轻量 fallback 只服务不带 host 的单元夹具。
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonical(project))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

export const DRAFT_STALE = 'DRAFT_STALE' as const;
export type DraftRejectCode = typeof DRAFT_STALE;

/** Workspace 信封在 projectFile 信封之外额外持有的元数据（持有而非定义模型）。 */
export interface WorkspaceMeta {
  workspaceId: string;
  /** 归属账号 id；本地开放模式为 'local-open' */
  owner: string;
  /** 归属账号标识（与 owner 同源，留作多租户前的稳定字段） */
  account: string;
  /** 最近更新时间 ISO 8601 */
  updatedAt: string;
  /** 并发版本：live 每经一次提交/apply 单调 +1；draft 据此做乐观锁 */
  liveModelVersion: number;
}

/** 完整 Workspace 文件形状 = WorkspaceMeta ∪ projectFile 信封（模型用同一信封承载）。 */
export interface WorkspaceFileShape extends WorkspaceMeta {
  format: string;
  formatVersion: number;
  savedAt: string;
  project: Project;
  draftSyncReceipts?: Record<string, DraftSyncReceipt>;
}

export interface DraftHandle {
  workspaceId: string;
  draftId: string;
  runId: string;
  revision: number;
  baseModelVersion: number;
  baseProjectHash: string;
  owner: string;
}

export interface DraftFreshness {
  runId: string;
  revision: number;
  draftHash: string;
  isStale: boolean;
  staleReason: 'base_hash_missing' | 'version_mismatch' | 'hash_mismatch' | null;
  baseModelVersion: number;
  liveModelVersion: number;
  baseProjectHash: string;
  liveProjectHash: string;
  canApply: boolean;
}

export interface DraftSyncReceipt {
  syncId: string;
  draftId: string;
  runId: string;
  revision: number;
  hash: string;
  localVersion?: number;
  remoteVersion: number;
  baseModelVersion: number;
  baseProjectHash: string;
  workspaceId: string;
  newVersion: number;
  project: Project;
}

export interface ApplyExpectations {
  syncId?: string;
  runId: string;
  draftId: string;
  revision: number;
  draftHash: string;
  localVersion: number;
  remoteVersion: number;
  baseModelVersion?: number;
  baseProjectHash?: string;
}

function readSyncReceipts(value: unknown): DraftSyncReceipt[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const receipts: DraftSyncReceipt[] = [];
  for (const [syncId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const receipt = raw as Record<string, unknown>;
    if (
      receipt.syncId !== syncId || typeof receipt.draftId !== 'string' || !receipt.draftId ||
      typeof receipt.runId !== 'string' || typeof receipt.revision !== 'number' || !Number.isInteger(receipt.revision) ||
      typeof receipt.hash !== 'string' || typeof receipt.remoteVersion !== 'number' || !Number.isInteger(receipt.remoteVersion) ||
      typeof receipt.baseModelVersion !== 'number' || !Number.isInteger(receipt.baseModelVersion) ||
      typeof receipt.baseProjectHash !== 'string' || typeof receipt.workspaceId !== 'string' ||
      typeof receipt.newVersion !== 'number' || !Number.isInteger(receipt.newVersion) || !receipt.project || typeof receipt.project !== 'object' ||
      Array.isArray(receipt.project)
    ) continue;
    receipts.push(structuredClone(receipt as unknown as DraftSyncReceipt));
  }
  return receipts;
}

function storedWorkspaceIdentityConflict(raw: string): string | null {
  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return null; // 让标准 project-file parser 报告 JSON 错误。
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const record = envelope as Record<string, unknown>;
  const conflicts: string[] = [];
  const liveDuplicates = findDuplicateUnitIds(record.project);
  if (liveDuplicates.length) conflicts.push(unitIdentityConflictMessage('live project', liveDuplicates));
  const receipts = record.draftSyncReceipts;
  if (receipts && typeof receipts === 'object' && !Array.isArray(receipts)) {
    for (const [syncId, value] of Object.entries(receipts as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const receiptProject = (value as Record<string, unknown>).project;
      const duplicates = findDuplicateUnitIds(receiptProject);
      if (duplicates.length) conflicts.push(unitIdentityConflictMessage(`draftSyncReceipts[${syncId}].project`, duplicates));
    }
  }
  return conflicts.length ? conflicts.join(' ') : null;
}

function liveUnitIdentityConflict(project: Project): string | null {
  const duplicates = findDuplicateUnitIds(project);
  return duplicates.length ? unitIdentityConflictMessage('live project', duplicates) : null;
}

function failedExec(message: string): ExecResult {
  return {
    ok: false,
    error: message,
    diff: [],
    newIssues: [],
    resolvedIssues: [],
    derived: { panels: 0, pieces: 0, areaM2: 0, weightKg: 0 },
    clamped: [],
    blockingErrors: 0,
    memoryHits: [],
  };
}

export type ApplyResult =
  | DraftSyncReceipt & { ok: true }
  | {
      ok: false;
      code: DraftRejectCode | typeof WORKSPACE_UNIT_ID_CONFLICT | 'SYNC_ID_INVALID' | 'SYNC_ID_REUSED' | 'APPLY_METADATA_REQUIRED' | 'APPLY_METADATA_INVALID';
      message: string;
      draftId: string;
      baseVersion?: number;
      currentVersion: number;
      baseProjectHash?: string;
      currentProjectHash: string;
    };

// ── id 生成（稳定且进程内唯一，足够 S1；不依赖外部 id 服务）──
let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * 服务端草稿：从某个 baseModelVersion 的 live 快照 fork 出一份独立 CommandBus。
 * draft 内执行的 Command 只改 draft 自己的总线，**绝不触碰 live**。
 * apply 与否由持有它的 WorkspaceStore 用乐观锁裁决。
 */
class ServerDraft {
  readonly draftId: string;
  readonly runId: string;
  readonly workspaceId: string;
  readonly baseModelVersion: number;
  readonly baseProjectHash: string;
  readonly owner: string;
  readonly createdAt: string;
  private readonly bus: CommandBus;
  private revision: number;

  constructor(opts: {
    workspaceId: string;
    baseModelVersion: number;
    baseProjectHash: string;
    runId?: string;
    revision?: number;
    owner: string;
    project: Project;
    rules: RuleSet;
    /** 从磁盘恢复时传入，保留原 draftId；新建时缺省自动生成 */
    draftId?: string;
    createdAt?: string;
  }) {
    this.draftId = opts.draftId ?? nextId('draft');
    this.runId = opts.runId ?? nextId('run');
    this.workspaceId = opts.workspaceId;
    this.baseModelVersion = opts.baseModelVersion;
    this.baseProjectHash = opts.baseProjectHash;
    this.owner = opts.owner;
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    this.revision = Number.isInteger(opts.revision) && (opts.revision ?? -1) >= 0 ? opts.revision! : 0;
    // CommandBus 构造时会 structuredClone(project) ⇒ draft 与 live 物理隔离
    this.bus = new CommandBus(opts.project, opts.rules);
  }

  execute(cmd: Command): ExecResult {
    const result = this.bus.execute(cmd);
    if (result.ok) this.revision += 1;
    return result;
  }

  getRevision(): number {
    return this.revision;
  }

  getProjectHash(hashProject: ProjectHashFn): string {
    return hashProject(this.bus.getState());
  }

  getState(): Project {
    return this.bus.getState();
  }

  validate(): { issues: Issue[]; derived: DerivedSummary; blockingErrors: number } {
    const d = this.bus.derive();
    return { issues: d.issues, derived: this.bus.derivedSummary(), blockingErrors: d.issues.filter((i) => i.severity === 'ERROR').length };
  }

  handle(): DraftHandle {
    return {
      workspaceId: this.workspaceId,
      draftId: this.draftId,
      runId: this.runId,
      revision: this.revision,
      baseModelVersion: this.baseModelVersion,
      baseProjectHash: this.baseProjectHash,
      owner: this.owner,
    };
  }

  /**
   * 落盘形状：draft 是"未提交改动"，与 workspace 文件分开存放
   *（§8.3：`drafts/<draftId>.json`，落在数据卷上，容器重建不丢）。
   * 只存元数据 + project 快照；恢复时用同一份 rules 重建 CommandBus。
   */
  toJSON(): DraftFileShape {
    return {
      format: 'furniture-cad-draft',
      formatVersion: 2,
      draftId: this.draftId,
      runId: this.runId,
      revision: this.revision,
      workspaceId: this.workspaceId,
      baseModelVersion: this.baseModelVersion,
      baseProjectHash: this.baseProjectHash,
      owner: this.owner,
      createdAt: this.createdAt,
      project: this.bus.getState(),
    };
  }

  /** 从磁盘形状恢复（字段缺失/类型不对直接抛错，不降级、不静默修）。 */
  static fromJSON(obj: unknown, rules: RuleSet): ServerDraft {
    const o = obj as Record<string, unknown>;
    if (!o || o.format !== 'furniture-cad-draft' || typeof o.draftId !== 'string' || !o.draftId) {
      throw new Error('draft 文件格式非法：缺 format/draftId');
    }
    if (typeof o.workspaceId !== 'string' || typeof o.baseModelVersion !== 'number' || typeof o.owner !== 'string') {
      throw new Error(`draft 文件元数据非法：${o.draftId}`);
    }
    if (!o.project || typeof o.project !== 'object') {
      throw new Error(`draft 文件缺 project 快照：${o.draftId}`);
    }
    return new ServerDraft({
      draftId: o.draftId,
      runId: typeof o.runId === 'string' ? o.runId : String(o.draftId),
      revision: typeof o.revision === 'number' ? o.revision : 0,
      workspaceId: o.workspaceId,
      baseModelVersion: o.baseModelVersion,
      // v1 草稿没有基线 hash，恢复后按 stale 处理，不允许以缺失指纹绕过冲突检查。
      baseProjectHash: typeof o.baseProjectHash === 'string' ? o.baseProjectHash : '',
      owner: o.owner,
      project: o.project as Project,
      rules,
      createdAt: typeof o.createdAt === 'string' ? o.createdAt : undefined,
    });
  }
}

/** draft 落盘文件形状（与 workspace 文件分开，不污染 projectFile 信封）。 */
export interface DraftFileShape {
  format: 'furniture-cad-draft';
  formatVersion: 2;
  draftId: string;
  runId: string;
  revision: number;
  workspaceId: string;
  baseModelVersion: number;
  baseProjectHash: string;
  owner: string;
  createdAt: string;
  project: Project;
}

/** draft 落盘：content 为 null = 删除文件（apply/discard 后调用）。 */
export type DraftPersistFn = (draftId: string, content: string | null) => Promise<void>;
/** draft 装载：返回全部 draft 文件的原始字符串（读不进队列，解析失败由调用方处理）。 */
export type DraftLoadFn = () => Promise<Array<{ draftId: string; content: string }>>;
/** 隔离无法恢复的 draft 文件，避免每次启动重复加载损坏内容。 */
export type DraftQuarantineFn = (draftId: string, reason: string) => Promise<void>;

export interface WorkspaceStoreOpts {
  filePath: string;
  rules: RuleSet;
  persist: PersistFn;
  workspaceId: string;
  owner: string;
  account: string;
  liveModelVersion: number;
  updatedAt: string;
  bus: CommandBus;
  /**
   * draft 持久化（S4）：按 §8.3 落盘到数据卷，容器重建不丢。
   * 缺省（测试）= 纯内存，与 S1 行为一致。
   */
  persistDraft?: DraftPersistFn;
  loadDrafts?: DraftLoadFn;
  quarantineDraft?: DraftQuarantineFn;
  projectHash?: ProjectHashFn;
  syncReceipts?: DraftSyncReceipt[];
  identityConflict?: string | null;
}

/**
 * Workspace 持有实体：服务端一侧的「项目状态」。
 * 一份 workspace 只有一个可写端点（live model 由本 store 独占），
 * 与 P10.0 架构审查 IR-1「不夺走浏览器本地所有权」一致。
 */
export class WorkspaceStore {
  readonly workspaceId: string;
  readonly owner: string;
  readonly account: string;
  private readonly rules: RuleSet;
  private readonly filePath: string;
  private readonly persist: PersistFn;
  private bus: CommandBus;
  private liveModelVersion: number;
  private updatedAt: string;
  private readonly drafts = new Map<string, ServerDraft>();
  private readonly syncReceipts = new Map<string, DraftSyncReceipt>();
  private readonly persistDraft?: DraftPersistFn;
  private readonly loadDrafts?: DraftLoadFn;
  private readonly quarantineDraft?: DraftQuarantineFn;
  private readonly projectHash: ProjectHashFn;
  private loadedIdentityConflict: string | null;
  private liveWriteTail: Promise<void> = Promise.resolve();

  private constructor(opts: WorkspaceStoreOpts) {
    this.workspaceId = opts.workspaceId;
    this.owner = opts.owner;
    this.account = opts.account;
    this.rules = opts.rules;
    this.filePath = opts.filePath;
    this.persist = opts.persist;
    this.bus = opts.bus;
    this.liveModelVersion = opts.liveModelVersion;
    this.updatedAt = opts.updatedAt;
    this.persistDraft = opts.persistDraft;
    this.loadDrafts = opts.loadDrafts;
    this.quarantineDraft = opts.quarantineDraft;
    this.projectHash = opts.projectHash ?? fallbackProjectHash;
    this.loadedIdentityConflict = opts.identityConflict ?? null;
    for (const receipt of opts.syncReceipts ?? []) this.syncReceipts.set(receipt.syncId, structuredClone(receipt));
  }

  /** 新建一个空（或示例）Workspace。 */
  static create(opts: {
    filePath: string;
    rules: RuleSet;
    persist: PersistFn;
    owner?: string;
    account?: string;
    project?: Project;
    persistDraft?: DraftPersistFn;
    loadDrafts?: DraftLoadFn;
    quarantineDraft?: DraftQuarantineFn;
    projectHash?: ProjectHashFn;
  }): WorkspaceStore {
    const project = opts.project ?? sampleProject(opts.rules);
    const duplicates = findDuplicateUnitIds(project);
    if (duplicates.length) throw unitIdentityConflictError('new project', duplicates);
    const bus = new CommandBus(project, opts.rules);
    return new WorkspaceStore({
      filePath: opts.filePath,
      rules: opts.rules,
      persist: opts.persist,
      workspaceId: nextId('ws'),
      owner: opts.owner ?? 'local-open',
      account: opts.account ?? opts.owner ?? 'local-open',
      liveModelVersion: 0,
      updatedAt: new Date().toISOString(),
      bus,
      persistDraft: opts.persistDraft,
      loadDrafts: opts.loadDrafts,
      quarantineDraft: opts.quarantineDraft,
      projectHash: opts.projectHash,
      syncReceipts: [],
    });
  }

  /** 从磁盘加载一个已存在的 Workspace（读不进队列；解析失败直接抛错，不降级）。 */
  static load(opts: {
    filePath: string;
    rules: RuleSet;
    persist: PersistFn;
    readRaw: ReadRawFn;
    persistDraft?: DraftPersistFn;
    loadDrafts?: DraftLoadFn;
    quarantineDraft?: DraftQuarantineFn;
    projectHash?: ProjectHashFn;
  }): WorkspaceStore {
    const raw = opts.readRaw();
    const identityConflict = storedWorkspaceIdentityConflict(raw);
    const parsed = parseProjectFile(raw, { allowDuplicateUnitIds: true });
    if (!parsed.ok) throw new Error(`Workspace 文件不是合法项目文件：${parsed.error}`);
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error('Workspace 文件 JSON 解析失败');
    }
    const meta: WorkspaceMeta = {
      workspaceId: typeof env.workspaceId === 'string' ? env.workspaceId : nextId('ws'),
      owner: typeof env.owner === 'string' ? env.owner : 'local-open',
      account: typeof env.account === 'string' ? env.account : 'local-open',
      updatedAt: typeof env.updatedAt === 'string' ? env.updatedAt : new Date().toISOString(),
      // liveModelVersion 是 Workspace 的并发版本，必须随文件持久化；缺省按 0 起
      liveModelVersion:
        typeof env.liveModelVersion === 'number' && Number.isInteger(env.liveModelVersion) && env.liveModelVersion >= 0
          ? env.liveModelVersion
          : 0,
    };
    const bus = new CommandBus(parsed.project, opts.rules);
    return new WorkspaceStore({
      filePath: opts.filePath,
      rules: opts.rules,
      persist: opts.persist,
      workspaceId: meta.workspaceId,
      owner: meta.owner,
      account: meta.account,
      liveModelVersion: meta.liveModelVersion,
      updatedAt: meta.updatedAt,
      bus,
      persistDraft: opts.persistDraft,
      loadDrafts: opts.loadDrafts,
      quarantineDraft: opts.quarantineDraft,
      projectHash: opts.projectHash,
      syncReceipts: readSyncReceipts(env.draftSyncReceipts),
      identityConflict,
    });
  }

  /** Stable, user-readable diagnostics shared by every read and write surface. */
  getUnitIdentityDiagnostics(): {
    readOnly: boolean;
    code: typeof WORKSPACE_UNIT_ID_CONFLICT | null;
    message: string | null;
    duplicateUnitIds: Array<{ id: string; scope: string; locations: string[] }>;
  } {
    const conflicts: Array<{ scope: string; duplicates: Array<{ id: string; locations: string[] }> }> = [];
    const add = (scope: string, project: unknown) => {
      const duplicates = findDuplicateUnitIds(project);
      if (duplicates.length) conflicts.push({ scope, duplicates });
    };
    add('live project', this.bus.getState());
    for (const [syncId, receipt] of this.syncReceipts) add(`draftSyncReceipts[${syncId}].project`, receipt.project);
    for (const [draftId, draft] of this.drafts) add(`draft ${draftId}`, draft.getState());

    const messages: string[] = [];
    if (this.loadedIdentityConflict) messages.push(this.loadedIdentityConflict);
    for (const conflict of conflicts) {
      const message = unitIdentityConflictMessage(conflict.scope, conflict.duplicates);
      if (!messages.some((existing) => existing.includes(message))) messages.push(message);
    }
    return {
      readOnly: messages.length > 0,
      code: messages.length > 0 ? WORKSPACE_UNIT_ID_CONFLICT : null,
      message: messages.length > 0 ? messages.join(' ') : null,
      duplicateUnitIds: conflicts.flatMap(({ scope, duplicates }) => duplicates.map(({ id, locations }) => ({ id, scope, locations: [...locations] }))),
    };
  }

  /** Read-only status shared by HTTP/MCP writers; a duplicate live/receipt/draft keeps the whole workspace closed. */
  getUnitIdentityConflict(): string | null {
    return this.getUnitIdentityDiagnostics().message;
  }

  // ── 读 ──
  getLiveModelVersion(): number {
    return this.liveModelVersion;
  }
  getState(): Project {
    return this.bus.getState();
  }
  getUpdatedAt(): string {
    return this.updatedAt;
  }
  getFilePath(): string {
    return this.filePath;
  }
  /**
   * 只读：底层 CommandBus 的内部 modelVersion。
   * 与 liveModelVersion 是**两层**：前者是总线自己的版本计数（每次提交 +1），
   * 后者是 Workspace 的并发版本（draft 乐观锁依据）。两者都如实报出，不做归一化。
   */
  getModelVersion(): number {
    return this.bus.getVersion();
  }

  /**
   * 只读：当前 live 语义模型的**深拷贝**。
   *
   * 为什么返回拷贝而不是内部引用：只读消费者（MCP `cad.get_state` / `cad.validate`）
   * 拿到的对象绝不允许成为改模型的旁路 —— 直接递出 `bus.getState()` 就等于
   * 把"唯一写入口"这条宪法开了个后门。拷贝代价在只读路径上可以接受。
   */
  getProjectSnapshot(): Project {
    return structuredClone(this.bus.getState());
  }

  /**
   * 只读校验 / 派生：跑**现有** CommandBus.derive()（其内部已含 validateCabinet、
   * 转角干涉、装配关系、空间校验）并取派生汇总。
   * · 不新建 validator、不另立一套验证体系；
   * · 不改 live、不落盘、无副作用（derive 结果按 modelVersion 缓存，读多少次都一样）。
   */
  validate(): { issues: Issue[]; derived: DerivedSummary; blockingErrors: number } {
    const d = this.bus.derive();
    return {
      issues: d.issues,
      // 派生汇总同样只从总线取（sumDerived 的唯一实现），不在下游重算
      derived: this.bus.derivedSummary(),
      blockingErrors: d.issues.filter((i) => i.severity === 'ERROR').length,
    };
  }

  /** 只读校验指定草稿；复用草稿自己的 CommandBus 派生，与 live validator 同源。 */
  validateDraft(draftId: string): { issues: Issue[]; derived: DerivedSummary; blockingErrors: number } | null {
    return this.drafts.get(draftId)?.validate() ?? null;
  }

  /**
   * 把当前 live 状态落盘一次（首次建立实体时调用；不改变模型内容，只写文件）。
   * 写入仍经注入的 persist ⇒ 走同一个进程内串行写队列。
   */
  async save(): Promise<void> {
    await this.flush();
  }

  private serializeWorkspace(
    project: Project,
    liveModelVersion: number,
    updatedAt: string,
    receipts: Map<string, DraftSyncReceipt>,
  ): string {
    const envelope = JSON.parse(serializeProjectFile(project, updatedAt)) as Record<string, unknown>;
    envelope.workspaceId = this.workspaceId;
    envelope.owner = this.owner;
    envelope.account = this.account;
    envelope.liveModelVersion = liveModelVersion;
    envelope.updatedAt = updatedAt;
    if (receipts.size > 0) {
      envelope.draftSyncReceipts = Object.fromEntries([...receipts.entries()].map(([id, receipt]) => [id, structuredClone(receipt)]));
    } else {
      delete envelope.draftSyncReceipts;
    }
    return JSON.stringify(envelope, null, 2);
  }

  private async persistSnapshot(
    project: Project,
    liveModelVersion: number,
    receipts: Map<string, DraftSyncReceipt>,
  ): Promise<string> {
    const identityConflict = this.getUnitIdentityConflict();
    if (identityConflict) throw Object.assign(new Error(identityConflict), { code: WORKSPACE_UNIT_ID_CONFLICT });
    const liveDuplicates = findDuplicateUnitIds(project);
    if (liveDuplicates.length) throw Object.assign(new Error(unitIdentityConflictMessage('live project', liveDuplicates)), { code: WORKSPACE_UNIT_ID_CONFLICT });
    for (const [syncId, receipt] of receipts) {
      const receiptDuplicates = findDuplicateUnitIds(receipt.project);
      if (receiptDuplicates.length) {
        throw Object.assign(new Error(unitIdentityConflictMessage(`draftSyncReceipts[${syncId}].project`, receiptDuplicates)), { code: WORKSPACE_UNIT_ID_CONFLICT });
      }
    }
    const savedAt = new Date().toISOString();
    await this.persist(this.serializeWorkspace(project, liveModelVersion, savedAt, receipts));
    return savedAt;
  }

  private async flush(): Promise<void> {
    const savedAt = await this.persistSnapshot(this.bus.getState(), this.liveModelVersion, this.syncReceipts);
    this.updatedAt = savedAt;
  }

  private async serializeLiveWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.liveWriteTail;
    let release!: () => void;
    this.liveWriteTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * 服务端写模型的唯一入口：所有变更**只经现有 CommandBus**（含路径白名单校验）。
   * requireAuth 是 HTTP 层关注点；S1 无 HTTP，由调用方保证 actor 合法。
   * 提交成功才 bump 并发版本并落盘。
   */
  async execute(cmd: Command): Promise<ExecResult> {
    return this.serializeLiveWrite(async () => {
      const identityConflict = this.getUnitIdentityConflict();
      if (identityConflict) return failedExec(identityConflict);
      // ── 唯一写入口：模型变更只允许经 CommandBus（其 plan() 内含 WRITABLE/DENY 白名单）──
      const r = this.bus.execute(cmd);
      if (r.ok) {
        this.liveModelVersion += 1;
        await this.flush();
      }
      return r;
    });
  }

  /** 创建草稿：从当前 live 快照 fork，并同时记录基线 version + SHA-256 项目 hash。 */
  async createDraft(owner: string): Promise<DraftHandle> {
    return this.serializeLiveWrite(async () => {
      const project = this.bus.getState();
      const identityConflict = this.getUnitIdentityConflict();
      if (identityConflict) throw Object.assign(new Error(identityConflict), { code: WORKSPACE_UNIT_ID_CONFLICT });
      const draft = new ServerDraft({
        workspaceId: this.workspaceId,
        baseModelVersion: this.liveModelVersion,
        baseProjectHash: this.projectHash(project),
        owner,
        project,
        rules: this.rules,
      });
      if (this.persistDraft) {
        await this.persistDraft(draft.draftId, JSON.stringify(draft.toJSON(), null, 2));
      }
      this.drafts.set(draft.draftId, draft);
      return draft.handle();
    });
  }

  getDraft(draftId: string): DraftHandle | null {
    const d = this.drafts.get(draftId);
    return d ? d.handle() : null;
  }

  private freshnessFor(draft: ServerDraft): DraftFreshness {
    const liveProjectHash = this.projectHash(this.bus.getState());
    const baseProjectHash = draft.baseProjectHash;
    const draftHash = draft.getProjectHash(this.projectHash);
    const staleReason = !baseProjectHash
      ? 'base_hash_missing'
      : this.liveModelVersion !== draft.baseModelVersion
        ? 'version_mismatch'
        : liveProjectHash !== baseProjectHash
          ? 'hash_mismatch'
          : null;
    return {
      runId: draft.runId,
      revision: draft.getRevision(),
      draftHash,
      isStale: staleReason !== null,
      staleReason,
      baseModelVersion: draft.baseModelVersion,
      liveModelVersion: this.liveModelVersion,
      baseProjectHash,
      liveProjectHash,
      canApply: staleReason === null,
    };
  }

  getDraftFreshness(draftId: string): DraftFreshness | null {
    const draft = this.drafts.get(draftId);
    return draft ? this.freshnessFor(draft) : null;
  }

  /** draft 内执行 Command：只改 draft 总线，live 不变。 */
  async draftExecute(draftId: string, cmd: Command): Promise<ExecResult> {
    return this.serializeLiveWrite(async () => {
      const workspaceConflict = this.getUnitIdentityConflict();
      if (workspaceConflict) return failedExec(workspaceConflict);
      const d = this.drafts.get(draftId);
      if (!d) {
        return {
          ok: false,
          error: `draft 不存在：${draftId}`,
          diff: [],
          newIssues: [],
          resolvedIssues: [],
          derived: { panels: 0, pieces: 0, areaM2: 0, weightKg: 0 },
          clamped: [],
          blockingErrors: 0,
          memoryHits: [],
        };
      }
      const draftConflict = liveUnitIdentityConflict(d.getState());
      if (draftConflict) return failedExec(draftConflict.replace('live project', `draft ${draftId}`));
      // 命令先在私有候选 draft 上执行；落盘成功后才替换内存版本。
      const candidate = ServerDraft.fromJSON(d.toJSON(), this.rules);
      const result = candidate.execute(cmd);
      if (!result.ok) return result;
      if (this.persistDraft) {
        await this.persistDraft(draftId, JSON.stringify(candidate.toJSON(), null, 2));
      }
      this.drafts.set(draftId, candidate);
      return result;
    });
  }

  draftState(draftId: string): Project | null {
    const d = this.drafts.get(draftId);
    return d ? d.getState() : null;
  }

  /**
   * apply 草稿：乐观锁。
   * 仅当 liveModelVersion === baseModelVersion 才应用（用现有 CommandBus.replaceProject
   * 把 live 整体替换为 draft 终态，版本 +1）；否则结构化拒绝 DRAFT_STALE，
   * **不自动 merge、不 last-write-wins、不静默覆盖**，live 与 draft 都原样保留。
   */
  async applyDraft(draftId: string, request: ApplyExpectations): Promise<ApplyResult> {
    return this.serializeLiveWrite(() => this.applyDraftSerialized(draftId, request));
  }

  private async applyDraftSerialized(draftId: string, request: ApplyExpectations): Promise<ApplyResult> {
    const expected = request as Partial<ApplyExpectations> | null | undefined;
    const currentProject = this.bus.getState();
    const currentProjectHash = this.projectHash(currentProject);
    const identityConflict = this.getUnitIdentityConflict();
    if (identityConflict) {
      return {
        ok: false,
        code: WORKSPACE_UNIT_ID_CONFLICT,
        message: identityConflict,
        draftId,
        currentVersion: this.liveModelVersion,
        currentProjectHash,
      };
    }
    if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
      return {
        ok: false,
        code: 'APPLY_METADATA_REQUIRED',
        message: 'apply 必须提供完整的 runId/draftId/revision/draftHash/localVersion/remoteVersion 确认元数据。',
        draftId,
        currentVersion: this.liveModelVersion,
        currentProjectHash,
      };
    }
    const syncId = expected.syncId ?? `draft:${draftId}`;
    const required = ['runId', 'draftId', 'revision', 'draftHash', 'localVersion', 'remoteVersion'] as const;
    const missing = required.filter((field) => expected[field] === undefined || expected[field] === null || expected[field] === '');
    if (missing.length > 0) {
      return {
        ok: false,
        code: 'APPLY_METADATA_REQUIRED',
        message: `apply 缺少完整确认字段：${missing.join('、')}。`,
        draftId,
        currentVersion: this.liveModelVersion,
        currentProjectHash,
      };
    }
    if (typeof expected.runId !== 'string' || !expected.runId.trim() || expected.runId.length > 200
      || typeof expected.draftId !== 'string' || !expected.draftId.trim() || expected.draftId.length > 200
      || !Number.isSafeInteger(expected.revision) || expected.revision! < 0
      || typeof expected.draftHash !== 'string' || !expected.draftHash.trim()
      || !Number.isSafeInteger(expected.localVersion) || expected.localVersion! < 0
      || !Number.isSafeInteger(expected.remoteVersion) || expected.remoteVersion! < 0) {
      return {
        ok: false,
        code: 'APPLY_METADATA_INVALID',
        message: 'runId/draftId/draftHash 必须有效；revision/localVersion/remoteVersion 必须是非负安全整数。',
        draftId,
        currentVersion: this.liveModelVersion,
        currentProjectHash,
      };
    }
    if (typeof syncId !== 'string' || !syncId.trim() || syncId.length > 200) {
      return {
        ok: false,
        code: 'SYNC_ID_INVALID',
        message: 'syncId 必须是 1–200 个字符的非空字符串。',
        draftId,
        currentVersion: this.liveModelVersion,
        currentProjectHash,
      };
    }
    const prior = this.syncReceipts.get(syncId);
    if (prior) {
      const receiptDuplicates = findDuplicateUnitIds(prior.project);
      if (receiptDuplicates.length) {
        return {
          ok: false,
          code: WORKSPACE_UNIT_ID_CONFLICT,
          message: unitIdentityConflictMessage(`sync receipt ${syncId}.project`, receiptDuplicates),
          draftId,
          currentVersion: this.liveModelVersion,
          currentProjectHash,
        };
      }
      const receiptMismatch = prior.draftId !== draftId
        || expected.draftId !== prior.draftId
        || expected.runId !== prior.runId
        || expected.revision !== prior.revision
        || expected.draftHash !== prior.hash
        || expected.localVersion !== prior.localVersion
        || expected.remoteVersion !== prior.remoteVersion
        || (expected.baseModelVersion !== undefined && expected.baseModelVersion !== prior.baseModelVersion)
        || (expected.baseProjectHash !== undefined && expected.baseProjectHash !== prior.baseProjectHash);
      if (receiptMismatch) {
        return {
          ok: false,
          code: 'SYNC_ID_REUSED',
          message: `syncId ${syncId} 已绑定另一组草稿/确认元数据，拒绝把它用于 draft ${draftId}。`,
          draftId,
          currentVersion: this.liveModelVersion,
          currentProjectHash,
        };
      }
      // 收据和 live 已原子提交；重试时只清理残留草稿文件，不重复改写模型。
      await this.retireCommittedDraftFile(draftId, prior, '同 syncId 重试时清理已应用的草稿文件');
      this.drafts.delete(draftId);
      return { ok: true, ...structuredClone(prior) };
    }
    const d = this.drafts.get(draftId);
    if (!d) {
      return {
        ok: false,
        code: DRAFT_STALE,
        message: `draft 不存在：${draftId}；没有可回放的 sync receipt。`,
        draftId,
        currentVersion: this.liveModelVersion,
        currentProjectHash,
      };
    }
    const draftConflict = findDuplicateUnitIds(d.getState());
    if (draftConflict.length) {
      return {
        ok: false,
        code: WORKSPACE_UNIT_ID_CONFLICT,
        message: unitIdentityConflictMessage(`draft ${draftId}`, draftConflict),
        draftId,
        currentVersion: this.liveModelVersion,
        currentProjectHash,
      };
    }
    const freshness = this.freshnessFor(d);
    const metadataMismatch = expected.draftId !== draftId
      || expected.runId !== freshness.runId
      || expected.revision !== freshness.revision
      || expected.draftHash !== freshness.draftHash
      || expected.remoteVersion !== freshness.liveModelVersion
      || (expected.baseModelVersion !== undefined && expected.baseModelVersion !== freshness.baseModelVersion)
      || (expected.baseProjectHash !== undefined && expected.baseProjectHash !== freshness.baseProjectHash);
    if (metadataMismatch || freshness.isStale) {
      return {
        ok: false,
        code: DRAFT_STALE,
        message: `草稿确认元数据或基线与当前 live 不一致，已拒绝应用且未修改 live（metadataMismatch=${metadataMismatch}；staleReason=${freshness.staleReason}；runId=${freshness.runId}；revision=${freshness.revision}；draftHash=${freshness.draftHash}；base version/hash=${freshness.baseModelVersion}/${freshness.baseProjectHash || 'missing'}；live version/hash=${freshness.liveModelVersion}/${freshness.liveProjectHash}）。请重新预览并创建草稿。`,
        draftId,
        baseVersion: freshness.baseModelVersion,
        currentVersion: freshness.liveModelVersion,
        baseProjectHash: freshness.baseProjectHash,
        currentProjectHash: freshness.liveProjectHash,
      };
    }
    // 纯预演与普通 replaceProject 共用关系 reconcile。预演期间不触碰 live ledger；
    // 先将规范化 Project + receipt 原子落盘，成功后再提交完全相同的预演结果。
    const preparedProject = this.bus.prepareProjectReplacement(d.getState());
    const project = preparedProject.project;
    const nextVersion = this.liveModelVersion + 1;
    const receipt: DraftSyncReceipt = {
      syncId,
      draftId,
      runId: freshness.runId,
      revision: freshness.revision,
      hash: freshness.draftHash,
      localVersion: expected.localVersion,
      remoteVersion: freshness.liveModelVersion,
      baseModelVersion: freshness.baseModelVersion,
      baseProjectHash: freshness.baseProjectHash,
      workspaceId: this.workspaceId,
      newVersion: nextVersion,
      project,
    };
    const nextReceipts = new Map(this.syncReceipts);
    nextReceipts.set(syncId, structuredClone(receipt));
    const savedAt = await this.persistSnapshot(project, nextVersion, nextReceipts);

    // 原子 workspace 已提交后，才发布内存状态并清理 draft 文件。
    this.bus.replacePreparedProject(preparedProject, `apply draft ${d.draftId}`);
    this.liveModelVersion = nextVersion;
    this.updatedAt = savedAt;
    this.syncReceipts.set(syncId, structuredClone(receipt));
    this.drafts.delete(draftId);
    await this.retireCommittedDraftFile(draftId, receipt, 'apply 已提交后清理草稿文件');
    return { ok: true, ...structuredClone(receipt) };
  }

  /** 丢弃草稿（按归属控制由调用方负责；S1 不在此做权限判定，权限是 HTTP 层职责）。 */
  async discardDraft(draftId: string): Promise<boolean> {
    return this.serializeLiveWrite(async () => {
      const identityConflict = this.getUnitIdentityConflict();
      if (identityConflict) throw Object.assign(new Error(identityConflict), { code: WORKSPACE_UNIT_ID_CONFLICT });
      if (!this.drafts.has(draftId)) return false;
      // 先删除持久文件；unlink 失败时内存 draft 必须仍可见、可重试。
      await this.deleteDraftFile(draftId);
      return this.drafts.delete(draftId);
    });
  }

  /** MCP 写工具需要的规则集（构造 Cabinet / 编译 Proposal 用）。只读，不递引用。 */
  getRules(): RuleSet {
    return this.rules;
  }

  /** 列出内存中的全部 draft（含归属与创建时间，供 cad.list_drafts）。 */
  listDrafts(): Array<DraftHandle & DraftFreshness & { createdAt: string }> {
    return [...this.drafts.values()].map((d) => ({ ...d.handle(), ...this.freshnessFor(d), createdAt: d.createdAt }));
  }

  /**
   * 把指定 draft 落盘（S4）。
   * 调用方（MCP 写工具）在 createDraft / draftExecute 成功后显式调用 ——
   * 与 Workspace.execute() "提交成功才落盘"同一条纪律：没落盘就不算成功。
   */
  async saveDraft(draftId: string): Promise<void> {
    const identityConflict = this.getUnitIdentityConflict();
    if (identityConflict) throw Object.assign(new Error(identityConflict), { code: WORKSPACE_UNIT_ID_CONFLICT });
    if (!this.persistDraft) return;
    const d = this.drafts.get(draftId);
    if (!d) throw new Error(`draft 不存在，无法落盘：${draftId}`);
    await this.persistDraft(draftId, JSON.stringify(d.toJSON(), null, 2));
  }

  /** 删除 draft 文件（apply/discard 后调用；文件不存在也不报错，幂等）。 */
  async deleteDraftFile(draftId: string): Promise<void> {
    const identityConflict = this.getUnitIdentityConflict();
    if (identityConflict) throw Object.assign(new Error(identityConflict), { code: WORKSPACE_UNIT_ID_CONFLICT });
    if (!this.persistDraft) return;
    await this.persistDraft(draftId, null);
  }

  private async retireCommittedDraftFile(draftId: string, receipt: DraftSyncReceipt, reason: string): Promise<void> {
    try {
      await this.retireDraftFile(draftId, reason);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw Object.assign(new Error(
        `apply 已持久提交 live 与 sync receipt，但草稿删除/隔离失败（${detail}）；live 不会回滚。请使用相同 syncId=${receipt.syncId} 和相同完整确认元数据安全重试以回放收据。`,
      ), {
        code: 'APPLY_COMMITTED_CLEANUP_FAILED',
        committed: true,
        retryable: true,
        syncId: receipt.syncId,
        draftId,
        newVersion: receipt.newVersion,
        receipt: structuredClone(receipt),
      });
    }
  }

  private async quarantineDraftFile(draftId: string, reason: string): Promise<void> {
    if (this.quarantineDraft) {
      await this.quarantineDraft(draftId, reason);
      return;
    }
    await this.deleteDraftFile(draftId);
  }

  private async retireDraftFile(draftId: string, reason: string): Promise<void> {
    try {
      await this.deleteDraftFile(draftId);
    } catch (error) {
      // 已提交的 live+receipt 不可回滚；隔离残留 draft，避免重启后重新出现。
      try {
        await this.quarantineDraftFile(draftId, `${reason}: ${String(error)}`);
      } catch {
        throw error;
      }
    }
  }

  /**
   * 启动时从磁盘恢复 draft（S4）。
   * 单个文件坏了只跳过该文件（记下 id），不让一个坏草稿拦住整个工作区装载；
   * 返回成功恢复的 draftId 列表，调用方决定是否告警。
   */
  async loadPersistedDrafts(): Promise<{ loaded: string[]; skipped: string[] }> {
    const loaded: string[] = [];
    const skipped: string[] = [];
    if (!this.loadDrafts) return { loaded, skipped };
    const files = await this.loadDrafts();
    for (const f of files) {
      let rawDraft: unknown;
      try { rawDraft = JSON.parse(f.content); } catch { /* handled by normal draft parser below */ }
      const rawProject = rawDraft && typeof rawDraft === 'object' ? (rawDraft as Record<string, unknown>).project : undefined;
      const rawDuplicates = findDuplicateUnitIds(rawProject);
      if (rawDuplicates.length) {
        this.loadedIdentityConflict ??= unitIdentityConflictMessage(`persisted draft ${f.draftId}`, rawDuplicates);
        // A structurally valid duplicate draft remains available to read-only draft
        // views. Workspace identityConflict blocks every writer before it can use it.
        try {
          const draft = ServerDraft.fromJSON(rawDraft, this.rules);
          if (draft.draftId !== f.draftId || draft.workspaceId !== this.workspaceId) {
            skipped.push(f.draftId);
            continue;
          }
          this.drafts.set(draft.draftId, draft);
          loaded.push(draft.draftId);
        } catch {
          skipped.push(f.draftId);
        }
        continue; // never quarantine or rewrite a duplicate-identity recovery source.
      }
      let draft: ServerDraft;
      try {
        draft = ServerDraft.fromJSON(JSON.parse(f.content), this.rules);
      } catch (error) {
        skipped.push(f.draftId);
        if (this.getUnitIdentityConflict()) continue;
        await this.quarantineDraftFile(f.draftId, `损坏或非法 draft JSON/schema: ${String(error)}`);
        continue;
      }
      if (draft.draftId !== f.draftId) {
        skipped.push(f.draftId);
        if (this.getUnitIdentityConflict()) continue;
        await this.quarantineDraftFile(f.draftId, `文件名 draftId 与内容不一致：${draft.draftId}`);
        continue;
      }
      if (draft.workspaceId !== this.workspaceId || this.freshnessFor(draft).isStale) {
        skipped.push(f.draftId);
        if (this.getUnitIdentityConflict()) continue;
        await this.retireDraftFile(f.draftId, '工作区不匹配或草稿基线已过期');
        continue;
      }
      this.drafts.set(draft.draftId, draft);
      loaded.push(draft.draftId);
    }
    return { loaded, skipped };
  }
}
