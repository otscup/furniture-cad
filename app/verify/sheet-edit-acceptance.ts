/**
 * ══════════════════════════════════════════════════════════════════════
 *  图纸四视图编辑验收（Task #48）
 *
 *  ── 这一组断言守的是什么 ──
 *    "四视图上拖一条线"听起来是界面活儿，但真正的风险在语义层：
 *    ① 拖的是不是**语义参数**（而不是偷偷改了图元坐标）
 *    ② 在**任意一张图**上改同一个尺寸，结果是不是同一个数、写的是不是同一条路径
 *    ③ 改完之后**其余三张图是否跟着一起变**（派生视图的一致性）
 *    ④ 拖不动的时候是不是**给出了理由**（静默无反应是最伤信任的）
 *
 *  所以这里既有正样本，也有"这条不该能拖 / 超区间必须夹住"的负样本。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import type { Cabinet, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { dragPlanOf, dragValueOf, dragClamped } from '../src/viewport/sheetDrag.ts';
import type { PickLine } from '../src/core/geometry/pickLines.ts';
import { hitPart } from '../src/viewport/hitTest.ts';

let pass = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const section = (t: string): void => console.log(`\n── ${t} ──`);

const rules: RuleSet = JSON.parse(readFileSync('src/core/ruleset/factory-default.json', 'utf8'));

function project() {
  const p = sampleProject(rules);
  const bus = new CommandBus(p, rules);
  return bus;
}

/** 按 {view, part, edge} 精确取一条可点线 */
function line(bus: CommandBus, view: PickLine['view'], part: PickLine['part'], edge?: 'min' | 'max'): PickLine | null {
  const all = bus.derive().geom.views.pickLines;
  return all.find((l) => l.view === view && l.part === part && (edge === undefined || l.edge === edge)) ?? null;
}

function cabinetOf(bus: CommandBus, id: string): Cabinet {
  const c = bus.getState().cabinets.find((x) => x.id === id);
  if (!c) throw new Error(`找不到柜体 ${id}`);
  return c;
}

console.log('\n═══ 图纸四视图编辑（sheet-edit）═══');

// ───────────────────────── A. 反查层覆盖四张图 ─────────────────────────
section('A. 四张图上都有可点线，且命中测试真能命中');
{
  const bus = project();
  const cab = bus.getState().cabinets[0];
  const all = bus.derive().geom.views.pickLines;
  for (const v of ['front', 'side', 'top', 'internal'] as const) {
    ok(`${v} 视图登记了可点线`, all.some((l) => l.view === v && l.cabinetId === cab.id), String(all.filter((l) => l.view === v).length));
  }

  // 命中测试用**线上真实的一点**去打：确保 pickLines 的点位与图元同源（不是另算一套）
  const widthMax = line(bus, 'front', 'outer.width', 'max');
  ok('正视图右外轮廓存在', Boolean(widthMax));
  if (widthMax) {
    const mid = { x: (widthMax.pts[0].x + widthMax.pts[1].x) / 2, y: (widthMax.pts[0].y + widthMax.pts[1].y) / 2 };
    const hit = hitPart(all, mid, 6);
    ok('取线段中点做命中测试 → 命中的就是那条线', hit !== null && hit.part === 'outer.width' && hit.edge === 'max', hit ? `${hit.view}/${hit.part}/${hit.edge}` : 'null');
  }
  const depthMax = line(bus, 'side', 'outer.depth', 'max');
  ok('侧视图能拿到"前边 = 柜深"这条线（没有它就只能偷偷按坐标改）', Boolean(depthMax));
}

// ───────────────────────── B. 拖动 → 语义参数 ─────────────────────────
section('B. 拖动改的是语义参数，走的是唯一写入口');
{
  const bus = project();
  const cabId = bus.getState().cabinets[0].id;
  const cab = cabinetOf(bus, cabId);
  const w0 = cab.params.width;

  const pl = line(bus, 'front', 'outer.width', 'max')!;
  const plan = dragPlanOf(pl);
  ok('正视图右外轮廓 → 可拖', plan.ok, plan.ok ? '' : plan.reason);
  if (!plan.ok) throw new Error('不该到这');
  ok('拖动轴是 x（宽度轴）且符号为正', plan.spec.axis === 'x' && plan.spec.sign === 1, `${plan.spec.axis}/${plan.spec.sign}`);

  const v = dragValueOf(plan.spec, cab, { x: 0, y: 0 }, { x: 200, y: 0 });
  ok('右移 200mm → 柜宽 +200（整数 mm，无浮点）', v === w0 + 200, `${v} vs ${w0 + 200}`);

  const cmd = plan.spec.build(cab, pl.unitIndex, v);
  ok('产出的是 cabinet.resize 命令、写 params.width', cmd.op === 'cabinet.resize' && cmd.changes.some((c) => c.path === 'params.width' && c.value === v), JSON.stringify(cmd.changes));

  const r = bus.execute(cmd, { commitLabel: '验收：改柜宽' });
  ok('命令被总线接受（真实管线，含规则校验）', r.ok, r.error ?? '');
  ok('模型里柜宽真的变了', cabinetOf(bus, cabId).params.width === v, String(cabinetOf(bus, cabId).params.width));
}

// ───────────────────────── C. 改一张图，四张图一起变 ─────────────────────────
section('C. 在任意一张图上改 → 其余三张图同步（派生一致性）');
{
  const bus = project();
  const cabId = bus.getState().cabinets[0].id;
  const before = bus.derive().geom.views;
  const wBefore = before.bbox ? before.bbox.max.x - before.bbox.min.x : 0;

  // 在**俯视图**上改柜宽（不是正视图）：这是最容易出错的地方
  const pl = line(bus, 'top', 'outer.width', 'max')!;
  const plan = dragPlanOf(pl);
  ok('俯视图右外轮廓 → 可拖', plan.ok, plan.ok ? '' : plan.reason);
  if (!plan.ok) throw new Error('不该到这');
  const cab = cabinetOf(bus, cabId);
  const v = dragValueOf(plan.spec, cab, { x: 0, y: 0 }, { x: 300, y: 0 });
  const r = bus.execute(plan.spec.build(cab, pl.unitIndex, v), { commitLabel: '验收：俯视图改宽' });
  ok('俯视图改宽被接受', r.ok, r.error ?? '');

  const after = bus.derive().geom.views;
  const wAfter = after.bbox ? after.bbox.max.x - after.bbox.min.x : 0;
  // 注意不能断言"包围盒正好 +300"：图幅里侧视图/尺寸链排在正视图右侧，
  // 正视图变宽会把它们一起右推，包围盒涨得更多。这是**排布**的后果，不是 bug。
  ok('图幅包围盒确实变宽了（≥ +300mm，右侧图元被推着走）', wAfter - wBefore >= 300, `${wBefore} → ${wAfter}`);

  // 真正的精确不变量：正视图上"左右两条外轮廓线的跨度" === 柜宽
  const fMin = line(bus, 'front', 'outer.width', 'min')!;
  const fMax = line(bus, 'front', 'outer.width', 'max')!;
  ok('正视图左右外轮廓的跨度 === 柜宽（图与模型说同一个数）',
    Math.abs(fMax.pts[0].x - fMin.pts[0].x - cabinetOf(bus, cabId).params.width) <= 1,
    `span=${fMax.pts[0].x - fMin.pts[0].x} width=${cabinetOf(bus, cabId).params.width}`);

  // 同一个部件在正视图上也必须跟着走：多视图 = 同一份模型的不同投影
  const frontW = line(bus, 'front', 'outer.width', 'max')!;
  const topW = line(bus, 'top', 'outer.width', 'max')!;
  ok('正视图与俯视图的宽度线都落在新的柜宽上（两张图说同一个数）',
    Math.abs((frontW.pts[0].x - topW.pts[0].x)) <= 1 && Math.abs(v - cabinetOf(bus, cabId).params.width) <= 0.001,
    `front=${frontW.pts[0].x} top=${topW.pts[0].x} model=${cabinetOf(bus, cabId).params.width}`);
}

// ───────────────────────── D. 进深：侧视图与俯视图方向相反 ─────────────────────────
section('D. 柜深在侧/俯两张图上都能改，且方向相反仍得到同一个数');
{
  const bus = project();
  const cabId = bus.getState().cabinets[0].id;
  const cab = cabinetOf(bus, cabId);
  const d0 = cab.params.depth;

  const bySide = dragPlanOf(line(bus, 'side', 'outer.depth', 'max')!);
  const byTop = dragPlanOf(line(bus, 'top', 'outer.depth', 'max')!);
  ok('侧视图可改深（横向轴）', bySide.ok && bySide.spec.axis === 'x' && bySide.spec.sign === 1, bySide.ok ? `${bySide.spec.axis}/${bySide.spec.sign}` : bySide.reason);
  ok('俯视图可改深（纵向轴，符号为负 —— 俯视图进深轴是反的）', byTop.ok && byTop.spec.axis === 'y' && byTop.spec.sign === -1, byTop.ok ? `${byTop.spec.axis}/${byTop.spec.sign}` : byTop.reason);

  if (bySide.ok && byTop.ok) {
    // 侧视图：前边在右侧，向右拖（远离后边）→ 深 +60
    const vs = dragValueOf(bySide.spec, cab, { x: 0, y: 0 }, { x: 60, y: 0 });
    ok('侧视图右拖 +60 → 深 +60', vs === d0 + 60, `${vs} vs ${d0 + 60}`);
    // 俯视图：前边画在**下方**（y = ty0 - Y），所以向下拖（世界 y 减小）才是加深。
    // 这两条一起验的是"反向轴换算正确"—— 最怕的就是一张图上往反方向变。
    const vt = dragValueOf(byTop.spec, cab, { x: 0, y: 0 }, { x: 0, y: -60 });
    ok('俯视图下拖 -60 → 深 +60（进深轴反向，换算必须跟着反）', vt === d0 + 60, `${vt} vs ${d0 + 60}`);
    const vt2 = dragValueOf(byTop.spec, cab, { x: 0, y: 0 }, { x: 0, y: 60 });
    ok('俯视图上拖 +60 → 深 -60（同一次换算的反向验证）', vt2 === d0 - 60, `${vt2} vs ${d0 - 60}`);
  }
}

// ───────────────────────── E. 分区分界：总宽不变 ─────────────────────────
section('E. 拖动分区分界：此消彼长，总宽不变，一条命令两个变化');
{
  const bus = project();
  const cabId = bus.getState().cabinets[0].id;
  const cab = cabinetOf(bus, cabId);
  const pl = line(bus, 'front', 'unit.divider')!;
  const plan = dragPlanOf(pl);
  ok('分区线可拖', plan.ok, plan.ok ? '' : plan.reason);
  if (plan.ok) {
    const i = pl.unitIndex;
    const sumBefore = cab.layout.units.reduce((s, u) => s + u.requestedWidth, 0);
    const v = dragValueOf(plan.spec, cab, { x: 0, y: 0 }, { x: 120, y: 0 });
    const cmd = plan.spec.build(cab, i, v);
    ok('一条命令同时改左右两个分区（不允许出现"一边改了另一边没改"）',
      cmd.changes.length === 2 && cmd.changes[0].path === `layout.units[${i}].requestedWidth` && cmd.changes[1].path === `layout.units[${i + 1}].requestedWidth`,
      JSON.stringify(cmd.changes.map((c) => c.path)));
    const r = bus.execute(cmd, { commitLabel: '验收：拖分区分界' });
    ok('分区分界命令被接受', r.ok, r.error ?? '');
    const after = cabinetOf(bus, cabId);
    const sumAfter = after.layout.units.reduce((s, u) => s + u.requestedWidth, 0);
    ok('两分区请求宽之和不变（总宽没有被偷偷改掉）', sumAfter === sumBefore, `${sumBefore} → ${sumAfter}`);
    ok('左分区确实变宽了', after.layout.units[i].requestedWidth !== cab.layout.units[i].requestedWidth, `${cab.layout.units[i].requestedWidth} → ${after.layout.units[i].requestedWidth}`);
  }
}

// ───────────────────────── F. 负样本：拖不动的、越界的 ─────────────────────────
section('F. 负样本：基准边不可拖、离散部件不可拖、越界必须夹住');
{
  const bus = project();
  const cab = cabinetOf(bus, bus.getState().cabinets[0].id);

  for (const [view, part] of [['front', 'outer.width'], ['side', 'outer.height'], ['side', 'outer.depth']] as const) {
    const plan = dragPlanOf(line(bus, view, part, 'min')!);
    ok(`${view} 图 ${part} 的基准边（min）不可拖 —— 且给出了理由`, !plan.ok && plan.reason.length > 0, plan.ok ? '竟然可拖' : plan.reason);
  }

  const shelf = dragPlanOf(line(bus, 'internal', 'shelf.line') ?? ({} as PickLine));
  if (line(bus, 'internal', 'shelf.line')) {
    ok('层板线不可拖（它是数量派生的），且理由指明该去哪里改', !shelf.ok && /数量/.test(shelf.reason), shelf.ok ? '竟然可拖' : shelf.reason);
  } else {
    ok('（本样例无层板线，跳过）', true);
  }

  const widthPlan = dragPlanOf(line(bus, 'front', 'outer.width', 'max')!);
  if (widthPlan.ok) {
    const huge = dragValueOf(widthPlan.spec, cab, { x: 0, y: 0 }, { x: 99999, y: 0 });
    ok('拖过头 → 夹到区间上限（不是写进一个荒唐值）', huge === widthPlan.spec.max, String(huge));
    ok('夹取时 dragClamped 为真（界面据此提示"已到边界"）', dragClamped(widthPlan.spec, huge), String(huge));
    const tiny = dragValueOf(widthPlan.spec, cab, { x: 0, y: 0 }, { x: -99999, y: 0 });
    ok('反向拖过头 → 夹到区间下限', tiny === widthPlan.spec.min, String(tiny));
  }

  // 部件与视图不匹配时不许乱拖
  const wrongView = dragPlanOf({ ...line(bus, 'front', 'outer.width', 'max')!, view: 'internal' } as PickLine);
  ok('把"柜宽线"放到内部图上 → 拒绝（部件与视图必须匹配）', !wrongView.ok, wrongView.ok ? '竟然可拖' : wrongView.reason);
}

console.log(`\n═══ 图纸四视图编辑：通过 ${pass} 项，失败 ${fails.length} 项 ═══`);
if (fails.length > 0) {
  console.log('\n失败项：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log('四视图编辑成立：拖动写的是语义参数、多视图同源、不可拖的都给了理由。');
