import type { ReactNode } from 'react';
import type { SnapSettings } from '../viewport/snapping.ts';
import { TOOLS } from './types.ts';
import type { Tool } from './types.ts';
import { CABINET_TEMPLATES } from '../core/templates.ts';

export type RightTab =
  | 'props'
  | 'issues'
  | 'history'
  | 'layers'
  | 'views'
  | 'variant'
  | 'export'
  | 'memory'
  | 'admin'
  | 'ai'
  | 'account';

export function Toolbar(props: {
  tool: Tool;
  setTool: (t: Tool) => void;
  mode: 'plan' | 'sheet' | '3d';
  setMode: (m: 'plan' | 'sheet' | '3d') => void;
  explode: boolean;
  setExplode: (v: boolean) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onZoomExtents: () => void;
  showGrid: boolean;
  setShowGrid: (v: boolean) => void;
  snap: SnapSettings;
  setSnap: (s: SnapSettings) => void;
  onNewRoom: () => void;
  /** 放置柜体使用的柜型预设（与命令行 TPL 共用状态） */
  templateId: string;
  setTemplateId: (id: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  hasSelection: boolean;
  canDuplicate: boolean;
  canDelete: boolean;
  /** 有会话才显示「退出登录」——免登录模式下没有可退的东西，给个按钮是骗人 */
  loggedIn: boolean;
  onLogout: () => void;
}): ReactNode {
  const t = props.snap;
  const toggle = (patch: Partial<SnapSettings>): void => props.setSnap({ ...t, ...patch });

  return (
    <div className="toolbar">
      <div className="tb-brand">
        <span className="tb-logo">▦</span>
        <span className="tb-title">家具 CAD</span>
        <span className="tb-sub">语义参数化 · 生产级</span>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className={`tb-btn ${props.tool === tool.id ? 'active' : ''}`}
            title={`${tool.hint}（快捷键 ${tool.shortcut}）`}
            onClick={() => props.setTool(tool.id)}
          >
            {tool.label}
            <kbd>{tool.shortcut}</kbd>
          </button>
        ))}
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <button type="button" className="tb-btn" disabled={!props.canUndo} title="撤销 Ctrl+Z" onClick={props.onUndo}>
          ↶ 撤销
        </button>
        <button type="button" className="tb-btn" disabled={!props.canRedo} title="重做 Ctrl+Y" onClick={props.onRedo}>
          ↷ 重做
        </button>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <button
          type="button"
          className={`tb-btn ${props.mode === 'plan' ? 'active' : ''}`}
          title="平面图 —— 唯一可编辑的视图"
          onClick={() => props.setMode('plan')}
        >
          平面图
        </button>
        <button
          type="button"
          className={`tb-btn ${props.mode === 'sheet' ? 'active' : ''}`}
          title="四视图图幅：正视图 / 俯视图 / 侧视图 / 内部结构图（只读，由同一份数据投影派生）"
          onClick={() => props.setMode('sheet')}
        >
          ▤ 四视图
        </button>
        <button
          type="button"
          className={`tb-btn ${props.mode === '3d' ? 'active' : ''}`}
          title="3D 视图：体块预览（只读）。拖动旋转 / 滚轮缩放 / 点击柜体选中，改尺寸回平面图"
          onClick={() => props.setMode('3d')}
        >
          ⬢ 3D
        </button>
        <button
          type="button"
          className={`tb-btn ${props.explode ? 'active' : ''}`}
          title="分解图（爆炸图）：按开料清单逐件摆开的轴测图，供生产装配参照。默认关闭 —— 四视图调整好之后再开"
          onClick={() => props.setExplode(!props.explode)}
        >
          ✦ 分解图
        </button>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <button type="button" className="tb-btn" title="缩放到图幅（Home）" onClick={props.onZoomExtents}>
          ⤢ 全图
        </button>
        <button type="button" className={`tb-btn ${props.showGrid ? 'active' : ''}`} title="栅格 F7" onClick={() => props.setShowGrid(!props.showGrid)}>
          ▦ 栅格
        </button>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <button type="button" className={`tb-btn ${t.enabled ? 'active' : ''}`} title="对象捕捉 F3" onClick={() => toggle({ enabled: !t.enabled })}>
          捕捉
        </button>
        <button type="button" className={`tb-btn ${t.ortho ? 'active' : ''}`} title="正交 F8" onClick={() => toggle({ ortho: !t.ortho, polar: t.ortho ? t.polar : false })}>
          正交
        </button>
        <button type="button" className={`tb-btn ${t.polar ? 'active' : ''}`} title="极轴追踪" onClick={() => toggle({ polar: !t.polar, ortho: t.polar ? false : t.ortho })}>
          极轴 {t.polarStep}°
        </button>
        <button type="button" className={`tb-btn ${t.gridSnap ? 'active' : ''}`} title="栅格捕捉" onClick={() => toggle({ gridSnap: !t.gridSnap })}>
          栅格捕捉
        </button>
      </div>

      <div className="tb-sep" />

      <div className="tb-group">
        <button type="button" className="tb-btn" title="新建一个 3.2×2.6m 矩形房间" onClick={props.onNewRoom}>
          + 房间
        </button>
        <select
          className="tb-select"
          title={`放置柜型：${CABINET_TEMPLATES.find((t) => t.id === props.templateId)?.hint ?? ''}（命令行 TPL 可切换）`}
          value={props.templateId}
          onChange={(e) => props.setTemplateId(e.target.value)}
        >
          {CABINET_TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} {t.params.width}×{t.params.height}×{t.params.depth}
            </option>
          ))}
        </select>
        <button type="button" className="tb-btn" disabled={!props.canDuplicate} title="复制选中柜体（Ctrl+D）" onClick={props.onDuplicate}>
          复制
        </button>
        <button type="button" className="tb-btn tb-danger" disabled={!props.canDelete} title="删除选中（Delete / E）" onClick={props.onDelete}>
          删除
        </button>
      </div>

      <div className="tb-spacer" />

      {props.loggedIn ? (
        <div className="tb-group">
          <button type="button" className="tb-btn" title="退出登录（会话只在本标签页，关掉浏览器即失效）" onClick={props.onLogout}>
            ⏻ 退出登录
          </button>
        </div>
      ) : null}

      {/* 介绍页：新标签页打开。同标签页等于把当前这张未存盘的设计顶掉 —— 那不是入口，是删除 */}
      <a
        className="tb-btn"
        href="/home.html"
        target="_blank"
        rel="noopener noreferrer"
        title="产品介绍页（新开标签页，当前设计不会丢）"
      >
        ⌂ 首页
      </a>

      <div className="tb-sep" />

      <div className="tb-group tb-notice" title="MVP 阶段只输出 DXF">
        MVP：仅 DXF
      </div>
    </div>
  );
}
