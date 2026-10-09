import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DrawingEntity, Project, RuleSet } from '../src/core/types.ts';
import { rectRoom, sampleProject } from '../src/core/docFactory.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { buildCabinetViews, buildProjectViews } from '../src/core/geometry/views.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { validateCabinet } from '../src/core/rules/validate.ts';
import { planSourceKeys, sourceOverride } from '../src/core/drawingEdits.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import { toNeutralExport } from '../src/export/neutralSheet.ts';
import { buildRoomBook } from '../src/export/roomBook.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  导出验收 —— "导出成功"不能只看"文件存在"
 *
 *  这一组要钉住的事，按危险程度排：
 *
 *   ① **中文不许被写成 \U+XXXX。** ezdxf 默认 cp1252，这一条踩过实测的坑
 *      （docs/Phase0-Spike-Report.md）。图纸上一旦出现转义串，工人看到的就是
 *      "主卧衣柜"变成 "\U+4E3B\U+5367…"，而且是**打印出来才发现**。
 *
 *   ② **图层颜色不许用 ACI 7。** 7 是黑/白随背景反转，白底打印会隐形。
 *      颜色策略必须显式分配，且这一条要断言而不是"相信代码"。
 *
 *   ③ **图元数必须逐类对上。** neutral 里有几个 poly / fill / text，
 *      DXF 里就该有几个 LWPOLYLINE / HATCH / TEXT —— 少一个就是丢了一条线。
 *      只断言"实体总数 > 0"挡不住"丢一半线"这种缺陷。
 *
 *   ④ **$INSUNITS 必须是毫米。** 单位错了，图纸按米打开就是 1:1000 的灾难。
 *
 *   ⑤ 三件套（模型版本 / 生成器 / 规则集）必须写进文件 ——
 *      光靠文件名做不到"可复现"，文件会被改名。
 *
 *   ⑥ 后端接口要走真 HTTP 验一次：链路里有 spawn 两个子进程、临时目录、
 *      中文文件名 RFC 5987 —— 任何一环都可能单独坏掉。
 * ══════════════════════════════════════════════════════════════════════
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n${t}`);
}

/**
 * Python 解释器跨平台解析（与 server.mjs 的 pythonExe() 同一优先级，Codex 验收§三①）。
 * 显式路径必须存在才用；裸命令名无法 existsSync，直接保留作兜底。
 * 找不到就如实报错，不许"假装导出成功"。
 */
function resolvePython(): string {
  const cand = [
    process.env.APP_PYTHON,
    join(root, '.venv', 'Scripts', 'python.exe'),
    join(root, '..', '.venv', 'Scripts', 'python.exe'),
    join(root, '..', '.venv', 'bin', 'python'),
    'python3',
    'python',
  ]
    .filter((c): c is string => Boolean(c))
    .filter((c) => (c.includes('/') || c.includes('\\') ? existsSync(c) : true));
  return cand[0] ?? 'python';
}

const PY = resolvePython();
const VERIFY_DXF_PY = join(root, 'py', 'verify_dxf.py');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;
const project: Project = sampleProject(rules);
const fixtureIssues = new CommandBus(project, rules).issues();
const fixtureErrors = fixtureIssues.filter((issue) => issue.severity === 'ERROR');
const fixtureWarnings = fixtureIssues.filter((issue) => issue.severity === 'WARNING');
ok('HTTP 导出正样本无 ERROR、但包含 WARNING（用于验证警告不阻断）', fixtureErrors.length === 0 && fixtureWarnings.length > 0, `ERROR ${fixtureErrors.length} / WARNING ${fixtureWarnings.length}`);
const usedRoomFixtureIds = new Set(project.rooms.flatMap((room) => [room.id, ...room.walls.map((wall) => wall.id)]));
for (const cabinet of project.cabinets) usedRoomFixtureIds.add(cabinet.id);
const kitchen = rectRoom({
  name: '厨房', x: 8000, y: 0, w: 3600, h: 3000, thickness: 120, height: 2700,
  takenIds: usedRoomFixtureIds,
});
// 顺序故意与 sampleProject 的卧室顺序反过来，验证 PLAN 遵循 rooms[] 而非空间/柜体遍历顺序。
project.rooms.unshift(kitchen);

// 唯一标记覆盖贯穿 PLAN/top/front/internal：真实 PDF 与 DXF 必须共同消费重载后的同一 authored 数据。
const fixtureCabinet = project.cabinets[0]!;
const fixtureRoom = project.rooms.find((room) => room.id === fixtureCabinet.roomId)!;
const rawViews = buildCabinetViews(fixtureCabinet, rules);
const projectViews = buildProjectViews(project, rules);
const viewPlacement = projectViews.placements[fixtureCabinet.id]!;
const viewDx = viewPlacement.x - rawViews.meta.front.origin.x;
const viewDy = viewPlacement.y - rawViews.meta.front.origin.y;
const onView = (view: 'top' | 'front' | 'internal', x: number, y: number) => ({
  x: rawViews.meta[view].origin.x + x + viewDx,
  y: rawViews.meta[view].origin.y + y + viewDy,
});
project.drawingEdits = [
  {
    id: 'verify-export-top', space: 'sheet', cabinetId: fixtureCabinet.id, view: 'top', kind: 'polyline',
    points: [onView('top', 250, 180), onView('top', 410, 180), onView('top', 410, 280), onView('top', 250, 280)],
    textSize: 90, lineWidth: 2, closed: true, dash: [8, 4], layer: 'QA-EXPORT-TOP', provenance: 'manual',
  },
  {
    id: 'verify-export-front-rot', space: 'sheet', cabinetId: fixtureCabinet.id, view: 'front', kind: 'text',
    points: [onView('front', 320, 430)], text: 'QA-EXPORT-PDF-DXF-ROT-90', textSize: 125, rot: 90,
    lineWidth: 1, layer: 'QA-EXPORT-FRONT', provenance: 'manual', align: 'c',
  },
  {
    id: 'verify-export-internal', space: 'sheet', cabinetId: fixtureCabinet.id, view: 'internal', kind: 'line',
    points: [onView('internal', 170, 210), onView('internal', 280, 260)], textSize: 90,
    lineWidth: 2, layer: 'QA-EXPORT-INTERNAL', provenance: 'manual',
  },
  {
    id: 'verify-export-room-plan', space: 'plan', roomId: fixtureRoom.id, kind: 'line',
    points: [{ x: 150, y: 170 }, { x: 310, y: 230 }], textSize: 90,
    lineWidth: 2, layer: 'QA-EXPORT-ROOM-PLAN', provenance: 'manual',
  },
];
const fillIndex = projectViews.prims.findIndex((prim, i) => projectViews.sourceKeys[i]?.startsWith(`sheet:${fixtureCabinet.id}:`) && prim.k === 'fill');
const fillSource = fillIndex >= 0 ? { key: projectViews.sourceKeys[fillIndex]!, prim: projectViews.prims[fillIndex]! } : null;
ok('真实导出 fixture 的模型 fill 可见，但 sourceOverride 明确拒绝覆盖它', Boolean(fillSource && fillSource.prim.k === 'fill' && sourceOverride(fillSource.key, fillSource.prim, 'sheet', 'verify-fill') === null && !project.drawingEdits.some((edit) => edit.replacesSource === fillSource.key)));

const TMP = mkdtempSync(join(tmpdir(), 'furniture-export-verify-'));
const PORT = 8823;
const SERVER_TMP = join(TMP, 'server-tmp');
mkdirSync(SERVER_TMP, { recursive: true });

interface WorkspaceSnapshot {
  project: Project;
  workspaceId: string;
  liveModelVersion: number;
  projectSnapshotId: string;
  projectSnapshotHash: string;
  projectSnapshotVersion: number;
}

function seedWorkspace(path: string, fixture: Project, workspaceId: string): void {
  const envelope = JSON.parse(serializeProjectFile(fixture)) as Record<string, unknown>;
  Object.assign(envelope, {
    workspaceId,
    owner: 'local-open',
    account: 'local-open',
    liveModelVersion: 41,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(envelope, null, 2), 'utf8');
}

function snapshotBody(snapshot: WorkspaceSnapshot, fixture: Project = snapshot.project, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project: fixture,
    projectSnapshotId: snapshot.projectSnapshotId,
    projectSnapshotHash: snapshot.projectSnapshotHash,
    projectSnapshotVersion: snapshot.projectSnapshotVersion,
    which: ['plan', 'sheet'],
    layoutRoomIds: [],
    ...extra,
  };
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return probe.close(() => reject(new Error('未能分配本地端口')));
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

/** 为业务错误 fixture 启动隔离服务；无效项目也必须先成为服务端 live 快照，才能合法地验证 422。 */
async function withSnapshotFixture<T>(fixture: Project, workspaceId: string, run: (snapshot: WorkspaceSnapshot, port: number, tempPath: string) => Promise<T>): Promise<T> {
  const fixtureRoot = join(TMP, workspaceId);
  const fixtureTemp = join(fixtureRoot, 'server-tmp');
  mkdirSync(fixtureTemp, { recursive: true });
  const workspacePath = join(fixtureRoot, 'workspace.json');
  seedWorkspace(workspacePath, fixture, workspaceId);
  const port = await allocatePort();
  const fixtureChild = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_ENV_PATH: join(fixtureRoot, '.env'),
      APP_MEM_PATH: join(fixtureRoot, 'mem.jsonl'),
      APP_ACCOUNTS_PATH: join(fixtureRoot, 'accounts.json'),
      APP_AUDIT_PATH: join(fixtureRoot, 'audit.jsonl'),
      APP_WORKSPACE_PATH: workspacePath,
      TMPDIR: fixtureTemp,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  fixtureChild.stdout?.on('data', (data: Buffer) => { log += data.toString(); });
  fixtureChild.stderr?.on('data', (data: Buffer) => { log += data.toString(); });
  try {
    let snapshot: WorkspaceSnapshot | null = null;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (fixtureChild.exitCode !== null || fixtureChild.signalCode !== null) break;
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/workspace`);
        if (response.ok) {
          snapshot = await response.json() as WorkspaceSnapshot;
          break;
        }
      } catch { /* 服务仍在启动 */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!snapshot) throw new Error(`快照 fixture 服务启动失败（${workspaceId}）：${log}`);
    return await run(snapshot, port, fixtureTemp);
  } finally {
    if (fixtureChild.exitCode === null && fixtureChild.signalCode === null) {
      fixtureChild.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => fixtureChild.once('close', () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (fixtureChild.exitCode === null && fixtureChild.signalCode === null) fixtureChild.kill('SIGKILL');
    }
  }
}

/**
 * 为什么用异步 spawn 而不是 execFileSync：
 * 在 --experimental-strip-types 的进程里，execFileSync 起这个 python.exe 会报 EBUSY
 * （Windows + venv launcher 的组合问题），而异步 spawn 一直是好的 ——
 * 与 server.mjs 用的是同一种方式，不为了写起来短一点换一条没验证过的路。
 */
const runPy = (args: string[], input?: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const p = spawn(PY, args, { cwd: root });
    let out = '';
    let err = '';
    if (input !== undefined) p.stdin?.end(input);
    p.stdout?.on('data', (d: Buffer) => (out += d));
    p.stderr?.on('data', (d: Buffer) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`python 退出码 ${code}：${(err || out).slice(0, 600)}`))
    );
  });

// ───────────────────────── A. 中立交换格式 ─────────────────────────

section('A. 中立交换格式：几何由 TS 算好，Python 只做序列化');

const neutral = toNeutralExport(project, rules, ['plan', 'sheet'], 'v42');
ok('meta 带三件套（模型版本 / 生成器 / 规则集）', Boolean(neutral.meta.traceability?.modelVersion) && neutral.meta.traceability.modelVersion === 'v42', JSON.stringify(neutral.meta.traceability));
ok('单位是毫米、$INSUNITS=4', neutral.meta.units === 'mm' && neutral.meta.insUnits === 4);
ok('两间房各有独立 PLAN，且柜体图仍然逐柜生成', neutral.sheets.length === 3 && neutral.sheets.filter((s) => s.kind === 'room-plan').length === 2 && neutral.sheets.filter((s) => s.kind === 'cabinet').length === 1, JSON.stringify(neutral.sheets.map((s) => [s.name, s.nameZh, s.kind])));
ok('每张图纸的图元都非空', neutral.sheets.every((s) => s.prims.length > 0), JSON.stringify(neutral.sheets.map((s) => [s.name, s.prims.length])));
ok('每张图纸都带 bbox（没有它没法取景）', neutral.sheets.every((s) => s.bbox !== null));
ok('开料单非空（板件数 > 0）', neutral.panels.length > 0, `${neutral.panels.length} 块`);
const cabinetExportFixture = neutral.sheets.find((sheet) => sheet.kind === 'cabinet' && sheet.cabinetId === fixtureCabinet.id);
const roomPlanExportFixture = neutral.sheets.find((sheet) => sheet.kind === 'room-plan' && sheet.roomId === fixtureRoom.id);
const sourceFillCount = projectViews.prims.filter((prim) => prim.k === 'fill').length;
const neutralFillCount = neutral.sheets.reduce((sum, sheet) => sum + sheet.prims.filter((prim) => prim.k === 'fill').length, 0);
const roomBook = buildRoomBook(project, rules, 'v42');
const cabinetSvg = roomBook.sections.flatMap((section) => section.cabinets).find((cabinet) => cabinet.id === fixtureCabinet.id)?.sheetSvg ?? '';
ok('真实 DXF/PDF fixture 包含 cabinet top 的闭合虚线覆盖', cabinetExportFixture?.prims.some((p) => p.k === 'poly' && p.layer === 'QA-EXPORT-TOP' && p.closed && p.dash?.join(',') === '8,4'));
ok('真实 DXF/PDF fixture 包含 front 旋转文字和 internal 手工线', cabinetExportFixture?.prims.some((p) => p.k === 'text' && p.text === 'QA-EXPORT-PDF-DXF-ROT-90' && p.rot === 90) && cabinetExportFixture?.prims.some((p) => p.k === 'poly' && p.layer === 'QA-EXPORT-INTERNAL'));
ok('真实 DXF/PDF fixture 包含 room PLAN 覆盖', roomPlanExportFixture?.prims.some((p) => p.k === 'poly' && p.layer === 'QA-EXPORT-ROOM-PLAN'));
ok('只读 fill 保留原始 PDF alpha 图形与 DXF fill 几何输入', sourceFillCount > 0 && neutralFillCount > 0 && [...new Set(projectViews.prims.filter((p) => p.k === 'fill').map((p) => String(p.alpha)))].some((alpha) => cabinetSvg.includes(`fill-opacity="${alpha}"`)));
ok('PDF SVG 使用同一图纸坐标，保留闭合虚线与 90° 旋转文字', Boolean(cabinetSvg.includes('QA-EXPORT-PDF-DXF-ROT-90') && cabinetSvg.includes('rotate(-90)') && cabinetSvg.includes('stroke-dasharray="8 4"')));
ok(
  '所有制造板件的长/宽/厚都是有限正整数 mm（0 或负数不能进入导出）',
  neutral.panels.every((p) => [p.length, p.width, p.thickness].every((value) => Number.isFinite(value) && Number.isInteger(value) && value > 0)),
  JSON.stringify(neutral.panels.filter((p) => ![p.length, p.width, p.thickness].every((value) => Number.isFinite(value) && value > 0)).slice(0, 2))
);
const validCabinetGeometry = generateProject(project, rules).cabinets[fixtureCabinet.id]!;
const dimensionGuardChecks = (['length', 'width', 'thickness'] as const).map((field) => {
  const first = validCabinetGeometry.panels[0]!;
  const invalidGeometry = {
    ...validCabinetGeometry,
    panels: validCabinetGeometry.panels.map((panel, index) => index === 0 ? { ...panel, [field]: 0 } : panel),
  };
  const issue = validateCabinet(fixtureCabinet, invalidGeometry, rules).find((candidate) => candidate.code === 'RULE-PANEL-NONPOSITIVE-DIMENSION' && candidate.target === first.id);
  return { field, issue };
});
ok('共享 Cabinet validator 对 length/width/thickness 各为 0 都产生正式 ERROR', dimensionGuardChecks.every((check) => check.issue?.severity === 'ERROR' && check.issue.targetKind === 'panel'), dimensionGuardChecks.map((check) => `${check.field}:${check.issue?.code ?? 'missing'}`).join(', '));

// ───────────────────────── B. DXF 序列化 + 回读 ─────────────────────────

section('B. DXF 序列化与回读（ezdxf 双向验证）');

const neutralPath = join(TMP, 'neutral.json');
writeFileSync(neutralPath, JSON.stringify(neutral), 'utf8');
const dxfPath = join(TMP, 'out.dxf');
const buildInfo = JSON.parse(await runPy([join(root, 'py', 'export_dxf.py'), neutralPath, dxfPath, 'R2007']));
ok('导出脚本退出码 0 并返回统计', Boolean(buildInfo?.entities), JSON.stringify(buildInfo?.primStats ?? buildInfo));

const check = JSON.parse(await runPy([VERIFY_DXF_PY, dxfPath, neutralPath]));

ok('DXF 版本是 R2007（AC1021，原生 UTF-8）', check.dxfversion === 'AC1021', check.dxfversion);
ok(`实体总数 ${check.entities} 与 neutral 图元数一致`, check.entities === neutral.sheets.reduce((a, s) => a + s.prims.length, 0), `DXF ${check.entities} vs neutral ${neutral.sheets.reduce((a, s) => a + s.prims.length, 0)}`);
ok(
  '【关键】逐类对上：poly→LWPOLYLINE / fill→LWPOLYLINE轮廓 / text→TEXT（少一个就是丢一条线）',
  // fill 走线框模式：转成闭合 LWPOLYLINE，不再是 HATCH（手机看图软件会把实心 HATCH 渲染成灰块）
  (check.counts.LWPOLYLINE ?? 0) === neutral.sheets.reduce((a, s) => a + s.prims.filter((p) => p.k === 'poly' || p.k === 'fill').length, 0) &&
    (check.counts.HATCH ?? 0) === 0 &&
    (check.counts.TEXT ?? 0) === neutral.sheets.reduce((a, s) => a + s.prims.filter((p) => p.k === 'text').length, 0),
  JSON.stringify({ dxf: check.counts, neutral: neutral.sheets.map((s) => s.prims.reduce((a, p) => ((a[p.k] = (a[p.k] ?? 0) + 1), a), {})) })
);
ok(
  '不生成最近邻猜配的 DIMENSION/LEADER 实体（避免与权威线条和文字重复）',
  (check.counts.DIMENSION ?? 0) === 0 && (check.counts.LEADER ?? 0) === 0,
  JSON.stringify({ DIMENSION: check.counts.DIMENSION ?? 0, LEADER: check.counts.LEADER ?? 0 })
);
ok(
  '【关键】中文没有被写成 \\U+XXXX（这个坑打印出来才会发现）',
  check.escapedTexts.length === 0,
  JSON.stringify(check.escapedTexts.slice(0, 3))
);
ok('图纸里确实有中文文字（不是"全空的通过"）', check.textCount > 0 && check.texts.some((text: string) => /[\u4e00-\u9fff]/.test(text)), JSON.stringify(check.sampleTexts));
ok('【关键】图层颜色没有用到 ACI 7（黑/白随背景反转，白底隐形）', check.colorSevenUsed === false, JSON.stringify(check.layerColors));
ok('$INSUNITS = 4（毫米。单位错了整张图就是 1:1000 的灾难）', check.insUnits === 4, String(check.insUnits));
const nonemptyPaperLayouts = check.paperLayouts.filter((layout: any) => layout.entityCount > 0);
const expectedRoomSheets = neutral.sheets.filter((sheet) => sheet.kind === 'room-plan');
const expectedCabinetSheets = neutral.sheets.filter((sheet) => sheet.kind === 'cabinet');
const semanticLayoutBySheet = new Map<string, string>(
  (check.neutralSemantics?.sheets ?? []).map((entry: any) => [String(entry.sheet), String(entry.layout)])
);
const roomLayouts = nonemptyPaperLayouts.filter((layout: any) => expectedRoomSheets.some((sheet) => semanticLayoutBySheet.get(sheet.name) === layout.name));
const cabinetLayouts = nonemptyPaperLayouts.filter((layout: any) => expectedCabinetSheets.some((sheet) => semanticLayoutBySheet.get(sheet.name) === layout.name));
ok(
  '每间房 PLAN 和每个柜体图各有独立 A3 横向纸空间 layout',
  nonemptyPaperLayouts.length === neutral.sheets.length && roomLayouts.length === expectedRoomSheets.length && cabinetLayouts.length === expectedCabinetSheets.length && nonemptyPaperLayouts.every((layout: any) => layout.paperWidth === 420 && layout.paperHeight === 297 && /A3/.test(layout.paperSize)),
  JSON.stringify(nonemptyPaperLayouts.map((layout: any) => ({ name: layout.name, paperSize: layout.paperSize, paperWidth: layout.paperWidth, paperHeight: layout.paperHeight })))
);
ok(
  'PLAN 与柜体图都按毫米、纸空间 1:1 出图且没有覆盖内容的视口；PLAN 不进入 modelspace',
  check.modelspaceEntities === 0 && nonemptyPaperLayouts.length > 0 && nonemptyPaperLayouts.every((layout: any) => layout.plotPaperUnits === 1 && layout.plotScaleNumerator === 1 && layout.plotScaleDenominator === 1 && layout.plotRotation === 0 && layout.plotType === 5 && layout.viewportCount === 0),
  JSON.stringify({ modelspaceEntities: check.modelspaceEntities, layouts: nonemptyPaperLayouts.map((layout: any) => ({ name: layout.name, units: layout.plotPaperUnits, scale: `${layout.plotScaleNumerator}:${layout.plotScaleDenominator}`, rotation: layout.plotRotation, plotType: layout.plotType, viewports: layout.viewportCount })) })
);
ok(
  '房间 PLAN 与柜体图实体边界均完整落在 A3 的 5 mm 打印安全边距内',
  nonemptyPaperLayouts.length > 0 && nonemptyPaperLayouts.every((layout: any) => layout.fitsPrintableArea),
  JSON.stringify(nonemptyPaperLayouts.map((layout: any) => ({ name: layout.name, bounds: layout.bounds, margins: layout.margins })))
);
ok(
  'PLAN 按 rooms[] 顺序回读为独立布局，且源图元经统一比例变换未丢失或跨页',
  JSON.stringify((check.neutralSemantics?.sheets ?? []).filter((entry: any) => expectedRoomSheets.some((sheet) => sheet.name === entry.sheet)).map((entry: any) => entry.sheet)) === JSON.stringify(expectedRoomSheets.map((sheet) => sheet.name)) && roomLayouts.length === expectedRoomSheets.length && (check.neutralSemantics?.sheets ?? []).filter((entry: any) => expectedRoomSheets.some((sheet) => sheet.name === entry.sheet)).every((entry: any) => entry.ok),
  JSON.stringify({ expected: expectedRoomSheets.map((sheet) => sheet.name), actual: (check.neutralSemantics?.sheets ?? []).filter((entry: any) => expectedRoomSheets.some((sheet) => sheet.name === entry.sheet)) })
);
ok(
  '柜体图纸纸面字高合理（1.5–10 mm），而非数百 DXF 单位',
  cabinetLayouts.length > 0 && cabinetLayouts.every((layout: any) => layout.textHeightMin >= 1.5 && layout.textHeightMax <= 10),
  JSON.stringify(cabinetLayouts.map((layout: any) => ({ name: layout.name, min: layout.textHeightMin, max: layout.textHeightMax })))
);
ok(
  '房间 PLAN 与柜体图纸的所有图元、折线顶点、闭合状态、文字、字高和相对几何均保持一致',
  check.neutralSemantics?.ok === true,
  JSON.stringify(check.neutralSemantics)
);
const expectedTextContent = neutral.sheets.flatMap((sheet) => sheet.prims.filter((prim) => prim.k === 'text' && prim.text).map((prim) => prim.text));
ok(
  'DXF 中所有文字内容与中立图纸顺序完全一致',
  JSON.stringify(check.texts) === JSON.stringify(expectedTextContent),
  JSON.stringify({ actual: check.texts.length, expected: expectedTextContent.length })
);
ok(
  '三件套写进了文件自定义属性（光靠文件名做不到可复现，文件会被改名）',
  Boolean(check.custom?.FurnitureModelVersion) && check.custom.FurnitureModelVersion === 'v42',
  JSON.stringify(check.custom)
);

// ───────────────────────── C. 后端接口（真 HTTP） ─────────────────────────

section('C. 后端导出接口：真 HTTP 走一遍整条链路');

const workspacePath = join(TMP, 'workspace.json');
seedWorkspace(workspacePath, project, 'ws_export_acceptance');
const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    APP_HOST: '127.0.0.1',
    APP_ENV_PATH: join(TMP, '.env'),
    APP_MEM_PATH: join(TMP, 'mem.jsonl'),
    APP_ACCOUNTS_PATH: join(TMP, 'accounts.json'),
    APP_AUDIT_PATH: join(TMP, 'audit.jsonl'),
    APP_WORKSPACE_PATH: workspacePath,
    TMPDIR: SERVER_TMP,
  },
});
await new Promise<void>((resolve) => {
  const t = setTimeout(() => resolve(), 6000);
  child.stdout.on('data', (d: Buffer) => {
    if (String(d).includes('监听')) {
      clearTimeout(t);
      resolve();
    }
  });
});

try {
  const postAt = async (port: number, path: string, body: unknown): Promise<{ status: number; headers: Headers; buf: Buffer }> => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, headers: r.headers, buf: Buffer.from(await r.arrayBuffer()) };
  };
  const post = (path: string, body: unknown) => postAt(PORT, path, body);
  const snapshotResponse = await fetch(`http://127.0.0.1:${PORT}/api/workspace`);
  if (!snapshotResponse.ok) throw new Error(`/api/workspace 返回 ${snapshotResponse.status}: ${(await snapshotResponse.text()).slice(0, 500)}`);
  const confirmedSnapshot = await snapshotResponse.json() as WorkspaceSnapshot;
  ok('真实导出先读取 /api/workspace 的确认 ID/hash/version', Boolean(confirmedSnapshot.projectSnapshotId && confirmedSnapshot.projectSnapshotHash && Number.isSafeInteger(confirmedSnapshot.projectSnapshotVersion))
    && confirmedSnapshot.projectSnapshotVersion === confirmedSnapshot.liveModelVersion
    && confirmedSnapshot.projectSnapshotId === `ws_export_acceptance:v${confirmedSnapshot.projectSnapshotVersion}:${confirmedSnapshot.projectSnapshotHash}`,
  `version=${confirmedSnapshot.projectSnapshotVersion}; hash=${confirmedSnapshot.projectSnapshotHash}`);

  const assertSnapshotRejected = async (
    path: string,
    label: string,
    body: unknown,
    expectedCode: string,
    expectedField: string,
    port = PORT,
    tempPath = SERVER_TMP,
  ): Promise<void> => {
    const response = await postAt(port, path, body);
    let payload: any = {};
    try { payload = JSON.parse(response.buf.toString('utf8')); } catch { /* 快照拒绝必须是 JSON */ }
    const mismatchFields = Array.isArray(payload.mismatchFields) ? payload.mismatchFields : [];
    ok(`${label} → 409 ${expectedCode} 且无附件`, response.status === 409 && payload.code === expectedCode
      && mismatchFields.includes(expectedField) && !response.headers.has('Content-Disposition')
      && (response.headers.get('Content-Type') ?? '').includes('application/json')
      && response.headers.get('Cache-Control') === 'no-store',
    `status=${response.status}; code=${payload.code ?? 'none'}; fields=${JSON.stringify(mismatchFields)}`);
    const remaining = readdirSync(tempPath);
    ok(`${label} 拒绝前未生成导出临时文件`, remaining.length === 0, JSON.stringify(remaining));
  };

  const snapshotMismatchCases = [
    {
      label: '缺少全部快照元数据',
      body: { project: confirmedSnapshot.project, which: ['plan', 'sheet'], layoutRoomIds: [] },
      code: 'EXPORT_SNAPSHOT_REQUIRED',
      field: 'projectSnapshotId',
    },
    {
      label: '快照版本冲突',
      body: snapshotBody(confirmedSnapshot, confirmedSnapshot.project, { projectSnapshotVersion: confirmedSnapshot.projectSnapshotVersion + 1 }),
      code: 'EXPORT_SNAPSHOT_CONFLICT',
      field: 'projectSnapshotVersion',
    },
    {
      label: '快照 hash 冲突',
      body: (() => {
        const tampered = structuredClone(confirmedSnapshot.project);
        tampered.cabinets[0]!.name += ' hash-mismatch';
        return snapshotBody(confirmedSnapshot, tampered, { projectSnapshotHash: '0'.repeat(64) });
      })(),
      code: 'EXPORT_SNAPSHOT_CONFLICT',
      field: 'projectSnapshotHash',
    },
  ] as const;
  for (const [path, label] of [
    ['/api/export/pdf', 'PDF'],
    ['/api/export/dxf', 'DXF'],
    ['/api/export/cutlist', 'CSV'],
  ] as const) {
    for (const mismatch of snapshotMismatchCases) {
      await assertSnapshotRejected(path, `${label} ${mismatch.label}`, mismatch.body, mismatch.code, mismatch.field);
    }
  }

  const blockedProject = structuredClone(project);
  blockedProject.cabinets[0]!.params.width = 10000;
  blockedProject.cabinets[0]!.layout.units[2]!.doors!.count = 1;
  const blockedCases = [
    ['/api/export/pdf', 'PDF'],
    ['/api/export/dxf', 'DXF'],
    ['/api/export/cutlist', 'CSV'],
  ] as const;
  await withSnapshotFixture(blockedProject, 'ws_export_blocked_errors', async (blockedSnapshot, blockedPort) => {
    for (const [path, label] of blockedCases) {
      const blocked = await postAt(blockedPort, path, snapshotBody(blockedSnapshot));
      let payload: any = {};
      try { payload = JSON.parse(blocked.buf.toString('utf8')); } catch { /* 拒绝响应必须是 JSON */ }
      ok(`${label} 有 ERROR 时真实 HTTP 请求返回 422 EXPORT_BLOCKED`, blocked.status === 422 && payload.code === 'EXPORT_BLOCKED', `status=${blocked.status} code=${payload.code ?? 'none'}`);
      ok(`${label} 拒绝响应列出可修复的 ERROR 清单`, Array.isArray(payload.issues) && payload.issues.length > 0 && payload.issues.every((issue: any) => issue.severity === 'ERROR') && payload.blockingErrors === payload.issues.length, JSON.stringify(payload.issues?.slice(0, 2)));
    }
  });

  const nonpositivePanelProject = structuredClone(project);
  nonpositivePanelProject.drawingEdits = [];
  nonpositivePanelProject.cabinets.find((cabinet) => cabinet.id === fixtureCabinet.id)!.params.width = 2 * rules.materials[fixtureCabinet.params.boardMaterial]!.thickness;
  const badPanelIssues = new CommandBus(nonpositivePanelProject, rules).issues().filter((issue) => issue.code === 'RULE-PANEL-NONPOSITIVE-DIMENSION');
  ok('非法宽度 fixture 实际派生出非正尺寸板件并被共享校验标记 ERROR', badPanelIssues.length > 0 && badPanelIssues.every((issue) => issue.severity === 'ERROR' && issue.targetKind === 'panel'), badPanelIssues.map((issue) => `${issue.target}:${issue.message}`).slice(0, 2).join(' | '));
  await withSnapshotFixture(nonpositivePanelProject, 'ws_export_nonpositive_panel', async (panelSnapshot, panelPort) => {
    for (const [path, label] of blockedCases) {
      const rejected = await postAt(panelPort, path, snapshotBody(panelSnapshot));
      let payload: any = {};
      try { payload = JSON.parse(rejected.buf.toString('utf8')); } catch { /* 正式导出阻断应返回结构化 JSON */ }
      ok(`${label} 对非正制造板件真实返回 422 EXPORT_BLOCKED RULE-PANEL-NONPOSITIVE-DIMENSION`, rejected.status === 422 && payload.code === 'EXPORT_BLOCKED' && payload.issues?.some((issue: any) => issue.code === 'RULE-PANEL-NONPOSITIVE-DIMENSION' && issue.severity === 'ERROR' && issue.targetKind === 'panel'), `status=${rejected.status}; issues=${JSON.stringify(payload.issues?.map((issue: any) => issue.code) ?? payload)}`);
    }
  });

  const dxfRes = await post('/api/export/dxf', snapshotBody(confirmedSnapshot, confirmedSnapshot.project, { modelVersion: 'v7' }));
  ok('无 ERROR（仅含 WARNING）时 POST /api/export/dxf 返回 200', dxfRes.status === 200, String(dxfRes.status));
  ok('DXF 成功响应绑定已确认的快照 ID/hash/version', dxfRes.headers.get('X-Project-Snapshot-Id') === confirmedSnapshot.projectSnapshotId
    && dxfRes.headers.get('X-Project-Snapshot-Hash') === confirmedSnapshot.projectSnapshotHash
    && dxfRes.headers.get('X-Project-Snapshot-Version') === String(confirmedSnapshot.projectSnapshotVersion));
  ok('Content-Type 是 application/dxf', (dxfRes.headers.get('Content-Type') ?? '').includes('dxf'), String(dxfRes.headers.get('Content-Type')));
  ok('响应体是 DXF（以 SECTION/HEADER 开头），不是一段错误 JSON', dxfRes.buf.subarray(0, 20).toString('latin1').includes('SECTION'), dxfRes.buf.subarray(0, 40).toString('latin1'));
  ok(
    '中文文件名走 RFC 5987（否则下载下来是乱码）',
    /filename\*=UTF-8''/.test(dxfRes.headers.get('Content-Disposition') ?? ''),
    String(dxfRes.headers.get('Content-Disposition'))
  );
  ok('DXF 体量合理（> 10KB，说明不是只有几条线的空壳）', dxfRes.buf.length > 10 * 1024, `${dxfRes.buf.length} bytes`);

  const viaHttp = join(TMP, 'via-http.dxf');
  writeFileSync(viaHttp, dxfRes.buf);
  const check2 = JSON.parse(await runPy([VERIFY_DXF_PY, viaHttp, neutralPath]));
  ok('走 HTTP 拿到的 DXF 同样通过回读校验（中文 / 颜色 / A3 比例 / 边界 / 几何语义）', check2.escapedTexts.length === 0 && check2.colorSevenUsed === false && check2.insUnits === 4 && (check2.counts.DIMENSION ?? 0) === 0 && (check2.counts.LEADER ?? 0) === 0 && check2.neutralSemantics?.ok === true && check2.paperLayouts.filter((layout: any) => layout.entityCount > 0).every((layout: any) => layout.fitsPrintableArea && layout.plotScaleNumerator === 1 && layout.plotScaleDenominator === 1), JSON.stringify({ esc: check2.escapedTexts.length, c7: check2.colorSevenUsed, semantics: check2.neutralSemantics, paperLayouts: check2.paperLayouts.filter((layout: any) => layout.entityCount > 0) }));
  const httpCabinetReadback = check2.neutralSemantics?.sheets?.find((entry: any) => entry.sheet === cabinetExportFixture?.name);
  ok('真实 HTTP DXF 文件中的 cabinet sheet 逐顶点回读通过（含闭合、虚线、旋转文字）', Boolean(httpCabinetReadback?.ok && httpCabinetReadback.actualEntities === httpCabinetReadback.expectedEntities), JSON.stringify(httpCabinetReadback));

  const unsupportedViewProject = structuredClone(project);
  unsupportedViewProject.drawingEdits![0] = { ...unsupportedViewProject.drawingEdits![0]!, view: 'side' };
  for (const path of ['/api/export/pdf', '/api/export/dxf']) {
    await assertSnapshotRejected(path, `${path.endsWith('pdf') ? 'PDF' : 'DXF'} 未确认的 side 覆盖项目 hash 冲突`,
      snapshotBody(confirmedSnapshot, unsupportedViewProject), 'EXPORT_SNAPSHOT_CONFLICT', 'project');
  }

  const staleSourceProject = structuredClone(project);
  const beforeResize = generateProject(staleSourceProject, rules);
  const originalCabinetPlan = beforeResize.cabinets[fixtureCabinet.id]?.plan ?? [];
  const originalCabinetKeys = planSourceKeys(`cabinet:${fixtureCabinet.id}`, originalCabinetPlan);
  const resizeProbe = structuredClone(project);
  resizeProbe.cabinets.find(cabinet => cabinet.id === fixtureCabinet.id)!.params.width += 120;
  const resizedProbe = generateProject(resizeProbe, rules);
  const resizedKeys = new Set(planSourceKeys(`cabinet:${fixtureCabinet.id}`, resizedProbe.cabinets[fixtureCabinet.id]?.plan ?? []));
  const staleCandidateIndex = originalCabinetPlan.findIndex((prim, index) =>
    (prim.k === 'poly' || prim.k === 'text') && originalCabinetKeys.filter(key => key === originalCabinetKeys[index]).length === 1 && !resizedKeys.has(originalCabinetKeys[index]!)
  );
  ok('HTTP stale fixture 找到唯一、可编辑的柜体平面源图元', staleCandidateIndex >= 0, String(staleCandidateIndex));
  const staleSourceKey = originalCabinetKeys[staleCandidateIndex] ?? `plan:cabinet:${fixtureCabinet.id}:g:missing-fingerprint`;
  const stalePrim = originalCabinetPlan[staleCandidateIndex];
  const staleOverride = stalePrim
    ? sourceOverride(staleSourceKey, stalePrim, 'plan', 'verify-export-stale-source', { roomId: fixtureRoom.id, cabinetId: fixtureCabinet.id })
    : null;
  ok('HTTP stale fixture 在模型参数变化前成功绑定原始 source key', Boolean(staleOverride), staleSourceKey);
  if (staleOverride) staleSourceProject.drawingEdits!.push(staleOverride);
  staleSourceProject.cabinets.find(cabinet => cabinet.id === fixtureCabinet.id)!.params.width += 120;
  ok('HTTP stale fixture 的柜体宽度重算后，旧覆盖 source key 已不存在', !resizedKeys.has(staleSourceKey), staleSourceKey);
  await withSnapshotFixture(staleSourceProject, 'ws_export_stale_source', async (staleSnapshot, stalePort) => {
    for (const path of ['/api/export/pdf', '/api/export/dxf']) {
      const rejected = await postAt(stalePort, path, snapshotBody(staleSnapshot));
      let payload: any = {};
      try { payload = JSON.parse(rejected.buf.toString('utf8')); } catch { /* 阻断应有结构化 JSON */ }
      ok(`${path.endsWith('pdf') ? 'PDF' : 'DXF'} 遇到已失效 source 覆盖时返回 422 DRAWING-SOURCE-STALE`, rejected.status === 422 && payload.code === 'EXPORT_BLOCKED' && payload.issues?.some((issue: any) => issue.code === 'DRAWING-SOURCE-STALE'), `status=${rejected.status}; ${JSON.stringify(payload.issues?.[0] ?? payload)}`);
    }
  });

  const topPrefix = `sheet:${fixtureCabinet.id}:top:`;
  const topSourceCounts = new Map<string, number>();
  for (const key of projectViews.sourceKeys) topSourceCounts.set(key, (topSourceCounts.get(key) ?? 0) + 1);
  const uniqueTopIndex = projectViews.sourceKeys.findIndex((key, index) => key.startsWith(topPrefix) && topSourceCounts.get(key) === 1 && projectViews.prims[index]?.k === 'poly');
  const uniqueTopKey = projectViews.sourceKeys[uniqueTopIndex];
  ok('ambiguous HTTP fixture 找到唯一 top 源线作为两条覆盖的共同目标', Boolean(uniqueTopKey), String(uniqueTopIndex));
  if (uniqueTopKey) {
    const ambiguousSourceProject = structuredClone(project);
    const makeAmbiguousEdit = (id: string): DrawingEntity => ({
      id, space: 'sheet', cabinetId: fixtureCabinet.id, view: 'top', kind: 'line',
      points: [{ x: 11, y: 11 }, { x: 31, y: 31 }], textSize: 90, lineWidth: 1,
      layer: 'QA-AMBIGUOUS-SOURCE', provenance: 'model-override', replacesSource: uniqueTopKey!,
    });
    ambiguousSourceProject.drawingEdits!.push(makeAmbiguousEdit('verify-export-ambiguous-a'), makeAmbiguousEdit('verify-export-ambiguous-b'));
    await withSnapshotFixture(ambiguousSourceProject, 'ws_export_ambiguous_source', async (ambiguousSnapshot, ambiguousPort) => {
      for (const path of ['/api/export/pdf', '/api/export/dxf']) {
        const rejected = await postAt(ambiguousPort, path, snapshotBody(ambiguousSnapshot));
        let payload: any = {};
        try { payload = JSON.parse(rejected.buf.toString('utf8')); } catch { /* 阻断应有结构化 JSON */ }
        ok(`${path.endsWith('pdf') ? 'PDF' : 'DXF'} 遇到多个覆盖竞争同一源时返回 422 DRAWING-SOURCE-AMBIGUOUS`, rejected.status === 422 && payload.code === 'EXPORT_BLOCKED' && payload.issues?.some((issue: any) => issue.code === 'DRAWING-SOURCE-AMBIGUOUS'), `status=${rejected.status}; ${JSON.stringify(payload.issues?.filter((issue: any) => issue.code?.startsWith('DRAWING-SOURCE-')) ?? payload)}`);
      }
    });
  }

  const selectedRoomId = project.rooms[1]!.id;
  const selectedNeutral = toNeutralExport(project, rules, ['plan'], 'selected-room', undefined, [selectedRoomId]);
  const selectedNeutralPath = join(TMP, 'selected-room-neutral.json');
  writeFileSync(selectedNeutralPath, JSON.stringify(selectedNeutral), 'utf8');
  const selectedRoomRes = await post('/api/export/dxf', snapshotBody(confirmedSnapshot, confirmedSnapshot.project, { which: ['plan'], planRoomIds: [selectedRoomId], modelVersion: 'selected-room' }));
  ok('HTTP DXF 可按房间 ID 只导出选中的 PLAN', selectedRoomRes.status === 200, String(selectedRoomRes.status));
  const selectedRoomDxf = join(TMP, 'selected-room.dxf');
  writeFileSync(selectedRoomDxf, selectedRoomRes.buf);
  const selectedRoomCheck = JSON.parse(await runPy([VERIFY_DXF_PY, selectedRoomDxf, selectedNeutralPath]));
  ok('所选房间仅生成一个独立 layout，顺序/几何/纸张边界回读全部通过', selectedRoomCheck.neutralSemantics?.ok === true && selectedRoomCheck.modelspaceEntities === 0 && selectedRoomCheck.paperLayouts.filter((layout: any) => layout.entityCount > 0).length === 1 && selectedRoomCheck.paperLayouts.filter((layout: any) => layout.entityCount > 0).every((layout: any) => layout.fitsPrintableArea), JSON.stringify(selectedRoomCheck.neutralSemantics));

  const pdfRes = await post('/api/export/pdf', snapshotBody(confirmedSnapshot, confirmedSnapshot.project, { modelVersion: 'pdf-v7' }));
  ok('无 ERROR（仅含 WARNING）时 POST /api/export/pdf 返回 200', pdfRes.status === 200, String(pdfRes.status));
  ok('PDF 成功响应绑定已确认的快照 ID/hash/version', pdfRes.headers.get('X-Project-Snapshot-Id') === confirmedSnapshot.projectSnapshotId
    && pdfRes.headers.get('X-Project-Snapshot-Hash') === confirmedSnapshot.projectSnapshotHash
    && pdfRes.headers.get('X-Project-Snapshot-Version') === String(confirmedSnapshot.projectSnapshotVersion));
  ok('PDF Content-Type 是 application/pdf', (pdfRes.headers.get('Content-Type') ?? '').includes('application/pdf'), String(pdfRes.headers.get('Content-Type')));
  ok('PDF 响应体有有效 %PDF- 签名且体量合理', pdfRes.buf.subarray(0, 5).toString('ascii') === '%PDF-' && pdfRes.buf.length > 10 * 1024, `${pdfRes.buf.length} bytes / ${pdfRes.buf.subarray(0, 5).toString('ascii')}`);
  const expectedPdfPages = roomBook.totals.cabinets;
  ok('PDF 默认不插入房间 PLAN，页数等于柜体生产图页数', Number(pdfRes.headers.get('X-PDF-Page-Count')) === expectedPdfPages, `${pdfRes.headers.get('X-PDF-Page-Count')} vs ${expectedPdfPages} cabinets; layoutRoomIds defaults empty`);
  const pdfPath = join(TMP, 'drawing-edits.pdf');
  writeFileSync(pdfPath, pdfRes.buf);
  const pdfText = spawnSync('pdftotext', [pdfPath, '-'], { encoding: 'utf8' });
  ok('真实 PDF 保留 top/front/internal 覆盖中的唯一 front 旋转文字标记', pdfText.status === 0 && pdfText.stdout.includes('QA-EXPORT-PDF-DXF-ROT-90'), (pdfText.stderr || pdfText.stdout).slice(0, 300));
  const pdfBBox = spawnSync('pdftotext', ['-bbox', pdfPath, '-'], { encoding: 'utf8' });
  const markerBox = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">QA-EXPORT-PDF-DXF-ROT-90<\/word>/.exec(pdfBBox.stdout);
  const pageTextPrim = cabinetExportFixture?.prims.find((prim) => prim.k === 'text' && prim.text === 'QA-EXPORT-PDF-DXF-ROT-90');
  const viewBox = /viewBox="([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+)"/.exec(cabinetSvg);
  let pdfCoordinateMatch = false, pdfRotationMatch = false;
  if (markerBox && pageTextPrim?.k === 'text' && viewBox) {
    const [vbX, vbY, vbW, vbH] = viewBox.slice(1).map(Number);
    const scale = Math.min(420 / vbW!, 297 / vbH!);
    const offsetX = (420 - vbW! * scale) / 2, offsetY = (297 - vbH! * scale) / 2;
    const expectedX = (offsetX + (pageTextPrim.p.x - vbX!) * scale) * 72 / 25.4;
    const expectedY = (offsetY + (-pageTextPrim.p.y - vbY!) * scale) * 72 / 25.4;
    const [x1, y1, x2, y2] = markerBox.slice(1).map(Number);
    const actualX = (x1! + x2!) / 2, actualY = (y1! + y2!) / 2;
    pdfCoordinateMatch = Math.hypot(actualX - expectedX, actualY - expectedY) < 100;
    pdfRotationMatch = y2! - y1! > (x2! - x1!) * 1.5;
  }
  ok('实际 PDF 标记 bbox 落在 SVG 视图坐标经 A3 页面变换后的同一锚点附近', pdfBBox.status === 0 && pdfCoordinateMatch, markerBox?.slice(1).join(',') ?? pdfBBox.stderr);
  ok('实际 PDF 文件中文字 bbox 呈竖排，核验 90° 旋转而非只核对文本存在', pdfRotationMatch, markerBox?.slice(1).join(',') ?? pdfBBox.stderr);
  const pdfAlpha = spawnSync(PY, ['-c', `from pypdf import PdfReader\nimport json,sys\nr=PdfReader(sys.argv[1])\nvals=[]\nfor page in r.pages:\n res=page.get('/Resources')\n if not res: continue\n gs=res.get('/ExtGState')\n if not gs: continue\n for item in gs.get_object().values():\n  obj=item.get_object()\n  if '/ca' in obj: vals.append(float(obj['/ca']))\nprint(json.dumps(vals))`, pdfPath], { encoding: 'utf8' });
  const pdfAlphas: number[] = pdfAlpha.status === 0 ? JSON.parse(pdfAlpha.stdout) : [];
  ok('实际 PDF 文件保留只读 fill 的透明度图形状态（alpha < 1）', pdfAlpha.status === 0 && pdfAlphas.some((alpha) => alpha < 0.999), (pdfAlpha.stderr || pdfAlpha.stdout).slice(0, 300));
  ok('PDF 中文文件名走 RFC 5987', /filename\*=UTF-8''/.test(pdfRes.headers.get('Content-Disposition') ?? ''), String(pdfRes.headers.get('Content-Disposition')));

  const csvRes = await post('/api/export/cutlist', snapshotBody(confirmedSnapshot));
  ok('无 ERROR（仅含 WARNING）时 POST /api/export/cutlist 返回 200', csvRes.status === 200, String(csvRes.status));
  ok('CSV 成功响应绑定已确认的快照 ID/hash/version', csvRes.headers.get('X-Project-Snapshot-Id') === confirmedSnapshot.projectSnapshotId
    && csvRes.headers.get('X-Project-Snapshot-Hash') === confirmedSnapshot.projectSnapshotHash
    && csvRes.headers.get('X-Project-Snapshot-Version') === String(confirmedSnapshot.projectSnapshotVersion));
  const csv = csvRes.buf.toString('utf8');
  ok('CSV 带 BOM（没有它 Excel 打开中文就是乱码）', csv.charCodeAt(0) === 0xfeff, `首字符码点 ${csv.charCodeAt(0)}`);
  ok(
    `CSV 行数 = 表头 + 板件数（${neutral.panels.length + 1}）`,
    csv.trim().split(/\r?\n/).length === neutral.panels.length + 1,
    String(csv.trim().split(/\r?\n/).length)
  );
  ok('CSV 表头是中文（工人看得懂的表，不是给程序看的）', /板件ID/.test(csv) && /厚\(mm\)/.test(csv), csv.split(/\r?\n/)[0]);

  await assertSnapshotRejected('/api/export/dxf', '缺 project', { ...snapshotBody(confirmedSnapshot), project: undefined }, 'EXPORT_SNAPSHOT_CONFLICT', 'project');
  await assertSnapshotRejected('/api/export/pdf', 'PDF 缺 project', { ...snapshotBody(confirmedSnapshot), project: undefined }, 'EXPORT_SNAPSHOT_CONFLICT', 'project');

  section('D. roombook 快照：并入独立真实 HTTP 的匹配/拒绝/TOCTOU 验收');
  const roombookRun = spawnSync(process.execPath, [join(here, 'roombook-snapshot-http-negative.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (roombookRun.stdout) process.stdout.write(roombookRun.stdout);
  if (roombookRun.stderr) process.stderr.write(roombookRun.stderr);
  const roombookSummary = /roombook snapshot HTTP negative acceptance:\s*(\d+) passed,\s*(\d+) failed/.exec(roombookRun.stdout ?? '');
  if (roombookSummary) {
    const roombookPass = Number(roombookSummary[1]);
    const roombookFail = Number(roombookSummary[2]);
    pass += roombookPass;
    fail += roombookFail;
    if (roombookFail > 0) failures.push('roombook snapshot HTTP 子验收失败');
    if (roombookRun.status !== 0 && roombookFail === 0) {
      fail++;
      failures.push(`roombook snapshot HTTP 子验收异常退出（status=${roombookRun.status}）`);
    }
  } else {
    fail++;
    failures.push(`roombook snapshot HTTP 子验收未给出计数（status=${roombookRun.status}; ${roombookRun.error?.message ?? ''}）`);
  }
} finally {
  child.kill();
  rmSync(TMP, { recursive: true, force: true });
}

// ───────────────────────── 汇总 ─────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (fail === 0) {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log('导出成立：逐柜横向 PDF 与 DXF / CSV 服务端链路、中文/颜色/单位/三件套全部过关。');
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log(`失败项：${failures.join('、')}`);
  process.exitCode = 1;
}
