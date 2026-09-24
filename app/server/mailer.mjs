/**
 * ══════════════════════════════════════════════════════════════════════
 *  邮件发送 —— SMTP 配置的读取、打码与发信
 *
 *  ── 为什么用 nodemailer 而不是自己写 SMTP 客户端 ──
 *    本项目 server 侧一直坚持零依赖，但 SMTP 是个例外：
 *    STARTTLS 协商、AUTH PLAIN/LOGIN、多行应答解析、各家邮箱
 *    （QQ/163/Gmail）的怪癖，每一处都是真实的坑，自写会在
 *    "用户正式注册的那一刻"才爆出来。发信是账号体系的安全件，
 *    用久经考验的库是工程判断，不是偷懒。
 *
 *  ── 两种发信模式 ──
 *    smtp  默认。读 .env 里的 SMTP_* 配置真发信。
 *    file  落盘模式（SMTP_MODE=file）。不发网，把邮件写成 JSONL 追加到
 *          SMTP_FILE_OUT。用途：① 验收测试拿到验证码走完整注册流；
 *          ② 本地开发没配 SMTP 时也能把注册流程跑通。
 *          落盘模式在 describe() 里照实标注，界面必须显示出来，
 *          不许让用户以为邮件真的发出去了。
 *
 *  ── 口令纪律 ──
 *    SMTP 授权码与 AI API Key 同级：只落 .env，GET 永远只回打码值，
 *    PUT 留空 = 不修改。前端永远拿不到原文。
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import nodemailer from 'nodemailer';

export const SMTP_KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_MODE', 'SMTP_FILE_OUT'];

/** 从 env 读出 SMTP 配置（.env 由 server.mjs 的 readEnv 提供） */
export function readConfig(env) {
  const mode = String(env.SMTP_MODE ?? 'smtp').toLowerCase() === 'file' ? 'file' : 'smtp';
  const port = Number(env.SMTP_PORT ?? (env.SMTP_SECURE === '1' ? 465 : 587));
  return {
    mode,
    host: String(env.SMTP_HOST ?? '').trim(),
    port,
    secure: env.SMTP_SECURE === '1' || (!env.SMTP_SECURE && port === 465),
    user: String(env.SMTP_USER ?? '').trim(),
    pass: String(env.SMTP_PASS ?? ''),
    from: String(env.SMTP_FROM ?? '').trim() || String(env.SMTP_USER ?? '').trim(),
    fileOut: String(env.SMTP_FILE_OUT ?? '').trim(),
  };
}

/** 是否具备发信条件：落盘模式只差一个落点；SMTP 模式必须有 host 与发件人 */
export function isConfigured(env) {
  const c = readConfig(env);
  if (c.mode === 'file') return Boolean(c.fileOut);
  return Boolean(c.host && c.from);
}

/** 对外视图 —— 口令只回打码值，与 AI API Key 同一纪律 */
export function describe(env) {
  const c = readConfig(env);
  const passSet = Boolean(c.pass);
  return {
    mode: c.mode,
    configured: isConfigured(env),
    host: c.host,
    port: c.port,
    secure: c.secure,
    user: c.user,
    from: c.from,
    passMasked: passSet ? `${'*'.repeat(8)}${c.pass.slice(-2)}` : '',
    passSet,
    fileOut: c.mode === 'file' ? c.fileOut : '',
    signupOpen: env.SIGNUP_OPEN === '1',
  };
}

/** UTF-8 中文主题/正文都走 base64 MIME —— 各家 SMTP 对 8BITMIME 的支持参差，这是最稳的路 */
function mimeHeader(name, value) {
  return `${name}: =?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMime({ from, to, subject, text }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    mimeHeader('Subject', subject),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(text, 'utf8').toString('base64'),
  ].join('\r\n');
}

/**
 * 发一封邮件。返回 { ok, mode, messageId?, file? } 或 { ok:false, error }。
 * 报错永远带"下一步该干什么"：没配置就说去管理后台，发不出去就带上服务商原话。
 */
export async function sendMail(env, { to, subject, text }) {
  const c = readConfig(env);
  if (!isConfigured(env)) {
    return { ok: false, error: '邮件服务未配置：请由管理员在「管理后台 → 邮件 / SMTP」里填写设置（本地调试可设 SMTP_MODE=file 落盘模式）', code: 'SMTP_NOT_CONFIGURED' };
  }
  if (c.mode === 'file') {
    const line = JSON.stringify({ at: new Date().toISOString(), mode: 'file', from: c.from, to, subject, text }) + '\n';
    try {
      const dir = dirname(c.fileOut);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(c.fileOut, line, 'utf8');
      return { ok: true, mode: 'file', file: c.fileOut };
    } catch (e) {
      return { ok: false, error: `落盘模式写文件失败：${e.message}` };
    }
  }
  try {
    const transport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    });
    const info = await transport.sendMail({ from: c.from, to, subject, text });
    return { ok: true, mode: 'smtp', messageId: info.messageId };
  } catch (e) {
    return { ok: false, error: `SMTP 发送失败：${e.message}` };
  }
}

const CODE_MAIL_TEXT = (code, minutes) =>
  `你正在注册家具 CAD 账号。\n\n验证码：${code}\n\n${minutes} 分钟内有效。如果这不是你本人的操作，请忽略本邮件。`;

export async function sendVerificationCode(env, email, code, minutes = 10) {
  return sendMail(env, {
    to: email,
    subject: `家具 CAD 注册验证码：${code}`,
    text: CODE_MAIL_TEXT(code, minutes),
  });
}

export async function sendTest(env, to) {
  return sendMail(env, {
    to,
    subject: '家具 CAD · SMTP 测试邮件',
    text: `这是一封来自家具 CAD 本地服务的测试邮件（${new Date().toLocaleString('zh-CN')}）。\n收到它说明 SMTP 配置是通的。`,
  });
}

/** 验收/排障用：读落盘模式的全部邮件（最新在后） */
export function readFileOutbox(fileOut) {
  if (!fileOut || !existsSync(fileOut)) return [];
  return readFileSync(fileOut, 'utf8')
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
}
