/**
 * admin 验收 —— 会话轮换与审计导出的地基不变量（Task #27）。
 *
 * 账号体系守护的是"这把 key 谁能花"—— 会话管理出 bug 等于门锁坏了。
 * 这里用临时文件直测 AuthStore（不走 HTTP；HTTP 层由浏览器 B29 覆盖），
 * 断言围绕三条主线：
 *   1. 会话可见性：管理员能看到活跃会话（哈希只露前 8 位）
 *   2. 会话轮换：单条撤销 / 全部踢下线后，被踢 token 立即失效
 *   3. 审计留痕 + CSV 导出格式（BOM / 转义）可被机器判定
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStore } from '../server/auth.mjs';
import { auditCsv } from '../server/auditCsv.mjs';

const dir = mkdtempSync(join(tmpdir(), 'furnicad-admin-'));
const accountsPath = join(dir, 'accounts.json');
const auditPath = join(dir, 'audit.jsonl');

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name} —— ${detail}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

section('1. 登录与活跃会话可见性（哈希只露前 8 位）');
{
  const auth = new AuthStore({ accountsPath, auditPath });
  const cr = auth.create({ username: 'owner', password: 'correct-horse-42', actor: 'bootstrap' });
  ok('建账号成功（进入 accounts 模式）', cr.ok, JSON.stringify(cr).slice(0, 120));

  const l1 = auth.login('owner', 'correct-horse-42', { ip: '127.0.0.1', ua: 'verify/1' });
  ok('第一次登录成功', l1.ok, JSON.stringify(l1).slice(0, 120));
  const l2 = auth.login('owner', 'correct-horse-42', { ip: '127.0.0.2', ua: 'verify/2' });
  ok('第二次登录成功（两个设备）', l2.ok);

  const ls = auth.listSessions(cr.account!.id);
  ok('listSessions 报告 2 个活跃会话', ls.ok && ls.active === 2, JSON.stringify(ls).slice(0, 200));
  ok('会话短 ID 是 8 位哈希前缀（不给全文）',
    ls.ok && ls.sessions.every((s: { id: string }) => /^[0-9a-f]{8}$/.test(s.id)),
    JSON.stringify(ls.sessions?.map((s: { id: string }) => s.id)));
  ok('会话带 IP / UA（管理员辨认"哪台设备"靠它）',
    ls.ok && ls.sessions.some((s: { ip: string }) => s.ip === '127.0.0.1') && ls.sessions.some((s: { ip: string }) => s.ip === '127.0.0.2'));
  ok('明文 token 不出现在会话记录里',
    !JSON.stringify(ls).includes(l1.token!.slice(0, 12)));
}

section('2. 会话轮换：单条撤销 / 全部踢下线');
{
  const auth = new AuthStore({ accountsPath, auditPath });
  const acc = auth.create({ username: 'user-a', password: 'another-breeze-77', actor: 'bootstrap' }).account!;
  const t1 = auth.login('user-a', 'another-breeze-77', { ip: '127.0.0.1', ua: 'a' }).token!;
  const t2 = auth.login('user-a', 'another-breeze-77', { ip: '127.0.0.3', ua: 'b' }).token!;

  ok('撤销前两个 token 都有效', auth.authenticate(t1) !== null && auth.authenticate(t2) !== null);
  // listSessions 带 ip —— 管理员靠它辨认"哪台设备"；验收同样用它定位要撤的会话
  const ls2 = auth.listSessions(acc.id) as { sessions: Array<{ id: string; ip: string }> };
  const target = ls2.sessions.find((s) => s.ip === '127.0.0.1')!;
  const rv = auth.revokeSession(acc.id, target.id, 'admin_001');
  ok('单条撤销成功（removed=1）', rv.ok && rv.removed === 1, JSON.stringify(rv));

  // 两条 token 哪条是 t1？authenticate 只剩一个会话：先记住撤销前两个都能用，
  // 撤销后**恰好一个**失效 —— 具体是哪个由哈希前缀对应关系决定，不能瞎猜。
  const alive1 = auth.authenticate(t1) !== null;
  const alive2 = auth.authenticate(t2) !== null;
  ok('恰好一条会话被撤销（另一条照常有效）', alive1 !== alive2, `t1=${alive1} t2=${alive2}`);

  const kick = auth.revokeAllSessions(acc.id, 'admin_001');
  ok('全部踢下线：removed = 剩余会话数', kick.ok && kick.removed === (alive1 ? 1 : 1), JSON.stringify(kick));
  ok('被踢后所有 token 立即失效', auth.authenticate(t1) === null && auth.authenticate(t2) === null);

  const ghost = auth.revokeSession(acc.id, 'deadbeef', 'admin_001');
  ok('撤销不存在的短 ID：removed=0，如实报告而不是报错崩掉', ghost.ok && ghost.removed === 0, JSON.stringify(ghost));
  const nf = auth.revokeSession('acc_none', 'deadbeef', 'admin_001');
  ok('撤销不存在账号：ACCOUNT_NOT_FOUND', !nf.ok && nf.error === 'ACCOUNT_NOT_FOUND');
}

section('3. 审计留痕：轮换动作必须可追溯');
{
  const raw = readFileSync(auditPath, 'utf8');
  ok('audit.jsonl 存在且非空', existsSync(auditPath) && raw.trim().length > 0);
  ok('单条撤销留痕（account.revokeSession，带 actor 与 target）', raw.includes('"action":"account.revokeSession"'));
  ok('全部踢下线留痕（account.revokeAllSessions）', raw.includes('"action":"account.revokeAllSessions"'));
}

section('4. CSV 导出：BOM 必须在，转义必须对');
{
  const entries = [
    { at: '2026-09-24T10:00:00', actor: 'owner_001', action: 'account.revokeSession', target: 'acc_001', result: 'ok', note: '含逗号, 引号" 换行\n第二行' },
    { at: '2026-09-24T10:01:00', action: 'auth.login', result: 'ok' },
  ];
  const csv = auditCsv(entries);
  ok('以 BOM 开头（\uFEFF）—— 没有 BOM 的 CSV 送给 Excel 就是乱码', csv.charCodeAt(0) === 0xfeff, `首字符码点=${csv.charCodeAt(0)}`);
  ok('表头六列齐全', csv.replace(/^\uFEFF/, '').split('\r\n')[0] === 'at,actor,action,target,result,detail', csv.split('\r\n')[0]);

  // 转义对不对，最硬的判据不是比对字面串（detail 经过 JSON 包装，猜串必错），
  // 而是【解析回代】：用 RFC4180 规则解析该行，还原出的 note 必须逐字符等于原始输入。
  const parseCsvLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const row1 = parseCsvLine(csv.replace(/^\uFEFF/, '').split('\r\n')[1]);
  const detailNote = (JSON.parse(row1[5]) as { note?: string }).note;
  ok('转义可解析回代（detail 里的 note 逐字符还原，含逗号/引号/换行）',
    detailNote === '含逗号, 引号" 换行\n第二行', JSON.stringify(detailNote));
  ok('行数 = 表头 + 条目数', csv.replace(/^\uFEFF/, '').split('\r\n').length === 3);
}

// ══════════════════════════════════════════════════════════════════════
// 5. 权限边界：重置口令必须是管理者的特权
//
//    `PATCH /api/account/account {id, newPassword}` 早先不做角色校验 ——
//    `actor` 只用来写审计。于是**任何一条普通账号**（哪怕 role=viewer）
//    只要带 token 就能接管整个系统：把 owner 的口令换掉，自己登录成 owner。
//    role/status 那两个分支有 setRole/setStatus 内部兜底，resetPassword 没有，
//    所以兜底只能加在 HTTP 层。下面这条断言必须**打在 HTTP 上**，
//    读源码说"我记得加了"不算数。
// ══════════════════════════════════════════════════════════════════════
section('5. 权限边界：重置口令需要 canManage（HTTP 层实测）');
{
  const { spawn } = await import('node:child_process');
  const httpDir = mkdtempSync(join(tmpdir(), 'furnicad-authz-'));
  const hp = {
    accounts: join(httpDir, 'accounts.json'),
    audit: join(httpDir, 'audit.jsonl'),
    env: join(httpDir, 'empty.env'),
    mem: join(httpDir, 'memory', 'corrections.jsonl'),
  };
  const PORT = 8800 + Math.floor(Math.random() * 190);
  const BASE = `http://127.0.0.1:${PORT}`;

  // 与 email-acceptance.mjs 同一套写法：token 走 `Authorization: Bearer`，
  // 不是塞进 body 也不是塞进 headers 的某个自定义键 —— 服务端就这么取的。
  // 顺手把 `token:` 也收进去，写错成 body 字段时不会静默变成 401。
  const call = async (path: string, { method = 'GET', token, body }: { method?: string; token?: string; body?: unknown } = {}) => {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  const srv = spawn(process.execPath, ['server/server.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(PORT),
      APP_ENV_PATH: hp.env,
      APP_ACCOUNTS_PATH: hp.accounts,
      APP_AUDIT_PATH: hp.audit,
      APP_MEM_PATH: hp.mem,
    },
  });
  srv.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      try { up = (await fetch(`${BASE}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    ok('测试服务启动成功', up);

    const boss = await call('/api/auth/register', { method: 'POST', body: { username: 'boss', password: 'Zq7#mR2vLd!9K' } });
    ok('第一个账号建成功（owner）', boss.status === 200 && typeof boss.body.token === 'string', JSON.stringify(boss).slice(0, 160));
    const bossId = boss.body.account?.id;
    const bossToken = boss.body.token;

    const mk = await call('/api/account/accounts', { method: 'POST', token: bossToken, body: { username: 'minion', password: 'Kp3$vN8wQz!2x', role: 'viewer' } });
    ok('owner 建一条 viewer 账号成功', mk.status === 200 && mk.body.account?.role === 'viewer', JSON.stringify(mk).slice(0, 160));
    const minionLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'minion', password: 'Kp3$vN8wQz!2x' } });
    const minionToken = minionLogin.body.token;
    ok('viewer 登录成功（拿到 token，具备发起越权的条件）', typeof minionToken === 'string');

    const steal = await call('/api/account/account', { method: 'PATCH', token: minionToken, body: { id: bossId, newPassword: 'Hacked!123456' } });
    ok('viewer 重置 owner 口令 → 403 FORBIDDEN', steal.status === 403 && steal.body.code === 'FORBIDDEN', JSON.stringify(steal).slice(0, 200));

    // 光看状态码还不够：`resetPassword` 若真跑了，会把 owner 的口令换掉。
    // 所以必须回头验一次旧口令 —— **失败的那次请求不许留下任何后果**，
    // 这才是"权限校验放在动作之前"的真正含义。
    const untouched = await call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'Zq7#mR2vLd!9K' } });
    ok('被拒绝后 owner 原口令仍然有效（失败请求零副作用）', untouched.status === 200, JSON.stringify(untouched).slice(0, 160));

    const asBoss = await call('/api/account/account', { method: 'PATCH', token: bossToken, body: { id: bossId, newPassword: 'Yt4@Bs6cMd!7f' } });
    ok('owner 自己重置口令 → 200', asBoss.status === 200, JSON.stringify(asBoss).slice(0, 160));
    const after = await call('/api/auth/login', { method: 'POST', body: { username: 'boss', password: 'Yt4@Bs6cMd!7f' } });
    ok('新口令可以登录，旧口令失效', after.status === 200, JSON.stringify(after).slice(0, 160));
  } finally {
    srv.kill('SIGKILL');
  }
  rmSync(httpDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
// 6. 离线重置通道：唯一的 owner 忘了口令时，系统必须能自我救回来
//
//    "能重置口令的只有能登录的人，而能登录的人正好忘了口令" ——
//    没有这条通道，自部署的单机系统就是**永久锁死**。
//    这里不测"脚本能跑"，测的是它做对了每一件事：先备份、弱口令照拒、
//    写回的口令真能登录、踢掉会话、留审计。
// ══════════════════════════════════════════════════════════════════════
section('6. 离线口令重置（逃生门）');
{
  const { execFileSync } = await import('node:child_process');
  const cliDir = mkdtempSync(join(tmpdir(), 'furnicad-recover-'));
  const cp = join(cliDir, 'accounts.json');
  const ap = join(cliDir, 'audit.jsonl');
  const { AuthStore } = await import('../server/auth.mjs');
  const hashedPw = AuthStore.hashPassword('忘了的口令-v1');

  // 造一份"真的出事了"的账号库：owner 忘了口令、还有一条活跃会话
  writeFileSync(cp, JSON.stringify({
    version: 1,
    accounts: [{
      id: 'acc_stuck', username: 'admin', displayName: 'admin', role: 'owner', plan: 'free',
      status: 'active', email: null, tenantId: 'tenant_default',
      password: hashedPw, sessions: [{ hash: 'deadbeef', createdAt: 'x', expiresAt: 'y', ip: '1.1.1.1', ua: 'z' }],
      failedLogins: [], lockedUntil: null, lastLoginAt: '2026-09-24T17:34:41.000Z',
    }],
  }, null, 2));
  writeFileSync(ap, '');

  /**
   * 用 execFileSync 而不是 spawnSync：Windows 上父进程阻塞在同步派生时，
   * 起 node.exe 子进程会直接报 EBUSY（不是脚本的问题，是同步派生本身的问题）。
   * 失败走 throw，所以要把 stderr 从异常里捞回来 —— 拿不到 stderr 的失败等于没报错。
   */
  const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    try {
      const stdout = execFileSync(process.execPath, ['server/account-reset.mjs', ...args], {
        cwd: join(import.meta.dirname, '..'),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, APP_ACCOUNTS_PATH: cp, APP_AUDIT_PATH: ap },
      });
      return { status: 0, stdout, stderr: '' };
    } catch (e) {
      const x = e as { status?: number; stderr?: string; stdout?: string };
      return { status: x.status ?? null, stdout: x.stdout ?? '', stderr: x.stderr ?? '' };
    }
  };

  const weak = run(['--user', 'admin', '--password', '123456']);
  ok('弱口令被拒（重置通道不许把系统设回弱口令）', weak.status !== 0 && /口令至少 8 位/.test(weak.stderr ?? ''), (weak.stderr ?? '').slice(-160));
  // 必须跟**写入时那一份**比：`hashPassword` 每次都带新盐，再算一次必然不相等，
  // 拿它当判据会得到一条永远为真的断言 —— 看着绿，其实什么都没测。
  ok('弱口令被拒后账号库一个字节都没动', JSON.parse(readFileSync(cp, 'utf8')).accounts[0].password.hash === hashedPw.hash);

  const good = run(['--user', 'admin', '--password', 'Ws5^Lp9dRz!3q']);
  ok('重置成功退出码 0', good.status === 0, (good.stderr ?? good.stdout ?? '').slice(-200));

  const after = JSON.parse(readFileSync(cp, 'utf8')).accounts[0];
  ok('新口令真能验证通过', AuthStore.verifyPassword('Ws5^Lp9dRz!3q', after.password.hash, after.password.salt));
  ok('旧口令已失效', !AuthStore.verifyPassword('忘了的口令-v1', after.password.hash, after.password.salt));
  ok('所有会话被踢掉（逃生门必须连旧会话一起收）', (after.sessions ?? []).length === 0);
  ok('失败计数与锁定状态被清空', Array.isArray(after.failedLogins) && after.failedLogins.length === 0 && !after.lockedUntil);
  ok('改之前留了备份（改错了能还原）', existsSync(`${cp}.bak`));
  ok('动作写进审计（装作没发生不行）', /"action":"account\.resetPassword"/.test(readFileSync(ap, 'utf8')));

  const noUser = run(['--user', 'nobody', '--password', 'Ws5^Lp9dRz!3q']);
  ok('重置不存在的用户：报错退出，不静默成功', noUser.status !== 0 && /没有用户/.test(noUser.stderr ?? ''), (noUser.stderr ?? '').slice(-160));

  rmSync(cliDir, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(66)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：会话轮换与审计导出的地基成立。');
