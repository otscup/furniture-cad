import type { UnitSpec } from './types.ts';

/**
 * 柜型预设注册表 —— Phase B「模板机制」的核心。
 *
 * 设计原则（对应 docs/Special-Cabinets-and-Sales-Drawing-Plan.md §2.2）：
 *  1. **模板 = 声明式骨架（数据），不是几何块，也不是代码分支**。
 *     它只回答"这个柜型通常分几格、每格是什么、门怎么开、外形多大"，
 *     板件/几何/清单全部由既有派生管线从 UnitSpec 现算 —— 模板不引入
 *     第二个几何来源，真相源仍然是语义参数化模型。
 *  2. **五金/材质不进模板**。makeUnit 在构造时从规则集挑（pickHinge /
 *     pickRunner / pickRod），换工厂规则集 = 五金自动跟着换。
 *  3. 模板宽度支持"固定 mm"或"占柜宽比例 { ratio }"，比例模板在
 *     放置时按实际柜宽解析，最后一个分区吃余量，保证 Σ = 柜宽。
 *  4. AI / UI / MCP / 命令行全部经由 docFactory.createCabinetFromTemplate
 *     使用模板 —— 四条通道同权同位，模板不给自己开小灶。
 */

export interface TemplateUnit {
  kind: UnitSpec['kind'];
  /** 固定宽度 mm，或按柜宽比例 */
  width: number | { ratio: number };
  /** 按 kind 解释：drawerBank = 抽屉数，shelves = 层板数 */
  count?: number;
  /** 仅 hanging：挂衣杆离柜内底高度 */
  rodHeight?: number;
  /** 门板。缺省 = 无门；显式 null 也表示无门（跟"忘了填"区分开） */
  doors?: { count: number; hingeSide?: 'left' | 'right' } | null;
  nickname?: string;
}

export interface CabinetTemplate {
  id: string;
  name: string;
  /** 工具栏 title / 命令行回显用的一句话 */
  hint: string;
  params: {
    width: number;
    height: number;
    depth: number;
    /** 缺省走 defaultCabinetParams 的 80。吊柜挂墙，不要踢脚，显式给 0 */
    bodyLift?: number;
  };
  /** 分区骨架。空数组 = 走 defaultUnits（默认三分区），保持旧行为 */
  units: TemplateUnit[];
}

export const CABINET_TEMPLATES: CabinetTemplate[] = [
  {
    id: 'default',
    name: '标准柜',
    hint: '默认三分区（窄柜单分区），与既有放置行为一致',
    params: { width: 900, height: 2400, depth: 600 },
    units: [],
  },
  {
    id: 'shoe_cabinet',
    name: '鞋柜',
    hint: '浅进深 350 · 多层层板 · 对开门',
    params: { width: 900, height: 2400, depth: 350 },
    units: [{ kind: 'shelves', width: { ratio: 1 }, count: 8, doors: { count: 2 }, nickname: '鞋格' }],
  },
  {
    id: 'wall_cabinet',
    name: '吊柜',
    hint: '矮柜 700 高 · 挂墙无踢脚 · 对开门',
    params: { width: 1200, height: 700, depth: 350, bodyLift: 0 },
    units: [{ kind: 'shelves', width: { ratio: 1 }, count: 1, doors: { count: 2 }, nickname: '吊柜格' }],
  },
  {
    id: 'tv_stand',
    name: '电视柜',
    hint: '矮柜 450 高 · 抽 + 开放设备格 + 抽',
    params: { width: 1800, height: 450, depth: 400 },
    units: [
      { kind: 'drawerBank', width: { ratio: 0.28 }, count: 2, nickname: '左抽' },
      { kind: 'shelves', width: { ratio: 0.44 }, count: 1, nickname: '设备格' },
      { kind: 'drawerBank', width: { ratio: 0.28 }, count: 2, nickname: '右抽' },
    ],
  },
];

/** 找模板；找不到抛带可用清单的错（AI 通道也能读懂） */
export function findCabinetTemplate(id: string): CabinetTemplate {
  const tpl = CABINET_TEMPLATES.find((t) => t.id === id);
  if (!tpl) {
    throw new Error(`未知柜型模板「${id}」（可用：${CABINET_TEMPLATES.map((t) => t.id).join('、')}）`);
  }
  return tpl;
}

/** 把模板的宽度声明解析成名义宽度：固定值原样，比例按柜宽取整，最后一个吃余量 */
export function resolveTemplateUnitWidths(tpl: CabinetTemplate): number[] {
  const total = tpl.params.width;
  const raw = tpl.units.map((u) => (typeof u.width === 'number' ? u.width : Math.round(total * u.width.ratio)));
  if (raw.length === 0) return [];
  const sumOthers = raw.slice(0, -1).reduce((a, b) => a + b, 0);
  raw[raw.length - 1] = total - sumOthers;
  return raw.map((w) => Math.max(1, Math.round(w)));
}
