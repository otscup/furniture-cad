import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { renameRoomCommand } from '../src/core/commands.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import type { Project, RuleSet } from '../src/core/types.ts';
import { WorkspaceStore } from '../src/workspace/workspace.ts';
import { openWorkspace } from '../server/workspaceHost.mjs';
import { hashProjectSnapshot } from '../server/projectHash.mjs';

const appRoot = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..');
const rules = JSON.parse(readFileSync(join(appRoot, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const tempRoot = mkdtempSync(join(tmpdir(), 'furnicad-draft-failure-safety-'));
let pass = 0;
let fail = 0;
const failures: string[] = [];

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

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function makeProject(): Project {
  const project = emptyProject({ id: 'draft-failure-safety', name: 'Draft failure safety', ruleSetId: rules.id });
  project.rooms.push(rectRoom({ id: 'room_failure_safety', name: '故障注入房间', x: 0, y: 0, w: 5000, h: 4000, thickness: 120, height: 2700 }));
  return project;
}

function confirmation(store: WorkspaceStore, draftId: string, syncId: string, localVersion: number): Record<string, unknown> {
  const freshness = store.getDraftFreshness(draftId);
  if (!freshness) throw new Error(`draft freshness missing: ${draftId}`);
  return {
    syncId,
    draftId,
    runId: freshness.runId,
    revision: freshness.revision,
    draftHash: freshness.draftHash,
    localVersion,
    remoteVersion: freshness.liveModelVersion,
    baseModelVersion: freshness.baseModelVersion,
    baseProjectHash: freshness.baseProjectHash,
  };
}

async function main(): Promise<void> {
  const workspacePath = join(tempRoot, 'store', 'workspace.json');
  const draftsDir = join(tempRoot, 'store', 'drafts');
  const quarantineDir = join(draftsDir, 'quarantine');
  let failWriteTarget: string | null = null;
  let failRenameTarget: string | null = null;
  let failUnlinkTarget: string | null = null;
  let failNextDraftTempWrite = false;
  let failNextQuarantineRename = false;
  let workspaceTempWrites = 0;
  let workspaceRenameAttempts = 0;
  let draftTempWrites = 0;
  let draftUnlinkAttempts = 0;
  const ioFailure = (operation: string) => Object.assign(new Error(`injected filesystem ${operation} failure`), { code: 'EIO' });
  const fileSystemAdapter = {
    existsSync,
    readFileSync,
    readdirSync,
    mkdirSync,
    writeFileSync(path: string, data: string | Uint8Array, encoding?: any) {
      if (path.startsWith(`${workspacePath}.`) && path.endsWith('.tmp')) workspaceTempWrites += 1;
      if (path.startsWith(`${draftsDir}/`) && path.endsWith('.tmp')) draftTempWrites += 1;
      if (failWriteTarget && path.startsWith(`${failWriteTarget}.`) && path.endsWith('.tmp')) {
        failWriteTarget = null;
        throw ioFailure('writeFileSync(temp)');
      }
      if (failNextDraftTempWrite && path.startsWith(`${draftsDir}/`) && path.endsWith('.tmp')) {
        failNextDraftTempWrite = false;
        throw ioFailure('draft writeFileSync(temp)');
      }
      return writeFileSync(path, data as any, encoding);
    },
    renameSync(from: string, to: string) {
      if (to === workspacePath) workspaceRenameAttempts += 1;
      if (to.includes(`${draftsDir}/quarantine/`) && failNextQuarantineRename) {
        failNextQuarantineRename = false;
        throw ioFailure('quarantine renameSync');
      }
      if (failRenameTarget === to) {
        failRenameTarget = null;
        throw ioFailure('renameSync');
      }
      return renameSync(from, to);
    },
    unlinkSync(path: string) {
      if (path.startsWith(`${draftsDir}/`) && !path.includes('/quarantine/')) draftUnlinkAttempts += 1;
      if (failUnlinkTarget === path) {
        failUnlinkTarget = null;
        throw ioFailure('unlinkSync');
      }
      return unlinkSync(path);
    },
  };
  const initialEnvelope = JSON.parse(serializeProjectFile(makeProject())) as Record<string, unknown>;
  Object.assign(initialEnvelope, { workspaceId: 'ws_fault_injection', owner: 'acceptance', account: 'acceptance', liveModelVersion: 0, updatedAt: new Date().toISOString() });
  mkdirSync(join(tempRoot, 'store'), { recursive: true });
  writeFileSync(workspacePath, JSON.stringify(initialEnvelope, null, 2), 'utf8');
  const opened = await openWorkspace({ filePath: workspacePath, owner: 'acceptance', account: 'acceptance', fileSystemAdapter });
  if (!opened.ok) throw new Error(`production workspaceHost failed to open fixture: ${opened.error}`);
  const store = opened.workspace as WorkspaceStore;
  const reopen = async (): Promise<WorkspaceStore> => {
    const result = await openWorkspace({ filePath: workspacePath, owner: 'acceptance', account: 'acceptance', fileSystemAdapter });
    if (!result.ok) throw new Error(`production workspaceHost failed to reload fixture: ${result.error}`);
    return result.workspace as WorkspaceStore;
  };

  console.log('\nA. apply workspace 持久化失败时旧 live 与 draft 均保留');
  const failedWriteDraft = await store.createDraft('acceptance');
  const failedWriteExpected = confirmation(store, failedWriteDraft.draftId, 'write-failure-same-key', 31);
  const beforeFailedWrite = {
    project: structuredClone(store.getState()),
    version: store.getLiveModelVersion(),
    disk: JSON.parse(readFileSync(workspacePath, 'utf8')) as Record<string, any>,
    draft: store.getDraftFreshness(failedWriteDraft.draftId),
  };
  // writeFileAtomic 已真实创建临时文件，仅 renameSync(tmp, workspace.json) 注入 EIO。
  failRenameTarget = workspacePath;
  let applyWriteRejected = false;
  try { await store.applyDraft(failedWriteDraft.draftId, failedWriteExpected); } catch { applyWriteRejected = true; }
  const afterFailedWriteDisk = JSON.parse(readFileSync(workspacePath, 'utf8')) as Record<string, any>;
  const workspaceTempsAfterRenameFailure = readdirSync(dirname(workspacePath)).filter((name) => name.startsWith('workspace.json.') && name.endsWith('.tmp'));
  check('workspace 原子写在真实writeFileAtomic temp write后遭遇renameSync EIO并向调用方报错', applyWriteRejected
    && workspaceTempWrites > 0 && workspaceRenameAttempts > 0 && workspaceTempsAfterRenameFailure.length === 0,
  `tempWrites=${workspaceTempWrites}; renameAttempts=${workspaceRenameAttempts}; leftoverTemps=${workspaceTempsAfterRenameFailure.length}`);
  check('写失败后内存 live/hash/version 完全不变', hashProjectSnapshot(store.getState()) === hashProjectSnapshot(beforeFailedWrite.project)
    && store.getLiveModelVersion() === beforeFailedWrite.version,
  `version=${beforeFailedWrite.version}->${store.getLiveModelVersion()}`);
  check('写失败后磁盘仍为旧 live 且没有 sync receipt', hashProjectSnapshot(afterFailedWriteDisk.project) === hashProjectSnapshot(beforeFailedWrite.disk.project)
    && afterFailedWriteDisk.liveModelVersion === beforeFailedWrite.disk.liveModelVersion
    && !afterFailedWriteDisk.draftSyncReceipts?.[String(failedWriteExpected.syncId)],
  `diskVersion=${afterFailedWriteDisk.liveModelVersion}; receipts=${Object.keys(afterFailedWriteDisk.draftSyncReceipts ?? {}).length}`);
  check('写失败后 draft 仍在内存且磁盘，可用同一确认元数据重试', !!store.getDraft(failedWriteDraft.draftId)
    && existsSync(join(draftsDir, `${failedWriteDraft.draftId}.json`))
    && same(store.getDraftFreshness(failedWriteDraft.draftId), beforeFailedWrite.draft));

  const firstApply = await store.applyDraft(failedWriteDraft.draftId, failedWriteExpected);
  check('同一 syncId 重试成功且只推进一次 live version', firstApply.ok
    && firstApply.newVersion === beforeFailedWrite.version + 1
    && store.getLiveModelVersion() === beforeFailedWrite.version + 1,
  `ok=${firstApply.ok}; version=${beforeFailedWrite.version}->${store.getLiveModelVersion()}`);
  const sameProcessRetry = await store.applyDraft(failedWriteDraft.draftId, failedWriteExpected);
  check('进程内同 syncId 重试返回原 receipt，不二次写 live', sameProcessRetry.ok && same(sameProcessRetry, firstApply)
    && store.getLiveModelVersion() === firstApply.newVersion);

  const restarted = await reopen();
  const restoredDrafts = await restarted.loadPersistedDrafts();
  const restartedRetry = await restarted.applyDraft(failedWriteDraft.draftId, failedWriteExpected);
  check('restart 后 receipt 可重放同一确认，返回同结果且不重复增加版本', restoredDrafts.loaded.length === 0
    && restartedRetry.ok && same(restartedRetry, firstApply)
    && restarted.getLiveModelVersion() === firstApply.newVersion,
  `loaded=${restoredDrafts.loaded.length}; version=${restarted.getLiveModelVersion()}`);

  console.log('\nA2. writeFileAtomic 临时文件真实 writeFileSync 故障');
  const failedTempWriteDraft = await store.createDraft('acceptance');
  const failedTempWriteExpected = confirmation(store, failedTempWriteDraft.draftId, 'temp-write-failure-retry', 33);
  const beforeTempWrite = {
    project: structuredClone(store.getState()),
    version: store.getLiveModelVersion(),
    disk: JSON.parse(readFileSync(workspacePath, 'utf8')) as Record<string, any>,
    draft: store.getDraftFreshness(failedTempWriteDraft.draftId),
  };
  failWriteTarget = workspacePath;
  let tempWriteRejected = false;
  try { await store.applyDraft(failedTempWriteDraft.draftId, failedTempWriteExpected); } catch { tempWriteRejected = true; }
  const afterTempWriteDisk = JSON.parse(readFileSync(workspacePath, 'utf8')) as Record<string, any>;
  const workspaceTempsAfterWriteFailure = readdirSync(dirname(workspacePath)).filter((name) => name.startsWith('workspace.json.') && name.endsWith('.tmp'));
  check('writeFileAtomic临时路径writeFileSync EIO向调用方报错且清理临时文件', tempWriteRejected
    && workspaceTempWrites > 1 && workspaceTempsAfterWriteFailure.length === 0,
    `workspace temp write attempts=${workspaceTempWrites}; leftoverTemps=${workspaceTempsAfterWriteFailure.length}`);
  check('真实临时写失败后live内存/磁盘/version/receipt与draft完整保留', hashProjectSnapshot(store.getState()) === hashProjectSnapshot(beforeTempWrite.project)
    && store.getLiveModelVersion() === beforeTempWrite.version
    && hashProjectSnapshot(afterTempWriteDisk.project) === hashProjectSnapshot(beforeTempWrite.disk.project)
    && !afterTempWriteDisk.draftSyncReceipts?.[String(failedTempWriteExpected.syncId)]
    && !!store.getDraft(failedTempWriteDraft.draftId)
    && same(store.getDraftFreshness(failedTempWriteDraft.draftId), beforeTempWrite.draft),
  `version=${beforeTempWrite.version}->${store.getLiveModelVersion()}; draft=${!!store.getDraft(failedTempWriteDraft.draftId)}`);
  const tempWriteRetry = await store.applyDraft(failedTempWriteDraft.draftId, failedTempWriteExpected);
  check('真实writeFileSync故障后同一确认重试成功', tempWriteRetry.ok && tempWriteRetry.newVersion === beforeTempWrite.version + 1);

  console.log('\nA3. 草稿创建/编辑保存失败不发布候选内存状态');
  const idsBeforeCreateFailure = store.listDrafts().map((draft) => draft.draftId).sort();
  const filesBeforeCreateFailure = existsSync(draftsDir) ? readdirSync(draftsDir).filter((name) => name.endsWith('.json')).sort() : [];
  failNextDraftTempWrite = true;
  let draftCreateRejected = false;
  try { await store.createDraft('acceptance'); } catch { draftCreateRejected = true; }
  const idsAfterCreateFailure = store.listDrafts().map((draft) => draft.draftId).sort();
  const filesAfterCreateFailure = existsSync(draftsDir) ? readdirSync(draftsDir).filter((name) => name.endsWith('.json')).sort() : [];
  const draftTempsAfterCreateFailure = existsSync(draftsDir) ? readdirSync(draftsDir).filter((name) => name.endsWith('.tmp')) : [];
  check('draft create临时文件写失败明确报错且内存/磁盘无新增draft', draftCreateRejected
    && same(idsAfterCreateFailure, idsBeforeCreateFailure) && same(filesAfterCreateFailure, filesBeforeCreateFailure)
    && draftTempsAfterCreateFailure.length === 0, `temp残留=${draftTempsAfterCreateFailure.length}`);

  const editableDraft = await store.createDraft('acceptance');
  const editablePath = join(draftsDir, `${editableDraft.draftId}.json`);
  const beforeEdit = {
    project: structuredClone(store.draftState(editableDraft.draftId)),
    disk: readFileSync(editablePath, 'utf8'),
    freshness: store.getDraftFreshness(editableDraft.draftId),
  };
  failWriteTarget = editablePath;
  let draftEditRejected = false;
  try { await store.draftExecute(editableDraft.draftId, renameRoomCommand(0, '故障注入房间', '不应发布的名称', 'mcp')); } catch { draftEditRejected = true; }
  const draftTempsAfterEditFailure = readdirSync(draftsDir).filter((name) => name.endsWith('.tmp'));
  check('draft edit真实writeFileSync(temp)失败报错且project/revision/hash与磁盘均不变', draftEditRejected
    && same(store.draftState(editableDraft.draftId), beforeEdit.project)
    && same(store.getDraftFreshness(editableDraft.draftId), beforeEdit.freshness)
    && readFileSync(editablePath, 'utf8') === beforeEdit.disk && draftTempsAfterEditFailure.length === 0,
  `revision=${beforeEdit.freshness?.revision}->${store.getDraftFreshness(editableDraft.draftId)?.revision}; temp残留=${draftTempsAfterEditFailure.length}`);
  const editRetry = await store.draftExecute(editableDraft.draftId, renameRoomCommand(0, '故障注入房间', '重试后的名称', 'mcp'));
  check('draft保存失败后同一编辑重试成功并同步磁盘', editRetry.ok
    && store.draftState(editableDraft.draftId)?.rooms[0]?.name === '重试后的名称'
    && JSON.parse(readFileSync(editablePath, 'utf8')).project.rooms[0].name === '重试后的名称');

  console.log('\nB. apply draft 文件删除失败与 discard 删除失败');
  const cleanupDraft = await store.createDraft('acceptance');
  const cleanupExpected = confirmation(store, cleanupDraft.draftId, 'delete-failure-same-key', 32);
  const beforeCleanupApplyVersion = store.getLiveModelVersion();
  failUnlinkTarget = join(draftsDir, `${cleanupDraft.draftId}.json`);
  const cleanupFailureApply = await store.applyDraft(cleanupDraft.draftId, cleanupExpected);
  const afterCleanupRetry = await store.applyDraft(cleanupDraft.draftId, cleanupExpected);
  check('apply 的 draft unlink 故障不回滚已原子提交的 live，残留文件被隔离', cleanupFailureApply.ok
    && store.getLiveModelVersion() === beforeCleanupApplyVersion + 1
    && !existsSync(join(draftsDir, `${cleanupDraft.draftId}.json`))
    && readdirSync(quarantineDir).some((name) => name.includes(cleanupDraft.draftId)),
  `version=${beforeCleanupApplyVersion}->${store.getLiveModelVersion()}; quarantined=${readdirSync(quarantineDir).length}`);
  check('draft unlink 故障后的相同 syncId retry 返回 receipt 且不重复写入', afterCleanupRetry.ok
    && same(afterCleanupRetry, cleanupFailureApply)
    && store.getLiveModelVersion() === beforeCleanupApplyVersion + 1);

  const discard = await store.createDraft('acceptance');
  const discardFile = join(draftsDir, `${discard.draftId}.json`);
  const discardDiskBefore = readFileSync(discardFile, 'utf8');
  failUnlinkTarget = discardFile;
  let discardRejected = false;
  try { await store.discardDraft(discard.draftId); } catch { discardRejected = true; }
  check('discard 删除失败明确报错且内存草稿、旧文件均保留', discardRejected
    && !!store.getDraft(discard.draftId)
    && existsSync(discardFile) && readFileSync(discardFile, 'utf8') === discardDiskBefore,
  `memory=${!!store.getDraft(discard.draftId)}; file=${existsSync(discardFile)}`);
  const discarded = await store.discardDraft(discard.draftId);
  const restartAfterDiscard = await reopen();
  const afterDiscardLoad = await restartAfterDiscard.loadPersistedDrafts();
  check('discard 重试先删除磁盘文件，再移除内存；重启不复活', discarded
    && !store.getDraft(discard.draftId)
    && !existsSync(discardFile)
    && !afterDiscardLoad.loaded.includes(discard.draftId),
  `discarded=${discarded}; restored=${afterDiscardLoad.loaded.join(',')}`);

  console.log('\nC. 损坏 JSON 草稿隔离，后续启动不重复出现');
  const corruptPath = join(draftsDir, 'corrupt_json_fixture.json');
  writeFileSync(corruptPath, '{ this is not valid JSON', 'utf8');
  failNextQuarantineRename = true;
  let quarantineFailureReported = false;
  try { await store.loadPersistedDrafts(); } catch { quarantineFailureReported = true; }
  check('隔离rename故障明确报错且原损坏draft文件仍保留可重试', quarantineFailureReported && existsSync(corruptPath));
  const corruptLoad = await store.loadPersistedDrafts();
  const isolatedCorrupt = readdirSync(quarantineDir).some((name) => name.includes('corrupt_json_fixture'));
  const secondCorruptLoad = await store.loadPersistedDrafts();
  check('损坏 draft 被记为 skipped 并移入隔离目录', corruptLoad.skipped.includes('corrupt_json_fixture')
    && isolatedCorrupt && !existsSync(corruptPath), `skipped=${corruptLoad.skipped.join(',')}`);
  check('再次从同一持久目录恢复时损坏 draft 不再重复报告', !secondCorruptLoad.skipped.includes('corrupt_json_fixture')
    && secondCorruptLoad.loaded.length === 0, `skipped=${secondCorruptLoad.skipped.join(',')}`);
  check('真实adapter观测到草稿临时写、草稿unlink及live rename操作', draftTempWrites > 0 && draftUnlinkAttempts > 0
    && workspaceRenameAttempts > 0, `draftTempWrites=${draftTempWrites}; draftUnlinks=${draftUnlinkAttempts}; liveRenames=${workspaceRenameAttempts}`);

  console.log('\nD. 生产 workspaceHost 的真实损坏文件隔离路径');
  const hostRoot = join(tempRoot, 'host');
  const hostWorkspacePath = join(hostRoot, 'workspace.json');
  mkdirSync(join(hostRoot, 'drafts'), { recursive: true });
  const hostEnvelope = JSON.parse(serializeProjectFile(makeProject())) as Record<string, unknown>;
  Object.assign(hostEnvelope, {
    workspaceId: 'ws_corrupt_host_fixture',
    owner: 'local-open',
    account: 'local-open',
    liveModelVersion: 0,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(hostWorkspacePath, JSON.stringify(hostEnvelope, null, 2), 'utf8');
  const hostCorruptPath = join(hostRoot, 'drafts', 'broken_host_draft.json');
  writeFileSync(hostCorruptPath, '{ definitely broken', 'utf8');
  const firstEvents: Array<Record<string, any>> = [];
  const firstHost = await openWorkspace({ filePath: hostWorkspacePath, onEvent: (event: Record<string, any>) => firstEvents.push(event) });
  const hostQuarantineFiles = join(hostRoot, 'drafts', 'quarantine');
  const movedByProductionHost = existsSync(hostQuarantineFiles)
    && readdirSync(hostQuarantineFiles).some((name) => name.includes('broken_host_draft'));
  const secondEvents: Array<Record<string, any>> = [];
  const secondHost = await openWorkspace({ filePath: hostWorkspacePath, onEvent: (event: Record<string, any>) => secondEvents.push(event) });
  const firstLoad = firstEvents.find((event) => event.action === 'workspace.load');
  const secondLoad = secondEvents.find((event) => event.action === 'workspace.load');
  check('workspaceHost 成功装载并把坏 JSON 移出 drafts/*.json', firstHost.ok && movedByProductionHost && !existsSync(hostCorruptPath)
    && firstLoad?.draftsSkipped === 1,
  `ok=${firstHost.ok}; skipped=${firstLoad?.draftsSkipped}; quarantined=${movedByProductionHost}`);
  check('生产 host 第二次启动不再重复跳过同一损坏 draft', secondHost.ok && secondLoad?.draftsSkipped === 0,
    `ok=${secondHost.ok}; skipped=${secondLoad?.draftsSkipped}`);

  console.log('\nE. DraftsPanel 确认严格绑定用户看到的预览快照');
  const panelSource = readFileSync(join(appRoot, 'src/ui/panels/DraftsPanel.tsx'), 'utf8');
  const applyStart = panelSource.indexOf('const onApply =');
  const applyEnd = panelSource.indexOf('const onSyncRemote =', applyStart);
  const applySource = applyStart >= 0 && applyEnd > applyStart ? panelSource.slice(applyStart, applyEnd) : '';
  check('onApply 的全部必填字段都由确认快照直接取值', [
    'runId: snapshot.runId',
    'draftId: snapshot.draftId',
    'revision: snapshot.revision',
    'draftHash: snapshot.draftHash',
    'localVersion: snapshot.localVersion',
    'remoteVersion: snapshot.liveModelVersion',
  ].every((field) => applySource.includes(field)), '确认 body 含六项必填元数据');
  check('点击确认前冻结 previewSnapshot；提交使用 confirmationSnapshot，不会重读 latest draft',
    panelSource.includes('setConfirmationSnapshot(structuredClone(previewSnapshot))')
      && panelSource.includes('const confirmed = confirmationSnapshot;')
      && panelSource.includes('void onApply(confirmed);')
      && !applySource.includes('api<Omit<DraftSnapshot'),
  'preview → immutable confirmation → apply');
  check('preview 时记录本地版本，确认弹窗向用户显示 revision/hash 与本地/远端版本',
    panelSource.includes('localVersion: bus.getVersion()')
      && panelSource.includes('{confirmationSnapshot.revision}')
      && panelSource.includes('{confirmationSnapshot.draftHash}')
      && panelSource.includes('{confirmationSnapshot.localVersion}')
      && panelSource.includes('{confirmationSnapshot.liveModelVersion}'));

  console.log(`\nDraft confirmation failure-safety acceptance: ${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`验收失败：${fail} 项（${failures.join('；')}）`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
}).finally(() => {
  if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});
