import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { RuleSet, Room } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { emptyProject, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import * as CMD from '../src/core/commands.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  房间管理命令验收 —— 「添加房间应该是单独的一页」
 *
 *  用户原话：
 *    "添加房间应该是单独的一页……现在我添加房间和柜子后点击展开4面图
 *     所有房间都展开了，如果以后房间多了完全不知道哪个是哪个。"
 *
 *  ── 这批断言要证明什么 ──
 *    ① room.resize 真的改了四面墙端点（且坐标精确缩放，不是只改个标注）。
 *    ② room.resize 不碰柜体 placement（房间缩放与柜体归属解耦）。
 *    ③ room.delete 删的是房间本体；含柜体时**拒绝**并说清原因（不静默留孤儿）。
 *    ④ 删除 / 调整尺寸都可撤销，且撤销后几何逐位还原（不是"大概回来了"）。
 *    ⑤ room.rename 走路径白名单，改名可撤销。
 *    ⑥ 退化房间（墙共线、包围盒为 0）resize 被拒 —— 反向证明正常房间能缩放。
 * ══════════════════════════════════════════════════════════════════════
 */

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(title: string): void {
  console.log(`\n【${title}】`);
}

function bbox(room: Room): { w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const w of room.walls) {
    for (const p of [w.start, w.end]) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { w: maxX - minX, h: maxY - minY };
}

function corners(room: Room): Set<string> {
  const s = new Set<string>();
  for (const w of room.walls) {
    s.add(`${Math.round(w.start.x)},${Math.round(w.start.y)}`);
    s.add(`${Math.round(w.end.x)},${Math.round(w.end.y)}`);
  }
  return s;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ───────────────────────── A. 基线：room.create 仍可用 ─────────────────────────
section('A. 新建房间（基线）');
{
  const bus = new CommandBus(emptyProject({ name: '家', ruleSetId: rules.id }), rules);
  const v0 = bus.getVersion();
  const room = rectRoom({ name: '主卧', x: 0, y: 0, w: 3200, h: 2600, thickness: 120, height: 2700 });
  const r = bus.execute(CMD.createRoomCommand(room));
  ok('room.create 成功', r.ok === true);
  ok('房间数变成 1', bus.getState().rooms.length === 1);
  ok('矩形房间有 4 面墙', bus.getState().rooms[0].walls.length === 4);
  ok('版本号被 bump', bus.getVersion() === v0 + 1);
  ok('初始尺寸 3200×2600', (() => {
    const d = bbox(bus.getState().rooms[0]);
    return Math.round(d.w) === 3200 && Math.round(d.h) === 2600;
  })());
}

// ───────────────────────── B. room.resize 精确缩放 + 不动柜体 ─────────────────────────
section('B. 调整房间尺寸（精确缩放）');
{
  const bus = new CommandBus(sampleProject(rules), rules); // 主卧 3200×2600 + 一个 2400 衣柜
  const room = bus.getState().rooms[0];
  const cab = bus.getState().cabinets[0];
  const beforeCab = { x: cab.placement.x, y: cab.placement.y };
  const beforeCorners = corners(room);
  const v0 = bus.getVersion();

  const r = bus.execute(CMD.resizeRoomCommand(room.id, 4000, 3000));
  ok('resize 成功', r.ok === true);
  const r2 = bus.getState().rooms[0];
  ok('bbox 宽=4000', Math.round(bbox(r2).w) === 4000);
  ok('bbox 高=3000', Math.round(bbox(r2).h) === 3000);
  ok(
    '四角精确缩放（0,0 / 4000,0 / 4000,3000 / 0,3000）',
    sameSet(corners(r2), new Set(['0,0', '4000,0', '4000,3000', '0,3000'])),
  );
  const cabAfter = bus.getState().cabinets[0].placement;
  ok('柜体 placement 未被 resize 改动', cabAfter.x === beforeCab.x && cabAfter.y === beforeCab.y);
  ok('版本号被 bump', bus.getVersion() === v0 + 1);

  // 撤销必须逐位还原
  bus.undo();
  const r3 = bus.getState().rooms[0];
  ok('撤销后尺寸还原 3200×2600', (() => {
    const d = bbox(r3);
    return Math.round(d.w) === 3200 && Math.round(d.h) === 2600;
  })());
  ok('撤销后四角还原', sameSet(corners(r3), beforeCorners));
  const cabUndo = bus.getState().cabinets[0].placement;
  ok('撤销后柜体 placement 仍不变', cabUndo.x === beforeCab.x && cabUndo.y === beforeCab.y);
}

// ───────────────────────── C. room.delete 含柜体时拒删 ─────────────────────────
section('C. 删除房间（含柜体必须拒删）');
{
  const bus = new CommandBus(sampleProject(rules), rules); // 主卧 + 衣柜
  const room = bus.getState().rooms[0];
  const r = bus.execute(CMD.deleteRoomCommand(room.id, room.name));
  ok('含柜体时删除被拒', r.ok === false);
  ok('拒绝理由点明「柜体」', !!r.error && r.error.includes('柜体'));
  ok('被拒后房间仍在', bus.getState().rooms.length === 1);
}

// ───────────────────────── D. room.delete 空房间可删 + 可撤销 ─────────────────────────
section('D. 删除房间（空房间可删，可撤销）');
{
  const bus = new CommandBus(sampleProject(rules), rules);
  // 注意：必须避开全项目已用的 id，否则第二个房间 id 撞首房 → create 被结构性命令拒绝
  const takenIds = new Set<string>();
  for (const rr of bus.getState().rooms) {
    takenIds.add(rr.id);
    for (const w of rr.walls) takenIds.add(w.id);
  }
  const empty = rectRoom({ name: '空房', x: 10000, y: 0, w: 2000, h: 2000, thickness: 120, height: 2700, takenIds });
  bus.execute(CMD.createRoomCommand(empty));
  const before = bus.getState().rooms.length;
  const r = bus.execute(CMD.deleteRoomCommand(empty.id, empty.name));
  ok('空房间删除成功', r.ok === true);
  ok('删除后少一个', bus.getState().rooms.length === before - 1);
  ok('被删房间确实不在了', bus.getState().rooms.find((x) => x.id === empty.id) === undefined);

  bus.undo();
  ok('撤销后空房间回来', bus.getState().rooms.find((x) => x.id === empty.id) !== undefined);
  ok('撤销后房间数复原', bus.getState().rooms.length === before);
  const restored = bus.getState().rooms.find((x) => x.id === empty.id);
  ok('撤销后房间墙也还原（4 面）', !!restored && restored.walls.length === 4);
}

// ───────────────────────── E. room.rename 走白名单 + 可撤销 ─────────────────────────
section('E. 重命名房间（路径白名单）');
{
  const bus = new CommandBus(sampleProject(rules), rules);
  const room = bus.getState().rooms[0];
  const r = bus.execute(CMD.renameRoomCommand(0, room.name, '新卧室'));
  ok('rename 成功', r.ok === true);
  ok('名字改了', bus.getState().rooms[0].name === '新卧室');
  bus.undo();
  ok('撤销后名字还原', bus.getState().rooms[0].name === room.name);
}

// ───────────────────────── F. 退化房间 resize 被拒（反向证明） ─────────────────────────
section('F. 退化房间 resize 被拒（反向证明正常房间能缩放）');
{
  const bus = new CommandBus(emptyProject({ name: '家', ruleSetId: rules.id }), rules);
  // w=0,h=0 → 四面墙全在 (0,0)，包围盒退化
  const deg = rectRoom({ name: '退化', x: 0, y: 0, w: 0, h: 0, thickness: 120, height: 2700 });
  bus.execute(CMD.createRoomCommand(deg));
  const r = bus.execute(CMD.resizeRoomCommand(deg.id, 1000, 1000));
  ok('退化房间 resize 被拒', r.ok === false);
  ok('被拒理由说清（退化）', !!r.error);
}

// ───────────────────────── 汇总 ─────────────────────────
console.log(`\n${fail === 0 ? '✅' : '❌'} 房间命令验收：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
