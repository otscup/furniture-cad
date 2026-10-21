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
 * ══════════════════════════════════════════════════════════════════════
 *  相似度匹配（把「上次类似的做法」挑出来当范例）
 *
 *  ── 它要解决什么 ──
 *    findSimilar 原来只按「动作族有交集」筛选。那是**类型**层面的过滤，
 *    不是**内容**层面的 —— 同一族里的两条序列可能差得很远：
 *    「建个衣柜」和「建个鞋柜」都是 create 族，但做法完全不同。
 *    把不相关的一条当范例塞进提示词，模型会**照着抄**错的做法，
 *    比不给范例更糟。
 *
 *  ── 为什么用字符二元组（bigram）Jaccard ──
 *    中文没有空格分词，二元组是最省事又不失真的近似：
 *    「建个衣柜」和「做个衣柜」共享 {个衣, 衣柜} ⇒ 像；
 *    「建个衣柜」和「把柜子改宽点」一个二元组都不共享 ⇒ 不像。
 *    口径与 shared/ruleRetrieval.mjs 里的 jaccard 保持一致 ——
 *    两处各写一套，同一件事会有两个不同的数，早晚漂移。
 *
 *  ── 阈值为什么取 0.45（实测出来的，不是拍的）──
 *    拿本项目真实说法跑一遍，分成两簇：
 *      · 该像的：0.40 ~ 1.00
 *        （「建个衣柜」/「帮我建个衣柜」= 0.60、「加个吊柜」/「再加个吊柜」= 0.75、
 *          「建个衣柜」/「建个衣橱」= 0.50、「建个衣柜」/「建一个衣柜」= 1.00）
 *      · 不该像的：≤ 0.20
 *        （「加个抽屉」/「加个层板」= 0.20、「建个衣柜」/「建个书柜」= 0.20）
 *    0.45 正落在两簇之间的空档里。
 *
 *    ★ 阈值往高了取，不往低了取 ──
 *      范例是给模型**照着抄**的。给一条不相关的范例，模型会照抄；
 *      不给范例，模型自己想一遍 —— 结果仍然是对的，只是慢一点。
 *      两个代价不对等，所以宁可漏。
 *
 *  ── 已知局限（记下来，免得以后误以为它能分）──
 *    字符层面的相似度分不出「衣柜」和「衣架」：结构一样、只差一个字，
 *    得分同样是 0.50。这类「同构不同物」只能靠语义拦，本模块拦不住。
 *    动作族那一关能拦掉跨类型的（建柜 vs 改尺寸），拦不掉同类型的
 *    （衣柜 vs 衣架）—— 这是已知代价，不假装没有。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 相似度检索的默认阈值。
 *
 * ★ 数字的依据见上面那段实测 —— 0.45 落在「该像」与「不该像」两簇之间。
 * @type {number}
 */
export const SIMILARITY_THRESHOLD = 0.45;
/**
 * 把配置里的阈值解析成一个可用的数字。
 *
 * ★ 为什么要有这个函数 ──
 *   阈值可以配（.env 的 SEQ_SIMILARITY_THRESHOLD），
 *   但**解析必须能测**。
 *   服务端那份代码住在 server.mjs 里 —— 一 import 就会起服务，
 *   验收脚本根本引不动（ruleRetrieval 那边踩过同样的坑，
 *   最后把纯逻辑提到了 shared 里）。
 *   所以「怎么解析」放这里，服务端只负责把 .env 的那一行传进来。
 *
 ★ 配坏了怎么办 ──
 *   回落到默认值，**不**报错、**不**把功能带坏。
 *   一个手滑写错的配置项，不该让整个序列复用停摆。
 *
 * @param {string|number|undefined} value 配置里的原始值
 * @returns {number} 0~1 之间的阈值
 */
export function resolveSimilarityThreshold(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return SIMILARITY_THRESHOLD;
  if (raw <= 0 || raw > 1) return SIMILARITY_THRESHOLD;
  return raw;
}

/**
 * 一次最多带几条范例。
 *
 * ★ 为什么不给更多 ──
 *   范例越多，模型越容易把**别人那次的需求参数**当成本次的默认值。
 *   这东西的作用是「省掉摸索」，不是「穷举可能性」—— 给最好的 1~2 条就够。
 * @type {number}
 */
export const MAX_SIMILAR_SEQUENCES = 2;

/**
 * 量词表：数字 + 量词 是**计数**，不是**参数**。
 *
 * ★ 只收「可数名词」的量词，绝不收尺寸单位（mm/cm/m）——
 *   收了尺寸单位就会把「宽600」和「宽800」折成同一句话，
 *   而那两个是**不同的需求**，给错范例等于给错尺寸。
 */
const COUNT_UNITS = [
  '个', '只', '张', '把', '条', '台', '扇', '副', '双', '根', '块',
  '间', '组', '排', '套', '件', '栋', '棵', '座', '匹',
];

/**
 * 把一句话变成「用于比较像不像」的文本。
 *
 * ★ 与 intentFingerprint 的区别（这两个别混）──
 *   intentFingerprint 是**重放**的判据，必须严格：数字不同就是不同的需求，
 *   绝不能折叠（「宽600」和「宽800」不能互相重放）。
 *   这里只用来**比较像不像**，所以把「计数」折叠掉：
 *   「建一个衣柜」与「建个衣柜」是同一个需求，折叠后完全一致 ⇒ 相似度 1。
 *
 * ★ 只折叠「数字 + 量词」，绝不裸删数字 ──
 *   裸删数字会把「宽600」和「宽800」变成同一句话。
 *
 * @param {string} text 用户原话
 * @returns {string} 规范化后的比较文本；空文本返回空串
 */
/**
 * ★ 私用区（PUA）码位的起点 ──
 *
 *   U+E000 ~ U+F8FF 是 Unicode 划给「私有使用」的码位：
 *   正式字符集里不会有，也不会有用户输入正好是这些字符。
 *   所以拿它当「数字的替身」是安全的 —— 不会撞上任何真实文字。
 */
const PUA_BASE = 0xe000;

/**
 * 私用区里可用的码位数量。
 *
 * ★ 为什么要留出这么多个 ──
 *   数字要映射成**两位**私用区字符：两位才能让不同的数字
 *   落在完全不同的码位组合上（一位只有 6400 种，够用但不宽裕）。
 */
const PUA_SPAN = 6400;

/**
 * 把一个数字映射成**两个私用区字符**。
 *
 * ★ 为什么要用私用区字符，而不是 '#' + 十六进制 ──
 *   十六进制（'#600#' / '#800#'）仍会共享 bigram「00」「0#」——
 *   实测「建个衣柜宽600」vs「做3个吊柜宽600」相似度 0.647，
 *   **越过了 0.45 的阈值**：两个完全不同的需求被判成同一件事。
 *
 *   私用区字符不会：不同数字 ⇒ 不同码位 ⇒ **一个 bigram 都不共享**。
 *   而「建个衣柜」与「建个衣柜宽600」共享的是「建个衣柜」那部分，
 *   剩下的分母里带着尺寸的区分度 ⇒ 相似度自然落在 0.5 左右，
 *   既是同一个任务，又没被当成同一句话。
 *
 * ★ 长度固定为 2 ──
 *   Jaccard 的分母是「两边 bigram 集合的大小之和」，
 *   数字长度不同（600 vs 8000）会让分母不可比。
 *   固定两位 ⇒ 分母永远可比。
 *
 * @param {string} num 纯数字串
 * @returns {string} 两个私用区字符
 */
function dimensionMarker(num) {
  let h = 0x811c9dc5;
  for (let i = 0; i < num.length; i++) {
    h = (h ^ num.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  const lo = h % PUA_SPAN;
  const hi = Math.floor(h / PUA_SPAN) % PUA_SPAN;
  return String.fromCharCode(PUA_BASE + lo, PUA_BASE + hi);
}

/**
 * 把一句话变成「用于比较像不像」的文本。
 *
 * ★ 三条规矩 ──
 *   ① 计数（数字 + 量词）**折叠掉** ——「建一个衣柜」≡「建个衣柜」。
 *   ② 尺寸（裸数字）换成**按值区分的私用区标记** ——
 *      保留区分度，且不与别的数字共享 bigram。
 *   ③ 数字**前后的文字必须原样保留** ——
 *      这条曾经错过：早先的写法在遇到数字时直接跳到数字处，
 *      把「建个衣柜宽600」里的「建个衣柜」整个丢了，
 *      于是「建个衣柜宽600」和「做3个吊柜宽600」都只剩一个标记 ⇒ 相似度 1.0，
 *      两个完全不同的任务被判成同一件事。
 *
 * @param {string} text 用户原话
 * @returns {string} 规范化后的比较文本；空文本返回空串
 */
function similarityText(text) {
  const base = intentFingerprint(text);
  if (!base) return '';
  const units = COUNT_UNITS.join('|');
  /**
   * 找出所有「数字 + 量词」的位置 —— 那些是计数，要折叠。
   */
  const countRe = new RegExp('[0-9]+(?=' + units + ')', 'g');
  const countSpans = [];
  for (const m of base.matchAll(countRe)) countSpans.push([m.index, m.index + m[0].length]);

  let out = '';
  let i = 0;
  while (i < base.length) {
    const d = /[0-9]/.exec(base.slice(i));
    if (!d || d.index === undefined) {
      out += base.slice(i);
      break;
    }
    const start = i + d.index;
    // ★ 数字**前面**的文字必须保留（早先就是漏了这一句）
    out += base.slice(i, start);
    const numMatch = /^[0-9]+/.exec(base.slice(start));
    const num = numMatch ? numMatch[0] : base.slice(start);
    const isCount = countSpans.some(([s, e]) => start >= s && start < e);
    if (isCount) {
      // 计数：折叠掉（「一个」≡「个」）
      out += '';
    } else {
      // 尺寸参数：换成按值区分、长度固定的私用区标记
      out += dimensionMarker(num);
    }
    i = start + num.length;
  }
  return out;
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
  if (inter === 0) return 0;
  return inter / (A.size + B.size - inter);
}

/**
 * 取一段话（字符串或带 intent 字段的序列记录）。
 *
 * @param {string|{intent?: string}} x
 * @returns {string}
 */
function textOf(x) {
  if (typeof x === 'string') return x;
  if (x && typeof x === 'object') return String(x.intent ?? '');
  return '';
}

/**
 * 两条意图有多像（0~1）。
 *
 * 完全一样 ⇒ 1；一个字都不沾 ⇒ 0。
 *
 * ★ 为什么能当判据 ──
 *   它只回答「像不像」，**不回答**「能不能照抄」。
 *   能不能重放是 canReplay 的事（白名单 + 有创建动作），
 *   两件事分开管：相似度再高也不改变删除类不可重放这条底线。
 *
 * @param {string|{intent?: string}} a
 * @param {string|{intent?: string}} b
 * @returns {number} 0~1
 */
export function similarityOf(a, b) {
  const ta = similarityText(textOf(a));
  const tb = similarityText(textOf(b));
  if (!ta || !tb) return 0;
  return jaccard(ta, tb);
}

/**
 * ★ 从一堆历史序列里挑出「像这次」的候选 ★
 *
 * 三道闸，缺一不可：
 *   ① **可重放** —— 含删除类的序列一律不进来（canReplay 的白名单）。
 *   ② **动作族有交集** —— 分不清类型的请求不参与序列复用
 *      （跟 server.mjs 里 detectFamiliesFor 同一个口径）。
 *   ③ **相似度达标** —— 低于阈值直接丢掉。
 *
 * ★ 第③道为什么放在最后也最重要 ──
 *   前两道是「类型对不对」，第三道才是「内容像不像」。
 *   只有动作族这一道时，「建个衣柜」会捞出「建个鞋柜」——
 *   那条范例会把模型带偏，而且模型会照着抄。
 *
 * @param {Array} seqs 历史序列 [{key, intent, families, steps, at}]
 * @param {string} intent 这次的用户原话
 * @param {string[]} families 这次的动作族
 * @param {object} [options]
 * @param {number} [options.threshold=SIMILARITY_THRESHOLD] 相似度阈值
 * @param {number} [options.limit=MAX_SIMILAR_SEQUENCES] 最多返回几条
 * @param {string} [options.excludeKey] 要排除的 key（自己那条）
 * @returns {Array} 排序后的候选 [{...seq, similarity}]，相似度降序
 */
export function matchSequences(seqs, intent, families = [], options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : SIMILARITY_THRESHOLD;
  const limit = Number.isFinite(options.limit) ? options.limit : MAX_SIMILAR_SEQUENCES;
  const excludeKey = String(options.excludeKey ?? '');
  const fam = new Set(Array.isArray(families) ? families : []);

  // 分不清类型 ⇒ 一条都不给。宁可没有范例，也不要给错类型的范例。
  if (fam.size === 0) return [];

  const list = Array.isArray(seqs) ? seqs : [];
  const out = [];
  for (const seq of list) {
    if (!seq || typeof seq !== 'object') continue;
    if (excludeKey && seq.key === excludeKey) continue;
    // ① 安全底线：删除类序列永远不进候选
    if (!canReplay(seq.steps).ok) continue;
    // ② 类型要对得上
    const sf = Array.isArray(seq.families) ? seq.families : [];
    if (!sf.some((f) => fam.has(f))) continue;
    // ③ 内容要够像
    const similarity = similarityOf(seq, intent);
    if (similarity < threshold) continue;
    out.push({ ...seq, similarity });
  }

  // 相似度降序；同分时取最近的那条（同一条做法，越近越贴近当前项目状态）
  out.sort((a, b) => (b.similarity - a.similarity) || ((b.at ?? 0) - (a.at ?? 0)));
  return limit >= 0 ? out.slice(0, limit) : out;
}

/**
 * 把上次的成功序列渲染成提示词范例。
 *
 * ★ 为什么能收一条也能收一批 ──
 *   服务端传下来的是**排好序的候选列表**（最像的在前）。
 *   这里按顺序渲染前几条；一条时读起来是「上次那套」，
 *   几条时是「上次那几套」，都还是本项目里已经跑通过的做法。
 *
 * @param {object|Array} seq 序列记录，或排好序的候选列表
 * @returns {string}
 */
export function renderSequenceHint(seq) {
  const list = Array.isArray(seq) ? seq : (seq ? [seq] : []);
  const usable = list.filter((s) => s && Array.isArray(s.steps) && s.steps.length > 0);
  if (usable.length === 0) return '';
  const picked = usable.slice(0, MAX_SIMILAR_SEQUENCES);
  const lines = [];
  lines.push('【上次类似需求你是这样做的】');
  lines.push(
    picked.length === 1
      ? '下面是本项目里**已经成功执行过**的一套操作，可以直接照着做（参数按这次的实际需求替换）：'
      : '下面是本项目里**已经成功执行过**的几套操作，可以直接照着做（参数按这次的实际需求替换）：',
  );
  for (const s of picked) {
    for (const st of s.steps) {
      let argStr = '';
      try {
        argStr = JSON.stringify(st.args ?? {});
      } catch {
        argStr = '';
      }
      lines.push('- ' + st.tool + ' ' + (argStr.length > 200 ? argStr.slice(0, 200) + '…' : argStr));
    }
  }
  return lines.join('\n');
}