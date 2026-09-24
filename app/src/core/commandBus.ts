import type { Cabinet, Issue, Project, ProjectGeometry, Room, RuleSet, UnitSpec, Wall } from './types.ts';
import { generateProject } from './geometry/project.ts';
import { buildProjectExplode, type ProjectExplodeSet } from './geometry/explode.ts';
import { validateCabinet } from './rules/validate.ts';
import { createRoom, defaultCabinetParams, defaultUnits } from './docFactory.ts';
import { nextId } from './ids.ts';
import type { Gate, GateHit } from '../ai/memory.ts';
import { formatGateError } from '../ai/memory.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  CommandBus —— 全系统唯一写入口（宪法级）
 *
 *  UI 点击 / 拖动 / 键盘、AI 指令、MCP 调用、脚本导入，四条路必须走这里。
 *  收益：① 人类与 AI 完全同权同位 ② 审计/撤销/权限只实现一次
 *        ③ 换 AI 供应商或加新客户端，零改动
 *
 *  三条铁律：
 *   1. 只接受 path-based 的语义字段修改 + 结构性命令，禁止任何几何/坐标直改
 *   2. 写路径白名单 —— AI/UI 都改不了派生字段和规则集（见 WRITABLE / DENY）
 *   3. 派生数据（板件/几何/清单）永不写回模型，永远是现算
 *
 *  ⚠ 关于 ERROR 是否阻断提交（一条容易做错的设计决策）：
 *    ERROR 阻断的是【导出/交付】，不是【编辑】。
 *    理由：真实设计过程必然经过中间非法态（柜子先放进墙里再挪出来）。
 *    如果每次拖动都因为"产生 ERROR"而拒绝提交，工具就没法用了。
 *    因此默认 strict=false：提交成功，同时把新增 ERROR 明确回报 + 前端弹出警告。
 *    AI / MCP 想要求"干净提交"时显式传 strict=true，
 *    此时只有【本次命令新引入的】ERROR 才阻断（历史遗留错误不阻塞新操作）。
 * ══════════════════════════════════════════════════════════════════════
 */

export type CommandSource = 'ui' | 'ai' | 'mcp' | 'system';

export interface Change {
  path: string;
  op: 'set' | 'add';
  value: number | string | boolean | null;
  unit?: 'mm' | 'deg' | '';
}

/** 结构性命令的载荷（数组增删无法用路径赋值表达） */
export interface CommandPayload {
  /** cabinet.create */
  cabinet?: Cabinet;
  /** cabinet.layout.addUnit / removeUnit */
  unit?: UnitSpec;
  unitId?: string;
  /** room.create / wall.create */
  room?: Room;
  wall?: Wall;
  roomId?: string;
  /** 允许调用方覆盖名字等 */
  name?: string;
}

export interface Command {
  id: string;
  op: string;
  source: CommandSource;
  target?: { kind: 'cabinet' | 'wall' | 'project'; id: string };
  changes: Change[];
  /** 结构性命令载荷；与 changes 互斥（二者必须有一个非空） */
  payload?: CommandPayload;
  /** AI 或 UI 的原始意图，写进审计日志（出事故时唯一能复盘的东西） */
  intent?: { nl?: string; assumptions?: string[] };
  /** 人类可读摘要，用于命令历史面板 */
  label?: string;
}

export interface DiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

/**
 * 结构性变更的逆运算描述 —— 声明式，便于 undo/redo 统一处理。
 * 用数组而不是单个：一条命令可能同时创建"房间 + 墙"（首次画墙时自动建房间），
 * 撤销必须整体回退，不能留下半个空房间。
 */
export type SideEffect =
  | { kind: 'insertCabinet'; cab: Cabinet; index: number }
  | { kind: 'removeCabinet'; cab: Cabinet; index: number }
  | { kind: 'addUnit'; cabinetId: string; unit: UnitSpec; index: number }
  | { kind: 'removeUnit'; cabinetId: string; unit: UnitSpec; index: number }
  | { kind: 'insertRoom'; room: Room; index: number }
  | { kind: 'removeRoom'; room: Room; index: number }
  | { kind: 'insertWall'; roomId: string; wall: Wall; index: number }
  | { kind: 'removeWall'; roomId: string; wall: Wall; index: number }
  /**
   * 镜像柜体（MI）：分区序列左右反序。反序的自逆就是自身（reverse 两次还原），
   * 所以 undo/redo 走同一个动作 —— 不需要快照前后两份。
   */
  | { kind: 'mirrorUnits'; cabinetId: string; from: string[]; to: string[] }
  /**
   * 整项目替换（导入 / 恢复草稿）。它换掉的是【对象引用】而不是某个字段，
   * 所以不能走路径回退，undo/redo 里单独处理 —— 必须同时携带前后两份快照，
   * 两个方向都要能走。（这条曾缺失：replaceProject 声称可撤销，实际 undo 后
   * 路径回退静默失败，模型仍是导入后的项目 —— 断言第一次抓到的就是它。）
   */
  | { kind: 'replaceProject'; prev: Project; next: Project };

export interface LogEntry {
  seq: number;
  at: number;
  command: Command;
  label: string;
  diff: DiffEntry[];
  /** 路径编辑的逆运算（逐条 set 回旧值） */
  inverse: Change[];
  /** 结构性变更（插入/删除对象）无法用路径赋值逆运算，单独记录 */
  sideEffects?: SideEffect[];
  derived: DerivedSummary;
  issueDelta: { errors: number; warnings: number; added: Issue[] };
  applied: boolean;
  discarded: boolean;
}

export interface DerivedSummary {
  panels: number;
  pieces: number;
  areaM2: number;
  weightKg: number;
}

export interface ExecResult {
  ok: boolean;
  error?: string;
  diff: DiffEntry[];
  /** 本次命令【新引入】的问题 */
  newIssues: Issue[];
  /** 本次命令【消除掉】的问题 */
  resolvedIssues: Issue[];
  derived: DerivedSummary;
  clamped: string[];
  /** 提交后（或试算后）仍存在的 ERROR 总数 —— 决定能否导出 */
  blockingErrors: number;
  /**
   * 被【记忆门】拦下的条目。
   * 与 error 字段的区别：error 是给人看的一句话，memoryHits 是结构化来源，
   * 让 AI/UI 能说清"是哪条记忆拦的、你当时的原话是什么"。
   */
  memoryHits: GateHit[];
}

/** 结构性 ops 白名单：这些 op 走 payload 分支，不做路径校验 */
const STRUCTURAL_OPS = new Set([
  'cabinet.create',
  'cabinet.delete',
  'cabinet.layout.addUnit',
  'cabinet.layout.removeUnit',
  'cabinet.mirror',
  'room.create',
  'wall.create',
  'wall.delete',
]);

/** 写路径白名单：不在名单里的路径一律拒绝（AI 越权防线 #3） */
const WRITABLE: Record<string, RegExp[]> = {
  'cabinet.move': [/^placement\.(x|y)$/],
  'cabinet.rotate': [/^placement\.rotation$/],
  /**
   * cabinet.resize：拖夹点改宽/深时，可能需要同时补偿 placement
   * （例如拖左边缘 → 右边缘必须钉住不动，锚点得跟着挪）。
   * 必须是【一条命令】，否则中途态不是合法模型，撤销也会留下半截。
   */
  'cabinet.resize': [/^params\.(width|height|depth)$/, /^placement\.(x|y)$/],
  'cabinet.update': [
    /^params\.(width|height|depth|bodyLift|shelfFrontClearance)$/,
    /^params\.backPanel\.(grooveDepth|grooveSetback|clearance|material|method)$/,
    /^params\.boardMaterial$/,
  ],
  'cabinet.rename': [/^name$/],
  /**
   * 多选移动：一条命令改多个柜体，撤销才是一步。
   * 逐柜发 N 条命令也能动，但撤销要按 N 次 —— 那不是用户的心智模型。
   */
  'cabinet.moveBatch': [/^cabinets\[\d+\]\.placement\.(x|y)$/],
  'cabinet.layout': [
    /^layout\.widthMode$/,
    /^layout\.units\[\d+\]\.(requestedWidth|nickname|kind)$/,
    /^layout\.units\[\d+\]\.(drawers)\.(count|gap|runner|runnerLength|boxHeightDeduct)$/,
    /^layout\.units\[\d+\]\.(shelves)\.(count|gapPerSide)$/,
    /^layout\.units\[\d+\]\.(doors)\.(count|gapOuter|gapMid|hinge)$/,
    /^layout\.units\[\d+\]\.(rod)\.(count|heightFromBottom|hardware)$/,
  ],
  'wall.move': [/^(start|end)\.[xy]$/],
  'wall.update': [/^thickness$/, /^height$/, /^name$/],
  'room.rename': [/^rooms\[\d+\]\.name$/],
  'project.rename': [/^name$/],
};

/** 绝对不能改的路径前缀（派生字段 / 系统字段），即使白名单写错也拦一道 */
const DENY = [/^panels/, /^geometry/, /^issues/, /^stats/, /^id$/, /^schemaVersion$/, /^ruleSetId$/];

/** 项目级目标允许改的绝对路径 */
const SETTABLE_ABS = new Set(['name']);

function isWritablePath(op: string, path: string, isProjectTarget: boolean): boolean {
  if (DENY.some((d) => d.test(path))) return false;
  const rules = WRITABLE[op];
  if (rules && rules.some((r) => r.test(path))) return true;
  // 项目级目标：只允许显式列进 SETTABLE_ABS 的绝对路径
  return isProjectTarget && SETTABLE_ABS.has(path);
}

// ───────────────────────────── path 读写 ─────────────────────────────

type Token = { key: string; index?: number };

function parsePath(path: string): Token[] {
  return path.split('.').map((seg) => {
    const m = /^([A-Za-z_$][\w$]*)(?:\[(\d+)\])?$/.exec(seg);
    if (!m) throw new Error(`非法路径段: "${seg}"（完整路径 "${path}"）`);
    return m[2] === undefined ? { key: m[1] } : { key: m[1], index: Number(m[2]) };
  });
}

export function getByPath(root: unknown, path: string): unknown {
  let cur: any = root;
  for (const tk of parsePath(path)) {
    if (cur == null) return undefined;
    cur = cur[tk.key];
    if (tk.index !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[tk.index];
    }
  }
  return cur;
}

/**
 * 允许"从无到有"创建的叶子字段。
 * 只放**可选 authored 字段**：它们在类型上是 `?:`，首次赋值是正常业务操作。
 * 其余一律拒绝创建 —— 这是"派生字段永不写入模型"的最后一道物理防线。
 */
const OPTIONAL_AUTHORED = new Set(['nickname']);

function setByPath(root: unknown, path: string, value: unknown): void {
  const toks = parsePath(path);
  let cur: any = root;
  for (let i = 0; i < toks.length - 1; i++) {
    const tk = toks[i];
    cur = cur[tk.key];
    if (cur == null || typeof cur !== 'object') throw new Error(`路径不存在: ${path}`);
    if (tk.index !== undefined) {
      cur = cur[tk.index];
      if (cur == null || typeof cur !== 'object') throw new Error(`路径不存在: ${path}`);
    }
  }
  const last = toks[toks.length - 1];
  if (last.index !== undefined) {
    const arr = cur[last.key];
    if (!Array.isArray(arr) || arr[last.index] === undefined) throw new Error(`路径不存在: ${path}`);
    arr[last.index] = value;
  } else {
    if (!(last.key in cur) && !OPTIONAL_AUTHORED.has(last.key)) {
      throw new Error(`字段不存在: ${path}（不允许新增字段）`);
    }
    cur[last.key] = value;
  }
}

const clampInt = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(v)));

/** 值域夹紧（防线 #4）：超范围不静默改，而是夹紧后回报 */
function sanitize(change: Change): { value: unknown; note?: string } {
  if (typeof change.value !== 'number') return { value: change.value };
  const key = change.path.split('.').pop() ?? '';
  const clampTo = (min: number, max: number, hint: string) => {
    const v = clampInt(change.value as number, min, max);
    return { value: v, note: v !== change.value ? `${change.path}：${String(change.value)} 被夹紧到 ${v}（${hint}）` : undefined };
  };
  if (key === 'rotation') return clampTo(-360, 360, '旋转角');
  if (key === 'x' || key === 'y') return clampTo(-100000, 100000, '世界坐标 mm');
  if (key === 'width' || key === 'height' || key === 'depth') return clampTo(100, 6000, '100~6000mm');
  if (key === 'bodyLift') return clampTo(0, 300, '踢脚高 0~300mm');
  if (key === 'shelfFrontClearance') return clampTo(0, 100, '前沿让位');
  if (key === 'runnerLength') return clampTo(200, 600, '滑轨长度');
  if (key === 'gap' || key === 'gapOuter' || key === 'gapMid') return clampTo(0, 20, '缝隙');
  if (key === 'count') return clampTo(0, 40, '数量');
  if (key === 'heightFromBottom') return clampTo(0, 3000, '距内底高度');
  if (key === 'thickness') return clampTo(20, 400, '墙厚');
  return { value: change.value };
}

// ───────────────────────── 结构性变更的施加/回退 ─────────────────────────

function findCab(project: Project, id: string): number {
  return project.cabinets.findIndex((c) => c.id === id);
}
function findRoom(project: Project, id: string): number {
  return project.rooms.findIndex((r) => r.id === id);
}

/** forward=true 表示"重做/应用"，false 表示"撤销" */
function applySideEffect(project: Project, se: SideEffect, forward: boolean): void {
  switch (se.kind) {
    case 'insertCabinet': {
      const i = findCab(project, se.cab.id);
      if (forward) {
        if (i < 0) project.cabinets.splice(Math.min(se.index, project.cabinets.length), 0, structuredClone(se.cab));
      } else if (i >= 0) {
        project.cabinets.splice(i, 1);
      }
      return;
    }
    case 'removeCabinet': {
      const i = findCab(project, se.cab.id);
      if (forward) {
        if (i >= 0) project.cabinets.splice(i, 1);
      } else if (i < 0) {
        project.cabinets.splice(Math.min(se.index, project.cabinets.length), 0, structuredClone(se.cab));
      }
      return;
    }
    case 'addUnit': {
      const cab = project.cabinets.find((c) => c.id === se.cabinetId);
      if (!cab) return;
      const i = cab.layout.units.findIndex((u) => u.id === se.unit.id);
      if (forward) {
        if (i < 0) cab.layout.units.splice(Math.min(se.index, cab.layout.units.length), 0, structuredClone(se.unit));
      } else if (i >= 0) {
        cab.layout.units.splice(i, 1);
      }
      return;
    }
    case 'removeUnit': {
      const cab = project.cabinets.find((c) => c.id === se.cabinetId);
      if (!cab) return;
      const i = cab.layout.units.findIndex((u) => u.id === se.unit.id);
      if (forward) {
        if (i >= 0) cab.layout.units.splice(i, 1);
      } else if (i < 0) {
        cab.layout.units.splice(Math.min(se.index, cab.layout.units.length), 0, structuredClone(se.unit));
      }
      return;
    }
    case 'insertRoom': {
      const i = findRoom(project, se.room.id);
      if (forward) {
        if (i < 0) project.rooms.splice(Math.min(se.index, project.rooms.length), 0, structuredClone(se.room));
      } else if (i >= 0) {
        // 撤销建房间时，房间里的柜体必须一起走，否则会留下 orphan（悬空柜体）
        const roomId = project.rooms[i].id;
        project.rooms.splice(i, 1);
        project.cabinets = project.cabinets.filter((c) => c.roomId !== roomId);
      }
      return;
    }
    case 'removeRoom': {
      const i = findRoom(project, se.room.id);
      if (forward) {
        if (i >= 0) project.rooms.splice(i, 1);
      } else if (i < 0) {
        project.rooms.splice(Math.min(se.index, project.rooms.length), 0, structuredClone(se.room));
      }
      return;
    }
    case 'insertWall': {
      const room = project.rooms.find((r) => r.id === se.roomId);
      if (!room) return;
      const i = room.walls.findIndex((w) => w.id === se.wall.id);
      if (forward) {
        if (i < 0) room.walls.splice(Math.min(se.index, room.walls.length), 0, structuredClone(se.wall));
      } else if (i >= 0) {
        room.walls.splice(i, 1);
      }
      return;
    }
    case 'removeWall': {
      const room = project.rooms.find((r) => r.id === se.roomId);
      if (!room) return;
      const i = room.walls.findIndex((w) => w.id === se.wall.id);
      if (forward) {
        if (i >= 0) room.walls.splice(i, 1);
      } else if (i < 0) {
        room.walls.splice(Math.min(se.index, room.walls.length), 0, structuredClone(se.wall));
      }
      return;
    }
    case 'mirrorUnits': {
      const cab = project.cabinets.find((c) => c.id === se.cabinetId);
      if (!cab) return;
      // 反序自逆：undo / redo 都执行同一个 reverse（两次 reverse = 还原）。
      // 照抄 se.from 校验一次，防止未来有人在别处动了顺序导致快照失真。
      const cur = cab.layout.units.map((u) => u.id);
      const expect = forward ? se.from : se.to;
      if (cur.length === expect.length && cur.every((id, i) => id === expect[i])) {
        cab.layout.units.reverse();
      }
      return;
    }
  }
}

function applySideEffects(project: Project, list: SideEffect[], forward: boolean): void {
  // 撤销必须逆序：真实顺序是[建房间, 加墙]，逆序才是[去墙, 去房间]
  const seq = forward ? list : [...list].reverse();
  for (const se of seq) applySideEffect(project, se, forward);
}

// ───────────────────────────── Bus ─────────────────────────────

export class CommandBus {
  private project: Project;
  private rules: RuleSet;
  private entries: LogEntry[] = [];
  private pointer = -1;
  private listeners = new Set<() => void>();
  /** 几何缓存：只在 modelVersion 变化时重算（缓存失效的唯一依据） */
  private geomCache: { version: number; geom: ProjectGeometry; issues: Issue[] } | null = null;
  /**
   * 分解图缓存。
   *
   * 为什么它不进 geomCache：分解图是**开关控制的可选视图**，默认关闭。
   * 如果把它塞进每次 derive 都跑的那条路，就等于"永远都在算一张没人看的图"，
   * 而且"关掉分解图"会跟"没有分解图"混为一谈。
   * 缓存键带上 enabled，切换开关必然重算，不存在"开了还显示旧结果"。
   */
  private explodeCache: { key: string; set: ProjectExplodeSet } | null = null;
  private modelVersion = 0;
  /**
   * 记忆门：由 ai/memory.ts 的 compileCorrections() 编译出来的可执行检查。
   *
   * 挂在总线而不是 AI 层，是有意的：UI 点击、拖动、AI、MCP、脚本五条路都经过这里，
   * 所以"你说过的话"既拦得住 AI，也拦得住你自己的手滑；而且不需要 AI 在线。
   */
  private gate: Gate | null = null;

  constructor(project: Project, rules: RuleSet) {
    this.project = structuredClone(project);
    this.rules = rules;
  }

  /** 设置/清除记忆门。传 null 表示关闭（例如回放旧会话时不想被新规矩拦住） */
  setGate(gate: Gate | null): void {
    this.gate = gate;
  }
  hasGate(): boolean {
    return this.gate !== null;
  }

  // ── 读 ──
  getState(): Project {
    return this.project;
  }
  getRules(): RuleSet {
    return this.rules;
  }
  getVersion(): number {
    return this.modelVersion;
  }

  /** 派生几何 + 全量校验问题（带缓存，按 modelVersion 失效） */
  derive(): { geom: ProjectGeometry; issues: Issue[] } {
    if (this.geomCache && this.geomCache.version === this.modelVersion) return this.geomCache;
    const r = this.deriveFor(this.project);
    this.geomCache = { version: this.modelVersion, geom: r.geom, issues: r.issues };
    return this.geomCache;
  }

  issues(): Issue[] {
    return this.derive().issues;
  }

  /**
   * 分解图（爆炸图）—— 按需派生。
   *
   * `enabled = false` 时**连装配数据都不算**（零开销），并且返回的 set 里
   * `enabled === false` 且 prims 为空。这样"关"与"没有"在类型上就是分得开的：
   * 界面可以说"关闭"，而不是"这张图是空的"。
   *
   * `below` 传四视图图幅的包围盒 → 分解图永远摆在它正下方，两张图不会重叠。
   * 这个关系是算出来的，不是调间距调出来的。
   */
  deriveExplode(enabled: boolean): ProjectExplodeSet {
    const key = `${this.modelVersion}|${enabled ? 1 : 0}`;
    if (this.explodeCache && this.explodeCache.key === key) return this.explodeCache.set;
    const set = buildProjectExplode(this.project, this.rules, { enabled, below: this.derive().geom.views.bbox });
    this.explodeCache = { key, set };
    return set;
  }

  /** 是否处于"不可交付"状态 —— 阻断的是导出，不是编辑 */
  hasBlockingErrors(): boolean {
    return this.issues().some((i) => i.severity === 'ERROR');
  }

  // ── 订阅 ──
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // ── 日志 ──
  log(): LogEntry[] {
    return this.entries;
  }
  canUndo(): boolean {
    return this.pointer >= 0;
  }
  canRedo(): boolean {
    return this.pointer + 1 < this.entries.length;
  }
  /** 已生效的日志条目（从旧到新），供历史面板展示 */
  activeLog(): LogEntry[] {
    return this.entries.slice(0, this.pointer + 1);
  }

  /**
   * 干跑规划：只算出"如果执行会变成什么样"，绝不触碰 this.project。
   * execute 与 preview 共用这一份，因此【预览结果 === 提交结果】是结构性保证，
   * 而不是"两边都写对了"的巧合。拖动柜体时屏幕上看到的就是提交后必然得到的。
   */
  plan(
    cmd: Command
  ):
    | { ok: true; draft: Project; diff: DiffEntry[]; inverse: Change[]; sideEffects: SideEffect[]; clamped: string[] }
    | { ok: false; error: string } {
    const isStructural = STRUCTURAL_OPS.has(cmd.op);

    // ① 目标与载荷校验
    if (cmd.target && cmd.target.kind === 'cabinet') {
      if (findCab(this.project, cmd.target.id) < 0) return { ok: false, error: `找不到柜体 ${cmd.target.id}` };
    }
    if (isStructural) {
      if (cmd.op === 'cabinet.create' && !cmd.payload?.cabinet) {
        return { ok: false, error: 'cabinet.create 缺少 payload.cabinet' };
      }
      if (cmd.op === 'cabinet.layout.addUnit' && !cmd.payload?.unit) {
        return { ok: false, error: 'addUnit 缺少 payload.unit' };
      }
      if (cmd.op === 'cabinet.layout.removeUnit' && !cmd.payload?.unitId) {
        return { ok: false, error: 'removeUnit 缺少 payload.unitId' };
      }
      if (cmd.op === 'wall.create' && !cmd.payload?.wall) {
        return { ok: false, error: 'wall.create 缺少 payload.wall' };
      }
      if (cmd.op === 'room.create' && !cmd.payload?.room) {
        return { ok: false, error: 'room.create 缺少 payload.room' };
      }
    } else if (cmd.changes.length === 0) {
      return { ok: false, error: '命令没有携带任何变更' };
    }

    // ② 写权限 + 路径白名单校验
    const clamped: string[] = [];
    if (!isStructural) {
      const isProjectTarget = !cmd.target || cmd.target.kind === 'project';
      for (const ch of cmd.changes) {
        if (!isWritablePath(cmd.op, ch.path, isProjectTarget)) {
          return {
            ok: false,
            error: `越权写入被拒绝：op="${cmd.op}" 不允许修改 "${ch.path}"（派生字段与规则集对 AI 只读）`,
          };
        }
      }
    }

    // ③ 在副本上试算
    const draft = structuredClone(this.project);
    const diff: DiffEntry[] = [];
    const inverse: Change[] = [];
    let sideEffects: SideEffect[] = [];

    if (isStructural) {
      const built = this.planStructural(cmd, draft);
      if (!built) {
        // mirror 的最常见拒绝原因值得说人话：单分区柜没有"左右"可翻
        const why =
          cmd.op === 'cabinet.mirror'
            ? '单分区柜体没有左右分区可翻（镜像至少需要 2 个分区）'
            : cmd.op;
        return { ok: false, error: `结构性命令失败：${why}` };
      }
      sideEffects = built.sideEffects;
      diff.push(...built.diff);
      applySideEffects(draft, sideEffects, true);
    } else {
      const root: any =
        !cmd.target || cmd.target.kind === 'project'
          ? draft
          : cmd.target.kind === 'cabinet'
            ? draft.cabinets.find((c) => c.id === cmd.target!.id)
            : this.findWall(draft, cmd.target.id);
      if (root === undefined) return { ok: false, error: `找不到目标 ${cmd.target?.id}` };

      for (const ch of cmd.changes) {
        const before = getByPath(root, ch.path);
        if (before === undefined) return { ok: false, error: `路径不存在: ${ch.path}` };
        const s = sanitize(ch);
        if (s.note) clamped.push(s.note);
        let next: unknown = s.value;
        if (ch.op === 'add') next = (Number(before) || 0) + (Number(s.value) || 0);
        try {
          setByPath(root, ch.path, next);
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
        diff.push({ path: ch.path, from: before, to: next });
        inverse.push({ path: ch.path, op: 'set', value: before as Change['value'], unit: ch.unit });
      }
    }

    if (diff.length === 0) return { ok: false, error: '命令没有产生任何变更' };
    return { ok: true, draft, diff, inverse, sideEffects, clamped };
  }

  /**
   * 干跑读取：返回"执行后模型会变成什么样"。
   * 拖动/夹点编辑的实时预览走这里 —— 因此预览必然与提交结果逐位一致。
   */
  preview(cmd: Command): { ok: boolean; error?: string; project: Project } {
    const p = this.plan(cmd);
    return p.ok ? { ok: true, project: p.draft } : { ok: false, error: p.error, project: this.project };
  }

  /**
   * 执行命令。
   * dryRun = true 时完全不改变状态，只回传 diff + 问题变化（AI 两段式的第一步）
   * strict = true 时，只要本次命令【新引入】ERROR 就拒绝提交
   */
  execute(
    cmd: Command,
    opts: { dryRun?: boolean; commitLabel?: string; strict?: boolean } = {}
  ): ExecResult {
    const dryRun = opts.dryRun ?? false;
    const strict = opts.strict ?? false;
    const empty = (error?: string): ExecResult => ({
      ok: false,
      error,
      diff: [],
      newIssues: [],
      resolvedIssues: [],
      derived: this.sumDerived(this.derive().geom),
      clamped: [],
      blockingErrors: 0,
      memoryHits: [],
    });

    const planned = this.plan(cmd);
    if (!planned.ok) return empty(planned.error);
    const { draft, diff, inverse, sideEffects, clamped } = planned;

    // ④ 试算派生数据 + 规则（这就是干跑的价值：先看后果）
    const before = this.derive();
    const trial = this.deriveFor(draft);
    const afterDerived = this.sumDerived(trial.geom);

    const keyOf = (i: Issue): string => `${i.severity}|${i.code}|${i.target}`;
    const beforeKeys = new Set(before.issues.map(keyOf));
    const afterKeys = new Set(trial.issues.map(keyOf));
    const newIssues = trial.issues.filter((i) => !beforeKeys.has(keyOf(i)));
    const resolvedIssues = before.issues.filter((i) => !afterKeys.has(keyOf(i)));
    const blockingErrors = trial.issues.filter((i) => i.severity === 'ERROR').length;
    const newErrors = newIssues.filter((i) => i.severity === 'ERROR');

    /**
     * ④.5 记忆门 —— 用户/AI 纠正过的规矩在这里把门。
     *
     * 位置特意放在【试算之后、提交之前】：
     *  · 走的是和 strict 模式同一套 before/after 对比，所以只拦"这次操作新引入的违规"，
     *    历史遗留问题不会让之后每一步都被卡住
     *  · dryRun 也照样过门 → AI 两段式的第一步就能预告"这一步会被你的记忆拦住"，
     *    而不是等到提交才失败
     *
     * ── 为什么它排在 strict **之前**（一次真实的次序缺陷）──
     *  原先 strict 在前。当一次操作同时触发"新引入 ERROR"和"违反某条记忆"时，
     *  返回的是错误信息只有前者 —— 于是**记忆命中被整个掩盖**：
     *  `memoryHits` 是空的，界面上的「最近一次拦截」永远不更新，
     *  而"被你说的某句话拦住过"正是记忆功能最该留下的痕迹。
     *  两条门都拒绝这次操作，但**该报哪一条**是有讲究的：
     *  记忆是"你上次亲口说过不要这样"，比一条通用规则更具体、更可行动，
     *  所以让它先说话。规则 ERROR 并不会因此消失 —— 它们照旧在 newIssues 里，
     *  界面照样一条条列出来。
     */
    const memoryHits = this.gate ? this.gate({ cmd, before: this.project, draft, newIssues, rules: this.rules }) : [];
    if (memoryHits.length > 0) {
      return {
        ok: false,
        error: formatGateError(memoryHits),
        diff,
        newIssues,
        resolvedIssues,
        derived: afterDerived,
        clamped,
        blockingErrors,
        memoryHits,
      };
    }

    if (strict && newErrors.length > 0) {
      return {
        ok: false,
        error: `严格模式：本次操作新引入 ${newErrors.length} 条 ERROR，已拒绝。${newErrors[0].message}`,
        diff,
        newIssues,
        resolvedIssues,
        derived: afterDerived,
        clamped,
        blockingErrors,
        memoryHits: [],
      };
    }

    const result: ExecResult = { ok: true, diff, newIssues, resolvedIssues, derived: afterDerived, clamped, blockingErrors, memoryHits: [] };

    if (dryRun) return result;

    // ⑤ 提交：丢弃 redo 分支
    if (this.pointer + 1 < this.entries.length) {
      for (let i = this.pointer + 1; i < this.entries.length; i++) this.entries[i].discarded = true;
      this.entries = this.entries.slice(0, this.pointer + 1);
    }
    this.project = draft;
    this.modelVersion++;
    this.geomCache = null;

    this.entries.push({
      seq: this.entries.length + 1,
      at: Date.now(),
      command: cmd,
      label: opts.commitLabel ?? cmd.label ?? cmd.op,
      diff,
      inverse,
      sideEffects: sideEffects.length > 0 ? sideEffects : undefined,
      derived: afterDerived,
      issueDelta: {
        errors: newErrors.length,
        warnings: newIssues.filter((i) => i.severity === 'WARNING').length,
        added: newIssues,
      },
      applied: true,
      discarded: false,
    });
    this.pointer = this.entries.length - 1;
    this.notify();
    return result;
  }

  /** 结构性命令：只计算"要施加什么"，不直接改 this.project */
  private planStructural(
    cmd: Command,
    draft: Project
  ): { sideEffects: SideEffect[]; diff: DiffEntry[] } | null {
    const p = cmd.payload ?? {};

    if (cmd.op === 'cabinet.create') {
      const cab = structuredClone(p.cabinet!);
      // 归一化：补齐可能缺失的默认值（AI 只给核心字段时也能落地）
      const base = defaultCabinetParams(this.rules);
      cab.params = { ...base, ...cab.params, backPanel: { ...base.backPanel, ...cab.params?.backPanel } };
      if (!cab.layout || !cab.layout.units || cab.layout.units.length === 0) {
        cab.layout = { type: 'row', widthMode: 'fit_total', units: defaultUnits(cab.params.width, this.rules) };
      }
      if (!cab.id) cab.id = nextId('cab', draft.cabinets.map((c) => c.id));
      if (draft.cabinets.some((c) => c.id === cab.id)) return null;
      const room = draft.rooms.find((r) => r.id === cab.roomId) ?? draft.rooms[0];
      if (!room) return null; // 没有房间时不能建柜（避免悬空柜体）
      cab.roomId = room.id;
      const index = draft.cabinets.length;
      return {
        sideEffects: [{ kind: 'insertCabinet', cab, index }],
        diff: [{ path: '(cabinet.create)', from: null, to: `${cab.id} ${cab.name}` }],
      };
    }

    if (cmd.op === 'cabinet.delete') {
      const id = cmd.target?.id;
      if (!id) return null;
      const index = findCab(draft, id);
      if (index < 0) return null;
      const cab = structuredClone(draft.cabinets[index]);
      return {
        sideEffects: [{ kind: 'removeCabinet', cab, index }],
        diff: [{ path: '(cabinet.delete)', from: `${cab.id} ${cab.name}`, to: null }],
      };
    }

    if (cmd.op === 'cabinet.layout.addUnit') {
      const id = cmd.target?.id;
      if (!id) return null;
      const cab = draft.cabinets.find((c) => c.id === id);
      if (!cab) return null;
      const unit = structuredClone(p.unit!);
      if (!unit.id) unit.id = nextId('unit', cab.layout.units.map((u) => u.id));
      if (cab.layout.units.some((u) => u.id === unit.id)) return null;
      if (typeof unit.requestedWidth !== 'number') {
        const rest = cab.params.width - cab.layout.units.reduce((a, u) => a + u.requestedWidth, 0);
        unit.requestedWidth = Math.max(150, Math.round(rest));
      }
      const index = cab.layout.units.length;
      return {
        sideEffects: [{ kind: 'addUnit', cabinetId: id, unit, index }],
        diff: [{ path: `layout.units[${index}]`, from: null, to: unit.id }],
      };
    }

    if (cmd.op === 'cabinet.layout.removeUnit') {
      const id = cmd.target?.id;
      const unitId = p.unitId!;
      if (!id) return null;
      const cab = draft.cabinets.find((c) => c.id === id);
      if (!cab) return null;
      const index = cab.layout.units.findIndex((u) => u.id === unitId);
      if (index < 0) return null;
      if (cab.layout.units.length <= 1) return null; // 至少保留一个分区，否则不是柜子
      const unit = structuredClone(cab.layout.units[index]);
      return {
        sideEffects: [{ kind: 'removeUnit', cabinetId: id, unit, index }],
        diff: [{ path: `layout.units[${index}]`, from: unit.id, to: null }],
      };
    }

    if (cmd.op === 'cabinet.mirror') {
      const id = cmd.target?.id;
      if (!id) return null;
      const cab = draft.cabinets.find((c) => c.id === id);
      if (!cab) return null;
      // 单分区没有"左右"可翻 —— 拒绝，让 UI 给出解释而不是静默成功
      if (cab.layout.units.length < 2) return null;
      const from = cab.layout.units.map((u) => u.id);
      const to = from.slice().reverse();
      return {
        sideEffects: [{ kind: 'mirrorUnits', cabinetId: id, from, to }],
        diff: [{ path: 'layout.units', from: from.join('|'), to: to.join('|') }],
      };
    }

    if (cmd.op === 'room.create') {
      const room = structuredClone(p.room!);
      if (!room.id) room.id = nextId('room', draft.rooms.map((r) => r.id));
      if (draft.rooms.some((r) => r.id === room.id)) return null;
      const index = draft.rooms.length;
      return {
        sideEffects: [{ kind: 'insertRoom', room, index }],
        diff: [{ path: '(room.create)', from: null, to: `${room.id} ${room.name}` }],
      };
    }

    if (cmd.op === 'wall.create') {
      const wall = structuredClone(p.wall!);
      const sideEffects: SideEffect[] = [];
      let room = p.roomId ? draft.rooms.find((r) => r.id === p.roomId) : draft.rooms[0];

      // 一个房间都没有时，画墙自动创建一个容器房间。
      // 两件事必须包在一条命令里 —— 否则撤销会留下一个空房间。
      if (!room) {
        const auto = createRoom({ name: '房间1', takenIds: draft.rooms.map((r) => r.id) });
        const roomIndex = draft.rooms.length;
        sideEffects.push({ kind: 'insertRoom', room: auto, index: roomIndex });
        draft.rooms.push(structuredClone(auto));
        room = draft.rooms[roomIndex];
      }

      if (!wall.id) wall.id = nextId('wall', room.walls.map((w) => w.id));
      if (room.walls.some((w) => w.id === wall.id)) return null;
      const index = room.walls.length;
      sideEffects.push({ kind: 'insertWall', roomId: room.id, wall, index });
      return {
        sideEffects,
        diff: [{ path: `rooms[${room.id}].walls[${index}]`, from: null, to: `${wall.id} ${wall.name}` }],
      };
    }

    if (cmd.op === 'wall.delete') {
      const id = cmd.target?.id;
      if (!id) return null;
      for (const room of draft.rooms) {
        const index = room.walls.findIndex((w) => w.id === id);
        if (index < 0) continue;
        const wall = structuredClone(room.walls[index]);
        return {
          sideEffects: [{ kind: 'removeWall', roomId: room.id, wall, index }],
          diff: [{ path: `rooms[${room.id}].walls[${index}]`, from: `${wall.id} ${wall.name}`, to: null }],
        };
      }
      return null;
    }

    return null;
  }

  private findWall(project: Project, wallId: string): unknown {
    for (const r of project.rooms) {
      const w = r.walls.find((x) => x.id === wallId);
      if (w) return w;
    }
    return undefined;
  }

  // ───────────────────────────── Undo / Redo ─────────────────────────────

  undo(): boolean {
    if (!this.canUndo()) return false;
    const e = this.entries[this.pointer];
    this.revert(e, false);
    e.applied = false;
    this.pointer--;
    this.modelVersion++;
    this.geomCache = null;
    this.notify();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo()) return false;
    const e = this.entries[this.pointer + 1];
    this.revert(e, true);
    e.applied = true;
    this.pointer++;
    this.modelVersion++;
    this.geomCache = null;
    this.notify();
    return true;
  }

  /** forward=true 重做，false 撤销。路径编辑与结构性变更统一在这里处理。 */
  private revert(e: LogEntry, forward: boolean): void {
    if (e.sideEffects && e.sideEffects.length > 0) {
      // 整项目替换换掉的是对象引用，不能走逐字段回退 —— 单独处理（replace 永远是单条）
      if (e.sideEffects.length === 1 && e.sideEffects[0].kind === 'replaceProject') {
        const se = e.sideEffects[0];
        this.project = structuredClone(forward ? se.next : se.prev);
        return;
      }
      applySideEffects(this.project, e.sideEffects, forward);
      return;
    }
    const root: any =
      !e.command.target || e.command.target.kind === 'project'
        ? this.project
        : e.command.target.kind === 'cabinet'
          ? this.project.cabinets.find((c) => c.id === e.command.target!.id)
          : this.findWall(this.project, e.command.target.id);
    if (root === undefined) return;
    if (forward) {
      for (const d of e.diff) {
        try {
          setByPath(root, d.path, d.to);
        } catch {
          /* 目标结构已变（例如分区被删），跳过；整体状态仍一致，因为后续条目会各自回退 */
        }
      }
    } else {
      for (const inv of e.inverse) {
        try {
          setByPath(root, inv.path, inv.value);
        } catch {
          /* 同上 */
        }
      }
    }
  }

  /** 跳到某个历史点（撤销到指定 seq 之后 / 重做到指定 seq） */
  jumpTo(seq: number): void {
    const targetSeq = this.entries.findIndex((e) => e.seq === seq);
    if (targetSeq < 0) return;
    while (this.pointer > targetSeq) if (!this.undo()) break;
    while (this.pointer < targetSeq) if (!this.redo()) break;
  }

  /** 直接替换整个项目（导入 / 恢复版本）—— 也走日志，可撤销 */
  replaceProject(next: Project, label: string): void {
    const prev = this.project;
    this.project = structuredClone(next);
    if (this.pointer + 1 < this.entries.length) this.entries = this.entries.slice(0, this.pointer + 1);
    this.modelVersion++;
    this.geomCache = null;
    this.explodeCache = null;
    this.entries.push({
      seq: this.entries.length + 1,
      at: Date.now(),
      command: { id: `cmd_replace_${Date.now().toString(36)}`, op: 'project.replace', source: 'system', changes: [], label },
      label,
      diff: [{ path: '(project)', from: prev.name, to: next.name }],
      inverse: [],
      sideEffects: [{ kind: 'replaceProject', prev: structuredClone(prev), next: structuredClone(next) }],
      derived: this.sumDerived(this.derive().geom),
      issueDelta: { errors: 0, warnings: 0, added: [] },
      applied: true,
      discarded: false,
    });
    this.pointer = this.entries.length - 1;
    this.notify();
  }

  private deriveFor(p: Project): { geom: ProjectGeometry; issues: Issue[] } {
    const geom = generateProject(p, this.rules);
    const issues: Issue[] = [...geom.issues];
    for (const cab of p.cabinets) {
      const g = geom.cabinets[cab.id];
      if (!g) continue; // 生成器已为它报了 GEN-ERROR，不再继续校验
      issues.push(...validateCabinet(cab, g, this.rules));
    }
    return { geom, issues };
  }

  private sumDerived(geom: ProjectGeometry): DerivedSummary {
    let panels = 0;
    let pieces = 0;
    let areaM2 = 0;
    let weightKg = 0;
    for (const g of Object.values(geom.cabinets)) {
      panels += g.stats.panelKinds;
      pieces += g.stats.totalPieces;
      areaM2 += g.stats.boardAreaM2;
      weightKg += g.stats.estWeightKg;
    }
    return { panels, pieces, areaM2: Math.round(areaM2 * 10) / 10, weightKg: Math.round(weightKg * 10) / 10 };
  }
}
