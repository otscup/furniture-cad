/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.1 Spatial Context for AI 验收
 *
 *  ── 要证明的核心命题（四条）──
 *    ① AI 快照里**真的有**可用于设计推理的空间事实（不再是只有房间名）；
 *    ② 这些事实与 `deriveSpatial` / `designValidation` 的结论**完全一致**
 *       （同一份派生，不是第二套判定）；
 *    ③ 它**没有任何坐标写入口**：没坐标、没多边形、没包络，契约也没新增动作；
 *    ④ 判不出来的**保持判不出来**：unknown 不被默认值顶替，
 *       未确认的导入/识别事实进不了"确定事实"。
 *
 *  ── 分组 ──
 *    §1 快照含空间事实 .......... 1~18
 *    §2 与派生/统一验证一致 ...... 19~31
 *    §3 没有坐标写入口 .......... 32~41
 *    §4 AI 契约没新增非法动作 ..... 42~50
 *    §5 unknown 保持 unknown .... 51~59
 *    §6 未确认事实不进确定事实 ..... 60~64
 *    §7 架构与不变量 ........... 65~72
 *
 *  ── 判据纪律（本项目反复钉过的）──
 *    · 断言钉到**具体码与具体数**（"被拒了/没报错"会被别处检查顶替而假绿）；
 *    · 带数字的断言必须是真的那个值（intrusion=600 / length=4000），不是 /\d/；
 *    · 每个夹具**自己 clone 一份房间**（共享 Room 引用会让用例互相污染 → 假绿）；
 *    · 每条失败先打原始值 —— **先假定断言自己写错**。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSnapshot, snapshotBytes, snapshotContext } from '../src/ai/snapshot.ts';
import { buildSpatialContext, type AiSpaceConcern, type AiSpatialContext } from '../src/ai/spatialContext.ts';
import { createCabinet, createWall, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, DoorHinge, DoorSwingDirection, Project, Room } from '../src/core/types.ts';
import { deriveDoorSwing, deriveSpatial } from '../src/core/spatial/index.ts';
import { validateDesign } from '../src/core/designValidation/index.ts';
import { ACTION_NAMES, ACTIONS, proposalShapeError, validateAction } from '../shared/aiContract.mjs';
import { importBlocked, validateNormalized, type NormalizedDesign } from '../src/ai/import/normalized.ts';

const APP = join(import.meta.dirname, '..');
const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset', 'factory-default.json'), 'utf8')) as never;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

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

// ─────────────────────────── fixtures ───────────────────────────

/** 矩形房间 4000×3000；墙 id/名固定：w1 南(0,0)→(4000,0) / w2 东 / w3 北(4000,3000)→(0,3000) / w4 西 */
function mkRoom(id: string, x = 0, y = 0, w = 4000, h = 3000, thickness = 120): Room {
  const room = rectRoom({ id, name: `房间${id}`, x, y, w, h, thickness, height: 2700 });
  room.walls.forEach((wl, i) => {
    wl.id = `${id}_w${i + 1}`;
    wl.name = `${id}墙${i + 1}`;
  });
  return room;
}
function mkCab(room: Room | null, id: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet {
  const units = defaultUnits(w, RULES, d).map((u) => ({ ...u, id: `${id}_${u.id}` }));
  return createCabinet({
    id,
    name: id,
    roomId: room ? room.id : 'r_missing',
    x,
    y,
    rotation,
    rules: RULES,
    params: { ...defaultCabinetParams(RULES), width: w, height: 2200, depth: d },
    units,
  });
}
const mkProject = (rooms: Room[], cabinets: Cabinet[]): Project =>
  ({ schemaVersion: '0.3', id: 'proj', name: 'P91', ruleSetId: (RULES as { id: string }).id, rooms, cabinets }) as Project;

type DoorSpec = {
  id: string;
  kind: 'door';
  offset: number;
  width: number;
  name?: string;
} & Partial<{ hinge: DoorHinge; swingDirection: DoorSwingDirection }>;

/** 丰富夹具：窗(南墙 offset2000/w1200) + 门(北墙 offset1000/w900 hinge=start into-room) + 三只柜 */
function richProject(): Project {
  const room = mkRoom('r1');
  room.walls[0]!.openings = [{ id: 'open_win', kind: 'window', offset: 2000, width: 1200 } as never];
  room.walls[2]!.openings = [
    { id: 'open_001', kind: 'door', offset: 1000, width: 900, name: '入户门', hinge: 'start', swingDirection: 'into-room' } as never,
  ];
  return mkProject(
    [room],
    [
      mkCab(room, 'c_touch', 400, 60, 2400, 600, 0), // 背靠南墙内表面 y=60，同时压住窗洞影响带
      mkCab(room, 'c_float', 1500, 1500, 900, 400, 0), // 房间中间（悬空）
      mkCab(room, 'c_door', 3000, 2940, 900, 600, 180), // 北墙门口，落在门扇扇区里
    ]
  );
}

/** 未指定开启语义的门（hinge/direction 都没有） */
function noSwingProject(): Project {
  const room = mkRoom('r2');
  room.walls[2]!.openings = [{ id: 'open_u', kind: 'door', offset: 1000, width: 900 } as never];
  return mkProject([room], [mkCab(room, 'c2', 3000, 2940, 900, 600, 180)]);
}

const RICH = richProject();
const SC: AiSpatialContext = buildSpatialContext(RICH);
const SNAP = buildSnapshot(RICH, RULES);
const byCab = (sc: AiSpatialContext, id: string) => sc.cabinetFacts.find((c) => c.cabinetId === id)!;
const concernsOf = (sc: AiSpatialContext, id: string): AiSpaceConcern[] => byCab(sc, id).concerns;

// ═══════════════════════════ §1 快照含空间事实 ═══════════════════════════
section('§1 快照里有可用于设计推理的空间事实');

ok(
  '1. AiSnapshot 新增只读空间上下文块：spatialContext.readOnly === true，四个列表都是数组',
  SNAP.spatialContext.readOnly === true &&
    Array.isArray(SNAP.spatialContext.rooms) &&
    Array.isArray(SNAP.spatialContext.walls) &&
    Array.isArray(SNAP.spatialContext.openings) &&
    Array.isArray(SNAP.spatialContext.cabinetFacts),
  JSON.stringify(Object.keys(SNAP.spatialContext))
);
ok(
  '2. rooms 覆盖项目的每个房间，id 与顺序逐条一致',
  JSON.stringify(SC.rooms.map((r) => r.id)) === JSON.stringify(RICH.rooms.map((r) => r.id)),
  JSON.stringify(SC.rooms.map((r) => r.id))
);
ok(
  '3. 矩形房 boundary = {closed:true, status:"ok", wallCount:4, cornerCount:4}（基础语义齐）',
  SC.rooms[0]!.boundary.closed === true &&
    SC.rooms[0]!.boundary.status === 'ok' &&
    SC.rooms[0]!.boundary.wallCount === 4 &&
    SC.rooms[0]!.boundary.cornerCount === 4,
  JSON.stringify(SC.rooms[0]!.boundary)
);
ok(
  '4. 房间尺寸以 extent 给出：{width:4000, depth:3000}（**具名标量**，不是数组/坐标）',
  SC.rooms[0]!.extent?.width === 4000 && SC.rooms[0]!.extent?.depth === 3000 && !Array.isArray(SC.rooms[0]!.extent),
  JSON.stringify(SC.rooms[0]!.extent)
);
ok(
  '5. 墙的 name 是 authored 人话（"r1墙1"）—— 用户给的"北墙/东墙"这类语义由此投影，系统不另造方位推断',
  SC.walls.map((w) => w.name).join('|') === RICH.rooms[0]!.walls.map((w) => w.name).join('|') &&
    SC.walls[0]!.name === 'r1墙1',
  JSON.stringify(SC.walls.map((w) => w.name))
);
ok(
  '6. 每面墙给出 id / 所属 roomId / 长度（4000,3000,4000,3000）',
  String(SC.walls.map((w) => `${w.id}@${w.roomId}:${w.length}`)) ===
    'r1_w1@r1:4000,r1_w2@r1:3000,r1_w3@r1:4000,r1_w4@r1:3000',
  JSON.stringify(SC.walls.map((w) => [w.id, w.roomId, w.length]))
);
ok(
  '7. 每面墙给出走向：horizontal / vertical / horizontal / vertical（由端点差派生，无三角函数）',
  String(SC.walls.map((w) => w.axis)) === 'horizontal,vertical,horizontal,vertical',
  JSON.stringify(SC.walls.map((w) => w.axis))
);
ok(
  '8. 每面墙说明有没有洞口：openingCount = 1 / 0 / 1 / 0',
  String(SC.walls.map((w) => w.openingCount)) === '1,0,1,0',
  JSON.stringify(SC.walls.map((w) => w.openingCount))
);
ok(
  '9. openings 覆盖每个洞口：id/kind/offset/width/wallId/roomId 与模型逐条一致（含门洞名）',
  SC.openings.length === 2 &&
    SC.openings[0]!.id === 'open_win' &&
    SC.openings[0]!.kind === 'window' &&
    SC.openings[0]!.offset === 2000 &&
    SC.openings[0]!.width === 1200 &&
    SC.openings[0]!.wallId === 'r1_w1' &&
    SC.openings[1]!.id === 'open_001' &&
    SC.openings[1]!.kind === 'door' &&
    SC.openings[1]!.offset === 1000 &&
    SC.openings[1]!.width === 900 &&
    SC.openings[1]!.wallId === 'r1_w3' &&
    SC.openings[1]!.name === '入户门' &&
    SC.openings.every((o) => o.roomId === 'r1'),
  JSON.stringify(SC.openings)
);
ok(
  '10. 门洞带开启语义（已确认）：status ok + hinge start + direction into-room',
  SC.openings[1]!.swing?.status === 'ok' &&
    SC.openings[1]!.swing?.hinge === 'start' &&
    SC.openings[1]!.swing?.direction === 'into-room',
  JSON.stringify(SC.openings[1]!.swing)
);
ok(
  '11. 窗洞**没有** swing 键（"开启"只对门有意义，不给窗编一个）',
  !('swing' in SC.openings[0]!) && SC.openings[0]!.swing === undefined,
  JSON.stringify(SC.openings[0])
);
ok(
  '12. cabinetFacts 覆盖每只柜体，id 与顺序逐条一致',
  JSON.stringify(SC.cabinetFacts.map((c) => c.cabinetId)) === JSON.stringify(RICH.cabinets.map((c) => c.id)),
  JSON.stringify(SC.cabinetFacts.map((c) => c.cabinetId))
);
ok(
  '13. 贴墙柜给出 touching wall：{wallId:"r1_w1", relation:"touching", gap:0}',
  JSON.stringify(byCab(SC, 'c_touch').wallContacts) === JSON.stringify([{ wallId: 'r1_w1', relation: 'touching', gap: 0 }]),
  JSON.stringify(byCab(SC, 'c_touch').wallContacts)
);
ok(
  '14. 悬空柜：wallContacts 为空 + concern 含 floating（且不含 touching-wall，两件事不许混）',
  byCab(SC, 'c_float').wallContacts.length === 0 &&
    concernsOf(SC, 'c_float').includes('floating') &&
    !concernsOf(SC, 'c_float').includes('touching-wall'),
  JSON.stringify(concernsOf(SC, 'c_float'))
);
ok(
  '15. 挡门柜给出 door clearance：opening open_001 / status overlap / intrusion 600mm + concern in-door-swing',
  JSON.stringify(byCab(SC, 'c_door').doorClearances) ===
    JSON.stringify([{ openingId: 'open_001', status: 'overlap', intrusion: 600 }]) &&
    concernsOf(SC, 'c_door').includes('in-door-swing'),
  JSON.stringify(byCab(SC, 'c_door').doorClearances)
);
ok(
  '16. 压洞口柜给出 opening proximity：open_win / window / overlap + concern blocks-opening',
  JSON.stringify(byCab(SC, 'c_touch').openingProximity) ===
    JSON.stringify([{ openingId: 'open_win', kind: 'window', relation: 'overlap' }]) &&
    concernsOf(SC, 'c_touch').includes('blocks-opening'),
  JSON.stringify(byCab(SC, 'c_touch').openingProximity)
);
ok(
  '17. 每只柜的 roomRelation 是事实枚举（inside/outside/crossing/unknown 之一）',
  SC.cabinetFacts.every((c) => ['inside', 'outside', 'crossing', 'unknown'].includes(c.roomRelation)),
  JSON.stringify(SC.cabinetFacts.map((c) => c.roomRelation))
);
ok(
  '18. concern token 全部落在闭集内（10 个词，逐条核对）',
  (() => {
    const allowed = new Set<AiSpaceConcern>([
      'room-not-closed',
      'outside-room',
      'crossing-room',
      'crossing-wall',
      'touching-wall',
      'near-wall',
      'floating',
      'blocks-opening',
      'in-door-swing',
      'door-swing-unknown',
    ]);
    const seen = new Set<AiSpaceConcern>();
    for (const c of SC.cabinetFacts) for (const t of c.concerns) seen.add(t);
    return [...seen].every((t) => allowed.has(t)) && [...seen].length > 0;
  })(),
  JSON.stringify(SC.cabinetFacts.map((c) => c.concerns))
);

// ═══════════════════════ §2 与派生 / 统一验证一致 ═══════════════════════
section('§2 与 deriveSpatial / designValidation 结果一致（同一份派生，不是第二套判定）');

const SP = deriveSpatial(RICH);
ok(
  '19. 每个房间 boundary.closed === deriveSpatial(p).facts.rooms[i].closed（逐条）',
  SC.rooms.every((r, i) => r.boundary.closed === SP.facts.rooms[i]!.closed),
  JSON.stringify([SC.rooms.map((r) => r.boundary.closed), SP.facts.rooms.map((r) => r.closed)])
);
ok(
  '20. boundary.status 与 facts.problem 对应：closed=true ↔ problem=null（ok 是唯一闭合态）',
  SC.rooms.every((r, i) => SP.facts.rooms[i]!.closed === (r.boundary.status === 'ok')),
  JSON.stringify([SC.rooms.map((r) => r.boundary.status), SP.facts.rooms.map((r) => r.problem)])
);
ok(
  '21. 每只柜 roomRelation === deriveSpatial(p).facts.cabinets[i].room',
  SC.cabinetFacts.every((c, i) => c.roomRelation === SP.facts.cabinets[i]!.room),
  JSON.stringify([SC.cabinetFacts.map((c) => c.roomRelation), SP.facts.cabinets.map((c) => c.room)])
);
ok(
  '22. wallContacts 与 facts.cabinets[i].walls 逐条相同（widget 数 + wallId/relation/gap 全等）',
  SC.cabinetFacts.every((c, i) => {
    const f = SP.facts.cabinets[i]!;
    return (
      c.wallContacts.length === f.walls.length &&
      c.wallContacts.every((w, j) => w.wallId === f.walls[j]!.wallId && w.relation === f.walls[j]!.relation && w.gap === f.walls[j]!.gap)
    );
  }),
  JSON.stringify([SC.cabinetFacts.map((c) => c.wallContacts), SP.facts.cabinets.map((c) => c.walls)])
);
ok(
  '23. openingProximity === facts.cabinets[i].openings 里 relation !== "clear" 的那批（顺序一致）',
  SC.cabinetFacts.every((c, i) => {
    const expected = SP.facts.cabinets[i]!.openings
      .filter((o) => o.relation !== 'clear')
      .map((o) => ({ openingId: o.openingId, kind: o.kind, relation: o.relation }));
    return JSON.stringify(c.openingProximity) === JSON.stringify(expected);
  }),
  JSON.stringify(SC.cabinetFacts.map((c) => c.openingProximity))
);
ok(
  '24. doorClearances === deriveSpatial(p).clearances 里 overlap/touch 那批的投影（含 intrusion=600）',
  (() => {
    const expected = SP.clearances
      .filter((c) => c.status === 'overlap' || c.status === 'touch')
      .map((c) => ({ openingId: c.openingId, status: c.status, cabinetId: c.cabinetId }));
    const got: Array<{ openingId: string; status: string; cabinetId: string }> = [];
    for (const c of SC.cabinetFacts) for (const d of c.doorClearances) got.push({ openingId: d.openingId, status: d.status, cabinetId: c.cabinetId });
    return JSON.stringify(got) === JSON.stringify(expected);
  })(),
  JSON.stringify([SC.cabinetFacts.map((c) => c.doorClearances), SP.clearances])
);
ok(
  '25. 门的开启判定与 deriveDoorSwing 同源：每个门的 status/reason 与 door fact 相同',
  (() => {
    const doors = deriveDoorSwing(RICH).doors;
    return SC.openings
      .filter((o) => o.kind === 'door')
      .every((o) => {
        const d = doors.find((x) => x.openingId === o.id)!;
        return o.swing!.status === d.status && (o.swing!.unknownReason ?? undefined) === d.unknownReason && (o.swing!.hinge ?? undefined) === d.hinge;
      });
  })(),
  JSON.stringify(SC.openings.filter((o) => o.kind === 'door').map((o) => o.swing))
);
ok(
  '26. 统一验证报告的 spatial 段与单独 deriveSpatial 逐字节相同（同源 → 上面的一致性传递到 P8.8）',
  JSON.stringify(validateDesign(RICH).spatial) === JSON.stringify(SP)
);
{
  const rep = validateDesign(RICH);
  const doorCabIds = [...new Set(rep.findings.filter((f) => f.code === 'DESIGN-CABINET-DOOR-SWING').map((f) => f.cabId))].sort();
  const swingCabs = SC.cabinetFacts.filter((c) => c.concerns.includes('in-door-swing')).map((c) => c.cabinetId).sort();
  ok(
    `27. 与统一验证一致：报 DESIGN-CABINET-DOOR-SWING 的柜 === concerns 含 in-door-swing 的柜（${JSON.stringify(swingCabs)}）`,
    JSON.stringify(doorCabIds) === JSON.stringify(swingCabs) && swingCabs.length > 0,
    JSON.stringify([doorCabIds, swingCabs])
  );
  const openCabIds = [...new Set(rep.findings.filter((f) => f.code === 'SPATIAL-CABINET-OPENING').map((f) => f.cabId))].sort();
  const blockCabs = SC.cabinetFacts.filter((c) => c.concerns.includes('blocks-opening')).map((c) => c.cabinetId).sort();
  ok(
    `28. 与统一验证一致：报 SPATIAL-CABINET-OPENING 的柜 === concerns 含 blocks-opening 的柜（${JSON.stringify(blockCabs)}）`,
    JSON.stringify(openCabIds) === JSON.stringify(blockCabs) && blockCabs.length > 0,
    JSON.stringify([openCabIds, blockCabs])
  );
  const floatCabs = SC.cabinetFacts.filter((c) => c.concerns.includes('floating')).map((c) => c.cabinetId).sort();
  const floatFindings = [...new Set(rep.findings.filter((f) => f.code === 'DESIGN-CABINET-FLOATING').map((f) => f.cabId))].sort();
  ok(
    `29. 与统一验证一致：concerns 含 floating 的柜 === 报 DESIGN-CABINET-FLOATING 的柜（${JSON.stringify(floatCabs)}）`,
    JSON.stringify(floatCabs) === JSON.stringify(floatFindings) && floatCabs.length > 0,
    JSON.stringify([floatCabs, floatFindings])
  );
}
ok(
  '30. 确定性：同一项目连算两次逐字节相同',
  JSON.stringify(buildSpatialContext(RICH)) === JSON.stringify(SC)
);
ok(
  '31. 不写回模型：buildSnapshot 前后 project 的 JSON 逐字节相同（快照是只读投影）',
  (() => {
    const p = richProject();
    const before = JSON.stringify(p);
    buildSnapshot(p, RULES);
    return before === JSON.stringify(p);
  })()
);

// ═══════════════════════ §3 没有坐标写入口 ═══════════════════════
section('§3 没有坐标写入口：无坐标 / 无多边形 / 无包络');

/** B3 同款判据：只允许 cabinets[*].placement 出现 {x,y}；不许出现长度 2/6 的裸数字数组 */
function geometryHits(root: unknown, rootPath: string): string[] {
  const hits: string[] = [];
  (function walk(n: unknown, path: string): void {
    if (Array.isArray(n)) {
      if ((n.length === 2 || n.length === 6) && n.every((v) => typeof v === 'number')) hits.push(`${path}=[${n.join(',')}]`);
      n.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      const isPlacement = new RegExp(`^${rootPath}\\.cabinets\\[\\d+\\]\\.placement$`).test(path);
      if (!isPlacement && typeof o.x === 'number' && typeof o.y === 'number') hits.push(`${path}={x,y}`);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    }
  })(root, rootPath);
  return hits;
}
{
  const hits = geometryHits(SNAP, 'snapshot');
  ok('32. 全快照扫描：除 cabinets[*].placement 外没有任何 {x,y}（空间事实也没带坐标进来）', hits.length === 0, hits.slice(0, 6));
  const hitsSc = geometryHits(SC, 'spatialContext');
  ok('33. 只扫空间上下文同样是 0 命中（它不是靠外层的例外规则蒙混过关）', hitsSc.length === 0, hitsSc.slice(0, 6));
  const dirty = clone(SC) as unknown as Record<string, unknown>;
  (dirty.rooms as Array<Record<string, unknown>>)[0]!.bbox = { min: [0, 0], max: [4000, 3000] };
  ok('34. 负样本：往空间上下文塞派生包围盒 → 判据必须检出（证明判据有牙）', geometryHits(dirty, 'spatialContext').length > 0);
}
ok(
  '35. 空间上下文里没有 pts / path / poly / points 这类图元字段',
  !['pts', 'path', 'poly', 'points'].some((k) => JSON.stringify(SC).includes(`"${k}"`))
);
ok(
  '36. 门扇只给"判得出/判不出"：快照里没有 envelope / closedTip / openTip / arcSegments / hingePoint',
  !['envelope', 'closedTip', 'openTip', 'arcSegments', 'hingePoint'].some((k) => JSON.stringify(SNAP).includes(k)),
  JSON.stringify(SC.openings.filter((o) => o.kind === 'door').map((o) => o.swing))
);
ok(
  '37. opening.swing 的键只有 {status, hinge, direction, unknownReason} 四种子集（没有多余形状）',
  SC.openings
    .filter((o) => o.kind === 'door')
    .every((o) => Object.keys(o.swing!).every((k) => ['status', 'hinge', 'direction', 'unknownReason'].includes(k)))
);
ok(
  '38. hinge 是语义枚举（start/end 字符串），**不是坐标**（避免"铰链点"混进来）',
  SC.openings.filter((o) => o.kind === 'door').every((o) => o.swing!.hinge === undefined || o.swing!.hinge === 'start' || o.swing!.hinge === 'end')
);
ok(
  '39. 空间上下文里所有数字都是整数（mm 精度，不带浮点尾巴）',
  (() => {
    const bads: string[] = [];
    (function walk(n: unknown, p: string): void {
      if (typeof n === 'number') {
        if (!Number.isInteger(n)) bads.push(`${p}=${n}`);
        return;
      }
      if (Array.isArray(n)) return n.forEach((v, i) => walk(v, `${p}[${i}]`));
      if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) walk(v, `${p}.${k}`);
    })(SC, 'sc');
    return bads.length === 0;
  })()
);
ok(
  '40. 快照体积仍在预算内（< 40000 字节）—— 空间事实是"够用但不精确到假"的量级',
  snapshotBytes(SNAP) < 40_000,
  `${snapshotBytes(SNAP)} bytes`
);
{
  const src = readFileSync(join(APP, 'src/ai/spatialContext.ts'), 'utf8');
  const code = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join('\n');
  ok('41. spatialContext.ts 的代码里没有一处三角函数（sin / cos / tan / atan2）', !/Math\.(sin|cos|tan|atan2)\b/.test(code));
}

// ═══════════════════════ §4 AI 契约没新增非法动作 ═══════════════════════
section('§4 AI 契约边界：没新增动作，也没有任何写墙/写洞口的入口');

const BASELINE_ACTIONS = [
  'cabinet.resize',
  'cabinet.setBodyLift',
  'cabinet.setWidthMode',
  'cabinet.rename',
  'cabinet.move',
  'cabinet.nudge',
  'cabinet.rotate',
  'cabinet.place',
  'cabinet.setUnitWidth',
  'cabinet.setUnitParam',
  'cabinet.renameUnit',
  'cabinet.addUnit',
  'cabinet.removeUnit',
  'cabinet.setBoardMaterial',
  'cabinet.setBackMaterial',
  'cabinet.create',
  'cabinet.duplicate',
  'cabinet.delete',
  'assembly.create',
  'assembly.delete',
  'project.rename',
];
ok(
  '42. 动作清单与 P9.1 之前**逐字一致**（21 个；加动作必须同时改这条断言，漂移哨兵）',
  JSON.stringify([...ACTION_NAMES].sort()) === JSON.stringify([...BASELINE_ACTIONS].sort()) && ACTION_NAMES.length === 21,
  JSON.stringify(ACTION_NAMES)
);
ok(
  '43. 没有任何动作名与墙 / 洞口 / 门扇 / 空间有关',
  !ACTION_NAMES.some((n: string) => /wall|opening|door|spatial|swing/i.test(n)),
  JSON.stringify(ACTION_NAMES.filter((n: string) => /wall|opening|door|spatial|swing/i.test(n)))
);
{
  const ctx = snapshotContext(SNAP);
  const try_ = (raw: unknown) => validateAction(raw, ctx);
  ok(
    '44. 负样本：wall.move → UNKNOWN_ACTION（AI 没有改墙的语法）',
    try_({ action: 'wall.move', target: { wallId: 'r1_w1' }, params: {} }).code === 'UNKNOWN_ACTION'
  );
  ok(
    '45. 负样本：opening.update → UNKNOWN_ACTION（AI 也没有改洞口的语法）',
    try_({ action: 'opening.update', target: { wallId: 'r1_w1' }, params: { width: 1200 } }).code === 'UNKNOWN_ACTION'
  );
  ok(
    '46. 负样本：door.swing.set → UNKNOWN_ACTION（开门方向是设计决定，AI 不许代填）',
    try_({ action: 'door.swing.set', target: { cabinetName: 'c_touch' }, params: { direction: 'into-room' } }).code === 'UNKNOWN_ACTION'
  );
  ok(
    '47. 负样本：把 wallId 塞进合法动作的 target → EXTRA_TARGET_KEY 整条作废（target 白名单里没有墙/洞口）',
    (() => {
      const r = try_({ action: 'cabinet.resize', target: { cabinetName: 'c_touch', wallId: 'r1_w1' }, params: { width: 1800 } });
      return !r.ok && r.code === 'EXTRA_TARGET_KEY';
    })(),
    JSON.stringify(try_({ action: 'cabinet.resize', target: { cabinetName: 'c_touch', wallId: 'r1_w1' }, params: { width: 1800 } }))
  );
}
ok(
  '48. 契约没把空间实体变成可写参数：没有动作参数叫 spatialContext/wallId/openingId，往动作里塞 hinge 也整条作废',
  (() => {
    const params: string[] = [];
    for (const s of Object.values(ACTIONS as Record<string, { params?: Record<string, unknown> }>)) {
      params.push(...Object.keys(s.params ?? {}));
    }
    const nameLeak = params.filter((p) => ['spatialContext', 'wallId', 'openingId', 'hinge', 'swingDirection'].includes(p));
    const r = validateAction(
      { action: 'cabinet.rotate', target: { cabinetName: 'c_touch' }, params: { deg: 90, hinge: 'start' } },
      snapshotContext(SNAP)
    );
    return nameLeak.length === 0 && !r.ok && r.code === 'EXTRA_PARAM';
  })(),
  JSON.stringify(validateAction({ action: 'cabinet.rotate', target: { cabinetName: 'c_touch' }, params: { deg: 90, hinge: 'start' } }, snapshotContext(SNAP)))
);
ok(
  '49. 形状门仍然拒收坐标：方案里 placement 写 x/y → 直接拒（"面名是语义，坐标是几何"这条界线没变）',
  (() => {
    const bad = proposalShapeError({
      title: 't',
      cabinets: [{ ref: 'a', placement: { relation: 'attach', reference: 'b', x: 100 } }],
    });
    return typeof bad === 'string' && bad.includes('不接受坐标');
  })(),
  String(proposalShapeError({ title: 't', cabinets: [{ ref: 'a', placement: { relation: 'attach', reference: 'b', x: 100 } }] }))
);
ok(
  '50. 但"面名"仍然是允许的：attach + targetFace/referenceFace 通过形状门（给 AI 的是语义不是坐标）',
  proposalShapeError({
    title: 't',
    cabinets: [{ ref: 'a', placement: { relation: 'attach', reference: 'b', targetFace: 'back', referenceFace: 'right' } }],
  }) === null
);

// ═══════════════════════ §5 unknown 保持 unknown ═══════════════════════
section('§5 判不出来就保持判不出来（unknown 不被默认值顶替）');

{
  const p = noSwingProject();
  const sc = buildSpatialContext(p);
  const door = sc.openings.find((o) => o.kind === 'door')!;
  ok(
    '51. 门没指定开启语义 → swing.status="unknown" + reason="no-swing"，**不填** into-room 默认值',
    door.swing!.status === 'unknown' &&
      door.swing!.unknownReason === 'no-swing' &&
      door.swing!.hinge === undefined &&
      door.swing!.direction === undefined,
    JSON.stringify(door.swing)
  );
  ok(
    '52. 未指定的门不产任何净空结论：该柜 doorClearances 为空（无包络 → 无从判）',
    byCab(sc, 'c2').doorClearances.length === 0 && deriveSpatial(p).clearances.length === 0,
    JSON.stringify([byCab(sc, 'c2').doorClearances, deriveSpatial(p).clearances])
  );
  ok(
    '53. 但"判不出"本身要说出来：同房间的柜 concerns 含 door-swing-unknown（沉默不等于没问题）',
    concernsOf(sc, 'c2').includes('door-swing-unknown'),
    JSON.stringify(concernsOf(sc, 'c2'))
  );
  ok(
    '54. 同时**不含** in-door-swing（没判出来就不许声称撞上）',
    !concernsOf(sc, 'c2').includes('in-door-swing')
  );
}
{
  // 洞口 span 越界：authored 的开启意图照实保留，但包络判不出 → unknown + bad-span
  const room = mkRoom('rd');
  room.walls[2]!.openings = [
    { id: 'od', kind: 'door', offset: 3500, width: 900, hinge: 'start', swingDirection: 'into-room' } as never,
  ];
  const p = mkProject([room], [mkCab(room, 'cd', 400, 60, 1200, 600)]);
  const sc = buildSpatialContext(p);
  const door = sc.openings[0]!;
  ok(
    '55. 洞口越界（offset+width > 墙长）→ swing.status="unknown" + reason="bad-span"，但 authored 的 hinge/direction 照实给出',
    door.swing!.status === 'unknown' &&
      door.swing!.unknownReason === 'bad-span' &&
      door.swing!.hinge === 'start' &&
      door.swing!.direction === 'into-room',
    JSON.stringify(door.swing)
  );
  ok(
    '56. 越界洞口的柜 relation = "unknown"（不是 "clear"）→ 不被当成"没事"',
    JSON.stringify(byCab(sc, 'cd').openingProximity) === JSON.stringify([{ openingId: 'od', kind: 'door', relation: 'unknown' }]),
    JSON.stringify(byCab(sc, 'cd').openingProximity)
  );
}
{
  // 未闭合房间
  const room = mkRoom('ra');
  room.walls = room.walls.slice(0, 3);
  const p = mkProject([room], [mkCab(room, 'ca', 400, 60, 1200, 600), mkCab(room, 'ca2', 1500, 1500, 900, 400, 0)]);
  const sc = buildSpatialContext(p);
  ok(
    '57. 未闭合房间：boundary.closed=false / status="open" / 不给 extent（判不出就不编尺寸）',
    sc.rooms[0]!.boundary.closed === false && sc.rooms[0]!.boundary.status === 'open' && sc.rooms[0]!.extent === undefined,
    JSON.stringify(sc.rooms[0])
  );
  ok(
    '58. 未闭合房间里的柜：roomRelation="unknown" + concern room-not-closed；**不谎报** floating',
    byCab(sc, 'ca').roomRelation === 'unknown' &&
      concernsOf(sc, 'ca').includes('room-not-closed') &&
      !concernsOf(sc, 'ca2').includes('floating'),
    JSON.stringify([byCab(sc, 'ca').roomRelation, concernsOf(sc, 'ca'), concernsOf(sc, 'ca2')])
  );
}
{
  // 退化房间：只有一面零长墙
  const wall = createWall({
    id: 'rb_w1',
    name: 'rb墙1',
    start: { x: 0, y: 0 },
    end: { x: 0, y: 0 },
    thickness: 120,
    height: 2700,
    takenIds: [] as string[],
  });
  const room: Room = { id: 'rb', name: '房间rb', walls: [wall] };
  const p = mkProject([room], [mkCab(room, 'cb', 400, 60, 1200, 600)]);
  const sc = buildSpatialContext(p);
  ok(
    '59. 零长墙：axis="degenerate"（不编一个方向）、房间无 extent、柜 roomRelation="unknown"、只报 room-not-closed',
    sc.walls[0]!.axis === 'degenerate' &&
      sc.walls[0]!.length === 0 &&
      sc.rooms[0]!.extent === undefined &&
      byCab(sc, 'cb').roomRelation === 'unknown' &&
      JSON.stringify(concernsOf(sc, 'cb')) === JSON.stringify(['room-not-closed']),
    JSON.stringify([sc.walls[0], sc.rooms[0], byCab(sc, 'cb').roomRelation, concernsOf(sc, 'cb')])
  );
}

// ═══════════════════ §6 未确认事实不进"确定事实" ═══════════════════
section('§6 导入 / 图片识别的未确认事实进不了确定事实');

ok(
  '60. 空间上下文只有 Project 一个输入源（arity=1）—— 导入/识别的假设没有第二条注入路径',
  buildSpatialContext.length === 1 && JSON.stringify(SNAP.spatialContext) === JSON.stringify(buildSpatialContext(RICH)),
  `arity=${buildSpatialContext.length}`
);
ok(
  '61. rooms 清空 → 空间事实为空（墙/洞口只可能来自 Project.rooms，快照不发明空间）',
  (() => {
    const sc = buildSpatialContext(mkProject([], []));
    return sc.rooms.length === 0 && sc.walls.length === 0 && sc.openings.length === 0 && sc.cabinetFacts.length === 0 && sc.readOnly === true;
  })()
);
ok(
  '62. 快照里没有任何未确认标记（uncertainty / hypothesis / caveats / confidence / origin 一律不出现）',
  !['uncertainty', 'hypothesis', 'Hypothesis', 'caveats', 'confidence', 'origin'].some((k) => JSON.stringify(SNAP).includes(k)),
  JSON.stringify(['uncertainty', 'hypothesis', 'caveats', 'confidence', 'origin'].filter((k) => JSON.stringify(SNAP).includes(k)))
);
{
  // 行为证据：带 uncertainty 的识别结果**被阻断**，所以它到不了模型（也就到不了空间事实）
  const nd: NormalizedDesign = {
    title: '图片识别假设',
    source: 'image',
    batchId: 'b1',
    cabinets: [{ ref: 'a', width: 900, uncertainty: ['墙厚看不清'] }],
  };
  const issues = validateNormalized(nd, RICH);
  ok(
    '63. 带 uncertainty 的识别结果被 IMPORT-UNCERTAINTY 阻断（importBlocked=true）→ 无法成为确定事实',
    importBlocked(issues) === true && issues.some((i) => i.code === 'IMPORT-UNCERTAINTY'),
    JSON.stringify(issues.map((i) => i.code))
  );
  ok(
    '64. 干净的识别结果也要人确认才落地：它的产物是 proposal（不是 Project），不经确认进不了 rooms/墙/洞口',
    (() => {
      const clean: NormalizedDesign = { title: '干净', source: 'image', batchId: 'b2', cabinets: [{ ref: 'a', width: 900 }] };
      const okIssues = validateNormalized(clean, RICH);
      return importBlocked(okIssues) === false && !('rooms' in clean) && !('schemaVersion' in clean);
    })()
  );
}

// ═══════════════════════ §7 架构与不变量 ═══════════════════════
section('§7 架构：纯投影、依赖方向、既有不变量不破');

{
  const src = readFileSync(join(APP, 'src/ai/spatialContext.ts'), 'utf8');
  // 只取代码行（去掉注释行）后匹配 `from '…'` —— **多行 import 的 from 在续行上**，
  // 只扫"以 import 开头的行"会漏掉它，那样依赖方向断言就成了假绿。
  const codeOnly = src
    .split('\n')
    .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
    .join('\n');
  const specifiers = [...codeOnly.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
  ok(
    '65. spatialContext 只从 core/spatial、core/types、core/geometry 取数（恰好 3 个来源，派生事实的唯一来源）',
    specifiers.length === 3 &&
      specifiers.includes('../core/spatial/index.ts') &&
      specifiers.includes('../core/types.ts') &&
      specifiers.includes('../core/geometry/transform.ts'),
    JSON.stringify(specifiers)
  );
  ok(
    '66. 不 import AI 相关层 / 导出 / 制造 / 知识 / 命令总线（纯投影，无副作用）',
    !specifiers.some((s) => /\/vision\/|\/import\/|\/export\/|manufacturing|knowledge|commandBus|\/ai\//.test(s)),
    JSON.stringify(specifiers)
  );
  ok(
    '67. 纯函数：源文件里没有 Date.now / Math.random / performance.now（无时钟无随机）',
    !/Date\.now|Math\.random|performance\.now/.test(src)
  );
  ok(
    '68. 既有白名单不变量不破：快照里不出现任何派生字段名（derived / panels / issues / geom / views / assembly / explode / hardware / legend / price / cut）',
    (() => {
      const json = JSON.stringify(SNAP);
      const keys = ['derived', 'panels', 'issues', 'geom', 'views', 'assembly', 'explode', 'hardware', 'legend', 'price', 'cut'];
      return keys.every((k) => !json.includes(`"${k}"`));
    })()
  );
  ok(
    '69. 旧的快照出口没变：snapshotContext 仍给 bodyMaterials / backMaterials / roomCount（旧消费者不受影响）',
    (() => {
      const c = snapshotContext(SNAP);
      return Array.isArray(c.bodyMaterials) && Array.isArray(c.backMaterials) && c.roomCount === 1;
    })()
  );
  ok(
    '70. 空间上下文的形状稳定：无房间时键仍在（不因"空"而消失 —— 形状一致才谈得上多轮可比）',
    'spatialContext' in buildSnapshot(mkProject([], []), RULES)
  );
  ok(
    '71. 新增的块确实进了 AiSnapshot（不是只存在于模块里没人调用）',
    (() => {
      const s = buildSnapshot(RICH, RULES);
      return s.spatialContext.rooms.length === 1 && s.spatialContext.walls.length === 4 && s.spatialContext.openings.length === 2;
    })()
  );
  ok(
    '72. 已接进 verify:all（脚本没接进链路等于不存在）',
    (() => {
      const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      return typeof pkg.scripts['verify:spatial-context-ai'] === 'string' && /verify:spatial-context-ai/.test(pkg.scripts['verify:all'] ?? '');
    })()
  );
}

console.log(`\n═══ P9.1 Spatial Context for AI 验收：通过 ${passed} / 失败 ${failed} ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
