/**
 * ══════════════════════════════════════════════════════════════════════
 *  纠正记忆检索（Rule Retrieval）
 *
 *  ── 它要解决什么 ──
 *    纠正记忆现在是**整包塞进提示词**的（最多 30 条）。规则一多就有两个问题：
 *      ① **稀释** —— 30 条规则里只有 2 条跟这次有关，
 *         模型却要为 28 条不相关的规则分心，还可能互相打架；
 *      ② **矛盾** —— 「背板要拆块」和「背板要整块」同时在场时，
 *         模型只能靠猜，猜错就是错图。
 *
 *    改成检索：按用户这句话的意图，挑出**真的相关**的那几条。
 *
 *  ── 为什么不能简单粗暴地「只给最相关的 3 条」──
 *    有些规则是**全局性的**（如「柜体不许重叠」「撞墙了要往回退」），
 *    它们跟具体意图无关，但每一条操作都要遵守。
 *    只按关键词匹配的话，这些规则会在「建个衣柜」时被丢掉 ——
 *    而这恰恰是最容易撞墙、最需要它们的场景。
 *
 *    所以分两类：
 *      · **常驻规则**（always）—— 无论做什么都要遵守，永远带上；
 *      · **情境规则**（conditional）—— 只在相关时带上。
 *    判定「常驻」用 scope：scope==='rule' 的是通用规矩，scope==='cabinet' 的是具体柜子的事。
 *
 *  ── 阈值策略 ──
 *    规则总数不多（<= ALWAYS_KEEP + 4）时**全给** —— 检索本身有误伤风险，
 *    规则少的时候没必要冒这个险。规则多起来才启用检索。
 *    这条阈值是刻意保守的：本模块最怕的不是「多给了几条」，
 *    而是「该给的没给」—— 那样用户会看到明显违反他自己定的规矩的结果。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 常驻规则永远带上；总规则数不超过这个数时就全给（不检索）。
 * @type {number}
 */
export const ALWAYS_KEEP = 4;

/**
 * 检索时最多额外带多少条情境规则。
 * @type {number}
 */
export const MAX_RETRIEVED = 6;

/**
 * 意图词表：用户话里的这些词，决定了「这次在做什么」，
 * 用来和规则的 tags / nl 做匹配。
 *
 * 词表刻意做成**同义词分组**而不是一长串：
 * 「柜体/柜子/箱子」是同一类意图的三个说法，分开列会让匹配分数失真。
 */
export const INTENT_LEXICON = {
  create: ['建', '做', '来一个', '来个', '加个', '新增', '搭', '装'],
  cabinet: ['柜', '柜体', '柜子', '箱体', '衣柜', '地柜', '吊柜', '书架', '台面', '台柜'],
  kitchen: ['厨房', '灶', '水槽', '洗碗', '台面', '橱柜', 'l型', '一字'],
  wardrobe: ['衣柜', '衣橱', '挂衣', '卧室', '被褥', '被子'],
  storage: ['储物', '收纳', '置物', '放东西', '格子', '层板', '隔板', '分区'],
  appliance: ['洗衣机', '冰箱', '洗碗机', '烘干', '电器', '灶具', '蒸箱', '烤箱'],
  geometry: ['宽', '高', '深', '尺寸', '大小', '位置', '挪', '移', '靠墙', '贴', '旋转', '转'],
  units: ['抽屉', '层板', '隔板', '分区', '门', '格子', '挂衣杆', '拉篮'],
  material: ['材质', '板材', '背板', '板子', '木'],
  naming: ['改名', '重命名', '名字', '叫'],
  assembly: ['组合', '成组', '拼', '一排', '整组', '并排'],
  collision: ['撞', '重叠', '叠了', '冲突', '打架', '压到', '越界', '出屋'],
  opening: ['门', '窗', '洞口', '开口', '挡'],
};

/**
 * 从用户原话里抽出命中的意图标签。
 *
 * @param {string} text 用户原话
 * @returns {string[]} 命中的意图标签（去重）
 */
export function detectIntentTags(text) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return [];
  const tags = [];
  for (const [tag, words] of Object.entries(INTENT_LEXICON)) {
    for (const w of words) {
      if (hay.includes(w.toLowerCase())) {
        tags.push(tag);
        break;
      }
    }
  }
  return tags;
}

/**
 * 把一段文本切成二元组（bigram），用来算字面重合度。
 * 中文没有空格分词，二元组是最省事又不失真的近似。
 *
 * @param {string} s
 * @returns {Set<string>}
 */
function bigrams(s) {
  const out = new Set();
  const t = String(s ?? '').replace(/\s+/g, '');
  if (t.length === 1) {
    out.add(t);
    return out;
  }
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 算两条文本的字面重合度（Jaccard）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0~1
 */
function jaccard(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * 一条规则有多「常驻」。
 *
 * scope==='rule' 的是通用规矩（碰撞、背板、几何生成器这类），
 * 它们跟具体意图无关，任何操作都要遵守 ⇒ 常驻。
 * scope==='cabinet' 的是某只柜子的事 ⇒ 情境规则，按需取。
 *
 * 另外：如果规则文本里出现「不许 / 不能 / 永远 / 任何」这类**否定式硬话**，
 * 那它多半也是常驻的 —— 否定式规则漏掉的代价比多余的高。
 *
 * @param {object} rule
 * @returns {boolean}
 */
export function isAlwaysRule(rule) {
  if (!rule || typeof rule !== 'object') return false;
  if (rule.scope === 'rule') return true;
  const nl = String(rule.nl ?? '');
  return /不许|不能|永远|任何|都不|禁止|不得/.test(nl);
}

/**
 * 给一条规则打分（相关性）。
 *
 * @param {object} rule 规则 {nl, tags, scope}
 * @param {string} text 用户原话
 * @param {string[]} intentTags detectIntentTags 的结果
 * @returns {number} 0 = 无关
 */
export function scoreRule(rule, text, intentTags) {
  if (!rule) return 0;
  const nl = String(rule.nl ?? '');
  const tags = Array.isArray(rule.tags) ? rule.tags : [];
  let score = 0;

  // ① 规则自己的 tags 与意图标签对上 —— 最强的信号
  for (const t of tags) {
    for (const it of intentTags) {
      if (String(t).toLowerCase().includes(it) || it.includes(String(t).toLowerCase())) {
        score += 3;
      }
    }
  }

  // ② 规则 tags 里的词直接出现在用户话里
  const hay = String(text ?? '').toLowerCase();
  for (const t of tags) {
    if (t && hay.includes(String(t).toLowerCase())) score += 2;
  }

  // ③ 字面重合
  score += jaccard(nl, String(text ?? '')) * 4;

  // ④ 意图标签在规则文本里出现
  for (const it of intentTags) {
    if (nl.toLowerCase().includes(it.toLowerCase())) score += 1.5;
  }

  return score;
}

/**
 * ★ 检索的入口 ★
 *
 * 按用户这句话，从全部规则里挑出该带的那几条。
 *
 * @param {Array} rules 全部候选规则 [{nl, tags, scope}]
 * @param {string} text 用户原话
 * @param {object} [options]
 * @param {number} [options.max=MAX_RETRIEVED] 情境规则最多几条
 * @param {number} [options.threshold=1.2] 相关性阈值
 * @returns {{kept: Array, always: Array, matched: Array, mode: string}}
 *   kept    —— 最终要注入的规则（常驻 + 情境，已去重）
 *   always  —— 常驻规则部分
 *   matched —— 情境规则部分
 *   mode    —— 'all'（规则少，全给）| 'retrieved'（规则多，检索过）
 */
export function retrieveRules(rules, text, options = {}) {
  const all = Array.isArray(rules) ? rules.filter((r) => r && String(r.nl ?? '').trim()) : [];
  const max = Number.isFinite(options.max) ? options.max : MAX_RETRIEVED;
  const threshold = Number.isFinite(options.threshold) ? options.threshold : 1.2;

  if (all.length === 0) {
    return { kept: [], always: [], matched: [], mode: 'all' };
  }

  const always = all.filter(isAlwaysRule);

  // 规则不多 ⇒ 全给（检索有误伤风险，规则少时没必要冒险）
  if (all.length <= ALWAYS_KEEP + 4) {
    return { kept: all, always, matched: [], mode: 'all' };
  }

  const intentTags = detectIntentTags(text);
  const conditional = all.filter((r) => !isAlwaysRule(r));
  const scored = conditional
    .map((r) => ({ rule: r, score: scoreRule(r, text, intentTags) }))
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score);

  const matched = scored.slice(0, max).map((x) => x.rule);

  // 去重（按 nl）
  const seen = new Set();
  const kept = [];
  for (const r of [...always, ...matched]) {
    const k = String(r.nl).trim();
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(r);
  }

  return { kept, always, matched, mode: 'retrieved' };
}

/**
 * 把规则渲染成提示词文本。
 *
 * ★ 为什么放在这个模块而不是各自写一遍 ──
 *   plan / design / agent 三条通道都要渲染这段。
 *   三处各写一遍 = 三处措辞会慢慢漂移，模型在不同通道里受到不同的对待。
 *   共享一个函数 = 一处改动，三条通道同时生效。
 *
 * ★ 必须先过滤空条目再决定要不要输出标题 ──
 *   数组非空但条目全是空白时，如果只看 length 就输出标题，
 *   模型会读到「本项目的既定约定：」然后发现下面什么都没有，
 *   容易理解成「这个项目没有约定」（而事实是「有约定但没写清」）。
 *   那比没这段更糟。
 *
 * @param {Array} rules [{nl, tags}]
 * @returns {string} 没有规则时返回空串
 */
/**
 * ★ 服务端那层用的就是这个 ──
 *
 * 服务端原来把这个逻辑**内联**在 server.mjs 里（读文件 → 过滤 → 检索）。
 * 内联的后果：验收脚本**没法直接测它** ——
 *   ① server.mjs 一 import 就有副作用（起服务、读 .env），测试里引不动；
 *   ② 只能退化成源码扫描断言（`serverSrc.includes(...)`），
 *   而源码扫描断言守不住行为（第一版就是这么栽的）。
 *
 * 所以把「选哪些规则」这个纯逻辑提到共享模块，
 * 服务端只负责读文件（那是服务端的事），选择交给这里。
 *
 * @param {Array} rules 全部候选规则
 * @param {string} text 用户这一句话
 * @returns {Array} 要注入提示词的规则
 */
export function selectProjectRules(rules, text) {
  const list = Array.isArray(rules) ? rules : [];
  if (list.length === 0) return [];
  const { kept } = retrieveRules(list, text);
  return kept;
}

export function renderProjectRules(rules) {
  const ruleLines = [];
  for (const rule of Array.isArray(rules) ? rules.slice(0, 30) : []) {
    const text = String(rule?.nl ?? '').trim();
    if (!text) continue;
    const tags = Array.isArray(rule?.tags) && rule.tags.length > 0 ? '（' + rule.tags.join('/') + '）' : '';
    ruleLines.push('- ' + text + tags);
  }
  if (ruleLines.length === 0) return '';
  const lines = [];
  lines.push('【本项目的既定约定】');
  lines.push('下面这些是这个项目**已经确认过**的做法（来自管理后台的纠正记录）。它们优先于你的通用常识：');
  lines.push(...ruleLines);
  return lines.join('\n');
}
