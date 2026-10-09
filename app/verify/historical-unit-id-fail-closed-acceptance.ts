import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { replaceDrawingEdits } from '../src/core/drawingEdits.ts';
import { parseProjectFile, serializeProjectFile } from '../src/core/projectFile.ts';
import { findDuplicateUnitIds, WORKSPACE_UNIT_ID_CONFLICT, WorkspaceStore, type DraftSyncReceipt } from '../src/workspace/workspace.ts';
import { hashProjectSnapshot } from '../server/projectHash.mjs';

const APP = join(import.meta.dirname, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const TMP = mkdtempSync(join(tmpdir(), 'historical-unit-id-guard-'));
let pass = 0;
let fail = 0;
const failures: string[] = [];
const children: ChildProcess[] = [];
const serverLogs = new Map<ChildProcess, string>();

function check(name: string, condition: unknown, detail = ''): void {
  if (condition === true) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stable(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
const same = (a: unknown, b: unknown) => stable(a) === stable(b);
function buildProject(): Project {
  const project = emptyProject({ id: 'historical-unit-id-guard', name: 'Unit ID Guard QA', ruleSetId: rules.id });
  project.rooms.push(rectRoom({ id: 'room_qa', name: '验收厨房', x: 0, y: 0, w: 5000, h: 4000, thickness: 120, height: 2700 }));
  const first = createCabinet({ id: 'cab_qa_1', name: '左柜', roomId: 'room_qa', x: 100, y: 100, rules, params: { width: 800, height: 2100, depth: 600 } });
  const second = createCabinet({ id: 'cab_qa_2', name: '右柜', roomId: 'room_qa', x: 1000, y: 100, rules, params: { width: 900, height: 2100, depth: 600 } });
  const allIds = new Set<string>();
  for (const [cabIndex, cabinet] of [first, second].entries()) {
    const assign = (units: Array<{ id: string }>, row: string) => units.forEach((unit, index) => {
      let id = `unit_qa_${cabIndex + 1}_${row}_${index + 1}`;
      while (allIds.has(id)) id += '_x';
      unit.id = id;
      allIds.add(id);
    });
    if (cabinet.layout.rows?.length) {
      cabinet.layout.rows.forEach((row, index) => assign(row.units, `r${index + 1}`));
      cabinet.layout.units = structuredClone(cabinet.layout.rows[0]!.units);
    } else assign(cabinet.layout.units, 'r1');
    if (cabinet.layout.backUnits) assign(cabinet.layout.backUnits, 'back');
  }
  project.cabinets.push(first, second);
  return project;
}
function setWidthCmd(cabinetId: string, width: number): Command {
  return { op: 'cabinet.update', source: 'system', target: { kind: 'cabinet', id: cabinetId }, changes: [{ path: 'params.width', op: 'set', value: width, unit: 'mm' }] } as Command;
}
function duplicateFixtureProject(name: string, width: number, reference: string): Project {
  const project = buildProject();
  project.name = name;
  project.cabinets[0]!.layout.units[0]!.id = 'unit_001';
  project.cabinets[1]!.layout.backUnits = [structuredClone(project.cabinets[1]!.layout.units[0]!)];
  project.cabinets[1]!.layout.backUnits[0]!.id = 'unit_001';
  project.cabinets[1]!.layout.type = 'double';
  project.cabinets[0]!.params.width = width;
  (project as unknown as Record<string, unknown>).drawingEdits = [{
    id: `edit_${reference}`, space: 'sheet', kind: 'line', cabinetId: 'cab_qa_1', view: 'top',
    points: [{ x: 1, y: 2 }, { x: 3, y: 4 }], replacesSource: reference,
  }];
  (project as unknown as Record<string, unknown>).sharedPanels = [{
    id: `shared_${reference}`, memberCabinetIds: ['cab_qa_1', 'cab_qa_2'], replacesPanelIds: [`P_${reference}`],
  }];
  return project;
}
function receipt(syncId: string, project: Project, newVersion: number): DraftSyncReceipt {
  return {
    syncId, draftId: `draft_${syncId}`, runId: `run_${syncId}`, revision: newVersion,
    hash: `hash_${syncId}`, localVersion: newVersion, remoteVersion: newVersion - 1,
    baseModelVersion: newVersion - 1, baseProjectHash: `base_${syncId}`, workspaceId: 'historical-workspace',
    newVersion, project,
  };
}
function envelope(project: Project, receipts: Record<string, DraftSyncReceipt> = {}, version = 9): Record<string, unknown> {
  const out = JSON.parse(serializeProjectFile(project, '2025-01-01T00:00:00.000Z')) as Record<string, unknown>;
  out.workspaceId = 'historical-workspace';
  out.owner = 'local-open';
  out.account = 'local-open';
  out.liveModelVersion = version;
  out.updatedAt = '2025-01-01T00:00:00.000Z';
  if (Object.keys(receipts).length) out.draftSyncReceipts = receipts;
  return out;
}
function unitOnlyWorkspaceFiles(workspaceDir: string, workspacePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string, rel = '') => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const key = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) visit(path, key);
      else result[key] = readFileSync(path).toString('base64');
    }
  };
  visit(workspaceDir);
  if (result['workspace.json'] !== readFileSync(workspacePath).toString('base64')) throw new Error('workspace file path 与被监视目录不一致');
  return result;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('无法读取临时端口')));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}
interface ServerFixture { port: number; dir: string; workspaceDir: string; workspacePath: string; draftsDir: string; exportTmp: string; initialFiles: Record<string, string>; child: ChildProcess }
async function startServer(dir: string, workspaceProject: Project, receipts: Record<string, DraftSyncReceipt> = {}, version = 9, seedDraft = true): Promise<ServerFixture> {
  const workspaceDir = join(dir, 'workspaces', 'local-open');
  const draftsDir = join(workspaceDir, 'drafts');
  const exportTmp = join(dir, 'export-tmp');
  mkdirSync(draftsDir, { recursive: true });
  mkdirSync(exportTmp, { recursive: true });
  const workspacePath = join(workspaceDir, 'workspace.json');
  writeFileSync(workspacePath, `${JSON.stringify(envelope(workspaceProject, receipts, version), null, 2)}\n`, 'utf8');
  if (seedDraft) {
    const draftProject = buildProject();
    draftProject.name = '历史 workspace 中保留的正常 draft';
    const normalizedLive = parseProjectFile(serializeProjectFile(workspaceProject), { allowDuplicateUnitIds: true });
    if (!normalizedLive.ok) throw new Error(`无法构造 server draft baseline：${normalizedLive.error}`);
    const draft = {
      format: 'furniture-cad-draft', formatVersion: 2, draftId: 'legacy_draft', runId: 'legacy_run', revision: 1,
      workspaceId: 'historical-workspace', baseModelVersion: version, baseProjectHash: hashProjectSnapshot(normalizedLive.project),
      owner: 'local-open', createdAt: '2025-01-02T00:00:00.000Z', project: draftProject,
    };
    writeFileSync(join(draftsDir, 'legacy_draft.json'), `${JSON.stringify(draft, null, 2)}\n`, 'utf8');
    const duplicateDraft = {
      format: 'furniture-cad-draft', formatVersion: 2, draftId: 'legacy_duplicate_draft', runId: 'legacy_duplicate_run', revision: 2,
      workspaceId: 'historical-workspace', baseModelVersion: version, baseProjectHash: hashProjectSnapshot(normalizedLive.project),
      owner: 'local-open', createdAt: '2025-01-02T00:00:00.000Z',
      project: duplicateFixtureProject('持久历史重复ID draft', 850, 'source_duplicate_draft'),
    };
    writeFileSync(join(draftsDir, 'legacy_duplicate_draft.json'), `${JSON.stringify(duplicateDraft, null, 2)}\n`, 'utf8');
  }
  const initialFiles = unitOnlyWorkspaceFiles(workspaceDir, workspacePath);
  const port = await allocatePort();
  const child = spawn(process.execPath, [join(APP, 'server/server.mjs')], {
    cwd: APP,
    env: {
      ...process.env,
      PORT: String(port), APP_HOST: '127.0.0.1',
      APP_ACCOUNTS_PATH: join(dir, 'accounts.json'), APP_AUDIT_PATH: join(dir, 'audit.jsonl'),
      APP_WORKSPACE_PATH: join(dir, 'unused-base-workspace.json'), APP_MEM_PATH: join(dir, 'mem.jsonl'), TMPDIR: exportTmp,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  serverLogs.set(child, '');
  child.stdout?.on('data', (chunk: Buffer) => { log += chunk.toString(); serverLogs.set(child, log); });
  child.stderr?.on('data', (chunk: Buffer) => { log += chunk.toString(); serverLogs.set(child, log); });
  for (let i = 0; i < 180; i++) {
    await wait(100);
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (!health.ok) continue;
      const ws = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      if (ws.status === 200) return { port, dir, workspaceDir, workspacePath, draftsDir, exportTmp, initialFiles, child };
    } catch { /* server boot */ }
  }
  throw new Error(`隔离 server 未就绪：${log}`);
}
async function stopServer(fixture: ServerFixture): Promise<void> {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { fixture.child.kill('SIGKILL'); resolve(); }, 4000);
      fixture.child.once('exit', () => { clearTimeout(timer); resolve(); });
      fixture.child.kill('SIGTERM');
    });
  }
}
async function http(f: ServerFixture, path: string, method = 'GET', body?: unknown) {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${f.port}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    return { status: 0, json: { transportError: String(error), serverLog: serverLogs.get(f.child) }, text: `transport error: ${String(error)}\n${serverLogs.get(f.child) ?? ''}`, headers: new Headers() };
  }
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* raw export bytes or protocol error */ }
  return { status: response.status, json, text, headers: response.headers };
}
async function mcp(f: ServerFixture, name: string, args: unknown = {}) {
  const response = await fetch(`http://127.0.0.1:${f.port}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {
    const line = text.split(/\r?\n/u).find((item) => item.startsWith('data:'));
    if (line) try { json = JSON.parse(line.slice(5).trim()); } catch { /* report below */ }
  }
  const toolText = json?.result?.content?.[0]?.text;
  let payload: any = null;
  if (typeof toolText === 'string') try { payload = JSON.parse(toolText); } catch { payload = { message: toolText }; }
  return { status: response.status, json, text, payload, isError: json?.result?.isError === true };
}
async function liveSnapshot(f: ServerFixture): Promise<any> {
  const response = await http(f, '/api/workspace');
  if (response.status !== 200) throw new Error(`GET /api/workspace ${response.status}: ${response.text}`);
  const data = response.json;
  return {
    project: data.project,
    workspaceId: data.workspaceId,
    liveModelVersion: data.liveModelVersion,
    projectSnapshotId: data.projectSnapshotId,
    projectSnapshotHash: data.projectSnapshotHash,
    projectSnapshotVersion: data.projectSnapshotVersion,
  };
}
function hasIdentityError(response: { json?: any; payload?: any; text?: string }): boolean {
  const text = stable(response.payload ?? response.json ?? response.text ?? '');
  return text.includes(WORKSPACE_UNIT_ID_CONFLICT) && text.includes('显式修复/迁移');
}
function hasReadableIdentityDiagnostics(value: any): boolean {
  const diagnostics = value?.identityDiagnostics;
  const liveDuplicate = diagnostics?.duplicateUnitIds?.find((item: any) => item.id === 'unit_001' && item.scope === 'live project');
  return diagnostics?.readOnly === true
    && diagnostics?.code === WORKSPACE_UNIT_ID_CONFLICT
    && typeof diagnostics?.message === 'string'
    && diagnostics.message.includes('unit_001')
    && diagnostics.message.includes('cab_qa_1')
    && diagnostics.message.includes('cab_qa_2')
    && Array.isArray(diagnostics?.duplicateUnitIds)
    && Boolean(liveDuplicate)
    && Array.isArray(liveDuplicate.locations)
    && liveDuplicate.locations.some((location: string) => location.includes('cabinet:cab_qa_1'))
    && liveDuplicate.locations.some((location: string) => location.includes('cabinet:cab_qa_2'));
}
function hasAllHistoricalIdentityScopes(value: any): boolean {
  const diagnostics = value?.identityDiagnostics;
  const requiredScopes = [
    'live project',
    'draftSyncReceipts[sync_old_1].project',
    'draftSyncReceipts[sync_old_2].project',
    'draft legacy_duplicate_draft',
  ];
  return requiredScopes.every((scope) => diagnostics?.duplicateUnitIds?.some((item: any) =>
    item.id === 'unit_001' && item.scope === scope
      && item.locations?.some((location: string) => location.includes('cabinet:cab_qa_1'))
      && item.locations?.some((location: string) => location.includes('cabinet:cab_qa_2'))));
}
async function rejectWithoutMutation(f: ServerFixture, name: string, action: () => Promise<{ status: number; json?: any; payload?: any; text?: string }>): Promise<void> {
  const beforeFiles = unitOnlyWorkspaceFiles(f.workspaceDir, f.workspacePath);
  const before = await liveSnapshot(f);
  const beforeMcp = await mcp(f, 'cad.get_state', {});
  const response = await action();
  const afterFiles = unitOnlyWorkspaceFiles(f.workspaceDir, f.workspacePath);
  const after = await liveSnapshot(f);
  const afterMcp = await mcp(f, 'cad.get_state', {});
  check(`${name} 明确返回 WORKSPACE_UNIT_ID_CONFLICT + 显式修复/迁移`, hasIdentityError(response), stable(response.payload ?? response.json ?? response.text).slice(0, 280));
  check(`${name} Project/receipt/hash/live+bus version/draft 原始字节全部不变`, same(beforeFiles, afterFiles) && same(before, after)
    && same(beforeMcp.payload?.project, afterMcp.payload?.project)
    && beforeMcp.payload?.liveModelVersion === afterMcp.payload?.liveModelVersion
    && beforeMcp.payload?.modelVersion === afterMcp.payload?.modelVersion,
  stable({ status: response.status, beforeVersion: before.liveModelVersion, afterVersion: after.liveModelVersion,
    beforeBusVersion: beforeMcp.payload?.modelVersion, afterBusVersion: afterMcp.payload?.modelVersion }));
}
function makeApplyBody(): Record<string, unknown> {
  const draftProject = buildProject();
  return {
    draftId: 'legacy_draft', syncId: 'sync_old_1', runId: 'legacy_run', revision: 1,
    draftHash: hashProjectSnapshot(draftProject), localVersion: 1, remoteVersion: 9,
    baseModelVersion: 9, baseProjectHash: hashProjectSnapshot(duplicateFixtureProject('旧工作区 live', 800, 'source_server_live')),
  };
}
function snapshotInMemory(storage: Map<string, string>): Record<string, string> {
  return Object.fromEntries([...storage.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function main(): Promise<void> {
  console.log('\nA. 浏览器本地真实 CommandBus：只读浏览可用，所有 Project/drawing/SharedPanel 写入零变化');
  const duplicate = duplicateFixtureProject('本地历史重复 ID', 800, 'source_local');
  const appSource = readFileSync(join(APP, 'src/ui/App.tsx'), 'utf8');
  const memoryStorage = new Map<string, string>([
    ['furnicad.draft.v1', serializeProjectFile(duplicate, '2025-01-01T00:00:00.000Z')],
    ['furniture-cad.workspace-mode', 'cad'],
    ['furniture-cad.workspace-context', '{"projectId":"old","roomId":"room_qa"}'],
  ]);
  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => memoryStorage.get(key) ?? null,
    setItem: (key: string, value: string) => { memoryStorage.set(key, value); },
    removeItem: (key: string) => { memoryStorage.delete(key); },
    clear: () => memoryStorage.clear(),
  } });
  const localBus = new CommandBus(duplicate, rules);
  const recoveredLocalDraft = (await import('../src/state/draftStore.ts')).loadDraft();
  const beforeLocal = { project: JSON.stringify(localBus.getState()), version: localBus.getVersion(), storage: snapshotInMemory(memoryStorage) };
  const localEdit = localBus.execute(setWidthCmd('cab_qa_1', 1000));
  const drawingCommand = replaceDrawingEdits(localBus.getState(), [], '历史身份图元编辑');
  const drawingResult = localBus.execute(drawingCommand);
  let replaceError = '';
  try { localBus.replaceProject({ ...localBus.getState(), name: '不能保存的新项目' }, 'replace duplicate'); }
  catch (error) { replaceError = String((error as Error).message); }
  let sharedError = '';
  try { localBus.replaceProject({ ...localBus.getState(), sharedPanels: [{ id: 'shared_after', memberCabinetIds: ['cab_qa_1'] }] } as Project, 'SharedPanel save'); }
  catch (error) { sharedError = String((error as Error).message); }
  const saveDraftResult = (await import('../src/state/draftStore.ts')).saveDraft(localBus.getState());
  (await import('../src/state/draftStore.ts')).clearDraft();
  const undoResult = localBus.undo();
  const redoResult = localBus.redo();
  const afterLocal = { project: JSON.stringify(localBus.getState()), version: localBus.getVersion(), storage: snapshotInMemory(memoryStorage) };
  check('真实 localStorage 草稿恢复保留重复 Project 只读浏览，且 CommandBus 可检测身份冲突', recoveredLocalDraft?.project.name === duplicate.name && Boolean(recoveredLocalDraft.identityConflict) && localBus.getState().name === duplicate.name && localBus.getUnitIdentityConflict()?.includes('显式修复/迁移'));
  check('bus.execute 修改命令拒绝并明确提示身份冲突', !localEdit.ok && localEdit.error?.includes('显式修复/迁移'));
  check('bus.execute drawingEdits 命令拒绝并明确提示身份冲突', !drawingResult.ok && drawingResult.error?.includes('显式修复/迁移'));
  check('bus.replaceProject 与 App SharedPanel 同一替换写入口均拒绝且明确提示', replaceError.includes('显式修复/迁移') && sharedError.includes('显式修复/迁移'));
  check('Project 草稿保存/清理零写入，Undo/Redo 零状态变化', saveDraftResult === '' && !undoResult && !redoResult && same(beforeLocal, afterLocal));
  check('App 持久 alert 将 CommandBus 的冲突原因直接呈现给用户',
    appSource.includes('data-testid="unit-identity-readonly-banner"')
      && appSource.includes('role="alert"')
      && appSource.includes('const localUnitIdentityConflict = bus.getUnitIdentityConflict();')
      && appSource.includes('remoteWorkspaceStatus?.identityDiagnostics?.readOnly')
      && appSource.includes('identityDiagnostics: workspaceResult.data.identityDiagnostics')
      && appSource.includes('data-testid="unit-identity-readonly-details"')
      && appSource.includes('visibleIdentityDiagnostics?.message ?? unitIdentityConflict'));
  if (previousLocalStorage) Object.defineProperty(globalThis, 'localStorage', previousLocalStorage);
  else delete (globalThis as { localStorage?: unknown }).localStorage;

  console.log('\nB. WorkspaceStore 历史 live + 两份 receipt 只读 load：原始 workspace 字节不变，旧 syncId replay 拒绝');
  const historyDir = join(TMP, 'history');
  mkdirSync(historyDir, { recursive: true });
  const historyPath = join(historyDir, 'workspace.json');
  const live = duplicateFixtureProject('旧工作区 live', 800, 'source_live');
  const receiptProject1 = duplicateFixtureProject('回执项目一', 740, 'source_receipt_one');
  const receiptProject2 = duplicateFixtureProject('回执项目二', 960, 'source_receipt_two');
  const initial = `${JSON.stringify(envelope(live, {
    sync_old_1: receipt('sync_old_1', receiptProject1, 8),
    sync_old_2: receipt('sync_old_2', receiptProject2, 9),
  }), null, 2)}\n`;
  writeFileSync(historyPath, initial, 'utf8');
  const beforeStoreLoad = readFileSync(historyPath, 'utf8');
  let storePersistCalls = 0;
  const store = WorkspaceStore.load({ filePath: historyPath, rules, persist: async (content) => { storePersistCalls++; writeFileSync(historyPath, content, 'utf8'); }, readRaw: () => readFileSync(historyPath, 'utf8'), projectHash: hashProjectSnapshot });
  check('WorkspaceStore.load 拒绝历史重复身份但逐字节保留原始 workspace', readFileSync(historyPath, 'utf8') === beforeStoreLoad,
    stable({ bytesBefore: beforeStoreLoad.length, bytesAfter: readFileSync(historyPath, 'utf8').length }));
  await store.loadPersistedDrafts();
  check('draft load 保持 workspace 与 receipts 原始字节不变', readFileSync(historyPath, 'utf8') === beforeStoreLoad,
    stable({ bytesBefore: beforeStoreLoad.length, bytesAfter: readFileSync(historyPath, 'utf8').length }));
  const beforeStore = readFileSync(historyPath, 'utf8');
  const beforeStoreProject = store.getState();
  const beforeStoreVersion = store.getLiveModelVersion();
  const beforeStoreBusVersion = store.getModelVersion();
  const beforeStoreHash = hashProjectSnapshot(beforeStoreProject);
  const replay = await store.applyDraft('draft_sync_old_1', {
    syncId: 'sync_old_1', draftId: 'draft_sync_old_1', runId: 'run_sync_old_1', revision: 8,
    draftHash: 'hash_sync_old_1', localVersion: 8, remoteVersion: 7, baseModelVersion: 7, baseProjectHash: 'base_sync_old_1',
  } as never);
  const blockedEdit = await store.execute(setWidthCmd('cab_qa_1', 1100));
  let storeCreateBlocked = false;
  try { await store.createDraft('local-open'); } catch (error) { storeCreateBlocked = (error as { code?: string }).code === WORKSPACE_UNIT_ID_CONFLICT; }
  check('load 正常返回只读 Store，live、receipt1、receipt2 均保留相同跨柜重复ID且数据/引用不同',
    findDuplicateUnitIds(store.getState()).some((item) => item.id === 'unit_001')
      && findDuplicateUnitIds(receiptProject1).some((item) => item.id === 'unit_001')
      && findDuplicateUnitIds(receiptProject2).some((item) => item.id === 'unit_001')
      && receiptProject1.name !== receiptProject2.name
      && (receiptProject1 as any).sharedPanels[0].replacesPanelIds[0] !== (receiptProject2 as any).sharedPanels[0].replacesPanelIds[0]
      && store.getUnitIdentityConflict()?.includes('draftSyncReceipts[sync_old_1]')
      && store.getUnitIdentityConflict()?.includes('draftSyncReceipts[sync_old_2]'));
  check('WorkspaceStore 只读快照可供浏览，重复 ID project 不被自动重编号', store.getProjectSnapshot().cabinets[0]!.layout.units[0]!.id === 'unit_001' && store.getUnitIdentityConflict()?.includes('显式修复/迁移'));
  check('旧 syncId receipt replay、live command、draft create 全部明确拒绝', !replay.ok && replay.code === WORKSPACE_UNIT_ID_CONFLICT && !blockedEdit.ok && blockedEdit.error?.includes('显式修复/迁移') && storeCreateBlocked);
  check('拒绝后 live 内存/live+bus version/hash/workspace+receipt 字节不变，persist 从未调用且可重试', same(beforeStoreProject, store.getState())
    && store.getLiveModelVersion() === beforeStoreVersion && store.getModelVersion() === beforeStoreBusVersion
    && hashProjectSnapshot(store.getState()) === beforeStoreHash && readFileSync(historyPath, 'utf8') === beforeStore && storePersistCalls === 0,
  stable({ liveVersionBefore: beforeStoreVersion, liveVersionAfter: store.getLiveModelVersion(), busVersionBefore: beforeStoreBusVersion,
    busVersionAfter: store.getModelVersion(), hashBefore: beforeStoreHash, hashAfter: hashProjectSnapshot(store.getState()),
    sameProject: same(beforeStoreProject, store.getState()), persistCalls: storePersistCalls }));

  console.log('\nC. 真隔离 HTTP server + MCP handler：读可浏览，所有可达写与 receipt replay 均拒绝');
  const badDir = join(TMP, 'server-bad');
  mkdirSync(badDir, { recursive: true });
  const serverLive = duplicateFixtureProject('旧工作区 live', 800, 'source_server_live');
  const serverReceipt1 = duplicateFixtureProject('服务端回执一', 740, 'source_server_receipt_one');
  const serverReceipt2 = duplicateFixtureProject('服务端回执二', 960, 'source_server_receipt_two');
  const bad = await startServer(badDir, serverLive, {
    sync_old_1: receipt('sync_old_1', serverReceipt1, 8),
    sync_old_2: receipt('sync_old_2', serverReceipt2, 9),
  }, 9, true);
  check('启动真实 server 与 load 持久草稿未改历史 workspace/draft 字节', same(bad.initialFiles, unitOnlyWorkspaceFiles(bad.workspaceDir, bad.workspacePath)));
  const browserGet = await http(bad, '/api/workspace');
  check('HTTP /api/workspace 保留只读浏览，返回原重复ID清单/诊断与 hash/version', browserGet.status === 200
    && browserGet.json.project.cabinets[0].layout.units[0].id === 'unit_001' && browserGet.json.liveModelVersion === 9
    && browserGet.json.projectSnapshotHash === hashProjectSnapshot(browserGet.json.project)
    && hasReadableIdentityDiagnostics(browserGet.json) && hasAllHistoricalIdentityScopes(browserGet.json),
  stable({ status: browserGet.status, id: browserGet.json?.project?.cabinets?.[0]?.layout?.units?.[0]?.id, version: browserGet.json?.liveModelVersion, identityDiagnostics: browserGet.json?.identityDiagnostics }));
  const mcpRead = await mcp(bad, 'cad.get_state', {});
  const mcpDraftRead = await mcp(bad, 'cad.list_drafts', {});
  const mcpValidateRead = await mcp(bad, 'cad.validate', {});
  const httpDraftListRead = await http(bad, '/api/drafts');
  const duplicateDraftRead = await http(bad, '/api/drafts/legacy_duplicate_draft');
  check('真实 MCP get_state 返回原项目及重复ID诊断；list_drafts/HTTP preview 可读取持久重复 draft',
    !mcpRead.isError && !mcpDraftRead.isError
      && mcpRead.payload?.project?.cabinets?.[0]?.layout?.units?.[0]?.id === 'unit_001'
      && hasReadableIdentityDiagnostics(mcpRead.payload)
      && hasAllHistoricalIdentityScopes(mcpRead.payload)
      && hasReadableIdentityDiagnostics(mcpDraftRead.payload)
      && hasAllHistoricalIdentityScopes(mcpDraftRead.payload)
      && hasReadableIdentityDiagnostics(mcpValidateRead.payload)
      && hasAllHistoricalIdentityScopes(mcpValidateRead.payload)
      && httpDraftListRead.status === 200 && hasReadableIdentityDiagnostics(httpDraftListRead.json)
      && hasAllHistoricalIdentityScopes(httpDraftListRead.json)
      && mcpDraftRead.payload?.drafts?.some((item: any) => item.draftId === 'legacy_draft')
      && mcpDraftRead.payload?.drafts?.some((item: any) => item.draftId === 'legacy_duplicate_draft')
      && duplicateDraftRead.status === 200 && duplicateDraftRead.json.project.cabinets[0].layout.units[0].id === 'unit_001'
      && hasReadableIdentityDiagnostics(duplicateDraftRead.json)
      && hasAllHistoricalIdentityScopes(duplicateDraftRead.json)
      && same(bad.initialFiles, unitOnlyWorkspaceFiles(bad.workspaceDir, bad.workspacePath)),
    stable({ readError: mcpRead.isError, workspaceDiagnostics: mcpRead.payload?.identityDiagnostics, listDiagnostics: mcpDraftRead.payload?.identityDiagnostics,
      validateDiagnostics: mcpValidateRead.payload?.identityDiagnostics, httpDraftListDiagnostics: httpDraftListRead.json?.identityDiagnostics,
      draftIds: mcpDraftRead.payload?.drafts?.map((item: any) => item.draftId), duplicatePreviewStatus: duplicateDraftRead.status,
      duplicateId: duplicateDraftRead.json?.project?.cabinets?.[0]?.layout?.units?.[0]?.id, previewDiagnostics: duplicateDraftRead.json?.identityDiagnostics }));
  const beforeExports = unitOnlyWorkspaceFiles(bad.workspaceDir, bad.workspacePath);
  const badSnapshot = await liveSnapshot(bad);
  const exportBody = {
    project: badSnapshot.project,
    projectSnapshotId: badSnapshot.projectSnapshotId,
    projectSnapshotHash: badSnapshot.projectSnapshotHash,
    projectSnapshotVersion: badSnapshot.projectSnapshotVersion,
    which: ['sheet'], layoutRoomIds: [], modelVersion: `v${badSnapshot.projectSnapshotVersion}`,
  };
  for (const [label, route] of [
    ['HTTP PDF', '/api/export/pdf'], ['HTTP DXF', '/api/export/dxf'],
    ['HTTP CSV', '/api/export/cutlist'], ['HTTP roombook', '/api/export/roombook'],
  ] as const) {
    await rejectWithoutMutation(bad, label, () => http(bad, route, 'POST', exportBody));
  }
  const mcpExportCalls: Array<[string, string, unknown]> = [
    ['MCP PDF', 'cad.export_pdf', {}], ['MCP DXF', 'cad.export_dxf', { which: ['sheet'] }],
    ['MCP CSV', 'cad.export_bom_csv', {}], ['MCP roombook', 'cad.export_roombook', {}],
  ];
  for (const [label, name, args] of mcpExportCalls) {
    await rejectWithoutMutation(bad, label, () => mcp(bad, name, args));
  }
  const applyBody = makeApplyBody();
  await rejectWithoutMutation(bad, 'HTTP apply + 已存在 sync_old_1 receipt replay', () => http(bad, '/api/drafts/legacy_draft/apply', 'POST', applyBody));
  await rejectWithoutMutation(bad, 'HTTP discard 持久草稿', () => http(bad, '/api/drafts/legacy_draft/discard', 'POST', {}));
  await rejectWithoutMutation(bad, 'HTTP Agent 写入口', () => http(bad, '/api/ai/agent', 'POST', { roomId: 'room_qa', intent: '修改柜体宽度' }));
  const mcpWriteCalls: Array<[string, string, unknown]> = [
    ['MCP create cabinet', 'cad.create_cabinet', { name: '不应创建', roomId: 'room_qa', width: 800 }],
    ['MCP create assembly', 'cad.create_assembly', { name: '不应组合', memberIds: ['cab_qa_1', 'cab_qa_2'] }],
    ['MCP place cabinet', 'cad.place_cabinet', { cabinetId: 'cab_qa_1', mode: 'explicit', x: 100, y: 100 }],
    ['MCP update object', 'cad.update_object', { targetId: 'cab_qa_1', targetType: 'cabinet', field: 'width', value: 1000, draftId: 'legacy_draft' }],
    ['MCP delete object', 'cad.delete_object', { targetId: 'cab_qa_1', targetType: 'cabinet', draftId: 'legacy_draft' }],
    ['MCP submit proposal', 'cad.submit_proposal', { proposal: {}, draftId: 'legacy_draft' }],
    ['MCP apply + sync_old_1 receipt replay', 'cad.apply_draft', applyBody],
    ['MCP discard draft', 'cad.discard_draft', { draftId: 'legacy_draft' }],
    ['MCP create room', 'cad.create_room', { name: '不应新建房间' }],
    ['MCP draw wall', 'cad.draw_wall', { start: { x: 0, y: 0 }, end: { x: 500, y: 0 } }],
    ['MCP duplicate cabinet', 'cad.duplicate_object', { sourceId: 'cab_qa_1' }],
  ];
  for (const [label, name, args] of mcpWriteCalls) {
    await rejectWithoutMutation(bad, label, () => mcp(bad, name, args));
  }
  check('HTTP 与 MCP 全部拒绝后，临时导出目录没有 PDF/DXF/CSV/HTML 文件产物', readdirSync(bad.exportTmp).length === 0 && same(beforeExports, unitOnlyWorkspaceFiles(bad.workspaceDir, bad.workspacePath)));
  await stopServer(bad);

  console.log('\nD. 唯一 ID 正向控制：浏览器 CommandBus、WorkspaceStore、真实 HTTP/MCP 写入与四种导出仍成功');
  const cleanProject = buildProject();
  const cleanBus = new CommandBus(cleanProject, rules);
  const cleanEdit = cleanBus.execute(setWidthCmd('cab_qa_1', 1000));
  const cleanReplace = (() => {
    try { cleanBus.replaceProject({ ...cleanBus.getState(), name: '合法 replace' }, 'clean replace'); return true; }
    catch { return false; }
  })();
  check('唯一 ID 浏览器 CommandBus 普通修改和 replaceProject 仍成功并推进版本', cleanEdit.ok && cleanReplace && cleanBus.getVersion() === 2 && findDuplicateUnitIds(cleanBus.getState()).length === 0);

  const uniquePath = join(TMP, 'unique-workspace.json');
  let uniquePersistCount = 0;
  const uniqueStore = WorkspaceStore.create({ filePath: uniquePath, rules, project: buildProject(), owner: 'qa', account: 'qa', persist: async (content) => { uniquePersistCount++; writeFileSync(uniquePath, content, 'utf8'); }, projectHash: hashProjectSnapshot });
  await uniqueStore.save();
  const cleanDraft = await uniqueStore.createDraft('qa');
  const cleanFresh = uniqueStore.getDraftFreshness(cleanDraft.draftId)!;
  const cleanApply = await uniqueStore.applyDraft(cleanDraft.draftId, {
    syncId: 'sync_unique', draftId: cleanDraft.draftId, runId: cleanFresh.runId, revision: cleanFresh.revision,
    draftHash: cleanFresh.draftHash, localVersion: 1, remoteVersion: cleanFresh.liveModelVersion,
    baseModelVersion: cleanFresh.baseModelVersion, baseProjectHash: cleanFresh.baseProjectHash,
  } as never);
  const cleanReplay = await uniqueStore.applyDraft(cleanDraft.draftId, {
    syncId: 'sync_unique', draftId: cleanDraft.draftId, runId: cleanFresh.runId, revision: cleanFresh.revision,
    draftHash: cleanFresh.draftHash, localVersion: 1, remoteVersion: cleanFresh.liveModelVersion,
    baseModelVersion: cleanFresh.baseModelVersion, baseProjectHash: cleanFresh.baseProjectHash,
  } as never);
  check('唯一 ID WorkspaceStore create/save/apply/replay 仍成功且重放版本稳定', cleanApply.ok && cleanReplay.ok && cleanApply.newVersion === cleanReplay.newVersion && uniquePersistCount >= 2);

  const uniqueDir = join(TMP, 'server-unique');
  mkdirSync(uniqueDir, { recursive: true });
  const good = await startServer(uniqueDir, buildProject(), {}, 0, false);
  const goodBefore = await liveSnapshot(good);
  const createRoom = await mcp(good, 'cad.create_room', { name: '正常新增房间' });
  const createdDraftId = createRoom.payload?.draftId;
  const goodAfterDraft = await liveSnapshot(good);
  check('唯一 ID 真实 MCP create_room 成功、落有持久 draft 且 live 仍按草稿语义不变', !createRoom.isError && typeof createdDraftId === 'string' && same(goodBefore, goodAfterDraft) && existsSync(join(good.draftsDir, `${createdDraftId}.json`)), stable(createRoom.payload));
  const discardClean = await mcp(good, 'cad.discard_draft', { draftId: createdDraftId });
  check('唯一 ID 真实 MCP discard 仍成功且持久 draft 删除', !discardClean.isError && discardClean.payload?.ok === true && !existsSync(join(good.draftsDir, `${createdDraftId}.json`)));
  const cleanSnapshot = await liveSnapshot(good);
  const cleanExportBody = {
    project: cleanSnapshot.project,
    projectSnapshotId: cleanSnapshot.projectSnapshotId,
    projectSnapshotHash: cleanSnapshot.projectSnapshotHash,
    projectSnapshotVersion: cleanSnapshot.projectSnapshotVersion,
    which: ['sheet'], layoutRoomIds: [], modelVersion: `v${cleanSnapshot.projectSnapshotVersion}`,
  };
  const goodHttpExports = await Promise.all([
    http(good, '/api/export/pdf', 'POST', cleanExportBody),
    http(good, '/api/export/dxf', 'POST', cleanExportBody),
    http(good, '/api/export/cutlist', 'POST', cleanExportBody),
    http(good, '/api/export/roombook', 'POST', cleanExportBody),
  ]);
  check('唯一 ID HTTP PDF/DXF/CSV/roombook 四出口仍成功返回文件内容', goodHttpExports.every((response) => response.status === 200 && response.text.length > 0), stable(goodHttpExports.map((response) => ({ status: response.status, type: response.headers.get('content-type') }))));
  const goodMcpExports = await Promise.all([
    mcp(good, 'cad.export_pdf', {}), mcp(good, 'cad.export_dxf', { which: ['sheet'] }),
    mcp(good, 'cad.export_bom_csv', {}), mcp(good, 'cad.export_roombook', {}),
  ]);
  check('唯一 ID MCP PDF/DXF/CSV/roombook 四出口仍成功且返回 base64 文件', goodMcpExports.every((response) => !response.isError && response.payload?.ok === true && typeof response.payload?.base64 === 'string' && response.payload.base64.length > 0), stable(goodMcpExports.map((response) => response.payload?.code ?? response.payload?.filename)));
  await stopServer(good);

  console.log(`\n历史重复 Unit ID fail-closed 独立验收：通过 ${pass} / 失败 ${fail}`);
  rmSync(TMP, { recursive: true, force: true });
  if (fail) {
    console.log(`失败项：\n  · ${failures.join('\n  · ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  for (const child of children) if (serverLogs.get(child)) console.error(`[isolated server ${child.pid}]\n${serverLogs.get(child)}`);
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* cleanup */ } }
  rmSync(TMP, { recursive: true, force: true });
  process.exitCode = 1;
});
