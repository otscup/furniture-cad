/**
 * 候选布局层（P9.3）—— 对外唯一出口。
 *
 *   model.ts     纯临时对象模型（CandidateLayout / CandidatePlacement / CandidateRequest …）
 *   generate.ts  确定性枚举（复用 candidateSpots / resolvePlacement / detectCollisions / 事实层）
 *
 * ── 导出面本身就是一条纪律：**没有 adopt / apply / commit / persist 任何名字** ──
 *   候选只描述"如果这样摆会得到什么结果"；把它变成真实 placement 是**未来**的事，
 *   本层不提供任何"让候选生效"的入口（想写模型只能走 CommandBus，而本层不 import 它）。
 *   `verify:candidate-layout` 会断言这个导出面里不含 adopt / apply / commit / persist。
 */
export * from './model.ts';
export * from './generate.ts';
