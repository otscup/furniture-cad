import type { Issue, Project, RuleSet } from '../core/types.ts';
import type { Command } from '../core/commandBus.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  AI 记忆与进化 —— 让"我记住了"变成"它真的拦得住"
 *
 *  用户原话："ai 要带进化以及重要的记忆功能，比如有问题的地方在我告诉他过后
 *            下次不要犯同样的错误。"
 *
 *  ── 为什么不能只存一句自然语言 ──
 *    "记住：柜子别超过 2400" 这种条目，存下来很容易，但它**永远不会发挥作用**。
 *    半年后模型换了、你换了一台机器、或者只是忘了加载，
 *    这条记忆就只是聊天记录里的一句话 —— 这就是「假记忆」。
 *
 *  ── 本模块的解法：记忆必须是编译产物 ──
 *
 *      Correction（结构化记录，JSONL 可落盘）
 *          │  compileCorrections()
 *          ▼
 *      Check 闭包（可执行、可穷举测试）
 *          │  挂在 CommandBus.execute 的提交前门
 *          ▼
 *      违反 → 拒绝提交，并说清是哪条记忆拦的、为什么
 *
 *    门的位置选在 CommandBus 而不是 AI 层，理由：
 *      · UI 点击 / 拖动 / AI / MCP / 脚本 五条路都经过这里 —— 记忆对 AI 生效，
 *        也对你自己的手生效（你手滑把柜子拖进墙里，同样会被自己定的规矩拦住）
 *      · 复用已有的两段式语义：dryRun 时门也照跑，AI 可以先"预告"会被拦
 *      · 不需要 AI 在线。断网、换模型、换客户端，记忆照样生效
 *
 *  ── 一条铁律：检不出来的，不许进 active ──
 *    status 只有三种：
 *      active  —— 已编译成可执行检查，并且通过了"该拦的拦得住、不该拦的不误伤"双向测试
 *      pending —— 记下来了，但当前还编译不出检查（例如 DXF 导出还没接）
 *      retired —— 已失效（工艺变了 / 用户撤回）
 *    verify/memory-acceptance.ts 会逐条跑 active 的 both-way 测试，
 *    任何一条检不出来就当场失败 —— 宁可报"我记下了但还不会自动拦"，
 *    也不许装作记住了。
 * ══════════════════════════════════════════════════════════════════════
 */

export type CorrectionScope = 'global' | 'cabinet' | 'rule' | 'ui' | 'export';
export type CorrectionStatus = 'active' | 'pending' | 'retired';

/** 记忆能编译出的检查种类 —— 每一种都是**可判定**的，没有模糊地带 */
export type CheckSpec =
  | {
      kind: 'noNewIssue';
      /** 本次命令新引入该 code 的 issue 就拦（code 来自 rules/validate.ts） */
      issueCode: string;
      message: string;
      fixHint?: string;
    }
  | {
      kind: 'maxValue';
      /** 相对柜体/墙的属性路径，例如 params.height */
      path: string;
      value: number;
      unit?: string;
      message: string;
      fixHint?: string;
    }
  | {
      kind: 'minValue';
      path: string;
      value: number;
      unit?: string;
      message: string;
      fixHint?: string;
    }
  | {
      kind: 'pathForbidden';
      /** 禁止写入的路径前缀，例如 params.backPanel.grooveDepth */
      path: string;
      message: string;
      fixHint?: string;
    };

export interface Correction {
  id: string;
  at: number;
  scope: CorrectionScope;
  /** 用户原话（原样保留 —— 这是审计的本体，任何改写都可能曲解原意） */
  nl: string;
  /** 当时指出问题时的证据（文件、截图路径、复现步骤、错误码） */
  evidence: string[];
  status: CorrectionStatus;
  /** status 为 pending 时必须写清"为什么还编译不出检查" */
  pendingReason?: string;
  checkSpec?: CheckSpec;
  tags: string[];
  /** 这条记忆来自谁：用户纠正 / 系统自省（我们踩过的坑） */
  origin: 'user' | 'self';
}

/** 一次门拦截 */
export interface GateHit {
  correctionId: string;
  nl: string;
  message: string;
  fixHint?: string;
}

export interface GateCtx {
  cmd: Command;
  before: Project;
  draft: Project;
  /** 本次命令【新引入】的问题（execute 已算好，门不重算，避免两份判定） */
  newIssues: Issue[];
  rules: RuleSet;
}

export type Gate = (ctx: GateCtx) => GateHit[];

export interface CompiledRule {
  correctionId: string;
  /** 人能看懂的一句话：这条记忆现在具体在查什么 */
  describe: string;
  scope: CorrectionScope;
}

export interface CompileResult {
  gate: Gate;
  compiled: CompiledRule[];
  /** 没有可执行检查的条目（active 却没 spec / pending / retired） */
  inactive: Correction[];
}

// ───────────────────────────── path 读取 ─────────────────────────────

/** 只支持 `a.b.c` 形式的简单路径；读不到返回 undefined（不抛） */
function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * 该 path 在 draft 里是否被"改成了超过阈值"的值。
 *
 * 注意是**比较 before / draft**，而不是只看 draft：
 * 项目里可能本来就有超标的柜体（历史遗留），门只拦"这次操作把它变得更糟"。
 * 否则一旦有一条历史违规，之后任何操作都会被拦住 —— 工具就没法用了。
 */
function crossedLimit(ctx: GateCtx, path: string, cmp: (after: number, limit: number) => boolean, limit: number): boolean {
  for (const c of ctx.draft.cabinets) {
    const after = Number(readPath(c, path));
    if (!Number.isFinite(after)) continue;
    const prev = ctx.before.cabinets.find((x) => x.id === c.id);
    const before = prev ? Number(readPath(prev, path)) : Number.NaN;
    if (cmp(after, limit) && after !== before) return true;
  }
  return false;
}

// ───────────────────────────── 编译 ─────────────────────────────

function buildCheck(spec: CheckSpec): { run: (ctx: GateCtx) => boolean; describe: string } {
  switch (spec.kind) {
    case 'noNewIssue':
      return {
        describe: `本次操作若新引入 ${spec.issueCode} 即拒绝`,
        run: (ctx) => ctx.newIssues.some((i) => i.code === spec.issueCode),
      };
    case 'maxValue':
      return {
        describe: `${spec.path} 不得超过 ${spec.value}${spec.unit ?? ''}`,
        run: (ctx) => crossedLimit(ctx, spec.path, (a, v) => a > v, spec.value),
      };
    case 'minValue':
      return {
        describe: `${spec.path} 不得低于 ${spec.value}${spec.unit ?? ''}`,
        run: (ctx) => crossedLimit(ctx, spec.path, (a, v) => a < v, spec.value),
      };
    case 'pathForbidden':
      return {
        describe: `禁止写入 ${spec.path}*`,
        // 结构性命令（cabinet.create 等）可能不带 changes 字段 —— 用 ?? [] 兜底，
        // 避免门自己因 cmd.changes 为 undefined 而崩（门崩了比"漏拦一次"更糟）。
        run: (ctx) => (ctx.cmd.changes ?? []).some((ch) => ch.path === spec.path || ch.path.startsWith(`${spec.path}.`)),
      };
  }
}

/**
 * 编译记忆 → 可执行门。
 * 纯函数：同一组 correction 永远得到同一个门（便于单测与回放）。
 */
export function compileCorrections(corrections: Correction[]): CompileResult {
  const compiled: CompiledRule[] = [];
  const inactive: Correction[] = [];
  const checks: Array<{ id: string; nl: string; spec: CheckSpec; run: (ctx: GateCtx) => boolean }> = [];

  for (const c of corrections) {
    if (c.status !== 'active' || !c.checkSpec) {
      inactive.push(c);
      continue;
    }
    const { run, describe } = buildCheck(c.checkSpec);
    checks.push({ id: c.id, nl: c.nl, spec: c.checkSpec, run });
    compiled.push({ correctionId: c.id, describe, scope: c.scope });
  }

  const gate: Gate = (ctx) => {
    const hits: GateHit[] = [];
    for (const c of checks) {
      if (!c.run(ctx)) continue;
      hits.push({
        correctionId: c.id,
        nl: c.nl,
        message: c.spec.message,
        fixHint: c.spec.fixHint,
      });
    }
    return hits;
  };

  return { gate, compiled, inactive };
}

/** 把门拦截结果拼成给用户/AI 看的一句话（必须能说清"是哪条记忆拦的"） */
export function formatGateError(hits: GateHit[]): string {
  if (hits.length === 0) return '';
  const head = hits[0];
  const more = hits.length > 1 ? `（另有 ${hits.length - 1} 条记忆同时命中）` : '';
  return `记忆拦截 [${head.correctionId}]：${head.message}。你当时的原话：「${head.nl}」${more}${head.fixHint ? ` · 建议：${head.fixHint}` : ''}`;
}

/** 记忆摘要（给界面用） */
export function summarize(corrections: Correction[]): { active: number; pending: number; retired: number; total: number } {
  const s = { active: 0, pending: 0, retired: 0, total: corrections.length };
  for (const c of corrections) s[c.status]++;
  return s;
}
