import type { Command } from '../core/commandBus.ts';
import type { Connection, ConnectionEdge, ConnectionKind, Cabinet, FurnitureAssembly, ImportOrigin, Project, RowHeight, RuleSet, UnitSpec } from '../core/types.ts';
import * as CMD from '../core/commands.ts';
import { createCabinet as buildCabinet, defaultCabinetParams, makeUnit } from '../core/docFactory.ts';
import { nextId } from '../core/ids.ts';
import { unitParamRange, unitIntentsSemanticError } from '../../shared/aiContract.mjs';
import { pickPartsOf } from '../core/geometry/pickLines.ts';
import { ROW_HEIGHT_FILL, allUnits, canonicalUnits, isMultiRow, layoutRows } from '../core/layoutModel.ts';
import { detectCollisions } from '../core/geometry/project.ts';
import { candidateSpots, joinSpots, nudgeOutOfWalls } from '../core/snapPlace.ts';
import { PLACEMENT_BLOCKING_CODES } from '../core/variants.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  动作 → 命令 编译器
 *
 *  这是整条 AI 链路上**唯一**把"AI 说的话"变成"能改模型的东西"的地方。
 *  它存在的理由只有一条：**AI 输出的是动作名，不是路径。**
 *
 *    模型返回    {"action":"cabinet.resize","params":{"width":1800}}
 *    编译器产出  Command{ op:'cabinet.resize', changes:[{path:'params.width',...}] }
 *
 *  路径是在这里拼的，而这里是**我们自己的代码**。模型从头到尾没有一个字节
 *  能决定"写哪个字段"。于是"AI 写入派生字段"这件事在结构上就不可能发生 ——
 *  不是靠提示词求它别这么干，而是它连表达这个意思的语法都没有。
 *
 *  ── 编译期做三类判定，任一不过就整条不产出 ──
 *    1. 指代能落地：`target.cabinetName` 必须唯一命中一个柜体；
 *       `unit` 必须命中一个分区。**命中不唯一就报错，绝不替用户挑一个。**
 *       （"我改了主卧衣柜" vs "我改了次卧衣柜" —— 猜错比报错危害大得多。）
 *    2. 功能前提成立：分区没有抽屉就不能设抽屉数 —— 报错并告诉它该用哪个动作。
 *    3. 区间合法：`value` 按 `param` 取区间（区间表在契约里，与校验器同源）。
 *
 *  ── 与服务的分工（有意为之，不是漏了）──
 *    服务端校验的是**静态**条件（参数名、类型、枚举、区间、条数上限）——
 *    它手上有契约和快照，但没有"第几个分区"的解析职责。
 *    这边校验的是**上下文**条件（柜体是否存在、分区是否存在、该分区有没有抽屉）。
 *    两边各管一段，没有重复实现。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 校验器归一化之后的动作（与 shared/aiContract.mjs 的 validateAction 输出同构） */
export interface AiAction {
  action: string;
  target: {
    cabinetId?: string;
    cabinetName?: string;
    roomId?: string;
    roomName?: string;
    unit?: number | string;
    /** 点选的部件（闭合词汇表，见 core/geometry/pickLines.ts） */
    part?: string;
    /** 圈选：作用于"当前选中的柜体集合"（由 planRunner 展开成逐柜动作） */
    scope?: 'selection';
  };
  params: Record<string, number | string>;
  reason: string;
  index: number;
  /**
   * 方案内引用名（P3 DesignProposal 用）。
   *
   * 组合要引用"本轮刚建的柜体"，而柜体 id 是总线执行的瞬间才生成的 ——
   * 编译这一刻不存在。所以编译产物里用 `$ref:<名字>` 占位，
   * 由 planRunner 在该步骤建成后换成真 id（见 planRunner 的 refs）。
   * 模型永远拿不到也不需要拿到 id —— 这是"AI 只出语义"的落点之一。
   */
  ref?: string;
  /**
   * 导入来源归属（v0.3，P4）。仅 Import 链路产出的动作带此字段；
   * 经 planRunner 的 `{...action}` 展开天然透传，最终由 createCabinet 落到 Cabinet.origin。
   * AI DesignProposal 通道不带它（它不是导入）。
   */
  origin?: ImportOrigin;
}

export type CompileResult =
  /**
   * `note` = 编译器替 AI 做过的修正。它会拼进 PlanStep.label，界面必须看得到 —— "预览 === 提交"
   * `createdId` = 这一步**会**建出来的对象 id。planRunner 用它把 `$ref:` 占位换成真 id
   * （id 在编译期就已确定并写进 command payload，所以预览与提交拿到的是同一个）。
   */
  | { ok: true; command: Command; summary: string; note?: string; createdId?: string }
  | { ok: false; error: string };

const mm = (v: number): number => Math.round(Number(v));

/**
 * 「要不要门、几扇」的意图 → makeUnit 需要的 doors 形状。
 *
 * doorCount 缺省（undefined）= **没说**，建出来是不带门的开放格；
 * 0 是明确说"不要门"，结果同样是开放格 —— 两者结果一致但语义不同，
 * 这里统一成"不挂 doors"，因为 makeUnit 里"没有 doors"就是开放格的合法表达。
 */
function doorIntentOf(doorCount: unknown): { count: number } | undefined {
  if (doorCount === undefined || doorCount === null) return undefined;
  const n = Math.round(Number(doorCount));
  return n > 0 ? { count: n } : undefined;
}

/**
 * 替新柜挑一个放得下的落位。
 *
 * ── 判据不许自己写 ──
 *   "放不放得下"只有一个答案，那就是**干涉校验器**（project.detectCollisions）。
 *   这里的 probe 只是把候选柜体塞进一份临时 Project 里去问它，
 *   谁要是在这里再写一遍 AABB，就等于种下第二份真相源 ——
 *   两边迟早会算出不一样的结论，而那正是本项目最怕的一类事故。
 *
 * ── 为什么只在 PLACEMENT_BLOCKING_CODES 上否决 ──
 *   与 variants.ts 的 placeVariant 同一个道理：柜体本身的结构问题
 *   （比如板件超幅面）跟"放哪儿"无关，拿它否决落位会导致
 *   **所有落点都被否掉**，最后退化成"随便放进去再说"。
 */
function pickFreeSpot(project: Project, cab: Cabinet, preferRotation?: number): { x: number; y: number; rotation: number } | null {
  /**
   * 拼接候选：把新柜的某一个角锚到房间内已有柜体的角点，贴着它形成 L 或续接。
   *
   * 这条是"拼接操作"能不能成立的关键。早先 `pickFreeSpot` 只从「贴墙候选」里挑，
   * 于是两条互相垂直的臂会各自贴一面墙、中间留一道缝 —— 用户要的是拐弯成 L，
   * 拿到的是两个互不相连的柜子。没给 atX / atY 时，系统应该替它把两段拼起来：
   * 新柜落位优先贴着已有的柜体，共用角点。判据仍是校验器那一份（见 joinSpots）。
   */
  const join = joinSpots(project, cab);
  let spots = candidateSpots(project, cab.roomId, cab.params.width);
  /**
   * AI 说了朝向（rotation）时，落位必须**顺着它说的朝向**去找墙。
   */
  if (preferRotation !== undefined) {
    const want = ((Math.round(preferRotation) % 360) + 360) % 360;
    spots = [...spots.filter((s) => s.rotation === want), ...spots.filter((s) => s.rotation !== want)];
  }
  // 拼接优先：能贴着已有柜体就贴（这才是"拼接"），否则才退到贴墙
  const ordered = join.length > 0 ? [...join, ...spots] : spots;
  for (const s of ordered) {
    const trial: Cabinet = { ...cab, placement: { x: s.x, y: s.y, rotation: s.rotation } };
    const draft: Project = { ...project, cabinets: [...project.cabinets, trial] };
    const bad = detectCollisions(draft).filter(
      (i) => i.severity === 'ERROR' && PLACEMENT_BLOCKING_CODES.has(i.code) && i.target.split(' / ').includes(trial.id)
    );
    if (bad.length === 0) return { x: s.x, y: s.y, rotation: s.rotation };
  }
  return null;
}

/**
 * 分区意图数组 → UnitSpec[]。
 *
 * ── 为什么 width 直接拿来当 requestedWidth，不按柜宽做归一化 ──
 *   layout.widthMode = fit_total 下柜宽是**硬约束**，分区净宽由
 *   allocateWidths 按比例摊（它连取整余量都按小数部分补齐，Σ 精确）。
 *   让 AI 给的宽之和必须等于柜宽，既没有收益，又制造了大量"差 1mm"的机会。
 *
 * ── takenIds 必须逐个累积（这条是血泪，不是洁癖）──
 *   不累积时每个分区都拿到 unit_001，而板件 id 是 `…_unit_00N_SH1` 拼出来的，
 *   多个分区同名会让**不同板件撞成同一个 id**：校验器报 DUP-PANEL-ID，
 *   更糟的是列表里两块不同的板会静默共用一条记录 —— 到了生产就是下错料。
 */
function unitsFromIntents(raw: unknown, opts: { rules: RuleSet; depth: number; takenIds?: Set<string> }): UnitSpec[] | string {
  if (!Array.isArray(raw)) return 'units 必须是一个数组';
  if (raw.length === 0) return 'units 是空数组 —— 想用默认分区就不要给这个参数';
  // 语义互斥这一层**不由编译器自己重写**，而是调用契约里同一份实现。
  // 只靠服务端拦是不够的：dryRunPlan 会直接编译"假定已合规"的动作，
  // 那样的话"{kind:'hanging', count:2}"这种坏分区能被真的建出来。
  const semantic = unitIntentsSemanticError(raw);
  if (semantic) return semantic;
  /**
   * 多行柜：每一行都要接着上一行的 id 往后排。
   * 各行自己从 unit_001 开始 = 两行共用同一条清单记录（下错料，且不报错）。
   */
  /**
   * 直接在调用方那个 Set 上累加（不拷贝）：多行柜靠它把 id 一直往后排。
   * 拷贝一份的话第二行又从 unit_001 开始，两行共用同一条清单记录。
   */
  const taken = opts.takenIds ?? new Set<string>();
  const out: UnitSpec[] = [];
  for (let i = 0; i < raw.length; i++) {
    const it = (raw[i] ?? {}) as Record<string, unknown>;
    const kind = String(it.kind ?? '') as UnitSpec['kind'];
    if (!kind) return `units 第 ${i + 1} 项缺 kind（分区类型）`;
    let unit: UnitSpec;
    try {
      unit = makeUnit({
        kind,
        requestedWidth: mm(Number(it.width ?? 0)),
        nickname: it.nickname === undefined ? undefined : String(it.nickname),
        rules: opts.rules,
        depth: opts.depth,
        count: it.count === undefined ? undefined : Number(it.count),
        rodHeight: it.rodHeight === undefined ? undefined : Number(it.rodHeight),
        doors: doorIntentOf(it.doorCount),
        takenIds: taken,
        appliance:
          kind === 'appliance'
            ? {
                name: it.applianceName === undefined ? undefined : String(it.applianceName),
                openingWidth: it.openingWidth === undefined ? undefined : Number(it.openingWidth),
                openingHeight: it.openingHeight === undefined ? undefined : Number(it.openingHeight),
                openingDepth: it.openingDepth === undefined ? undefined : Number(it.openingDepth),
                topDrawers: it.topDrawers === undefined ? undefined : Number(it.topDrawers),
              }
            : undefined,
      });
    } catch (e) {
      // makeUnit 对未知 kind 抛错 —— 转成"哪一格说错了"的人话，别让整份计划挂在一个字段名上
      return `units 第 ${i + 1} 项的分区类型「${kind}」本系统不认识（可用：drawerBank 抽屉区 / hanging 挂衣区 / shelves 层板区 / open 空区 / appliance 电器格）`;
    }
    taken.add(unit.id);
    out.push(unit);
  }
  return out;
}

/**
 * 解析"是哪个柜体"。
 *
 * 优先显式 id（AI 通常拿不到，但快照里给了 index/id，模型偶尔会用）；
 * 否则按名字：**先全等，再唯一子串**。子串命中多个 → 报错并列出候选，
 * 不按"第一个"或"最像的那个"挑。
 */
export function resolveCabinet(project: Project, target: AiAction['target']): Cabinet | string {
  if (target.cabinetId) {
    const hit = project.cabinets.find((c) => c.id === target.cabinetId);
    return hit ?? `找不到 id 为 ${target.cabinetId} 的柜体`;
  }
  const name = target.cabinetName;
  if (!name) return '没有指明是哪个柜体（需要 target.cabinetName）';
  const exact = project.cabinets.filter((c) => c.name === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return `有 ${exact.length} 个柜体都叫「${name}」，请说清是哪一个`;
  const fuzzy = project.cabinets.filter((c) => c.name.includes(name) || name.includes(c.name));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) return `「${name}」匹配到多个柜体：${fuzzy.map((c) => c.name).join('、')} —— 请用完整名字`;
  return `找不到柜体「${name}」（现有：${project.cabinets.map((c) => c.name).join('、') || '无'}）`;
}

/**
 * 解析"是哪个分区"。1 起序号，或昵称。
 *
 * 返回 0 起的 index —— 因为 CommandBus 的路径用的是数组下标。
 * 这个 +1/−1 的换算只在这里做一次，界面上给用户看的永远是 1 起序号。
 */
export function resolveUnitIndex(cab: Cabinet, ref: number | string | undefined): number | string {
  /**
   * ⚠ 多行柜（v0.3）：本阶段 AI 还**不能指定"哪一行"**。
   *
   * 这里必须**拒绝**，而不是默认取第 0 行：多行柜的"第 2 分区"在每一行里都存在，
   * 缺行信息时无法确定对象。猜错一行的后果是**安静改错分区** ——
   * 拒绝看得见（用户能换个说法），改错看不见（最后变成车间下错料）。
   * 这与本文件其它地方"宁可报错不许猜"的口径一致。
   *
   * 界面上直接改不受影响：界面知道用户点的是哪一行（PickLine 带 rowIndex）。
   */
  if (isMultiRow(cab.layout)) {
    return `柜体「${cab.name}」分了上下 ${layoutRows(cab.layout).length} 行，本阶段 AI 还不能指定是哪一行 —— 请在界面上直接改那一行里的分区`;
  }
  /**
   * 走 canonical 取法：单行柜下它与 `layout.units` 逐项同一对象（v0.2 逐位等价）；
   * 多行柜已被上面那道闸门拦住，但**不依赖闸门的执行顺序** —— 万一将来闸门被移走，
   * 这里拿到的是空数组（走到下一行报错），而不是越界或静默改到别的行。
   */
  const units = canonicalUnits(cab.layout);
  if (units.length === 0) return `柜体「${cab.name}」没有任何分区`;
  if (ref === undefined || ref === null) return '没有指明是哪个分区（需要 target.unit：1 起序号或分区昵称）';
  if (typeof ref === 'number') {
    const i = Math.round(ref) - 1;
    if (i < 0 || i >= units.length) return `分区序号 ${ref} 超出范围（该柜体有 ${units.length} 个分区）`;
    return i;
  }
  const s = String(ref);
  const exact = units.map((u, i) => ({ u, i })).filter((x) => x.u.nickname === s);
  if (exact.length === 1) return exact[0].i;
  if (exact.length > 1) return `有 ${exact.length} 个分区都叫「${s}」`;
  const fuzzy = units.map((u, i) => ({ u, i })).filter((x) => (x.u.nickname ?? '').includes(s) || s.includes(x.u.nickname ?? '\u0000'));
  if (fuzzy.length === 1) return fuzzy[0].i;
  if (fuzzy.length > 1) return `「${s}」匹配到多个分区：${fuzzy.map((x) => x.u.nickname ?? x.u.id).join('、')}`;
  return `柜体「${cab.name}」里没有叫「${s}」的分区（现有：${units.map((u, i) => `${i + 1}.${u.nickname ?? u.id}`).join('、')}）`;
}

/** 分区是否具备某类功能 —— 依据是 UnitSpec 上那个子规格对象在不在 */
function hasFamily(unit: UnitSpec, family: string): boolean {
  switch (family) {
    case 'drawers':
      return Boolean(unit.drawers);
    case 'shelves':
      return Boolean(unit.shelves);
    case 'doors':
      return Boolean(unit.doors);
    case 'rod':
      return Boolean(unit.rod);
    default:
      return false;
  }
}

const FAMILY_ACTION: Record<string, string> = {
  drawers: '新建「抽屉区」（cabinet.addUnit, kind=drawerBank）',
  shelves: '新建「层板区」（cabinet.addUnit, kind=shelves）',
  doors: '门板由柜体的分区类型决定，当前动作清单里没有"给已有分区加门"',
  rod: '新建「挂衣区」（cabinet.addUnit, kind=hanging）',
};

/**
 * 编译单条动作。
 *
 * @param action 已通过契约校验的动作
 * @param project **这一步开始时**的项目 —— 多步计划的每一步都要对着上一步的结果编译，
 *                否则"先加一个分区、再改第 4 个分区"这类计划会因为下标没跟上而改错对象。
 */
export function compileAction(action: AiAction, project: Project, rules: RuleSet): CompileResult {
  // ── A4：part 目标的语义校验（点选的部件必须存在、改的路径必须与部件一致）──
  if (action.target?.scope === 'selection') {
    return { ok: false, error: 'scope:"selection" 要由 planRunner 按当前选择展开成逐柜动作，编译器不直接接受它' };
  }
  const partCheck = checkPartTarget(action, project);
  if (!partCheck.ok) return partCheck;
  const result = compileResolved(action, project, rules);
  if (result.ok && partCheck.paramPath !== undefined) {
    /**
     * 一致性校验（这就是"踢脚线不许解析成 height"的那条断言的运行时形态）：
     * AI 说要改某个部件，编译出的命令却动了别的路径 —— 拒绝。
     * 例外：placement.* 是柜体外形补偿（拖边缘钉另一边），属于同一次部件变更的一部分。
     */
    const bad = result.command.changes.find(
      (c) => c.path !== partCheck.paramPath && !c.path.startsWith('placement.')
    );
    if (bad) {
      return {
        ok: false,
        error: `这条动作要改 ${bad.path}，与你点选的部件（${action.target.part}，由 ${partCheck.paramPath} 决定）不符 —— 一个部件一条动作，不要混改`,
      };
    }
  }
  return result;
}

/**
 * part 目标的两步校验：
 *  ① 部件在该柜体上是否仍然存在（引用失效 → 报出候选清单，不许静默改别的东西 —— 对齐 resolveUnit 的做法）
 *  ② 部件落在哪个分区（多处命中且未指明 unit → 报出候选）
 */
function checkPartTarget(
  action: AiAction,
  project: Project
): { ok: true; paramPath?: string } | { ok: false; error: string } {
  const part = action.target?.part;
  if (!part) return { ok: true };
  const cab = resolveCabinet(project, action.target);
  if (typeof cab === 'string') return { ok: false, error: cab };
  const occurrences = pickPartsOf(cab).filter((x) => x.part === part);
  if (occurrences.length === 0) {
    const avail = pickPartsOf(cab).map((x) => `${x.part}(${x.unitIndex + 1})`).join('、');
    return {
      ok: false,
      error: `柜体「${cab.name}」上没有部件 "${part}"（现有：${avail || '无'}）—— 引用的那条线可能已被上一步改掉`,
    };
  }
  if (occurrences.length === 1) return { ok: true, paramPath: occurrences[0].paramPath };
  if (action.target.unit === undefined) {
    return {
      ok: false,
      error: `部件 "${part}" 在柜体「${cab.name}」上有 ${occurrences.length} 处（分区：${occurrences
        .map((x) => x.unitIndex + 1)
        .join('、')}）—— 请用 target.unit 指明是哪一个`,
    };
  }
  const i = resolveUnitIndex(cab, action.target.unit);
  if (typeof i === 'string') return { ok: false, error: i };
  const found = occurrences.find((x) => x.unitIndex === i);
  if (!found) {
    return { ok: false, error: `第 ${i + 1} 分区上没有部件 "${part}"（${part} 在分区：${occurrences.map((x) => x.unitIndex + 1).join('、')}）` };
  }
  return { ok: true, paramPath: found.paramPath };
}

function compileResolved(action: AiAction, project: Project, rules: RuleSet): CompileResult {
  const p = action.params;
  const src = 'ai' as const;

  switch (action.action) {
    // ───────────── 柜体外形 ─────────────
    case 'cabinet.resize': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const size: { width?: number; height?: number; depth?: number } = {};
      if (p.width !== undefined) size.width = mm(p.width as number);
      if (p.height !== undefined) size.height = mm(p.height as number);
      if (p.depth !== undefined) size.depth = mm(p.depth as number);
      return { ok: true, command: CMD.resizeCabinet(cab, size, src), summary: `改「${cab.name}」尺寸` };
    }

    case 'cabinet.setBodyLift': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      return { ok: true, command: CMD.setBodyLift(cab, mm(p.mm as number), src), summary: `改「${cab.name}」踢脚高` };
    }

    case 'cabinet.setWidthMode': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const mode = p.mode as 'fit_total' | 'fit_units';
      return { ok: true, command: CMD.setWidthMode(cab, mode, src), summary: `改「${cab.name}」总宽策略` };
    }

    case 'cabinet.rename': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const to = String(p.name);
      if (to === cab.name) return { ok: false, error: `「${cab.name}」本来就叫这个名字，改了等于没改` };
      return { ok: true, command: CMD.renameCabinet(cab, to, src), summary: `重命名「${cab.name}」→「${to}」` };
    }

    // ───────────── 柜体位置 ─────────────
    case 'cabinet.move': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const x = p.x === undefined ? mm(cab.placement.x) : mm(p.x as number);
      const y = p.y === undefined ? mm(cab.placement.y) : mm(p.y as number);
      return { ok: true, command: CMD.moveCabinet(cab, x, y, src), summary: `移动「${cab.name}」` };
    }

    case 'cabinet.nudge': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      return {
        ok: true,
        command: CMD.nudgeCabinet(cab, mm((p.dx as number) ?? 0), mm((p.dy as number) ?? 0), src),
        summary: `位移「${cab.name}」`,
      };
    }

    case 'cabinet.rotate': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      return { ok: true, command: CMD.rotateCabinet(cab, Number(p.deg), src), summary: `旋转「${cab.name}」` };
    }

    // ───────────── 分区 ─────────────
    case 'cabinet.setUnitWidth': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const i = resolveUnitIndex(cab, action.target.unit);
      if (typeof i === 'string') return { ok: false, error: i };
      return { ok: true, command: CMD.setUnitWidth(cab, i, mm(p.width as number), src), summary: `改「${cab.name}」第 ${i + 1} 分区净宽` };
    }

    case 'cabinet.setUnitParam': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const i = resolveUnitIndex(cab, action.target.unit);
      if (typeof i === 'string') return { ok: false, error: i };
      const unit = canonicalUnits(cab.layout)[i];
      const key = String(p.param);
      const r = unitParamRange(key);
      if (!r) return { ok: false, error: `分区参数 "${key}" 没有登记区间（契约表漏了一项）` };
      // 功能前提：分区没有这类功能就改不了 —— 报错并指出替代动作，而不是产出一条必然失败的命令
      if (!hasFamily(unit, r.family)) {
        const alt = FAMILY_ACTION[r.family] ?? '换一个动作';
        return {
          ok: false,
          error: `分区「${unit.nickname ?? unit.id}」没有${familyName(r.family)}，无法设置 ${key}。想加的话请用 ${alt}。`,
        };
      }
      const v = Number(p.value);
      if (r.integer && Math.abs(v - Math.round(v)) > 1e-9) return { ok: false, error: `${key} 必须是整数` };
      if (v < r.min || v > r.max) return { ok: false, error: `${key} = ${v} 超出区间 ${r.min}~${r.max}` };
      const label = `${paramLabel(key)} → ${v}`;
      return { ok: true, command: CMD.setUnitInt(cab, i, key, v, label, src), summary: `改「${cab.name}」第 ${i + 1} 分区 ${key}` };
    }

    case 'cabinet.renameUnit': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const i = resolveUnitIndex(cab, action.target.unit);
      if (typeof i === 'string') return { ok: false, error: i };
      const nick = String(p.nickname);
      return {
        ok: true,
        command: CMD.setUnitString(cab, i, 'nickname', nick, `分区昵称 → ${nick}`, src),
        summary: `重命名「${cab.name}」第 ${i + 1} 分区`,
      };
    }

    case 'cabinet.addUnit': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      /**
       * 多行柜：新分区加到哪一行没有合理缺省（第 0 行是最上面那行，常常不是用户想加的地方）。
       * AI 契约在本阶段没有"行"这个参数，所以明确拒绝，而不是悄悄加到第 0 行。
       */
      if (isMultiRow(cab.layout)) {
        return {
          ok: false,
          error: `柜体「${cab.name}」分了上下 ${layoutRows(cab.layout).length} 行，本阶段 AI 还不能指定新分区加到哪一行 —— 请在界面上直接加`,
        };
      }
      const kind = String(p.kind) as UnitSpec['kind'];
      if (kind === 'hanging' && p.rodHeight === undefined && p.count !== undefined) {
        // count 在 hanging 语义下没有意义，静默忽略会让人以为生效了
        return { ok: false, error: '挂衣区请用 rodHeight 指定挂衣杆高度，不要用 count（count 只用于抽屉区/层板区）' };
      }
      if (kind === 'appliance' && p.doorCount !== undefined && Number(p.doorCount) !== 0) {
        return { ok: false, error: '电器格的洞口和门在同一张脸上互相冲突 —— 不要给电器格装门（机器露前脸是常规做法）' };
      }
      // 分区 id 的唯一性必须**跨行**成立：板件 id 由 unit.id 拼出（`P_cab_unit_001_SHELF1`），
      // 两行各有一个 `unit_001` 会让两份板件在清单里合成一条 —— 静默少件。
      const taken = new Set(allUnits(cab.layout).map((u) => u.id));
      if (cab.layout.backUnits) for (const u of cab.layout.backUnits) taken.add(u.id);
      const unit = makeUnit({
        id: nextId('unit', taken),
        kind,
        requestedWidth: mm(p.requestedWidth as number),
        nickname: p.nickname === undefined ? undefined : String(p.nickname),
        rules,
        depth: cab.params.depth,
        count: p.count === undefined ? undefined : Number(p.count),
        rodHeight: p.rodHeight === undefined ? undefined : Number(p.rodHeight),
        doors: doorIntentOf(p.doorCount),
        appliance:
          kind === 'appliance'
            ? {
                name: p.applianceName === undefined ? undefined : String(p.applianceName),
                openingWidth: p.openingWidth === undefined ? undefined : Number(p.openingWidth),
                openingHeight: p.openingHeight === undefined ? undefined : Number(p.openingHeight),
                openingDepth: p.openingDepth === undefined ? undefined : Number(p.openingDepth),
                topDrawers: p.topDrawers === undefined ? undefined : Number(p.topDrawers),
              }
            : undefined,
      });
      return { ok: true, command: CMD.addUnit(cab.id, cab.name, unit, src), summary: `「${cab.name}」新增分区 ${unit.nickname ?? unit.id}` };
    }

    case 'cabinet.removeUnit': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const i = resolveUnitIndex(cab, action.target.unit);
      if (typeof i === 'string') return { ok: false, error: i };
      const rowUnits = canonicalUnits(cab.layout);
      if (rowUnits.length <= 1) return { ok: false, error: `柜体「${cab.name}」只剩一个分区，删掉就没有柜体结构了` };
      const unit = rowUnits[i];
      return { ok: true, command: CMD.removeUnit(cab.id, cab.name, unit.id, src), summary: `「${cab.name}」删除分区 ${unit.nickname ?? unit.id}` };
    }

    // ───────────── 材质 ─────────────
    case 'cabinet.setBoardMaterial': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const id = String(p.materialId);
      const bad = checkMaterial(rules, id, 'body');
      if (bad) return { ok: false, error: bad };
      return { ok: true, command: CMD.setCabinetParam(cab, 'boardMaterial', id, `柜体板 → ${rules.materials[id].name}`, src), summary: `改「${cab.name}」柜体板材质` };
    }

    case 'cabinet.setBackMaterial': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const id = String(p.materialId);
      const bad = checkMaterial(rules, id, 'back');
      if (bad) return { ok: false, error: bad };
      return { ok: true, command: CMD.setCabinetParam(cab, 'backPanel.material', id, `背板 → ${rules.materials[id].name}`, src), summary: `改「${cab.name}」背板材质` };
    }

    // ───────────── 柜体增删 ─────────────
    case 'cabinet.create': {
      const room = resolveRoom(project, action.target);
      if (typeof room === 'string') return { ok: false, error: room };
      const name = String(p.name);
      if (project.cabinets.some((c) => c.name === name)) return { ok: false, error: `已经有一个柜体叫「${name}」，名字要能分辨` };
      /** 系统替它改了落位时要写在 summary 里 —— "界面读数必须是最终会被用到的那个值" */
      let note = '';
      const base = defaultCabinetParams(rules);
      const place = { x: mm(Number(p.atX ?? 0)), y: mm(Number(p.atY ?? 0)) };
      if (p.atX === undefined && p.atY === undefined) {
        // 没给落位：放在房间内已有柜体的右侧，避免新柜与旧柜必然重叠（重叠会立刻产生干涉 ERROR）
        const same = project.cabinets.filter((c) => c.roomId === room.id);
        place.x = same.reduce((m, c) => Math.max(m, c.placement.x + c.params.width), 0);
        place.y = same.length ? same[0].placement.y : 0;
      }
      const width = p.width === undefined ? base.width : mm(Number(p.width));
      const height = p.height === undefined ? base.height : mm(Number(p.height));
      const depth = p.depth === undefined ? base.depth : mm(Number(p.depth));

      // ── 分区意图：AI 说"左边三个抽屉、右边两组对开门"时就落在这里 ──
      // 省略 units 才走默认三分区；给了就必须**完全按它说的建**，不许偷偷补默认分区。
      let units: UnitSpec[] | undefined;
      if (p.units !== undefined) {
        const built = unitsFromIntents(p.units, { rules, depth });
        if (typeof built === 'string') return { ok: false, error: built };
        units = built;
      }
      /**
       * 垂直行（P1 的形状；P3 起设计方案可以表达"上挂衣 / 下鞋抽"）。
       *
       * **分区 id 必须跨行唯一**：每行各自从 unit_001 开始，两行就会共用
       * 同一条清单记录（不报错，直接下错料）。所以 takenIds 是跨行累加的 Set。
       */
      let rows: Array<{ height?: RowHeight; units: UnitSpec[] }> | undefined;
      if (p.rows !== undefined && p.rows !== null) {
        const rawRows = p.rows as unknown as Array<Record<string, unknown>>;
        if (!Array.isArray(rawRows)) return { ok: false, error: 'rows 必须是一个数组' };
        if (rawRows.length === 0) return { ok: false, error: 'rows 是空数组 —— 想建单行柜就不要给这个参数' };
        const taken = new Set<string>();
        rows = [];
        for (let i = 0; i < rawRows.length; i++) {
          const r = (rawRows[i] ?? {}) as Record<string, unknown>;
          const built = unitsFromIntents(r.units, { rules, depth, takenIds: taken });
          if (typeof built === 'string') return { ok: false, error: built.replace('units 第', `rows 第 ${i + 1} 行的第`) };
          const h = r.height;
          rows.push({
            ...(h === undefined || h === null ? {} : { height: h === 'fill' ? ROW_HEIGHT_FILL : mm(Number(h)) }),
            units: built,
          });
        }
      }
      // 背面分区（岛台）：给了就建双面柜。排深 = (总深 - 板厚) / 2，与派生骨架同口径。
      let backUnits: UnitSpec[] | undefined;
      if (p.backUnits !== undefined) {
        const boardT = rules.materials[base.boardMaterial]?.thickness ?? 18;
        const rowDepth = Math.floor((depth - boardT) / 2);
        const built = unitsFromIntents(p.backUnits, { rules, depth: rowDepth });
        if (typeof built === 'string') return { ok: false, error: built.replace('units 第', 'backUnits（背面分区）第') };
        backUnits = built;
      }

      // 落位朝向：AI 建转角柜的第二条臂时靠它一次建到位。
      // 少了这一步就只能"先 0° 建、再 rotate"，而中间态常常撞墙 —— 严格模式下
      // 那条 create 会被当场拒掉，转角柜就永远建不出来（见契约里 rotation 参数的注释）。
      const rotation = p.rotation === undefined ? 0 : Number(p.rotation);
      const cab = buildCabinet({
        name,
        roomId: room.id,
        x: place.x,
        y: place.y,
        rotation,
        rules,
        ...(action.origin ? { origin: action.origin } : {}),
        params: { width, height, depth },
        units,
        backUnits,
        rows,
        takenIds: project.cabinets.map((c) => c.id),
      });

      // 没给落位时，替它在房间里找一个**放得下**的位置。
      // 这一步看似是"体贴"，其实是必需的：AI 只是描述了柜子长什么样，
      // 落位是系统替它定的 —— 系统把柜子塞进墙里再报一条干涉 ERROR，
      // 用户会以为是 AI 理解错了，实际是我们自己挑错了地方。
      if (p.atX === undefined || p.atY === undefined) {
        const spot = pickFreeSpot(project, cab, rotation);
        if (spot !== null) {
          cab.placement = { x: spot.x, y: spot.y, rotation: spot.rotation };
        } else {
          return {
            ok: false,
            error:
              `房间「${project.rooms.find((r) => r.id === room.id)?.name ?? room.id}」里找不到放得下「${name}」（宽 ${width}mm）的位置：贴墙的落位会撞墙或与已有柜体重叠。` +
              '请把柜宽改小一点，或显式给 atX / atY 指定落位。',
          };
        }
      } else {
        /**
         * AI 显式给了 atX / atY —— 而它手上**没有墙的坐标**，只能照房间名猜角点。
         * 实测它给的往往正好是墙的中心线（房间2 南墙 y=0、墙厚 120 → 柜体扎进墙 60mm），
         * 于是记忆门 mem_002 整份拒收，界面上只剩"未并入草案"。
         *
         * 这里不再把这份坐标当成圣旨，也不直接报错让用户卡住：
         * 沿**最小位移**把它推到与墙面相切，并把"改了、改了多少"写进 summary。
         * 判据仍然是校验器那一份（见 nudgeOutOfWalls 的注释）。
         */
        const pushed = nudgeOutOfWalls(project, cab);
        if (pushed === null) {
          return {
            ok: false,
            error:
              `「${name}」按 atX=${cab.placement.x} / atY=${cab.placement.y} 放会嵌进墙体，且推不出来（房间可能比柜子还小）。` +
              '请不要给 atX / atY，让系统自动找落位；或先把房间尺寸调大。',
          };
        }
        if (pushed.x !== cab.placement.x || pushed.y !== cab.placement.y) {
          const from = `(${cab.placement.x}, ${cab.placement.y})`;
          cab.placement = { ...cab.placement, x: pushed.x, y: pushed.y };
          note = `（给的落位 ${from} 会嵌进墙，已自动贴墙修正到 (${pushed.x}, ${pushed.y})）`;
        }
      }

      return {
        ok: true,
        command: CMD.createCabinet(cab, src),
        summary: `新建柜体「${name}」${note}`,
        note: note || undefined,
        // 方案里的组合要靠它把 `$ref:` 换成真 id（见 planRunner 的 refs）
        createdId: cab.id,
      };
    }

    case 'cabinet.duplicate': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      return { ok: true, command: CMD.duplicateCabinet(cab, mm(Number(p.offset ?? 700)), src), summary: `复制「${cab.name}」` };
    }

    case 'cabinet.delete': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      return { ok: true, command: CMD.deleteCabinet(cab, src), summary: `删除柜体「${cab.name}」` };
    }

    // ───────────── 组合（v0.3，P2）─────────────
    case 'assembly.create': {
      const name = String(p.name);
      const memberIds = p.memberIds as unknown as string[];
      /**
       * 成员 id **必须逐个查到**。这里不"尽力而为"地跳过找不到的那个：
       * 跳过 = AI 说"这三个是一组"，实际只进了两个，而界面上显示的仍是"创建成功"。
       * 宁可整条拒收并说清是哪个 id 不存在。
       */
      const missing = memberIds.filter((id) => !project.cabinets.some((c) => c.id === id));
      if (missing.length > 0) {
        return { ok: false, error: `组合成员里有找不到的柜体：${missing.join('、')}（现有柜体：${project.cabinets.map((c) => c.id).join('、') || '（项目里还没有柜体）'}）` };
      }
      const rooms = new Set(memberIds.map((id) => project.cabinets.find((c) => c.id === id)!.roomId));
      if (rooms.size > 1) {
        return { ok: false, error: `组合成员不在同一个房间（${[...rooms].join(' / ')}）—— 跨房间的组合没有意义，整组移动会把柜子搬到别的房间去` };
      }
      const roomId = [...rooms][0]!;
      const connections: Connection[] = [];
      for (const raw of (p.connections ?? []) as unknown as Array<Record<string, unknown>>) {
        const mkEnd = (v: unknown): { cabinetId: string; edge?: ConnectionEdge } | null => {
          if (typeof v === 'string') return { cabinetId: v };
          if (v && typeof v === 'object') {
            const o = v as { cabinetId?: unknown; edge?: unknown };
            if (typeof o.cabinetId !== 'string') return null;
            const e = typeof o.edge === 'string' ? (o.edge as ConnectionEdge) : undefined;
            return e ? { cabinetId: o.cabinetId, edge: e } : { cabinetId: o.cabinetId };
          }
          return null;
        };
        const a = mkEnd(raw.a);
        const b = mkEnd(raw.b);
        const kind = raw.kind as ConnectionKind;
        if (!a || !b) return { ok: false, error: '连接的 a / b 都必须是柜体 id（或 { cabinetId, edge? }）' };
        if (!memberIds.includes(a.cabinetId) || !memberIds.includes(b.cabinetId)) {
          return { ok: false, error: `连接用到的柜体不在成员列表里：${a.cabinetId} / ${b.cabinetId}` };
        }
        if (a.cabinetId === b.cabinetId) return { ok: false, error: `连接的两端是同一个柜体 ${a.cabinetId}` };
        connections.push({ id: '', kind, a, b, origin: 'authored' });
      }
      const asm: FurnitureAssembly = { id: '', name, roomId, memberIds, connections };
      return { ok: true, command: CMD.createAssembly(asm, src), summary: `新建组合「${name}」（${memberIds.length} 个柜体${connections.length ? `，${connections.length} 条连接` : ''}）` };
    }

    case 'assembly.delete': {
      const id = String(p.assemblyId);
      const asm = (project.assemblies ?? []).find((a) => a.id === id);
      if (!asm) {
        const list = (project.assemblies ?? []).map((a) => a.id).join('、');
        return { ok: false, error: `找不到组合 ${id}${list ? `（现有组合：${list}）` : '（项目里还没有任何组合）'}` };
      }
      return { ok: true, command: CMD.deleteAssembly(asm.id, asm.name, src), summary: `删除组合「${asm.name}」（不动柜体）` };
    }

    // ───────────── 项目 ─────────────
    case 'project.rename': {
      const to = String(p.name);
      if (to === project.name) return { ok: false, error: `项目本来就叫「${project.name}」` };
      return { ok: true, command: CMD.renameProject(project.name, to, src), summary: `重命名项目 →「${to}」` };
    }

    default:
      /**
       * 走到这里说明契约里加了动作、编译器没跟上。
       * 必须**明确报错**，不能静默返回一个空结果 ——
       * 静默返回会让"AI 说它改了"和"实际没改"同时成立，那是最坏的一种 bug。
       * verify/ai-acceptance.ts 的 A 组就是常驻防这一条。
       */
      return { ok: false, error: `契约里声明了动作 "${action.action}"，但编译器没有实现它 —— 两边漂移了` };
  }
}

function familyName(family: string): string {
  return { drawers: '抽屉', shelves: '层板', doors: '门', rod: '挂衣杆' }[family] ?? family;
}

/** 分区参数的中文标签 —— 会进入撤销日志，所以跟 UI 用同一套说法 */
function paramLabel(key: string): string {
  return (
    {
      'drawers.count': '抽屉数',
      'drawers.runnerLength': '滑轨长',
      'shelves.count': '层板数',
      'doors.count': '门扇数',
      'doors.gapMid': '门中缝',
      'doors.gapOuter': '门外缝',
      'rod.heightFromBottom': '挂衣杆高',
    }[key] ?? key
  );
}

/**
 * 材质能力判定。
 *
 * 判据只有一条：规则集里的 `kind`。分两种用途是因为**5mm 抽底板和 9mm 背板
 * 的 kind 都是 'back'** —— 只看 kind 会把"拿 5mm 板当柜体板"放行，
 * 而那正是最典型的"AI 看着名字差不多就选了一个"的错误。
 * 与 snapshot.ts 里的 canBeBodyBoard / canBeBack 是同一套推导。
 */
function checkMaterial(rules: RuleSet, id: string, use: 'body' | 'back'): string | null {
  const m = rules.materials[id];
  if (!m) return `规则集里没有材质 "${id}"（可选：${Object.keys(rules.materials).join('、')}）`;
  if (use === 'body') {
    if (m.kind === 'board') return null;
    const alt = Object.entries(rules.materials).filter(([, x]) => x.kind === 'board').map(([k, x]) => `${k}(${x.name})`).join('、');
    return `材质 "${id}"（${m.name}）的 kind = "${m.kind}"，只能做嵌槽件/背板，不能当柜体结构板。柜体板请从：${alt}`;
  }
  if (m.kind === 'board' || m.kind === 'back') return null;
  return `材质 "${id}"（${m.name}）的 kind = "${m.kind}"，不能用作背板`;
}

function resolveRoom(project: Project, target: AiAction['target']): { id: string } | string {
  if (project.rooms.length === 0) return '项目里还没有房间';
  if (project.rooms.length === 1) return { id: project.rooms[0].id };
  const ref = target.roomName ?? target.roomId;
  if (ref === undefined) return `项目里有 ${project.rooms.length} 个房间，需要指明 target.roomName`;
  if (typeof ref === 'number') {
    const r = project.rooms[Math.round(ref) - 1];
    return r ? { id: r.id } : `房间序号 ${ref} 超范围（共 ${project.rooms.length} 个）`;
  }
  const s = String(ref);
  const exact = project.rooms.filter((r) => r.name === s || r.id === s);
  if (exact.length === 1) return { id: exact[0].id };
  if (exact.length > 1) return `有多个房间叫「${s}」`;
  return `找不到房间「${s}」（现有：${project.rooms.map((r) => r.name).join('、')}）`;
}

/** 供验收断言：契约里声明的动作名集合（防止编译器与契约漂移时漏检） */
export const COMPILED_ACTIONS = [
  'cabinet.resize',
  'cabinet.setBodyLift',
  'cabinet.setWidthMode',
  'cabinet.rename',
  'cabinet.move',
  'cabinet.nudge',
  'cabinet.rotate',
  'cabinet.setUnitWidth',
  'cabinet.setUnitParam',
  'cabinet.renameUnit',
  'cabinet.addUnit',
  'cabinet.removeUnit',
  'cabinet.setBoardMaterial',
  'cabinet.setBackMaterial',
  'cabinet.create',
  'cabinet.duplicate',
  'cabinet.delete',
  'assembly.create',
  'assembly.delete',
  'project.rename',
] as const;
