import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Section, Text, Pill } from './common.tsx';

export interface DraftSummary {
  draftId: string;
  owner: string;
  createdAt: string;
  baseModelVersion: number;
}

interface DraftsPanelProps {
  token: string | null;
  version: number;
  onToast: (kind: 'ok' | 'info' | 'error', msg: string) => void;
  onApplied: () => void;
}

async function api(path: string, token: string | null, method = 'GET'): Promise<any> {
  const r = await fetch(path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

export function DraftsPanel(props: DraftsPanelProps): ReactNode {
  const { token, version, onToast, onApplied } = props;
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [liveVersion, setLiveVersion] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const j = await api('/api/drafts', token);
      setDrafts(j.drafts ?? []);
      setLiveVersion(j.liveModelVersion ?? 0);
    } catch (e) {
      onToast('error', `草稿列表加载失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }, [token, onToast]);

  useEffect(() => {
    void reload();
  }, [reload, version]);

  const onApply = async (d: DraftSummary) => {
    if (!confirm(`把草稿「${d.draftId}」合入正式？合入后正式数据会被修改。`)) return;
    setBusy(d.draftId);
    try {
      await api(`/api/drafts/${encodeURIComponent(d.draftId)}/apply`, token, 'POST');
      onToast('ok', '草稿已合入正式');
      onApplied();
      await reload();
    } catch (e) {
      onToast('error', `合入失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const onDiscard = async (d: DraftSummary) => {
    if (!confirm(`丢弃草稿「${d.draftId}」？此操作不可撤销。`)) return;
    setBusy(d.draftId);
    try {
      await api(`/api/drafts/${encodeURIComponent(d.draftId)}/discard`, token, 'POST');
      onToast('ok', '草稿已丢弃');
      await reload();
    } catch (e) {
      onToast('error', `丢弃失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section title="草稿">
      <div className="hint">
        MCP / AI 写的改动先落在草稿里，不碰正式数据。在这里查看、合入或丢弃。
      </div>
      <div className="row">
        <button type="button" className="btn" onClick={() => void reload()} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </button>
      </div>
      {drafts.length === 0 && !loading ? (
        <div className="hint">暂无草稿。MCP 工具写入时会自动创建。</div>
      ) : null}
      {drafts.map((d) => {
        const stale = d.baseModelVersion !== liveVersion;
        const isBusy = busy === d.draftId;
        return (
          <div key={d.draftId} className="card" style={{ marginTop: 8 }}>
            <div className="row">
              <Text mono>{d.draftId}</Text>
              {stale ? <Pill kind="WARNING">版本已过期</Pill> : <Pill kind="ok">可合入</Pill>}
            </div>
            <div className="hint">
              创建者 {d.owner} · {fmtTime(d.createdAt)}
              {stale ? ` · 基于版本 v${d.baseModelVersion}（当前 v${liveVersion}）` : ''}
            </div>
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={isBusy}
                onClick={() => void onApply(d)}
              >
                {isBusy ? '处理中…' : '合入正式'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={isBusy}
                onClick={() => void onDiscard(d)}
              >
                丢弃
              </button>
            </div>
          </div>
        );
      })}
    </Section>
  );
}
