import { CommandBus } from '../core/commandBus.ts';
import type { Project, RuleSet } from '../core/types.ts';
import type { AiAction } from './compile.ts';
import { commitPlan, dryRunPlan, type CommitOutcome, type PlanRun, type PlanStep } from './planRunner.ts';
import { buildSnapshot, type AiSnapshot } from './snapshot.ts';
import type { Gate } from './memory.ts';
import type { PlanRejection } from './aiClient.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  草案会话 —— 「先聊出一个方案，定稿了再变成真东西」
 *
 *  ── 为什么需要它，而不是"每次都重新生成一份计划" ──
 *    一轮出图的工作方式是这样的：人看完说"矮了，加到 2400"，
 *    于是第二次请求发出去。如果第一次的成果**没有留在桌上**，那第二句
 *    "把刚才那个柜子加高" 就没有任何着落 —— AI 拿到的快照还是原始项目，
 *    它看不见"刚才那个柜子"，只能重新造一个，或者开始反问。
 *    **对话能持续修改的前提是：上一轮的结果必须留在桌上。**
 *    这份文件就是那张桌子。
 *
 *  ── 它和真模型的关系：一条单向的闸门 ──
 *    草案全程活在一根**独立的沙盒总线**上，真总线一个字节都没动。
 *    唯一的出口是 `finalizeDraft()`，且它复用 `commitPlan` 的每一条规矩：
 *       · 真模型版本必须与开案时一致（期间手动改过就拒绝，不能"尽力合并"）
 *       · 提交的是**预览时那一批 Command 对象**，不是重新编译一遍
 *     所以「预览 === 提交」这条结构性保证，在多轮累积之后依然成立。
 *
 *  ── 快照取自草案，不是取自真项目（这是全文件最关键的一行注释）──
 *    `draftSnapshot()` 用**当前草案**生成快照喂给下一轮。
 *    若这里偷懒用真项目，第二轮 AI 就会说"我没看见你刚才建的柜子" ——
 *    表现很像模型犯傻，实际是喂错了东西。
 *
 *  ── 一轮失败时怎么办 ──
 *    失败的那一轮**不进入草案**（草案停在上一轮的样子），但这一轮要留在
 *    记录里并把原因显示出来 —— 人不看到"为什么没生效"，就会以为生效了。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 一轮对话里，用户说了什么、AI 回了什么、这一轮打算怎么改 */
export interface DraftRound {
  index: number;
  /** 用户这一句原话 */
  text: string;
  /** AI 的说明（它可能只说话、不产生动作） */
  reply: string;
  /** 这一轮打算执行的动作（原文，用于回显与重放） */
  actions: AiAction[];
  /** 被契约拒收的动作 —— 一条都不能藏 */
  rejected: PlanRejection[];
  /** 这一轮在草案上的干跑结果 */
  run: PlanRun;
  /** 这一轮是否已经并入草案（失败的一轮为 false，草案停在上一轮） */
  merged: boolean;
}

export interface DraftSession {
  /** 开案那一刻的真项目 —— 撤回与定稿都以它为起点 */
  base: Project;
  /** 开案时的真总线版本。定稿前会再比一次，不一致就拒绝 */
  baseVersion: number;
  /** 当前草案长什么样 */
  project: Project;
  rounds: DraftRound[];
  /** 累积下来**可提交**的步骤 —— 定稿时提交的就是这些 */
  steps: PlanStep[];
}

const cloneProject = (p: Project): Project => JSON.parse(JSON.stringify(p)) as Project;

/** 开案：草案 = 真项目的一份拷贝，此后两边互不干扰 */
export function startDraft(bus: CommandBus): DraftSession {
  const base = cloneProject(bus.getState());
  return {
    base,
    baseVersion: bus.getVersion(),
    project: cloneProject(base),
    rounds: [],
    steps: [],
  };
}

/**
 * 发给 AI 的快照 —— 必须是**草案**的。
 * 见文件头：用真项目会让第二轮之后的每一句"刚才那个…"全部落空。
 */
export function draftSnapshot(s: DraftSession, rules: RuleSet): AiSnapshot {
  return buildSnapshot(s.project, rules);
}

/** 在草案上跑一轮（不碰真总线） */
export function addDraftRound(
  s: DraftSession,
  opts: {
    text: string;
    reply: string;
    actions: AiAction[];
    rejected?: PlanRejection[];
    rules: RuleSet;
    gate?: Gate | null;
    selection?: string[];
  },
): DraftSession {
  const round = runRound(s.project, opts);
  round.index = s.rounds.length + 1;
  const merged = round.merged;
  return {
    ...s,
    project: merged ? (round.run.draft ?? s.project) : s.project,
    rounds: [...s.rounds, round],
    // 失败的一轮不进 steps：后续步骤是"对着它编译"的，它没生效就不能被带进提交
    steps: merged ? [...s.steps, ...round.run.steps.filter((st) => st.ok && st.command)] : s.steps,
  };
}

/** 撤回上一轮：草案回到上一轮之前的样子（从 base 重放剩余轮次） */
export function undoLastRound(
  s: DraftSession,
  opts: { rules: RuleSet; gate?: Gate | null; selection?: string[] },
): DraftSession {
  if (s.rounds.length === 0) return s;
  return replay(s.base, s.baseVersion, s.rounds.slice(0, -1), opts);
}

/**
 * 定稿：把累积的步骤写进真总线。
 *
 * 走的是 `commitPlan`，所以它自带那两条硬规矩（版本一致、逐条同一 Command）。
 * 这里只是把多轮累积的结果**包装成一个合成 PlanRun**，不去新造一套提交逻辑 ——
 * 新造一套就等于绕开了那些规矩。
 */
export function finalizeDraft(s: DraftSession, bus: CommandBus): CommitOutcome {
  if (s.steps.length === 0) return { ok: false, error: '草案里还没有可提交的步骤' };
  const synth: PlanRun = {
    steps: s.steps,
    okCount: s.steps.length,
    errorCount: 0,
    blockingErrors: s.steps[s.steps.length - 1]?.blockingErrors ?? 0,
    draft: s.project,
    baseVersion: s.baseVersion,
    committed: false,
    /**
     * impact 是"逐柜影响面"，定稿这一步拿不到前后两次派生（真总线还没跑），
     * 所以留空 —— 界面在定稿后读的是真总线的新状态，不需要这个字段。
     * 每**一轮**的影响面由那一轮自己的 run.impact 显示，那个是有的。
     */
    impact: [],
  };
  return commitPlan(synth, bus);
}

// ── 内部 ──

function runRound(
  from: Project,
  opts: {
    text: string;
    reply: string;
    actions: AiAction[];
    rejected?: PlanRejection[];
    rules: RuleSet;
    gate?: Gate | null;
    selection?: string[];
  },
): DraftRound {
  const sandbox = new CommandBus(cloneProject(from), opts.rules);
  if (opts.gate !== undefined) sandbox.setGate(opts.gate);
  const run = dryRunPlan({
    bus: sandbox,
    actions: opts.actions,
    gate: opts.gate,
    selection: opts.selection,
  });
  /**
   * 只在这一轮**一条都没失败**时才并入草案。
   * 半截成功比全失败更危险：人会以为"改动生效了"，而实际上后面几步没跑，
   * 于是下一句"把它加宽"会加到一个不存在的对象上。
   */
  const merged = run.errorCount === 0 && run.blockingErrors === 0 && run.steps.length > 0;
  if (merged) commitPlan(run, sandbox);
  return {
    index: 0,
    text: opts.text,
    reply: opts.reply,
    actions: opts.actions,
    rejected: opts.rejected ?? [],
    run,
    merged,
  };
}

/** 从 base 重放若干轮，重建会话（撤回用） */
function replay(
  base: Project,
  baseVersion: number,
  rounds: DraftRound[],
  opts: { rules: RuleSet; gate?: Gate | null; selection?: string[] },
): DraftSession {
  let project = cloneProject(base);
  const steps: PlanStep[] = [];
  const out: DraftRound[] = [];
  for (const r of rounds) {
    const round = runRound(project, {
      text: r.text,
      reply: r.reply,
      actions: r.actions,
      rejected: r.rejected,
      rules: opts.rules,
      gate: opts.gate,
      selection: opts.selection,
    });
    if (round.merged) {
      project = round.run.draft ?? project;
      steps.push(...round.run.steps.filter((st) => st.ok && st.command));
    }
    out.push({ ...round, index: out.length + 1 });
  }
  return { base: cloneProject(base), baseVersion, project, rounds: out, steps };
}
