/**
 * ══════════════════════════════════════════════════════════════════════
 *  布局的 canonical 形状（v0.3）—— rows / units 两种形状的**唯一口径点**
 *
 *  ── 为什么必须只有这一个文件知道两种形状 ──
 *  柜体内部原本只有"左右"一个维度（`layout.units` 一维数组）。v0.3 引入第二个
 *  维度：垂直的"行"（`layout.rows`）。如果让每处代码各自判断"有 rows 用 rows、
 *  没 rows 用 units"，这个分支会散落到生成器、校验器、四视图、3D、DXF、清单、
 *  UI 属性面板、AI 快照、导入导出……几十处 —— 漏掉一处的后果不是报错，而是
 *  那条路径**静默只看到第一行**（界面看着正常，清单少了上柜）。
 *  这正是本项目铁律「同一件事只许有一处实现」要防的东西。
 *
 *  所以口径固定在这里：
 *    · 读：`layoutRows()` / `canonicalUnits()` —— 一律折成**至少一行**
 *    · 写：`toFileLayout()` / `toFileProject()` —— 单行塌回 `units`，多行才写 `rows`
 *  其它模块只面对 canonical 形状（行数组），不需要知道文件里存的是哪个字段。
 *
 *  ── 读侧谁是权威 ──
 *  `rows` 存在且非空 ⇒ **rows 是权威**，`units` 只是给旧读者兜底/降级用的镜像。
 *  `rows` 缺省 ⇒ 由 `units` 折成单行（id 固定，避免每次读都生成不同的行 id）。
 *
 *  ── 写侧为何要"塌回 units" ──
 *  存量文件是 v0.2 形状（只有 units）。序列化时若把单行柜也统一改写成 rows，
 *  每个文件都会产生 diff、破坏哈希与人工 review —— 而单行柜根本没有"行"这个
 *  信息量。所以：**单行 ⇒ 逐字节保持旧形状**；多行 ⇒ 只写 rows（理由见
 *  toFileLayout 的注释：不让旧读者把第一行当成整柜、安静产出错误生产尺寸）。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { CabinetLayout, CabinetRow, Project, UnitSpec } from './types.ts';

/**
 * 单行柜的规范行 id。
 * 旧文件里没有行 id —— 迁移时给一个**稳定**的名字，而不是 `nextId()`：
 * 让"读两次得到同一个模型"，否则 diff/哈希/断言都会无端抖动。
 */
export const SINGLE_ROW_ID = 'row_001';

/** 行高缺省值 = 吃掉剩余内高（多行柜的唯一自由项） */
export const ROW_HEIGHT_FILL = 'fill' as const;

/**
 * canonical 布局：行的数组**永远 ≥ 1 行**。
 * 调用方不需要（也不许）再判断 `rows` 是否存在。
 */
export interface CanonicalLayout {
  type: CabinetLayout['type'];
  widthMode: CabinetLayout['widthMode'];
  rows: CabinetRow[];
  /** 双面柜的背面排（岛台）。与 rows 正交，不参与垂直分层。 */
  backUnits?: UnitSpec[];
}

/**
 * 读侧：任何历史形状 → 行数组（**永远 ≥ 1 行**）。
 *
 * `rows` 存在且非空时它是权威；否则把 `units` 折成一行。
 * 注意返回的是**同一批对象引用**（不是深拷贝）：这条路径在每个派生/读取里
 * 都会跑，拷贝一次就是白烧一次；调用方一律当只读用（模型只经 CommandBus 改）。
 */
export function layoutRows(layout: CabinetLayout): CabinetRow[] {
  if (Array.isArray(layout.rows) && layout.rows.length > 0) return layout.rows;
  return [{ id: SINGLE_ROW_ID, height: ROW_HEIGHT_FILL, units: layout.units ?? [] }];
}

/** 读侧：任意形状 → canonical 布局（type/widthMode/rows/backUnits） */
export function normalizeLayout(layout: CabinetLayout): CanonicalLayout {
  return {
    type: layout.type,
    widthMode: layout.widthMode,
    rows: layoutRows(layout),
    ...(Array.isArray(layout.backUnits) ? { backUnits: layout.backUnits } : {}),
  };
}

/**
 * 兼容视图：**当前几何/UI/AI 面向的"那一排"** = 第一行。
 *
 * P0 阶段它必须与 `layout.units` 逐位相等（单行等价护栏要证明的就是这件事）；
 * P1 起生成器/校验器改从这里取第一排，从而不需要知道 rows 的存在。
 */
export function canonicalUnits(layout: CabinetLayout): UnitSpec[] {
  return layoutRows(layout)[0]!.units;
}

/** 是否真的分了上下多层（≥2 行）。缺省单行 → false。 */
export function isMultiRow(layout: CabinetLayout): boolean {
  return layoutRows(layout).length > 1;
}

/** 全部行里的全部分区（按行序，行内按左→右）。用于"柜体所有分区"的遍历。 */
export function allUnits(layout: CabinetLayout): UnitSpec[] {
  return layoutRows(layout).flatMap((r) => r.units);
}

/**
 * 写侧：canonical → **文件形状**。
 *
 *   · 单行 ⇒ 只写 `units`、**不写 `rows`**。存量文件保存后逐字节不变，
 *     旧版本代码照常可读（回滚不丢数据）。
 *   · 多行 ⇒ 写 `rows`，**并且刻意不写 `units`**。
 *
 * ── 为什么多行不写 `units` 镜像（一个越过"顺手兼容"的安全决策）──
 *   若多行时也把 `rows[0].units` 写进 `units`，旧版本代码（不认识 `rows`）会
 *   把**第一行当成整柜**，按柜体全高算出板件 —— 它不会报错，只会安静地产出
 *   一份错误的生产尺寸（上层本该 480 高的层板被做成 2284 高）。
 *   少写一个字段，旧读者就在 `parseProjectFile` 里明确拒绝这个文件
 *   （"缺少 layout.units"）—— **宁可打不开，不可下错料**。
 *   这正是本文件头的哲学：拒绝比宽容好，把事故挡在车间之前。
 *
 * 未知字段原样带过：序列化不是清理器，不替调用方"顺手规范化"。
 * 键序也尽量沿用原顺序，保证 JSON 输出稳定（否则每次存盘都产生假 diff）。
 */
export function toFileLayout(layout: CabinetLayout): CabinetLayout {
  const rows = layoutRows(layout);
  const multi = rows.length > 1;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(layout)) {
    if (k === 'rows') continue; // 单行时不再写出去；多行时最后统一追加
    if (k === 'units') {
      // 单行：以 canonical 为准（内存里的 units 可能已过期）；多行：刻意省略（见上）
      if (!multi) out.units = rows[0]!.units;
      continue;
    }
    out[k] = v;
  }
  if (!multi && !('units' in out)) out.units = rows[0]!.units;
  if (multi) out.rows = rows;
  return out as unknown as CabinetLayout;
}

/**
 * 写侧（项目级）：把每个柜体的 layout 归到文件形状。**不改输入**。
 * 只做一件事，因此"存盘写出的形状"永远只有一个实现。
 */
export function toFileProject(project: Project): Project {
  const out = structuredClone(project);
  for (const cab of out.cabinets) cab.layout = toFileLayout(cab.layout);
  return out;
}
