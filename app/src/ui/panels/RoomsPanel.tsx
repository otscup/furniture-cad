import { useState, type ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Room, Vec2 } from '../../core/types.ts';
import * as CMD from '../../core/commands.ts';
import { rectRoom } from '../../core/docFactory.ts';
import { NumField, Pill, Row, Section, Text, TextField } from './common.tsx';

/** 房间页有两种状态：列表 / 新建。新建是**独立一页**，不在列表里凭空多出一张卡片 */
export type RoomsView = 'list' | 'new';

/** 房间尺寸来自四面墙端点，取包围盒的宽/高（mm） */
function roomDims(room: Room): { w: number; h: number } {
  if (room.walls.length === 0) return { w: 0, h: 0 };
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
  return { w: Math.round(maxX - minX), h: Math.round(maxY - minY) };
}

export function RoomsPanel(props: {
  bus: CommandBus;
  version: number;
  run: (cmd: import('../../core/commandBus.ts').Command) => boolean;
  onToast: (kind: 'ok' | 'info' | 'error', msg: string) => void;
  onFocusRoom: (id: string) => void;
  view: RoomsView;
  onViewChange: (v: RoomsView) => void;
  onCreated: (roomId: string) => void;
  readOnly?: boolean;
}): ReactNode {
  const { bus, run, onToast, onFocusRoom, view, onViewChange, onCreated } = props;
  const project = bus.getState();

  const cabCountOf = (roomId: string): number => project.cabinets.filter((c) => c.roomId === roomId).length;

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

  const onDelete = (room: Room): void => {
    const n = cabCountOf(room.id);
    if (n > 0) {
      onToast('error', `房间内有 ${n} 个柜体，无法删除（请先移走或删除这些柜体）`);
      return;
    }
    if (run(CMD.deleteRoomCommand(room.id, room.name))) onToast('ok', `已删除房间「${room.name}」`);
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
        <div className="btn-row">
          <button type="button" className="tb-btn primary" disabled={props.readOnly} onClick={() => onViewChange('new')}>
            + 新建房间
          </button>
        </div>
        <div className="hint-line">
          每个房间是独立、可命名、可单独查看的实体。点「聚焦」会把平面图缩放到该房间，
          多个房间时一眼就能分清哪个是哪个。删除带柜体的房间会被拦下，避免留下悬空柜体。
        </div>

        {project.rooms.length === 0 ? (
          <div className="hint-line">还没有房间。点「+ 新建房间」，或用工具栏「+ 房间」、平面图「画墙」工具。</div>
        ) : null}

        <div className="room-list">
          {project.rooms.map((room, index) => {
            const dims = roomDims(room);
            const cabs = cabCountOf(room.id);
            const hasWalls = room.walls.length > 0;
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
                  <Text mono>{room.walls.length} 面</Text>
                </Row>

                <div className="room-actions">
                  <button type="button" className="tb-btn" onClick={() => onFocusRoom(room.id)} title="平面图缩放到该房间">
                    聚焦
                  </button>
                  <button
                    type="button"
                    className="tb-btn danger"
                    disabled={cabs > 0}
                    title={cabs > 0 ? `房间内有 ${cabs} 个柜体，先移走或删除` : '删除该房间'}
                    onClick={() => onDelete(room)}
                  >
                    删除
                  </button>
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
 *
 * ── 为什么不再"点了就立刻多一张卡片" ──
 *   旧做法是点「+ 新建房间」就地 append 一个默认 3200×2600 的房间：
 *   用户还没填名字，列表里就并排多出一个「房间3」，跟已有房间混在一起，
 *   既分不清哪个是新加的，也没机会先想好尺寸。
 *   这里改成：先给一页表单（名称 / 宽 / 高 / 落位），确认后才真的建。
 *
 * ── 尺寸为什么是"填数字"而不是"拖四个角" ──
 *   房间尺寸本来就由四面墙端点决定（room.resize 也是这么做的）；
 *   矩形房间是最常见的情况，给它一条最快的路；异形房间仍然去平面图「画墙」。
 */
function NewRoomPage(props: {
  bus: CommandBus;
  run: (cmd: import('../../core/commandBus.ts').Command) => boolean;
  onToast: (kind: 'ok' | 'info' | 'error', msg: string) => void;
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
    /**
     * 房间 id 与墙 id 必须避开**全项目**已用的（不能只按"第几个房间"编）。
     * 少了这几行，第二个房间拿到的还是 room_001 → 结构性命令被拒 → 永远建不出第二个。
     */
    const takenIds = new Set<string>();
    for (const r of project.rooms) {
      takenIds.add(r.id);
      for (const wl of r.walls) takenIds.add(wl.id);
    }
    let maxX = 0;
    for (const r of project.rooms) for (const wl of r.walls) maxX = Math.max(maxX, wl.start.x, wl.end.x);
    const x = project.rooms.length === 0 ? 0 : Math.round(maxX) + 200;
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
          填写名称即可创建；默认矩形为 3200×2600mm，之后可在房间面板调整尺寸。异形房间请用平面图里的「画墙」工具。
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
