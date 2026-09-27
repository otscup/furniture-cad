import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { dryRunPlan } from '../src/ai/planRunner.ts';
import type { AiAction } from '../src/ai/compile.ts';
import { compileCorrections } from '../src/ai/memory.ts';
import { seedCorrections } from '../src/ai/seedCorrections.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  "AI 建柜"这条通路的语言兑现能力 —— L 形转角柜 / 岛台
 *
 *  用户原话：
 *    "在房间2生成一个 L 形橱柜，长2200，高900，宽850，
 *     另一边长1500，高700，宽850，中间镂空，类似于岛台"
 *
 *  ── 这批断言要证明什么 ──
 *    ① 两个 arm 各一条 cabinet.create，AI **不给落位**也能真的建成
 *       （系统负责找位置，不许把"塞进墙里"包装成 AI 理解错了）。
 *    ② 两个 arm 都落在目标房间里 —— "建在房间2"这话必须有落点。
 *    ③ 第三条：这类异形还能一次性给出分区意图（AI 真正的能力边界）。
 *    ④ 岛台（双面柜 backUnits）这条路是真通的 ——
 *       上一轮我在对话里对说过"契约支持岛台"，这句话本身要有断言看着。
 *    ⑤ 反例：把柜体建到墙体里，**strict 必须拒收**并给出可操作的原因。
 *       （pickFreeSpot 存在就是为了这一条 —— 自动落位不许让自己撞墙。）
 *
 *  ── 为什么写成"两种都要" ──
 *     只测成功路径会让"找到空位"这套逻辑失去约束：
 *     它要是退化成"塞进去再说"，这里是唯一会发现的地方。
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
function section(title: string): void {
  console.log(`\n【${title}】`);
}

function twoRoomProject(): { bus: CommandBus; room2Id: string } {
  const taken = new Set<string>();
  const p = emptyProject({ ruleSetId: rules.id, name: 'L 形验收' });
  p.rooms.push(rectRoom({ name: '房间1', x: 0, y: 0, w: 4000, h: 3000, id: 'room_001', takenIds: taken }));
  const room2 = rectRoom({ name: '房间2', x: 4200, y: 0, w: 4000, h: 3000, id: 'room_002', takenIds: taken });
  p.rooms.push(room2);
  return { bus: new CommandBus(p, rules), room2Id: room2.id };
}

// ───────────────────────── ① L 形两臂（用户那句话的字面记账）─────────────────────────
section('L 形：两条臂各一条 cabinet.create（AI 不给落位）');

{
  const { bus, room2Id } = twoRoomProject();
  const actions: AiAction[] = [
    {
      action: 'cabinet.create',
      target: { roomId: room2Id },
      params: { name: 'L形横臂', width: 2200, height: 900, depth: 850 },
      reason: '长 2200、高 900、深 850',
    },
    {
      action: 'cabinet.create',
      target: { roomId: room2Id },
      params: { name: 'L形竖臂', width: 1500, height: 700, depth: 850, rotation: 90 },
      reason: '另一条边 1500、高 700、深 850',
    },
  ];
  const run = dryRunPlan({ bus, actions, gate: null });

  ok('两条动作都通过 strict 干跑（AI 描述出来的柜型能被真的建出来）', run.okCount === 2 && run.errorCount === 0, JSON.stringify(run.steps.map((s) => `${s.ok}/${s.error ?? ''}`)));
  ok('草案里真的多出两个柜体', run.draft.cabinets.length === 2, String(run.draft.cabinets.length));
  ok(
    '两个柜体都落在目标房间（"建在房间2"这话有落点）',
    run.draft.cabinets.every((c) => c.roomId === room2Id),
    JSON.stringify(run.draft.cabinets.map((c) => c.roomId))
  );
  ok(
    '尺寸逐位就是用户说的那几个数（2200×900×850 / 1500×700×850）',
    run.draft.cabinets.some((c) => c.params.width === 2200 && c.params.height === 900 && c.params.depth === 850) &&
      run.draft.cabinets.some((c) => c.params.width === 1500 && c.params.height === 700 && c.params.depth === 850),
    JSON.stringify(run.draft.cabinets.map((c) => `${c.params.width}×${c.params.height}×${c.params.depth}`))
  );
  const errIssues = run.draft.cabinets.flatMap((c) => run.steps.flatMap((s) => s.newIssues.filter((i) => i.severity === 'ERROR')));
  ok('没有引入任何 ERROR（否则这一轮在界面上会被整轮拒掉）', errIssues.length === 0, JSON.stringify(errIssues.map((i) => i.message)));
}

// ───────────────────────── ② 一条命令就把分区意图给全 ────────────────────────
section('异形：一次性给出分区意图');

{
  const { bus, room2Id } = twoRoomProject();
  const run = dryRunPlan({
    bus,
    gate: null,
    actions: [
      {
        action: 'cabinet.create',
        target: { roomId: room2Id },
        params: {
          name: 'L形横臂',
          width: 2200,
          height: 900,
          depth: 850,
          units: [
            { kind: 'drawerBank', width: 700, count: 3 },
            { kind: 'open', width: 800 },
            { kind: 'shelves', width: 700, count: 2, doorCount: 2 },
          ],
        },
        reason: '左边三只抽屉、中间开放格、右边一组对开门',
      },
    ],
  });
  const cab = run.draft.cabinets.find((c) => c.name === 'L形横臂');
  ok('一条 cabinet.create 就能带上三个分区', run.okCount === 1 && cab?.layout.units.length === 3, JSON.stringify(cab?.layout.units.map((u) => u.kind) ?? null));
}

// ───────────────────────── ③ 岛台（双面柜 backUnits）────────────────────────
section('岛台：backUnits 双面柜这条路真通');

{
  const { bus, room2Id } = twoRoomProject();
  const run = dryRunPlan({
    bus,
    gate: null,
    actions: [
      {
        action: 'cabinet.create',
        target: { roomId: room2Id },
        params: {
          name: '岛台',
          width: 1800,
          height: 900,
          depth: 850,
          units: [{ kind: 'drawerBank', width: 900, count: 3 }, { kind: 'open', width: 900 }],
          backUnits: [{ kind: 'drawerBank', width: 900, count: 3 }, { kind: 'open', width: 900 }],
        },
        reason: '前后两排背靠背 —— 契约里的"岛台"',
      },
    ],
  });
  const cab = run.draft.cabinets.find((c) => c.name === '岛台');
  ok('岛台建成（没有时是谁也没办法说"支持岛台"）', run.okCount === 1 && !!cab, JSON.stringify(run.steps.map((s) => s.error ?? s.label)));
  ok('它真的是双面柜（layout.type = double 且背面排有分区）', cab?.layout.type === 'double' && (cab?.layout.backUnits?.length ?? 0) === 2, JSON.stringify({ type: cab?.layout.type, back: cab?.layout.backUnits?.length ?? 0 }));
}

// ───────────────────────── ④ AI 自己给的坐标扎进墙 → 自动贴墙修正 ─────────────────────────
/**
 * 这一组是 2026-09-28 用户现场报的那条：
 *   「第 1 轮 · 未并入草案 · 记忆拦截 mem_002_no_cabinet_in_wall」
 *
 * 根因不在 AI，在我们：**提示词要求 AI 给 atX/atY，而 AI 手上没有墙的坐标**，
 * 它只能照房间名猜角点 —— 房间2 南墙中心线 y=0、墙厚 120，模型给的 atY 就是 0，
 * 柜体正好扎进墙 60mm，记忆门整份拒收。
 *
 * 所以这里钉死两件事：
 *   · 猜错坐标**不再等于失败**：系统沿最小位移把它推到与墙面相切并照实说明；
 *   · 但推不出来时（柜子比房间还大）必须**明确报错并给出下一步**，不许静默乱放。
 */
section('AI 猜的落位扎进墙 → 自动贴墙修正（而不是整份拒收）');

{
  const { bus, room2Id } = twoRoomProject();
  // 真实现场：AI 把房间2 的角点当成 (4200, 0) —— 那正是西墙与南墙的中心线交点
  const run = dryRunPlan({
    bus,
    gate: compileCorrections(seedCorrections()).gate,
    actions: [
      {
        action: 'cabinet.create',
        target: { roomId: room2Id },
        params: { name: '横臂', width: 2200, height: 900, depth: 850, atX: 4200, atY: 0 },
        reason: 'AI 猜的落位',
      },
    ],
  });
  const cab = run.draft.cabinets.find((c) => c.name === '横臂');
  ok('不再被 mem_002 拒收 —— 这一轮能真的并进草案', run.okCount === 1 && run.errorCount === 0, JSON.stringify(run.steps.map((s) => s.error ?? s.label)));
  ok(
    '修正后的落位确实与墙面相切（校验器里没有 RULE-CABINET-IN-WALL）',
    run.steps[0].newIssues.filter((i) => i.code === 'RULE-CABINET-IN-WALL').length === 0,
    JSON.stringify(run.steps[0].newIssues.map((i) => i.code))
  );
  ok('改了落位这件事写在摘要里（界面读数 = 最终会被用到的值）', /自动贴墙修正/.test(run.steps[0].label), run.steps[0].label);
  ok('修正量是最小的（只推到墙面，不是随便挪开）', cab !== undefined && cab.placement.y === 60 && cab.placement.x >= 4260, JSON.stringify(cab?.placement));
}

// ───────────────────────── ⑤ 反例：推不出来时必须明确报错 ─────────────────────────
section('反例：柜子比房间还大 → 推不出来就明确报错并给出下一步');

{
  // 一个 1200×1200 的小房间（净宽约 1080），硬塞一条 1100 宽的柜子并指定角点：
  // 推到西墙外就撞东墙，推回来又撞西墙 —— 这就该明确报错，而不是静默乱放。
  const taken = new Set<string>();
  const p = emptyProject({ ruleSetId: rules.id, name: '推不出来' });
  p.rooms.push(rectRoom({ name: '小房间', x: 0, y: 0, w: 1200, h: 1200, id: 'room_s', takenIds: taken }));
  const bus = new CommandBus(p, rules);
  const run = dryRunPlan({
    bus,
    gate: null,
    actions: [
      {
        action: 'cabinet.create',
        target: { roomId: 'room_s' },
        params: { name: '放不下的柜', width: 1100, height: 700, depth: 600, atX: 0, atY: 0 },
        reason: '反例',
      },
    ],
  });
  ok('推不出来 → 整条拒收（不许静默乱放）', run.errorCount === 1 && run.steps[0].ok === false, JSON.stringify(run.steps[0].label));
  const msg = run.steps[0].error ?? '';
  ok('报错点名"嵌进墙"并给出下一步（省略 atX/atY 或调大房间）', /嵌进墙/.test(msg) && /atX/.test(msg) && /房间/.test(msg), msg.slice(0, 300));
}

// ───────────────────────── ⑥ L 形：朝向必须被尊重（不许并排贴同一面墙）─────────────────────────
section('L 形：rotation 决定贴哪面墙（两条臂不能并排贴同一面墙）');

{
  const { bus, room2Id } = twoRoomProject();
  const run = dryRunPlan({
    bus,
    gate: null,
    actions: [
      { action: 'cabinet.create', target: { roomId: room2Id }, params: { name: '横臂', width: 2200, height: 900, depth: 850 } },
      { action: 'cabinet.create', target: { roomId: room2Id }, params: { name: '竖臂', width: 1500, height: 700, depth: 850, rotation: 90 } },
    ],
  });
  const a = run.draft.cabinets.find((c) => c.name === '横臂');
  const b = run.draft.cabinets.find((c) => c.name === '竖臂');
  ok('两条臂都建成', run.okCount === 2 && !!a && !!b, JSON.stringify(run.steps.map((s) => s.error ?? s.label)));
  ok(
    'AI 说的朝向被尊重 —— 竖臂仍然是 90°（以前会被自动落位悄悄改成 0°）',
    b?.placement.rotation === 90 && a?.placement.rotation === 0,
    JSON.stringify({ 横臂: a?.placement.rotation, 竖臂: b?.placement.rotation })
  );
  const fp = (c: (typeof run.draft.cabinets)[number]) => {
    const x0 = c.placement.x;
    const y0 = c.placement.y;
    const r = c.placement.rotation;
    // 与 getCabinetFootprint 同口径：rotation=90 时宽落在 Y、深落在 X
    const along = r === 90 || r === 270;
    return { minX: along ? x0 - c.params.depth : x0, maxX: along ? x0 : x0 + c.params.width, minY: along ? y0 : y0 - 0, maxY: along ? y0 + c.params.width : y0 + c.params.depth };
  };
  const fa = a ? fp(a) : null;
  const fb = b ? fp(b) : null;
  const overlapXY = fa && fb ? fa.minX < fb.maxX && fa.maxX > fb.minX && fa.minY < fb.maxY && fa.maxY > fb.minY : true;
  ok('两条臂不重叠（否则会被 mem_003 拦下，又是"未并入草案"）', overlapXY === false, JSON.stringify({ fa, fb }));
  ok(
    '两条臂贴的是**互相垂直**的两面墙（这才是 L，不是一字排开）',
    a !== undefined && b !== undefined && a.placement.rotation !== b.placement.rotation,
    JSON.stringify({ 横臂: a?.placement.rotation, 竖臂: b?.placement.rotation })
  );
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) {
  console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
