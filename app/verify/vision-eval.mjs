#!/usr/bin/env node
/**
 * 视觉识别评测卡（2026-10-22）
 *
 *  ── 测什么 ──
 *    真模型 + 真图 ⇒ 识别出来的柜体/尺寸/分区对不对。
 *    现有的 verify:vision-acceptance.ts **只用 Mock provider**，
 *    测的是映射逻辑（识别结果 → 语义模型），**不测模型准不准**。
 *
 *  ── ground truth 从哪来 ──
 *    demo-out/图纸册.html 里那张图同源，柜体清单写明了：
 *      主卧衣柜 2400×2400×600mm、正面·分区3、门1 288×2280、门2 287×2280
 *    图 = demo-out/png/sym-02c.png（同一批渲染）。
 *
 *  ── 怎么跑 ──
 *    先起服务（node server/server.mjs），然后：
 *      node verify/vision-eval.mjs
 *    NLU_K 控制重复次数（默认 1 —— 视觉调用 8-40 秒，重复很贵）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const repoDir = join(appDir, '..');

const PORT = Number(process.env.EVAL_PORT ?? 8977);
const BASE = 'http://127.0.0.1:' + PORT;
const K = Math.max(1, Number(process.env.NLU_K ?? 1) || 1);

const IMG = join(repoDir, 'demo-out', 'png', 'sym-02c.png');

/**
 * ground truth：来自 demo-out/图纸册.html 的柜体清单（同一批渲染）。
 *
 * 宽高深是**图上标着的**（source=annotation），分区数是清单里写的「分区3」。
 * 门宽 288/287 —— 两条门缝宽度不同，模型给的是总宽不是门宽，这项不判。
 */
const TRUTH = {
  cabinets: 1,
  width: 2400,
  height: 2400,
  depth: 600,
  unitCount: 3,
};
if (!existsSync(IMG)) {
  console.log('找不到 ' + IMG + ' —— 跳过');
  process.exit(0);
}

async function vision(hint) {
  const dataUrl = 'data:image/png;base64,' + readFileSync(IMG).toString('base64');
  const r = await fetch(BASE + '/api/ai/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl, mode: 'render', hint }),
  });
  const j = await r.json();
  return j;
}

function check(res) {
  const out = { pass: [], fail: [] };
  if (!res.ok) {
    out.fail.push('接口没成功：' + (res.error ?? '?'));
    return out;
  }
  const cabs = res.result?.cabinets ?? [];
  if (cabs.length === TRUTH.cabinets) out.pass.push('柜体数 ' + cabs.length);
  else out.fail.push('柜体数：期望 ' + TRUTH.cabinets + '，实际 ' + cabs.length);
  const c = cabs[0];
  if (!c) return out;
  for (const [k, want] of [['width', TRUTH.width], ['height', TRUTH.height], ['depth', TRUTH.depth]]) {
    const got = c[k]?.value;
    if (got === want) out.pass.push(k + ' = ' + got);
    else out.fail.push(k + '：期望 ' + want + '，实际 ' + got);
  }
  const units = c.units ?? [];
  if (units.length === TRUTH.unitCount) out.pass.push('分区数 ' + units.length);
  else out.fail.push('分区数：期望 ' + TRUTH.unitCount + '，实际 ' + units.length);
  if (res.sawNoImage) out.fail.push('模型没看图（image_tokens = 0）');
  return out;
}

console.log('视觉识别评测卡');
console.log('图: demo-out/png/sym-02c.png   ground truth: ' + JSON.stringify(TRUTH));
console.log('='.repeat(64));

let allPass = 0;
let total = 0;
const failures = [];
for (let i = 0; i < K; i++) {
  const t0 = Date.now();
  let res;
  try {
    res = await vision('请识别这张柜体图。');
  } catch (e) {
    console.log('  #' + (i + 1) + ' 请求失败：' + e.message);
    console.log('  （服务没起？先 node server/server.mjs）');
    process.exit(1);
  }
  const r = check(res);
  total += r.pass.length + r.fail.length;
  allPass += r.pass.length;
  console.log('  #' + (i + 1) + '  ' + (Date.now() - t0) + 'ms  通过 ' + r.pass.length + '/' + (r.pass.length + r.fail.length));
  for (const f of r.fail) { console.log('      x ' + f); failures.push(f); }
}

console.log('='.repeat(64));
console.log('通过率：' + allPass + '/' + total + ' = ' + (total ? Math.round(allPass / total * 100) : 0) + '%');
if (failures.length) {
  console.log('');
  console.log('失败明细：');
  for (const f of [...new Set(failures)]) console.log('  · ' + f);
}
