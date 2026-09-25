/**
 * ══════════════════════════════════════════════════════════════════════
 *  AI 动作契约 —— 「AI 到底被允许做什么」的唯一权威定义
 *
 *  为什么必须独占一个文件、且是**纯 JS**：
 *    这份契约要被三方同时使用，任何一方各写一份都会漂移：
 *      · 本地服务 server/server.mjs   —— 在 AI 输出进入系统的地方先拦一道
 *      · 前端 src/ai/compile.ts       —— 把动作编译成 Command（唯一写入口）
 *      · 验收 verify/ai-acceptance.ts —— 断言"清单里每一条都有编译器"、反之亦然
 *    服务是 .mjs（Node 直接跑），前端是 .ts（Vite 编译），所以只有纯 ESM JS
 *    能被两边同时 import。JSON 不行 —— Node 22 的 `import ... with { type: 'json' }`
 *    在本机是报错的（ImportAttributes），而不用 with 又拿不到 JSON 模块。
 *
 *  ── 三层防线，AI 想越权要连破三关 ──
 *    第一层（本文件 · 词汇表）：AI 只能从**有限动作清单**里挑一个名字 + 参数。
 *      它根本没有机会输出路径。没有 `set(path, value)` 这种东西。
 *    第二层（本文件 · 校验器）：参数只能落在声明的名字上，多一个键就整条丢掉；
 *      数值必须在闭区间内；枚举必须在册。AI 想塞 `panels` / `derived` 进参数里
 *      会在这一层被识别为"未知参数"而拒收。
 *    第三层（CommandBus）：动作编译出的 Command 仍要过 `isWritablePath` 白名单。
 *      这一层不认识"AI"，它一视同仁地拒绝一切写派生字段的尝试。
 *
 *  ── 铁律（写在最前面，改这个文件的人先读）──
 *    1. **几何永不来自 AI**。这里没有任何一个动作接受坐标数组、板件清单、
 *       图元。AI 能给的只有**语义参数**（宽 / 高 / 深 / 数量 / 材质 id / 分区间隔）。
 *    2. **规则集对 AI 只读**。没有 `rules.*` 动作。换工厂 = 换规则文件，不是让 AI 改。
 *    3. **不新增"删除项目"类动作**。AI 可以建议，不能执行不可逆的破坏。
 *    4. 动作名必须能在 `src/ai/compile.ts` 找到实现，且**一一对应** ——
 *       这条由 verify/ai-acceptance.ts 常驻断言，防止两边漂移。
 * ══════════════════════════════════════════════════════════════════════
 */

export const CONTRACT_VERSION = '1.0.0';

/** 一次规划最多接受多少条动作 —— 防止模型"顺手把整套房子重排" */
export const MAX_ACTIONS = 12;
/** 单条 reason 文案上限（会显示在界面上） */
export const MAX_REASON = 200;
/** 单条自由文本参数上限 */
export const MAX_STRING = 60;

/**
 * 枚举值来源标记。放在契约里的是**语义**（"这是材质 id"），
 * 真正的取值在运行时从规则集读 —— 契约是静态的，规则集是可换的。
 */
export const ENUM_SOURCES = ['rules.materials.body', 'rules.materials.back', 'units.kind'];

/**
 * `cabinet.setUnitParam` 里 `value` 的取值区间 —— 按 `param` 分别限定。
 *
 * 为什么要单独一张表：`value` 是个数字，但"抽屉数"和"挂衣杆高度"的合法区间
 * 完全不同。声明在 `params.value` 上只能给一个统一区间，那要么太松（放行 3000 只抽屉），
 * 要么太紧（把 1800mm 的杆高卡掉）。
 *
 * 与 PropertiesPanel 里的 min/max 是**同一套数**：那张表是给人用的旋钮范围，
 * 这张表是给 AI 用的同一把尺子。改一处必须改另一处 —— 由
 * verify/ai-acceptance.ts 的 D 组断言两边一致，不允许它们各说各话。
 */
export const UNIT_PARAM_RANGES = {
  'drawers.count': { min: 0, max: 10, integer: true, family: 'drawers' },
  'drawers.runnerLength': { min: 200, max: 600, integer: true, family: 'drawers' },
  'shelves.count': { min: 0, max: 12, integer: true, family: 'shelves' },
  'doors.count': { min: 0, max: 6, integer: true, family: 'doors' },
  'doors.gapMid': { min: 0, max: 20, integer: false, family: 'doors' },
  'doors.gapOuter': { min: 0, max: 20, integer: false, family: 'doors' },
  'rod.heightFromBottom': { min: 0, max: 3000, integer: true, family: 'rod' },
};

/**
 * ══════════════════════════════════════════════════════════════════
 *  「形体组合」说明 —— 提示词里紧跟动作清单之后的那一段
 *
 *  ── 这段为什么必须存在 ──
 *    用户 complained：说了一句「长 2200、台面宽 750、高 1000、另一边 1200
 *    的 L 形新橱柜」，AI 回的是「需要两个柜体配合，但目前我只能创建单个柜体，
 *    无法直接生成 L 形结构。请问你希望把这两个柜体分别放到哪个房间里？」。
 *
 *    那段话**不是代码里的固定文案**（全仓库 grep 无匹配），是模型自己说出口的。
 *    根因也不在模型能力，在**提示词漏了一段信息**：
 *      · 动作清单里确实没有 `cabinet.createLShape` 这样的名字 —— 柜体永远是矩形；
 *      · 但提示词只把 17 个动作**一个个列出来**，从来没说过"它们能拼"；
 *      · 于是模型做了一次看起来很合理的归纳：清单里没有 → 系统做不到。
 *    它甚至没意识到 `cabinet.rotate` 存在 —— 那条动作就在它的正上方。
 *
 *    「列清单」这种生成方式有个盲区：把能力**枚举**出来，不等于把能力的
 *    **用法**说清楚。现实中没人会因为菜单上没有"合股"就断言餐厅只会炒单体菜。
 *
 *  ── 所以这里把组合规则写死：L 形 / U 形 / 转角 = 多个柜体 + rotate ──
 *    这与 `core/rules/corner.ts` 是同一套口径 —— 那份转角干涉校验就是为
 *    "两臂背靠两条垂直墙"写的。也就是说系统**一直支持** L 形，
 *    只是没人告诉 AI。
 *
 *  ⚠ 改这段的人注意：这是给模型看的说明书，不是注释。每个字都要能被
 *    模型直接执行；同时 verify/ai-generate-acceptance.ts 会断言它
 *    **确实出现在生成的提示词里**，改了就得跟着改断言。
 * ══════════════════════════════════════════════════════════════════
 */
export const COMPOSITION_GUIDE = `
【形体怎么组合】—— 动作清单里没有"L 形 / 转角 / U 形"这类名字，不等于系统做不到。
柜体本身永远是矩形；**拐弯的形体一律用多个柜体拼出来**：
  · L 形 / 转角：两条臂 = 两次 cabinet.create（分别给 2200 和 1200 的 width），
    **第二条一定要在 cabinet.create 里就给 rotation**（90 / 180 / 270，取哪一个是
    为了让两臂共用角点），并且给 atX / atY 让两臂的角点对齐。
    千万不要"先 create 一条臂、再配一条 cabinet.rotate 转它"—— 中间态是没转的
    那个朝向，位置多半当场撞墙，会被严格模式整条拒掉，界面上只剩一句"嵌进了墙体
    1390mm"，看上去就像系统不支持转角。
  · U 形 / 三面围合：create 三次 + 必要的 rotation，臂与臂之间按用户说的间隙留（没说就 0，拼严）。
  · 反过来，一条**长柜内部的**"左三段抽屉、右两组对开门"是**一个**柜体的 units 分区，
    不是多个柜体 —— 别把柜内分区当成多个柜来建。
  · 落位拿不准就省略 atX / atY：系统会自动找个放得下的位置。拼歪了、拼重叠了都不要紧，
    两段式执行会先在预览里画出来，用户自己会纠偏 —— **你不需要先问落位**。
`;

/**
 * 动作词汇表。
 *
 * `params` 里的 `type`：
 *   number —— 必带 min / max（合理性区间，**不是**工艺门；工艺门在规则集里）
 *   enum   —— 必带 from（ENUM_SOURCES 之一），或直接给 values
 *   string —— 自由文本，必带 max
 * `atLeastOne` —— 至少要出现其中一个参数（例如 resize 至少给一个尺寸）
 * `detail` —— 会写进 prompt 的补充说明，用来减少模型的猜测
 */
/**
 * ── 分区意图：让 AI 有本事"照一句话描述搭出一个柜子" ──
 *
 * 为什么必须有这个口子：
 *   `cabinet.create` 缺省生成 2:4:2 的三分区柜。用户说"左边三个抽屉、右边
 *   两组对开门"时，AI 只能**先建后拆** —— removeUnit 掉那三个默认分区
 *   （破坏性动作，还得写理由），再逐个 addUnit。一次上限 12 条动作根本不够，
 *   而"先按默认建出来再拆掉"这种绕路，本质上是逼模型去猜系统的内部默认值。
 *
 * 为什么它不违反「几何永不来自 AI」：
 *   每一项只有 kind（类型）/ width（期望宽 mm）/ count（数量）/ rodHeight /
 *   doorCount / nickname —— **全是语义意图**，没有坐标、没有板件清单、没有图元。
 *   真正的板件由 makeUnit + 参数化生成器推导，与既有柜型模板走**同一个构造点**。
 *
 * 为什么 width 是"期望值"而不是必须加总等于柜宽：
 *   layout.widthMode = fit_total 下柜宽是硬约束，分区净宽按比例摊
 *   （见 core/allocate.ts 的 allocateWidths，它连取整余量都按小数部分补齐，
 *   保证 Σ 精确）。让 AI 去做加法没有任何好处，只会制造"差 1mm"的机会。
 */
export const UNIT_INTENT_MAX = 8;

export const UNIT_INTENT_ITEM = {
  kind: { type: 'enum', from: 'units.kind' },
  width: { type: 'number', min: 50, max: 4000, unit: 'mm' },
  count: { type: 'number', min: 1, max: 12 },
  rodHeight: { type: 'number', min: 0, max: 3000, unit: 'mm' },
  doorCount: { type: 'number', min: 0, max: 6 },
  nickname: { type: 'string', max: MAX_STRING },
  // ── 电器格（洗衣机柜等）："预留洞口 + 上下分体" ──
  applianceName: { type: 'string', max: 20 },
  openingWidth: { type: 'number', min: 200, max: 2000, unit: 'mm' },
  openingHeight: { type: 'number', min: 200, max: 3000, unit: 'mm' },
  openingDepth: { type: 'number', min: 200, max: 1200, unit: 'mm' },
  topDrawers: { type: 'number', min: 0, max: 6 },
};

export const UNIT_INTENT_DOC = {
  type: 'unitIntents',
  item: UNIT_INTENT_ITEM,
  max: UNIT_INTENT_MAX,
  desc: `柜体内部结构（从左到右），最多 ${UNIT_INTENT_MAX} 个分区。省略 = 用系统默认三分区`,
};

export const ACTIONS = {
  // ───────── 柜体：外形 ─────────
  'cabinet.resize': {
    label: '改柜体外形尺寸',
    target: 'cabinet',
    params: {
      width: { type: 'number', min: 300, max: 6000, unit: 'mm', desc: '柜体总宽' },
      height: { type: 'number', min: 300, max: 4000, unit: 'mm', desc: '柜体总高' },
      depth: { type: 'number', min: 200, max: 1200, unit: 'mm', desc: '柜体总深（含门）' },
    },
    atLeastOne: ['width', 'height', 'depth'],
    detail: '只给要改的那个尺寸。分区净宽会按柜体 layout.widthMode 自动重算，不要同时给分区宽。',
  },
  'cabinet.setBodyLift': {
    label: '改踢脚高',
    target: 'cabinet',
    params: { mm: { type: 'number', min: 0, max: 300, unit: 'mm', desc: '脚线高度；0 = 落地无脚' } },
    required: ['mm'],
  },
  'cabinet.setWidthMode': {
    label: '切换柜体宽度约束方式',
    target: 'cabinet',
    params: {
      mode: {
        type: 'enum',
        values: ['fit_total', 'fit_units'],
        desc: 'fit_total = 总宽是硬约束、分区按请求比例分配（默认）；fit_units = 各分区净宽是硬约束、总宽随之变化',
      },
    },
    required: ['mode'],
  },
  'cabinet.rename': {
    label: '重命名柜体',
    target: 'cabinet',
    params: { name: { type: 'string', max: MAX_STRING } },
    required: ['name'],
  },

  // ───────── 柜体：位置 ─────────
  'cabinet.move': {
    label: '把柜体移到绝对坐标',
    target: 'cabinet',
    params: {
      x: { type: 'number', min: -50000, max: 50000, unit: 'mm', desc: '房间坐标 X（柜背左角）' },
      y: { type: 'number', min: -50000, max: 50000, unit: 'mm', desc: '房间坐标 Y（柜背左角）' },
    },
    atLeastOne: ['x', 'y'],
    detail: '绝对坐标，不是位移。想"往右挪 200"请用 cabinet.nudge。',
  },
  'cabinet.nudge': {
    label: '柜体相对位移',
    target: 'cabinet',
    params: {
      dx: { type: 'number', min: -50000, max: 50000, unit: 'mm', desc: 'X 向位移，正 = 向右' },
      dy: { type: 'number', min: -50000, max: 50000, unit: 'mm', desc: 'Y 向位移，正 = 向前' },
    },
    atLeastOne: ['dx', 'dy'],
    detail: '用户说"往左挪 200 / 靠墙 / 贴住左边"时用这个。',
  },
  'cabinet.rotate': {
    label: '逆时针旋转柜体',
    target: 'cabinet',
    params: { deg: { type: 'enum', values: [0, 90, 180, 270], desc: '绕柜背左角的逆时针角度' } },
    required: ['deg'],
  },

  // ───────── 柜体：分区 ─────────
  'cabinet.setUnitWidth': {
    label: '改分区净宽',
    target: 'cabinet',
    targetUnit: true,
    params: {
      width: { type: 'number', min: 100, max: 4000, unit: 'mm', desc: '该分区净宽（内空宽）' },
    },
    required: ['width'],
    detail: '若柜体是 fit_total，改分区宽只在"各分区请求比例"的意义上生效 —— 请在 reason 里说明这一点。',
  },
  'cabinet.setUnitParam': {
    label: '改分区内的功能参数',
    target: 'cabinet',
    targetUnit: true,
    params: {
      param: {
        type: 'enum',
        values: Object.keys(UNIT_PARAM_RANGES),
        desc: 'drawers.* 抽屉数/滑轨长；shelves.count 层板数；doors.* 门扇数与缝隙；rod.heightFromBottom 挂衣杆离柜内底高度',
      },
      value: { type: 'number', min: 0, max: 3000, desc: '数值，实际区间由 param 决定（见 UNIT_PARAM_RANGES）' },
    },
    required: ['param', 'value'],
    detail: '只能改该分区**已经具备**的功能。分区没有 drawers 就不能设抽屉数 —— 想加功能请用 cabinet.addUnit。',
  },
  'cabinet.renameUnit': {
    label: '重命名分区',
    target: 'cabinet',
    targetUnit: true,
    params: { nickname: { type: 'string', max: MAX_STRING } },
    required: ['nickname'],
  },
  'cabinet.addUnit': {
    label: '新增一个分区',
    target: 'cabinet',
    params: {
      kind: { type: 'enum', from: 'units.kind', desc: 'drawerBank 抽屉区 / hanging 挂衣区 / shelves 层板区 / open 空区 / appliance 电器格（洗衣机位）' },
      requestedWidth: { type: 'number', min: 100, max: 4000, unit: 'mm', desc: '请求净宽' },
      nickname: { type: 'string', max: MAX_STRING, optional: true },
      count: { type: 'number', min: 1, max: 12, desc: '该分区的抽屉数 / 层板数（按 kind 解释）' },
      rodHeight: { type: 'number', min: 0, max: 3000, unit: 'mm', desc: '仅 hanging：挂衣杆离柜内底高度' },
      doorCount: { type: 'number', min: 0, max: 6, desc: '要不要门、几扇：0 = 开放格，2 = 对开门。不给就是不做门' },
      applianceName: { type: 'string', max: 20, desc: '仅 appliance：电器名（洗衣机/烘干机…）' },
      openingWidth: { type: 'number', min: 200, max: 2000, unit: 'mm', desc: '仅 appliance：洞口净空宽（机器尺寸+安装余量）' },
      openingHeight: { type: 'number', min: 200, max: 3000, unit: 'mm', desc: '仅 appliance：洞口净空高' },
      openingDepth: { type: 'number', min: 200, max: 1200, unit: 'mm', desc: '仅 appliance：洞口净空深' },
      topDrawers: { type: 'number', min: 0, max: 6, desc: '仅 appliance：洞口上面的抽屉数（上下分体），0 = 开放' },
    },
    required: ['kind', 'requestedWidth'],
    detail: '新增分区会改变柜体总宽分配。kind=shelves/drawerBank 时 count 表示层板/抽屉数量；kind=hanging 时给 rodHeight；kind=appliance 时给洞口三尺寸 + topDrawers。想要"带门的格子"要显式给 doorCount，否则建出来是开放格。',
  },
  'cabinet.removeUnit': {
    label: '删除一个分区',
    target: 'cabinet',
    targetUnit: true,
    params: {},
    dangerous: true,
    detail: '柜体至少保留一个分区。删除分区是**破坏性**的（该分区的层板/抽屉/门会一起消失），必须在 reason 里说明。',
  },

  // ───────── 柜体：材质 ─────────
  'cabinet.setBoardMaterial': {
    label: '改柜体板材质',
    target: 'cabinet',
    params: { materialId: { type: 'enum', from: 'rules.materials.body', desc: '材质 id，只能选 snapshot.materials 里 canBeBodyBoard 的那些' } },
    required: ['materialId'],
  },
  'cabinet.setBackMaterial': {
    label: '改背板材质',
    target: 'cabinet',
    params: { materialId: { type: 'enum', from: 'rules.materials.back', desc: '材质 id，只能选 snapshot.materials 里 canBeBack 的那些' } },
    required: ['materialId'],
  },

  // ───────── 柜体：增删 ─────────
  'cabinet.create': {
    label: '新建一个柜体',
    target: 'project',
    params: {
      name: { type: 'string', max: MAX_STRING },
      width: { type: 'number', min: 300, max: 6000, unit: 'mm' },
      height: { type: 'number', min: 300, max: 4000, unit: 'mm' },
      depth: { type: 'number', min: 200, max: 1200, unit: 'mm' },
      atX: { type: 'number', min: -50000, max: 50000, unit: 'mm', desc: '落位 X（省略 = 按房间内已有柜体自动排开）' },
      atY: { type: 'number', min: -50000, max: 50000, unit: 'mm', desc: '落位 Y' },
      /**
       * 落位朝向 —— 这条是"AI 能建 L 形 / 转角"的关键。
       *
       * 之前 `cabinet.create` 不带旋转，模型只能"先以 0° 建、再 cabinet.rotate"。
       * 而中间态是**没转的那个朝向**，位置多半就撞墙了，严格模式当场拒收
       * （实测报错："嵌进了墙体 1390mm"）—— 于是转角柜在动作层面**根本拼不出来**，
       * 模型也只能自称"无法生成 L 形"。
       *
       * 旋转角是**落位意图**（"这条臂朝哪边摆"），不是几何：它只决定 placement
       * 那三个数，板件仍然由参数化生成器推导。所以它是合法的动作参数，不是后门。
       */
      rotation: {
        type: 'enum',
        values: [0, 90, 180, 270],
        desc: '绕柜背左角的逆时针角度（0/90/180/270）。建转角柜的第二条臂时必须给，例如 90 或 270；省略 = 0（柜面朝 +Y）',
      },
      units: UNIT_INTENT_DOC,
      backUnits: { ...UNIT_INTENT_DOC, desc: '背面分区（从左到右）。给了就建**双面柜（岛台）**：前后两排背靠背、共用中板、没有背板。岛台/吧台这类两面临走的柜子才用' },
    },
    required: ['name'],
    detail:
      '未给尺寸时用规则集默认值。' +
      '**描述内部结构就给 units**（从左到右一列）：每项给 kind + width + 按需给 count(抽屉/层板数) / rodHeight(挂衣区) / doorCount(门扇数，0=开放格)。' +
      '**洗衣机柜/嵌入式电器用 kind:"appliance"**：给 openingWidth / openingHeight / openingDepth（要留的洞口净空 = 机器尺寸 + 安装余量）和 topDrawers（洞口上面的抽屉数，0 = 洞口以上开放）。' +
      '**岛台给 backUnits**（背面分区，结构同 units），不给 backUnits 就是普通单面柜。' +
      'width 是**期望值**，总和不必等于柜宽 —— 系统按比例摊到总宽上，不要自己去做加法。' +
      '没给 units 时才会用默认三分区：不要先 create 再 removeUnit 去拆它。' +
      '**转角柜的第二条臂必须在这里就给 rotation**（90 / 180 / 270），不要建完再配 cabinet.rotate —— ' +
      '中间态是没转的那个朝向，多半一建就撞墙被严格模式拒掉，那条报错会让人以为"系统不支持转角"。',
  },
  'cabinet.duplicate': {
    label: '复制一个柜体',
    target: 'cabinet',
    params: { offset: { type: 'number', min: 100, max: 5000, unit: 'mm', desc: '复制件相对原件在 X 向的偏移，默认 700' } },
  },
  'cabinet.delete': {
    label: '删除柜体',
    target: 'cabinet',
    params: {},
    dangerous: true,
    detail: '破坏性操作。只有在用户**明确**说"删掉 XX 柜"时才可以产生这条动作，绝不可推测。',
  },

  // ───────── 项目 ─────────
  'project.rename': {
    label: '重命名项目',
    target: 'project',
    params: { name: { type: 'string', max: MAX_STRING } },
    required: ['name'],
  },
};

export const ACTION_NAMES = Object.keys(ACTIONS);

/** 除 target/params/reason 之外，顶层还允许出现的键（白名单，不是黑名单） */
const TOP_KEYS = new Set(['action', 'target', 'params', 'reason']);
const TARGET_KEYS = new Set(['cabinetId', 'cabinetName', 'roomId', 'roomName', 'unit', 'part', 'scope']);

/**
 * 部件词汇表（闭合，Task #25 A3）—— 来自 core/geometry/pickLines.ts 的 CabinetPart。
 * AI 只允许用清单里的部件名指"图上那条线"；写别的一律整条拒收。
 */
export const PARTS = new Set([
  'outer.width',
  'outer.height',
  // Phase E 之后：侧视图/俯视图也能点选和拖动，必须有"这条线 = 柜深"这个词，
  // 否则界面就只能偷偷按坐标改 —— 那是第二个真相源的开头
  'outer.depth',
  'bodyLift',
  'unit.divider',
  'door.gapMid',
  'shelf.line',
  'drawer.divider',
]);

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * 校验（并归一化）单条动作。
 *
 * 设计原则：**白名单**。任何没在契约里声明过的东西 —— 未知动作、未知参数、
 * 未知顶层字段 —— 一律整条拒收，而不是"忽略掉不认识的部分继续"。
 * 静默忽略是最危险的行为：模型以为生效了，人以为生效了，实际没生效。
 *
 * @param raw 模型返回的一条动作（未经信任）
 * @param ctx { materials: string[], roomCount: number } —— 运行时上下文，
 *            用于校验那些取值来自规则集/项目的枚举（契约本身是静态的）
 * @returns { ok: true, action } | { ok: false, code, error }
 */
export function validateAction(raw, ctx = {}) {
  if (!isPlainObject(raw)) return { ok: false, code: 'NOT_OBJECT', error: '动作不是一个对象' };

  const extraTop = Object.keys(raw).filter((k) => !TOP_KEYS.has(k));
  if (extraTop.length > 0) {
    return { ok: false, code: 'EXTRA_TOP_KEY', error: `动作里出现了契约外的字段：${extraTop.join('、')}` };
  }

  const name = raw.action;
  if (typeof name !== 'string' || !name) return { ok: false, code: 'NO_ACTION', error: '缺少 action' };
  const spec = ACTIONS[name];
  if (!spec) return { ok: false, code: 'UNKNOWN_ACTION', error: `动作 "${name}" 不在契约里（AI 只允许做清单内的事）` };

  // ── target ──
  const target = {};
  if (raw.target !== undefined) {
    if (!isPlainObject(raw.target)) return { ok: false, code: 'BAD_TARGET', error: 'target 必须是对象' };
    const extraT = Object.keys(raw.target).filter((k) => !TARGET_KEYS.has(k));
    if (extraT.length > 0) return { ok: false, code: 'EXTRA_TARGET_KEY', error: `target 里出现契约外字段：${extraT.join('、')}` };
    for (const k of ['cabinetId', 'cabinetName', 'roomId', 'roomName']) {
      if (raw.target[k] !== undefined) {
        if (typeof raw.target[k] !== 'string' || raw.target[k].length > MAX_STRING) {
          return { ok: false, code: 'BAD_TARGET', error: `target.${k} 必须是 ${MAX_STRING} 字以内的字符串` };
        }
        target[k] = raw.target[k];
      }
    }
    if (raw.target.unit !== undefined) target.unit = raw.target.unit;
    if (raw.target.part !== undefined) {
      if (typeof raw.target.part !== 'string' || !PARTS.has(raw.target.part)) {
        return { ok: false, code: 'BAD_PART', error: `target.part "${String(raw.target.part)}" 不是合法部件（可用：${[...PARTS].join(' | ')}）` };
      }
      target.part = raw.target.part;
    }
    if (raw.target.scope !== undefined) {
      if (raw.target.scope !== 'selection') {
        return { ok: false, code: 'BAD_SCOPE', error: `target.scope 只允许 "selection"（圈选当前选中的柜体），收到 "${String(raw.target.scope)}"` };
      }
      target.scope = 'selection';
    }
    if (target.part !== undefined && target.scope === 'selection') {
      return { ok: false, code: 'PART_SCOPE_CLASH', error: 'part（点选某个柜体的某个部件）与 scope:"selection"（圈选一批柜体）只能二选一' };
    }
  }
  if (spec.target === 'cabinet' && !target.cabinetId && !target.cabinetName && target.scope !== 'selection') {
    return { ok: false, code: 'NO_CABINET', error: `动作 "${name}" 必须指明是哪个柜体（target.cabinetName 用柜体名字；或 target.scope="selection" 圈选当前选中的柜体）` };
  }
  /**
   * 分区引用归 target 而不是 params —— 这是个**口径问题**，不是风格问题：
   *   target 放"指向哪个已有对象"，params 放"要把它改成什么"。
   * 分区就是个已有对象（它自己还有昵称、功能）。混进 params 会在界面上
   * 表现成"分区"和"净宽"并列，让人以为是两件平行的事。
   */
  if (spec.targetUnit === true && target.unit === undefined) {
    return { ok: false, code: 'NO_UNIT', error: `动作 "${name}" 必须指明是哪个分区（target.unit：1 起序号或分区昵称）` };
  }

  // ── params ──
  const paramsRaw = raw.params === undefined ? {} : raw.params;
  if (!isPlainObject(paramsRaw)) return { ok: false, code: 'BAD_PARAMS', error: 'params 必须是对象' };
  const declared = spec.params ?? {};
  const extraP = Object.keys(paramsRaw).filter((k) => !(k in declared));
  if (extraP.length > 0) {
    return { ok: false, code: 'EXTRA_PARAM', error: `参数 ${extraP.join('、')} 不在 "${name}" 的声明里` };
  }
  const params = {};
  for (const [k, p] of Object.entries(declared)) {
    const v = paramsRaw[k];
    const optional = p.optional === true || !(spec.required ?? []).includes(k);
    if (v === undefined || v === null) {
      if (!optional) return { ok: false, code: 'MISSING_PARAM', error: `"${name}" 缺少必填参数 ${k}` };
      continue;
    }
    const bad = checkParam(name, k, p, v, ctx);
    if (bad) return { ok: false, code: 'BAD_PARAM', error: bad };
    params[k] = p.type === 'number' ? Math.round(v * 100) / 100 : v;
  }
  if (spec.atLeastOne && spec.atLeastOne.every((k) => params[k] === undefined)) {
    return { ok: false, code: 'MISSING_PARAM', error: `"${name}" 至少要给出 ${spec.atLeastOne.join(' / ')} 中的一个` };
  }
  // 纯白名单动作（params 声明为空）如果带了参数，已被 EXTRA_PARAM 拦掉

  // ── 跨参数校验：某个参数的含义由另一个参数决定 ──
  const cross = crossValidate(name, params);
  if (cross) return { ok: false, code: 'BAD_PARAM', error: cross };

  // ── reason ──
  let reason = '';
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== 'string') return { ok: false, code: 'BAD_REASON', error: 'reason 必须是字符串' };
    reason = raw.reason.slice(0, MAX_REASON);
  } else if (raw.reason === undefined) {
    // reason 可选，但缺省时不要编造 —— 留空由界面显示动作自带的中文标签
  }

  return { ok: true, action: { action: name, target, params, reason } };
}

function checkParam(actionName, key, p, v, ctx) {
  const where = `${actionName}.${key}`;
  switch (p.type) {
    case 'number': {
      if (!finite(v)) return `${where} 必须是数字（收到 ${JSON.stringify(v)}）`;
      if (p.min !== undefined && v < p.min) return `${where} = ${v} 小于下限 ${p.min}${p.unit ?? ''}`;
      if (p.max !== undefined && v > p.max) return `${where} = ${v} 超出上限 ${p.max}${p.unit ?? ''}`;
      return null;
    }
    case 'string': {
      if (typeof v !== 'string') return `${where} 必须是字符串`;
      if (!v.trim()) return `${where} 不能是空字符串`;
      if (p.max !== undefined && v.length > p.max) return `${where} 超过 ${p.max} 字`;
      return null;
    }
    case 'enum': {
      const allowed = p.values ?? enumFromSource(p.from, ctx);
      if (!allowed || allowed.length === 0) return `${where} 的可选值在本次上下文中为空（检查规则集/项目数据）`;
      if (!allowed.some((a) => same(a, v))) {
        return `${where} = ${JSON.stringify(v)} 不在允许值内（${allowed.slice(0, 12).join(' / ')}${allowed.length > 12 ? ' …' : ''}）`;
      }
      return null;
    }
    case 'unitRef': {
      if (finite(v)) return null; // 1 起的序号，具体范围由编译器按实际分区数判断
      if (typeof v === 'string' && v.trim() && v.length <= MAX_STRING) return null; // 昵称
      return `${where} 必须是数字序号（1 起）或分区昵称字符串`;
    }
    case 'roomRef': {
      if (finite(v) || (typeof v === 'string' && v.trim() && v.length <= MAX_STRING)) return null;
      return `${where} 必须是数字序号（1 起）或房间名`;
    }
    case 'unitIntents': {
      if (!Array.isArray(v)) return `${where} 必须是一个数组（每个分区一项，从左到右）`;
      if (v.length === 0) return `${where} 是空数组 —— 那就等于没说，删掉这个参数走默认分区`;
      if (p.max !== undefined && v.length > p.max) {
        return `${where} 给了 ${v.length} 个分区，最多 ${p.max} 个 —— 描述得太碎了，请把相邻的同类型格子合并`;
      }
      const item = p.item ?? {};
      for (let i = 0; i < v.length; i++) {
        const it = v[i];
        if (!isPlainObject(it)) return `${where} 第 ${i + 1} 项必须是一个对象`;
        for (const k of Object.keys(it)) {
          if (!(k in item)) {
            return `${where} 第 ${i + 1} 项里的 "${k}" 不是本系统认识的字段（只能用 ${Object.keys(item).join(' / ')}）`;
          }
        }
        for (const [k, sub] of Object.entries(item)) {
          if (it[k] === undefined) continue;
          const bad = checkParam(`${actionName}.units[${i + 1}]`, k, sub, it[k], ctx);
          if (bad) return bad;
        }
      }
      return null;
    }
    default:
      return `${where} 的类型 "${p.type}" 未实现校验 —— 契约里不许出现没人校验的参数类型`;
  }
}

function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return String(a) === String(b);
}

/**
 * 跨参数校验 —— 当某个参数的合法取值取决于另一个参数时，在这里一次性判定。
 *
 * 目前只有一处：`cabinet.setUnitParam` 的 `value` 区间由 `param` 决定。
 * 不做这一层的话，"把抽屉数设成 3000"会一路通过到 CommandBus ——
 * 那一层只认路径白名单，不认业务数量级。
 *
 * @returns 错误文案，或 null（通过）
 */
/**
 * 分区意图的**语义互斥**判定。
 *
 * 为什么要抽成一个导出函数，被【校验器】和【编译器】两处调用：
 *   校验器跑在服务端（AI 输出进门的地方），编译器跑在前端（planRunner 会
 *   直接编译已经"假定合规"的动作）。只在一边拦，另一条路就是敞的 ——
 *   实测过：`dryRunPlan` 拿到 `{kind:'hanging', count:2}` 时，
 *   因为没人做这一层，坏分区真的建出来了。
 *   同一条规矩只许有一份实现，不然迟早有一边失守。
 *
 * @returns 错误文案，或 null（通过）
 */
export function unitIntentsSemanticError(units) {
  if (!Array.isArray(units)) return null;
  const APPLIANCE_FIELDS = ['applianceName', 'openingWidth', 'openingHeight', 'openingDepth', 'topDrawers'];
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (!isPlainObject(u)) continue; // 结构问题由 checkParam 管，这里只看语义
    const nth = `units 第 ${i + 1} 个分区（${u.kind ?? '?'}）`;
    if (u.kind === 'hanging' && u.count !== undefined) {
      return `${nth} 给了 count，但挂衣区没有"数量"这个概念 —— 挂衣杆高度请用 rodHeight（离柜内底）`;
    }
    if (u.kind !== 'hanging' && u.rodHeight !== undefined) {
      return `${nth} 给了 rodHeight，但 ${u.kind} 区没有挂衣杆 —— rodHeight 只有挂衣区用得上`;
    }
    if (u.kind === 'open' && u.count !== undefined) {
      return `${nth} 给了 count，但空区（open）什么都不放 —— 想要几块层板请用 shelves 并给 count`;
    }
    if (u.kind === 'appliance' && u.count !== undefined) {
      return `${nth} 给了 count，但电器格没有"层板数/抽屉数"这个概念 —— 洞口上面的抽屉数请用 topDrawers，洞口尺寸用 openingWidth / openingHeight / openingDepth`;
    }
    const gotApplianceField = APPLIANCE_FIELDS.some((k) => u[k] !== undefined);
    if (u.kind !== 'appliance' && gotApplianceField) {
      return `${nth} 给了洞口参数（${APPLIANCE_FIELDS.filter((k) => u[k] !== undefined).join('、')}），但只有电器格（kind: "appliance"）预留洞口 —— 洗衣机柜、嵌入式烤箱这类才用得上`;
    }
    if (u.kind === 'appliance' && u.doorCount !== undefined && u.doorCount !== 0) {
      return `${nth} 给了 doorCount，但电器格的洞口和门在同一张脸上互相冲突 —— 机器露前脸是常规做法，不要给电器格装门`;
    }
  }
  return null;
}

function crossValidate(actionName, params) {
  if (actionName === 'cabinet.setUnitParam') {
    const key = params.param;
    const r = UNIT_PARAM_RANGES[key];
    if (!r) return `param = ${JSON.stringify(key)} 没有登记取值区间 —— 契约表漏了一项`;
    const v = params.value;
    if (typeof v !== 'number') return 'value 必须是数字';
    if (r.integer && Math.abs(v - Math.round(v)) > 1e-9) return `${key} 必须是整数（收到 ${v}）`;
    if (v < r.min || v > r.max) return `${key} = ${v} 超出允许区间 ${r.min}~${r.max}`;
    return null;
  }
  if (actionName === 'cabinet.create') {
    if (Array.isArray(params.units)) {
      const bad = unitIntentsSemanticError(params.units);
      if (bad) return bad;
    }
    if (Array.isArray(params.backUnits)) {
      const bad = unitIntentsSemanticError(params.backUnits);
      if (bad) return bad.replace('units 第', 'backUnits（背面分区）第');
    }
    return null;
  }
  if (actionName === 'cabinet.addUnit') {
    const APPLIANCE_ONLY = ['applianceName', 'openingWidth', 'openingHeight', 'openingDepth', 'topDrawers'];
    const got = APPLIANCE_ONLY.filter((k) => params[k] !== undefined);
    if (got.length > 0 && params.kind !== 'appliance') {
      return `给了洞口参数（${got.join('、')}），但 kind 是 "${params.kind}" —— 只有电器格（kind: "appliance"）预留洞口`;
    }
    if (params.kind === 'appliance' && params.doorCount !== undefined && params.doorCount !== 0) {
      return '电器格的洞口和门在同一张脸上互相冲突 —— 不要给电器格装门（机器露前脸是常规做法）';
    }
    return null;
  }
  return null;
}

/** 供编译器/界面使用的区间查询 —— 与 crossValidate 同源，不许各写一份 */
export function unitParamRange(param) {
  return UNIT_PARAM_RANGES[param] ?? null;
}

function enumFromSource(from, ctx) {
  switch (from) {
    case 'rules.materials.body':
      return ctx.bodyMaterials ?? [];
    case 'rules.materials.back':
      return ctx.backMaterials ?? [];
    case 'units.kind':
      return ['drawerBank', 'hanging', 'shelves', 'open', 'appliance'];
    default:
      return [];
  }
}

/**
 * 校验整个计划。
 *
 * 关键行为：**逐条校验、逐条拒收，而不是整体失败**。
 * 一个 10 条的计划里有 1 条越权，不应该让人重问一遍 ——
 * 应该把 9 条合法的摆出来、把 1 条连原因一起摊在台面上让人自己判断。
 * 但如果合法的 0 条，那就必须 ok:false：不能给出一个"看起来有动作"的空计划。
 */
export function validatePlan(raw, ctx = {}) {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'AI 返回的不是一个 JSON 对象', reply: '', actions: [], rejected: [] };
  }
  const reply = typeof raw.reply === 'string' ? raw.reply.slice(0, 2000) : '';
  const list = raw.actions;
  if (!Array.isArray(list)) {
    return { ok: false, error: 'AI 返回里没有 actions 数组', reply, actions: [], rejected: [] };
  }
  if (list.length > MAX_ACTIONS) {
    return {
      ok: false,
      error: `AI 一次给出 ${list.length} 条动作，超过上限 ${MAX_ACTIONS} —— 请把需求拆成几步说`,
      reply,
      actions: [],
      rejected: [],
    };
  }
  const actions = [];
  const rejected = [];
  for (let i = 0; i < list.length; i++) {
    const r = validateAction(list[i], ctx);
    /**
     * 通过的动作**原样**放进 actions —— 不附加 index 之类的元信息。
     * 理由：前端会拿这份 actions 再走一遍 validatePlan（双重校验，
     * 因为"服务端已经校验过"不能成为前端放弃校验的理由）。
     * 多一个字段就会在第二次校验时被判为"契约外字段"而整条丢掉。
     * 原始位置只出现在 rejected 里，供界面说明"第几条被拒了"。
     */
    if (r.ok) actions.push(r.action);
    else rejected.push({ index: i, code: r.code, error: r.error, raw: list[i] });
  }
  if (actions.length === 0 && rejected.length === 0) {
    // actions: [] 是合法的（"这个问题不需要改模型"），此时必须有人话解释
    return { ok: true, reply: reply || '（AI 认为不需要改动模型）', actions, rejected };
  }
  if (actions.length === 0) {
    return { ok: false, error: `AI 给出的 ${rejected.length} 条动作全部被拒`, reply, actions, rejected };
  }
  return { ok: true, reply, actions, rejected };
}

// ───────────────────────────── prompt 构建 ─────────────────────────────

/**
 * 系统提示词由**词汇表生成**，不手写。
 *
 * 手写的提示词一定会和契约漂移：契约加了动作、提示词忘了说，
 * 模型就会去猜一个不存在的动作名，然后被拒收 —— 而"AI 老是做错事"
 * 这种印象一旦形成，人就不会再用了。生成保证了不可能漂移。
 */
export function buildSystemPrompt() {
  const lines = [];
  lines.push('你是一个定制家具设计系统的**命令规划器**。你的唯一输出是一段 JSON。');
  lines.push('');
  lines.push('绝对规则（违反任何一条，你的输出会被程序直接丢弃）：');
  lines.push('1. 你**不能**输出几何：不能给坐标、点、线段、板件清单、图元。板件的裁切尺寸由系统的参数化模型推导，与你无关。');
  lines.push('2. 你**不能**修改工厂规则集：板材幅面、封边标准、五金型号、工艺上限都来自工厂规则文件，只读。');
  lines.push('3. 你**只能**从下面的动作清单里选动作，参数只能出现在该动作声明的参数名里。多写一个参数就整条作废。');
  lines.push('4. 你看不到、也不需要"派生数据"（开料清单 / 图纸 / 问题列表）。你只根据用户的话和当前模型的语义参数来决定动作。');
  /**
   * 第 5 / 6 条是用户那次投诉的直接元凶，改的时候要克制 —— 它们原本是对的，
   * 只是**没有任何一条规则告诉模型"先想想能不能拼"**，于是严格性全压在"不许做"
   * 上，模型就选了最安全也最没用的那条路：坦白做不到 + 反问用户。
   *
   * 新的写法把"做不做"变成一串**可判定**的问句（直接做 / 组合做 / 真的做不到），
   * 并把反问限定在真正会丢信息的那一类情况。规则本身没放松 —— 放宽的后果是
   * AI 开始凭感觉填数，那比反问更糟。
   */
  lines.push('5. 说"做不到"必须是**具体的能力缺口**，不是"这句话有点绕"。按这个顺序判断：①清单里有没有一条动作能直接做到 —— 有就做；②能不能用清单里的动作**拼**出来（见后面【形体怎么组合】）—— 能就拼，一次给全；③三条都试过、确实一条都靠不上，才可以在 reply 里说做不到，并点名缺什么。**不许**把"没听懂 / 有歧义 / 怕猜错"包装成"做不到"。');
  lines.push('6. 不要凭空发明用户**没给**的关键数字：用户说"高一点"却不给数，就别自己挑一个高度。反过来，**用户给了数字就必须照着做**——他给了「长 2200、台面宽 750、高 1000、另一边 1200」，就按这个建：台面宽当**进深**（depth）、柜高当 height、2200 与 1200 各是一条臂的 width，然后在 reply 里一行说明你按什么口径理解。口头口径错了没关系，两段式预览会先画出来，用户纠偏。**只有当用户一个数字都没给时**才允许反过来问他要哪一个。');
  lines.push('');
  lines.push('输出格式（严格的 JSON，不要 markdown 代码围栏）：');
  lines.push('{ "reply": "给用户看的中文说明，一两句", "actions": [ { "action": "动作名", "target": { "cabinetName": "柜体名字" }, "params": { ... }, "reason": "为什么这么做" } ] }');
  lines.push('');
  lines.push(`动作清单（共 ${ACTION_NAMES.length} 个）：`);
  for (const [name, spec] of Object.entries(ACTIONS)) {
    const ps = Object.entries(spec.params ?? {}).map(([k, p]) => describeParam(k, p, spec));
    const req = (spec.required ?? []).length ? `【必填 ${spec.required.join(', ')}】` : '';
    const atl = spec.atLeastOne ? `【至少给一个 ${spec.atLeastOne.join('/')}】` : '';
    const danger = spec.dangerous ? '【破坏性，仅当用户明确要求才可用】' : '';
    lines.push(`- ${name} —— ${spec.label}${req}${atl}${danger}`);
    if (ps.length) lines.push(`    参数：${ps.join('；')}`);
    if (spec.detail) lines.push(`    说明：${spec.detail}`);
  }
  lines.push('');
  lines.push(COMPOSITION_GUIDE);
  lines.push('target 用于指明"对哪个已有对象动手"：cabinetName 给柜体名字（不要编 id），unit 给分区（1 起序号或分区昵称），roomName 给房间名（只有 cabinet.create 需要）。');
  lines.push('当用户指"图上的一条线 / 一个部件"时，用 target.part 部件名（合法值：' + [...PARTS].join(' | ') + '），它仍需 cabinetName 指明柜体；当用户说"选中的这些柜体都要…"时，用 target: { scope: "selection" } 且不要给 cabinetName。part 与 scope 不能同时出现。');
  /**
   * 房间这条也要堵掉：模型当时的第二个问题就是"你希望这两个柜体放到哪个房间"。
   * 项目只有一个房间时 resolveRoom 直接吃掉省略值，问了纯属浪费一轮对话；
   * 有多个房间时用 snapshot 里列出来的名字即可（找不到会被拒收并附上现有房间名，
   * 那条报错比反问有用得多）。
   */
  lines.push('房间只在 target.roomName 里给，不要写进 params。项目里只有一个房间时可以省略；有多个房间就从 snapshot 的房间列表里挑一个写好。**永远不要反问用户"放到哪个房间"** —— 猜错了他在预览里一眼就看见。');
  lines.push('判断顺序：先认准用户说的是**哪个柜体**，再决定动作；一次把用户这一句话涉及的动作全部给出。');
  lines.push('用户说的中文数字（"三只抽屉"）要转成阿拉伯数字。"两米四"要转成 2400。');
  return lines.join('\n');
}

function describeParam(k, p, spec) {
  const opt = p.optional === true || !(spec.required ?? []).includes(k) ? '' : '(必填)';
  switch (p.type) {
    case 'number':
      return `${k}: 数字[${p.min}~${p.max}${p.unit ?? ''}]${opt}${p.desc ? ` ${p.desc}` : ''}`;
    case 'string':
      return `${k}: 字符串≤${p.max}字${opt}${p.desc ? ` ${p.desc}` : ''}`;
    case 'enum':
      return `${k}: 枚举${p.values ? `{${p.values.join('|')}}` : `（取值见输入里的 ${p.from}）`}${opt}${p.desc ? ` ${p.desc}` : ''}`;
    case 'unitRef':
      return `${k}: 分区引用（1 起序号或昵称）${opt}`;
    case 'roomRef':
      return `${k}: 房间引用（1 起序号或房间名）${opt}`;
    case 'unitIntents': {
      const fields = Object.entries(p.item ?? {}).map(([ik, ip]) => `${ik}${describeParam(ik, ip, {}).replace(/^[^:]*: /, '(') + ')'}`);
      return `${k}: 数组，最多 ${p.max} 项，从左到右，每项含 ${fields.join('，')}${opt}${p.desc ? ` ${p.desc}` : ''}`;
    }
    default:
      return `${k}: ${p.type}`;
  }
}

/** 用户消息也要由契约生成 —— 提示词与示例必须同源，否则模型会照抄示例里的旧格式 */
export function buildUserMessage(text, snapshot, history = []) {
  const lines = [];
  if (history.length > 0) {
    lines.push('【最近的对话】');
    for (const h of history.slice(-6)) lines.push(`${h.role === 'user' ? '用户' : '你'}：${String(h.text).slice(0, 300)}`);
    lines.push('');
  }
  lines.push('【当前模型状态】（这是系统给你的**只读**快照，只有语义参数，没有几何）');
  lines.push('```json');
  lines.push(JSON.stringify(snapshot, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('【用户这一句要求】');
  lines.push(String(text).slice(0, 2000));
  return lines.join('\n');
}

/**
 * 请求体构造 —— 走 OpenAI 的 `/chat/completions` 形态。
 * 之所以固定走这个形态：本机可用的服务商（OpenAI / DeepSeek / Kimi / GLM /
 * 通义 / 硅基 / OpenRouter / Ollama）**都提供兼容端点**，
 * 一处实现就能覆盖全部，加一家新服务商只是加一个 baseUrl。
 */
/**
 * 单次请求的默认输出上限。
 *
 * ── 为什么必须**显式**给，不能留给服务商默认值 ──
 *   **推理模型会先把预算花在思考上**。实测一个 R1 系的局域网模型：
 *     · 问"踢脚线多高"  → 252 个输出 token 里 **224 个是推理**（89%）
 *     · 回答"从 80 改成 120" → 130 个里 48 个是推理
 *     · 给 max_tokens=20 时 → **推理把 20 个全吃掉，正文是空字符串**
 *   如果服务商的默认上限偏小，规划请求就会拿回一个空 content，
 *   而错误信息只会说"模型返回了空内容" —— 完全指不到真正的原因
 *   （不是模型不会，是预算没给够）。
 *
 * ── 为什么是 4096 ──
 *   上限同时受 `MAX_ACTIONS`（12 条）约束，输出不可能长得离谱；
 *   4096 足够装下"一段推理 + 十几条动作 JSON"，又不会被模型拿去写小作文。
 *   要调就在 `.env` 里给 `AI_MAX_TOKENS`，不改代码。
 */
export const DEFAULT_MAX_TOKENS = 4096;

export function buildChatRequest(model, text, snapshot, opts = {}) {
  return {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserMessage(text, snapshot, opts.history ?? []) },
    ],
    temperature: opts.temperature ?? 0.1,
    response_format: { type: 'json_object' },
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

/**
 * 从模型回复里抠出 JSON。
 *
 * 现实里模型经常加 markdown 围栏、前后寒暄、甚至两个 JSON 连着。
 * 这里**不猜**：先试直接 parse，再试剥掉代码围栏，再试取第一个平衡的
 * `{...}` 片段。三次都失败就如实报错，让界面显示原始文本 ——
 * 而不是"尽力理解"，把一段半截 JSON 当成合法计划执行掉。
 */
export function extractJson(text) {
  const s = String(text ?? '').trim();
  if (!s) return { ok: false, error: '模型返回了空内容' };
  const attempts = [];
  attempts.push(s);
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) attempts.push(fence[1].trim());
  const bal = firstBalancedObject(s);
  if (bal) attempts.push(bal);
  for (const a of attempts) {
    try {
      const v = JSON.parse(a);
      if (v && typeof v === 'object') return { ok: true, value: v };
    } catch {
      /* 继续试下一种 */
    }
  }
  return { ok: false, error: '模型返回的不是可解析的 JSON', raw: s.slice(0, 800) };
}

/** 取第一个括号配平（且不在字符串里）的 `{...}` 片段 */
function firstBalancedObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
