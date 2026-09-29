import { useEffect, useState, type ReactNode } from 'react';
import type { Cabinet, CabinetGeometry, Project, ProjectGeometry, RowHeight, RuleSet, UnitSpec, Wall } from '../../core/types.ts';
import type { Command, CommandBus } from '../../core/commandBus.ts';
import * as CMD from '../../core/commands.ts';
import { NumField, Pill, Row, Section, Text, TextField } from './common.tsx';
import { ROW_HEIGHT_FILL, layoutRows, unitPathPrefix, unitsAtPath } from '../../core/layoutModel.ts';
import type { ToastKind } from '../types.ts';

/**
 * 属性面板（主方案 §L6）
 *
 * 版面铁律：**上面是 authored（可写），下面是 derived（只读）**，
 * 中间有一条明确的界线。看到输入框 = 你能改；看到 🔒 = 这是算出来的。
 * 设计师与 AI 共用同一个面板 —— 所以不存在"AI 有特权改派生字段"的可能。
 */

export interface PropertiesPanelProps {
  bus: CommandBus;
  version: number;
  selection: string[];
  setSelection: (ids: string[]) => void;
  onToast: (kind: ToastKind, text: string) => void;
}

type Run = (c: Command) => void;

export function PropertiesPanel(props: PropertiesPanelProps): ReactNode {
  const { bus, selection } = props;
  const project = bus.getState();
  const rules = bus.getRules();
  const derived = bus.derive();

  const run: Run = (cmd) => {
    const r = bus.execute(cmd, { commitLabel: cmd.label });
    if (!r.ok) props.onToast('error', r.error ?? '操作被拒绝');
  };

  if (selection.length === 0) {
    return <ProjectProps project={project} rules={rules} geom={derived.geom} onRun={run} />;
  }

  if (selection.length > 1) {
    return <MultiProps project={project} selection={selection} setSelection={props.setSelection} />;
  }

  const id = selection[0];
  const cab = project.cabinets.find((c) => c.id === id);
  if (cab) return <CabinetProps bus={bus} cab={cab} rules={rules} geom={derived.geom.cabinets[cab.id]} onRun={run} />;

  const wall = findWall(project, id);
  if (wall) return <WallProps wall={wall} onRun={run} />;

  return <div className="panel-scroll empty-hint">对象已不存在（可能被撤销删除）。</div>;
}

function findWall(project: Project, id: string): Wall | null {
  for (const r of project.rooms) {
    const w = r.walls.find((x) => x.id === id);
    if (w) return w;
  }
  return null;
}

// ─────────────────────────── 项目 ───────────────────────────

function ProjectProps(props: { project: Project; rules: RuleSet; geom: ProjectGeometry; onRun: Run }): ReactNode {
  const { project, rules, geom } = props;
  const gs = Object.values(geom.cabinets);
  const issueCount = (sev: string): number => gs.reduce((a, g) => a + g.issues.filter((i) => i.severity === sev).length, 0);

  return (
    <div className="panel-scroll">
      <Section title="项目（可写）">
        <Row label="名称">
          <TextField value={project.name} onCommit={(v) => props.onRun(CMD.renameProject(project.name, v))} />
        </Row>
        <Row label="项目 ID" derived>
          <Text mono>{project.id}</Text>
        </Row>
        <Row label="schema 版本" derived>
          <Text mono>{project.schemaVersion}</Text>
        </Row>
      </Section>

      <Section title="规则集（🔒 AI 不可修改）">
        <Row label="规则集" derived>
          <Text>{rules.name}</Text>
        </Row>
        <Row label="规则集 ID" derived>
          <Text mono>{rules.id}</Text>
        </Row>
        <Row label="余量归属" derived>
          <Text mono>{rules.policy.remainderPolicy}</Text>
        </Row>
        <Row label="总宽策略" derived>
          <Text mono>{rules.policy.widthAllocationPolicy}</Text>
        </Row>
        <Row label="板材幅面" derived>
          <Text mono>
            {rules.limits.maxSheetSize[0]}×{rules.limits.maxSheetSize[1]} mm
          </Text>
        </Row>
        <Row label="门宽上限" derived>
          <Text mono>{rules.limits.maxDoorWidth} mm</Text>
        </Row>
      </Section>

      <Section title="规模（派生）">
        <Row label="房间 / 墙" derived>
          <Text mono>
            {project.rooms.length} / {project.rooms.reduce((a, r) => a + r.walls.length, 0)}
          </Text>
        </Row>
        <Row label="柜体" derived>
          <Text mono>{project.cabinets.length}</Text>
        </Row>
        <Row label="板件种类 / 件数" derived>
          <Text mono>
            {gs.reduce((a, g) => a + g.stats.panelKinds, 0)} / {gs.reduce((a, g) => a + g.stats.totalPieces, 0)}
          </Text>
        </Row>
        <Row label="板材面积" derived>
          <Text mono>{gs.reduce((a, g) => a + g.stats.boardAreaM2, 0).toFixed(2)} m²</Text>
        </Row>
        <Row label="估算重量" derived>
          <Text mono>{gs.reduce((a, g) => a + g.stats.estWeightKg, 0).toFixed(1)} kg</Text>
        </Row>
        <Row label="问题统计" derived>
          <Text mono>
            {issueCount('ERROR')} ERROR / {issueCount('WARNING')} WARN / {issueCount('INFO')} INFO
          </Text>
        </Row>
      </Section>

      <div className="hint-line">在视口里点选对象，这里会切到该对象的属性。拖动柜体改 placement，拖动方块夹点改 params。</div>
    </div>
  );
}

function MultiProps(props: { project: Project; selection: string[]; setSelection: (ids: string[]) => void }): ReactNode {
  const { project, selection } = props;
  return (
    <div className="panel-scroll">
      <Section title={`已选中 ${selection.length} 个对象`}>
        <ul className="clean">
          {selection.map((id) => {
            const c = project.cabinets.find((x) => x.id === id);
            const w = findWall(project, id);
            return <li key={id}>{c ? `柜体 · ${c.name}` : w ? `墙 · ${w.name}` : id}</li>;
          })}
        </ul>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => props.setSelection([])}>
            取消选择
          </button>
        </div>
        <div className="hint-line">拖动其中任一柜体会整体移动（一条命令、一次撤销）。</div>
      </Section>
    </div>
  );
}

// ─────────────────────────── 柜体 ───────────────────────────

function CabinetProps(props: {
  bus: CommandBus;
  cab: Cabinet;
  rules: RuleSet;
  geom: CabinetGeometry | undefined;
  onRun: Run;
}): ReactNode {
  const { cab, rules, geom } = props;
  const p = cab.params;
  const L = geom?.layout;
  /** 是否多行柜 —— 只影响“要不要画行头与行高输入”；单行柜输出与 v0.2 逐节点相同 */
  const multiRow = layoutRows(cab.layout).length > 1;

  return (
    <div className="panel-scroll">
      <Section title={`柜体「${cab.name}」（可写）`}>
        <Row label="名称">
          <TextField value={cab.name} onCommit={(v) => props.onRun(CMD.renameCabinet(cab, v))} />
        </Row>
        <Row label="柜体 ID" derived>
          <Text mono>{cab.id}</Text>
        </Row>
        <Row label="所属房间" derived>
          <Text mono>{cab.roomId}</Text>
        </Row>
      </Section>

      <Section title="外形尺寸（真相源 = 参数，不是图形）">
        <Row label="宽 W">
          <NumField value={p.width} min={100} max={6000} onCommit={(v) => props.onRun(CMD.resizeCabinet(cab, { width: v }))} />
        </Row>
        <Row label="高 H">
          <NumField value={p.height} min={100} max={6000} onCommit={(v) => props.onRun(CMD.resizeCabinet(cab, { height: v }))} />
        </Row>
        <Row label="深 D">
          <NumField value={p.depth} min={100} max={6000} onCommit={(v) => props.onRun(CMD.resizeCabinet(cab, { depth: v }))} />
        </Row>
        <Row label="踢脚高" hint="bodyLift：箱体底面离地高度">
          <NumField value={p.bodyLift} min={0} max={300} onCommit={(v) => props.onRun(CMD.setBodyLift(cab, v))} />
        </Row>
        <Row label="见光板" hint="finishedEnds：外露端板做 R36 圆弧前缘（表达异形，不改结构板）">
          <select
            className="input"
            value={p.finishedEnds ?? 'none'}
            onChange={(e) => props.onRun(CMD.setFinishedEnds(cab, e.target.value as 'none' | 'left' | 'right' | 'both'))}
          >
            <option value="none">无</option>
            <option value="left">左端</option>
            <option value="right">右端</option>
            <option value="both">左右两端</option>
          </select>
        </Row>
      </Section>

      <Section title="位置（背左角 + 旋转）">
        <Row label="X">
          <NumField value={cab.placement.x} onCommit={(v) => props.onRun(CMD.moveCabinet(cab, v, cab.placement.y))} />
        </Row>
        <Row label="Y">
          <NumField value={cab.placement.y} onCommit={(v) => props.onRun(CMD.moveCabinet(cab, cab.placement.x, v))} />
        </Row>
        <Row label="旋转">
          <NumField value={cab.placement.rotation} min={-360} max={360} suffix="°" onCommit={(v) => props.onRun(CMD.rotateCabinet(cab, v))} />
        </Row>
      </Section>

      <Section title="材质">
        <Row label="柜体板">
          <select
            className="input"
            value={p.boardMaterial}
            onChange={(e) => props.onRun(CMD.setCabinetParam(cab, 'boardMaterial', e.target.value, `柜体板 → ${e.target.value}`))}
          >
            {Object.entries(rules.materials)
              .filter(([, m]) => m.kind === 'board')
              .map(([k, m]) => (
                <option key={k} value={k}>
                  {m.thickness}mm {m.name}
                </option>
              ))}
          </select>
        </Row>
        <Row label="背板">
          <select
            className="input"
            value={p.backPanel.material}
            onChange={(e) => props.onRun(CMD.setCabinetParam(cab, 'backPanel.material', e.target.value, `背板 → ${e.target.value}`))}
          >
            {Object.entries(rules.materials)
              .filter(([, m]) => m.kind === 'back')
              .map(([k, m]) => (
                <option key={k} value={k}>
                  {m.thickness}mm {m.name}
                </option>
              ))}
          </select>
        </Row>
      </Section>

      <Section title="分区（layout）">
        <Row label="总宽策略" hint="fit_total = 总宽固定，按比例分配净宽；fit_units = 净宽固定，总宽外扩">
          <select
            className="input"
            value={cab.layout.widthMode}
            onChange={(e) => props.onRun(CMD.setWidthMode(cab, e.target.value as 'fit_total' | 'fit_units'))}
          >
            <option value="fit_total">fit_total（总宽优先）</option>
            <option value="fit_units">fit_units（净宽优先）</option>
          </select>
        </Row>

        {/**
         * 分区按**行**分组（v0.3）。
         * 单行柜 ⇒ 恰好一行、无行头、basePath = `layout.units`（与 v0.2 完全一致）；
         * 多行柜 ⇒ 每行一个行高输入 + 该行的分区，所有改动都带**该行的写路径前缀**
         * （`layout.rows[j].units`）—— 少了它就等于"改上层、动了下层"。
         */}
        {layoutRows(cab.layout).map((r, ri) => {
          const basePath = unitPathPrefix(cab.layout, ri);
          const rowDerived = L?.rows[ri];
          const rowUnits = unitsAtPath(cab.layout, basePath);
          return (
            <div key={r.id}>
              {multiRow ? (
                <>
                  <div className="prop-row-sub">第 {ri + 1} 行（rows[{ri}]）· {r.height === ROW_HEIGHT_FILL ? '吃掉剩余内高' : '固定高度'}{rowDerived ? ` → 净高 ${rowDerived.netH}mm` : ''}</div>
                  <Row label={`第 ${ri + 1} 行高度`} hint="数字 = 固定净高（mm）；'fill' = 吃掉剩余内高（多行柜的唯一自由项，且只能落在最后一行）">
                    <RowHeightField
                      value={r.height}
                      onCommit={(v) => props.onRun(CMD.setRowHeight(cab, ri, v))}
                    />
                  </Row>
                </>
              ) : null}

              {rowUnits.map((u, i) => (
                <UnitEditor
                  key={u.id}
                  cab={cab}
                  unit={u}
                  index={i}
                  basePath={basePath}
                  rowIndex={ri}
                  rowPrefix={multiRow ? `R${ri + 1} ` : ''}
                  netWidth={rowDerived?.nets[i]}
                  onRun={props.onRun}
                />
              ))}

              <div className="btn-row">
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const unit: UnitSpec = {
                      id: '',
                      kind: 'shelves',
                      requestedWidth: 450,
                      nickname: '新分区',
                      shelves: { count: 3, mode: 'equal', gapPerSide: 0.5 },
                    };
                    // 多行柜必须指明加在哪一行（CommandBus 会拒绝缺行信息的多行命令）
                    props.onRun(CMD.addUnit(cab.id, cab.name, unit, 'ui', multiRow ? ri : undefined));
                  }}
                >
                  {multiRow ? `+ 第 ${ri + 1} 行新增分区` : '+ 新增分区'}
                </button>
              </div>
            </div>
          );
        })}
      </Section>

      <Section title="派生骨架（🔒 生成器输出，不是输入）">
        {L ? (
          <>
            <Row label="板厚 / 背板厚" derived>
              <Text mono>
                {L.boardT} / {L.backT} mm
              </Text>
            </Row>
            <Row label="箱体高 / 内空高" derived>
              <Text mono>
                {L.bodyH} / {L.innerH} mm
              </Text>
            </Row>
            <Row label="内空宽" derived>
              <Text mono>{L.innerW} mm</Text>
            </Row>
            <Row label="可用净宽合计" derived>
              <Text mono>{L.netTotal} mm</Text>
            </Row>
            <Row label="各分区实际净宽" derived>
              <Text mono>{L.nets.join(' / ')} mm</Text>
            </Row>
            <Row label="层板深度" derived>
              <Text mono>{L.shelfDepth} mm</Text>
            </Row>
          </>
        ) : (
          <div className="empty-hint">几何生成失败，无法给出派生数据。</div>
        )}
      </Section>

      <Section title={`板件清单（派生 ${geom?.panels.length ?? 0} 种 / ${geom?.stats.totalPieces ?? 0} 件）`}>
        {geom ? (
          <>
            <div className="summary-line">
              板材 {geom.stats.boardAreaM2} m² · 约 {geom.stats.estWeightKg} kg
            </div>
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>板件</th>
                    <th>长×宽</th>
                    <th>厚</th>
                    <th>数</th>
                    <th>封边</th>
                  </tr>
                </thead>
                <tbody>
                  {geom.panels.map((pn) => (
                    <tr key={pn.id}>
                      <td>{pn.nameZh}</td>
                      <td className="mono">
                        {pn.length}×{pn.width}
                      </td>
                      <td className="mono">{pn.thickness}</td>
                      <td className="mono">{pn.qty}</td>
                      <td className="edge-cell">{pn.edgeLabel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <div className="empty-hint">无板件数据。</div>
        )}
      </Section>

      {geom && geom.hardware.length > 0 ? (
        <Section title={`五金清单（派生 ${geom.hardware.length} 项）`} defaultOpen={false}>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>五金</th>
                  <th>数</th>
                  <th>规格</th>
                </tr>
              </thead>
              <tbody>
                {geom.hardware.map((h) => (
                  <tr key={h.id}>
                    <td>{h.nameZh}</td>
                    <td className="mono">{h.qty}</td>
                    <td className="edge-cell">{h.spec}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {geom && geom.issues.length > 0 ? (
        <Section title={`该柜体问题（${geom.issues.length}）`}>
          <ul className="issue-list">
            {geom.issues.map((i, k) => (
              <li key={`${i.code}-${k}`}>
                <Pill kind={i.severity}>{i.severity}</Pill> <span className="mono">{i.code}</span> {i.message}
                {i.fixHint ? <div className="fix-hint">→ {i.fixHint}</div> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/**
 * 行高输入：数字（净高 mm）或 `fill`（吃掉剩余内高）。
 *
 * 为什么是一个输入框而不是“开关 + 数值”两个控件：
 *   `'fill'` 与数字是**同一个字段的两个取值**。拆成两个控件，界面就会出现
 *   “勾了还剩一个数”这种模型里根本不存在的中间态，而模型里只能有一个值。
 */
function RowHeightField(props: { value: RowHeight; onCommit: (v: RowHeight) => void }): ReactNode {
  const asText = (v: RowHeight): string => (v === ROW_HEIGHT_FILL ? 'fill' : String(v));
  const [text, setText] = useState(asText(props.value));
  useEffect(() => setText(asText(props.value)), [props.value]);

  const commit = (): void => {
    const t = text.trim().toLowerCase();
    if (t === 'fill' || t === '剩余') {
      setText('fill');
      if (props.value !== ROW_HEIGHT_FILL) props.onCommit(ROW_HEIGHT_FILL);
      return;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) {
      setText(asText(props.value));
      return;
    }
    const v = Math.max(1, Math.round(n));
    setText(String(v));
    if (v !== props.value) props.onCommit(v);
  };

  return (
    <div className="numfield">
      <input
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setText(asText(props.value));
            e.currentTarget.blur();
          }
        }}
      />
      <span className="suffix">{props.value === ROW_HEIGHT_FILL ? '剩余' : 'mm'}</span>
    </div>
  );
}

function UnitEditor(props: {
  cab: Cabinet;
  unit: UnitSpec;
  index: number;
  /** 该分区所在那一行的写路径前缀（单行 = `layout.units`，多行 = `layout.rows[j].units`） */
  basePath: string;
  rowIndex: number;
  /** 多行柜时的标题前缀（`R1 `）；单行柜为空串 */
  rowPrefix: string;
  netWidth: number | undefined;
  onRun: Run;
}): ReactNode {
  const { cab, unit, index, netWidth, basePath, rowPrefix } = props;
  const rowUnits = unitsAtPath(cab.layout, basePath);
  return (
    <Section title={`${rowPrefix}${index + 1}. ${unit.nickname ?? unit.kind} · 实际净宽 ${netWidth ?? '—'}mm`} defaultOpen={false}>
      <Row label="昵称">
        <TextField value={unit.nickname ?? ''} onCommit={(v) => props.onRun(CMD.setUnitString(cab, index, 'nickname', v, '重命名分区', 'ui', basePath))} />
      </Row>
      <Row label="期望净宽" hint="fit_total 策略下这只是「愿望」，实际净宽见标题与只读区">
        <NumField value={unit.requestedWidth} min={50} max={6000} onCommit={(v) => props.onRun(CMD.setUnitWidth(cab, index, v, 'ui', basePath))} />
      </Row>

      {unit.drawers ? (
        <>
          <Row label="抽屉数">
            <NumField value={unit.drawers.count} min={0} max={10} suffix="只" onCommit={(v) => props.onRun(CMD.setUnitInt(cab, index, 'drawers.count', v, `抽屉数 → ${v}`, 'ui', basePath))} />
          </Row>
          <Row label="滑轨长度">
            <NumField value={unit.drawers.runnerLength} min={200} max={600} onCommit={(v) => props.onRun(CMD.setUnitInt(cab, index, 'drawers.runnerLength', v, `滑轨长 → ${v}`, 'ui', basePath))} />
          </Row>
        </>
      ) : null}

      {unit.shelves ? (
        <Row label="层板数">
          <NumField value={unit.shelves.count} min={0} max={12} suffix="块" onCommit={(v) => props.onRun(CMD.setUnitInt(cab, index, 'shelves.count', v, `层板数 → ${v}`, 'ui', basePath))} />
        </Row>
      ) : null}

      {unit.doors ? (
        <>
          <Row label="门扇数">
            <NumField value={unit.doors.count} min={0} max={6} suffix="扇" onCommit={(v) => props.onRun(CMD.setUnitInt(cab, index, 'doors.count', v, `门扇数 → ${v}`, 'ui', basePath))} />
          </Row>
          <Row label="中缝">
            <NumField value={unit.doors.gapMid} min={0} max={20} onCommit={(v) => props.onRun(CMD.setUnitInt(cab, index, 'doors.gapMid', v, `门中缝 → ${v}`, 'ui', basePath))} />
          </Row>
          <Row label="外缝">
            <NumField value={unit.doors.gapOuter} min={0} max={20} onCommit={(v) => props.onRun(CMD.setUnitInt(cab, index, 'doors.gapOuter', v, `门外缝 → ${v}`, 'ui', basePath))} />
          </Row>
        </>
      ) : null}

      {unit.rod ? (
        <Row label="挂衣杆高">
          <NumField value={unit.rod.heightFromBottom} min={0} max={3000} onCommit={(v) => props.onRun(CMD.setUnitInt(cab, index, 'rod.heightFromBottom', v, `挂衣杆高 → ${v}`, 'ui', basePath))} />
        </Row>
      ) : null}

      <div className="btn-row">
        <button
          type="button"
          className="btn btn-danger"
          disabled={rowUnits.length <= 1}
          title={rowUnits.length <= 1 ? '至少保留一个分区' : ''}
          onClick={() => props.onRun(CMD.removeUnit(cab.id, cab.name, unit.id, 'ui', props.rowIndex))}
        >
          删除该分区
        </button>
      </div>
    </Section>
  );
}

// ─────────────────────────── 墙 ───────────────────────────

function WallProps(props: { wall: Wall; onRun: Run }): ReactNode {
  const { wall } = props;
  const len = Math.round(Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y));
  return (
    <div className="panel-scroll">
      <Section title={`墙「${wall.name}」（可写）`}>
        <Row label="名称">
          <TextField value={wall.name} onCommit={(v) => props.onRun(CMD.renameWall(wall.id, wall.name, v))} />
        </Row>
        <Row label="厚度">
          <NumField value={wall.thickness} min={20} max={400} onCommit={(v) => props.onRun(CMD.setWallThickness(wall.id, wall.name, v))} />
        </Row>
      </Section>
      <Section title="几何（🔒 由端点与厚度派生）">
        <Row label="起点" derived>
          <Text mono>
            ({wall.start.x}, {wall.start.y})
          </Text>
        </Row>
        <Row label="终点" derived>
          <Text mono>
            ({wall.end.x}, {wall.end.y})
          </Text>
        </Row>
        <Row label="长度" derived>
          <Text mono>{len} mm</Text>
        </Row>
        <Row label="墙高" derived>
          <Text mono>{wall.height} mm</Text>
        </Row>
      </Section>
      <div className="hint-line">拖动墙端点的方形夹点即可改起点/终点 —— 改的是 wall.start / wall.end 语义字段，不是"移动一条线"。</div>
    </div>
  );
}
