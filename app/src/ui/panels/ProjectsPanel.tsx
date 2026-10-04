/**
 * 项目目录面板 —— 多项目管理树
 *
 * 结构：
 *   📁 某某小区李先生（当前）
 *      🏠 客厅
 *      🏠 主卧
 *   📁 另一个项目
 *      🏠 厨房（2 间房）
 *
 * 操作：新建项目 / 切换项目 / 删除项目 / 在当前项目下新建房间
 */
import { useCallback, useEffect, useState } from 'react';

interface ProjectInfo {
  id: string;
  name: string;
  roomCount: number;
  cabinetCount: number;
  updatedAt: number;
  isActive: boolean;
  broken?: boolean;
}

interface RoomInfo {
  id: string;
  name: string;
}

interface Props {
  token?: string | null;
  /** 当前项目的房间列表（从 workspace 来） */
  rooms: RoomInfo[];
  onToast?: (kind: 'info' | 'error' | 'ok' | 'warn', msg: string) => void;
  /** 切换项目后回调（需刷新） */
  onProjectSwitched?: () => void;
  /** 从服务端载入工作区后回调（父组件用 bus.replaceProject 装载） */
  onWorkspaceLoaded?: (project: any) => void;
  /** 新建房间：调用方提供实现（走命令总线） */
  onCreateRoom?: (name: string) => void;
  /** 点击房间回调 */
  onFocusRoom?: (roomId: string) => void;
}

export function ProjectsPanel(props: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [showNewRoom, setShowNewRoom] = useState(false);

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch('/api/projects', {
        headers: props.token ? { Authorization: `Bearer ${props.token}` } : {},
      });
      const j = await r.json();
      if (j.ok) setProjects(j.projects);
    } catch {
      /* 忽略 */
    } finally {
      setLoading(false);
    }
  }, [props.token]);

  useEffect(() => { void fetchProjects(); }, [fetchProjects]);

  const [loadingWs, setLoadingWs] = useState(false);
  const loadFromServer = useCallback(async () => {
    if (!confirm('从服务端载入当前账号的工作区？\n\n本地未保存的修改会被服务端版本覆盖。')) return;
    setLoadingWs(true);
    try {
      const r = await fetch('/api/workspace', {
        headers: props.token ? { Authorization: `Bearer ${props.token}` } : {},
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || '载入失败');
      props.onWorkspaceLoaded?.(j.project);
      props.onToast?.('ok', `已从服务端载入：${j.project.rooms?.length ?? 0} 房间 / ${j.project.cabinets?.length ?? 0} 柜体（live v${j.liveModelVersion}）`);
    } catch (e) {
      props.onToast?.('error', `载入失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setLoadingWs(false);
    }
  }, [props]);

  const createProject = useCallback(async () => {
    const name = newName.trim();
    if (!name) {
      props.onToast?.('error', '请输入项目名称');
      return;
    }
    try {
      const r = await fetch('/api/projects', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(props.token ? { Authorization: `Bearer ${props.token}` } : {}),
        },
        body: JSON.stringify({ name }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      props.onToast?.('ok', `项目「${name}」已创建`);
      setNewName('');
      setShowNew(false);
      setProjects(j.projects);
    } catch (e) {
      props.onToast?.('error', `创建失败：${e instanceof Error ? e.message : e}`);
    }
  }, [newName, props]);

  const activateProject = useCallback(async (id: string, name: string) => {
    if (!confirm(`切换到项目「${name}」？\n\n当前未保存的修改会丢失，切换后页面将刷新。`)) return;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(id)}/activate`, {
        method: 'POST',
        headers: props.token ? { Authorization: `Bearer ${props.token}` } : {},
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      props.onToast?.('ok', j.message || '已切换项目');
      // 刷新页面加载新项目
      setTimeout(() => window.location.reload(), 800);
      props.onProjectSwitched?.();
    } catch (e) {
      props.onToast?.('error', `切换失败：${e instanceof Error ? e.message : e}`);
    }
  }, [props]);

  const deleteProject = useCallback(async (id: string, name: string) => {
    if (!confirm(`删除项目「${name}」？\n\n该操作不可恢复！`)) return;
    try {
      const r = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: props.token ? { Authorization: `Bearer ${props.token}` } : {},
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      props.onToast?.('ok', `项目「${name}」已删除`);
      setProjects(j.projects);
    } catch (e) {
      props.onToast?.('error', `删除失败：${e instanceof Error ? e.message : e}`);
    }
  }, [props]);

  const activeProject = projects.find(p => p.isActive);

  return (
    <div className="projects-panel">
      <div className="projects-head">
        <span className="projects-title">项目目录</span>
        <button
          type="button"
          className="tb-btn small"
          onClick={() => void loadFromServer()}
          disabled={loadingWs}
          title="从服务端拉取当前账号的工作区（MCP/其他端写入的数据）"
        >
          {loadingWs ? '载入中…' : '⟳ 从服务端载入'}
        </button>
        <button
          type="button"
          className="tb-btn small"
          onClick={() => setShowNew(!showNew)}
          title="新建项目（如：某某小区李先生）"
        >
          ＋ 新建项目
        </button>
      </div>

      {showNew ? (
        <div className="projects-new">
          <input
            type="text"
            className="tb-input"
            placeholder="项目名称，如：某某小区李先生"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void createProject(); }}
            autoFocus
          />
          <div className="btn-row">
            <button type="button" className="tb-btn primary small" onClick={() => void createProject()}>
              创建
            </button>
            <button type="button" className="tb-btn small" onClick={() => { setShowNew(false); setNewName(''); }}>
              取消
            </button>
          </div>
        </div>
      ) : null}

      {loading ? <div className="muted-sm">加载中…</div> : null}

      <div className="projects-tree">
        {projects.map(p => (
          <div key={p.id} className={`project-node ${p.isActive ? 'active' : ''}`}>
            <div className="project-head">
              <span className="project-icon">{p.isActive ? '📂' : '📁'}</span>
              <span className="project-name" title={p.id}>
                {p.name}
                {p.isActive ? <span className="active-tag">（当前）</span> : null}
              </span>
              <span className="project-meta muted-sm">
                {p.roomCount} 房 · {p.cabinetCount} 柜
              </span>
            </div>

            {/* 当前项目的房间列表 */}
            {p.isActive ? (
              <div className="project-rooms">
                {props.rooms.map(r => (
                  <div
                    key={r.id}
                    className="room-node"
                    onClick={() => props.onFocusRoom?.(r.id)}
                    title="点击定位到该房间"
                  >
                    <span className="room-icon">🏠</span>
                    <span className="room-name">{r.name}</span>
                  </div>
                ))}
                {props.rooms.length === 0 ? (
                  <div className="muted-sm">暂无房间</div>
                ) : null}
                {showNewRoom ? (
                  <div className="room-new">
                    <input
                      type="text"
                      className="tb-input"
                      placeholder="房间名称，如：客厅"
                      value={newRoomName}
                      onChange={e => setNewRoomName(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && newRoomName.trim()) {
                          props.onCreateRoom?.(newRoomName.trim());
                          setNewRoomName('');
                          setShowNewRoom(false);
                        }
                      }}
                      autoFocus
                    />
                    <div className="btn-row">
                      <button
                        type="button"
                        className="tb-btn primary small"
                        disabled={!newRoomName.trim()}
                        onClick={() => {
                          props.onCreateRoom?.(newRoomName.trim());
                          setNewRoomName('');
                          setShowNewRoom(false);
                        }}
                      >
                        创建
                      </button>
                      <button
                        type="button"
                        className="tb-btn small"
                        onClick={() => { setShowNewRoom(false); setNewRoomName(''); }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="tb-btn small"
                    onClick={() => setShowNewRoom(true)}
                    title="在当前项目下新建房间"
                  >
                    ＋ 新建房间
                  </button>
                )}
              </div>
            ) : (
              <div className="project-rooms collapsed muted-sm">
                {p.roomCount} 个房间
              </div>
            )}

            <div className="project-actions btn-row">
              {!p.isActive ? (
                <button
                  type="button"
                  className="tb-btn small"
                  onClick={() => void activateProject(p.id, p.name)}
                  title="切换到该项目"
                >
                  切换
                </button>
              ) : null}
              {!p.isActive ? (
                <button
                  type="button"
                  className="tb-btn small danger"
                  onClick={() => void deleteProject(p.id, p.name)}
                  title="删除该项目（不可恢复）"
                >
                  删除
                </button>
              ) : null}
            </div>
          </div>
        ))}
        {projects.length === 0 && !loading ? (
          <div className="muted-sm">暂无项目，点击「新建项目」开始</div>
        ) : null}
      </div>

      {activeProject ? (
        <div className="muted-sm projects-hint">
          当前项目：{activeProject.name}
        </div>
      ) : null}
    </div>
  );
}
