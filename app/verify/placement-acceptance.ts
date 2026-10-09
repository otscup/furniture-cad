/**
 * ══════════════════════════════════════════════════════════════════════
 *  P8.1 验收 —— Deterministic Placement Foundation
 *
 *  出口判据：PlacementIntent → 确定性引擎 → 可验证的空间位置。
 *
 *  ── 这一批断言真正在防什么 ──
 *   ① **引擎不纯 / 有隐藏状态。** 同输入必须同输出；输入快照与语义模型
 *      一个字节都不能被解析过程改掉。
 *   ② **静默回退到原点。** 任何解析失败必须给结构化错误（精确到码），
 *      绝不出现"失败就放 (0,0)"—— 那会让柜体悄悄扎进墙里还装作成功。
 *   ③ **AI 夹带坐标。** 新落位面（cabinet.place / 方案 placement）不收
 *      x/y；方案里出现坐标字段被形状门拒收；absolute 只认 authored。
 *   ④ **绕过 CommandBus。** 解析结果只能经 `cabinet.place` 一条命令原子写入；
 *      解析本身不碰模型版本。
 *   ⑤ **两套尺寸/位置真相。** 引擎只读 sceneFromProject 的语义参数
 *      （width/depth/placement）；2D（plan 图元）与 3D（bodies3d）在落位后
 *      位移必须一致 —— 它们本来就同源于 generateProject。
 *   ⑥ **连续落位顺序碰运气。** A 参照 B 必须用 B 解析后的新位置；
 *      成环必须被静态拦下，而不是按数组顺序碰。
 *   ⑦ **预览 ≠ 提交。** 走 P3 唯一链路（dryRunPlan → commitPlan），
 *      提交后的 placement 必须与预览草稿逐值相等。
 *
 *  注：本文件的旋转 bbox 复核是**故意独立重算**的（0/90° 整数三角）——
 *  验收侧不该 import 被测实现来自我证明。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, Prim, Project, RuleSet, Vec2 } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import {
  resolvePlacement,
  resolvePlacements,
  sceneFromProject,
  type PlacementIntent,
  type PlacementScene,
} from '../src/core/placement.ts';
import { bboxOf } from '../src/core/geometry/transform.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { compileAction, type AiAction } from '../src/ai/compile.ts';
import { validateProposal, type DesignProposal } from '../src/ai/proposal.ts';
import { compileProposal } from '../src/ai/compileProposal.ts';
import { commitPlan, dryRunPlan } from '../src/ai/planRunner.ts';
import { ACTIONS, proposalShapeError } from '../shared/aiContract.mjs';
import * as CMD from '../src/core/commands.ts';
import { findDuplicateUnitIds } from '../src/core/unitIdentity.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \u2717 ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(title: string): void {
  console.log(`\n【${title}】`);
}
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
type Box = { min: Vec2; max: Vec2 };

// ───────────── 测试场景 ─────────────

/** A(400,60) 2400×600；B(1000,1000) 800×550。A 的包围盒 = [400,60]~[2800,660] */
function mkProject(): Project {
  const room = rectRoom({ name: '测试房', x: 0, y: 0, w: 6000, h: 4000, thickness: 100, height: 2700 });
  const mk = (id: string, name: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet =>
    withUniqueUnitIds(createCabinet({
      id,
      name,
      roomId: room.id,
      x,
      y,
      rotation,
      rules,
      params: { ...defaultCabinetParams(rules), width: w, height: 2200, depth: d },
      units: defaultUnits(w, rules, d),
    }));
  const project: Project = {
    schemaVersion: '0.3',
    id: 'proj_p81',
    name: 'P8.1 落位验收',
    ruleSetId: rules.id,
    rooms: [room],
    cabinets: [mk('cab_A', '基准柜A', 400, 60, 2400, 600), mk('cab_B', '相邻柜B', 1000, 1000, 800, 550)],
  };
  assertUniqueFixtureUnitIds(project);
  return project;
}

function withUniqueUnitIds(cabinet: Cabinet): Cabinet {
  let sequence = 0;
  const assign = (units?: Array<{ id: string }>): void => {
    for (const unit of units ?? []) {
      sequence++;
      unit.id = `${cabinet.id}_unit_${String(sequence).padStart(3, '0')}`;
    }
  };
  if (cabinet.layout.rows?.length) {
    for (const row of cabinet.layout.rows) assign(row.units);
  } else {
    assign(cabinet.layout.units);
  }
  assign(cabinet.layout.backUnits);
  return cabinet;
}

function assertUniqueFixtureUnitIds(project: Project): void {
  if (findDuplicateUnitIds(project).length === 0) return;
  const duplicates = findDuplicateUnitIds(project);
  throw new Error(`Placement fixture has duplicate Unit/backUnit IDs: ${JSON.stringify(duplicates)}`);
}

function primBox(prims: Prim[]): Box {
  const pts = prims.flatMap((p) => (p.k === 'text' ? [p.p] : p.pts));
  return bboxOf(pts);
}

/** 验收侧独立复核：柜体足迹包围盒（0/90° 整数三角，不 import 被测实现） */
function footprintBox(cab: Cabinet): Box {
  const r = (cab.placement.rotation * Math.PI) / 180;
  const c = Math.round(Math.cos(r));
  const s = Math.round(Math.sin(r));
  const pts = [
    { x: 0, y: 0 },
    { x: cab.params.width, y: 0 },
    { x: cab.params.width, y: cab.params.depth },
    { x: 0, y: cab.params.depth },
  ].map((p) => ({ x: cab.placement.x + p.x * c - p.y * s, y: cab.placement.y + p.x * s + p.y * c }));
  return bboxOf(pts);
}

// ═══════════════════ §1 基础：三种关系的确定性数值 ═══════════════════
section('§1 基础关系：absolute / adjacent / align 的确定性数值');
{
  const scene: PlacementScene = sceneFromProject(mkProject());

  // absolute（authored）
  const abs = resolvePlacement({ relation: 'absolute', targetId: 'cab_B', x: 1234.6, y: -87.2, origin: 'authored' }, scene);
  ok('absolute：x/y 取整为整数 mm', abs.ok && abs.placement.x === 1235 && abs.placement.y === -87, JSON.stringify(abs));
  ok('absolute：不给 rotation 时保留柜体当前朝向', abs.ok && abs.placement.rotation === 0, JSON.stringify(abs));
  const abs2 = resolvePlacement({ relation: 'absolute', targetId: 'cab_B', x: 0, y: 0, rotation: 90, origin: 'authored' }, scene);
  ok('absolute：显式 rotation 生效', abs2.ok && abs2.placement.rotation === 90);

  // adjacent 四向（缺省对齐：并排背面齐、前后左缘齐）
  const adjR = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }, scene);
  ok('adjacent right：target 左缘贴 reference 右缘（x=2800）', adjR.ok && adjR.placement.x === 2800, JSON.stringify(adjR));
  ok('adjacent right：缺省背面齐（y=60）', adjR.ok && adjR.placement.y === 60);
  ok('adjacent right：朝向保留', adjR.ok && adjR.placement.rotation === 0);
  const adjL = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'left' }, scene);
  ok('adjacent left：target 右缘贴 reference 左缘（x=-400，右缘=400）', adjL.ok && adjL.placement.x === -400, JSON.stringify(adjL));
  const adjF = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'front' }, scene);
  ok('adjacent front：target 背面贴 reference 前脸（y=660）', adjF.ok && adjF.placement.y === 660, JSON.stringify(adjF));
  ok('adjacent front：缺省左缘齐（x=400）', adjF.ok && adjF.placement.x === 400);
  const adjB = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'back' }, scene);
  ok('adjacent back：target 前脸贴 reference 背面（y=-490，前缘=60）', adjB.ok && adjB.placement.y === -490, JSON.stringify(adjB));

  // 对齐变体
  const adjFC = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right', alignment: 'front' }, scene);
  ok('adjacent right + front：前缘齐（y=110）', adjFC.ok && adjFC.placement.y === 110, JSON.stringify(adjFC));
  const adjRC = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right', alignment: 'center' }, scene);
  ok('adjacent right + center：中心对齐（y=85）', adjRC.ok && adjRC.placement.y === 85, JSON.stringify(adjRC));

  // align 五种
  const alL = resolvePlacement({ relation: 'align', targetId: 'cab_B', referenceId: 'cab_A', alignment: 'left' }, scene);
  ok('align left：只动 X（x=400，y 不变）', alL.ok && alL.placement.x === 400 && alL.placement.y === 1000, JSON.stringify(alL));
  const alR = resolvePlacement({ relation: 'align', targetId: 'cab_B', referenceId: 'cab_A', alignment: 'right' }, scene);
  ok('align right：x=2000', alR.ok && alR.placement.x === 2000 && alR.placement.y === 1000);
  const alF = resolvePlacement({ relation: 'align', targetId: 'cab_B', referenceId: 'cab_A', alignment: 'front' }, scene);
  ok('align front：只动 Y（y=110，x 不变）', alF.ok && alF.placement.y === 110 && alF.placement.x === 1000, JSON.stringify(alF));
  const alB = resolvePlacement({ relation: 'align', targetId: 'cab_B', referenceId: 'cab_A', alignment: 'back' }, scene);
  ok('align back：y=60', alB.ok && alB.placement.y === 60);
  const alC = resolvePlacement({ relation: 'align', targetId: 'cab_B', referenceId: 'cab_A', alignment: 'center' }, scene);
  ok('align center：中心重合（1200, 85）', alC.ok && alC.placement.x === 1200 && alC.placement.y === 85, JSON.stringify(alC));

  // 旋转柜：包围盒法对任意 rotation 成立（90° 参照 / 90° 目标）
  const rotProject = mkProject();
  rotProject.cabinets[0]!.placement.rotation = 90;
  const rotRef = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }, sceneFromProject(rotProject));
  // A 旋转 90° 后包围盒 = [-200,60]~[400,2460]；B 右贴 → x=400，背面齐 y=60
  ok('旋转 90° 的参照柜：adjacent right 仍面贴合（x=400，y=60）', rotRef.ok && rotRef.placement.x === 400 && rotRef.placement.y === 60, JSON.stringify(rotRef));

  const rotProject2 = mkProject();
  rotProject2.cabinets[1]!.placement.rotation = 90;
  const rotTgt = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }, sceneFromProject(rotProject2));
  // B 旋转 90° 后包围盒 = [450,1000]~[1000,1800]；dx = 2800-450 → x=3350
  ok('旋转 90° 的目标柜：位移增量法对任意朝向成立（x=3350）', rotTgt.ok && rotTgt.placement.x === 3350, JSON.stringify(rotTgt));

  // 不同深度：相邻右的 x 只依赖参照右缘与目标宽，与两柜深度无关
  const p3 = mkProject();
  p3.cabinets[1]!.params.depth = 318; // 非常规深度
  const deepR = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }, sceneFromProject(p3));
  ok('不同深度：placement 只依赖几何事实（深度不影响 adjacent right 的 x/y）', deepR.ok && deepR.placement.x === 2800 && deepR.placement.y === 60, JSON.stringify(deepR));
}

// ═══════════════════ §2 多柜连续落位（依赖排序）═══════════════════
section('§2 多柜连续：后面的柜贴前面"刚解析出来"的位置');
{
  const project = mkProject();
  project.cabinets.push(
    withUniqueUnitIds(createCabinet({
      id: 'cab_C',
      name: '第三柜C',
      roomId: project.rooms[0]!.id,
      x: 2000,
      y: 2000,
      rotation: 0,
      rules,
      params: { ...defaultCabinetParams(rules), width: 800, height: 2200, depth: 600 },
      units: defaultUnits(800, rules, 600),
    }))
  );
  assertUniqueFixtureUnitIds(project);
  const scene = sceneFromProject(project);
  const intents: PlacementIntent[] = [
    { relation: 'adjacent', targetId: 'cab_C', referenceId: 'cab_B', side: 'right' }, // 故意乱序：C 排在 B 前面
    { relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' },
  ];
  const batch = resolvePlacements(intents, scene);
  ok('批量解析成功（乱序输入也被依赖排序救回）', batch.ok, JSON.stringify(batch));
  const byTarget = new Map(batch.ok ? batch.resolved.map((r) => [r.intent.targetId, r.placement]) : []);
  const b = byTarget.get('cab_B');
  const c = byTarget.get('cab_C');
  ok('B 贴 A 右侧（2800, 60）', b?.x === 2800 && b?.y === 60, JSON.stringify(b));
  // B 解析后右缘 = 2800+800 = 3600；C 左缘贴上去 → C.x = 3600-（C 原左缘 2000 的位移 1600）→ 3600
  ok('C 贴 B 解析后的新位置（C.x=3600，左缘=3600=B 新右缘）', c?.x === 3600 && c?.y === 60, JSON.stringify(c));
  const singleB = resolvePlacement(intents[1]!, scene);
  ok('same intent → same resolved（批量与单条一致）', singleB.ok && b?.x === singleB.placement.x && b?.y === singleB.placement.y);
}

// ═══════════════════ §3 错误：结构化、精确到码、绝不静默回原点 ═══════════════════
section('§3 错误路径：结构化错误（不许 silently fallback 到 (0,0,0)）');
{
  const scene = sceneFromProject(mkProject());
  const r1 = resolvePlacement({ relation: 'adjacent', targetId: 'nope', referenceId: 'cab_A', side: 'right' }, scene);
  ok('target 不存在 → PLACEMENT-TARGET-NOT-FOUND', !r1.ok && r1.error.code === 'PLACEMENT-TARGET-NOT-FOUND', JSON.stringify(r1));
  const r2 = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'nope', side: 'right' }, scene);
  ok('reference 不存在 → PLACEMENT-REFERENCE-NOT-FOUND', !r2.ok && r2.error.code === 'PLACEMENT-REFERENCE-NOT-FOUND', JSON.stringify(r2));
  const r3 = resolvePlacement({ relation: 'align', targetId: 'cab_B', referenceId: 'cab_B', alignment: 'left' }, scene);
  ok('自参照 → PLACEMENT-SELF-REFERENCE', !r3.ok && r3.error.code === 'PLACEMENT-SELF-REFERENCE', JSON.stringify(r3));
  const r4 = resolvePlacement({ relation: 'beside', targetId: 'cab_B', referenceId: 'cab_A' } as unknown as PlacementIntent, scene);
  ok('未知关系 → PLACEMENT-INTENT-INVALID', !r4.ok && r4.error.code === 'PLACEMENT-INTENT-INVALID', JSON.stringify(r4));
  const r5 = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A' } as PlacementIntent, scene);
  ok('adjacent 缺 side → PLACEMENT-INTENT-INVALID（不猜方向）', !r5.ok && r5.error.code === 'PLACEMENT-INTENT-INVALID', JSON.stringify(r5));
  const r6 = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right', alignment: 'left' }, scene);
  ok('并排给了前后叠的对齐 → PLACEMENT-INTENT-INVALID', !r6.ok && r6.error.code === 'PLACEMENT-INTENT-INVALID', JSON.stringify(r6));
  const r7 = resolvePlacement({ relation: 'align', targetId: 'cab_B', referenceId: 'cab_A', alignment: 'centerX' as never }, scene);
  ok('align 对齐方式不认识 → PLACEMENT-INTENT-INVALID', !r7.ok && r7.error.code === 'PLACEMENT-INTENT-INVALID');
  const r8 = resolvePlacement({ relation: 'absolute', targetId: 'cab_B', x: 100, y: 100 } as PlacementIntent, scene);
  ok('absolute 缺 origin=authored → 拒收（AI 不得把坐标当授权输入）', !r8.ok && r8.error.code === 'PLACEMENT-INTENT-INVALID', JSON.stringify(r8));
  const r9 = resolvePlacement({ relation: 'absolute', targetId: 'cab_B', x: Number.NaN, y: 0, origin: 'authored' }, scene);
  ok('absolute 非有限数 → 拒收', !r9.ok && r9.error.code === 'PLACEMENT-INTENT-INVALID');
  const badSize = scene.map((s) => (s.id === 'cab_A' ? { ...s, width: 0 } : s));
  const r10 = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }, badSize);
  ok('参照柜尺寸非法 → PLACEMENT-SIZE-INVALID', !r10.ok && r10.error.code === 'PLACEMENT-SIZE-INVALID', JSON.stringify(r10));
  const badGeom = scene.map((s) => (s.id === 'cab_A' ? { ...s, x: Number.NaN } : s));
  const r11 = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }, badGeom);
  ok('参照柜落位数据不完整 → PLACEMENT-GEOMETRY-MISSING', !r11.ok && r11.error.code === 'PLACEMENT-GEOMETRY-MISSING', JSON.stringify(r11));

  // 批量成环
  const cycle = resolvePlacements(
    [
      { relation: 'adjacent', targetId: 'cab_A', referenceId: 'cab_B', side: 'right' },
      { relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' },
    ],
    scene
  );
  ok('批量互为参照成环 → PLACEMENT-CYCLE（全批拒绝）', !cycle.ok && cycle.error.code === 'PLACEMENT-CYCLE', JSON.stringify(cycle));

  // 错误信息可读：带目标 id 与场景规模（不是一句光秃秃的"失败"）
  ok('错误信息可读：带目标 id 和数量', !r1.ok && r1.error.message.includes('nope') && r1.error.message.includes('2 个柜体'), r1.ok ? '' : r1.error.message);
}

// ═══════════════════ §4 纯函数与不可变输入 ═══════════════════
section('§4 架构：resolver 是纯函数（同输入同输出、不改输入、不碰模型）');
{
  const project = mkProject();
  const scene = sceneFromProject(project);
  const intent: PlacementIntent = { relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' };
  const sceneBefore = JSON.stringify(scene);
  const projectBefore = JSON.stringify(project);
  const intentBefore = JSON.stringify(intent);
  const a = resolvePlacement(intent, scene);
  const b = resolvePlacement(intent, scene);
  ok('同输入两次解析 → 逐位相同', eq(a, b));
  ok('场景快照未被修改', JSON.stringify(scene) === sceneBefore);
  ok('语义模型未被修改（解析不写模型）', JSON.stringify(project) === projectBefore);
  ok('意图对象未被修改', JSON.stringify(intent) === intentBefore);
  ok('输出是整数 mm', a.ok && Number.isInteger(a.placement.x) && Number.isInteger(a.placement.y) && Number.isInteger(a.placement.rotation));
  const batch1 = resolvePlacements([intent], scene);
  const batch2 = resolvePlacements([intent], scene);
  ok('批量解析同样确定（无随机、无时钟）', eq(batch1, batch2));
}

// ═══════════════════ §5 CommandBus：cabinet.place 唯一写入路径 ═══════════════════
section('§5 CommandBus：解析结果经 cabinet.place 原子写入（不绕过总线）');
{
  const project = mkProject();
  const bus = new CommandBus(project, rules);
  const v0 = bus.getVersion();
  const scene = sceneFromProject(bus.getState());
  const r = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }, scene);
  ok('解析成功且未动模型版本', r.ok && bus.getVersion() === v0);
  const cabB = bus.getState().cabinets.find((c) => c.id === 'cab_B')!;
  const cmd = CMD.placeCabinet(cabB, r.ok ? r.placement : { x: 0, y: 0, rotation: 0 }, 'ai');

  const dry = bus.execute(cmd, { dryRun: true });
  const untouched = bus.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
  ok('干跑成功、模型未动（版本不变、placement 不变）', dry.ok && bus.getVersion() === v0 && untouched.x === 1000 && untouched.y === 1000, dry.ok ? '' : JSON.stringify(dry));
  ok('一条命令带齐 x/y/rotation（原子，不是三条）', cmd.changes.length === 3 && cmd.changes.every((ch) => /^placement\.(x|y|rotation)$/.test(ch.path)));

  const exec = bus.execute(cmd);
  const after = bus.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
  ok('提交成功：版本 +1，落位 = 解析值（2800, 60, 0）', exec.ok && bus.getVersion() === v0 + 1 && after.x === 2800 && after.y === 60 && after.rotation === 0, exec.ok ? JSON.stringify(after) : `${JSON.stringify(exec)}; after=${JSON.stringify(after)}`);
  ok('预览（dryRun diff）与提交结果一致', eq(dry.diff, exec.diff));

  ok('撤销一步回到原位（placement 逐值还原）', (() => {
    if (!bus.undo()) return false;
    const p = bus.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
    return p.x === 1000 && p.y === 1000 && p.rotation === 0;
  })());
  ok('重做恢复落位', (() => {
    if (!bus.redo()) return false;
    const p = bus.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
    return p.x === 2800 && p.y === 60;
  })());

  const cheat = CMD.placeCabinet(cabB, { x: 1, y: 2, rotation: 0 }, 'ai');
  cheat.changes.push({ path: 'params.width', op: 'set', value: 999 });
  const cheatRun = bus.plan(cheat);
  ok('cabinet.place 夹带非 placement 路径 → 越权拒绝', !cheatRun.ok && cheatRun.error.includes('越权'), cheatRun.ok ? '' : String(cheatRun.error));
}

// ═══════════════════ §6 Proposal / AI 边界 ═══════════════════
section('§6 Proposal 链路：意图 → 编译 → 干跑 → 提交，全链唯一入口');
{
  const baseProposal: DesignProposal = {
    title: 'P8.1 落位验收',
    room: '主卧',
    cabinets: [
      { ref: 'base', name: '基准柜', width: 1200, height: 2200, depth: 550 },
      { ref: 'next', name: '相邻柜', width: 800, height: 2200, depth: 600, placement: { relation: 'adjacent', reference: 'base', side: 'right' } },
    ],
  };

  // 语义校验：合法方案无 PLACE 类错误
  const placeIssueCodes = (p: DesignProposal): string[] =>
    validateProposal(p, sampleProject(rules)).filter((i) => i.code.startsWith('PROPOSAL-PLACE')).map((i) => i.code);
  ok('合法落位意图：validateProposal 无 PLACE 类错误', placeIssueCodes(baseProposal).length === 0, JSON.stringify(placeIssueCodes(baseProposal)));

  // 编译：create 全部在前、place 在后；$ref 占位正确；无坐标
  const compile = compileProposal(baseProposal, sampleProject(rules), rules);
  ok('编译成功', compile.ok, compile.blockedReason ?? '');
  const placeActions = compile.actions.filter((a) => a.action === 'cabinet.place');
  const createCount = compile.actions.filter((a) => a.action === 'cabinet.create').length;
  ok('place 动作在全部 create 之后（先建完再落位，$ref 才换得出）', createCount === 2 && placeActions.length === 1 && compile.actions.indexOf(placeActions[0]!) === compile.actions.length - 1);
  ok('place 的 target 与 reference 都是 $ref 占位（AI 拿不到也编不了 id）', placeActions[0]!.target.cabinetId === '$ref:next' && String(placeActions[0]!.params.reference) === '$ref:base');
  ok('place 参数里没有任何坐标字段', !('x' in placeActions[0]!.params) && !('y' in placeActions[0]!.params));
  ok('缺省对齐写进了 notes（系统按惯例取了什么，界面必须显示）', compile.notes.some((n) => n.includes('back')), JSON.stringify(compile.notes));

  // 干跑 → 落位关系在草稿里成立；提交 → 与草稿逐值相等
  const bus = new CommandBus(sampleProject(rules), rules);
  const run = dryRunPlan({ bus, actions: compile.actions });
  const failed = run.steps.filter((s) => !s.ok);
  ok('干跑全部步骤通过', failed.length === 0, JSON.stringify(failed.map((s) => ({ label: s.label, error: s.error }))));
  const draftBase = run.draft.cabinets.find((c) => c.name === '基准柜')!;
  const draftNext = run.draft.cabinets.find((c) => c.name === '相邻柜')!;
  const baseBox = footprintBox(draftBase);
  const nextBox = footprintBox(draftNext);
  ok('草稿里：相邻柜左缘 === 基准柜右缘（面贴合，零缝隙）', nextBox.min.x === baseBox.max.x, `${JSON.stringify(baseBox)} vs ${JSON.stringify(nextBox)}`);
  ok('草稿里：背面齐（缺省对齐 back）', nextBox.min.y === baseBox.min.y);
  const committed = commitPlan(run, bus);
  ok('提交成功', committed.ok, committed.ok ? '' : committed.error);
  const finalBase = bus.getState().cabinets.find((c) => c.name === '基准柜')!.placement;
  const finalNext = bus.getState().cabinets.find((c) => c.name === '相邻柜')!.placement;
  ok('预览 === 提交：placement 逐值相等（x/y/rotation）', finalBase.x === draftBase.placement.x && finalBase.y === draftBase.placement.y && finalNext.x === draftNext.placement.x && finalNext.y === draftNext.placement.y && finalNext.rotation === draftNext.placement.rotation);

  // 同一意图 → 同一解析（全新状态重跑一遍）
  const bus2 = new CommandBus(sampleProject(rules), rules);
  const compile2 = compileProposal(baseProposal, sampleProject(rules), rules);
  const run2 = dryRunPlan({ bus: bus2, actions: compile2.actions });
  const next2 = run2.draft.cabinets.find((c) => c.name === '相邻柜')!;
  ok('same intent → same resolved placement（可复现，无随机）', next2.placement.x === draftNext.placement.x && next2.placement.y === draftNext.placement.y, `${JSON.stringify(draftNext.placement)} vs ${JSON.stringify(next2.placement)}`);

  // 连续多柜链（A←B←C）：编译按依赖排序，草稿里三柜首尾相接
  const chainProposal: DesignProposal = {
    title: '三柜连续',
    room: '主卧',
    cabinets: [
      { ref: 'a', name: '链A', width: 900, height: 2200, depth: 550 },
      { ref: 'b', name: '链B', width: 900, height: 2200, depth: 550, placement: { relation: 'adjacent', reference: 'a', side: 'right' } },
      { ref: 'c', name: '链C', width: 900, height: 2200, depth: 550, placement: { relation: 'adjacent', reference: 'b', side: 'right' } },
    ],
  };
  const compile3 = compileProposal(chainProposal, sampleProject(rules), rules);
  const opList = compile3.actions.map((a) => `${a.action}:${String((a.params as { name?: string }).name ?? (a.target as { cabinetId?: string }).cabinetId ?? '')}`);
  const firstPlace = compile3.actions.findIndex((a) => a.action === 'cabinet.place');
  ok('链式编译：3 create 在前、2 place 在后', firstPlace === 3 && compile3.actions.length === 5, JSON.stringify(opList));
  ok('链式依赖序：B 的落位排在 C 之前（C 要用 B 的新位置）', String(compile3.actions[firstPlace]!.params.reference) === '$ref:a' && String(compile3.actions[firstPlace + 1]!.params.reference) === '$ref:b', JSON.stringify(opList));
  const bus3 = new CommandBus(sampleProject(rules), rules);
  const run3 = dryRunPlan({ bus: bus3, actions: compile3.actions });
  const chainOk = run3.steps.every((s) => s.ok);
  const bxA = footprintBox(run3.draft.cabinets.find((c) => c.name === '链A')!);
  const bxB = footprintBox(run3.draft.cabinets.find((c) => c.name === '链B')!);
  const bxC = footprintBox(run3.draft.cabinets.find((c) => c.name === '链C')!);
  ok('三柜连续干跑全过', chainOk, JSON.stringify(run3.steps.filter((s) => !s.ok).map((s) => s.error)));
  ok('链A—链B 面贴合', bxB.min.x === bxA.max.x, JSON.stringify([bxA, bxB]));
  ok('链B—链C 面贴合（C 用的是 B 解析后的新位置）', bxC.min.x === bxB.max.x, JSON.stringify([bxB, bxC]));
  ok('三柜背面齐', bxB.min.y === bxA.min.y && bxC.min.y === bxA.min.y);

  // ── 负样本：每条都精确到码 ──
  const withCycle: DesignProposal = {
    ...baseProposal,
    cabinets: [
      { ref: 'base', name: '甲', placement: { relation: 'adjacent', reference: 'next', side: 'right' } },
      { ref: 'next', name: '乙', placement: { relation: 'adjacent', reference: 'base', side: 'right' } },
    ],
  };
  ok('方案成环 → PROPOSAL-PLACE-CYCLE', placeIssueCodes(withCycle).includes('PROPOSAL-PLACE-CYCLE'), JSON.stringify(placeIssueCodes(withCycle)));
  const noSide: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'base', name: '甲' },
    { ref: 'next', name: '乙', placement: { relation: 'adjacent', reference: 'base' } as never },
  ] };
  ok('缺 side → PROPOSAL-PLACE-SIDE', placeIssueCodes(noSide).includes('PROPOSAL-PLACE-SIDE'));
  const badAlign: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'base', name: '甲' },
    { ref: 'next', name: '乙', placement: { relation: 'adjacent', reference: 'base', side: 'right', alignment: 'left' } },
  ] };
  ok('对齐与方向不匹配 → PROPOSAL-PLACE-ALIGNMENT', placeIssueCodes(badAlign).includes('PROPOSAL-PLACE-ALIGNMENT'));
  const ghostRef: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'base', name: '甲' },
    { ref: 'next', name: '乙', placement: { relation: 'adjacent', reference: 'ghost', side: 'right' } },
  ] };
  ok('参照不存在 → PROPOSAL-PLACE-REF', placeIssueCodes(ghostRef).includes('PROPOSAL-PLACE-REF'));
  const selfRef: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'base', name: '甲' },
    { ref: 'next', name: '乙', placement: { relation: 'adjacent', reference: 'next', side: 'right' } },
  ] };
  ok('自参照 → PROPOSAL-PLACE-SELF', placeIssueCodes(selfRef).includes('PROPOSAL-PLACE-SELF'));
  const badRel: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'base', name: '甲' },
    { ref: 'next', name: '乙', placement: { relation: 'beside', reference: 'base' } as never },
  ] };
  ok('未知关系 → PROPOSAL-PLACE-RELATION', placeIssueCodes(badRel).includes('PROPOSAL-PLACE-RELATION'));

  // 形状门：方案里出现坐标直接拒收（AI 不得把坐标当意图塞进来）
  const shapeErr = proposalShapeError({ title: 't', cabinets: [{ ref: 'a', placement: { relation: 'adjacent', reference: 'b', side: 'right', x: 100 } }] });
  ok('形状门：placement 夹带 x → 拒收', typeof shapeErr === 'string' && shapeErr.includes('坐标'), String(shapeErr));
  const shapeOk = proposalShapeError({ title: 't', cabinets: [{ ref: 'a', placement: { relation: 'adjacent', reference: 'b', side: 'right' } }] });
  ok('形状门：合法 placement 放行', shapeOk === null, String(shapeOk));

  // compileAction 层：AI 直接给 absolute → 拒收
  const fresh4 = sampleProject(rules);
  const absAction: AiAction = {
    action: 'cabinet.place',
    target: { cabinetName: '主卧衣柜' },
    params: { relation: 'absolute', reference: '主卧衣柜', x: 100, y: 200 } as never,
    reason: '验收：AI 不得给绝对坐标',
    index: 0,
  };
  const absCompiled = compileAction(absAction, fresh4, rules);
  ok('AI 给 absolute → 编译拒收（绝对坐标是授权输入，不是 AI 的）', !absCompiled.ok && String(absCompiled.error).includes('absolute'), absCompiled.ok ? '' : String(absCompiled.error));
  const contractParams = Object.keys((ACTIONS as Record<string, { params: Record<string, unknown> }>)['cabinet.place']!.params);
  ok('契约 cabinet.place 没有 x/y 坐标参数（结构性保证）', !contractParams.includes('x') && !contractParams.includes('y'), JSON.stringify(contractParams));
}

// ═══════════════════ §7 2D / 3D 同一 resolved placement ═══════════════════
section('§7 2D 与 3D 消费同一份 resolved placement（单源派生）');
{
  const project = mkProject();
  const beforePlan = primBox(generateProject(project, rules).cabinets['cab_B']!.plan);
  const bodiesBefore = generateProject(project, rules).bodies3d.filter((b) => b.cabId === 'cab_B');
  const meanCxBefore = bodiesBefore.reduce((a, b) => a + b.cx, 0) / bodiesBefore.length;

  const bus = new CommandBus(project, rules);
  const r = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }, sceneFromProject(bus.getState()));
  const cabB = bus.getState().cabinets.find((c) => c.id === 'cab_B')!;
  bus.execute(CMD.placeCabinet(cabB, r.ok ? r.placement : { x: 0, y: 0, rotation: 0 }, 'ai'));

  const geom = generateProject(bus.getState(), rules);
  const planAfter = primBox(geom.cabinets['cab_B']!.plan);
  const bodiesAfter = geom.bodies3d.filter((b) => b.cabId === 'cab_B');
  const meanCxAfter = bodiesAfter.reduce((a, b) => a + b.cx, 0) / bodiesAfter.length;
  const DX = 2800 - 1000; // 解析出的 X 位移
  ok('2D（plan 图元）随落位平移了同样的位移', Math.abs(planAfter.min.x - beforePlan.min.x - DX) < 0.5, `plan dx=${planAfter.min.x - beforePlan.min.x} 期望 ${DX}`);
  ok('3D（bodies3d 体块）随落位平移了同样的位移', Math.abs(meanCxAfter - meanCxBefore - DX) < 0.5, `3d dx=${meanCxAfter - meanCxBefore} 期望 ${DX}`);
  ok('2D 与 3D 同源于一次 derive（generateProject 单源，视图各自不重算落位）', bodiesAfter.length > 0 && geom.cabinets['cab_B']!.plan.length > 0);
}

// ═══════════════════ 汇总 ═══════════════════
console.log(`\n总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败断言：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
