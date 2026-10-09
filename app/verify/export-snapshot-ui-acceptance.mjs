#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const processes = [];
let cdp;
let chrome;
let vite;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'furnicad-snapshot-ui-'));
let passed = 0;
let failed = 0;
const failures = [];

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
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('无法分配端口')));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function startProcess(name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child._name = name;
  child._log = '';
  child.stdout.on('data', (chunk) => { child._log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { child._log += chunk.toString(); });
  processes.push(child);
  return child;
}

async function waitHttp(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* service starting */ }
    await wait(100);
  }
  throw new Error(`等待服务超时：${url}`);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result ?? {});
  });
  return {
    ws,
    ready,
    send(method, params = {}) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { try { ws.close(); } catch { /* already closed */ } },
  };
}

async function evaluate(expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) throw new Error(`浏览器脚本异常：${JSON.stringify(response.exceptionDetails)}`);
  return response.result?.value;
}

async function waitFor(expression, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await wait(80);
  }
  throw new Error(`浏览器条件等待超时：${expression}`);
}

async function clickButton(label) {
  const found = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return 'missing';
    if (button.disabled) return 'disabled';
    button.click();
    return 'clicked';
  })()`);
  if (found !== 'clicked') throw new Error(`无法点击「${label}」：${found}`);
}

async function shutdown(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    wait(2500),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

try {
  const vitePort = await freePort();
  const cdpPort = await freePort();
  const viteBin = path.join(appRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  vite = startProcess('vite', process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], { cwd: appRoot });
  await waitHttp(`http://127.0.0.1:${vitePort}/verify/export-snapshot-ui-fixture.html`);

  chrome = startProcess('chromium', '/usr/bin/chromium', [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    'about:blank',
  ]);
  await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`);
  let targets = [];
  for (let attempt = 0; attempt < 50; attempt += 1) {
    targets = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
    if (targets.some((target) => target.type === 'page' && target.webSocketDebuggerUrl)) break;
    await wait(100);
  }
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) throw new Error('未找到 Chromium 页面目标');
  cdp = connectCdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const fixtureUrl = `http://127.0.0.1:${vitePort}/verify/export-snapshot-ui-fixture.html`;
  await cdp.send('Page.navigate', { url: fixtureUrl });
  await waitFor("Boolean(window.__snapshotExportTest && document.querySelector('[data-testid=draft-status]'))");
  await waitFor('Boolean(document.querySelector("button"))');

  console.log('A. 确认快照一致：PDF / DXF / CSV / HTML 图册请求携带服务端原样 ID/hash/version');
  for (const [label, urlSuffix] of [
    ['导出横向 PDF 图纸', '/api/export/pdf'],
    ['导出 DXF 图纸', '/api/export/dxf'],
    ['导出开料单 CSV', '/api/export/cutlist'],
    ['下载 HTML 打印版（备用）', '/api/export/roombook'],
  ]) {
    const before = await evaluate('window.__snapshotExportTest.requests.length');
    await clickButton(label);
    await waitFor(`window.__snapshotExportTest.requests.length === ${before + 1}`);
    const record = await evaluate(`window.__snapshotExportTest.requests[${before}]`);
    const body = record?.body ?? {};
    const expected = body.projectSnapshotId === `ws_snapshot_ui_fixture:v41:${'a'.repeat(64)}`
      && body.projectSnapshotHash === 'a'.repeat(64)
      && body.projectSnapshotVersion === 41
      && body.modelVersion === 'v41'
      && body.project?.id === 'project_snapshot_ui_fixture';
    check(`${urlSuffix} 匹配快照可以提交，且携带准确元数据`, record?.url === urlSuffix && expected,
      `url=${record?.url}; id=${String(body.projectSnapshotId)}; version=${String(body.projectSnapshotVersion)}`);
    await waitFor('!document.querySelector("button.primary")?.disabled');
  }

  console.log('\nB. 服务端明确返回 409 版本冲突：面板说明字段、同步/刷新建议与 JSON 可用');
  await evaluate('window.__snapshotExportTest.setNextConflict()');
  const beforeConflict = await evaluate('window.__snapshotExportTest.requests.length');
  await clickButton('导出开料单 CSV');
  await waitFor(`window.__snapshotExportTest.requests.length === ${beforeConflict + 1}`);
  await waitFor("Boolean(document.querySelector('[data-testid=export-snapshot-conflict]'))");
  const conflictText = await evaluate("document.querySelector('[data-testid=export-snapshot-conflict]').innerText");
  check('409 冲突提示明确解释快照冲突并建议同步/刷新',
    conflictText.includes('EXPORT_SNAPSHOT_CONFLICT') && conflictText.includes('projectSnapshotVersion')
      && (conflictText.includes('同步工作区') || conflictText.includes('刷新页面')),
    conflictText.replace(/\s+/g, ' ').slice(0, 240));
  const blockedAfter409 = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '导出开料单 CSV');
    return Boolean(button?.disabled);
  })()`);
  check('服务器 409 后阻断旧快照的后续生产导出', blockedAfter409 === true);
  check('冲突后 JSON 项目存档功能仍可用', await evaluate('Boolean([...document.querySelectorAll("button")].find((item) => item.textContent.includes("存为项目文件 .json") && !item.disabled))'));

  console.log('\nC. 本地内容变更：在请求前 fail-closed，且不自动替换成服务器项目');
  const changedProject = await evaluate('JSON.parse(JSON.stringify(window.__snapshotExportTest.requests[0].body.project))');
  changedProject.name = '浏览器本地未确认修改';
  await evaluate(`window.__snapshotExportTest.setLocalProject(${JSON.stringify(changedProject)})`);
  await waitFor("Boolean(document.querySelector('[data-testid=export-blocked-local-snapshot]'))");
  const localAlert = await evaluate("document.querySelector('[data-testid=export-blocked-local-snapshot]').innerText");
  const beforeBlocked = await evaluate('window.__snapshotExportTest.requests.length');
  const exportButtonState = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '导出开料单 CSV');
    return button ? { disabled: button.disabled, localName: window.__snapshotExportTest.requests[0].body.project.name } : null;
  })()`);
  check('本地项目相对确认快照改变后导出按钮关闭，并显示解释', exportButtonState?.disabled === true
    && localAlert.includes('最近确认的服务器快照不一致') && exportButtonState.localName === '快照导出 UI 验收',
  `${localAlert.replace(/\s+/g, ' ').slice(0, 200)}; button=${JSON.stringify(exportButtonState)}`);
  const afterBlocked = await evaluate('window.__snapshotExportTest.requests.length');
  check('本地内容漂移阻断没有发出额外导出请求', beforeBlocked === afterBlocked, `requests=${afterBlocked}`);

  console.log(`\nExport snapshot UI acceptance: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  for (const child of processes) if (child?._log) console.error(`\n--- ${child._name} log ---\n${child._log.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  if (cdp) {
    try { await cdp.send('Browser.close'); } catch { /* browser may have exited */ }
    cdp.close();
  }
  await shutdown(chrome);
  await shutdown(vite);
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}
