/**
 * 玻璃门材质 / 清单分流 / 五金目录验收（Phase C）。
 *
 * 承诺的是：
 *   1. `doors.material` 是语义字段：docFactory 显式补默认（不留隐式回退），
 *      CommandBus 白名单放行，未知材质 ID 报 WARNING 不静默吞；
 *   2. 清单分流：kind='glass' 的门板**不进** panels / 开料统计，
 *      进 purchased（甲购件）—— 玻璃不走开料机；
 *   3. 门板图：玻璃门画低透明填充 + 45° 斜线（黑框灰玻，销售图纸同款），
 *      斜线只表示材质（|dx|==|dy|，与开向对角线 dx≠dy 可区分）；内部图不画；
 *   4. `shelves.ledStrip` 语义字段 → 五金自动出 HW_LED_*，规格含安装位。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Cabinet, RuleSet } from '../src/core/types.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { generateCabinet } from '../src/core/geometry/generate.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { toNeutralExport } from '../src/export/neutralSheet.ts';
import { CommandBus } from '../src/core/commandBus.ts';

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

const GLASS_ID = 'M_GLASS_8_GREY';
const clone = (c: Cabinet): Cabinet => JSON.parse(JSON.stringify(c)) as Cabinet;
const TOL = 0.5;

// ── 公共夹具：样例项目 + 门/层板分区索引 ──
const baseCab = sampleProject(rules).cabinets[0]!;
const doorIdx = baseCab.layout.units.findIndex((u) => u.doors);
const shelfIdx = baseCab.layout.units.findIndex((u) => u.shelves);
if (doorIdx < 0 || shelfIdx < 0) throw new Error(`样例项目夹具失效：doorIdx=${doorIdx} shelfIdx=${shelfIdx}`);
const doorUnit = baseCab.layout.units[doorIdx]!;
const nDoors = doorUnit.doors!.count;

section('1. 数据模型：默认显式、规则集齐备、白名单放行');
{
  ok(`docFactory 门板材质显式补齐（= ${doorUnit.doors!.material}）`, typeof doorUnit.doors!.material === 'string' && doorUnit.doors!.material.length > 0);
  ok('默认门板材质是规则集里最厚的 board 材质（门板要刚度）', (() => {
    const boards = Object.entries(rules.materials).filter(([, m]) => m.kind === 'board').sort((a, b) => b[1].thickness - a[1].thickness);
    return doorUnit.doors!.material === boards[0]![0];
  })(), doorUnit.doors!.material);
  const g = rules.materials[GLASS_ID];
  ok(`规则集有玻璃材质 ${GLASS_ID}（kind=glass, 8mm）`, !!g && g.kind === 'glass' && g.thickness === 8, JSON.stringify(g));
  ok('五金目录含反弹器 / 灯带三安装位 / 拉篮', ['HW_DAMPER', 'HW_LED_CENTER', 'HW_LED_FRONT', 'HW_LED_ANGLED45', 'HW_BASKET'].every((id) => !!rules.hardware[id]),
    Object.keys(rules.hardware).join(','));

  // 白名单用独立总线验证，不污染后面的夹具
  const wb = new CommandBus(sampleProject(rules), rules);
  const v0 = wb.getVersion();
  const cab = wb.getState().cabinets[0]!;
  const r1 = wb.execute({ id: 'g1', op: 'cabinet.layout', source: 'ui', target: { kind: 'cabinet', id: cab.id }, changes: [{ path: `layout.units[${doorIdx}].doors.material`, op: 'set', value: GLASS_ID }] }, '试改玻璃');
  const r2 = wb.execute({ id: 'g2', op: 'cabinet.layout', source: 'ui', target: { kind: 'cabinet', id: cab.id }, changes: [{ path: `layout.units[${shelfIdx}].shelves.ledStrip`, op: 'set', value: 'front' }] }, '试改灯带');
  ok('白名单放行 doors.material 与 shelves.ledStrip（两条都执行、版本推进）',
    wb.getVersion() === v0 + 2 && !r1.error && !r2.error,
    `version=${wb.getVersion()} r1=${JSON.stringify(r1.error)} r2=${JSON.stringify(r2.error)}`);
  ok('undo 逐条撤销：撤到底后玻璃材质回默认（写入走总线，可回退）', (() => {
    wb.undo();
    wb.undo();
    const u = wb.getState().cabinets[0]!.layout.units[doorIdx]!.doors!;
    return u.material === doorUnit.doors!.material && wb.getState().cabinets[0]!.layout.units[shelfIdx]!.shelves!.ledStrip === 'none';
  })());
}

section('2. 清单分流：玻璃不进开料，进甲购');
{
  const wood = generateCabinet(baseCab, rules);
  const woodDoors = wood.panels.filter((p) => p.role === 'DoorPanel');
  ok('木门柜：门板在 panels，厚度 = 材质定义厚度（18）', woodDoors.length === nDoors && woodDoors.every((p) => p.thickness === 18 && p.material === doorUnit.doors!.material),
    `panels=${woodDoors.length} doorDef=${doorUnit.doors!.material}`);
  ok('木门柜：purchased 为空', wood.purchased.length === 0);

  const glassCab = clone(baseCab);
  glassCab.layout.units[doorIdx]!.doors!.material = GLASS_ID;
  const glass = generateCabinet(glassCab, rules);
  ok('玻璃门柜：panels 里没有门板（玻璃不走开料机）', glass.panels.filter((p) => p.role === 'DoorPanel').length === 0,
    JSON.stringify(glass.panels.map((p) => p.role)));
  ok(`玻璃门柜：purchased 有 ${nDoors} 件玻璃门`, glass.purchased.length === nDoors, JSON.stringify(glass.purchased));
  const pc = glass.purchased[0]!;
  ok('玻璃甲购件规格可下单（尺寸 + 8mm 厚 + 黑框灰玻工艺）', pc.kind === 'glassDoor' && pc.material === GLASS_ID && pc.spec.includes('8mm') && pc.spec.includes('铝合金框') && pc.spec.includes('黑框灰玻'),
    pc.spec);
  ok('玻璃甲购件归属到分区（belongsTo = 柜.分区）', glass.purchased.every((x) => x.belongsTo.startsWith(glassCab.id)), JSON.stringify(glass.purchased.map((x) => x.belongsTo)));
  ok('玻璃门不进板件统计（stats 面积 < 木门柜：少了 nDoors 块门板）', glass.stats.boardAreaM2 < wood.stats.boardAreaM2,
    `glass=${glass.stats.boardAreaM2} wood=${wood.stats.boardAreaM2}`);
}

section('3. 未知材质：报 WARNING，不静默吞');
{
  const bad = clone(baseCab);
  bad.layout.units[doorIdx]!.doors!.material = 'M_NOT_EXIST';
  const g = generateCabinet(bad, rules);
  const warn = g.issues.find((i) => i.code === 'RULE-DOOR-MATERIAL');
  ok('未知材质 ID 产出 RULE-DOOR-MATERIAL WARNING', !!warn && warn.severity === 'WARNING', JSON.stringify(g.issues.map((i) => i.code)));
  ok('回退到柜体板材并照常出板（不整柜失败）', g.panels.filter((p) => p.role === 'DoorPanel').length === nDoors && g.purchased.length === 0);
}

section('4. 门板图：黑框灰玻斜线填充');
{
  const glassCab = clone(baseCab);
  glassCab.layout.units[doorIdx]!.doors!.material = GLASS_ID;
  const R = buildCabinetViews(glassCab, rules);
  const woodR = buildCabinetViews(baseCab, rules);
  const is45 = (dx: number, dy: number): boolean => Math.abs(Math.abs(dx) - Math.abs(dy)) < TOL && Math.abs(dx) > 1;

  const glassFills = R.prims.front.filter((p) => p.k === 'fill');
  const woodFills = woodR.prims.front.filter((p) => p.k === 'fill');
  ok('玻璃门正视图有填充图元（灰玻低透明）', glassFills.length >= 1, `fills=${glassFills.length}`);
  ok('木门正视图没有填充（对比成立）', woodFills.length === 0, `fills=${woodFills.length}`);

  // 45° 斜线：2 点开放 poly 且 |dx|==|dy|（开向对角线 dx≠dy：门宽≠门高）
  const hatchGlass = R.prims.front.filter((p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && is45(p.pts[1]!.x - p.pts[0]!.x, p.pts[1]!.y - p.pts[0]!.y));
  const hatchWood = woodR.prims.front.filter((p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && is45(p.pts[1]!.x - p.pts[0]!.x, p.pts[1]!.y - p.pts[0]!.y));
  /**
   * ★ 口径已改（2026-10-21）——
   *
   *   旧断言：「每扇 2 道，共 4 道」。
   *   那是**上一版自己发明的画法**（两道短斜线），不是参考图纸的画法。
   *
   *   参考图纸的实测（PDF 内容流）：玻璃门是**满铺的 45° 等距平行线**，
   *   每条被门板矩形裁剪（所以长度不同，但 dx 严格等于 dy），
   *   间距中位数 = 板宽的 8.3%。
   *
   *   满铺之后条数取决于门宽与间距，不是固定值 ——
   *   所以断言改成「**很多条** + **都严格 45°**」。
   */
  ok(`玻璃门正视图有满铺 45° 斜线（>20 条，实测 ${hatchGlass.length}）`, hatchGlass.length > 20, `hatch=${hatchGlass.length}`);
  /**
   * 每条都必须是**严格的 45°**（|dx| == |dy|）。
   * 这条断言是本轮的关键：
   *   第一版实现画的是「左下角到右上角再 clamp」，dx=288 dy=2280 —— 根本不是 45°，
   *   而且因为不满足 is45，筛查根本认不出来（画了 43 条却报 0 条）。
   */
  const non45 = hatchGlass.filter((p) => !is45(p.pts[1]!.x - p.pts[0]!.x, p.pts[1]!.y - p.pts[0]!.y));
  ok('★ 每条玻璃斜线都是严格的 45°（|dx| == |dy|）', non45.length === 0, `${non45.length} 条不是 45 度`);
  ok('木门没有 45° 斜线', hatchWood.length === 0, `hatch=${hatchWood.length}`);

  // 斜线端点全部在门洞矩形内（正视图局部坐标：origin 平移回去）
  const fx = R.meta.front.origin.x;
  const fy = R.meta.front.origin.y;
  const Lg = computeCabinetLayout(glassCab, rules);
  const t = Lg.boardT;
  // 正视图局部 y 从柜体底部（含 bodyLift 离地）起算：内空 y ∈ [bodyLift+t+gap, bodyLift+t+innerH-gap]
  const innerY0 = glassCab.params.bodyLift + t + doorUnit.doors!.gapOuter;
  const innerY1 = glassCab.params.bodyLift + t + Lg.innerH - doorUnit.doors!.gapOuter;
  const ux0 = Lg.unitX0[doorIdx]!;
  const netW = Lg.nets[doorIdx]!;
  const gapOuter = doorUnit.doors!.gapOuter;
  const inRect = (x: number, y: number): boolean =>
    x >= ux0 + gapOuter - TOL && x <= ux0 + netW - gapOuter + TOL && y >= innerY0 - TOL && y <= innerY1 + TOL;
  ok('斜线端点全部落在门洞内（矩形内截断不越界）',
    hatchGlass.every((p) => p.pts.every((q) => inRect(q.x - fx, q.y - fy))),
    JSON.stringify(hatchGlass.map((p) => p.pts.map((q) => [Math.round(q.x - fx), Math.round(q.y - fy)]))));

  // 内部图：玻璃也只画结构，无填充无斜线
  // 内部图：玻璃也只画结构。注意内部图本来就有一层背板背景填充（层=背板层），
  // 要断言的是"没有门板图层的材质填充"，不是"图上没有 fill"。
  const innerHatch = R.prims.internal.filter((p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && is45(p.pts[1]!.x - p.pts[0]!.x, p.pts[1]!.y - p.pts[0]!.y));
  ok('内部图不画玻璃填充与斜线（结构图无材质表达）',
    !R.prims.internal.some((p) => p.k === 'fill' && p.layer === 'F-CAB-FRONT') && innerHatch.length === 0,
    `frontLayerFills=${R.prims.internal.filter((p) => p.k === 'fill' && p.layer === 'F-CAB-FRONT').length} hatch=${innerHatch.length}`);
}

section('5. ledStrip：语义字段 → 五金派生');
{
  const ledCab = clone(baseCab);
  const shelfCount = ledCab.layout.units[shelfIdx]!.shelves!.count;
  ok('shelves.ledStrip 显式默认 none（不走"字段缺失"表达状态）', ledCab.layout.units[shelfIdx]!.shelves!.ledStrip === 'none');
  ledCab.layout.units[shelfIdx]!.shelves!.ledStrip = 'front';
  const g1 = generateCabinet(ledCab, rules);
  const led1 = g1.hardware.find((h) => h.kind === 'ledStrip');
  ok('ledStrip=front 派生 LED 五金，数量 = 层板数', !!led1 && led1.qty === shelfCount, JSON.stringify(led1));
  ok('LED 规格含安装位（贴前沿）与长度', !!led1 && led1.spec.includes('贴前沿') && /L=\d+mm/.test(led1.spec), led1?.spec ?? '');

  ledCab.layout.units[shelfIdx]!.shelves!.ledStrip = 'angled45';
  const g2 = generateCabinet(ledCab, rules);
  ok('ledStrip=angled45 规格映射 45° 斜光灯带', g2.hardware.find((h) => h.kind === 'ledStrip')?.spec.includes('45°') === true);

  ledCab.layout.units[shelfIdx]!.shelves!.ledStrip = 'center';
  const g3 = generateCabinet(ledCab, rules);
  ok('ledStrip=center 规格映射居中灯带', g3.hardware.find((h) => h.kind === 'ledStrip')?.spec.includes('居中') === true);

  const g0 = generateCabinet(baseCab, rules);
  ok('未设 ledStrip 的柜子不出 LED 五金', g0.hardware.every((h) => h.kind !== 'ledStrip'));
}

section('6. 中立导出：purchased 一路走到交换格式');
{
  const glassCab = clone(baseCab);
  glassCab.layout.units[doorIdx]!.doors!.material = GLASS_ID;
  const project = sampleProject(rules);
  project.cabinets[0] = glassCab;
  const n = toNeutralExport(project, rules, [], 'test-v1');
  ok('neutralExport.panels 不含玻璃门', n.panels.every((p) => rules.materials[p.material]?.kind !== 'glass'));
  ok(`neutralExport.purchased 含玻璃门（数量=${nDoors}）`, n.purchased.length === nDoors && n.purchased.every((x) => x.kind === 'glassDoor'),
    JSON.stringify(n.purchased.map((x) => x.id)));
  const panelPieces = Object.values(generateCabinet(glassCab, rules).panels).reduce((a, p) => a + p.qty, 0);
  ok('开料统计不受玻璃影响（totalPieces 只数板件）', n.stats.totalPieces === panelPieces,
    `stats=${n.stats.totalPieces} direct=${panelPieces}`);
}

console.log(`\n═══ 玻璃门 / 分流 / 五金：通过 ${pass} 项，失败 ${fail} 项 ═══`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
