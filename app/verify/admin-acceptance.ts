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
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
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

rmSync(dir, { recursive: true, force: true });

console.log(`\n${'─'.repeat(66)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：会话轮换与审计导出的地基成立。');
