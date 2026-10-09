import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { generateCabinet, getCabinetFootprint } from '../core/geometry/generate.ts';
import { confirmSharedPanel, validateSharedPanels } from '../core/sharedPanels.ts';
import type { Cabinet, EdgeSpec, Project, RuleSet, SharedPanel, SharedPanelHole, SharedPanelSegment } from '../core/types.ts';

type EdgeKey = keyof EdgeSpec;
type Side = 'front' | 'back' | 'left' | 'right';
type SegmentDraft = { id: string; x: string; y: string; length: string; width: string };
type HoleDraft = { id: string; kind: string; x: string; y: string; diameter: string; depth: string };
type PanelDraft = {
  id: string;
  name: string;
  members: string[];
  overhang: Record<Side, string>;
  elevation: string;
  material: string;
  thickness: string;
  finish: string;
  grain: '' | 'length' | 'width' | 'none';
  edges: Record<EdgeKey, string>;
  supportMethod: string;
  supportIds: string[];
  segmentationMode: '' | 'single' | 'manual';
  segmentationConfirmed: boolean;
  segments: SegmentDraft[];
  machiningStatus: '' | SharedPanel['machining']['status'];
  holes: HoleDraft[];
  scopeConfirmed: boolean;
};

type Bounds = SharedPanel['bounds'];

const SIDES: Array<{ key: Side; label: string }> = [
  { key: 'front', label: '前' }, { key: 'back', label: '后' }, { key: 'left', label: '左' }, { key: 'right', label: '右' },
];
const EDGES: Array<{ key: EdgeKey; label: string }> = [
  { key: 'top', label: '前边' }, { key: 'bottom', label: '后边' }, { key: 'left', label: '左边' }, { key: 'right', label: '右边' },
];
const EDGE_NONE = '__no_edge__';

function numeric(value: string): number | null {
  if (!value.trim()) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function unionBounds(cabinets: Cabinet[]): Bounds | null {
  if (!cabinets.length) return null;
  const points = cabinets.flatMap(getCabinetFootprint);
  const bounds = {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
  return Object.values(bounds).every(Number.isSafeInteger) ? bounds : null;
}

function proposedBounds(envelope: Bounds | null, overhang: PanelDraft['overhang']): Bounds | null {
  if (!envelope) return null;
  const values = Object.fromEntries(SIDES.map(({ key }) => [key, numeric(overhang[key]) ?? 0])) as Record<Side, number>;
  return {
    minX: envelope.minX - values.left,
    minY: envelope.minY - values.back,
    maxX: envelope.maxX + values.right,
    maxY: envelope.maxY + values.front,
  };
}

function panelElevation(cabinet: Cabinet): number {
  return (cabinet.params.mountHeight ?? 0) + cabinet.params.bodyLift + cabinet.params.height;
}

function freshPanelId(project: Project): string {
  const known = new Set((project.sharedPanels ?? []).map((panel) => panel.id));
  let id = '';
  do {
    id = `SP_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  } while (known.has(id));
  return id;
}

function newDraft(project: Project, roomCabinets: Cabinet[], existing?: SharedPanel): PanelDraft {
  const suggestedElevation = roomCabinets.length ? Math.max(...roomCabinets.map(panelElevation)) : 0;
  return {
    id: existing?.id ?? freshPanelId(project),
    name: existing?.name ?? '',
    members: existing ? [...existing.memberCabinetIds] : [],
    overhang: existing ? {
      front: String(existing.overhang.front), back: String(existing.overhang.back),
      left: String(existing.overhang.left), right: String(existing.overhang.right),
    } : { front: '', back: '', left: '', right: '' },
    elevation: String(existing?.elevation ?? suggestedElevation),
    material: existing?.material ?? '',
    thickness: existing ? String(existing.thickness) : '',
    finish: existing?.finish ?? '',
    grain: existing?.grainDirection ?? '',
    edges: existing ? Object.fromEntries(EDGES.map(({ key }) => [key, existing.edgeTreatment[key] ?? EDGE_NONE])) as Record<EdgeKey, string>
      : { top: '', bottom: '', left: '', right: '' },
    supportMethod: existing?.support.method ?? '',
    supportIds: existing ? [...existing.support.memberCabinetIds] : [],
    segmentationMode: existing?.segmentation.segments.length ? (existing.segmentation.segments.length === 1 ? 'single' : 'manual') : '',
    segmentationConfirmed: existing?.segmentation.confirmed ?? false,
    segments: existing?.segmentation.segments.map((segment) => ({ id: segment.id, x: String(segment.x), y: String(segment.y), length: String(segment.length), width: String(segment.width) })) ?? [],
    machiningStatus: existing?.machining.status ?? '',
    holes: existing?.machining.holes.map((hole) => ({ id: hole.id, kind: hole.kind, x: String(hole.x), y: String(hole.y), diameter: String(hole.diameter), depth: String(hole.depth) })) ?? [],
    scopeConfirmed: false,
  };
}

function formatBounds(bounds: Bounds | null): string {
  return bounds ? `X ${bounds.minX}–${bounds.maxX} · Y ${bounds.minY}–${bounds.maxY} mm` : '无法推导（请检查成员柜和落位）';
}

function makeSegments(draft: PanelDraft, bounds: Bounds | null): SharedPanelSegment[] {
  if (!bounds || !draft.segmentationConfirmed) return [];
  if (draft.segmentationMode === 'single') {
    return [{ id: 'whole', x: bounds.minX, y: bounds.minY, length: bounds.maxX - bounds.minX, width: bounds.maxY - bounds.minY }];
  }
  if (draft.segmentationMode !== 'manual') return [];
  return draft.segments.map((segment) => ({
    id: segment.id,
    x: numeric(segment.x) ?? Number.NaN,
    y: numeric(segment.y) ?? Number.NaN,
    length: numeric(segment.length) ?? Number.NaN,
    width: numeric(segment.width) ?? Number.NaN,
  }));
}

function makeHoles(draft: PanelDraft): SharedPanelHole[] {
  if (draft.machiningStatus !== 'confirmed-holes') return [];
  return draft.holes.map((hole) => ({
    id: hole.id,
    kind: hole.kind,
    x: numeric(hole.x) ?? Number.NaN,
    y: numeric(hole.y) ?? Number.NaN,
    diameter: numeric(hole.diameter) ?? Number.NaN,
    depth: numeric(hole.depth) ?? Number.NaN,
  }));
}

export function SharedPanelsPanel(props: {
  project: Project;
  roomId: string;
  roomName: string;
  rules: RuleSet;
  onSave: (panels: SharedPanel[], label: string) => void;
  onDraftStateChange?: (open: boolean) => void;
  readOnly?: boolean;
}): ReactNode {
  const roomCabinets = useMemo(() => props.project.cabinets.filter((cabinet) => cabinet.roomId === props.roomId), [props.project, props.roomId]);
  const cabinetById = useMemo(() => new Map(props.project.cabinets.map((cabinet) => [cabinet.id, cabinet])), [props.project]);
  const roomIds = useMemo(() => new Set(roomCabinets.map((cabinet) => cabinet.id)), [roomCabinets]);
  const panels = (props.project.sharedPanels ?? []).filter((panel) => panel.memberCabinetIds.some((id) => roomIds.has(id)) || panel.memberSnapshots.some((snapshot) => snapshot.roomId === props.roomId));
  const [draft, setDraft] = useState<PanelDraft | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  useEffect(() => () => props.onDraftStateChange?.(false), [props.onDraftStateChange]);
  const memberCabinets = draft?.members.map((id) => cabinetById.get(id)).filter((cabinet): cabinet is Cabinet => Boolean(cabinet)) ?? [];
  const envelope = unionBounds(memberCabinets);
  const finishedBounds = draft ? proposedBounds(envelope, draft.overhang) : null;
  const finishedLength = finishedBounds ? finishedBounds.maxX - finishedBounds.minX : 0;
  const finishedWidth = finishedBounds ? finishedBounds.maxY - finishedBounds.minY : 0;
  const selectedMaterial = draft ? props.rules.materials[draft.material] : undefined;
  const sheetSize = selectedMaterial?.maxSheet ?? props.rules.limits.maxSheetSize;
  const exceedsSheet = draft ? !((finishedLength <= sheetSize[0] && finishedWidth <= sheetSize[1]) || (finishedLength <= sheetSize[1] && finishedWidth <= sheetSize[0])) : false;

  const update = (patch: Partial<PanelDraft>): void => setDraft((current) => current ? { ...current, ...patch } : current);
  const startCreate = (): void => { if (props.readOnly) return; setErrors([]); setNotice(''); props.onDraftStateChange?.(true); setDraft(newDraft(props.project, roomCabinets)); };
  const startEdit = (panel: SharedPanel): void => { if (props.readOnly) return; setErrors([]); setNotice(''); props.onDraftStateChange?.(true); setDraft(newDraft(props.project, roomCabinets, panel)); };
  const close = (): void => { setDraft(null); setErrors([]); props.onDraftStateChange?.(false); };

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!draft || props.readOnly) return;
    const selectedIds = draft.members;
    const selectedCabinets = selectedIds.map((id) => cabinetById.get(id));
    const validMembers = selectedCabinets.every((cabinet): cabinet is Cabinet => Boolean(cabinet && cabinet.roomId === props.roomId));
    const uniqueMembers = new Set(selectedIds).size === selectedIds.length;
    const sameRoom = validMembers && selectedCabinets.every((cabinet) => cabinet?.roomId === props.roomId);
    if (!uniqueMembers || !sameRoom || selectedIds.length < 2) {
      setErrors(['请显式选择至少两个不同柜体；所有 cabinet ID 必须有效且属于当前房间。']);
      return;
    }
    if (!envelope || !finishedBounds) {
      setErrors(['成员联合范围无法按整数毫米推导，暂不能确认共享件。']);
      return;
    }
    const validOverhang = SIDES.every(({ key }) => numeric(draft.overhang[key]) !== null && Number(draft.overhang[key]) >= 0);
    const thickness = numeric(draft.thickness);
    const edgeValue = (value: string): string | null => value === EDGE_NONE ? null : value || '__UNCONFIRMED__';
    const edgeTreatment: EdgeSpec = {
      top: edgeValue(draft.edges.top),
      bottom: edgeValue(draft.edges.bottom),
      left: edgeValue(draft.edges.left),
      right: edgeValue(draft.edges.right),
    };
    const elevation = numeric(draft.elevation);
    const segmentation = { confirmed: draft.segmentationConfirmed, segments: makeSegments(draft, finishedBounds) };
    const machiningStatus = draft.machiningStatus || 'unconfirmed';
    const replacedPanelIds: string[] = [];
    for (const cabinet of selectedCabinets) {
      if (!cabinet) continue;
      try {
        const top = generateCabinet(cabinet, props.rules).panels.find((panel) => panel.role === 'TopPanel');
        if (top) replacedPanelIds.push(top.id);
      } catch { /* The shared-panel validator reports invalid member cabinet data below. */ }
    }
    const shared: SharedPanel = {
      id: draft.id,
      name: draft.name.trim(),
      memberCabinetIds: [...selectedIds],
      replacesPanelIds: replacedPanelIds,
      bounds: finishedBounds,
      elevation: elevation ?? Number.NaN,
      length: finishedLength,
      width: finishedWidth,
      thickness: thickness ?? Number.NaN,
      material: draft.material,
      finish: draft.finish.trim(),
      edgeTreatment,
      overhang: Object.fromEntries(SIDES.map(({ key }) => [key, numeric(draft.overhang[key]) ?? Number.NaN])) as SharedPanel['overhang'],
      grainDirection: draft.grain || 'none',
      grain: draft.grain || 'none',
      segmentation,
      support: { confirmed: Boolean(draft.supportMethod.trim() && draft.supportIds.length), method: draft.supportMethod.trim(), memberCabinetIds: [...draft.supportIds] },
      machining: { status: machiningStatus, holes: makeHoles(draft) },
      memberSnapshots: [],
      confirmation: { status: 'draft' },
    };
    const confirmed = confirmSharedPanel(shared, props.project);
    const candidatePanels = [...(props.project.sharedPanels ?? []).filter((panel) => panel.id !== confirmed.id), confirmed];
    const candidateProject = { ...props.project, sharedPanels: candidatePanels };
    const issues = validateSharedPanels(candidateProject, props.rules).filter((issue) => issue.target === confirmed.id || issue.target === 'sharedPanels');
    const reasons = issues.flatMap((issue) => issue.message.split(/[；;](?=\s|[^\s])/u)).map((reason) => reason.trim()).filter(Boolean);
    const localProblems: string[] = [];
    if (!draft.scopeConfirmed) localProblems.push('请先核对成员联合范围、四边外挑后的成品边界和标高，并勾选确认。');
    if (!validOverhang) localProblems.push('前、后、左、右外挑都须明确填写非负整数毫米；无内缩工艺，负值不接受。');
    if (!draft.segmentationConfirmed || !draft.segmentationMode) localProblems.push('请明确确认整件方案或人工分段方案。');
    if (exceedsSheet && draft.segmentationMode !== 'manual') localProblems.push(`成品 ${finishedLength}×${finishedWidth}mm 超过板幅 ${sheetSize[0]}×${sheetSize[1]}mm，须人工填写并确认分段。`);
    const allProblems = [...new Set([...localProblems, ...reasons])];
    if (allProblems.length) {
      setErrors(allProblems);
      setNotice('未保存：关键制造信息尚未全部确认，正式生产导出保持阻断。');
      return;
    }
    props.onSave(candidatePanels, `${draft.id === (props.project.sharedPanels ?? []).find((panel) => panel.id === draft.id)?.id ? '重新确认' : '创建'}共享件 ${draft.id}`);
    setNotice('');
    setErrors([]);
    setDraft(null);
    props.onDraftStateChange?.(false);
  };

  const getPanelIssues = (panel: SharedPanel): string[] => validateSharedPanels(props.project, props.rules)
    .filter((issue) => issue.target === panel.id)
    .flatMap((issue) => issue.message.split('；').map((message) => message.trim()).filter(Boolean));

  return (
    <section className="shared-panels" aria-label="房间共享顶板与台面" data-testid="shared-panels">
      <header className="shared-panels-head">
        <div>
          <div className="workspace-eyebrow">独立共享制造件</div>
          <h2>共享顶板 / 台面</h2>
          <p>相邻柜默认仍各自独立拆件；只有显式选择成员并确认规格后，才创建共享件并替代对应柜顶。</p>
        </div>
        <button type="button" className="workspace-button workspace-button-primary" onClick={startCreate} disabled={props.readOnly || roomCabinets.length < 2} title={props.readOnly ? '历史重复 Unit ID 项目只读；须显式修复/迁移后才能创建或保存共享件' : undefined} data-testid="shared-panel-create">
          ＋ 创建共享件
        </button>
      </header>

      {panels.length === 0 ? (
        <div className="shared-panel-empty" role="note">当前房间没有已创建的共享件。未创建 SharedPanel 时，柜体顶板保持独立计料，不会因相邻或成组而自动合并。</div>
      ) : (
        <div className="shared-panel-list">
          {panels.map((panel) => {
            const blockers = getPanelIssues(panel);
            const isStale = blockers.some((message) => /stale|已变化|快照缺失|确认后字段已变化/u.test(message));
            const memberNames = panel.memberCabinetIds.map((id) => cabinetById.get(id)?.name ?? id);
            return (
              <article className={`shared-panel-card ${blockers.length ? 'shared-panel-card-blocked' : ''}`} key={panel.id} data-shared-panel-id={panel.id} data-stale={isStale ? 'true' : 'false'}>
                <div className="shared-panel-card-head">
                  <div>
                    <strong>{panel.name || '未命名共享件'}</strong>
                    <span className={`shared-panel-status ${blockers.length ? 'blocked' : 'confirmed'}`}>{isStale ? 'STALE · 需重新确认' : blockers.length ? '未确认 · 禁止生产导出' : '已确认'}</span>
                  </div>
                  <button type="button" className="workspace-button workspace-button-quiet" onClick={() => startEdit(panel)} disabled={props.readOnly}>{isStale ? '重新确认 / 编辑' : '查看 / 编辑'}</button>
                </div>
                <div className="shared-panel-meta">
                  <span><b>SharedPanel ID</b> <code>{panel.id}</code></span>
                  <span><b>成员</b> {memberNames.join('、') || '无有效成员'}</span>
                  <span><b>成品边界</b> {formatBounds(panel.bounds)}</span>
                  <span><b>成品尺寸</b> {panel.length} × {panel.width} × {panel.thickness} mm · 标高 {panel.elevation} mm</span>
                  <span><b>材料 / 饰面</b> {panel.material} · {panel.finish || '未确认'}</span>
                  <span><b>纹理 / 封边</b> {panel.grainDirection} · {EDGES.map(({ key, label }) => `${label}:${panel.edgeTreatment[key] ?? '不封边'}`).join(' / ')}</span>
                  <span><b>分段</b> {panel.segmentation.confirmed ? `${panel.segmentation.segments.length} 段已确认` : '未确认'}</span>
                  <span><b>支撑</b> {panel.support.method || '未确认'} · {panel.support.memberCabinetIds.map((id) => cabinetById.get(id)?.name ?? id).join('、')}</span>
                  <span><b>孔位</b> {panel.machining.status === 'reference-only' ? '参考位（非 CNC）' : panel.machining.status} · {panel.machining.holes.length} 孔</span>
                </div>
                {blockers.length ? <div className="shared-panel-blocker" role="alert"><strong>{isStale ? '成员柜尺寸、材料或位置等发生变化，须重新核对并确认。正式生产导出已阻断。' : '正式生产导出已阻断。'}</strong><ul>{blockers.slice(0, 4).map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul></div> : null}
              </article>
            );
          })}
        </div>
      )}

      {draft ? (
        <div className="workspace-3d-overlay shared-panel-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <section className="shared-panel-dialog" role="dialog" aria-modal="true" aria-label={draft.members.length ? '创建或编辑共享顶板' : '创建共享顶板'} data-testid="shared-panel-dialog">
            <header className="workspace-3d-header">
              <div><strong>{(props.project.sharedPanels ?? []).some((panel) => panel.id === draft.id) ? '查看 / 编辑共享件' : '创建共享顶板 / 台面'}</strong><span>必须由用户选择成员柜；箱体三视图与逐柜生产图保持独立语义。</span></div>
              <button type="button" className="workspace-button workspace-button-quiet" onClick={close} aria-label="关闭共享件编辑">关闭</button>
            </header>
            {props.readOnly ? <div className="alert alert-warn" role="note">历史重复 Unit ID 项目只读；SharedPanel 字段与保存已禁用，需显式修复/迁移后恢复。</div> : null}
            <form className="shared-panel-form" onSubmit={onSubmit} noValidate>
              <div className="shared-panel-form-scroll">
                <fieldset disabled={props.readOnly} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
                <div className="shared-panel-section">
                  <h3>1. 成员范围与成品边界</h3>
                  <label className="shared-panel-field">共享件名称<input className="input" value={draft.name} onChange={(event) => update({ name: event.target.value })} placeholder="例如：厨房连续台面" data-testid="sp-name" /></label>
                  <fieldset className="shared-panel-members"><legend>显式选择同房间成员柜（至少 2 台）</legend>
                    {roomCabinets.length ? roomCabinets.map((cabinet) => (
                      <label key={cabinet.id} className="shared-panel-member-option"><input type="checkbox" data-testid={`sp-member-${cabinet.id}`} checked={draft.members.includes(cabinet.id)} onChange={(event) => update({ members: event.target.checked ? [...draft.members, cabinet.id] : draft.members.filter((id) => id !== cabinet.id), supportIds: event.target.checked ? draft.supportIds : draft.supportIds.filter((id) => id !== cabinet.id), scopeConfirmed: false })} /><span><b>{cabinet.name}</b><small>{cabinet.params.width} × {cabinet.params.height} × {cabinet.params.depth} mm · {cabinet.id}</small></span></label>
                    )) : <p>当前房间没有可选择的柜体。</p>}
                  </fieldset>
                  <div className="shared-panel-bound-preview" data-testid="shared-panel-bounds">
                    <div><b>成员联合范围</b><span>{formatBounds(envelope)}</span></div>
                    <div className="shared-panel-overhang-grid">{SIDES.map(({ key, label }) => <label key={key}>{label}外挑（mm）<input className="input" type="number" step="1" min="0" value={draft.overhang[key]} onChange={(event) => update({ overhang: { ...draft.overhang, [key]: event.target.value }, scopeConfirmed: false })} data-testid={`sp-overhang-${key}`} /></label>)}</div>
                    <div><b>推导成品 bounds</b><span data-testid="shared-panel-finished-bounds">{formatBounds(finishedBounds)}{finishedBounds ? ` · ${finishedLength} × ${finishedWidth} mm` : ''}</span></div>
                    <div className="shared-panel-elevation"><label>成品标高（mm）<input className="input" type="number" step="1" min="0" value={draft.elevation} onChange={(event) => update({ elevation: event.target.value, scopeConfirmed: false })} data-testid="sp-elevation" /></label>
                      <label className="shared-panel-confirm-check"><input type="checkbox" checked={draft.scopeConfirmed} onChange={(event) => update({ scopeConfirmed: event.target.checked })} />我已核对成员范围、联合边界、四边外挑后的成品 bounds 与标高。</label></div>
                  </div>
                </div>

                <div className="shared-panel-section">
                  <h3>2. 材料、饰面、纹理和封边</h3>
                  <div className="shared-panel-fields-grid">
                    <label className="shared-panel-field">板材<select className="input" value={draft.material} onChange={(event) => { const material = event.target.value; update({ material, thickness: props.rules.materials[material] ? String(props.rules.materials[material]!.thickness) : '' }); }} data-testid="sp-material"><option value="">选择板材</option>{Object.entries(props.rules.materials).filter(([, material]) => material.kind === 'board').map(([id, material]) => <option key={id} value={id}>{id} · {material.name}（{material.thickness}mm）</option>)}</select></label>
                    <label className="shared-panel-field">厚度（mm）<input className="input" type="number" min="1" step="1" value={draft.thickness} onChange={(event) => update({ thickness: event.target.value })} data-testid="sp-thickness" /></label>
                    <label className="shared-panel-field">饰面 / 表面处理<input className="input" value={draft.finish} onChange={(event) => update({ finish: event.target.value })} placeholder="明确材质表面做法" data-testid="sp-finish" /></label>
                    <label className="shared-panel-field">纹理方向<select className="input" value={draft.grain} onChange={(event) => update({ grain: event.target.value as PanelDraft['grain'] })} data-testid="sp-grain"><option value="">选择并确认纹理方向</option><option value="length">沿成品长轴</option><option value="width">沿成品宽轴</option><option value="none">无纹理</option></select></label>
                  </div>
                  <div className="shared-panel-fields-grid shared-panel-edges"><strong>四边封边（每边都须显式选择封边规格或“不封边”）</strong>{EDGES.map(({ key, label }) => <label className="shared-panel-field" key={key}>{label}<select className="input" value={draft.edges[key]} onChange={(event) => update({ edges: { ...draft.edges, [key]: event.target.value } })} data-testid={`sp-edge-${key}`}><option value="">未确认</option><option value={EDGE_NONE}>不封边</option>{Object.entries(props.rules.edgebanding).map(([id, edge]) => <option key={id} value={id}>{id} · {edge.name}</option>)}</select></label>)}</div>
                </div>

                <div className="shared-panel-section">
                  <h3>3. 接缝 / 分段与支撑</h3>
                  <div className={`shared-panel-sheet-note ${exceedsSheet ? 'is-error' : ''}`} role={exceedsSheet ? 'alert' : 'note'}>板材幅面：{sheetSize[0]} × {sheetSize[1]} mm。{exceedsSheet ? `成品 ${finishedLength} × ${finishedWidth} mm 超幅，须人工设计并确认分段；系统不替你排缝。` : '未超幅时仍须明确确认按整件制作或给出人工分段方案。'}</div>
                  <div className="shared-panel-radio-row">
                    <label><input type="radio" name="sp-segmentation" checked={draft.segmentationMode === 'single'} onChange={() => update({ segmentationMode: 'single', segments: [], segmentationConfirmed: false })} />按整件（尺寸须适配板幅）</label>
                    <label><input type="radio" name="sp-segmentation" checked={draft.segmentationMode === 'manual'} onChange={() => update({ segmentationMode: 'manual', segments: draft.segments.length ? draft.segments : [], segmentationConfirmed: false })} />人工分段（由我填写）</label>
                    <label className="shared-panel-confirm-check"><input type="checkbox" data-testid="sp-confirm-segmentation" checked={draft.segmentationConfirmed} onChange={(event) => update({ segmentationConfirmed: event.target.checked })} />我已确认接缝 / 分段方案</label>
                  </div>
                  {draft.segmentationMode === 'single' ? <p className="shared-panel-hint">整件记录为一段，范围为完整成品 bounds；这是你的人工确认，不包含专业排料或旋转优化。</p> : null}
                  {draft.segmentationMode === 'manual' ? <div className="shared-panel-segments"><p>以世界坐标输入每段左下角 X/Y 及长宽；所有分段须无重叠、完整覆盖 bounds，且不得超过板幅。</p>{draft.segments.map((segment, index) => <div className="shared-panel-segment-row" key={segment.id}>
                    <strong>分段 {index + 1}</strong>{(['x', 'y', 'length', 'width'] as const).map((key) => <label key={key}>{({ x: 'X', y: 'Y', length: '长', width: '宽' })[key]}<input className="input" type="number" step="1" value={segment[key]} onChange={(event) => update({ segmentationConfirmed: false, segments: draft.segments.map((item) => item.id === segment.id ? { ...item, [key]: event.target.value } : item) })} data-testid={`sp-segment-${index}-${key}`} /></label>)}
                    <button type="button" className="workspace-button workspace-button-quiet" onClick={() => update({ segmentationConfirmed: false, segments: draft.segments.filter((item) => item.id !== segment.id) })}>删除</button>
                  </div>)}<button type="button" className="workspace-button workspace-button-quiet" onClick={() => update({ segmentationMode: 'manual', segmentationConfirmed: false, segments: [...draft.segments, { id: `segment-${draft.segments.length + 1}`, x: '', y: '', length: '', width: '' }] })} data-testid="sp-add-segment">＋ 添加人工分段</button></div> : null}
                  <label className="shared-panel-field shared-panel-support-method">支撑方式 / 规格<input className="input" value={draft.supportMethod} onChange={(event) => update({ supportMethod: event.target.value })} placeholder="填写承托、连接或支撑做法" data-testid="sp-support-method" /></label>
                  <fieldset className="shared-panel-members"><legend>确认承托成员柜</legend>{draft.members.map((id) => { const cabinet = cabinetById.get(id); return <label key={id} className="shared-panel-member-option"><input type="checkbox" data-testid={`sp-support-${id}`} checked={draft.supportIds.includes(id)} onChange={(event) => update({ supportIds: event.target.checked ? [...draft.supportIds, id] : draft.supportIds.filter((memberId) => memberId !== id) })} /><span><b>{cabinet?.name ?? id}</b><small>{id}</small></span></label>; })}</fieldset>
                </div>

                <div className="shared-panel-section">
                  <h3>4. 孔位 / 加工状态</h3>
                  <label className="shared-panel-field">孔位状态<select className="input" value={draft.machiningStatus} onChange={(event) => update({ machiningStatus: event.target.value as PanelDraft['machiningStatus'] })} data-testid="sp-machining-status"><option value="">选择并确认孔位状态</option><option value="confirmed-none">已确认无孔（CNC）</option><option value="confirmed-holes">已确认 CNC 孔位</option><option value="reference-only">仅参考标记（非 CNC）</option><option value="unconfirmed">未确认（阻断生产）</option></select></label>
                  {draft.machiningStatus === 'reference-only' ? <div className="shared-panel-reference-notice" role="alert"><strong>参考孔位仅为参考标记（非 CNC），不等于加工数据。</strong>此状态将阻断正式生产导出；请确认“无孔”或补齐 CNC 孔型、坐标、孔径和深度。</div> : null}
                  {draft.machiningStatus === 'confirmed-holes' ? <div className="shared-panel-holes"><p>孔位坐标为相对成品板左后角的局部 X/Y（mm），每孔均须填写类型、直径与深度。</p>{draft.holes.map((hole, index) => <div className="shared-panel-hole-row" key={hole.id}><strong>孔 {index + 1}</strong>{(['kind', 'x', 'y', 'diameter', 'depth'] as const).map((key) => <label key={key}>{({ kind: '类型', x: 'X', y: 'Y', diameter: '孔径', depth: '孔深' })[key]}<input className="input" type={key === 'kind' ? 'text' : 'number'} step="1" value={hole[key]} onChange={(event) => update({ holes: draft.holes.map((item) => item.id === hole.id ? { ...item, [key]: event.target.value } : item) })} data-testid={`sp-hole-${index}-${key}`} /></label>)}<button type="button" className="workspace-button workspace-button-quiet" onClick={() => update({ holes: draft.holes.filter((item) => item.id !== hole.id) })}>删除</button></div>)}<button type="button" className="workspace-button workspace-button-quiet" onClick={() => update({ holes: [...draft.holes, { id: `hole-${draft.holes.length + 1}`, kind: '', x: '', y: '', diameter: '', depth: '' }] })} data-testid="sp-add-hole">＋ 添加孔位规格</button></div> : null}
                  <p className="shared-panel-hint">参考预留、参考孔位和示意标记不代表 CNC 刀路或已完成加工。</p>
                </div>

                {errors.length ? <div className="shared-panel-form-errors" role="alert" data-testid="shared-panel-errors"><strong>{notice || '未确认共享件。'}</strong><ul>{errors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul></div> : null}
                </fieldset>
              </div>
              <footer className="shared-panel-dialog-actions"><button type="button" className="workspace-button workspace-button-quiet" onClick={close}>取消</button><button type="submit" className="workspace-button workspace-button-primary" data-testid="sp-confirm" disabled={props.readOnly}>确认规格并保存</button></footer>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}
