#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  变异测试：格子抽 / 裤架（2026-10-21）
 *
 *  每个变异 = 故意改坏实现 → 验收必须变红 → 自动还原。
 *  ★ 安全网：跑之前备份所有目标文件，exit / SIGINT / uncaughtException 都还原。
 *    （上一轮因为没有这个，源码被留在坏状态，丢了 2388 行。）
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
  types: join(appDir, 'src', 'core', 'types.ts'),
  factory: join(appDir, 'src', 'core', 'docFactory.ts'),
  templates: join(appDir, 'src', 'core', 'templates.ts'),
  compile: join(appDir, 'src', 'ai', 'compile.ts'),
  contract: join(appDir, 'shared', 'aiContract.mjs'),
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
      ['--experimental-strip-types', join(here, 'grid-trouser-acceptance.ts')],
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

console.log('变异测试：格子抽 / 裤架');
console.log('='.repeat(64));

console.log('\n1. 格子抽几何');
mutate('★ 折线条数改错（删掉一段）', TARGETS.views,
  "    [0.45, 0.1, 0.5, 0.0],",
  "",
  '正好 6 段折线');
mutate('★ 谷底断开（两段不相接）', TARGETS.views,
  "    [0.5, 0.0, 0.55, 0.1],",
  "    [0.56, 0.02, 0.61, 0.12],",
  '在同一点相接');
mutate('★ 折线方向反了（整体是「谷」不是「山」）', TARGETS.views,
  "    [0.0, 1.0, 0.05, 0.9],",
  "    [0.0, 0.0, 0.05, 0.1],",
  '前 3 段下行');
mutate('★ 折线改为每抽格一组（不再横跨）', TARGETS.views,
  "            if (d.style === 'grid' && isFirstCell) {",
  "            if (d.style === 'grid') {",
  '正好 6 段折线');
mutate('★ 格子抽画到五金图层（不再是抽面图层）', TARGETS.views,
  "    P.line(x0 + ax * w, x0 + bx * w, z0 + ay * h, z0 + by * h, L_FRONT, 0.8);",
  "    P.line(x0 + ax * w, x0 + bx * w, z0 + ay * h, z0 + by * h, L_HW, 0.8);",
  '抽面图层');

console.log('\n2. 裤架几何');
mutate('★ 裤架不画了', TARGETS.views,
  "        if (u.trouserRack === true && !withFronts) {",
  "        if (false) {",
  '内部图上有裤架挂钩');
mutate('★ 裤架画到外观图上（外面也画）', TARGETS.views,
  "        if (u.trouserRack === true && !withFronts) {",
  "        if (u.trouserRack === true) {",
  '外观图**不**画裤架');
mutate('★ 挂钩顶点朝下（∧ 形）', TARGETS.views,
  "    P.line(cx - half, cx, rodZ, rodZ - hookH, L_HW, 0.8);",
  "    P.line(cx - half, cx, rodZ - hookH, rodZ, L_HW, 0.8);",
  '在顶点相接');

console.log('\n3. 语义链路');
mutate('★ 模板不声明 drawerStyle', TARGETS.templates,
  "      { kind: 'drawerBank', width: { ratio: 0.36 }, count: 3, drawerStyle: 'grid', nickname: '格子抽' },",
  "      { kind: 'drawerBank', width: { ratio: 0.36 }, count: 3, nickname: '格子抽' },",
  '格子抽分区');
mutate('★ docFactory 不落 drawers.style', TARGETS.factory,
  "      if (opts.drawerStyle === 'grid') unit.drawers!.style = 'grid';",
  "      void opts.drawerStyle;",
  'drawers.style=grid');
mutate('★ docFactory 不落 trouserRack', TARGETS.factory,
  "      if (opts.trouserRack === true) unit.trouserRack = true;",
  "      void opts.trouserRack;",
  'trouserRack=true');
mutate('★ 模板不声明 trouserRack', TARGETS.templates,
  "      { kind: 'hanging', width: { ratio: 0.36 }, rodHeight: 1800, trouserRack: true, nickname: '挂衣+裤架' },",
  "      { kind: 'hanging', width: { ratio: 0.36 }, rodHeight: 1800, nickname: '挂衣+裤架' },",
  '裤架分区');
mutate('★ 契约里去掉 drawerStyle（unitIntents 那处）', TARGETS.contract,
  "  drawerStyle: { type: 'enum', values: ['plain', 'grid'], optional: true, desc: '抽面表达（仅 drawerBank 分区）：plain=普通抽面（默认，一条横线）；grid=格子抽（抽面内画一排折线小格，图上是「山」字形折线）。用户说「格子抽」「网格抽」「百格抽」时给 grid' },",
  "",
  '契约里两处都声明了 drawerStyle');
mutate('★ compile 不透传 trouserRack', TARGETS.compile,
  "        trouserRack: truthyFlag(p.trouserRack) ? true : undefined,",
  "        trouserRack: undefined,",
  '透传给 makeUnit');

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