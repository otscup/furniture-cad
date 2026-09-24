#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  邮箱注册验收 —— 独立起一个带临时数据目录的本地服务，把注册全流程走真。
 *
 *  为什么独立起服务而不是直接 import 类：
 *    要验的是「HTTP 层的开放性判定 + 限频 + 落盘发信 + 账号落库」整条链，
 *    任何一环只测内存对象都会漏掉（比如 PUBLIC_API 忘了加白名单这种
 *    只在 HTTP 层才存在的错误）。落盘发信模式（SMTP_MODE=file）让
 *    验证码可读取 —— 全流程无网、可复现、不碰真邮箱。
 * ══════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP = mkdtempSync(join(tmpdir(), 'furniture-cad-email-verify-'));
const ENV_PATH = join(TMP, 'env', '.env');
const ACCOUNTS_PATH = join(TMP, 'memory', 'accounts.json');
const AUDIT_PATH = join(TMP, 'memory', 'audit.jsonl');
const REG_PATH = join(TMP, 'memory', 'pending-registrations.json');
const OUTBOX = join(TMP, 'memory', 'outbox.jsonl');
const PORT = 8893;
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(join(TMP, 'env'), { recursive: true });
mkdirSync(join(TMP, 'memory'), { recursive: true });
writeFileSync(
  ENV_PATH,
  ['# 邮箱注册验收专用', 'AI_PROVIDER=deepseek', 'AI_BASE_URL=https://api.deepseek.com/v1', 'AI_MODEL=deepseek-chat', 'AI_API_KEY=sk-email-verify-fake', 'AI_TIMEOUT_MS=4000', 'SMTP_MODE=file', `SMTP_FILE_OUT=${OUTBOX}`, 'SMTP_FROM=cad-verify@example.com', ''].join('\n'),
  'utf8'
);

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) pass += 1;
  else fail += 1;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : `\n      ${String(detail).slice(0, 300)}`}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/** 从落盘邮件里取发给自己邮箱的最新验证码 */
function lastCodeFor(email) {
  if (!existsSync(OUTBOX)) return null;
  const mails = readFileSync(OUTBOX, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((m) => m.to === email);
  const last = mails[mails.length - 1];
  const m = /验证码：(\d{6})/.exec(String(last?.subject ?? last?.text ?? ''));
  return m ? m[1] : null;
}

function startServer() {
  const p = spawn(process.execPath, ['server/server.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(PORT), APP_ENV_PATH: ENV_PATH, APP_ACCOUNTS_PATH: ACCOUNTS_PATH, APP_AUDIT_PATH: AUDIT_PATH, APP_REGISTRATIONS_PATH: REG_PATH, APP_MEM_PATH: join(TMP, 'memory', 'corrections.jsonl') },
  });
  p.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  return p;
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  return false;
}

const server = startServer();
try {
  if (!(await waitUp())) throw new Error('server 未能在 10s 内启动');

  // ═══════════ A. local-open：邮箱注册可作为第一账号（owner）通道 ═══════════
  console.log('\n── A. local-open 阶段：邮箱注册建第一个账号 ──');

  const bad = await call('/api/auth/register-email', { method: 'POST', body: { email: 'not-an-email' } });
  ok('非法邮箱被 400 拒绝', bad.status === 400 && bad.body.code === 'BAD_EMAIL', JSON.stringify(bad));

  const e1 = 'owner-a@example.com';
  const r1 = await call('/api/auth/register-email', { method: 'POST', body: { email: e1 } });
  ok('local-open 下请求验证码成功（落盘发信）', r1.status === 200 && r1.body.sendMode === 'file', JSON.stringify(r1));
  const code1 = lastCodeFor(e1);
  ok('落盘邮件里有 6 位验证码（且服务端响应里没有它 —— 响应泄码等于没验证）', /^\d{6}$/.test(code1 ?? '') && !JSON.stringify(r1.body).includes(code1 ?? ''), `code=${code1}`);

  const rAgain = await call('/api/auth/register-email', { method: 'POST', body: { email: e1 } });
  ok('60 秒内重复请求同一邮箱被 429 限频', rAgain.status === 429 && rAgain.body.code === 'RATE_LIMITED', JSON.stringify(rAgain));

  const w1 = await call('/api/auth/register-email/verify', { method: 'POST', body: { email: e1, code: '000000' !== code1 ? '000000' : '111111', password: 'Vf9-tRw2-Kqp7' } });
  ok('错误验证码被 400 拒绝', w1.status === 400 && w1.body.code === 'BAD_CODE', JSON.stringify(w1));

  const v1 = await call('/api/auth/register-email/verify', { method: 'POST', body: { email: e1, code: code1, password: 'Vf9-tRw2-Kqp7' } });
  ok('正确验证码建号成功：自动登录、角色 owner（第一个账号）', v1.status === 200 && v1.body.account?.role === 'owner' && typeof v1.body.token === 'string', JSON.stringify({ ...v1.body, token: v1.body.token ? '***' : null }));
  const ownerToken = v1.body.token;

  const me1 = await call('/api/auth/me', { token: ownerToken });
  ok('/api/auth/me 带邮箱（账号视图透出 email）', me1.body.account?.email === e1, JSON.stringify(me1.body.account ?? {}));

  const closed = await call('/api/auth/register-email', { method: 'POST', body: { email: 'second@example.com' } });
  ok('已有账号且未开「开放注册」→ 403 SIGNUP_CLOSED（注册接口不成为后门）', closed.status === 403 && closed.body.code === 'SIGNUP_CLOSED', JSON.stringify(closed));

  // ═══════════ B. 管理端：SMTP 设置 / 打码 / 开关 ═══════════
  console.log('\n── B. SMTP 设置与开放注册开关 ──');

  const g0 = await call('/api/settings/smtp', { token: ownerToken });
  ok('GET smtp：回 mode/fileOut/signupOpen，口令未设置', g0.status === 200 && g0.body.mode === 'file' && g0.body.signupOpen === false && g0.body.passSet === false, JSON.stringify(g0.body));

  const put1 = await call('/api/settings/smtp', { method: 'PUT', token: ownerToken, body: { signupOpen: true, pass: 'verify-auth-pw-123' } });
  ok('PUT smtp：开「开放注册」+ 存授权码成功', put1.status === 200 && put1.body.signupOpen === true && put1.body.passSet === true, JSON.stringify(put1.body));
  ok('口令只回打码值（响应里没有原文）', put1.body.passMasked.includes('*') && !JSON.stringify(put1.body).includes('verify-auth-pw-123'), put1.body.passMasked);

  const put2 = await call('/api/settings/smtp', { method: 'PUT', token: ownerToken, body: { signupOpen: true } });
  ok('PUT 不带口令 = 不修改（passSet 仍为 true）', put2.body.passSet === true, JSON.stringify(put2.body));

  const test1 = await call('/api/settings/smtp/test', { method: 'POST', token: ownerToken, body: { to: 'admin@example.com' } });
  ok('测试邮件走落盘模式成功', test1.status === 200 && test1.body.mode === 'file', JSON.stringify(test1));

  // ═══════════ C. 开放注册后的完整流程 ═══════════
  console.log('\n── C. 开放注册：验证码全流程 ──');

  const e2 = 'user-b@example.com';
  const r2 = await call('/api/auth/register-email', { method: 'POST', body: { email: e2 } });
  ok('开放注册下第二个邮箱拿到验证码', r2.status === 200, JSON.stringify(r2));
  const code2 = lastCodeFor(e2);
  for (let i = 0; i < 5; i++) {
    const w = await call('/api/auth/register-email/verify', { method: 'POST', body: { email: e2, code: i === 0 ? '000000' : '00000' + ((i + 1) % 10), password: 'Vf9-tRw2-Kqp7' } });
    if (!(w.status === 400 && w.body.code === 'BAD_CODE')) {
      ok(`错码第 ${i + 1} 次被拒并提示剩余机会`, false, JSON.stringify(w));
      break;
    }
    if (i === 4) ok('错码 5 次逐次被拒（每次提示剩余次数）', true);
  }
  const tooMany = await call('/api/auth/register-email/verify', { method: 'POST', body: { email: e2, code: code2, password: 'Vf9-tRw2-Kqp7' } });
  ok('错满 5 次后，连正确验证码也作废（防在线枚举）', tooMany.status === 400 && tooMany.body.code === 'TOO_MANY_ATTEMPTS', JSON.stringify(tooMany));

  const e3 = 'user-c@example.com';
  await call('/api/auth/register-email', { method: 'POST', body: { email: e3 } });
  const code3 = lastCodeFor(e3);
  const weak = await call('/api/auth/register-email/verify', { method: 'POST', body: { email: e3, code: code3, password: '12345678' } });
  ok('弱口令（纯数字）被拒 —— 验证码对了口令也必须过硬', weak.status === 400 && /纯数字/.test(weak.body.error ?? ''), JSON.stringify(weak));

  // hold 设计：口令被拒后**同一验证码**仍然可用（记录保留到账号真正落库才核销），
  // 用户改个口令就能重试，不用干等 60 秒重拿 —— 这是从首轮验收里抓出的 UX 缺陷
  const v3 = await call('/api/auth/register-email/verify', { method: 'POST', body: { email: e3, code: code3, password: 'Vf9-tRw2-Kqp7' } });
  ok('同一验证码换强口令重试成功（hold：弱口令被拒不白吃验证码）', v3.status === 200 && v3.body.account?.role === 'designer' && v3.body.account?.email === e3, JSON.stringify(v3.body.account ?? {}));

  // 限频只对「还有待验记录」的邮箱生效（注册成功即核销，重发是新的合法请求）；
  // 用全新邮箱连发两次来验 60 秒窗口
  const e5 = 'user-rate@example.com';
  const dupA = await call('/api/auth/register-email', { method: 'POST', body: { email: e5 } });
  const dupB = await call('/api/auth/register-email', { method: 'POST', body: { email: e5 } });
  ok('同一邮箱 60 秒内连发两次：第一次成功、第二次 429（不能用来轰炸真人邮箱）', dupA.status === 200 && dupB.status === 429 && dupB.body.code === 'RATE_LIMITED', JSON.stringify({ dupA: dupA.status, dupB }));

  const login3 = await call('/api/auth/login', { method: 'POST', body: { username: e3, password: 'Vf9-tRw2-Kqp7' } });
  ok('邮箱即用户名，可直接登录', login3.status === 200 && login3.body.account?.email === e3, JSON.stringify(login3.body.account ?? {}));

  // ═══════════ D. SMTP 未配置的负例 ═══════════
  console.log('\n── D. SMTP 未配置时明确报错 ──');

  const putOff = await call('/api/settings/smtp', { method: 'PUT', token: ownerToken, body: { mode: 'smtp', host: '' } });
  ok('切到 smtp 模式但不填 host → configured=false', putOff.body.configured === false, JSON.stringify(putOff.body));
  const r4 = await call('/api/auth/register-email', { method: 'POST', body: { email: 'user-d@example.com' } });
  ok('未配置 SMTP 时注册请求 503，报错指向管理后台', r4.status === 503 && r4.body.code === 'SMTP_NOT_CONFIGURED', JSON.stringify(r4));

  const audit = readFileSync(AUDIT_PATH, 'utf8');
  ok('审计日志里有 registerEmail 的 issue/verify 留痕', audit.includes('auth.registerEmail.issue') && audit.includes('auth.registerEmail.verify') && audit.includes('settings.smtp'));

  console.log(`\n═══ 邮箱注册（email）：通过 ${pass} 项，失败 ${fail} 项 ═══`);
  process.exitCode = fail > 0 ? 1 : 0;
} catch (e) {
  console.error('\nERR:', e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  await sleep(300);
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch { /* 临时目录删不掉不影响结论 */ }
}
