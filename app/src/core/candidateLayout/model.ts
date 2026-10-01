/**
 * ══════════════════════════════════════════════════════════════════════
 *  候选布局（CandidateLayout）—— 纯临时对象模型（P9.3）
 *
 *  ── 它是什么 ──
 *    "如果这样摆，会得到什么结果"：一组**已有柜体**的另一种落位方案，
 *    连同它带来的冲突、以及它对设计意图的满足情况。
 *    它是给人**看**的，不是给系统**执行**的。
 *
 *  ── 它不是什么（本阶段四条红线，缺一条就退化成本项目一直在防的那个东西）──
 *    ① 不是 Project：不进 `project.json`、不随项目存盘、不着 `schemaVersion`；
 *    ② 不是 Cabinet：候选落位**不创建也不修改任何柜体**，只描述"某只已有柜摆到某处"；
 *    ③ 不是 File schema：它只活在本会话内存里（`draft`），刷新即消失
 *       —— 与 `VariantDraft` 同一条纪律；
 *    ④ 不是第二真相源：坐标**永远**由 `resolvePlacement`（全项目唯一的落位出口）算，
 *       候选只**携带** resolver 的输出，绝不自己算 x/y。
 *
 *  ── 为什么它必须只活内存（P8.5-B 的教训直接搬过来）──
 *    坐标一旦落盘，下次打开就分不清"用户摆的"和"系统猜的"；
 *    `preview === commit`、`dryRun === commit` 两条逐字节不变量会当场破。
 *    所以候选**只存在于生成函数返回的那个临时对象里**。
 *    要真正生效只能走未来的 adopt 通道 —— 本阶段**没有**这个通道
 *    （见 index.ts 的导出面：没有 adopt / apply / commit 任何名字）。
 *
 *  ── `CandidateStatus` 在类型层就只有两个值中更少的那个 ──
 *    生命周期是 draft → evaluated（P9.4）→ adopted（未来）。
 *    本阶段把它定成字面量 `'draft'`：**写不出** `'evaluated'` / `'adopted'`，
 *    比"能写出来再靠校验拦住"彻底一档（与 P9.2 把 `'system'` 从 origin 里
 *    拿掉是同一手法）。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Issue, Project } from '../types.ts';
import { nextId } from '../ids.ts';
import type { PlacementIntent, ResolvedPlacement } from '../placement.ts';
import type { DesignIntentGoal } from '../designIntent/vocabulary.ts';

/** 候选生命周期 —— 本阶段**只有** draft（类型层没有 evaluated / adopted） */
export type CandidateStatus = 'draft';

/**
 * AI 可以输出的候选请求（唯一允许的候选入口）。
 *
 * ── 只有**引用**，没有任何坐标 ──
 *    `intentIds` / `cabinetIds` 都是 **id**，`scope` 是枚举 ——
 *    里面没有任何 x / y / rotation。AI 想"直接说坐标"在类型上就写不出来；
 *    真正的落位由确定性枚举（`generateCandidateLayouts`）完成。
 *
 * ── 与 `shared/aiContract.mjs` 的 `validateCandidateRequest` 同源 ──
 *    这里的字段名就是那份契约里 `CANDIDATE_REQUEST_KEYS` 的同一串
 *    （`intentIds` / `cabinetIds` / `scope` / `maxCandidates`），
 *    由 `verify:candidate-layout` 断言两边逐字一致，不允许漂移。
 */
export interface CandidateRequest {
  /** 想比较哪几条意图下的候选（**active** 意图 id）；缺省 / 空 = 全部 active 意图 */
  intentIds?: string[];
  /** 只对这几只柜做候选（可选；缺省 = 意图 scope 指向的柜） */
  cabinetIds?: string[];
  /** 范围：room = 房间视角，project = 整个项目 */
  scope: 'room' | 'project';
  /** 每个目标柜最多几个候选（缺省 = MAX_CANDIDATES_PER_TARGET，超过也夹到该值） */
  maxCandidates?: number;
}

/** 请求里允许出现的键（唯一权威在 shared/aiContract.mjs；这里复述一份供本层与验收自检） */
export const CANDIDATE_REQUEST_KEYS = ['intentIds', 'cabinetIds', 'scope', 'maxCandidates'] as const;

/** 每个目标柜最多产出几个候选（A / B / C 三档） */
export const MAX_CANDIDATES_PER_TARGET = 3;

/** 一条候选落位对某条意图的满足情况（**事实层判定**的结果，不是这里算的） */
export interface CandidateSatisfies {
  goal: DesignIntentGoal;
  ok: boolean;
}

/**
 * 一条候选落位：**引用**某只已有柜体 + 它"如果摆到哪"。
 *
 * ── 为什么不是 `{ cabinet: Cabinet }`（VariantDraft 的形状）──
 *    `VariantDraft` 的候选是一只**新柜**，所以它必须带一整个 `Cabinet`；
 *    本层的候选是"某只**已有**柜体换个摆法"—— 带 `Cabinet` 就等于
 *    这只柜变成了候选的一部分（候选里长出了 Cabinet），越界。
 *    所以这里只有 `targetId`（引用）+ 一份**语义落位意图** + resolver 的输出。
 *
 * ── `intent` 为什么是 `absolute` ──
 *    落位候选来自 `candidateSpots`（确定性贴墙枚举器），它给的就是一个
 *    具体坐标；而 `PlacementIntent` 里唯一能承载"具体坐标"的分支是
 *    `absolute`（且必须 `origin:'authored'`）。这里的 `authored` 只表示
 *    "这是候选沙盒里一个确定的坐标提案"，**不代表用户对真实模型做过授权** ——
 *    真实模型里没有任何 authored 被写入（候选根本不碰模型）。
 */
export interface CandidatePlacement {
  /** 要重摆的柜体 id（**引用** `project.cabinets`，不是 Cabinet 本体） */
  targetId: string;
  /** 语义落位意图（不是坐标 —— 坐标由 `resolvePlacement` 算） */
  intent: PlacementIntent;
  /** resolver 的输出（整数 mm；全项目唯一的坐标出口） */
  resolved: ResolvedPlacement;
  /** 在"把该柜按 resolved 摆好"的项目**副本**上派生的冲突（复用 `detectCollisions`，零第二份判定） */
  issues: Issue[];
  /** 对每条 `sourceIntent` 的满足情况（复用事实层，零第二份判定） */
  satisfies: CandidateSatisfies[];
}

/** 一件"没被解决的事"（意图构造不出候选 / 某候选没满足某意图）—— 如实说，不假装 */
export interface CandidateUnresolved {
  intentId?: string;
  cabinetId?: string;
  reason: string;
}

/**
 * 一份候选布局：`{id, sourceIntent[], placements[], explanations[], unresolved[]}`。
 *
 * 它描述"如果把这几只柜按 `placements` 这样摆，会得到什么结果"，
 * **绝不替代真实 placement** —— 真实 placement 仍然只在 `Cabinet.placement` 里。
 *
 * P9.7 起 `placements` 允许多项：一份候选可以同时重摆多只柜
 * （整墙链 / L 型拼接的**整体**候选）—— 多柜候选仍然只持 `targetId` 引用，
 * 每条落位仍各自过 Resolver，整体验证/评分在克隆副本上做。
 * 禁止 `cabinets: Cabinet[]`（候选里长出 Cabinet 本体 = VariantDraft 的语义越界）。
 */
export interface CandidateLayout {
  id: string;
  status: CandidateStatus;
  /** 驱动本候选的意图 id（引用 active 意图） */
  sourceIntent: string[];
  /** 候选落位（每只被重摆的柜一条；P9.7 起允许多柜整体候选） */
  placements: CandidatePlacement[];
  /** 人话说明（为什么生成它、试了什么策略、算了什么数） */
  explanations: string[];
  /** 本候选**没解决**的事（例如"这条候选没满足某意图"） */
  unresolved: CandidateUnresolved[];
}

/**
 * 本轮候选生成统计（P9.7 §十一 —— 运行态，绝不进 project.json）。
 *
 * `maxCandidates` 是**运行态计算限制**：生成空间本身受控（确定性有限枚举），
 * 达到上限时 `generationLimited = true` 并给出 truncated 数 —— 绝不静默 slice。
 */
export interface CandidateGenerationStats {
  /** 本次运行允许返回的候选上限（= 夹取后的 maxCandidates） */
  requested: number;
  /** 枚举产出的**有效**（解析成功 + 零冲突 + 去重后）协调候选数 */
  generated: number;
  /** 实际返回的候选数（≤ requested） */
  returned: number;
  /** generated - returned（有明确原因的丢弃数，不是静默截断） */
  truncated: number;
  /** truncated > 0 —— 明确告诉调用方"枚举空间被上限截断了" */
  generationLimited: boolean;
}

/** 一次候选生成的结果集（生成期就产不出候选的意图逐条记在 `unresolved`） */
export interface CandidateLayoutSet {
  status: CandidateStatus;
  candidates: CandidateLayout[];
  /** 生成期就产不出候选的意图 / 请求（未生效 / 取舍方向 / 没有可作用的柜 / 放不下） */
  unresolved: CandidateUnresolved[];
  /**
   * 多柜协调枚举（P9.7）的生成统计；单柜路径不填（undefined = 本轮未启用协调枚举）。
   * 运行态字段 —— CandidateLayoutSet 整体不落盘，这里加字段不触碰 schemaVersion。
   */
  generation?: CandidateGenerationStats;
}

/** 候选 id：确定性、可读（与 `di_001` / `cab_001` 同一套；**必须传 takenIds**） */
export function candidateLayoutId(taken: Iterable<string>): string {
  return nextId('cl', taken);
}

/** 候选落位的人话（界面 / 报告共用；不在别处再拼一遍） */
export function candidatePlacementZh(p: CandidatePlacement, project?: Project): string {
  const cab = project?.cabinets.find((c) => c.id === p.targetId);
  return `${cab?.name ?? p.targetId} → (${p.resolved.x}, ${p.resolved.y}) @ ${p.resolved.rotation}°`;
}
