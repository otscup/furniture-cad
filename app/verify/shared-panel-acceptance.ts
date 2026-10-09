import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, RuleSet, SharedPanel } from '../src/core/types.ts';
import { createCabinet, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { confirmSharedPanel, sharedPanelConfirmationPayload, sharedPanelParts } from '../src/core/sharedPanels.ts';
import { serializeProjectFile, parseProjectFile } from '../src/core/projectFile.ts';
import { manufacturingToNeutralExportDefault } from '../src/core/manufacturing/bridge.ts';
import { deriveManufacturing } from '../src/core/manufacturing/derive.ts';
import { exportCutlist, exportDxf, exportPdf, ExportBlockedError } from '../server/exportCore.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rules = JSON.parse(readFileSync(join(root, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
let passed = 0;
let failed = 0;
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function readDxfSharedPieceSize(path: string, panelId: string, sourceScale: number): { length: number; width: number } | null {
  const script = [
    'import ezdxf, json, sys',
    'doc = ezdxf.readfile(sys.argv[1])',
    'target = "sharedPanelId=" + sys.argv[2]',
    'for layout in doc.layouts:',
    '    texts = [entity.plain_text() for entity in layout if entity.dxftype() in ("TEXT", "MTEXT")]',
    '    if not any(target in text for text in texts): continue',
    '    polys = [entity for entity in layout if entity.dxftype() == "LWPOLYLINE" and entity.closed]',
    '    if not polys: break',
    '    poly = max(polys, key=lambda entity: (max(p[0] for p in entity.get_points("xy")) - min(p[0] for p in entity.get_points("xy"))) * (max(p[1] for p in entity.get_points("xy")) - min(p[1] for p in entity.get_points("xy"))))',
    '    points = list(poly.get_points("xy"))',
    '    print(json.dumps({"length": (max(p[0] for p in points) - min(p[0] for p in points)) / float(sys.argv[3]), "width": (max(p[1] for p in points) - min(p[1] for p in points)) / float(sys.argv[3])}))',
    '    break',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script, path, panelId, String(sourceScale)], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout) as { length: number; width: number }; } catch { return null; }
}
function isExportBlocked(error: unknown): boolean {
  return error instanceof ExportBlockedError || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EXPORT_BLOCKED');
}
async function writeExportResult<T>(path: string, operation: () => Promise<T>, toBytes: (result: T) => Buffer | string): Promise<boolean> {
  try {
    const result = await operation();
    writeFileSync(path, toBytes(result));
    return false;
  } catch (error) {
    return isExportBlocked(error);
  }
}

const base = sampleProject(rules);
const room = rectRoom({ name: '共享板验收厨房', x: 0, y: 0, w: 3200, h: 2600, id: 'room_shared_acceptance' });
const c1 = createCabinet({ id: 'cab_shared_left', name: '左柜', roomId: room.id, x: 400, y: 60, rules, params: { width: 600, height: 900, depth: 600 } });
const c2 = createCabinet({ id: 'cab_shared_right', name: '右柜', roomId: room.id, x: 1000, y: 60, rules, params: { width: 600, height: 900, depth: 600 }, units: c1.layout.units.map((unit) => ({ ...unit, id: 'unit_shared_right' })) });
const project: Project = { ...base, id: 'project_shared_acceptance', name: '共享板验收', rooms: [room], cabinets: [c1, c2], assemblies: undefined, sharedPanels: undefined };
const geom = generateProject(project, rules);
const replacedPanelIds = [c1, c2].map((cabinet) => geom.cabinets[cabinet.id]!.panels.find((panel) => panel.role === 'TopPanel')!.id);
const draft: SharedPanel = {
  id: 'SP_COUNTER_001',
  name: '厨房连续台面',
  memberCabinetIds: [c1.id, c2.id],
  replacesPanelIds: replacedPanelIds,
  bounds: { minX: 400, minY: 60, maxX: 1600, maxY: 660 },
  elevation: 980,
  length: 1200,
  width: 600,
  thickness: 18,
  material: 'M_BOARD_18_WOOD',
  finish: '同柜体板材饰面',
  edgeTreatment: { top: null, bottom: null, left: null, right: null },
  overhang: { front: 0, back: 0, left: 0, right: 0 },
  grainDirection: 'length',
  grain: 'length',
  segmentation: { confirmed: true, segments: [{ id: 'whole', x: 400, y: 60, length: 1200, width: 600 }] },
  support: { confirmed: true, method: '两柜侧板连续承托', memberCabinetIds: [c1.id, c2.id] },
  machining: { status: 'confirmed-holes', holes: [{ id: 'hole_shared_01', kind: '盲孔', x: 120, y: 150, diameter: 8, depth: 10 }] },
  memberSnapshots: [],
  confirmation: { status: 'draft' },
};
const validPanel = confirmSharedPanel(draft, project);
const valid: Project = { ...project, sharedPanels: [validPanel] };
function refreshConfirmation(panel: SharedPanel): SharedPanel {
  const refreshed = { ...panel, confirmation: { status: 'confirmed' as const, fingerprint: '' } };
  refreshed.confirmation.fingerprint = sharedPanelConfirmationPayload(refreshed);
  return refreshed;
}
function panelWithFrontOverhang(front: number): SharedPanel {
  const finishedWidth = 600 + front;
  return confirmSharedPanel({
    ...draft,
    bounds: { minX: 400, minY: 60, maxX: 1600, maxY: 660 + front },
    width: finishedWidth,
    overhang: { front, back: 0, left: 0, right: 0 },
    segmentation: { confirmed: true, segments: [{ id: 'whole', x: 400, y: 60, length: 1200, width: finishedWidth }] },
  }, project);
}

const validIssues = new CommandBus(valid, rules).issues();
check('显式确认的共享板通过统一项目校验', !validIssues.some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED'), validIssues.map((issue) => issue.message).join(' | '));
const requiredKeys: Array<[string, Partial<SharedPanel>]> = [
  ['材料', { material: '' }], ['厚度', { thickness: 0 }], ['饰面', { finish: '' }],
  ['纹理方向', { grainDirection: undefined }],
  ['四边封边', { edgeTreatment: undefined }], ['外挑', { overhang: undefined }],
  ['支撑', { support: undefined }], ['接缝分段', { segmentation: undefined }],
  ['孔位状态', { machining: undefined }],
];
const blockedMissingKeys = requiredKeys.map(([key, missing]) => {
  const incomplete = confirmSharedPanel({ ...validPanel, ...missing } as SharedPanel, project);
  return [key, new CommandBus({ ...project, sharedPanels: [incomplete] }, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED')] as const;
});
check('厚度/材料/饰面/四边封边/外挑/支撑/接缝/CNC 字段任缺一项都阻断', blockedMissingKeys.every(([, blocked]) => blocked), JSON.stringify(blockedMissingKeys));
const manufacturing = sharedPanelParts(valid, rules);
const validPanelIds = new Set(manufacturing.map((panel) => panel.id));
const allCabinetParts = Object.values(geom.cabinets).flatMap((cabinet) => cabinet.panels);
const originalTopIds = new Set(replacedPanelIds);
check('共享对象只生成一个共享制造 ID，两个柜顶不再作为独立件', manufacturing.length === 1 && manufacturing[0]?.sharedPanelTrace?.id === validPanel.id &&
  replacedPanelIds.every((id) => !validPanelIds.has(id)) && allCabinetParts.filter((panel) => !originalTopIds.has(panel.id)).length === allCabinetParts.length - 2,
  JSON.stringify({ manufacturing: manufacturing.map((panel) => panel.id), replacedPanelIds }));
const unsharedManufacturing = deriveManufacturing(project, geom, rules);
check('未显式建共享对象时，相邻柜仍分别保留各自箱体顶板', replacedPanelIds.every((id) => unsharedManufacturing.parts.some((part) => part.id === id)));

const staleProject: Project = { ...valid, cabinets: valid.cabinets.map((cabinet) => cabinet.id === c2.id ? { ...cabinet, placement: { ...cabinet.placement, x: cabinet.placement.x + 1 } } : cabinet) };
check('成员柜位置变化标记 stale 且不派生共享板生产件', new CommandBus(staleProject, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED') && sharedPanelParts(staleProject, rules).length === 0);
const materialChangedProject: Project = { ...valid, cabinets: valid.cabinets.map((cabinet) => cabinet.id === c2.id ? { ...cabinet, params: { ...cabinet.params, boardMaterial: 'M_BOARD_15_WOOD' } } : cabinet) };
check('任一成员柜材料变化标记 stale 并阻断共享件生产', new CommandBus(materialChangedProject, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED') && sharedPanelParts(materialChangedProject, rules).length === 0);
const dimensionChangedProject: Project = { ...valid, cabinets: valid.cabinets.map((cabinet) => cabinet.id === c2.id ? { ...cabinet, params: { ...cabinet.params, height: cabinet.params.height + 1 } } : cabinet) };
check('任一成员柜尺寸变化标记 stale 并阻断共享件生产', new CommandBus(dimensionChangedProject, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED') && sharedPanelParts(dimensionChangedProject, rules).length === 0);
const invalidMemberCases: Array<[string, unknown[]]> = [
  ['空 ID', [c1.id, '', c2.id]], ['未知 ID', [c1.id, 'cab_shared_missing', c2.id]], ['重复 ID', [c1.id, c1.id, c2.id]],
];
for (const [label, memberCabinetIds] of invalidMemberCases) {
  const panel = confirmSharedPanel({ ...draft, memberCabinetIds: memberCabinetIds as string[] }, project);
  const candidate = { ...project, sharedPanels: [panel] };
  check(`成员 cabinetId ${label} 被拒并不派生共享件`, new CommandBus(candidate, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED') && sharedPanelParts(candidate, rules).length === 0);
}
const mixedNumericIds = confirmSharedPanel({ ...draft, memberCabinetIds: [c1.id, 42, c2.id] as unknown as string[] }, project);
const mixedNumericProject: Project = { ...project, sharedPanels: [mixedNumericIds] };
check('成员 cabinetId 混入数字时不经字符串过滤放行', new CommandBus(mixedNumericProject, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED' && issue.message.includes('非空字符串')) && sharedPanelParts(mixedNumericProject, rules).length === 0);
const repeatedSnapshotPanel = refreshConfirmation({ ...validPanel, memberSnapshots: [validPanel.memberSnapshots[0]!, validPanel.memberSnapshots[0]!] });
const omittedMemberChangedProject: Project = {
  ...project,
  sharedPanels: [repeatedSnapshotPanel],
  cabinets: project.cabinets.map((cabinet) => cabinet.id === c2.id ? { ...cabinet, params: { ...cabinet.params, height: cabinet.params.height + 1 } } : cabinet),
};
const repeatedSnapshotIssues = new CommandBus(omittedMemberChangedProject, rules).issues().filter((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED');
check('重复成员快照不能占位另一成员；遗漏且已变化的成员使快照 stale 并阻断派生', repeatedSnapshotIssues.some((issue) => issue.message.includes('快照必须与成员 cabinetId 精确一一对应')) &&
  repeatedSnapshotIssues.some((issue) => issue.message.includes('成员柜快照缺失')) && sharedPanelParts(omittedMemberChangedProject, rules).length === 0);
const resizedProject: Project = { ...valid, sharedPanels: [{ ...validPanel, length: validPanel.length - 1 }] };
check('共享板尺寸在确认后变化也会 stale 并阻断生产', new CommandBus(resizedProject, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED') && sharedPanelParts(resizedProject, rules).length === 0);
const staleOverhangProject: Project = { ...valid, sharedPanels: [{ ...validPanel, overhang: { ...validPanel.overhang, front: 100 } }] };
check('仅改确认后的外挑而不重确认会 stale 并阻断生产', new CommandBus(staleOverhangProject, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED') && sharedPanelParts(staleOverhangProject, rules).length === 0);
const front100Panel = panelWithFrontOverhang(100);
const front100Project: Project = { ...project, sharedPanels: [front100Panel] };
const front100Part = sharedPanelParts(front100Project, rules)[0];
check('重新确认 front=100 后 bounds 和真实成品料沿前侧增至 1200×700', !new CommandBus(front100Project, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED') &&
  front100Panel.bounds.maxY === 760 && front100Panel.width === 700 && front100Part?.length === 1200 && front100Part.width === 700);
const negativeOverhangPanel = panelWithFrontOverhang(-50);
const negativeOverhangProject: Project = { ...project, sharedPanels: [negativeOverhangPanel] };
check('front=-50 无内缩工艺定义时产生 ERROR 并不派生成品料', new CommandBus(negativeOverhangProject, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED' && issue.message.includes('负外挑')) && sharedPanelParts(negativeOverhangProject, rules).length === 0);
const referenceOnly = confirmSharedPanel({ ...draft, machining: { status: 'reference-only', holes: [] } }, project);
check('参考孔位仍为参考标记，确认字段也不能放行生产', new CommandBus({ ...project, sharedPanels: [referenceOnly] }, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED'));
const missingHoleDepth = confirmSharedPanel({ ...draft, machining: { status: 'confirmed-holes', holes: [{ id: 'hole_missing_depth', kind: '盲孔', x: 120, y: 150, diameter: 8 } as unknown as SharedPanel['machining']['holes'][number]] } }, project);
check('缺失任一孔位关键尺寸（孔深）仍是待确认并阻断导出', new CommandBus({ ...project, sharedPanels: [missingHoleDepth] }, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED'));
const explicitNoHoles = confirmSharedPanel({ ...draft, machining: { status: 'confirmed-none', holes: [] } }, project);
check('确认为无孔时必须持久化 confirmed-none 与空孔位数组', !new CommandBus({ ...project, sharedPanels: [explicitNoHoles] }, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED'));
const oversized = confirmSharedPanel({ ...draft, bounds: { minX: 400, minY: 60, maxX: 3000, maxY: 660 }, length: 2600, overhang: { front: 0, back: 0, left: 0, right: 1400 }, segmentation: { confirmed: true, segments: [{ id: 'whole', x: 400, y: 60, length: 2600, width: 600 }] } }, project);
check('整件超出板幅且未确认分段时不能进入生产清单', new CommandBus({ ...project, sharedPanels: [oversized] }, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED') && sharedPanelParts({ ...project, sharedPanels: [oversized] }, rules).length === 0);
const manuallySegmented = confirmSharedPanel({ ...draft, bounds: { minX: 400, minY: 60, maxX: 3000, maxY: 660 }, length: 2600, overhang: { front: 0, back: 0, left: 0, right: 1400 }, segmentation: { confirmed: true, segments: [
  { id: 'seam-a', x: 400, y: 60, length: 1300, width: 600 }, { id: 'seam-b', x: 1700, y: 60, length: 1300, width: 600 },
] } }, project);
check('超过整板幅面时仅接受用户确认、无重叠并完整覆盖的人工分段', !new CommandBus({ ...project, sharedPanels: [manuallySegmented] }, rules).issues().some((issue) => issue.code === 'RULE-SHARED-PANEL-BLOCKED') && sharedPanelParts({ ...project, sharedPanels: [manuallySegmented] }, rules).length === 2);
const schemaRoundTrip = parseProjectFile(serializeProjectFile(valid, '2026-10-09T12:00:00.000Z'));
check('项目文件往返保留共享件纹理方向、精确成员快照和成品边界并标记 schema 0.4', schemaRoundTrip.ok && schemaRoundTrip.project.schemaVersion === '0.4' &&
  schemaRoundTrip.project.sharedPanels?.[0]?.id === validPanel.id && schemaRoundTrip.project.sharedPanels?.[0]?.grainDirection === 'length' &&
  schemaRoundTrip.project.sharedPanels?.[0]?.memberSnapshots.length === 2 && schemaRoundTrip.project.sharedPanels?.[0]?.bounds.maxY === 660, JSON.stringify(schemaRoundTrip));

const scratch = mkdtempSync(join(tmpdir(), 'shared-panel-acceptance-'));
try {
  const csvPath = join(scratch, 'shared.csv');
  const dxfPath = join(scratch, 'shared.dxf');
  const neutralPath = join(scratch, 'neutral.json');
  const pdfPath = join(scratch, 'shared.pdf');
  const pdfTextPath = join(scratch, 'shared.txt');

  const csvResult = await exportCutlist(valid, { modelVersion: 'shared-acceptance' });
  writeFileSync(csvPath, csvResult.csv, 'utf8');
  const csv = readFileSync(csvPath, 'utf8');
  const csvLines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const sharedRows = csvLines.filter((line) => line.includes(validPanel.id));
  check('零外挑 CSV 实际成品料为 1200×600，并同一 SharedPanel ID 回读全规格、纹理与孔位', sharedRows.length === 1 && sharedRows[0]!.includes(c1.id) && sharedRows[0]!.includes(c2.id) &&
    replacedPanelIds.every((id) => sharedRows[0]!.includes(id)) && sharedRows[0]!.includes(',18,1200,600,1,length,') && sharedRows[0]!.includes('hole_shared_01') && sharedRows[0]!.includes('盲孔') && sharedRows[0]!.includes('""diameter"":8') && sharedRows[0]!.includes('""depth"":10') && sharedRows[0]!.includes('同柜体板材饰面') &&
    ['overallSize', 'elevation', 'edgeTreatment', 'overhang', 'segmentation', 'support', 'grainDirection', 'grainReference', 'nestingBoundary'].every((field) => sharedRows[0]!.includes(field)) &&
    csvLines.length === manufacturing.length + allCabinetParts.length - 2 + 1,
    JSON.stringify({ lines: csvLines.length, sharedRows }));

  const dxfResult = await exportDxf(valid, { which: ['sheet'], modelVersion: 'shared-acceptance' });
  writeFileSync(dxfPath, dxfResult.buffer);
  const neutral = manufacturingToNeutralExportDefault(valid, rules, ['sheet'], 'shared-acceptance');
  writeFileSync(neutralPath, JSON.stringify(neutral), 'utf8');
  const dxfReadback = spawnSync('python3', [join(root, 'py/verify_dxf.py'), dxfPath, neutralPath], { cwd: root, encoding: 'utf8' });
  const dxfReport = dxfReadback.status === 0 ? JSON.parse(dxfReadback.stdout) : null;
  const sharedDxfSheet = neutral.sheets.find((sheet) => sheet.kind === 'shared-panel' && sheet.sharedPanelId === validPanel.id);
  const dxfNotes = dxfReport?.texts?.join('\n') ?? '';
  const sharedDxfCompare = dxfReport?.neutralSemantics?.sheets?.find((entry: { sheet: string }) => entry.sheet === sharedDxfSheet?.name);
  const dxfPieceSize = sharedDxfCompare?.scale ? readDxfSharedPieceSize(dxfPath, validPanel.id, sharedDxfCompare.scale) : null;
  check('零外挑 DXF 回读闭合成品轮廓为 1200×600，且同一 sharedPanelId 页图元等价并含纹理/规格/孔位', Boolean(dxfReport?.neutralSemantics?.ok && sharedDxfSheet && dxfPieceSize &&
    Math.abs(dxfPieceSize.length - 1200) < 1e-6 && Math.abs(dxfPieceSize.width - 600) < 1e-6 &&
    dxfNotes.includes(`sharedPanelId=${validPanel.id}`) && dxfNotes.includes('M_BOARD_18_WOOD') && dxfNotes.includes('同柜体板材饰面') &&
    dxfNotes.includes('grainDirection=length') && dxfNotes.includes('no-professional-sheet-nesting-or-stock-rotation-optimization') &&
    dxfNotes.includes('edgeTreatment=') && dxfNotes.includes('overhang(') && dxfNotes.includes('segmentationConfirmed=true') &&
    dxfNotes.includes('supportCabinetIds=') && dxfNotes.includes('hole_shared_01:盲孔@120,150 Ø8 深10') && dxfReport.layouts.some((name: string) => name.includes('共享板'))), dxfReadback.stderr || dxfReadback.stdout.slice(0, 500));

  const pdfResult = await exportPdf(valid, { modelVersion: 'shared-acceptance', layoutRoomIds: [] });
  writeFileSync(pdfPath, pdfResult.pdf);
  const pdfText = spawnSync('pdftotext', ['-layout', pdfPath, pdfTextPath], { cwd: root, encoding: 'utf8' });
  const extracted = pdfText.status === 0 && existsSync(pdfTextPath) ? readFileSync(pdfTextPath, 'utf8') : '';
  check('零外挑 PDF 为有效文件并回读 1200×600 成品尺寸、共享 ID、成员、纹理和孔位', pdfResult.pdf.subarray(0, 5).toString('ascii') === '%PDF-' &&
    extracted.includes(validPanel.id) && extracted.includes(c1.id) && extracted.includes(c2.id) && replacedPanelIds.every((id) => extracted.includes(id)) &&
    extracted.includes('成品尺寸/标高：1200×600×18mm') && extracted.includes('M_BOARD_18_WOOD') && extracted.includes('同柜体板材饰面') && extracted.includes('纹理方向：length') &&
    extracted.includes('两柜侧板连续承托') && extracted.includes('hole_shared_01') && extracted.includes('盲孔') && extracted.includes('Ø8mm') && extracted.includes('深10mm') &&
    ['成品边界', '外挑', '接缝分段', '四边处理', '标高', '不提供专业开料优化'].every((field) => extracted.includes(field)) && pdfResult.pageCount >= 3,
    JSON.stringify({ pageCount: pdfResult.pageCount, hasId: extracted.includes(validPanel.id) }));

  const front100CsvPath = join(scratch, 'front-100.csv');
  const front100DxfPath = join(scratch, 'front-100.dxf');
  const front100NeutralPath = join(scratch, 'front-100-neutral.json');
  const front100PdfPath = join(scratch, 'front-100.pdf');
  const front100TextPath = join(scratch, 'front-100.txt');
  const front100CsvResult = await exportCutlist(front100Project, { modelVersion: 'shared-front-100' });
  writeFileSync(front100CsvPath, front100CsvResult.csv, 'utf8');
  const front100CsvRow = readFileSync(front100CsvPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.includes(front100Panel.id)) ?? '';

  const front100DxfResult = await exportDxf(front100Project, { which: ['sheet'], modelVersion: 'shared-front-100' });
  writeFileSync(front100DxfPath, front100DxfResult.buffer);
  const front100Neutral = manufacturingToNeutralExportDefault(front100Project, rules, ['sheet'], 'shared-front-100');
  writeFileSync(front100NeutralPath, JSON.stringify(front100Neutral), 'utf8');
  const front100DxfReadback = spawnSync('python3', [join(root, 'py/verify_dxf.py'), front100DxfPath, front100NeutralPath], { cwd: root, encoding: 'utf8' });
  const front100DxfReport = front100DxfReadback.status === 0 ? JSON.parse(front100DxfReadback.stdout) : null;
  const front100Sheet = front100Neutral.sheets.find((sheet) => sheet.kind === 'shared-panel' && sheet.sharedPanelId === front100Panel.id);
  const front100Compare = front100DxfReport?.neutralSemantics?.sheets?.find((entry: { sheet: string }) => entry.sheet === front100Sheet?.name);
  const front100DxfSize = front100Compare?.scale ? readDxfSharedPieceSize(front100DxfPath, front100Panel.id, front100Compare.scale) : null;
  const front100DxfNotes = front100DxfReport?.texts?.join('\n') ?? '';

  const front100PdfResult = await exportPdf(front100Project, { modelVersion: 'shared-front-100', layoutRoomIds: [] });
  writeFileSync(front100PdfPath, front100PdfResult.pdf);
  const front100PdfTextResult = spawnSync('pdftotext', ['-layout', front100PdfPath, front100TextPath], { cwd: root, encoding: 'utf8' });
  const front100PdfText = front100PdfTextResult.status === 0 && existsSync(front100TextPath) ? readFileSync(front100TextPath, 'utf8') : '';
  check('front=100 的 CSV/PDF/DXF 均回读 1200×700 成品实尺寸；DXF 实际闭合轮廓回读等价',
    front100CsvRow.includes(front100Panel.id) && front100CsvRow.includes(',18,1200,700,1,length,') && front100CsvRow.includes('""overallSize"":[1200,700,18]') &&
    front100PdfText.includes(front100Panel.id) && front100PdfText.includes('成品尺寸/标高：1200×700×18mm') && front100PdfText.includes('纹理方向：length') &&
    Boolean(front100DxfReport?.neutralSemantics?.ok && front100Sheet && front100DxfSize && Math.abs(front100DxfSize.length - 1200) < 1e-6 && Math.abs(front100DxfSize.width - 700) < 1e-6 &&
      front100DxfNotes.includes(`sharedPanelId=${front100Panel.id}`) && front100DxfNotes.includes('overall=1200×700×18mm')),
    JSON.stringify({ csv: front100CsvRow, pdfPages: front100PdfResult.pageCount, dxfSize: front100DxfSize, dxf: front100DxfReadback.stderr }));

  const numericCsvPath = join(scratch, 'mixed-numeric-id.csv');
  const numericBlocked = await writeExportResult(numericCsvPath, () => exportCutlist(mixedNumericProject, { modelVersion: 'shared-invalid-member-id' }), (result) => result.csv);
  check('成员 ID 混入数字时正式 CSV 被拒且零文件产出', numericBlocked && !existsSync(numericCsvPath));
  const duplicateSnapshotCsvPath = join(scratch, 'duplicate-snapshot.csv');
  const duplicateSnapshotBlocked = await writeExportResult(duplicateSnapshotCsvPath, () => exportCutlist(omittedMemberChangedProject, { modelVersion: 'shared-duplicate-snapshot' }), (result) => result.csv);
  check('重复快照占位并遗漏已变化成员时正式 CSV 被拒且零文件产出', duplicateSnapshotBlocked && !existsSync(duplicateSnapshotCsvPath));

  const negativeCsvPath = join(scratch, 'negative-overhang.csv');
  const negativeDxfPath = join(scratch, 'negative-overhang.dxf');
  const negativePdfPath = join(scratch, 'negative-overhang.pdf');
  const negativeCsvBlocked = await writeExportResult(negativeCsvPath, () => exportCutlist(negativeOverhangProject, { modelVersion: 'shared-negative-overhang' }), (result) => result.csv);
  const negativeDxfBlocked = await writeExportResult(negativeDxfPath, () => exportDxf(negativeOverhangProject, { which: ['sheet'], modelVersion: 'shared-negative-overhang' }), (result) => result.buffer);
  const negativePdfBlocked = await writeExportResult(negativePdfPath, () => exportPdf(negativeOverhangProject, { modelVersion: 'shared-negative-overhang', layoutRoomIds: [] }), (result) => result.pdf);
  check('front=-50 时 CSV/PDF/DXF 均由正式入口拒绝，三个目标文件均零产出', negativeCsvBlocked && negativeDxfBlocked && negativePdfBlocked &&
    !existsSync(negativeCsvPath) && !existsSync(negativeDxfPath) && !existsSync(negativePdfPath));

  let blocked = false;
  try { await exportCutlist({ ...project, sharedPanels: [{ ...draft, confirmation: { status: 'draft' } }] }, { modelVersion: 'shared-acceptance' }); }
  catch (error) { blocked = error instanceof ExportBlockedError || (error as { code?: string }).code === 'EXPORT_BLOCKED'; }
  check('draft / 未确认共享板被服务端正式导出入口拒绝', blocked);
  let incompleteBlocked = false;
  try { await exportCutlist({ ...project, sharedPanels: [missingHoleDepth] }, { modelVersion: 'shared-acceptance' }); }
  catch (error) { incompleteBlocked = error instanceof ExportBlockedError || (error as { code?: string }).code === 'EXPORT_BLOCKED'; }
  check('孔位字段缺失时服务端 CSV 正式导出也被阻断', incompleteBlocked);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed) process.exitCode = 1;
