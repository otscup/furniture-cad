/**
 * 确定性设计评分层（P9.4）—— 对外唯一出口。
 *
 *   model.ts  DesignScore / DesignScoreComponent / DesignScoreHardFailure /
 *             DesignScorePreferenceMatch / 权重政策（weight = null，§九）
 *   score.ts  scoreCandidateLayout（Gate → 条件命中 → 偏好命中）/ compareDesignScores
 *
 * ── 导出面本身就是一条纪律：**没有 winner / best / recommended / adopt / apply** ──
 *   评分只回答"这份候选如果这样摆会得到什么结果"，**不选方案、不让任何候选生效**。
 *   要落地必须走 CommandBus（本层不 import 它），且必须由用户拍板。
 *   `verify:design-score` 会断言这个导出面里不含上述名字。
 */
export * from './model.ts';
export * from './score.ts';
