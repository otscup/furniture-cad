import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Project, RuleSet, UnitSpec } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, createWall, emptyProject, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import * as CMD from '../src/core/commands.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { getCabinetFootprint } from '../src/core/geometry/generate.ts';
import { placeAgainstNearestWall } from '../src/core/snapPlace.ts';
import { validateCabinet } from '../src/core/rules/validate.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  Phase 1 地基验收（主方案 §L12 第 1 步）
 *
 *  验收的不是"能跑"，而是下面这些不变量：
 *   1. 示例模型派生 + 校验：恒等式断言 0 ERROR
 *   2. 写路径白名单真的拦得住派生字段与越权 op
 *   3. 值域夹紧会回报，而不是静默改
 *   4. 【预览 === 提交】：同一条命令，preview 与 execute 得到逐字节相同的模型
 *   5. 每一个变更操作，undo 后与操作前逐字节一致；redo 后与操作后逐字节一致
 *   6. 结构性变更（建/删柜体、增删分区、画墙、建房间）同样满足第 5 条
 *   7. 派生字段（panels/geometry/issues/stats）永不进入模型
 *   8. 连续多次合法编辑后，恒等式断言始终保持 0 ERROR
 * ══════════════════════════════════════════════════════════════════════
 */

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

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

const snap = (p: Project): string => JSON.stringify(p);

function errsOf(bus: CommandBus): string[] {
  return bus
    .issues()
    .filter((i) => i.severity === 'ERROR')
    .map((i) => `${i.code} ${i.target}: ${i.message}`);
}

/** 撤销往返断言：before → 操作 → 撤销必须回到 before → 重做必须回到 after */
function roundTrip(bus: CommandBus, label: string, mutate: (b: CommandBus) => { ok: boolean; error?: string }): string {
  const before = snap(bus.getState());
  const r = mutate(bus);
  if (!r.ok) {
    fail++;
    failures.push(`${label}（提交失败）`);
    console.log(`  \u2717 ${label}：提交失败 ${r.error ?? ''}`);
    return before;
  }
  const after = snap(bus.getState());

  bus.undo();
  ok(`${label} · 撤销后与操作前逐字节一致`, snap(bus.getState()) === before);

  bus.redo();
  ok(`${label} · 重做后与操作后逐字节一致`, snap(bus.getState()) === after);

  bus.undo(); // 复原，供下一项测试
  ok(`${label} · 二次撤销回到操作前`, snap(bus.getState()) === before);

  return before;
}

// ─────────────────────────────────────────────────────────────────
section('【1】示例模型派生与校验');

const bus = new CommandBus(sampleProject(rules), rules);
const baseline = snap(bus.getState());

const g0 = bus.derive().geom;
ok('派生出了 cab_001 的几何', !!g0.cabinets['cab_001']);
ok('板件数 > 20 种', (g0.cabinets['cab_001']?.panels.length ?? 0) > 20, `实际 ${g0.cabinets['cab_001']?.panels.length}`);
ok('恒等式断言 + 生产硬规则：0 ERROR', errsOf(bus).length === 0, errsOf(bus).join('\n      '));
ok('缓存命中（同 version 两次 derive 返回同一对象）', bus.derive().geom === bus.derive().geom);

// 直接复核一次（不经 CommandBus），确认校验器独立可跑
const raw = generateProject(bus.getState(), rules);
const rawIssues = [...raw.issues, ...bus.getState().cabinets.flatMap((c) => validateCabinet(c, raw.cabinets[c.id], rules))];
ok('绕过缓存独立复核同样 0 ERROR', rawIssues.filter((i) => i.severity === 'ERROR').length === 0);

// ─────────────────────────────────────────────────────────────────
section('【2】写路径白名单（AI 越权防线）');

const deny = (label: string, cmd: Parameters<CommandBus['execute']>[0]): void => {
  const r = bus.execute(cmd, { dryRun: false });
  ok(`拒绝：${label}`, !r.ok, `竟然通过了：${JSON.stringify(r.diff)}`);
};

deny('直写派生字段 panels', {
  id: 't1',
  op: 'cabinet.update',
  source: 'ai',
  target: { kind: 'cabinet', id: 'cab_001' },
  changes: [{ path: 'panels', op: 'set', value: 1 }],
});

deny('op=cabinet.move 改 params.width（op 与路径不匹配）', {
  id: 't2',
  op: 'cabinet.move',
  source: 'ai',
  target: { kind: 'cabinet', id: 'cab_001' },
  changes: [{ path: 'params.width', op: 'set', value: 1000 }],
});

deny('写 issues', {
  id: 't3',
  op: 'cabinet.update',
  source: 'ai',
  target: { kind: 'cabinet', id: 'cab_001' },
  changes: [{ path: 'issues', op: 'set', value: [] }],
});

deny('写 stats', {
  id: 't4',
  op: 'cabinet.update',
  source: 'ai',
  target: { kind: 'cabinet', id: 'cab_001' },
  changes: [{ path: 'stats.pieces', op: 'set', value: 999 }],
});

deny('改规则集（ruleSetId）', {
  id: 't5',
  op: 'project.rename',
  source: 'ai',
  target: { kind: 'project', id: 'project' },
  changes: [{ path: 'ruleSetId', op: 'set', value: 'hacked' }],
});

deny('新增不存在的字段', {
  id: 't6',
  op: 'cabinet.update',
  source: 'ai',
  target: { kind: 'cabinet', id: 'cab_001' },
  changes: [{ path: 'params.magicExtra', op: 'set', value: 1 }],
});

deny('不存在的目标柜体', {
  id: 't7',
  op: 'cabinet.move',
  source: 'ai',
  target: { kind: 'cabinet', id: 'cab_999' },
  changes: [{ path: 'placement.x', op: 'set', value: 0 }],
});

ok('以上越权尝试均未改变模型', snap(bus.getState()) === baseline);

// ─────────────────────────────────────────────────────────────────
section('【3】值域夹紧（拒绝静默改值）');

{
  const b = new CommandBus(sampleProject(rules), rules);
  const c = b.getState().cabinets[0];
  const r = b.execute(CMD.resizeCabinet(c, { width: 99999 }), { strict: false });
  ok('超范围宽度被夹紧到 6000', b.getState().cabinets[0].params.width === 6000, `实际 ${b.getState().cabinets[0].params.width}`);
  ok('夹紧行为被回报（clamped 非空）', r.clamped.length > 0, JSON.stringify(r.clamped));
  b.undo();
  ok('撤销夹紧后复原', snap(b.getState()) === snap(sampleProject(rules)));
}

// ─────────────────────────────────────────────────────────────────
section('【4】预览 === 提交（拖动所见即松手所得）');

{
  const src = bus.getState();
  const c = src.cabinets[0];

  const cases: Array<[string, ReturnType<typeof CMD.moveCabinet>]> = [
    ['移动柜体', CMD.moveCabinet(c, c.placement.x + 250, c.placement.y - 130)],
    ['改宽度', CMD.resizeCabinet(c, { width: 2000 })],
    ['改深度', CMD.resizeCabinet(c, { depth: 550 })],
    ['改高度', CMD.resizeCabinet(c, { height: 2200 })],
    ['改踢脚高', CMD.setBodyLift(c, 120)],
    ['改分区净宽', CMD.setUnitWidth(c, 0, 700)],
    ['改抽屉数', CMD.setUnitInt(c, 0, 'drawers.count', 2, '抽屉数')],
    ['旋转', CMD.rotateCabinet(c, 90)],
  ];

  for (const [label, cmd] of cases) {
    const probe = new CommandBus(src, rules);
    const pv = probe.preview(cmd);

    const commit = new CommandBus(src, rules);
    const r = commit.execute(cmd);

    ok(`「${label}」预览 === 提交`, pv.ok && r.ok && snap(pv.project) === snap(commit.getState()), `preview.ok=${pv.ok} exec.ok=${r.ok}`);
  }
}

// ─────────────────────────────────────────────────────────────────
section('【5】路径类变更的撤销/重做往返');

{
  const b = new CommandBus(sampleProject(rules), rules);
  const c0 = () => b.getState().cabinets[0];

  roundTrip(b, '移动柜体', (x) => x.execute(CMD.moveCabinet(c0(), c0().placement.x + 200, c0().placement.y + 90)));
  roundTrip(b, '改宽度', (x) => x.execute(CMD.resizeCabinet(c0(), { width: 1800 })));
  roundTrip(b, '改高度', (x) => x.execute(CMD.resizeCabinet(c0(), { height: 2300 })));
  roundTrip(b, '改深度', (x) => x.execute(CMD.resizeCabinet(c0(), { depth: 580 })));
  roundTrip(b, '旋转 90°', (x) => x.execute(CMD.rotateCabinet(c0(), 90)));
  roundTrip(b, '重命名', (x) => x.execute(CMD.renameCabinet(c0(), '衣柜 A')));
  roundTrip(b, '改分区净宽', (x) => x.execute(CMD.setUnitWidth(c0(), 1, 1100)));
  roundTrip(b, '改层板数', (x) => x.execute(CMD.setUnitInt(c0(), 2, 'shelves.count', 5, '层板数 → 5')));
  roundTrip(b, '改门扇数', (x) => x.execute(CMD.setUnitInt(c0(), 2, 'doors.count', 3, '门扇数 → 3')));
  roundTrip(b, '改总宽策略', (x) => x.execute(CMD.setWidthMode(c0(), 'fit_units')));
  roundTrip(b, '改分区昵称', (x) => x.execute(CMD.setUnitString(c0(), 0, 'nickname', '抽屉组', '重命名')));
  roundTrip(b, '改项目名', (x) => x.execute(CMD.renameProject(x.getState().name, '示例户型 B')));

  ok('所有往返测试结束后模型回到基线', snap(b.getState()) === baseline, snap(b.getState()).slice(0, 120));
  ok('日志条数 = 12 条操作 × 3 次（执行/撤销/重做共 2 条新记录）… 仅检查日志非空', b.log().length > 0);
}

// ─────────────────────────────────────────────────────────────────
section('【6】结构性变更的撤销/重做往返');

{
  const b = new CommandBus(sampleProject(rules), rules);
  const roomId = b.getState().rooms[0].id;

  roundTrip(b, '新建柜体', (x) =>
    x.execute(
      CMD.createCabinet(
        createCabinet({
          name: '测试柜',
          roomId,
          x: 2000,
          y: 1500,
          rules,
          takenIds: x.getState().cabinets.map((c) => c.id),
        }),
        'ai'
      )
    )
  );

  roundTrip(b, '删除柜体', (x) => x.execute(CMD.deleteCabinet(x.getState().cabinets[0])));

  const unit: UnitSpec = {
    id: '',
    kind: 'shelves',
    requestedWidth: 400,
    nickname: '新分区',
    shelves: { count: 2, mode: 'equal', gapPerSide: 0.5 },
  };
  roundTrip(b, '新增分区', (x) => x.execute(CMD.addUnit(x.getState().cabinets[0].id, x.getState().cabinets[0].name, unit)));

  roundTrip(b, '删除分区', (x) =>
    x.execute(CMD.removeUnit(x.getState().cabinets[0].id, x.getState().cabinets[0].name, x.getState().cabinets[0].layout.units[0].id))
  );

  roundTrip(b, '删除最后一面墙', (x) => {
    const w = x.getState().rooms[0].walls[0];
    return x.execute(CMD.deleteWall(w.id, w.name));
  });

  ok('全部结构性往返后回到基线', snap(b.getState()) === baseline, snap(b.getState()).slice(0, 120));

  // 空项目画墙 → 必须自动建房间，且撤销后房间一并消失
  const fresh = new CommandBus(emptyProject({ name: '空项目', ruleSetId: rules.id }), rules);
  const w = createWall({ name: '墙1', start: { x: 0, y: 0 }, end: { x: 3000, y: 0 }, thickness: 120, height: 2700 });
  const rw = fresh.execute(CMD.drawWall(w));
  ok('空项目画墙：自动创建容器房间', rw.ok && fresh.getState().rooms.length === 1 && fresh.getState().rooms[0].walls.length === 1);
  fresh.undo();
  ok('撤销画墙：房间与墙一起消失（不留空房间）', fresh.getState().rooms.length === 0 && fresh.getState().cabinets.length === 0);

  const room = rectRoom({ name: '房间2', x: 4000, y: 0, w: 3000, h: 2400 });
  roundTrip(fresh, '新建房间', (x) => x.execute(CMD.createRoomCommand(room)));
}

// ─────────────────────────────────────────────────────────────────
section('【7】派生字段永不进入模型');

{
  const model = JSON.stringify(bus.getState());
  ok('模型里没有 panels 字段', !/"panels"/.test(model));
  ok('模型里没有 geometry 字段', !/"geometry"/.test(model));
  ok('模型里没有 issues 字段', !/"issues"/.test(model));
  ok('模型里没有 stats 字段', !/"stats"/.test(model));
  ok('模型里没有 panels/geometry 相关键', !/(panelKinds|totalPieces|boardAreaM2)/.test(model));
}

// ─────────────────────────────────────────────────────────────────
section('【8】strict 模式：拒绝引入 ERROR 的提交');

{
  const b = new CommandBus(sampleProject(rules), rules);
  const before = snap(b.getState());
  const c = b.getState().cabinets[0];
  // 6000 宽会让顶底板远超板材幅面 → 必然引入 ERROR
  const r = b.execute(CMD.resizeCabinet(c, { width: 6000 }), { strict: true });
  ok('strict 下提交被拒绝', !r.ok, `竟然通过了：blockingErrors=${r.blockingErrors}`);
  ok('strict 拒绝后模型未改变', snap(b.getState()) === before);
  ok('拒绝原因指向新引入的 ERROR', (r.error ?? '').includes('ERROR'), r.error);

  // 非 strict 下同一命令应当成功，但如实回报 ERROR
  const r2 = b.execute(CMD.resizeCabinet(c, { width: 6000 }));
  ok('非 strict 下允许提交（编辑不该被硬阻断）', r2.ok);
  ok('非 strict 下仍如实回报阻断态', r2.blockingErrors > 0 && b.hasBlockingErrors());
}

// ─────────────────────────────────────────────────────────────────
section('【9】连续编辑后恒等式断言始终 0 ERROR');

{
  const b = new CommandBus(sampleProject(rules), rules);
  let violations = 0;
  let rounds = 0;
  let seed = 20260923;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  for (let i = 0; i < 80; i++) {
    const c = b.getState().cabinets[0];
    // 上限刻意压在 2300：单柜净宽一旦超过板材长边 2440，顶底板必然超幅面 ——
    // 那是【正确的生产硬规则在报警】（该拆柜，而不是拆顶板），
    // 不属于本项要验证的"编辑过程是否保持自洽"。
    const W = Math.round(1600 + rnd() * 700); // 1600~2300
    const H = Math.round(2000 + rnd() * 400); // 2000~2400
    const D = Math.round(500 + rnd() * 150); // 500~650
    // 位移限制在房间内表面之间，避免人为制造柜-墙干涉（那是另一类规则）
    const x = Math.round(80 + rnd() * Math.max(1, 3140 - W - 80));
    const y = Math.round(80 + rnd() * Math.max(1, 2540 - D - 80));

    const r1 = b.execute(CMD.resizeCabinet(c, { width: W, height: H, depth: D }));
    const r2 = b.execute(CMD.moveCabinet(b.getState().cabinets[0], x, y));
    rounds += 2;
    if (!r1.ok || !r2.ok) violations++;
    if (errsOf(b).length > 0) {
      violations++;
      if (violations <= 4) console.log(`      第 ${i} 轮出现 ERROR：${errsOf(b)[0]}`);
    }
  }
  ok(`${rounds} 次随机合法编辑后始终 0 ERROR`, violations === 0, `${violations} 次违规`);

  // 全部撤销回去，验证长链撤销的正确性
  for (let i = 0; i < rounds; i++) b.undo();
  ok('连续撤销全部操作后回到基线', snap(b.getState()) === baseline, snap(b.getState()).slice(0, 160));
}

// ─────────────────────────────────────────────────────────────────
section('【9b】背板超幅面必须在两个方向都拆块');

{
  const b = new CommandBus(sampleProject(rules), rules);
  const c = b.getState().cabinets[0];
  // 宽高都超过短板边 1220，且宽超过长边以外的情形，迫使必须网格化拆块
  b.execute(CMD.resizeCabinet(c, { width: 2300, height: 2400, depth: 600 }));
  const g = b.derive().geom.cabinets['cab_001'];
  const backs = g.panels.filter((x) => x.role === 'BackPanel');
  const [sheetL, sheetS] = rules.limits.maxSheetSize;
  ok('背板被拆成多块', backs.length > 1, `实际 ${backs.length} 块`);
  ok(
    '每个背板块都放得进板材（两种摆放任一种）',
    backs.every((x) => (x.length <= sheetL && x.width <= sheetS) || (x.length <= sheetS && x.width <= sheetL)),
    JSON.stringify(backs.map((x) => `${x.length}×${x.width}`))
  );
  ok('背板拆块后 0 ERROR', errsOf(b).length === 0, errsOf(b).join(' | '));
  const total = backs.reduce((a, x) => a + x.length * x.width, 0);
  const expect = g.layout.innerW + 2 * 8 - 1;
  const expectH = g.layout.innerH + 2 * 8 - 1;
  ok('拆块面积 = 整板面积（面积守恒）', total === expect * expectH, `${total} vs ${expect * expectH}`);
}

// ─────────────────────────────────────────────────────────────────
section('【10】审计与状态跳转');

{
  const b = new CommandBus(sampleProject(rules), rules);
  const c = b.getState().cabinets[0];
  b.execute(CMD.moveCabinet(c, c.placement.x + 100, c.placement.y));
  const mid = snap(b.getState());
  b.execute(CMD.resizeCabinet(b.getState().cabinets[0], { width: 1600 }));
  const last = snap(b.getState());

  ok('日志记录了 source', b.log().every((e) => !!e.command.source));
  ok('日志记录了 diff', b.log().every((e) => e.diff.length > 0));
  ok('日志记录了派生快照', b.log().every((e) => typeof e.derived.pieces === 'number'));

  b.jumpTo(b.log()[0].seq);
  ok('jumpTo 第一步：回到第一次操作后的状态', snap(b.getState()) === mid);

  b.jumpTo(b.log()[1].seq);
  ok('jumpTo 第二步：回到最新状态', snap(b.getState()) === last);

  b.jumpTo(b.log()[0].seq);
  b.undo();
  ok('jumpTo + undo：回到基线', snap(b.getState()) === baseline);
}

// ─────────────────────────────────────────────────────────────────
section('I. 贴墙判定：旋转过的柜体背靠墙面仍算相切，不算干涉');

/**
 * 这一组是一次真实缺陷留下的回归断言。
 *
 * `Math.sin(Math.PI)` 不是 0 而是 1.2246e-16，于是旋转 180°、背靠北墙内表面
 * （y=2540）的柜体算出来的足迹 max.y = 2540.0000000000005 —— 比墙面大了
 * **4.5e-13 mm**。碰撞判定用的是严格小于（"相切不算干涉"），
 * 这点浮点残差就把"贴墙"判成了"扎进墙里"。
 *
 * 它的隐蔽之处在于：手工操作几乎总是 rotation=0（此时 sin(0) 精确为 0），
 * 所以这个错误可以在系统里躺很久，直到某个**自动落点**功能第一次尝试
 * "贴着某面墙放"才暴露出来 —— 而那时的表现是"采用方案永远失败"。
 *
 * 修法在 geometry/transform.ts（旋转矩阵里 0/±1 必须精确取值），
 * 这里钉住的是**后果**：每个 90° 倍数下贴墙都必须仍然算相切。
 */
{
  const room = rectRoom({ name: '测试房', x: 0, y: 0, w: 3200, h: 2600, thickness: 120, height: 2700 });
  const base: Project = { ...emptyProject(), rooms: [room] };

  /**
   * 落点用**真实的贴墙逻辑**去取，不手写坐标。
   * 手写坐标是这次差点写错的地方：背左角 y=60 对 rotation=0 是贴南墙，
   * 对 rotation=270 却真的是扎进墙里（局部 +Y 指向了 -Y）——
   * 那样断言失败会指向"贴墙判定坏了"，而其实坏的是我给的坐标。
   * 用同一份 placeAgainstNearestWall，四面墙就恰好覆盖 0/90/180/270 四个角。
   */
  const seen = new Set<number>();
  for (const w of room.walls) {
    const mid = { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 };
    const toIn = { x: 1600 - mid.x, y: 1300 - mid.y };
    const len = Math.hypot(toIn.x, toIn.y) || 1;
    const seed = { x: mid.x + (toIn.x / len) * (w.thickness / 2 + 30), y: mid.y + (toIn.y / len) * (w.thickness / 2 + 30) };
    const spot = placeAgainstNearestWall(base, seed, 1200);

    const cab = createCabinet({
      id: `cab_${w.id}`,
      name: `贴${w.name}`,
      roomId: room.id,
      x: spot.x,
      y: spot.y,
      rotation: spot.rotation,
      rules,
      params: { width: 1200, height: 2400, depth: 600 },
    });
    seen.add(spot.rotation);

    const g = generateProject({ ...base, cabinets: [cab] }, rules);
    const inWall = g.issues.filter((i) => i.code === 'RULE-CABINET-IN-WALL');
    ok(
      `贴「${w.name}」（rotation=${spot.rotation}）不算撞墙 —— 相切就是相切`,
      inWall.length === 0,
      `placement=${JSON.stringify({ x: spot.x, y: spot.y, r: spot.rotation })} ${JSON.stringify(inWall.map((i) => i.message))}`
    );

    /**
     * 上面那条**单独一条是不够的**（这一点是实测出来的，不是想出来的）：
     * 关掉修复后它照样通过 —— 因为墙的多边形自己也带着同一类残差，
     * 两边偶然互相抵消了。只断言"没有报撞墙"，等于什么都没断言。
     *
     * 真正钉住根因的是下面这条：足迹坐标必须是**精确整数 mm**。
     * `sin(π)=1.2246e-16` 一旦混进来，2540 就变成 2540.0000000000005，
     * 于是"相切"在数值上变成了"重叠"。整数性是二进制层面可判定的，不留侥幸。
     */
    const fp = getCabinetFootprint(cab);
    ok(
      `贴「${w.name}」的足迹坐标是精确整数 mm（rotation=${spot.rotation}，${spot.rotation === 0 ? '这条本就该过' : 'sin/cos 的残差不许进几何'}）`,
      fp.every((p) => Number.isInteger(p.x) && Number.isInteger(p.y)),
      JSON.stringify(fp)
    );
  }
  ok(
    '四面墙恰好覆盖了 0 / 90 / 180 / 270 四个旋转角（漏一个角就漏一类浮点残差）',
    seen.size === 4,
    JSON.stringify([...seen].sort((a, b) => a - b))
  );
}

// ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(66)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：Phase 1 地基（CommandBus / 撤销 / 缓存失效 / 越权防线）成立。');
