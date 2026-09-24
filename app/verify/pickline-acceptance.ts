import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject, createCabinet as makeCabinet, makeUnit } from '../src/core/docFactory.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { pickPartsOf, partParamPath, PART_ZH } from '../src/core/geometry/pickLines.ts';
import type { PickLine } from '../src/core/geometry/pickLines.ts';
import { hitPart } from '../src/viewport/hitTest.ts';
import { compileAction, type AiAction } from '../src/ai/compile.ts';
import { dryRunPlan } from '../src/ai/planRunner.ts';
import { validateAction, PARTS } from '../../app/shared/aiContract.mjs';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  A 组验收：点选 / 圈选 → AI 局部编辑（设计文档《Local-Pick-Edit》§4-A6）
 *
 *  这组验收最重要的不是正样本，是**负样本**：
 *   · 「踢脚线不许解析成 height」—— 反查表错一个词，AI 就会改错参数
 *   · 部件不存在时必须报候选清单，不许静默改别的东西
 *   · 改的路径与点选的部件不符时必须拒绝（AI 说话和动手必须是同一件事）
 *   · 契约外的 target 键（rect 坐标！）必须整条拒收 —— AI 永远不许拿到坐标
 * ══════════════════════════════════════════════════════════════════════
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

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

const proj = sampleProject(rules);
const cab0 = proj.cabinets[0];
const vs = buildCabinetViews(cab0, rules, { x: 0, y: 0 });
const PL = vs.pickLines;
const byPart = (p: string): PickLine[] => PL.filter((x) => x.part === p);

// ───────────────────────── A. 反查表（正样本） ─────────────────────────

console.log('\n── A. PickLine 与图元同源产出，部件解析正确 ──');

const unitCount = cab0.layout.units.length;
// Task #48：分区线现在在**两张图**上都登记了（正视图 + 俯视图），所以按视图分别断言。
// 顺带锁死一条结构性不变量：多视图 ≠ 多真相 —— 两张图上的同一条线必须指向同一个写路径。
const divFront = byPart('unit.divider').filter((d) => d.view === 'front');
const divTop = byPart('unit.divider').filter((d) => d.view === 'top');
ok('每个分区之间的中立板都有一条 unit.divider（正视图）', divFront.length === unitCount - 1, `${divFront.length} vs ${unitCount - 1}`);
ok('俯视图上同一批分区线也在（多视图反查）', divTop.length === unitCount - 1, `${divTop.length} vs ${unitCount - 1}`);
ok(
  '正/俯两图上的分区线指向**同一个写路径**（多视图不是多真相）',
  divFront.map((d) => d.paramPath).join('|') === divTop.map((d) => d.paramPath).join('|'),
  `${divFront.map((d) => d.paramPath).join('|')} ≠ ${divTop.map((d) => d.paramPath).join('|')}`
);
ok(
  '分区线的参数路径逐条对上（第 i 条 → layout.units[i].requestedWidth）',
  byPart('unit.divider').every((pl) => {
    const m = /layout\.units\[(\d+)\]/.exec(pl.paramPath);
    return m !== null && byPart('unit.divider').some((x) => x.paramPath === `layout.units[${m![1]}].requestedWidth`);
  }),
  JSON.stringify(byPart('unit.divider').map((x) => x.paramPath))
);
ok('外轮廓 → params.width（AI 改的就是这条写路径）', byPart('outer.width').every((x) => x.paramPath === 'params.width'));
ok('踢脚线 → params.bodyLift', byPart('bodyLift').length >= 1 && byPart('bodyLift').every((x) => x.paramPath === 'params.bodyLift'));
ok(
  '门缝只出现在"门扇数 > 1"的分区上（门扇数 ≤ 1 没有中缝，不许编出来）',
  byPart('door.gapMid').every((pl) => {
    const u = cab0.layout.units[pl.unitIndex];
    return Boolean(u?.doors && u.doors.count > 1);
  })
);
ok(
  '层板线只出现在有层板的分区上，路径指向 shelves.count（改层板 = 攂数量，不是挪线）',
  byPart('shelf.line').every((pl) => Boolean(cab0.layout.units[pl.unitIndex]?.shelves) && pl.paramPath.endsWith('shelves.count'))
);
ok('部件中文名齐全（界面上要直接给人看）', PL.every((x) => x.labelZh === PART_ZH[x.part] && x.labelZh.length > 0));

ok(
  'PickLine 点位落在对应视图的图幅里（同源生成的结构证明：点位不在图上 = 和图元不是一份）',
  PL.every((pl) => {
    const bb = vs.meta[pl.view].bbox;
    const inside = (pt: { x: number; y: number }): boolean =>
      pt.x >= bb.min.x - 1 && pt.x <= bb.max.x + 1 && pt.y >= bb.min.y - 1 && pt.y <= bb.max.y + 1;
    return pl.pts.every(inside);
  })
);

// ───────────────────────── B. 负样本：反查不许错 ─────────────────────────

console.log('\n── B. 反查负样本：踢脚线不许解析成 height ──');

ok('踢脚线的参数路径必须是 params.bodyLift（文档点名的负样本）', partParamPath('bodyLift', 0) === 'params.bodyLift');
ok('踢脚线的参数路径绝不是 params.height', partParamPath('bodyLift', 0) !== 'params.height');
ok('外轮廓(宽)不许解析成 height', partParamPath('outer.width', 0) === 'params.width' && partParamPath('outer.width', 0) !== 'params.height');
ok('层板线的路径不许指向 drawers（层板和抽屉是两种部件）', !partParamPath('shelf.line', 0).includes('drawers'));

// hitPart：贴线命中、离线不命中
const leftEdge = byPart('outer.width')[0];
const nearPt = { x: leftEdge.pts[0].x + 1, y: (leftEdge.pts[0].y + leftEdge.pts[1].y) / 2 };
const hit1 = hitPart(PL, nearPt, 20);
ok('贴近左边框命中 outer.width（命中测试贴的是屏幕上那条线）', hit1?.part === 'outer.width' && hit1.cabinetId === cab0.id, JSON.stringify(hit1 && { part: hit1.part, path: hit1.paramPath }));
const farPt = { x: vs.meta.front.bbox.max.x + 5000, y: vs.meta.front.bbox.max.y + 5000 };
ok('离线远处命中为 null（不硬凑）', hitPart(PL, farPt, 20) === null);

// ───────────────────────── C. 编译器一致性（A4） ─────────────────────────

console.log('\n── C. 编译器：AI 说话与动手必须是同一件事 ──');

const act = (a: Partial<AiAction>): AiAction => ({
  action: 'cabinet.setBodyLift',
  target: { cabinetName: cab0.name },
  params: {},
  reason: '',
  index: 0,
  ...a,
});

// 正样本：点踢脚线 → 改 bodyLift
const c1 = compileAction(act({ action: 'cabinet.setBodyLift', params: { mm: 120 } }), proj, rules);
ok('点选踢脚线 + 改 bodyLift → 编译通过', c1.ok);
ok('编译出的命令确实只改 params.bodyLift', c1.ok && c1.command.changes.every((c) => c.path === 'params.bodyLift'), JSON.stringify(c1.ok ? c1.command.changes.map((c) => c.path) : c1));

// 负样本 1：说改踢脚线，动手改高度 —— 拒绝
const c2 = compileAction(
  act({ action: 'cabinet.resize', target: { cabinetName: cab0.name, part: 'bodyLift' }, params: { height: 2600 } }),
  proj,
  rules
);
ok('点选踢脚线却改 height → 拒绝（说的和做的不一致）', !c2.ok && /不符/.test(c2.error), c2.ok ? '竟然通过了' : c2.error);

// 负样本 2：部件不存在 → 报候选清单
const noShelf: Cabinet = structuredClone(cab0);
noShelf.id = 'cab_noshelf';
noShelf.name = '无层板柜';
noShelf.layout = {
  type: 'row',
  widthMode: 'fit_total',
  // 注意：kind='hanging' 会自带一块顶层层板（docFactory 的既定结构），构造"无层板"必须用 open
  units: [makeUnit({ kind: 'open', requestedWidth: 1200, takenIds: [], rules })],
};
const projN = structuredClone(proj);
projN.cabinets.push(noShelf);
const c3 = compileAction(
  act({ action: 'cabinet.setUnitParam', target: { cabinetName: noShelf.name, part: 'shelf.line' }, params: { param: 'shelves.count', value: 3 } }),
  projN,
  rules
);
ok('在"没有层板的柜体"上点层板线 → 拒绝并列出现有部件（不许静默改别的）', !c3.ok && /现有/.test(c3.error), c3.ok ? '通过' : c3.error);

// 负样本 3：多处命中且未指明分区
const c4 = compileAction(act({ action: 'cabinet.setUnitWidth', target: { cabinetName: cab0.name, part: 'unit.divider' }, params: { width: 800 } }), proj, rules);
if (unitCount - 1 > 1) {
  ok('部件有多处且未指明 unit → 要求指明（不许替用户猜）', !c4.ok && /target\.unit/.test(c4.error), c4.ok ? '通过' : c4.error);
} else {
  ok('部件唯一处命中 → 直接解析', c4.ok);
}
// 指明之后能解析到具体分区
const c5 = compileAction(act({ action: 'cabinet.setUnitWidth', target: { cabinetName: cab0.name, part: 'unit.divider', unit: 1 }, params: { width: 800 } }), proj, rules);
ok('指明 unit 后编译通过，路径 = layout.units[0].requestedWidth', c5.ok && c5.command.changes.some((c) => c.path === 'layout.units[0].requestedWidth'), c5.ok ? JSON.stringify(c5.command.changes.map((c) => c.path)) : c5.error);

// ───────────────────────── D. 契约校验（A3） ─────────────────────────

console.log('\n── D. 契约：part 闭合词汇表 / scope 只有 selection / 坐标整条拒收 ──');

const v1 = validateAction({ action: 'cabinet.setBodyLift', target: { cabinetName: cab0.name, part: 'bodyLift' }, params: { mm: 120 } });
ok('合法 part 通过契约校验', v1.ok);
const v2 = validateAction({ action: 'cabinet.setBodyLift', target: { cabinetName: cab0.name, part: 'outer.foo' }, params: { mm: 120 } });
ok('契约外部件名整条拒收', !v2.ok && v2.code === 'BAD_PART', JSON.stringify(v2));
const v3 = validateAction({ action: 'cabinet.setBodyLift', target: { scope: 'area' }, params: { mm: 120 } });
ok('scope 只允许 "selection"', !v3.ok && v3.code === 'BAD_SCOPE', JSON.stringify(v3));
const v4 = validateAction({
  action: 'cabinet.setBodyLift',
  target: { cabinetName: cab0.name, part: 'bodyLift', scope: 'selection' },
  params: { mm: 120 },
});
ok('part 与 scope 同现 → 拒收（点选与圈选互斥）', !v4.ok && v4.code === 'PART_SCOPE_CLASH', JSON.stringify(v4));
const v5 = validateAction({
  action: 'cabinet.setBodyLift',
  target: { cabinetName: cab0.name, rect: [0, 0, 100, 100] } as Record<string, unknown>,
  params: { mm: 120 },
});
ok('target.rect（坐标！）被白名单拒收 —— AI 永远不许拿到坐标', !v5.ok && v5.code === 'EXTRA_TARGET_KEY', JSON.stringify(v5));
// Task #48：加了 outer.depth（侧/俯视图上那两条框架边）之后是 8 个。
// 这条断言的意义是"词汇表必须闭合"—— 每加一个部件都必须同步到契约与反查层，
// 所以数字必须写死，不能写成 PARTS.size === PARTS.size 那种自我实现的断言。
ok('契约的 PARTS 是闭合的（8 个部件名，7 类语义）', PARTS.size === 8, String(PARTS.size));
ok('新增的 outer.depth 在契约里 —— 否则界面只能偷偷按坐标改进深（第二个真相源）', PARTS.has('outer.depth'), [...PARTS].join(','));
ok('outer.depth 的写路径是 params.depth（不是任何派生字段）', partParamPath('outer.depth', 0) === 'params.depth', partParamPath('outer.depth', 0));

// ───────────────────────── E. planRunner：圈选展开 + 影响面（A5） ─────────────────────────

console.log('\n── E. planRunner：圈选展开成逐柜动作 / 影响面来自真实派生对比 ──');

// 造一个双柜项目
const bus2 = new CommandBus(sampleProject(rules), rules);
const cabB = makeCabinet({
  name: '次卧衣柜',
  roomId: bus2.getState().rooms[0].id,
  x: 3600,
  y: 60,
  rotation: 0,
  rules,
  params: { width: 1600 },
  takenIds: bus2.getState().cabinets.map((c) => c.id),
});
bus2.execute({ id: 'cmd_test_add', op: 'cabinet.create', source: 'system', changes: [], payload: { cabinet: cabB } });
const twoIds = bus2.getState().cabinets.map((c) => c.id);
ok('测试项目里有两个柜体', twoIds.length === 2, String(twoIds.length));

const scopeAction: AiAction = {
  action: 'cabinet.setBodyLift',
  target: { scope: 'selection' },
  params: { mm: 150 },
  reason: '',
  index: 0,
};
const runE = dryRunPlan({ bus: bus2, actions: [scopeAction], selection: twoIds });
ok(`圈选 2 个柜体 → 展开成 2 步（每步落成具体 cabinetId）`, runE.steps.length === 2 && runE.steps.every((s) => s.action.target?.cabinetId !== undefined), JSON.stringify(runE.steps.map((s) => s.action.target)));
ok('展开后的每一步都能编译执行', runE.errorCount === 0, JSON.stringify(runE.steps.filter((s) => !s.ok).map((s) => s.error)));
ok('圈选改踢脚 → 影响面里有"分区净宽"变化（踢脚变 → 内空变 → 板件尺寸重排）', runE.impact.length > 0, JSON.stringify(runE.impact));

const runEmpty = dryRunPlan({ bus: bus2, actions: [scopeAction], selection: [] });
ok('圈选为空 → 如实报错（不静默跳过）', runEmpty.steps.length === 1 && !runEmpty.steps[0].ok && /圈选/.test(runEmpty.steps[0].error ?? ''), runEmpty.steps[0]?.error ?? '');

const runNoop = dryRunPlan({ bus: bus2, actions: [{ action: 'cabinet.rename', target: { cabinetId: twoIds[0] }, params: { name: bus2.getState().cabinets[0].name }, reason: '', index: 0 }] });
ok('无实质变更的计划 → 影响面为空（不编造影响）', runNoop.impact.length === 0, JSON.stringify(runNoop.impact));

const runResize = dryRunPlan({ bus: bus2, actions: [{ action: 'cabinet.resize', target: { cabinetId: twoIds[0] }, params: { width: 1800 }, reason: '', index: 0 }] });
ok('改宽 → 影响面给出该柜体的净宽重排（前后两次真实派生对比，不是静态表）', runResize.impact.some((l) => l.includes('主卧衣柜') && /净宽/.test(l)), JSON.stringify(runResize.impact));

// ───────────────────────── 汇总 ─────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (fail === 0) {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log('点选/圈选局部编辑成立：反查表与几何同源、负样本全绿、AI 改的路径与点选的部件严格一致。');
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log(`失败项：${failures.join('、')}`);
  process.exitCode = 1;
}
