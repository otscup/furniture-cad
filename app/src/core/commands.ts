import type { Cabinet, Connection, FurnitureAssembly, Room, RowHeight, UnitSpec, Wall } from './types.ts';
import type { Change, Command, CommandSource } from './commandBus.ts';
import type { PlacementIntentDecl } from './placement.ts';
import { newCommandId } from './ids.ts';
import { ROW_HEIGHT_FILL, unitPathPrefix, unitsAtPath } from './layoutModel.ts';
import { KIND_ZH } from './relations.ts';

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

function cmd(op: string, source: CommandSource, target: Command['target'], changes: Change[], label: string, intent?: Command['intent'], extra?: Partial<Command>): Command {
  return { id: newCommandId(op), op, source, target, changes, label, intent, ...extra };
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
 * 确定性落位（P8.1）：把 Placement Engine 解析出的位置**一条命令**写进 placement。
 *
 * 为什么不复用 moveCabinet + rotateCabinet：那是两条命令、两次版本号，
 * 中途态是"转了没挪"的半成品，撤销也要撤两次。落位是一个语义动作，
 * x/y/rotation 必须原子生效 —— 这正是 cabinet.resize 把补偿并进同一条
 * 命令的同一条理由。
 *
 * 坐标从哪来：调用方必须先过 `core/placement.ts` 的解析器
 * （resolvePlacement / resolvePlacements）。这里不做几何计算 ——
 * 命令词汇表只负责"把算好的值安全地写进去"。
 */
export function placeCabinet(
  cab: Cabinet,
  at: { x: number; y: number; rotation: number },
  source: CommandSource = 'ui',
  label?: string,
  /** 落位意图声明（P8.5-C1）：从 AI 提案的 relation/reference/face/alignment 重建；只声明不决定坐标 */
  placementIntent?: PlacementIntentDecl
): Command {
  return cmd('cabinet.place', source, cabTarget(cab.id), [
    { path: 'placement.x', op: 'set', value: Math.round(at.x), unit: 'mm' },
    { path: 'placement.y', op: 'set', value: Math.round(at.y), unit: 'mm' },
    { path: 'placement.rotation', op: 'set', value: Math.round(at.rotation), unit: 'deg' },
  ], label ?? `落位「${cab.name}」到 (${Math.round(at.x)}, ${Math.round(at.y)}) @ ${Math.round(at.rotation)}°`,
  undefined,
  placementIntent ? { placementIntent } : undefined);
}

/**
 * 镜像柜体（MI）—— 语义化映射，不是几何镜像。
 *
 * AutoCAD 的 MI 镜像一条线段；语义模型里没有线，镜像的语义等价物是
 * 【分区序列左右反序】：站在柜前看，最左的分区变成最右。
 * 门扇按等分跟随分区翻转，铰链是五金型号（无左右向）不用动。
 * 单分区柜体没有"左右"可翻 —— 总线拒绝，UI 提示而不是静默成功。
 */
// ══════════════════════════════════════════════════════════════════════
//  组合（v0.3，P2）
//
//  这一组构造器的共同点：**payload 里只有 id 与语义，没有一个坐标是这里算的**。
//  整体移动给的是"位移量"（用户拖了多少），落到哪儿由 CommandBus 套到每个成员上，
//  撞不撞仍由 detectCollisions 在提交时判 —— 关系层不产坐标，这是 P2 的硬边界。
// ══════════════════════════════════════════════════════════════════════

/** 建一个组合（成员 + 可选的关系声明） */
export function createAssembly(
  assembly: FurnitureAssembly,
  source: CommandSource = 'ui'
): Command {
  return {
    id: newCommandId('assembly.create'),
    op: 'assembly.create',
    source,
    target: { kind: 'project', id: assembly.roomId },
    changes: [],
    payload: { assembly },
    label: `新建组合「${assembly.name}」（${assembly.memberIds.length} 个柜体）`,
  };
}

export function deleteAssembly(assemblyId: string, name: string, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('assembly.delete'),
    op: 'assembly.delete',
    source,
    target: { kind: 'project', id: assemblyId },
    changes: [],
    payload: { assemblyId },
    label: `删除组合「${name}」`,
  };
}

export function addAssemblyMember(
  assemblyId: string,
  asmName: string,
  cabinetId: string,
  cabName: string,
  source: CommandSource = 'ui'
): Command {
  return {
    id: newCommandId('assembly.addMember'),
    op: 'assembly.addMember',
    source,
    target: { kind: 'project', id: assemblyId },
    changes: [],
    payload: { assemblyId, cabinetId },
    label: `把「${cabName}」加入组合「${asmName}」`,
  };
}

export function removeAssemblyMember(
  assemblyId: string,
  asmName: string,
  cabinetId: string,
  cabName: string,
  source: CommandSource = 'ui'
): Command {
  return {
    id: newCommandId('assembly.removeMember'),
    op: 'assembly.removeMember',
    source,
    target: { kind: 'project', id: assemblyId },
    changes: [],
    payload: { assemblyId, cabinetId },
    label: `把「${cabName}」移出组合「${asmName}」`,
  };
}

export function connectInAssembly(
  assemblyId: string,
  asmName: string,
  connection: Connection,
  source: CommandSource = 'ui'
): Command {
  return {
    id: newCommandId('assembly.connect'),
    op: 'assembly.connect',
    source,
    target: { kind: 'project', id: assemblyId },
    changes: [],
    payload: { assemblyId, connection },
    label: `在组合「${asmName}」里声明一条${KIND_ZH[connection.kind]}`,
  };
}

export function disconnectInAssembly(
  assemblyId: string,
  asmName: string,
  connectionId: string,
  source: CommandSource = 'ui'
): Command {
  return {
    id: newCommandId('assembly.disconnect'),
    op: 'assembly.disconnect',
    source,
    target: { kind: 'project', id: assemblyId },
    changes: [],
    payload: { assemblyId, connectionId },
    label: `删除组合「${asmName}」里的一条连接`,
  };
}

/** 整组平移：一次命令改所有成员的 placement，一次撤销回到原位 */
export function moveAssembly(
  assemblyId: string,
  asmName: string,
  dx: number,
  dy: number,
  source: CommandSource = 'ui'
): Command {
  return {
    id: newCommandId('assembly.move'),
    op: 'assembly.move',
    source,
    target: { kind: 'project', id: assemblyId },
    changes: [],
    payload: { assemblyId, dx, dy },
    label: `整体移动「${asmName}」Δ${Math.round(dx)},${Math.round(dy)}mm`,
  };
}

export function renameAssembly(assemblyId: string, name: string, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('assembly.rename'),
    op: 'assembly.rename',
    source,
    target: { kind: 'project', id: assemblyId },
    changes: [],
    payload: { assemblyId, name },
    label: `组合改名为「${name}」`,
  };
}

/**
 * 镜像柜体：分区左右反序（语义镜像，不是几何镜像）。
 * `rowIndex` 同 addUnit：多行柜必须指明翻哪一行（缺省会被 CommandBus 拒绝）。
 */
export function mirrorCabinet(cab: Cabinet, source: CommandSource = 'ui', rowIndex?: number): Command {
  const c = cmd('cabinet.mirror', source, cabTarget(cab.id), [], `镜像「${cab.name}」（分区左右反序）`);
  if (rowIndex !== undefined) c.payload = { rowIndex };
  return c;
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

export function setUnitWidth(
  cab: Cabinet,
  index: number,
  width: number,
  source: CommandSource = 'ui',
  unitBasePath: string = unitPathPrefix(cab.layout, 0)
): Command {
  const u = unitsAtPath(cab.layout, unitBasePath)[index];
  return cmd('cabinet.layout', source, cabTarget(cab.id), [
    { path: `${unitBasePath}[${index}].requestedWidth`, op: 'set', value: Math.round(width), unit: 'mm' },
  ], `「${cab.name}·${u?.nickname ?? u?.id ?? index}」净宽 → ${Math.round(width)}mm`);
}

export function setUnitInt(
  cab: Cabinet,
  index: number,
  relPath: string,
  value: number,
  label: string,
  source: CommandSource = 'ui',
  unitBasePath: string = unitPathPrefix(cab.layout, 0)
): Command {
  return cmd('cabinet.layout', source, cabTarget(cab.id), [
    { path: `${unitBasePath}[${index}].${relPath}`, op: 'set', value: Math.round(value) },
  ], `「${cab.name}」${label}`);
}

/** 分区上的字符串字段（昵称、kind） */
export function setUnitString(
  cab: Cabinet,
  index: number,
  relPath: string,
  value: string,
  label: string,
  source: CommandSource = 'ui',
  unitBasePath: string = unitPathPrefix(cab.layout, 0)
): Command {
  return cmd('cabinet.layout', source, cabTarget(cab.id), [
    { path: `${unitBasePath}[${index}].${relPath}`, op: 'set', value },
  ], `「${cab.name}」${label}`);
}

export function setWidthMode(cab: Cabinet, mode: 'fit_total' | 'fit_units', source: CommandSource = 'ui'): Command {
  return cmd('cabinet.layout', source, cabTarget(cab.id), [
    { path: 'layout.widthMode', op: 'set', value: mode },
  ], `「${cab.name}」总宽策略 → ${mode}`);
}

// ───────────── 柜体：垂直行（v0.3） ─────────────

/**
 * 改某一行的**净高** —— v0.3 引入"行"之后新增的**唯一** authored 行字段。
 *
 * `height` 只有两个合法形态：
 *   · 数字 = 该行固定净高（mm）；
 *   · `'fill'` = 吃掉剩余内高（多行柜的**唯一自由项**，且必须落在最后一行）。
 * 两者共用同一条写路径，因为它们是同一个字段的两个取值 ——
 * 如果拆成两条路径，高度链的判定就得在两处各写一遍。
 *
 * ⚠ 只对**已有 rows** 的柜体有效：单行柜的文件里根本没有 `rows` 这一层，
 * 写这条路径会被 CommandBus 的"不许凭空创建结构"拦下（见 setByPath）。
 * 也就是说"把单行柜变成多行柜"在本阶段**不是一条命令能做出来的事** ——
 * 那属于结构设计（P2），P1 只保证多行结构一旦存在就被正确地派生。
 */
export function setRowHeight(cab: Cabinet, rowIndex: number, height: RowHeight, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.layout', source, cabTarget(cab.id), [
    { path: `layout.rows[${rowIndex}].height`, op: 'set', value: height },
  ], `「${cab.name}」第 ${rowIndex + 1} 行高 → ${height === ROW_HEIGHT_FILL ? '吃掉剩余内高' : `${height}mm`}`);
}

/** 柜体 params 上的枚举/字符串字段（材质 ID、背板方式…） */
export function setCabinetParam(cab: Cabinet, relPath: string, value: string, label: string, source: CommandSource = 'ui'): Command {
  return cmd('cabinet.update', source, cabTarget(cab.id), [
    { path: `params.${relPath}`, op: 'set', value },
  ], `「${cab.name}」${label}`);
}

/**
 * 新增分区。
 * `rowIndex` 只在**多行柜**上需要（单行柜不要传，避免给旧命令加无意义的载荷字段）：
 * 多行柜不传就会被 CommandBus 拒绝 —— 因为"加到哪一行"没有合理缺省，
 * 猜错的后果是分区加到了别的楼层，而界面上显示的是"新增成功"。
 */
export function addUnit(cabId: string, cabName: string, unit: UnitSpec, source: CommandSource = 'ui', rowIndex?: number): Command {
  return {
    id: newCommandId('cabinet.layout.addUnit'),
    op: 'cabinet.layout.addUnit',
    source,
    target: cabTarget(cabId),
    changes: [],
    payload: rowIndex === undefined ? { unit } : { unit, rowIndex },
    label: `「${cabName}」新增分区 ${unit.nickname ?? unit.id}`,
  };
}

export function removeUnit(cabId: string, cabName: string, unitId: string, source: CommandSource = 'ui', rowIndex?: number): Command {
  return {
    id: newCommandId('cabinet.layout.removeUnit'),
    op: 'cabinet.layout.removeUnit',
    source,
    target: cabTarget(cabId),
    changes: [],
    payload: rowIndex === undefined ? { unitId } : { unitId, rowIndex },
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

export function deleteRoomCommand(roomId: string, roomName: string, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('room.delete'),
    op: 'room.delete',
    source,
    target: { kind: 'project', id: 'project' },
    changes: [],
    payload: { roomId },
    label: `删除房间「${roomName}」`,
  };
}

export function resizeRoomCommand(roomId: string, w: number, h: number, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('room.resize'),
    op: 'room.resize',
    source,
    target: { kind: 'project', id: 'project' },
    changes: [],
    payload: { roomId, w, h },
    label: `调整房间尺寸 → ${w}×${h}`,
  };
}

/** 重命名房间：走 room.rename 路径白名单（rooms[i].name）。index 取当前房间在数组中的位置。 */
export function renameRoomCommand(roomIndex: number, fromName: string, toName: string, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('room.rename'),
    op: 'room.rename',
    source,
    target: { kind: 'project', id: 'project' },
    changes: [{ path: `rooms[${roomIndex}].name`, op: 'set', value: toName }],
    label: `重命名房间「${fromName}」→「${toName}」`,
  };
}

// ─────────────────────────── 门窗洞口（P8.7） ───────────────────────────

const KIND_ZH_OPENING = { door: '门洞', window: '窗洞' } as const;

/**
 * 在墙上开门/窗洞。offset/width 是 authored 语义值（沿墙量），id 由总线补；
 * 世界坐标是派生的 —— 这里绝不接收 x/y。
 */
export function createOpening(
  wallId: string,
  wallName: string,
  kind: 'door' | 'window',
  offset: number,
  width: number,
  source: CommandSource = 'ui'
): Command {
  const o = { id: '', kind, offset: Math.round(offset), width: Math.round(width) };
  return {
    id: newCommandId('opening.create'),
    op: 'opening.create',
    source,
    target: { kind: 'wall', id: wallId },
    changes: [],
    payload: { wallId, opening: o },
    label: `「${wallName}」加${KIND_ZH_OPENING[kind]} ${Math.round(width)}mm @${Math.round(offset)}`,
  };
}

export function deleteOpening(wallId: string, wallName: string, openingId: string, kind: 'door' | 'window', width: number, source: CommandSource = 'ui'): Command {
  return {
    id: newCommandId('opening.delete'),
    op: 'opening.delete',
    source,
    target: { kind: 'wall', id: wallId },
    changes: [],
    payload: { wallId, openingId },
    label: `「${wallName}」删除${KIND_ZH_OPENING[kind]} ${Math.round(width)}mm`,
  };
}

/** 改洞口的位置/宽度/名字：一条命令一处语义补丁，撤销一步到位 */
export function updateOpening(
  wallId: string,
  wallName: string,
  openingId: string,
  kind: 'door' | 'window',
  width: number,
  patch: { offset?: number; width?: number; name?: string },
  source: CommandSource = 'ui'
): Command {
  const parts: string[] = [];
  if (patch.offset !== undefined) parts.push(`位置→${Math.round(patch.offset)}`);
  if (patch.width !== undefined) parts.push(`宽→${Math.round(patch.width)}`);
  if (patch.name !== undefined) parts.push(`名→${patch.name}`);
  return {
    id: newCommandId('opening.update'),
    op: 'opening.update',
    source,
    target: { kind: 'wall', id: wallId },
    changes: [],
    payload: { wallId, openingId, openingPatch: patch },
    label: `「${wallName}」的${KIND_ZH_OPENING[kind]} ${Math.round(width)}mm ${parts.join(' ')}`,
  };
}

// ───────────── 项目 ─────────────

export function renameProject(from: string, to: string, source: CommandSource = 'ui'): Command {
  return cmd('project.rename', source, { kind: 'project', id: 'project' }, [{ path: 'name', op: 'set', value: to }], `重命名项目「${from}」→「${to}」`);
}
