/**
 * ══════════════════════════════════════════════════════════════════════
 *  设计意图（DesignIntent）—— 记录模型与生命周期（P9.2）
 *
 *  ── 它属于真相源，与 Knowledge 不是一类东西 ──
 *      Knowledge（P6）：**跨项目仍成立的习惯**（"我习惯背面齐"）→ 换个项目也成立
 *                       → 独立存储，`store.ts` 写明"知识不进 project.json"。
 *      DesignIntent   ：**这份设计当前的目标**（"这个厨房要优先储物"）→ 换个项目就不成立
 *                       → **属于这份设计的真相源**，随项目进 project.json。
 *
 *  ── 模型只装 active（P8.5-B 的教训直接搬过来）──
 *      "未确认" 与 "已确认" 是**真实语义差异**：
 *        · AI 推断只产生 candidate —— 它是"提案"，不是设计目标；
 *        · candidate 一旦落盘，下次打开就分不清"用户要的"和"AI 猜的"；
 *        · 而 `preview === commit`、`dryRun === commit` 两条逐字节不变量，
 *          全都建立在"模型里只有已确认的事"之上。
 *      所以：**candidate 只活在意图提案对象里**，确认之后才以 active 进模型。
 *
 *  ── `'system'` 在类型层就不存在 ──
 *      §4 明令"系统不产生偏好"。把 `'system'` 从 origin 的联合类型里去掉，
 *      比"能写出来再靠校验拦住"彻底一档：写不出来。
 *
 *  ── 悬空引用的态度（照 P8.9 对 hinge 的口径）──
 *      意图是**注解**不是**事实**：它指着一个已经被删掉的柜/房间时，
 *      丢弃它并给出可见警告，**绝不因为一个坏注解让项目打不开**；
 *      也绝不"猜一个最近的柜顶上"（那就是编数据）。
 *      注意与 Cabinet.roomId 悬空**故意不同**：那是事实，悬空会让整组操作少动一个柜 → 必须拒绝文件。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { OpeningKind, Project } from '../types.ts';
import { nextId } from '../ids.ts';
import type { DesignIntentGoal } from './vocabulary.ts';
import { designIntentGoalZh } from './vocabulary.ts';

/**
 * 生命周期三态（与 P6 Knowledge 同名同义，不另起一套叫法）。
 *   candidate = 提出了还没被确认（**只活在提案里，不进模型**）
 *   active    = 生效中（**只有它能进模型**）
 *   rejected  = 被否掉（不进模型；留在提案/会话里说明"这条被否过"）
 */
export type DesignIntentStatus = 'candidate' | 'active' | 'rejected';

/**
 * 谁提出了这条意图。**没有 `'system'`**（见文件头）。
 *   user-stated  = 用户自己说的（本身就是确认）
 *   ai-inferred  = AI 推断的（**只能是 candidate**）
 */
export type DesignIntentOrigin = 'user-stated' | 'ai-inferred';

/** 谁让它生效的。只有 active 才有 —— 缺了就是"没确认过"。 */
export type DesignIntentConfirmedBy = 'user-stated' | 'user-confirmed';

/**
 * 意图说的是"哪一层的事"。
 *
 * ── 为什么这里可以挂 roomId / cabinetId，而 `wallId` / `openingId` 一律不挂 ──
 *   `scope` 回答的是"**这条意图是关于谁的**"（它是这条记录的主语）；
 *   而 `wallId` 回答的是"**贴到哪面墙上去**" —— 那是落位决定。
 *   两者只差一步：写得出 `wallId`，"贴哪面墙"就成了意图能拍板的事，
 *   `{x,y,rotation}` 也就不远了。
 *   所以这里**在类型层**只留两种 scope —— 想写 `{kind:'wall', wallId}` 的人
 *   根本写不出来（不是靠运行时校验拦住，是靠联合类型表达不出来）。
 */
export type DesignIntentScope =
  | { kind: 'room'; roomId: string }
  | { kind: 'cabinet'; cabinetId: string };

/** 一条证据：什么时候、什么来源、说了什么（原话照留，任何改写都可能曲解原意） */
export interface DesignIntentEvidence {
  at: number;
  source: DesignIntentOrigin | DesignIntentConfirmedBy;
  /** 原话 / 命令 label / 提案标题（照原样保留） */
  detail: string;
}

export interface DesignIntent {
  id: string;
  status: DesignIntentStatus;
  /** 想要什么（词表里的一个词） */
  goal: DesignIntentGoal;
  /** 关于谁 */
  scope: DesignIntentScope;
  /**
   * `near-opening` 专用：只算门还是只算窗。
   * 词表里**唯一**允许出现的取值字段（见 vocabulary 的 DESIGN_INTENT_VALUE_KEY）。
   */
  openingKind?: OpeningKind;
  /** 用户原话（可选，展示与审计用；**不可判定**，不参与任何判定） */
  statement?: string;
  /** 谁提出的（没有 'system'） */
  origin: DesignIntentOrigin;
  /** 谁让它生效的 —— only active；candidate 带了它 = 未确认却自称生效，非法 */
  confirmedBy?: DesignIntentConfirmedBy;
  evidence: DesignIntentEvidence[];
  createdAt: number;
  updatedAt: number;
}

/** 意图 id：确定性、可读、可预测（与 `cab_001` / `unit_001` 同一套；**必须传 takenIds**） */
export function designIntentId(taken: Iterable<string>): string {
  return nextId('di', taken);
}

/** 项目里已经占用的全部意图 id（造新意图前先建这个集合 —— 撞 id 不会报错，只会静默共用记录） */
export function takenIntentIds(project: Project): Set<string> {
  return new Set((project.designIntents ?? []).map((i) => i.id));
}

// ─────────────────────────── 构造：只有两条入口 ───────────────────────────

/**
 * 用户明说的意图：**直接 active + confirmedBy:'user-stated'**。
 * 用户原话就是最高证据（与 `makeStatedPreference` 同一条纪律）。
 */
export function makeStatedIntent(input: {
  goal: DesignIntentGoal;
  scope: DesignIntentScope;
  openingKind?: OpeningKind;
  statement?: string;
  detail: string;
  taken: Iterable<string>;
}): DesignIntent {
  const now = Date.now();
  return {
    id: designIntentId(input.taken),
    status: 'active',
    goal: input.goal,
    scope: input.scope,
    ...(input.openingKind ? { openingKind: input.openingKind } : {}),
    ...(input.statement ? { statement: input.statement } : {}),
    origin: 'user-stated',
    confirmedBy: 'user-stated',
    evidence: [{ at: now, source: 'user-stated', detail: input.detail }],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * AI 推断的意图：**只能是 candidate，且没有 confirmedBy**。
 *
 * 这个函数是"AI 推断只能产生 candidate"在代码里的落点 ——
 * 它**没有**参数能让你把它造成 active，想生效只能走 `confirmIntent()`（用户确认）。
 */
export function makeCandidateIntent(input: {
  goal: DesignIntentGoal;
  scope: DesignIntentScope;
  openingKind?: OpeningKind;
  statement?: string;
  detail: string;
  taken: Iterable<string>;
}): DesignIntent {
  const now = Date.now();
  return {
    id: designIntentId(input.taken),
    status: 'candidate',
    goal: input.goal,
    scope: input.scope,
    ...(input.openingKind ? { openingKind: input.openingKind } : {}),
    ...(input.statement ? { statement: input.statement } : {}),
    origin: 'ai-inferred',
    // confirmedBy **刻意不写**：candidate 带它就是"未确认却自称生效"
    evidence: [{ at: now, source: 'ai-inferred', detail: input.detail }],
    createdAt: now,
    updatedAt: now,
  };
}

// ─────────────────────────── 生命周期迁移 ───────────────────────────

/**
 * 用户确认一条 candidate → active（**唯一**的人工升级通道）。
 *
 * 只对 `status === 'candidate'` 生效：已经 active / 已 rejected 的**原样返回**，
 * 不"顺手把它激活"。rejected 不能靠再确认一次复活 —— 要复活应当重新提一条，
 * 否则"我否过它"这件事就没有痕迹了。
 */
export function confirmIntent(list: DesignIntent[], id: string): DesignIntent[] {
  const now = Date.now();
  return list.map((i) =>
    i.id === id && i.status === 'candidate'
      ? {
          ...i,
          status: 'active' as const,
          confirmedBy: 'user-confirmed' as const,
          evidence: [...i.evidence, { at: now, source: 'user-confirmed' as const, detail: '用户确认生效' }],
          updatedAt: now,
        }
      : i,
  );
}

/** 否掉一条意图（candidate 或 active 都可以被否；否掉 = 不进模型/从模型里退场） */
export function rejectIntent(list: DesignIntent[], id: string, detail = '被否掉'): DesignIntent[] {
  const now = Date.now();
  return list.map((i) =>
    i.id === id ? { ...i, status: 'rejected' as const, evidence: [...i.evidence, { at: now, source: 'user-stated' as const, detail }], updatedAt: now } : i,
  );
}

// ─────────────────────────── 模型侧的唯一入口 ───────────────────────────

/** 模型里生效中的意图（**读侧唯一入口** —— 别处不许直接读 `project.designIntents`） */
export function activeDesignIntents(project: Project): DesignIntent[] {
  return (project.designIntents ?? []).filter((i) => i.status === 'active');
}

/**
 * 这条意图能不能进模型 —— 不能则给出人话原因。
 *
 * 两道门：
 *   ① **未确认不能进 active**：`status !== 'active'` 一律不许进模型（candidate 是提案，rejected 是记录）；
 *   ② **active 必须有人认领**：`confirmedBy` 缺失的 active 是"凭空生效"，同样拒收。
 * 悬空引用（指向不存在的房间/柜）不在这里判 —— 那要看项目，见 `danglingIntentError()`。
 */
export function modelIntentError(i: DesignIntent): string | null {
  if (i.status !== 'active') {
    return `意图 ${i.id} 的状态是 ${i.status}，只有 active 能进模型（candidate 是提案，确认之后才生效）`;
  }
  if (i.confirmedBy !== 'user-stated' && i.confirmedBy !== 'user-confirmed') {
    return `意图 ${i.id} 是 active 却没有人认领（confirmedBy 缺失）—— 生效必须有人确认`;
  }
  if (i.origin === 'ai-inferred' && i.confirmedBy !== 'user-confirmed') {
    return `意图 ${i.id} 来自 AI 推断，必须以 confirmedBy:'user-confirmed' 生效（不能自己宣布生效）`;
  }
  if (i.origin === 'user-stated' && i.confirmedBy !== 'user-stated') {
    return `意图 ${i.id} 是用户明说的，confirmedBy 应当是 'user-stated'（收到 ${String(i.confirmedBy)}）`;
  }
  return null;
}

/** 悬空引用：指着已经不存在的房间/柜。返回人话原因，或 null。 */
export function danglingIntentError(i: DesignIntent, project: Project): string | null {
  // 取成局部常量再收窄：`i.scope` 是可变属性，回调里不会被 TS 收窄
  const scope = i.scope;
  if (scope.kind === 'room') {
    const roomId = scope.roomId;
    return project.rooms.some((r) => r.id === roomId) ? null : `意图 ${i.id} 指向的房间 ${roomId} 已经不存在`;
  }
  const cabinetId = scope.cabinetId;
  return project.cabinets.some((c) => c.id === cabinetId) ? null : `意图 ${i.id} 指向的柜体 ${cabinetId} 已经不存在`;
}

/** 按 id 找（找不到返回 undefined；找不到**不编**一个出来） */
export function findIntent(list: DesignIntent[], id: string): DesignIntent | undefined {
  return list.find((i) => i.id === id);
}

// ─────────────────────────── 人话 ───────────────────────────

const SCOPE_ZH = (scope: DesignIntentScope, project?: Project): string => {
  // 先把可辨识字段取成局部常量：函数参数在回调里不会被 TS 收窄，
  // 直接在 `find((x) => …)` 里用 `scope.roomId` 会报「联合类型上没有这个属性」
  if (scope.kind === 'room') {
    const roomId = scope.roomId;
    const r = project?.rooms.find((x) => x.id === roomId);
    return `房间「${r?.name ?? roomId}」`;
  }
  const cabinetId = scope.cabinetId;
  const c = project?.cabinets.find((x) => x.id === cabinetId);
  return `柜体「${c?.name ?? cabinetId}」`;
};

/** 一句话说清这条意图（界面、报告、提示共用；**不在别处再拼一遍**） */
export function designIntentZh(i: DesignIntent, project?: Project): string {
  const value = i.openingKind ? `（只算${i.openingKind === 'door' ? '门' : '窗'}）` : '';
  return `${SCOPE_ZH(i.scope, project)}：${designIntentGoalZh(i.goal)}${value}`;
}

const STATUS_ZH: Record<DesignIntentStatus, string> = { candidate: '待确认', active: '生效中', rejected: '已否掉' };
const ORIGIN_ZH: Record<DesignIntentOrigin, string> = { 'user-stated': '用户明说', 'ai-inferred': 'AI 推断' };

export const designIntentStatusZh = (s: DesignIntentStatus): string => STATUS_ZH[s] ?? s;
export const designIntentOriginZh = (o: DesignIntentOrigin): string => ORIGIN_ZH[o] ?? String(o);
