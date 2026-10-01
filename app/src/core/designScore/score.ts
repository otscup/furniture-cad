/**
 * ══════════════════════════════════════════════════════════════════════
 *  确定性设计评分（P9.4）—— 只消费已有事实与规则，不新增判定
 *
 *  ── 这条链就是本层的全部 ──
 *      CandidateLayout
 *        + Deterministic Facts      （deriveSpatialFacts / deriveContacts / validateDesign）
 *        + Design Rules             （designIntent 词表的 goal spec）
 *        + Applicable Preferences   （resolveKnowledge 的 applicable）
 *        ↓
 *      DesignScore
 *
 *  ── 四条纪律（违反任一条，这一层就退化成"第二套规则"）──
 *    ① **不重判**（§二）：穿墙 / 挡门 / 靠墙 / 房间关系 / 柜间关系 / 门扇开启
 *       一律**读**既有结论 —— 门槛读 `detectCollisions` 与 `validateDesign` 的
 *       `status`，事实读 `deriveSpatialFacts` / `deriveContacts`。
 *       本文件**没有一处** bbox 相交、多边形重叠、距离、墙/门检测的实现（§八）。
 *    ② **不新增容差、不写三角函数**（§八）：一个 `Math.sin/cos/hypot/atan2`
 *       都不出现，也没有任何 mm 阈值字面量 —— "多近算贴上"只有 SPATIAL_TOL 一处。
 *    ③ **不写模型、不产生 Command、不落盘**：纯函数；入参 `project` 一个字节不动
 *       （验收断言评分前后 `serializeProjectFile` 逐字节相同）。
 *    ④ **无 adopt**：导出面里没有 winner / best / recommended / adopt / apply。
 *       本层只回答"这份候选如果这样摆会得到什么"，让候选生效是**未来**的事。
 *
 *  ── 候选生命周期（§十一）──
 *      `draft`（P9.3）→ `evaluated`（本层 `evaluateCandidateLayout`）→ adopted（**未来**）。
 *      本层只推进到 `evaluated`，且**它仍然是运行态**：
 *      不进 `project.json`、不进 Semantic Model、不进 Knowledge（类型层也写不出 `'adopted'`）。
 *
 *  ── 与 AI 的关系（§十二）──
 *      评分**不下发给模型做决策**：AI 契约里没有评分入口、没有动作、更没有坐标。
 *      `ai/candidateScoreContext.ts` 给模型的只是一份**只读、无坐标**的投影
 *      （"看到了评分"，不等于"可以据此选择或落地"）。
 *
 *  ── 硬约束闸门（§四）──
 *      先过 Gate → valid / infeasible；**valid 才进入软评分**。
 *      infeasible ⇒ `total:null` + `components:[]`。
 *      "ERROR = -100 然后继续假装它是有效候选"是本层明确要防的写法。
 *
 *  ── 为什么不去读 `CandidatePlacement.satisfies` ──
 *      它只覆盖 P9.3 能构造的两个目标（wall-contact / standalone），
 *      其余词一律是 `false`（含义是"**没被问过**"，不是"不满足"）。
 *      拿它当评分依据会把"没问过"误读成"不满足"——所以这里按意图词表
 *      **逐条读它声明的那个 fact 维度**，与 spec 的 `satisfiedValues` 对账。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Cabinet, Project } from '../types.ts';
import { activeDesignIntents } from '../designIntent/model.ts';
import { designIntentGoalSpec, designIntentGoalZh, type DesignIntentGoal } from '../designIntent/vocabulary.ts';
import { validateDesign, type DesignValidationReport } from '../designValidation/index.ts';
import { deriveSpatialFacts, type SpatialFacts } from '../spatial/index.ts';
import { deriveContacts, type Contact } from '../relations.ts';
import { cornerTurnSide } from '../placementDesign.ts';
import {
  contextCovers,
  type KnowledgeEntry,
  type PlacementContext,
} from '../../ai/knowledge/model.ts';
import { preferredOrientation, resolveKnowledge } from '../../ai/knowledge/resolver.ts';
import type { CandidateLayout, CandidateLayoutSet } from '../candidateLayout/model.ts';
import {
  SCORE_WEIGHT_POLICY,
  designScoreCounts,
  designScoreHitZh,
  type DesignScore,
  type DesignScoreComponent,
  type DesignScoreHardFailure,
  type DesignScoreHit,
  type DesignScorePreferenceMatch,
  type EvaluatedCandidate,
} from './model.ts';

/** 归一到 [0,360) 的整数角 —— 只用于**比较**朝向是否相同，不做任何几何计算 */
const normDeg = (d: number): number => ((Math.round(d) % 360) + 360) % 360;

/** 把候选的每一条落位套到项目**副本**上（纯函数：入参不动）。坐标来自 Resolver，本层不重算 */
function cloneWithLayout(project: Project, layout: CandidateLayout): Project {
  const byId = new Map(layout.placements.map((p) => [p.targetId, p.resolved] as const));
  return {
    ...project,
    cabinets: project.cabinets.map((c) => {
      const p = byId.get(c.id);
      return p ? { ...c, placement: { x: p.x, y: p.y, rotation: p.rotation } } : c;
    }),
  };
}

// ─────────────────────────── ① Hard Constraint Gate ───────────────────────────

/**
 * 硬约束闸门 —— **只读既有结论**，不自己判"这条算不算硬错"。
 *
 * 两个来源（都与界面/主链同源）：
 *   ① 候选自带的 `issues`（P9.3 由 `detectCollisions` 产出，与 CommandBus 同一份）；
 *   ② 把候选摆到副本上跑 `validateDesign`（取其中的 ERROR 级结论，等级真相源仍是 issueCatalog），
 *      只取**挂在候选目标柜上**的 —— 房间/墙自身的结构问题（如墙退化）不是这个候选造成的。
 *
 * 只有 `severity/status === ERROR` 才进闸门；WARNING 是设计建议，不是阻断。
 */
function gateFailures(project: Project, layout: CandidateLayout): DesignScoreHardFailure[] {
  const targets = new Set(layout.placements.map((p) => p.targetId));
  const seen = new Set<string>();
  const out: DesignScoreHardFailure[] = [];
  const push = (f: DesignScoreHardFailure): void => {
    const k = `${f.code}|${f.target}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(f);
  };

  for (const p of layout.placements) {
    for (const i of p.issues) {
      if (i.severity !== 'ERROR') continue;
      push({ code: i.code, severity: 'ERROR', target: i.target, message: i.message, source: 'candidate-issues' });
    }
  }

  const report = validateDesign(cloneWithLayout(project, layout));
  for (const f of report.findings) {
    if (f.status !== 'error' || !f.cabId || !targets.has(f.cabId)) continue;
    push({ code: f.code, severity: 'ERROR', target: f.cabId, message: f.message, source: 'design-validation' });
  }
  return out;
}

// ─────────────────────────── ② 条件命中（设计规则 × 既有事实） ───────────────────────────

interface FactCtx {
  project: Project;
  facts: SpatialFacts;
  contacts: Contact[];
  report: DesignValidationReport;
}

interface FactRead {
  hit: DesignScoreHit;
  detail: string;
}

/**
 * 读一条设计意图对应的**既有事实**，与词表 spec 的 `satisfiedValues` 对账。
 *
 * 纪律：这里每一个分支都只**读一个算好的枚举值**，再和 spec 声明的期望值比一比 ——
 * 比对不是判定，是"对账"。`unknown`（判不出来）**既不等于满足，也不等于不满足**。
 */
function readGoalFact(goal: DesignIntentGoal, cabId: string, ctx: FactCtx): FactRead {
  const spec = designIntentGoalSpec(goal);
  switch (goal) {
    case 'wall-contact': {
      // 读 P8.8 解释层的墙接触语义分类（背面/侧面/门脸/离缝/穿墙/没靠墙）
      const kinds = ctx.report.wallContacts.filter((c) => c.cabId === cabId).map((c) => c.kind);
      const hit: DesignScoreHit = kinds.some((k) => spec.satisfiedValues.includes(k)) ? 'yes' : 'no';
      return { hit, detail: `墙接触 = [${kinds.join(', ') || '（无）'}]，规则要求 ∈ [${spec.satisfiedValues.join(', ')}]` };
    }
    case 'opening-clear': {
      const rels = ctx.facts.cabinets.find((c) => c.cabId === cabId)?.openings.map((o) => o.relation) ?? [];
      const hit: DesignScoreHit = rels.some((r) => r === 'overlap')
        ? 'no'
        : rels.some((r) => r === 'unknown')
          ? 'unknown'
          : 'yes';
      return { hit, detail: `洞口关系 = [${rels.join(', ') || '（无洞口）'}]，规则要求 ∈ [${spec.satisfiedValues.join(', ')}]` };
    }
    case 'door-swing-clear': {
      /**
       * ⚠ 这里有一处必须小心的地方：**判不出开启方向的门根本不产生净空行**。
       *   若只看 `clearances`，一个"门缺 swingDirection、柜正堵在门口"的场景会得到
       *   空数组 → 被读成"让开了" —— 那是把 **unknown 当成 clear**（§十四 / §十六）。
       *   所以还要看本柜所在房间里有没有**判不出开启区域**的门（`doors[].status==='unknown'`）。
       */
      const cab = ctx.project.cabinets.find((c) => c.id === cabId);
      const unknownDoors = ctx.report.doorSwing.doors.filter(
        (d) => d.roomId === cab?.roomId && d.status === 'unknown'
      ).length;
      const st = ctx.report.doorSwing.clearances.filter((c) => c.cabinetId === cabId).map((c) => c.status);
      const hit: DesignScoreHit = st.some((s) => s === 'overlap' || s === 'touch')
        ? 'no'
        : st.some((s) => s === 'unknown') || unknownDoors > 0
          ? 'unknown'
          : 'yes';
      return {
        hit,
        detail:
          `门扇净空 = [${st.join(', ') || '（无判定）'}]，规则要求 ∈ [${spec.satisfiedValues.join(', ')}]` +
          (unknownDoors > 0 ? `；另有 ${unknownDoors} 扇门判不出开启区域（unknown ≠ 让开）` : ''),
      };
    }
    case 'room-inside': {
      const rel = ctx.facts.cabinets.find((c) => c.cabId === cabId)?.room ?? 'unknown';
      const hit: DesignScoreHit = rel === 'inside' ? 'yes' : rel === 'unknown' ? 'unknown' : 'no';
      return { hit, detail: `房间关系 = ${rel}，规则要求 ∈ [${spec.satisfiedValues.join(', ')}]` };
    }
    case 'near-opening': {
      // "靠近洞口"的前提是**房间边界闭合**（否则影响带画在哪一侧都判不出）—— 判不出就说判不出
      const cab = ctx.project.cabinets.find((c) => c.id === cabId);
      const closed = cab ? ctx.facts.rooms.find((r) => r.roomId === cab.roomId)?.closed === true : false;
      if (!closed) return { hit: 'unknown', detail: '房间边界不闭合 —— 离洞口远近判不出来' };
      const codes = ctx.report.findings.filter((f) => f.cabId === cabId).map((f) => f.code);
      const hit: DesignScoreHit = codes.some((c) => spec.satisfiedValues.includes(c)) ? 'yes' : 'no';
      return { hit, detail: `洞口邻近结论 = [${codes.filter((c) => spec.satisfiedValues.includes(c)).join(', ') || '（无）'}]` };
    }
    case 'standalone': {
      const has = ctx.contacts.some((c) => c.a === cabId || c.b === cabId);
      return { hit: has ? 'no' : 'yes', detail: has ? '有柜间接触记录' : '无任何柜间接触记录' };
    }
    default:
      // 取舍方向类（fact === null）在调用方就已分流；这里兜住"将来新增了词但忘了接线"
      return { hit: 'unknown', detail: '本层没有这个目标的读取口径' };
  }
}

/** 规则引用串（"依据哪条 rule"的可读名 —— 指向词表，不在别处重述期望值） */
const goalRuleRef = (goal: DesignIntentGoal): string => {
  const spec = designIntentGoalSpec(goal);
  return `designIntentGoalSpec('${goal}') · class=${spec.class} · satisfiedValues=[${spec.satisfiedValues.join(', ')}]`;
};

/**
 * 逐条 active 意图生成 component。
 *
 * 作用对象 = **意图自己 scope 指向的那只柜**（条件类目标全部是柜级）。
 * 候选没改动的柜也会被评估 —— 它给出的正是"当前状态"，两份候选之间因此可以逐条对比。
 * `class:'priority'`（`fact === null`，取舍方向）**判不出来** → 记 `unavailable`，不计入 total。
 */
function conditionComponents(project: Project, ctx: FactCtx): DesignScoreComponent[] {
  const out: DesignScoreComponent[] = [];
  for (const intent of activeDesignIntents(project)) {
    const spec = designIntentGoalSpec(intent.goal);
    if (spec.fact === null) {
      out.push({
        id: `unavail:${intent.id}`,
        kind: 'unavailable',
        label: `${designIntentGoalZh(intent.goal)}（取舍方向）`,
        // 来源是规则自身：goal spec 明说这一类没有判定依据（fact === null）
        source: 'rule',
        rule: goalRuleRef(intent.goal),
        intentId: intent.id,
        goal: intent.goal,
        isPreference: false,
        weight: null,
        weightSource: 'unassigned',
        hit: 'unknown',
        why: `词表把「${designIntentGoalZh(intent.goal)}」定为取舍方向（fact === null）—— 没有可对账的事实维度，**判不出来**，不进评分（不补启发式）`,
      });
      continue;
    }
    if (intent.scope.kind !== 'cabinet') {
      out.push({
        id: `unavail:${intent.id}`,
        kind: 'unavailable',
        label: `${designIntentGoalZh(intent.goal)}（房间级）`,
        source: 'rule',
        rule: goalRuleRef(intent.goal),
        intentId: intent.id,
        goal: intent.goal,
        isPreference: false,
        weight: null,
        weightSource: 'unassigned',
        hit: 'unknown',
        why: '这条意图的作用对象是房间，而条件类事实是**逐柜**读的 —— 房间级结论判不出来，不进评分',
      });
      continue;
    }
    const cabId = intent.scope.cabinetId;
    const cab = project.cabinets.find((c) => c.id === cabId);
    const read = readGoalFact(intent.goal, cabId, ctx);
    out.push({
      id: `cond:${intent.id}`,
      kind: 'condition',
      label: `${designIntentGoalZh(intent.goal)}（${cab?.name ?? cabId}）`,
      source: 'fact',
      fact: spec.fact,
      rule: goalRuleRef(intent.goal),
      intentId: intent.id,
      goal: intent.goal,
      isPreference: false,
      weight: null,
      weightSource: 'unassigned',
      hit: read.hit,
      why: read.detail,
    });
  }
  return out;
}

// ─────────────────────────── ③ 偏好命中（§六：复用 Resolver） ───────────────────────────

/**
 * 当前落位在"哪种情形"里（朝向偏好**必须带上下文**，见 P8.4 的 PlacementContext）。
 *
 * 全部来自既有派生：接触形态来自 `deriveContacts` 的 `kind`，
 * 转角方向来自 P8.3 的 `cornerTurnSide`（唯一实现），且**以对方柜为视角**
 * （"转自己时它不变"，与 P8.4 的口径一致）。本文件不重复实现任何接触/转角判定。
 */
function placementContextOf(cabId: string, clone: Project, contacts: Contact[]): PlacementContext {
  const ct = contacts.find((c) => c.a === cabId || c.b === cabId);
  if (!ct) return {};
  if (ct.kind === 'butt') return { contact: 'butt' };
  const self = clone.cabinets.find((c) => c.id === cabId);
  const otherId = ct.a === cabId ? ct.b : ct.a;
  const other = clone.cabinets.find((c) => c.id === otherId);
  if (!self || !other) return { contact: 'corner' };
  return { contact: 'corner', turnSide: cornerTurnSide(other as Cabinet, self as Cabinet) };
}

/**
 * 偏好命中 —— **严格复用 Knowledge Resolver**。
 *
 * 三条"不能"（§六）在代码里的落点：
 *   · 只读 `resolveKnowledge()` 的 `applicable` ⇒ candidate 偏好天然进不来，
 *     被硬规则压制的偏好天生在 `suppressed` 里（不覆盖硬规则）；
 *   · 本文件**不 import** `knowledge/store` ⇒ 不可能产生偏好、不可能升级 candidate；
 *   · 偏好只产生 `preferenceMatches`（加权建议），**永不**进 `hardFailures`。
 */
function preferenceComponents(
  project: Project,
  layout: CandidateLayout,
  clone: Project,
  ctx: FactCtx,
  entries: KnowledgeEntry[]
): { components: DesignScoreComponent[]; matches: DesignScorePreferenceMatch[]; skipped: number } {
  const components: DesignScoreComponent[] = [];
  const matches: DesignScorePreferenceMatch[] = [];
  let skipped = 0;

  for (const p of layout.placements) {
    const cab = clone.cabinets.find((c) => c.id === p.targetId);
    if (!cab) continue;
    const room = project.rooms.find((r) => r.id === cab.roomId);
    const pc = placementContextOf(cab.id, clone, ctx.contacts);

    const res = resolveKnowledge({ cabinetName: cab.name, roomName: room?.name }, entries);
    const prefs = res.applicable.filter(
      (r) => r.entry.layer === 'userPreference' && r.entry.predicate?.kind === 'orientation' && r.entry.predicate.op === 'prefer'
    );
    if (prefs.length === 0) continue;

    const covering = prefs.filter((r) => contextCovers(r.entry.predicate!.context, pc));
    if (covering.length === 0) {
      skipped += prefs.length;
      continue;
    }
    // 用 Resolver 的**唯一读取口**取值（不在本层再解释一遍谓词语义）
    const preferred = preferredOrientation(res, pc);
    const distinct = new Set(covering.map((r) => normDeg(Number(r.entry.predicate!.value))));
    const cur = normDeg(p.resolved.rotation);

    for (const r of covering) {
      const pred = r.entry.predicate!;
      let matched: DesignScoreHit;
      let why: string;
      if (preferred === null || distinct.size > 1) {
        matched = 'unknown';
        why = `本情形下有 ${covering.length} 条适用偏好（建议值 ${[...distinct].join('° / ')}°）彼此不同 —— 评分不替你裁决`;
      } else {
        matched = cur === normDeg(preferred) ? 'yes' : 'no';
        why = `候选朝向 ${cur}°，偏好建议 ${normDeg(preferred)}°（情形：${r.why}）`;
      }
      const id = `pref:${cab.id}:${r.entry.id}`;
      components.push({
        id,
        kind: 'preference',
        label: `偏好「${r.entry.statement}」（${cab.name}）`,
        source: 'preference',
        fact: 'placement.rotation',
        rule: `userPreference:${r.entry.id}`,
        preferenceId: r.entry.id,
        isPreference: true,
        weight: null,
        weightSource: 'unassigned',
        hit: matched,
        why,
      });
      matches.push({
        preferenceId: r.entry.id,
        statement: r.entry.statement,
        kind: pred.kind,
        op: pred.op,
        value: pred.value,
        cabinetId: cab.id,
        matched,
        why,
      });
    }
  }
  return { components, matches, skipped };
}

// ─────────────────────────── 对外：评分 ───────────────────────────

/**
 * 给一份候选布局打分（**纯函数**：同输入同输出，不改 project、不写盘、无随机无时钟）。
 *
 * @param project 当前项目（只读；评分前后逐字节不变）
 * @param layout  一份候选布局（P9.3 产出，或手工构造的同一形状）
 * @param entries 用户知识条目（**可选**；不传 = 没有可用偏好）。
 *                传进来的条目**不会被修改**，也不会被写回任何 store。
 */
export function scoreCandidateLayout(project: Project, layout: CandidateLayout, entries: KnowledgeEntry[] = []): DesignScore {
  // ① Hard Constraint Gate —— 先于一切软评分
  const hardFailures = gateFailures(project, layout);
  if (hardFailures.length > 0) {
    return {
      status: 'infeasible',
      total: null,
      totalKind: 'none',
      weights: SCORE_WEIGHT_POLICY,
      components: [],
      hardFailures,
      preferenceMatches: [],
      explanations: [
        `硬约束闸门：未通过 —— ${hardFailures.length} 处阻断错误 ⇒ infeasible，**不进入软评分**（不用"扣很多分"假装它还是有效候选）`,
        ...hardFailures.map((f) => `[${f.code}] ${f.message}`),
        SCORE_WEIGHT_POLICY.note,
      ],
    };
  }

  // ② 软评分：全部来自已有事实 / 规则 / 已确认偏好
  const clone = cloneWithLayout(project, layout);
  const ctx: FactCtx = {
    project,
    facts: deriveSpatialFacts(clone),
    contacts: deriveContacts(clone),
    report: validateDesign(clone),
  };

  const conditions = conditionComponents(project, ctx);
  const pref = preferenceComponents(project, layout, clone, ctx, entries);
  const components = [...conditions, ...pref.components];

  const total = components.filter((c) => designScoreCounts(c.hit)).length;
  const explanations = [
    '硬约束闸门：通过（0 处阻断错误）—— 进入软评分',
    ...components.map((c) => `${c.label}：${designScoreHitZh(c.hit)} —— ${c.why}`),
    `总分口径：命中 ${total} / ${components.filter((c) => c.kind !== 'unavailable').length} 条可判定项（**无权重**）`,
  ];
  if (pref.skipped > 0) {
    explanations.push(`有 ${pref.skipped} 条偏好因**情形不匹配**未参与（例如偏好限定"角接"，而本候选的落位情形不是角接）`);
  }
  explanations.push(SCORE_WEIGHT_POLICY.note);

  return {
    status: 'valid',
    total,
    totalKind: 'hit-count',
    weights: SCORE_WEIGHT_POLICY,
    components,
    hardFailures: [],
    preferenceMatches: pref.matches,
    explanations,
  };
}

/** 评一份候选 → 推进它的生命周期（`draft → evaluated`）。**运行态**，不落盘、不进模型 */
export function evaluateCandidateLayout(
  project: Project,
  layout: CandidateLayout,
  entries: KnowledgeEntry[] = []
): EvaluatedCandidate {
  return {
    candidateId: layout.id,
    fromStatus: layout.status, // 恒 'draft'（P9.3 的产出物状态）
    lifecycle: 'evaluated',
    score: scoreCandidateLayout(project, layout, entries),
  };
}

/** 一次给整批候选评分（顺序与 `set.candidates` 一致；纯函数）—— 每份都推进到 `evaluated` */
export function scoreCandidateLayoutSet(
  project: Project,
  set: CandidateLayoutSet,
  entries: KnowledgeEntry[] = []
): EvaluatedCandidate[] {
  return set.candidates.map((c) => evaluateCandidateLayout(project, c, entries));
}

// ─────────────────────────── ④ 确定性比较（§十：**不选 winner**） ───────────────────────────

const HIT_RANK: Record<DesignScoreHit, number> = { yes: 2, unknown: 1, no: 0 };

/**
 * 确定性比较两份评分 —— **只回答"好 / 差 / 平"**。
 *
 * ⚠ 本函数**不选 winner**：它不返回"哪份更好"，只返回一个三值序关系；
 *   调用方不许据此宣布"最佳方案"，更不许自动 adopt（那是 P9.5 之后的事，
 *   且必须由用户拍板）。比较是可复现的：同两份评分永远得到同一个结果，
 *   平手时按 component 向量做字典序 tiebreak —— 不掷骰子、不看时间。
 */
export function compareDesignScores(a: DesignScore, b: DesignScore): -1 | 0 | 1 {
  const gate = (s: DesignScore): number => (s.status === 'valid' ? 1 : 0);
  if (gate(a) !== gate(b)) return gate(a) > gate(b) ? 1 : -1;
  const ta = a.total ?? -1;
  const tb = b.total ?? -1;
  if (ta !== tb) return ta > tb ? 1 : -1;
  const key = (s: DesignScore): string =>
    s.components
      .map((c) => `${c.id}=${HIT_RANK[c.hit]}`)
      .sort()
      .join('|');
  const ka = key(a);
  const kb = key(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** 人话摘要（界面/报告共用一处；**不返回"推荐哪个"**） */
export function designScoreSummaryZh(score: DesignScore): string {
  if (score.status === 'infeasible') return `不可行：${score.hardFailures.length} 处阻断错误（不评分）`;
  return `可用：命中 ${score.total ?? 0} 项（无权重；权重系统留待后续）`;
}
