import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Project } from '../../core/types.ts';
import { buildCabinetViews } from '../../core/geometry/views.ts';
import { primsToSvg } from '../../export/roomBook.ts';
import { RULESET } from '../../state/store.ts';
import { Section, Text, Pill } from './common.tsx';

export interface DraftSummary {
  draftId: string;
  owner: string;
  createdAt: string;
  baseModelVersion: number;
}

interface WorkspaceSnapshot {
  project: Project;
  liveModelVersion: number;
  workspaceId: string;
}

interface DraftSnapshot {
  draftId: string;
  runId: string;
  revision: number;
  draftHash: string;
  liveModelVersion: number;
  baseModelVersion: number;
  baseProjectHash: string;
  isStale: boolean;
  canApply: boolean;
  localVersion: number;
  project: Project;
  validation?: { blockingErrors: number };
}

interface PendingRemoteSync {
  project: Project;
  workspaceId: string;
  liveModelVersion: number;
  originallyAppliedVersion: number;
}

interface DraftsPanelProps {
  token: string | null;
  version: number;
  bus: CommandBus;
  onToast: (kind: 'ok' | 'info' | 'error', msg: string) => void;
  /** Called only after the browser-local CommandBus has actually been synchronized. */
  onApplied: () => void;
  readOnly?: boolean;
}

const PENDING_SYNC_KEY = 'furniture-cad.remote-sync-pending.v1';

async function api<T = Record<string, unknown>>(path: string, token: string | null, method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

/** Object-key order is irrelevant; array order remains semantic for a furniture project. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function readPendingMarker(): { workspaceId: string; liveModelVersion: number } | null {
  try {
    const raw = localStorage.getItem(PENDING_SYNC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { workspaceId?: unknown; liveModelVersion?: unknown };
    if (typeof parsed.workspaceId !== 'string' || typeof parsed.liveModelVersion !== 'number') return null;
    return { workspaceId: parsed.workspaceId, liveModelVersion: parsed.liveModelVersion };
  } catch {
    return null;
  }
}

function savePendingMarker(workspaceId: string, liveModelVersion: number): void {
  try {
    localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify({ workspaceId, liveModelVersion }));
  } catch {
    // A session can still finish the sync flow when browser storage is unavailable.
  }
}

function clearPendingMarker(): void {
  try { localStorage.removeItem(PENDING_SYNC_KEY); } catch { /* storage unavailable */ }
}

function cabinetKind(cabinet: Project['cabinets'][number]): string {
  const kind = cabinet.params.cabinetType ?? ((cabinet.params.mountHeight ?? 0) > 0 ? 'wall' : 'base');
  return kind === 'base' ? '地柜' : kind === 'wall' ? '吊柜' : kind === 'tall' ? '高柜' : kind === 'island' ? '岛台' : '其他柜体';
}

function DraftDrawingPreview(props: { snapshot: DraftSnapshot }): ReactNode {
  const groups = new Map<string, Project['cabinets']>();
  for (const cabinet of props.snapshot.project.cabinets) {
    const label = cabinetKind(cabinet);
    groups.set(label, [...(groups.get(label) ?? []), cabinet]);
  }
  return (
    <div className="remote-draft-preview" role="region" aria-label="MCP 草稿实时图纸预览">
      <div className="remote-draft-preview-head">
        <strong>网页实时预览：{props.snapshot.project.name}</strong>
        <span>{props.snapshot.project.rooms.length} 个房间 · {props.snapshot.project.cabinets.length} 台柜</span>
      </div>
      <div className="hint" data-testid="remote-draft-confirmation-metadata">
        预览确认快照：revision {props.snapshot.revision} · 本地 v{props.snapshot.localVersion} · 远端 v{props.snapshot.liveModelVersion}
        <div>draft hash（SHA-256）：<code style={{ overflowWrap: 'anywhere' }}>{props.snapshot.draftHash}</code></div>
      </div>
      {groups.size === 0 ? <div className="hint">草稿还没有柜体；创建房间、放入柜体后这里会自动刷新。</div> : null}
      {[...groups.entries()].map(([label, cabinets]) => (
        <section className="remote-draft-preview-group" key={label}>
          <h4>{label} · {cabinets.length} 台</h4>
          <div className="remote-draft-preview-cabinets">
            {cabinets.map((cabinet) => {
              let svg = '';
              try { svg = primsToSvg(buildCabinetViews(cabinet, RULESET, { x: 0, y: 0 }).prims.front, 'cabinet-view-svg'); } catch { /* keep name and dimensions visible for incomplete drafts */ }
              return (
                <figure key={cabinet.id}>
                  <figcaption>{cabinet.name}<small>{cabinet.params.width} × {cabinet.params.height} × {cabinet.params.depth} mm</small></figcaption>
                  <div className="remote-draft-preview-svg" role="img" aria-label={`${cabinet.name}正面预览`} dangerouslySetInnerHTML={{ __html: svg }} />
                </figure>
              );
            })}
          </div>
        </section>
      ))}
      {props.snapshot.validation ? (
        <div className={`remote-draft-preview-status ${props.snapshot.validation.blockingErrors ? 'has-errors' : ''}`}>
          {props.snapshot.validation.blockingErrors === 0 ? '当前草稿无阻断错误' : `当前有 ${props.snapshot.validation.blockingErrors} 个阻断错误`}
          <span> · 预览约每 2 秒刷新；这里只预览，尚未写入网页正式模型</span>
        </div>
      ) : null}
    </div>
  );
}

export function DraftsPanel(props: DraftsPanelProps): ReactNode {
  const { token, version, bus, onToast, onApplied, readOnly = false } = props;
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [liveVersion, setLiveVersion] = useState<number>(0);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingSync, setPendingSync] = useState<PendingRemoteSync | null>(null);
  const [previewDraftId, setPreviewDraftId] = useState<string | null>(null);
  const [previewSnapshot, setPreviewSnapshot] = useState<DraftSnapshot | null>(null);
  const [confirmationSnapshot, setConfirmationSnapshot] = useState<DraftSnapshot | null>(null);
  const [dismissedRemoteVersion, setDismissedRemoteVersion] = useState<number | null>(null);

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const j = await api<{ drafts?: DraftSummary[]; liveModelVersion?: number }>('/api/drafts', token);
      setDrafts(j.drafts ?? []);
      setLiveVersion(j.liveModelVersion ?? 0);
    } catch (e) {
      onToast('error', `服务端草稿列表加载失败：${e instanceof Error ? e.message : e}`);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [token, onToast]);

  useEffect(() => {
    void reload();
  }, [reload, version]);

  useEffect(() => {
    const timer = window.setInterval(() => { void reload(true); }, 2500);
    return () => window.clearInterval(timer);
  }, [reload]);

  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      try {
        const snapshot = await api<WorkspaceSnapshot>('/api/workspace', token);
        if (cancelled) return;
        setLiveVersion(snapshot.liveModelVersion);
        const differs = stableJson(snapshot.project) !== stableJson(bus.getState());
        if (differs && dismissedRemoteVersion !== snapshot.liveModelVersion) {
          setPendingSync((current) => current ?? {
            project: snapshot.project,
            workspaceId: snapshot.workspaceId,
            liveModelVersion: snapshot.liveModelVersion,
            originallyAppliedVersion: snapshot.liveModelVersion,
          });
        } else if (!differs) {
          setPendingSync((current) => current?.workspaceId === snapshot.workspaceId ? null : current);
          clearPendingMarker();
        }
      } catch { /* keep the last known status; manual refresh is still available */ }
    };
    void check();
    const timer = window.setInterval(() => { void check(); }, 3000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [token, bus, version, dismissedRemoteVersion]);

  useEffect(() => {
    if (!previewDraftId) return;
    let cancelled = false;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const remote = await api<Omit<DraftSnapshot, 'localVersion'>>(`/api/drafts/${encodeURIComponent(previewDraftId)}`, token);
        const snapshot: DraftSnapshot = { ...remote, localVersion: bus.getVersion() };
        if (!cancelled) setPreviewSnapshot((current) => {
          if (!current) return snapshot;
          const sameVisibleSnapshot = current.runId === snapshot.runId
            && current.revision === snapshot.revision
            && current.draftHash === snapshot.draftHash
            && current.liveModelVersion === snapshot.liveModelVersion
            && stableJson(current.project) === stableJson(snapshot.project);
          return sameVisibleSnapshot ? { ...current, localVersion: snapshot.localVersion } : snapshot;
        });
      } catch {
        if (!cancelled) {
          setPreviewDraftId(null);
          setPreviewSnapshot(null);
          void reload(true);
        }
      } finally { inFlight = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 1800);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [previewDraftId, token, reload, bus, version]);

  // If a prior apply was remote-only, restore the sync action after navigating away or reloading.
  useEffect(() => {
    let cancelled = false;
    const marker = readPendingMarker();
    if (!marker) return () => { cancelled = true; };
    void api<WorkspaceSnapshot>('/api/workspace', token).then((snapshot) => {
      if (cancelled || snapshot.workspaceId !== marker.workspaceId) return;
      setPendingSync({
        project: snapshot.project,
        workspaceId: snapshot.workspaceId,
        liveModelVersion: snapshot.liveModelVersion,
        originallyAppliedVersion: marker.liveModelVersion,
      });
    }).catch((e) => {
      if (!cancelled) onToast('error', `无法恢复远端同步状态：${e instanceof Error ? e.message : e}`);
    });
    return () => { cancelled = true; };
  }, [token, onToast]);

  useEffect(() => {
    const refresh = (): void => { void reload(); };
    window.addEventListener('furniture:server-drafts-updated', refresh);
    return () => window.removeEventListener('furniture:server-drafts-updated', refresh);
  }, [reload]);

  const onApply = async (snapshot: DraftSnapshot): Promise<void> => {
    if (readOnly) return;
    if (!snapshot.canApply) {
      onToast('error', '当前预览对应的草稿已过期或基线不一致，请读取最新预览后再确认。');
      return;
    }
    setBusy(snapshot.draftId);
    try {
      // The confirmation payload is bound to the immutable preview the user saw; this workspace
      // read is only for safe local-sync eligibility and never replaces the preview metadata.
      const before = await api<WorkspaceSnapshot>('/api/workspace', token);
      const localBefore = structuredClone(bus.getState());
      const baselineMatches = before.liveModelVersion === snapshot.liveModelVersion
        && bus.getVersion() === snapshot.localVersion
        && stableJson(before.project) === stableJson(localBefore);

      const applied = await api<{
        newVersion: number;
        liveModelVersion?: number;
        workspaceId?: string;
        project?: Project;
      }>(`/api/drafts/${encodeURIComponent(snapshot.draftId)}/apply`, token, 'POST', {
        syncId: `draft:${snapshot.draftId}`,
        runId: snapshot.runId,
        draftId: snapshot.draftId,
        revision: snapshot.revision,
        draftHash: snapshot.draftHash,
        localVersion: snapshot.localVersion,
        remoteVersion: snapshot.liveModelVersion,
        baseModelVersion: snapshot.baseModelVersion,
        baseProjectHash: snapshot.baseProjectHash,
      });
      const after = applied.project
        ? {
            project: applied.project,
            liveModelVersion: applied.liveModelVersion ?? applied.newVersion,
            workspaceId: applied.workspaceId ?? before.workspaceId,
          }
        : await api<WorkspaceSnapshot>('/api/workspace', token);

      if (baselineMatches && bus.getVersion() === snapshot.localVersion) {
        bus.replaceProject(after.project, `apply remote draft ${snapshot.draftId}`);
        clearPendingMarker();
        setPendingSync(null);
        await reload();
        onToast('ok', `已应用到服务器并同步到本地；房间卡片已更新（本地模型 v${bus.getVersion()}）。`);
        onApplied();
      } else {
        setPendingSync({
          project: after.project,
          workspaceId: after.workspaceId,
          liveModelVersion: after.liveModelVersion,
          originallyAppliedVersion: after.liveModelVersion,
        });
        savePendingMarker(after.workspaceId, after.liveModelVersion);
        await reload();
        onToast('info', `草稿已应用到远端服务器工作区 v${after.liveModelVersion}；浏览器本地模型 v${bus.getVersion()} 未改变。两端基线不一致或本地在预览后有更改，请在此单独确认同步。`);
      }
    } catch (e) {
      onToast('error', `应用服务端草稿失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const onSyncRemote = async (): Promise<void> => {
    if (!pendingSync || readOnly) return;
    setBusy('__sync__');
    try {
      const current = await api<WorkspaceSnapshot>('/api/workspace', token);
      const localVersionBefore = bus.getVersion();
      const localName = bus.getState().name;
      const replacingName = current.project.name;
      if (!confirm(
        `将服务器工作区「${replacingName}」v${current.liveModelVersion} 整体替换浏览器本地项目「${localName}」（本地模型 v${localVersionBefore}）？本地未同步的房间、柜体和修改将被覆盖。此操作只在你明确确认后执行。`,
      )) return;

      const latest = await api<WorkspaceSnapshot>('/api/workspace', token);
      if (latest.workspaceId !== current.workspaceId || latest.liveModelVersion !== current.liveModelVersion) {
        throw new Error('确认期间服务端工作区或版本发生变化，未同步；请刷新后重新检查。');
      }
      if (bus.getVersion() !== localVersionBefore) {
        throw new Error('确认期间浏览器本地模型发生变化，未覆盖本地；请检查后重试。');
      }
      bus.replaceProject(latest.project, `sync server workspace v${latest.liveModelVersion}`);
      clearPendingMarker();
      setPendingSync(null);
      await reload();
      onToast('ok', `已将服务器工作区 v${latest.liveModelVersion} 同步到本地；本地模型 v${bus.getVersion()}，房间卡片已刷新。`);
      onApplied();
    } catch (e) {
      onToast('error', `同步到本地失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const onDiscard = async (d: DraftSummary): Promise<void> => {
    if (readOnly) return;
    if (!confirm(`丢弃服务端草稿「${d.draftId}」？此操作不可撤销。`)) return;
    setBusy(d.draftId);
    try {
      await api(`/api/drafts/${encodeURIComponent(d.draftId)}/discard`, token, 'POST');
      onToast('ok', '服务端草稿已丢弃');
      await reload();
    } catch (e) {
      onToast('error', `丢弃失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  };

  const onPreview = async (d: DraftSummary): Promise<void> => {
    try {
      const remote = await api<Omit<DraftSnapshot, 'localVersion'>>(`/api/drafts/${encodeURIComponent(d.draftId)}`, token);
      const snapshot: DraftSnapshot = { ...remote, localVersion: bus.getVersion() };
      setConfirmationSnapshot(null);
      setPreviewDraftId(d.draftId);
      setPreviewSnapshot(snapshot);
    } catch (e) {
      onToast('error', `读取 MCP 草稿预览失败：${e instanceof Error ? e.message : e}`);
    }
  };

  return (
    <Section title="服务端草稿">
      {readOnly ? <div className="alert alert-warn" role="note">历史重复 Unit ID 项目处于只读浏览模式；草稿应用、同步和丢弃均已禁用，须显式修复/迁移后恢复。</div> : null}
      <div className="hint">
        Agent / MCP 草稿保存在远端服务器工作区。确认应用会先更新服务器；仅当浏览器本地与服务端基线一致时才自动同步本地，否则会明确提示并要求单独确认替换，不会把远端 live 静默冒充成本地已更新。
      </div>
      <div className="row">
        <button type="button" className="btn" onClick={() => void reload()} disabled={loading}>
          {loading ? '加载中…' : '刷新远端草稿'}
        </button>
        <Pill kind="INFO">服务器 live v{liveVersion}</Pill>
      </div>

      {previewSnapshot ? (
        <>
          <div className="row" style={{ marginTop: 8 }}>
            <Pill kind="INFO">预览草稿 {previewSnapshot.draftId}</Pill>
            <button type="button" className="btn" onClick={() => { setPreviewDraftId(null); setPreviewSnapshot(null); setConfirmationSnapshot(null); }}>关闭预览</button>
          </div>
          <DraftDrawingPreview snapshot={previewSnapshot} />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={readOnly || busy !== null || !previewSnapshot.canApply}
              onClick={() => setConfirmationSnapshot(structuredClone(previewSnapshot))}
            >
              确认应用到服务器
            </button>
            {!previewSnapshot.canApply ? <span className="hint">此预览已过期，不能确认应用；请重新创建草稿。</span> : null}
          </div>
        </>
      ) : null}

      {confirmationSnapshot ? (
        <div style={{ position: 'fixed', inset: 0, zIndex: 3000, display: 'grid', placeItems: 'center', padding: 20, background: 'rgba(0, 0, 0, 0.38)' }}>
        <div
          className="card remote-draft-confirmation"
          role="dialog"
          aria-modal="true"
          aria-label="确认应用服务端草稿"
          style={{ width: 'min(640px, calc(100vw - 40px))', maxHeight: '80vh', overflowY: 'auto', borderColor: 'var(--warn)', background: 'var(--panel, white)' }}
        >
          <strong>确认将服务端草稿「{confirmationSnapshot.draftId}」应用到服务器工作区？</strong>
          <div className="hint">
            本次只确认你已查看的预览快照：runId {confirmationSnapshot.runId} · revision {confirmationSnapshot.revision}
            <br />draft hash（SHA-256）：<code style={{ overflowWrap: 'anywhere' }}>{confirmationSnapshot.draftHash}</code>
            <br />本地 v{confirmationSnapshot.localVersion} · 远端 v{confirmationSnapshot.liveModelVersion}
            <br />确认期间草稿如有更新，本次旧确认会被拒绝，不会自动改用新版。
          </div>
          <div className="row">
            <button type="button" className="btn" disabled={busy !== null} onClick={() => setConfirmationSnapshot(null)}>
              返回预览
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={readOnly || busy !== null || !confirmationSnapshot.canApply}
              onClick={() => {
                const confirmed = confirmationSnapshot;
                setConfirmationSnapshot(null);
                void onApply(confirmed);
              }}
            >
              {busy === confirmationSnapshot.draftId ? '处理中…' : '确认应用这份预览'}
            </button>
          </div>
        </div>
        </div>
      ) : null}

      {pendingSync ? (
        <div className="card remote-sync-card" role="status" style={{ marginTop: 8, borderColor: 'var(--warn)' }}>
          <div className="row">
            <strong>服务器项目与网页当前项目不一致</strong>
            <Pill kind="WARNING">服务器 v{pendingSync.liveModelVersion}</Pill>
          </div>
          <div className="hint">
            MCP 导出使用服务器 live；网页导出使用当前网页项目。同步会整体替换网页项目，因此先核对项目和房间，再决定是否覆盖本地未同步修改。
          </div>
          <div className="row">
            <button type="button" className="btn" disabled={readOnly || busy !== null} onClick={() => void onSyncRemote()}>
              {busy === '__sync__' ? '同步中…' : '确认将服务器项目同步到本地'}
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => { setDismissedRemoteVersion(pendingSync.liveModelVersion); setPendingSync(null); }}>
              稍后处理
            </button>
          </div>
        </div>
      ) : null}

      {drafts.length === 0 && !loading ? (
        <div className="hint">暂无远端草稿。Agent / MCP 写入时会在服务器工作区创建。</div>
      ) : null}
      {drafts.map((d) => {
        const stale = d.baseModelVersion !== liveVersion;
        const isBusy = busy === d.draftId || busy === '__sync__';
        return (
          <div key={d.draftId} className="card" style={{ marginTop: 8 }}>
            <div className="row">
              <Text mono>{d.draftId}</Text>
              {stale ? <Pill kind="WARNING">远端版本已过期</Pill> : <Pill kind="ok">可应用到服务器</Pill>}
            </div>
            <div className="hint">
              创建者 {d.owner} · {fmtTime(d.createdAt)}
              {stale ? ` · 基于服务器版本 v${d.baseModelVersion}（当前 v${liveVersion}）` : ''}
            </div>
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={isBusy}
                onClick={() => void onPreview(d)}
              >
                {previewDraftId === d.draftId ? '刷新网页预览' : '网页实时预览'}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={readOnly || isBusy}
                onClick={() => void onDiscard(d)}
              >
                丢弃远端草稿
              </button>
            </div>
          </div>
        );
      })}
    </Section>
  );
}
