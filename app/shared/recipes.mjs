/**
 * ══════════════════════════════════════════════════════════════════════
 *  标准配方库（Recipes）
 *
 *  ── 它要解决什么 ──
 *    Agent 笨的根因不是模型不行，而是**没人告诉它这类柜体该怎么走**。
 *    同一个 L 型厨房，模型每次都要从零摸索：先建几个地柜？几个吊柜？
 *    吊柜的 mountHeight 给多少？要不要调 create_assembly？分几组？
 *
 *  ── 事实依据（本次实测）──
 *    裁剪提示词后，建柜从 6 步 / 33.9s 降到 2 步 / 13.6s。
 *    提示词裁剪省的是**字数**，而告诉它怎么走省的是**步数**——
 *    步数直接等于模型往返次数，是耗时的主要来源。
 *
 *  ── 配方怎么被选中 ──
 *    按用户这句话的关键词命中（keywords 命中即入选）。
 *    命中多个配方时按 score 排序，只注入最靠前的几个（避免提示词膨胀）。
 *    一个配方都没命中 ⇒ 不注入任何东西（保持提示词短）。
 *
 *  ── 为什么放在独立模块 ──
 *    aiContract.mjs 已经 1900 行 / 114KB。配方是内容不是契约，
 *    单独成文件后：契约文件不膨胀、配方可以单独演进、验收可以单独引。
 *    本模块是**纯函数**（不读文件、不碰网络），三方都能引。
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 配方定义。
 *
 * 字段：
 *   id        稳定标识（用于序列复用时标记来源）
 *   title     标题（模型看到的第一行）
 *   keywords  命中关键词（用户原话里出现即命中；大小写不敏感）
 *   weight    权重：命中数相同时按权重排（越大越靠前）
 *   steps     分步做法（模型照着走）
 *   traps     常见坑（模型容易做错的地方）
 */
export const RECIPES = [
  {
    id: 'kitchen-L',
    title: 'L 型厨房',
    keywords: ['l型', 'l 型', '转角厨房', 'l形', 'l 形', '厨房', '灶台', '水槽柜', '洗碗机'],
    weight: 10,
    steps: [
      '1. 先确认房间已存在；没有就 cad.create_room（只给 name 与 w、h）。',
      '2. 沿一面墙建 3~4 个**独立地柜模块**（每个 600 宽左右），不建整排大柜。',
      '3. 在转角那一面再建 2~3 个地柜模块。',
      '4. 吊柜：与对应地柜**同一个 x 起点**，mountHeight=1500，深度 350 左右。',
      '5. cad.create_assembly 把地柜排成一组、吊柜排成另一组（分两排，不是一组）。',
      '6. cad.validate 确认 0 错误。',
    ],
    traps: [
      '不要逐扇门单独建柜 —— 门是分区属性，不是柜体。',
      '地柜和吊柜要**分别**成组，不要塞进同一个 assembly。',
      '不要合并地柜与吊柜的尺寸，组合不改变任何柜体的外形。',
    ],
  },
  {
    id: 'kitchen-straight',
    title: '一字型厨房',
    keywords: ['一字', '一字型', '直线厨房'],
    weight: 8,
    steps: [
      '1. 沿一面墙建 3~5 个独立地柜模块。',
      '2. 上方建吊柜，mountHeight=1500。',
      '3. cad.create_assembly 分地柜排 / 吊柜排两组。',
    ],
    traps: ['不要把整排做成一个超大柜体。'],
  },
  {
    id: 'wardrobe',
    title: '衣柜',
    keywords: ['衣柜', '衣橱', '卧室柜', '挂衣', '储物柜'],
    weight: 9,
    steps: [
      '1. 建柜体：width 按用户给的净宽，height 通常 2400，depth 600。',
      '2. 用 cabinet.addUnit 分区：上格（放被子）+ 挂衣区（rod）+ 底部叠放区。',
      '3. 挂衣区用 kind=hanging，rod.heightFromBottom 约 1500。',
      '4. 门用 cabinet.update_object 设 doors.count。',
      '5. 门板开向由用户说向左/向右开决定；没提就按右开。',
    ],
    traps: [
      '不要为每扇门各建一个柜体 —— 门是柜体的分区属性。',
      '挂衣区记得给 rod，否则内部结构图里没有衣架。',
    ],
  },
  {
    id: 'base-cabinet-row',
    title: '一排地柜',
    keywords: ['地柜', '地柜排', '灶柜', '碗柜', '储物地柜'],
    weight: 7,
    steps: [
      '1. 每个模块单独建（600 宽、height 800、depth 600、bodyLift 100）。',
      '2. 每个模块建在自己的位置上，x 逐个递增，不要都叠在原点。',
      '3. 全部建完再 cad.create_assembly 组成一组。',
    ],
    traps: ['先成组再补柜会漏关联；顺序是先建完，再成组。'],
  },
  {
    id: 'wall-cabinet-row',
    title: '一排吊柜',
    keywords: ['吊柜', '吊柜排', '壁柜'],
    weight: 7,
    steps: [
      '1. 每个模块单独建，mountHeight=1500，depth 350，height 700~800。',
      '2. 吊柜的 x 要与对应地柜对齐（不传 x 时系统会自动对齐正上方）。',
      '3. 全部建完再 cad.create_assembly 组成一组。',
    ],
    traps: ['吊柜的 mountHeight 必须是正数（>0），否则会落地变成地柜。'],
  },
  {
    id: 'appliance-bay',
    title: '电器位（洗衣机 / 冰箱 / 洗碗机）',
    keywords: ['洗衣机', '冰箱', '洗碗机', '烘干机', '电器位', '嵌入电器'],
    weight: 9,
    steps: [
      '1. **先查项目里已有的电器位**：电器位通常已经作为独立柜体存在，别重复建。',
      '2. 用户要在旁边加个柜子时，用 cabinet.addUnit 在**已有柜体**上加分区，不要新建柜。',
      '3. 真要新建电器位：建柜时留出开口，unit.kind 设为 appliance。',
    ],
    traps: [
      '电器位外面**不应该**再包一层柜体 —— 参考图纸里冰箱/洗衣机是直接露在外面的。',
      '不要用普通地柜顶替电器位，电器有独立开口尺寸。',
    ],
  },
  {
    id: 'tv-console',
    title: '电视柜 / 餐边柜',
    keywords: ['电视柜', '餐边柜', '矮柜', '边柜', '玄关柜'],
    weight: 6,
    steps: [
      '1. 建柜体：height 通常 450~600（矮柜），depth 400~450。',
      '2. 分区：抽屉区（kind=drawers）+ 开放格。',
      '3. 抽屉用 drawers.count，不是层板。',
    ],
    traps: ['矮柜 height 超过 1200 会被当成高柜，内部图会画错。'],
  },
  {
    id: 'bookshelf',
    title: '书架',
    keywords: ['书架', '书柜', '书柜墙'],
    weight: 6,
    steps: [
      '1. 建柜体，height 通常 2000~2400。',
      '2. 用 shelves.count 一次给多个层板，比逐个 addUnit 省几步。',
      '3. 全部建完调 cad.validate 确认 0 错误。',
    ],
    traps: ['格子数很多时不要循环调 addUnit —— 一次给 count 更省步数。'],
  },
  {
    id: 'single-cabinet',
    title: '单个柜体（通用）',
    keywords: ['柜子', '柜体', '做个', '来一个'],
    /**
     * 泛用配方：只有在明确要**新建**时才注入。
     * 「把柜子改宽点」也命中「柜子」，但那是改不是建。
     */
    generic: true,
    weight: 3,
    steps: [
      '1. cabinet.create 创建柜体（给 width / height / depth）。',
      '2. 需要分区就 addUnit；不需要就跳过。',
      '3. cad.validate 确认 0 错误。',
    ],
    traps: ['用户没给尺寸且意图是方向性的，先确认目标而不是瞎猜。'],
  },
];

/**
 * ── 「泛用配方」用显式标记，不用子串启发式 ──
 *
 * ★ 之前用 STOP_HINTS 做**子串**判断（关键词里含「柜」就算泛词）──
 *   结果「电视柜」被误判成泛词：
 *   tv-console 的关键词是 [电视柜/餐边柜/矮柜/边柜/玄关柜]，
 *   每个都含「柜」⇒ every() 为真 ⇒ 被降权 ⇒ 命中不了 tv-console。
 *   子串启发式在这里是错的：「电视柜」是**具体**柜型，「柜子」才是泛词。
 *
 *   现在改成配方自己声明 generic:true，判据一目了然，也不会误伤。
 */

/**
 * 触发「建」这类动作的词 —— 只有出现这些词，泛用配方才允许被注入。
 *
 * ★ 为什么需要这个 ──
 *   single-cabinet 的关键词全是泛词（柜子/柜体/做个/来一个），
 *   任何提到「柜」的话都会命中它 —— 包括「把柜子**改宽点**」。
 *   而「建单个柜体」的做法对「改尺寸」完全没用，
 *   反而会让模型去重新建一个柜子。
 *
 *   所以泛用配方额外要求：这句话里必须有「建/做/来/加/搭」这类**创建**语义。
 */
const BUILD_HINTS = ['建', '做', '来个', '来一个', '来只', '加个', '加一', '新增', '搭', '弄个', '整一个', '要一个', '要个', '再来一个', '再来个', '整排', '一排'];

/**
 * 这句话是不是在要求「新建一个」。
 * @param {string} hay 小写用户原话
 * @returns {boolean}
 */
function isBuildIntent(hay) {
  for (const b of BUILD_HINTS) {
    if (hay.includes(b)) return true;
  }
  return false;
}

/**
 * 给一个配方打分。
 *
 * @param {object} recipe 配方
 * @param {string} hay 用户原话（小写）
 * @returns {number} 0 = 未命中
 */
function scoreRecipe(recipe, hay) {
  let score = 0;
  for (const kw of recipe.keywords) {
    if (hay.includes(kw)) {
      // 越长的关键词越具体，分越高
      score += Math.max(1, Math.min(kw.length, 6));
    }
  }
  if (score === 0) return 0;
  // 只命中停用词的配方（泛词）降权，避免做个柜子把整个配方库都拽进来
  /**
   * 泛用配方（generic:true）只在**明确要新建**时才注入。
   *
   * 「把柜子改宽点」命中了「柜子」这个泛词，但那是**改**不是**建** ——
   * 注入建柜做法会让模型去重新建一个柜子，而不是改现有的。
   */
  if (recipe.generic === true && !isBuildIntent(hay)) return 0;
  // 泛用配方排在具体配方**后面**：「来一个书架」该用 bookshelf，不是 single-cabinet
  if (recipe.generic === true) score *= 0.6;
  return score + (recipe.weight ?? 0) * 0.1;
}

/**
 * 按用户这句话挑出要注入的配方。
 *
 * @param {string} text 用户原话
 * @param {object} [options]
 * @param {number} [options.max=2] 最多注入几个配方
 * @returns {Array<{id:string,title:string,steps:string[],traps:string[]}>}
 */
export function matchRecipes(text, options = {}) {
  const max = Number.isFinite(options.max) ? options.max : 2;
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return [];
  const scored = [];
  for (const recipe of RECIPES) {
    const score = scoreRecipe(recipe, hay);
    if (score > 0) scored.push({ recipe, score });
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map(({ recipe }) => ({
    id: recipe.id,
    title: recipe.title,
    steps: recipe.steps,
    traps: recipe.traps,
  }));
}

/**
 * 把配方渲染成提示词文本。
 *
 * @param {Array} matched matchRecipes 的结果
 * @returns {string} 没有配方时返回空串
 */
export function renderRecipes(matched) {
  if (!Array.isArray(matched) || matched.length === 0) return '';
  const lines = [];
  lines.push('【标准做法】');
  lines.push('这类需求的成熟做法如下，照着走可以少走弯路、少调几次工具：');
  for (const m of matched) {
    lines.push('');
    lines.push('■ ' + m.title + '：');
    for (const s of m.steps) lines.push('  ' + s);
    if (m.traps && m.traps.length > 0) {
      lines.push('  常见坑：');
      for (const t of m.traps) lines.push('  ✗ ' + t);
    }
  }
  lines.push('');
  lines.push('（以上是做法建议，不是硬性限制；如果用户的要求与做法冲突，以用户为准。）');
  return lines.join('\n');
}

/**
 * 一步到位：挑配方 + 渲染。
 *
 * @param {string} text 用户原话
 * @param {object} [options] 同 matchRecipes
 * @returns {string} 提示词文本（无命中则空串）
 */
export function recipeBlockFor(text, options = {}) {
  return renderRecipes(matchRecipes(text, options));
}