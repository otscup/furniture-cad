/**
 * ══════════════════════════════════════════════════════════════════════
 *  复杂柜型验收 —— 餐边柜 / 岛台 / 洗衣机柜
 *
 *  用户原话：
 *    "如果遇到一些复杂的柜子怎么添加……如果是餐边柜以及岛台橱柜洗衣机柜应该怎么添加"
 *
 *  ── 三种柜型各自"复杂"在哪，语义怎么接 ──
 *    餐边柜：矮高 + 抽/开放灯带/门板的组合 —— 现有分区语义**本来就能表达**，
 *            落点是模板（sideboard）。这一组同时证明"模板组合能力"是够的。
 *    岛台：  双面柜 —— layout.type='double' + backUnits（背面排），共用中板、
 *            没有背板。两排各自做净宽分配，各自有宽度链恒等式。
 *    洗衣机柜：预留洞口 + 上下分体 —— kind='appliance'，洞口三尺寸 +
 *            topDrawers（洞口上面的抽屉）；机器本身是甲购件，不进开料清单。
 *
 *  ── 这批断言要证明什么 ──
 *    ① 三种柜型走的是同一条 makeUnit → computeCabinetLayout → generate 管线，
 *      没有为"特殊柜型"开第二条几何实现（第二份真相源是本项目最怕的事故）。
 *    ② 恒等式对两排都成立（后排 Σ净宽链、排深+中板=总深、洞口上方抽屉的
 *      净高口径），差 1mm 都不行。
 *    ③ 说错话（电器格给 count / 层板区给洞口 / 电器格带门）被逐条拒收并说明原因。
 *    ④ 四视图、清单、3D 对新语义的派生真实存在（不是"模型里有字段但图上没有"）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinetFromTemplate, makeUnit, sampleProject } from '../src/core/docFactory.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { generateCabinet } from '../src/core/geometry/generate.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { buildCabinetBodies } from '../src/core/geometry/bodies3d.ts';
import { validateCabinet } from '../src/core/rules/validate.ts';
import { compileAction, type AiAction } from '../src/ai/compile.ts';
import * as CMD from '../src/core/commands.ts';
import { validatePlan } from '../shared/aiContract.mjs';

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

const ctx = { bodyMaterials: [], backMaterials: [] };
function validate(actions: unknown[]): ReturnType<typeof validatePlan> {
  return validatePlan({ reply: '', actions }, ctx);
}

/** 走真实链路：契约 → 编译 → 提交，返回 bus（命令可能失败，调用方自判） */
function runCreate(raw: Record<string, unknown>, name: string): { bus: CommandBus; error?: string; cab: Cabinet | null } {
  const v = validatePlan({ reply: '', actions: [raw] }, ctx);
  const bus = new CommandBus(sampleProject(rules), rules);
  if (!v.ok || v.actions.length === 0) return { bus, error: v.error ?? JSON.stringify(v.rejected), cab: null };
  const c = compileAction({ ...(v.actions[0] as object), index: 0 } as AiAction, bus.getState(), rules);
  if (!c.ok) return { bus, error: c.error, cab: null };
  const r = bus.execute(c.command, { commitLabel: 'AI 建复杂柜' });
  if (!r.ok) return { bus, error: r.error, cab: null };
  return { bus, cab: bus.getState().cabinets.find((x) => x.name === name) ?? null };
}

// ═══════════════════════════════ A 契约 ═══════════════════════════════

section('A 契约：电器格与背面分区的校验');

const laundryUnits = [
  { kind: 'appliance', width: 700, applianceName: '洗衣机', openingWidth: 650, openingHeight: 850, openingDepth: 600, topDrawers: 3, nickname: '洗衣机位' },
  { kind: 'shelves', width: 650, count: 4, doorCount: 2, nickname: '侧柜' },
];
const laundryCreate = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: '洗衣机柜', width: 1400, height: 2100, depth: 620, units: laundryUnits } },
]);
ok('A1 电器格意图（洞口三尺寸 + topDrawers）通过校验', laundryCreate.ok === true, JSON.stringify(laundryCreate.rejected));

const applianceCount = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [{ kind: 'appliance', width: 700, count: 3 }] } },
]);
ok('A2 电器格给了 count → 拒，并提示用 topDrawers / opening*',
  applianceCount.ok === false && /topDrawers/.test(JSON.stringify(applianceCount.rejected)),
  JSON.stringify(applianceCount.rejected));

const shelfOpening = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [{ kind: 'shelves', width: 700, openingWidth: 650, openingHeight: 850, openingDepth: 600 }] } },
]);
ok('A3 层板区给了洞口参数 → 拒（只有电器格预留洞口）',
  shelfOpening.ok === false && /appliance/.test(JSON.stringify(shelfOpening.rejected)),
  JSON.stringify(shelfOpening.rejected));

const applianceDoor = validate([
  { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: 'X', units: [{ kind: 'appliance', width: 700, openingWidth: 650, openingHeight: 850, openingDepth: 600, doorCount: 2 }] } },
]);
ok('A4 电器格带门 → 拒（洞口与门在同一张脸上冲突）',
  applianceDoor.ok === false && /冲突|装门/.test(JSON.stringify(applianceDoor.rejected)),
  JSON.stringify(applianceDoor.rejected));

const islandCreate = validate([
  {
    action: 'cabinet.create',
    target: { roomName: '主卧' },
    params: {
      name: '岛台', width: 2000, height: 900, depth: 900,
      units: [
        { kind: 'drawerBank', width: 600, count: 2 },
        { kind: 'shelves', width: 660, count: 1, doorCount: 2 },
        { kind: 'shelves', width: 660, count: 1, doorCount: 2 },
      ],
      backUnits: [
        { kind: 'shelves', width: 640, count: 2, doorCount: 2 },
        { kind: 'shelves', width: 640, count: 2, doorCount: 2 },
        { kind: 'shelves', width: 640, count: 2, doorCount: 2 },
      ],
    },
  },
]);
ok('A5 backUnits（双面岛台）通过校验', islandCreate.ok === true, JSON.stringify(islandCreate.rejected));

const badBack = validate([
  {
    action: 'cabinet.create',
    target: { roomName: '主卧' },
    params: {
      name: 'X', width: 2000, height: 900, depth: 900, units: [{ kind: 'open', width: 1900 }],
      backUnits: [{ kind: 'hanging', width: 1900, count: 3 }],
    },
  },
]);
ok('A6 背面分区说错话同样被拒（挂衣区给 count）',
  badBack.ok === false && /backUnits/.test(JSON.stringify(badBack.rejected) + (badBack.error ?? '')),
  JSON.stringify(badBack.rejected));

const addUnitAppliance = validate([
  { action: 'cabinet.addUnit', target: { cabinetName: '主卧衣柜' }, params: { kind: 'appliance', requestedWidth: 700, applianceName: '烘干机', openingWidth: 650, openingHeight: 850, openingDepth: 600, topDrawers: 0 } },
]);
ok('A7 addUnit 也能加电器格（增量描述洗衣机柜）', addUnitAppliance.ok === true, JSON.stringify(addUnitAppliance.rejected));

const addUnitOpening = validate([
  { action: 'cabinet.addUnit', target: { cabinetName: '主卧衣柜' }, params: { kind: 'shelves', requestedWidth: 700, openingWidth: 650, openingHeight: 850, openingDepth: 600 } },
]);
ok('A8 addUnit 给层板区塞洞口 → 拒',
  addUnitOpening.ok === false && /洞口|appliance/.test(JSON.stringify(addUnitOpening.rejected)),
  JSON.stringify(addUnitOpening.rejected));

// ═══════════════════════════════ B 模板 ═══════════════════════════════

section('B 三个新模板：同一条构造管线，预设自洽');

for (const tid of ['sideboard', 'island', 'laundry']) {
  const cab = createCabinetFromTemplate({ templateId: tid, name: `验收·${tid}`, roomId: 'room_check', x: 0, y: 0, rules });
  const geom = generateCabinet(cab, rules);
  const issues = validateCabinet(cab, geom, rules);
  const hardErr = issues.filter((i) => i.severity === 'ERROR');
  const warns = issues.filter((i) => i.severity === 'WARNING').map((i) => i.code);
  ok(`[${tid}] 构造 → 派生 → 校验零 ERROR`, hardErr.length === 0, hardErr.map((i) => i.code).join(','));
  ok(`[${tid}] 无意外 WARNING（${warns.join(',') || '无'}）`,
    warns.every((c) => ['RULE-BACKPANEL-SPLIT', 'RULE-PANEL-WEIGHT', 'RULE-DRAWER-TALL-FRONT'].includes(c)),
    warns.join(','));
  const ids = [...cab.layout.units, ...(cab.layout.backUnits ?? [])].map((u) => u.id);
  ok(`[${tid}] 前后排分区 id 全局唯一`, new Set(ids).size === ids.length, ids.join(','));
  const panelIds = geom.panels.map((x) => x.id);
  ok(`[${tid}] 板件 id 无重复（撞 id = 清单少一块 = 下错料）`, new Set(panelIds).size === panelIds.length);
}

const island = createCabinetFromTemplate({ templateId: 'island', name: '岛台', roomId: 'room_check', x: 0, y: 0, rules });
const laundry = createCabinetFromTemplate({ templateId: 'laundry', name: '洗衣机柜', roomId: 'room_check', x: 0, y: 0, rules });

ok('岛台模板落地为 type=double + backUnits', island.layout.type === 'double' && (island.layout.backUnits?.length ?? 0) === 3, `${island.layout.type} / ${island.layout.backUnits?.length}`);
ok('洗衣机柜模板的电器格带完整洞口语义', (() => {
  const a = laundry.layout.units[0]?.appliance;
  return !!a && a.name === '洗衣机' && a.openingWidth === 650 && a.openingHeight === 850 && a.openingDepth === 600 && a.topDrawers === 3;
})(), JSON.stringify(laundry.layout.units[0]?.appliance));

// ═══════════════════════════════ C 岛台派生 ═══════════════════════════════

section('C 岛台派生：中板 / 无背板 / 两排恒等式 / 四视图');

const L = computeCabinetLayout(island, rules);
const DB = L.double!;
ok('排深恒等式：后排深 + 中板 + 前排深 === 总深', DB.backRowDepth + DB.midT + DB.frontRowDepth === island.params.depth, `${DB.backRowDepth}+${DB.midT}+${DB.frontRowDepth} vs ${island.params.depth}`);
ok('后排宽度链：t + Σ后排净宽 + (m-1)t + t === 总宽', (() => {
  const t = L.boardT;
  return t + DB.backNets.reduce((a, b) => a + b, 0) + (DB.backNets.length - 1) * t + t === island.params.width;
})(), DB.backNets.join('+'));
ok('前排宽度链同样成立', (() => {
  const t = L.boardT;
  return t + L.nets.reduce((a, b) => a + b, 0) + (L.nets.length - 1) * t + t === island.params.width;
})(), L.nets.join('+'));

const geom = generateCabinet(island, rules);
const roles = new Map<string, number>();
for (const p of geom.panels) roles.set(p.role, (roles.get(p.role) ?? 0) + 1);
ok('没有背板板件（中板就是两排共用的"背"）', (roles.get('BackPanel') ?? 0) === 0, `BackPanel=${roles.get('BackPanel')}`);
ok('共用中板恰好 1 块', roles.get('MiddlePanel') === 1, `${roles.get('MiddlePanel')}`);
ok('后踢脚板存在（双面临走两面都有脚线）', (roles.get('KickBoardBack') ?? 0) === 1);
ok('中板裁切尺寸 = 内空宽 × 箱体高（与顶底板同源）', (() => {
  const mid = geom.panels.find((x) => x.role === 'MiddlePanel')!;
  return mid.length === L.innerW && mid.width === L.bodyH;
})(), JSON.stringify(geom.panels.find((x) => x.role === 'MiddlePanel')));

// 后排的板件真的存在（门/层板按后排 units 派生）
const backIds = new Set(island.layout.backUnits!.map((u) => u.id));
const backDoors = geom.panels.filter((x) => backIds.has(x.group) && x.role === 'DoorPanel');
const backShelves = geom.panels.filter((x) => backIds.has(x.group) && x.role === 'ShelfPanel');
ok('背面排的门板真的派生出来了（3 组 × 2 扇）', backDoors.length === 6, `${backDoors.length}`);
ok('背面排的层板真的派生出来了（3 格 × 2 块）', backShelves.length === 6, `${backShelves.length}`);
ok('前后排板件 id 无交叉（后排不会顶掉前排的板）', (() => {
  const all = geom.panels.map((x) => x.id);
  return new Set(all).size === all.length;
})());

// 四视图：俯视图要看到两排的脸；侧视图要看到中板
const views = buildCabinetViews(island, rules);
const topPolys = views.prims.top;
const frontLayerInTop = topPolys.filter((p) => p.k === 'poly' && p.layer === 'F-CAB-FRONT');
ok('俯视图：前排脸线存在', frontLayerInTop.length >= 3, `${frontLayerInTop.length}`);
const structLayerInTop = topPolys.filter((p) => p.k === 'poly' && p.layer === 'PANEL_18');
ok('俯视图：中板横带存在（18mm 图层的矩形多于前排立板数）', structLayerInTop.length >= 4, `${structLayerInTop.length}`);
const sidePolys = views.prims.side;
const midVisibleInSide = sidePolys.some(
  (p) => p.k === 'poly' && p.layer === 'PANEL_18' && (() => {
    const ys = p.pts.map((q) => q.x);
    return Math.abs(Math.max(...ys) - Math.min(...ys) - DB.midT) < 1e-6;
  })()
);
ok('侧视图：中板以实线竖带出现（宽 = 板厚）', midVisibleInSide);
ok('假设清单如实说明"背面排在正投影不可见"', views.assumptions.some((s) => s.includes('双面柜')), views.assumptions.join(' | ').slice(0, 200));

// 3D：语义骨架照常派生（前排 2+2 扇 + 后排 3×2 扇 = 10 扇门，中板占 role 'back'）
const bodies = buildCabinetBodies(island, rules);
ok('3D 体块照常派生且两排门都在（前排 4 扇 + 后排 6 扇）', bodies.filter((b) => b.role === 'door').length === 10, `door=${bodies.filter((b) => b.role === 'door').length}`);
ok('3D 里中板顶替了背板（双面柜没有独立背板体）', bodies.some((b) => b.id.endsWith('_MID')) && !bodies.some((b) => b.id.endsWith('_BACK')), bodies.filter((b) => b.role === 'back').map((b) => b.id).join(','));
ok('3D 里后踢脚板存在', bodies.filter((b) => b.role === 'plinth').length === 2);

// 镜像：前后排一起反序（只翻前排的"镜像"是假的）
{
  const islandClone = structuredClone(island);
  islandClone.id = 'cab_island_check';
  const proj: Project = { ...sampleProject(rules), rooms: [{ id: 'room_x', name: 'X', walls: [] }], cabinets: [islandClone] };
  const bus = new CommandBus(proj, rules);
  const c = CMD.mirrorCabinet(islandClone, 'test');
  const r = bus.execute(c, { commitLabel: '镜像岛台' });
  const after = bus.getState().cabinets[0]!;
  const fwd = after.layout.units.map((u) => u.nickname).join('|');
  const bwd = (after.layout.backUnits ?? []).map((u) => u.nickname).join('|');
  ok('镜像：前排反序', r.ok === true && fwd === ['前柜右', '前柜左', '前抽'].join('|'), fwd);
  ok('镜像：背面排一起反序', bwd === ['后柜右', '后柜中', '后柜左'].join('|'), bwd);
  bus.undo();
  const restored = bus.getState().cabinets[0]!;
  ok('镜像撤销：两排都回到原序', restored.layout.units.map((u) => u.nickname).join('|') === island.layout.units.map((u) => u.nickname).join('|') && (restored.layout.backUnits ?? []).map((u) => u.nickname).join('|') === island.layout.backUnits!.map((u) => u.nickname).join('|'));
}

// ═══════════════════════════════ D 洗衣机柜派生 ═══════════════════════════════

section('D 洗衣机柜派生：过梁板 / 甲购件 / 洞口硬规则 / 上下分体净高');

const lg = generateCabinet(laundry, rules);
const lL = computeCabinetLayout(laundry, rules);
const lintel = lg.panels.find((x) => x.role === 'ApertureLintel');
ok('过梁板存在（洞口的顶）', !!lintel, JSON.stringify(lg.panels.map((x) => x.role)));
ok('过梁板位置 = 距柜内底 850mm（洞口高）', !!lintel && lintel.edgeLabel.includes('850'), lintel?.edgeLabel ?? '');
ok('过梁板跨整个分区净宽', !!lintel && lintel.length === lL.nets[0], `${lintel?.length} vs ${lL.nets[0]}`);

const app = lg.purchased.find((x) => x.kind === 'appliance');
ok('洗衣机进甲购件清单（不进开料）', !!app && app.nameZh.includes('洗衣机'), JSON.stringify(lg.purchased));
ok('甲购件规格写明洞口三尺寸（安装前现场复核）', !!app && app.spec.includes('650') && app.spec.includes('850') && app.spec.includes('600'), app?.spec ?? '');
ok('开料清单里没有"洗衣机"板件（机器不走开料机）', lg.panels.every((x) => !x.nameZh.includes('洗衣机')));

// 上排抽屉的净高口径：Σ分格高 + (n+1)gap = 内空高 − 洞口高 − 过梁板
{
  const u0 = laundry.layout.units[0]!;
  const upperH = lL.innerH - u0.appliance!.openingHeight - lL.boardT;
  const cells = (() => {
    // 与 layout.ts 同源的分格算法
    const d = u0.drawers!;
    const total = upperH - (d.count + 1) * d.gap;
    const base = Math.floor(total / d.count);
    const cells = Array.from({ length: d.count }, () => base);
    let rem = total - base * d.count;
    for (let i = 0; rem > 0; i = (i + 1) % d.count, rem--) cells[i]! += 1;
    return cells;
  })();
  const fronts = lg.panels.filter((x) => x.group === u0.id && x.role === 'DrawerFront');
  ok(`上排抽屉分格 Σ + 缝 = 剩余净高 ${upperH}（上下分体的"上"不占洞口）`,
    cells.reduce((a, b) => a + b, 0) + (u0.drawers!.count + 1) * u0.drawers!.gap === upperH && fronts.length === u0.drawers!.count,
    `cells=${cells.join(',')} fronts=${fronts.length}`);
}

// 洞口放不下 → ERROR 且说人话 + 说清怎么改
{
  const tooNarrow = makeUnit({
    id: 'unit_001',
    kind: 'appliance',
    requestedWidth: 600,
    rules,
    appliance: { name: '洗衣机', openingWidth: 650, openingHeight: 850, openingDepth: 600, topDrawers: 2 },
  });
  const narrowCab: Cabinet = {
    ...structuredClone(laundry),
    id: 'cab_narrow',
    layout: { type: 'row', widthMode: 'fit_total', units: [tooNarrow, laundry.layout.units[1]!] },
  };
  const ng = generateCabinet(narrowCab, rules);
  const nIssues = validateCabinet(narrowCab, ng, rules);
  const fitW = nIssues.find((i) => i.code === 'RULE-APPLIANCE-FIT-W');
  ok('洞口宽 > 分区净宽 → ERROR（模板 600 净宽装不下 650 洞口）', !!fitW && fitW.severity === 'ERROR', JSON.stringify(nIssues.map((i) => i.code)));
  /**
   * 「人话化」的验收口径：报错必须同时给得出**差多少**（不是"参数不合法"）
   * 和**怎么改**（具体到数或具体字段名）。
   *   ① 差多少：message 里有"还宽 29mm"这种带单位的差值
   *   ② 怎么办：fixHint 里有具体目标值（加宽到 686mm 以上）
   */
  ok(
    '错误说清了差多少、怎么改（人话，不是"参数不合法"）',
    !!fitW && /还宽|超|大\s*\d+mm/.test(fitW.message) && /\d+mm/.test(fitW.fixHint ?? ''),
    fitW ? `${fitW.message} / ${fitW.fixHint}` : '无'
  );
}

// ═══════════════════════════════ E AI 端到端 ═══════════════════════════════

section('E AI 端到端：一句话建洗衣机柜 / 岛台');

{
  const res = runCreate(
    {
      action: 'cabinet.create',
      target: { roomName: '主卧' },
      params: { name: '阳台洗衣机柜', width: 1400, height: 2100, depth: 620, units: laundryUnits },
    },
    '阳台洗衣机柜'
  );
  ok('AI 一句话建出洗衣机柜（create → 编译 → 提交全链）', res.cab !== null, res.error ?? '');
  const cab = res.cab;
  ok('电器格语义落地（洞口 650×850×600 + 上面 3 抽）', (() => {
    const a = cab?.layout.units.find((u) => u.kind === 'appliance')?.appliance;
    return !!a && a.openingWidth === 650 && a.topDrawers === 3;
  })(), JSON.stringify(cab?.layout.units));
  ok('AI 建的洗衣机柜校验零 ERROR', (() => {
    if (!cab) return false;
    const g = generateCabinet(cab, rules);
    return validateCabinet(cab, g, rules).every((i) => i.severity !== 'ERROR');
  })());
}

{
  const res = runCreate(
    {
      action: 'cabinet.create',
      target: { roomName: '主卧' },
      params: {
        name: '中岛', width: 2000, height: 900, depth: 900,
        units: [
          { kind: 'drawerBank', width: 600, count: 2 },
          { kind: 'shelves', width: 660, count: 1, doorCount: 2 },
          { kind: 'shelves', width: 660, count: 1, doorCount: 2 },
        ],
        backUnits: [
          { kind: 'shelves', width: 640, count: 2, doorCount: 2 },
          { kind: 'shelves', width: 640, count: 2, doorCount: 2 },
          { kind: 'shelves', width: 640, count: 2, doorCount: 2 },
        ],
      },
    },
    '中岛'
  );
  ok('AI 一句话建出双面岛台（units + backUnits 全链）', res.cab !== null, res.error ?? '');
  ok('岛台经总线落地为 type=double', res.cab?.layout.type === 'double' && (res.cab?.layout.backUnits?.length ?? 0) === 3, JSON.stringify({ type: res.cab?.layout.type, back: res.cab?.layout.backUnits?.length }));
  ok('AI 建的岛台前后排宽度链全部成立', (() => {
    if (!res.cab) return false;
    const g = generateCabinet(res.cab, rules);
    return validateCabinet(res.cab, g, rules).every((i) => i.severity !== 'ERROR');
  })());
}

// 干跑不动真模型（复杂柜型不豁免两段式）
{
  const bus = new CommandBus(sampleProject(rules), rules);
  const before = JSON.stringify(bus.getState());
  const plan = [
    { action: 'cabinet.create', target: { roomName: '主卧' }, params: { name: '干跑岛台', width: 2000, height: 900, depth: 900, units: [{ kind: 'open', width: 1900 }], backUnits: [{ kind: 'open', width: 1900 }] } },
  ];
  const v = validatePlan({ reply: '', actions: plan }, ctx);
  const { dryRunPlan } = await import('../src/ai/planRunner.ts');
  const run = dryRunPlan({ bus, actions: v.actions });
  // PlanRun 的口径：okCount / errorCount（不是 run.ok —— 那是我第一版断言自己读错了返回结构）
  ok('干跑：岛台计划能通过编译并给出预览', run.errorCount === 0 && run.okCount === 1, JSON.stringify(run.steps.map((s) => ({ ok: s.ok, error: s.error }))));
  ok('干跑不动真模型', JSON.stringify(bus.getState()) === before);
}

// ═══════════════════════════════ F 回归 ═══════════════════════════════

section('F 回归：老柜型一根汗毛都不能动');

{
  const s = sampleProject(rules);
  const cab = s.cabinets[0]!;
  const g = generateCabinet(cab, rules);
  ok('示例衣柜仍是 row + 有背板（默认行为不变）', cab.layout.type === 'row' && g.panels.some((x) => x.role === 'BackPanel'));
  ok('示例衣柜校验零 ERROR', validateCabinet(cab, g, rules).every((i) => i.severity !== 'ERROR'));
  const v = buildCabinetViews(cab, rules);
  ok('示例衣柜四视图照常（无双面柜假设条目）', v.assumptions.every((a) => !a.includes('双面柜')));
  ok('row 柜带 backUnits → 校验报 ERROR（不自相矛盾的模型才放行）', (() => {
    const bad: Cabinet = { ...structuredClone(cab), id: 'cab_badrow', layout: { ...cab.layout, backUnits: cab.layout.units } };
    const g2 = generateCabinet(bad, rules);
    return validateCabinet(bad, g2, rules).some((i) => i.code === 'RULE-ROW-WITH-BACK');
  })());
  ok('double 柜缺 backUnits → 校验报 ERROR（派生按 row 兜底，但不放过矛盾）', (() => {
    const bad: Cabinet = { ...structuredClone(cab), id: 'cab_bad2', layout: { ...cab.layout, type: 'double' } };
    const g2 = generateCabinet(bad, rules);
    return validateCabinet(bad, g2, rules).some((i) => i.code === 'RULE-DOUBLE-NO-BACK');
  })());
}

// ═══════════════════════════════ 收尾 ═══════════════════════════════

console.log('\n════════════════════════════════════════════════');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('\n复杂柜型成立：餐边柜（模板组合）/ 岛台（双面 + 中板）/ 洗衣机柜（洞口 + 上下分体），全部走同一条派生管线。');
