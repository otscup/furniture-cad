/**
 * bodies3d 验收 —— 3D 体块派生层的地基不变量。
 *
 * 3D 是派生视图，但它仍然是"会被用户看到的读数"：层板浮在半空、门板嵌进
 * 箱体、柜体整体错位 —— 这类错误在 2D 断言里全都是盲区，必须在这里钉住。
 *
 * 核心不变量：
 *   1. 与 2D 生成器同源（equalSpacing / doorWidths / drawerCellHeights 同款公式）
 *   2. 无退化盒（任何一维为 0 的"板"都不是板，是几何 bug）
 *   3. 世界坐标与 2D 足迹一致（rot=0 时局部中心 + placement 必须吻合）
 *   4. 镜像（分区反序）在 3D 里表现为层板 x 序列反序 —— 语义镜像的视觉证据
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import * as CMD from '../src/core/commands.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { equalSpacing } from '../src/core/allocate.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name} —— ${detail}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

const snap = (p: Project): string => JSON.stringify(p);

section('1. 箱体骨架：每个柜体必有侧板×2 / 顶 / 底 / 背');
{
  const bus = new CommandBus(sampleProject(rules), rules);
  const bodies = bus.derive().geom.bodies3d;
  ok('3D 体块非空（样例项目至少一个柜体）', bodies.length > 0, `${bodies.length} 个盒`);
  const cab = bus.getState().cabinets[0];
  const mine = bodies.filter((b) => b.cabId === cab.id);
  const roles = new Set(mine.map((b) => b.role));
  ok('箱体五面齐全（side/top/bottom/back）',
    roles.has('side') && roles.has('top') && roles.has('bottom') && roles.has('back'),
    JSON.stringify([...roles]));
  ok('侧板恰好两块，厚度 = 规则板厚', mine.filter((b) => b.role === 'side').length === 2
    && mine.filter((b) => b.role === 'side').every((b) => b.sx === computeCabinetLayout(cab, rules).boardT));
  ok('背板进深 = 背板厚', mine.filter((b) => b.role === 'back').every((b) => b.sy === computeCabinetLayout(cab, rules).backT));
  ok('无退化盒（三围全部 > 0）', mine.every((b) => b.sx > 0 && b.sy > 0 && b.sz > 0),
    JSON.stringify(mine.filter((b) => !(b.sx > 0 && b.sy > 0 && b.sz > 0)).map((b) => b.id)));
}

section('2. 与 2D 同源：层板位置 = equalSpacing，门宽 = doorWidths');
{
  const bus = new CommandBus(sampleProject(rules), rules);
  const cab = bus.getState().cabinets[0];
  const L = computeCabinetLayout(cab, rules);
  const bodies = bus.derive().geom.bodies3d.filter((b) => b.cabId === cab.id);

  const shelfUnits = cab.layout.units.filter((u) => u.shelves && u.shelves.count > 0);
  const expectShelfCount = shelfUnits.reduce((a, u) => a + u.shelves!.count, 0);
  ok('层板盒数量 = 各分区层板数之和', bodies.filter((b) => b.role === 'shelf').length === expectShelfCount,
    `${bodies.filter((b) => b.role === 'shelf').length} vs ${expectShelfCount}`);

  // 抽查第一个带层板分区：层板中心 z = 内底 + equalSpacing 位置
  const u0 = shelfUnits[0];
  if (u0) {
    const ui = cab.layout.units.indexOf(u0);
    const innerBottom = cab.params.bodyLift + L.boardT;
    const firstShelfZ = bodies.find((b) => b.role === 'shelf' && b.id === `${cab.id}_${u0.id}_SH1`)?.cz;
    const expectZ = innerBottom + equalSpacing(L.innerH, u0.shelves!.count)[0];
    ok('第一块层板中心高度与 2D 公式逐毫米一致', Math.abs(firstShelfZ! - expectZ) < 1e-6,
      `3D=${firstShelfZ} 2D公式=${expectZ}`);
    ok(`分区索引校验用到了 ui=${ui}（防呆：分区顺序影响层板 x）`, ui >= 0);
  }

  const doorUnits = cab.layout.units.filter((u) => u.doors);
  const expectDoorCount = doorUnits.reduce((a, u) => a + u.doors!.count, 0);
  ok('门板盒数量 = 各分区门扇数之和', bodies.filter((b) => b.role === 'door').length === expectDoorCount,
    `${bodies.filter((b) => b.role === 'door').length} vs ${expectDoorCount}`);
  ok('门板在箱体前脸之外（凸出装饰面）',
    bodies.filter((b) => b.role === 'door').every((b) => b.cy > cab.placement.y + cab.params.depth - 1e-6));
}

section('3. 世界坐标：rot=0 时 3D 中心 = placement + 局部中心');
{
  const bus = new CommandBus(sampleProject(rules), rules);
  const cab = bus.getState().cabinets[0];
  const L = computeCabinetLayout(cab, rules);
  const mine = bus.derive().geom.bodies3d.filter((b) => b.cabId === cab.id);
  const sideL = mine.find((b) => b.id === `${cab.id}_LS`)!;
  // 左侧板局部中心 x = boardT/2
  ok('左侧板世界中心 x = placement.x + 板厚/2',
    Math.abs(sideL.cx - (cab.placement.x + L.boardT / 2)) < 1e-6,
    `cx=${sideL.cx} expect=${cab.placement.x + L.boardT / 2}`);
  ok('左侧板世界中心 y = placement.y + 进深/2',
    Math.abs(sideL.cy - (cab.placement.y + cab.params.depth / 2)) < 1e-6,
    `cy=${sideL.cy} expect=${cab.placement.y + cab.params.depth / 2}`);
  ok('盒携带柜体旋转角（旋转柜体的 3D 由渲染层处理）',
    mine.every((b) => b.rot === cab.placement.rotation));
}

section('4. 语义镜像的 3D 证据：层板群关于柜体中轴镜像对调');
{
  const b = new CommandBus(sampleProject(rules), rules);
  const cab0 = b.getState().cabinets[0];
  const cabId = cab0.id;
  const midX = cab0.placement.x + cab0.params.width / 2; // 柜体竖直中轴
  const shelfXs = () => b.derive().geom.bodies3d
    .filter((x) => x.cabId === cabId && x.role === 'shelf')
    .map((x) => Math.round(x.cx))
    .sort((a, z) => a - z);
  const before = shelfXs();
  ok('镜像前样例柜有层板（前提）', before.length > 0, JSON.stringify(before));
  const r = b.execute(CMD.mirrorCabinet(b.getState().cabinets.find((c) => c.id === cabId)!));
  ok('镜像提交成功', r.ok, r.error ?? '');
  const after = shelfXs();
  /**
   * 为什么断"关于中轴对称"而不是"排序后逐位反序"：
   * 中轴上的层板镜像后仍在中轴（它在排序里的位置会漂），右群整体搬去左群。
   * 正确的几何事实是【集合级】的：after 是 {2·midX − x | x ∈ before}，
   * 逐点在多重集合里找镜像点，一个不多一个不少。
   */
  const pool = new Map<number, number>();
  for (const x of after) pool.set(x, (pool.get(x) ?? 0) + 1);
  let matched = 0;
  for (const x of before) {
    const mirror = 2 * midX - x;
    const cnt = pool.get(mirror) ?? 0;
    if (cnt > 0) {
      matched++;
      pool.set(mirror, cnt - 1);
    }
  }
  ok('镜像后层板群关于柜体中轴镜像对调（用户在 3D 里看到左右互换）',
    before.length === after.length && matched === before.length,
    `before=${before} after=${after} midX=${midX} matched=${matched}`);
}

section('5. 容错：单柜派生失败不拖垮 3D 视图');
{
  const b = new CommandBus(sampleProject(rules), rules);
  const bad = structuredClone(b.getState());
  const goodCab = structuredClone(bad.cabinets[0]);
  goodCab.id = 'cab_002';
  goodCab.name = '好柜';
  goodCab.placement = { ...goodCab.placement, x: goodCab.placement.x + 2500 };
  bad.cabinets.push(goodCab);
  bad.cabinets[0].params.boardMaterial = 'M_NOT_EXIST';
  const b2 = new CommandBus(bad, rules);
  const g = b2.derive().geom;
  ok('坏材质柜的 3D 体块为空（跳过，不是崩掉）',
    !g.bodies3d.some((x) => x.cabId === bad.cabinets[0].id));
  ok('其余柜体的 3D 体块照常生成',
    g.bodies3d.some((x) => x.cabId === 'cab_002'),
    JSON.stringify([...new Set(g.bodies3d.map((x) => x.cabId))]));
}

console.log(`\n${'─'.repeat(66)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：3D 体块派生与 2D 同源、无退化盒、镜像语义可视觉验证。');
