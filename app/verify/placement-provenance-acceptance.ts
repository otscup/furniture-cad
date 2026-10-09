/**
 * ══════════════════════════════════════════════════════════════════════
 *  P8.5-C1 验收 —— Placement Intent Provenance（命令层落位来源）
 *
 *  出口判据：**落位权威由总线单点派生，调用方无从伪造；provenance 只是被动
 *  记录，任何派生层（几何/清单/DXF/P8.3）一律不读。**
 *
 *  ── 这一批断言真正在防什么 ──
 *   ① **声明通道缺失。** 确认过的落位提案必须能把"用了哪个面/对齐"带进命令，
 *      否则 alignment 偏好永远只能从坐标猜（P8.4 主动缩范围的根因）。
 *   ② **authority 被调用方伪造。** 旧代码用 cmd.source 代理"是不是人的选择"，
 *      AI 提案经人点「应用」后 source 仍是 'ai' → 被当成 ai-inferred，结构性
 *      收不到落位证据。现在 authority = 总线从 (source × confirmedPlan) 派生，
 *      UI/mcp→user-authored、确认过的 AI→user-confirmed、system→system-resolved、
 *      未确认 AI/导入→unknown。**调用方无权声明**。
 *   ③ **观察门禁。** alignment / orientation 证据只从"人来授权的落位"产生：
 *      user-authored / user-confirmed 才产，unknown（未确认 AI）不产。
 *   ④ **失效判定漂移。** 同一只柜多此落位（place/rotate/move/resize/nudge/
 *      手动移回/重跑 intent）→ 只有最后一条 live，之前全 superseded，且随
 *      undo/redo 原子同步（模型回去、provenance 也回去）。
 *   ⑤ **导入伪造意图。** replaceProject 整批替换模型后，历史 provenance 必须清空
 *      （不指向已删的柜、绝不伪造"导入来的柜是谁摆的"）。
 *   ⑥ **派生层读 provenance。** placement.ts 不 import knowledge；geometry /
 *      export / placementDesign（P8.3）不出现 placementProvenance / PlacementAuthority
 *      / derivePlacementAuthority —— 落位来源不影响几何算法。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, FurnitureAssembly, Project, RuleSet } from '../src/core/types.ts';
import { CommandBus, type Command } from '../src/core/commandBus.ts';
import * as CMD from '../src/core/commands.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import { toPlacementIntentDecl, type PlacementIntent } from '../src/core/placement.ts';
import { commitPlan, dryRunPlan } from '../src/ai/planRunner.ts';
import type { DesignProposal } from '../src/ai/proposal.ts';
import { compileProposal } from '../src/ai/compileProposal.ts';
import {
  observeCommand,
  type PlacementContext,
} from '../src/ai/knowledge/index.ts';

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
const provList = (e: { placementProvenance?: unknown }): Array<Record<string, unknown>> => {
  const p = e.placementProvenance;
  if (!p) return [];
  return (Array.isArray(p) ? p : [p]) as Array<Record<string, unknown>>;
};

// ───────────────────────── 场景 ─────────────────────────

const ROOM = rectRoom({ name: '测试房', x: 0, y: 0, w: 9000, h: 6000, thickness: 100, height: 2700 });

function mkCab(id: string, name: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet {
  const units = defaultUnits(w, rules, d).map((unit) => ({ ...unit, id: `${id}_${unit.id}` }));
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

function assertUniqueUnitIds(cabs: Cabinet[]): void {
  const ownerByUnitId = new Map<string, string>();
  for (const cab of cabs) {
    for (const unit of cab.layout.units) {
      const previousOwner = ownerByUnitId.get(unit.id);
      if (previousOwner) {
        throw new Error(`provenance 验收夹具 Unit ID 必须全局唯一：${unit.id} 同时属于柜体 ${previousOwner} 和 ${cab.id}`);
      }
      ownerByUnitId.set(unit.id, cab.id);
    }
  }
}

function mkProject(cabs: Cabinet[], assemblies?: FurnitureAssembly[]): Project {
  assertUniqueUnitIds(cabs);
  return {
    schemaVersion: '0.3',
    id: 'proj_p85',
    name: 'P8.5 落位来源验收',
    ruleSetId: rules.id,
    rooms: [ROOM],
    cabinets: cabs,
    ...(assemblies ? { assemblies } : {}),
  };
}

const CTX: PlacementContext = { contact: 'corner', turnSide: 'right' };

const adjIntent: PlacementIntent = { relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right', alignment: 'back' };
const declAdj = toPlacementIntentDecl(adjIntent);

const atRight = { x: 4200, y: 1560, rotation: 0 };

function executeAndAssertOk(bus: CommandBus, cmd: Command, label: string): void {
  const result = bus.execute(cmd);
  const detail = result.ok
    ? ''
    : `op=${cmd.op}; commandId=${cmd.id}; source=${cmd.source}; error=${result.error ?? '未提供错误详情'}`;
  ok(`${label} 执行成功`, result.ok, detail);
  if (!result.ok) {
    throw new Error(`[${section_}] ${label} 执行失败：${detail}`);
  }
}

// ═══════════════ §1 声明通道：placementIntent 进命令、进 provenance ═══════════════
section('§1 声明通道：placementIntent 通过 cabinet.place 落到 provenance');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  executeAndAssertOk(bus, CMD.placeCabinet(project.cabinets[1]!, atRight, 'ui', '落位副臂B', declAdj), '带 intent 的 cabinet.place');
  const e = bus.log()[bus.log().length - 1]!;
  ok('cabinet.place 带 placementIntent → 产生单条 provenance（不是数组）',
    e.placementProvenance !== undefined && !Array.isArray(e.placementProvenance), JSON.stringify(e.placementProvenance));
  const prov = provList(e)[0]!;
  ok('provenance 的 intent 逐值等于声明的 decl（targetId 已剥）',
    eq(prov.intent, declAdj), JSON.stringify(prov.intent));
  ok('provenance 的 byOp = cabinet.place', prov.byOp === 'cabinet.place', String(prov.byOp));
  ok('provenance 不存 resolved 坐标（只声明不决定坐标）：对象无 x/y 字段',
    !('x' in prov) && !('y' in prov), JSON.stringify(Object.keys(prov)));
  ok('provenance 的 status 初值 = live', prov.status === 'live', String(prov.status));

  // 不带 placementIntent 的 cabinet.place（例如系统自动贴墙）也会产生 provenance，但 intent = null
  const bus2 = new CommandBus(project, rules);
  executeAndAssertOk(bus2, CMD.placeCabinet(project.cabinets[1]!, { x: 4000, y: 60, rotation: 90 }, 'system'), '不带 intent 的 system cabinet.place');
  const e2 = bus2.log()[bus2.log().length - 1]!;
  const prov2 = provList(e2)[0]!;
  ok('不带 intent 的落位也产生 provenance（status 跟踪需要），但 intent = null（不伪造）',
    prov2 !== undefined && prov2.intent === null, JSON.stringify(prov2?.intent));

  // 非落位 op（cabinet.update 改宽，不在 PLACEMENT_OPS）→ 不产生 provenance
  const bus3 = new CommandBus(project, rules);
  const updCmd: Command = { id: 'c_upd', op: 'cabinet.update', source: 'ui', target: { kind: 'cabinet', id: 'cab_B' }, changes: [{ path: 'params.width', op: 'set', value: 1000 }], label: '改宽' };
  executeAndAssertOk(bus3, updCmd, '非落位 cabinet.update');
  const e3 = bus3.log()[bus3.log().length - 1]!;
  ok('非落位 op（cabinet.update）不写 provenance（undefined）', e3.placementProvenance === undefined, JSON.stringify(e3.placementProvenance));
}

// ═══════════════ §2 authority 派生矩阵（总线单点，调用方无从声明） ═══════════════
section('§2 authority 派生矩阵：source × confirmedPlan → authority');
{
  const mk2 = () => mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);

  const uiBus = new CommandBus(mk2(), rules);
  executeAndAssertOk(uiBus, CMD.placeCabinet(uiBus.getState().cabinets[1]!, atRight, 'ui', 'ui 手动落位', declAdj), "source='ui' 落位");
  const uiProv = provList(uiBus.log().at(-1)!)[0]!;
  ok("source='ui' → authority=user-authored", uiProv.authority === 'user-authored', String(uiProv.authority));

  const mcpBus = new CommandBus(mk2(), rules);
  executeAndAssertOk(mcpBus, CMD.placeCabinet(mcpBus.getState().cabinets[1]!, atRight, 'mcp', 'mcp 代用户落位', declAdj), "source='mcp' 落位");
  const mcpProv = provList(mcpBus.log().at(-1)!)[0]!;
  ok("source='mcp' → authority=user-authored（脚本代用户 = 人的决定）", mcpProv.authority === 'user-authored', String(mcpProv.authority));

  const sysBus = new CommandBus(mk2(), rules);
  executeAndAssertOk(sysBus, CMD.placeCabinet(sysBus.getState().cabinets[1]!, atRight, 'system', '系统自动落位', declAdj), "source='system' 落位");
  const sysProv = provList(sysBus.log().at(-1)!)[0]!;
  ok("source='system' → authority=system-resolved（自动解析/整组平移/撤销）", sysProv.authority === 'system-resolved', String(sysProv.authority));

  const aiBus = new CommandBus(mk2(), rules);
  executeAndAssertOk(aiBus, CMD.placeCabinet(aiBus.getState().cabinets[1]!, atRight, 'ai', 'AI 草稿落位', declAdj), "source='ai' 未确认落位");
  const aiProv = provList(aiBus.log().at(-1)!)[0]!;
  ok("source='ai' 未确认 → authority=unknown（绝不冒充 user 证据）", aiProv.authority === 'unknown', String(aiProv.authority));

  // confirmedPlan：模拟 planRunner.commitPlan 给 AI 命令打上的标记
  const confBus = new CommandBus(mk2(), rules);
  const confCmd = CMD.placeCabinet(confBus.getState().cabinets[1]!, atRight, 'ai', 'AI 提案经人确认', declAdj);
  confCmd.confirmedPlan = true;
  executeAndAssertOk(confBus, confCmd, 'confirmedPlan AI 落位');
  const confProv = provList(confBus.log().at(-1)!)[0]!;
  ok("confirmedPlan=true（人点「应用」确认过的 AI 提案）→ authority=user-confirmed",
    confProv.authority === 'user-confirmed', String(confProv.authority));
  ok('user-confirmed 的证据来源会映射成 user-observed（见 §4）', true);
}

// ═══════════════ §3 真实 apply 路径：commitPlan 标记 confirmedPlan ═══════════════
section('§3 真实 apply 路径：commitPlan 把 AI 落位提案标成 user-confirmed');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600)]);
  const proposal: DesignProposal = {
    title: '接一条副臂',
    summary: '主臂旁接一条副臂，按背面齐',
    room: '测试房',
    cabinets: [
      {
        ref: 'b',
        name: '副臂B',
        width: 900,
        height: 2200,
        depth: 600,
        placement: { relation: 'adjacent', reference: '主臂A', side: 'right', alignment: 'back' },
      },
    ],
    assumptions: [],
    questions: [],
  };
  const compiled = compileProposal(proposal, project, rules);
  ok('方案编译成功（含 cabinet.place 动作）', compiled.ok, compiled.blockedReason ?? '');
  const hasPlace = compiled.actions.some((a) => a.action === 'cabinet.place');
  ok('编译产物里确有 cabinet.place（落位意图会经 planRunner 带进命令）', hasPlace, JSON.stringify(compiled.actions.map((a) => a.action)));

  const bus = new CommandBus(project, rules);
  const run = dryRunPlan({ bus, actions: compiled.actions });
  const cm = commitPlan(run, bus);
  ok('commitPlan 成功', cm.ok, cm.error ?? '');

  const placeEntries = bus.log().filter((e) => e.command.op === 'cabinet.place' && e.placementProvenance);
  ok('提交的落位条目存在', placeEntries.length >= 1, String(placeEntries.length));
  const prov = provList(placeEntries[0]!)[0]!;
  ok('经 commitPlan 提交的 AI 落位 → authority=user-confirmed（根治 ai-inferred 误判）',
    prov.authority === 'user-confirmed', String(prov.authority));
  ok('提交后 provenance 的 intent 带着 alignment（确认过的提案可学 alignment）',
    eq(prov.intent, { relation: 'adjacent', referenceId: 'cab_A', side: 'right', alignment: 'back' }), JSON.stringify(prov.intent));

  // 对比：同一落位语义若不走 commitPlan（直接 ai 源执行）→ unknown
  const rawBus = new CommandBus(project, rules);
  executeAndAssertOk(rawBus, CMD.placeCabinet(rawBus.getState().cabinets[0]!, { x: 500, y: 500, rotation: 0 }, 'ai', 'AI 草稿（未确认）'), '未确认 AI 对照落位');
  // 主臂本身已存在，这里只是再 place 一次主臂以制造一个 ai 落位条目用于对照
  const rawProv = provList(rawBus.log().at(-1)!)[0]!;
  ok('同语义但不经 commitPlan（直接 ai 源）→ authority=unknown（对照成立）', rawProv.authority === 'unknown', String(rawProv.authority));
}

// ═══════════════ §4 观察门禁：alignment / orientation 随 authority 读 ═══════════════
section('§4 观察门禁：alignment/orientation 证据只从「人来授权」的落位产生');
{
  const cab = mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90);
  const placeCmd = CMD.placeCabinet(cab, atRight, 'ui', '落位副臂B', declAdj);

  // user-confirmed（确认过的 AI 提案）→ 产 alignment 证据，来源 user-observed
  const obsC = observeCommand(placeCmd, placeCmd.changes, '副臂B', CTX, 'user-confirmed');
  ok('user-confirmed 的落位 → 产生 alignment 观察（可学"按背面齐"）',
    obsC.some((o) => o.predicate.kind === 'alignment' && o.predicate.value === 'back'), JSON.stringify(obsC.map((o) => o.predicate)));
  ok('alignment 观察只产生 1 条（没有把解析坐标当人的习惯）', obsC.length === 1, JSON.stringify(obsC.length));
  ok('alignment 证据来源 = user-observed（确认过的提案 = 用户的接受）',
    obsC[0]?.evidence.source === 'user-observed', JSON.stringify(obsC[0]?.evidence.source));
  ok('alignment 观察只产 candidate（弱证据，须用户在知识面板确认才生效）',
    obsC[0]?.scopeCabinet === undefined);

  // 同一条命令，但 authority=unknown（未确认 AI）→ 不产 alignment
  const obsU = observeCommand(placeCmd, placeCmd.changes, '副臂B', CTX, 'unknown');
  ok('authority=unknown（未确认 AI 草稿）→ 不产生 alignment 观察（不得冒充 user）',
    obsU.length === 0, JSON.stringify(obsU.map((o) => o.predicate.kind)));

  // orientation 门禁同样随 authority：确认过 → 产；未确认 → 不产
  const rotCmd = CMD.rotateCabinet(cab, 270, 'ui');
  const rdiff = [{ path: 'placement.rotation', from: 90, to: 270 }];
  const obsRC = observeCommand(rotCmd, rdiff, '副臂B', CTX, 'user-confirmed');
  ok('user-confirmed 的朝向改动 → 产生 orientation 观察',
    obsRC.some((o) => o.predicate.kind === 'orientation' && o.predicate.value === 270), JSON.stringify(obsRC.map((o) => o.predicate)));
  const obsRU = observeCommand(rotCmd, rdiff, '副臂B', CTX, 'unknown');
  ok('authority=unknown 的朝向改动 → 不产生 orientation 观察（门禁同源纪律）', obsRU.length === 0, JSON.stringify(obsRU.map((o) => o.predicate.kind)));

  // 退化兼容：不传 authority 时按旧 source 代理（cmd.source='ui' → 仍 human）
  const obsLegacy = observeCommand(placeCmd, placeCmd.changes, '副臂B', CTX);
  ok('不传 authority 时退化到旧行为（source=ui 仍产 alignment，向后兼容）',
    obsLegacy.some((o) => o.predicate.kind === 'alignment'), JSON.stringify(obsLegacy.map((o) => o.predicate.kind)));
}

// ═══════════════ §5 superseded 失效：多次落位，仅末条 live ═══════════════
section('§5 superseded 失效：同一柜多次落位，旧记录自动失效');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  const b = () => bus.getState().cabinets[1]!;

  executeAndAssertOk(bus, CMD.placeCabinet(b(), { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位1', declAdj), '第一次落位');
  executeAndAssertOk(bus, CMD.rotateCabinet(b(), 270, 'ui'), '旋转落位');
  executeAndAssertOk(bus, CMD.moveCabinet(b(), 4300, 1560, 'ui'), '移动落位');

  const entries = bus.log().filter((e) => e.placementProvenance);
  ok('三次落位产生三条 provenance 记录', entries.length === 3, String(entries.length));
  const provs = entries.map((e) => provList(e)[0]!);
  ok('第一条（place）被 superseded', provs[0]!.status === 'superseded', String(provs[0]!.status));
  ok('第二条（rotate）被 superseded', provs[1]!.status === 'superseded', String(provs[1]!.status));
  ok('第三条（move）为 live', provs[2]!.status === 'live', String(provs[2]!.status));
  ok('第一条的 supersededBy 指向第二条的 op（cabinet.rotate）',
    provs[0]!.supersededBy?.op === 'cabinet.rotate', JSON.stringify(provs[0]!.supersededBy));
  ok('第二条的 supersededBy 指向第三条的 op（cabinet.move）',
    provs[1]!.supersededBy?.op === 'cabinet.move', JSON.stringify(provs[1]!.supersededBy));
  ok('同一只柜任意时刻仅一条 live', provs.filter((p) => p.status === 'live').length === 1, JSON.stringify(provs.map((p) => p.status)));

  // 重跑相同 intent（再 place 一次）→ 旧记录失效，仍只一条 live，intent 等于 decl
  executeAndAssertOk(bus, CMD.placeCabinet(b(), { x: 4500, y: 1560, rotation: 0 }, 'ui', '重跑 intent', declAdj), '重跑 intent 落位');
  const entries2 = bus.log().filter((e) => e.placementProvenance);
  const provs2 = entries2.map((e) => provList(e)[0]!);
  ok('重跑 intent 后 live 数量仍为 1', provs2.filter((p) => p.status === 'live').length === 1, JSON.stringify(provs2.map((p) => p.status)));
  const live = provs2.find((p) => p.status === 'live')!;
  ok('重跑后的 live 记录 intent 仍等于声明 decl（provenance 不被坐标污染）',
    eq(live.intent, declAdj), JSON.stringify(live.intent));
}

// ═══════════════ §6 undo / redo 原子同步：provenance 跟随模型状态 ═══════════════
section('§6 undo/redo 原子同步：provenance 与模型一起回退');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  const b = () => bus.getState().cabinets[1]!;
  executeAndAssertOk(bus, CMD.placeCabinet(b(), { x: 4200, y: 1560, rotation: 0 }, 'ui', '落位', declAdj), 'undo/redo 场景初始落位');
  executeAndAssertOk(bus, CMD.rotateCabinet(b(), 270, 'ui'), 'undo/redo 场景旋转落位');

  const beforeUndo = bus.activeLog().filter((e) => e.placementProvenance).map((e) => provList(e)[0]!.status);
  ok('undo 前：两条记录（superseded, live）', beforeUndo.join(',') === 'superseded,live', beforeUndo.join(','));

  bus.undo(); // 撤销 rotate
  const afterUndo = bus.activeLog().filter((e) => e.placementProvenance).map((e) => provList(e)[0]!.status);
  ok('undo rotate 后：仅 place 一条（active 集合），且恢复为 live（旧记录不再被当作 live）',
    afterUndo.join(',') === 'live', afterUndo.join(','));

  bus.redo(); // 重做 rotate
  const afterRedo = bus.activeLog().filter((e) => e.placementProvenance).map((e) => provList(e)[0]!.status);
  ok('redo 后：重新变成（superseded, live），与模型原子同步',
    afterRedo.join(',') === 'superseded,live', afterRedo.join(','));
}

// ═══════════════ §7 导入不伪造意图 ═══════════════
section('§7 导入（replaceProject）不清算意图：历史 provenance 全清空');
{
  const project = mkProject([mkCab('cab_A', '主臂A', 2000, 60, 1500, 600), mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90)]);
  const bus = new CommandBus(project, rules);
  executeAndAssertOk(bus, CMD.placeCabinet(bus.getState().cabinets[1]!, atRight, 'ui', '落位副臂B', declAdj), '导入前落位');
  ok('导入前确有 provenance', bus.log().some((e) => e.placementProvenance), '');

  // 模拟从外部文件导入一个全新项目（来源由 cabinet.origin 回答，不伪造 intent）
  const imported = mkProject([mkCab('cab_X', '导入柜', 1000, 1000, 900, 600)]);
  bus.replaceProject(imported, '导入外部项目');

  const allProv = bus.log().flatMap((e) => (e.placementProvenance === undefined ? [] : [1]));
  ok('导入后：所有历史条目的 placementProvenance 被清空（undefined）',
    allProv.length === 0, JSON.stringify(allProv.length));
  const replaceEntry = bus.log().at(-1)!;
  ok('导入本身产生的 replace 条目不带 provenance（导入来源不伪造意图）',
    replaceEntry.placementProvenance === undefined, JSON.stringify(replaceEntry.placementProvenance));
  ok('导入后模型已是导入内容（柜 X 存在，副臂 B 消失）',
    bus.getState().cabinets.some((c) => c.id === 'cab_X') && !bus.getState().cabinets.some((c) => c.id === 'cab_B'));
}

// ═══════════════ §8 源码扫描：派生层不读 provenance；落位层不读 knowledge ═══════════════
section('§8 源码扫描：provenance 只住命令总线，派生层一律不读');
{
  const placementSrc = readFileSync(join(APP, 'src', 'core', 'placement.ts'), 'utf8');
  ok('placement.ts 不 import knowledge（落位层读不到偏好，结构上就不可能）',
    !/knowledge/i.test(placementSrc) && !/from '\.\.\/ai\//.test(placementSrc));
  ok('placement.ts 不出现 placementProvenance（它不读 provenance，只定义 decl）',
    !/placementProvenance/.test(placementSrc));

  const geomSrc = readFileSync(join(APP, 'src', 'core', 'geometry', 'project.ts'), 'utf8');
  ok('geometry/project.ts 不读 provenance（几何算法不被落位来源影响）',
    !/placementProvenance|PlacementAuthority|derivePlacementAuthority/.test(geomSrc));

  const designSrc = readFileSync(join(APP, 'src', 'core', 'placementDesign.ts'), 'utf8');
  ok('placementDesign.ts（P8.3）不读 provenance',
    !/placementProvenance|PlacementAuthority|derivePlacementAuthority/.test(designSrc));

  const exportRoomSrc = readFileSync(join(APP, 'src', 'export', 'roomBook.ts'), 'utf8');
  const exportSheetSrc = readFileSync(join(APP, 'src', 'export', 'neutralSheet.ts'), 'utf8');
  ok('export/roomBook.ts（DXF 导出）不读 provenance',
    !/placementProvenance|PlacementAuthority|derivePlacementAuthority/.test(exportRoomSrc));
  ok('export/neutralSheet.ts（清单导出）不读 provenance',
    !/placementProvenance|PlacementAuthority|derivePlacementAuthority/.test(exportSheetSrc));

  const observeSrc = readFileSync(join(APP, 'src', 'ai', 'knowledge', 'observe.ts'), 'utf8');
  ok('observe.ts 只从命令总线/落位层读 authority（允许 import commandBus & placement）',
    /from '\.\.\/\.\.\/core\/commandBus\.ts'/.test(observeSrc) && /from '\.\.\/\.\.\/core\/placement\.ts'/.test(observeSrc));
  ok('observe.ts 不逆向 import 几何/导出/制造（观察者不依赖派生层）',
    !/from '\.\.\/\.\.\/core\/geometry/.test(observeSrc) && !/from '\.\.\/\.\.\/export/.test(observeSrc));

  // 全仓反向核对（P8.5-B 后）：placementProvenance 允许出现在「定义/生命周期（命令总线）」、
  // 「模型字段（types.ts）」「UI 读 authority（App.tsx）」；派生层一律禁止。
  const allowed: string[] = ['src/core/commandBus.ts', 'src/core/types.ts', 'src/ui/App.tsx'];
  const forbidden: string[] = [
    'src/core/placement.ts',
    'src/core/geometry/project.ts',
    'src/core/placementDesign.ts',
    'src/export/roomBook.ts',
    'src/export/neutralSheet.ts',
  ];
  for (const f of allowed) {
    ok(`placementProvenance 允许出现在 ${f}（定义/模型/UI）`, /placementProvenance/.test(readFileSync(join(APP, f), 'utf8')), f);
  }
  for (const f of forbidden) {
    ok(`placementProvenance 不出现在 ${f}（派生层不读落位来源）`, !/placementProvenance/.test(readFileSync(join(APP, f), 'utf8')), f);
  }
  ok('observe.ts 不引用 placementProvenance（观察者只吃 authority 参数，职责分离）',
    !/placementProvenance/.test(observeSrc));
}

// ═════════════════ 汇总 ═══════════════════
console.log(`\n总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败断言：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
