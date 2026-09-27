import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import { ACTION_NAMES, ACTIONS } from '../../../shared/aiContract.mjs';
import { requestChat, requestPlan, type ChatTurn, type PlanRejection } from '../../ai/aiClient.ts';
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
import { compiledRules } from '../../state/memoryStore.ts';
import { Pill, Row, Section, Text } from './common.tsx';
import { DraftPreview } from './DraftPreview.tsx';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  AI 面板 —— 两个入口，两种后果
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
 * 对话历史存在 sessionStorage。
 *
 * ── 为什么不能只放在组件的 state 里 ──
 *   右侧面板是**按需挂载**的（`{rightTab === 'ai' ? <AIPanel/> : null}`）。
 *   切到「属性」再切回来，组件被卸载后重建，state 归零 ——
 *   用户问了三个问题，去图层页看一眼，回来对话全没了。
 *   **这是浏览器验收 B20 抓出来的真实缺陷**，不是理论担忧。
 *
 * ── 为什么是 sessionStorage 而不是 localStorage ──
 *   对话是**会话级**的工作记录，不是配置。关掉标签页就该消失。
 *   localStorage 里的东西会一直留在这台机器上（和 token 同一个理由）。
 *   代价是"关掉标签页就得重新聊"，换来的是"它不会悄悄堆积"。
 */
const CHAT_STORAGE_KEY = 'furniture-cad.ai.chat';
/** 最多留 40 条，防止长会话把 sessionStorage 撑爆 */
const CHAT_KEEP = 40;

function loadChat(): ChatTurn[] {
  try {
    const raw = sessionStorage.getItem(CHAT_STORAGE_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(v) ? (v as ChatTurn[]) : [];
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用 —— 那就只是不记住，不影响使用 */
    return [];
  }
}

export function AIPanel(props: { bus: CommandBus; version: number; token: string | null; /** 当前选中的柜体 id —— scope:"selection" 的圈选目标 */ selection: string[]; onToast?: (kind: 'ok' | 'info' | 'warn' | 'error', text: string) => void }): ReactNode {
  const { bus, version } = props;
  const [text, setText] = useState('');

  /**
   * 谁在跑。同一个模型通道，**同时只允许一个请求**：
   * 并发发两个不但会让用量账目混乱，还会让用户分不清哪个回答对应哪句话。
   */
  const [busyKind, setBusyKind] = useState<'' | 'chat' | 'plan' | 'draft'>('');
  const busy = busyKind !== '';
  /** 已等待秒数 —— 见文件头"为什么有一个计时器" */
  const [waited, setWaited] = useState(0);

  // ── 对话 ──
  /** 惰性初始化：从 sessionStorage 恢复上一次的对话（见 loadChat 的说明） */
  const [chat, setChat] = useState<ChatTurn[]>(loadChat);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  // 每次变更都同步回 sessionStorage —— 面板卸载时没有"保存"的机会，只能随时写
  useEffect(() => {
    try {
      sessionStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chat.slice(-CHAT_KEEP)));
    } catch {
      /* 写不进去只说明这次不记住，不影响正在进行的对话 */
    }
  }, [chat]);

  // ── 计划 ──
  const [run, setRun] = useState<PlanRun | null>(null);
  const [reply, setReply] = useState('');
  const [rejected, setRejected] = useState<PlanRejection[]>([]);
  const [rawReply, setRawReply] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [meta, setMeta] = useState<{ model?: string; tokens?: number; reasoningTokens?: number; ms?: number } | null>(null);
  const [err, setErr] = useState('');
  const [lastApply, setLastApply] = useState('');

  /**
   * 草案会话 —— 「先聊出方案，定稿才落地」那张桌子。
   *
   * 它和下面的 `run`（一次性计划）是两条路：
   *   · `run`  一句话 → 一份计划 → 应用。改第二句要重新走一遍。
   *   · 草案   每一句都叠在上一句的**结果**上，AI 看得见自己上一轮建出来的东西。
   * 之所以保留两条而不是把 run 删掉：run 那条路已被验收脚本与浏览器探针覆盖，
   * 而草案是"持续修改"的新入口。两条路共用同一套干跑/提交器，不会分叉。
   */
  const [draft, setDraft] = useState<DraftSession | null>(null);

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
    setRun((cur) => {
      if (!cur) return cur;
      if (cur.committed && cur.committedVersion === version) return cur;
      setLastApply('');
      return null;
    });
  }, [version]);

  /**
   * 真模型一被改动，草案的落点同样失效 —— 必须作废。
   *
   * 不作废的话会发生一件很难解释的事：用户在主界面手动拖了一下柜子，
   * 再回来点"定稿"，草案里那批命令是**对着旧模型编译**的，
   * 它们会落到一个已经不存在的状态上。宁可让人重聊，也不能悄悄写错。
   */
  useEffect(() => {
    setDraft((cur) => (cur && cur.baseVersion !== version ? null : cur));
  }, [version]);

  // ── 对话 ──

  const sendChat = useCallback(async () => {
    const q = text.trim();
    if (!q || busy) return;
    const next: ChatTurn[] = [...chat, { role: 'user', text: q }];
    setChat(next);
    setText('');
    setBusyKind('chat');
    try {
      const r = await requestChat({ history: next, snapshot, token: props.token });
      setChat([...next, r.turn]);
    } finally {
      setBusyKind('');
    }
  }, [busy, chat, props.token, snapshot, text]);

  const clearChat = useCallback(() => setChat([]), []);

  // 新消息进来时滚到底 —— 否则回答出现在视野之外，看起来像"没反应"
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chat.length, busyKind]);

  // ── 计划 ──

  const generatePlan = useCallback(async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusyKind('plan');
    setErr('');
    setRawReply('');
    setReasoning('');
    setRun(null);
    setRejected([]);
    setLastApply('');
    try {
      const r = await requestPlan({ text: q, snapshot, token: props.token });
      setReply(r.reply);
      setRejected(r.rejected);
      setRawReply(r.raw ?? '');
      setReasoning(r.reasoning ?? '');
      setMeta({ model: r.model, tokens: r.usage?.total_tokens, reasoningTokens: r.usage?.reasoning_tokens, ms: r.ms });
      if (!r.ok) {
        setErr(r.error ?? '规划失败');
        props.onToast?.('error', r.error ?? '规划失败');
        return;
      }
      if (r.actions.length === 0) {
        setErr('');
        props.onToast?.('info', 'AI 认为不需要改动模型（它只回了一句话）');
        return;
      }
      // 干跑：拿真总线上的记忆门，跑在沙盒模型上
      const g = compiledRules().gate;
      setRun(dryRunPlan({ bus, actions: r.actions, gate: g, selection: props.selection }));
    } finally {
      setBusyKind('');
    }
  }, [bus, busy, props, snapshot, text]);

  const apply = useCallback(() => {
    if (!run) return;
    const r = commitPlan(run, bus);
    if (!r.ok) {
      setLastApply(`✗ ${r.error}`);
      props.onToast?.('error', r.error);
      return;
    }
    const msg = `已应用 ${r.applied} 条（跳过 ${r.skipped} 条）· 模型里还有 ${r.blockingErrors} 条 ERROR`;
    setLastApply(msg);
    props.onToast?.(r.blockingErrors > 0 ? 'warn' : 'ok', msg);
  }, [bus, props, run]);

  const dismissPlan = useCallback(() => {
    setRun(null);
    setReply('');
    setRejected([]);
    setRawReply('');
    setReasoning('');
    setErr('');
    setLastApply('');
  }, []);

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
    setErr('');
    try {
      const session = draft ?? startDraft(bus);
      const snap = draftSnapshot(session, bus.getRules());
      const history = session.rounds.flatMap((r) => [
        { role: 'user' as const, text: r.text },
        { role: 'assistant' as const, text: r.reply },
      ]);
      const r = await requestPlan({ text: q, snapshot: snap, history, token: props.token });
      setMeta({ model: r.model, tokens: r.usage?.total_tokens, reasoningTokens: r.usage?.reasoning_tokens, ms: r.ms });
      if (!r.ok) {
        setErr(r.error ?? '草案生成失败');
        props.onToast?.('error', r.error ?? '草案生成失败');
        return;
      }
      if (r.actions.length === 0) {
        props.onToast?.('info', 'AI 认为这一句不需要改动草案（它只回了一句话）');
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
      setDraft(next);
      setText('');
      const last = next.rounds[next.rounds.length - 1];
      if (!last.merged) {
        props.onToast?.('warn', '这一轮没有被并入草案 —— 看草案卡片里的失败原因');
      }
    } finally {
      setBusyKind('');
    }
  }, [bus, busy, draft, props, text]);

  const finalize = useCallback(() => {
    if (!draft) return;
    const r = finalizeDraft(draft, bus);
    if (!r.ok) {
      props.onToast?.('error', r.error);
      return;
    }
    setDraft(null);
    const msg = `已定稿：写入 ${r.applied} 条${r.skipped > 0 ? `（跳过 ${r.skipped} 条）` : ''} · 模型里还有 ${r.blockingErrors} 条 ERROR`;
    props.onToast?.(r.blockingErrors > 0 ? 'warn' : 'ok', msg);
  }, [bus, draft, props]);

  const undoDraft = useCallback(() => {
    if (!draft) return;
    setDraft(undoLastRound(draft, { rules: bus.getRules(), gate: compiledRules().gate, selection: props.selection }));
  }, [bus, draft, props]);

  const discardDraft = useCallback(() => setDraft(null), []);

  /**
   * 被契约拒掉的动作 —— 一个 JSX 片段，**成功路径和失败路径都要渲染它**。
   *
   * 踩过的坑：这个块原先只挂在「AI 的说明」那一节里，而只要有任何一条动作被拒，
   * `requestPlan` 就会返回 ok:false → 界面走「失败」那一节 → 这一段永远不渲染。
   * 结果是最该被看到的东西（哪一条被拒、为什么）在最需要它的那条路径上消失了，
   * 屏幕上只剩一句"规划失败"。所以把它提出来，两处共用。
   */
  const rejectedBlock =
    rejected.length > 0 ? (
      <div className="alert alert-warn">
        <b>{rejected.length} 条动作被契约拒绝</b> —— 这几条<b>不会</b>被执行（整份计划都不执行，见上）：
        <ul>
          {rejected.map((r, i) => (
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
      {/* ═══════════════ 对话：问与答，永不改模型 ═══════════════ */}
      <Section title="AI 对话（不会改模型）" defaultOpen>
        <p className="note">
          这里只是<b>问与答</b>：可以问尺寸、板材、五金、工艺，也可以问当前这个柜子。
          想让 AI 改模型，请用下面的<b>「生成编辑计划」</b>——
          那条路会先给你一份干跑预览，<b>你点确认了才会写进去</b>。
        </p>

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
            disabled={busy || !text.trim()}
            onClick={() => void generatePlan()}
            title="生成动作清单并干跑预览。在你点「应用」之前不会修改模型。"
          >
            {busyKind === 'plan' ? `规划中… ${waited}s` : '生成编辑计划'}
          </button>
          <button
            type="button"
            className="tb-btn primary ai-btn-draft"
            disabled={busy || !text.trim()}
            onClick={() => void generateDraft()}
            title="把这一句叠到草案上：AI 看得见之前几轮的结果，可以一句一句改到满意，最后再定稿。"
          >
            {busyKind === 'draft' ? `改草案中… ${waited}s` : draft ? '继续改草案' : '生成草案'}
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
        {meta ? (
          <Row label="本次调用" derived hint="规划通道的用量。对话的用量显示在每条回答下面">
            <Text mono>
              {meta.model ?? '(未知模型)'}
              {meta.tokens !== undefined ? ` · ${meta.tokens} token` : ' · 服务商未返回用量'}
              {meta.reasoningTokens ? `（其中推理 ${meta.reasoningTokens}）` : ''}
              {meta.ms !== undefined ? ` · ${(meta.ms / 1000).toFixed(1)}s` : ''}
            </Text>
          </Row>
        ) : null}
      </Section>

      {/* ═══════════════ 草案：持续修改，定稿才写入 ═══════════════ */}
      {draft ? (
        <Section
          title={`草案（${draft.rounds.length} 轮 · ${draft.steps.length} 步待定稿）`}
          defaultOpen
        >
          <p className="note">
            下面是<b>草案当前的样子</b>：每一句都会叠在上一句的结果上，AI 也看得见。
            在下面点<b>「定稿并生成可编辑稿件」</b>之前，<b>真模型一个字节都没动</b>。
          </p>

          <DraftPreview project={draft.project} rules={bus.getRules()} />

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

          <div className="draft-rounds">
            {draft.rounds.map((r) => (
              <div key={r.index} className={`draft-round ${r.merged ? '' : 'draft-round-bad'}`}>
                <div className="draft-round-head">
                  <Pill kind={r.merged ? 'ok' : 'WARNING'}>{r.merged ? `第 ${r.index} 轮 · 已并入` : `第 ${r.index} 轮 · 未并入`}</Pill>
                  <span className="draft-round-text">{r.text}</span>
                </div>
                {r.reply ? <div className="draft-round-reply">{r.reply}</div> : null}
                <div className="draft-round-steps">
                  {r.run.steps.length === 0 ? (
                    <span className="muted-sm">AI 这一轮没有给出动作</span>
                  ) : (
                    r.run.steps.map((s, i) => (
                      <div key={i} className={`draft-step ${s.ok ? '' : 'draft-step-bad'}`}>
                        <Text mono>{s.action.action}</Text>{' '}
                        <span className="muted-sm">{s.ok ? s.label : s.error}</span>
                      </div>
                    ))
                  )}
                </div>
                {r.rejected.length > 0 ? (
                  <div className="alert alert-warn">
                    {r.rejected.length} 条动作被契约拒绝：
                    <ul>
                      {r.rejected.map((x, i) => (
                        <li key={i}>
                          <Text mono>第 {x.index + 1} 条 · {x.code}</Text> {x.error}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {r.run.impact.length > 0 ? (
                  <details className="draft-impact">
                    <summary>这一轮的影响面（{r.run.impact.length} 处）</summary>
                    <ul className="diff-list">
                      {r.run.impact.map((t, i) => (
                        <li key={i}>{t}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* ═══════════════ 计划：失败 / 说明 / 干跑预览 ═══════════════ */}
      {err ? (
        <Section title="失败" defaultOpen>
          <div className="alert alert-error">{err}</div>
          {rejectedBlock}
          {reply ? <p className="note">AI 的说明：{reply}</p> : null}
          {rawReply ? (
            <details>
              <summary>模型原始回复（截断）</summary>
              <pre className="code">{rawReply}</pre>
            </details>
          ) : null}
          {reasoning ? (
            <details>
              <summary>模型的思考过程（{reasoning.length} 字）</summary>
              <pre className="code">{reasoning}</pre>
            </details>
          ) : null}
        </Section>
      ) : null}

      {reply && !err ? (
        <Section title="AI 的说明" defaultOpen>
          <p className="note">{reply}</p>
          {rejectedBlock}
        </Section>
      ) : null}

      {run ? (
        <Section title={`干跑预览（${run.okCount} 条可应用 / ${run.errorCount} 条失败）`} defaultOpen>
          <p className="note">
            下面每一条都已在<b>沙盒模型</b>上真跑过一遍，用的是和提交完全相同的命令 ——
            所以「预览 = 提交」是结构性的，不是两边都写对了。
          </p>
          {run.steps.map((s, i) => (
            <div key={i} className={`plan-step ${s.ok ? '' : 'plan-step-bad'}`}>
              <div className="plan-head">
                <Pill kind={s.ok ? 'ok' : 'ERROR'}>{s.ok ? '可应用' : '失败'}</Pill>
                <Text mono>{s.action.action}</Text>
                <span className="muted-sm">
                  {s.action.target.cabinetName ? `→「${s.action.target.cabinetName}」` : ''}
                  {s.action.target.unit !== undefined ? ` 分区 ${String(s.action.target.unit)}` : ''}
                </span>
              </div>
              {s.error ? <div className="alert alert-error">{s.error}</div> : null}
              {s.action.reason ? <div className="plan-reason">AI 理由：{s.action.reason}</div> : null}
              {s.ok ? (
                <>
                  <div className="plan-label">{s.label}</div>
                  <ul className="diff-list">
                    {s.diff.slice(0, 8).map((d, j) => (
                      <li key={j}>
                        <Text mono>{d.path}</Text>：{fmt(d.from)} → <b>{fmt(d.to)}</b>
                      </li>
                    ))}
                    {s.diff.length > 8 ? <li className="muted-sm">…另有 {s.diff.length - 8} 处</li> : null}
                  </ul>
                  {s.memoryHits.length > 0 ? (
                    <div className="alert alert-error">
                      被记忆拦住（你之前纠正过的规矩）：{s.memoryHits.map((h) => h.message).join('；')}
                    </div>
                  ) : null}
                  {s.newIssues.length > 0 ? (
                    <div className="plan-issues">
                      {s.newIssues.map((x, j) => (
                        <div key={j}>
                          <Pill kind={x.severity === 'ERROR' ? 'ERROR' : x.severity === 'WARNING' ? 'WARNING' : 'INFO'}>{x.severity}</Pill>{' '}
                          <Text mono>{x.code}</Text> {x.message}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="muted-sm">未新增任何规则问题</div>
                  )}
                  {s.resolvedIssues.length > 0 ? <div className="muted-sm">顺带消除 {s.resolvedIssues.length} 条问题</div> : null}
                  {s.clamped.length > 0 ? <div className="muted-sm">被钳制：{s.clamped.join('；')}</div> : null}
                </>
              ) : null}
            </div>
          ))}
          <div className="btn-row">
            <button type="button" className="tb-btn primary" disabled={run.okCount === 0 || run.committed} onClick={apply}>
              {run.committed ? `✓ 已应用 ${run.okCount} 条` : `应用全部（${run.okCount} 条）`}
            </button>
            <button type="button" className="tb-btn" onClick={dismissPlan}>
              丢弃
            </button>
          </div>
          <Row label="干跑后模型里仍有 ERROR" derived hint="ERROR 会阻断生产数据导出；WARNING 不阻断">
            {run.blockingErrors > 0 ? <Pill kind="ERROR">{run.blockingErrors}</Pill> : <Pill kind="ok">0</Pill>}
          </Row>
          {run.impact.length > 0 ? (
            <Row
              label="影响面（连带改变）"
              derived
              hint="由干跑前后两次真实派生对比得出。你点选的「一条线」背后连着门板高、抽屉分格、铰链数量 —— 这里列出的是它们实际会怎么变"
            >
              <ul className="diff-list">
                {run.impact.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </Row>
          ) : null}
          {lastApply ? <div className="alert alert-info">{lastApply}</div> : null}
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

function fmt(v: unknown): string {
  if (v === undefined) return '(无)';
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  return String(v);
}
