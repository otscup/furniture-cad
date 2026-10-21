#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  变异测试：焦点栈（2026-10-21）
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

const TARGETS = {
  focus: join(appDir, 'shared', 'focusStack.mjs'),
};

const BACKUP = {};
for (const [k, f] of Object.entries(TARGETS)) BACKUP[k] = readFileSync(f, 'utf8');
function restoreAll() {
  for (const [k, f] of Object.entries(TARGETS)) {
    try { writeFileSync(f, BACKUP[k], 'utf8'); } catch { /* 尽力而为 */ }
  }
}
process.on('exit', restoreAll);
process.on('SIGINT', () => { restoreAll(); process.exit(130); });
process.on('uncaughtException', (e) => {
  console.error('变异脚本异常：' + (e?.message ?? e));
  restoreAll();
  process.exit(1);
});

let pass = 0;
let fail = 0;
const failures = [];

function runAcceptance() {
  try {
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', join(here, 'focus-stack-acceptance.ts')],
      { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const m = out.match(/失败 (\d+) 项/);
    const names = [...out.matchAll(/^  ✗ (.+)$/gm)].map((x) => x[1]);
    return { count: m ? Number(m[1]) : 0, names };
  } catch (e) {
    const out = String(e?.stdout ?? '') + String(e?.stderr ?? '');
    const m = out.match(/失败 (\d+) 项/);
    const names = [...out.matchAll(/^  ✗ (.+)$/gm)].map((x) => x[1]);
    return { count: m ? Number(m[1]) : 99, names };
  }
}

function mutate(label, file, from, to, expectRed) {
  const original = readFileSync(file, 'utf8');
  if (!original.includes(from)) {
    fail++;
    failures.push(label + '（变异锚点找不到）');
    console.log(`  ✗ ${label} — 锚点不存在，测不了`);
    return;
  }
  try {
    writeFileSync(file, original.split(from).join(to), 'utf8');
    const r = runAcceptance();
    const red = r.count > 0;
    const caught = red && r.names.some((n) => n.includes(expectRed));
    if (caught) {
      pass++;
      console.log(`  ✓ ${label} → ${r.count} 条变红（含「${expectRed}」）`);
    } else {
      fail++;
      failures.push(label + (red ? '（红了但红错地方：' + r.names.join('|') + '）' : '（仍全绿 —— 断言没守住）'));
      console.log(`  ✗ ${label} — ${red ? '红了但红错地方' : '仍全绿'}`);
    }
  } finally {
    writeFileSync(file, original, 'utf8');
  }
}

console.log('变异测试：焦点栈');
console.log('='.repeat(64));

console.log('\n1. 焦点推导');
mutate('★ 焦点不含柜体 id（模型对不上号）', TARGETS.focus,
  "      cabinetId: cabId,",
  "      cabinetId: '',",
  '柜体 id 对');
mutate('★ 焦点不含柜体名（用户这么叫它时对不上）', TARGETS.focus,
  "      cabinetName: cab.name ?? cabId,",
  "      cabinetName: '',",
  '柜体名对（用户这么叫它）');
mutate('★ 焦点不含绝对值快照（相对量算不出来）', TARGETS.focus,
  "      entry.snapshot = { width: cab.params.width, height: cab.params.height, depth: cab.params.depth };",
  "      entry.snapshot = undefined;",
  '绝对值快照带上了');
mutate('★ 失败的步骤也进焦点（模型说了不算的也算了）', TARGETS.focus,
  "    if (!st || st.ok !== true) continue;",
  "    if (!st) continue;",
  '失败的步骤不产生焦点');
mutate('★ 改动字段认不出来（改了什么不知道）', TARGETS.focus,
  "  if (p.includes('width')) return '宽';",
  "  if (p.includes('width')) return '某项';",
  '改动的字段被认出来');

console.log('\n2. 从历史推导');
mutate('★ 历史里的结构化步骤被忽略（只剩退化路径）', TARGETS.focus,
  "    if (steps.length > 0) {",
  "    if (false) {",
  '从历史推出焦点');
mutate('★ 退化路径抠不出柜体名', TARGETS.focus,
  "  const m = /[「『]([^」』]+)[」』]/.exec(text);",
  "  const m = null;",
  '退化路径：从人话里也能抠出柜体名');

console.log('\n3. 渲染');
mutate('★ 渲染里不给绝对值（模型没基准）', TARGETS.focus,
  "      if (dims.length) parts.push(`现在 ${dims.join(' × ')}`);",
  "      if (dims.length) parts.push('');",
  '渲染里有当前绝对值');
mutate('★ 渲染里不写「用绝对值换算」', TARGETS.focus,
  "  lines.push('    「再加 N」这类**相对量**，用上面的**当前绝对值**换算成目标值（例：现在宽 1800，用户说「再加 200」⇒ 目标 2000）。');",
  "  lines.push('');",
  '渲染里说了「用绝对值换算」');
mutate('★ 渲染里不写「别替用户挑」', TARGETS.focus,
  "  lines.push('  ★ 如果焦点里有**多个**柜体，而用户的话没点名，**问清楚是哪一台**（不要替用户挑）。');",
  "  lines.push('');",
  '渲染里说了「别替用户挑」');

console.log('\n' + '-'.repeat(64));
const final = runAcceptance();
if (final.count === 0) {
  pass++;
  console.log('  ✓ 还原后验收恢复全绿');
} else {
  fail++;
  failures.push('还原后验收没有恢复全绿');
  console.log('  ✗ 还原后验收没有恢复全绿：' + final.names.join(' | '));
}

console.log('='.repeat(64));
if (fail === 0) {
  console.log(`变异测试：通过 ${pass} 项，失败 0 项`);
  console.log('每个变异都被对应断言抓住 —— 断言是真的在守东西。');
} else {
  console.log(`变异测试：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
