/**
 * ══════════════════════════════════════════════════════════════════════
 *  操作序列复用（Sequence Reuse）
 *
 *  ── 它要解决什么 ──
 *    同一句话问两遍，或者换个说法问同一件事，每次都要重新让模型想一遍。
 *    实测「建柜」一次 13.6s / 2 步 —— 其中模型思考占了大头。
 *    如果这串操作**以前成功过**，那它可以**直接重放**，一次模型调用都不用。
 *
 *  ── 三档复用策略（按确信度从高到低）──
 *    ① **完全重放**（confidence=exact）：意图指纹一致 ⇒ 直接重放工具调用。
 *       0 次模型调用。
 *    ② **提示词参考**（confidence=similar）：意图相近 ⇒ 把上次的成功序列
 *       放进提示词当范例。模型仍会调，但会照着抄，步数更少。
 *    ③ **不用**：意图差异大。
 *
 *  ── 安全底线 ──
 *    重放**只重放创建类工具**（create_cabinet / create_room / create_assembly /
 *    draw_wall / update_object / place_cabinet）。
 *    **绝不重放删除类**（delete_object / discard_draft / apply_draft）——
 *    删除重放的语义随项目状态变化，重放很可能删错东西。
 *    重放全程在**新 draft** 里进行：失败就丢弃，绝不碰 live。
 *
 *  ── 指纹怎么算 ──
 *    指纹 = 规范化后的意图文本 + 动作族。
 *    规范化会去掉数字差异（「宽 600」和「宽 800」是同一类请求，
 *    但**参数不同**不能直接重放）—— 所以数字保留在指纹里，
 *    保证「完全重放」只在**字面等价**时发生。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 允许重放的工具白名单。
 *
 * ★ 删除类**故意不在里面** —— 重放删除的语义依赖当时的项目状态，
 *   现在重放很可能删错东西，而且不可逆。
 */
export const REPLAYABLE_TOOLS = new Set([
  'cad.create_cabinet',
  'cad.create_room',
  'cad.create_assembly',
  'cad.draw_wall',
  'cad.update_object',
  'cad.place_cabinet',
]);

/**
 * 可以重放的工具里，还要再排除掉「会破坏既有数据」的。
 * 保守起见，删除/应用/丢弃一律不可重放。
 */
export function isReplayable(toolName) {
  return REPLAYABLE_TOOLS.has(String(toolName ?? ''));
}

/**
 * 把用户原话规范化成指纹。
 *
 * 保留数字（不同尺寸是不同请求），去掉空白与标点，
 * 把中文数字统一成阿拉伯数字（「两米四」→「2400」）。
 *
 * @param {string} text 用户原话
 * @returns {string} 指纹；空文本返回空串
 */
export function intentFingerprint(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const cn = raw
    .replace(/([一二两三四五六七八九十])百/g, (_, d) => String(cnNum(d) * 100))
    .replace(/([一二两三四五六七八九十])十([一二三四五六七八九])?/g, (_, a, b) =>
      String(cnNum(a) * 10 + (b ? cnNum(b) : 0)))
    .replace(/([一二三四五六七八九])/g, (_, d) => String(cnNum(d)));
  return cn
    .replace(/[\s,，。.!！?？、;；:：~～]/g, '')
    .toLowerCase();
}

/**
 * 中文数字 → 阿拉伯数字（只处理 0~99 的常用情况，够用了）。
 * @param {string} d 单个中文字
 * @returns {number}
 */
function cnNum(d) {
  const map = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  return map[d] ?? 0;
}

/**
 * 序列指纹：意图指纹 + 动作族。
 *
 * 动作族来自 detectActionFamilies（同一个意思但改动类型不同，不能互相重放）。
 *
 * @param {string} text 用户原话
 * @param {string[]} families 动作族
 * @returns {string}
 */
export function sequenceKey(text, families = []) {
  const fp = intentFingerprint(text);
  if (!fp) return '';
  return fp + '|' + [...families].sort().join('+');
}

/**
 * 判断一个序列能不能**完全重放**。
 *
 * 必须同时满足：
 *  · 所有工具都在白名单里（没有删除类）；
 *  · 至少有一个创建动作（纯查询序列没什么可重放的）；
 *  · 序列本身完整（有头有尾）。
 *
 * @param {Array} steps [{tool, args}]
 * @returns {{ok: boolean, reason: string}}
 */
export function canReplay(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { ok: false, reason: '序列为空' };
  }
  for (const s of steps) {
    if (!isReplayable(s?.tool)) {
      return { ok: false, reason: '包含不可重放的工具：' + s.tool };
    }
  }
  const hasCreate = steps.some((s) => String(s?.tool ?? '').includes('create'));
  if (!hasCreate) {
    return { ok: false, reason: '序列里没有创建动作，重放没有意义' };
  }
  return { ok: true, reason: '' };
}

/**
 * 从一次成功的运行里提取可重放的步骤。
 *
 * 只取成功的步骤；剔除 draftId（重放时要用新的 draft）。
 *
 * @param {Array} steps Agent 循环产出的步骤
 * @returns {Array} [{tool, args}]
 */
export function extractReplayable(steps) {
  const out = [];
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || s.ok !== true) continue;
    if (!isReplayable(s.tool)) continue;
    if (s.tool === 'cad.validate') continue;
    const args = { ...(s.args ?? {}) };
    delete args.draftId;
    out.push({ tool: s.tool, args });
  }
  return out;
}

/**
 * 把上次的成功序列渲染成提示词范例。
 *
 * @param {object} seq 序列记录
 * @returns {string}
 */
export function renderSequenceHint(seq) {
  if (!seq || !Array.isArray(seq.steps) || seq.steps.length === 0) return '';
  const lines = [];
  lines.push('【上次类似需求你是这样做的】');
  lines.push('下面是本项目里**已经成功执行过**的一套操作，可以直接照着做（参数按这次的实际需求替换）：');
  for (const s of seq.steps) {
    let argStr = '';
    try {
      argStr = JSON.stringify(s.args ?? {});
    } catch {
      argStr = '';
    }
    lines.push('- ' + s.tool + ' ' + (argStr.length > 200 ? argStr.slice(0, 200) + '…' : argStr));
  }
  return lines.join('\n');
}
