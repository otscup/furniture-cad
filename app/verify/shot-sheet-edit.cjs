'use strict';
/**
 * 四视图可编辑 —— 出图脚本（只做一件事：把"能拖/不能拖"拍下来给人看）。
 *
 * 为什么单独一个脚本：verify:ui 那套要跑 3 分钟、还会把工程改得面目全非。
 * 这里只起 vite + 无头 Chrome，进四视图，把鼠标悬到两条线上各拍一张：
 *   · 可拖线（柜宽末端边）→ 蓝实线 + 端点帽 + 读数"柜宽 2400mm · 左右拖 = 改柜宽"
 *   · 基准边（柜宽起算端）→ 红虚线 + 读数里带"基准边"的理由
 * 产物落在 verify/out/ 下（那里就是"人要看的东西"的地盘）。
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = Number(process.env.APP_PORT || 5299);
const CDP_PORT = Number(process.env.CDP_PORT || 6299);
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const OUT_DIR = path.join(__dirname, 'out');
const viteJs = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];
const PROFILE = path.join(os.tmpdir(), 'furniture-cad-cdp', `shot-${Date.now()}`);
fs.mkdirSync(PROFILE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch {
            reject(new Error('bad json'));
          }
        });
      })
      .on('error', reject);
  });
}

function ping(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
  });
}

async function main() {
  const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!chrome) throw new Error('找不到 Chrome');
  if (!fs.existsSync(viteJs)) throw new Error('找不到 vite，请先 npm install');

  const vite = spawn(process.execPath, [viteJs, '--port', String(APP_PORT), '--host', '127.0.0.1', '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chromeProc = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1600,1000',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  try {
    for (let i = 0; i < 60; i++) {
      if (await ping(APP_URL)) break;
      await sleep(500);
    }
    let version = null;
    for (let i = 0; i < 60; i++) {
      try {
        version = await getJson(CDP_PORT, '/json/version');
        break;
      } catch {
        await sleep(500);
      }
    }
    if (!version) throw new Error('CDP 未就绪');

    const targets = await getJson(CDP_PORT, '/json/list');
    const page = targets.find((t) => t.type === 'page');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let msgId = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('ws 失败')));
    });
    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++msgId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result?.result?.value;
    };

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: APP_URL });
    await sleep(2500);

    // 进四视图
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.includes('四视图'));if(b)b.click();return !!b})()`);
    await sleep(1200);

    const clientOf = (wx, wy) => evalJs(`(async()=>{
      const m = await import('/src/viewport/camera.ts');
      const cd = (await import('/src/viewport/camDebug.ts')).camDebug;
      const rect = document.querySelector('.vp').getBoundingClientRect();
      const s = m.worldToScreen({x:${wx}, y:${wy}}, cd.cam, cd.vw, cd.vh);
      return { x: rect.left + s.x, y: rect.top + s.y, scale: cd.cam.scale };})()`);
    const midOf = (view, part, edge) => evalJs(`(async()=>{
      const s = await import('/src/state/store.ts');
      const pl = s.bus.derive().geom.views.pickLines.find(x=>x.view==='${view}'&&x.part==='${part}'&&x.edge==='${edge}');
      if (!pl) return null;
      return { x:(pl.pts[0].x+pl.pts[1].x)/2, y:(pl.pts[0].y+pl.pts[1].y)/2 };})()`);

    async function shot(name, worldPt, note) {
      const c = await clientOf(worldPt.x, worldPt.y);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(c.x),
        y: Math.round(c.y),
        button: 'none',
        buttons: 0,
        pointerType: 'mouse',
      });
      await sleep(700);
      const read = await evalJs(`(()=>{const n=document.querySelector('.vp-hud-read');return n?n.textContent:''})()`);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(OUT_DIR, name);
      fs.writeFileSync(file, Buffer.from(shot.result.data, 'base64'));
      console.log(`已出图 ${file}`);
      console.log(`   ${note}`);
      console.log(`   悬停读数=[${read}]`);
      return read;
    }

    const maxPt = await midOf('front', 'outer.width', 'max');
    const minPt = await midOf('front', 'outer.width', 'min');
    const shelfPt = await midOf('internal', 'shelf.line');
    console.log('点位：', JSON.stringify({ maxPt, minPt, shelfPt }));

    const r1 = await shot('sheet-edit-draggable.png', maxPt, '悬停在【可拖】的柜宽末端边：应为蓝实线 + 端点帽');
    const r2 = await shot('sheet-edit-anchor.png', minPt, '悬停在【基准边】：应为红虚线，且读数里要说出为什么拖不动');
    if (shelfPt) await shot('sheet-edit-derived.png', shelfPt, '悬停在【层板线】：由数量派生，必须给理由，不许静默无反应');

    // 顺手做两条硬断言：图不是空白、可拖与不可拖的读数确实不同
    const size1 = fs.statSync(path.join(OUT_DIR, 'sheet-edit-draggable.png')).size;
    console.log(`\n断言：截图非空白 ${size1 > 20000 ? 'PASS' : 'FAIL'}（${size1} 字节）`);
    console.log(`断言：可拖/不可拖读数不同 ${r1 !== r2 ? 'PASS' : 'FAIL'}`);
    console.log(`断言：基准边读数含"理由" ${/基准边|不能拖|请/.test(r2) ? 'PASS' : 'FAIL'}`);
  } finally {
    try {
      await fetch(`http://127.0.0.1:${CDP_PORT}/json/close/self`).catch?.(() => {});
    } catch {}
    chromeProc.kill('SIGKILL');
    vite.kill('SIGKILL');
    await sleep(500);
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
    } catch {}
  }
}

main().catch((e) => {
  console.error('ERR:', e && e.message ? e.message : e);
  process.exit(1);
});
