/**
 * ══════════════════════════════════════════════════════════════════════
 *  订阅用量口径验收 —— 「按标准 token 显示」这件事本身要有断言看着
 *
 *  用户原话：
 *    "ai 的订阅用量怎么按标准使用 token 来显示，比如免费用户每天限制使用
 *     100 万 token，或者免费生成一次。订阅用户 1 亿 token 或每天生成 10 次
 *     以及不限量使用。"
 *
 *  ── 这批断言要证明什么 ──
 *    ① **档位数值就是用户说的那几个数**（100 万/日、1 亿/月、10 次/日、不限）。
 *       这类需求最常见的翻车是"实现得挺好，但数字不是他说的那个"——
 *       而数字错了在界面上完全看不出来，只能靠断言钉住。
 *    ② **显示口径**：万 / 亿，不是"1234567"。且不限档显示"不限"，
 *       不是显示 9007199254740991（那是拿魔数当"无限"用的典型事故）。
 *    ③ **两个维度任一用尽即止**，并且**说清是哪一条拦的**。
 *    ④ **对话只花 token、不算生成次数** —— 否则免费档每天那 1 次
 *       会被"踢脚线一般多高"这种问题吃掉，用户还没开始生成就没额度了。
 *    ⑤ **跨日 / 跨月归零**，且老记录（只有 monthTokens/dayCalls）不会被编造成
 *       生成次数 —— 少记一笔是少收，编一个数是造假。
 *
 *  ── 为什么纯函数也要单独验 ──
 *    界面上"还剩多少"是四个地方共用的同一份视图；共用 = 一处错四处错。
 *    在这里把口径钉死，比在四个界面上各截一张图可靠得多。
 * ══════════════════════════════════════════════════════════════════════
 */
import { PLANS, planOf, quotaView, checkQuota, applyUsage, normalizeUsage, formatTokens, formatCount } from '../shared/quota.mjs';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n\u2500\u2500 ${t} \u2500\u2500`);
}

// ───────────────────────── ① 档位数值 ─────────────────────────
section('1. 档位数值就是用户点名的那几个数');

ok('1.1 免费档：每日 100 万 token', PLANS.free.tokens.limit === 1_000_000 && PLANS.free.tokens.period === 'day',
  JSON.stringify(PLANS.free.tokens));
ok('1.2 免费档：每日 1 次生成', PLANS.free.generations.limit === 1 && PLANS.free.generations.period === 'day',
  JSON.stringify(PLANS.free.generations));
ok('1.3 订阅档：每月 1 亿 token', PLANS.pro.tokens.limit === 100_000_000 && PLANS.pro.tokens.period === 'month',
  JSON.stringify(PLANS.pro.tokens));
ok('1.4 订阅档：每日 10 次生成', PLANS.pro.generations.limit === 10 && PLANS.pro.generations.period === 'day',
  JSON.stringify(PLANS.pro.generations));
ok('1.5 不限档：两个维度都是 null（不是 MAX_SAFE_INTEGER 那种假无限）',
  PLANS.unlimited.tokens.limit === null && PLANS.unlimited.generations.limit === null,
  JSON.stringify(PLANS.unlimited));
ok('1.6 未知档位一律按免费处理（宁可少给，不能因为一个错值放行）', planOf('不存在的档').id === 'free');

// ───────────────────────── ② 显示口径 ─────────────────────────
section('2. 按万 / 亿显示，且"不限"就是"不限"');

ok('2.1 不足 1 万原样给（个位数也要看得见）', formatTokens(9876) === '9876', formatTokens(9876));
ok('2.2 1 万以上压成"万"', formatTokens(123_456) === '12.3 万', formatTokens(123_456));
ok('2.3 100 万整显示"100 万"（不留 .0 尾巴）', formatTokens(1_000_000) === '100 万', formatTokens(1_000_000));
ok('2.4 1 亿显示"1 亿"', formatTokens(100_000_000) === '1 亿', formatTokens(100_000_000));
ok('2.5 1.2345 亿保留两位（1.2 亿 与 1.23 亿 差 300 万，不能省）',
  formatTokens(123_456_789) === '1.23 亿', formatTokens(123_456_789));
ok('2.6 非法值显示 ∞ 而不是 NaN', formatTokens(Number.NaN) === '∞', formatTokens(Number.NaN));
ok('2.7 次数不带单位（10 次就是 10 次）', formatCount(10) === '10', formatCount(10));

{
  const v = quotaView('unlimited', null);
  ok('2.8 不限档的限额显示"不限"，不是天文数字', v.tokens.limitText === '不限' && v.generations.limitText === '不限',
    `${v.tokens.limitText} / ${v.generations.limitText}`);
  ok('2.9 不限档不会被判成"快用完了"（pct 无意义）', v.tokens.pct === 0 && v.tokens.exhausted === false);
  ok('2.10 不限档永不拦截', checkQuota('unlimited', null, { counts: true }).ok === true);
}

// ───────────────────────── ③ 任一用尽即止 + 说清是哪条 ─────────────────────────
section('3. 两个维度任一用尽即止，且必须说清是哪一条拦的');

{
  const day = new Date('2026-05-10T10:00:00Z');
  // 免费档：token 还远没用完（5 万 / 100 万），但今天已经生成过 1 次
  const used = { day: '2026-05-10', month: '2026-05', dayTokens: 50_000, monthTokens: 50_000, dayGenerations: 1, monthGenerations: 1, dayCalls: 3, totalTokens: 50_000, totalGenerations: 1, totalCalls: 3 };
  const blocked = checkQuota('free', used, { counts: true }, day);
  ok('3.1 生成次数用尽 → 拦住', blocked.ok === false && blocked.code === 'QUOTA_GENERATIONS', JSON.stringify(blocked.code));
  ok('3.2 拦住的原因点名是"生成次数"（用户才知道该等明天还是该升级）',
    String(blocked.error).includes('生成次数'), String(blocked.error));
  const asChat = checkQuota('free', used, { counts: false }, day);
  ok('3.3 同一份用量下**对话仍然放行**（提问不该吃掉生成额度）', asChat.ok === true, String(asChat.error));

  const v = quotaView('free', used, day);
  ok('3.4 视图里 blockedBy 是 generations（界面照它说，不许自己猜）', v.blockedBy === 'generations', String(v.blockedBy));
  ok('3.5 token 那一维仍有剩余（还剩 95 万）', v.tokens.remain === 950_000 && v.tokens.remainText === '95 万', `${v.tokens.remain} / ${v.tokens.remainText}`);
  ok('3.6 百分比按 token 那一维算对（5 万/100 万 = 5%）', v.tokens.pct === 5, String(v.tokens.pct));
}

{
  const day = new Date('2026-05-10T10:00:00Z');
  const used = { day: '2026-05-10', month: '2026-05', dayTokens: 1_000_000, monthTokens: 1_000_000, dayGenerations: 0, monthGenerations: 0, dayCalls: 9, totalTokens: 1_000_000, totalGenerations: 0, totalCalls: 9 };
  const r = checkQuota('free', used, { counts: true }, day);
  ok('3.7 token 用尽 → 拦住，且代码是 QUOTA_TOKENS', r.ok === false && r.code === 'QUOTA_TOKENS', JSON.stringify(r.code));
  ok('3.8 原因点名是 token', String(r.error).includes('token'), String(r.error));
  ok('3.9 生成次数还剩 1 次也不放行（任一用尽即止）', quotaView('free', used, day).blockedBy === 'tokens');
}

// ───────────────────────── ④ 记账 ─────────────────────────
section('4. 记账：生成算次数、对话不算');

{
  const day = new Date('2026-05-10T10:00:00Z');
  const u0 = normalizeUsage(null, day);
  ok('4.1 空记录起步全 0', u0.dayTokens === 0 && u0.dayGenerations === 0 && u0.dayCalls === 0);
  const u1 = applyUsage(u0, { tokens: 1290, generation: true }, day);
  ok('4.2 一次生成：token 与次数都加', u1.dayTokens === 1290 && u1.dayGenerations === 1 && u1.dayCalls === 1, JSON.stringify(u1));
  const u2 = applyUsage(u1, { tokens: 136 }, day);
  ok('4.3 一次对话：只加 token 与调用次数，生成次数不动',
    u2.dayTokens === 1426 && u2.dayGenerations === 1 && u2.dayCalls === 2 && u2.totalGenerations === 1, JSON.stringify(u2));
  const u3 = applyUsage(u2, { tokens: Number.NaN }, day);
  ok('4.4 服务商没返回用量时按 0 记，但次数照样记（不编造 token 数）',
    u3.dayTokens === 1426 && u3.dayCalls === 3, JSON.stringify(u3));
  ok('4.5 负数 token 不倒扣', applyUsage(u2, { tokens: -500 }, day).dayTokens === 1426);
}

// ───────────────────────── ⑤ 跨周期归零与老记录 ─────────────────────────
section('5. 跨日 / 跨月归零，且不把老记录编造成生成次数');

{
  const today = new Date('2026-05-10T10:00:00Z');
  const nextDay = new Date('2026-05-11T10:00:00Z');
  const u = { day: '2026-05-10', month: '2026-05', dayTokens: 999_999, monthTokens: 999_999, dayGenerations: 1, monthGenerations: 1, dayCalls: 5, totalTokens: 999_999, totalGenerations: 1, totalCalls: 5 };
  ok('5.1 当天：token 快用完了', quotaView('free', u, today).tokens.remain === 1);
  const next = normalizeUsage(u, nextDay);
  ok('5.2 跨日：每日 token 与生成次数都归零', next.dayTokens === 0 && next.dayGenerations === 0 && next.dayCalls === 0, JSON.stringify(next));
  ok('5.3 跨日：累计不清零（累计是账本，不是额度）', next.totalTokens === 999_999 && next.totalGenerations === 1);
  ok('5.4 跨日归零是在**读取处**判的，不需要任何定时器', quotaView('free', u, nextDay).generations.used === 0);

  const nextMonth = normalizeUsage(u, new Date('2026-06-01T00:00:00Z'));
  ok('5.5 跨月：月度 token 归零', nextMonth.monthTokens === 0 && nextMonth.monthGenerations === 0, JSON.stringify(nextMonth));

  // 老记录：只有 monthTokens / dayCalls，没有"生成次数"这个维度
  const legacy = { day: '2026-05-10', month: '2026-05', monthTokens: 12_000, dayCalls: 7, totalTokens: 12_000, totalCalls: 7 };
  const norm = normalizeUsage(legacy, today);
  ok('5.6 老记录的月度 token 照常读得到', norm.monthTokens === 12_000);
  ok('5.7 老记录**不**被编造成生成次数（少记是少收，编数是造假）', norm.dayGenerations === 0, String(norm.dayGenerations));
  ok('5.8 老记录的 dayCalls 只用于显示调用次数，不顶替生成次数', norm.dayCalls === 7);
}

console.log(`\n${'='.repeat(64)}`);
console.log(`订阅用量口径验收：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
