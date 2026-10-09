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
  'RULE-SHARED-PANEL-BLOCKED': {
    title: '跨柜共享板尚不能生产',
    severity: 'ERROR',
    message: (c) => `共享板「${str(c, 'panelId')}」不能进入生产导出：${str(c, 'reasons')}。`,
    hint: () => '补齐并人工确认成员柜、几何/尺寸、材料饰面、封边、外挑、接缝分段、支撑及 CNC 孔位；成员或确认字段变化后须重新核对。参考孔位不是 CNC 数据。',
    manual: '系统只验证显式共享对象及其确认快照，不从相邻柜推断共享范围、拼缝、支撑或加工孔位。',
  },
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
  'DRAWING-SOURCE-STALE': {
    title: '手工覆盖引用的模型图元已变化',
    severity: 'ERROR',
    message: (c) => `二维覆盖「${str(c, 'editId')}」引用的${str(c, 'space') === 'sheet' ? '柜体图纸' : '房间平面'}模型图元已变化或消失；旧引用未隐藏任何当前生成图元。`,
    hint: () => '请检查图纸上的旧覆盖：确认后删除它，或重新选择当前生成图元并创建新覆盖；处理前禁止正式导出。',
    manual: '来源几何发生变化后无法安全推断旧覆盖应绑定到哪条新线；旧引用已失效，不会自动迁移。',
  },
  'DRAWING-SOURCE-AMBIGUOUS': {
    title: '手工覆盖对应多个候选图元',
    severity: 'ERROR',
    message: (c) => `二维覆盖「${str(c, 'editId')}」的来源指纹匹配到多个相同模型图元或多个覆盖；为避免错线，当前没有隐藏任何候选。`,
    hint: () => '请检查并清理重复源图元/重复覆盖，使来源唯一后重新绑定；处理前禁止正式导出。',
    manual: '完全相同的几何无法仅凭可见图元证明实体身份；系统选择报错并保留全部候选，不猜测要隐藏哪一个。',
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
  'RULE-PANEL-NONPOSITIVE-DIMENSION': {
    title: '板件尺寸无效，已阻断生产导出',
    severity: 'ERROR',
    message: (c) => `「${str(c, 'cabName')}」的板件「${str(c, 'panelName')}」尺寸为长 ${num(c, 'length')}×宽 ${num(c, 'width')}×厚 ${num(c, 'thickness')}mm（无效字段：${str(c, 'invalidDimensions')}）；制造板件长、宽、厚必须都是有限正数。`,
    hint: () => '请修正柜体尺寸/结构并重新生成，使每块制造板件的长、宽、厚都大于 0；此错误会阻断 CSV、PDF 和 DXF 正式导出。',
    manual: '非正尺寸板件不能开料；不要绕过导出拦截，也不要把零尺寸件当作警告处理。',
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
  'RULE-CABINET-TYPE-MOUNT': {
    title: '柜体类型与安装标高不匹配',
    severity: 'ERROR',
    message: (c) => `「${str(c, 'cabName')}」的柜型「${str(c, 'cabinetType')}」与安装底标高 ${num(c, 'mountHeight')}mm 不匹配。`,
    hint: (c) => str(c, 'cabinetType') === 'wall' ? '吊柜必须设置正数 mountHeight（柜体底板离地高度）；地柜/高柜/岛台应设为 0。' : '只有吊柜可以设置正数 mountHeight；检查 cabinetType 与 mountHeight。',
    manual: '请根据房间标高和实际安装方案填写柜型与安装高度。',
  },
  'RULE-COUNTERTOP-CUTOUT-OUT-OF-BOUNDS': {
    title: '台面预留超出柜体范围',
    severity: 'ERROR',
    message: (c) => `「${str(c, 'cabName')}」的「${str(c, 'cutoutName')}」预留 ${num(c, 'width')}×${num(c, 'depth')}mm 超出台面可用范围。`,
    hint: (c) => `预留位置需满足 x≥18、x+width≤${num(c, 'cabWidth') - 18}、y≥0、y+depth≤${num(c, 'cabDepth')}mm。`,
    manual: '调整预留位置和尺寸；系统不会自动改动水槽或灶具尺寸。',
  },
  'RULE-COUNTERTOP-CUTOUT-PLACEHOLDER': {
    title: '参考预留｜非 CNC 开孔｜待拆单确认',
    severity: 'WARNING',
    message: (c) => `「${str(c, 'cabName')}」包含 ${num(c, 'count')} 个台面参考预留；虚线仅为定位参考，非 CNC 开孔，也不代表顶板已加工。`,
    hint: () => '下单前由台面供应商复核水槽/灶具模板、边距与边缘工艺，并完成拆单；当前图纸不能作为 CNC 真开孔指令。',
    manual: '状态必须保持「参考预留｜非 CNC 开孔｜待拆单确认」，直至供应商完成复核并生成正式生产图。',
  },
  'RULE-CABINET-IN-WALL': {
    title: '柜子和墙打架',
    severity: 'ERROR',
    message: (c) =>
      `「${str(c, 'cabName')}」嵌进了墙体「${str(c, 'wallName')}」里 ${num(c, 'pen')}mm —— 墙厚 ${num(c, 'thickness')}mm，是结构，挪不开。`,
    hint: (c) => `把柜子沿墙推到贴墙面（挪出约 ${num(c, 'need')}mm），或换个位置放。`,
    manual: '往墙的哪一侧挪、挪多少，属于设计决定。',
  },
  // ═══════════════ 空间语义（v0.3，P8.7：Room / Wall / Opening）═══════════════
  //
  // 这一族回答"柜与空间实体的关系是什么"。分工红线：
  //   柜体嵌墙的硬错误仍是 RULE-CABINET-IN-WALL（geometry 层，唯一归属）——
  //   空间层不重复报穿墙，只报空间实体自身的问题与"柜盖洞口/在房间外"这类
  //   geometry 层看不见的事实。全部不给"自动移柜"式修复：怎么解是设计决定。
  'SPATIAL-WALL-ZERO': {
    title: '这段墙没有长度',
    severity: 'ERROR',
    message: (c) => `房间「${str(c, 'roomName')}」的墙「${str(c, 'wallName')}」起点和终点重合 —— 长度为 0 的墙拼不进房间边界，洞口和贴墙判断都会被它搅乱。`,
    hint: () => '拖动它的端点让墙有实际长度，或直接删除这段墙。',
    manual: '这面墙要去要去留属于设计决定。',
  },
  'SPATIAL-ROOM-OPEN': {
    title: '房间边界没有闭合',
    severity: 'WARNING',
    message: (c) => `房间「${str(c, 'roomName')}」的墙没有连成闭合回路 —— "柜体在房间内/外"这类判断需要闭合边界才有确定答案，现在只能标为未知。`,
    hint: () => '把缺口处的墙补上（端点接到相邻墙的端点上），或接受这些判断暂时未知。',
    manual: '边界画到哪算画完，属于设计决定 —— 系统不猜缺口该封在哪。',
  },
  'SPATIAL-ROOM-SHAPE': {
    title: '房间边界形状有问题',
    severity: 'ERROR',
    message: (c) => `房间「${str(c, 'roomName')}」的墙回路有问题：${str(c, 'what')} —— 边界不合法时「柜在房间内/外」的答案会自相矛盾。`,
    hint: () => '检查这间房的每面墙：端点要首尾相接成一条单一回路，不能有重复顶点、分支或互相穿过。',
    manual: '怎么改墙属于设计决定；系统不会静默替你修边界。',
  },
  'SPATIAL-OPENING-SPAN': {
    title: '洞口开到了墙外',
    severity: 'ERROR',
    message: (c) => {
      const neg = c.negOffset;
      const where = typeof neg === 'number' ? `从起点往回 ${Math.abs(neg)}mm 处才开始` : `从起点 ${num(c, 'offset')}mm 处开始、宽 ${num(c, 'width')}mm`;
      return `「${str(c, 'roomName')}」的墙「${str(c, 'wallName')}」上的${str(c, 'openingName')}${where}，但这面墙总长只有 ${num(c, 'wallLen')}mm —— 洞口超出了墙身${num(c, 'over') > 0 ? ` ${num(c, 'over')}mm` : ''}。`;
    },
    hint: (c) =>
      `洞口必须完整落在墙内：offset ≥ 0、width > 0、offset + width ≤ ${num(c, 'wallLen')}mm。把 offset 或 width 调回这个范围内（比如 width ≤ ${Math.max(0, num(c, 'wallLen') - num(c, 'offset'))}mm）。`,
    manual: '洞口开在哪个位置、开多宽，属于设计决定。',
  },
  'SPATIAL-CABINET-OUTSIDE': {
    title: '柜子在房间外',
    severity: 'WARNING',
    message: (c) => `「${str(c, 'cabName')}」整个落在房间「${str(c, 'roomName')}」的边界之外 —— 它归属这个房间，却不在房间里。`,
    hint: () => '把柜子挪回房间内，或检查房间边界是不是画错了（柜体确实该在"屋外"的话，忽略这条即可）。',
    manual: '挪柜还是改墙属于设计决定，系统不自动移柜。',
  },
  'SPATIAL-CABINET-OPENING': {
    title: '柜子盖住了门窗洞口',
    severity: 'ERROR',
    message: (c) =>
      `「${str(c, 'cabName')}」压在了「${str(c, 'roomName')}」墙「${str(c, 'wallName')}」的${str(c, 'kindZh')}（宽 ${num(c, 'width')}mm）上 —— 这个位置要留给人/光/风通过，被柜子挡住就失效了。`,
    hint: () => '把柜子沿墙挪开这段洞口，或缩小柜宽；门扇开合范围本阶段不检查，但人站的位置先要腾出来。',
    manual: '往哪挪、挪多少属于设计决定，系统不自动移柜。',
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
  // ★ P9.9 约束一：禁止静默丢字段。
  //   分区字段是**封闭词汇表**（唯一真相源 = 契约 `UNIT_INTENT_ITEM`）；方案里出现表外字段，
  //   系统既不认识、也不该装作没看见 —— 装作没看见的后果是"你以为配上了、其实没有"
  //   （AI 写 `customHardware:"blum"` 而系统静默丢掉 ⇒ 用户以为拿到了阻尼五金）。
  //   与 `PROPOSAL-UNIT-KIND` 同族同责：那一条管"值不认识"，这一条管"字段不认识"。
  //   严重级别取 WARNING（不是 ERROR）：多写一个字段不该把整份方案退回，
  //   但它必须**显式**出现在 `issues` 与 `notes` 里（界面显示为"提示"），不许无声消失。
  'PROPOSAL-UNIT-FIELD': {
    title: '方案里的分区带了不认识的字段',
    severity: 'WARNING',
    message: (c) => `${str(c, 'where')}第 ${num(c, 'index')} 格带了本系统不认识的字段「${str(c, 'field')}」（可用字段 ${num(c, 'count')} 个：${str(c, 'fields')}）。`,
    hint: (c) => `把「${str(c, 'field')}」删掉、或改成这 ${num(c, 'count')} 个字段之一：${str(c, 'fields')}。系统**不会**静默忽略它 —— 忽略了你就会以为它配上了。`,
    manual: '分区字段是封闭词汇表（与契约 UNIT_INTENT_ITEM 同源）；表外字段一律显式拒绝，不静默丢弃。',
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

  // ───── 方案里的落位意图（v0.3，P8.1：PlacementIntent）─────
  // AI 只说"想怎么放"（相邻/对齐），坐标由 Placement Engine 算 —— 方案里
  // 出现坐标字段会被形状门（aiContract.proposalShapeError）直接拒收。
  'PROPOSAL-PLACE-RELATION': {
    title: '落位关系不认识',
    severity: 'ERROR',
    message: (c) => `柜体「${str(c, 'ref')}」的落位关系「${str(c, 'relation')}」不认识（可用 ${num(c, 'count')} 种：${str(c, 'relations')}）。`,
    hint: (c) => `改成这 ${num(c, 'count')} 种之一：${str(c, 'relations')}（adjacent = 贴着参照柜放；align = 与参照柜某条边/中心齐平）。`,
    manual: '落位关系是封闭词汇表（与 core/placement.ts 同源）。',
  },
  'PROPOSAL-PLACE-REF': {
    title: '落位参照的柜体找不到',
    severity: 'ERROR',
    message: (c) => `柜体「${str(c, 'ref')}」的落位参照「${str(c, 'reference')}」既不是本方案的 ${num(c, 'count')} 个柜体之一，也不是项目里已有的柜体。`,
    hint: (c) => `参照只能写本方案的柜体 ref，或项目里已有柜体的 id / 名字（现在项目里有 ${num(c, 'existing')} 个柜体）。`,
    manual: '落位必须有参照物，系统不猜"旁边"是哪。',
  },
  'PROPOSAL-PLACE-SELF': {
    title: '柜体以自己为落位参照',
    severity: 'ERROR',
    message: (c) => `方案里第 ${num(c, 'index')} 个柜体「${str(c, 'ref')}」的落位参照写了它自己 —— 落位必须有别的柜体做参照（本方案共 ${num(c, 'count')} 个柜体）。`,
    hint: (c) => `把 reference 改成另一个柜体（要贴着谁、对齐谁就写谁；本方案共 ${num(c, 'count')} 个柜体）。`,
    manual: '自引用无法解析。',
  },
  'PROPOSAL-PLACE-SIDE': {
    title: '落位方向缺失或不认识',
    severity: 'ERROR',
    message: (c) => `柜体「${str(c, 'ref')}」的 adjacent 落位${str(c, 'why')}（side 有 ${num(c, 'count')} 种取值：${str(c, 'sides')}${str(c, 'side') !== '' ? `，收到的是「${str(c, 'side')}」` : ''}）。`,
    hint: (c) => `side 说明贴在参照柜的哪一侧，${num(c, 'count')} 选 1：${str(c, 'sides')}。`,
    manual: '方向是封闭词汇表（与 PlacementSide 同源）。',
  },
  'PROPOSAL-PLACE-ALIGNMENT': {
    title: '落位对齐方式与方向不匹配',
    severity: 'ERROR',
    message: (c) => `柜体「${str(c, 'ref')}」的落位对齐「${str(c, 'alignment')}」用错了地方（${str(c, 'where')} 可用这 ${num(c, 'count')} 种：${str(c, 'allowed')}）。`,
    hint: () => `并排（side=left/right）用 back/front/center；前后叠（side=front/back）用 left/right/center。缺省时系统按行业惯例取（并排背面齐、前后左缘齐）。`,
    manual: '对齐集合与 core/placement.ts 的 ADJACENT_ALIGNMENTS 同源。',
  },
  'PROPOSAL-PLACE-FACE': {
    title: '贴合的面缺失或不认识',
    severity: 'ERROR',
    message: (c) => `柜体「${str(c, 'ref')}」的 attach 落位${str(c, 'why')}（能贴合的面只有 ${num(c, 'count')} 个垂直面：${str(c, 'faces')}${str(c, 'face') !== '' ? `，收到的是「${str(c, 'face')}」` : ''}）。`,
    hint: (c) => `attach 要说清哪两个面贴在一起：${num(c, 'count')} 个垂直面 ${str(c, 'faces')} 选两个，且两面必须朝向相对（left↔right、front↔back）。top / bottom 需要 Z 坐标，本阶段不做。`,
    manual: '面词汇与 P2 的 ConnectionEdge 同源（core/placement.ts 直接取 relations.ts 的 EDGE_ORDER，不抄第二份）。',
  },
  'PROPOSAL-PLACE-OFFSET': {
    title: '贴合缝隙不是合法毫米数',
    severity: 'ERROR',
    message: (c) => `柜体「${str(c, 'ref')}」的 attach 缝隙「${str(c, 'offset')}」不能用 —— 缝隙只能是 0 到 ${num(c, 'max')}mm 之间的数（0 = 真正贴合）。`,
    hint: (c) => `offset 只沿贴合面的外法线留缝（${num(c, 'max')}mm 以内）；要重叠请改尺寸或位置 —— 重叠是碰撞，落位层不造。`,
    manual: 'offset 只改变解析结果，不写进几何、不进模型。',
  },
  'PROPOSAL-PLACE-CYCLE': {
    title: '落位意图互相参照成环',
    severity: 'ERROR',
    message: (c) => `柜体 ${str(c, 'refs')} 的落位意图互相参照成环 —— ${num(c, 'count')} 个柜体谁先落位没有确定答案，系统不按顺序碰运气。`,
    hint: () => '把其中一个的参照改成位置已确定的柜体（项目里已有的，或本方案里不参与互相参照的），或拆成两份方案分两次应用。',
    manual: '成环的相对落位没有唯一解，这是设计决定。',
  },
  'PROPOSAL-OPEN-QUESTIONS': {
    title: '这份方案还有问题要你定',
    severity: 'WARNING',
    message: (c) => `AI 列了 ${num(c, 'count')} 个必须先问你的问题，其中第一条是：「${str(c, 'first')}」。`,
    hint: (c) => `先回答这 ${num(c, 'count')} 个问题（在下面输入框里说一句就行），方案才会被应用到模型 —— 系统不会替你把它们猜掉。`,
    manual: '这是设计决定，只能由你定：猜出来的尺寸会直接变成下料尺寸。',
  },

  // ───── 落位后的设计语义（v0.3，P8.3：几何合法 ≠ 设计合理）─────
  //  Resolver 说"能不能放"，这一族说"放得合不合理"。全部是 **WARNING**：
  //  门脸贴邻居、L 型转错方向，在别的家具/镜像/背靠背布局里都可能是有意为之，
  //  系统没有硬规则能证明它一定非法 —— 所以只提示、不拦截、更不自动改 rotation。
  //  （能证明的一定非法由 P2 的 ASSEMBLY-* 管，本族不重复实现。）
  'DESIGN-FRONT-BLOCKED': {
    title: '门脸贴着邻居（柜门开不了）',
    severity: 'WARNING',
    message: (c) => `「${str(c, 'cabName')}」的门脸朝${str(c, 'front')}（当前 rotation ${num(c, 'rotation')}°），正贴着与它相接的「${str(c, 'otherName')}」—— 几何上接触成立（这一对里有 ${num(c, 'count')} 只柜门脸朝内），但 ${num(c, 'faceWidth')}mm 宽的门脸被挡住，柜门开不了；不朝内的朝向有 ${num(c, 'altCount')} 种。`,
    hint: (c) => `把「${str(c, 'cabName')}」换成不朝内的朝向：${str(c, 'alternatives')}。改朝向会改它占的地方，位置要按新朝向重新解析 —— 系统不会替你自动转。`,
    manual: '这是设计决定（转哪个方向由你或 AI 定）：门脸贴邻居不一定非法（背靠背、岛台可能是有意的），所以只提示不拦截。',
  },
  'DESIGN-ORIENTATION-SUSPECT': {
    title: 'L 型组合里门脸朝内',
    severity: 'WARNING',
    message: (c) => `corner（L 型）相接：几何上接触成立（这一对里有 ${num(c, 'count')} 只柜门脸朝内），但「${str(c, 'cabName')}」的门脸朝${str(c, 'front')}（rotation ${num(c, 'rotation')}°）朝的是组合内侧 —— ${num(c, 'faceWidth')}mm 宽的门脸会被另一臂挡住；同样不朝内的朝向有 ${num(c, 'altCount')} 种，本系统不替你选。`,
    hint: (c) => `L 型的转角方向没有唯一正确答案（左右转角、镜像结构都可能合理），这里只列同样不朝内的那些：${str(c, 'alternatives')}。选定朝向后位置要重新解析，系统不代劳。`,
    manual: '这不是程序缺陷，也不是硬规则：转哪个方向是设计决定，交给 AI / 用户继续决策。',
  },

  // ══════════ 统一设计验证：空间语义解释（v0.3，P8.8）══════════
  //
  // 这一族是 **P8.8 组合层**（core/designValidation）的出口：它把 P8.7 的空间事实
  // 翻译成"这在设计上意味着什么"。三条红线写在这里，改之前先读一遍：
  //
  //  ① **等级重新审查（本族的裁定标准）**
  //     硬错误（ERROR）—— 只有"已经被证明非法"的才算：
  //       · 与墙体重叠（穿墙，几何上装不进去）
  //       · 声明贴墙而事实不贴 / 贴合面不符 / 缝宽不符（声明与事实矛盾，
  //         与 P2 的"声明的连接 vs 派生接触不符"同一纪律）
  //     设计建议（WARNING）—— 几何成立但可能不合理，**不给"好坏"的裁判**：
  //       · 门脸朝墙、离墙有缝、没靠墙、门前余量、窗被挡
  //     本族**没有**"看起来不好"这类没有确定规则的等级 —— 判不出来就不发。
  //
  //  ② **不与 geometry 层重复报**：柜体嵌墙在**主规则链**里仍归
  //     RULE-CABINET-IN-WALL（geometry 层，唯一硬规则）。本族的
  //     DESIGN-CABINET-WALL-CONFLICT 是**设计验证视角**的同一事实（来源是
  //     P8.7 的 crossing 事实，不是第二次几何判定），只出现在设计验证报告里，
  //     不进 CommandBus.deriveFor 的主问题链。
  //     （例外：DESIGN-CABINET-DOOR-SWING（P8.9）的实现就在空间层，
  //      与 SPATIAL-CABINET-OPENING 同类，因此**进**主问题链 —— 见该条的归口说明。）
  //
  //  ③ **一律不给"自动移柜/自动贴墙/自动转朝向"的按钮**：怎么解是设计决定
  //     （§P8.7/P8.8 明确禁止自动修复）。每条都给得出具体数字与 manual。
  'DESIGN-CABINET-WALL-CONFLICT': {
    title: '柜子和墙重叠（穿进墙里）',
    severity: 'ERROR',
    message: (c) =>
      `「${str(c, 'cabName')}」与「${str(c, 'roomName', '房间')}」的墙「${str(c, 'wallName', '未命名墙')}」（厚 ${num(c, 'thickness')}mm）在平面上重叠 —— 柜体（深 ${num(c, 'depth')}mm）有部分穿进了墙体里，这个位置装不下它。`,
    hint: (c) =>
      `把柜子沿墙的垂直方向推开：柜深 ${num(c, 'depth')}mm 与 ${num(c, 'thickness')}mm 厚的墙至少要让开这段重叠，让柜体整个落回房间里（墙是结构，挪不开）。`,
    manual: '往墙的哪一侧挪、挪多少属于设计决定，系统不自动移柜。',
  },
  'DESIGN-CABINET-FRONT-WALL': {
    title: '柜门朝着墙（门开不了）',
    severity: 'WARNING',
    message: (c) =>
      `「${str(c, 'cabName')}」的门脸正对着墙「${str(c, 'wallName', '未命名墙')}」（墙厚 ${num(c, 'thickness')}mm）—— ${num(c, 'faceWidth')}mm 宽的门扇打开时会直接顶在墙上。`,
    hint: (c) =>
      `让门脸朝向房间内部（通常是把柜体转 180°），门脸与墙之间至少留出一扇门的宽度（约 ${num(c, 'faceWidth')}mm）。`,
    manual: '转哪个方向属于设计决定（壁龛、假墙等场景确实可能有意朝墙），系统只提示、不自动转。',
  },
  'DESIGN-CABINET-NEAR-WALL': {
    title: '柜子没贴到墙（留了缝）',
    severity: 'WARNING',
    message: (c) =>
      `「${str(c, 'cabName')}」离墙「${str(c, 'wallName', '未命名墙')}」还有 ${num(c, 'gap')}mm 缝 —— 既没贴上，也没明确拉开，缝里容易积灰、正面也不好收口。`,
    hint: (c) =>
      `要么贴上去（把柜体往墙方向挪 ${num(c, 'gap')}mm 让背面贴合），要么干脆拉开到方便打扫的距离（一般 ≥ 50mm，缝口加收口条）。`,
    manual: '贴上去还是留缝属于设计决定（踢脚线、收口条会让它必须留）。',
  },
  'DESIGN-CABINET-FLOATING': {
    title: '柜子没靠墙',
    severity: 'WARNING',
    message: (c) =>
      `「${str(c, 'cabName')}」在「${str(c, 'roomName', '房间')}」里，但没有靠着这个房间的任何一面墙（房间共 ${num(c, 'wallCount')} 面墙）—— 这是"独立摆放"的形态，不是错误。`,
    hint: () =>
      '本来就要做成岛台/独立柜的话，这条忽略即可；本来要靠墙的，把柜体挪到墙边并让背面贴合。',
    manual: '岛台、独立柜、中岛台面本来就不靠墙 —— 这是设计决定，系统只说明事实。',
  },
  'DESIGN-CABINET-NEAR-DOOR': {
    title: '柜子挡在门口附近',
    severity: 'WARNING',
    message: (c) =>
      `「${str(c, 'cabName')}」距「${str(c, 'wallName', '未命名墙')}」上的${str(c, 'openingName', '门洞')}（宽 ${num(c, 'width')}mm）只剩 ${num(c, 'gap')}mm —— 柜体没有盖住洞口，但已经站在进出要走的通道上了。`,
    hint: (c) =>
      `把柜子沿墙挪开：门洞前建议留足 ≥ 900mm 的净通道，现在只剩 ${num(c, 'gap')}mm；也可以把洞口改到别的墙段。`,
    manual: '挪柜还是改洞口属于设计决定；门扇开启范围本阶段不模拟。',
  },
  'DESIGN-WINDOW-BEHIND-CABINET': {
    title: '窗洞被柜子挡在后面',
    severity: 'WARNING',
    message: (c) =>
      `「${str(c, 'cabName')}」距「${str(c, 'wallName', '未命名墙')}」上的${str(c, 'openingName', '窗洞')}（宽 ${num(c, 'width')}mm）只剩 ${num(c, 'gap')}mm —— 采光和通风会被这只柜影响（柜体没盖住洞口，但紧贴在窗前）。`,
    hint: (c) =>
      `沿墙把柜子挪开 ${num(c, 'gap')}mm 以上，或改用矮柜（降到窗台线以下），把窗洞让出来。`,
    manual: '让不让窗、让多少属于设计决定。',
  },
  'DESIGN-ATTACH-NOT-TOUCHING': {
    title: '声明了贴墙，实际没贴上',
    severity: 'ERROR',
    message: (c) =>
      `落位声明要求「${str(c, 'cabName')}」靠墙，但它与墙「${str(c, 'wallName', '未命名墙')}」实际还差 ${num(c, 'gap')}mm，没有接触到 —— 声明与事实对不上。`,
    hint: (c) =>
      `要么把柜体往墙的方向挪 ${num(c, 'gap')}mm 让它真的贴上，要么撤回"靠墙"这个声明 —— 声明过的就要做到（与 P2 的"只校验声明"同一条纪律）。`,
    manual: '补齐落位还是改声明，属于设计决定。',
  },
  'DESIGN-ATTACH-FACE-MISMATCH': {
    title: '贴墙用错了面',
    severity: 'ERROR',
    message: (c) =>
      `落位声明的贴合面是「${str(c, 'declaredZh')}」，但「${str(c, 'cabName')}」实际贴上墙的是「${str(c, 'actualZh')}」（柜体当前 rotation ${num(c, 'rotation')}°）—— 声明与事实对不上。`,
    hint: (c) =>
      `确认哪一面临墙：要「${str(c, 'declaredZh')}」临墙，就按该朝向重新落位（当前 rotation ${num(c, 'rotation')}°）；确实是「${str(c, 'actualZh')}」临墙，就改声明。`,
    manual: '哪个面临墙是设计决定（左开门/右开门、见光板位置的要求都不同）。',
  },
  'DESIGN-ATTACH-OFFSET-MISMATCH': {
    title: '贴墙的缝隙与声明不符',
    severity: 'ERROR',
    message: (c) =>
      `落位声明要求「${str(c, 'cabName')}」与墙之间留 ${num(c, 'declared')}mm 缝，实测是 ${num(c, 'actual')}mm —— 声明与事实对不上。`,
    hint: (c) =>
      `沿墙面法线方向把柜体移动 ${Math.abs(num(c, 'actual') - num(c, 'declared'))}mm，让实际缝隙变成声明的 ${num(c, 'declared')}mm；本来就不留缝的话，把声明改成 0。`,
    manual: '留不留缝属于设计决定（踢脚线、收口条的厚度会让它必须留）。',
  },

  // ── 门扇开启（v0.3，P8.9）─────────────────────────────────────────────
  //
  // ⚠ 归口说明（读之前先看这条，免得以为是放错了族）：
  //   本条的 **实现** 在空间层（core/spatial）：它的来源是确定性几何事实
  //   ——"柜体 footprint 与门扇 90° 扫过的扇区内部重叠"，与 P8.7 的
  //   SPATIAL-CABINET-OPENING 是同一类判断，所以它**随空间校验进主问题链**
  //   （和 SPATIAL-CABINET-OPENING 一样，会出现在状态栏 / 问题列表里）。
  //   而 P8.8 那批 DESIGN-* 是"设计语义解释"，只出现在统一设计验证报告里。
  //   前缀 DESIGN- 表达的是"这是设计可用性问题"，不是"属于哪个模块"。
  //
  //   `touch`（只贴到扇区边界，≤ SPATIAL_TOL.TOUCH）不报 —— 与 P8.7 的
  //   "贴着不算穿墙"同一把尺子；`unknown`（没指定铰链/方向、房间不闭合、
  //   洞口非法）也不报 —— 判不出来就不说话。
  'DESIGN-CABINET-DOOR-SWING': {
    title: '柜子挡在门扇开启范围内（门开不了）',
    severity: 'ERROR',
    message: (c) =>
      `「${str(c, 'cabName')}」落在「${str(c, 'wallName', '未命名墙')}」上${str(c, 'openingName', '门洞')}（净宽 ${num(c, 'width')}mm）的门扇开启范围内 —— 门扇绕${str(c, 'hingeZh', '起点侧')}铰链向${str(c, 'dirZh', '室内')}转 90° 会扫到它（柜体从墙面往${str(c, 'dirZh', '室内')}探出 ${num(c, 'intrusion')}mm，门扇半径 ${num(c, 'width')}mm）。`,
    hint: (c) =>
      `门扇扫过的是以铰链为心、半径 ${num(c, 'width')}mm 的 90° 扇形：把柜体挪出这个扇形，或者改用另一侧铰链、或者让门朝另一侧开，它就不会被撞到。`,
    manual: '挪柜 / 换铰链侧 / 改开启方向都是设计决定（也可能"门就该朝这边开、柜本来就该挪"）—— 系统只报事实，不自动改。',
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
  // ─────────────── 人体工学类（按客户身高）───────────────
  'ERGO-DRAWER-HEIGHT': {
    title: '抽屉装太高，够不着',
    severity: 'WARNING',
    message: (c) => `「${str(c, 'cabName')}」的抽屉安装高度 ${num(c, 'drawerH')}mm，超过客户身高 ${num(c, 'height')}mm 对应的建议上限 ${num(c, 'limit')}mm（身高-300）—— 拉出后拿不到里面的东西。`,
    hint: (c) => `把抽屉降到 ${num(c, 'limit')}mm 以下，或把高处改成翻门/开放格。`,
    manual: '抽屉放哪层属于设计决定。',
  },
  'ERGO-ROD-HEIGHT': {
    title: '挂衣杆太高，挂不到',
    severity: 'WARNING',
    message: (c) => `「${str(c, 'cabName')}」的挂衣杆高度 ${num(c, 'rodH')}mm，超过客户身高 ${num(c, 'height')}mm 对应的建议上限 ${num(c, 'limit')}mm（身高+200）—— 挂衣服要踮脚。`,
    hint: (c) => `把挂衣杆降到 ${num(c, 'limit')}mm 以下，或加装升降挂衣杆（在图纸上注明）。`,
    manual: '挂衣杆高度属于设计决定。',
  },
  'ERGO-ROD-CLEARANCE': {
    title: '挂衣杆离上方层板太近',
    severity: 'ERROR',
    message: (c) => `「${str(c, 'cabName')}」的挂衣杆离上方层板只有 ${num(c, 'gap')}mm，小于最小 ${num(c, 'min')}mm —— 衣服挂不进去。`,
    hint: () => '把挂衣杆下移或把上方层板上移，留出至少 100mm。',
    manual: '怎么调属于设计决定。',
  },
  'ERGO-HANG-ZONE': {
    title: '挂衣区净高不够',
    severity: 'WARNING',
    message: (c) => `「${str(c, 'cabName')}」的${str(c, 'zoneType')}区净高 ${num(c, 'netH')}mm，小于建议 ${num(c, 'min')}mm —— ${str(c, 'zoneType')}会拖地或顶住。`,
    hint: (c) => `把${str(c, 'zoneType')}区净高做到 ${num(c, 'min')}mm 以上（长衣≥1400，短衣≥900）。`,
    manual: '分区高度属于设计决定。',
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
