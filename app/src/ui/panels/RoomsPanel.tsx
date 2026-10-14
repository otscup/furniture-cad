import { useState, type ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Room, Vec2 } from '../../core/types.ts';
import * as CMD from '../../core/commands.ts';
import { rectRoom } from '../../core/docFactory.ts';
import { deoverlapProjectRooms } from '../../core/unitIdentity.mjs';
import { NumField, Pill, Row, Section, Text, TextField } from './common.tsx';

/** 房间页有两种状态：列表 / 新建。新建是**独立一页**，不在列表里凭空多出一张卡片 */
export type RoomsView = 'list' | 'new';

/** 房间尺寸来自四面墙端点，取包围盒的宽/高（mm） */
function roomDims(room: Room): { w: number; h: number; minX: number; minY: number; maxX: number; maxY: number } {
  if (room.walls.length === 0) return { w: 0, h: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const wll of room.walls) {
    for (const p of [wll.start, wll.end] as Vec2[]) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return {
    w: Math.round(maxX - minX),
    h: Math.round(maxY - minY),
    minX: Math.round(minX),
    minY: Math.round(minY),
    maxX: Math.round(maxX),
    maxY: Math.round(maxY),
  };
}

export function RoomsPanel(props: {
  bus: CommandBus;
  version: number;
  run: (cmd: import('../../core/commandBus.ts').Command) => boolean;
  onToast: (kind: 'ok' | 'info' | 'warn' | 'error', msg: string) => void;
  onFocusRoom: (id: string) => void;
  view: RoomsView;
  onViewChange: (v: RoomsView) => void;
  onCreated: (roomId: string) => void;
  onSyncToServer?: () => Promise<boolean> | void;
  remoteDiffers?: boolean;
  readOnly?: boolean;
}): ReactNode {
  const { bus, run, onToast, onFocusRoom, view, onViewChange, onCreated } = props;
  const project = bus.getState();
  const [confirmCascadeId, setConfirmCascadeId] = useState<string | null>(null);

  const cabCountOf = (roomId: string): number => project.cabinets.filter((c) => c.roomId === roomId).length;

  const hasOverlappingRooms = (() => {
    const boxes = project.rooms.map(roomDims).filter((b) => b.w > 0 && b.h > 0);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY) return true;
      }
    }
    return false;
  })();

  const onDeoverlapRooms = (): void => {
    if (props.readOnly) return;
    const { project: nextProj, movedRooms } = deoverlapProjectRooms(project);
    if (movedRooms.length === 0) {
      onToast('info', '当前没有坐标重叠的房间');
      return;
    }
    bus.replaceProject(nextProj, `自动错开重叠房间（${movedRooms.map((r: { roomName: string }) => r.roomName).join('、')}）`);
    onToast('ok', `已自动错开 ${movedRooms.length} 个重叠房间（连同房内柜体一并平移）`);
  };

  const onRename = (room: Room, index: number, toName: string): void => {
    if (!toName || toName === room.name) return;
    if (!run(CMD.renameRoomCommand(index, room.name, toName))) {
      onToast('error', '重命名被总线拒绝');
    }
  };

  const onResize = (room: Room, w: number, h: number): void => {
    if (room.walls.length === 0) {
      onToast('error', '这个房间还没有墙，无法调整尺寸（请先画墙）');
      return;
    }
    if (!run(CMD.resizeRoomCommand(room.id, w, h))) {
      onToast('error', '调整尺寸被总线拒绝（房间可能退化或尺寸非法）');
    }
  };

  const onDelete = (room: Room, cascade = false): void => {
    if (props.readOnly) {
      onToast('warn', '当前工作区处于只读锁状态，请先点击顶部横幅「一键自动修复重复 Unit ID」解锁后再删除房间');
      return;
    }
    const n = cabCountOf(room.id);
    if (n > 0 && !cascade) {
      setConfirmCascadeId(room.id);
      return;
    }
    if (run(CMD.deleteRoomCommand(room.id, room.name, 'ui', cascade && n > 0))) {
      setConfirmCascadeId(null);
      onToast('ok', cascade && n > 0 ? `已删除房间「${room.name}」及其 ${n} 台柜体（可撤销）` : `已删除房间「${room.name}」`);
    }
  };

  /** 新建房间是独立一页 —— 点「+ 新建房间」只**切到那一页**，不立刻造一个出来 */
  if (view === 'new') {
    return (
      <NewRoomPage
        bus={bus}
        run={run}
        onToast={onToast}
        onCancel={() => onViewChange('list')}
        onCreated={onCreated}
        onDone={() => onViewChange('list')}
        readOnly={props.readOnly}
      />
    );
  }

  return (
    <div className="panel-scroll">
      <Section title={`房间管理（${project.rooms.length}）`}>
        <div className="btn-row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <button type="button" className="tb-btn primary" disabled={props.readOnly} onClick={() => onViewChange('new')}>
            + 新建房间
          </button>
          {props.onSyncToServer ? (
            <button
              type="button"
              className="tb-btn"
              disabled={props.readOnly}
              onClick={() => void props.onSyncToServer?.()}
              title="将本地房间与柜体修改同步写入服务端工作区"
            >
              {props.remoteDiffers ? '⚡ 同步修改到服务端' : '☁️ 同步到服务端'}
            </button>
          ) : null}
          {hasOverlappingRooms ? (
            <button
              type="button"
              className="tb-btn"
              disabled={props.readOnly}
              onClick={onDeoverlapRooms}
              title="将坐标重叠在 (0,0) 的多个房间及柜体自动横向错开排布"
            >
              📐 一键错开重叠房间
            </button>
          ) : null}
        </div>
        <div className="hint-line">
          每个房间是独立、可命名、可单独查看的实体。点「聚焦」会把平面图缩放到该房间；空房间可直接删除，含柜体的房间点击「删除」后确认即可连同房内柜体一并删除（支持 Ctrl+Z 一步撤销）。
        </div>

        {project.rooms.length === 0 ? (
          <div className="hint-line">还没有房间。点「+ 新建房间」，或用工具栏「+ 房间」、平面图「画墙」工具。</div>
        ) : null}

        <div className="room-list">
          {project.rooms.map((room, index) => {
            const dims = roomDims(room);
            const cabs = cabCountOf(room.id);
            const hasWalls = room.walls.length > 0;
            const confirmingCascade = confirmCascadeId === room.id;
            return (
              <div key={room.id} className="room-card">
                <div className="room-card-head">
                  <TextField value={room.name} onCommit={(v) => onRename(room, index, v)} />
                  <Pill kind={cabs > 0 ? 'INFO' : 'muted'}>{cabs} 个柜体</Pill>
                </div>
                {room.note ? <div className="room-note">{room.note}</div> : null}

                <Row label="尺寸（宽×高）">
                  {hasWalls ? (
                    <span className="room-dims">
                      <NumField
                        value={dims.w}
                        min={300}
                        max={20000}
                        step={50}
                        suffix="mm"
                        onCommit={(v) => onResize(room, v, dims.h)}
                      />
                      <span className="room-x">×</span>
                      <NumField
                        value={dims.h}
                        min={300}
                        max={20000}
                        step={50}
                        suffix="mm"
                        onCommit={(v) => onResize(room, dims.w, v)}
                      />
                    </span>
                  ) : (
                    <span className="muted">（无墙）</span>
                  )}
                </Row>

                <Row label="墙体">
                  <Text mono>{room.walls.length} 面{hasWalls ? ` · 起点 (${dims.minX}, ${dims.minY})` : ''}</Text>
                </Row>

                <div className="room-actions" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <button type="button" className="tb-btn" onClick={() => onFocusRoom(room.id)} title="平面图缩放到该房间">
                    聚焦
                  </button>
                  {!confirmingCascade ? (
                    <button
                      type="button"
                      className="tb-btn danger"
                      disabled={props.readOnly}
                      title={cabs > 0 ? `删除该房间（含房内 ${cabs} 台柜体，点击后二次确认）` : '删除该房间'}
                      onClick={() => onDelete(room, false)}
                    >
                      {cabs > 0 ? `删除（含${cabs}柜）` : '删除'}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="tb-btn danger"
                        disabled={props.readOnly}
                        onClick={() => onDelete(room, true)}
                      >
                        确认连同 {cabs} 台柜体删除
                      </button>
                      <button
                        type="button"
                        className="tb-btn"
                        onClick={() => setConfirmCascadeId(null)}
                      >
                        取消
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

/**
 * 新建房间 —— **独立一页**。
 */
function NewRoomPage(props: {
  bus: CommandBus;
  run: (cmd: import('../../core/commandBus.ts').Command) => boolean;
  onToast: (kind: 'ok' | 'info' | 'warn' | 'error', msg: string) => void;
  onCancel: () => void;
  onCreated: (roomId: string) => void;
  onDone: () => void;
  readOnly?: boolean;
}): ReactNode {
  const { bus, run, onToast, onCancel, onCreated, onDone } = props;
  const project = bus.getState();
  const suggested = `房间${project.rooms.length + 1}`;
  const [name, setName] = useState(suggested);
  const [note, setNote] = useState('');

  /** 名称必填且唯一；尺寸采用轻量新建的安全默认值，之后可在房间面板调整。 */
  const problem = (): string => {
    const t = name.trim();
    if (!t) return '房间名不能为空';
    if (project.rooms.some((r) => r.name === t)) return `已经有一个房间叫「${t}」`;
    return '';
  };

  const onCreate = (): void => {
    if (props.readOnly) return;
    const bad = problem();
    if (bad) {
      onToast('error', bad);
      return;
    }
    const takenIds = new Set<string>();
    for (const r of project.rooms) {
      takenIds.add(r.id);
      for (const wl of r.walls) takenIds.add(wl.id);
    }
    let maxX = 0;
    for (const r of project.rooms) for (const wl of r.walls) maxX = Math.max(maxX, wl.start.x, wl.end.x);
    const x = project.rooms.length === 0 ? 0 : Math.round(maxX) + 800;
    const room = rectRoom({ name: name.trim(), note, x, y: 0, w: 3200, h: 2600, takenIds });
    if (!run(CMD.createRoomCommand(room))) {
      onToast('error', '新建房间被总线拒绝');
      return;
    }
    onToast('ok', `已新建房间「${room.name}」3200×2600mm`);
    onCreated(room.id);
    onDone();
  };

  const bad = problem();

  return (
    <div className="panel-scroll">
      <Section title="新建房间">
        <div className="btn-row">
          <button type="button" className="tb-btn" onClick={onCancel}>
            ← 返回房间列表
          </button>
        </div>
        <div className="hint-line">
          填写名称即可创建；默认矩形为 3200×2600mm（自动排布在现有房间右侧，绝不重叠），之后可在房间面板调整尺寸。
        </div>

        <Row label="名称">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：主卧" maxLength={80} required aria-label="房间名称" />
        </Row>
        <Row label="备注（可选）">
          <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} aria-label="房间备注（可选）" />
        </Row>

        <Row label="默认规格">
          <Text mono>矩形 · 4 面墙 · 3200×2600mm</Text>
        </Row>

        {bad ? <div className="hint-line">{bad}</div> : null}

        <div className="btn-row">
          <button type="button" className="tb-btn primary" disabled={props.readOnly || bad !== ''} onClick={onCreate}>
            创建房间
          </button>
          <button type="button" className="tb-btn" onClick={onCancel}>
            取消
          </button>
        </div>
      </Section>
    </div>
  );
}
