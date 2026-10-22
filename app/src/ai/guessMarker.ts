/**
 * 「猜」的标记与识别（2026-10-22）
 *
 * ── 它是什么 ──
 *   提示词规则 6b 给模型第三条路：缺关键数字时，
 *   可以**先按默认值做**，但必须在 reason 里用 `【猜】` 标出猜了哪些。
 *
 *   理由：家具场景每个参数都问一遍会烦死用户；
 *   但**默默猜**更危险（出错图不可逆，用户直接点确认）。
 *   中间路是「做，但标出来，让用户在点确认前一眼看到」。
 *
 * ── 为什么放在 shared ──
 *   识别这个标记的地方不止一处：
 *   · PlanRunView（干跑预览）
 *   · Agent 步骤列表（agentSteps）
 *   · 未来任何展示 AI 理由的地方
 *   放一处才不会漂移。
 */

/** 模型用来标记「这个值是我猜的」的固定前缀。 */
export const GUESS_MARK = '【猜】';

/**
 * 一个 reason 里有没有「猜」。
 * @param {string | undefined | null} reason
 * @returns {boolean}
 */
export function hasGuess(reason: string | undefined | null): boolean {
  return typeof reason === 'string' && reason.includes(GUESS_MARK);
}

/**
 * 把 reason 拆成「猜的部分」与「其余部分」。
 *
 * @param {string | undefined | null} reason
 * @returns {{ guess: string, rest: string }}
 */
export function splitGuess(reason: string | undefined | null): { guess: string; rest: string } {
  const text = typeof reason === 'string' ? reason : '';
  const i = text.indexOf(GUESS_MARK);
  if (i < 0) return { guess: '', rest: text };
  return {
    guess: text.slice(i + GUESS_MARK.length).trim(),
    rest: text.slice(0, i).trim(),
  };
}
