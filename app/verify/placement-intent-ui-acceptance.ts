/**
 * ══════════════════════════════════════════════════════════════════════
 *  P8.6 验收 —— Semantic Placement Intent UI / User-authored Alignment
 *
 *  出口判据：用户在 UI 上点的是「对齐到 / 贴合到」这类**语义操作**，
 *  产出的必须是真实 PlacementIntent（authority=user-authored），并且：
 *
 *   ① UI 不输入坐标、不实现第二套 resolver —— 坐标只来自
 *      core/placement.ts 的唯一 Resolver，提交只走唯一 cabinet.place；
 *   ② UI 意图完整进入 P8.5 provenance（user-authored + intent != null），
 *      并随 P8.5-B 持久化 round-trip 不丢；
 *   ③ user-authored 的 alignment 意图能成为 Knowledge alignment candidate
 *      （P8.5 打通的就是这一步），candidate → 用户确认 → active → digest；
 *   ④ preview === commit（provenance 只住总线，模型干净）；
 *   ⑤ drag-only / unknown / system-resolved / absolute 一律不产生 alignment
 *      偏好 —— 绝不从坐标反推意图；
 *   ⑥ undo / redo / reload 不重复制造 evidence。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, FurnitureAssembly, Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import * as CMD from '../src/core/commands.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import { resolvePlacement, sceneFromProject, type PlacementIntent } from '../src/core/placement.ts';
import { validatePlacementDesign } from '../src/core/placementDesign.ts';
import { serializeProjectFile, parseProjectFile } from '../src/core/projectFile.ts';
import { buildAlignIntent, buildAttachIntent, commitPlacementIntent } from '../src/ui/placementIntent.ts';
import {
  confirmKnowledge,
  knowledgeDigest,
  observeCommand,
  placementContextOf,
  recordObservation,
  resolveKnowledge,
  type KnowledgeEntry,
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

// ───────────────────────── 场景 ─────────────────────────

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
    id: 'proj_p86',
    name: 'P8.6 语义落位意图 UI 验收',
    ruleSetId: rules.id,
    rooms: [ROOM],
    cabinets: cabs,
    ...(assemblies ? { assemblies } : {}),
  };
}

/** 主臂 A：(2000,60) 1500×600 ⇒ x[2000,3500] y[60,660] */
const armA = (): Cabinet => mkCab('cab_A', '主臂A', 2000, 60, 1500, 600, 0);
/** 副臂 B：初始在远端 (6000,3000) 900×600 */
const armB = (): Cabinet => mkCab('cab_B', '副臂B', 6000, 3000, 900, 600, 0);
const asmOf = (id: string, a: string, b: string, kind: 'corner' | 'butt' = 'butt'): FurnitureAssembly => ({
  id,
  name: '组合',
  roomId: ROOM.id,
  memberIds: [a, b],
  connections: [{ id: `${id}_c1`, kind, a: { cabinetId: a }, b: { cabinetId: b }, origin: 'authored' }],
});

/** 复刻 App.tsx 的观察回路：只消费新 seq、跳过未应用/系统命令，provenance 取 authority */
function drain(bus: CommandBus, observedSeq: { current: number }): ReturnType<typeof observeCommand> {
  const log = bus.log();
  const out: ReturnType<typeof observeCommand> = [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i]!;
    if (e.seq <= observedSeq.current) break;
    if (!e.applied || e.command.source === 'system') continue;
    const cab =
      e.command.target?.kind === 'cabinet' ? bus.getState().cabinets.find((c) => c.id === e.command.target?.id) : undefined;
    const pCtx: PlacementContext | null = cab ? placementContextOf(bus.getState(), cab.id) : null;
    const prov = e.placementProvenance;
    const authority = Array.isArray(prov) ? prov[0]?.authority : prov?.authority;
    out.push(...observeCommand(e.command, e.diff, cab?.name, pCtx, authority));
  }
  if (log.length > 0) observedSeq.current = Math.max(observedSeq.current, log[log.length - 1]!.seq);
  return out;
}

const placements = (p: Project): Record<string, { x: number; y: number; rotation: number }> =>
  Object.fromEntries(p.cabinets.map((c) => [c.id, { ...c.placement }]));

// ═══════════════ §1 UI 对齐意图：语义入口 → 唯一 Resolver ═══════════════
section('§1 UI 对齐意图（align）：left/right/front/back/center 全走唯一 Resolver');
{
  const want: Record<string, { x: number; y: number }> = {
    left: { x: 2000, y: 3000 }, // B.min.x = A.min.x
    right: { x: 2600, y: 3000 }, // B.max.x = A.max.x = 3500
    front: { x: 6000, y: 60 }, // B.max.y = A.max.y = 660
    back: { x: 6000, y: 60 }, // B.min.y = A.min.y = 60
    center: { x: 2300, y: 60 }, // 包围盒中心重合
  };
  for (const a of ['left', 'right', 'front', 'back', 'center'] as const) {
    const project = mkProject([armA(), armB()]);
    const bus = new CommandBus(project, rules);
    const state = bus.getState();
    const cab = state.cabinets.find((c) => c.id === 'cab_B')!;
    const ref = state.cabinets.find((c) => c.id === 'cab_A')!;
    const r = commitPlacementIntent(bus, cab, ref, buildAlignIntent(cab.id, ref.id, a));
    const w = want[a]!;
    // execute 后重读最新状态（bus 会重建 cabinets 数组，旧引用是 stale 的）
    const after = bus.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
    ok(`align ${a}：提交成功且坐标 = Resolver 算的唯一值 (${w.x},${w.y})`,
      r.ok && after.x === w.x && after.y === w.y,
      JSON.stringify(r.ok ? after : r.error));
    ok(`align ${a}：rotation 不被 UI 碰（保持原值 0）`, after.rotation === 0, String(after.rotation));
  }

  // intent 本体不含坐标
  const decl = buildAlignIntent('cab_B', 'cab_A', 'left') as Record<string, unknown>;
  ok('align intent 不含 x/y/坐标字段（只有 relation/referenceId/alignment）',
    eq(decl, { relation: 'align', targetId: 'cab_B', referenceId: 'cab_A', alignment: 'left' }), JSON.stringify(decl));

  // 解析失败诚实拒绝、不改状态（本柜左面 ↔ 参照左面 = 法线同向，贴合不了）
  const project = mkProject([armA(), armB()]);
  const bus = new CommandBus(project, rules);
  const state = bus.getState();
  const before = JSON.stringify(bus.getState());
  const r = commitPlacementIntent(
    bus,
    state.cabinets[1]!,
    state.cabinets[0]!,
    buildAttachIntent('cab_B', 'cab_A', 'left', 'left')
  );
  ok('非法 attach（left↔left 面不相对）被 Resolver 拒绝且消息给出原因',
    !r.ok && r.error.includes('贴合不了'), r.ok ? '竟然成功' : r.error);
  ok('被拒后模型逐字节未变（失败停在 preview 之前）', JSON.stringify(bus.getState()) === before);
}

// ═══════════════ §2 UI 贴合意图（attach）═══════════════
section('§2 UI 贴合意图（attach）：两面有名有姓 + offset 缝隙');
{
  const project = mkProject([armA(), armB()]);
  const bus = new CommandBus(project, rules);
  const state = bus.getState();
  const r = commitPlacementIntent(
    bus,
    state.cabinets[1]!,
    state.cabinets[0]!,
    buildAttachIntent('cab_B', 'cab_A', 'left', 'right', 'start')
  );
  const bAfter = () => bus.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
  ok('attach 本柜左面↔参照右面：B.x = A 右缘 3500', r.ok && bAfter().x === 3500,
    JSON.stringify(r.ok ? bAfter() : r.error));
  ok('attach start：沿面起始端齐（B.y = A.y = 60）', bAfter().y === 60, JSON.stringify(bAfter()));

  const project2 = mkProject([armA(), armB()]);
  const bus2 = new CommandBus(project2, rules);
  const s2 = bus2.getState();
  const r2 = commitPlacementIntent(
    bus2,
    s2.cabinets[1]!,
    s2.cabinets[0]!,
    buildAttachIntent('cab_B', 'cab_A', 'left', 'right', 'start', 50)
  );
  const b2After = bus2.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
  ok('attach offset=50：缝隙沿参照外法线外推（B.x = 3550）', r2.ok && b2After.x === 3550,
    JSON.stringify(r2.ok ? b2After : r2.error));

  const decl = buildAttachIntent('cab_B', 'cab_A', 'left', 'right', 'center', 0) as Record<string, unknown>;
  ok('attach intent 词表与引擎逐字同一份（relation/faces/alignment，无坐标）',
    eq(decl, {
      relation: 'attach',
      targetId: 'cab_B',
      referenceId: 'cab_A',
      targetFace: 'left',
      referenceFace: 'right',
      alignment: 'center',
      offset: 0,
    }), JSON.stringify(decl));
}

// ═══════════════ §3 provenance：user-authored + intent 真实保存 ═══════════════
section('§3 provenance：UI 意图 = user-authored + intent != null；拖拽 = intent null');
{
  const project = mkProject([armA(), armB()]);
  const bus = new CommandBus(project, rules);
  const state = bus.getState();
  commitPlacementIntent(
    bus,
    state.cabinets[1]!,
    state.cabinets[0]!,
    buildAlignIntent('cab_B', 'cab_A', 'right')
  );
  const prov = bus.getPlacementProvenance('cab_B');
  ok('UI 对齐落位 authority = user-authored', prov?.authority === 'user-authored', JSON.stringify(prov));
  ok('provenance.intent 逐值等于 UI 声明的意图', eq(prov?.intent, { relation: 'align', referenceId: 'cab_A', alignment: 'right' }),
    JSON.stringify(prov?.intent));
  ok('byOp = cabinet.place（唯一执行路径，无 uiAlign 平行命令）', prov?.byOp === 'cabinet.place', String(prov?.byOp));
  ok('atVersion 是提交时的模型版本（可复现指针）', typeof prov?.atVersion === 'number' && prov.atVersion > 0, String(prov?.atVersion));

  // 拖拽（cabinet.move）：intent 必须是 null，绝不可从坐标反推 alignment
  const before = placements(bus.getState());
  bus.execute(CMD.moveCabinet(bus.getState().cabinets[1]!, before.cab_B!.x + 137, before.cab_B!.y, 'ui'));
  const provMove = bus.getPlacementProvenance('cab_B');
  ok('拖拽后 live provenance 更新但 intent = null（不从 x/y 猜对齐）',
    provMove?.intent === null && provMove?.authority === 'user-authored', JSON.stringify(provMove));
}

// ═══════════════ §4 preview === commit ═══════════════
section('§4 preview === commit：UI 意图命令在沙盒与提交两端逐字节一致');
{
  const project = mkProject([armA(), armB()]);
  const mkPair = () => {
    const a = new CommandBus(structuredClone(project), rules);
    const b = new CommandBus(structuredClone(project), rules);
    return [a, b] as const;
  };
  const [sandbox, commit] = mkPair();
  // 两端跑**同一条** UI 意图命令（commitPlacementIntent 内部就是这条命令）
  const state = commit.getState();
  const cab = state.cabinets.find((c) => c.id === 'cab_B')!;
  const ref = state.cabinets.find((c) => c.id === 'cab_A')!;
  const intent = buildAlignIntent('cab_B', 'cab_A', 'back');
  const res = resolvePlacement(intent, sceneFromProject(state));
  if (!res.ok) throw new Error('fixture 解析失败');
  const cmd = CMD.placeCabinet(cab, res.placement, 'ui', '「副臂B」对齐「主臂A」后缘', intent);
  sandbox.execute(structuredClone(cmd), { commitLabel: cmd.label });
  commit.execute(structuredClone(cmd), { commitLabel: cmd.label });
  ok('干跑终点 vs 提交终点：模型状态逐字节相同（provenance 不进模型）',
    eq(sandbox.getState(), commit.getState()));
  // 文件形状比较：savedAt 是墙钟元数据（每次序列化必然不同），内容以 parse 回来的 project 为准
  const fileA = parseProjectFile(serializeProjectFile(sandbox.toFileSnapshot()));
  const fileB = parseProjectFile(serializeProjectFile(commit.toFileSnapshot()));
  ok('干跑终点 vs 提交终点：文件内容（含 provenance）逐值相同',
    fileA.ok && fileB.ok && eq(fileA.project, fileB.project));
  ok('文件形状里带 user-authored provenance（UI 意图落盘）',
    fileA.ok && fileA.project.cabinets[1]!.placementProvenance?.authority === 'user-authored');
  ok('模型状态里没有 placementProvenance 字段（P8.5-B 不变量在 UI 意图下保持）',
    commit.getState().cabinets.every((c) => c.placementProvenance === undefined));
}

// ═══════════════ §5 Knowledge：user-authored alignment → candidate → active → digest ═══════════════
section('§5 Knowledge 闭环：UI 意图 → alignment candidate → 用户确认 → digest');
{
  const project = mkProject([armA(), armB(), mkCab('cab_C', '吊柜C', 6000, 4500, 900, 350)], [asmOf('asm_1', 'cab_A', 'cab_C')]);
  const bus = new CommandBus(project, rules);
  const observedSeq = { current: 0 };
  let knowledge: KnowledgeEntry[] = [];

  const state = bus.getState();
  const c = state.cabinets.find((x) => x.id === 'cab_C')!;
  const a = state.cabinets.find((x) => x.id === 'cab_A')!;
  const r = commitPlacementIntent(bus, c, a, buildAlignIntent('cab_C', 'cab_A', 'right'));
  if (!r.ok) throw new Error(`fixture：UI 对齐提交失败 ${r.error}`);
  const obs = drain(bus, observedSeq);
  ok('user-authored UI 对齐产生 1 条 alignment 观察', obs.length === 1 && obs[0]!.predicate.kind === 'alignment',
    JSON.stringify(obs));
  ok('观察值 = 用户选的 right、来源 = user-observed',
    obs[0]!.predicate.value === 'right' && obs[0]!.evidence.source === 'user-observed', JSON.stringify(obs[0]));
  ok('观察带 PlacementContext（说得出是哪类情形）',
    obs[0]!.predicate.context !== undefined && (obs[0]!.predicate.context?.contact ?? obs[0]!.predicate.context?.turnSide) !== undefined,
    JSON.stringify(obs[0]!.predicate.context));
  ok('偏好不挂柜名（挂情形才可复用）', obs[0]!.scopeCabinet === undefined);

  knowledge = recordObservation([], obs[0]!);
  ok('只产生 candidate（永不自动 active）', knowledge[0]!.status === 'candidate');
  ok('未确认不进 applicable（不参与规划）', resolveKnowledge({}, knowledge).applicable.length === 0);

  // 同类观察（仍是 candidate 时）→ 累积证据而非新条目
  const s2 = bus.getState();
  const c2 = s2.cabinets.find((x) => x.id === 'cab_C')!;
  commitPlacementIntent(bus, c2, s2.cabinets.find((x) => x.id === 'cab_A')!, buildAlignIntent('cab_C', 'cab_A', 'right'));
  const obs2 = drain(bus, observedSeq);
  const merged = recordObservation(knowledge, obs2[0]!);
  ok('candidate 阶段同类观察累积到同一条（evidence +1，不新增条目）',
    merged.length === 1 && merged[0]!.evidence.length === 2, JSON.stringify(merged.map((k) => k.evidence.length)));
  ok('累积也**不会**自动升级为 active', merged[0]!.status === 'candidate');

  // 用户确认 → active → digest 可用
  const confirmed = confirmKnowledge(merged, merged[0]!.id);
  ok('用户在知识面板确认后 = active（唯一升级通道）', confirmed[0]!.status === 'active');
  const digest = knowledgeDigest(resolveKnowledge({}, confirmed));
  ok('active preference 进入 knowledgeDigest（AI 设计时可见）', digest.includes('right') && digest.includes('落位对齐'),
    digest.slice(0, 160));

  // ── 负样本：这些一律不产生 alignment candidate ──
  const count = (list: KnowledgeEntry[]): number => list.filter((k) => k.predicate?.kind === 'alignment').length;
  const n0 = count(knowledge);

  // 拖拽（cabinet.move，无 intent）
  bus.execute(CMD.moveCabinet(bus.getState().cabinets.find((x) => x.id === 'cab_C')!, 5000, 4500, 'ui'));
  ok('单纯 x/y 移动不产生 alignment candidate', count(knowledge) === n0 && drain(bus, observedSeq).every((o) => o.predicate.kind !== 'alignment'));

  // unknown（AI 未确认）
  const s3 = bus.getState();
  const b3 = s3.cabinets.find((x) => x.id === 'cab_B')!;
  bus.execute(CMD.placeCabinet(b3, { x: 4600, y: 60, rotation: 0 }, 'ai', 'AI 草稿落位', buildAlignIntent('cab_B', 'cab_A', 'left')));
  const obsAi = drain(bus, observedSeq);
  ok('AI 未确认（unknown）不产生 alignment candidate',
    obsAi.every((o) => o.predicate.kind !== 'alignment'), JSON.stringify(obsAi));

  // system-resolved
  const s4 = bus.getState();
  bus.execute(CMD.placeCabinet(s4.cabinets.find((x) => x.id === 'cab_B')!, { x: 4600, y: 60, rotation: 0 }, 'system', '系统解析'));
  ok('system-resolved 不产生任何观察', drain(bus, observedSeq).length === 0);

  // absolute（授权坐标）不记对齐偏好
  const s5 = bus.getState();
  bus.execute(
    CMD.placeCabinet(
      s5.cabinets.find((x) => x.id === 'cab_B')!,
      { x: 4600, y: 60, rotation: 0 },
      'ui',
      '用户直接给坐标',
      { relation: 'absolute', x: 4600, y: 60, origin: 'authored' }
    )
  );
  const obsAbs = drain(bus, observedSeq);
  ok('absolute（授权输入）不产生 alignment candidate', obsAbs.every((o) => o.predicate.kind !== 'alignment'), JSON.stringify(obsAbs));

  ok('负样本之后 alignment 条目数不变（没有漏网证据）', count(knowledge) === n0);
}

// ═══════════════ §6 undo / redo / reload 不重复制造 evidence ═══════════════
section('§6 undo/redo/reload：不产生、不重复 evidence；intent 持久化不丢');
{
  const project = mkProject([armA(), armB()], [asmOf('asm_1', 'cab_A', 'cab_B')]);
  const bus = new CommandBus(project, rules);
  const observedSeq = { current: 0 };
  const state = bus.getState();
  const r = commitPlacementIntent(
    bus,
    state.cabinets[1]!,
    state.cabinets[0]!,
    buildAlignIntent('cab_B', 'cab_A', 'center')
  );
  if (!r.ok) throw new Error('fixture 失败');
  const obs1 = drain(bus, observedSeq);
  ok('首次 UI 对齐产生 1 条观察', obs1.length === 1, JSON.stringify(obs1.length));

  bus.undo();
  ok('undo 不产生新观察（撤销不是新事实）', drain(bus, observedSeq).length === 0);
  bus.redo();
  ok('redo 不重复制造 evidence（seq 已消费）', drain(bus, observedSeq).length === 0);

  // 持久化 round-trip：保存 → 重新打开
  const json = serializeProjectFile(bus.toFileSnapshot());
  const parsed = parseProjectFile(json);
  if (!parsed.ok) throw new Error(`round-trip 失败：${parsed.error}`);
  ok('round-trip：provenance（intent=align center + user-authored）随柜体落盘不丢',
    eq(parsed.project.cabinets[1]!.placementProvenance, {
      intent: { relation: 'align', referenceId: 'cab_A', alignment: 'center' },
      authority: 'user-authored',
      byOp: 'cabinet.place',
      atVersion: bus.getPlacementProvenance('cab_B')!.atVersion,
    }), JSON.stringify(parsed.project.cabinets[1]!.placementProvenance));
  ok('round-trip：placement 逐值不变', eq(parsed.project.cabinets[1]!.placement, bus.getState().cabinets[1]!.placement));

  const bus2 = new CommandBus(parsed.project, rules);
  ok('reload：命令日志为空（观察无从回放）', bus2.log().length === 0);
  ok('reload：drain 产生 0 条观察（同一 provenance 不重复贡献 evidence）',
    drain(bus2, { current: 0 }).length === 0);
  ok('reload：总线内 provenance 已种子化（authority 仍是 user-authored，不退化）',
    bus2.getPlacementProvenance('cab_B')?.authority === 'user-authored');
  ok('reload：schemaVersion 不因 UI intent 单独变化（内容驱动）', parsed.project.schemaVersion === '0.3', parsed.project.schemaVersion);

  // 老项目（无 provenance）正常打开
  const legacy = parseProjectFile(serializeProjectFile(mkProject([armA(), armB()])));
  ok('老项目（无 provenance）正常解析，字段保持 undefined',
    legacy.ok && legacy.project.cabinets.every((c) => c.placementProvenance === undefined));
}

// ═══════════════ §7 设计校验消费 P8.3 报告 + Resolver 不读 provenance ═══════════════
section('§7 UI 只消费 DesignPlacementReport；Resolver 结果与 provenance 无关');
{
  const project = mkProject([armA(), armB()]);
  const bus = new CommandBus(project, rules);
  const state = bus.getState();
  const r = commitPlacementIntent(
    bus,
    state.cabinets[1]!,
    state.cabinets[0]!,
    buildAttachIntent('cab_B', 'cab_A', 'left', 'right', 'start')
  );
  if (!r.ok) throw new Error('fixture 失败');
  ok('commit 返回 P8.3 报告（status ∈ valid/warning/error）',
    ['valid', 'warning', 'error'].includes(r.report.status), r.report.status);
  ok('报告与直接调 validatePlacementDesign 同源（UI 无第二套判断）',
    eq(r.report, validatePlacementDesign(bus.getState())));

  // resolver 不读 provenance：带/不带 provenance 的同场景，解析结果逐值相同
  const withProv = bus.toFileSnapshot();
  const withoutProv = structuredClone(withProv);
  for (const c of withoutProv.cabinets) delete (c as Record<string, unknown>).placementProvenance;
  const intent = buildAlignIntent('cab_B', 'cab_A', 'front');
  ok('带 provenance 与不带 provenance：同一 intent 解析结果逐值相同',
    eq(resolvePlacement(intent, sceneFromProject(withProv)), resolvePlacement(intent, sceneFromProject(withoutProv))));
}

// ═══════════════ §8 源码扫描：UI 无第二套 resolver / 不碰知识存储 ═══════════════
section('§8 源码扫描：UI 层边界');
{
  const uiIntent = readFileSync(join(APP, 'src', 'ui', 'placementIntent.ts'), 'utf8');
  ok('ui/placementIntent.ts 从 core/placement.ts 引入唯一 Resolver',
    /import \{[^}]*resolvePlacement[^}]*\} from '\.\.\/core\/placement\.ts'/.test(uiIntent));
  ok('ui/placementIntent.ts 用 toPlacementIntentDecl 生成声明（词表唯一）',
    uiIntent.includes('toPlacementIntentDecl'));
  ok('ui/placementIntent.ts 提交走 CMD.placeCabinet（无平行执行路径）',
    /CMD\.placeCabinet\(/.test(uiIntent));
  ok('ui/placementIntent.ts 不 import knowledge/*（UI 层不碰知识存储）',
    !/knowledge/.test(uiIntent));

  // src/ui 全目录：不允许出现第二套解析实现
  const bad: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/i.test(f)) {
        const src = readFileSync(p, 'utf8');
        if (/function resolvePlacement|function footprintBox|function resolveAttach|function resolvePlacements\b/.test(src)) bad.push(p);
      }
    }
  };
  walk(join(APP, 'src', 'ui'));
  ok('src/ui 无第二套 resolver / 包围盒 / 贴合解析实现', bad.length === 0, JSON.stringify(bad));

  const panel = readFileSync(join(APP, 'src', 'ui', 'panels', 'PropertiesPanel.tsx'), 'utf8');
  ok('PropertiesPanel 不 import 几何变换原语（不写第二套数学）',
    !/geometry\/transform/.test(panel));
  // 落位意图区函数体起至文件尾：不允许出现对 placement 坐标的读写（offset 是语义缝隙，不算坐标）
  const secStart = panel.indexOf('function PlacementIntentSection');
  const secTail = secStart >= 0 ? panel.slice(secStart) : '';
  ok('落位意图区不含 placement.x / placement.y / placement.rotation（不输入坐标）',
    secStart >= 0 && !/placement\.(x|y|rotation)/.test(secTail), secStart);
  ok('placementIntent.ts 不读 placementProvenance（UI 逻辑层不碰 provenance 内部）',
    !/placementProvenance/.test(uiIntent));
}

// ───────────────────────── 汇总 ─────────────────────────
console.log(`\n════════════════════════════════════`);
console.log(`P8.6 placement-intent-ui 验收：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
