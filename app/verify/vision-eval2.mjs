#!/usr/bin/env node
/**
 * 视觉评测卡 v2：整图 vs 单视图（2026-10-22）
 *
 * ── 它回答什么 ──
 *   「三段式视觉识别」到底值不值得做？
 *   做法：同一批 ground truth 图，**同一模型**，只换图（整图 vs 裁剪后的单视图），
 *   比准确率。这是 A/B，不是「感觉更准」。
 *
 * ── 为什么要自己造图 ──
 *   现成的 demo 图只有 1 张、且是多视图拼版 ⇒
 *   任何结论都是单样本，而且模型容易把「同一只柜的多个视图」当成多个柜体
 *   （实测 kimi-k3 把一只衣柜认成 C1+C2）。
 *   verify/fixtures/ 里的图是**用项目渲染器渲染已知柜体**造的：
 *   结构就是渲染它的那份数据 ⇒ ground truth 精确无误。
 *
 * ── 跑法 ──
 *   node verify/vision-eval2.mjs            （全部用例、默认模型）
 *   VISION_MODEL=xxx node verify/vision-eval2.mjs
 *   VISION_K=3 node verify/vision-eval2.mjs   （每例跑 3 次看稳定性）
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const FIX = join(here, 'fixtures');

if (!existsSync(join(FIX, 'truth.json'))) {
  console.log('没有 ground truth 图集 —— 先跑 node verify/vision-fixtures.mjs');
  process.exit(1);
}
const TRUTH = JSON.parse(readFileSync(join(FIX, 'truth.json'), 'utf8'));

const env = {};
for (const line of readFileSync(join(appDir, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const BASE = (env.AI_BASE_URL || '').replace(/\/+$/, '');
const KEY = env.AI_API_KEY || '';
const MODEL = process.env.VISION_MODEL || env.AI_VISION_MODEL || env.AI_MODEL;
const K = Math.max(1, Number(process.env.VISION_K ?? 1) || 1);

/**
 * 识别一张图。问的是**图纸上标注了什么**（能读标注 = 真在看图）。
 *
 * @param {string} imgPath
 * @returns {Promise<{ok: boolean, width?: number, units?: number, kinds?: string[], raw?: string, pt?: number}>}
 */
async function recognize(imgPath, attempt = 0) {
  const dataUrl = 'data:image/png;base64,' + readFileSync(imgPath).toString('base64');
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      temperature: 0.1,
      messages: [{ role: 'user', content: [
        { type: 'text', text: [
          '这是一张柜体图纸。请只输出一个 JSON 对象：',
          '{"宽":数字,"高":数字,"深":数字,"分区数":数字,"分区类型":["shelves"|"drawerBank"|"hanging"|"open"]}',
          '',
          '规则：',
          '· 宽/高/深 读图上**标注的毫米数**（不是量出来的）。图上没标就填 0。',
          '· **分区数 = 柜体内部被竖向分隔成的格子数**（左右并排的仓格）。',
          '  注意：不要把尺寸线、标注文字、图框、门缝算成分区。',
          '· 分区类型按格子里的东西填：放层板的=shelves，抽屉=drawerBank，挂衣杆=hanging，空的=open。',
          '· 只输出 JSON，不要任何其他文字。',
        ].join('\n') },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] }],
    }),
    signal: AbortSignal.timeout(180000),
  });
  const t = await r.text();
  if (!r.ok) {
    // ★ 429/504 是**限流**，退避后重试 —— 连续打十几次必然触发。
    if ((r.status === 429 || r.status === 504) && attempt < 4) {
      await new Promise((x) => setTimeout(x, 4000 * (attempt + 1)));
      return recognize(imgPath, attempt + 1);
    }
    return { ok: false, raw: 'HTTP ' + r.status + ' ' + t.slice(0, 120) };
  }
  const j = JSON.parse(t);
  const content = String(j?.choices?.[0]?.message?.content ?? '').trim();
  const pt = Number(j?.usage?.prompt_tokens ?? 0);
  const m = /\{[\s\S]*\}/.exec(content);
  if (!m) return { ok: false, raw: content.slice(0, 200), pt };
  try {
    const v = JSON.parse(m[0]);
    return {
      ok: true,
      width: Number(v['宽'] ?? v.width ?? 0),
      height: Number(v['高'] ?? v.height ?? 0),
      depth: Number(v['深'] ?? v.depth ?? 0),
      units: Number(v['分区数'] ?? v.units ?? 0),
      kinds: Array.isArray(v['分区类型'] ?? v.kinds) ? (v['分区类型'] ?? v.kinds) : [],
      raw: content.slice(0, 160),
      pt,
    };
  } catch {
    return { ok: false, raw: content.slice(0, 200), pt };
  }
}
/**
 * 判分：逐项比对 ground truth。
 *
 * @param {object} got 识别结果
 * @param {object} want truth
 * @returns {{score: number, total: number, detail: string[]}}
 */
function score(got, want) {
  const detail = [];
  let hit = 0;
  let total = 0;
  const check = (name, g, w) => {
    total += 1;
    if (g === w) { hit += 1; detail.push('v ' + name + ' ' + g); }
    else detail.push('x ' + name + ' 期望 ' + w + ' 实得 ' + g);
  };
  check('宽', got.width, want.width);
  check('高', got.height, want.height);
  check('深', got.depth, want.depth);
  check('分区数', got.units, want.units);
  // 分区类型（排序后比）
  total += 1;
  const gk = [...(got.kinds ?? [])].sort().join(',');
  const wk = [...(want.unitKinds ?? [])].sort().join(',');
  if (gk === wk) { hit += 1; detail.push('v 分区类型 ' + gk); }
  else detail.push('x 分区类型 期望 ' + wk + ' 实得 ' + gk);
  return { score: hit, total, detail };
}

console.log('视觉评测卡 v2 —— 整图 vs 单视图');
console.log('模型: ' + MODEL + '   每例跑 ' + K + ' 次   用例: ' + TRUTH.length);
console.log('='.repeat(64));

const arms = [
  { name: '整图(多视图)', suffix: '-full.png' },
  { name: '单视图800', suffix: '-crop800.png' },
  { name: '单视图500', suffix: '-crop500.png' },
];

const summary = [];
for (const arm of arms) {
  let scoreSum = 0;
  let totalSum = 0;
  let ptSum = 0;
  let ptN = 0;
  let okCount = 0;
  console.log('\n【' + arm.name + '】');
  for (const cs of TRUTH) {
    const imgPath = join(FIX, cs.id + arm.suffix);
    if (!existsSync(imgPath)) { console.log('  ' + cs.id + ' 缺图，跳过'); continue; }
    for (let i = 0; i < K; i++) {
      const got = await recognize(imgPath);
      if (!got.ok) {
        console.log('  ' + cs.id.padEnd(24) + ' 识别失败：' + String(got.raw).slice(0, 60));
        totalSum += 5;
        continue;
      }
      okCount += 1;
      if (got.pt) { ptSum += got.pt; ptN += 1; }
      const s = score(got, cs.truth);
      scoreSum += s.score;
      totalSum += s.total;
      if (i === 0) {
        console.log('  ' + cs.id.padEnd(24) + ' ' + s.score + '/' + s.total + '  pt=' + got.pt
          + '  ' + s.detail.filter((d) => d[0] === 'x').join(' | '));
      }
    }
  }
  const rate = totalSum ? Math.round((scoreSum / totalSum) * 100) : 0;
  const avgPt = ptN ? Math.round(ptSum / ptN) : 0;
  summary.push({ arm: arm.name, rate, avgPt, okCount, scoreSum, totalSum });
  console.log('  ⇒ 准确率 ' + rate + '%   平均 prompt_tokens ' + avgPt);
}

console.log('\n' + '='.repeat(64));
console.log('★ 结论（整图 vs 单视图）');
console.log('  ' + '臂'.padEnd(12) + '准确率    平均pt');
for (const s of summary) {
  console.log('  ' + s.arm.padEnd(12) + String(s.rate + '%').padEnd(9) + String(s.avgPt));
}
const a = summary[0], b = summary[1];
if (a && b) {
  const dAcc = b.rate - a.rate;
  const dPt = b.avgPt && a.avgPt ? Math.round((1 - b.avgPt / a.avgPt) * 100) : 0;
  console.log('');
  console.log('  单视图 vs 整图：准确率 ' + (dAcc >= 0 ? '+' : '') + dAcc + ' 个百分点，token ' + (dPt >= 0 ? '省 ' : '多 ') + Math.abs(dPt) + '%');
}
console.log('='.repeat(64));
