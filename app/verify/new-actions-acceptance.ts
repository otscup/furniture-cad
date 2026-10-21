/**
 * ══════════════════════════════════════════════════════════════════════
 *  新增动作验收：加上下分层 / 改已有分区门板材质（2026-10-21）
 *
 * ── 为什么要有这两个动作 ──
 *   NLU 评测卡（verify/nlu-eval.ts）实测发现，模型对两类请求的回答是：
 *
 *     「那个挂衣区下面加一层格子」
 *       -> 「做不到：cabinet.addUnit 只能新增左右并排的分区，
 *          rows 上下分层只在 cabinet.create 新建柜体时才能给」
 *     「换成玻璃门」
 *       -> 「这个改不了：现有动作里没有『修改已建分区门板材质』这一项」
 *
 *   ★ 核实后确认**模型说的是事实** ──
 *     · UNIT_PARAM_RANGES 里没有 doors.material ⇒ 改不了门板材质
 *     · 28 个动作里没有任何 rows 相关动作 ⇒ 加不了上下分层
 *
 *   ⇒ 问题不在「模型听不懂」，在**能力清单缺项**。
 *     这一轮把两个能力补上。
 *
 * ── 关键洞察 ──
 *   底层的 rows 结构、addUnit 命令的 rowIndex、commandBus 的 targetRowOf
 *   **本来就有** —— 缺的只是 AI 契约这一层。
 *   于是模型只能说「做不到，请到界面上加」。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACTIONS, ACTION_NAMES, detectActionFamilies } from '../shared/aiContract.mjs';
import { compileAction } from '../src/ai/compile.ts';
import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
import type { RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

/** 造一个带上下分层的柜（rows），以及一个单行柜 */
function makeProject(): { project: ReturnType<typeof emptyProject>; cabId: string; singleId: string } {
  const project = emptyProject({ name: 'p', ruleSetId: rules.id, id: 'p' });
  const room = rectRoom({ name: '主卧', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  project.rooms.push(room);
  // 多行柜：上行挂衣 + 下行层板
  project.cabinets.push(
    createCabinet({
      id: 'cMulti', name: '多层衣柜', roomId: room.id, x: 100, y: 60, rotation: 0, rules,
      params: { width: 1800, height: 2400, depth: 600, bodyLift: 80, cabinetType: 'tall', mountHeight: 0 },
      rows: [
        { height: 1200, units: [{ id: 'u1', kind: 'hanging', requestedWidth: 1800, nickname: '挂衣区' }] },
        { height: 1200, units: [{ id: 'u2', kind: 'shelves', requestedWidth: 1800, nickname: '下层格' }] },
      ],
    }),
  );
  // 单行柜（带门，用来测改门板材质）
  project.cabinets.push(
    createCabinet({
      id: 'cSingle', name: '单行柜', roomId: room.id, x: 2100, y: 60, rotation: 0, rules,
      params: { width: 900, height: 2000, depth: 600, bodyLift: 80, cabinetType: 'base', mountHeight: 0 },
      units: [{ id: 'u3', kind: 'shelves', requestedWidth: 900, nickname: '柜格', doors: { type: 'hinged', count: 2, mode: 'equal', style: 'inset', gapOuter: 0, gapMid: 0, hinge: 'M_HINGE', material: 'M_GLASS_8_GREY' } }],
    }),
  );
  return { project, cabId: 'cMulti', singleId: 'cSingle' };
}

// ═══════════════ 1. 契约里有这两个动作 ═══════════════
section('1. 契约登记');
{
  ok('★ cabinet.setUnitDoorMaterial 在契约里', 'cabinet.setUnitDoorMaterial' in ACTIONS);
  ok('★ 它的参数是 material 且必填',
    ACTIONS['cabinet.setUnitDoorMaterial']?.required?.includes('material'),
    JSON.stringify(ACTIONS['cabinet.setUnitDoorMaterial']?.required));
  ok('★ 它标了 targetUnit（要指明哪个分区）', ACTIONS['cabinet.setUnitDoorMaterial']?.targetUnit === true);
  ok('★ addUnit 有了 rowIndex 参数',
    'rowIndex' in (ACTIONS['cabinet.addUnit']?.params ?? {}),
    Object.keys(ACTIONS['cabinet.addUnit']?.params ?? {}).join(','));
  // ★ 逐个查每个「作用于分区」的动作都有 rowIndex ——
  //   只查 addUnit 的话，把 addUnit 的删掉而别的还留着，断言照样绿。
  const unitActions = ['cabinet.setUnitWidth', 'cabinet.setUnitParam', 'cabinet.renameUnit', 'cabinet.setUnitDoorMaterial', 'cabinet.removeUnit', 'cabinet.addUnit'];
  for (const a of unitActions) {
    ok(`★ ${a} 的参数里有 rowIndex`,
      'rowIndex' in (ACTIONS[a]?.params ?? {}),
      Object.keys(ACTIONS[a]?.params ?? {}).join(','));
  }
  // ★ detectActionFamilies 返回的是 **Set**（不是数组）—— 之前踩过这个坑
  const fams = detectActionFamilies('换个玻璃门');
  ok('★ setUnitDoorMaterial 在 units 族里（能被动作族检索到）',
    fams instanceof Set ? fams.has('units') : false,
    fams instanceof Set ? [...fams].join(',') : String(fams));
  // ★ 光看「命中了 units 族」不够 —— units 族里还有别的动作，
  //   把 setUnitDoorMaterial 删掉照样能命中 units 族。
  //   要查的是**族里列了这个动作**。
  const contractSrc = readFileSync(join(here, '..', 'shared', 'aiContract.mjs'), 'utf8');
  // ★ 只取 ACTION_FAMILIES 里的那一处（单行格式）—— 文件里还有别的 units: [ 会误匹配
  const unitsFamilyMatch = /^\s*units:\s*\[([^\]]*)\]/m.exec(contractSrc);
  ok('★ ★ units 族里列出了 setUnitDoorMaterial',
    !!unitsFamilyMatch && unitsFamilyMatch[1].includes('cabinet.setUnitDoorMaterial'),
    unitsFamilyMatch ? unitsFamilyMatch[1].slice(0, 120) : '没找到 units 族');
  ok('★ 动作清单里能数到它', ACTION_NAMES.includes('cabinet.setUnitDoorMaterial'));
  ok('★ ★ setUnitFeature 在契约里', 'cabinet.setUnitFeature' in ACTIONS);
  ok('★ ★ setUnitFeature 的 feature 枚举含三个开关',
    (ACTIONS['cabinet.setUnitFeature']?.params?.feature as { values?: string[] })?.values?.length === 3,
    JSON.stringify((ACTIONS['cabinet.setUnitFeature']?.params?.feature as { values?: string[] })?.values));
}

// ═══════════════ 2. 改门板材质真的能改 ═══════════════
section('2. cabinet.setUnitDoorMaterial：改已有分区的门板材质');
{
  const { project, singleId } = makeProject();
  const before = project.cabinets.find((c) => c.id === singleId)!;
  const beforeMat = (before.layout.units![0]!.doors as { material?: string } | undefined)?.material;
  ok('★ 改之前门板材质是木门', beforeMat === 'M_GLASS_8_GREY', String(beforeMat));

  // 找一个存在的玻璃门材质 id
  const glassId = Object.keys(rules.materials ?? {}).find((k) => /glass/i.test(k));
  ok('★ 规则集里有玻璃门材质', !!glassId, Object.keys(rules.materials ?? {}).join(','));

  if (glassId) {
    const r = compileAction({
      action: 'cabinet.setUnitDoorMaterial',
      target: { cabinetName: '单行柜', unit: 1 },
      params: { material: glassId },
    } as never, project, rules);
    ok('★ ★ 编译通过（不再报「没有这个动作」）', r.ok === true, r.ok ? '' : String(r.error));
    ok('★ 产出一条命令', r.ok ? !!r.command : false);
    ok('★ 命令是 setUnitString 改 doors.material',
      r.ok ? r.command.changes.some((ch) => ch.path.includes('doors.material')) : false,
      r.ok ? JSON.stringify(r.command.changes).slice(0, 140) : '');
  }
}

// ═══════════════ 3. 门板材质的边界 ═══════════════
section('3. 门板材质的边界：不存在 / 没有门');
{
  const { project, singleId } = makeProject();
  // 不存在的材质 id —— 不能静默降级成木门
  const r1 = compileAction({
    action: 'cabinet.setUnitDoorMaterial',
    target: { cabinetName: '单行柜', unit: 1 },
    params: { material: 'M_NOT_EXIST_MATERIAL', rowIndex: 0 },
  } as never, project, rules);
  ok('★ ★ 不存在的材质 id 被拒（不静默降级成木门）', r1.ok === false, r1.ok ? '竟然通过了' : '');
  ok('★ 错误信息提到了门板材质', r1.ok ? false : String(r1.error).includes('门板材质'), String(r1.error).slice(0, 90));

  // 没有门的分区（开放格）
  const r2 = compileAction({
    action: 'cabinet.setUnitDoorMaterial',
    target: { cabinetName: '多层衣柜', unit: 1 },
    params: { material: 'M_GLASS_8_GREY', rowIndex: 0 },
  } as never, project, rules);
  ok('★ ★ 开放格改门板材质被拒（并指出该做什么）', r2.ok === false, r2.ok ? '竟然通过了' : '');
  ok('★ 错误信息提示了「没有门」', r2.ok ? false : String(r2.error).includes('没有门'), String(r2.error).slice(0, 90));
}

// ═══════════════ 4. addUnit 的 rowIndex ═══════════════
section('4. cabinet.addUnit 的 rowIndex：加到指定行');
{
  const { project, cabId } = makeProject();
  const rows = project.cabinets.find((c) => c.id === cabId)!.layout.rows!;
  ok('★ 造出来的柜真的是 2 行', rows.length === 2, String(rows.length));

  // 不给 rowIndex —— 必须拒绝并说清要指哪一行
  const r1 = compileAction({
    action: 'cabinet.addUnit',
    target: { cabinetName: '多层衣柜' },
    params: { kind: 'shelves', requestedWidth: 1800, count: 3 },
  } as never, project, rules);
  ok('★ ★ 多行柜不给 rowIndex 被拒', r1.ok === false, r1.ok ? '竟然通过了' : '');
  ok('★ ★ 错误信息说了要指哪一行（给出行数范围）',
    r1.ok ? false : /rowIndex/.test(String(r1.error)) && /0~/.test(String(r1.error)),
    String(r1.error).slice(0, 120));

  // 给 rowIndex=1（下面那行）
  const r2 = compileAction({
    action: 'cabinet.addUnit',
    target: { cabinetName: '多层衣柜' },
    params: { kind: 'shelves', requestedWidth: 1800, count: 3, rowIndex: 1 },
  } as never, project, rules);
  ok('★ ★ 给 rowIndex=1 编译通过', r2.ok === true, r2.ok ? '' : String(r2.error));
  ok('★ 命令带上了 rowIndex', r2.ok ? (r2.command.payload?.rowIndex === 1) : false,
    r2.ok ? JSON.stringify(r2.command.payload ?? {}).slice(0, 120) : '');

  // ★ 多行柜改分区时不给 rowIndex —— 必须拒绝并说清要指哪一行
  //   （这一条是「多行柜的分区定位不再要求行号」那个变异的守门人）
  const r4 = compileAction({
    action: 'cabinet.setUnitDoorMaterial',
    target: { cabinetName: '多层衣柜', unit: 1 },
    params: { material: 'M_GLASS_8_GREY' },
  } as never, project, rules);
  ok('★ ★ 多行柜改分区不给 rowIndex 被拒（不猜是哪一行）', r4.ok === false, r4.ok ? '竟然通过了' : '');
  // ★ 断言要查**错误信息本身**，不能只查「被拒」——
  //   第一道防线（要求指明行号）去掉后，第二道兜底（rows[NaN] 取不到）**仍然会拒**，
  //   所以「被拒」这个断言测不到第一道防线。
  //   真正区分两者的是**错误信息**：第一道说「要指明是哪一行」，第二道说「rowIndex = NaN 超出范围」。
  ok('★ ★ 错误信息说了要指明是哪一行（不是 NaN 那种兜底信息）',
    r4.ok ? false : /指明是哪一行|要指明/.test(String(r4.error)),
    String(r4.error).slice(0, 110));

  // 越界的 rowIndex
  const r3 = compileAction({
    action: 'cabinet.addUnit',
    target: { cabinetName: '多层衣柜' },
    params: { kind: 'shelves', requestedWidth: 1800, count: 3, rowIndex: 5 },
  } as never, project, rules);
  ok('★ 越界的 rowIndex 被拒（不是静默夹到最后一格）', r3.ok === false, r3.ok ? '竟然通过了' : '');
  ok('★ 错误信息说了范围', r3.ok ? false : /超出范围/.test(String(r3.error)), String(r3.error).slice(0, 90));
}


// ═══════════════ 5. cabinet.setUnitFeature：改已有分区的功能开关 ═══════════════
section('5. cabinet.setUnitFeature：裤架 / 格子抽 / 灯带');
{
  const { project, singleId } = makeProject();
  const cab = project.cabinets.find((c) => c.id === singleId)!;
  // 造一个带挂衣杆的分区来测裤架
  const hangCab = createCabinet({
    id: 'cHang', name: '挂衣柜', roomId: cab.roomId, x: 3100, y: 60, rotation: 0, rules,
    params: { width: 900, height: 2000, depth: 600, bodyLift: 80, cabinetType: 'base', mountHeight: 0 },
    units: [{ id: 'uH', kind: 'hanging', requestedWidth: 900, nickname: '挂衣区', rod: { count: 1, heightFromBottom: 1600 } }],
  });
  project.cabinets.push(hangCab);

  // ① 裤架：给挂衣区加
  const r1 = compileAction({
    action: 'cabinet.setUnitFeature',
    target: { cabinetName: '挂衣柜', unit: 1 },
    params: { feature: 'trouserRack', value: 'true' },
  } as never, project, rules);
  ok('★ ★ 给挂衣区加裤架编译通过', r1.ok === true, r1.ok ? '' : String(r1.error));
  ok('★ 命令写的是 trouserRack 路径',
    r1.ok ? r1.command.changes.some((ch) => ch.path.includes('trouserRack')) : false,
    r1.ok ? JSON.stringify(r1.command.changes).slice(0, 120) : '');

  // ② 前提不满足：给没有挂衣杆的分区加裤架
  const r2 = compileAction({
    action: 'cabinet.setUnitFeature',
    target: { cabinetName: '单行柜', unit: 1 },
    params: { feature: 'trouserRack', value: 'true' },
  } as never, project, rules);
  ok('★ ★ 非挂衣区加裤架被拒', r2.ok === false, r2.ok ? '竟然通过了' : '');
  ok('★ 错误信息说明了原因',
    r2.ok ? false : /挂衣/.test(String(r2.error)),
    String(r2.error).slice(0, 100));

  // ②·补 挂衣区但**没有挂衣杆** —— 这是另一条 precheck 分支
  //   （kind 是 hanging 但 rod 缺失：裤架无处可挂）
  const noRod = createCabinet({
    id: 'cNoRod', name: '无杆柜', roomId: cab.roomId, x: 4100, y: 60, rotation: 0, rules,
    params: { width: 900, height: 2000, depth: 600, bodyLift: 80, cabinetType: 'base', mountHeight: 0 },
    units: [{ id: 'uN', kind: 'hanging', requestedWidth: 900, nickname: '光秃区' }],
  });
  project.cabinets.push(noRod);
  const r2b = compileAction({
    action: 'cabinet.setUnitFeature',
    target: { cabinetName: '无杆柜', unit: 1 },
    params: { feature: 'trouserRack', value: 'true' },
  } as never, project, rules);
  ok('★ ★ 挂衣区但没有挂衣杆时加裤架被拒', r2b.ok === false, r2b.ok ? '竟然通过了' : '');
  ok('★ ★ 错误信息说了「没有挂衣杆」',
    r2b.ok ? false : /挂衣杆/.test(String(r2b.error)),
    String(r2b.error).slice(0, 100));

  // ③ 非法取值
  const r3 = compileAction({
    action: 'cabinet.setUnitFeature',
    target: { cabinetName: '挂衣柜', unit: 1 },
    params: { feature: 'trouserRack', value: 'yes' },
  } as never, project, rules);
  ok('★ 非法取值被拒（不是静默忽略）', r3.ok === false, r3.ok ? '竟然通过了' : '');

  // ④ 格子抽
  const r4 = compileAction({
    action: 'cabinet.setUnitFeature',
    target: { cabinetName: '单行柜', unit: 1 },
    params: { feature: 'drawerStyle', value: 'grid' },
  } as never, project, rules);
  ok('★ 格子抽：没有抽屉的分区被拒（并指出该做什么）', r4.ok === false, r4.ok ? '竟然通过了' : '');
  ok('★ 错误信息提到了抽屉', r4.ok ? false : /抽屉/.test(String(r4.error)), String(r4.error).slice(0, 90));
}
console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`新增动作验收：通过 ${pass} 项，失败 0 项`);
  console.log('全部通过：能加上下分层、能改已有分区门板材质，边界都拦得住。');
} else {
  console.log(`新增动作验收：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
