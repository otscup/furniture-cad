/**
 * ══════════════════════════════════════════════════════════════════════
 *  P7 验收 —— Manufacturing Semantics（制造语义第一版）
 *
 *  用户给 P7 定的验收清单（逐条对应下面的 section）：
 *    ① Semantic Model → Manufacturing 确定性
 *    ② 相同输入得到相同制造结果
 *    ③ panel 数量正确
 *    ④ panel 尺寸与 Semantic / Geometry 一致（单一尺寸来源）
 *    ⑤ row divider / divider 等已有角色正确进入制造层
 *    ⑥ 未验证结构不会被自动制造（不脑补孔位/坐标）
 *    ⑦ Assembly 不会自动产生未经规则确认的加工
 *    ⑧ BOM 与 Manufacturing Part 来源一致
 *    ⑨ DXF 与 Manufacturing Part 来源一致
 *    ⑩ 修改 Semantic Model 后 Manufacturing 正确重新派生
 *    ⑪ 真实闭环：2D / 3D / BOM / DXF / Manufacturing 来自同一 Semantic Model，关键尺寸一致
 *    ⑫ 层板托孔（P7.1 第一条真实制造规则）：verified、标高来自几何、横向留量来自制造规则、可关
 *    （P0–P6 旧测试由 verify:all 整体回归，本脚本只钉 P7 新增的不变量）
 *
 *  ── 判据纪律（与既有验收一致）──
 *    负样本精确到原因：不写「被拒了」这种会被别处检查顶替的假绿；
 *    尺寸断言用「几何派生值 vs 制造件值逐字段相等」而非「都是正整数」这种恒真判据。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, CabinetRow, Connection, FurnitureAssembly, Project, RuleSet, UnitSpec } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, makeUnit, sampleProject } from '../src/core/docFactory.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { equalSpacing } from '../src/core/allocate.ts';
import { toNeutralExport, type NeutralExport } from '../src/export/neutralSheet.ts';
import {
  deriveManufacturing,
  bomFromManufacturing,
  manufacturingToPanels,
  manufacturingToNeutralExport,
  DEFAULT_MANUFACTURING_RULES,
} from '../src/core/manufacturing/index.ts';
import type { ManufacturingPart, MfgPartRole } from '../src/core/manufacturing/index.ts';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

// ── 断言脚手架（与既有 verify 脚本同款）──
let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (detail ? ` —— ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}
const deepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

// ── 造柜助手 ──
let seq = 0;
function mkUnit(kind: UnitSpec['kind'], requestedWidth: number): UnitSpec {
  return makeUnit({ id: `unit_${String(++seq).padStart(3, '0')}`, kind, requestedWidth, rules });
}
/** 造多行柜（单行时仍显式写 rows；多行时清空 units，与真实文件形状一致） */
function mkCab(rows: Array<{ h: number | 'fill'; units: UnitSpec[] }>, opts: { id?: string; width?: number; height?: number; depth?: number } = {}): Cabinet {
  const cab = createCabinet({
    id: opts.id ?? `cab_mfg_${++seq}`,
    name: opts.id ?? `柜${seq}`,
    roomId: 'room_001',
    placement: { x: 0, y: 0, rotation: 0 },
    params: { width: opts.width ?? 2400, height: opts.height ?? 2400, depth: opts.depth ?? 600 },
    layout: { type: 'row', widthMode: 'fit_total', units: rows[0]!.units },
    rules,
  });
  const rs: CabinetRow[] = rows.map((r, i) => ({ id: `row_${String(i + 1).padStart(3, '0')}`, height: r.h, units: r.units }));
  cab.layout.rows = rs;
  if (rs.length > 1) cab.layout.units = [];
  return cab;
}

const boardT = (cab: Cabinet): number => rules.materials[cab.params.boardMaterial]!.thickness;

console.log('P7 · Manufacturing Semantics 验收');

// ═════════════════════════════════════════════════════════════════════
// ① + ② 确定性：相同输入 → 相同输出
// ═════════════════════════════════════════════════════════════════════
{
  const project = sampleProject(rules);
  const geom = generateProject(project, rules);
  const a = deriveManufacturing(project, geom, rules);
  const b = deriveManufacturing(project, geom, rules);
  ok('① 同输入同输出：两次派生深比较相等', deepEqual(a, b), `a.parts=${a.parts.length} b.parts=${b.parts.length}`);
  ok('② 派生命名稳定：ManufacturingPart.id === 几何 Panel.id', a.parts.every((p) => p.id === p.geometryPanelId));
}

// ═════════════════════════════════════════════════════════════════════
// ③ + ④ 数量正确 + 尺寸与 Semantic/Geometry 一致（单一尺寸来源）
// ═════════════════════════════════════════════════════════════════════
{
  const project = sampleProject(rules);
  const geom = generateProject(project, rules);
  const mfg = deriveManufacturing(project, geom, rules);
  const cab = project.cabinets[0]!;
  const g = geom.cabinets[cab.id]!;
  const mfgParts = mfg.cabinets[cab.id]!;

  ok('③ 制造件数 === 几何板件数（单行柜逐板对应）', mfgParts.length === g.panels.length, `mfg=${mfgParts.length} geom=${g.panels.length}`);

  // 每个制造件的长/宽/厚/数量 === 对应几何板件（逐字段，证明制造层不重算尺寸）
  let dimMatch = true;
  for (const p of mfgParts) {
    const gp = g.panels.find((x) => x.id === p.id);
    if (!gp || gp.length !== p.length || gp.width !== p.width || gp.thickness !== p.thickness || gp.qty !== p.qty) dimMatch = false;
  }
  ok('④ 制造件尺寸逐字段 === 几何板件（Manufacturing 只读几何，不重算）', dimMatch);

  // 尺寸追溯到 Semantic Model：顶板长 === 内空宽 === 柜宽 − 2×板厚
  const t = boardT(cab);
  const innerW = cab.params.width - 2 * t;
  const top = mfgParts.find((p) => p.role === 'TopPanel')!;
  ok('④ 顶板长 === 柜宽 − 2×板厚（来源可追溯）', top.length === innerW, `top=${top.length} innerW=${innerW}`);
  const side = mfgParts.find((p) => p.role === 'LeftSidePanel')!;
  ok('④ 侧板长 === 柜内净高(bodyH)（来源可追溯）', side.length === g.layout.bodyH, `side=${side.length} bodyH=${g.layout.bodyH}`);
}

// ═════════════════════════════════════════════════════════════════════
// ⑤ 已有角色正确进入制造层（含多行 row divider）
// ═════════════════════════════════════════════════════════════════════
{
  const project = sampleProject(rules);
  const geom = generateProject(project, rules);
  const mfg = deriveManufacturing(project, geom, rules);
  const roles = new Set(mfg.parts.map((p) => p.role));
  const needSingle: MfgPartRole[] = ['LeftSidePanel', 'RightSidePanel', 'TopPanel', 'BottomPanel', 'DividerPanel', 'BackPanel', 'ShelfPanel', 'DoorPanel'];
  ok('⑤ 单行柜基础角色全部进入制造层', needSingle.every((r) => roles.has(r)), [...needSingle.filter((r) => !roles.has(r))].join(','));

  // 多行柜：行隔板进入制造层，数量 = 行数−1；上层挂衣、下层层板（便于溯源断言）
  const twoRow = mkCab([
    { h: 'fill', units: [mkUnit('hanging', 1200)] },
    { h: 480, units: [mkUnit('shelves', 1200)] },
  ]);
  const proj2: Project = { ...project, cabinets: [twoRow] };
  const geom2 = generateProject(proj2, rules);
  const mfg2 = deriveManufacturing(proj2, geom2, rules);
  const rdCount = mfg2.parts.filter((p) => p.role === 'RowDividerPanel').length;
  ok('⑤ 多行柜：RowDividerPanel 进入制造层', rdCount === 1, `count=${rdCount}`);
  ok('⑤ 多行柜：行隔板数 === 几何板件中 RowDividerPanel 数', rdCount === geom2.cabinets[twoRow.id]!.panels.filter((p) => p.role === 'RowDividerPanel').length);
  // 多行板件的 rowId 溯源准确（行隔板不分属具体行 → undefined；分区板件能定位行）
  const shelfInRow2 = mfg2.parts.some((p) => p.role === 'ShelfPanel' && p.source.unitId && p.source.rowId === 'row_002');
  ok('⑤ 多行柜：下层层板回指到正确行（row_002）', shelfInRow2);
}

// ═════════════════════════════════════════════════════════════════════
// ⑥ 未验证结构不会被自动制造（不脑补孔位/坐标）
// ═════════════════════════════════════════════════════════════════════
{
  const project = sampleProject(rules);
  const geom = generateProject(project, rules);
  const mfg = deriveManufacturing(project, geom, rules);

  // 除"确定性层板托孔"外，没有任何未确认加工被标成 verified（不脑补）
  const fabricatedVerified = mfg.parts.some((p) =>
    p.operations.some((o) => ['drilling', 'connector-hole', 'hardware-mount', 'groove'].includes(o.role) && o.verification === 'verified' && o.source !== 'deterministic.shelfElevations'),
  );
  ok('⑥ 除确定性层板托孔外，没有任何未确认加工被标成 verified（不脑补）', !fabricatedVerified);

  // 层板件本身不再声称托孔（托孔在侧板，固定层板不钻孔）
  const shelf = mfg.parts.find((p) => p.role === 'ShelfPanel')!;
  ok('⑥ 层板件本身不声称钻孔（托孔已升格到侧板 verified）', !shelf.operations.some((o) => o.role === 'drilling'));

  // 封边是 verified（来自几何 panel.edge）
  const side = mfg.parts.find((p) => p.role === 'LeftSidePanel')!;
  ok('⑥ 侧板封边操作 verified（来自几何 panel.edge）', side.operations.some((o) => o.role === 'edge-banding' && o.verification === 'verified'));
  // 背板工艺 verified（来自语义 backPanel.method）
  const back = mfg.parts.find((p) => p.role === 'BackPanel')!;
  ok('⑥ 背板工艺操作 verified（来自语义 backPanel.method）', back.operations.some((o) => o.role === 'back-panel-treatment' && o.verification === 'verified'));

  // 侧板带 verified 层板托孔（P7.1 第一条真实制造规则；孔位来自几何，不脑补）
  const pin = side.operations.find((o) => o.role === 'drilling' && o.source === 'deterministic.shelfElevations');
  ok('⑥ 侧板带 verified 层板托孔（标高来自几何，不脑补）', !!pin && pin.verification === 'verified');
  ok('⑥ 层板托孔带结构化孔位（elevations 非空，基准=柜内底）', !!pin?.holes && pin.holes.elevations.length > 0 && pin.holes.reference === 'cabinet-inner-bottom');
}

// ═════════════════════════════════════════════════════════════════════
// ⑦ Assembly 不会自动产生未经规则确认的加工
// ═════════════════════════════════════════════════════════════════════
{
  const a = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cab_A' });
  const b = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cab_B' });
  const conn: Connection = { id: 'conn_001', kind: 'butt', a: { cabinetId: 'cab_A' }, b: { cabinetId: 'cab_B' }, origin: 'authored' };
  const asm: FurnitureAssembly = { id: 'asm_001', name: '并排组', roomId: 'room_001', memberIds: ['cab_A', 'cab_B'], connections: [conn] };
  const project: Project = { ...sampleProject(rules), cabinets: [a, b], assemblies: [asm] };
  const geom = generateProject(project, rules);
  const mfg = deriveManufacturing(project, geom, rules);

  // 没有任何组合连接孔被标成 verified
  const asmVerifiedConn = mfg.parts.some((p) => p.operations.some((o) => o.role === 'connector-hole' && o.verification === 'verified'));
  ok('⑦ 组合连接不生成 verified 加工（不自动编造）', !asmVerifiedConn);

  // 但诚实标了一条 unverified 的组合连接孔操作
  const asmUnverifiedConn = mfg.parts.some((p) => p.operations.some((o) => o.role === 'connector-hole' && o.verification === 'unverified' && (o.nameZh.includes('组合连接') || o.detail?.includes('assembly connector'))));
  ok('⑦ 组合连接标为 unverified（诚实说未确认）', asmUnverifiedConn);

  // 组合成员柜体带 MFG-ASSEMBLY-CONN-UNVERIFIED 备注
  const noted = mfg.parts.some((p) => p.source.cabinetId === 'cab_A' && p.warnings.some((w) => w.code === 'MFG-ASSEMBLY-CONN-UNVERIFIED'));
  ok('⑦ 组合成员柜体带未确认备注', noted);
}

// ═════════════════════════════════════════════════════════════════════
// ⑧ BOM 与 Manufacturing Part 来源一致
// ═════════════════════════════════════════════════════════════════════
{
  const project = sampleProject(rules);
  const geom = generateProject(project, rules);
  const mfg = deriveManufacturing(project, geom, rules);
  const bom = bomFromManufacturing(mfg.parts);
  const cab = project.cabinets[0]!;
  const g = geom.cabinets[cab.id]!;
  const cabBom = bom.filter((r) => r.sourcePanelId.startsWith(cab.id) || mfg.cabinets[cab.id]!.some((p) => p.id === r.sourcePanelId));

  ok('⑧ BOM 行数 === 几何板件数', cabBom.length === g.panels.length, `bom=${cabBom.length} geom=${g.panels.length}`);
  // 每个 BOM 行的 sourcePanelId 都能在制造件里找到
  ok('⑧ 每个 BOM 行回指一个制造件', bom.every((r) => mfg.parts.some((p) => p.id === r.sourcePanelId)));

  // BOM 与几何板件按 (role,material,length,width,thickness,qty) 聚合计数一致
  const key = (role: string, m: string, l: number, w: number, t: number, q: number): string => `${role}|${m}|${l}|${w}|${t}|${q}`;
  const bomCount = new Map<string, number>();
  for (const r of bom) bomCount.set(key(r.role, r.material, r.length, r.width, r.thickness, r.qty), (bomCount.get(key(r.role, r.material, r.length, r.width, r.thickness, r.qty)) ?? 0) + 1);
  const geomCount = new Map<string, number>();
  for (const p of g.panels) geomCount.set(key(p.role, p.material, p.length, p.width, p.thickness, p.qty), (geomCount.get(key(p.role, p.material, p.length, p.width, p.thickness, p.qty)) ?? 0) + 1);
  let countsMatch = bomCount.size === geomCount.size;
  for (const [k, v] of bomCount) if (geomCount.get(k) !== v) countsMatch = false;
  ok('⑧ BOM 与几何板件（角色/材质/尺寸/数量）聚合一致', countsMatch);
}

// ═════════════════════════════════════════════════════════════════════
// ⑨ DXF 与 Manufacturing Part 来源一致
// ═════════════════════════════════════════════════════════════════════
{
  const project = sampleProject(rules);
  const legacy: NeutralExport = toNeutralExport(project, rules, ['sheet'], 'v-test');
  const mfgDxf: NeutralExport = manufacturingToNeutralExport(project, rules, DEFAULT_MANUFACTURING_RULES, ['sheet'], 'v-test');
  ok('⑨ DXF(panels) 旧路径 vs 制造路径逐字段相等', deepEqual(legacy.panels, mfgDxf.panels), `legacy=${legacy.panels.length} mfg=${mfgDxf.panels.length}`);

  // 多行柜：DXF 经制造层仍包含行隔板，且 id/尺寸一致
  const twoRow = mkCab([
    { h: 480, units: [mkUnit('shelves', 1200)] },
    { h: 'fill', units: [mkUnit('hanging', 1200)] },
  ]);
  const proj2: Project = { ...project, cabinets: [twoRow] };
  const legacy2 = toNeutralExport(proj2, rules, ['sheet'], 'v-test');
  const mfg2 = manufacturingToNeutralExport(proj2, rules, DEFAULT_MANUFACTURING_RULES, ['sheet'], 'v-test');
  const rdLegacy = legacy2.panels.filter((p) => p.role === 'RowDividerPanel');
  const rdMfg = mfg2.panels.filter((p) => p.role === 'RowDividerPanel');
  ok('⑨ 多行柜：DXF 经制造层仍含行隔板', rdLegacy.length === 1 && rdMfg.length === 1);
  ok('⑨ 多行柜：行隔板 id/尺寸一致', rdLegacy.length === 1 && rdMfg.length === 1 && deepEqual(rdLegacy[0], rdMfg[0]));
}

// ═════════════════════════════════════════════════════════════════════
// ⑩ 修改 Semantic Model → Manufacturing 正确重新派生
// ═════════════════════════════════════════════════════════════════════
{
  const project = sampleProject(rules);
  const geom0 = generateProject(project, rules);
  const mfg0 = deriveManufacturing(project, geom0, rules);
  const cab = project.cabinets[0]!;
  const top0 = mfg0.cabinets[cab.id]!.find((p) => p.role === 'TopPanel')!;

  // 改柜宽 +200
  const project2: Project = structuredClone(project);
  project2.cabinets[0]!.params.width += 200;
  const geom1 = generateProject(project2, rules);
  const mfg1 = deriveManufacturing(project2, geom1, rules);
  const top1 = mfg1.cabinets[cab.id]!.find((p) => p.role === 'TopPanel')!;

  ok('⑩ 改柜宽后顶板长变化量 === 柜宽变化量（innerW = width − 2×板厚）', top1.length - top0.length === 200, `Δtop=${top1.length - top0.length}`);
  ok('⑩ 改柜宽不影响侧板长（bodyH 与宽无关）', mfg0.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!.length === mfg1.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!.length);
  // 重派生产出有效制造件（尺寸链随语义改变被正确重算，门数随宽合法变化属正常派生）
  ok('⑩ 改柜宽后 Manufacturing 正确重新派生（产出有效制造件）', mfg1.parts.length > 0 && mfg1.stats.partCount === mfg1.parts.length);
}

// ═════════════════════════════════════════════════════════════════════
// ⑪ 真实闭环：2D / 3D / BOM / DXF / Manufacturing 同源于一个 Semantic Model
// ═════════════════════════════════════════════════════════════════════
{
  const project = sampleProject(rules);
  const geom = generateProject(project, rules);
  const mfg = deriveManufacturing(project, geom, rules);
  const cab = project.cabinets[0]!;
  const g = geom.cabinets[cab.id]!;
  const mfgParts = mfg.cabinets[cab.id]!;
  const bom = bomFromManufacturing(mfg.parts).filter((r) => mfg.cabinets[cab.id]!.some((p) => p.id === r.sourcePanelId));
  const dxf = toNeutralExport(project, rules, ['sheet'], 'v-test').panels.filter((p) => p.belongsTo === cab.id || p.belongsTo.startsWith(cab.id + '.'));

  // 五处出口都对同一柜产出相同数量的板件
  const nViews = g.plan.length > 0; // 2D 平面图图元存在
  const n3d = geom.bodies3d.length > 0; // 3D 体块存在
  ok('⑪ 2D 视图已派生', nViews);
  ok('⑪ 3D 体块已派生', n3d);
  ok('⑪ 五处出口板件数一致（几何/制造/BOM/DXF）', g.panels.length === mfgParts.length && mfgParts.length === bom.length && bom.length === dxf.length, `geom=${g.panels.length} mfg=${mfgParts.length} bom=${bom.length} dxf=${dxf.length}`);

  // 关键尺寸一致：制造侧板长 === bodyH === 3D 体块高度之一
  const sideLen = mfgParts.find((p) => p.role === 'LeftSidePanel')!.length;
  const bodyH = g.layout.bodyH;
  const body3dHeights = geom.bodies3d.filter((b) => b.cabId === cab.id).map((b) => Math.round(b.sz * 100) / 100);
  ok('⑪ 制造侧板长 === 几何 bodyH', sideLen === bodyH, `side=${sideLen} bodyH=${bodyH}`);
  ok('⑪ 3D 体块高度含 bodyH（关键尺寸跨出口一致）', body3dHeights.some((h) => Math.abs(h - bodyH) < 0.5), `heights=${JSON.stringify(body3dHeights)} bodyH=${bodyH}`);
}

// ─────────────────────────────────────────────────────────────────
// ⑫ 层板托孔（P7.1 第一条真实制造规则）
// ═════════════════════════════════════════════════════════════════
{
  const project = sampleProject(rules);
  const geom = generateProject(project, rules);
  const mfg = deriveManufacturing(project, geom, rules);
  const cab = project.cabinets[0]!;
  const g = geom.cabinets[cab.id]!;
  const side = mfg.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!;
  const pin = side.operations.find((o) => o.role === 'drilling' && o.source === 'deterministic.shelfElevations');

  ok('⑫ 侧板带 verified 层板托孔（来源 deterministic.shelfElevations）', !!pin && pin.verification === 'verified');

  // 触发条件：样本柜存在带 shelves 的分区
  const hasShelf = g.layout.rows.some((r) => r.units.some((u) => u.shelves && u.shelves.count > 0));
  ok('⑫ 样本柜存在带 shelves 的分区（verified 升格条件满足）', hasShelf);

  // 标高 === 几何 equalSpacing 层板标高集合（柜内底基准），逐值一致（孔位不另算）
  const innerBottomZ = cab.params.bodyLift + g.layout.boardT;
  const expected = new Set<number>();
  for (const r of g.layout.rows) {
    for (const u of r.units) {
      const s = u.shelves;
      if (s && s.count > 0) for (const pos of equalSpacing(r.netH, s.count)) expected.add(Math.round(r.z0 - innerBottomZ + pos));
    }
  }
  const exp = [...expected].sort((a, b) => a - b);
  ok('⑫ 托孔标高 === 几何层板标高集合（逐值一致，单一来源）', !!pin?.holes && deepEqual(pin.holes.elevations, exp), `pin=${JSON.stringify(pin?.holes?.elevations)} exp=${JSON.stringify(exp)}`);

  // 横向留量来自制造规则（工厂参数），不是几何、不是语义
  ok(
    '⑫ 托孔横向留量来自制造规则 shelfPins（非几何）',
    !!pin?.holes && pin.holes.insetFrontMm === DEFAULT_MANUFACTURING_RULES.shelfPins.insetFrontMm && pin.holes.holesPerElevationPerSide === DEFAULT_MANUFACTURING_RULES.shelfPins.holesPerElevationPerSide,
  );

  // 无 shelves 的柜：侧板不带 verified 托孔（不硬钻）
  const plain = mkCab([{ h: 'fill', units: [mkUnit('open', 1200)] }]);
  const proj2: Project = { ...sampleProject(rules), cabinets: [plain] };
  const geom2 = generateProject(proj2, rules);
  const mfg2 = deriveManufacturing(proj2, geom2, rules);
  const side2 = mfg2.parts.find((p) => p.role === 'LeftSidePanel')!;
  ok('⑫ 无 shelves 的柜：侧板不带 verified 托孔（不硬钻）', !side2.operations.some((o) => o.role === 'drilling' && o.source === 'deterministic.shelfElevations'));

  // shelfPins.enabled=false → 不钻（工厂可关，不钻默认孔）
  const shelved = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }]);
  const proj3: Project = { ...sampleProject(rules), cabinets: [shelved] };
  const geom3 = generateProject(proj3, rules);
  const off = deriveManufacturing(proj3, geom3, rules, {
    ...DEFAULT_MANUFACTURING_RULES,
    shelfPins: { ...DEFAULT_MANUFACTURING_RULES.shelfPins, enabled: false },
  });
  const sideOff = off.parts.find((p) => p.role === 'LeftSidePanel')!;
  ok('⑫ shelfPins.enabled=false → 侧板不带 verified 托孔（规则可关）', !sideOff.operations.some((o) => o.role === 'drilling' && o.source === 'deterministic.shelfElevations'));
}

// ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(66)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：P7 Manufacturing Semantics 制造语义底座成立。');
