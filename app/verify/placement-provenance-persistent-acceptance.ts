/**
 * ══════════════════════════════════════════════════════════════════════
 *  P8.5-B 验收 —— Persistent Placement Provenance（落位来源跨会话持久化）
 *
 *  基线：P8.5-C1 已落地（会话内 provenance）。本阶段把它随柜体落盘进 project.json，
 *  方案 A：每柜只存当前 live（intent/authority/byOp/atVersion），不升 schemaVersion、
 *  不加 migration、不存坐标/几何、Resolver 不读、reload 不回放观察。
 *
 *  ── 这条验收真正在防什么 ──
 *   ① **来源跨会话丢失。** 关闭项目再打开，placement 的来源（谁摆的、什么意图、
 *      是否用户确认）必须还在，否则 alignment 偏好无法跨会话积累、AI 确认过的
 *      落位会退化成 ai-inferred。
 *   ② **第二套位置真相。** provenance 只能解释 placement，绝不能含 x/y/rotation；
 *      任何派生层（几何/DXF/清单/P8.3）一律不读它。
 *   ③ **import 伪造意图。** 外部来源没有真实落位意图 → intent=null，绝不写 alignment/attach。
 *   ④ **reload 自我强化。** 重新打开项目绝不能重放观察、不能让 Knowledge evidence +1；
 *      去重由「reload 不回放」+「recordObservation 内容合并」双保险守住。
 *   ⑤ **原子一致。** execute/undo/redo 时 placement 与 provenance 必须一起变、一起回退，
 *      不能出现「placement 回去了、provenance 还停在旧 live」。
 *   ⑥ **诚实边界。** 不升 schemaVersion、老文件逐字节兼容、缺失字段 = unknown。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, FurnitureAssembly, Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import * as CMD from '../src/core/commands.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import { toPlacementIntentDecl, type PlacementIntent } from '../src/core/placement.ts';
import { commitPlan, dryRunPlan } from '../src/ai/planRunner.ts';
import type { DesignProposal } from '../src/ai/proposal.ts';
import { compileProposal } from '../src/ai/compileProposal.ts';
import {
  observeCommand,
  recordObservation,
  type KnowledgeEntry,
  type PlacementContext,
} from '../src/ai/knowledge/index.ts';
import { serializeProjectFile, parseProjectFile, resolveSchemaVersion } from '../src/core/projectFile.ts';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
let section_ = '';
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`[${section_}] ${name}`);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(t: string): void {
  section_ = t;
  console.log(`\n【${t}】`);
}
const eq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const ROOM = rectRoom({ name: '测试房', x: 0, y: 0, w: 9000, h: 6000, thickness: 100, height: 2700 });

function mkCab(id: string, name: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet {
  // 每个柜的分区 id 必须全局唯一（parseProjectFile 的硬约束）；手动构建时按柜 id 加前缀。
  const units = defaultUnits(w, rules, d).map((u) => ({ ...u, id: `${id}_${u.id}` }));
  return createCabinet({
    id,
    name,
    roomId: ROOM.id,
    x,
    y,
    rotation,
    rules,
    params: { ...defaultCabinetParams(rules), width: w, height: 2200, depth: d },
    units,
  });
}
function mkProject(cabs: Cabinet[], assemblies?: FurnitureAssembly[]): Project {
  return {
    schemaVersion: '0.3',
    id: 'proj_p85b',
    name: 'P8.5-B 持久化验收',
    ruleSetId: rules.id,
    rooms: [ROOM],
    cabinets: cabs,
    ...(assemblies ? { assemblies } : {}),
  };
}

const CTX: PlacementContext = { contact: 'corner', turnSide: 'right' };
const adjIntent: PlacementIntent = { relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right', alignment: 'back' };
const declAdj = toPlacementIntentDecl(adjIntent);

/** 存盘 → 解析 → 新总线（模拟关闭项目后重新打开）。
 *  保存走 bus.toFileSnapshot()：provenance 只在文件形状里物化（内存模型永远干净）。 */
function saveAndReload(bus: CommandBus): { bus: CommandBus; project: Project } {
  const json = serializeProjectFile(bus.toFileSnapshot());
  const parsed = parseProjectFile(json);
  if (!parsed.ok) throw new Error(`保存后重新解析失败：${parsed.error}`);
  return { bus: new CommandBus(parsed.project, rules), project: parsed.project };
}
const cabB = (p: Project): Cabinet => p.cabinets.find((c) => c.id === 'cab_B')!;

// ═══════════════ §1 持久化：provenance 写入 / 不丢 / 不含几何 ═══════════════
section('§1 持久化：provenance 写入 project.json、不丢、不含坐标/几何');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  bus.execute(CMD.placeCabinet(bus.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位副臂B', declAdj));
  const { project: reloaded } = saveAndReload(bus);
  const pp = cabB(reloaded).placementProvenance;

  ok('1. provenance 已写入 project.json（落盘后存在）', pp !== undefined, JSON.stringify(pp));
  ok('2. 落盘 intent 逐值等于声明 decl（targetId 已剥）', pp !== undefined && eq(pp.intent, declAdj), JSON.stringify(pp?.intent));
  ok('3. 落盘 authority = user-authored（ui 手动落位）', pp?.authority === 'user-authored', String(pp?.authority));
  ok('4. 落盘 byOp = cabinet.place', pp?.byOp === 'cabinet.place', String(pp?.byOp));
  ok('5. 落盘 atVersion 是数字（可复现指针）', typeof pp?.atVersion === 'number', String(pp?.atVersion));

  // 不含坐标/几何快照（第二套位置真相的红线）
  const keys = pp ? Object.keys(pp) : [];
  ok('6. 落盘对象只含 {intent,authority,byOp,atVersion}，不含 x/y/z/rotation/bbox',
    pp !== undefined && keys.every((k) => ['intent', 'authority', 'byOp', 'atVersion'].includes(k)),
    JSON.stringify(keys));
  ok('7. 落盘对象不含 x/y/z（provenance 不复制几何）', pp !== undefined && !('x' in pp) && !('y' in pp) && !('z' in pp), JSON.stringify(keys));

  // placement 本身逐值不变
  const placed = bus.getState().cabinets[1]!.placement;
  ok('8. reload 后 placement 逐值不变（几何真相不被 provenance 污染）', eq(cabB(reloaded).placement, placed), JSON.stringify(cabB(reloaded).placement));

  // 二次 round-trip 仍不丢
  const bus2 = new CommandBus(reloaded, rules);
  const { project: reloaded2 } = saveAndReload(bus2);
  ok('9. 二次 round-trip 后 provenance 仍不丢且相等', eq(reloaded2.cabinets[1]!.placementProvenance, pp), JSON.stringify(reloaded2.cabinets[1]!.placementProvenance));

  // 结构不变量：provenance 只住总线，内存模型永远干净（预览===提交 / 干跑===提交逐字节相同的保证）
  ok('9b. 会话内内存模型不带 placementProvenance（只在 toFileSnapshot 物化）',
    bus.getState().cabinets.every((c) => c.placementProvenance === undefined),
    JSON.stringify(bus.getState().cabinets.map((c) => c.placementProvenance)));
}

// ═══════════════ §2 老项目：无 provenance 正常加载 ═══════════════
section('§2 老项目（无 placementProvenance）正常加载，不升版本');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const { project: reloaded } = saveAndReload(new CommandBus(project, rules));
  ok('10. 老项目（不曾落位 provenance）解析成功', reloaded.cabinets.every((c) => c.placementProvenance === undefined), JSON.stringify(reloaded.cabinets.map((c) => c.placementProvenance)));
  ok('11. 老项目 schemaVersion 保持内容驱动值（不因任何字段机械升版本）', reloaded.schemaVersion === resolveSchemaVersion(reloaded), `${reloaded.schemaVersion} vs ${resolveSchemaVersion(reloaded)}`);
}

// ═══════════════ §3 AI：未确认 ≠ user-confirmed；确认后跨会话保持 ═══════════════
section('§3 AI：未确认 unknown；确认后 user-confirmed 跨会话不退化');
{
  // 6. 未确认 AI 落位
  const p1 = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const b1 = new CommandBus(p1, rules);
  b1.execute(CMD.placeCabinet(b1.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 0 }, 'ai', 'AI 草稿（未确认）', declAdj));
  const r1 = saveAndReload(b1);
  ok('12. AI 未确认落位 reload 后 authority = unknown（绝不冒充 user）', r1.project.cabinets[1]!.placementProvenance?.authority === 'unknown', JSON.stringify(r1.project.cabinets[1]!.placementProvenance));
  ok('13. AI 未确认 reload 后总线仍读得到 unknown', r1.bus.getPlacementProvenance('cab_B')?.authority === 'unknown');

  // 7/8. 确认过的 AI 提案
  const p2 = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600)]);
  const proposal: DesignProposal = {
    title: '接一条副臂',
    summary: '主臂旁接一条副臂，按背面齐',
    room: '测试房',
    cabinets: [{ ref: 'b', name: '副臂B', width: 900, height: 2200, depth: 600, placement: { relation: 'adjacent', reference: '主臂A', side: 'right', alignment: 'back' } }],
    assumptions: [], questions: [],
  };
  const compiled = compileProposal(proposal, p2, rules);
  const bus = new CommandBus(p2, rules);
  const run = dryRunPlan({ bus, actions: compiled.actions });
  const cm = commitPlan(run, bus);
  ok('14. commitPlan 成功', cm.ok, cm.error ?? '');
  const r2 = saveAndReload(bus);
  const pp = r2.project.cabinets.find((c) => c.name === '副臂B')!.placementProvenance;
  ok('15. AI 提案经人确认后 reload authority = user-confirmed（根治退化成 ai-inferred）', pp?.authority === 'user-confirmed', JSON.stringify(pp));
  ok('16. 确认后的 intent 仍带着 alignment（跨会话可学）', pp !== undefined && eq(pp.intent, { relation: 'adjacent', referenceId: 'cab_A', side: 'right', alignment: 'back' }), JSON.stringify(pp?.intent));
  ok('17. reload 后总线 getPlacementProvenance 仍 = user-confirmed', r2.bus.getPlacementProvenance(r2.project.cabinets.find((c) => c.name === '副臂B')!.id)?.authority === 'user-confirmed');
}

// ═══════════════ §4 User：authored 保留；修改产生新 live；旧记录失效 ═══════════════
section('§4 User：user-authored 保留；后续修改产生新 live；旧记录 superseded');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  const b = () => bus.getState().cabinets[1]!;
  bus.execute(CMD.placeCabinet(b(), { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位', declAdj));
  bus.execute(CMD.moveCabinet(b(), 4300, 1560, 'ui'));

  // 会话内：place 被 superseded，move 是 live
  const liveEntry = bus.log().filter((e) => e.placementProvenance).at(-1)!;
  ok('18. 多次落位后，会话内最后一条（move）为 live', provStatus(liveEntry) === 'live', provStatus(liveEntry));
  ok('19. 前一条（place）在会话内被标 superseded', bus.log().filter((e) => e.placementProvenance).slice(0, -1).every((e) => provStatus(e) === 'superseded'));

  const r = saveAndReload(bus);
  const pp = r.project.cabinets[1]!.placementProvenance;
  ok('20. reload 后 persist 的是新 live（move），byOp = cabinet.move', pp?.byOp === 'cabinet.move', JSON.stringify(pp));
  ok('21. reload 后 persist 的 move 记录 intent = null（手移无语义意图，不伪造）', pp?.intent === null, JSON.stringify(pp?.intent));
  ok('22. reload 后 user-authored 保留（手移也是人的决定）', pp?.authority === 'user-authored', String(pp?.authority));

  // 11 续：reload 后再 move 一次 → 新 live 覆盖（不残留旧）
  r.bus.execute(CMD.moveCabinet(r.bus.getState().cabinets[1]!, 4400, 1560, 'ui'));
  const r2 = saveAndReload(r.bus);
  const pp2 = r2.project.cabinets[1]!.placementProvenance;
  ok('23. reload 后再修改：新 live（第二次 move）覆盖旧，byOp = cabinet.move', pp2?.byOp === 'cabinet.move', JSON.stringify(pp2?.byOp));
}

// ═══════════════ §5 execute/undo/redo：placement 与 provenance 原子一致 ═══════════════
section('§5 execute/undo/redo：placement 与 provenance 原子一致、不残留 stale');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  const b = () => bus.getState().cabinets[1]!;
  const prov = () => bus.getPlacementProvenance('cab_B');
  const created = { ...b().placement };

  bus.execute(CMD.placeCabinet(b(), { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位', declAdj));
  ok('24. execute 后 placement 已变 + provenance 为 live', b().placement.x === 4200 && prov()?.authority === 'user-authored', JSON.stringify(prov()));

  bus.undo(); // 撤销落位
  ok('25. undo 后 placement 回到创建时坐标（几何回退）', eq(b().placement, created), JSON.stringify(b().placement));
  ok('26. undo 后 provenance 同步清空（不残留已被撤销命令的 stale live）', prov() === undefined, JSON.stringify(prov()));

  bus.redo(); // 重做落位
  ok('27. redo 后 placement 恢复 + provenance 恢复为 live', b().placement.x === 4200 && prov()?.authority === 'user-authored');

  // 分支历史：place → move → undo move → undo place → redo place → redo move
  bus.execute(CMD.moveCabinet(b(), 4300, 1560, 'ui'));
  bus.undo(); // 撤销 move → 回到 place live
  ok('28. undo move 后 live 回到 place（move 的 stale 不残留）', b().placement.x === 4200 && prov()?.byOp === 'cabinet.place', JSON.stringify(prov()?.byOp));
  bus.undo(); // 撤销 place → 回到创建坐标，prov 清空
  ok('29. 再 undo place 后 placement 回创建坐标 + provenance 清空', eq(b().placement, created) && prov() === undefined);
  bus.redo();
  bus.redo();
  ok('30. 重做链末端 placement = move 位置 + provenance 为 move live（分支未错误复活旧 provenance）',
    b().placement.x === 4300 && prov()?.byOp === 'cabinet.move', JSON.stringify(prov()));
}

// ═══════════════ §6 Reload：只恢复 provenance，不触发观察 ═══════════════
section('§6 Reload：只恢复 provenance，不回放观察、不产生重复 evidence');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  bus.execute(CMD.placeCabinet(bus.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位', declAdj));
  const { bus: reloaded } = saveAndReload(bus);
  ok('31. reload 后总线仍读得到落位 provenance（来源已恢复）', reloaded.getPlacementProvenance('cab_B')?.authority === 'user-authored');
  ok('32. reload 后命令日志为空（App 的 observedSeqRef 闸门不会回放 → 不产生 observation）', reloaded.log().length === 0, String(reloaded.log().length));

  // 18 续：同一观察喂两次 → 内容合并，不 +1（自我强化的双保险）
  const placeCmd = CMD.placeCabinet(bus.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位', declAdj);
  const obs = observeCommand(placeCmd, placeCmd.changes, '副臂B', CTX, 'user-confirmed');
  let know: KnowledgeEntry[] = [];
  know = recordObservation(know, obs[0]!);
  const afterFirst = know.length;
  know = recordObservation(know, obs[0]!); // 同样的观察再喂一次
  ok('33. 同一观察重复喂入 → Knowledge 只 1 条 candidate（内容合并，不自我强化）', afterFirst === 1 && know.length === 1, `${afterFirst} -> ${know.length}`);
}

// ═══════════════ §7 Import / 载入：外来=unknown；自家=恢复；undo/redo 原子 ═══════════════
section('§7 Import：无真实意图 → intent=null；replaceProject 旧柜不残留、自家 provenance 可恢复');
{
  // 19/20. 增量导入式落位（外部只给坐标，无语义关系）→ intent=null
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  // 不带 placementIntent 的落位 = 外部来源只有坐标（DXF/JSON）→ 诚实 intent=null
  bus.execute(CMD.placeCabinet(bus.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 90 }, 'ui', '导入落位（无语义意图）'));
  const r = saveAndReload(bus);
  const pp = r.project.cabinets[1]!.placementProvenance;
  ok('34. 导入式落位（无 intent）reload 后 intent = null（不反推 alignment/attach）', pp?.intent === null, JSON.stringify(pp?.intent));
  ok('35. 导入式落位不会伪造 authority 暗示 attach（intent 缺失即诚实）', pp?.intent === null && pp?.authority === 'user-authored');

  // 21. replaceProject（整批载入外来项目）清空旧柜 provenance
  const bus2 = new CommandBus(mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]), rules);
  bus2.execute(CMD.placeCabinet(bus2.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位副臂B', declAdj));
  const imported = mkProject([mkCab('cab_X', '导入柜', 1000, 1000, 900, 600)]);
  bus2.replaceProject(imported, '导入外部项目');
  ok('36. replaceProject 后：旧柜（cab_B）provenance 已从总线清除', bus2.getPlacementProvenance('cab_B') === undefined);
  ok('37. replaceProject 后：新柜（cab_X）provenance 为 undefined（外来来源天然 unknown）',
    bus2.getPlacementProvenance('cab_X') === undefined && bus2.toFileSnapshot().cabinets.every((c) => c.placementProvenance === undefined),
    JSON.stringify(bus2.toFileSnapshot().cabinets.map((c) => c.placementProvenance)));

  // 21b. 自家格式载入（项目文件 / 草稿恢复）→ provenance 原样恢复（user-confirmed 不退化）
  const own = mkProject([mkCab('cab_Y', '自家柜', 1500, 500, 900, 600)]);
  own.cabinets[0]!.placementProvenance = { intent: declAdj, authority: 'user-confirmed', byOp: 'cabinet.place', atVersion: 7 };
  bus2.replaceProject(own, '恢复本地草稿');
  const restored = bus2.getPlacementProvenance('cab_Y');
  ok('38. 载入自家格式：provenance 原样恢复（user-confirmed 不退化成 unknown/ai）',
    restored?.authority === 'user-confirmed' && eq(restored?.intent, declAdj) && restored?.atVersion === 7, JSON.stringify(restored));
  ok('39. 恢复后内存模型仍干净（只在 toFileSnapshot 物化）',
    bus2.getState().cabinets.every((c) => c.placementProvenance === undefined));

  // 21c. replaceProject 的 undo/redo：provenance 双向原子恢复
  bus2.undo(); // 撤销载入 → 回到导入项目（无 provenance）
  ok('40. undo 载入后：placement/provenance 一起回到替换前（cab_Y 消失、provenance 为空）',
    !bus2.getState().cabinets.some((c) => c.id === 'cab_Y') && bus2.getPlacementProvenance('cab_Y') === undefined);
  bus2.redo(); // 重做载入 → provenance 再次恢复
  ok('41. redo 载入后：provenance 再次恢复（user-confirmed 不因 redo 丢失）',
    bus2.getPlacementProvenance('cab_Y')?.authority === 'user-confirmed');
}

// ═══════════════ §8 Resolver / Knowledge：几何不受 provenance 影响；证据纪律 ═══════════════
section('§8 Resolver 不读 provenance；P8.4 朝向学习正常；user-confirmed 可成证据');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  bus.execute(CMD.placeCabinet(bus.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位', declAdj));
  const placed = bus.getState().cabinets[1]!.placement;
  const { project: reloaded } = saveAndReload(bus);
  // 22. 几何与是否持久化 provenance 无关：reload 后 placement 逐值相等
  ok('38. Resolved 几何与是否持久化 provenance 无关：reload 后 placement 逐值相等', eq(reloaded.cabinets[1]!.placement, placed));

  // 24. P8.4 朝向偏好学习：人的 rotate 产生 orientation 观察
  const rotCmd = CMD.rotateCabinet(bus.getState().cabinets[1]!, 270, 'ui');
  const rotObs = observeCommand(rotCmd, [{ path: 'placement.rotation', from: 0, to: 270 }], '副臂B', CTX, 'user-authored');
  ok('39. 人的 rotate → 产生 orientation 观察（P8.4 学习正常）', rotObs.some((o) => o.predicate.kind === 'orientation' && o.predicate.value === 270));

  // 25. Resolver 算出的 rotation（system place）不被误认成 user preference
  const sysPlace = CMD.placeCabinet(bus.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 90 }, 'system', '系统自动落位');
  const sysObs = observeCommand(sysPlace, sysPlace.changes, '副臂B', CTX, 'system-resolved');
  ok('40. system（Resolver）落位 → 不产生 orientation 观察（解析坐标不算人的习惯）', !sysObs.some((o) => o.predicate.kind === 'orientation'));

  // 26. user-confirmed AI 落位成为合法证据
  const confPlace = CMD.placeCabinet(bus.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 0 }, 'ai', '确认过的提案', declAdj);
  confPlace.confirmedPlan = true;
  const confObs = observeCommand(confPlace, confPlace.changes, '副臂B', CTX, 'user-confirmed');
  ok('41. user-confirmed AI 落位 → 产生 alignment 证据（来源 user-observed），可作为合法证据',
    confObs.some((o) => o.predicate.kind === 'alignment' && o.evidence.source === 'user-observed'));

  // 27. evidence 去重成立（同 §6 的 33，这里再在 knowledge 层确认）
  let know: KnowledgeEntry[] = [];
  know = recordObservation(know, confObs[0]!);
  const n1 = know.length;
  know = recordObservation(know, confObs[0]!);
  ok('42. 同一 alignment 观察重复 → 仍 1 条 candidate（去重成立）', n1 === 1 && know.length === 1);
}

// ═══════════════ §9 SchemaVersion / migration：不升版本，老文件兼容 ═══════════════
section('§9 schemaVersion / migration：不升版本；老 JSON 兼容；缺失字段 = unknown');
{
  // 28. 不升 schemaVersion
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  bus.execute(CMD.placeCabinet(bus.getState().cabinets[1]!, { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位', declAdj));
  const json = serializeProjectFile(bus.toFileSnapshot());
  const parsed = parseProjectFile(json);
  // 43 的真正判据：同一份内容，带 provenance 与不带 provenance 的存档 schemaVersion 完全相等
  // —— provenance 是可选字段，绝不强制升版本。
  const noProv = bus.toFileSnapshot();
  for (const c of noProv.cabinets) c.placementProvenance = undefined;
  const jsonNoProv = serializeProjectFile(noProv);
  const parsedNoProv = parseProjectFile(jsonNoProv);
  ok('43. 带/不带 provenance 的同内容存档 schemaVersion 相等（provenance 不强制升版本）',
    parsed.ok && parsedNoProv.ok && parsed.project.schemaVersion === parsedNoProv.project.schemaVersion,
    `${parsed.ok ? parsed.project.schemaVersion : parsed.error} vs ${parsedNoProv.ok ? parsedNoProv.project.schemaVersion : parsedNoProv.error}`);

  // 29. 老 JSON（无 placementProvenance）round-trip
  const oldJson = JSON.stringify({
    format: 'furniture-cad-project',
    formatVersion: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    project: {
      schemaVersion: '0.3',
      id: 'old',
      name: '老项目',
      ruleSetId: rules.id,
      rooms: [ROOM],
      cabinets: [{ id: 'cab_A', name: '主臂A', roomId: ROOM.id, placement: { x: 2000, y: 60, rotation: 0 }, params: { ...defaultCabinetParams(rules), width: 1500, height: 2200, depth: 600 }, layout: { units: defaultUnits(1500, rules, 600) } }],
    },
  });
  const oldParsed = parseProjectFile(oldJson);
  ok('44. 老 JSON（无 placementProvenance）解析成功', oldParsed.ok, oldParsed.ok ? '' : oldParsed.error);
  ok('45. 老 JSON 的柜 placementProvenance = undefined（兼容，不作废）', oldParsed.ok && oldParsed.project.cabinets[0]!.placementProvenance === undefined);
  const reOld = saveAndReload(new CommandBus(oldParsed.project, rules));
  ok('46. 老 JSON round-trip 后 provenance 仍为 undefined，不伪造', reOld.project.cabinets[0]!.placementProvenance === undefined);

  // 30. 新 JSON 缺失可选 provenance 行为正常
  const noProvJson = JSON.stringify({
    format: 'furniture-cad-project',
    formatVersion: 1,
    savedAt: '2026-01-01T00:00:00.000Z',
    project: {
      schemaVersion: '0.3',
      id: 'np',
      name: '缺 provenance',
      ruleSetId: rules.id,
      rooms: [ROOM],
      cabinets: [{ id: 'cab_A', name: '主臂A', roomId: ROOM.id, placement: { x: 2000, y: 60, rotation: 0 }, params: { ...defaultCabinetParams(rules), width: 1500, height: 2200, depth: 600 }, layout: { units: defaultUnits(1500, rules, 600) }, placementProvenance: undefined }],
    },
  });
  const npParsed = parseProjectFile(noProvJson);
  ok('47. 显式 placementProvenance:undefined 的新 JSON 正常解析', npParsed.ok && npParsed.project.cabinets[0]!.placementProvenance === undefined, npParsed.ok ? '' : npParsed.error);
}

// ═══════════════ §10 源码扫描：派生层不读 provenance；落位层不读 knowledge ═══════════════
section('§10 源码扫描：provenance 只住总线/模型/UI；Resolver 不读、落位层不读 knowledge');
{
  const scan = (f: string): boolean => /placementProvenance|PlacementAuthority|derivePlacementAuthority/.test(readFileSync(join(APP, f), 'utf8'));
  // 允许：命令总线（定义/生命周期）、模型字段（types）、序列化守卫（projectFile）、UI 读 authority。
  // layoutModel.ts 经 structuredClone 整体透传、从不点名该字段（写形状唯一口径不碰 provenance），
  // 其透传正确性由 §1/§3/§9 的 round-trip 断言证明，不做点名断言。
  const allowed = ['src/core/commandBus.ts', 'src/core/types.ts', 'src/core/projectFile.ts', 'src/ui/App.tsx'];
  // 禁止：几何 / 落位词表(Resolver) / P8.3 设计语义 / DXF / 清单 —— 派生层一律不读
  const forbidden = [
    'src/core/placement.ts',
    'src/core/geometry/project.ts',
    'src/core/placementDesign.ts',
    'src/export/roomBook.ts',
    'src/export/neutralSheet.ts',
  ];
  for (const f of allowed) ok(`48. 允许出现落位来源引用：${f}`, scan(f), f);
  for (const f of forbidden) ok(`49. 派生/序列化层不读 provenance（${f}）`, !scan(f), f);

  const placementSrc = readFileSync(join(APP, 'src/core/placement.ts'), 'utf8');
  ok('50. placement.ts（Resolver/落位词表）不 import knowledge，结构上不可能读偏好',
    !/knowledge/i.test(placementSrc) && !/from '\.\/ai\//.test(placementSrc));
  ok('51. placement.ts 不出现 placementProvenance（它只定义 intent decl，不读 provenance）', !/placementProvenance/.test(placementSrc));
}

// ───────────────────────── 工具 ─────────────────────────
function provStatus(e: { placementProvenance?: unknown }): string {
  const p = e.placementProvenance;
  if (!p) return 'none';
  const arr = Array.isArray(p) ? p : [p];
  return arr.map((x) => (x as { status?: string }).status).join(',');
}

// ═════════════════ 汇总 ═══════════════════
console.log(`\n总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败断言：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
