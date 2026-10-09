import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Project } from '../../core/types.ts';
import { parseProjectFile, serializeProjectFile } from '../../core/projectFile.ts';
import { fmtSavedAt } from '../../state/draftStore.ts';
import type { ToastKind } from '../types.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  导出：项目存档 + 横向 PDF / DXF 图纸 + 开料单
 *
 *  ── 这个面板只做"把当前模型交给外部"，不做任何几何计算 ──
 *
 *  模型 100% 归 CommandBus，这里只把 `bus.getState()` 整个 project 发过去；
 *  几何由后端从语义模型重算（见 server/server.mjs 的 /api/export/*）。
 *  如果这里改成"先把图元算好再上传"，就等于让浏览器成为几何的第二个来源，
 *  "图 = 料" 这条线会当场断掉。
 *
 *  ── 项目存档（.json）──
 *    DXF/CSV 是"给生产的东西"，项目文件是"给自己的存档"。
 *    导入走 bus.replaceProject()：同样的唯一写入口、同样进历史可撤销，
 *    导入也是一条普通命令，没有特权。
 *
 *  ── 为什么导出前必须先摆出问题 ──
 *    一张"看起来没问题"的图纸比一张报错的图纸危险得多：
 *    它会一路走到开料才被人发现。所以有 ERROR 时，这个面板先把话说清楚，
 *    而不是让人高高兴兴导出一份错图。
 *
 *  ── MVP 输出 PDF / DXF，不出 DWG ──
 *    DWG 涉及 ODA 授权，商业级无 Web/SaaS 使用权（见主方案红线）。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface ExportPanelProps {
  bus: CommandBus;
  version: number;
  token: string | null;
  /** 最近一次草稿自动保存时间（ISO）——null 表示还没存过 */
  savedAt: string | null;
  /** 网页本地与服务端 live 不同：阻止生产导出，避免图纸与当前网页/服务器版本混淆。 */
  remoteStatusReady: boolean;
  remoteStatusDiffers: boolean;
  remoteLiveModelVersion: number;
  /** /api/workspace 返回的原始确认快照；仅用于结构比较，不从本地模型计算 hash。 */
  confirmedProject: Project | null;
  projectSnapshotId: string | null;
  projectSnapshotHash: string | null;
  projectSnapshotVersion: number | null;
  unconfirmedSharedPanelDraft?: boolean;
  onOpenRemoteDrafts: () => void;
  onToast: (kind: ToastKind, msg: string) => void;
  readOnly?: boolean;
}

/** 从 Content-Disposition 里取文件名（RFC 5987 的 filename*=UTF-8''… 优先） */
function fileNameOf(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const m = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* 编码坏了就退回 ASCII 名，不要因此让整个下载失败 */
    }
  }
  const m2 = /filename="([^"]+)"/i.exec(header);
  return m2 ? m2[1] : fallback;
}

/** 确定性结构表示只用于判断本地模型是否仍等于 GET /api/workspace 的项目；绝不作为服务器 hash。 */
function stableProjectJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableProjectJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableProjectJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function freezeProjectSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeProjectSnapshot(child);
  }
  return value;
}

export function ExportPanel(props: ExportPanelProps): ReactNode {
  const { bus, version, token, savedAt, onToast } = props;
  const [plan, setPlan] = useState(true);
  const [planRoomIds, setPlanRoomIds] = useState<string[] | null>(null);
  const [pdfLayoutSelection, setPdfLayoutSelection] = useState<{ roomKey: string; ids: string[] }>({ roomKey: '', ids: [] });
  const [sheet, setSheet] = useState(true);
  const [dxfVersion, setDxfVersion] = useState<'R2007' | 'R2000'>('R2007');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string>('');
  const [snapshotConflictNote, setSnapshotConflictNote] = useState<string>('');
  const [snapshotConflictFor, setSnapshotConflictFor] = useState<string | null>(null);
  /** 文件选择器是"看不见状态的隐藏 input"，导入结果必须显式留在界面上 */
  const fileRef = useRef<HTMLInputElement>(null);
  const [importNote, setImportNote] = useState<string>('');

  const project = bus.getState();
  const allRoomIds = project.rooms.map((room) => room.id);
  const selectedPlanRoomIds = planRoomIds === null ? allRoomIds : allRoomIds.filter((id) => planRoomIds.includes(id));
  const pdfLayoutRoomKey = `${project.id}:${allRoomIds.join('\u001f')}`;
  const selectedPdfLayoutRoomIds = pdfLayoutSelection.roomKey === pdfLayoutRoomKey
    ? allRoomIds.filter((id) => pdfLayoutSelection.ids.includes(id))
    : [];
  const issues = bus.issues();
  const errors = issues.filter((i) => i.severity === 'ERROR');
  const warnings = issues.filter((i) => i.severity === 'WARNING');
  const identityConflict = bus.getUnitIdentityConflict();
  const hasConfirmedSnapshotMetadata = typeof props.projectSnapshotId === 'string' && props.projectSnapshotId.length > 0
    && typeof props.projectSnapshotHash === 'string' && props.projectSnapshotHash.length > 0
    && Number.isInteger(props.projectSnapshotVersion) && (props.projectSnapshotVersion ?? -1) >= 0;
  const localSnapshotDiffers = !props.confirmedProject
    || stableProjectJson(project) !== stableProjectJson(props.confirmedProject);
  const snapshotKey = `${props.projectSnapshotId ?? ''}\u001f${props.projectSnapshotHash ?? ''}\u001f${props.projectSnapshotVersion ?? ''}`;
  const snapshotConflictLocked = snapshotConflictFor === snapshotKey;
  const exportBlocked = errors.length > 0 || !props.remoteStatusReady || props.remoteStatusDiffers
    || !hasConfirmedSnapshotMetadata || localSnapshotDiffers || snapshotConflictLocked || props.unconfirmedSharedPanelDraft === true
    || Boolean(identityConflict) || props.readOnly === true;

  useEffect(() => {
    if (snapshotConflictFor && snapshotConflictFor !== snapshotKey) {
      setSnapshotConflictFor(null);
      setSnapshotConflictNote('');
    } else if (!localSnapshotDiffers && !snapshotConflictFor && snapshotConflictNote) {
      setSnapshotConflictNote('');
    }
  }, [localSnapshotDiffers, snapshotConflictFor, snapshotConflictNote, snapshotKey]);

  // ── 项目存档 ──
  function exportProject(): void {
    if (identityConflict) {
      onToast('error', identityConflict);
      return;
    }
    const name = `${bus.getState().name || '项目'}.json`;
    const blob = new Blob([serializeProjectFile(bus.toFileSnapshot())], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setImportNote(`已导出 ${name}（${Math.round(blob.size / 1024)} KB）`);
    onToast('ok', `已导出项目文件 ${name}`);
  }

  async function importProject(file: File): Promise<void> {
    let raw: string;
    try {
      raw = await file.text();
    } catch (e) {
      onToast('error', `读文件失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const r = parseProjectFile(raw);
    if (!r.ok) {
      setImportNote(`✗ ${file.name}：${r.error}`);
      onToast('error', `导入失败：${r.error}`);
      return;
    }
    if (r.project.ruleSetId && r.project.ruleSetId !== bus.getRules().id) {
      onToast('warn', `规则集不一致：文件要求 ${r.project.ruleSetId}，当前 ${bus.getRules().id}。已按当前规则集打开，几何按当前规则重新校验。`);
    }
    for (const w of r.warnings) onToast('warn', w);
    try {
      bus.replaceProject(r.project, `导入项目文件 ${file.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportNote(`✗ ${file.name}：${message}`);
      onToast('error', message);
      return;
    }
    setImportNote(
      `已导入 ${file.name}：${r.project.rooms.length} 房间 / ${r.project.cabinets.length} 柜体${r.warnings.length > 0 ? `（${r.warnings.length} 条提示，见气泡）` : ''}`
    );
    onToast('ok', `已导入 ${file.name}（可在历史里撤销这次导入）`);
  }

  async function post(kind: 'dxf' | 'cutlist' | 'roombook' | 'pdf'): Promise<void> {
    if (busy) return;
    if (props.readOnly) {
      onToast('error', '历史重复 Unit ID 项目处于只读浏览模式；生产导出已禁用，需显式修复/迁移后恢复。');
      return;
    }
    if (identityConflict) {
      onToast('error', identityConflict);
      return;
    }
    if (props.unconfirmedSharedPanelDraft) {
      onToast('error', '正式生产导出已阻止：共享件规格仍在编辑，须先确认保存或取消编辑。');
      return;
    }
    // 捕获本次请求唯一待导出的项目副本；不会把后续本地编辑混入正在进行的请求。
    const projectSnapshot = freezeProjectSnapshot(structuredClone(bus.getState()));
    if (!props.remoteStatusReady || !props.confirmedProject || !hasConfirmedSnapshotMetadata
      || props.remoteStatusDiffers || snapshotConflictLocked
      || stableProjectJson(projectSnapshot) !== stableProjectJson(props.confirmedProject)) {
      const message = '正式导出已阻止：网页模型与最近读取的服务器确认快照不一致，或快照元数据不可用。请先同步工作区或刷新后重新读取服务器快照；不会自动切换到其他版本。项目 JSON 存档仍可使用。';
      setSnapshotConflictNote(message);
      onToast('error', message);
      return;
    }
    const currentErrors = bus.issues().filter((issue) => issue.severity === 'ERROR');
    if (currentErrors.length > 0) {
      onToast('error', `正式导出已阻止：还有 ${currentErrors.length} 条 ERROR。请先到「问题」页签修复后再试。`);
      return;
    }
    setBusy(true);
    setLast('');
    setSnapshotConflictNote('');
    try {
      const res = await fetch(`/api/export/${kind}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          project: projectSnapshot,
          projectSnapshotId: props.projectSnapshotId,
          projectSnapshotHash: props.projectSnapshotHash,
          projectSnapshotVersion: props.projectSnapshotVersion,
          which: [plan ? 'plan' : null, sheet ? 'sheet' : null].filter(Boolean),
          planRoomIds: plan && kind === 'dxf' && selectedPlanRoomIds.length < allRoomIds.length ? selectedPlanRoomIds : undefined,
          layoutRoomIds: kind === 'pdf' ? selectedPdfLayoutRoomIds : undefined,
          version: dxfVersion,
          modelVersion: `v${props.projectSnapshotVersion}`,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        let why = t;
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(t) as Record<string, unknown>;
          why = typeof payload.error === 'string' ? payload.error : t;
        } catch {
          /* 不是 JSON 就原样显示 */
        }
        if (res.status === 409 && (payload.code === 'EXPORT_SNAPSHOT_CONFLICT' || payload.code === 'EXPORT_SNAPSHOT_REQUIRED')) {
          const fields = Array.isArray(payload.mismatchFields)
            ? payload.mismatchFields.filter((field): field is string => typeof field === 'string')
            : [];
          const reason = why.replace(/[。.!?]+$/u, '');
          const fieldNote = fields.length ? `冲突字段：${fields.join('、')}。` : '';
          const message = `服务器快照冲突（${String(payload.code)}）：${reason}。${fieldNote}请先同步工作区或刷新页面，重新读取服务器快照后再试；不会自动切换版本。项目 JSON 存档仍可使用。`;
          setSnapshotConflictFor(snapshotKey);
          setSnapshotConflictNote(message);
          onToast('error', message);
          return;
        }
        onToast('error', `导出失败：${why}`);
        return;
      }
      const blob = await res.blob();
      const fallback = kind === 'dxf' ? 'export.dxf' : kind === 'roombook' ? 'roombook.html' : kind === 'pdf' ? 'furniture-drawings.pdf' : 'cutlist.csv';
      const name = fileNameOf(res.headers.get('Content-Disposition'), fallback);
      const pdfPages = kind === 'pdf' ? Number(res.headers.get('X-PDF-Page-Count') ?? 0) : 0;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLast(`${name}（${Math.round(blob.size / 1024)} KB${pdfPages > 0 ? ` · ${pdfPages} 页` : ''}）`);
      onToast('ok', `已导出 ${name}`);
    } catch (e) {
      onToast('error', `导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-scroll">
      <div className="exp-group">
        <div className="exp-title">项目存档</div>
        <div className="ts" data-testid="draft-status">
          {savedAt ? <>草稿已自动保存 <b>{fmtSavedAt(savedAt)}</b>（浏览器本地，刷新不丢）</> : '草稿尚未保存 —— 模型有变更后会自动保存到浏览器本地'}
        </div>
        <div className="exp-btns">
          <button type="button" className="tb-btn" onClick={exportProject}>
            存为项目文件 .json
          </button>
          <button type="button" className="tb-btn" onClick={() => fileRef.current?.click()}>
            打开项目文件…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importProject(f);
            }}
          />
        </div>
        {importNote ? <div className="ts">{importNote}</div> : null}
        <div className="ts vnote">
          项目文件只含语义模型（权威字段），不含派生几何 —— 打开后一切现算，"图 = 料"不靠文件里存的那份图。
          导入会作为一条命令进历史，可以撤销。
        </div>
      </div>

      {errors.length > 0 ? (
        <div className="vissue vissue-error">
          <b>正式导出已阻止：当前模型有 {errors.length} 条 ERROR。</b>
          <div>请到「问题」页签逐项修复后再导出 PDF、DXF、CSV 或打印版。</div>
          <div className="ts">优先修复：{errors[0].message}</div>
          {errors[0].fixHint ? <div className="ts">修复建议：{errors[0].fixHint}</div> : null}
          {errors.length > 1 ? <div className="ts">另有 {errors.length - 1} 条错误；全部清除后即可导出。</div> : null}
        </div>
      ) : (
        <div className="ts">
          校验通过：ERROR 0{warnings.length > 0 ? ` · WARNING ${warnings.length}（警告不会阻止导出）` : ''}。
        </div>
      )}

      {props.unconfirmedSharedPanelDraft ? (
        <div className="vissue vissue-error" role="alert" data-testid="export-blocked-shared-panel-draft">
          <b>正式生产导出已阻止：共享件规格仍在编辑，尚未确认保存。</b>
          <div>请先确认保存完整分段方案，或取消编辑；项目 JSON 存档仍可使用。</div>
        </div>
      ) : null}

      {props.remoteStatusDiffers ? (
        <div className="vissue vissue-error" role="alert" data-testid="export-blocked-remote-mismatch">
          <b>生产导出已阻止：网页模型与服务器 live v{props.remoteLiveModelVersion} 不一致。</b>
          <div>网页预览/生产图可能对应不同版本。先核对服务端草稿，再明确确认同步；同步完成后此阻断会解除。</div>
          <button type="button" className="tb-btn" onClick={props.onOpenRemoteDrafts}>查看草稿并确认同步</button>
        </div>
      ) : null}
      {!props.remoteStatusReady && !props.remoteStatusDiffers ? (
        <div className="vissue vissue-error" role="alert" data-testid="export-blocked-remote-status-unknown">
          <b>生产导出已阻止：暂时无法确认网页与服务器是否为同一版本。</b>
          <div>连接恢复并完成版本校验后再导出；项目 JSON 存档仍可使用。</div>
        </div>
      ) : null}
      {props.readOnly ? <div className="vissue vissue-error" role="alert" data-testid="export-blocked-readonly"><b>只读浏览模式：PDF、DXF、开料单与打印版生产导出均已禁用。</b><div>须显式修复/迁移重复身份后才能恢复生产导出。</div></div> : null}
      {localSnapshotDiffers && props.remoteStatusReady ? (
        <div className="vissue vissue-error" role="alert" data-testid="export-blocked-local-snapshot">
          <b>正式导出已阻止：网页中的项目与最近确认的服务器快照不一致。</b>
          <div>请先同步工作区或刷新页面重新读取快照，再导出。不会将本地修改伪装成服务器确认快照；项目 JSON 存档仍可使用。</div>
        </div>
      ) : null}
      {snapshotConflictNote ? (
        <div className="vissue vissue-error" role="alert" data-testid="export-snapshot-conflict">
          <b>快照冲突</b>
          <div>{snapshotConflictNote}</div>
        </div>
      ) : null}

      <div className="exp-group">
        <div className="exp-title">DXF 图纸内容（仅影响 DXF）</div>
        <label className="exp-check">
          <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
          房间平面布置图（按房间独立 A3 布局）
        </label>
        {plan && project.rooms.length > 0 ? (
          <div className="exp-room-list" aria-label="选择要导出的房间平面图">
            {project.rooms.map((room) => (
              <label className="exp-check" key={room.id}>
                <input
                  type="checkbox"
                  checked={selectedPlanRoomIds.includes(room.id)}
                  onChange={(e) => {
                    const selected = new Set(selectedPlanRoomIds);
                    if (e.target.checked) selected.add(room.id);
                    else selected.delete(room.id);
                    setPlanRoomIds(project.rooms.map((item) => item.id).filter((id) => selected.has(id)));
                  }}
                />
                {room.name}
              </label>
            ))}
          </div>
        ) : null}
        {plan && project.rooms.length > 0 && selectedPlanRoomIds.length === 0 ? <div className="verr">至少选择一个房间，或关闭平面布置图。</div> : null}
        <label className="exp-check">
          <input type="checkbox" checked={sheet} onChange={(e) => setSheet(e.target.checked)} />
          柜体图纸（按柜体独立布局）
        </label>
        {!plan && !sheet ? <div className="verr">至少选一张图，否则导出的文件是空的。</div> : null}
      </div>

      <div className="exp-group">
        <div className="exp-title">DXF 版本</div>
        <select className="input" value={dxfVersion} onChange={(e) => setDxfVersion(e.target.value as 'R2007' | 'R2000')}>
          <option value="R2007">R2007（原生 UTF-8，中文零转义）—— 主交付</option>
          <option value="R2000">R2000（GBK，给老版本 / 部分国产 CAD 作兼容备用）</option>
        </select>
        <div className="ts vnote">
          房间平面图和柜体图分别进入独立 A3 横向布局；几何统一适配页面，打印设置保持毫米 1:1。
        </div>
      </div>

      <div className="exp-group">
        <div className="exp-title">PDF 房间布局页（默认关闭）</div>
        <div className="ts vnote">普通房间默认只输出逐柜页。勾选后会在该房间第一张柜体页之前插入一页房间布局；不改变柜体页顺序。</div>
        {project.rooms.length > 0 ? (
          <div className="exp-room-list exp-pdf-layout-list" aria-label="选择包含 PDF 房间布局页的房间">
            {project.rooms.map((room) => (
              <label className="exp-check" key={room.id}>
                <input
                  type="checkbox"
                  className="pdf-layout-room-checkbox"
                  data-pdf-layout-room={room.id}
                  aria-label={`在 ${room.name} 的柜体页前插入布局页`}
                  checked={selectedPdfLayoutRoomIds.includes(room.id)}
                  onChange={(e) => {
                    setPdfLayoutSelection((current) => {
                      const selected = new Set(current.roomKey === pdfLayoutRoomKey ? current.ids : []);
                      if (e.target.checked) selected.add(room.id);
                      else selected.delete(room.id);
                      return { roomKey: pdfLayoutRoomKey, ids: allRoomIds.filter((id) => selected.has(id)) };
                    });
                  }}
                />
                {room.name}
              </label>
            ))}
          </div>
        ) : <div className="ts">当前项目没有可选择的房间。</div>}
      </div>

      <div className="exp-group">
        <button type="button" className="tb-btn primary" data-testid="production-export-pdf" disabled={busy || exportBlocked || bus.getState().cabinets.length === 0} onClick={() => void post('pdf')}>
          {busy ? '正在导出…' : '导出横向 PDF 图纸'}
        </button>
        <button type="button" className="tb-btn" data-testid="production-export-dxf" disabled={busy || exportBlocked || (!sheet && (!plan || selectedPlanRoomIds.length === 0))} onClick={() => void post('dxf')}>
          {busy ? '正在导出…' : '导出 DXF 图纸'}
        </button>
        <button type="button" className="tb-btn" data-testid="production-export-csv" disabled={busy || exportBlocked} onClick={() => void post('cutlist')}>
          {busy ? '正在生成…' : '导出开料单 CSV'}
        </button>
        <button type="button" className="tb-btn" data-testid="production-export-roombook" disabled={busy || exportBlocked} onClick={() => void post('roombook')} title="备用打印版 HTML；正式 PDF 已固定为横向 A3 文件直接下载">
          {busy ? '正在生成…' : '下载 HTML 打印版（备用）'}
        </button>
      </div>

      {last ? <div className="ts">上次导出：{last}</div> : null}

      <div className="exp-group">
        <div className="ts vnote">
          导出的是<b>当前模型 v{version}</b>。文件里自带「模型版本 + 生成器版本 + 规则集版本」三件套，
          任何一次交付都能完整复现。
        </div>
        <div className="ts vnote">MVP 输出横向 PDF、DXF 和开料 CSV。DWG 涉及 ODA 授权，商业级不含 Web/SaaS 使用权。</div>
      </div>
    </div>
  );
}
