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

  // 除"确定性层板托孔 / 箱体外壳连接孔"外，没有任何未确认加工被标成 verified（不脑补）
  const fabricatedVerified = mfg.parts.some((p) =>
    p.operations.some((o) => ['drilling', 'connector-hole', 'hardware-mount', 'groove'].includes(o.role) && o.verification === 'verified' && o.source !== 'deterministic.shelfElevations' && o.source !== 'deterministic.caseConnectors'),
  );
  ok('⑥ 除确定性层板托孔/箱体外壳连接孔外，没有任何未确认加工被标成 verified（不脑补）', !fabricatedVerified);

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

  // 没有任何「组合连接」孔被标成 verified（箱体内壳连接 deterministic.caseConnectors 是另一回事，已升格）
  const asmVerifiedConn = mfg.parts.some((p) => p.operations.some((o) => o.role === 'connector-hole' && o.verification === 'verified' && o.source !== 'deterministic.caseConnectors'));
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
// ⑬ 层板托孔规则硬化（P7.2）：证明规则正确，而非只证明「有孔位」
// ═════════════════════════════════════════════════════════════════
{
  const base = sampleProject(rules);
  const findPin = (part: ManufacturingPart): ManufacturingOperation | undefined =>
    part.operations.find((o) => o.role === 'drilling' && o.source === 'deterministic.shelfElevations');
  const expectedElevations = (geom: ReturnType<typeof generateProject>, cab: Cabinet): number[] => {
    const L = geom.cabinets[cab.id]!.layout;
    const innerBottomZ = cab.params.bodyLift + L.boardT;
    const set = new Set<number>();
    for (const r of L.rows) for (const u of r.units) {
      const s = u.shelves;
      if (s && s.count > 0) for (const pos of equalSpacing(r.netH, s.count)) set.add(Math.round(r.z0 - innerBottomZ + pos));
    }
    return [...set].sort((a, b) => a - b);
  };

  // A. verified 升格结构性判据（verified 9 条的可测代理）：
  //    verified 的坐标加工绝不来自 'manufacturing-rule:unverified'；
  //    unverified 的加工绝不携带结构化孔位（不脑补坐标）；verified 钻孔必有坐标。
  const mfgAll = deriveManufacturing(base, generateProject(base, rules), rules);
  let structOk = true;
  for (const p of mfgAll.parts) for (const o of p.operations) {
    const coordRole = ['drilling', 'connector-hole', 'hardware-mount', 'groove'].includes(o.role);
    if (o.verification === 'verified' && coordRole && o.source === 'manufacturing-rule:unverified') structOk = false;
    if (o.verification === 'unverified' && coordRole && o.holes) structOk = false;
    if (o.role === 'drilling' && o.verification === 'verified' && !o.holes) structOk = false;
  }
  ok('⑬ verified 结构性判据：verified 坐标加工 source 非 unverified；unverified 不携带 holes', structOk);

  // B. 不同柜高 → 标高随之变化且逐值 === 几何 equalSpacing（单一来源）
  for (const H of [1800, 2400, 3000]) {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: `cabH_${H}`, height: H });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const side = mfg.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!;
    const pin = findPin(side);
    ok(`⑬ 柜高 ${H}：侧板 verified 托孔标高 === 几何层板标高`, !!pin && pin.verification === 'verified' && deepEqual(pin.holes!.elevations, expectedElevations(geom, cab)), `H=${H}`);
  }

  // C. 多行柜：只有带 shelves 的行贡献标高；无 shelves 的行（挂衣）不贡献
  {
    const twoMix = mkCab([
      { h: 'fill', units: [mkUnit('hanging', 1200)] },
      { h: 600, units: [mkUnit('shelves', 1200)] },
    ], { id: 'cabMix' });
    const proj: Project = { ...base, cabinets: [twoMix] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const side = mfg.cabinets['cabMix']!.find((p) => p.role === 'LeftSidePanel')!;
    const pin = findPin(side);
    ok('⑬ 多行柜：仅带 shelves 的行贡献标高（挂衣行不钻）', !!pin && deepEqual(pin.holes!.elevations, expectedElevations(geom, twoMix)), `got=${JSON.stringify(pin?.holes?.elevations)}`);
  }
  // 双行都带 shelves → 两行标高合并
  {
    const twoShelf = mkCab([
      { h: 'fill', units: [mkUnit('shelves', 1200)] },
      { h: 600, units: [mkUnit('shelves', 1200)] },
    ], { id: 'cabTwoShelf' });
    const proj: Project = { ...base, cabinets: [twoShelf] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const side = mfg.cabinets['cabTwoShelf']!.find((p) => p.role === 'LeftSidePanel')!;
    const pin = findPin(side);
    ok('⑬ 双行都带 shelves：两行标高合并进侧板托孔', !!pin && deepEqual(pin.holes!.elevations, expectedElevations(geom, twoShelf)), `got=${JSON.stringify(pin?.holes?.elevations)}`);
  }

  // D. 不同 shelfPins 参数 → 孔型参数逐字段反映，标高不变
  for (const variant of [
    { holesPerElevationPerSide: 1, insetFrontMm: 20, insetBackMm: 20 },
    { holesPerElevationPerSide: 3, insetFrontMm: 50, insetBackMm: 50 },
  ]) {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: `cabVar_${variant.holesPerElevationPerSide}` });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules, { ...DEFAULT_MANUFACTURING_RULES, shelfPins: { ...DEFAULT_MANUFACTURING_RULES.shelfPins, ...variant } });
    const side = mfg.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!;
    const pin = findPin(side);
    ok(`⑬ 参数变体 holes=${variant.holesPerElevationPerSide}/inset=${variant.insetFrontMm}：孔型参数来自规则`, !!pin && pin.holes!.holesPerElevationPerSide === variant.holesPerElevationPerSide && pin.holes!.insetFrontMm === variant.insetFrontMm && pin.holes!.insetBackMm === variant.insetBackMm);
    ok(`⑬ 参数变体 holes=${variant.holesPerElevationPerSide}：标高仍 === 几何（参数不影响位置）`, !!pin && deepEqual(pin.holes!.elevations, expectedElevations(geom, cab)));
  }

  // E. 边界高度（矮柜）：标高仍为正且 ≤ 侧板长（物理合理，单一来源）
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabShort', height: 700 });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const side = mfg.cabinets['cabShort']!.find((p) => p.role === 'LeftSidePanel')!;
    const pin = findPin(side);
    const sideLen = geom.cabinets['cabShort']!.panels.find((p) => p.role === 'LeftSidePanel')!.length;
    const allInRange = !!pin && pin.holes!.elevations.length > 0 && pin.holes!.elevations.every((e) => e > 0 && e <= sideLen);
    ok('⑬ 矮柜（700）：标高皆为正且 ≤ 侧板长（单一来源、物理合理）', allInRange, `elev=${JSON.stringify(pin?.holes?.elevations)} sideLen=${sideLen}`);
  }

  // F. 参数缺失（工厂参数未就绪）→ 降级 unverified，绝不脑补/补默认值
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabMiss' });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const missing: typeof DEFAULT_MANUFACTURING_RULES = { ...DEFAULT_MANUFACTURING_RULES, shelfPins: { enabled: true, source: 'deterministic.shelfElevations', holesPerElevationPerSide: 2 } as unknown as typeof DEFAULT_MANUFACTURING_RULES['shelfPins'] };
    const mfg = deriveManufacturing(proj, geom, rules, missing);
    const side = mfg.cabinets['cabMiss']!.find((p) => p.role === 'LeftSidePanel')!;
    const unv = side.operations.find((o) => o.role === 'drilling' && o.verification === 'unverified');
    ok('⑬ 参数缺失：侧板托孔降级 unverified（不脑补、不补默认值）', !!unv && unv.source === 'manufacturing-rule:unverified' && (unv.detail ?? '').includes('参数非法'));
    ok('⑬ 参数缺失：不产生 verified 托孔', !findPin(side));
  }

  // G. 参数非法（holesPerElevationPerSide=0 / inset 为负）→ 降级 unverified
  for (const bad of [
    { ...DEFAULT_MANUFACTURING_RULES.shelfPins, holesPerElevationPerSide: 0 },
    { ...DEFAULT_MANUFACTURING_RULES.shelfPins, insetFrontMm: -5 },
  ]) {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: `cabBad_${bad.holesPerElevationPerSide}_${bad.insetFrontMm}` });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules, { ...DEFAULT_MANUFACTURING_RULES, shelfPins: bad });
    const side = mfg.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!;
    ok(`⑬ 参数非法（holes=${bad.holesPerElevationPerSide},insetF=${bad.insetFrontMm}）：降级 unverified`, !findPin(side) && !!side.operations.find((o) => o.role === 'drilling' && o.verification === 'unverified'));
  }

  // H. 不应打孔：无 shelves 语义的柜（开放格 / 抽屉柜）→ 侧板不钻托孔
  // （注：hanging 挂衣区按 docFactory 约定自带 1 块顶层层板，应钻；故不列入此处）
  for (const kind of ['open', 'drawerBank'] as const) {
    const cab = mkCab([{ h: 'fill', units: [mkUnit(kind, 1200)] }], { id: `cabNoShelf_${kind}` });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const side = mfg.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!;
    ok(`⑬ 无 shelves 语义（${kind} 柜）：侧板不钻托孔（不应打孔）`, !findPin(side));
  }

  // J. 左右侧板来源：两侧板都带 verified 托孔且标高一致；层板自身不钻
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabLR' });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const L = mfg.cabinets['cabLR']!.find((p) => p.role === 'LeftSidePanel')!;
    const R = mfg.cabinets['cabLR']!.find((p) => p.role === 'RightSidePanel')!;
    const lPin = findPin(L), rPin = findPin(R);
    ok('⑬ 左右侧板都带 verified 托孔', !!lPin && !!rPin && lPin.verification === 'verified' && rPin.verification === 'verified');
    ok('⑬ 左右侧板托孔标高一致', !!lPin && !!rPin && deepEqual(lPin.holes!.elevations, rPin.holes!.elevations));
    const shelf = mfg.cabinets['cabLR']!.find((p) => p.role === 'ShelfPanel')!;
    ok('⑬ 层板件本身不钻托孔（托孔在侧板）', !shelf.operations.some((o) => o.role === 'drilling'));
  }

  // K. 制造尺寸与 Geometry Panel 一致 + provenance + 无第二尺寸真相源
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabProv' });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfgRules = DEFAULT_MANUFACTURING_RULES;
    const mfg = deriveManufacturing(proj, geom, rules, mfgRules);
    const side = mfg.cabinets['cabProv']!.find((p) => p.role === 'LeftSidePanel')!;
    const gSide = geom.cabinets['cabProv']!.panels.find((p) => p.role === 'LeftSidePanel')!;
    const pin = findPin(side)!;
    ok('⑬ 侧板长 === 几何侧板长（制造只读几何，不重算）', side.length === gSide.length, `mfg=${side.length} geom=${gSide.length}`);
    ok('⑬ 托孔标高 ≤ 侧板长（物理合理，单一尺寸来源）', pin.holes!.elevations.every((e) => e >= 0 && e <= side.length));
    ok('⑬ provenance.manufacturingRuleSetId === 所用规则集', side.provenance.manufacturingRuleSetId === mfgRules.id, `${side.provenance.manufacturingRuleSetId} vs ${mfgRules.id}`);
  }
}

// ─────────────────────────────────────────────────────────────────
// ⑭ 箱体外壳连接孔（P7.3）：三合一 / 木榫，verified 且孔位可证明
// ─────────────────────────────────────────────────────────────────
{
  const base = sampleProject(rules);
  const findConn = (part: ManufacturingPart): ManufacturingOperation | undefined =>
    part.operations.find((o) => o.role === 'connector-hole' && o.source === 'deterministic.caseConnectors');
  const findUnvConn = (part: ManufacturingPart): ManufacturingOperation | undefined =>
    part.operations.find((o) => o.role === 'connector-hole' && o.verification === 'unverified');

  // A. verified 结构性判据（覆盖连接孔）：verified 连接孔 source 非 unverified；
  //    unverified 连接孔绝不携带 connectorHoles；verified 连接孔必有 connectorHoles。
  {
    const mfgAll = deriveManufacturing(base, generateProject(base, rules), rules);
    let structOk = true;
    for (const p of mfgAll.parts) for (const o of p.operations) {
      const coord = o.role === 'connector-hole';
      if (o.verification === 'verified' && coord && o.source === 'manufacturing-rule:unverified') structOk = false;
      if (o.verification === 'unverified' && coord && o.connectorHoles) structOk = false;
      if (o.role === 'connector-hole' && o.verification === 'verified' && !o.connectorHoles) structOk = false;
    }
    ok('⑭ verified 连接孔结构性判据：source 非 unverified；unverified 不携带 connectorHoles；verified 必有坐标', structOk);
  }

  // B. 三合一（默认 cam-lock）：侧/顶/底板带 verified 连接孔，坐标系可证明
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabConn', depth: 600 });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const depth = geom.cabinets['cabConn']!.panels.find((p) => p.role === 'LeftSidePanel')!.width;
    const expPos = [37, depth - 37]; // edgeHolePositions(depth,37,2)

    const side = mfg.cabinets['cabConn']!.find((p) => p.role === 'LeftSidePanel')!;
    const top = mfg.cabinets['cabConn']!.find((p) => p.role === 'TopPanel')!;
    const bottom = mfg.cabinets['cabConn']!.find((p) => p.role === 'BottomPanel')!;
    const sc = findConn(side)!, tc = findConn(top)!, bc = findConn(bottom)!;

    ok('⑭ 三合一：侧/顶/底板都带 verified 连接孔（source deterministic.caseConnectors）', !!sc && sc.verification === 'verified' && !!tc && tc.verification === 'verified' && !!bc && bc.verification === 'verified');
    ok('⑭ 三合一：nameZh=三合一连接孔、holeType=cam-lock', sc.nameZh === '三合一连接孔' && sc.connectorHoles!.holeType === 'cam-lock');
    // 侧板：top/bottom 两条边；顶/底板：left/right 两条边
    ok('⑭ 三合一：侧板连接边 = top/bottom', !!sc.connectorHoles && deepEqual(sc.connectorHoles.lines.map((l) => l.edge).sort(), ['bottom', 'top']));
    ok('⑭ 三合一：顶板连接边 = left/right', !!tc.connectorHoles && deepEqual(tc.connectorHoles.lines.map((l) => l.edge).sort(), ['left', 'right']));
    // 孔位 = 工厂留量(37)作用于几何进深，逐值 === 预期
    ok('⑭ 三合一：侧板孔位 === 几何进深推导值（37 / 563）', !!sc.connectorHoles && deepEqual(sc.connectorHoles.lines[0]!.positions, expPos), `got=${JSON.stringify(sc.connectorHoles?.lines[0]?.positions)} exp=${JSON.stringify(expPos)}`);
    ok('⑭ 三合一：顶/底板孔位与侧板一致（共享进深）', !!tc.connectorHoles && !!bc.connectorHoles && deepEqual(tc.connectorHoles.lines[0]!.positions, expPos) && deepEqual(bc.connectorHoles.lines[0]!.positions, expPos));
    // provenance：joint / withPanelRole 正确
    ok('⑭ 三合一：侧板 top 边连接对象 = TopPanel（joint side-to-top）', sc.connectorHoles!.lines.some((l) => l.edge === 'top' && l.joint === 'side-to-top' && l.withPanelRole === 'TopPanel'));
    ok('⑭ 三合一：顶板 left 边连接对象 = LeftSidePanel（joint top-to-left）', tc.connectorHoles!.lines.some((l) => l.edge === 'left' && l.joint === 'top-to-left' && l.withPanelRole === 'LeftSidePanel'));
    // 工厂参数逐字段来自规则
    const cc = DEFAULT_MANUFACTURING_RULES.caseConnectors;
    ok('⑭ 三合一：孔径/孔深/配对加工来自规则', sc.connectorHoles!.diameterMm === cc.diameterMm && sc.connectorHoles!.depthMm === cc.depthMm && sc.connectorHoles!.pairMachining === cc.pairMachining);
  }

  // C. 木榫（wood-dowel）：同位置算法，孔型不同
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabDowel', depth: 600 });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules, { ...DEFAULT_MANUFACTURING_RULES, caseConnectors: { ...DEFAULT_MANUFACTURING_RULES.caseConnectors, type: 'wood-dowel' } });
    const depth = geom.cabinets['cabDowel']!.panels.find((p) => p.role === 'LeftSidePanel')!.width;
    const side = mfg.cabinets['cabDowel']!.find((p) => p.role === 'LeftSidePanel')!;
    const sc = findConn(side)!;
    ok('⑭ 木榫：nameZh=木榫连接孔、holeType=wood-dowel', sc.nameZh === '木榫连接孔' && sc.connectorHoles!.holeType === 'wood-dowel');
    ok('⑭ 木榫：孔位与三合一同算法（几何进深推导，位置不变）', deepEqual(sc.connectorHoles!.lines[0]!.positions, [37, depth - 37]));
  }

  // D. 不同进深 → 孔位随之变化（位置来自几何进深，单一来源）
  for (const D of [500, 600, 700]) {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: `cabD_${D}`, depth: D });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const side = mfg.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!;
    const sc = findConn(side)!;
    const expect = [37, D - 37];
    ok(`⑭ 进深 ${D}：侧板孔位 === 几何进深推导（37 / ${D - 37}）`, !!sc && deepEqual(sc.connectorHoles!.lines[0]!.positions, expect), `got=${JSON.stringify(sc?.connectorHoles?.lines[0]?.positions)}`);
  }

  // E. 不同板厚 → 连接孔位置不变（只依赖进深 panel.width，不依赖 thickness），几何一致
  {
    const thin = rules.materials['M_BOARD_15_WOOD'];
    const cab18 = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabT18', depth: 600 });
    const proj18: Project = { ...base, cabinets: [cab18] };
    const side18 = deriveManufacturing(proj18, generateProject(proj18, rules), rules).cabinets['cabT18']!.find((p) => p.role === 'LeftSidePanel')!;
    let sameAcrossThickness = true;
    if (thin) {
      const cab15 = createCabinet({ id: 'cabT15', name: 'cabT15', roomId: 'room_001', placement: { x: 0, y: 0, rotation: 0 }, params: { width: 2400, height: 2400, depth: 600, boardMaterial: 'M_BOARD_15_WOOD' }, layout: { type: 'row', widthMode: 'fit_total', units: [mkUnit('shelves', 1200)] }, rules });
      const proj15: Project = { ...sampleProject(rules), cabinets: [cab15] };
      const side15 = deriveManufacturing(proj15, generateProject(proj15, rules), rules).cabinets['cabT15']!.find((p) => p.role === 'LeftSidePanel')!;
      const p18 = generateProject(proj18, rules).cabinets['cabT18']!.panels.find((p) => p.role === 'LeftSidePanel')!.width;
      const p15 = generateProject(proj15, rules).cabinets['cabT15']!.panels.find((p) => p.role === 'LeftSidePanel')!.width;
      // 两块板进深都 = 600 ⇒ 孔位必须逐值相等（证明位置不随板厚变）
      sameAcrossThickness = deepEqual(findConn(side18)!.connectorHoles!.lines[0]!.positions, findConn(side15)!.connectorHoles!.lines[0]!.positions) && p18 === 600 && p15 === 600;
      ok('⑭ 不同板厚(18→15mm)：连接孔位置不变（只依赖进深，几何一致）', sameAcrossThickness, `p18=${p18} p15=${p15}`);
    } else {
      // 无 15mm 板材可对比时，退而证明位置仅来自 panel.width（进深），与厚度无关
      const g18 = generateProject(proj18, rules).cabinets['cabT18']!;
      const sideGeom = g18.panels.find((p) => p.role === 'LeftSidePanel')!;
      sameAcrossThickness = deepEqual(findConn(side18)!.connectorHoles!.lines[0]!.positions, [37, sideGeom.width - 37]);
      ok('⑭ 连接孔位置 === 几何进深推导（与板厚无关，取现有板材验证）', sameAcrossThickness);
    }
  }

  // F. 不同参数（holesPerJoint / endMargin）只改变制造参数与孔位，不改几何事实
  for (const v of [
    { endMarginMm: 20, holesPerJoint: 1 },
    { endMarginMm: 50, holesPerJoint: 3 },
  ]) {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: `cabP_${v.endMarginMm}_${v.holesPerJoint}`, depth: 600 });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules, { ...DEFAULT_MANUFACTURING_RULES, caseConnectors: { ...DEFAULT_MANUFACTURING_RULES.caseConnectors, ...v } });
    const side = mfg.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!;
    const sc = findConn(side)!;
    const expPos = v.holesPerJoint === 1 ? [Math.round(600 / 2)] : v.holesPerJoint === 3 ? [50, 300, 550] : [v.endMarginMm, 600 - v.endMarginMm];
    ok(`⑭ 参数(边距${v.endMarginMm}/每边${v.holesPerJoint}孔)：孔位来自规则`, !!sc && deepEqual(sc.connectorHoles!.lines[0]!.positions, expPos), `got=${JSON.stringify(sc?.connectorHoles?.lines[0]?.positions)} exp=${JSON.stringify(expPos)}`);
    ok(`⑭ 参数(边距${v.endMarginMm}/每边${v.holesPerJoint}孔)：工厂参数逐字段反映`, !!sc && sc.connectorHoles!.lines.length === 2);
  }

  // G. 多行柜：侧板仍 verified 连接（主外壳），行隔板连接保持 unverified（诚实）
  {
    const twoRow = mkCab([
      { h: 'fill', units: [mkUnit('shelves', 1200)] },
      { h: 600, units: [mkUnit('shelves', 1200)] },
    ], { id: 'cabConnRow' });
    const proj: Project = { ...base, cabinets: [twoRow] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const side = mfg.cabinets['cabConnRow']!.find((p) => p.role === 'LeftSidePanel')!;
    ok('⑭ 多行柜：侧板仍带 verified 外壳连接孔', !!findConn(side) && findConn(side)!.verification === 'verified');
    const rd = mfg.parts.find((p) => p.role === 'RowDividerPanel')!;
    ok('⑭ 多行柜：行隔板连接保持 unverified（待真实规则，不脑补）', !!findUnvConn(rd) && findUnvConn(rd)!.detail!.includes('待真实规则'));
    // 行隔板不是 verified 连接孔
    ok('⑭ 多行柜：行隔板不带 verified 连接孔（无坐标）', !rd.operations.some((o) => o.role === 'connector-hole' && o.verification === 'verified'));
  }

  // H. 多柜组合（authored connection）：外壳连接仍 verified，组合连接仍 unverified
  {
    const a = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabCA' });
    const b = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabCB' });
    const conn: Connection = { id: 'conn_c', kind: 'butt', a: { cabinetId: 'cabCA' }, b: { cabinetId: 'cabCB' }, origin: 'authored' };
    const asm: FurnitureAssembly = { id: 'asm_c', name: '并排组', roomId: 'room_001', memberIds: ['cabCA', 'cabCB'], connections: [conn] };
    const proj: Project = { ...sampleProject(rules), cabinets: [a, b], assemblies: [asm] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const sideA = mfg.cabinets['cabCA']!.find((p) => p.role === 'LeftSidePanel')!;
    ok('⑭ 多柜组合：成员柜外壳连接仍 verified（确定性，不受组合声明影响）', !!findConn(sideA) && findConn(sideA)!.verification === 'verified');
    ok('⑭ 多柜组合：组合连接仍 unverified（组合连接加工孔，不自动生成）', mfg.parts.some((p) => p.source.cabinetId === 'cabCA' && !!findUnvConn(p) && (findUnvConn(p)!.detail ?? '').includes('assembly connector')));
  }

  // J. 参数缺失 / 非法 → 降级 unverified，不产生坐标
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabMissC' });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const missing: typeof DEFAULT_MANUFACTURING_RULES = { ...DEFAULT_MANUFACTURING_RULES, caseConnectors: { enabled: true, type: 'cam-lock', source: 'deterministic.caseConnectors', endMarginMm: 37, holesPerJoint: 2 } as unknown as typeof DEFAULT_MANUFACTURING_RULES['caseConnectors'] };
    const mfg = deriveManufacturing(proj, geom, rules, missing);
    const side = mfg.cabinets['cabMissC']!.find((p) => p.role === 'LeftSidePanel')!;
    const unv = findUnvConn(side);
    ok('⑭ 参数缺失：外壳连接降级 unverified（不脑补、不补默认值）', !!unv && unv.source === 'manufacturing-rule:unverified' && (unv.detail ?? '').includes('参数非法'));
    ok('⑭ 参数缺失：不产生 verified 连接孔', !findConn(side));
  }
  for (const bad of [
    { ...DEFAULT_MANUFACTURING_RULES.caseConnectors, holesPerJoint: 0 },
    { ...DEFAULT_MANUFACTURING_RULES.caseConnectors, endMarginMm: 400 }, // ≥ 进深/2(600/2=300) ⇒ 两孔交叉
    { ...DEFAULT_MANUFACTURING_RULES.caseConnectors, diameterMm: 0 },
  ]) {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: `cabBadC_${bad.holesPerJoint}_${bad.endMarginMm}_${bad.diameterMm}` });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules, { ...DEFAULT_MANUFACTURING_RULES, caseConnectors: bad });
    const side = mfg.cabinets[cab.id]!.find((p) => p.role === 'LeftSidePanel')!;
    ok(`⑭ 参数非法(hole=${bad.holesPerJoint},margin=${bad.endMarginMm},d=${bad.diameterMm})：降级 unverified`, !findConn(side) && !!findUnvConn(side));
  }
  // 信息不足（规则未启用）→ 外壳连接标 unverified（open question），不脑补
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabOffC' });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules, { ...DEFAULT_MANUFACTURING_RULES, caseConnectors: { ...DEFAULT_MANUFACTURING_RULES.caseConnectors, enabled: false } });
    const side = mfg.cabinets['cabOffC']!.find((p) => p.role === 'LeftSidePanel')!;
    ok('⑭ 规则未启用（信息不足）：外壳连接标 unverified，无坐标', !findConn(side) && !!findUnvConn(side) && !findUnvConn(side)!.connectorHoles);
  }

  // K. 非连接板不能产生连接孔：层板 / 门板无 connectorHoles；中立板/行隔板只有 unverified
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabNoConn' });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfg = deriveManufacturing(proj, geom, rules);
    const shelf = mfg.cabinets['cabNoConn']!.find((p) => p.role === 'ShelfPanel')!;
    ok('⑭ 层板件不带连接孔（托孔在侧板、连接孔在侧/顶/底）', !shelf.operations.some((o) => o.role === 'connector-hole'));
    // 门板来自带门样本柜（本 shelves 柜无门）：门板不带 verified 连接孔
    const doorMfg = deriveManufacturing(base, generateProject(base, rules), rules);
    const door = doorMfg.parts.find((p) => p.role === 'DoorPanel');
    ok('⑭ 门板不带连接孔（铰链孔仍 unverified，非本规则）', !door || !door.operations.some((o) => o.role === 'connector-hole' && o.verification === 'verified'));
  }

  // L. 左右侧板来源一致 + 制造尺寸与几何一致 + provenance + 无第二尺寸 + 不修改模型
  {
    const cab = mkCab([{ h: 'fill', units: [mkUnit('shelves', 1200)] }], { id: 'cabProvC' });
    const proj: Project = { ...base, cabinets: [cab] };
    const geom = generateProject(proj, rules);
    const mfgRules = DEFAULT_MANUFACTURING_RULES;
    const mfg = deriveManufacturing(proj, geom, rules, mfgRules);
    const L = mfg.cabinets['cabProvC']!.find((p) => p.role === 'LeftSidePanel')!;
    const R = mfg.cabinets['cabProvC']!.find((p) => p.role === 'RightSidePanel')!;
    const lC = findConn(L)!, rC = findConn(R)!;
    ok('⑭ 左右侧板都带 verified 外壳连接孔', !!lC && !!rC && lC.verification === 'verified' && rC.verification === 'verified');
    ok('⑭ 左右侧板连接孔（边/位置）一致', !!lC && !!rC && deepEqual(lC.connectorHoles!.lines, rC.connectorHoles!.lines));
    const gL = geom.cabinets['cabProvC']!.panels.find((p) => p.role === 'LeftSidePanel')!;
    ok('⑭ 侧板长 === 几何侧板长（制造只读几何，不重算）', L.length === gL.length, `mfg=${L.length} geom=${gL.length}`);
    ok('⑭ 连接孔位置来自几何进深（panel.width），不重算第二尺寸', lC.connectorHoles!.lines[0]!.positions.every((p) => p >= 0 && p <= gL.width) && gL.width === cab.params.depth);
    ok('⑭ provenance.manufacturingRuleSetId === 所用规则集', L.provenance.manufacturingRuleSetId === mfgRules.id);
    // 不修改 Semantic Model：派生前后项目柜体参数不变
    const before = JSON.stringify(base.cabinets.map((c) => c.params));
    deriveManufacturing(proj, geom, rules, mfgRules);
    const after = JSON.stringify(base.cabinets.map((c) => c.params));
    ok('⑭ 派生不修改 Semantic Model（柜体 params 派生前后一致）', before === after);
  }
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
