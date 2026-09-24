/**
 * ══════════════════════════════════════════════════════════════════════
 *  图纸拖动 → 语义命令 的规格层
 *
 *  ── 这个文件解决什么问题 ──
 *    用户在四视图上拖动一条线，必须翻译成**一条写参数的命令**，绝不能
 *    直接改图元坐标（那就是第二个真相源）。本层只做翻译，不碰 Project。
 *
 *  ── 「能拖 / 不能拖」必须当场讲清楚 ──
 *    返回 NoDrag 时会带上 reason，界面据此告诉用户"为什么这条拖不动"。
 *    静默无反应是最伤信任的交互：用户会以为是软件坏了。
 *    典型例子：Z=0 那条底边不可拖 —— 因为模型是锚定的（0..H），
 *    拖它需要平移原点，而模型里没有这个概念。这句话要说出来。
 *
 *  ── 取值范围从哪里来 ──
 *    一律读 shared/aiContract.mjs：那儿是契约的权威登记处，
 *    本层与其同源。界面拖出来的值与 AI 能写的值，天然是同一个区间。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Cabinet, Vec2 } from '../core/types.ts';
import type { Command } from '../core/commandBus.ts';
import type { CabinetPart, PickLine } from '../core/geometry/pickLines.ts';
import { PART_ZH } from '../core/geometry/pickLines.ts';
import * as CMD from '../core/commands.ts';
import { newCommandId } from '../core/ids.ts';
import { ACTIONS, unitParamRange } from '../../shared/aiContract.mjs';

/** 每 1mm 都算数 —— 生产尺寸禁止浮点（项目铁律第 7 条） */
const mm = (v: number): number => Math.round(v);

/** 契约登记的取值区间（动作表演式），这里只读不抄 */
function rangeOf(action: string, param: string): { min: number; max: number } {
  const p = (ACTIONS as Record<string, { params?: Record<string, { min?: number; max?: number }> }>)[action]?.params?.[param];
  if (!p || p.min === undefined || p.max === undefined) return { min: 0, max: Number.MAX_SAFE_INTEGER };
  return { min: p.min, max: p.max };
}

export interface SheetDragSpec {
  part: CabinetPart;
  labelZh: string;
  /** 读世界坐标拖动的哪个轴 */
  axis: 'x' | 'y';
  /**
   * 世界位移 → 参数增量的符号。
   * 之所以需要它：各视图的轴含义不同，俯视图的进深轴还是反的
   * （mapTop: y = ty0 - Y），没有它就会出现"往反方向变"的经典事故。
   */
  sign: 1 | -1;
  /** 给用户的操作提示（状态栏读数） */
  hintZh: string;
  min: number;
  max: number;
  read: (cab: Cabinet) => number;
  build: (cab: Cabinet, unitIndex: number, value: number) => Command;
}

export type DragPlan =
  | { ok: true; spec: SheetDragSpec }
  | { ok: false; labelZh: string; reason: string };

const SIZE_RANGE = {
  width: rangeOf('cabinet.resize', 'width'),
  height: rangeOf('cabinet.resize', 'height'),
  depth: rangeOf('cabinet.resize', 'depth'),
};
const UNIT_WIDTH_RANGE = rangeOf('cabinet.setUnitWidth', 'width');
const TOE_RANGE = rangeOf('cabinet.setBodyLift', 'mm');
const GAP_RANGE = ((): { min: number; max: number } => {
  const r = unitParamRange('doors.gapMid');
  return r && r.min !== undefined ? { min: r.min, max: r.max } : { min: 0, max: 20 };
})();

const ANCHOR_REASON =
  '这条是基准边（尺寸从这一端起算）。模型没有"平移基准"这个概念，改尺寸请拖另一端';

/**
 * 一条可点线段能不能拖、拖了改什么。
 * 只看 {part, view, edge} —— 永远不看坐标：坐标是派生值，拿它当依据就又回到改几何了。
 */
export function dragPlanOf(pl: PickLine): DragPlan {
  const label = PART_ZH[pl.part];
  switch (pl.part) {
    case 'outer.width': {
      // 正视图（横向 X）与俯视图（横向 X）都在拖同一根宽轴
      if (pl.view !== 'front' && pl.view !== 'top') return { ok: false, labelZh: label, reason: '这张图上这条线不代表柜宽' };
      if (pl.edge !== 'max') return { ok: false, labelZh: label, reason: ANCHOR_REASON };
      return {
        ok: true,
        spec: {
          part: pl.part,
          labelZh: '柜宽',
          axis: 'x',
          sign: 1,
          hintZh: '左右拖 = 改柜宽',
          ...SIZE_RANGE.width,
          read: (c) => c.params.width,
          build: (c, _i, v) => CMD.resizeCabinet(c, { width: mm(v) }),
        },
      };
    }
    case 'outer.height': {
      if (pl.view !== 'front' && pl.view !== 'side') return { ok: false, labelZh: label, reason: '这张图上这条线不代表柜高' };
      if (pl.edge !== 'max') return { ok: false, labelZh: label, reason: ANCHOR_REASON };
      return {
        ok: true,
        spec: {
          part: pl.part,
          labelZh: '柜高',
          axis: 'y',
          sign: 1,
          hintZh: '上下拖 = 改柜高',
          ...SIZE_RANGE.height,
          read: (c) => c.params.height,
          build: (c, _i, v) => CMD.resizeCabinet(c, { height: mm(v) }),
        },
      };
    }
    case 'outer.depth': {
      if (pl.edge !== 'max') return { ok: false, labelZh: label, reason: ANCHOR_REASON };
      // 侧视图：横向就是进深；俯视图：纵向是进深**且反向**（y = ty0 - Y）
      const axis: 'x' | 'y' | null = pl.view === 'side' ? 'x' : pl.view === 'top' ? 'y' : null;
      if (!axis) return { ok: false, labelZh: label, reason: '这张图上这条线不代表柜深' };
      return {
        ok: true,
        spec: {
          part: pl.part,
          labelZh: '柜深',
          axis,
          sign: pl.view === 'top' ? -1 : 1,
          hintZh: pl.view === 'side' ? '左右拖 = 改柜深' : '上下拖 = 改柜深',
          ...SIZE_RANGE.depth,
          read: (c) => c.params.depth,
          build: (c, _i, v) => CMD.resizeCabinet(c, { depth: mm(v) }),
        },
      };
    }
    case 'bodyLift': {
      if (pl.view !== 'front' && pl.view !== 'side') return { ok: false, labelZh: label, reason: '这张图上这条线不代表踢脚' };
      return {
        ok: true,
        spec: {
          part: pl.part,
          labelZh: '踢脚高',
          axis: 'y',
          sign: 1,
          hintZh: '上下拖 = 改踢脚高',
          ...TOE_RANGE,
          read: (c) => c.params.bodyLift,
          build: (c, _i, v) => CMD.setBodyLift(c, mm(v)),
        },
      };
    }
    case 'unit.divider': {
      if (pl.view !== 'front' && pl.view !== 'top') return { ok: false, labelZh: label, reason: '这张图上这条线不代表分区分界' };
      const i = pl.unitIndex;
      return {
        ok: true,
        spec: {
          part: pl.part,
          labelZh: `分区 ${i + 1}/${i + 2} 分界`,
          axis: 'x',
          sign: 1,
          hintZh: '左右拖 = 改两个分区的比例（总宽不变）',
          ...UNIT_WIDTH_RANGE,
          read: (c) => c.layout.units[i]?.requestedWidth ?? 0,
          build: (c, _i, v) => dividerCommand(c, i, v),
        },
      };
    }
    case 'door.gapMid': {
      const i = pl.unitIndex;
      return {
        ok: true,
        spec: {
          part: pl.part,
          labelZh: '门扇中缝',
          axis: 'x',
          sign: 1,
          hintZh: '左右拖 = 改中缝间隙',
          ...GAP_RANGE,
          read: (c) => c.layout.units[i]?.doors?.gapMid ?? 0,
          build: (c, _unitIndex, v) => CMD.setUnitInt(c, i, 'doors.gapMid', mm(v), `门扇中缝 → ${mm(v)}mm`),
        },
      };
    }
    case 'shelf.line':
      return { ok: false, labelZh: label, reason: '层板位置由"层板数量"派生，不能拖：请在属性面板改层板数，或让 AI 改' };
    case 'drawer.divider':
      return { ok: false, labelZh: label, reason: '抽屉分格由"抽屉数量"派生，不能拖：请在属性面板改抽屉数，或让 AI 改' };
  }
}

/**
 * 拖动分区分界：左区变宽多少，右区就变窄多少（**总宽不变**）。
 * 一条命令两个 change —— 一次撤销回到原样，不允许出现"一边改了另一边没改"的中间态。
 */
function dividerCommand(cab: Cabinet, leftIndex: number, leftWidth: number): Command {
  const left = cab.layout.units[leftIndex];
  const right = cab.layout.units[leftIndex + 1];
  if (!left || !right) {
    // 不该发生（合成表只在相邻分区之间登记）：退回单区改宽，总比崩掉好
    return CMD.setUnitWidth(cab, leftIndex, mm(leftWidth));
  }
  const before = left.requestedWidth;
  const delta = before - mm(leftWidth);
  const rw = Math.max(UNIT_WIDTH_RANGE.min, right.requestedWidth + delta);
  const lw = mm(leftWidth);
  return {
    id: newCommandId('cabinet.layout'),
    op: 'cabinet.layout',
    source: 'ui',
    target: { kind: 'cabinet', id: cab.id },
    changes: [
      { path: `layout.units[${leftIndex}].requestedWidth`, op: 'set', value: lw, unit: 'mm' },
      { path: `layout.units[${leftIndex + 1}].requestedWidth`, op: 'set', value: rw, unit: 'mm' },
    ],
    label: `「${cab.name}」分区 ${leftIndex + 1}/${leftIndex + 2} 分界 → ${lw} / ${rw}mm`,
  };
}

/** 按拖动位移算出新值（夹在合法区间里），返回值已经是整数 mm */
export function dragValueOf(spec: SheetDragSpec, cab: Cabinet, startWorld: Vec2, nowWorld: Vec2): number {
  const delta = (nowWorld[spec.axis] - startWorld[spec.axis]) * spec.sign;
  const raw = spec.read(cab) + delta;
  return mm(Math.min(spec.max, Math.max(spec.min, raw)));
}

/** 是否真的被夹取了（给用户一句诚实的提示，而不是悄悄停住） */
export function dragClamped(spec: SheetDragSpec, wanted: number): boolean {
  return wanted <= spec.min || wanted >= spec.max;
}
