/**
 * ══════════════════════════════════════════════════════════════════════
 *  离线口令重置 —— 自部署系统的逃生门
 *
 *  为什么必须有这个东西：
 *    系统只有一个 owner 账号、自助注册已关闭、没有邮箱找回，
 *    那 owner 一旦忘记口令，这台机器上**没有人能把他救回来** ——
 *    能重置口令的只有能登录的人，而能登录的人正好忘了口令。
 *    这不是"少见"的情况，是自己部署的单机系统里几乎必然会遇到的一次卡死。
 *
 *  它绕过服务、直接改账号库文件，因此：
 *    · 必须在**服务停止**时跑（跑的时候改文件，服务会把旧内容读回去覆盖）
 *    · 会先备份原文件（accounts.json.bak），改错了能还原
 *    · 强制走 checkPasswordStrength，防止顺手设回一个弱口令
 *    · 动作写进 audit.jsonl，装作什么都没发生是不行的
 *
 *  用法（服务停掉再跑）：
 *    npm run account:reset -- --user admin --password '新口令'
 *    npm run account:reset -- --list
 *    APP_ACCOUNTS_PATH=/path/to/accounts.json npm run account:reset -- --user admin -p 'x'
 * ══════════════════════════════════════════════════════════════════════
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync, appendFileSync, renameSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthStore, checkPasswordStrength } from './auth.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const accountsPath = process.env.APP_ACCOUNTS_PATH ? resolve(process.env.APP_ACCOUNTS_PATH) : join(ROOT, 'memory', 'accounts.json');
const auditPath = process.env.APP_AUDIT_PATH ? resolve(process.env.APP_AUDIT_PATH) : join(ROOT, 'memory', 'audit.jsonl');

const argv = process.argv.slice(2);
const flag = (name, short) => {
  const i = argv.findIndex((a) => a === `--${name}` || a === `-${short}`);
  if (i < 0) return null;
  return argv[i + 1] ?? null;
};
const has = (name) => argv.includes(`--${name}`);

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};

/** 读账号库。损坏就拒绝，绝不降级成"没有账号" —— 那等于悄悄关掉账号模式 */
function loadAccounts() {
  if (!existsSync(accountsPath)) {
    die(`找不到账号库 ${accountsPath}。\n  这个路径不是它 —— 线上部署的可能挂在别处，用 APP_ACCOUNTS_PATH 指过去再试。`);
  }
  return JSON.parse(readFileSync(accountsPath, 'utf8'));
}

if (has('help') || argv.length === 0) {
  console.log(`
离线口令重置

  npm run account:reset -- --list
      列出账号库里有哪些账号（只读）

  npm run account:reset -- --user <用户名> --password <新口令>
      重置口令。会踢掉该账号所有会话、清空失败计数、先备份再改。

     --password 也可以写 -p；从终端不放心的话走环境变量：
       RESET_PASSWORD='xxx' npm run account:reset -- --user admin

  ⚠ 跑之前先停掉服务 —— 服务正在运行的话会把它读回去的旧内容覆盖回来。

  账号库路径可用 APP_ACCOUNTS_PATH / APP_AUDIT_PATH 覆盖，
  与 server.mjs 用的是同一对变量，指错地方会直接报找不到文件。
`);
  process.exit(0);
}

// ─────────────────────────── 列出账号 ───────────────────────────

if (has('list')) {
  const d = loadAccounts();
  const list = d.accounts ?? [];
  if (list.length === 0) {
    console.log(`\n账号库 ${accountsPath} 里没有任何账号 —— 当前处于 local-open 模式，\
接口免登录。这时还不需要重置口令。\n`);
    process.exit(0);
  }
  console.log(`\n账号库 ${accountsPath} 里共 ${list.length} 个账号：\n`);
  for (const a of list) {
    const sess = (a.sessions ?? []).length;
    const lock = a.lockedUntil && new Date(a.lockedUntil).getTime() > Date.now() ? ` 🔒锁定到 ${a.lockedUntil}` : '';
    console.log(
      `  ${a.username.padEnd(16)} id=${String(a.id).padEnd(18)} role=${String(a.role).padEnd(10)}` +
        ` status=${a.status}${lock}  会话 ${sess} 条  最后登录 ${a.lastLoginAt ?? '—'}`
    );
  }
  console.log('');
  process.exit(0);
}

// ─────────────────────────── 重置口令 ───────────────────────────

const user = flag('user');
const pw = flag('password', 'p') ?? (process.env.RESET_PASSWORD ? '' : null);

if (!user) die(`缺少 --user <用户名>`);
const password = pw ?? process.env.RESET_PASSWORD;
if (!password) die(`缺少 --password <新口令>（或环境变量 RESET_PASSWORD）`);

const data = loadAccounts();
const acc = (data.accounts ?? []).find((a) => a.username === user);
if (!acc) {
  const names = (data.accounts ?? []).map((a) => a.username).join('、') || '（空）';
  die(`账号库里没有用户 "${user}"。现有账号：${names}`);
}

const pwErr = checkPasswordStrength(password);
if (pwErr) die(`新口令不合规：${pwErr}\n  重置口令同样要过 strength 检查，别把系统设回一个弱口令。`);

console.log(`\n  账号    ${acc.username}（${acc.id}，${acc.role}）`);
console.log(`  文件    ${accountsPath}`);
console.log(`  会话    ${(acc.sessions ?? []).length} 条 → 全部踢掉`);

const bak = `${accountsPath}.bak`;
copyFileSync(accountsPath, bak);
console.log(`  备份    ${bak}`);

/** 原子替换：先写 .tmp 再 rename，中途被打断也不会留一个半截的账号库 */
acc.password = AuthStore.hashPassword(password);
acc.sessions = [];
acc.failedLogins = [];
acc.lockedUntil = null;
acc.lastLoginAt = new Date().toISOString();

const tmp = `${accountsPath}.tmp`;
writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
renameSync(tmp, accountsPath);

appendFileSync(
  auditPath,
  `${JSON.stringify({
    ts: new Date().toISOString(),
    actor: 'offline-cli',
    action: 'account.resetPassword',
    target: acc.id,
    username: acc.username,
    via: 'account-reset.mjs',
    note: '服务停止后由离线脚本直改账号库（忘记口令时的唯一逃生门）',
  })}\n`
);

console.log(`\n  ✓ 口令已重置，所有会话已失效。`);
console.log(`    现在可以用新口令重新登录了。`);
console.log(`    换一台设备/换过 IP 的旧登录会被踢掉，重新登录即可。\n`);
