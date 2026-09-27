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
  onCreated: () => void;
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
      />
    );
  }

  return (
    <div className="panel-scroll">
      <Section title={`房间管理（${project.rooms.length}）`}>
        <div className="btn-row">
          <button type="button" className="tb-btn primary" onClick={() => onViewChange('new')}>
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
  onCreated: () => void;
  onDone: () => void;
}): ReactNode {
  const { bus, run, onToast, onCancel, onCreated, onDone } = props;
  const project = bus.getState();

  /** 默认落位：排在现有房间的右边，留 200 间隙 —— 一眼看得出"这是新加的" */
  const defaultX = (): number => {
    let maxX = 0;
    for (const r of project.rooms) for (const wl of r.walls) maxX = Math.max(maxX, wl.start.x, wl.end.x);
    return project.rooms.length === 0 ? 0 : Math.round(maxX) + 200;
  };

  const suggested = `房间${project.rooms.length + 1}`;
  const [name, setName] = useState(suggested);
  const [w, setW] = useState(3200);
  const [h, setH] = useState(2600);
  const [x, setX] = useState(defaultX);
  const [y, setY] = useState(0);

  /** 唯一一处校验：问题写在界面上，同时让「创建」按钮不可用 —— 不给"点了才知道错"的机会 */
  const problem = (): string => {
    const t = name.trim();
    if (!t) return '房间名不能为空';
    if (project.rooms.some((r) => r.name === t)) return `已经有一个房间叫「${t}」`;
    if (!(w >= 300 && w <= 20000)) return '宽度要在 300–20000mm 之间';
    if (!(h >= 300 && h <= 20000)) return '高度要在 300–20000mm 之间';
    return '';
  };

  const onCreate = (): void => {
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
    const room = rectRoom({ name: name.trim(), x, y, w, h, takenIds });
    if (!run(CMD.createRoomCommand(room))) {
      onToast('error', '新建房间被总线拒绝');
      return;
    }
    onToast('ok', `已新建房间「${room.name}」${w}×${h}mm`);
    onCreated();
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
          填好再创建 —— 创建后才会出现在房间列表里。异形（非矩形）房间请用平面图里的「画墙」工具。
        </div>

        <Row label="名称">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：主卧" />
        </Row>
        <Row label="宽（X 向）">
          <input className="input" type="number" min={300} max={20000} step={50} value={w} onChange={(e) => setW(Number(e.target.value))} />
        </Row>
        <Row label="高（Y 向）">
          <input className="input" type="number" min={300} max={20000} step={50} value={h} onChange={(e) => setH(Number(e.target.value))} />
        </Row>
        <Row label="落位 X">
          <input className="input" type="number" step={50} value={x} onChange={(e) => setX(Number(e.target.value))} />
        </Row>
        <Row label="落位 Y">
          <input className="input" type="number" step={50} value={y} onChange={(e) => setY(Number(e.target.value))} />
        </Row>

        <Row label="预览">
          <Text mono>{`矩形 · 4 面墙 · ${w}×${h}mm`}</Text>
        </Row>

        {bad ? <div className="hint-line">{bad}</div> : null}

        <div className="btn-row">
          <button type="button" className="tb-btn primary" disabled={bad !== ''} onClick={onCreate}>
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
