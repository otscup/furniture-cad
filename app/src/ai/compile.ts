import type { Command } from '../core/commandBus.ts';
import type { Cabinet, Project, RuleSet, UnitSpec } from '../core/types.ts';
import * as CMD from '../core/commands.ts';
import { createCabinet as buildCabinet, defaultCabinetParams, makeUnit } from '../core/docFactory.ts';
import { nextId } from '../core/ids.ts';
import { unitParamRange } from '../../shared/aiContract.mjs';

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
  target: { cabinetId?: string; cabinetName?: string; roomId?: string; roomName?: string; unit?: number | string };
  params: Record<string, number | string>;
  reason: string;
  index: number;
}

export type CompileResult =
  | { ok: true; command: Command; summary: string }
  | { ok: false; error: string };

const mm = (v: number): number => Math.round(Number(v));

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
  const units = cab.layout.units;
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
      const unit = cab.layout.units[i];
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
      const kind = String(p.kind) as UnitSpec['kind'];
      if (kind === 'hanging' && p.rodHeight === undefined && p.count !== undefined) {
        // count 在 hanging 语义下没有意义，静默忽略会让人以为生效了
        return { ok: false, error: '挂衣区请用 rodHeight 指定挂衣杆高度，不要用 count（count 只用于抽屉区/层板区）' };
      }
      const taken = cab.layout.units.map((u) => u.id);
      const unit = makeUnit({
        id: nextId('unit', taken),
        kind,
        requestedWidth: mm(p.requestedWidth as number),
        nickname: p.nickname === undefined ? undefined : String(p.nickname),
        rules,
        depth: cab.params.depth,
        count: p.count === undefined ? undefined : Number(p.count),
        rodHeight: p.rodHeight === undefined ? undefined : Number(p.rodHeight),
      });
      return { ok: true, command: CMD.addUnit(cab.id, cab.name, unit, src), summary: `「${cab.name}」新增分区 ${unit.nickname ?? unit.id}` };
    }

    case 'cabinet.removeUnit': {
      const cab = resolveCabinet(project, action.target);
      if (typeof cab === 'string') return { ok: false, error: cab };
      const i = resolveUnitIndex(cab, action.target.unit);
      if (typeof i === 'string') return { ok: false, error: i };
      if (cab.layout.units.length <= 1) return { ok: false, error: `柜体「${cab.name}」只剩一个分区，删掉就没有柜体结构了` };
      const unit = cab.layout.units[i];
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
      const base = defaultCabinetParams(rules);
      const place = { x: mm(Number(p.atX ?? 0)), y: mm(Number(p.atY ?? 0)) };
      if (p.atX === undefined && p.atY === undefined) {
        // 没给落位：放在房间内已有柜体的右侧，避免新柜与旧柜必然重叠（重叠会立刻产生干涉 ERROR）
        const same = project.cabinets.filter((c) => c.roomId === room.id);
        place.x = same.reduce((m, c) => Math.max(m, c.placement.x + c.params.width), 0);
        place.y = same.length ? same[0].placement.y : 0;
      }
      const cab = buildCabinet({
        name,
        roomId: room.id,
        x: place.x,
        y: place.y,
        rules,
        params: {
          width: p.width === undefined ? base.width : mm(Number(p.width)),
          height: p.height === undefined ? base.height : mm(Number(p.height)),
          depth: p.depth === undefined ? base.depth : mm(Number(p.depth)),
        },
        takenIds: project.cabinets.map((c) => c.id),
      });
      return { ok: true, command: CMD.createCabinet(cab, src), summary: `新建柜体「${name}」` };
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
  'project.rename',
] as const;
