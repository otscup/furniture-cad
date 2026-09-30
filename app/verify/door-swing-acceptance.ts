/**
 * ══════════════════════════════════════════════════════════════════════
 *  P8.9 Door Swing / Clearance Semantics 验收
 *
 *  覆盖指令 §二十二 的 50 项，按七组组织：
 *    §1 语义 1~9        铰链/朝向/未指定/非法值/序列化/undo/redo
 *    §2 几何 10~18      0/90/180/270° 墙、房间平移、洞口宽·位、非正方柜、旋转柜
 *    §3 扇区 19~24      clear / 贴边 / 部分重叠 / 完全重叠 / 向内开·向外开
 *    §4 unknown 25~29   房间不闭合 / 墙退化 / 洞口越界 / 缺开启信息 / 洞口非法
 *    §5 架构 30~38      无三角函数 / 复用几何原语 / 不改模型 / 不调 AI / 不出 BOM·DXF
 *    §6 关系 39~44      P8.7 洞口判定不变 / P8.8 同源不变 / 进统一报告 /
 *                       intent 不绕过 / 报告确定性 / 不重复报
 *    §7 UI·持久化 45~50 界面能设 / 能清 / 重开保留 / 旧项目能开 / schema 策略不变
 *
 *  判据纪律（本项目反复钉过的，一条都不省）：
 *    · 断言要钉到**具体码与具体数**，"被拒了/没报错"这种会被别处检查顶替而假绿；
 *    · 带数字的断言必须是"喂进去/派生出的那个值真的出现在文案里"，不能只断言 /\d/；
 *    · 每个夹具必须有**独立的房间副本**（复用同一个 Room 对象会让后建的用例
 *      把先建用例的 openings 覆盖掉 —— 探针里真实踩过这个坑，会让一堆断言假绿）；
 *    · 每条失败时先把原始值打出来 —— **先假定断言自己写错**。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CommandBus } from '../src/core/commandBus.ts';
import * as CMD from '../src/core/commands.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, DoorHinge, DoorSwingDirection, Project, Room, Vec2 } from '../src/core/types.ts';
import { getCabinetFootprint } from '../src/core/geometry/generate.ts';
import { parseProjectFile, resolveSchemaVersion, serializeProjectFile } from '../src/core/projectFile.ts';
import {
  DOOR_SWING,
  DOOR_UNKNOWN_ZH,
  clearancesOfDoor,
  deriveDoorSwing,
  deriveSpatial,
  doorEnvelopeOf,
  doorFactOf,
  roomLoop,
  wallInteriorSide,
  type DoorSwingEnvelope,
  type DoorSwingFact,
} from '../src/core/spatial/index.ts';
import { validateDesign } from '../src/core/designValidation/index.ts';
import { validatePlacementDesign, withResolvedPlacements } from '../src/core/placementDesign.ts';
import { resolvePlacement, sceneFromProject, type PlacementIntent } from '../src/core/placement.ts';
import { doorSwingPrimsOf } from '../src/viewport/doorSwingPrims.ts';
import { LAYERS } from '../src/viewport/layers.ts';
import { RULE_CODES, ruleCard } from '../src/core/rules/issueCatalog.ts';

const APP = join(import.meta.dirname, '..');
const SAVED_AT = '2026-01-01T00:00:00.000Z'; // 墙钟元数据不参与内容比较（P8.6 踩过的坑）
const DOOR_SWING_CODE = 'DESIGN-CABINET-DOOR-SWING';
const OPENING_CODE = 'SPATIAL-CABINET-OPENING';

let passed = 0;
let failed = 0;
const fails: string[] = [];
function ok(name: string, cond: unknown, detail: unknown = ''): void {
  if (cond === true) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  ✗ ${name}  ── ${JSON.stringify(detail)}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

// ─────────────────────────── fixture ───────────────────────────

const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset/factory-default.json'), 'utf8')) as never;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 矩形房间 4000×3000，墙 id/名固定：w1 南(0,0)→(4000,0) / w2 东 / w3 北(4000,3000)→(0,3000) / w4 西 */
function mkRoom(id: string, x = 0, y = 0, w = 4000, h = 3000, thickness = 120): Room {
  const room = rectRoom({ id, name: `房间${id}`, x, y, w, h, thickness, height: 2700 });
  room.walls.forEach((wl, i) => {
    wl.id = `${id}_w${i + 1}`;
    wl.name = `${id}墙${i + 1}`;
  });
  return room;
}

function mkCab(room: Room, id: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet {
  const units = defaultUnits(w, RULES, d).map((u) => ({ ...u, id: `${id}_${u.id}` }));
  return createCabinet({
    id,
    name: id,
    roomId: room.id,
    x,
    y,
    rotation,
    rules: RULES,
    params: { ...defaultCabinetParams(RULES), width: w, height: 2200, depth: d },
    units,
  });
}

const mkProject = (rooms: Room[], cabinets: Cabinet[]): Project =>
  ({ schemaVersion: '0.3', id: 'proj', name: 'P89', ruleSetId: (RULES as { id: string }).id, rooms, cabinets }) as Project;

/** 无门的干净房间项目（**每次新建房间**，不复用对象 —— 见文件头判据纪律第 3 条） */
const bare = (cabinets: Cabinet[] = []): Project => mkProject([mkRoom('r1')], cabinets);

type DoorSpec = { id: string; kind: 'door'; offset: number; width: number } & Partial<{ hinge: DoorHinge; swingDirection: DoorSwingDirection }>;

const door = (patch: Partial<DoorSpec> = {}): DoorSpec => ({
  id: 'open_001',
  kind: 'door',
  offset: 1000,
  width: 900,
  hinge: 'start',
  swingDirection: 'into-room',
  ...patch,
});

/** 北墙(w3)上挂一扇门 + 指定柜体；房间**先深拷贝**，避免用例之间互相污染 */
function withNorthDoor(room: Room, cabinets: Cabinet[], d: DoorSpec = door()): Project {
  const r = clone(room);
  r.walls[2]!.openings = [d];
  return mkProject([r], cabinets);
}

const codesOf = (p: Project): string[] => deriveSpatial(p).issues.map((i) => i.code);
const envOf = (p: Project, openingId = 'open_001'): DoorSwingEnvelope => {
  const f = deriveDoorSwing(p).doors.find((x) => x.openingId === openingId);
  if (!f?.envelope) throw new Error(`夹具错了：这扇门没有包络（${JSON.stringify(f)}）`);
  return f.envelope;
};
const clearanceOf = (p: Project, cabinetId: string): { status: string; distance?: number; intrusion?: number; hitRadius?: number } => {
  const c = deriveDoorSwing(p).clearances.find((x) => x.cabinetId === cabinetId);
  if (!c) throw new Error(`夹具错了：没有 ${cabinetId} 的净空判定`);
  return c;
};
const src = (...parts: string[]): string => readFileSync(join(APP, ...parts), 'utf8');
/** 剥掉注释再扫源码：注释里出现"knowledge / DXF"这些词不算违规（P8.8 踩过的假红） */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ═══════════════ §1 语义（1~9） ═══════════════
section('§1 语义：铰链 / 朝向 / 未指定 / 非法值 / 序列化 / undo·redo');

{
  const room = mkRoom('r1');
  const WALL = 'r1_w3';
  const WALL_NAME = '房间r1墙3';
  const doorCmd = (patch: { hinge?: DoorHinge | null; swingDirection?: DoorSwingDirection | null }) =>
    CMD.updateOpening(WALL, WALL_NAME, 'open_001', 'door', 900, patch);

  // 1. hinge = start：authored 写进模型，派生包络的铰链落在**起点侧**门垛（北墙起点 x=4000）
  const bus = new CommandBus(bare(), RULES);
  bus.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
  const r1 = bus.execute(doorCmd({ hinge: 'start', swingDirection: 'into-room' }));
  const op1 = bus.getState().rooms[0]!.walls[2]!.openings![0]!;
  const env1 = envOf(bus.getState());
  ok(
    '1. hinge=start 进模型，且包络铰链落在起点侧门垛（offset=1000 → x=3000，墙内表面 y=2940）',
    r1.ok && op1.hinge === 'start' && env1.hinge.x === 3000 && env1.hinge.y === 2940,
    JSON.stringify({ ok: r1.ok, op: op1, hinge: env1.hinge })
  );
  // 1b. 门扇关闭位置沿墙指向另一侧门垛、开启位置垂直于墙 —— 两个方向恰好垂直（90°）
  const closed: Vec2 = { x: env1.closedTip.x - env1.hinge.x, y: env1.closedTip.y - env1.hinge.y };
  const open: Vec2 = { x: env1.openTip.x - env1.hinge.x, y: env1.openTip.y - env1.hinge.y };
  ok(
    '1b. 关闭方向 ∥ 墙方向、开启方向 ⊥ 墙方向（内积 0），半径 = 洞口净宽 900，扇区 = 8 段折线 + 2 端点',
    Math.abs(closed.x * open.x + closed.y * open.y) < 1e-9 &&
      env1.radius === 900 &&
      env1.poly.length === DOOR_SWING.ARC_SEGMENTS + 2,
    JSON.stringify({ closed, open, r: env1.radius, n: env1.poly.length })
  );

  // 2. hinge = end → 铰链在**终点侧**门垛（offset+width=1900 → x=2100）
  const bus2 = new CommandBus(bus.getState(), RULES);
  const r2 = bus2.execute(doorCmd({ hinge: 'end' }));
  const env2 = envOf(bus2.getState());
  ok(
    '2. hinge=end → 铰链落到终点侧门垛（x=2100），关闭方向随之反向（指向 +x 到 x=3000）',
    r2.ok &&
      bus2.getState().rooms[0]!.walls[2]!.openings![0]!.hinge === 'end' &&
      env2.hinge.x === 2100 &&
      env2.closedTip.x === 3000,
    JSON.stringify({ hinge: env2.hinge, closedTip: env2.closedTip })
  );

  // 3. 向室内开：整个扇区落在房间回路内（室内侧由 P8.7 的回路判定，不是猜的）
  const loop = roomLoop(room.walls);
  ok(
    '3. swingDirection=into-room → 扇区每个顶点都落在房间内',
    env1.poly.every((p) => pointInPolySafe(p, loop.poly)),
    JSON.stringify(env1.poly)
  );

  // 4. 向室外开：整个扇区落在房间外
  const bus4 = new CommandBus(bus.getState(), RULES);
  bus4.execute(doorCmd({ swingDirection: 'out-of-room' }));
  const env4 = envOf(bus4.getState());
  ok(
    '4. swingDirection=out-of-room → 扇区整个落在房间外（铰链翻到外墙面 y=3060）',
    env4.hinge.y === 3060 && env4.poly.every((p) => pointInPolySafe(p, loop.poly) === false),
    JSON.stringify({ hinge: env4.hinge, poly: env4.poly.slice(0, 3) })
  );

  // 5. 未指定：判不出，且**不产生任何结论**（绝不默认向内开）
  const bus5 = new CommandBus(bare(), RULES);
  bus5.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
  const d5 = deriveDoorSwing(bus5.getState());
  ok(
    '5. 未指定铰链/方向 → status=unknown、reason=no-swing、没有包络、一条结论都不发（不猜方向）',
    d5.doors.length === 1 &&
      d5.doors[0]!.status === 'unknown' &&
      d5.doors[0]!.unknownReason === 'no-swing' &&
      d5.doors[0]!.envelope === undefined &&
      d5.clearances.length === 0 &&
      !codesOf(bus5.getState()).includes(DOOR_SWING_CODE),
    JSON.stringify(d5.doors)
  );
  // 5b. 只给铰链（用户知道铰链、还没想好往哪开）也是 unknown —— 两个字段各自可缺省
  const bus5b = new CommandBus(bare(), RULES);
  bus5b.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
  bus5b.execute(doorCmd({ hinge: 'end' }));
  ok(
    '5b. 只设铰链不设方向 → 仍是 unknown（"没说"≠"默认向内开"）',
    deriveDoorSwing(bus5b.getState()).doors[0]!.unknownReason === 'no-swing' &&
      deriveDoorSwing(bus5b.getState()).doors[0]!.hinge === 'end',
    JSON.stringify(deriveDoorSwing(bus5b.getState()).doors)
  );

  // 6. 非法值：解析时抹掉当"未指定"并给警告（不阻断打开项目）
  {
    const env = JSON.parse(serializeProjectFile(bus.toFileSnapshot(), SAVED_AT)) as Record<string, unknown>;
    const raw = env as unknown as { project: { rooms: Array<{ walls: Array<Record<string, unknown>> }> } };
    const opRaw = (raw.project.rooms[0]!.walls[2]!.openings as Array<Record<string, unknown>>)[0]!;
    opRaw.hinge = 'middle';
    opRaw.swingDirection = 'sideways';
    const parsed = parseProjectFile(JSON.stringify(env));
    const opAfter = parsed.ok ? (parsed.project.rooms[0]!.walls[2]!.openings![0] as Record<string, unknown>) : null;
    ok(
      '6. hinge/swingDirection 非法值 → 抹成"未指定" + 两条各说各的警告（不因为一个注解打不开项目）',
      parsed.ok &&
        opAfter!.hinge === undefined &&
        opAfter!.swingDirection === undefined &&
        parsed.warnings.length === 2 &&
        parsed.warnings[0]!.includes('hinge') &&
        parsed.warnings[1]!.includes('swingDirection'),
      parsed.ok ? JSON.stringify({ op: opAfter, warnings: parsed.warnings }) : parsed.error
    );
  }

  // 7. 序列化：键序固定（先设方向/先设铰链得到同一份字节）+ round-trip 逐值保留
  {
    const a = new CommandBus(bare(), RULES);
    a.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
    a.execute(doorCmd({ swingDirection: 'into-room' }));
    a.execute(doorCmd({ hinge: 'start' }));
    const b = new CommandBus(bare(), RULES);
    b.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
    b.execute(doorCmd({ hinge: 'start' }));
    b.execute(doorCmd({ swingDirection: 'into-room' }));
    const ja = serializeProjectFile(a.toFileSnapshot(), SAVED_AT);
    const jb = serializeProjectFile(b.toFileSnapshot(), SAVED_AT);
    const back = parseProjectFile(ja);
    ok(
      '7. 先设方向再设铰链 与 反过来 → 存盘逐字节相同（键序规范化），round-trip 逐值保留',
      ja === jb &&
        back.ok &&
        back.project.rooms[0]!.walls[2]!.openings![0]!.hinge === 'start' &&
        back.project.rooms[0]!.walls[2]!.openings![0]!.swingDirection === 'into-room',
      JSON.stringify({ same: ja === jb, op: back.ok ? back.project.rooms[0]!.walls[2]!.openings : back.error })
    );
  }

  // 8 / 8b / 9：undo·redo 走**两条独立命令**，才看得见"字段真的消失"
  {
    const bus8 = new CommandBus(bare(), RULES);
    bus8.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
    bus8.execute(doorCmd({ swingDirection: 'into-room' }));
    bus8.execute(doorCmd({ hinge: 'start' }));

    bus8.undo(); // → 只剩方向、没有铰链
    const afterUndo = bus8.getState().rooms[0]!.walls[2]!.openings![0]!;
    const f8 = deriveDoorSwing(bus8.getState()).doors[0]!;
    ok(
      '8. undo 一步回到"只设了方向"那一态：hinge 字段真的不存在（不是被改成别的值），判定同时退回 unknown',
      afterUndo.hinge === undefined &&
        afterUndo.swingDirection === 'into-room' &&
        f8.status === 'unknown' &&
        f8.unknownReason === 'no-swing' &&
        f8.envelope === undefined,
      JSON.stringify({ op: afterUndo, fact: f8 })
    );

    bus8.undo(); // → 两侧都没指定
    const f8b = deriveDoorSwing(bus8.getState()).doors[0]!;
    ok(
      '8b. 再 undo 一步 → 回到"未指定"，包络随之消失（派生跟着 authored 走，没有缓存残留）',
      bus8.getState().rooms[0]!.walls[2]!.openings![0]!.swingDirection === undefined &&
        f8b.status === 'unknown' &&
        f8b.envelope === undefined,
      JSON.stringify(f8b)
    );

    bus8.redo();
    bus8.redo();
    const afterRedo = bus8.getState().rooms[0]!.walls[2]!.openings![0]!;
    const envRedo = envOf(bus8.getState());
    ok(
      '9. redo 两步 → 回到 hinge=start + into-room，包络与第一次判定逐值相同',
      afterRedo.hinge === 'start' && afterRedo.swingDirection === 'into-room' && JSON.stringify(envRedo) === JSON.stringify(env1),
      JSON.stringify({ op: afterRedo, same: JSON.stringify(envRedo) === JSON.stringify(env1) })
    );
  }
}

/** 房间回路内的点判定（贴边也算在里面）—— 只用于本验收，不进产品代码 */
function pointInPolySafe(p: Vec2, poly: Vec2[]): boolean {
  const inside = (() => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!;
      const b = poly[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
    }
    return hit;
  })();
  if (inside) return true;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    if (Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) < 1e-9) {
      if (p.x >= Math.min(a.x, b.x) - 1e-9 && p.x <= Math.max(a.x, b.x) + 1e-9 && p.y >= Math.min(a.y, b.y) - 1e-9 && p.y <= Math.max(a.y, b.y) + 1e-9) return true;
    }
  }
  return false;
}

// ═══════════════ §2 几何（10~18） ═══════════════
section('§2 几何：0/90/180/270° 墙、房间平移、洞口宽·位、非正方柜、旋转柜');

{
  const room = mkRoom('r1');
  const sideOf = (i: number) => wallInteriorSide(roomLoop(room.walls).poly, room.walls[i]!);
  const envOn = (i: number, patch: Parameters<typeof door>[0] = {}) => {
    const r = doorEnvelopeOf(room.walls[i]!, door(patch), sideOf(i));
    if (r.status !== 'ok') throw new Error(`夹具错了：${JSON.stringify(r)}`);
    return r.envelope;
  };

  // 10. 0° 墙（南墙 (0,0)→(4000,0)）：铰链在内表面 y=60，门扇往房间内（+y）扫
  const e10 = envOn(0);
  ok(
    '10. 0° 墙（南墙 (0,0)→(4000,0)）：铰链 (1000,60)、开启端 y=960（+y 朝屋内）',
    e10.hinge.x === 1000 && e10.hinge.y === 60 && e10.openTip.y === 960,
    JSON.stringify({ hinge: e10.hinge, openTip: e10.openTip })
  );

  // 11. 90° 墙（东墙 (4000,0)→(4000,3000)）：铰链 x=3940、开启端 x=3040（-x 朝屋内）
  const e11 = envOn(1);
  ok(
    '11. 90° 墙（东墙）：铰链 (3940,1000)（内表面）、开启端 x=3040（往 -x 扫进房间）',
    e11.hinge.x === 3940 && e11.hinge.y === 1000 && e11.openTip.x === 3040,
    JSON.stringify({ hinge: e11.hinge, openTip: e11.openTip })
  );

  // 12. 180° 墙（北墙 (4000,3000)→(0,3000)）：铰链 y=2940、开启端 y=2040，铰链在起点侧
  const e12 = envOn(2);
  ok(
    '12. 180° 墙（北墙）：铰链 (3000,2940)、开启端 y=2040；铰链在**起点侧**（起点在 x=4000）',
    e12.hinge.x === 3000 && e12.hinge.y === 2940 && e12.openTip.y === 2040,
    JSON.stringify({ hinge: e12.hinge, openTip: e12.openTip })
  );

  // 13. 270° 墙（西墙 (0,3000)→(0,0)）：铰链 x=60、开启端 x=960
  const e13 = envOn(3);
  ok(
    '13. 270° 墙（西墙）：铰链 (60,2000)、开启端 x=960；起点侧 = y 从 3000 往 0 数',
    e13.hinge.x === 60 && e13.hinge.y === 2000 && e13.openTip.x === 960,
    JSON.stringify({ hinge: e13.hinge, openTip: e13.openTip })
  );

  // 14. 不同房间位置：平移不变（结论跟着平移，方向不翻）
  {
    const room2 = mkRoom('r2', 10000, 8000);
    const r = doorEnvelopeOf(room2.walls[2]!, door(), wallInteriorSide(roomLoop(room2.walls).poly, room2.walls[2]!));
    ok(
      '14. 房间整体平移到 (10000,8000) → 包络逐点平移同样位移（方向由墙自身定义，不依赖世界原点）',
      r.status === 'ok' && r.envelope.hinge.x === 13000 && r.envelope.hinge.y === 10940,
      JSON.stringify(r)
    );
  }

  // 15. 洞口宽度 → 半径跟着变（宽度是 authored，半径是派生）
  {
    const w600 = envOn(2, { width: 600 });
    const w1200 = envOn(2, { width: 1200 });
    ok(
      '15. 净宽 600 / 1200 → 半径 600 / 1200（半径是派生的，模型里没有它）；1200 时开启端 y=1740',
      w600.radius === 600 && w1200.radius === 1200 && w1200.openTip.y === 1740,
      JSON.stringify({ w600: w600.radius, w1200: w1200.radius, tip: w1200.openTip })
    );
  }

  // 16. offset → 铰链沿墙移动
  {
    const o100 = envOn(2, { offset: 100 });
    const o2500 = envOn(2, { offset: 2500 });
    ok(
      '16. offset 100/2500 → 铰链 x = 3900/1500（沿墙量，世界坐标是派生的）',
      o100.hinge.x === 3900 && o2500.hinge.x === 1500,
      JSON.stringify({ o100: o100.hinge, o2500: o2500.hinge })
    );
  }

  // 17. 非正方柜（宽≠深）照样按 footprint 判：窄深柜与宽浅柜结论各自成立
  {
    const narrowRoom = mkRoom('r1');
    const shallowRoom = mkRoom('r1');
    const pn = withNorthDoor(narrowRoom, [mkCab(narrowRoom, 'c_narrow', 3000, 2940, 300, 900, 180)]); // 300 宽 × 900 深
    const ps = withNorthDoor(shallowRoom, [mkCab(shallowRoom, 'c_shallow', 3000, 2940, 900, 200, 180)]); // 900 宽 × 200 深
    ok(
      '17. 非正方柜：300×900 与 900×200 都判出 overlap，但报出的「探出墙面」不同（900 vs 200）',
      clearanceOf(pn, 'c_narrow').status === 'overlap' &&
        clearanceOf(pn, 'c_narrow').intrusion === 900 &&
        clearanceOf(ps, 'c_shallow').status === 'overlap' &&
        clearanceOf(ps, 'c_shallow').intrusion === 200,
      JSON.stringify({ narrow: clearanceOf(pn, 'c_narrow'), shallow: clearanceOf(ps, 'c_shallow') })
    );
  }

  // 18. 旋转柜：同一落点换 rotation，判定跟着 footprint 走（不是拿 bbox / 点拍脑袋）
  {
    const mk = (id: string, rot: number) => {
      const r = mkRoom('r1');
      return withNorthDoor(r, [mkCab(r, id, 2000, 2540, 900, 600, rot)]);
    };
    const r0 = mk('c0', 0);
    const r90 = mk('c90', 90);
    const r180 = mk('c180', 180);
    const r270 = mk('c270', 270);
    const c0 = clearanceOf(r0, 'c0');
    const c90 = clearanceOf(r90, 'c90');
    const c180 = clearanceOf(r180, 'c180');
    const c270 = clearanceOf(r270, 'c270');
    ok(
      '18. 同一落点 (2000,2540) 四个旋转角 → 0°/270° 入扇区（overlap），90°/180° 在外面且实测距离不同（100 / 177）',
      c0.status === 'overlap' &&
        c270.status === 'overlap' &&
        c90.status === 'clear' &&
        c90.distance === 100 &&
        c180.status === 'clear' &&
        c180.distance === 177,
      JSON.stringify({ c0, c90, c180, c270 })
    );
  }
}

// ═══════════════ §3 扇区判定（19~24） ═══════════════
section('§3 扇区：clear / 贴边 / 部分重叠 / 完全重叠 / 向内开 vs 向外开');

{
  const farRoom = mkRoom('r1');
  const touchRoom = mkRoom('r1');
  const partialRoom = mkRoom('r1');
  const fullRoom = mkRoom('r1');
  const outRoom = mkRoom('r1');
  const inRoomP = mkRoom('r1');

  // 远离门（房间另一头）
  const far = withNorthDoor(farRoom, [mkCab(farRoom, 'c_far', 1000, 500, 900, 600, 0)]);
  // 扇区西侧、只贴到弧线端点（角点 (2100,2940) 正是扇区的一个端点）
  const touch = withNorthDoor(touchRoom, [mkCab(touchRoom, 'c_touch', 2100, 2940, 900, 600, 180)]);
  // 部分重叠：跨在墙上、半只在扇区内
  const partial = withNorthDoor(partialRoom, [mkCab(partialRoom, 'c_partial', 2600, 2540, 600, 400, 180)]);
  // 完全落在扇区内：400×400 且贴着铰链
  const full = withNorthDoor(fullRoom, [mkCab(fullRoom, 'c_full', 3000, 2940, 400, 400, 180)]);
  // 同一只柜，换个开启方向
  const into = withNorthDoor(inRoomP, [mkCab(inRoomP, 'c_x', 3000, 2940, 900, 600, 180)]);
  const out = withNorthDoor(outRoom, [mkCab(outRoom, 'c_out', 3000, 2940, 900, 600, 180)], door({ swingDirection: 'out-of-room' }));

  ok(
    '19. 远处柜体 → clear，并给出实测最近距离 1246mm',
    clearanceOf(far, 'c_far').status === 'clear' && clearanceOf(far, 'c_far').distance === 1246,
    JSON.stringify(clearanceOf(far, 'c_far'))
  );
  ok(
    '20. 只贴到扇区边界（距离 0 ≤ TOUCH 1mm）→ touch，且**不报** DESIGN-CABINET-DOOR-SWING（贴边不算撞）',
    clearanceOf(touch, 'c_touch').status === 'touch' &&
      clearanceOf(touch, 'c_touch').distance === 0 &&
      !codesOf(touch).includes(DOOR_SWING_CODE),
    JSON.stringify({ c: clearanceOf(touch, 'c_touch'), codes: codesOf(touch) })
  );
  ok(
    '21. 部分重叠 → overlap + DESIGN-CABINET-DOOR-SWING（ERROR），文案里带实测「探出墙面 800mm」与净宽',
    clearanceOf(partial, 'c_partial').status === 'overlap' &&
      clearanceOf(partial, 'c_partial').intrusion === 800 &&
      deriveSpatial(partial).issues.some(
        (i) => i.code === DOOR_SWING_CODE && i.severity === 'ERROR' && i.message.includes('800') && i.message.includes('900')
      ),
    JSON.stringify(deriveSpatial(partial).issues.map((i) => i.message))
  );
  ok(
    '22/23. 整只柜完全落在扇区内 → overlap，且 footprint 四个角点都在包络里；只报一条门扇结论',
    clearanceOf(full, 'c_full').status === 'overlap' &&
      getCabinetFootprint(full.cabinets[0]!).every((v) => pointInPolySafe(v, envOf(full).poly)) &&
      deriveSpatial(full).issues.filter((i) => i.code === DOOR_SWING_CODE).length === 1,
    JSON.stringify({ c: clearanceOf(full, 'c_full'), fp: getCabinetFootprint(full.cabinets[0]!) })
  );
  ok(
    '24. 同一只柜：往室内开 → overlap；改成往室外开 → clear（实测距离 120mm，扇区换了一侧，判定跟着换）',
    clearanceOf(into, 'c_x').status === 'overlap' &&
      clearanceOf(out, 'c_out').status === 'clear' &&
      clearanceOf(out, 'c_out').distance === 120,
    JSON.stringify({ into: clearanceOf(into, 'c_x'), out: clearanceOf(out, 'c_out') })
  );
}

// ═══════════════ §4 unknown（25~29） ═══════════════
section('§4 unknown：房间不闭合 / 墙退化 / 洞口越界 / 缺开启信息 / 洞口非法');

{
  // 25. 房间不闭合（拆掉北墙）→ 判不出室内侧 → unknown
  {
    const room = mkRoom('r1');
    const openRoom: Room = { ...room, walls: room.walls.slice(0, 3) };
    const p = withNorthDoor(openRoom, []);
    const f = deriveDoorSwing(p).doors[0]!;
    ok(
      '25. 房间墙不成回路 → unknown / open-room，**不报**门扇 issue（判不出来就不说话）',
      f.status === 'unknown' && f.unknownReason === 'open-room' && !codesOf(p).includes(DOOR_SWING_CODE),
      JSON.stringify(f)
    );
  }

  // 26. 墙退化（零长墙）：洞口挂在零长墙上 → bad-wall
  {
    const room = mkRoom('r1');
    const degenerate: Room = {
      ...room,
      walls: [
        ...room.walls,
        { id: 'r1_w5', name: '零长墙', start: { x: 2000, y: 1500 }, end: { x: 2000, y: 1500 }, thickness: 120, height: 2700, openings: [door()] },
      ],
    };
    const p = mkProject([degenerate], []);
    const f = deriveDoorSwing(p).doors[0]!;
    ok(
      '26. 墙退化（零长）→ unknown / bad-wall，不报门扇 issue',
      f.status === 'unknown' && f.unknownReason === 'bad-wall' && !codesOf(p).includes(DOOR_SWING_CODE),
      JSON.stringify(f)
    );
  }

  // 27. 洞口越界：offset+width 超过墙长 → bad-span（且 P8.7 的 SPATIAL-OPENING-SPAN 照旧报）
  {
    const room = mkRoom('r1');
    const p = withNorthDoor(room, [], door({ offset: 3500, width: 900 })); // 3500+900 > 4000
    const f = deriveDoorSwing(p).doors[0]!;
    ok(
      '27. 洞口 span 越界 → unknown / bad-span；空间层仍报 SPATIAL-OPENING-SPAN（两条各说各的）',
      f.status === 'unknown' &&
        f.unknownReason === 'bad-span' &&
        codesOf(p).includes('SPATIAL-OPENING-SPAN') &&
        !codesOf(p).includes(DOOR_SWING_CODE),
      JSON.stringify({ f, codes: codesOf(p) })
    );
  }

  // 28. 缺开启信息（两个字段都缺）→ no-swing
  {
    const room = mkRoom('r1');
    const p = withNorthDoor(room, [], door({ hinge: undefined, swingDirection: undefined }));
    const f = deriveDoorSwing(p).doors[0]!;
    ok(
      '28. 两个字段都缺 → unknown / no-swing（缺一个也一样，见 5b）',
      f.status === 'unknown' && f.unknownReason === 'no-swing',
      JSON.stringify(f)
    );
  }

  // 29. 洞口非法（width ≤ 0）+ 窗洞不参与门扇判定
  {
    const badRoom = mkRoom('r1');
    const winRoom = mkRoom('r1');
    const pBad = withNorthDoor(badRoom, [], door({ width: 0 }));
    const fBad = deriveDoorSwing(pBad).doors[0]!;
    const pWindow = withNorthDoor(winRoom, [], { ...door(), kind: 'window' } as DoorSpec);
    ok(
      '29. width=0 → bad-span；kind=window → 根本不产生门扇事实（窗没有门扇）',
      fBad.status === 'unknown' &&
        fBad.unknownReason === 'bad-span' &&
        deriveDoorSwing(pWindow).doors.length === 0 &&
        deriveDoorSwing(pWindow).clearances.length === 0,
      JSON.stringify({ fBad, windowDoors: deriveDoorSwing(pWindow).doors.length })
    );
  }

  // 29b. unknown 的人话出口唯一（界面不许自己翻译）
  ok(
    '29b. 四种 unknown 原因都有人话文案（DOOR_UNKNOWN_ZH），且每条都说得清"为什么判不出"',
    Object.values(DOOR_UNKNOWN_ZH).length === 4 && Object.values(DOOR_UNKNOWN_ZH).every((s) => s.length > 8),
    JSON.stringify(DOOR_UNKNOWN_ZH)
  );
}

// ═══════════════ §5 架构红线（30~38） ═══════════════
section('§5 架构红线：无三角函数 / 复用几何原语 / 不改模型 / 不调 AI / 不出 BOM·DXF');

{
  const doorCode = strip(src('src/core/spatial/door.ts'));
  ok('30. 门扇几何里没有 Math.sin（角平分线用向量加法二分，全程无三角函数）', !/Math\.sin/.test(doorCode), doorCode.match(/Math\.sin[^\n]*/)?.[0] ?? '');
  ok('31. 门扇几何里没有 Math.cos', !/Math\.cos/.test(doorCode), doorCode.match(/Math\.cos[^\n]*/)?.[0] ?? '');
  ok(
    '32. 复用既有几何原语：footprint 走 getCabinetFootprint、墙几何走 wallNormalUnit/openingRect，重叠/距离走 polysOverlapInterior/polyDistance',
    /getCabinetFootprint/.test(doorCode) &&
      /wallNormalUnit/.test(doorCode) &&
      /openingRect/.test(doorCode) &&
      /polysOverlapInterior/.test(doorCode) &&
      /polyDistance/.test(doorCode),
    '缺少复用的原语'
  );
  ok(
    '32b. 室内侧判定复用 P8.7 的 wallInteriorSide（不重算一套"哪边是屋里"）',
    /import \{ wallInteriorSide \} from '\.\/derive\.ts'/.test(doorCode),
    ''
  );

  // 33. 派生不改模型 + 不改总线版本
  {
    const room = mkRoom('r1');
    const bus = new CommandBus(withNorthDoor(room, [mkCab(room, 'c_b', 3000, 2940, 900, 600, 180)]), RULES);
    const v0 = bus.getVersion();
    const before = serializeProjectFile(bus.toFileSnapshot(), SAVED_AT);
    const d1 = deriveDoorSwing(bus.getState());
    const d2 = deriveDoorSwing(bus.getState());
    const after = serializeProjectFile(bus.toFileSnapshot(), SAVED_AT);
    ok(
      '33. deriveDoorSwing 前后模型逐字节不变、两次结果逐值相同（纯函数）',
      before === after && JSON.stringify(d1) === JSON.stringify(d2),
      JSON.stringify({ same: before === after, det: JSON.stringify(d1) === JSON.stringify(d2) })
    );
    ok(
      '33b. derive 期间总线版本号不变（派生结果没有被写回模型）',
      bus.getVersion() === v0,
      JSON.stringify({ v0, v1: bus.getVersion() })
    );
  }

  // 34. 不调 AI
  {
    const importLines = ['door.ts', 'validate.ts', 'derive.ts', 'model.ts', 'index.ts']
      .map((f) => src('src/core/spatial', f))
      .join('\n')
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n');
    ok('34. 空间层不 import AI 层（门扇判定是确定性的，不经过任何模型）', !/\/ai\//.test(importLines), importLines);
    const dvImports = ['model.ts', 'validate.ts', 'interpret.ts']
      .map((f) => src('src/core/designValidation', f))
      .join('\n')
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n');
    ok('34b. 统一设计验证层也不 import AI', !/\/ai\//.test(dvImports), dvImports);
  }

  // 35. 画图元只从空间层取（同一次派生），界面不自己算弧
  {
    const primSrc = strip(src('src/viewport/doorSwingPrims.ts'));
    ok(
      '35. 2D 包络图元来自 deriveDoorSwing 的同一份结果（界面不许自己画弧）',
      /deriveDoorSwing\(project\)/.test(primSrc) && /env\.poly/.test(primSrc) && !/Math\.(sin|cos)/.test(primSrc),
      primSrc.slice(0, 200)
    );
    const vpSrc = src('src/ui/Viewport.tsx');
    ok('35b. Viewport 只调用 doorSwingPrimsOf（不自己算包络）', /doorSwingPrimsOf\(scene\.project\)/.test(vpSrc) && !/deriveDoorSwing/.test(vpSrc), '');
    ok('35c. 图层 A-DOOR-SWING 登记在 LAYERS 表里（图元不许用没登记的图层）', LAYERS.some((l) => l.name === 'A-DOOR-SWING'), LAYERS.map((l) => l.name).join(','));
  }

  // 36~38. 不进 BOM / 清单 / 制造 / DXF
  {
    const all = ['door.ts', 'validate.ts']
      .map((f) => src('src/core/spatial', f))
      .join('\n')
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l))
      .join('\n');
    ok('36. 门扇层不 import 清单 / 甲购 / 板件层（不进清单）', !/neutralSheet|roomBook|sheet|bom|purchased/i.test(all), all);
    ok('37. 门扇层不 import 制造层（不进 ManufacturingPart / CNC）', !/manufacturing/i.test(all), all);
    ok('38. 门扇层不 import 导出 / DXF 层', !/\/export\//.test(all) && !/dxf/i.test(all), all);
  }

  // 38b. 禁止项源码级确认：门扇层没有自动移柜 / 改方向的写路径
  ok(
    '38b. 门扇层没有任何"自动移柜 / 自动改方向"的写路径（源码扫描：不出现 moveCabinet / placeCabinet / updateOpening / bus.execute）',
    !/moveCabinet|placeCabinet|updateOpening|bus\.execute/.test(doorCode),
    ''
  );
}

// ═══════════════ §6 与既有验证链的关系（39~44） ═══════════════
section('§6 与 P8.7 / P8.8 的关系：不变 / 进统一报告 / intent 不绕过 / 确定性 / 不重复报');

{
  const blockRoom = mkRoom('r1');
  const blocking = withNorthDoor(blockRoom, [mkCab(blockRoom, 'c_cover', 2900, 2900, 600, 300, 180)]);

  // 39. P8.7 的"柜盖门洞"判定不变（柜体压在洞口影响带里 → 仍然恰好一条）
  ok(
    '39. 柜体站在门洞正前方（压住洞口影响带）→ SPATIAL-CABINET-OPENING 仍然只报一条（P8.7 行为没被改写）',
    codesOf(blocking).filter((c) => c === OPENING_CODE).length === 1,
    JSON.stringify(codesOf(blocking))
  );

  /**
   * 39c. **已知遗留（P8.7 的边角，P8.9 不越界修）**
   *
   * 柜宽恰好 = 洞口净宽、且背面贴着墙内表面齐平时，柜体 footprint 与"洞口影响带"
   * 矩形在 x 方向**逐边重合**、上沿也重合 —— 此时 P8.7 判定用的
   * `polysOverlapInterior`（"任一顶点严格落入对方内部，或任一对边正交穿过"）
   * 两边都不成立，于是**检不出**"柜子挡住门口"。
   *
   * 为什么不在 P8.9 改它：这个判定是 P8.7 的地基（`verify:spatial` 钉着它的行为），
   * 改它会同时改写 P8.7 的结论，属于越过本阶段边界。
   * 这里把**现状**钉住并记录为遗留，等专门一阶段处理 —— 谁将来修好它，这条断言会变红，
   * 就会被迫回来看这段注释（而不是悄悄改掉一个"看起来没人管"的行为）。
   *
   * 附带事实：同一只柜在 P8.9 的门扇判定里**仍会被报**（扇形是圆弧包出来的多边形，
   * 不可能与柜体逐边重合）—— 两条判定在这个边角上恰好互补。
   */
  {
    const edgeRoom = mkRoom('r1');
    const edge = withNorthDoor(edgeRoom, [mkCab(edgeRoom, 'c_edge', 3000, 2940, 900, 200, 180)]);
    ok(
      '39c.（遗留·P8.7 边角）柜宽恰 = 洞宽且贴墙齐平时洞口影响带检不出（逐边重合），此时由 P8.9 门扇判定兜住 —— 现状已钉住，未在 P8.9 修改',
      !codesOf(edge).includes(OPENING_CODE) && codesOf(edge).includes(DOOR_SWING_CODE),
      JSON.stringify({ codes: codesOf(edge), c: clearanceOf(edge, 'c_edge') })
    );
  }

  // 39b. P8.8 的同源不变：report.placement / report.spatial 仍与单独调用逐字节相同
  {
    const rep = validateDesign(blocking);
    ok(
      '39b. 统一报告里 placement / spatial 两段仍与单独调用逐字节相同（P8.8 的同源不变量没被破坏）',
      JSON.stringify(rep.placement) === JSON.stringify(validatePlacementDesign(blocking)) &&
        JSON.stringify(rep.spatial) === JSON.stringify(deriveSpatial(blocking)),
      ''
    );
  }

  // 40. 无门项目：统一报告里没有任何门扇结论（P8.8 的既有用例不受影响）
  {
    const plainRoom = mkRoom('r1');
    const plain = mkProject([plainRoom], [mkCab(plainRoom, 'c_plain', 500, 60, 900, 600, 0)]);
    const rep = validateDesign(plain);
    ok(
      '40. 无门项目：doors / clearances 为空、findings 里没有门扇码、layer 仍只有三层（P8.8 用例零影响）',
      rep.doorSwing.doors.length === 0 &&
        rep.doorSwing.clearances.length === 0 &&
        !rep.findings.some((f) => f.code === DOOR_SWING_CODE) &&
        rep.findings.every((f) => f.layer === 'placement' || f.layer === 'spatial' || f.layer === 'semantic'),
      JSON.stringify({ counts: rep.counts, doors: rep.doorSwing.doors.length })
    );
  }

  // 41. 门扇结论进统一报告：状态被顶成 error、cabId 挂对
  {
    const rep = validateDesign(blocking);
    const f = rep.findings.find((x) => x.code === DOOR_SWING_CODE);
    ok(
      '41. 门扇冲突进入统一报告：status=error、cabId 挂到那只柜、报告总状态被顶成 error',
      f?.status === 'error' && f?.cabId === 'c_cover' && rep.status === 'error' && rep.counts.error >= 1,
      JSON.stringify({ f, status: rep.status })
    );
  }

  // 42. intent 不绕过：柜体是"用户明确要求贴合落位"的，落进扇区照样报
  {
    const intention: PlacementIntent = {
      targetId: 'c_intent',
      relation: 'attach',
      referenceId: 'c_ref',
      targetFace: 'right',
      referenceFace: 'left',
    };
    const r = mkRoom('r1');
    const base = withNorthDoor(r, [mkCab(r, 'c_ref', 2000, 2400, 400, 400, 180), mkCab(r, 'c_intent', 9000, 9000, 400, 400, 180)]);
    const resolved = resolvePlacement(intention, sceneFromProject(base));
    const placed = resolved.ok ? withResolvedPlacements(base, [{ intent: intention, placement: resolved.placement }]) : null;
    const refClear = placed ? clearanceOf(placed, 'c_ref').status === 'clear' : false;
    const hits = placed ? deriveSpatial(placed).issues.filter((i) => i.code === DOOR_SWING_CODE) : [];
    ok(
      '42. 用户"语义贴合"把柜子落到门扇范围内 → 照样报 DESIGN-CABINET-DOOR-SWING（intent 不豁免 validation），且只有被贴进去的那只被点名',
      Boolean(placed) &&
        refClear &&
        clearanceOf(placed!, 'c_intent').status === 'overlap' &&
        hits.length === 1 &&
        hits[0]!.target === 'c_intent',
      JSON.stringify({ ok: resolved.ok, refClear, c: placed ? clearanceOf(placed, 'c_intent') : null, hits: hits.map((i) => i.target) })
    );
  }

  // 43. 报告确定性
  {
    const a = validateDesign(blocking);
    const b = validateDesign(blocking);
    ok('43. 同一输入两次统一验证逐值相同（确定性，无时钟无随机）', JSON.stringify(a) === JSON.stringify(b), '');
  }

  // 44. 不重复报：两条判定各说各的事
  {
    // a) 柜在扇区里但**没**压洞口影响带（贴着门垛、离墙 700mm 外）
    const aRoom = mkRoom('r1');
    const inSwing = withNorthDoor(aRoom, [mkCab(aRoom, 'c_swingOnly', 2900, 2300, 300, 200, 180)]);
    const codesSwing = codesOf(inSwing);
    // b) 柜压洞口影响带但**不在**扇区里（在洞口远端角落、扇区半径够不到）
    const bRoom = mkRoom('r1');
    const coverOnly = withNorthDoor(bRoom, [mkCab(bRoom, 'c_doorOnly', 2200, 2440, 200, 200, 180)]);
    const codesDoor = codesOf(coverOnly);
    ok(
      '44. 两条判定互不替代且不互相制造：柜只在扇区里 → 只有 DOOR-SWING；柜只挡洞口通道 → 只有 CABINET-OPENING',
      codesSwing.includes(DOOR_SWING_CODE) &&
        !codesSwing.includes(OPENING_CODE) &&
        codesDoor.includes(OPENING_CODE) &&
        !codesDoor.includes(DOOR_SWING_CODE),
      JSON.stringify({ inSwing: codesSwing, coverOnly: codesDoor })
    );
  }

  // 44b. 规则码目录：登记齐全、等级/文案/manual 齐备（新码不许走"未登记"的暗路）
  {
    const card = ruleCard(DOOR_SWING_CODE);
    ok(
      '44b. DESIGN-CABINET-DOOR-SWING 已登记在 issueCatalog：ERROR + hint 带实测数字 + manual 且不给一键修复按钮',
      RULE_CODES.includes(DOOR_SWING_CODE) &&
        card !== undefined &&
        card.severity === 'ERROR' &&
        card.fix === undefined &&
        Boolean(card.manual) &&
        card.hint({ width: 903 }).includes('903'),
      JSON.stringify({ severity: card?.severity, manual: card?.manual, hasFix: card?.fix !== undefined })
    );
  }
}

// ═══════════════ §7 UI 与持久化（45~50） ═══════════════
section('§7 UI 与持久化：能设 / 能清 / 重开保留 / 旧项目能开 / schema 策略不变');

{
  const WALL = 'r1_w3';
  const WALL_NAME = '房间r1墙3';
  const panel = src('src/ui/panels/PropertiesPanel.tsx');
  const blockStart = panel.indexOf('function DoorSwingBlock');
  const block = panel.slice(blockStart, panel.indexOf('\nfunction ', blockStart + 10));

  // 45. 界面能设铰链：行为层 + 源码层（两个方向 + 未指定三段按钮，且**没有**数字输入 / 自动按钮）
  {
    const bus = new CommandBus(bare(), RULES);
    bus.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
    const r = CMD.updateOpening(WALL, WALL_NAME, 'open_001', 'door', 900, { hinge: 'end' });
    bus.execute(r);
    ok(
      '45. 界面能设铰链侧：命令把 hinge 写进模型；面板上有「起点侧/终点侧/未指定」三段按钮、无任何数字输入、无自动按钮',
      bus.getState().rooms[0]!.walls[2]!.openings![0]!.hinge === 'end' &&
        blockStart > 0 &&
        /起点侧/.test(block) &&
        /终点侧/.test(block) &&
        /向室内/.test(block) &&
        /向室外/.test(block) &&
        /未指定/.test(block) &&
        (block.match(/<button/g) ?? []).length === 6 &&
        !/<NumField/.test(block) &&
        !/moveCabinet|placeCabinet/.test(block) &&
        /CMD\.updateOpening/.test(block) &&
        /o\.kind === 'door' \? <DoorSwingBlock/.test(panel),
      JSON.stringify({ op: bus.getState().rooms[0]!.walls[2]!.openings, blockStart, buttons: (block.match(/<button/g) ?? []).length })
    );
  }

  // 46 / 47. 能设开启方向 + 能清回"未指定"
  {
    const bus = new CommandBus(bare(), RULES);
    bus.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
    bus.execute(CMD.updateOpening(WALL, WALL_NAME, 'open_001', 'door', 900, { hinge: 'start', swingDirection: 'out-of-room' }));
    const setDir = bus.getState().rooms[0]!.walls[2]!.openings![0]!;
    bus.execute(CMD.updateOpening(WALL, WALL_NAME, 'open_001', 'door', 900, { swingDirection: null }));
    const cleared = bus.getState().rooms[0]!.walls[2]!.openings![0]!;
    ok(
      '46. 界面能设开启方向（向室内 / 向室外）：方向进模型、铰链不受影响',
      setDir.swingDirection === 'out-of-room' && setDir.hinge === 'start',
      JSON.stringify(setDir)
    );
    ok(
      '47. 界面能把方向清回"未指定"（null ≠ undefined：清空后字段真的不存在，且判定随即变 unknown）',
      cleared.swingDirection === undefined &&
        cleared.hinge === 'start' &&
        deriveDoorSwing(bus.getState()).doors[0]!.status === 'unknown' &&
        deriveDoorSwing(bus.getState()).doors[0]!.unknownReason === 'no-swing',
      JSON.stringify({ op: cleared, fact: deriveDoorSwing(bus.getState()).doors[0] })
    );
  }

  // 48. reload 保留
  {
    const bus = new CommandBus(bare(), RULES);
    bus.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
    bus.execute(CMD.updateOpening(WALL, WALL_NAME, 'open_001', 'door', 900, { hinge: 'end', swingDirection: 'into-room' }));
    const json = serializeProjectFile(bus.toFileSnapshot(), SAVED_AT);
    const parsed = parseProjectFile(json);
    const envBefore = envOf(bus.getState());
    const envAfter = parsed.ok ? envOf(parsed.project) : null;
    ok(
      '48. 重开项目：authored 的两字段逐值保留，派生包络也逐值回到同一份（存的是意图，不是几何）',
      parsed.ok &&
        parsed.project.rooms[0]!.walls[2]!.openings![0]!.hinge === 'end' &&
        JSON.stringify(envAfter) === JSON.stringify(envBefore),
      parsed.ok ? JSON.stringify(parsed.project.rooms[0]!.walls[2]!.openings) : parsed.error
    );
  }

  // 49. 旧项目（没有 openings 字段）正常打开
  {
    const bus = new CommandBus(bare(), RULES);
    bus.execute(CMD.createOpening(WALL, WALL_NAME, 'door', 1000, 900));
    const env = JSON.parse(serializeProjectFile(bus.toFileSnapshot(), SAVED_AT)) as {
      project: { rooms: Array<{ walls: Array<Record<string, unknown>> }> };
    };
    for (const w of env.project.rooms[0]!.walls) delete w.openings;
    const parsed = parseProjectFile(JSON.stringify(env));
    ok(
      '49. 旧项目（连 openings 都没有）正常打开且零警告，门扇事实为空（不伪造）',
      parsed.ok &&
        parsed.warnings.length === 0 &&
        parsed.project.rooms[0]!.walls.every((w) => (w as { openings?: unknown }).openings === undefined) &&
        deriveDoorSwing(parsed.project).doors.length === 0,
      parsed.ok ? JSON.stringify(parsed.warnings) : parsed.error
    );
  }

  // 50. schema 策略：门扇开启不改变 schemaVersion 的判定口径（只由 rows / assemblies 决定）
  {
    const withSwing = withNorthDoor(mkRoom('r1'), []);
    const r = mkRoom('r1');
    const without = mkProject([r], [mkCab(r, 'c_plain', 500, 60, 900, 600, 0)]);
    ok(
      '50. schemaVersion 仍只由 多行柜 / 组合 决定：门扇开启不影响它（不升版本、不加 migration）',
      resolveSchemaVersion(withSwing) === '0.2' && resolveSchemaVersion(without) === '0.2' && withSwing.schemaVersion === '0.3',
      JSON.stringify({ a: resolveSchemaVersion(withSwing), b: resolveSchemaVersion(without) })
    );
  }

  // 50b. 门扇事实里没有任何"写回模型"的字段（派生数据不得混进 authored）
  {
    const room = mkRoom('r1');
    const p = withNorthDoor(room, [mkCab(room, 'c_b', 3000, 2940, 900, 600, 180)]);
    const f = deriveDoorSwing(p).doors[0] as DoorSwingFact;
    const allowed = ['openingId', 'wallId', 'roomId', 'hinge', 'direction', 'status', 'unknownReason', 'envelope'];
    ok(
      '50b. 门扇事实的字段集合固定（没有把 envelope 之类派生数据塞回 Opening）',
      Object.keys(f).every((k) => allowed.includes(k)) &&
        Object.keys(p.rooms[0]!.walls[2]!.openings![0]!).every((k) => ['id', 'kind', 'offset', 'width', 'hinge', 'swingDirection'].includes(k)),
      JSON.stringify({ fact: Object.keys(f), opening: Object.keys(p.rooms[0]!.walls[2]!.openings![0]!) })
    );
  }

  // 50c. 门扇图元：有包络才画、unknown 不画、图上画的包络与判定用的包络是同一条 poly
  {
    const room = mkRoom('r1');
    const p = withNorthDoor(room, [mkCab(room, 'c_b', 3000, 2940, 900, 600, 180)]);
    const drawn = doorSwingPrimsOf(p);
    const notDrawn = doorSwingPrimsOf(withNorthDoor(mkRoom('r1'), [], door({ hinge: undefined, swingDirection: undefined })));
    const fill = drawn.find((x) => x.k === 'fill');
    ok(
      '50c. 2D 图元：有包络的门画 fill + 折线（fill 的 pts 就是判定用的那条 poly），没指定开启语义的门一个图元都不画',
      drawn.length === 2 &&
        drawn.every((x) => x.layer === 'A-DOOR-SWING') &&
        fill !== undefined &&
        JSON.stringify(fill.pts) === JSON.stringify(envOf(p).poly) &&
        notDrawn.length === 0,
      JSON.stringify({ drawn: drawn.length, notDrawn: notDrawn.length })
    );
  }

  // 50d. 界面读数与判定同源：面板的"判定"文案取自空间层的人话表（不自己拼）
  ok(
    '50d. 面板的"未指定"提示取自 DOOR_UNKNOWN_ZH（界面不许自己翻译判定结果）',
    /DOOR_UNKNOWN_ZH/.test(block) && /clearancesOfDoor/.test(block) && /deriveDoorSwing/.test(block),
    block.slice(0, 160)
  );
}

// ═══════════════ 汇总 ═══════════════
console.log(`\n═══ P8.9 门扇开启验收：${passed} 通过 / ${failed} 失败 ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  · ${f}`);
  process.exit(1);
}
