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
 * verified 升格标准（P7.2 落定，铁律）。
 * 一条制造加工要进入 `verified`，必须**同时满足**以下全部 9 条；否则保持
 * `unverified`（当前规则无法确认）或 `unsupported`（本阶段不支持）。
 * 任何一条不满足都不得标 verified，更不得让 AI / Vision / Import 的输出替它升格。
 */
export const VERIFIED_PROMOTION_CHECKLIST: readonly string[] = [
  '① 输入语义事实明确（如 shelves.count > 0）',
  '② 制造规则确定（加工逻辑是确定性规则，非启发式）',
  '③ 参数来源明确（孔型/留量等参数来自 ManufacturingRuleSet 的工厂参数，可追）',
  '④ 加工结果可确定性推导（同输入必得同输出，可被自动化测试钉）',
  '⑤ 不依赖 AI 猜测',
  '⑥ 不依赖 Vision 猜测',
  '⑦ 不依赖 Import 猜测',
  '⑧ 不产生第二尺寸真相源（制造尺寸只读几何 Panel，不重算）',
  '⑨ 能够被自动化测试验证',
] as const;

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
 * 层板托孔（第一条真实制造规则，P7.1）。满足 VERIFIED_PROMOTION_CHECKLIST 全部 9 条。
 *
 * ── 性质澄清（P7.2 架构审查）──
 *   `equalSpacing()`（allocate.ts）是**几何辅助算法**，不是制造规则；层板标高（孔位 Z）
 *   是**几何事实**（层板物理就坐在这些高度）。本规则 = 「在层板标高处钻孔」这个确定性工艺决策：
 *     · 标高读几何事实（基准 innerBottomZ = bodyLift + boardT，与生成器 edgeLabel 同源），
 *       制造层只读、不产生第二尺寸真相源；
 *     · holesPerElevationPerSide / insetFrontMm / insetBackMm 才是**本规则的工厂参数**，
 *       不是语义、不是几何。
 *
 * ── verified 升格触发（确定性，缺一不可）──
 *   ① mfgRules.shelfPins.enabled = true；
 *   ② 柜体存在带 shelves 的分区（shelves.count > 0）；
 *   ③ 孔位标高全部来自几何（equalSpacing 的层板标高，柜内底基准）—— 不重算、不猜；
 *   ④ 工厂参数合法且来源明确（见 derive.ts 参数校验；缺失/非法 → 降级 unverified）。
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
 * 箱体外壳连接孔（三合一 / 木榫）—— P7.3 第二条真实制造规则，满足 VERIFIED_PROMOTION_CHECKLIST。
 *
 * ── 性质澄清（与 P7.2 层板托孔一脉相承）──
 *   箱体外壳是几何事实：侧板、顶板、底板永远存在且彼此相接（标准 carcass）。
 *   连接的「孔在哪里」由两部分决定：
 *     · **几何事实**：哪两块板连接 + 连接边 + 进深这一维（`panel.width` = p.depth）。
 *       拓扑（侧↔顶/底、顶/底↔侧）由板件 role 直接判定，制造层只读、不重算、不猜。
 *     · **工厂参数**：孔型（三合一/木榫）、孔径、孔深、边距、每边孔数、是否配对加工。
 *       这些**不是几何、不是语义**，来自本规则。
 *   孔位坐标用「板件自身边 + 沿边位置」表达（见 model.ts MfgConnectorHoles），
 *   沿边位置 = 工厂留量规则（endMargin + 孔数）作用于几何进深 —— 不产生第二尺寸真相源。
 *
 * ── verified 升格触发（确定性，缺一不可）──
 *   ① mfgRules.caseConnectors.enabled = true；
 *   ② 板件 role ∈ {LeftSidePanel, RightSidePanel, TopPanel, BottomPanel}（其余结构板待真实规则）；
 *   ③ 孔线位置 = 工厂留量作用于几何进深（panel.width），不重算；
 *   ④ 工厂参数完整且合法（见 derive.ts 参数校验；缺失/非法 → 降级 unverified）。
 *
 * ── 本阶段只做「最可证明的子集」──
 *   仅箱体外壳主连接（侧↔顶/底、顶/底↔侧）升格 verified；中立板/行隔板/中板/背板与
 *   侧板的连接、以及柜↔柜组合连接，当前规则无法确定性推出孔位，仍标 unverified
 *   （不伪造语义、不脑补坐标）。这与用户 P7.3 指示「先实现确定性最强的一种连接方式」一致。
 */
export interface MfgCaseConnectorRule {
  enabled: boolean;
  /**
   * 孔型：三合一（偏心连接件）或木榫。决定哪些板钻、孔几何不同，但**位置算法相同**
   * （都落在同一连接边的同一组进深位置上），故用同一规则 + 此工厂参数切换。
   */
  type: 'cam-lock' | 'wood-dowel';
  /** 孔位来源：几何事实（侧↔顶/底拓扑 + 进深）被工厂留量规则派生。 */
  source: 'deterministic.caseConnectors';
  /** 距板两端的最小边距（mm）。工厂参数；两孔不得交叉 ⇒ 须 < 进深/2。 */
  endMarginMm: number;
  /** 每条连接边的孔数（含两端）。工厂参数；≥1。 */
  holesPerJoint: number;
  /** 孔径（mm）。工厂参数。 */
  diameterMm: number;
  /** 孔深（mm，沿板厚钻入）。工厂参数；应 ≤ 板厚（板厚为几何事实，制造层只读）。 */
  depthMm: number;
  /** 是否两块板配对加工（箱体外壳连接恒为 true）。 */
  pairMachining: boolean;
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
  caseConnectors: MfgCaseConnectorRule;
  /**
   * 必须标记 unverified 的制造方面（按角色/连接罗列，便于审计与未来逐项点亮）。
   * 这些不是「不做」，而是「当前规则无法确认，需工厂排孔/工艺方案补」。
   */
  unverifiedAspects: string[];
}

export const DEFAULT_MANUFACTURING_RULES: ManufacturingRuleSet = {
  id: 'mfg_factory_default_v1',
  name: '工厂默认制造规则（占位，待真实工厂校准）',
  note: 'P7 占位值。换工厂 = 换本文件，不改代码。已确认能力：封边、背板工艺、层板托孔（几何标高派生，侧板钻孔）、箱体外壳连接孔（侧↔顶/底，几何拓扑+进深派生，侧/顶/底板钻孔）。其余加工标 unverified。',
  edgeBanding: { enabled: true, source: 'geometry.edge' },
  backPanel: { source: 'semantic.backPanel.method' },
  shelfPins: {
    enabled: true,
    source: 'deterministic.shelfElevations',
    holesPerElevationPerSide: 2,
    insetFrontMm: 37,
    insetBackMm: 37,
  },
  caseConnectors: {
    enabled: true,
    type: 'cam-lock',
    source: 'deterministic.caseConnectors',
    endMarginMm: 37,
    holesPerJoint: 2,
    diameterMm: 15,
    depthMm: 13,
    pairMachining: true,
  },
  unverifiedAspects: [
    'hinge boring（铰链孔）',
    'drawer hardware mount holes（抽屉五金安装孔）',
    'case connector holes for 中立板/行隔板/中板/背板（待真实规则）',
    'assembly connector machining（组合连接加工孔）',
  ],
};
