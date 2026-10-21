#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  变异测试：新增动作（加上下分层 / 改门板材质，2026-10-21）
 *
 *  每个变异 = 故意改坏实现 → 验收必须变红 → 自动还原。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

const TARGETS = {
  contract: join(appDir, 'shared', 'aiContract.mjs'),
  compile: join(appDir, 'src', 'ai', 'compile.ts'),
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
      ['--experimental-strip-types', join(here, 'new-actions-acceptance.ts')],
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

console.log('变异测试：新增动作');
console.log('='.repeat(64));

console.log('\n1. 契约登记');
mutate('★ 契约里删掉 setUnitDoorMaterial', TARGETS.contract,
  "  'cabinet.setUnitDoorMaterial': {",
  "  'cabinet.setUnitDoorMaterial_DISABLED': {",
  '在契约里');
mutate('★ addUnit 删掉 rowIndex 参数', TARGETS.contract,
  "      rowIndex: { type: 'number', min: 0, max: 9, optional: true, desc: '加到第几行（0 = 最上面）。单行柜不用给；多层柜必须给' },",
  "",
  'addUnit 的参数里有 rowIndex');
mutate('★ setUnitDoorMaterial 从 units 族里被删掉', TARGETS.contract,
  "'cabinet.setUnitDoorMaterial', 'cabinet.setUnitFeature'],",
  "'cabinet.setUnitFeature'],",
  'units 族里列出了 setUnitDoorMaterial');

console.log('\n2. 编译实现');
mutate('★ 编译器不实现 setUnitDoorMaterial（漂移）', TARGETS.compile,
  "    case 'cabinet.setUnitDoorMaterial': {",
  "    case 'cabinet.setUnitDoorMaterial_DISABLED': {",
  '编译通过（不再报「没有这个动作」）');
mutate('★ 不存在的材质被静默接受（降级成木门）', TARGETS.compile,
  "      const dm = checkDoorMaterial(rules, material);",
  "      const dm = null as string | null;",
  '不存在的材质 id 被拒');
mutate('★ 开放格也能改门板材质', TARGETS.compile,
  "      if (!unit.doors || !unit.doors.count) {",
  "      if (false) {",
  '开放格改门板材质被拒');
mutate('★ 多行柜缺 rowIndex 时悄悄加到第 0 行', TARGETS.compile,
  "      if (isMultiRow(cab.layout) && !hasRowIndex) {",
  "      if (false) {",
  '多行柜不给 rowIndex 被拒');
mutate('★ 越界的 rowIndex 被静默夹到最后一格', TARGETS.compile,
  "        if (!Number.isInteger(ri) || ri < 0 || ri >= rowCount) {",
  "        if (false) {",
  '越界的 rowIndex 被拒');
mutate('★ rowIndex 没传到命令里', TARGETS.compile,
  "hasRowIndex ? Number(p.rowIndex) : undefined",
  "undefined",
  '命令带上了 rowIndex');
mutate('★ 多行柜的分区定位不再要求行号', TARGETS.compile,
  "    if (rowIndex === undefined || rowIndex === null) {",
  "    if (false) {",
  '错误信息说了要指明是哪一行');

console.log('\n3. setUnitFeature（裤架 / 格子抽 / 灯带）');
mutate('★ 契约里删掉 setUnitFeature', TARGETS.contract,
  "  'cabinet.setUnitFeature': {",
  "  'cabinet.setUnitFeature_DISABLED': {",
  '在契约里');
mutate('★ 编译器不实现 setUnitFeature（漂移）', TARGETS.compile,
  "    case 'cabinet.setUnitFeature': {",
  "    case 'cabinet.setUnitFeature_DISABLED': {",
  '给挂衣区加裤架编译通过');
mutate('★ 非法取值被静默接受', TARGETS.compile,
  "      if (!spec.values.includes(raw)) {",
  "      if (false) {",
  '非法取值被拒');
mutate('★ 给没有挂衣杆的分区加裤架也放行', TARGETS.compile,
  "        : !u.rod || !u.rod.count",
  "        : false",
  '挂衣区但没有挂衣杆时加裤架被拒');
mutate('★ 写路径白名单里没有 trouserRack（命令会被总线拒）', TARGETS.compile,
  "        command: CMD.setUnitString(cab, i, spec.path, raw, label, src),",
  "        command: CMD.setUnitString(cab, i, 'nickname', raw, label, src),",
  '命令写的是 trouserRack 路径');

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
