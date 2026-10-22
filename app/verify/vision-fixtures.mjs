#!/usr/bin/env node
/**
 * 视觉 ground truth 图集（2026-10-22）
 *
 * ── 它解决什么 ──
 *   现在能测的只有「demo-out 里那一张图」⇒ 任何结论都是**单样本**。
 *   而且那组图是**多视图拼版**（俯视+正��+内部），
 *   模型很容易把**同一只柜的多个视图**当成多个柜体
 *   （实测 kimi-k3 就把一只衣柜认成 C1+C2）。
 *
 *   ⇒ 这里用**项目自己的渲染器**造图：
 *     · 柜体的结构**完全已知**（就是渲染它的那份 JSON）
 *     · 单视图出图 ⇒ 没有「几个视图算几个柜」的歧义
 *     · 可以造 N 个不同结构的柜 ⇒ 结论才有统计意义
 *
 * ── 怎么用 ──
 *   node verify/vision-fixtures.mjs      （生成图集）
 *   之后 npm run eval:vision 用它评测
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildFurnitureSheet } from '../src/export/furnitureSheet.ts';
import { primsToSvg } from '../src/export/roomBook.ts';
import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
import { launchChrome, navigate } from './cdp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const OUT = join(appDir, 'verify', 'fixtures');
const rules = JSON.parse(readFileSync(join(appDir, 'src/core/ruleset/factory-default.json'), 'utf8'));

/**
 * 造图用例。**结构就是答案** —— 渲染它的那份数据就是 ground truth。
 *
 * 每个用例刻意覆盖一种「模型容易搞错」的结构：
 *   · 单格 vs 多格（计数）
 *   · 挂衣 vs 层板 vs 抽屉（分区类型）
 *   · 有无门（门数）
 *   · 上下分层（rows）
 */
const CASES = [
  {
    id: 'single-hanging',
    name: '单格挂衣柜',
    cabinet: { width: 900, height: 2400, depth: 600, cabinetType: 'tall' },
    units: [
      { kind: 'hanging', requestedWidth: 900, nickname: '挂衣区', rod: { count: 1, heightFromBottom: 1800 } },
    ],
    truth: { cabinets: 1, width: 900, height: 2400, depth: 600, units: 1, unitKinds: ['hanging'], doors: 0 },
  },
  {
    id: 'two-shelves',
    name: '两格层板柜',
    cabinet: { width: 1200, height: 2000, depth: 600, cabinetType: 'tall' },
    units: [
      { kind: 'shelves', requestedWidth: 600, nickname: '层板A', shelves: { count: 3, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 } },
      { kind: 'shelves', requestedWidth: 600, nickname: '层板B', shelves: { count: 3, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 } },
    ],
    truth: { cabinets: 1, width: 1200, height: 2000, depth: 600, units: 2, unitKinds: ['shelves', 'shelves'], doors: 0 },
  },
  {
    id: 'hanging-plus-shelves',
    name: '挂衣+层板两格',
    cabinet: { width: 1800, height: 2400, depth: 600, cabinetType: 'tall' },
    units: [
      { kind: 'hanging', requestedWidth: 900, nickname: '挂衣区', rod: { count: 1, heightFromBottom: 1800 } },
      { kind: 'shelves', requestedWidth: 900, nickname: '层板格', shelves: { count: 3, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 } },
    ],
    truth: { cabinets: 1, width: 1800, height: 2400, depth: 600, units: 2, unitKinds: ['hanging', 'shelves'], doors: 0 },
  },
  {
    id: 'drawer-bank',
    name: '三抽柜',
    cabinet: { width: 800, height: 800, depth: 600, cabinetType: 'base' },
    units: [
      { kind: 'drawerBank', requestedWidth: 800, nickname: '抽屉区', drawers: { count: 3, gap: 0, runner: 'M_RUNNER', runnerLength: 450, boxHeightDeduct: 0, style: 'plain' } },
    ],
    truth: { cabinets: 1, width: 800, height: 800, depth: 600, units: 1, unitKinds: ['drawerBank'], doors: 0 },
  },
  {
    id: 'two-doors',
    name: '两门柜',
    cabinet: { width: 1000, height: 2200, depth: 600, cabinetType: 'tall', doors: { count: 2, gapMid: 0, gapOuter: 0, material: 'M_MELAMINE', doorThickness: 18 } },
    units: [
      { kind: 'hanging', requestedWidth: 1000, nickname: '挂衣区', rod: { count: 1, heightFromBottom: 1800 } },
    ],
    truth: { cabinets: 1, width: 1000, height: 2200, depth: 600, units: 1, unitKinds: ['hanging'], doors: 2 },
  },
];
/**
 * 渲染一个用例 ⇒ 整图 + 单视图裁剪图。
 *
 * ★ 为什么要两种图 ──
 *   整图 = 俯视 + 正视 + 内部 拼在一张（多视图歧义）。
 *   单图 = 只截「外观正面图」那一块（**只有一只柜、一种视角**）。
 *   ⇒ 拿同一只柜的两种图去跑同一个模型，
 *     就能**量出「多视图拼版」到底 hurts 多少**。
 *
 * @param {object} cdp
 * @param {object} cs 用例
 * @returns {Promise<{full: Buffer, front: Buffer}>}
 */
async function renderCase(cdp, cs) {
  const project = emptyProject({ name: 'fx', ruleSetId: rules.id, id: 'fx' });
  const room = rectRoom({ name: '主卧', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  project.rooms.push(room);
  project.cabinets.push(createCabinet({
    id: 'c1', name: cs.name, roomId: room.id, x: 100, y: 60, rotation: 0, rules,
    params: {
      width: cs.cabinet.width, height: cs.cabinet.height, depth: cs.cabinet.depth,
      bodyLift: 80, cabinetType: cs.cabinet.cabinetType, mountHeight: 0,
      ...(cs.cabinet.doors ? { doors: cs.cabinet.doors } : {}),
    },
    units: cs.units.map((u, i) => ({ ...u, id: 'u' + (i + 1) })),
  }));
  const sheet = buildFurnitureSheet(room, project.cabinets, project, rules, { furnitureName: cs.name });
  const svg = primsToSvg(sheet.prims, 'dwg-sheet');
  // ★ 把 SVG **包进 HTML** —— 独立 SVG 文件是**文档根**，
  //   改它的 viewBox 不会触发重排（裁剪会静默失效）。
  //   包进 HTML 后 svg 就是普通元素，viewBox 一改就重新渲染。
  const svgPath = join(OUT, cs.id + '.svg');
  writeFileSync(svgPath, svg, 'utf8');
  const htmlPath = join(OUT, cs.id + '.html');
  writeFileSync(htmlPath,
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;background:#fff}svg{width:100vw;height:100vh;display:block}</style>' +
    '</head><body>' + svg + '</body></html>',
    'utf8');
  const url = 'file:///' + htmlPath.replace(/\\/g, '/');
  // 整图
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
  await navigate(cdp, url);
  const fullRes = await cdp.send('Page.captureScreenshot', { format: 'png' });
  const full = Buffer.from(fullRes.data, 'base64');
  // ★ 用**改 viewBox**来裁剪 —— 矢量图会按新视口**重新渲染**（不是拉伸变形）。
  //   位置来自 sheet.views（图纸自己的计算），不会和图纸对不上。
  //   注意：primsToSvg 内部有 scale(1,-1)，所以 viewBox 的 y 要取负。
  // ★ 裁**内部结构图**（不是外观正面图）——
  //   外观图只有轮廓+门，看不出里面分了几格、是什么分区；
  //   识图要的是「里面有什么」。
  const f = sheet.views.internal;
  const pad = 600;
  // 直接把四个数算好再拼进去 —— 避免 JS 运算符优先级坑。
  const nvx = f.x - pad;
  const nvy = -(f.y + f.h + pad);
  const nvw = f.w + pad * 2;
  const nvh = f.h + pad * 2;
  const expr = "(() => { const s = document.querySelector('svg');" +
    "s.setAttribute('viewBox', '" + nvx + ' ' + nvy + ' ' + nvw + ' ' + nvh + "');" +
    "return s.getAttribute('viewBox'); })()";
  const vbRes = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (vbRes.exceptionDetails) throw new Error('改 viewBox 失败：' + JSON.stringify(vbRes.exceptionDetails).slice(0, 200));
  if (!vbRes.result?.value) throw new Error('改 viewBox 没拿到值');
  await new Promise((r) => setTimeout(r, 400));
  // ★ 出**两个尺寸**的单视图 ——
  //   800 是「够看清」的尺寸（token 1785 → 510，省 71%），
  //   500 是「最省」的尺寸（token → 261，省 85%）。
  //   评测卡会量两档，看省 token 换不换得来准确率。
  const crops = {};
  for (const [tag, w, h] of [['800', 800, 550], ['500', 500, 344]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await navigate(cdp, url);
    const e2 = "(() => { const s = document.querySelector('svg'); s.setAttribute('viewBox', '" + nvx + ' ' + nvy + ' ' + nvw + ' ' + nvh + "'); return 1; })()";
    await cdp.send('Runtime.evaluate', { expression: e2, returnByValue: true });
    await new Promise((r) => setTimeout(r, 350));
    const s2 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    crops[tag] = Buffer.from(s2.data, 'base64');
  }
  return { full, crops };
}

console.log('视觉 ground truth 图集');
console.log('='.repeat(64));
mkdirSync(OUT, { recursive: true });

const { cdp, kill } = await launchChrome(9320);
try {
  for (const cs of CASES) {
    const { full, crops } = await renderCase(cdp, cs);
    writeFileSync(join(OUT, cs.id + '-full.png'), full);
    for (const [tag, buf] of Object.entries(crops)) {
      writeFileSync(join(OUT, cs.id + '-crop' + tag + '.png'), buf);
    }
    const sizes = Object.entries(crops).map(([t, b]) => t + '=' + (b.length/1024).toFixed(0) + 'KB').join(' ');
    console.log('  ' + cs.id.padEnd(24) + ' 整图 ' + (full.length/1024).toFixed(0) + 'KB   ' + sizes);
  }
  // ground truth 一起落盘（评测卡读它）
  writeFileSync(join(OUT, 'truth.json'), JSON.stringify(
    CASES.map((c) => ({ id: c.id, name: c.name, truth: c.truth })), null, 2), 'utf8');
  console.log('  truth.json 已写（' + CASES.length + ' 条）');
} finally {
  kill();
}
console.log('='.repeat(64));
