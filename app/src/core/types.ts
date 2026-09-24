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

export interface UnitSpec {
  id: string;
  kind: 'drawerBank' | 'hanging' | 'shelves' | 'open';
  requestedWidth: number;
  nickname?: string;
  drawers?: DrawerSpec;
  shelves?: { count: number; mode: 'equal'; gapPerSide: number };
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
  };
  rod?: { count: number; heightFromBottom: number; hardware: string };
}

export interface CabinetLayout {
  type: 'row';
  widthMode: 'fit_total' | 'fit_units';
  units: UnitSpec[];
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
}

export interface BBox {
  min: Vec2;
  max: Vec2;
}

export interface CabinetGeometry {
  cabinetId: string;
  panels: Panel[];
  hardware: HardwareItem[];
  plan: Prim[];
  /** 板件在立面上的投影（用于侧栏缩略图 / 后续立面图） */
  elevation: Prim[];
  issues: Issue[];
  stats: { panelKinds: number; totalPieces: number; boardAreaM2: number; estWeightKg: number };
  /** 派生骨架：生成器/校验器/UI 共用同一份，禁止各自再算一遍 */
  layout: CabinetDerived;
}

export interface CabinetDerived {
  boardT: number;
  backT: number;
  bodyH: number;
  innerW: number;
  innerH: number;
  netTotal: number;
  nets: number[];
  unitX0: number[];
  shelfDepth: number;
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
