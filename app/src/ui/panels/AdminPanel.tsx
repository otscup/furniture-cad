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

export function AdminPanel(props: { token: string | null }): ReactNode {
  const [health, setHealth] = useState<'checking' | 'online' | 'offline'>('checking');
  const [healthInfo, setHealthInfo] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [modelChoice, setModelChoice] = useState('');
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
            <Row label="输出上限" hint="推理模型会先把预算花在思考上 —— 值太小，正文会是空的（而接口仍返回成功）">
              <input
                className="input"
                type="number"
                min={64}
                step={512}
                value={String(settings.maxTokens)}
                onChange={(e) => setSettings({ ...settings, maxTokens: Number(e.target.value) || 0 })}
              />
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
