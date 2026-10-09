import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyProject, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import { serializeProjectFile } from '../src/core/projectFile.ts';
import { indexProjectRooms } from '../src/core/roomIndex.ts';
import type { Project, RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const temp = mkdtempSync(join(tmpdir(), 'furniture-agent-room-'));
const children: ChildProcess[] = [];
let mockServer: Server | null = null;
let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return reject(new Error('无法分配测试端口'));
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForApp(port: number, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('家具 CAD 服务提前退出');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) return;
    } catch { /* 等待服务就绪 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('家具 CAD 服务未在 15 秒内启动');
}

async function main(): Promise<void> {
  let completionCalls = 0;
  let firstSystemPrompt = '';
  mockServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages?: Array<{ role: string; content?: string }>;
      };
      const toolResults = (request.messages ?? []).filter((message) => message.role === 'tool' && message.content).map((message) => {
        try { return JSON.parse(message.content!) as { draftId?: string; cabinetId?: string }; } catch { return {}; }
      });
      completionCalls++;
      if (completionCalls === 1) {
        firstSystemPrompt = request.messages?.find((message) => message.role === 'system')?.content ?? '';
      }
      const message = completionCalls === 1
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'agent-room-create-1',
              type: 'function',
              function: {
                name: 'cad.create_cabinet',
                // 模拟模型省略房间字段；Agent 必须使用前端传入的当前房间。
                arguments: JSON.stringify({ name: '书房上下文验收柜', width: 900, height: 2100, depth: 550 }),
              },
            }],
          }
        : completionCalls === 2
          ? {
              role: 'assistant', content: null,
              tool_calls: [{
                id: 'agent-room-create-2', type: 'function',
                function: { name: 'cad.create_cabinet', arguments: JSON.stringify({ name: '书房相邻验收柜', width: 900, height: 2100, depth: 550, x: 1000 }) },
              }],
            }
          : completionCalls === 3
            ? {
                role: 'assistant', content: null,
                tool_calls: [{
                  id: 'agent-room-assembly-1', type: 'function',
                  function: {
                    name: 'cad.create_assembly',
                    arguments: JSON.stringify({
                      name: '书房地柜组合',
                      memberIds: toolResults.map((result) => result.cabinetId).filter(Boolean),
                      connections: [{ kind: 'butt', a: { cabinetId: toolResults[0]?.cabinetId }, b: { cabinetId: toolResults[1]?.cabinetId } }],
                    }),
                  },
                }],
              }
            : { role: 'assistant', content: '已在当前房间创建柜体并组成同一柜组。' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
    });
  });
  const aiPort = await freePort();
  await new Promise<void>((resolve, reject) => {
    mockServer!.once('error', reject);
    mockServer!.listen(aiPort, '127.0.0.1', resolve);
  });

  const project: Project = emptyProject({ ruleSetId: 'factory_default_v1' });
  project.name = '双房间 Agent 房间上下文验收';
  const roomIds = new Set<string>();
  const addRoom = (room: ReturnType<typeof rectRoom>): void => {
    project.rooms.push(room);
    roomIds.add(room.id);
    room.walls.forEach((wall) => roomIds.add(wall.id));
  };
  addRoom(rectRoom({ name: '客厅', x: 0, y: 0, w: 5000, h: 4000, id: 'room_first', takenIds: roomIds }));
  addRoom(rectRoom({ name: '书房', x: 7000, y: 0, w: 4000, h: 3500, id: 'room_second', takenIds: roomIds }));
  const rules = JSON.parse(readFileSync(join(root, 'src/core/ruleset/factory-default.json'), 'utf8')) as RuleSet;
  const orphanCabinet = structuredClone(sampleProject(rules).cabinets[0]!);
  orphanCabinet.id = 'cab_orphan';
  orphanCabinet.name = '悬空归属柜';
  orphanCabinet.roomId = 'room_missing';
  const danglingProject = structuredClone(project);
  danglingProject.cabinets.push(orphanCabinet);
  const unassignedGroup = indexProjectRooms(danglingProject).find((group) => group.unassigned);
  ok('双真实房间中的悬空 roomId 被索引到未分配组', project.rooms.length === 2 && unassignedGroup?.room.id === '__unassigned__'
    && unassignedGroup.cabinets.some((cabinet) => cabinet.id === 'cab_orphan'), JSON.stringify(unassignedGroup));
  const workspacePath = join(temp, 'workspaces', 'local-open', 'workspace.json');
  mkdirSync(dirname(workspacePath), { recursive: true });
  const envelope = JSON.parse(serializeProjectFile(project)) as Record<string, unknown>;
  writeFileSync(workspacePath, JSON.stringify({
    ...envelope,
    workspaceId: 'ws_agent_room_context',
    owner: 'local-open',
    account: 'local-open',
    liveModelVersion: 0,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  const appPort = await freePort();
  const envPath = join(temp, 'agent.env');
  writeFileSync(envPath, [
    `AI_BASE_URL=http://127.0.0.1:${aiPort}/v1`,
    'AI_API_KEY=agent-room-context-test-key',
    'AI_MODEL=mock-agent-model',
    'AI_TIMEOUT_MS=10000',
    '',
  ].join('\n'), 'utf8');
  const child = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(appPort),
      APP_HOST: '127.0.0.1',
      APP_ENV_PATH: envPath,
      APP_WORKSPACE_PATH: workspacePath,
      APP_ACCOUNTS_PATH: join(temp, 'accounts.json'),
      APP_AUDIT_PATH: join(temp, 'audit.jsonl'),
      APP_MEM_PATH: join(temp, 'memory.jsonl'),
      AI_BASE_URL: `http://127.0.0.1:${aiPort}/v1`,
      AI_API_KEY: 'agent-room-context-test-key',
      AI_MODEL: 'mock-agent-model',
    },
    stdio: 'ignore',
  });
  children.push(child);
  await waitForApp(appPort, child);

  const response = await fetch(`http://127.0.0.1:${appPort}/api/ai/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: '在当前房间新建一个衣柜',
      roomId: 'room_second',
      roomName: '书房',
    }),
  });
  const result = await response.json() as {
    ok?: boolean;
    error?: string;
    steps?: Array<{ tool: string; args?: Record<string, unknown>; result?: { draftId?: string } }>;
  };
  ok('Agent API 请求成功', response.status === 200 && result.ok === true, `${response.status} ${result.error ?? ''}`);
  ok('Agent 系统提示包含当前房间身份', firstSystemPrompt.includes('roomId=room_second') && firstSystemPrompt.includes('书房'));

  const createStep = result.steps?.find((step) => step.tool === 'cad.create_cabinet');
  const assemblyStep = result.steps?.find((step) => step.tool === 'cad.create_assembly');
  ok('模型省略房间参数时，Agent 为 MCP 工具补入第二个房间 ID', createStep?.args?.roomId === 'room_second', JSON.stringify(createStep?.args));
  ok('MCP 新建柜体调用成功并创建草稿', Boolean(createStep?.result?.draftId), JSON.stringify(createStep?.result));
  ok('Agent 可创建柜体组合，且组合仍追加到同一份草稿', assemblyStep?.result?.draftId === createStep?.result?.draftId && assemblyStep?.args?.draftId === createStep?.result?.draftId,
    JSON.stringify({ args: assemblyStep?.args, result: assemblyStep?.result, draftId: createStep?.result?.draftId }));

  const draftId = createStep?.result?.draftId;
  const previewResponse = draftId ? await fetch(`http://127.0.0.1:${appPort}/api/drafts/${encodeURIComponent(draftId)}`) : null;
  const previewSnapshot = previewResponse ? await previewResponse.json() as { ok?: boolean; project?: Project; liveModelVersion?: number } : null;
  ok('只读草稿快照可读取新增柜体，且尚未写入服务器 live', previewResponse?.status === 200 && previewSnapshot?.ok === true && previewSnapshot.project?.cabinets.some((cabinet) => cabinet.name === '书房上下文验收柜') === true && previewSnapshot.liveModelVersion === 0,
    `status=${previewResponse?.status}; live=${previewSnapshot?.liveModelVersion}; cabinets=${previewSnapshot?.project?.cabinets.length}`);
  const safeDraftId = draftId?.replace(/[^a-zA-Z0-9_-]/g, '_');
  const draftPath = safeDraftId ? join(dirname(workspacePath), 'drafts', `${safeDraftId}.json`) : '';
  const draft = draftPath && existsSync(draftPath)
    ? JSON.parse(readFileSync(draftPath, 'utf8')) as { project?: Project }
    : null;
  const created = draft?.project?.cabinets.find((cabinet) => cabinet.name === '书房上下文验收柜');
  ok('双房间真实 MCP 草稿中的柜体归属书房，而非首个客厅', created?.roomId === 'room_second',
    `roomId=${created?.roomId ?? 'missing'}; draft=${draftPath || 'none'}; exists=${Boolean(draft)}; cabinetNames=${draft?.project?.cabinets.map((cabinet) => cabinet.name).join(',') ?? 'none'}`);
  const assembly = draft?.project?.assemblies?.find((item) => item.name === '书房地柜组合');
  ok('生成的两个独立柜箱以显式 butt 关系进入一个柜组', assembly?.roomId === 'room_second' && assembly.memberIds.length === 2 && assembly.connections.some((connection) => connection.kind === 'butt'), JSON.stringify(assembly));

  const draftsDir = join(dirname(workspacePath), 'drafts');
  const draftFilesBefore = existsSync(draftsDir) ? readdirSync(draftsDir).filter((name) => name.endsWith('.json')).sort() : [];
  const completionCallsBefore = completionCalls;
  const unassignedResponse = await fetch(`http://127.0.0.1:${appPort}/api/ai/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: '在这个未分配柜体旁再创建一个柜子',
      roomId: unassignedGroup?.room.id ?? '__unassigned__',
      roomName: unassignedGroup?.room.name ?? '未分配房间',
      roomContext: 'unassigned',
    }),
  });
  const unassignedResult = await unassignedResponse.json() as { code?: string; error?: string };
  const draftFilesAfter = existsSync(draftsDir) ? readdirSync(draftsDir).filter((name) => name.endsWith('.json')).sort() : [];
  ok('未分配上下文的 Agent 创建请求返回明确的真实房间提示', unassignedResponse.status === 409
    && unassignedResult.code === 'ROOM_CONTEXT_REQUIRED' && unassignedResult.error?.includes('真实房间'),
  `${unassignedResponse.status} ${unassignedResult.code ?? ''} ${unassignedResult.error ?? ''}`);
  ok('悬空 roomId 不触发模型调用，也不会产生错误房间草稿', completionCalls === completionCallsBefore
    && JSON.stringify(draftFilesAfter) === JSON.stringify(draftFilesBefore),
  `completion ${completionCallsBefore}→${completionCalls}; drafts ${draftFilesBefore.join(',')}→${draftFilesAfter.join(',')}`);

  const noRoomCompletionCalls = completionCalls;
  const noRoomResponse = await fetch(`http://127.0.0.1:${appPort}/api/ai/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: '新建一个柜子', roomId: '' }),
  });
  const noRoomResult = await noRoomResponse.json() as { code?: string; error?: string };
  const noRoomDraftFiles = existsSync(draftsDir) ? readdirSync(draftsDir).filter((name) => name.endsWith('.json')).sort() : [];
  ok('缺少房间上下文的 Agent 请求明确要求先选真实房间', noRoomResponse.status === 409
    && noRoomResult.code === 'ROOM_CONTEXT_REQUIRED' && noRoomResult.error?.includes('真实房间'),
  `${noRoomResponse.status} ${noRoomResult.code ?? ''} ${noRoomResult.error ?? ''}`);
  ok('缺少 roomId 不调用模型、不新增草稿', completionCalls === noRoomCompletionCalls
    && JSON.stringify(noRoomDraftFiles) === JSON.stringify(draftFilesBefore),
  `completion ${noRoomCompletionCalls}→${completionCalls}; drafts ${draftFilesBefore.join(',')}→${noRoomDraftFiles.join(',')}`);

  // browser semantic model 与服务端 MCP workspace 是两份状态：模拟 browser 的 room_second
  // 误传到只含 room_server_only 的 server。即使 server 只有一室，也必须在 AI/MCP 前拒绝。
  const mismatchRoot = join(temp, 'mismatch-server');
  const mismatchWorkspacePath = join(mismatchRoot, 'workspaces', 'local-open', 'workspace.json');
  mkdirSync(dirname(mismatchWorkspacePath), { recursive: true });
  const mismatchProject: Project = emptyProject({ ruleSetId: 'factory_default_v1' });
  mismatchProject.name = '只有一个服务端房间的错位验收';
  mismatchProject.rooms.push(rectRoom({
    name: '服务端唯一房间', x: 0, y: 0, w: 4200, h: 3200, id: 'room_server_only', takenIds: new Set<string>(),
  }));
  const mismatchEnvelope = JSON.parse(serializeProjectFile(mismatchProject)) as Record<string, unknown>;
  writeFileSync(mismatchWorkspacePath, JSON.stringify({
    ...mismatchEnvelope,
    workspaceId: 'ws_single_room_mismatch',
    owner: 'local-open',
    account: 'local-open',
    liveModelVersion: 0,
    updatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');

  const mismatchEnvPath = join(temp, 'agent-mismatch.env');
  writeFileSync(mismatchEnvPath, [
    `AI_BASE_URL=http://127.0.0.1:${aiPort}/v1`,
    'AI_API_KEY=agent-room-context-test-key',
    'AI_MODEL=mock-agent-model',
    'AI_TIMEOUT_MS=10000',
    '',
  ].join('\n'), 'utf8');
  const mismatchPort = await freePort();
  const mismatchChild = spawn(process.execPath, [join(root, 'server', 'server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(mismatchPort),
      APP_HOST: '127.0.0.1',
      APP_ENV_PATH: mismatchEnvPath,
      APP_WORKSPACE_PATH: mismatchWorkspacePath,
      APP_ACCOUNTS_PATH: join(mismatchRoot, 'accounts.json'),
      APP_AUDIT_PATH: join(mismatchRoot, 'audit.jsonl'),
      APP_MEM_PATH: join(mismatchRoot, 'memory.jsonl'),
      AI_BASE_URL: `http://127.0.0.1:${aiPort}/v1`,
      AI_API_KEY: 'agent-room-context-test-key',
      AI_MODEL: 'mock-agent-model',
    },
    stdio: 'ignore',
  });
  children.push(mismatchChild);
  await waitForApp(mismatchPort, mismatchChild);
  const mismatchDraftDir = join(dirname(mismatchWorkspacePath), 'drafts');
  const mismatchDraftsBefore = existsSync(mismatchDraftDir)
    ? readdirSync(mismatchDraftDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  const mismatchCompletionCalls = completionCalls;
  const mismatchResponse = await fetch(`http://127.0.0.1:${mismatchPort}/api/ai/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intent: '在浏览器选中的书房新建书柜', roomId: 'room_second', roomName: '书房' }),
  });
  const mismatchResult = await mismatchResponse.json() as { code?: string; error?: string };
  const mismatchDraftsAfter = existsSync(mismatchDraftDir)
    ? readdirSync(mismatchDraftDir).filter((name) => name.endsWith('.json')).sort()
    : [];
  ok('browser room_second 不属于仅有 room_server_only 的服务端工作区时返回明确错位提示', mismatchResponse.status === 409
    && mismatchResult.code === 'ROOM_CONTEXT_MISMATCH'
    && mismatchResult.error?.includes('不属于服务端工作区')
    && mismatchResult.error.includes('已拒绝'),
  `${mismatchResponse.status} ${mismatchResult.code ?? ''} ${mismatchResult.error ?? ''}`);
  ok('单房间错位在调用模型/MCP 前失败关闭且不创建草稿', completionCalls === mismatchCompletionCalls
    && JSON.stringify(mismatchDraftsAfter) === JSON.stringify(mismatchDraftsBefore),
  `completion ${mismatchCompletionCalls}→${completionCalls}; drafts ${mismatchDraftsBefore.join(',')}→${mismatchDraftsAfter.join(',')}`);

  console.log(`\nAgent 房间上下文回归：${passed} 通过，${failed} 失败。`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill();
  if (mockServer) await new Promise<void>((resolve) => mockServer!.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
}
