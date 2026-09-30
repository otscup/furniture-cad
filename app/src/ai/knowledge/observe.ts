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

import type { Command, CommandSource, DiffEntry, PlacementAuthority } from '../../core/commandBus.ts';
import type { PlacementIntentDecl } from '../../core/placement.ts';
import {
  ADJACENT_DEFAULT_ALIGNMENT,
  ATTACH_DEFAULT_ALIGNMENT,
} from '../../core/placement.ts';
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

/**
 * authority → 证据来源（P8.5-C1）。
 *
 * 旧代码用 `cmd.source` 直接代理"是不是人的选择"，但 AI 提案经人点「应用」提交时
 * source 仍是 'ai'，导致确认过的提案被当成 ai-inferred、结构性收不到落位证据。
 * 现在 authority 由总线派生：user-authored / user-confirmed → user-observed；
 * system-resolved → system；unknown（未确认 AI / 导入）→ ai-inferred。
 * authority 未传（旧调用路径）时退化到旧行为，保证不回归。
 */
function authorityToOrigin(authority: PlacementAuthority | undefined, source: CommandSource): KnowledgeEvidence['source'] {
  if (authority === 'user-authored' || authority === 'user-confirmed') return 'user-observed';
  if (authority === 'system-resolved') return 'system';
  if (authority === 'unknown') return 'ai-inferred';
  return source === 'ai' ? 'ai-inferred' : 'user-observed';
}

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
 * 从 cabinet.place 的落位意图里提取**对齐方式**观察（P8.5-C1）。
 *
 * 为什么现在能学 alignment：P8.4 时模型只存 x/y/rotation，"按背面齐还是中心齐"
 * 落盘即消失、事后无法反推，硬造 relation 字段 = 拿猜测当证据。P8.5 给命令层
 * 加了 placementIntent（声明通道），确认过的 AI 落位提案把"用了哪个对齐"带进了命令，
 * 于是 alignment 成了**可观察事实**（不再靠从坐标猜）。
 *
 * 门禁（与 orientation 同源纪律）：
 *   · 必须是人的授权（user-authored / user-confirmed）—— AI 草稿未确认不计；
 *   · 必须拿得到上下文（contact / turnSide）—— 说不出情形就不产生知识；
 *   · 永远只产 candidate，不自动 active（弱证据：UI 没有对齐入口，这只算
 *     "用户接受了 AI 给的对齐"，须用户在知识面板确认才生效）。
 */
function alignmentFromIntent(
  intent: PlacementIntentDecl,
  human: boolean,
  placementCtx?: PlacementContext | null,
): Omit<SemanticObservation, 'evidence'> | null {
  if (!human) return null;
  if (!placementCtx || (placementCtx.contact === undefined && placementCtx.turnSide === undefined)) return null;
  let align: string | undefined;
  let relZh = '';
  if (intent.relation === 'adjacent') {
    align = intent.alignment ?? ADJACENT_DEFAULT_ALIGNMENT[intent.side];
    relZh = `贴${intent.side}侧`;
  } else if (intent.relation === 'align') {
    align = intent.alignment;
    relZh = `对齐`;
  } else if (intent.relation === 'attach') {
    align = intent.alignment ?? ATTACH_DEFAULT_ALIGNMENT;
    relZh = `面贴合（${intent.targetFace}↔${intent.referenceFace}）`;
  } else {
    return null; // absolute 是授权输入，不记为对齐偏好
  }
  if (!align) return null;
  return {
    predicate: { kind: 'alignment', op: 'prefer', value: align, context: placementCtx },
    statement: `在${placementContextZh(placementCtx)}里，落位按「${relZh} · ${align}对齐」`,
  };
}

/**
 * 从一条已执行的命令里提取语义观察（可能 0 ~ N 条）。
 * 吃 **LogEntry.diff**（CommandBus 已算好的权威路径 diff）—— 观察器只翻译，
 * 不重新 diff（两份判定必然漂移）。
 *
 * @param authority 由 CommandBus 派生的落位权威（P8.5-C1）。未传时退化到旧的
 *        source 代理行为（向后兼容），不回归。
 */
export function observeCommand(
  cmd: Command,
  diff: DiffEntry[],
  cabinetName?: string,
  placementCtx?: PlacementContext | null,
  authority?: PlacementAuthority,
): SemanticObservation[] {
  // 撤销/重做不是新事实 —— 不观察（否则 undo 一次会把"旧值"当成新偏好）
  if (cmd.source === 'system') return [];

  const human =
    authority === 'user-authored' ||
    authority === 'user-confirmed' ||
    (authority === undefined && isHumanSource(cmd.source));
  const origin = authorityToOrigin(authority, cmd.source);
  const detail = cmd.label || cmd.intent?.nl || `${cmd.op} ${diff.map((c) => c.path).join(', ')}`;

  // `cabinet.place` 在 P8.4 刻意不在列表里（它的坐标是 Resolver 算的，不是人的选择）；
  // P8.5 起：确认过的落位提案会把 placementIntent 带进命令，于是"用了哪个对齐"
  // 成了可观察事实 —— 列入允许集合，但只从 intent 提取对齐证据（见下），不把
  // 解析出的坐标当人的习惯。
  if (
    cmd.op !== 'cabinet.update' &&
    cmd.op !== 'cabinet.create' &&
    cmd.op !== 'cabinet.rotate' &&
    cmd.op !== 'cabinet.place'
  )
    return [];

  const out: SemanticObservation[] = [];

  // ① 路径 diff → 谓词（朝向 / 行高 / 分区类型 / 数量 / 尺寸）
  // 注意：**cabinet.place 不进这条分支**。它的 diff（x/y/rotation）是 Resolver 算出来的，
  // 不是人的选择——若从这里提取"朝向"，等于把系统输出当成人习惯（P8.4 明令禁止）。
  // cabinet.place 只走 ②（从声明过的 placementIntent 提取对齐），绝不从坐标反推。
  if (cmd.op !== 'cabinet.place') {
    for (const ch of diff) {
      const obs = predicateFromChange(ch, human, placementCtx);
      if (!obs) continue;
      out.push({
        ...obs,
        evidence: { at: Date.now(), source: origin, detail, cabinetId: cmd.target?.id },
        // 落位类偏好挂在**情形**上（contact / turnSide），不挂在某个柜子的名字上：
        // 挂名字就等于"这只柜喜欢 270°"—— 既不可复用（换个柜子就不算），
        // 又会在该生效时不生效（scope 不匹配 → 被 scopeMatches 挡掉）。
        // 是哪只柜改的，证据里 `cabinetId` 已经留痕了，不需要再占用 scope。
        scopeCabinet: obs.predicate?.context ? undefined : cabinetName,
      });
    }
  }

  // ② cabinet.place 的落位意图 → 对齐方式证据（P8.5-C1）
  if (cmd.op === 'cabinet.place' && cmd.placementIntent) {
    const alignObs = alignmentFromIntent(cmd.placementIntent, human, placementCtx);
    if (alignObs) {
      out.push({
        ...alignObs,
        evidence: { at: Date.now(), source: origin, detail, cabinetId: cmd.target?.id },
        scopeCabinet: undefined,
      });
    }
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
