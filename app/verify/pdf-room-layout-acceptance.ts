import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rectRoom, sampleProject } from '../src/core/docFactory.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import type { Project, RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const tempDir = mkdtempSync(join(tmpdir(), 'furnicad-pdf-room-layout-'));
let child: ChildProcess | null = null;
let port = 0;
let passed = 0;
let failed = 0;

interface WorkspaceSnapshot {
  project: Project;
  projectSnapshotId: string;
  projectSnapshotHash: string;
  projectSnapshotVersion: number;
}

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (text: string) => text.replace(/[\s\u00a0\u200b\ufeff]+/g, '');

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('No local port')));
      const selected = address.port;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

function seedWorkspace(path: string, project: Project): void {
  const envelope = JSON.parse(serializeProjectFile(project)) as Record<string, unknown>;
  Object.assign(envelope, {
    workspaceId: 'ws_pdf_room_layout', owner: 'local-open', account: 'local-open',
    liveModelVersion: 0, updatedAt: new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(envelope, null, 2), 'utf8');
}

async function startServer(project: Project): Promise<void> {
  port = await allocatePort();
  const workspacePath = join(tempDir, 'workspace.json');
  seedWorkspace(workspacePath, project);
  child = spawn(process.execPath, [join(root, 'server/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port), APP_HOST: '127.0.0.1', APP_PYTHON: process.env.APP_PYTHON ?? 'python3',
      APP_ENV_PATH: join(tempDir, '.env'), APP_ACCOUNTS_PATH: join(tempDir, 'accounts.json'),
      APP_AUDIT_PATH: join(tempDir, 'audit.jsonl'), APP_MEM_PATH: join(tempDir, 'corrections.jsonl'),
      APP_REGISTRATIONS_PATH: join(tempDir, 'registrations.json'), APP_WORKSPACE_PATH: workspacePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout?.on('data', (data: Buffer) => { log += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { log += data.toString(); });
  for (let attempt = 0; attempt < 180; attempt++) {
    await wait(100);
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch { /* server is still binding */ }
  }
  throw new Error(`Isolated HTTP server did not start: ${log}`);
}

async function getWorkspaceSnapshot(): Promise<WorkspaceSnapshot> {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace`);
  if (!response.ok) throw new Error(`GET /api/workspace returned ${response.status}: ${(await response.text()).slice(0, 800)}`);
  return await response.json() as WorkspaceSnapshot;
}

function makeFixture(): Project {
  const project = structuredClone(sampleProject(rules));
  const roomA = rectRoom({ name: 'A 普通卧室', id: 'room_a', x: 0, y: 0, w: 7000, h: 4500, thickness: 120, height: 2700 });
  const takenIds = new Set([roomA.id, ...roomA.walls.map((wall) => wall.id)]);
  const roomB = rectRoom({ name: 'B 厨房', id: 'room_b', x: 8000, y: 0, w: 7000, h: 4500, thickness: 120, height: 2700, takenIds });
  project.id = 'project_pdf_room_layout_fixture';
  project.name = 'PDF 两房布局页验收';
  project.rooms = [roomA, roomB];
  const source = project.cabinets[0]!;
  const makeCabinet = (id: string, name: string, roomId: string, x: number) => {
    const cabinet = structuredClone(source);
    cabinet.id = id;
    cabinet.name = name;
    cabinet.roomId = roomId;
    cabinet.placement.x = x;
    cabinet.placement.y = 60;
    cabinet.placement.rotation = 0;
    cabinet.layout.units = cabinet.layout.units.map((unit, index) => ({ ...unit, id: `${id}_unit_${index + 1}` }));
    return cabinet;
  };
  project.cabinets = [
    makeCabinet('cab_a_bookcase', 'A-书柜', roomA.id, 3600),
    makeCabinet('cab_b_base', 'B-地柜', roomB.id, 8060),
    makeCabinet('cab_a_wardrobe', 'A-衣柜', roomA.id, 60),
  ];
  return project;
}

async function exportPdf(snapshot: WorkspaceSnapshot, label: string, layoutRoomIds?: string[]): Promise<{ pages: string[]; actualPages: number; headerPages: number; path: string }> {
  const response = await fetch(`http://127.0.0.1:${port}/api/export/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: snapshot.project,
      projectSnapshotId: snapshot.projectSnapshotId,
      projectSnapshotHash: snapshot.projectSnapshotHash,
      projectSnapshotVersion: snapshot.projectSnapshotVersion,
      modelVersion: `pdf-room-layout-${label}`,
      ...(layoutRoomIds === undefined ? {} : { layoutRoomIds }),
    }),
  });
  if (!response.ok) throw new Error(`${label}: POST /api/export/pdf returned ${response.status}: ${(await response.text()).slice(0, 800)}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const path = join(tempDir, `${label}.pdf`);
  writeFileSync(path, bytes);
  const headerPages = Number(response.headers.get('X-PDF-Page-Count') ?? 0);
  const pdfInfo = execFileSync('pdfinfo', [path], { encoding: 'utf8' });
  const actualPages = Number(/^Pages:\s+(\d+)\s*$/m.exec(pdfInfo)?.[1] ?? 0);
  const pages = Array.from({ length: actualPages }, (_, index) => execFileSync(
    'pdftotext', ['-f', String(index + 1), '-l', String(index + 1), '-layout', path, '-'], { encoding: 'utf8' },
  ));
  assert(`${label} 通过真实 HTTP 下载有效 PDF，响应页数头与 PDF 文件页数一致`, bytes.subarray(0, 5).toString('ascii') === '%PDF-' && headerPages === actualPages && actualPages > 0, `header=${headerPages}; pdfinfo=${actualPages}; bytes=${bytes.length}`);
  console.log(`    ${label} pages: ${pages.map((text, index) => `${index + 1}:${text.replace(/\s+/g, ' ').trim().slice(0, 90)}`).join(' | ')}`);
  return { pages, actualPages, headerPages, path };
}

async function stopServer(): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child?.once('close', () => resolve())),
    wait(2000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main(): Promise<void> {
  try {
    const fixture = makeFixture();
    await startServer(fixture);
    const snapshot = await getWorkspaceSnapshot();
    const project = snapshot.project;
    assert('两房 fixture 含 A 两柜、B 一柜，源数组故意打乱以验证与 UI 相同的稳定页序', project.rooms.length === 2 && project.cabinets.length === 3
      && project.cabinets.filter((cabinet) => cabinet.roomId === 'room_a').length === 2
      && project.cabinets.filter((cabinet) => cabinet.roomId === 'room_b').length === 1
      && project.cabinets.map((cabinet) => cabinet.id).join(',') === 'cab_a_bookcase,cab_b_base,cab_a_wardrobe',
    `源数组=${project.cabinets.map((cabinet) => `${cabinet.roomId}:${cabinet.name}`).join(', ')}; UI/DrawingPlan 顺序应按 rooms[] + placement.y/x + 原数组平局裁决`);

    const defaults = await exportPdf(snapshot, 'default');
    const defaultPageNames = defaults.pages.map(normalize);
    assert('默认 layoutRoomIds 缺省为空集：A柜1、A柜2、B柜共 3 页且无布局页', defaults.actualPages === 3
      && defaultPageNames.every((text) => !text.includes('房间布局'))
      && defaultPageNames[0]?.includes(normalize('A 普通卧室')) && defaultPageNames[0]?.includes('A-衣柜')
      && defaultPageNames[1]?.includes('A-书柜')
      && defaultPageNames[2]?.includes(normalize('B 厨房')) && defaultPageNames[2]?.includes('B-地柜'),
    defaultPageNames.map((text, index) => `${index + 1}:${text.slice(0, 160)}`).join(' | '));

    const onlyB = await exportPdf(snapshot, 'only-b', ['room_b']);
    const onlyBPages = onlyB.pages.map(normalize);
    const onlyBLayout = onlyBPages.findIndex((text) => text.includes('房间布局'));
    const onlyBCabinet = onlyBPages.findIndex((text) => text.includes('B-地柜') && text.includes(normalize('房间 B 厨房')));
    const onlyBFlags = {
      fourPages: onlyB.actualPages === 4,
      firstA: onlyBPages[0]?.includes('A-衣柜') ?? false,
      secondA: onlyBPages[1]?.includes('A-书柜') ?? false,
      layoutIndex: onlyBLayout,
      cabinetIndex: onlyBCabinet,
      layoutHasRoomName: onlyBPages[onlyBLayout]?.includes(normalize('B 厨房')) ?? false,
      oneLayout: onlyBPages.filter((text) => text.includes('房间布局')).length === 1,
    };
    assert('仅勾 B：4 页，A 两柜不变，B 布局页紧邻 B 柜体页之前且仅出现一次', onlyB.actualPages === 4
      && onlyBPages[0]?.includes('A-衣柜') && onlyBPages[1]?.includes('A-书柜')
      && onlyBLayout === 2 && onlyBCabinet === 3
      && onlyBPages[onlyBLayout]?.includes(normalize('B 厨房'))
      && onlyBPages.filter((text) => text.includes('房间布局')).length === 1,
    `${JSON.stringify(onlyBFlags)}; ${onlyBPages.map((text, index) => `${index + 1}:${text.slice(0, 160)}`).join(' | ')}`);

    const onlyA = await exportPdf(snapshot, 'only-a', ['room_a']);
    const onlyAPages = onlyA.pages.map(normalize);
    const onlyALayout = onlyAPages.findIndex((text) => text.includes('房间布局'));
    assert('仅勾 A：4 页，A 布局在两柜前，B 柜仍在末页且不插布局页', onlyA.actualPages === 4
      && onlyALayout === 0 && onlyAPages[0]?.includes(normalize('A 普通卧室'))
      && onlyAPages[1]?.includes('A-衣柜') && onlyAPages[2]?.includes('A-书柜')
      && onlyAPages[3]?.includes(normalize('B 厨房')) && onlyAPages[3]?.includes('B-地柜')
      && onlyAPages.filter((text) => text.includes('房间布局')).length === 1,
    onlyAPages.map((text, index) => `${index + 1}:${text.slice(0, 160)}`).join(' | '));
  } finally {
    await stopServer();
    rmSync(tempDir, { recursive: true, force: true });
  }
  console.log(`\n═══ PDF 每房间布局页真实 HTTP 验收：通过 ${passed} 项，失败 ${failed} 项 ═══`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error));
  await stopServer();
  rmSync(tempDir, { recursive: true, force: true });
  process.exitCode = 1;
});
