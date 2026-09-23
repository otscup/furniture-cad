import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';

/**
 * 命令历史面板 —— 项目的审计日志。
 *
 * 这一栏存在的意义不只是"撤销"：它把"UI 拖动"和"AI 指令"放在同一条时间线上，
 * 并且每条都带 source 标记。出事故时，这是唯一能复盘的东西。
 */
export function HistoryPanel(props: { bus: CommandBus; version: number }): ReactNode {
  const { bus } = props;
  const entries = bus.log();
  const pointer = entries.filter((e) => e.applied).length - 1;

  if (entries.length === 0) {
    return (
      <div className="panel-scroll empty-hint">
        还没有任何命令。拖动柜体、改尺寸、画墙都会在这里留下一条可撤销、可复盘的记录。
      </div>
    );
  }

  return (
    <div className="panel-scroll hist">
      <div className="hist-meta">
        共 {entries.length} 条 · 可撤销 {pointer + 1} 条 · 可重做 {Math.max(0, entries.length - pointer - 1)} 条
      </div>
      {entries
        .map((e, i) => ({ e, i }))
        .reverse()
        .map(({ e, i }) => {
          const state = e.applied ? (i <= pointer ? 'on' : 'off') : 'off';
          return (
            <button
              key={e.seq}
              type="button"
              className={`hist-item ${state === 'on' ? '' : 'undone'}`}
              onClick={() => bus.jumpTo(e.seq)}
              title="点击：把模型状态跳回这一步"
            >
              <div className="hist-head">
                <span className="hist-seq mono">#{e.seq}</span>
                <span className={`hist-src src-${e.command.source}`}>{e.command.source}</span>
                <span className="hist-time mono">{new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              </div>
              <div className="hist-label">{e.label}</div>
              <div className="hist-ops mono">{e.command.op}</div>
              <div className="hist-stat mono">
                板件 {e.derived.pieces} 件 · {e.derived.areaM2} m² · {e.derived.weightKg} kg
                {e.issueDelta.errors > 0 ? <span className="hist-err"> · +{e.issueDelta.errors} ERROR</span> : null}
              </div>
              {e.diff.length > 0 && e.diff[0].path.startsWith('(') ? null : (
                <div className="hist-diff mono">
                  {e.diff
                    .slice(0, 3)
                    .map((d) => `${d.path}: ${String(d.from)} → ${String(d.to)}`)
                    .join('   ')}
                  {e.diff.length > 3 ? `   …共 ${e.diff.length} 条` : ''}
                </div>
              )}
            </button>
          );
        })}
    </div>
  );
}
