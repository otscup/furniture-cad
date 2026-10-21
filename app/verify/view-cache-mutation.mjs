#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  变异测试：视图缓存（2026-10-21）
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
      ['--experimental-strip-types', join(here, 'view-cache-acceptance.ts')],
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
    // 全部出现处都改（同一个 key 表达式在两个函数里都有，只改一处等于没测）
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

console.log('变异测试：视图缓存');
console.log('='.repeat(64));

console.log('\n1. 缓存不改变结果');
// 视图缓存的 key：把所有柜共用一个 ⇒ 视图串了
mutate('★ 视图缓存 key 固定（所有柜共用一份视图）', TARGETS.views,
  "  const key = cabinetContentKey(cab) + '@' + fx;",
  "  const key = 'FIXED-VIEWS';",
  '缓存键含柜子内容指纹');
// 指纹缓存的 key：同样固定 ⇒ 指纹串了
mutate('★ 指纹缓存 key 固定（所有柜共用一份指纹）', TARGETS.views,
  "  const key = cabinetContentKey(cab) + '@' + fx;",
  "  const key = 'FIXED-KEYS';",
  '缓存键含排布位置');

console.log('\n2. 失效边界');
mutate('★ 缓存键不含 params（改尺寸不失效）', TARGETS.views,
  "    p.width, p.height, p.depth, p.bodyLift, p.shelfFrontClearance,",
  "    p.bodyLift,",
  '改 params.width 后视图变了');
mutate('★ 缓存键不含 layout.units（加分区不失效）', TARGETS.views,
  "    cab.layout.units, cab.layout.backUnits ?? null, cab.layout.rows ?? null,",
  "    null, null, null,",
  '加分区后视图变了');
mutate('★ 缓存键含 placement（拖动也失效，优化白做）', TARGETS.views,
  "    cab.layout.units, cab.layout.backUnits ?? null, cab.layout.rows ?? null,",
  "    cab.layout.units, cab.layout.backUnits ?? null, cab.layout.rows ?? null, cab.placement,",
  '缓存键不含 placement');

console.log('\n3. 缓存结构');
mutate('★ 缓存没有上限（会无限涨）', TARGETS.views,
  "const LOCAL_VIEW_CACHE_MAX = 256;",
  "const LOCAL_VIEW_CACHE_MAX = 100000;",
  '缓存上限存在且 <= 512');
mutate('★ 缓存键不含排布位置 fx', TARGETS.views,
  "  const key = cabinetContentKey(cab) + '@' + fx;",
  "  const key = cabinetContentKey(cab);",
  '缓存键含排布位置');

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
