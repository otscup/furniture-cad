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

/** 落盘函数：调用方把「内存真相」序列化成字符串传入，队列只负责原子有序写。 */
export type PersistFn = (content: string) => Promise<void>;
/** 读盘函数：返回 Workspace 文件的原始字符串（读不进队列，但失败由调用方处理）。 */
export type ReadRawFn = () => string;

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
}

export interface DraftHandle {
  workspaceId: string;
  draftId: string;
  baseModelVersion: number;
  owner: string;
}

export type ApplyResult =
  | { ok: true; newVersion: number }
  | { ok: false; code: DraftRejectCode; message: string };

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
  readonly workspaceId: string;
  readonly baseModelVersion: number;
  readonly owner: string;
  readonly createdAt: string;
  private readonly bus: CommandBus;

  constructor(opts: {
    workspaceId: string;
    baseModelVersion: number;
    owner: string;
    project: Project;
    rules: RuleSet;
    /** 从磁盘恢复时传入，保留原 draftId；新建时缺省自动生成 */
    draftId?: string;
    createdAt?: string;
  }) {
    this.draftId = opts.draftId ?? nextId('draft');
    this.workspaceId = opts.workspaceId;
    this.baseModelVersion = opts.baseModelVersion;
    this.owner = opts.owner;
    this.createdAt = opts.createdAt ?? new Date().toISOString();
    // CommandBus 构造时会 structuredClone(project) ⇒ draft 与 live 物理隔离
    this.bus = new CommandBus(opts.project, opts.rules);
  }

  execute(cmd: Command): ExecResult {
    return this.bus.execute(cmd);
  }

  getState(): Project {
    return this.bus.getState();
  }

  handle(): DraftHandle {
    return {
      workspaceId: this.workspaceId,
      draftId: this.draftId,
      baseModelVersion: this.baseModelVersion,
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
      formatVersion: 1,
      draftId: this.draftId,
      workspaceId: this.workspaceId,
      baseModelVersion: this.baseModelVersion,
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
      workspaceId: o.workspaceId,
      baseModelVersion: o.baseModelVersion,
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
  formatVersion: 1;
  draftId: string;
  workspaceId: string;
  baseModelVersion: number;
  owner: string;
  createdAt: string;
  project: Project;
}

/** draft 落盘：content 为 null = 删除文件（apply/discard 后调用）。 */
export type DraftPersistFn = (draftId: string, content: string | null) => Promise<void>;
/** draft 装载：返回全部 draft 文件的原始字符串（读不进队列，解析失败由调用方处理）。 */
export type DraftLoadFn = () => Promise<Array<{ draftId: string; content: string }>>;

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
  private readonly persistDraft?: DraftPersistFn;
  private readonly loadDrafts?: DraftLoadFn;

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
  }): WorkspaceStore {
    const project = opts.project ?? sampleProject(opts.rules);
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
  }): WorkspaceStore {
    const raw = opts.readRaw();
    const parsed = parseProjectFile(raw);
    if (!parsed.ok) {
      throw new Error(`Workspace 文件不是合法项目文件：${parsed.error}`);
    }
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
    });
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

  /**
   * 把当前 live 状态落盘一次（首次建立实体时调用；不改变模型内容，只写文件）。
   * 写入仍经注入的 persist ⇒ 走同一个进程内串行写队列。
   */
  async save(): Promise<void> {
    await this.flush();
  }

  private async flush(): Promise<void> {
    const savedAt = new Date().toISOString();
    this.updatedAt = savedAt;
    const envelope = JSON.parse(serializeProjectFile(this.bus.getState(), savedAt)) as Record<string, unknown>;
    envelope.workspaceId = this.workspaceId;
    envelope.owner = this.owner;
    envelope.account = this.account;
    envelope.liveModelVersion = this.liveModelVersion;
    envelope.updatedAt = this.updatedAt;
    await this.persist(JSON.stringify(envelope, null, 2));
  }

  /**
   * 服务端写模型的唯一入口：所有变更**只经现有 CommandBus**（含路径白名单校验）。
   * requireAuth 是 HTTP 层关注点；S1 无 HTTP，由调用方保证 actor 合法。
   * 提交成功才 bump 并发版本并落盘。
   */
  async execute(cmd: Command): Promise<ExecResult> {
    // ── 唯一写入口：模型变更只允许经 CommandBus（其 plan() 内含 WRITABLE/DENY 白名单）──
    const r = this.bus.execute(cmd);
    if (r.ok) {
      this.liveModelVersion += 1;
      await this.flush();
    }
    return r;
  }

  /** 创建草稿：从当前 live 快照 fork，base = 当前 liveModelVersion。 */
  createDraft(owner: string): DraftHandle {
    const draft = new ServerDraft({
      workspaceId: this.workspaceId,
      baseModelVersion: this.liveModelVersion,
      owner,
      project: this.bus.getState(),
      rules: this.rules,
    });
    this.drafts.set(draft.draftId, draft);
    return draft.handle();
  }

  getDraft(draftId: string): DraftHandle | null {
    const d = this.drafts.get(draftId);
    return d ? d.handle() : null;
  }

  /** draft 内执行 Command：只改 draft 总线，live 不变。 */
  draftExecute(draftId: string, cmd: Command): ExecResult {
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
    // draft 命令只作用于 draft 自己的总线；绝不写 live
    return d.execute(cmd);
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
  async applyDraft(draftId: string): Promise<ApplyResult> {
    const d = this.drafts.get(draftId);
    if (!d) {
      return { ok: false, code: DRAFT_STALE, message: `draft 不存在：${draftId}` };
    }
    if (this.liveModelVersion !== d.baseModelVersion) {
      return {
        ok: false,
        code: DRAFT_STALE,
        message: `live=${this.liveModelVersion} ≠ base=${d.baseModelVersion}：draft 已过期，拒绝应用（需 rebase 后重试）`,
      };
    }
    // 复用现有 CommandBus.replaceProject：live 整体替换为 draft 终态，modelVersion +1
    this.bus.replaceProject(d.getState(), `apply draft ${d.draftId}`);
    this.liveModelVersion += 1;
    this.drafts.delete(draftId);
    await this.flush();
    return { ok: true, newVersion: this.liveModelVersion };
  }

  /** 丢弃草稿（按归属控制由调用方负责；S1 不在此做权限判定，权限是 HTTP 层职责）。 */
  discardDraft(draftId: string): boolean {
    return this.drafts.delete(draftId);
  }

  /** MCP 写工具需要的规则集（构造 Cabinet / 编译 Proposal 用）。只读，不递引用。 */
  getRules(): RuleSet {
    return this.rules;
  }

  /** 列出内存中的全部 draft（含归属与创建时间，供 cad.list_drafts）。 */
  listDrafts(): Array<DraftHandle & { createdAt: string }> {
    return [...this.drafts.values()].map((d) => ({ ...d.handle(), createdAt: d.createdAt }));
  }

  /**
   * 把指定 draft 落盘（S4）。
   * 调用方（MCP 写工具）在 createDraft / draftExecute 成功后显式调用 ——
   * 与 Workspace.execute() "提交成功才落盘"同一条纪律：没落盘就不算成功。
   */
  async saveDraft(draftId: string): Promise<void> {
    if (!this.persistDraft) return;
    const d = this.drafts.get(draftId);
    if (!d) throw new Error(`draft 不存在，无法落盘：${draftId}`);
    await this.persistDraft(draftId, JSON.stringify(d.toJSON(), null, 2));
  }

  /** 删除 draft 文件（apply/discard 后调用；文件不存在也不报错，幂等）。 */
  async deleteDraftFile(draftId: string): Promise<void> {
    if (!this.persistDraft) return;
    await this.persistDraft(draftId, null);
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
      try {
        const draft = ServerDraft.fromJSON(JSON.parse(f.content), this.rules);
        if (draft.workspaceId !== this.workspaceId) {
          skipped.push(f.draftId);
          continue;
        }
        this.drafts.set(draft.draftId, draft);
        loaded.push(draft.draftId);
      } catch {
        skipped.push(f.draftId);
      }
    }
    return { loaded, skipped };
  }
}
