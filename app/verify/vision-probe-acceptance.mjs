#!/usr/bin/env node
/**
 * 视觉能力探测验收（2026-10-22）
 *
 * ── 它守的是什么 ──
 *   「视觉模型配错了」这个故障**看不出来**：接口 200、结果结构完整、
 *   连置信度都是 high —— 但模型其实**没看图**，对着输入乱猜。
 *   （实测 glm-5.2 会答「抱歉，我看不到图片」；deepseek 会答「这是 SVG 源码文本」。）
 *
 *   ⇒ 探测必须能区分三种情况：
 *     ① 图**送到了**，模型也**承认看见了** ⇒ 正常
 *     ② 图送到了，但模型**不承认** ⇒ 拿到了却不认（deepseek）
 *     ③ 图**压根没送到** ⇒ 配错了（glm-5.2）
 *
 * ── 为什么用真网关测 ──
 *   判据是「prompt_tokens 的增量」—— 这是**网关行为**，
 *   mock 出来的 token 数是编的，测了等于没测。
 *
 * 跑法：需要能连到 AI 网关（.env 里的 AI_BASE_URL / AI_API_KEY）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  v ' + name); }
  else { fail += 1; failures.push(name); console.log('  x ' + name + (detail ? '\n      ' + detail : '')); }
}

// 读 .env（跟服务端同一份）
const envPath = join(appDir, '.env');
if (!existsSync(envPath)) {
  console.log('没有 .env —— 跳过（这个验收要真网关）');
  process.exit(0);
}
const env = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const BASE = (env.AI_BASE_URL || '').replace(/\/+$/, '');
const KEY = env.AI_API_KEY || '';
if (!BASE || !KEY) { console.log('.env 里没有 AI_BASE_URL / AI_API_KEY —— 跳过'); process.exit(0); }

const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

async function ask(model, withImage, attempt = 0) {
  const content = withImage
    ? [{ type: 'text', text: '这张图是什么颜色？' }, { type: 'image_url', image_url: { url: RED_PNG } }]
    : [{ type: 'text', text: '这张图是什么颜色？' }];
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 512 }),
    signal: AbortSignal.timeout(180000),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    // ★ 上游会**临时不可用**（engine is not available / 429 / 504），
    //   退避后重试 —— 否则一次抖动就报「验收失败」，那是噪音不是问题。
    if (attempt < 4 && (r.status === 429 || r.status === 500 || r.status === 502 || r.status === 504)) {
      await new Promise((x) => setTimeout(x, 4000 * (attempt + 1)));
      return ask(model, withImage, attempt + 1);
    }
    return { ok: false, error: 'HTTP ' + r.status + ' ' + text.slice(0, 120) };
  }
  const j = JSON.parse(await r.text());
  return {
    ok: true,
    pt: Number(j?.usage?.prompt_tokens ?? 0),
    said: String(j?.choices?.[0]?.message?.content ?? '').trim(),
  };
}

console.log('视觉能力探测验收');
console.log('网关: ' + BASE);
console.log('='.repeat(64));

const visionModel = env.AI_VISION_MODEL || env.AI_MODEL;
ok('配了 AI_VISION_MODEL（与 AI_MODEL 分开才测得到视觉通道）', Boolean(env.AI_VISION_MODEL));
ok('AI_VISION_MODEL 与 AI_MODEL 不同（同一个就测不出差别）', visionModel !== env.AI_MODEL, visionModel + ' vs ' + env.AI_MODEL);

console.log('\n1. 纯文本的 prompt_tokens 基线');
const plain = await ask(visionModel, false);
ok('纯文本请求成功', plain.ok, plain.error);

console.log('\n2. 带图时 prompt_tokens 必须**明显增加**（图送到了）');
const withImg = await ask(visionModel, true);
ok('带图请求成功', withImg.ok, withImg.error);
if (plain.ok && withImg.ok) {
  const delta = withImg.pt - plain.pt;
  console.log('  纯文本 pt=' + plain.pt + '  带图 pt=' + withImg.pt + '  差=' + delta);
  ok('★ 带图的 token 明显更多（图确实送进去了）', delta > 0, '差=' + delta);
  ok('★ 模型能说出颜色（真看见了）', /红|red/i.test(withImg.said), '它说：' + withImg.said.slice(0, 80));
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log('通过 ' + pass + ' 项，失败 0 项');
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  for (const f of failures) console.log('  x ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
