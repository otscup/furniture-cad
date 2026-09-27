import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { dryRunPlan } from '../src/ai/planRunner.ts';
import type { AiAction } from '../src/ai/compile.ts';

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

// ───────────────────────── ④ 反例：自己往墙里塞，必须被拒且说清 ─────────────────────────
section('反例：显式落位嵌进墙 → strict 拒收，且原因可操作');

{
  const { bus, room2Id } = twoRoomProject();
  const run = dryRunPlan({
    bus,
    gate: null,
    actions: [
      {
        action: 'cabinet.create',
        target: { roomId: room2Id },
        // 房间2 的西墙在 x=4200；这里把柜体横跨墙中心线 —— 必然嵌墙
        params: { name: '嵌墙柜', width: 1500, height: 700, depth: 850, atX: 3900, atY: 300 },
        reason: '反例',
      },
    ],
  });
  ok('引入了 ERROR，于是整条被 strict 拒收', run.errorCount === 1 && run.steps[0].ok === false, JSON.stringify(run.steps[0]));
  const msg = `${run.steps[0].error ?? ''} ${run.steps[0].newIssues.map((i) => i.message).join(' ')}`;
  ok('拒收原因点名了"墙体"并给出厚度（不是一句"失败"）', /墙/.test(msg) && /120/.test(msg), msg.slice(0, 300));
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`通过 ${pass} · 失败 ${fail}`);
if (fail > 0) {
  console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
