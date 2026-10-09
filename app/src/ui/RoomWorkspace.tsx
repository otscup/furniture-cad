import { lazy, Suspense, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { CommandBus } from '../core/commandBus.ts';
import { assemblyConfirmationStatus } from '../core/assemblyConfirmation.ts';
import { confirmAssembly } from '../core/commands.ts';
import { buildCabinetViews } from '../core/geometry/views.ts';
import { allUnits } from '../core/layoutModel.ts';
import { displayGroupsForRoom, indexProjectRooms } from '../core/roomIndex.ts';
import { CABINET_TEMPLATES } from '../core/templates.ts';
import type { Project, RuleSet } from '../core/types.ts';
import { primsToSvg } from '../export/roomBook.ts';
import { SharedPanelsPanel } from './SharedPanelsPanel.tsx';

const ThreeViewport = lazy(() => import('./ThreeViewport.tsx').then((module) => ({ default: module.ThreeViewport })));

type CabinetPreset = {
  id: string;
  name: string;
  hint: string;
  templateId: string;
  width: number;
  height: number;
  depth: number;
};

const CABINET_PRESETS: CabinetPreset[] = [
  { id: 'kitchen-base', name: '厨房地柜', hint: '常见台面下柜体，850 高、600 进深', templateId: 'default', width: 900, height: 850, depth: 600 },
  { id: 'kitchen-wall', name: '厨房吊柜', hint: '挂墙矮柜，700 高、350 进深', templateId: 'wall_cabinet', width: 1200, height: 700, depth: 350 },
  ...CABINET_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name,
    hint: template.hint,
    templateId: template.id,
    width: template.params.width,
    height: template.params.height,
    depth: template.params.depth,
  })),
];

export function WorkspaceTopBar(props: {
  project: Project;
  onOpenCad: () => void;
  onNewRoom: () => void;
  onExport: () => void;
  onOpenRemoteDrafts: () => void;
  productionExportBlocked?: boolean;
  readOnly?: boolean;
  remoteStatus: { draftCount: number; differs: boolean; liveModelVersion: number } | null;
}): ReactNode {
  return (
    <header className="workspace-topbar">
      <div className="workspace-brand">
        <span className="workspace-brand-mark">▦</span>
        <strong>家具设计</strong>
        <span className="workspace-brand-project">{props.project.name}</span>
      </div>
      <div className="workspace-top-meta">
        <span>{props.project.rooms.length} 个房间</span>
        <span>{props.project.cabinets.length} 个柜体</span>
      </div>
      <div className="workspace-top-actions">
        <button type="button" className="workspace-button workspace-button-quiet" onClick={props.onNewRoom} disabled={props.readOnly} title={props.readOnly ? '历史重复 Unit ID 项目只读；须显式修复/迁移后才能创建' : undefined}>
          ＋ 房间
        </button>
        <button type="button" className="workspace-button workspace-button-quiet" onClick={props.onExport} disabled={props.readOnly || props.productionExportBlocked} data-testid="workspace-export-button" title={props.readOnly ? '历史重复 Unit ID 项目只读；生产导出已禁用' : props.productionExportBlocked ? '共享件规格仍在编辑；确认保存或取消后才能导出' : undefined}>
          导出图纸
        </button>
        <button type="button" className={`workspace-button ${props.remoteStatus?.differs ? 'workspace-button-warning' : 'workspace-button-quiet'}`} onClick={props.onOpenRemoteDrafts} title={`服务器 live v${props.remoteStatus?.liveModelVersion ?? '—'}；点击查看 MCP 草稿或同步`}>
          {props.remoteStatus?.differs ? `网页/服务器不同步${props.remoteStatus.draftCount ? ` · 草稿 ${props.remoteStatus.draftCount}` : ''}` : props.remoteStatus?.draftCount ? `MCP 草稿 ${props.remoteStatus.draftCount}` : 'MCP / 同步'}
        </button>
        <button type="button" className="workspace-button workspace-button-primary" onClick={props.onOpenCad} disabled={props.readOnly} title={props.readOnly ? '历史重复 Unit ID 项目只读；须显式修复/迁移后才能编辑' : '打开高级 CAD 二维编辑视图'}>
          高级 CAD 编辑
        </button>
      </div>
    </header>
  );
}

export function RoomWorkspace(props: {
  project: Project;
  rules: RuleSet;
  bus: CommandBus;
  version: number;
  selection: string[];
  setSelection: (ids: string[]) => void;
  selectedRoomId: string;
  roomSelectionMessage: string;
  onRoomChange: (roomId: string) => void;
  onOpenCad: (cabinetId?: string, roomId?: string) => void;
  onCreateCabinet: (request: { roomId: string; name: string; templateId: string; params: { width: number; height: number; depth: number } }) => boolean;
  onSaveSharedPanels: (panels: NonNullable<Project['sharedPanels']>, label: string) => void;
  onSharedPanelDraftChange: (open: boolean) => void;
  readOnly?: boolean;
  accountConnected: boolean;
  onAccountOpen: () => void;
  children?: ReactNode;
}): ReactNode {
  const groups = useMemo(() => indexProjectRooms(props.project), [props.project]);
  const [threeCabinetId, setThreeCabinetId] = useState<string | null>(null);
  const [showCabinetForm, setShowCabinetForm] = useState(false);
  const [presetId, setPresetId] = useState('kitchen-base');
  const [cabinetName, setCabinetName] = useState('厨房地柜');
  const [dimensions, setDimensions] = useState({ width: 900, height: 850, depth: 600 });
  const activeRoom = groups.find((group) => group.room.id === props.selectedRoomId);
  const canAddCabinet = !!activeRoom && !activeRoom.unassigned && props.project.rooms.some((room) => room.id === activeRoom.room.id);
  const active3DCabinet = props.project.cabinets.find((cabinet) => cabinet.id === threeCabinetId);
  const selectedPreset = CABINET_PRESETS.find((preset) => preset.id === presetId);
  const cabinetGroups = useMemo(() => activeRoom
    ? displayGroupsForRoom(props.project, activeRoom.room.id, activeRoom.cabinets)
    : [], [props.project, activeRoom]);
  const roomAssemblies = useMemo(() => activeRoom && !activeRoom.unassigned
    ? (props.project.assemblies ?? []).filter((assembly) => assembly.roomId === activeRoom.room.id)
    : [], [props.project, activeRoom]);
  const [selectedAssemblyId, setSelectedAssemblyId] = useState('');
  const [pendingAssemblyId, setPendingAssemblyId] = useState<string | null>(null);
  const [assemblyConfirmationMessage, setAssemblyConfirmationMessage] = useState('');
  const selectedAssembly = roomAssemblies.find((assembly) => assembly.id === selectedAssemblyId) ?? roomAssemblies[0];
  const pendingAssembly = roomAssemblies.find((assembly) => assembly.id === pendingAssemblyId);
  const selectedAssemblyStatus = selectedAssembly ? assemblyConfirmationStatus(selectedAssembly) : null;
  const selectedAssemblyMembers = selectedAssembly?.memberIds.map((id) => props.project.cabinets.find((cabinet) => cabinet.id === id)) ?? [];
  const selectedAssemblyIsValid = !!selectedAssembly && selectedAssembly.memberIds.length > 0 &&
    selectedAssemblyMembers.every((cabinet) => cabinet?.roomId === selectedAssembly.roomId) &&
    selectedAssembly.roomId === activeRoom?.room.id && Array.isArray(selectedAssembly.connections);
  const confirmPendingAssembly = (): void => {
    if (!pendingAssembly || props.readOnly) return;
    const readOnlyReason = props.bus.getUnitIdentityConflict();
    if (readOnlyReason) {
      setAssemblyConfirmationMessage(`无法确认：${readOnlyReason}`);
      return;
    }
    const result = props.bus.execute(confirmAssembly(pendingAssembly.id, pendingAssembly.name));
    if (!result.ok) {
      setAssemblyConfirmationMessage(`确认失败：${result.error ?? 'CommandBus 拒绝了这次确认'}`);
      return;
    }
    setPendingAssemblyId(null);
    setAssemblyConfirmationMessage(`已明确确认「${pendingAssembly.name}」；只影响连续浏览，不改变逐柜生产图。`);
  };

  const cabinetViews = useMemo(() => {
    const output = new Map<string, { front: string; internal: string; top: string; error?: string }>();
    for (const cabinet of props.project.cabinets) {
      try {
        const views = buildCabinetViews(cabinet, props.rules, { x: 0, y: 0 });
        output.set(cabinet.id, {
          front: primsToSvg(views.prims.front, 'cabinet-view-svg'),
          internal: primsToSvg(views.prims.internal, 'cabinet-view-svg'),
          top: primsToSvg(views.prims.top, 'cabinet-view-svg'),
        });
      } catch (error) {
        output.set(cabinet.id, { front: '', internal: '', top: '', error: error instanceof Error ? error.message : String(error) });
      }
    }
    return output;
  }, [props.project, props.rules, props.version]);

  const viewSpecs = [
    { key: 'front' as const, title: '外观正面', note: '带门板' },
    { key: 'internal' as const, title: '内部结构', note: '去掉门板' },
    { key: 'top' as const, title: '俯视图', note: '柜体进深与宽度' },
  ];

  const openCabinetForm = (): void => {
    if (!canAddCabinet || props.readOnly) return;
    const preset = CABINET_PRESETS.find((item) => item.id === 'kitchen-base')!;
    setPresetId(preset.id);
    setDimensions({ width: preset.width, height: preset.height, depth: preset.depth });
    setCabinetName(`${preset.name} ${(activeRoom?.cabinets.length ?? 0) + 1}`);
    setShowCabinetForm(true);
  };

  const selectPreset = (id: string): void => {
    const preset = CABINET_PRESETS.find((item) => item.id === id);
    if (!preset) return;
    setPresetId(preset.id);
    setDimensions({ width: preset.width, height: preset.height, depth: preset.depth });
    setCabinetName(`${preset.name} ${(activeRoom?.cabinets.length ?? 0) + 1}`);
  };

  const submitCabinet = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canAddCabinet || !activeRoom || props.readOnly) return;
    const preset = CABINET_PRESETS.find((item) => item.id === presetId);
    if (!preset) return;
    const created = props.onCreateCabinet({
      roomId: activeRoom.room.id,
      name: cabinetName,
      templateId: preset.templateId,
      params: {
        width: Math.max(1, Math.round(dimensions.width)),
        height: Math.max(1, Math.round(dimensions.height)),
        depth: Math.max(1, Math.round(dimensions.depth)),
      },
    });
    if (created) setShowCabinetForm(false);
  };

  return (
    <div className="room-workspace">
      <aside className="workspace-room-list" aria-label="房间列表">
        <div className="workspace-room-list-head">
          <strong>房间</strong>
          <span>{groups.length}</span>
        </div>
        <div className="workspace-room-list-items">
          {groups.map((group) => (
            <button
              type="button"
              key={group.room.id}
              className={`workspace-room-item ${activeRoom?.room.id === group.room.id ? 'selected' : ''}`}
              onClick={() => props.onRoomChange(group.room.id)}
            >
              <span className="workspace-room-item-name">{group.room.name}</span>
              <span className="workspace-room-item-count">{group.cabinets.length}</span>
            </button>
          ))}
          {groups.length === 0 ? <div className="workspace-room-empty">还没有房间</div> : null}
        </div>
        <button type="button" className="workspace-account-button" onClick={props.onAccountOpen} title={props.accountConnected ? '账户设置' : '登录 / 账户设置'} aria-label={props.accountConnected ? '账户设置' : '登录 / 账户设置'}>
          <span className="workspace-account-avatar" aria-hidden="true">
            {props.accountConnected ? '我' : <svg viewBox="0 0 24 24" focusable="false"><circle cx="12" cy="8" r="3.5" /><path d="M5 20c.7-3.5 3.3-5.3 7-5.3s6.3 1.8 7 5.3" /></svg>}
          </span>
          <span className="workspace-account-label">{props.accountConnected ? '账户设置' : '登录 / 账户'}</span>
          <span className="workspace-account-chevron">›</span>
        </button>
      </aside>

      <main className="workspace-room-content">
        <section className="workspace-room-design" aria-label="房间柜体设计">
          {activeRoom ? (
            <>
              <div className="workspace-room-heading">
                <div>
                  <div className="workspace-eyebrow">房间设计</div>
                  <h1>{activeRoom.room.name}</h1>
                  {activeRoom.room.note ? <p className="workspace-room-note">备注：{activeRoom.room.note}</p> : null}
                  <p>按地柜、吊柜等集中展示整组；每台柜仍可单独编辑，逐柜生产图保持独立交付。</p>
                </div>
                <div className="workspace-room-actions">
                  {canAddCabinet ? (
                    <button type="button" className="workspace-button workspace-button-primary" onClick={openCabinetForm} disabled={props.readOnly} title={props.readOnly ? '历史重复 Unit ID 项目只读；须显式修复/迁移后才能创建' : undefined}>
                      ＋ 添加柜体
                    </button>
                  ) : null}
                  <button type="button" className="workspace-button workspace-button-quiet" onClick={() => props.onOpenCad(undefined, activeRoom.room.id)} disabled={props.readOnly} title={props.readOnly ? '历史重复 Unit ID 项目只读；须显式修复/迁移后才能编辑' : '旧版 CAD 高级编辑入口继续保留'}>
                    高级 CAD
                  </button>
                </div>
              </div>
              {!activeRoom.unassigned ? (
                <SharedPanelsPanel
                  project={props.project}
                  roomId={activeRoom.room.id}
                  roomName={activeRoom.room.name}
                  rules={props.rules}
                  onSave={props.onSaveSharedPanels}
                  onDraftStateChange={props.onSharedPanelDraftChange}
                  readOnly={props.readOnly}
                />
              ) : null}
              {activeRoom.unassigned ? (
                <div className="workspace-unassigned-notice" role="note">
                  <strong>未分配房间中不能添加柜体</strong>
                  <p>这些柜体引用的房间已不存在。请先在左侧选择一个真实房间后再添加；现有柜体归属不会自动改到默认房间。</p>
                </div>
              ) : null}

              {roomAssemblies.length > 0 ? (
                <section className="workspace-assembly-confirmation" aria-label="装配组明确确认" data-testid="assembly-confirmation-panel">
                  <header>
                    <div><strong>装配组确认</strong><span>只确认连续浏览语义；不改变柜体 ID、尺寸或单柜生产图</span></div>
                  </header>
                  <div className="workspace-assembly-confirmation-controls">
                    <label>
                      选择装配组
                      <select
                        className="input"
                        aria-label="选择待确认装配组"
                        data-testid="assembly-confirmation-select"
                        value={selectedAssembly?.id ?? ''}
                        onChange={(event) => { setSelectedAssemblyId(event.target.value); setAssemblyConfirmationMessage(''); }}
                      >
                        {roomAssemblies.map((assembly) => {
                          const status = assemblyConfirmationStatus(assembly);
                          const label = status === 'confirmed' ? '已确认' : status === 'stale' ? '确认已失效，需重确认' : '未确认';
                          return <option key={assembly.id} value={assembly.id}>{assembly.name} · {label}</option>;
                        })}
                      </select>
                    </label>
                    {selectedAssemblyStatus !== 'confirmed' ? (
                      <button
                        type="button"
                        className="workspace-button workspace-button-primary"
                        data-testid="assembly-confirm-start"
                        disabled={props.readOnly || !selectedAssemblyIsValid}
                        title={props.readOnly ? '历史重复 Unit ID 项目只读；装配确认已禁用' : !selectedAssemblyIsValid ? '装配组成员必须完整且属于当前房间' : undefined}
                        onClick={() => { setAssemblyConfirmationMessage(''); setPendingAssemblyId(selectedAssembly?.id ?? null); }}
                      >
                        {selectedAssemblyStatus === 'stale' ? '重新确认装配组' : '确认装配组'}
                      </button>
                    ) : <span className="workspace-assembly-confirmed-label" role="status">该装配组已确认</span>}
                  </div>
                  {selectedAssembly ? (
                    <p className="workspace-assembly-confirmation-note" role="note">
                      当前：{selectedAssembly.name} · {selectedAssembly.memberIds.length} 台柜体 · {selectedAssemblyStatus === 'confirmed' ? '确认有效' : selectedAssemblyStatus === 'stale' ? '成员或连接已变化，原确认失效' : '尚未确认'}
                    </p>
                  ) : null}
                  {assemblyConfirmationMessage ? <p className="workspace-assembly-confirmation-result" role="status">{assemblyConfirmationMessage}</p> : null}
                </section>
              ) : null}

              {activeRoom.cabinets.length > 0 ? (
                <div className="workspace-cabinet-groups">
                  {cabinetGroups.map((group) => (
                    <section className="workspace-cabinet-group" key={group.id} aria-label={`${group.name}组合`} data-cabinet-group={group.id}>
                      <header className="workspace-cabinet-group-head">
                        <div><strong>{group.name}</strong><span>{group.cabinets.length} 台</span></div>
                        <span>
                          按柜型集中展示
                          {group.assemblyNames.length > 0 ? ` · 已确认连续组：${[...new Set(group.assemblyNames)].join('、')}` : ''}
                        </span>
                      </header>
                      {group.confirmedAssemblies.map((assembly) => {
                        const assemblyMembers = assembly.memberIds
                          .map((id) => props.project.cabinets.find((cabinet) => cabinet.id === id))
                          .filter((cabinet): cabinet is NonNullable<typeof cabinet> => Boolean(cabinet));
                        return (
                          <section className="workspace-confirmed-assembly-preview" key={assembly.id} data-testid="confirmed-assembly-preview" data-confirmed-assembly-id={assembly.id} aria-label={`${assembly.name}已确认连续装配组`}>
                            <header><strong>{assembly.name}</strong><span>已确认连续组 · {assemblyMembers.length} 台</span></header>
                            <div className="workspace-cabinet-run-preview" aria-label={`${assembly.name}连续装配预览`}>
                              {assemblyMembers.map((cabinet) => {
                                const views = cabinetViews.get(cabinet.id);
                                return (
                                  <figure className="workspace-cabinet-run-item" key={cabinet.id} data-assembly-member-id={cabinet.id}>
                                    <figcaption>{cabinet.name}</figcaption>
                                    <div className="workspace-cabinet-run-svg" role="img" aria-label={`${cabinet.name}正面预览`} dangerouslySetInnerHTML={{ __html: views?.front ?? '' }} />
                                    <small>{cabinet.params.width} × {cabinet.params.height} mm</small>
                                  </figure>
                                );
                              })}
                            </div>
                          </section>
                        );
                      })}
                      <div className="workspace-cabinet-independent-preview" aria-label={`${group.name}各柜独立立面预览`}>
                        {group.cabinets.map((cabinet) => {
                          const views = cabinetViews.get(cabinet.id);
                          return (
                            <figure className="workspace-cabinet-independent-item" key={cabinet.id} data-independent-cabinet-id={cabinet.id}>
                              <figcaption>{cabinet.name}</figcaption>
                              <div className="workspace-cabinet-run-svg" role="img" aria-label={`${cabinet.name}正面预览`} dangerouslySetInnerHTML={{ __html: views?.front ?? '' }} />
                              <small>{cabinet.params.width} × {cabinet.params.height} mm</small>
                            </figure>
                          );
                        })}
                      </div>
                      <details className="workspace-cabinet-members">
                        <summary>逐柜编辑与完整三视图（{group.cabinets.length} 台）</summary>
                        <div className="workspace-cabinet-grid">
                  {group.cabinets.map((cabinet) => {
                    const views = cabinetViews.get(cabinet.id);
                    const selected = props.selection.includes(cabinet.id);
                    const referenceNotes = [
                      ...(cabinet.params.counterCutouts ?? []).map((cutout) => `${cutout.name} ${cutout.width}×${cutout.depth}mm (X=${cutout.x}, Y=${cutout.y}mm)`),
                      ...allUnits(cabinet.layout).filter((unit) => unit.kind === 'appliance' && unit.appliance).map((unit) => `${unit.appliance!.name} 净空 ${unit.appliance!.openingWidth}×${unit.appliance!.openingHeight}×${unit.appliance!.openingDepth}mm`),
                    ];
                    return (
                      <article key={cabinet.id} className={`workspace-cabinet-card ${selected ? 'is-selected' : ''}`}>
                        <div className="workspace-cabinet-card-head">
                          <button type="button" className="workspace-cabinet-title" onClick={() => props.setSelection([cabinet.id])}>
                            <span className="workspace-cabinet-name">{cabinet.name}</span>
                            <span className="workspace-cabinet-dims">{cabinet.params.width} × {cabinet.params.height} × {cabinet.params.depth} mm</span>
                          </button>
                          <div className="workspace-cabinet-actions">
                            <button type="button" className="workspace-button workspace-button-quiet" onClick={() => { props.setSelection([cabinet.id]); setThreeCabinetId(cabinet.id); }}>
                              3D 预览
                            </button>
                            <button type="button" className="workspace-button workspace-button-quiet" onClick={() => props.onOpenCad(cabinet.id, activeRoom.room.id)}>
                              编辑
                            </button>
                          </div>
                        </div>
                        {referenceNotes.length > 0 ? (
                          <div role="note" style={{ marginTop: 10, padding: '8px 10px', border: '1px solid #c94e42', background: '#fff1ef', color: '#751c15', fontSize: 13, lineHeight: 1.45 }}>
                            <strong>参考预留｜非 CNC 开孔｜待拆单确认</strong>
                            <div>{referenceNotes.join('；')}</div>
                            <div>电器净空须按实机复核；虚线不代表已完成加工。</div>
                          </div>
                        ) : null}
                        {views?.error ? (
                          <div className="workspace-view-error">无法生成视图：{views.error}</div>
                        ) : (
                          <details className="workspace-cabinet-details" open={selected}>
                            <summary>查看完整三视图 / 内部结构</summary>
                          <div className="workspace-view-grid">
                            {viewSpecs.map((spec) => (
                              <figure className="workspace-view" key={spec.key}>
                                <figcaption>
                                  <strong>{spec.title}</strong>
                                  <span>{spec.note}</span>
                                </figcaption>
                                <div
                                  className={`workspace-view-canvas workspace-view-${spec.key}`}
                                  role="img"
                                  aria-label={`${activeRoom.room.name} ${cabinet.name} ${spec.title}`}
                                  dangerouslySetInnerHTML={{ __html: views?.[spec.key] ?? '' }}
                                />
                              </figure>
                            ))}
                          </div>
                          </details>
                        )}
                      </article>
                    );
                  })}
                        </div>
                      </details>
                    </section>
                  ))}
                </div>
              ) : (
                <div className="workspace-empty-state">
                  <div className="workspace-empty-icon">＋</div>
                  <h2>这个房间还没有柜体</h2>
                  <p>直接添加地柜、吊柜或其他柜型；复杂方案也可以在下方聊天里描述，让 Agent 先生成草案。</p>
                  {canAddCabinet ? (
                    <button type="button" className="workspace-button workspace-button-primary" onClick={openCabinetForm} disabled={props.readOnly} title={props.readOnly ? '历史重复 Unit ID 项目只读；须显式修复/迁移后才能创建' : undefined}>
                      添加第一个柜体
                    </button>
                  ) : null}
                </div>
              )}
            </>
          ) : (
            <div className="workspace-empty-state workspace-room-reselect" role="status">
              <div className="workspace-empty-icon">▦</div>
              <h2>{groups.length > 0 ? '请选择房间' : '还没有房间'}</h2>
              <p>{props.roomSelectionMessage || (groups.length > 0 ? '请从左侧房间列表选择一个房间；系统不会自动切换到默认房间。' : '点击顶部「＋ 房间」创建第一个房间。')}</p>
            </div>
          )}
        </section>

        <section className="workspace-chat-panel" aria-label="Agent 聊天">
          <div className="workspace-chat-heading">
            <div>
              <strong>AI 设计助手</strong>
              <span>{activeRoom ? `当前上下文：${activeRoom.room.name}` : '当前上下文：整个项目'}</span>
            </div>
            <span className="workspace-chat-heading-hint">对话记录与房间上下文关联</span>
          </div>
          <div className="workspace-chat-content">{props.children}</div>
        </section>
      </main>

      {pendingAssembly ? (
        <div className="workspace-3d-overlay" role="presentation">
          <section className="workspace-cabinet-dialog workspace-assembly-confirm-dialog" role="dialog" aria-modal="true" aria-label={`确认装配组${pendingAssembly.name}`} data-testid="assembly-confirm-dialog">
            <header className="workspace-3d-header">
              <div><strong>请明确确认「{pendingAssembly.name}」</strong><span>这一步只建立连续装配浏览语义</span></div>
              <button type="button" className="workspace-button workspace-button-quiet" onClick={() => setPendingAssemblyId(null)}>取消</button>
            </header>
            <div className="workspace-assembly-confirm-dialog-body">
              <p>成员：{pendingAssembly.memberIds.map((id) => props.project.cabinets.find((cabinet) => cabinet.id === id)?.name ?? id).join('、')}</p>
              <p>确认后会显示装配名称并作为连续组浏览；不会改变柜体 ID、柜体参数、单柜生产页或逐柜导出。</p>
              {props.readOnly ? <p role="alert">当前项目只读，不能确认装配组。</p> : null}
            </div>
            <footer>
              <button type="button" className="workspace-button workspace-button-quiet" onClick={() => setPendingAssemblyId(null)}>返回修改</button>
              <button type="button" className="workspace-button workspace-button-primary" data-testid="assembly-confirm-final" disabled={props.readOnly || !selectedAssemblyIsValid} onClick={confirmPendingAssembly}>明确确认此装配组</button>
            </footer>
          </section>
        </div>
      ) : null}

      {showCabinetForm && canAddCabinet && activeRoom ? (
        <div className="workspace-3d-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCabinetForm(false); }}>
          <section className="workspace-cabinet-dialog" role="dialog" aria-modal="true" aria-label={`在${activeRoom.room.name}添加柜体`}>
            <header className="workspace-3d-header">
              <div>
                <strong>在「{activeRoom.room.name}」添加柜体</strong>
                <span>直接归属当前房间，并自动尝试空闲墙位</span>
              </div>
              <button type="button" className="workspace-button workspace-button-quiet" onClick={() => setShowCabinetForm(false)} aria-label="关闭添加柜体对话框">关闭</button>
            </header>
            <form className="workspace-cabinet-form" onSubmit={submitCabinet}>
              <label>
                柜型方案
                <select className="input" value={presetId} onChange={(event) => selectPreset(event.target.value)}>
                  {CABINET_PRESETS.map((preset, index) => <option key={`${preset.id}-${index}`} value={preset.id}>{preset.name}</option>)}
                </select>
              </label>
              <label>
                柜体名称
                <input className="input" value={cabinetName} onChange={(event) => setCabinetName(event.target.value)} maxLength={80} required />
              </label>
              <div className="workspace-dimension-fields">
                {(['width', 'height', 'depth'] as const).map((dimension) => (
                  <label key={dimension}>
                    {{ width: '宽度', height: '高度', depth: '进深' }[dimension]}（mm）
                    <input className="input" type="number" min={1} max={12000} step={1} value={dimensions[dimension]} onChange={(event) => setDimensions((current) => ({ ...current, [dimension]: Number(event.target.value) }))} required />
                  </label>
                ))}
              </div>
              <p className="workspace-cabinet-hint">{selectedPreset?.hint ?? '柜型结构由项目模板构造，尺寸可在此调整。'}</p>
              <div className="workspace-dialog-actions">
                <button type="button" className="workspace-button workspace-button-quiet" onClick={() => setShowCabinetForm(false)}>取消</button>
                <button type="submit" className="workspace-button workspace-button-primary">创建柜体</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {active3DCabinet ? (
        <div className="workspace-3d-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setThreeCabinetId(null); }}>
          <section className="workspace-3d-dialog" role="dialog" aria-modal="true" aria-label={`${active3DCabinet.name} 3D 预览`}>
            <header className="workspace-3d-header">
              <div>
                <strong>{activeRoom?.room.name} · {active3DCabinet.name}</strong>
                <span>3D 仅网页预览，不导出到 PDF / DXF</span>
              </div>
              <button type="button" className="workspace-button workspace-button-quiet" onClick={() => setThreeCabinetId(null)} aria-label="关闭 3D 预览">关闭</button>
            </header>
            <div className="workspace-3d-canvas">
              <Suspense fallback={<div className="workspace-3d-loading">正在载入 3D 视图…</div>}>
                <ThreeViewport
                  bus={props.bus}
                  version={props.version}
                  selection={props.selection}
                  setSelection={props.setSelection}
                  cabinetFilterId={active3DCabinet.id}
                />
              </Suspense>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
