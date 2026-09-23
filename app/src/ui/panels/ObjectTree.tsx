import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';

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
                {c.layout.units.map((u, i) => (
                  <div key={u.id} className="tree-leaf-sub">
                    <span className="tree-name">
                      {u.nickname ?? u.kind}
                      {u.doors ? ` · ${u.doors.count}门` : ''}
                      {u.drawers ? ` · ${u.drawers.count}抽` : ''}
                      {u.shelves ? ` · ${u.shelves.count}层` : ''}
                    </span>
                    <span className="tree-meta mono">
                      净{u.requestedWidth}
                      {g ? `→${g.layout.nets[i]}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
