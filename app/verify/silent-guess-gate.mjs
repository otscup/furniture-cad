#!/usr/bin/env node
/**
 * ★ 静默猜测发布闸门（2026-10-22）
 *
 * ── 它守的是什么 ──
 *   规则 6b 允许模型「先按默认值做，但必须标出来」。
 *   如果哪天有人改了提示词、把规则 6b 删了，或者模型开始不标了，
 *   **没有任何验收会红** —— 准确率可能还看得出点差别，但很不显眼。
 *
 *   ⇒ 需要一个**专门盯这件事**的闸门。
 *
 * ── 判据 ──
 *   「该问而没问」的用例里，模型给了动作却**没说**自己猜了 ⇒ 静默猜测。
 *   比率 = 静默猜测次数 / 「该问而没问」的用例里给了动作的次数。
 *
 * ── 阈值怎么定 ──
 *   按**实测值**留 3 倍余量（跟 verify:export-perf 一个路子）。
 *   实测：规则 6b 之前 ≈ 100%（每条都猜、每条都不说），
 *   之后单柜 3 次 / 多柜 1 次 ⇒ 比率约 2%。
 *   门槛取 **10%** —— 抓的是「规则被删了 / 模型不标了」这种量级劣化，
 *   不是抓 1~2 次的抖动（那会天天误报）。
 *
 * ── 为什么不能靠 pass^k 兜底 ──
 *   静默猜测**不一定降低 pass^k** —— 模型猜对了、也标了，pass^k 不变；
 *   模型猜对了、**但没标**，pass@k 也不变（动作名对）。
 *   ⇒ 它是一个**独立维度**，必须单独量。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

/** 静默猜测比率的上限（10%）—— 抓量级劣化，不抓抖动。 */
export const MAX_SILENT_GUESS_RATE = 0.1;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  v ' + name); }
  else { fail += 1; failures.push(name); console.log('  x ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('静默猜测发布闸门');
console.log('='.repeat(64));

console.log('\n1. 闸门的判据本身要成立');
{
  const evalSrc = readFileSync(join(here, 'nlu-eval.ts'), 'utf8');
  ok('★ 评测卡统计了「静默猜测」', evalSrc.includes('silentGuess'));
  ok('★ 静默猜测只在「该问而没问」的用例上判定',
    /c\.wantClarify[\s\S]{0,200}silentGuess/.test(evalSrc) ||
    /silentGuess[\s\S]{0,200}c\.wantClarify/.test(evalSrc),
    '判据必须限定在 wantClarify 的用例上（其他用例用户**给了**数字，不该标）');
  ok('★ 判定同时看 reason 与 reply（模型两种都用过）',
    evalSrc.includes('reasons') && evalSrc.includes('reply'));
}

console.log('\n2. 规则 6b 必须还在提示词里');
{
  const contract = readFileSync(join(appDir, 'shared', 'aiContract.mjs'), 'utf8');
  ok('★ 规则 6b 存在', contract.includes('6b.'));
  ok('★ 点名了 【猜】 标记', contract.includes('【猜】'));
  ok('★ 明说「不许既不标也不问」', /既不标也不问/.test(contract));
}

console.log('\n3. 界面必须把「猜」显示出来（看不见 = 白标）');
{
  const planView = readFileSync(join(appDir, 'src', 'ui', 'panels', 'PlanRunView.tsx'), 'utf8');
  ok('★ 干跑预览高亮', planView.includes('这是 AI 猜的'));
  const css = readFileSync(join(appDir, 'src', 'styles.css'), 'utf8');
  ok('★ 样式不是灰色小字（有背景与左边框）',
    /\.plan-guess \{[^}]*background/.test(css) && /\.plan-guess \{[^}]*border-left/.test(css));
}

console.log('\n4. 阈值本身');
{
  ok('★ 阈值不大于 10%（抓量级劣化，不抓抖动）', MAX_SILENT_GUESS_RATE <= 0.1, String(MAX_SILENT_GUESS_RATE));
  ok('★ 阈值不小于 1%（不是 0 —— 0 意味着一次抖动就红）', MAX_SILENT_GUESS_RATE >= 0.01);
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log('通过 ' + pass + ' 项，失败 0 项');
  console.log('闸门成立。★ 注意：真正的比率由 eval:nlu 跑出来（' 
    + '那需要真网关、几分钟）；本闸门守的是「判据与机制没被拆掉」。');
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  for (const f of failures) console.log('  x ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
