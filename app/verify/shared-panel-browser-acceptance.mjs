#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import { manufacturingToNeutralExportDefault } from '../src/core/manufacturing/bridge.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(readFileSync(path.join(root, 'src/core/ruleset/factory-default.json'), 'utf8'));
async function nextPort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
function parseCsvLine(line) {
  const cells = []; let value = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && quoted && line[i + 1] === '"') { value += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { cells.push(value); value = ''; }
    else value += char;
  }
  cells.push(value); return cells;
}
const normalized = (value) => String(value).replace(/\s+/gu, '');
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
const sameJson = (a, b) => stableJson(a) === stableJson(b);
function readDxfSharedSegments(dxfPath, panelId, scale, expectedSegments) {
  const script = [
    'import ezdxf, json, sys', 'doc = ezdxf.readfile(sys.argv[1])', 'target = "sharedPanelId=" + sys.argv[2]',
    'expected = json.loads(sys.argv[4])', 'for layout in doc.layouts:',
    '    texts = [entity.plain_text() for entity in layout if entity.dxftype() in ("TEXT", "MTEXT")]',
    '    if not any(target in text for text in texts): continue',
    '    polys = [entity for entity in layout if entity.dxftype() == "LWPOLYLINE" and entity.closed]',
    '    matched = []', '    for poly in polys:', '        points = list(poly.get_points("xy"))',
    '        length = (max(p[0] for p in points) - min(p[0] for p in points)) / float(sys.argv[3])',
    '        width = (max(p[1] for p in points) - min(p[1] for p in points)) / float(sys.argv[3])',
    '        if any((abs(length - item["length"]) < 1e-6 and abs(width - item["width"]) < 1e-6) or (abs(width - item["length"]) < 1e-6 and abs(length - item["width"]) < 1e-6) for item in expected): matched.append({"length": length, "width": width})',
    '    print(json.dumps({"matched": matched, "text": texts}))', '    break',
  ].join('\n');
  const result = spawnSync('python3', ['-c', script, dxfPath, panelId, String(scale), JSON.stringify(expectedSegments)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`DXF 闭合轮廓读取失败：${result.stderr}`);
  return JSON.parse(result.stdout);
}
function checkSegmentation(project, panel, expectedSegments) {
  const cabinets = new Map(project.cabinets.map((cabinet) => [cabinet.id, cabinet]));
  const points = panel.memberCabinetIds.flatMap((id) => {
    const cabinet = cabinets.get(id); if (!cabinet) return [];
    const w = cabinet.params.width, d = cabinet.params.depth, rotation = (cabinet.placement.rotation * Math.PI) / 180;
    return [{ x: cabinet.placement.x, y: cabinet.placement.y },
      { x: cabinet.placement.x + w * Math.cos(rotation), y: cabinet.placement.y + w * Math.sin(rotation) },
      { x: cabinet.placement.x - d * Math.sin(rotation), y: cabinet.placement.y + d * Math.cos(rotation) },
      { x: cabinet.placement.x + w * Math.cos(rotation) - d * Math.sin(rotation), y: cabinet.placement.y + w * Math.sin(rotation) + d * Math.cos(rotation) }];
  });
  const base = points.length ? { minX: Math.min(...points.map((p) => p.x)), minY: Math.min(...points.map((p) => p.y)), maxX: Math.max(...points.map((p) => p.x)), maxY: Math.max(...points.map((p) => p.y)) } : null;
  const expectedBounds = base ? { minX: base.minX - panel.overhang.left, minY: base.minY - panel.overhang.back, maxX: base.maxX + panel.overhang.right, maxY: base.maxY + panel.overhang.front } : null;
  const bounds = panel.bounds, segments = panel.segmentation?.segments ?? [];
  const inside = segments.every((s) => s.x >= bounds.minX && s.y >= bounds.minY && s.x + s.length <= bounds.maxX && s.y + s.width <= bounds.maxY);
  const overlaps = segments.some((a, i) => segments.slice(i + 1).some((b) => a.x < b.x + b.length && a.x + a.length > b.x && a.y < b.y + b.width && a.y + a.width > b.y));
  const area = segments.reduce((sum, s) => sum + s.length * s.width, 0), boundsArea = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
  const xEdges = [...new Set([bounds.minX, bounds.maxX, ...segments.flatMap((s) => [s.x, s.x + s.length])])].sort((a, b) => a - b);
  const stripCoverageClosed = xEdges.slice(0, -1).every((left, index) => {
    const right = xEdges[index + 1]; if (right <= left) return true;
    const intervals = segments.filter((s) => s.x <= left && s.x + s.length >= right).map((s) => [s.y, s.y + s.width]).sort((a, b) => a[0] - b[0]);
    let cursor = bounds.minY;
    for (const [low, high] of intervals) { if (low !== cursor || high <= low) return false; cursor = high; }
    return cursor === bounds.maxY;
  });
  const sheet = rules.materials[panel.material]?.maxSheet ?? rules.limits.maxSheetSize;
  const allSegmentsWithinSheet = segments.every((s) => (s.length <= sheet[0] && s.width <= sheet[1]) || (s.length <= sheet[1] && s.width <= sheet[0]));
  return { boundsMatch: Boolean(expectedBounds && sameJson(expectedBounds, bounds)), expectedBounds, insideBounds: inside, noOverlap: !overlaps,
    areaSum: area, boundsArea, exactCoverage: inside && !overlaps && area === boundsArea && stripCoverageClosed, stripCoverageClosed,
    allSegmentsWithinSheet, sheetSize: sheet, formSegmentsMatch: sameJson(segments, expectedSegments), segments };
}
async function startIsolatedApi(project) {
  const temp = mkdtempSync(path.join(tmpdir(), 'shared-panel-browser-http-'));
  const serverTemp = path.join(temp, 'server-tmp'), workspacePath = path.join(temp, 'workspace.json'), port = await nextPort();
  let child, childLog = '';
  try {
    mkdirSync(serverTemp, { recursive: true });
    const envelope = JSON.parse(serializeProjectFile(project));
    Object.assign(envelope, { workspaceId: `ws_b48_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, owner: 'local-open', account: 'local-open', liveModelVersion: 48, updatedAt: new Date().toISOString() });
    writeFileSync(workspacePath, JSON.stringify(envelope, null, 2), 'utf8');
    child = spawn(process.execPath, [path.join(root, 'server/server.mjs')], { cwd: root, env: { ...process.env,
      PORT: String(port), APP_HOST: '127.0.0.1', TMPDIR: serverTemp, APP_ENV_PATH: path.join(temp, '.env'),
      APP_ACCOUNTS_PATH: path.join(temp, 'accounts.json'), APP_AUDIT_PATH: path.join(temp, 'audit.jsonl'),
      APP_MEM_PATH: path.join(temp, 'corrections.jsonl'), APP_REGISTRATIONS_PATH: path.join(temp, 'registrations.json'), APP_WORKSPACE_PATH: workspacePath }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => { childLog += chunk.toString(); }); child.stderr.on('data', (chunk) => { childLog += chunk.toString(); });
    let ready = false;
    for (let attempt = 0; attempt < 180; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try { const health = await fetch(`http://127.0.0.1:${port}/api/health`); if (health.ok && (await health.json()).workspace?.loading === false) { ready = true; break; } } catch { /* wait */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`隔离正式 HTTP 服务启动失败：${childLog.slice(-2000)}`);
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace`);
    if (!response.ok) throw new Error(`/api/workspace 返回 ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    const snapshot = await response.json();
    if (!snapshot.projectSnapshotId || !snapshot.projectSnapshotHash || !Number.isInteger(snapshot.projectSnapshotVersion)) throw new Error('隔离服务未返回有效 snapshotId/hash/version');
    return { temp, serverTemp, port, child, snapshot };
  } catch (error) {
    if (child && child.exitCode === null) child.kill('SIGTERM'); rmSync(temp, { recursive: true, force: true }); throw error;
  }
}
async function stopIsolatedApi(api) {
  if (api.child && api.child.exitCode === null && api.child.signalCode === null) await new Promise((resolve) => {
    const timeout = setTimeout(() => { api.child.kill('SIGKILL'); resolve(); }, 4000);
    api.child.once('exit', () => { clearTimeout(timeout); resolve(); }); api.child.kill('SIGTERM');
  });
  rmSync(api.temp, { recursive: true, force: true });
}
async function requestApiExport(api, kind) {
  const route = { csv: '/api/export/cutlist', pdf: '/api/export/pdf', dxf: '/api/export/dxf', roombook: '/api/export/roombook' }[kind];
  const s = api.snapshot;
  return fetch(`http://127.0.0.1:${api.port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: s.project, projectSnapshotId: s.projectSnapshotId, projectSnapshotHash: s.projectSnapshotHash,
      projectSnapshotVersion: s.projectSnapshotVersion, which: ['sheet'], layoutRoomIds: [], modelVersion: `v${s.projectSnapshotVersion}` }) });
}
async function inspectExports(project, expectedSegments) {
  const panel = project.sharedPanels?.[0]; if (!panel) throw new Error('浏览器提交项目中没有 SharedPanel');
  const temp = mkdtempSync(path.join(tmpdir(), 'shared-panel-browser-readback-'));
  const api = await startIsolatedApi(project);
  try {
    const stored = api.snapshot.project.sharedPanels?.find((item) => item.id === panel.id);
    if (!stored || !sameJson(stored, panel)) throw new Error('HTTP WorkspaceStore 读回的 SharedPanel 与浏览器保存记录不一致');
    const geometry = checkSegmentation(api.snapshot.project, stored, expectedSegments);
    const [csvResponse, pdfResponse, dxfResponse, roomResponse] = await Promise.all([requestApiExport(api, 'csv'), requestApiExport(api, 'pdf'), requestApiExport(api, 'dxf'), requestApiExport(api, 'roombook')]);
    const csvBuffer = Buffer.from(await csvResponse.arrayBuffer()), pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer()), dxfBuffer = Buffer.from(await dxfResponse.arrayBuffer()), roomHtml = await roomResponse.text();
    const headersMatch = (r) => r.headers.get('X-Project-Snapshot-Id') === api.snapshot.projectSnapshotId && r.headers.get('X-Project-Snapshot-Hash') === api.snapshot.projectSnapshotHash && r.headers.get('X-Project-Snapshot-Version') === String(api.snapshot.projectSnapshotVersion);
    const httpOk = [csvResponse, pdfResponse, dxfResponse, roomResponse].every((r) => r.status === 200 && headersMatch(r));
    const pdfPath = path.join(temp, 'shared.pdf'), dxfPath = path.join(temp, 'shared.dxf'), neutralPath = path.join(temp, 'neutral.json');
    writeFileSync(pdfPath, pdfBuffer); writeFileSync(dxfPath, dxfBuffer);
    const neutral = manufacturingToNeutralExportDefault(api.snapshot.project, rules, ['sheet'], `v${api.snapshot.projectSnapshotVersion}`); writeFileSync(neutralPath, JSON.stringify(neutral));
    const textResult = spawnSync('pdftotext', ['-layout', pdfPath, '-'], { encoding: 'utf8' });
    if (textResult.status !== 0) throw new Error(`正式 HTTP PDF 文本读回失败：${textResult.stderr}`);
    const pdfText = textResult.stdout, pdfCompact = normalized(pdfText), boundsText = JSON.stringify(panel.bounds);
    const pdfSegmentChecks = panel.segmentation.segments.map((s) => [`"id":"${s.id}"`, `"x":${s.x}`, `"y":${s.y}`, `"length":${s.length}`, `"width":${s.width}`].every((needle) => pdfCompact.includes(needle)));
    const pdfOk = pdfText.includes(panel.id) && pdfCompact.includes(normalized(boundsText)) && pdfText.includes(`成品尺寸/标高：${panel.length}×${panel.width}×${panel.thickness}mm`)
      && pdfSegmentChecks.every(Boolean) && panel.memberCabinetIds.every((id) => pdfText.includes(id));
    const csvText = csvBuffer.toString('utf8').replace(/^\uFEFF/u, ''), csvRows = csvText.trim().split(/\r?\n/u).map(parseCsvLine).filter((cells) => cells[12] === panel.id);
    const csvMeta = csvRows[0]?.[16] ? JSON.parse(csvRows[0][16]) : null;
    const csvSegments = panel.segmentation.segments.map((s) => { const row = csvRows.find((cells) => cells[13] === s.id); return Boolean(row && Number(row[7]) === s.length && Number(row[8]) === s.width); });
    const csvOk = csvBuffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && csvRows.length === panel.segmentation.segments.length
      && csvSegments.every(Boolean) && sameJson(csvMeta?.bounds, panel.bounds) && sameJson(csvMeta?.segmentation, panel.segmentation)
      && csvRows.every((cells) => panel.memberCabinetIds.every((id) => cells[14]?.includes(id)));
    const dxfCheck = spawnSync('python3', [path.join(root, 'py/verify_dxf.py'), dxfPath, neutralPath], { cwd: root, encoding: 'utf8' });
    if (dxfCheck.status !== 0) throw new Error(`正式 HTTP DXF 语义回读失败：${dxfCheck.stderr || dxfCheck.stdout}`);
    const report = JSON.parse(dxfCheck.stdout), sheet = neutral.sheets.find((s) => s.kind === 'shared-panel' && s.sharedPanelId === panel.id);
    const comparison = report.neutralSemantics?.sheets?.find((s) => s.sheet === sheet?.name);
    const expectedSizes = panel.segmentation.segments.map(({ length, width }) => ({ length, width }));
    const dxfReadback = comparison?.scale ? readDxfSharedSegments(dxfPath, panel.id, comparison.scale, expectedSizes) : null;
    const dxfNotes = report.texts?.join('\n') ?? '', dxfCompact = normalized(dxfNotes), dxfBounds = `bounds=${panel.bounds.minX},${panel.bounds.minY}~${panel.bounds.maxX},${panel.bounds.maxY}`;
    const dxfSegments = panel.segmentation.segments.map((s) => dxfCompact.includes(`${s.id}@${s.x},${s.y}${s.length}×${s.width}`) && dxfCompact.includes(`${panel.id}/${s.id}/${s.length}×${s.width}×${panel.thickness}mm`));
    const outlinesMatch = Boolean(dxfReadback?.matched?.length === expectedSizes.length && expectedSizes.every((expected) => dxfReadback.matched.some((actual) =>
      (Math.abs(actual.length - expected.length) < 1e-6 && Math.abs(actual.width - expected.width) < 1e-6) || (Math.abs(actual.width - expected.length) < 1e-6 && Math.abs(actual.length - expected.width) < 1e-6))));
    const dxfOk = Boolean(report.neutralSemantics?.ok && sheet && outlinesMatch && dxfSegments.every(Boolean) && dxfCompact.includes(`sharedPanelId=${panel.id}`)
      && dxfCompact.includes(normalized(dxfBounds)) && panel.memberCabinetIds.every((id) => dxfNotes.includes(id)));
    const cabinetPageIds = project.cabinets.filter((c) => roomHtml.includes(`data-page-kind="cabinet" data-room-id="${c.roomId}" data-cabinet-id="${c.id}"`)).map((c) => c.id);
    const roomBounds = JSON.stringify(panel.bounds).replace(/"/gu, '&quot;');
    const roomSegments = JSON.stringify(panel.segmentation).replace(/"/gu, '&quot;');
    const roomBookSharedOk = roomHtml.includes(`data-shared-panel-id="${panel.id}"`) && roomHtml.includes(roomBounds) && roomHtml.includes(roomSegments)
      && panel.segmentation.segments.every((s) => roomHtml.includes(s.id) && roomHtml.includes(`${s.length}×${s.width}mm`));
    const cabinetPagesOk = roomResponse.status === 200 && cabinetPageIds.length === project.cabinets.length;
    const afterExportsResponse = await fetch(`http://127.0.0.1:${api.port}/api/workspace`);
    const afterExports = afterExportsResponse.ok ? await afterExportsResponse.json() : null;
    const snapshotStable = Boolean(afterExports && afterExports.projectSnapshotId === api.snapshot.projectSnapshotId
      && afterExports.projectSnapshotHash === api.snapshot.projectSnapshotHash && afterExports.projectSnapshotVersion === api.snapshot.projectSnapshotVersion);
    const serverTempEntries = readdirSync(api.serverTemp).sort();
    return { ok: httpOk && snapshotStable && geometry.boundsMatch && geometry.noOverlap && geometry.exactCoverage && geometry.allSegmentsWithinSheet && geometry.formSegmentsMatch && csvOk && pdfOk && dxfOk && roomBookSharedOk && cabinetPagesOk && serverTempEntries.length === 0,
      api: { routes: true, snapshotId: api.snapshot.projectSnapshotId, snapshotHash: api.snapshot.projectSnapshotHash, snapshotVersion: api.snapshot.projectSnapshotVersion,
        status: { csv: csvResponse.status, pdf: pdfResponse.status, dxf: dxfResponse.status, roombook: roomResponse.status }, headersMatch: httpOk, snapshotStableAfterExports: snapshotStable, serverTempEntries },
      panelId: panel.id, bounds: panel.bounds, size: [panel.length, panel.width, panel.thickness], geometry, formSegmentsMatch: geometry.formSegmentsMatch,
      csv: { ok: csvOk, hasPanelId: csvRows.length > 0, hasBounds: sameJson(csvMeta?.bounds, panel.bounds), segmentsMatch: csvSegments.every(Boolean), rows: csvRows.map((c) => ({ segmentId: c[13], length: Number(c[7]), width: Number(c[8]) })), metadata: csvMeta },
      pdf: { ok: pdfOk, hasPanelId: pdfText.includes(panel.id), hasBounds: pdfCompact.includes(normalized(boundsText)), segmentChecks: pdfSegmentChecks, cabinetPagesOk, cabinetPageIds },
      roombook: { ok: roomBookSharedOk, hasPanelId: roomHtml.includes(panel.id), hasBounds: roomHtml.includes(roomBounds), hasSegments: roomHtml.includes(roomSegments) },
      dxf: { ok: dxfOk, hasPanelId: dxfCompact.includes(`sharedPanelId=${panel.id}`), hasBounds: dxfCompact.includes(normalized(dxfBounds)), segmentsMatch: dxfSegments.every(Boolean), closedOutlines: dxfReadback?.matched ?? [] },
      cabinetSheetIds: project.cabinets.map((c) => c.id) };
  } finally { rmSync(temp, { recursive: true, force: true }); await stopIsolatedApi(api); }
}
async function inspectDraftLock(project) {
  const api = await startIsolatedApi(project);
  try {
    const before = api.snapshot;
    const afterResponse = await fetch(`http://127.0.0.1:${api.port}/api/workspace`);
    const after = afterResponse.ok ? await afterResponse.json() : null;
    const serverTempEntries = readdirSync(api.serverTemp).sort();
    const snapshotStable = Boolean(after && before.projectSnapshotId === after.projectSnapshotId
      && before.projectSnapshotHash === after.projectSnapshotHash && before.projectSnapshotVersion === after.projectSnapshotVersion);
    return { ok: snapshotStable && serverTempEntries.length === 0, snapshotStable, snapshotId: before.projectSnapshotId,
      snapshotHash: before.projectSnapshotHash, snapshotVersion: before.projectSnapshotVersion, serverTempEntries, zeroTempFiles: serverTempEntries.length === 0 };
  } finally { await stopIsolatedApi(api); }
}
async function inspectBlockedHttp(project, expectedReason) {
  const api = await startIsolatedApi(project);
  try {
    const routeResults = {}, blockedKinds = [];
    for (const kind of ['csv', 'pdf', 'dxf']) {
      const response = await requestApiExport(api, kind), text = await response.text(); let body = {};
      try { body = JSON.parse(text); } catch { /* preserve response status */ }
      const issues = (Array.isArray(body.issues) ? body.issues : []).map((item) => item.message ?? '').join('；');
      const zeroArtifacts = readdirSync(api.serverTemp).length === 0;
      const ok = response.status === 422 && body.code === 'EXPORT_BLOCKED' && expectedReason.test(issues) && !response.headers.has('Content-Disposition') && zeroArtifacts;
      if (ok) blockedKinds.push(kind);
      routeResults[kind] = { status: response.status, code: body.code, issueText: issues, zeroArtifacts, noAttachment: !response.headers.has('Content-Disposition'),
        snapshotId: api.snapshot.projectSnapshotId, snapshotHash: api.snapshot.projectSnapshotHash, snapshotVersion: api.snapshot.projectSnapshotVersion };
    }
    return { ok: blockedKinds.length === 3 && Object.values(routeResults).every((r) => r.zeroArtifacts), blockedKinds,
      zeroArtifacts: Object.values(routeResults).every((r) => r.zeroArtifacts), api: { routes: true, snapshotId: api.snapshot.projectSnapshotId, snapshotHash: api.snapshot.projectSnapshotHash, snapshotVersion: api.snapshot.projectSnapshotVersion }, routesResult: routeResults };
  } finally { await stopIsolatedApi(api); }
}
const oraclePort = await nextPort(), oracleUrl = `http://127.0.0.1:${oraclePort}/verify`;
const oracle = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  if (request.method !== 'POST' || request.url !== '/verify') { response.writeHead(404).end(); return; }
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const reasons = { unconfirmed: /接缝\/分段方案未确认/u, reference: /参考标记|参考孔位/u, unconfirmedHole: /CNC 孔位尚未确认/u, stale: /stale|已变化|快照缺失/u };
    const result = input.mode === 'exports' ? await inspectExports(input.project, input.expectedSegments)
      : input.mode === 'draftLock' ? await inspectDraftLock(input.project)
        : await inspectBlockedHttp(input.project, reasons[input.mode] ?? /接缝\/分段方案未确认/u);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  }
});
await new Promise((resolve) => oracle.listen(oraclePort, '127.0.0.1', resolve));
const usedPorts = new Set();
async function nextFreePort() { for (let attempt = 0; attempt < 20; attempt++) { const port = await nextPort(); if (!usedPorts.has(port) && port !== oraclePort) { usedPorts.add(port); return port; } } throw new Error('无法分配独立浏览器验收端口'); }
const ports = []; for (let index = 0; index < 4; index++) ports.push(await nextFreePort());
const [appPort, cdpPort, apiPort, mockPort] = ports;
const env = { ...process.env, ONLY: 'B48_SHARED_PANEL_UI', STOP_AFTER_ONLY: '1', APP_PORT: String(appPort), CDP_PORT: String(cdpPort), API_PORT: String(apiPort), MOCK_PORT: String(mockPort), SHARED_PANEL_EXPORT_ORACLE_URL: oracleUrl };
console.log('运行真实浏览器 SharedPanel 验收：未确认分段阻断 / 编辑期导出锁 / 正式 HTTP 三格式回读 / 参考孔与 stale 阻断');
console.log(`隔离端口：app=${appPort}, CDP=${cdpPort}, api=${apiPort}, mock=${mockPort}, browser-oracle=${oraclePort}（内部另启真实隔离 HTTP 导出服务）`);
const runner = spawn(process.execPath, [path.join(root, 'verify/run-ui-verify.mjs')], { cwd: root, env, stdio: 'inherit' });
const result = await new Promise((resolve) => { runner.once('error', (error) => resolve({ code: 1, error })); runner.once('exit', (code, signal) => resolve({ code: code ?? 1, signal })); });
await new Promise((resolve) => oracle.close(resolve));
if (result.error) { console.error(`独立 UI runner 启动失败：${result.error.message}`); process.exitCode = 1; }
else if (result.signal) { console.error(`独立 UI runner 被信号终止：${result.signal}`); process.exitCode = 1; }
else process.exitCode = result.code;
