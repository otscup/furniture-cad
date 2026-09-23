import type { Cabinet, Vec2, Wall } from '../core/types.ts';
import type { Command } from '../core/commandBus.ts';
import { newCommandId } from '../core/ids.ts';
import type { GripRole } from './hitTest.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  拖动 → 语义命令 映射层（主方案 §L1 铁律 + §L10 映射表）
 *
 *  鼠标拖动柜子，产生的**不是**"把某个图元的 x 从 1000 改成 1200"，
 *  而是 { op:"cabinet.move", changes:[{path:"placement.x", op:"add", ...}] }。
 *
 *  这一层是唯一允许把"像素意图"翻译成"语义变更"的地方，
 *  它输出 Command，不输出几何，因此不违反"交互层不许碰几何"。
 *  纯函数，可穷举单测。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface GripDragPlan {
  command: Command;
  /** 拖动结束写进命令历史的摘要 */
  label: string;
  /** 拖动过程中的实时读数（状态栏） */
  readout: string;
}

const MIN_SIZE = 100;
const MAX_SIZE = 6000;
const clamp = (v: number, lo = MIN_SIZE, hi = MAX_SIZE): number => Math.max(lo, Math.min(hi, v));

interface Axes {
  ax: Vec2;
  ay: Vec2;
}

/** 柜体局部轴在世界坐标下的方向：ax = 局部 +X（沿柜宽），ay = 局部 +Y（背→前） */
function axes(rotationDeg: number): Axes {
  const r = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { ax: { x: c, y: s }, ay: { x: -s, y: c } };
}

const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });

/**
 * 柜体夹点拖动 → Command
 * @param cab 拖动开始时的柜体快照（不是实时的 —— 否则位移会逐帧叠加）
 * @param pointer 本轮已捕捉后的世界坐标
 * @param startPointer 按下时的世界坐标（仅 cab-move 用）
 */
export function planCabinetGripDrag(
  cab: Cabinet,
  grip: GripRole,
  pointer: Vec2,
  startPointer: Vec2
): GripDragPlan | null {
  const o = cab.placement;
  const { ax, ay } = axes(o.rotation);
  const W = cab.params.width;

  switch (grip) {
    case 'cab-move': {
      const dx = Math.round(pointer.x - startPointer.x);
      const dy = Math.round(pointer.y - startPointer.y);
      if (dx === 0 && dy === 0) return null;
      const nx = Math.round(o.x + dx);
      const ny = Math.round(o.y + dy);
      return {
        command: {
          id: newCommandId('cabinet.move'),
          op: 'cabinet.move',
          source: 'ui',
          target: { kind: 'cabinet', id: cab.id },
          changes: [
            { path: 'placement.x', op: 'set', value: nx, unit: 'mm' },
            { path: 'placement.y', op: 'set', value: ny, unit: 'mm' },
          ],
          label: `移动「${cab.name}」到 (${nx}, ${ny})`,
        },
        label: `移动「${cab.name}」Δ(${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy})`,
        readout: `X ${nx}  Y ${ny}   Δ${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy}`,
      };
    }

    case 'cab-width-r': {
      // 左边缘（锚点）不动，右边缘跟手
      const localX = dot(sub(pointer, { x: o.x, y: o.y }), ax);
      const w = clamp(Math.round(localX));
      if (w === W) return null;
      return {
        command: {
          id: newCommandId('cabinet.resize'),
          op: 'cabinet.resize',
          source: 'ui',
          target: { kind: 'cabinet', id: cab.id },
          changes: [{ path: 'params.width', op: 'set', value: w, unit: 'mm' }],
          label: `改「${cab.name}」宽度 ${W} → ${w}`,
        },
        label: `改「${cab.name}」宽度 ${W} → ${w}`,
        readout: `宽 ${w}（左固定）`,
      };
    }

    case 'cab-width-l': {
      // 右边缘钉住不动：锚点（背左角）必须跟着挪，否则整体会漂
      const rightWorld = { x: o.x + W * ax.x, y: o.y + W * ax.y };
      const localX = -dot(sub(pointer, rightWorld), ax);
      const w = clamp(Math.round(localX));
      if (w === W) return null;
      const no = { x: rightWorld.x - w * ax.x, y: rightWorld.y - w * ax.y };
      const nx = Math.round(no.x);
      const ny = Math.round(no.y);
      return {
        command: {
          id: newCommandId('cabinet.resize'),
          op: 'cabinet.resize',
          source: 'ui',
          target: { kind: 'cabinet', id: cab.id },
          changes: [
            { path: 'params.width', op: 'set', value: w, unit: 'mm' },
            { path: 'placement.x', op: 'set', value: nx, unit: 'mm' },
            { path: 'placement.y', op: 'set', value: ny, unit: 'mm' },
          ],
          // 一条命令同时改宽与锚点：中途态永远是合法柜体，撤销也是一步到位
          label: `改「${cab.name}」宽度 ${W} → ${w}（右边缘固定）`,
        },
        label: `改「${cab.name}」宽度 ${W} → ${w}（右边缘固定）`,
        readout: `宽 ${w}（右固定）`,
      };
    }

    case 'cab-depth-f': {
      const localY = dot(sub(pointer, { x: o.x, y: o.y }), ay);
      const d = clamp(Math.round(localY));
      const D = cab.params.depth;
      if (d === D) return null;
      return {
        command: {
          id: newCommandId('cabinet.resize'),
          op: 'cabinet.resize',
          source: 'ui',
          target: { kind: 'cabinet', id: cab.id },
          changes: [{ path: 'params.depth', op: 'set', value: d, unit: 'mm' }],
          label: `改「${cab.name}」深度 ${D} → ${d}`,
        },
        label: `改「${cab.name}」深度 ${D} → ${d}`,
        readout: `深 ${d}（背面固定）`,
      };
    }

    default:
      return null;
  }
}

/** 墙端点拖动 → Command */
export function planWallGripDrag(wall: Wall, grip: GripRole, pointer: Vec2): GripDragPlan | null {
  const isStart = grip === 'wall-start';
  if (!isStart && grip !== 'wall-end') return null;
  const key = isStart ? 'start' : 'end';
  const from = isStart ? wall.start : wall.end;
  const nx = Math.round(pointer.x);
  const ny = Math.round(pointer.y);
  if (nx === from.x && ny === from.y) return null;
  const len = Math.round(Math.hypot((isStart ? wall.end.x : wall.start.x) - nx, (isStart ? wall.end.y : wall.start.y) - ny));
  return {
    command: {
      id: newCommandId('wall.move'),
      op: 'wall.move',
      source: 'ui',
      target: { kind: 'wall', id: wall.id },
      changes: [
        { path: `${key}.x`, op: 'set', value: nx, unit: 'mm' },
        { path: `${key}.y`, op: 'set', value: ny, unit: 'mm' },
      ],
      label: `改墙「${wall.name}」${isStart ? '起点' : '终点'}到 (${nx}, ${ny})`,
    },
    label: `改墙「${wall.name}」${isStart ? '起点' : '终点'}到 (${nx}, ${ny})，墙长 ${len}`,
    readout: `墙长 ${len}`,
  };
}

/** 工具提示：给状态栏显示当前夹点提示 */
export function gripHint(role: GripRole): string {
  return (
    {
      'cab-move': '移动柜体：拖动改 placement.x / placement.y',
      'cab-width-l': '改宽度（右边缘固定）：拖动改 params.width + 补偿锚点',
      'cab-width-r': '改宽度（左边缘固定）：拖动改 params.width',
      'cab-depth-f': '改深度（背面固定）：拖动改 params.depth',
      'wall-start': '改墙起点：拖动改 wall.start',
      'wall-end': '改墙终点：拖动改 wall.end',
    } as const
  )[role];
}
