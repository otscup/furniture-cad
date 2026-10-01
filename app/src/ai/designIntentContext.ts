/**
 * ══════════════════════════════════════════════════════════════════════
 *  设计意图的 AI 只读上下文（P9.2）
 *
 *  ── 为什么它是**独立一块**，不塞进 spatialContext ──
 *    `spatialContext`（P9.1）装的是**派生出来的空间事实**："这面墙多长、这扇门往里开"。
 *    `designIntent` 装的是**用户确认过的设计目标**："这个厨房要优先储物"。
 *    一个是世界的样子，一个是人想要的样子 —— 混在一个块里，
 *    下一个人读快照时分不清哪句是事实、哪句是诉求（而这两者犯错的方式完全不同：
 *    事实错 = 系统算错；诉求错 = 系统会错，但它本来就是用户的权利）。
 *
 *  ── 纯投影 ──
 *    只读 `activeDesignIntents(project)`，逐字段重塑形。
 *    本文件**不判断任何事**：不评估意图满没满足（那是 P9.4 的事），
 *    不给"哪条更重要"（那是优先级本身的含义），也不补默认值。
 *
 *  ── 零坐标 ──
 *    本块里不会出现任何数字：goal 是词，scope 是 id，openingKind 是枚举。
 *    （`fact` 字段是**事实维度的名字**，不是值 —— 它只回答"这条将来对账时看哪一项"。）
 * ══════════════════════════════════════════════════════════════════════
 */
import type { OpeningKind, Project } from '../core/types.ts';
import { activeDesignIntents, type DesignIntent } from '../core/designIntent/model.ts';
import { DESIGN_INTENT_GOAL_ORDER, designIntentGoalSpec, designIntentGoalZh } from '../core/designIntent/vocabulary.ts';

/** 一条意图在快照里的形状（全部来自模型，没有一个字段是这里算出来的） */
export interface AiDesignIntent {
  id: string;
  /** 词表里的词（AI 可以据此判断"用户想要什么"） */
  goal: string;
  /** 该词的人话 */
  goalZh: string;
  /** 'room' | 'cabinet' —— 这条意图说的是哪一层的事 */
  scope: 'room' | 'cabinet';
  /** scope 指向的房间 id（scope='room' 时） */
  roomId?: string;
  /** scope 指向的柜体 id（scope='cabinet' 时） */
  cabinetId?: string;
  /** 仅 near-opening：只算门还是只算窗 */
  openingKind?: OpeningKind;
  /** 用户原话（可选；**照原样**，不改写） */
  statement?: string;
  /** 谁提出的：user-stated / ai-inferred（**没有 system**） */
  origin: string;
  /** 将来对账时读哪个**既有**事实维度；null = 不可判定（取舍方向类） */
  fact: string | null;
  /** "什么算满足"的人话；不可判定类如实说不可判定 */
  expect: string;
}

export interface AiDesignIntentContext {
  /**
   * 恒为 true —— 与 `spatialContext.readOnly` 同一条纪律：
   * 这是**给 AI 看的事实/目标**，不是给它改的入口。
   */
  readOnly: true;
  /** 本块里一共几条目标（= 模型里 active 的条数；空项目为 0） */
  count: number;
  /** 按词表顺序列出（稳定顺序 = 同一份模型永远给出同一段文本） */
  intents: AiDesignIntent[];
}

function project1(i: DesignIntent): AiDesignIntent {
  const spec = designIntentGoalSpec(i.goal);
  return {
    id: i.id,
    goal: i.goal,
    goalZh: designIntentGoalZh(i.goal),
    scope: i.scope.kind,
    ...(i.scope.kind === 'room' ? { roomId: i.scope.roomId } : { cabinetId: i.scope.cabinetId }),
    ...(i.openingKind ? { openingKind: i.openingKind } : {}),
    ...(i.statement ? { statement: i.statement } : {}),
    origin: i.origin,
    fact: spec.fact,
    expect: spec.expect,
  };
}

/**
 * 模型 → 快照块。**空项目也给一个四条字段齐备的空块**（不是 `undefined`）：
 * 形状稳定才能让提示词前缀在多轮之间逐字节相同（与 P9.1 的做法一致）。
 */
export function buildDesignIntentContext(project: Project): AiDesignIntentContext {
  const active = activeDesignIntents(project);
  const order = new Map(DESIGN_INTENT_GOAL_ORDER.map((g, k) => [g, k]));
  // 排序键：先按词表顺序，再按 id —— 与模型的存入顺序无关，同一份模型永远同一段文本
  const intents = [...active]
    .sort((a, b) => (order.get(a.goal) ?? 999) - (order.get(b.goal) ?? 999) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(project1);
  return { readOnly: true, count: intents.length, intents };
}
