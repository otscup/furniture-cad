import { Fragment, type ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import { ROW_HEIGHT_FILL, layoutRows } from '../../core/layoutModel.ts';

/** 对象树：模型结构的直接映射（房间 → 墙 / 柜体 → 分区） */
export function ObjectTree(props: {
  bus: CommandBus;
  version: number;
  selection: string[];
  setSelection: (ids: string[]) => void;
}): ReactNode {
  const { bus, selection } = props;
  const project = bus.getState();
  const derived = bus.derive();

  const sel = (id: string): void => props.setSelection([id]);
  const isSel = (id: string): boolean => selection.includes(id);

  return (
    <div className="panel-scroll tree">
      <div className="tree-root">
        <span className="tree-node-label">{project.name}</span>
      </div>

      <div className="tree-group">
        <div className="tree-group-title">房间 / 墙（{project.rooms.length}）</div>
        {project.rooms.map((r) => (
          <div key={r.id}>
            <div className="tree-node tree-room">{r.name}</div>
            {r.walls.length === 0 ? <div className="tree-empty">（还没有墙）</div> : null}
            {r.walls.map((w) => {
              const len = Math.round(Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y));
              return (
                <button
                  key={w.id}
                  type="button"
                  className={`tree-leaf ${isSel(w.id) ? 'sel' : ''}`}
                  onClick={() => sel(w.id)}
                >
                  <span className="tree-name">{w.name}</span>
                  <span className="tree-meta mono">
                    {len}mm · 厚{w.thickness}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="tree-group">
        <div className="tree-group-title">柜体（{project.cabinets.length}）</div>
        {project.cabinets.length === 0 ? <div className="tree-empty">（还没有柜体 · 用「放柜体」工具点一下）</div> : null}
        {project.cabinets.map((c) => {
          const g = derived.geom.cabinets[c.id];
          const errs = g ? g.issues.filter((i) => i.severity === 'ERROR').length : 0;
          /** 是否多行柜 —— 只影响"要不要画行头"，单行柜输出与 v0.2 逐节点相同 */
          const multiRow = layoutRows(c.layout).length > 1;
          return (
            <div key={c.id}>
              <button type="button" className={`tree-leaf ${isSel(c.id) ? 'sel' : ''}`} onClick={() => sel(c.id)}>
                <span className="tree-name">
                  {errs > 0 ? <span className="dot dot-err" title={`${errs} 条 ERROR`} /> : null}
                  {c.name}
                </span>
                <span className="tree-meta mono">
                  {c.params.width}×{c.params.height}×{c.params.depth}
                </span>
              </button>
              <div className="tree-sub">
                {/**
                 * 分区按**行**分组（v0.3）。
                 * 单行柜 ⇒ 恰好一组、且不画行头 → DOM 与 v0.2 完全相同（旧验收断言不动）。
                 * 多行柜 ⇒ 每行一个行头 + 该行的分区；净宽取自**该行**的派生表
                 * （用整柜的 `g.layout.nets` 会把每一行都标成第一行的宽度）。
                 */}
                {layoutRows(c.layout).map((r, ri) => {
                  const rowDerived = g?.layout.rows[ri];
                  return (
                    <Fragment key={r.id}>
                      {multiRow ? (
                        <div className="tree-row-head">
                          R{ri + 1} · {r.height === ROW_HEIGHT_FILL ? '吃掉剩余内高' : `净高 ${r.height}`}
                          {rowDerived ? ` → ${rowDerived.netH}` : ''}
                        </div>
                      ) : null}
                      {r.units.map((u, i) => (
                        <div key={u.id} className="tree-leaf-sub">
                          <span className="tree-name">
                            {u.nickname ?? u.kind}
                            {u.doors ? ` · ${u.doors.count}门` : ''}
                            {u.drawers ? ` · ${u.drawers.count}抽` : ''}
                            {u.shelves ? ` · ${u.shelves.count}层` : ''}
                          </span>
                          <span className="tree-meta mono">
                            净{u.requestedWidth}
                            {rowDerived ? `→${rowDerived.nets[i]}` : ''}
                          </span>
                        </div>
                      ))}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
