/**
 * AI Planner 基础层（P9.5）—— 对外唯一出口。
 *
 *   model.ts    PlannerRequest / PlannerPlan / PlannerUnresolved /
 *               PlannerGeometryForbidden（类型层禁几何）/ 规模上限
 *   request.ts  语义归一化：id 必须真的存在、必须是 active、规模超限**整份拒绝**（不裁剪）
 *   plan.ts     planCandidates —— Phase B 编排：P9.3 枚举 → P9.4 评分（零第二份判定）
 *
 * ── 导出面本身就是一条纪律 ──
 *   这里**没有** winner / best / recommended / pick / adopt / apply / commit / persist
 *   任何名字：Planner 只回答"按这些目标能枚举出哪些候选、它们各自会得到什么结果"，
 *   **不选方案、不让任何候选生效**（§十）。选哪份由用户拍板；
 *   要落地必须走 CommandBus（本层不 import 它）。
 *   `verify:ai-planner` 会断言这个导出面里不含上述名字。
 */
export * from './model.ts';
export * from './request.ts';
export * from './plan.ts';
