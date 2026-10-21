#!/usr/bin/env node
/**
 * 换模型前的体检（2026-10-22）
 *
 * ── 为什么需要它 ──
 *   买完 API Key 填进 .env，第一反应是「能用了吗」。
 *   但实测踩过的坑：
 *     · 有的模型**不传图**（image_tokens 恒为 0），接口照样 200、结果照样「完整」
 *     · 有的模型**拒绝 temperature**（kimi-k3: only 1 is allowed）=> 直接 400
 *     · 有的模型**不支持 response_format: json_object** => 400
 *   ⇒ 光「能连通」不够，要**逐项**体检。
 *
 * ── 怎么用 ──
 *   1) 改 .env：AI_BASE_URL / AI_API_KEY / AI_VISION_MODEL
 *   2) node verify/vision-check.mjs
 *   3) 全绿 = 能用；有红项 = 按提示改（多数只是 .env 一行）
 *
 * 打的是**真网关**，不 mock。
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
  else { fail += 1; failures.push(name + (detail ? ' —— ' + detail : '')); console.log('  x ' + name + (detail ? '\n      ' + detail : '')); }
}
function section(t) { console.log('\n' + t); }

const envPath = join(appDir, '.env');
if (!existsSync(envPath)) { console.log('没有 .env —— 先配好再跑'); process.exit(1); }
const env = {};
for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const BASE = (env.AI_BASE_URL || '').replace(/\/+$/, '');
const KEY = env.AI_API_KEY || '';
const VISION = env.AI_VISION_MODEL || env.AI_MODEL || '';
const TEXT = env.AI_MODEL || '';
if (!BASE || !KEY) { console.log('.env 里没有 AI_BASE_URL / AI_API_KEY'); process.exit(1); }

console.log('换模型体检');
console.log('网关: ' + BASE);
console.log('文本: ' + TEXT);
console.log('视觉: ' + VISION);
console.log('='.repeat(64));

const RED_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC';

async function call(model, body, timeout = 120000) {
  const r = await fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model, ...body }),
    signal: AbortSignal.timeout(timeout),
  });
  const t = await r.text();
  if (!r.ok) return { ok: false, status: r.status, text: t.slice(0, 300) };
  try { return { ok: true, j: JSON.parse(t) }; } catch { return { ok: false, status: 0, text: t.slice(0, 300) }; }
}
section('1. 文本模型能回话（且能吐纯 JSON）');
{
  const r = await call(TEXT, { messages: [{ role: 'user', content: '只输出 JSON：{"ok":1}' }], max_tokens: 512 });
  ok('文本模型请求成功', r.ok, r.ok ? '' : 'HTTP ' + r.status + ' ' + r.text);
  if (r.ok) {
    const said = String(r.j?.choices?.[0]?.message?.content ?? '').trim();
    ok('文本模型真的回了话（不是空）', said.length > 0, '正文：' + said.slice(0, 60));
    let parsed = false;
    try { JSON.parse(said); parsed = true; } catch { /* 不是纯 JSON */ }
    ok('文本模型能吐纯 JSON', parsed, said.slice(0, 80));
  }
}

section('2. ★ 视觉模型收 temperature=0 吗（有些模型只允许 1）');
{
  const r = await call(VISION, { messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, temperature: 0 });
  ok('视觉模型接受 temperature=0', r.ok, r.ok ? '' : 'HTTP ' + r.status + ' ' + r.text.slice(0, 140));
  if (!r.ok && /temperature/i.test(r.text)) {
    console.log('      >> 修法：把 .env 里的 AI_TEMPERATURE 删掉，或让服务端不传 temperature');
  }
}

section('3. ★ 视觉模型支持 response_format: json_object 吗');
{
  const r = await call(VISION, {
    messages: [{ role: 'user', content: '只输出 JSON：{"a":1}' }],
    max_tokens: 512,
    response_format: { type: 'json_object' },
  });
  ok('视觉模型接受 response_format', r.ok, r.ok ? '' : 'HTTP ' + r.status + ' ' + r.text.slice(0, 140));
  if (!r.ok) console.log('      >> 若不支持：服务端那行 response_format 要去掉（会退回正则抠 JSON）');
}

section('4. ★★ 图有没有真的送进去（prompt_tokens 增量）');
{
  const plain = await call(VISION, { messages: [{ role: 'user', content: '这张图是什么颜色？' }], max_tokens: 512 });
  const withImg = await call(VISION, {
    messages: [{ role: 'user', content: [
      { type: 'text', text: '这张图是什么颜色？' },
      { type: 'image_url', image_url: { url: RED_PNG } },
    ] }],
    max_tokens: 512,
  });
  ok('视觉模型两次请求都成功', plain.ok && withImg.ok, (plain.error ?? '') + ' ' + (withImg.error ?? ''));
  if (plain.ok && withImg.ok) {
    const a = Number(plain.j?.usage?.prompt_tokens ?? 0);
    const b = Number(withImg.j?.usage?.prompt_tokens ?? 0);
    const said = String(withImg.j?.choices?.[0]?.message?.content ?? '').trim();
    console.log('  纯文本 pt=' + a + '  带图 pt=' + b + '  差=' + (b - a));
    ok('★ 带图的 token 明显更多（图送进去了）', b - a > 0, '差=' + (b - a));
    ok('★ 模型能说出颜色（真看见了）', /红|red/i.test(said), '它说：' + said.slice(0, 80));
  }
}

section('5. 真实图纸识别（结构对不对）');
{
  const imgPath = join(appDir, '..', 'demo-out', 'png', 'sym-02c.png');
  if (!existsSync(imgPath)) {
    console.log('  (跳过 —— 没有 demo-out/png/sym-02c.png)');
  } else {
    const dataUrl = 'data:image/png;base64,' + readFileSync(imgPath).toString('base64');
    const r = await call(VISION, {
      messages: [{ role: 'user', content: [
        { type: 'text', text: '这张柜体图总宽多少毫米？分几格？只回答 JSON：{"宽":数字,"格数":数字}' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ] }],
      max_tokens: 2000,
    });
    ok('真实图纸识别请求成功', r.ok, r.ok ? '' : 'HTTP ' + r.status + ' ' + r.text.slice(0, 140));
    if (r.ok) {
      const said = String(r.j?.choices?.[0]?.message?.content ?? '').trim();
      console.log('  模型说：' + said.replace(/\s+/g, ' ').slice(0, 160));
      ok('★ 认出了总宽 2400mm（ground truth）', /2400/.test(said), '它说：' + said.slice(0, 100));
      ok('★ 认出了 3 格（ground truth）', /3/.test(said), '它说：' + said.slice(0, 100));
    }
  }
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log('通过 ' + pass + ' 项，失败 0 项 —— 这个模型可以用了');
} else {
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项：');
  for (const f of failures) console.log('  x ' + f);
}
console.log('='.repeat(64));
if (fail > 0) process.exitCode = 1;
