import type { PlacementFace } from '../placement.ts';
import type { DesignAlternative, DesignPlacementFinding, DesignPlacementReport } from '../placementDesign.ts';
import type { CabRoomRelation, CabWallRelation, SpatialReport } from '../spatial/index.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  Unified Design Validation —— 统一的设计验证报告模型（v0.3，P8.8）
 *
 *  ── 它是什么 ──
 *    一条链，回答四个问题：
 *      柜子为什么在这里？   （placement 层：意图 + provenance，见 P8.5）
 *      这个位置合法吗？     （placement 层：Resolver 的能不能放，P8.1/P8.2）
 *      这样放合理吗？       （placement 层：设计语义，P8.3）
 *      违反空间事实了吗？   （spatial 层：Room/Wall/Opening，P8.7）
 *
 *  ── 它不是什么（本阶段红线）──
 *    不是自动布局，不是自动修复。本层**只判断、只描述、只组合**：
 *      · 不改 Semantic Model，不改 placement，不动几何；
 *      · 不调 AI，不出 DXF / BOM，不进主规则链（不进 CommandBus.deriveFor）；
 *      · 不重新实现任何既有判定 —— placement/柜间语义只来自 P8.3，
 *        空间事实只来自 P8.7，本层的"新判断"只有一类：
 *        **把已有事实翻译成人看得懂的设计语义**（哪一面靠墙 / 门脸是否朝墙 /
 *        门前空间够不够 / 声明的贴墙与事实是否一致）。
 *
 *  ── 为什么单独立一层而不是塞进 placementDesign ──
 *    P8.3 与 P8.7 各有各的真相源与纪律。把空间判断塞进 placementDesign，
 *    就会出现"柜间语义需要墙坐标、墙坐标需要房间、房间又需要柜"的循环依赖，
 *    而且两边的红线会互相污染（P8.3 只提示不拦截；P8.7 只报事实）。
 *    组合层站在两者之上：**只读它们的输出**，一个都不改。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 统一报告的状态：error 压过 warning，warning 压过 valid（与 P8.3 口径一致） */
export type DesignValidationStatus = 'valid' | 'warning' | 'error';

/** 结论来自哪一层 —— 界面/审计靠它把话追回到实现 */
export type DesignValidationLayer = 'placement' | 'spatial' | 'semantic';

/**
 * 设计语义层的阈值（mm）。
 *
 * ⚠ 与 SPATIAL_TOL 的分工（不许互相搬家）：
 *   · SPATIAL_TOL（P8.7）= **空间事实**的判定阈值（多近算贴着 / 洞口影响带多深），
 *     它决定 touching / near / overlap 这些**事实**；
 *   · DESIGN_TOL（本层）= **设计语义建议**的阈值，只影响提示，不影响任何事实判定。
 *   空间阈值一律从 spatial 层 import，绝不在这里重写一份（否则"贴不贴着"会有两套口径）。
 */
export const DESIGN_TOL = {
  /**
   * 门前/窗前通行余量：柜体离"洞口影响带"多近算"挡着门口"。
   * 影响带本身（墙厚 + 室内侧 600mm 过道）已是 P8.7 的事实；这里再往外 600mm
   * 是"人还得走过来"的余量 —— 只产提示，不产事实、不改判定。
   */
  APPROACH: 600,
} as const;

/**
 * 柜体 ↔ 墙的**设计语义**（P8.8 新增的解释层；不是事实层）。
 *
 * 事实层（P8.7）只有四个值：touching / near / crossing / none。
 * 这里说的是"这个事实在设计上意味着什么"：
 *   back-wall-contact  背面贴墙（最常用的靠墙摆放）
 *   side-wall-contact  侧面顶墙（柜子夹在两面墙之间）
 *   front-wall-contact 门脸朝墙（门基本开不了 —— 提示）
 *   wall-near          离墙有缝（既没贴上也还在墙边 —— 提示）
 *   wall-conflict      与墙体重叠（穿墙，硬错）
 *   floating           房间里没靠任何一面墙（提示）
 */
export type WallContactKind =
  | 'back-wall-contact'
  | 'side-wall-contact'
  | 'front-wall-contact'
  | 'wall-near'
  | 'wall-conflict'
  | 'floating';

/** 中文标签（界面与提示共用一处；与 openingName 同套路：词汇表的人话出口只有一个） */
export const WALL_CONTACT_ZH: Record<WallContactKind, string> = {
  'back-wall-contact': '背面贴墙',
  'side-wall-contact': '侧面顶墙',
  'front-wall-contact': '门脸朝墙',
  'wall-near': '离墙有缝',
  'wall-conflict': '穿进墙里',
  floating: '没靠墙',
};

export const wallContactZh = (k: WallContactKind): string => WALL_CONTACT_ZH[k];

/** 一条柜↔墙的设计语义事实（只读派生；**绝不写回 Cabinet**） */
export interface WallContactFact {
  cabId: string;
  kind: WallContactKind;
  /** floating 时没有具体墙 */
  wallId?: string;
  wallName?: string;
  /** 贴合的那一面柜体面（back/side/front 三类才有；用 P2 的面词汇，不另造一套） */
  face?: PlacementFace;
  /** 事实层的分类（来自 P8.7 facts，原样透传，不在本层重判） */
  relation: CabWallRelation | 'none';
  /** 间距 mm（P8.7 facts 给的值，原样透传） */
  gap?: number;
  /**
   * 面判定是否走了"最近面"回退（柜体斜向旋转时，法线对不上墙法线）。
   * true = 位置与贴合是确定的，但"是哪个面"是按最近面推的，请按注释口径理解。
   */
  rotated?: boolean;
}

/**
 * 统一结论条目。字段刻意与 P8.3 的 DesignPlacementFinding 对齐（多一个 layer），
 * 这样界面可以把两层的结论摆在一起而不必写两套渲染。
 */
export interface DesignValidationFinding {
  layer: DesignValidationLayer;
  status: 'warning' | 'error';
  code: string;
  /** 文案来自 issueCatalog（唯一真相源），本层与各下层都不自己拼 */
  message: string;
  hint?: string;
  manual?: string;
  cabId?: string;
  neighborId?: string;
  assemblyId?: string;
  wallId?: string;
  openingId?: string;
  /** 透传下层时填原始码（便于追责到 P8.3 / P8.7 的实现） */
  sourceCode?: string;
  /** P8.3 的候选朝向：列出 ≠ 推荐（本层同样不替用户选） */
  alternatives?: DesignAlternative[];
  ambiguous?: boolean;
}

/** 单只柜体的设计视图（界面「空间检查」区直接消费） */
export interface CabinetDesignView {
  cabId: string;
  cabName: string;
  roomId: string;
  roomName: string;
  /** 柜 ↔ 房间（P8.7 事实，原样透传；unknown = 边界不成回路，判不出就说判不出） */
  room: CabRoomRelation;
  contacts: WallContactFact[];
  /** 与这只柜相关的全部结论（含 placement 层） */
  findings: DesignValidationFinding[];
}

export interface DesignValidationReport {
  status: DesignValidationStatus;
  /** P8.3 的输出，**原样**透传（同源证据：见验收 §2） */
  placement: DesignPlacementReport;
  /** P8.7 的输出，**原样**透传（同源证据：见验收 §3） */
  spatial: SpatialReport;
  /** 统一结论：placement + spatial + 设计语义解释，三层各自的码都保留 */
  findings: DesignValidationFinding[];
  counts: { error: number; warning: number };
  /** 柜 ↔ 墙的设计语义（结构化事实，界面画 ✓ 用） */
  wallContacts: WallContactFact[];
  cabinets: CabinetDesignView[];
}

/** 把 P8.3 的结论折叠成统一条目（不改文案、不改状态，只补 layer/sourceCode） */
export function fromPlacementFinding(f: DesignPlacementFinding): DesignValidationFinding {
  return {
    layer: 'placement',
    status: f.status === 'error' ? 'error' : 'warning',
    code: f.code,
    message: f.message,
    ...(f.hint !== undefined ? { hint: f.hint } : {}),
    ...(f.cabinetId !== undefined ? { cabId: f.cabinetId } : {}),
    ...(f.neighborId !== undefined ? { neighborId: f.neighborId } : {}),
    ...(f.assemblyId !== undefined ? { assemblyId: f.assemblyId } : {}),
    ...(f.sourceCode !== undefined ? { sourceCode: f.sourceCode } : {}),
    ...(f.alternatives !== undefined ? { alternatives: f.alternatives } : {}),
    ...(f.ambiguous !== undefined ? { ambiguous: f.ambiguous } : {}),
  };
}
