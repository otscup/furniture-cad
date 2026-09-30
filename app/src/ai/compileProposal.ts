import type { Issue, Project, RuleSet } from '../core/types.ts';
import type { AiAction } from './compile.ts';
import { ADJACENT_DEFAULT_ALIGNMENT, PLACEMENT_SIDES } from '../core/placement.ts';
import { defaultSizes, proposalBlocked, validateProposal, type DesignProposal, type ProposalRow, type ProposalUnit } from './proposal.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  DesignProposal → AiAction[]（确定性编译）
 *
 *  ── 这一层是"AI 只出语义"的兑现处 ──
 *    模型给的是"要什么"（鞋柜 2400 高、下面三层鞋抽、上面开放格放钥匙），
 *    这里决定"怎么建"：房间解析、尺寸补齐、分区意图原样传下去、
 *    组合的成员引用换成 `$ref:`（真正建出来那一刻由 planRunner 换成真 id）。
 *    **这里不产生任何坐标**：落位仍由 `cabinet.create` 里的 `pickFreeSpot` 定。
 *
 *  ── 为什么编译成动作，而不是直接改模型 ──
 *    直接改模型 = 绕开 CommandBus = 绕开规则校验与审计。
 *    编译成 AiAction 之后，它走的仍然是既有那条路：
 *      契约校验 → dryRunPlan（沙盒）→ 预览 → 用户确认 → commitPlan → 真总线
 *    所以"Proposal 是后门"在结构上就不可能：它没有第二条写入口可走。
 *
 *  ── 默认值的态度 ──
 *    没给的尺寸**不猜**，用规则集默认值，并把"系统按默认补了什么"写进 notes
 *    显示在界面上 —— 悄悄补齐等于骗人（用户以为 AI 理解了他的意思）。
 *    反过来，模型自己列的 `questions` 一律**不许跳过**：有就拒绝编译到可执行动作。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface ProposalCompile {
  /** false = 编译不出可执行的动作（有 ERROR，或有待确认问题） */
  ok: boolean;
  actions: AiAction[];
  issues: Issue[];
  /** 系统替它定的东西（默认值补齐 / 落位由系统定）—— 界面必须显示 */
  notes: string[];
  /** AI 声明的假设 + 系统补齐的默认值，合起来给用户看 */
  assumptions: string[];
  /** 阻塞原因（人话）。ok=false 时必有 */
  blockedReason?: string;
}

const mkAction = (
  action: string,
  target: AiAction['target'],
  params: Record<string, unknown>,
  reason: string,
  index: number,
  ref?: string,
): AiAction => ({
  action,
  target,
  // 分区/行是数组，AiAction.params 的类型只声明了标量 —— 与契约里 units 的读法一致（读侧再 as）
  params: params as unknown as Record<string, number | string>,
  reason,
  index,
  ...(ref ? { ref } : {}),
});

/** 房间：既认 id 也认名字（模型手上只有快照里的房间名） */
function roomIdOf(project: Project, v: string | null | undefined): string | undefined {
  if (!v) return undefined;
  const hit = project.rooms.find((r) => r.id === v || r.name === v);
  return hit?.id;
}

export function compileProposal(p: DesignProposal, project: Project, rules: RuleSet): ProposalCompile {
  const issues = validateProposal(p, project);
  const notes: string[] = [];

  if (proposalBlocked(issues)) {
    const blocking = issues.filter((i) => i.severity === 'ERROR' || i.code === 'PROPOSAL-OPEN-QUESTIONS');
    return {
      ok: false,
      actions: [],
      issues,
      notes,
      assumptions: p.assumptions ?? [],
      blockedReason: blocking.map((i) => i.message).join('；') || '这份方案有拦不住的问题',
    };
  }

  const base = defaultSizes(rules);
  const fallbackRoom = roomIdOf(project, p.room) ?? project.rooms[0]?.id;
  if (!fallbackRoom) {
    return {
      ok: false,
      actions: [],
      issues,
      notes,
      assumptions: p.assumptions ?? [],
      blockedReason: '项目里还没有房间 —— 先在「房间」里建一个房间，再来要方案',
    };
  }

  const actions: AiAction[] = [];
  let index = 0;

  for (const c of p.cabinets) {
    const ref = String(c.ref);
    const name = String(c.name ?? ref);
    const roomId = roomIdOf(project, c.room) ?? fallbackRoom;
    if (!roomIdOf(project, c.room) && c.room) notes.push(`「${name}」的房间「${c.room}」没找到，放在「${project.rooms.find((r) => r.id === roomId)?.name ?? roomId}」`);

    const params: Record<string, unknown> = { name };
    for (const dim of ['width', 'height', 'depth'] as const) {
      const v = c[dim];
      if (v === undefined || v === null || !Number.isFinite(Number(v))) {
        params[dim] = base[dim];
        notes.push(`「${name}」没给${{ width: '宽', height: '高', depth: '深' }[dim]}，按规则集默认 ${base[dim]}mm 补齐`);
      } else {
        params[dim] = Math.round(Number(v));
      }
    }
    if (c.rotation !== undefined && c.rotation !== null) params.rotation = Number(c.rotation);

    const rows = c.rows && c.rows.length > 0 ? c.rows : null;
    const units = c.units && c.units.length > 0 ? c.units : null;
    if (rows) {
      params.rows = rows.map((r: ProposalRow) => ({
        ...(r.height === undefined || r.height === null ? {} : { height: r.height }),
        units: (r.units ?? []).map(stripUnit),
      }));
    } else if (units) {
      params.units = units.map(stripUnit);
    } else {
      notes.push(`「${name}」没说内部结构，按默认三分区建（改分区请直接说，或建完在属性面板里调）`);
    }
    if (c.backUnits && c.backUnits.length > 0) params.backUnits = c.backUnits.map(stripUnit);

    actions.push(mkAction('cabinet.create', { roomId }, params, `设计方案：${name}`, index++, ref));
  }

  // ── 落位（v0.3，P8.1）：所有 create 之后统一发 cabinet.place ──
  // 为什么不紧跟在各柜的 create 后面：参照可能是本方案里**靠后**才建的柜，
  // 先建完再落位，`$ref:` 才换得出真 id。
  // 多柜连续落位按"参照依赖"排序（A 参照 B → A 排在 B 之后，被参照的先落位），
  // 顺序稳定（同为就绪时按方案内顺序）—— 同一份方案永远编译出同一批动作。
  // 成环已在 validateProposal 拦下（PROPOSAL-PLACE-CYCLE），这里排序必然可完成。
  const placing = p.cabinets.filter((c) => c.placement);
  if (placing.length > 0) {
    // $ref 判据用**全部**柜体的 ref：参照可以是本方案里不参与落位的柜
    //（"相邻柜贴基准柜"—— 基准柜自己不需要落位意图）。只查 placing 会让
    // $ref 漏生成，执行期按名字找不到本轮刚建的柜 —— 这里抓过一次。
    const allRefs = new Set(p.cabinets.map((c) => String(c.ref)));
    const placePos = new Map(placing.map((c, k) => [String(c.ref), k]));
    const pdeps: number[][] = placing.map((c) => {
      const pl = c.placement!;
      const j = placePos.get(String(pl.reference));
      return j !== undefined && String(pl.reference) !== String(c.ref) ? [j] : [];
    });
    const inDeg = pdeps.map((d) => d.length);
    const dependents: number[][] = placing.map(() => []);
    pdeps.forEach((d, i) => {
      for (const j of d) dependents[j].push(i);
    });
    const ready: number[] = [];
    inDeg.forEach((d, i) => {
      if (d === 0) ready.push(i);
    });
    const order: number[] = [];
    while (ready.length > 0) {
      ready.sort((a, b) => a - b);
      const i = ready.shift()!;
      order.push(i);
      for (const k of dependents[i]) {
        inDeg[k]--;
        if (inDeg[k] === 0) ready.push(k);
      }
    }
    const sideZh: Record<string, string> = { left: '左侧', right: '右侧', front: '前侧', back: '后侧' };
    const alignZh: Record<string, string> = { left: '左缘', right: '右缘', front: '前缘', back: '背缘', center: '中心' };
    for (const k of order) {
      const c = placing[k];
      const pl = c.placement!;
      const ref = String(c.ref);
      const name = String(c.name ?? ref);
      const inProposal = allRefs.has(String(pl.reference));
      const params: Record<string, unknown> = {
        relation: pl.relation,
        reference: inProposal ? `$ref:${pl.reference}` : String(pl.reference),
        ...(pl.side ? { side: pl.side } : {}),
        ...(pl.alignment ? { alignment: pl.alignment } : {}),
      };
      // 缺省对齐必须写进 notes：系统替模型按惯例取了什么，界面要显示（悄悄补齐＝骗人）
      if (pl.relation === 'adjacent' && pl.side && !pl.alignment && PLACEMENT_SIDES.includes(pl.side)) {
        notes.push(`「${name}」没说对齐方式，按惯例取「${ADJACENT_DEFAULT_ALIGNMENT[pl.side]}」（并排背面齐、前后左缘齐）`);
      }
      const reason =
        pl.relation === 'adjacent'
          ? `设计方案：把「${name}」贴到「${pl.reference}」的${sideZh[String(pl.side)] ?? String(pl.side)}`
          : `设计方案：把「${name}」与「${pl.reference}」按${alignZh[String(pl.alignment)] ?? String(pl.alignment)}对齐`;
      // target 用 $ref 占位：真 id 在 planRunner 执行该柜 create 的瞬间才存在
      actions.push(mkAction('cabinet.place', { cabinetId: `$ref:${ref}` }, params, reason, index++));
    }
  }

  // ── 组合：成员用 $ref: 占位，真正建出来那一刻由 planRunner 换成真 id ──
  // （柜体 id 是总线在执行的瞬间生成的，编译这一刻根本不存在 ——
  //   让模型去猜 id，或让它"先建柜再建组"，都是把工程活推回给模型。）
  for (const a of p.assemblies ?? []) {
    const members = (a.members ?? []).map((m) => `$ref:${m}`);
    if (members.length < 2) continue;
    const connections = (a.connections ?? []).map((c) => ({ a: `$ref:${c.a}`, b: `$ref:${c.b}`, kind: c.kind }));
    actions.push(
      mkAction(
        'assembly.create',
        {},
        { name: String(a.name ?? a.ref), memberIds: members, ...(connections.length > 0 ? { connections } : {}) },
        `设计方案：把 ${members.length} 个柜组成一组`,
        index++,
      ),
    );
    if (connections.length === 0) {
      notes.push(`组合「${a.name ?? a.ref}」没声明连接方式 —— 建好后可用对象树里的「按当前落位补全连接」补`);
    }
  }

  return {
    ok: true,
    actions,
    issues,
    notes,
    assumptions: [...(p.assumptions ?? []), ...notes],
  };
}

/** 分区意图原样透传（形状与契约 units 一致）；空字段剥掉，免得把 null 塞进契约 */
function stripUnit(u: ProposalUnit): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: String(u.kind) };
  if (u.nickname) out.nickname = String(u.nickname);
  if (u.width !== undefined && u.width !== null) out.width = Number(u.width);
  if (u.count !== undefined && u.count !== null) out.count = Number(u.count);
  if (u.doorCount !== undefined && u.doorCount !== null) out.doorCount = Number(u.doorCount);
  if (u.rodHeight !== undefined && u.rodHeight !== null) out.rodHeight = Number(u.rodHeight);
  if (u.applianceName) out.applianceName = String(u.applianceName);
  if (u.openingWidth !== undefined && u.openingWidth !== null) out.openingWidth = Number(u.openingWidth);
  if (u.openingHeight !== undefined && u.openingHeight !== null) out.openingHeight = Number(u.openingHeight);
  if (u.openingDepth !== undefined && u.openingDepth !== null) out.openingDepth = Number(u.openingDepth);
  if (u.topDrawers !== undefined && u.topDrawers !== null) out.topDrawers = Number(u.topDrawers);
  return out;
}
