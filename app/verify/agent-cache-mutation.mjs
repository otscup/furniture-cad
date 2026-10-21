#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  变异测试：Agent 提示词缓存（P0-1，2026-10-21）
 *
 *  每个变异 = 故意改坏实现 → 验收必须变红 → 自动还原。
 *  ★ 安全网：备份 + exit/SIGINT/uncaughtException 都还原。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

const TARGETS = {
  agent: join(appDir, 'server', 'agentLoop.mjs'),
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
      ['--experimental-strip-types', join(here, 'agent-cache-acceptance.ts')],
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

console.log('变异测试：Agent 提示词缓存');
console.log('='.repeat(64));

console.log('\n1. 位置：动态必须在静态之后');
mutate('★ 静态规则被挪到动态之后（缓存全废）', TARGETS.agent,
  "  const systemPrompt = staticRules + '\\n' + dynamicContext;",
  "  const systemPrompt = dynamicContext + '\\n' + staticRules;",
  '拼装顺序是 static 在前');
mutate('★ 静态规则整个被丢掉', TARGETS.agent,
  "  const systemPrompt = staticRules + '\\n' + dynamicContext;",
  "  const systemPrompt = dynamicContext;",
  '拼装顺序是 static 在前');

console.log('\n2. 每轮变的内容必须在动态段');
mutate('★ 纠正记忆被挪回静态段', TARGETS.agent,
  "    rulesBlock,",
  "    '',",
  'rulesBlock（纠正记忆） 在动态段里');
mutate('★ 配方被挪回静态段', TARGETS.agent,
  "    recipeBlock,",
  "    '',",
  'recipeBlock（配方库） 在动态段里');
mutate('★ 序列范例被挪回静态段', TARGETS.agent,
  "    seqHint,",
  "    '',",
  'seqHint（序列范例） 在动态段里');
mutate('★ 项目上下文被挪回静态段', TARGETS.agent,
  "    projectContextText,",
  "    '',",
  'projectContextText（项目上下文） 在动态段里');

console.log('\n3. 静态段不能夹带动态');
mutate('★ 静态段夹带当前房间（每轮都变）', TARGETS.agent,
  "- 完成后调用 cad.validate 确认 0 错误。",
  "- 完成后调用 cad.validate 确认 0 错误。当前房间是 ${roomId || '未知'}。",
  '静态段里没有夹带动态变量');
mutate('★ 静态段夹带 draft id（每轮都变）', TARGETS.agent,
  "- 完成后调用 cad.validate 确认 0 错误。",
  "- 完成后调用 cad.validate 确认 0 错误。当前 draft 是 ${currentDraftId || '无'}。",
  '静态段里没有夹带动态变量');

console.log('\n4. 内容不能丢');
mutate('★ 丢掉「所有写操作只进 draft」这条铁律', TARGETS.agent,
  "- 所有写操作只进 draft，不碰 live。",
  "",
  '关键内容还在：所有写操作只进 draft');
mutate('★ 丢掉「完成后调用 cad.validate」', TARGETS.agent,
  "- 完成后调用 cad.validate 确认 0 错误。",
  "",
  '关键内容还在：完成后调用 cad.validate');

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
