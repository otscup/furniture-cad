import type { Cabinet, Connection, DoorHinge, DoorSwingDirection, FurnitureAssembly, Issue, Opening, Project, ProjectGeometry, Room, RuleSet, UnitSpec, Vec2, Wall } from './types.ts';
import type { PlacementIntentDecl } from './placement.ts';
import { generateProject } from './geometry/project.ts';
import { buildProjectExplode, type ProjectExplodeSet } from './geometry/explode.ts';
import { validateCabinet } from './rules/validate.ts';
import { validateCornerInterference } from './rules/corner.ts';
import { pairKey, validateAssemblies } from './relations.ts';
import { deriveSpatial } from './spatial/index.ts';
import { createRoom, defaultCabinetParams, defaultUnits } from './docFactory.ts';
import { nextId } from './ids.ts';
import { allUnits, layoutRows, unitPathPrefix, unitsAtPath } from './layoutModel.ts';
import type { Gate, GateHit } from '../ai/memory.ts';
import { formatGateError } from '../ai/memory.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  CommandBus —— 全系统唯一写入口（宪法级）
 *
 *  UI 点击 / 拖动 / 键盘、AI 指令、MCP 调用、脚本导入，四条路必须走这里。
 *  收益：① 人类与 AI 完全同权同位 ② 审计/撤销/权限只实现一次
 *        ③ 换 AI 供应商或加新客户端，零改动
 *
 *  三条铁律：
 *   1. 只接受 path-based 的语义字段修改 + 结构性命令，禁止任何几何/坐标直改
 *   2. 写路径白名单 —— AI/UI 都改不了派生字段和规则集（见 WRITABLE / DENY）
 *   3. 派生数据（板件/几何/清单）永不写回模型，永远是现算
 *
 *  ⚠ 关于 ERROR 是否阻断提交（一条容易做错的设计决策）：
 *    ERROR 阻断的是【导出/交付】，不是【编辑】。
 *    理由：真实设计过程必然经过中间非法态（柜子先放进墙里再挪出来）。
 *    如果每次拖动都因为"产生 ERROR"而拒绝提交，工具就没法用了。
 *    因此默认 strict=false：提交成功，同时把新增 ERROR 明确回报 + 前端弹出警告。
 *    AI / MCP 想要求"干净提交"时显式传 strict=true，
 *    此时只有【本次命令新引入的】ERROR 才阻断（历史遗留错误不阻塞新操作）。
 * ══════════════════════════════════════════════════════════════════════
 */

export type CommandSource = 'ui' | 'ai' | 'mcp' | 'system';

export interface Change {
  path: string;
  op: 'set' | 'add';
  value: number | string | boolean | null;
  unit?: 'mm' | 'deg' | '';
}

/** 结构性命令的载荷（数组增删无法用路径赋值表达） */
export interface CommandPayload {
  /** cabinet.create */
  cabinet?: Cabinet;
  /** cabinet.layout.addUnit / removeUnit */
  unit?: UnitSpec;
  unitId?: string;
  /** room.create / wall.create */
  room?: Room;
  wall?: Wall;
  roomId?: string;
  /** room.resize 的新尺寸（mm） */
  w?: number;
  h?: number;
  /** assembly.create */
  assembly?: FurnitureAssembly;
  /** assembly.* 的组合 id */
  assemblyId?: string;
  /** assembly.addMember / removeMember 的柜体 id */
  cabinetId?: string;
  /** assembly.connect */
  connection?: Connection;
  /** assembly.disconnect */
  connectionId?: string;
  /** assembly.move 的位移（mm） */
  dx?: number;
  dy?: number;
  /**
   * 结构性分区操作落在**哪一行**（`layout.rows` 行序，0 = 最上面）。
   * 单行柜缺省 0；多行柜缺省即拒绝 —— 见 planStructural 里的说明：
   * 猜错行的后果是把分区加到别的楼层，而界面上看起来"成功了"。
   */
  rowIndex?: number;
  /** 允许调用方覆盖名字等 */
  name?: string;
  /** ── opening.*（P8.7：门窗洞口）── */
  /** opening.create / delete / update：洞口挂在哪面墙（target 也可以指，payload 显式更防呆） */
  wallId?: string;
  /** opening.create 的洞口内容 */
  opening?: Opening;
  /** opening.delete / update 的洞口 id */
  openingId?: string;
  /**
   * opening.update 的字段补丁（只含要改的字段）。
   *
   * 门扇开启两字段（P8.9）用三态：`undefined` 不改 / `null` 改成"未指定" /
   * 给定值 = 设成它。缺了 `null` 这一态，"未指定"就永远回不去。
   */
  openingPatch?: {
    offset?: number;
    width?: number;
    name?: string;
    hinge?: DoorHinge | null;
    swingDirection?: DoorSwingDirection | null;
  };
}

export interface Command {
  id: string;
  op: string;
  source: CommandSource;
  target?: { kind: 'cabinet' | 'wall' | 'project'; id: string };
  changes: Change[];
  /** 结构性命令载荷；与 changes 互斥（二者必须有一个非空） */
  payload?: CommandPayload;
  /** AI 或 UI 的原始意图，写进审计日志（出事故时唯一能复盘的东西） */
  intent?: { nl?: string; assumptions?: string[] };
  /**
   * 落位意图声明（P8.5-C1，命令层 provenance）。
   *
   * 只声明"这次落位是怎么来的"（语义关系/面/对齐），**不决定坐标**——
   * 坐标仍由 Resolver 算、由 `cabinet.place` 写。仅 `cabinet.place` 会带它
   * （由 compile 从 AI 提案的 relation/reference/face/alignment 重建）。
   * 它**不在 Semantic Model 里**，不进 project.json、不进任何派生层。
   */
  placementIntent?: PlacementIntentDecl;
  /**
   * 这条命令是不是"用户确认过的 AI 计划"（P8.5-C1）。
   *
   * ⚠ 只由 apply 路径（commitPlan / commitPlanSubset）在用户点「应用」时打上。
   * 调用方**无权声明 authority**——authority 由总线从 (source × confirmedPlan)
   * 派生。这个布尔只是一个事实维度（"来自已确认的计划吗"），不是 authority 本身。
   */
  confirmedPlan?: boolean;
  /** 人类可读摘要，用于命令历史面板 */
  label?: string;
}

/**
 * 落位权威（P8.5-C1）—— 谁**授权**了这次落位，由总线派生，调用方无从伪造。
 *
 *   · user-authored   = 人自己给的（界面 / 属性面板 / MCP 显式 / 拖拽）
 *   · user-confirmed  = AI 提案，人点「应用」确认（confirmedPlan=true）
 *   · system-resolved = 系统自动（自动贴墙 / 自动落位 / 整组平移 / resize 补偿 / 撤销）
 *   · unknown         = 导入、手工摆放、不可判定（绝不伪造意图）
 *
 * 为什么要有它：P8.4 用 `Command.source` 代理"是不是人的选择"，但 `compile.ts`
 * 让 AI 编译的命令 source 恒为 'ai'（含用户点应用后的提交）——于是用户确认过的
 * 提案被当成 ai-inferred，结构性地一条落位证据都收不到。authority 把"授权方"
 * 从"发出方"里分离出来，确认真的确认过的 AI 落位也算 user 证据。
 */
export type PlacementAuthority = 'user-authored' | 'user-confirmed' | 'system-resolved' | 'unknown';

/** 落位 provenance 记录（P8.5-C1，会话内；不进 project.json） */
export interface PlacementProvenance {
  targetId: string;
  /** null = 来源未知（导入 / 手摆）—— 不伪造 intent */
  intent: PlacementIntentDecl | null;
  authority: PlacementAuthority;
  byOp: string;
  /** 当时的模型版本（不是时间戳：版本是本项目唯一的可复现指针） */
  atVersion: number;
  status: 'live' | 'superseded';
  supersededBy?: { op: string; atVersion: number };
}

/** 落位相关命令（这些 op 会写 placement，才需要 provenance） */
const PLACEMENT_OPS = new Set(['cabinet.place', 'cabinet.move', 'cabinet.rotate', 'cabinet.nudge', 'cabinet.resize', 'assembly.move']);

/**
 * 派生落位权威（P8.5-C1）—— 总线单点，**调用方无从声明 authority**。
 *
 *   source='system'            → system-resolved（自动解析 / 撤销 / 整组平移）
 *   confirmedPlan=true         → user-confirmed（人点「应用」确认过的 AI 提案）
 *   source∈{ui,mcp}            → user-authored（人自己的动作）
 *   其余（source='ai' 未确认） → unknown（绝不冒充 user 证据）
 */
function derivePlacementAuthority(cmd: Command): PlacementAuthority {
  if (cmd.source === 'system') return 'system-resolved';
  if (cmd.confirmedPlan) return 'user-confirmed';
  if (cmd.source === 'ui' || cmd.source === 'mcp') return 'user-authored';
  return 'unknown';
}

/** 一条落位命令影响了哪些柜体的 placement（用于 provenance 的失效判定） */
function affectedPlacementCabinets(cmd: Command, project: Project): string[] {
  if (cmd.op === 'assembly.move') {
    const asm = project.assemblies?.find((a) => a.id === cmd.payload?.assemblyId);
    return asm ? [...asm.memberIds] : [];
  }
  if (cmd.target?.kind === 'cabinet' && cmd.target.id) return [cmd.target.id];
  return [];
}

export interface DiffEntry {
  path: string;
  from: unknown;
  to: unknown;
}

/**
 * 洞口 authored 字段的快照（P8.7 位置/宽/名 + P8.9 门扇开启）。
 *
 * 单独成型的理由：它同时出现在 sideEffect 的 prev/next、落盘键序规范化
 * 与 diff 生成三处 —— 三处各写一份形状，"新加了字段忘了同步某一处"
 * 就会变成 undo 后字段诡异残留。类型放在一处，编译器替我们盯。
 */
export interface OpeningAuthored {
  offset: number;
  width: number;
  name?: string;
  /** 门扇铰链侧（P8.9；缺省 = 未指定） */
  hinge?: DoorHinge;
  /** 门扇开启朝向（P8.9；缺省 = 未指定） */
  swingDirection?: DoorSwingDirection;
}

/**
 * 结构性变更的逆运算描述 —— 声明式，便于 undo/redo 统一处理。
 * 用数组而不是单个：一条命令可能同时创建"房间 + 墙"（首次画墙时自动建房间），
 * 撤销必须整体回退，不能留下半个空房间。
 */
export type SideEffect =
  | { kind: 'insertCabinet'; cab: Cabinet; index: number }
  | { kind: 'removeCabinet'; cab: Cabinet; index: number }
  /**
   * 分区增删：`basePath` 指明动的是**哪一行**的分区数组
   * （单行柜 `layout.units` / 多行柜 `layout.rows[j].units`，见 layoutModel.unitPathPrefix）。
   * 撤销时靠它把分区放回原来那一行 —— 少了它，多行柜的 undo 会插进第一行。
   */
  | { kind: 'addUnit'; cabinetId: string; unit: UnitSpec; index: number; basePath: string }
  | { kind: 'removeUnit'; cabinetId: string; unit: UnitSpec; index: number; basePath: string }
  | { kind: 'insertRoom'; room: Room; index: number }
  | { kind: 'removeRoom'; room: Room; index: number }
  /**
   * 调整房间尺寸：矩形/任意多边形房间把每条墙端点相对房间包围盒原点缩放。
   * 墙的 id/名称/厚度/高度都保留，只动端点坐标。forward 落到新尺寸，reverse 还原。
   * 必须同时带新/旧端点 —— 房间尺寸没有单字段可表达（来自四面墙 8 个端点），不能走路径回退。
   */
  | { kind: 'resizeRoom'; roomId: string; walls: Array<{ id: string; start: Vec2; end: Vec2; prevStart: Vec2; prevEnd: Vec2 }> }
  | { kind: 'insertWall'; roomId: string; wall: Wall; index: number }
  | { kind: 'removeWall'; roomId: string; wall: Wall; index: number }
  /**
   * 门窗洞口（P8.7）：与墙同构的最小可逆三件套。
   * 洞口挂在 `wall.openings`（roomId/wallId 由结构回答）；insert/remove 带 index
   * 才能精确回位；update 记字段前后值（offset/width/name 是洞口仅有的 authored 字段）。
   */
  | { kind: 'insertOpening'; roomId: string; wallId: string; opening: Opening; index: number }
  | { kind: 'removeOpening'; roomId: string; wallId: string; opening: Opening; index: number }
  | {
      kind: 'updateOpening';
      roomId: string;
      wallId: string;
      openingId: string;
      prev: OpeningAuthored;
      next: OpeningAuthored;
    }
  /**
   * 镜像柜体（MI）：分区序列左右反序。反序的自逆就是自身（reverse 两次还原），
   * 所以 undo/redo 走同一个动作 —— 不需要快照前后两份。
   */
  | { kind: 'mirrorUnits'; cabinetId: string; from: string[]; to: string[]; basePath: string }
  /**
   * 组合（v0.3，P2）—— 整组插入/删除。
   * 与柜体同构：带 index 才能把整组放回原来的位置（组合顺序在界面与快照里都有意义）。
   */
  | { kind: 'insertAssembly'; asm: FurnitureAssembly; index: number }
  | { kind: 'removeAssembly'; asm: FurnitureAssembly; index: number }
  /**
   * 组合成员增删 / 关系增删 / 改名 —— 都记"前后两份"，不走路径回退：
   * `assemblies` 是数组，成员与关系都在数组元素里，用 `assemblies[3].memberIds`
   * 这种路径回退等于把整个数组换成新数组，撤销时会把别人同时做的改动一起卷回去。
   * 带前后快照的 patch 只还原这一处，是**最小可逆**的那一种。
   */
  | { kind: 'patchAssembly'; assemblyId: string; prev: FurnitureAssembly; next: FurnitureAssembly }
  /**
   * 整组平移：一次性改所有成员的 placement。
   * 存"每个成员的前后 x/y"，而不是存 dx/dy —— dx/dy 反向要取负，看似等价，
   * 但一旦中途有成员被单独移动过（别的命令），"整组 undo"就会把别的改动也吃掉。
   */
  | { kind: 'moveAssembly'; assemblyId: string; moves: Array<{ cabinetId: string; from: { x: number; y: number }; to: { x: number; y: number } }> }
  /**
   * 整项目替换（导入 / 恢复草稿）。它换掉的是【对象引用】而不是某个字段，
   * 所以不能走路径回退，undo/redo 里单独处理 —— 必须同时携带前后两份快照，
   * 两个方向都要能走。（这条曾缺失：replaceProject 声称可撤销，实际 undo 后
   * 路径回退静默失败，模型仍是导入后的项目 —— 断言第一次抓到的就是它。）
   */
  | { kind: 'replaceProject'; prev: Project; next: Project };

export interface LogEntry {
  seq: number;
  at: number;
  command: Command;
  label: string;
  diff: DiffEntry[];
  /** 路径编辑的逆运算（逐条 set 回旧值） */
  inverse: Change[];
  /** 结构性变更（插入/删除对象）无法用路径赋值逆运算，单独记录 */
  sideEffects?: SideEffect[];
  derived: DerivedSummary;
  issueDelta: { errors: number; warnings: number; added: Issue[] };
  applied: boolean;
  discarded: boolean;
  /**
   * 落位 provenance（P8.5-C1，会话内，不进 project.json）。
   * 仅落位相关命令（cabinet.place / move / rotate / nudge / resize，
   * assembly.move）会带；其它命令为 undefined。
   * assembly.move 影响多个成员 → 用数组（每条一个 targetId），同一条命令一次撤销。
   * ⚠ 任何派生层（几何 / 清单 / DXF / P8.3 校验 / 制造）**一律不读**——
   * 它是被动记录，真相源永远是 `Cabinet.placement`。
   */
  placementProvenance?: PlacementProvenance | PlacementProvenance[];
}

export interface DerivedSummary {
  panels: number;
  pieces: number;
  areaM2: number;
  weightKg: number;
}

export interface ExecResult {
  ok: boolean;
  error?: string;
  diff: DiffEntry[];
  /** 本次命令【新引入】的问题 */
  newIssues: Issue[];
  /** 本次命令【消除掉】的问题 */
  resolvedIssues: Issue[];
  derived: DerivedSummary;
  clamped: string[];
  /** 提交后（或试算后）仍存在的 ERROR 总数 —— 决定能否导出 */
  blockingErrors: number;
  /**
   * 被【记忆门】拦下的条目。
   * 与 error 字段的区别：error 是给人看的一句话，memoryHits 是结构化来源，
   * 让 AI/UI 能说清"是哪条记忆拦的、你当时的原话是什么"。
   */
  memoryHits: GateHit[];
}

/** 结构性 ops 白名单：这些 op 走 payload 分支，不做路径校验 */
const STRUCTURAL_OPS = new Set([
  'cabinet.create',
  'cabinet.delete',
  'cabinet.layout.addUnit',
  'cabinet.layout.removeUnit',
  'cabinet.mirror',
  'room.create',
  'room.delete',
  'room.resize',
  'wall.create',
  'wall.delete',
  'opening.create',
  'opening.delete',
  'opening.update',
  'assembly.create',
  'assembly.delete',
  'assembly.addMember',
  'assembly.removeMember',
  'assembly.connect',
  'assembly.disconnect',
  'assembly.move',
  'assembly.rename',
]);

/** 写路径白名单：不在名单里的路径一律拒绝（AI 越权防线 #3） */
const WRITABLE: Record<string, RegExp[]> = {
  'cabinet.move': [/^placement\.(x|y)$/],
  'cabinet.rotate': [/^placement\.rotation$/],
  /**
   * 确定性落位（P8.1）：Placement Engine（core/placement.ts）解析出的
   * x/y/rotation 用**一条命令**原子写入。与 move+rotate 两条命令的区别：
   * 落位是一个语义动作，中途态（转了没挪）不该存在，撤销也该是一步。
   * 坐标的"算"在引擎里（纯函数），这里的白名单只管"写" —— AI 仍然
   * 摸不到任何路径之外的写法。
   */
  'cabinet.place': [/^placement\.(x|y|rotation)$/],
  /**
   * cabinet.resize：拖夹点改宽/深时，可能需要同时补偿 placement
   * （例如拖左边缘 → 右边缘必须钉住不动，锚点得跟着挪）。
   * 必须是【一条命令】，否则中途态不是合法模型，撤销也会留下半截。
   */
  'cabinet.resize': [/^params\.(width|height|depth)$/, /^placement\.(x|y)$/],
  'cabinet.update': [
    /^params\.(width|height|depth|bodyLift|mountHeight|shelfFrontClearance|finishedEnds)$/,
    /^params\.backPanel\.(grooveDepth|grooveSetback|clearance|material|method)$/,
    /^params\.boardMaterial$/,
  ],
  'cabinet.rename': [/^name$/],
  /**
   * 多选移动：一条命令改多个柜体，撤销才是一步。
   * 逐柜发 N 条命令也能动，但撤销要按 N 次 —— 那不是用户的心智模型。
   */
  'cabinet.moveBatch': [/^cabinets\[\d+\]\.placement\.(x|y)$/],
  'cabinet.layout': [
    /^layout\.type$/,
    /^layout\.widthMode$/,
    /^layout\.units\[\d+\]\.(requestedWidth|nickname|kind)$/,
    /^layout\.units\[\d+\]\.(drawers)\.(count|gap|runner|runnerLength|boxHeightDeduct)$/,
    /^layout\.units\[\d+\]\.(shelves)\.(count|gapPerSide|ledStrip|tilt)$/,
    /^layout\.units\[\d+\]\.(doors)\.(count|gapOuter|gapMid|hinge|hingeSide|material)$/,
    /^layout\.units\[\d+\]\.(rod)\.(count|heightFromBottom|hardware)$/,
    /^layout\.units\[\d+\]\.appliance\.(name|openingWidth|openingHeight|openingDepth|topDrawers)$/,
    // 双面柜（岛台）的背面排 —— 与前排同一套旋钮，同一条白名单管两排
    /^layout\.backUnits\[\d+\]\.(requestedWidth|nickname|kind)$/,
    /^layout\.backUnits\[\d+\]\.(drawers)\.(count|gap|runner|runnerLength|boxHeightDeduct)$/,
    /^layout\.backUnits\[\d+\]\.(shelves)\.(count|gapPerSide|ledStrip|tilt)$/,
    /^layout\.backUnits\[\d+\]\.(doors)\.(count|gapOuter|gapMid|hinge|hingeSide|material)$/,
    /^layout\.backUnits\[\d+\]\.(rod)\.(count|heightFromBottom|hardware)$/,
    /^layout\.backUnits\[\d+\]\.appliance\.(name|openingWidth|openingHeight|openingDepth|topDrawers)$/,
    /**
     * 垂直行（v0.3）：多行柜里分区在 `layout.rows[j].units[k]`。
     * 字段清单与前排**逐字相同** —— 行只是多了一层容器，分区本身还是同一套旋钮。
     * `height` 是行唯一的 authored 字段（数字 = 固定净高 / 'fill' = 吃掉剩余内高）；
     * 行 id 不可改（它同时是派生、清单与拾取线的标识）。
     * 注意这些路径**只在 rows 已存在时才是合法路径**：单行柜的文件里没有 `rows`，
     * 写入会因为"不许凭空创建结构"被物理拦下（见 OPTIONAL_AUTHORED）——
     * 也就是说 P1 不可能把单行柜悄悄变成多行柜，只会被拒绝。
     */
    /^layout\.rows\[\d+\]\.height$/,
    /^layout\.rows\[\d+\]\.units\[\d+\]\.(requestedWidth|nickname|kind)$/,
    /^layout\.rows\[\d+\]\.units\[\d+\]\.(drawers)\.(count|gap|runner|runnerLength|boxHeightDeduct)$/,
    /^layout\.rows\[\d+\]\.units\[\d+\]\.(shelves)\.(count|gapPerSide|ledStrip|tilt)$/,
    /^layout\.rows\[\d+\]\.units\[\d+\]\.(doors)\.(count|gapOuter|gapMid|hinge|hingeSide|material)$/,
    /^layout\.rows\[\d+\]\.units\[\d+\]\.(rod)\.(count|heightFromBottom|hardware)$/,
    /^layout\.rows\[\d+\]\.units\[\d+\]\.appliance\.(name|openingWidth|openingHeight|openingDepth|topDrawers)$/,
  ],
  /**
   * 一键修复用的"去门"动作：电器洞口格配了门板（RULE-APPLIANCE-DOOR）时的修复动作。
   * 单独一个 op 而不是并入 cabinet.layout —— 路径写白名单要的是**精确到字段**，
   * 把 `layout.units[i].doors` 整个交给通用 op，等于让人能把 doors 写成任意垃圾。
   */
  'cabinet.layout.clearDoors': [/^layout\.units\[\d+\]\.doors$/, /^layout\.rows\[\d+\]\.units\[\d+\]\.doors$/],
  'wall.move': [/^(start|end)\.[xy]$/],
  'wall.update': [/^thickness$/, /^height$/, /^name$/],
  'room.rename': [/^rooms\[\d+\]\.name$/],
  'project.rename': [/^name$/],
};

/** 绝对不能改的路径前缀（派生字段 / 系统字段），即使白名单写错也拦一道 */
const DENY = [/^panels/, /^geometry/, /^issues/, /^stats/, /^id$/, /^schemaVersion$/, /^ruleSetId$/];

/** 项目级目标允许改的绝对路径 */
const SETTABLE_ABS = new Set(['name']);

function isWritablePath(op: string, path: string, isProjectTarget: boolean): boolean {
  if (DENY.some((d) => d.test(path))) return false;
  const rules = WRITABLE[op];
  if (rules && rules.some((r) => r.test(path))) return true;
  // 项目级目标：只允许显式列进 SETTABLE_ABS 的绝对路径
  return isProjectTarget && SETTABLE_ABS.has(path);
}

// ───────────────────────────── path 读写 ─────────────────────────────

type Token = { key: string; index?: number };

function parsePath(path: string): Token[] {
  return path.split('.').map((seg) => {
    const m = /^([A-Za-z_$][\w$]*)(?:\[(\d+)\])?$/.exec(seg);
    if (!m) throw new Error(`非法路径段: "${seg}"（完整路径 "${path}"）`);
    return m[2] === undefined ? { key: m[1] } : { key: m[1], index: Number(m[2]) };
  });
}

export function getByPath(root: unknown, path: string): unknown {
  let cur: any = root;
  for (const tk of parsePath(path)) {
    if (cur == null) return undefined;
    cur = cur[tk.key];
    if (tk.index !== undefined) {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[tk.index];
    }
  }
  return cur;
}

/**
 * 允许"从无到有"创建的叶子字段。
 * 只放**可选 authored 字段**：它们在类型上是 `?:`，首次赋值是正常业务操作。
 * 其余一律拒绝创建 —— 这是"派生字段永不写入模型"的最后一道物理防线。
 */
const OPTIONAL_AUTHORED = new Set(['nickname', 'type', 'backUnits', 'appliance', 'ledStrip', 'tilt', 'hingeSide', 'material']);

function setByPath(root: unknown, path: string, value: unknown): void {
  const toks = parsePath(path);
  let cur: any = root;
  for (let i = 0; i < toks.length - 1; i++) {
    const tk = toks[i];
    cur = cur[tk.key];
    if (cur == null || typeof cur !== 'object') throw new Error(`路径不存在: ${path}`);
    if (tk.index !== undefined) {
      cur = cur[tk.index];
      if (cur == null || typeof cur !== 'object') throw new Error(`路径不存在: ${path}`);
    }
  }
  const last = toks[toks.length - 1];
  if (last.index !== undefined) {
    const arr = cur[last.key];
    if (!Array.isArray(arr) || arr[last.index] === undefined) throw new Error(`路径不存在: ${path}`);
    arr[last.index] = value;
  } else {
    if (!(last.key in cur) && !OPTIONAL_AUTHORED.has(last.key)) {
      throw new Error(`字段不存在: ${path}（不允许新增字段）`);
    }
    cur[last.key] = value;
  }
}

const clampInt = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(v)));

/** 值域夹紧（防线 #4）：超范围不静默改，而是夹紧后回报 */
function sanitize(change: Change): { value: unknown; note?: string } {
  if (typeof change.value !== 'number') return { value: change.value };
  const key = change.path.split('.').pop() ?? '';
  const clampTo = (min: number, max: number, hint: string) => {
    const v = clampInt(change.value as number, min, max);
    return { value: v, note: v !== change.value ? `${change.path}：${String(change.value)} 被夹紧到 ${v}（${hint}）` : undefined };
  };
  if (key === 'rotation') return clampTo(-360, 360, '旋转角');
  if (key === 'x' || key === 'y') return clampTo(-100000, 100000, '世界坐标 mm');
  if (key === 'width' || key === 'height' || key === 'depth') return clampTo(100, 6000, '100~6000mm');
  if (key === 'bodyLift') return clampTo(0, 300, '踢脚高 0~300mm');
  if (key === 'mountHeight') return clampTo(0, 3000, '壁挂安装高度 0~3000mm');
  if (key === 'shelfFrontClearance') return clampTo(0, 100, '前沿让位');
  if (key === 'runnerLength') return clampTo(200, 600, '滑轨长度');
  if (key === 'gap' || key === 'gapOuter' || key === 'gapMid') return clampTo(0, 20, '缝隙');
  if (key === 'count') return clampTo(0, 40, '数量');
  if (key === 'heightFromBottom') return clampTo(0, 3000, '距内底高度');
  if (key === 'thickness') return clampTo(20, 400, '墙厚');
  return { value: change.value };
}

// ───────────────────────── 结构性变更的施加/回退 ─────────────────────────

function findCab(project: Project, id: string): number {
  return project.cabinets.findIndex((c) => c.id === id);
}
function findRoom(project: Project, id: string): number {
  return project.rooms.findIndex((r) => r.id === id);
}

/** 按 id 找墙（洞口挂在墙下，洞口操作需要定位到具体墙） */
function findWallById(project: Project, wallId: string): Wall | undefined {
  for (const r of project.rooms) {
    const w = r.walls.find((x) => x.id === wallId);
    if (w) return w;
  }
  return undefined;
}

/** forward=true 表示"重做/应用"，false 表示"撤销" */
function applySideEffect(project: Project, se: SideEffect, forward: boolean): void {
  switch (se.kind) {
    case 'insertCabinet': {
      const i = findCab(project, se.cab.id);
      if (forward) {
        if (i < 0) project.cabinets.splice(Math.min(se.index, project.cabinets.length), 0, structuredClone(se.cab));
      } else if (i >= 0) {
        project.cabinets.splice(i, 1);
      }
      return;
    }
    case 'removeCabinet': {
      const i = findCab(project, se.cab.id);
      if (forward) {
        if (i >= 0) project.cabinets.splice(i, 1);
      } else if (i < 0) {
        project.cabinets.splice(Math.min(se.index, project.cabinets.length), 0, structuredClone(se.cab));
      }
      return;
    }
    case 'addUnit': {
      const cab = project.cabinets.find((c) => c.id === se.cabinetId);
      if (!cab) return;
      const units = unitsAtPath(cab.layout, se.basePath);
      const i = units.findIndex((u) => u.id === se.unit.id);
      if (forward) {
        if (i < 0) units.splice(Math.min(se.index, units.length), 0, structuredClone(se.unit));
      } else if (i >= 0) {
        units.splice(i, 1);
      }
      return;
    }
    case 'removeUnit': {
      const cab = project.cabinets.find((c) => c.id === se.cabinetId);
      if (!cab) return;
      const units = unitsAtPath(cab.layout, se.basePath);
      const i = units.findIndex((u) => u.id === se.unit.id);
      if (forward) {
        if (i >= 0) units.splice(i, 1);
      } else if (i < 0) {
        units.splice(Math.min(se.index, units.length), 0, structuredClone(se.unit));
      }
      return;
    }
    case 'insertRoom': {
      const i = findRoom(project, se.room.id);
      if (forward) {
        if (i < 0) project.rooms.splice(Math.min(se.index, project.rooms.length), 0, structuredClone(se.room));
      } else if (i >= 0) {
        // 撤销建房间时，房间里的柜体必须一起走，否则会留下 orphan（悬空柜体）
        const roomId = project.rooms[i].id;
        project.rooms.splice(i, 1);
        project.cabinets = project.cabinets.filter((c) => c.roomId !== roomId);
      }
      return;
    }
    case 'removeRoom': {
      const i = findRoom(project, se.room.id);
      if (forward) {
        if (i >= 0) project.rooms.splice(i, 1);
      } else if (i < 0) {
        project.rooms.splice(Math.min(se.index, project.rooms.length), 0, structuredClone(se.room));
      }
      return;
    }
    case 'resizeRoom': {
      const room = project.rooms.find((r) => r.id === se.roomId);
      if (!room) return;
      for (const wl of se.walls) {
        const wall = room.walls.find((x) => x.id === wl.id);
        if (!wall) continue;
        const ns = forward ? wl.start : wl.prevStart;
        const ne = forward ? wl.end : wl.prevEnd;
        wall.start = { x: ns.x, y: ns.y };
        wall.end = { x: ne.x, y: ne.y };
      }
      return;
    }
    case 'insertWall': {
      const room = project.rooms.find((r) => r.id === se.roomId);
      if (!room) return;
      const i = room.walls.findIndex((w) => w.id === se.wall.id);
      if (forward) {
        if (i < 0) room.walls.splice(Math.min(se.index, room.walls.length), 0, structuredClone(se.wall));
      } else if (i >= 0) {
        room.walls.splice(i, 1);
      }
      return;
    }
    case 'removeWall': {
      const room = project.rooms.find((r) => r.id === se.roomId);
      if (!room) return;
      const i = room.walls.findIndex((w) => w.id === se.wall.id);
      if (forward) {
        if (i >= 0) room.walls.splice(i, 1);
      } else if (i < 0) {
        room.walls.splice(Math.min(se.index, room.walls.length), 0, structuredClone(se.wall));
      }
      return;
    }
    case 'insertOpening': {
      const wall = findWallById(project, se.wallId);
      if (!wall) return;
      wall.openings ??= [];
      const i = wall.openings.findIndex((o) => o.id === se.opening.id);
      if (forward) {
        if (i < 0) wall.openings.splice(Math.min(se.index, wall.openings.length), 0, structuredClone(se.opening));
      } else if (i >= 0) {
        wall.openings.splice(i, 1);
      }
      return;
    }
    case 'removeOpening': {
      const wall = findWallById(project, se.wallId);
      if (!wall || !wall.openings) return;
      const i = wall.openings.findIndex((o) => o.id === se.opening.id);
      if (forward) {
        if (i >= 0) wall.openings.splice(i, 1);
      } else if (i < 0) {
        wall.openings.splice(Math.min(se.index, wall.openings.length), 0, structuredClone(se.opening));
      }
      return;
    }
    case 'updateOpening': {
      const wall = findWallById(project, se.wallId);
      if (!wall?.openings) return;
      const index = wall.openings.findIndex((x) => x.id === se.openingId);
      if (index < 0) return;
      const cur = wall.openings[index]!;
      const v = forward ? se.next : se.prev;
      /**
       * **整对象重建、键序固定**（不是逐字段赋值）。
       *
       * 为什么必须重建：新增的 hinge / swingDirection 是可缺省的，
       * 若用 `delete` + 赋值，同一个逻辑状态会因为"用户先后点的是哪个按钮"
       * 得到不同的键序 —— 于是存盘字节不同、diff 里冒出假变化。
       * 键序在这里一次性钉死：id → kind → offset → width → name → hinge → swingDirection。
       * id/kind 是洞口的身份与类型（本命令不改），照抄。
       *
       * 未知字段**原样带走**（排在已知字段之后）：将来给洞口加了新 authored 字段
       * 而忘了改这里，也不能让一条"改缝宽"的命令把它悄悄删掉。
       */
      const KNOWN = new Set(['id', 'kind', 'offset', 'width', 'name', 'hinge', 'swingDirection']);
      const extras = Object.fromEntries(Object.entries(cur).filter(([k]) => !KNOWN.has(k)));
      wall.openings[index] = {
        id: cur.id,
        kind: cur.kind,
        offset: v.offset,
        width: v.width,
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.hinge !== undefined ? { hinge: v.hinge } : {}),
        ...(v.swingDirection !== undefined ? { swingDirection: v.swingDirection } : {}),
        ...extras,
      };
      return;
    }
    case 'mirrorUnits': {
      const cab = project.cabinets.find((c) => c.id === se.cabinetId);
      if (!cab) return;
      // 反序自逆：undo / redo 都执行同一个 reverse（两次 reverse = 还原）。
      // 照抄 se.from 校验一次，防止未来有人在别处动了顺序导致快照失真。
      const units = unitsAtPath(cab.layout, se.basePath);
      const cur = units.map((u) => u.id);
      const expect = forward ? se.from : se.to;
      if (cur.length === expect.length && cur.every((id, i) => id === expect[i])) {
        units.reverse();
        // 双面柜：背面排跟着镜像 —— 只翻前排不翻后排，"镜像"就是假的
        if (Array.isArray(cab.layout.backUnits)) cab.layout.backUnits.reverse();
      }
      return;
    }

    // ───────────── 组合（v0.3，P2）─────────────
    case 'insertAssembly': {
      const list = project.assemblies ?? (project.assemblies = []);
      if (forward) {
        const i = list.findIndex((a) => a.id === se.asm.id);
        if (i < 0) list.splice(Math.min(se.index, list.length), 0, structuredClone(se.asm));
      } else {
        const i = list.findIndex((a) => a.id === se.asm.id);
        if (i >= 0) list.splice(i, 1);
      }
      return;
    }
    case 'removeAssembly': {
      const list = project.assemblies ?? (project.assemblies = []);
      const i = list.findIndex((a) => a.id === se.asm.id);
      if (forward) {
        if (i >= 0) list.splice(i, 1);
      } else if (i < 0) {
        list.splice(Math.min(se.index, list.length), 0, structuredClone(se.asm));
      }
      return;
    }
    case 'patchAssembly': {
      const list = project.assemblies ?? (project.assemblies = []);
      const i = list.findIndex((a) => a.id === se.assemblyId);
      if (i < 0) return;
      list[i] = structuredClone(forward ? se.next : se.prev);
      return;
    }
    case 'moveAssembly': {
      for (const m of se.moves) {
        const cab = project.cabinets.find((c) => c.id === m.cabinetId);
        if (!cab) continue;
        const at = forward ? m.to : m.from;
        cab.placement = { ...cab.placement, x: at.x, y: at.y };
      }
      return;
    }
  }
}

function applySideEffects(project: Project, list: SideEffect[], forward: boolean): void {
  // 撤销必须逆序：真实顺序是[建房间, 加墙]，逆序才是[去墙, 去房间]
  const seq = forward ? list : [...list].reverse();
  for (const se of seq) applySideEffect(project, se, forward);
}

// ───────────────────────────── Bus ─────────────────────────────

export class CommandBus {
  private project: Project;
  private rules: RuleSet;
  private entries: LogEntry[] = [];
  private pointer = -1;
  private listeners = new Set<() => void>();
  /** 几何缓存：只在 modelVersion 变化时重算（缓存失效的唯一依据） */
  private geomCache: { version: number; geom: ProjectGeometry; issues: Issue[] } | null = null;
  /**
   * 分解图缓存。
   *
   * 为什么它不进 geomCache：分解图是**开关控制的可选视图**，默认关闭。
   * 如果把它塞进每次 derive 都跑的那条路，就等于"永远都在算一张没人看的图"，
   * 而且"关掉分解图"会跟"没有分解图"混为一谈。
   * 缓存键带上 enabled，切换开关必然重算，不存在"开了还显示旧结果"。
   */
  private explodeCache: { key: string; set: ProjectExplodeSet } | null = null;
  private modelVersion = 0;
  /**
   * 记忆门：由 ai/memory.ts 的 compileCorrections() 编译出来的可执行检查。
   *
   * 挂在总线而不是 AI 层，是有意的：UI 点击、拖动、AI、MCP、脚本五条路都经过这里，
   * 所以"你说过的话"既拦得住 AI，也拦得住你自己的手滑；而且不需要 AI 在线。
   */
  private gate: Gate | null = null;
  /**
   * 落位 provenance 的 live 存储（P8.5-B，会话内权威）。
   * 每次 execute/undo/redo 后由 `recomputeProvenance` 从「加载基线 baselineProv」
   * 重置、再用 activeLog 里的 live 覆盖。
   *
   * ── 为什么 provenance 不写进会话内存模型（Cabinet）──
   * 「预览 === 提交」与「干跑终点 === 提交终点逐字节相同」是本项目的核心不变量，
   * 而干跑（沙盒）与真提交对同一条 AI 命令的 authority 判定天然不同（沙盒未打
   * confirmedPlan → unknown；提交已确认 → user-confirmed）——这是**真实的语义差异**，
   * 不是 bug。provenance 一旦进模型，这个差异就会让逐字节比对永远变红。
   * 所以 provenance 只住总线（这里），保存时经 `toFileSnapshot()` 物化成文件形状，
   * 加载时经 `seedProvenanceFromProject` 种子化回来——模型里永远干净。
   */
  private provById = new Map<string, PlacementProvenance>();
  /**
   * 加载基线（P8.5-B）：构造/整批载入时从文件里每柜 `placementProvenance` 种子化。
   * 撤销某条落位命令后，该柜回到"加载时"的状态 → provenance 自然回到基线（或基线为空则清空，
   * 不会残留已被撤销的命令的 live）。
   */
  private baselineProv = new Map<string, PlacementProvenance>();

  constructor(project: Project, rules: RuleSet) {
    /**
     * 防呆（踩过一次）：这两个参数写反**照样能编译、照样能跑**，只是把规则集当项目存起来，
     * 然后在一句"读 .materials 炸了"的地方才露馅 —— 离调用点越远越难查。
     * 参数顺序对不对，在构造函数里一眼就能看出来，别留给运行期。
     */
    if (!project || !Array.isArray((project as unknown as Project).cabinets)) {
      throw new Error(`CommandBus 的第一个参数应是 Project（要有 cabinets 数组），收到 ${typeof project}`);
    }
    if (!project || !rules || typeof rules !== 'object' || typeof (rules as RuleSet).materials !== 'object') {
      throw new Error(`CommandBus 的第二个参数应是 RuleSet（要有 materials），收到 ${typeof rules}`);
    }
    this.project = structuredClone(project);
    this.rules = rules;
    // P8.5-B：把文件里每柜的 placementProvenance 种子为本会话的 live 基线，
    // 使跨会话来源可见、user-confirmed 不退化、后续命令能正确 supersede。
    // 随后把该字段从内存模型剥掉——模型里永远干净（预览===提交的结构保证）。
    this.seedProvenanceFromProject(this.project);
    this.stripProvenanceFields(this.project);
  }

  /** 设置/清除记忆门。传 null 表示关闭（例如回放旧会话时不想被新规矩拦住） */
  setGate(gate: Gate | null): void {
    this.gate = gate;
  }
  hasGate(): boolean {
    return this.gate !== null;
  }

  // ── 读 ──
  getState(): Project {
    return this.project;
  }
  getRules(): RuleSet {
    return this.rules;
  }
  getVersion(): number {
    return this.modelVersion;
  }

  /** 派生几何 + 全量校验问题（带缓存，按 modelVersion 失效） */
  derive(): { geom: ProjectGeometry; issues: Issue[] } {
    if (this.geomCache && this.geomCache.version === this.modelVersion) return this.geomCache;
    const r = this.deriveFor(this.project);
    this.geomCache = { version: this.modelVersion, geom: r.geom, issues: r.issues };
    return this.geomCache;
  }

  issues(): Issue[] {
    return this.derive().issues;
  }

  /**
   * 分解图（爆炸图）—— 按需派生。
   *
   * `enabled = false` 时**连装配数据都不算**（零开销），并且返回的 set 里
   * `enabled === false` 且 prims 为空。这样"关"与"没有"在类型上就是分得开的：
   * 界面可以说"关闭"，而不是"这张图是空的"。
   *
   * `below` 传四视图图幅的包围盒 → 分解图永远摆在它正下方，两张图不会重叠。
   * 这个关系是算出来的，不是调间距调出来的。
   */
  deriveExplode(enabled: boolean): ProjectExplodeSet {
    const key = `${this.modelVersion}|${enabled ? 1 : 0}`;
    if (this.explodeCache && this.explodeCache.key === key) return this.explodeCache.set;
    const set = buildProjectExplode(this.project, this.rules, { enabled, below: this.derive().geom.views.bbox });
    this.explodeCache = { key, set };
    return set;
  }

  /** 是否处于"不可交付"状态 —— 阻断的是导出，不是编辑 */
  hasBlockingErrors(): boolean {
    return this.issues().some((i) => i.severity === 'ERROR');
  }

  /**
   * 派生汇总（只读出口）：板件数 / 件数 / 面积 / 重量。
   *
   * 为什么要有这个出口：`sumDerived` 的口径（面积、重量怎么加、保留几位）
   * 只允许存在**一处**。只读消费者（P10.0 S2 的 MCP `cad.validate`）需要这份汇总时，
   * 必须来这里取，而不是在下游按 geom 再算一遍 —— 否则迟早出现两个"总重量"。
   * 本方法不改模型、不落盘、无副作用。
   */
  derivedSummary(): DerivedSummary {
    return this.sumDerived(this.derive().geom);
  }

  // ── 订阅 ──
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // ── 日志 ──
  log(): LogEntry[] {
    return this.entries;
  }
  canUndo(): boolean {
    return this.pointer >= 0;
  }
  canRedo(): boolean {
    return this.pointer + 1 < this.entries.length;
  }
  /** 已生效的日志条目（从旧到新），供历史面板展示 */
  activeLog(): LogEntry[] {
    return this.entries.slice(0, this.pointer + 1);
  }

  /**
   * 干跑规划：只算出"如果执行会变成什么样"，绝不触碰 this.project。
   * execute 与 preview 共用这一份，因此【预览结果 === 提交结果】是结构性保证，
   * 而不是"两边都写对了"的巧合。拖动柜体时屏幕上看到的就是提交后必然得到的。
   */
  plan(
    cmd: Command
  ):
    | { ok: true; draft: Project; diff: DiffEntry[]; inverse: Change[]; sideEffects: SideEffect[]; clamped: string[] }
    | { ok: false; error: string } {
    const isStructural = STRUCTURAL_OPS.has(cmd.op);

    // ① 目标与载荷校验
    if (cmd.target && cmd.target.kind === 'cabinet') {
      if (findCab(this.project, cmd.target.id) < 0) return { ok: false, error: `找不到柜体 ${cmd.target.id}` };
    }
    if (isStructural) {
      if (cmd.op === 'cabinet.create' && !cmd.payload?.cabinet) {
        return { ok: false, error: 'cabinet.create 缺少 payload.cabinet' };
      }
      if (cmd.op === 'cabinet.layout.addUnit' && !cmd.payload?.unit) {
        return { ok: false, error: 'addUnit 缺少 payload.unit' };
      }
      if (cmd.op === 'cabinet.layout.removeUnit' && !cmd.payload?.unitId) {
        return { ok: false, error: 'removeUnit 缺少 payload.unitId' };
      }
      if (cmd.op === 'wall.create' && !cmd.payload?.wall) {
        return { ok: false, error: 'wall.create 缺少 payload.wall' };
      }
      if (cmd.op === 'room.create' && !cmd.payload?.room) {
        return { ok: false, error: 'room.create 缺少 payload.room' };
      }
      // 组合：载荷缺什么就说什么（plan 那边也会 return null，但这里给得出人话）
      if (cmd.op === 'assembly.create' && !cmd.payload?.assembly) {
        return { ok: false, error: 'assembly.create 缺少 payload.assembly' };
      }
      if (cmd.op === 'assembly.connect' && !cmd.payload?.connection) {
        return { ok: false, error: 'assembly.connect 缺少 payload.connection' };
      }
      if (cmd.op === 'assembly.disconnect' && !cmd.payload?.connectionId) {
        return { ok: false, error: 'assembly.disconnect 缺少 payload.connectionId' };
      }
      if (
        cmd.op.startsWith('assembly.') && cmd.op !== 'assembly.create' && !cmd.payload?.assemblyId
      ) {
        return { ok: false, error: `${cmd.op} 缺少 payload.assemblyId` };
      }
      /**
       * room.delete 含柜体时拒绝：删房间会把房间从数组摘掉，但柜体的 roomId 仍指着它
       * → 悬空柜体（生成器读不到房间 → 尺寸/归属全乱）。与其静默留下孤儿，不如明确拦下，
       * 让用户先把柜体移走/删掉。这和 cabinet.create「没有房间不能建柜」是同一道防线的两头。
       */
      if (cmd.op === 'room.delete') {
        const rid = cmd.payload?.roomId;
        const n = this.project.cabinets.filter((c) => c.roomId === rid).length;
        if (n > 0) {
          return { ok: false, error: `房间内有 ${n} 个柜体，无法删除（请先移走或删除这些柜体）` };
        }
      }
    } else if (cmd.changes.length === 0) {
      return { ok: false, error: '命令没有携带任何变更' };
    }

    // ② 写权限 + 路径白名单校验
    const clamped: string[] = [];
    if (!isStructural) {
      const isProjectTarget = !cmd.target || cmd.target.kind === 'project';
      for (const ch of cmd.changes) {
        if (!isWritablePath(cmd.op, ch.path, isProjectTarget)) {
          return {
            ok: false,
            error: `越权写入被拒绝：op="${cmd.op}" 不允许修改 "${ch.path}"（派生字段与规则集对 AI 只读）`,
          };
        }
      }
    }

    // ③ 在副本上试算
    const draft = structuredClone(this.project);
    const diff: DiffEntry[] = [];
    const inverse: Change[] = [];
    let sideEffects: SideEffect[] = [];

    if (isStructural) {
      const built = this.planStructural(cmd, draft);
      if (!built) {
        // mirror 的最常见拒绝原因值得说人话：单分区柜没有"左右"可翻
        const why =
          cmd.op === 'cabinet.mirror'
            ? '单分区柜体没有左右分区可翻（镜像至少需要 2 个分区）'
            : cmd.op;
        return { ok: false, error: `结构性命令失败：${why}` };
      }
      sideEffects = built.sideEffects;
      diff.push(...built.diff);
      applySideEffects(draft, sideEffects, true);
    } else {
      const root: any =
        !cmd.target || cmd.target.kind === 'project'
          ? draft
          : cmd.target.kind === 'cabinet'
            ? draft.cabinets.find((c) => c.id === cmd.target!.id)
            : this.findWall(draft, cmd.target.id);
      if (root === undefined) return { ok: false, error: `找不到目标 ${cmd.target?.id}` };

      for (const ch of cmd.changes) {
        const before = getByPath(root, ch.path);
        if (before === undefined) return { ok: false, error: `路径不存在: ${ch.path}` };
        const s = sanitize(ch);
        if (s.note) clamped.push(s.note);
        let next: unknown = s.value;
        if (ch.op === 'add') next = (Number(before) || 0) + (Number(s.value) || 0);
        try {
          setByPath(root, ch.path, next);
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
        diff.push({ path: ch.path, from: before, to: next });
        inverse.push({ path: ch.path, op: 'set', value: before as Change['value'], unit: ch.unit });
      }
    }

    if (diff.length === 0) return { ok: false, error: '命令没有产生任何变更' };
    return { ok: true, draft, diff, inverse, sideEffects, clamped };
  }

  /**
   * 干跑读取：返回"执行后模型会变成什么样"。
   * 拖动/夹点编辑的实时预览走这里 —— 因此预览必然与提交结果逐位一致。
   */
  preview(cmd: Command): { ok: boolean; error?: string; project: Project } {
    const p = this.plan(cmd);
    return p.ok ? { ok: true, project: p.draft } : { ok: false, error: p.error, project: this.project };
  }

  /**
   * 执行命令。
   * dryRun = true 时完全不改变状态，只回传 diff + 问题变化（AI 两段式的第一步）
   * strict = true 时，只要本次命令【新引入】ERROR 就拒绝提交
   */
  execute(
    cmd: Command,
    opts: { dryRun?: boolean; commitLabel?: string; strict?: boolean } = {}
  ): ExecResult {
    const dryRun = opts.dryRun ?? false;
    const strict = opts.strict ?? false;
    const empty = (error?: string): ExecResult => ({
      ok: false,
      error,
      diff: [],
      newIssues: [],
      resolvedIssues: [],
      derived: this.sumDerived(this.derive().geom),
      clamped: [],
      blockingErrors: 0,
      memoryHits: [],
    });

    const planned = this.plan(cmd);
    if (!planned.ok) return empty(planned.error);
    const { draft, diff, inverse, sideEffects, clamped } = planned;

    // ④ 试算派生数据 + 规则（这就是干跑的价值：先看后果）
    const before = this.derive();
    const trial = this.deriveFor(draft);
    const afterDerived = this.sumDerived(trial.geom);

    const keyOf = (i: Issue): string => `${i.severity}|${i.code}|${i.target}`;
    const beforeKeys = new Set(before.issues.map(keyOf));
    const afterKeys = new Set(trial.issues.map(keyOf));
    const newIssues = trial.issues.filter((i) => !beforeKeys.has(keyOf(i)));
    const resolvedIssues = before.issues.filter((i) => !afterKeys.has(keyOf(i)));
    const blockingErrors = trial.issues.filter((i) => i.severity === 'ERROR').length;
    const newErrors = newIssues.filter((i) => i.severity === 'ERROR');

    /**
     * ④.5 记忆门 —— 用户/AI 纠正过的规矩在这里把门。
     *
     * 位置特意放在【试算之后、提交之前】：
     *  · 走的是和 strict 模式同一套 before/after 对比，所以只拦"这次操作新引入的违规"，
     *    历史遗留问题不会让之后每一步都被卡住
     *  · dryRun 也照样过门 → AI 两段式的第一步就能预告"这一步会被你的记忆拦住"，
     *    而不是等到提交才失败
     *
     * ── 为什么它排在 strict **之前**（一次真实的次序缺陷）──
     *  原先 strict 在前。当一次操作同时触发"新引入 ERROR"和"违反某条记忆"时，
     *  返回的是错误信息只有前者 —— 于是**记忆命中被整个掩盖**：
     *  `memoryHits` 是空的，界面上的「最近一次拦截」永远不更新，
     *  而"被你说的某句话拦住过"正是记忆功能最该留下的痕迹。
     *  两条门都拒绝这次操作，但**该报哪一条**是有讲究的：
     *  记忆是"你上次亲口说过不要这样"，比一条通用规则更具体、更可行动，
     *  所以让它先说话。规则 ERROR 并不会因此消失 —— 它们照旧在 newIssues 里，
     *  界面照样一条条列出来。
     */
    const memoryHits = this.gate ? this.gate({ cmd, before: this.project, draft, newIssues, rules: this.rules }) : [];
    if (memoryHits.length > 0) {
      return {
        ok: false,
        error: formatGateError(memoryHits),
        diff,
        newIssues,
        resolvedIssues,
        derived: afterDerived,
        clamped,
        blockingErrors,
        memoryHits,
      };
    }

    if (strict && newErrors.length > 0) {
      return {
        ok: false,
        error: `严格模式：本次操作新引入 ${newErrors.length} 条 ERROR，已拒绝。${newErrors[0].message}`,
        diff,
        newIssues,
        resolvedIssues,
        derived: afterDerived,
        clamped,
        blockingErrors,
        memoryHits: [],
      };
    }

    const result: ExecResult = { ok: true, diff, newIssues, resolvedIssues, derived: afterDerived, clamped, blockingErrors, memoryHits: [] };

    if (dryRun) return result;

    // ⑤ 提交：丢弃 redo 分支
    if (this.pointer + 1 < this.entries.length) {
      for (let i = this.pointer + 1; i < this.entries.length; i++) this.entries[i].discarded = true;
      this.entries = this.entries.slice(0, this.pointer + 1);
    }
    this.project = draft;
    this.modelVersion++;
    this.geomCache = null;

    // P8.5-C1：落位 provenance（会话内，不进 project.json）。
    // 只声明不决定坐标；atVersion = 提交后的版本号。总线单点写、派生层不读。
    const provs: PlacementProvenance[] | undefined = PLACEMENT_OPS.has(cmd.op)
      ? affectedPlacementCabinets(cmd, draft).map((id) => ({
          targetId: id,
          intent: cmd.placementIntent ?? null,
          authority: derivePlacementAuthority(cmd),
          byOp: cmd.op,
          atVersion: this.modelVersion,
          status: 'live' as const,
        }))
      : undefined;

    this.entries.push({
      seq: this.entries.length + 1,
      at: Date.now(),
      command: cmd,
      label: opts.commitLabel ?? cmd.label ?? cmd.op,
      diff,
      inverse,
      sideEffects: sideEffects.length > 0 ? sideEffects : undefined,
      derived: afterDerived,
      issueDelta: {
        errors: newErrors.length,
        warnings: newIssues.filter((i) => i.severity === 'WARNING').length,
        added: newIssues,
      },
      applied: true,
      discarded: false,
      ...(provs ? { placementProvenance: provs.length === 1 ? provs[0] : provs } : {}),
    });
    this.pointer = this.entries.length - 1;
    this.recomputeProvenance();
    this.notify();
    return result;
  }

  /** 结构性命令：只计算"要施加什么"，不直接改 this.project */
  private planStructural(
    cmd: Command,
    draft: Project
  ): { sideEffects: SideEffect[]; diff: DiffEntry[] } | null {
    const p = cmd.payload ?? {};

  /** 结构性分区操作的目标行：单行柜缺省第 0 行；多行柜必须显式指定（否则拒绝） */
  const targetRowOf = (cab: Cabinet): { units: UnitSpec[]; basePath: string } | null => {
    const rows = layoutRows(cab.layout);
    if (rows.length > 1 && p.rowIndex === undefined) return null;
    const ri = p.rowIndex ?? 0;
    const row = rows[ri];
    if (!row) return null;
    return { units: row.units, basePath: unitPathPrefix(cab.layout, ri) };
  };

  if (cmd.op === 'cabinet.create') {
    const cab = structuredClone(p.cabinet!);
    // 归一化：补齐可能缺失的默认值（AI 只给核心字段时也能落地）
    const base = defaultCabinetParams(this.rules);
    cab.params = { ...base, ...cab.params, backPanel: { ...base.backPanel, ...cab.params?.backPanel } };
    /**
     * 没有任何分区时才补默认分区。
     * ⚠ 判据必须是 `layoutRows()`（canonical）而不是"`units` 存不存在"：
     * 多行柜按约定**不写 units 镜像**（见 layoutModel.toFileLayout），
     * 若照旧判 `!cab.layout.units` 就会把整个 rows 结构**覆盖掉**换成单行默认分区 ——
     * 上层柜体在创建的那一刻被静默删掉，而调用方看到的是"创建成功"。
     */
    // 判据只用 canonical 的 allUnits —— 不在这里再判一次"有没有 rows"
    const hasAnyUnits = cab.layout ? allUnits(cab.layout).length > 0 : false;
    if (!cab.layout || !hasAnyUnits) {
      cab.layout = { type: 'row', widthMode: 'fit_total', units: defaultUnits(cab.params.width, this.rules, cab.params.depth) };
    }
    if (!cab.id) cab.id = nextId('cab', draft.cabinets.map((c) => c.id));
    if (draft.cabinets.some((c) => c.id === cab.id)) return null;
    const room = draft.rooms.find((r) => r.id === cab.roomId) ?? draft.rooms[0];
    if (!room) return null; // 没有房间时不能建柜（避免悬空柜体）
    cab.roomId = room.id;
    const index = draft.cabinets.length;
    return {
      sideEffects: [{ kind: 'insertCabinet', cab, index }],
      diff: [{ path: '(cabinet.create)', from: null, to: `${cab.id} ${cab.name}` }],
    };
  }

    if (cmd.op === 'cabinet.delete') {
      const id = cmd.target?.id;
      if (!id) return null;
      const index = findCab(draft, id);
      if (index < 0) return null;
      const cab = structuredClone(draft.cabinets[index]);
      return {
        sideEffects: [{ kind: 'removeCabinet', cab, index }],
        diff: [{ path: '(cabinet.delete)', from: `${cab.id} ${cab.name}`, to: null }],
      };
    }

    if (cmd.op === 'cabinet.layout.addUnit') {
      const id = cmd.target?.id;
      if (!id) return null;
      const cab = draft.cabinets.find((c) => c.id === id);
      if (!cab) return null;
      const row = targetRowOf(cab);
      if (!row) return null; // 多行柜未指定行 → 拒绝，绝不猜（猜错＝把分区加到别的楼层）
      const unit = structuredClone(p.unit!);
      if (!unit.id) unit.id = nextId('unit', row.units.map((u) => u.id));
      if (row.units.some((u) => u.id === unit.id)) return null;
      if (typeof unit.requestedWidth !== 'number') {
        const rest = cab.params.width - row.units.reduce((a, u) => a + u.requestedWidth, 0);
        unit.requestedWidth = Math.max(150, Math.round(rest));
      }
      const index = row.units.length;
      return {
        sideEffects: [{ kind: 'addUnit', cabinetId: id, unit, index, basePath: row.basePath }],
        diff: [{ path: `${row.basePath}[${index}]`, from: null, to: unit.id }],
      };
    }

    if (cmd.op === 'cabinet.layout.removeUnit') {
      const id = cmd.target?.id;
      const unitId = p.unitId!;
      if (!id) return null;
      const cab = draft.cabinets.find((c) => c.id === id);
      if (!cab) return null;
      const row = targetRowOf(cab);
      if (!row) return null;
      const index = row.units.findIndex((u) => u.id === unitId);
      if (index < 0) return null;
      if (row.units.length <= 1) return null; // 至少保留一个分区，否则不是柜子
      const unit = structuredClone(row.units[index]);
      return {
        sideEffects: [{ kind: 'removeUnit', cabinetId: id, unit, index, basePath: row.basePath }],
        diff: [{ path: `${row.basePath}[${index}]`, from: unit.id, to: null }],
      };
    }

    if (cmd.op === 'cabinet.mirror') {
      const id = cmd.target?.id;
      if (!id) return null;
      const cab = draft.cabinets.find((c) => c.id === id);
      if (!cab) return null;
      const row = targetRowOf(cab);
      if (!row) return null;
      // 单分区没有"左右"可翻 —— 拒绝，让 UI 给出解释而不是静默成功
      if (row.units.length < 2) return null;
      const from = row.units.map((u) => u.id);
      const to = from.slice().reverse();
      return {
        sideEffects: [{ kind: 'mirrorUnits', cabinetId: id, from, to, basePath: row.basePath }],
        diff: [{ path: row.basePath, from: from.join('|'), to: to.join('|') }],
      };
    }

    // ════════════════ 组合（v0.3，P2）════════════════
    //
    // 这一组 op 的公共纪律：
    //   ① **引用必须存在**。成员/关系指向不存在的柜体一律拒绝 —— 让调用方看到
    //      "失败了"，而不是留一条下次派生时才炸的脏数据。
    //   ② **不猜房间**。组合的 roomId 取自第一个成员；成员跨房间时直接拒绝，
    //      而不是"取多数派"那种自作聪明。
    //   ③ **落位不由这里算**。整体移动只做平移（改 x/y），"移到哪不撞"仍由
    //      detectCollisions 在提交时判定 —— 关系层不写第二套坐标。
    if (cmd.op === 'assembly.create') {
      const asm = structuredClone(p.assembly!);
      if (!asm.memberIds || asm.memberIds.length === 0) return null;
      const cabById = new Map(draft.cabinets.map((c) => [c.id, c]));
      for (const id of asm.memberIds) if (!cabById.has(id)) return null;
      // 成员必须同房间：跨房间的"一组家具"没有意义，且整组移动会跨房间乱飞
      const rooms = new Set(asm.memberIds.map((id) => cabById.get(id)!.roomId));
      if (rooms.size > 1) return null;
      const roomId = asm.roomId || cabById.get(asm.memberIds[0]!)!.roomId;
      asm.roomId = roomId;
      if (!asm.id) asm.id = nextId('asm', (draft.assemblies ?? []).map((a) => a.id));
      if ((draft.assemblies ?? []).some((a) => a.id === asm.id)) return null;
      // 关系 id 也要唯一：id 撞车不会报错，只会让两条关系共用一条记录
      const takenConn = new Set<string>();
      for (const c of asm.connections) {
        if (!c.id) c.id = nextId('conn', takenConn);
        takenConn.add(c.id);
        if (!asm.memberIds.includes(c.a.cabinetId) || !asm.memberIds.includes(c.b.cabinetId)) return null;
        c.origin = 'authored';
      }
      const index = (draft.assemblies ?? []).length;
      return {
        sideEffects: [{ kind: 'insertAssembly', asm, index }],
        diff: [{ path: '(assembly.create)', from: null, to: `${asm.id} ${asm.name}` }],
      };
    }

    if (cmd.op === 'assembly.delete') {
      const id = p.assemblyId;
      if (!id) return null;
      const list = draft.assemblies ?? [];
      const index = list.findIndex((a) => a.id === id);
      if (index < 0) return null;
      const asm = structuredClone(list[index]!);
      return {
        sideEffects: [{ kind: 'removeAssembly', asm, index }],
        diff: [{ path: '(assembly.delete)', from: `${asm.id} ${asm.name}`, to: null }],
      };
    }

    if (cmd.op === 'assembly.addMember' || cmd.op === 'assembly.removeMember') {
      const id = p.assemblyId;
      const cabId = p.cabinetId;
      if (!id || !cabId) return null;
      const list = draft.assemblies ?? [];
      const i = list.findIndex((a) => a.id === id);
      if (i < 0) return null;
      const asm = list[i]!;
      const cab = draft.cabinets.find((c) => c.id === cabId);
      if (!cab) return null;
      const prev = structuredClone(asm);
      const next = structuredClone(asm);
      if (cmd.op === 'assembly.addMember') {
        if (next.memberIds.includes(cabId)) return null;
        // 跨房间不合并：宁可拒绝，不可让"整组移动"把一个柜搬到另一个房间去
        if (cab.roomId !== next.roomId) return null;
        next.memberIds.push(cabId);
      } else {
        const k = next.memberIds.indexOf(cabId);
        if (k < 0) return null;
        next.memberIds.splice(k, 1);
        // 成员走了，指向它的关系也必须一起走 —— 留着就是"指向组合外"的 ERROR
        next.connections = next.connections.filter((c) => c.a.cabinetId !== cabId && c.b.cabinetId !== cabId);
      }
      return {
        sideEffects: [{ kind: 'patchAssembly', assemblyId: id, prev, next }],
        diff: [{ path: `assemblies[${i}].memberIds`, from: prev.memberIds.join('|'), to: next.memberIds.join('|') }],
      };
    }

    if (cmd.op === 'assembly.connect' || cmd.op === 'assembly.disconnect') {
      const id = p.assemblyId;
      if (!id) return null;
      const list = draft.assemblies ?? [];
      const i = list.findIndex((a) => a.id === id);
      if (i < 0) return null;
      const asm = list[i]!;
      const prev = structuredClone(asm);
      const next = structuredClone(asm);
      if (cmd.op === 'assembly.connect') {
        const conn = structuredClone(p.connection!);
        if (!conn) return null;
        if (!next.memberIds.includes(conn.a.cabinetId) || !next.memberIds.includes(conn.b.cabinetId)) return null;
        if (conn.a.cabinetId === conn.b.cabinetId) return null;
        // 同一对柜只可能有一种空间关系 —— 重复声明会让校验永远有一条 ERROR
        const dup = next.connections.some(
          (c) => pairKey(c.a.cabinetId, c.b.cabinetId) === pairKey(conn.a.cabinetId, conn.b.cabinetId)
        );
        if (dup) return null;
        if (!conn.id) conn.id = nextId('conn', next.connections.map((c) => c.id));
        conn.origin = 'authored';
        next.connections.push(conn);
      } else {
        const connId = p.connectionId;
        if (!connId) return null;
        const k = next.connections.findIndex((c) => c.id === connId);
        if (k < 0) return null;
        next.connections.splice(k, 1);
      }
      return {
        sideEffects: [{ kind: 'patchAssembly', assemblyId: id, prev, next }],
        diff: [{ path: `assemblies[${i}].connections`, from: `${prev.connections.length} 条`, to: `${next.connections.length} 条` }],
      };
    }

    if (cmd.op === 'assembly.move') {
      const id = p.assemblyId;
      const dx = p.dx;
      const dy = p.dy;
      if (!id || typeof dx !== 'number' || typeof dy !== 'number') return null;
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
      const list = draft.assemblies ?? [];
      const asm = list.find((a) => a.id === id);
      if (!asm) return null;
      const moves = asm.memberIds
        .map((cabId) => draft.cabinets.find((c) => c.id === cabId))
        .filter((c): c is Cabinet => Boolean(c))
        .map((c) => ({
          cabinetId: c.id,
          from: { x: c.placement.x, y: c.placement.y },
          to: { x: Math.round(c.placement.x + dx), y: Math.round(c.placement.y + dy) },
        }));
      if (moves.length === 0) return null;
      return {
        sideEffects: [{ kind: 'moveAssembly', assemblyId: id, moves }],
        diff: [{ path: `(assembly.move) ${asm.name}`, from: null, to: `Δ${Math.round(dx)},${Math.round(dy)}mm` }],
      };
    }

    if (cmd.op === 'assembly.rename') {
      const id = p.assemblyId;
      const name = p.name;
      if (!id || typeof name !== 'string' || name.trim() === '') return null;
      const list = draft.assemblies ?? [];
      const i = list.findIndex((a) => a.id === id);
      if (i < 0) return null;
      const prev = structuredClone(list[i]!);
      const next = structuredClone(prev);
      next.name = name;
      return {
        sideEffects: [{ kind: 'patchAssembly', assemblyId: id, prev, next }],
        diff: [{ path: `assemblies[${i}].name`, from: prev.name, to: next.name }],
      };
    }

    if (cmd.op === 'room.create') {
      const room = structuredClone(p.room!);
      if (!room.id) room.id = nextId('room', draft.rooms.map((r) => r.id));
      if (draft.rooms.some((r) => r.id === room.id)) return null;
      const index = draft.rooms.length;
      return {
        sideEffects: [{ kind: 'insertRoom', room, index }],
        diff: [{ path: '(room.create)', from: null, to: `${room.id} ${room.name}` }],
      };
    }

    if (cmd.op === 'room.delete') {
      const rid = p.roomId;
      if (!rid) return null;
      const i = findRoom(draft, rid);
      if (i < 0) return null;
      const room = structuredClone(draft.rooms[i]);
      return {
        sideEffects: [{ kind: 'removeRoom', room, index: i }],
        diff: [{ path: '(room.delete)', from: `${room.name}`, to: null }],
      };
    }

    if (cmd.op === 'room.resize') {
      const rid = p.roomId;
      const w = p.w;
      const h = p.h;
      if (!rid || typeof w !== 'number' || typeof h !== 'number' || w <= 0 || h <= 0) return null;
      const room = draft.rooms.find((r) => r.id === rid);
      if (!room || room.walls.length === 0) return null;
      // 房间尺寸来自四面墙端点，先取包围盒原点与边长
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const wll of room.walls) {
        for (const pt of [wll.start, wll.end]) {
          if (pt.x < minX) minX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y > maxY) maxY = pt.y;
        }
      }
      const oldW = maxX - minX;
      const oldH = maxY - minY;
      if (!(oldW > 0) || !(oldH > 0)) return null; // 退化的房间（墙共线）没法缩放
      const sx = w / oldW;
      const sy = h / oldH;
      const scale = (pt: Vec2): Vec2 => ({ x: minX + (pt.x - minX) * sx, y: minY + (pt.y - minY) * sy });
      const walls = room.walls.map((wll) => ({
        id: wll.id,
        start: scale(wll.start),
        end: scale(wll.end),
        prevStart: { x: wll.start.x, y: wll.start.y },
        prevEnd: { x: wll.end.x, y: wll.end.y },
      }));
      return {
        sideEffects: [{ kind: 'resizeRoom', roomId: rid, walls }],
        diff: [{ path: `rooms[${rid}]`, from: `${Math.round(oldW)}×${Math.round(oldH)}`, to: `${Math.round(w)}×${Math.round(h)}` }],
      };
    }

    if (cmd.op === 'wall.create') {
      const wall = structuredClone(p.wall!);
      const sideEffects: SideEffect[] = [];
      let room = p.roomId ? draft.rooms.find((r) => r.id === p.roomId) : draft.rooms[0];

      // 一个房间都没有时，画墙自动创建一个容器房间。
      // 两件事必须包在一条命令里 —— 否则撤销会留下一个空房间。
      if (!room) {
        const auto = createRoom({ name: '房间1', takenIds: draft.rooms.map((r) => r.id) });
        const roomIndex = draft.rooms.length;
        sideEffects.push({ kind: 'insertRoom', room: auto, index: roomIndex });
        draft.rooms.push(structuredClone(auto));
        room = draft.rooms[roomIndex];
      }

      if (!wall.id) wall.id = nextId('wall', room.walls.map((w) => w.id));
      if (room.walls.some((w) => w.id === wall.id)) return null;
      const index = room.walls.length;
      sideEffects.push({ kind: 'insertWall', roomId: room.id, wall, index });
      return {
        sideEffects,
        diff: [{ path: `rooms[${room.id}].walls[${index}]`, from: null, to: `${wall.id} ${wall.name}` }],
      };
    }

    if (cmd.op === 'wall.delete') {
      const id = cmd.target?.id;
      if (!id) return null;
      for (const room of draft.rooms) {
        const index = room.walls.findIndex((w) => w.id === id);
        if (index < 0) continue;
        const wall = structuredClone(room.walls[index]);
        return {
          sideEffects: [{ kind: 'removeWall', roomId: room.id, wall, index }],
          diff: [{ path: `rooms[${room.id}].walls[${index}]`, from: `${wall.id} ${wall.name}`, to: null }],
        };
      }
      return null;
    }

    // ── 门窗洞口（P8.7）：与墙同构的结构性三操作 ──
    if (cmd.op === 'opening.create') {
      const wall = cmd.payload?.wallId ? findWallById(draft, cmd.payload.wallId) : undefined;
      const opening = cmd.payload?.opening ? structuredClone(cmd.payload.opening) : null;
      if (!wall || !opening) return null;
      const room = draft.rooms.find((r) => r.walls.some((w) => w.id === wall.id));
      if (!room) return null;
      wall.openings ??= [];
      if (!opening.id) opening.id = nextId('open', wall.openings.map((o) => o.id));
      if (wall.openings.some((o) => o.id === opening.id)) return null;
      const index = wall.openings.length;
      return {
        sideEffects: [{ kind: 'insertOpening', roomId: room.id, wallId: wall.id, opening, index }],
        diff: [{ path: `rooms[${room.id}].walls[${wall.id}].openings[${index}]`, from: null, to: `${opening.id} ${opening.kind}@${opening.offset}+${opening.width}` }],
      };
    }

    if (cmd.op === 'opening.delete') {
      const openingId = cmd.payload?.openingId;
      if (!openingId) return null;
      for (const room of draft.rooms) {
        for (const wall of room.walls) {
          const list = wall.openings;
          if (!list) continue;
          const index = list.findIndex((o) => o.id === openingId);
          if (index < 0) continue;
          const opening = structuredClone(list[index]);
          return {
            sideEffects: [{ kind: 'removeOpening', roomId: room.id, wallId: wall.id, opening, index }],
            diff: [{ path: `rooms[${room.id}].walls[${wall.id}].openings[${index}]`, from: `${opening.id} ${opening.kind}`, to: null }],
          };
        }
      }
      return null;
    }

    if (cmd.op === 'opening.update') {
      const openingId = cmd.payload?.openingId;
      const patch = cmd.payload?.openingPatch;
      if (!openingId || !patch) return null;
      for (const room of draft.rooms) {
        for (const wall of room.walls) {
          const o = wall.openings?.find((x) => x.id === openingId);
          if (!o) continue;
          const prev: OpeningAuthored = {
            offset: o.offset,
            width: o.width,
            ...(o.name !== undefined ? { name: o.name } : {}),
            ...(o.hinge !== undefined ? { hinge: o.hinge } : {}),
            ...(o.swingDirection !== undefined ? { swingDirection: o.swingDirection } : {}),
          };
          // 三态补丁：undefined = 不改 / null = 清成"未指定" / 值 = 设成它
          const pick = <T>(next: T | null | undefined, cur: T | undefined): T | undefined =>
            next === undefined ? cur : next === null ? undefined : next;
          const nextName = pick(patch.name, prev.name);
          const nextHinge = pick(patch.hinge, prev.hinge);
          const nextDir = pick(patch.swingDirection, prev.swingDirection);
          const next: OpeningAuthored = {
            offset: patch.offset !== undefined ? Math.round(patch.offset) : prev.offset,
            width: patch.width !== undefined ? Math.round(patch.width) : prev.width,
            ...(nextName !== undefined ? { name: nextName } : {}),
            ...(nextHinge !== undefined ? { hinge: nextHinge } : {}),
            ...(nextDir !== undefined ? { swingDirection: nextDir } : {}),
          };
          return {
            sideEffects: [{ kind: 'updateOpening', roomId: room.id, wallId: wall.id, openingId, prev, next }],
            diff: [
              ...(next.offset !== prev.offset ? [{ path: `openings[${openingId}].offset`, from: prev.offset, to: next.offset }] : []),
              ...(next.width !== prev.width ? [{ path: `openings[${openingId}].width`, from: prev.width, to: next.width }] : []),
              ...(next.name !== prev.name ? [{ path: `openings[${openingId}].name`, from: prev.name ?? null, to: next.name ?? null }] : []),
              ...(next.hinge !== prev.hinge ? [{ path: `openings[${openingId}].hinge`, from: prev.hinge ?? null, to: next.hinge ?? null }] : []),
              ...(next.swingDirection !== prev.swingDirection
                ? [{ path: `openings[${openingId}].swingDirection`, from: prev.swingDirection ?? null, to: next.swingDirection ?? null }]
                : []),
            ],
          };
        }
      }
      return null;
    }

    return null;
  }

  private findWall(project: Project, wallId: string): unknown {
    for (const r of project.rooms) {
      const w = r.walls.find((x) => x.id === wallId);
      if (w) return w;
    }
    return undefined;
  }

  // ───────────────────────────── Undo / Redo ─────────────────────────────

  undo(): boolean {
    if (!this.canUndo()) return false;
    const e = this.entries[this.pointer];
    this.revert(e, false);
    e.applied = false;
    this.pointer--;
    this.modelVersion++;
    this.geomCache = null;
    this.recomputeProvenance();
    this.notify();
    return true;
  }

  redo(): boolean {
    if (!this.canRedo()) return false;
    const e = this.entries[this.pointer + 1];
    this.revert(e, true);
    e.applied = true;
    this.pointer++;
    this.modelVersion++;
    this.geomCache = null;
    this.recomputeProvenance();
    this.notify();
    return true;
  }

  /** forward=true 重做，false 撤销。路径编辑与结构性变更统一在这里处理。 */
  private revert(e: LogEntry, forward: boolean): void {
    if (e.sideEffects && e.sideEffects.length > 0) {
      // 整项目替换换掉的是对象引用，不能走逐字段回退 —— 单独处理（replace 永远是单条）
      if (e.sideEffects.length === 1 && e.sideEffects[0].kind === 'replaceProject') {
        const se = e.sideEffects[0];
        this.project = structuredClone(forward ? se.next : se.prev);
        // P8.5-B：provenance 与模型原子同步 —— 两侧快照都带 provenance，
        // 恢复哪个方向就从哪个方向重新种子化，再把字段从内存模型剥掉。
        this.provById.clear();
        this.baselineProv.clear();
        this.seedProvenanceFromProject(this.project);
        this.stripProvenanceFields(this.project);
        return;
      }
      applySideEffects(this.project, e.sideEffects, forward);
      return;
    }
    const root: any =
      !e.command.target || e.command.target.kind === 'project'
        ? this.project
        : e.command.target.kind === 'cabinet'
          ? this.project.cabinets.find((c) => c.id === e.command.target!.id)
          : this.findWall(this.project, e.command.target.id);
    if (root === undefined) return;
    if (forward) {
      for (const d of e.diff) {
        try {
          setByPath(root, d.path, d.to);
        } catch {
          /* 目标结构已变（例如分区被删），跳过；整体状态仍一致，因为后续条目会各自回退 */
        }
      }
    } else {
      for (const inv of e.inverse) {
        try {
          setByPath(root, inv.path, inv.value);
        } catch {
          /* 同上 */
        }
      }
    }
  }

  /** 跳到某个历史点（撤销到指定 seq 之后 / 重做到指定 seq） */
  jumpTo(seq: number): void {
    const targetSeq = this.entries.findIndex((e) => e.seq === seq);
    if (targetSeq < 0) return;
    while (this.pointer > targetSeq) if (!this.undo()) break;
    while (this.pointer < targetSeq) if (!this.redo()) break;
  }

  /**
   * 落位 provenance 的 live 存储种子化（P8.5-B 加载路径）。
   * 把每柜文件里的 `placementProvenance`（落盘 live 形态）转成会话态 PlacementProvenance，
   * 作为本会话的基线（baselineProv）与初始 live（provById）：后续 execute/undo/redo
   * 会用 activeLog 里的真实记录覆盖 live，撤销后回到基线。
   */
  private seedProvenanceFromProject(project: Project): void {
    for (const cab of project.cabinets) {
      const pp = cab.placementProvenance;
      if (!pp) continue;
      const p: PlacementProvenance = {
        targetId: cab.id,
        intent: pp.intent,
        authority: pp.authority,
        byOp: pp.byOp,
        atVersion: pp.atVersion,
        status: 'live',
      };
      this.baselineProv.set(cab.id, p);
      this.provById.set(cab.id, p);
    }
  }

  /**
   * 把内存模型里的 placementProvenance 字段剥掉（P8.5-B）。
   * provenance 只住总线（provById/baselineProv），模型里永远干净——
   * 这是「预览 === 提交」「干跑终点 === 提交终点」逐字节不变量的结构保证。
   */
  private stripProvenanceFields(project: Project): void {
    for (const c of project.cabinets) {
      if (c.placementProvenance !== undefined) c.placementProvenance = undefined;
    }
  }

  /**
   * 当前状态的**文件形状**快照（P8.5-B 保存出口）：clone 状态、把每柜当前 live
   * provenance 物化成 `Cabinet.placementProvenance`，再交给调用方序列化。
   *
   * 只物化有 live 的柜（无 live = 无来源 = 不写字段，绝不伪造 undefined 以外的值）；
   * 不写 status / supersededBy（派生态不落盘，加载后由总线重算）。
   */
  toFileSnapshot(): Project {
    const snapshot = structuredClone(this.getState());
    for (const cab of snapshot.cabinets) {
      const live = this.provById.get(cab.id);
      if (live) {
        cab.placementProvenance = {
          intent: live.intent,
          authority: live.authority,
          byOp: live.byOp,
          atVersion: live.atVersion,
        };
      }
    }
    return snapshot;
  }

  /** 读取某柜当前 live provenance（会话内记录优先，否则加载基线）；reload 后也可读 */
  getPlacementProvenance(cabinetId: string): PlacementProvenance | undefined {
    return this.provById.get(cabinetId);
  }

  /**
   * 重算每只柜 provenance 的 live / superseded（P8.5-C1），并同步持久化 live（P8.5-B）。
   *
   * 规则：同一只柜的 provenance 记录里，**最后一条（按提交顺序）为 live，
   * 之前的全为 superseded**（保留为历史来源，不再产生偏好证据）。
   * 这覆盖了 review §E 的全部失效情形：rotate / move / nudge / resize / 手动移回
   * 都会产生一条更新的记录 → 旧记录自动 superseded；重跑同一 intent（cabinet.place）
   * 产生新 live 记录。
   *
   * 为什么集中重算而不是"写新时手动标旧"：撤销/重做会改变 active 集合，集中重算
   * 让 provenance 与模型状态**原子同步**，不存在"模型回去了、provenance 没回去"。
   * activeLog 只含 applied 且未丢弃的条目，所以被撤销的分支自然不参与。
   *
   * P8.5-B：重算后把 live 写进 `provById`（覆盖加载基线），再镜像到 `Cabinet.placementProvenance`。
   * 无会话记录的柜保留加载基线（provById 不动），因此 reload 后不丢、且无记录柜不伪造。
   */
  private recomputeProvenance(): void {
    const active = this.activeLog();
    const byCab = new Map<string, Array<{ entry: LogEntry; prov: PlacementProvenance }>>();
    for (const e of active) {
      const list = e.placementProvenance;
      if (!list) continue;
      const arr = Array.isArray(list) ? list : [list];
      for (const prov of arr) {
        const bucket = byCab.get(prov.targetId) ?? [];
        bucket.push({ entry: e, prov });
        byCab.set(prov.targetId, bucket);
      }
    }
    for (const bucket of byCab.values()) {
      for (let i = 0; i < bucket.length; i++) {
        const prov = bucket[i]!.prov;
        const last = i === bucket.length - 1;
        if (last) {
          prov.status = 'live';
          prov.supersededBy = undefined;
        } else {
          prov.status = 'superseded';
          const next = bucket[i + 1]!.prov;
          prov.supersededBy = { op: next.byOp, atVersion: next.atVersion };
        }
      }
    }
    // P8.5-B：维护持久化 live 存储。先回到加载基线，再用 activeLog 的 live 覆盖——
    // 撤销某条落位命令后，该柜自然回到基线（或基线为空则清空，不残留 stale live）。
    // 注意：这里**只动 provById，不动模型**——provenance 物化到文件形状只在 toFileSnapshot()。
    this.provById = new Map(this.baselineProv);
    for (const bucket of byCab.values()) {
      const live = bucket[bucket.length - 1]!.prov;
      this.provById.set(live.targetId, { ...live, status: 'live', supersededBy: undefined });
    }
  }

  /** 直接替换整个项目（导入 / 打开文件 / 恢复草稿）—— 也走日志，可撤销 */
  replaceProject(next: Project, label: string): void {
    // prev 侧快照带 provenance（物化当前 live）：撤销本次替换时才能原样恢复旧 provenance。
    const prev = this.toFileSnapshot();
    const nextInMemory = structuredClone(next);
    // P8.5-B：整批载入 = provenance 状态整体重置。旧映射先清（旧柜绝不残留），
    // 再按【载入内容】重新种子化——自家格式（项目文件 / 草稿）里带 provenance = 恢复，
    // 外来来源（P4/P5 适配器构造的柜）从不带该字段 = 天然 unknown。两种都诚实：
    // 恢复的是"我们自己持久化过的事实"，unknown 是"确实不知道"，都不伪造。
    this.provById.clear();
    this.baselineProv.clear();
    this.seedProvenanceFromProject(nextInMemory);
    this.stripProvenanceFields(nextInMemory);
    this.project = nextInMemory;
    if (this.pointer + 1 < this.entries.length) this.entries = this.entries.slice(0, this.pointer + 1);
    this.modelVersion++;
    this.geomCache = null;
    this.explodeCache = null;
    this.entries.push({
      seq: this.entries.length + 1,
      at: Date.now(),
      command: { id: `cmd_replace_${Date.now().toString(36)}`, op: 'project.replace', source: 'system', changes: [], label },
      label,
      diff: [{ path: '(project)', from: prev.name, to: next.name }],
      inverse: [],
      // 快照两侧都保留 provenance（next 原样、prev 已物化）：撤销/重做时按原样恢复，
      // provenance 与模型原子同步 —— 与 execute/undo/redo 的总纪律一致。
      sideEffects: [{ kind: 'replaceProject', prev, next: structuredClone(next) }],
      derived: this.sumDerived(this.derive().geom),
      issueDelta: { errors: 0, warnings: 0, added: [] },
      applied: true,
      discarded: false,
    });
    // 会话日志里指向旧模型的 provenance 一并清空（新会话从载入内容起步）。
    for (const e of this.entries) e.placementProvenance = undefined;
    this.pointer = this.entries.length - 1;
    this.notify();
  }

  private deriveFor(p: Project): { geom: ProjectGeometry; issues: Issue[] } {
    const geom = generateProject(p, this.rules);
    const issues: Issue[] = [...geom.issues];
    for (const cab of p.cabinets) {
      const g = geom.cabinets[cab.id];
      if (!g) continue; // 生成器已为它报了 GEN-ERROR，不再继续校验
      issues.push(...validateCabinet(cab, g, this.rules));
    }
    // 跨柜规则（Phase E）：L 型转角处铰链门开门撞邻柜的软建议
    issues.push(...validateCornerInterference(p, this.rules));
    // 组合关系（v0.3，P2）：只校验**声明过**的关系；无组合时返回空数组（v0.2 逐位等价）
    issues.push(...validateAssemblies(p));
    // 空间语义（v0.3，P8.7）：Room/Wall/Opening 的事实层校验。
    // 只报空间层独有问题（房间形状/洞口 span/柜在房间外/柜盖洞口）；
    // 穿墙硬错误仍归 geometry 层 RULE-CABINET-IN-WALL，不重复报。
    issues.push(...deriveSpatial(p).issues);
    return { geom, issues };
  }

  private sumDerived(geom: ProjectGeometry): DerivedSummary {
    let panels = 0;
    let pieces = 0;
    let areaM2 = 0;
    let weightKg = 0;
    for (const g of Object.values(geom.cabinets)) {
      panels += g.stats.panelKinds;
      pieces += g.stats.totalPieces;
      areaM2 += g.stats.boardAreaM2;
      weightKg += g.stats.estWeightKg;
    }
    return { panels, pieces, areaM2: Math.round(areaM2 * 10) / 10, weightKg: Math.round(weightKg * 10) / 10 };
  }
}
