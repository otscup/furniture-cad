/**
 * ══════════════════════════════════════════════════════════════════════
 *  Knowledge Resolver —— 确定性的知识解析层（纯函数，不碰模型不写存储）
 *
 *  输入：当前设计上下文 + 全部知识条目
 *  输出：适用于当前设计的知识集合 + 为什么适用 + 是否用户确认 + 冲突
 *
 *  ── 三条边界 ──
 *    1. 不修改 Semantic Model，不产生 Command，不写 store —— 输出只是
 *       「建议依据」，消费方（AI 规划 / Vision 映射）仍走既有链路。
 *    2. 优先级确定性：hardRule > designKnowledge > userPreference。
 *       与硬规则数值冲突的偏好被**压制**（进 suppressed + conflicts），
 *       绝不返回为可执行建议 —— 「我喜欢 400 抽屉」vs「五金最小净宽 450」
 *       这类矛盾在规划前就暴露，而不是等 Rules 在提交时炸掉。
 *    3. candidate 一律不进 applicable —— 没被用户确认的知识不参与规划。
 * ══════════════════════════════════════════════════════════════════════
 */

import {
  contextCovers,
  contextKey,
  placementContextZh,
  type KnowledgeEntry,
  type KnowledgePredicate,
  type KnowledgeScope,
  type PlacementContext,
} from './model.ts';

/** 当前设计上下文（Resolver 只读它做 scope 匹配） */
export interface KnowledgeContext {
  cabinetName?: string;
  roomName?: string;
}

export interface ResolvedKnowledge {
  entry: KnowledgeEntry;
  /** 为什么适用（scope 匹配 + 确认状态的人话说明） */
  why: string;
  /** 用户确认过的？（user-stated 或人工确认 = true） */
  confirmed: boolean;
}

export interface KnowledgeConflict {
  /** 压制方（优先级高的一方） */
  winner: KnowledgeEntry;
  /** 被压制方（保留来源与原文，不静默丢弃） */
  loser: KnowledgeEntry;
  /** 确定性理由（人话 + 机器可比对） */
  reason: string;
  kind: 'hard-rule-beats-preference' | 'hard-rule-beats-knowledge' | 'same-layer-contradiction';
}

export interface KnowledgeResolution {
  /** 可用知识（active + scope 匹配 + 未被压制），按层排序：hard → design → preference */
  applicable: ResolvedKnowledge[];
  /** 发现的冲突（保留双方来源；硬规则压制的偏好在此列出） */
  conflicts: KnowledgeConflict[];
  /** 被硬规则压制的条目（不出现在 applicable，但来源与原文都在 conflicts.loser 里） */
  suppressed: KnowledgeEntry[];
}

const LAYER_RANK: Record<KnowledgeEntry['layer'], number> = {
  hardRule: 0,
  designKnowledge: 1,
  userPreference: 2,
};

/** scope 匹配：条目的 cabinet/room 未填 = 不限；填了必须精确相等 */
export function scopeMatches(scope: KnowledgeScope, ctx: KnowledgeContext): boolean {
  if (scope.cabinet && scope.cabinet !== 'any' && scope.cabinet !== ctx.cabinetName) return false;
  if (scope.room && scope.room !== 'any' && scope.room !== ctx.roomName) return false;
  return true;
}

/** 数值型谓词维度集合（枚举维度不做数值比较） */
const NUMERIC_KINDS = new Set(['drawerCount', 'rowHeight', 'cabinetWidth', 'cabinetDepth']);

function asNumber(v: number | string): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 两个谓词是否冲突（同维度才比；枚举维度只比 forbid / prefer 不等）。
 * 返回 null = 不冲突或不可判定（不可判定 ≠ 无冲突 —— 但第一版只对可判定
 * 维度断言，别的留给 Rules 在提交时拦，绝不在这里假装判过）。
 */
export function predicatesConflict(a: KnowledgePredicate, b: KnowledgePredicate): boolean | null {
  if (a.kind !== b.kind) return false;
  // 上下文不同 = 说的不是同一件事：右转角偏好 270 与左转角偏好 90 并不矛盾
  // —— 反过来，若不看上下文，两条偏好会被误判成冲突而被迫"二选一"。
  if (contextKey(a.context) !== contextKey(b.context)) return false;
  // 枚举维度：prefer 两个不同值 = 矛盾建议（同层）；forbid 命中 prefer 的值 = 硬禁止
  if (!NUMERIC_KINDS.has(a.kind)) {
    if (a.op === 'prefer' && b.op === 'prefer') return a.value !== b.value;
    if (a.op === 'forbid' && b.op === 'prefer') return a.value === b.value;
    if (b.op === 'forbid' && a.op === 'prefer') return b.value === a.value;
    return false;
  }
  const av = asNumber(a.value);
  const bv = asNumber(b.value);
  if (av === null || bv === null) return null;
  // prefer vs min/max：建议值越过边界
  if (a.op === 'prefer' && b.op === 'min') return av < bv;
  if (a.op === 'prefer' && b.op === 'max') return av > bv;
  if (b.op === 'prefer' && a.op === 'min') return bv < av;
  if (b.op === 'prefer' && a.op === 'max') return bv > av;
  // 同层两条 prefer 不同的数值 = 矛盾
  if (a.op === 'prefer' && b.op === 'prefer') return av !== bv;
  // min vs max 是互补约束（min<=max 合法），min/min 不同值 = 边界不一致
  if (a.op === 'min' && b.op === 'min') return av !== bv;
  if (a.op === 'max' && b.op === 'max') return av !== bv;
  return false;
}

const LAYER_ZH: Record<KnowledgeEntry['layer'], string> = {
  hardRule: '硬规则',
  designKnowledge: '设计知识',
  userPreference: '用户偏好',
};

function whyOf(e: KnowledgeEntry, ctx: KnowledgeContext): string {
  const parts: string[] = [`层=${LAYER_ZH[e.layer]}`];
  if (e.scope.cabinet && e.scope.cabinet !== 'any') parts.push(`限定柜体「${e.scope.cabinet}」（当前：${ctx.cabinetName ?? '未指定'}）`);
  if (e.scope.room && e.scope.room !== 'any') parts.push(`限定房间「${e.scope.room}」（当前：${ctx.roomName ?? '未指定'}）`);
  const originZh: Record<string, string> = {
    'ai-inferred': '来自 AI 推测',
    'user-observed': '来自你的修改行为观察',
    'user-stated': '你亲自确认',
    system: '系统登记',
  };
  parts.push(originZh[e.evidence[0]?.source ?? 'system']);
  if (e.confirmedAt) parts.push('已确认');
  if (e.predicate?.context) parts.push(`适用情形：${placementContextZh(e.predicate.context)}`);
  return parts.join(' · ');
}

/**
 * 解析。纯函数：传入的 entries 不被修改（验收会深比较）。
 */
export function resolveKnowledge(ctx: KnowledgeContext, entries: KnowledgeEntry[]): KnowledgeResolution {
  const applicable: ResolvedKnowledge[] = [];
  const suppressed: KnowledgeEntry[] = [];
  const conflicts: KnowledgeConflict[] = [];

  const active = entries.filter((e) => e.status === 'active' && scopeMatches(e.scope, ctx));

  // ① hardRule 全部进 applicable（它们是约束的引用，用于 AI 提前避让 + 冲突判定）
  const hardRules = active.filter((e) => e.layer === 'hardRule');
  for (const e of hardRules) applicable.push({ entry: e, why: whyOf(e, ctx), confirmed: Boolean(e.confirmedAt) });

  // ② designKnowledge / userPreference：先过硬规则压制，再做同层矛盾检测
  const soft = active.filter((e) => e.layer !== 'hardRule');
  const beaten = new Set<string>();
  for (const soft_ of soft) {
    if (!soft_.predicate) {
      applicable.push({ entry: soft_, why: whyOf(soft_, ctx), confirmed: Boolean(soft_.confirmedAt) });
      continue;
    }
    let killed: KnowledgeEntry | null = null;
    for (const h of hardRules) {
      if (!h.predicate) continue;
      if (predicatesConflict(h.predicate, soft_.predicate) === true) {
        killed = h;
        break;
      }
    }
    if (killed) {
      beaten.add(soft_.id);
      suppressed.push(soft_);
      conflicts.push({
        winner: killed,
        loser: soft_,
        kind: soft_.layer === 'userPreference' ? 'hard-rule-beats-preference' : 'hard-rule-beats-knowledge',
        reason: `${LAYER_ZH[killed.layer]}「${killed.statement}」压制${LAYER_ZH[soft_.layer]}「${soft_.statement}」—— 硬规则优先，偏好不采用。`,
      });
    } else {
      applicable.push({ entry: soft_, why: whyOf(soft_, ctx), confirmed: Boolean(soft_.confirmedAt) });
    }
  }

  // ③ 同层矛盾（未被压制的软知识之间）：都保留、都返回，冲突暴露给 AI/人权衡
  const softAlive = soft.filter((e) => !beaten.has(e.id) && e.predicate);
  for (let i = 0; i < softAlive.length; i++) {
    for (let j = i + 1; j < softAlive.length; j++) {
      const a = softAlive[i]!;
      const b = softAlive[j]!;
      if (predicatesConflict(a.predicate!, b.predicate!) !== true) continue;
      const lo = LAYER_RANK[a.layer] <= LAYER_RANK[b.layer] ? a : b;
      const hi = lo === a ? b : a;
      conflicts.push({
        winner: hi,
        loser: lo,
        kind: 'same-layer-contradiction',
        reason: `${LAYER_ZH[hi.layer]}「${hi.statement}」（${hi.predicate!.kind}=${String(hi.predicate!.value)}）与${LAYER_ZH[lo.layer]}「${lo.statement}」（${lo.predicate!.kind}=${String(lo.predicate!.value)}）矛盾 —— 双方都保留，请人工裁决；AI 不替你选。`,
      });
      // 登记到条目上（只在 resolver 的**输出副本**概念里表达；不改输入 ——
      // 条目自身的 conflicts 字段由 store 层在发现冲突时落盘，见 resolveAndRecord）
    }
  }

  // 排序：层优先级 → 置信度
  applicable.sort((x, y) => LAYER_RANK[x.entry.layer] - LAYER_RANK[y.entry.layer] || y.entry.confidence - x.entry.confidence);
  return { applicable, conflicts, suppressed };
}

/** 段落维度是否可判定参与冲突（供观察器决定是否生成谓词） */
export function isJudgable(kind: KnowledgePredicate['kind']): boolean {
  return NUMERIC_KINDS.has(kind) || kind === 'unitKind' || kind === 'layoutStyle' || kind === 'alignment';
}

/**
 * 当前情形下**建议**的朝向（P8.4）—— 只回答"建议什么"，**不回答"几何怎么算"**。
 *
 *  · 只从 `applicable` 里读：未确认的 candidate 不算，被硬规则压制的也不算。
 *  · 它不参与、更不影响 `resolvePlacement` —— 落位永远是确定性解析的结果。
 *  · 返回 null = 没有可依据的偏好。**没依据就别说**，不猜一个默认值回来。
 */
export function preferredOrientation(res: KnowledgeResolution, ctx: PlacementContext): number | null {
  for (const { entry } of res.applicable) {
    const p = entry.predicate;
    if (!p || p.kind !== 'orientation' || p.op !== 'prefer') continue;
    if (!contextCovers(p.context, ctx)) continue;
    const n = Number(p.value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 当前情形下**建议**的落位对齐方式（P8.5-C1）—— 与 preferredOrientation 同源纪律：
 * 只回答"建议什么"，不改变几何；只从 `applicable` 读；无依据返回 null。
 *
 * 对齐证据来自用户确认的 AI 落位提案（cabinet.place 的 placementIntent），
 * 属弱证据（UI 没有对齐入口），须用户在知识面板确认才进 applicable。
 */
export function preferredAlignment(res: KnowledgeResolution, ctx: PlacementContext): string | null {
  for (const { entry } of res.applicable) {
    const p = entry.predicate;
    if (!p || p.kind !== 'alignment' || p.op !== 'prefer') continue;
    if (!contextCovers(p.context, ctx)) continue;
    if (typeof p.value === 'string') return p.value;
  }
  return null;
}
