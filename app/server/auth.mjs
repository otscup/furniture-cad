/**
 * ══════════════════════════════════════════════════════════════════════
 *  账号 / 会话 / 额度 / 审计 —— 零依赖实现
 *
 *  为什么全放在一个文件里：这四件事共用同一份载体（账号记录），
 *  拆成四个模块必然出现"谁负责写盘"的扯皮，最后落出两份状态。
 *  一份 store，一处读写，一处判权限。
 *
 *  ── 关于"这是不是生产级" ──
 *    不是。这里实现的是一套**能自证清白**的单机账号体系：
 *      · 口令用 scrypt + 每账号独立随机盐，比较用 timingSafeEqual
 *      · 会话 token 只落**哈希**，明文只回给登录者一次
 *      · 失败登录计数 + 锁定窗口
 *      · 所有管理操作写审计日志
 *    缺的是生产必需的那几样，**已在 /api/security/policy 里逐条写明**：
 *      HTTPS、反向代理后的真实 IP、会话轮换与撤销、邮件/短信二次验证、
 *      数据库而不是 JSON 文件、备份与灾备。
 *    把这些说清楚比假装安全重要得多 —— 一个"看起来有登录框"的系统
 *    比一个明说"我是单机自用"的系统危险。
 *
 *  ── 两种运行模式（关键设计）──
 *    local-open  —— 还没有任何账号。所有接口不要求 token，行为与加账号体系之前完全一致。
 *                   目的：不破坏任何既有用法，也让"先自用、后商业化"这条路走得通。
 *    accounts    —— 存在至少一个账号。**所有** /api 接口（除健康检查与登录本身）都要求 token。
 *                   一旦建了第一个账号，就没有"悄悄绕过"的口子 —— 这个切换是单向的。
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
// P10.0 S1-E：账号库写入口统一经进程内串行写队列，消除并发 save 的整文件丢写
import { enqueueWrite } from './writeQueue.mjs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

/** 角色 → 能做什么。全部判定只读这一张表，不许在别处再写一遍 if (role === ...) */
export const ROLES = {
  owner: { label: '所有者', rank: 40, canManage: true, canDesign: true, canView: true },
  admin: { label: '管理员', rank: 30, canManage: true, canDesign: true, canView: true },
  designer: { label: '设计师', rank: 20, canManage: false, canDesign: true, canView: true },
  viewer: { label: '只读', rank: 10, canManage: false, canDesign: false, canView: true },
};

/**
 * 订阅档位 —— 定义在 shared/quota.mjs，这里只是转发。
 *
 * 为什么不留在 auth.mjs：额度要在服务端、账号面板、管理后台、AI 面板四处显示，
 * 而"四处各格式化一次"迟早会显示成四个不同的数。档位表、显示口径、
 * 已用/剩余的计算全部只有一份（见 shared/quota.mjs 文件头）。
 */
import { PLANS, planOf, normalizeUsage, applyUsage, checkQuota as evalQuota, quotaView } from '../shared/quota.mjs';
export { PLANS };

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 小时
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const SCRYPT_KEYLEN = 64;
/** scrypt 代价参数。写在这里、并且**记进哈希串**里 —— 见 hashPassword 的说明 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/** 自描述哈希串：scrypt$N=…,r=…,p=…$salt$hash */
function encodeHash(salt, hash, params) {
  return `scrypt$N=${params.N},r=${params.r},p=${params.p}$${salt}$${hash}`;
}

/**
 * 解析自描述哈希串；认不出来就按**早期的裸 hex + 独立盐**形态处理。
 *
 * 为什么要留这条老路：换哈希格式的那一天，已经存在的账号必须仍能登录。
 * "升级后所有人登不进来"是这类改动最典型的翻车方式。
 */
function parseHash(stored, legacySalt) {
  const s = String(stored ?? '');
  const m = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/.exec(s);
  if (m) {
    const params = { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
    const hash = m[5];
    return { salt: m[4], hash, params, keylen: hash.length / 2 };
  }
  // 早期形态：hash 是裸 hex，盐在另一个字段里
  if (/^[0-9a-f]+$/.test(s) && legacySalt) {
    return { salt: String(legacySalt), hash: s, params: SCRYPT_PARAMS, keylen: s.length / 2 };
  }
  return null;
}

export class AuthStore {  /**
   * @param opts.accountsPath 账号库落点（JSON）
   * @param opts.auditPath    审计日志落点（JSONL，**只追加**）
   */
  constructor(opts) {
    this.accountsPath = opts.accountsPath;
    this.auditPath = opts.auditPath;
    this.data = this.#load();
  }

  // ───────────────────────── 持久化 ─────────────────────────

  #load() {
    if (!existsSync(this.accountsPath)) return { version: 1, accounts: [] };
    try {
      const d = JSON.parse(readFileSync(this.accountsPath, 'utf8'));
      if (!d || !Array.isArray(d.accounts)) return { version: 1, accounts: [] };
      return d;
    } catch {
      /**
       * 账号库损坏**不能**当成"没有账号"—— 那等于把整个系统降级成不设防，
       * 任何人打开页面就又是主人了。宁可启动失败，让人来处理。
       */
      throw new Error(`账号库 ${this.accountsPath} 解析失败。为安全起见拒绝降级为"无账号"模式，请人工检查该文件。`);
    }
  }

  #save() {
    // 经进程内串行写队列：同一账号库路径的多次 save 按提交顺序落盘，
    // 一个写失败不影响后续；写本身仍用 tmp + rename 原子替换。
    return enqueueWrite(this.accountsPath, () => {
      const dir = dirname(this.accountsPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const tmp = `${this.accountsPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      renameSync(tmp, this.accountsPath);
    });
  }

  /** 审计日志只追加，永不覆盖 —— 它是"谁在什么时候改了什么"的唯一凭据 */
  audit(entry) {
    const dir = dirname(this.auditPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    // 只追加、不读改写回 —— readFile+writeFile 在并发写时会互相覆盖，丢失他人条目。
    appendFileSync(this.auditPath, `${line}\n`, 'utf8');
  }

  readAudit(limit = 200) {
    if (!existsSync(this.auditPath)) return [];
    const lines = readFileSync(this.auditPath, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(-limit).reverse().map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { at: '', action: 'parse_error', raw: l.slice(0, 200) };
      }
    });
  }

  // ───────────────────────── 模式 ─────────────────────────

  get enabled() {
    return this.data.accounts.length > 0;
  }

  get mode() {
    return this.enabled ? 'accounts' : 'local-open';
  }

  // ───────────────────────── 口令 ─────────────────────────

  /**
   * 口令哈希 —— 存成**自描述**的串：
   *
   *     scrypt$N=16384,r=8,p=1$<salt-hex>$<hash-hex>
   *
   * 为什么不存一个裸 hex：
   *   裸 hex 只记下了"结果"，没记下"用哪套参数算的"。将来把 N 从 16384 提到
   *   65536（或者整族换成 argon2），**老账号就没法验证了** ——
   *   而那恰恰是最不该出事的时刻：所有人会在同一个早上突然登不进来。
   *   自描述之后，参数升级可以逐账号做：验证时按记录里的参数算，
   *   登录成功后再用新参数重算一遍写回去。用户名/口令是唯一凭据，
   *   这条升级路必须提前留好。
   *
   * 兼容：仍然接受早期的 `{ salt, hash: <裸 hex> }` 形态（那时盐是分开存的），
   * 所以换格式不会把已经存在的账号锁在门外。
   */
  static hashPassword(password, salt = randomBytes(16).toString('hex')) {
    const hash = scryptSync(String(password), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS).toString('hex');
    return { salt, hash: encodeHash(salt, hash, SCRYPT_PARAMS) };
  }

  /** 校验。`stored` 既可以是自描述串，也可以是早期形态（此时需要用 legacySalt 补齐） */
  static verifyPassword(password, stored, legacySalt) {
    try {
      const parsed = parseHash(stored, legacySalt);
      if (!parsed) return false;
      const a = scryptSync(String(password), parsed.salt, parsed.keylen, parsed.params);
      const b = Buffer.from(parsed.hash, 'hex');
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  // ───────────────────────── 账号 ─────────────────────────

  /** 对外暴露的账号视图 —— **白名单**，口令哈希与盐永远不出这个函数 */
  static publicView(a, extra = {}) {
    return {
      id: a.id,
      username: a.username,
      displayName: a.displayName,
      role: a.role,
      roleLabel: ROLES[a.role]?.label ?? a.role,
      plan: a.plan,
      planLabel: PLANS[a.plan]?.label ?? a.plan,
      email: a.email ?? null,
      status: a.status,
      tenantId: a.tenantId,
      createdAt: a.createdAt,
      lastLoginAt: a.lastLoginAt ?? null,
      /**
       * 额度**视图**（已用/剩余/百分比/被哪条拦住）。
       *
       * 以前这里发的是三个裸数字，界面自己去拼"已用 / 限额"、自己算百分比 ——
       * 于是同一个额度在账号面板和后台可能是两种说法。现在两边拿的都是这一份，
       * 界面只负责把它画出来，不做第二次计算。
       */
      quota: quotaView(a.plan, a.usage),
      ...extra,
    };
  }

  list() {
    return this.data.accounts.map((a) => AuthStore.publicView(a));
  }

  findById(id) {
    return this.data.accounts.find((a) => a.id === id) ?? null;
  }

  findByUsername(username) {
    const u = String(username ?? '').trim().toLowerCase();
    return this.data.accounts.find((a) => a.username.toLowerCase() === u) ?? null;
  }

  /**
   * 建账号。第一个账号必然是 owner —— 且**只**允许在没有账号时自助创建，
   * 之后创建账号必须有 owner/admin 身份（由调用方先判定权限）。
   *
   * email 可选：邮箱注册路径会带上（登录用 username，邮箱用于找回与通知的落点）。
   * 格式与唯一性在这里判定 —— 调用方给的邮箱必须过了同一把尺子才落库。
   */
  create({ username, password, displayName, role, plan, email, actor = null }) {
    const u = String(username ?? '').trim();
    if (!/^[A-Za-z0-9_.@-]{3,32}$/.test(u)) return { ok: false, error: '用户名只能由字母、数字、_ . @ - 组成，3~32 位' };
    if (this.findByUsername(u)) return { ok: false, error: '用户名已存在' };
    const mail = String(email ?? '').trim().toLowerCase();
    if (mail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { ok: false, error: '邮箱格式不正确' };
      if (this.data.accounts.some((a) => a.email === mail)) return { ok: false, error: '这个邮箱已经注册过账号' };
    }
    const pwErr = checkPasswordStrength(password);
    if (pwErr) return { ok: false, error: pwErr };
    const first = this.data.accounts.length === 0;
    const finalRole = first ? 'owner' : role && ROLES[role] ? role : 'designer';
    const { salt, hash } = AuthStore.hashPassword(password);
    const acc = {
      id: `acc_${randomBytes(6).toString('hex')}`,
      username: u,
      displayName: String(displayName ?? '').trim() || u,
      role: finalRole,
      plan: plan && PLANS[plan] ? plan : 'free',
      status: 'active',
      email: mail || null,
      /**
       * 租户 id —— 商用上线后所有业务数据（项目/规则集/订单）都要按它隔离。
       * 现在只有一个租户，但字段从第一天就在，将来不必做数据迁移。
       * owner 的租户 id 固定为 'tenant_default'，其它账号默认加入同一租户，
       * 由管理操作显式改成别的值 —— 不允许通过注册参数自选（否则就是租户逃逸）。
       */
      tenantId: first ? 'tenant_default' : 'tenant_default',
      password: { salt, hash },
      createdAt: new Date().toISOString(),
      sessions: [],
      /** 长期 API token（PAT）—— 只落哈希，见 createToken。新账号初始化为空数组。 */
      tokens: [],
      failedLogins: [],
      lockedUntil: null,
      usage: normalizeUsage(null),
    };
    this.data.accounts.push(acc);
    this.#save();
    this.audit({ actor: actor ?? acc.id, action: first ? 'account.bootstrap' : 'account.create', target: acc.id, username: acc.username, role: acc.role });
    return { ok: true, account: AuthStore.publicView(acc) };
  }

  setRole(id, role, actor) {
    const a = this.findById(id);
    if (!a) return { ok: false, error: '账号不存在' };
    if (!ROLES[role]) return { ok: false, error: `未知角色 ${role}` };
    if (a.role === 'owner' && role !== 'owner' && this.#ownerCount() <= 1) {
      return { ok: false, error: '这是最后一个所有者账号，不能降级 —— 否则没人能再管理这个系统了' };
    }
    const from = a.role;
    a.role = role;
    this.#save();
    this.audit({ actor, action: 'account.setRole', target: id, from, to: role });
    return { ok: true, account: AuthStore.publicView(a) };
  }

  setPlan(id, plan, actor) {
    const a = this.findById(id);
    if (!a) return { ok: false, error: '账号不存在' };
    if (!PLANS[plan]) return { ok: false, error: `未知档位 ${plan}` };
    const from = a.plan;
    a.plan = plan;
    this.#save();
    this.audit({ actor, action: 'account.setPlan', target: id, from, to: plan });
    return { ok: true, account: AuthStore.publicView(a) };
  }

  setStatus(id, status, actor) {
    const a = this.findById(id);
    if (!a) return { ok: false, error: '账号不存在' };
    if (!['active', 'disabled'].includes(status)) return { ok: false, error: '状态只能是 active / disabled' };
    if (a.role === 'owner' && status === 'disabled' && this.#ownerCount() <= 1) {
      return { ok: false, error: '不能停用最后一个所有者账号' };
    }
    a.status = status;
    if (status === 'disabled') a.sessions = []; // 停用即踢下线
    this.#save();
    this.audit({ actor, action: 'account.setStatus', target: id, to: status });
    return { ok: true, account: AuthStore.publicView(a) };
  }

  /** 改自己的口令：必须提供当前口令。改完踢掉所有会话（含当前这条） */
  changePassword(id, currentPassword, newPassword) {
    const a = this.findById(id);
    if (!a) return { ok: false, error: '账号不存在' };
    if (!AuthStore.verifyPassword(currentPassword, a.password.hash, a.password.salt)) {
      this.audit({ actor: id, action: 'account.changePassword', result: 'bad_current' });
      return { ok: false, error: '当前口令不正确' };
    }
    const pwErr = checkPasswordStrength(newPassword);
    if (pwErr) return { ok: false, error: pwErr };
    a.password = AuthStore.hashPassword(newPassword);
    a.sessions = [];
    this.#save();
    this.audit({ actor: id, action: 'account.changePassword', result: 'ok' });
    return { ok: true };
  }

  /** 管理员重置口令：不需要旧口令，但会踢下线并记审计（这是有意的越权行为，必须留痕） */
  resetPassword(id, newPassword, actor) {
    const a = this.findById(id);
    if (!a) return { ok: false, error: '账号不存在' };
    const pwErr = checkPasswordStrength(newPassword);
    if (pwErr) return { ok: false, error: pwErr };
    a.password = AuthStore.hashPassword(newPassword);
    a.sessions = [];
    this.#save();
    this.audit({ actor, action: 'account.resetPassword', target: id });
    return { ok: true };
  }

  #ownerCount() {
    return this.data.accounts.filter((a) => a.role === 'owner' && a.status === 'active').length;
  }

  // ───────────────────────── 登录 / 会话 ─────────────────────────

  /**
   * 登录。
   *
   * 失败一律回同一个错误文案（"用户名或口令不正确"），不区分
   * "用户不存在"和"口令错误" —— 后者会变成账号枚举接口。
   * 但要**分别**记审计，否则排查真实问题时没有线索。
   */
  login(username, password, meta = {}) {
    const a = this.findByUsername(username);
    const now = Date.now();
    if (!a) {
      this.audit({ actor: null, action: 'auth.login', username: String(username ?? '').slice(0, 64), result: 'no_such_user', ip: meta.ip });
      return { ok: false, error: '用户名或口令不正确', code: 'BAD_CREDENTIALS' };
    }
    if (a.lockedUntil && new Date(a.lockedUntil).getTime() > now) {
      const left = Math.ceil((new Date(a.lockedUntil).getTime() - now) / 1000);
      this.audit({ actor: a.id, action: 'auth.login', result: 'locked', ip: meta.ip });
      return { ok: false, error: `账号已锁定，请 ${left} 秒后再试`, code: 'LOCKED' };
    }
    if (a.status !== 'active') {
      this.audit({ actor: a.id, action: 'auth.login', result: 'disabled', ip: meta.ip });
      return { ok: false, error: '账号已停用，请联系管理员', code: 'DISABLED' };
    }
    if (!AuthStore.verifyPassword(password, a.password.hash, a.password.salt)) {
      a.failedLogins = [...(a.failedLogins ?? []), now].filter((t) => now - t < LOGIN_WINDOW_MS);
      let locked = false;
      if (a.failedLogins.length >= LOGIN_MAX_FAILS) {
        a.lockedUntil = new Date(now + LOCK_MS).toISOString();
        a.failedLogins = [];
        locked = true;
      }
      this.#save();
      this.audit({ actor: a.id, action: 'auth.login', result: locked ? 'fail+locked' : 'fail', ip: meta.ip, ua: meta.ua });
      return {
        ok: false,
        error: locked ? `连续 ${LOGIN_MAX_FAILS} 次口令错误，账号已锁定 ${LOCK_MS / 60000} 分钟` : '用户名或口令不正确',
        code: locked ? 'LOCKED' : 'BAD_CREDENTIALS',
      };
    }

    a.failedLogins = [];
    a.lockedUntil = null;
    a.lastLoginAt = new Date().toISOString();
    const token = randomBytes(32).toString('base64url'); // 明文 token 只出现在这一次响应里
    a.sessions = [
      ...(a.sessions ?? []).filter((s) => new Date(s.expiresAt).getTime() > now),
      {
        hash: sha256(token), // ← 落盘的只有哈希
        createdAt: new Date().toISOString(),
        expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
        ip: meta.ip ?? '',
        ua: String(meta.ua ?? '').slice(0, 160),
      },
    ];
    this.#save();
    this.audit({ actor: a.id, action: 'auth.login', result: 'ok', ip: meta.ip, ua: meta.ua });
    return { ok: true, token, expiresAt: a.sessions[a.sessions.length - 1].expiresAt, account: AuthStore.publicView(a) };
  }

  /** 校验 token。返回账号（已过停用/锁定/过期检查），或 null */
  authenticate(token) {
    if (!token) return null;
    const h = sha256(String(token));
    const now = Date.now();
    for (const a of this.data.accounts) {
      const s = (a.sessions ?? []).find((x) => x.hash === h);
      if (!s) continue;
      if (new Date(s.expiresAt).getTime() <= now) return null;
      if (a.status !== 'active') return null;
      if (a.lockedUntil && new Date(a.lockedUntil).getTime() > now) return null;
      return a;
    }
    return null;
  }

  // ───────────────────────── 长期 API token（PAT，P10.0 S2）─────────────────────────
  //
  // 为什么需要它：MCP 客户端是**机器**，不能拿"人登录一次得到的 12 小时会话"当凭据。
  // 目标形态是长期 token（类 GitHub PAT）：高熵、明文只在创建时出现一次、只落哈希、
  // 可撤销；权限**仍由账号的 role 决定**（token 只是"同一个账号的另一种凭据"，
  // 不是新身份、不引入第二套角色）。
  //
  // 为什么用 sha256 而不是 scrypt：token 是 32 字节随机值（256 bit 熵），
  // 不存在"弱口令可爆破"的问题，摘要足够；且会话 token 本来就是这么存的
  // —— 复用同一条既有实现，**不新造密码学方案**（P10.0 S2 红线）。
  //
  // 明文 token 只在 createToken 的返回值里出现一次；落盘、审计、日志、listTokens
  // 与 publicView（白名单）里都**不含**它。publicView 是显式白名单 ⇒ tokens 天然不外泄。

  /**
   * 创建长期 token（绑定到 accountId）。
   * @returns {{ok:true, token:string, record:{id,label,createdAt}}} 明文 token 只此一次
   */
  createToken(accountId, { label = '', actor = null } = {}) {
    const a = this.findById(accountId);
    if (!a) return { ok: false, error: 'ACCOUNT_NOT_FOUND' };
    const token = randomBytes(32).toString('base64url');
    const rec = {
      id: `pat_${randomBytes(4).toString('hex')}`,
      hash: sha256(token), // ← 落盘的只有哈希
      label: String(label ?? '').slice(0, 64),
      createdAt: new Date().toISOString(),
      createdBy: actor ?? accountId,
    };
    a.tokens = [...(a.tokens ?? []), rec];
    this.#save();
    this.audit({ actor: actor ?? accountId, action: 'account.createToken', target: accountId, tokenId: rec.id, label: rec.label });
    return { ok: true, token, record: { id: rec.id, label: rec.label, createdAt: rec.createdAt } };
  }

  /**
   * 校验**长期** token。返回账号（已过停用/锁定检查），或 null。
   * 只看 tokens，不看 sessions —— 会话 token 走 authenticate()，两条路径各自独立、可单独收紧。
   */
  authenticateToken(token) {
    if (!token) return null;
    const h = sha256(String(token));
    const now = Date.now();
    for (const a of this.data.accounts) {
      const t = (a.tokens ?? []).find((x) => x.hash === h);
      if (!t) continue;
      if (a.status !== 'active') return null;
      if (a.lockedUntil && new Date(a.lockedUntil).getTime() > now) return null;
      return a;
    }
    return null;
  }

  /** 列出某账号的长期 token（只回短 id 与标签，**永不含哈希**）。 */
  listTokens(accountId) {
    const a = this.findById(accountId);
    if (!a) return { ok: false, error: 'ACCOUNT_NOT_FOUND' };
    const tokens = (a.tokens ?? []).map((t) => ({
      id: t.id,
      label: t.label ?? '',
      createdAt: t.createdAt,
      createdBy: t.createdBy ?? null,
    }));
    return { ok: true, tokens };
  }

  /** 撤销长期 token（按完整 id 或短前缀匹配，与会话撤销同口径）。撤 0 条不是错误，但要如实报。 */
  revokeToken(accountId, tokenId, actor = null) {
    const a = this.findById(accountId);
    if (!a) return { ok: false, error: 'ACCOUNT_NOT_FOUND' };
    const id = String(tokenId ?? '').trim();
    if (!id) return { ok: false, error: 'TOKEN_ID_REQUIRED' };
    const before = (a.tokens ?? []).length;
    a.tokens = (a.tokens ?? []).filter((t) => !t.id.startsWith(id));
    const removed = before - a.tokens.length;
    if (removed > 0) this.#save();
    this.audit({ actor, action: 'account.revokeToken', target: accountId, tokenId: id, result: removed > 0 ? 'ok' : 'no_token' });
    return { ok: true, removed };
  }

  logout(token, actor = null) {
    if (!token) return { ok: true };
    const h = sha256(String(token));
    let hit = false;
    for (const a of this.data.accounts) {
      const before = (a.sessions ?? []).length;
      a.sessions = (a.sessions ?? []).filter((x) => x.hash !== h);
      if (a.sessions.length !== before) hit = true;
    }
    if (hit) this.#save();
    this.audit({ actor, action: 'auth.logout', result: hit ? 'ok' : 'no_session' });
    return { ok: true };
  }

  sessionCount(id) {
    const a = this.findById(id);
    if (!a) return 0;
    const now = Date.now();
    return (a.sessions ?? []).filter((s) => new Date(s.expiresAt).getTime() > now).length;
  }

  // ───────────────────────── 会话管理（管理员轮换） ─────────────────────────
  //
  // 为什么管理员需要能"踢下线"而不只是等 TTL：账号被怀疑泄露（丢了笔记本 /
  // token 曾贴进过错误的窗口）时，等待自然过期是在赌博。改密与停用虽然也会
  // 清会话，但那两个动作各有副作用；"只清会话、账号照常"是独立的运维动作。

  /**
   * 查看指定账号的活跃会话。
   * 哈希只回**前 8 位**做短 ID（够管理员辨认"哪条是我刚踢的"），
   * 全文不给 —— 审计日志会到处走，落全文等于把哈希当明文管。
   */
  listSessions(id) {
    const a = this.findById(id);
    if (!a) return { ok: false, error: 'ACCOUNT_NOT_FOUND' };
    const now = Date.now();
    const sessions = (a.sessions ?? [])
      .filter((s) => new Date(s.expiresAt).getTime() > now)
      .map((s) => ({
        id: s.hash.slice(0, 8),
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        ip: s.ip ?? '',
        ua: s.ua ?? '',
      }));
    return { ok: true, sessions, active: sessions.length };
  }

  /** 撤销指定会话（按短 ID 前缀匹配）。返回实际撤销条数 —— 撤 0 条不是错误，但要如实报 */
  revokeSession(id, sessionId, actor = null) {
    const a = this.findById(id);
    if (!a) return { ok: false, error: 'ACCOUNT_NOT_FOUND' };
    const sid = String(sessionId ?? '').trim();
    if (!sid) return { ok: false, error: 'SESSION_ID_REQUIRED' };
    const before = (a.sessions ?? []).length;
    a.sessions = (a.sessions ?? []).filter((s) => !s.hash.startsWith(sid));
    const removed = before - a.sessions.length;
    if (removed > 0) this.#save();
    this.audit({ actor, action: 'account.revokeSession', target: id, sessionId: sid, result: removed > 0 ? 'ok' : 'no_session' });
    return { ok: true, removed };
  }

  /** 撤销全部会话（踢下线）。audit 留痕 —— 这是运营动作，出事时必须能查到是谁按的 */
  revokeAllSessions(id, actor = null) {
    const a = this.findById(id);
    if (!a) return { ok: false, error: 'ACCOUNT_NOT_FOUND' };
    const removed = (a.sessions ?? []).length;
    if (removed > 0) {
      a.sessions = [];
      this.#save();
    }
    this.audit({ actor, action: 'account.revokeAllSessions', target: id, removed, result: 'ok' });
    return { ok: true, removed };
  }

  // ───────────────────────── 额度与用量 ─────────────────────────

  /**
   * 额度检查 —— 在**发起 AI 调用之前**执行，不是事后统计。
   *
   * @param opts.generation true = 这次算一次"生成"（计每日生成次数）；
   *                        对话通道传 false —— 提问不该吃掉生成额度。
   */
  checkQuota(id, opts = {}) {
    const a = this.findById(id);
    if (!a) return { ok: false, error: '账号不存在', code: 'ACCOUNT_NOT_FOUND' };
    const r = evalQuota(a.plan, a.usage, { counts: opts.generation === true });
    return { ok: r.ok, error: r.error, code: r.code, plan: planOf(a.plan), view: r.view, used: r.used };
  }

  /** 额度检查之模型白名单 —— 空数组 = 不限制 */
  checkModel(id, model) {
    const a = this.findById(id);
    const plan = planOf(a?.plan ?? 'free');
    if (!plan.models || plan.models.length === 0) return { ok: true };
    return plan.models.includes(model)
      ? { ok: true }
      : { ok: false, error: `当前档位不允许调用模型 "${model}"（允许：${plan.models.join('、')}）`, code: 'MODEL_NOT_ALLOWED' };
  }

  /**
   * 记一次调用。
   *
   * provider 返回的 usage 可能缺字段、可能是 0、也可能整段没有 ——
   * 所以宁可少记也不要编造：缺 token 数时按 0 记，并把 calls 记上，
   * 界面上如实显示"本次未返回用量"。凭空估一个数字会让账单不可信。
   */
  recordUsage(id, { promptTokens = 0, completionTokens = 0, model = '', ok = true, ms = 0, note = '', generation = false }) {
    const a = this.findById(id);
    if (!a) return;
    const u = applyUsage(a.usage, { tokens: promptTokens + completionTokens, generation });
    a.usage = { ...u, lastAt: new Date().toISOString(), lastModel: model, lastMs: ms, lastOk: ok };
    this.#save();
    this.audit({ actor: id, action: 'ai.call', model, ok, ms, promptTokens, completionTokens, note: String(note).slice(0, 120) });
  }
}

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * 口令强度。
 *
 * 有意**不**要求"必须含大写+符号"这种规则 —— 它会把人逼成 `Password1!`
 * 这种又难记又好猜的东西。要求的是**长度**与**不在常见弱口令里**。
 * 这是 NIST SP 800-63B 的路子，也是实际更安全的做法。
 */
const WEAK = new Set([
  'password', '123456', '12345678', '123456789', 'qwerty', 'abc123', '111111', '000000',
  'iloveyou', 'admin', 'root', 'letmein', 'welcome', 'monkey', 'dragon', 'master',
  'password1', 'qwerty123', 'admin123', '1234567890', 'passw0rd', 'p@ssw0rd',
]);
export function checkPasswordStrength(pw) {
  const s = String(pw ?? '');
  if (s.length < 8) return '口令至少 8 位';
  if (s.length > 200) return '口令过长';
  if (/^\d+$/.test(s)) return '口令不能是纯数字';
  if (WEAK.has(s.toLowerCase())) return '这个口令在常见弱口令表里，换一个';
  if (/^(.)\1+$/.test(s)) return '口令不能是同一个字符重复';
  if (/^(0123|1234|2345|3456|4567|5678|6789|abcd|bcde|cdef)/i.test(s)) return '口令不能是连续序列';
  return null;
}

/** 安全现状自述 —— 界面上要**照实**显示，包括现在还差什么 */
export function securityPolicy({ mode, accountsPath, auditPath, host }) {
  return {
    mode,
    host,
    accountsPath,
    auditPath,
    sessionTtlHours: SESSION_TTL_MS / 3600000,
    login: { windowMinutes: LOGIN_WINDOW_MS / 60000, maxFails: LOGIN_MAX_FAILS, lockMinutes: LOCK_MS / 60000 },
    passwordHashing: `scrypt（Node 内建；参数写进哈希串里：${encodeHash('<salt>', '<hash>', SCRYPT_PARAMS)}，每账号 16 字节随机盐，比较用 timingSafeEqual）`,
    sessionStorage: '只落 SHA-256 哈希；明文 token 只在登录响应里出现一次',
    transport: host === '127.0.0.1' ? '仅本机回环，未出网' : '⚠ 已监听非回环地址但没有 TLS',
    tenantIsolation: '按 tenantId 隔离业务数据（当前只有一个租户，字段已就位）',
    implemented: [
      '口令哈希 + 独立盐 + 定时安全比较',
      '会话 token 只存哈希，支持过期与停用即踢下线',
      '失败登录计数与锁定窗口',
      '角色（owner/admin/designer/viewer）与最小权限判定',
      'AI 调用额度（按周期 token + 每日生成次数，任一用尽即止）与模型白名单',
      '邮箱验证码注册：验证码只落哈希、10 分钟过期、限次限频（SMTP / 落盘两种发信模式）',
      '管理操作与 AI 调用全量审计（actor / action / target / ip / 时间）',
      '长期 API token（PAT）：高熵、明文只出现一次、只落哈希、可撤销；权限沿用账号角色（P10.0 S2）',
      '账号库/工作区 JSON 写入经进程内串行写队列，同进程内并发写不再互相覆盖（P10.0 S1）',
      '账号库损坏时**拒绝启动**，不降级为无账号模式',
    ],
    notImplemented: [
      '⚠ 没有 HTTPS —— 上线必须由反向代理终止 TLS，本服务本身不做',
      '⚠ 会话不会轮换（refresh），但已支持单条撤销（account.revokeSession）与整账号踢下线（revokeAllSessions）',
      '⚠ 没有二次验证（邮件/短信/TOTP），口令是唯一凭据',
      // 这句话里必须同时留着「并发写保护」这个词：verify:ui 的 B18 断言认定
      // 「上线前必须补的几件大事」里要**点名**这个风险（不是放宽测试，是让文案继续点名）。
      // P10.0 S1 之后风险面收窄（同进程已串行化），但跨进程/多实例依旧不成立 —— 措辞要跟着走，关键词不能丢。
      '⚠ 账号库是本地 JSON 文件：同进程内写入已串行化（P10.0 S1），但跨进程/多实例仍缺少并发写保护，会互相覆盖',
      '⚠ 没有密码找回流程，忘记口令只能由管理员重置',
      '⚠ 审计日志无防篡改（没有链式哈希或外部归档），且与账号库同机',
      '⚠ 上传/模型文件没有按账号隔离配额',
    ],
  };
}
