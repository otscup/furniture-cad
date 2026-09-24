import type { ReactNode } from 'react';
import type { CommandBus } from '../core/commandBus.ts';
import type { Camera } from '../viewport/camera.ts';
import type { SnapSettings } from '../viewport/snapping.ts';
import { fmtSavedAt } from '../state/draftStore.ts';
import type { Tool } from './types.ts';

export function StatusBar(props: {
  bus: CommandBus;
  version: number;
  cam: Camera;
  snap: SnapSettings;
  tool: Tool;
  selectionCount: number;
  /** 最近一次草稿自动保存时间（ISO）；null = 还没存过 */
  savedAt: string | null;
}): ReactNode {
  const { bus, cam, snap, tool } = props;
  const project = bus.getState();
  const issues = bus.issues();
  const errors = issues.filter((i) => i.severity === 'ERROR').length;
  const warnings = issues.filter((i) => i.severity === 'WARNING').length;
  const gs = Object.values(bus.derive().geom.cabinets);

  return (
    <div className="statusbar">
      <span className="sb-item">
        模型版本 <b className="mono">v{bus.getVersion()}</b>
      </span>
      <span className="sb-dot" />
      <span className="sb-item">
        1 : <b className="mono">{Math.round(1 / cam.scale)}</b>
      </span>
      <span className="sb-dot" />
      <span className="sb-item">
        <b className="mono">{project.cabinets.length}</b> 柜体 / <b className="mono">{project.rooms.reduce((a, r) => a + r.walls.length, 0)}</b> 墙
      </span>
      <span className="sb-dot" />
      <span className="sb-item">
        板件 <b className="mono">{gs.reduce((a, g) => a + g.stats.totalPieces, 0)}</b> 件 ·{' '}
        <b className="mono">{gs.reduce((a, g) => a + g.stats.boardAreaM2, 0).toFixed(2)}</b> m²
      </span>

      <span className="sb-spacer" />

      {props.selectionCount > 0 ? <span className="sb-item sb-sel">已选 {props.selectionCount} 项</span> : null}

      <span
        className="sb-item"
        title="草稿自动保存到浏览器本地（localStorage），刷新不丢；「导出」页签可存为 .json 文件"
      >
        草稿 {props.savedAt ? <>已存 <b>{fmtSavedAt(props.savedAt)}</b></> : '未保存'}
      </span>

      <span className="sb-mode" title="当前工具">
        {tool === 'select' ? '选择' : tool === 'wall' ? '画墙' : '放柜体'}
      </span>
      <span className={`sb-flag ${snap.enabled ? 'on' : ''}`}>捕捉</span>
      <span className={`sb-flag ${snap.ortho ? 'on' : ''}`}>正交</span>
      <span className={`sb-flag ${snap.polar ? 'on' : ''}`}>极轴</span>
      <span className={`sb-flag ${snap.gridSnap ? 'on' : ''}`}>栅格捕捉</span>

      {errors > 0 ? (
        <span className="sb-badge sb-badge-err" title="ERROR 会阻断生产数据交付，但不阻断编辑">
          {errors} ERROR · 阻断交付
        </span>
      ) : null}
      {warnings > 0 ? <span className="sb-badge sb-badge-warn">{warnings} WARNING</span> : null}
      {errors === 0 && warnings === 0 ? <span className="sb-badge sb-badge-ok">可交付</span> : null}
    </div>
  );
}
