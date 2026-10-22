/**
 * 配方 few-shot 样例（2026-10-22）
 *
 * ── 为什么加这个 ──
 *   调研结论：「**模型是抄示例，不是读规则**」。
 *   配方库原来只有 `steps`（人话步骤）和 `traps`（常见坑），
 *   两者都是**描述**，不是**范例** —— 模型读完还是得自己把话翻译成动作。
 *
 *   少的就是这一层：**用户这么说 → 动作长这样**。
 *
 * ── 关键纪律：样例必须**过契约校验** ──
 *   手写的样例极易过期（我第一版 10 个样例里 **4 个过不了校验**：
 *   setUnitParam 用错参数名、setBodyLift 用 value 而非 mm、
 *   setUnitFeature 的 value 不是字符串、duplicate 没有 name 参数）。
 *   ⇒ 样例里带一个**自检**，过不了就抛错 ——
 *   契约改了、样例没跟着改，验收立刻变红。
 *
 * ── 形态 ──
 *   每个配方最多 1 个样例（多了会稀释注意力，也吃 token）。
 *   样例 = { says: 用户会怎么说, actions: [动作…] }。
 */

import { validateAction } from './aiContract.mjs';

export const RECIPE_EXAMPLES = [
  {
    recipe: 'wardrobe',
    title: '建一只衣柜并分区',
    // ★ keywords 是**说话方式**的线索，不是家具类型 ——
    //   「带尺寸的衣柜」这个范例的关键词是「宽/米/高/深」这类**尺寸词**。
    // ★ 关键词必须是**具体短语**，不能是单字 ——
    //   「宽」会命中「把柜子改宽点」（那是**改**尺寸，不是**建**柜）。
    keywords: [' 宽', ' 米', ' 毫米', '宽的', '米高', '深 '],
    notKeywords: ['改宽', '变宽', '加宽', '缩窄'],
    requireAll: false,
    says: '给我来个衣柜，1800 宽，2 米 4 高，左边挂衣服右边放层板',
    actions: [
      {
        action: 'cabinet.create',
        target: { roomName: '主卧' },
        params: { name: '衣柜', width: 1800, height: 2400, depth: 600, cabinetType: 'tall' },
      },
      {
        action: 'cabinet.addUnit',
        target: { cabinetName: '衣柜' },
        params: { kind: 'hanging', requestedWidth: 900, nickname: '挂衣区', rodHeight: 1800 },
      },
      {
        action: 'cabinet.addUnit',
        target: { cabinetName: '衣柜' },
        params: { kind: 'shelves', requestedWidth: 900, nickname: '层板格', count: 3 },
      },
    ],
  },
  {
    recipe: 'base-cabinet-row',
    title: '做一排地柜并成组',
    keywords: ['地柜', '一排', '灶台', '台面', '吊柜', '一组', '厨房', '橱柜'],
    says: '厨房做一排地柜，三组，每组 600 宽，灶台那组中间空出来放灶',
    actions: [
      {
        action: 'cabinet.create',
        target: { roomName: '厨房' },
        params: { name: '地柜1', width: 600, height: 800, depth: 600, cabinetType: 'base', bodyLift: 100 },
      },
      {
        action: 'cabinet.create',
        target: { roomName: '厨房' },
        params: { name: '地柜2', width: 600, height: 800, depth: 600, cabinetType: 'base', bodyLift: 100 },
      },
      {
        action: 'cabinet.create',
        target: { roomName: '厨房' },
        params: { name: '地柜3', width: 600, height: 800, depth: 600, cabinetType: 'base', bodyLift: 100 },
      },
      {
        action: 'assembly.create',
        target: {},
        params: { name: '厨房地柜组', memberIds: ['地柜1', '地柜2', '地柜3'] },
      },
    ],
  },
  {
    // ★★ 「信息不足时**该问**」的范例 —— 规则 7 的核心。
    //
    //   为什么必须有它 ──
    //   我第一版范例**全是「照着做」**。结果「给我来个衣柜」（没给尺寸）
    //   这条**该追问**的用例开始不稳定 ——
    //   范例清一色在示范「做」，模型就倾向于**不追问**。
    //   ⇒ 范例必须**两种都有**：做，和问。
    recipe: 'single-cabinet',
    title: '信息不足时先问',
    // ★ 「**没给尺寸**」的线索：句子里**没有**尺寸词。
    keywords: ['来个', '做个', '来一个', '建个', '搞个', '来只'],
    notKeywords: ['宽', '米', '高', '深', '毫米'],
    requireAll: false,
    says: '给我来个衣柜',
    actions: [],
    reply: '衣柜要做多宽、多高、多深？给我这三个数我就建。',
    note: '缺关键尺寸就问，**不要自己挑一个**',
  },
  {
    recipe: 'appliance-bay',
    title: '留电器位',
    keywords: ['洗衣机', '冰箱', '电器', '灶具', '烤箱', '洗碗机', '留个洞', '预留', '嵌'],
    says: '洗衣机那格留个洞，600 宽 850 高，下面还得能开门',
    actions: [
      {
        action: 'cabinet.addUnit',
        target: { cabinetName: '主卧衣柜' },
        params: {
          kind: 'appliance',
          requestedWidth: 600,
          nickname: '洗衣机位',
          applianceName: '洗衣机',
          openingWidth: 600,
          openingHeight: 850,
        },
      },
    ],
  },
];

/**
 * 取某个配方的样例。
 * @param {string} recipeId 配方 id
 * @returns {object|null}
 */
/**
 * 按**用户原话**挑范例。
 *
 * ★ 为什么不用「按配方挑」──
 *   配方是按**家具类型**命中的（「衣柜」「地柜」），
 *   而范例要覆盖的是**说话方式**（「给我来个衣柜」vs「1800 宽的衣柜」）。
 *   两者不是一回事 —— 用配方挑的话，
 *   「给我来个衣柜」命中 wardrobe 配方，就只会拿到「带尺寸」那个范例，
 *   而「缺尺寸该追问」那个范例永远轮不上。
 *
 * @param {string} text 用户原话
 * @param {number} [max=1] 最多几个范例
 * @returns {Array<object>}
 */
export function matchExamples(text, max = 1) {
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return [];
  const hits = [];
  for (const ex of RECIPE_EXAMPLES) {
    const kws = ex.keywords ?? [];
    // ★ notKeywords：命中就**排除** ——
    //   「把柜子改宽点」含「宽」但它是**改尺寸**，不该拿到「建柜」范例。
    const banned = (ex.notKeywords ?? []).some((k) => hay.includes(String(k).toLowerCase()));
    if (banned) continue;
    const score = kws.reduce((n, k) => n + (hay.includes(String(k).toLowerCase()) ? 1 : 0), 0);
    if (score > 0) hits.push({ ex, score });
  }
  if (hits.length === 0) return [];
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, max).map((h) => h.ex);
}

/**
 * 取某个配方的样例（保留：按配方查的旧接口）。
 * @param {string} recipeId 配方 id
 * @returns {object|null}
 */
export function exampleFor(recipeId) {
  return RECIPE_EXAMPLES.find((e) => e.recipe === recipeId) ?? null;
}
/**
 * 样例自检：每个样例的动作都必须**过契约校验**。
 *
 * ── 为什么必须自动检查 ──
 *   手写样例极易过期（我第一版 10 个样例里 4 个过不了校验）。
 *   契约改了而样例没改 ⇒ 模型照着错样例输出 ⇒ 越改越差。
 *   ⇒ 契约一改，这个检查就红，**逼着人一起改**。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.checkEnums] 是否校验枚举取值（默认 true）
 * @returns {{ok: boolean, errors: string[]}}
 */
export function checkExamples(opts = {}) {
  const errors = [];
  for (const ex of RECIPE_EXAMPLES) {
    if (!ex.says || !Array.isArray(ex.actions)) {
      errors.push('样例 ' + ex.recipe + ' 结构不对（需要 says + actions 数组）');
      continue;
    }
    // ★ actions 为空是**合法**的 —— 那是「信息不足，该追问」的范例。
    //   但必须有 reply（要真问出那一句）。
    if (ex.actions.length === 0 && !ex.reply) {
      errors.push('样例 ' + ex.recipe + ' 是追问范例，必须带 reply');
      continue;
    }
    for (const a of ex.actions) {
      const r = validateAction(a);
      if (!r.ok) {
        errors.push('样例 ' + ex.recipe + ' 的 ' + a.action + ' 没过契约：' + r.error);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 把样例渲染成提示词文本。
 *
 * ★ 形态选择 ──
 *   用「用户这么说 → 输出这样」的形式（而不是只给动作序列），
 *   因为模型要学的是**从口语到动作的映射**，不是背动作列表。
 *
 * @param {string} text 用户原话（按它挑最贴的范例）
 * @param {object} [options]
 */
export function renderExamples(text, options = {}) {
  const max = Number.isFinite(options.max) ? options.max : 1;
  const picked = matchExamples(text, max);
  const lines = [];
  for (const ex of picked) {
    lines.push('');
    lines.push('● 范例（' + (ex.title ?? ex.recipe) + '）：');
    lines.push('  用户说：' + ex.says);
    lines.push('  这样输出：');
    lines.push('  ' + JSON.stringify({ reply: ex.reply ?? '（一句话说明）', actions: ex.actions }));
    if (ex.note) lines.push('  （' + ex.note + '）');
  }
  if (lines.length === 0) return '';
  return [
    '【范例】—— 下面是**真实的用户说法**和对应的动作，照这个形式产出：',
    ...lines,
  ].join('\n');
}
