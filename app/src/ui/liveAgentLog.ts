/**
 * ══════════════════════════════════════════════════════════════════════
 *  批次A · A2/A3 的**纯逻辑**（无 JSX、无 React、无 DOM）
 *
 *  为什么单独拆一个文件：
 *   A2（实时草稿在主画布可见）与 A3（事件流面板）的行为判据 —— 事件怎么从
 *   SSE 载荷里抽出来、列表怎么截断去重、草稿在哪种视图下以什么形态呈现 ——
 *   全是纯函数。把它们留在 .tsx 里就只能靠"读代码"验收，而本项目的硬规矩是
 *   断言必须能真的变红。拆出来后可以像其它 verify 脚本一样直接 import 断言，
 *   临时改坏这里的判据 → 对应断言立刻红。
 *
 *  纪律：本模块**只读不写**。它不认识 CommandBus，也不碰任何模型，
 *  草稿预览与正式模型的分流仍然由各自的既有写入口负责。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 事件流最多保留多少条（倒序）。内存有上界，长会话不会无限膨胀。 */
export const AGENT_EVENT_LIMIT = 50;
/** 去重键集合的上界倍数：超过就整体清空，避免键集合比日志本身还大。 */
const AGENT_EVENT_KEY_BUDGET = AGENT_EVENT_LIMIT * 4;

export type AgentEventKind = 'init' | 'draft' | 'tool' | 'workspace' | 'draft-deleted';

/** A3：实时事件流的单条记录。纯观测数据，不进任何写入口。 */
export interface AgentStreamEvent {
  /** 稳定 id（= 去重键），用作 React key。 */
  id: string;
  /** 本地收到该事件的时间戳（毫秒）。 */
  at: number;
  kind: AgentEventKind;
  /** 给人看的一行摘要。 */
  text: string;
  draftId?: string;
  /** tool 事件才有：MCP 工具名。 */
  tool?: string;
  /** tool 事件才有：这一步成没成。 */
  toolOk?: boolean;
  /** agent.step 的轮次（服务端 agentLoop 的 round）。 */
  round?: number;
}

/** 从 pushAgentEvent 传来的原始事件（id/at 由归约器补上）。 */
export type AgentStreamEventInput = Omit<AgentStreamEvent, 'id' | 'at'> & { key: string };

/**
 * A3 归约器：把一条新事件并入列表。
 *
 * 三条硬性语义：
 *  1. **最新在前**（倒序），UI 不需要再排一次；
 *  2. **同键只记一次** —— EventSource 断线重连会重推 init 与同一步骤：
 *     不去重的话，面板里会出现一串"同一句话"的重复行，用户会以为 Agent 重复执行了；
 *  3. **最多 AGENT_EVENT_LIMIT 条**，超出直接截尾（不是"以后再清"，是当下就有界）。
 *
 * 返回新对象而不是就地改，交给 React 做浅比较。
 */
export function appendAgentEvent(
  previous: readonly AgentStreamEvent[],
  input: AgentStreamEventInput,
  seenKeys: Set<string>,
  now: number,
): { events: AgentStreamEvent[]; appended: boolean } {
  if (seenKeys.has(input.key)) return { events: previous as AgentStreamEvent[], appended: false };
  /**
   * 键集合触顶时不能简单 clear()：
   *  · 清空会把**刚加进去的这一条**也忘掉，于是同一步的下一次重推又能进来；
   *  · 更糟的是列表里已经展示的那 50 条，键全丢了，重连重推就会出现重复行。
   * 所以用"保留当前可见的 50 条 + 本条"重新播种：内存照样有上界，
   * 而**看得见的行绝不会重复**。
   */
  if (seenKeys.size >= AGENT_EVENT_KEY_BUDGET) {
    seenKeys.clear();
    for (const event of previous) seenKeys.add(event.id);
  }
  seenKeys.add(input.key);
  const { key, ...rest } = input;
  const next: AgentStreamEvent[] = [{ id: key, at: now, ...rest }, ...previous].slice(0, AGENT_EVENT_LIMIT);
  return { events: next, appended: true };
}

/** SSE 载荷里我们关心且**确实存在**的字段（服务端 server.mjs 的形状）。 */
export interface AgentSsePayload {
  type?: string;
  draftId?: string;
  revision?: number;
  project?: { cabinets?: unknown[] } | null;
  draftProject?: { cabinets?: unknown[] } | null;
  liveModelVersion?: number;
  latestDraft?: {
    draftId?: string;
    revision?: number;
    baseModelVersion?: number;
    project?: { cabinets?: unknown[] } | null;
  };
  step?: { tool?: string; ok?: boolean; round?: number };
  validation?: { blockingErrors?: number };
  freshness?: { liveModelVersion?: number; baseModelVersion?: number };
}

function cabinetCountOf(project: { cabinets?: unknown[] } | null | undefined): number {
  return Array.isArray(project?.cabinets) ? project.cabinets!.length : 0;
}

/**
 * A3 核心：把一条 SSE 载荷翻译成 0~1 条事件。
 *
 * 刻意只翻译"能证明发生过什么"的字段：
 *  · init 只说连上了、草稿里已经有几台；
 *  · draft.updated / agent.step 说这一步调的是什么工具、成没成、草图现在几台；
 *  · draft.deleted 说草稿没了。
 * 拿不到项目内容的事件（服务端降级推送只有 draftId）**不编造**，直接返回 null。
 */
export function agentEventFromSsePayload(payload: AgentSsePayload): AgentStreamEventInput | null {
  if (payload.type === 'init' && payload.latestDraft?.project) {
    const draftId = payload.latestDraft.draftId ?? '';
    return {
      key: `init|${draftId}|${payload.latestDraft.revision ?? 0}`,
      kind: 'init',
      draftId,
      text: `连上实时流：草稿 ${draftId} 已有 ${cabinetCountOf(payload.latestDraft.project)} 台柜体`,
    };
  }
  if (payload.type === 'draft.updated' || payload.type === 'agent.step') {
    const project = payload.project ?? payload.draftProject;
    if (!project) return null;
    const draftId = payload.draftId ?? '';
    const tool = typeof payload.step?.tool === 'string' && payload.step.tool ? payload.step.tool : null;
    const ok = payload.step?.ok === true;
    const round = typeof payload.step?.round === 'number' ? payload.step.round : 0;
    const revision = typeof payload.revision === 'number' ? payload.revision : 0;
    const cabinets = cabinetCountOf(project);
    return {
      key: `${payload.type}|${draftId}|${revision}|${tool ?? '-'}|${round}|${cabinets}`,
      kind: tool ? 'tool' : 'draft',
      draftId,
      tool: tool ?? undefined,
      toolOk: tool ? ok : undefined,
      round: typeof payload.step?.round === 'number' ? payload.step.round : undefined,
      text: tool
        ? `${tool}${ok ? ' ✓' : ' ✗'}（草稿共 ${cabinets} 台柜体）`
        : `草稿更新至 ${cabinets} 台柜体`,
    };
  }
  if (payload.type === 'draft.deleted') {
    const draftId = payload.draftId ?? '';
    return {
      // 草稿删了还可以用同一个 id 重新建，所以键里带时间戳，不能只认 id。
      key: `deleted|${draftId}|${payload.liveModelVersion ?? 0}|${payload.revision ?? 0}`,
      kind: 'draft-deleted',
      draftId,
      text: `草稿 ${draftId} 已删除`,
    };
  }
  return null;
}

/** 主画布的三种视图（与 RoomWorkspace 的 centerViewMode 一一对应）。 */
export type CenterViewMode = 'sheet' | '3d' | 'plan';

/**
 * A2：实时草稿在**当前视图**下怎么呈现。
 *
 * 这就是这次要修的缺陷本身：草稿预览原先只能出现在"整墙四视图"下方的长内容里，
 * 用户切到 3D 或平面视图（正在画的那个房间的主视图）就完全看不到 Agent 在干什么。
 *
 * 约定：
 *  · 三种视图都返回 pinned=true —— 草稿条**永远钉在主画布顶部**，不受视图切换影响；
 *  · 只有 sheet 视图额外展开整张四视图（inlineSheet），避免在 3D/平面视图里
 *    塞一张和当前画布无关的大图；
 *  · 草稿是旁路：bandLabel 明确写"实时草稿·尚未入库"，用户不会把它当成正式图。
 */
export function liveDraftStageMode(mode: CenterViewMode): {
  pinned: boolean;
  inlineSheet: boolean;
  bandLabel: string;
  hint: string;
} {
  return {
    pinned: true,
    inlineSheet: mode === 'sheet',
    bandLabel: 'MCP / Agent 实时草稿 · 尚未入库',
    hint: mode === '3d'
      ? '当前在 3D 视图；草稿是旁路预览，不会改动你的正式模型'
      : mode === 'plan'
        ? '当前在平面视图；草稿是旁路预览，不会改动你的正式模型'
        : '当前在四视图；草稿与正式图纸同源，采纳前不会改动你的正式模型',
  };
}
