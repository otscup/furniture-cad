/**
 * ══════════════════════════════════════════════════════════════════════
 *  邮箱注册验证码 —— 待验证记录的签发、限频与核销
 *
 *  ── 为什么独立成一个文件 ──
 *    验证码是**临时态**（10 分钟生死期），账号是**长期态**。混进 auth.mjs
 *    会让两套生命周期互相污染：清过期验证码的逻辑碰不得账号，反之亦然。
 *
 *  ── 安全纪律 ──
 *    1. 验证码落盘只存 sha256(code)。注册库和账号库一样是会进备份的文件，
 *       明文验证码落盘等于把"10 分钟内有效的大门钥匙"贴在门上。
 *    2. 一条记录最多错 5 次 —— 6 位数字共 100 万种，不限次数等于
 *       给暴力枚举开门（自动填充 10 分钟内能试几万次）。
 *    3. 限频三道闸：同邮箱 60 秒一条（防骚扰真人邮箱）、
 *       同邮箱每天 10 条、同 IP 每天 30 条（防把别人的邮箱当靶子）。
 *    4. 核销即删除。用过的验证码不是"标记已用"，是不复存在。
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomInt } from 'node:crypto';

const RESEND_WINDOW_MS = 60_000; // 同邮箱两次发送的最小间隔
const CODE_TTL_MS = 10 * 60_000; // 验证码有效期
const MAX_ATTEMPTS = 5; // 单条验证码最大错误次数
const PER_EMAIL_DAILY = 10; // 同邮箱 24h 内最多发送条数
const PER_IP_DAILY = 30; // 同 IP 24h 内最多发送条数

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

/** 落盘只认这个形态的邮箱 —— 与 server.mjs 的入口校验保持同一把尺子 */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class RegistrationStore {
  /**
   * @param opts.storePath 验证码库落点（JSON，原子写）
   * @param opts.audit     审计回调（复用 auth 的审计日志 —— 注册事件必须在同一份留痕里能查到）
   */
  constructor(opts) {
    this.storePath = opts.storePath;
    this.audit = opts.audit ?? (() => {});
    this.data = this.#load();
  }

  #load() {
    if (!existsSync(this.storePath)) return { version: 1, pending: [] };
    try {
      const d = JSON.parse(readFileSync(this.storePath, 'utf8'));
      if (!d || !Array.isArray(d.pending)) return { version: 1, pending: [] };
      return d;
    } catch {
      // 与账号库同一立场：验证码库损坏不清零重来（清零等于绕过限频），拒绝启动让人来处理
      throw new Error(`注册验证码库 ${this.storePath} 解析失败，请人工检查该文件。`);
    }
  }

  #save() {
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.storePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.storePath);
  }

  #prune() {
    const now = Date.now();
    this.data.pending = this.data.pending.filter((r) => new Date(r.expiresAt).getTime() > now);
  }

  /**
   * 签发一条验证码。返回 { ok, code, expiresInMin } 或 { ok:false, error, code }。
   * 成功时**把明文验证码还给调用方**（server 负责发邮件）；本文件不碰网络。
   */
  issue(email, ip = '') {
    const mail = String(email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(mail)) return { ok: false, error: '邮箱格式不正确', code: 'BAD_EMAIL' };
    this.#prune();
    const now = Date.now();
    const rec = this.data.pending.find((r) => r.email === mail);
    if (rec) {
      const since = now - new Date(rec.lastSentAt).getTime();
      if (since < RESEND_WINDOW_MS) {
        const wait = Math.ceil((RESEND_WINDOW_MS - since) / 1000);
        return { ok: false, error: `发送太频繁，请 ${wait} 秒后再试`, code: 'RATE_LIMITED' };
      }
      if (rec.sends.filter((t) => now - t < 24 * 3600_000).length >= PER_EMAIL_DAILY) {
        return { ok: false, error: '这个邮箱今天的验证码次数已用完，请明天再试', code: 'RATE_LIMITED_DAILY' };
      }
    }
    const ipHits = this.data.pending.filter((r) => r.ip === ip && r.sends.some((t) => now - t < 24 * 3600_000)).length;
    if (ipHits >= PER_IP_DAILY) {
      return { ok: false, error: '当前来源今天的请求次数已达上限', code: 'RATE_LIMITED_IP' };
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    if (rec) {
      rec.codeHash = sha256(code);
      rec.attempts = 0;
      rec.createdAt = new Date(now).toISOString();
      rec.expiresAt = new Date(now + CODE_TTL_MS).toISOString();
      rec.lastSentAt = rec.createdAt;
      rec.sends = [...rec.sends, now];
      rec.ip = ip;
    } else {
      this.data.pending.push({
        email: mail,
        codeHash: sha256(code),
        attempts: 0,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
        lastSentAt: new Date(now).toISOString(),
        sends: [now],
        ip,
      });
    }
    this.#save();
    this.audit({ actor: null, action: 'auth.registerEmail.issue', target: mail, ip, result: 'ok' });
    return { ok: true, code, expiresInMin: Math.round(CODE_TTL_MS / 60_000) };
  }

  /** 发送失败时撤掉刚签发的记录 —— 让用户改完配置能立刻重试，而不是干等 60 秒 */
  revoke(email, reason = '') {
    const mail = String(email ?? '').trim().toLowerCase();
    const before = this.data.pending.length;
    this.data.pending = this.data.pending.filter((r) => r.email !== mail);
    if (this.data.pending.length !== before) {
      this.#save();
      this.audit({ actor: null, action: 'auth.registerEmail.revoke', target: mail, reason: String(reason).slice(0, 120) });
    }
  }

  /**
   * 核销。成功 = 记录当场删除；失败（错码）= 次数 +1，超限 = 记录作废需重新获取。
   *
   * hold 模式：验证码核对通过但**保留记录**，由调用方在账号真正落库后再
   * consume()。为什么需要它：建号还有口令强度、用户名占用这些后续关卡，
   * 若验证码先被删掉，用户改完口令就得干等 60 秒重拿 —— 这是从验收里
   * 真实暴露出来的 UX 缺陷。held 的记录可以被再次 verify（同一码重试）。
   */
  verify(email, code, ip = '', { hold = false } = {}) {
    const mail = String(email ?? '').trim().toLowerCase();
    this.#prune();
    const rec = this.data.pending.find((r) => r.email === mail);
    if (!rec) {
      return { ok: false, error: '验证码不存在或已过期，请重新获取', code: 'NO_PENDING' };
    }
    if (rec.attempts >= MAX_ATTEMPTS) {
      this.data.pending = this.data.pending.filter((r) => r !== rec);
      this.#save();
      this.audit({ actor: null, action: 'auth.registerEmail.verify', target: mail, result: 'too_many_attempts', ip });
      return { ok: false, error: `错误次数过多，这条验证码已作废，请重新获取（每次最多错 ${MAX_ATTEMPTS} 次）`, code: 'TOO_MANY_ATTEMPTS' };
    }
    if (sha256(String(code ?? '').trim()) !== rec.codeHash) {
      rec.attempts += 1;
      const left = MAX_ATTEMPTS - rec.attempts;
      this.#save();
      this.audit({ actor: null, action: 'auth.registerEmail.verify', target: mail, result: 'bad_code', ip });
      return { ok: false, error: `验证码不正确${left > 0 ? `（还剩 ${left} 次机会）` : '，这条验证码已作废，请重新获取'}`, code: 'BAD_CODE' };
    }
    if (!hold) {
      this.data.pending = this.data.pending.filter((r) => r !== rec);
      this.#save();
    }
    this.audit({ actor: null, action: 'auth.registerEmail.verify', target: mail, result: 'ok', ip });
    return { ok: true, email: mail };
  }

  /** 账号落库成功后调用：把（可能处于 hold 状态的）记录彻底核销 */
  consume(email) {
    const mail = String(email ?? '').trim().toLowerCase();
    const before = this.data.pending.length;
    this.data.pending = this.data.pending.filter((r) => r.email !== mail);
    if (this.data.pending.length !== before) this.#save();
  }

  /** 测试与运维用的只读视图：还有多少条在等验证（不含任何验证码信息） */
  stats() {
    this.#prune();
    return { pending: this.data.pending.length };
  }
}
