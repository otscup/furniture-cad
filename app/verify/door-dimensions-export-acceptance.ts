/**
 * 真导出回归：门板净宽/净高必须与制造板件完全一致，并在真实 PDF、DXF 中可读。
 * 覆盖多扇门 + 抽屉组合、多行柜，以及双面柜背排门板。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleProject } from '../src/core/docFactory.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { generateCabinet } from '../src/core/geometry/generate.ts';
import { toNeutralExport } from '../src/export/neutralSheet.ts';
import type { Project, RuleSet } from '../src/core/types.ts';
import { exportDxf, exportPdf } from '../server/exportCore.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..');
const rules = JSON.parse(readFileSync(join(app, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const tmp = mkdtempSync(join(tmpdir(), 'furniture-door-dims-'));
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

function mixedDoorProject(): Project {
  const project = structuredClone(sampleProject(rules));
  const cabinet = project.cabinets[0]!;
  const doorTemplate = structuredClone(cabinet.layout.units[2]!.doors!);
  cabinet.layout.units[1]!.doors = { ...structuredClone(doorTemplate), count: 2 };
  cabinet.layout.units[2]!.doors = { ...doorTemplate, count: 3 };
  return project;
}

function multiRowProject(): Project {
  const project = mixedDoorProject();
  const cabinet = project.cabinets[0]!;
  const source = structuredClone(cabinet.layout.units);
  const upper = source.map((unit, index) => ({ ...unit, id: `upper_${index + 1}` }));
  const lower = source.map((unit, index) => ({ ...unit, id: `lower_${index + 1}` }));
  cabinet.layout.rows = [
    { id: 'row_upper', height: 650, units: upper },
    { id: 'row_lower', height: 'fill', units: lower },
  ];
  cabinet.layout.units = [];
  return project;
}

function doubleCabinetProject(): Project {
  const project = mixedDoorProject();
  const cabinet = project.cabinets[0]!;
  // 岛台高度、宽度与分格采用可落板的生产尺寸，避免样例本身触发板材幅面错误。
  cabinet.params.width = 2100;
  cabinet.params.height = 900;
  cabinet.params.depth = 900;
  [450, 1050, 500].forEach((width, index) => {
    cabinet.layout.units[index]!.requestedWidth = width;
  });
  cabinet.layout.type = 'double';
  cabinet.layout.backUnits = structuredClone(cabinet.layout.units).map((unit, index) => ({ ...unit, id: `back_${index + 1}` }));
  return project;
}

function normalizeText(text: string): string {
  return text.replace(/[\s\u00a0]+/g, '');
}

async function runExportCase(label: string, project: Project): Promise<void> {
  const validation = new CommandBus(project, rules).issues().filter((issue) => issue.severity === 'ERROR');
  ok(`${label} 生产校验无阻断 ERROR`, validation.length === 0, JSON.stringify(validation.map((issue) => issue.code)));
  if (validation.length > 0) return;

  const cabinet = project.cabinets[0]!;
  const manufacturedDoors = generateCabinet(cabinet, rules).panels.filter((panel) => panel.role === 'DoorPanel');
  ok(`${label} 制造派生确有门板样本`, manufacturedDoors.length > 0, `${manufacturedDoors.length} 扇`);
  if (manufacturedDoors.length === 0) return;

  const modelVersion = `door-dimensions-${label}`;
  const neutral = toNeutralExport(project, rules, ['sheet'], modelVersion);
  const neutralPath = join(tmp, `${label}.neutral.json`);
  writeFileSync(neutralPath, JSON.stringify(neutral), 'utf8');

  const dxf = await exportDxf(project, { which: ['sheet'], modelVersion });
  const dxfPath = join(tmp, `${label}.dxf`);
  writeFileSync(dxfPath, dxf.buffer);
  const dxfReport = JSON.parse(execFileSync('python3', [join(app, 'py/verify_dxf.py'), dxfPath, neutralPath], { encoding: 'utf8' })) as any;
  ok(`${label} 真正 DXF 回读的图元与中立数据逐项一致`, dxfReport.neutralSemantics?.ok === true, JSON.stringify(dxfReport.neutralSemantics));
  ok(`${label} 真正 DXF 只有一个可打印 A3 横向柜体图纸`, dxfReport.paperLayouts?.filter((layout: any) => layout.entityCount > 0).length === 1 && dxfReport.paperLayouts.filter((layout: any) => layout.entityCount > 0).every((layout: any) => layout.fitsPrintableArea), JSON.stringify(dxfReport.paperLayouts?.filter((layout: any) => layout.entityCount > 0)));

  const sheetPrims = (neutral.sheets ?? []).flatMap((sheet: any) => sheet.prims ?? []);
  const dimPrims = sheetPrims.filter((prim: any) => prim.layer === 'F-DIM' && prim.k === 'text');
  const dimTexts = dimPrims.map((prim: any) => String(prim.text));
  const frontUnits = cabinet.layout.rows?.length
    ? cabinet.layout.rows.flatMap((row) => row.units)
    : cabinet.layout.units;
  const frontPanelUnitIds = new Set(frontUnits.map((unit) => `${cabinet.id}.${unit.id}`));
  const frontWidths = generateCabinet(cabinet, rules).panels
    .filter((panel) => panel.role === 'DoorPanel' && frontPanelUnitIds.has(panel.belongsTo))
    .map((panel) => Math.round(panel.width));
  const missingFrontWidths = [...new Set(frontWidths)].filter((width) => !dimTexts.includes(String(width)));
  ok(`${label} 正立面尺寸链标出制造清单中每种门净宽`, missingFrontWidths.length === 0, `缺少宽度: ${missingFrontWidths.join(', ') || '无'}；尺寸文字=${dimTexts.join(' | ')}`);

  const dimLabels = dimPrims.filter((prim: any) => /^\d+$/.test(String(prim.text)) || /(扇|抽|格)\//.test(String(prim.text)));
  const overlaps = (a: any, b: any): boolean => {
    const box = (prim: any) => {
      const size = Number(prim.size ?? 110);
      const width = String(prim.text).length * size * 0.55;
      const height = size;
      const rotated = Math.abs(Number(prim.rot ?? 0) % 180) === 90;
      const halfW = (rotated ? height : width) / 2;
      const halfH = (rotated ? width : height) / 2;
      return { left: prim.p.x - halfW, right: prim.p.x + halfW, bottom: prim.p.y - halfH, top: prim.p.y + halfH };
    };
    const aa = box(a), bb = box(b);
    return aa.left < bb.right && aa.right > bb.left && aa.bottom < bb.top && aa.top > bb.bottom;
  };
  const collidedLabels: string[] = [];
  for (let i = 0; i < dimLabels.length; i++) {
    for (let j = i + 1; j < dimLabels.length; j++) {
      if (overlaps(dimLabels[i], dimLabels[j])) collidedLabels.push(`${dimLabels[i].text}/${dimLabels[j].text}`);
    }
  }
  ok(`${label} 门宽与分格尺寸文字没有相互覆盖`, collidedLabels.length === 0, collidedLabels.slice(0, 8).join(', '));

  const pagePoints = sheetPrims.flatMap((prim: any) => {
    if (prim.k === 'text') return [prim.p];
    if (prim.k === 'poly' || prim.k === 'fill') return prim.pts ?? [];
    if (prim.k === 'arc') return [
      { x: prim.c.x - prim.r, y: prim.c.y - prim.r },
      { x: prim.c.x + prim.r, y: prim.c.y + prim.r },
    ];
    return [];
  });
  const pageBounds = {
    minX: Math.min(...pagePoints.map((point: any) => point.x)), maxX: Math.max(...pagePoints.map((point: any) => point.x)),
    minY: Math.min(...pagePoints.map((point: any) => point.y)), maxY: Math.max(...pagePoints.map((point: any) => point.y)),
  };
  ok(`${label} 整张中立图纸图元均在 A3 页面范围内`, pageBounds.minX >= 0 && pageBounds.minY >= 0 && pageBounds.maxX <= 14000 && pageBounds.maxY <= 10000, JSON.stringify(pageBounds));

  const pdf = await exportPdf(project, { modelVersion });
  const pdfPath = join(tmp, `${label}.pdf`);
  writeFileSync(pdfPath, pdf.pdf);
  const extracted = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
  const compactPdf = normalizeText(extracted);
  const firstPageText = execFileSync('pdftotext', ['-f', '1', '-l', '1', '-layout', pdfPath, '-'], { encoding: 'utf8' });
  const hasCabinetOnlyDefault = pdf.pageCount === 1 && normalizeText(firstPageText).includes('俯视图') && normalizeText(firstPageText).includes('外观正面图') && !normalizeText(firstPageText).includes('房间布局');
  ok(`${label} 真正 PDF 默认只含 1 页单柜图，不插房间布局页`, pdf.pdf.subarray(0, 5).toString('ascii') === '%PDF-' && hasCabinetOnlyDefault, `${pdf.pageCount} 页 / ${pdf.pdf.length} bytes; cabinet=${normalizeText(firstPageText).includes('俯视图') && normalizeText(firstPageText).includes('外观正面图')}; layout=${normalizeText(firstPageText).includes('房间布局')}`);

  const missingSizes = manufacturedDoors
    .map((panel) => `${Math.round(panel.width)}×${Math.round(panel.length)}mm`)
    .filter((size) => !compactPdf.includes(normalizeText(size)));
  ok(`${label} PDF 门板表逐扇包含制造清单的净宽×净高`, missingSizes.length === 0, `缺少规格: ${missingSizes.join(', ') || '无'}`);
  ok(`${label} PDF 门板表标出门扇数量`, /扇/.test(extracted), extracted.slice(-800));

  const scheduleTexts = sheetPrims
    .filter((prim: any) => prim.layer === 'F-TEXT' && prim.k === 'text')
    .map((prim: any) => String(prim.text));
  const scheduleEntries = scheduleTexts.filter((text) => /·门\d+\s+\d+×\d+mm$/.test(text));
  ok(`${label} 门板规格表每扇独立编号并有独立生产尺寸行`, scheduleEntries.length === manufacturedDoors.length, `制造门板 ${manufacturedDoors.length} 扇，规格行 ${scheduleEntries.length} 行`);
  const scheduledCounts = new Map<string, number>();
  const specFromText = (text: string): string | null => /\d+×\d+mm$/.exec(text)?.[0] ?? null;
  for (const text of scheduleEntries) {
    const spec = specFromText(text);
    if (spec) scheduledCounts.set(spec, (scheduledCounts.get(spec) ?? 0) + 1);
  }
  const manufacturedCounts = new Map<string, number>();
  for (const panel of manufacturedDoors) {
    const size = `${Math.round(panel.width)}×${Math.round(panel.length)}mm`;
    manufacturedCounts.set(size, (manufacturedCounts.get(size) ?? 0) + 1);
  }
  const countMismatches = [...manufacturedCounts].filter(([size, count]) => scheduledCounts.get(size) !== count);
  const pdfCountMismatches = [...manufacturedCounts].filter(([size, count]) => compactPdf.split(normalizeText(size)).length - 1 < count);
  const dxfCountMismatches = [...manufacturedCounts].filter(([size, count]) => dxfReport.texts.filter((text: string) => text.endsWith(size)).length < count);
  ok(`${label} 每扇尺寸表规格与制造板件逐项、逐数量一致`, countMismatches.length === 0, JSON.stringify({ expected: [...manufacturedCounts], scheduled: [...scheduledCounts] }));
  ok(`${label} 真实 PDF 每个制造门规格均按扇数可查`, pdfCountMismatches.length === 0, JSON.stringify({ expected: [...manufacturedCounts], missing: pdfCountMismatches }));
  ok(`${label} 真实 DXF 每个制造门规格均按扇数可查`, dxfCountMismatches.length === 0, JSON.stringify({ expected: [...manufacturedCounts], missing: dxfCountMismatches }));
  ok(`${label} 门板尺寸文字落在 DXF 中并通过逐图元回归`, dxfReport.neutralSemantics?.ok === true && [...new Set(frontWidths)].every((width) => dxfReport.texts.includes(String(width))), JSON.stringify({ semanticSheets: dxfReport.neutralSemantics?.sheets?.length, widths: frontWidths }));
}

function denseDoorProject(): Project {
  const project = sampleProject(rules);
  project.cabinets[0]!.layout.units[2]!.doors!.count = 6;
  return project;
}

try {
  console.log('\n【多门 + 抽屉组合】');
  await runExportCase('mixed', mixedDoorProject());
  console.log('\n【双行多门柜】');
  await runExportCase('rows', multiRowProject());
  console.log('\n【双面柜前后排】');
  await runExportCase('double', doubleCabinetProject());
  console.log('\n【窄分区六扇门压力样例】');
  await runExportCase('dense', denseDoorProject());
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error(`失败项：${failures.join('、')}`);
  process.exitCode = 1;
}
