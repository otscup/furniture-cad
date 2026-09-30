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
/**
 * `PlacementAuthority` 定义在 `core/commandBus.ts`（落位权威生命周期的唯一归口，
 * P8.5-B 决定不迁入 placement.ts）：这里用 `import type` 引用，编译期擦除，
 * 不会形成运行时循环依赖。
 */
import type { PlacementAuthority } from './commandBus.ts';
import type { PlacementIntentDecl } from './placement.ts';

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
  /**
   * 家具组合（v0.3，可选）—— 一组柜体的**语义分组 + 关系声明**。
   *
   * ── 为什么是项目级扁平数组而不是嵌在 Room 里 ──
   *   与 `cabinets` 同构（`assembly.roomId` 指向房间）：新增/删除/移动都只需
   *   动一个数组，命令的 sideEffect、白名单、快照三条线都少一处分支。
   *   嵌进 Room 会让"移动柜体到别的房间"变成"从一个数组搬到另一个数组"。
   *
   * ── 缺省 = 没有组合（v0.2 逐位等价）──
   *   旧文件没有这个字段，读出来是 `undefined`，所有派生与校验按"无组合"处理。
   */
  assemblies?: FurnitureAssembly[];
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

// ─────────────────────── 组合关系（v0.3，P2）───────────────────────

/**
 * 柜体局部坐标下的四条边。
 * 局部坐标：+X 沿柜宽（左→右），+Y 沿进深（背面→正面）。
 *   `back` = y 0（贴墙那一面）；`front` = y 深（门脸那一面）；`left`/`right` = 两端。
 */
export type ConnectionEdge = 'back' | 'front' | 'left' | 'right';

/**
 * 关系类型。**只描述"怎么连"，不含任何坐标。**
 *   `corner` 角接（L 型）：两臂轴线垂直、在墙角相接；
 *   `butt`   续接（并排）：两柜同向、端面或侧面贴合，合成一整排；
 *   `stack`  叠放：一柜在另一柜之上。
 *
 * ── 为什么 `stack` 在类型里但派生不产出它 ──
 *   柜体的 placement 只有 (x, y, rotation)，**没有 Z**。没有 Z 就无法判定
 *   "谁在谁上面"，硬算只能猜。所以：`stack` 允许**声明**（用户明确说上下叠放），
 *   但派生层不产出、也不校验它 —— 报 `RULE-ASSEMBLY-STACK-UNVERIFIED` 说清
 *   "你说叠放了，本阶段没有 Z 坐标可核"。宁可如实说没核，不可假装核过。
 */
export type ConnectionKind = 'corner' | 'butt' | 'stack';

/** 关系的一端：哪个柜 + 它的哪条边（边可选，缺省由派生从落位反推） */
export interface ConnectionEnd {
  cabinetId: string;
  edge?: ConnectionEdge;
}

export interface Connection {
  id: string;
  kind: ConnectionKind;
  a: ConnectionEnd;
  b: ConnectionEnd;
  /**
   * 这条关系是**谁说的**：
   *   `authored` = 用户/AI 明确声明的事实（可校验、可据此报错）；
   *   `inferred` = 派生从落位反推出来的（只用于表达，不据此报错）。
   * 两者必须分开：把推断当事实去报错，会在用户只是"放得近"时骂他"你说连着其实没连"。
   */
  origin: 'authored' | 'inferred';
}

/**
 * 家具组合：一组柜体 + 它们之间的连接关系。
 *
 * ── 它**不是**几何 ──
 *   声明组合不产生任何板件、不改任何尺寸、不改 2D/3D/DXF/BOM。
 *   它是"这两段属于同一组电视墙、并且在这里拐了个弯"这条**语义**，
 *   落位仍然由 `snapPlace.joinSpots` 算、干涉仍然由 `detectCollisions` 判 ——
 *   关系层不许自己写第二套坐标，这是本阶段最容易走偏的地方。
 *
 * ── 它带来什么 ──
 *   ① 整体操作（平移整组、整组删）不必靠"框选"这种空间巧合；
 *   ② 转角撞门检查可以**按声明**必检，而不是靠"看起来像 L 型"猜；
 *   ③ P3 的 AI 提案可以把"一组"作为可讨论的对象（"把转角这组改成 U 型"）。
 */
export interface FurnitureAssembly {
  id: string;
  name: string;
  roomId: string;
  /** 成员柜体 id（指向 `project.cabinets`）；顺序有意义（界面与快照按此列） */
  memberIds: string[];
  connections: Connection[];
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
  /**
   * 导入来源归属（v0.3，P4）。
   *
   * 一条外部数据被导入后，"它来自哪、可信到什么程度、哪里还没确定"
   * 必须跟着柜体走，而不是只活在导入那一刻的界面里 —— 下次打开项目，
   * 你仍该看得到"这个柜是从 DXF 导入的、深度是估的、置信度低"。
   *
   * 这是 authored 语义模型的一部分（属于真相源，不是派生数据）：
   * 它描述"这个柜是怎么来的"这一事实，与板件/坐标/清单无关，也不污染几何。
   */
  origin?: ImportOrigin;
  /**
   * 落位 provenance（P8.5-B，可选）。只存「当前 live」记录，随柜体进 project.json。
   *
   * 它**只是解释** `placement` 是怎么来的（谁、什么来源、什么落位意图、是否用户确认），
   * **永远不能成为第二个位置真相**——任何派生层（几何/清单/DXF/P8.3）一律不读它。
   * undefined = 无来源信息（等同 unknown，绝不伪造）。
   *
   * 落盘形态刻意剥掉会话派生态（status / targetId / supersededBy）：
   * 加载后由命令总线从 activeLog 重算，或保留加载时的基线。本字段不升
   * schemaVersion、不加 migration——老文件无此键，读出来 undefined，逐字节兼容。
   */
  placementProvenance?: PersistedPlacementProvenance;
}

/**
 * 落盘形态（P8.5-B）。只存每柜当前 live provenance 的最小事实；
 * status / targetId / supersededBy 是会话派生态，不落盘（加载后由总线重算）。
 *
 * 不含任何坐标 / 几何快照（x/y/rotation 是 `placement` 的事，重复存一份 = 第二套真相）。
 */
export interface PersistedPlacementProvenance {
  /** 当时的落位意图声明；null = 来源未知（导入 / 手摆），不伪造 */
  intent: PlacementIntentDecl | null;
  /** 落位权威：user-authored / user-confirmed / system-resolved / unknown */
  authority: PlacementAuthority;
  /** 产生它的命令 op（cabinet.place / move / rotate / nudge / resize / assembly.move） */
  byOp: string;
  /** 提交时的模型版本（可复现指针，不是时间戳） */
  atVersion: number;
}

// ── 导入来源归属（v0.3，P4）──
/** 已落地的外部来源。未在此枚举内的来源不应直接写进模型（先扩展适配器 + 错误码） */
export type ImportSource = 'json' | 'dxf' | 'kujiale' | 'imageVision';

/**
 * 导入来源归属。来源 / 置信度 / 不确定项三者缺一不可，跟着柜体走。
 * 不确定项（uncertainty）一旦存在，导入即被阻断应用 —— 宁可停下来问，不替用户猜。
 */
export interface ImportOrigin {
  source: ImportSource;
  /** 人类可读来源（文件名 / 平台名 / URL / 批次说明） */
  label?: string;
  /** 同一批次导入共享的 id —— 审计追踪"这些柜是一起来的" */
  batchId: string;
  /** 适配器对该柜体的整体置信度 */
  confidence?: 'high' | 'medium' | 'low';
  /** 该柜在导入时未能可靠确定的内容（需用户确认，不替用户猜） */
  uncertainty?: string[];
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
