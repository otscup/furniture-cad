/**
 * ══════════════════════════════════════════════════════════════════════
 *  设计意图的闸门（P9.2）—— 唯一实现
 *
 *  ── 为什么闸门要独占一个文件 ──
 *    同一条规矩出现在两处（记录入口 / 提案入口）时，只在一处拦 = 另一条路是敞的。
 *    `unitIntentsSemanticError` 当年就是为这件事被抽出来的（实测：dryRunPlan
 *    拿到坏分区真的建出来了）。所以这里只有**一份**载荷判定
 *    （`intentPayloadError`），"记录"与"提案"两种入口都调它。
 *
 *  ── 四道门，按"能不能被绕过"排序 ──
 *    ① 词的闭集：`goal` 不在词表里 → 拒（**未知意图不被接受**，不是"忽略掉继续"）
 *    ② 载荷无数字：`goal` / `scope` / `openingKind` 里不许出现**任何数字**。
 *       这比"禁止 x/y"强一档 —— 坐标一定是数字，禁掉数字等于让坐标在物理上无法表达。
 *    ③ 载荷无实体：`scope` 只认 `room` / `cabinet` 两种 kind，键闭集里没有 wallId / openingId。
 *       （类型层也已经表达不出来，这里是数据入口的第二道。）
 *    ④ 生命周期：candidate 不许自带 `confirmedBy`；active 必须有人认领；
 *       AI 推断的 active 必须以 'user-confirmed' 生效（**AI 不能自己宣布生效**）。
 *
 *  ── 白名单，不是黑名单 ──
 *    多一个键就拒，不做"忽略不认识的字段继续"。静默忽略是最危险的行为：
 *    提的人以为生效了，系统以为没提。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Project } from '../types.ts';
import {
  DESIGN_INTENT_OPENING_KINDS,
  DESIGN_INTENT_VALUE_KEY,
  DESIGN_INTENT_VALUE_OWNER,
  designIntentGoalSpec,
  isDesignIntentGoal,
} from './vocabulary.ts';
import {
  danglingIntentError,
  modelIntentError,
  type DesignIntent,
  type DesignIntentScope,
} from './model.ts';
import { nextId } from '../ids.ts';

/** 一条**完整记录**允许出现的全部键（闭集）。多一个就拒。 */
export const DESIGN_INTENT_KEYS: string[] = [
  'id',
  'status',
  'goal',
  'scope',
  DESIGN_INTENT_VALUE_KEY,
  'statement',
  'origin',
  'confirmedBy',
  'evidence',
  'createdAt',
  'updatedAt',
];

/** 元信息键 —— 由**系统**登记，不由提出者自带（提案里出现它们要给出带教训的报错） */
export const DESIGN_INTENT_META_KEYS: string[] = ['id', 'status', 'origin', 'confirmedBy', 'evidence', 'createdAt', 'updatedAt'];

/** 意图**草案**的键（提案里的每条就是它）：一条意图"想要什么"的全部 */
export const DESIGN_INTENT_DRAFT_KEYS: string[] = ['goal', 'scope', DESIGN_INTENT_VALUE_KEY, 'statement'];

/** 一次提案最多几条（与 MAX_ACTIONS 同精神：防"顺手把整屋的诉求重说一遍"） */
export const DESIGN_INTENT_PROPOSAL_MAX = 8;

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 载荷里的"数字" —— 本层唯一一条硬禁。
 *
 * 为什么连"2 条"这种数也不放行：载荷是**枚举 + id**，本来就没有需要数的地方。
 * 一旦开了"某个位置允许数字"的口子，下一个需求就会说"那这里也放个 600 的净空吧"。
 */
function payloadNumberError(v: unknown, where: string): string | null {
  if (typeof v === 'number' || typeof v === 'boolean') {
    return `${where} 是 ${JSON.stringify(v)} —— 设计意图的载荷里**不许出现数字**（坐标 / 尺寸 / 阈值一律属于几何层，不在这里表达）`;
  }
  if (Array.isArray(v)) {
    return `${where} 是数组 —— 意图只表达"想要什么"，不表达点列 / 区间 / 清单`;
  }
  if (isPlainObject(v)) {
    for (const [k, sub] of Object.entries(v)) {
      const bad = payloadNumberError(sub, `${where}.${k}`);
      if (bad) return bad;
    }
  }
  return null;
}

/** `scope` 的形状与实体闭集（不回答"贴哪面墙"那种问题） */
function scopeError(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'intent 缺 scope（这条意图是关于哪个房间 / 哪只柜的）';
  const illegal = Object.keys(raw).filter((k) => k !== 'kind' && k !== 'roomId' && k !== 'cabinetId');
  if (illegal.length > 0) {
    return (
      `scope 里出现了本层不认识的字段：${illegal.join('、')} —— scope 只回答"关于谁"（kind + roomId / cabinetId）；` +
      '墙、洞口、坐标都不是意图能指的对象（那是落位决定）'
    );
  }
  const kind = raw.kind;
  if (kind === 'room') {
    if (typeof raw.roomId !== 'string' || raw.roomId.trim() === '') return 'scope.kind="room" 时必须有 roomId（字符串）';
    if (raw.cabinetId !== undefined) return 'scope 同时给了 roomId 与 cabinetId —— 一条意图只有一个主语';
    return null;
  }
  if (kind === 'cabinet') {
    if (typeof raw.cabinetId !== 'string' || raw.cabinetId.trim() === '') return 'scope.kind="cabinet" 时必须有 cabinetId（字符串）';
    if (raw.roomId !== undefined) return 'scope 同时给了 roomId 与 cabinetId —— 一条意图只有一个主语';
    return null;
  }
  return `scope.kind 只能是 "room" / "cabinet"（收到 ${JSON.stringify(kind ?? null)}）—— 意图不指向墙、洞口或坐标`;
}

/**
 * 载荷判定 —— **唯一一份**"想要什么"的规矩。
 *
 * 只回答"goal / scope / openingKind / statement 这一块对不对"，
 * 不回答"这条记录完不完整"（那是 `designIntentError` 的事），
 * 也不回答"谁有权提"（那是草案闸门与生命周期的事）。
 */
export function intentPayloadError(raw: Record<string, unknown>): string | null {
  /**
   * ① **先筛数字** —— 把它放第一位是刻意的。
   *
   * 坐标走私是本层最想防的事，而"坐标一定是数字"。放在最前有两个好处：
   *   · 报错最准（`scope.x = 100` 会直说"载荷里不许出现数字"，比"不认识的字段 x"更点题）；
   *   · 这道筛子**真的会触发**，于是它不是一个永远轮不到执行的死分支
   *     （本项目对"恒真断言 / 永不触发检查"的态度：没被证伪过的检查不算检查）。
   */
  for (const k of ['goal', 'scope', DESIGN_INTENT_VALUE_KEY]) {
    const bad = payloadNumberError(raw[k], k === DESIGN_INTENT_VALUE_KEY ? DESIGN_INTENT_VALUE_KEY : `意图的 ${k}`);
    if (bad) return bad;
  }

  // ② 词的闭集
  if (!('goal' in raw)) return '意图缺 goal（想要什么）';
  if (!isDesignIntentGoal(raw.goal)) {
    return (
      `goal = ${JSON.stringify(raw.goal ?? null)} 不在设计意图词表里（可用词见 core/designIntent/vocabulary.ts）` +
      ' —— 未知意图不被接受，不会"忽略掉继续"'
    );
  }
  const spec = designIntentGoalSpec(raw.goal);

  // ③ scope 的形状与实体闭集
  const sErr = scopeError(raw.scope);
  if (sErr) return sErr;
  const scope = raw.scope as DesignIntentScope;
  if (scope.kind !== spec.scope) {
    return `goal "${raw.goal}" 说的是**${spec.scope === 'room' ? '房间' : '柜体'}**层级的事，但 scope 给的是 ${scope.kind} —— 两者必须一致`;
  }

  // ④ 取值字段：只有 near-opening 用得上；别人给了必须拒（不是静默忽略）
  if (raw[DESIGN_INTENT_VALUE_KEY] !== undefined && raw[DESIGN_INTENT_VALUE_KEY] !== null) {
    if (raw.goal !== DESIGN_INTENT_VALUE_OWNER) {
      return `${DESIGN_INTENT_VALUE_KEY} 只有 goal="${DESIGN_INTENT_VALUE_OWNER}" 用得上，而这条是 "${raw.goal}" —— 意图不接受与本词无关的参数`;
    }
    const v = raw[DESIGN_INTENT_VALUE_KEY];
    if (!DESIGN_INTENT_OPENING_KINDS.includes(v as never)) {
      return `${DESIGN_INTENT_VALUE_KEY} 只能是 ${DESIGN_INTENT_OPENING_KINDS.join(' / ')}（收到 ${JSON.stringify(v ?? null)}）`;
    }
  }

  if (raw.statement !== undefined && raw.statement !== null && typeof raw.statement !== 'string') {
    return 'statement 必须是字符串（用户原话，照原样保留）';
  }
  return null;
}

/**
 * 草案闸门（**提案里每条意图走的门**）。
 *
 * 与载荷判定的区别只有一条：**不许自带元信息**。
 * 出现 id / status / origin 时给的是**点名**的报错，而不是笼统的"不认识这个字段"——
 * 因为那是"想自己宣布生效"，必须让提出者看懂它做不到。
 */
export function designIntentDraftError(raw: unknown): string | null {
  if (!isPlainObject(raw)) return '意图草案必须是一个对象';
  for (const k of DESIGN_INTENT_META_KEYS) {
    if (k in raw) {
      return (
        `意图草案不能自带 "${k}" —— 生效状态、来源、id、时间戳都由系统在你交付之后登记；` +
        '提出者不能自己宣布生效（AI 推断只能产生 candidate，必须经用户确认）'
      );
    }
  }
  const unknown = Object.keys(raw).filter((k) => !DESIGN_INTENT_DRAFT_KEYS.includes(k));
  if (unknown.length > 0) {
    return `意图草案里出现了本层不认识的字段：${unknown.join('、')}（只允许 ${DESIGN_INTENT_DRAFT_KEYS.join(' / ')}）`;
  }
  return intentPayloadError(raw);
}

/** 完整记录闸门 = 载荷判定 + 元信息合法性（记录**必须**带 id/status/origin/evidence/时间戳） */
export function designIntentError(raw: unknown): string | null {
  if (!isPlainObject(raw)) return '意图必须是一个对象';
  const unknown = Object.keys(raw).filter((k) => !DESIGN_INTENT_KEYS.includes(k));
  if (unknown.length > 0) return `意图里出现了本层不认识的字段：${unknown.join('、')}`;

  const p = intentPayloadError(raw);
  if (p) return p;

  if (typeof raw.id !== 'string' || raw.id.trim() === '') return '意图缺 id';
  const id = raw.id;
  const st = raw.status;
  if (st !== 'candidate' && st !== 'active' && st !== 'rejected') {
    return `意图 ${id} 的 status 只能是 candidate / active / rejected（收到 ${JSON.stringify(st ?? null)}）`;
  }
  const origin = raw.origin;
  if (origin !== 'user-stated' && origin !== 'ai-inferred') {
    return `意图 ${id} 的 origin 只能是 user-stated / ai-inferred（收到 ${JSON.stringify(origin ?? null)}）—— 系统不产生设计意图`;
  }
  if (raw.confirmedBy !== undefined && raw.confirmedBy !== null) {
    if (raw.confirmedBy !== 'user-stated' && raw.confirmedBy !== 'user-confirmed') {
      return `意图 ${id} 的 confirmedBy 只能是 user-stated / user-confirmed（收到 ${JSON.stringify(raw.confirmedBy)}）`;
    }
    if (st === 'candidate') {
      return `意图 ${id} 还是 candidate 却带着 confirmedBy —— 未确认不能算生效（"未确认却自称生效"是最该防的一种假象）`;
    }
  }
  if (st === 'active' && (raw.confirmedBy === undefined || raw.confirmedBy === null)) {
    return `意图 ${id} 是 active 却没有人认领（缺 confirmedBy）—— 生效必须有人确认`;
  }
  if (origin === 'ai-inferred' && st === 'active' && raw.confirmedBy !== 'user-confirmed') {
    return `意图 ${id} 来自 AI 推断，必须以 confirmedBy:'user-confirmed' 生效（AI 不能自己宣布生效）`;
  }
  if (origin === 'user-stated' && st === 'active' && raw.confirmedBy !== 'user-stated') {
    return `意图 ${id} 是用户明说的，confirmedBy 应当是 'user-stated'（收到 ${JSON.stringify(raw.confirmedBy)}）`;
  }
  if (!Array.isArray(raw.evidence)) return `意图 ${id} 缺 evidence（谁在什么时候基于什么提出的）`;
  for (const e of raw.evidence) {
    if (!isPlainObject(e) || typeof e.detail !== 'string' || typeof e.at !== 'number') {
      return `意图 ${id} 的 evidence 里有非法条目（每条要有 at 与 detail）`;
    }
  }
  if (typeof raw.createdAt !== 'number' || typeof raw.updatedAt !== 'number') return `意图 ${id} 缺 createdAt / updatedAt`;
  return null;
}

// ─────────────────────────── 提案（AI 的入口）───────────────────────────

/** 提案的顶层键（闭集） */
export const DESIGN_INTENT_PROPOSAL_KEYS: string[] = ['intents', 'reply'];

export interface DesignIntentProposal {
  intents: unknown[];
  reply?: string;
}

/**
 * 意图提案的形状闸门。
 *
 * ── 为什么它不挤进动作清单（ACTIONS）──
 *    动作清单管的是"AI 能改模型什么"；意图提案**改不了模型**——
 *    它只能产生 candidate，要用户确认才生效。所以它是一条**只读侧的提议通道**，
 *    与 DesignProposal（P3）同一套路数，不该让动作数从 21 变成 23。
 *
 * ── 为什么每条都过草案闸门，而不是这里另写一套 ──
 *    未知意图、坐标、自带 status 这三类越界在草案闸门里已经有带教训的人话报错；
 *    再写一份必然分家（`unitIntentsSemanticError` 的教训）。
 */
export function designIntentProposalError(raw: unknown): string | null {
  if (!isPlainObject(raw)) return '意图提案必须是一个 JSON 对象';
  const unknown = Object.keys(raw).filter((k) => !DESIGN_INTENT_PROPOSAL_KEYS.includes(k));
  if (unknown.length > 0) {
    return `意图提案里出现了不认识的字段：${unknown.join('、')}（只允许 ${DESIGN_INTENT_PROPOSAL_KEYS.join(' / ')}）`;
  }
  const list = raw.intents;
  if (!Array.isArray(list)) return '意图提案缺 intents（意图数组）—— 没有意图就不要提这一轮';
  if (list.length === 0) return 'intents 是空数组 —— 没有意图就别说这句';
  if (list.length > DESIGN_INTENT_PROPOSAL_MAX) {
    return `一次给了 ${list.length} 条意图，最多 ${DESIGN_INTENT_PROPOSAL_MAX} 条 —— 请把诉求合并一下再说`;
  }
  for (let i = 0; i < list.length; i++) {
    const bad = designIntentDraftError(list[i]);
    if (bad) return `intents 第 ${i + 1} 条：${bad}`;
  }
  return null;
}

/**
 * 提案 → candidate 列表（**纯函数**，不改任何东西）。
 *
 * 这是"AI 推断只能产生 candidate"的最后一步落点：
 * 走过闸门的提案，出来的**一定是 candidate**，且**没有** confirmedBy ——
 * 这个函数没有办法产出 active，想生效只有一条路：`confirmIntent()`（用户确认）。
 */
export function proposalToCandidates(
  raw: DesignIntentProposal,
  opts: { taken: Iterable<string>; detail: string; at?: number },
): { ok: true; candidates: DesignIntent[] } | { ok: false; error: string } {
  const bad = designIntentProposalError(raw);
  if (bad) return { ok: false, error: bad };
  const taken = new Set(opts.taken);
  const now = opts.at ?? Date.now();
  const candidates: DesignIntent[] = [];
  for (const item of raw.intents) {
    const d = item as Record<string, unknown>;
    // **必须传 takenIds**：不传就每个草案都拿到 di_001，静默共用一条记录
    const id = nextId('di', taken);
    taken.add(id);
    candidates.push({
      id,
      status: 'candidate',
      goal: d.goal as DesignIntent['goal'],
      scope: d.scope as DesignIntentScope,
      ...(typeof d[DESIGN_INTENT_VALUE_KEY] === 'string' ? { openingKind: d[DESIGN_INTENT_VALUE_KEY] as never } : {}),
      ...(typeof d.statement === 'string' && d.statement ? { statement: d.statement } : {}),
      origin: 'ai-inferred',
      // confirmedBy **刻意不写**：candidate 带它就是"未确认却自称生效"
      evidence: [{ at: now, source: 'ai-inferred' as const, detail: opts.detail }],
      createdAt: now,
      updatedAt: now,
    });
  }
  return { ok: true, candidates };
}

// ─────────────────────────── 模型入口（文件加载边界用）───────────────────────────

export interface ModelIntentPartition {
  /** 可以进模型的（全部是 active + 有人认领 + 引用不悬空） */
  keep: DesignIntent[];
  /** 被丢弃的条目及原因（**必须显示给用户**，不许静默丢） */
  dropped: Array<{ raw: unknown; why: string }>;
}

/**
 * 文件里读到的设计意图 → 能进模型的那一份。
 *
 * 丢弃规则（三条，任一命中就丢并给原因）：
 *   ① 形状 / 词表非法（坏字段不毁整个项目 —— 与 P8.9 对 `hinge` 的口径同源）
 *   ② 不是 active / 无人认领 / AI 推断却自己生效（**未确认不能进模型**）
 *   ③ 悬空引用（指着一个已经不存在的房间 / 柜）
 *
 * 为什么**丢弃**而不是**拒绝整个文件**：
 *   意图是注解、不是事实。它坏了顶多"少知道一条诉求"；打不开项目会让用户连柜体尺寸都改不了 ——
 *   后者糟得多。注意这与 `Cabinet.roomId` 悬空**故意不同**：那是事实，
 *   悬空会让整组操作少动一个柜（静默做错事）→ 必须拒绝整个文件。
 */
export function partitionModelIntents(rawList: unknown, project: Project): ModelIntentPartition {
  const keep: DesignIntent[] = [];
  const dropped: Array<{ raw: unknown; why: string }> = [];
  if (!Array.isArray(rawList)) return { keep, dropped };
  const seen = new Set<string>();
  for (const raw of rawList) {
    const bad = designIntentError(raw);
    if (bad) {
      dropped.push({ raw, why: bad });
      continue;
    }
    const i = raw as DesignIntent;
    if (seen.has(i.id)) {
      dropped.push({ raw, why: `意图 id 重复：${i.id}（撞 id 会让两条意图共用一条记录）` });
      continue;
    }
    const m = modelIntentError(i);
    if (m) {
      dropped.push({ raw, why: m });
      continue;
    }
    const dg = danglingIntentError(i, project);
    if (dg) {
      dropped.push({ raw, why: dg });
      continue;
    }
    seen.add(i.id);
    keep.push(i);
  }
  return { keep, dropped };
}
