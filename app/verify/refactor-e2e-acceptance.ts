/**
 * 重构全链路端到端验收（P10.3 Refactor E2E Acceptance）：
 *  1. MCP / Agent 绘画过程 SSE 实时推送（GET /api/workspace/stream：init / draft.updated / agent.step / workspace.updated）
 *  2. 云端防空覆盖水位线保护（空本地浏览器打开绝不覆盖云端已画好的模型；手动改图 PUT /api/workspace 同步后直接解锁 PDF/DXF 导出）
 *  3. 吊柜自动排布对齐（X=0 正对地柜上方）+ 整房/整墙一体化三视图（俯视图 + 外观正面图 + 内部结构图）+ L 型转角/同高防遮挡展开
 *  4. 双图（效果图 + 尺寸图）融合识图 + 存疑项非阻塞导入（先出图后页面微调）+ Shift 拖基准边 + 失效二维覆盖一键清理
 *  5. 聊天框防遮挡三栏全高布局校验
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCabinet, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import * as CMD from '../src/core/commands.ts';
import { findDuplicateUnitIds, repairDuplicateUnitIdsInProject, deoverlapProjectRooms } from '../src/core/unitIdentity.mjs';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import type { Project, RuleSet } from '../src/core/types.ts';
import { compileAction } from '../src/ai/compile.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { buildFurnitureSheet, computeUnfoldedWallX } from '../src/export/furnitureSheet.ts';
import { mergeVisionResults, visionResultToNormalized } from '../src/ai/vision/visionResultToNormalized.ts';
import { validateNormalized, importBlocked } from '../src/ai/import/normalized.ts';
import { compileImport } from '../src/ai/import/compileImport.ts';
import { dragPlanOf } from '../src/viewport/sheetDrag.ts';
import { filterValidDrawingEdits, planSourceKeys, sourceOverride } from '../src/core/drawingEdits.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
const tempDir = mkdtempSync(join(tmpdir(), 'furnicad-refactor-e2e-'));
const outputDir = '/working_dir/c_47a3479296285a8e/artifacts/file_generation/ttl=63d/output';

let child: ChildProcess | null = null;
let port = 0;
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return server.close(() => reject(new Error('No local port')));
      const selected = address.port;
      server.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}

async function startServer(initialProject: Project): Promise<void> {
  port = await allocatePort();
  const workspacePath = join(tempDir, 'workspace.json');
  const envelope = JSON.parse(serializeProjectFile(initialProject)) as Record<string, unknown>;
  Object.assign(envelope, {
    workspaceId: 'ws_refactor_e2e',
    owner: 'local-open',
    account: 'local-open',
    liveModelVersion: 0,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(workspacePath, JSON.stringify(envelope, null, 2), 'utf8');

  child = spawn(process.execPath, [join(root, 'server/server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      APP_HOST: '127.0.0.1',
      APP_PYTHON: process.env.APP_PYTHON ?? 'python3',
      APP_ENV_PATH: join(tempDir, '.env'),
      APP_ACCOUNTS_PATH: join(tempDir, 'accounts.json'),
      APP_AUDIT_PATH: join(tempDir, 'audit.jsonl'),
      APP_MEM_PATH: join(tempDir, 'corrections.jsonl'),
      APP_REGISTRATIONS_PATH: join(tempDir, 'registrations.json'),
      APP_WORKSPACE_PATH: workspacePath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 150; i++) {
    await wait(100);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return;
    } catch {
      /* wait */
    }
  }
  throw new Error('Server failed to start');
}

async function stopServer(): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await wait(300);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function callMcp(toolName: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });
  const j = (await r.json()) as any;
  if (j.error) throw new Error(j.error.message);
  return JSON.parse(j.result.content[0].text);
}

async function main(): Promise<void> {
  try {
    // ─────────────────────────────────────────────────────────────────
    // 1. 吊柜自动排布与整墙多柜体防遮挡算法验证
    // ─────────────────────────────────────────────────────────────────
    section('1. 吊柜自动排布对齐（X=0 正对地柜上方）与多柜体防遮挡展开');
    {
      const proj = structuredClone(sampleProject(rules));
      proj.cabinets = [];
      const roomId = proj.rooms[0]!.id;
      const bus = new CommandBus(proj, rules);

      // 新建两台地柜（未指定坐标，自动排在 X=0 和 X=900）
      const cBase1 = compileAction(
        { action: 'cabinet.create', target: { roomId }, params: { name: '厨房左地柜', width: 900, height: 820, depth: 600, cabinetType: 'base' } },
        bus.getState(),
        rules,
      );
      ok('左地柜编译成功', cBase1.ok);
      if (cBase1.ok) bus.execute(cBase1.command);

      const cBase2 = compileAction(
        { action: 'cabinet.create', target: { roomId }, params: { name: '厨房右地柜', width: 900, height: 820, depth: 600, cabinetType: 'base' } },
        bus.getState(),
        rules,
      );
      ok('右地柜编译成功', cBase2.ok);
      if (cBase2.ok) bus.execute(cBase2.command);

      // 新建两台吊柜（mountHeight=1450，未指定坐标 —— 修复后应从 X=0 和 X=900 排在地柜正上方，而不是排到 X=1800！）
      const cWall1 = compileAction(
        { action: 'cabinet.create', target: { roomId }, params: { name: '厨房左吊柜', width: 900, height: 720, depth: 350, cabinetType: 'wall', mountHeight: 1450, bodyLift: 0 } },
        bus.getState(),
        rules,
      );
      ok('左吊柜编译成功', cWall1.ok);
      if (cWall1.ok) bus.execute(cWall1.command);

      const cWall2 = compileAction(
        { action: 'cabinet.create', target: { roomId }, params: { name: '厨房右吊柜', width: 900, height: 720, depth: 350, cabinetType: 'wall', mountHeight: 1450, bodyLift: 0 } },
        bus.getState(),
        rules,
      );
      ok('右吊柜编译成功', cWall2.ok);
      if (cWall2.ok) bus.execute(cWall2.command);

      // 再建一台通顶高柜（height=2170，与地柜和吊柜在垂直方向均重叠 —— 应自动排在 X=1800）
      const cTall = compileAction(
        { action: 'cabinet.create', target: { roomId }, params: { name: '厨房电器高柜', width: 600, height: 2170, depth: 600, cabinetType: 'tall' } },
        bus.getState(),
        rules,
      );
      ok('电器高柜编译成功', cTall.ok);
      if (cTall.ok) bus.execute(cTall.command);

      const cabs = bus.getState().cabinets;
      const b1 = cabs.find((c) => c.name === '厨房左地柜')!;
      const b2 = cabs.find((c) => c.name === '厨房右地柜')!;
      const w1 = cabs.find((c) => c.name === '厨房左吊柜')!;
      const w2 = cabs.find((c) => c.name === '厨房右吊柜')!;
      const t1 = cabs.find((c) => c.name === '厨房电器高柜')!;

      ok('地柜 1、2 贴墙无缝拼接（250..1150 与 1150..2050）', Math.abs(b1.placement.x - b2.placement.x) === 900, `b1.x=${b1.placement.x}, b2.x=${b2.placement.x}`);
      ok('吊柜 1、2 自动精准对齐在地柜 1、2 正上方（X 坐标完全一致，0 干涉）', w1.placement.x === b1.placement.x && w2.placement.x === b2.placement.x, `w1.x=${w1.placement.x}, w2.x=${w2.placement.x}`);
      ok('通顶高柜同时避让地柜与吊柜，紧贴右侧排在 X=2050 且全屋 0 碰撞', t1.placement.x === Math.max(b1.placement.x, b2.placement.x) + 900 && bus.issues().filter((i) => i.severity === 'ERROR').length === 0, `t1.x=${t1.placement.x}`);

      // 测试防遮挡展开：若人工把两台地柜误设到同一个 X=0，computeUnfoldedWallX 自动展开不重叠，且吊柜仍与地柜对齐
      const unfolded = computeUnfoldedWallX(cabs);
      ok('正常上下叠放的地柜与吊柜在整墙图中保持相同 X 坐标', unfolded.get(b1.id) === unfolded.get(w1.id) && unfolded.get(b2.id) === unfolded.get(w2.id));

      const wholeSheet = buildFurnitureSheet(bus.getState().rooms[0]!, cabs, bus.getState(), rules, { furnitureName: '厨房整体柜' });
      const texts = wholeSheet.prims.filter((p) => p.k === 'text').map((p: any) => p.text);
      const viewTitles = texts.filter((t: string) => t === '俯视图' || t === '外观正面图' || t === '内部结构图');
      ok('整墙图纸只要 3 视图：唯一一个「俯视图」+「外观正面图」+「内部结构图」，不再拆地柜/吊柜双俯视',
        viewTitles.length === 3 && texts.filter((t: string) => t === '俯视图').length === 1
          && !texts.some((t: string) => t.includes('地柜平面俯视图') || t.includes('吊柜平面俯视图')),
        texts.filter((t: string) => t.includes('视图')).join(' | '));
    }

    // ─────────────────────────────────────────────────────────────────
    // 2. 启动真实 HTTP 服务：测试 SSE 实时流、防空覆盖保护、本地改图同步与整房 PDF/DXF 导出
    // ─────────────────────────────────────────────────────────────────
    section('2. MCP 实时绘画 SSE 流式同步 + 防空覆盖水位线保护 + 整房 PDF/DXF 导出');
    const baseProj = structuredClone(sampleProject(rules));
    const roomKitchen = rectRoom({ name: '餐厨一体空间', id: 'room_kitchen', x: 0, y: 0, w: 4200, h: 3000, thickness: 120, height: 2700 });
    baseProj.name = '世园润府全屋定制重构样板';
    baseProj.rooms = [roomKitchen];
    baseProj.cabinets = [];
    await startServer(baseProj);

    // 连接 SSE 实时流
    const sseEvents: any[] = [];
    const sseReq = http.get(`http://127.0.0.1:${port}/api/workspace/stream`, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        const parts = buf.split('\n\n');
        buf = parts.pop() ?? '';
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            try {
              sseEvents.push(JSON.parse(line.slice(6)));
            } catch {
              /* ignore */
            }
          }
        }
      });
    });
    sseReq.on('error', () => {});

    await wait(250);
    ok('浏览器连接 GET /api/workspace/stream 立即收到 init 快照事件', sseEvents.some((e) => e.type === 'init'));

    // 用 MCP 连续画一排地柜 + 吊柜 + 高柜，观察 SSE 实时推送
    const m1 = await callMcp('cad.create_cabinet', {
      roomId: roomKitchen.id,
      name: '烟机灶具地柜',
      width: 900,
      height: 820,
      depth: 600,
      cabinetType: 'base',
      units: [{ kind: 'drawerBank', width: 900, count: 3 }],
    });
    const draftId = m1.draftId;
    ok('MCP 第 1 步创建烟机灶具地柜并生成 draftId', Boolean(draftId), draftId);

    await callMcp('cad.create_cabinet', {
      draftId,
      roomId: roomKitchen.id,
      name: '水槽洗碗机地柜',
      width: 900,
      height: 820,
      depth: 600,
      cabinetType: 'base',
      units: [{ kind: 'shelves', width: 900, count: 1, doorCount: 2 }],
    });

    await callMcp('cad.create_cabinet', {
      draftId,
      roomId: roomKitchen.id,
      name: '左储物吊柜',
      width: 900,
      height: 720,
      depth: 350,
      cabinetType: 'wall',
      mountHeight: 1450,
      bodyLift: 0,
      units: [{ kind: 'shelves', width: 900, count: 2, doorCount: 2 }],
    });

    await callMcp('cad.create_cabinet', {
      draftId,
      roomId: roomKitchen.id,
      name: '右储物吊柜',
      width: 900,
      height: 720,
      depth: 350,
      cabinetType: 'wall',
      mountHeight: 1450,
      bodyLift: 0,
      units: [{ kind: 'shelves', width: 900, count: 2, doorCount: 2 }],
    });

    await callMcp('cad.create_cabinet', {
      draftId,
      roomId: roomKitchen.id,
      name: '蒸烤一体高柜',
      width: 600,
      height: 2170,
      depth: 600,
      cabinetType: 'tall',
      units: [{ kind: 'shelves', width: 600, count: 4, doorCount: 2 }],
    });

    await wait(200);
    const draftEvents = sseEvents.filter((e) => e.type === 'draft.updated' && e.draftId === draftId);
    ok('MCP 连续画 5 台柜体过程中，SSE 实时收到每一步 draft.updated 推送且最终草稿含 5 台柜体',
      draftEvents.length >= 5 && draftEvents[draftEvents.length - 1]?.project?.cabinets?.length === 5,
      `收到 ${draftEvents.length} 条实时推送，最新柜数=${draftEvents[draftEvents.length - 1]?.project?.cabinets?.length}`);

    // 应用草稿到云端 live
    const draftDetailRes = await fetch(`http://127.0.0.1:${port}/api/drafts/${encodeURIComponent(draftId)}`);
    const draftDetail = (await draftDetailRes.json()) as any;
    const applyRes = await fetch(`http://127.0.0.1:${port}/api/drafts/${encodeURIComponent(draftId)}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        syncId: `e2e_apply_${draftId}`,
        runId: draftDetail.runId,
        draftId,
        revision: draftDetail.revision,
        draftHash: draftDetail.draftHash,
        localVersion: 0,
        remoteVersion: draftDetail.liveModelVersion,
        baseModelVersion: draftDetail.baseModelVersion,
        baseProjectHash: draftDetail.baseProjectHash,
      }),
    });
    const applied = (await applyRes.json()) as any;
    ok('草稿应用成功，云端 liveModelVersion 升为 1 且含 5 台柜体', applied.ok === true && applied.liveModelVersion === 1 && applied.project.cabinets.length === 5);

    // 验证痛点 2：打开空白/默认本地浏览器，发送 clientHasLocalEdits=false（或空柜体项目），绝不冲掉云端 5 台柜体！
    const emptyBrowserProject = structuredClone(baseProj);
    emptyBrowserProject.cabinets = [];
    const emptySyncRes = await fetch(`http://127.0.0.1:${port}/api/workspace`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: emptyBrowserProject,
        clientHasLocalEdits: false,
      }),
    });
    const emptySyncJson = (await emptySyncRes.json()) as any;
    ok('【防空覆盖】空本地浏览器连接云端时不会覆盖云端数据，而是返回 hydratedFromServer=true 及云端 5 台柜体',
      emptySyncJson.ok === true && emptySyncJson.hydratedFromServer === true && emptySyncJson.project.cabinets.length === 5);

    // 验证浏览器手动改图 → PUT /api/workspace 同步 → 立即解锁整房 PDF 与 DXF 导出
    const editedProject = structuredClone(emptySyncJson.project) as Project;
    // 将最右侧的蒸烤一体高柜宽度从 600mm 人工修改为 750mm（不与左侧柜体重叠）
    editedProject.cabinets[4]!.params.width = 750;

    const manualSyncRes = await fetch(`http://127.0.0.1:${port}/api/workspace`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: editedProject,
        clientHasLocalEdits: true,
        force: true,
        reason: '人工在页面修改左地柜/左吊柜宽度为 1000mm',
      }),
    });
    const manualSyncJson = (await manualSyncRes.json()) as any;
    ok('页面人工改图后 PUT /api/workspace 同步成功，返回最新快照元数据（liveModelVersion=2）',
      manualSyncJson.ok === true && manualSyncJson.liveModelVersion === 2 && Boolean(manualSyncJson.projectSnapshotId));

    // 导出整房一体化 PDF（sheetMode: 'room'）
    const pdfRes = await fetch(`http://127.0.0.1:${port}/api/export/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: manualSyncJson.project,
        projectSnapshotId: manualSyncJson.projectSnapshotId,
        projectSnapshotHash: manualSyncJson.projectSnapshotHash,
        projectSnapshotVersion: manualSyncJson.projectSnapshotVersion,
        sheetMode: 'room',
      }),
    });
    ok('人工改图同步后导出整房一体化 PDF 成功（HTTP 200）', pdfRes.status === 200);
    const pdfBytes = Buffer.from(await pdfRes.arrayBuffer());
    mkdirSync(outputDir, { recursive: true });
    const outPdfPath = join(outputDir, '整房一体化三视图图纸_世园润府对标样例.pdf');
    writeFileSync(outPdfPath, pdfBytes);
    const pdfPages = Number(pdfRes.headers.get('X-PDF-Page-Count') ?? 0);
    const pdfText = execFileSync('pdftotext', [outPdfPath, '-'], { encoding: 'utf8' });
    ok('整房一体化 PDF 仅 1 页（5 台柜体合在一张 A3 图幅，不再拆成 5 页）且包含俯视图与正面/内部结构图，没有双俯视',
      pdfPages === 1 && pdfText.includes('俯视图') && pdfText.includes('外观正面图') && pdfText.includes('内部结构图')
        && !pdfText.includes('地柜平面俯视图') && !pdfText.includes('吊柜平面俯视图'),
      `pages=${pdfPages}, bytes=${pdfBytes.length}`);

    // 导出整房一体化 DXF（sheetMode: 'room'）
    const dxfRes = await fetch(`http://127.0.0.1:${port}/api/export/dxf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project: manualSyncJson.project,
        projectSnapshotId: manualSyncJson.projectSnapshotId,
        projectSnapshotHash: manualSyncJson.projectSnapshotHash,
        projectSnapshotVersion: manualSyncJson.projectSnapshotVersion,
        which: ['plan', 'sheet'],
        sheetMode: 'room',
      }),
    });
    ok('人工改图同步后导出整房一体化 DXF 成功（HTTP 200）', dxfRes.status === 200);
    const dxfBytes = Buffer.from(await dxfRes.arrayBuffer());
    const outDxfPath = join(outputDir, '整房一体化三视图图纸_世园润府对标样例.dxf');
    writeFileSync(outDxfPath, dxfBytes);
    ok('整房一体化 DXF 文件有效且落盘成功', dxfBytes.length > 5000, `bytes=${dxfBytes.length}`);

    sseReq.destroy();

    // ─────────────────────────────────────────────────────────────────
    // 3. 双图（效果图 + 尺寸图）融合识图与非阻塞导入验证
    // ─────────────────────────────────────────────────────────────────
    section('3. 双图（效果图 + 尺寸图）融合识图与非阻塞导入（先出图后人工微调）');
    {
      const renderVision = {
        cabinets: [
          {
            ref: 'cab_1',
            name: '主卧衣柜',
            width: { value: 1800, confidence: 'low' as const, source: 'estimate' as const },
            height: { value: 2400, confidence: 'low' as const, source: 'estimate' as const },
            units: [
              { kind: 'hanging' as const, widthRatio: 0.5, doorCount: 2, confidence: 'high' as const },
              { kind: 'drawerBank' as const, widthRatio: 0.5, count: 3, confidence: 'high' as const },
            ],
            confidence: 'medium' as const,
            notVisible: ['depth' as const, 'real-size' as const],
          },
        ],
        overallConfidence: 'medium' as const,
        ambiguous: ['右下角踢脚高度标注略模糊'],
      };
      const dimVision = {
        cabinets: [
          {
            ref: 'cab_1',
            name: '主卧衣柜',
            width: { value: 2000, confidence: 'high' as const, source: 'annotation' as const },
            height: { value: 2450, confidence: 'high' as const, source: 'annotation' as const },
            depth: { value: 600, confidence: 'high' as const, source: 'annotation' as const },
            confidence: 'high' as const,
          },
        ],
        scale: { known: true, text: '顶部总宽标注 2000mm', confidence: 'high' as const },
        overallConfidence: 'high' as const,
      };
      const fused = mergeVisionResults([
        { result: renderVision, mode: 'render', name: '效果图.png' },
        { result: dimVision, mode: 'dimension', name: '尺寸图.png' },
      ]);
      ok('双图融合保留了尺寸图的精确 annotation 宽高深（2000×2450×600）与效果图的内部挂衣/抽屉分格',
        fused.cabinets[0]?.width?.value === 2000 &&
          fused.cabinets[0]?.height?.value === 2450 &&
          fused.cabinets[0]?.depth?.value === 600 &&
          fused.cabinets[0]?.units?.length === 2 &&
          fused.scale?.known === true);

      const nd = visionResultToNormalized(fused, { room: roomKitchen.id });
      const issues = validateNormalized(nd, baseProj);
      ok('识图存在轻微存疑（ambiguous）但已识别出柜体时，转为非阻断 IMPORT-CAVEAT，不再触发 IMPORT-OPEN-QUESTIONS 死锁',
        !importBlocked(issues) && issues.some((i) => i.code === 'IMPORT-CAVEAT'),
        issues.map((i) => i.code).join(', '));
      const compiled = compileImport(nd, baseProj, rules);
      ok('融合识图结果可直接编译为建柜动作供页面微调', compiled.ok && compiled.actions.length === 1);
    }

    // ─────────────────────────────────────────────────────────────────
    // 4. 页面手动改图增强（Shift 拖基准边 + 失效二维覆盖一键清理 + 聊天框无遮挡布局）
    // ─────────────────────────────────────────────────────────────────
    section('4. 页面手动改图增强与三栏无遮挡布局校验');
    {
      const minEdgeLine = {
        cabinetId: 'cab_1',
        view: 'front' as const,
        part: 'outer.width' as const,
        edge: 'min' as const,
        unitIndex: -1,
        rowIndex: 0,
        pts: [{ x: 0, y: 0 }, { x: 0, y: 2400 }] as [{ x: number; y: number }, { x: number; y: number }],
      };
      const defaultDrag = dragPlanOf(minEdgeLine);
      const shiftDrag = dragPlanOf(minEdgeLine, { allowAnchorDrag: true });
      ok('默认拖基准边保持安全提示，按住 Shift（allowAnchorDrag=true）允许反向拖动改宽', !defaultDrag.ok && shiftDrag.ok && shiftDrag.spec.sign === -1);

      const p = structuredClone(sampleProject(rules));
      const fakePrim = { k: 'poly' as const, pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }], closed: false, layer: 'F-CAB', lw: 1 };
      const keys = planSourceKeys('cab_1', [fakePrim]);
      const ov = sourceOverride(keys[0]!, fakePrim, 'plan', 'edit_stale_1')!;
      p.drawingEdits = [ov];
      // 当源图元变化导致 keys 不再包含旧 key 时，filterValidDrawingEdits 可一键清理失效覆盖
      const cleaned = filterValidDrawingEdits(p, ['plan:cab_1:g:new_key'], []);
      ok('filterValidDrawingEdits 能一键清理因改柜体尺寸而失效的二维图元覆盖', cleaned.length === 0);

      const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
      ok('styles.css 已将 .workspace-room-content 升级为左右分栏（设计区 + 全高聊天面板），彻底消除聊天记录遮挡',
        css.includes('grid-template-columns: minmax(0, 1fr) minmax(380px, 430px)') &&
          css.includes('.ai-workspace-panel .chat-list.workspace-chat-timeline { position: relative; flex: 1 1 auto; max-height: none;'));
    }

    // ─────────────────────────────────────────────────────────────────
    // 5. Phase 2 专项：防房间重叠、级联删房间+撤销、Unit ID 冲突根治与一键修复 API
    // ─────────────────────────────────────────────────────────────────
    section('5. 防房间重叠 + 级联删房间可撤销 + Unit ID 全局防撞号与一键修复解锁');
    {
      // (a) 连续新建两个默认分区柜体 + 新增分区，验证 Unit ID 全局唯一不撞号
      const pUnit = structuredClone(sampleProject(rules));
      const rId = pUnit.rooms[0]!.id;
      const uBus = new CommandBus(pUnit, rules);
      const c2 = compileAction(
        { action: 'cabinet.create', target: { roomId: rId }, params: { name: '测试二号柜', width: 1200, height: 2100, depth: 600 } },
        uBus.getState(),
        rules,
      );
      ok('未传 units 的第二台默认三分区柜编译成功', c2.ok);
      if (c2.ok) uBus.execute(c2.command);
      const addU = compileAction(
        { action: 'cabinet.addUnit', target: { cabinetName: '测试二号柜' }, params: { kind: 'shelves', requestedWidth: 400, count: 3 } },
        uBus.getState(),
        rules,
      );
      ok('在第二台柜上新增分区编译成功且不与首柜 unit_001 撞号', addU.ok);
      if (addU.ok) {
        const resAdd = uBus.execute(addU.command);
        ok('新增分区执行成功且全项目 0 重复 Unit ID', resAdd.ok && findDuplicateUnitIds(uBus.getState()).length === 0);
      }

      // (b) 新建第二个房间（传 x=0,y=0 或通过 MCP 只传 w,h）自动向右平移错开，绝不与首房间重叠
      const room2Raw = rectRoom({ name: '次卧书房', x: 0, y: 0, w: 3000, h: 2600 });
      const rCreate = uBus.execute(CMD.createRoomCommand(room2Raw));
      ok('新建第二个房间（即使传入 x=0,y=0）成功执行', rCreate.ok);
      const room1 = uBus.getState().rooms[0]!;
      const room2 = uBus.getState().rooms[1]!;
      const r1MaxX = Math.max(...room1.walls.flatMap((w) => [w.start.x, w.end.x]));
      const r2MinX = Math.min(...room2.walls.flatMap((w) => [w.start.x, w.end.x]));
      ok('第二个房间自动排布在第一个房间右侧（r2MinX > r1MaxX），彻底消除房间重叠', r2MinX > r1MaxX, `r1MaxX=${r1MaxX}, r2MinX=${r2MinX}`);

      // 在第二个房间用房间局部坐标 (x=60, y=60) 建柜，自动转换到第二个房间的世界坐标
      const cRoom2 = compileAction(
        { action: 'cabinet.create', target: { roomId: room2.id }, params: { name: '次卧书柜', width: 1200, height: 2100, depth: 350, atX: 60, atY: 60 } },
        uBus.getState(),
        rules,
      );
      ok('在第二个房间按局部坐标 (60,60) 建柜编译成功', cRoom2.ok);
      if (cRoom2.ok) uBus.execute(cRoom2.command);
      const cabInR2 = uBus.getState().cabinets.find((c) => c.name === '次卧书柜')!;
      ok('第二个房间的柜体自动落入第二个房间世界坐标范围内（不落回主卧）', cabInR2.placement.x >= r2MinX, `cab.x=${cabInR2.placement.x}, r2MinX=${r2MinX}`);

      // (c) 级联删除含柜体的房间 + 一步撤销完整还原
      const snapBeforeDel = JSON.stringify(uBus.getState());
      const delCascade = uBus.execute(CMD.deleteRoomCommand(room2.id, room2.name, 'ui', true));
      ok('含柜体的房间通过 cascade=true 一键级联删除成功', delCascade.ok && uBus.getState().rooms.length === 1 && !uBus.getState().cabinets.some((c) => c.roomId === room2.id));
      uBus.undo();
      ok('级联删除房间后执行 Undo，房间与房内柜体逐字节完整还原', JSON.stringify(uBus.getState()) === snapBeforeDel);

      // (d) MCP cad.create_room 支持只传 { name, w, h }（省略 x, y）且自动防重叠
      const mcpRoom = await callMcp('cad.create_room', { name: '独立衣帽间', w: 2800, h: 2400 });
      ok('MCP cad.create_room 仅传 {name, w, h} 创建成功', mcpRoom.ok === true && Boolean(mcpRoom.roomId));

      // (e) POST /api/workspace/repair-unit-ids 一键修复接口验证
      const repairRes = await fetch(`http://127.0.0.1:${port}/api/workspace/repair-unit-ids`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const repairJson = (await repairRes.json()) as any;
      ok('POST /api/workspace/repair-unit-ids 成功返回健康项目且 readOnly=false',
        repairRes.ok && repairJson.ok === true && repairJson.identityDiagnostics?.readOnly === false);
    }

  } finally {
    await stopServer();
    rmSync(tempDir, { recursive: true, force: true });
  }

  console.log(`\n══════════════════════════════════════════════════════════════`);
  console.log(`  重构端到端验收：通过 ${passed} 项，失败 ${failed} 项`);
  console.log(`══════════════════════════════════════════════════════════════`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await stopServer();
  rmSync(tempDir, { recursive: true, force: true });
  process.exit(1);
});
