import type { Cabinet, Issue } from '../types.ts';
import type { Change, Command } from '../commandBus.ts';
import { resizeCabinet, setUnitInt, setUnitWidth } from '../commands.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  规则码目录 —— 「报错人话化」的唯一真相源
 *
 *  为什么把它单独抽出来：
 *    fixHint 覆盖率从 30% 提到 100%，靠"记得每条都写"是做不到的 ——
 *    下一次加规则就又漏了。所以这里做的是**结构性保证**：
 *      校验器 / 生成器 / 项目派生 / 转角校验 **只能经 buildIssue() 发出报错**，
 *      message 与 fixHint 一律由目录产出，调用方不许自己拼。
 *    于是"每条报错都有人话解释 + 修复建议"是编译期+验收双重锁死的，
 *    不是一份需要靠自觉维护的清单。
 *
 *  ── 每条卡包含 ──
 *    title   人话标题（界面列表里顶着的那句，不用用户去猜 RULE-DOOR-MAX-WIDTH 是什么）
 *    message 出了什么事：说清"哪个柜/哪一格 + 差多少 mm"，用 mm 不用小数
 *    hint    怎么办：给得出具体数字或具体字段名，不许"检查一下"这类空话
 *    fix     一键修复命令。**只有修复意图唯一可判定时才给**；
 *             凡是"往左还是往右你自己定"的（移动哪个柜、加宽哪一格），
 *             一律不给按钮，只给 manual —— 一键修复最怕的不是修不了，
 *             而是替用户做了设计决定。
 *    manual  不能一键修时，如实说清是"要你决定"还是"这是程序缺陷"
 *    program 是否为程序缺陷（这类绝不允许一键"修"：修了只是把 bug 盖住）
 * ══════════════════════════════════════════════════════════════════════
 */

/**
 * 一键修复的计划：一条命令该干什么（不含 id —— id 由执行时生成，
 * 否则同一条报错修两次会撞 id）。
 *
 * 为什么存"计划"而不是"命令"：命令 id 必须唯一，而报错是每次派生都重新算出来的；
 * 把带 id 的命令塞进 Issue，等于把执行期的东西混进了派生结果。
 */
export interface FixPlan {
  op: string;
  target: { kind: 'cabinet' | 'wall' | 'project'; id: string };
  changes: Change[];
  label: string;
  note: string;
}

/** 目录内部用：从命令词汇表的构造器里取出"改什么"，避免在目录里另写一份 change 路径 */
function fromCommand(cmd: Command, note: string): FixPlan {
  if (!cmd.target) throw new Error(`修复命令缺少 target：${cmd.label ?? cmd.op}`);
  return { op: cmd.op, target: cmd.target, changes: cmd.changes, label: cmd.label ?? cmd.op, note };
}

export interface RuleCard {
  title: string;
  severity: Issue['severity'];
  program?: boolean;
  message: (c: IssueCtx) => string;
  hint: (c: IssueCtx) => string;
  fix?: (c: IssueCtx) => FixPlan | null;
  manual?: string;
}

export interface IssueCtx {
  /** 需要构造修复命令时带上柜体对象 */
  cab?: Cabinet;
  cabName?: string;
  [k: string]: unknown;
}

const num = (c: IssueCtx, key: string, fallback = 0): number => {
  const v = c[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};
const str = (c: IssueCtx, key: string, fallback = ''): string => {
  const v = c[key];
  return typeof v === 'string' ? v : v === undefined ? fallback : String(v);
};
const cabOf = (c: IssueCtx): Cabinet => c.cab as Cabinet;
const zh = (nick: string, id: string): string => nick || id;

/**
 * 门扇数：均分之后**最宽那扇**不超过 limit，最少要几扇。
 *
 * 为什么不写死"加一扇"：门宽 = (净宽 − 2×外缝 − (n−1)×中缝) / n，
 * 一个 2200mm 的门格加一扇还是 1100mm，照样超 600 上限 —— 那按钮就是个
 * "点了没反应"的假按钮。"预览 === 提交"，修完错还在比不给按钮更糟。
 */
/** 候选清单（材质库 / 封边表里的选项）人话化：宁可少列，不许刷屏 */
const listOf = (c: IssueCtx, key: string, max = 4): string => {
  const raw = c[key];
  if (!Array.isArray(raw) || raw.length === 0) return '（规则集里暂无可选项）';
  const names = raw.map((x) => String(x));
  return names.slice(0, max).join('、') + (names.length > max ? ' 等' : '');
};
const listLen = (c: IssueCtx, key: string): number => (Array.isArray(c[key]) ? (c[key] as unknown[]).length : 0);

function enoughDoorCount(netW: number, limit: number, gapOuter: number, gapMid: number, from: number): number {
  const widest = (n: number): number =>
    Math.ceil(Math.max(0, netW - 2 * gapOuter - (n - 1) * gapMid) / n);
  for (let n = from + 1; n <= from + 16; n++) {
    if (widest(n) <= limit) return n;
  }
  return from + 16;
}

const RULE_CARDS: Record<string, RuleCard> = {
  // ─────────────── 程序缺陷类：绝不给一键修复 ───────────────
  'IDENTITY-FAIL': {
    title: '程序自检没过',
    severity: 'ERROR',
    program: true,
    message: (c) =>
      `【${str(c, 'label')}】这条程序自检没过（${str(c, 'detail')}：左=${num(c, 'a', NaN)}，右=${num(c, 'b', NaN)}）。这是生成器自己算出来自相矛盾，不是你设计的问题。`,
    hint: () => '这是程序缺陷，不是你的设计问题：请把这条连同柜体名一起反馈给开发者，不要手动改几何。',
    manual: '程序缺陷（恒等式断言失败）：生成器的输出自相矛盾。修不了也不该一键"修" —— 一键修只会把 bug 盖住。',
  },
  'LAYOUT-CACHE-STALE': {
    title: '几何缓存过期',
    severity: 'ERROR',
    program: true,
    message: (c) =>
      `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」的几何缓存和模型对不上（${str(c, 'what')}）。这是程序缺陷，不是设计问题。`,
    hint: () => '这里的"修复"是重算缓存，属于程序行为；请反馈而不是手改缓存。',
    manual: '这是缓存失效逻辑的程序缺陷。重启应用若仍出现，请把这条反馈给开发者。',
  },
  'MISSING-BACKPANEL': {
    title: '少了一块背板',
    severity: 'ERROR',
    program: true,
    message: (c) => `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」的板件清单里没有背板 —— 派生管线漏了它。`,
    hint: () => '不要手动补板件，这是程序缺陷。',
    manual: '派生管线漏了背板，属于程序缺陷。请反馈，不要手改清单。',
  },
  'MISSING-MIDDLE-PANEL': {
    title: '双面柜少了共用中板',
    severity: 'ERROR',
    program: true,
    message: (c) =>
      `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」是双面柜，前后两排靠一块共用中板隔开，但清单里没有这块中板。`,
    hint: () => '不要手动补板件，这是程序缺陷。',
    manual: '派生管线漏了共用中板，属于程序缺陷。请反馈，不要手改清单。',
  },
  'IDENTITY-BACKSPLIT-BAD': {
    title: '背板拆出的块放不进板材',
    severity: 'ERROR',
    program: true,
    message: (c) =>
      `背板拆出的那块 ${num(c, 'len')}×${num(c, 'wid')}mm 横竖两种摆法都超了板材 ${num(c, 'sheetL')}×${num(c, 'sheetS')}mm —— 拆块算法有问题。`,
    hint: () => '不要手动改板件，这是程序缺陷。',
    manual: '拆块算法的问题，属于程序缺陷。请反馈。',
  },
  'DUP-PANEL-ID': {
    title: '板件编号撞号',
    severity: 'ERROR',
    program: true,
    message: (c) => `编号 ${str(c, 'panelId')} 被两块板同时占用 —— 开料机会按这个编号重复下料。`,
    hint: () => '不要手动改，这是程序缺陷。',
    manual: '板件 id 撞号属于程序缺陷。请反馈。',
  },
  'PANEL-ORPHAN': {
    title: '悬空板件',
    severity: 'ERROR',
    program: true,
    message: (c) => `板件 ${str(c, 'panelId')} 的归属写成了 ${str(c, 'belongsTo')}，不属于它所在的柜体。`,
    hint: () => '不要手动改，这是程序缺陷。',
    manual: '板件归属错误属于程序缺陷。请反馈。',
  },
  'GEN-CABINET-FAILED': {
    title: '这个柜生成失败',
    severity: 'ERROR',
    program: true,
    message: (c) => `「${str(c, 'cabName')}」没能生成出来：${str(c, 'reason')}。界面上它暂时没有图纸和清单。`,
    hint: (c) => `具体原因：${str(c, 'reason')}。请反馈；不要手改几何。`,
    manual: '生成过程抛了异常（程序缺陷）。请把这条反馈给开发者。',
  },

  // ─────────────── 设计问题：可判定 → 给一键修复 ───────────────
  'RULE-RUNNER-TOO-LONG': {
    title: '抽屉滑轨装不进去',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」的抽屉滑轨长 ${num(c, 'runnerLength')}mm，而柜体只有 ${num(c, 'depth')}mm 深 —— 滑轨伸不进去，抽屉装不上。`,
    hint: (c) =>
      `把滑轨缩短到 ${num(c, 'depth')}mm（抽屉会浅 ${Math.max(0, num(c, 'runnerLength') - num(c, 'depth'))}mm），或把柜体加深到 ≥ ${num(c, 'runnerLength')}mm。`,
    fix: (c) =>
      fromCommand(
        setUnitInt(cabOf(c), num(c, 'unitIndex'), 'drawers.runnerLength', num(c, 'depth'), '抽屉滑轨 → 柜体深度'),
        `滑轨已缩短到 ${num(c, 'depth')}mm，抽屉相应变浅 ${Math.max(0, num(c, 'runnerLength') - num(c, 'depth'))}mm。`
      ),
  },
  'RULE-APPLIANCE-FIT-W': {
    title: '电器洞口太宽，机器塞不下',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」的${str(c, 'applianceName', '电器')}洞口宽 ${num(c, 'openingWidth')}mm，比这格的净宽 ${num(c, 'netW')}mm 还宽 ${Math.max(0, num(c, 'openingWidth') - num(c, 'netW'))}mm —— 机器放不进去。`,
    hint: (c) => `把这格加宽到 ${num(c, 'needW')}mm 以上（= 洞口宽 + 两侧板厚），或换一台窄一点的机器。`,
    fix: (c) =>
      fromCommand(
        setUnitWidth(cabOf(c), num(c, 'unitIndex'), num(c, 'needW')),
        `该分区期望净宽已加到 ${num(c, 'needW')}mm（总宽固定，其他分区会等比让一点）。`
      ),
  },
  'RULE-APPLIANCE-FIT-H': {
    title: '电器洞口太高，顶到柜子内空',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」的洞口高 ${num(c, 'openingHeight')}mm 加上过梁板 ${num(c, 'boardT')}mm 后，超出柜内净高 ${num(c, 'innerH')}mm。`,
    hint: (c) =>
      `把柜体加高到 ${num(c, 'needH')}mm 以上，或把洞口高收到 ${num(c, 'maxOpening')}mm 以内。`,
    fix: (c) =>
      fromCommand(
        resizeCabinet(cabOf(c), { height: num(c, 'needH') }),
        `柜体高度已加到 ${num(c, 'needH')}mm；若顶到天花，还需确认是否要改成上下分柜。`
      ),
  },
  'RULE-APPLIANCE-FIT-D': {
    title: '电器洞口太深，会凸出柜面',
    severity: 'WARNING',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」的洞口深 ${num(c, 'openingDepth')}mm 比这排的排深 ${num(c, 'rowDepth')}mm 还深 —— ${str(c, 'applianceName', '电器')}会凸出柜面 ${Math.max(0, num(c, 'openingDepth') - num(c, 'rowDepth'))}mm。`,
    hint: (c) => `把柜体加深到 ${num(c, 'needD')}mm 以上；如果凸出是有意的设计，忽略这条即可。`,
    fix: (c) =>
      fromCommand(
        resizeCabinet(cabOf(c), { depth: num(c, 'needD') }),
        `柜体深度已加到 ${num(c, 'needD')}mm。`
      ),
  },
  'RULE-APPLIANCE-DOOR': {
    title: '电器格不该有门',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」是给${str(c, 'applianceName', '电器')}留的洞口格，却配了门板 —— 门板会挡在洞口前面。`,
    hint: () => '去掉这一格的门（嵌入式电器通常直接露前脸），或把它改成普通层板格。',
    fix: (c) => ({
      op: 'cabinet.layout.clearDoors',
      target: { kind: 'cabinet', id: str(c, 'cabId') },
      changes: [{ path: `layout.units[${num(c, 'unitIndex')}].doors`, op: 'set', value: null }],
      label: `「${str(c, 'unitName')}」去掉门板（电器洞口格）`,
      note: '门板已去掉，电器洞口现在直接露前脸。',
    }),
  },
  'RULE-DOOR-MAX-WIDTH': {
    title: '门板太宽',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」做出来最宽的一扇门是 ${num(c, 'maxW')}mm，超过这条规则允许的上限 ${num(c, 'limit')}mm —— 这么宽的门板一开就变形，铰链也扛不住。`,
    hint: (c) => {
      const n = enoughDoorCount(num(c, 'netW'), num(c, 'limit'), num(c, 'gapOuter'), num(c, 'gapMid'), num(c, 'count'));
      const per = Math.ceil(Math.max(0, num(c, 'netW') - 2 * num(c, 'gapOuter') - (n - 1) * num(c, 'gapMid')) / n);
      return `把这一格的门扇数量从 ${num(c, 'count')} 扇加到 ${n} 扇（每扇约 ${per}mm）；如果工厂实际允许更宽，也可以放宽这条规则的数值。`;
    },
    fix: (c) => {
      const from = num(c, 'count');
      const n = enoughDoorCount(num(c, 'netW'), num(c, 'limit'), num(c, 'gapOuter'), num(c, 'gapMid'), from);
      const per = Math.ceil(Math.max(0, num(c, 'netW') - 2 * num(c, 'gapOuter') - (n - 1) * num(c, 'gapMid')) / n);
      return fromCommand(
        setUnitInt(cabOf(c), num(c, 'unitIndex'), 'doors.count', n, `门扇数 ${from} → ${n}`),
        `门扇已加到 ${n} 扇，最宽那扇 ${per}mm；门缝位置会跟着重排。`
      );
    },
  },
  /**
   * 门高**只由柜高与踢脚决定**（门高 = 柜高 − 踢脚 − 2×板厚 − 2×外缝），
   * 和门扇数无关 —— 所以这里绝不能给"改门扇数"的按钮（点了门高纹丝不动）。
   * 两个修法（降柜高 / 抬踢脚）各有取舍，属于设计决定，只给数字不给按钮。
   */
  'RULE-DOOR-MAX-HEIGHT': {
    title: '门板太高',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」的门板高 ${num(c, 'doorH')}mm，超过规则允许的上限 ${num(c, 'limit')}mm —— 门板太重，铰链扛不住。`,
    hint: (c) => {
      const over = Math.max(0, num(c, 'doorH') - num(c, 'limit'));
      return `把柜体高度从 ${num(c, 'height')}mm 降到 ${num(c, 'height') - over}mm 以内（门高随之压到 ${num(c, 'limit')}mm），或者把踢脚高度从 ${num(c, 'bodyLift')}mm 加到 ${num(c, 'bodyLift') + over}mm（柜子总高不变，门高同样压到 ${num(c, 'limit')}mm）。`;
    },
    manual: '降柜高还是抬踢脚，会让柜子外观不一样，属于设计决定 —— 系统只给得出数字，不替你选。',
  },
  'RULE-DRAWER-TALL-FRONT': {
    title: '抽屉面太高',
    severity: 'WARNING',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」最高的那块抽屉面板 ${num(c, 'maxFront')}mm，超出单抽常用高度（≤400mm），取放会别扭。`,
    hint: (c) => `在这格里多分一格抽屉（数量 ${num(c, 'count')} → ${num(c, 'count') + 1}，每格约 ${Math.round(num(c, 'netH') / (num(c, 'count') + 1))}mm），或改成「抽屉 + 上翻门」。`,
    fix: (c) =>
      fromCommand(
        setUnitInt(cabOf(c), num(c, 'unitIndex'), 'drawers.count', num(c, 'count') + 1, `抽屉数 ${num(c, 'count')} → ${num(c, 'count') + 1}`),
        `抽屉已多分一格（${num(c, 'count')} → ${num(c, 'count') + 1}），面板高度随之降低。`
      ),
  },
  'RULE-DOUBLE-NO-BACK': {
    title: '双面柜缺了背面那排',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」被标成双面柜（前后两排），但没有给背面要放什么（backUnits）—— 背面无从生成。`,
    hint: () => '给 layout.backUnits 至少加一个分区；如果其实只要单排，把 layout.type 改回 row。',
    manual: '要加几个背面分区、放什么，属于设计决定，系统不能替你选。',
  },
  'RULE-ROW-WITH-BACK': {
    title: '单面柜却带了背面分区',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」是单面柜，却带着背面分区 backUnits —— 两者互相矛盾。`,
    hint: () => '把 layout.type 改成 double（做真双面柜），或把 backUnits 删掉。',
    manual: '改成双面还是删掉背面分区，属于设计决定。',
  },

  // ─────────────── 设计问题：修法有多种 → 只给建议 ───────────────
  'RULE-DRAWER-NO-ROOM': {
    title: '这一格放不下抽屉',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」的净宽只有 ${num(c, 'netW')}mm，抽屉左右滑轨各要让位后已经没有余量 —— 抽屉盒装不进去。`,
    hint: (c) => `把这格加宽到 ${num(c, 'needW')}mm 以上，或换用更窄的滑轨（单侧 12.5mm）。`,
    manual: '加宽哪几格 / 换什么滑轨，属于设计决定，系统不替你选。',
  },
  'RULE-SHELF-DEPTH': {
    title: '层板深度算不出来',
    severity: 'ERROR',
    message: (c) => `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」按前沿让位算出的层板深度是 ${num(c, 'sd')}mm，生成不出这块板。`,
    hint: () => '加大柜体深度，或检查背板槽位置与前沿让位参数。',
    manual: '加多少深度属于设计决定。',
  },
  'RULE-MIN-PANEL': {
    title: '板件太小，是边角料',
    severity: 'WARNING',
    message: (c) =>
      `「${str(c, 'nameZh')}」${num(c, 'len')}×${num(c, 'wid')}mm，小于最小可用尺寸 ${num(c, 'min')}mm —— 开料时容易废，也容易在运输中损坏。`,
    hint: () => '把相邻两格合并，或调整分格尺寸让每块都够大。',
    manual: '怎么合并分格属于设计决定。',
  },
  'RULE-PANEL-OVER-SHEET': {
    title: '板件超出板材幅面',
    severity: 'ERROR',
    message: (c) =>
      `「${str(c, 'nameZh')}」${num(c, 'len')}×${num(c, 'wid')}mm 放不进板材 ${num(c, 'sheetL')}×${num(c, 'sheetS')}mm${num(c, 'grainLocked') ? '（有木纹方向，不能转 90°）' : ''}。`,
    hint: () => '把这块板拆成两块接料，或改用拼板方案；没有木纹方向的板件也可以试着转 90° 再用。',
    manual: '拼板方式是工厂工艺决定，不能一键替你选。',
  },
  'RULE-PANEL-WEIGHT': {
    title: '板件太重，一个人搬不动',
    severity: 'WARNING',
    message: (c) =>
      `「${str(c, 'nameZh')}」单件约 ${num(c, 'kg', 0) ? num(c, 'kg').toFixed(1) : '?'}kg，超过人工搬运建议上限 ${num(c, 'limit')}kg（共 ${num(c, 'qty')} 件）。`,
    hint: () => '拆成两块接料，或安排双人搬运（在图纸上注明）。',
    manual: '拆块会改变板件编号，属于工厂工艺决定。',
  },
  'RULE-EDGE-UNKNOWN': {
    title: '封边材料不存在',
    severity: 'ERROR',
    message: (c) => `「${str(c, 'nameZh')}」引用了规则集里没有的封边材料「${str(c, 'edge')}」—— 工厂按哪个封边条下料？`,
    hint: (c) => `规则集里现有的封边共 ${listLen(c, 'candidates')} 种（${listOf(c, 'candidates')}），把这条边改成其中一个；确实用这个新封边就去规则集里补上它。`,
    manual: '改规则集还是改设计，属于管理决定；而且规则集不是 AI 能碰的东西。',
  },
  'RULE-CABINET-SPLIT-HEIGHT': {
    title: '柜子太高，建议上下分柜',
    severity: 'WARNING',
    message: (c) => `「${str(c, 'cabName')}」高 ${num(c, 'height')}mm，超过单柜建议上限 ${num(c, 'limit')}mm。`,
    hint: (c) => `把柜高降到 ${num(c, 'limit')}mm 以内，或拆成上下两个柜（中间加中立梁）。`,
    manual: '怎么分柜属于设计决定。',
  },
  'RULE-CABINET-SPLIT-WIDTH': {
    title: '柜子太宽，建议左右分柜',
    severity: 'WARNING',
    message: (c) => `「${str(c, 'cabName')}」宽 ${num(c, 'width')}mm，超过单柜建议上限 ${num(c, 'limit')}mm。`,
    hint: (c) => `把柜宽降到 ${num(c, 'limit')}mm 以内，或拆成左右两个柜。`,
    manual: '怎么分柜属于设计决定。',
  },
  'RULE-SHELF-SPAN': {
    title: '层板跨度偏大',
    severity: 'WARNING',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」的层板跨度 ${num(c, 'netW')}mm，超过建议上限 ${num(c, 'max')}mm —— 中间没有支撑，容易弯。`,
    hint: (c) =>
      `在中间加一块中立板（切成 ${Math.max(2, Math.ceil(num(c, 'netW') / num(c, 'max')))} 段，每段约 ${Math.round(num(c, 'netW') / Math.max(2, Math.ceil(num(c, 'netW') / num(c, 'max'))))}mm），或把层板加厚到 25mm。`,
    manual: '加中立板会占用柜内空间，属于设计决定。',
  },
  'RULE-CABINET-OVERLAP': {
    title: '两个柜子重叠了',
    severity: 'ERROR',
    message: (c) =>
      `「${str(c, 'nameA')}」和「${str(c, 'nameB')}」在平面上重叠了 ${num(c, 'area')}mm² —— 装进去必然打架。`,
    hint: (c) => `挪开其中一个（点这条会选中这两个柜，可以直接拖），或把柜体做窄 ${num(c, 'needW')}mm。`,
    manual: '动哪个柜、往哪挪，属于设计决定，系统不能替你选。',
  },
  'RULE-CABINET-IN-WALL': {
    title: '柜子和墙打架',
    severity: 'ERROR',
    message: (c) =>
      `「${str(c, 'cabName')}」嵌进了墙体「${str(c, 'wallName')}」里 ${num(c, 'pen')}mm —— 墙厚 ${num(c, 'thickness')}mm，是结构，挪不开。`,
    hint: (c) => `把柜子沿墙推到贴墙面（挪出约 ${num(c, 'need')}mm），或换个位置放。`,
    manual: '往墙的哪一侧挪、挪多少，属于设计决定。',
  },
  'CORNER-DOOR-SWING': {
    title: '转角门会扫到邻居',
    severity: 'WARNING',
    message: (c) =>
      `「${str(c, 'nameSrc')}」靠内角那扇门（宽约 ${num(c, 'radius')}mm）打开时会扫到「${str(c, 'nameOther')}」—— 可能撞门或撞抽屉面。`,
    hint: () => '把这一格的内端改成无门 / 移门，或缩短门扇宽度，或把相邻柜体内缩避让。',
    manual: '改哪一边属于设计决定。',
  },

  // ─────────────── 提示类：说清楚"为什么长这样"，不是错误 ───────────────
  'DOUBLE-NO-BACKPANEL': {
    title: '双面柜本来就没有背板',
    severity: 'INFO',
    message: (c) =>
      `「${str(c, 'cabName')}」是双面柜：前后两排背靠背，共用一块 ${num(c, 'boardT')}mm 中板当分隔，因此不需要背板（中板即背）。总深 = 后排 ${num(c, 'backRowDepth')} + 中板 ${num(c, 'midT')} + 前排 ${num(c, 'frontRowDepth')} = ${num(c, 'depth')}mm。`,
    hint: () => '无需处理；背板槽参数对这个柜型不生效。',
  },
  'ALLOC-FIT-TOTAL': {
    title: '净宽被重新摊了一遍',
    severity: 'INFO',
    message: (c) =>
      `「${str(c, 'cabName')}」总宽 ${num(c, 'width')}mm 是不动的：扣掉两侧板与立板后，可用净宽只有 ${num(c, 'netTotal')}mm，所以各格按期望比例重新分到了${str(c, 'drift', '')}。`,
    hint: () => '如果希望"净宽说了算、总宽跟着变"，把 layout.widthMode 改成 fit_units。',
    manual: '改总宽策略会改变整柜尺寸，属于设计决定。',
  },
  'LAYOUT-MODE-NOT-IMPLEMENTED': {
    title: '这个宽度策略还没实现',
    severity: 'INFO',
    message: (c) =>
      `「${str(c, 'cabName')}」用的是 fit_units 策略，但生成器现在一律按「总宽优先」分配净宽 —— 也就是说总宽 ${num(c, 'width')}mm 仍然是唯一权威。`,
    hint: () => '这个功能还在做；在此之前先用 fit_total（总宽优先）。',
  },
  'RULE-DOOR-TALL': {
    title: '门比较高，铰链要复核',
    severity: 'INFO',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」的门板高 ${num(c, 'doorH')}mm，按规则约需 ${num(c, 'hinges')} 只铰链 —— 建议和铰链品牌确认一下承重。`,
    hint: () => '下单前复核铰链型号与承重即可，结构本身是算得出来的。',
  },
  'RULE-BACKPANEL-SPLIT': {
    title: '背板超出幅面，已拆块',
    severity: 'WARNING',
    message: (c) =>
      `「${str(c, 'cabName')}」的背板 ${num(c, 'bw')}×${num(c, 'bh')}mm 超出板材幅面，已按 ${num(c, 'cols')} 列 × ${num(c, 'rows')} 行拆成 ${num(c, 'pieces')} 块（单块最大 ${num(c, 'maxCol')}×${num(c, 'maxRow')}mm，${str(c, 'orientZh')}）。`,
    hint: () => '确认拼接方向与压条方案；或改用 5mm 条状背板（条状不受幅面限制）。',
    manual: '拼接方案是工厂工艺决定。',
  },
  'RULE-DOOR-MATERIAL': {
    title: '门板材质不在材质库，已回退',
    severity: 'WARNING',
    message: (c) =>
      `「${zh(str(c, 'unitName'), str(c, 'unitId'))}」的门板材质「${str(c, 'doorMaterial')}」在材质库里找不到，已按柜体板材回退成「${str(c, 'fallback')}」。`,
    hint: (c) => `材质库里现有的材质共 ${listLen(c, 'candidates')} 种（${listOf(c, 'candidates')}），把门板材质 ID 改成其中一个；确实用它就去规则集里补上「${str(c, 'doorMaterial')}」。`,
    manual: '用哪个材质是设计决定，系统不会替你换掉它。',
  },
};

export const RULE_CODES = Object.keys(RULE_CARDS);
export const ruleCard = (code: string): RuleCard | undefined => RULE_CARDS[code];

/**
 * 唯一的报错构造口。
 *
 * 调用方只负责"哪个柜 / 哪一格 + 差多少"，message 与 fixHint 一律由目录产出 ——
 * 这样"每条报错都带人话解释和修复建议"是结构性成立的，不依赖谁记得写。
 */
export function buildIssue(
  code: string,
  over: { target: string; targetKind: Issue['targetKind']; ctx?: IssueCtx },
): Issue {
  const card = RULE_CARDS[code];
  if (!card) {
    // 目录里没有的码就是漏登记 —— 宁可报错也绝不静默产出一条没人看得懂的 Issue
    throw new Error(`规则码未登记到 issueCatalog：${code}`);
  }
  const ctx = over.ctx ?? {};
  const issue: Issue = {
    severity: card.severity,
    code,
    target: over.target,
    targetKind: over.targetKind,
    message: card.message(ctx),
    fixHint: card.hint(ctx),
  };
  // 一键修复计划挂在报错上，界面直接拿去执行 —— 不必在 UI 里再把规则推理一遍
  const plan = buildFix(card, ctx);
  if (plan) issue.autoFix = plan;
  return issue;
}

/** 一键修复：只有目录显式给了 fix、且不是程序缺陷时才可能给出计划 */
export function buildFix(card: RuleCard, ctx: IssueCtx): FixPlan | null {
  if (!card.fix || card.program) return null;
  try {
    return card.fix(ctx) ?? null;
  } catch {
    // 修复命令构造失败时宁可没有按钮，也不能发出一条坏命令
    return null;
  }
}
