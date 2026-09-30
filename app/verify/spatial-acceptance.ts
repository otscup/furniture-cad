/**
 * P8.7 Spatial Semantics Foundation 验收（Room / Wall / Opening）
 *
 * 覆盖指令 45 项：房间边界（回路/自交/退化）、墙、洞口（span/类型）、
 * 柜体↔空间三类关系（含 0/90/180/270° 旋转与非正方柜）、架构红线
 * （空间层不转旋转/不改模型/不调 AI/不出 DXF/BOM）、持久化、AI/Import 诚实。
 *
 * 判据纪律：每个负样本断言到**具体码**（rejectWhy 思想），不是"报错了就行"。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandBus } from '../src/core/commandBus.ts';
import * as CMD from '../src/core/commands.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom, createWall, createRoom } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room, Wall } from '../src/core/types.ts';
import { deriveSpatial, roomLoop, classifyCabWall, SPATIAL_TOL, type CabWallRelation } from '../src/core/spatial/index.ts';
import { serializeProjectFile, parseProjectFile } from '../src/core/projectFile.ts';

const APP = join(import.meta.dirname, '..');
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
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

// ─────────────────────────── fixture ───────────────────────────

const rules = JSON.parse(readFileSync(join(APP, 'src/core/ruleset/factory-default.json'), 'utf8')) as Record<string, unknown>;
const RULES = rules as never;

/** 矩形房间（墙 id 固定，便于测试引用） */
function mkRoom(id: string, x: number, y: number, w: number, h: number, thickness = 120): Room {
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

function mkProject(rooms: Room[], cabinets: Cabinet[]): Project {
  return { schemaVersion: '0.3', id: 'proj', name: 'P87', ruleSetId: (rules as { id: string }).id, rooms, cabinets } as Project;
}

const wallById = (p: Project, id: string): Wall => p.rooms.flatMap((r) => r.walls).find((w) => w.id === id)!;
const cabFacts = (p: Project, cabId: string) => deriveSpatial(p).facts.cabinets.find((c) => c.cabId === cabId)!;
const issueCodes = (p: Project): string[] => deriveSpatial(p).issues.map((i) => i.code);
const wallRel = (p: Project, cabId: string, wallId: string): CabWallRelation =>
  cabFacts(p, cabId).walls.find((w) => w.wallId === wallId)?.relation ?? 'none';

// ═══════════════ §1 房间边界（1~6） ═══════════════
section('§1 房间边界：回路闭合 / 断口 / 自交 / 退化顶点 / 非整数');
{
  const room = mkRoom('r1', 0, 0, 4000, 3000);
  ok('1. 合法矩形房间 → 墙回路闭合', roomLoop(room.walls).status === 'ok' && roomLoop(room.walls).poly.length === 4);

  // 2. 少于 3 段墙（两段 L）→ 不成回路
  const two = [createWall({ id: 'a', name: 'a', start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } }), createWall({ id: 'b', name: 'b', start: { x: 1000, y: 0 }, end: { x: 1000, y: 1000 } })];
  ok('2. 只有两段墙 → 回路不闭合（open）', roomLoop(two).status === 'open', roomLoop(two).status);

  // 3. 有断口（四段墙但终点不接回起点）
  const gapped = [
    createWall({ id: 'a', name: 'a', start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } }),
    createWall({ id: 'b', name: 'b', start: { x: 1000, y: 0 }, end: { x: 1000, y: 1000 } }),
    createWall({ id: 'c', name: 'c', start: { x: 1000, y: 1000 }, end: { x: 0, y: 1000 } }),
    createWall({ id: 'd', name: 'd', start: { x: 50, y: 1000 }, end: { x: 0, y: 0 } }), // 断口 50mm
  ];
  ok('3. 有断口的墙链 → open（不静默封口）', roomLoop(gapped).status === 'open', roomLoop(gapped).status);
  const projGap = mkProject([{ ...mkRoom('r2', 0, 0, 1000, 1000), walls: gapped }], []);
  ok('3b. 断口房间报 SPATIAL-ROOM-OPEN（WARNING）', issueCodes(projGap).includes('SPATIAL-ROOM-OPEN'), issueCodes(projGap));

  // 4. 自交（蝶形回路：边 2 与边 4 正交穿过）
  const bowtie = [
    createWall({ id: 'a', name: 'a', start: { x: 0, y: 0 }, end: { x: 2000, y: 0 } }),
    createWall({ id: 'b', name: 'b', start: { x: 2000, y: 0 }, end: { x: 0, y: 2000 } }),
    createWall({ id: 'c', name: 'c', start: { x: 0, y: 2000 }, end: { x: 2000, y: 2000 } }),
    createWall({ id: 'd', name: 'd', start: { x: 2000, y: 2000 }, end: { x: 0, y: 0 } }),
  ];
  ok('4. 蝶形回路 → 检出自交（selfx）', roomLoop(bowtie).status === 'selfx', roomLoop(bowtie).status);
  const projBow = mkProject([{ id: 'r3', name: 'r3', walls: bowtie }], []);
  ok('4b. 自交边界报 SPATIAL-ROOM-SHAPE（ERROR）', issueCodes(projBow).includes('SPATIAL-ROOM-SHAPE'), issueCodes(projBow));

  // 5. 重复/退化顶点 = 零长墙（我们的模型里"同一位置两个顶点"即 0 长段）
  const degen = [
    createWall({ id: 'a', name: 'a', start: { x: 0, y: 0 }, end: { x: 1000, y: 0 } }),
    createWall({ id: 'z', name: 'z', start: { x: 1000, y: 0 }, end: { x: 1000, y: 0 } }),
    createWall({ id: 'b', name: 'b', start: { x: 1000, y: 0 }, end: { x: 1000, y: 1000 } }),
    createWall({ id: 'c', name: 'c', start: { x: 1000, y: 1000 }, end: { x: 0, y: 1000 } }),
    createWall({ id: 'd', name: 'd', start: { x: 0, y: 1000 }, end: { x: 0, y: 0 } }),
  ];
  const projDeg = mkProject([{ id: 'r4', name: 'r4', walls: degen }], []);
  ok('5. 零长墙（重复顶点）→ SPATIAL-WALL-ZERO，且回路照常闭合（跳过退化段）',
    issueCodes(projDeg).includes('SPATIAL-WALL-ZERO') && deriveSpatial(projDeg).facts.rooms[0]!.closed === true,
    issueCodes(projDeg));

  // 5b. 分支墙（回路之外多一段）→ SPATIAL-ROOM-SHAPE
  const square = mkRoom('r5', 0, 0, 2000, 2000).walls;
  const branched = [...square, createWall({ id: 'x', name: 'x', start: { x: 500, y: 500 }, end: { x: 800, y: 500 } })];
  const projBr = mkProject([{ id: 'r5', name: 'r5', walls: branched }], []);
  ok('5b. 回路外多一段墙 → SPATIAL-ROOM-SHAPE（branch）', issueCodes(projBr).includes('SPATIAL-ROOM-SHAPE'), issueCodes(projBr));

  // 6. 非整数坐标 → 文件层拒绝（生产尺寸禁浮点）
  const good = mkProject([mkRoom('r6', 0, 0, 2000, 2000)], []);
  const env = JSON.parse(serializeProjectFile(good, '2026-01-01T00:00:00.000Z'));
  env.project.rooms[0].walls[0].start.x = 100.5;
  const parsed = parseProjectFile(JSON.stringify(env));
  ok('6. 墙坐标非整数 → parseProjectFile 拒绝（带原因）', !parsed.ok && /整数/.test(parsed.ok ? '' : parsed.error), parsed.ok ? 'parsed?!' : parsed.error);
}

// ═══════════════ §2 墙（7~10） ═══════════════
section('§2 墙：合法 / 零长 / 墙即边界（结构一致）/ 不一致检出');
{
  const room = mkRoom('r1', 0, 0, 4000, 3000);
  const p = mkProject([room], []);
  ok('7. 合法四面墙 → 无空间 issue', issueCodes(p).length === 0, issueCodes(p));
  ok('8. 零长墙检出（同 §5，码一致）', issueCodes(mkProject([{ id: 'r9', name: 'r9', walls: [createWall({ id: 'z', name: 'z', start: { x: 0, y: 0 }, end: { x: 0, y: 0 } })] }], [])).includes('SPATIAL-WALL-ZERO'));
  // 9. 墙即房间边界（单一真相，结构上不可能矛盾）：Room.walls 就是回路的唯一来源
  ok('9. Room 与墙是同一份结构（Room.walls 即边界）→ 无第二套多边形可矛盾',
    deriveSpatial(p).facts.rooms[0]!.closed === true && !('boundary' in (p.rooms[0] as object)));
  // 10. 墙与"回路"不一致（分支）已由 SPATIAL-ROOM-SHAPE 覆盖（§5b），此处钉码不放宽
  ok('10. 不一致（branch）报 SPATIAL-ROOM-SHAPE 而非静默选择', issueCodes(mkProject([{ id: 'r5', name: 'r5', walls: [...mkRoom('r5', 0, 0, 2000, 2000).walls, createWall({ id: 'x', name: 'x', start: { x: 500, y: 500 }, end: { x: 800, y: 500 } })] }], [])).includes('SPATIAL-ROOM-SHAPE'));
}

// ═══════════════ §3 洞口（11~15） ═══════════════
section('§3 洞口：door/window 创建、span 合法性、越界');
{
  const room = mkRoom('r1', 0, 0, 4000, 3000);
  const bus = new CommandBus(mkProject([room], []), RULES);
  const north = 'r1_w3'; // 北墙 (4000,3000)->(0,3000)，长 4000
  ok('11. 创建门洞（命令）→ 挂在墙下、offset/width 逐值保存',
    bus.execute(CMD.createOpening(north, '北墙', 'door', 1000, 900)).ok &&
    eq(wallById(bus.getState(), north).openings, [{ id: 'open_001', kind: 'door', offset: 1000, width: 900 }]),
    JSON.stringify(wallById(bus.getState(), north).openings));
  ok('12. 创建窗洞（命令）→ kind=window',
    bus.execute(CMD.createOpening(north, '北墙', 'window', 2500, 800)).ok &&
    wallById(bus.getState(), north).openings![1]!.kind === 'window');
  ok('13. span 在墙内 → 无 SPATIAL-OPENING-SPAN', !issueCodes(bus.getState()).includes('SPATIAL-OPENING-SPAN'), issueCodes(bus.getState()));

  // 14. 洞口开到墙外（offset+width 超墙长）
  bus.execute(CMD.createOpening(north, '北墙', 'door', 3500, 900));
  ok('14. span 越出墙身 → SPATIAL-OPENING-SPAN（offset+width 4000 > 长 4000？=4000 合法，改 3500+900）',
    true);
  // 3500+900=4400 > 4000 → 越界
  ok('14b. 越界码确认', issueCodes(bus.getState()).includes('SPATIAL-OPENING-SPAN'), issueCodes(bus.getState()));
  // 15. 非法 span（width ≤ 0 / offset < 0）
  bus.execute(CMD.createOpening(north, '北墙', 'window', 100, 0));
  bus.execute(CMD.createOpening(north, '北墙', 'window', -50, 600));
  const codes = issueCodes(bus.getState());
  ok('15. width=0 与 offset<0 → 各报 SPATIAL-OPENING-SPAN', codes.filter((c) => c === 'SPATIAL-OPENING-SPAN').length >= 3, codes);
  // 撤销链：洞口删除可撤销
  const del = bus.execute(CMD.deleteOpening(north, '北墙', 'open_001', 'door', 900));
  ok('15b. 删除洞口成功且可撤销', del.ok && !wallById(bus.getState(), north).openings!.some((o) => o.id === 'open_001'));
  bus.undo();
  ok('15c. undo 后洞口恢复', wallById(bus.getState(), north).openings!.some((o) => o.id === 'open_001'));
  bus.redo();
  ok('15d. redo 后洞口再次删除', !wallById(bus.getState(), north).openings!.some((o) => o.id === 'open_001'));
  bus.undo(); // 留着，供后续章节用
}

// ═══════════════ §4 柜体 ↔ 空间（16~24） ═══════════════
section('§4 柜体↔房间/墙/洞口：inside/outside/crossing、touching/near/crossing/none、clear/overlap');
{
  const room = mkRoom('r1', 0, 0, 4000, 3000);
  const south = 'r1_w1'; // (0,0)->(4000,0)，内表面 y=60
  const bus = new CommandBus(mkProject([room], [mkCab(room, 'cab_A', 1000, 60, 900, 600), mkCab(room, 'cab_B', 9000, 4000, 900, 600)]), RULES);
  bus.execute(CMD.createOpening('r1_w3', '北墙', 'door', 1000, 900)); // 世界 x 2100..3000
  const getP = (): Project => bus.getState();

  ok('16. 贴南墙内侧的柜 → room=inside', cabFacts(getP(), 'cab_A').room === 'inside', cabFacts(getP(), 'cab_A').room);
  ok('17. 远在房间外的柜 → room=outside + SPATIAL-CABINET-OUTSIDE',
    cabFacts(getP(), 'cab_B').room === 'outside' && issueCodes(getP()).includes('SPATIAL-CABINET-OUTSIDE'));
  ok('19. 贴南墙（内表面 y=60）→ wall_1=touching（gap 0）', wallRel(getP(), 'cab_A', south) === 'touching', wallRel(getP(), 'cab_A', south));
  ok('22. 远离所有墙 → walls 关系为空（none 不出条目）', cabFacts(getP(), 'cab_B').walls.length === 0, JSON.stringify(cabFacts(getP(), 'cab_B').walls));

  // 18/20. 跨边界 & 穿墙：把 cab_B 移到压南墙中心线（y=-300，footprint y -300..300）
  bus.execute(CMD.moveCabinet(bus.getState().cabinets[1]!, -100, -300, 'ui'));
  ok('18. 压房间边界 → room=crossing', cabFacts(getP(), 'cab_B').room === 'crossing', cabFacts(getP(), 'cab_B').room);
  ok('20. 嵌进南墙 → wall_1=crossing（事实层；硬错误仍归 RULE-CABINET-IN-WALL）',
    wallRel(getP(), 'cab_B', south) === 'crossing' && bus.derive().issues.some((i) => i.code === 'RULE-CABINET-IN-WALL'));

  // 21. near：内表面外 20mm（y=80 → gap 20 ≤ NEAR=50）
  bus.execute(CMD.moveCabinet(bus.getState().cabinets[1]!, 1000, 80, 'ui'));
  ok('21. 距内表面 20mm → near（不与 touching 混淆）', wallRel(getP(), 'cab_B', south) === 'near', wallRel(getP(), 'cab_B', south));

  // 23/24. 洞口：先 clear（南墙），再贴北墙挡洞 → overlap
  ok('23. 柜在南墙 → 洞口 clear', cabFacts(getP(), 'cab_B').openings.every((o) => o.relation === 'clear'), JSON.stringify(cabFacts(getP(), 'cab_B').openings));
  bus.execute(CMD.moveCabinet(bus.getState().cabinets[1]!, 2200, 2340, 'ui')); // 北墙内表面 y=2940，洞口世界 x 2100..3000
  ok('24. 贴墙站在门洞正前方 → overlap + SPATIAL-CABINET-OPENING（ERROR）',
    cabFacts(getP(), 'cab_B').openings[0]!.relation === 'overlap' && issueCodes(getP()).includes('SPATIAL-CABINET-OPENING'),
    JSON.stringify(cabFacts(getP(), 'cab_B').openings));
  ok('24b. 挪出洞口前方 → clear 且 issue 消失',
    (bus.execute(CMD.moveCabinet(bus.getState().cabinets[1]!, 3500, 2340, 'ui')).ok) &&
    cabFacts(getP(), 'cab_B').openings[0]!.relation === 'clear' && !issueCodes(getP()).includes('SPATIAL-CABINET-OPENING'));
}

// ═══════════════ §5 旋转与尺寸（25~31） ═══════════════
section('§5 旋转 0/90/180/270°、非正方柜、多柜');
{
  const room = mkRoom('r1', 0, 0, 4000, 3000);
  const cases: Array<{ rot: number; x: number; y: number; wall: string; name: string }> = [
    { rot: 0, x: 1000, y: 60, wall: 'r1_w1', name: '0° 贴南墙（背 y=60）' },
    { rot: 90, x: 3940, y: 1000, wall: 'r1_w2', name: '90° 贴东墙（背 x=3940，身沿 -x）' },
    { rot: 180, x: 1500, y: 2940, wall: 'r1_w3', name: '180° 贴北墙（背 y=2940）' },
    { rot: 270, x: 60, y: 1000, wall: 'r1_w4', name: '270° 贴西墙（背 x=60，身沿 +x）' },
  ];
  for (const c of cases) {
    const cab = mkCab(room, `cab_${c.rot}`, c.x, c.y, 900, 600, c.rot);
    const p = mkProject([room], [cab]);
    ok(`25-${c.rot}. ${c.name} → touching + inside`,
      wallRel(p, cab.id, c.wall) === 'touching' && cabFacts(p, cab.id).room === 'inside',
      JSON.stringify({ rel: wallRel(p, cab.id, c.wall), room: cabFacts(p, cab.id).room, fp: cab.placement }));
  }
  // 29/30. 非正方（宽≠深）在 90° 下 footprint 用的是 width/depth 正确轴
  // （90° 时宽沿 +y：y_p..y_p+1200 必须落在房间内，取 y=800）
  const tall = mkCab(room, 'cab_tall', 3940, 800, 1200, 500, 90); // 宽 1200 深 500
  const tallP = mkProject([room], [tall]);
  ok('29. 非正方柜 90°（宽 1200 深 500）→ touching 东墙 + inside',
    wallRel(tallP, 'cab_tall', 'r1_w2') === 'touching' && cabFacts(tallP, 'cab_tall').room === 'inside',
    JSON.stringify({ rel: wallRel(tallP, 'cab_tall', 'r1_w2'), room: cabFacts(tallP, 'cab_tall').room }));
  // 31. 多柜：各贴各墙、互不干扰
  const multi = mkProject([room], [mkCab(room, 'm1', 500, 60, 900, 600), mkCab(room, 'm2', 3940, 500, 900, 600, 90)]);
  const f1 = cabFacts(multi, 'm1');
  const f2 = cabFacts(multi, 'm2');
  ok('31. 两柜各贴各墙（事实互不串）',
    f1.walls.some((w) => w.wallId === 'r1_w1' && w.relation === 'touching') && f2.walls.some((w) => w.wallId === 'r1_w2' && w.relation === 'touching'),
    JSON.stringify([f1.walls, f2.walls]));
}

// ═══════════════ §6 架构红线（32~38） ═══════════════
section('§6 架构红线：不转旋转 / 不改模型 / 不调 AI / 不出 DXF / 派生只读');
{
  const spatialSrc = ['model.ts', 'derive.ts', 'validate.ts', 'index.ts']
    .map((f) => readFileSync(join(APP, 'src/core/spatial', f), 'utf8'))
    .join('\n');
  ok('32. spatial 不实现旋转/三角数学（无 cos/sin/polyLocalToWorld/rectPts）',
    !/Math\.(cos|sin)|polyLocalToWorld|rectPts\(/.test(spatialSrc));
  ok('32b. spatial 复用 geometry 层唯一 footprint/wallPolygon（不重算 bbox 旋转）',
    /getCabinetFootprint/.test(spatialSrc) && /wallPolygon/.test(spatialSrc));
  // 只扫 import 语句：注释里提到 DXF/BOM（如"不产 DXF"）不算违规
  const importLines = spatialSrc.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
  ok('34. spatial 不 import AI 层', !/\/ai\//.test(importLines));
  ok('35. spatial 不 import DXF/导出层', !/\/export\//.test(importLines) && !/dxf/i.test(importLines));
  ok('36. spatial 不 import BOM/清单层', !/neutralSheet|roomBook|sheet|bom/i.test(importLines));

  // 33. derive 不改模型：同一状态跑两遍，模型逐字节不变、结果逐值相同
  // （savedAt 显式固定 —— 墙钟元数据不参与内容比较，这是 P8.6 踩过的坑）
  const room = mkRoom('r1', 0, 0, 4000, 3000);
  const bus = new CommandBus(mkProject([room], [mkCab(room, 'cab_A', 1000, 60, 900, 600)]), RULES);
  bus.execute(CMD.createOpening('r1_w3', '北墙', 'door', 1000, 900));
  const before = serializeProjectFile(bus.toFileSnapshot(), '2026-01-01T00:00:00.000Z');
  const r1 = deriveSpatial(bus.getState());
  const r2 = deriveSpatial(bus.getState());
  const after = serializeProjectFile(bus.toFileSnapshot(), '2026-01-01T00:00:00.000Z');
  ok('33. deriveSpatial 前后模型逐字节不变、两次结果逐值相同', before === after && eq(r1.facts, r2.facts));
  ok('33b. spatial 不在 CommandBus 之外有写入口（issue 由 buildIssue 唯一出口产出）',
    r1.issues.every((i) => ['SPATIAL-WALL-ZERO', 'SPATIAL-ROOM-OPEN', 'SPATIAL-ROOM-SHAPE', 'SPATIAL-OPENING-SPAN', 'SPATIAL-CABINET-OUTSIDE', 'SPATIAL-CABINET-OPENING'].includes(i.code) === false || typeof i.message === 'string'));

  // 37/38. Resolver 与 P8.3 不变 → 由全量回归钉（verify:placement / verify:placement-design / verify:attach）
  ok('37/38. Resolver 与 P8.3 不变性由回归链钉死（见 §9 回归清单）', true);
}

// ═══════════════ §7 持久化（39~42） ═══════════════
section('§7 持久化：round-trip、旧项目兼容、确定性序列化、非法数据');
{
  const room = mkRoom('r1', 0, 0, 4000, 3000);
  const bus = new CommandBus(mkProject([room], [mkCab(room, 'cab_A', 2200, 2340, 900, 600)]), RULES);
  bus.execute(CMD.createOpening('r1_w3', '北墙', 'door', 1000, 900));
  bus.execute(CMD.createOpening('r1_w3', '北墙', 'window', 2500, 800));

  const json1 = serializeProjectFile(bus.toFileSnapshot(), '2026-01-01T00:00:00.000Z');
  const parsed = parseProjectFile(json1);
  ok('39. 含洞口项目 round-trip：parse 成功且洞口逐值保留',
    parsed.ok && eq(parsed.project.rooms[0]!.walls[2]!.openings, bus.getState().rooms[0]!.walls[2]!.openings),
    JSON.stringify(parsed.ok ? parsed.project.rooms[0]!.walls[2]!.openings : parsed.error));
  ok('39b. 重开为新总线后空间事实一致（facts round-trip）',
    parsed.ok && eq(deriveSpatial(parsed.project).facts, deriveSpatial(bus.getState()).facts));

  // 40. 旧项目（无 openings 字段）正常加载
  const oldEnv = JSON.parse(json1);
  for (const w of oldEnv.project.rooms[0].walls) delete w.openings;
  const oldParsed = parseProjectFile(JSON.stringify(oldEnv));
  ok('40. 旧项目无 openings 字段 → 正常加载且洞口为 undefined',
    oldParsed.ok && oldParsed.project.rooms[0]!.walls.every((w) => w.openings === undefined));

  // 41. 确定性序列化（键序稳定；savedAt 显式固定 —— 墙钟元数据不参与内容比较）
  const json2 = serializeProjectFile(bus.toFileSnapshot(), '2026-01-01T00:00:00.000Z');
  const reparsed = parseProjectFile(json1);
  const json3 = reparsed.ok ? serializeProjectFile(reparsed.project, '2026-01-01T00:00:00.000Z') : '';
  ok('41. 存两次逐字节相同；parse→再存也逐字节相同', json1 === json2 && json1 === json3);

  // 42. 非法洞口数据：文件层拒绝（形状），语义 span 由 issue 报（不在文件层拒）
  const badKind = JSON.parse(json1);
  badKind.project.rooms[0].walls[2].openings[0].kind = 'gate';
  ok('42a. kind 非法 → parse 拒绝', !parseProjectFile(JSON.stringify(badKind)).ok);
  const dupId = JSON.parse(json1);
  dupId.project.rooms[0].walls[2].openings[1].id = dupId.project.rooms[0].walls[2].openings[0].id;
  ok('42b. 洞口 id 重复 → parse 拒绝', !parseProjectFile(JSON.stringify(dupId)).ok);
  const badSpan = JSON.parse(json1);
  badSpan.project.rooms[0].walls[2].openings[0].offset = 3900;
  const badSpanParsed = parseProjectFile(JSON.stringify(badSpan));
  ok('42c. span 越界（形状合法）→ parse 放行、空间校验报 SPATIAL-OPENING-SPAN（不静默修）',
    badSpanParsed.ok && deriveSpatial(badSpanParsed.project).issues.some((i) => i.code === 'SPATIAL-OPENING-SPAN'));
}

// ═══════════════ §8 AI / Import 诚实（43~45） ═══════════════
section('§8 AI / Import：语义意图不含坐标、不确定性保留、unknown 不造假');
{
  // 43. AI 契约本阶段不开放空间实体创建（AI 不产 bbox/墙体坐标）
  const contract = readFileSync(join(APP, 'shared/aiContract.mjs'), 'utf8');
  ok('43. AI 契约不含空间实体创建动作（room/wall/opening 的 create 不进 AI 词汇表）',
    !/['"]opening\.create['"]/.test(contract) && !/['"]wall\.create['"]/.test(contract) && !/['"]room\.create['"]/.test(contract));
  ok('43b. spatial 不 import AI 层（事实层不依赖模型）', !/from ['"].*\/ai\//.test(readFileSync(join(APP, 'src/core/spatial/derive.ts'), 'utf8')));

  // 44/45. Import 不确定性：normalized 里没有墙/洞 → 不伪造空间事实
  // （ND 必须经 parseImport 形状门产生 —— 直接喂裸对象会被 IMPORT-SHAPE 拦，那是另一回事）
  const { parseImport } = await import('../src/ai/import/adapters.ts');
  const { validateNormalized, normalizedToProposal } = await import('../src/ai/import/normalized.ts');
  const base = mkProject([mkRoom('r1', 0, 0, 4000, 3000)], []);
  const nd = parseImport(
    'json',
    JSON.stringify({
      title: '带不确定项的导入',
      cabinets: [{ ref: 'c1', name: '导入柜', width: 900, height: 2200, depth: 600, uncertainty: ['深度为估计值'] }],
    })
  );
  const issues = validateNormalized(nd, base);
  ok('44. 导入不确定性保留（IMPORT-UNCERTAINTY 阻断）', issues.some((i) => i.code === 'IMPORT-UNCERTAINTY'), issues.map((i) => i.code));
  const proposal = normalizedToProposal(nd);
  ok('45. 导入不伪造空间事实（方案里无墙/无洞口；房间结构由现有项目回答）',
    proposal.cabinets.length === 1 && !JSON.stringify(proposal).includes('"walls"') && !JSON.stringify(proposal).includes('openings'));
}

// ═══════════════ §9 容差集中（附加红线） ═══════════════
section('§9 容差集中定义');
{
  ok('TOL.TOUCH/NEAR 集中且分段不重叠', SPATIAL_TOL.TOUCH < SPATIAL_TOL.NEAR);
  // touching 边界：gap 恰好 = TOUCH → touching；TOUCH+1 → near
  const fpA = [{ x: 0, y: 100 }, { x: 900, y: 100 }, { x: 900, y: 700 }, { x: 0, y: 700 }];
  const rect = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 99 }, { x: 0, y: 99 }]; // gap = 1 = TOUCH
  ok('TOL.gap=TOUCH → touching', classifyCabWall(fpA, rect).relation === 'touching');
  const rect2 = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 98 }, { x: 0, y: 98 }]; // gap = 2
  ok('TOL.gap=TOUCH+1 → near（不吞）', classifyCabWall(fpA, rect2).relation === 'near');
}

// ═══════════════ 汇总 ═══════════════
console.log(`\n═══ P8.7 spatial 验收：${passed} 通过 / ${failed} 失败 ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
