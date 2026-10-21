#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  服务端模块完整性检查（2026-10-22）
 *
 * ── 它守的是什么 ──
 *   一条**未闭合的块注释**就能让整个 .mjs 文件从某一行起全部变成注释 ——
 *   于是模块「加载成功」但里面所有的声明都不存在，运行期一碰到就是
 *   xxx is not defined。
 *
 *   ★ 真实事故 ──
 *     2026-10-21 的提交 2d34cda 少了一个注释结束符，
 *     导致 server/server.mjs 从第 206 行起全被注释 ——
 *     **所有 AI 端点（chat / plan / design / vision / agent）一律 500**，
 *     持续了整整一天。
 *
 *   ★ 为什么没被现有验收抓住 ──
 *     · tsc --noEmit **不检查 .mjs**
 *     · node --check 只查**语法**，不查「注释吞掉了后面的代码」
 *     · 那些验收都是**单元级**的（直接 import 某个函数），绕过了 HTTP 路由
 *
 *   ⇒ 本检查补上这一层：所有 .mjs 服务端模块的顶层声明都要真的存在。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');
const BT = String.fromCharCode(96);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log('  v ' + name); }
  else { fail += 1; failures.push(name); console.log('  x ' + name + (detail ? '\n      ' + detail : '')); }
}

console.log('服务端模块完整性检查');
console.log('='.repeat(64));
// ── 1. 扫描所有服务端 .mjs，找未闭合的块注释 ──
const SERVER_DIRS = ['server', 'shared'];
const files = [];
for (const d of SERVER_DIRS) {
  const dir = join(appDir, d);
  let entries = [];
  try { entries = readdirSync(dir); } catch { continue; }
  for (const e of entries) {
    if (!e.endsWith('.mjs')) continue;
    const p = join(dir, e);
    if (!statSync(p).isFile()) continue;
    files.push(p);
  }
}

/**
 * 判断一个源文件里有没有**未闭合的块注释**。
 *
 * 做法：逐字符扫，跳过字符串与行注释，统计块注释起止符的配对。
 * 未配平 ⇒ 有一段注释一直没关 ⇒ 后面的代码全被吞掉。
 *
 * @param {string} src 源码
 * @returns {{ok: boolean, line: number}}
 */
function findUnclosedBlockComment(src) {
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      if (close < 0) {
        return { ok: false, line: src.slice(0, i).split('\n').length };
      }
      i = close + 2;
      continue;
    }
    // 字符串（跳过内容里的注释符号）
    if (c === DQ || c === SQ || c === BT) {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    i++;
  }
  return { ok: true, line: 0 };
}

console.log('\n1. 注释必须闭合（未闭合 ⇒ 后面的代码全被吞掉）');
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const r = findUnclosedBlockComment(src);
  const rel = f.replace(appDir + '\\', '');
  ok(rel + ' 没有未闭合的块注释', r.ok, r.ok ? '' : ('第 ' + r.line + ' 行开始的 /* 一直没关'));
}



/**
 * 数块注释的开合是否**嵌套配平**。
 *
 * ★ 为什么不能只查「有没有未闭合」──
 *   真实事故是**少了一个结束符**（不是多了一个），
 *   后面大段代码被吞 ⇒ 那些声明根本不存在。
 *   只查「未闭合」会因为文件后面还有别的注释块而误判为「已闭合」。
 *
 * 做法：逐字符扫，遇到块注释起始符就 +1，遇到结束符就 -1；
 *   中途变成负数（说明多了结束符）或扫完还 > 0（说明少了）都算失衡。
 *
 * @param {string} src 源码
 * @returns {{ok: boolean, line: number}}
 */
function blockCommentBalance(src) {
  let i = 0;
  let depth = 0;
  let openLine = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (c === '/' && next === '*') {
      if (depth === 0) openLine = src.slice(0, i).split('\n').length;
      depth++;
      i += 2;
      continue;
    }
    if (c === '*' && next === '/') {
      depth--;
      if (depth < 0) return { ok: false, line: src.slice(0, i).split('\n').length };
      i += 2;
      continue;
    }
    if (c === DQ || c === SQ || c === BT) {
      const quote = c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    i++;
  }
  if (depth !== 0) return { ok: false, line: openLine };
  return { ok: true, line: 0 };
}
// ── 2. 关键的服务端符号必须真的存在 ──
console.log('\n2. ★ 真起一个服务端，打真实端点（这才是那个 bug 的现场）');
//
// ★ 为什么必须这么测 ──
//   真实事故：少了一个注释结束符 ⇒ server.mjs 从中间起全是注释 ⇒
//   模块「加载成功」但那些声明不存在 ⇒ 运行期一碰到就是
//   xxx is not defined ⇒ **所有 AI 端点一律 500**。
//
//   · 扫源码测不到（正则字面量里的 / 会被误认成注释起止，误报一堆）
//   · node --check 测不到（只看语法，不看「注释吞掉了后面的代码」）
//   · 单元级 import 测不到（绕过了 HTTP 路由，模块顶层根本没被求值）
//
//   ⇒ 唯一诚实的判据：**把服务真起起来，打真实端点，看它答不答**。
const PORT = 8951 + Math.floor(Math.random() * 200);
const srv = spawn(process.execPath, ['server/server.mjs'], {
  cwd: appDir,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let srvOut = '';
srv.stdout.on('data', (d) => { srvOut += d.toString(); });
srv.stderr.on('data', (d) => { srvOut += d.toString(); });
try {
  // 等它起来
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/api/health');
      up = r.status < 500 || (await r.text()).includes('dataWritable');
    } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  ok('服务端能起来', up, srvOut.slice(-300));
  // 打真实端点：故意传错参数，看它是「参数校验 400」还是「代码崩了 500」
  const r = await fetch('http://127.0.0.1:' + PORT + '/api/ai/vision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: '' }),
  });
  const bodyText = await r.text();
  // 400 = 正常的参数校验（说明代码跑起来了）
  // 500 且报 is not defined = 代码被注释吞了
  const isRefErr = /is not defined/.test(bodyText);
  ok('AI 端点不会因为「变量不存在」而崩（说明顶层声明都在）', !isRefErr, bodyText.slice(0, 200));
  ok('AI 端点返回的是结构化错误（400 参数校验）而不是 500', r.status === 400, 'HTTP ' + r.status + ' ' + bodyText.slice(0, 120));
} finally {
  try { srv.kill(); } catch { /* 已退出 */ }
}

console.log('\n3. 服务端模块能被 node 加载（语法 + 顶层求值）');
const LOADABLE = ['server/agentLoop.mjs', 'server/mcpWrite.mjs', 'server/mcp.mjs', 'shared/aiContract.mjs', 'shared/focusStack.mjs', 'shared/sequenceStore.mjs', 'shared/recipes.mjs'];
for (const rel of LOADABLE) {
  const url = 'file:///' + join(appDir, rel.replace(/\//g, '\\')).replace(/\\/g, '/');
  const code = 'import(' + JSON.stringify(url) + ').then(()=>process.exit(0)).catch(e=>{console.error(String(e&&e.message||e));process.exit(1)})';
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    ok(rel + ' 能加载', true);
  } catch (e) {
    const msg = String((e && (e.stderr || e.message)) || '').slice(0, 180);
    ok(rel + ' 能加载', false, msg);
  }
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log('服务端模块完整性：通过 ' + pass + ' 项，失败 0 项');
  console.log('全部通过：没有未闭合的块注释，关键符号都在，模块都能加载。');
} else {
  console.log('服务端模块完整性：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  for (const f of failures) console.log('  x ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
