import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { fromJsonl, toJsonl } from '../../ai/correctionStore.ts';
import { applyCorrections, getCorrections } from '../../state/memoryStore.ts';
import { Pill, Row, Section, Text } from './common.tsx';

/**
 * 管理后台 —— 自己加 API 模型 / 自动拉取模型清单 / 测连通性 / 同步记忆。
 *
 * ── 两条不可动摇的规矩 ──
 *  1. **API Key 不进浏览器**。输入框永远是空的，只显示后四位；保存后前端
 *     也拿不回原文。纯前端保管 key 等于把 key 发给浏览器，那是设计事故。
 *  2. **服务只监听 127.0.0.1**。这台机器没有 VPS，服务就是本机进程；
 *     一旦 bind 0.0.0.0，同一个 WiFi 下任何人都能用你的 key 花钱。
 *
 * ── 关于"自动拉取模型"的诚实说明 ──
 *  内置清单是静态的，一定会过期。真正的权威来源是服务商的 GET {baseUrl}/models。
 *  所以拉取结果里必须带 source：'live' 说明是服务商实时返回的，
 *  'builtin' 说明拉取失败退回了内置清单 —— 界面必须如实区别，不能让用户
 *  以为看到的就是最新的。
 */

interface ProviderInfo {
  label: string;
  baseUrl: string;
  models: string[];
}

interface Settings {
  provider: string;
  providerLabel: string;
  baseUrl: string;
  model: string;
  apiKeyMasked: string;
  apiKeySet: boolean;
  temperature: number;
  /**
   * 单次输出上限。放在界面上是因为它**直接决定推理模型上有没有正文**：
   * 值太小 → 思考过程把预算吃光 → 正文是空字符串（而 HTTP 仍是 200）。
   */
  maxTokens: number;
  providers: Record<string, ProviderInfo>;
  envPath: string;
}

interface ModelList {
  source: 'live' | 'builtin';
  models: string[];
  count?: number;
  note?: string;
  error?: string;
}

/** 邮件 / SMTP 设置 —— 口令只回打码值（与 AI API Key 同一纪律） */
interface SmtpSettings {
  mode: 'smtp' | 'file';
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from: string;
  passMasked: string;
  passSet: boolean;
  fileOut: string;
  signupOpen: boolean;
}

export function AdminPanel(props: { token: string | null }): ReactNode {
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking');
  const [healthInfo, setHealthInfo] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelChoice, setModelChoice] = useState('');
  // ── 邮件 / SMTP ──
  const [smtp, setSmtp] = useState<SmtpSettings | null>(null);
  const [smtpForm, setSmtpForm] = useState<{ host: string; port: string; secure: boolean; user: string; from: string; pass: string; mode: 'smtp' | 'file' } | null>(null);
  const [signupOpen, setSignupOpen] = useState(false);
  const [testTo, setTestTo] = useState('');

  // ── 用量 / 账号 / 审计（Task #27：把后端已有的数据变成"看得见"的界面）──
  interface QuotaInfo {
    monthlyTokens?: number;
    dailyCalls?: number;
    used?: { monthTokens?: number; dayCalls?: number; month?: string; totalTokens?: number; totalCalls?: number };
  }
  interface UsageAccount {
    id: string;
    username: string;
    plan: string;
    quota?: QuotaInfo;
    lastLoginAt?: string | null;
  }
  interface AcctRow extends UsageAccount {
    role?: string;
    roleLabel?: string;
    planLabel?: string;
    status?: string;
  }
  interface SessionRow { id: string; createdAt: string; expiresAt: string; ip?: string; ua?: string }
  interface AuditEntry { at?: string; actor?: string; action?: string; target?: string; result?: string }
  const [usage, setUsage] = useState<UsageAccount[] | null>(null);
  const [accounts, setAccounts] = useState<AcctRow[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [sessionRows, setSessionRows] = useState<Record<string, { sessions: SessionRow[]; active: number }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  /** 被权限拦下时的原因。非空 = 这个面板现在**只能显示这句话**，不许渲染配置表单 */
  const [denied, setDenied] = useState('');

  const say = useCallback((s: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${s}`, ...l].slice(0, 12));
  }, []);

  /**
   * 带凭据的请求 —— 管理后台**必须**走这里。
   *
   * 为什么这不是洁癖：启用账号体系之后，`/api/settings` 这类接口一律要求 Bearer。
   * 早先这里用的是裸 `fetch`，于是 401 的 JSON 响应体（`{ok:false,error:'…'}`）
   * 被当成 Settings 直接读进了 state —— 界面**照常渲染出一整套模型表单**，
   * 每个字段都是 undefined，而它看起来跟读到了配置一模一样。
   * 用户会以为"配置读取成功"，实际上一个字节都没读到；接着点保存，也是白点。
   *
   * 所以这里的规矩是：**拦下就是拦下**。返回 null，调用方立刻停手，
   * 界面改为把拦截原因写在最上面。宁可不显示，也不显示一份假的配置。
   */
  const authed = useCallback(
    async (path: string, init: RequestInit = {}): Promise<Response | null> => {
      const res = await fetch(path, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
          ...(props.token ? { Authorization: `Bearer ${props.token}` } : {}),
        },
      });
      if (res.status === 401 || res.status === 403) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDenied(body.error ?? (res.status === 401 ? '这个接口需要登录' : '当前账号没有管理权限'));
        return null;
      }
      setDenied('');
      return res;
    },
    [props.token]
  );

  const boot = useCallback(async () => {
    try {
      const h = await fetch('/api/health'); // 健康检查是公开接口（上线时监控要能探活）
      if (!h.ok) throw new Error(`HTTP ${h.status}`);
      setHealthInfo(await h.json());
      setHealth('online');
    } catch (e) {
      setHealth('offline');
      say(`本地服务未响应：${(e as Error).message}`);
      return;
    }
    // 用量 / 账号 / 审计：并行拉，各自独立成败 —— 一个 403 不拖垮其余面板
    void (async () => {
      const u = await authed('/api/usage');
      if (u) setUsage(((await u.json()) as { accounts?: UsageAccount[] }).accounts ?? []);
      const a = await authed('/api/account/accounts');
      if (a) setAccounts(((await a.json()) as { accounts?: AcctRow[] }).accounts ?? []);
      const al = await authed('/api/security/audit?limit=50');
      if (al) setAudit(((await al.json()) as { entries?: AuditEntry[] }).entries ?? []);
      // SMTP 设置独立拉取：读失败（未登录/无权限）不影响上面的面板
      const sm = await authed('/api/settings/smtp');
      if (sm) {
        const d = (await sm.json()) as SmtpSettings;
        setSmtp(d);
        setSignupOpen(d.signupOpen);
        setSmtpForm({ host: d.host, port: String(d.port || ''), secure: d.secure, user: d.user, from: d.from, pass: '', mode: d.mode });
        setTestTo(d.from || d.user || '');
      }
    })();
    try {
      const sr = await authed('/api/settings');
      if (!sr) return;
      const s = (await sr.json()) as Settings;
      setSettings(s);
      setModelChoice(s.model);
      const mr = await authed('/api/models');
      if (!mr) return;
      setModels((await mr.json()) as ModelList);
      say(`已连接本地服务，读到 ${Object.keys(s.providers ?? {}).length} 家服务商预设`);
    } catch (e) {
      say(`读取配置失败：${(e as Error).message}`);
    }
  }, [authed, say]);

  useEffect(() => {
    void boot();
  }, [boot]);

  const save = useCallback(async () => {
    if (!settings) return;
    setBusy('save');
    try {
      const r = await authed('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          // 模型名留空 = 不修改。切到「局域网」这类没有内置清单的服务商时，
          // 下拉框是空的 —— 这时候把空字符串发过去会**清掉**原来配好的模型名。
          ...(modelChoice.trim() ? { model: modelChoice.trim() } : {}),
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          // 留空 = 不修改。前端根本没有原文，也不可能"原样发回"。
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      if (!r) return;
      const data = (await r.json()) as Settings;
      setSettings(data);
      setApiKey('');
      say(`已保存到 ${data.envPath}（key ${data.apiKeyMasked || '未设置'}，模型 ${data.model}）`);
      const mr = await authed('/api/models');
      if (mr) setModels((await mr.json()) as ModelList);
    } catch (e) {
      say(`保存失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [apiKey, authed, modelChoice, say, settings]);

  const refreshModels = useCallback(async () => {
    setBusy('models');
    try {
      const r = await authed('/api/models/refresh', { method: 'POST' });
      if (!r) return;
      const data = (await r.json()) as ModelList;
      setModels(data);
      say(
        data.source === 'live'
          ? `服务商实时返回 ${data.count} 个模型`
          : `拉取失败，退回内置清单（${data.models.length} 个）：${data.error ?? '未知原因'}`
      );
    } catch (e) {
      say(`拉取失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [authed, say]);

  const test = useCallback(async () => {
    setBusy('test');
    try {
      const r = await authed('/api/test', { method: 'POST' });
      if (!r) return;
      const data = (await r.json()) as {
        ok: boolean;
        reachable?: boolean;
        spoke?: boolean;
        latencyMs?: number;
        model?: string;
        error?: string;
        note?: string;
        usage?: { total_tokens?: number; reasoning_tokens?: number } | null;
      };
      /**
       * ── 两句话，一个判据：模型有没有真的回话 ──
       *
       * 早先这里只看 HTTP，于是对**推理模型**报"连通性正常"：
       * 输出预算被思考过程吃掉、正文是空的 —— 用户以为配好了，
       * 转头在规划里收到"模型返回了空内容"，完全无从下手。
       * 通过一个什么都没验证的测试，比测试失败更坏。
       *
       * 否定时统一用「连通性失败」开头，后面接**具体原因**（服务端给的 note 已经
       * 区分了"鉴权没过"和"模型没说话"）—— 一个笼统的失败词会把排查方向带偏。
       */
      if (data.spoke) {
        const u = data.usage;
        say(
          `✓ 连通性正常：模型确实回了话 · ${data.model} · ${data.latencyMs}ms` +
            (u?.total_tokens !== undefined ? ` · ${u.total_tokens} token` : '') +
            (u?.reasoning_tokens ? `（其中推理 ${u.reasoning_tokens}）` : '')
        );
      } else {
        say(`✗ 连通性失败：${data.note ?? ''}${data.error ? `　${data.error}` : ''}`);
      }
    } catch (e) {
      say(`测试失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [authed, say]);

  const saveSmtp = useCallback(async () => {
    if (!smtpForm) return;
    setBusy('smtp-save');
    try {
      const r = await authed('/api/settings/smtp', {
        method: 'PUT',
        body: JSON.stringify({
          mode: smtpForm.mode,
          host: smtpForm.host,
          ...(smtpForm.port.trim() ? { port: Number(smtpForm.port) } : { port: '' }),
          secure: smtpForm.secure,
          user: smtpForm.user,
          from: smtpForm.from,
          // 留空 = 不修改 —— 前端根本没有原文，也不可能"原样发回"
          ...(smtpForm.pass.trim() ? { pass: smtpForm.pass.trim() } : {}),
          signupOpen,
        }),
      });
      if (!r) return;
      const data = (await r.json()) as SmtpSettings;
      setSmtp(data);
      setSignupOpen(data.signupOpen);
      setSmtpForm({ host: data.host, port: String(data.port || ''), secure: data.secure, user: data.user, from: data.from, pass: '', mode: data.mode });
      say(
        data.configured
          ? `SMTP 已保存并就绪（模式：${data.mode === 'file' ? `落盘 ${data.fileOut}` : `${data.host}:${data.port}`}）`
          : 'SMTP 已保存，但配置还不完整 —— 邮箱注册在配置齐全前会明确报错'
      );
    } catch (e) {
      say(`SMTP 保存失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [authed, say, signupOpen, smtpForm]);

  const testSmtp = useCallback(async () => {
    if (!smtpForm) return;
    // 先存再测：测的是"当前表单里的配置"，不是磁盘上的旧配置 —— 否则测通过一次，保存后却是另一套
    const saved = await (async () => {
      setBusy('smtp-test');
      try {
        const r = await authed('/api/settings/smtp', {
          method: 'PUT',
          body: JSON.stringify({
            mode: smtpForm.mode,
            host: smtpForm.host,
            ...(smtpForm.port.trim() ? { port: Number(smtpForm.port) } : { port: '' }),
            secure: smtpForm.secure,
            user: smtpForm.user,
            from: smtpForm.from,
            ...(smtpForm.pass.trim() ? { pass: smtpForm.pass.trim() } : {}),
            signupOpen,
          }),
        });
        if (!r) return null;
        const data = (await r.json()) as SmtpSettings;
        setSmtp(data);
        setSmtpForm({ host: data.host, port: String(data.port || ''), secure: data.secure, user: data.user, from: data.from, pass: '', mode: data.mode });
        return data;
      } catch (e) {
        say(`SMTP 保存失败：${(e as Error).message}`);
        return null;
      }
    })();
    if (!saved) {
      setBusy(null);
      return;
    }
    try {
      const r = await authed('/api/settings/smtp/test', { method: 'POST', body: JSON.stringify({ to: testTo.trim() || undefined }) });
      if (!r) return;
      const data = (await r.json()) as { ok: boolean; mode?: string; to?: string; file?: string; messageId?: string; error?: string };
      if (data.ok) {
        say(
          data.mode === 'file'
            ? `✓ 落盘模式：邮件已写入 ${data.file}（没有真发网）`
            : `✓ 测试邮件已发给 ${data.to}（messageId ${String(data.messageId ?? '').slice(0, 24)}…）`
        );
      } else {
        say(`✗ 测试邮件发送失败：${data.error ?? '未知原因'}`);
      }
    } catch (e) {
      say(`测试邮件失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [authed, say, signupOpen, smtpForm, testTo]);

  const exportMemory = useCallback(async () => {
    setBusy('memout');
    try {
      const jsonl = toJsonl(getCorrections());
      const r = await authed('/api/memory', { method: 'PUT', body: JSON.stringify({ jsonl }) });
      if (!r) return;
      const data = (await r.json()) as { ok: boolean; path?: string; bytes?: number; error?: string };
      say(data.ok ? `记忆已写入 ${data.path}（${data.bytes} 字节，旧版备份为 .bak）` : `写入失败：${data.error}`);
    } catch (e) {
      say(`写入失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [authed, say]);

  const importMemory = useCallback(async () => {
    setBusy('memin');
    try {
      const r = await authed('/api/memory');
      if (!r) return;
      const data = (await r.json()) as { ok: boolean; jsonl?: string; count?: number };
      if (!data.jsonl || data.count === 0) {
        say('服务端还没有记忆文件，先「写入服务端」一次。');
        return;
      }
      const parsed = fromJsonl(data.jsonl);
      if (parsed.list.length === 0) {
        say('服务端记忆全部解析失败，已放弃导入（未改动当前记忆）');
        return;
      }
      applyCorrections(parsed.list);
      say(`已从服务端载入 ${parsed.list.length} 条记忆，记忆门已重新编译并立即生效`);
    } catch (e) {
      say(`载入失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [authed, say]);

  const providerList = settings ? Object.entries(settings.providers) : [];

  // ── 会话轮换 / 审计导出（Task #27）──
  const loadSessions = useCallback(
    async (id: string) => {
      setBusy(`sess-${id}`);
      try {
        const r = await authed(`/api/account/sessions?id=${encodeURIComponent(id)}`);
        if (!r) return;
        const data = (await r.json()) as { sessions?: SessionRow[]; active?: number };
        setSessionRows((prev) => ({ ...prev, [id]: { sessions: data.sessions ?? [], active: data.active ?? 0 } }));
      } catch (e) {
        say(`读取会话失败：${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [authed, say]
  );

  const kickAll = useCallback(
    async (id: string) => {
      setBusy(`kick-${id}`);
      try {
        const r = await authed('/api/account/revoke-all-sessions', { method: 'POST', body: JSON.stringify({ id }) });
        if (!r) return;
        const data = (await r.json()) as { removed?: number };
        say(`已踢下线 ${data.removed ?? 0} 个会话（被踢设备需要重新登录）`);
        setSessionRows((prev) => ({ ...prev, [id]: { sessions: [], active: 0 } }));
      } catch (e) {
        say(`踢下线失败：${(e as Error).message}`);
      } finally {
        setBusy(null);
      }
    },
    [authed, say]
  );

  const exportAuditCsv = useCallback(async () => {
    setBusy('audit-csv');
    try {
      const r = await authed('/api/security/audit?format=csv&limit=1000');
      if (!r) return;
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      say('审计日志已导出 CSV（带 BOM，Excel 打开中文不乱码）');
    } catch (e) {
      say(`导出失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [authed, say]);

  const fmtNum = (v: number | undefined): string => (typeof v === 'number' ? v.toLocaleString('zh-CN') : '—');
  const modelOptions = (() => {
    const base = models?.models ?? [];
    const cur = modelChoice || settings?.model || '';
    return cur && !base.includes(cur) ? [cur, ...base] : base;
  })();

  return (
    <div className="panel-scroll">
      <Section title="本地服务">
        <Row label="状态">
          {health === 'checking' ? <Pill kind="muted">检测中…</Pill> : health === 'online' ? <Pill kind="ok">运行中</Pill> : <Pill kind="ERROR">未启动</Pill>}
        </Row>
        {health === 'offline' ? (
          <div className="hint-line">
            管理后台需要一个<b>本机</b>进程来保管 API Key（前端不留 key）。在项目目录执行：
            <pre className="cmdbox">{'cd app\nnode server/server.mjs'}</pre>
            或者直接 <b>npm run server</b>。开发时 <b>npm run dev</b> 会把 <b>/api</b> 代理到它。
          </div>
        ) : (
          <>
            <Row label="监听地址">
              <Text mono>
                http://{String(healthInfo?.host ?? '127.0.0.1')}:{String(healthInfo?.port ?? 8787)}
              </Text>
            </Row>
            <Row label="安全边界">
              <Text>只监听本机回环地址，局域网内其他机器访问不到</Text>
            </Row>
            <Row label="配置文件">
              <Text mono>{settings?.envPath ?? '—'}</Text>
            </Row>
          </>
        )}
      </Section>

      {/**
       * 被权限拦下 —— 这时**只能显示这句话**。
       * 下面那个 `settings &&` 判断本来只是"还没读到就不渲染"，
       * 但 401 的响应体是个对象，一样非空 —— 于是"没读到"会被当成"读到了"。
       * 加上 !denied 才是真正的"读到过并且读对了"。
       */}
      {denied ? (
        <Section title="权限" defaultOpen>
          <div className="alert alert-error">管理后台需要管理权限：{denied}</div>
          <div className="muted-sm">
            服务本身是通的（上面的健康检查正常），只是这次请求被权限拦下了。请到右侧「账号」页登录所有者 / 管理员账号后回来。
          </div>
        </Section>
      ) : null}

      {health === 'online' && settings && !denied ? (
        <>
          <Section title="用量与额度" defaultOpen>
            {usage === null ? (
              <Text>读取中…</Text>
            ) : usage.length === 0 ? (
              <Text>本地开放模式：还没有账号体系，用量统计在创建账号后生效</Text>
            ) : (
              usage.map((a) => {
                const used = a.quota?.used;
                const pct = a.quota?.monthlyTokens && a.quota.monthlyTokens > 0 && used?.monthTokens !== undefined
                  ? Math.min(100, Math.round((used.monthTokens / a.quota.monthlyTokens) * 100))
                  : null;
                return (
                  <div key={a.id} className="view-item">
                    <div className="view-item-head">
                      <b>{a.username}</b>
                      <Pill kind={pct !== null && pct > 85 ? 'WARNING' : 'muted'}>{a.plan}</Pill>
                    </div>
                    <div className="view-item-note">
                      本月 {fmtNum(used?.monthTokens)} / {fmtNum(a.quota?.monthlyTokens)} token
                      {pct !== null ? `（${pct}%）` : ''} · 今日调用 {fmtNum(used?.dayCalls)} / {fmtNum(a.quota?.dailyCalls)} · 累计{' '}
                      {fmtNum(used?.totalTokens)} token
                    </div>
                  </div>
                );
              })
            )}
          </Section>

          <Section title="账号与会话">
            {accounts === null ? (
              <Text>读取中…</Text>
            ) : accounts.length === 0 ? (
              <Text>本地开放模式：无账号（创建第一个账号后这里会出现账号列表）</Text>
            ) : (
              <>
                {accounts.map((a) => (
                  <div key={a.id} className="view-item">
                    <div className="view-item-head">
                      <b>{a.username}</b>
                      <span>
                        <Pill kind="muted">{a.roleLabel ?? a.role ?? '—'}</Pill>{' '}
                        {a.status !== 'active' ? <Pill kind="ERROR">{a.status}</Pill> : null}
                      </span>
                    </div>
                    <div className="view-item-note">
                      {a.planLabel ?? a.plan} · 最近登录 {a.lastLoginAt ? String(a.lastLoginAt).slice(0, 16).replace('T', ' ') : '从未'}
                    </div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <button
                        type="button"
                        className="tb-btn"
                        disabled={busy === `sess-${a.id}`}
                        onClick={() => void loadSessions(a.id)}
                      >
                        {busy === `sess-${a.id}` ? '读取中…' : '查看活跃会话'}
                      </button>
                      <button
                        type="button"
                        className="tb-btn"
                        disabled={busy === `kick-${a.id}`}
                        onClick={() => void kickAll(a.id)}
                      >
                        {busy === `kick-${a.id}` ? '踢下线中…' : '全部踢下线'}
                      </button>
                    </div>
                    {sessionRows[a.id] ? (
                      sessionRows[a.id].sessions.length === 0 ? (
                        <div className="view-item-note">当前没有活跃会话（0 个）</div>
                      ) : (
                        sessionRows[a.id].sessions.map((s) => (
                          <div key={s.id} className="view-item-note" title={`${s.ip ?? ''} ${s.ua ?? ''}`}>
                            会话 {s.id}… · 登录 {s.createdAt.slice(0, 16).replace('T', ' ')} · 过期 {s.expiresAt.slice(0, 16).replace('T', ' ')}
                          </div>
                        ))
                      )
                    ) : null}
                  </div>
                ))}
                <div className="muted-sm">
                  会话哈希只显示前 8 位 —— 审计数据会四处走，落全文等于把哈希当明文管。
                  「全部踢下线」后账号本身不受影响，被踢设备需要重新登录。
                </div>
              </>
            )}
          </Section>

          <Section title="安全审计">
            {audit === null ? (
              <Text>读取中…</Text>
            ) : (
              <>
                {audit.slice(0, 12).map((e, i) => (
                  <div key={i} className="view-item-note">
                    {String(e.at ?? '').slice(5, 19).replace('T', ' ')} · {e.action ?? '—'} · {e.actor ?? '—'}
                    {e.target ? ` → ${e.target}` : ''}
                    {e.result ? ` · ${e.result}` : ''}
                  </div>
                ))}
                {audit.length === 0 ? <Text>还没有审计记录</Text> : null}
                <div style={{ marginTop: 6 }}>
                  <button type="button" className="tb-btn" disabled={busy === 'audit-csv'} onClick={() => void exportAuditCsv()}>
                    {busy === 'audit-csv' ? '导出中…' : '导出审计 CSV（近 1000 条）'}
                  </button>
                </div>
              </>
            )}
          </Section>

          <Section title="AI 模型">
            <Row label="服务商">
              <select
                className="input"
                value={settings.provider}
                onChange={(e) => {
                  const p = e.target.value;
                  const info = settings.providers[p];
                  setSettings({ ...settings, provider: p, baseUrl: info?.baseUrl ?? settings.baseUrl });
                  setModelChoice(info?.models[0] ?? '');
                }}
              >
                {providerList.map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Base URL">
              <input
                className="input"
                value={settings.baseUrl}
                placeholder="https://…/v1　或　http://192.168.x.x:端口/v1"
                onChange={(e) => setSettings({ ...settings, baseUrl: e.target.value })}
              />
            </Row>
            {settings.provider === 'lan' ? (
              <p className="note">
                内网端点直接填 <code>http://192.168.x.x:端口/v1</code> —— <b>不需要 HTTPS、不需要出网</b>。
                模型名请点「⟳ 自动拉取模型」拿（内网挂的是什么模型，这里无从预设）。
                <br />
                另外：本服务只监听 <code>127.0.0.1</code>，那是<b>入站</b>限制；<b>出站</b>连局域网不受它影响，
                不需要为了让本服务能连内网模型而改成监听所有网卡。
              </p>
            ) : null}
            <Row label="API Key" hint="留空表示不修改；前端只能看到后四位">
              <input
                className="input"
                type="password"
                value={apiKey}
                placeholder={settings.apiKeySet ? `已保存 ${settings.apiKeyMasked}（留空不改）` : '还没有设置'}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
              />
            </Row>
            <Row label="模型">
              <select className="input" value={modelChoice} onChange={(e) => setModelChoice(e.target.value)}>
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                {modelOptions.length === 0 ? <option value="">（先拉取模型列表）</option> : null}
              </select>
            </Row>
            <Row label="温度">
              <input
                className="input"
                inputMode="decimal"
                value={String(settings.temperature)}
                onChange={(e) => setSettings({ ...settings, temperature: Number(e.target.value) || 0 })}
              />
            </Row>
            <Row
              label="输出上限"
              hint="单次回复的最大 token 数，合法区间 1–65536。不能设到百万级（那是上下文/总量概念，不是这里的 max_tokens）。推理模型会先把预算花在思考上，值太小正文是空的；但值太大（如 64K）模型会写很久而超时 —— 建议 8K/16K。"
            >
              <div className="token-presets">
                {[4096, 8192, 16384, 32768, 65536].map((v) => (
                  <button
                    key={v}
                    type="button"
                    className={`tb-btn ${settings.maxTokens === v ? 'active' : ''}`}
                    onClick={() => setSettings({ ...settings, maxTokens: v })}
                  >
                    {v / 1024}K
                  </button>
                ))}
                <button
                  type="button"
                  className={`tb-btn ${
                    settings.maxTokens !== 4096 &&
                    settings.maxTokens !== 8192 &&
                    settings.maxTokens !== 16384 &&
                    settings.maxTokens !== 32768 &&
                    settings.maxTokens !== 65536
                      ? 'active'
                      : ''
                  }`}
                  onClick={() => setSettings({ ...settings, maxTokens: 16384 })}
                >
                  自定义
                </button>
                {settings.maxTokens !== 4096 &&
                settings.maxTokens !== 8192 &&
                settings.maxTokens !== 16384 &&
                settings.maxTokens !== 32768 &&
                settings.maxTokens !== 65536 ? (
                  <input
                    className="input token-custom"
                    type="number"
                    min={1}
                    max={65536}
                    step={512}
                    value={String(settings.maxTokens)}
                    onChange={(e) =>
                      setSettings({
                        ...settings,
                        maxTokens: Math.max(1, Math.min(65536, Math.round(Number(e.target.value) || 0))),
                      })
                    }
                  />
                ) : null}
              </div>
              <span className="muted">当前：{settings.maxTokens} token（{Math.round(settings.maxTokens / 1024)}K）</span>
            </Row>

            <div className="btn-row">
              <button type="button" className="tb-btn active" disabled={busy !== null} onClick={() => void save()}>
                保存
              </button>
              <button type="button" className="tb-btn" disabled={busy !== null} onClick={() => void refreshModels()}>
                ⟳ 自动拉取模型
              </button>
              <button type="button" className="tb-btn" disabled={busy !== null} onClick={() => void test()}>
                测试连通性
              </button>
            </div>

            {models ? (
              <div className={`model-src model-src-${models.source}`}>
                {models.source === 'live' ? (
                  <>
                    <Pill kind="ok">服务商实时返回</Pill> 共 {models.count} 个模型 —— 这是当前权威清单。
                  </>
                ) : (
                  <>
                    <Pill kind="WARNING">内置清单（可能已过期）</Pill> {models.models.length} 个模型
                    {models.error ? <div className="model-err">拉取失败原因：{models.error}</div> : <div className="model-err">{models.note}</div>}
                  </>
                )}
              </div>
            ) : null}
          </Section>

          <Section title="邮件 / SMTP">
            {smtp && smtpForm ? (
              <>
                <Row label="发信模式" hint="file = 落盘模式，不发网，邮件追加写入文件（本地调试与验收用）；smtp = 真发信">
                  <select
                    className="input"
                    value={smtpForm.mode}
                    onChange={(e) => setSmtpForm({ ...smtpForm, mode: e.target.value as 'smtp' | 'file' })}
                  >
                    <option value="smtp">SMTP 发信</option>
                    <option value="file">落盘模式（不发网）</option>
                  </select>
                </Row>
                {smtpForm.mode === 'file' ? (
                  <Row label="落盘文件" hint="邮件以 JSONL 追加写入这里，注册验证码可从文件里读">
                    <input
                      className="input"
                      value={smtpForm.mode === smtp.mode ? smtp.fileOut : ''}
                      placeholder="保存后生效（默认 memory/outbox.jsonl）"
                      readOnly
                    />
                  </Row>
                ) : (
                  <>
                    <Row label="SMTP 服务器">
                      <input
                        className="input"
                        value={smtpForm.host}
                        placeholder="smtp.qq.com / smtp.163.com / …"
                        onChange={(e) => setSmtpForm({ ...smtpForm, host: e.target.value })}
                      />
                    </Row>
                    <Row label="端口" hint="465 = SSL（勾选安全连接）；587 = STARTTLS">
                      <input
                        className="input"
                        type="number"
                        min={1}
                        value={smtpForm.port}
                        placeholder={smtpForm.secure ? '465' : '587'}
                        onChange={(e) => setSmtpForm({ ...smtpForm, port: e.target.value })}
                      />
                    </Row>
                    <Row label="安全连接 (SSL)">
                      <input
                        type="checkbox"
                        checked={smtpForm.secure}
                        onChange={(e) => setSmtpForm({ ...smtpForm, secure: e.target.checked })}
                      />
                    </Row>
                  </>
                )}
                <Row label="账号（发信邮箱）">
                  <input
                    className="input"
                    value={smtpForm.user}
                    placeholder="you@example.com"
                    onChange={(e) => setSmtpForm({ ...smtpForm, user: e.target.value })}
                  />
                </Row>
                <Row label="授权码 / 口令" hint="QQ/163 邮箱用的是「授权码」不是登录密码；留空表示不修改">
                  <input
                    className="input"
                    type="password"
                    value={smtpForm.pass}
                    placeholder={smtp.passSet ? `已保存 ${smtp.passMasked}（留空不改）` : '还没有设置'}
                    onChange={(e) => setSmtpForm({ ...smtpForm, pass: e.target.value })}
                    autoComplete="new-password"
                  />
                </Row>
                <Row label="发件人" hint="多数服务商要求与账号一致，不一致会被拒信">
                  <input
                    className="input"
                    value={smtpForm.from}
                    placeholder="you@example.com"
                    onChange={(e) => setSmtpForm({ ...smtpForm, from: e.target.value })}
                  />
                </Row>
                <Row label="开放注册" hint="开启后，任何人可用邮箱验证码自助注册（角色=设计师、档位=免费）。关闭时只有无账号阶段可自助建号">
                  <input type="checkbox" checked={signupOpen} onChange={(e) => setSignupOpen(e.target.checked)} />
                  <span className="muted-sm">{signupOpen ? '已开放' : '未开放'}</span>
                </Row>
                <Row label="收测试邮件到">
                  <input
                    className="input"
                    value={testTo}
                    placeholder="留空 = 发给发件人自己"
                    onChange={(e) => setTestTo(e.target.value)}
                  />
                </Row>
                <div className="btn-row">
                  <button type="button" className="tb-btn active" disabled={busy !== null} onClick={() => void saveSmtp()}>
                    保存
                  </button>
                  <button type="button" className="tb-btn" disabled={busy !== null} onClick={() => void testSmtp()}>
                    保存并发测试邮件
                  </button>
                </div>
                {smtp.mode === 'file' && smtp.configured ? (
                  <div className="muted-sm">当前是落盘模式：邮件没有真的发出去，只是写进了文件 —— 界面上如实显示，别当成已发网。</div>
                ) : null}
              </>
            ) : (
              <Text>读取中…</Text>
            )}
          </Section>

          <Section title="记忆同步">
            <div className="hint-line">
              记忆默认存在浏览器 localStorage 里（随时可用）。写入服务端后它会落到{' '}
              <Text mono>app/memory/corrections.jsonl</Text>，可以进 git、可以跨浏览器载入。覆盖前会先留一份{' '}
              <Text mono>.bak</Text>。
            </div>
            <div className="btn-row">
              <button type="button" className="tb-btn" disabled={busy !== null} onClick={() => void exportMemory()}>
                写入服务端
              </button>
              <button type="button" className="tb-btn" disabled={busy !== null} onClick={() => void importMemory()}>
                从服务端载入
              </button>
            </div>
          </Section>
        </>
      ) : null}

      <Section title="操作日志" defaultOpen={log.length > 0}>
        {log.length === 0 ? <div className="hint-line">还没有操作。</div> : <pre className="cmdbox logbox">{log.join('\n')}</pre>}
      </Section>
    </div>
  );
}
