import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Issue } from '../../core/types.ts';
import { ruleCard } from '../../core/rules/issueCatalog.ts';

const ORDER: Array<Issue['severity']> = ['ERROR', 'WARNING', 'INFO'];

const LABEL: Record<Issue['severity'], string> = {
  ERROR: 'ERROR · 阻断交付',
  WARNING: 'WARNING · 需人工确认',
  INFO: 'INFO · 提示（不是错误）',
};

/**
 * 问题面板：机器硬规则与恒等式断言的输出，按严重度分组。
 *
 * 每条报错给出「一键修复」还是「要你自己定」，规则是 issueCatalog 判的：
 *   - 修法唯一可判定的（加一扇门、缩短滑轨）→ 给按钮，点了是一条命令 = 一次撤销；
 *   - 修法有多种、或属于程序缺陷 → **不给按钮**，只给说清原因的话。
 * 后者最怕的不是"不能修"，而是给一个点了也没用的按钮让人反复点。
 */
export function IssuesPanel(props: {
  bus: CommandBus;
  version: number;
  setSelection: (ids: string[]) => void;
  applyFix?: (i: Issue) => boolean;
}): ReactNode {
  const { bus, applyFix } = props;
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
            {list.map((i, k) => {
              const card = ruleCard(i.code);
              const canFix = Boolean(i.autoFix) && typeof applyFix === 'function';
              return (
                <div key={`${i.code}-${i.target}-${k}`} className="issue-item">
                  <button type="button" className="issue-main" onClick={() => focus(i.target)}>
                    <div className="issue-head">
                      <span className="mono issue-code">{i.code}</span>
                      {card?.title ? <span className="issue-title">{card.title}</span> : null}
                      <span className="mono issue-target">{i.target}</span>
                    </div>
                    <div className="issue-msg">{i.message}</div>
                    {i.fixHint ? <div className="fix-hint">→ {i.fixHint}</div> : null}
                    {!i.autoFix && card?.manual ? <div className="fix-manual">{card.manual}</div> : null}
                  </button>
                  {canFix ? (
                    <button
                      type="button"
                      className="issue-fix"
                      title={i.autoFix?.note}
                      onClick={() => {
                        if (!applyFix) return;
                        applyFix(i);
                      }}
                    >
                      一键修复
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
