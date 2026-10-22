/**
 * ══════════════════════════════════════════════════════════════════════
 *  NLU 评测卡（2026-10-21）
 *
 * ── 它是什么 ──
 *   一组**真实用户口语**的说法 + 期望动作 + 程序化判分。
 *   不靠 LLM judge，靠「模型输出的动作名是否命中期望」。
 *
 * ── 为什么要有 ──
 *   「agent 能不能听懂人话」这件事**一直没有度量**。
 *   之前只能靠「试用时感觉还行」。
 *   有了这张卡，改提示词/换模型/加动作之后，
 *   能不能听懂就变成一个**可比较的数字**。
 *
 * ── 两种判定 ──
 *   ① **动作命中**：模型选了对的动作（最直接）。
 *   ② **正确澄清**：信息不足时**应该追问**而不是瞎猜。
 *      —— 这一项比动作命中率更贴近用户感受。
 *     「建个柜子」这种请求，正确行为是问「什么柜子、多宽、多高」，
 *     不是随便造一个。
 *
 * ── 怎么跑 ──
 *   node --experimental-strip-types verify/nlu-eval.ts
 *   联网跑（要真实调模型）。离线时自动跳过并说明。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemPrompt, extractJson } from '../shared/aiContract.mjs';
import { deriveFocusFromHistory, renderFocusStack } from '../shared/focusStack.mjs';
import { summarizeProjectContext } from '../server/agentLoop.mjs';
import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
import type { RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

// ── 网关配置（自己读 .env，验收不该依赖外部环境变量是否导出）──
const envText = (() => { try { return readFileSync(join(here, '..', '.env'), 'utf8'); } catch { return ''; } })();
const envOf = (k: string): string => {
  const m = new RegExp('^' + k + '=(.*)$', 'm').exec(envText);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
const BASE = process.env.AI_BASE_URL || envOf('AI_BASE_URL');
const KEY = process.env.AI_API_KEY || envOf('AI_API_KEY');
/**
 * ★ 支持一次跑多个模型（2026-10-21）──
 *
 *   NLU_MODELS 用逗号分隔；不设就只跑 NLU_MODEL（或 .env 里的默认）。
 *   一次跑完能直接横向对比，比一个一个跑省事得多。
 */
const MODELS: string[] = (
  process.env.NLU_MODELS
    ? process.env.NLU_MODELS.split(',').map((x) => x.trim()).filter(Boolean)
    : [process.env.NLU_MODEL || process.env.AI_MODEL || envOf('AI_MODEL')].filter(Boolean)
);

/**
 * 造一个真实项目。
 *
 * ★ 场景不同，项目也不同 ──
 *   场景 A（单柜）：只有一台柜 ⇒「这柜子」指代清楚 ⇒ 该做就做。
 *   场景 B（三柜）：三台柜 ⇒「踢脚改成100」**确实有歧义**（改哪台？）⇒ 该问就问。
 *   场景 C：同场景 B，但问的是**参数缺失**。
 *
 * ★ 这两类必须分开量 ──
 *   混在一起会得出「模型爱追问」或「模型不爱追问」这种没法行动的结论。
 *   分开才知道它在**该问时问没问**、在**不该问时问没问**。
 */
function buildProject(cabCount: number) {
  const project = emptyProject({ name: 'nlu', ruleSetId: rules.id, id: 'nlu' });
  const bedroom = rectRoom({ name: '主卧', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  const living = rectRoom({ name: '客厅', x: 10000, y: 0, w: 5000, h: 4000, thickness: 120, height: 2700 });
  project.rooms.push(bedroom, living);
  const mk = (id: string, name: string, roomId: string, x: number, kind: string) =>
    createCabinet({
      id, name, roomId, x, y: 60, rotation: 0, rules,
      params: { width: 1800, height: 2400, depth: 600, bodyLift: 80, cabinetType: kind, mountHeight: 0 },
      // ★ 每台柜**多个不同类型的分区** —— 真实衣柜有挂衣区也有层板区。
      //   （原来三台柜都只有挂衣区，模型说「都只有挂衣区」是**测试数据**的问题。）
      units: [
        { id: id + 'u1', kind: 'hanging', requestedWidth: 1200, nickname: '挂衣区', rod: { count: 1, heightFromBottom: 1800 } },
        { id: id + 'u2', kind: 'shelves', requestedWidth: 600, nickname: '层板格', shelves: { count: 3, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 } },
      ],
    });
  project.cabinets.push(mk('c1', '主卧衣柜', bedroom.id, 100, 'tall'));
  if (cabCount >= 2) project.cabinets.push(mk('c2', '主卧床尾柜', bedroom.id, 2100, 'base'));
  if (cabCount >= 3) project.cabinets.push(mk('c3', '客厅电视柜', living.id, 100, 'base'));
  return { project, bedroom };
}
/**
 * ★ 评测用例 ──
 *
 * wantActions：期望模型选的动作（任一命中即算动作命中）
 * wantClarify：该请求**信息不足**，正确行为是**追问**（而不是硬猜）
 *
 * 用例刻意用**口语**，不是命令式：
 *   「给我来个衣柜」而不是「创建柜体 type=tall」
 *   「刚才那个柜子太宽了」而不是「resize width=800」
 *   —— 前者才是用户真会说的话。
 */
interface NluTurn {
  /** 这一轮用户说的话 */
  q: string;
  /** 期望动作（空数组 = 期望追问） */
  wantActions: string[];
  /** 期望追问 */
  wantClarify?: boolean;
}

interface NluCase {
  q: string;
  wantActions: string[];
  wantClarify?: boolean;
  note?: string;
  /**
   * 场景：决定用几个柜的项目。
   *   'single' = 一台柜（指代清楚）；'multi' = 三台柜（指代有歧义）；
   *   'turns'   = 多轮（跨轮指代）。
   */
  scenario: 'single' | 'multi' | 'turns';
  /** 两种回答都算对（追问也行、给对动作也行）—— 用于「本身就有歧义」的请求 */
  allowClarify?: boolean;
  /**
   * 多轮场景的完整对话（按顺序）。
   *   判定只看**最后一轮**；前面的轮次用来建立指代对象。
   */
  turns?: NluTurn[];
}
/**
 * ★ 重复次数 k（2026-10-21）——
 *
 *   为什么必须重复跑 ──
 *   实测发现：**同一句话、同一上下文，两次运行结果不同**。
 *   「换成玻璃门」一次追问「换哪一格」、一次直接改两个 —— 两次都对，
 *   但这说明「跑通一次」不能代表「这个行为稳定」。
 *
 *   两个口径 ──
 *   pass@k   = k 次里**至少对 1 次**（乐观：偶尔对就算会）
 *   pass^k   = k 次**全对**（悲观：k 次都对才算稳定）
 *
 *   ★ 家具出错图是**不可逆返工** ——
 *     所以真正该看的是 pass^k（稳定性），pass@k 只能当「会不会」的上限。
 *     调研报告里的 90% pass@1 → pass^8 只剩 43%，说的就是这件事。
 *
 *   ★ 默认 k=5，不是 3 ──
 *     实测教训：k=3 时多轮场景 pass^3 是 75%，k=5 却是 100% ——
 *     那个 75% 完全是**噪声**（一条用例抖一次就掉 25%）。
 *     用 k=3 判断「某个改动有没有用」= 抽签。
 *   用 NLU_K 环境变量可调；判断改动前后的差异时**必须 k>=5 且做 A/B 对照**
 *   （NLU_NO_FOCUS=1 可关掉焦点栈做对照）。
 */
const K = Math.max(1, Number(process.env.NLU_K ?? 5) || 5);

const CASES: NluCase[] = [
  /**
   * ★ 场景 A：只有一台柜 —— 指代清楚，该做就做
   *   （「踢脚改成100」在只有一台柜时**不该**问「改哪台」）
   */
  // ★ 柜子的宽高深**本来就该问** —— 缺了就是缺了，不该替用户挑一个。
  { q: '给我来个衣柜', wantActions: [], wantClarify: true, note: '宽高深未知，该问', scenario: 'single' },
  { q: '踢脚改成100', wantActions: ['cabinet.setBodyLift'], scenario: 'single' },
  { q: '层板再多加两层', wantActions: ['cabinet.setUnitParam'], scenario: 'single' },
  // ★ 柜子有两个分区时，「换成玻璃门」**该问换哪一格**（或都换）。
  //   模型问对了 —— 它明确说「玻璃门我会用灰玻 M_GLASS_8_GREY，不会被降级成木门」，
  //   说明它**读懂了新动作的语义**。
  // ★ 这条**两种回答都对**：换哪一格该问；全换也行。
  //   模型在两次运行里分别给了「追问」和「直接改两个」—— 行为不稳定（见 pass^k）。
  //   判分：给了对的动作 **或** 追问了，都算通过。
  { q: '换成玻璃门', wantActions: ['cabinet.setUnitDoorMaterial'], allowClarify: true, note: '换哪一格或都换，两种都对', scenario: 'single' },
  { q: '层板格换成玻璃门', wantActions: ['cabinet.setUnitDoorMaterial', 'cabinet.setUnitParam'], scenario: 'single' },
  { q: '加个裤架', wantActions: ['cabinet.setUnitFeature', 'cabinet.setUnitParam', 'cabinet.addUnit'], scenario: 'single' },
  { q: '那个挂衣区下面加一层格子', wantActions: ['cabinet.addUnit', 'cabinet.setUnitParam'], scenario: 'single' },
  { q: '这柜子下面留个洗衣机的位置', wantActions: ['cabinet.addUnit'], scenario: 'single' },
  { q: '叫「主卧衣柜」', wantActions: ['cabinet.rename'], scenario: 'single' },
  { q: '再来一个一样的', wantActions: ['cabinet.duplicate'], scenario: 'single' },
  { q: '把它宽改成800', wantActions: ['cabinet.resize'], scenario: 'single' },
  /**
   * ★ 场景 B：多台柜 —— 指代不清，该问就问
   *   「踢脚改成100」在**三台柜**面前**确实有歧义**（改哪台？），
   *   正确行为是追问，不是随便挑一台改。
   *
   *   ★ 这两类必须分开量 ──
   *   混在一起会得出「模型爱追问」或「模型不爱追问」这种没法行动的结论。
   *   分开才知道它在**该问时问没问**、在**不该问时问没问**。
   */
  // ★ 模型给的是 setBodyLift × 3（三台全改）—— 也是一种合理解读，
  //   所以这条**不算它错**；它错不错取决于产品要不要「全部都改」这个语义。
  { q: '踢脚改成100', wantActions: ['cabinet.setBodyLift'], scenario: 'multi' },

  { q: '这柜子太宽了，缩到800', wantActions: [], wantClarify: true, note: '「这柜子」指哪台？', scenario: 'multi' },
  /**
   * ★ 场景 C：信息不足 —— 该追问
   *   「建个柜子」缺太多信息（柜型/宽/高/位置），
   *   模型如果直接造一个 600×800×600 的柜子，就是**在替用户做决定**。
   */
  { q: '建个柜子', wantActions: [], wantClarify: true, note: '柜型/宽高/位置都不明', scenario: 'multi' },
  { q: '再宽点', wantActions: [], wantClarify: true, note: '相对量但没基准', scenario: 'multi' },
  { q: '加个抽屉', wantActions: [], wantClarify: true, note: '哪个柜？多宽？', scenario: 'multi' },
  /**
   * ★ 场景 D：多轮（跨轮指代）——
   *   「再宽点」「第一格」这类词**单独看没有意义**，意思全在上一轮里。
   *   模型丢了上下文就只能瞎猜。
   *
   *   测法：多轮按顺序喂进去，**只看最后一轮**的判定。
   *   前面几轮的作用是**建立指代对象**。
   */
  {
    q: '再加 200 宽',
    wantActions: ['cabinet.resize'],
    scenario: 'turns',
    note: '第 2 轮：第 1 轮建了 1800 宽的衣柜，第 2 轮说「再加 200」—— 相对量但有基准，模型该算出 2000',
    turns: [
      { q: '给我做个衣柜，1800 宽', wantActions: ['cabinet.create'] },
      { q: '再加 200 宽', wantActions: ['cabinet.resize'] },
    ],
  },
  {
    q: '再宽点',
    wantActions: [],
    wantClarify: true,
    scenario: 'turns',
    note: '第 2 轮：「再宽点」是相对量但**没给加多少** —— 该问「加多少毫米」',
    turns: [
      { q: '给我做个衣柜，1800 宽', wantActions: ['cabinet.create'] },
      { q: '再宽点', wantActions: [], wantClarify: true },
    ],
  },
  {
    q: '第一格换成玻璃门',
    wantActions: ['cabinet.setUnitDoorMaterial', 'cabinet.setUnitParam'],
    scenario: 'turns',
    note: '第 2 轮：第 1 轮建了双分区衣柜，第 2 轮指「第一格」',
    turns: [
      { q: '给我做个衣柜，左边挂衣右边层板，各 900 宽', wantActions: ['cabinet.create'] },
      { q: '第一格换成玻璃门', wantActions: ['cabinet.setUnitDoorMaterial', 'cabinet.setUnitParam'] },
    ],
  },
  {
    q: '那个抽屉也加个格子',
    wantActions: [],
    wantClarify: true,
    scenario: 'turns',
    note: '第 2 轮：「那个」指上一轮建的抽屉，但「加个格子」在抽屉区里说不清，该问',
    turns: [
      { q: '给我做个衣柜，左边挂衣右边层板，各 900 宽', wantActions: ['cabinet.create'] },
      { q: '那个抽屉也加个格子', wantActions: [], wantClarify: true },
    ],
  },
];

async function chat(model: string, messages: unknown[], maxTokens = 8192) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.1 }),
      signal: AbortSignal.timeout(180000),
    });
    const txt = await r.text();
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, ms, raw: txt.slice(0, 200) };
    const j = JSON.parse(txt);
    const m = (j?.choices?.[0]?.message ?? {}) as { content?: string };
    return { ok: true, ms, content: String(m.content ?? ''), finish: j?.choices?.[0]?.finish_reason, usage: j?.usage };
  } catch (e) {
    // ★ 网关超时/网络错误**不能**让整个评测崩掉 ——
    //   pass^k 就是要量「有多少次没跑成」，崩了就什么都量不到。
    //   而且超时本身就是一个结果（模型太慢 = 实际不可用）。
    return { ok: false, status: 0, ms: Date.now() - t0, raw: 'EXC: ' + String((e as Error)?.message ?? e).slice(0, 120) };
  }
}

/** 场景 → 柜数 */
const CAB_COUNT = { single: 1, multi: 3, turns: 1 } as const;

const sys = buildSystemPrompt({});

if (!BASE || !KEY || MODELS.length === 0) {
  console.log('未配置 AI_BASE_URL / AI_API_KEY / AI_MODEL —— 跳过（联网评测需要网关）');
  console.log('='.repeat(64));
  process.exit(0);
}


/**
 * 一条用例在 k 次运行里的结果。
 */
interface RunResult {
  pass: boolean;
  actions: string[];
  reply: string;
  ms: number;
  parseFail: boolean;
  /** 基础设施故障（网关抖了/空内容/JSON 坏）—— 不是模型判断错，不计入准确率 */
  infraFail?: boolean;
  /** 网关调用是否成功（失败 = 超时/非 JSON 响应） */
  ok: boolean;
  status?: number;
  /** 上游的结束原因（length = 撞到输出预算被截断） */
  finish?: string;
  /** 网关返回的原始错误（502 等） */
  raw?: string;
  /** 本次输出用了多少 completion token */
  cc?: number;
  /** 其中多少是推理 token */
  rt?: number;
}

/**
 * 跑一条用例一次，返回判定结果。
 */
async function runOnce(
  model: string,
  c: NluCase,
  ctx: string,
  history: Array<{ role: string; text: string; agentSummary?: string; agentSteps?: string }> = [],
  project: unknown = null,
): Promise<RunResult> {
  // ★ 焦点栈：真实会话里 Agent 通道会把它注入 system 提示词（server/agentLoop.mjs）。
  //   评测必须**同样**注入，否则测的是「没有焦点」的表现。
  // ★ NLU_NO_FOCUS=1 可以**关掉**焦点栈 ——
  //   用来做「有/无焦点栈」的对照实验（同一批用例、同一个模型、只差这一点）。
  const focusText = process.env.NLU_NO_FOCUS
    ? ''
    : renderFocusStack(deriveFocusFromHistory(history, project));
  const messages: unknown[] = [{ role: 'system', content: focusText ? sys + '\n' + focusText : sys }];
  // ★ 多轮：先喂历史，再喂本轮 ——
  //   「再宽点」的意思全在历史里，丢了就只剩一个没有主语的词。
  for (const h of history) messages.push({ role: h.role, content: h.text });
  messages.push({ role: 'user', content: ctx + '\n\n用户说：' + c.q });
  const r = await chat(model, messages);
  let actions: string[] = [];
  let reply = '';
  let parseFail = false;
  if (r.ok) {
    // ★ 用**生产**的 extractJson ——
    //   它有 firstBalancedObject 兜底，能从「先说一句人话再给 JSON」的输出里
    //   提取出配平的 {...}。评测用简陋的正则会误判成「JSON 截断」，
    //   而生产其实解析得好好的 ⇒ 评测反映的就不是真实行为。
    const parsed = extractJson(r.content);
    if (parsed.ok) {
      const j = parsed.value as { actions?: Array<{ action?: string }>; reply?: string };
      actions = (j.actions ?? []).map((a) => String(a.action ?? ''));
      reply = String(j.reply ?? '');
    } else {
      parseFail = true;
      if (process.env.NLU_DEBUG_RAW) console.log('[RAW-BAD] ' + r.content.slice(0, 400));
    }
  }
  // ★★ 区分「模型答错」与「**根本没答**」——
  //   网关 502/504、模型返回空内容、JSON 解析失败 ⇒ 这些**不是模型判断错**，
  //   是基础设施抖了。算进准确率会把「网关故障」误报成「模型变笨了」，
  //   也会让 A/B 对照的结论失真（实测有一轮「多轮 50%」其实是 6 次空答案）。
  const infraFail = !r.ok || (r.ok && r.content.trim() === '') || parseFail;
  // 判定：期望动作命中 = 通过；期望追问 = 没给动作 = 通过；allowClarify = 两者都行
  let pass: boolean;
  if (c.allowClarify) {
    pass = c.wantActions.some((w) => actions.includes(w)) || actions.length === 0;
  } else if (c.wantClarify) {
    pass = actions.length === 0;
  } else {
    pass = c.wantActions.some((w) => actions.includes(w));
  }
  return { pass, actions, reply, ms: r.ms, parseFail, infraFail, ok: r.ok, status: r.status, raw: r.raw, finish: r.finish, cc: r.usage?.completion_tokens, rt: r.usage?.completion_tokens_details?.reasoning_tokens };
}

/** 统计口径 */
interface Stat {
  /** 用例数 */
  n: number;
  /** pass@1：单次跑的平均正确率 */
  passAt1: number;
  /** pass@k：k 次里至少对 1 次的用例占比 */
  passAtK: number;
  /** pass^k：k 次全对的用例占比（稳定性） */
  passPowK: number;
  /** k 次全对的用例数 */
  stable: number;
  /** k 次里有时对有时不对的用例数 */
  unstable: number;
  /** 基础设施故障次数（网关抖了/空内容）—— 不计入准确率 */
  infra: number;
  /** 完全没拿到有效回答的用例数 */
  noAnswer: number;
}

/**
 * 评测一个模型。
 */
async function evaluateModel(model: string): Promise<void> {
  const MODEL = model;   // ★ 本函数内的 chat() 用它
  console.log('');
  console.log('━'.repeat(64));
  console.log('模型：' + MODEL + '   每条跑 ' + K + ' 次');
  console.log('━'.repeat(64));
  const stats = new Map<string, Stat>();
  for (const sc of ['single', 'multi', 'turns']) {
    stats.set(sc, {
      n: 0, infra: 0, noAnswer: 0,
      passAt1: 0, passAtK: 0, passPowK: 0, stable: 0, unstable: 0,
    });
  }
  const details: string[] = [];
  const unstableCases: string[] = [];

  for (const c of CASES) {
    const { project, bedroom } = buildProject(CAB_COUNT[c.scenario]);
    const ctx = summarizeProjectContext(project, bedroom.id, []);
    const runs: RunResult[] = [];
    for (let i = 0; i < K; i++) {
      // ★ 多轮：先把前几轮跑一遍（建立指代对象），把对话存进 history，
      //   再跑**最后一轮**并判定它。
      //   判定只看最后一轮 —— 前几轮是铺垫。
      const history: Array<{ role: string; text: string; agentSummary?: string; agentSteps?: string }> = [];
      const turns = c.turns ?? [{ q: c.q, wantActions: c.wantActions, wantClarify: c.wantClarify }];
      const last = turns[turns.length - 1]!;
      for (let ti = 0; ti < turns.length - 1; ti++) {
        const t = turns[ti]!;
        const pre = await runOnce(model, { ...c, q: t.q, wantActions: t.wantActions, wantClarify: t.wantClarify }, ctx, history, project);
        //   ctx 已经出现在 system 之后的第一条 user 消息与本轮 user 消息里，
        //   再放一遍会让上下文重复 3 次（36k+ 字符）⇒ 模型困惑 / 上游超长报错。
        history.push({ role: 'user', text: t.q });
        // ★ 带上**结构化的工具调用记录** —— 焦点栈就是从它推导事实的。
        //   真实会话里前端发的就是 agentSteps（JSON 字符串），这里模拟同样的形状，
        //   评测才反映得出「有焦点栈」与「没焦点栈」的差别。
        history.push({
          role: 'assistant',
          text: pre.reply || (pre.actions.length ? pre.actions.join('、') : '（追问）'),
          agentSummary: pre.reply || '',
          agentSteps: JSON.stringify([
            { round: 1, tool: 'cabinet.create_cabinet', ok: true, args: { cabinetId: 'c1', name: '主卧衣柜' } },
            ...(pre.actions.length
              ? [{ round: 1, tool: 'cabinet.layout', ok: true, args: { cabinetId: 'c1' },
                   changes: [{ path: 'params.width', op: 'set', value: 2000 }] }]
              : []),
          ]),
        });
      }
      runs.push(await runOnce(model, { ...c, q: last.q, wantActions: last.wantActions, wantClarify: last.wantClarify }, ctx, history, project));
    }
    // ★ 基础设施故障（网关抖了/空内容/JSON 坏）**不计入准确率** ——
    //   它测的是网关，不是模型。算进去会让「网关故障」伪装成「模型变笨」，
    //   也会让 A/B 结论失真（实测有一轮「多轮 50%」其实是 6 次空答案）。
    const valid = runs.filter((x) => !x.infraFail);
    const infra = runs.length - valid.length;
    const st = stats.get(c.scenario)!;
    st.n++;
    st.infra += infra;
    if (valid.length === 0) { st.noAnswer++; continue; }
    const hits = valid.filter((x) => x.pass).length;
    const KV = valid.length;
    st.passAt1 += hits / KV;
    if (hits >= 1) st.passAtK++;
    if (hits === KV) { st.passPowK++; st.stable++; }
    else {
      st.unstable++;
      if (hits > 0) {
        // ★ 带上每次失败的原因 —— 「不稳定」可能是模型犹豫，也可能是超时/截断，
        //   这两者的修法完全不同（前者改提示词，后者改超时/输出预算）。
        const why = runs.filter((x) => !x.pass).map((x) =>
          !x.ok ? ('网关失败:' + (x.status ?? '?') + (x.raw ? ' ' + String(x.raw).slice(0, 60) : ''))
          : x.parseFail ? ((x.finish === 'length' ? '输出预算耗尽' : 'JSON格式坏') + ' finish=' + (x.finish ?? '?') + ' cc=' + (x.cc ?? '?') + ' 推理=' + (x.rt ?? '?'))
            : (x.actions.length ? '给了别的动作:' + x.actions.join('/') : '纯追问'));
        unstableCases.push('[' + c.scenario + '] ' + c.q + ' —— ' + hits + '/' + KV + ' 次对（不稳定）；失败原因：' + why.join(' / '));
      }
    }
    const mark = hits === KV ? 'v' : hits === 0 ? 'x' : '~';
    const acts = [...new Set(runs.flatMap((x) => x.actions))].join('/') || '(追问)';
    console.log('  ' + mark + ' [' + c.scenario + '] ' + c.q.padEnd(22) + ' ' + hits + '/' + KV + '  ' + acts.slice(0, 52));
    if (hits === 0) {
      const r0 = runs[0];
      details.push('[' + c.scenario + '] ' + c.q + ' —— 0/' + K + ' 次对。模型答：' + (r0.reply || (r0.parseFail ? '(JSON 截断)' : '')).slice(0, 100));
    }
  }

  console.log('='.repeat(64));
  console.log('★ 分场景（每条跑 ' + K + ' 次）—— 混在一起看不出「该问时问没问」：');
  for (const [sc, st] of stats) {
    const label = sc === 'single' ? '单柜（该做就做）' : sc === 'multi' ? '多柜（该问就问）' : '多轮（跨轮指代）';
    const n = Math.max(1, st.n);
    console.log('  ' + label + '：pass@1 ' + (st.passAt1 / n * 100).toFixed(0) + '%   '
      + 'pass@' + K + ' ' + (st.passAtK / n * 100).toFixed(0) + '%   '
      + 'pass^' + K + ' ' + (st.passPowK / n * 100).toFixed(0) + '%   '
      + '（全对 ' + st.stable + ' / 不稳定 ' + st.unstable + ' / 共 ' + st.n + '）');
      + (st.infra ? '   ⚠ 基础设施故障 ' + st.infra + ' 次（已剔除）' : '');
  }
  console.log('');
  console.log('★ 两个口径的区别 —— 家具出错图不可逆，**pass^k 才是该盯的那个**：');
  console.log('  pass@k = k 次里至少对 1 次（会不会）');
  console.log('  pass^k = k 次全对（稳不稳）      —— 差值越大说明越飘');
  if (unstableCases.length) {
    console.log('');
    console.log('★ 不稳定的用例（k 次里有时对有时不对）：');
    for (const d of unstableCases) console.log('  · ' + d);
  }
  if (details.length) {
    console.log('');
    console.log('完全没对的用例：');
    for (const d of details) console.log('  · ' + d);
  }
  console.log('='.repeat(64));
}

// ── 跑所有模型 ──
for (const m of MODELS) {
  await evaluateModel(m);
}
console.log('='.repeat(64));
