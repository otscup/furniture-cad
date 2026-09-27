import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Room, Vec2 } from '../../core/types.ts';
import * as CMD from '../../core/commands.ts';
import { rectRoom } from '../../core/docFactory.ts';
import { NumField, Pill, Row, Section, Text, TextField } from './common.tsx';

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
}): ReactNode {
  const { bus, run, onToast, onFocusRoom } = props;
  const project = bus.getState();

  const cabCountOf = (roomId: string): number => project.cabinets.filter((c) => c.roomId === roomId).length;

  const onNewRoom = (): void => {
    const n = project.rooms.length;
    const takenIds = new Set<string>();
    for (const r of project.rooms) {
      takenIds.add(r.id);
      for (const w of r.walls) takenIds.add(w.id);
    }
    const room = rectRoom({
      name: `房间${n + 1}`,
      x: n * 3600,
      y: 0,
      w: 3200,
      h: 2600,
      takenIds,
    });
    if (run(CMD.createRoomCommand(room))) onToast('ok', `已新建房间「${room.name}」`);
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

  const onDelete = (room: Room): void => {
    const n = cabCountOf(room.id);
    if (n > 0) {
      onToast('error', `房间内有 ${n} 个柜体，无法删除（请先移走或删除这些柜体）`);
      return;
    }
    if (run(CMD.deleteRoomCommand(room.id, room.name))) onToast('ok', `已删除房间「${room.name}」`);
  };

  return (
    <div className="panel-scroll">
      <Section title={`房间管理（${project.rooms.length}）`}>
        <div className="btn-row">
          <button type="button" className="tb-btn primary" onClick={onNewRoom}>
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
