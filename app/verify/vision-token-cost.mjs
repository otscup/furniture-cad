#!/usr/bin/env node
/**
 * 视觉 token 成本卡（2026-10-22）
 *
 * ── 为什么单独一张卡 ──
 *   准确率要打十几次模型调用 ⇒ 必被限流（429/504）⇒ 结果不可靠。
 *   而 **token 成本**只需要每臂 1 次调用（短输出），稳得多。
 *   ⇒ 成本与准确率**分开量**，别让限流把两件事一起毁掉。
 *
 * 跑法：node verify/vision-token-cost.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const FIX = join(here, 'fixtures');
if (!existsSync(join(FIX, 'truth.json'))) { console.log('先跑 node verify/vision-fixtures.mjs'); process.exit(1); }
const TRUTH = JSON.parse(readFileSync(join(FIX, 'truth.json'), 'utf8'));

const env = {};
for (const line of readFileSync(join(appDir, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const BASE = (env.AI_BASE_URL || '').replace(/\/+$/, '');
const KEY = env.AI_API_KEY || '';
const MODEL = process.env.VISION_MODEL || env.AI_VISION_MODEL || env.AI_MODEL;

async function probe(imgPath) {
  const dataUrl = 'data:image/png;base64,' + readFileSync(imgPath).toString('base64');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({ model: MODEL, max_tokens: 32, messages: [{ role: 'user', content: [
        { type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: dataUrl } }] }] }),
      signal: AbortSignal.timeout(120000),
    });
    const t = await r.text();
    if (r.ok) {
      const j = JSON.parse(t);
      return { pt: Number(j?.usage?.prompt_tokens ?? 0), cc: Number(j?.usage?.completion_tokens ?? 0) };
    }
    if (r.status !== 429 && r.status !== 504) return { err: 'HTTP ' + r.status };
    await new Promise((x) => setTimeout(x, 4000 * (attempt + 1)));
  }
  return { err: '限流（重试 5 次仍失败）' };
}

const arms = [
  { name: '整图(多视图拼版)', suffix: '-full.png' },
  { name: '单视图 800', suffix: '-crop800.png' },
  { name: '单视图 500', suffix: '-crop500.png' },
];

console.log('视觉 token 成本卡');
console.log('模型: ' + MODEL);
console.log('='.repeat(64));

const rows = [];
for (const arm of arms) {
  const pts = [];
  for (const cs of TRUTH) {
    const p = join(FIX, cs.id + arm.suffix);
    if (!existsSync(p)) continue;
    const r = await probe(p);
    if (r.pt) pts.push(r.pt);
    process.stdout.write('.');
  }
  const avg = pts.length ? Math.round(pts.reduce((a, b) => a + b, 0) / pts.length) : 0;
  rows.push({ name: arm.name, avg, n: pts.length });
  console.log('\n  ' + arm.name.padEnd(22) + ' 平均 prompt_tokens = ' + avg + '  (n=' + pts.length + ')');
}

const base = rows[0]?.avg ?? 0;
console.log('\n' + '='.repeat(64));
console.log('  ' + '臂'.padEnd(24) + 'token    相对整图');
for (const r of rows) {
  const pct = base ? Math.round((1 - r.avg / base) * 100) : 0;
  console.log('  ' + r.name.padEnd(24) + String(r.avg).padEnd(8) + (r === rows[0] ? '（基准）' : (pct >= 0 ? '省 ' + pct + '%' : '多 ' + Math.abs(pct) + '%')));
}
console.log('='.repeat(64));
