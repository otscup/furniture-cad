/**
 * 领域模型类型 —— 唯一真相源。
 *
 * 铁律：
 *  1. 全部尺寸单位 mm，整数（禁止浮点误差进入生产尺寸）
 *  2. 这里只有 authored（权威）字段。派生数据（板件、几何、清单）一律不落在这里，
 *     由 core/geometry 现算。见 docs/AI-Web-CAD-Furniture-Master-Plan-v0.1.md §D
 *  3. 没有任何 CAD 内核相关概念（无 B-rep、无三角形），换几何后端零迁移
 *
 * 注：`import type` 是纯类型引用，编译期被擦除，不会形成运行时循环依赖。
 */
import type { ProjectViewSet } from './geometry/views.ts';

export interface Vec2 {
  x: number;
  y: number;
}

// ─────────────────────────── 项目 / 房间 / 墙 ───────────────────────────

export interface Project {
  schemaVersion: string;
  id: string;
  name: string;
  ruleSetId: string;
  rooms: Room[];
  cabinets: Cabinet[];
}

export interface Room {
  id: string;
  name: string;
  walls: Wall[];
}

/**
 * 墙：中心线 + 厚度。端点可以拖动 → 这是"改语义参数"，不是"移动线条"。
 */
export interface Wall {
  id: string;
  name: string;
  start: Vec2;
  end: Vec2;
  thickness: number;
  height: number;
}

// ─────────────────────────── 柜体 ───────────────────────────

export interface CabinetParams {
  width: number;
  height: number;
  depth: number;
  boardMaterial: string;
  backPanel: {
    material: string;
    method: 'groove' | 'inset';
    grooveDepth: number;
    grooveSetback: number;
    clearance: number;
  };
  bodyLift: number;
  shelfFrontClearance: number;
  /**
   * 见光板（圆弧见光，Phase E 表达异形）。
   *   酒柜/衣柜/橱柜靠墙一端外露时，外露的端板做"见光板"工艺处理：
   *   本应用用 R36 前缘圆弧表达（见光面工艺，不是结构问题）。
   *   'none' = 不做（默认）；'left'/'right'/'both' = 左/右/两端侧板改为见光板。
   * 这是**表达异形**：不改结构板数量，只改端板命名 + 侧视图前缘圆弧 + 标注，
   * 与"结构异形走图元扩展"严格分流（见方案文档 §2.3 / §7）。
   */
  finishedEnds?: 'none' | 'left' | 'right' | 'both';
}

export interface DrawerSpec {
  count: number;
  runner: string;
  runnerLength: number;
  sideThickness: number;
  bottomThickness: number;
  bottomGrooveDepth: number;
  gap: number;
  boxHeightDeduct: number;
}

/**
 * 嵌入式电器格（洗衣机柜等）—— "预留洞口 + 上下分体"的语义表达。
 *
 * 为什么洞口尺寸是**洞**而不是机器：木工下单收到的是"这里留 650×850×600 的洞"，
 * 不是"这里放一台某型号洗衣机"。机器尺寸 + 安装余量在用户嘴里合成一个数，
 * 语义层直接收这个合成结果（openingWidth/Height/Depth），生成器只做
 * "洞口 ≤ 分区净空"的校验，不替用户猜余量。
 */
export interface ApplianceSpec {
  /** 电器名（洗衣机 / 烘干机 / 嵌入式烤箱…），进甲购件清单与图面标注 */
  name: string;
  /** 洞口净空：宽（X）/ 高（Z，从柜内底到过梁板下表面）/ 深（Y，从前脸往里） */
  openingWidth: number;
  openingHeight: number;
  openingDepth: number;
  /**
   * 洞口上方的抽屉数（上下分体的"上"）。0 = 洞口以上是开放空腔。
   * 派生：过梁板（洞口顶板）+ 上排抽屉全套，占用的净高 = 内空高 - 洞口高 - 板厚。
   */
  topDrawers: number;
}

export interface UnitSpec {
  id: string;
  kind: 'drawerBank' | 'hanging' | 'shelves' | 'open' | 'appliance';
  requestedWidth: number;
  nickname?: string;
  /** 仅 kind='appliance'：洞口与上下分体定义（缺省值由 docFactory.makeUnit 显式补齐） */
  appliance?: ApplianceSpec;
  drawers?: DrawerSpec;
  shelves?: {
    count: number;
    mode: 'equal';
    gapPerSide: number;
    /**
     * 灯带安装位（销售图纸里开放格灯带的三种画法）：
     *   'none' = 不装（显式默认，docFactory 补齐 —— 不靠"字段缺失"表达状态）；
     *   'center' = 层板前缘居中；'front' = 贴前沿；'angled45' = 45° 斜光朝前。
     * 语义字段进清单派生（五金自动出 HW_LED_*），内视图标注挂 Phase D。
     */
    ledStrip?: 'none' | 'center' | 'front' | 'angled45';
    /**
     * 斜层板倾角（酒柜等，Phase E 异形图元）。
     *   0 = 平层板（默认，显式补齐，不留隐式回退）；
     *   1..45 = 层板沿前立面方向倾斜的角度（度），酒瓶斜放时常用 10~15°。
     * 这是**几何图元扩展**：板件真实裁切长 = 水平跨度 / cos(tilt)，
     * 四视图里画成平行四边形（与销售图纸同款），不引入第二套几何来源。
     * 只影响板件尺寸与图面表达，不影响分区净宽分配（净宽仍是水平投影）。
     */
    tilt?: number;
  };
  doors?: {
    type: 'hinged';
    count: number;
    mode: 'equal';
    style: 'inset';
    gapOuter: number;
    gapMid: number;
    hinge: string;
    /**
     * 门铰链侧（开向标注的数据来源）。
     *   count===1：'left' = 铰链在左、门往右开；
     *   count===2 且 style 为对开：两扇铰链在两侧（V 形开向线），此字段标记主扇（左扇）方向；
     *   更多扇：暂按每扇同向对角线表达（行业简画）。
     * 缺省 = 'left'（docFactory 补齐）。只影响图面表达，不影响板件清单。
     */
    hingeSide?: 'left' | 'right';
    /**
     * 门板材质 ID（引用 RuleSet.materials）。
     * 玻璃 / 镜面等甲购件与木门共用这一个字段 —— 板件清单按材质 kind 分流：
     * kind='glass' 的门板不进开料清单，进「甲购/外采件」。
     * 缺省 = 规则集默认门板材质（docFactory 补齐，显式覆盖不留隐式回退）。
     */
    material?: string;
  };
  rod?: { count: number; heightFromBottom: number; hardware: string };
}

/**
 * 行高（v0.3）。
 *   数字 = 该行的**固定净高**（mm 整数，指内空净高，不含行隔板）；
 *   'fill' = 吃掉剩余内高（高度链唯一的自由项）。
 *
 * 多行柜的高度链恒等式：`Σ(行净高) + (行数-1)×板厚 === innerH`。
 * 因此 'fill' **有且只有一个、且必须在最后一行** —— 这条由 P1 的校验器强制，
 * 类型层面只保证取值合法（见 rules/validate.ts 的 RULE-ROW-* 家族）。
 *
 * **行序固定为自上而下**：`rows[0]` 是最上面一行，`rows[n-1]` 是最下面一行。
 * 于是"上部通顶柜 + 下部三分区"就写成 `[{height:480,…}, {height:'fill',…}]`
 * —— 定死上面那层，剩下的全归下面（'fill' 恰好落在最后一行，不需要额外规则）。
 */
export type RowHeight = number | 'fill';

/**
 * 垂直行（v0.3，上下分层）—— **一行 Section 的容器**。
 *
 * ── 为什么是"加一个维度"而不是"加一种柜型" ──
 *   柜体内部原本只有左右一个维度（`units` 一维数组），于是"上通顶柜 + 下三分区"
 *   这类结构只能靠新的巨型 if/else 柜型硬编码。引入"行"以后：
 *     · `UnitSpec` 就是 Section 叶（语义完全不变）；
 *     · `drawers/shelves/doors/rod/appliance` 就是 Component（原样保留）；
 *     · 行的不同组合 = 不同柜型 —— 新柜型是**组合**出来的，不是新分支。
 *
 * ── 与旧模型的等价关系 ──
 *   `rows` 缺省（单行）时，模型与 v0.2 **逐位等价**：内存里视作
 *   `[{ id:'row_001', height:'fill', units }]`，序列化时塌回 `units`。
 *   见 core/layoutModel.ts —— 全项目只有那一个文件知道这两种形状。
 */
export interface CabinetRow {
  id: string;
  height: RowHeight;
  units: UnitSpec[];
}

export interface CabinetLayout {
  /**
   * 'row' = 单面柜（分区左右并排，唯一的背板在背面）；
   * 'double' = 双面柜（岛台）：正面 + 背面两排分区背靠背，中间一块共用中板，
   * **没有背板**（中板就是两排共用的"背"）。
   */
  type: 'row' | 'double';
  widthMode: 'fit_total' | 'fit_units';
  /**
   * 第一排（`rows` 缺省时 = 唯一一排）的分区，从左到右。
   * `rows` 存在时它**不参与读取**（读侧以 `rows` 为权威），且存盘时被省略 ——
   * 免得旧读者把第一行当成整柜算出错误的生产尺寸。
   * 单一口径点在 core/layoutModel.ts，别处不许判断 rows/units 谁在。
   */
  units: UnitSpec[];
  /**
   * 垂直行（v0.3，可选）。**只在真的分了上下两层时才出现**：
   *   · 缺省 = 单行柜（= v0.2 形状，存量文件一个字节都不动）；
   *   · 1 行 = 等价于缺省，序列化时自动塌回 `units`（不写冗余的 rows）；
   *   · ≥2 行（自上而下，`rows[0]` 在最上面）= 上下分层，
   *     行间贯通横隔板由 P1 的派生层生成。
   * 与 `units` 同时出现时以 `rows` 为准（解析器会就"镜像不一致"给出 warning）。
   */
  rows?: CabinetRow[];
  /**
   * 仅 type='double'：背面分区（从左到右，朝 -Y）。
   * row 柜带 backUnits 是自相矛盾的模型 —— 校验器报 ERROR，不静默忽略。
   * 排深的语义固定为**前后对半**（中板居中）：不留"前深后浅"的自由度，
   * 真要偏置的岛台是另一档柜型，等真实需求出现再加字段。
   */
  backUnits?: UnitSpec[];
}

export interface Cabinet {
  id: string;
  name: string;
  roomId: string;
  /**
   * placement：柜体背面左角在世界坐标中的位置 + 绕该点逆时针旋转角（deg）。
   * 局部坐标：+X 沿柜宽（左→右），+Y 沿进深（背面→正面）。
   * 拖动柜体 = 改这里的 x/y，绝不改任何几何坐标。
   */
  placement: { x: number; y: number; rotation: number };
  params: CabinetParams;
  layout: CabinetLayout;
}

// ─────────────────────────── 库 / 规则集 ───────────────────────────

export interface MaterialDef {
  name: string;
  thickness: number;
  kind: string;
  maxSheet: [number, number];
  grain: boolean;
  density: number;
}

export interface RuleSet {
  id: string;
  name: string;
  note?: string;
  materials: Record<string, MaterialDef>;
  edgebanding: Record<string, { name: string; thickness: number }>;
  hardware: Record<string, { name: string; unit: string }>;
  limits: {
    maxSheetSize: [number, number];
    minPanelSize: number;
    maxPanelWeightKg: number;
    maxDoorWidth: number;
    maxDoorHeight: number;
    maxShelfSpan: number;
    maxSingleCabinetHeight: number;
    maxSingleCabinetWidth: number;
    hingeSpacingMax: number;
  };
  policy: {
    remainderPolicy: 'bottom' | 'top' | 'distribute';
    widthAllocationPolicy: 'fit_total' | 'fit_units';
    edgeBandingRule: string;
  };
  /**
   * 风格预设（可选）。没有配 = 该工厂不提供方案对比，界面会如实这么说，
   * 不悄悄编一套出来。
   */
  stylePresets?: StylePreset[];
}

// ─────────────────────────── 风格预设 ───────────────────────────

/**
 * 风格预设 —— 「通体两门 / 三段分格」这类**分格方式**。
 *
 * ── 为什么它是语义参数，不是图面样式 ──
 *   图面样式（颜色 / 线型）改不出"门扇从 2 变 3"，而客户选风格恰恰就是在选分格方式。
 *   而且只有语义参数才能让四视图**一致地**跟着变 ——
 *   见 docs/Design-Local-Pick-Edit-and-Staged-Generation.md §3.3
 *
 * ── 为什么分区宽用「比例」而不是绝对 mm ──
 *   柜宽是用户给的（2400），风格只定义"怎么分"。用比例，同一套预设在 1200 和 3600
 *   的柜子上都成立；用绝对值，换个柜宽就得改预设。这与
 *   `layout.widthMode = 'fit_total'`（总宽硬约束、分区按请求比例分配）是同一套语义。
 *
 * ── 一条必须写明的边界 ──
 *   `CabinetLayout.type` 目前只有 `'row'`（分区**左右**并排）。
 *   所以"上下分段"（一条水平分隔线）**现在表达不出来** —— 预设里不许假装能做。
 */
export interface StylePresetUnits {
  kind: UnitSpec['kind'];
  ratio: number;
  nickname?: string;
  /** 按 kind 解释：drawerBank = 抽屉数，shelves = 层板数 */
  count?: number;
  /** 仅 hanging 有效：挂衣杆离柜内底高度 */
  rodHeight?: number;
  /** 该分区要不要带门。`doors.count` 省略则用预设级的默认值 */
  doors?: { count: number; gapMid?: number; gapOuter?: number };
}

export interface StylePreset {
  id: string;
  nameZh: string;
  /** 这条风格的假设 / 工艺说明，界面上要显示 —— 没有工艺依据的地方不能悄悄用 */
  note?: string;
  /** 省略 = 用 docFactory 的 defaultUnits（2:4:2 三分区） */
  units?: StylePresetUnits[];
  /** 门板用的默认缝隙；具体门扇数在每个 unit 上给 */
  doorDefaults?: { gapMid?: number; gapOuter?: number };
  boardMaterial?: string;
  backMaterial?: string;
}

// ─────────────────────────── 派生：板件 ───────────────────────────

export interface EdgeSpec {
  top: string | null;
  bottom: string | null;
  left: string | null;
  right: string | null;
}

export interface Panel {
  id: string;
  role: string;
  nameZh: string;
  belongsTo: string;
  group: string;
  material: string;
  thickness: number;
  length: number;
  width: number;
  qty: number;
  grain: 'length' | 'width' | 'none';
  edge: EdgeSpec;
  edgeLabel: string;
  layer: string;
}

export interface HardwareItem {
  id: string;
  nameZh: string;
  kind: string;
  qty: number;
  spec: string;
  belongsTo: string;
}

/**
 * 甲购 / 外采件（玻璃门、镜面、成品拉篮等）。
 * 与 HardwareItem 的区别：它们不是安装五金，是**要花钱买的成品件**，
 * 清单上单独一节，绝不进板式开料清单（玻璃不走开料机）。
 */
export interface PurchasedItem {
  id: string;
  nameZh: string;
  kind: string;
  material: string;
  /** 规格描述（尺寸 / 厚度 / 工艺要求），生产下单时直接可读 */
  spec: string;
  qty: number;
  belongsTo: string;
}

// ─────────────────────────── 派生：2D 图元 ───────────────────────────

export type Prim =
  | { k: 'poly'; pts: Vec2[]; closed: boolean; layer: string; lw: number; dash?: number[] }
  | { k: 'fill'; pts: Vec2[]; layer: string; alpha: number }
  | { k: 'text'; p: Vec2; text: string; size: number; layer: string; align: 'l' | 'c' | 'r'; rot?: number };

export interface Issue {
  severity: 'ERROR' | 'WARNING' | 'INFO';
  code: string;
  target: string;
  targetKind: 'cabinet' | 'panel' | 'project' | 'unit';
  message: string;
  fixHint?: string;
  /**
   * 一键修复计划（由 issueCatalog 判定：只有"修法唯一可判定"的规则才有）。
   * 没有这一项 = 这条要用户自己决定 —— 界面不许给假按钮。
   */
  autoFix?: {
    op: string;
    target: { kind: 'cabinet' | 'room' | 'wall' | 'unit' | 'project'; id: string };
    changes: Array<{ path: string; op: 'set' | 'add'; value: string | number | boolean | null; unit?: string }>;
    label: string;
    note: string;
  };
}

export interface BBox {
  min: Vec2;
  max: Vec2;
}

export interface CabinetGeometry {
  cabinetId: string;
  panels: Panel[];
  hardware: HardwareItem[];
  /** 甲购/外采件（玻璃门等，kind='glass' 的材质分流到这里，不进 panels） */
  purchased: PurchasedItem[];
  plan: Prim[];
  /** 板件在立面上的投影（用于侧栏缩略图 / 后续立面图） */
  elevation: Prim[];
  issues: Issue[];
  stats: { panelKinds: number; totalPieces: number; boardAreaM2: number; estWeightKg: number };
  /** 派生骨架：生成器/校验器/UI 共用同一份，禁止各自再算一遍 */
  layout: CabinetDerived;
}

/**
 * 垂直行的**派生几何**（v0.3）。
 *
 * canonical：永远 ≥1 行，与 `layout.rows` 等长同序（自上而下，`[0]` 在最上面）。
 * 单行柜 = 恰好一行，各字段与 v0.2 的柜级字段**逐值相等** → 旧行为逐位不变。
 *
 * ── 为什么"行的 Z 位置"必须由派生层给，而不是让 2D/3D 各自算 ──
 *   行从下往上堆：底行的内空底面 = 内空底（bodyLift + 板厚），往上每跨一行加
 *   `行净高 + 行隔板厚`。若正视图、内部图、侧视图、3D 各写一遍这个累加，
 *   一旦某处漏加一块行隔板，图上就出现"上柜比实际矮 18mm"这类**看不出来的错**，
 *   而清单仍是照派生给的板件做 —— 图料不一致正是本项目第一条铁律要防的东西。
 */
export interface DerivedRow {
  id: string;
  /**
   * 该行结构板件 id 的**唯一性标签**：单行柜 = `''`（于是 id 与 v0.2 逐字相同，
   * `P_cab_DIV1`），多行柜 = `R1_` / `R2_`…（`P_cab_R1_DIV1`）。
   *
   * 为什么在派生层定而不是各生成器各自拼：板件 id 同时出现在清单、分解图、
   * 拾取线里；三处各拼一次就会出现"清单里叫 A、图上找不到 A"。
   */
  panelTag: string;
  /** authored 高度：数字 = 固定净高，'fill' = 吃掉剩余内高 */
  height: RowHeight;
  /** 该行的分区（= authored units 的同一批对象引用，只读；不拷贝） */
  units: UnitSpec[];
  /** 该行净高（内空，**不含**行隔板） */
  netH: number;
  /** 该行净宽总和 = innerW − (该行分区数−1)×板厚 */
  netTotal: number;
  /** 该行各分区净宽（左→右），与 units 等长 */
  nets: number[];
  /** 该行各分区左边缘 X（局部坐标，含侧板） */
  unitX0: number[];
  /** 该行内空底面 Z（局部立面坐标，自地面起算） */
  z0: number;
  /** 该行内空顶面 Z = z0 + netH */
  z1: number;
}

/**
 * 行高链的解算结论 —— **合法性的唯一判定处**。
 *
 * 为什么把"判定"和"求解"放在同一个函数里（layout.ts 的 resolveRowHeights）：
 *   若生成器按一种口径解、校验器按另一种口径判，两边一起错就永远发现不了
 *   （校验器的铁律：校验"生成器的输出"，而不是"自己另算一遍"）。
 *   所以这里只把结论带出来，校验器负责把它翻成人话报错。
 */
export interface RowHeightCheck {
  ok: boolean;
  /**
   * 不合法时的原因码（ok=true 时缺省）：
   *   FILL-NOT-LAST = 'fill' 出现在非最后一行；FILL-DUP = 多个 'fill'；
   *   FILL-OVERFLOW = 固定行高之和已超过可用内高，'fill' 行没有空间；
   *   SUM-MISMATCH  = 没有 'fill'，各固定行高之和不等于可用内高；
   *   HEIGHT-BAD    = 某行高度不是正整数（解析层本该拦住，这里是最后一道）
   */
  code?: 'FILL-NOT-LAST' | 'FILL-DUP' | 'SUM-MISMATCH' | 'FILL-OVERFLOW' | 'HEIGHT-BAD';
  /** 行数 */
  rowCount: number;
  /** 各固定行高之和（不含 'fill' 行） */
  fixedSum: number;
  /** 可用总高 = innerH − (行数−1)×板厚 */
  available: number;
  /** 固定行高之和 − 可用总高（正数 = 超了这么多 mm） */
  diff: number;
  /** 'fill' 行的索引；−1 = 没有 'fill' 或 'fill' 不止一个 */
  fillIndex: number;
  /** 'fill' 出现的次数（>1 即 FILL-DUP） */
  fillCount: number;
}

export interface CabinetDerived {
  boardT: number;
  backT: number;
  bodyH: number;
  innerW: number;
  innerH: number;
  /**
   * ⚠️ 下列三个字段是**行的兼容视图**（= `rows[0]`，即最上面那一行）。
   *
   *   · 单行柜：`rows[0]` 就是整柜 → 与 v0.2 逐值相等，旧行为不变；
   *   · 多行柜：只有 `rows[0]` 那一行的值 —— **不许拿它代表整柜**。
   *     需要遍历全部行的地方（生成器/校验器/四视图/3D/拾取线）一律用 `rows`。
   *     这是 P0 定下的口径：读侧以 canonical 行数组为权威，别处不再判断字段形状。
   */
  netTotal: number;
  nets: number[];
  unitX0: number[];
  shelfDepth: number;
  /** 垂直行派生（canonical，永远 ≥1 行，自上而下）。单行柜 = 一行 = 旧行为 */
  rows: DerivedRow[];
  /**
   * 行隔板（贯通横隔板）Z 区间下沿，长度 = rows.length − 1。
   * 墙板位置**不存** —— 由 `rows[i].z1` 立即得出（同一件事不给两个来源）。
   */
  rowDividers: number[];
  /** 行高链解算结论（合法性判定唯一来源，见 RowHeightCheck） */
  heightChain: RowHeightCheck;
  /**
   * 双面柜（type='double'）的派生骨架增量。row 柜为 undefined。
   * 前排占用 Y ∈ [midY0+midT, D]（前脸朝 +Y），后排占 Y ∈ [0, midY0]。
   */
  double?: {
    /** 前排箱体深（从前脸到中板前表面） */
    frontRowDepth: number;
    /** 后排箱体深（从中板后表面到柜背） */
    backRowDepth: number;
    /** 中板厚（= boardT） */
    midT: number;
    /** 中板前表面所在的 Y（= backRowDepth） */
    midY0: number;
    /** 后排净宽分配与起点（与前排同算法，独立分配） */
    backNets: number[];
    backUnitX0: number[];
    backNetTotal: number;
    /** 后排层板深（后排箱体深 - shelfFrontClearance，无槽） */
    backShelfDepth: number;
  };
}

export interface ProjectGeometry {
  cabinets: Record<string, CabinetGeometry>;
  plan: Prim[];
  issues: Issue[];
  bbox: BBox | null;
  /**
   * 3D 体块（派生视图）。语义骨架现算的轴对齐盒，给 Three.js 渲染；
   * 与 plan / views 同一次派生产出，永不写回模型。
   */
  bodies3d: import('./geometry/bodies3d.ts').Box3D[];
  /**
   * 四视图图幅（正视图 / 俯视图 / 侧视图 / 内部结构图，多柜并排）。
   *
   * 与 plan 一样是**派生视图**：和平面图来自同一份模型、同一次 derive，
   * 不写回模型、不单独缓存。见 core/geometry/views.ts
   */
  views: ProjectViewSet;
}
