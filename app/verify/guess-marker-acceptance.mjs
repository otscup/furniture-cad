#!/usr/bin/env node
/**
 * 「猜」的标记验收（2026-10-22）
 *
 * ── 它守的是什么 ──
 *   规则 6b 给模型第三条路：缺关键数字时**先按默认值做，但必须标出来**。
 *   这条路成立的前提是 —— **用户真的看得见那个标记**。
 *
 *   实测过 122 条用例后发现的缺陷：
 *     「下面加个抽屉」→ 「净宽先按柜宽 1800、1 个抽屉来做；不对告诉我我改」
 *   ★ 违反规则 6（别凭空发明关键数字），
 *     而且是最危险的形态：**看起来在征求意见，实际已经动手了**。
 *
 * ⇒ 这套机制的三条腿：
 *   ① 提示词教模型怎么标（规则 6b）
 *   ② 识别标记的函数（shared/ai/guessMarker.ts）
 *   ③ 界面把它**高亮**（不是混在灰色小字里）
 *   缺任何一条，机制就是空的。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GUESS_MARK, hasGuess, splitGuess } from '../src/ai/guessMarker.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  v ' + name); }
  else { fail += 1; failures.push(name); console.log('  x ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('「猜」的标记验收');
console.log('='.repeat(64));

console.log('\n1. 识别函数');
{
  ok('普通 reason 不是猜', !hasGuess('用户要求加一个抽屉区'));
  ok('带标记的是猜', hasGuess(GUESS_MARK + '净宽按 600'));
  ok('标记在中间也能认', hasGuess('加了个抽屉区，' + GUESS_MARK + '净宽按 600'));
  ok('空串不是猜', !hasGuess(''));
  ok('undefined 不是猜', !hasGuess(undefined));
  ok('null 不是猜', !hasGuess(null));
}

console.log('\n2. 拆分');
{
  const r = splitGuess(GUESS_MARK + '净宽按 600（用户没给宽度）');
  ok('★ 猜的部分被拆出来', r.guess === '净宽按 600（用户没给宽度）', JSON.stringify(r));
  ok('★ 其余部分为空', r.rest === '', JSON.stringify(r));
  const r2 = splitGuess('用户要加抽屉区。' + GUESS_MARK + '净宽按 600');
  ok('★ 前半段归 rest', r2.rest === '用户要加抽屉区。', JSON.stringify(r2));
  ok('★ 后半段归 guess', r2.guess === '净宽按 600', JSON.stringify(r2));
  const r3 = splitGuess('没有标记的普通理由');
  ok('没有标记时 guess 为空', r3.guess === '');
  ok('没有标记时 rest 是原文', r3.rest === '没有标记的普通理由');
}

console.log('\n3. ★ 提示词教了模型怎么标');
{
  const contract = readFileSync(join(appDir, 'shared', 'aiContract.mjs'), 'utf8');
  ok('★ 规则 6b 存在', contract.includes('6b.') || contract.includes('【猜】'));
  ok('★ 规则里点名了 【猜】 标记', contract.includes(GUESS_MARK));
  ok('★ 规则说了「不许既不标也不问」', /既不标也不问/.test(contract));
}

console.log('\n4. ★ 界面把它高亮显示（不是混在灰色小字里）');
{
  const planView = readFileSync(join(appDir, 'src', 'ui', 'panels', 'PlanRunView.tsx'), 'utf8');
  ok('★ 干跑预览用了 guessMarker', planView.includes('splitGuess'));
  ok('★ 有专门的「这是 AI 猜的」标签', planView.includes('这是 AI 猜的'));
  const aiPanel = readFileSync(join(appDir, 'src', 'ui', 'panels', 'AIPanel.tsx'), 'utf8');
  ok('★ Agent 步骤也高亮', aiPanel.includes('hasGuess'));
  const css = readFileSync(join(appDir, 'src', 'styles.css'), 'utf8');
  ok('★ 样式里有 .plan-guess', css.includes('.plan-guess'));
  ok('★ 样式里有醒目的标签', css.includes('.plan-guess-tag'));
  ok('★ 不是灰色小字（有自己的背景与左边框）',
    /\.plan-guess \{[^}]*background/.test(css) && /\.plan-guess \{[^}]*border-left/.test(css));
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
