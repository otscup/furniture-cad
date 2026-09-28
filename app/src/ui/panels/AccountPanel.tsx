import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api, loadToken, saveToken, type AuthAccount } from '../../ai/aiClient.ts';
import type { PlanOption } from '../../ai/quotaTypes.ts';
import { planOptionLabel, QuotaMeter } from '../QuotaMeter.tsx';
import { Pill, Row, Section, Text } from './common.tsx';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  账号与安全
 *
 *  ── 这个面板的写法和别处不一样：它把"还没做到的事"也列出来 ──
 *    安全能力清单分两栏：「已实现」与「尚未实现」。
 *    后者包含 HTTPS、二次验证、会话轮换、账号库并发写保护、审计防篡改……
 *    一个只显示"我们有登录框"的界面是在骗人。把缺口摆出来，
 *    才知道上线之前必须补什么 —— 这也是"后续商用要保证账号安全"的落地方式：
 *    不是现在假装安全，而是把差距写在界面上。
 *
 *  ── 两种模式 ──
 *    local-open  还没有账号。此时全部接口免登录 —— 不显示登录框，显示"建立第一个账号"。
 *    accounts    已建账号。除登录注册外一切要求 token。**这个切换不可回退**。
 * ══════════════════════════════════════════════════════════════════════
 */

interface Policy {
  mode: string;
  host: string;
  accountsPath: string;
  auditPath: string;
  sessionTtlHours: number;
  login: { windowMinutes: number; maxFails: number; lockMinutes: number };
  passwordHashing: string;
  sessionStorage: string;
  transport: string;
  tenantIsolation: string;
  implemented: string[];
  notImplemented: string[];
  apiKeyMasked: string;
  apiKeyLocation: string;
}

interface AuditEntry {
  at: string;
  actor?: string | null;
  action?: string;
  result?: string;
  target?: string;
  model?: string;
  ip?: string;
  [k: string]: unknown;
}

export function AccountPanel(props: {
  token: string | null;
  setToken: (t: string | null) => void;
  onToast?: (kind: 'ok' | 'info' | 'warn' | 'error', text: string) => void;
  /** 统一的登出入口（见 App.tsx 的 doLogout） */
  onLogout: () => void;
}): ReactNode {
  const [online, setOnline] = useState<'checking' | 'online' | 'offline'>('checking');
  const [mode, setMode] = useState<'local-open' | 'accounts' | null>(null);
  /** 管理员是否开放了邮箱自助注册（/api/auth/mode 的 signupOpen；local-open 时天然可注册） */
  const [signupOpen, setSignupOpen] = useState(false);
  const [me, setMe] = useState<AuthAccount | null>(null);
  const [permissions, setPermissions] = useState<{ canManage?: boolean; canDesign?: boolean; canView?: boolean } | null>(null);
  const [sessions, setSessions] = useState(0);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [accounts, setAccounts] = useState<AuthAccount[]>([]);
  const [roles, setRoles] = useState<Array<{ id: string; label: string }>>([]);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  // 表单
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [p2, setP2] = useState('');
  const [curP, setCurP] = useState('');
  const [newP, setNewP] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [newUserPw, setNewUserPw] = useState('');
  const [newUserRole, setNewUserRole] = useState('designer');

  // 邮箱注册表单
  const [regEmail, setRegEmail] = useState('');
  const [regCode, setRegCode] = useState('');
  const [regUser, setRegUser] = useState('');
  const [regDisp, setRegDisp] = useState('');
  const [regPass, setRegPass] = useState('');
  const [codeSent, setCodeSent] = useState<{ expiresInMin: number; sendMode: string } | null>(null);

  /**
   * 「修改我的口令」这一段的反馈**必须就地显示**。
   *
   * 坑：早先这段代码失败后只是 `setErr(...)`，而面板里那个红条渲染在
   * **上面第一个 Section（账号与安全）** —— 用户滚到下面填表时视线根本不在那儿，
   * 于是"保存"看起来毫无反应，实际是口令压根没改成功（服务端零请求、审计零记录）。
   * 成功时用户会被踢下线，反馈才勉强可见；失败则彻底静默 —— 这是最坏的一种失败。
   * 所以这一段自带一份状态，好了坏了都写在按钮上面。
   */
  const [pwMsg, setPwMsg] = useState('');
  const [pwErr, setPwErr] = useState('');

  const say = useCallback((s: string) => setMsg(s), []);

  const refresh = useCallback(async () => {
    const t = props.token;
    const modeR = await api<{ mode: string; accountCount: number; signupOpen?: boolean }>('/api/auth/mode');
    if (modeR.status === 0) {
      setOnline('offline');
      setMode(null);
      return;
    }
    setOnline('online');
    setMode(modeR.data.mode === 'accounts' ? 'accounts' : 'local-open');
    setSignupOpen(Boolean(modeR.data.signupOpen));

    const meR = await api<{ account: AuthAccount | null; sessions?: number; permissions?: { canManage?: boolean } }>('/api/auth/me', { token: t });
    if (meR.ok && meR.data.account) {
      setMe(meR.data.account);
      setSessions(meR.data.sessions ?? 0);
      setPermissions(meR.data.permissions ?? null);
      if (meR.data.permissions?.canManage) {
        const listR = await api<{ accounts: AuthAccount[]; roles: Array<{ id: string; label: string }>; plans: typeof plans }>('/api/account/accounts', { token: t });
        if (listR.ok) {
          setAccounts(listR.data.accounts ?? []);
          setRoles(listR.data.roles ?? []);
          setPlans(listR.data.plans ?? []);
        }
      } else {
        setAccounts([]);
      }
    } else {
      setMe(null);
      setPermissions(null);
      setAccounts([]);
    }

    const polR = await api<Policy>('/api/security/policy', { token: t });
    if (polR.status === 200 && (polR.data as { mode?: string }).mode) setPolicy(polR.data);
    else if (polR.status === 401) setPolicy(null);
  }, [props.token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const doRegister = useCallback(async () => {
    setErr('');
    if (p !== p2) {
      setErr('两次输入的口令不一致');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ token: string | null }>('/api/auth/register', { method: 'POST', body: { username: u, password: p, displayName: u } });
      if (!r.ok) {
        setErr(r.error ?? '建立失败');
        return;
      }
      props.setToken(r.data.token ?? null);
      saveToken(r.data.token ?? null);
      setP('');
      setP2('');
      say('已建立所有者账号。从此刻起所有接口都要求登录，且不可回退。');
      props.onToast?.('ok', '账号已建立，系统进入「账号模式」');
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [p, p2, props, refresh, u]);

  /** 第一步：请求验证码。SMTP 没配 / 未开放注册时，服务端的报错原样透出 —— 不替服务端圆场 */
  const sendRegCode = useCallback(async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await api<{ expiresInMin: number; sendMode: string }>('/api/auth/register-email', { method: 'POST', body: { email: regEmail.trim() } });
      if (!r.ok) {
        setErr(r.error ?? '验证码发送失败');
        return;
      }
      setCodeSent({ expiresInMin: r.data.expiresInMin, sendMode: r.data.sendMode });
      say(
        r.data.sendMode === 'file'
          ? `验证码已生成（落盘模式，没有真发信）—— ${r.data.expiresInMin} 分钟内有效`
          : `验证码已发到 ${regEmail.trim()} —— ${r.data.expiresInMin} 分钟内有效`
      );
    } finally {
      setBusy(false);
    }
  }, [regEmail, say]);

  /** 第二步：凭码建号。无账号时建的是 owner；开放注册时建的是设计师/免费档 */
  const doEmailRegister = useCallback(async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await api<{ token: string | null }>('/api/auth/register-email/verify', {
        method: 'POST',
        body: { email: regEmail.trim(), code: regCode.trim(), password: regPass, username: regUser.trim() || undefined, displayName: regDisp.trim() || undefined },
      });
      if (!r.ok) {
        setErr(r.error ?? '注册失败');
        return;
      }
      props.setToken(r.data.token ?? null);
      saveToken(r.data.token ?? null);
      setRegEmail('');
      setRegCode('');
      setRegUser('');
      setRegDisp('');
      setRegPass('');
      setCodeSent(null);
      props.onToast?.('ok', '注册成功，已自动登录');
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [regCode, regDisp, regEmail, regPass, regUser, props, refresh]);

  const doLogin = useCallback(async () => {    setErr('');
    setBusy(true);
    try {
      const r = await api<{ token: string }>('/api/auth/login', { method: 'POST', body: { username: u, password: p } });
      if (!r.ok) {
        setErr(r.error ?? '登录失败');
        return;
      }
      props.setToken(r.data.token);
      saveToken(r.data.token);
      setP('');
      say('已登录');
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [p, props, refresh, u]);

  /**
   * 登出由 App 统一处理（`props.onLogout`）—— 顶栏那个按钮走的是同一份实现。
   * 这里保留按钮只是为了让"退出登录"在账号页里也够得着，不再各写一遍。
   */

  const doChangePassword = useCallback(async () => {
    setPwErr('');
    setPwMsg('');
    const r = await api('/api/auth/password', { method: 'POST', token: props.token, body: { currentPassword: curP, newPassword: newP } });
    if (!r.ok) {
      // 就地报错，并且把"当前口令"清空 —— 否则用户会以为改成功了，然后拿新口令去登录
      setPwErr(r.error ?? '修改失败');
      setCurP('');
      return;
    }
    setCurP('');
    setNewP('');
    props.setToken(null);
    saveToken(null);
    setPwMsg('口令已修改，所有会话已失效，请重新登录');
    say('口令已修改，所有会话已失效，请重新登录');
    props.onToast?.('ok', '口令已修改，请重新登录');
    await refresh();
  }, [curP, newP, props, refresh]);

  const patch = useCallback(
    async (id: string, body: Record<string, unknown>, label: string) => {
      const r = await api('/api/account/account', { method: 'PATCH', token: props.token, body: { id, ...body } });
      if (!r.ok) {
        props.onToast?.('error', r.error ?? `${label}失败`);
        return;
      }
      props.onToast?.('ok', `${label}已生效`);
      await refresh();
    },
    [props, refresh]
  );

  const loadAudit = useCallback(async () => {
    const r = await api<{ entries: AuditEntry[] }>('/api/security/audit?limit=60', { token: props.token });
    if (r.ok) setAudit(r.data.entries ?? []);
    else props.onToast?.('error', r.error ?? '读取审计失败');
  }, [props]);

  // ───────────────────────── 渲染 ─────────────────────────

  /**
   * ⚠ 每个 return 都必须包在 `.panel-scroll` 里，三个 early return 也不例外。
   *
   * 这个面板是向右栏里最长的一个（账号管理 + 安全现状两栏 + 审计表格），
   * 而 `.side-right` 本身没有滚动能力（flex 子项默认 min-height:auto，且 overflow 可见）。
   * 少了这一层，长出来的部分会**溢出到面板之外、滚不到** —— 表现只是"内容没了"。
   */
  if (online === 'offline') {
    return (
      <div className="panel-scroll">
        <Section title="账号与安全" defaultOpen>
          <div className="alert alert-warn">
            本地服务未启动，账号体系不可用。先运行 <Text mono>npm run server</Text>。
          </div>
        </Section>
      </div>
    );
  }
  if (online === 'checking') {
    return (
      <div className="panel-scroll">
        <Section title="账号与安全" defaultOpen>
          <span className="muted-sm">检测中…</span>
        </Section>
      </div>
    );
  }

  const canManage = Boolean(permissions?.canManage);

  return (
    <div className="panel-scroll">
      <Section title="账号与安全" defaultOpen>
        <Row label="鉴权模式" derived hint="local-open = 还没有账号，接口免登录（先自用的默认状态）；accounts = 已启用账号，除登录注册外一律要求 token">
          <Pill kind={mode === 'accounts' ? 'ok' : 'muted'}>{mode}</Pill>
          {mode === 'local-open' ? <span className="muted-sm">　（接口当前免登录）</span> : null}
        </Row>
        {props.token && me ? (
          <>
            <Row label="当前账号" derived>
              <Text strong>{me.displayName}</Text> <Text mono>({me.username})</Text>
            </Row>
            <Row label="身份 / 档位" derived>
              <Pill kind="ok">{me.roleLabel}</Pill> <Pill kind="muted">{me.planLabel}</Pill>
              <span className="muted-sm">　活跃会话 {sessions} 条</span>
            </Row>
            <Row label="权限" derived>
              {permissions?.canManage ? '可管理账号' : '不可管理账号'} · {permissions?.canDesign ? '可改模型' : '只读'}
            </Row>
            <button type="button" className="tb-btn" onClick={() => props.onLogout()}>
              退出登录
            </button>
          </>
        ) : null}
        {!props.token && mode === 'local-open' ? (
          <div className="alert alert-info">
            还没有任何账号 —— 此时<b>所有接口都免登录</b>，这是"先自用"的默认状态。
            建立第一个账号后系统会进入账号模式：除健康检查与登录/注册外，<b>所有接口都要求登录</b>。
            <b>这个切换是单向的</b>（删掉账号库不能绕过，因为服务遇到损坏/缺失的账号库会拒绝启动而不是降级）。
          </div>
        ) : null}
        {msg ? <div className="alert alert-info">{msg}</div> : null}
        {err ? <div className="alert alert-error">{err}</div> : null}
      </Section>

      {props.token && me ? (
        <Section title="我的 AI 用量（按标准 token 计）" defaultOpen>
          <p className="note">
            token 按<b>万 / 亿</b>显示 —— 「已用 1234567」没人看得懂是多少，「123.5 万」一眼就明白；
            把鼠标停在数字上能看到精确值，便于和服务商账单核对。
            <b>生成次数</b>只计「生成编辑计划」「改草案」这类会出结果的调用，
            <b>对话提问不算</b>（它只花 token）—— 否则问两句常识就把当天的生成额度吃掉了。
            两条里<b>任意一条</b>用尽即止，界面会写清是哪一条拦的。
          </p>
          <QuotaMeter quota={me.quota} />
        </Section>
      ) : null}

      {(!props.token && mode === 'local-open') || !props.token ? (
        <Section title={mode === 'local-open' ? '建立第一个账号（所有者）' : '登录'} defaultOpen>
          <Row label="用户名">
            <input className="input" value={u} onChange={(e) => setU(e.target.value)} placeholder="3~32 位字母数字 _ . @ -" autoComplete="username" />
          </Row>
          <Row label="口令" hint="至少 8 位；不能是纯数字、常见弱口令或连续序列">
            <input className="input" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete={mode === 'local-open' ? 'new-password' : 'current-password'} />
          </Row>
          {mode === 'local-open' ? (
            <Row label="再输一次">
              <input className="input" type="password" value={p2} onChange={(e) => setP2(e.target.value)} autoComplete="new-password" />
            </Row>
          ) : null}
          <button
            type="button"
            className="tb-btn primary"
            disabled={busy || !u.trim() || !p}
            onClick={() => void (mode === 'local-open' ? doRegister() : doLogin())}
          >
            {mode === 'local-open' ? '建立账号并进入账号模式' : '登录'}
          </button>
        </Section>
      ) : null}

      {!props.token && signupOpen ? (
        <Section title={mode === 'local-open' ? '邮箱注册（第一个账号 = 所有者）' : '邮箱注册'} defaultOpen={mode !== 'local-open'}>
          <p className="note">
            两步：填邮箱拿验证码 → 凭验证码设口令。{mode === 'accounts' ? '开放注册期间新建的账号是「设计师 / 免费档」；' : ''}
            验证码 10 分钟有效，每次最多错 5 次。
          </p>
          <Row label="邮箱">
            <input
              className="input"
              value={regEmail}
              placeholder="you@example.com"
              autoComplete="email"
              onChange={(e) => setRegEmail(e.target.value)}
            />
          </Row>
          {codeSent ? (
            <>
              <Row label="验证码" hint={`${codeSent.expiresInMin} 分钟内有效`}>
                <input className="input" value={regCode} placeholder="6 位数字" inputMode="numeric" onChange={(e) => setRegCode(e.target.value)} />
              </Row>
              <Row label="用户名（可选）" hint="留空 = 用邮箱当用户名">
                <input className="input" value={regUser} placeholder="3~32 位字母数字 _ . @ -" onChange={(e) => setRegUser(e.target.value)} />
              </Row>
              <Row label="显示名（可选）" hint="留空 = 用户名 @ 前的部分">
                <input className="input" value={regDisp} onChange={(e) => setRegDisp(e.target.value)} />
              </Row>
              <Row label="口令" hint="至少 8 位；不能是纯数字、常见弱口令或连续序列">
                <input className="input" type="password" value={regPass} autoComplete="new-password" onChange={(e) => setRegPass(e.target.value)} />
              </Row>
              <div className="btn-row">
                <button type="button" className="tb-btn primary" disabled={busy || !regCode.trim() || !regPass} onClick={() => void doEmailRegister()}>
                  创建账号并登录
                </button>
                <button type="button" className="tb-btn" disabled={busy || !regEmail.trim()} onClick={() => void sendRegCode()}>
                  重新发送验证码
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="tb-btn primary" disabled={busy || !regEmail.trim()} onClick={() => void sendRegCode()}>
              发送验证码
            </button>
          )}
        </Section>
      ) : null}

      {props.token ? (
        <Section title="修改我的口令" defaultOpen={false}>
          <p className="note">改完会<b>踢掉所有会话（含当前这条）</b>，需要重新登录 —— 这是有意的：口令变更必须让旧凭据立即失效。</p>
          <Row label="当前口令">
            <input className="input" type="password" value={curP} onChange={(e) => setCurP(e.target.value)} autoComplete="current-password" />
          </Row>
          <Row label="新口令">
            <input className="input" type="password" value={newP} onChange={(e) => setNewP(e.target.value)} autoComplete="new-password" />
          </Row>
          {pwErr ? <div className="alert alert-error">{pwErr}<br />口令没有改动，请照上面提示重来。</div> : null}
          {pwMsg ? <div className="alert alert-info">{pwMsg}</div> : null}
          <button type="button" className="tb-btn" disabled={!curP || !newP} onClick={() => void doChangePassword()}>
            修改口令
          </button>
        </Section>
      ) : null}

      {canManage ? (
        <Section title={`账号管理（${accounts.length} 个）`} defaultOpen={accounts.length > 1}>
          <p className="note">
            角色权限：所有者/管理员可管账号；设计师可改模型；只读只能看。
            <b>不能降级或停用最后一个所有者</b> —— 那会把系统锁死到没人能管。
          </p>
          {accounts.map((a) => (
            <div key={a.id} className="acct">
              <div className="acct-head">
                <Text strong>{a.displayName}</Text> <Text mono>({a.username})</Text>
                {a.status === 'disabled' ? <Pill kind="ERROR">已停用</Pill> : <Pill kind="ok">正常</Pill>}
              </div>
              <Row label="角色">
                <select className="input" value={a.role} onChange={(e) => void patch(a.id, { role: e.target.value }, '角色变更')}>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="订阅档位" hint="档位决定 AI 的 token 额度（按周期）与每日生成次数，任一用尽即止">
                <select className="input" value={a.plan} onChange={(e) => void patch(a.id, { plan: e.target.value }, '档位变更')}>
                  {plans.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {planOptionLabel(pl)}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="AI 用量" derived>
                {/* 与「我的用量」、管理后台共用同一块 —— 三处口径必须一致 */}
                <QuotaMeter quota={a.quota} />
              </Row>
              <Row label="最近登录" derived>
                <Text mono>{a.lastLoginAt ? new Date(a.lastLoginAt).toLocaleString() : '从未'}</Text>
              </Row>
              <div className="btn-row">
                <button type="button" className="tb-btn" onClick={() => void patch(a.id, { status: a.status === 'active' ? 'disabled' : 'active' }, a.status === 'active' ? '停用' : '启用')}>
                  {a.status === 'active' ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  className="tb-btn"
                  onClick={() => {
                    const np = window.prompt(`给「${a.username}」设置新口令（至少 8 位）。该账号所有会话会被踢下线。`);
                    if (np) void patch(a.id, { newPassword: np }, '重置口令');
                  }}
                >
                  重置口令
                </button>
              </div>
            </div>
          ))}
          <Section title="新建账号" defaultOpen={false}>
            <Row label="用户名">
              <input className="input" value={newUserName} onChange={(e) => setNewUserName(e.target.value)} />
            </Row>
            <Row label="初始口令">
              <input className="input" type="password" value={newUserPw} onChange={(e) => setNewUserPw(e.target.value)} autoComplete="new-password" />
            </Row>
            <Row label="角色">
              <select className="input" value={newUserRole} onChange={(e) => setNewUserRole(e.target.value)}>
                {roles
                  .filter((r) => r.id !== 'owner' || canManage)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
              </select>
            </Row>
            <button
              type="button"
              className="tb-btn"
              disabled={!newUserName.trim() || !newUserPw}
              onClick={() =>
                void (async () => {
                  const r = await api('/api/account/accounts', { method: 'POST', token: props.token, body: { username: newUserName, password: newUserPw, role: newUserRole } });
                  if (!r.ok) {
                    props.onToast?.('error', r.error ?? '新建失败');
                    return;
                  }
                  setNewUserName('');
                  setNewUserPw('');
                  props.onToast?.('ok', '账号已创建');
                  await refresh();
                })()
              }
            >
              创建账号
            </button>
          </Section>
        </Section>
      ) : null}

      {policy ? (
        <Section title="安全现状（照实列出缺口）" defaultOpen={false}>
          <Row label="监听地址" derived hint="只监听回环 = 局域网访问不到；上线时靠反向代理做 TLS，而不是把本进程暴露出去">
            <Text mono>{policy.host}</Text> {policy.host === '127.0.0.1' ? <Pill kind="ok">仅本机</Pill> : <Pill kind="WARNING">已暴露</Pill>}
          </Row>
          <Row label="传输" derived>
            <Text>{policy.transport}</Text>
          </Row>
          <Row label="口令存储" derived>
            <Text mono>{policy.passwordHashing}</Text>
          </Row>
          <Row label="会话存储" derived>
            <Text mono>{policy.sessionStorage}</Text>
          </Row>
          <Row label="会话有效期 / 登录防爆破" derived>
            <Text mono>
              {policy.sessionTtlHours}h · {policy.login.windowMinutes} 分钟内失败 {policy.login.maxFails} 次锁定 {policy.login.lockMinutes} 分钟
            </Text>
          </Row>
          <Row label="租户隔离" derived>
            <Text>{policy.tenantIsolation}</Text>
          </Row>
          <Row label="API Key" derived>
            <Text mono>{policy.apiKeyMasked || '（未配置）'}</Text>
            <div className="muted-sm">存于 {policy.apiKeyLocation}，仅服务端可读，界面只显示后四位</div>
          </Row>
          <div className="two-col">
            <div>
              <div className="col-head ok">已实现</div>
              <ul className="tiny-list">
                {policy.implemented.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <div className="col-head warn">尚未实现（上线前必须补）</div>
              <ul className="tiny-list">
                {policy.notImplemented.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            </div>
          </div>
        </Section>
      ) : null}

      <Section title="审计日志" defaultOpen={false}>
        <p className="note">只追加、不覆盖。登录、失败登录、账号变更、AI 调用都会留痕（actor / action / target / ip / 时间）。</p>
        <button type="button" className="tb-btn" onClick={() => void loadAudit()}>
          读取最近 60 条
        </button>
        {audit.length > 0 ? (
          <table className="audit">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>结果</th>
                <th>对象</th>
                <th>来源</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e, i) => (
                <tr key={i}>
                  <td>{e.at ? new Date(e.at).toLocaleString() : ''}</td>
                  <td>
                    <Text mono>{e.action ?? ''}</Text>
                  </td>
                  <td>{e.result ?? (e.ok === false ? 'fail' : e.ok ? 'ok' : '')}</td>
                  <td>
                    <Text mono>{String(e.target ?? e.username ?? e.actor ?? '').slice(0, 24)}</Text>
                  </td>
                  {/**
                   * 来源 IP —— 面板上面的说明里写了会记 ip，表格就必须**真的显示它**。
                   * 那是复盘"这个账号是从哪台机器被登的"时唯一有用的字段；
                   * 说明与实际不符比不写更糟（人会以为他看过了）。
                   * 本机地址会带 `::ffff:` 前缀，去掉它才读得懂。
                   */}
                  <td>
                    <Text mono>{String(e.ip ?? '—').replace(/^::ffff:/, '')}</Text>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted-sm">尚未读取或暂无记录</div>
        )}
      </Section>
    </div>
  );
}

/** 供 App 初始化时复用：从 sessionStorage 取回 token */
export const initialToken = loadToken;
