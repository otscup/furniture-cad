import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'furnicad-mcp-http-fs-failure-'));
const workspacePath = join(temp, 'workspaces', 'local-open', 'workspace.json');
const draftsDir = join(dirname(workspacePath), 'drafts');
const quarantineDir = join(draftsDir, 'quarantine');
const controlPath = join(temp, 'fs-fault-control.json');
const faultLogPath = join(temp, 'fs-fault-operations.jsonl');
const preloadPath = join(temp, 'filesystem-fault-preload.mjs');
let port = 0;
let child: ChildProcess | null = null;
let childOutput = '';
let pass = 0;
let fail = 0;
const failures: string[] = [];

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
function section(name: string): void { console.log(`\n${name}`); }
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('no port')));
      const found = address.port;
      server.close((error) => error ? reject(error) : resolve(found));
    });
  });
}

function writePreload(): void {
  writeFileSync(preloadPath, `
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
const workspace = process.env.APP_WORKSPACE_PATH;
const drafts = join(dirname(workspace), 'drafts');
const control = process.env.APP_FS_FAULT_CONTROL;
const log = process.env.APP_FS_FAULT_LOG;
const failure = (op) => Object.assign(new Error('injected filesystem failure at ' + op), { code: 'EIO' });
function consume(op) {
  try {
    const current = JSON.parse(fs.readFileSync(control, 'utf8'));
    if (Array.isArray(current.ops)) {
      if (current.ops[0] !== op) return false;
      current.ops.shift();
      fs.writeFileSync(control, JSON.stringify(current), 'utf8');
      return true;
    }
    if (current.op !== op) return false;
    fs.writeFileSync(control, '{}', 'utf8');
    return true;
  } catch { return false; }
}
function record(op, path) {
  fs.appendFileSync(log, JSON.stringify({ op, path }) + '\\n', 'utf8');
}
const adapter = {
  existsSync: fs.existsSync,
  readFileSync: fs.readFileSync,
  readdirSync: fs.readdirSync,
  mkdirSync: fs.mkdirSync,
  writeFileSync(path, data, encoding) {
    const target = String(path);
    if (target.startsWith(workspace + '.') && target.endsWith('.tmp') && consume('live-write')) {
      record('writeFileSync(temp)-EIO', target);
      throw failure('writeFileSync(temp)');
    }
    if (target.startsWith(drafts + '/') && target.endsWith('.tmp') && consume('draft-write')) {
      record('writeFileSync(draft-temp)-EIO', target);
      throw failure('writeFileSync(draft-temp)');
    }
    return fs.writeFileSync(path, data, encoding);
  },
  renameSync(from, to) {
    const target = String(to);
    if (target === workspace && consume('live-rename')) {
      record('renameSync(temp, workspace)-EIO', target);
      throw failure('renameSync(temp, workspace)');
    }
    if (target.startsWith(drafts + '/quarantine/') && consume('draft-quarantine-rename')) {
      record('renameSync(draft, quarantine)-EIO', target);
      throw failure('renameSync(draft, quarantine)');
    }
    return fs.renameSync(from, to);
  },
  unlinkSync(path) {
    const target = String(path);
    if (target.startsWith(drafts + '/') && !target.includes('/quarantine/') && consume('draft-unlink')) {
      record('unlinkSync(draft)-EIO', target);
      throw failure('unlinkSync(draft)');
    }
    return fs.unlinkSync(path);
  },
};
globalThis[Symbol.for('furniture-cad.workspaceFileSystemAdapter')] = adapter;
`, 'utf8');
  writeFileSync(controlPath, '{}', 'utf8');
  writeFileSync(faultLogPath, '', 'utf8');
}

async function startServer(): Promise<void> {
  port = await allocatePort();
  childOutput = '';
  child = spawn(process.execPath, ['--import', preloadPath, join(root, 'server/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_WORKSPACE_PATH: workspacePath,
      APP_ACCOUNTS_PATH: join(temp, 'accounts.json'),
      APP_AUDIT_PATH: join(temp, 'audit.jsonl'),
      APP_MEM_PATH: join(temp, 'corrections.jsonl'),
      APP_ENV_PATH: join(temp, '.env'),
      APP_REGISTRATIONS_PATH: join(temp, 'registrations.json'),
      APP_FS_FAULT_CONTROL: controlPath,
      APP_FS_FAULT_LOG: faultLogPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => { childOutput += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { childOutput += chunk.toString(); });
  for (let i = 0; i < 150; i++) {
    await wait(100);
    if (child.exitCode !== null || child.signalCode !== null) break;
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* wait */ }
  }
  throw new Error(`server failed to start: ${childOutput}`);
}
async function stopServer(): Promise<void> {
  const current = child;
  child = null;
  if (!current || current.exitCode !== null) return;
  current.kill();
  await Promise.race([new Promise<void>((resolve) => current.once('exit', () => resolve())), wait(3000)]);
}
function setFault(op: string): void { writeFileSync(controlPath, JSON.stringify({ op }), 'utf8'); }
function setFaultSequence(...ops: string[]): void { writeFileSync(controlPath, JSON.stringify({ ops }), 'utf8'); }
async function api(path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* leave raw response */ }
  return { status: response.status, json, text };
}
async function mcp(name: string, args: Record<string, unknown>): Promise<{ status: number; json: any; payload: any; isError: boolean }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: any;
  try { json = JSON.parse(text); } catch { throw new Error(`invalid MCP response: ${text.slice(0, 500)}`); }
  const content = json?.result?.content?.[0]?.text;
  let payload: any = null;
  try { payload = JSON.parse(content ?? '{}'); } catch { payload = { raw: content }; }
  return { status: response.status, json, payload, isError: json?.result?.isError === true || !!json?.error };
}
function confirmation(preview: any, syncId: string, localVersion = 0): Record<string, unknown> {
  return {
    syncId,
    runId: preview.runId,
    draftId: preview.draftId,
    revision: preview.revision,
    draftHash: preview.draftHash,
    localVersion,
    remoteVersion: preview.liveModelVersion,
    baseModelVersion: preview.baseModelVersion,
    baseProjectHash: preview.baseProjectHash,
  };
}
function readDiskDraft(draftId: string): string {
  return readFileSync(join(draftsDir, `${draftId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`), 'utf8');
}
function diskDraftPath(draftId: string): string {
  return join(draftsDir, `${draftId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function quarantineFilesFor(draftId: string): string[] {
  if (!existsSync(quarantineDir)) return [];
  const safeId = draftId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return readdirSync(quarantineDir).filter((name) => name.startsWith(`${safeId}.`)).sort();
}
async function captureConfirmationState(draftId: string): Promise<any> {
  const workspace = await api('/api/workspace');
  const drafts = await api('/api/drafts');
  const preview = await api(`/api/drafts/${encodeURIComponent(draftId)}`);
  const diskWorkspace = readFileSync(workspacePath, 'utf8');
  const parsedDiskWorkspace = JSON.parse(diskWorkspace);
  return {
    workspace: workspace.json,
    drafts: drafts.json,
    preview: preview.json,
    diskWorkspace,
    receipts: parsedDiskWorkspace.draftSyncReceipts ?? {},
    draftFile: readDiskDraft(draftId),
    diskDraftFiles: readdirSync(draftsDir).filter((name) => name.endsWith('.json')).sort(),
  };
}
function explicitMcpRejection(response: { isError: boolean; json: any; payload: any }): boolean {
  const errorText = [response.json?.error?.message, response.payload?.message, response.payload?.code, response.payload?.raw]
    .filter((value) => value !== undefined && value !== null).map(String).join(' ');
  return response.isError && errorText.trim().length > 0;
}

async function applyNegative(transport: 'HTTP' | 'MCP', draftId: string, body: Record<string, any>,
  expected: 'required' | 'invalid' | 'stale' | 'missing-draft', field: string): Promise<{ rejected: boolean; detail: string }> {
  if (transport === 'HTTP') {
    const response = await api(`/api/drafts/${encodeURIComponent(draftId)}/apply`, 'POST', body);
    const rejected = expected === 'required'
      ? response.status === 400 && response.json?.code === 'APPLY_METADATA_REQUIRED' && response.json?.missingFields?.includes(field)
      : expected === 'invalid'
        ? response.status === 400 && response.json?.code === 'APPLY_METADATA_INVALID'
        : response.status === 409 && response.json?.code === (expected === 'missing-draft' ? 'DRAFT_STALE' : 'DRAFT_STALE');
    return { rejected, detail: `HTTP ${response.status} ${response.json?.code ?? response.text.slice(0, 100)}` };
  }
  const response = await mcp('cad.apply_draft', body);
  const code = response.payload?.code;
  const rejected = expected === 'required' || expected === 'invalid'
    ? explicitMcpRejection(response)
    : response.isError && (code === 'DRAFT_STALE' || code === 'DRAFT_NOT_FOUND' || explicitMcpRejection(response));
  return { rejected, detail: `MCP status=${response.status} code=${code ?? response.json?.error?.code ?? 'tool-error'}` };
}

async function captureRecoveryState(draftId: string, syncId: string): Promise<any> {
  const workspace = await api('/api/workspace');
  const drafts = await api('/api/drafts');
  const diskWorkspace = readFileSync(workspacePath, 'utf8');
  const envelope = JSON.parse(diskWorkspace);
  return {
    workspace: workspace.json,
    drafts: drafts.json,
    diskWorkspace,
    diskEnvelope: envelope,
    receipt: envelope.draftSyncReceipts?.[syncId] ?? null,
    draftFileExists: existsSync(diskDraftPath(draftId)),
    draftFile: existsSync(diskDraftPath(draftId)) ? readDiskDraft(draftId) : null,
    quarantineFiles: quarantineFilesFor(draftId),
  };
}
function receiptMatchesConfirmation(receipt: any, body: Record<string, any>): boolean {
  return !!receipt && receipt.syncId === body.syncId && receipt.draftId === body.draftId
    && receipt.runId === body.runId && receipt.revision === body.revision && receipt.hash === body.draftHash
    && receipt.localVersion === body.localVersion && receipt.remoteVersion === body.remoteVersion
    && receipt.baseModelVersion === body.baseModelVersion && receipt.baseProjectHash === body.baseProjectHash;
}
function cabinetUnitMap(project: any): Array<{ cabinetId: string; rows: string[][]; backUnitIds: string[] }> {
  return project.cabinets.map((cabinet: any) => ({
    cabinetId: cabinet.id,
    rows: Array.isArray(cabinet.layout.rows) && cabinet.layout.rows.length
      ? cabinet.layout.rows.map((row: any) => row.units.map((unit: any) => unit.id))
      : [cabinet.layout.units.map((unit: any) => unit.id)],
    backUnitIds: (cabinet.layout.backUnits ?? []).map((unit: any) => unit.id),
  }));
}
function allProjectUnitIds(project: any): string[] {
  return project.cabinets.flatMap((cabinet: any) => [
    ...(Array.isArray(cabinet.layout.rows) && cabinet.layout.rows.length
      ? cabinet.layout.rows.flatMap((row: any) => row.units.map((unit: any) => unit.id))
      : cabinet.layout.units.map((unit: any) => unit.id)),
    ...(cabinet.layout.backUnits ?? []).map((unit: any) => unit.id),
  ]);
}

async function verifyPostCommitCleanupRecovery(transport: 'HTTP' | 'MCP', cabinetName: string, syncId: string, localVersion: number): Promise<void> {
  const created = await mcp('cad.create_cabinet', { name: cabinetName, roomId: 'room_fs_fault', width: 880, height: 2050, depth: 590 });
  const draftId = String(created.payload?.draftId ?? '');
  const draftFile = diskDraftPath(draftId);
  const preview = await api(`/api/drafts/${encodeURIComponent(draftId)}`);
  const body = confirmation(preview.json, syncId, localVersion);
  const expectedProject = structuredClone(preview.json.project);
  const expectedIdMap = cabinetUnitMap(expectedProject);
  const expectedCabinet = expectedProject.cabinets.find((cabinet: any) => cabinet.name === cabinetName);
  const expectedCabinetUnitIds = (expectedIdMap.find((entry) => entry.cabinetId === expectedCabinet?.id)?.rows ?? []).flat();
  const before = await api('/api/workspace');
  const existingUnitIds = new Set(allProjectUnitIds(before.json.project));
  const candidateProjectUnitIds = allProjectUnitIds(expectedProject);
  check(`${transport} preview 已在写入前分配全项目唯一且无冲突的Unit IDs`,
    !!expectedCabinet && expectedCabinetUnitIds.length > 0
      && new Set(candidateProjectUnitIds).size === candidateProjectUnitIds.length
      && expectedCabinetUnitIds.every((id) => !existingUnitIds.has(id)),
    `cabinetId=${expectedCabinet?.id}; unitIds=${expectedCabinetUnitIds.join(',')}; projectUnique=${new Set(candidateProjectUnitIds).size === candidateProjectUnitIds.length}; newCabinetDisjointFromLive=${expectedCabinetUnitIds.every((id) => !existingUnitIds.has(id))}`);
  const draftBytesBefore = readDiskDraft(draftId);
  const initialCabinetCount = before.json.project.cabinets.length;
  setFaultSequence('draft-unlink', 'draft-quarantine-rename');
  const failedApply = transport === 'HTTP'
    ? await api(`/api/drafts/${encodeURIComponent(draftId)}/apply`, 'POST', body)
    : await mcp('cad.apply_draft', body);
  const afterCommitFailure = await captureRecoveryState(draftId, syncId);
  const logEntries = readFileSync(faultLogPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const unlinkInjected = logEntries.some((entry) => entry.op === 'unlinkSync(draft)-EIO' && entry.path === draftFile);
  const quarantineInjected = logEntries.some((entry) => entry.op === 'renameSync(draft, quarantine)-EIO' && entry.path.startsWith(`${quarantineDir}/`));
  const failureResponseIsExplicit = transport === 'HTTP'
    ? failedApply.status === 500 && failedApply.json?.code === 'APPLY_COMMITTED_CLEANUP_FAILED'
      && failedApply.json?.committed === true && failedApply.json?.retryable === true
      && failedApply.json?.syncId === syncId && failedApply.json?.newVersion === before.json.liveModelVersion + 1
      && receiptMatchesConfirmation(failedApply.json?.receipt, body)
      && same(failedApply.json?.receipt?.project, expectedProject)
      && same(cabinetUnitMap(failedApply.json?.receipt?.project), expectedIdMap)
      && String(failedApply.json?.error).includes('live 与 sync receipt')
    : failedApply.isError && failedApply.payload?.code === 'APPLY_COMMITTED_CLEANUP_FAILED'
      && failedApply.payload?.committed === true && failedApply.payload?.retryable === true
      && failedApply.payload?.syncId === syncId && failedApply.payload?.newVersion === before.json.liveModelVersion + 1
      && receiptMatchesConfirmation(failedApply.payload?.receipt, body)
      && same(failedApply.payload?.receipt?.project, expectedProject)
      && same(cabinetUnitMap(failedApply.payload?.receipt?.project), expectedIdMap)
      && String(failedApply.payload?.message).includes('live 与 sync receipt');
  check(`${transport} unlink 与 quarantine rename 连续 EIO 的响应明确标记已提交且可同 key 重试`, failureResponseIsExplicit,
    transport === 'HTTP' ? `status=${failedApply.status}; code=${failedApply.json?.code}; committed=${failedApply.json?.committed}`
      : `isError=${failedApply.isError}; code=${failedApply.payload?.code}; committed=${failedApply.payload?.committed}`);
  check(`${transport} 故障由真实 unlinkSync 与 quarantine renameSync 注入`, unlinkInjected && quarantineInjected,
    `unlink=${unlinkInjected}; quarantineRename=${quarantineInjected}`);
  check(`${transport} 清理两步失败后内存 live 与磁盘 project/version/receipt 一致且只提交一次`,
    afterCommitFailure.workspace?.liveModelVersion === before.json.liveModelVersion + 1
      && afterCommitFailure.workspace?.project?.cabinets?.length === initialCabinetCount + 1
      && afterCommitFailure.workspace?.project?.cabinets?.filter((cabinet: any) => cabinet.name === cabinetName).length === 1
      && same(afterCommitFailure.workspace.project, afterCommitFailure.diskEnvelope.project)
      && same(afterCommitFailure.workspace.project, expectedProject)
      && same(cabinetUnitMap(afterCommitFailure.workspace.project), expectedIdMap)
      && afterCommitFailure.workspace.liveModelVersion === afterCommitFailure.diskEnvelope.liveModelVersion
      && receiptMatchesConfirmation(afterCommitFailure.receipt, body)
      && afterCommitFailure.receipt.newVersion === afterCommitFailure.workspace.liveModelVersion
      && same(afterCommitFailure.receipt.project, afterCommitFailure.workspace.project)
      && same(afterCommitFailure.receipt.project, expectedProject)
      && afterCommitFailure.receipt.project.cabinets.filter((cabinet: any) => cabinet.name === cabinetName).length === 1,
    `memory/disk=${afterCommitFailure.workspace?.liveModelVersion}/${afterCommitFailure.diskEnvelope.liveModelVersion}; receipt=${afterCommitFailure.receipt?.newVersion}; cabinetId=${expectedCabinet?.id}; unitIds=${expectedCabinetUnitIds.join(',')}; idMapSame=${same(cabinetUnitMap(afterCommitFailure.workspace?.project), expectedIdMap)}`);
  check(`${transport} 清理失败时内存 draft 已退役、磁盘 draft 保留且未进入 quarantine`,
    !((afterCommitFailure.drafts?.drafts ?? []).some((draft: any) => draft.draftId === draftId))
      && afterCommitFailure.draftFileExists && afterCommitFailure.draftFile === draftBytesBefore
      && afterCommitFailure.quarantineFiles.length === 0,
    `memoryListed=${(afterCommitFailure.drafts?.drafts ?? []).some((draft: any) => draft.draftId === draftId)}; diskFile=${afterCommitFailure.draftFileExists}; quarantine=${afterCommitFailure.quarantineFiles.length}`);

  await stopServer();
  await startServer();
  const afterFirstRestart = await captureRecoveryState(draftId, syncId);
  check(`${transport} 首次重启后 /api/workspace 与磁盘一致，柜数/version和receipt保留，旧 draft 被安全清理`,
    afterFirstRestart.workspace?.liveModelVersion === afterCommitFailure.workspace.liveModelVersion
      && same(afterFirstRestart.workspace?.project, afterFirstRestart.diskEnvelope.project)
      && same(afterFirstRestart.workspace?.project, expectedProject)
      && same(afterFirstRestart.receipt?.project, expectedProject)
      && same(cabinetUnitMap(afterFirstRestart.workspace?.project), expectedIdMap)
      && new Set(allProjectUnitIds(afterFirstRestart.workspace?.project)).size === allProjectUnitIds(afterFirstRestart.workspace?.project).length
      && afterFirstRestart.workspace?.project?.cabinets?.length === initialCabinetCount + 1
      && afterFirstRestart.workspace?.project?.cabinets?.filter((cabinet: any) => cabinet.name === cabinetName).length === 1
      && afterFirstRestart.receipt && same(afterFirstRestart.receipt, afterCommitFailure.receipt)
      && !((afterFirstRestart.drafts?.drafts ?? []).some((draft: any) => draft.draftId === draftId))
      && !afterFirstRestart.draftFileExists && afterFirstRestart.quarantineFiles.length === 0,
    `version=${afterFirstRestart.workspace?.liveModelVersion}; cabinets=${afterFirstRestart.workspace?.project?.cabinets?.length}; diskMemSame=${same(afterFirstRestart.workspace?.project, afterFirstRestart.diskEnvelope.project)}; projectSame=${same(afterFirstRestart.workspace?.project, expectedProject)}; receiptProjectSame=${same(afterFirstRestart.receipt?.project, expectedProject)}; cabinetId=${expectedCabinet?.id}; unitIds=${expectedCabinetUnitIds.join(',')}; draftFile=${afterFirstRestart.draftFileExists}; quarantine=${afterFirstRestart.quarantineFiles.length}`);

  const diskBeforeReplay = afterFirstRestart.diskWorkspace;
  const retry = transport === 'HTTP'
    ? await api(`/api/drafts/${encodeURIComponent(draftId)}/apply`, 'POST', body)
    : await mcp('cad.apply_draft', body);
  const afterReplay = await captureRecoveryState(draftId, syncId);
  const replayResponseMatchesReceipt = transport === 'HTTP'
    ? retry.status === 200 && retry.json?.ok === true && retry.json?.syncId === syncId
      && retry.json?.draftId === draftId && retry.json?.runId === body.runId
      && retry.json?.revision === body.revision && retry.json?.draftHash === body.draftHash
      && retry.json?.localVersion === body.localVersion && retry.json?.remoteVersion === body.remoteVersion
      && retry.json?.newVersion === afterReplay.receipt?.newVersion
      && same(retry.json?.project, afterReplay.receipt?.project) && same(retry.json?.project, expectedProject)
    : !retry.isError && retry.payload?.ok === true && retry.payload?.syncId === syncId
      && retry.payload?.draftId === draftId && retry.payload?.newVersion === afterReplay.receipt?.newVersion
      && retry.payload?.runId === body.runId && retry.payload?.revision === body.revision
      && retry.payload?.draftHash === body.draftHash && retry.payload?.localVersion === body.localVersion
      && retry.payload?.remoteVersion === body.remoteVersion && same(retry.payload?.project, afterReplay.receipt?.project)
      && same(retry.payload?.project, expectedProject);
  check(`${transport} 重启后以同一 syncId 和完整元数据成功回放原 receipt（包含所记 localVersion）`,
    replayResponseMatchesReceipt && receiptMatchesConfirmation(afterReplay.receipt, body)
      && afterReplay.receipt.localVersion === localVersion,
    transport === 'HTTP' ? `status=${retry.status}; syncId=${retry.json?.syncId}; localVersion=${retry.json?.localVersion}; newVersion=${retry.json?.newVersion}`
      : `isError=${retry.isError}; syncId=${retry.payload?.syncId}; newVersion=${retry.payload?.newVersion}; receiptLocalVersion=${afterReplay.receipt?.localVersion}; projectSame=${same(retry.payload?.project, expectedProject)}`);
  check(`${transport} 重试只回放不再写 live：内存/磁盘字节、柜数、version 与 receipt 均不变`,
    same(afterReplay.workspace, afterFirstRestart.workspace)
      && afterReplay.diskWorkspace === diskBeforeReplay
      && afterReplay.workspace.liveModelVersion === before.json.liveModelVersion + 1
      && afterReplay.workspace.project.cabinets.length === initialCabinetCount + 1
      && afterReplay.workspace.project.cabinets.filter((cabinet: any) => cabinet.name === cabinetName).length === 1
      && same(afterReplay.receipt, afterFirstRestart.receipt)
      && !afterReplay.draftFileExists && afterReplay.quarantineFiles.length === 0,
    `version=${afterFirstRestart.workspace.liveModelVersion}->${afterReplay.workspace.liveModelVersion}; cabinets=${afterFirstRestart.workspace.project.cabinets.length}->${afterReplay.workspace.project.cabinets.length}`);

  await stopServer();
  await startServer();
  const afterSuccessfulRetryRestart = await captureRecoveryState(draftId, syncId);
  check(`${transport} 成功重试后再次重启：/api/workspace 与磁盘一致、旧 draft/quarantine 不复活、柜数/version 不变`,
    afterSuccessfulRetryRestart.workspace?.liveModelVersion === afterReplay.workspace.liveModelVersion
      && same(afterSuccessfulRetryRestart.workspace?.project, afterReplay.workspace.project)
      && same(afterSuccessfulRetryRestart.workspace?.project, expectedProject)
      && same(afterSuccessfulRetryRestart.receipt?.project, expectedProject)
      && same(cabinetUnitMap(afterSuccessfulRetryRestart.workspace?.project), expectedIdMap)
      && new Set(allProjectUnitIds(afterSuccessfulRetryRestart.workspace?.project)).size === allProjectUnitIds(afterSuccessfulRetryRestart.workspace?.project).length
      && same(afterSuccessfulRetryRestart.workspace?.project, afterSuccessfulRetryRestart.diskEnvelope.project)
      && afterSuccessfulRetryRestart.workspace?.liveModelVersion === afterSuccessfulRetryRestart.diskEnvelope.liveModelVersion
      && same(afterSuccessfulRetryRestart.receipt, afterReplay.receipt)
      && !((afterSuccessfulRetryRestart.drafts?.drafts ?? []).some((draft: any) => draft.draftId === draftId))
      && !afterSuccessfulRetryRestart.draftFileExists && afterSuccessfulRetryRestart.quarantineFiles.length === 0
      && afterSuccessfulRetryRestart.workspace.project.cabinets.length === initialCabinetCount + 1
      && afterSuccessfulRetryRestart.workspace.project.cabinets.filter((cabinet: any) => cabinet.name === cabinetName).length === 1,
    `version=${afterReplay.workspace.liveModelVersion}->${afterSuccessfulRetryRestart.workspace?.liveModelVersion}; cabinets=${afterReplay.workspace.project.cabinets.length}->${afterSuccessfulRetryRestart.workspace?.project?.cabinets?.length}; draftFile=${afterSuccessfulRetryRestart.draftFileExists}`);
}

async function main(): Promise<void> {
  const project = emptyProject({ id: 'mcp-http-fs-failure', name: 'MCP/HTTP FS fault acceptance', ruleSetId: 'factory_default_v1' });
  project.rooms.push(rectRoom({ id: 'room_fs_fault', name: '故障验收房间', x: 0, y: 0, w: 5000, h: 4000 }));
  const envelope = JSON.parse(serializeProjectFile(project)) as Record<string, unknown>;
  Object.assign(envelope, { workspaceId: 'ws_mcp_http_fs_fault', owner: 'local-open', account: 'local-open', liveModelVersion: 0, updatedAt: new Date().toISOString() });
  mkdirSync(dirname(workspacePath), { recursive: true });
  writeFileSync(workspacePath, JSON.stringify(envelope, null, 2), 'utf8');
  writePreload();
  await startServer();
  try {
    section('A. HTTP apply真实write/rename故障：服务端报错、状态完整、同确认可重试');
    const created = await mcp('cad.create_cabinet', { name: 'rename失败重试柜', roomId: 'room_fs_fault', width: 900, height: 2100, depth: 600 });
    const draftId = String(created.payload?.draftId ?? '');
    const draftFile = diskDraftPath(draftId);
    check('MCP创建的draft已持久化', !created.isError && !!draftId && existsSync(draftFile));
    const before = await api('/api/workspace');
    const preview = await api(`/api/drafts/${encodeURIComponent(draftId)}`);
    const body = confirmation(preview.json, 'live-write-rename-retry-v1');
    const diskBefore = readFileSync(workspacePath, 'utf8');
    const draftBefore = readDiskDraft(draftId);
    setFault('live-write');
    const failedWrite = await api(`/api/drafts/${encodeURIComponent(draftId)}/apply`, 'POST', body);
    const afterWrite = await api('/api/workspace');
    check('真实 workspace 临时write EIO经HTTP明确返回错误', failedWrite.status === 500 && String(failedWrite.json?.error).includes('writeFileSync(temp)'),
      `status=${failedWrite.status}; error=${failedWrite.json?.error}`);
    check('提交前write失败后HTTP内存/磁盘/version/draft/receipt均零变化', afterWrite.status === 200
      && same(afterWrite.json, before.json) && readFileSync(workspacePath, 'utf8') === diskBefore
      && readDiskDraft(draftId) === draftBefore && same(JSON.parse(readFileSync(workspacePath, 'utf8')).draftSyncReceipts ?? {}, {}),
    `version=${afterWrite.json?.liveModelVersion}; draft=${existsSync(draftFile)}`);

    setFault('live-rename');
    const failedRename = await api(`/api/drafts/${encodeURIComponent(draftId)}/apply`, 'POST', body);
    const afterRename = await api('/api/workspace');
    check('真实 workspace 临时rename EIO经HTTP明确返回错误', failedRename.status === 500 && String(failedRename.json?.error).includes('renameSync(temp, workspace)'),
      `status=${failedRename.status}; error=${failedRename.json?.error}`);
    check('提交前rename失败后HTTP内存/磁盘/version/draft/receipt均零变化', afterRename.status === 200
      && same(afterRename.json, before.json) && readFileSync(workspacePath, 'utf8') === diskBefore
      && readDiskDraft(draftId) === draftBefore && same(JSON.parse(readFileSync(workspacePath, 'utf8')).draftSyncReceipts ?? {}, {}),
    `version=${afterRename.json?.liveModelVersion}; draft=${existsSync(draftFile)}`);
    const retried = await api(`/api/drafts/${encodeURIComponent(draftId)}/apply`, 'POST', body);
    check('同一完整确认在write/rename失败后重试成功且只应用一次', retried.status === 200
      && retried.json?.newVersion === before.json.liveModelVersion + 1
      && !existsSync(draftFile), `status=${retried.status}; version=${retried.json?.newVersion}`);

    section('B. MCP draft create/edit真实保存失败：客户端错误且不发布内存脏写');
    const listBeforeCreateFailure = await api('/api/drafts');
    const diskFilesBefore = readdirSync(draftsDir).filter((name) => name.endsWith('.json')).sort();
    setFault('draft-write');
    const failedCreate = await mcp('cad.create_cabinet', { name: '保存失败不应出现的柜', roomId: 'room_fs_fault', width: 800, height: 2100, depth: 600 });
    const listAfterCreateFailure = await api('/api/drafts');
    const diskFilesAfter = readdirSync(draftsDir).filter((name) => name.endsWith('.json')).sort();
    check('createDraft写失败向MCP客户端报错，内存列表/磁盘文件均无新增', failedCreate.isError
      && same((listAfterCreateFailure.json?.drafts ?? []).map((d: any) => d.draftId).sort(), (listBeforeCreateFailure.json?.drafts ?? []).map((d: any) => d.draftId).sort())
      && same(diskFilesAfter, diskFilesBefore), `error=${JSON.stringify(failedCreate.payload)?.slice(0, 180)}`);

    const editable = await mcp('cad.create_cabinet', { name: '编辑保存故障柜', roomId: 'room_fs_fault', width: 850, height: 2100, depth: 600 });
    const editableId = String(editable.payload?.draftId ?? '');
    const cabinetId = String(editable.payload?.cabinetId ?? '');
    const editPreviewBefore = await api(`/api/drafts/${encodeURIComponent(editableId)}`);
    const editDiskBefore = readDiskDraft(editableId);
    setFault('draft-write');
    const failedEdit = await mcp('cad.update_object', { targetId: cabinetId, targetType: 'cabinet', field: 'width', value: 950, draftId: editableId });
    const editPreviewAfter = await api(`/api/drafts/${encodeURIComponent(editableId)}`);
    check('draftExecute保存失败向MCP客户端报错，内存project/revision/hash和磁盘字节均不变', failedEdit.isError
      && same(editPreviewAfter.json?.project, editPreviewBefore.json?.project)
      && editPreviewAfter.json?.revision === editPreviewBefore.json?.revision
      && editPreviewAfter.json?.draftHash === editPreviewBefore.json?.draftHash
      && readDiskDraft(editableId) === editDiskBefore,
    `code=${failedEdit.payload?.code}; revision=${editPreviewBefore.json?.revision}->${editPreviewAfter.json?.revision}`);
    const editRetry = await mcp('cad.update_object', { targetId: cabinetId, targetType: 'cabinet', field: 'width', value: 950, draftId: editableId });
    check('draft保存失败后的相同编辑请求可重试并提交', !editRetry.isError
      && (await api(`/api/drafts/${encodeURIComponent(editableId)}`)).json?.revision > editPreviewBefore.json?.revision
      && (await api(`/api/drafts/${encodeURIComponent(editableId)}`)).json?.draftHash !== editPreviewBefore.json?.draftHash);

    section('C. HTTP discard unlink失败：客户端明确收到错误、草稿保留并可重试');
    const discardFile = diskDraftPath(editableId);
    const discardDiskBefore = readFileSync(discardFile, 'utf8');
    setFault('draft-unlink');
    const failedDiscard = await api(`/api/drafts/${encodeURIComponent(editableId)}/discard`, 'POST', {});
    check('unlinkSync EIO经HTTP明确返回错误，草稿内存与磁盘仍保留', failedDiscard.status === 500
      && String(failedDiscard.json?.error).includes('unlinkSync(draft)')
      && (await api(`/api/drafts/${encodeURIComponent(editableId)}`)).status === 200
      && existsSync(discardFile) && readFileSync(discardFile, 'utf8') === discardDiskBefore,
    `status=${failedDiscard.status}; error=${failedDiscard.json?.error}`);
    const retriedDiscard = await api(`/api/drafts/${encodeURIComponent(editableId)}/discard`, 'POST', {});
    check('unlink失败后的discard重试成功并删除文件', retriedDiscard.status === 200
      && retriedDiscard.json?.ok === true && !existsSync(discardFile));
    await stopServer();
    await startServer();
    const afterRestartDrafts = await api('/api/drafts');
    check('discard成功后服务重启不复活旧draft', afterRestartDrafts.status === 200
      && !(afterRestartDrafts.json?.drafts ?? []).some((draft: any) => draft.draftId === editableId));

    section('D. HTTP 与 MCP 六个确认字段逐项缺失/伪造值负例');
    const negativeDraft = await mcp('cad.create_cabinet', { name: '确认字段负例草稿', roomId: 'room_fs_fault', width: 810, height: 2000, depth: 580 });
    const negativeDraftId = String(negativeDraft.payload?.draftId ?? '');
    const negativePreview = await api(`/api/drafts/${encodeURIComponent(negativeDraftId)}`);
    const negativeBase = confirmation(negativePreview.json, 'negative-confirmation-never-committed', 0);
    const fields = ['runId', 'draftId', 'revision', 'draftHash', 'localVersion', 'remoteVersion'] as const;
    const staleValue: Record<(typeof fields)[number], unknown> = {
      runId: `${negativeBase.runId}-forged`,
      draftId: `${negativeDraftId}-forged`,
      revision: Number(negativeBase.revision) + 1,
      draftHash: negativeBase.draftHash === 'f'.repeat(64) ? '0'.repeat(64) : 'f'.repeat(64),
      // localVersion 没有服务端镜像：这里只验证缺失/非法负值会被拒绝，不把它表述成服务端 freshness 校验。
      localVersion: -1,
      remoteVersion: Number(negativeBase.remoteVersion) + 1,
    };
    for (const transport of ['HTTP', 'MCP'] as const) {
      for (const field of fields) {
        const beforeNegative = await captureConfirmationState(negativeDraftId);
        const body = { ...negativeBase };
        delete body[field];
        const result = await applyNegative(transport, negativeDraftId, body, 'required', field);
        const afterNegative = await captureConfirmationState(negativeDraftId);
        check(`${transport} 缺失 ${field} 明确拒绝`, result.rejected, result.detail);
        check(`${transport} 缺失 ${field} 后 live/version/内存与磁盘 draft/receipt 零变化`, same(afterNegative, beforeNegative),
          `live=${afterNegative.workspace?.liveModelVersion}; receiptCount=${Object.keys(afterNegative.receipts).length}`);
      }
      for (const field of fields) {
        const beforeNegative = await captureConfirmationState(negativeDraftId);
        const body = { ...negativeBase, [field]: staleValue[field] };
        const expectation = field === 'localVersion' ? 'invalid'
          : field === 'draftId' ? 'missing-draft' : 'stale';
        const result = await applyNegative(transport, negativeDraftId, body, expectation, field);
        const afterNegative = await captureConfirmationState(negativeDraftId);
        check(`${transport} 伪造/陈旧 ${field} 值明确拒绝`, result.rejected, result.detail);
        check(`${transport} 伪造/陈旧 ${field} 后 live/version/内存与磁盘 draft/receipt 零变化`, same(afterNegative, beforeNegative),
          `live=${afterNegative.workspace?.liveModelVersion}; receiptCount=${Object.keys(afterNegative.receipts).length}`);
      }
    }
    const discardedNegative = await api(`/api/drafts/${encodeURIComponent(negativeDraftId)}/discard`, 'POST', {});
    check('确认字段负例结束后清理未应用的测试草稿', discardedNegative.status === 200 && !existsSync(diskDraftPath(negativeDraftId)));

    section('E. live+receipt 已持久提交后 unlink 与 quarantine 连续 EIO：HTTP/MCP 重启回放');
    await verifyPostCommitCleanupRecovery('HTTP', 'HTTP post-commit recovery cabinet', 'post-commit-http-sync-v1', 41);
    await verifyPostCommitCleanupRecovery('MCP', 'MCP post-commit recovery cabinet', 'post-commit-mcp-sync-v1', 42);

    const operations = readFileSync(faultLogPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    check('故障日志证明覆盖真实 workspace write/rename、draft-save、删除及双重 quarantine 清理故障',
      operations.some((entry) => entry.op === 'writeFileSync(temp)-EIO')
      && operations.some((entry) => entry.op === 'renameSync(temp, workspace)-EIO')
      && operations.some((entry) => entry.op === 'writeFileSync(draft-temp)-EIO')
      && operations.some((entry) => entry.op === 'unlinkSync(draft)-EIO')
      && operations.some((entry) => entry.op === 'renameSync(draft, quarantine)-EIO'),
    `write=${operations.filter((entry) => entry.op === 'writeFileSync(temp)-EIO').length}; rename=${operations.filter((entry) => entry.op === 'renameSync(temp, workspace)-EIO').length}; draftSave=${operations.filter((entry) => entry.op === 'writeFileSync(draft-temp)-EIO').length}; unlink=${operations.filter((entry) => entry.op === 'unlinkSync(draft)-EIO').length}; quarantine=${operations.filter((entry) => entry.op === 'renameSync(draft, quarantine)-EIO').length}`);
    console.log(`\nMCP/HTTP filesystem failure acceptance: ${pass} passed, ${fail} failed`);
    if (fail > 0) throw new Error(`验收失败：${fail} 项（${failures.join('；')}）`);
  } finally {
    await stopServer();
    try { rmSync(temp, { recursive: true, force: true }); } catch { /* cleanup */ }
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
