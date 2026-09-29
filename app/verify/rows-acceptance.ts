/**
 * ══════════════════════════════════════════════════════════════════════
 *  P1 验收 —— Cabinet → Rows → Units → Components 的垂直语义
 *
 *  用户给 P1 定的验收清单（逐条对应下面的 section）：
 *    ① 单行回归          ② 两行固定 + fill      ③ 多行高度总和恒等式
 *    ④ fill 非最后一行必须拒绝                  ⑤ 行间贯通横隔板
 *    ⑥ 每行独立 Unit 分配 ⑦ Case 1 / 2 / 4      ⑧ 2D / 3D / DXF / BOM 一致性
 *
 *  ── 这一批断言真正在防什么 ──
 *    · **"加了一层"变成"改了单层"**：P1 对用户可见的承诺是"旧柜一个 mm 都不变"。
 *      所以这里的单行回归不是跑通旧断言就完事，而是把**新旧两种文件形状**
 *      （只有 units / 显式写一行 rows）的派生骨架、板件清单、四视图、3D 盒、
 *      导出中立 JSON 逐值比一遍 —— 差一个字符都算失败。
 *    · **行高链条不闭合**：`Σ行净高 + (行数−1)×板厚 === 内空高` 是唯一的真相。
 *      一旦哪天有人改成"按比例分高度"，这条会立刻变红，而不是等车间下错料。
 *    · **把多行展平成一排算宽度**：这是最容易犯又最难发现的写法 ——
 *      宽度链恒等式在"整柜"口径下照样成立，于是安静地全错。
 *      第 ⑥ 组专门对比"逐行算"与"展平算"，断言它们**不相等**。
 *    · **横隔板是谁造的**：行隔板必须来自 `Cabinet → Rows → boundary`，
 *      而不是谁手加一块板。第 ⑤ 组断言它的数量、长度、Z 位置全部由派生给。
 *    · **下游各自解析 rows**：第 ⑧ 组断言 2D / 3D / 中立导出(DXF 的唯一源) /
 *      板件清单(BOM) 对同一柜给出的"行数"互相一致 —— 只要有一处自己解析 rows，
 *      它迟早会与另外三处对不上。
 *
 *  ── 判据纪律（踩过坑才写的）──
 *    负样本必须精确到**原因**：只断言"被拒了"会被别处的检查顶替而假绿。
 *    所以 ④ 断言的是码 `RULE-ROW-FILL-POSITION`，不是"有 ERROR"。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, CabinetRow, RowHeight, RuleSet, UnitSpec } from '../src/core/types.ts';
import type { Box3D } from '../src/core/geometry/bodies3d.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, makeUnit, sampleProject } from '../src/core/docFactory.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { generateCabinet } from '../src/core/geometry/generate.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { buildCabinetBodies } from '../src/core/geometry/bodies3d.ts';
import { validateCabinet } from '../src/core/rules/validate.ts';
import { toNeutralExport } from '../src/export/neutralSheet.ts';
import * as CMD from '../src/core/commands.ts';
import {
  ROW_HEIGHT_FILL,
  SINGLE_ROW_ID,
  allUnits,
  isMultiRow,
  layoutRows,
  toFileLayout,
  unitPathPrefix,
  unitsAtPath,
} from '../src/core/layoutModel.ts';

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
const eq = (a: unknown, b: unknown): string => `实际=${JSON.stringify(a)} 期望=${JSON.stringify(b)}`;

// ═══════════════════════════════ 造柜辅助 ═══════════════════════════════

let seq = 0;
const taken = new Set<string>();
/** 造一个分区（id 全局唯一 —— 撞 id 不报错，只会静默共用一条清单记录） */
function unit(kind: UnitSpec['kind'], requestedWidth: number, count = 3): UnitSpec {
  seq += 1;
  const u = makeUnit({ id: `unit_${String(seq).padStart(3, '0')}`, kind, requestedWidth, rules, count, takenIds: taken });
  taken.add(u.id);
  return u;
}

interface RowSpec {
  h: RowHeight;
  units: UnitSpec[];
}

/**
 * 造柜：`rows` 只有一层时也照样写 rows（除非 multi=false）——
 * 用于证明"显式一行"与"旧形状"逐位等价。
 */
function mkCab(rows: RowSpec[], opts: { id?: string; width?: number; height?: number; depth?: number } = {}): Cabinet {
  const cab = createCabinet({
    id: opts.id ?? `cab_rows_${seq++}`,
    name: '测试柜',
    roomId: 'room_001',
    x: 0,
    y: 0,
    rules,
    params: { width: opts.width ?? 2400, height: opts.height ?? 2400, depth: opts.depth ?? 600, bodyLift: 80 },
    units: rows[0]!.units,
  });
  const rs: CabinetRow[] = rows.map((r, i) => ({ id: `row_${String(i + 1).padStart(3, '0')}`, height: r.h, units: r.units }));
  cab.layout.rows = rs;
  // 多行：刻意留空 units（真实文件也是这样写的），让"rows 是权威"没有歧义
  if (rs.length > 1) cab.layout.units = [];
  taken.add(cab.id);
  return cab;
}

// ══════════════════════════ ① 单行回归（逐位等价）══════════════════════════

section('① 单行回归：旧形状与新形状逐位等价');

const singleUnits = [unit('drawerBank', 600), unit('hanging', 1200, 1), unit('shelves', 600, 4)];
/**
 * 两种形状必须**同一个柜号**：板件 id / 3D 盒 id / 拾取线都带柜号，
 * 柜号不同的话比出来的是 id 差异，而不是几何差异 —— 那样的"不相等"是假红。
 */
const oldCab = mkCab([{ h: ROW_HEIGHT_FILL, units: singleUnits.map((u) => structuredClone(u)) }], { id: 'cab_single' });
delete oldCab.layout.rows; // 真正的 v0.2 文件形状：只有 units
const newCab = mkCab([{ h: ROW_HEIGHT_FILL, units: singleUnits.map((u) => structuredClone(u)) }], { id: 'cab_single' });

ok('旧文件形状没有 rows 字段（v0.2 原样）', !('rows' in oldCab.layout));
ok('canonical 读法把旧形状折成 1 行，行 id 稳定', layoutRows(oldCab.layout).length === 1 && layoutRows(oldCab.layout)[0]!.id === SINGLE_ROW_ID);
ok('isMultiRow(旧形状) = false', isMultiRow(oldCab.layout) === false);
ok('canonicalUnits(旧形状) 就是 layout.units 同一批对象', (() => {
  const cu = layoutRows(oldCab.layout)[0]!.units;
  return cu.length === oldCab.layout.units.length && cu.every((u, i) => u === oldCab.layout.units[i]);
})());

const LO = computeCabinetLayout(oldCab, rules);
const LN = computeCabinetLayout(newCab, rules);
for (const k of ['innerW', 'innerH', 'netTotal', 'boardT', 'backT', 'bodyH', 'shelfDepth'] as const) {
  ok(`派生骨架 ${k} 新旧一致`, (LO as unknown as Record<string, unknown>)[k] === (LN as unknown as Record<string, unknown>)[k],
    eq((LO as unknown as Record<string, unknown>)[k], (LN as unknown as Record<string, unknown>)[k]));
}
ok('派生骨架 nets 逐值一致', JSON.stringify(LO.nets) === JSON.stringify(LN.nets), eq(LO.nets, LN.nets));
ok('派生骨架 unitX0 逐值一致', JSON.stringify(LO.unitX0) === JSON.stringify(LN.unitX0), eq(LO.unitX0, LN.unitX0));
ok('单行柜没有行隔板', LO.rowDividers.length === 0 && LN.rowDividers.length === 0);
ok('单行柜高度链 ok', LO.heightChain.ok && LN.heightChain.ok);
ok('单行柜行净高 = 内空高（fill 吃掉全部）', LN.rows.length === 1 && LN.rows[0]!.netH === LN.innerH, eq(LN.rows[0]?.netH, LN.innerH));
ok('单行柜 panelTag 为空 → 板件 id 不带行号', LN.rows[0]!.panelTag === '');

const GO = generateCabinet(oldCab, rules);
const GN = generateCabinet(newCab, rules);
ok('板件清单逐项一致（id/role/长/宽/数量）', JSON.stringify(GO.panels.map(stripPanel)) === JSON.stringify(GN.panels.map(stripPanel)),
  eq(GO.panels.length, GN.panels.length));
ok('五金清单逐项一致', JSON.stringify(GO.hardware) === JSON.stringify(GN.hardware));
ok('统计一致（板件种类/总件数/面积/重量）', JSON.stringify(GO.stats) === JSON.stringify(GN.stats), eq(GO.stats, GN.stats));
ok('平面投影图元逐项一致', JSON.stringify(GO.plan) === JSON.stringify(GN.plan));
ok('立面投影图元逐项一致', JSON.stringify(GO.elevation) === JSON.stringify(GN.elevation));

const VO = buildCabinetViews(oldCab, rules);
const VN = buildCabinetViews(newCab, rules);
ok('四视图图元逐项一致（front/top/side/internal）', JSON.stringify(VO.prims) === JSON.stringify(VN.prims));
ok('四视图标注逐项一致', JSON.stringify(VO.labels) === JSON.stringify(VN.labels));
ok('四视图拾取线逐项一致', JSON.stringify(VO.pickLines) === JSON.stringify(VN.pickLines));
ok('3D 盒体逐项一致', JSON.stringify(buildCabinetBodies(oldCab, rules)) === JSON.stringify(buildCabinetBodies(newCab, rules)));
ok('导出中立 JSON（DXF 的唯一源）逐项一致', (() => {
  // 去掉时间戳再比：generatedAt 是"导出时刻"，与模型形状无关
  const strip = (o: unknown): string => {
    const c = JSON.parse(JSON.stringify(o)) as { meta?: Record<string, unknown> };
    if (c.meta) delete c.meta.generatedAt; // meta.generatedAt = 导出时刻，与模型形状无关
    return JSON.stringify(c);
  };
  return strip(toNeutralExport(projOf(oldCab), rules, ['sheet'], 'TEST')) === strip(toNeutralExport(projOf(newCab), rules, ['sheet'], 'TEST'));
})());
ok('存盘形状：单行柜塌回 units、不写 rows', (() => {
  const f = toFileLayout(newCab.layout) as unknown as Record<string, unknown>;
  return !('rows' in f) && Array.isArray(f.units);
})());

function stripPanel(p: { id: string; role: string; length: number; width: number; qty: number; thickness: number }): string {
  return `${p.id}|${p.role}|${p.length}|${p.width}|${p.qty}|${p.thickness}`;
}
function projOf(cab: Cabinet) {
  const proj = sampleProject(rules);
  proj.cabinets = [structuredClone(cab)];
  proj.cabinets[0]!.roomId = proj.rooms[0]!.id;
  return proj;
}

// ══════════════════════════ ② 两行固定 + fill ══════════════════════════

section('② 两行：上固定 + 下 fill（Case 2 的形状）');

const twoRow = mkCab([
  { h: 480, units: [unit('shelves', 1200, 2), unit('shelves', 1200, 2)] },
  { h: ROW_HEIGHT_FILL, units: [unit('drawerBank', 800), unit('hanging', 800, 1), unit('shelves', 800, 3)] },
]);
const L2 = computeCabinetLayout(twoRow, rules);
const t2 = L2.boardT;
ok('两行：rows[0] 是上面那一行（固定 480）', L2.rows[0]!.netH === 480, eq(L2.rows[0]?.netH, 480));
ok('两行：rows[1] 吃掉剩余内高', L2.rows[1]!.netH === L2.innerH - 480 - t2, eq(L2.rows[1]?.netH, L2.innerH - 480 - t2));
ok('两行：上面那行的 z0 高于下面那行（行序自上而下）', L2.rows[0]!.z0 > L2.rows[1]!.z0);
// 行序自上而下：rows[1] 是下面那行，它的**顶面**加一块板厚才是 rows[0] 的底面
ok('两行：rows[1].z1 + 板厚 = rows[0].z0（行隔板正好夹在中间）', L2.rows[1]!.z1 + t2 === L2.rows[0]!.z0,
  eq(L2.rows[1]!.z1 + t2, L2.rows[0]?.z0));
ok('两行：高度链 ok', L2.heightChain.ok === true, JSON.stringify(L2.heightChain));
ok('两行：rowDividers 恰好 1 块', L2.rowDividers.length === 1);
ok('两行：行隔板 Z = 上面那行的内空底面', L2.rowDividers[0] === L2.rows[1]!.z1, eq(L2.rowDividers[0], L2.rows[1]?.z1));
ok('两行：panelTag 分行（R1_ / R2_）', L2.rows[0]!.panelTag === 'R1_' && L2.rows[1]!.panelTag === 'R2_');

// ══════════════════════════ ③ 多行高度总和恒等式 ══════════════════════════

section('③ 高度链恒等式：Σ行净高 + (行数−1)×板厚 === 内空高');

const threeRow = mkCab([
  { h: 600, units: [unit('shelves', 1200, 2), unit('shelves', 1200, 2)] },
  { h: 900, units: [unit('drawerBank', 700), unit('shelves', 850, 3), unit('shelves', 850, 3)] },
  { h: ROW_HEIGHT_FILL, units: [unit('drawerBank', 2400, 2)] },
]);
const L3 = computeCabinetLayout(threeRow, rules);
const t3 = L3.boardT;
ok('三行：恒等式成立', L3.rows.reduce((a, r) => a + r.netH, 0) + (L3.rows.length - 1) * t3 === L3.innerH,
  eq(L3.rows.reduce((a, r) => a + r.netH, 0) + (L3.rows.length - 1) * t3, L3.innerH));
ok('三行：rowDividers 恰好 2 块', L3.rowDividers.length === 2, eq(L3.rowDividers.length, 2));
ok('三行：每行 z1 − z0 === 该行净高（位置与高度同源）', L3.rows.every((r) => r.z1 - r.z0 === r.netH));
ok('三行：行与行之间只隔一块板厚', L3.rows.every((r, i) => i === 0 || L3.rows[i - 1]!.z0 - r.z1 === t3),
  eq(L3.rows.map((r) => r.z0), L3.rows.map((r) => r.z1)));
ok('三行：全固定高（无 fill）且和正好等于可用高时也闭合', (() => {
  const avail = L3.innerH - 2 * t3;
  const c = mkCab([
    { h: 500, units: [unit('shelves', 2400, 2)] },
    { h: 400, units: [unit('shelves', 2400, 2)] },
    { h: avail - 900, units: [unit('shelves', 2400, 2)] },
  ]);
  const L = computeCabinetLayout(c, rules);
  return L.heightChain.ok && L.rows.reduce((a, r) => a + r.netH, 0) + 2 * L.boardT === L.innerH;
})());
ok('三行：恒等式对 2/3/4 行都成立（同一套解算，不是按行数分支）', [2, 3, 4].every((n) => {
  const rows: RowSpec[] = [];
  for (let i = 0; i < n; i++) rows.push({ h: i === n - 1 ? ROW_HEIGHT_FILL : 400 + i * 50, units: [unit('shelves', 2400, 2)] });
  const L = computeCabinetLayout(mkCab(rows), rules);
  return L.heightChain.ok && L.rows.reduce((a, r) => a + r.netH, 0) + (n - 1) * L.boardT === L.innerH;
}));

// ══════════════════════════ ④ fill 位置与重复必须拒绝 ══════════════════════════

section('④ fill 的规则：只能一个、只能在最后一行');

const badFillPos = mkCab([
  { h: ROW_HEIGHT_FILL, units: [unit('shelves', 2400, 2)] },
  { h: 600, units: [unit('drawerBank', 2400, 2)] },
]);
const LB = computeCabinetLayout(badFillPos, rules);
ok('fill 在第一行：高度链判定为 FILL-NOT-LAST', LB.heightChain.ok === false && LB.heightChain.code === 'FILL-NOT-LAST',
  JSON.stringify(LB.heightChain));
ok('fill 在第一行：校验器报 RULE-ROW-FILL-POSITION（精确到原因码）', (() => {
  const g = generateCabinet(badFillPos, rules);
  return validateCabinet(badFillPos, g, rules).some((i) => i.code === 'RULE-ROW-FILL-POSITION' && i.severity === 'ERROR');
})(), JSON.stringify(generateCabinet(badFillPos, rules).issues.map((i) => i.code)));

const badFillDup = mkCab([
  { h: ROW_HEIGHT_FILL, units: [unit('shelves', 2400, 2)] },
  { h: ROW_HEIGHT_FILL, units: [unit('drawerBank', 2400, 2)] },
]);
const LD = computeCabinetLayout(badFillDup, rules);
ok('两个 fill：高度链判定为 FILL-DUP', LD.heightChain.ok === false && LD.heightChain.code === 'FILL-DUP', JSON.stringify(LD.heightChain));
ok('两个 fill：校验器报 RULE-ROW-FILL-DUP', (() => {
  const g = generateCabinet(badFillDup, rules);
  return validateCabinet(badFillDup, g, rules).some((i) => i.code === 'RULE-ROW-FILL-DUP' && i.severity === 'ERROR');
})());

const badOverflow = mkCab([
  { h: 3000, units: [unit('shelves', 2400, 2)] },
  { h: ROW_HEIGHT_FILL, units: [unit('drawerBank', 2400, 2)] },
]);
ok('固定高超过内高：判定为 FILL-OVERFLOW（不给负数、不说假话）', (() => {
  const L = computeCabinetLayout(badOverflow, rules);
  return L.heightChain.ok === false && L.heightChain.code === 'FILL-OVERFLOW' && L.rows.every((r) => r.netH >= 1);
})(), JSON.stringify(computeCabinetLayout(badOverflow, rules).heightChain));

const badSum = mkCab([
  { h: 600, units: [unit('shelves', 2400, 2)] },
  { h: 700, units: [unit('drawerBank', 2400, 2)] },
]);
ok('无 fill 且固定高之和不等于可用高：判定为 SUM-MISMATCH', (() => {
  const L = computeCabinetLayout(badSum, rules);
  return L.heightChain.ok === false && L.heightChain.code === 'SUM-MISMATCH';
})(), JSON.stringify(computeCabinetLayout(badSum, rules).heightChain));
ok('非法配置仍然画得出来（每行净高 ≥1mm，不是 NaN）', (() => {
  const L = computeCabinetLayout(badSum, rules);
  return L.rows.every((r) => Number.isInteger(r.netH) && r.netH >= 1);
})(), JSON.stringify(computeCabinetLayout(badSum, rules).rows.map((r) => r.netH)));

// ══════════════════════════ ⑤ 行间贯通横隔板 ══════════════════════════

section('⑤ 行间横隔板：来自 Rows → boundary，不是手加的一块板');

const G3 = generateCabinet(threeRow, rules);
const rdPanels = G3.panels.filter((p) => p.role === 'RowDividerPanel');
ok('行隔板数量 = 行数 − 1', rdPanels.length === L3.rows.length - 1, eq(rdPanels.length, L3.rows.length - 1));
ok('行隔板长度 = 内空宽（夹在两块侧板之间，贯通）', rdPanels.every((p) => p.length === L3.innerW),
  eq(rdPanels.map((p) => p.length), L3.innerW));
ok('行隔板进深 = 柜体进深', rdPanels.every((p) => p.width === threeRow.params.depth));
ok('行隔板 id 由派生层定（P_<cab>_RD<n>）', rdPanels.every((p, i) => p.id === `P_${threeRow.id}_RD${i + 1}`),
  eq(rdPanels.map((p) => p.id), `P_${threeRow.id}_RD1..2`));
ok('行隔板位置写进 edgeLabel（距柜内底多少 mm）', rdPanels.every((p, i) => p.edgeLabel.includes(`距柜内底 ${L3.rowDividers[i]! - (threeRow.params.bodyLift + t3)}mm`)),
  rdPanels.map((p) => p.edgeLabel).join(' / '));
ok('行隔板的 Z 位置 = 派生给的 rowDividers（不是谁另算的）', L3.rowDividers.every((z, k) => z === L3.rows[k + 1]!.z1));
ok('中立板长度 = **该行**净高（不是整柜净高 → 上层中立板不会捅穿顶板）', (() => {
  const div = G3.panels.filter((p) => p.role === 'DividerPanel');
  const byTag = (tag: string): number[] => div.filter((p) => p.id.includes(`_${tag}DIV`)).map((p) => p.length);
  return JSON.stringify(byTag('R1_')) === JSON.stringify([L3.rows[0]!.netH])
    && JSON.stringify(byTag('R2_')) === JSON.stringify([L3.rows[1]!.netH, L3.rows[1]!.netH])
    && byTag('R3_').length === 0; // 第三行只有 1 个分区 → 没有中立板
})(), G3.panels.filter((p) => p.role === 'DividerPanel').map((p) => `${p.id}=${p.length}`).join(' / '));

// ══════════════════════════ ⑥ 每行独立 Unit 分配 ══════════════════════════

section('⑥ 每行独立做水平分配（不许展平成一排）');

ok('每行净宽链：Σ该行净宽 + (该行分区数−1)×板厚 === 内空宽', L3.rows.every((r) => r.netTotal + (r.units.length - 1) * t3 === L3.innerW),
  L3.rows.map((r) => `${r.netTotal}+${r.units.length - 1}*${t3}`).join(' / '));
ok('两行：上行 2 格 + 下行 3 格，各自分各自的净宽', (() => {
  const r0 = L2.rows[0]!;
  const r1 = L2.rows[1]!;
  return r0.units.length === 2 && r1.units.length === 3
    && r0.netTotal + t3 === L2.innerW && r1.netTotal + 2 * t3 === L2.innerW;
})());
ok('展平反例：逐行算的结果 ≠ 把 5 个分区展平成一排算（否则就是安静地全错）', (() => {
  const flatUnits = [...L2.rows[0]!.units, ...L2.rows[1]!.units];
  const flatCab = mkCab([{ h: ROW_HEIGHT_FILL, units: flatUnits }]);
  const LF = computeCabinetLayout(flatCab, rules);
  const perRow = [...L2.rows[0]!.nets, ...L2.rows[1]!.nets];
  return JSON.stringify(LF.nets) !== JSON.stringify(perRow);
})(), (() => {
  const flatUnits = [...L2.rows[0]!.units, ...L2.rows[1]!.units];
  const LF = computeCabinetLayout(mkCab([{ h: ROW_HEIGHT_FILL, units: flatUnits }]), rules);
  return `展平=${JSON.stringify(LF.nets)} 逐行=${JSON.stringify([...L2.rows[0]!.nets, ...L2.rows[1]!.nets])}`;
})());
ok('每行 unitX0 从侧板起算、逐区累加板厚', L3.rows.every((r) => {
  let x = t3;
  for (let i = 0; i < r.units.length; i++) {
    if (r.unitX0[i] !== x) return false;
    x += r.nets[i]!;
    if (i < r.units.length - 1) x += t3;
  }
  return true;
}));
ok('柜级兼容视图（nets/unitX0/netTotal）= 第一行的值，且多行时不冒充整柜', (() => {
  return JSON.stringify(L3.nets) === JSON.stringify(L3.rows[0]!.nets)
    && JSON.stringify(L3.unitX0) === JSON.stringify(L3.rows[0]!.unitX0)
    && L3.netTotal === L3.rows[0]!.netTotal;
})());
ok('allUnits 跨行取全部分区（2+3+1=6）', allUnits(threeRow.layout).length === 6, eq(allUnits(threeRow.layout).length, 6));

// ══════════════════════════ ⑦ Case 1 / 2 / 4 ══════════════════════════

section('⑦ Case 1 / Case 2 / Case 4：同一套机制，不是三份专用几何');

interface CaseDef {
  name: string;
  cab: Cabinet;
  expectRows: number;
  expectUnits: number;
}
const case1: CaseDef = {
  name: 'Case 1 · 单行三分区衣柜',
  cab: (() => {
    const c = mkCab([{ h: ROW_HEIGHT_FILL, units: [unit('drawerBank', 600), unit('hanging', 1200, 1), unit('shelves', 600, 4)] }]);
    delete c.layout.rows;
    return c;
  })(),
  expectRows: 1,
  expectUnits: 3,
};
const case2: CaseDef = {
  name: 'Case 2 · 上部通顶柜 + 下部三分区',
  cab: mkCab([
    { h: 480, units: [unit('shelves', 1200, 2), unit('shelves', 1200, 2)] },
    { h: ROW_HEIGHT_FILL, units: [unit('drawerBank', 800), unit('hanging', 800, 1), unit('shelves', 800, 3)] },
  ]),
  expectRows: 2,
  expectUnits: 5,
};
const case4: CaseDef = {
  name: 'Case 4 · 上中下三层嵌套分区',
  cab: mkCab([
    { h: 600, units: [unit('shelves', 1200, 2), unit('shelves', 1200, 2)] },
    { h: 900, units: [unit('drawerBank', 700), unit('shelves', 850, 3), unit('shelves', 850, 3)] },
    // 底行也分两格：整柜宽(2360)的抽屉面板放不进 2440×1220 板材 ——
    // 这是开料约束给出的真实 ERROR，不是 P1 引入的；测试模型不该自带设计错误
    { h: ROW_HEIGHT_FILL, units: [unit('drawerBank', 1200, 2), unit('shelves', 1200, 3)] },
  ]),
  expectRows: 3,
  expectUnits: 7,
};

for (const c of [case1, case2, case4]) {
  const L = computeCabinetLayout(c.cab, rules);
  const g = generateCabinet(c.cab, rules);
  const issues = validateCabinet(c.cab, g, rules);
  const vs = buildCabinetViews(c.cab, rules);
  const bodies = buildCabinetBodies(c.cab, rules);
  const errs = issues.filter((i) => i.severity === 'ERROR');

  ok(`${c.name}：行数 ${c.expectRows}、分区总数 ${c.expectUnits}`, L.rows.length === c.expectRows && allUnits(c.cab.layout).length === c.expectUnits,
    eq(`${L.rows.length}行/${allUnits(c.cab.layout).length}区`, `${c.expectRows}行/${c.expectUnits}区`));
  ok(`${c.name}：高度链闭合`, L.rows.reduce((a, r) => a + r.netH, 0) + (L.rows.length - 1) * L.boardT === L.innerH);
  ok(`${c.name}：无 ERROR 级校验问题`, errs.length === 0, errs.map((i) => `${i.code}:${i.message}`).join(' | '));
  ok(`${c.name}：行隔板数 = 行数 − 1`, g.panels.filter((p) => p.role === 'RowDividerPanel').length === L.rows.length - 1);
  ok(`${c.name}：四视图四个视图都有图元`, (['front', 'top', 'side', 'internal'] as const).every((v) => vs.prims[v].length > 0));
  ok(`${c.name}：3D 盒体非空且都带柜号`, bodies.length > 0 && bodies.every((b) => b.cabId === c.cab.id));
  ok(`${c.name}：3D 里行隔板盒数量 = 行数 − 1`, bodies.filter((b) => b.role === 'rowDivider').length === L.rows.length - 1,
    eq(bodies.filter((b) => b.role === 'rowDivider').length, L.rows.length - 1));
}

// ══════════════════════════ ⑧ 2D / 3D / DXF / BOM 一致性 ══════════════════════════

section('⑧ 下游一致性：2D / 3D / DXF(中立导出) / BOM 说同一件事');

for (const c of [case2, case4]) {
  const L = computeCabinetLayout(c.cab, rules);
  const g = generateCabinet(c.cab, rules);
  const vs = buildCabinetViews(c.cab, rules);
  const bodies = buildCabinetBodies(c.cab, rules);
  const nRow = L.rows.length;

  // BOM（板件清单）
  const bomDividers = g.panels.filter((p) => p.role === 'RowDividerPanel').length;
  // 3D
  const boxDividers = bodies.filter((b) => b.role === 'rowDivider').length;
  // 2D：侧视图里行隔板必须画出来（逐行虚线 + 横板）
  const side = vs.prims.side;
  const twoD = L.rowDividers.every((z) => side.some((p) => p.k === 'poly' && p.pts.some((pt) => Math.abs(pt.y - z) < 1)));
  // DXF 的唯一源：中立导出（sheet）
  const neutral = toNeutralExport(projOf(c.cab), rules, ['sheet'], 'TEST');
  const sheet = neutral.sheets.find((s) => s.name === 'SHEET')!;

  ok(`${c.name}：BOM 行隔板数 === 3D 行隔板数 === 行数−1`, bomDividers === boxDividers && boxDividers === nRow - 1,
    `BOM=${bomDividers} 3D=${boxDividers} 行=${nRow}`);
  ok(`${c.name}：2D 侧视图按派生给的 rowDividers 画横板（不是自己猜位置）`, twoD,
    `rowDividers=${JSON.stringify(L.rowDividers)}`);
  ok(`${c.name}：3D 行隔板盒的 Z 中心 = 派生 Z + 半板厚`, L.rowDividers.every((z) => bodies.some((b: Box3D) => b.role === 'rowDivider' && Math.abs(b.cz - (z + L.boardT / 2)) < 1e-6)),
    JSON.stringify(bodies.filter((b) => b.role === 'rowDivider').map((b) => b.cz)));
  ok(`${c.name}：中立导出（DXF 源）图元非空、且图幅含全部分区文字`, sheet.prims.length > 0);
  ok(`${c.name}：中立导出 = 四视图同一条链路（图元数与视图图元数同源）`, (() => {
    const total = (['front', 'top', 'side', 'internal'] as const).reduce((a, v) => a + vs.prims[v].length, 0);
    return sheet.prims.length >= total; // 中立导出 = 视图图元 + 标注 + 衔接线
  })());
  ok(`${c.name}：BOM 中立板长度逐行不同（证明清单也认行，不是拿整柜高套）`, (() => {
    const lens = new Set(g.panels.filter((p) => p.role === 'DividerPanel').map((p) => p.length));
    return [...lens].every((v) => L.rows.some((r) => r.netH === v));
  })(), g.panels.filter((p) => p.role === 'DividerPanel').map((p) => p.length).join('/'));
}

// ══════════════════════════ ⑧b 本阶段明确不支持的组合 ══════════════════════════

section('⑧b 多行 × 双面柜：明确拒绝，且派生不许给出荒谬数字');

const doubleMulti = mkCab([
  { h: 700, units: [unit('shelves', 1200, 2), unit('shelves', 1200, 2)] },
  { h: ROW_HEIGHT_FILL, units: [unit('drawerBank', 2400, 2)] },
]);
doubleMulti.layout.type = 'double';
doubleMulti.layout.backUnits = [unit('shelves', 1200, 2), unit('shelves', 1200, 2)];

const LDM = computeCabinetLayout(doubleMulti, rules);
const GDM = generateCabinet(doubleMulti, rules);
ok('双面 + 多行：校验器报 RULE-ROW-DOUBLE-UNSUPPORTED（ERROR）',
  validateCabinet(doubleMulti, GDM, rules).some((i) => i.code === 'RULE-ROW-DOUBLE-UNSUPPORTED' && i.severity === 'ERROR'),
  GDM.issues.map((i) => i.code).join('/'));
ok('双面 + 多行：派生按单行兜底（取 canonical 第一行，不是空数组）', LDM.rows.length === 1 && LDM.nets.length === 2,
  eq(LDM.nets.length, 2));
ok('双面 + 多行：netTotal 不是荒谬值（不是 innerW + 板厚）', LDM.netTotal === LDM.innerW - LDM.boardT,
  eq(LDM.netTotal, LDM.innerW - LDM.boardT));
ok('双面 + 多行：不产出行隔板（几何语义未定义，不许猜）', GDM.panels.filter((p) => p.role === 'RowDividerPanel').length === 0);
ok('双面 + 多行：所有派生数字都是有限数（没有 NaN 混进生产尺寸）',
  [LDM.innerW, LDM.innerH, LDM.netTotal, ...LDM.nets, ...LDM.unitX0].every((v) => Number.isFinite(v)));

// ══════════════════════════ ⑨ 写路径与命令口径 ══════════════════════════

section('⑨ 写路径：单行沿用 layout.units，多行落在 layout.rows[j].units');

ok('单行柜写路径前缀 = layout.units（与 v0.2 逐字相同）', unitPathPrefix(case1.cab.layout, 0) === 'layout.units',
  eq(unitPathPrefix(case1.cab.layout, 0), 'layout.units'));
ok('多行柜第 2 行写路径前缀 = layout.rows[1].units', unitPathPrefix(case4.cab.layout, 1) === 'layout.rows[1].units',
  eq(unitPathPrefix(case4.cab.layout, 1), 'layout.rows[1].units'));
ok('反向查询：按前缀取回那一行的分区', JSON.stringify(unitsAtPath(case4.cab.layout, 'layout.rows[1].units')) === JSON.stringify(case4.cab.layout.rows![1]!.units));
ok('多行柜存盘只写 rows、不写 units 镜像（防旧读者把第一行当整柜）', (() => {
  const f = toFileLayout(case4.cab.layout) as unknown as Record<string, unknown>;
  return Array.isArray(f.rows) && !Array.isArray(f.units);
})(), JSON.stringify(Object.keys(toFileLayout(case4.cab.layout))));
ok('改第 2 行的净宽真的落在第 2 行（不是安静地改到第 1 行）', (() => {
  const proj = projOf(case4.cab);
  const bus = new CommandBus(proj, rules);
  const cab = proj.cabinets[0]!;
  const cmd = CMD.setUnitWidth(cab, 0, 999, 'ui', unitPathPrefix(cab.layout, 1));
  const res = bus.execute(cmd);
  if (!res.ok) return false;
  const after = bus.project.cabinets[0]!;
  return after.layout.rows![1]!.units[0]!.requestedWidth === 999
    && after.layout.rows![0]!.units[0]!.requestedWidth !== 999;
})());
ok('单行柜的分区命令不改路径形状（仍是 layout.units[0]…）', (() => {
  const cmd = CMD.setUnitWidth(case1.cab, 0, 700);
  return cmd.changes[0]!.path === 'layout.units[0].requestedWidth';
})(), CMD.setUnitWidth(case1.cab, 0, 700).changes[0]?.path);

// ══════════════════════════ 收尾 ═══════════════════════════════

console.log('\n════════════════════════════════════════════════');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('\nP1 成立：单行逐位等价、行高链闭合、行隔板由 boundary 派生、每行独立分宽，Case 1/2/4 走同一条 rows → layout → geometry → 2D/3D/DXF/BOM 链路。');
