#!/usr/bin/env node
/**
 * 独立真实浏览器验收：历史重复 Unit ID 项目只读浏览与唯一 ID 写入对照。
 *
 * 用法：node --experimental-strip-types verify/historical-unit-id-readonly-ui-acceptance.mjs
 * 本脚本只启动自己的 mock API、Vite 和 Chromium；Vite 的 API_PORT 显式指向 mock API，
 * 不连接、不重启 8787。进程、浏览器 profile 和临时目录均在 finally 中回收。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createServer as createNetServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyProject, createCabinet, rectRoom } from '../src/core/docFactory.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { resizeCabinet } from '../src/core/commands.ts';
import { replaceDrawingEdits } from '../src/core/drawingEdits.ts';
import { saveDraft, clearDraft, loadDraft, setProjectStorageReadOnly } from '../src/state/draftStore.ts';
import { findDuplicateUnitIds, unitIdentityConflictMessage, WORKSPACE_UNIT_ID_CONFLICT } from '../src/core/unitIdentity.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
};
const sameJson = (left, right) => stableJson(left) === stableJson(right);

let passed = 0;
let failed = 0;
const failures = [];
const processes = [];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-unit-id-readonly-ui-'));
let apiServer;
let cdp;
let chrome;
let vite;
let httpFixtureRoot;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = address && typeof address !== 'string' ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('无法分配隔离端口');
  return port;
}

function startProcess(name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child._name = name;
  child._log = '';
  child.stdout?.on('data', (chunk) => { child._log += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { child._log += chunk.toString(); });
  processes.push(child);
  return child;
}

async function waitHttp(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* 服务启动中 */ }
    await wait(100);
  }
  throw new Error(`等待服务超时：${url}`);
}

function buildBaseProject(rules) {
  const project = emptyProject({ id: 'historical_unit_id_ui_fixture', name: '历史 Unit ID 远端项目', ruleSetId: rules.id });
  const room = rectRoom({ id: 'room_ui_qa', name: '验收厨房', x: 0, y: 0, w: 5000, h: 4000, thickness: 120, height: 2700 });
  project.rooms.push(room);
  const cabinets = [
    createCabinet({ id: 'cab_ui_left', name: '左侧柜体', roomId: room.id, x: 300, y: 120, rules, params: { width: 800, height: 2100, depth: 600 } }),
    createCabinet({ id: 'cab_ui_right', name: '右侧柜体', roomId: room.id, x: 1500, y: 120, rules, params: { width: 900, height: 2100, depth: 600 } }),
  ];
  for (const [cabinetIndex, cabinet] of cabinets.entries()) {
    const assign = (units, rowLabel) => units.forEach((unit, index) => { unit.id = `unit_ui_${cabinetIndex + 1}_${rowLabel}_${index + 1}`; });
    if (cabinet.layout.rows?.length) {
      cabinet.layout.rows.forEach((row, rowIndex) => assign(row.units, `row${rowIndex + 1}`));
      cabinet.layout.units = structuredClone(cabinet.layout.rows[0].units);
    } else {
      assign(cabinet.layout.units, 'row1');
    }
    if (cabinet.layout.backUnits?.length) assign(cabinet.layout.backUnits, 'back');
  }
  project.cabinets.push(...cabinets);
  return project;
}

function buildDuplicateProject(base) {
  const project = structuredClone(base);
  project.cabinets[0].name = '左侧柜体（历史原件）';
  project.cabinets[1].name = '右侧柜体（历史原件）';
  const canonicalFirst = (cabinet) => cabinet.layout.rows?.[0]?.units?.[0] ?? cabinet.layout.units?.[0];
  canonicalFirst(project.cabinets[0]).id = 'unit_historical_duplicate_001';
  project.cabinets[1].layout.backUnits = [structuredClone(canonicalFirst(project.cabinets[1]))];
  project.cabinets[1].layout.backUnits[0].id = 'unit_historical_duplicate_001';
  project.cabinets[1].layout.type = 'double';
  return project;
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let sequence = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result ?? {});
  });
  return {
    ws,
    ready,
    send(method, params = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch { /* 浏览器已关闭 */ } },
  };
}

async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw new Error(`浏览器脚本异常：${JSON.stringify(response.exceptionDetails)}`);
  return response.result?.value;
}

async function waitFor(expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await evaluate(expression);
    if (result) return result;
    await wait(80);
  }
  throw new Error(`浏览器条件等待超时：${expression}`);
}

async function buttonState(selector) {
  return evaluate(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); return button ? { disabled: Boolean(button.disabled), text: (button.innerText || button.textContent || '').trim() } : null; })()`);
}

async function clickSelector(selector, { force = false } = {}) {
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return 'missing';
    const wasDisabled = Boolean(element.disabled);
    if (wasDisabled && !${force ? 'true' : 'false'}) return 'disabled';
    if (${force ? 'true' : 'false'}) element.disabled = false;
    element.click();
    if (${force ? 'true' : 'false'}) element.disabled = wasDisabled;
    return 'clicked';
  })()`);
}

async function storageSnapshot() {
  return evaluate('Object.fromEntries(Object.keys(localStorage).sort().map((key) => [key, localStorage.getItem(key)]))');
}

async function liveBrowserBusSnapshot() {
  return evaluate(`(async () => {
    const { bus } = await import('/src/state/store.ts');
    const project = bus.getState();
    return { project, projectId: project.id, version: bus.getVersion() };
  })()`);
}

async function shutdown(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => child.once('close', resolve)), wait(2500)]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

try {
  const rules = JSON.parse(fs.readFileSync(path.join(appRoot, 'src/core/ruleset/factory-default.json'), 'utf8'));
  const cleanProject = buildBaseProject(rules);
  const badProject = buildDuplicateProject(cleanProject);
  cleanProject.id = 'healthy_unit_id_ui_fixture';
  cleanProject.name = '唯一 ID 健康对照项目';
  const duplicateAlternativeProject = structuredClone(badProject);
  duplicateAlternativeProject.id = 'duplicate_unit_id_alternative_fixture';
  duplicateAlternativeProject.name = '仍含重复 Unit ID 的候选项目';
  const networkFailureProject = { id: 'network_failure_project_fixture', name: '载入网络失败的候选项目' };
  const localBadProject = structuredClone(badProject);
  localBadProject.name = '浏览器缓存中的历史项目';
  const duplicateRows = findDuplicateUnitIds(badProject).map((item) => ({ ...item, scope: 'live project' }));
  const conflictMessage = unitIdentityConflictMessage('live project', duplicateRows);
  const diagnostics = {
    readOnly: true,
    code: WORKSPACE_UNIT_ID_CONFLICT,
    message: conflictMessage,
    duplicateUnitIds: duplicateRows,
  };
  const fixtureState = {
    mode: 'bad',
    project: badProject,
    cleanProject,
    diagnostics,
    workspaceReads: [],
    draftReads: [],
    activationAttempts: [],
    writes: [],
  };
  const draftProject = structuredClone(cleanProject);
  draftProject.name = 'MCP 草稿只读预览';
  const fixtureDraft = {
    draftId: 'ui-readonly-fixture-draft',
    owner: 'ui-acceptance',
    createdAt: '2026-10-09T00:00:00.000Z',
    baseModelVersion: 41,
    runId: 'run_ui_readonly_fixture',
    revision: 1,
    draftHash: 'b'.repeat(64),
    liveModelVersion: 41,
    baseProjectHash: 'c'.repeat(64),
    isStale: false,
    canApply: true,
    project: draftProject,
    validation: { blockingErrors: 0 },
  };

  const apiPort = await freePort();
  const vitePort = await freePort();
  const cdpPort = await freePort();
  const baseUrl = `http://127.0.0.1:${vitePort}`;
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  apiServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const method = request.method ?? 'GET';
    const pathname = new URL(request.url ?? '/', apiUrl).pathname;
    const isActivationRequest = method === 'POST' && /^\/api\/projects\/[^/]+\/activate$/u.test(pathname);
    if (method !== 'GET' && !isActivationRequest) fixtureState.writes.push({ method, pathname, body });
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (method === 'OPTIONS') {
      response.writeHead(204);
      response.end();
      return;
    }
    const activationMatch = pathname.match(/^\/api\/projects\/([^/]+)\/activate$/u);
    if (method === 'POST' && activationMatch) {
      const projectId = decodeURIComponent(activationMatch[1]);
      fixtureState.activationAttempts.push({ method, pathname, body, projectId });
      if (projectId === duplicateAlternativeProject.id) {
        response.writeHead(409);
        response.end(JSON.stringify({ ok: false, code: WORKSPACE_UNIT_ID_CONFLICT, error: conflictMessage, identityDiagnostics: structuredClone(fixtureState.diagnostics) }));
        return;
      }
      if (projectId === networkFailureProject.id) {
        request.socket.destroy();
        return;
      }
      if (projectId !== fixtureState.cleanProject.id) {
        response.writeHead(404);
        response.end(JSON.stringify({ ok: false, code: 'PROJECT_NOT_FOUND', error: 'fixture project not found' }));
        return;
      }
      fixtureState.mode = 'unique';
      fixtureState.writes.push({ method, pathname, body });
      response.writeHead(200);
      response.end(JSON.stringify({
        ok: true,
        activeId: projectId,
        project: structuredClone(fixtureState.cleanProject),
        liveModelVersion: 42,
        identityDiagnostics: { readOnly: false, code: null, message: '', duplicateUnitIds: [] },
      }));
      return;
    }
    if (method !== 'GET') {
      response.writeHead(409);
      response.end(JSON.stringify({ ok: false, error: 'readonly UI fixture rejects all writes' }));
      return;
    }
    if (pathname === '/api/workspace') {
      const isRemoteBad = fixtureState.mode === 'bad' || fixtureState.mode === 'remote-bad';
      const project = isRemoteBad ? badProject : fixtureState.cleanProject;
      fixtureState.workspaceReads.push({ at: Date.now(), project: structuredClone(project), mode: fixtureState.mode });
      response.writeHead(200);
      response.end(JSON.stringify({
        ok: true,
        project: structuredClone(project),
        workspaceId: 'ui-readonly-fixture-workspace',
        liveModelVersion: 41,
        projectSnapshotId: 'ui-readonly-fixture:v41:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        projectSnapshotHash: 'a'.repeat(64),
        projectSnapshotVersion: 41,
        ...(isRemoteBad ? { identityDiagnostics: structuredClone(fixtureState.diagnostics) } : {}),
      }));
      return;
    }
    if (pathname === '/api/drafts') {
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, drafts: [{ draftId: fixtureDraft.draftId, owner: fixtureDraft.owner, createdAt: fixtureDraft.createdAt, baseModelVersion: 41 }], liveModelVersion: 41 }));
      return;
    }
    if (pathname === `/api/drafts/${fixtureDraft.draftId}`) {
      fixtureState.draftReads.push(Date.now());
      response.writeHead(200);
      response.end(JSON.stringify({ ok: true, ...structuredClone(fixtureDraft) }));
      return;
    }
    if (pathname === '/api/projects') {
      const isRemoteBad = fixtureState.mode === 'bad' || fixtureState.mode === 'remote-bad';
      const project = isRemoteBad ? badProject : fixtureState.cleanProject;
      response.writeHead(200);
      const projects = [{
        id: project.id, name: project.name, roomCount: project.rooms.length,
        cabinetCount: project.cabinets.length, updatedAt: 1, isActive: true,
      }];
      if (isRemoteBad) projects.push({
        id: fixtureState.cleanProject.id, name: fixtureState.cleanProject.name,
        roomCount: fixtureState.cleanProject.rooms.length, cabinetCount: fixtureState.cleanProject.cabinets.length,
        updatedAt: 1, isActive: false,
      });
      if (isRemoteBad) projects.push({
        id: duplicateAlternativeProject.id, name: duplicateAlternativeProject.name,
        roomCount: duplicateAlternativeProject.rooms.length, cabinetCount: duplicateAlternativeProject.cabinets.length,
        updatedAt: 0, isActive: false,
      }, {
        id: networkFailureProject.id, name: networkFailureProject.name,
        roomCount: 0, cabinetCount: 0, updatedAt: 0, isActive: false,
      });
      response.end(JSON.stringify({ ok: true, projects }));
      return;
    }
    response.writeHead(200);
    response.end(JSON.stringify({ ok: true, models: [], drafts: [] }));
  });
  await new Promise((resolve, reject) => { apiServer.once('error', reject); apiServer.listen(apiPort, '127.0.0.1', resolve); });

  const chromePath = process.env.CHROME_PATH || ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((candidate) => fs.existsSync(candidate));
  if (!chromePath) throw new Error('找不到 Chromium；可通过 CHROME_PATH 指定可执行文件');
  const viteBin = path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) throw new Error(`缺少 Vite：${viteBin}；请先在 app/ 安装依赖`);

  console.log('运行独立真实浏览器 UI harness（API fixture + Vite/React + Chromium），不触碰 8787');
  console.log(`隔离端口：mock-api=${apiPort} vite=${vitePort} cdp=${cdpPort}`);
  vite = startProcess('vite', process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: appRoot,
    env: { ...process.env, API_PORT: String(apiPort) },
  });
  await waitHttp(baseUrl);
  chrome = startProcess('chromium', chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
    '--disable-background-networking', 'about:blank',
  ]);
  await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`);
  let targets = [];
  for (let attempt = 0; attempt < 60; attempt += 1) {
    targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    if (targets.some((target) => target.type === 'page' && target.webSocketDebuggerUrl)) break;
    await wait(100);
  }
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) throw new Error('Chromium 没有可用的真实页面 target');
  cdp = connectCdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const localDraft = serializeProjectFile(localBadProject, '2026-10-09T00:00:00.000Z');
  const initScript = `(() => {
    if (!localStorage.getItem('furnicad.draft.v1')) localStorage.setItem('furnicad.draft.v1', ${JSON.stringify(localDraft)});
    if (!localStorage.getItem('furniture-cad.workspace-mode')) localStorage.setItem('furniture-cad.workspace-mode', 'chat');
  })();`;
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: initScript });
  await cdp.send('Page.navigate', { url: baseUrl });
  await waitFor("Boolean(document.querySelector('[data-testid=unit-identity-readonly-banner]') && document.querySelector('.workspace-topbar') && document.querySelector('[data-testid=shared-panels]') && document.querySelector('.ai-btn-agent'))");
  await waitFor("document.querySelector('.workspace-topbar')?.innerText.includes('不同步')");

  console.log('\nA. 服务端重复身份诊断真实进入 React 顶部只读横幅');
  const serverResponse = await fetch(`${apiUrl}/api/workspace`);
  const serverSnapshot = await serverResponse.json();
  const serverDiagnostics = serverSnapshot.identityDiagnostics;
  check('API fixture 实际返回 readOnly/code/message/duplicateUnitIds.locations', serverSnapshot.ok === true
    && serverDiagnostics?.readOnly === true
    && serverDiagnostics?.code === WORKSPACE_UNIT_ID_CONFLICT
    && typeof serverDiagnostics?.message === 'string'
    && serverDiagnostics.duplicateUnitIds?.some((item) => item.locations?.length >= 2),
  `code=${serverDiagnostics?.code}; locations=${serverDiagnostics?.duplicateUnitIds?.[0]?.locations?.length ?? 0}`);
  const bannerText = await evaluate("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText ?? ''");
  const expectedLocations = serverDiagnostics.duplicateUnitIds.flatMap((item) => item.locations);
  check('真实 DOM 横幅可见只读、诊断码、原因及显式修复要求', bannerText.includes('只读')
    && bannerText.includes('需显式修复/迁移')
    && bannerText.includes(serverDiagnostics.code)
    && bannerText.includes(serverDiagnostics.message), bannerText.replace(/\s+/gu, ' ').slice(0, 260));
  check('真实 DOM 横幅至少展示两个柜体/行冲突位置', expectedLocations.length >= 2
    && expectedLocations.slice(0, 2).every((location) => bannerText.includes(location))
    && expectedLocations.slice(0, 2).every((location) => location.includes('cabinet:')),
  expectedLocations.slice(0, 2).join(' | '));

  console.log('\nB. 坏项目态的创建、CAD、SharedPanel、Agent 和同步写入口均 fail-closed');
  const states = {
    room: await buttonState('.workspace-topbar button.workspace-button'),
    cabinet: await evaluate("(() => { const b=[...document.querySelectorAll('.workspace-room-actions button')].find((item)=>item.textContent.includes('添加柜体')); return b?{disabled:b.disabled,text:b.innerText.trim()}:null; })()"),
    cad: await evaluate("(() => { const b=[...document.querySelectorAll('.workspace-topbar button')].find((item)=>item.textContent.includes('高级 CAD')); return b?{disabled:b.disabled,text:b.innerText.trim()}:null; })()"),
    shared: await buttonState('[data-testid=shared-panel-create]'),
    agent: await buttonState('button.ai-btn-agent'),
  };
  const roomIsAdd = states.room?.text.includes('房间');
  check('顶部房间创建入口在坏项目态禁用', Boolean(roomIsAdd && states.room.disabled), JSON.stringify(states.room));
  check('柜体创建入口在坏项目态禁用', states.cabinet?.disabled === true, JSON.stringify(states.cabinet));
  check('顶部高级 CAD 编辑入口在坏项目态禁用', states.cad?.disabled === true, JSON.stringify(states.cad));
  check('SharedPanel 创建入口在坏项目态禁用（房间至少有两柜）', states.shared?.disabled === true, JSON.stringify(states.shared));

  const agentInput = await evaluate(`(() => {
    const input = document.querySelector('textarea.ai-input');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, '请执行修改柜体');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(80);
  const agentState = await buttonState('button.ai-btn-agent');
  check('填写执行意图后 Agent 执行按钮仍禁用', Boolean(agentInput && agentState?.disabled), JSON.stringify(agentState));

  const beforeDom = await evaluate("({projectId:document.querySelector('.app')?.dataset.projectId,version:document.querySelector('.app')?.dataset.modelVersion})");
  const storageBefore = await storageSnapshot();
  await evaluate("window.__readonlyUiConfirmCalls=0; window.confirm=()=>{window.__readonlyUiConfirmCalls++;return true;}");
  for (const [name, selector] of [
    ['顶部新建房间 handler guard', '.workspace-topbar button.workspace-button'],
    ['高级 CAD handler guard', '.workspace-topbar button.workspace-button-primary'],
    ['SharedPanel create handler guard', '[data-testid=shared-panel-create]'],
    ['Agent execute handler guard', 'button.ai-btn-agent'],
  ]) {
    const result = await clickSelector(selector, { force: true });
    check(`${name} 不可通过程序化 click 绕过只读`, result === 'clicked', result);
  }
  check('SharedPanel create guard 未打开创建/保存表单', await evaluate("!document.querySelector('[data-testid=shared-panel-dialog]')"));
  check('被拦截的 Agent execute 未发出服务端写请求', fixtureState.writes.length === 0, `writes=${fixtureState.writes.length}`);
  check('被拦截动作未改页面 Project/version', sameJson(beforeDom, await evaluate("({projectId:document.querySelector('.app')?.dataset.projectId,version:document.querySelector('.app')?.dataset.modelVersion})"), JSON.stringify(beforeDom)));
  check('被拦截动作未改 localStorage', sameJson(storageBefore, await storageSnapshot()));

  console.log('\nC. 浏览 MCP 草稿但不能应用/同步；刷新后重新读取同一远端坏项目');
  await waitFor("Boolean([...document.querySelectorAll('.workspace-topbar button')].find((button)=>button.textContent.includes('不同步')))");
  const remoteButton = await evaluate("(() => { const b=[...document.querySelectorAll('.workspace-topbar button')].find((button)=>button.textContent.includes('不同步')); if(!b || b.disabled) return 'unavailable'; b.click(); return 'clicked'; })()");
  check('只读用户仍可进入远端草稿浏览面板', remoteButton === 'clicked', remoteButton);
  await waitFor("Boolean(document.querySelector('.remote-sync-card') && [...document.querySelectorAll('button')].some((button)=>button.textContent.includes('网页实时预览')))");
  const syncState = await evaluate("(() => { const b=[...document.querySelectorAll('button')].find((item)=>item.textContent.includes('确认将服务器项目同步到本地')); return b?{disabled:b.disabled,text:b.innerText.trim()}:null; })()");
  check('MCP/服务器同步到本地动作禁用', syncState?.disabled === true, JSON.stringify(syncState));
  const syncClick = await evaluate(`(() => {
    const b=[...document.querySelectorAll('button')].find((item)=>item.textContent.includes('确认将服务器项目同步到本地'));
    if(!b) return 'missing'; b.disabled=false; b.click(); b.disabled=true; return 'clicked';
  })()`);
  check('程序化触发同步 handler 仍被 guard 拦截', syncClick === 'clicked' && await evaluate('window.__readonlyUiConfirmCalls===0'));

  const previewButton = await evaluate("(() => { const b=[...document.querySelectorAll('button')].find((item)=>item.textContent.includes('网页实时预览')); if(!b || b.disabled) return 'unavailable'; b.click(); return 'clicked'; })()");
  check('允许读取 MCP 草稿预览（只读）', previewButton === 'clicked', previewButton);
  await waitFor("Boolean([...document.querySelectorAll('button')].some((button)=>button.textContent.includes('确认应用到服务器')))");
  const applyState = await evaluate("(() => { const b=[...document.querySelectorAll('button')].find((item)=>item.textContent.includes('确认应用到服务器')); return b?{disabled:b.disabled,text:b.innerText.trim()}:null; })()");
  check('MCP 草稿“确认应用到服务器”动作禁用', applyState?.disabled === true, JSON.stringify(applyState));
  const applyClick = await evaluate(`(() => {
    const b=[...document.querySelectorAll('button')].find((item)=>item.textContent.includes('确认应用到服务器'));
    if(!b) return 'missing'; b.disabled=false; b.click(); b.disabled=true; return 'clicked';
  })()`);
  check('程序化触发草稿应用仍被 guard 拦截', applyClick === 'clicked' && !await evaluate("Boolean(document.querySelector('[aria-label=确认应用服务端草稿]'))"));
  check('只读浏览未产生 Agent/草稿应用/同步/删除 API 写请求', fixtureState.writes.length === 0, `writes=${fixtureState.writes.length}`);
  check('只读浏览未改页面 Project/version', sameJson(beforeDom, await evaluate("({projectId:document.querySelector('.app')?.dataset.projectId,version:document.querySelector('.app')?.dataset.modelVersion})"), JSON.stringify(beforeDom)));
  check('只读浏览及草稿预览未改 localStorage', sameJson(storageBefore, await storageSnapshot()));

  const remoteReadCountBeforeReload = fixtureState.workspaceReads.filter((entry) => entry.mode === 'bad').length;
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor("Boolean(document.querySelector('[data-testid=unit-identity-readonly-banner]') && document.querySelector('.workspace-topbar') && document.querySelector('[data-testid=shared-panels]'))");
  await waitFor("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText.includes('WORKSPACE_UNIT_ID_CONFLICT')");
  const afterReloadBanner = await evaluate("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText ?? ''");
  const afterReloadDom = await evaluate("({projectId:document.querySelector('.app')?.dataset.projectId,version:document.querySelector('.app')?.dataset.modelVersion})");
  const afterReloadStorage = await storageSnapshot();
  const rawSaved = afterReloadStorage['furnicad.draft.v1'];
  const savedEnvelope = rawSaved ? JSON.parse(rawSaved) : null;
  const savedProject = savedEnvelope?.project ?? savedEnvelope;
  const savedDuplicates = findDuplicateUnitIds(savedProject);
  const remoteBadReads = fixtureState.workspaceReads.filter((entry) => entry.mode === 'bad');
  check('刷新后再次请求同一远端 Project 并继续显示告警', remoteBadReads.length > remoteReadCountBeforeReload
    && remoteBadReads.every((entry) => sameJson(entry.project, badProject))
    && afterReloadBanner.includes(serverDiagnostics.code)
    && afterReloadBanner.includes(serverDiagnostics.message), `workspace GET=${remoteBadReads.length}`);
  check('刷新/重开没有重编号或改写本地缓存的原始柜体与重复 Unit ID', savedDuplicates.some((item) => item.id === 'unit_historical_duplicate_001')
    && savedProject.cabinets?.length === badProject.cabinets.length
    && savedProject.cabinets?.map((cabinet) => cabinet.id).join('|') === badProject.cabinets.map((cabinet) => cabinet.id).join('|')
    && savedProject.cabinets[0].name === localBadProject.cabinets[0].name
    && savedProject.cabinets[1].name === localBadProject.cabinets[1].name,
  `cabinetIds=${savedProject.cabinets?.map((cabinet) => cabinet.id).join(',')}; duplicate=${savedDuplicates.map((item) => item.id).join(',')}`);
  check('刷新后坏项目只读状态、页面 Project/version 与 localStorage 保持', sameJson(afterReloadDom, beforeDom)
    && sameJson(afterReloadStorage, storageBefore)
    && afterReloadBanner.includes('只读')
    && (await buttonState('[data-testid=shared-panel-create]'))?.disabled === true,
  `project/version=${JSON.stringify(afterReloadDom)}`);

  console.log('\nD. 唯一 ID 对照项目：创建房间仍可真实写入本地模型');
  fixtureState.mode = 'unique';
  const openHealthyProjectPicker = await evaluate("(() => { const b=document.querySelector('[data-testid=unit-identity-switch-healthy-project]'); if(!b) return 'missing'; b.click(); return 'clicked'; })()");
  await waitFor("Boolean(document.querySelector('.projects-panel') && [...document.querySelectorAll('.projects-panel button')].some((b)=>b.textContent.includes('从服务端载入')))");
  await evaluate('window.confirm = () => true');
  const loadHealthyProject = await evaluate("(() => { const b=[...document.querySelectorAll('.projects-panel button')].find((item)=>item.textContent.includes('从服务端载入')); if(!b || b.disabled) return 'disabled-or-missing'; b.click(); return 'clicked'; })()");
  await waitFor(`!document.querySelector('[data-testid=unit-identity-readonly-banner]') && document.querySelector('.app')?.dataset.projectId === ${JSON.stringify(cleanProject.id)}`, 10000);
  check('用户显式载入并通过身份校验的健康项目后才解除粘滞锁', openHealthyProjectPicker === 'clicked' && loadHealthyProject === 'clicked'
    && !(await evaluate("Boolean(document.querySelector('[data-testid=unit-identity-readonly-banner]'))")));
  const preservedBadDraft = await evaluate(`(() => {
    const key=Object.keys(localStorage).find((name)=>name.startsWith('furnicad.draft.identity-conflict-backup'));
    const raw=key?localStorage.getItem(key):null; const envelope=raw?JSON.parse(raw):null; const p=envelope?.project??envelope;
    return {key, left:p?.cabinets?.[0]?.layout?.units?.[0]?.id, right:p?.cabinets?.[1]?.layout?.backUnits?.[0]?.id};
  })()`);
  check('切换前的坏旧项目副本原样保留（没有自动重编号）', Boolean(preservedBadDraft.key)
    && preservedBadDraft.left === 'unit_historical_duplicate_001'
    && preservedBadDraft.right === 'unit_historical_duplicate_001', JSON.stringify(preservedBadDraft));
  await waitFor("Boolean(document.querySelector('.projects-panel button[title=\"在当前项目下新建房间\"]'))");
  const uniqueRoomButton = await evaluate("(() => { const b=document.querySelector('.projects-panel button[title=\"在当前项目下新建房间\"]'); return b?{disabled:b.disabled,text:b.innerText.trim()}:null; })()");
  const uniqueCadButton = await evaluate("(() => { const b=document.querySelector('[data-testid=toolbar-tool-cabinet]'); return b?{disabled:b.disabled,text:b.title}:null; })()");
  check('唯一 ID 健康项目的房间创建与 CAD 工具写入口不被全局禁用', uniqueRoomButton?.disabled === false && uniqueCadButton?.disabled === false,
    `room=${JSON.stringify(uniqueRoomButton)}; cabinet-tool=${JSON.stringify(uniqueCadButton)}`);
  const versionBeforeSmoke = Number((await evaluate("document.querySelector('.app')?.dataset.modelVersion")) ?? 0);
  const projectIdBeforeSmoke = await evaluate("document.querySelector('.app')?.dataset.projectId");
  const createRoomEntry = await evaluate("(() => { const b=document.querySelector('.projects-panel button[title=\"在当前项目下新建房间\"]'); if(!b || b.disabled) return 'disabled-or-missing'; b.click(); return 'clicked'; })()");
  check('唯一 ID 项目可打开房间创建表单', createRoomEntry === 'clicked', createRoomEntry);
  await waitFor("Boolean(document.querySelector('.projects-panel .room-new input[placeholder*=\"房间名称\"]'))");
  await evaluate(`(() => { const i=document.querySelector('.projects-panel .room-new input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(i,'健康写入房间'); i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  await waitFor("Boolean([...document.querySelectorAll('.projects-panel .room-new button')].some((button)=>button.textContent.trim()==='创建' && !button.disabled))");
  const actualCreate = await evaluate("(() => { const b=[...document.querySelectorAll('.projects-panel .room-new button')].find((button)=>button.textContent.trim()==='创建'); if(!b || b.disabled) return 'disabled-or-missing'; b.click(); return 'clicked'; })()");
  check('唯一 ID 项目真实提交创建房间', actualCreate === 'clicked', actualCreate);
  await waitFor(`Number(document.querySelector('.app')?.dataset.modelVersion) > ${versionBeforeSmoke}`, 10000);
  await waitFor("(() => { try { const v=JSON.parse(localStorage.getItem('furnicad.draft.v1')||'null'); const p=v?.project??v; return p?.rooms?.length===2; } catch { return false; } })()", 10000);
  const smokeProject = await evaluate("(() => { const v=JSON.parse(localStorage.getItem('furnicad.draft.v1')||'null'); return v?.project??v; })()");
  const versionAfterSmoke = Number((await evaluate("document.querySelector('.app')?.dataset.modelVersion")) ?? 0);
  check('唯一 ID smoke 实际改动 Project、递增版本并持久化房间', smokeProject?.id === projectIdBeforeSmoke
    && smokeProject?.rooms?.length === 2
    && versionAfterSmoke > versionBeforeSmoke
    && findDuplicateUnitIds(smokeProject).length === 0,
  `v${versionBeforeSmoke}→v${versionAfterSmoke}; rooms=${smokeProject?.rooms?.length}`);
  check('唯一 ID 本地写入 smoke 没有误发远端写 API', fixtureState.writes.length === 0, `writes=${fixtureState.writes.length}`);

  console.log('\nD2. SharedPanel 表单在打开期间收到远端只读诊断后，保存入口 fail-closed');
  const returnToWorkspace = await evaluate("(() => { const b=document.querySelector('button[title=\"返回 AI 房间工作区\"]'); if(!b || b.disabled) return 'disabled-or-missing'; b.click(); return 'clicked'; })()");
  await waitFor("Boolean(document.querySelector('.workspace-room-list-items'))");
  await evaluate("(() => { const room=document.querySelector('.workspace-room-item'); if(room) room.click(); })()");
  await waitFor("Boolean(document.querySelector('[data-testid=shared-panel-create]') && !document.querySelector('[data-testid=shared-panel-create]').disabled)");
  const openSharedDraft = await clickSelector('[data-testid=shared-panel-create]');
  await waitFor("Boolean(document.querySelector('[data-testid=shared-panel-dialog] [data-testid=sp-confirm]'))");
  fixtureState.mode = 'remote-bad';
  await waitFor("Boolean(document.querySelector('[data-testid=unit-identity-readonly-banner]') && document.querySelector('[data-testid=sp-confirm]')?.disabled)", 15000);
  const sharedSaveDisabled = await buttonState('[data-testid=sp-confirm]');
  const sharedFieldsetDisabled = await evaluate("Boolean(document.querySelector('[data-testid=shared-panel-dialog] fieldset')?.disabled)");
  const sharedBefore = await liveBrowserBusSnapshot();
  const sharedHashBefore = createHash('sha256').update(stableJson(sharedBefore.project)).digest('hex');
  const sharedStorageBefore = await storageSnapshot();
  await evaluate(`(() => {
    const form=document.querySelector('[data-testid=shared-panel-dialog] form');
    const submit=form?.querySelector('[data-testid=sp-confirm]');
    if(!form || !submit) return false;
    const disabled=submit.disabled; submit.disabled=false;
    form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
    submit.disabled=disabled; return true;
  })()`);
  await wait(80);
  const sharedAfter = await liveBrowserBusSnapshot();
  const sharedHashAfter = createHash('sha256').update(stableJson(sharedAfter.project)).digest('hex');
  check('已打开的 SharedPanel 字段和确认保存按钮在坏身份诊断到达后可见 disabled', returnToWorkspace === 'clicked'
    && openSharedDraft === 'clicked' && sharedSaveDisabled?.disabled === true && sharedFieldsetDisabled);
  check('程序化触发 SharedPanel form submit 仍无 Project/hash/version/localStorage/API 写入', sharedBefore.projectId === sharedAfter.projectId
    && sharedHashBefore === sharedHashAfter && sharedBefore.version === sharedAfter.version
    && sameJson(sharedStorageBefore, await storageSnapshot()) && fixtureState.writes.length === 0,
  `${sharedHashBefore.slice(0, 12)}; v${sharedBefore.version}→${sharedAfter.version}; writes=${fixtureState.writes.length}`);

  console.log('\nE. 服务端坏项目 + 浏览器本地唯一项目：统一锁、画布、属性保存和键盘尝试');
  fixtureState.mode = 'remote-bad';
  await evaluate(`(() => {
    localStorage.setItem('furnicad.draft.v1', ${JSON.stringify(serializeProjectFile(cleanProject, '2026-10-09T00:00:00.000Z'))});
    localStorage.setItem('furniture-cad.workspace-mode', 'cad');
    localStorage.removeItem('furniture-cad.workspace-context');
    localStorage.removeItem('furniture-cad.workspace-room-id');
  })()`);
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor("Boolean(document.querySelector('[data-testid=unit-identity-readonly-banner]') && document.querySelector('.vp-canvas'))");
  await wait(1000);
  const remoteOnlyBaseline = await evaluate(`(() => {
    const app = document.querySelector('.app');
    const raw = localStorage.getItem('furnicad.draft.v1');
    const envelope = raw ? JSON.parse(raw) : null;
    return { projectId: app?.dataset.projectId, version: app?.dataset.modelVersion, raw, project: envelope?.project ?? envelope };
  })()`);
  const remoteOnlyHash = createHash('sha256').update(stableJson(remoteOnlyBaseline.project)).digest('hex');
  const remoteOnlyStorageBefore = await storageSnapshot();
  check('远端报告坏项目时浏览器本地 Project 仍唯一，App 进入只读浏览', findDuplicateUnitIds(remoteOnlyBaseline.project).length === 0
    && Boolean(await evaluate("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText.includes('需显式修复/迁移')"))
    && Boolean(await evaluate("document.querySelector('[data-testid=unit-identity-copy-advice]')?.innerText.includes('建议先保留副本')")));

  console.log('\nE0. 历史重复 Unit ID 只读下 ImportPanel 可解析/预览，但不可应用');
  const openImportTab = await evaluate("(() => { const button=[...document.querySelectorAll('.side-right .tabs button')].find((item)=>item.textContent.trim()==='导入'); if(!button) return 'missing'; button.click(); return 'clicked'; })()");
  await waitFor("Boolean(document.querySelector('.import-panel textarea.import-text'))");
  const importJson = JSON.stringify({
    title: '只读导入预览', room: 'room_ui_qa',
    cabinets: [{ ref: 'import_readonly_probe', name: '只读导入预览柜', width: 700, height: 1800, depth: 450 }],
  });
  const importInputSet = await evaluate(`(() => {
    const input = document.querySelector('.import-panel textarea.import-text');
    const setter = input && Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!input || !setter) return false;
    setter.call(input, ${JSON.stringify(importJson)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await waitFor("Boolean([...document.querySelectorAll('.import-panel button')].some((button)=>button.textContent.trim()==='解析导入' && !button.disabled))");
  const parsedImport = await evaluate("(() => { const button=[...document.querySelectorAll('.import-panel button')].find((item)=>item.textContent.trim()==='解析导入'); if(!button) return false; button.click(); return true; })()");
  await waitFor("Boolean(document.querySelector('.import-panel .import-meta') && [...document.querySelectorAll('.import-panel button')].some((button)=>button.textContent.includes('编译并预览')))");
  const importParseState = await evaluate("(() => { const button=[...document.querySelectorAll('.import-panel button')].find((item)=>item.textContent.includes('编译并预览')); return {normalized:Boolean(document.querySelector('.import-panel .import-meta')), compileEnabled:Boolean(button && !button.disabled)}; })()");
  check('坏工作区下 ImportPanel 仍可解析数据并启用编译/预览', openImportTab === 'clicked' && importInputSet && parsedImport
    && importParseState.normalized && importParseState.compileEnabled, JSON.stringify(importParseState));
  const compileImportPreview = await evaluate("(() => { const button=[...document.querySelectorAll('.import-panel button')].find((item)=>item.textContent.includes('编译并预览')); if(!button || button.disabled) return 'disabled-or-missing'; button.click(); return 'clicked'; })()");
  await waitFor("Boolean([...document.querySelectorAll('.import-panel button')].some((button)=>button.textContent.trim()==='应用导入'))");
  const importPlanState = await evaluate("(() => { const button=[...document.querySelectorAll('.import-panel button')].find((item)=>item.textContent.trim()==='应用导入'); return {applyDisabled:Boolean(button?.disabled), successfulSteps:document.querySelectorAll('.import-panel .plan-step:not(.plan-step-bad)').length, failedSteps:document.querySelectorAll('.import-panel .plan-step-bad').length, previewVisible:Boolean(document.querySelector('.import-panel .btn-row'))}; })()");
  check('真实 ImportPanel/PlanRunView 有待应用成功步骤且“应用导入”明确 disabled', compileImportPreview === 'clicked'
    && importPlanState.previewVisible && importPlanState.successfulSteps > 0
    && importPlanState.failedSteps === 0 && importPlanState.applyDisabled, JSON.stringify(importPlanState));
  const importApplyBefore = await liveBrowserBusSnapshot();
  const importApplyHashBefore = createHash('sha256').update(stableJson(importApplyBefore.project)).digest('hex');
  const importApplyStorageBefore = await storageSnapshot();
  const importApplyAttempt = await evaluate(`(() => {
    const button = [...document.querySelectorAll('.import-panel button')].find((item) => item.textContent.trim() === '应用导入');
    if (!button) return { result: 'missing', initiallyDisabled: false };
    const initiallyDisabled = button.disabled;
    button.disabled = false;
    button.click();
    button.disabled = initiallyDisabled;
    return { result: 'clicked', initiallyDisabled };
  })()`);
  await wait(100);
  const importApplyAfter = await liveBrowserBusSnapshot();
  const importApplyHashAfter = createHash('sha256').update(stableJson(importApplyAfter.project)).digest('hex');
  const importApplyStorageAfter = await storageSnapshot();
  const importApplyButtonAfter = await evaluate("(() => { const button=[...document.querySelectorAll('.import-panel button')].find((item)=>item.textContent.trim()==='应用导入'); return {disabled:Boolean(button?.disabled), previewVisible:Boolean(document.querySelector('.import-panel .btn-row'))}; })()");
  check('强制尝试 ImportPanel 应用后 Project/hash/CommandBus version/localStorage 均不变', importApplyAttempt.result === 'clicked'
    && importApplyAttempt.initiallyDisabled === true
    && importApplyBefore.projectId === importApplyAfter.projectId
    && importApplyBefore.version === importApplyAfter.version
    && importApplyHashBefore === importApplyHashAfter
    && sameJson(importApplyBefore.project, importApplyAfter.project)
    && sameJson(importApplyStorageBefore, importApplyStorageAfter)
    && importApplyButtonAfter.disabled && importApplyButtonAfter.previewVisible,
  `${importApplyHashBefore.slice(0, 12)}; v${importApplyBefore.version}→${importApplyAfter.version}; storage unchanged`);

  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'l', code: 'KeyL', windowsVirtualKeyCode: 76 });
  const wallToolSelected = await evaluate("document.querySelector('[data-testid=toolbar-tool-wall]')?.classList.contains('active')");
  check('L 快捷键只切换绘图工具，不改 Project/version', wallToolSelected === true
    && String(await evaluate("document.querySelector('.app')?.dataset.modelVersion")) === String(remoteOnlyBaseline.version));
  const canvasRect = await evaluate("(() => { const r=document.querySelector('.vp-canvas')?.getBoundingClientRect(); return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null; })()");
  if (canvasRect?.width && canvasRect?.height) {
    const x = Math.round(canvasRect.x + canvasRect.width * 0.5), y = Math.round(canvasRect.y + canvasRect.height * 0.5);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await evaluate(`(() => { const el=document.querySelector('.vp'); if(!el) return false; const r=el.getBoundingClientRect(); return el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,pointerId:7,pointerType:'mouse',isPrimary:true,button:0,buttons:1,clientX:${x},clientY:${y}})); })()`);
  }
  await waitFor("document.querySelector('.toasts')?.innerText.includes('画布图元与模型写入已拦截')");
  check('真实画布点击进入图元写入路径后显示只读提示并被拦截', Boolean(canvasRect?.width && canvasRect?.height));

  const propertyTab = await evaluate("(() => { const b=[...document.querySelectorAll('.side-right .tabs button')].find((x)=>x.textContent.trim()==='属性'); if(!b) return false; b.click(); return true; })()");
  await waitFor("Boolean(document.querySelector('[data-testid=properties-readonly-boundary] input'))");
  const propertyAttempt = await evaluate(`(() => {
    const input = document.querySelector('[data-testid=properties-readonly-boundary] input');
    const fieldset = input?.closest('fieldset');
    if (!input || !fieldset) return { found: false };
    const oldValue = input.value;
    fieldset.disabled = false; // 仅用于验证 React handler/CommandBus 的第二层 guard；用户看到的 fieldset 默认 disabled
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    input.focus();
    setter?.call(input, oldValue + ' probe');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    input.dispatchEvent(new FocusEvent('blur'));
    fieldset.disabled = true;
    return { found: true, initiallyDisabled: true, value: input.value };
  })()`);
  await waitFor("document.querySelector('.toasts')?.innerText.includes('属性修改/保存已拦截')");
  check('属性面板字段可见 disabled，程序化编辑/失焦保存仍被 React handler 拦截', propertyTab === true && propertyAttempt.found === true
    && Boolean(await evaluate("document.querySelector('[data-testid=properties-readonly-boundary] fieldset')?.disabled")));

  const ctrlZBefore = await liveBrowserBusSnapshot();
  const ctrlZHashBefore = createHash('sha256').update(stableJson(ctrlZBefore.project)).digest('hex');
  const ctrlZStorageBefore = await storageSnapshot();
  const ctrlZBannerBefore = await evaluate("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText ?? ''");
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 2, windowsVirtualKeyCode: 90 });
  await evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}))");
  await wait(80);
  const ctrlZAfter = await liveBrowserBusSnapshot();
  const ctrlZHashAfter = createHash('sha256').update(stableJson(ctrlZAfter.project)).digest('hex');
  const ctrlZStorageAfter = await storageSnapshot();
  const ctrlZBannerAfter = await evaluate("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText ?? ''");
  check('Ctrl+Z 尝试前后 live CommandBus Project/hash/version 与 localStorage 原值完全不变', ctrlZBefore.projectId === ctrlZAfter.projectId
    && ctrlZHashBefore === ctrlZHashAfter
    && ctrlZBefore.version === ctrlZAfter.version
    && sameJson(ctrlZStorageBefore, ctrlZStorageAfter),
  `${ctrlZHashBefore.slice(0, 12)}; v${ctrlZBefore.version}→${ctrlZAfter.version}`);
  check('Ctrl+Z 拦截后只读告警横幅仍持续显示', ctrlZBannerBefore.includes('WORKSPACE_UNIT_ID_CONFLICT')
    && ctrlZBannerAfter.includes('只读') && ctrlZBannerAfter.includes('WORKSPACE_UNIT_ID_CONFLICT'));
  const remoteOnlyAfter = await evaluate(`(() => {
    const app = document.querySelector('.app');
    const raw = localStorage.getItem('furnicad.draft.v1');
    const envelope = raw ? JSON.parse(raw) : null;
    return { projectId: app?.dataset.projectId, version: app?.dataset.modelVersion, raw, project: envelope?.project ?? envelope };
  })()`);
  const remoteOnlyAfterHash = createHash('sha256').update(stableJson(remoteOnlyAfter.project)).digest('hex');
  check('画布/属性/键盘尝试后 Project hash、Project ID、version 与 localStorage 完全不变', remoteOnlyAfter.projectId === remoteOnlyBaseline.projectId
    && remoteOnlyAfter.version === remoteOnlyBaseline.version
    && remoteOnlyAfterHash === remoteOnlyHash
    && sameJson(remoteOnlyStorageBefore, await storageSnapshot())
    && fixtureState.writes.length === 0,
  `${remoteOnlyHash.slice(0, 12)}; v${remoteOnlyBaseline.version}→${remoteOnlyAfter.version}; writes=${fixtureState.writes.length}`);

  const exportTab = await evaluate("(() => { const b=[...document.querySelectorAll('.side-right .tabs button')].find((x)=>x.textContent.trim()==='导出'); if(!b) return false; b.click(); return true; })()");
  await waitFor("Boolean(document.querySelector('[data-testid=export-blocked-readonly]') && document.querySelector('[data-testid=production-export-csv]'))");
  const exportButtons = await evaluate(`['pdf','dxf','csv','roombook'].map((kind)=>{
    const b=document.querySelector('[data-testid=production-export-'+kind+']');
    return {kind,disabled:Boolean(b?.disabled),text:b?.innerText?.trim()??''};
  })`);
  const exportBefore = await liveBrowserBusSnapshot();
  const exportHashBefore = createHash('sha256').update(stableJson(exportBefore.project)).digest('hex');
  const exportStorageBefore = await storageSnapshot();
  await evaluate("(() => { const b=document.querySelector('[data-testid=production-export-csv]'); if(!b) return false; const disabled=b.disabled; b.disabled=false; b.click(); b.disabled=disabled; return true; })()");
  await wait(80);
  const exportAfter = await liveBrowserBusSnapshot();
  const exportHashAfter = createHash('sha256').update(stableJson(exportAfter.project)).digest('hex');
  const exportNotice = await evaluate("document.querySelector('[data-testid=export-blocked-readonly]')?.innerText ?? ''");
  check('生产导出面板明确标记只读，PDF/DXF/CSV/房间书入口全部禁用', exportTab === true
    && exportNotice.includes('只读') && exportButtons.length === 4 && exportButtons.every((button)=>button.disabled),
  JSON.stringify(exportButtons));
  check('强制点击生产 CSV 导出仍被 UI guard 拦截，无模型/storage/API 写入', exportBefore.projectId === exportAfter.projectId
    && exportHashBefore === exportHashAfter && exportBefore.version === exportAfter.version
    && sameJson(exportStorageBefore, await storageSnapshot()) && fixtureState.writes.length === 0,
  `${exportHashBefore.slice(0, 12)}; v${exportBefore.version}→${exportAfter.version}; writes=${fixtureState.writes.length}`);

  const beforeComponentRemountStorage = await storageSnapshot();
  const openRecoveryPanel = await evaluate("(() => { const b=document.querySelector('[data-testid=unit-identity-switch-healthy-project]'); if(!b) return 'missing'; b.click(); return 'clicked'; })()");
  await waitFor("Boolean(document.querySelector('.projects-panel'))");
  await wait(250);
  const remountedBanner = await evaluate("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText ?? ''");
  const roomEntryAfterRemount = await evaluate("(() => { const b=document.querySelector('.projects-panel button[title=\"在当前项目下新建房间\"]'); return b?{disabled:b.disabled}:null; })()");
  check('点击恢复 CTA 只跳到 ProjectsPanel，组件子树卸载/重挂后仍锁且保留恢复提示', openRecoveryPanel === 'clicked'
    && remountedBanner.includes('建议先保留副本')
    && remountedBanner.includes('WORKSPACE_UNIT_ID_CONFLICT')
    && roomEntryAfterRemount?.disabled === true
    && sameJson(beforeComponentRemountStorage, await storageSnapshot())
    && fixtureState.writes.length === 0,
  `room=${JSON.stringify(roomEntryAfterRemount)}; writes=${fixtureState.writes.length}`);

  const stickyStorageBeforeReload = await storageSnapshot();
  fixtureState.mode = 'unique'; // 服务端此时已健康；轮询/刷新不得自行清除刚建立的锁
  await cdp.send('Page.reload', { ignoreCache: true });
  await waitFor("Boolean(document.querySelector('[data-testid=unit-identity-readonly-banner]') && document.querySelector('.vp-canvas'))");
  await wait(1000);
  const stickyAfterReload = await evaluate(`(() => {
    const app=document.querySelector('.app'); const raw=localStorage.getItem('furnicad.draft.v1');
    const envelope=raw?JSON.parse(raw):null;
    return {projectId:app?.dataset.projectId,version:app?.dataset.modelVersion,raw,project:envelope?.project??envelope,banner:document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText??''};
  })()`);
  const stickyAfterHash = createHash('sha256').update(stableJson(stickyAfterReload.project)).digest('hex');
  check('服务端后来健康、整页刷新/重新 hydrate 仍不能先清除 CommandBus 粘滞锁', stickyAfterReload.banner.includes('只读')
    && stickyAfterReload.banner.includes('WORKSPACE_UNIT_ID_CONFLICT')
    && stickyAfterReload.banner.includes('cabinet:')
    && (await buttonState('[data-testid=toolbar-tool-cabinet]'))?.disabled === true,
  stickyAfterReload.banner.replace(/\s+/gu, ' ').slice(0, 220));
  check('刷新 hydrate 后 Project/hash/version/localStorage 均保持且无服务端写入', stickyAfterReload.projectId === remoteOnlyBaseline.projectId
    && String(stickyAfterReload.version) === String(remoteOnlyBaseline.version)
    && stickyAfterHash === remoteOnlyHash
    && sameJson(stickyStorageBeforeReload, await storageSnapshot())
    && fixtureState.writes.length === 0,
  `${stickyAfterHash.slice(0, 12)}; v${remoteOnlyBaseline.version}→${stickyAfterReload.version}; writes=${fixtureState.writes.length}`);

  fixtureState.mode = 'remote-bad';
  const openProjectsAfterRefresh = await evaluate("(() => { const b=document.querySelector('[data-testid=unit-identity-switch-healthy-project]'); if(!b) return 'missing'; b.click(); return 'clicked'; })()");
  await waitFor(`Boolean(document.querySelector('.projects-panel') && [${JSON.stringify(cleanProject.id)},${JSON.stringify(duplicateAlternativeProject.id)},${JSON.stringify(networkFailureProject.id)}].every((id)=>[...document.querySelectorAll('.project-node .project-name')].some((e)=>e.title===id)))`);
  await evaluate('window.confirm = () => true');
  const originalReadOnlySnapshot = await liveBrowserBusSnapshot();
  const originalReadOnlyHash = createHash('sha256').update(stableJson(originalReadOnlySnapshot.project)).digest('hex');
  const originalReadOnlyStorage = await storageSnapshot();
  const originalReadOnlyBanner = await evaluate("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText ?? ''");
  const attemptSwitchTo = (projectId) => evaluate(`(() => {
    const row=[...document.querySelectorAll('.project-node')].find((node)=>node.querySelector('.project-name')?.title===${JSON.stringify(projectId)});
    const button=row?.querySelector('button[title="切换到该项目"]');
    if(!button || button.disabled) return 'disabled-or-missing';
    button.click(); return 'clicked';
  })()`);
  const duplicateSwitchAttempt = await attemptSwitchTo(duplicateAlternativeProject.id);
  await waitFor("document.querySelector('.toasts')?.innerText.includes('目标项目仍有历史重复 Unit ID')");
  const afterDuplicateAttempt = await liveBrowserBusSnapshot();
  const afterDuplicateHash = createHash('sha256').update(stableJson(afterDuplicateAttempt.project)).digest('hex');
  const afterDuplicateBanner = await evaluate("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText ?? ''");
  check('切换到仍重复 ID 的目标时服务端返回诊断，原只读 Project/version/hash/storage 与横幅诊断完整保留', duplicateSwitchAttempt === 'clicked'
    && fixtureState.mode === 'remote-bad' && fixtureState.writes.length === 0
    && originalReadOnlySnapshot.projectId === afterDuplicateAttempt.projectId
    && originalReadOnlySnapshot.version === afterDuplicateAttempt.version
    && originalReadOnlyHash === afterDuplicateHash
    && sameJson(originalReadOnlyStorage, await storageSnapshot())
    && originalReadOnlyBanner === afterDuplicateBanner
    && afterDuplicateBanner.includes('WORKSPACE_UNIT_ID_CONFLICT')
    && afterDuplicateBanner.includes('unit_historical_duplicate_001'),
  `v${originalReadOnlySnapshot.version}→${afterDuplicateAttempt.version}; committed writes=${fixtureState.writes.length}`);

  const networkSwitchAttempt = await attemptSwitchTo(networkFailureProject.id);
  await waitFor("document.querySelector('.toasts')?.innerText.includes('切换失败：')");
  const afterNetworkFailure = await liveBrowserBusSnapshot();
  const afterNetworkHash = createHash('sha256').update(stableJson(afterNetworkFailure.project)).digest('hex');
  const afterNetworkBanner = await evaluate("document.querySelector('[data-testid=unit-identity-readonly-banner]')?.innerText ?? ''");
  check('切换目标请求网络断连时不替换 Project、不改版本/storage、不清原诊断锁', networkSwitchAttempt === 'clicked'
    && fixtureState.mode === 'remote-bad' && fixtureState.writes.length === 0
    && originalReadOnlySnapshot.projectId === afterNetworkFailure.projectId
    && originalReadOnlySnapshot.version === afterNetworkFailure.version
    && originalReadOnlyHash === afterNetworkHash
    && sameJson(originalReadOnlyStorage, await storageSnapshot())
    && originalReadOnlyBanner === afterNetworkBanner,
  `v${originalReadOnlySnapshot.version}→${afterNetworkFailure.version}; attempts=${fixtureState.activationAttempts.length}`);

  const activateHealthy = await evaluate(`(() => {
    const row=[...document.querySelectorAll('.project-node')].find((node)=>node.querySelector('.project-name')?.title===${JSON.stringify(cleanProject.id)});
    const button=row?.querySelector('button[title="切换到该项目"]');
    if(!button || button.disabled) return 'disabled-or-missing';
    button.click(); return 'clicked';
  })()`);
  await waitFor(`!document.querySelector('[data-testid=unit-identity-readonly-banner]') && document.querySelector('.app')?.dataset.projectId===${JSON.stringify(cleanProject.id)}`, 10000);
  check('刷新锁定后仅用户确认切换到 ProjectsPanel 中已校验的健康备选项目才原子替换并解锁', openProjectsAfterRefresh === 'clicked'
    && activateHealthy === 'clicked'
    && findDuplicateUnitIds(await liveBrowserBusSnapshot().then((snapshot) => snapshot.project)).length === 0
    && fixtureState.mode === 'unique'
    && fixtureState.activationAttempts.length === 3
    && fixtureState.writes.length === 1
    && fixtureState.writes[0].pathname.endsWith(`/${cleanProject.id}/activate`),
  `active=${await evaluate("document.querySelector('.app')?.dataset.projectId")}; attempts=${fixtureState.activationAttempts.length}; committed=${fixtureState.writes.length}`);
  await verifySecondLayerGuards(badProject, rules, cleanProject);
} catch (error) {
  check('harness 执行完成', false, error instanceof Error ? error.stack ?? error.message : String(error));
  for (const child of processes) if (child?._log) console.error(`\n--- ${child._name} 最近日志 ---\n${child._log.slice(-3000)}`);
} finally {
  if (cdp) {
    try { await cdp.send('Browser.close'); } catch { /* 浏览器可能已退出 */ }
    cdp.close();
  }
  await Promise.all(processes.map((child) => shutdown(child)));
  if (apiServer?.listening) await new Promise((resolve) => apiServer.close(resolve));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  if (httpFixtureRoot) fs.rmSync(httpFixtureRoot, { recursive: true, force: true, maxRetries: 5 });
}

console.log(`\nHistorical Unit ID readonly UI acceptance: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.error(`失败项：${failures.join(' | ')}`);
  process.exitCode = 1;
}


async function verifySecondLayerGuards(badProject, rules, cleanProject) {
  console.log('\nE. CommandBus 与隔离真实 HTTP server 的二道 fail-closed 检查');
  const bus = new CommandBus(structuredClone(badProject), rules);
  const before = { project: structuredClone(bus.getState()), version: bus.getVersion() };
  const update = bus.execute(resizeCabinet(bus.getState().cabinets[0], {
    width: badProject.cabinets[0].params.width + 100,
  }));
  const drawing = bus.execute(replaceDrawingEdits(badProject, [{
    id: 'readonly_ui_forbidden_drawing_edit', space: 'sheet', kind: 'line', view: 'top',
    cabinetId: badProject.cabinets[0].id, points: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
    layer: 'F-CAD-EDIT', lineWidth: 1, provenance: 'manual',
  }], 'readonly UI CommandBus drawing bypass probe'));
  let replaceProjectBlocked = false;
  try { bus.replaceProject({ ...bus.getState(), name: '不应覆盖的坏项目' }, 'readonly replaceProject bypass probe'); }
  catch (error) { replaceProjectBlocked = String(error).includes('显式修复/迁移'); }
  check('真实 CommandBus 拒绝柜体参数命令，且 Project/version 不变', !update.ok
    && update.error?.includes('显式修复/迁移')
    && sameJson(before, { project: bus.getState(), version: bus.getVersion() }), update.error ?? '');
  check('真实 CommandBus 拒绝 CAD drawingEdits 替换命令', !drawing.ok
    && drawing.error?.includes('显式修复/迁移')
    && sameJson(before, { project: bus.getState(), version: bus.getVersion() }), drawing.error ?? '');
  check('真实 CommandBus 拒绝 replaceProject 第二写入入口', replaceProjectBlocked
    && sameJson(before, { project: bus.getState(), version: bus.getVersion() }));

  const remoteLockedBus = new CommandBus(structuredClone(cleanProject), rules);
  remoteLockedBus.replaceProject({ ...remoteLockedBus.getState(), name: '健康项目：undo/redo 测试历史' }, 'seed healthy project history');
  remoteLockedBus.setExternalReadOnly('服务端检测到历史重复 Unit ID；需显式修复/迁移后恢复。');
  const healthyBefore = { project: structuredClone(remoteLockedBus.getState()), version: remoteLockedBus.getVersion() };
  const healthyWrite = remoteLockedBus.execute(resizeCabinet(remoteLockedBus.getState().cabinets[0], {
    width: cleanProject.cabinets[0].params.width + 100,
  }));
  let healthyReplaceBlocked = false;
  try { remoteLockedBus.replaceProject({ ...remoteLockedBus.getState(), name: '不得更改' }, 'remote readonly replace probe'); }
  catch { healthyReplaceBlocked = true; }
  const undoResult = remoteLockedBus.undo();
  const redoResult = remoteLockedBus.redo();
  check('本地唯一 ID + 远端锁下 CommandBus.execute 拒绝真实柜体写入', !healthyWrite.ok
    && healthyWrite.error?.includes('显式修复/迁移')
    && sameJson(healthyBefore, { project: remoteLockedBus.getState(), version: remoteLockedBus.getVersion() }));
  check('远端锁统一拒绝 replaceProject、undo、redo，已有历史亦不变', healthyReplaceBlocked
    && undoResult === false && redoResult === false
    && sameJson(healthyBefore, { project: remoteLockedBus.getState(), version: remoteLockedBus.getVersion() }));
  let duplicateSwitchRejected = false;
  try { remoteLockedBus.switchToValidatedHealthyProject(structuredClone(badProject), 'must not unlock bad project', true); }
  catch { duplicateSwitchRejected = true; }
  check('显式切换入口仍拒绝重复 ID 目标且不清锁/不改 Project/hash/version', duplicateSwitchRejected
    && Boolean(remoteLockedBus.getUnitIdentityConflict())
    && sameJson(healthyBefore, { project: remoteLockedBus.getState(), version: remoteLockedBus.getVersion() }));
  const stickyReason = remoteLockedBus.getUnitIdentityConflict();
  remoteLockedBus.setExternalReadOnly(null); // 模拟健康远端轮询/重复 hydrate 提供空诊断
  check('健康轮询/重复 hydrate 不能通过空诊断清除 CommandBus 粘滞锁', Boolean(stickyReason)
    && remoteLockedBus.getUnitIdentityConflict() === stickyReason
    && sameJson(healthyBefore, { project: remoteLockedBus.getState(), version: remoteLockedBus.getVersion() }));
  remoteLockedBus.switchToValidatedHealthyProject(structuredClone(cleanProject), 'user explicitly selected validated healthy project', true);
  check('只有完成 duplicate 扫描的显式健康项目切换入口才清除锁', remoteLockedBus.getUnitIdentityConflict() === null
    && remoteLockedBus.getState().id === cleanProject.id
    && findDuplicateUnitIds(remoteLockedBus.getState()).length === 0);

  const oldLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const projectStorageWrites = [];
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true, writable: true,
      value: {
        getItem: () => 'not-json',
        setItem: (...args) => projectStorageWrites.push(['set', ...args]),
        removeItem: (...args) => projectStorageWrites.push(['remove', ...args]),
      },
    });
    setProjectStorageReadOnly(true);
    const savedAt = saveDraft(cleanProject);
    clearDraft();
    loadDraft();
    check('project-storage 只读栅栏拒绝 save/clear/损坏草稿清理', savedAt === '' && projectStorageWrites.length === 0,
      `write/delete attempts=${projectStorageWrites.length}`);
  } finally {
    setProjectStorageReadOnly(false);
    if (oldLocalStorage) Object.defineProperty(globalThis, 'localStorage', oldLocalStorage);
    else delete globalThis.localStorage;
  }

  httpFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'historical-unit-id-http-fixture-'));
  const workspaceDir = path.join(httpFixtureRoot, 'workspaces', 'local-open');
  const draftsDir = path.join(workspaceDir, 'drafts');
  const exportTmp = path.join(httpFixtureRoot, 'export-tmp');
  fs.mkdirSync(draftsDir, { recursive: true });
  fs.mkdirSync(exportTmp, { recursive: true });
  const workspacePath = path.join(workspaceDir, 'workspace.json');
  const projectDir = path.join(workspaceDir, 'projects');
  fs.mkdirSync(projectDir, { recursive: true });
  const workspaceId = 'historical-unit-id-readonly-http-fixture';
  const envelope = JSON.parse(serializeProjectFile(badProject, '2026-10-09T00:00:00.000Z'));
  Object.assign(envelope, {
    workspaceId, owner: 'local-open', account: 'local-open',
    liveModelVersion: 9, updatedAt: '2026-10-09T00:00:00.000Z', draftSyncReceipts: {},
  });
  fs.writeFileSync(workspacePath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
  const httpDuplicateProject = structuredClone(badProject);
  httpDuplicateProject.id = 'http_duplicate_project_candidate';
  const writeProjectCandidate = (project, projectWorkspaceId) => {
    const projectEnvelope = JSON.parse(serializeProjectFile(project, '2026-10-09T00:00:00.000Z'));
    Object.assign(projectEnvelope, {
      workspaceId: projectWorkspaceId, owner: 'local-open', account: 'local-open',
      liveModelVersion: 4, updatedAt: '2026-10-09T00:00:00.000Z', draftSyncReceipts: {},
    });
    fs.writeFileSync(path.join(projectDir, `${project.id}.json`), `${JSON.stringify(projectEnvelope, null, 2)}\n`, 'utf8');
  };
  writeProjectCandidate(badProject, 'http-current-bad-project');
  writeProjectCandidate(httpDuplicateProject, 'http-duplicate-project-candidate');
  writeProjectCandidate(cleanProject, 'http-healthy-project-candidate');
  const activeProjectPath = path.join(workspaceDir, 'active-project.json');
  fs.writeFileSync(activeProjectPath, `${JSON.stringify({ activeId: badProject.id })}\n`, 'utf8');
  fs.writeFileSync(path.join(draftsDir, 'legacy_draft.json'), `${JSON.stringify({
    format: 'furniture-cad-draft', formatVersion: 2, draftId: 'legacy_draft',
    runId: 'legacy_run', revision: 1, workspaceId, baseModelVersion: 9,
    baseProjectHash: 'c'.repeat(64), owner: 'local-open', createdAt: '2026-10-09T00:00:00.000Z',
    project: structuredClone(badProject),
  }, null, 2)}\n`, 'utf8');
  const backendPort = await freePort();
  const backend = startProcess('isolated-fail-closed-http-server', process.execPath, [path.join(appRoot, 'server/server.mjs')], {
    cwd: appRoot,
    env: {
      ...process.env, PORT: String(backendPort), APP_HOST: '127.0.0.1',
      APP_ACCOUNTS_PATH: path.join(httpFixtureRoot, 'accounts.json'),
      APP_AUDIT_PATH: path.join(httpFixtureRoot, 'audit.jsonl'),
      APP_WORKSPACE_PATH: path.join(httpFixtureRoot, 'unused-base-workspace.json'),
      APP_MEM_PATH: path.join(httpFixtureRoot, 'mem.jsonl'), TMPDIR: exportTmp,
    },
  });
  const backendUrl = `http://127.0.0.1:${backendPort}`;
  await waitHttp(`${backendUrl}/api/health`, 20000);
  const getResponse = await fetch(`${backendUrl}/api/workspace`);
  const snapshot = await getResponse.json();
  const originalWorkspaceBytes = fs.readFileSync(workspacePath, 'utf8');
  check('隔离真实 HTTP server 从旧 workspace 返回重复身份只读诊断', getResponse.status === 200
    && snapshot.identityDiagnostics?.readOnly === true
    && snapshot.identityDiagnostics?.code === WORKSPACE_UNIT_ID_CONFLICT
    && snapshot.identityDiagnostics?.duplicateUnitIds?.some((item) => item.locations?.length >= 2),
  `status=${getResponse.status}; code=${snapshot.identityDiagnostics?.code}`);

  const exportBody = {
    project: snapshot.project,
    projectSnapshotId: snapshot.projectSnapshotId,
    projectSnapshotHash: snapshot.projectSnapshotHash,
    projectSnapshotVersion: snapshot.projectSnapshotVersion,
    which: ['sheet'], layoutRoomIds: [], modelVersion: `v${snapshot.projectSnapshotVersion}`,
  };
  const exportResponse = await fetch(`${backendUrl}/api/export/cutlist`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exportBody),
  });
  const exportPayload = await exportResponse.json().catch(() => ({}));
  check('真实 HTTP 生产开料导出第二道拒绝返回 4xx + WORKSPACE_UNIT_ID_CONFLICT', exportResponse.status >= 400 && exportResponse.status < 500
    && exportPayload.code === WORKSPACE_UNIT_ID_CONFLICT, `status=${exportResponse.status}; code=${exportPayload.code}`);

  const applyBody = {
    syncId: 'readonly_ui_http_sync_probe', draftId: 'legacy_draft', runId: 'readonly_ui_http_run',
    revision: 1, draftHash: 'b'.repeat(64), localVersion: 1, remoteVersion: snapshot.liveModelVersion,
    baseModelVersion: snapshot.liveModelVersion, baseProjectHash: snapshot.projectSnapshotHash,
  };
  const applyResponse = await fetch(`${backendUrl}/api/drafts/legacy_draft/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(applyBody),
  });
  const applyPayload = await applyResponse.json().catch(() => ({}));
  check('真实 HTTP MCP 草稿确认/同步第二道拒绝返回 409 + WORKSPACE_UNIT_ID_CONFLICT', applyResponse.status === 409
    && applyPayload.code === WORKSPACE_UNIT_ID_CONFLICT, `status=${applyResponse.status}; code=${applyPayload.code}`);

  const afterResponse = await fetch(`${backendUrl}/api/workspace`);
  const after = await afterResponse.json();
  check('HTTP 拒绝后真实 workspace 文件字节、Project、版本与快照 hash 不变', fs.readFileSync(workspacePath, 'utf8') === originalWorkspaceBytes
    && sameJson(snapshot.project, after.project)
    && snapshot.liveModelVersion === after.liveModelVersion
    && snapshot.projectSnapshotHash === after.projectSnapshotHash,
  `v${snapshot.liveModelVersion}→${after.liveModelVersion}; bytes=${originalWorkspaceBytes.length}`);

  const activeBytesBeforeSwitch = fs.readFileSync(activeProjectPath, 'utf8');
  const rejectedDuplicateResponse = await fetch(`${backendUrl}/api/projects/${httpDuplicateProject.id}/activate`, { method: 'POST' });
  const rejectedDuplicatePayload = await rejectedDuplicateResponse.json().catch(() => ({}));
  const afterDuplicateSwitchResponse = await fetch(`${backendUrl}/api/workspace`);
  const afterDuplicateSwitch = await afterDuplicateSwitchResponse.json();
  check('真实 server 拒绝重复身份目标激活，原 active ID、workspace 文件、Project/version/hash 保持不变', rejectedDuplicateResponse.status === 409
    && rejectedDuplicatePayload.code === WORKSPACE_UNIT_ID_CONFLICT
    && rejectedDuplicatePayload.identityDiagnostics?.duplicateUnitIds?.length >= 1
    && fs.readFileSync(activeProjectPath, 'utf8') === activeBytesBeforeSwitch
    && fs.readFileSync(workspacePath, 'utf8') === originalWorkspaceBytes
    && sameJson(snapshot.project, afterDuplicateSwitch.project)
    && snapshot.liveModelVersion === afterDuplicateSwitch.liveModelVersion
    && snapshot.projectSnapshotHash === afterDuplicateSwitch.projectSnapshotHash,
  `status=${rejectedDuplicateResponse.status}; code=${rejectedDuplicatePayload.code}; active unchanged=${fs.readFileSync(activeProjectPath, 'utf8') === activeBytesBeforeSwitch}`);

  const missingProjectResponse = await fetch(`${backendUrl}/api/projects/http_missing_project_candidate/activate`, { method: 'POST' });
  const missingProjectPayload = await missingProjectResponse.json().catch(() => ({}));
  const afterMissingProject = await (await fetch(`${backendUrl}/api/workspace`)).json();
  check('真实 server 对缺失/不可读取目标失败关闭且不半切换', missingProjectResponse.status === 404
    && missingProjectPayload.code === 'PROJECT_NOT_FOUND'
    && fs.readFileSync(activeProjectPath, 'utf8') === activeBytesBeforeSwitch
    && sameJson(snapshot.project, afterMissingProject.project)
    && snapshot.liveModelVersion === afterMissingProject.liveModelVersion,
  `status=${missingProjectResponse.status}; code=${missingProjectPayload.code}`);

  const healthySwitchResponse = await fetch(`${backendUrl}/api/projects/${cleanProject.id}/activate`, { method: 'POST' });
  const healthySwitchPayload = await healthySwitchResponse.json().catch(() => ({}));
  const afterHealthySwitch = await (await fetch(`${backendUrl}/api/workspace`)).json();
  check('真实 server 仅在健康目标通过身份校验后原子替换 active ID 与 WorkspaceStore', healthySwitchResponse.status === 200
    && healthySwitchPayload.ok === true
    && healthySwitchPayload.project?.id === cleanProject.id
    && afterHealthySwitch.project?.id === cleanProject.id
    && afterHealthySwitch.identityDiagnostics?.readOnly === false
    && JSON.parse(fs.readFileSync(activeProjectPath, 'utf8')).activeId === cleanProject.id,
  `status=${healthySwitchResponse.status}; active=${JSON.parse(fs.readFileSync(activeProjectPath, 'utf8')).activeId}`);
  await shutdown(backend);
}
