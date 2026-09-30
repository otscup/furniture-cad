import { Fragment, type ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import { ROW_HEIGHT_FILL, layoutRows } from '../../core/layoutModel.ts';
import { KIND_ZH, deriveContacts, pairKey } from '../../core/relations.ts';
import * as CMD from '../../core/commands.ts';

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

  /** 选中的柜体（用于"组成一组"）；跨房间时不允许成组 */
  const selCabs = project.cabinets.filter((c) => selection.includes(c.id));
  const sameRoom = selCabs.length >= 2 && selCabs.every((c) => c.roomId === selCabs[0]!.roomId);

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
                <div key={w.id}>
                  <button
                    type="button"
                    className={`tree-leaf ${isSel(w.id) ? 'sel' : ''}`}
                    onClick={() => sel(w.id)}
                  >
                    <span className="tree-name">{w.name}</span>
                    <span className="tree-meta mono">
                      {len}mm · 厚{w.thickness}
                      {(w.openings?.length ?? 0) > 0 ? ` · 洞${w.openings!.length}` : ''}
                    </span>
                  </button>
                  {(w.openings ?? []).map((o) => (
                    <div key={o.id} className="tree-empty" style={{ paddingLeft: 16 }}>
                      {o.kind === 'door' ? '门洞' : '窗洞'} {o.width}mm @{o.offset}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/**
       * 「组成一组」入口 —— 只在**多选了 ≥2 个同房间柜体**时出现。
       *
       * 为什么入口放在这里而不是工具栏：组合是"把已有柜体声明成一组"，
       * 它的前提就是"已经选中了哪几个"。没有选中时不该有一个点了要再去选的按钮。
       *
       * 创建的组合**不带任何连接**：连接要由下面那个"按当前落位补全"按钮
       * **经用户点一下**才补 —— 系统不会自动把"看起来挨着"变成"你说连着"。
       * （推断与声明必须分开，这是关系层的第一纪律。）
       */}
      {selCabs.length >= 2 ? (
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            title={selCabs.length >= 2 && sameRoom ? '把这组柜体声明成一个组合（不动任何尺寸）' : '只能把同一个房间里的柜体组成一组'}
            disabled={!sameRoom}
            onClick={() =>
              bus.execute(
                CMD.createAssembly({
                  id: '',
                  name: `组合 ${(project.assemblies?.length ?? 0) + 1}`,
                  roomId: selCabs[0]!.roomId,
                  memberIds: selCabs.map((c) => c.id),
                  connections: [],
                })
              )
            }
          >
            把选中的 {selCabs.length} 个柜组成一组
          </button>
        </div>
      ) : null}

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

      {/**
       * 组合（v0.3，P2）—— **只在真的有组合时才渲染这一整块**。
       * 没有组合时 DOM 与 v0.2 逐节点相同（旧 UI 断言不受影响）。
       * 组合是关系层，不是几何层：这里列出的全是"谁和谁怎么连"，没有一个尺寸
       * 是这里算的（尺寸一律取自派生表）。
       */}
      {project.assemblies && project.assemblies.length > 0 ? (
        <div className="tree-group">
          <div className="tree-group-title">组合（{project.assemblies.length}）</div>
          {project.assemblies.map((a) => {
            const nameOf = (id: string): string => project.cabinets.find((c) => c.id === id)?.name ?? id;
            /** 组合内**实际相接**但还没声明的对 —— 补连接的候选项 */
            const missingOf = (asm: typeof a): Array<{ kind: 'corner' | 'butt'; a: string; b: string }> =>
              deriveContacts(project)
                .filter((c) => asm.memberIds.includes(c.a) && asm.memberIds.includes(c.b))
                .filter((c) => !asm.connections.some((x) => pairKey(x.a.cabinetId, x.b.cabinetId) === pairKey(c.a, c.b)))
                .map((c) => ({ kind: c.kind, a: c.a, b: c.b }));
            return (
              <div key={a.id}>
                <div className="tree-node tree-asm">
                  <span className="tree-name">{a.name}</span>
                  <span className="tree-meta mono">{a.memberIds.length} 个柜体</span>
                </div>
                <div className="tree-sub">
                  {a.connections.length === 0 ? (
                    <div className="tree-empty">（还没声明连接）</div>
                  ) : (
                    a.connections.map((c) => (
                      <div key={c.id} className="tree-leaf-sub">
                        <span className="tree-name">
                          {KIND_ZH[c.kind]}
                          {c.origin === 'inferred' ? ' · 推断' : ''}
                        </span>
                        <span className="tree-meta">
                          {nameOf(c.a.cabinetId)} ↔ {nameOf(c.b.cabinetId)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
                <div className="btn-row">
                  <button type="button" className="btn" onClick={() => props.setSelection(a.memberIds)}>
                    选中整组
                  </button>
                  {/**
                   * 「按当前落位补全连接」—— 把派生出来的接触**经用户确认**变成声明。
                   * 这一步必须经过一次点击：系统不能自己把"看起来挨着"记成
                   * "你说连着"（那是把推断当事实，会让以后的报错失去依据）。
                   */}
                  {missingOf(a).length > 0 ? (
                    <button
                      type="button"
                      className="btn"
                      title={`补 ${missingOf(a).length} 条：${missingOf(a).map((c) => KIND_ZH[c.kind]).join('、')}`}
                      onClick={() => {
                        for (const c of missingOf(a)) {
                          bus.execute(
                            CMD.connectInAssembly(a.id, a.name, {
                              id: '',
                              kind: c.kind,
                              a: { cabinetId: c.a },
                              b: { cabinetId: c.b },
                              origin: 'authored',
                            })
                          );
                        }
                      }}
                    >
                      按当前落位补全连接（{missingOf(a).length}）
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn"
                    title="只取消「这是一组」的语义，不会删掉里头的柜体"
                    onClick={() => bus.execute(CMD.deleteAssembly(a.id, a.name))}
                  >
                    删除组合
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
