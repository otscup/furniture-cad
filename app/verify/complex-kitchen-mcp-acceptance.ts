import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { emptyProject } from '../src/core/docFactory.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import type { Cabinet, Project, RuleSet } from '../src/core/types.ts';
import { detectCollisions, generateProject } from '../src/core/geometry/project.ts';
import { buildProjectBodies } from '../src/core/geometry/bodies3d.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { buildRoomPlanCallouts } from '../src/export/roomBook.ts';
import { buildFurnitureSheet } from '../src/export/furnitureSheet.ts';
import { cabinetWarningIssues, formatCabinetWarning } from '../src/export/warningNotes.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const tempDir = mkdtempSync(join(tmpdir(), 'furnicad-complex-mcp-'));
const outDir = resolve(process.env.VERIFY_OUTPUT_DIR ?? join(root, 'verify-output/complex-kitchen'));
mkdirSync(outDir, { recursive: true });
const safetyPhrase = '参考预留｜非 CNC 开孔｜待拆单确认';
let child: ChildProcess | null = null;
let port = 0;
let nextId = 1;
let checks = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  checks++;
  if (!cond) throw new Error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`);
}
const wait = (ms: number) => new Promise((resolveWait) => setTimeout(resolveWait, ms));
const normalizePdfText = (value: string) => value.replace(/\s+/g, '').replace(/[\u200b\ufeff]/g, '');
function parsePdfLines(bboxText: string): Array<Array<{ text: string; xMin: number; yMin: number; xMax: number; yMax: number }>> {
  const decode = (value: string) => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const pages = [...bboxText.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)];
  return pages.map((page) => [...(page[1] ?? '').matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/g)].map((match) => {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const get = (name: string) => Number(new RegExp(`${name}="([^"]+)"`).exec(attrs)?.[1] ?? NaN);
    const text = [...body.matchAll(/<word\b[^>]*>([\s\S]*?)<\/word>/g)].map((word) => decode(word[1] ?? '')).join(' ');
    return { text, xMin: get('xMin'), yMin: get('yMin'), xMax: get('xMax'), yMax: get('yMax') };
  }));
}
function parsePdfPageSizes(bboxText: string): Array<{ width: number; height: number }> {
  return [...bboxText.matchAll(/<page\b([^>]*)>/g)].map((match) => {
    const attrs = match[1] ?? '';
    const get = (name: string) => Number(new RegExp(`${name}="([^"]+)"`).exec(attrs)?.[1] ?? NaN);
    return { width: get('width'), height: get('height') };
  });
}
function boxesOverlap(a: { xMin: number; yMin: number; xMax: number; yMax: number }, b: { xMin: number; yMin: number; xMax: number; yMax: number }): boolean {
  return a.xMin < b.xMax && a.xMax > b.xMin && a.yMin < b.yMax && a.yMax > b.yMin;
}
async function allocatePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (!address || typeof address === 'string') return srv.close(() => reject(new Error('no port')));
      const found = address.port;
      srv.close((err) => err ? reject(err) : resolvePort(found));
    });
  });
}
function seedWorkspace(filePath: string): void {
  const project = emptyProject({ ruleSetId: 'factory_default_v1' });
  project.name = '隔离测试厨房（MCP）';
  const envelope = JSON.parse(serializeProjectFile(project)) as Record<string, unknown>;
  Object.assign(envelope, { workspaceId: 'ws_complex_kitchen', owner: 'local-open', account: 'local-open', liveModelVersion: 0, updatedAt: new Date().toISOString() });
  writeFileSync(filePath, JSON.stringify(envelope, null, 2), 'utf8');
}
async function startServer(): Promise<void> {
  port = await allocatePort();
  const wsPath = join(tempDir, 'workspace.json');
  seedWorkspace(wsPath);
  child = spawn(process.execPath, [join(root, 'server/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), APP_HOST: '127.0.0.1', APP_PYTHON: process.env.APP_PYTHON ?? 'python3',
      APP_ENV_PATH: join(tempDir, '.env'), APP_ACCOUNTS_PATH: join(tempDir, 'accounts.json'),
      APP_AUDIT_PATH: join(tempDir, 'audit.jsonl'), APP_MEM_PATH: join(tempDir, 'corrections.jsonl'),
      APP_REGISTRATIONS_PATH: join(tempDir, 'registrations.json'), APP_WORKSPACE_PATH: wsPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (d: Buffer) => { log += d.toString(); });
  child.stderr?.on('data', (d: Buffer) => { log += d.toString(); });
  for (let i = 0; i < 180; i++) {
    await wait(100);
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch { /* wait until listen */ }
  }
  throw new Error(`MCP server did not start: ${log}`);
}
async function callTool(name: string, args: Record<string, unknown> = {}, expectError = false): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.text();
  let json: any;
  try { json = JSON.parse(raw); } catch { throw new Error(`${name}: invalid JSON-RPC response: ${raw.slice(0, 500)}`); }
  const result = json?.result;
  const isError = result?.isError === true;
  const content = result?.content?.[0]?.text;
  let payload: any;
  try { payload = JSON.parse(content ?? '{}'); } catch { payload = { raw: content }; }
  if (expectError) {
    if (!isError) throw new Error(`${name}: expected tool error, got ${JSON.stringify(payload).slice(0, 600)}`);
  } else if (!response.ok || isError || payload?.ok === false) {
    throw new Error(`${name}: ${JSON.stringify(payload).slice(0, 900)}`);
  }
  return payload;
}

type LiveExportSnapshot = {
  ok: true;
  project: Project;
  workspaceId: string;
  liveModelVersion: number;
  projectSnapshotId: string;
  projectSnapshotHash: string;
  projectSnapshotVersion: number;
};
async function readLiveExportSnapshot(): Promise<LiveExportSnapshot> {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace`);
  if (!response.ok) throw new Error(`/api/workspace 返回 ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return await response.json() as LiveExportSnapshot;
}

async function main(): Promise<void> {
  await startServer();
  console.log(`隔离 MCP server: http://127.0.0.1:${port}/mcp`);
  const listRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} }),
  });
  const listJson: any = await listRes.json();
  const toolNames = (listJson?.result?.tools ?? []).map((tool: any) => tool.name);
  assert('真实 MCP 工具公开柜体组合、房间 PDF 与草稿验证', ['cad.create_assembly', 'cad.export_pdf', 'cad.validate'].every((name) => toolNames.includes(name)), toolNames.join(', '));

  const room = await callTool('cad.create_room', { name: '隔离验收厨房', x: 0, y: 0, w: 5000, h: 4000, height: 2700 });
  const draftId = String(room.draftId);
  const roomId = String(room.roomId);
  assert('通过 MCP 在隔离 workspace 新建厨房房间', Boolean(draftId && roomId), `${roomId}, draft=${draftId}`);
  const boardT = rules.materials.M_BOARD_18_WOOD.thickness;

  const created: Array<{ name: string; id: string; width: number; height: number; depth: number; type: 'base' | 'wall' }> = [];
  async function createCabinet(input: {
    name: string; x: number; y: number; width: number; height: number; depth: number;
    cabinetType: 'base' | 'wall'; mountHeight: number; bodyLift: number;
    units: Array<Record<string, unknown>>; counterCutouts?: Array<Record<string, unknown>>;
  }): Promise<string> {
    const payload = await callTool('cad.create_cabinet', { ...input, roomId, draftId });
    const id = String(payload.cabinetId);
    created.push({ name: input.name, id, width: input.width, height: input.height, depth: input.depth, type: input.cabinetType });
    return id;
  }

  const base1 = await createCabinet({ name: '01 三抽地柜', x: 60, y: 60, width: 800, height: 850, depth: 600, cabinetType: 'base', mountHeight: 0, bodyLift: 40, units: [{ kind: 'drawerBank', width: 800 - 2 * boardT, count: 3, nickname: '三抽' }] });
  const base2 = await createCabinet({ name: '02 水槽地柜', x: 860, y: 60, width: 900, height: 850, depth: 600, cabinetType: 'base', mountHeight: 0, bodyLift: 80, units: [{ kind: 'shelves', width: (900 - 3 * boardT) / 2, count: 1, doorCount: 1, nickname: '水槽柜左格' }, { kind: 'shelves', width: (900 - 3 * boardT) / 2, count: 1, doorCount: 1, nickname: '水槽柜右格' }], counterCutouts: [{ kind: 'sink', name: '水槽预留', x: 125, y: 80, width: 650, depth: 450 }] });
  const base3 = await createCabinet({ name: '03 灶具地柜', x: 1760, y: 60, width: 900, height: 850, depth: 600, cabinetType: 'base', mountHeight: 0, bodyLift: 80, units: [{ kind: 'shelves', width: (900 - 3 * boardT) / 2, count: 1, doorCount: 1, nickname: '灶具柜左格' }, { kind: 'shelves', width: (900 - 3 * boardT) / 2, count: 1, doorCount: 1, nickname: '灶具柜右格' }], counterCutouts: [{ kind: 'cooktop', name: '灶具预留', x: 130, y: 40, width: 640, depth: 520 }] });
  const base4 = await createCabinet({ name: '04 烤箱地柜', x: 2660, y: 60, width: 604, height: 850, depth: 600, cabinetType: 'base', mountHeight: 0, bodyLift: 80, units: [{ kind: 'appliance', width: 604 - 2 * boardT, nickname: '烤箱位', applianceName: '烤箱预留', openingWidth: 568, openingHeight: 600, openingDepth: 560, topDrawers: 1 }] });
  const wall1 = await createCabinet({ name: '05 左吊柜', x: 60, y: 60, width: 1200, height: 700, depth: 350, cabinetType: 'wall', mountHeight: 1450, bodyLift: 0, units: [376, 376, 376].map((width, i) => ({ kind: 'shelves', width, count: 2, doorCount: 1, nickname: `左吊柜${i + 1}格` })) });
  const wall2 = await createCabinet({ name: '06 中吊柜', x: 1260, y: 60, width: 1000, height: 700, depth: 350, cabinetType: 'wall', mountHeight: 1450, bodyLift: 0, units: [473, 473].map((width, i) => ({ kind: 'shelves', width, count: 2, doorCount: 1, nickname: `中吊柜${i + 1}格` })) });
  const wall3 = await createCabinet({ name: '07 右吊柜', x: 2260, y: 60, width: 1000, height: 700, depth: 350, cabinetType: 'wall', mountHeight: 1450, bodyLift: 0, units: [473, 473].map((width, i) => ({ kind: 'shelves', width, count: 2, doorCount: 1, nickname: `右吊柜${i + 1}格` })) });
  assert('通过 MCP 创建 4 地柜 + 3 吊柜，含抽屉/水槽/灶具/烤箱预留', created.length === 7, `${created.length} cabinets`);

  const butt = (a: string, b: string) => ({ kind: 'butt', a: { cabinetId: a, edge: 'right' }, b: { cabinetId: b, edge: 'left' } });
  await callTool('cad.create_assembly', { name: '厨房地柜线', memberIds: [base1, base2, base3, base4], connections: [butt(base1, base2), butt(base2, base3), butt(base3, base4)], draftId });
  await callTool('cad.create_assembly', { name: '厨房吊柜线', memberIds: [wall1, wall2, wall3], connections: [butt(wall1, wall2), butt(wall2, wall3)], draftId });
  assert('同一房间建立地柜/吊柜两组并排连接组合', true, '3 条地柜连接 + 2 条吊柜连接');

  const before = await callTool('cad.get_state');
  assert('draft 阶段 live 未被改写', before.project.cabinets.length === 0 && before.project.rooms.length === 0, `live rooms=${before.project.rooms.length}, cabinets=${before.project.cabinets.length}`);
  const draftValidation = await callTool('cad.validate', { draftId });
  assert('真实 MCP validate(draftId) 返回无阻断错误', draftValidation.blockingErrors === 0, `errors=${draftValidation.blockingErrors}; issues=${draftValidation.issues.map((i: any) => i.code).join(', ')}`);
  assert('台面参考预留明确产生非阻断制造提示', draftValidation.issues.filter((i: any) => i.code === 'RULE-COUNTERTOP-CUTOUT-PLACEHOLDER').length === 2, '水槽/灶具各一条 warning');
  const draftList = await callTool('cad.list_drafts');
  const confirmation = (draftList.drafts ?? []).find((draft: any) => draft.draftId === draftId);
  if (!confirmation) throw new Error(`list_drafts 中找不到预览快照：${draftId}`);
  const applied = await callTool('cad.apply_draft', {
    draftId,
    runId: confirmation.runId,
    revision: confirmation.revision,
    draftHash: confirmation.draftHash,
    localVersion: 0,
    remoteVersion: confirmation.liveModelVersion,
  });
  assert('draft 经 validate 后成功 apply', applied.ok === true, `newVersion=${applied.newVersion}`);

  const state = await callTool('cad.get_state');
  const mcpLiveProject = state.project as Project;
  const liveSnapshot = await readLiveExportSnapshot();
  assert('MCP apply 后 /api/workspace 确认同一 live Project 与真实快照版本',
    liveSnapshot.ok === true
      && isDeepStrictEqual(liveSnapshot.project, mcpLiveProject)
      && liveSnapshot.projectSnapshotVersion === liveSnapshot.liveModelVersion
      && liveSnapshot.projectSnapshotVersion === applied.newVersion
      && liveSnapshot.projectSnapshotId.length > 0
      && liveSnapshot.projectSnapshotHash.length > 0,
    `workspace=${liveSnapshot.workspaceId}; version=${liveSnapshot.projectSnapshotVersion}; id=${liveSnapshot.projectSnapshotId}; hash=${liveSnapshot.projectSnapshotHash}`);
  const project = liveSnapshot.project;
  const exportSnapshotBody = {
    project,
    projectSnapshotId: liveSnapshot.projectSnapshotId,
    projectSnapshotHash: liveSnapshot.projectSnapshotHash,
    projectSnapshotVersion: liveSnapshot.projectSnapshotVersion,
  };
  const postOfficialExport = (path: string, extra: Record<string, unknown> = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...exportSnapshotBody, ...extra }),
  });
  const assertSnapshotBoundResponse = (label: string, response: Response) => {
    const matches = response.headers.get('X-Project-Snapshot-Id') === liveSnapshot.projectSnapshotId
      && response.headers.get('X-Project-Snapshot-Hash') === liveSnapshot.projectSnapshotHash
      && response.headers.get('X-Project-Snapshot-Version') === String(liveSnapshot.projectSnapshotVersion);
    assert(`${label} 成功响应绑定 apply 后同一服务器快照`, response.status === 200 && matches,
      `status=${response.status}; id=${response.headers.get('X-Project-Snapshot-Id')}; hash=${response.headers.get('X-Project-Snapshot-Hash')}; version=${response.headers.get('X-Project-Snapshot-Version')}`);
  };
  assert('apply 后厨房房间与 7 个柜体在 live 同房间可见', project.rooms.length === 1 && project.cabinets.length === 7 && project.cabinets.every((cabinet) => cabinet.roomId === roomId), `rooms=${project.rooms.length}, cabinets=${project.cabinets.length}`);
  assert('两组组合持久化且成员数正确', (project.assemblies ?? []).length === 2 && (project.assemblies ?? []).reduce((n, a) => n + a.memberIds.length, 0) === 7, `${project.assemblies?.length ?? 0} assemblies`);
  const liveValidation = await callTool('cad.validate');
  assert('apply 后 live validate 仍无阻断错误', liveValidation.blockingErrors === 0, `errors=${liveValidation.blockingErrors}`);
  const minPanelWarnings = liveValidation.issues.filter((issue: any) => issue.code === 'RULE-MIN-PANEL' && issue.severity === 'WARNING');
  assert('MCP validate 只保留一条真实非零地柜踢脚 WARNING，吊柜无 RULE-MIN-PANEL 零件告警', minPanelWarnings.length === 1 && minPanelWarnings[0]?.target === `P_${base1}_KICK`, minPanelWarnings.map((issue: any) => `${issue.target}: ${issue.message}`).join(' | '));

  const overlapProbe = structuredClone(project.cabinets.find((cab) => cab.id === base1)!) as Cabinet;
  overlapProbe.id = 'acceptance_overlap_probe';
  overlapProbe.name = '冲突反例（不应用）';
  const probeProject = { ...project, cabinets: [...project.cabinets, overlapProbe] };
  const overlapIssues = detectCollisions(probeProject as Project).filter((issue) => issue.code === 'RULE-CABINET-OVERLAP');
  assert('碰撞负样本：同标高/同投影冲突仍报 RULE-CABINET-OVERLAP', overlapIssues.some((issue) => String(issue.target).includes('acceptance_overlap_probe')), `${overlapIssues.length} overlap issues`);
  assert('标高分离：地柜与吊柜投影重合不报碰撞', !detectCollisions(project).some((issue) => issue.code === 'RULE-CABINET-OVERLAP'), 'valid kitchen has zero cabinet overlap');

  const geometry = generateProject(project, rules);
  const allManufacturingPanels = Object.values(geometry.cabinets).flatMap((cabinetGeometry) => cabinetGeometry.panels);
  const invalidManufacturingPanels = allManufacturingPanels.filter((panel) => ![panel.length, panel.width, panel.thickness].every((value) => Number.isFinite(value) && value > 0));
  assert('厨房完整派生中所有制造板件长/宽/厚均为有限正数', invalidManufacturingPanels.length === 0, JSON.stringify(invalidManufacturingPanels.map((panel) => ({ id: panel.id, length: panel.length, width: panel.width, thickness: panel.thickness }))));
  const wallCabinetIds = new Set([wall1, wall2, wall3]);
  const wallKickPanels = project.cabinets.filter((cabinet) => wallCabinetIds.has(cabinet.id)).flatMap((cabinet) => geometry.cabinets[cabinet.id]?.panels ?? []).filter((panel) => panel.role === 'KickBoard' || panel.role === 'KickBoardBack');
  const baseKickPanels = geometry.cabinets[base1]?.panels.filter((panel) => panel.role === 'KickBoard' || panel.role === 'KickBoardBack') ?? [];
  assert('wall 吊柜彻底不生成 KICK/KICKB 制造板件', wallKickPanels.length === 0, JSON.stringify(wallKickPanels.map((panel) => ({ id: panel.id, role: panel.role, length: panel.length, width: panel.width }))));
  assert('base 地柜仍保留有效非零 KICK，避免墙柜修复误伤地柜', baseKickPanels.length === 1 && baseKickPanels.every((panel) => panel.role === 'KickBoard' && panel.length > 0 && panel.width > 0 && panel.thickness > 0), JSON.stringify(baseKickPanels.map((panel) => ({ id: panel.id, role: panel.role, length: panel.length, width: panel.width, thickness: panel.thickness }))));
  const warningRows = minPanelWarnings.map((issue: any) => {
    const owners = project.cabinets.filter((cabinet) => (geometry.cabinets[cabinet.id]?.panels ?? []).some((panel) => panel.id === issue.target));
    if (owners.length !== 1) throw new Error(`RULE-MIN-PANEL target 未唯一映射到柜体：${issue.target}; owners=${owners.map((cabinet) => cabinet.name).join(',')}`);
    const cabinet = owners[0]!;
    const cabinetGeometry = geometry.cabinets[cabinet.id];
    const sourceIssue = cabinetGeometry
      ? cabinetWarningIssues(cabinet, cabinetGeometry, rules).find((candidate) => candidate.code === issue.code && candidate.target === issue.target)
      : undefined;
    if (sourceIssue?.targetKind !== 'panel' || sourceIssue.message !== issue.message) throw new Error(`MCP warning 未与本地 Cabinet validator 同一 issue：${issue.target}; source=${sourceIssue?.targetKind ?? 'missing'}`);
    return { issue: sourceIssue, cabinet, text: formatCabinetWarning(cabinet, sourceIssue) };
  });
  assert('剩余 warning 唯一绑定到真实有效 KICK Panel.id 和地柜', warningRows.length === 1 && warningRows[0]?.cabinet.id === base1 && warningRows[0]?.issue.target === baseKickPanels[0]?.id, warningRows.map((row) => `${row.cabinet.name} ← ${row.issue.target}`).join('; '));
  assert('唯一真实 RULE-MIN-PANEL 保留可读的开料与运输后果说明', warningRows.length === 1 && warningRows.every((row) => row.issue.message.includes('小于最小可用尺寸') && row.issue.message.includes('开料') && row.issue.message.includes('运输中损坏')), warningRows.map((row) => row.issue.message).join(' | '));
  const body3d = buildProjectBodies(project, rules);
  const wallIds = new Set([wall1, wall2, wall3]);
  const wallBoxes = body3d.filter((body) => wallIds.has(body.cabId));
  const zMins = wallBoxes.map((body) => body.cz - body.sz / 2);
  const zMaxs = wallBoxes.map((body) => body.cz + body.sz / 2);
  assert('吊柜 3D 体块按 mountHeight 抬高到 1450–2150mm', wallBoxes.length > 0 && Math.min(...zMins) >= 1450 && Math.max(...zMaxs) <= 2150, `z=${Math.min(...zMins)}..${Math.max(...zMaxs)}`);
  assert('3D 语义体包含两种台面预留占位', body3d.filter((body) => body.role === 'countertopCutout').length === 2, `${body3d.filter((body) => body.role === 'countertopCutout').length} cutouts`);
  const planText = (geometry.roomPlans[roomId] ?? []).filter((prim) => prim.k === 'text').map((prim: any) => prim.text).join(' ');
  assert('厨房平面图元带水槽/灶具预留名与精确尺寸', planText.includes('水槽预留 650×450') && planText.includes('灶具预留 640×520'), planText.match(/水槽预留[^ ]*|灶具预留[^ ]*/g)?.join(', ') ?? 'labels missing');
  const planLabels = (geometry.roomPlans[roomId] ?? []).filter((prim) => prim.k === 'text') as any[];
  const baseNameLabel = planLabels.find((prim) => prim.text === '01 三抽地柜');
  const wallNameLabel = planLabels.find((prim) => String(prim.text).startsWith('05 左吊柜 吊柜底'));
  const cutoutLabels = planLabels.filter((prim) => String(prim.text).startsWith('水槽预留') || String(prim.text).startsWith('灶具预留'));
  const labelBandGap = baseNameLabel && wallNameLabel ? Math.abs(baseNameLabel.p.y - wallNameLabel.p.y) : 0;
  assert('吊柜/地柜名称分带放置且避开厨电预留文字', labelBandGap >= 400 && cutoutLabels.length === 2 && cutoutLabels.every((prim) => Math.abs(prim.p.y - baseNameLabel.p.y) >= 500), `label band gap=${labelBandGap}mm; cutouts=${cutoutLabels.length}`);
  const externalCutoutLabels = cutoutLabels.every((label) => {
    const owner = project.cabinets.find((cabinet) => (cabinet.params.counterCutouts ?? []).some((cutout) => String(label.text).startsWith(cutout.name)));
    return Boolean(owner && label.p.y >= owner.placement.y + owner.params.depth + 100);
  });
  assert('水槽/灶具说明标签在柜体投影框外独立成带', externalCutoutLabels, cutoutLabels.map((label) => `${label.text}@${label.p.y}`).join('; '));
  const mapCallouts = buildRoomPlanCallouts(project.cabinets);
  const calloutBoxes = mapCallouts.labels.map((label) => label.bounds);
  const calloutBoxesClear = mapCallouts.labels.length === 7
    && calloutBoxes.every((box, index) => !calloutBoxes.some((other, otherIndex) => index !== otherIndex && boxesOverlap(
      { xMin: box.minX, yMin: box.minY, xMax: box.maxX, yMax: box.maxY },
      { xMin: other.minX, yMin: other.minY, xMax: other.maxX, yMax: other.maxY },
    )))
    && mapCallouts.labels.every((label) => {
      const cabinet = project.cabinets.find((candidate) => candidate.id === label.cabinetId)!;
      const footprint = { xMin: cabinet.placement.x, yMin: cabinet.placement.y, xMax: cabinet.placement.x + cabinet.params.width, yMax: cabinet.placement.y + cabinet.params.depth };
      const box = { xMin: label.bounds.minX, yMin: label.bounds.minY, xMax: label.bounds.maxX, yMax: label.bounds.maxY };
      return !boxesOverlap(box, footprint);
    });
  assert('布局编号白底框与引线对准七柜，标签框不互撞且不压柜体', calloutBoxesClear, mapCallouts.labels.map((label) => label.tag).join(', '));
  const ovenCabinet = project.cabinets.find((cab) => cab.id === base4)!;
  const ovenViews = buildCabinetViews(ovenCabinet, rules);
  const ovenText = Object.values(ovenViews.prims).flat().filter((prim) => prim.k === 'text').map((prim: any) => prim.text).join(' ');
  assert('烤箱开口尺寸在柜体三视图语义中仍为 568×600mm', ovenText.includes('568×600'), ovenText.match(/[^ ]*568×600[^ ]*/g)?.join(', ') ?? 'opening annotation missing');
  const ovenBandLabel = ovenViews.prims.top.find((prim: any) => prim.k === 'text' && String(prim.text).startsWith('烤箱预留')) as any;
  assert('烤箱尺寸文字移到俯视框外，正视洞口不重复压字', Boolean(ovenBandLabel && ovenBandLabel.p.y < ovenViews.meta.top.bbox.min.y && !ovenViews.prims.front.some((prim: any) => prim.k === 'text' && String(prim.text).includes('烤箱预留'))), ovenBandLabel ? `labelY=${ovenBandLabel.p.y}; frameBottom=${ovenViews.meta.top.bbox.min.y}` : 'no external label');

  const dxfExportStartedAt = Date.now();
  const dxfResponse = await postOfficialExport('/api/export/dxf', { which: ['plan', 'sheet'], planRoomIds: [roomId], version: 'R2007' });
  const dxfBytes = Buffer.from(await dxfResponse.arrayBuffer());
  assertSnapshotBoundResponse('正式 HTTP /api/export/dxf', dxfResponse);
  assert('正式 HTTP /api/export/dxf 生成本轮布局+逐柜 DXF', dxfResponse.status === 200 && dxfBytes.length > 10000 && dxfBytes.subarray(0, 20).toString('ascii').includes('SECTION'), `status=${dxfResponse.status}; ${dxfBytes.length} bytes; ${dxfResponse.headers.get('Content-Disposition') ?? ''}; started=${new Date(dxfExportStartedAt).toISOString()}`);
  const dxfPath = join(outDir, 'complex-kitchen-layout-and-sheets.dxf');
  writeFileSync(dxfPath, dxfBytes);
  const dxfText = dxfBytes.toString('utf8');
  const csvExportStartedAt = Date.now();
  const csvResponse = await postOfficialExport('/api/export/cutlist');
  const csvBytes = Buffer.from(await csvResponse.arrayBuffer());
  assertSnapshotBoundResponse('正式 HTTP /api/export/cutlist', csvResponse);
  const csvPath = join(outDir, 'complex-kitchen-cutlist.csv');
  writeFileSync(csvPath, csvBytes);
  const csvMtimeMs = statSync(csvPath).mtimeMs;
  assert('真实 HTTP /api/export/cutlist 生成本轮 CSV 开料单', csvResponse.status === 200 && csvBytes.length > 100 && csvMtimeMs >= csvExportStartedAt, `status=${csvResponse.status}; ${csvBytes.length} bytes`);
  const csvReadbackScript = [
    'import csv,json,math,sys',
    'with open(sys.argv[1], encoding="utf-8-sig", newline="") as f: rows=[r for r in csv.DictReader(f) if str(r.get("板件ID","")).startswith("P_")] ',
    'def value(r,k):',
    '  try: return float(r[k])',
    '  except Exception: return float("nan")',
    'keys=("厚(mm)","长(mm)","宽(mm)")',
    'bad=[{"id":r.get("板件ID"),"dims":{k:r.get(k) for k in keys}} for r in rows if any(not math.isfinite(value(r,k)) or value(r,k)<=0 for k in keys)]',
    'wall_ids=set(sys.argv[3:])',
    'kicks=[r for r in rows if r.get("角色") in ("KickBoard","KickBoardBack")]',
    'wall_kicks=[{"id":r.get("板件ID"),"owner":r.get("所属"),"dims":[r.get(k) for k in keys]} for r in kicks if r.get("所属") in wall_ids]',
    'base_kicks=[{"id":r.get("板件ID"),"owner":r.get("所属"),"dims":[r.get(k) for k in keys]} for r in kicks if r.get("所属")==sys.argv[2]]',
    'print(json.dumps({"rows":len(rows),"bad":bad,"wall_kicks":wall_kicks,"base_kicks":base_kicks},ensure_ascii=False))',
  ].join('\n');
  const csvReadback = JSON.parse(execFileSync('python3', ['-c', csvReadbackScript, csvPath, base1, wall1, wall2, wall3], { encoding: 'utf8' })) as { rows: number; bad: Array<unknown>; wall_kicks: Array<unknown>; base_kicks: Array<{ id: string; owner: string; dims: string[] }> };
  assert('实际 CSV 每块板件长/宽/厚均为正，且三只吊柜没有 KICK/KICKB 行', csvReadback.rows > 0 && csvReadback.bad.length === 0 && csvReadback.wall_kicks.length === 0, JSON.stringify({ rows: csvReadback.rows, bad: csvReadback.bad.slice(0, 2), wallKickRows: csvReadback.wall_kicks }));
  assert('实际 CSV 保留地柜有效 KICK，且唯一 warning target 指向同一板件 ID', csvReadback.base_kicks.length === 1 && csvReadback.base_kicks[0]?.id === `P_${base1}_KICK` && warningRows[0]?.issue.target === csvReadback.base_kicks[0]?.id, JSON.stringify(csvReadback.base_kicks));
  assert('正式 HTTP DXF 布局+逐柜名称和完整外尺寸', dxfBytes.length > 10000 && created.every((cab) => dxfText.includes(cab.name) && dxfText.includes(`${cab.width}×${cab.height}×${cab.depth}`)), `${dxfBytes.length} bytes; ${dxfResponse.headers.get('Content-Disposition') ?? ''}`);
  assert('DXF 包含台面预留标签/尺寸和烤箱洞口尺寸', dxfText.includes('水槽预留') && dxfText.includes('650×450') && dxfText.includes('灶具预留') && dxfText.includes('640×520') && dxfText.includes('568×600'), '正式端点回读的预留尺寸均保留');
  const dxfReadback = JSON.parse(execFileSync('python3', [join(root, 'py/verify_dxf.py'), dxfPath], { encoding: 'utf8' })) as { paperLayouts?: Array<{ name: string; texts?: string[]; fitsPrintableArea?: boolean }> };
  const paperLayouts = dxfReadback.paperLayouts ?? [];
  const layoutHasSafety = (namePart: string) => {
    const layout = paperLayouts.find((candidate) => candidate.name.includes(namePart));
    return Boolean(layout?.fitsPrintableArea && (layout.texts ?? []).some((text) => normalizePdfText(text).includes(normalizePdfText(safetyPhrase))));
  };
  const safetyLayoutNames = paperLayouts.filter((layout) => (layout.texts ?? []).some((text) => normalizePdfText(text).includes(normalizePdfText(safetyPhrase)))).map((layout) => layout.name);
  const dxfSafetyChecks = ['平面布置图', '水槽地柜', '灶具地柜', '烤箱地柜'].map(layoutHasSafety);
  assert('ezdxf 文件级回读确认安全注记存在于房间布局及水槽/灶具/烤箱四个纸空间页', dxfSafetyChecks.every(Boolean), `注记页=${safetyLayoutNames.join(' | ') || 'none'}`);
  const dxfWarningChecks = warningRows.map((row) => {
    const matches = paperLayouts.filter((layout) => normalizePdfText((layout.texts ?? []).join(' ')).includes(normalizePdfText(row.text)));
    const layout = matches[0];
    const stableCabinetKey = row.cabinet.id.replace(/[^A-Za-z0-9]/g, '').slice(-8);
    return { cabinet: row.cabinet.name, code: row.issue.code, layout: layout?.name ?? '', ok: matches.length === 1 && Boolean(layout?.name.includes(stableCabinetKey) && layout.fitsPrintableArea) };
  });
  assert('ezdxf 文件级 TEXT/MTEXT 回读确认唯一 warning 在真实地柜踢脚板所属 layout', dxfWarningChecks.length === 1 && dxfWarningChecks[0]?.cabinet === '01 三抽地柜' && dxfWarningChecks.every((check) => check.ok), dxfWarningChecks.map((check) => `${check.cabinet}: ${check.layout || 'missing'} (${check.ok})`).join(' | '));
  const dxfWallPages = [wall1, wall2, wall3].map((id) => {
    const stableKey = id.replace(/[^A-Za-z0-9]/g, '').slice(-8);
    const matches = paperLayouts.filter((layout) => layout.name.includes(stableKey));
    const text = normalizePdfText(matches.flatMap((layout) => layout.texts ?? []).join(' '));
    return { id, matches: matches.length, ok: matches.length === 1 && !text.includes('RULE-MIN-PANEL') && !text.includes('踢脚板') };
  });
  assert('实际 DXF 三张吊柜 layout 无零踢脚件名称及虚假 RULE-MIN-PANEL 警告', dxfWallPages.every((check) => check.ok), JSON.stringify(dxfWallPages));
  const sinkViews = buildCabinetViews(project.cabinets.find((cab) => cab.id === base2)!, rules);
  const hobViews = buildCabinetViews(project.cabinets.find((cab) => cab.id === base3)!, rules);
  const sinkBandLabel = sinkViews.prims.top.find((prim: any) => prim.k === 'text' && String(prim.text).startsWith('水槽预留')) as any;
  const hobBandLabel = hobViews.prims.top.find((prim: any) => prim.k === 'text' && String(prim.text).startsWith('灶具预留')) as any;
  assert('水槽与灶具预留标签都在各自俯视框外，不穿过虚线框/中隔线', Boolean(sinkBandLabel && sinkBandLabel.p.y < sinkViews.meta.top.bbox.min.y && hobBandLabel && hobBandLabel.p.y < hobViews.meta.top.bbox.min.y), `sink=${sinkBandLabel?.p.y ?? 'missing'} frame=${sinkViews.meta.top.bbox.min.y}..${sinkViews.meta.top.bbox.max.y}; hob=${hobBandLabel?.p.y ?? 'missing'} frame=${hobViews.meta.top.bbox.min.y}..${hobViews.meta.top.bbox.max.y}`);

  const pdfExportStartedAt = Date.now();
  const pdfResponse = await postOfficialExport('/api/export/pdf', { layoutRoomIds: [roomId] });
  const pdfBytes = Buffer.from(await pdfResponse.arrayBuffer());
  const pdfPageCount = Number(pdfResponse.headers.get('X-PDF-Page-Count'));
  assertSnapshotBoundResponse('正式 HTTP /api/export/pdf', pdfResponse);
  const pdfPath = join(outDir, 'complex-kitchen-roombook.pdf');
  writeFileSync(pdfPath, pdfBytes);
  const pdfMtimeMs = statSync(pdfPath).mtimeMs;
  assert('正式 HTTP PDF 显式选择厨房 layoutRoomIds 后生成恰好 8 页（1 布局 + 7 单柜）', pdfResponse.status === 200 && pdfBytes.subarray(0, 5).toString('ascii') === '%PDF-' && pdfPageCount === 8, `${pdfPageCount} pages; layoutRoomIds=${roomId}; ${pdfBytes.length} bytes`);
  assert('PDF 文件修改时间晚于本次正式 HTTP 导出请求', pdfMtimeMs >= pdfExportStartedAt, new Date(pdfMtimeMs).toISOString());
  const pdfText = execFileSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
  assert('PDF 布局页逐柜名称与完整外尺寸和 MCP 输入一致', pdfText.includes('隔离验收厨房') && created.every((cab) => pdfText.includes(cab.name) && pdfText.includes(`${cab.width}×${cab.height}×${cab.depth}`)), created.map((cab) => `${cab.name} ${cab.width}×${cab.height}×${cab.depth}`).join('; '));
  assert('PDF 逐柜页保留烤箱洞口和门板分区尺寸', pdfText.includes('568×600') && (pdfText.match(/372×660mm/g) ?? []).length >= 3, '烤箱 568×600；左吊柜 3 扇门 372×660');
  const pageText = (page: number) => execFileSync('pdftotext', ['-f', String(page), '-l', String(page), '-layout', pdfPath, '-'], { encoding: 'utf8' });
  const p1 = pageText(1);
  const p4 = pageText(4);
  const p6 = pageText(6);
  const p8 = pageText(8);
  const pdfPages = Array.from({ length: pdfPageCount }, (_, index) => pageText(index + 1));
  assert('实际 PDF 第 1 页布局显著注明非生产参考位状态', normalizePdfText(p1).includes(normalizePdfText(safetyPhrase)) && p1.includes('水槽预留') && p1.includes('烤箱预留'), p1.replace(/\s+/g, ' ').slice(0, 320));
  assert('实际 PDF 第 4 页水槽柜页有非 CNC disclaimer 与精确尺寸', normalizePdfText(p4).includes(normalizePdfText(safetyPhrase)) && p4.includes('水槽预留') && p4.includes('650×450'), p4.replace(/\s+/g, ' ').slice(0, 260));
  assert('实际 PDF 第 6 页灶具柜页有非 CNC disclaimer 与精确尺寸', normalizePdfText(p6).includes(normalizePdfText(safetyPhrase)) && p6.includes('灶具预留') && p6.includes('640×520'), p6.replace(/\s+/g, ' ').slice(0, 260));
  assert('实际 PDF 第 8 页烤箱页区分设计净空与加工完成状态', normalizePdfText(p8).includes(normalizePdfText(safetyPhrase)) && p8.includes('烤箱预留安装净空') && p8.includes('568×600×560'), p8.replace(/\s+/g, ' ').slice(0, 300));
  const bboxOutput = execFileSync('pdftotext', ['-bbox-layout', pdfPath, '-'], { encoding: 'utf8' });
  const bboxPages = parsePdfLines(bboxOutput);
  const bboxPageSizes = parsePdfPageSizes(bboxOutput);
  const backPanelSidebarChecks = [4, 6, 8].map((pageNo) => {
    const lines = bboxPages[pageNo - 1] ?? [];
    const pageSize = bboxPageSizes[pageNo - 1];
    const matches = lines.filter((line) => normalizePdfText(line.text).includes('9mm背板'));
    const note = matches[0];
    const noTextOverlap = Boolean(note && !lines.some((line) => line !== note && line.text.trim() && boxesOverlap(note, line)));
    const xRatio = pageSize && note ? note.xMin / pageSize.width : null;
    return {
      page: pageNo, label: note?.text ?? '', matches: matches.length,
      xMin: note?.xMin ?? null, pageWidth: pageSize?.width ?? null,
      xRatio, noTextOverlap,
      ok: matches.length === 1 && xRatio !== null && xRatio >= 0.82 && noTextOverlap,
    };
  });
  assert('实际 PDF 第4/6/8页 9mm背板红字位于右侧信息栏且独占文字框，不进入内部视图', backPanelSidebarChecks.every((check) => check.ok), JSON.stringify(backPanelSidebarChecks));
  const pdfWarningChecks = warningRows.map((row) => {
    const header = row.text.split(row.issue.message)[0] ?? '';
    const messageParts = row.issue.message.split('——').map(normalizePdfText).filter(Boolean);
    const matches = bboxPages.map((lines, index) => ({ page: index + 1, text: (lines ?? []).filter((line) => line.yMin < 110).map((line) => line.text).join(' ') }))
      .filter(({ page, text }) => {
        const normalized = normalizePdfText(text);
        return page > 1 && normalized.includes(normalizePdfText(header)) && messageParts.every((part) => normalized.includes(part));
      });
    return { cabinet: row.cabinet.name, code: row.issue.code, page: matches[0]?.page ?? null, ok: matches.length === 1 };
  });
  assert('实际 PDF 顶端注记带回读确认唯一有效地柜 KICK warning 的规则名/柜名/完整说明', pdfWarningChecks.length === 1 && pdfWarningChecks[0]?.cabinet === '01 三抽地柜' && pdfWarningChecks.every((check) => check.ok), pdfWarningChecks.map((check) => `${check.cabinet}: page ${check.page ?? 'missing'} (${check.ok})`).join(' | '));
  const wallPdfPages = [wall1, wall2, wall3].map((id) => {
    const cabinet = project.cabinets.find((candidate) => candidate.id === id)!;
    const matches = pdfPages.map((text, index) => ({ page: index + 1, text })).filter(({ page, text }) => page > 1 && text.includes(cabinet.name));
    const normalized = normalizePdfText(matches.map((match) => match.text).join(' '));
    return { cabinet: cabinet.name, page: matches[0]?.page ?? null, matches: matches.length, ok: matches.length === 1 && !normalized.includes('RULE-MIN-PANEL') && !normalized.includes('踢脚板') };
  });
  assert('实际 PDF 三张吊柜柜体页无零尺寸踢脚板及 RULE-MIN-PANEL warning', wallPdfPages.every((check) => check.ok), JSON.stringify(wallPdfPages));
  const baseKickPdfPage = pdfWarningChecks[0]?.page;
  const baseKickPdfText = baseKickPdfPage ? pdfPages[baseKickPdfPage - 1] ?? '' : '';
  assert('实际 PDF 同一地柜页携带 CSV 对应有效 KICK 的完整制造 warning', Boolean(baseKickPdfText && normalizePdfText(baseKickPdfText).includes(normalizePdfText(warningRows[0]?.text ?? '')) && warningRows[0]?.issue.target === csvReadback.base_kicks[0]?.id), `page=${baseKickPdfPage}; panel=${warningRows[0]?.issue.target ?? 'missing'}`);
  const noteCollisionChecks = [1, 4, 6, 8].map((pageNo) => {
    const lines = bboxPages[pageNo - 1] ?? [];
    const marker = pageNo === 1 ? '柜体编号通过引线对应下方清单' : '适用于台面虚线标记';
    const noteLines = lines.filter((line) => line.yMin < 110
      && normalizePdfText(line.text).includes(normalizePdfText(safetyPhrase))
      && normalizePdfText(line.text).includes(normalizePdfText(marker)));
    if (noteLines.length === 0) return false;
    const noteBox = {
      xMin: Math.min(...noteLines.map((line) => line.xMin)), yMin: Math.min(...noteLines.map((line) => line.yMin)),
      xMax: Math.max(...noteLines.map((line) => line.xMax)), yMax: Math.max(...noteLines.map((line) => line.yMax)),
    };
    return !lines.some((line) => line.text.trim() && !noteLines.includes(line) && boxesOverlap(noteBox, line));
  });
  assert('PDF 第 1/4/6/8 页 disclaimer 文本框与其它文字 bbox 均无相交', noteCollisionChecks.every(Boolean), `pages=${noteCollisionChecks.map((ok, i) => `${[1, 4, 6, 8][i]}:${ok}`).join(', ')}`);
  const calloutLineIsIsolated = (pageNo: number, prefix: string, excluded: string) => {
    const lines = bboxPages[pageNo - 1] ?? [];
    const line = lines.find((candidate) => normalizePdfText(candidate.text).includes(normalizePdfText(prefix)) && !normalizePdfText(candidate.text).includes(normalizePdfText(excluded)));
    return Boolean(line && !lines.some((candidate) => candidate !== line && candidate.text.trim() && boxesOverlap(line, candidate)));
  };
  assert('PDF 第 4/6 页水槽/灶具外置标签 bbox 均不撞其它标注文字', calloutLineIsIsolated(4, '水槽预留 650×450', 'X=125') && calloutLineIsIsolated(6, '灶具预留 640×520', 'X=130'), '页4 水槽、页6 灶具标签需独占一行');
  const ovenPageLines = bboxPages[7] ?? [];
  const ovenNoteLine = ovenPageLines.find((line) => normalizePdfText(line.text).includes('烤箱预留安装净空') && normalizePdfText(line.text).includes('568×600×560'));
  const ovenDimLines = ovenPageLines.filter((line) => normalizePdfText(line.text).includes('568×600') && !normalizePdfText(line.text).includes('烤箱预留安装净空'));
  assert('PDF 第 8 页烤箱俯视尺寸标签与净空 disclaimer bbox 分离', Boolean(ovenNoteLine && ovenDimLines.length > 0 && ovenDimLines.every((line) => !boxesOverlap(ovenNoteLine, line))), `note=${ovenNoteLine?.text ?? 'missing'}; dims=${ovenDimLines.map((line) => line.text).join(' / ') || 'missing'}`);
  const rasterPages = [4, 6, 8].map((page) => {
    const prefix = join(outDir, `complex-kitchen-binding-page-${page}`);
    execFileSync('pdftoppm', ['-f', String(page), '-l', String(page), '-singlefile', '-png', '-scale-to', '1500', pdfPath, prefix], { stdio: 'ignore' });
    return `${prefix}.png`;
  });
  const rasterEdgeScript = [
    'from PIL import Image',
    'import json,math,sys',
    'out=[]',
    'for path in sys.argv[1:]:',
    '  im=Image.open(path).convert("RGB"); w,h=im.size; ink=[x for y in range(h) for x in range(w) if max(im.getpixel((x,y)))<245]',
    '  left=min(ink) if ink else w; safe=math.ceil(w*5/420)',
    '  out.append({"file":path,"width":w,"height":h,"leftmostInkPx":left,"fiveMmSafePixels":safe,"ok":w==1500 and left>=safe})',
    'print(json.dumps(out))',
  ].join('\n');
  const rasterEdgeChecks = JSON.parse(execFileSync('python3', ['-c', rasterEdgeScript, ...rasterPages], { encoding: 'utf8' })) as Array<{ file: string; width: number; height: number; leftmostInkPx: number; fiveMmSafePixels: number; ok: boolean }>;
  assert('PDF 第4/6/8页实际 A3 栅格最左墨迹均位于5mm安全边距内（装订线无贴边裁字）', rasterEdgeChecks.length === 3 && rasterEdgeChecks.every((check) => check.ok), JSON.stringify(rasterEdgeChecks));
  const backPanelRasterRegions = backPanelSidebarChecks.map((check) => ({
    page: check.page,
    xMin: check.xMin ?? 0, yMin: (bboxPages[check.page - 1] ?? []).find((line) => normalizePdfText(line.text).includes('9mm背板'))?.yMin ?? 0,
    xMax: check.xMin === null ? 0 : ((bboxPages[check.page - 1] ?? []).find((line) => normalizePdfText(line.text).includes('9mm背板'))?.xMax ?? 0),
    yMax: check.xMin === null ? 0 : ((bboxPages[check.page - 1] ?? []).find((line) => normalizePdfText(line.text).includes('9mm背板'))?.yMax ?? 0),
    pageWidth: check.pageWidth ?? 1,
    pageHeight: bboxPageSizes[check.page - 1]?.height ?? 1,
  }));
  const backPanelRasterScript = [
    'from PIL import Image',
    'import json,sys',
    'regions=json.loads(sys.argv[1]); out=[]',
    'for path,region in zip(sys.argv[2:],regions):',
    '  im=Image.open(path).convert("RGB"); w,h=im.size; sx=w/region["pageWidth"]; sy=h/region["pageHeight"]',
    '  x0=max(0,int(region["xMin"]*sx)-4); x1=min(w,int(region["xMax"]*sx)+5); y0=max(0,int(region["yMin"]*sy)-4); y1=min(h,int(region["yMax"]*sy)+5)',
    '  crop=im.crop((x0,y0,x1,y1)); red=sum(1 for r,g,b in crop.getdata() if r>120 and g<150 and b<150)',
    '  out.append({"page":region["page"],"file":path,"labelPixels":red,"crop":[x0,y0,x1,y1],"ok":red>=30})',
    'print(json.dumps(out))',
  ].join('\n');
  const backPanelRasterChecks = JSON.parse(execFileSync('python3', ['-c', backPanelRasterScript, JSON.stringify(backPanelRasterRegions), ...rasterPages], { encoding: 'utf8' })) as Array<{ page: number; file: string; labelPixels: number; crop: number[]; ok: boolean }>;
  assert('PDF 第4/6/8页实际栅格在右侧信息栏可见红色背板注记像素', backPanelRasterChecks.length === 3 && backPanelRasterChecks.every((check) => check.ok), JSON.stringify(backPanelRasterChecks));
  const roomBookResponse = await postOfficialExport('/api/export/roombook');
  const htmlBytes = Buffer.from(await roomBookResponse.arrayBuffer());
  assertSnapshotBoundResponse('正式 HTTP /api/export/roombook', roomBookResponse);
  const htmlPath = join(outDir, 'complex-kitchen-roombook.html');
  writeFileSync(htmlPath, htmlBytes);
  const html = htmlBytes.toString('utf8');
  assert('图纸册 HTML 结构含 1 个布局页 + 7 张柜体页', (html.match(/data-page-kind="layout"/g) ?? []).length === 1 && (html.match(/data-page-kind="cabinet"/g) ?? []).length === 7, `${htmlBytes.length} bytes`);
  assert('正式 HTTP 图册有标签编号清单、房间免责声明与三页柜体免责声明', ['B1', 'W1', '01 三抽地柜', safetyPhrase, '水槽预留 650×450mm', '灶具预留 640×520mm', '烤箱预留安装净空 568×600×560mm'].every((text) => html.includes(text)), 'source RoomBook 注记已回读');
  assert('正式 HTTP 图册保留唯一真实非零地柜 KICK RULE-MIN-PANEL 完整警告', warningRows.length === 1 && warningRows.every((row) => html.includes(row.text)), warningRows.map((row) => row.cabinet.name).join(', '));
  const finalLiveSnapshot = await readLiveExportSnapshot();
  assert('四种正式导出前后 live 快照始终未变化', finalLiveSnapshot.projectSnapshotId === liveSnapshot.projectSnapshotId
    && finalLiveSnapshot.projectSnapshotHash === liveSnapshot.projectSnapshotHash
    && finalLiveSnapshot.projectSnapshotVersion === liveSnapshot.projectSnapshotVersion,
  `id=${finalLiveSnapshot.projectSnapshotId}; version=${finalLiveSnapshot.projectSnapshotVersion}`);

  const report = {
    result: 'PASS', checks, roomId, draftId, project: project.name,
    projectSnapshot: {
      workspaceId: liveSnapshot.workspaceId,
      projectSnapshotId: liveSnapshot.projectSnapshotId,
      projectSnapshotHash: liveSnapshot.projectSnapshotHash,
      projectSnapshotVersion: liveSnapshot.projectSnapshotVersion,
    },
    room: { name: project.rooms[0]?.name, width: 5000, depth: 4000, ceiling: 2700 },
    cabinets: created.map((cab) => ({ ...cab, mountHeight: cab.type === 'wall' ? 1450 : 0 })),
    assemblies: (project.assemblies ?? []).map((assembly) => ({ name: assembly.name, members: assembly.memberIds.length, connections: assembly.connections.length })),
    validation: { blockingErrors: liveValidation.blockingErrors, issues: liveValidation.issues.map((issue: any) => {
      const panelWarning = warningRows.find((row) => row.issue.code === issue.code && row.issue.target === issue.target);
      const targetKind = panelWarning ? 'panel' : issue.targetKind ?? null;
      const owner = panelWarning?.cabinet ?? (targetKind === 'panel'
        ? project.cabinets.find((cabinet) => geometry.cabinets[cabinet.id]?.panels.some((panel) => panel.id === issue.target))
        : project.cabinets.find((cabinet) => cabinet.id === issue.target));
      return { code: issue.code, severity: issue.severity, target: issue.target, targetKind, cabinetId: owner?.id ?? null, cabinetName: owner?.name ?? null, message: issue.message };
    }) },
    collision: { verticalSeparationPass: true, sameElevationNegativePass: true },
    manufacturing: { panelCount: allManufacturingPanels.length, invalidDimensionPanels: invalidManufacturingPanels.length, wallKickPanels: wallKickPanels.length, baseKickPanelIds: baseKickPanels.map((panel) => panel.id), warningPanelIds: warningRows.map((row) => row.issue.target) },
    exports: { csv: { path: csvPath, bytes: csvBytes.length, modifiedAt: new Date(csvMtimeMs).toISOString(), panelRows: csvReadback.rows, invalidRows: csvReadback.bad.length, wallKickRows: csvReadback.wall_kicks.length, baseKickRows: csvReadback.base_kicks }, pdf: { path: pdfPath, bytes: pdfBytes.length, pages: pdfPageCount, layoutRoomIds: [roomId], modifiedAt: new Date(pdfMtimeMs).toISOString(), generatedAfterRequest: pdfMtimeMs >= pdfExportStartedAt, warningReadBacks: pdfWarningChecks, backPanelSidebarChecks, backPanelRasterChecks, wallCabinetPages: wallPdfPages, bindingEdgeRasterChecks: rasterEdgeChecks }, dxf: { path: dxfPath, bytes: dxfBytes.length, safetyNotesReadBack: dxfSafetyChecks.every(Boolean), safetyNoteLayouts: safetyLayoutNames, warningReadBacks: dxfWarningChecks, wallCabinetPages: dxfWallPages }, html: { path: htmlPath, bytes: htmlBytes.length, warningNotesReadBack: warningRows.length } },
  };
  writeFileSync(join(outDir, 'acceptance.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

try {
  await main();
} finally {
  try { child?.kill(); } catch { /* ignore */ }
  await wait(200);
  rmSync(tempDir, { recursive: true, force: true });
}
