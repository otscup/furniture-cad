import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Issue } from '../../core/types.ts';
import { ACTION_NAMES, ACTIONS } from '../../../shared/aiContract.mjs';
import { api, requestChat, requestDesign, requestPlan, type ChatTurn, type DesignResponse, type PlanRejection } from '../../ai/aiClient.ts';
import type { QuotaView } from '../../ai/quotaTypes.ts';
import { QuotaMeter } from '../QuotaMeter.tsx';
import { buildSnapshot, snapshotBytes, type AiSnapshot } from '../../ai/snapshot.ts';
import { commitPlan, dryRunPlan, type PlanRun } from '../../ai/planRunner.ts';
import {
  addDraftRound,
  draftSnapshot,
  finalizeDraft,
  startDraft,
  undoLastRound,
  type DraftSession,
} from '../../ai/draftSession.ts';
import { validateProposal, type DesignProposal } from '../../ai/proposal.ts';
import { compileProposal } from '../../ai/compileProposal.ts';
import type { AiAction } from '../../ai/compile.ts';
import { PlanRunView } from './PlanRunView.tsx';
import { CandidateComparePanel } from './candidateCompare.tsx';
import { resolveSelection, type StoredCandidateSelection } from './candidateCompareLogic.ts';
import { candidateKey } from '../../core/candidateLayout/generate.ts';
import { planCandidates, type PlannerPlan } from '../../core/planner/index.ts';
import { compiledRules } from '../../state/memoryStore.ts';
import { currentKnowledge, resolveKnowledge, knowledgeDigest as knowledgeDigestOf } from '../../ai/knowledge/index.ts';
import { Pill, Row, Section, Text } from './common.tsx';
import { DraftPreview } from './DraftPreview.tsx';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  AI 面板 —— 按房间一对一聊天；草案随每一句话更新
 *
 *  ── 为什么是「对话」和「生成编辑计划」两个按钮，而不是一个 ──
 *    用户说"踢脚线一般多高"，可能是在问常识，也可能是想让 AI 改。
 *    如果交给模型自己判断，同一句话在不同时候会有不同后果 ——
 *    有时动了模型，有时没动，而**界面上看不出区别**。
 *    "这句话有没有动到我的模型"必须由用户点下的那个按钮决定：
 *
 *      对话    永不改模型。只回答、只解释。想改就明确告诉他点另一边。
 *      生成计划 一定会产出一份动作清单，而且**在你点「应用」之前不碰模型**。
 *
 *  ── 历史为什么不许丢（一次真实反馈：切个页签回来，刚才的东西全没了）──
 *    右侧面板是**按需挂载**的（`{rightTab === 'ai' ? <AIPanel/> : null}`）。
 *    切到「属性」再切回来，组件被卸载后重建 —— 任何只活在 state 里的东西都归零。
 *    以前只有对话记得住（sessionStorage），**草案与干跑预览不记得**：
 *    用户为了让模型想清楚，等了三十秒跑出一份草案，去别处看一眼再回来，
 *    草案没了、预览也没了，等于那一分钟白等。
 *    现在**整份会话**（聊天 + 草案 + 计划预览）都落 sessionStorage，
 *    且按房间分开存 —— 这不是锦上添花，是"等多久都不能白等"这条要求的最低实现。
 *
 *  ── 为什么按房间分开会话 ──
 *    "房间2 的柜子再高一点"这句话离开房间2就没有指代了。一旦所有房间共用一段历史，
 *    模型会拿着房间3的话去改房间2，而界面上分不出它改的是哪一轮。
 *    一人一房一段历史，指代才有落点，历史才有可读性。
 *
 *  ── 计划那条路是两段式的，且没有一步是自动的 ──
 *    ① 打字 → 生成计划（AI 只产出动作）
 *    ② 干跑预览（真实管线跑在沙盒模型上）→ 人看清楚 diff / 规则问题 / 记忆拦截
 *    ③ 人点「应用」才写模型
 *    第②步不可跳过：用户点"应用"的唯一依据就是这里显示的东西。
 *    所以预览用的是**和提交完全相同的命令对象**，不是"大概这样"。
 *
 *  ── 界面上必须如实显示的几件事 ──
 *    · 用的是哪个模型、这次花了多少 token（用量是账单，不能估）
 *    · 推理模型还要显示**思考 token** —— 那是"为什么等了 20 秒"的直接答案
 *    · 被契约拒掉的动作（连原因），一条都不能藏
 *    · 每条动作的 reason（AI 为什么这么干）与将要发生的 diff
 *    · 当前模型里还有几条 ERROR（决定这份计划能不能交付生产）
 *
 *  ── 为什么有一个"已等 N 秒"的计时器 ──
 *    实测局域网那台推理模型单次要 17–27 秒。没有计数的等待看起来就是卡死，
 *    用户会去点第二次、第三次，然后一次收到三个回答。
 *    秒数在跳，本身就是"还活着"的证据。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 示例提示词由**契约词汇表**生成，不手写 —— 契约加了动作，示例自动跟上 */
const EXAMPLES = [
  '把主卧衣柜改成 2400 高、600 深',
  '给主卧衣柜加一个 500 宽的抽屉区，4 只抽屉',
  '挂衣区层板改成 3 块，挂衣杆降到 1700',
  '新建一个 1800×2400×600 的柜子，叫「次卧衣柜」',
  '所有柜体踢脚改成 120',
  '柜体板换成 18mm 双饰面木纹板',
];

/** 对话区的开场问题 —— 都是"看一眼就知道答案对不对"的常识题，用来确认链路通没通 */
const CHAT_STARTERS = ['这个柜子的踢脚多高？', '背板 9mm 够吗？', '挂衣杆一般离地多高？'];

/**
 * 会话存在 sessionStorage。
 *
 * ── 为什么不用 localStorage ──
 *   会话是**会话级**的工作记录，不是配置。关掉标签页就该消失。
 *   localStorage 里的东西会一直留在这台机器上（和 token 同一个理由）。
 *   代价是"关掉标签页就得重新聊"，换来的是"它不会悄悄堆积"。
 */
const CONVO_KEY = 'furniture-cad.ai.convos.v2';
const ROOM_KEY = 'furniture-cad.ai.room.v2';
/** 每个房间最多留 40 轮对话，防止长会话把存储撑爆 */
const CHAT_KEEP = 40;

/** 助手回复上附着的"这一轮改了草案的什么" */
interface DraftRoundMark {
  round: number;
  merged: boolean;
  /** 这一轮想执行的动作名 */
  actions: string[];
  rejected: number;
  note: string;
}

interface Turn extends ChatTurn {
  draftRound?: DraftRoundMark;
}

/** 计划通道那一整块的结果（一次性计划，不是草案） */
interface PlanBundle {
  reply: string;
  rejected: PlanRejection[];
  rawReply: string;
  reasoning: string;
  meta: { model?: string; tokens?: number; reasoningTokens?: number; ms?: number } | null;
  err: string;
  lastApply: string;
  run: PlanRun | null;
}

/**
 * 设计方案通道那一整块的结果（P3：需求级 Proposal）。
 *
 * ── 与 PlanBundle 的同与异 ──
 *   同：最终都编译成 `AiAction[]` → `dryRunPlan`（沙盒）→ 人确认 → `commitPlan`。
 *   异：它**不直接产动作**，先产一个 `DesignProposal`（AI 对需求的理解与规划），
 *       `validateProposal`/`compileProposal` 是**确定性代码**做的"把方案翻成动作"。
 *   关键：`proposal` 本身**从不进正式模型** —— 它只活在会话状态里，
 *   直到 `commitPlan` 把编译出的动作真正写进去。这就是"Proposal 与正式模型分离"。
 *
 *   `openQuestions` 非空时**不允许编译到可执行动作**（compileProposal 会返回 ok:false），
 *   界面也会把"待确认问题"摆在最显眼处 —— 宁可停下来问，不可替用户拍板。
 */
interface DesignBundle {
  proposal: DesignProposal | null;
  /** 这一轮发给模型的原始需求文本 —— 用于"修订"（把上一句作为历史再生成一次） */
  lastText: string;
  reasoning: string;
  meta: { model?: string; tokens?: number; reasoningTokens?: number; ms?: number } | null;
  err: string;
  /** validateProposal 的产出（含 PROPOSAL-* 各码，给出具体数字） */
  issues: Issue[];
  /** 编译器替它定的东西（默认值补齐 / 落位由系统定）—— 必须显示给用户看 */
  notes: string[];
  /** 模型列的"待确认问题" —— 非空就禁止应用到模型 */
  openQuestions: string[];
  run: PlanRun | null;
  lastApply: string;
}

/**
 * 一段会话 = 一个房间的全部工作记录。
 * 三个字段必须**一起**存取：少了哪一个，"回来还是刚才那样"都不成立。
 */
interface Convo {
  chat: Turn[];
  draft: DraftSession | null;
  plan: PlanBundle;
  design: DesignBundle;
  updatedAt: number;
}

const EMPTY_PLAN: PlanBundle = {
  reply: '',
  rejected: [],
  rawReply: '',
  reasoning: '',
  meta: null,
  err: '',
  lastApply: '',
  run: null,
};

const EMPTY_DESIGN: DesignBundle = {
  proposal: null,
  lastText: '',
  reasoning: '',
  meta: null,
  err: '',
  issues: [],
  notes: [],
  openQuestions: [],
  run: null,
  lastApply: '',
};

const emptyConvo = (): Convo => ({ chat: [], draft: null, plan: { ...EMPTY_PLAN }, design: { ...EMPTY_DESIGN }, updatedAt: 0 });

/**
 * 落存储前先把"派生快照"摘掉。
 *
 * 每一轮都留了一份当轮干跑后的完整 project（`run.draft`）。它是**只看一次**的
 * 过程产物（显示这一轮的影响面用），而 Regiment 也一样 —— 一旦整体写进
 * sessionStorage，十轮下来就是十几份完整项目，5MB 的配额很快见底，
 * 而超限的表现是"存不进去还不说"，比丢历史更糟。
 * 摘掉它不影响任何功能：撤回是**从 base 重放**，定稿用的是累积的 steps。
 */
function thinRun(run: PlanRun | null): PlanRun | null {
  if (!run) return null;
  const { draft: _dropDraft, ...rest } = run;
  return { ...rest, steps: run.steps, draft: null as unknown as PlanRun['draft'] };
}

function thinConvo(c: Convo): unknown {
  return {
    chat: c.chat.slice(-CHAT_KEEP),
    plan: { ...c.plan, run: thinRun(c.plan.run) },
    design: { ...c.design, run: thinRun(c.design.run) },
    draft: c.draft
      ? {
          ...c.draft,
          rounds: c.draft.rounds.map((r) => ({ ...r, run: thinRun(r.run) as DraftSession['rounds'][number]['run'] })),
        }
      : null,
    updatedAt: c.updatedAt,
  };
}

function loadConvos(): Record<string, Convo> {
  try {
    const raw = sessionStorage.getItem(CONVO_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, Convo> = {};
    for (const [k, rawConvo] of Object.entries(v as Record<string, unknown>)) {
      const c = rawConvo as Partial<Convo> | null;
      if (!c || typeof c !== 'object') continue;
      out[k] = {
        chat: Array.isArray(c.chat) ? (c.chat as Turn[]) : [],
        // 反序列化出来的 project 失去了类实例；本项目里它们是纯数据，
        // 但如果结构被改坏了，宁可丢掉草案也不让它带着坏数据继续跑
        draft: (c.draft ?? null) as DraftSession | null,
        plan: { ...EMPTY_PLAN, ...(c.plan ?? {}) },
        design: { ...EMPTY_DESIGN, ...(c.design ?? {}) },
        updatedAt: typeof c.updatedAt === 'number' ? c.updatedAt : 0,
      };
    }
    return out;
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用 —— 那就只是不记住，不影响使用 */
    return {};
  }
}

function loadRoomId(): string {
  try {
    return sessionStorage.getItem(ROOM_KEY) ?? '';
  } catch {
    return '';
  }
}

export function AIPanel(props: { bus: CommandBus; version: number; token: string | null; /** 当前选中的柜体 id —— scope:"selection" 的圈选目标 */ selection: string[]; onToast?: (kind: 'ok' | 'info' | 'warn' | 'error', text: string) => void }): ReactNode {
  const { bus, version } = props;
  const [text, setText] = useState('');

  /**
   * 谁在跑。同一个模型通道，**同时只允许一个请求**：
   * 并发发两个不但会让用量账目混乱，还会让用户分不清哪个回答对应哪句话。
   */
  const [busyKind, setBusyKind] = useState<'' | 'chat' | 'plan' | 'draft' | 'design'>('');
  const busy = busyKind !== '';
  /** 已等待秒数 —— 见文件头"为什么有一个计时器" */
  const [waited, setWaited] = useState(0);

  /** 全部会话（按房间 id 存放；'' 这一格是没有选房间时的"全项目"会话） */
  const [convos, setConvos] = useState<Record<string, Convo>>(loadConvos);
  const [roomId, setRoomId] = useState<string>(loadRoomId);
  /** 存不进去要**说一声** —— 默默不存等于骗人说记住了 */
  const [storeErr, setStoreErr] = useState('');

  /**
   * 还剩多少额度。
   *
   * 为什么摆在 AI 面板里：额度是"这次点下去能不能成"的前提，
   * 而"点了之后等 30 秒才被告知额度用完"是最没必要的那种等待。
   * 数字跟着每次调用返回的值更新 —— 不额外拉一次账号信息，
   * 省一次往返，也避免"界面停在旧数字上"这种两头不一致。
   */
  const [quota, setQuota] = useState<QuotaView | null>(null);
  useEffect(() => {
    if (!props.token) {
      setQuota(null);
      return;
    }
    let alive = true;
    void api<{ account?: { quota?: QuotaView } }>('/api/auth/me', { token: props.token }).then((r) => {
      if (alive) setQuota(r.data?.account?.quota ?? null);
    });
    return () => {
      alive = false;
    };
  }, [props.token]);

  const rooms = bus.getState().rooms;
  /** 房间被删掉后 roomId 失效 —— 退回全项目会话，而不是对着空气聊天 */
  const activeRoomId = rooms.some((r) => r.id === roomId) ? roomId : '';
  const activeRoom = rooms.find((r) => r.id === activeRoomId) ?? null;
  const convo: Convo = convos[activeRoomId] ?? emptyConvo();

  const setConvo = useCallback(
    (patch: Partial<Convo>) => {
      setConvos((prev) => {
        const cur = prev[activeRoomId] ?? emptyConvo();
        return { ...prev, [activeRoomId]: { ...cur, ...patch, updatedAt: Date.now() } };
      });
    },
    [activeRoomId],
  );

  // 每次变更都同步回去 —— 面板卸载时没有"保存"的机会，只能随时写
  useEffect(() => {
    try {
      const thin: Record<string, unknown> = {};
      for (const [k, c] of Object.entries(convos)) thin[k] = thinConvo(c);
      sessionStorage.setItem(CONVO_KEY, JSON.stringify(thin));
      sessionStorage.setItem(ROOM_KEY, String(activeRoomId));
      if (storeErr) setStoreErr('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!storeErr) setStoreErr(`会话没能存下来（${msg}）—— 切走再回来会丢`);
    }
  }, [convos, activeRoomId, storeErr]);

  const snapshot: AiSnapshot = useMemo(() => buildSnapshot(bus.getState(), bus.getRules()), [bus, version]);
  const bytes = useMemo(() => snapshotBytes(snapshot), [snapshot]);
  const issues = bus.issues();
  const errCount = issues.filter((i) => i.severity === 'ERROR').length;

  useEffect(() => {
    if (!busy) {
      setWaited(0);
      return;
    }
    const t0 = Date.now();
    setWaited(0);
    const id = setInterval(() => setWaited(Math.floor((Date.now() - t0) / 1000)), 300);
    return () => clearInterval(id);
  }, [busy]);

  /**
   * 模型一被改动，之前那份计划的落点就失效了 —— 必须作废。
   *
   * 但有一个例外：**我们自己刚提交的那一次**。提交会 bump 版本号，
   * 如果一视同仁地作废，人点完「应用全部」看到的是整个预览区立刻消失，
   * 只来得及瞥一眼 toast；回头想核对"到底改了哪几处"就什么都没有了。
   * 所以已提交的计划要留着（它的按钮已因 run.committed 禁用，不会再提交第二次），
   * 一直留到模型**再次**被改动为止。
   *
   * 注意：**对话历史不在这里作废**。对话是"聊过什么"的记录，
   * 它和模型当前长什么样无关 —— 用户改了模型之后回头看刚才问了什么，是正常需求。
   */
  useEffect(() => {
    setConvos((prev) => {
      let touched = false;
      const next: Record<string, Convo> = {};
      for (const [k, c] of Object.entries(prev)) {
        const run = c.plan.run;
        const dRun = c.design.run;
        const planStale = run && !(run.committed && run.committedVersion === version);
        const designStale = dRun && !(dRun.committed && dRun.committedVersion === version);
        if (planStale || designStale) {
          next[k] = {
            ...c,
            plan: planStale ? { ...c.plan, run: null, lastApply: '' } : c.plan,
            design: designStale ? { ...c.design, run: null, lastApply: '' } : c.design,
          };
          touched = true;
        } else {
          next[k] = c;
        }
      }
      return touched ? next : prev;
    });
  }, [version]);

  /**
   * 真模型一被改动，草案的落点同样失效 —— 必须作废（所有房间都一样）。
   *
   * 不作废的话会发生一件很难解释的事：用户在主界面手动拖了一下柜子，
   * 再回来点"定稿"，草案里那批命令是**对着旧模型编译**的，
   * 它们会落到一个已经不存在的状态上。宁可让人重聊，也不能悄悄写错。
   * 恢复出来的旧草案同样适用 —— baseVersion 对不上就是作废，没有例外。
   */
  useEffect(() => {
    setConvos((prev) => {
      let touched = false;
      const next: Record<string, Convo> = {};
      for (const [k, c] of Object.entries(prev)) {
        if (c.draft && c.draft.baseVersion !== version) {
          next[k] = { ...c, draft: null };
          touched = true;
        } else {
          next[k] = c;
        }
      }
      return touched ? next : prev;
    });
  }, [version]);

  const chat = convo.chat;
  const draft = convo.draft;
  const plan = convo.plan;
  const design = convo.design;
  /**
   * 计划这一块要**按增量**改，所以更新必须从最新的 convo 起算 —— 不能用闭包里的。
   *
   * 踩过的坑（浏览器探针 B17 抓出来的，不是理论担忧）：
   * 一次规划请求里会连着改好几下（先写 reply/meta，再写 run 或 err）。
   * 如果按"闭包里的 plan + patch"来写，第二次调用会**带着旧的那份覆盖回去** ——
   * 于是 reply/meta/rejected 全被抹掉，界面上表现为"引用信息没了、
   * 被拒的那几条也不见了"。这种丢信息的 bug 比报错难查得多。
   */
  const setPlan = useCallback(
    (patch: Partial<PlanBundle>) => {
      setConvos((prev) => {
        const cur = prev[activeRoomId] ?? emptyConvo();
        return { ...prev, [activeRoomId]: { ...cur, plan: { ...cur.plan, ...patch }, updatedAt: Date.now() } };
      });
    },
    [activeRoomId],
  );

  const setDesign = useCallback(
    (patch: Partial<DesignBundle>) => {
      setConvos((prev) => {
        const cur = prev[activeRoomId] ?? emptyConvo();
        return { ...prev, [activeRoomId]: { ...cur, design: { ...cur.design, ...patch }, updatedAt: Date.now() } };
      });
    },
    [activeRoomId],
  );

  /** 这一轮发给模型的话要带上"针对哪个房间" —— 一对一会话的前提是模型也知道范围 */
  const scopePrefix = useMemo(() => {
    if (!activeRoom || rooms.length <= 1) return '';
    return `【当前会话只针对房间「${activeRoom.name}」；要新建柜体就建在这个房间里。】`;
  }, [activeRoom, rooms.length]);

  // 新消息进来时滚到底 —— 否则回答出现在视野之外，看起来像"没反应"
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chat.length, busyKind]);

  // ── 对话 ──

  const sendChat = useCallback(async () => {
    const q = text.trim();
    if (!q || busy) return;
    const next: Turn[] = [...chat, { role: 'user', text: q }];
    setConvo({ chat: next });
    setText('');
    setBusyKind('chat');
    try {
      const r = await requestChat({ history: next, snapshot, token: props.token, scope: scopePrefix });
      setConvo({ chat: [...next, r.turn] });
      if (r.quota) setQuota(r.quota);
    } finally {
      setBusyKind('');
    }
  }, [busy, chat, props.token, scopePrefix, setConvo, snapshot, text]);

  const clearChat = useCallback(() => setConvo({ chat: [] }), [setConvo]);

  // ── 计划 ──

  const generatePlan = useCallback(async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusyKind('plan');
    setPlan({ reply: '', rejected: [], rawReply: '', reasoning: '', meta: null, err: '', lastApply: '', run: null });
    try {
      const r = await requestPlan({ text: `${scopePrefix}${q}`, snapshot, token: props.token });
      if (r.quota) setQuota(r.quota);
      setPlan({
        reply: r.reply,
        rejected: r.rejected,
        rawReply: r.raw ?? '',
        reasoning: r.reasoning ?? '',
        meta: { model: r.model, tokens: r.usage?.total_tokens, reasoningTokens: r.usage?.reasoning_tokens, ms: r.ms },
      });
      if (!r.ok) {
        setPlan({ err: r.error ?? '规划失败' });
        props.onToast?.('error', r.error ?? '规划失败');
        return;
      }
      if (r.actions.length === 0) {
        setPlan({ err: '' });
        props.onToast?.('info', 'AI 认为不需要改动模型（它只回了一句话）');
        return;
      }
      // 干跑：拿真总线上的记忆门，跑在沙盒模型上
      const g = compiledRules().gate;
      setPlan({ run: dryRunPlan({ bus, actions: r.actions, gate: g, selection: props.selection }) });
    } finally {
      setBusyKind('');
    }
  }, [bus, busy, props, scopePrefix, setPlan, snapshot, text]);

  const apply = useCallback(() => {
    const run = convo.plan.run;
    if (!run) return;
    const r = commitPlan(run, bus);
    if (!r.ok) {
      setPlan({ lastApply: `✗ ${r.error}` });
      props.onToast?.('error', r.error);
      return;
    }
    const msg = `已应用 ${r.applied} 条（跳过 ${r.skipped} 条）· 模型里还有 ${r.blockingErrors} 条 ERROR`;
    setPlan({ lastApply: msg });
    props.onToast?.(r.blockingErrors > 0 ? 'warn' : 'ok', msg);
  }, [bus, convo.plan.run, props, setPlan]);

  const dismissPlan = useCallback(() => setPlan({ ...EMPTY_PLAN }), [setPlan]);

  // ── 候选对比（P9.6）：只消费运行态，选中仅 UI/session 态 ──
  // ⚠ 红线：comparePlan / selectedCandidateId **绝不**进 project.json、不进 convo 存盘。
  //    selected 用独立前缀的 sessionStorage key（不污染 CONVO_KEY/ROOM_KEY）。
  const [comparePlan, setComparePlan] = useState<PlannerPlan | null>(null);
  const SELECT_KEY = 'p96:selectedCandidate';
  /**
   * 选中态 = `{candidateId, key}`（P9.9 S3）。
   * 旧版只存**位置性 id** ⇒ 重新生成后高亮会**错指**到另一个候选（§9.2 的真实缺陷）。
   * 现在 id 与**内容键**（`candidateKey`）一起存；恢复时经 `resolveSelection` 双重校验，
   * 失配即**清除**（**绝不回退**到"id 相同就认"）。
   */
  const [selectedCandidate, setSelectedCandidate] = useState<StoredCandidateSelection | null>(() => {
    try {
      const raw = sessionStorage.getItem(SELECT_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw) as unknown;
      if (o && typeof o === 'object') {
        const r = o as Record<string, unknown>;
        if (typeof r.candidateId === 'string' && typeof r.key === 'string') {
          return { candidateId: r.candidateId, key: r.key };
        }
      }
      return null;
    } catch {
      return null;
    }
  });
  /** 写 sessionStorage；null = 清除（隐私模式下可能不可用 —— 只是不记住，不影响使用） */
  const persistSelection = useCallback((s: StoredCandidateSelection | null) => {
    try {
      if (s) sessionStorage.setItem(SELECT_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SELECT_KEY);
    } catch {
      /* ignore */
    }
  }, []);
  const selectCandidate = useCallback(
    (id: string) => {
      const c = comparePlan?.candidates.find((x) => x.id === id);
      if (!c) return;
      const s: StoredCandidateSelection = { candidateId: c.id, key: candidateKey(c) };
      setSelectedCandidate(s);
      persistSelection(s);
    },
    [comparePlan, persistSelection],
  );
  const closeCompare = useCallback(() => {
    setComparePlan(null);
    setSelectedCandidate(null);
    persistSelection(null);
  }, [persistSelection]);

  /**
   * 生成候选对比（P9.6 入口）：读当前项目 + 生效设计意图，跑 `planCandidates`
   * （确定性枚举 + 确定性评分），把 `PlannerPlan` 交给 `CandidateComparePanel` 消费。
   * 不调 AI、不改模型、不写盘。
   */
  const generateCompare = useCallback(() => {
    if (busy) return;
    setBusyKind('plan');
    try {
      const entries = currentKnowledge();
      const r = planCandidates(bus.getState(), { scope: 'project' }, entries);
      if (!r.ok) {
        props.onToast?.('warn', r.error ?? '无法生成候选对比');
        setComparePlan({
          request: { scope: 'project' },
          unresolved: [{ reason: r.error ?? '无法生成候选对比' }],
          candidates: [],
          scores: [],
          explanations: [],
        });
        setSelectedCandidate(null); // 没有候选 ⇒ 选中失效并清除
        persistSelection(null);
        return;
      }
      setComparePlan(r.plan);
      // ★ 重新生成 ⇒ 旧选中必须用**新 plan** 复核（id 存在**且**内容键匹配），失配即清除、不回退
      setSelectedCandidate((prev) => {
        const ok = resolveSelection(r.plan, prev);
        persistSelection(ok);
        return ok;
      });
    } finally {
      setBusyKind('');
    }
  }, [bus, busy, props, persistSelection]);

  /**
   * 预览一份候选（§七/§九）：候选的坐标来自 `resolvePlacement`（唯一出口），
   * 这里只把它翻译成既有 UI 授权动作 `cabinet.move` + `cabinet.rotate`，
   * 走 **既有** `dryRunPlan` → `PlanRunView` → `commitPlan` 链路 —— 不建第二条提交路径，
   * 更不调 `core/variants.ts` 的 `adoptVariant`（那是 VariantDraft→Cabinet，语义不同）。
   * 点"应用"才会真正改模型（preview===commit）。
   */
  const previewCandidate = useCallback(
    (candidateId: string) => {
      const plan0 = comparePlan;
      if (!plan0) return;
      const layout = plan0.candidates.find((c) => c.id === candidateId);
      if (!layout || layout.placements.length === 0) return;
      // P9.7：多柜整体候选 → 逐 placement 产动作（一批 dryRun，天然原子）；
      // 单柜候选 placements.length===1，行为与 P9.6 完全一致。
      const state0 = bus.getState();
      const actions: AiAction[] = [];
      for (const p of layout.placements) {
        const cab = state0.cabinets.find((c) => c.id === p.targetId);
        if (!cab) continue; // 候选引用的柜已不存在 —— 该 placement 跳过（dryRun 会如实呈现实际效果）
        if (cab.placement.x !== p.resolved.x || cab.placement.y !== p.resolved.y) {
          actions.push({ action: 'cabinet.move', target: { cabinetId: cab.id }, params: { x: p.resolved.x, y: p.resolved.y }, reason: `预览候选 ${candidateId}`, index: actions.length });
        }
        if (cab.placement.rotation !== p.resolved.rotation) {
          actions.push({ action: 'cabinet.rotate', target: { cabinetId: cab.id }, params: { deg: p.resolved.rotation }, reason: `预览候选 ${candidateId}`, index: actions.length });
        }
      }
      if (actions.length === 0) {
        props.onToast?.('info', '这份候选与当前落位一致，无需改动');
        return;
      }
      const g = compiledRules().gate;
      // 复用 plan 通道的预览/提交：setPlan 后由既有 PlanRunView + apply 接管
      setPlan({ reply: '', rejected: [], rawReply: '', reasoning: '', meta: null, err: '', lastApply: '', run: null });
      setPlan({ run: dryRunPlan({ bus, actions, gate: g, selection: props.selection }) });
    },
    [bus, comparePlan, props, setPlan],
  );

  // ── 设计方案（P3：需求级 Proposal）──

  /**
   * 生成设计方案。
   *
   * 链路：requestDesign → DesignProposal（AI 只出语义）→ validateProposal（确定性校验）
   * → compileProposal（确定性编译成 AiAction[]）→ dryRunPlan（沙盒）→ 预览。
   * 全程不碰真模型：proposal 只存在会话状态里，commitPlan 才是唯一的写入口。
   *
   * 修订：把上一轮的（用户原话 + AI 给的标题/说明）作为 history 再生成一次，
   * 模型就能在原有方案上"加一句"而不用从头来。
   */
  const generateDesign = useCallback(async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusyKind('design');
    setDesign({
      proposal: null,
      lastText: q,
      reasoning: '',
      meta: null,
      err: '',
      issues: [],
      notes: [],
      openQuestions: [],
      run: null,
      lastApply: '',
    });
    try {
      const history: Array<{ role: 'user' | 'assistant'; text: string }> = design?.lastText
        ? [
            { role: 'user', text: design.lastText },
            { role: 'assistant', text: `${design.proposal?.title ?? ''} ${design.proposal?.summary ?? ''}`.trim() },
          ]
        : [];
      const r: DesignResponse = await requestDesign({
        text: `${scopePrefix}${q}`,
        snapshot,
        history: history.slice(-6),
        token: props.token,
        // P6：把适用知识（含冲突警告）作为参考上下文交给 AI —— 产出仍是
        // DesignProposal，仍走同一套校验/干跑/确认，知识不给 AI 任何特权。
        knowledgeDigest: knowledgeDigestOf(resolveKnowledge({ roomName: activeRoom?.name }, currentKnowledge())),
      });
      if (r.quota) setQuota(r.quota);
      if (!r.ok) {
        setDesign({ err: r.error ?? '设计方案生成失败', reasoning: r.reasoning ?? '' });
        props.onToast?.('error', r.error ?? '设计方案生成失败');
        return;
      }
      const p = r.proposal as DesignProposal;
      const project = bus.getState();
      const issues = validateProposal(p, project);
      const compiled = compileProposal(p, project, bus.getRules());
      const patch: Partial<DesignBundle> = {
        proposal: p,
        reasoning: r.reasoning ?? '',
        meta: { model: r.model, tokens: r.usage?.total_tokens, reasoningTokens: r.usage?.reasoning_tokens, ms: r.ms },
        issues,
        notes: compiled.ok ? compiled.notes : [],
        openQuestions: p.questions ?? [],
      };
      if (!compiled.ok) {
        setDesign({ ...patch, err: compiled.blockedReason ?? '这份方案还不能编译成动作' });
        props.onToast?.('warn', compiled.blockedReason ?? '这份方案还不能编译成动作');
        return;
      }
      // 干跑：拿真总线上的记忆门，跑在沙盒模型上 —— 与计划通道同一条纪律
      const g = compiledRules().gate;
      setDesign({ ...patch, run: dryRunPlan({ bus, actions: compiled.actions, gate: g, selection: props.selection }) });
    } finally {
      setBusyKind('');
    }
  }, [bus, busy, design, props, scopePrefix, setDesign, snapshot, text]);

  const applyDesign = useCallback(() => {
    const run = convo.design.run;
    if (!run) return;
    const r = commitPlan(run, bus);
    if (!r.ok) {
      setDesign({ lastApply: `✗ ${r.error}` });
      props.onToast?.('error', r.error);
      return;
    }
    const msg = `已应用 ${r.applied} 条（跳过 ${r.skipped} 条）· 模型里还有 ${r.blockingErrors} 条 ERROR`;
    setDesign({ lastApply: msg });
    props.onToast?.(r.blockingErrors > 0 ? 'warn' : 'ok', msg);
  }, [bus, convo.design.run, props, setDesign]);

  const dismissDesign = useCallback(() => setDesign({ ...EMPTY_DESIGN }), [setDesign]);

  // ── 草案 ──

  /**
   * 向草案追加一轮。
   *
   * 关键在 `draftSnapshot(draft ?? startDraft(bus), …)`：
   * **发给 AI 的是草案当前的样子**，不是真项目。少了这一句，第二轮的
   * "把刚才那个柜子加宽"就没有任何着落 —— AI 看不见自己上一轮建的东西。
   */
  const generateDraft = useCallback(async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusyKind('draft');
    try {
      const session = draft ?? startDraft(bus);
      const snap = draftSnapshot(session, bus.getRules());
      const history = session.rounds.flatMap((r) => [
        { role: 'user' as const, text: r.text },
        { role: 'assistant' as const, text: r.reply },
      ]);
      const r = await requestPlan({ text: `${scopePrefix}${q}`, snapshot: snap, history, token: props.token });
      if (r.quota) setQuota(r.quota);
      if (!r.ok) {
        setConvo({ chat: [...chat, { role: 'user', text: q }, { role: 'assistant', text: '', error: r.error, draftRound: { round: (draft?.rounds.length ?? 0) + 1, merged: false, actions: [], rejected: r.rejected.length, note: '这一轮没有进入草案' } }] });
        props.onToast?.('error', r.error ?? '草案生成失败');
        setText('');
        return;
      }
      if (r.actions.length === 0) {
        // AI 只说话不动手 —— 话要留在会话里（这也是历史的一部分），草案不动
        setConvo({ chat: [...chat, { role: 'user', text: q }, { role: 'assistant', text: r.reply }] });
        props.onToast?.('info', 'AI 认为这一句不需要改动草案（它只回了一句话）');
        setText('');
        return;
      }
      const next = addDraftRound(session, {
        text: q,
        reply: r.reply,
        actions: r.actions,
        rejected: r.rejected,
        rules: bus.getRules(),
        gate: compiledRules().gate,
        selection: props.selection,
      });
      const last = next.rounds[next.rounds.length - 1];
      const failText = last.run.steps
        .filter((s) => !s.ok)
        .map((s) => s.error ?? '')
        .join('；')
        .slice(0, 240);
      setConvo({
        chat: [
          ...chat,
          { role: 'user', text: q },
          {
            role: 'assistant',
            text: r.reply,
            model: r.model,
            usage: r.usage,
            ms: r.ms,
            reasoning: r.reasoning,
            draftRound: {
              round: last.index,
              merged: last.merged,
              actions: last.run.steps.map((s) => s.action.action),
              rejected: last.rejected.length,
              note: last.merged ? '' : failText || '这一步会在 strict 模式下引入新的 ERROR，因此整轮被拒',
            },
          },
        ],
        draft: next,
      });
      setText('');
      if (!last.merged) {
        props.onToast?.('warn', `第 ${last.index} 轮没有并进草案 —— 看会话里那条标红的原因`);
      }
    } finally {
      setBusyKind('');
    }
  }, [bus, busy, chat, draft, props, scopePrefix, setConvo, setText, text]);

  const finalize = useCallback(() => {
    if (!draft) return;
    const r = finalizeDraft(draft, bus);
    if (!r.ok) {
      props.onToast?.('error', r.error);
      return;
    }
    setConvo({ draft: null });
    const msg = `已定稿：写入 ${r.applied} 条${r.skipped > 0 ? `（跳过 ${r.skipped} 条）` : ''} · 模型里还有 ${r.blockingErrors} 条 ERROR`;
    props.onToast?.(r.blockingErrors > 0 ? 'warn' : 'ok', msg);
  }, [bus, draft, props, setConvo]);

  const undoDraft = useCallback(() => {
    if (!draft) return;
    setConvo({
      draft: undoLastRound(draft, { rules: bus.getRules(), gate: compiledRules().gate, selection: props.selection }),
    });
  }, [bus, draft, props, setConvo]);

  const discardDraft = useCallback(() => setConvo({ draft: null }), [setConvo]);

  /**
   * 被契约拒掉的动作 —— 一个 JSX 片段，**成功路径和失败路径都要渲染它**。
   *
   * 踩过的坑：这个块原先只挂在「AI 的说明」那一节里，而只要有任何一条动作被拒，
   * `requestPlan` 就会返回 ok:false → 界面走「失败」那一节 → 这一段永远不渲染。
   * 结果是最该被看到的东西（哪一条被拒、为什么）在最需要它的那条路径上消失了，
   * 屏幕上只剩一句"规划失败"。所以把它提出来，两处共用。
   */
  const rejectedBlock =
    plan.rejected.length > 0 ? (
      <div className="alert alert-warn">
        <b>{plan.rejected.length} 条动作被契约拒绝</b> —— 这几条<b>不会</b>被执行（整份计划都不执行，见上）：
        <ul>
          {plan.rejected.map((r, i) => (
            <li key={i}>
              <Text mono>第 {r.index + 1} 条 · {r.code}</Text> {r.error}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  return (
    /**
     * ⚠ 这一层 `.panel-scroll` 不是装饰，是**必需的**。
     *
     * `.side-right` 是 `display:flex; flex-direction:column`，而 `.panel-scroll`
     * 提供 `flex:1; overflow:auto; min-height:0` —— 三个缺一不可：
     * flex 子项默认 `min-height:auto`，不给 0 就撑高父容器；没有 overflow:auto
     * 就没有滚动条。少了这一层，面板内容一长（这个面板有对话 + 干跑预览 + 词汇表）
     * 就会**溢出到面板外面、永远滚不到** —— 而屏幕上看起来只是"内容被截断了"。
     *
     * 这个缺陷是靠浏览器探针里那条"右侧面板必须有滚动容器"的结构断言抓出来的：
     * 当时 AI 面板与账号面板都漏了这一层，而所有只看文本内容的断言都读到了空字符串，
     * 一度被误判成"面板没渲染"。
     */
    <div className="panel-scroll">
      {storeErr ? <div className="alert alert-warn">{storeErr}</div> : null}

      {/* ═══════════════ 会话对象：一个房间一段 ═══════════════ */}
      <Section title="会话对象（一个房间一段历史）" defaultOpen>
        <p className="note">
          每个房间有一段<b>各自独立</b>的会话和草案：聊"这个柜子再高一档"时，
          指代的是这个房间的柜子。切换页面、切换房间都不会丢 ——
          <b>连草案一起记住</b>（跑一次要几十秒，不该白等）。
        </p>
        <div className="chips room-chips">
          <button type="button" className={`chip ${activeRoomId === '' ? 'chip-on' : ''}`} onClick={() => setRoomId('')}>
            全项目{convos['']?.chat?.length ? ` · ${convos[''].chat.length} 条` : ''}
          </button>
          {rooms.map((r, i) => {
            const c = convos[r.id];
            const n = c?.chat?.length ?? 0;
            const rounds = c?.draft?.rounds.length ?? 0;
            return (
              <button
                key={r.id}
                type="button"
                className={`chip ${activeRoomId === r.id ? 'chip-on' : ''}`}
                onClick={() => setRoomId(r.id)}
                title={`房间 ${i + 1} · ${r.walls.length} 面墙`}
              >
                {r.name}
                {n ? ` · ${n} 条` : ''}
                {rounds ? ` · 草案 ${rounds} 轮` : ''}
              </button>
            );
          })}
          {rooms.length === 0 ? <span className="muted-sm">还没有房间 —— 先在「房间」页建一个，AI 才能把柜体放进去。</span> : null}
        </div>
      </Section>

      {/* ═══════════════ 草案：随每一句话更新，定稿才写入 ═══════════════ */}
      {draft ? (
        <Section
          title={`草案 · ${activeRoom ? activeRoom.name : '全项目'}（${draft.rounds.length} 轮 · ${draft.steps.length} 步待定稿）`}
          defaultOpen
        >
          <p className="note">
            下面是<b>草案当前的样子</b>（正面图）：每一句都叠在上一句的结果上，AI 也看得见。
            在下面点<b>「定稿并生成可编辑稿件」</b>之前，<b>真模型一个字节都没动</b>。
          </p>

          {draft.rounds.length > 0 && !draft.rounds[draft.rounds.length - 1].merged ? (
            <div className="alert alert-warn">
              第 {draft.rounds[draft.rounds.length - 1].index} 轮<b>没有被并入草案</b> —— 草案停在上一轮的样子。
              原因写在下面那一轮的卡片里。
            </div>
          ) : null}

          <DraftPreview
            project={draft.project}
            rules={bus.getRules()}
            roomId={activeRoomId || undefined}
            roomLabel={activeRoom?.name}
          />

          <div className="btn-row">
            <button
              type="button"
              className="tb-btn primary ai-btn-finalize"
              disabled={busy || draft.steps.length === 0}
              onClick={finalize}
            >
              定稿并生成可编辑稿件
            </button>
            <button type="button" className="tb-btn" disabled={busy || draft.rounds.length === 0} onClick={undoDraft}>
              撤回上一轮
            </button>
            <button type="button" className="tb-btn" disabled={busy} onClick={discardDraft}>
              放弃草案
            </button>
          </div>
          {draft.steps.length === 0 ? (
            <div className="hint-line">草案里还没有能提交的步骤 —— 前面几轮要么失败了，要么 AI 只回了话。</div>
          ) : null}
        </Section>
      ) : null}

      {/* ═══════════════ 对话：问与改，历史都在 ═══════════════ */}
      <Section title="AI 对话（不会改模型）" defaultOpen>
        <p className="note">
          这里只是<b>问与答</b>：可以问尺寸、板材、五金、工艺，也可以问当前这个柜子。
          想让 AI 改模型，请用下面的<b>「生成编辑计划」</b>或<b>「改草案」</b>——
          两条路都会先给你预览，<b>你点确认了才会写进去</b>。
        </p>

        {/*
          ── 剩余额度就摆在输入框上方 ──
          额度是"这一句能不能生成"的前提。摆在别处（比如账号页）的后果是：
          用户打完一句话、等 30 秒、才被告知额度用完 —— 那 30 秒纯粹是白等。
          local-open（还没建账号）时服务端不给额度，这里就什么都不显示：
          如实说"当前没有额度限制"比摆一个假的 0/0 好。
        */}
        {quota ? <QuotaMeter quota={quota} compact /> : null}

        {chat.length > 0 ? (
          <div className="chat-list">
            {chat.map((m, i) => (
              <div key={i} className={`chat-msg chat-${m.role}`}>
                <div className="chat-role">{m.role === 'user' ? '你' : 'AI'}</div>
                <div className="chat-body">
                  {m.text ? <div className="chat-text">{m.text}</div> : null}
                  {/* 正文为空时显示**可操作**的原因，而不是留一个空白框 */}
                  {!m.text && m.emptyReason ? <div className="chat-empty">{m.emptyReason}</div> : null}
                  {m.error ? <div className="chat-error">{m.error}</div> : null}
                  {/* 这一轮有没有真的改到草案 —— "AI 说了但没动"必须当场看得出来 */}
                  {m.draftRound ? (
                    <div className={`chat-round ${m.draftRound.merged ? 'chat-round-ok' : 'chat-round-bad'}`}>
                      <Pill kind={m.draftRound.merged ? 'ok' : 'WARNING'}>
                        第 {m.draftRound.round} 轮 · {m.draftRound.merged ? '已并入草案' : '未并入草案'}
                      </Pill>
                      {m.draftRound.actions.length > 0 ? (
                        <span className="mono">{m.draftRound.actions.join('、')}</span>
                      ) : (
                        <span className="muted-sm">没有给出动作</span>
                      )}
                      {m.draftRound.rejected > 0 ? <span className="draft-err">被契约拒 {m.draftRound.rejected} 条</span> : null}
                      {m.draftRound.note ? <div className="chat-round-note">{m.draftRound.note}</div> : null}
                    </div>
                  ) : null}
                  {m.role === 'assistant' && (m.model || m.usage || m.ms !== undefined) ? (
                    <div className="chat-meta">
                      <Text mono>
                        {m.model ?? '未知模型'}
                        {m.usage?.total_tokens !== undefined ? ` · ${m.usage.total_tokens} token` : ''}
                        {m.usage?.reasoning_tokens ? `（其中推理 ${m.usage.reasoning_tokens}）` : ''}
                        {m.ms !== undefined ? ` · ${(m.ms / 1000).toFixed(1)}s` : ''}
                      </Text>
                    </div>
                  ) : null}
                  {/*
                    思考过程默认折叠。它不是回答，所以不该占据视线；
                    但它是"为什么慢"和"为什么回答是空的"的唯一解释，所以不许丢。
                  */}
                  {m.reasoning ? (
                    <details className="chat-think">
                      <summary>
                        模型的思考过程（{m.reasoning.length} 字
                        {m.usage?.reasoning_tokens ? ` · ${m.usage.reasoning_tokens} token` : ''}）
                      </summary>
                      <pre className="code">{m.reasoning}</pre>
                    </details>
                  ) : null}
                </div>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>
        ) : (
          <p className="muted-sm">
            还没有对话。可以试：
            {CHAT_STARTERS.map((s) => `「${s}」`).join('')}
          </p>
        )}

        {/*
          ── 输入框与两个按钮就放在对话区里，不另开一个分区 ──
          原因很实际：`Section` 折叠时**整块不渲染**，把输入框放进一个默认折叠的分区，
          等于用户打开 AI 页签时看不到主入口（而我第一版就是那么写的）。
          输入框必须在打开面板的第一眼就在视野里。
        */}
        <textarea
          className="input ai-input"
          rows={3}
          placeholder="例：把主卧衣柜改成 2400 高，挂衣区层板改成 3 块 —— 或直接问一个问题"
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              // Ctrl+Enter = 对话（轻量的那个）；加 Shift 才是生成计划 —— 改模型要多按一个键
              if (e.shiftKey) void generatePlan();
              else void sendChat();
            }
          }}
        />
        <div className="btn-row">
          <button
            type="button"
            className="tb-btn ai-btn-chat"
            disabled={busy || !text.trim()}
            onClick={() => void sendChat()}
            title="问与答。不会修改模型。"
          >
            {busyKind === 'chat' ? `AI 正在思考… ${waited}s` : '对话（不改模型）'}
          </button>
          <button
            type="button"
            className="tb-btn primary ai-btn-plan"
            disabled={busy || !text.trim() || !!quota?.blockedBy}
            onClick={() => void generatePlan()}
            title={
              quota?.blockedBy
                ? `额度已用完，不能生成：${quota.blockReason}`
                : '生成动作清单并干跑预览。在你点「应用」之前不会修改模型。'
            }
          >
            {busyKind === 'plan' ? `规划中… ${waited}s` : '生成编辑计划'}
          </button>
          <button
            type="button"
            className="tb-btn primary ai-btn-draft"
            disabled={busy || !text.trim() || !!quota?.blockedBy}
            onClick={() => void generateDraft()}
            title={
              quota?.blockedBy
                ? `额度已用完，不能生成：${quota.blockReason}`
                : '把这一句叠到草案上：AI 看得见之前几轮的结果，可以一句一句改到满意，最后再定稿。'
            }
          >
            {busyKind === 'draft' ? `改草案中… ${waited}s` : draft ? '继续改草案' : '改草案（多轮）'}
          </button>
          <button
            type="button"
            className="tb-btn primary ai-btn-design"
            disabled={busy || !text.trim() || !!quota?.blockedBy}
            onClick={() => void generateDesign()}
            title={
              quota?.blockedBy
                ? `额度已用完，不能生成：${quota.blockReason}`
                : '先用自然语言描述需求，AI 给出一个可确认的设计方案（柜体结构 / 组合 / 假设 / 待确认问题），确认后才写进模型。'
            }
          >
            {busyKind === 'design' ? `设计方案生成中… ${waited}s` : design?.proposal ? '重新设计方案' : '设计方案'}
          </button>
          <button
            type="button"
            className="tb-btn"
            disabled={busy || rooms.length === 0}
            onClick={() => void generateCompare()}
            title="对当前生效的设计意图做确定性候选枚举 + 评分，并排对比（不调 AI、不改模型）。选哪份由你拍板。"
          >
            {busyKind === 'plan' ? `枚举中… ${waited}s` : '规划候选对比'}
          </button>
          <button type="button" className="tb-btn" disabled={busy || chat.length === 0} onClick={clearChat}>
            清空对话
          </button>
        </div>
        <div className="muted-sm">
          Ctrl+Enter 对话 · Ctrl+Shift+Enter 生成计划
          {busy ? <span className="ai-waiting">　·　已等待 {waited} 秒（推理模型单次可能要十几到几十秒）</span> : null}
        </div>
        <div className="chips">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" className="chip" disabled={busy} onClick={() => setText(e)}>
              {e}
            </button>
          ))}
        </div>
        <Row label="发给模型的项目快照" derived hint="只有语义参数（宽高深/分区/材质），没有任何板件与几何。对话与规划都会带上它">
          <Text mono>
            {snapshot.cabinets.length} 个柜体 · {snapshot.rooms.length} 个房间 · {(bytes / 1024).toFixed(1)} KB
          </Text>
        </Row>
        {plan.meta ? (
          <Row label="本次调用" derived hint="规划通道的用量。对话的用量显示在每条回答下面">
            <Text mono>
              {plan.meta.model ?? '(未知模型)'}
              {plan.meta.tokens !== undefined ? ` · ${plan.meta.tokens} token` : ' · 服务商未返回用量'}
              {plan.meta.reasoningTokens ? `（其中推理 ${plan.meta.reasoningTokens}）` : ''}
              {plan.meta.ms !== undefined ? ` · ${(plan.meta.ms / 1000).toFixed(1)}s` : ''}
            </Text>
          </Row>
        ) : null}
      </Section>

      {/* ═══════════════ 计划：失败 / 说明 / 干跑预览 ═══════════════ */}
      {plan.err ? (
        <Section title="失败" defaultOpen>
          <div className="alert alert-error">{plan.err}</div>
          {rejectedBlock}
          {plan.reply ? <p className="note">AI 的说明：{plan.reply}</p> : null}
          {plan.rawReply ? (
            <details>
              <summary>模型原始回复（截断）</summary>
              <pre className="code">{plan.rawReply}</pre>
            </details>
          ) : null}
          {plan.reasoning ? (
            <details>
              <summary>模型的思考过程（{plan.reasoning.length} 字）</summary>
              <pre className="code">{plan.reasoning}</pre>
            </details>
          ) : null}
        </Section>
      ) : null}

      {plan.reply && !plan.err ? (
        <Section title="AI 的说明" defaultOpen>
          <p className="note">{plan.reply}</p>
          {rejectedBlock}
        </Section>
      ) : null}

      {plan.run ? (
        <Section title={`干跑预览（${plan.run.okCount} 条可应用 / ${plan.run.errorCount} 条失败）`} defaultOpen>
          <PlanRunView run={plan.run} onApply={apply} onDismiss={dismissPlan} lastApply={plan.lastApply} />
        </Section>
      ) : null}

      {/* ═══════════════ 候选对比（P9.6）：纯消费运行态，手动选，不造 winner ═══════════════ */}
      {comparePlan ? (
        <Section title="候选方案对比（确定性枚举 + 评分，你选一份）" defaultOpen>
          <CandidateComparePanel
            plan={comparePlan}
            project={bus.getState()}
            selectedCandidateId={selectedCandidate?.candidateId ?? null}
            onSelect={selectCandidate}
            onPreview={previewCandidate}
            onClose={closeCompare}
          />
        </Section>
      ) : null}

      {/* ═══════════════ 设计方案（P3：需求级 Proposal → 预览 → 确认）══════════════ */}
      {design.proposal || design.err ? (
        <Section
          title={design.proposal ? `设计方案 · ${design.proposal.title}` : '设计方案（生成失败）'}
          defaultOpen
        >
          <p className="note">
            下面是 <b>AI 理解出来的设计方案</b>，<b>还没写进模型</b>。结构、假设、待确认问题都摊在这里；
            你点「应用全部」之前，真模型一个字节都没动。有<b>待确认问题</b>的方案不能应用 —— 必须先回答。
          </p>

          {/* 待确认问题：最显眼，且直接阻断应用 */}
          {design.openQuestions.length > 0 ? (
            <div className="alert alert-warn">
              <b>{design.openQuestions.length} 个待确认问题（不回答不能应用）</b>
              <ul>
                {design.openQuestions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
              <div className="muted-sm">在上面的输入框里把答案补全后，重新点「设计方案」即可。</div>
            </div>
          ) : null}

          {/* 语义校验：PROPOSAL-* 各码，给得出具体数字 */}
          {design.issues.length > 0 ? (
            <div className={design.issues.some((i) => i.severity === 'ERROR') ? 'alert alert-error' : 'alert alert-warn'}>
              <b>方案校验：{design.issues.filter((i) => i.severity === 'ERROR').length} 处错误 / {design.issues.filter((i) => i.severity !== 'ERROR').length} 处提示</b>
              <ul>
                {design.issues.map((i, j) => (
                  <li key={j}>
                    <Pill kind={i.severity === 'ERROR' ? 'ERROR' : i.severity === 'WARNING' ? 'WARNING' : 'INFO'}>{i.severity}</Pill>{' '}
                    <Text mono>{i.code}</Text> {i.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 假设与系统补齐的默认值：必须显示，否则"悄悄替你定了"等于骗人 */}
          {design.proposal?.assumptions && design.proposal.assumptions.length > 0 ? (
            <div className="hint-line">
              <b>AI 的假设：</b>
              <ul>
                {design.proposal.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {design.notes.length > 0 ? (
            <div className="hint-line">
              <b>系统替你定的（默认值 / 落位由系统定）：</b>
              <ul>
                {design.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {design.proposal?.summary ? <p className="note">方案说明：{design.proposal.summary}</p> : null}

          {design.reasoning ? (
            <details>
              <summary>模型的思考过程（{design.reasoning.length} 字）</summary>
              <pre className="code">{design.reasoning}</pre>
            </details>
          ) : null}

          {design.err ? (
            <div className="alert alert-error">{design.err}</div>
          ) : design.run ? (
            <PlanRunView
              run={design.run}
              onApply={applyDesign}
              onDismiss={dismissDesign}
              lastApply={design.lastApply}
              applyLabel="应用设计方案"
              dismissLabel="丢弃方案"
            />
          ) : null}

          {design.meta ? (
            <Row label="本次调用" derived hint="设计方案通道的用量">
              <Text mono>
                {design.meta.model ?? '(未知模型)'}
                {design.meta.tokens !== undefined ? ` · ${design.meta.tokens} token` : ' · 服务商未返回用量'}
                {design.meta.reasoningTokens ? `（其中推理 ${design.meta.reasoningTokens}）` : ''}
                {design.meta.ms !== undefined ? ` · ${(design.meta.ms / 1000).toFixed(1)}s` : ''}
              </Text>
            </Row>
          ) : null}

          {design.run && design.openQuestions.length > 0 ? (
            <div className="alert alert-warn">有 {design.openQuestions.length} 个待确认问题，应用按钮已禁用 —— 回答后再重新生成方案。</div>
          ) : null}
        </Section>
      ) : null}

      {/* 标题里的数量取自契约本身 —— 不手写，"契约加了一个动作、界面还说 18 个"这种事不该发生 */}
      <Section title={`AI 能做什么（契约词汇表 · ${ACTION_NAMES.length} 个动作）`} defaultOpen={false}>
        <p className="note">
          这张表就是 AI 的全部权限。它不在代码里写死，而是 <Text mono>shared/aiContract.mjs</Text> ——
          服务端、前端编译器、验收脚本三方读同一份，改一处三方同时生效。
          AI <b>不产出几何</b>，唯一能做的写入路径是"选一个动作 + 填参数"，
          再走和鼠标操作完全相同的那条写入路径。
        </p>
        <ul className="action-list">
          {Object.entries(ACTIONS).map(([name, spec]) => (
            <li key={name}>
              <Text mono>{name}</Text> —— {spec.label}
              {(spec as { dangerous?: boolean }).dangerous ? <Pill kind="WARNING">破坏性</Pill> : null}
            </li>
          ))}
        </ul>
        <Row label="当前模型 ERROR 数" derived>
          {errCount > 0 ? <Pill kind="ERROR">{errCount}</Pill> : <Pill kind="ok">0</Pill>}
        </Row>
      </Section>
    </div>
  );
}
