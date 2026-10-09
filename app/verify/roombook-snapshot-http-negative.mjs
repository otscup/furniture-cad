import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCabinet, emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src/core/ruleset/factory-default.json'), 'utf8'));
const tempRoot = mkdtempSync(join(tmpdir(), 'furnicad-roombook-snapshot-http-'));
const serverTemp = join(tempRoot, 'server-tmp');
const markerPath = join(tempRoot, 'roombook-emitter-started');
const preloadPath = join(tempRoot, 'delay-roombook-emitter.cjs');
mkdirSync(serverTemp, { recursive: true });
let child;
let port = 0;
let pass = 0;
let fail = 0;
let childLog = '';
const failures = [];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function buildProject() {
  const project = emptyProject({ id: 'project_roombook_snapshot_http', name: '图纸册快照 HTTP 验收', ruleSetId: rules.id });
  const room = rectRoom({ id: 'room_roombook_snapshot_http', name: '验收房间', x: 0, y: 0, w: 5000, h: 4000, thickness: 120, height: 2700 });
  project.rooms.push(room);
  project.cabinets.push(createCabinet({
    id: 'cab_roombook_snapshot_http',
    name: '快照基线柜',
    roomId: room.id,
    x: 400,
    y: 60,
    rules,
    params: { width: 800, height: 2000, depth: 600 },
  }));
  return project;
}

function seedWorkspace(path) {
  const envelope = JSON.parse(serializeProjectFile(buildProject()));
  Object.assign(envelope, {
    workspaceId: 'ws_roombook_snapshot_http',
    owner: 'local-open',
    account: 'local-open',
    liveModelVersion: 23,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(path, JSON.stringify(envelope, null, 2), 'utf8');
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('未能分配本地测试端口')));
      const selected = address.port;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
}

async function startServer() {
  port = await allocatePort();
  const workspacePath = join(tempRoot, 'workspace.json');
  seedWorkspace(workspacePath);
  const originalNodeOptions = process.env.NODE_OPTIONS ?? '';
  writeFileSync(preloadPath, [
    "const fs = require('node:fs');",
    "if (process.argv.some((arg) => arg.endsWith('/emit-roombook.ts'))) {",
    "  const marker = process.env.FURNICAD_ROOMBOOK_STARTED_FILE;",
    "  if (marker) fs.writeFileSync(marker, 'started');",
    "  const delay = Number(process.env.FURNICAD_ROOMBOOK_DELAY_MS || 0);",
    "  if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);",
    "}",
  ].join('\n') + '\n', 'utf8');

  child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', join(root, 'server/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      TMPDIR: serverTemp,
      APP_ENV_PATH: join(tempRoot, '.env'),
      APP_ACCOUNTS_PATH: join(tempRoot, 'accounts.json'),
      APP_AUDIT_PATH: join(tempRoot, 'audit.jsonl'),
      APP_MEM_PATH: join(tempRoot, 'corrections.jsonl'),
      APP_REGISTRATIONS_PATH: join(tempRoot, 'registrations.json'),
      APP_WORKSPACE_PATH: workspacePath,
      FURNICAD_ROOMBOOK_STARTED_FILE: markerPath,
      FURNICAD_ROOMBOOK_DELAY_MS: '1600',
      NODE_OPTIONS: `${originalNodeOptions}${originalNodeOptions ? ' ' : ''}--require=${preloadPath}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data) => { childLog += data.toString(); });
  child.stderr?.on('data', (data) => { childLog += data.toString(); });

  for (let attempt = 0; attempt < 180; attempt++) {
    await wait(100);
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (!response.ok) continue;
      const health = await response.json();
      if (health.workspace?.loading === false) return;
    } catch { /* 独立验收服务仍在启动 */ }
  }
  throw new Error(`独立 HTTP 服务启动失败：${childLog}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child?.once('close', resolve)),
    wait(2000),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function readSnapshot() {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace`);
  if (!response.ok) throw new Error(`/api/workspace 返回 ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return await response.json();
}

function exportBody(snapshot, project = snapshot.project, extra = {}) {
  return {
    project,
    projectSnapshotId: snapshot.projectSnapshotId,
    projectSnapshotHash: snapshot.projectSnapshotHash,
    projectSnapshotVersion: snapshot.projectSnapshotVersion,
    // 即使客户端传入伪造版本，正式打印物也只能标注服务端已确认版本。
    modelVersion: 'client-spoofed-v999999',
    ...extra,
  };
}

async function requestExport(body) {
  return fetch(`http://127.0.0.1:${port}/api/export/roombook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function assertRejected(label, body, expectedCode, expectedField) {
  rmSync(markerPath, { force: true });
  const response = await requestExport(body);
  const text = await response.text();
  let payload = {};
  try { payload = JSON.parse(text); } catch { /* assertions report malformed responses */ }
  const fields = Array.isArray(payload.mismatchFields) ? payload.mismatchFields : [];
  check(`${label} → 明确 409 ${expectedCode}，无可打印附件`, response.status === 409
    && payload.code === expectedCode && fields.includes(expectedField)
    && !response.headers.has('Content-Disposition')
    && (response.headers.get('Content-Type') ?? '').toLowerCase().includes('application/json')
    && response.headers.get('Cache-Control') === 'no-store',
  `status=${response.status}; code=${String(payload.code)}; fields=${JSON.stringify(fields)}; bytes=${Buffer.byteLength(text)}`);
  const temporaryFiles = readdirSync(serverTemp);
  check(`${label} 拒绝时未启动图纸册生成器或生成临时文件`, !existsSync(markerPath) && temporaryFiles.length === 0,
    `emitterStarted=${existsSync(markerPath)}; tempFiles=${JSON.stringify(temporaryFiles)}`);
}

async function callTool(name, args) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${Date.now()}-${name}`, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await response.text();
  let message = {};
  try { message = JSON.parse(raw); } catch {
    const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith('data:'));
    if (dataLine) {
      try { message = JSON.parse(dataLine.slice(5).trim()); } catch { /* report below */ }
    }
  }
  const text = message.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`MCP ${name} HTTP ${response.status}: ${raw.slice(0, 700)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`MCP ${name} 返回非 JSON 工具文本：${text.slice(0, 500)}`); }
}

async function main() {
  try {
    await startServer();
    const snapshot = await readSnapshot();
    const canonical = (value) => value === null || typeof value !== 'object'
      ? JSON.stringify(value)
      : Array.isArray(value)
        ? `[${value.map(canonical).join(',')}]`
        : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    const actualHash = createHash('sha256').update(canonical(snapshot.project)).digest('hex');
    check('真实 HTTP 工作区快照元数据与项目内容相互一致', snapshot.projectSnapshotVersion === snapshot.liveModelVersion
      && snapshot.projectSnapshotId === `${snapshot.workspaceId}:v${snapshot.projectSnapshotVersion}:${snapshot.projectSnapshotHash}`
      && snapshot.projectSnapshotHash === actualHash,
    `version=${snapshot.projectSnapshotVersion}; hash=${snapshot.projectSnapshotHash}`);

    console.log('\nA. roombook 负样本：元数据缺失、版本不符、项目内容 hash 不符');
    for (const field of ['projectSnapshotId', 'projectSnapshotHash', 'projectSnapshotVersion']) {
      const body = exportBody(snapshot);
      delete body[field];
      await assertRejected(`缺少快照元数据 ${field}`, body, 'EXPORT_SNAPSHOT_REQUIRED', field);
    }
    await assertRejected('快照版本与 live 不符', exportBody(snapshot, structuredClone(snapshot.project), {
      projectSnapshotVersion: snapshot.projectSnapshotVersion + 1,
    }), 'EXPORT_SNAPSHOT_CONFLICT', 'projectSnapshotVersion');
    const tampered = structuredClone(snapshot.project);
    tampered.cabinets[0].placement.x += 10;
    await assertRejected('项目内容变更导致 hash 不符', exportBody(snapshot, tampered), 'EXPORT_SNAPSHOT_CONFLICT', 'project');

    console.log('\nB. 正常导出：返回完整 HTML，且版本与响应头绑定服务端快照');
    rmSync(markerPath, { force: true });
    const success = await requestExport(exportBody(snapshot));
    const html = await success.text();
    const expectedVersionTag = `<meta name="furniture-model-version" content="v${snapshot.projectSnapshotVersion}">`;
    check('匹配快照仍可导出完整 HTML 图纸册', success.status === 200
      && html.startsWith('<!DOCTYPE html>') && html.includes('</html>')
      && html.includes(expectedVersionTag) && html.includes('快照基线柜'),
    `status=${success.status}; bytes=${Buffer.byteLength(html)}; versionTag=${html.includes(expectedVersionTag)}`);
    check('成功响应标识确认的快照并禁止缓存', success.headers.get('X-Project-Snapshot-Id') === snapshot.projectSnapshotId
      && success.headers.get('X-Project-Snapshot-Hash') === snapshot.projectSnapshotHash
      && success.headers.get('X-Project-Snapshot-Version') === String(snapshot.projectSnapshotVersion)
      && success.headers.get('Cache-Control') === 'no-store'
      && success.headers.has('Content-Disposition'),
    `id=${success.headers.get('X-Project-Snapshot-Id')}; version=${success.headers.get('X-Project-Snapshot-Version')}`);

    console.log('\nC. 并发一致性：生成期间 apply live，输出仅可为旧快照完整文件或明确冲突');
    const beforeConcurrent = await readSnapshot();
    const draft = await callTool('cad.create_cabinet', {
      name: 'ROOMBOOK_CONCURRENT_SENTINEL',
      roomId: 'room_roombook_snapshot_http',
      width: 800,
      height: 2000,
      depth: 600,
      x: 2500,
      y: 60,
    });
    const draftId = String(draft.draftId ?? '');
    check('并发用 draft 创建成功且尚未改变 live', draft.ok === true && Boolean(draftId)
      && (await readSnapshot()).projectSnapshotVersion === beforeConcurrent.projectSnapshotVersion,
    `draftId=${draftId}; created=${JSON.stringify(draft).slice(0, 220)}`);
    if (!draftId) throw new Error('无法创建并发验收 draft');

    rmSync(markerPath, { force: true });
    const exportPromise = requestExport(exportBody(beforeConcurrent));
    let generationStarted = false;
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (existsSync(markerPath)) {
        generationStarted = true;
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await wait(5);
    }
    check('已观察到快照确认后的 roombook 生成窗口', generationStarted, `marker=${existsSync(markerPath)}`);

    let applyResponse;
    if (generationStarted) {
      const previewResponse = await fetch(`http://127.0.0.1:${port}/api/drafts/${encodeURIComponent(draftId)}`);
      const preview = await previewResponse.json();
      applyResponse = await fetch(`http://127.0.0.1:${port}/api/drafts/${encodeURIComponent(draftId)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          syncId: 'roombook-concurrent-apply-v1',
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
    }
    const appliedText = applyResponse ? await applyResponse.text() : '';
    const afterConcurrent = await readSnapshot();
    check('并发 live 修改已生效且版本递增', Boolean(applyResponse) && applyResponse.status === 200
      && afterConcurrent.projectSnapshotVersion === beforeConcurrent.projectSnapshotVersion + 1
      && afterConcurrent.project.cabinets.some((cabinet) => cabinet.name === 'ROOMBOOK_CONCURRENT_SENTINEL'),
    `apply=${applyResponse?.status ?? 'not attempted'}; live=${afterConcurrent.projectSnapshotVersion}; body=${appliedText.slice(0, 220)}`);

    const concurrentResponse = await exportPromise;
    const concurrentBytes = Buffer.from(await concurrentResponse.arrayBuffer());
    if (concurrentResponse.status === 200) {
      const concurrentHtml = concurrentBytes.toString('utf8');
      const oldSnapshotTag = `<meta name="furniture-model-version" content="v${beforeConcurrent.projectSnapshotVersion}">`;
      check('并发期间成功的图纸册是完整文件且严格对应已验证旧快照', concurrentHtml.startsWith('<!DOCTYPE html>')
        && concurrentHtml.includes('</html>')
        && concurrentResponse.headers.get('X-Project-Snapshot-Id') === beforeConcurrent.projectSnapshotId
        && concurrentResponse.headers.get('X-Project-Snapshot-Hash') === beforeConcurrent.projectSnapshotHash
        && concurrentResponse.headers.get('X-Project-Snapshot-Version') === String(beforeConcurrent.projectSnapshotVersion)
        && concurrentHtml.includes(oldSnapshotTag)
        && !concurrentHtml.includes('ROOMBOOK_CONCURRENT_SENTINEL'),
      `status=${concurrentResponse.status}; bytes=${concurrentBytes.length}; exported-v=${concurrentResponse.headers.get('X-Project-Snapshot-Version')}; live-v=${afterConcurrent.projectSnapshotVersion}`);
    } else {
      let conflict = {};
      try { conflict = JSON.parse(concurrentBytes.toString('utf8')); } catch { /* assertion below */ }
      check('并发期间若拒绝则为明确 409 冲突，未返回附件', concurrentResponse.status === 409
        && conflict.code === 'EXPORT_SNAPSHOT_CONFLICT'
        && !concurrentResponse.headers.has('Content-Disposition')
        && concurrentResponse.headers.get('Cache-Control') === 'no-store'
        && readdirSync(serverTemp).length === 0,
      `status=${concurrentResponse.status}; code=${String(conflict.code)}; bytes=${concurrentBytes.length}; tempFiles=${JSON.stringify(readdirSync(serverTemp))}`);
    }

    console.log(`\nroombook snapshot HTTP negative acceptance: ${pass} passed, ${fail} failed`);
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
