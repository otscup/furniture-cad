/**
 * ══════════════════════════════════════════════════════════════════════
 *  FocusStack —— 显式对话焦点（2026-10-21）
 *
 *  ── 它解决什么 ──
 *    「再宽点」「刚才那个」「第一格」这些词，**单独看没有意义**，
 *    意思全在上一轮里。现在模型每轮都要**从自由文本里重新推断**焦点，
 *    于是它飘 —— NLU 评测卡实测多轮场景 pass^3 只有 75%（最弱的一环）。
 *
 *    ⇒ 把焦点变成**结构化状态**，直接告诉模型：
 *      · 现在盯着哪只柜（id + 名字）
 *      · 上一轮对它做了什么（改了什么字段、改成多少）
 *      · 上一轮得到的**绝对值**（供相对量换算：再加 200 ⇒ 1800+200=2000）
 *
 *  ── 为什么不用模型自己总结 ──
 *    让模型在上一轮末尾额外输出一个 focus 描述 = 多一次调用 + 多一个出错点。
 *    而**这些信息本来就在系统里**（项目状态 + 上一轮的命令），
 *    直接**从事实里推导**更可靠。
 *
 *  ── 与 summarizeProjectContext 的分工 ──
 *    summarizeProjectContext = 「工作区里有什么」（空间/柜体/分区现状）
 *    FocusStack            = 「我们现在在聊哪一只、上一轮动过什么」
 *    两个是**互补**的，不是替代。
 *
 *  ── 跨轮指代的三种形态 ──
 *    ① 显式：「主卧衣柜的层板格换成玻璃门」⇒ 不需要 focusStack
 *    ② 隐式指代：「再宽点」「第一格」⇒ 需要 focusStack 指明对象
 *    ③ 相对量：「再加 200」⇒ 需要 focusStack 给基准值才能算绝对值
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 焦点条目：上一轮动过哪只柜、改成多少。
 *
 * @typedef {{
 *   cabinetId: string,
 *   cabinetName: string,
 *   action: string,
 *   snapshot?: { width?: number, height?: number, depth?: number },
 *   changes?: Array<{ field: string, from?: number|string, to?: number|string }>,
 * }} FocusEntry
 */

/**
 * 上一轮 Agent 执行后的落点（从命令结果里提取的事实）。
 *
 * ★ 这不是「模型说的」，是**系统实际做了什么** ——
 *   模型可能说「已改成 2000」而实际没改；这里只信命令与项目状态。
 *
 * @typedef {{
 *   cabinetId: string,
 *   cabinetName?: string,
 *   action: string,
 *   changes?: Array<{ field: string, from?: number|string, to?: number|string }>,
 *   snapshot?: { width?: number, height?: number, depth?: number },
 * }} FocusFact
 */
/**
 * 从**已执行的命令**里推导焦点事实。
 *
 * ★ 为什么从命令推导，而不是从模型的回复文本 ──
 *   模型可能说「已改成 2000」而实际没改（编译失败被拒了）。
 *   只有**命令 + 项目状态**是事实。
 *
 * @param steps Agent 循环产出的步骤（已执行的）
 * @param project 现在的项目状态（取尺寸绝对值）
 * @returns 焦点事实（按影响对象聚合）
 */

/**
 * 把命令路径翻成人话（「width」→「宽」）。
 * @param {string} path 命令里的字段路径
 * @returns {string|null} 中文标签；认不出来返回 null
 */
function fieldLabelOf(path) {
  const p = String(path ?? '');
  if (p.includes('width')) return '宽';
  if (p.includes('height')) return '高';
  if (p.includes('depth')) return '深';
  if (p.includes('bodyLift')) return '踢脚高';
  if (p.includes('placement.x') || p.includes('placement.y')) return '位置';
  if (p.includes('shelves.count')) return '层板数';
  if (p.includes('drawers.count')) return '抽屉数';
  if (p.includes('doors.count')) return '门扇数';
  if (p.includes('doors.material')) return '门板材质';
  if (p.includes('rod.heightFromBottom')) return '挂衣杆高度';
  if (p.includes('nickname')) return '名字';
  return null;
}

/**
 * 把一步执行描述成人话。
 * @param {object} st 步骤
 * @returns {string} 描述；没有就返回空串
 */
function describeStep(st) {
  const tool = String(st.tool ?? '');
  const map = {
    'cad.create_cabinet': '新建了柜体',
    'cad.update_object': '改了柜体',
    'cabinet.layout.addUnit': '新增了分区',
    'cabinet.layout.removeUnit': '删除了分区',
    'cabinet.layout.setUnitString': '改了分区',
    'cabinet.layout.setUnitInt': '改了分区',
    'cad.place_cabinet': '调整了落位',
    'cad.duplicate_object': '复制了柜体',
    'cad.create_assembly': '建立了组合',
  };
  return map[tool] ?? '';
}
/**
 * 从**已执行的步骤**里推导焦点事实。
 *
 * ★ 为什么从步骤推导，而不是从模型的回复文本 ──
 *   模型可能说「已改成 2000」而实际没改（编译失败被拒了）。
 *   只有**执行记录 + 项目状态**是事实。
 *
 * ★ 柜体 id 从哪来 ──
 *   步骤的 args 里带 cabinetId / cabinetName（AI 通道的动作都带 target）；
 *   拿不到就退回按工具名匹配不了 ⇒ 该步不产生焦点。
 *
 * @param steps Agent 循环产出的步骤（已执行的）
 * @param project 现在的项目状态（取尺寸绝对值）
 * @returns 焦点事实（按柜体聚合）
 */
export function deriveFocusFacts(steps, project) {
  const byCabinet = new Map();
  for (const st of Array.isArray(steps) ? steps : []) {
    if (!st || st.ok !== true) continue;
    const args = st.args ?? {};
    const cabId = String(args.cabinetId ?? args.targetCabinetId ?? '');
    if (!cabId) continue;
    const cab = (project?.cabinets ?? []).find((c) => c.id === cabId);
    if (!cab) continue;
    const entry = byCabinet.get(cabId) ?? {
      cabinetId: cabId,
      cabinetName: cab.name ?? cabId,
      action: '',
      changes: [],
    };
    const desc = describeStep(st);
    if (desc) entry.action = entry.action ? entry.action + '；' + desc : desc;
    for (const ch of st.changes ?? []) {
      const field = fieldLabelOf(ch.path);
      if (!field) continue;
      entry.changes.push({ field, to: ch.value });
    }
    byCabinet.set(cabId, entry);
  }
  // 快照取**当前**项目里的绝对值（改完之后的状态）
  for (const entry of byCabinet.values()) {
    const cab = (project?.cabinets ?? []).find((c) => c.id === entry.cabinetId);
    if (cab?.params) {
      entry.snapshot = { width: cab.params.width, height: cab.params.height, depth: cab.params.depth };
    }
  }
  return [...byCabinet.values()];
}
/**
 * 把焦点事实渲染成提示词里的一段。
 *
 * ★ 写法要点 ──
 *   ① **给绝对值**：相对量（「再加 200」）只有拿到基准才算是数。
 *      「当前宽 1800mm」+「上一轮改成 2000」⇒ 模型能算出 2000。
 *   ② **给柜体名**：用户说「那个衣柜」时要能对上号。
 *   ③ **说清这是事实不是猜测**：模型不该再去猜上一轮干了什么。
 *
 * @param facts 焦点事实
 * @returns 提示词文本；没有事实时返回空串
 */
export function renderFocusStack(facts) {
  const list = Array.isArray(facts) ? facts.filter((f) => f && f.cabinetId) : [];
  if (list.length === 0) return '';
  const lines = [];
  lines.push('【当前焦点】—— 上一轮动过这些（这是系统的事实，不是你的猜测）：');
  for (const f of list) {
    const parts = [];
    if (f.action) parts.push(f.action);
    if (f.changes && f.changes.length > 0) {
      const cs = f.changes.map((c) =>
        c.from === undefined ? `${c.field} → ${c.to}` : `${c.field} ${c.from} → ${c.to}`);
      parts.push('改了' + cs.join('、'));
    }
    if (f.snapshot) {
      const s = f.snapshot;
      const dims = [];
      if (s.width !== undefined) dims.push(`宽 ${s.width}mm`);
      if (s.height !== undefined) dims.push(`高 ${s.height}mm`);
      if (s.depth !== undefined) dims.push(`深 ${s.depth}mm`);
      if (dims.length) parts.push(`现在 ${dims.join(' × ')}`);
    }
    lines.push(`  · ${f.cabinetName}（cabinetId=${f.cabinetId}）：${parts.join('，')}`);
  }
  lines.push('  ★ 用户说「再宽点」「第一格」「那个抽屉」时，**对象就是这里面的柜体/分区**；');
  lines.push('    「再加 N」这类**相对量**，用上面的**当前绝对值**换算成目标值（例：现在宽 1800，用户说「再加 200」⇒ 目标 2000）。');
  lines.push('  ★ 如果焦点里有**多个**柜体，而用户的话没点名，**问清楚是哪一台**（不要替用户挑）。');
  return lines.join('\n');
}
/**
 * 从**对话历史**里推导焦点事实。
 *
 * ★ 为什么从历史推导，而不是从本次运行推导 ──
 *   本次运行刚开始时还没有「上一轮」——
 *   焦点指的是**上一次**对话动过什么。
 *   历史里每一轮都带着 agentSteps（工具调用记录），那才是事实。
 *
 * ★ 历史里 agentSteps 是**自由文本摘要**（前端拼的）还是结构化的？
 *   前端目前发的是 `agentSummary`（一段文字）—— 不可靠，模型说了不算。
 *   所以这里做的是：**从文字里尽量提取**，提取不到就退化为「用项目状态推断」。
 *
 * @param history 对话历史
 * @param project 当前项目状态
 * @returns 焦点事实
 */
export function deriveFocusFromHistory(history, project) {
  const facts = [];
  const list = Array.isArray(history) ? history : [];
  for (const h of list) {
    if (!h || h.role !== 'assistant') continue;
    // 优先用结构化的 steps（若有）
    const steps = parseSteps(h.agentSteps);
    if (steps.length > 0) {
      facts.push(...deriveFocusFacts(steps, project));
      continue;
    }
    // 退化：从人话摘要里抠柜体名
    const name = cabinetNameFromText(String(h.agentSummary ?? h.text ?? ''));
    if (!name) continue;
    const cab = (project?.cabinets ?? []).find((c) => c.name === name);
    if (!cab) continue;
    facts.push({
      cabinetId: cab.id,
      cabinetName: cab.name,
      action: '上一轮动过这只柜（细节不详）',
      snapshot: { width: cab.params?.width, height: cab.params?.height, depth: cab.params?.depth },
    });
  }
  return facts;
}

/**
 * 解析一轮里的工具调用记录。
 * @param {unknown} raw agentSteps（可能是 JSON 字符串或数组）
 * @returns 步骤数组；解析不出来返回空数组
 */
function parseSteps(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * 从人话里抠出柜体名（退化路径用）。
 * @param {string} text
 * @returns {string|null} 柜体名
 */
function cabinetNameFromText(text) {
  const m = /[「『]([^」』]+)[」』]/.exec(text);
  return m ? m[1] : null;
}
