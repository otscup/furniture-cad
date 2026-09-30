import type { Cabinet, Issue } from '../types.ts';
import type { Change, Command } from '../commandBus.ts';
import { resizeCabinet, setUnitInt, setUnitWidth } from '../commands.ts';
import { unitPathPrefix } from '../layoutModel.ts';

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

/** 相接容差文案（与 relations.ts 的 CONTACT_TOL 同源，避免两处各写死一个数字） */
const CONTACT_TOL_TEXT = '2mm';

const num = (c: IssueCtx, key: string, fallback = 0): number => {
  const v = c[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};
/**
 * 与 `num` 的区别：`num` 缺值兜底 0，会把"字段缺失 / 未知"悄悄变成 0，
 * 让测试误以为"消息里带数字了"（假绿）。`numOrUndef` 在缺值/非数时返回 undefined，
 * 调用方据此显式报"数量无法识别"，而不是拿 0 顶替。
 *
 * 使用口径（项目级一致）：凡是"外部数据带进来的数量/计数"（导入、识别、统计），
 * 一律用 `numOrUndef`；只有"本系统已算出的确定尺寸差"才用 `num`（那些值校验器必给）。
 */
const numOrUndef = (c: IssueCtx, key: string): number | undefined => {
  const v = c[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
/** 数量文案：真有数 → "N 个"；缺失 → 明确"无法识别"，绝不说"0 个" */
const countText = (c: IssueCtx, key: string): string => {
  const n = numOrUndef(c, key);
  return n === undefined ? '数量无法识别（数据缺失或非数组）' : `${n} 个`;
};
const str = (c: IssueCtx, key: string, fallback = ''): string => {
  const v = c[key];
  return typeof v === 'string' ? v : v === undefined ? fallback : String(v);
};
const cabOf = (c: IssueCtx): Cabinet => c.cab as Cabinet;
const zh = (nick: string, id: string): string => nick || id;

/**
 * 这条报错说的分区**在哪一排** —— 一键修复的写路径前缀。
 *
 * 校验器会把 `unitBasePath` 放进 ctx（垂直行 = `layout.rows[j].units`，
 * 背面排 = `layout.backUnits`）；单行柜就是 `layout.units`。
 * 没带时按 canonical 第一行走（与 v0.2 一致）。
 *
 * ── 为什么必须有它 ──
 *   一键修复是"点了就执行"的按钮。若多行柜的修复命令仍写死 `layout.units[i]`，
 *   用户在**第 2 行**点"门扇加到 3 扇"，改的却是第 1 行 —— 界面不报错、
 *   柜子看着变了、车间拿到的是错的板件。比"没有按钮"糟得多。
 */
const baseOf = (c: IssueCtx): string => {
  const b = c['unitBasePath'];
  if (typeof b === 'string' && b !== '') return b;
  const cab = c.cab;
  return cab ? unitPathPrefix(cab.layout, 0) : 'layout.units';
};

/** 该分区所在行的说明（多行柜才有；单行柜为空串 → 文案与 v0.2 逐字相同） */
const rowOf = (c: IssueCtx): string => str(c, 'rowLabel');

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
        setUnitInt(cabOf(c), num(c, 'unitIndex'), 'drawers.runnerLength', num(c, 'depth'), '抽屉滑轨 → 柜体深度', 'ui', baseOf(c)),
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
        setUnitWidth(cabOf(c), num(c, 'unitIndex'), num(c, 'needW'), 'ui', baseOf(c)),
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
        setUnitInt(cabOf(c), num(c, 'unitIndex'), 'doors.count', n, `门扇数 ${from} → ${n}`, 'ui', baseOf(c)),
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
      /**
       * 多行柜（上下分层）时，"降柜高"不是唯一的修法 —— 要降的是**这一行**的高度。
       * 单行柜时这里走下面那条分支，文案与 v0.2 逐字相同。
       */
      if (rowOf(c) !== '') {
        return `把这一行的固定高度减少 ${over}mm 以上（门高随之压到 ≤${num(c, 'limit')}mm；柜体总高不变，让出来的空间归标了 fill 的那一行），或者把这一行的门拆成上下两扇。`;
      }
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
        setUnitInt(cabOf(c), num(c, 'unitIndex'), 'drawers.count', num(c, 'count') + 1, `抽屉数 ${num(c, 'count')} → ${num(c, 'count') + 1}`, 'ui', baseOf(c)),
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

  // ═══════════ Rows（v0.3 上下分层）：高度链的错法 ═══════════
  // 判定全部来自 layout.ts 的 resolveRowHeights（唯一一处），这里只把它翻成人话。
  'RULE-ROW-FILL-DUP': {
    title: '有两行都想"吃掉剩余高度"',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」分了 ${num(c, 'rowCount')} 行，其中 ${num(c, 'fillCount')} 行都标成了「吃掉剩余高度」（fill）—— 剩余高度只有一份，两行都吃掉算不出结果。`,
    hint: (c) =>
      `只留最后一行标 fill；其余行各给一个固定净高，这些固定高之和必须等于 ${num(c, 'available')}mm（= 柜内净高 − (${num(c, 'rowCount')}−1)×板厚 ${num(c, 'boardT')}mm）。`,
    manual: '哪几行给固定高、各给多少，属于设计决定 —— 系统只给得出总和。',
  },
  'RULE-ROW-FILL-POSITION': {
    title: '"吃掉剩余"的那一行不在最下面',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」共 ${num(c, 'rowCount')} 行（自上而下编号），标了 fill 的是第 ${num(c, 'fillIndex') + 1} 行 —— 而 fill 必须落在最后一行（最下面那行），否则它上/下方的行没有锚点。`,
    hint: (c) =>
      `把 fill 挪到最后一行（第 ${num(c, 'rowCount')} 行），或者给第 ${num(c, 'fillIndex') + 1} 行一个固定净高、把 fill 让给最后一行。`,
    manual: '让哪一行吃剩余高度，属于设计决定。',
  },
  'RULE-ROW-FILL-OVERFLOW': {
    title: '固定行高之和已经超过可用内高',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」各固定行的净高之和是 ${num(c, 'fixedSum')}mm，而扣掉 ${num(c, 'rowCount')} 行之间那几块行隔板后只剩 ${num(c, 'available')}mm —— 已经超了 ${num(c, 'over')}mm，最后一行的 fill 没有空间可吃。`,
    hint: (c) =>
      `把固定行的总高减少 ${num(c, 'over')}mm 以上（总和要 ≤ ${num(c, 'available')}mm），或者把柜体高度加大 ${num(c, 'over')}mm 以上。`,
    manual: '减哪一行、还是加高柜体，属于设计决定。',
  },
  'RULE-ROW-HEIGHT-SUM': {
    title: '各行高度加起来对不上柜内净高',
    severity: 'ERROR',
    message: (c) => {
      const d = num(c, 'diff');
      const rel = d >= 0 ? `多 ${d}mm` : `少 ${Math.abs(d)}mm`;
      return `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」各固定行的净高之和是 ${num(c, 'fixedSum')}mm，而扣掉 ${num(c, 'rowCount')} 行之间的行隔板后可用内高是 ${num(c, 'available')}mm —— 比可用内高${rel}，而且没有一行标 fill 来吸收这个差。`;
    },
    hint: (c) =>
      `把某一行的高度调整 ${Math.abs(num(c, 'diff'))}mm（让总和等于 ${num(c, 'available')}mm），或者把最后一行改成「吃掉剩余高度」（fill），让它自动吸收。`,
    manual: '调哪一行属于设计决定；改成 fill 则等于把自由量交给最后一行。',
  },
  'RULE-ROW-HEIGHT-BAD': {
    title: '行高不是合法的正整毫米',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」有一行的高度不是正整数毫米（共 ${num(c, 'rowCount')} 行）—— 生产尺寸不允许小数，也不允许 0 或负数。`,
    hint: () => '把这一行的 height 改成正整数（mm，例如 480），或改成字符串 "fill"（表示吃掉剩余高度）。',
    manual: '这一行该多高，属于设计决定。',
  },
  'RULE-ROW-DOUBLE-UNSUPPORTED': {
    title: '双面柜暂不支持上下分行',
    severity: 'ERROR',
    message: (c) =>
      `「${zh(str(c, 'cabName'), str(c, 'cabId'))}」是双面柜（前后两排），同时又分了 ${num(c, 'rowCount')} 个上下行 —— 本阶段不支持这个组合：行隔板会与前后共用的中板抢同一段空间，而"两排的行要不要对齐、行隔板要不要穿中板"还没有定义。`,
    hint: () => '把它拆成两个单面柜，或者先取消上下分行（去掉 layout.rows 里多出来的行）再排岛台。',
    manual: '这是本阶段明确的能力边界，不是你的设计错 —— 系统不猜一个没人定义过的几何。',
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

  // ═══════════════ 组合关系（v0.3，P2）═══════════════
  //
  // 这一族的定位：**校验"声明的关系"**，不是校验柜体本身。
  // 组合不产生板件、不改尺寸 —— 所以这一族里没有一条是"尺寸问题"，
  // 全是"你说的话与落位对不对得上"。这正是关系层该管的事。
  'ASSEMBLY-NOT-TOUCHING': {
    title: '声明连着，实际没挨着',
    severity: 'ERROR',
    message: (c) =>
      `组合「${str(c, 'asmName')}」里声明「${str(c, 'nameA')}」与「${str(c, 'nameB')}」是${str(c, 'kindZh')}，但两柜实际没相接：最近处还差 ${num(c, 'gap')}mm（相接容差 ${CONTACT_TOL_TEXT}）。`,
    hint: (c) => `把其中一个柜朝另一个挪 ${num(c, 'gap')}mm 就贴上了（贴边或共角）；本来就不该连的话删掉这条连接 —— 声明"连着"却没连着，整组移动/转角检查会按错误的前提算。`,
    manual: '挪哪个柜是设计决定（系统不知道你想让谁靠过去）。',
  },
  'ASSEMBLY-KIND-MISMATCH': {
    title: '连接方式和实际摆放不一致',
    severity: 'ERROR',
    message: (c) =>
      `组合「${str(c, 'asmName')}」里「${str(c, 'nameA')}」与「${str(c, 'nameB')}」声明的是${str(c, 'declared')}，按落位算（两柜轴线夹角 ${num(c, 'angle')}°）其实是${str(c, 'actual')}。`,
    hint: (c) => `把这条连接的类型改成${str(c, 'actual')}；或者转柜体让夹角到 90°（现在 ${num(c, 'angle')}°）再按角接算。`,
    manual: '是改声明还是改摆放，取决于你想要哪个。',
  },
  'ASSEMBLY-EDGE-MISMATCH': {
    title: '连接的边和实际不一致',
    severity: 'ERROR',
    message: (c) =>
      `组合「${str(c, 'asmName')}」里「${str(c, 'cabName')}」声明用${str(c, 'declared')}相接，按落位算（两柜轴线夹角 ${num(c, 'angle')}°）贴合的是${str(c, 'actual')}。`,
    hint: (c) => `续接时贴合边是唯一确定的：把声明改成${str(c, 'actual')}，或干脆不写 edge 交给派生反推（夹角 ${num(c, 'angle')}° 时边是算出来的，不是猜的）。`,
    manual: '要不要保留这条边的声明由你定；不写 edge 不会丢信息。',
  },
  'ASSEMBLY-EDGE-AMBIGUOUS': {
    title: '角接的边有歧义',
    severity: 'WARNING',
    message: (c) =>
      `组合「${str(c, 'asmName')}」里「${str(c, 'cabName')}」声明用${str(c, 'declared')}角接，按落位算（两柜轴线夹角 ${num(c, 'angle')}°）更接近${str(c, 'actual')}。`,
    hint: (c) =>
      `墙角那个点同时属于相邻两条边（夹角 ${num(c, 'angle')}° 时尤其明显），"角接算哪条边"本身没有唯一答案。建议不写 edge，只声明角接 —— 需要精确控制时，这条提示告诉你系统算成了${str(c, 'actual')}。`,
    manual: '角点归属两条边是几何事实，不是错误。',
  },
  'ASSEMBLY-CONN-OUTSIDE': {
    title: '连接指向组合外的柜体',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'asmName')}」（成员 ${num(c, 'count')} 个）的连接用到了柜体 ${str(c, 'cabId')}，它不在成员列表里。`,
    hint: (c) => `把它加进成员（成员会变成 ${num(c, 'count') + 1} 个），或删掉这条连接。关系只能描述组合内部 —— 跨出成员的关系会让"整组移动"的边界说不清。`,
    manual: '要不要把它并进这组是设计决定。',
  },
  'ASSEMBLY-CONN-SELF': {
    title: '柜体连到了自己',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'asmName')}」（成员 ${num(c, 'count')} 个）里有一条连接的两端都是柜体 ${str(c, 'cabId')}。`,
    hint: (c) => `删掉这条连接：同一对柜体之间最多留 1 条，自己与自己（这 ${num(c, 'count')} 个成员里它只算一个）谈不上"相接"。`,
    manual: '这是模型数据有问题，删掉即可。',
  },
  'ASSEMBLY-CONN-DUP': {
    title: '同一对柜体重复声明了连接',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'asmName')}」（成员 ${num(c, 'count')} 个）里「${str(c, 'nameA')}」与「${str(c, 'nameB')}」之间有不止 1 条连接。`,
    hint: () => '两个柜体之间只可能有一种空间关系，保留实际那一条、删掉其余的（每对最多 1 条）。',
    manual: '保留哪条要看你想要哪种语义。',
  },
  'ASSEMBLY-MEMBER-MISSING': {
    title: '组合成员不存在',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'asmName')}」的成员 ${str(c, 'cabId')} 在项目里找不到（这个组合现在列了 ${num(c, 'count')} 个成员）。`,
    hint: () => '删掉这个成员 id，或把对应柜体补回来。指向不存在的柜体，整组操作时一定会静默少动一个。',
    manual: '多半是柜体被删了而组合没跟着改。',
  },
  'ASSEMBLY-MEMBER-DUP': {
    title: '组合成员重复',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'asmName')}」的成员列表（${num(c, 'count')} 项）里 ${str(c, 'cabId')} 出现了不止 1 次。`,
    hint: () => '成员列表里每个柜体只写一次。重复会让"整组平移"把同一个柜挪两次。',
    manual: '删掉重复项即可。',
  },
  'ASSEMBLY-MEMBER-ROOM': {
    title: '组合跨了房间',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'asmName')}」（成员 ${num(c, 'count')} 个）里的「${str(c, 'cabName')}」在房间「${str(c, 'roomName')}」，不在本组合所属房间。`,
    hint: () => '一个组合只属于一个房间：把柜体挪进该房间，或把它从这个组合里去掉。跨房间的组合没有"同一组家具"的意义。',
    manual: '房间归属是设计决定。',
  },
  'ASSEMBLY-ROOM-MISSING': {
    title: '组合指向不存在的房间',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'asmName')}」所属房间 ${str(c, 'roomId')} 在项目里找不到（项目现在有 ${num(c, 'count')} 个房间）。`,
    hint: (c) => `把组合改到现有这 ${num(c, 'count')} 个房间里的某一个，或删掉这个组合。`,
    manual: '多半是房间被删了而组合没跟着改。',
  },
  'ASSEMBLY-EMPTY': {
    title: '组合没有成员',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'asmName')}」的成员列表是空的（成员数 ${num(c, 'count')}）。`,
    hint: () => '加进至少 1 个柜体，或删掉这个组合。空组合在整组操作时什么也不做，却占着一个名字。',
    manual: '删掉或补成员都可以。',
  },
  'ASSEMBLY-ID-DUP': {
    title: '组合 id 重复',
    severity: 'ERROR',
    message: (c) => `组合 id ${str(c, 'asmId')}（「${str(c, 'asmName')}」）出现了 ${num(c, 'count')} 次。`,
    hint: (c) => `${num(c, 'count')} 个组合共用一个 id 时，改一个会连带改到另一个 —— 必须改成唯一 id。`,
    manual: '这是模型数据有问题，改 id 即可。',
  },
  'ASSEMBLY-DISCONNECTED': {
    title: '这一组在空间上分成了几堆',
    severity: 'WARNING',
    message: (c) => `组合「${str(c, 'asmName')}」的 ${num(c, 'count')} 个柜体没有连成一片（中间有断开的地方）。`,
    hint: (c) => `${num(c, 'count')} 个成员分成了多堆：检查是不是有柜体没挪到位；如果本来就是两组家具，拆成两个组合更清楚。`,
    manual: '是不是同一组由你定，系统只提示"它们没挨着"。',
  },
  'ASSEMBLY-MEMBER-SHARED': {
    title: '柜体同时属于多个组合',
    severity: 'WARNING',
    message: (c) => `「${str(c, 'cabName')}」同时属于 ${num(c, 'count')} 个组合（${str(c, 'names')}）。`,
    hint: (c) => `整组移动/整组删除时，这个柜会被这 ${num(c, 'count')} 个组合各操作一次。要么只留一个归属，要么接受"它属于两组"。`,
    manual: '归属是设计决定。',
  },
  'ASSEMBLY-STACK-UNVERIFIED': {
    title: '叠放关系本阶段核不了',
    severity: 'INFO',
    message: (c) =>
      `组合「${str(c, 'asmName')}」里「${str(c, 'nameA')}」（高 ${num(c, 'hA')}）与「${str(c, 'nameB')}」（高 ${num(c, 'hB')}）声明为叠放，本阶段柜体没有 Z 坐标，核不了谁在上；若真叠放总高约 ${num(c, 'total')}。`,
    hint: (c) => `这条已按你说的记下来了，但没有被校验 —— 要真校验得先给柜体加 Z；或者用同一柜内上下两行 rows 表达分层（${num(c, 'hA')}+${num(c, 'hB')}=${num(c, 'total')}），那个是能算的。`,
    manual: '这是已知限制，不是错误：宁可如实说"没核"，不可假装核过。',
  },

  // ═══════════════ 设计方案 DesignProposal（v0.3，P3）═══════════════
  //
  // 这一族校验的是**还没进模型的方案**。所以引用用 ref（柜还没建、没有 id），
  // 尺寸说的是"能不能建"，不是"建得好不好" —— 后者交给模型落位后的规则校验。
  // 与组合那一族的分工：那边验"已在模型里的组合"，这边验"还在纸上的方案"。
  'PROPOSAL-EMPTY': {
    title: '方案里没有柜体',
    severity: 'ERROR',
    message: (c) => `这份设计方案里一个柜体都没有（cabinets 只有 ${num(c, 'count')} 项）。`,
    hint: () => '至少说清要 1 个柜体（宽/高/深与内部分区可以后补，系统会按规则集默认值补齐）。',
    manual: '方案为空没有可预览、可确认的东西。',
  },
  'PROPOSAL-ROOM-MISSING': {
    title: '方案指向不存在的房间',
    severity: 'ERROR',
    message: (c) => `方案里的房间「${str(c, 'room')}」在项目里找不到（项目现在有 ${num(c, 'count')} 个房间：${str(c, 'names')}）。`,
    hint: (c) => `把房间改成现有这 ${num(c, 'count')} 个之一：${str(c, 'names')}。`,
    manual: '柜子要落在某个房间里，房间归属是设计决定。',
  },
  'PROPOSAL-CAB-NO-REF': {
    title: '柜体缺方案内引用名',
    severity: 'ERROR',
    message: (c) => `方案里第 ${num(c, 'index')} 个柜体没有 ref（组合要靠它引用这个柜）。`,
    hint: (c) => `给第 ${num(c, 'index')} 个柜体补一个 ref（比如 "cab1"）—— 柜体 id 要等真建出来才有，方案里只能用 ref。`,
    manual: 'ref 是方案内部的引用名，与模型 id 无关。',
  },
  'PROPOSAL-CAB-DUP-REF': {
    title: '方案内引用名重复',
    severity: 'ERROR',
    message: (c) => `方案里 ref「${str(c, 'ref')}」出现了 ${num(c, 'count')} 次。`,
    hint: (c) => `每个柜体的 ref 只能有 1 个 —— 把重复的 ${num(c, 'count')} 个改成不同名字，否则组合会引用到错的那个。`,
    manual: '改名即可，不影响模型。',
  },
  'PROPOSAL-SIZE-RANGE': {
    title: '方案里的尺寸做不出来',
    severity: 'ERROR',
    message: (c) => `柜体「${str(c, 'ref')}」的${str(c, 'dim')} ${num(c, 'value')}mm 超出可建范围（${num(c, 'min')}~${num(c, 'max')}mm）。`,
    hint: (c) => `把${str(c, 'dim')}改到 ${num(c, 'min')}~${num(c, 'max')}mm 之间（现在是 ${num(c, 'value')}mm，差 ${Math.max(num(c, 'min') - num(c, 'value'), num(c, 'value') - num(c, 'max'))}mm）。`,
    manual: '这个范围与 AI 契约里的 cabinet.create 同源，改规则集即可。',
  },
  'PROPOSAL-UNIT-KIND': {
    title: '方案里的分区类型不认识',
    severity: 'ERROR',
    message: (c) => `${str(c, 'where')}第 ${num(c, 'index')} 格的分区类型「${str(c, 'kind')}」本系统不认识（可用 ${num(c, 'count')} 种：${str(c, 'kinds')}）。`,
    hint: (c) => `改成这 ${num(c, 'count')} 种之一：${str(c, 'kinds')}。`,
    manual: '分区类型是封闭词汇表（与模型 UnitSpec 同源）。',
  },
  'PROPOSAL-ASM-MIN': {
    title: '组合的柜体不够',
    severity: 'ERROR',
    message: (c) => `方案里的组合「${str(c, 'ref')}」只列了 ${num(c, 'count')} 个柜体 —— 一组至少要 2 个。`,
    hint: () => '补到 2 个及以上（1 个柜体谈不上"成组"），或把这个组合删掉。',
    manual: '一个柜体不需要成组。',
  },
  'PROPOSAL-ASM-MEMBER': {
    title: '组合引用了方案外的柜体',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'ref')}」的成员「${str(c, 'member')}」不在方案里（本方案共 ${num(c, 'count')} 个柜体）。`,
    hint: (c) => `成员只能写本方案里那 ${num(c, 'count')} 个柜体的 ref —— 想组合已有柜体，请直接在对象树里选它们成组。`,
    manual: '设计方案只负责"新建的这一组"，改动已有柜体请用对话里的编辑计划。',
  },
  'PROPOSAL-CONN-KIND': {
    title: '方案里的连接方式不认识',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'ref')}」的连接类型「${str(c, 'kind')}」不认识（可用 ${num(c, 'count')} 种：${str(c, 'kinds')}）。`,
    hint: (c) => `改成这 ${num(c, 'count')} 种之一：${str(c, 'kinds')}；不写连接也可以，建好后用「按当前落位补全连接」。`,
    manual: '连接类型是封闭词汇表（与模型 Connection 同源）。',
  },
  'PROPOSAL-CONN-REF': {
    title: '连接引用了组合外的柜体',
    severity: 'ERROR',
    message: (c) => `组合「${str(c, 'ref')}」的${str(c, 'side')}引用了「${str(c, 'member')}」，它不在这个组合的 ${num(c, 'count')} 个成员里。`,
    hint: (c) => `连接的两端必须是同一个组合的成员（这个组合有 ${num(c, 'count')} 个）。`,
    manual: '关系只描述组合内部。',
  },
  'PROPOSAL-OPEN-QUESTIONS': {
    title: '这份方案还有问题要你定',
    severity: 'WARNING',
    message: (c) => `AI 列了 ${num(c, 'count')} 个必须先问你的问题，其中第一条是：「${str(c, 'first')}」。`,
    hint: (c) => `先回答这 ${num(c, 'count')} 个问题（在下面输入框里说一句就行），方案才会被应用到模型 —— 系统不会替你把它们猜掉。`,
    manual: '这是设计决定，只能由你定：猜出来的尺寸会直接变成下料尺寸。',
  },

  // ═══════════════ Import 外部数据（v0.3，P4）══════════════
  //
  // 这一族校验的是"从外部设计数据（JSON / DXF / 酷家乐 / 图片识别）进来的东西"。
  // 与 PROPOSAL-* 的分工：PROPOSAL 是 AI 自己规划的设计方案（同链路、可复用）；
  // 这里多管三件事——来源是否可信（IMPORT-UNVERIFIED-CAPABILITY）、
  // 不确定项是否摆在脸上（IMPORT-UNCERTAINTY）、以及形状门要带数字
  // （IMPORT-SHAPE，复用契约 proposalShapeError 的字符串，不会用兜底值顶替）。
  // 阻断应用的条件：ERROR，或 IMPORT-OPEN-QUESTIONS，或 IMPORT-UNCERTAINTY ——
  // 宁可停下来问，不可替用户把估出来的尺寸猜成下料尺寸。
  'IMPORT-EMPTY': {
    title: '导入里没有柜体',
    severity: 'ERROR',
    message: (c) => {
      const n = numOrUndef(c, 'count');
      return n === undefined
        ? `这份导入数据里一个柜体都没有：${countText(c, 'count')}。`
        : `这份导入数据里一个柜体都没有（cabinets 只有 ${n} 项）。`;
    },
    hint: () => '至少给 1 个柜体（宽/高/深与内部分区可以后补，系统会按规则集默认值补齐）。',
    manual: '导入为空没有可预览、可确认的东西。',
  },
  'IMPORT-SHAPE': {
    title: '导入数据形状不对',
    severity: 'ERROR',
    message: (c) => `这份导入数据不是「柜体清单」的形状：${str(c, 'detail')}`,
    hint: () => '它应当是一个含 cabinets 数组的对象（或柜体数组）。对照 JSON 适配器的示例形状检查字段名。',
    manual: '形状门复用 aiContract.proposalShapeError —— 与服务端同一份实现，前端只是防呆。',
  },
  'IMPORT-OPEN-QUESTIONS': {
    title: '导入还有问题要你定',
    severity: 'WARNING',
    message: (c) => {
      const n = numOrUndef(c, 'count');
      if (n === undefined) return `这份导入数据有问题要你定：${countText(c, 'count')}。`;
      return `导入数据列了 ${n} 个必须先问你的问题，其中第一条是：「${str(c, 'first')}」。`;
    },
    hint: (c) => `先回答这 ${numOrUndef(c, 'count') ?? '若干'} 个问题（在下面输入框里说一句就行），才会被应用到模型 —— 系统不会替你把它们猜掉。`,
    manual: '这是设计决定，只能由你定：猜出来的尺寸会直接变成下料尺寸。',
  },
  'IMPORT-UNCERTAINTY': {
    title: '导入里有没确定的内容',
    severity: 'WARNING',
    message: (c) => {
      const n = numOrUndef(c, 'count');
      if (n === undefined) return `这份导入数据有没可靠确定的内容：${countText(c, 'count')}。`;
      return `导入数据有 ${n} 处没可靠确定的内容，其中第一条是：「${str(c, 'first')}」。`;
    },
    hint: () => `这些不确定项必须你确认后才能落地（不确定的部分会按规则集默认或标注估算）。在对话框里说一句怎么定，或编辑导入数据补上。`,
    manual: '不确定就问不猜：把"估的"当"准的"直接下料，是生产事故。',
  },
  'IMPORT-LOW-CONFIDENCE': {
    title: '导入整体置信度偏低',
    severity: 'WARNING',
    message: (c) => {
      const n = numOrUndef(c, 'count');
      const cabNote = n === undefined ? '柜体' + countText(c, 'count') : `${n} 个柜体`;
      return `这份导入数据整体置信度偏低（${cabNote}来自 ${str(c, 'sources')}），导入结果可能需要你逐柜核对。`;
    },
    hint: () => '预览时可以逐柜看来源与不确定项；确认无误再应用。',
    manual: '低置信度不阻断，但请逐柜核对再下料。',
  },
  'IMPORT-UNVERIFIED-CAPABILITY': {
    title: '导入用到了尚未验证的能力',
    severity: 'WARNING',
    message: (c) => `来源「${str(c, 'source')}」的「${str(c, 'capability')}」能力在本环境尚未验证（P4 仅预留边界）。`,
    hint: () => '它不静默假装成功：结果会标 low 置信度并列出不确定项，请用 JSON 适配器或人工核对兜底。',
    manual: '酷家乐 / 图片识别等真实接入是 P5+ 的活，P4 只把边界画对。',
  },
  // ═══════════════ Import 图片识别 caveats（v0.3，P5）══════════════
  //
  // caveats = 「图片看见了外面、但生产上还得你定」的诚实项：真实深度、板厚、
  // 隐藏隔板、真实尺寸（无标注时只是视觉估计）等。**不阻断**——它们会被用户
  // 在预览里「已知晓并确认」后生成，并随 Cabinet.origin.uncertainty 留痕审计。
  // 与 IMPORT-UNCERTAINTY（P4 硬阻断，用于「连候选都不敢给」）分工：
  //   · caveats  → 有候选、可确认、不卡死（P5 人机协作识别链路）
  //   · uncertainty → 硬阻断（P4 占位适配器对「没真做识别」的诚实拒收）
  'IMPORT-CAVEAT': {
    title: '图片识别有需你确认的生产项',
    severity: 'WARNING',
    message: (c) => {
      const n = numOrUndef(c, 'count');
      if (n === undefined) return `这份图片识别有需你确认的生产结构：${countText(c, 'count')}。`;
      return `这份图片识别有 ${n} 项图片看不见、需你确认的生产结构，其中第一条是：「${str(c, 'first')}」。`;
    },
    hint: () => '预览里逐项「已知晓」后才会生成；它们会随 Cabinet 来源归属留痕（深度/板厚等若为估计值，下料前请复核）。',
    manual: 'Vision 不编造看不见的生产结构：这些项不是被猜掉的，而是交回给你定。',
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
