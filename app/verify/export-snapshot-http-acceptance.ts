import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCabinet, emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import type { Project, RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const tempRoot = mkdtempSync(join(tmpdir(), 'furnicad-export-snapshot-http-'));
const serverTemp = join(tempRoot, 'server-tmp');
mkdirSync(serverTemp, { recursive: true });
let child: ChildProcess | null = null;
let port = 0;
let pass = 0;
let fail = 0;
const failures: string[] = [];
let childLog = '';

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 独立实现 API 契约：对象键排序、数组顺序不变。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function buildProject(): Project {
  const project = emptyProject({ id: 'project_export_snapshot_http', name: '快照绑定 HTTP 验收', ruleSetId: rules.id });
  const room = rectRoom({ id: 'room_export_snapshot_http', name: '验收房间', x: 0, y: 0, w: 5000, h: 4000, thickness: 120, height: 2700 });
  project.rooms.push(room);
  project.cabinets.push(createCabinet({
    id: 'cab_export_snapshot_http',
    name: '基线柜',
    roomId: room.id,
    x: 400,
    y: 60,
    rules,
    params: { width: 800, height: 2000, depth: 600 },
  }));
  return project;
}

function seedWorkspace(path: string): void {
  const envelope = JSON.parse(serializeProjectFile(buildProject())) as Record<string, unknown>;
  Object.assign(envelope, {
    workspaceId: 'ws_export_snapshot_http',
    owner: 'local-open',
    account: 'local-open',
    liveModelVersion: 23,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(envelope, null, 2), 'utf8');
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('未能分配本地端口')));
      const selected = address.port;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

async function startServer(): Promise<void> {
  port = await allocatePort();
  const workspacePath = join(tempRoot, 'workspace.json');
  const accountsPath = join(tempRoot, 'accounts.json');
  seedWorkspace(workspacePath);
  const python = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
  const delayedPython = join(tempRoot, 'python-with-export-delay.sh');
  // 只延迟本验收子服务的 DXF/PDF 序列化子进程，稳定制造可观测的真实并发窗口。
  writeFileSync(delayedPython, `#!/bin/sh\nsleep 1\nexec "${python}" "$@"\n`, 'utf8');
  chmodSync(delayedPython, 0o755);

  child = spawn(process.execPath, [join(root, 'server/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_PYTHON: delayedPython,
      TMPDIR: serverTemp,
      APP_ENV_PATH: join(tempRoot, '.env'),
      APP_ACCOUNTS_PATH: accountsPath,
      APP_AUDIT_PATH: join(tempRoot, 'audit.jsonl'),
      APP_MEM_PATH: join(tempRoot, 'corrections.jsonl'),
      APP_REGISTRATIONS_PATH: join(tempRoot, 'registrations.json'),
      APP_WORKSPACE_PATH: workspacePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data: Buffer) => { childLog += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { childLog += data.toString(); });

  for (let attempt = 0; attempt < 180; attempt++) {
    await wait(100);
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (!health.ok) continue;
      const status = await health.json() as { workspace?: { loading?: boolean } };
      if (status.workspace?.loading === false) return;
    } catch { /* 服务仍在启动 */ }
  }
  throw new Error(`独立 HTTP 服务启动失败：${childLog}`);
}

interface SnapshotResponse {
  ok: true;
  project: Project;
  workspaceId: string;
  liveModelVersion: number;
  projectSnapshotId: string;
  projectSnapshotHash: string;
  projectSnapshotVersion: number;
}

async function readSnapshot(): Promise<SnapshotResponse> {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace`);
  if (!response.ok) throw new Error(`/api/workspace 返回 ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return await response.json() as SnapshotResponse;
}

function requestBody(snapshot: SnapshotResponse, project: Project = snapshot.project, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    project,
    projectSnapshotId: snapshot.projectSnapshotId,
    projectSnapshotHash: snapshot.projectSnapshotHash,
    projectSnapshotVersion: snapshot.projectSnapshotVersion,
    // 客户端传来的展示版本不得覆盖服务器权威快照版本。
    modelVersion: 'client-spoofed-v999999',
    which: ['plan', 'sheet'],
    layoutRoomIds: [],
    ...extra,
  };
}

async function requestExport(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function exportTempEntries(): string[] {
  return readdirSync(serverTemp).sort();
}

function formatEntries(): Array<{ label: string; path: string; signature: (bytes: Buffer, response: Response) => boolean }> {
  return [
    {
      label: 'DXF',
      path: '/api/export/dxf',
      signature: (bytes) => bytes.length > 100 && bytes.subarray(0, 20).toString('ascii').includes('SECTION'),
    },
    {
      label: 'CSV',
      path: '/api/export/cutlist',
      signature: (bytes) => bytes.length > 100 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
    },
    {
      label: 'PDF',
      path: '/api/export/pdf',
      signature: (bytes, response) => bytes.length > 500 && bytes.subarray(0, 5).toString('ascii') === '%PDF-' && Number(response.headers.get('X-PDF-Page-Count')) > 0,
    },
  ];
}

async function assertRejected(
  format: { label: string; path: string },
  label: string,
  body: Record<string, unknown>,
  expectedCode: string,
  expectedField: string,
): Promise<void> {
  const response = await requestExport(format.path, body);
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* 被判为非结构化错误 */ }
  const fields = Array.isArray(json.mismatchFields) ? json.mismatchFields : [];
  check(`${format.label} ${label} → 409 ${expectedCode}（无附件文件）`,
    response.status === 409 && json.code === expectedCode && fields.includes(expectedField)
      && !response.headers.has('Content-Disposition') && !/^(application\/pdf|application\/dxf|text\/csv)/i.test(response.headers.get('Content-Type') ?? '')
      && response.headers.get('Cache-Control') === 'no-store',
    `status=${response.status}; code=${String(json.code)}; fields=${JSON.stringify(fields)}; bytes=${Buffer.byteLength(text)}`);
  check(`${format.label} ${label} 未创建/缓存任何导出临时文件`, exportTempEntries().length === 0, JSON.stringify(exportTempEntries()));
}

async function assertSuccessfulExport(format: ReturnType<typeof formatEntries>[number], snapshot: SnapshotResponse): Promise<void> {
  const response = await requestExport(format.path, requestBody(snapshot));
  const bytes = Buffer.from(await response.arrayBuffer());
  const headersMatch = response.headers.get('X-Project-Snapshot-Id') === snapshot.projectSnapshotId
    && response.headers.get('X-Project-Snapshot-Hash') === snapshot.projectSnapshotHash
    && response.headers.get('X-Project-Snapshot-Version') === String(snapshot.projectSnapshotVersion);
  check(`${format.label} 匹配快照正常导出`, response.status === 200 && format.signature(bytes, response)
    && response.headers.has('Content-Disposition') && response.headers.get('Cache-Control') === 'no-store',
  `status=${response.status}; bytes=${bytes.length}; content-type=${response.headers.get('Content-Type')}`);
  check(`${format.label} 成功响应仍绑定已确认的服务器快照头`, headersMatch,
    `id=${response.headers.get('X-Project-Snapshot-Id')}; version=${response.headers.get('X-Project-Snapshot-Version')}`);
  check(`${format.label} 正常导出后临时目录已清理`, exportTempEntries().length === 0, JSON.stringify(exportTempEntries()));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${Date.now()}-${name}`, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.text();
  let message: Record<string, any> = {};
  try {
    message = JSON.parse(raw) as Record<string, any>;
  } catch {
    const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith('data:'));
    if (dataLine) {
      try { message = JSON.parse(dataLine.slice(5).trim()) as Record<string, any>; } catch { /* below reports malformed */ }
    }
  }
  const toolText = message.result?.content?.[0]?.text;
  if (typeof toolText !== 'string') throw new Error(`MCP ${name} HTTP ${response.status}: ${raw.slice(0, 700)}`);
  try { return JSON.parse(toolText) as Record<string, unknown>; }
  catch { throw new Error(`MCP ${name} returned non-JSON tool text: ${toolText.slice(0, 500)}`); }
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
    await startServer();
    const snapshot = await readSnapshot();
    check('GET /api/workspace 提供 ID/hash/version 且 hash 与项目内容独立计算一致',
      snapshot.projectSnapshotVersion === snapshot.liveModelVersion
        && snapshot.projectSnapshotId === `${snapshot.workspaceId}:v${snapshot.projectSnapshotVersion}:${snapshot.projectSnapshotHash}`
        && snapshot.projectSnapshotHash === sha256(canonicalJson(snapshot.project)),
      `v${snapshot.projectSnapshotVersion}; hash=${snapshot.projectSnapshotHash}`);
    check('复现基线 placement.x=400', snapshot.project.cabinets[0]?.placement.x === 400,
      `actual=${snapshot.project.cabinets[0]?.placement.x}`);

    console.log('\nA. 真实 HTTP fail-closed：版本冲突、内容 hash 不符、缺少快照元数据 × DXF/CSV/PDF');
    for (const format of formatEntries()) {
      const versionMismatch = requestBody(snapshot, structuredClone(snapshot.project), {
        projectSnapshotVersion: snapshot.projectSnapshotVersion + 1,
      });
      await assertRejected(format, '服务器快照版本不符', versionMismatch, 'EXPORT_SNAPSHOT_CONFLICT', 'projectSnapshotVersion');

      const tampered = structuredClone(snapshot.project);
      tampered.cabinets[0]!.placement.x = 410;
      await assertRejected(format, '内容 hash 不符（placement.x 400→410）', requestBody(snapshot, tampered), 'EXPORT_SNAPSHOT_CONFLICT', 'project');

      await assertRejected(format, '缺少全部快照元数据', {
        project: snapshot.project,
        which: ['plan', 'sheet'],
        layoutRoomIds: [],
      }, 'EXPORT_SNAPSHOT_REQUIRED', 'projectSnapshotId');
    }

    console.log('\nB. 正常通路：匹配的已确认快照仍能下载完整 DXF、CSV、PDF');
    for (const format of formatEntries()) await assertSuccessfulExport(format, snapshot);

    console.log('\nC. 真 HTTP 并发修改：导出已越过快照门槛时 apply live，结果只能对应已确认快照或冲突');
    const beforeConcurrent = await readSnapshot();
    const created = await callTool('cad.create_cabinet', {
      name: 'CONCURRENT_SNAPSHOT_SENTINEL',
      roomId: 'room_export_snapshot_http',
      width: 800,
      height: 2000,
      depth: 600,
      x: 2500,
      y: 60,
    });
    const draftId = String(created.draftId ?? '');
    check('并发用新柜草稿已创建但尚未修改 live', created.ok === true && Boolean(draftId)
      && (await readSnapshot()).projectSnapshotVersion === beforeConcurrent.projectSnapshotVersion,
    `draftId=${draftId}; created=${JSON.stringify(created).slice(0, 220)}`);
    if (!draftId) throw new Error('无法创建并发验收 draft');

    const exportPromise = requestExport('/api/export/dxf', requestBody(beforeConcurrent));
    let exportGenerationStarted = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (exportTempEntries().some((entry) => entry.startsWith('furniture-dxf-'))) {
        exportGenerationStarted = true;
        break;
      }
      await wait(5);
    }
    check('DXF 服务端已通过快照门槛并进入导出生成（观察到隔离临时目录）', exportGenerationStarted, JSON.stringify(exportTempEntries()));

    const previewResponse = await fetch(`http://127.0.0.1:${port}/api/drafts/${encodeURIComponent(draftId)}`);
    const preview = await previewResponse.json() as Record<string, any>;
    const appliedResponse = await fetch(`http://127.0.0.1:${port}/api/drafts/${encodeURIComponent(draftId)}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        syncId: 'dxf-concurrent-apply-v1',
        runId: preview.runId,
        draftId: preview.draftId,
        revision: preview.revision,
        draftHash: preview.draftHash,
        localVersion: 0,
        remoteVersion: preview.liveModelVersion,
        baseModelVersion: preview.baseModelVersion,
        baseProjectHash: preview.baseProjectHash,
      }),
    });
    const appliedText = await appliedResponse.text();
    let applied: Record<string, any> = {};
    try { applied = JSON.parse(appliedText) as Record<string, any>; } catch { /* assert below */ }
    const afterConcurrent = await readSnapshot();
    check('并发 apply 已使服务器 live 版本递增且包含 sentinel 柜', appliedResponse.status === 200
      && afterConcurrent.projectSnapshotVersion === beforeConcurrent.projectSnapshotVersion + 1
      && afterConcurrent.project.cabinets.some((cabinet) => cabinet.name === 'CONCURRENT_SNAPSHOT_SENTINEL'),
    `apply=${appliedResponse.status}; live=${afterConcurrent.projectSnapshotVersion}; body=${appliedText.slice(0, 220)}`);

    const concurrentExport = await exportPromise;
    const concurrentBytes = Buffer.from(await concurrentExport.arrayBuffer());
    if (concurrentExport.status === 200) {
      const dxfText = concurrentBytes.toString('utf8');
      check('并发窗口内成功的 DXF 严格对应已校验的旧 snapshot/hash/version，而非新 live',
        concurrentExport.headers.get('X-Project-Snapshot-Id') === beforeConcurrent.projectSnapshotId
          && concurrentExport.headers.get('X-Project-Snapshot-Hash') === beforeConcurrent.projectSnapshotHash
          && concurrentExport.headers.get('X-Project-Snapshot-Version') === String(beforeConcurrent.projectSnapshotVersion)
          && !dxfText.includes('CONCURRENT_SNAPSHOT_SENTINEL'),
        `status=${concurrentExport.status}; bytes=${concurrentBytes.length}; exported-v=${concurrentExport.headers.get('X-Project-Snapshot-Version')}; live-v=${afterConcurrent.projectSnapshotVersion}`);
    } else {
      const text = concurrentBytes.toString('utf8');
      let conflict: Record<string, any> = {};
      try { conflict = JSON.parse(text) as Record<string, any>; } catch { /* assert below */ }
      check('并发窗口内若拒绝导出则返回明确 409 冲突且没有附件', concurrentExport.status === 409
        && conflict.code === 'EXPORT_SNAPSHOT_CONFLICT' && !concurrentExport.headers.has('Content-Disposition'),
      `status=${concurrentExport.status}; code=${String(conflict.code)}; bytes=${concurrentBytes.length}`);
    }
    check('并发导出结束后没有遗留部分文件或缓存临时目录', exportTempEntries().length === 0, JSON.stringify(exportTempEntries()));

    console.log(`\nHTTP snapshot export acceptance: ${pass} passed, ${fail} failed`);
    if (fail > 0) throw new Error(`验收失败：${fail} 项（${failures.join('；')}）`);
  } finally {
    await stopServer();
    if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  if (childLog) console.error(`\n--- isolated server log ---\n${childLog.slice(-4000)}`);
  process.exitCode = 1;
});
