/**
 * ══════════════════════════════════════════════════════════════════════
 *  Manufacturing Model（P7）—— 可制造语义层
 *
 *  ── 这一层是什么 ──
 *    把「设计语义」继续向「可制造语义」推进的**确定性派生层**。
 *    输入是已经由 Semantic Model + Rules + Geometry 派生好的 CabinetGeometry
 *    （即几何板件 Panel[]），输出是描述「这个东西是什么、怎么制造」的
 *    ManufacturingPart[]。
 *
 *  ── 架构铁律（与 P0–P6 同源）──
 *    ① Semantic Model 是唯一真相源；Manufacturing 只**派生**，绝不回写模型。
 *    ② 制造尺寸（长/宽/厚/数量）**只读几何 Panel**，不允许 Manufacturing 重新算一遍
 *       —— 重算 = 第二份尺寸真相源 = 「图上 2400、料单 2399」的结构性风险。
 *    ③ AI / Vision / Import 不碰这一层；DXF / BOM 只消费这里的确定性结果。
 *    ④ 当前规则**不能**确定性给出的加工（钻孔 / 连接孔 / 五金安装孔 / 组合连接孔）
 *       一律标 `unverified`，**绝不脑补坐标或孔位**。
 *    ⑤ 每个 ManufacturingOperation 都有 role / source / confidence / verification，
 *       让「这一步加工到底靠不靠谱」对车间只有一个读法。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { EdgeSpec } from '../types.ts';

/** 制造的确定性状态：verified = 有规则/语义依据；unverified = 当前无法确认，不脑补 */
export type MfgVerification = 'verified' | 'unverified';

/**
 * 加工操作角色。这些是可扩展的——未来 CNC / 排孔 / 套料在此加枚举即可，
 * 不必动几何或 Semantic Model。
 */
export type MfgOperationRole =
  | 'edge-banding' // 封边（当前唯一 verified 的加工，来自几何 panel.edge）
  | 'back-panel-treatment' // 背板工艺（来自语义 cab.params.backPanel.method）
  | 'drilling' // 钻孔（层板托孔 / 铰链孔 / 抽屉五金孔）—— 当前 unverified
  | 'connector-hole' // 连接孔（箱体三合一 / 组合连接）—— 当前 unverified
  | 'groove' // 开槽（未来扩展点）
  | 'hardware-mount' // 五金安装（未来扩展点）
  | 'machining'; // 通用加工（未来扩展点）

/** 单条制造加工：角色 / 来源 / 置信 / 验证状态，四件套缺一不可 */
export interface ManufacturingOperation {
  role: MfgOperationRole;
  nameZh: string;
  /**
   * 这条操作的来源（审计 + 不脑补的核心）：
   *   'geometry.edge'            = 几何板件的封边边位（设计规则决定）
   *   'semantic.backPanel.method'= 语义层的背板工艺字段
   *   'manufacturing-rule:unverified' = 制造规则明确「这一步当前无法确认」
   */
  source: string;
  /** 确定性置信：verified 的能力给 high；未确认给 none（绝不拿估计顶替） */
  confidence: 'high' | 'medium' | 'low' | 'none';
  verification: MfgVerification;
  /** 生产可读的细节（封边边位 / 板条规格 / 工艺名 / 为何未确认） */
  detail?: string;
}

/** 制造件大类：回答「这是什么」而不只是一块矩形 */
export type MfgPartCategory =
  | 'case-shell' // 箱体结构板（侧/顶/底/中/踢脚/行隔板/中立板）
  | 'back' // 背板
  | 'shelf' // 层板
  | 'front' // 门板
  | 'drawer' // 抽屉各件
  | 'aperture' // 洞口过梁
  | 'misc';

/**
 * 制造件角色。与几何 Panel.role 一一对应（几何 role 已经是语义化的）：
 * 侧/顶/底/中/踢脚/中立板/行隔板/背板/层板/门板/抽屉件/过梁。
 * 制造层在此之上加 category / operations / 来源 / 验证状态。
 */
export type MfgPartRole =
  | 'LeftSidePanel'
  | 'RightSidePanel'
  | 'TopPanel'
  | 'BottomPanel'
  | 'KickBoard'
  | 'KickBoardBack'
  | 'MiddlePanel'
  | 'DividerPanel'
  | 'RowDividerPanel'
  | 'BackPanel'
  | 'ShelfPanel'
  | 'DoorPanel'
  | 'DrawerFront'
  | 'DrawerSide'
  | 'DrawerBack'
  | 'DrawerBottom'
  | 'ApertureLintel';

/** 制造件回指的语义实体（单一真相源的溯源链） */
export interface MfgPartSource {
  /** 所属柜体 id（Semantic Model 的 Cabinet.id） */
  cabinetId: string;
  /** 所属分区 id（UnitSpec.id），柜级结构板为 undefined */
  unitId?: string;
  /** 所属行 id（CabinetRow.id），柜级外壳板 / 行隔板为 undefined */
  rowId?: string;
  /** 派生几何板件 id（CabinetGeometry.panels[].id）—— ManufacturingPart.id 与之相等，1:1 可追溯 */
  geometryPanelId: string;
  /** 派生几何板件角色（= 本制造件的 role） */
  geometryRole: string;
}

export interface MfgWarning {
  code: string;
  severity: 'warning' | 'info';
  message: string;
}

/**
 * 制造件：一块板/一件从「是什么」到「怎么造」的完整描述。
 * 注意：长/宽/厚/数量/纹向/材质全部照搬几何 Panel（单一尺寸来源），
 * 额外字段（edgeLabel/group/belongsTo/layer）保留以便无损回投影到几何 Panel。
 */
export interface ManufacturingPart {
  /** 稳定 id，与几何 Panel.id 相等（1:1 可追溯，不另造 id） */
  id: string;
  geometryPanelId: string;
  role: MfgPartRole;
  category: MfgPartCategory;
  nameZh: string;
  source: MfgPartSource;
  material: string;
  materialName: string;
  thickness: number;
  length: number;
  width: number;
  qty: number;
  grain: 'length' | 'width' | 'none';
  /** 封边规格（来自几何 panel.edge，单一来源） */
  edge: EdgeSpec;
  /** 封边文字说明（保留，无损回投影用） */
  edgeLabel: string;
  /** 分组（保留，无损回投影用） */
  group: string;
  /** 所属（保留，无损回投影用） */
  belongsTo: string;
  /** 图层（保留，无损回投影用） */
  layer: string;
  /** 制造加工：每条都有 role/source/confidence/verification */
  operations: ManufacturingOperation[];
  /** 当前规则未能确定性确认的制造方面（必须显式暴露，不脑补） */
  unverified: string[];
  warnings: MfgWarning[];
  /** 整体验证状态：任一 unverified 操作 → 'unverified'（整体诚实） */
  verification: MfgVerification;
  provenance: { ruleSetId: string; manufacturingRuleSetId: string };
}

export interface ManufacturingProject {
  ruleSetId: string;
  manufacturingRuleSetId: string;
  /** 逐柜体：cabinetId → 该柜制造件列表 */
  cabinets: Record<string, ManufacturingPart[]>;
  /** 全项目制造件扁平列表 */
  parts: ManufacturingPart[];
  stats: {
    partCount: number;
    verifiedCount: number;
    unverifiedCount: number;
    byCategory: Record<MfgPartCategory, number>;
  };
  warnings: MfgWarning[];
}
