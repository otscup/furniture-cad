/**
 * ══════════════════════════════════════════════════════════════════════
 *  AI Planner —— 纯语义的规划请求 / 规划结果模型（P9.5）
 *
 *  ── Planner 是什么，不是什么（§二）──
 *    是：**理解用户设计目标 + 组织 Design Intent + 决定需要哪些候选搜索**。
 *    不是：Geometry Solver / Placement Resolver / Validator / Score Engine /
 *          Command Executor —— 这些全都**已经有唯一实现**，Planner 只调用它们。
 *
 *      用户需求 → AI Planner → PlannerRequest → 确定性候选生成器 → CandidateLayout[]
 *                                                                    → DesignScore[]
 *
 *  ── 两条类型级红线（本文件存在的意义）──
 *    ① **规划请求里写不出几何**：`PlannerRequest` 混入 `PlannerGeometryForbidden`，
 *       里面全是 `x?: never` 之类 —— 赋一个坐标就**编译不过**。
 *       这不是"运行时拦住"，是"根本表达不出来"（与 P9.2 把 `'system'` 从
 *       `DesignIntentOrigin` 联合里拿掉、P9.3 把 `CandidateStatus` 定成字面量同一手法）。
 *    ② **规划结果里没有"选了谁"**：`PlannerPlan` 只装 request + unresolved +
 *       `CandidateLayout[]` + `EvaluatedCandidate[]` —— **没有** winner / best /
 *       recommended / adopted 字段。选哪份必须由用户拍板（§十）。
 *
 *  ── 运行态，不落盘 ──
 *    与 P9.3 候选 / P9.4 评分同一条纪律：不进 `project.json`、不进 Semantic Model、
 *    不进 Knowledge、不升 `schemaVersion`。它是"这次规划算出来的东西"，刷新即消失。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { CandidateGenerationStats, CandidateLayout } from '../candidateLayout/model.ts';
import type { EvaluatedCandidate } from '../designScore/model.ts';
import type { DesignIntentGoal } from '../designIntent/vocabulary.ts';

/**
 * 规划范围。
 *
 * 与 P9.3 `CandidateRequest.scope` **同口径**（不给 `roomId`）：
 * "哪个房间"由意图 / 柜体的 scope 派生，Planner 不新增一个"直接点房间"的入口 ——
 * 少一个入口就少一处"绕开 scope 解析"的机会。
 */
export type PlannerScope = 'room' | 'project';

/**
 * ══════════════════════════════════════════════════════════════════
 *  ★ 类型层禁止几何（§三）—— 「写不出来」比「能写出来再拦住」彻底一档
 *
 *  为什么用 `?: never` 而不是"什么都不声明"：
 *    · 什么都不声明，`{ x: 100 }` 传进 `PlannerRequest` 只会被 TS 的
 *      "多余属性检查"在**字面量**上拦一下 —— 一旦经过变量中转就悄悄放行；
 *    · `x?: never` 是**声明了一个类型为 never 的可选属性**：任何非 undefined
 *      的赋值都是类型错误，**中转也拦得住**。
 *
 *  这些名字不是"将来要用的字段"，是**明确点名的不许出现**：
 *  坐标 / 旋转 / 多边形 / 点集 / 墙端点 / 包围盒 / 弧半径。
 *  墙只能用**意图 / 语义关系**去说（"希望贴墙"），不能用 `wallId` 点名 ——
 *  那正是 P9.2 拒绝把 `wallId` 放进 `DesignIntentScope` 的同一条理由：
 *  写得出 wallId，"贴哪面墙"就成了这一层能拍板的事，`{x,y,rotation}` 也就不远了。
 * ══════════════════════════════════════════════════════════════════
 */
export interface PlannerGeometryForbidden {
  x?: never;
  y?: never;
  z?: never;
  rotation?: never;
  angle?: never;
  dx?: never;
  dy?: never;
  polygon?: never;
  points?: never;
  pts?: never;
  path?: never;
  placements?: never;
  placement?: never;
  geometry?: never;
  coordinates?: never;
  /** 墙只能通过"希望贴墙"这类**语义目标**去说，不能点名某面墙 */
  wallId?: never;
  wallStart?: never;
  wallEnd?: never;
  wallCoords?: never;
  bbox?: never;
  radius?: never;
  arc?: never;
}

/**
 * ── Phase A 输出：AI 能表达的规划请求（**输入侧**）──
 *
 * 只有四类东西，全是**引用与方向**：
 *   · `scope`            —— 房间视角还是整个项目（枚举）
 *   · `intentIds`        —— 引用**已确认**的设计意图（id）
 *   · `cabinetIds`       —— 引用**已有**柜体（id）
 *   · `generationGoals`  —— 目标方向词（9 词闭集），决定"该枚举什么"
 *   · `maxCandidates`    —— 每个目标最多几条候选（夹取，不静默给 0）
 *
 * **没有 `unresolved`**：AI 不许自己声明"哪些解决不了"——那等于让模型编造系统状态。
 * 它由系统填在 `PlannerPlan.unresolved`（见 §1.11 的有意偏离）。
 */
export interface PlannerRequest extends PlannerGeometryForbidden {
  scope: PlannerScope;
  /** 想按哪几条意图规划（**active** 意图 id）；缺省 = 全部 active 意图 */
  intentIds?: string[];
  /** 只规划这几只柜（可选；缺省 = 意图 scope 指向的柜） */
  cabinetIds?: string[];
  /** 目标方向词（9 词闭集）。缺省 = 由 `intentIds` 指向的意图自己决定 */
  generationGoals?: DesignIntentGoal[];
  /**
   * 最多要几条候选（缺省 = 由生成器按路径政策定；非法 = 回落默认）。
   *
   * P9.8 §四：归一化时按**两条路径里较宽的**那条夹到 `MAX_CANDIDATES_COORDINATED`
   * （单柜路径随后仍按每只柜 `MAX_CANDIDATES_PER_TARGET` 档再夹一次，并如实记账）——
   * 不再让多柜协调的新搜索空间被旧的 `<=3` 在上游卡死。
   */
  maxCandidates?: number;
}

/** 请求里允许出现的键（唯一权威在 `shared/aiContract.mjs`；这里复述一份供本层与验收自检） */
export const PLANNER_REQUEST_KEYS = ['scope', 'intentIds', 'cabinetIds', 'generationGoals', 'maxCandidates'] as const;

/**
 * 规划规模上限 —— **硬拒，不裁剪**。
 *
 * 为什么必须有：`candidateRequest` 只限"每个目标几条候选"，**不限一次覆盖多少只柜**；
 * 一次规划覆盖 200 只柜在形状上完全合法，而枚举成本与给模型看的上下文都会失控。
 *
 * 为什么超限是**整份拒绝**而不是"悄悄砍到上限"：
 *   砍掉柜子 = 用户以为整屋都规划了，实际只处理了前 24 只 —— 静默丢柜是最坏的一种
 *   （与 `MAX_ACTIONS` 的处理同一口径：宁可明确说不，不许悄悄少做）。
 *
 * 数值与 `shared/aiContract.mjs` 的 `PLANNER_LIMITS` 必须逐字一致，由 `verify:ai-planner` 断言。
 */
export const MAX_PLANNER_CABINETS = 24;
export const MAX_PLANNER_INTENTS = 12;
export const MAX_PLANNER_GOALS = 9;

/** 一件"没被解决的事" —— 如实说，不假装（生成器产不出候选 / 引用不存在 / 本层不支持的组合） */
export interface PlannerUnresolved {
  intentId?: string;
  cabinetId?: string;
  goal?: DesignIntentGoal;
  reason: string;
}

/**
 * ── Phase B 输出：系统产出的规划结果（**输出侧**）──
 *
 * 四样东西，缺一不可：
 *   · `request`      —— 归一化后的请求（回显"系统到底按什么规划的"）
 *   · `unresolved`   —— 系统**算出来**的"哪些没解决"（AI 不许声明，见 §1.11）
 *   · `candidates`   —— P9.3 确定性生成器产出（**零第二份枚举**）
 *   · `scores`       —— P9.4 确定性评分（**零第二份判定**）
 *   · `explanations` —— 人话：这次规划做了什么、哪些没做
 *
 * **没有** `winner`：本层收到多个候选时只解释"各份满足了什么 / 什么还没满足"（§十），
 * 绝不给出"推荐哪一份"。
 */
export interface PlannerPlan {
  request: PlannerRequest;
  unresolved: PlannerUnresolved[];
  candidates: CandidateLayout[];
  scores: EvaluatedCandidate[];
  explanations: string[];
  /**
   * 多柜协调枚举统计（P9.7，运行态透传自 CandidateLayoutSet.generation）。
   * undefined = 本轮没有启用协调枚举（意图只作用到单柜）。
   */
  generation?: CandidateGenerationStats;
}

/**
 * 归一化结果：要么给出可执行的请求，要么明确报错（**不静默降级**）。
 * `unresolved` 在 `ok:true` 时表达"请求合法，但里面有些引用用不上"。
 */
export type PlannerRequestResult =
  | { ok: true; request: PlannerRequest; unresolved: PlannerUnresolved[] }
  | { ok: false; error: string; unresolved: PlannerUnresolved[] };

/** 规划结果：要么有 `plan`，要么有明确 `error`（两者不会同时缺） */
export type PlannerRunResult =
  | { ok: true; plan: PlannerPlan }
  | { ok: false; error: string; unresolved: PlannerUnresolved[] };
