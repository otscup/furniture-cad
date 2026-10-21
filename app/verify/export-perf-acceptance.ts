/**
 * ══════════════════════════════════════════════════════════════════════
 *  导出性能回归验收（2026-10-21）
 *
 * ── 它守的是什么 ──
 *   曾经有一个 O(房间数 × 柜数²) 的爆炸：
 *   buildFurnitureSheet 内部每次都 buildProjectViews(project) 遍历**全部**柜体，
 *   而 buildRoomBook 对每个房间调一次、对每个叠放组再调一次。
 *
 *   实测（每房 10 柜）：
 *     1 房 183 ms → 2 房 480 ms → 4 房 3090 ms → 8 房 **22133 ms**
 *   8 房 80 柜要 22 秒 —— 多房间户型直接卡死。
 *
 *   修法：调用方算一次 buildProjectViews，传给 buildFurnitureSheet。
 *   修后：1 房 88 ms → 8 房 **866 ms**（25 倍）。
 *
 * ── 为什么要有这个验收 ──
 *   性能退化**不会报错**，只会「慢慢变慢」，等发现时已经很难定位。
 *   必须有一个**会红**的门槛把它钉住。
 *
 * ★ 阈值怎么定 ──
 *   按**修复后的实测值**留 3 倍余量（机器波动 + CI 机器更慢）。
 *   门槛刻意宽松 —— 它要抓的是「回到 O(N²)」这种量级劣化，
 *   不是抓几毫秒的性能抖动（那会天天误报）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
import { buildRoomBook } from '../src/export/roomBook.ts';
import { toNeutralExport } from '../src/export/neutralSheet.ts';
import type { Project, RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

/** 造一个多房间项目：nRooms 个房间，每房 nCabsPerRoom 只柜。 */
function buildProject(nRooms: number, nCabsPerRoom: number): Project {
  const project = emptyProject({ name: 'perf', ruleSetId: rules.id, id: 'perf' });
  for (let r = 0; r < nRooms; r++) {
    const room = rectRoom({
      name: `房${r}`, x: r * 20000, y: 0, w: 15000, h: 6000, thickness: 120, height: 2700,
    });
    project.rooms.push(room);
    for (let i = 0; i < nCabsPerRoom; i++) {
      project.cabinets.push(createCabinet({
        id: `c${r}_${i}`, name: `柜${r}-${i}`, roomId: room.id, x: 100 + i * 900, y: 60, rotation: 0, rules,
        params: { width: 800, height: 2400, depth: 600, bodyLift: 80, cabinetType: 'base', mountHeight: 0 },
        units: [{
          id: `u${r}_${i}`, kind: 'shelves', requestedWidth: 800, nickname: 'u',
          shelves: { count: 4, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 },
        }],
      }));
    }
  }
  return project;
}

/** 跑一次并返回毫秒。 */
function msOf(fn: () => unknown, runs = 1): number {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / runs;
}
// ═══════════════ 1. buildRoomBook 的规模伸缩 ═══════════════
section('1. buildRoomBook：房间数增加时耗时不应二次方爆炸');
{
  const p1 = buildProject(1, 10);
  const p2 = buildProject(2, 10);
  const p4 = buildProject(4, 10);
  const p8 = buildProject(8, 10);

  const t1 = msOf(() => buildRoomBook(p1, rules, 'v'));
  const t2 = msOf(() => buildRoomBook(p2, rules, 'v'));
  const t4 = msOf(() => buildRoomBook(p4, rules, 'v'));
  const t8 = msOf(() => buildRoomBook(p8, rules, 'v'));
  console.log(`      实测: 1房 ${t1.toFixed(0)}ms · 2房 ${t2.toFixed(0)}ms · 4房 ${t4.toFixed(0)}ms · 8房 ${t8.toFixed(0)}ms`);

  ok('8 房 80 柜的图纸册 < 5000 ms（修复前是 22000 ms）', t8 < 5000, `${t8.toFixed(0)} ms`);
  /**
   * ★ 关键断言：**增长倍率**要接近线性 ──
   *   房间数 1→8（8 倍），若仍是 O(R×N²)，耗时会涨约 64 倍（183 → 22133 ms）。
   *   修好后是 O(N)，8 房约 8 倍。
   *   留 20 倍余量：20 倍以上说明又回到二次方了。
   */
  const growth = t8 / Math.max(t1, 1);
  ok('★ 房间数 1→8（8 倍）耗时增长 < 20 倍（线性-ish）', growth < 20, `实际增长 ${growth.toFixed(1)} 倍`);
}

// ═══════════════ 2. toNeutralExport 的规模伸缩 ═══════════════
section('2. toNeutralExport（逐柜分图，默认模式）：柜数增加时不应二次方爆炸');
{
  const q10 = buildProject(1, 10);
  const q20 = buildProject(1, 20);
  const q40 = buildProject(1, 40);

  const e10 = msOf(() => toNeutralExport(q10, rules, ['sheet'], { sheetMode: 'cabinet' }), 3);
  const e20 = msOf(() => toNeutralExport(q20, rules, ['sheet'], { sheetMode: 'cabinet' }), 3);
  const e40 = msOf(() => toNeutralExport(q40, rules, ['sheet'], { sheetMode: 'cabinet' }), 3);
  console.log(`      实测: 10柜 ${e10.toFixed(0)}ms · 20柜 ${e20.toFixed(0)}ms · 40柜 ${e40.toFixed(0)}ms`);

  ok('40 柜的中立导出 < 600 ms（修复前是 932 ms）', e40 < 600, `${e40.toFixed(0)} ms`);
  /**
   * ★ 关键断言：柜数 10→40（4 倍），耗时应接近 4 倍。
   *   修复前是完美的二次曲线（4 倍柜 → 16 倍耗时）。
   */
  const growth = e40 / Math.max(e10, 1);
  ok('★ 柜数 10→40（4 倍）耗时增长 < 8 倍（线性-ish）', growth < 8, `实际增长 ${growth.toFixed(1)} 倍`);
}

// ═══════════════ 3. 修法本身的结构断言 ═══════════════
section('3. 修法本身：projectViews 必须是「传进来」的，不是「每次重算」的');
{
  const sheetSrc = readFileSync(join(here, '..', 'src', 'export', 'furnitureSheet.ts'), 'utf8');
  const bookSrc = readFileSync(join(here, '..', 'src', 'export', 'roomBook.ts'), 'utf8');
  const neutralSrc = readFileSync(join(here, '..', 'src', 'export', 'neutralSheet.ts'), 'utf8');

  ok('★ buildFurnitureSheet 支持传入 projectViews', sheetSrc.includes('projectViews?: ProjectViewSet'));
  ok('★ buildFurnitureSheet 优先用传入的 projectViews',
    sheetSrc.includes('opts.projectViews ?? buildProjectViews(project, rules)'));
  ok('★ buildRoomBook 只算一次 projectViews',
    (bookSrc.match(/buildProjectViews\(project, rules\)/g) ?? []).length === 1,
    `${(bookSrc.match(/buildProjectViews\(project, rules\)/g) ?? []).length} 处`);
  ok('★ buildRoomBook 把 projectViews 传给 buildFurnitureSheet',
    bookSrc.includes('furnitureName: `${group.room.name}整体柜`, projectViews'));
  ok('★ toNeutralExport 只算一次 projectViews',
    (neutralSrc.match(/buildProjectViews\(project, rules\)/g) ?? []).length === 1,
    `${(neutralSrc.match(/buildProjectViews\(project, rules\)/g) ?? []).length} 处`);
  ok('★ toNeutralExport 把 projectViews 传给 buildFurnitureSheet',
    neutralSrc.includes('furnitureName: cabinet.name, projectViews'));
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`导出性能回归验收：通过 ${pass} 项，失败 0 项`);
  console.log('全部通过：房间数/柜数增长时耗时保持线性，没有回到 O(R×N²)。');
} else {
  console.log(`导出性能回归验收：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
