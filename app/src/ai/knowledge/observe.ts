/**
 * ══════════════════════════════════════════════════════════════════════
 *  修改观察器 —— 「AI 原方案 vs 用户最终方案」的语义差异 → 知识候选
 *
 *  ── 第一版只认有限、可靠的语义事实（不自动总结所有修改）──
 *    · layout.rows[N].height            → rowHeight 观察行高 A→B
 *    · units[M].count / rows…units…count → drawerCount 观察数量 A→B
 *    · units[M].kind / rows…units…kind  → unitKind 观察类型 A→B
 *    · params.width / params.depth      → cabinetWidth/Depth 观察尺寸
 *    这些都是 CommandBus 的 changes 已经算好的路径 diff —— 观察器只翻译，
 *    不重新 diff（两份判定必然漂移）。
 *
 *  ── 铁律：观察 ≠ 偏好 ──
 *    · 任何观察只产生 candidate（低置信），不产生 active。
 *    · candidate 必须用户在知识面板确认后才生效（唯一升级通道）。
 *    · 用户明说「以后都这样做」→ user-stated → 直接 active（makeStatedPreference）。
 *
 *  ── 来源区分 ──
 *    cmd.source === 'ai'      → ai-inferred（AI 提案被采纳的痕迹）
 *    其他（ui / user / mcp）   → user-observed（人的手改）
 *    两者都留下 evidence 原话（label / intent.nl），provenance 可追溯。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { Command, CommandSource, DiffEntry } from '../../core/commandBus.ts';
import {
  contextKey,
  placementContextZh,
  type KnowledgeEvidence,
  type KnowledgePredicate,
  type PlacementContext,
  type PredicateKind,
} from './model.ts';
import { makeCandidate, type KnowledgeEntry } from './model.ts';

/** 一条从命令里提取的语义观察（尚未成为知识） */
export interface SemanticObservation {
  predicate: KnowledgePredicate;
  /** 人话陈述（陈述「用户把什么从 A 改成了 B」） */
  statement: string;
  /** 证据（原话 / 命令 label —— provenance 本体） */
  evidence: KnowledgeEvidence;
  /** 建议的 scope（从命令目标推导） */
  scopeCabinet?: string;
}

const UNIT_KINDS = new Set(['drawerBank', 'hanging', 'shelves', 'open', 'appliance']);

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

const norm360 = (deg: number): number => ((Math.round(deg) % 360) + 360) % 360;

/**
 * 这条命令是不是**人的手改** —— 只有它能证明"这是用户的选择"。
 *   · 'ai'     = AI 自己给出的朝向（尚未经用户确认）→ 不得冒充 user-observed
 *   · 'system' = 撤销 / 重做 / 系统自动解析 → 不是新事实
 *   · 'ui' / 'mcp' = 界面手改 / 脚本代用户执行 → 人才做的决定
 */
const isHumanSource = (s: CommandSource): boolean => s !== 'ai' && s !== 'system';

function predicateFromChange(
  ch: DiffEntry,
  human: boolean,
  placementCtx?: PlacementContext | null,
): Omit<SemanticObservation, 'evidence'> | null {
  const path = ch.path;
  const num = (v: unknown): number | null => (isNum(v) ? v : null);

  // ── 柜体朝向（P8.4）──
  // 这是本阶段唯一新增的落位维度，也是**门禁最严**的一个：
  //   · 必须是人的改动（AI 给的朝向不算证据，系统自动解析的更不算）
  //   · 必须拿得到上下文（说不出是哪一类情形 → 这条改动不产生知识）
  //   · 同值写入 / 等价角（-90 ≡ 270）不算改动
  if (path === 'placement.rotation') {
    const from = num(ch.from);
    const to = num(ch.to);
    if (from === null || to === null) return null;
    if (norm360(from) === norm360(to)) return null;
    if (!human) return null;
    if (!placementCtx || (placementCtx.contact === undefined && placementCtx.turnSide === undefined)) return null;
    const toDeg = norm360(to);
    return {
      predicate: { kind: 'orientation', op: 'prefer', value: toDeg, context: placementCtx },
      statement: `在${placementContextZh(placementCtx)}里，朝向从 ${norm360(from)}° 改成 ${toDeg}°`,
    };
  }

  // 行高：layout.rows.N.height
  if (/^layout(\.rows\.\d+)?\.height$/.test(path) || path === 'layout.height') {
    const from = num(ch.from);
    const to = num(ch.to);
    if (from === null || to === null || from === to) return null;
    return {
      predicate: { kind: 'rowHeight', op: 'prefer', value: to },
      statement: `行高从 ${from}mm 改成 ${to}mm`,
      scopeCabinet: undefined,
    };
  }

  // 分区类型：…units.M.kind
  const kindM = /(?:^|\.)units\.(\d+)\.kind$/.exec(path);
  if (kindM) {
    const from = typeof ch.from === 'string' && UNIT_KINDS.has(ch.from) ? ch.from : null;
    const to = typeof ch.to === 'string' && UNIT_KINDS.has(ch.to) ? ch.to : null;
    if (!from || !to || from === to) return null;
    return {
      predicate: { kind: 'unitKind', op: 'prefer', value: to },
      statement: `分区类型从「${from}」改成「${to}」`,
    };
  }

  // 抽屉/层板数量：…units.M.count
  const countM = /(?:^|\.)units\.(\d+)\.count$/.exec(path);
  if (countM) {
    const from = num(ch.from);
    const to = num(ch.to);
    if (from === null || to === null || from === to) return null;
    return {
      predicate: { kind: 'drawerCount', op: 'prefer', value: to },
      statement: `分区件数从 ${from} 改成 ${to}`,
    };
  }

  // 柜宽 / 柜深：params.width / params.depth
  if (path === 'params.width') {
    const from = num(ch.from);
    const to = num(ch.to);
    if (from === null || to === null || from === to) return null;
    return { predicate: { kind: 'cabinetWidth', op: 'prefer', value: to }, statement: `柜宽从 ${from}mm 改成 ${to}mm` };
  }
  if (path === 'params.depth') {
    const from = num(ch.from);
    const to = num(ch.to);
    if (from === null || to === null || from === to) return null;
    return { predicate: { kind: 'cabinetDepth', op: 'prefer', value: to }, statement: `柜深从 ${from}mm 改成 ${to}mm` };
  }

  return null;
}

/**
 * 从一条已执行的命令里提取语义观察（可能 0 ~ N 条）。
 * 吃 **LogEntry.diff**（CommandBus 已算好的权威路径 diff）—— 观察器只翻译，
 * 不重新 diff（两份判定必然漂移）。
 */
export function observeCommand(
  cmd: Command,
  diff: DiffEntry[],
  cabinetName?: string,
  placementCtx?: PlacementContext | null,
): SemanticObservation[] {
  // `cabinet.place` **刻意不在列表里**：它的坐标是 Resolver 算出来的，不是人的选择
  // （系统自动落位产生偏好 = 把算法的输出当成用户的习惯，必然自我强化）。
  if (cmd.op !== 'cabinet.update' && cmd.op !== 'cabinet.create' && cmd.op !== 'cabinet.rotate') return [];
  // 撤销/重做不是新事实 —— 不观察（否则 undo 一次会把"旧值"当成新偏好）
  if (cmd.source === 'system') return [];

  const source = cmd.source === 'ai' ? 'ai-inferred' : 'user-observed';
  const detail = cmd.label || cmd.intent?.nl || `${cmd.op} ${diff.map((c) => c.path).join(', ')}`;
  const out: SemanticObservation[] = [];
  for (const ch of diff) {
    const obs = predicateFromChange(ch, isHumanSource(cmd.source), placementCtx);
    if (!obs) continue;
    out.push({
      ...obs,
      evidence: { at: Date.now(), source, detail, cabinetId: cmd.target?.id },
      // 落位类偏好挂在**情形**上（contact / turnSide），不挂在某个柜子的名字上：
      // 挂名字就等于"这只柜喜欢 270°"—— 既不可复用（换个柜子就不算），
      // 又会在该生效时不生效（scope 不匹配 → 被 scopeMatches 挡掉）。
      // 是哪只柜改的，证据里 `cabinetId` 已经留痕了，不需要再占用 scope。
      scopeCabinet: obs.predicate?.context ? undefined : cabinetName,
    });
  }
  return out;
}

/**
 * 观察 → candidate 知识（追加进列表）。
 * 同 layer+predicate+scope 的既有条目：只追加证据、涨置信（上限 0.9 ——
 * 永远差一步到「确认」，把最后一步留给用户）；状态不变。
 * 不同则新建 candidate。
 */
export function recordObservation(list: KnowledgeEntry[], obs: SemanticObservation, layer: KnowledgeEntry['layer'] = 'userPreference'): KnowledgeEntry[] {
  const hit = list.find(
    (e) =>
      e.status === 'candidate' &&
      e.layer === layer &&
      e.predicate &&
      obs.predicate &&
      e.predicate.kind === obs.predicate.kind &&
      e.predicate.op === obs.predicate.op &&
      e.predicate.value === obs.predicate.value &&
      // 上下文不同的两条是**两类情形**，不能合并成一条（右转角 270 ≠ 左转角 270）
      contextKey(e.predicate.context) === contextKey(obs.predicate.context) &&
      (e.scope.cabinet ?? undefined) === (obs.scopeCabinet ?? undefined),
  );
  if (hit) {
    return list.map((e) =>
      e.id === hit.id
        ? {
            ...e,
            evidence: [...e.evidence, obs.evidence],
            confidence: Math.min(0.9, e.confidence + 0.15),
            updatedAt: Date.now(),
          }
        : e,
    );
  }
  const seq = list.length + 1;
  const cand = makeCandidate({
    layer,
    statement: obs.statement,
    predicate: obs.predicate,
    scope: obs.scopeCabinet ? { cabinet: obs.scopeCabinet } : {},
    evidence: obs.evidence,
    confidence: 0.3,
    seq,
  });
  return [...list, cand];
}

export const OBSERVABLE_KINDS: PredicateKind[] = ['drawerCount', 'rowHeight', 'cabinetWidth', 'cabinetDepth', 'unitKind', 'orientation'];
