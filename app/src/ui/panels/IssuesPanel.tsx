import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Issue } from '../../core/types.ts';

const ORDER: Array<Issue['severity']> = ['ERROR', 'WARNING', 'INFO'];

const LABEL: Record<Issue['severity'], string> = {
  ERROR: 'ERROR · 阻断交付',
  WARNING: 'WARNING · 需人工确认',
  INFO: 'INFO · 提示（不是错误）',
};

/** 问题面板：机器硬规则与恒等式断言的输出，按严重度分组 */
export function IssuesPanel(props: { bus: CommandBus; version: number; setSelection: (ids: string[]) => void }): ReactNode {
  const { bus } = props;
  const issues = bus.issues();
  const project = bus.getState();

  const focus = (target: string): void => {
    // 干涉类问题的 target 形如 "cab_001 / cab_002"，两个都要选中
    const parts = target.split('/').map((s) => s.trim());
    const ids = parts.filter((p) => project.cabinets.some((c) => c.id === p) || project.rooms.some((r) => r.walls.some((w) => w.id === p)));
    if (ids.length > 0) props.setSelection(ids);
  };

  if (issues.length === 0) {
    return <div className="panel-scroll empty-hint ok-hint">没有发现任何问题。恒等式断言与生产硬规则全部通过。</div>;
  }

  return (
    <div className="panel-scroll">
      {ORDER.map((sev) => {
        const list = issues.filter((i) => i.severity === sev);
        if (list.length === 0) return null;
        return (
          <div key={sev} className={`issue-group issue-${sev}`}>
            <div className="issue-group-title">
              {LABEL[sev]}（{list.length}）
            </div>
            {list.map((i, k) => (
              <button key={`${i.code}-${i.target}-${k}`} type="button" className="issue-item" onClick={() => focus(i.target)}>
                <div className="issue-head">
                  <span className="mono issue-code">{i.code}</span>
                  <span className="mono issue-target">{i.target}</span>
                </div>
                <div className="issue-msg">{i.message}</div>
                {i.fixHint ? <div className="fix-hint">→ {i.fixHint}</div> : null}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
