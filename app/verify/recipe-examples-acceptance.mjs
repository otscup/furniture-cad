#!/usr/bin/env node
/**
 * 配方范例验收（2026-10-22）
 *
 * ── 它守的是什么 ──
 *   配方 few-shot 样例是**照抄给模型看的** ⇒ 样例错了，模型就照着错。
 *   而手写样例极易过期（我第一版 10 个里 4 个过不了契约校验）。
 *
 *   所以这里钉三件事：
 *   1. 每个样例的动作都**过契约校验**（参数名/必填/枚举都对）
 *   2. 样例引用的配方**都存在**（不悬空）
 *   3. ★ 配方的 steps 里**没有过时或不存在���动作名**
 *      （原来 steps 写「用 cabinet.update_object 设 doors.count」，
 *       而 AI 动作清单里**根本没有** cabinet.update_object —— 那是 MCP 工具名。
 *       模型照着做必然失败，而这类错没有任何验收会抓。）
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RECIPE_EXAMPLES, checkExamples, renderExamples } from '../shared/recipeExamples.mjs';
import { RECIPES, matchRecipes, renderRecipes } from '../shared/recipes.mjs';
import { ACTIONS } from '../shared/aiContract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  v ' + name); }
  else { fail += 1; failures.push(name); console.log('  x ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('配方范例验收');
console.log('='.repeat(64));

console.log('\n1. 样例必须过契约校验');
{
  const r = checkExamples();
  ok('★ 所有样例过契约校验', r.ok, r.errors.join('\n      '));
}

console.log('\n2. 样例引用的配方都要存在');
{
  const ids = new Set(RECIPES.map((r) => r.id));
  for (const ex of RECIPE_EXAMPLES) {
    ok('样例 ' + ex.recipe + ' 引用的配方存在', ids.has(ex.recipe), '已知配方：' + [...ids].join(', '));
  }
}

console.log('\n3. ★ 规划通道的配方里不能有 MCP 工具名（AI 动作里没有 cad.*）');
{
  const KNOWN = new Set(Object.keys(ACTIONS));
  for (const r of RECIPES) {
    for (const step of [...(r.steps ?? []), ...(r.traps ?? [])]) {
      // 找形如 cabinet.xxx / cad.xxx 的词（下划线也算）
      const names = step.match(/\b(?:cabinet|assembly|project|cad)\.[a-zA-Z_]+/g) ?? [];
      for (const nm of names) {
        if (nm.startsWith('cad.')) continue;   // MCP 工具名，由第 4 节按通道查
        ok('配方 ' + r.id + ' 提到的动作 ' + nm + ' 在契约里', KNOWN.has(nm), step.slice(0, 100));
      }
    }
  }
}

console.log('\n4. ★ 两条通道的配方口径必须分开');
{
  const matched = matchRecipes('给我来个衣柜');
  ok('「衣柜」能命中配方', matched.length > 0);
  const actionBlock = renderRecipes(matched, { channel: 'action' });
  const agentBlock = renderRecipes(matched, { channel: 'agent' });
  ok('★ 规划通道的配方里没有 cad.* 工具名', !/\bcad\.[a-zA-Z_]+/.test(actionBlock), actionBlock.slice(0, 200));
  ok('★ 规划通道的配方里没有 MCP 步骤', !actionBlock.includes('cad.create_assembly'));
}

console.log('\n5. 范例要真的被注入');
{
  const matched = matchRecipes('给我来个衣柜');
  ok('「衣柜」能命中配方', matched.length > 0);
  // ★ renderExamples 收的是**用户原话**（按说话方式挑范例），不是配方数组。
  const text = renderExamples('给我来个衣柜');
  ok('★ 渲染出范例', text.length > 0);
  ok('范例里带用户原话', text.includes('用户说：'));
  ok('范例里带动作 JSON', text.includes('"actions"'));
  ok('没命中时不渲染', renderExamples('把柜子改宽点') === '');
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
