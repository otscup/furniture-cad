import { proposalShapeError, validatePlan } from '../../shared/aiContract.mjs';
import type { AiAction } from './compile.ts';
import type { QuotaView } from './quotaTypes.ts';
import { snapshotContext, type AiSnapshot } from './snapshot.ts';
import type { DesignProposal } from './proposal.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  AI 规划通道的客户端
 *
 *  ── 走的是标准 OpenAI 调用形态 ──
 *    服务端把请求转成 `POST {baseUrl}/chat/completions`（带
 *    `response_format: {type:'json_object'}`），任何提供兼容端点的服务商
 *    都能直接接上：OpenAI / DeepSeek / Kimi / 智谱 / 通义 / 硅基 / OpenRouter /
 *    Ollama / 自定义。加一家新服务商 = 在管理后台填一个 baseUrl，不需要改代码。
 *
 *  ── 为什么前端也要再校验一遍 ──
 *    服务端已经校验过了。这里再做一次不是不信任服务端，而是**不信任这条链路上
 *    的任何一环**：验收里会用 mock 服务商返回畸形 JSON 来验证"坏输出进不来"；
 *    将来换成 MCP 通道或别人接的服务端，也不该因为"他们校验过了"就少了这道门。
 *    校验器只有一份（shared/aiContract.mjs），多调用一次不产生第二套规则。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface PlanRejection {
  index: number;
  code: string;
  error: string;
}

export interface PlanResponse {
  ok: boolean;
  error?: string;
  /** AI 给用户看的人话（它不是动作，只是说明） */
  reply: string;
  /** 通过契约校验的动作，**已按位置编号 1 起** */
  actions: AiAction[];
  /** 被契约拒掉的动作 —— 必须显示出来，不能悄悄丢 */
  rejected: PlanRejection[];
  /** 模型返回了但解析不出 JSON 时的原文，供人直接看模型说了什么 */
  raw?: string;
  /**
   * 模型的**思考过程**（推理模型才有）。规划失败时它往往是唯一的线索：
   * 正文是空的、原因写在思考里，界面不显示它的话用户只能看到一个空白。
   */
  reasoning?: string;
  /** 模型的结束原因。`length` = 输出预算用完了 —— 正文为空时这是最要紧的那个信息 */
  finishReason?: string;
  /**
   * 这份计划是**从模型的思考过程里救出来的**（正文为空时的兜底）。
   * 它是"模型边想边写下的草稿"，可信度低于正式正文 —— 界面必须提示用户重点复核，
   * 不能和普通结果一个待遇（界面与审计必须说同一件事）。
   */
  salvagedFromReasoning?: boolean;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; reasoning_tokens?: number } | null;
  ms?: number;
  /**
   * 服务端顺手带回的额度余量（local-open 模式下为空）。
   * 带上它的理由：界面上的"今日还能生成几次"必须跟着真实消耗走，
   * 每次调用完再单独拉一次账号信息是多余的一次往返 —— 而多余的一次往返
   * 迟早会有人忘记发，界面就停在旧数字上。
   */
  quota?: QuotaView;
}

/** 带上登录 token（local-open 模式下没有 token，也就不带） */
function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function requestPlan(opts: {
  text: string;
  snapshot: AiSnapshot;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  model?: string;
  token?: string | null;
}): Promise<PlanResponse> {
  const empty: PlanResponse = { ok: false, reply: '', actions: [], rejected: [] };
  let res: Response;
  try {
    res = await fetch('/api/ai/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(opts.token ?? null) },
      body: JSON.stringify({
        text: opts.text,
        snapshot: opts.snapshot,
        history: (opts.history ?? []).slice(-6),
        model: opts.model,
      }),
    });
  } catch (e) {
    return { ...empty, error: `连不上本地服务：${(e as Error).message}　（请确认 npm run server 在跑）` };
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ...empty, error: `本地服务返回了非 JSON（HTTP ${res.status}）` };
  }

  if (res.status === 401) return { ...empty, error: String(body.error ?? '未登录或会话已过期') };
  if (res.status === 429) return { ...empty, error: String(body.error ?? 'AI 额度已用完') };
  if (res.status === 403) return { ...empty, error: String(body.error ?? '没有权限') };

  const rawActions = Array.isArray(body.actions) ? body.actions : [];
  /**
   * 第二次校验：拿服务端给的 reply/actions 重新过一遍契约。
   * 归一化过的动作能再次通过（幂等），被篡改/畸形的会在这一层落下来。
   */
  const revalidated = validatePlan({ reply: body.reply, actions: rawActions }, snapshotContext(opts.snapshot));
  const rejected: PlanRejection[] = [
    ...((body.rejected as PlanRejection[] | undefined) ?? []),
    ...revalidated.rejected.map((r) => ({ index: r.index, code: r.code, error: r.error })),
  ];

  /**
   * ── 有动作被拒 → **整份计划一条都不执行**（原子性）──
   *
   * 为什么不是"跳过坏的、执行好的"：
   *   用户说的是"把踢脚改成 120，再把它改成 2900 高"。如果"2900 高"这条被规则拒掉，
   *   而"踢脚 120"照样执行了，用户看到的是"AI 干了一半"—— 他会以为两件事都办了。
   *   半执行的意图比不执行更危险，因为它是**静默**的。
   *
   * 但拒绝必须给出**具体理由**。
   *   早先这里返回 ok:false 却不带 error（服务端在"部分被拒"时只回 rejected、不回 error），
   *   于是界面上只剩一句光秃秃的「规划失败」，而真正的原因（第几条、为什么）
   *   就躺在没人渲染的 rejected 数组里。用户看到的是一句没有信息量的话。
   *   现在把"第几条 / 共几条 / 为什么"写进 error，rejected 同时交给界面逐条列出。
   */
  const rejectedNote =
    rejected.length > 0
      ? `AI 给出的 ${rejected.length} 条动作不符合契约（第 ${rejected.map((r) => r.index + 1).join('、')} 条），整份计划不予执行 —— 只执行未被拒的那几条会得到"半执行"的模型，而用户以为整句话都生效了。具体原因见下。`
      : undefined;

  return {
    ok: Boolean(body.ok) && rejected.length === 0 && (revalidated.ok || rawActions.length === 0),
    error: rejectedNote ?? (body.error as string | undefined) ?? (revalidated.ok ? undefined : revalidated.error),
    reply: String(body.reply ?? revalidated.reply ?? ''),
    actions: revalidated.actions.map((a, i) => ({ ...a, index: i })),
    rejected,
    raw: body.raw as string | undefined,
    reasoning: body.reasoning as string | undefined,
    finishReason: body.finishReason as string | undefined,
    salvagedFromReasoning: body.salvagedFromReasoning === true,
    model: body.model as string | undefined,
    usage: (body.usage as PlanResponse['usage']) ?? null,
    ms: body.ms as number | undefined,
    quota: (body.quota as QuotaView | undefined) ?? undefined,
  };
}

// ───────────────────────────── AI 设计方案（P3）─────────────────────────────

export interface DesignResponse {
  ok: boolean;
  error?: string;
  /** 通过形状门的方案（**还没进模型**，也还没编译） */
  proposal?: DesignProposal;
  /** 模型返回了但形状不对时的原文 —— 不猜、不修，原样给界面显示 */
  raw?: string;
  reasoning?: string;
  finishReason?: string;
  salvagedFromReasoning?: boolean;
  model?: string;
  usage?: PlanResponse['usage'];
  ms?: number;
  quota?: QuotaView;
}

/**
 * 要一份设计方案（不是要动作）。
 *
 * ── 与 requestPlan 的分工 ──
 *   plan = "照这句话去改现有模型"（动作级，改的是已经存在的东西）；
 *   design = "照这句需求设计一个方案"（需求级，产出的是**新建**的东西）。
 *   两条路最后都汇到 `dryRunPlan → 确认 → commitPlan`，写入口只有一个。
 *
 * ── 为什么这里还要再验一遍形状 ──
 *   服务端已经验过。但"服务端验过了"不能成为前端免检的理由 ——
 *   校验器只有一份（契约），多调一次不产生第二套规则，
 *   而少调一次就多一处"将来换通道时忘了验"的口子。
 */
export async function requestDesign(opts: {
  text: string;
  snapshot: AiSnapshot;
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
  model?: string;
  token?: string | null;
}): Promise<DesignResponse> {
  const empty: DesignResponse = { ok: false };
  let res: Response;
  try {
    res = await fetch('/api/ai/design', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(opts.token ?? null) },
      body: JSON.stringify({
        text: opts.text,
        snapshot: opts.snapshot,
        history: (opts.history ?? []).slice(-6),
        model: opts.model,
      }),
    });
  } catch (e) {
    return { ...empty, error: `连不上本地服务：${(e as Error).message}　（请确认 npm run server 在跑）` };
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    return { ...empty, error: `本地服务返回了非 JSON（HTTP ${res.status}）` };
  }
  if (res.status === 401) return { ...empty, error: String(body.error ?? '未登录或会话已过期') };
  if (res.status === 429) return { ...empty, error: String(body.error ?? 'AI 额度已用完') };
  if (res.status === 403) return { ...empty, error: String(body.error ?? '没有权限') };
  if (!body.ok) {
    return {
      ...empty,
      error: String(body.error ?? '没有拿到方案'),
      raw: body.raw as string | undefined,
      reasoning: body.reasoning as string | undefined,
      finishReason: body.finishReason as string | undefined,
      model: body.model as string | undefined,
      usage: (body.usage as DesignResponse['usage']) ?? null,
      ms: body.ms as number | undefined,
    };
  }

  const proposal = body.proposal;
  const bad = proposalShapeError(proposal);
  /**
   * 形状不对 → **整份不要**，不做"尽力修补"。
   * 半份被修过的方案比没有方案更危险：界面会拿它去预览，
   * 而预览出来的东西和用户说的不是一回事。
   */
  if (bad) {
    return { ...empty, error: `AI 给的方案形状不对，已整份退回：${bad}`, raw: JSON.stringify(proposal).slice(0, 800) };
  }
  return {
    ok: true,
    proposal: proposal as DesignProposal,
    reasoning: body.reasoning as string | undefined,
    finishReason: body.finishReason as string | undefined,
    salvagedFromReasoning: body.salvagedFromReasoning === true,
    model: body.model as string | undefined,
    usage: (body.usage as DesignResponse['usage']) ?? null,
    ms: body.ms as number | undefined,
    quota: (body.quota as QuotaView | undefined) ?? undefined,
  };
}

// ───────────────────────────── AI 对话 ─────────────────────────────

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /**
   * 推理模型的**思考 token**。它是"为什么这一问等了 20 秒"的直接答案 ——
   * 实测局域网那个模型回答一句常识问题：输出 224 个 token 里 190 个是思考。
   */
  reasoning_tokens?: number;
}

/**
 * 一条对话消息。`reasoning` 只在 assistant 消息上有值。
 *
 * 为什么不把 reasoning 直接丢掉：它**不是**模型的回答，但它是长时间等待与
 * 空回答的唯一解释。丢掉它，用户面对的就是"转了很久 + 一个空白框"。
 */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  reasoning?: string;
  model?: string;
  usage?: ChatUsage | null;
  ms?: number;
  finishReason?: string;
  /** 正文为空时服务端给出的**可操作**原因（不是一句"AI 没有回答"） */
  emptyReason?: string;
  /**
   * 这条消息上的错误。放在 turn 上而不是单独一个错误状态 ——
   * 这样界面上每条失败都**留在它发生的位置**（那个空白的回答框旁边），
   * 而不是跑到面板顶部变成一个不知道属于哪一轮的红色条。
   */
  error?: string;
}

/**
 * 对话通道的角色设定。
 *
 * 最后两条最要紧：**说明它不能改模型**，并指明该走哪条路。
 * 不这么写，模型经常回"好的，我已经帮你改成 120 了"—— 而它其实什么都没做
 * （它在结构上就没有这个能力）。这种"口头答应"是最坏的一类误会：
 * 用户以为模型已经改了，于是不会去点「生成编辑计划」。
 */
const CHAT_SYSTEM = [
  '你是定制家具设计软件（Web CAD）里的助手。',
  '· 可以解释尺寸、结构、板材、五金、工艺等问题，也可以针对当前项目提建议。',
  '· 你**不能直接修改模型**。用户若要改尺寸或结构，请让他点「生成编辑计划」把要求说清楚。',
  '  **不要**说"已经帮你改好了"这类话 —— 你没有这个能力，说了会造成误解。',
  '· 用中文回答，简短、直接。不要输出 JSON。',
].join('\n');

export interface ChatResponse {
  ok: boolean;
  error?: string;
  note?: string;
  turn: ChatTurn;
  /** 这一问花完之后还剩多少额度（对话也计 token，但不计生成次数） */
  quota?: QuotaView;
}

/**
 * 自由对话 —— 和「生成编辑计划」是**两条不同的路**。
 *
 * ── 为什么必须分成两个入口 ──
 *   用户说"踢脚线一般多高"，可能是问常识，也可能是想让 AI 改。
 *   如果交给模型自己判断，同一句话在不同时候会有不同后果 ——
 *   有时动了模型，有时没动，而**界面上看不出区别**。
 *   "这句话有没有动到我的模型"必须由用户点下的那个按钮决定，
 *   不能由模型的判断决定。所以：对话永不改模型；要改就点计划按钮，
 *   走两段式（干跑预览 → 你确认）。
 *
 * ── 为什么要把项目快照一起发过去 ──
 *   这是个 CAD 助手，"我这个柜子踢脚多高"是最自然的问法。
 *   不带快照它只能泛泛而谈。快照是**白名单投影**（见 snapshot.ts），
 *   只有语义参数，没有板件也没有几何 —— 所以发过去是安全的。
 */
export async function requestChat(opts: {
  history: ChatTurn[];
  snapshot: AiSnapshot;
  token: string | null;
  /**
   * 会话范围说明（"当前只针对房间X"）。
   *
   * 放进**系统提示**，不放进用户的话里：用户说的话要原样留在历史里，
   * 否则回头看历史时会看到一句自己没说过的话 —— 历史被篡改过一次之后，
   * 它就再也没法用来复盘了。
   */
  scope?: string;
}): Promise<ChatResponse> {
  const empty: ChatTurn = { role: 'assistant', text: '' };
  /** 只回传最近 12 条，防止多轮之后 prompt 无限膨胀 */
  const turns = opts.history
    .filter((m) => m.text.trim())
    .slice(-12)
    .map((m) => ({ role: m.role, content: m.text }));

  const scopeLine = opts.scope ? `\n\n${opts.scope}` : '';
  const system = `${CHAT_SYSTEM}${scopeLine}\n\n当前项目状态（只读，JSON）：\n\`\`\`json\n${JSON.stringify(opts.snapshot)}\n\`\`\``;

  let res: Response;
  try {
    res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(opts.token) },
      body: JSON.stringify({ messages: [{ role: 'system', content: system }, ...turns] }),
    });
  } catch (e) {
    const msg = `连不上本地服务：${(e as Error).message}　（请确认 npm run server 在跑）`;
    return { ok: false, error: msg, turn: { ...empty, error: msg } };
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    const msg = `本地服务返回了非 JSON（HTTP ${res.status}）`;
    return { ok: false, error: msg, turn: { ...empty, error: msg } };
  }
  if (res.status === 401) {
    const msg = String(body.error ?? '未登录或会话已过期');
    return { ok: false, error: msg, turn: { ...empty, error: msg } };
  }
  if (res.status === 429) {
    const msg = String(body.error ?? 'AI 额度已用完');
    return { ok: false, error: msg, turn: { ...empty, error: msg } };
  }
  if (res.status === 403) {
    const msg = String(body.error ?? '没有权限');
    return { ok: false, error: msg, turn: { ...empty, error: msg } };
  }

  const text = String(body.text ?? '');
  const error = body.error as string | undefined;
  return {
    ok: Boolean(body.ok) && text.trim().length > 0,
    error,
    note: body.note as string | undefined,
    turn: {
      role: 'assistant',
      text,
      reasoning: body.reasoning as string | undefined,
      model: body.model as string | undefined,
      usage: (body.usage as ChatUsage) ?? null,
      ms: body.ms as number | undefined,
      finishReason: body.finishReason as string | undefined,
      emptyReason: body.emptyReason as string | undefined,
      error: text.trim() ? undefined : error,
    },
    quota: (body.quota as QuotaView | undefined) ?? undefined,
  };
}

// ───────────────────────────── 账号 / 会话 ─────────────────────────────

export interface AuthAccount {
  id: string;
  username: string;
  displayName: string;
  role: string;
  roleLabel: string;
  plan: string;
  planLabel: string;
  status: string;
  tenantId: string;
  createdAt: string;
  lastLoginAt: string | null;
  quota: QuotaView;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; token?: string | null } = {}): Promise<{ ok: boolean; error?: string; status: number; data: T }> {
  try {
    const res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json', ...authHeaders(opts.token ?? null) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown> & T;
    return { ok: res.ok && data.ok !== false, error: typeof data.error === 'string' ? data.error : undefined, status: res.status, data };
  } catch (e) {
    return { ok: false, error: `连不上本地服务：${(e as Error).message}`, status: 0, data: {} as T };
  }
}

/**
 * token 存放位置：sessionStorage，不放 localStorage。
 *
 * 理由：sessionStorage 随标签页关闭而消失，且不跨标签页共享。
 * localStorage 里的 token 会一直留在这台机器上，任何人打开浏览器
 * （包括共用这台电脑的家人、以及任何注入到这个源上的脚本）都能直接拿到它。
 * 代价是"关掉标签页要重新登录"—— 这个代价换来的东西是值得的。
 */
const TOKEN_KEY = 'furniture-cad.auth.token';

export function loadToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(t: string | null): void {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用 —— 那就只能不记住登录，正常工作仍不受影响 */
  }
}
