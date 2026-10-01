/**
 * ══════════════════════════════════════════════════════════════════════
 *  规划上下文（P9.5，§五）—— Planner 的**只读**输入 = 三块已有上下文的组合
 *
 *  ① `spatial`       —— P9.1：**世界是什么**（派生事实：墙多长、门往哪开、柜贴哪面墙）
 *  ② `designIntent`  —— P9.2：**人想要什么**（authored 目标：这个厨房要优先储物）
 *  ③ `candidateScore`—— P9.4：**系统算出来什么**（候选的确定性评分结论）
 *
 *  ── 为什么是「视图」而不是第四个快照键 ──
 *    这三块已经在快照里各占一个顶层键（形状稳定、每轮逐字节一致）。
 *    若再并一块把它们装进去，会把同样的字节发两遍，并制造**第二处读法** ——
 *    哪天有人只改了一边，模型看到的"空间事实"就有两个版本。
 *    所以本函数**只做引用**：把快照上已有的三个键挑出来，套一层说明。
 *    它**零新增计算、零新增判定、零坐标**；`verify:ai-planner` 有一条断言钉死
 *    "`buildPlannerContext(snapshot)` 的三块与快照的那三个键**逐字节相同**"，
 *    防止它将来偷偷长出自己的判断。
 *
 *  ── 三条纪律（与 §十二 一致）──
 *    ① 只读：`readOnly: true`。AI 可以据此理解现状，**不能**据此决策，更不能回写；
 *    ② 不重定义：`score` / `weight` / `feasibility` 都是系统算的，AI 无法改，
 *       也无法把自己上一轮的判断"注入"评分（评分层根本不接受 AI 的输入）；
 *    ③ 不落盘：整份上下文每次构建现算，不进 `project.json` / Semantic Model / Knowledge。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { AiSnapshot } from './snapshot.ts';
import type { AiSpatialContext } from './spatialContext.ts';
import type { AiDesignIntentContext } from './designIntentContext.ts';
import type { AiCandidateScoreContext } from './candidateScoreContext.ts';

export interface AiPlannerContext {
  /** 显式声明只读（给模型看的）—— 它不是可改的对象，也不是决策依据 */
  readOnly: true;
  note: string;
  /** 世界是什么（P9.1，派生事实） */
  spatial: AiSpatialContext;
  /** 人想要什么（P9.2，authored 目标） */
  designIntent: AiDesignIntentContext;
  /** 系统算出来什么（P9.4，确定性评分结论） */
  candidateScore: AiCandidateScoreContext;
}

/** 本视图的键（供验收自检用；顺序即语义顺序：事实 → 目标 → 结论） */
export const PLANNER_CONTEXT_KEYS = ['readOnly', 'note', 'spatial', 'designIntent', 'candidateScore'] as const;

export const PLANNER_CONTEXT_NOTE =
  '规划输入（只读）：`spatial` 是世界的样子（事实）、`designIntent` 是人想要的样子（目标）、' +
  '`candidateScore` 是系统对候选的确定性评分结论。三者都是**只读**：你可以据此组织一次规划请求，' +
  '但不能改它们、不能从 `candidateScore` 反推坐标、也不能宣布"哪一份更好"——' +
  '选哪份由用户拍板，落地一律走动作清单。';

/**
 * 组合三块只读上下文（**纯视图**：不改快照、不新增计算）。
 *
 * 没有 active 意图 ⇒ `candidateScore.evaluated` 为空 ⇒ 规划请求会如实产不出候选
 * （不是错误，是"现在还没有可规划的目标"）。
 */
export function buildPlannerContext(snapshot: AiSnapshot): AiPlannerContext {
  return {
    readOnly: true,
    note: PLANNER_CONTEXT_NOTE,
    spatial: snapshot.spatialContext,
    designIntent: snapshot.designIntent,
    candidateScore: snapshot.candidateScore,
  };
}
