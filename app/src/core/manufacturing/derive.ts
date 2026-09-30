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
 *    · 已确认的 verified 加工走「确定性制造规则」并只在 ManufacturingRuleSet 注册后才升格：
 *      层板托孔（drilling，标高读几何 equalSpacing 事实）、箱体外壳连接孔（connector-hole，
 *      拓扑+进深读几何事实）。孔型/孔径/孔深/留量等来自制造规则集（工厂参数），不污染模型。
 *    · 组合（Assembly）的声明连接：**不自动生成 verified 加工**，
 *      只标一条 unverified 的 connector-hole（诚实说「未确认」）。
 *    · 纯函数、无副作用、无随机/无时间 → 同输入必得同输出（验收可钉）。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { Cabinet, CabinetGeometry, Panel, Project, ProjectGeometry, RuleSet } from '../types.ts';
import { layoutRows } from '../layoutModel.ts';
import { authoredConnections } from '../relations.ts';
import { equalSpacing } from '../allocate.ts';
import { DEFAULT_MANUFACTURING_RULES, type ManufacturingRuleSet } from './rules.ts';
import type {
  ManufacturingOperation,
  ManufacturingPart,
  ManufacturingProject,
  MfgConnectorHoleLine,
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
function edgeBandingOps(ctx: MfgRuleEvalCtx): ManufacturingOperation[] {
  const { panel, rules, mfgRules } = ctx;
  if (!mfgRules.edgeBanding.enabled) return [];
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

/** 背板工艺（verified）：来自语义 cab.params.backPanel.method。仅作用于背板件。 */
function backPanelOps(ctx: MfgRuleEvalCtx): ManufacturingOperation[] {
  const { cab, role } = ctx;
  if (role !== 'BackPanel') return [];
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
 *
 * 注意：层板托孔已升格为 verified（见 shelfPinOps，在侧板上钻），
 * 所以这里不再为 ShelfPanel 生成未确认的托孔。
 */
function unverifiedOps(role: MfgPartRole, inAuthoredAssembly: boolean, mfgRules: ManufacturingRuleSet): ManufacturingOperation[] {
  const ops: ManufacturingOperation[] = [];
  const drill = (nameZh: string, detail: string): void => {
    ops.push({ role: 'drilling', nameZh, source: 'manufacturing-rule:unverified', confidence: 'none', verification: 'unverified', detail });
  };
  const conn = (nameZh: string, detail: string): void => {
    ops.push({ role: 'connector-hole', nameZh, source: 'manufacturing-rule:unverified', confidence: 'none', verification: 'unverified', detail });
  };

  if (role === 'DoorPanel') drill('铰链孔', 'hinge boring；语义模型未携带孔位，需工厂排孔方案');
  if (role.startsWith('Drawer')) drill('抽屉五金安装孔', 'drawer hardware mount holes（滑轨/拉手）；语义模型未携带孔位');
  // 箱体外壳主连接（侧/顶/底）已由 caseConnectorOps 升格 verified；其余结构板
  // （中立板/行隔板/中板/背板/踢脚）的连接当前规则无法确定性推出孔位 → 仍 unverified
  const coveredByVerifiedCaseConn = mfgRules.caseConnectors.enabled && CASE_CONNECTOR_ROLES.includes(role);
  if (CASE_SHELL_ROLES.includes(role) && !coveredByVerifiedCaseConn) {
    conn('箱体连接孔', 'case connector holes（中立板/行隔板/中板/背板连接，待真实规则确认孔位）');
  }
  if (inAuthoredAssembly) conn('组合连接加工孔', 'assembly connector machining；未经制造规则确认，不自动生成');

  return ops;
}

/**
 * 层板托孔（第一条真实制造规则，verified）—— 只在侧板（Left/Right）上钻。
 *
 * ── 性质澄清（P7.2 架构审查结论）──
 *    `equalSpacing()` 位于 allocate.ts，是**几何辅助算法**（生成器/视图/3D 用它把层板摆到
 *    这些高度），**不是制造规则**。层板标高（孔位 Z）是**几何事实**：层板物理上就坐在
 *    这些高度。本规则做的是「在层板标高处钻孔」这个**确定性工艺决策**，因此：
 *      · 标高 = 读几何事实（基准 innerBottomZ = bodyLift + boardT，与生成器 edgeLabel 同源），
 *        制造层**只读、不另算一份布局**，不产生第二尺寸真相源；
 *      · 孔型参数（holesPerElevationPerSide / insetFrontMm / insetBackMm）才是**制造规则
 *        自己的工厂参数**——来自 mfgRules.shelfPins，不是几何、不是语义；
 *      · 「是否钻」的决策（enabled + 本柜存在带 shelves 的分区）是规则的确定性触发条件。
 *    满足 verified 升格 9 条（见 rules.ts VERIFIED_PROMOTION_CHECKLIST）。
 *
 * ── 参数合法性（verified 升格条件④：参数来源明确、可确定性推导）──
 *    mfgRules.shelfPins 的工厂参数缺失/非法 → 规则无法给出确定孔位，**降级为 unverified**
 *    （open question：需工厂校准真实参数），**绝不补默认值、绝不脑补坐标**。
 */
function shelfPinOps(ctx: MfgRuleEvalCtx): ManufacturingOperation[] {
  const { cab, g, mfgRules, role } = ctx;
  const pin = mfgRules.shelfPins;
  if (!pin.enabled) return [];
  // 托孔只在侧板（Left/Right）上钻；注册表对每块板都调用本 evaluator，这里自判适用面
  if (role !== 'LeftSidePanel' && role !== 'RightSidePanel') return [];

  // 工厂参数必须完整且合法，否则无法确定性推导孔位
  const paramsValid =
    typeof pin.holesPerElevationPerSide === 'number' && pin.holesPerElevationPerSide >= 1 &&
    typeof pin.insetFrontMm === 'number' && pin.insetFrontMm >= 0 &&
    typeof pin.insetBackMm === 'number' && pin.insetBackMm >= 0;
  if (!paramsValid) {
    return [
      {
        role: 'drilling',
        nameZh: '层板托孔',
        source: 'manufacturing-rule:unverified',
        confidence: 'none',
        verification: 'unverified',
        detail: `层板托孔：制造规则 shelfPins 参数非法（holesPerElevationPerSide=${pin.holesPerElevationPerSide}, insetFrontMm=${pin.insetFrontMm}, insetBackMm=${pin.insetBackMm}），无法确定性推导孔位，需工厂校准真实参数`,
      },
    ];
  }

  // 标高 = 几何事实：generate.ts 用同一 equalSpacing 把层板放到这些高度。
  // equalSpacing 是「几何辅助算法」，制造层在这里只是「读」这些已派生的层板标高作为钻孔位置。
  const L = g.layout;
  const innerBottomZ = cab.params.bodyLift + L.boardT;
  const set = new Set<number>();
  let hasShelf = false;
  for (const row of L.rows) {
    for (const u of row.units) {
      const s = u.shelves;
      if (s && s.count > 0) {
        hasShelf = true;
        for (const pos of equalSpacing(row.netH, s.count)) {
          set.add(Math.round(row.z0 - innerBottomZ + pos));
        }
      }
    }
  }
  if (!hasShelf) return [];
  const elevations = [...set].sort((a, b) => a - b);
  return [
    {
      role: 'drilling',
      nameZh: '层板托孔',
      source: 'deterministic.shelfElevations',
      confidence: 'high',
      verification: 'verified',
      detail: `侧板按层板标高钻托孔：标高 ${elevations.join('/')}mm（柜内底基准）；每标高每侧 ${pin.holesPerElevationPerSide} 孔，前后留量各 ${pin.insetFrontMm}/${pin.insetBackMm}mm`,
      holes: {
        reference: 'cabinet-inner-bottom',
        elevations,
        holesPerElevationPerSide: pin.holesPerElevationPerSide,
        insetFrontMm: pin.insetFrontMm,
        insetBackMm: pin.insetBackMm,
      },
    },
  ];
}

/**
 * 箱体连接孔沿边的位置（mm，从背面 Y=0 量起）。
 *
 * ── 这是「工厂留量作用于几何进深」的制造间距助手，不是几何事实、不是第二尺寸源 ──
 *   进深 = 本板 `panel.width`（= 柜进深 p.depth，几何事实，只读）。
 *   两端留 `endMargin`，中间按 `equalSpacing` 均布（与层板标高同款均布算法，但语义不同：
 *   那里是几何辅助算法读出的层板标高；这里是用工厂留量把连接孔沿边摆开）。
 */
function edgeHolePositions(depth: number, endMargin: number, count: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [Math.round(depth / 2)];
  if (count === 2) return [endMargin, depth - endMargin].map(Math.round);
  const interior = equalSpacing(depth - 2 * endMargin, count - 2);
  return [endMargin, ...interior.map((p) => endMargin + p), depth - endMargin].map(Math.round);
}

/** 箱体外壳主连接（P7.3 升格 verified 的子集）：侧↔顶/底、顶/底↔侧 */
const CASE_CONNECTOR_ROLES: MfgPartRole[] = ['LeftSidePanel', 'RightSidePanel', 'TopPanel', 'BottomPanel'];

/** 每块板在箱体外壳里要钻连接孔的边 + 连接对象（provenance） */
type ConnEdgeSpec = { edge: 'top' | 'bottom' | 'left' | 'right'; joint: MfgConnectorHoleLine['joint']; withPanelRole: MfgPartRole };
const CONNECTOR_EDGES: Record<string, ConnEdgeSpec[]> = {
  LeftSidePanel: [
    { edge: 'top', joint: 'side-to-top', withPanelRole: 'TopPanel' },
    { edge: 'bottom', joint: 'side-to-bottom', withPanelRole: 'BottomPanel' },
  ],
  RightSidePanel: [
    { edge: 'top', joint: 'side-to-top', withPanelRole: 'TopPanel' },
    { edge: 'bottom', joint: 'side-to-bottom', withPanelRole: 'BottomPanel' },
  ],
  TopPanel: [
    { edge: 'left', joint: 'top-to-left', withPanelRole: 'LeftSidePanel' },
    { edge: 'right', joint: 'top-to-right', withPanelRole: 'RightSidePanel' },
  ],
  BottomPanel: [
    { edge: 'left', joint: 'bottom-to-left', withPanelRole: 'LeftSidePanel' },
    { edge: 'right', joint: 'bottom-to-right', withPanelRole: 'RightSidePanel' },
  ],
};

/**
 * 箱体外壳连接孔（三合一 / 木榫）—— P7.3 第二条真实制造规则，verified。
 *
 * ── 性质澄清（与层板托孔同一范式：几何事实负责「孔在哪」+ 制造规则负责「怎么加工」）──
 *   几何事实（只读，不重算）：
 *     · 拓扑：侧板↔顶板/底板、顶板/底板↔侧板 由板件 role 直接判定（标准 carcass 永远存在）；
 *     · 进深这一维 = `panel.width`（= 柜进深 p.depth）—— 两侧/顶底板共享，单尺寸来源。
 *   工厂参数（来自 mfgRules.caseConnectors）：孔型 / 孔径 / 孔深 / 边距 / 每边孔数 / 配对加工。
 *   孔位坐标在「板件自身边 + 沿边位置（沿进深、从背面 Y=0 量）」里表达（见 model.ts
 *   MfgConnectorHoles），**不依赖柜体世界坐标、不重算板件尺寸**——满足 verified 9 条。
 *
 * ── 本阶段只做「最可证明的子集」──
 *   仅 role ∈ {LeftSide/RightSide/Top/Bottom} 升格；中立板/行隔板/中板/背板与侧板的连接、
 *   柜↔柜组合连接仍由 unverifiedOps 标 unverified（不伪造语义、不脑补坐标）。
 */
function caseConnectorOps(ctx: MfgRuleEvalCtx): ManufacturingOperation[] {
  const { role, panel, mfgRules } = ctx;
  const cc = mfgRules.caseConnectors;
  if (!cc.enabled) return [];
  if (!CASE_CONNECTOR_ROLES.includes(role)) return []; // 自判适用面（注册表对每块板都调用）

  // 几何事实：进深 = panel.width（= p.depth），只读。两孔不得交叉 ⇒ endMargin*2 < depth
  const depth = panel.width;
  const paramsValid =
    (cc.type === 'cam-lock' || cc.type === 'wood-dowel') &&
    typeof cc.endMarginMm === 'number' && cc.endMarginMm >= 0 && cc.endMarginMm * 2 < depth &&
    Number.isInteger(cc.holesPerJoint) && cc.holesPerJoint >= 1 &&
    typeof cc.diameterMm === 'number' && cc.diameterMm > 0 &&
    typeof cc.depthMm === 'number' && cc.depthMm > 0;
  if (!paramsValid) {
    return [
      {
        role: 'connector-hole',
        nameZh: cc.type === 'wood-dowel' ? '木榫连接孔' : '三合一连接孔',
        source: 'manufacturing-rule:unverified',
        confidence: 'none',
        verification: 'unverified',
        detail: `箱体外壳连接孔：制造规则 caseConnectors 参数非法（type=${cc.type}, endMarginMm=${cc.endMarginMm}, holesPerJoint=${cc.holesPerJoint}, diameterMm=${cc.diameterMm}, depthMm=${cc.depthMm}），无法确定性推导孔位，需工厂校准真实参数`,
      },
    ];
  }

  const edges = CONNECTOR_EDGES[role]!;
  const positions = edgeHolePositions(depth, cc.endMarginMm, cc.holesPerJoint);
  const typeZh = cc.type === 'wood-dowel' ? '木榫' : '三合一';
  return [
    {
      role: 'connector-hole',
      nameZh: cc.type === 'wood-dowel' ? '木榫连接孔' : '三合一连接孔',
      source: 'deterministic.caseConnectors',
      confidence: 'high',
      verification: 'verified',
      detail: `${typeZh}连接孔：${role} 在 ${edges.map((e) => e.edge).join('/')} 边钻，沿进深位置 ${positions.join('/')}mm（进深${depth}mm、边距${cc.endMarginMm}mm、每边${cc.holesPerJoint}孔）；孔径${cc.diameterMm}mm 孔深${cc.depthMm}mm；与对侧板配对加工`,
      connectorHoles: {
        holeType: cc.type,
        diameterMm: cc.diameterMm,
        depthMm: cc.depthMm,
        pairMachining: cc.pairMachining,
        lines: edges.map((e) => ({ edge: e.edge, positions, joint: e.joint, withPanelRole: e.withPanelRole })),
      },
    },
  ];
}

/**
 * verified 制造规则求值器统一上下文。
 * 每条真实制造规则（封边 / 背板 / 层板托孔 / 箱体外壳连接孔 / 未来的铰链孔 / 木榫 / 背板槽 …）
 * 都是一个纯函数 evaluator：只读几何/语义/规则集，**绝不另算尺寸、绝不脑补坐标**，
 * 自己判断「是否适用于本板/本柜」并返回操作列表（不适用返回空）。
 */
interface MfgRuleEvalCtx {
  panel: Panel;
  role: MfgPartRole;
  cab: Cabinet;
  g: CabinetGeometry;
  rules: RuleSet;
  mfgRules: ManufacturingRuleSet;
}

type VerifiedEvaluator = (ctx: MfgRuleEvalCtx) => ManufacturingOperation[];

/**
 * 已确认的 verified 制造规则注册表（P7.2 架构审查落点）。
 * 新增一条真实制造规则 = 在此注册一个 evaluator（在 rules.ts 加接口+默认、在 derive.ts 加
 * 纯函数），**不必在 buildPart 里堆针对加工类型的 if/else**；列表式派发天然可扩展。
 * 顺序无关（各 evaluator 独立、不互相覆盖）。
 */
const VERIFIED_RULE_EVALUATORS: VerifiedEvaluator[] = [edgeBandingOps, backPanelOps, shelfPinOps, caseConnectorOps];

function buildPart(
  panel: Panel,
  cab: Cabinet,
  g: CabinetGeometry,
  rules: RuleSet,
  mfgRules: ManufacturingRuleSet,
  inAuthoredAssembly: boolean,
): ManufacturingPart {
  const role = panel.role as MfgPartRole;
  const ctx: MfgRuleEvalCtx = { panel, role, cab, g, rules, mfgRules };
  const verifiedOps = VERIFIED_RULE_EVALUATORS.flatMap((ev) => ev(ctx));

  const unverified = unverifiedOps(role, inAuthoredAssembly, mfgRules);
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
    const list = g.panels.map((panel) => buildPart(panel, cab, g, rules, mfgRules, inAuthoredAssembly.has(cab.id)));
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
