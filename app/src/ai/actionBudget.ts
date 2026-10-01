/**
 * ══════════════════════════════════════════════════════════════════════
 *  Action Budget —— `MAX_ACTIONS = 12` 的**分批方案**（P9.5，§七）
 *
 *  ── 先把这个数是什么说清楚 ──
 *    `MAX_ACTIONS`（`shared/aiContract.mjs`）是**一轮 AI 输出的动作条数上限**。
 *    它约束的不只是"模型别说太多"，而是**单次预览/提交的影响面**：
 *    用户要点应用复核的那份 diff 最多多长、一条坏计划最多能造成多大破坏。
 *    `validatePlan` 在超限时**整份拒绝**（`ok:false` + `actions: []`），
 *    **绝不截断、绝不丢柜** —— 这一条现有实现已经成立，本文件只把它钉住并给出后续路径。
 *
 *  ── 为什么需要这个文件（问题本身）──
 *    一只柜要花 **2 条动作**（`cabinet.create` + `cabinet.place`），
 *    所以「整墙 6 柜」= 12 条 = **正好顶到上限、0 余量**；
 *    第 7 只柜或任何一句追加修改 → 13 条 → 整份被拒。
 *    根因不是 12 太小，是 **2N 的固定成本**。
 *
 *  ── 方案：分批，而不是把数字改大 ──
 *    · **不改 `MAX_ACTIONS`**（`ACTION_BUDGET` 只是它的再导出，同一处真相）。
 *      改大等于把"一次最多动 12 步"变成"一次最多动 100 步"，
 *      用户复核能力与回滚粒度同时退化 —— 那是本项目最贵的三条不变量的地基。
 *    · 超限时给出**依赖安全**的批次：每组 ≤ 上限，**每批各走一次**
 *      `dryRunPlan → 预览 → commitPlan`（既有链路，一行都不用改）。
 *      所以分批**没有放宽任何限制**：上限仍是 12、每批仍整份通过或整份拒绝、
 *      仍然 `preview === commit`，而且**每批更小、影响面更小**。
 *
 *  ── 依赖安全是这里的全部难点 ──
 *    `cabinet.place` 的 target 是 `$ref:<名字>`，指向同一批里某个
 *    `cabinet.create` 的产物。**把 create 和它的 place 拆到两批里**，
 *    第二批就会去引一个不存在的对象 —— 静默改错对象，最坏的一种。
 *    所以这里按 **`$ref` 依赖闭包**分组（并查集），**整组一起进同一批**。
 *    如果**单个组**自己就超过上限，那它**无法安全分批** —— 如实返回
 *    `unsplittable: true`，**绝不从中截断**。
 * ══════════════════════════════════════════════════════════════════════
 */
import { MAX_ACTIONS } from '../../shared/aiContract.mjs';
import type { AiAction } from './compile.ts';

/** 预算的真身仍只有一处：`shared/aiContract.mjs`。这里只做再导出，不许另写一个数 */
export const ACTION_BUDGET = MAX_ACTIONS;

const REF_PREFIX = '$ref:';

export interface ActionBatchPlan {
  /** 动作总条数 */
  count: number;
  /** 单批上限（= `MAX_ACTIONS`） */
  limit: number;
  /** `count <= limit` —— 一批装得下（这是"能不能一次执行完"的判据） */
  fits: boolean;
  /** 需要多于一批（`batches.length > 1`） */
  batched: boolean;
  /** 超出上限的条数（`max(0, count - limit)`）；`fits` 时为 0 */
  overflow: number;
  /**
   * 依赖安全的批次（每批 ≤ limit，顺序即原顺序）。
   * `unsplittable` 时为 `[]` —— 宁可不给方案，也不给一个会把 create/place 拆开的假方案。
   */
  batches: AiAction[][];
  /** 依赖组的个数（1 = 所有动作互相独立，可以随便切） */
  groups: number;
  /** 有一个依赖组自己就 > limit ⇒ **无法安全分批**（必须明确拒绝，不许截断） */
  unsplittable: boolean;
  /** 引用了 `$ref:` 但本批里没有定义它的名字（悬空引用 —— 是个缺陷，如实列出） */
  danglingRefs: string[];
  /** 人话结论（谁在读它都不该看到"我悄悄帮你砍了几条"） */
  note: string;
}

interface Gear {
  defines: string[];
  uses: string[];
}

/** 一条动作定义了哪个 ref、引用了哪些 ref（`target` 与 `params` 都扫） */
export function refsOf(action: AiAction): Gear {
  const defines = action.ref ? [action.ref] : [];
  const uses: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.startsWith(REF_PREFIX)) uses.push(v.slice(REF_PREFIX.length));
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) collect(x);
      return;
    }
    if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) collect(x);
    }
  };
  collect(action.target);
  collect(action.params);
  return { defines, uses };
}

/**
 * 把动作按 `$ref` 依赖闭包分组，再贪心装箱成批次。
 *
 * 保证：
 *   · **不丢动作**（所有动作恰好出现一次）；
 *   · **不拆依赖组**（定义 ref 的动作与所有引用它的动作永远同批）；
 *   · **不改顺序**（批内、批间都保持原相对顺序）；
 *   · 装不下**就说不装不下**（`unsplittable`），不从中间截断。
 */
export function planActionBatches(actions: AiAction[], limit: number = ACTION_BUDGET): ActionBatchPlan {
  const safeLimit = Number.isInteger(limit) && limit >= 1 ? limit : ACTION_BUDGET;
  const count = actions.length;

  // ── 并查集（确定性：小下标当根）──
  const parent = actions.map((_, i) => i);
  const find = (i: number): number => {
    let x = i;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]!;
      x = parent[x]!;
    }
    return x;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent[rb] = ra;
    else parent[ra] = rb;
  };

  /** ref 名 → 第一个定义它的动作下标（重复定义本身就是缺陷，这里不掩盖：取第一个，多的那个仍然独立成组） */
  const definer = new Map<string, number>();
  actions.forEach((a, i) => {
    for (const r of refsOf(a).defines) if (!definer.has(r)) definer.set(r, i);
  });

  const dangling: string[] = [];
  actions.forEach((a, i) => {
    for (const r of refsOf(a).uses) {
      const d = definer.get(r);
      if (d === undefined) dangling.push(r);
      else if (d !== i) union(i, d);
    }
  });

  // ── 分组成批（组按"组内最小下标"升序；组内按原下标升序）──
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const r = find(i);
    const arr = byRoot.get(r);
    if (arr) arr.push(i);
    else byRoot.set(r, [i]);
  }
  const groups = [...byRoot.values()].sort((a, b) => a[0]! - b[0]!);
  const oversized = groups.find((g) => g.length > safeLimit);

  if (oversized) {
    return {
      count,
      limit: safeLimit,
      fits: count <= safeLimit,
      batched: false,
      overflow: Math.max(0, count - safeLimit),
      batches: [],
      groups: groups.length,
      unsplittable: true,
      danglingRefs: [...new Set(dangling)],
      note:
        `无法安全分批：有一组 ${oversized.length} 条动作互相有 $ref 依赖，自己就超过上限 ${safeLimit}。` +
        '把它们拆开会把 cabinet.create 和它的 cabinet.place 分到两批 —— 第二批会引一个不存在的对象。' +
        '所以这里**不给批次、也不截断**：请把需求拆成几次说。',
    };
  }

  const batches: AiAction[][] = [];
  let cur: number[] = [];
  for (const g of groups) {
    if (cur.length + g.length > safeLimit) {
      batches.push(cur.map((i) => actions[i]!));
      cur = [];
    }
    cur.push(...g);
  }
  if (cur.length > 0) batches.push(cur.map((i) => actions[i]!));

  const fits = count <= safeLimit;
  const batched = batches.length > 1;
  const note = fits
    ? `一批装得下（${count} ≤ ${safeLimit}）：走的仍是既有的 dryRunPlan → 预览 → commitPlan。`
    : `一批装不下（${count} > ${safeLimit}）：按 $ref 依赖安全拆成 ${batches.length} 批，每批各走一次既有链路。` +
      '**上限没有改**（仍是 ' +
      safeLimit +
      '），每批仍然整份通过或整份拒绝 —— 分批只是把"一次说不完"变成"分几次说清楚"，' +
      '每批更小、影响面更小。**没有任何动作被丢弃**。';

  return {
    count,
    limit: safeLimit,
    fits,
    batched,
    overflow: Math.max(0, count - safeLimit),
    batches,
    groups: groups.length,
    unsplittable: false,
    danglingRefs: [...new Set(dangling)],
    note,
  };
}
