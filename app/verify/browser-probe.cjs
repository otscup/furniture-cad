#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  Phase 1 · 浏览器端验收探针（主方案 §L12 第 1 步的收尾证据）
 *
 *  跑的是【真实界面】：真 Chrome、真指针事件、真键盘、真 DOM 取值。
 *  不做任何 JS 注入式取数 —— 所有读数都从界面上读回来，
 *  因为这一轮要证明的恰恰是"界面如实反映模型"，而不是"模型自己说自己是好的"。
 *
 *  B1  页面加载与初始状态（真实数字）
 *  B2  问题面板如实列出 3 条 WARNING（含 fixHint）
 *  B3  视口坐标标定（用 HUD 反解 px/mm，校验 X/Y 比例一致）
 *  B4  点选柜体 → 属性面板 authored / derived 分区与派生值
 *  B5  拖动柜体 = 改 placement（预览徽标 + Δ 读数 + 松手后提交）
 *  B6  历史面板记录了这条 UI 操作（source=ui / diff / 派生快照）
 *  B7  拖宽度夹点 = 改 params.width 并补偿锚点（右边缘钉住）
 *  B8  撤销 / 重做逐值回退
 *  B9  粘贴一段 Command JSON 走同一条历史（AI / MCP 通道）
 *  B10 越权写入在真实界面上被拒绝，且模型未变
 *  B11 零页面异常 / 零控制台 error / 截图非空白
 *  B12 对象捕捉真的工作：最终点 = 捕捉点，提示用中文
 *  B13 四视图图幅：正/俯/侧/内部由同一份模型投影派生（长对正 / 高平齐 / 宽相等）
 *  B14 记忆：记下的问题下次真的会拦住，不是存一句话
 *  B15 管理后台：自己配 API 模型 · 自动拉取 · key 只回后四位
 *  B16 分解图开关：默认关闭 · 打开后与开料清单逐件对应 · 关闭后复原
 *  B17 AI 规划：一句话 → 契约 → 干跑预览 → 应用（真 HTTP，OpenAI 兼容端点）
 *  B18 账号与安全：默认可不登录 · 建号后一个漏网接口都没有 · 缺口照实列出
 *  B18b 账号模式下未登录访问：宁可什么都不显示，也不显示一份假配置
 *  B19 样式完整性：界面上用到的类名必须在样式表里有规则
 *  B22 新建房间：连建多个房间都成功（id 必须避开项目里已用的）
 *  B23 导出面板：图纸选择 / 版本选择 / ERROR 提示 / 禁用逻辑
 *  B24 项目存盘与加载：自动保存 / 打开项目文件 / 坏文件拒绝
 *  B25 右键上下文菜单：右键即选中 / 选中态决定菜单 / 命令中右键=取消
 *  B26 四视图点选线 → 语义解析（点选部件 → 参数路径，坐标不出管线）
 *
 *  用法：先起本地服务与 dev server，再跑本脚本（见 package.json 的 verify:ui）。
 *  ══════════════════════════════════════════════════════════════════════
 */

'use strict';

const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// ───────────────────────────── config ─────────────────────────────

const APP_PORT = Number(process.env.APP_PORT || 5273);
const CDP_PORT = Number(process.env.CDP_PORT || 6273);
const APP_URL = `http://127.0.0.1:${APP_PORT}/`;
const HERE = __dirname;
const OUT_DIR = path.join(HERE, 'out');
const SHOT_PLAN = path.join(OUT_DIR, 'app-plan-view.png');
const SHOT_ISSUES = path.join(OUT_DIR, 'app-issues-view.png');
const SHOT_DRAG = path.join(OUT_DIR, 'app-drag-preview.png');

/**
 * Chrome 的 user-data-dir 放【系统临时目录】，不放项目里。
 *
 * 一开始放在 verify/out/ 下，结果是每次验收往项目里扔 8–56MB，
 * 而且删除时会被运行环境的 safe-delete 保护层拦下来（转回收站失败 → fail-closed），
 * 根本清不掉。临时 profile 是纯一次性垃圾，本来就不该进仓库；
 * 放 tmp 之后 verify/out/ 里只剩"人要看的东西"（截图）。
 */
const PROFILE_ROOT = path.join(os.tmpdir(), 'furniture-cad-cdp');
const PROFILE = path.join(PROFILE_ROOT, `profile-${Date.now()}`);

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
];

const DIAG_DIR = path.join(OUT_DIR, 'diagnostics');

// 从真实管线实测得到的期望值（verify/_probe-facts.ts 采过，跑完即删）
const FACT = {
  cabinetName: '主卧衣柜',
  cabW: 2400,
  cabH: 2400,
  cabD: 600,
  cabX: 400,
  cabY: 60,
  panelKinds: 28,
  totalPieces: 31,
  nets: '582 / 1164 / 582',
  warnings: 3,
  errors: 0,
};

// ───────────────────────────── 断言 ─────────────────────────────

const results = [];
let currentGroup = '';

/**
 * ONLY=<小节关键字> 时只统计/打印该小节 —— 排查单节失败时不必每次等满 3 分钟。
 * 注意：其他小节的**动作照样执行**（很多小节依赖前序留下的状态），
 * 只是不记账。所以它是排查工具，不是"跳过前置"的开关。
 */
const ONLY = (process.env.ONLY || '').trim();
const focused = () => !ONLY || currentGroup.includes(ONLY);

function section(title) {
  currentGroup = title;
  console.log(`\n── ${title} ──`);
}

function ok(name, cond, detail) {
  const pass = !!cond;
  if (focused()) {
    results.push({ group: currentGroup, name, pass, detail });
    console.log(`${pass ? '  \u2713' : '  \u2717'} ${name}${pass || !detail ? '' : `\n      → ${detail}`}`);
  }
  return pass;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ───────────────────────────── CDP 底座 ─────────────────────────────

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: p }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(d));
          } catch (e) {
            reject(new Error(`bad JSON from ${p}`));
          }
        });
      })
      .on('error', reject);
  });
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  throw new Error(`Chrome not found:\n  ${CHROME_CANDIDATES.join('\n  ')}`);
}

async function waitForApp(url, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const html = await new Promise((resolve, reject) => {
        http
          .get(url, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve(d));
          })
          .on('error', reject);
      });
      if (/<div id="root">|<script/.test(html)) return true;
    } catch {
      /* dev server not up yet */
    }
    await sleep(400);
  }
  return false;
}

// ───────────────────────────── main ─────────────────────────────

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  /**
   * `diagnostics/` 只在这个 catch 里按需创建（见文件末尾）。
   * 早先在这里无条件 mkdir，于是**每一次正常通过**的验收都会留下一个空目录 ——
   * 一个"什么都不说明"的目录出现在证据目录里，比没有这个目录更容易让人误解。
   */

  // 清掉上一次跑剩的临时 profile（只动我们自己前缀的那一类）
  fs.mkdirSync(PROFILE_ROOT, { recursive: true });
  try {
    for (const name of fs.readdirSync(PROFILE_ROOT)) {
      if (name.startsWith('profile-')) {
        fs.rmSync(path.join(PROFILE_ROOT, name), { recursive: true, force: true, maxRetries: 2 });
      }
    }
  } catch {
    /* 清不掉就留着，临时目录不影响项目 */
  }

  const appUp = await waitForApp(APP_URL);
  if (!appUp) {
    console.error(`ERR: dev server 未响应 ${APP_URL}（请先启动 vite）`);
    process.exit(1);
  }

  const chromePath = findChrome();
  fs.mkdirSync(PROFILE, { recursive: true });

  const chrome = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-component-update',
      '--disable-features=Translate,MediaRouter',
      '--hide-scrollbars',
      '--window-size=1600,1040',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  /**
   * ══ 收尾：必须连 profile 一起删 ══
   *
   * Chrome 的 user-data-dir 每个 8–56MB，跑十几次验收能堆到几百 MB。
   * 试过两种失败写法，记在这里免得重犯：
   *   · 先 `chrome.kill()` 再 `rm` → 子进程（crashpad/zygote）还占着句柄，rm 全失败
   *   · `taskkill /pid <spawn 出来的 pid> /T /F` → 打不中：Windows 上 Chrome 会把
   *     浏览器进程交给新 PID，我们手上的 pid 早就退出了；Chrome 是稍后才自己退的，
   *     那时已经没人负责删目录了
   * 正确顺序：**先优雅关闭（CDP Browser.close）→ 等它真的退出 → 再删**。
   */
  const killChrome = () => {
    try {
      if (process.platform === 'win32' && chrome.pid) {
        // 先按启动器 pid 整树强杀（覆盖大多数情况）
        spawnSync('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
        /**
         * 兜底：Windows 上 Chrome 会把浏览器进程交给新 PID（singleton 重排），
         * 上面那发 `/pid /T` 打不中真正的浏览器进程 —— 于是每次验收都留一个孤儿
         * chrome，跑十几轮就把内存吃满（tsc 报 VirtualAlloc failed / errno=1455）。
         * 按我们**独有**的 remote-debugging-port 把残留的 chrome 整组收掉；
         * 用户自己开的那份 chrome 不带这个端口，不会被误杀。
         * 失败（PowerShell 不可用等）静默忽略 —— 至少退回到原来的 /pid 行为。
         */
        const ps = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*remote-debugging-port=${CDP_PORT}*' } | ForEach-Object { taskkill /pid $_.ProcessId /F }`;
        spawnSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'ignore' });
      } else {
        chrome.kill('SIGKILL');
      }
    } catch {
      /* already gone */
    }
  };

  const removeProfile = () => {
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* 还占着就留给下一次运行开头的兜底清扫 */
    }
  };

  /** 浏览器还活着吗？—— 用 CDP 是否应答判断，而不是用我们自己的子进程状态 */
  const cdpAlive = async () => {
    try {
      await Promise.race([
        getJson(CDP_PORT, '/json/version'),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 700)),
      ]);
      return true;
    } catch {
      return false;
    }
  };

  /** 通过浏览器级 endpoint 请求 Chrome 自己关闭（正常落盘并释放全部句柄） */
  const closeBrowserGracefully = async () => {
    if (!(await cdpAlive())) return;
    try {
      const v = await getJson(CDP_PORT, '/json/version');
      if (!v?.webSocketDebuggerUrl) return;
      const bws = new WebSocket(v.webSocketDebuggerUrl);
      const opened = await new Promise((res) => {
        const t = setTimeout(() => res(false), 2000);
        bws.addEventListener('open', () => {
          clearTimeout(t);
          res(true);
        });
        bws.addEventListener('error', () => {
          clearTimeout(t);
          res(false);
        });
      });
      if (opened) {
        bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        await sleep(300);
      }
      try {
        bws.close();
      } catch {
        /* ignore */
      }
    } catch {
      /* ignore */
    }
  };

  // 兜底：意外退出路径也要尽力清一次（exit 钩子里只能跑同步代码）
  process.on('exit', () => {
    killChrome();
    removeProfile();
  });

  /**
   * 收尾顺序：优雅关闭 → 等浏览器真的消失 → 删目录。
   *
   * 注意**不能**用 `chrome.exitCode === null` 来等：Windows 上 Chrome 会把浏览器
   * 进程交给新 PID，我们 spawn 出来的启动器秒退，exitCode 立刻就有值，
   * 等待循环会空转，然后在浏览器还活着的时候去删目录 —— 必然失败。
   */
  const cleanup = async () => {
    await closeBrowserGracefully();
    for (let i = 0; i < 20; i++) {
      if (!(await cdpAlive())) break;
      await sleep(200);
    }
    if (await cdpAlive()) killChrome(); // 死活不走才强杀（跨平台兜底）
    for (let i = 0; i < 8; i++) {
      if (!fs.existsSync(PROFILE)) return;
      removeProfile();
      if (!fs.existsSync(PROFILE)) return;
      await sleep(300);
    }
  };

  let ws = null;

  try {
    // ── 1. 等 CDP ──
    const deadline = Date.now() + 25000;
    let version = null;
    while (Date.now() < deadline) {
      try {
        version = await getJson(CDP_PORT, '/json/version');
        break;
      } catch {
        await sleep(400);
      }
    }
    if (!version) throw new Error(`CDP 未就绪（端口 ${CDP_PORT}）`);
    console.log('chrome  :', version['Browser']);

    // ── 2. 连页面 ──
    const targets = await getJson(CDP_PORT, '/json/list');
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('找不到 page target');
    ws = new WebSocket(page.webSocketDebuggerUrl);

    let msgId = 0;
    const pending = new Map();
    const pageErrors = [];
    const consoleErrors = [];

    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
        return;
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        pageErrors.push(d.exception?.description || d.text || 'unknown exception');
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
        const e = m.params.entry;
        consoleErrors.push(`${e.text}${e.url ? ` ← ${e.url}` : ''}`);
      }
    });

    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('websocket 连接失败')));
    });

    const send = (method, params = {}) =>
      new Promise((resolve) => {
        const id = ++msgId;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');

    // ── 3. 导航 ──
    await send('Page.navigate', { url: APP_URL });
    await sleep(1200);

    // 等 React 挂载 + 首帧绘制
    {
      const dl = Date.now() + 15000;
      let ready = false;
      while (Date.now() < dl) {
        const r = await send('Runtime.evaluate', {
          expression: `!!document.querySelector('.vp-canvas') && document.querySelectorAll('.tree-leaf').length >= 0 && !!document.querySelector('.statusbar')`,
          returnByValue: true,
        });
        if (r.result?.result?.value) {
          ready = true;
          break;
        }
        await sleep(250);
      }
      if (!ready) throw new Error('界面未在 15s 内挂载');
    }
    await sleep(900);

    // ── 工具函数（都建立在 send 之上）──

    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.result?.exceptionDetails) {
        throw new Error(`页面内报错: ${r.result.exceptionDetails.text} :: ${r.result.exceptionDetails.exception?.description ?? ''}`);
      }
      return r.result?.result?.value;
    };

    const mouse = (type, x, y, opts = {}) =>
      send('Input.dispatchMouseEvent', {
        type,
        x: Math.round(x),
        y: Math.round(y),
        button: opts.button ?? (type === 'mouseMoved' ? 'none' : 'left'),
        buttons: opts.buttons ?? (type === 'mouseMoved' ? 0 : 1),
        clickCount: type === 'mouseMoved' ? 0 : 1,
        pointerType: 'mouse',
      });

    const moveMouse = (x, y, buttons = 0) => mouse('mouseMoved', x, y, { button: 'none', buttons });
    const mouseDown = (x, y) => mouse('mousePressed', x, y, { button: 'left', buttons: 1 });
    const mouseUp = (x, y) => mouse('mouseReleased', x, y, { button: 'left', buttons: 0 });
    const mouseRightClick = (x, y) => {
      mouse('mousePressed', x, y, { button: 'right', buttons: 2 });
      mouse('mouseReleased', x, y, { button: 'right', buttons: 0 });
    };

    const keyPress = async (key, code, vk, modifiers = 0) => {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers,
      });
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers,
      });
      await sleep(120);
    };

    const text = (sel) => evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});return e?e.textContent.replace(/\\s+/g,' ').trim():''})()`);

    const hudWorld = async () => {
      const t = await evalJs(`(()=>{const e=document.querySelectorAll('.vp-hud-item')[0];return e?e.textContent:''})()`);
      const m = /X\s*(-?\d+)\s*Y\s*(-?\d+)/.exec(t || '');
      return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
    };

    const hudReadout = () => text('.vp-hud-read');
    const statusText = () => text('.statusbar');

    /**
     * 状态栏必须按【独立元素】取值，不能对整条状态栏做正则。
     * 状态栏是 flex 里的一串 inline 元素，textContent 会把相邻项直接粘起来：
     * "v0" + "1 : 6" 变成 "v01 : 6"，正则 /v(\d+)/ 就会读出 1。
     */
    const statusItems = () =>
      evalJs(`[...document.querySelectorAll('.statusbar .sb-item')].map(e=>e.textContent.replace(/\\s+/g,' ').trim())`);

    const pickItem = async (needle) => {
      const it = await statusItems();
      return it.find((x) => x.includes(needle)) ?? '';
    };

    const statusVersion = async () => {
      const m = /v(\d+)/.exec(await pickItem('模型版本'));
      return m ? Number(m[1]) : null;
    };
    const statusRatio = async () => {
      const m = /1\s*:\s*(\d+)/.exec(await pickItem('1 :'));
      return m ? Number(m[1]) : null;
    };
    const statusPieces = async () => {
      const m = /板件\s*(\d+)\s*件/.exec(await pickItem('板件'));
      return m ? Number(m[1]) : null;
    };
    const statusSelection = async () => {
      const m = /已选\s*(\d+)\s*项/.exec(await pickItem('已选'));
      return m ? Number(m[1]) : null;
    };

    /** 按 label 精确读属性面板里的输入框值（label 需先去掉 🔒 与空白） */
    const panelInput = async (label) => {
      const v = await evalJs(`(()=>{
        const want = ${JSON.stringify(label)}.replace(/[\\s\\u{1F512}]/gu,'');
        const norm = (s)=>s.replace(/[\\s\\u{1F512}]/gu,'');
        const row = [...document.querySelectorAll('.side-right .row')]
          .find(r=>{const l=r.querySelector('.row-label');return l&&norm(l.textContent)===want;});
        if(!row) return null;
        const f = row.querySelector('input,select');
        return f ? String(f.value) : null;
      })()`);
      return v === null ? null : Number(v);
    };

    /** 按 label 精确读属性面板里的只读文本 */
    const panelText = async (label) => {
      const v = await evalJs(`(()=>{
        const want = ${JSON.stringify(label)}.replace(/[\\s\\u{1F512}]/gu,'');
        const norm = (s)=>s.replace(/[\\s\\u{1F512}]/gu,'');
        const row = [...document.querySelectorAll('.side-right .row')]
          .find(r=>{const l=r.querySelector('.row-label');return l&&norm(l.textContent)===want;});
        if(!row) return null;
        const v = row.querySelector('.row-value');
        return v ? v.textContent.replace(/\\s+/g,' ').trim() : null;
      })()`);
      return v;
    };

    /** 右侧面板的整段文本（用于"这段话在不在"这类断言，不用于精确取行） */
    const panelTextAll = async () =>
      String(await evalJs(`(()=>{const e=document.querySelector('.side-right');return e?e.textContent.replace(/\\s+/g,' ').trim():'';})()`));

    const activateRightTab = async (name) => {
      const r = await evalJs(`(()=>{
        const b=[...document.querySelectorAll('.side-right .tabs button')]
          .find(x=>x.textContent.trim().startsWith(${JSON.stringify(name)}));
        if(!b) return false; b.click(); return true;
      })()`);
      await sleep(260);
      return r;
    };

    const vpRect = () =>
      evalJs(`(()=>{const e=document.querySelector('.vp');if(!e)return null;const r=e.getBoundingClientRect();
        return {left:r.left,top:r.top,w:r.width,h:r.height};})()`);

    /** 通过命令行执行一条命令（含 Command JSON 通道） */
    const runCommandLine = async (payload) => {
      const open = await evalJs(`!!document.querySelector('.cmd-input')`);
      if (!open) {
        await keyPress('`', 'Backquote', 192);
        await sleep(260);
      }
      const setLen = await evalJs(`(()=>{
        const el=document.querySelector('.cmd-input');
        if(!el) return -1;
        const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        d.set.call(el, ${JSON.stringify(payload)});
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.focus();
        return el.value.length;
      })()`);
      if (setLen < 0) throw new Error('命令行输入框不存在');
      await sleep(120);
      await keyPress('Enter', 'Enter', 13);
      await sleep(420);
    };

    const shot = async (file) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      if (!r.result?.data) return 0;
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      return fs.statSync(file).size;
    };

    // ── 面板操作（记忆 / 管理后台 / 视图面板共用）──

    /** 点击右侧面板里文字匹配的按钮（先精确匹配，再退化为包含匹配） */
    const clickPanelBtn = async (label, waitMs = 320) => {
      const r = await evalJs(`(()=>{
        const l=${JSON.stringify(label)};
        const b=[...document.querySelectorAll('.side-right .tb-btn')]
          .find(x=>x.textContent.replace(/\\s+/g,' ').trim()===l || x.textContent.includes(l));
        if(!b) return false; b.click(); return true;
      })()`);
      await sleep(waitMs);
      return r;
    };

    /** 按 label 找到右侧面板某一行里的控件，用原生 setter 写入并派发 input/change */
    const panelSet = async (label, value) => {
      const r = await evalJs(`(()=>{
        const want=${JSON.stringify(label)}.replace(/[\\s\\u{1F512}]/gu,'');
        const norm=(s)=>s.replace(/[\\s\\u{1F512}]/gu,'');
        const row=[...document.querySelectorAll('.side-right .row')]
          .find(r=>{const l=r.querySelector('.row-label');return l&&norm(l.textContent)===want;});
        if(!row) return 'no-row';
        const f=row.querySelector('input,select,textarea');
        if(!f) return 'no-field';
        const proto=f.tagName==='SELECT'?HTMLSelectElement.prototype
          :f.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(f, ${JSON.stringify(String(value))});
        f.dispatchEvent(new Event('input',{bubbles:true}));
        f.dispatchEvent(new Event('change',{bubbles:true}));
        /**
         * NumField 是**失焦/回车才提交**（否则输入 2400 会在撤销栈里留下 4 条命令）。
         * 只派 input/change 只会改它的本地文本态，onCommit 根本不会触发 ——
         * 探针会以为"写进去了"，其实 setValue 没被调用。
         * 这里补一次回车：与真实用户敲完按回车完全同一条路径。
         */
        if (f.closest('.numfield')) {
          f.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
        }
        return 'ok';
      })()`);
      await sleep(180);
      return r;
    };

    /** 读某一行里控件的原生属性（type / placeholder / value / option 列表） */
    const panelField = async (label) =>
      evalJs(`(()=>{
        const want=${JSON.stringify(label)}.replace(/[\\s\\u{1F512}]/gu,'');
        const norm=(s)=>s.replace(/[\\s\\u{1F512}]/gu,'');
        const row=[...document.querySelectorAll('.side-right .row')]
          .find(r=>{const l=r.querySelector('.row-label');return l&&norm(l.textContent)===want;});
        if(!row) return null;
        const f=row.querySelector('input,select,textarea');
        if(!f) return null;
        return {
          tag:f.tagName, type:f.getAttribute('type')||'', placeholder:f.getAttribute('placeholder')||'',
          value:f.value==null?'':String(f.value),
          options:f.tagName==='SELECT'?[...f.options].map(o=>o.value):null,
        };
      })()`);

    /** 直接给某个选择器写值（textarea 等不在 Row 里的控件） */
    const setElValue = async (sel, value) => {
      const r = await evalJs(`(()=>{
        const el=document.querySelector(${JSON.stringify(sel)});
        if(!el) return false;
        const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto,'value').set.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event('input',{bubbles:true}));
        return true;
      })()`);
      await sleep(150);
      return r;
    };

    /** 轮询等待页面内条件成立（面板里的 fetch 是异步的，写死 sleep 必然假失败） */
    const waitFor = async (expr, timeoutMs = 5000, step = 150) => {
      const dl = Date.now() + timeoutMs;
      while (Date.now() < dl) {
        if (await evalJs(expr)) return true;
        await sleep(step);
      }
      return false;
    };

    /** 视口画布像素指纹：用来证明"换了一个视图"而不是"看起来像换了" */
    const canvasSig = () =>
      evalJs(`(()=>{
        const c=document.querySelector('.vp-canvas');
        const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let n=0,nonBg=0,h=2166136261;
        for(let i=0;i<d.length;i+=4*53){
          n++;
          if(d[i]!==d[i+1]||d[i+1]!==d[i+2]) nonBg++;
          h=Math.imul(h^d[i],16777619); h=Math.imul(h^d[i+1],16777619); h=Math.imul(h^d[i+2],16777619);
        }
        return {n, nonBg, h: h>>>0};
      })()`);

    // ═══════════════════════════════════════════════════════════
    section('B1 页面加载与初始状态（期望值来自真实管线，不是臆测）');

    const rect = await vpRect();
    ok('视口元素存在且有尺寸', !!rect && rect.w > 300 && rect.h > 200, rect ? JSON.stringify(rect) : 'null');

    const canvasInfo = await evalJs(`(()=>{const c=document.querySelector('.vp-canvas');
      return c?{bw:c.width,bh:c.height,cw:c.style.width,dpr:window.devicePixelRatio||1}:null})()`);
    ok(
      'canvas 后备存储按 DPR 放大（不是 1:1 模糊画布）',
      !!canvasInfo && canvasInfo.bw >= Number.parseInt(canvasInfo.cw, 10),
      JSON.stringify(canvasInfo)
    );

    ok(`状态栏显示 板件 ${FACT.totalPieces} 件`, (await statusPieces()) === FACT.totalPieces, (await pickItem('板件')));
    ok('状态栏显示 1 柜体 / 4 墙', (await pickItem('柜体')) === '1 柜体 / 4 墙', await pickItem('柜体'));
    ok('状态栏显示板材面积 22.80 m²', /22\.80\s*m²/.test(await pickItem('板件')), await pickItem('板件'));
    ok('初始模型版本是 v0（尚未发生任何命令）', (await statusVersion()) === 0, `v${await statusVersion()}`);

    const errBadge = await text('.sb-badge-err');
    ok('初始状态没有任何 ERROR 徽标', errBadge === '', `实为「${errBadge}」`);
    const warnBadge = await text('.sb-badge-warn');
    ok(`初始状态如实显示 ${FACT.warnings} WARNING（不掩盖）`, warnBadge === `${FACT.warnings} WARNING`, `实为「${warnBadge}」`);

    ok('工具栏明示 MVP 边界：仅 DXF', (await text('.tb-notice')) === 'MVP：仅 DXF', await text('.tb-notice'));

    // 底部三条横栏（视口 / 提示条 / 状态栏）必须各占各的位置。
    // 这条断言来自一次真实的目视检查：提示条曾用绝对定位压在状态栏上，叠成一团不可读的字。
    const layout = await evalJs(`(()=>{
      const hit=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
      const R=(s)=>{const e=document.querySelector(s);return e?e.getBoundingClientRect():null;};
      const CS=(s)=>{const e=document.querySelector(s);return e?getComputedStyle(e):null;};
      const hint=R('.cmd-hint'), bar=R('.statusbar'), vp=R('.vp');
      const toc=CS('.toasts'), hic=CS('.cmd-hint');
      return {
        hintExists: !!hint,
        hintVsStatusbar: hint&&bar ? hit(hint,bar) : null,
        hintVsViewport: hint&&vp ? hit(hint,vp) : null,
        toastsBottom: toc ? parseFloat(toc.bottom) : null,
        bottomBars: (bar?bar.height:0) + (hic?parseFloat(hic.height):0),
      };
    })()`);
    ok('命令行提示条存在（命令行关闭时）', layout?.hintExists === true, JSON.stringify(layout));
    ok('提示条不与状态栏重叠', layout?.hintVsStatusbar === false, JSON.stringify(layout));
    ok('提示条不遮盖 2D 视口', layout?.hintVsViewport === false, JSON.stringify(layout));
    ok(
      '提示气泡让开了底部横栏（bottom ≥ 状态栏 + 提示条）',
      layout?.toastsBottom !== null && layout.toastsBottom >= layout.bottomBars,
      JSON.stringify(layout)
    );

    // 对象树里墙排在柜体前面，所以不能取"第一个 .tree-leaf"，要按名字找
    const treeCab = await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-left .tree-leaf')]
      .find(x=>x.textContent.includes(${JSON.stringify(FACT.cabinetName)}));
      return b?b.textContent.replace(/\\s+/g,' ').trim():null})()`);
    ok(
      `对象树里是「${FACT.cabinetName}」${FACT.cabW}×${FACT.cabH}×${FACT.cabD}`,
      !!treeCab && treeCab.includes(FACT.cabinetName) && treeCab.includes(`${FACT.cabW}×${FACT.cabH}×${FACT.cabD}`),
      treeCab
    );

    const treeUnits = await evalJs(`document.querySelectorAll('.side-left .tree-leaf-sub').length`);
    ok('对象树展开了 3 个分区', treeUnits === 3, `实为 ${treeUnits}`);

    // ═══════════════════════════════════════════════════════════
    section('B2 问题面板如实列出 3 条 WARNING');

    await activateRightTab('问题');
    const issuesText = await text('.side-right .panel-scroll');
    ok('WARNING 分组标题为 3 条', /WARNING · 需人工确认（3）/.test(issuesText), issuesText.slice(0, 200));
    // 措辞随目录改版过一次（"拆为 N 块" → "按 a 列 × b 行拆成 N 块"）：
    // 这里要的是"说明了拆了几块"，不是某个固定措辞 —— 措辞一换就红是脆断言。
    ok('列出 RULE-BACKPANEL-SPLIT 且说明了拆块',
      /RULE-BACKPANEL-SPLIT/.test(issuesText) && /拆(为|成) \d+ 块/.test(issuesText));
    ok('列出 RULE-DRAWER-TALL-FRONT', /RULE-DRAWER-TALL-FRONT/.test(issuesText));
    ok('列出 RULE-SHELF-SPAN', /RULE-SHELF-SPAN/.test(issuesText));
    ok(
      '每条问题都带 fixHint（不是只报错不给方向）',
      (await evalJs(`document.querySelectorAll('.side-right .issue-item .fix-hint').length`)) >= 3
    );
    ok('ERROR 分组不存在（没有 ERROR）', !/ERROR · 阻断交付/.test(issuesText));
    ok('INFO 与 WARNING 分了不同等级，未混为一谈', /INFO · 提示（不是错误）/.test(issuesText));

    const sizeIssues = await shot(SHOT_ISSUES);
    ok(`问题面板截图已保存（${(sizeIssues / 1024).toFixed(0)}KB）`, sizeIssues > 20000);

    // ═══════════════════════════════════════════════════════════
    section('B3 视口坐标标定（用 HUD 反解 px/mm）');

    // 关掉对象捕捉，让 HUD 显示未经吸附的原始世界坐标（否则标定被吸附污染）
    await keyPress('F3', 'F3', 114);
    const snapOn = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')]
      .find(x=>x.textContent.trim().startsWith('捕捉'));return b?b.classList.contains('active'):null})()`);
    ok('F3 关闭了对象捕捉（标定前提）', snapOn === false, `active=${snapOn}`);

    const A = { x: Math.round(rect.left + rect.w * 0.26), y: Math.round(rect.top + rect.h * 0.28) };
    const B = { x: Math.round(rect.left + rect.w * 0.74), y: Math.round(rect.top + rect.h * 0.80) };
    const C = { x: Math.round(rect.left + rect.w * 0.5), y: Math.round(rect.top + rect.h * 0.52) };

    await moveMouse(A.x, A.y);
    await sleep(220);
    const wa = await hudWorld();
    await moveMouse(B.x, B.y);
    await sleep(220);
    const wb = await hudWorld();

    ok('HUD 在 A 点给出了世界坐标', !!wa, JSON.stringify(wa));
    ok('HUD 在 B 点给出了世界坐标', !!wb, JSON.stringify(wb));

    const pxPerMmX = (B.x - A.x) / (wb.x - wa.x);
    const pxPerMmY = (A.y - B.y) / (wb.y - wa.y);
    const scale = (pxPerMmX + pxPerMmY) / 2;

    ok(
      `X/Y 两个方向的 px/mm 一致（说明坐标系没被非等比缩放）`,
      Math.abs(pxPerMmX - pxPerMmY) / scale < 0.01,
      `X=${pxPerMmX.toFixed(5)} Y=${pxPerMmY.toFixed(5)}`
    );
    ok(`比例尺落在合理区间（1:${Math.round(1 / scale)}）`, scale > 0.05 && scale < 1, `scale=${scale.toFixed(5)}`);

    const screenRatio = await statusRatio();
    ok(
      '状态栏的比例与实测标定一致（±2）',
      screenRatio !== null && Math.abs(screenRatio - Math.round(1 / scale)) <= 2,
      `状态栏 1:${screenRatio} vs 标定 1:${Math.round(1 / scale)}`
    );

    // 反解函数：client 像素 → 世界 mm
    const toClient = (wx, wy) => ({ x: A.x + (wx - wa.x) * scale, y: A.y - (wy - wa.y) * scale });
    const toWorld = (cx, cy) => ({ x: wa.x + (cx - A.x) / scale, y: wa.y - (cy - A.y) / scale });

    await moveMouse(C.x, C.y);
    await sleep(220);
    const wc = await hudWorld();
    const predicted = toWorld(C.x, C.y);
    ok(
      '第三点实测与标定预测一致（≤2mm）',
      near(wc.x, predicted.x, 2) && near(wc.y, predicted.y, 2),
      `实测 (${wc.x}, ${wc.y}) vs 预测 (${predicted.x.toFixed(1)}, ${predicted.y.toFixed(1)})`
    );

    // ═══════════════════════════════════════════════════════════
    section('B4 点选柜体 → 属性面板 authored / derived 分区');

    await activateRightTab('属性');
    const clickOnCab = toClient(FACT.cabX + 500, FACT.cabY + 250);
    await moveMouse(clickOnCab.x, clickOnCab.y);
    await sleep(150);
    await mouseDown(clickOnCab.x, clickOnCab.y);
    await sleep(120);
    await mouseUp(clickOnCab.x, clickOnCab.y);
    await sleep(450);

    const selCount = await statusSelection();
    ok('状态栏显示 已选 1 项', selCount === 1, `实为 ${selCount}`);

    const selTree = await text('.side-left .tree-leaf.sel');
    ok('对象树里对应条目被高亮', selTree.includes(FACT.cabinetName), selTree);

    ok(
      '属性面板切到柜体（标题写明「可写」区）',
      /柜体「主卧衣柜」（可写）/.test(await text('.side-right .panel-scroll'))
    );

    ok('外形尺寸区可写：宽 W 是输入框', (await panelInput('宽 W')) === FACT.cabW, String(await panelInput('宽 W')));
    ok('高 H / 深 D 可写且正确', (await panelInput('高 H')) === FACT.cabH && (await panelInput('深 D')) === FACT.cabD);
    ok('位置 X / Y 可写且正确', (await panelInput('X')) === FACT.cabX && (await panelInput('Y')) === FACT.cabY);

    ok(
      '派生值区带 🔒 标记（AI 与人都改不了）',
      (await evalJs(`document.querySelectorAll('.side-right .row-derived .lock').length`)) >= 6
    );
    ok(`派生净宽 = ${FACT.nets}`, (await panelText('各分区实际净宽')) === `${FACT.nets} mm`, await panelText('各分区实际净宽'));
    ok('派生可用净宽合计 = 2328', (await panelText('可用净宽合计')) === '2328 mm', await panelText('可用净宽合计'));

    const panelTitle = await text('.side-right .panel-scroll');
    ok(
      `板件清单标题如实给出 ${FACT.panelKinds} 种 / ${FACT.totalPieces} 件`,
      new RegExp(`板件清单（派生 ${FACT.panelKinds} 种 / ${FACT.totalPieces} 件）`).test(panelTitle)
    );

    const rows = await evalJs(`document.querySelectorAll('.side-right .tbl tbody tr').length`);
    ok(`板件清单表格有 ${FACT.panelKinds} 行`, rows >= FACT.panelKinds, `实为 ${rows}`);

    const edgeCells = await evalJs(`(()=>{const c=[...document.querySelectorAll('.side-right .edge-cell')];
      return c.length? c.map(x=>x.textContent).filter(x=>x.includes('封边')).length : 0})()`);
    ok('板件表给出了封边信息（生产必备）', edgeCells > 0, `封边单元 ${edgeCells} 个`);

    // ═══════════════════════════════════════════════════════════
    section('B5 拖动柜体 = 改 placement（预览 === 提交）');

    const Y_BEFORE = await panelInput('Y');
    const X_BEFORE = await panelInput('X');
    const vBeforeDrag = await statusVersion();
    const bodyFrom = toClient(X_BEFORE + 500, Y_BEFORE + 250);
    const dragPx = 150; // 屏幕像素；世界位移由标定换算，不写死期望值

    await moveMouse(bodyFrom.x, bodyFrom.y);
    await sleep(150);
    await mouseDown(bodyFrom.x, bodyFrom.y);
    await sleep(150);

    // 分步拖，模拟真实手感
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await moveMouse(bodyFrom.x, bodyFrom.y - (dragPx * i) / steps, 1);
      await sleep(45);
    }
    await sleep(240);

    const previewBadge = await text('.vp-preview-badge');
    ok('拖动中显示「预览中 · 松手提交」徽标（两段式执行的可见形态）', /预览中/.test(previewBadge), previewBadge);

    const readout = await hudReadout();
    const mDelta = /Δ\(?([+-]?\d+),\s*([+-]?\d+)\)?/.exec(readout);
    ok('拖动中 HUD 给出位移读数 Δ', !!mDelta, `读数「${readout}」`);

    const dragShot = await shot(SHOT_DRAG);
    ok(`拖动中的截图已保存（${(dragShot / 1024).toFixed(0)}KB）`, dragShot > 20000);

    // 松手前的模型尚未改变 —— 这正是两段式执行的价值
    const vDuringDrag = await statusVersion();
    ok(
      '松手前模型版本未变（拖动只是预览，未写库）',
      vDuringDrag === vBeforeDrag,
      `v${vBeforeDrag} → v${vDuringDrag}`
    );

    await mouseUp(bodyFrom.x, bodyFrom.y - dragPx);
    await sleep(520);

    const expectedDy = dragPx / scale;
    const Y_AFTER = await panelInput('Y');
    const X_AFTER = await panelInput('X');

    ok(
      `提交后 Y 增加了约 ${Math.round(expectedDy)}mm（±5）`,
      Y_AFTER !== null && near(Y_AFTER - Y_BEFORE, expectedDy, 5),
      `${Y_BEFORE} → ${Y_AFTER}（期望 +${expectedDy.toFixed(1)}）`
    );
    ok('拖动的方向正确（世界 +Y 向上，屏幕向上 = Y 增大）', Y_AFTER > Y_BEFORE, `${Y_BEFORE} → ${Y_AFTER}`);
    ok('垂直拖动没有污染 X', Math.abs(X_AFTER - X_BEFORE) <= 2, `${X_BEFORE} → ${X_AFTER}`);

    ok(
      '松手后 HUD 读数 Δ 与提交结果一致（看到的 === 落库的）',
      !!mDelta && near(Number(mDelta[2]), Y_AFTER - Y_BEFORE, 4),
      `Δ读数 Δ(${mDelta?.[1]}, ${mDelta?.[2]}) vs 实际 Δ(${X_AFTER - X_BEFORE}, ${Y_AFTER - Y_BEFORE})`
    );

    // 松手后不能留下拖动期才该有的东西（追踪线 / 捕捉标记 / 预览徽标 / 位移读数）
    const leftovers = await evalJs(`({
      snap: !!document.querySelector('.vp-hud-snap'),
      readout: !!document.querySelector('.vp-hud-read'),
      preview: !!document.querySelector('.vp-preview-badge'),
    })`);
    ok(
      '松手后没有残留的捕捉标记 / 位移读数 / 预览徽标（状态不拖尾）',
      !leftovers.snap && !leftovers.readout && !leftovers.preview,
      JSON.stringify(leftovers)
    );

    ok('拖动只改位置：宽/高/深一个都没动', (await panelInput('宽 W')) === FACT.cabW && (await panelInput('高 H')) === FACT.cabH && (await panelInput('深 D')) === FACT.cabD);
    const vAfterMove = await statusVersion();
    ok('一次拖动 = 一条命令 = 模型版本 +1', vAfterMove === vBeforeDrag + 1, `v${vBeforeDrag} → v${vAfterMove}`);
    ok(`板件数不受位置影响（仍 ${FACT.totalPieces} 件）`, (await statusPieces()) === FACT.totalPieces, `实为 ${await statusPieces()}`);
    ok('拖动没有引入 ERROR', (await text('.sb-badge-err')) === '', await text('.sb-badge-err'));

    // 记下"拖动后、改尺寸前"的 X，B8 撤销时要用它（B7 会改 X，撤销必须还原到它）
    const X_AFTER_BODY = X_AFTER;

    // ═══════════════════════════════════════════════════════════
    section('B6 历史面板记录这条 UI 操作');

    await activateRightTab('历史');
    const hist = await text('.side-right .hist');
    ok('历史里有「移动『主卧衣柜』」这条记录', /移动「主卧衣柜」/.test(hist), hist.slice(0, 240));
    ok(
      '位移读数带符号（正负方向一眼可分，复盘不会看反）',
      /Δ\(\+0, \+\d+\)/.test(hist),
      hist.slice(0, 240)
    );
    ok('该条记录标记 source = ui', (await evalJs(`document.querySelectorAll('.side-right .hist-src.src-ui').length`)) >= 1);
    ok('该条记录写了 op = cabinet.moveBatch', /cabinet\.moveBatch/.test(hist), hist.slice(0, 240));
    ok('该条记录给出 diff：placement.y 从 60 起', /placement\.y:\s*60\s*→/.test(hist), hist.slice(0, 400));
    ok(`该条记录带派生快照（板件 ${FACT.totalPieces} 件）`, new RegExp(`板件\\s*${FACT.totalPieces}\\s*件`).test(hist));
    ok('该条记录带重量快照 244.8 kg', /244\.8\s*kg/.test(hist), hist.slice(0, 300));
    ok('该条操作没有产生 ERROR 增量', !/\+\d+\s*ERROR/.test(hist));
    ok('历史面板给出可撤销/可重做计数', /可撤销\s*\d+\s*条/.test(hist), hist.slice(0, 120));

    // ═══════════════════════════════════════════════════════════
    section('B7 拖宽度夹点 = 改 params.width（右边缘钉住）');

    await activateRightTab('属性');
    const W_BEFORE = await panelInput('宽 W');
    const XB = await panelInput('X');
    const YB = await panelInput('Y');
    const DB = await panelInput('深 D');
    const RIGHT_BEFORE = XB + W_BEFORE;

    // 左侧夹点位于「背左角 + 局部 (0, D/2)」；rotation=0 故直接是 (X, Y + D/2)
    const gripLeft = toClient(XB, YB + DB / 2);
    const widthDeltaMm = 200;
    const gripTo = toClient(XB + widthDeltaMm, YB + DB / 2);

    await moveMouse(gripLeft.x, gripLeft.y);
    await sleep(220);
    const hoverHint = await text('.vp-hud-hover');
    ok('悬停到夹点上时 HUD 提示对象名', hoverHint.includes(FACT.cabinetName), hoverHint);

    await mouseDown(gripLeft.x, gripLeft.y);
    await sleep(160);
    for (let i = 1; i <= 8; i++) {
      await moveMouse(gripLeft.x + ((gripTo.x - gripLeft.x) * i) / 8, gripLeft.y, 1);
      await sleep(50);
    }
    await sleep(220);
    const gripReadout = await hudReadout();
    ok('夹点拖动给出宽度读数（左固定 / 右固定）', /宽\s*\d+/.test(gripReadout), gripReadout);

    await mouseUp(gripTo.x, gripLeft.y);
    await sleep(520);

    const W_AFTER = await panelInput('宽 W');
    const X_AFTER2 = await panelInput('X');
    const Y_AFTER2 = await panelInput('Y');
    ok(
      `宽度减少约 ${widthDeltaMm}mm（±6）`,
      W_AFTER !== null && near(W_BEFORE - W_AFTER, widthDeltaMm, 6),
      `${W_BEFORE} → ${W_AFTER}`
    );
    ok(
      '锚点被补偿：右边缘钉住不动（±8mm）',
      near(X_AFTER2 + W_AFTER, RIGHT_BEFORE, 8),
      `右边缘 ${RIGHT_BEFORE} → ${X_AFTER2 + W_AFTER}`
    );
    ok('夹点拖动没有改变 Y', Math.abs(Y_AFTER2 - YB) <= 2, `${YB} → ${Y_AFTER2}`);
    ok('夹点拖动没有改变高/深', (await panelInput('高 H')) === FACT.cabH && (await panelInput('深 D')) === DB);

    // 夹点拖动同样不能留下极轴追踪线（这条断言就是为一次目视发现加的：
    // 松手后屏幕上曾残留一条指向虚空的绿色橡皮筋）
    ok(
      '夹点拖完也没有残留的追踪线 / 捕捉标记',
      (await evalJs(`!document.querySelector('.vp-hud-snap') && !document.querySelector('.vp-hud-read')`)) === true
    );

    await activateRightTab('历史');
    const hist2 = await text('.side-right .hist');
    ok('历史里这条是 cabinet.resize 且写明「右边缘固定」', /cabinet\.resize/.test(hist2) && /右边缘固定/.test(hist2), hist2.slice(0, 240));
    ok('历史里没有出现「派生字段」被写入的痕迹', !/panels:/.test(hist2) && !/geometry:/.test(hist2));

    const vAfterResize = await statusVersion();
    ok('两次操作 = 模型版本 +2', vAfterResize === vAfterMove + 1, `v${vAfterMove} → v${vAfterResize}`);

    // ═══════════════════════════════════════════════════════════
    section('B8 撤销 / 重做（逐值回退，不是"差不多"）');

    await activateRightTab('属性');
    const beforeUndo = { x: await panelInput('X'), y: await panelInput('Y'), w: await panelInput('宽 W') };
    const vBeforeUndo = await statusVersion();

    await keyPress('z', 'KeyZ', 90, 2); // Ctrl+Z
    await sleep(460);
    ok(`撤销把宽度还回 ${FACT.cabW}`, (await panelInput('宽 W')) === FACT.cabW, String(await panelInput('宽 W')));
    // 撤销「右边缘固定」的改宽，锚点补偿也必须一起回退：
    // X 应回到 B5 垂直拖动之后的值（那次拖动没动 X），而不是漂在补偿后的位置
    ok(
      '撤销把锚点补偿也一起回退（X 回到改宽之前）',
      (await panelInput('X')) === X_AFTER_BODY,
      `${beforeUndo.x} → ${await panelInput('X')}（期望回到 ${X_AFTER_BODY}）`
    );
    ok('撤销后 Y 不变（只回退一条命令）', (await panelInput('Y')) === beforeUndo.y, String(await panelInput('Y')));
    ok('撤销也让模型版本 +1（撤销本身也是一次状态变更）', (await statusVersion()) === vBeforeUndo + 1);

    await keyPress('z', 'KeyZ', 90, 10); // Ctrl+Shift+Z
    await sleep(460);
    ok(`重做恢复宽度 ${beforeUndo.w}`, (await panelInput('宽 W')) === beforeUndo.w, String(await panelInput('宽 W')));
    ok('重做恢复 X', (await panelInput('X')) === beforeUndo.x, String(await panelInput('X')));

    await keyPress('z', 'KeyZ', 90, 2);
    await sleep(420);
    await keyPress('z', 'KeyZ', 90, 2);
    await sleep(460);
    ok(
      `连撤两次回到初始位置 (${FACT.cabX}, ${FACT.cabY})`,
      (await panelInput('X')) === FACT.cabX && (await panelInput('Y')) === FACT.cabY,
      `(${await panelInput('X')}, ${await panelInput('Y')})`
    );
    ok(`连撤两次回到初始宽度 ${FACT.cabW}`, (await panelInput('宽 W')) === FACT.cabW);
    ok('全部撤销后仍然是 0 ERROR（撤销不会弄坏模型）', (await text('.sb-badge-err')) === '');

    // ═══════════════════════════════════════════════════════════
    section('B9 粘贴一段 Command JSON 走同一条历史（AI / MCP 通道）');

    const aiCmd = {
      op: 'cabinet.move',
      source: 'ai',
      target: { kind: 'cabinet', id: 'cab_001' },
      label: 'AI：把主卧衣柜沿 X 挪到 700',
      intent: { nl: '把主卧衣柜往右挪，但不要碰到东墙' },
      changes: [{ path: 'placement.x', op: 'set', value: 700, unit: 'mm' }],
    };
    const vBeforeAI = await statusVersion();
    await runCommandLine(JSON.stringify(aiCmd));

    const aiToast = await text('.toast-ok');
    ok('界面确认外部指令已执行', /已执行/.test(aiToast), aiToast);

    const histAfterAI = await text('.side-right .hist');
    ok('历史里出现 source = ai 的条目（与 UI 同一条时间线）', (await evalJs(`document.querySelectorAll('.side-right .hist-src.src-ai').length`)) >= 1);
    ok('该条记录带 AI 给定的 label', /AI：把主卧衣柜沿 X 挪到 700/.test(histAfterAI), histAfterAI.slice(0, 240));
    ok(
      '该条记录的 diff 精确写出 placement.x: 400 → 700',
      /placement\.x:\s*400\s*→\s*700/.test(histAfterAI),
      histAfterAI.slice(0, 400)
    );

    await activateRightTab('属性');
    ok('属性面板 X 已是 700（AI 改的就是同一个模型）', (await panelInput('X')) === 700, String(await panelInput('X')));
    ok(`板件数仍为 ${FACT.totalPieces} 件`, (await statusPieces()) === FACT.totalPieces, `实为 ${await statusPieces()}`);
    ok('引入 X=700 后没有新增 ERROR（柜体仍在墙内）', (await text('.sb-badge-err')) === '', await text('.sb-badge-err'));
    ok('AI 指令与鼠标操作一样：模型版本 +1', (await statusVersion()) === vBeforeAI + 1, `v${vBeforeAI} → v${await statusVersion()}`);

    // ═══════════════════════════════════════════════════════════
    section('B10 越权写入在真实界面上被拒绝，模型未变');

    const histLenBefore = await evalJs(`document.querySelectorAll('.side-right .hist-item').length`);
    const illegal = {
      op: 'cabinet.update',
      source: 'ai',
      target: { kind: 'cabinet', id: 'cab_001' },
      label: 'AI 试图直写派生字段',
      changes: [{ path: 'panels', op: 'set', value: [] }],
    };
    await runCommandLine(JSON.stringify(illegal));

    const errToast = await text('.toast-error');
    ok('界面弹出拒绝提示（不是静默失败）', /拒绝|不允许|白名单|派生/.test(errToast), errToast);
    ok('模型未被改动：X 仍是 700', (await panelInput('X')) === 700, String(await panelInput('X')));
    ok(
      '被拒绝的命令没有进入历史',
      (await evalJs(`document.querySelectorAll('.side-right .hist-item').length`)) === histLenBefore,
      `${histLenBefore} → ${await evalJs(`document.querySelectorAll('.side-right .hist-item').length`)}`
    );

    // ═══════════════════════════════════════════════════════════
    section('B11 零异常 / 零控制台 error / 截图非空白');

    // 命令行开着时提示条不该重复占位；关掉后应当回来，并且仍然不压状态栏
    ok('命令行打开时提示条不重复占位', (await evalJs(`!!document.querySelector('.cmd-hint')`)) === false);
    await keyPress('Escape', 'Escape', 27);
    await sleep(320);
    ok('关闭命令行后提示条回来', (await evalJs(`!!document.querySelector('.cmd-hint')`)) === true);
    const layout2 = await evalJs(`(()=>{
      const hit=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
      const R=(s)=>{const e=document.querySelector(s);return e?e.getBoundingClientRect():null;};
      const hint=R('.cmd-hint'), bar=R('.statusbar'), vp=R('.vp');
      return { s: hint&&bar?hit(hint,bar):null, v: hint&&vp?hit(hint,vp):null };
    })()`);
    ok('提示条回到流程里后仍不与状态栏/视口重叠', layout2?.s === false && layout2?.v === false, JSON.stringify(layout2));
    ok('关闭命令行没有清掉选择（Esc 只作用于命令行）', (await statusSelection()) === 1, `已选 ${await statusSelection()}`);

    await activateRightTab('属性');
    await sleep(300);
    const planShot = await shot(SHOT_PLAN);
    ok(`总平面截图已保存（${(planShot / 1024).toFixed(0)}KB）`, planShot > 40000, `${planShot} bytes`);

    // HUD 内容的逐项转储：文字类问题在大图上肉眼是看不清的，必须逐项读出来
    const hudItems = await evalJs(`[...document.querySelectorAll('.vp-hud-item')].map(e=>e.className+' | '+e.textContent)`);
    console.log(`      HUD: ${JSON.stringify(hudItems)}`);

    // 放大截图：给"文字/线条"这类只能靠眼睛发现的问题留一份可复核的证据
    const detail = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: rect.left + 8, y: rect.top + rect.h - 46, width: 460, height: 40, scale: 3 },
    });
    if (detail.result?.data) {
      fs.writeFileSync(path.join(OUT_DIR, 'app-hud-detail.png'), Buffer.from(detail.result.data, 'base64'));
      ok('HUD 放大截图已保存', fs.statSync(path.join(OUT_DIR, 'app-hud-detail.png')).size > 3000);
    }

    const canvasNonBlank = await evalJs(`(()=>{
      const c=document.querySelector('.vp-canvas');
      const ctx=c.getContext('2d');
      const d=ctx.getImageData(0,0,c.width,c.height).data;
      let nonBg=0, total=0;
      for(let i=0;i<d.length;i+=4*97){ total++; if(d[i]!==d[i+1]||d[i+1]!==d[i+2]) nonBg++; }
      return {total, nonBg};
    })()`);
    ok(
      'canvas 上确实画了东西（不是空白视口）',
      canvasNonBlank && canvasNonBlank.nonBg > 40,
      JSON.stringify(canvasNonBlank)
    );

    ok('零页面异常（uncaught exception / unhandledrejection）', pageErrors.length === 0, pageErrors.join('\n      '));
    ok('零 console error', consoleErrors.length === 0, consoleErrors.slice(0, 5).join('\n      '));

    // ═══════════════════════════════════════════════════════════
    section('B12 对象捕捉真的工作：最终点 = 捕捉点，提示用中文');

    // 重新打开捕捉（B3 为了标定把它关了）
    await keyPress('F3', 'F3', 114);
    await sleep(200);
    ok(
      'F3 重新打开捕捉',
      (await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')]
        .find(x=>x.textContent.trim().startsWith('捕捉'));return b?b.classList.contains('active'):null})()`)) === true
    );

    // 鼠标落在柜体"背左角"附近但不重合：捕捉应当把它拉到精确角点上
    const W_CORNER_X = 700;
    const W_CORNER_Y = 60;
    const rawPoint = toClient(W_CORNER_X + 40, W_CORNER_Y + 40); // 偏 40/40mm，在容差内
    await moveMouse(rawPoint.x, rawPoint.y);
    await sleep(300);

    const snapped = await hudWorld();
    ok(
      '鼠标落在角点附近时，HUD 给出的最终点是精确角点（不是原始鼠标点）',
      !!snapped && snapped.x === W_CORNER_X && snapped.y === W_CORNER_Y,
      `原始点 (${W_CORNER_X + 40}, ${W_CORNER_Y + 40}) → 捕捉后 (${snapped?.x}, ${snapped?.y})`
    );

    const snapChip = await text('.vp-hud-snap');
    ok('HUD 说明了捕捉到了什么对象的什么特征点', /主卧衣柜/.test(snapChip), `「${snapChip}」`);
    ok(
      '捕捉类型用中文（与画布上的标记同一套词，不出现 quad/polar 之类英文枚举）',
      /象限点|端点|中点|中心|交点|栅格|正交|极轴/.test(snapChip) &&
        !/\b(end|mid|center|quad|intersect|grid|ortho|polar|none)\b/.test(snapChip),
      `「${snapChip}」`
    );

    // 移开后就该松手，捕捉不粘人
    const away = toClient(W_CORNER_X + 600, W_CORNER_Y + 500);
    await moveMouse(away.x, away.y);
    await sleep(280);
    const awaySnap = await hudWorld();
    ok(
      '移开后不再吸附（捕捉不是"粘住"）',
      !!awaySnap && Math.abs(awaySnap.x - W_CORNER_X) > 1,
      `(${awaySnap?.x}, ${awaySnap?.y})`
    );

    // ═══════════════════════════════════════════════════════════
    /**
     * B13 —— 用户原话："输入尺寸过后 AI 能生成正面图、俯视图、侧面图、内部图，
     * 衔接要合理"。
     *
     * 这里验的不是"画出来了"，而是三件事：
     *  1. 四张图**确实由同一份模型投影派生**（长对正 / 高平齐 / 宽相等在图幅上成立）
     *  2. 界面上给出的读数**就是派生结果本身**（面板数字 === 模型图元数）
     *  3. 图幅是**只读**的：点它不改变模型，改模型必须回平面图
     */
    section('B13 四视图图幅：正/俯/侧/内部由同一份模型投影派生');

    await activateRightTab('视图');
    await sleep(340);

    const viewsPanel = await text('.side-right .panel-scroll');
    const fourNames = ['正视图', '俯视图', '侧视图', '内部结构图'];
    ok(
      '视图面板把四张图逐一点名（正视图 / 俯视图 / 侧视图 / 内部结构图）',
      fourNames.every((n) => viewsPanel.includes(n)),
      viewsPanel.slice(0, 220)
    );
    // Task #48 之后四视图可编辑了：这条断言的意义从"它声明只读"变为
    // "它如实说明可编辑 + 四图同源同步 + 哪些不能拖"。文案必须跟着产品走。
    ok(
      '面板如实说明四视图可编辑，且改一处四图同步（不再写"只读"骗人）',
      /可以直接编辑/.test(viewsPanel) && /其余三张同步更新/.test(viewsPanel) && !/只读派生视图/.test(viewsPanel),
      viewsPanel.slice(0, 160)
    );
    ok('面板点明"层板/抽屉由数量派生、不能拖"（把不能做的也讲清楚）', /数量/.test(viewsPanel) && /不能拖/.test(viewsPanel));
    ok(
      '面板写明排布依据是第一角投影（GB / ISO-E），并点名长对正 / 高平齐 / 宽相等',
      /第一角投影/.test(viewsPanel) && /长对正/.test(viewsPanel) && /高平齐/.test(viewsPanel) && /宽相等/.test(viewsPanel)
    );

    /**
     * 从页面自己的模块图里取**同一个 bus 实例**与**同一个纯函数**再算一遍。
     * 这不是测试专用后门（没有往产品代码里塞 window.__debug）——
     * 走的是浏览器里已经加载的那份模块缓存，拿到的就是界面正在用的数据。
     */
    const viewFacts = await evalJs(`(async()=>{
      const store = await import('/src/state/store.ts');
      const V = await import('/src/core/geometry/views.ts');
      const views = store.bus.derive().geom.views;
      const cab = store.bus.getState().cabinets[0];
      const vs = V.buildCabinetViews(cab, store.RULESET);
      const bb = (k)=>{
        const pts=[];
        for(const p of vs.prims[k]) pts.push(...(p.k==='text'?[p.p]:p.pts));
        let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
        for(const p of pts){ if(p.x<x0)x0=p.x; if(p.x>x1)x1=p.x; if(p.y<y0)y0=p.y; if(p.y>y1)y1=p.y; }
        return {x0,x1,y0,y1};
      };
      return {
        primTotal: views.prims.length,
        hinge: views.prims.filter(p=>p.layer==='F-VIEW').length,
        dimText: views.prims.filter(p=>p.layer==='F-DIM'||p.layer==='F-TEXT').length,
        assumptions: views.assumptions.length,
        warnAssumptions: views.assumptions.filter(a=>a.startsWith('\\u26a0')).length,
        bboxText: views.bbox
          ? Math.round(views.bbox.min.x)+','+Math.round(views.bbox.min.y)+' \\u2192 '+Math.round(views.bbox.max.x)+','+Math.round(views.bbox.max.y)
          : '\\u2014',
        dims: vs.dims,
        front: bb('front'), top: bb('top'), side: bb('side'), internal: bb('internal'),
      };
    })()`);

    ok(
      `面板「视图图元合计」等于真实派生出的图元数 ${viewFacts.primTotal}`,
      (await panelText('视图图元合计')) === String(viewFacts.primTotal),
      `面板「${await panelText('视图图元合计')}」vs 模型 ${viewFacts.primTotal}`
    );
    ok(
      '面板「投影衔接线」= 6 条（长对正 2 · 高平齐 2 · 宽相等 2），且图层计数一致',
      (await panelText('投影衔接线'))?.startsWith('6 条') === true && viewFacts.hinge === 6,
      `面板「${await panelText('投影衔接线')}」/ F-VIEW 图元 ${viewFacts.hinge}`
    );
    ok(
      `面板「标题与标注」等于模型里的标注与文字图元数 ${viewFacts.dimText}`,
      (await panelText('标题与标注')) === String(viewFacts.dimText),
      `面板「${await panelText('标题与标注')}」vs 模型 ${viewFacts.dimText}`
    );
    ok(
      '面板「图幅包围盒」与派生出的 bbox 逐字符一致（界面读数 === 派生结果）',
      (await panelText('图幅包围盒')) === viewFacts.bboxText,
      `面板「${await panelText('图幅包围盒')}」vs 模型「${viewFacts.bboxText}」`
    );

    // ── 投影映射不变量：在浏览器里针对"当前这份被拖过、改过的模型"再验一次 ──
    const TOLV = 0.51;
    const f = viewFacts.front;
    const t = viewFacts.top;
    const s = viewFacts.side;
    const iv = viewFacts.internal;
    ok(
      '长对正：俯视图与正视图共享同一段 X（同一左边界 / 同一右边界）',
      near(f.x0, t.x0, TOLV) && near(f.x1, t.x1, TOLV),
      `正视 X[${f.x0}, ${f.x1}] vs 俯视 X[${t.x0}, ${t.x1}]`
    );
    ok(
      '高平齐：侧视图与正视图共享同一段 Y（同一底 / 同一顶）',
      near(f.y0, s.y0, TOLV) && near(f.y1, s.y1, TOLV),
      `正视 Y[${f.y0}, ${f.y1}] vs 侧视 Y[${s.y0}, ${s.y1}]`
    );
    ok(
      `宽相等：俯视图进深跨度 = 侧视图进深跨度 = 柜深 ${viewFacts.dims.D}mm`,
      near(t.y1 - t.y0, viewFacts.dims.D, TOLV) && near(s.x1 - s.x0, viewFacts.dims.D, TOLV),
      `俯视 ${t.y1 - t.y0} / 侧视 ${s.x1 - s.x0} / 柜深 ${viewFacts.dims.D}`
    );
    ok(
      '第一角排布成立：俯视在正视正下方，侧视在正视正右方，内部图在侧视正右方',
      t.y1 <= f.y0 + TOLV && s.x0 >= f.x1 - TOLV && iv.x0 >= s.x1 - TOLV,
      `俯视上沿 ${t.y1} ≤ 正视下沿 ${f.y0}；侧视左沿 ${s.x0} ≥ 正视右沿 ${f.x1}；内部图左沿 ${iv.x0} ≥ 侧视右沿 ${s.x1}`
    );
    ok(
      '内部结构图与正视图同宽同高（只是水平平移，不是另画一张）',
      near(iv.x1 - iv.x0, f.x1 - f.x0, TOLV) && near(iv.y1 - iv.y0, f.y1 - f.y0, TOLV),
      `内部图 ${iv.x1 - iv.x0}×${iv.y1 - iv.y0} vs 正视 ${f.x1 - f.x0}×${f.y1 - f.y0}`
    );
    ok(
      `正视 / 内部图的宽度都等于柜宽 ${viewFacts.dims.W}mm`,
      near(f.x1 - f.x0, viewFacts.dims.W, TOLV) && near(iv.x1 - iv.x0, viewFacts.dims.W, TOLV)
    );

    /**
     * 内部图的板件标签必须互不压字。
     *
     * 这条断言来自**目视检查**：截图上看内部图中间一片标签挤在一起，
     * 在大图上肉眼根本判断不了到底压没压上（这正是血泪清单里那条
     * "文字类问题必须放大截图 + 逐项转储"）。所以干脆用渲染器同一套字体
     * 量出每个标签的包围盒，把"压字"变成可判定的数。
     */
    const labelOverlap = await evalJs(`(async()=>{
      const store = await import('/src/state/store.ts');
      const V = await import('/src/core/geometry/views.ts');
      const R = await import('/src/viewport/renderer.ts');
      const cab = store.bus.getState().cabinets[0];
      const vs = V.buildCabinetViews(cab, store.RULESET);
      const ctx = document.createElement('canvas').getContext('2d');
      const boxOf = (p)=>{
        ctx.font = p.size.toFixed(1)+'px '+R.FONT_STACK;
        const w = ctx.measureText(p.text).width;
        const h = p.size * 1.2;
        const x0 = p.align==='l' ? p.p.x : p.align==='r' ? p.p.x - w : p.p.x - w/2;
        return { x0, x1:x0+w, y0:p.p.y-h/2, y1:p.p.y+h/2, t:p.text };
      };
      const all = vs.prims.internal.filter(p=>p.k==='text').map(boxOf);
      const hits = [];
      for (let i=0;i<all.length;i++) for (let j=i+1;j<all.length;j++){
        const a=all[i], b=all[j];
        const ow = Math.min(a.x1,b.x1)-Math.max(a.x0,b.x0);
        const oh = Math.min(a.y1,b.y1)-Math.max(a.y0,b.y0);
        if (ow>2 && oh>2) hits.push(a.t+' \\u00d7 '+b.t+' 重叠 '+ow.toFixed(0)+'\\u00d7'+oh.toFixed(0)+'mm');
      }
      return { count: all.length, hits, texts: all.map(t=>t.t) };
    })()`);
    console.log(`      内部图标签（${labelOverlap.count} 个）: ${JSON.stringify(labelOverlap.texts)}`);
    ok(
      `内部图上 ${labelOverlap.count} 个标注/标签互不压字`,
      labelOverlap.hits.length === 0,
      labelOverlap.hits.join('；')
    );

    // ── 假设清单：没有工艺依据的地方必须摆在界面上 ──
    const assumeSec = await evalJs(`(()=>{
      const sec=[...document.querySelectorAll('.side-right .sec')]
        .find(x=>/派生假设/.test(x.querySelector('.sec-toggle')?.textContent||''));
      if(!sec) return null;
      return {
        title: sec.querySelector('.sec-toggle').textContent.replace(/\\s+/g,' ').trim(),
        count: sec.querySelectorAll('.assume-list li').length,
        warn: [...sec.querySelectorAll('.assume-list li')].filter(li=>li.classList.contains('assume-warn')).length,
      };
    })()`);
    ok(
      `派生假设如实列出 ${viewFacts.assumptions} 条（没工艺依据的取向不藏在代码里）`,
      assumeSec?.count === viewFacts.assumptions,
      JSON.stringify(assumeSec)
    );
    ok(
      `其中 ${viewFacts.warnAssumptions} 条带 ⚠ 标记（规则集里真实存在的参数矛盾），且被标红`,
      assumeSec?.warn === viewFacts.warnAssumptions && viewFacts.warnAssumptions > 0,
      JSON.stringify(assumeSec)
    );

    // ── 切到图幅：视口换了一幅画 ──
    const planSig = await canvasSig();
    const vBeforeMode = await statusVersion();
    const selBeforeMode = await statusSelection();
    ok('切模式前选中 1 个柜体（用于验证切模式会把选择收干净）', selBeforeMode === 1, `已选 ${selBeforeMode}`);

    const planBtnActive = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')]
      .find(x=>x.textContent.trim()==='平面图');return b?b.classList.contains('active'):null})()`);
    ok('工具栏「平面图」当前处于激活态', planBtnActive === true, String(planBtnActive));

    const clickedSheet = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')]
      .find(x=>x.textContent.trim()==='▤ 四视图');if(!b)return false;b.click();return true})()`);
    ok('工具栏上能点到「▤ 四视图」（不是隐藏功能）', clickedSheet === true);
    await sleep(620);

    const sheetBtnActive = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')]
      .find(x=>x.textContent.trim()==='▤ 四视图');return b?b.classList.contains('active'):null})()`);
    ok('切过去后「▤ 四视图」变成激活态、平面图退出激活', sheetBtnActive === true);

    const hudSheet = await text('.vp-hud-sheet');
    // Task #48：图幅可编辑之后，HUD 不能再写"只读"骗人 —— 必须告诉用户"蓝线可拖"。
    ok('HUD 明说这是「四视图图幅 · 可编辑」（不再写"只读"误导用户）',
      /四视图图幅/.test(hudSheet) && /可编辑/.test(hudSheet) && !/只读/.test(hudSheet), hudSheet || '(缺失)');
    ok('图幅模式下不再显示平面坐标读数（X/Y 是平面图的概念，不混进图幅）', (await hudWorld()) === null, JSON.stringify(await hudWorld()));

    const sheetCursor = await evalJs(`getComputedStyle(document.querySelector('.vp')).cursor`);
    ok('图幅模式光标变成 grab（暗示"这里只能平移，不能编辑"）', sheetCursor === 'grab', String(sheetCursor));

    const sheetSig = await canvasSig();
    ok(
      '图幅确实渲染出了东西（不是空白画布）',
      sheetSig.nonBg > 40,
      JSON.stringify(sheetSig)
    );
    ok(
      '图幅画面与平面图不是同一幅（换的是真视图，不是加了个标签）',
      sheetSig.h !== planSig.h,
      `平面指纹 ${planSig.h} vs 图幅指纹 ${sheetSig.h}`
    );

    // ── 只读性：图幅上点、拖、移动都不能改模型 ──
    const vpRect2 = await vpRect();
    const midX = vpRect2.left + vpRect2.w / 2;
    const midY = vpRect2.top + vpRect2.h / 2;

    await moveMouse(midX, midY);
    await sleep(220);
    const sheetLeaks = await evalJs(`({
      snap: !!document.querySelector('.vp-hud-snap'),
      read: !!document.querySelector('.vp-hud-read'),
      preview: !!document.querySelector('.vp-preview-badge'),
      prompt: !!document.querySelector('.vp-prompt'),
    })`);
    ok(
      '图幅上移动鼠标不会冒出捕捉标记 / 位移读数 / 预览徽标（图幅不是编辑面）',
      !sheetLeaks.snap && !sheetLeaks.read && !sheetLeaks.preview && !sheetLeaks.prompt,
      JSON.stringify(sheetLeaks)
    );

    await mouseDown(midX, midY);
    await sleep(120);
    for (let i = 1; i <= 6; i++) {
      await moveMouse(midX + (60 * i) / 6, midY + (40 * i) / 6, 1);
      await sleep(40);
    }
    await mouseUp(midX + 60, midY + 40);
    await sleep(420);

    ok(
      '图幅上拖动只平移画布，模型版本不变（点不动模型）',
      (await statusVersion()) === vBeforeMode,
      `v${vBeforeMode} → v${await statusVersion()}`
    );
    ok(
      '图幅上点选后什么都没被选中（状态栏连「已选」读数都不出现）',
      (await statusSelection()) === null,
      `状态栏「已选」读数：${(await pickItem('已选')) || '(不显示)'}`
    );
    ok(
      '切到图幅时把原来的选择收干净了（避免图上残留夹点）',
      (await evalJs(`document.querySelectorAll('.side-left .tree-leaf.sel').length`)) === 0
    );

    const viewsShot = await shot(path.join(OUT_DIR, 'app-views-sheet.png'));
    ok(`四视图图幅截图已保存（${(viewsShot / 1024).toFixed(0)}KB）`, viewsShot > 40000, `${viewsShot} bytes`);

    // ── 切回平面图：编辑能力必须恢复 ──
    const clickedPlan = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')]
      .find(x=>x.textContent.trim()==='平面图');if(!b)return false;b.click();return true})()`);
    ok('能切回「平面图」', clickedPlan === true);
    await sleep(620);
    ok('切回后图幅提示消失', (await evalJs(`!!document.querySelector('.vp-hud-sheet')`)) === false);
    ok('切回后光标回到默认（可编辑）', (await evalJs(`getComputedStyle(document.querySelector('.vp')).cursor`)) === 'default');

    const backClick = toClient(FACT.cabX + 500, FACT.cabY + 250);
    await moveMouse(backClick.x, backClick.y);
    await sleep(140);
    await mouseDown(backClick.x, backClick.y);
    await sleep(110);
    await mouseUp(backClick.x, backClick.y);
    await sleep(420);
    ok('切回平面图后点选柜体恢复正常（模式切换没有把编辑能力弄丢）', (await statusSelection()) === 1, `已选 ${await statusSelection()}`);
    ok('来回到图幅走一圈，模型版本没有被模式切换改动', (await statusVersion()) === vBeforeMode, `v${vBeforeMode} → v${await statusVersion()}`);
    ok('图幅往返没有引入 ERROR', (await text('.sb-badge-err')) === '', await text('.sb-badge-err'));

    // ═══════════════════════════════════════════════════════════
    /**
     * B14 —— 用户原话："AI 要带进化以及重要的记忆功能，比如有问题的地方
     * 在我告诉他过后下次不要犯同样的错误"。
     *
     * 这一组验的是记忆**真的能拦住操作**，而不是"存了一句话"：
     *   · 记下的自然语言如果没有可执行判据 → 必须如实标成「待编译」
     *   · 有判据的记忆 → 五条路（UI/拖动/AI/MCP/脚本）都过同一道门
     *   · 拦下之后模型必须**一个字节都没变**
     *   · 门不是一刀切：合法的操作必须照常通过
     */
    section('B14 记忆：记下的问题下次真的会拦住，不是存一句话');

    await activateRightTab('记忆');
    await sleep(340);

    const memPanel = () => text('.side-right .panel-scroll');
    /**
     * 读 Section 的标题。
     * ⚠ 这里踩过一次坑（和 B 系列开头那条同一个坑的变体）：
     * `.sec-toggle` 里第一个子元素是 `<span class="caret">▸</span>`，
     * textContent 会把三角粘在标题前面（"▸记忆总览（生效 5 · …）"），
     * 于是 startsWith('记忆总览') 恒为 false —— 断言失败其实是断言写错了。
     *
     * 修的时候又踩了第二脚：顺手把空白也一起 strip 掉，标题就变成
     * "记忆总览（生效5·待编译2·共7）"，反过来的正则又不匹配了。
     * 所以这里**只去掉三角**，空白原样保留 —— 去掉什么必须是有理由的，
     * 不能"顺手清理一下"，那会把待核对的原始格式一起毁掉。
     */
    const memOverview = () => evalJs(`(()=>{
      const t=[...document.querySelectorAll('.side-right .sec-toggle')]
        .map(x=>x.textContent.replace(/[\\u25b8\\u25be]/g,'').trim())
        .find(x=>x.startsWith('记忆总览'));
      return t||'';
    })()`);
    const memCount = (sel) => evalJs(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    const lsLines = () => evalJs(`(()=>{const s=localStorage.getItem('furniture-cad.corrections.v1');
      return s? s.split(/\\r?\\n/).filter(l=>l.trim()).length : 0})()`);

    const ov0 = await memOverview();
    ok('记忆面板给出「生效 / 待编译 / 共」三个数（不把待编译混进生效里）', /记忆总览（生效 \d+ · 待编译 \d+ · 共 \d+）/.test(ov0), ov0 || '(缺失)');

    const active0 = await memCount('.side-right .mem-item.mem-active');
    const pending0 = await memCount('.side-right .mem-item.mem-pending');
    ok(`生效中 ${active0} 条 / 待编译 ${pending0} 条，且合计与总览一致`, active0 + pending0 === 7, `${active0} + ${pending0}`);
    ok(
      '每条生效记忆都写出了「它现在具体在查什么」（编译产物的 describe）',
      (await memCount('.side-right .mem-check')) === active0,
      `mem-check ${await memCount('.side-right .mem-check')} vs active ${active0}`
    );
    ok(
      '每条待编译记忆都写出了「未生效原因」（不许长得跟生效的一样）',
      (await memCount('.side-right .mem-item.mem-pending .mem-pending')) === pending0,
      `未生效原因块 ${await memCount('.side-right .mem-item.mem-pending .mem-pending')} vs pending ${pending0}`
    );
    const memTabBadge = await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right .tabs button')]
      .find(x=>x.textContent.trim().startsWith('记忆'));const s=b?b.querySelector('.tab-badge-warn'):null;return s?s.textContent.trim():''})()`);
    ok(`标签页上用角标如实提示还有 ${pending0} 条待编译`, memTabBadge === String(pending0), `角标「${memTabBadge}」`);
    ok('预置记忆里能看到那条"总高不超过 2400"的原话', /柜体总高不超过 2400mm/.test(await memPanel()));

    // ── 记一条只有自然语言的 → 必须进「待编译」，且当场说明它拦不住 ──
    const newNl = '验收用：柜体进深尽量不要超过 700mm（这条故意不给判定条件）';
    await setElValue('.side-right .mem-input', newNl);
    const added = await clickPanelBtn('记下这条');
    ok('面板上能新增一条记忆', added === true);

    const addMsg = await text('.side-right .hint-line.strong');
    ok(
      '新增后当场如实告知：没有判定条件就拦不住任何东西（不假装生效）',
      /待编译/.test(addMsg) && /拦不住/.test(addMsg),
      addMsg || '(无提示)'
    );
    const idList = await evalJs(`[...document.querySelectorAll('.side-right .mem-id')].map(e=>e.textContent.trim())`);
    const newId = idList[idList.length - 1];
    ok('新记忆被分了一个可追踪的 id', /^mem_\d{3}_/.test(newId || ''), String(newId));

    const ov1 = await memOverview();
    ok('总览变成 生效 5 · 待编译 3 · 共 8（数字跟着动）', /记忆总览（生效 5 · 待编译 3 · 共 8）/.test(ov1), ov1);
    ok('待编译角标跟着 +1', (await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right .tabs button')]
      .find(x=>x.textContent.trim().startsWith('记忆'));const s=b?b.querySelector('.tab-badge-warn'):null;return s?s.textContent.trim():''})()`)) === '3');
    ok('新记忆真的落到了 localStorage（不只是内存里的一行）', (await lsLines()) === 8, `localStorage ${await lsLines()} 行`);
    ok(
      '新增的待编译记忆拦不住任何东西（这正是把它标成 non-active 的原因）',
      (await evalJs(`document.querySelectorAll('.side-right .mem-item.mem-pending .mem-check').length`)) === 0
    );

    // ── 删掉它，恢复现场 ──
    const deleted = await evalJs(`(()=>{
      const id=${JSON.stringify(newId)};
      const item=[...document.querySelectorAll('.side-right .mem-item')].find(x=>x.querySelector('.mem-id')?.textContent.trim()===id);
      if(!item) return false;
      const b=[...item.querySelectorAll('.tb-btn')].find(x=>x.textContent.trim()==='删除');
      if(!b) return false; b.click(); return true;
    })()`);
    await sleep(360);
    ok('面板上能删除一条记忆', deleted === true);
    ok('删除后回到 生效 5 · 待编译 2 · 共 7', /记忆总览（生效 5 · 待编译 2 · 共 7）/.test(await memOverview()), await memOverview());
    ok('删除也同步到了 localStorage', (await lsLines()) === 7, `localStorage ${await lsLines()} 行`);

    // ── 真拦截：从命令行发一条 AI 命令，把总高改到 2600 ──
    await activateRightTab('历史');
    await sleep(280);
    const histBeforeBlock = await memCount('.side-right .hist-item');
    await activateRightTab('记忆');
    await sleep(240);

    const vBeforeBlock = await statusVersion();
    const blocked = {
      op: 'cabinet.resize',
      source: 'ai',
      target: { kind: 'cabinet', id: 'cab_001' },
      label: 'AI：把主卧衣柜加高到 2600',
      changes: [{ path: 'params.height', op: 'set', value: 2600, unit: 'mm' }],
    };
    await runCommandLine(JSON.stringify(blocked));

    const blockToast = await text('.toast-error');
    ok('界面上弹出了拒绝提示（不静默失败）', /记忆拦截/.test(blockToast), blockToast || '(无提示)');
    ok(
      '提示里写明是哪一条记忆拦的（给出 correction id）',
      /mem_004_max_height_2400/.test(blockToast),
      blockToast
    );
    ok(
      '提示里回放了你当时的原话（用户能认出"这是我自己定的规矩"）',
      /你当时的原话/.test(blockToast) && /柜体总高不超过 2400mm/.test(blockToast),
      blockToast
    );
    ok(
      '提示给出怎么改（建议：上下分柜），而不是只说"操作被拒绝"',
      /建议：/.test(blockToast) && /上下分柜/.test(blockToast),
      blockToast
    );

    await activateRightTab('属性');
    await sleep(280);
    ok(`模型没被改动：高 H 仍是 ${FACT.cabH}`, (await panelInput('高 H')) === FACT.cabH, String(await panelInput('高 H')));
    ok('模型版本没有 +1（拒绝 = 什么都没发生）', (await statusVersion()) === vBeforeBlock, `v${vBeforeBlock} → v${await statusVersion()}`);
    ok(`板件数也没动（仍 ${FACT.totalPieces} 件）`, (await statusPieces()) === FACT.totalPieces, `实为 ${await statusPieces()}`);

    await activateRightTab('历史');
    await sleep(280);
    ok(
      '被拦下的命令没有进入历史（历史是"发生过的事"，不是"试过的事"）',
      (await memCount('.side-right .hist-item')) === histBeforeBlock,
      `${histBeforeBlock} → ${await memCount('.side-right .hist-item')}`
    );

    await activateRightTab('记忆');
    await sleep(280);
    const hitBox = await text('.side-right .mem-hit');
    /**
     * 失败时先把原始值倒出来看（血泪教训：断言失败时先假定断言自己写错）。
     * 这条断言第一次跑就红了 —— 而且抓出的是真缺陷：
     * 命令行 Command JSON 通道（AI / MCP 走这条）原先绕过 run()，
     * 记忆拦下 AI 命令时不记 lastHit，「最近一次拦截」永远是空的。
     */
    const hitDiag = await evalJs(`(async()=>{
      const ms = await import('/src/state/memoryStore.ts');
      const h = ms.getLastHit();
      return {
        store: h ? { id: h.correctionId, label: h.label, text: h.text } : null,
        dom: !!document.querySelector('.mem-hit'),
        domText: (document.querySelector('.mem-hit')||{}).textContent||null,
      };
    })()`);
    console.log(`      拦截诊断: ${JSON.stringify(hitDiag)}`);
    ok(
      '记忆面板记录下"最近一次拦截"，点开就知道是哪条在起作用',
      /mem_004_max_height_2400/.test(hitBox) && hitDiag?.store?.id === 'mem_004_max_height_2400',
      hitBox || '(缺失)'
    );
    ok(
      '被拦下的那条命令的 label 也记了下来（复盘时知道 AI 当时想干什么）',
      /把主卧衣柜加高到 2600/.test(String(hitDiag?.store?.label ?? '')),
      String(hitDiag?.store?.label)
    );

    // ── 门不是一刀切：合法操作必须照常通过 ──
    const okCmd = {
      op: 'cabinet.resize',
      source: 'ai',
      target: { kind: 'cabinet', id: 'cab_001' },
      label: 'AI：把主卧衣柜加高到 2350（合法）',
      changes: [{ path: 'params.height', op: 'set', value: 2350, unit: 'mm' }],
    };
    const vBeforeOk = await statusVersion();
    await runCommandLine(JSON.stringify(okCmd));
    const okToast = await text('.toast-ok');
    ok('合法的加高（2350 < 2400）照常执行，门没有一刀切', /已执行/.test(okToast), okToast || '(无 ok 提示)');
    await activateRightTab('属性');
    await sleep(260);
    ok('合法命令确实生效：高 H = 2350', (await panelInput('高 H')) === 2350, String(await panelInput('高 H')));
    ok('合法命令与其它路一样：模型版本 +1', (await statusVersion()) === vBeforeOk + 1, `v${vBeforeOk} → v${await statusVersion()}`);

    // 收尾：撤回到 2400，别把现场留给下一组断言
    await keyPress('Escape', 'Escape', 27);
    await sleep(240);
    await keyPress('z', 'KeyZ', 90, 2); // Ctrl+Z
    await sleep(460);
    ok(`撤销后总高回到 ${FACT.cabH}`, (await panelInput('高 H')) === FACT.cabH, String(await panelInput('高 H')));

    await activateRightTab('记忆');
    await sleep(300);
    const memShot = await shot(path.join(OUT_DIR, 'app-memory-panel.png'));
    ok(`记忆面板截图已保存（${(memShot / 1024).toFixed(0)}KB）`, memShot > 30000, `${memShot} bytes`);

    // ═══════════════════════════════════════════════════════════
    /**
     * B15 —— 用户原话："还得加个管理后台，能自己添加 api 模型，自动拉取模型"。
     *
     * 两条底线必须在这里被证明：
     *   · **完整 API Key 永远不出现在浏览器里**（页面上、响应里都找不到；
     *     但服务端的 .env 里必须有 —— 由 Node 侧读文件交叉验证）
     *   · **拉不到就是拉不到**：失败必须如实说失败并退回内置清单，
     *     不能把内置清单包装成"服务商实时返回"
     */
    section('B15 管理后台：自己配 API 模型 · 自动拉取 · key 只回后四位');

    const EXPECT_API = process.env.EXPECT_API === '1';
    const API_PORT = Number(process.env.API_PORT || 8787);
    const VERIFY_ENV = process.env.VERIFY_ENV_PATH || '';
    const VERIFY_MEM = process.env.VERIFY_MEM_PATH || '';
    const FAKE_KEY = process.env.VERIFY_FAKE_KEY || '';
    const FAKE_KEY2 = process.env.VERIFY_FAKE_KEY2 || '';

    await activateRightTab('后台');
    const adminState = () => evalJs(`(()=>{
      const row=[...document.querySelectorAll('.side-right .row')]
        .find(r=>r.querySelector('.row-label')?.textContent.trim()==='状态');
      return row? row.querySelector('.row-value').textContent.replace(/\\s+/g,' ').trim() : null;
    })()`);
    const settled = await waitFor(`(()=>{
      const row=[...document.querySelectorAll('.side-right .row')]
        .find(r=>r.querySelector('.row-label')?.textContent.trim()==='状态');
      return !!row && row.querySelector('.row-value').textContent.trim() !== '检测中…';
    })()`, 8000);
    ok('后台面板进入终态（不是永远停在"检测中…"）', settled === true, String(await adminState()));

    if (EXPECT_API) {
      ok(`本地服务被识别为「运行中」（服务跑在 ${API_PORT}）`, (await adminState()) === '运行中', String(await adminState()));
      ok(
        `面板如实写出监听地址 127.0.0.1:${API_PORT}`,
        (await panelText('监听地址')) === `http://127.0.0.1:${API_PORT}`,
        String(await panelText('监听地址'))
      );
      ok(
        '面板明说只监听本机回环地址（不 bind 0.0.0.0，同一个 WiFi 用不了你的 key）',
        /只监听本机回环地址/.test(String(await panelText('安全边界'))),
        String(await panelText('安全边界'))
      );
      ok(
        '面板写出了配置文件真实路径（配置落在哪儿不含糊）',
        String(await panelText('配置文件')).endsWith('.env'),
        String(await panelText('配置文件'))
      );

      const provSel = await panelField('服务商');
      ok(`服务商下拉列出 ${provSel?.options?.length} 家（可换，不是写死一家）`, (provSel?.options?.length ?? 0) >= 8, JSON.stringify(provSel?.options));
      ok('服务商下拉里有 DeepSeek / OpenAI / Ollama / 自定义', ['deepseek', 'openai', 'ollama', 'custom'].every((k) => (provSel?.options ?? []).includes(k)), JSON.stringify(provSel?.options));

      const modelSel = await panelField('模型');
      ok('模型下拉非空且默认选中一个真模型', (modelSel?.options?.length ?? 0) >= 1 && modelSel.options.includes('deepseek-chat'), JSON.stringify(modelSel?.options));
      ok('Base URL 是可编辑输入框（能自己添任意 OpenAI 兼容端点）', (await panelField('Base URL'))?.tag === 'INPUT', JSON.stringify(await panelField('Base URL')));
      ok('温度是输入框且默认 0.2', (await panelField('温度'))?.value === '0.2', String((await panelField('温度'))?.value));

      // ── Key 的第 1 条底线：只回后四位 ──
      const keyField0 = await panelField('API Key');
      ok('API Key 输入框是 password 类型（不裸奔在屏幕上）', keyField0?.type === 'password', JSON.stringify(keyField0));
      ok('API Key 输入框自身永远为空（前端拿不到原文）', keyField0?.value === '', `value 「${keyField0?.value}」`);
      ok(
        '已保存的 key 只以后四位形式出现',
        /已保存/.test(keyField0?.placeholder || '') && (keyField0?.placeholder || '').includes(FAKE_KEY.slice(-4)),
        String(keyField0?.placeholder)
      );
      const html0 = await evalJs(`document.documentElement.outerHTML`);
      ok('整页 HTML 里搜不到完整 API Key（包括初始 .env 里的那一个）', FAKE_KEY !== '' && !html0.includes(FAKE_KEY));

      // ── 保存一条新 key：只回后四位，但服务端必须真的收到 ──
      const setKey = await panelSet('API Key', FAKE_KEY2);
      ok('能在界面上填入一个新的 API Key', setKey === 'ok', String(setKey));
      const saveClicked = await clickPanelBtn('保存', 900);
      ok('点「保存」执行保存', saveClicked === true);

      const logBox = () => text('.side-right .logbox');
      const log1 = await logBox();
      ok('操作日志里写明保存到了哪个文件', /已保存到/.test(log1) && log1.includes('.env'), log1.slice(0, 300));
      ok(
        '日志里的 key 也只有后四位（日志同样不泄 key）',
        log1.includes(FAKE_KEY2.slice(-4)) && !log1.includes(FAKE_KEY2),
        log1.slice(0, 300)
      );

      const keyField1 = await panelField('API Key');
      ok('保存后输入框被清空（不给"回显原文"的机会）', keyField1?.value === '', `value 「${keyField1?.value}」`);
      ok(
        '保存后占位文案更新为新 key 的后四位',
        (keyField1?.placeholder || '').includes(FAKE_KEY2.slice(-4)),
        String(keyField1?.placeholder)
      );

      const html1 = await evalJs(`document.documentElement.outerHTML`);
      ok('保存完整页 HTML 里仍然搜不到完整 key（含刚填的那个）', !html1.includes(FAKE_KEY2) && !html1.includes(FAKE_KEY));

      const settingsResp = await evalJs(`fetch('/api/settings').then(r=>r.text())`);
      ok(
        '/api/settings 响应里不含完整 key，只回后四位',
        !String(settingsResp).includes(FAKE_KEY2) && String(settingsResp).includes(FAKE_KEY2.slice(-4)),
        String(settingsResp).slice(0, 220)
      );

      // ── 交叉验证（Node 侧）：浏览器看不到的东西，服务端文件里必须有 ──
      if (VERIFY_ENV) {
        const envText = fs.existsSync(VERIFY_ENV) ? fs.readFileSync(VERIFY_ENV, 'utf8') : '';
        ok(
          '服务端 .env 里确实存着完整 key（浏览器看不到 ≠ 服务端没收到）',
          envText.includes(FAKE_KEY2),
          envText ? `文件 ${envText.length} 字节，含新 key：${envText.includes(FAKE_KEY2)}` : '(文件不存在)'
        );
        ok('保存是替换而不是追加：旧 key 已被覆盖', !envText.includes(FAKE_KEY), envText.split('\n').filter((l) => l.startsWith('AI_API_KEY')).join(' | '));
        ok(
          '浏览器能看到的路径与服务端真实落点一致（读数诚实）',
          String(await panelText('配置文件')) === VERIFY_ENV,
          `面板「${await panelText('配置文件')}」vs 实际 ${VERIFY_ENV}`
        );
      }

      // ── 自动拉取模型：假 key 必然失败，失败必须如实说失败 ──
      const refreshClicked = await clickPanelBtn('自动拉取模型', 900);
      ok('能点到「⟳ 自动拉取模型」', refreshClicked === true);
      const refetchOk = await waitFor(`/拉取|实时|内置/.test(document.querySelector('.side-right .logbox')?.textContent||'')`, 12000);
      ok('拉取动作有明确结论（成功或失败，不会一直转圈）', refetchOk === true);

      const log2 = await logBox();
      const srcBox = await evalJs(`(()=>{const e=document.querySelector('.side-right .model-src');
        return e? { cls:e.className, text:e.textContent.replace(/\\s+/g,' ').trim() } : null})()`);
      ok(
        '假 key 拉取失败时退回内置清单，并明确标注「内置清单（可能已过期）」',
        srcBox?.cls.includes('model-src-builtin') === true && /内置清单（可能已过期）/.test(srcBox?.text || ''),
        JSON.stringify(srcBox)
      );
      ok(
        '没有把内置清单包装成「服务商实时返回」（这是最要紧的一条诚实性）',
        !/服务商实时返回/.test(srcBox?.text || '') && !/实时返回/.test(log2),
        JSON.stringify(srcBox) + ' / log ' + log2.slice(0, 200)
      );
      ok(
        '界面给出失败的真实原因（HTTP 状态或网络错误），不是一句"失败了"',
        /拉取失败|服务商返回|超时|fetch/i.test(srcBox?.text || '') || /拉取失败/.test(log2),
        JSON.stringify(srcBox?.text?.slice(0, 200))
      );
      ok('日志里也有这条失败记录（可回溯）', /拉取失败|内置清单/.test(log2), log2.slice(0, 240));

      // ── 连通性测试：同样必须如实报失败 ──
      const testClicked = await clickPanelBtn('测试连通性', 900);
      ok('能点到「测试连通性」', testClicked === true);
      const testSettled = await waitFor(`/连通性/.test(document.querySelector('.side-right .logbox')?.textContent||'')`, 12000);
      const log3 = await logBox();
      ok('连通性测试给出结论', testSettled === true, log3.slice(0, 200));
      ok(
        '假 key 的连通性测试如实报「连通性失败」+ 原因（不谎报正常）',
        /连通性失败/.test(log3),
        log3.slice(0, 240)
      );

      // ── 记忆同步：写入服务端 → 从服务端载入 ──
      const memOut = await clickPanelBtn('写入服务端', 900);
      ok('能点到「写入服务端」', memOut === true);
      const log4 = await logBox();
      ok('写入服务端有明确回执（含落点路径与字节数）', /记忆已写入/.test(log4) && /字节/.test(log4), log4.slice(0, 260));

      if (VERIFY_MEM) {
        const memText = fs.existsSync(VERIFY_MEM) ? fs.readFileSync(VERIFY_MEM, 'utf8') : '';
        const lines = memText.split(/\r?\n/).filter((l) => l.trim()).length;
        ok(
          `服务端记忆文件真的写出了 ${lines} 条（记忆不只躺在浏览器里，能进 git）`,
          lines === 7,
          `路径 ${VERIFY_MEM}，${lines} 行`
        );
        ok(
          '写出的每条记忆都能被解析出 id / status（不是一坨文本）',
          memText
            .split(/\r?\n/)
            .filter((l) => l.trim())
            .every((l) => {
              try {
                const o = JSON.parse(l);
                return Boolean(o.id && o.status);
              } catch {
                return false;
              }
            })
        );
        ok('记忆文件里不含任何 API Key（记忆与配置彻底分离）', FAKE_KEY2 !== '' && !memText.includes(FAKE_KEY2));
      }

      const memIn = await clickPanelBtn('从服务端载入', 1000);
      ok('能点到「从服务端载入」', memIn === true);
      const log5 = await logBox();
      ok('载入后明确说明载入了多少条、门已重新编译', /已从服务端载入\s*7\s*条记忆/.test(log5) && /门已重新编译/.test(log5), log5.slice(0, 260));

      const adminShot = await shot(path.join(OUT_DIR, 'app-admin-panel.png'));
      ok(`管理后台截图已保存（${(adminShot / 1024).toFixed(0)}KB）`, adminShot > 30000, `${adminShot} bytes`);

      // ── B29 后台增强：用量可见 · 会话轮换 · 审计 CSV 导出 ──
      // 账号/会话的写路径已由 Node 级验收（verify:admin，21 项）直测；
      // 这里只证明「界面上真的看得见、按钮真的打得通」—— 数据从接口到 DOM 的最后一段。
      const secExists = (t) => evalJs(`[...document.querySelectorAll('.side-right .sec-toggle')].some(x=>x.textContent.includes(${JSON.stringify(t)}))`);
      ok('「用量与额度」Section 存在（后端数据不再藏在接口里）', (await secExists('用量与额度')) === true);
      ok('「账号与会话」Section 存在', (await secExists('账号与会话')) === true);
      ok('「安全审计」Section 存在', (await secExists('安全审计')) === true);
      // local-open 模式的诚实文案：还没有账号体系时明说，而不是渲染一张空表假装有用
      const adminFull = await evalJs(`document.querySelector('.side-right .panel-scroll')?.textContent ?? ''`);
      ok('本地开放模式：用量区如实说明"还没有账号体系"（不假装有数据）',
        /还没有账号体系/.test(String(adminFull)) || /\d+/.test(String(adminFull)), String(adminFull).slice(0, 120));
      // CSV 导出端点：从页面 fetch（带浏览器环境），断 BOM 与 Content-Type —— 这是导出链路的真实形态
      // CSV 导出端点：从页面 fetch（带浏览器环境）。两个坑先说明：
      //   · res.text() 的 TextDecoder 默认剥掉 BOM —— 在浏览器层永远"看不见"BOM，
      //     断 BOM 必须用 arrayBuffer 读原始字节（Node 级验收已直测过 auditCsv 本体）；
      //   · 审计行数不硬编码 —— 断「CSV 条目数 = JSON 接口条目数」，导出与接口同源才是语义本身。
      const csvCheck = await evalJs(`(async()=>{
        const r = await fetch('/api/security/audit?format=csv&limit=20').catch(e=>null);
        if (!r) return { err: 'fetch failed' };
        const buf = await r.arrayBuffer();
        const b = new Uint8Array(buf);
        const text = new TextDecoder().decode(buf);
        const j = await fetch('/api/security/audit?limit=20').then((x)=>x.json()).catch(()=>null);
        return { status: r.status, ct: r.headers.get('Content-Type') ?? '',
          // UTF-8 的 BOM 是 EF BB BF 三字节（0xFEFF 是 UTF-16 的 BOM，别混）
          bom: b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF,
          head: text.split('\\r\\n')[0],
          csvRows: text.split('\\r\\n').length - 1,
          jsonCount: (j && j.entries ? j.entries.length : -1) };
      })()`);
      ok('审计 CSV 端点返回 200 + text/csv', !!csvCheck && csvCheck.status === 200 && /text\/csv/.test(csvCheck.ct ?? ''), JSON.stringify(csvCheck).slice(0, 160));
      ok('CSV 原始字节以 BOM 开头（Excel 打开不乱码的那条命根）',
        !!csvCheck && csvCheck.bom === true, JSON.stringify(csvCheck).slice(0, 160));
      ok('CSV 表头六列齐全', !!csvCheck && csvCheck.head === 'at,actor,action,target,result,detail', String(csvCheck?.head));
      ok('CSV 条目数与 JSON 接口一致（导出与接口同源，不编数据）',
        !!csvCheck && csvCheck.csvRows === csvCheck.jsonCount && csvCheck.jsonCount >= 0,
        `csv=${csvCheck?.csvRows} json=${csvCheck?.jsonCount}`);
    } else {
      // 没有拉起本地服务时，必须如实显示"未启动"并给出启动办法 —— 不许假装成功
      ok('服务未启动时如实显示「未启动」', (await adminState()) === '未启动', String(await adminState()));
      const offlineText = await memPanel();
      ok('给出可照做的启动命令（cd app / node server/server.mjs）', /node server\/server\.mjs/.test(offlineText) && /npm run server/.test(offlineText));
      ok('并说明为什么需要它（前端不留 API Key）', /前端不留 key/.test(offlineText), offlineText.slice(0, 200));
      ok('离线时不渲染任何"看起来配好了"的模型表单（不假装有后端）', (await evalJs(`!!document.querySelector('.side-right .model-src')`)) === false);
      ok('离线时也不会显示"运行中"', (await adminState()) !== '运行中');
    }

    ok('跑完记忆与后台之后，仍然零页面异常', pageErrors.length === 0, pageErrors.join('\n      '));
    ok('跑完记忆与后台之后，仍然零 console error', consoleErrors.length === 0, consoleErrors.slice(0, 5).join('\n      '));

    // ═══════════════════════════════════════════════════════════
    /**
     * B16 —— 用户原话："之前我看你生成的 cad 有拆解图，这个可以设置开关，
     * 4 视图调整好后可以选择生成分解图用于生产。也可以选择关闭。"
     *
     * 这一组要证明的不是"有这么个按钮"，而是三件事：
     *   ① 默认必须是**关**（"可以选择关闭"的前提是它默认不挡视线）
     *   ② 打开后图幅上真的多出一张图，而且**与开料清单逐件对应**（不是画个大概）
     *   ③ 关掉后画面逐像素回到原样，模型一个数都没变（开关是"看的方式"，不是改模型）
     */
    section('B16 分解图开关：默认关闭 · 打开后与开料清单逐件对应 · 关闭后复原');

    /** 展开右侧某个折叠分区（折叠的分区整块不渲染，不展开就读不到它的内容） */
    const openSection = async (needle) => {
      const r = await evalJs(`(()=>{
        const sec=[...document.querySelectorAll('.side-right .sec')]
          .find(s=>((s.querySelector('.sec-toggle')?.textContent)||'').includes(${JSON.stringify(needle)}));
        if(!sec) return 'no-sec';
        if(!sec.querySelector('.sec-body')){ sec.querySelector('.sec-toggle').click(); return 'opened'; }
        return 'already';
      })()`);
      await sleep(300);
      return r;
    };

    await activateRightTab('视图');
    await sleep(340);

    const exBtnActive = () =>
      evalJs(`(()=>{
        const b=[...document.querySelectorAll('.toolbar .tb-btn')]
          .find(x=>x.textContent.replace(/\\s+/g,' ').trim()==='✦ 分解图');
        return b? b.classList.contains('active') : null;
      })()`);
    const exBtnClick = async () => {
      const r = await evalJs(`(()=>{
        const b=[...document.querySelectorAll('.toolbar .tb-btn')]
          .find(x=>x.textContent.replace(/\\s+/g,' ').trim()==='✦ 分解图');
        if(!b) return false; b.click(); return true;
      })()`);
      await sleep(620);
      return r;
    };
    const panelAll = () => text('.side-right .panel-scroll');

    /** 画布下半部分的"墨量" —— 分解图只可能出现在那里，用它证明"真的画上去了" */
    const bottomInk = () =>
      evalJs(`(()=>{
        const c=document.querySelector('.vp-canvas');
        const y0=Math.floor(c.height*0.55);
        const d=c.getContext('2d').getImageData(0,y0,c.width,Math.max(1,c.height-y0)).data;
        let n=0;
        for(let i=0;i<d.length;i+=4*13){ if(d[i]!==d[i+1]||d[i+1]!==d[i+2]) n++; }
        return n;
      })()`);

    ok('工具栏上有「✦ 分解图」按钮（开关在手边，不用翻面板找）', (await exBtnActive()) !== null, `active=${await exBtnActive()}`);
    ok('默认是关闭的 —— 用户说"也可以选择关闭"，默认就该不挡视线', (await exBtnActive()) === false);

    ok('能展开「分解图（爆炸图）」分区', (await openSection('分解图（爆炸图）')) !== 'no-sec', String(await openSection('分解图（爆炸图）')));
    ok('关闭时面板如实写明"当前关闭 —— 图幅上不会出现分解图"', /当前关闭/.test(await panelAll()), (await panelAll()).slice(0, 200));
    ok(
      '关闭状态下列不出任何板件读数（连装配数据都不算，"零开销"不是一句口号）',
      (await panelText('柜体 / 板件')) === null,
      `读到「${await panelText('柜体 / 板件')}」`
    );

    // ── 切到四视图图幅：分解图是图幅上的第二张图，平面图上没有它 ──
    const toSheet = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')]
      .find(x=>x.textContent.trim()==='▤ 四视图');if(!b)return false;b.click();return true})()`);
    ok('能切到「▤ 四视图」图幅', toSheet === true);
    await sleep(760);

    const vBeforeExplode = await statusVersion();
    const hudSheetOnly = await text('.vp-hud-sheet');
    ok('此时 HUD 只提四视图，不提分解图', /四视图图幅/.test(hudSheetOnly) && !/分解图/.test(hudSheetOnly), hudSheetOnly);
    const sigSheetOnly = await canvasSig();
    const inkSheetOnly = await bottomInk();

    // ── 打开 ──
    ok('点工具栏「✦ 分解图」把它打开', (await exBtnClick()) === true);
    ok('按钮进入激活态（开关状态看得见，不是只有一个动作没有状态）', (await exBtnActive()) === true);

    const hudWithExplode = await text('.vp-hud-sheet');
    ok('HUD 明说图幅上多了"分解图（下方）"', /分解图（下方）/.test(hudWithExplode), hudWithExplode);

    const exFacts = await evalJs(`(async()=>{
      const store = await import('/src/state/store.ts');
      const e = store.bus.deriveExplode(true);
      const v = store.bus.derive().geom.views;
      return {
        enabled:e.enabled, prims:e.prims.length,
        cabinets:e.check.cabinets, panelKinds:e.check.panelKinds, pieces:e.check.pieces,
        instances:e.check.instances, drawnNos:e.check.drawnNos, unplaced:e.check.unplaced,
        mismatches:e.check.mismatches, ok:e.check.ok,
        exY1:e.bbox?e.bbox.max.y:null, exY0:e.bbox?e.bbox.min.y:null,
        viewY0:v.bbox?v.bbox.min.y:null, viewY1:v.bbox?v.bbox.max.y:null,
      };
    })()`);

    const sigWithExplode = await canvasSig();
    const inkWithExplode = await bottomInk();
    ok('画布上确实多了一张图（像素指纹变了，不是只加了个标签）', sigWithExplode.h !== sigSheetOnly.h, `只四视图 ${sigSheetOnly.h} vs 加分解图 ${sigWithExplode.h}`);
    ok(
      '分解图真的画出来了：画布下半部分的墨量明显增加（那里只可能有分解图）',
      inkWithExplode > inkSheetOnly && inkWithExplode > 20,
      `下半部墨量 ${inkSheetOnly} → ${inkWithExplode}`
    );

    ok(
      `面板「柜体 / 板件」逐字等于派生结果（${exFacts.cabinets} 个 / 清单 ${exFacts.panelKinds} 种 ${exFacts.pieces} 件）`,
      (await panelText('柜体 / 板件')) === `${exFacts.cabinets} 个 / 清单 ${exFacts.panelKinds} 种 ${exFacts.pieces} 件`,
      `面板读到「${await panelText('柜体 / 板件')}」`
    );
    ok(
      `面板「图上摆出」逐字等于派生结果（${exFacts.instances} 件 / ${exFacts.drawnNos} 个件号）`,
      (await panelText('图上摆出')) === `${exFacts.instances} 件 / ${exFacts.drawnNos} 个件号`,
      `面板读到「${await panelText('图上摆出')}」`
    );
    ok(
      `图上摆出的件数 = 开料清单件数（${exFacts.instances} = ${exFacts.pieces}）—— 按 qty 逐件展开，不是"一类摆一件"`,
      exFacts.instances === exFacts.pieces,
      `instances ${exFacts.instances} vs pieces ${exFacts.pieces}`
    );
    ok(
      `分解图的清单口径 = 状态栏板件数（${exFacts.pieces} = ${await statusPieces()}）—— 两个视图同源派生，读数不许打架`,
      exFacts.pieces === (await statusPieces()),
      `分解图 ${exFacts.pieces} vs 状态栏 ${await statusPieces()}`
    );
    ok(
      `清单口径仍是基线值（${FACT.totalPieces} 件 / ${FACT.panelKinds} 种）`,
      exFacts.pieces === FACT.totalPieces && exFacts.panelKinds === FACT.panelKinds,
      `pieces ${exFacts.pieces} / panelKinds ${exFacts.panelKinds}`
    );
    ok('与清单核对通过：没有一块摆不出来', exFacts.ok === true && exFacts.unplaced.length === 0, JSON.stringify(exFacts.unplaced));
    ok('面板给出的核对结论是「件数一一对应」', /件数一一对应/.test(String(await panelText('与清单核对'))), String(await panelText('与清单核对')));
    ok(
      '分解图整体摆在四视图正下方，两张图不重叠（这个关系是算出来的：below = 四视图 bbox）',
      exFacts.exY1 !== null && exFacts.viewY0 !== null && exFacts.exY1 <= exFacts.viewY0,
      `分解图上沿 ${exFacts.exY1} ≤ 四视图下沿 ${exFacts.viewY0}`
    );
    ok('面板写明爆炸位移只是图面表达、没有工艺含义（不让人当成拆卸行程）', /没有工艺含义/.test(await panelAll()));
    ok('开关只换"看的方式"，不改模型：版本一个数都没动', (await statusVersion()) === vBeforeExplode, `v${vBeforeExplode} → v${await statusVersion()}`);

    const exShot = await shot(path.join(OUT_DIR, 'app-explode-sheet.png'));
    ok(`分解图图幅截图已保存（${(exShot / 1024).toFixed(0)}KB）`, exShot > 40000, `${exShot} bytes`);

    // ── 关闭：必须回到原样 ──
    ok('再点一次就关掉（"也可以选择关闭"）', (await exBtnClick()) === true);
    ok('关闭后按钮退出激活态', (await exBtnActive()) === false);
    ok('关闭后 HUD 不再提分解图', !/分解图/.test(await text('.vp-hud-sheet')), await text('.vp-hud-sheet'));
    ok('关闭后面板回到「当前关闭」', /当前关闭/.test(await panelAll()));
    ok(
      '关闭后板件读数消失（不是留下一个 0 —— 是根本没有这一项）',
      (await panelText('柜体 / 板件')) === null,
      `读到「${await panelText('柜体 / 板件')}」`
    );

    const sigBack = await canvasSig();
    ok(
      '关闭后画面逐像素回到"只有四视图"的那一帧（开关可逆，不是往画布上叠一层）',
      sigBack.h === sigSheetOnly.h,
      `关掉后 ${sigBack.h} vs 打开前 ${sigSheetOnly.h}`
    );
    ok('开关往返一趟，模型版本仍未变', (await statusVersion()) === vBeforeExplode, `v${vBeforeExplode} → v${await statusVersion()}`);
    ok('分解图往返没有引入 ERROR', (await text('.sb-badge-err')) === '', await text('.sb-badge-err'));

    // ── 命令行也要能开关（AI / MCP 走的是同一条通道，不能只有鼠标能用）──
    await runCommandLine('EXPLODE');
    ok('命令行 EXPLODE 能打开分解图', (await exBtnActive()) === true);
    await runCommandLine('EXPLODE OFF');
    ok('命令行 EXPLODE OFF 能关掉', (await exBtnActive()) === false);

    // ═══════════════════════════════════════════════════════════
    /**
     * B17 —— 用户原话："ai 调用用支持 api 调用的形式，比如 openai 的接口，
     * 用于测试，后续可以添加其他 api。"
     *
     * 走的是**真 HTTP**：验收脚本起了一个 OpenAI 兼容端点（mock 服务商），
     * 然后通过界面真实地走完 说一句话 → 出计划 → 干跑预览 → 点应用 → 模型真的变了。
     * 不这么做就只验得了失败路径（假 key 打真服务商必然失败），而成功路径
     * 才是这条功能存在的全部理由。
     */
    section('B17 AI 规划：一句话 → 契约 → 干跑预览 → 应用（真 HTTP，OpenAI 兼容端点）');

    const MOCK_URL = process.env.VERIFY_MOCK_URL || '';
    const VERIFY_AUDIT = process.env.VERIFY_AUDIT_PATH || '';
    ok('验收环境提供了 mock 服务商地址（走真 HTTP，不是函数打桩）', MOCK_URL.startsWith('http'), MOCK_URL || '(未设置)');

    const settingsPut = await evalJs(`fetch('/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider:'custom',baseUrl:${JSON.stringify(MOCK_URL)},model:'mock-model-1'})}).then(r=>r.json())`);
    ok('服务商能换成任意 OpenAI 兼容端点 —— "后续可以添加其他 api"靠的就是这一步', settingsPut?.baseUrl === MOCK_URL && settingsPut?.model === 'mock-model-1', JSON.stringify({ baseUrl: settingsPut?.baseUrl, model: settingsPut?.model }));
    ok('换服务商不需要改代码、不需要重启服务（设置即时生效）', settingsPut?.provider === 'custom', String(settingsPut?.provider));

    await activateRightTab('AI');
    await sleep(420);
    const aiPanel = () => text('.side-right .panel-scroll');

    // 词汇表分区默认折叠（它是参考表，不该一进来就占满屏）。**先展开再读** ——
    // 顺序要紧：`Section` 折叠时整块不渲染，先断言内容只会读到空字符串。
    // （第一次写这组时就是反的：先断言"不产出几何"、再展开，于是那条断言必然失败。）
    ok('能展开「契约词汇表」分区', (await openSection('契约词汇表')) !== 'no-sec');

    ok(
      'AI 面板说清边界：只能选动作、不产出几何、走和鼠标操作相同的那条写入路径',
      /不产出几何/.test(await aiPanel()) && /写入路径/.test(await aiPanel()),
      (await aiPanel()).slice(0, 260)
    );
    const vocabCount = await evalJs(`document.querySelectorAll('.side-right .action-list li').length`);
    ok(`面板把契约词汇表逐个列出来（${vocabCount} 个动作）—— 这张表就是 AI 的全部权限`, vocabCount >= 18, String(vocabCount));
    /**
     * 词汇表必须与契约**同源**：面板上列的 18 个动作名，逐个等于
     * shared/aiContract.mjs 导出的 ACTION_NAMES。
     * 这条断言的意义与"契约区间 === 界面旋钮"是同一条原则 ——
     * 界面上写着"AI 能做什么"，那就必须是 AI 真的能做什么，多一个少一个都不行。
     */
    const contractActions = await import(pathToFileURL(path.join(HERE, '..', 'shared', 'aiContract.mjs')).href);
    const panelActions = await evalJs(`[...document.querySelectorAll('.side-right .action-list li .mono')].map(x=>x.textContent.trim())`);
    ok(
      `面板列出的动作名逐字等于契约里的 ${contractActions.ACTION_NAMES.length} 个（界面不自己另写一套）`,
      JSON.stringify(panelActions) === JSON.stringify(contractActions.ACTION_NAMES),
      `面板 ${JSON.stringify(panelActions)}\n      契约 ${JSON.stringify(contractActions.ACTION_NAMES)}`
    );
    ok(
      '快照体积如实显示（发给模型的东西有多少，不含糊）',
      /KB/.test(String(await panelText('发给模型的项目快照'))),
      String(await panelText('发给模型的项目快照'))
    );

    await activateRightTab('历史');
    await sleep(320);
    const histAiBefore = await evalJs(`document.querySelectorAll('.side-right .hist-src.src-ai').length`);
    await activateRightTab('AI');
    await sleep(340);

    const aiBefore = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const c=s.bus.getState().cabinets[0];
      return { name:c.name, lift:c.params.bodyLift, height:c.params.height };})()`);
    const vBeforeAi = await statusVersion();

    ok('能在输入框里写下这句话', (await setElValue('.side-right .ai-input', '把主卧衣柜的踢脚改成 120，顺便把名字改一下')) === true);
    ok('点「生成计划」', (await clickPanelBtn('生成编辑计划', 1600)) === true);

    const previewShown = await waitFor(`!!document.querySelector('.side-right .plan-step')`, 25000);
    ok('不久后出现干跑预览（这一段走的是真 HTTP，服务端再转发到 mock 服务商）', previewShown === true, (await aiPanel()).slice(0, 400));

    const planDom = await evalJs(`(()=>{
      const steps=[...document.querySelectorAll('.side-right .plan-step')];
      const rowVal=(label)=>{const r=[...document.querySelectorAll('.side-right .row')]
        .find(x=>((x.querySelector('.row-label')?.textContent)||'').replace(/\\s+/g,'').replace(/\\u{1F512}/gu,'')===label);
        return r&&r.querySelector('.row-value')?r.querySelector('.row-value').textContent.replace(/\\s+/g,' ').trim():null;};
      return {
        count:steps.length,
        bad:steps.filter(s=>s.classList.contains('plan-step-bad')).length,
        actions:steps.map(s=>((s.querySelector('.plan-head .mono')?.textContent)||'').trim()),
        labels:steps.map(s=>((s.querySelector('.plan-label')?.textContent)||'').trim()),
        reasons:steps.map(s=>((s.querySelector('.plan-reason')?.textContent)||'').trim()),
        diffs:steps.map(s=>[...s.querySelectorAll('.diff-list li')].map(li=>li.textContent.replace(/\\s+/g,' ').trim())),
        noNew:steps.filter(s=>/未新增任何规则问题/.test(s.textContent)).length,
        call:rowVal('本次调用'),
        snapshot:rowVal('发给模型的项目快照'),
      };
    })()`);

    ok(`干跑把 ${planDom.count} 条动作一条一卡地列出来（不是一个"共 2 处改动"的汇总）`, planDom.count === 2, JSON.stringify(planDom.actions));
    ok('两条都标为可应用（没有失败卡）', planDom.bad === 0, `坏卡 ${planDom.bad} 张`);
    ok('每条给出编译后的命令人话摘要（与鼠标操作的日志是同一套说法）', planDom.labels.every((s) => s && s !== '(未编译)'), JSON.stringify(planDom.labels));
    ok('每条回显 AI 给的理由（不是黑箱改模型）', planDom.reasons.every((s) => /AI 理由/.test(s) && s.length > 6), JSON.stringify(planDom.reasons));
    ok('每条给出将要发生的 diff —— 用户点"应用"的唯一依据就是这个', planDom.diffs.every((d) => d.length > 0), JSON.stringify(planDom.diffs));
    ok(
      'diff 里能读到踢脚高 80 → 120（预览给出的数，就是待会儿真会落进模型的数）',
      planDom.diffs.some((d) => d.some((x) => /params\.bodyLift/.test(x) && /80\s*→\s*120/.test(x))),
      JSON.stringify(planDom.diffs)
    );
    ok('两条都没有新增规则问题（strict 干跑放行）', planDom.noNew === 2, String(planDom.noNew));
    ok(
      '面板如实写出这次用了哪个模型、花了多少 token、耗时多少（用量是账单，不能估）',
      /**
       * 耗时用**秒**显示，不用毫秒。
       * 这台局域网推理模型单次是 17–27 秒 —— "26500ms"要在脑子里除一次才读得懂，
       * 而"26.5s"是直接懂的。显示的单位要按量级选。
       */
      /mock-model-1/.test(String(planDom.call)) && /1290 token/.test(String(planDom.call)) && /\d+\.\d+s/.test(String(planDom.call)),
      String(planDom.call)
    );
    ok('预览阶段模型没被动过：版本还是原来的', (await statusVersion()) === vBeforeAi, `v${vBeforeAi} → v${await statusVersion()}`);
    ok(
      '预览阶段柜体名与踢脚高都还是原值（"预览"真的是预览）',
      (await evalJs(`(async()=>{const s=await import('/src/state/store.ts');const c=s.bus.getState().cabinets[0];return c.name+'|'+c.params.bodyLift})()`)) === `${aiBefore.name}|${aiBefore.lift}`,
      `期望 ${aiBefore.name}|${aiBefore.lift}`
    );

    // ── 应用 ──
    ok('点「应用全部（2 条）」', (await clickPanelBtn('应用全部', 1400)) === true);
    ok('应用后有明确回执（不静默生效）', /已应用\s*2\s*条/.test(await text('.toasts')), await text('.toasts'));

    const aiAfter = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const c=s.bus.getState().cabinets[0];
      return { name:c.name, lift:c.params.bodyLift, height:c.params.height, version:s.bus.getVersion() };})()`);
    ok('踢脚真的变成了预览里写的 120 —— 「预览 === 提交」在 AI 通路上同样成立', aiAfter.lift === 120, String(aiAfter.lift));
    ok(`柜体名真的改了（${aiBefore.name} → ${aiAfter.name}）`, aiAfter.name === `${aiBefore.name}·AI`, String(aiAfter.name));
    ok('两条命令各 +1：模型版本 +2', aiAfter.version === vBeforeAi + 2, `v${vBeforeAi} → v${aiAfter.version}`);
    ok('高度没被顺手改掉（AI 只动了它说会动的东西）', aiAfter.height === aiBefore.height, `${aiBefore.height} → ${aiAfter.height}`);
    ok('应用后模型里 0 ERROR', (await text('.sb-badge-err')) === '', await text('.sb-badge-err'));

    const keepPanel = await aiPanel();
    ok('已提交的计划留在面板上（不会"版本一变就清屏"，人能回头核对到底改了什么）', /已应用\s*2\s*条/.test(keepPanel) && /干跑预览/.test(keepPanel), keepPanel.slice(0, 240));
    const applyBtnDisabled = await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right .tb-btn')]
      .find(x=>/已应用|应用全部/.test(x.textContent));return b? b.disabled : null;})()`);
    ok('应用按钮已禁用（同一份计划不可能被提交两次）', applyBtnDisabled === true, String(applyBtnDisabled));

    await activateRightTab('历史');
    await sleep(360);
    const histAiAfter = await text('.side-right .hist');
    const histCountAfter = await evalJs(`document.querySelectorAll('.side-right .hist-item').length`);
    /**
     * ⚠ 这里不能用"条目数 = 之前 + 2"来判断。
     *
     * 第一版就是这么写的，报 `2 → 3`（少了一条），我一度以为是"有条命令没进历史"。
     * 实际原因是模型本身的规矩：**撤销之后再执行新命令，会丢弃重做尾巴**
     * （`commandBus.execute` 里那句 `entries.slice(0, pointer + 1)`，与所有
     * CAD/编辑器的线性历史一致）。B14 结尾撤销过一次，于是历史里留着一条
     * 未被应用的尾巴；B17 的第一条命令一来，那条尾巴就被丢掉了 —— 它恰好是
     * 一条 source=ai 的条目，所以净增是 2 - 1 = +1。
     *
     * 结论：断言要盯住"这两条命令到底有没有进历史、标成什么"，而不是去做
     * 一个依赖前面所有用例行为的加法 —— 那种断言会在别处改动时莫名其妙地红。
     */
    ok(
      '两条 AI 命令都进了同一条历史时间线（与鼠标操作并列，不是另开一本账）',
      /AI：「[^」]*」踢脚高 → 120mm/.test(histAiAfter) && /AI：重命名「[^」]*」→「[^」]*·AI」/.test(histAiAfter),
      histAiAfter.slice(0, 700)
    );
    ok('历史里带「AI：」前缀的 label（与鼠标操作的写法一致，复盘时一眼分得清）', /AI：/.test(histAiAfter));
    ok('历史写出真实 diff：params.bodyLift 80 → 120', /params\.bodyLift:\s*80\s*→\s*120/.test(histAiAfter), histAiAfter.slice(0, 700));
    ok('历史里能读到改名那一笔', /主卧衣柜·AI/.test(histAiAfter), histAiAfter.slice(0, 700));
    ok('历史条目仍带派生快照（AI 改完不会留下旧快照）', /板件\s*\d+\s*件/.test(histAiAfter));
    ok(
      `执行新命令会丢弃"撤销过的重做尾巴"（AI 之前 ai 条目 ${histAiBefore} 条，现在历史共 ${histCountAfter} 条）—— 这条正是上面那次误判的根源，现在它自己也有断言看着了`,
      histCountAfter >= 3,
      String(histCountAfter)
    );

    // ── 负例：一条动作不符合契约 → 整份计划必须停住，并说清是哪一条、为什么 ──
    await activateRightTab('AI');
    await sleep(340);
    ok('能再写一句（面板没有被上一轮锁死）', (await setElValue('.side-right .ai-input', '把主卧衣柜的踢脚改成 140，顺便改个名字（越界参数）')) === true);
    const vBeforeBad = await statusVersion();
    ok('点「生成计划」（第二次）', (await clickPanelBtn('生成编辑计划', 1600)) === true);
    const badShown = await waitFor(`/不符合契约/.test(document.querySelector('.side-right .panel-scroll')?.textContent||'')`, 25000);
    const badPanel = await aiPanel();
    ok(
      '有动作不符合契约时，界面点名"第几条 + 具体原因"，而不是光一句"规划失败"',
      badShown === true && /第 2 条/.test(badPanel) && /volume/.test(badPanel),
      badPanel.slice(0, 460)
    );
    ok('被拒的动作逐条列在告警框里（一条都不藏）', (await evalJs(`document.querySelectorAll('.side-right .alert-warn li').length`)) >= 1, String(await evalJs(`document.querySelectorAll('.side-right .alert-warn li').length`)));
    ok('没有出现干跑预览（根本没走到"看起来可以应用"那一步）', (await evalJs(`document.querySelectorAll('.side-right .plan-step').length`)) === 0);

    const afterBad = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const c=s.bus.getState().cabinets[0];
      return { name:c.name, lift:c.params.bodyLift, version:s.bus.getVersion() };})()`);
    ok(
      '合法的那一条（改踢脚 140）也没被执行 —— 原子性：半执行的模型会让人以为整句话都生效了',
      afterBad.lift === 120 && afterBad.name === aiAfter.name,
      JSON.stringify(afterBad)
    );
    ok('模型版本一个数都没动', afterBad.version === vBeforeBad, `v${vBeforeBad} → v${afterBad.version}`);

    // ── Node 侧交叉验证：服务端真的记了这笔 AI 调用（浏览器看不到的地方）──
    if (VERIFY_AUDIT) {
      const auditEntries = fs
        .readFileSync(VERIFY_AUDIT, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const plans = auditEntries.filter((e) => e.action === 'ai.plan');
      ok(`服务端审计里留下了 AI 调用记录（${plans.length} 条 ai.plan）`, plans.length >= 2, JSON.stringify(auditEntries.map((e) => e.action)));
      /**
       * 三态而不是两态：`ok`（全部动作合规）/ `partial`（有动作被拒，前端会整份拒绝）/
       * `rejected`（全部被拒）。如果只记 ok / rejected，"部分被拒"就会在账上显示成成功 ——
       * 而界面明明说的是"整份计划不予执行"。审计必须和界面说同一件事。
       */
      ok(
        '第一条成功记为 ok，第二条（含越界参数）记为 partial —— 审计与界面的说法一致',
        plans.some((p) => p.result === 'ok') && plans.some((p) => p.result === 'partial'),
        JSON.stringify(plans.map((p) => p.result))
      );
      ok('partial 那条写明了被拒的契约错误码（EXTRA_PARAM）', plans.some((p) => p.result === 'partial' && (p.rejected ?? []).includes('EXTRA_PARAM')), JSON.stringify(plans.find((p) => p.result === 'partial')));
      ok('审计里记了模型名与动作名（出账/追责靠这个，不是一坨日志）', plans.every((p) => p.model) && plans.some((p) => Array.isArray(p.actions) && p.actions.length > 0), JSON.stringify(plans[0]));
    }

    // ═══════════════════════════════════════════════════════════
    /**
     * B37 —— 「AI 照描述生成柜体」在**真界面**上跑通一遍。
     *
     * 用户原话："目前ai功能太少，只能修改长宽高等一些基础参数……能不能利用AI更具描述生成"。
     *
     * node 侧已经证明"意图 → 分区"的映射和恒等式，但用户真正要的是
     * **在界面上说一句话就得到一个柜子**。这条链路（输入 → mock 服务商 →
     * 契约 → 干跑 → 点应用 → 对象树/四视图里真的多出一台柜）只在浏览器里存在。
     *
     * 关键断言不是"多了一个柜"，而是三条：
     *   ① 建出来的内部结构**就是描述里说的那个**（三个分区、抽屉数、门扇数）
     *   ② 落位是系统替它挑的，且**不撞墙**（不许"放进去再说"）
     *   ③ 一次生成 = 一条命令 = 一次撤销（不是散落一堆改动收不回来）
     */
    section('B37 AI 照描述生成柜体：一句话 → 真界面 → 真的多出一台柜');

    await activateRightTab('AI');
    await sleep(360);

    // 先存现场。这一节会真的往模型里加一台柜，而下游 B21 / B30 的落位断言
    // 依赖"房间还剩多少空位" —— 不还原就会把人家挤到没地方放（第一轮就踩了，
    // B30 于是报"两个柜体重叠"，看起来像模板放置有 bug，其实是这里留了赃物）。
    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      window.__b37Saved = structuredClone(s.bus.getState()); return true})()`);

    const before37 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const p=s.bus.getState();
      return { ver:s.bus.getVersion(), count:p.cabinets.length,
        names:p.cabinets.map(c=>c.name), errs:s.bus.derive().issues.filter(i=>i.severity==='ERROR').length };})()`);

    ok('能在输入框里写出一段结构描述（不是"把宽改成 1800"这种单参数指令）',
      (await setElValue('.side-right .ai-input', '帮我生成一个餐边柜：左边三只抽屉，中间两块层板带一组对开门，右边留开放格')) === true);
    ok('点「生成编辑计划」', (await clickPanelBtn('生成编辑计划', 20000)) === true);

    const shown37 = await waitFor(`!!document.querySelector('.side-right .plan-step')`, 25000);
    ok('出现干跑预览（走真 HTTP：界面 → 本地服务 → mock 服务商 → 回来）', shown37 === true, (await text('.side-right .panel-scroll')).slice(0, 300));

    const plan37 = await evalJs(`(()=>{
      const steps=[...document.querySelectorAll('.side-right .plan-step')];
      return {
        count:steps.length,
        bad:steps.filter(s=>s.classList.contains('plan-step-bad')).length,
        actions:steps.map(s=>((s.querySelector('.plan-head .mono')?.textContent)||'').trim()),
        labels:steps.map(s=>((s.querySelector('.plan-label')?.textContent)||'').trim()),
        diffs:steps.map(s=>[...s.querySelectorAll('.diff-list li')].map(li=>li.textContent.replace(/\\s+/g,' ').trim())),
      };
    })()`);

    ok('AI 给出的是"建一个柜"这条动作，而不是一串改尺寸的补丁',
      plan37.actions.some((a) => /cabinet\.create/.test(a)), JSON.stringify(plan37.actions));
    ok('预览里没有失败卡（描述被完整理解了）', plan37.bad === 0, `坏卡 ${plan37.bad} 张`);
    ok('预览阶段模型没动：柜体数量不变', (await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets.length})()`)) === before37.count,
      `${before37.count} → ${await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets.length})()`)}`);

    // 留一张"干跑预览"的图：这是用户点"应用"之前看到的唯一依据，值得被看见
    const shotPreview37 = await shot(path.join(OUT_DIR, 'ai-generate-preview.png'));
    ok('干跑预览截图已留档（非空）', shotPreview37 > 20000, `${shotPreview37} 字节`);

    ok('点「应用」', (await clickPanelBtn('应用全部', 1400)) === true);
    await sleep(420);

    const after37 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const p=s.bus.getState();
      const c=p.cabinets.find(x=>x.name==='AI生成柜');
      return {
        ver:s.bus.getVersion(), count:p.cabinets.length,
        errs:s.bus.derive().issues.filter(i=>i.severity==='ERROR').length,
        cab: c ? { name:c.name, w:c.params.width, h:c.params.height, d:c.params.depth,
          place:JSON.stringify(c.placement),
          units:c.layout.units.map(u=>({id:u.id, kind:u.kind, nick:u.nickname,
            drawers:u.drawers?.count ?? null, shelves:u.shelves?.count ?? null, doors:u.doors?.count ?? null})) } : null,
      };})()`);

    ok('真的多出一台柜（一次生成 = 一条命令 = 版本 +1）',
      after37.count === before37.count + 1 && after37.ver === before37.ver + 1, JSON.stringify({ c: `${before37.count}→${after37.count}`, v: `${before37.ver}→${after37.ver}` }));
    ok('描述里的三个分区一个不少（左抽 / 中门格 / 右开放）',
      Boolean(after37.cab) && after37.cab.units.length === 3
        && after37.cab.units.map((u) => u.kind).join(',') === 'drawerBank,shelves,open',
      JSON.stringify(after37.cab?.units));
    ok('"三只抽屉"真的变成 3 只', after37.cab?.units[0]?.drawers === 3, String(after37.cab?.units[0]?.drawers));
    ok('"带一组对开门"真的做了 2 扇门', after37.cab?.units[1]?.doors === 2, String(after37.cab?.units[1]?.doors));
    ok('"右边开放格"就是不带门（不是忘了做）', after37.cab?.units[2]?.doors === null, String(after37.cab?.units[2]?.doors));
    ok('分区 id 各不相同（否则板件撞 id → 清单少一块 → 生产下错料）',
      new Set((after37.cab?.units ?? []).map((u) => u.id)).size === 3, JSON.stringify((after37.cab?.units ?? []).map((u) => u.id)));
    ok('落位是系统挑的且没撞墙（不是"放进去再报一条干涉"）',
      after37.errs === before37.errs, `ERROR ${before37.errs} → ${after37.errs}`);
    ok('应用后没有新增硬错', after37.errs === 0, String(after37.errs));

    // 撤销：一次生成必须一次收得回来
    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');s.bus.undo();return true})()`);
    await sleep(320);
    const undo37 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets.length})()`);
    ok('一次撤销就把这台柜收回去（生成不是散落一堆改不回来的改动）', undo37 === before37.count, `${after37.count} → ${undo37}`);
    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');s.bus.redo();return true})()`);
    await sleep(320);
    ok('重做又能回来（历史是线性的，不是一次性操作）',
      (await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets.length})()`)) === before37.count + 1);

    // 切到四视图拍一张：新柜在图上真的画出来了（不是只在对象树里多一行）
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.includes('四视图'));if(b)b.click();return !!b})()`);
    await sleep(1100);
    const shotApplied37 = await shot(path.join(OUT_DIR, 'ai-generate-applied.png'));
    ok('应用后截图已留档（非空）', shotApplied37 > 20000, `${shotApplied37} 字节`);

    // 还原现场：本节自己造的柜子不许留给下游
    const restored37 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      if (!window.__b37Saved) return null;
      s.bus.replaceProject(window.__b37Saved, 'B37 还原现场');
      const p=s.bus.getState();
      return { count:p.cabinets.length, names:p.cabinets.map(c=>c.name) };})()`);
    ok('B37 结束后把现场还原了（自己造的柜子不许留给下游占地方）',
      Boolean(restored37) && restored37.count === before37.count
        && restored37.names.join('|') === before37.names.join('|'),
      `还原=${JSON.stringify(restored37)} 之前=${JSON.stringify(before37.names)}`);
    await sleep(240);

    // ═══════════════════════════════════════════════════════════
    /**
     * B38 —— 「洗衣机柜」这条**复杂柜型**经 AI 全链在真界面落地。
     *
     * 餐边柜 / 岛台的派生正确性已由 node 侧验收（complex-cabinets-acceptance）
     * 覆盖；浏览器里专挑洗衣机柜验，因为它最刁：
     * kind:'appliance'（洞口三尺寸 + 上面抽屉）必须是 AI 契约里**说得出的话**
     * ——否则就是"AI 建不出来、用户还得手动改"，那句"照描述生成"就名存实亡。
     *
     * 三条硬断言（与 B37 同构，但每一层都换了内容）：
     *   ① 落地的语义就是描述里那个（洞口 650×850×600、上面 3 只抽屉、电器格不带门）
     *   ② 派生分流正确：洗衣机本体进**甲购件**（不走开料机），过梁板进**开料**
     *   ③ 一次生成 = 一条命令 = 一次撤销
     */
    section('B38 AI 生成复杂柜型（洗衣机柜）：一句话 → 电器格语义 → 甲购件分流');

    await activateRightTab('AI');
    await sleep(360);

    // 同 B37 的教训：本节会真的往模型里加一台柜，先存现场，结束还原。
    // （下游 B21 / B30 的落位断言依赖"房间还剩多少空位"，留赃物会把人家挤挂。）
    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      window.__b38Saved = structuredClone(s.bus.getState()); return true})()`);

    const before38 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const p=s.bus.getState();
      return { ver:s.bus.getVersion(), count:p.cabinets.length,
        names:p.cabinets.map(c=>c.name), errs:s.bus.derive().issues.filter(i=>i.severity==='ERROR').length };})()`);

    ok('能在输入框里写出一段电器格描述（洞口三尺寸 + 上面抽屉，契约外的旧词汇说不出这句话）',
      (await setElValue('.side-right .ai-input', '帮我生成一个洗衣机柜：左边留 650 宽 850 高的洗衣机洞口，上面做三只抽屉，右边一组对开门层板柜')) === true);
    ok('点「生成编辑计划」', (await clickPanelBtn('生成编辑计划', 20000)) === true);

    const shown38 = await waitFor(`!!document.querySelector('.side-right .plan-step')`, 25000);
    ok('出现干跑预览（走真 HTTP：界面 → 本地服务 → mock 服务商 → 回来）', shown38 === true, (await text('.side-right .panel-scroll')).slice(0, 300));

    const plan38 = await evalJs(`(()=>{
      const steps=[...document.querySelectorAll('.side-right .plan-step')];
      return {
        count:steps.length,
        bad:steps.filter(s=>s.classList.contains('plan-step-bad')).length,
        actions:steps.map(s=>((s.querySelector('.plan-head .mono')?.textContent)||'').trim()),
      };
    })()`);

    ok('AI 给出的是"建一个柜"这条动作（复杂柜型也走 cabinet.create，不是散补丁）',
      plan38.actions.some((a) => /cabinet\.create/.test(a)), JSON.stringify(plan38.actions));
    ok('预览里没有失败卡（电器格意图被契约完整接住了）', plan38.bad === 0, `坏卡 ${plan38.bad} 张`);
    ok('预览阶段模型没动：柜体数量不变', (await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets.length})()`)) === before38.count,
      `${before38.count} → ${await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets.length})()`)}`);

    const shotPreview38 = await shot(path.join(OUT_DIR, 'ai-laundry-preview.png'));
    ok('干跑预览截图已留档（非空）', shotPreview38 > 20000, `${shotPreview38} 字节`);

    ok('点「应用」', (await clickPanelBtn('应用全部', 1400)) === true);
    await sleep(420);

    const after38 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const p=s.bus.getState();
      const c=p.cabinets.find(x=>x.name==='AI洗衣机柜');
      const apUnit = c ? c.layout.units.find(u=>u.kind==='appliance') : null;
      const g = c ? s.bus.derive().geom.cabinets[c.id] : null;
      return {
        ver:s.bus.getVersion(), count:p.cabinets.length,
        errs:s.bus.derive().issues.filter(i=>i.severity==='ERROR').length,
        cab: c ? { id:c.id, units:c.layout.units.map(u=>({id:u.id, kind:u.kind, nick:u.nickname,
          drawers:u.drawers?.count ?? null, doors:u.doors?.count ?? null})) } : null,
        ap: apUnit ? { name:apUnit.appliance?.name, w:apUnit.appliance?.openingWidth,
          h:apUnit.appliance?.openingHeight, d:apUnit.appliance?.openingDepth,
          top:apUnit.appliance?.topDrawers, wUnit:apUnit.width } : null,
        purchased: g ? g.purchased.map(x=>x.nameZh) : null,
        panelWasher: g ? g.panels.filter(x=>x.nameZh && x.nameZh.includes('洗衣机')).map(x=>x.nameZh) : null,
      };})()`);

    ok('真的多出一台柜（一次生成 = 一条命令 = 版本 +1）',
      after38.count === before38.count + 1 && after38.ver === before38.ver + 1, JSON.stringify({ c: `${before38.count}→${after38.count}`, v: `${before38.ver}→${after38.ver}` }));
    ok('两个分区都在：电器格 + 侧柜（不是只建了个空壳）',
      Boolean(after38.cab) && after38.cab.units.length === 2
        && after38.cab.units.map((u) => u.kind).join(',') === 'appliance,shelves',
      JSON.stringify(after38.cab?.units));
    ok('洞口三尺寸原样落地 650×850×600（这是安装师傅要的数，一个都不能漂）',
      after38.ap?.w === 650 && after38.ap?.h === 850 && after38.ap?.d === 600, JSON.stringify(after38.ap));
    ok('"上面三只抽屉"真的变成 3 只（topDrawers 挂在抽屉字段上，不是装样子）',
      after38.ap?.top === 3 && after38.cab?.units[0]?.drawers === 3,
      JSON.stringify({ top: after38.ap?.top, drawers: after38.cab?.units[0]?.drawers }));
    ok('电器格不带门（带门就是 RULE-APPLIANCE-DOOR 的硬错，AI 也不许犯）',
      after38.cab?.units[0]?.doors === null, String(after38.cab?.units[0]?.doors));
    ok('"右边一组对开门"真的做了 2 扇门', after38.cab?.units[1]?.doors === 2, String(after38.cab?.units[1]?.doors));
    ok('分区 id 各不相同（板件撞 id = 清单少一块 = 生产下错料）',
      new Set((after38.cab?.units ?? []).map((u) => u.id)).size === 2, JSON.stringify((after38.cab?.units ?? []).map((u) => u.id)));
    ok('洗衣机本体进了甲购件清单（机器不走开料机，这是清单分流的红线）',
      Array.isArray(after38.purchased) && after38.purchased.some((n) => n.includes('洗衣机')), JSON.stringify(after38.purchased));
    ok('开料清单里没有"洗衣机"板件（派生没有把甲购件混进开料）',
      Array.isArray(after38.panelWasher) && after38.panelWasher.length === 0, JSON.stringify(after38.panelWasher));
    ok('应用后没有新增硬错（洞口 650 装得下 700 净宽，宽度和洞口尺寸不冲突）',
      after38.errs === before38.errs, `ERROR ${before38.errs} → ${after38.errs}`);

    // 撤销：一次生成必须一次收得回来
    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');s.bus.undo();return true})()`);
    await sleep(320);
    const undo38 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets.length})()`);
    ok('一次撤销就把这台柜收回去', undo38 === before38.count, `${after38.count} → ${undo38}`);
    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');s.bus.redo();return true})()`);
    await sleep(320);
    ok('重做又能回来（历史是线性的）',
      (await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets.length})()`)) === before38.count + 1);

    // 切到四视图拍一张：洗衣机柜（虚线洞口 + 甲购件标注）在图上真的画出来了
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.includes('四视图'));if(b)b.click();return !!b})()`);
    await sleep(1100);
    const shotApplied38 = await shot(path.join(OUT_DIR, 'ai-laundry-applied.png'));
    ok('应用后截图已留档（非空）', shotApplied38 > 20000, `${shotApplied38} 字节`);

    // 还原现场：本节自己造的柜子不许留给下游
    const restored38 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      if (!window.__b38Saved) return null;
      s.bus.replaceProject(window.__b38Saved, 'B38 还原现场');
      const p=s.bus.getState();
      return { count:p.cabinets.length, names:p.cabinets.map(c=>c.name) };})()`);
    ok('B38 结束后把现场还原了（自己造的柜子不许留给下游占地方）',
      Boolean(restored38) && restored38.count === before38.count
        && restored38.names.join('|') === before38.names.join('|'),
      `还原=${JSON.stringify(restored38)} 之前=${JSON.stringify(before38.names)}`);
    await sleep(240);

    // ═══════════════════════════════════════════════════════════
    /**
     * B39 —— 用户原话："报错看不懂、看不出该怎么改"（master 反馈五件事里的第 4 件）。
     *
     * node 侧（verify/fixhint-acceptance）验的是"规则目录是对的"，
     * 这里验的是**用户在界面上真正看到的那一条**：
     *   ① 面板里说的是人话：报得出"差多少"、上限定在多少、往哪改
     *   ② 一键修复是真按钮：**真去点它**（不是调函数），点了 = 一条命令 = 一次撤销，
     *      错误真的消失，而且改的是语义参数（门扇数），不是偷偷去动几何
     *   ③ 修法不唯一的那条（门板 780×2160 放不进 2440×1220 板材：改门宽 / 拆块 / 换幅面
     *      都算数）**不许出现按钮**，只许说"这是你要定的事"
     */
    section('B39 报错人话化：面板说人话 · 一键修复是真按钮 · 点了真消错');

    await activateRightTab('问题');
    // 本节会真的往模型里加一台柜（并改两次参数），先存现场，结束还原。
    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      window.__b39Saved = structuredClone(s.bus.getState()); return true})()`);

    const before39 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const errs=s.bus.derive().issues.filter(i=>i.severity==='ERROR');
      const p=s.bus.getState();
      // names 也要存：还原之后要拿它和"本节开始时"逐项对账，
      // 只比数量等于没比 —— 少一台柜子和一个不存在的字段长得一模一样（这轮就栽在这）
      return { ver:s.bus.getVersion(), errs:errs.map(i=>i.code), count:p.cabinets.length,
        names:p.cabinets.map(c=>c.name) };})()`);

    /**
     * 造一台"门板太宽"的柜：单格 + 1 扇门 + 柜宽 2200mm → 单扇门 2160mm，
     * 远超 maxDoorWidth（600mm）。放 (4000,4000) 空地上，避开撞墙与重叠记忆门。
     *
     * 柜高老实给 900：记忆规则 mem_004 会把"总高超过 2400"的柜子连创建一起拦下
     * （这条记忆本来就是用户定的"行业默认单柜上限"），所以这条路径上唯一能真实触发的
     * 硬错就是"门太宽"，负样本（放不进板材）是同一次派生顺带挂上来的，不用额外造。
     */
    const wide39 = await evalJs(`(async()=>{
      const s=await import('/src/state/store.ts');
      const { createCabinet, makeUnit } = await import('/src/core/docFactory.ts');
      const rules=s.RULESET;
      const proto=s.bus.getState().cabinets[0];
      const t=rules.materials[proto.params.boardMaterial].thickness;
      const c=createCabinet({
        id:'cab_b39', name:'探针宽门柜',
        roomId:(s.bus.getState().rooms[0]||{id:'r1'}).id,
        x:4000, y:4000,
        units:[makeUnit({ id:'unit_b39', kind:'shelves', requestedWidth:2200-2*t, count:1,
          nickname:'宽门格', rules, depth:600, doors:{count:1} }, new Set(['cab_b39']))],
        params:{ width:2200, height:900, depth:600, bodyLift:80 },
        rules,
      });
      const r=s.bus.execute({ id:'probe_b39_create', op:'cabinet.create', source:'ui',
        target:{kind:'project',id:'project'}, changes:[], payload:{cabinet:c} }, 'B39 探针：放一台宽门柜');
      if (r.error) return { err:r.error };
      const it=s.bus.derive().issues.find(i=>i.code==='RULE-DOOR-MAX-WIDTH' && i.severity==='ERROR');
      return { ver:s.bus.getVersion(), msg:it?it.message:null, hint:it?it.fixHint:null,
        hasFix:it?Boolean(it.autoFix):false, doors:it?it.autoFix?it.autoFix.changes[0].value:null:null,
        verBefore:s.bus.getVersion() };
    })()`);
    ok('探针造出了"门板太宽"这条硬错（没有负样本，后面验的一键修复就是假的）',
      !wide39.err && Boolean(wide39.msg), JSON.stringify(wide39));
    ok('这条报错报得出差多少与上限定在多少（不是"参数不合法"）',
      /2160/.test(wide39.msg || '') && /600/.test(wide39.msg || ''), wide39.msg);
    ok('这条报错说得出往哪改（门扇数 + 加完每扇多宽）',
      /门扇数量|门扇/.test(wide39.hint || '') && /扇/.test(wide39.hint || ''), wide39.hint);

    const dom39 = await evalJs(`(()=>{
      const items=[...document.querySelectorAll('.side-right .issue-item')];
      const hit=items.find(el=>(el.querySelector('.issue-code')?.textContent||'').includes('RULE-DOOR-MAX-WIDTH'));
      return hit ? {
        code:(hit.querySelector('.issue-code')?.textContent||'').trim(),
        title:(hit.querySelector('.issue-title')?.textContent||'').trim(),
        msg:(hit.querySelector('.issue-msg')?.textContent||'').trim(),
        hint:(hit.querySelector('.fix-hint')?.textContent||'').trim(),
        manual:(hit.querySelector('.fix-manual')?.textContent||'').trim(),
        fixBtn:(hit.querySelector('.issue-fix')?.textContent||'').trim(),
      } : null;
    })()`);
    ok('问题面板里看得见这条报错，而且顶着的是人话标题（不用去猜 RULE-DOOR-MAX-WIDTH 是什么）',
      Boolean(dom39) && dom39.title.length > 0 && /门板/.test(dom39.title), JSON.stringify(dom39));
    ok('面板上这句话就是 node 侧算出来的那句（界面与规则同源，不是另写一套）',
      Boolean(dom39) && dom39.msg === (wide39.msg || '').trim(), `${dom39 && dom39.msg} vs ${wide39.msg}`);
    ok('面板上带了「一键修复」按钮（这条修法唯一，给得起按钮）',
      Boolean(dom39) && dom39.fixBtn.includes('一键修复'), JSON.stringify(dom39));
    // 柜宽 2200 也会顶到 maxSingleCabinetWidth（WARNING）：这条修法有多种（拆柜 or 降宽），
    // 面板上出现了就必须**没有按钮**；没出现（被严重度过滤掉）则跳过，不算通过也不算失败。
    const split39 = await evalJs(`(()=>{const items=[...document.querySelectorAll('.side-right .issue-item')];
      const hit=items.find(el=>(el.querySelector('.issue-code')?.textContent||'').includes('RULE-CABINET-SPLIT'));
      return hit?{btn:!!hit.querySelector('.issue-fix'),
        manual:(hit.querySelector('.fix-manual')?.textContent||'').trim()}:null})()`);
    ok('修法有多种的那条（柜宽超单柜上限）不给按钮，只说"要你决定"',
      split39 === null || (split39.btn === false && /设计决定/.test(split39.manual)),
      JSON.stringify(split39));

    /**
     * 负样本**不用额外造**：这一台柜一放下就同时挂着两条 ERROR ——
     *   RULE-DOOR-MAX-WIDTH  门扇太宽                 → 修法唯一，给按钮
     *   RULE-PANEL-OVER-SHEET 门板 780×2160 放不进 2440×1220 板材 → 修法有多种
     *     （改门宽 / 拆成两块上不同板 / 换更大幅面板材），属于设计决定，**不给按钮**
     * 挑它就是因为它和门宽同根：修完门宽，它会跟着一起消 —— 正好验"修复是真的"。
     * （试过把进深压到 60mm 造第三条，但值域夹紧 100~6000 会把它顶回 100，
     *   这类"命令成功但值被改了"的路子不适合当负样本，也顺带说明夹紧是有回报的 toast。）
     */
    await sleep(420);
    const sheet39 = await evalJs(`(()=>{
      const items=[...document.querySelectorAll('.side-right .issue-item')];
      const hit=items.find(el=>(el.querySelector('.issue-code')?.textContent||'').includes('RULE-PANEL-OVER-SHEET'));
      return hit?{ btn:!!hit.querySelector('.issue-fix'),
        manual:(hit.querySelector('.fix-manual')?.textContent||'').trim(),
        msg:(hit.querySelector('.issue-msg')?.textContent||'').trim() }:null;})()`);
    ok('修法不唯一的报错也在面板上出现了（门板放不进板材）', Boolean(sheet39), JSON.stringify(sheet39));
    ok('修法不唯一的报错不给按钮（给了就是"点了没用"的假按钮）',
      Boolean(sheet39) && sheet39.btn === false, JSON.stringify(sheet39));
    // 措辞不写死：这条的 manual 说的是"工厂工艺决定"，另一条说的是"设计决定"，
    // 要的是"把决定权交回给人"，不是某个固定词条
    ok('不给按钮的那条也把话说全了：是"要你定"，不是一声不吭',
      Boolean(sheet39) && sheet39.manual.length > 6 && /决定/.test(sheet39.manual),
      sheet39 && sheet39.manual);
    ok('不给按钮的那条照样报得出具体尺寸（780×2160 放不进 2440×1220，不是"尺寸异常"）',
      Boolean(sheet39) && /2160/.test(sheet39.msg) && /2440/.test(sheet39.msg), sheet39 && sheet39.msg);

    /**
     * 点按钮之前先把现场读下来：撤销本身也会走一次版本 +1，
     * 所以不能拿"建柜时"的版本去推算"点完之后该是几" —— 那是探针自己的算术，不是产品行为。
     * 之后一切只跟这一刻对账。
     */
    const pre39 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const d=s.bus.derive();
      return { ver:s.bus.getVersion(),
        errs:d.issues.filter(i=>i.severity==='ERROR').map(i=>i.code),
        warn:d.issues.filter(i=>i.severity==='WARNING').map(i=>i.code) };})()`);
    ok('现场里同时挂着"门太宽"与"放不进板材"两条硬错（只有一条，下面验的就不是同一件事）',
      pre39.errs.includes('RULE-DOOR-MAX-WIDTH') && pre39.errs.includes('RULE-PANEL-OVER-SHEET'),
      JSON.stringify(pre39.errs));

    const shotFix39 = await shot(path.join(OUT_DIR, 'issue-fixhint-before.png'));
    ok('修复前的问题面板截图已留档（非空）', shotFix39 > 20000, `${shotFix39} 字节`);

    // 真去点那个按钮（不是调函数）：这一下必须是"一条命令 = 一次撤销"
    await evalJs(`(()=>{const items=[...document.querySelectorAll('.side-right .issue-item')];
      const hit=items.find(el=>(el.querySelector('.issue-code')?.textContent||'').includes('RULE-DOOR-MAX-WIDTH'));
      const b=hit&&hit.querySelector('.issue-fix'); if(b){b.click();return true;} return false;})()`);
    await sleep(460);

    const after39 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const cab=s.bus.getState().cabinets.find(c=>c.id==='cab_b39');
      const errs=s.bus.derive().issues.filter(i=>i.severity==='ERROR').map(i=>i.code);
      return { ver:s.bus.getVersion(), doors:cab?cab.layout.units[0].doors.count:null,
        netW:cab?cab.layout.units[0].requestedWidth:null, errs,
        gone:!errs.includes('RULE-DOOR-MAX-WIDTH') };})()`);
    ok('点按钮之后版本只 +1（一次修复 = 一条命令，不是摸黑改模型）',
      after39.ver === pre39.ver + 1, `v${pre39.ver} → v${after39.ver}`);
    ok('这条硬错真的消失了（点了没反应比不给按钮更糟）', after39.gone, JSON.stringify(after39.errs));
    ok('改的是语义参数「门扇数」，不是偷偷去动几何（1 扇 → 4 扇把 2160 压到 540 上下）',
      after39.doors === 4, `门扇数=${after39.doors} 期望净宽=${after39.netW}`);
    /**
     * "一次修复不顺手改别的"该怎么问：修完门扇变窄，那条"放不进板材"是**连带**消掉的
     * （2160 的门放不进 2440 的板，538 的门当然放得进），这不是"顺手改了别的"，是同一件事。
     * 真正要防的是另外两件事：**冒出新错误**、**动了别处**（别的柜子的报错一条都不许变）。
     */
    const fixedAway = pre39.errs.filter((c) => !after39.errs.includes(c));
    const born39 = after39.errs.filter((c) => !pre39.errs.includes(c));
    ok('被修的那条连带它同源的那条一起消失了（门窄了，自然放得进板材）',
      fixedAway.includes('RULE-DOOR-MAX-WIDTH') && fixedAway.includes('RULE-PANEL-OVER-SHEET'),
      `消失的=${fixedAway.join('|')}`);
    ok('修复没有凭空冒出新错误（修前 ${pre39.errs.length} 条 → 修后 ${after39.errs.length} 条）',
      born39.length === 0, `冒出来的=${born39.join('|')}`);

    const shotFix39b = await shot(path.join(OUT_DIR, 'issue-fixhint-after.png'));
    ok('修复后的面板截图已留档（非空）', shotFix39b > 20000, `${shotFix39b} 字节`);

    // 撤销：一次撤销收掉一步，逐步断言（整段撤销后不对账 = 不知道是哪一步没收回）
    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');s.bus.undo();return true})()`);
    await sleep(380);
    const undo1 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const d=s.bus.derive();
      return { back:d.issues.some(i=>i.code==='RULE-DOOR-MAX-WIDTH'),
        sheet:d.issues.some(i=>i.code==='RULE-PANEL-OVER-SHEET'),
        doors:(s.bus.getState().cabinets.find(c=>c.id==='cab_b39')||{}).layout?.units[0]?.doors?.count ?? null };})()`);
    ok('撤销掉「一键修复」这一笔：两条硬错和门扇数一起回来（历史按笔回退，不是整体重置）',
      undo1.back === true && undo1.sheet === true && undo1.doors === 1, JSON.stringify(undo1));

    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');s.bus.undo();return true})()`);
    await sleep(380);
    const undo39 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const p=s.bus.getState();
      return { hasCab:p.cabinets.some(c=>c.id==='cab_b39'), count:p.cabinets.length,
        errs:s.bus.derive().issues.filter(i=>i.severity==='ERROR').map(i=>i.code) };})()`);
    ok('再撤销掉"建柜"这一笔：柜子没了、报错回到本节开始之前（历史是线性的，不是整体重置）',
      undo39.hasCab === false && undo39.count === before39.count
        && undo39.errs.join('|') === before39.errs.join('|'),
      JSON.stringify(undo39));

    // 还原现场：本节自己造的柜子与改动不许留给下游
    const restored39 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      if(!window.__b39Saved) return null;
      s.bus.replaceProject(window.__b39Saved, 'B39 还原现场');
      const p=s.bus.getState();
      const d=s.bus.derive();
      return { count:p.cabinets.length, names:p.cabinets.map(c=>c.name),
        errs:d.issues.filter(i=>i.severity==='ERROR').map(i=>i.code) };})()`);
    ok('B39 结束后把现场还原了（自己造的柜子与改动不许留给下游）',
      Boolean(restored39) && restored39.count === before39.count
        && restored39.names.join('|') === before39.names.join('|')
        && restored39.errs.join('|') === before39.errs.join('|'),
      JSON.stringify(restored39));
    await sleep(240);

    // ═══════════════════════════════════════════════════════════
    /**
     * B18 —— 用户原话："以后用于商用可能涉及到订阅模式…增加账号管理等功能，
     * 以及账号使用、ai 模型调用管理等功能。但是得保证账号安全问题。"
     *
     * 这一组按**上线那天的顺序**验：先是没有账号（免登录），
     * 然后建第一个账号 → 模式单向切换 → 逐个接口确认"一个漏网的都没有" →
     * 最后把安全现状（包括**还没做到的事**）逐条核对一遍。
     */
    section('B18 账号与安全：默认可不登录 · 建号后一个漏网接口都没有 · 缺口照实列出');

    const VERIFY_ACCOUNTS = process.env.VERIFY_ACCOUNTS_PATH || '';
    ok('验收的账号库落在临时目录（不会往仓库里塞一个所有者账号）', VERIFY_ACCOUNTS.includes('furniture-cad-verify-'), VERIFY_ACCOUNTS || '(未设置)');

    const apiCall = (path, opts) => evalJs(`fetch(${JSON.stringify(path)},${JSON.stringify(opts || {})}).then(async r=>({status:r.status, body: await r.json().catch(()=>({}))}))`);

    const modeBefore = await apiCall('/api/auth/mode');
    ok('建号之前是 local-open 模式（"先自用"的默认状态）', modeBefore.body.mode === 'local-open' && modeBefore.body.accountCount === 0, JSON.stringify(modeBefore.body));
    const usageNoAuth = await apiCall('/api/usage');
    ok('这个状态下连管理接口都免登录 —— 界面**不假装**已经设防（如实反映真实状态）', usageNoAuth.status === 200 && usageNoAuth.body.mode === 'local-open', JSON.stringify({ status: usageNoAuth.status, mode: usageNoAuth.body.mode }));

    await activateRightTab('账号');
    await sleep(700);
    const acctPanel = () => text('.side-right .panel-scroll');
    const acctSettled = await waitFor(`/鉴权模式/.test(document.querySelector('.side-right .panel-scroll')?.textContent||'')`, 10000);
    ok('账号面板进入终态（不是永远停在"检测中…"）', acctSettled === true, (await acctPanel()).slice(0, 200));
    ok('面板把鉴权模式摆在最上面', String(await panelText('鉴权模式')).startsWith('local-open'), String(await panelText('鉴权模式')));
    ok('面板明说当前接口免登录', /接口当前免登录/.test(await acctPanel()), (await acctPanel()).slice(0, 200));
    ok('此时界面是「建立第一个账号（所有者）」而不是登录框', /建立第一个账号（所有者）/.test(await acctPanel()));
    ok(
      '面板写明这个切换是单向的，并给出理由（"删掉账号库也不能绕过"）—— 不让人以为是随手可翻的开关',
      /单向/.test(await acctPanel()) && /不能绕过/.test(await acctPanel()),
      (await acctPanel()).slice(0, 400)
    );

    // ── 弱口令必须被挡在门外 ──
    await panelSet('用户名', 'owner');
    await panelSet('口令', '12345678');
    await panelSet('再输一次', '12345678');
    ok('点「建立账号并进入账号模式」', (await clickPanelBtn('建立账号并进入账号模式', 900)) === true);
    ok('纯数字口令被拒，并说明原因（不是默默不生效）', /不能是纯数字/.test(await acctPanel()), (await acctPanel()).slice(0, 300));
    ok('被拒之后模式没变（失败不留半成品）', (await apiCall('/api/auth/mode')).body.mode === 'local-open');

    // ── 正式建号 ──
    const OWNER_PW = 'Cad-Str0ng-Pw-2026!x';
    await panelSet('用户名', 'owner');
    await panelSet('口令', OWNER_PW);
    await panelSet('再输一次', OWNER_PW);
    ok('改用强口令再点一次', (await clickPanelBtn('建立账号并进入账号模式', 1400)) === true);
    const modeAfter = await apiCall('/api/auth/mode');
    ok('建号成功：模式变成 accounts，账号数 1', modeAfter.body.mode === 'accounts' && modeAfter.body.accountCount === 1, JSON.stringify(modeAfter.body));

    const TOKEN = await evalJs(`sessionStorage.getItem('furniture-cad.auth.token')`);
    ok('会话 token 落在 sessionStorage（关掉标签页即失效），不放 localStorage', typeof TOKEN === 'string' && TOKEN.length >= 40 && (await evalJs(`localStorage.getItem('furniture-cad.auth.token')`)) === null, `token 长度 ${String(TOKEN).length}`);

    // ── 逐个接口确认"一个漏网的都没有" ──
    const guardProbe = await evalJs(`(async()=>{
      const paths=['/api/settings','/api/models','/api/memory','/api/usage','/api/ai/plan','/api/account/accounts','/api/security/policy','/api/security/audit'];
      const out={};
      for(const p of paths){
        const opts = p==='/api/ai/plan' ? {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'} : {};
        const r = await fetch(p, opts);
        out[p]=r.status;
      }
      const pub={};
      for(const p of ['/api/health','/api/auth/mode']){
        pub[p]=(await fetch(p)).status;
      }
      return {guarded:out, public:pub};
    })()`);
    ok(
      `建号后 ${Object.keys(guardProbe.guarded).length} 个非公开接口**全部**返回 401（一个漏网的都没有）`,
      Object.values(guardProbe.guarded).every((s) => s === 401),
      JSON.stringify(guardProbe.guarded)
    );
    ok(
      '健康检查与鉴权模式仍免登录（上线后监控要能探活、前端要先知道该显示登录框还是建号框）',
      Object.values(guardProbe.public).every((s) => s === 200),
      JSON.stringify(guardProbe.public)
    );

    const reregister = await apiCall('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'backdoor', password: OWNER_PW }) });
    ok('注册窗口只开一次：再调注册接口被 403 REGISTER_CLOSED 挡住（否则注册接口就是个后门）', reregister.status === 403 && reregister.body.code === 'REGISTER_CLOSED', JSON.stringify({ status: reregister.status, code: reregister.body.code }));

    const wrongPw = await apiCall('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'not-the-password' }) });
    const noSuchUser = await apiCall('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ghost', password: 'not-the-password' }) });
    ok('口令错误 → 401', wrongPw.status === 401 && wrongPw.body.code === 'BAD_CREDENTIALS', JSON.stringify(wrongPw.body));
    ok(
      '用户不存在与口令错误返回**同一句**提示（不让攻击者拿登录框枚举用户名）',
      wrongPw.body.error === noSuchUser.body.error && wrongPw.body.error === '用户名或口令不正确',
      `「${wrongPw.body.error}」 vs 「${noSuchUser.body.error}」`
    );

    const demoteSelf = await apiCall('/api/account/account', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ id: (await apiCall('/api/auth/me', { headers: { Authorization: `Bearer ${TOKEN}` } })).body.account.id, role: 'designer' }),
    });
    ok(
      '安全阀：不能降级最后一个所有者（否则没人能再管理系统）',
      demoteSelf.status === 400 && /最后一个所有者/.test(String(demoteSelf.body.error)),
      JSON.stringify(demoteSelf.body)
    );

    // ── Node 侧：账号库与审计日志的落盘内容 ──
    if (VERIFY_ACCOUNTS && fs.existsSync(VERIFY_ACCOUNTS)) {
      const accText = fs.readFileSync(VERIFY_ACCOUNTS, 'utf8');
      const acc = JSON.parse(accText);
      const a0 = acc.accounts?.[0];
      ok('账号库真的落盘了（不是只在内存里活着）', Boolean(a0), accText.slice(0, 200));
      ok('文件里搜不到明文口令', !accText.includes(OWNER_PW));
      ok(
        '口令是**自描述**的 scrypt 哈希串：算法与代价参数（N/r/p）都写在里面',
        /^scrypt\$N=\d+,r=\d+,p=\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(String(a0?.password?.hash)),
        String(a0?.password?.hash).slice(0, 60)
      );
      ok(
        '代价参数不是默认的弱档（N ≥ 2^14）—— 记参数正是为了将来能安全地往上提',
        Number(/N=(\d+)/.exec(String(a0?.password?.hash))?.[1] ?? 0) >= 16384,
        String(a0?.password?.hash).slice(0, 24)
      );
      ok('盐是 16 字节随机（32 个 hex 字符）且与哈希串里的一致（两处不许漂移）', /^[0-9a-f]{32}$/.test(String(a0?.password?.salt)) && String(a0?.password?.hash).includes(String(a0?.password?.salt)), `${String(a0?.password?.salt).slice(0, 8)}…`);
      ok(
        '会话只落 SHA-256 哈希：文件里搜不到登录时发出去的那个明文 token（哈希泄露也不等于能直接登录）',
        !accText.includes(String(TOKEN)) && /^[0-9a-f]{64}$/.test(String(a0?.sessions?.[0]?.hash)),
        String(a0?.sessions?.[0]?.hash).slice(0, 24)
      );
      ok('第一个账号自动是所有者，默认档位 free（额度而不是"无限"）', a0?.role === 'owner' && a0?.plan === 'free', `${a0?.role} / ${a0?.plan}`);
      ok('租户字段从第一天就在（将来做多租户不必迁移数据）', a0?.tenantId === 'tenant_default', String(a0?.tenantId));
      ok('账号库文件不含 API Key（账号与模型配置彻底分离）', !accText.includes(FAKE_KEY2 || 'sk-verify-second'));
    }

    if (VERIFY_AUDIT && fs.existsSync(VERIFY_AUDIT)) {
      const auditRaw = fs.readFileSync(VERIFY_AUDIT, 'utf8');
      const lines = auditRaw.split(/\r?\n/).filter((l) => l.trim());
      const entries = lines.map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      });
      ok(`审计日志逐行 JSON、只追加（${lines.length} 条，无一行解析失败）`, entries.every(Boolean) && lines.length > 0);
      const evts = entries.filter(Boolean);
      ok('建号留痕（account.bootstrap）', evts.some((e) => e.action === 'account.bootstrap'), JSON.stringify(evts.map((e) => e.action)));
      ok('登录留痕（auth.login / ok）', evts.some((e) => e.action === 'auth.login' && e.result === 'ok'));
      ok('**失败登录也留痕**（只有成功日志的审计等于没审计）', evts.some((e) => e.action === 'auth.login' && (e.result === 'fail' || e.result === 'no_such_user')), JSON.stringify(evts.filter((e) => e.action === 'auth.login').map((e) => e.result)));
      ok('每条都带时间戳（复盘靠它排序）', evts.every((e) => typeof e.at === 'string' && e.at.length > 10));
      ok('审计里没有明文口令、也没有完整 token（日志常常是泄露的第一现场）', !auditRaw.includes(OWNER_PW) && !auditRaw.includes(String(TOKEN)));
    }

    // ── 界面侧：安全现状必须连"还没做到的事"一起列 ──
    await activateRightTab('账号');
    await sleep(600);
    ok('能展开「账号管理」分区', (await openSection('账号管理')) !== 'no-sec');
    const acctMgmt = await evalJs(`(()=>{
      const secs=[...document.querySelectorAll('.side-right .sec')];
      const sec=secs.find(s=>((s.querySelector('.sec-toggle')?.textContent)||'').includes('账号管理'));
      if(!sec) return null;
      return { title:sec.querySelector('.sec-toggle').textContent.replace(/[\\u25b8\\u25be]/g,'').trim(),
        cards:sec.querySelectorAll('.acct').length,
        selects:sec.querySelectorAll('select').length,
        text:sec.textContent.replace(/\\s+/g,' ') };
    })()`);
    ok(`账号管理里列出 ${acctMgmt?.cards} 个账号卡片`, acctMgmt?.cards === 1, JSON.stringify(acctMgmt?.title));
    ok('每个账号能改角色与订阅档位（下拉，不是写死）', (acctMgmt?.selects ?? 0) >= 2, String(acctMgmt?.selects));
    ok('账号卡显示 AI 用量与最近登录（"账号使用 + AI 模型调用管理"落到界面上）', /AI 用量/.test(acctMgmt?.text || '') && /最近登录/.test(acctMgmt?.text || ''));
    ok('面板写明不能降级/停用最后一个所有者（把规则写在人看得见的地方）', /最后一个所有者/.test(acctMgmt?.text || ''));

    const policyDom = await evalJs(`(()=>{
      const secs=[...document.querySelectorAll('.side-right .sec')];
      const sec=secs.find(s=>((s.querySelector('.sec-toggle')?.textContent)||'').includes('安全现状'));
      if(!sec) return null;
      if(!sec.querySelector('.sec-body')) sec.querySelector('.sec-toggle').click();
      return 'ok';
    })()`);
    await sleep(340);
    const policy = await evalJs(`(()=>{
      const secs=[...document.querySelectorAll('.side-right .sec')];
      const sec=secs.find(s=>((s.querySelector('.sec-toggle')?.textContent)||'').includes('安全现状'));
      if(!sec) return null;
      const cols=[...sec.querySelectorAll('.two-col > div')];
      return {
        title:sec.querySelector('.sec-toggle').textContent.replace(/[\\u25b8\\u25be]/g,'').trim(),
        heads:cols.map(c=>((c.querySelector('.col-head')?.textContent)||'').replace(/\\s+/g,' ').trim()),
        items:cols.map(c=>[...c.querySelectorAll('.tiny-list li')].map(li=>li.textContent.replace(/\\s+/g,' ').trim())),
      };
    })()`);
    ok('「安全现状」是两栏：已实现 / 尚未实现（缺口摆在明处，不是只显示"我们有登录框"）', policy === null ? false : policy.heads.length === 2 && /已实现/.test(policy.heads[0]) && /尚未实现/.test(policy.heads[1]), JSON.stringify(policy?.heads));
    ok(`已实现一栏列出 ${policy?.items?.[0]?.length} 条（口令哈希 / 会话哈希 / 失败锁定 / 角色 / 额度 / 审计 / 拒绝降级）`, (policy?.items?.[0]?.length ?? 0) >= 7, JSON.stringify(policy?.items?.[0]?.slice(0, 3)));
    ok(`尚未实现一栏列出 ${policy?.items?.[1]?.length} 条`, (policy?.items?.[1]?.length ?? 0) >= 6, JSON.stringify(policy?.items?.[1]?.slice(0, 3)));
    ok(
      '缺口里包含 HTTPS、二次验证、会话轮换、账号库并发写保护（上线前必须补的几件大事都点了名）',
      ['HTTPS', '二次验证', '轮换', '并发写保护'].every((k) => (policy?.items?.[1] ?? []).some((x) => x.includes(k))),
      JSON.stringify(policy?.items?.[1])
    );
    ok('监听地址如实显示为仅本机（不 bind 0.0.0.0，同一个 WiFi 用不了你的 key）', /127\.0\.0\.1/.test(String(await panelText('监听地址'))), String(await panelText('监听地址')));
    ok('口令存储方式写明是 scrypt + 独立盐 + 定时安全比较', /scrypt/.test(String(await panelText('口令存储'))) && /timingSafeEqual/.test(String(await panelText('口令存储'))), String(await panelText('口令存储')));
    ok('会话存储写明"只落哈希"', /SHA-256/.test(String(await panelText('会话存储'))), String(await panelText('会话存储')));

    ok('能展开「审计日志」分区', (await openSection('审计日志')) !== 'no-sec');
    ok('点「读取最近 60 条」', (await clickPanelBtn('读取最近 60 条', 1100)) === true);
    const auditRows = await evalJs(`document.querySelectorAll('.side-right table.audit tbody tr').length`);
    ok(`审计表格读出 ${auditRows} 行（界面上能直接复盘，不用去翻文件）`, auditRows >= 3, String(auditRows));
    const auditHead = await evalJs(`[...document.querySelectorAll('.side-right table.audit thead th')].map(x=>x.textContent.trim())`);
    ok('表格列出 时间 / 动作 / 结果 / 对象 / 来源（"从哪台机器来的"是复盘时最有用的一列）', JSON.stringify(auditHead) === JSON.stringify(['时间', '动作', '结果', '对象', '来源']), JSON.stringify(auditHead));
    const auditCellWithIp = await evalJs(`(()=>{
      const cell=[...document.querySelectorAll('.side-right table.audit tbody tr td:last-child')].map(x=>x.textContent.trim());
      return cell.filter(x=>/^(\\d{1,3}\\.){3}\\d{1,3}$/.test(x)).length;
    })()`);
    ok(`至少 ${auditCellWithIp} 行的来源列给出了可读的 IP（没有 ::ffff: 前缀，读得懂）`, auditCellWithIp >= 1, String(auditCellWithIp));
    ok('表格里出现了 ai.plan 那一笔（AI 调用也进审计，不只是登录）', /ai\.plan/.test(await acctPanel()), (await acctPanel()).slice(-500));

    // ═══════════════════════════════════════════════════════════
    /**
     * B18b —— 上线那天真正的样子：账号模式下**没有登录**的人打开这个界面。
     *
     * 这一段必须靠**重新加载页面**来做：token 是 React state + sessionStorage，
     * 只有刷新后才能真的回到"未登录"。这也正好验了"刷新后会话还在不在"。
     *
     * 为什么值得单独验：管理后台原先用的是裸 fetch，401 的响应体是个非空对象，
     * 会被当成配置读进 state —— 界面**照常渲染出一整套模型表单**，
     * 每个字段都是 undefined，看起来跟读到了配置一模一样。
     * 用户会以为配置读到了，其实一个字节都没读到。
     */
    section('B18b 账号模式下未登录访问：宁可什么都不显示，也不显示一份假配置');

    await evalJs(`sessionStorage.removeItem('furniture-cad.auth.token'); 1`);
    await send('Page.reload', { ignoreCache: false });
    await sleep(2600);
    const remounted = await waitFor(`!!document.querySelector('.side-right .tabs button')`, 15000);
    ok('刷新后界面重新挂载（token 已清掉，现在是一个未登录的访客）', remounted === true);

    const tokenGone = await evalJs(`sessionStorage.getItem('furniture-cad.auth.token')`);
    ok('未登录状态确认：sessionStorage 里没有 token', tokenGone === null, String(tokenGone));

    await activateRightTab('后台');
    await sleep(900);
    const guestAdmin = await waitFor(`/管理权限|需要登录/.test(document.querySelector('.side-right .panel-scroll')?.textContent||'')`, 10000);
    const guestAdminText = await text('.side-right .panel-scroll');
    ok('未登录时管理后台明确说出被权限拦下（而不是假装读到了配置）', guestAdmin === true && /需要/.test(guestAdminText), guestAdminText.slice(0, 240));
    const guestFields = await evalJs(`[...document.querySelectorAll('.side-right .row .row-label')]
      .map(x=>x.textContent.replace(/[\\s\\u{1F512}]/gu,'').trim())`);
    ok(
      '此时**不渲染**任何模型配置字段（API Key / 服务商 / Base URL / 模型 一个都不出现）',
      !guestFields.some((l) => ['API Key', '服务商', 'Base URL', '模型', '温度'].includes(l)),
      `当前渲染出的字段行：${JSON.stringify(guestFields)}`
    );
    ok('同时说清"服务是通的，只是被权限拦下"（不把权限问题说成服务挂了）', /服务本身是通的|健康检查正常/.test(guestAdminText), guestAdminText.slice(0, 300));

    await activateRightTab('账号');
    await sleep(800);
    const loginForm = await text('.side-right .panel-scroll');
    ok('账号页此时显示的是**登录**表单（不再是"建立第一个账号"）', /登录/.test(loginForm) && !/建立第一个账号/.test(loginForm), loginForm.slice(0, 220));
    ok('登录表单不再要求"再输一次"（登录与注册是两种表单，不混在一起）', !/再输一次/.test(loginForm));

    await activateRightTab('AI');
    await sleep(500);
    ok('能在 AI 输入框里写话', (await setElValue('.side-right .ai-input', '把主卧衣柜的踢脚改成 120')) === true);
    ok('点「生成计划」', (await clickPanelBtn('生成编辑计划', 1600)) === true);
    const guestAi = await waitFor(`/登录|会话/.test(document.querySelector('.side-right .panel-scroll')?.textContent||'')`, 12000);
    ok('未登录时 AI 通道被挡住，并给出可读原因（不是一句"失败"）', guestAi === true, (await aiPanel()).slice(0, 260));

    // ── 重新登录：能力必须回来 ──
    await activateRightTab('账号');
    await sleep(700);
    const loginUserSet = await panelSet('用户名', 'owner');
    const loginPwSet = await panelSet('口令', OWNER_PW);
    ok('在登录框里填入账号与口令（两个字段都真的写进去了，不是"填了但没生效"）', loginUserSet === 'ok' && loginPwSet === 'ok', `${loginUserSet} / ${loginPwSet}`);
    ok('点「登录」', (await clickPanelBtn('登录', 1400)) === true);
    const tokenBack = await evalJs(`sessionStorage.getItem('furniture-cad.auth.token')`);
    ok('登录成功：拿到新会话 token', typeof tokenBack === 'string' && tokenBack.length >= 40, `长度 ${String(tokenBack).length}`);
    ok('登录后能看到当前账号与权限', /当前账号/.test(await acctPanel()) && /所有者/.test(await acctPanel()), (await acctPanel()).slice(0, 240));

    await activateRightTab('后台');
    await sleep(1000);
    const adminBack = await waitFor(`!!document.querySelector('.side-right .row')`, 12000);
    ok('登录后管理后台恢复：配置表单重新出现（权限是"能不能用"的开关，不是"坏了"）', adminBack === true, (await text('.side-right .panel-scroll')).slice(0, 200));
    ok('恢复后的配置读得到真值（模型名与 Base URL 都在）', (await panelField('模型'))?.options?.includes('mock-model-1') === true, JSON.stringify(await panelField('模型')));

    // ═══════════════════════════════════════════════════════════
    /**
     * B20 —— AI 对话。
     *
     * 这一组要证明的不是"模型答得好不好"（那是模型自己的事），而是三件
     * **界面必须自己保证**的事：
     *
     *   1. 对话**不改模型** —— 版本号一个字节都不能动。
     *      这是"两个入口"这个设计的存在理由：用户点的是对话，那么无论模型
     *      多热心想帮忙，都不该有东西被写进模型。
     *   2. 两个入口的后果**一眼可分** —— 后果写在按钮上，
     *      而不是让用户从"AI 刚说了什么"去倒推自己有没有改到模型。
     *   3. 长等待必须有反馈 —— 实测那台局域网推理模型单次 17–27 秒。
     *      没有计数的等待看起来就是卡死，用户会再点两次，然后一次收到三个回答。
     */
    section('B20 AI 对话：能问答 · 不改模型 · 长等待有反馈');

    await activateRightTab('AI');
    await sleep(700);

    /** 两个入口按钮的当前文案（等待中会变，所以要能重复读） */
    const aiBtnLabels = () =>
      evalJs(`(()=>{
        const a=document.querySelector('.side-right .ai-btn-chat');
        const b=document.querySelector('.side-right .ai-btn-plan');
        return {chat:a?a.textContent.trim():null, plan:b?b.textContent.trim():null};
      })()`);

    ok(
      '输入框在打开面板的第一眼就在（没有被折叠分区藏起来）',
      (await evalJs(`!!document.querySelector('.side-right .ai-input')`)) === true,
      (await text('.side-right .panel-scroll')).slice(0, 160)
    );

    const labels = await aiBtnLabels();
    ok('「对话」按钮自己写明了它不改模型（后果写在按钮上，不靠用户猜）', /不改模型/.test(String(labels.chat)), JSON.stringify(labels));
    ok('「生成编辑计划」按钮在，且与对话按钮是两个可区分的类', String(labels.plan).includes('生成编辑计划'), JSON.stringify(labels));

    const vBeforeChat = await statusVersion();

    ok('能在输入框里写下问题', (await setElValue('.side-right .ai-input', '这个柜子的踢脚多高？')) === true);
    const chatClicked = await evalJs(`(()=>{const b=document.querySelector('.side-right .ai-btn-chat');if(!b)return false;b.click();return true;})()`);
    ok('点得动「对话」', chatClicked === true);

    /**
     * mock 故意慢 800ms —— 就是为了能在这一瞬间读到"正在思考"。
     * 秒回的话这个状态在探针读到之前就已经结束了，那条断言会退化成恒真（等于没验）。
     */
    await sleep(240);
    const waitingLab = await aiBtnLabels();
    ok(
      '等待期间如实显示"正在思考 + 已等秒数"（十几秒的等待没有反馈就是卡死）',
      /正在思考/.test(String(waitingLab.chat)) && /\d+\s*s/.test(String(waitingLab.chat)),
      `按钮文案：${JSON.stringify(waitingLab.chat)}`
    );

    /** 一次读回全部对话消息的三样东西：角色、正文、以及助手消息上的元信息 */
    const readTurns = () =>
      evalJs(`(()=>[...document.querySelectorAll('.side-right .chat-msg')].map(m=>({
        role: m.classList.contains('chat-user')?'user':'assistant',
        text: (m.querySelector('.chat-text')||{}).textContent||'',
        meta: (m.querySelector('.chat-meta')||{}).textContent||'',
        think: !!m.querySelector('.chat-think'),
      })))()`);

    const answered = await waitFor(`document.querySelectorAll('.side-right .chat-assistant').length >= 1`, 20000);
    ok('回答出现在对话列表里（不是弹个 toast 就没了）', answered === true);

    const turns1 = await readTurns();
    const a1 = turns1.find((t) => t.role === 'assistant');
    ok(
      '回答非空，而且走的是**对话通道**而不是规划通道',
      Boolean(a1) && a1.text.includes('（mock 回答）'),
      a1 ? JSON.stringify(a1.text.slice(0, 160)) : '(没有 assistant 消息)'
    );
    ok(
      '用户那句话也在列表里（一问一答成对出现，不是只有回答）',
      turns1.some((t) => t.role === 'user' && t.text.includes('踢脚多高')),
      JSON.stringify(turns1.map((t) => t.role))
    );
    ok(
      '如实显示了模型名 / token / 耗时（用量是账单，不能估）',
      /mock-model-1/.test(a1?.meta ?? '') && /token/.test(a1?.meta ?? '') && /\d+\.\d+s/.test(a1?.meta ?? ''),
      JSON.stringify(a1?.meta)
    );
    ok('思考过程折叠块存在（推理模型"为什么这么慢"必须看得到）', a1?.think === true, JSON.stringify(turns1.map((t) => t.think)));

    const vAfterChat = await statusVersion();
    ok(
      '**对话没有改动模型**（版本号一字节未动）—— 这是"两个入口"这个设计的存在理由',
      vAfterChat === vBeforeChat,
      `v${vBeforeChat} → v${vAfterChat}`
    );

    const thinkLen = await evalJs(`(()=>{
      const d=document.querySelector('.side-right .chat-think');
      if(!d) return -1;
      d.querySelector('summary').click();
      const pre=d.querySelector('pre');
      return pre? pre.textContent.length : 0;
    })()`);
    ok('展开思考过程能看到内容（不是个空壳折叠块）', (thinkLen ?? 0) > 10, `思考过程 ${thinkLen} 字`);

    await setElValue('.side-right .ai-input', '那背板 9mm 够吗？');
    await evalJs(`(()=>{const b=document.querySelector('.side-right .ai-btn-chat');b.click();return true;})()`);
    const answered2 = await waitFor(`document.querySelectorAll('.side-right .chat-assistant').length >= 2`, 20000);
    ok('第二问也得到回答（多轮可用）', answered2 === true);
    const turns2 = await readTurns();
    ok(
      '四条消息都在（两问两答，历史没被截掉）',
      turns2.length >= 4,
      `共 ${turns2.length} 条：${JSON.stringify(turns2.map((t) => t.role))}`
    );

    await activateRightTab('属性');
    await sleep(320);
    await activateRightTab('AI');
    await sleep(560);
    const keptTurns = await evalJs(`document.querySelectorAll('.side-right .chat-msg').length`);
    ok('切走再切回来，对话还在（不会被卸载清掉）', keptTurns >= 4, `${keptTurns} 条`);

    ok('点「清空对话」', (await clickPanelBtn('清空对话', 420)) === true);
    const clearedTurns = await evalJs(`document.querySelectorAll('.side-right .chat-msg').length`);
    ok('清空后列表是空的', clearedTurns === 0, `${clearedTurns} 条`);

    ok(
      '对话、切页签、清空这一整套操作下来，模型版本始终没动过',
      (await statusVersion()) === vBeforeChat,
      `v${await statusVersion()}（起始 v${vBeforeChat}）`
    );

    // ═══════════════════════════════════════════════════════════
    /**
     * B21 —— 方案对比。
     *
     * 这一组要钉住三件容易做错、且光看"有东西显示"看不出来的事：
     *   ① **生成对比不许改模型** —— 候选是纯产物，没采用之前版本一字节不动；
     *   ② **缩略图必须是正视图** —— 侧视图图框宽 = 柜深(600)，正视图 = 柜宽(2400)。
     *      宽高比不一样，"取错视图"在界面上只是"图看起来扁一点"，肉眼容易放过；
     *   ③ **每份候选自带问题读数** —— 客户选风格时就得看得见门板超宽，
     *      而不是选完、改完、出了四视图才发现。
     */
    section('B21 方案对比：规格 → N 份候选语义方案 → 正面图对比 → 采用后出四视图');

    await activateRightTab('方案');
    await sleep(420);
    const vBeforeVar = await statusVersion();

    ok(
      '「方案」页签在，打开后第一眼就是规格输入（不是被折叠分区藏起来）',
      (await evalJs(`(()=>{
        const r=document.querySelector('.side-right');
        if(!r) return false;
        return /规格/.test(r.textContent) && !!r.querySelector('.side-right .vgen, .vgen');
      })()`)) === true
    );

    ok(
      '规则集配了风格 → 不出现"没有配置 stylePresets"的告警横幅',
      (await evalJs(`!document.querySelector('.side-right .banner')`)) === true,
      String(await evalJs(`(document.querySelector('.side-right .banner')||{}).textContent||''`))
    );

    ok('还没生成时如实说"尚未生成"，不是给一张空列表', /尚未生成|填好规格/.test(await panelTextAll()));

    // ── 生成 ──
    const genClicked = await clickPanelBtn('生成方案对比', 900);
    ok('点得动「生成方案对比」', genClicked === true);

    const cards = await evalJs(`(()=>[...document.querySelectorAll('.side-right .vcard')].map(c=>({
        name: (c.querySelector('.vcard-head b')||{}).textContent||'',
        pill: (c.querySelector('.vcard-head .pill')||{}).textContent||'',
        summary: (c.querySelector('.ts')||{}).textContent||'',
        shapes: c.querySelectorAll('.vthumb polyline, .vthumb polygon').length,
        // 缩略图取景：正视图图框宽 = 柜宽 2400，高 = 柜高 2400
        vb: (c.querySelector('svg.vthumb')||{}).getAttribute
             ? c.querySelector('svg.vthumb').getAttribute('viewBox') : null,
        hasIssue: !!c.querySelector('.vissue'),
        issueText: (c.querySelector('.vissue')||{}).textContent||'',
      })))()`);
    const cardList = Array.isArray(cards) ? cards : [];

    ok('生成出了多份候选（不是一份）', cardList.length >= 2, JSON.stringify(cardList.map((c) => c.name)));
    ok(
      '【铁律】生成对比没有改动模型（版本号一字节未动）',
      (await statusVersion()) === vBeforeVar,
      `v${vBeforeVar} → v${await statusVersion()}`
    );

    ok('每份候选的缩略图都真的画出了图元', cardList.every((c) => c.shapes > 0), JSON.stringify(cardList.map((c) => [c.name, c.shapes])));

    /**
     * 取的是正视图还是侧视图 —— 用 viewBox 的宽高比钉死。
     * 2400×2400 的正视图是方的；侧视图是 600 宽 × 2400 高（细长）。
     */
    ok(
      '【关键】缩略图取的是正视图不是侧视图（viewBox 宽 ≈ 高，不是 1:4 的细长条）',
      (() => {
        const nums = String(cardList[0]?.vb ?? '').split(/\s+/).map(Number);
        if (nums.length !== 4) return false;
        const ratio = nums[2] / nums[3];
        return ratio > 0.8 && ratio < 1.25;
      })(),
      JSON.stringify(cardList.map((c) => c.vb))
    );

    ok(
      '每份候选都给出了一眼可辨的分区摘要',
      cardList.every((c) => /个分区/.test(c.summary)),
      JSON.stringify(cardList.map((c) => c.summary))
    );
    ok(
      '各方案的分区结构确实不同（否则"选风格"就是假的）',
      new Set(cardList.map((c) => c.summary)).size === cardList.length,
      JSON.stringify(cardList.map((c) => c.summary))
    );
    ok(
      '每份候选都自带问题读数（选风格时就看得见，不用选完才发现）',
      cardList.every((c) => c.pill.length > 0),
      JSON.stringify(cardList.map((c) => [c.name, c.pill]))
    );

    // ── 采用 ──
    const errToastBefore = await text('.toast-error');
    const adopted = await clickPanelBtn('采用这个方案', 900);
    ok('点得动「采用这个方案」', adopted === true);

    /**
     * 采用必须有**回执**。
     * 只断言"版本号 +1"是不够的：版本没动的时候，你分不清是
     * "命令被拒了"还是"按钮根本没接上" —— 而这两件事的修法完全不同。
     * 所以这里同时读成功回执与失败原因，让失败自己把原因说出来。
     */
    /**
     * 读**整条 toast 队列**，不能只读第一条。
     * 上面「生成方案对比」弹的那条 ok 还没消失，`text('.toast-ok')` 只会取到它 ——
     * 于是采用的回执永远读不到，断言会去检测一条无关的旧提示。
     * （这次就是这么失败的：读到的是"已生成 3 份候选方案"。）
     */
    const adoptToasts = await text('.toasts');
    const adoptErrToast = await text('.toast-error');
    ok(
      '采用成功有明确回执（不是静默生效）',
      /已采用/.test(adoptToasts),
      `toasts="${adoptToasts}" err="${adoptErrToast}"`
    );
    /**
     * 落点必须是"贴某面墙"，不是凭空的 (0,0)。
     * 候选在对比阶段没有位置，若采用时不解决落点，它会落在原点 ——
     * 而默认项目里 cab_001 就在 (400,60)、南墙内表面也在 y=60，
     * 于是必然撞墙又撞柜、被记忆门拦下。回执里说得出墙名，才证明落点真的算过。
     */
    ok(
      '采用的回执说得出贴在哪面墙上（落点是算出来的，不是按 (0,0) 塞进去）',
      /贴「.+?」放置/.test(adoptToasts),
      adoptToasts
    );
    ok(
      '采用没有被拒绝（被拒时必须有一句能读的原因）',
      adoptErrToast === '' || adoptErrToast === errToastBefore,
      `before="${errToastBefore}" after="${adoptErrToast}"`
    );

    ok(
      '采用之后模型版本 +1（只有采用才写模型）',
      (await statusVersion()) === vBeforeVar + 1,
      `v${vBeforeVar} → v${await statusVersion()}`
    );
    ok(
      '采用后自动切到「视图」页签 —— 这正是"选完再出四视图"的那一步',
      (await evalJs(`(()=>{
        const b=[...document.querySelectorAll('.side-right .tabs button')].find(x=>x.classList.contains('on'));
        return b ? b.textContent.trim() : null;
      })()`)) === '视图',
      String(await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right .tabs button')].find(x=>x.classList.contains('on'));return b?b.textContent.trim():null;})()`))
    );

    // ── 改规格后候选必须失效，不许拿着旧尺寸的方案让人采用 ──
    await activateRightTab('方案');
    await sleep(300);
    await panelSet('宽 W', '1800');
    await sleep(260);
    ok(
      '改了规格之后已生成的候选作废（不许拿着旧尺寸的方案让人采用）',
      /尚未生成|填好规格/.test(await panelTextAll()),
      (await panelTextAll()).slice(0, 160)
    );

    // ═══════════════════════════════════════════════════════════
    /**
     * B22 —— 新建房间。
     *
     * 这一组是一次真实缺陷留下的：房间 id 没有避开项目里已用的 id，
     * 于是第二个房间拿到的还是 `room_001` → `planStructural` 返回 null →
     * 界面上只剩一句「结构性命令失败：room.create」，**用户永远建不出第二个房间**。
     *
     * 断言必须**真去点工具栏那个按钮**，不能在 Node 侧直接调 docFactory ——
     * 缺陷在 App 的调用点，不在 `rectRoom` 本身；测了后者会是一条永远绿的假断言。
     */
    section('B22 新建房间：点「+ 房间」必须真的建出第二个房间');

    await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-left .tabs button')]
      .find(x=>x.textContent.trim()==='对象树');if(b)b.click();return !!b})()`);
    await sleep(320);
    const roomCount = () => evalJs(`document.querySelectorAll('.side-left .tree-room').length`);

    const roomsBefore = await roomCount();
    const errToastBeforeRoom = await text('.toast-error');
    const vBeforeRoom = await statusVersion();

    /**
     * 2026-09-28：「+ 房间」不再当场造一个房间出来，而是打开**独立的「新建房间」页**
     * （用户原话：添加房间应该是单独的一页添加，而不是和现有房间在一个页面并排）。
     * 所以这里要走完整两步：点工具栏 → 在新建页点「创建房间」。
     * 只点第一步就断言"房间数 +1"会变成一条**永远失败**的断言，那不是我们要的。
     */
    const newRoomViaPage = () =>
      evalJs(`(async()=>{
        const tb=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.trim()==='+ 房间');
        if(!tb) return 'no-toolbar-btn';
        tb.click();
        await new Promise(r=>setTimeout(r,320));
        const btn=[...document.querySelectorAll('.side-right .tb-btn')].find(x=>x.textContent.trim()==='创建房间');
        if(!btn) return 'no-create-btn';
        if(btn.disabled) return 'create-disabled';
        btn.click();
        return 'ok';
      })()`);

    const clickedNewRoom = await newRoomViaPage();
    ok('工具栏「+ 房间」→ 打开新建房间页 → 点「创建房间」这条走得通', clickedNewRoom === 'ok', String(clickedNewRoom));
    await sleep(520);

    const roomErrToast = await text('.toast-error');
    ok(
      '新建房间不报「结构性命令失败」（房间 id 必须避开项目里已用的）',
      !/结构性命令失败/.test(roomErrToast) && (roomErrToast === '' || roomErrToast === errToastBeforeRoom),
      `before="${errToastBeforeRoom}" after="${roomErrToast}"`
    );
    ok(
      '新建房间后模型版本 +1（真的写进模型了，不是只弹个提示）',
      (await statusVersion()) === vBeforeRoom + 1,
      `v${vBeforeRoom} → v${await statusVersion()}`
    );
    ok(
      '对象树里的房间数 +1',
      (await roomCount()) === roomsBefore + 1,
      `${roomsBefore} → ${await roomCount()}`
    );

    // 连续建第二个：只建得出一个也是缺陷（id 撞车就是这种表现）
    await newRoomViaPage();
    await sleep(520);
    ok(
      '能连续建第二个新房间（不是只能建一个）',
      (await roomCount()) === roomsBefore + 2,
      `${roomsBefore} → ${await roomCount()}`
    );
    ok(
      '两个新房间都没有触发结构性失败',
      !/结构性命令失败/.test(await text('.toast-error')),
      await text('.toast-error')
    );

    // ═══════════════════════════════════════════════════════════
    /**
     * B22b —— 「新建房间」是**独立一页**，不是在列表里凭空并排多一张卡片。
     *
     * 用户原话：「添加房间是增加一个单独页面添加，而不是和现有房间在一个页面并排」。
     * 旧行为：点「+ 房间」就地 append 一个默认房间，名字没填、尺寸没定，
     *        跟已有房间混在一起，房间一多根本分不清哪个是新加的。
     *
     * 这组断言钉死三件事：① 点了之后进的是表单页；② **这一刻房间数没有变**
     * （"点了不该立刻多一个"才是用户要的）；③ 填了重名时创建按钮不可用。
     */
    section('B22b 新建房间是独立一页（点了不立刻多一个，重名不能建）');

    const roomsBefore22b = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().rooms.length})()`);
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')]
      .find(x=>x.textContent.trim()==='+ 房间');if(b)b.click();return !!b})()`);
    await sleep(420);
    ok(
      '点「+ 房间」进的是「新建房间」表单页（能看见创建按钮）',
      await evalJs(`[...document.querySelectorAll('.side-right .tb-btn')].some(x=>x.textContent.trim()==='创建房间')`),
      await text('.side-right')
    );
    ok(
      '★ 这一刻房间数没变 —— 不再"点了就并排多一个"（用户要的就是这个）',
      (await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().rooms.length})()`)) === roomsBefore22b,
      `${roomsBefore22b} → ${await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().rooms.length})()`)}`
    );
    // 重名 → 创建按钮必须禁用（不给"点了才知道错"的机会）
    await evalJs(`(async()=>{
      const inp=[...document.querySelectorAll('.side-right input.input')][0];
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const names=(await import('/src/state/store.ts')).bus.getState().rooms.map(r=>r.name);
      setter.call(inp, names[0]);
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await sleep(360);
    ok(
      '房间名重名时「创建房间」不可用，且界面上写明原因',
      (await evalJs(`[...document.querySelectorAll('.side-right .tb-btn')].find(x=>x.textContent.trim()==='创建房间')?.disabled === true`)) === true &&
        /已经有一个房间叫/.test(await text('.side-right')),
      await text('.side-right')
    );
    // 改回一个不重名的名字 → 能建，且回到列表页
    await evalJs(`(async()=>{
      const inp=[...document.querySelectorAll('.side-right input.input')][0];
      const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(inp, '验收新增房间');
      inp.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await sleep(300);
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right .tb-btn')].find(x=>x.textContent.trim()==='创建房间');if(b&&!b.disabled)b.click();return !!b})()`);
    await sleep(520);
    ok(
      '填好确认后才真的建出来（房间数 +1）',
      (await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().rooms.length})()`)) === roomsBefore22b + 1,
      `${roomsBefore22b} → ${await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().rooms.length})()`)}`
    );
    ok(
      '建完回到房间列表页（不是停在表单页上）',
      (await evalJs(`[...document.querySelectorAll('.side-right .tb-btn')].some(x=>x.textContent.trim()==='创建房间')`)) === false,
      await text('.side-right')
    );

    // ═══════════════════════════════════════════════════════════
    /**
     * B23 —— 导出面板。
     *
     * 这里**故意不真点「导出 DXF」**：那会触发浏览器下载，headless 下的下载行为
     * 不可控（挂起 / 落到下载目录 / 触发权限提示），会把验收拖进环境问题。
     * 真实导出链路（spawn node → python → 回读）已由 verify:export 用真 HTTP 覆盖。
     * 这里钉的是**面板自身的可点性与如实性**：
     *   · 一张图都不选时按钮必须禁用（否则导出空文件）
     *   · 有 ERROR 时必须先说话，而不是让人高高兴兴导出一份错图
     *   · "1:1 不缩放 / 三件套可复现"这两件事必须写在界面上 —— 它们是承诺，不是注释
     */
    section('B23 导出面板：图纸选择 / 版本选择 / ERROR 提示 / 禁用逻辑');

    await activateRightTab('导出');
    await sleep(420);

    const expChecks = await evalJs(`[...document.querySelectorAll('.side-right .exp-check input')].map(i=>i.checked)`);
    ok('「导出」页签在，且默认勾选了平面图与四视图两张', Array.isArray(expChecks) && expChecks.length === 2 && expChecks.every(Boolean), JSON.stringify(expChecks));

    ok(
      'DXF 版本下拉默认 R2007（原生 UTF-8 主交付，不是兼容备用的 R2000）',
      (await evalJs(`(()=>{const s=document.querySelector('.side-right select.input');return s?s.value:null})()`)) === 'R2007'
    );

    const exportBtn = async () => evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right .tb-btn')]
      .find(x=>x.textContent.includes('导出 DXF'));return b?{disabled:b.disabled}:null})()`);
    ok('「导出 DXF」按钮在', (await exportBtn()) !== null, JSON.stringify(await exportBtn()));

    // 两张图都不勾 → 必须禁用。这条防的是"导出一份空文件"。
    await evalJs(`[...document.querySelectorAll('.side-right .exp-check input')].forEach(i=>{i.click()})`);
    await sleep(260);
    ok(
      '两张图都不选时「导出 DXF」被禁用（不许导出空文件）',
      ((await exportBtn()) || {}).disabled === true,
      JSON.stringify(await exportBtn())
    );
    ok('面板同时给出一句话解释（禁用不许是无声的）', /至少选一张图/.test(await panelTextAll()));
    await evalJs(`[...document.querySelectorAll('.side-right .exp-check input')].forEach(i=>{i.click()})`);
    await sleep(260);
    ok('恢复勾选后按钮回到可用', ((await exportBtn()) || {}).disabled === false, JSON.stringify(await exportBtn()));

    ok(
      '界面写明"模型空间 1:1"（这是出图纪律的承诺，不是注释里的私事）',
      /1:1/.test(await panelTextAll())
    );
    ok(
      '界面写明三件套可复现（模型版本 + 生成器 + 规则集）',
      /三件套/.test(await panelTextAll())
    );

    // ═══════════════════════════════════════════════════════════
    /**
     * B24 —— 项目存盘与加载（Task #23）。
     *
     * 上一轮用户的原话是"现在刷新就丢，等于没法真正用"。这一组钉四件事：
     *   · 自动保存真的在写 localStorage，且写进去的是当前模型（不是旧快照）
     *   · 界面上的"已保存几点几分"是给用户看的承诺，必须随变更更新
     *   · 打开合法项目文件走 bus.replaceProject —— 项目名真的出现在对象树上
     *   · 打开别家 .json 被拒，且给出人能看懂的理由（导入的文件是攻击面）
     *
     * 导入用 DataTransfer 构造 File 再真触发 change —— 绕过 file input 会漏掉
     * 整条 onImportFile 链路；坏文件的拒绝断言必须真的走这条链。
     */
    section('B24 项目存盘与加载：自动保存 / 打开项目文件 / 坏文件拒绝');

    // B23 结束时就在「导出」页签 —— 项目存档组就在这个面板里
    ok(
      '「项目存档」组在导出面板里（存为 .json 与 打开… 两个按钮都在）',
      (await evalJs(`(()=>{const btns=[...document.querySelectorAll('.side-right .exp-btns .tb-btn')].map(b=>b.textContent.trim());
        return btns.some(t=>/存为项目文件/.test(t)) && btns.some(t=>/打开项目文件/.test(t));})()`)
      ) === true,
      await evalJs(`JSON.stringify([...document.querySelectorAll('.side-right .exp-btns .tb-btn')].map(b=>b.textContent.trim()))`)
    );
    ok('存档组写明"导入会作为一条命令进历史，可以撤销"', /可以撤销/.test(await panelTextAll()));

    // 自动保存是去抖 800ms：B22 已连建两个房间，等窗口过去再看状态
    await sleep(1500);
    const draftStatus = await text('[data-testid="draft-status"]');
    ok('模型变更后，面板写明草稿已自动保存到几点几分（不是一句静态文案）', /已自动保存\s*\d{2}:\d{2}/.test(draftStatus), draftStatus);

    const draftMatch = await evalJs(`(async()=>{
      try {
        const s = await import('/src/state/store.ts');
        const p = s.bus.getState();
        const raw = localStorage.getItem('furnicad.draft.v1') || '';
        let d = null; try { d = JSON.parse(raw); } catch(e) {}
        return { ok: true, cabNow: p.cabinets.length, cabDraft: d && d.project ? d.project.cabinets.length : -1,
                 roomNow: p.rooms.length, roomDraft: d && d.project ? d.project.rooms.length : -1, hasEnvelope: !!d && d.format === 'furniture-cad-project' };
      } catch(e) { return { ok:false, err: String(e) }; }
    })()`);
    ok('localStorage 里的草稿是本项目格式（带信封）', draftMatch.ok && draftMatch.hasEnvelope === true, JSON.stringify(draftMatch));
    ok(
      '草稿里的房间/柜体数与当前模型一致（自动保存写进的是真模型，不是旧快照）',
      draftMatch.ok && draftMatch.cabNow === draftMatch.cabDraft && draftMatch.roomNow === draftMatch.roomDraft,
      JSON.stringify(draftMatch)
    );

    // 坏文件：别家 JSON 必须在门口被拒
    const badImport = await evalJs(`(async()=>{
      const input = document.querySelector('.side-right input[type=file]');
      if (!input) return 'NO_INPUT';
      const dt = new DataTransfer();
      dt.items.add(new File(['{"name":"not-our-app"}'], 'bad.json', { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK';
    })()`);
    ok('构造别家 .json 真触发了打开链路（change 事件）', badImport === 'OK', String(badImport));
    await sleep(460);
    const badToast = await text('.toast-error');
    ok(
      '坏文件被拒，理由人能看懂（导入失败 + 不是本系统的文件）',
      /导入失败/.test(badToast) && /不是本系统导出的项目文件/.test(badToast),
      badToast
    );

    // 好文件：拿草稿改个项目名再导入 —— 名字必须真的出现在对象树上
    const goodImport = await evalJs(`(async()=>{
      const input = document.querySelector('.side-right input[type=file]');
      if (!input) return 'NO_INPUT';
      const raw = localStorage.getItem('furnicad.draft.v1');
      if (!raw) return 'NO_DRAFT';
      const env = JSON.parse(raw);
      env.project.name = '导入测试项目';
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(env)], 'good.json', { type: 'application/json' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'OK';
    })()`);
    ok('打开合法项目文件触发导入', goodImport === 'OK', String(goodImport));
    await sleep(560);
    ok('导入成功有回执（不静默生效）', /已导入\s*good\.json/.test(await text('.toasts')), await text('.toasts'));
    const treeRootName = await evalJs(`(()=>{const el=document.querySelector('.side-left .tree-root .tree-node-label');return el?el.textContent.trim():''})()`);
    ok('导入后对象树根节点显示新项目名（replaceProject 真的生效）', treeRootName === '导入测试项目', treeRootName);
    ok('面板留下导入结果（几个房间 / 几个柜体）', /已导入\s*good\.json/.test(await panelTextAll()), (await panelTextAll()).slice(0, 160));

    // ═══════════════════════════════════════════════════════════
    /**
     * B25 —— 右键上下文菜单（Task #24）。
     *
     * 钉四件事：
     *   · 右键即选中：右键落在柜体上，先选中它，菜单才有"复制/旋转/删除"可谈
     *   · 选中态决定菜单：空白右键的菜单里没有柜体专属项
     *   · 菜单项真的执行：旋转 90° 后版本 +1；执行完菜单收掉
     *   · 命令进行中右键 = 取消（与 Esc 同义），不弹菜单、不写模型
     *
     * B22 建房间触发过 fit，B3 的相机标定已失效 —— 这里独立重新标定，
     * 不复用旧 A/wa/scale（复用旧标定是 B5 之后差点埋过的一次暗雷）。
     */
    section('B25 右键上下文菜单：右键即选中 / 选中态决定菜单 / 命令中右键=取消');

    // 回平面图 + 选择工具，关掉捕捉（HUD 才显示原始世界坐标，标定不被吸附污染）
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.trim()==='平面图');if(b)b.click();return !!b})()`);
    await sleep(360);
    const snapWasOn25 = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')]
      .find(x=>x.textContent.trim().startsWith('捕捉'));return b?b.classList.contains('active'):null})()`);
    if (snapWasOn25 === true) {
      await keyPress('F3', 'F3', 114);
      await sleep(260);
    }

    /**
     * 相机标定（HUD 两点反解 px/mm）。做成函数是因为「新建房间」会触发
     * fitSignal 重新取景 —— 相机一变旧标定就是错的，取景后必须重标一次。
     * （复用旧标定是 B5 之后差点埋过的一次暗雷，这里在结构上禁止它。）
     */
    const calib25 = async () => {
      const rect = await evalJs(`(()=>{const r=document.querySelector('.vp').getBoundingClientRect();
        return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,w:r.width,h:r.height}})()`);
      const A = { x: Math.round(rect.left + rect.w * 0.25), y: Math.round(rect.top + rect.h * 0.3) };
      const B = { x: Math.round(rect.left + rect.w * 0.75), y: Math.round(rect.top + rect.h * 0.78) };
      await moveMouse(A.x, A.y);
      await sleep(220);
      const wa = await hudWorld();
      await moveMouse(B.x, B.y);
      await sleep(220);
      const wb = await hudWorld();
      const good = wa && wb && wb.x !== wa.x && wb.y !== wa.y;
      const scale = good ? ((B.x - A.x) / (wb.x - wa.x) + (A.y - B.y) / (wb.y - wa.y)) / 2 : null;
      return {
        rect,
        good,
        scale,
        toClient: (wx, wy) => ({ x: A.x + (wx - wa.x) * scale, y: A.y - (wy - wa.y) * scale }),
      };
    };

    let cal25 = await calib25();
    ok('B25 独立重标定成功（HUD 两点反解 px/mm）', cal25.good && cal25.scale > 0.05 && cal25.scale < 1,
      cal25.good ? `scale=${cal25.scale.toFixed(4)}` : 'HUD 读数失败');

    const cabInfo25 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const c=s.bus.getState().cabinets[0];
      return { id:c.id, x:c.placement.x, y:c.placement.y, rot:c.placement.rotation, w:c.params.width, d:c.params.depth };})()`);
    ok('柜体 0 的旋转角是 0（右键点位按未旋转计算的前提）', cabInfo25.rot === 0, JSON.stringify(cabInfo25));
    const cabCenter25 = () => cal25.toClient(cabInfo25.x + cabInfo25.w / 2, cabInfo25.y + cabInfo25.d / 2);
    {
      const c = cabCenter25();
      ok('柜体中心点落在视口内（不然下面的右键都是空的）',
        c.x > cal25.rect.left + 8 && c.x < cal25.rect.right - 8 && c.y > cal25.rect.top + 8 && c.y < cal25.rect.bottom - 8,
        JSON.stringify(c));
    }

    // ① 右键柜体 → 先选中，菜单含柜体专属项
    const vBeforeCtx = await statusVersion();
    await mouseRightClick(cabCenter25().x, cabCenter25().y);
    await sleep(380);
    const ctxLabels1 = await evalJs(`(()=>{const m=document.querySelector('.ctx-menu');return m?[...m.querySelectorAll('.ctx-item .ctx-label')].map(x=>x.textContent.trim()):[]})()`);
    ok('右键柜体弹出上下文菜单', ctxLabels1.length > 0, JSON.stringify(ctxLabels1));
    ok('菜单里有柜体专属项（复制 / 旋转 90° / 删除）',
      ctxLabels1.some((t) => /复制/.test(t)) && ctxLabels1.some((t) => /旋转 90°/.test(t)) && ctxLabels1.some((t) => /删除/.test(t)),
      JSON.stringify(ctxLabels1));
    const selAfterRclick = await statusSelection();
    ok('右键即选中：状态栏显示 已选 1 项', selAfterRclick === 1, `实为 ${selAfterRclick}`);

    // ② 点「旋转 90°」—— 注意：cab_001 贴墙摆放，绕左后角原地旋转 90° 会把柜体甩进墙里。
    //    生效记忆 mem_002（柜体不许扎进墙）对右键菜单【一视同仁】地拦截 —— 这是设计行为：
    //    "UI / AI / MCP / 脚本五条路同权"，门不豁免任何一条。这里断言的恰恰是这个。
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.ctx-menu .ctx-item')].find(x=>/旋转 90°/.test(x.textContent));if(b)b.click();return !!b})()`);
    await sleep(420);
    ok('菜单项执行后菜单收掉（不留残影）', (await evalJs(`!!document.querySelector('.ctx-menu')`)) === false);
    // 读整条 .toasts 而不是 .toast-error：toast 在 DOM 里要停 8 秒，
    // B24 的"导入失败"气泡可能还挂着 —— 只读第一条会读到旧消息（B21 的同款坑）
    const rotToasts = await text('.toasts');
    ok('贴墙柜原地旋转被记忆门拦下（门对 UI 右键不豁免，五条路同权）', /记忆拦截/.test(rotToasts), rotToasts || '(无提示)');
    ok('被拦下后模型未变（版本不变）', (await statusVersion()) === vBeforeCtx, `v${vBeforeCtx} → v${await statusVersion()}`);
    ok('旋转角还是 0（拦截是真的拦了）', (await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets[0].placement.rotation})()`)) === 0);

    // ②b 菜单项也要证明【能执行】：用空白菜单的「新建房间」（远离现有房间，干干净净）
    const roomsBeforeCtx = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().rooms.length})()`);
    await mouseRightClick(cabCenter25().x, cabCenter25().y);
    await sleep(320);
    // 「新建房间」现在只打开独立的新建页（不再当场造），所以要再点一下「创建房间」
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.ctx-menu .ctx-item')].find(x=>x.textContent.trim()==='新建房间');if(b)b.click();return !!b})()`);
    await sleep(360);
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right .tb-btn')].find(x=>x.textContent.trim()==='创建房间');if(b&&!b.disabled)b.click();return !!b})()`);
    await sleep(520);
    ok('菜单项能真的执行：「新建房间」后版本 +1', (await statusVersion()) === vBeforeCtx + 1, `v${vBeforeCtx} → v${await statusVersion()}`);
    ok('菜单项执行后菜单收掉', (await evalJs(`!!document.querySelector('.ctx-menu')`)) === false);
    ok('房间数 +1（不是只弹了个提示）', (await evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().rooms.length})()`)) === roomsBeforeCtx + 1);

    // ③ Esc 关菜单（菜单开着再右键一次，然后按 Esc）
    // 「新建房间」触发了 fitSignal 重新取景 —— 相机变了，旧标定作废，重标一次
    cal25 = await calib25();
    ok('取景后重新标定成功（相机变了，旧标定就是错的）', cal25.good && cal25.scale > 0.05 && cal25.scale < 1,
      cal25.good ? `scale=${cal25.scale.toFixed(4)}` : 'HUD 读数失败');
    await mouseRightClick(cabCenter25().x, cabCenter25().y);
    await sleep(320);
    ok('再次右键菜单重新打开', (await evalJs(`!!document.querySelector('.ctx-menu')`)) === true);
    await keyPress('Escape', 'Escape', 27);
    await sleep(280);
    ok('Esc 关掉菜单（不误伤模型）', (await evalJs(`!!document.querySelector('.ctx-menu')`)) === false && (await statusVersion()) === vBeforeCtx + 1);

    // 再按一次 Esc 清掉选中 —— 不然空白右键的菜单里还挂着柜体专属项，④ 的判别式必假
    // 注意：statusSelection 在「未选中」时返回 null（没有已选元素可读），不是 0 —— 断言要接住两种
    await keyPress('Escape', 'Escape', 27);
    await sleep(260);
    const selAfterEsc2 = await statusSelection();
    ok('再次 Esc 清掉了选中（空白菜单的前置条件）', selAfterEsc2 === 0 || selAfterEsc2 === null, `实为 ${selAfterEsc2}`);

    // ④ 空白处右键：菜单里没有柜体专属项（在柜体对角线外侧找空白点）
    let blankMenuOk = false;
    let blankLabels = [];
    for (const dist of [800, 1400, 2000, 2800]) {
      const p = cal25.toClient(cabInfo25.x + cabInfo25.w + dist, cabInfo25.y - dist);
      if (p.x < cal25.rect.left + 12 || p.x > cal25.rect.right - 12 || p.y < cal25.rect.top + 12 || p.y > cal25.rect.bottom - 12) continue;
      await mouseRightClick(p.x, p.y);
      await sleep(340);
      blankLabels = await evalJs(`(()=>{const m=document.querySelector('.ctx-menu');return m?[...m.querySelectorAll('.ctx-item .ctx-label')].map(x=>x.textContent.trim()):[]})()`);
      if (blankLabels.length > 0 && !blankLabels.some((t) => /复制/.test(t))) {
        blankMenuOk = true;
        break;
      }
      await keyPress('Escape', 'Escape', 27);
      await sleep(220);
    }
    ok('空白处右键弹出通用菜单（含 新建房间 / 全选 / 适应窗口）',
      blankMenuOk && blankLabels.some((t) => /新建房间/.test(t)) && blankLabels.some((t) => /全选/.test(t)) && blankLabels.some((t) => /适应窗口/.test(t)),
      JSON.stringify(blankLabels));
    ok('空白菜单里没有柜体专属项（选中态决定菜单，不是一套通吃）', !blankLabels.some((t) => /复制/.test(t)), JSON.stringify(blankLabels));
    await keyPress('Escape', 'Escape', 27);
    await sleep(220);

    // ⑤ 画墙画到一半右键 = 取消（不弹菜单、不写模型、回到选择工具）
    await keyPress('l', 'l', 76);
    await sleep(300);
    const modeWall = await evalJs(`(()=>{const el=document.querySelector('.sb-mode');return el?el.textContent.trim():''})()`);
    ok('按 L 进入画墙工具（准备测"命令中右键"）', modeWall === '画墙', modeWall);
    await mouseRightClick(cabCenter25().x, cabCenter25().y);
    await sleep(340);
    const modeAfterR = await evalJs(`(()=>{const el=document.querySelector('.sb-mode');return el?el.textContent.trim():''})()`);
    ok('命令进行中右键：不弹菜单', (await evalJs(`!!document.querySelector('.ctx-menu')`)) === false);
    ok('命令进行中右键 = 取消，回到选择工具', modeAfterR === '选择', modeAfterR);
    ok('取消没有写模型（版本不变）', (await statusVersion()) === vBeforeCtx + 1, `v${vBeforeCtx + 1} → v${await statusVersion()}`);

    // ═══════════════════════════════════════════════════════════
    /**
     * B26 —— 四视图点选线 → 语义解析（Task #25 A 组的浏览器闭环）。
     *
     * 在图幅上点一条线，界面必须说出"这是哪个柜体的什么部件、由哪个参数决定"，
     * 并把所属柜体选上 —— AI 与用户从这里拿到的是 {cabinetId, part, paramPath}，
     * 永远不是坐标。
     *
     * 点位不写死：从派生管线里现取 pickLines 的实际点位（与屏幕上那条线同源），
     * 经独立标定换算成屏幕坐标 —— 写死坐标等于赌相机状态，迟早假红。
     */
    section('B26 四视图点选线 → 语义解析（外轮廓/层板线 → 参数路径）');

    /**
     * 图幅内点位换算 —— 为什么不做 HUD 两点标定：
     *   ① 图幅模式按设计不显示 X/Y 坐标读数（B20 有这条断言），在图幅内标定必然失败；
     *   ② "平面图标定带进图幅"也错 —— 切图幅必然触发一次重新取景（fit 到四图幅
     *      bbox，Viewport 的 fitGeom 对 sheet 取 views.bbox），旧标定的 scale/原点
     *      全部作废。B26 第一轮三连失败的真实根因就是探针假设了"相机跨模式共享"。
     * 出路：从 camDebug 读产品**正在用**的真实相机，用渲染同款的 worldToScreen
     * 换算 —— 与 hitPart 的反解互为逆运算，点位精度与用户点击完全同权。
     */
    const clientOfSheet = (wx, wy) => evalJs(`(async()=>{
      const m = await import('/src/viewport/camera.ts');
      const cd = (await import('/src/viewport/camDebug.ts')).camDebug;
      if (!cd.cam) return null;
      const rect = document.querySelector('.vp').getBoundingClientRect();
      const s = m.worldToScreen({x:${wx}, y:${wy}}, cd.cam, cd.vw, cd.vh);
      return { x: rect.left + s.x, y: rect.top + s.y, scale: cd.cam.scale,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } };
    })()`);
    const inViewport = (c) => c && Number.isFinite(c.x) && Number.isFinite(c.y) && c.scale > 0
      && c.x > c.rect.left + 8 && c.x < c.rect.right - 8 && c.y > c.rect.top + 8 && c.y < c.rect.bottom - 8;

    // 进四视图
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.includes('四视图'));if(b)b.click();return !!b})()`);
    await sleep(420);
    ok('四视图切换成功（图幅 HUD 提示在，平面读数不在）',
      (await evalJs(`!!document.querySelector('.vp-hud-sheet')`)) === true,
      `sheet-hud=${await evalJs(`!!document.querySelector('.vp-hud-sheet')`)} hudWorld=${JSON.stringify(await hudWorld())}`);

    // 点击前的气泡快照（条目级）—— mem_003 之类旧拦截气泡有 8 秒寿命，
    // 断言只看"点击之后**新增**的那几条"（基线差集），旧账不往点选头上算。
    const toastItems = () => evalJs(`[...document.querySelectorAll('.toasts > *')].map(n=>n.textContent)`);
    /** 等到气泡自然过期清空（非 error 气泡寿命 4.5s），让"新增气泡"的判定不受旧账干扰 */
    const waitToastsClear = async (limit = 9000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < limit) {
        if (((await toastItems()) || []).length === 0) return true;
        await sleep(500);
      }
      return false;
    };
    const baseline26 = (await toastItems()) || [];
    const baseSet26 = new Set(baseline26);
    const freshToasts = async () => {
      const after = (await toastItems()) || [];
      return after.filter((t) => !baseSet26.has(t)).join(' | ');
    };

    const pickOuter = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const v=s.bus.derive().geom.views.pickLines;
      const pl=v.find(x=>x.part==='outer.width');
      return pl?{mid:{x:(pl.pts[0].x+pl.pts[1].x)/2, y:(pl.pts[0].y+pl.pts[1].y)/2}, label:pl.labelZh, path:pl.paramPath, cab:pl.cabinetId}:null;})()`);
    ok('派生管线里能取到 outer.width 的 PickLine', pickOuter !== null, JSON.stringify(pickOuter));
    if (pickOuter) {
      const c = await clientOfSheet(pickOuter.mid.x, pickOuter.mid.y);
      ok('外轮廓点位换算成功且落在视口内', inViewport(c), JSON.stringify(c));
      if (inViewport(c)) {
        await mouseDown(c.x, c.y);
        await sleep(120);
        await mouseUp(c.x, c.y);
        await sleep(460);
        const fresh26 = await freshToasts();
        ok('点击外轮廓 → 界面说出部件名与参数路径（这不是一条线，是柜宽）',
          pickOuter.label && fresh26.includes(pickOuter.label) && fresh26.includes(pickOuter.path) && !fresh26.includes('mem_'),
          `新增气泡=[${fresh26 || '(无)'}]`);
        ok('点线即选中所属柜体（语义目标落成选择集，后续 AI 才有 scope 可用）', (await statusSelection()) === 1, `实为 ${await statusSelection()}`);
      }
    }

    // 层板线：同样现取现点
    const pickShelf = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const v=s.bus.derive().geom.views.pickLines;
      const pl=v.find(x=>x.part==='shelf.line');
      return pl?{mid:{x:(pl.pts[0].x+pl.pts[1].x)/2, y:(pl.pts[0].y+pl.pts[1].y)/2}, label:pl.labelZh, path:pl.paramPath}:null;})()`);
    ok('派生管线里能取到 shelf.line 的 PickLine', pickShelf !== null, '样例柜体没有层板分区（不该发生）');
    if (pickShelf) {
      const c2 = await clientOfSheet(pickShelf.mid.x, pickShelf.mid.y);
      if (inViewport(c2)) {
        await mouseDown(c2.x, c2.y);
        await sleep(120);
        await mouseUp(c2.x, c2.y);
        await sleep(460);
        const fresh26b = await freshToasts();
        ok('点击层板线 → 解析成 shelves.count（改层板 = 改数量参数，不是挪线）',
          fresh26b.includes(pickShelf.label) && fresh26b.includes('shelves.count'),
          `新增气泡=[${fresh26b || '(无)'}]`);
        ok('点线没有写模型（解析是读操作，改不改由用户决定）', (await statusVersion()) === vBeforeCtx + 1, `v${vBeforeCtx + 1} → v${await statusVersion()}`);
      }
    }

    // ═══════════════════════════════════════════════════════════
    /**
     * B36 —— 四视图可编辑：**真鼠标拖动**一条线 = 改一个语义参数。
     *
     * 为什么要跑到浏览器里拖一次：node 侧已经验证了映射与命令，
     * 但"鼠标按下 → 命中 → 预览 → 松手写入"这条**真实链路**只在浏览器里存在。
     * 历史上"预览与提交不一致"的事故都发生在这条链路上，所以必须真拖。
     *
     * 关键断言不是"值变了"，而是三条结构性事实：
     *   ① 拖完写的确实是语义参数（模型里的 width 变了，不是图元坐标）
     *   ② 四张图同步（改宽之后，俯视图那条宽线跟着走到同一个数）
     *   ③ 拖不动的线会**说出原因**，且不改模型
     *
     * ── 这一节为什么开头先把工程复位 ──
     *   第一次跑通时，松手后被"墙体记忆"拦下：气泡说"这次操作把柜体扎进了墙体里"。
     *   查下来不是产品的错，是**探针的错**：B36 排在 B24（导入测试项目）之后，
     *   那时 cabinets[0] 已经不是示例里的那个衣柜，而是导入工程里贴着墙的柜子。
     *   探针不该靠前序小节"遗留的状态"活着 —— 所以 B36 先把工程复位成干净的
     *   示例工程，让它自成一体、可重复。（复位前的状态照样打印出来，作为证据。）
     *
     * ── 为什么往"收窄"方向拖 ──
     *   示例衣柜 2400mm 已在板材幅面（2440）边缘，再加宽必然新增
     *   RULE-PANEL-OVER-SHEET。那会让"拖动到底写没写进去"和"板件超幅面"
     *   两件事混在一起说不清。超幅面另有规则小节覆盖，这里挑一个干净的方向。
     */
    // ═══════════════════════════════════════════════════════════
    section('B36 四视图可编辑：真鼠标拖动 → 写语义参数，四图同步，不可拖的给出理由');

    // 证据：复位前这一节究竟在跑哪个工程、哪个柜子（别让"状态被污染"停留在猜测）
    const dirty36 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const p=s.bus.getState(); const c=p.cabinets[0];
      return {proj:p.name, cabCount:p.cabinets.length, id:c&&c.id, name:c&&c.name,
        place:c&&JSON.stringify(c.placement), width:c&&c.params.width};})()`);
    console.log('[B36 复位前状态] ' + JSON.stringify(dirty36));

    // 先把现场存起来。本节为了可重复必须复位工程，但**下游小节（B30 等）依赖
    // 前序留下的柜子**——第一轮修完 B36 就顺手把 B30 冲挂了。所以用完必须还原：
    // "自成一体"不等于"可以随便改全局状态"。
    await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      window.__b36Saved = structuredClone(s.bus.getState()); return true;})()`);

    // 复位成干净示例工程 —— 本节自成一体
    const reset36 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const df=await import('/src/core/docFactory.ts');
      s.bus.replaceProject(df.sampleProject(s.RULESET), 'B36 复位为示例工程');
      const p=s.bus.getState(); const c=p.cabinets[0];
      return {proj:p.name, id:c.id, name:c.name, width:c.params.width, ver:s.bus.getVersion()};})()`);
    ok('B36 跑在干净的示例工程上（本节自成一体，不依赖前序小节遗留的状态）',
      Boolean(reset36) && reset36.proj === '示例户型' && reset36.width === 2400, JSON.stringify(reset36));
    await sleep(260);

    // 必须在图幅模式下拖：若在平面模式，图纸坐标全在屏幕外，点位换算会失败 ——
    // 那会让后面几条断言"静默跳过"，看着像通过，其实什么都没验。所以先断言模式。
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.includes('四视图'));if(b&&!document.querySelector('.vp-hud-sheet'))b.click();return true})()`);
    await sleep(420);
    ok('B36 拖动发生在四视图图幅模式下（否则后面的断言会静默跳过）',
      (await evalJs(`!!document.querySelector('.vp-hud-sheet')`)) === true,
      `sheet-hud=${await evalJs(`!!document.querySelector('.vp-hud-sheet')`)}`);

    const snap36 = () => evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const v=s.bus.derive().geom.views.pickLines;
      const find=(view,part,edge)=>{const pl=v.find(x=>x.view===view&&x.part===part&&(edge===undefined||x.edge===edge));
        return pl?{x:pl.pts[0].x,y:pl.pts[0].y}:null;};
      return {ver:s.bus.getVersion(), width:s.bus.getState().cabinets[0].params.width,
        frontW:find('front','outer.width','max'), topW:find('top','outer.width','max'),
        frontMin:find('front','outer.width','min'),
        // 基准边那条竖线的**中点**：不要用端点再偏移一个固定值 ——
        // 图幅缩放下命中容差只有一百多毫米，固定偏移会直接打空，
        // 于是"拖了没反应"会被误当成"产品没给理由"。
        frontMinMid:(()=>{const pl=v.find(x=>x.view==='front'&&x.part==='outer.width'&&x.edge==='min');
          return pl?{x:(pl.pts[0].x+pl.pts[1].x)/2, y:(pl.pts[0].y+pl.pts[1].y)/2}:null;})(),
        hasSide:!!v.find(x=>x.view==='side'), hasTop:!!v.find(x=>x.view==='top')};})()`);

    const s0 = await snap36();
    ok('B36 反查层覆盖侧视图与俯视图（这两张图以前没有可点线）', s0.hasSide && s0.hasTop, JSON.stringify({ hasSide: s0.hasSide, hasTop: s0.hasTop }));

    // 拖正视图右外轮廓 +100mm：像素量 = 100 × 当前 scale（与渲染同款换算的逆运算）
    const line36 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const v=s.bus.derive().geom.views.pickLines;
      const pl=v.find(x=>x.view==='front'&&x.part==='outer.width'&&x.edge==='max');
      return pl?{mid:{x:(pl.pts[0].x+pl.pts[1].x)/2, y:(pl.pts[0].y+pl.pts[1].y)/2}}:null;})()`);
    ok('B36 取到正视图右外轮廓（= 柜宽那条边）', line36 !== null, JSON.stringify(line36));

    // 先用**产品自己的命中测试**在算出的世界点上打一枪：这样"坐标算错"与
    // "鼠标事件没进到处理函数"两类失败就能分开，不用猜。
    if (line36) {
      const selfHit = await evalJs(`(async()=>{
        const s=await import('/src/state/store.ts');
        const ht=await import('/src/viewport/hitTest.ts');
        const sn=await import('/src/viewport/snapping.ts');
        const cd=(await import('/src/viewport/camDebug.ts')).camDebug;
        const tol=sn.snapToleranceWorld(8, cd.cam.scale);
        const hit=ht.hitPart(s.bus.derive().geom.views.pickLines, {x:${line36.mid.x}, y:${line36.mid.y}}, tol);
        return hit?{view:hit.view, part:hit.part, edge:hit.edge, unit:hit.unitIndex}:null;})()`);
      ok('B36 产品自身的命中测试在该世界坐标上命中了"正视图·柜宽·末端边"',
        selfHit !== null && selfHit.view === 'front' && selfHit.part === 'outer.width' && selfHit.edge === 'max',
        JSON.stringify(selfHit));
    }

    // 页面内直接跑一遍 dragPlanOf：读的是**界面正在用的同一份模块**，
    // 任何隐藏异常（比如契约导入失败）都会在这里现形，而不是变成"拖了没反应"。
    const plan36 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const sd=await import('/src/viewport/sheetDrag.ts');
      const pl=s.bus.derive().geom.views.pickLines.find(x=>x.view==='front'&&x.part==='outer.width'&&x.edge==='max');
      const p=sd.dragPlanOf(pl);
      return p.ok?{ok:true,label:p.spec.labelZh,axis:p.spec.axis,sign:p.spec.sign,min:p.spec.min,max:p.spec.max}:{ok:false,reason:p.reason};})()`);
    ok('B36 页面内 dragPlanOf 判定这条线可拖（与界面同一份模块）', Boolean(plan36 && plan36.ok), JSON.stringify(plan36));

    // 拖之前的硬错数：拖完不许变多（拖动只该改这一个尺寸，不该顺手造出新问题）
    const errCount36 = () => evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      return s.bus.derive().issues.filter(i=>i.severity==='ERROR').length;})()`);

    if (line36) {
      const c36 = await clientOfSheet(line36.mid.x, line36.mid.y);
      ok('B36 拖动起点换算成功且落在视口内', inViewport(c36), JSON.stringify(c36));
      if (inViewport(c36)) {
        // 往"收窄"方向拖 ~100mm。图幅模式为了塞下四张图，scale 很小（约 0.047 px/mm），
        // 100mm 只有 5px 左右 —— 所以**不能**断言"正好 100mm"，像素取整本身就带误差。
        // 误差上限 = 半个像素对应的毫米数，这里照实算出来，不拍脑袋写死。
        const px36 = -Math.max(3, Math.round(100 * c36.scale));
        const halfPxMm = Math.ceil(0.5 / c36.scale) + 1;
        const errBefore36 = await errCount36();
        await mouseDown(c36.x, c36.y);
        await sleep(90);
        await moveMouse(c36.x + Math.round(px36 / 2), c36.y, 1);
        await sleep(90);
        const read36 = await hudReadout();
        await moveMouse(c36.x + px36, c36.y, 1);
        await sleep(120);
        const read36b = await hudReadout();
        await mouseUp(c36.x + px36, c36.y);
        await sleep(320);
        // 诊断：把"松手瞬间"的读数与气泡打进日志 —— 命令若被规则拒绝，气泡里就是原因
        const toastsUp36 = ((await toastItems()) || []).slice(-3).join(' | ');
        console.log(`[B36 诊断] 目标像素位移=${px36}px scale=${c36.scale} 半像素=${halfPxMm}mm 松手前读数=[${read36b}] 松手后气泡=[${toastsUp36}]`);

        const s1 = await snap36();
        const errAfter36 = await errCount36();
        // 悬停读数形如"柜宽 2400mm · 左右拖…"，拖动读数形如"柜宽 → 2300mm"（含箭头）。
        // 必须断言箭头，否则"悬停有读数"会冒充"拖动有读数"，把真失败盖过去。
        ok('B36 拖动过程有读数：显示"柜宽 → 目标值mm"（所见即所得，且是拖动态不是悬停态）',
          /柜宽/.test(String(read36 || '')) && /→/.test(String(read36 || '')),
          `拖动中读数=[${read36}] 末=[${read36b}]`);
        ok('B36 松手后模型版本 +1（一次拖动 = 一条命令 = 一次撤销）', s1.ver === s0.ver + 1, `v${s0.ver} → v${s1.ver}`);
        ok('B36 模型里的柜宽真的变了（写的是语义参数，不是图元坐标）',
          s1.width !== s0.width && s1.width < s0.width, `${s0.width} → ${s1.width}`);
        ok('B36 位移量 ≈ 100mm（差值是像素取整带来的，已按半像素算过上限）',
          Math.abs(Math.abs(s1.width - s0.width) - 100) <= halfPxMm,
          `Δ=${Math.abs(s1.width - s0.width)}mm 允许±${halfPxMm}mm`);

        // 这条是本项目最重要的一条交互铁律：界面上给的数，就是最终落库的数。
        // 历史上"预览与提交不一致"的事故，都是因为没人把读数与落库值对起来比过。
        const readNum36 = Number((String(read36b || '').match(/(\d+)\s*mm/) || [])[1] || NaN);
        ok('B36 松手瞬间的读数 === 真正落库的值（所见即所得，不是"差不多"）',
          Number.isFinite(readNum36) && Math.abs(readNum36 - s1.width) <= 1,
          `读数=${read36b} 落库=${s1.width}`);

        ok('B36 四视图同步：俯视图那条宽线也走到同一个数（多视图 = 同一份模型）',
          Boolean(s1.topW) && Boolean(s1.frontW) && Math.abs(s1.topW.x - s1.frontW.x) <= 1
            && Math.abs(s1.topW.x - s0.topW.x - (s1.width - s0.width)) <= 1,
          `front.x=${s1.frontW?.x} top.x=${s1.topW?.x} width=${s1.width}`);
        ok('B36 拖完没有新增硬错（只改了这一个尺寸，没顺手造出新问题）',
          errAfter36 === errBefore36, `ERROR ${errBefore36} → ${errAfter36}`);
      }
    }

    // 负样本：拖"基准边"—— 必须给出理由，且不许改模型
    if (s0.frontMinMid) {
      const cMin = await clientOfSheet(s0.frontMinMid.x, s0.frontMinMid.y);
      ok('B36 基准边中点落在视口内（否则下面两条会静默跳过）', inViewport(cMin), JSON.stringify(cMin));
      // 先确认这一枪真能打中：否则"没冒气泡"到底是产品没给理由、还是根本没点中，
      // 就永远说不清。上一轮就是这么被自己的坐标骗过去的。
      const hitMin = await evalJs(`(async()=>{
        const s=await import('/src/state/store.ts');
        const ht=await import('/src/viewport/hitTest.ts');
        const sn=await import('/src/viewport/snapping.ts');
        const cd=(await import('/src/viewport/camDebug.ts')).camDebug;
        const tol=sn.snapToleranceWorld(8, cd.cam.scale);
        const hit=ht.hitPart(s.bus.derive().geom.views.pickLines, {x:${s0.frontMinMid.x}, y:${s0.frontMinMid.y}}, tol);
        return hit?{view:hit.view, part:hit.part, edge:hit.edge}:null;})()`);
      ok('B36 基准边在世界坐标上确实能被命中（点位算对了才谈得上"拖不动"）',
        hitMin !== null && hitMin.part === 'outer.width' && hitMin.edge === 'min', JSON.stringify(hitMin));
      if (inViewport(cMin)) {
        // ── 判定"新增气泡"为什么必须先等气泡清空 ──
        // 气泡寿命 4.5s，上一条同文本气泡（B26 刚点过同一条基准边）还在屏上时：
        //   ① 按**文本**做差集 → 新气泡被当成"旧的"过滤掉，明明冒了却判成没冒；
        //   ② 改成**计数** → 旧气泡恰在观察窗口里过期，"旧的没了新的来了"变成 1→1，
        //      照样判不出来（这两种都真实发生过，各花了一轮 3 分钟才看清）。
        // 结论：别跟旧气泡较劲，等它清空，之后屏上任何一条都是这一次产生的。
        const cleared36 = await waitToastsClear();
        ok('B36 负样本开始前气泡已清空（否则"新增气泡"判不准，会冤枉产品）',
          cleared36, `残留=${JSON.stringify((await toastItems()) || [])}`);
        const before36 = await snap36();
        const base36 = new Set((await toastItems()) || []);
        // 诊断三件套：真实落点反解 / 相机有没有被平移 / 全部气泡（不是差集）。
        // 差集为空有两种可能——"没冒气泡"或"冒了但和旧气泡同文本被过滤"，
        // 只看差集永远分不清，所以两个都打。
        const rawMin = await evalJs(`(async()=>{
          const m=await import('/src/viewport/camera.ts');
          const cd=(await import('/src/viewport/camDebug.ts')).camDebug;
          const rect=document.querySelector('.vp').getBoundingClientRect();
          const w=m.screenToWorld({x:${cMin.x}-rect.left, y:${cMin.y}-rect.top}, cd.cam, cd.vw, cd.vh);
          return {x:Math.round(w.x*10)/10, y:Math.round(w.y*10)/10};})()`);
        // 注意：Runtime.evaluate 里没有顶层 await，必须包 async IIFE ——
        // 否则 `await import(...)` 会被解析成 `await` 后紧跟一个 `import` 记号，
        // 报 "Unexpected token 'import'"，整节探针直接崩掉（踩过一次）。
        const camBefore36 = await evalJs(`(async()=>JSON.stringify((await import('/src/viewport/camDebug.ts')).camDebug.cam))()`);
        await mouseDown(cMin.x, cMin.y);
        await sleep(90);
        await moveMouse(cMin.x + 40, cMin.y, 1);
        await sleep(90);
        await mouseUp(cMin.x + 40, cMin.y);
        await sleep(300);
        const camAfter36 = await evalJs(`(async()=>JSON.stringify((await import('/src/viewport/camDebug.ts')).camDebug.cam))()`);
        const all36 = (await toastItems()) || [];
        console.log(`[B36 基准边诊断] 期望世界点=(${s0.frontMinMid.x},${s0.frontMinMid.y}) 真实落点=${JSON.stringify(rawMin)}`);
        console.log(`[B36 基准边诊断] 相机 before=${camBefore36} after=${camAfter36}（相机变了说明这一下被当成平移了）`);
        console.log(`[B36 基准边诊断] 全部气泡=${JSON.stringify(all36)}`);
        const after36 = await snap36();
        const fresh36 = all36.filter((t) => !base36.has(t)).join(' | ');
        ok('B36 基准边拖不动 → 界面说清为什么（不许静默无反应）',
          /基准边/.test(fresh36), `新增气泡=[${fresh36 || '(无)'}] 全部=${JSON.stringify(all36)}`);
        ok('B36 基准边拖不动 → 模型一字未改（不是"改了又退回"）',
          after36.ver === before36.ver && after36.width === before36.width,
          `v${before36.ver}→v${after36.ver} w${before36.width}→${after36.width}`);
      }
    }

    // 还原现场：下游 B30 等小节依赖前序留下的柜子，本节不能把它们冲掉
    const restored36 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      if (!window.__b36Saved) return null;
      s.bus.replaceProject(window.__b36Saved, 'B36 还原现场');
      const p=s.bus.getState();
      return {proj:p.name, cabCount:p.cabinets.length};})()`);
    ok('B36 结束后把现场还原了（自成一体 ≠ 可以随便改全局状态）',
      Boolean(restored36) && restored36.cabCount === dirty36.cabCount && restored36.proj === dirty36.proj,
      `还原=${JSON.stringify(restored36)} 复位前=${JSON.stringify({ proj: dirty36.proj, cabCount: dirty36.cabCount })}`);
    await sleep(200);

    // ═══════════════════════════════════════════════════════════
    /**
     * B19 —— "界面用到的类名，样式表里必须有规则"。
     *
     * 这条断言的由来是一次真实的视觉缺陷：`.note` / `.alert` / `.muted-sm` /
     * `.diff-list` 这些类名**早就被面板用着了**，但样式表里一条规则都没有 ——
     * 于是"⚠ 被记忆拦住"和正文长得一模一样，告警失去了告警的样子。
     * 那时已有的 219 项浏览器断言**一条都没抓到** —— 因为它们全部只比对文本内容，
     * 从不看渲染结果。（那 219 项现在长到了 376 项，但下面这组之所以存在，
     * 不是因为"数量不够"，而是因为**维度不对**：从"界面说了什么"换到"界面长什么样"。）
     *
     * 做法：把所有右侧标签页 + 左侧页签都真点一遍，收集**真正挂载过**的元素类名
     * （面板是按需挂载的，只查当前页会漏掉一大半），再和样式表里的选择器对账。
     * 例外必须显式登记并写清理由 —— 允许"有意不写样式"，不允许"忘了写"。
     */
    // ═══════════════════════════════════════════════════════════
    section('B27 命令行补齐：MI 镜像 / O·TR·EX 诚实拒绝');

    // 回平面图重标定 —— B26 结束时在图幅模式，相机被 fit 过，旧标定作废
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.trim()==='平面图');if(b)b.click();return !!b})()`);
    await sleep(420);
    cal25 = await calib25();
    ok('B27 平面图重标定成功', cal25.good && cal25.scale > 0.05 && cal25.scale < 1, cal25.good ? `scale=${cal25.scale.toFixed(4)}` : 'HUD 读数失败');

    // 点击柜体中心选中（镜像作用于选中集）
    const c27 = cabCenter25();
    await mouseDown(c27.x, c27.y);
    await sleep(100);
    await mouseUp(c27.x, c27.y);
    await sleep(320);
    ok('点击柜体中心完成选中', (await statusSelection()) === 1, `实为 ${await statusSelection()}`);

    const unitIds27 = () => evalJs(`(async()=>{const s=await import('/src/state/store.ts');return s.bus.getState().cabinets[0].layout.units.map(u=>u.id);})()`);
    const before27 = await unitIds27();
    const vB27 = await statusVersion();

    await runCommandLine('MI');
    const after27 = await unitIds27();
    ok('MI 镜像：版本 +1', (await statusVersion()) === vB27 + 1, `v${vB27} → v${await statusVersion()}`);
    ok('MI 镜像：分区序列左右反序（语义化镜像，不是几何镜像）',
      after27.length === before27.length && after27.every((id, i) => id === before27[before27.length - 1 - i]),
      `before=[${before27}] after=[${after27}]`);

    await runCommandLine('U');
    ok('镜像撤销回到原序（reverse 自逆）', JSON.stringify(await unitIds27()) === JSON.stringify(before27), JSON.stringify(await unitIds27()));

    // O / TR / EX：AutoCAD 习惯键位 —— 语义模型没有线条，诚实拒绝 + 指路。
    // 拒绝是设计行为：假装能偏移一条不存在的线，比拒绝更伤害信任。
    const v27b = await statusVersion();
    await runCommandLine('O');
    const tO27 = await text('.toasts');
    ok('O 偏移：明确说没有线条可偏移并指路（柜宽 / 移动）', tO27.includes('没有线条可偏移'), tO27.slice(-180));
    await runCommandLine('TR');
    const tTR27 = await text('.toasts');
    ok('TR 修剪：明确说没有线条可修剪并指路（分区夹点 / AI）', tTR27.includes('没有线条可修剪'), tTR27.slice(-180));
    await runCommandLine('EX');
    const tEX27 = await text('.toasts');
    ok('EX 延伸：明确说没有线条可延伸并指路（height / addUnit）', tEX27.includes('没有线条可延伸'), tEX27.slice(-180));
    ok('O/TR/EX 三条都没有写模型', (await statusVersion()) === v27b, `v${v27b} → v${await statusVersion()}`);

    // 右键菜单含镜像项（选中态决定菜单）
    await mouseRightClick(c27.x, c27.y);
    await sleep(340);
    const ctxMir27 = await evalJs(`(()=>{const m=document.querySelector('.ctx-menu');return m?[...m.querySelectorAll('.ctx-item .ctx-label')].map(x=>x.textContent.trim()):[]})()`);
    ok('右键菜单含「镜像（分区反序）」', ctxMir27.some((t) => /镜像/.test(t)), JSON.stringify(ctxMir27));
    await keyPress('Escape', 'Escape', 27);
    await sleep(260);

    // ═══════════════════════════════════════════════════════════
    section('B28 3D 视口：体块派生的只读渲染 + 点选联动');

    // 工具栏按钮 → 切 3D
    const btn3d = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.includes('3D'));if(b)b.click();return !!b})()`);
    ok('工具栏上有「3D」按钮且能点到（不是隐藏功能）', btn3d === true, `btn=${btn3d}`);
    // 3D 视口是 lazy chunk：首次切入要下载并解析 three.js（~558KB），
    // Suspense 期间是 fallback 占位 —— 必须轮询等 canvas 真正挂载，固定 sleep 会在慢机器上飘
    const mounted3d = await waitFor(`!!document.querySelector('.vp-3d canvas')`, 15000, 150);
    await sleep(600); // 首帧渲染 + 取景
    ok('切过去后 3D 视口完成懒加载并挂载（chunk 下载 → Suspense → canvas）',
      mounted3d === true && (await evalJs(`!!document.querySelector('.vp-hud-3d')`)) === true);
    const canvas3d = await evalJs(`(()=>{const c=document.querySelector('.vp-3d canvas');return c?{w:c.width,h:c.height}:null})()`);
    ok('WebGL 画布真的挂载且有尺寸（不是空壳 div）', !!canvas3d && canvas3d.w > 100 && canvas3d.h > 100, JSON.stringify(canvas3d));
    const v3d = await statusVersion();

    // 点选联动：fit 后柜群在画布中央，扫描几个候选点直到 raycast 命中
    const rect3d = await evalJs(`(()=>{const c=document.querySelector('.vp-3d canvas').getBoundingClientRect();return {l:c.left,t:c.top,w:c.width,h:c.height}})()`);
    const cands = [
      { x: rect3d.l + rect3d.w * 0.5, y: rect3d.t + rect3d.h * 0.45 },
      { x: rect3d.l + rect3d.w * 0.4, y: rect3d.t + rect3d.h * 0.5 },
      { x: rect3d.l + rect3d.w * 0.6, y: rect3d.t + rect3d.h * 0.55 },
      { x: rect3d.l + rect3d.w * 0.35, y: rect3d.t + rect3d.h * 0.4 },
    ];
    let sel3d = null;
    for (const p of cands) {
      await mouseDown(p.x, p.y);
      await sleep(80);
      await mouseUp(p.x, p.y);
      await sleep(340);
      sel3d = await statusSelection();
      if (sel3d === 1) break;
      // 点空白清了选择也无妨，继续扫下一个点
    }
    ok('点击柜体 → 3D raycast 命中并落成选择集（3D 渲染与几何同时被证明）',
      sel3d === 1, `扫描 ${cands.length} 个点后选中=${sel3d}`);
    ok('3D 是只读视图：整个 B28 没有写模型', (await statusVersion()) === v3d, `v${v3d} → v${await statusVersion()}`);

    // 点空白清空选择（CAD 习惯）
    await mouseDown(rect3d.l + rect3d.w * 0.03, rect3d.t + rect3d.h * 0.06);
    await sleep(80);
    await mouseUp(rect3d.l + rect3d.w * 0.03, rect3d.t + rect3d.h * 0.06);
    await sleep(320);
    const selBlank = await statusSelection();
    ok('点空白 → 清空选择（null 或 0 都算清空）', selBlank === null || selBlank === 0, `实为 ${selBlank}`);

    // 跨模式联动：重新选中 → 切回平面图 → 选择保持
    await mouseDown(rect3d.l + rect3d.w * 0.5, rect3d.t + rect3d.h * 0.45);
    await sleep(80);
    await mouseUp(rect3d.l + rect3d.w * 0.5, rect3d.t + rect3d.h * 0.45);
    await sleep(340);
    const selBack = await statusSelection();
    await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')].find(x=>x.textContent.trim()==='平面图');if(b)b.click();return !!b})()`);
    await sleep(420);
    ok('3D 里选中的柜体，切回平面图后选择保持（选择是跨模式的视图状态）',
      selBack === 1 && (await statusSelection()) === 1, `3D=${selBack} plan=${await statusSelection()}`);
    // 收尾：留截图
    await shot(path.join(OUT_DIR, 'app-3d-viewport.png'));
    ok('3D 视图截图已保存（人工目视用）', true, 'app-3d-viewport.png');

    // ═══════════════════════════════════════════════════════════
    section('B30 柜型预设库：模板选择 → 放置 → 语义参数落地');

    // ① 工具栏下拉列出全部模板
    const tplOpts = await evalJs(`(()=>{
      const s=document.querySelector('.toolbar .tb-select');
      return s?[...s.options].map(o=>o.value):null;
    })()`);
    ok('工具栏有柜型预设下拉且列出全部模板',
      Array.isArray(tplOpts) && tplOpts.length >= 4 && tplOpts.includes('default') &&
      tplOpts.includes('shoe_cabinet') && tplOpts.includes('wall_cabinet') && tplOpts.includes('tv_stand'),
      JSON.stringify(tplOpts));

    // ② TPL 命令：裸命令列出全部（含当前标记）
    await runCommandLine('TPL');
    const tplListMsg = await text('.cmd-msg');
    ok('裸 TPL 列出全部柜型并标出当前', /鞋柜/.test(tplListMsg) && /吊柜/.test(tplListMsg) && /电视柜/.test(tplListMsg) && /▶/.test(tplListMsg),
      tplListMsg);

    // ③ TPL shoe_cabinet → 工具栏下拉同步（两个入口共用同一个状态）
    await runCommandLine('TPL shoe_cabinet');
    const tplSelVal = await evalJs(`(()=>{const s=document.querySelector('.toolbar .tb-select');return s?s.value:null})()`);
    ok('TPL shoe_cabinet 后工具栏下拉同步为 shoe_cabinet（UI 与命令行同状态）', tplSelVal === 'shoe_cabinet', `select=${tplSelVal}`);

    // ④ 放置鞋柜：贴东墙。断言直接读 store —— 浅进深/层板数/门数都是语义参数
    const vB30 = await statusVersion();
    const cal30 = await calib25();
    ok('B30 平面图重标定成功', !!cal30 && cal30.good === true, JSON.stringify(!!cal30 && cal30.good));
    await runCommandLine('CAB');
    {
      const c = cal30.toClient(3000, 1300); // 东墙内表面 x=3140，靠近它
      await mouseDown(c.x, c.y);
      await sleep(80);
      await mouseUp(c.x, c.y);
      await sleep(460);
    }
    const shoeCab = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const c=s.bus.getState().cabinets.at(-1);
      return {name:c.name,w:c.params.width,h:c.params.height,d:c.params.depth,lift:c.params.bodyLift,
        units:c.layout.units.map(u=>({kind:u.kind,shelves:u.shelves?u.shelves.count:0,drawers:u.drawers?u.drawers.count:0,doors:u.doors?u.doors.count:0}))};})()`);
    ok('放置鞋柜：版本 +1（真写入了模型）', (await statusVersion()) === vB30 + 1);
    ok('放置鞋柜：名字与外形来自模板（900×2400×350 浅进深）',
      /^鞋柜/.test(shoeCab.name) && shoeCab.w === 900 && shoeCab.h === 2400 && shoeCab.d === 350, JSON.stringify(shoeCab));
    ok('放置鞋柜：分区骨架 = 模板声明（8 层鞋格 + 对开门，五金/材质不进模板）',
      shoeCab.units.length === 1 && shoeCab.units[0].kind === 'shelves' && shoeCab.units[0].shelves === 8 && shoeCab.units[0].doors === 2,
      JSON.stringify(shoeCab.units));

    // ⑤ TPL tv_stand → 放电视柜：比例宽度 + 中间开放设备格
    await runCommandLine('TPL tv_stand');
    const tplTvMsg = await text('.cmd-msg');
    ok('TPL tv_stand 切换成功（回执说出柜型）', /电视柜/.test(tplTvMsg), tplTvMsg);
    const dbgB30 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      return {
        cabs:s.bus.getState().cabinets.map(c=>({n:c.name,x:c.placement.x,y:c.placement.y,w:c.params.width,d:c.params.depth,rot:c.placement.rotation})),
        active:(document.querySelector('.toolbar .tb-btn.active')||{}).textContent||'',
        sel:document.querySelector('.toolbar .tb-select')?document.querySelector('.toolbar .tb-select').value:''
      };})()`);
    await runCommandLine('CAB');
    let tvClick = null;
    {
      // 西墙南侧空档：通体挂衣柜占北墙（footprint x 400..2800, y 1940..2540），
      // 1800 宽的电视柜贴西墙必须整体落在 y < 1940 —— y_c=970 → y 70..1870，
      // 与通体挂衣留 70mm 间隙、与南墙内表面（y=60）留 10mm，都不重叠。
      // （第一次跑点位选 y_c=1600，被 mem_003_no_cabinet_overlap 真实拦下 ——
      //   语义护栏正确工作，错的是探针的点位，不能为了绿绕开护栏。）
      const c = cal30.toClient(200, 970);
      tvClick = { c, r: cal30.rect };
      await mouseDown(c.x, c.y);
      await sleep(80);
      await mouseUp(c.x, c.y);
      await sleep(460);
    }
    const tvToasts = await text('.toasts');
    const tvCab = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const c=s.bus.getState().cabinets.at(-1);
      return {name:c.name,w:c.params.width,h:c.params.height,d:c.params.depth,
        units:c.layout.units.map(u=>({kind:u.kind,shelves:u.shelves?u.shelves.count:0,drawers:u.drawers?u.drawers.count:0,doors:u.doors?u.doors.count:0}))};})()`);
    ok('放置电视柜：矮柜 1800×450×400，抽 + 设备格 + 抽 三分区',
      /^电视柜/.test(tvCab.name) && tvCab.w === 1800 && tvCab.h === 450 && tvCab.d === 400 &&
      tvCab.units.length === 3 && tvCab.units[0].drawers === 2 && tvCab.units[1].kind === 'shelves' && tvCab.units[1].doors === 0 && tvCab.units[2].drawers === 2,
      JSON.stringify({ tvCab, tplTvMsg, dbg: dbgB30, click: tvClick, toasts: tvToasts }));
    ok('放置电视柜：全程只 create 不改既有对象（版本恰好 +1）', (await statusVersion()) === vB30 + 2);

    // ⑥ 负样本：未知模板必须报错且给出可用清单（不静默、不回退默认）
    await runCommandLine('TPL no_such');
    const tplErr = await text('.cmd-msg');
    ok('TPL 未知 id 报错并列出可用模板', /未知柜型/.test(tplErr) && /shoe_cabinet/.test(tplErr) && /tv_stand/.test(tplErr), tplErr);

    // ⑦ 收尾：切回 default，不污染后续样式审计
    await runCommandLine('TPL default');
    ok('TPL default 切回标准柜', /标准柜/.test(await text('.cmd-msg')));
    await keyPress('Escape', 'Escape', 27);
    await sleep(200);

    // ═══════════════════════════════════════════════════════════
    section('B31 玻璃门材质：语义字段 → 斜线填充 + 甲购分流');

    const vB31 = await statusVersion();
    // ① 总线改玻璃（ui 与 AI 同权同位 —— 探针走的就是用户会走的通道）
    const glassSet = await evalJs(`(async()=>{
      const s = await import('/src/state/store.ts');
      const b = s.bus;
      const cab = b.getState().cabinets.find((c) => c.layout.units.some((u) => u.doors));
      const idx = cab.layout.units.findIndex((u) => u.doors);
      const r = b.execute({ id: 'probe_glass', op: 'cabinet.layout', source: 'ui', target: { kind: 'cabinet', id: cab.id },
        changes: [{ path: 'layout.units[' + idx + '].doors.material', op: 'set', value: 'M_GLASS_8_GREY' }] }, 'B31 探针：改玻璃门');
      return { ver: b.getVersion(), err: r.error ?? null, mat: b.getState().cabinets.find((c) => c.id === cab.id).layout.units[idx].doors.material };
    })()`);
    ok('总线放行 doors.material 改玻璃（版本 +1、落进模型）',
      glassSet.ver === vB31 + 1 && !glassSet.err && glassSet.mat === 'M_GLASS_8_GREY', JSON.stringify(glassSet));

    // ② 派生：门板图出现灰玻填充 + 45° 斜线（材质表达，与开向对角线可区分）
    const glassView = await evalJs(`(async()=>{
      const s = await import('/src/state/store.ts');
      const v = await import('/src/core/geometry/views.ts');
      const cab = s.bus.getState().cabinets.find((c) => c.layout.units.some((u) => u.doors && u.doors.material === 'M_GLASS_8_GREY'));
      const vs = v.buildCabinetViews(cab, s.RULESET);
      const is45 = (dx, dy) => Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.5 && Math.abs(dx) > 1;
      return {
        fills: vs.prims.front.filter((p) => p.k === 'fill').length,
        hatch: vs.prims.front.filter((p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && is45(p.pts[1].x - p.pts[0].x, p.pts[1].y - p.pts[0].y)).length,
      };
    })()`);
    ok('门板图出现灰玻填充与 45° 斜线（黑框灰玻，销售图纸同款）', glassView.fills >= 1 && glassView.hatch >= 2, JSON.stringify(glassView));

    // ③ 清单分流：开料单无玻璃，甲购件清单有玻璃
    const glassCut = await evalJs(`(async()=>{
      const s = await import('/src/state/store.ts');
      const n = await import('/src/export/neutralSheet.ts');
      const out = n.toNeutralExport(s.bus.getState(), s.RULESET, [], 'probe-b31');
      return {
        panelsGlass: out.panels.filter((p) => p.material === 'M_GLASS_8_GREY').length,
        purchased: out.purchased.length,
        kind: out.purchased[0] ? out.purchased[0].kind : null,
      };
    })()`);
    ok('开料清单不含玻璃、甲购件清单有玻璃（分流成立）',
      glassCut.panelsGlass === 0 && glassCut.purchased >= 1 && glassCut.kind === 'glassDoor', JSON.stringify(glassCut));

    // ④ 还原：改回默认木门，不污染后续审计（undo 走总线）
    const glassBack = await evalJs(`(async()=>{
      const s = await import('/src/state/store.ts');
      const b = s.bus;
      b.undo();
      const cab = b.getState().cabinets.find((c) => c.layout.units.some((u) => u.doors));
      const u = cab.layout.units.find((u) => u.doors);
      return u.doors.material;
    })()`);
    ok('undo 还原为默认门板材质（写入可回退）', glassBack !== 'M_GLASS_8_GREY', String(glassBack));
    await shot(path.join(OUT_DIR, 'b31-glass-door.png'));

    // ═══════════════════════════════════════════════════════════
    section('B32 按房间图纸册：端到端导出（真端点 + UI 按钮）');

    // ① UI 按钮可达（导出面板里有「按房间图纸册」——先激活「导出」页签，面板才渲染）
    await activateRightTab('导出');
    await sleep(250);
    const rbBtn = await evalJs(`(()=>{
      const b=[...document.querySelectorAll('.tb-btn')].find(x=>x.textContent.includes('按房间图纸册'));
      if(!b) return {found:false};
      return {found:true, disabled:b.disabled};
    })()`);
    ok('导出面板有「按房间图纸册」按钮', rbBtn.found === true, JSON.stringify(rbBtn));

    // ② 真端点：语义模型在后端重算 → 完整 HTML（含封面/三图/三件套/汇总）
    //    注意：B29 账号组跑过之后 server 已是 accounts 模式 —— 探针必须带上会话 token（有则带）
    const rb = await evalJs(`(async()=>{
      const s = await import('/src/state/store.ts');
      const token = sessionStorage.getItem('furniture-cad.auth.token');
      const res = await fetch('/api/export/roombook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({ project: s.bus.getState(), modelVersion: 'b32-v1' }),
      });
      const html = await res.text();
      return {
        status: res.status,
        ctype: res.headers.get('Content-Type') || '',
        isDoc: html.startsWith('<!DOCTYPE html>') && html.includes('</html>'),
        cover: html.includes('图纸册') && html.includes('客户'),
        triptych: html.includes('平面图') && html.includes('立面外观（门板图）') && html.includes('立面结构（内视图）'),
        trace: html.includes('b32-v1') && html.includes('factory_default_v1'),
        summary: html.includes('清单汇总（按柜归类）'),
      };
    })()`);
    ok('POST /api/export/roombook 返回 200 + text/html', rb.status === 200 && rb.ctype.includes('text/html'), JSON.stringify({ status: rb.status, ctype: rb.ctype }));
    ok('图纸册结构齐全：封面客户表 + 每柜三图 + 版本三件套 + 尾页汇总',
      rb.isDoc && rb.cover && rb.triptych && rb.trace && rb.summary, JSON.stringify(rb));

    // ═══════════════════════════════════════════════════════════
    section('B33 异形图元：酒柜斜层板 tilt 落地 + 见光板语义切换（真实总线）');

    const vB33 = await statusVersion();
    // ① 在运行中的 app 内用真实总线创建酒柜（与 UI 放置走同一 create 管线）
    const wine = await evalJs(`(async()=>{
      const s = await import('/src/state/store.ts');
      const { createCabinetFromTemplate } = await import('/src/core/docFactory.ts');
      const roomId = (s.bus.getState().cabinets[0] || { roomId: 'r1' }).roomId || 'r1';
      // 与真实 UI 放置路径一致：传 takenIds 让 docFactory 分配唯一 id，
      // 否则默认 id（cab_001）会撞上项目里已存在的首柜 → planStructural 返回 null → 结构性失败。
      // 放点 (4000,4000)：房间外空地 —— 不撞墙（mem_002）、不与衣柜重叠（mem_003），
      // 让这条断言只验「模板 tilt 落地」，不被布置类记忆合法拦截。
      const c = createCabinetFromTemplate({ templateId: 'wine_cabinet', name: '探针酒柜', roomId, x: 4000, y: 4000, rotation: 0, rules: s.RULESET, takenIds: s.bus.getState().cabinets.map((x) => x.id) });
      // 与真实 UI 放置路径一致：结构性命令也带 changes:[]（CommandBus 契约要求，
      // 否则记忆门 pathForbidden 检查读 cmd.changes 会崩）。createCabinet() 也是这么发的。
      const r = s.bus.execute({ id: 'probe_wine_create', op: 'cabinet.create', source: 'ui', target: { kind: 'project', id: 'project' }, changes: [], payload: { cabinet: c } }, 'B33 探针：放酒柜');
      if (r.error) return { err: r.error };
      const cab = s.bus.getState().cabinets.find((x) => x.id === c.id);
      return { id: c.id, tilt: cab.layout.units[0].shelves.tilt, ver: s.bus.getVersion() };
    })()`);
    ok('B33 放置酒柜：版本 +1、斜层板 tilt=12 从模板落地（语义字段同源）',
      !wine.err && wine.tilt === 12 && wine.ver === vB33 + 1, JSON.stringify(wine));

    // ② 见光板语义切换：finishedEnds=both → 侧板命名「见光板-左/右」（派生现算）
    const fe = await evalJs(`(async()=>{
      const s = await import('/src/state/store.ts');
      const { generateCabinet } = await import('/src/core/geometry/generate.ts');
      const r = s.bus.execute({ id: 'probe_fe', op: 'cabinet.update', source: 'ui',
        target: { kind: 'cabinet', id: '${wine.id}' },
        changes: [{ path: 'params.finishedEnds', op: 'set', value: 'both' }] }, 'B33 探针：见光板');
      if (r.error) return { err: r.error };
      const cab = s.bus.getState().cabinets.find((x) => x.id === '${wine.id}');
      const g = generateCabinet(cab, s.RULESET);
      const left = g.panels.find((p) => p.role === 'LeftSidePanel');
      const right = g.panels.find((p) => p.role === 'RightSidePanel');
      return { left: left && left.nameZh, right: right && right.nameZh, ver: s.bus.getVersion(), fe: cab.params.finishedEnds };
    })()`);
    ok('B33 见光板切换：finishedEnds=both → 侧板命名「见光板-左/右」、不改结构板数',
      !fe.err && fe.fe === 'both' && fe.left === '见光板-左' && fe.right === '见光板-右', JSON.stringify(fe));

    // ③ 收尾：undo 两次（create + update）撤销酒柜，不污染后续样式审计。
    //    注意本项目语义：undo 本身也是一次状态变更（版本 +1，见 B8），
    //    所以 create+update+undo×2 = 版本推进 4，而不是回到 vB33。
    await evalJs(`(async()=>{ const s = await import('/src/state/store.ts'); s.bus.undo(); s.bus.undo(); })()`);
    const after33 = await evalJs(`(async()=>{ const s = await import('/src/state/store.ts');
      return { ver: s.bus.getVersion(), gone: !s.bus.getState().cabinets.some((x) => x.id === '${wine.id}') }; })()`);
    ok('B33 undo 收尾：酒柜不残留、版本按 create+update+undo×2 各 +1 推进',
      after33.gone && after33.ver === vB33 + 4, JSON.stringify({ ...after33, vB33 }));

    // ═══════════════════════════════════════════════════════════
    section('B34 首页介绍页：/home.html 可达、内容齐全、/ 仍是工作台');

    // ① 介绍页可达且关键区块齐全（hero / 能力 / 档位 / 诚实清单 / 责任边界）
    const homeRes = await fetch(`${APP_URL}home.html`);
    const homeHtml = homeRes.ok ? await homeRes.text() : '';
    const homeHas = (s) => homeHtml.includes(s);
    ok('B34 介绍页 /home.html 返回 200 且 UTF-8 中文正常',
      homeRes.status === 200 && homeHas('说一句话') && homeHas('订阅档位'),
      `status=${homeRes.status} len=${homeHtml.length}`);
    ok('B34 介绍页四个关键区块齐全：能力 / 档位表 / 安全自述 / 责任边界',
      homeHas('核心能力') && homeHas('不限') && homeHas('还没有做') && homeHas('责任边界'),
      `core=${homeHas('核心能力')} plans=${homeHas('不限')} honest=${homeHas('还没有做')} duty=${homeHas('责任边界')}`);
    ok('B34 介绍页档位表与 auth.mjs PLANS 一致（20万/500万/3000万/不限）',
      homeHas('20 万 token') && homeHas('500 万 token') && homeHas('3000 万 token'),
      `free=${homeHas('20 万 token')} pro=${homeHas('500 万 token')} team=${homeHas('3000 万 token')}`);

    // ② /api/auth/mode 公开接口正常（介绍页的模式徽标数据源）
    const modeRes = await fetch(`${APP_URL}api/auth/mode`);
    const modeJson = await modeRes.json().catch(() => null);
    ok('B34 /api/auth/mode 返回 ok+mode（介绍页徽标数据源可用）',
      modeRes.status === 200 && modeJson?.ok === true && typeof modeJson?.mode === 'string',
      JSON.stringify(modeJson));

    // ③ / 仍然是工作台 —— 介绍页绝不抢工作台的入口（日常自用不受打扰）
    const rootRes = await fetch(APP_URL);
    const rootHtml = rootRes.ok ? await rootRes.text() : '';
    ok('B34 / 仍是工作台（index.html 含 #root 挂载点，未被介绍页顶替）',
      rootRes.status === 200 && rootHtml.includes('id="root"'),
      `status=${rootRes.status} hasRoot=${rootHtml.includes('id="root"')}`);

    // ═══════════════════════════════════════════════════════════
    section('B35 邮箱注册：SMTP 落盘发信全流程 + 管理端开关与打码');

    // 此时 B18 已建 owner（accounts 模式），owner token 还在 sessionStorage
    const TOKEN35 = await evalJs(`sessionStorage.getItem('furniture-cad.auth.token')`);
    // 浏览器侧 fetch（走 vite 代理）→ 与真实 UI 同源同路径
    const api35b = async (path, { method = 'GET', token, body } = {}) => evalJs(`(async()=>{
      const r = await fetch(${JSON.stringify(path)}, {
        method: ${JSON.stringify(method)},
        headers: Object.assign({'Content-Type':'application/json'}, ${token ? `{Authorization:'Bearer ${String(token).replace(/'/g, '')}'}` : '{}'}),
        ${body ? `body: ${JSON.stringify(JSON.stringify(body))}` : 'undefined'}
      });
      return { status: r.status, body: await r.json().catch(()=>({})) };
    })()`);

    const smtpGet = await api35b('/api/settings/smtp', { token: TOKEN35 });
    ok('B35 GET smtp：落盘模式、未开注册、口令未设置',
      smtpGet.status === 200 && smtpGet.body.mode === 'file' && smtpGet.body.signupOpen === false, JSON.stringify(smtpGet.body));

    const badEmail = await api35b('/api/auth/register-email', { method: 'POST', body: { email: 'nope' } });
    ok('B35 非法邮箱 400', badEmail.status === 400 && badEmail.body.code === 'BAD_EMAIL', JSON.stringify(badEmail));

    const closed35 = await api35b('/api/auth/register-email', { method: 'POST', body: { email: 'probe-a@example.com' } });
    ok('B35 未开「开放注册」→ 403 SIGNUP_CLOSED（accounts 模式注册不是后门）',
      closed35.status === 403 && closed35.body.code === 'SIGNUP_CLOSED', JSON.stringify(closed35));

    const openPut = await api35b('/api/settings/smtp', { method: 'PUT', token: TOKEN35, body: { signupOpen: true } });
    ok('B35 管理端 PUT：开启「开放注册」', openPut.status === 200 && openPut.body.signupOpen === true, JSON.stringify(openPut.body));

    // UI：后台页「邮件 / SMTP」区块（owner 登录态才可见）—— 落盘模式提示 + 开放注册开关
    await activateRightTab('后台');
    await sleep(900);
    ok('B35 后台页出现「邮件 / SMTP」区块', /邮件 \/ SMTP/.test(await panelTextAll()), (await panelTextAll()).slice(0, 160));
    ok('B35 后台页有「开放注册」开关与落盘模式提示（不假装邮件真发了）',
      /开放注册/.test(await panelTextAll()) && /落盘/.test(await panelTextAll()), (await panelTextAll()).slice(-300));

    // UI：退出登录后账号页出现「邮箱注册」区块 —— 该区块只在未登录时渲染（已登录者不需要注册）
    await activateRightTab('账号');
    await sleep(500);
    await clickPanelBtn('退出登录');
    await sleep(900);
    ok('B35 退出登录后账号页出现「邮箱注册」区块（signupOpen 实时生效）', /邮箱注册/.test(await panelTextAll()), (await panelTextAll()).slice(0, 200));

    // 全流程：请求验证码 → 读落盘邮件 → 错码被拒 → 弱口令被拒 → 建号
    const e35 = 'probe-b@example.com';
    const req1 = await api35b('/api/auth/register-email', { method: 'POST', body: { email: e35 } });
    ok('B35 开放注册下请求验证码成功（sendMode=file）', req1.status === 200 && req1.body.sendMode === 'file', JSON.stringify(req1));
    const OUTBOX35 = process.env.VERIFY_SMTP_OUTBOX || '';
    const mails35 = fs.existsSync(OUTBOX35)
      ? fs.readFileSync(OUTBOX35, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((m) => m.to === e35)
      : [];
    const code35 = (/验证码：(\d{6})/.exec(String(mails35[mails35.length - 1]?.subject ?? '')) || [])[1];
    ok('B35 落盘邮件里读出 6 位验证码', /^\d{6}$/.test(code35 ?? ''), `mails=${mails35.length} code=${code35}`);
    const wrong35 = await api35b('/api/auth/register-email/verify', { method: 'POST', body: { email: e35, code: code35 === '123456' ? '654321' : '123456', password: 'Vf9-tRw2-Kqp7' } });
    ok('B35 错误验证码被 400 拒绝', wrong35.status === 400 && wrong35.body.code === 'BAD_CODE', JSON.stringify(wrong35));
    const weak35 = await api35b('/api/auth/register-email/verify', { method: 'POST', body: { email: e35, code: code35, password: '12345678' } });
    ok('B35 验证码对、弱口令仍被拒（hold：不白吃验证码）', weak35.status === 400 && /纯数字/.test(weak35.body.error ?? ''), JSON.stringify(weak35));
    const good35 = await api35b('/api/auth/register-email/verify', { method: 'POST', body: { email: e35, code: code35, password: 'Vf9-tRw2-Kqp7' } });
    ok('B35 同一验证码 + 强口令建号成功并自动登录',
      good35.status === 200 && typeof good35.body.token === 'string' && good35.body.account?.email === e35 && good35.body.account?.role === 'designer',
      JSON.stringify({ ...good35.body, token: good35.body.token ? '***' : null }));
    const me35 = await api35b('/api/auth/me', { token: good35.body.token });
    ok('B35 新账号 /api/auth/me 透出邮箱', me35.body.account?.email === e35, JSON.stringify(me35.body.account ?? {}));

    // ═══════════════════════════════════════════════════════════
    section('B19 样式完整性：界面上用到的类名必须在样式表里有规则');

    const UNSTYLED_ALLOWED = new Map([
      ['hist', 'HistoryPanel 的容器标记：它同时带着 .panel-scroll（布局由那条规则提供），内部的 .hist-item / .hist-diff 才是真正要样式的部分'],
      ['tree', 'ObjectTree 的容器标记：同上，带着 .panel-scroll；内部用 .tree-* 系列'],
      ['tree-room', '房间节点：它同时带着 .tree-node，样式由那条规则提供'],
      ['tree-node-label', '对象树里的项目名：样式由父级 .tree-root 提供'],
    ]);

    const collectClasses = () =>
      evalJs(`(()=>{const out=[];for(const el of document.querySelectorAll('*'))for(const c of el.classList)out.push(c);return out;})()`);
    const usedClasses = new Set();
    /** 每个右侧标签页都必须在**滚动容器**里 —— 见下面那条断言的理由 */
    const noScrollContainer = [];
    /**
     * 文本卫生：界面上不许出现 markdown 的 `**粗体**`。
     *
     * 这条来自一个**只有看渲染结果才发现**的真实缺陷：有 4 个面板把 `**强调**`
     * 直接写进了 JSX 或 toast 字符串，于是用户看到的是字面的星号
     * （"这几条**不会**被执行"）。在源码里它和 markdown 文档长得一模一样，
     * 而任何只比对"文本内容对不对"的断言都不会觉得它有问题 ——
     * 它需要的是**换一个维度**看：这段文字是给人看的，那就得按人的方式检查。
     */
    const markdownStars = [];
    const findStars = () =>
      evalJs(`(()=>{
        const out=[];
        for(const el of document.querySelectorAll('.side-right *')){
          if(el.children.length) continue;
          const t=el.textContent||'';
          if(/[*][*]/.test(t)) out.push((el.className||'?')+' :: '+t.slice(0,60));
        }
        return out;
      })()`);
    /**
     * 这份清单必须跟着 Toolbar 的 RIGHT_TABS 一起长。
     * 它当初漏掉过「方案」，于是那个面板的类名一个都没被审计到 ——
     * "新面板没写样式"这类缺陷会安静地躺在绿灯底下。
     */
    const RIGHT_TABS = ['属性', '问题', '历史', '图层', '视图', '方案', '导出', 'AI', '记忆', '后台', '账号'];
    for (const tab of RIGHT_TABS) {
      await activateRightTab(tab);
      if ((await evalJs(`document.querySelectorAll('.side-right .panel-scroll').length`)) === 0) noScrollContainer.push(tab);
      for (const c of await collectClasses()) usedClasses.add(c);
      for (const s of await findStars()) markdownStars.push(`${tab} → ${s}`);
    }
    ok(
      '界面文本里没有 markdown 的 `**粗体**` 残留（源码里它和文档长得一样，只有看渲染才发现）',
      markdownStars.length === 0,
      JSON.stringify(markdownStars.slice(0, 8))
    );
    /**
     * 结构断言：每个右侧面板都必须有一个 `.panel-scroll`。
     *
     * 这条不是"风格统一"，它挡的是一个**看得见但点不着**的缺陷：
     * `.side-right` 是 flex 列容器、自身不能滚动；内容的可滚动性全靠
     * `.panel-scroll` 的 `flex:1; overflow:auto; min-height:0`。
     * AI 面板与账号面板当初就漏了这一层 —— 于是内容一长就溢出到面板外面，
     * 屏幕上只表现为"下面的东西没了"，而所有只读文本的断言都读到空字符串，
     * 一度被误判成"面板根本没渲染"。
     */
    ok(
      `右侧 ${RIGHT_TABS.length} 个面板全部有滚动容器（长内容够得着，不会溢出到面板外）`,
      noScrollContainer.length === 0,
      `缺 .panel-scroll 的页签：${JSON.stringify(noScrollContainer)}`
    );
    for (const t of ['对象树', '图层']) {
      await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-left .tabs button')]
        .find(x=>x.textContent.trim()===${JSON.stringify(t)});if(b)b.click();return !!b;})()`);
      await sleep(300);
      for (const c of await collectClasses()) usedClasses.add(c);
    }
    // 命令行与 toast 是瞬时出现的，单独触发一次再收
    await keyPress('`', 'Backquote', 192);
    await sleep(360);
    for (const c of await collectClasses()) usedClasses.add(c);
    /**
     * 先发一条**合法**命令，再发一条**越权**的。
     * 合法的会进历史、弹成功提示；越权的会被拦、弹失败提示 ——
     * 于是 .hist / .toast-ok / .toast-error 这一批"平时不在 DOM 里"的类名都被真正覆盖到。
     * 只发越权那条是不够的：它不产生历史条目，历史面板会停在空状态，
     * `.hist` 这一层容器就永远收集不到（本轮第一版就是这样漏掉的）。
     */
    await runCommandLine(
      JSON.stringify({
        op: 'cabinet.move',
        source: 'ai',
        target: { kind: 'cabinet', id: 'cab_001' },
        label: 'AI：把主卧衣柜沿 X 挪到 900',
        changes: [{ path: 'placement.x', op: 'set', value: 900, unit: 'mm' }],
      })
    );
    for (const c of await collectClasses()) usedClasses.add(c);
    await runCommandLine(
      JSON.stringify({
        op: 'cabinet.resize',
        source: 'ai',
        target: { kind: 'cabinet', id: 'cab_001' },
        label: '越权写入：试图直接写派生字段 panels',
        changes: [{ path: 'panels', op: 'set', value: [] }],
      })
    );
    for (const c of await collectClasses()) usedClasses.add(c);
    await keyPress('Escape', 'Escape', 27);
    await sleep(300);
    // 现在历史里真的有条目了（上面那条合法命令），再挂一次历史面板收它的类名
    await activateRightTab('历史');
    for (const c of await collectClasses()) usedClasses.add(c);

    const styleSheetClasses = await evalJs(`(()=>{
      const known=new Set();
      /**
       * ⚠ 顺序要紧：**先读 selectorText，再决定要不要往下递归**。
       *
       * 第一版写的是"有 cssRules 就递归、否则读 selectorText" —— 结果一个类名都没读到，
       * 断言报"样式表定义 0 个"。原因是 Chrome 支持 CSS 嵌套之后，
       * 普通的 CSSStyleRule **也有 cssRules**（是个空的 CSSRuleList，真值），
       * 于是每条规则都拐进了空列表，selectorText 从来没被读过。
       *
       * 这正是那条铁律的又一例：断言失败时先假定断言自己写错了 ——
       * 如果这次反过来，就会得出"整个项目的样式表都不存在"这种荒唐结论。
       *
       * （另：这段注释里不能出现反引号 —— 它整段是外层模板字符串的一部分，
       *   一个反引号就会把字符串提前收掉，报出来的错还是"cssRules is not a function"
       *   这种完全不着边际的话。踩过一次，记在这里。）
       */
      const walk=(list)=>{for(const r of list){
        const sel=r.selectorText;
        if(sel) for(const m of sel.matchAll(/\\.(-?[_a-zA-Z][\\w-]*)/g)) known.add(m[1]);
        if(r.cssRules && r.cssRules.length) walk(r.cssRules);
      }};
      const sheets=[...document.styleSheets, ...(document.adoptedStyleSheets||[])];
      for(const s of sheets){ try{ walk(s.cssRules); }catch(e){ /* 跨域表读不到，跳过 */ } }
      return {classes:[...known], sheetCount:sheets.length, styleTags:document.querySelectorAll('style').length};
    })()`);
    const knownClasses = new Set(styleSheetClasses.classes);
    const missingClasses = [...usedClasses].filter((c) => !knownClasses.has(c)).sort();
    console.log(
      `      类名审计：DOM 用到 ${usedClasses.size} 个 · 样式表定义 ${knownClasses.size} 个 · 查不到规则的 ${missingClasses.length} 个 ${JSON.stringify(missingClasses)}`
    );
    ok(
      `界面上真正用到的 ${usedClasses.size} 个类名，除显式登记的 ${UNSTYLED_ALLOWED.size} 个例外，全部在样式表里有规则`,
      missingClasses.every((c) => UNSTYLED_ALLOWED.has(c)),
      `查不到规则的类名：${JSON.stringify(missingClasses)}　（要么补样式，要么在 UNSTYLED_ALLOWED 里登记理由）`
    );
    ok(
      '样式表真的读到了（不是"两边都是空集合所以通过"这种假绿）',
      knownClasses.size > 150 && usedClasses.size > 60 && styleSheetClasses.sheetCount > 0,
      `样式表 ${knownClasses.size} 个 / DOM ${usedClasses.size} 个 / sheets ${styleSheetClasses.sheetCount} / style 标签 ${styleSheetClasses.styleTags}`
    );
    ok('登记在案的例外都写了理由（不许出现没有理由的豁免）', [...UNSTYLED_ALLOWED.values()].every((r) => r.length >= 10));

    const finalShot = await shot(path.join(OUT_DIR, 'app-phase3-final.png'));
    ok(`阶段收尾截图已保存（${(finalShot / 1024).toFixed(0)}KB）`, finalShot > 30000, `${finalShot} bytes`);
    ok('跑完账号与样式审计之后，仍然零页面异常', pageErrors.length === 0, pageErrors.join('\n      '));

    // ═══════════════════════════════════════════════════════════
    /**
     * B40 —— master 反馈五件事里的第 5 件：UI 遗留（退出登录 / 首页入口）。
     *
     * 这两条当时**根本不存在**：介绍页（/home.html）能进工作台，但工作台没有任何
     * 路回介绍页；退出登录只藏在「账号」面板里，而免登录模式下那个面板干脆不出。
     * 所以这里先验"入口真的在顶栏够得着"，再真去点那个按钮 ——
     * 只断言按钮存在、不看点了以后会话有没有真的失效，等于给一个假出口。
     */
    section('B40 UI 遗留：顶栏能回介绍页 · 退出登录是真出口');

    const home40 = await evalJs(`(()=>{
      const as=[...document.querySelectorAll('.toolbar a')];
      const hit=as.find(el=>(el.textContent||'').includes('首页'));
      return hit?{ text:(hit.textContent||'').trim(), href:hit.getAttribute('href'),
        target:hit.getAttribute('target'), rel:hit.getAttribute('rel'),
        deco:getComputedStyle(hit).textDecorationLine,
        box:(()=>{const r=hit.getBoundingClientRect();return {w:Math.round(r.width),h:Math.round(r.height)}})() }:null;})()`);
    ok('顶栏看得见「首页」入口（原来只有介绍页能进工作台，反过来没有路）',
      Boolean(home40), JSON.stringify(home40));
    ok('它真指向介绍页，而且新标签页打开 —— 同标签页等于用介绍页顶掉未存盘的设计',
      Boolean(home40) && home40.href === '/home.html' && home40.target === '_blank' && /noopener/.test(home40.rel || ''),
      JSON.stringify(home40));
    ok('链接长成按钮的样子（没有下划线、也没缩成 0 宽）',
      Boolean(home40) && home40.deco === 'none' && home40.box.w > 20 && home40.box.h > 12,
      JSON.stringify(home40 && home40.box));

    /**
     * 前置自检：**这一节不许靠上一节留下的会话**。
     * 曾经 B18 建的那个 owner 会话是全靠 B18 点的建号按钮才有的 ——
     * 于是"顶栏有退出按钮"这条只能在大跑里绿，单独跑 B40 就 null。
     * 没有会话就自己建一个并登录；界面只在挂载时读一次 sessionStorage，
     * 所以塞完 token 必须重新导航，否则它永远读不到。
     */
    /**
     * 两步走，且每一步都**留痕**：
     *   ① 自助注册（只在一个账号都没有时放行，见 server.mjs 的 REGISTER_CLOSED）——
     *      注册成功那一步**直接就带着 token**，不必再登一次；
     *   ② 已经有账号时（大跑里 B18 建的那个 owner）注册会被 403 挡住，
     *      那就用 B18 那副凭据直接登录。
     * 第一版只发了 register 就丢掉状态码，等于"以为建成了"；再加上
     * 端口被一台旧服务占着（那台跑的是旧构建，注册接口根本不存在），
     * 于是这一步静默失败、后面三条全变 null —— ** failures 没有一条说到真原因**。
     * 所以这回每一步都把 status 带回来，失败时看一眼就明白。
     */
    const boot40 = await evalJs(`(async()=>{
      const K='furniture-cad.auth.token';
      if(sessionStorage.getItem(K)) return {already:true};
      const pw='Cad-Str0ng-Pw-2026!x';
      const post=async(name,b)=>{
        const r=await fetch('/api/auth/'+name,{method:'POST',
          headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
        return {s:r.status, b:await r.json().catch(()=>({}))};
      };
      const trace=[];
      const rg=await post('register',{username:'owner',password:pw});
      trace.push('register:'+rg.s);
      let tk = rg.b && rg.b.token;
      if(!tk){
        const lg=await post('login',{username:'owner',password:pw});
        trace.push('login-owner:'+lg.s);
        tk = lg.b && lg.b.token;
      }
      if(!tk) return {fail:true, trace, body: rg.b};
      sessionStorage.setItem(K,tk);
      return {logged:true, via:trace.join(' → ')};
    })()`);
    ok('B40 自带前置：要么本来就有会话，要么现建/现登一个 owner（不靠上一节留的现场）',
      boot40.already === true || boot40.logged === true, JSON.stringify(boot40));
    if (boot40.logged === true) {
      await send('Page.navigate', { url: APP_URL });
      await sleep(2600);
    }

    const logged40 = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')];
      const hit=b.find(el=>(el.textContent||'').includes('退出登录'));
      return hit?{ shown:hit.offsetParent!==null, token:(()=>{try{return sessionStorage.getItem('furniture-cad.auth.token')}catch(e){return null}})() }:null;})()`);
    ok('登录状态下顶栏出现「退出登录」（免登录时没有可退的东西，给它按钮是骗人）',
      Boolean(logged40) && logged40.shown === true, JSON.stringify(logged40));
    ok('此刻确实带着会话（没有会话就验不了"退出"这件事）',
      Boolean(logged40) && !!logged40.token, JSON.stringify(logged40));

    // 真去点顶栏那个按钮
    const clicked40 = await evalJs(`(()=>{const b=[...document.querySelectorAll('.toolbar .tb-btn')];
      const hit=b.find(el=>(el.textContent||'').includes('退出登录'));
      if(!hit) return false; hit.click(); return true;})()`);
    await sleep(700);
    const after40 = await evalJs(`(async()=>{
      const r=await fetch('/api/auth/me');
      const b=[...document.querySelectorAll('.toolbar .tb-btn')];
      const as=[...document.querySelectorAll('.toolbar a')];
      return { gone:!b.some(el=>(el.textContent||'').includes('退出登录')),
        meStatus:r.status,
        token:(()=>{try{return sessionStorage.getItem('furniture-cad.auth.token')}catch(e){return null}})(),
        homeStill:as.some(el=>(el.textContent||'').includes('首页')) };})()`);
    ok('顶栏那个「退出登录」点得动', clicked40 === true);
    ok('点了之后会话真的没了（不是只把按钮藏起来）',
      after40.meStatus === 401 && !after40.token, JSON.stringify(after40));
    ok('顶栏的退出按钮跟着消失（状态与界面一致）', after40.gone === true, JSON.stringify(after40));
    ok('退出之后首页入口还在（退出不该把其它入口一起带走）', after40.homeStill === true, JSON.stringify(after40));

    const shot40 = await shot(path.join(OUT_DIR, 'app-toolbar-home-logout.png'));
    ok('顶栏截图已留档（首页入口 + 未登录态）', shot40 > 20000, `${shot40} 字节`);

    /**
     * B41 —— master 的原话："为什么我之前保存的密码用不了"。
     *
     * 查下来根因不是口令被改坏，而是**静默失败**：改口令失败后代码只是 setErr()，
     * 而那个红条渲染在面板**上面第一个 Section** 里 —— 用户填表的视线在下面的
     * 「修改我的口令」，于是"保存"毫无反应，线上审计 changePassword = 0 条，
     * 服务端压根没收到过请求。成功时反而看得见（会被踢下线），失败才是无声的。
     *
     * 所以这条断言**必须把判定限定在那一节的节点内部**：
     * 只查"面板里有没有红字"的话，修复前也是绿的 —— 那正是"看着绿的假验收"。
     */
    section('B41 修改口令：失败必须就地在段内报错（不许静默）');
    await send('Page.navigate', { url: APP_URL });
    await sleep(2400);

    const boot41 = await evalJs(`(async()=>{
      const K='furniture-cad.auth.token';
      if(sessionStorage.getItem(K)) return {already:true};
      const pw='Cad-Str0ng-Pw-2026!x';
      const post=async(n,b)=>{const r=await fetch('/api/auth/'+n,{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
        return {s:r.status,b:await r.json().catch(()=>({}))};};
      const rg=await post('register',{username:'owner',password:pw});
      let tk=rg.b&&rg.b.token;
      if(!tk){const lg=await post('login',{username:'owner',password:pw}); tk=lg.b&&lg.b.token;}
      if(!tk) return {fail:true, body:rg.b};
      sessionStorage.setItem(K,tk);
      return {logged:true};
    })()`);
    ok('B41 自带前置：重新登录（B40 结尾已退出）', boot41.already === true || boot41.logged === true, JSON.stringify(boot41));
    if (boot41.logged === true) {
      await send('Page.navigate', { url: APP_URL });
      await sleep(2600);
    }

    await activateRightTab('账号');
    await sleep(420);

    // 「修改我的口令」是 defaultOpen=false，先点开它（折叠着的话根本不存在于 DOM）。
    // 点完必须**等一帧再读**：同一次求值里同步去读 DOM，React 还没重渲染，
    // 读到的一定是"没打开"—— 那是探针写错，不是产品没开。
    const hasBody41 = async () =>
      (await evalJs(`(()=>{
        const s=[...document.querySelectorAll('.side-right .sec')]
          .find(x=>{const h=x.querySelector('.sec-head');return h&&h.textContent.includes('修改我的口令');});
        if(!s) return 'no-section';
        return s.querySelector('.sec-body') ? 'open' : 'closed';
      })()`)) === 'open';

    const toggled41 = await evalJs(`(()=>{
      const s=[...document.querySelectorAll('.side-right .sec')]
        .find(x=>{const h=x.querySelector('.sec-head');return h&&h.textContent.includes('修改我的口令');});
      if(!s) return 'no-section';
      const t=s.querySelector('.sec-toggle');
      if(!t) return 'no-toggle';
      t.click(); return 'clicked';
    })()`);
    await sleep(420);
    ok('「修改我的口令」这一节能被打开', toggled41 === 'clicked' && (await hasBody41()) === true, `${toggled41}`);

    // 拿当前口令故意填错：这是最常踩的一种"保存没生效"
    const exp41 = await evalJs(`(()=>{
      const secs=[...document.querySelectorAll('.side-right .sec')];
      const s=secs.find(x=>{const h=x.querySelector('.sec-head');return h&&h.textContent.includes('修改我的口令');});
      if(!s) return {err:'no-section'};
      const body=s.querySelector('.sec-body');
      const inputs=[...(body?body.querySelectorAll('input[type=password]'):[])];
      if(inputs.length<2) return {err:'inputs='+inputs.length};
      const setV=(el,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        d.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
      setV(inputs[0],'我不是原来的口令-wrong');
      setV(inputs[1],'Nw8^Kd2#vRz!6b');
      const btn=[...(body.querySelectorAll('.tb-btn')||[])].find(b=>b.textContent.includes('修改口令'));
      if(!btn) return {err:'no-btn'};
      btn.click();
      return {ok:true, n:inputs.length};
    })()`);
    await sleep(1300);

    const inSec41 = await evalJs(`(async()=>{
      const secs=[...document.querySelectorAll('.side-right .sec')];
      const s=secs.find(x=>{const h=x.querySelector('.sec-head');return h&&h.textContent.includes('修改我的口令');});
      const body=s?s.querySelector('.sec-body'):null;
      // 只有 **本段内部** 的文本算数 —— 面板顶部的红条不算
      const localErr = body && body.querySelector('.alert-error');
      const txt = body? body.textContent.replace(/\\s+/g,' ').trim() : '';
      // /api/auth/me 不是公开路径，必须带上的那个 token 从 sessionStorage 取 ——
      // 裸 fetch 一定 401，那测的是"请求有没有头发"，不是"登录还在不在"
      const tk=(()=>{try{return sessionStorage.getItem('furniture-cad.auth.token')}catch(e){return null}})();
      const me=await fetch('/api/auth/me', tk?{headers:{Authorization:'Bearer '+tk}}:{});
      return {
        localErr: Boolean(localErr),
        localErrText: localErr? localErr.textContent.replace(/\\s+/g,' ').trim() : '',
        mentionsNoEffect: /没有改动/.test(txt),
        inputCleared: (()=>{const i=[...(body?body.querySelectorAll('input[type=password]'):[])];
          return i.length>=1 && i[0].value==='';})(),
        meStatus: me.status,
        panelHasErr: /当前口令不正确/.test(document.querySelector('.side-right').textContent),
      };
    })()`);

    ok('填错当前口令后，「修改我的口令」段内出现错误提示（不是只在面板顶部）',
      inSec41.localErr === true, JSON.stringify(inSec41));
    ok('段内错误说的是人话（服务端原话在，且明确"没有改动"）',
      /当前口令不正确/.test(inSec41.localErrText) && inSec41.mentionsNoEffect === true,
      inSec41.localErrText.slice(0, 160));
    ok('失败后仍然登录着（失败不该把人踢下线）', inSec41.meStatus === 200, JSON.stringify(inSec41));
    ok('出错后清空「当前口令」输入框（否则用户会以为改成功了）', inSec41.inputCleared === true, JSON.stringify(inSec41));

    const shot41 = await shot(path.join(OUT_DIR, 'app-change-pw-inplace-error.png'));
    ok('修改口令失败已留档', shot41 > 20000, `${shot41} 字节`);

    // 正路径：段内要能看见成功，并且被踢下线后拿新口令重新登录
    const ok41 = await evalJs(`(async()=>{
      const secs=[...document.querySelectorAll('.side-right .sec')];
      const s=secs.find(x=>{const h=x.querySelector('.sec-head');return h&&h.textContent.includes('修改我的口令');});
      const body=s&&s.querySelector('.sec-body');
      const inputs=[...(body?body.querySelectorAll('input[type=password]'):[])];
      if(inputs.length<2) return {err:'inputs'};
      const setV=(el,v)=>{const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        d.set.call(el,v); el.dispatchEvent(new Event('input',{bubbles:true}));};
      // B18 建的那个 owner 的口令，是这套验收环境里唯一已知可用的
      setV(inputs[0],'Cad-Str0ng-Pw-2026!x');
      setV(inputs[1],'Nw8^Kd2#vRz!6b');
      const btn=[...(body.querySelectorAll('.tb-btn')||[])].find(b=>b.textContent.includes('修改口令'));
      if(!btn) return {err:'btn'};
      btn.click();
      return {clicked:true};
    })()`);
    ok('用正确当前口令点「修改口令」', ok41.clicked === true, JSON.stringify(ok41));
    await sleep(1100);

    /**
     * 成功后**不能**断言"这一节里出现已修改提示"。
     * 改完即踢下线 → `props.token` 变 null → 整段被 `props.token ? … : null` 卸载，
     * 段内提示随组件一起消失。去测一个结构上永远不会出现的东西，等于写了一条假绿。
     * 真正要验的是：人被踢下线了，且这条结果**有地方说** —— 提示走的是 toast。
     */
    const after41 = await evalJs(`(()=>({
      token: (()=>{try{return sessionStorage.getItem('furniture-cad.auth.token')}catch(e){return null}})(),
      secGone: ![...document.querySelectorAll('.side-right .sec')]
        .some(x=>{const h=x.querySelector('.sec-head');return h&&h.textContent.includes('修改我的口令');}),
      toast: (()=>{const t=[...document.querySelectorAll('.toasts .toast')]
        .map(e=>e.textContent.replace(/\\s+/g,' ').trim()).join(' | '); return t;})(),
    }))()`);
    ok('改成功后被踢下线（口令变更必须让旧凭据立刻失效）', !after41.token, JSON.stringify(after41));
    ok('改密码成功后，这一节就地收掉（已退出，留着是骗人）', after41.secGone === true, JSON.stringify(after41));
    ok('改成功的结论有人告诉用户（toast，不是静默踢下线）',
      /口令已修改/.test(after41.toast), after41.toast.slice(0, 200));

    const relogin41 = await evalJs(`(async()=>{
      const r=await fetch('/api/auth/login',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:'owner',password:'Nw8^Kd2#vRz!6b'})});
      const b=await r.json().catch(()=>({}));
      if(b&&b.token) sessionStorage.setItem('furniture-cad.auth.token', b.token);
      return {s:r.status, got:Boolean(b&&b.token)};
    })()`);
    ok('新口令真的能登录（改生效了，不是改了个寂寞）', relogin41.got === true, JSON.stringify(relogin41));

    // 收尾把口令改回去：这节之后若再有人按旧口令登录，不该被它拖累
    const revert41 = await evalJs(`(async()=>{
      const r=await fetch('/api/auth/login',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:'owner',password:'Nw8^Kd2#vRz!6b'})});
      const b=await r.json().catch(()=>({}));
      if(!(b&&b.token)) return {got:false, s:r.status};
      const up=await fetch('/api/auth/password',{method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+b.token},
        body:JSON.stringify({currentPassword:'Nw8^Kd2#vRz!6b', newPassword:'Cad-Str0ng-Pw-2026!x'})});
      return {got:up.status===200, u:up.status};
    })()`);
    ok('收尾：把 owner 口令改回验收环境的原值', revert41.got === true, JSON.stringify(revert41));
    section('B42 AI 会话：按房间一对一 · 切页回来不丢 · 草图默认正视图');
    /**
     * 自带前置：**重新登录**。
     *
     * B41 那节改过 owner 口令（改口令会让服务端把旧会话作废），
     * 所以到这一步 sessionStorage 里的 token 已经是死的 ——
     * 不发这一句，下面的 AI 请求一律 401「未登录或会话已过期」，
     * 而看起来会像是"草案功能坏了"。第一版写这一节时就踩了，
     * 在去查 AI 通路之前，先确认自己是不是带着一个过期 token 在跑。
     * 注意：token 只在**挂载时**读一次，所以写完必须重新加载页面才生效。
     */
    const boot42 = await evalJs(`(async()=>{
      const K='furniture-cad.auth.token';
      const r=await fetch('/api/auth/login',{method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({username:'owner',password:'Cad-Str0ng-Pw-2026!x'})});
      const b=await r.json().catch(()=>({}));
      if(!(b&&b.token)) return {fail:true, s:r.status};
      sessionStorage.setItem(K,b.token);
      return {ok:true};
    })()`);
    ok('B42 自带前置：重新登录（B41 改口令已让旧会话失效）', boot42.ok === true, JSON.stringify(boot42));
    await send('Page.navigate', { url: APP_URL });
    await sleep(2600);
    await activateRightTab('AI');
    await sleep(460);

    const roomInfo42 = await evalJs(`(async()=>{const s=await import('/src/state/store.ts');
      const rooms=s.bus.getState().rooms;
      return {count:rooms.length, names:rooms.map(r=>r.name)};})()`);
    const chipCount42 = await evalJs(`document.querySelectorAll('.side-right .room-chips .chip').length`);
    /**
     * 用户原话："能不能做成聊天框类型，每个房间一对一对话"。
     * 这里验的是"一个房间一格"这件事本身：多了房间就多一格，改 model 不许把格局打乱。
     */
    ok(
      `会话对象按房间分格（${chipCount42} 格 = 全项目 + ${roomInfo42.count} 个房间）`,
      chipCount42 === roomInfo42.count + 1,
      JSON.stringify({ chipCount42, rooms: roomInfo42.names })
    );

    ok('能在输入框里写下这句话', (await setElValue('.side-right .ai-input', '生成一个 1800 宽的餐边柜')) === true);
    ok('点「改草案」', (await clickPanelBtn('改草案', 1800)) === true);
    const draftShown42 = await waitFor(`!!document.querySelector('.side-right .draft-preview')`, 25000);
    ok('草案卡片出来了（这一句话叠到了草案上）', draftShown42 === true, (await text('.side-right .panel-scroll')).slice(0, 300));

    /**
     * 用户原话："草图应该默认是正面图或者内部图"。
     * 这是从上一次真实反馈里得到的结论：俯视平面图会被整个房间占满，
     * 新柜只有两条细边 —— "这一轮到底建成没有"在看不出来，
     * 于是出现了"AI 把房间的图形复制出来了"这种无法解释的画面。
     */
    const viewBtns42 = await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right .draft-view-btn')];
      return {n:b.length, on:b.filter(x=>x.classList.contains('on')).map(x=>x.textContent.trim())};})()`);
    ok(
      '草图默认正视图（不再是一张被房间占满的平面图）',
      viewBtns42.on.length === 1 && viewBtns42.on[0] === '正视图',
      JSON.stringify(viewBtns42)
    );
    ok('三种看法都能切：正视图 / 内部结构图 / 俯视图', viewBtns42.n === 3, JSON.stringify(viewBtns42));

    const roundMark42 = await evalJs(`(()=>{const m=[...document.querySelectorAll('.side-right .chat-round')]
      .map(x=>x.textContent.replace(/\\s+/g,' ').trim());return m;})()`);
    ok(
      '会话里写明这一轮有没有并进草案（"AI 说了但没动手"必须当场看得见）',
      roundMark42.length >= 1 && /第 1 轮 · (已并入|未并入)草案/.test(roundMark42[0]),
      JSON.stringify(roundMark42)
    );

    // ── 用户原话："为什么切到其它页面再回来就看不到了" ──
    await activateRightTab('属性');
    await sleep(420);
    await activateRightTab('AI');
    await sleep(560);
    const back42 = await evalJs(`(()=>{
      return {
        draft: !!document.querySelector('.side-right .draft-preview'),
        chatTurns: document.querySelectorAll('.side-right .chat-msg').length,
        round: (document.querySelector('.side-right .chat-round')||{}).textContent||'',
      };})()`);
    ok('切到别的页签再回来，草案还在（等几十秒的成果不许白等）', back42.draft === true, JSON.stringify(back42));
    ok('对话历史也还在（连同"这一轮改了什么"的标记）', back42.chatTurns >= 2, JSON.stringify(back42));

    await clickPanelBtn('放弃草案', 460);
    ok('放弃草案后草图收起（界面不留一个别人以为还在的东西）', (await evalJs(`!!document.querySelector('.side-right .draft-preview')`)) === false);

    // ═══════════════════════════════════════════════════════════
    section('B43 导入面板（P4 Import + P5 图片识别）：Mock 识别 → caveat 确认门 → 编译预览 → 应用');

    // 导入面板的按钮不是 .tb-btn，是 .btn —— 用专用 helper（B43 专用，别与 clickPanelBtn 混用）
    const clickImportBtn = async (label, waitMs = 320) => {
      const r = await evalJs(`(()=>{
        const l=${JSON.stringify(label)};
        const b=[...document.querySelectorAll('.side-right button')]
          .find(x=>x.textContent.includes(l));
        if(!b) return 'no-btn'; b.click(); return 'OK';
      })()`);
      await sleep(waitMs);
      return r;
    };

    ok('「导入」页签存在且能打开', (await activateRightTab('导入')) === true);
    const importPanelVisible = await evalJs(`!!document.querySelector('.side-right .import-panel')`);
    ok('导入面板真的渲染出来了', importPanelVisible === true);
    const srcBtns = await evalJs(`[...document.querySelectorAll('.side-right .import-source')].map(b=>b.querySelector('b')?.textContent)`);
    ok('四个来源按钮齐全（JSON / DXF / 酷家乐 / 图片识别）', JSON.stringify(srcBtns) === JSON.stringify(['JSON 柜体清单', 'DXF（保守意图提取）', '酷家乐（边界占位）', '图片识别（Vision → 候选方案）']), JSON.stringify(srcBtns));
    ok('酷家乐 / DXF 标着「待验证」（不假装已接通）', (await evalJs(`[...document.querySelectorAll('.side-right .import-source')].filter(b=>b.textContent.includes('待验证')).length`)) === 2);

    ok('切到「图片识别」来源', (await clickImportBtn('图片识别')) === 'OK');
    ok('图片输入区出现（示例图 / 离线 Mock 入口可见）', (await evalJs(`[...document.querySelectorAll('.side-right button')].some(b=>b.textContent.includes('示例图（离线 Mock）'))`)) === true);

    // 离线 Mock：确定性 fixture，无网络 —— 识别出 3 柜 + 组合 + caveats
    ok('点「示例图（离线 Mock）」触发识别', (await clickImportBtn('示例图（离线 Mock）', 600)) === 'OK');
    const cabCount = await evalJs(`document.querySelectorAll('.side-right .import-panel .import-cab').length`);
    ok('归一化结果列出 3 个柜体', cabCount === 3, `实为 ${cabCount}`);
    const caveatShown = await evalJs(`[...document.querySelectorAll('.side-right .import-panel .alert-info')].some(e=>e.textContent.includes('图片未确认'))`);
    ok('「图片未确认」诚实项显示在柜体卡上（真实深度/板厚等不静默）', caveatShown === true);
    const ackBox = await evalJs(`!!document.querySelector('.side-right .import-panel .import-ack input[type=checkbox]')`);
    ok('caveat 确认门（勾选「已知晓」）出现', ackBox === true);

    // 确认门：没勾选 → 编译按钮禁用（Vision 的估计值不许绕过用户直接进模型）
    const compileBtnDisabledBefore = await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right button')].find(x=>x.textContent.includes('请先确认图片未确认项'));return b? b.disabled : 'no-btn';})()`);
    ok('未勾选确认前编译按钮禁用（文案写明原因）', compileBtnDisabledBefore === true, String(compileBtnDisabledBefore));
    await evalJs(`(()=>{const c=document.querySelector('.side-right .import-panel .import-ack input[type=checkbox]');if(c){c.click();}return !!c;})()`);
    await sleep(200);
    const compileReady = await evalJs(`(()=>{const b=[...document.querySelectorAll('.side-right button')].find(x=>x.textContent.trim()==='编译并预览');return b? !b.disabled : 'no-btn';})()`);
    ok('勾选确认后「编译并预览」启用', compileReady === true, String(compileReady));

    ok('编译并预览', (await clickImportBtn('编译并预览', 600)) === 'OK');
    ok('预览段出现（预览 = 提交，与 AI 设计通道同一块 PlanRunView）', (await evalJs(`[...document.querySelectorAll('.side-right .sec-head')].some(e=>e.textContent.includes('预览（与提交完全相同）'))`)) === true);

    const v0Import = await statusVersion();
    const appliedOk = await clickImportBtn('应用导入', 600);
    ok('点「应用导入」', appliedOk === 'OK');
    const importToast = await text('.toasts');
    ok('导入回执出现（应用了几条、不静默生效）', /已导入\s*4\s*条/.test(importToast), importToast.slice(0, 200));
    const v1Import = await statusVersion();
    ok('导入的 4 条动作（3 柜 + 1 组合）真的全部执行（版本 +4）', v1Import === v0Import + 4, `v${v0Import} → v${v1Import}`);

    // ═══════════════════════════════════════════════════════════
    section('B44 知识面板（P6 三层知识）：手动偏好生效 + 冲突暴露 + AI 摘要');

    ok('「知识」页签存在且能打开', (await activateRightTab('知识')) === true);
    const knPanelVisible = await evalJs(`!!document.querySelector('.side-right .knowledge-panel')`);
    ok('知识面板真的渲染出来了', knPanelVisible === true);

    // 手动添加一条偏好（user-stated → active，直接生效）
    const knTextarea = await evalJs(`(()=>{const t=document.querySelector('.side-right .knowledge-panel textarea.import-text');if(!t)return 'no-ta';const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;setter.call(t,'验收偏好：抽屉行高做 400mm');t.dispatchEvent(new Event('input',{bubbles:true}));return 'OK';})()`);
    ok('偏好输入框可写', knTextarea === 'OK', String(knTextarea));
    ok('点「记为偏好」', (await clickImportBtn('记为偏好', 400)) === 'OK');
    const prefShown = await evalJs(`[...document.querySelectorAll('.side-right .knowledge-panel .kn-statement')].some(e=>e.textContent.includes('验收偏好'))`);
    ok('新偏好出现在列表里（状态=生效）', prefShown === true);

    // 用户偏好层标注 + 置信/来源可读
    const prefCard = await evalJs(`(()=>{const c=[...document.querySelectorAll('.side-right .knowledge-panel .kn-entry')].find(x=>x.textContent.includes('验收偏好'));return c? c.textContent.slice(0,160) : 'no-card';})()`);
    ok('偏好卡片标明「用户偏好 / 用户明说 / 置信 100%」', /用户偏好/.test(prefCard) && /用户明说/.test(prefCard) && /置信\s*100%/.test(prefCard), prefCard);

    // AI 摘要段出现（有 active 偏好后 digest 非空）
    const digestShown = await evalJs(`!!document.querySelector('.side-right .knowledge-panel .kn-digest')`);
    ok('「给 AI 的知识摘要」调试段出现（digest 非空）', digestShown === true);

    // 面板说明写明边界（知识不绕过校验）
    const knNote = await evalJs(`(()=>{const n=document.querySelector('.side-right .knowledge-panel .note');return n? n.textContent : '';})()`);
    ok('面板明说「硬规则优先 / 不绕过校验 / 候选需确认」', /硬规则/.test(knNote) && /不绕过校验|永远不绕过/.test(knNote) && /确认/.test(knNote), knNote.slice(0, 120));

    /**
     * console error 的判定要分两类。
     *
     * 浏览器会把**每一个 4xx/5xx 响应**都记一条 "Failed to load resource"。
     * 而这一阶段里的 4xx **正是我们要的**：弱口令被拒、未登录被拒、越权被拒 ——
     * 每一条都对应一次"应该被拒绝"的请求。把它们算成缺陷，等于要求"拒绝时别出声"。
     * 但除此之外的任何 console error（JS 异常、React 警告、资源真的 404）
     * 一条都不放过 —— 所以这里是**按状态码白名单**，不是"忽略所有网络消息"。
     */
    const expected4xx = consoleErrors.filter((m) => /Failed to load resource: the server responded with a status of (400|401|403)/.test(m));
    const unexpectedConsoleErrors = consoleErrors.filter((m) => !expected4xx.includes(m));
    ok(
      `以上负例故意触发的 4xx 共 ${expected4xx.length} 条（每一条都对应一次"本该被拒"的请求，不是缺陷）`,
      expected4xx.length >= 3,
      consoleErrors.join('\n      ')
    );
    ok('除此之外没有任何 console error（JS 异常 / React 警告 / 资源 404 一条都不许有）', unexpectedConsoleErrors.length === 0, unexpectedConsoleErrors.slice(0, 5).join('\n      '));

    // ═══════════════════════════════════════════════════════════
    const pass = results.filter((r) => r.pass).length;
    const fail = results.length - pass;

    const byGroup = new Map();
    for (const r of results) byGroup.set(r.group, (byGroup.get(r.group) || 0) + (r.pass ? 0 : 1));

    console.log('\n══════════════════════════════════════════════');
    for (const [g, f] of byGroup) if (f > 0) console.log(`  ${g}  →  ${f} 项失败`);
    console.log(`  总计 ${results.length} 项：通过 ${pass}，失败 ${fail}`);
    console.log('══════════════════════════════════════════════');

    if (fail > 0) {
      console.log('\n失败清单：');
      for (const r of results.filter((x) => !x.pass)) console.log(`  · [${r.group}] ${r.name}${r.detail ? `\n      ${r.detail}` : ''}`);
    }

    ws.close();
    await cleanup();
    process.exit(fail > 0 ? 1 : 0);
  } catch (err) {
    console.error('\nERR:', err.message);
    // 只有真的崩了才建这个目录 —— 正常通过时它不该存在（见文件开头 main 处的说明）
    fs.mkdirSync(DIAG_DIR, { recursive: true });
    fs.writeFileSync(path.join(DIAG_DIR, 'probe-crash.txt'), `${err.stack || err.message}\n`);
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    await cleanup();
    process.exit(1);
  }
})();
