/**
 * 图层表 —— 与 generate.ts 中写进图元的 layer 字段一一对应。
 *
 * 图层是"派生视图"的组织方式，不是模型的一部分：
 * 模型里没有 layer 字段，图层归属由生成器决定。改图层策略 = 改这张表。
 */

export interface LayerDef {
  name: string;
  label: string;
  color: string;
  /** 默认线宽（屏幕 px，不随缩放变化 —— 这是 CAD 的常态） */
  lw: number;
  defaultVisible: boolean;
  /** 出图时是否打印（Phase 5 接 CTB/STB 用） */
  plot: boolean;
  group: string;
}

export const LAYERS: LayerDef[] = [
  { name: 'A-WALL', label: '墙体', color: '#334155', lw: 1.8, defaultVisible: true, plot: true, group: '建筑' },
  { name: 'A-TEXT', label: '墙长标注', color: '#64748b', lw: 1, defaultVisible: true, plot: true, group: '建筑' },
  /**
   * 门扇开启范围（P8.9）。
   *
   * 为什么单独一个图层而不是并进 A-WALL：它是**可关掉的参考线**
   * —— 出图时要不要画门扇开启弧，是绘图规范问题，不该逼着用户
   * "要墙体就连弧一起要"。默认可见（看不见就等于没有这个功能）。
   */
  { name: 'A-DOOR-SWING', label: '门扇开启范围', color: '#0ea5e9', lw: 1.2, defaultVisible: true, plot: true, group: '建筑' },

  { name: 'F-CAB', label: '柜体外框', color: '#2563eb', lw: 2, defaultVisible: true, plot: true, group: '家具' },
  { name: 'F-CAB-STRUCT', label: '结构板', color: '#0d9488', lw: 1.6, defaultVisible: true, plot: true, group: '家具' },
  { name: 'F-CAB-FRONT', label: '门 / 抽面', color: '#d97706', lw: 2.2, defaultVisible: true, plot: true, group: '家具' },
  { name: 'F-CAB-HW', label: '五金', color: '#7c3aed', lw: 1.4, defaultVisible: true, plot: true, group: '家具' },
  { name: 'F-CAB-HIDDEN', label: '被遮挡轮廓（虚线）', color: '#94a3b8', lw: 1, defaultVisible: true, plot: true, group: '家具' },

  { name: 'F-VIEW', label: '视图框 / 投影衔接线', color: '#c026d3', lw: 0.9, defaultVisible: true, plot: true, group: '视图' },
  { name: 'F-EXPLODE', label: '分解图件号 / 引线', color: '#0f766e', lw: 1, defaultVisible: true, plot: true, group: '视图' },
  /**
   * 件号气泡的白底。单独一个图层是为了让"只出分解图线稿、不要气泡底色"
   * 成为图层开关能做的一件事，而不是要改代码。
   */
  { name: 'F-EXPLODE-BG', label: '分解图件号底色', color: '#f8fafc', lw: 1, defaultVisible: true, plot: true, group: '视图' },

  { name: 'F-DIM', label: '尺寸标注', color: '#b91c1c', lw: 1, defaultVisible: true, plot: true, group: '标注' },
  { name: 'F-TEXT', label: '文字', color: '#475569', lw: 1, defaultVisible: true, plot: true, group: '标注' },
  { name: 'F-CAD-EDIT', label: '手工图元 / 视图覆盖', color: '#0f766e', lw: 1.5, defaultVisible: true, plot: true, group: '手工编辑' },

  { name: 'PANEL_18', label: '18mm 板件', color: '#1d4ed8', lw: 1.2, defaultVisible: true, plot: true, group: '板件' },
  { name: 'PANEL_15', label: '15mm 板件', color: '#7c3aed', lw: 1.2, defaultVisible: true, plot: true, group: '板件' },
  { name: 'PANEL_9', label: '9mm 背板', color: '#0891b2', lw: 1.2, defaultVisible: true, plot: true, group: '板件' },
  { name: 'PANEL_5', label: '5mm 抽底', color: '#059669', lw: 1.2, defaultVisible: true, plot: true, group: '板件' },
];

const BY_NAME = new Map(LAYERS.map((l) => [l.name, l]));

export const FALLBACK_LAYER: LayerDef = {
  name: '0',
  label: '0（未归类）',
  color: '#94a3b8',
  lw: 1,
  defaultVisible: true,
  plot: true,
  group: '未归类',
};

export function layerOf(name: string): LayerDef {
  return BY_NAME.get(name) ?? { ...FALLBACK_LAYER, name };
}

export function defaultHiddenLayers(): Set<string> {
  return new Set(LAYERS.filter((l) => !l.defaultVisible).map((l) => l.name));
}

/** 选中/高亮的界面色（不属于任何图层，纯交互反馈） */
export const UI_COLORS = {
  bg: '#ffffff',
  gridMinor: '#eef2f7',
  gridMajor: '#dde5ee',
  axisX: '#fca5a5',
  axisY: '#a7f3d0',
  selection: '#f97316',
  selectionFill: 'rgba(249, 115, 22, 0.10)',
  hover: '#60a5fa',
  grip: '#2563eb',
  gripHot: '#ea580c',
  gripFill: '#ffffff',
  snap: '#10b981',
  tracking: '#22c55e',
  marquee: '#3b82f6',
  draft: '#0891b2',
  rubber: '#94a3b8',
  problem: '#dc2626',
};

export type ColorMap = Record<string, string>;
