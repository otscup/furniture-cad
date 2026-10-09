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

function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}
function section(title: string): void { console.log(`\n── ${title} ──`); }

const roomB = rectRoom({ name: 'B 书房', id: 'room_b', x: 0, y: 0, w: 3000, h: 2600, thickness: 120, height: 2700 });
const roomA = rectRoom({ name: 'A 主卧', id: 'room_a', x: 3400, y: 0, w: 3200, h: 2600, thickness: 120, height: 2700 });
const mk = (id: string, name: string, roomId: string, x: number, y: number, units?: Parameters<typeof createCabinet>[0]['units']) =>
  createCabinet({ id, name, roomId, x, y, rotation: 0, rules, params: { width: 900 }, units, takenIds: [] });
const glassUnits: Parameters<typeof createCabinet>[0]['units'] = [
  makeUnit({ id: 'unit_001', kind: 'shelves', requestedWidth: 450, rules, count: 3 }),
  makeUnit({ id: 'unit_002', kind: 'hanging', requestedWidth: 450, rules, count: 2, doors: { count: 2, material: 'M_GLASS_8_GREY' } }),
];
const project = sampleProject(rules);
project.rooms = [roomB, roomA];
project.cabinets = [
  mk('cab_north', '北柜', roomA.id, 100, 2500),
  mk('cab_south', '南柜', roomA.id, 400, 60),
  mk('cab_yi', '乙柜', roomB.id, 900, 60, glassUnits),
  mk('cab_jia', '甲柜', roomB.id, 100, 60),
  mk('cab_orphan', '孤儿柜', 'room_nonexistent', 0, 0),
];

section('1. 房间索引与归属：只看本房间柜体，不自动吞并未分配柜体');
{
  const book = buildRoomBook(project, rules, 'rb-v1');
  ok('房间按 rooms[] 顺序展示（含 A 主卧、B 书房、未分配）', book.sections.map((room) => room.roomName).join('|') === 'B 书房|A 主卧|未分配房间', book.sections.map((room) => room.roomName).join('|'));
  const b = book.sections[0]!;
  const a = book.sections[1]!;
  const orphan = book.sections[2]!;
  ok('书房只含本房间两柜，按空间位置稳定排序', b.cabinets.map((cabinet) => cabinet.name).join('|') === '甲柜|乙柜', b.cabinets.map((cabinet) => cabinet.name).join('|'));
  ok('主卧只含本房间两柜，按空间位置稳定排序', a.cabinets.map((cabinet) => cabinet.name).join('|') === '南柜|北柜', a.cabinets.map((cabinet) => cabinet.name).join('|'));
  ok('悬空 roomId 保留在“未分配房间”且不会混进其它房间', orphan.cabinets.length === 1 && orphan.cabinets[0]!.name === '孤儿柜');
  const ids = book.sections.flatMap((room) => room.cabinets.map((cabinet) => cabinet.id));
  ok('每个柜体恰好出现一次', ids.length === project.cabinets.length && new Set(ids).size === ids.length);
}

section('2. 图纸计划：横向单柜单页，三视图同柜同源');
{
  const book = buildRoomBook(project, rules, 'rb-v1');
  const html = roomBookHtml(book);
  const pages = html.match(/data-page-kind="cabinet"/g) ?? [];
  ok(`HTML 备用版保留每房间历史布局页（${book.sections.length}）与单柜页（${project.cabinets.length}）`, (html.match(/data-page-kind="layout"/g) ?? []).length === book.sections.length && pages.length === project.cabinets.length, `layouts=${(html.match(/data-page-kind="layout"/g) ?? []).length}; cabinets=${pages.length}`);
  const noLayouts = roomBookHtml(book, { layoutRoomIds: [] });
  ok('显式空 layoutRoomIds 时 HTML 不输出任何布局页', !(noLayouts.match(/data-page-kind="layout"/g) ?? []).length && (noLayouts.match(/data-page-kind="cabinet"/g) ?? []).length === project.cabinets.length);
  const onlyA = roomBookHtml(book, { layoutRoomIds: ['room_a'] });
  const aLayoutIndex = onlyA.indexOf('data-page-kind="layout" data-room-id="room_a"');
  const aCabinetIndex = onlyA.indexOf('data-page-kind="cabinet" data-room-id="room_a"');
  ok('仅选择 A 主卧时只输出 A 布局页，且紧邻本房间首张柜体页之前', (onlyA.match(/data-page-kind="layout"/g) ?? []).length === 1 && aLayoutIndex >= 0 && aCabinetIndex > aLayoutIndex && !onlyA.includes('data-page-kind="layout" data-room-id="room_b"'));
  ok('每页保留房间名和柜体名', html.includes('B 书房 / 甲柜') && html.includes('A 主卧 / 南柜') && html.includes('未分配房间 / 孤儿柜'));
  ok('图纸页包含外观正面、内部结构与俯视图标题', html.includes('外观正面图') && html.includes('内部结构图') && html.includes('俯视图'));
  ok('默认没有封面、尾页汇总或分解图', !html.includes('版本三件套') && !html.includes('清单汇总') && !html.includes('分解图'));
  ok('打印 CSS 锁定 A3 横向且无页边距', html.includes('@page { size: A3 landscape; margin: 0; }'));
  ok(`版本三件套生成器版本可追溯（${GENERATOR_VERSION}）`, html.includes(GENERATOR_VERSION));
}

section('3. 内容完整性与 HTML 安全');
{
  const book = buildRoomBook(project, rules, 'rb-v42');
  ok('汇总统计柜体数量与项目一致', book.totals.cabinets === project.cabinets.length);
  ok('板件总数等于所有柜体明细之和', book.totals.panelPieces === book.summary.reduce((sum, row) => sum + row.panelPieces, 0));
  const original = project.cabinets[0]!.name;
  project.cabinets[0]!.name = '<script>alert(1)</script>';
  const html = roomBookHtml(buildRoomBook(project, rules, 'rb-safe'));
  project.cabinets[0]!.name = original;
  ok('房间名、柜名中的 HTML 字符被安全转义', html.includes('&lt;script&gt;') && !html.includes('<script>alert'));
}

section('4. CLI 图纸生成器');
{
  const runEmitter = (input: string): Promise<string> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(root, 'scripts', 'emit-roombook.ts')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (data: Buffer) => { out += data.toString('utf8'); });
    child.stderr.on('data', (data: Buffer) => { err += data.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`)));
    child.stdin.end(input);
  });
  const html = await runEmitter(JSON.stringify({ project, modelVersion: 'cli-v9' }));
  ok('emit-roombook 输出完整 HTML 文档', html.startsWith('<!DOCTYPE html>') && html.includes('</html>'));
  ok('发射器版本进入图纸元数据', html.includes('cli-v9'));
  ok('发射器输出五个可追溯柜体页且名称隔离', (html.match(/data-page-kind="cabinet"/g) ?? []).length === project.cabinets.length && html.includes('B 书房 / 甲柜'));
}

console.log(`\n═══ 单柜图纸册：通过 ${pass} 项，失败 ${fail} 项 ═══`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const failure of failures) console.log(`  · ${failure}`);
  process.exit(1);
}
