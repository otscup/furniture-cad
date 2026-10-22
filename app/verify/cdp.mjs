#!/usr/bin/env node
/**
 * CDP 小客户端（2026-10-22）
 *
 * ── 为什么要抽出来 ──
 *   两个 UI 验收脚本各写了一份 connectCdp（30 行），
 *   现在还要用它**渲染 + 裁剪**图片（做三段式视觉识别的第一步）——
 *   再抄第三遍就是灾难。
 *
 * ── 它能干什么 ──
 *   · 打开任意页面（本地 HTML/SVG 也行）
 *   · 执行 JS（Runtime.evaluate）
 *   · 截图（Page.captureScreenshot）
 *   · 切窗口尺寸（Emulation.setDeviceMetricsOverride）⇒ **这就是「裁剪」**
 *
 * 零依赖：Node 内置 WebSocket（Node 22+）+ child_process。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

/**
 * 找 Chrome/Chromium。
 * @returns {string|null}
 */
export function findChrome() {
  for (const c of CHROME_CANDIDATES) {
    if (c.includes('/') && !c.includes(':\\')) {
      try { if (existsSync(c)) return c; } catch { /* 忽略 */ }
      continue;
    }
    try { if (existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  return null;
}
/**
 * 连上 Chrome 的 DevTools 协议。
 * @param {string} wsUrl page target 的 webSocketDebuggerUrl
 * @returns {{ws: WebSocket, ready: Promise<void>, send: Function, close: Function}}
 */
export function connectCdp(wsUrl) {
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
        // ★ 必须有超时 —— CDP 偶尔不回的（页面卡住、渲染崩了），
        //   没有超时就是**永久挂起**，整个脚本卡死（实测踩过）。
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('CDP 调用超时：' + method));
        }, 30000);
        pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          reject(e);
        }
      });
    },
    close() { try { ws.close(); } catch { /* 浏览器已关闭 */ } },
  };
}

/**
 * 起一个 headless Chrome，并连上它的第一个页面。
 *
 * @param {number} cdpPort 调试端口（用随机高位端口避免撞车）
 * @returns {Promise<{cdp: object, kill: Function}>}
 */
export async function launchChrome(cdpPort) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error('找不到 Chrome/Chromium（可用 CHROME_PATH 指定）');
  const profile = mkdtempSync(join(tmpdir(), 'furnicad-cdp-'));
  const proc = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--disable-extensions', '--disable-background-networking', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  // ★ 必须杀**整棵进程树** —— 只 kill 主进程的话，
  //   Chrome 的一堆子进程会留下来（实测残留 8 个），
  //   下次跑就撞端口 / 吃内存。
  //   做法：Windows 用 taskkill /T /F，POSIX 用进程组（detached + kill(-pid)）。
  const kill = () => {
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { /* 组不存在 */ }
        try { proc.kill('SIGKILL'); } catch { /* 已退出 */ }
      }
    } catch { /* 已退出 */ }
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
  };
  // 等它起来
  let page = null;
  for (let attempt = 0; attempt < 100 && !page; attempt += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = await res.json();
      page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null;
    } catch {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!page) await new Promise((r) => setTimeout(r, 120));
  }
  if (!page) { kill(); throw new Error('Chrome 没起来（没拿到 page target）'); }
  const cdp = connectCdp(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { cdp, kill };
}
/**
 * 把一个 URL 截成 PNG（可指定视口尺寸 ⇒ 就是「裁剪」）。
 *
 * ★ 为什么用视口尺寸做裁剪，而不是先截大图再切 ──
 *   PNG 的解码/编码要自己写（项目零依赖）；
 *   而浏览器**天生就会按视口渲染** —— 改视口就是重新渲染，
 *   矢量图（我们的图纸就是 SVG）会**按新视口重新排版**，
 *   不是拉伸变形。
 *
 * @param {object} cdp CDP 客户端
 * @param {string} url 要打开的地址（file:// 或 http://）
 * @param {object} opts
 * @param {number} opts.width 视口宽
 * @param {number} opts.height 视口高
 * @param {number} [opts.deviceScaleFactor] 缩放（默认 1）
 * @param {number} [opts.timeoutMs] 导航超时
 * @returns {Promise<Buffer>} PNG 字节
 */
export async function screenshot(cdp, url, opts) {
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: opts.deviceScaleFactor ?? 1, mobile: false,
  });
  await cdp.send('Page.navigate', { url });
  // 等 load 事件
  await new Promise((resolve) => {
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data));
      if (m.method === 'Page.loadEventFired') {
        cdp.ws.removeEventListener('message', onMsg);
        resolve();
      }
    };
    cdp.ws.addEventListener('message', onMsg);
    setTimeout(resolve, opts.timeoutMs ?? 15000);
  });
  // SVG 要给它一点时间完成布局
  await new Promise((r) => setTimeout(r, 350));
  const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  return Buffer.from(res.data, 'base64');
}

/**
 * 在页面里跑一段 JS，取回可序列化结果。
 * @param {object} cdp
 * @param {string} expression
 * @returns {Promise<any>}
 */
export async function evaluate(cdp, expression) {
  const response = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  });
  if (response.exceptionDetails) {
    throw new Error('浏览器脚本异常：' + JSON.stringify(response.exceptionDetails).slice(0, 300));
  }
  return response.result?.value;
}

/**
 * 打开一个 URL 并**等 load 事件**（固定 sleep 不可靠 —— 第一个页面最慢）。
 *
 * @param {object} cdp
 * @param {string} url
 * @param {number} [timeoutMs]
 */
export async function navigate(cdp, url, timeoutMs = 20000) {
  const loaded = new Promise((resolve) => {
    const onMsg = (event) => {
      const m = JSON.parse(String(event.data));
      if (m.method === 'Page.loadEventFired') {
        cdp.ws.removeEventListener('message', onMsg);
        resolve(true);
      }
    };
    cdp.ws.addEventListener('message', onMsg);
    setTimeout(() => resolve(false), timeoutMs);
  });
  await cdp.send('Page.navigate', { url });
  const ok = await loaded;
  // SVG 还要一点时间排版
  await new Promise((r) => setTimeout(r, 250));
  return ok;
}
