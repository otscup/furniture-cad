#!/usr/bin/env node
/**
 * 独立真实浏览器验收：真实房间加柜仍能工作；未分配房间隐藏加柜入口、显示归属提示，
 * 并且不会把悬空柜体静默写入首房间。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const usedPorts = new Set();

async function nextFreePort() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (port > 0 && !usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  }
  throw new Error('无法分配独立验收端口');
}

const [appPort, cdpPort, apiPort, mockPort] = await Promise.all([
  nextFreePort(), nextFreePort(), nextFreePort(), nextFreePort(),
]);
const env = {
  ...process.env,
  ONLY: 'B46_ROOM_UNASSIGNED',
  STOP_AFTER_ONLY: '1',
  APP_PORT: String(appPort),
  CDP_PORT: String(cdpPort),
  API_PORT: String(apiPort),
  MOCK_PORT: String(mockPort),
};

console.log('运行真实浏览器验收：真实房间创建柜体 + 未分配房间入口/归属保护');
console.log(`隔离端口：app=${appPort}, CDP=${cdpPort}, api=${apiPort}, mock=${mockPort}`);

const runner = spawn(process.execPath, [path.join(root, 'verify', 'run-ui-verify.mjs')], {
  cwd: root,
  env,
  stdio: 'inherit',
});
const result = await new Promise((resolve) => {
  runner.once('error', (error) => resolve({ code: 1, error }));
  runner.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
});
if (result.error) {
  console.error(`独立 UI runner 启动失败：${result.error.message}`);
  process.exitCode = 1;
} else if (result.signal) {
  console.error(`独立 UI runner 被信号终止：${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.code;
}
