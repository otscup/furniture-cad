import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

import type { RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { buildSnapshot, snapshotBytes, snapshotContext } from '../src/ai/snapshot.ts';
import { compileAction, COMPILED_ACTIONS, resolveCabinet, resolveUnitIndex, type AiAction } from '../src/ai/compile.ts';
import { dryRunPlan, commitPlan } from '../src/ai/planRunner.ts';
import { compileCorrections } from '../src/ai/memory.ts';
import { ACTIONS, ACTION_NAMES, UNIT_PARAM_RANGES, buildSystemPrompt, validatePlan, validateAction } from '../shared/aiContract.mjs';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  AI 通路验收 —— 把「AI 不能乱改模型」变成可执行的定义
 *
 *  用户原话："ai调用用支持api调用的形式，比如openai的接口，用于测试，
 *            后续可以添加其他api。"
 *
 *  ── 这个脚本要证明的核心命题只有一句 ──
 *    **AI 无论返回什么，都不可能让系统写入几何、派生数据或规则集。**
 *  这不是靠"提示词写得好"，而是三层结构：
 *    ① 词汇表：AI 只能从动作清单里选名字，连"写哪个字段"的语法都没有
 *    ② 校验器：参数名白名单 + 区间；多一个键整条作废
 *    ③ 编译器 + CommandBus：路径是我们自己拼的，再走与鼠标同一条写入路径
 *  每一层都要有**负样本**证明它真的在拦 —— 否则"全绿"只说明断言没长牙。
 *
 *  ── 分组 ──
 *    A 契约 ↔ 编译器一一对应（漂移哨兵：契约加了动作、编译器没跟上，必须立刻报错）
 *    B 快照白名单（派生数据在结构上出不去）
 *    C 校验器（含 6 个负样本）
 *    D 契约里的区间与界面旋钮同源
 *    E 编译器的上下文判定（指代不唯一就报错，绝不替用户挑一个）
 *    F 干跑 / 提交（预览 === 提交，多步依赖，记忆门，版本失效）
 *    G 端到端：真起本地服务 + mock OpenAI 兼容服务商（证明"可换的 API"是真的）
 *    H 账号与额度（无 token 拦、额度耗尽拦、审计留痕）
 * ══════════════════════════════════════════════════════════════════════
 */

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
function section(t: string): void {
  console.log(`\n${t}`);
}

const project = sampleProject(rules);
const bus = new CommandBus(project, rules);
const snapshot = buildSnapshot(bus.getState(), rules);
const ctx = snapshotContext(snapshot);
const cab0 = bus.getState().cabinets[0];

/** 构造一条动作（模拟模型输出），走**完整**校验链路 */
function act(raw: unknown): { ok: boolean; action?: AiAction; error?: string; code?: string } {
  const v = validateAction(raw, ctx);
  if (!v.ok) return { ok: false, error: v.error, code: v.code };
  return { ok: true, action: { ...v.action, index: 0 } as AiAction };
}

// ═══════════════════════════ A. 契约 ↔ 编译器 ═══════════════════════════

section('【A】契约与编译器必须一一对应（漂移哨兵）');

const contractNames = [...ACTION_NAMES].sort();
const compiledNames = [...COMPILED_ACTIONS].sort();
ok(
  'A1 契约里的每个动作都有编译器实现',
  contractNames.every((n) => compiledNames.includes(n)),
  contractNames.filter((n) => !compiledNames.includes(n)).join('、')
);
ok(
  'A2 编译器里的每个动作都在契约里声明（不许有"暗门"动作）',
  compiledNames.every((n) => contractNames.includes(n)),
  compiledNames.filter((n) => !contractNames.includes(n)).join('、')
);

/**
 * A3 —— 不只是名字对上，还要**真的能编译**。
 * 做法：给每个动作造一组"最小合法参数"，看编译失败原因里有没有那句"两边漂移了"。
 * 名字对上但 switch 分支写错（例如分支名打错）只有这一条能抓到。
 */
const MINIMAL: Record<string, unknown> = {
  'cabinet.resize': { action: 'cabinet.resize', target: { cabinetName: cab0.name }, params: { width: 1800 } },
  'cabinet.setBodyLift': { action: 'cabinet.setBodyLift', target: { cabinetName: cab0.name }, params: { mm: 100 } },
  'cabinet.setWidthMode': { action: 'cabinet.setWidthMode', target: { cabinetName: cab0.name }, params: { mode: 'fit_units' } },
  'cabinet.rename': { action: 'cabinet.rename', target: { cabinetName: cab0.name }, params: { name: '验收柜' } },
  'cabinet.move': { action: 'cabinet.move', target: { cabinetName: cab0.name }, params: { x: 100 } },
  'cabinet.nudge': { action: 'cabinet.nudge', target: { cabinetName: cab0.name }, params: { dx: 100 } },
  'cabinet.rotate': { action: 'cabinet.rotate', target: { cabinetName: cab0.name }, params: { deg: 90 } },
  'cabinet.setUnitWidth': { action: 'cabinet.setUnitWidth', target: { cabinetName: cab0.name, unit: 1 }, params: { width: 600 } },
  'cabinet.setUnitParam': { action: 'cabinet.setUnitParam', target: { cabinetName: cab0.name, unit: 1 }, params: { param: 'drawers.count', value: 4 } },
  'cabinet.renameUnit': { action: 'cabinet.renameUnit', target: { cabinetName: cab0.name, unit: 1 }, params: { nickname: '抽屉区' } },
  'cabinet.addUnit': { action: 'cabinet.addUnit', target: { cabinetName: cab0.name }, params: { kind: 'shelves', requestedWidth: 400, count: 3 } },
  'cabinet.removeUnit': { action: 'cabinet.removeUnit', target: { cabinetName: cab0.name, unit: 3 }, params: {} },
  'cabinet.setBoardMaterial': { action: 'cabinet.setBoardMaterial', target: { cabinetName: cab0.name }, params: { materialId: 'M_BOARD_18_WOOD' } },
  'cabinet.setBackMaterial': { action: 'cabinet.setBackMaterial', target: { cabinetName: cab0.name }, params: { materialId: 'M_BACK_9' } },
  'cabinet.create': { action: 'cabinet.create', target: {}, params: { name: '新柜', width: 1200 } },
  'cabinet.duplicate': { action: 'cabinet.duplicate', target: { cabinetName: cab0.name }, params: { offset: 800 } },
  'cabinet.delete': { action: 'cabinet.delete', target: { cabinetName: cab0.name }, params: {} },
  'project.rename': { action: 'project.rename', target: {}, params: { name: '验收项目' } },
};

const drift: string[] = [];
for (const name of contractNames) {
  const raw = MINIMAL[name];
  if (!raw) {
    drift.push(`${name}（验收脚本没给它造最小样例）`);
    continue;
  }
  const v = act(raw);
  if (!v.ok) {
    drift.push(`${name}：契约校验没过 —— ${v.error}`);
    continue;
  }
  const c = compileAction(v.action!, bus.getState(), rules);
  if (!c.ok && c.error.includes('两边漂移了')) drift.push(`${name}：${c.error}`);
}
ok('A3 契约里每个动作都能被编译器真正处理（不是名字对上、分支写错）', drift.length === 0, drift.join('；'));
ok(
  'A4 prompt 里列出了全部动作名（提示词由词汇表生成，不会漂移）',
  contractNames.every((n) => buildSystemPrompt().includes(n)),
  contractNames.filter((n) => !buildSystemPrompt().includes(n)).join('、')
);

/**
 * A5 —— 这条是"AI 不输出几何/路径"的**结构性**证据。
 * 系统提示词里根本不该出现任何模型字段路径。模型连字段名都没见过，
 * 就算它想写 `cabinets[0].params.width` 也无从写起。
 */
const prompt = buildSystemPrompt();
const PATH_PATTERNS = [/params\./, /layout\.units\[/, /cabinets\[/, /placement\./, /panels/, /derived/, /issues/];
const leaked = PATH_PATTERNS.filter((re) => re.test(prompt)).map((re) => String(re));
ok('A5 系统提示词里不含任何模型字段路径（模型不知道字段名，也就无法写它们）', leaked.length === 0, leaked.join('、'));

// ═══════════════════════════ B. 快照白名单 ═══════════════════════════

section('【B】项目快照：派生数据在结构上出不去');

const snapJson = JSON.stringify(snapshot);
const DERIVED_KEYS = ['derived', 'panels', 'issues', 'geom', 'views', 'assembly', 'explode', 'hardware', 'legend', 'panelsByMaterial', 'price', 'cut'];
ok(
  'B1 快照里没有出现任何派生字段名',
  DERIVED_KEYS.every((k) => !snapJson.includes(`"${k}"`)),
  DERIVED_KEYS.filter((k) => snapJson.includes(`"${k}"`)).join('、')
);

/**
 * B2 —— 负样本：往真模型里塞派生数据，看它会不会跟着漏出去。
 * 只断言"当前没有"是不够的：将来模型长了新字段，快照可能跟着漏。
 * 这一条往模型里**主动注入**派生数据，如果实现改成了 `{...cab}` 展开，它会立刻变红。
 */
{
  const dirty = structuredClone(bus.getState()) as unknown as Record<string, unknown>;
  const cabs = dirty.cabinets as Array<Record<string, unknown>>;
  cabs[0].derived = {
    panels: [{ id: 'P_LEAK', role: 'TopPanel', length: 2364, width: 582, thickness: 18, points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] }],
    panelsByMaterial: { 'M_BOARD_18_WOOD': 12 },
    price: 1234.5,
    geom: { poly: [1, 2, 3, 4, 5, 6] },
  };
  (dirty as { issues?: unknown }).issues = [{ severity: 'ERROR', message: '注入的问题' }];
  const dirtySnap = JSON.stringify(buildSnapshot(dirty as never, rules));
  const leakedKeys = DERIVED_KEYS.filter((k) => dirtySnap.includes(`"${k}"`));
  ok(
    'B2 负样本：往模型里注入 derived.panels/price/geom/issues → 快照里一个都不出现',
    leakedKeys.length === 0 && !dirtySnap.includes('P_LEAK') && !dirtySnap.includes('1234.5'),
    `泄漏字段：${leakedKeys.join('、')}　含 P_LEAK=${dirtySnap.includes('P_LEAK')}`
  );
}

/**
 * B3 —— 快照里的"坐标"必须**只有**柜体的房间落位（那是语义数据：AI 要靠它
 * 判断"靠左/靠右/挪 200"，不给它就没法干这活），**不许**有从模型派生的几何。
 *
 * 判据写成白名单而不是"凡 {x,y} 皆禁止"，是因为后者会把合法的 placement 一起
 * 判死，然后只能加一个例外列表 —— 而例外列表正是将来掩盖真泄漏的地方。
 * 白名单写法：只有 `cabinets[*].placement` 允许 {x,y}；
 * 任何地方都不许出现长度为 2 或 6 的裸数字数组（点 / 包围盒的形状）。
 */
function findGeometry(node: unknown, path: string, hits: string[]): void {
  if (Array.isArray(node)) {
    if ((node.length === 2 || node.length === 6) && node.every((v) => typeof v === 'number')) hits.push(`${path}=[${node.join(',')}]`);
    node.forEach((v, i) => findGeometry(v, `${path}[${i}]`, hits));
    return;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const isPlacement = /^snapshot\.cabinets\[\d+\]\.placement$/.test(path);
    if (!isPlacement && typeof o.x === 'number' && typeof o.y === 'number') hits.push(`${path}={x,y}`);
    for (const [k, v] of Object.entries(o)) findGeometry(v, `${path}.${k}`, hits);
  }
}
{
  const hits: string[] = [];
  findGeometry(snapshot, 'snapshot', hits);
  ok('B3 快照里的坐标只有柜体房间落位（不出现派生几何：点 / 包围盒 / 折线）', hits.length === 0, hits.slice(0, 6).join('；'));
  // 负样本：往快照里塞一个派生的包围盒，判据必须检出
  const dirty = structuredClone(snapshot) as unknown as Record<string, unknown>;
  (dirty.cabinets as Array<Record<string, unknown>>)[0].bbox = { min: [0, 0], max: [2379, 582] };
  const hits2: string[] = [];
  findGeometry(dirty, 'snapshot', hits2);
  ok('B3b 负样本：往快照里塞派生包围盒 → 判据必须检出', hits2.length > 0, "判据形同虚设——那它就没资格替产品背书");
}

/**
 * B4 —— 尺寸必须是整数（1mm 精度）。
 * 给 AI 一个小数尺寸只会让它把 2399.9997 抄回去，然后产生"差 0.0003mm"的幽灵变更。
 */
{
  const bads: string[] = [];
  const walk = (n: unknown, p: string): void => {
    if (typeof n === 'number') {
      if (!Number.isInteger(n)) bads.push(`${p}=${n}`);
      return;
    }
    if (Array.isArray(n)) return n.forEach((v, i) => walk(v, `${p}[${i}]`));
    if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) walk(v, `${p}.${k}`);
  };
  walk({ rooms: snapshot.rooms, cabinets: snapshot.cabinets, materials: snapshot.materials }, 'snap');
  ok('B4 快照里的尺寸都是整数（mm 精度，不带浮点尾巴）', bads.length === 0, bads.slice(0, 5).join('、'));
}
ok('B5 快照体积在合理范围（不至于把整个模型塞进 prompt）', snapshotBytes(snapshot) < 40_000, `${snapshotBytes(snapshot)} bytes`);
ok(
  'B6 快照里包含了"这个分区有没有抽屉/层板/门/杆"（AI 必须能判断功能前提）',
  snapshot.cabinets.some((c) => c.layout.units.some((u) => u.drawers !== null)) &&
    snapshot.cabinets.some((c) => c.layout.units.some((u) => u.drawers === null)) &&
    JSON.stringify(snapshot).includes('"drawers":null')
);

// ═══════════════════════════ C. 校验器 ═══════════════════════════

section('【C】契约校验器：白名单式，多一个键就整条作废');

ok('C1 合法动作通过校验并归一化', act(MINIMAL['cabinet.resize']).ok === true);
ok('C2 未知动作被拒（UNKNOWN_ACTION）', act({ action: 'cabinet.explode', target: { cabinetName: cab0.name }, params: {} }).code === 'UNKNOWN_ACTION');

/**
 * C3/C4 —— 这两条就是"AI 想写几何/路径"的两个真实姿势：
 *   把字段名塞进 params；或干脆在顶层加一个 paths/changes 字段。
 * 两种都必须整条作废，而不是"忽略不认识的部分继续执行"。
 */
{
  const r = act({ action: 'cabinet.resize', target: { cabinetName: cab0.name }, params: { width: 1800, panels: [{ id: 'X' }] } });
  ok('C3 负样本：往 params 里塞 panels/derived 之类 → EXTRA_PARAM 整条作废', !r.ok && r.code === 'EXTRA_PARAM', r.error);
}
{
  const r = act({ action: 'cabinet.resize', target: { cabinetName: cab0.name }, params: { width: 1800 }, paths: ['params.width'], changes: [] });
  ok('C4 负样本：顶层加 paths/changes 字段 → EXTRA_TOP_KEY 整条作废', !r.ok && r.code === 'EXTRA_TOP_KEY', r.error);
}
ok(
  'C5 数值超出契约区间被拒',
  act({ action: 'cabinet.resize', target: { cabinetName: cab0.name }, params: { width: 99999 } }).code === 'BAD_PARAM'
);
ok(
  'C6 枚举取值不在运行时上下文里被拒（材质 id 来自规则集，不是硬编码）',
  act({ action: 'cabinet.setBoardMaterial', target: { cabinetName: cab0.name }, params: { materialId: 'M_NOT_EXIST' } }).code === 'BAD_PARAM'
);
ok(
  'C7 缺必填被拒：缺分区引用 → NO_UNIT；缺 width → MISSING_PARAM（两处都不放过）',
  act({ action: 'cabinet.setUnitWidth', target: { cabinetName: cab0.name }, params: {} }).code === 'NO_UNIT' &&
    act({ action: 'cabinet.setUnitWidth', target: { cabinetName: cab0.name, unit: 1 }, params: {} }).code === 'MISSING_PARAM'
);
ok(
  'C8 atLeastOne 生效：resize 一个尺寸都不给被拒',
  act({ action: 'cabinet.resize', target: { cabinetName: cab0.name }, params: {} }).code === 'MISSING_PARAM'
);

/**
 * C9 —— 跨参数校验。`cabinet.setUnitParam` 的 value 区间由 param 决定：
 * 不判这一层，"把抽屉数设成 3000"会一路通过到 CommandBus ——
 * 那一层只认路径白名单，不认业务数量级。
 */
{
  const bad = act({ action: 'cabinet.setUnitParam', target: { cabinetName: cab0.name, unit: 1 }, params: { param: 'drawers.count', value: 3000 } });
  const good = act({ action: 'cabinet.setUnitParam', target: { cabinetName: cab0.name, unit: 2 }, params: { param: 'rod.heightFromBottom', value: 1800 } });
  const frac = act({ action: 'cabinet.setUnitParam', target: { cabinetName: cab0.name, unit: 1 }, params: { param: 'drawers.count', value: 2.5 } });
  ok('C9 跨参数区间：抽屉数 3000 被拒 / 挂衣杆 1800 通过 / 抽屉数 2.5（非整数）被拒', !bad.ok && good.ok && !frac.ok, `${bad.error} | ${frac.error}`);
}
ok(
  'C10 一次给太多动作被整单拒（防止模型"顺手把整套房子重排"）',
  validatePlan({ actions: Array.from({ length: 40 }, () => MINIMAL['cabinet.resize']) }, ctx).ok === false
);

/**
 * C11 —— 逐条拒收，不是整体失败。
 * 一个 3 条的计划里有 1 条越权，不该让人重问一遍：合法的摆出来、
 * 越权的连原因摊开，由人决定。**但不能因此放过越权的那一条。**
 */
{
  const plan = validatePlan(
    {
      reply: '好的',
      actions: [MINIMAL['cabinet.resize'], { action: 'cabinet.hack', target: { cabinetName: cab0.name }, params: {} }, MINIMAL['project.rename']],
    },
    ctx
  );
  ok('C11 部分越权：合法的照常通过、越权的逐条拒收并给出原因', plan.ok === true && plan.actions.length === 2 && plan.rejected.length === 1, JSON.stringify(plan.rejected));
}
ok(
  'C12 全部越权 → 整体 ok:false（不能给出一个"看起来有动作"的空计划）',
  validatePlan({ actions: [{ action: 'a.b' }, { action: 'c.d' }] }, ctx).ok === false
);

// ═══════════════════════════ D. 契约与界面同源 ═══════════════════════════

section('【D】契约里的区间必须和界面旋钮是同一把尺子');

/**
 * D1 —— 这是一条"防两套数"的断言。
 * `UNIT_PARAM_RANGES` 是给 AI 用的区间，PropertiesPanel 里的 min/max 是给人用的旋钮范围。
 * 两处可以写在不同的文件里，但**不许是两套数**：AI 能设 10 只抽屉而界面只让到 8，
 * 就会出现"AI 改出来的值我在界面上拖不回来"这种荒唐事。
 * 所以直接读 PropertiesPanel 的源码解析出 (relPath, min, max)，逐项比对。
 */
{
  const src = readFileSync(join(APP, 'src', 'ui', 'panels', 'PropertiesPanel.tsx'), 'utf8');
  const pairs: Array<{ key: string; min: number; max: number }> = [];
  const re = /setUnitInt\(cab,\s*index,\s*'([^']+)',\s*v,\s*[^)]*\)[\s\S]{0,80}?min=\{(\d+)\}\s*max=\{(\d+)\}/g;
  // 实际写法是 <NumField ... onCommit={... setUnitInt(cab, index, 'x.y', v, ...)} />，
  // 属性顺序不固定，所以按"每个 NumField 片段"整体抓，再从中分别找 relPath 与 min/max
  for (const m of src.matchAll(/<NumField[\s\S]*?\/>/g)) {
    const frag = m[0];
    const k = /setUnitInt\(cab,\s*index,\s*'([^']+)'/.exec(frag);
    const lo = /min=\{(\d+)\}/.exec(frag);
    const hi = /max=\{(\d+)\}/.exec(frag);
    if (k && lo && hi) pairs.push({ key: k[1], min: Number(lo[1]), max: Number(hi[1]) });
  }
  void re;
  const mismatch = pairs.filter((p) => {
    const r = UNIT_PARAM_RANGES[p.key];
    return !r || r.min !== p.min || r.max !== p.max;
  });
  ok(
    `D1 界面旋钮范围 === 契约区间（比对到 ${pairs.length} 项）`,
    pairs.length >= 6 && mismatch.length === 0,
    mismatch.map((p) => `${p.key}: 界面 ${p.min}~${p.max} / 契约 ${JSON.stringify(UNIT_PARAM_RANGES[p.key])}`).join('；') || `只解析到 ${pairs.length} 项`
  );
}

// ═══════════════════════════ E. 编译器的上下文判定 ═══════════════════════════

section('【E】指代不唯一就报错，绝不替用户挑一个');

const twoCab = structuredClone(bus.getState());
twoCab.cabinets.push(structuredClone(twoCab.cabinets[0]));
twoCab.cabinets[1].id = 'cab_dup';
twoCab.cabinets[1].name = twoCab.cabinets[0].name; // 同名
{
  const r = resolveCabinet(twoCab, { cabinetName: cab0.name });
  ok('E1 同名柜体有两个 → 报错并说明有几个，不按"第一个"挑', typeof r === 'string' && r.includes('都叫'), String(r));
}
ok('E2 找不到柜体 → 报错并列出候选', typeof resolveCabinet(bus.getState(), { cabinetName: '不存在的柜子' }) === 'string');
ok('E3 没有给柜体指代 → 明确要求给出名字', typeof resolveCabinet(bus.getState(), {}) === 'string');
{
  const c = bus.getState().cabinets[0];
  ok('E4 分区序号越界 → 报错（1 起序号，不是 0 起）', typeof resolveUnitIndex(c, 99) === 'string');
  ok('E5 分区序号 1 → 下标 0（+1/−1 换算只做一次）', resolveUnitIndex(c, 1) === 0);
}
{
  // 2 号分区是挂衣区（带挂衣杆 + 一块层板），**没有抽屉**
  const r = act({ action: 'cabinet.setUnitParam', target: { cabinetName: cab0.name, unit: 2 }, params: { param: 'drawers.count', value: 3 } });
  const c = r.ok ? compileAction(r.action!, bus.getState(), rules) : null;
  ok(
    'E6 分区没有抽屉却要设抽屉数 → 报错，并指出替代动作（而不是产出一条必然失败的命令）',
    c !== null && !c.ok && c.error.includes('没有抽屉') && c.error.includes('addUnit'),
    c && !c.ok ? c.error : '编译通过了 —— 这是缺陷'
  );
}
{
  const r = act({ action: 'cabinet.addUnit', target: { cabinetName: cab0.name }, params: { kind: 'hanging', requestedWidth: 800, count: 3 } });
  const c = r.ok ? compileAction(r.action!, bus.getState(), rules) : null;
  ok('E7 挂衣区给了 count（无意义）→ 报错而不是静默忽略', c !== null && !c.ok && c.error.includes('rodHeight'), c && !c.ok ? c.error : '编译通过了');
}
{
  const c = bus.getState().cabinets[0];
  const r = act({ action: 'cabinet.removeUnit', target: { cabinetName: c.name, unit: 1 }, params: {} });
  const only1 = structuredClone(c);
  only1.layout.units = [only1.layout.units[0]];
  const p2 = { ...bus.getState(), cabinets: [only1] };
  const cc = r.ok ? compileAction(r.action!, p2, rules) : null;
  ok('E8 删到只剩一个分区 → 拒绝（那就不成柜体了）', cc !== null && !cc.ok && cc.error.includes('只剩一个分区'), cc && !cc.ok ? cc.error : '编译通过了');
}
{
  const r = act({ action: 'cabinet.create', target: {}, params: { name: cab0.name } });
  const c = r.ok ? compileAction(r.action!, bus.getState(), rules) : null;
  ok('E9 新建柜体重名 → 拒绝（名字必须能分辨）', c !== null && !c.ok && c.error.includes('已经有一个柜体'), c && !c.ok ? c.error : '编译通过了');
}
{
  /**
   * 5mm 抽底板（M_BOARD_5）在规则集里的 kind 也是 'back'，和 9mm 背板一样 ——
   * 所以"只看 kind"是不够的：柜体板必须来自 kind === 'board'。
   * 这一条同时验两件事：能否被校验器提前拒（枚举不含它），
   * 以及万一绕过来、编译器也要拒（第二道）。
   */
  const byValidator = act({ action: 'cabinet.setBoardMaterial', target: { cabinetName: cab0.name }, params: { materialId: 'M_BOARD_5' } });
  const raw = { action: 'cabinet.setBoardMaterial', target: { cabinetName: cab0.name }, params: { materialId: 'M_BOARD_5' } };
  const bypass = validateAction(raw, { ...ctx, bodyMaterials: ['M_BOARD_5'] }); // 模拟枚举被放宽
  const c = bypass.ok ? compileAction({ ...bypass.action, index: 0 } as AiAction, bus.getState(), rules) : null;
  const back = act({ action: 'cabinet.setBackMaterial', target: { cabinetName: cab0.name }, params: { materialId: 'M_BOARD_5' } });
  ok(
    'E10 5mm 抽底板不能当柜体板：校验器枚举先拒，放宽枚举后编译器也拒；但可以做背板',
    !byValidator.ok && c !== null && !c.ok && c.error.includes('kind') && back.ok,
    `校验器=${byValidator.code} 编译器=${c && !c.ok ? c.error : '通过了'} 背板=${back.ok}`
  );
}

/**
 * E11 —— 核心断言：**AI 产出的每一条命令，必须对 CommandBus 都是合法的**。
 * 枚举全部动作、各自造一条合法动作、编译、再逐条过 bus.plan()。
 * 只要有一条 plan 不通过，说明编译器拼出的路径越过了白名单 —— 那是严重缺陷。
 */
{
  const bad: string[] = [];
  let checked = 0;
  for (const name of contractNames) {
    const raw = MINIMAL[name];
    if (!raw) continue;
    const v = act(raw);
    if (!v.ok) continue;
    const c = compileAction(v.action!, bus.getState(), rules);
    if (!c.ok) continue;
    checked++;
    const p = bus.plan(c.command);
    if (!p.ok) bad.push(`${name}: ${p.error}`);
  }
  ok(`E11 AI 产出的命令全部通过总线写权限白名单（检查了 ${checked} 条）`, checked >= 15 && bad.length === 0, bad.join('；'));
}

/**
 * E12 —— 负样本：手工伪造一条"AI 想直接写派生字段"的命令，总线必须拒绝。
 * 这是第三层防线的证明：即使前两层被绕过，模型侧也写不进 panels。
 */
{
  const fake = {
    id: 'cmd_fake',
    op: 'cabinet.update',
    source: 'ai' as const,
    target: { kind: 'cabinet' as const, id: cab0.id },
    changes: [{ path: 'derived.panels[0].length', op: 'set' as const, value: 9999 }],
    label: 'AI 试图直接写派生板件',
  };
  const p = bus.plan(fake);
  const fake2 = { ...fake, changes: [{ path: 'panels[0].length', op: 'set' as const, value: 9999 }] };
  const p2 = bus.plan(fake2);
  ok('E12 负样本：伪造"直接写 derived/panels"的命令 → 总线拒绝（第三层防线成立）', !p.ok && !p2.ok, `${p.ok ? 'derived 通过了！' : p.error} / ${p2.ok ? 'panels 通过了！' : p2.error}`);
}

// ═══════════════════════════ F. 干跑 / 提交 ═══════════════════════════

section('【F】干跑 === 提交（这是"预览可信"的唯一依据）');

function planFrom(raws: unknown[]): { steps: ReturnType<typeof dryRunPlan> | null; errors: string[] } {
  const errors: string[] = [];
  const actions: AiAction[] = [];
  for (const raw of raws) {
    const v = act(raw);
    if (!v.ok) {
      errors.push(String(v.error));
      continue;
    }
    actions.push(v.action!);
  }
  return { steps: dryRunPlan({ bus, actions }), errors };
}

{
  const v0 = bus.getVersion();
  const projectBefore = JSON.stringify(bus.getState());
  const { steps } = planFrom([MINIMAL['cabinet.resize'], MINIMAL['cabinet.nudge']]);
  ok('F1 干跑不改变真模型（版本号与模型内容都不动）', bus.getVersion() === v0 && JSON.stringify(bus.getState()) === projectBefore);
  ok('F2 干跑给出每一步的 diff（用户点应用之前能看清将要发生什么）', steps !== null && steps.steps.every((s) => s.ok && s.diff.length > 0));

  /**
   * F3 —— "预览 === 提交"的可执行定义。
   * 拿干跑终点（沙盒里的模型）与真提交之后的模型**逐字节**比较。
   * 提交执行的是同一批 Command 对象，所以这在结构上必然成立；
   * 一旦有人让提交"重新编译一遍"，这条会立刻变红。
   */
  const expected = JSON.stringify(steps!.draft);
  const r = commitPlan(steps!, bus);
  ok('F3 提交结果与干跑终点逐字节相同（不是"大概一样"）', r.ok && JSON.stringify(bus.getState()) === expected, r.ok ? '' : r.error);
}

/**
 * F4 —— 多步依赖：第 2 步的分区下标由第 1 步决定。
 * 这是"必须对着上一步的结果编译"的可执行定义。若编译器对着原始项目编译，
 * 第 2 步会去改**别的**分区 —— 静默改错对象，比报错危险得多。
 */
{
  const fresh = new CommandBus(sampleProject(rules), rules);
  const c = fresh.getState().cabinets[0];
  const n = c.layout.units.length;
  const raws = [
    { action: 'cabinet.addUnit', target: { cabinetName: c.name }, params: { kind: 'shelves', requestedWidth: 400, count: 2 } },
    { action: 'cabinet.setUnitParam', target: { cabinetName: c.name, unit: n + 1 }, params: { param: 'shelves.count', value: 7 } },
  ];
  const actions: AiAction[] = [];
  for (const raw of raws) {
    const v = validateAction(raw, ctx);
    if (v.ok) actions.push({ ...v.action, index: 0 } as AiAction);
  }
  const run = dryRunPlan({ bus: fresh, actions });
  const applied = commitPlan(run, fresh);
  const after = fresh.getState().cabinets[0].layout.units;
  ok(
    'F4 多步依赖：新增分区后再改"第 N+1 个分区"，改中的是**新加的那个**',
    applied.ok && after.length === n + 1 && after[n].shelves?.count === 7 && after[0].shelves?.count !== 7,
    `units=${after.length} 新分区层板=${after[n].shelves?.count}`
  );
}

/**
 * F5 —— 记忆门必须在**干跑阶段**就把门。
 * 两段式的意义就在这儿：如果干跑不跑记忆门，用户会看到"预览没问题"，
 * 点下去才弹出"被你上次说的话拦住"，那这个预览就是骗人的。
 */
{
  /**
   * 记忆条目的形状取自 src/ai/memory.ts（Correction + CheckSpec）。
   * 这里刻意手写一条最小的、纯 `maxValue` 的条目 ——
   * 用种子记忆会引入"种子本身写错了"的干扰，这一条只验"门在干跑阶段就生效"。
   */
  const gate = compileCorrections([
    {
      id: 'c_test',
      at: Date.now(),
      scope: 'global',
      nl: '柜体高度不要超过 2400',
      evidence: ['验收脚本注入'],
      status: 'active',
      checkSpec: {
        kind: 'maxValue',
        path: 'params.height',
        value: 2400,
        unit: 'mm',
        message: '柜体高度不能超过 2400mm',
      },
      tags: ['验收'],
      origin: 'self',
    },
  ]).gate;
  const fresh = new CommandBus(sampleProject(rules), rules);
  const name = fresh.getState().cabinets[0].name;
  const r = validateAction({ action: 'cabinet.resize', target: { cabinetName: name }, params: { height: 2600 } }, ctx);
  const actions: AiAction[] = r.ok ? [{ ...r.action, index: 0 } as AiAction] : [];
  const run = dryRunPlan({ bus: fresh, actions, gate });
  ok(
    'F5 干跑阶段就被记忆门拦住（预览与提交用同一道门，预览不说谎）',
    run.okCount === 0 && run.steps[0]?.memoryHits.length > 0,
    JSON.stringify(run.steps[0]?.memoryHits ?? null)
  );

  /**
   * F5b —— 同时踩到"新引入 ERROR"和"违反记忆"时，报的必须是**记忆**那一条。
   * 2600 高会新引入 7 条 ERROR（板件超幅面）。原先 strict 排在记忆门之前，
   * 于是错误信息只有"新引入 7 条 ERROR"，memoryHits 是空的 ——
   * 记忆命中被整个掩盖，界面上「最近一次拦截」永远不更新。
   * 两条门都拒绝，但"你上次亲口说过不要这样"比一条通用规则更该被说出来。
   */
  const both = validateAction({ action: 'cabinet.resize', target: { cabinetName: name }, params: { height: 2600 } }, ctx);
  const run2 = dryRunPlan({ bus: new CommandBus(sampleProject(rules), rules), actions: both.ok ? [{ ...both.action, index: 0 } as AiAction] : [], gate });
  const step2 = run2.steps[0];
  ok(
    'F5b 同时触发 ERROR 与记忆 → 报记忆那条，且 memoryHits 不为空（不被 strict 掩盖）',
    step2 !== undefined && step2.memoryHits.length > 0 && step2.newIssues.some((i) => i.severity === 'ERROR') && Boolean(step2.error?.includes('记忆拦截')),
    `hits=${step2?.memoryHits.length} err=${step2?.error}`
  );
}

/**
 * F6 —— 失败步骤之后的步骤必须**一并跳过**，而不是硬提交。
 * 后续步骤是以上一步生效为前提编译的；前提没成立却提交，就会改到别的对象上。
 */
{
  const fresh = new CommandBus(sampleProject(rules), rules);
  const c = fresh.getState().cabinets[0];
  const v1 = validateAction({ action: 'cabinet.setUnitParam', target: { cabinetName: c.name, unit: 2 }, params: { param: 'drawers.count', value: 3 } }, ctx);
  const v2 = validateAction({ action: 'cabinet.resize', target: { cabinetName: c.name }, params: { width: 1900 } }, ctx);
  const actions: AiAction[] = [];
  if (v1.ok) actions.push({ ...v1.action, index: 0 } as AiAction); // 这一步编译会失败（挂衣区没抽屉）
  if (v2.ok) actions.push({ ...v2.action, index: 1 } as AiAction);
  const run = dryRunPlan({ bus: fresh, actions });
  const r = commitPlan(run, fresh);
  ok(
    'F6 前一步失败 → 后面的步骤一并跳过（不静默改错对象），并如实报出跳过数',
    run.steps[0].ok === false && r.ok && r.applied === 0 && r.skipped === 2,
    JSON.stringify(r)
  );
}

/**
 * F7 —— strict：AI 不能把模型改成"带 ERROR"的状态。
 * 用一个必然产生 ERROR 的尺寸（分区净宽给到负数级别的柜宽）触发。
 */
{
  const fresh = new CommandBus(sampleProject(rules), rules);
  const c = fresh.getState().cabinets[0];
  const v = validateAction({ action: 'cabinet.resize', target: { cabinetName: c.name }, params: { width: 300 } }, ctx);
  const actions: AiAction[] = v.ok ? [{ ...v.action, index: 0 } as AiAction] : [];
  const run = dryRunPlan({ bus: fresh, actions });
  const hasError = run.steps[0]?.newIssues.some((i) => i.severity === 'ERROR') ?? false;
  ok(
    'F7 会让模型产生 ERROR 的动作被拒（AI 不能把模型改成不可交付状态）',
    !hasError || run.steps[0].ok === false,
    `新 ERROR=${hasError} 步骤 ok=${run.steps[0].ok}`
  );
}

/**
 * F8 —— 版本失效：预览之后模型被改动过，提交必须拒绝。
 * 预览是用户点"应用"的唯一依据；依据变了还在提交等于骗人。
 */
{
  const fresh = new CommandBus(sampleProject(rules), rules);
  const c = fresh.getState().cabinets[0];
  const v = validateAction({ action: 'cabinet.resize', target: { cabinetName: c.name }, params: { width: 2000 } }, ctx);
  const actions: AiAction[] = v.ok ? [{ ...v.action, index: 0 } as AiAction] : [];
  const run = dryRunPlan({ bus: fresh, actions });
  // 模拟"用户自己又改了一下模型"
  const name = c.name;
  const c2 = fresh.getState().cabinets[0];
  fresh.execute({ id: 'x', op: 'cabinet.move', source: 'ui', target: { kind: 'cabinet', id: c2.id }, changes: [{ path: 'placement.x', op: 'add', value: 50, unit: 'mm' }], label: `移动「${name}」` });
  const r = commitPlan(run, fresh);
  ok('F8 预览之后模型被改动 → 拒绝提交并说明原因（而不是"尽力而为"）', !r.ok && r.error.includes('预览之后'), r.ok ? '居然提交成功了' : '');
}

// ═══════════════════════════ G. 端到端：mock OpenAI 兼容服务商 ═══════════════════════════

const TMP = join(tmpdir(), `furniture-cad-ai-${Date.now()}`);
const MOCK_PORT = Number(process.env.MOCK_AI_PORT || 8821);
const API_PORT = Number(process.env.AI_API_PORT || 8822);

/** mock 服务商：一个最小的 OpenAI 兼容端点。用来证明"换个 baseUrl 就能换一家" */
const mockHits: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
let mockContent = '';
let mockStatus = 200;
let mockEnvelope: unknown = null;

const mock = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown> = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* 记原文也够 */
    }
    mockHits.push({ url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
    if ((req.url ?? '').startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model-1' }, { id: 'mock-model-2' }] }));
      return;
    }
    if (mockStatus !== 200) {
      res.writeHead(mockStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'mock 故障注入' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        mockEnvelope ?? {
          id: 'chatcmpl-mock',
          model: 'mock-model-1',
          choices: [{ index: 0, message: { role: 'assistant', content: mockContent }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
        }
      )
    );
  });
});

const child: { proc: ReturnType<typeof spawn> | null } = { proc: null };

async function startup(): Promise<void> {
  mkdirSync(TMP, { recursive: true });
  await new Promise<void>((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));

  const envPath = join(TMP, '.env');
  writeFileSync(
    envPath,
    [
      '# AI 通路验收专用（临时目录，结束即丢弃）',
      'AI_PROVIDER=custom',
      `AI_BASE_URL=http://127.0.0.1:${MOCK_PORT}/v1`,
      'AI_MODEL=mock-model-1',
      'AI_API_KEY=sk-mock-verify-key-0000',
      'AI_TEMPERATURE=0.1',
      'AI_TIMEOUT_MS=8000',
      '',
    ].join('\n'),
    'utf8'
  );

  child.proc = spawn(process.execPath, [join(APP, 'server', 'server.mjs')], {
    cwd: APP,
    env: {
      ...process.env,
      PORT: String(API_PORT),
      APP_ENV_PATH: envPath,
      APP_MEM_PATH: join(TMP, 'memory', 'corrections.jsonl'),
      APP_ACCOUNTS_PATH: join(TMP, 'memory', 'accounts.json'),
      APP_AUDIT_PATH: join(TMP, 'memory', 'audit.jsonl'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.proc.stdout?.on('data', () => {});
  child.proc.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d.toString()}`));

  // 等服务起来
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/health`);
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('本地服务未能在 9 秒内启动');
}

function teardown(): void {
  try {
    child.proc?.kill();
  } catch {
    /* 已经退了 */
  }
  try {
    mock.close();
  } catch {
    /* 已经关了 */
  }
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
}

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function get(path: string, token?: string): Promise<{ status: number; data: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${API_PORT}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

async function main(): Promise<void> {
  section('【G】端到端：真服务 + mock OpenAI 兼容服务商');
  try {
    await startup();
  } catch (e) {
    ok('G0 本地服务能启动', false, (e as Error).message);
    return;
  }

  try {
    const health = await get('/api/health');
    ok('G1 本地服务健康检查通过，并如实报告鉴权模式', health.status === 200 && health.data.authMode === 'local-open', JSON.stringify(health.data));

    // ── 正常规划 ──
    mockContent = JSON.stringify({
      reply: '好的，把主卧衣柜改成 2000 宽。',
      actions: [{ action: 'cabinet.resize', target: { cabinetName: cab0.name }, params: { width: 2000 }, reason: '用户要求 2000' }],
    });
    mockHits.length = 0;
    const p1 = await post('/api/ai/plan', { text: '把主卧衣柜改成 2000 宽', snapshot });
    ok('G2 端到端规划成功，拿到契约校验过的动作', p1.status === 200 && p1.data.ok === true && (p1.data.actions as unknown[]).length === 1, JSON.stringify(p1.data).slice(0, 300));

    /**
     * G3 —— 证明发起的是**标准 OpenAI 调用形态**。
     * 这是"支持 api 调用的形式，后续可以添加其他 api"最直接的证据：
     * 请求体是 {model, messages, response_format}，Authorization: Bearer。
     * 任何提供兼容端点的服务商都能直接接上，不需要为它写适配层。
     */
    const call = mockHits.find((h) => h.url.startsWith('/v1/chat/completions'));
    const b = (call?.body ?? {}) as { model?: string; messages?: unknown[]; response_format?: { type?: string } };
    ok(
      'G3 发出去的是标准 /chat/completions 形态（model + messages + json 模式 + Bearer 鉴权）',
      Boolean(call) && b.model === 'mock-model-1' && Array.isArray(b.messages) && b.messages.length === 2 && b.response_format?.type === 'json_object' && call!.auth === 'Bearer sk-mock-verify-key-0000',
      JSON.stringify({ url: call?.url, model: b.model, msgs: b.messages?.length, rf: b.response_format, auth: call?.auth })
    );
    const sysMsg = String((b.messages as Array<{ content: string }>)?.[0]?.content ?? '');
    const userMsg = String((b.messages as Array<{ content: string }>)?.[1]?.content ?? '');
    ok('G4 system 消息是契约生成的提示词，user 消息里带项目快照与用户原话', sysMsg.includes('命令规划器') && userMsg.includes('主卧衣柜改成 2000 宽') && userMsg.includes('当前模型状态'));
    ok('G5 服务端如实回传用量（账单不能估）', (p1.data.usage as { total_tokens?: number } | null)?.total_tokens === 1290);

    /**
     * G6 —— 负样本：模型返回一大段寒暄+围栏+半截 JSON。
     * 判据：**不猜**。宁可说"解析不出来"并把原文交给用户，
     * 也不要用"尽力理解"把半截计划执行掉。
     */
    mockContent = '好的，我来帮你改。\n```json\n{ "actions": [ { "action": "cabinet.resize" ';
    const p2 = await post('/api/ai/plan', { text: '随便改改', snapshot });
    ok('G6 负样本：模型返回半截 JSON → 明确报"解析失败"并附原始文本，不猜', p2.data.ok === false && String(p2.data.error).includes('JSON') && typeof p2.data.raw === 'string', JSON.stringify(p2.data).slice(0, 240));

    mockContent = '```json\n{ "reply": "ok", "actions": [ { "action":"cabinet.resize","target":{"cabinetName":"' + cab0.name + '"},"params":{"width":1515},"paths":["params.width"] } ] }\n```';
    const p3 = await post('/api/ai/plan', { text: '试试越权', snapshot });
    ok(
      'G7 负样本：模型试图在动作里夹带 paths → 被拒，且进审计',
      p3.data.ok === false && (p3.data.rejected as unknown[]).length === 1,
      JSON.stringify(p3.data.rejected ?? p3.data).slice(0, 240)
    );

    /**
     * G8 —— 换一家服务商（不同 baseUrl / 模型名）同样能通。
     * 做法：改 .env 指向同一个 mock 的另一个"厂商路径"，重启服务。
     * 这是"后续可以添加其他 API"的可执行定义 —— 换服务商不改一行代码。
     */
    mockContent = JSON.stringify({ reply: 'ok', actions: [{ action: 'project.rename', target: {}, params: { name: '换服务商测试' } }] });
    mockHits.length = 0;
    const p4 = await post('/api/ai/plan', { text: '项目改名', snapshot, model: 'mock-model-2' });
    ok('G8 可在调用级指定另一个模型（同一个兼容端点下换模型不改代码）', p4.data.ok === true && mockHits.some((h) => (h.body as { model?: string }).model === 'mock-model-2'));

    // ── H. 账号与额度 ──
    section('【H】账号：无 token 拦、额度耗尽拦、审计留痕');

    const modeBefore = await get('/api/auth/mode');
    ok('H1 初始为 local-open（先自用的默认状态，不破坏既有用法）', modeBefore.data.mode === 'local-open');

    const reg = await post('/api/auth/register', { username: 'owner_verify', password: 'verify-pass-1234', displayName: '验收所有者' });
    ok('H2 建立第一个账号 → 成为 owner，并返回会话 token', reg.status === 200 && (reg.data.account as { role?: string })?.role === 'owner' && typeof reg.data.token === 'string');
    const token = String(reg.data.token);

    const noToken = await post('/api/ai/plan', { text: 'x', snapshot });
    ok('H3 账号模式下一旦没有 token，所有接口 401（包括 AI 规划）', noToken.status === 401, `实际 ${noToken.status}`);
    const withToken = await post('/api/ai/plan', { text: '项目改名', snapshot }, token);
    ok('H4 带 token 正常通过', withToken.status === 200 && withToken.data.ok === true, JSON.stringify(withToken.data).slice(0, 200));

    const dup = await post('/api/auth/register', { username: 'second', password: 'verify-pass-1234' });
    ok('H5 已有账号后自助注册被关闭（注册接口不是后门）', dup.status === 403 && String(dup.data.code) === 'REGISTER_CLOSED');

    const weak = await post('/api/account/accounts', { username: 'weakuser', password: '123456' }, token);
    ok('H6 弱口令被拒（纯数字/常见弱口令/长度不足）', weak.status === 400 && String(weak.data.error).includes('口令'), String(weak.data.error));

    // 额度：账号默认就是 free（每日 100 万 token **且**每日 1 次生成，任一用尽即止）
    await post('/api/account/account', { id: String((reg.data.account as { id?: string }).id), plan: 'free' }, token);
    // H4 那次成功调用已经用掉了今天这 1 次生成 —— 第二次就该被拦
    let quotaHit = 0;
    let lastStatus = 0;
    for (let i = 0; i < 70; i++) {
      const r = await post('/api/ai/plan', { text: '项目改名', snapshot }, token);
      lastStatus = r.status;
      if (r.status === 429) {
        quotaHit = i + 1;
        break;
      }
    }
    ok('H7 额度耗尽后被拦（429 且给出可读原因），不是无声继续烧钱', quotaHit > 0 && lastStatus === 429, `第 ${quotaHit} 次触发 429`);
    const blockedBody = await post('/api/ai/plan', { text: '项目改名', snapshot }, token);
    ok('H7b 被拦时**说清是哪一条拦的**（生成次数，不是 token）—— "额度用完"没有可操作性',
      String(blockedBody.data.code ?? '').includes('GENERATIONS') && String(blockedBody.data.error ?? '').includes('生成'),
      `${blockedBody.data.code} / ${blockedBody.data.error}`);

    const usage = await get('/api/usage', token);
    const usedRow = (usage.data.accounts as Array<{ quota: { used: { totalCalls: number; totalTokens: number; dayGenerations: number; dayTokens: number } } }>)?.[0]?.quota.used;
    ok('H8 用量被如实累计（次数与 token 都记）', Boolean(usedRow) && usedRow!.totalCalls > 0 && usedRow!.totalTokens > 0, JSON.stringify(usedRow));

    /**
     * H13 / H14 —— 对话通道也得记账。
     *
     * 以前 /api/ai/chat 既不查额度也不记账：问一句"踢脚线一般多高"同样要花
     * prompt + completion 的钱，而账上显示是 0。用量是账单，少记比不显示更糟 ——
     * 用户照着界面上的数字估"还能用多久"，估出来的是假的。
     *
     * 但对话**不算一次生成**：生成次数是给"出图"那件事留的，提问不该吃掉它。
     * 这两条一起，才是"免费用户每天 100 万 token 或 1 次生成"能同时成立的原因。
     */
    const genBefore = usedRow?.dayGenerations ?? -1;
    const tokBefore = usedRow?.dayTokens ?? -1;
    const chat = await post('/api/ai/chat', { messages: [{ role: 'user', content: '踢脚线一般多高？' }] }, token);
    ok('H13 对话通道正常返回（未被额度拦住）', chat.status === 200 && chat.data.ok === true, JSON.stringify(chat.data).slice(0, 160));
    const usage2 = await get('/api/usage', token);
    const usedRow2 = (usage2.data.accounts as Array<{ quota: { used: { dayTokens: number; dayGenerations: number } } }>)?.[0]?.quota.used;
    ok('H14 对话消耗的 token 进了账（以前这里永远是 0）', (usedRow2?.dayTokens ?? 0) > tokBefore, `${tokBefore} → ${usedRow2?.dayTokens}`);
    ok('H15 对话**没有**吃掉生成次数（提问不该算一次生成）', usedRow2?.dayGenerations === genBefore, `${genBefore} → ${usedRow2?.dayGenerations}`);

    const audit = await get('/api/security/audit?limit=200', token);
    const entries = (audit.data.entries as Array<{ action?: string; result?: string; actor?: string }>) ?? [];
    ok(
      'H9 审计日志留下登录、被拒的越权动作、AI 调用三类痕迹',
      entries.some((e) => e.action === 'auth.login' && e.result === 'ok') &&
        entries.some((e) => e.action === 'ai.plan' && e.result === 'rejected') &&
        entries.some((e) => e.action === 'ai.call'),
      entries.slice(0, 6).map((e) => `${e.action}/${e.result}`).join(' ')
    );

    const badLogin = await post('/api/auth/login', { username: 'owner_verify', password: 'wrong-password-here' });
    ok('H10 口令错误只回同一句话（不做账号枚举）', badLogin.status === 401 && String(badLogin.data.error) === '用户名或口令不正确', String(badLogin.data.error));

    const policy = await get('/api/security/policy', token);
    const ni = (policy.data.notImplemented as string[]) ?? [];
    ok(
      'H11 安全现状照实列出缺口（HTTPS / 二次验证 / 会话轮换 / 并发写保护 都在"尚未实现"里）',
      policy.status === 200 && ni.some((x) => x.includes('HTTPS')) && ni.some((x) => x.includes('二次验证')) && ni.some((x) => x.includes('轮换')),
      ni.length ? '' : '缺口列表是空的 —— 那才是真的危险'
    );

    /**
     * H12 —— 负样本：账号库被写坏 → 服务**必须拒绝启动**，不许降级成无账号。
     * 降级意味着"文件坏了 = 系统不设防"。启动失败很吵但看得见；静默降级没救。
     */
    {
      const accPath = join(TMP, 'memory', 'accounts.json');
      writeFileSync(accPath, '{ 这不是 JSON', 'utf8');
      const broken = spawn(process.execPath, [join(APP, 'server', 'server.mjs')], {
        cwd: APP,
        env: {
          ...process.env,
          PORT: String(API_PORT + 1),
          APP_ENV_PATH: join(TMP, '.env'),
          APP_MEM_PATH: join(TMP, 'memory', 'corrections.jsonl'),
          APP_ACCOUNTS_PATH: accPath,
          APP_AUDIT_PATH: join(TMP, 'memory', 'audit.jsonl'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderrText = '';
      broken.stderr?.on('data', (d: Buffer) => (stderrText += d.toString()));
      const code: number | null = await new Promise((r) => broken.on('exit', (c) => r(c)));
      await new Promise((r) => setTimeout(r, 250));
      let stillUp = false;
      try {
        await fetch(`http://127.0.0.1:${API_PORT + 1}/api/health`);
        stillUp = true;
      } catch {
        /* 起不来才对 */
      }
      ok('H12 负样本：账号库损坏 → 服务拒绝启动（不降级为"无账号"），且说明原因', code !== 0 && !stillUp && stderrText.includes('账号库'), `exit=${code} up=${stillUp}`);
    }
  } finally {
    teardown();
  }
}

await main();

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('\nAI 通路：三层防线成立，端到端可用，账号与额度生效。');
}
