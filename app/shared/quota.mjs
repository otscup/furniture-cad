/**
 * ══════════════════════════════════════════════════════════════════════
 *  订阅档位与用量口径 —— 唯一真源
 *
 *  ── 为什么从 auth.mjs 里搬出来 ──
 *    额度这件事有**四个地方**要显示同一个数：
 *      服务端 /api/usage、账号面板（我的用量）、管理后台（每账号用量）、
 *      AI 面板（还剩几次生成）。
 *    四个地方各格式化一次 = 四份口径，而"差一点点"的口径最容易骗人：
 *    面板显示还剩 30%、后台显示已用 71%，谁都不会去查是四舍五入的问题，
 *    只会觉得系统不可信。所以**档位定义 + 格式化 + 已用/剩余计算**都在这里，
 *    四处一律 import，不许在 UI 里再算一遍。
 *
 *  ── 两个维度，任一用尽即止 ──
 *    token：按**周期**累计（免费按天、订阅按月）。
 *    生成次数：按天计。
 *    "免费用户每天 100 万 token 或 1 次生成"里的"或"就是这个意思 ——
 *    先撞上哪条就停在哪条，界面要**说清是哪条拦的**，不能只说"额度用完了"。
 *
 *    ⚠ 只有"生成"（/api/ai/plan）计次数；**对话**（/api/ai/chat）只计 token。
 *      否则免费档每天那 1 次会被"踢脚线一般多高"这种问题吃掉，
 *      用户还没开始生成就已经没额度了 —— 那是把提问当成消费，说不通。
 *
 *  ── 为什么不限档用 null 而不是 Number.MAX_SAFE_INTEGER ──
 *    MAX_SAFE_INTEGER 在 JSON 里是一个巨大的数字，界面必须到处写
 *    "if (limit >= MAX_SAFE_INTEGER) 显示 ∞"。漏写一处就显示
 *    "已用 12,345 / 9007199254740991"，比不显示更糟。
 *    null 只有一个意思：没有上限。判断是真判断，不是跟一个魔数比大小。
 *
 *  ── 数字显示：按 万 / 亿 ──
 *    "已用 1234567 token"没人看得懂是多少。行业标准是按数量级压成一个小数 + 单位。
 *    本系统是中文界面，所以用 万 / 亿，不用 K/M ——
 *    "120.5 万" 比 "1.2M" 更接近"我大概用了多少"的直觉。
 *    精确值放在 title 里，需要核对时能看到真实数字。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 档位表。改这里就等于改全系统 —— 界面上的档位说明也是从这张表生成的。
 *
 * limit: null = 不限。period: 'day' 按自然日、'month' 按自然月（UTC）。
 */
export const PLANS = {
  free: {
    id: 'free',
    label: '免费',
    tokens: { limit: 1_000_000, period: 'day' },
    generations: { limit: 1, period: 'day' },
    models: [],
  },
  pro: {
    id: 'pro',
    label: '专业',
    tokens: { limit: 100_000_000, period: 'month' },
    generations: { limit: 10, period: 'day' },
    models: [],
  },
  team: {
    id: 'team',
    label: '团队',
    tokens: { limit: 1_000_000_000, period: 'month' },
    generations: { limit: 100, period: 'day' },
    models: [],
  },
  unlimited: {
    id: 'unlimited',
    label: '不限',
    tokens: { limit: null, period: 'month' },
    generations: { limit: null, period: 'day' },
    models: [],
  },
};

/** models: [] 表示不限制模型；填了就是白名单 */
export const PLAN_IDS = Object.keys(PLANS);

export const PERIOD_TEXT = { day: '每日', month: '每月' };

/** 取档位（未知档位一律按免费处理 —— 宁可少给，不能因为一个错值放行） */
export function planOf(id) {
  return PLANS[id] ?? PLANS.free;
}

// ───────────────────────── 数字显示 ─────────────────────────

/** 压成 1~2 位小数，去掉无意义的尾随 0（12.00 → 12；12.30 → 12.3） */
function trim(n, digits) {
  const s = n.toFixed(digits);
  return s.replace(/\.?0+$/, '');
}

/**
 * token 数 → 人类可读。
 *   < 1 万       → 原样（个位数都要看得见，压成 0.8 万反而不精确）
 *   < 1 亿       → X 万（1 位小数足够，10.3 万 与 10.34 万 对"还剩多少"没区别）
 *   ≥ 1 亿       → X 亿（2 位小数，因为 1.20 亿 和 1.2 亿 差 200 万）
 */
export function formatTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '∞';
  if (v < 0) return '0';
  if (v < 10_000) return String(Math.round(v));
  if (v < 100_000_000) return `${trim(v / 10_000, 1)} 万`;
  return `${trim(v / 100_000_000, 2)} 亿`;
}

/** 次数。次数都是小整数，原样给 —— 套"万"只会平添疑问 */
export function formatCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '∞';
  return String(Math.round(v));
}

/** 精确值（悬浮提示用）：千分位，便于和账单核对 */
export function formatExact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '不限';
  return Math.round(v).toLocaleString('en-US');
}

// ───────────────────────── 用量记录 ─────────────────────────

/**
 * 归一化用量记录。
 *
 * 周期归零在**读取处**判，不在定时器里判 —— 没有定时器就没有"没跑到"的问题。
 *
 * 关于老记录：早期只记 monthTokens / dayCalls，没有"生成次数"这个维度。
 * 这里**不把 dayCalls 当成 dayGenerations** —— 那时对话与生成混在一个计数器里，
 * 拿它填进生成次数就是凭空造数（既可能多算也可能少算）。
 * 老记录就让它从 0 开始记：少记一笔是少收，编一个数才是造假。
 */
export function normalizeUsage(u, now = new Date()) {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const day = now.toISOString().slice(0, 10);
  const b = u ?? {};
  const inDay = b.day === day;
  const inMonth = b.month === month;
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  return {
    day,
    month,
    dayTokens: inDay ? num(b.dayTokens) : 0,
    monthTokens: inMonth ? num(b.monthTokens) : 0,
    dayGenerations: inDay ? num(b.dayGenerations) : 0,
    monthGenerations: inMonth ? num(b.monthGenerations) : 0,
    dayCalls: inDay ? num(b.dayCalls) : 0,
    totalTokens: num(b.totalTokens),
    totalGenerations: num(b.totalGenerations),
    totalCalls: num(b.totalCalls),
  };
}

/** 按周期取出"当前这期的已用 token" */
export function usedTokens(u, period) {
  return period === 'day' ? u.dayTokens : u.monthTokens;
}

/** 按周期取出"当前这期的已用生成次数" */
export function usedGenerations(u, period) {
  return period === 'day' ? u.dayGenerations : u.monthGenerations;
}

// ───────────────────────── 额度视图 ─────────────────────────

/**
 * 一个维度的视图（已用 / 限额 / 剩余 / 百分比 / 是否用尽）。
 * 限额为 null（不限）时 pct 恒为 0、exhausted 恒为 false —— 不存在"99.99% 用完了"。
 */
function dimView(spec, used) {
  const limit = spec?.limit ?? null;
  const unlimited = limit === null || limit === undefined;
  const remain = unlimited ? null : Math.max(0, limit - used);
  const pct = unlimited ? 0 : limit <= 0 ? 100 : Math.min(100, Math.round((used / limit) * 100));
  return {
    period: spec?.period ?? 'day',
    periodText: PERIOD_TEXT[spec?.period ?? 'day'] ?? '',
    limit,
    limitText: unlimited ? '不限' : formatTokens(limit),
    used,
    usedText: formatTokens(used),
    remain,
    remainText: unlimited ? '不限' : formatTokens(remain),
    pct,
    unlimited,
    exhausted: unlimited ? false : used >= limit,
  };
}

/**
 * 档位 + 用量 → 界面要显示的那一份数据。
 *
 * `blockedBy` 是"是哪一条拦的"：先撞上 token 就是 token，否则才是生成次数。
 * 界面必须照它说 —— "额度用完了"这句话没有任何可操作性，用户不知道是该等明天
 * 还是该升级档位。
 */
export function quotaView(planId, rawUsage, now = new Date()) {
  const plan = planOf(planId);
  const u = normalizeUsage(rawUsage, now);
  const tokens = dimView(plan.tokens, usedTokens(u, plan.tokens.period));
  const generations = dimView(
    { ...plan.generations, limit: plan.generations.limit },
    usedGenerations(u, plan.generations.period),
  );
  // 次数是整数，用"次"而不是 token 的那套单位
  generations.limitText = generations.unlimited ? '不限' : `${formatCount(generations.limit)} 次`;
  generations.usedText = `${formatCount(generations.used)} 次`;
  generations.remainText = generations.unlimited ? '不限' : `${formatCount(generations.remain)} 次`;

  const blockedBy = tokens.exhausted ? 'tokens' : generations.exhausted ? 'generations' : null;
  const blockReason = blockedBy
    ? blockedBy === 'tokens'
      ? `${tokens.periodText} token 额度已用完（${tokens.usedText} / ${tokens.limitText}）`
      : `${generations.periodText}生成次数已用完（${generations.usedText} / ${generations.limitText}）`
    : '';

  return {
    planId: plan.id,
    planLabel: plan.label,
    models: plan.models ?? [],
    tokens,
    generations,
    calls: { day: u.dayCalls, total: u.totalCalls, totalTokens: u.totalTokens, totalGenerations: u.totalGenerations },
    blockedBy,
    blockReason,
    used: u,
  };
}

/**
 * 额度检查 —— 在**发起调用之前**执行，不是事后统计。
 *
 * @param opts.counts 这次调用要不要算一次"生成"。对话传 false（只花 token）。
 */
export function checkQuota(planId, rawUsage, opts = {}, now = new Date()) {
  const plan = planOf(planId);
  const u = normalizeUsage(rawUsage, now);
  const view = quotaView(plan.id, u, now);
  if (view.tokens.exhausted) {
    return {
      ok: false,
      code: 'QUOTA_TOKENS',
      error: `${view.tokens.periodText} AI token 额度已用完（${view.tokens.usedText} / ${view.tokens.limitText}），请升级订阅档位或等下一周期`,
      view,
    };
  }
  if (opts.counts === true && view.generations.exhausted) {
    return {
      ok: false,
      code: 'QUOTA_GENERATIONS',
      error: `${view.generations.periodText}生成次数已用完（${view.generations.usedText} / ${view.generations.limitText}），请升级订阅档位或等明天再试`,
      view,
    };
  }
  return { ok: true, view, used: u };
}

/**
 * 把一次调用记进用量记录。
 *
 * provider 返回的 usage 可能缺字段、可能是 0、也可能整段没有 ——
 * 宁可少记也不要编造：缺 token 数时按 0 记，但**次数一定记上**，
 * 界面上如实显示"本次未返回用量"。凭空估一个数字会让账单不可信。
 *
 * @param opts.tokens      本次消耗的 token（prompt + completion）
 * @param opts.generation  true = 这是一次"生成"（计入每日生成次数）
 */
export function applyUsage(rawUsage, opts = {}, now = new Date()) {
  const u = normalizeUsage(rawUsage, now);
  const t = Number.isFinite(Number(opts.tokens)) ? Math.max(0, Number(opts.tokens)) : 0;
  u.dayTokens += t;
  u.monthTokens += t;
  u.totalTokens += t;
  u.dayCalls += 1;
  u.totalCalls += 1;
  if (opts.generation === true) {
    u.dayGenerations += 1;
    u.monthGenerations += 1;
    u.totalGenerations += 1;
  }
  return u;
}
