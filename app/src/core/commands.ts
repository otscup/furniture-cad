import type { Cabinet, Room, UnitSpec, Wall } from './types.ts';
import type { Change, Command, CommandSource } from './commandBus.ts';
import { newCommandId } from './ids.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  命令词汇表 —— UI / AI / MCP / 脚本 共用的同一组构造器
 *
 *  为什么要有这一层：
 *    AI 的未来形态是 LLM 输出结构化 JSON。如果让它"自由拼 op 和 path"，
 *    它会拼出 /issues、/panels、甚至 placement 里的几何字段。
 *    把动作收敛成一个有限的、带类型检查的构造器集合，
 *    等于把"AI 能做什么"变成编译期可枚举的清单 —— 这是最便宜也最有效的防线。
 *
 *  约束：这里只产出 Command 对象，不执行、不接触 Project。
 * ══════════════════════════════════════════════════════════════════════
 */

function cmd(op: string, source: CommandSource, target: Command['target'], changes: Change[], label: string, intent?: Command['intent']): Command {
  return { id: newCommandId(op), op, source, target, changes, label, intent };
}

const cabTarget = (id: string): Command['target'] => ({ kind: 'cabinet', id });

/**
 * 位移读数的统一格式：正数必须带 + 号。
 * 审计日志里"移动 3 号柜 Δ(500, 0)"和"Δ(-500, 0)"必须一眼可分 ——
 * 少一个符号，复盘时方向就反了。
 */
const signed = (v: number): string => (v >= 0 ? `+${v}` : String(v));

// ───────────── 柜体：变换 ─────────────

export function moveCabinet(cab: Cabinet, x: number, y: number, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.move', source, cabTarget(cab.id), [
    { path: 'placement.x', op: 'set', value: Math.round(x), unit: 'mm' },
    { path: 'placement.y', op: 'set', value: Math.round(y), unit: 'mm' },
  ], `移动「${cab.name}」到 (${Math.round(x)}, ${Math.round(y)})`);
}

export function nudgeCabinet(cab: Cabinet, dx: number, dy: number, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.move', source, cabTarget(cab.id), [
    { path: 'placement.x', op: 'add', value: Math.round(dx), unit: 'mm' },
    { path: 'placement.y', op: 'add', value: Math.round(dy), unit: 'mm' },
  ], `移动「${cab.name}」Δ(${signed(Math.round(dx))}, ${signed(Math.round(dy))})`);
}

export function rotateCabinet(cab: Cabinet, deg: number, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.rotate', source, cabTarget(cab.id), [
    { path: 'placement.rotation', op: 'set', value: deg, unit: 'deg' },
  ], `旋转「${cab.name}」到 ${deg}°`);
}

/**
 * 镜像柜体（MI）—— 语义化映射，不是几何镜像。
 *
 * AutoCAD 的 MI 镜像一条线段；语义模型里没有线，镜像的语义等价物是
 * 【分区序列左右反序】：站在柜前看，最左的分区变成最右。
 * 门扇按等分跟随分区翻转，铰链是五金型号（无左右向）不用动。
 * 单分区柜体没有"左右"可翻 —— 总线拒绝，UI 提示而不是静默成功。
 */
export function mirrorCabinet(cab: Cabinet, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.mirror', source, cabTarget(cab.id), [], `镜像「${cab.name}」（分区左右反序）`);
}

/**
 * 多选移动：一次拖动 = 一条命令 = 一次撤销。
 * @param cabs 需要移动的柜体（含移动前的位置）
 * @param dx/dy 位移
 */
export function moveCabinetBatch(cabs: Cabinet[], projectOrder: Cabinet[], dx: number, dy: number, source: CommandSource = 'ui'): Command {
  const changes: Change[] = [];
  const labels: string[] = [];
  for (const cab of cabs) {
    const i = projectOrder.findIndex((c) => c.id === cab.id);
    if (i < 0) continue;
    changes.push({ path: `cabinets[${i}].placement.x`, op: 'set', value: Math.round(cab.placement.x + dx), unit: 'mm' });
    changes.push({ path: `cabinets[${i}].placement.y`, op: 'set', value: Math.round(cab.placement.y + dy), unit: 'mm' });
    labels.push(cab.name);
  }
  return cmd(
    'cabinet.moveBatch',
    source,
    { kind: 'project', id: 'project' },
    changes,
    `移动「${labels.join('、')}」Δ(${signed(Math.round(dx))}, ${signed(Math.round(dy))})`
  );
}

// ───────────── 柜体：尺寸 ─────────────

export function resizeCabinet(cab: Cabinet, size: { width?: number; height?: number; depth?: number }, source: CommandSource = 'ui'): Command {
  const changes: Change[] = [];
  if (size.width !== undefined) changes.push({ path: 'params.width', op: 'set', value: Math.round(size.width), unit: 'mm' });
  if (size.height !== undefined) changes.push({ path: 'params.height', op: 'set', value: Math.round(size.height), unit: 'mm' });
  if (size.depth !== undefined) changes.push({ path: 'params.depth', op: 'set', value: Math.round(size.depth), unit: 'mm' });
  const desc = [size.width && `宽${Math.round(size.width)}`, size.height && `高${Math.round(size.height)}`, size.depth && `深${Math.round(size.depth)}`]
    .filter(Boolean)
    .join(' ');
  return cmd('cabinet.resize', source, cabTarget(cab.id), changes, `改「${cab.name}」${desc}`);
}

export function setBodyLift(cab: Cabinet, mm: number, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.update', source, cabTarget(cab.id), [
    { path: 'params.bodyLift', op: 'set', value: mm, unit: 'mm' },
  ], `「${cab.name}」踢脚高 → ${mm}mm`);
}

/** 见光板（圆弧见光工艺，Phase E 表达异形）：none / left / right / both */
export function setFinishedEnds(cab: Cabinet, value: 'none' | 'left' | 'right' | 'both', source: CommandSource = 'ui'): Command {
  return cmd('cabinet.update', source, cabTarget(cab.id), [
    { path: 'params.finishedEnds', op: 'set', value },
  ], `「${cab.name}」见光板 → ${value === 'none' ? '无' : value}`);
}

export function renameCabinet(cab: Cabinet, name: string, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.rename', source, cabTarget(cab.id), [{ path: 'name', op: 'set', value: name }], `重命名「${cab.name}」→「${name}」`);
}

// ───────────── 柜体：分区 ─────────────

export function setUnitWidth(cab: Cabinet, index: number, width: number, source: CommandSource = 'ui'): Command {
  const u = cab.layout.units[index];
  return cmd('cabinet.layout', source, cabTarget(cab.id), [
    { path: `layout.units[${index}].requestedWidth`, op: 'set', value: Math.round(width), unit: 'mm' },
  ], `「${cab.name}·${u?.nickname ?? u?.id ?? index}」净宽 → ${Math.round(width)}mm`);
}

export function setUnitInt(cab: Cabinet, index: number, relPath: string, value: number, label: string, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.layout', source, cabTarget(cab.id), [
    { path: `layout.units[${index}].${relPath}`, op: 'set', value: Math.round(value) },
  ], `「${cab.name}」${label}`);
}

/** 分区上的字符串字段（昵称、kind） */
export function setUnitString(cab: Cabinet, index: number, relPath: string, value: string, label: string, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.layout', source, cabTarget(cab.id), [
    { path: `layout.units[${index}].${relPath}`, op: 'set', value },
  ], `「${cab.name}」${label}`);
}

export function setWidthMode(cab: Cabinet, mode: 'fit_total' | 'fit_units', source: CommandSource = 'ui'): Command {
  return cmd('cabinet.layout', source, cabTarget(cab.id), [
    { path: 'layout.widthMode', op: 'set', value: mode },
  ], `「${cab.name}」总宽策略 → ${mode}`);
}

/** 柜体 params 上的枚举/字符串字段（材质 ID、背板方式…） */
export function setCabinetParam(cab: Cabinet, relPath: string, value: string, label: string, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.update', source, cabTarget(cab.id), [
    { path: `params.${relPath}`, op: 'set', value },
  ], `「${cab.name}」${label}`);
}

export function addUnit(cabId: string, cabName: string, unit: UnitSpec, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('cabinet.layout.addUnit'),
    op: 'cabinet.layout.addUnit',
    source,
    target: cabTarget(cabId),
    changes: [],
    payload: { unit },
    label: `「${cabName}」新增分区 ${unit.nickname ?? unit.id}`,
  };
}

export function removeUnit(cabId: string, cabName: string, unitId: string, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('cabinet.layout.removeUnit'),
    op: 'cabinet.layout.removeUnit',
    source,
    target: cabTarget(cabId),
    changes: [],
    payload: { unitId },
    label: `「${cabName}」删除分区 ${unitId}`,
  };
}

// ───────────── 柜体：增删 ─────────────

export function createCabinet(cab: Cabinet, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('cabinet.create'),
    op: 'cabinet.create',
    source,
    target: { kind: 'project', id: 'project' },
    changes: [],
    payload: { cabinet: cab },
    label: `新建柜体「${cab.name}」${cab.params.width}×${cab.params.height}×${cab.params.depth}`,
  };
}

export function deleteCabinet(cab: Cabinet, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('cabinet.delete'),
    op: 'cabinet.delete',
    source,
    target: cabTarget(cab.id),
    changes: [],
    label: `删除柜体「${cab.name}」`,
  };
}

/** 复制柜体：偏移放置，避免与原柜完全重叠导致必然的干涉报错 */
export function duplicateCabinet(cab: Cabinet, offset = 700, source: CommandSource = 'ui'): Command {
  const copy: Cabinet = structuredClone(cab);
  copy.id = ''; // 交给 CommandBus 生成
  copy.name = `${cab.name} 副本`;
  copy.placement = { ...cab.placement, x: cab.placement.x + offset };
  return createCabinet(copy, source);
}

// ───────────── 墙 ─────────────

export function setWallThickness(wallId: string, wallName: string, thickness: number, source: CommandSource = 'ui'): Command {
  return cmd('wall.update', source, { kind: 'wall', id: wallId }, [
    { path: 'thickness', op: 'set', value: Math.round(thickness), unit: 'mm' },
  ], `墙「${wallName}」厚度 → ${Math.round(thickness)}mm`);
}

export function renameWall(wallId: string, from: string, to: string, source: CommandSource = 'ui'): Command {
  return cmd('wall.update', source, { kind: 'wall', id: wallId }, [{ path: 'name', op: 'set', value: to }], `重命名墙「${from}」→「${to}」`);
}

/**
 * 画一段墙。
 * 不需要先有房间：没有房间时 CommandBus 会在同一条命令里自动建一个容器房间，
 * 因此撤销是"一步回到什么都没有"，不会留下空房间。
 */
export function drawWall(wall: Wall, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('wall.create'),
    op: 'wall.create',
    source,
    target: { kind: 'project', id: 'project' },
    changes: [],
    payload: { wall },
    label: `画墙「${wall.name}」${Math.round(Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y))}mm`,
  };
}

export function deleteWall(wallId: string, wallName: string, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('wall.delete'),
    op: 'wall.delete',
    source,
    target: { kind: 'wall', id: wallId },
    changes: [],
    label: `删除墙「${wallName}」`,
  };
}

export function createRoomCommand(room: Room, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('room.create'),
    op: 'room.create',
    source,
    target: { kind: 'project', id: 'project' },
    changes: [],
    payload: { room },
    label: `新建房间「${room.name}」`,
  };
}

// ───────────── 项目 ─────────────

export function renameProject(from: string, to: string, source: CommandSource = 'ui'): Command {
  return cmd('project.rename', source, { kind: 'project', id: 'project' }, [{ path: 'name', op: 'set', value: to }], `重命名项目「${from}」→「${to}」`);
}
