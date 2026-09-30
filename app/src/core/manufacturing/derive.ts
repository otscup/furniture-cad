/**
 * ══════════════════════════════════════════════════════════════════════
 *  deriveManufacturing —— Semantic Model + Rules + Geometry → 制造件
 *
 *  ── 这是 P7 的唯一派生入口 ──
 *    输入：Project（Semantic Model）+ ProjectGeometry（已派生好的几何板件）
 *          + RuleSet（设计规则）+ ManufacturingRuleSet（制造规则）。
 *    输出：ManufacturingProject（每柜一块板的「是什么 + 怎么造」确定性描述）。
 *
 *  ── 关键纪律（逐条对照主方案 P7 要求）──
 *    · 长/宽/厚/数量/纹向/材质：**只读几何 Panel**，Manufacturing 不重算一个 mm。
 *    · 封边（verified）：来自几何 panel.edge（设计规则决定边位）。
 *    · 背板工艺（verified）：来自语义 cab.params.backPanel.method。
 *    · 钻孔 / 连接孔 / 五金安装孔：**当前规则无法确认** → 生成
 *      verification='unverified' 的操作，**绝不编造孔位/坐标**。
 *    · 组合（Assembly）的声明连接：**不自动生成 verified 加工**，
 *      只标一条 unverified 的 connector-hole（诚实说「未确认」）。
 *    · 纯函数、无副作用、无随机/无时间 → 同输入必得同输出（验收可钉）。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { Cabinet, Panel, Project, ProjectGeometry, RuleSet } from '../types.ts';
import { layoutRows } from '../layoutModel.ts';
import { authoredConnections } from '../relations.ts';
import { DEFAULT_MANUFACTURING_RULES, type ManufacturingRuleSet } from './rules.ts';
import type {
  ManufacturingOperation,
  ManufacturingPart,
  ManufacturingProject,
  MfgPartCategory,
  MfgPartRole,
  MfgPartSource,
  MfgWarning,
} from './model.ts';

/** 几何角色 → 制造大类（回答「这是什么」而不只是一块矩形） */
const ROLE_CATEGORY: Record<MfgPartRole, MfgPartCategory> = {
  LeftSidePanel: 'case-shell',
  RightSidePanel: 'case-shell',
  TopPanel: 'case-shell',
  BottomPanel: 'case-shell',
  KickBoard: 'case-shell',
  KickBoardBack: 'case-shell',
  MiddlePanel: 'case-shell',
  DividerPanel: 'case-shell',
  RowDividerPanel: 'case-shell',
  BackPanel: 'back',
  ShelfPanel: 'shelf',
  DoorPanel: 'front',
  DrawerFront: 'drawer',
  DrawerSide: 'drawer',
  DrawerBack: 'drawer',
  DrawerBottom: 'drawer',
  ApertureLintel: 'aperture',
};

/** 箱体结构板（这些才可能要三合一/木榫连接孔） */
const CASE_SHELL_ROLES: MfgPartRole[] = [
  'LeftSidePanel',
  'RightSidePanel',
  'TopPanel',
  'BottomPanel',
  'MiddlePanel',
  'DividerPanel',
  'RowDividerPanel',
];

/**
 * 解析制造件回指的语义实体。
 *  · cabinetId / unitId：从几何 panel.belongsTo（格式 `${cabId}` 或 `${cabId}.${uid}`）拆出。
 *  · rowId：多行柜的 DividerPanel 从 panel.id 的 `R{n}_` 标签定位；
 *           分区级板件（层板/门/抽/过梁）用 layoutRows 找到含该 unit 的行。
 *  单行柜：unitId 命中时行就是唯一的 `rows[0]`，回指准确。
 */
function parseSource(panel: Panel, cab: Cabinet): MfgPartSource {
  const belongs = panel.belongsTo;
  const dot = belongs.indexOf('.');
  const cabinetId = dot >= 0 ? belongs.slice(0, dot) : belongs;
  const unitId = dot >= 0 ? belongs.slice(dot + 1) : undefined;

  let rowId: string | undefined;
  const rTag = panel.id.match(/_R(\d+)_/);
  if (rTag) {
    const idx = Number(rTag[1]) - 1;
    rowId = layoutRows(cab.layout)[idx]?.id;
  } else if (unitId) {
    for (const r of layoutRows(cab.layout)) {
      if (r.units.some((u) => u.id === unitId)) {
        rowId = r.id;
        break;
      }
    }
  }

  return { cabinetId, unitId, rowId, geometryPanelId: panel.id, geometryRole: panel.role };
}

/** 封边操作（verified）：来自几何 panel.edge，制造层照单收 */
function edgeBandingOps(panel: Panel, rules: RuleSet): ManufacturingOperation[] {
  const e = panel.edge;
  if (!e) return [];
  const edges: string[] = [];
  if (e.top) edges.push('上');
  if (e.bottom) edges.push('下');
  if (e.left) edges.push('左');
  if (e.right) edges.push('右');
  if (edges.length === 0) return [];
  const specIds = [e.top, e.bottom, e.left, e.right].filter(Boolean) as string[];
  const bandNames = [...new Set(specIds.map((id) => rules.edgebanding[id]?.name ?? id))].join(' / ');
  return [
    {
      role: 'edge-banding',
      nameZh: '封边',
      source: 'geometry.edge',
      confidence: 'high',
      verification: 'verified',
      detail: `边位：${edges.join('·')}；板条：${bandNames}`,
    },
  ];
}

/** 背板工艺（verified）：来自语义 cab.params.backPanel.method */
function backPanelOps(cab: Cabinet): ManufacturingOperation[] {
  const bp = cab.params.backPanel;
  if (bp.method === 'groove') {
    return [
      {
        role: 'back-panel-treatment',
        nameZh: '背板开槽嵌入',
        source: 'semantic.backPanel.method',
        confidence: 'high',
        verification: 'verified',
        detail: `开槽深 ${bp.grooveDepth}mm，留边 ${bp.grooveSetback}mm`,
      },
    ];
  }
  return [
    {
      role: 'back-panel-treatment',
      nameZh: '背板嵌装（卡条/螺丝）',
      source: 'semantic.backPanel.method',
      confidence: 'high',
      verification: 'verified',
      detail: `留缝 ${bp.clearance}mm`,
    },
  ];
}

/**
 * 当前规则无法确认的加工 → unverified 操作（绝不脑补孔位/坐标）。
 * 每个都带 verification='unverified' + confidence='none' + 明确 detail 说明为何未确认。
 */
function unverifiedOps(role: MfgPartRole, inAuthoredAssembly: boolean): ManufacturingOperation[] {
  const ops: ManufacturingOperation[] = [];
  const drill = (nameZh: string, detail: string): void => {
    ops.push({ role: 'drilling', nameZh, source: 'manufacturing-rule:unverified', confidence: 'none', verification: 'unverified', detail });
  };
  const conn = (nameZh: string, detail: string): void => {
    ops.push({ role: 'connector-hole', nameZh, source: 'manufacturing-rule:unverified', confidence: 'none', verification: 'unverified', detail });
  };

  if (role === 'ShelfPanel') drill('层板托孔', 'shelf-pin holes；语义模型未携带孔位，需工厂排孔方案');
  if (role === 'DoorPanel') drill('铰链孔', 'hinge boring；语义模型未携带孔位，需工厂排孔方案');
  if (role.startsWith('Drawer')) drill('抽屉五金安装孔', 'drawer hardware mount holes（滑轨/拉手）；语义模型未携带孔位');
  if (CASE_SHELL_ROLES.includes(role)) conn('箱体连接孔', 'case connector holes（三合一/木榫）；语义模型未携带孔位');
  if (inAuthoredAssembly) conn('组合连接加工孔', 'assembly connector machining；未经制造规则确认，不自动生成');

  return ops;
}

function buildPart(
  panel: Panel,
  cab: Cabinet,
  rules: RuleSet,
  mfgRules: ManufacturingRuleSet,
  inAuthoredAssembly: boolean,
): ManufacturingPart {
  const role = panel.role as MfgPartRole;
  const verifiedOps: ManufacturingOperation[] = [];
  if (mfgRules.edgeBanding.enabled) verifiedOps.push(...edgeBandingOps(panel, rules));
  if (role === 'BackPanel') verifiedOps.push(...backPanelOps(cab));

  const unverified = unverifiedOps(role, inAuthoredAssembly);
  const allOps = [...verifiedOps, ...unverified];

  return {
    id: panel.id,
    geometryPanelId: panel.id,
    role,
    category: ROLE_CATEGORY[role],
    nameZh: panel.nameZh,
    source: parseSource(panel, cab),
    material: panel.material,
    materialName: rules.materials[panel.material]?.name ?? panel.material,
    thickness: panel.thickness,
    length: panel.length,
    width: panel.width,
    qty: panel.qty,
    grain: panel.grain,
    edge: panel.edge,
    edgeLabel: panel.edgeLabel,
    group: panel.group,
    belongsTo: panel.belongsTo,
    layer: panel.layer,
    operations: allOps,
    unverified: unverified.map((o) => o.detail ?? o.nameZh),
    warnings: inAuthoredAssembly
      ? [{ code: 'MFG-ASSEMBLY-CONN-UNVERIFIED', severity: 'info', message: `柜体属于已声明组合；组合连接加工孔未由制造规则确认，不自动生成（详见 unverified）` }]
      : [],
    verification: unverified.length > 0 ? 'unverified' : 'verified',
    provenance: { ruleSetId: rules.id, manufacturingRuleSetId: mfgRules.id },
  };
}

/**
 * 项目级制造派生（确定性、纯函数）。
 *
 * @param project  Semantic Model（真相源，提供 backPanel.method / 行 / 分区 / 组合）
 * @param geom     已由 Semantic Model + Rules + Geometry 派生好的几何（板件唯一来源）
 * @param rules    设计规则集（提供材质名 / 封边板条名）
 * @param mfgRules 制造规则集（默认 factory default；换工厂换此文件）
 */
export function deriveManufacturing(
  project: Project,
  geom: ProjectGeometry,
  rules: RuleSet,
  mfgRules: ManufacturingRuleSet = DEFAULT_MANUFACTURING_RULES,
): ManufacturingProject {
  // 收集「属于已声明（authored）组合」的柜体 id —— 这些柜体的板件要标组合连接未确认
  const inAuthoredAssembly = new Set<string>();
  for (const { conn } of authoredConnections(project)) {
    if (conn.origin === 'authored') {
      inAuthoredAssembly.add(conn.a.cabinetId);
      inAuthoredAssembly.add(conn.b.cabinetId);
    }
  }

  const cabinets: Record<string, ManufacturingPart[]> = {};
  const parts: ManufacturingPart[] = [];
  const warnings: MfgWarning[] = [];

  for (const cab of project.cabinets) {
    const g = geom.cabinets[cab.id];
    if (!g) {
      warnings.push({ code: 'MFG-CABINET-NO-GEOM', severity: 'warning', message: `柜体「${cab.name}」无派生几何，跳过制造派生` });
      continue;
    }
    const list = g.panels.map((panel) => buildPart(panel, cab, rules, mfgRules, inAuthoredAssembly.has(cab.id)));
    cabinets[cab.id] = list;
    parts.push(...list);
  }

  const byCategory = {} as Record<MfgPartCategory, number>;
  let verifiedCount = 0;
  let unverifiedCount = 0;
  for (const p of parts) {
    byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
    if (p.verification === 'verified') verifiedCount++;
    else unverifiedCount++;
  }

  return {
    ruleSetId: rules.id,
    manufacturingRuleSetId: mfgRules.id,
    cabinets,
    parts,
    stats: { partCount: parts.length, verifiedCount, unverifiedCount, byCategory },
    warnings,
  };
}
