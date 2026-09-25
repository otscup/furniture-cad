import { CommandBus, type Command, type DiffEntry } from '../core/commandBus.ts';
import type { Gate, GateHit } from './memory.ts';
import type { Issue, Project, RuleSet } from '../core/types.ts';
import { compileAction, type AiAction } from './compile.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  多步计划的干跑与提交
 *
 *  ── 为什么需要一个"沙盒总线"，而不是直接对真总线连续 plan ──
 *    真总线的 `plan()` 永远对着 `this.project` 算，它没有"假设前面几步已经生效"
 *    这个概念。而 AI 的一个计划常常是好几步互相依赖的：
 *        ① 给主卧衣柜新增一个抽屉区
 *        ② 把那个抽屉区改成 4 只抽屉      ← 这一步的分区下标由①决定
 *    如果每一步都对着原始 project 编译，②就会去改一个**别**的分区 ——
 *    静默改错对象，比报错危险得多。
 *    所以：拿一个 `new CommandBus(clone, rules)` 当草稿纸，每一步都对着
 *    **上一步的结果**编译并执行；真总线全程不动，直到用户点"应用"。
 *
 *  ── "预览 === 提交" 在这里同样是结构性保证 ──
 *    提交时执行的是**同一批 Command 对象**（不是重新编译一遍），
 *    所以在"模型版本没变"的前提下，提交结果与预览逐位相同。
 *    版本变了就**拒绝提交**并让人重新生成计划 —— 见 stale 字段。
 *    这一条不是洁癖：预览时看到的 diff 是用户点"应用"的唯一依据，
 *    依据和结果不一致等于骗人。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface PlanStep {
  /** 契约校验后的动作原文（原样回显给用户看"AI 到底想干什么"） */
  action: AiAction;
  /** 编译出来的命令。编译失败时为 undefined */
  command?: Command;
  /** 人话摘要（来自命令构造器，与 UI 点击产生的日志是同一套说法） */
  label: string;
  ok: boolean;
  error?: string;
  diff: DiffEntry[];
  newIssues: Issue[];
  resolvedIssues: Issue[];
  clamped: string[];
  /** 被记忆门拦下的条目 —— 界面必须显示"是你上次说的哪句话拦的" */
  memoryHits: GateHit[];
  blockingErrors: number;
}

export interface PlanRun {
  steps: PlanStep[];
  okCount: number;
  errorCount: number;
  /** 计划跑完后（干跑状态里）模型里仍有几条 ERROR */
  blockingErrors: number;
  /** 干跑结束时模型的样子 —— 只用于显示摘要，不是"已经改了" */
  draft: Project;
  /** 干跑开始时的模型版本。提交前会再比一次，不一致就拒绝 */
  baseVersion: number;
  /** true = 这批命令已经真的写进总线 */
  committed: boolean;
  /**
   * 影响面提示（A5）：干跑后每个被连带改变的柜体一行 ——
   * 「板件 31→30」「分区净宽 582/1164/582 → 780/960/582」这类。
   * 由前后两次真实派生对比得出，不是静态表 —— 静态表会与生成器漂移。
   */
  impact: string[];
  /**
   * 提交完成时的模型版本。
   *
   * 存在的理由只有一个，但很要紧：提交会 bump 版本号，而界面是"版本一变就作废这份计划"
   * （落点已经不同了）。人不区分"我自己刚点了应用"和"别人动了模型"，
   * 于是刚应用完，整个预览区就消失了 —— 想回头核对"到底改了哪几处"什么都没有。
   * 有了这个字段，界面就能把"我自己提交出来的这一次版本"认出来并留着，
   * 一直留到模型**再次**被改动为止。
   */
  committedVersion?: number;
}

/**
 * 干跑一个计划。
 *
 * `gate` 必须传进来：记忆门是"用户纠正过的规矩"，预览时不等它，
 * 就会出现"预览看着没问题、一点应用弹出被记忆拦住"—— 两段式的意义就没了。
 * 传 `undefined` 表示"调用方没有记忆门"（例如命令行验收），传 `null` 表示显式关闭。
 */
export function dryRunPlan(opts: { bus: CommandBus; actions: AiAction[]; gate?: Gate | null; selection?: string[] }): PlanRun {
  const { bus, actions } = opts;
  const rules: RuleSet = bus.getRules();
  const baseVersion = bus.getVersion();
  const sandbox = new CommandBus(bus.getState(), rules);
  if (opts.gate !== undefined) sandbox.setGate(opts.gate);

  const steps: PlanStep[] = [];
  const runStep = (action: AiAction, displayAction: AiAction): void => {
    const compiled = compileAction(action, sandbox.getState(), rules);
    if (!compiled.ok) {
      steps.push({
        action: displayAction,
        label: '(未编译)',
        ok: false,
        error: compiled.error ?? '编译失败（编译器没有给出原因，这本身是个缺陷）',
        diff: [],
        newIssues: [],
        resolvedIssues: [],
        clamped: [],
        memoryHits: [],
        blockingErrors: 0,
      });
      return;
    }
    /**
     * strict: true —— AI 不能把模型改成"带 ERROR"的状态。
     * 注意 strict 只拦**本次新引入**的 ERROR：模型里原本就有的历史问题
     * 不会让之后的每一步都被卡住（与 UI 手动操作同一套语义）。
     */
    const r = sandbox.execute(compiled.command, { strict: true, commitLabel: `AI：${compiled.summary}` });
    steps.push({
      action: displayAction,
      command: compiled.command,
      label: compiled.command.label ?? compiled.summary,
      ok: r.ok,
      /**
       * error 只能在**失败**时出现。
       * 这里原本写成 `r.error ?? '被拒绝（…）'`，于是**成功的步骤也被塞了一句"被拒绝"** ——
       * 界面恰好只看 !ok 的步骤，才没把这个笑话摆到用户面前。
       * 这种"字段自带假信息"比没有信息更危险：谁哪天改成直接渲染 error，
       * 用户会看到每一步都被拒绝。
       */
      error: r.ok ? undefined : (r.error ?? '被拒绝（总线没有给出原因，这本身是个缺陷）'),
      diff: r.diff,
      newIssues: r.newIssues,
      resolvedIssues: r.resolvedIssues,
      clamped: r.clamped,
      memoryHits: r.memoryHits,
      blockingErrors: r.blockingErrors,
    });
  };

  for (const action of actions) {
    /**
     * scope:"selection"（圈选）在这里展开成逐柜动作 —— 编译器没有"当前选择"的上下文，
     * 展开是 planRunner 的职责（A3/A4）。展开后每一步的 target 都落成具体 cabinetId，
     * 审计与 diff 才能说清"改的到底是谁"。选择集为空 → 如实报错，不静默跳过。
     */
    if (action.target?.scope === 'selection') {
      const sel = opts.selection ?? [];
      if (sel.length === 0) {
        steps.push({
          action,
          label: '(未编译)',
          ok: false,
          error: '圈选（scope:"selection"）为空：图上还没有选中任何柜体。先在图上选中，再让 AI 执行',
          diff: [],
          newIssues: [],
          resolvedIssues: [],
          clamped: [],
          memoryHits: [],
          blockingErrors: 0,
        });
        continue;
      }
      for (const id of sel) {
        // scope 必须剥掉：展开后的动作落成具体 cabinetId，
        // 否则编译器的守卫会正确地拦下它（那是守卫的功劳，不是展开的功劳）
        const { scope: _scope, ...targetRest } = action.target;
        const expanded: AiAction = { ...action, target: { ...targetRest, cabinetId: id } };
        runStep(expanded, expanded);
      }
      continue;
    }
    runStep(action, action);
  }

  const okCount = steps.filter((s) => s.ok).length;
  return {
    steps,
    okCount,
    errorCount: steps.length - okCount,
    blockingErrors: steps.length ? steps[steps.length - 1].blockingErrors : 0,
    draft: sandbox.getState(),
    baseVersion,
    committed: false,
    impact: buildImpact(bus, sandbox),
  };
}

/** 影响面（A5）：干跑前后各派生一次，逐柜对比板件数 / 用板面积 / 分区净宽 —— 静态表会与生成器漂移，这里全部来自真实派生 */
function buildImpact(bus: CommandBus, sandbox: CommandBus): string[] {
  const before = bus.derive().geom.cabinets;
  const after = sandbox.derive().geom.cabinets;
  const cabs = sandbox.getState().cabinets;
  const lines: string[] = [];
  for (const [id, g] of Object.entries(after)) {
    const b = before[id];
    const name = cabs.find((c) => c.id === id)?.name ?? id;
    if (!b) {
      lines.push(`「${name}」新增：板件 ${g.stats.totalPieces} 件`);
      continue;
    }
    const parts: string[] = [];
    if (b.stats.totalPieces !== g.stats.totalPieces) parts.push(`板件 ${b.stats.totalPieces}→${g.stats.totalPieces} 件`);
    /**
     * 用板面积要覆盖"板件数不变但尺寸变"的情况：改踢脚高不增减板件、
     * 不动分区净宽，但侧板/层板/背板都在变长变短 —— 面积是最老实的读数。
     * 取 cm² 精度比较，避免浮点噪声把没变的判成变了。
     */
    const a0 = Math.round(b.stats.boardAreaM2 * 100);
    const a1 = Math.round(g.stats.boardAreaM2 * 100);
    if (a0 !== a1) parts.push(`用板面积 ${b.stats.boardAreaM2.toFixed(2)}→${g.stats.boardAreaM2.toFixed(2)} m²`);
    const bn = b.layout.nets.join('/');
    const an = g.layout.nets.join('/');
    if (bn !== an) parts.push(`分区净宽 ${bn} → ${an}`);
    if (parts.length > 0) lines.push(`「${name}」${parts.join(' · ')}`);
  }
  for (const id of Object.keys(before)) {
    if (!after[id]) lines.push(`「${cabs.find((c) => c.id === id)?.name ?? id}」被删除`);
  }
  return lines;
}

export type CommitOutcome =
  | { ok: true; applied: number; skipped: number; blockingErrors: number }
  | { ok: false; error: string };

/**
 * 提交干跑通过的步骤。
 *
 * 两条硬规矩：
 *  1. **只提交干跑通过的那些**。失败的步骤不提交、也不静默跳过它的后续 ——
 *     后续步骤是"对着它编译"的，它没生效，后续就可能改错对象，所以一并跳过并说明。
 *  2. **模型版本必须没变**。预览之后用户要是自己拖了一下柜子，
 *     这批命令就是对着旧模型编译的，直接拒绝而不是"尽力而为"。
 */
export function commitPlan(run: PlanRun, bus: CommandBus): CommitOutcome {
  if (run.committed) return { ok: false, error: '这批计划已经提交过了' };
  if (bus.getVersion() !== run.baseVersion) {
    return { ok: false, error: '模型在预览之后被改动过，这份计划的落点可能已经失效 —— 请重新生成' };
  }
  let applied = 0;
  let skipped = 0;
  /**
   * blocked 一旦置位就不再提交任何后续步骤。
   * 理由：后续步骤是**以上一步的结果为前提编译**的（"先把新分区加宽，再改它的层板数"），
   * 前提没生效却硬提交，就会改到一个**别的**对象上 —— 那是静默改错，最坏的一种。
   */
  let blocked = false;
  for (const step of run.steps) {
    if (blocked || !step.ok || !step.command) {
      skipped++;
      blocked = true;
      continue;
    }
    const r = bus.execute(step.command, { strict: true, commitLabel: `AI：${step.label}` });
    if (!r.ok) {
      // 干跑过了、提交没过 —— 只可能是两次之间模型被改了（上面已拦）。
      // 真出现了就立刻停下并如实报告，绝不继续往下改。
      return { ok: false, error: `第 ${applied + 1} 步提交失败：${r.error}` };
    }
    applied++;
  }
  run.committed = true;
  run.committedVersion = bus.getVersion();
  return { ok: true, applied, skipped, blockingErrors: bus.issues().filter((i) => i.severity === 'ERROR').length };
}

/** 只提交其中指定序号（1 起）的步骤 —— 让用户可以"只要前面两条，第三条不要" */
export function commitPlanSubset(run: PlanRun, bus: CommandBus, stepIndexes: number[]): CommitOutcome {
  const wanted = new Set(stepIndexes);
  const v0 = bus.getVersion();
  if (v0 !== run.baseVersion) {
    return { ok: false, error: '模型在预览之后被改动过 —— 请重新生成计划' };
  }
  let applied = 0;
  let skipped = 0;
  for (let i = 0; i < run.steps.length; i++) {
    const step = run.steps[i];
    if (!wanted.has(i + 1) || !step.ok || !step.command) {
      skipped++;
      continue;
    }
    // 每提交一条版本号必然 +1；对不上说明有别人在并发写模型，立即停手
    if (bus.getVersion() !== v0 + applied) {
      return { ok: false, error: '模型状态与预览不一致，已停止（可能有其它写入发生）' };
    }
    const r = bus.execute(step.command, { strict: true, commitLabel: `AI：${step.label}` });
    if (!r.ok) return { ok: false, error: `第 ${i + 1} 步提交失败：${r.error}` };
    applied++;
  }
  run.committed = true;
  run.committedVersion = bus.getVersion();
  return { ok: true, applied, skipped, blockingErrors: bus.issues().filter((i) => i.severity === 'ERROR').length };
}
