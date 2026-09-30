/**
 * ══════════════════════════════════════════════════════════════════════
 *  Vision 类型 —— 图片/效果图 → 结构识别（P5）
 *
 *  ── Vision 与核心系统解耦 ──
 *    这一层只定义「一张图进去，结构化识别结果出来」的契约。
 *    具体用 OpenAI / Gemini / Claude / 本地模型 / 其它兼容 API，由
 *    `VisionProvider` 的实现决定，且**不硬编码任何厂商名 / 模型名 / API 形态**
 *    到 core。换服务商 = 换一个 Provider 实现（或给它一份配置），不碰
 *    Semantic Model / Geometry / Rules / DXF。
 *
 *  ── 诚实原则写在类型里 ──
 *    每一个尺寸都是 `{ value, confidence, source }`：
 *      · source='annotation'  → 图片上有尺寸标注 / 可识别参考尺度（高可信）
 *      · source='reference'   → 用户给了参考尺寸（如已知某件家具宽）
 *      · source='estimate'    → 纯视觉估计（像素比例 ≠ 真实毫米，**不可直接下料**）
 *    凡是图片看不见的（深度 / 板厚 / 隐藏隔板 / 连接关系 / 真实尺寸），
 *    一律进 `notVisible`，由映射层转成「必须用户确认」的 caveat / question。
 *    Vision **绝不**因为看不见就编造生产结构。
 * ══════════════════════════════════════════════════════════════════════
 */

export type Confidence = 'high' | 'medium' | 'low';

/** 尺寸的三种来源：决定它能不能直接当生产尺寸 */
export type DimSource = 'annotation' | 'reference' | 'estimate';

export interface VisionDim {
  /** 估计或标注的毫米值 */
  value: number;
  /** 模型对这个值的把握 */
  confidence: Confidence;
  /** 这个值怎么来的（estimate = 像素比例推的，不可直接下料） */
  source: DimSource;
}

/** 左右分区（单行柜的一列） */
export interface VisionUnit {
  kind: 'shelves' | 'drawerBank' | 'hanging' | 'open' | 'appliance';
  /** 已解析 mm 宽；或占整柜宽的比例（0~1），映射层按整柜宽换算 */
  widthMm?: number;
  widthRatio?: number;
  /** 抽屉数 / 层板数 */
  count?: number;
  /** 门扇数（0 = 开放格） */
  doorCount?: number;
  /** 挂衣区挂杆高（kind='hanging'） */
  rodHeight?: number;
  /** 电器洞口（kind='appliance'） */
  applianceName?: string;
  openingWidth?: number;
  openingHeight?: number;
  confidence: Confidence;
}

/** 上下分层（自上而下） */
export interface VisionRow {
  /** 已解析 mm 净高；或占整柜高的比例（0~1） */
  heightMm?: number;
  heightRatio?: number;
  units?: VisionUnit[];
  confidence: Confidence;
}

export type VisionComponentType = 'door' | 'drawer' | 'open-shelf' | 'shelf' | 'appliance-cavity';

/** 可见组件（柜门 / 抽屉 / 开放格 / 层板 / 电器洞口） */
export interface VisionComponent {
  type: VisionComponentType;
  /** 位置描述（给 UI / 用户看，不影响几何） */
  location?: string;
  confidence: Confidence;
}

/** 图片里「看得见」但「生产上还需要定」的东西，由映射层转成 caveat / question */
export type NotVisibleReason =
  | 'depth' // 真实深度看不见
  | 'inner-partitions' // 内部隔板 / 层板看不见
  | 'board-thickness' // 板厚看不见
  | 'connection' // 柜体之间怎么接看不见
  | 'real-size'; // 整柜真实尺寸无标注，只是估计

export interface VisionCabinet {
  /** 本批内引用名（组合用它引用本柜） */
  ref: string;
  name?: string;
  width?: VisionDim;
  height?: VisionDim;
  depth?: VisionDim;
  /** 可见的上下分层（自上而下）。有就按它；没有 = 内部结构未知 */
  rows?: VisionRow[];
  /** 可见的左右分区（单行柜）。有就按它；没有 = 内部结构未知 */
  units?: VisionUnit[];
  /** 可见的组件（门/抽屉/开放格/电器洞口），辅助说明前面 rows/units 的语义 */
  components?: VisionComponent[];
  /** 朝向意图（0/90/180/270），系统落位时优先参考 */
  rotation?: number;
  room?: string;
  /** 这份识别的整体把握 */
  confidence: Confidence;
  /** 图片里看不见、需要用户定 / 确认的东西 */
  notVisible?: NotVisibleReason[];
}

export type VisionRelationKind = 'L-shape' | 'side-by-side' | 'stacked' | 'adjacent';

/** 柜体之间的组合关系（可观察：L 型 / 并排 / 叠放 / 相邻） */
export interface VisionRelation {
  from: string;
  to: string;
  kind: VisionRelationKind;
  confidence: Confidence;
}

/** 图片里的尺度信息 */
export interface VisionScale {
  /** true = 图片有尺寸标注或可识别参考尺度（高可信）；false = 只有像素比例 */
  known: boolean;
  /** 标注文字（如「柜体高 2400」） */
  text?: string;
  /** 已解析出的参考毫米（标注值或参考物真实尺寸） */
  referenceMm?: number;
  confidence: Confidence;
}

/**
 * Vision 模型给出的识别结果（结构化）。
 * 这是 VisionProvider 与「映射层」之间的唯一契约。
 */
export interface VisionResult {
  /** 实际跑的 provider（mock / openai-compatible / …），仅用于溯源 */
  provider?: string;
  /** 实际跑的模型名（若有），仅用于溯源 */
  model?: string;
  /** 识别出的柜体区域 */
  cabinets: VisionCabinet[];
  /** 柜体组合关系 */
  relations?: VisionRelation[];
  /** 尺度信息 */
  scale?: VisionScale;
  /** 整份识别的把握 */
  overallConfidence: Confidence;
  /** 模型附带的说明 */
  notes?: string[];
  /**
   * 模型自己都说不清、必须反问用户的问题（**硬阻断**）。
   * 例如「图中看不出到底是两个柜还是三个」「这种转角结构连接方式有歧义」。
   * 没有就留空 —— 普通「看不见生产结构」走 notVisible → caveat（用户确认即可）。
   */
  ambiguous?: string[];
}

/** 喂给 VisionProvider 的输入 */
export interface VisionInput {
  /** 图片数据：浏览器里是 data URL（base64），其它环境可以是路径或已编码串 */
  image: string;
  mime?: string;
  filename?: string;
  /**
   * 用户能提供的、图片本身没有的上下文（**只当提示，不当真值**）：
   * 例如「这是玄关鞋柜」「左边那个高柜已知宽 400」。映射层不会把 hint 当成尺寸。
   */
  hint?: string;
  /** 用户已知的一个参考尺寸（mm）—— 等价于给模型一个 reference scale */
  knownScaleMm?: number;
  /** 选定模型（透传给底层 Provider；不填用 provider 默认） */
  model?: string;
}

/**
 * Vision Provider —— 可替换的视觉识别实现。
 *
 * 实现方职责：**只做识别，不碰几何、不写模型**。
 * 它返回一个 `VisionResult`，剩下的「→ NormalizedDesign → 校验 → 预览
 * → 确认 → CommandBus」全部走 P4 统一链路，与 JSON / DXF 导入同权同位。
 */
export interface VisionProvider {
  /** 实现标识（mock / openai-compatible / …） */
  id: string;
  /** 同步识别一张图 */
  analyze(input: VisionInput): Promise<VisionResult>;
}
