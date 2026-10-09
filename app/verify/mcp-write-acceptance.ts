/**
 * ══════════════════════════════════════════════════════════════════════
 *  P10.0 · S4/S5 专项验收（MCP 写工具 + draft）
 *
 *  全部走**真 HTTP**（spawn 真实 server.mjs + 真 fetch），不 mock 任何一层。
 *  规格硬编码在本文件（不 import 被测的 ALLOWED_TOOLS / WRITE_TOOLS）。
 *
 *  ── 反假绿 ──
 *   ① 工具清单硬编码 10 个，不读源码 —— 加工具不更新验收就红。
 *   ② 权限：禁止的组合必须同时断言"模型一字节未变"（只判 FORBIDDEN 会漏
 *      "先改了再返回 403"这种最坏的实现错误）。
 *   ③ 写隔离：写工具调用前后 liveModelVersion + project 快照逐字节一致。
 *   ④ draft 持久化：落盘 → 杀进程 → 重启 → draft 必须还在（§8.3）。
 *   ⑤ DRAFT_STALE：版本对不上必须结构化拒绝，不许自动 merge。
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AuthStore } from '../server/auth.mjs';
import { emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import type { Project, RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const RULES = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

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
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('无法获取临时测试端口')));
        return;
      }
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

// ── 规格（硬编码） ──
const EXPECTED_TOOLS = [
  'cad.get_state',
  'cad.validate',
  'cad.create_cabinet',
  'cad.create_assembly',
  'cad.place_cabinet',
  'cad.update_object',
  'cad.delete_object',
  'cad.submit_proposal',
  'cad.list_drafts',
  'cad.apply_draft',
  'cad.discard_draft',
  'cad.create_room',
  'cad.draw_wall',
  'cad.duplicate_object',
  'cad.export_dxf',
  'cad.export_bom_csv',
  'cad.export_roombook',
  'cad.export_pdf',
];
/** 明令禁止的工具词根：目前无（S6 已做，IR-3 已开放）。保留空数组占位。 */
const FORBIDDEN_ROOTS = [];

// ── 夹具 ──
const TMP = mkdtempSync(join(tmpdir(), 'furnicad-s45-'));
const children: ChildProcess[] = [];
function cleanup(): void {
  for (const child of children) { try { child.kill(); } catch {} }
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}
process.once('exit', cleanup);

interface Fixture { port: number; child: ChildProcess; dir: string; auditPath: string; wsPath: string }

function seedAccounts(dir: string): void {
  const a = new AuthStore({ accountsPath: join(dir, 'accounts.json'), auditPath: join(dir, 'audit.jsonl') });
  a.create({ username: 'owner', password: 'owner-pass-1234', actor: 'bootstrap' });
  a.create({ username: 'admin', password: 'admin-pass-1234', role: 'admin', actor: 'owner' });
  a.create({ username: 'designer', password: 'des-pass-1234', role: 'designer', actor: 'owner' });
  a.create({ username: 'viewer', password: 'view-pass-1234', role: 'viewer', actor: 'owner' });
}

function seedWorkspace(wsPath: string): void {
  const p = emptyProject({ ruleSetId: 'factory_default_v1' });
  p.name = 'S4S5 验收夹具';
  p.rooms.push(rectRoom({ name: '客厅', x: 0, y: 0, w: 5000, h: 4000, id: 'room_1' }));
  const env = JSON.parse(serializeProjectFile(p)) as Record<string, unknown>;
  env.workspaceId = 'ws_s45';
  env.owner = 'owner';
  env.account = 'owner';
  env.liveModelVersion = 0;
  env.updatedAt = new Date().toISOString();
  writeFileSync(wsPath, JSON.stringify(env, null, 2), 'utf8');
}

async function startServer(dir: string): Promise<Fixture> {
  const accountsPath = join(dir, 'accounts.json');
  const auditPath = join(dir, 'audit.jsonl');
  const wsPath = join(dir, 'workspace.json');
  const port = await allocatePort();
  const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_ACCOUNTS_PATH: accountsPath,
      APP_AUDIT_PATH: auditPath,
      APP_WORKSPACE_PATH: wsPath,
      APP_MEM_PATH: join(dir, 'corrections.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout?.on('data', (d: Buffer) => (log += d.toString()));
  child.stderr?.on('data', (d: Buffer) => (log += d.toString()));
  for (let i = 0; i < 150; i++) {
    await wait(100);
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return { port, child, dir, auditPath, wsPath };
    } catch {}
  }
  throw new Error(`server 未就绪（port=${port}）\n${log}`);
}

function headers(token?: string | null): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function api(port: number, path: string, init: { method?: string; token?: string | null; body?: unknown } = {}) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? 'POST',
      headers: headers(init.token),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await r.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: `连接失败：${String((e as Error)?.message ?? e)}` };
  }
}

async function mcp(port: number, body: unknown, token?: string | null) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { ...headers(token), Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: `连接失败：${String((e as Error)?.message ?? e)}` };
  }
}

function toolPayload(json: any): any {
  const t = json?.result?.content?.[0]?.text;
  if (typeof t !== 'string') return null;
  try { return JSON.parse(t); } catch { return { __unparsed: t }; }
}
const isErr = (json: any) => json?.result?.isError === true;

async function callTool(port: number, token: string, name: string, args: unknown) {
  const r = await mcp(port, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token);
  return { ...r, payload: toolPayload(r.json), err: isErr(r.json) };
}

// ── 主流程 ──
const dir = mkdtempSync(join(TMP, 'srv-'));
seedAccounts(dir);
seedWorkspace(join(dir, 'workspace.json'));
let F = await startServer(dir);
let port = F.port;

const login = async (u: string, p: string) => (await api(port, '/api/auth/login', { body: { username: u, password: p } })).json?.token as string;
const T_OWNER = await login('owner', 'owner-pass-1234');
const accList = await api(port, '/api/account/accounts', { method: 'GET', token: T_OWNER });
const accounts: any[] = accList.json?.accounts ?? [];
const idOf = (u: string) => accounts.find((a: any) => a.username === u)?.id ?? '';
const mkPat = async (username: string) => {
  const r = await api(port, '/api/account/tokens', { token: T_OWNER, body: { accountId: idOf(username), label: `s45-${username}` } });
  return r.json?.token as string;
};
const PAT_OWNER = await mkPat('owner');
const PAT_ADMIN = await mkPat('admin');
const PAT_DESIGNER = await mkPat('designer');
const PAT_VIEWER = await mkPat('viewer');
const draftDirFor = (username: string) => join(dir, 'workspaces', idOf(username), 'drafts');
const draftFilesFor = (username: string) => {
  const path = draftDirFor(username);
  return existsSync(path) ? readdirSync(path) : [];
};

const getState = async (token: string) => (await callTool(port, token, 'cad.get_state', {})).payload;
async function applyConfirmation(token: string, draftId: string): Promise<Record<string, unknown>> {
  const listing = await callTool(port, token, 'cad.list_drafts', {});
  const draft = listing.payload?.drafts?.find((item: any) => item.draftId === draftId);
  if (!draft) throw new Error(`no list_drafts preview for ${draftId}`);
  return {
    draftId: draft.draftId,
    runId: draft.runId,
    revision: draft.revision,
    draftHash: draft.draftHash,
    localVersion: 0,
    remoteVersion: draft.liveModelVersion,
  };
}
const snapOf = async (token: string) => {
  const s = await getState(token);
  return JSON.stringify({ v: s?.liveModelVersion, p: s?.project });
};

section('① 工具清单');
{
  const r = await mcp(port, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, PAT_VIEWER);
  const names = (r.json?.result?.tools ?? []).map((t: any) => t.name);
  ok('①1 tools/list 恰好 = 16 个工具（规格硬编码，顺序无关）',
    JSON.stringify([...names].sort()) === JSON.stringify([...EXPECTED_TOOLS].sort()), JSON.stringify(names));
  ok('①2 无 S6 词根（export_*）', names.every((n: string) => !FORBIDDEN_ROOTS.some((x) => n.includes(x))), JSON.stringify(names));
}

section('② 权限矩阵（禁止组合：FORBIDDEN + 模型一字节未变）');
{
  const viewerBefore = await snapOf(PAT_VIEWER);
  const designerBefore = await snapOf(PAT_DESIGNER);
  const v1 = await callTool(port, PAT_VIEWER, 'cad.create_cabinet', { name: '非法柜' });
  ok('②1 viewer 调 create_cabinet → FORBIDDEN', v1.err && v1.payload?.code === 'FORBIDDEN', JSON.stringify(v1.payload)?.slice(0, 120));
  ok('②2 被拒后 viewer 工作区未变', (await snapOf(PAT_VIEWER)) === viewerBefore);
  const v2 = await callTool(port, PAT_VIEWER, 'cad.apply_draft', { draftId: 'draft_x', runId: 'run_x', revision: 0, draftHash: '0'.repeat(64), localVersion: 0, remoteVersion: 0 });
  ok('②3 viewer 调 apply_draft → FORBIDDEN', v2.err && v2.payload?.code === 'FORBIDDEN', JSON.stringify(v2.payload)?.slice(0, 120));
  const d1 = await callTool(port, PAT_DESIGNER, 'cad.apply_draft', { draftId: 'draft_x', runId: 'run_x', revision: 0, draftHash: '0'.repeat(64), localVersion: 0, remoteVersion: 0 });
  ok('②4 designer 调 apply_draft → FORBIDDEN（要 admin+）', d1.err && d1.payload?.code === 'FORBIDDEN', JSON.stringify(d1.payload)?.slice(0, 120));
  ok('②5 被拒请求未改变 viewer/designer 工作区', (await snapOf(PAT_VIEWER)) === viewerBefore && (await snapOf(PAT_DESIGNER)) === designerBefore);
  const v3 = await callTool(port, PAT_VIEWER, 'cad.list_drafts', {});
  ok('②6 viewer 可调 list_drafts（读）', !v3.err && Array.isArray(v3.payload?.drafts), JSON.stringify(v3.payload)?.slice(0, 120));
}

section('③ 写隔离：写工具只进 draft，live 不动');
let DRAFT = '';
let CAB = '';
{
  const before = await snapOf(PAT_DESIGNER);
  const c = await callTool(port, PAT_DESIGNER, 'cad.create_cabinet', { name: '隔离柜', width: 1500 });
  ok('③1 designer 建柜成功', !c.err && !!c.payload?.draftId, JSON.stringify(c.payload)?.slice(0, 160));
  DRAFT = c.payload.draftId; CAB = c.payload.cabinetId;
  ok('③2 建柜后 designer 的 live 未变', (await snapOf(PAT_DESIGNER)) === before, `live 应仍 ${JSON.parse(before).v}`);
  const u = await callTool(port, PAT_DESIGNER, 'cad.update_object', { targetId: CAB, targetType: 'cabinet', field: 'width', value: 1600, draftId: DRAFT });
  ok('③3 draft 内改宽成功', !u.err, JSON.stringify(u.payload)?.slice(0, 160));
  ok('③4 改宽后 live 仍未变', (await snapOf(PAT_DESIGNER)) === before);
  const draftFiles = draftFilesFor('designer');
  ok('③5 draft 文件已落盘', draftFiles.some((f) => f.startsWith(DRAFT)), draftFiles.join(','));
}

section('④ draft 持久化：杀进程 → 重启 → draft 还在');
{
  F.child.kill();
  await wait(800);
  const F2 = await startServer(dir);
  const port2 = F2.port;
  const l = await callTool(port2, PAT_DESIGNER, 'cad.list_drafts', {});
  ok('④1 重启后 list_drafts 找回 draft', !l.err && l.payload?.drafts?.some((d: any) => d.draftId === DRAFT), JSON.stringify(l.payload?.drafts?.map((d: any) => d.draftId)));
  const st = await getState(PAT_DESIGNER);
  void st;
  // 后继测试走新 server
  F = F2;
  port = port2;
}

section('⑤ apply 乐观锁');
{
  // 同一账号工作区内建立两个同 base 版本的 draft，提交其一后另一个必须过期。
  const dNew = await callTool(port, PAT_ADMIN, 'cad.create_cabinet', { name: '新柜' });
  const dStale = await callTool(port, PAT_ADMIN, 'cad.create_cabinet', { name: '过期柜' });
  ok('⑤1 admin 建立基准草稿成功', !dNew.err && !!dNew.payload?.draftId, JSON.stringify(dNew.payload)?.slice(0, 140));
  ok('⑤2 admin 建立并行草稿成功', !dStale.err && !!dStale.payload?.draftId, JSON.stringify(dStale.payload)?.slice(0, 140));
  const exactConfirmation = await applyConfirmation(PAT_ADMIN, dNew.payload?.draftId);
  const guardBefore = await snapOf(PAT_ADMIN);
  const noMetadata = await mcp(port, { jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'cad.apply_draft', arguments: { draftId: dNew.payload?.draftId } } }, PAT_ADMIN);
  const noMetadataRejected = noMetadata.status >= 400 || !!noMetadata.json?.error || noMetadata.json?.result?.isError === true;
  ok('⑤2a MCP schema拒绝无确认字段请求且模型/version零变化', noMetadataRejected && (await snapOf(PAT_ADMIN)) === guardBefore,
    `status=${noMetadata.status}; error=${JSON.stringify(noMetadata.json?.error ?? noMetadata.json?.result?.content)?.slice(0, 160)}`);
  const missingField = { ...exactConfirmation } as Record<string, unknown>;
  delete missingField.draftHash;
  const missingMetadata = await mcp(port, { jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'cad.apply_draft', arguments: missingField } }, PAT_ADMIN);
  const missingRejected = missingMetadata.status >= 400 || !!missingMetadata.json?.error || missingMetadata.json?.result?.isError === true;
  ok('⑤2b MCP schema拒绝缺draftHash请求且模型/version零变化', missingRejected && (await snapOf(PAT_ADMIN)) === guardBefore,
    `status=${missingMetadata.status}; error=${JSON.stringify(missingMetadata.json?.error ?? missingMetadata.json?.result?.content)?.slice(0, 160)}`);
  const wrongHash = await callTool(port, PAT_ADMIN, 'cad.apply_draft', { ...exactConfirmation, draftHash: 'f'.repeat(64) });
  ok('⑤2c MCP handler拒绝伪造hash且模型/version零变化', wrongHash.err && wrongHash.payload?.code === 'DRAFT_STALE'
    && (await snapOf(PAT_ADMIN)) === guardBefore, JSON.stringify(wrongHash.payload)?.slice(0, 180));
  const staleConfirmation = await applyConfirmation(PAT_ADMIN, dStale.payload?.draftId);
  const apNew = await callTool(port, PAT_ADMIN, 'cad.apply_draft', exactConfirmation);
  ok('⑤3 admin apply 自己的新 draft 成功', !apNew.err && apNew.payload?.ok === true, JSON.stringify(apNew.payload)?.slice(0, 140));
  const stale = await callTool(port, PAT_ADMIN, 'cad.apply_draft', staleConfirmation);
  ok('⑤4 旧 draft apply → DRAFT_STALE 结构化拒绝', stale.err && stale.payload?.code === 'DRAFT_STALE', JSON.stringify(stale.payload)?.slice(0, 200));
  ok('⑤5 拒绝体带 baseVersion/currentVersion/hint', stale.payload?.baseVersion !== undefined && stale.payload?.currentVersion !== undefined && !!stale.payload?.hint, JSON.stringify(stale.payload)?.slice(0, 200));
  ok('⑤6 admin stale draft 文件仍在', draftFilesFor('admin').some((f) => f.startsWith(dStale.payload?.draftId)));
  const crossAccount = await callTool(port, PAT_ADMIN, 'cad.apply_draft', { draftId: DRAFT, runId: 'run_cross_account', revision: 0, draftHash: '0'.repeat(64), localVersion: 0, remoteVersion: 0 });
  ok('⑤7 admin 看不到 designer 工作区 draft', crossAccount.err && crossAccount.payload?.code === 'DRAFT_NOT_FOUND', JSON.stringify(crossAccount.payload)?.slice(0, 140));
  ok('⑤8 designer draft 仍保留在自己的工作区', draftFilesFor('designer').some((f) => f.startsWith(DRAFT)));
  // owner 同样在自己的工作区创建并 apply 新 draft
  const liveBefore = (await getState(PAT_OWNER))?.liveModelVersion;
  const dOk = await callTool(port, PAT_OWNER, 'cad.create_cabinet', { name: '终柜', width: 900 });
  const apOk = await callTool(port, PAT_OWNER, 'cad.apply_draft', await applyConfirmation(PAT_OWNER, dOk.payload?.draftId));
  ok('⑤9 owner apply 新鲜 draft 成功且版本 +1', !apOk.err && apOk.payload?.newVersion === liveBefore + 1, JSON.stringify({ ...apOk.payload, liveBefore }));
  ok('⑤10 apply 后 owner draft 文件已删', !draftFilesFor('owner').some((f) => f.startsWith(dOk.payload?.draftId)));
  const s2 = await getState(PAT_OWNER);
  ok('⑤11 owner live 里真有「终柜」', (s2?.project?.cabinets ?? []).some((c: any) => c.name === '终柜'), (s2?.project?.cabinets ?? []).map((c: any) => c.name).join(','));
}

section('⑥ discard 归属');
{
  const d = await callTool(port, PAT_DESIGNER, 'cad.create_cabinet', { name: '待丢柜' });
  const dd = d.payload?.draftId;
  const vDrop = await callTool(port, PAT_VIEWER, 'cad.discard_draft', { draftId: dd });
  ok('⑥1 viewer 看不到其他账号 draft', vDrop.err && vDrop.payload?.code === 'DRAFT_NOT_FOUND', JSON.stringify(vDrop.payload)?.slice(0, 120));
  const oDrop = await callTool(port, PAT_DESIGNER, 'cad.discard_draft', { draftId: dd });
  ok('⑥2 创建者丢自己的 draft → ok', !oDrop.err && oDrop.payload?.ok === true, JSON.stringify(oDrop.payload)?.slice(0, 120));
  ok('⑥3 discard 后 designer 草稿文件已删', !draftFilesFor('designer').some((f) => f.startsWith(dd)));
  const d2 = await callTool(port, PAT_DESIGNER, 'cad.create_cabinet', { name: '待丢柜2' });
  const aDrop = await callTool(port, PAT_ADMIN, 'cad.discard_draft', { draftId: d2.payload?.draftId });
  ok('⑥4 admin 看不到 designer 工作区 draft', aDrop.err && aDrop.payload?.code === 'DRAFT_NOT_FOUND', JSON.stringify(aDrop.payload)?.slice(0, 120));
  ok('⑥5 跨账号尝试后 designer draft 仍保留', draftFilesFor('designer').some((f) => f.startsWith(d2.payload?.draftId)));
  const dAdmin = await callTool(port, PAT_ADMIN, 'cad.create_cabinet', { name: '管理员待丢柜' });
  const aDropOwn = await callTool(port, PAT_ADMIN, 'cad.discard_draft', { draftId: dAdmin.payload?.draftId });
  ok('⑥6 admin 可丢弃自己工作区的 draft', !aDropOwn.err && aDropOwn.payload?.ok === true, JSON.stringify(aDropOwn.payload)?.slice(0, 120));
  ok('⑥7 admin discard 后文件已删', !draftFilesFor('admin').some((f) => f.startsWith(dAdmin.payload?.draftId)));
}

section('⑦ 结构纪律（源码级）');
{
  const writeSrc = stripComments(readFileSync(join(root, 'server', 'mcpWrite.mjs'), 'utf8'));
  const mcpSrc = stripComments(readFileSync(join(root, 'server', 'mcp.mjs'), 'utf8'));
  ok('⑦1 mcpWrite.mjs 不直接调 live 写入口 ws.execute(', !/ws\.execute\(/.test(writeSrc), '出现了 ws.execute(');
  ok('⑦2 无 project 数组直写（push/splice/下标赋值）', !/project\.(cabinets|rooms|walls)\.(push|splice)/.test(writeSrc) && !/project\.(cabinets|rooms|walls)\[/.test(writeSrc));
  ok('⑦3 mcp.mjs（传输层）不直接碰 draft/执行入口', !/\.(execute|draftExecute|applyDraft|createDraft|discardDraft)\(/.test(mcpSrc), '传输层出现了执行入口');
  ok('⑦4 写工具全部走 draftExecute 或既有构造器（无自建 mutation）', !/new Command\(/.test(writeSrc), '出现了 new Command(');
  const auditHits = (readFileSync(join(dir, 'audit.jsonl'), 'utf8').match(/"tool":"cad\.(create_cabinet|apply_draft)"/g) || []).length;
  ok('⑦5 写工具调用进了审计', auditHits >= 2, `命中 ${auditHits} 行`);
  const auditText = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
  ok('⑦6 审计里无 project JSON（只记元数据）', !/"project":\{/.test(auditText));
}

section('⑧ submit_proposal 复用既有链');
{
  const designerProject = (await getState(PAT_DESIGNER))?.project;
  const roomName = designerProject?.rooms?.[0]?.name ?? '主卧';
  const p = await callTool(port, PAT_DESIGNER, 'cad.submit_proposal', {
    proposal: { title: '验收提案', room: roomName, cabinets: [{ ref: 'p1', name: '提案验收柜', width: 1100 }] },
  });
  ok('⑧1 proposal 进 draft', !p.err && !!p.payload?.draftId && p.payload?.steps === 1, JSON.stringify(p.payload)?.slice(0, 200));
  const bad = await callTool(port, PAT_DESIGNER, 'cad.submit_proposal', { proposal: { title: '空', cabinets: [] } });
  ok('⑧2 空 proposal 被拒且不产生 draft', bad.err && bad.payload?.code === 'PROPOSAL_BLOCKED', JSON.stringify(bad.payload)?.slice(0, 160));
}

section('⑨ IR-3：create_room / draw_wall（用户已拍板开放）');
{
  const before = await snapOf(PAT_ADMIN);
  // admin 在自己的工作区创建矩形房间，后续同账号验证 apply。
  const cr = await callTool(port, PAT_ADMIN, 'cad.create_room', { name: '卧室', x: 0, y: 0, w: 3600, h: 3000 });
  ok('⑨1 admin 建矩形房间成功', !cr.err && !!cr.payload?.roomId, JSON.stringify(cr.payload)?.slice(0, 160));
  const roomId = cr.payload.roomId; const dId = cr.payload.draftId;
  ok('⑨2 建房间后 admin live 未变（只进 draft）', (await snapOf(PAT_ADMIN)) === before);
  // 在该房间画一面墙
  const dw = await callTool(port, PAT_ADMIN, 'cad.draw_wall', {
    roomId, start: { x: 0, y: 0 }, end: { x: 3600, y: 0 }, thickness: 120, draftId: dId });
  ok('⑨3 admin 画墙成功', !dw.err && !!dw.payload?.wallId, JSON.stringify(dw.payload)?.slice(0, 160));
  // 起终点相同应被拒
  const bad = await callTool(port, PAT_ADMIN, 'cad.draw_wall', {
    start: { x: 100, y: 100 }, end: { x: 100, y: 100 }, draftId: dId });
  ok('⑨4 零长度墙被拒', bad.err, JSON.stringify(bad.payload)?.slice(0, 120));
  // viewer 建房间应被拒且模型未变
  const viewerBefore = await snapOf(PAT_VIEWER);
  const v = await callTool(port, PAT_VIEWER, 'cad.create_room', { name: '非法房间' });
  ok('⑨5 viewer 建房间 → FORBIDDEN', v.err && v.payload?.code === 'FORBIDDEN', JSON.stringify(v.payload)?.slice(0, 120));
  ok('⑨6 viewer 被拒后工作区未变', (await snapOf(PAT_VIEWER)) === viewerBefore);
  // apply 进 live
  const ap = await callTool(port, PAT_ADMIN, 'cad.apply_draft', await applyConfirmation(PAT_ADMIN, dId));
  ok('⑨7 apply 成功', !ap.err && ap.payload?.ok === true, JSON.stringify(ap.payload)?.slice(0, 120));
  const gs = await getState(PAT_ADMIN);
  const room = (gs?.project?.rooms ?? []).find((r: any) => r.id === roomId);
  ok('⑨8 live 里有新房间且含墙', !!room && room.walls.length >= 5, `walls=${room?.walls?.length}`);
}

section('⑩ S6：export_dxf / export_bom_csv / export_roombook（只读，复用导出链）');
{
  // viewer 可调（只读）
  const dxf = await callTool(port, PAT_VIEWER, 'cad.export_dxf', { which: ['plan'] });
  ok('⑩1 viewer 导出 DXF 成功', !dxf.err && !!dxf.payload?.base64, JSON.stringify(dxf.payload)?.slice(0, 160));
  if (!dxf.err && dxf.payload?.base64) {
    ok('⑩2 DXF 文件名以 .dxf 结尾', dxf.payload?.filename?.endsWith('.dxf'), dxf.payload?.filename);
    const dxfBuf = Buffer.from(dxf.payload.base64, 'base64');
    ok('⑩3 DXF base64 可解码且非空', dxfBuf.length > 100);
    const dxfHead = dxfBuf.slice(0, 200).toString('ascii');
    ok('⑩4 DXF 内容合法（SECTION/HEADER/$ACADVER）', dxfHead.includes('SECTION') && dxfHead.includes('$ACADVER'), dxfHead.slice(0, 60));
  } else {
    ok('⑩2 DXF 文件名以 .dxf 结尾（跳过，导出失败）', false, 'export failed');
    ok('⑩3 DXF base64 可解码且非空（跳过）', false, '');
    ok('⑩4 DXF 内容含 AutoCAD 标记（跳过）', false, '');
  }

  const csv = await callTool(port, PAT_VIEWER, 'cad.export_bom_csv', {});
  ok('⑩5 viewer 导出开料单成功', !csv.err && !!csv.payload?.base64, JSON.stringify(csv.payload)?.slice(0, 120));
  const csvText = Buffer.from(csv.payload.base64, 'base64').toString('utf8');
  ok('⑩6 CSV 含表头（序号/板件ID）', csvText.includes('序号') && csvText.includes('板件ID'), csvText.slice(0, 60));

  const rb = await callTool(port, PAT_VIEWER, 'cad.export_roombook', {});
  ok('⑩7 viewer 导出图纸册成功', !rb.err && !!rb.payload?.base64, JSON.stringify(rb.payload)?.slice(0, 120));
  const rbText = Buffer.from(rb.payload.base64, 'base64').toString('utf8');
  ok('⑩8 图纸册是 HTML', rbText.includes('<html') || rbText.includes('<!DOCTYPE'), rbText.slice(0, 60));

  // 审计只记元数据
  const auditText2 = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
  const exHits = (auditText2.match(/"tool":"cad\.export_dxf"/g) || []).length;
  ok('⑩9 导出进了审计', exHits > 0, `命中 ${exHits} 行`);
  ok('⑩10 审计无文件内容（只记元数据）', !/"base64":"[A-Za-z0-9+\/]{100}/.test(auditText2), '审计里出现了长 base64');
}

section('⑪ duplicate_object：复制柜体');
{
  const before = await snapOf(PAT_ADMIN);
  // 在 admin 自己的工作区创建柜体并完成复制、提交。
  const cc = await callTool(port, PAT_ADMIN, 'cad.create_cabinet', { name: '被复制柜', width: 800, height: 2000, depth: 550 });
  const srcId = cc.payload.cabinetId; const dId = cc.payload.draftId;
  ok('⑪1 建源柜体成功', !cc.err && !!srcId);
  // 复制
  const dp = await callTool(port, PAT_ADMIN, 'cad.duplicate_object', { sourceId: srcId, draftId: dId });
  ok('⑪2 admin 复制成功', !dp.err && !!dp.payload?.newId, JSON.stringify(dp.payload)?.slice(0, 160));
  ok('⑪3 新名默认为"原名 副本"', dp.payload?.newName === '被复制柜 副本', dp.payload?.newName);
  ok('⑪4 新 ID 与源不同', dp.payload?.newId !== srcId);
  ok('⑪5 复制后 admin live 未变', (await snapOf(PAT_ADMIN)) === before);
  // 自定义名复制
  const dp2 = await callTool(port, PAT_ADMIN, 'cad.duplicate_object', { sourceId: srcId, name: '定制名', draftId: dId });
  ok('⑪6 自定义名复制成功', !dp2.err && dp2.payload?.newName === '定制名', JSON.stringify(dp2.payload)?.slice(0, 120));
  // 复制不存在的
  const bad = await callTool(port, PAT_ADMIN, 'cad.duplicate_object', { sourceId: 'nope', draftId: dId });
  ok('⑪7 复制不存在的被拒', bad.err, JSON.stringify(bad.payload)?.slice(0, 120));
  // viewer 被拒
  const v = await callTool(port, PAT_VIEWER, 'cad.duplicate_object', { sourceId: srcId });
  ok('⑪8 viewer 复制 → FORBIDDEN', v.err && v.payload?.code === 'FORBIDDEN');
  // apply 后 live 里有两个
  await callTool(port, PAT_ADMIN, 'cad.apply_draft', await applyConfirmation(PAT_ADMIN, dId));
  const gs = await getState(PAT_ADMIN);
  const cabs = (gs?.project?.cabinets ?? []).filter((c: any) => c.name === '被复制柜 副本' || c.name === '定制名');
  ok('⑪9 apply 后 live 里有两个副本', cabs.length === 2, `found=${cabs.length}`);
}

section('⑫ create_room 已有房间时不撞 id（Bug 3）');
{
  const before = await snapOf(PAT_DESIGNER);
  // 先建一个房间（room_001）
  const r1 = await callTool(port, PAT_DESIGNER, 'cad.create_room', { name: '房间一' });
  ok('⑫1 建第一个房间成功', !r1.err && !!r1.payload?.roomId, r1.payload?.roomId);
  const firstId = r1.payload.roomId;
  // 再建一个，必须成功且 id 不同
  const r2 = await callTool(port, PAT_DESIGNER, 'cad.create_room', { name: '房间二', draftId: r1.payload.draftId });
  ok('⑫2 已有房间时再建成功', !r2.err && !!r2.payload?.roomId, JSON.stringify(r2.payload)?.slice(0, 120));
  ok('⑫3 新房间 id 与第一个不同', r2.payload?.roomId !== firstId, `${firstId} vs ${r2.payload?.roomId}`);
  ok('⑫4 建房间后 designer live 未变（只进 draft）', (await snapOf(PAT_DESIGNER)) === before);
  // 矩形房间同理
  const r3 = await callTool(port, PAT_DESIGNER, 'cad.create_room', { name: '矩形房', x: 0, y: 0, w: 4000, h: 3000, draftId: r1.payload.draftId });
  ok('⑫5 矩形房间也不撞 id', !r3.err && r3.payload?.roomId !== firstId && r3.payload?.roomId !== r2.payload?.roomId, r3.payload?.roomId);
}

for (const c of children) { try { c.kill(); } catch {} }
console.log(`\n────────────────────────────────────────────────────────────\n通过 ${pass} 项，失败 ${fail} 项\n${fail > 0 ? '失败：\n' + failures.map((f) => `  - ${f}`).join('\n') : 'S4/S5 写工具成立：权限矩阵 × draft 隔离 × 持久化 × 乐观锁全部过关。'}`);
process.exit(fail > 0 ? 1 : 0);
