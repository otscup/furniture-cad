/**
 * ══════════════════════════════════════════════════════════════════════
 *  制造规则层（P7）—— 与「设计规则 RuleSet」清晰分离
 *
 *  ── 为什么单独一层 ──
 *    设计层（RuleSet）回答「这个柜子有什么板、多厚」（语义 + 约束）；
 *    制造层（ManufacturingRuleSet）回答「这块板要什么封边、什么背板工艺、
 *    哪些加工当前能确认、哪些必须标记 unverified」。
 *
 *    两者有关，但不是同一个对象：换工厂 = 换制造规则文件，不该动设计规则，
 *    更不该动 Semantic Model。这正是主方案「设计语义 → 结构语义 → 制造语义」
 *    三段式推进的落点之一。
 *
 *  ── 当前默认规则的核心纪律 ──
 *    明确列出「本阶段能确定性确认的加工」与「必须标 unverified 的加工」。
 *    制造派生层只读这里，绝不自己发明加工。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 哪些几何板件角色需要封边。
 * 真正的封边边位来自几何 Panel.edge（设计规则决定），制造层只「照单收」并确认。
 */
export interface MfgEdgeBandingRule {
  enabled: boolean;
  /** 封边边位的唯一来源，制造层不另算 */
  source: 'geometry.edge';
}

/**
 * 背板工艺来源。来自语义层 cab.params.backPanel.method（'groove' | 'inset'），
 * 制造层只确认这个方法，不自行决定工艺。
 */
export interface MfgBackPanelRule {
  source: 'semantic.backPanel.method';
}

/**
 * 层板托孔（第一条真实制造规则，P7.1）。
 *
 * ── verified 升格条件（缺一不可）──
 *   ① mfgRules.shelfPins.enabled = true；
 *   ② 柜体存在带 shelves 的分区（shelves.count > 0）；
 *   ③ 孔位标高**全部来自几何**（equalSpacing(row.netH, count) 的层板标高，
 *      基准为柜内底，与生成器板件 edgeLabel 同源）—— 不重算、不猜；
 *   ④ 横向留量（insetFrontMm / insetBackMm / holesPerElevationPerSide）
 *      是**工厂工艺参数**（来自本规则），不是语义、不是几何。
 *
 * ── 铁律 ──
 *   孔位坐标**绝不**由 AI / Vision / Import 提供；它们只表达语义，
 *   孔位必须由本确定性规则从几何派生。若某柜体没有 shelves（无法定派生标高），
 *   层板托孔保持 unverified，不升格。
 */
export interface MfgShelfPinRule {
  enabled: boolean;
  /** 标高来源：几何 equalSpacing（柜内底基准）。制造层只读，不另算。 */
  source: 'deterministic.shelfElevations';
  /** 每标高每侧板的孔数（前 + 后两孔的标准可调层板系统）。工厂参数。 */
  holesPerElevationPerSide: number;
  /** 前边距板边留量（mm）。工厂参数。 */
  insetFrontMm: number;
  /** 后边距板边留量（mm）。工厂参数。 */
  insetBackMm: number;
}

/**
 * 当前制造规则**尚未**能确定性给出的加工。
 * 制造派生层遇到这些角色/连接，一律标 unverified，**绝不脑补孔位或坐标**。
 */
export interface ManufacturingRuleSet {
  id: string;
  name: string;
  note: string;
  edgeBanding: MfgEdgeBandingRule;
  backPanel: MfgBackPanelRule;
  shelfPins: MfgShelfPinRule;
  /**
   * 必须标记 unverified 的制造方面（按角色/连接罗列，便于审计与未来逐项点亮）。
   * 这些不是「不做」，而是「当前规则无法确认，需工厂排孔/工艺方案补」。
   */
  unverifiedAspects: string[];
}

export const DEFAULT_MANUFACTURING_RULES: ManufacturingRuleSet = {
  id: 'mfg_factory_default_v1',
  name: '工厂默认制造规则（占位，待真实工厂校准）',
  note: 'P7 占位值。换工厂 = 换本文件，不改代码。已确认能力：封边、背板工艺、层板托孔（几何标高派生，侧板钻孔）。其余加工标 unverified。',
  edgeBanding: { enabled: true, source: 'geometry.edge' },
  backPanel: { source: 'semantic.backPanel.method' },
  shelfPins: {
    enabled: true,
    source: 'deterministic.shelfElevations',
    holesPerElevationPerSide: 2,
    insetFrontMm: 37,
    insetBackMm: 37,
  },
  unverifiedAspects: [
    'hinge boring（铰链孔）',
    'drawer hardware mount holes（抽屉五金安装孔）',
    'case connector holes（箱体三合一/木榫连接孔）',
    'assembly connector machining（组合连接加工孔）',
  ],
};
