#!/usr/bin/env node
/**
 * NLU 用例集验收（2026-10-22）
 *
 * ── 它守的是什么 ──
 *   评测卡本身是**量尺**。尺子坏了，后面的所有结论都是错的。
 *   这一轮把用例从 21 条扩到 142 条 ⇒ 更要确保**每一条都是合理的**。
 *
 * 断言：
 *   1. 每条用例的 wantActions 都是**契约里真实存在的动作**
 *   2. 契约里的 cabinet.* 动作**全部有用例覆盖**（不然是「有能力但没测」）
 *   3. 每个场景都有**足够条数**（少于 N 条 ⇒ 场景分数的置信区间宽到没用）
 *   4. 该追问的用例**真的标了 wantClarify**（或 allowClarify）
 *   5. 用例是**口语**（不是命令式）—— 用例写成「nudge dx=-200」就失去意义了
 *   6. 用例文本**互不重复**（重复的等于没扩）
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIONS } from '../shared/aiContract.mjs';
import { CASES } from './nlu-eval.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  v ' + name); }
  else { fail += 1; failures.push(name); console.log('  x ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('NLU 用例集验收');
console.log('='.repeat(64));

// ── 抽出所有用例 ──

// ★ 直接 import —— **不要用正则去解析源码**：
//   我第一版就是这么干的，结果把多轮用例的 turns 子项也当成了独立用例
//   （142 条里混进 32 条子项），场景统计全错。
//   正则解析源码天生守不住改写。
const cases = CASES.map((c) => ({
  q: c.q,
  acts: c.wantActions ?? [],
  scenario: c.scenario,
  wantClarify: Boolean(c.wantClarify),
  allowClarify: Boolean(c.allowClarify),
  isTurn: Array.isArray(c.turns),
}));
console.log('  抽到用例 ' + cases.length + ' 条');

console.log('\n1. wantActions 必须是契约里真实存在的动作');
{
  const known = new Set(Object.keys(ACTIONS));
  const used = new Set();
  const bad = [];
  for (const c of cases) {
    for (const a of c.acts) {
      used.add(a);
      if (!known.has(a)) bad.push(c.q + ' → ' + a);
    }
  }
  ok('★ 没有不存在的动作', bad.length === 0, bad.slice(0, 5).join('\n      '));
  console.log('  覆盖了 ' + used.size + ' 个动作');
}

console.log('\n2. 契约里每个 cabinet.* 动作都要有用例覆盖');
{
  const known = new Set(Object.keys(ACTIONS));
  const used = new Set(cases.flatMap((c) => c.acts));
  const missing = [...known].filter((a) => !used.has(a) && a.startsWith('cabinet.'));
  ok('★ cabinet.* 动作全覆盖', missing.length === 0, '未覆盖：' + missing.join(', '));
}

console.log('\n3. 每个场景都要有足够条数');
{
  const byScen = {};
  for (const c of cases) byScen[c.scenario] = (byScen[c.scenario] ?? 0) + 1;
  console.log('  ' + JSON.stringify(byScen));
  // ★ 少于 20 条 ⇒ 一条抖一次就掉 5 个百分点，场景分数没法用来做判断
  for (const [sc, n] of Object.entries(byScen)) {
    ok('场景 ' + sc + ' 至少 20 条', n >= 20, '实际 ' + n);
  }
}

console.log('\n4. 该追问的用例标了 wantClarify / allowClarify');
{
  const bad = cases.filter((c) => c.acts.length === 0 && !c.wantClarify && !c.allowClarify);
  ok('★ 没有「无动作但也没标追问」的用例', bad.length === 0, bad.map((c) => c.q).slice(0, 5).join(' | '));
}

console.log('\n5. 用例必须是口语（不能是命令式）');
{
  // 命令式的写法会带点号或英文参数名（dx=、action=）
  const bad = cases.filter((c) => /\b(dx|dy|mm|param|value|action)=|cabinet\.[a-z]/.test(c.q));
  ok('★ 没有命令式的用例', bad.length === 0, bad.map((c) => c.q).slice(0, 5).join(' | '));
}

console.log('\n6. 用例文本互不重复（同场景内）');
{
  // ★ 判据是「**同场景内**的 q 不重复」——
  //   同一句话在不同场景出现是**合理的**：
  //   「踢脚改成100」在 single 场景是单轮，在 turns 场景是第二轮，
  //   考的**不是**同一件事。
  const byScen = new Map();
  for (const c of cases) {
    const key = c.scenario + '||' + c.q;
    byScen.set(key, (byScen.get(key) ?? 0) + 1);
  }
  const dup = [...byScen].filter(([, n]) => n > 1).map(([k]) => k.replace('||', ' / '));
  ok('★ 同场景内没有重复的用例', dup.length === 0, dup.slice(0, 5).join(' | '));
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log('通过 ' + pass + ' 项，失败 0 项');
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  for (const f of failures) console.log('  x ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
