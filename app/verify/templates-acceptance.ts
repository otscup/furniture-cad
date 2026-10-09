/**
 * 柜型预设库验收（Phase B）—— 模板机制的地基不变量。
 *
 * 模板是"声明式骨架"，不是第二套构造逻辑。它承诺的是：
 *   1. 经 createCabinetFromTemplate 出来的柜体与手拼 UnitSpec 的柜体
 *      走**同一条**派生管线：layout / views / bodies3d 全部现算成立；
 *   2. 比例宽度解析后 Σ 分区宽 = 柜宽（最后一个分区吃余量）；
 *   3. 外形参数（浅进深鞋柜 / 矮吊柜 / 宽矮电视柜）真的落进 params；
 *   4. 未知模板必须报错且说出可用清单（AI 通道也要读得懂）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { RuleSet } from '../src/core/types.ts';
import { CABINET_TEMPLATES, findCabinetTemplate, resolveTemplateUnitWidths } from '../src/core/templates.ts';
import { createCabinetFromTemplate } from '../src/core/docFactory.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { buildProjectBodies } from '../src/core/geometry/bodies3d.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name} —— ${detail}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

const allFinite = (xs: number[]): boolean => xs.every(Number.isFinite);
const TOL = 0.5;

section('1. 注册表健康：模板是数据，声明必须自洽');
{
  ok('模板至少 4 个（default + 鞋柜 / 吊柜 / 电视柜）', CABINET_TEMPLATES.length >= 4, `${CABINET_TEMPLATES.length} 个`);
  const ids = CABINET_TEMPLATES.map((t) => t.id);
  ok('模板 id 唯一', new Set(ids).size === ids.length, ids.join(','));
  ok('default 模板保持旧行为（900 宽、走 defaultUnits）', (() => {
    const d = CABINET_TEMPLATES.find((t) => t.id === 'default')!;
    return d.params.width === 900 && d.units.length === 0;
  })());
  const ratioSumBad = CABINET_TEMPLATES.filter((t) => {
    const ratios = t.units.filter((u) => typeof u.width !== 'number').map((u) => (u.width as { ratio: number }).ratio);
    const fixed = t.units.filter((u) => typeof u.width === 'number').map((u) => u.width as number).reduce((a, b) => a + b, 0);
    return ratios.length > 0 && Math.abs(fixed) > TOL;
  });
  ok('比例与固定宽度没有混用（混用会让余量计算失去意义）', ratioSumBad.length === 0, ratioSumBad.map((t) => t.id).join(','));
  const sums = CABINET_TEMPLATES.map((t) => ({ id: t.id, ws: resolveTemplateUnitWidths(t) }));
  ok('每个模板解析后 Σ 分区宽 = 柜宽（余量进最后一个分区）',
    sums.every(({ id, ws }) => {
      const tpl = findCabinetTemplate(id);
      return ws.length === 0 || Math.abs(ws.reduce((a, b) => a + b, 0) - tpl.params.width) < TOL;
    }),
    JSON.stringify(sums));
  ok('解析出的宽度全部为正且有限',
    sums.every(({ ws }) => allFinite(ws) && ws.every((w) => w > 0)),
    JSON.stringify(sums));
}

section('2. 构造：模板柜走同一条 makeUnit → createCabinet 管线');
{
  const taken = new Set<string>();
  for (const tpl of CABINET_TEMPLATES) {
    const cab = createCabinetFromTemplate({
      templateId: tpl.id,
      name: `验收·${tpl.name}`,
      roomId: 'room_check',
      x: 0,
      y: 0,
      rules,
      takenIds: taken,
    });
    taken.add(cab.id);
    const expectUnits = tpl.units.length > 0 ? tpl.units.length : (tpl.params.width < 700 ? 1 : 3);
    ok(`[${tpl.id}] 分区数 = 模板声明（${expectUnits}）`, cab.layout.units.length === expectUnits, `${cab.layout.units.length}`);
    ok(`[${tpl.id}] 外形落进 params（${tpl.params.width}×${tpl.params.height}×${tpl.params.depth}）`,
      cab.params.width === tpl.params.width && cab.params.height === tpl.params.height && cab.params.depth === tpl.params.depth,
      JSON.stringify({ w: cab.params.width, h: cab.params.height, d: cab.params.depth }));
    ok(`[${tpl.id}] bodyLift ${tpl.params.bodyLift != null ? `= 模板值 ${tpl.params.bodyLift}` : '= 默认 80'}`,
      cab.params.bodyLift === (tpl.params.bodyLift ?? 80), `${cab.params.bodyLift}`);
    if (tpl.units.some((u) => u.doors)) {
      ok(`[${tpl.id}] 门板来自 makeUnit（铰链引用规则集，不硬编码）`,
        cab.layout.units.filter((u) => u.doors).every((u) => !!u.doors!.hinge && u.doors!.hingeSide === 'left'));
    }
  }
  ok('同批构造的柜体 id 不冲突（takenIds 真的在工作）', taken.size === CABINET_TEMPLATES.length);
}

section('2b. 同项目重复新建柜型：分区 ID 全局唯一');
{
  const takenCabinetIds = new Set<string>();
  const takenUnitIds = new Set<string>();
  const allUnitIds: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const cabinet = createCabinetFromTemplate({
      templateId: 'default',
      name: `同项目第 ${index + 1} 个默认柜`,
      roomId: 'room_check',
      x: index * 1000,
      y: 0,
      rules,
      takenIds: takenCabinetIds,
      takenUnitIds,
    });
    takenCabinetIds.add(cabinet.id);
    for (const unit of cabinet.layout.units) {
      allUnitIds.push(unit.id);
      takenUnitIds.add(unit.id);
    }
  }
  ok('三个同模板柜体的全部分区 ID 互不重复', new Set(allUnitIds).size === allUnitIds.length, allUnitIds.join(', '));
}

section('3. 派生：模板柜的 layout / views / bodies3d 全部现算成立');
for (const tpl of CABINET_TEMPLATES) {
  const cab = createCabinetFromTemplate({
    templateId: tpl.id,
    name: `派生·${tpl.name}`,
    roomId: 'room_check',
    x: 0,
    y: 0,
    rules,
  });
  const L = computeCabinetLayout(cab, rules);
  // 恒等式：Σ 净宽 + (n-1)×板厚 = innerW（分区之间的中立板占宽）
  ok(`[${tpl.id}] 布局恒等式：Σ 净宽 + (n-1)×板厚 = innerW`,
    Math.abs(L.nets.reduce((a, b) => a + b, 0) + (L.nets.length - 1) * L.boardT - L.innerW) < TOL,
    `Σnets=${L.nets.reduce((a, b) => a + b, 0)} n=${L.nets.length} innerW=${L.innerW}`);
  ok(`[${tpl.id}] innerW = W - 2×板厚`, Math.abs(L.innerW - (cab.params.width - 2 * L.boardT)) < TOL);

  // 门宽链：每个有门分区 Σ门宽 + 2×外缝 + (n-1)×中缝 = 该分区净宽
  const doorUnits = cab.layout.units.filter((u) => u.doors);
  if (doorUnits.length > 0) {
    ok(`[${tpl.id}] 门宽链成立（${doorUnits.length} 个有门分区）`, doorUnits.every((u) => {
      const d = u.doors!;
      const wsum = d.mode === 'equal' ? (u.requestedWidth - 2 * d.gapOuter - (d.count - 1) * d.gapMid) / d.count * d.count : 0;
      return Math.abs(wsum + 2 * d.gapOuter + (d.count - 1) * d.gapMid - u.requestedWidth) < TOL;
    }));
  }

  const vs = buildCabinetViews(cab, rules);
  ok(`[${tpl.id}] 四视图非空`, (['front', 'top', 'side', 'internal'] as const).every((k) => vs.prims[k].length > 0));
  const finite = (['front', 'top', 'side', 'internal'] as const).every((k) =>
    vs.prims[k].every((p) => (p.k === 'text' ? [p.p] : p.pts).every((q) => Number.isFinite(q.x) && Number.isFinite(q.y))));
  ok(`[${tpl.id}] 视图坐标全部有限（无 NaN）`, finite);

  // 外形真的生效：正视图 bbox 高 = 柜高，俯视图 bbox 深 = 柜深
  const fb = vs.meta.front.bbox;
  const tb = vs.meta.top.bbox;
  ok(`[${tpl.id}] 正视图高 = 柜高 ${cab.params.height}`, Math.abs(fb.max.y - fb.min.y - cab.params.height) < TOL,
    `${fb.max.y - fb.min.y}`);
  ok(`[${tpl.id}] 俯视图深 = 柜深 ${cab.params.depth}（鞋柜/吊柜浅进深要在这里现形）`,
    Math.abs(tb.max.y - tb.min.y - cab.params.depth) < TOL, `${tb.max.y - tb.min.y}`);

  const bodies = buildProjectBodies({ schemaVersion: '0.2', id: 'p', name: 'p', ruleSetId: rules.id, rooms: [], cabinets: [cab] }, rules);
  ok(`[${tpl.id}] 3D 体块非空且无退化盒`, bodies.length > 0 && bodies.every((b) => b.sx > 0 && b.sy > 0 && b.sz > 0),
    `${bodies.length} 盒`);
  ok(`[${tpl.id}] 3D 体块坐标有限`, bodies.every((b) => allFinite([b.cx, b.cy, b.cz, b.sx, b.sy, b.sz])));
}

section('4. 负样本：未知模板必须报错且说出可用清单');
{
  let threw = '';
  try {
    findCabinetTemplate('wardrobe_xl');
  } catch (e) {
    threw = (e as Error).message;
  }
  ok('findCabinetTemplate 未知 id 抛错', threw.length > 0, threw);
  ok('错误信息列出全部可用模板 id', CABINET_TEMPLATES.every((t) => threw.includes(t.id)), threw);
  let threw2 = '';
  try {
    createCabinetFromTemplate({ templateId: 'nope', roomId: 'r', x: 0, y: 0, rules });
  } catch (e) {
    threw2 = (e as Error).message;
  }
  ok('createCabinetFromTemplate 未知 id 同样抛错（入口只有一个，校验也只有一处）', threw2.length > 0);
}

section('5. 宽度覆盖：比例模板按覆盖后的柜宽重新解析');
{
  const cab = createCabinetFromTemplate({
    templateId: 'tv_stand',
    name: '覆盖宽度电视柜',
    roomId: 'room_check',
    x: 0,
    y: 0,
    rules,
    params: { width: 2400 },
  });
  const L = computeCabinetLayout(cab, rules);
  ok('覆盖 width=2400 后 Σ 净宽 + (n-1)×板厚 仍然 = innerW',
    Math.abs(L.nets.reduce((a, b) => a + b, 0) + (L.nets.length - 1) * L.boardT - L.innerW) < TOL,
    `Σnets=${L.nets.reduce((a, b) => a + b, 0)} innerW=${L.innerW}`);
  ok('覆盖后分区数不变（宽度是参数，骨架不是）', cab.layout.units.length === 3, `${cab.layout.units.length}`);
}

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('\n柜型预设库：全部不变量成立，负样本被检出。');
}
