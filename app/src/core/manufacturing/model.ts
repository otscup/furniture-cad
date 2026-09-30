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
  | 'connector-hole' // 连接孔（箱体外壳三合一 / 木榫可 verified；组合连接仍 unverified）
  | 'groove' // 开槽（未来扩展点）
  | 'hardware-mount' // 五金安装（未来扩展点）
  | 'machining'; // 通用加工（未来扩展点）

/** 钻孔的坐标描述 —— **只有 verified 钻孔才允许填**，unverified 一律不填（绝不脑补坐标）。 */
export interface MfgDrillHoles {
  /**
   * 孔位基准：柜内底面（唯一 Z 锚点）。
   * 与生成器板件 edgeLabel 的「距柜内底 Nmm」同源 —— 车间对同一个高度只有一个读法，
   * 不必先问「哪一行的内底」。这样制造层读的是几何已派生的标高，不另算一份。
   */
  reference: 'cabinet-inner-bottom';
  /** 每侧板的孔位标高（mm，自柜内底向上）。来自几何 equalSpacing（层板标高），非猜测。 */
  elevations: number[];
  /** 每标高每侧板的孔数（前 + 后，或工厂约定）。属于制造工艺留量，来自制造规则，非几何。 */
  holesPerElevationPerSide: number;
  /** 前 / 后距板边的工艺留量（mm，来自制造规则 shelfPins，非几何） */
  insetFrontMm: number;
  insetBackMm: number;
}

/**
 * 箱体连接孔（三合一 / 木榫）的坐标描述 —— **只有 verified 连接孔才允许填**，
 * unverified 一律不填（绝不脑补坐标）。
 *
 * ── 坐标约定（关键：不依赖柜体世界坐标、不依赖第二套尺寸）──
 *   连接孔沿板件的**某条边**钻，孔位用「面板自身坐标系」表达：
 *     · `edge`        = 这块板自己的哪条边（板件边缘，CNC 直接认）；
 *     · `positions`   = 沿该边的位置（mm，**沿进深方向、从背面 Y=0 量起**）；
 *     · 进深这一维 = 本板 `panel.width`（= 柜进深 p.depth），**只读几何，不另算**。
 *   为什么能这样做：箱体外壳主连接（侧板↔顶板/底板、顶板/底板↔侧板）的孔线永远
 *   平行于进深轴、在两侧/顶底板各自的边缘上 —— 同一套 `positions` 对两块板都成立
 *   （它们共享进深），所以在每块板各自的「边 + 沿边位置」里描述即可，无需柜体 Z。
 *   这样制造层只读 `panel.width`（单一尺寸来源），不重新计算任何板件尺寸。
 */
export interface MfgConnectorHoles {
  /** 五金类型：三合一（偏心件+连接杆）或木榫。来自制造规则，非几何非语义。 */
  holeType: 'cam-lock' | 'wood-dowel';
  /** 孔径（mm）。工厂参数。 */
  diameterMm: number;
  /** 孔深（mm，沿板厚方向钻入）。工厂参数（应 ≤ 板厚）。 */
  depthMm: number;
  /** 是否两块板配对加工（箱体外壳连接恒为 true：侧与顶/底都钻）。 */
  pairMachining: boolean;
  /** 本板每条需钻连接孔的边 + 沿边孔位 + 连接对象（provenance）。 */
  lines: MfgConnectorHoleLine[];
}

/** 单条连接孔线（某块板的一条边上的全部连接孔） */
export interface MfgConnectorHoleLine {
  /** 这块板自己的哪条边（板件边缘）。 */
  edge: 'top' | 'bottom' | 'left' | 'right' | 'front' | 'back';
  /** 沿该边的孔位（mm，沿进深从背面 Y=0 量起）。**来自工厂留量规则作用于几何进深**。 */
  positions: number[];
  /** 这条线对应哪种连接（provenance，便于审计与排产）。 */
  joint: 'side-to-top' | 'side-to-bottom' | 'top-to-left' | 'top-to-right' | 'bottom-to-left' | 'bottom-to-right';
  /** 连接到的另一块板（geometry role，provenance）。 */
  withPanelRole: MfgPartRole;
}

/** 单条制造加工：角色 / 来源 / 置信 / 验证状态，四件套缺一不可 */
export interface ManufacturingOperation {
  role: MfgOperationRole;
  nameZh: string;
  /**
   * 这条操作的来源（审计 + 不脑补的核心）：
   *   'geometry.edge'            = 几何板件的封边边位（设计规则决定）
   *   'semantic.backPanel.method'= 语义层的背板工艺字段
   *   'deterministic.shelfElevations' = 层板标高来自几何 equalSpacing（柜内底基准）
   *   'manufacturing-rule:unverified' = 制造规则明确「这一步当前无法确认」
   */
  source: string;
  /** 确定性置信：verified 的能力给 high；未确认给 none（绝不拿估计顶替） */
  confidence: 'high' | 'medium' | 'low' | 'none';
  verification: MfgVerification;
  /** 生产可读的细节（封边边位 / 板条规格 / 工艺名 / 为何未确认） */
  detail?: string;
  /** 钻孔坐标（仅 verified 钻孔填；unverified 不填，避免下料尺寸被猜出来） */
  holes?: MfgDrillHoles;
  /** 连接孔坐标（仅 verified 连接孔填；unverified 不填，避免孔位被猜出来） */
  connectorHoles?: MfgConnectorHoles;
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
