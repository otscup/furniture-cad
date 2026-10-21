#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  变异测试：灯带 / 玻璃面板（2026-10-21）
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
  views: join(appDir, 'src', 'core', 'geometry', 'views.ts'),
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
      ['--experimental-strip-types', join(here, 'led-glass-acceptance.ts')],
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
    writeFileSync(file, original.replace(from, to), 'utf8');
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

console.log('变异测试：灯带 / 玻璃面板');
console.log('='.repeat(64));

console.log('\n1. 灯带');
mutate('★ 灯带整个不画了', TARGETS.views,
  "            if (ledStyle !== 'none' && openUnit) {",
  "            if (false) {",
  'front 画了灯带');
mutate('★ 带门分区也画灯带（外面不该看见）', TARGETS.views,
  "            if (ledStyle !== 'none' && openUnit) {",
  "            if (ledStyle !== 'none') {",
  '带门分区在内部图上也不画灯带槽');
mutate('★ front 槽壁间距过大（不是靠前的细槽）', TARGETS.views,
  "      const wall = Math.max(3, t * 0.3);",
  "      const wall = Math.max(3, t * 2.0);",
  'front 槽壁间距很小');
mutate('★ center 的两条线间距过小（挤在一起）', TARGETS.views,
  "      const gap = t * 0.9;",
  "      const gap = t * 0.05;",
  'center 两条线**分开**');
mutate('★ angled45 的斜线不 45 度了', TARGETS.views,
  "      P.line(x0 + 0, x0 + reach, zFront, zFront + reach, L_HW, 0.8);",
  "      P.line(x0 + 0, x0 + reach * 3, zFront, zFront + reach, L_HW, 0.8);",
  'angled45 有 45° 斜线');

console.log('\n2. 玻璃面板');
mutate('★ 玻璃不画斜线了（循环体直接跳过）', TARGETS.views,
  "                for (let k = left - zHi; k <= right - zLo; k += step) {",
  "                for (let k = left - zHi; k <= right - zLo; k += step) { continue;",
  '玻璃门有满铺的 45° 斜线');
mutate('★ 玻璃斜线不是 45 度了（少裁剪）', TARGETS.views,
  "                  P.line(yFrom + k, yTo + k, yFrom, yTo, L_FRONT, 0.6);",
  "                  P.line(yFrom + k, yTo + k, yFrom, yTo * 0.5, L_FRONT, 0.6);",
  '严格 45°');
mutate('★ 玻璃间距不均匀（步进抖动）', TARGETS.views,
  "                for (let k = left - zHi; k <= right - zLo; k += step) {",
  "                for (let k = left - zHi; k <= right - zLo; k += step * (1 + (k % 7) * 0.1)) {",
  '玻璃斜线**等距**');
mutate('★ 玻璃斜线画到门外（不裁剪 x）', TARGETS.views,
  "                  P.line(yFrom + k, yTo + k, yFrom, yTo, L_FRONT, 0.6);",
  "                  P.line(yFrom + k - 400, yTo + k - 400, yFrom, yTo, L_FRONT, 0.6);",
  '都落在门板范围内');

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