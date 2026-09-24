/**
 * 按房间图纸册验收（Phase D）。
 *
 * 承诺的是：
 *   1. 排序即语义：房间按 rooms 数组顺序（**不被字母序重排**），
 *      房内柜体按 (y, x) 排序；无归属房间的柜体进「未分配」节且放最后；
 *   2. 每柜三图齐全（平面 / 门板外观 / 内部结构），SVG Y 轴翻转正确；
 *   3. 版本三件套（模型 + 生成器 + 规则集）强制出现在封面与尾页；
 *   4. HTML 卫生：柜名等模型字符串一律转义（模型内容不能破坏文档结构）；
 *   5. 甲购件（玻璃门）出现在书数据与 HTML 里；
 *   6. CLI 发射器（emit-roombook.ts）从 stdin 语义模型在后端重算几何。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { RuleSet } from '../src/core/types.ts';
import { createCabinet, makeUnit, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import { buildRoomBook, roomBookHtml } from '../src/export/roomBook.ts';
import { GENERATOR_VERSION } from '../src/export/neutralSheet.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name} —— ${detail}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

// ── 夹具：两个房间（rooms 顺序故意 B 在 A 前）+ 每房两柜（y 乱序给）+ 一个孤儿柜 + 一个玻璃柜 ──
// 注意：nextId 在各构造点独立计数 —— 房间/柜体不显式给 id 会全部撞成 room_001 / cab_001（实测踩过）。
const roomB = rectRoom({ name: 'B 书房', id: 'room_b', x: 0, y: 0, w: 3000, h: 2600, thickness: 120, height: 2700 });
const roomA = rectRoom({ name: 'A 主卧', id: 'room_a', x: 3400, y: 0, w: 3200, h: 2600, thickness: 120, height: 2700 });
const mk = (id: string, name: string, roomId: string, x: number, y: number, units?: Parameters<typeof createCabinet>[0]['units']): ReturnType<typeof createCabinet> =>
  createCabinet({ id, name, roomId, x, y, rotation: 0, rules, params: { width: 900 }, units, takenIds: [] });

const glassUnits: Parameters<typeof createCabinet>[0]['units'] = [
  makeUnit({ id: 'unit_001', kind: 'shelves', requestedWidth: 450, rules, count: 3 }),
  makeUnit({ id: 'unit_002', kind: 'hanging', requestedWidth: 450, rules, count: 2, doors: { count: 2, material: 'M_GLASS_8_GREY' } }),
];

const proj = sampleProject(rules);
proj.rooms = [roomB, roomA]; // 故意 B 在前：验证排序不被字母序重排
proj.cabinets = [
  mk('cab_north', '北柜', roomA.id, 100, 2500), // y 大 → 应排后面
  mk('cab_south', '南柜', roomA.id, 400, 60), // y 小 → 应排前面
  mk('cab_yi', '乙柜', roomB.id, 900, 60, glassUnits), // 玻璃门柜
  mk('cab_jia', '甲柜', roomB.id, 100, 60), // 同 y，x 小 → 应排前面
  mk('cab_orphan', '孤儿柜', 'room_nonexistent', 0, 0),
];

section('1. 编排：排序即语义（模型顺序，导出器不做主）');
{
  const book = buildRoomBook(proj, rules, 'rb-v1');
  ok('房间顺序 = rooms 数组顺序（B 书房在 A 主卧前）', book.sections[0]!.roomName === 'B 书房' && book.sections[1]!.roomName === 'A 主卧',
    book.sections.map((s) => s.roomName).join(' | '));
  const bCabs = book.sections[0]!.cabinets.map((c) => c.name);
  const aCabs = book.sections[1]!.cabinets.map((c) => c.name);
  ok('B 房柜序按 (y,x)：甲柜(100,60) 在 乙柜(900,60) 前', bCabs[0] === '甲柜' && bCabs[1] === '乙柜', bCabs.join('|'));
  ok('A 房柜序按 y：南柜(y60) 在 北柜(y2500) 前', aCabs[0] === '南柜' && aCabs[1] === '北柜', aCabs.join('|'));
  const last = book.sections.at(-1)!;
  ok('孤儿柜进「未分配」节且在最后（不静默丢）', last.roomName === '未分配房间' && last.cabinets.length === 1 && last.cabinets[0]!.name === '孤儿柜',
    book.sections.map((s) => s.roomName).join(' | '));
  ok('柜体编号带序号（每柜 index）', book.sections.every((s) => s.cabinets.every((c, i) => c.index === i + 1)));
}

section('2. 三图齐全 + SVG Y 轴翻转');
{
  const book = buildRoomBook(proj, rules, 'rb-v1');
  const all = book.sections.flatMap((s) => s.cabinets);
  ok('每柜三图都是非空 SVG', all.every((c) => [c.planSvg, c.frontSvg, c.internalSvg].every((s) => s.includes('<svg') && s.includes('<polyline'))));
  ok('SVG 内容套 scale(1,-1)（CAD Y 向上 → SVG Y 向下）', all.every((c) => [c.planSvg, c.frontSvg, c.internalSvg].every((s) => s.includes('transform="scale(1,-1)"'))));
  ok('文字节点再翻回（镜像文字不可读）', all.every((c) => c.frontSvg.includes('scale(1,-1) scale(1,-1)')) === false);
  ok('文字带独立 translate+scale 反转', all.some((c) => /<text transform="translate\([^)]*\) scale\(1,-1\)"/.test(c.internalSvg)));
  const glass = all.find((c) => c.name === '乙柜')!;
  ok('玻璃柜的门板材质在书上（规则集名）', glass.doorMaterial === '8mm 灰玻（门板）', String(glass.doorMaterial));
  ok('玻璃柜带甲购件明细', glass.purchased.length >= 1 && glass.purchased[0]!.kind === 'glassDoor', JSON.stringify(glass.purchased));
}

section('3. 版本三件套（生产数据红线）');
{
  const html = roomBookHtml(buildRoomBook(proj, rules, 'rb-v42'));
  ok('封面含模型版本', html.includes('rb-v42'));
  ok(`封面含生成器版本 ${GENERATOR_VERSION}`, html.includes(GENERATOR_VERSION));
  ok('封面含规则集 ID 与名称', html.includes(rules.id) && html.includes(rules.name));
  ok('尾页再带一遍（每页可追溯）', html.includes('首批生产必须人工全检') && html.includes(`生成：${GENERATOR_VERSION}`));
}

section('4. HTML 卫生：模型字符串必须转义');
{
  const evil = proj;
  const saved = evil.cabinets[0]!.name;
  evil.cabinets[0]!.name = '<script>alert(1)</script>';
  const html = roomBookHtml(buildRoomBook(evil, rules, 'rb-v1'));
  evil.cabinets[0]!.name = saved;
  ok('柜名 <script> 被转义（模型内容不破坏文档结构）', html.includes('&lt;script&gt;') && !html.includes('<script>alert'));
}

section('5. 尾页汇总：数字同源（不是第二次算）');
{
  const book = buildRoomBook(proj, rules, 'rb-v1');
  const sumKinds = book.summary.reduce((a, s) => a + s.panelKinds, 0);
  const sumPieces = book.summary.reduce((a, s) => a + s.panelPieces, 0);
  const sumPurchased = book.summary.reduce((a, s) => a + s.purchased, 0);
  ok('totals.panelKinds = 各柜之和', book.totals.panelKinds === sumKinds && sumKinds > 0, `totals=${book.totals.panelKinds} sum=${sumKinds}`);
  ok('totals.panelPieces = 各柜之和', book.totals.panelPieces === sumPieces);
  ok('totals.purchased 含玻璃柜', book.totals.purchased === sumPurchased && sumPurchased >= 1);
  ok('summary 覆盖全部柜体（含未分配）', book.summary.length === proj.cabinets.length, `${book.summary.length} vs ${proj.cabinets.length}`);
}

section('6. CLI 发射器：后端从语义模型重算');
{
  // spawnSync 在沙箱环境下报 EBUSY（异步 spawn 不受限），用异步 spawn + Promise 包装
  const runEmitter = (input: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(root, 'scripts', 'emit-roombook.ts')], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      p.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
      p.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
      p.stdin.end(input); // 子进程从 stdin 读语义模型，必须写完即关（EOF）
    });
  const out = await runEmitter(JSON.stringify({ project: proj, modelVersion: 'cli-v9' }));
  ok('emit-roombook 输出完整 HTML 文档', out.startsWith('<!DOCTYPE html>') && out.includes('</html>'));
  ok('发射器版本来自参数（cli-v9 进文档）', out.includes('cli-v9'));
  ok('发射器几何在后端重算（三图 SVG 在输出里）', out.includes('立面外观（门板图）') && out.includes('立面结构（内视图）'));
}

console.log(`\n═══ 按房间图纸册：通过 ${pass} 项，失败 ${fail} 项 ═══`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
