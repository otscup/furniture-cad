import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rectRoom, sampleProject } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room, RuleSet } from '../src/core/types.ts';
import { exportDxf, exportPdf } from '../server/exportCore.mjs';

type DxfReadback = {
  dxfversion?: string;
  paperLayouts?: Array<{ name: string; entityCount: number; texts?: string[] }>;
};

type ExpectedCabinet = { id: string; name: string; roomId: string; roomName: string };
type TracePage = { page: number; layout: string; cabinetId: string | null; roomId: string | null; cabinetHits: string[]; roomHits: string[] };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const tempDir = mkdtempSync(join(tmpdir(), 'furnicad-roombook-identity-'));
let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const normalize = (value: string): string => value.replace(/[\s\u00a0\u200b\ufeff]+/g, '');

function makeFixture(): { project: Project; expected: ExpectedCabinet[]; rooms: Room[] } {
  const project = structuredClone(sampleProject(rules));
  const roomA = rectRoom({ id: 'room_kitchen_A', name: '验收厨房甲', x: 0, y: 0, w: 7000, h: 4500, thickness: 120, height: 2700 });
  const roomB = rectRoom({ id: 'room_study_B', name: '验收书房乙', x: 8000, y: 0, w: 6000, h: 4500, thickness: 120, height: 2700 });
  project.id = 'project_roombook_identity_fixture';
  project.name = '项目图册逐页身份验收';
  project.rooms = [roomA, roomB];
  const template = project.cabinets[0]!;
  const spec = [
    { id: 'cab_kitchen_base_A', name: '厨房地柜甲', room: roomA, type: 'base' as const, x: 400, y: 60, width: 900, height: 850, depth: 600 },
    { id: 'cab_kitchen_wall_B', name: '厨房吊柜乙', room: roomA, type: 'wall' as const, x: 1600, y: 1500, width: 1200, height: 700, depth: 600 },
    { id: 'cab_kitchen_tall_C', name: '厨房高柜丙', room: roomA, type: 'tall' as const, x: 3200, y: 60, width: 900, height: 2100, depth: 600 },
    { id: 'cab_study_base_D', name: '书房矮柜丁', room: roomB, type: 'base' as const, x: 8400, y: 60, width: 1000, height: 900, depth: 500 },
  ];
  const cabinets: Cabinet[] = spec.map((item) => {
    const cabinet = structuredClone(template);
    cabinet.id = item.id;
    cabinet.name = item.name;
    cabinet.roomId = item.room.id;
    cabinet.placement = { x: item.x, y: item.y, rotation: 0 };
    cabinet.params.width = item.width;
    cabinet.params.height = item.height;
    cabinet.params.depth = item.depth;
    cabinet.params.cabinetType = item.type;
    cabinet.params.mountHeight = item.type === 'wall' ? 1450 : 0;
    cabinet.layout.units = cabinet.layout.units.map((unit, index) => ({ ...unit, id: `${item.id}_unit_${index + 1}` }));
    return cabinet;
  });
  // Source order deliberately differs from room/cabinet display order.
  project.cabinets = [cabinets[2]!, cabinets[0]!, cabinets[3]!, cabinets[1]!];
  project.assemblies = [];
  return {
    project,
    expected: spec.map((item) => ({ id: item.id, name: item.name, roomId: item.room.id, roomName: item.room.name })),
    rooms: [roomA, roomB],
  };
}

function pageTrace(pages: Array<{ label: string; text: string }>, expected: ExpectedCabinet[]): TracePage[] {
  // PDF/DXF 图纸可见标注使用 roomName/cabinetName；按 fixture 的唯一名称精确反查源 ID，
  // 任一页若缺标、匹配多柜/多房间，或源名称不唯一，后续每页与多重集合断言都会失败。
  return pages.map(({ label, text }, index) => {
    const normalized = normalize(text);
    const cabinetHits = expected.filter((cabinet) => normalized.includes(normalize(cabinet.name))).map((cabinet) => cabinet.id);
    const roomHits = [...new Map(expected.map((cabinet) => [cabinet.roomId, cabinet.roomName])).entries()]
      .filter(([, name]) => normalized.includes(normalize(name)))
      .map(([roomId]) => roomId);
    return {
      page: index + 1,
      layout: label,
      cabinetId: cabinetHits.length === 1 ? cabinetHits[0]! : null,
      roomId: roomHits.length === 1 ? roomHits[0]! : null,
      cabinetHits,
      roomHits,
    };
  });
}

function verifyPageTrace(format: string, pages: TracePage[], expected: ExpectedCabinet[]): void {
  const expectedIds = expected.map((item) => item.id);
  const actualIds = pages.flatMap((page) => page.cabinetId ? [page.cabinetId] : []);
  const expectedPairs = expected.map((item) => `${item.id}\0${item.roomId}`).sort();
  const actualPairs = pages.flatMap((page) => page.cabinetId && page.roomId ? [`${page.cabinetId}\0${page.roomId}`] : []).sort();
  const counts = new Map<string, number>();
  for (const id of actualIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const pairDetail = pages.map((page) => `${page.page}:${page.cabinetId ?? `?(${page.cabinetHits.join('|')})`} / ${page.roomId ?? `?(${page.roomHits.join('|')})`}`).join(' | ');

  assert(`${format} 每页恰好识别一个已知 cabinetId 和一个 roomId`, pages.length > 0 && pages.every((page) => page.cabinetHits.length === 1 && page.roomHits.length === 1 && page.cabinetId !== null && page.roomId !== null), pairDetail);
  assert(`${format} 导出 cabinetId 多重集合与输入完全一致，每个柜体恰有一页（无漏项、替换、重复）`, pages.length === expectedIds.length && actualIds.length === expectedIds.length && [...actualIds].sort().join('\0') === [...expectedIds].sort().join('\0') && expectedIds.every((id) => counts.get(id) === 1), `expected=${expectedIds.join(',')}; actual=${actualIds.join(',')}`);
  assert(`${format} 每个柜体页的 roomId 与输入柜体归属一致`, actualPairs.length === expectedPairs.length && actualPairs.join('\0') === expectedPairs.join('\0'), pairDetail);
}

async function main(): Promise<void> {
  try {
    const { project, expected } = makeFixture();
    const expectedIds = expected.map((cabinet) => cabinet.id);
    assert('项目级 fixture 覆盖两个房间及四个唯一柜体 ID/名称', project.rooms.length === 2 && expected.length === 4 && new Set(expectedIds).size === expectedIds.length && new Set(expected.map((cabinet) => cabinet.name)).size === expected.length,
      `rooms=${project.rooms.map((room) => room.id).join(',')}; cabinets=${expected.map((cabinet) => `${cabinet.id}@${cabinet.roomId}`).join(',')}`);
    const validation = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(root, 'scripts/validate-export.ts')], {
      input: JSON.stringify({ project }), encoding: 'utf8',
    })) as { blockingErrors?: number; issues?: Array<{ severity: string; code: string; target: string; message: string }> };
    assert('项目级导出 fixture 无阻断 ERROR', validation.blockingErrors === 0,
      JSON.stringify(validation.issues?.filter((issue) => issue.severity === 'ERROR') ?? []));
    if ((validation.blockingErrors ?? 0) > 0) throw new Error(`fixture blocked by export validation: ${JSON.stringify(validation.issues?.filter((issue) => issue.severity === 'ERROR') ?? [])}`);

    const pdfResult = await exportPdf(project, { modelVersion: 'roombook-identity-acceptance' });
    const pdfPath = join(tempDir, 'project-roombook.pdf');
    writeFileSync(pdfPath, pdfResult.pdf);
    const pdfInfo = execFileSync('pdfinfo', [pdfPath], { encoding: 'utf8' });
    const pdfPagesCount = Number(/^Pages:\s+(\d+)\s*$/m.exec(pdfInfo)?.[1] ?? 0);
    const pdfPages = Array.from({ length: pdfPagesCount }, (_, index) => ({
      label: `PDF page ${index + 1}`,
      text: execFileSync('pdftotext', ['-f', String(index + 1), '-l', String(index + 1), '-layout', pdfPath, '-'], { encoding: 'utf8' }),
    }));
    assert('项目级 PDF 是可回读的真实 PDF，渲染页数正好等于柜体数（默认不插房间布局页）', pdfResult.pdf.subarray(0, 5).toString('ascii') === '%PDF-' && pdfResult.pageCount === pdfPagesCount && pdfPagesCount === expected.length,
      `API=${pdfResult.pageCount}; pdfinfo=${pdfPagesCount}; bytes=${pdfResult.pdf.length}`);
    const pdfTrace = pageTrace(pdfPages, expected);
    console.log(`    PDF page trace: ${pdfTrace.map((page) => `${page.page}:${page.cabinetId ?? '?'}@${page.roomId ?? '?'}`).join(' | ')}`);
    verifyPageTrace('PDF', pdfTrace, expected);

    const dxfResult = await exportDxf(project, { which: ['sheet'], version: 'R2007', modelVersion: 'roombook-identity-acceptance' });
    const dxfPath = join(tempDir, 'project-roombook.dxf');
    writeFileSync(dxfPath, dxfResult.buffer);
    const dxfReadback = JSON.parse(execFileSync('python3', [join(root, 'py/verify_dxf.py'), dxfPath], { encoding: 'utf8' })) as DxfReadback;
    const allLayouts = dxfReadback.paperLayouts ?? [];
    const cabinetLayouts = allLayouts.filter((layout) => (layout.texts ?? []).some((text) => expected.some((cabinet) => normalize(text).includes(normalize(cabinet.name)))))
      .map((layout) => ({ label: layout.name, text: (layout.texts ?? []).join('\n') }));
    assert('项目级 DXF 可由 ezdxf 文件回读，逐柜纸空间 layout 恰好一页', dxfResult.buffer.length > 0 && dxfReadback.dxfversion === 'AC1021' && cabinetLayouts.length === expected.length && dxfResult.info.primStats?.sheets === expected.length,
      `version=${dxfReadback.dxfversion}; pages=${cabinetLayouts.length}; exporterSheets=${dxfResult.info.primStats?.sheets}; layouts=${allLayouts.map((layout) => `${layout.name}[${layout.entityCount}]`).join(',')}`);
    const dxfTrace = pageTrace(cabinetLayouts, expected);
    console.log(`    DXF page trace: ${dxfTrace.map((page) => `${page.page}:${page.layout}:${page.cabinetId ?? '?'}@${page.roomId ?? '?'}`).join(' | ')}`);
    verifyPageTrace('DXF', dxfTrace, expected);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`\n═══ 项目级 PDF/DXF 图册逐页 ID 回读验收：通过 ${passed} 项，失败 ${failed} 项 ═══`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = 1;
});
