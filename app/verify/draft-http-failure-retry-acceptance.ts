import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import type { Project, RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..');
const rules = JSON.parse(readFileSync(join(appRoot, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const tempRoot = mkdtempSync(join(tmpdir(), 'furnicad-draft-http-failure-retry-'));
const workspacePath = join(tempRoot, 'workspace.json');
const draftsDir = join(tempRoot, 'workspaces', 'local-open', 'drafts');
let child: ChildProcess | null = null;
let childLog = '';
let pass = 0;
let fail = 0;
const failures: string[] = [];
let requestId = 1;

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

function section(label: string): void {
  console.log(`\n${label}`);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function seedWorkspace(): void {
  const project: Project = emptyProject({ id: 'draft-http-failure-retry', name: 'Draft HTTP failure/retry', ruleSetId: rules.id });
  project.rooms.push(rectRoom({ id: 'room_draft_retry', name: '验收房间', x: 0, y: 0, w: 5000, h: 4000, thickness: 120, height: 2700 }));
  const envelope = JSON.parse(serializeProjectFile(project)) as Record<string, unknown>;
  Object.assign(envelope, {
    workspaceId: 'ws_draft_http_retry',
    owner: 'local-open',
    account: 'local-open',
    liveModelVersion: 41,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(workspacePath, JSON.stringify(envelope, null, 2), 'utf8');
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return probe.close(() => reject(new Error('无法分配本地端口')));
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(): Promise<number> {
  const port = await allocatePort();
  const childTemp = join(tempRoot, 'server-tmp');
  mkdirSync(childTemp, { recursive: true });
  childLog = '';
  child = spawn(process.execPath, [join(appRoot, 'server/server.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_ENV_PATH: join(tempRoot, '.env'),
      APP_ACCOUNTS_PATH: join(tempRoot, 'accounts.json'),
      APP_AUDIT_PATH: join(tempRoot, 'audit.jsonl'),
      APP_MEM_PATH: join(tempRoot, 'corrections.jsonl'),
      APP_REGISTRATIONS_PATH: join(tempRoot, 'registrations.json'),
      APP_WORKSPACE_PATH: workspacePath,
      TMPDIR: childTemp,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data: Buffer) => { childLog += data.toString(); });
  child.stderr?.on('data', (data: Buffer) => { childLog += data.toString(); });
  for (let attempt = 0; attempt < 180; attempt++) {
    await wait(100);
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/workspace`);
      if (response.ok) return port;
    } catch { /* service is starting */ }
  }
  throw new Error(`独立 HTTP 服务启动失败：${childLog}`);
}

async function stopServer(): Promise<void> {
  const current = child;
  child = null;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try { current.kill('SIGKILL'); } catch { /* already exited */ }
      resolve();
    }, 3000);
    current.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    try { current.kill('SIGTERM'); } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

interface HttpResult { status: number; json: Record<string, any> | null; text: string }
async function api(port: number, path: string, method = 'GET', body?: unknown): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: Record<string, any> | null = null;
  try { json = JSON.parse(text) as Record<string, any>; } catch { /* included in result */ }
  return { status: response.status, json, text };
}

async function mcp(port: number, method: string, params: unknown): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: requestId++, method, params }),
  });
  const raw = await response.text();
  let json: any = null;
  try { json = JSON.parse(raw); } catch {
    const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith('data:'));
    if (dataLine) {
      try { json = JSON.parse(dataLine.slice(5).trim()); } catch { /* reported below */ }
    }
  }
  if (!response.ok || !json) throw new Error(`MCP HTTP ${response.status}: ${raw.slice(0, 500)}`);
  return json;
}

async function callTool(port: number, name: string, args: unknown): Promise<Record<string, any>> {
  const result = await mcp(port, 'tools/call', { name, arguments: args });
  if (result?.result?.isError) throw new Error(`MCP ${name} 失败：${result.result.content?.[0]?.text ?? JSON.stringify(result)}`);
  const text = result?.result?.content?.find((part: any) => typeof part.text === 'string')?.text;
  if (typeof text !== 'string') throw new Error(`MCP ${name} 没有返回文本：${JSON.stringify(result)}`);
  return JSON.parse(text) as Record<string, any>;
}

async function createCabinetDraft(port: number, name: string, existingDraftId?: string): Promise<{ draftId: string; cabinetId: string }> {
  const args: Record<string, unknown> = {
    name,
    roomId: 'room_draft_retry',
    width: 700,
    height: 2100,
    depth: 600,
    x: 300 + (requestId % 5) * 850,
    y: 80,
  };
  if (existingDraftId) args.draftId = existingDraftId;
  const result = await callTool(port, 'cad.create_cabinet', args);
  if (result.ok !== true || typeof result.draftId !== 'string') throw new Error(`MCP 创建 draft 失败：${JSON.stringify(result)}`);
  return { draftId: result.draftId, cabinetId: String(result.cabinetId ?? '') };
}

function draftFile(draftId: string): string {
  const safe = draftId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(draftsDir, `${safe}.json`);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function confirmationMetadata(draft: Record<string, any>, syncId: string, localVersion = 0): Record<string, unknown> {
  return {
    syncId,
    runId: draft.runId,
    draftId: draft.draftId,
    revision: draft.revision,
    draftHash: draft.draftHash,
    localVersion,
    remoteVersion: draft.liveModelVersion,
    baseModelVersion: draft.baseModelVersion,
    baseProjectHash: draft.baseProjectHash,
  };
}

interface DroppedResponseProxy {
  server: HttpServer;
  port: number;
  dropped: boolean;
  upstreamStatus: number | null;
  upstreamBody: Record<string, any> | null;
}
async function startDropResponseProxy(upstreamPort: number, matchPath: string): Promise<DroppedResponseProxy> {
  const state: DroppedResponseProxy = { server: createHttpServer(), port: 0, dropped: false, upstreamStatus: null, upstreamBody: null };
  state.server.on('request', (incoming, outgoing) => {
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: upstreamPort,
      path: incoming.url,
      method: incoming.method,
      headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: Record<string, any> | null = null;
        try { parsed = JSON.parse(raw) as Record<string, any>; } catch { /* proxy response may be non-JSON */ }
        const shouldDrop = !state.dropped && incoming.method === 'POST' && String(incoming.url).includes(matchPath);
        if (shouldDrop) {
          state.dropped = true;
          state.upstreamStatus = response.statusCode ?? null;
          state.upstreamBody = parsed;
          // Upstream completed successfully, but the client receives no HTTP response bytes.
          outgoing.destroy();
          return;
        }
        const forwarded: Record<string, string | string[]> = {};
        for (const [key, value] of Object.entries(response.headers)) {
          if (value !== undefined && !['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(key.toLowerCase())) {
            forwarded[key] = value;
          }
        }
        outgoing.writeHead(response.statusCode ?? 502, forwarded);
        outgoing.end(Buffer.concat(chunks));
      });
    });
    upstream.on('error', (error) => {
      if (!outgoing.destroyed) {
        outgoing.writeHead(502, { 'Content-Type': 'text/plain' });
        outgoing.end(String(error));
      }
    });
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    state.server.once('error', reject);
    state.server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = state.server.address();
  if (!address || typeof address === 'string') throw new Error('响应丢弃代理未能监听');
  state.port = address.port;
  return state;
}

async function main(): Promise<void> {
  seedWorkspace();
  let port = await startServer();
  try {
    section('A. preview/apply 间 live 变化必须标 stale 并 fail-closed');
    const initial = (await api(port, '/api/workspace')).json!;
    const staleDraft = await createCabinetDraft(port, 'STALE_DRAFT_SENTINEL');
    const concurrentDraft = await createCabinetDraft(port, 'LIVE_CHANGE_SENTINEL');
    const initialDrafts = (await api(port, '/api/drafts')).json!;
    const staleSummary = initialDrafts.drafts?.find((draft: any) => draft.draftId === staleDraft.draftId);
    check('MCP 创建时记录 live version/hash，HTTP 列表初始标记 fresh', staleSummary?.baseModelVersion === initial.liveModelVersion
      && staleSummary?.baseProjectHash === initial.projectSnapshotHash
      && staleSummary?.liveProjectHash === initial.projectSnapshotHash
      && typeof staleSummary?.runId === 'string' && staleSummary.runId !== staleDraft.draftId && staleSummary?.revision === 1
      && typeof staleSummary?.draftHash === 'string' && staleSummary?.isStale === false && staleSummary?.canApply === true,
    `runId=${staleSummary?.runId}; revision=${staleSummary?.revision}; base=${staleSummary?.baseModelVersion}/${String(staleSummary?.baseProjectHash).slice(0, 12)}; live=${initial.liveModelVersion}/${String(initial.projectSnapshotHash).slice(0, 12)}`);

    const requiredDraft = await createCabinetDraft(port, 'REQUIRED_METADATA_SENTINEL');
    const requiredPreview = (await api(port, `/api/drafts/${encodeURIComponent(requiredDraft.draftId)}`)).json!;
    const requiredBefore = (await api(port, '/api/workspace')).json!;
    const requiredFields = ['runId', 'draftId', 'revision', 'draftHash', 'localVersion', 'remoteVersion'];
    const emptyMetadata = await api(port, `/api/drafts/${encodeURIComponent(requiredDraft.draftId)}/apply`, 'POST', {});
    const emptyAfter = (await api(port, '/api/workspace')).json!;
    check('空 body 被拒绝并指出全部缺失确认字段，live 与 draft 均不变', emptyMetadata.status === 400
      && emptyMetadata.json?.code === 'APPLY_METADATA_REQUIRED'
      && requiredFields.every((field) => emptyMetadata.json?.missingFields?.includes(field))
      && deepEqual(emptyAfter, requiredBefore)
      && (await api(port, `/api/drafts/${encodeURIComponent(requiredDraft.draftId)}`)).status === 200,
    `status=${emptyMetadata.status}; missing=${emptyMetadata.json?.missingFields?.join(',')}; version=${requiredBefore.liveModelVersion}->${emptyAfter.liveModelVersion}`);
    for (const field of requiredFields) {
      const body = confirmationMetadata(requiredPreview, `missing-${field}`) as Record<string, unknown>;
      delete body[field];
      const rejected = await api(port, `/api/drafts/${encodeURIComponent(requiredDraft.draftId)}/apply`, 'POST', body);
      const afterMissing = (await api(port, '/api/workspace')).json!;
      const draftStillThere = await api(port, `/api/drafts/${encodeURIComponent(requiredDraft.draftId)}`);
      check(`缺少 ${field} 返回 APPLY_METADATA_REQUIRED 且 live/draft 零变化`, rejected.status === 400
        && rejected.json?.code === 'APPLY_METADATA_REQUIRED'
        && rejected.json?.missingFields?.includes(field)
        && deepEqual(afterMissing, requiredBefore)
        && draftStillThere.status === 200
        && draftStillThere.json?.revision === requiredPreview.revision
        && draftStillThere.json?.draftHash === requiredPreview.draftHash,
      `status=${rejected.status}; missing=${rejected.json?.missingFields?.join(',')}; liveHash=${afterMissing.projectSnapshotHash}`);
    }

    const staleConfirmation = (await api(port, `/api/drafts/${encodeURIComponent(staleDraft.draftId)}`)).json!;
    const beforeBadConfirmation = (await api(port, '/api/workspace')).json!;
    const badHash = await api(port, `/api/drafts/${encodeURIComponent(staleDraft.draftId)}/apply`, 'POST', {
      ...confirmationMetadata(staleConfirmation, 'bad-preview-hash'),
      draftHash: 'f'.repeat(64),
    });
    const afterBadConfirmation = (await api(port, '/api/workspace')).json!;
    check('apply 拒绝不匹配的预览 hash，live 完全不变', badHash.status === 409 && badHash.json?.code === 'DRAFT_STALE'
      && afterBadConfirmation.liveModelVersion === beforeBadConfirmation.liveModelVersion
      && afterBadConfirmation.projectSnapshotHash === beforeBadConfirmation.projectSnapshotHash,
    `status=${badHash.status}; code=${badHash.json?.code}; version=${beforeBadConfirmation.liveModelVersion}->${afterBadConfirmation.liveModelVersion}`);

    const concurrentPreview = (await api(port, `/api/drafts/${encodeURIComponent(concurrentDraft.draftId)}`)).json!;
    const liveApply = await api(port, `/api/drafts/${encodeURIComponent(concurrentDraft.draftId)}/apply`, 'POST',
      confirmationMetadata(concurrentPreview, 'live-change-confirmation'));
    const afterLiveApply = (await api(port, '/api/workspace')).json!;
    check('另一份 draft 成功 apply 后 live 柜数/version 各增加一次', liveApply.status === 200
      && afterLiveApply.liveModelVersion === initial.liveModelVersion + 1
      && afterLiveApply.project.cabinets.length === initial.project.cabinets.length + 1
      && afterLiveApply.project.cabinets.some((cabinet: any) => cabinet.name === 'LIVE_CHANGE_SENTINEL'),
    `status=${liveApply.status}; cabinets=${afterLiveApply.project.cabinets.length}; version=${afterLiveApply.liveModelVersion}`);

    const preview = await api(port, `/api/drafts/${encodeURIComponent(staleDraft.draftId)}`);
    check('live 改变后 draft preview 立即返回 stale/hash mismatch 且禁止 apply', preview.status === 200
      && preview.json?.isStale === true && preview.json?.canApply === false
      && preview.json?.baseProjectHash === initial.projectSnapshotHash
      && preview.json?.liveProjectHash === afterLiveApply.projectSnapshotHash,
    `stale=${preview.json?.isStale}; reason=${preview.json?.staleReason}; canApply=${preview.json?.canApply}`);
    const beforeConflict = (await api(port, '/api/workspace')).json!;
    const staleApply = await api(port, `/api/drafts/${encodeURIComponent(staleDraft.draftId)}/apply`, 'POST',
      confirmationMetadata(staleConfirmation, 'stale-confirmation'));
    const afterConflict = (await api(port, '/api/workspace')).json!;
    check('stale apply 返回明确 409 DRAFT_STALE，live 项目/hash/version 完全不变', staleApply.status === 409
      && staleApply.json?.code === 'DRAFT_STALE'
      && typeof staleApply.json?.baseProjectHash === 'string'
      && typeof staleApply.json?.currentProjectHash === 'string'
      && afterConflict.liveModelVersion === beforeConflict.liveModelVersion
      && afterConflict.projectSnapshotHash === beforeConflict.projectSnapshotHash
      && afterConflict.project.cabinets.length === beforeConflict.project.cabinets.length,
    `status=${staleApply.status}; code=${staleApply.json?.code}; version=${beforeConflict.liveModelVersion}->${afterConflict.liveModelVersion}; cabinets=${beforeConflict.project.cabinets.length}->${afterConflict.project.cabinets.length}`);

    section('A2. 预览确认期间 draft revision/hash 前进，旧确认拒绝且不应用新版');
    const racingDraft = await createCabinetDraft(port, 'RACE_OLD_PREVIEW_SENTINEL');
    const oldPreview = (await api(port, `/api/drafts/${encodeURIComponent(racingDraft.draftId)}`)).json!;
    const liveBeforeRevisionRace = (await api(port, '/api/workspace')).json!;
    const advanced = await createCabinetDraft(port, 'RACE_NEW_REVISION_SENTINEL', racingDraft.draftId);
    const newPreview = (await api(port, `/api/drafts/${encodeURIComponent(racingDraft.draftId)}`)).json!;
    check('同一 draft 后续操作推进 revision 与 hash，预览反映新版内容', advanced.draftId === racingDraft.draftId
      && newPreview.revision > oldPreview.revision
      && newPreview.draftHash !== oldPreview.draftHash
      && newPreview.project.cabinets.some((cabinet: any) => cabinet.name === 'RACE_NEW_REVISION_SENTINEL'),
    `revision=${oldPreview.revision}->${newPreview.revision}; hash=${String(oldPreview.draftHash).slice(0, 12)}->${String(newPreview.draftHash).slice(0, 12)}`);
    const oldConfirmation = await api(port, `/api/drafts/${encodeURIComponent(racingDraft.draftId)}/apply`, 'POST',
      confirmationMetadata(oldPreview, 'old-preview-must-not-apply', 19));
    const afterOldConfirmation = (await api(port, '/api/workspace')).json!;
    check('旧预览确认返回 409 DRAFT_STALE，不写入新版也不改变 live', oldConfirmation.status === 409
      && oldConfirmation.json?.code === 'DRAFT_STALE'
      && deepEqual(afterOldConfirmation, liveBeforeRevisionRace)
      && !afterOldConfirmation.project.cabinets.some((cabinet: any) => cabinet.name === 'RACE_NEW_REVISION_SENTINEL')
      && (await api(port, `/api/drafts/${encodeURIComponent(racingDraft.draftId)}`)).status === 200,
    `status=${oldConfirmation.status}; code=${oldConfirmation.json?.code}; version=${liveBeforeRevisionRace.liveModelVersion}->${afterOldConfirmation.liveModelVersion}`);
    const confirmedNewPreview = (await api(port, `/api/drafts/${encodeURIComponent(racingDraft.draftId)}`)).json!;
    const newConfirmation = await api(port, `/api/drafts/${encodeURIComponent(racingDraft.draftId)}/apply`, 'POST',
      confirmationMetadata(confirmedNewPreview, 'new-preview-explicit-confirm', 20));
    const afterNewConfirmation = (await api(port, '/api/workspace')).json!;
    check('重新读取新版预览并以新版元数据显式确认后才成功应用', newConfirmation.status === 200
      && newConfirmation.json?.revision === confirmedNewPreview.revision
      && newConfirmation.json?.draftHash === confirmedNewPreview.draftHash
      && afterNewConfirmation.liveModelVersion === liveBeforeRevisionRace.liveModelVersion + 1
      && afterNewConfirmation.project.cabinets.some((cabinet: any) => cabinet.name === 'RACE_NEW_REVISION_SENTINEL'),
    `status=${newConfirmation.status}; confirmed revision=${newConfirmation.json?.revision}; version=${liveBeforeRevisionRace.liveModelVersion}->${afterNewConfirmation.liveModelVersion}`);

    section('B. 服务端成功、响应丢失、重启后同 syncId 重试');
    const retryDraft = await createCabinetDraft(port, 'RESPONSE_LOST_SENTINEL');
    const beforeRetryApply = (await api(port, '/api/workspace')).json!;
    check('apply 前持久化草稿文件存在', existsSync(draftFile(retryDraft.draftId)), draftFile(retryDraft.draftId));
    const retrySyncId = 'response-lost-retry-v1';
    const retryPreview = (await api(port, `/api/drafts/${encodeURIComponent(retryDraft.draftId)}`)).json!;
    const retryConfirmation = confirmationMetadata(retryPreview, retrySyncId, 17);
    const proxy = await startDropResponseProxy(port, `/api/drafts/${encodeURIComponent(retryDraft.draftId)}/apply`);
    let clientSawResponse = false;
    try {
      const lost = await fetch(`http://127.0.0.1:${proxy.port}/api/drafts/${encodeURIComponent(retryDraft.draftId)}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryConfirmation),
      });
      clientSawResponse = true;
      await lost.arrayBuffer();
    } catch { /* expected: proxy discards the completed upstream response */ }
    const afterLostResponse = (await api(port, '/api/workspace')).json!;
    check('代理丢弃客户端响应，但服务器已成功提交且只增一柜/一版', !clientSawResponse
      && proxy.dropped && proxy.upstreamStatus === 200 && proxy.upstreamBody?.syncId === retrySyncId
      && afterLostResponse.liveModelVersion === beforeRetryApply.liveModelVersion + 1
      && afterLostResponse.project.cabinets.length === beforeRetryApply.project.cabinets.length + 1
      && afterLostResponse.project.cabinets.some((cabinet: any) => cabinet.name === 'RESPONSE_LOST_SENTINEL'),
    `dropped=${proxy.dropped}; upstream=${proxy.upstreamStatus}; version=${beforeRetryApply.liveModelVersion}->${afterLostResponse.liveModelVersion}`);
    check('apply 成功返回前草稿持久文件已删除', !existsSync(draftFile(retryDraft.draftId)), draftFile(retryDraft.draftId));
    const firstReceipt = proxy.upstreamBody;
    await new Promise<void>((resolve) => proxy.server.close(() => resolve()));

    await stopServer();
    port = await startServer();
    const afterRestartDrafts = (await api(port, '/api/drafts')).json!;
    check('server restart 后已应用 draft 与 stale draft 均未复活', !afterRestartDrafts.drafts?.some((draft: any) => [retryDraft.draftId, staleDraft.draftId].includes(draft.draftId))
      && !existsSync(draftFile(retryDraft.draftId)) && !existsSync(draftFile(staleDraft.draftId)),
    `drafts=${afterRestartDrafts.drafts?.length ?? 'n/a'}; appliedFile=${existsSync(draftFile(retryDraft.draftId))}; staleFile=${existsSync(draftFile(staleDraft.draftId))}`);

    const retry = await api(port, `/api/drafts/${encodeURIComponent(retryDraft.draftId)}/apply`, 'POST', retryConfirmation);
    const afterRetry = (await api(port, '/api/workspace')).json!;
    check('跨 restart 同 syncId 重试返回同一收据，柜数/version 不再次增加', retry.status === 200
      && deepEqual(retry.json, firstReceipt)
      && afterRetry.liveModelVersion === afterLostResponse.liveModelVersion
      && afterRetry.project.cabinets.length === afterLostResponse.project.cabinets.length,
    `status=${retry.status}; version=${afterLostResponse.liveModelVersion}->${afterRetry.liveModelVersion}; cabinets=${afterLostResponse.project.cabinets.length}->${afterRetry.project.cabinets.length}`);

    section('C. 并发重复 apply 和 discard/restart');
    const duplicateDraft = await createCabinetDraft(port, 'CONCURRENT_APPLY_SENTINEL');
    const beforeConcurrent = (await api(port, '/api/workspace')).json!;
    const duplicatePath = `/api/drafts/${encodeURIComponent(duplicateDraft.draftId)}/apply`;
    const duplicatePreview = (await api(port, `/api/drafts/${encodeURIComponent(duplicateDraft.draftId)}`)).json!;
    const duplicateConfirmation = confirmationMetadata(duplicatePreview, 'parallel-same-sync-id', 18);
    const [duplicateA, duplicateB] = await Promise.all([
      api(port, duplicatePath, 'POST', duplicateConfirmation),
      api(port, duplicatePath, 'POST', duplicateConfirmation),
    ]);
    const afterConcurrent = (await api(port, '/api/workspace')).json!;
    check('并发同 syncId 双 apply 返回相同成功结果且只写入一次', duplicateA.status === 200 && duplicateB.status === 200
      && deepEqual(duplicateA.json, duplicateB.json)
      && afterConcurrent.liveModelVersion === beforeConcurrent.liveModelVersion + 1
      && afterConcurrent.project.cabinets.length === beforeConcurrent.project.cabinets.length + 1
      && afterConcurrent.project.cabinets.filter((cabinet: any) => cabinet.name === 'CONCURRENT_APPLY_SENTINEL').length === 1,
    `statuses=${duplicateA.status}/${duplicateB.status}; versions=${beforeConcurrent.liveModelVersion}->${afterConcurrent.liveModelVersion}; cabinets=${beforeConcurrent.project.cabinets.length}->${afterConcurrent.project.cabinets.length}`);

    const discardDraft = await createCabinetDraft(port, 'DISCARD_SENTINEL');
    check('discard 前持久化草稿文件存在', existsSync(draftFile(discardDraft.draftId)));
    const discarded = await api(port, `/api/drafts/${encodeURIComponent(discardDraft.draftId)}/discard`, 'POST', {});
    check('HTTP discard 返回成功并立即删除/tombstone 持久文件', discarded.status === 200
      && discarded.json?.ok === true && !existsSync(draftFile(discardDraft.draftId)),
    `status=${discarded.status}; fileExists=${existsSync(draftFile(discardDraft.draftId))}`);
    const beforeDiscardRestart = (await api(port, '/api/workspace')).json!;
    await stopServer();
    port = await startServer();
    const afterDiscardRestart = (await api(port, '/api/drafts')).json!;
    const afterDiscardWorkspace = (await api(port, '/api/workspace')).json!;
    check('discard draft 重启后不复活且 live 柜数/version 未变化', !afterDiscardRestart.drafts?.some((draft: any) => draft.draftId === discardDraft.draftId)
      && afterDiscardWorkspace.liveModelVersion === beforeDiscardRestart.liveModelVersion
      && afterDiscardWorkspace.project.cabinets.length === beforeDiscardRestart.project.cabinets.length,
    `draftPresent=${afterDiscardRestart.drafts?.some((draft: any) => draft.draftId === discardDraft.draftId)}; version=${beforeDiscardRestart.liveModelVersion}->${afterDiscardWorkspace.liveModelVersion}`);

    console.log(`\nDraft HTTP failure/retry acceptance: ${pass} passed, ${fail} failed`);
    if (fail > 0) throw new Error(`验收失败：${fail} 项（${failures.join('；')}）`);
  } finally {
    await stopServer();
    if (existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  if (childLog) console.error(`\n--- isolated server log ---\n${childLog.slice(-5000)}`);
  process.exitCode = 1;
});
