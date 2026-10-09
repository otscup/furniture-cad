import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyProject, createCabinet, rectRoom } from '../src/core/docFactory.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { addAssemblyMember, confirmAssembly } from '../src/core/commands.ts';
import { assemblyConfirmationStatus, isAssemblyConfirmed } from '../src/core/assemblyConfirmation.ts';
import { parseProjectFile, serializeProjectFile } from '../src/core/projectFile.ts';
import { allUnits } from '../src/core/layoutModel.ts';
import { WorkspaceStore } from '../src/workspace/workspace.ts';
import { hashProjectSnapshot } from '../server/projectHash.mjs';
import type { Project, RuleSet } from '../src/core/types.ts';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(readFileSync(join(appRoot, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const tempRoot = mkdtempSync(join(tmpdir(), 'furnicad-draft-assembly-generation-'));
let pass = 0;
let fail = 0;
const failures: string[] = [];
let child: ChildProcess | null = null;
let childOutput = '';
let port = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
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
async function startServer(workspacePath: string, transportDir: string): Promise<void> {
  port = await allocatePort();
  childOutput = '';
  child = spawn(process.execPath, [join(appRoot, 'server/server.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_WORKSPACE_PATH: workspacePath,
      APP_ACCOUNTS_PATH: join(transportDir, 'accounts.json'),
      APP_AUDIT_PATH: join(transportDir, 'audit.jsonl'),
      APP_MEM_PATH: join(transportDir, 'corrections.jsonl'),
      APP_ENV_PATH: join(transportDir, '.env'),
      APP_REGISTRATIONS_PATH: join(transportDir, 'registrations.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => { childOutput += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { childOutput += chunk.toString(); });
  for (let i = 0; i < 150; i++) {
    await wait(100);
    if (child.exitCode !== null || child.signalCode !== null) break;
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return; } catch { /* wait for listener */ }
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
async function api(path: string, method = 'GET', body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* retain raw response */ }
  return { status: response.status, json, text };
}
async function mcp(name: string, args: Record<string, unknown>): Promise<{ status: number; isError: boolean; payload: any; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  const json = JSON.parse(text);
  const content = json?.result?.content?.[0]?.text;
  let payload: any = null;
  try { payload = JSON.parse(content ?? '{}'); } catch { payload = { raw: content }; }
  return { status: response.status, isError: json?.result?.isError === true || !!json?.error, payload, json };
}
function makeProject(): Project {
  const room = rectRoom({ id: 'room_relgen_fixture', name: 'relationGeneration 验收房间', x: 0, y: 0, w: 6000, h: 4000, thickness: 120, height: 2700 });
  const project = emptyProject({ id: 'project_relgen_fixture', name: 'draft relationGeneration acceptance', ruleSetId: rules.id });
  project.rooms = [room];
  project.cabinets = [
    createCabinet({ id: 'cab_relgen_a', name: '成员柜 A', roomId: room.id, x: 200, y: 200, rules, params: { width: 800, height: 850, depth: 600 } }),
    createCabinet({ id: 'cab_relgen_b', name: '成员柜 B', roomId: room.id, x: 1000, y: 200, rules, params: { width: 800, height: 850, depth: 600 } }),
    createCabinet({ id: 'cab_relgen_c', name: '待加入柜 C', roomId: room.id, x: 1800, y: 200, rules, params: { width: 800, height: 850, depth: 600 } }),
  ];
  for (const cabinet of project.cabinets) {
    allUnits(cabinet.layout).forEach((unit, index) => { unit.id = `unit_${cabinet.id}_${index + 1}`; });
    cabinet.layout.backUnits?.forEach((unit, index) => { unit.id = `back_${cabinet.id}_${index + 1}`; });
  }
  project.assemblies = [{ id: 'asm_relgen_fixture', name: '已确认组', roomId: room.id, memberIds: ['cab_relgen_a', 'cab_relgen_b'], connections: [] }];
  const bus = new CommandBus(project, rules);
  const confirmed = bus.execute(confirmAssembly('asm_relgen_fixture', '已确认组', 'ui'));
  if (!confirmed.ok) throw new Error(`fixture assembly confirmation failed: ${confirmed.error}`);
  return bus.getState();
}
function seedTransport(transport: 'HTTP' | 'MCP') {
  const transportDir = join(tempRoot, transport.toLowerCase());
  const workspacePath = join(transportDir, 'workspaces', 'local-open', 'workspace.json');
  const draftsDir = join(dirname(workspacePath), 'drafts');
  mkdirSync(draftsDir, { recursive: true });
  const workspaceId = `ws_relgen_${transport.toLowerCase()}`;
  const draftId = `draft_relgen_${transport.toLowerCase()}`;
  const syncId = `sync_relgen_${transport.toLowerCase()}_v1`;
  const parsedLive = parseProjectFile(serializeProjectFile(makeProject()));
  if (!parsedLive.ok) throw new Error(`fixture project round-trip failed: ${parsedLive.error}`);
  const liveProject = parsedLive.project;
  const liveAssembly = liveProject.assemblies![0]!;
  const candidateBus = new CommandBus(liveProject, rules);
  const added = candidateBus.execute(addAssemblyMember(liveAssembly.id, liveAssembly.name, 'cab_relgen_c', '待加入柜 C', 'mcp'));
  if (!added.ok) throw new Error(`fixture draft addAssemblyMember failed: ${added.error}`);
  const candidateProject = candidateBus.getState();
  const envelope = JSON.parse(serializeProjectFile(liveProject)) as Record<string, any>;
  Object.assign(envelope, { workspaceId, owner: 'local-open', account: 'local-open', liveModelVersion: 0, updatedAt: new Date().toISOString() });
  writeFileSync(workspacePath, JSON.stringify(envelope, null, 2), 'utf8');
  const draft = {
    format: 'furniture-cad-draft', formatVersion: 2, draftId, runId: `run_${draftId}`, revision: 1,
    workspaceId, baseModelVersion: 0, baseProjectHash: hashProjectSnapshot(liveProject), owner: 'local-open',
    createdAt: new Date().toISOString(), project: candidateProject,
  };
  writeFileSync(join(draftsDir, `${draftId}.json`), JSON.stringify(draft, null, 2), 'utf8');
  return { transportDir, workspacePath, draftsDir, draftId, syncId, liveProject, candidateProject };
}
function relation(project: Project): { generation: number | undefined; status: string; confirmed: boolean | undefined } {
  const assembly = project.assemblies?.find((item) => item.id === 'asm_relgen_fixture');
  if (!assembly) throw new Error('fixture assembly missing from project');
  return { generation: assembly.relationGeneration, status: assemblyConfirmationStatus(assembly), confirmed: assembly.confirmed };
}
function confirmation(preview: any, syncId: string): Record<string, unknown> {
  return {
    syncId, runId: preview.runId, draftId: preview.draftId, revision: preview.revision,
    draftHash: preview.draftHash, localVersion: 0, remoteVersion: preview.liveModelVersion,
    baseModelVersion: preview.baseModelVersion, baseProjectHash: preview.baseProjectHash,
  };
}
async function capture(workspacePath: string, draftId: string, syncId: string): Promise<any> {
  const workspace = await api('/api/workspace');
  const diskWorkspace = readFileSync(workspacePath, 'utf8');
  const diskEnvelope = JSON.parse(diskWorkspace);
  return {
    workspace: workspace.json,
    diskWorkspace,
    diskEnvelope,
    receipt: diskEnvelope.draftSyncReceipts?.[syncId] ?? null,
    diskDraftExists: existsSync(join(dirname(workspacePath), 'drafts', `${draftId}.json`)),
  };
}
async function applyThrough(transport: 'HTTP' | 'MCP', draftId: string, body: Record<string, unknown>): Promise<{ ok: boolean; project: Project | null; payload: any; detail: string }> {
  if (transport === 'HTTP') {
    const response = await api(`/api/drafts/${encodeURIComponent(draftId)}/apply`, 'POST', body);
    return { ok: response.status === 200 && response.json?.ok === true, project: response.json?.project ?? null, payload: response.json, detail: `HTTP ${response.status} ${response.json?.code ?? ''}` };
  }
  const response = await mcp('cad.apply_draft', body);
  return { ok: !response.isError && response.payload?.ok === true, project: response.payload?.project ?? null, payload: response.payload, detail: `MCP error=${response.isError} code=${response.payload?.code ?? ''}` };
}
async function verifyTransport(transport: 'HTTP' | 'MCP'): Promise<void> {
  const fixture = seedTransport(transport);
  const initialRelation = relation(fixture.liveProject);
  const editedRelation = relation(fixture.candidateProject);
  check(`${transport} 唯一 fixture 从 confirmed gen0 产生 addMember draft gen1 stale`,
    initialRelation.generation === 0 && initialRelation.status === 'confirmed' && isAssemblyConfirmed(fixture.liveProject.assemblies![0]!)
      && editedRelation.generation === 1 && editedRelation.status === 'stale' && editedRelation.confirmed === false,
    `live=${JSON.stringify(initialRelation)}; draft=${JSON.stringify(editedRelation)}`);
  await startServer(fixture.workspacePath, fixture.transportDir);
  try {
    const preview = await api(`/api/drafts/${encodeURIComponent(fixture.draftId)}`);
    const body = confirmation(preview.json, fixture.syncId);
    const firstApply = await applyThrough(transport, fixture.draftId, body);
    const afterApply = await capture(fixture.workspacePath, fixture.draftId, fixture.syncId);
    if (!afterApply.receipt?.project) {
      throw new Error(`${transport} fixture apply failed: preview=${JSON.stringify(preview.json)}; apply=${JSON.stringify(firstApply.payload)}; live=${JSON.stringify(afterApply.workspace)}`);
    }
    const expectedRelation = relation(afterApply.receipt?.project);
    const applyHash = firstApply.project ? hashProjectSnapshot(firstApply.project) : '';
    const receiptHash = afterApply.receipt?.project ? hashProjectSnapshot(afterApply.receipt.project) : '';
    check(`${transport} apply 将 draft gen1 reconcile 为最终 gen2 stale，响应与 receipt 项目 hash 相同`,
      firstApply.ok && expectedRelation.generation === 2 && expectedRelation.status === 'stale' && expectedRelation.confirmed === false
        && applyHash !== '' && applyHash === receiptHash && same(firstApply.project, afterApply.receipt?.project),
      `${firstApply.detail}; relation=${JSON.stringify(expectedRelation)}; applyHash=${applyHash}; receiptHash=${receiptHash}`);
    const liveProject = afterApply.workspace?.project as Project | undefined;
    const diskProject = afterApply.diskEnvelope.project as Project | undefined;
    check(`${transport} apply 响应/receipt/live GET/磁盘均为同一规范化 Project 与 relation 状态`,
      !!liveProject && !!diskProject && same(firstApply.project, afterApply.receipt?.project)
        && same(firstApply.project, liveProject) && same(firstApply.project, diskProject)
        && hashProjectSnapshot(liveProject) === applyHash && hashProjectSnapshot(diskProject) === applyHash
        && relation(liveProject).generation === 2 && relation(diskProject).generation === 2
        && afterApply.workspace.liveModelVersion === 1 && afterApply.diskEnvelope.liveModelVersion === 1
        && afterApply.receipt?.newVersion === 1 && afterApply.diskDraftExists === false,
      `live/disk/receipt versions=${afterApply.workspace?.liveModelVersion}/${afterApply.diskEnvelope.liveModelVersion}/${afterApply.receipt?.newVersion}; hashes=${hashProjectSnapshot(liveProject ?? fixture.liveProject)}/${hashProjectSnapshot(diskProject ?? fixture.liveProject)}/${receiptHash}`);
    const diskBeforeRestart = afterApply.diskWorkspace;
    await stopServer();
    await startServer(fixture.workspacePath, fixture.transportDir);
    const afterRestart = await capture(fixture.workspacePath, fixture.draftId, fixture.syncId);
    const restartedRelation = relation(afterRestart.workspace.project as Project);
    check(`${transport} 重启 GET 回读与磁盘/receipt 保持 gen2 stale 和原 project hash`,
      same(afterRestart.workspace.project, afterRestart.diskEnvelope.project)
        && same(afterRestart.workspace.project, afterRestart.receipt?.project)
        && hashProjectSnapshot(afterRestart.workspace.project) === applyHash
        && restartedRelation.generation === 2 && restartedRelation.status === 'stale'
        && afterRestart.workspace.liveModelVersion === 1 && afterRestart.diskEnvelope.liveModelVersion === 1
        && afterRestart.diskWorkspace === diskBeforeRestart && !afterRestart.diskDraftExists,
      `relation=${JSON.stringify(restartedRelation)}; hash=${hashProjectSnapshot(afterRestart.workspace.project)}; diskUnchanged=${afterRestart.diskWorkspace === diskBeforeRestart}`);
    const replay = await applyThrough(transport, fixture.draftId, body);
    const afterReplay = await capture(fixture.workspacePath, fixture.draftId, fixture.syncId);
    check(`${transport} 重启后同 syncId replay 返回同一 gen2 stale receipt，不重复写磁盘或推进版本`,
      replay.ok && same(replay.payload, firstApply.payload)
        && same(afterReplay.receipt, afterRestart.receipt)
        && same(afterReplay.workspace, afterRestart.workspace)
        && afterReplay.diskWorkspace === afterRestart.diskWorkspace
        && hashProjectSnapshot(replay.project ?? fixture.liveProject) === applyHash
        && relation(replay.project ?? fixture.liveProject).generation === 2,
      `replay=${replay.detail}; version=${afterRestart.workspace.liveModelVersion}->${afterReplay.workspace.liveModelVersion}; diskUnchanged=${afterReplay.diskWorkspace === afterRestart.diskWorkspace}; hash=${hashProjectSnapshot(replay.project ?? fixture.liveProject)}`);
  } finally {
    await stopServer();
  }
}
async function verifyFailedPersistDoesNotAdvanceLedger(): Promise<void> {
  const workspacePath = join(tempRoot, 'ledger-failure', 'workspace.json');
  mkdirSync(dirname(workspacePath), { recursive: true });
  const parsedLive = parseProjectFile(serializeProjectFile(makeProject()));
  if (!parsedLive.ok) throw new Error(`failure fixture project round-trip failed: ${parsedLive.error}`);
  const liveProject = parsedLive.project;
  let rejectNextPersist = false;
  const persist = async (content: string) => {
    if (rejectNextPersist) {
      rejectNextPersist = false;
      throw Object.assign(new Error('injected atomic workspace persistence failure'), { code: 'EIO' });
    }
    writeFileSync(workspacePath, content, 'utf8');
  };
  const store = WorkspaceStore.create({ filePath: workspacePath, rules, persist, project: liveProject, projectHash: hashProjectSnapshot });
  await store.save();
  const draft = await store.createDraft('acceptance');
  const edit = await store.draftExecute(draft.draftId, addAssemblyMember('asm_relgen_fixture', '已确认组', 'cab_relgen_c', '待加入柜 C', 'mcp'));
  const freshness = store.getDraftFreshness(draft.draftId)!;
  const request = {
    syncId: 'sync_relgen_failed_persist_then_retry', draftId: draft.draftId, runId: freshness.runId,
    revision: freshness.revision, draftHash: freshness.draftHash, localVersion: 0,
    remoteVersion: freshness.liveModelVersion, baseModelVersion: freshness.baseModelVersion,
    baseProjectHash: freshness.baseProjectHash,
  };
  const projectBefore = store.getState();
  const versionBefore = store.getLiveModelVersion();
  const diskBefore = readFileSync(workspacePath, 'utf8');
  rejectNextPersist = true;
  let rejected = false;
  try { await store.applyDraft(draft.draftId, request); } catch { rejected = true; }
  const diskAfterFailure = readFileSync(workspacePath, 'utf8');
  check('写盘失败时 Project/version/disk/receipt/draft 保持原值，且操作确实到达持久化阶段',
    edit.ok && rejected && same(store.getState(), projectBefore) && store.getLiveModelVersion() === versionBefore
      && diskAfterFailure === diskBefore && !!store.getDraft(draft.draftId)
      && !JSON.parse(diskAfterFailure).draftSyncReceipts?.[request.syncId],
    `edit=${edit.ok}; rejected=${rejected}; version=${versionBefore}->${store.getLiveModelVersion()}; draft=${!!store.getDraft(draft.draftId)}`);
  const retry = await store.applyDraft(draft.draftId, request);
  const diskEnvelope = JSON.parse(readFileSync(workspacePath, 'utf8'));
  const retryRelation = relation(retry.project);
  check('写盘失败未提前改 live relation ledger：同确认重试恰为 gen2 stale（不是 gen3）',
    retry.ok && retry.newVersion === versionBefore + 1 && retryRelation.generation === 2
      && retryRelation.status === 'stale' && same(retry.project, store.getState())
      && same(retry.project, diskEnvelope.project)
      && same(retry.project, diskEnvelope.draftSyncReceipts?.[request.syncId]?.project),
    `version=${versionBefore}->${retry.newVersion}; relation=${JSON.stringify(retryRelation)}; hashes=${hashProjectSnapshot(retry.project)}/${hashProjectSnapshot(diskEnvelope.project)}`);
}

async function main(): Promise<void> {
  console.log('\nA. 原子 relation reconcile：HTTP 与 MCP apply 共用 WorkspaceStore 路径');
  await verifyTransport('HTTP');
  await verifyTransport('MCP');
  console.log('\nB. 持久化失败时 Project/version/receipt/draft/关系代次账本不变');
  await verifyFailedPersistDoesNotAdvanceLedger();
  console.log(`\nDraft assembly relationGeneration acceptance: ${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`验收失败：${fail} 项（${failures.join('；')}）`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  await stopServer();
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});
