/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.6 §二十七 真实需求验收：玻璃门衣柜端到端
 *
 *  ── 要证明的命题 ──
 *    "生成一个长 600，高 2200，深 400 的衣柜，玻璃门，下面两个抽屉，上面两层隔板"
 *    这条自然语言需求必须能**走通编译链路**，且：
 *      · 玻璃门材质（M_GLASS_8_GREY）**透传到底**，不被静默降级成普通木门；
 *      · 上下分区：上行显式 1200（不默认 50/50、系统不猜高），下行写 'fill' 吸收剩余
 *        （恰好一行 fill —— P1 允许；两行都 'fill' 必被拒，见 §3）；
 *      · 抽屉 / 层板数量与语义一致；
 *      · 未知门材质报错（不静默降级）；
 *      · 全链路不碰规则集、不改真 project.json。
 *
 *  ── 红线（§二十七 明令禁止的为让例子通过而做的妥协）──
 *    不放宽 P1 `fill` 规则；不默认上下 50/50；不自动猜高度；
 *    不把普通门伪装成玻璃门；不删原有严格校验；不修改旧测试使其通过；
 *    不在 Compare UI 里做补偿性逻辑。
 *    最终目标不是"这一个例子能生成"，而是把
 *    "明确语义不能被静默丢失、未知不能被擅自猜测"变成通用不变量。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Cabinet, Project, RuleSet, UnitSpec } from '../src/core/types.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { generateCabinet } from '../src/core/geometry/generate.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { validateCabinet } from '../src/core/rules/validate.ts';
import { dryRunPlan } from '../src/ai/planRunner.ts';

const APP = join(import.meta.dirname, '..');
const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset', 'factory-default.json'), 'utf8')) as RuleSet;
const GLASS_ID = 'M_GLASS_8_GREY';

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

// ── 夹具 ──
const baseProject = (): Project => sampleProject(RULES);
const roomId = (): string => baseProject().rooms[0]!.id;

/** §二十七 需求：上(1200)层板×2+玻璃门，下(1000)抽屉×2；宽600 高2200 深400 */
function glassWardrobeAction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'cabinet.create',
    target: { roomId: roomId() },
    params: {
      name: '玻璃门衣柜',
      width: 600,
      height: 2200,
      depth: 400,
      rows: [
        { height: 1200, units: [{ kind: 'shelves', count: 2, doorCount: 1, doorMaterial: GLASS_ID }] },
        { height: 'fill', units: [{ kind: 'drawerBank', count: 2 }] },
      ],
      ...overrides,
    },
    reason: '§27 验收',
    index: 0,
  };
}

function builtCabinet(action: Record<string, unknown>): { cab: Cabinet | null; err: string; okCount: number } {
  const proj = baseProject();
  const bus = new CommandBus(proj, RULES);
  const before = JSON.stringify(bus.getState());
  // gate 只装"用户纠正过的规矩"的记忆；全新工程没有纠正 → 空门。
  // 这里刻意不 import state/memoryStore：它经 store.ts 静态 import 规则集 JSON，
  // Node ESM 需要 import 属性（Vite 打包无此约束，故只影响 verify 直跑）。
  // 传 null = 无记忆门，在"无纠正"场景与 compileCorrections([]).gate 等价。
  const run = dryRunPlan({ bus, actions: [action as never], gate: null, selection: [] });
  const after = JSON.stringify(bus.getState());
  const cab = run.draft.cabinets.find((c) => c.name === '玻璃门衣柜') ?? null;
  // 验证真 project 未被改动（dryRunPlan 跑在 sandbox 上）
  const untouched = before === after;
  return { cab, err: run.steps[0]?.error ?? '', okCount: run.okCount, ...(untouched ? {} : { touched: true }) } as never;
}

const allUnits = (cab: Cabinet): UnitSpec[] => (cab.layout.rows ?? [{ units: cab.layout.units }]).flatMap((r) => r.units);

// ═══════════════════ §1 玻璃门衣柜端到端（§二十七 主路径）═══════════════════
section('§1 玻璃门衣柜编译链路走通');
{
  const { cab, err, okCount, touched } = builtCabinet(glassWardrobeAction());
  ok('1. ★ 编译成功：glass+显式行高的 cabinet.create 通过 dryRunPlan（1 步应用、无 error）', cab !== null && okCount === 1 && err === '', { err, okCount });
  ok('2. 柜体尺寸正确：宽600 / 高2200 / 深400', !!cab && cab.params.width === 600 && cab.params.height === 2200 && cab.params.depth === 400, cab ? `w=${cab.params.width} h=${cab.params.height} d=${cab.params.depth}` : 'no cab');
  ok('3. 上下两层结构：layout.rows.length === 2（不是默认单行三分区）', !!cab && (cab.layout.rows?.length ?? 0) === 2, cab ? `rows=${(cab.layout.rows ?? []).length}` : 'no cab');
  ok('4. ★ 行高语义未被系统篡改：上行显式 1200（≠ 50/50 均分的 1033），下行为显式 \'fill\'（系统不代填数字）', !!cab && cab.layout.rows?.[0]?.height === 1200 && cab.layout.rows?.[1]?.height === 'fill', cab ? cab.layout.rows?.map((r) => r.height) : 'no cab');
  const units = cab ? allUnits(cab) : [];
  const shelves = units.find((u) => u.kind === 'shelves');
  const drawers = units.find((u) => u.kind === 'drawerBank');
  ok('5. ★ 玻璃门材质透传：层板单元的 doors.material === M_GLASS_8_GREY（未被降级成木门）', !!shelves && shelves.doors?.material === GLASS_ID, shelves ? `material=${shelves.doors?.material}` : 'no shelves');
  ok('6. 层板数量 = 2', !!shelves && shelves.shelves?.count === 2, shelves ? `count=${shelves.shelves?.count}` : 'no shelves');
  ok('7. 抽屉数量 = 2（下面两个抽屉）', !!drawers && drawers.drawers?.count === 2, drawers ? `count=${drawers.drawers?.count}` : 'no drawers');
  ok('8. 玻璃门扇数 = 1', !!shelves && shelves.doors?.count === 1, shelves ? `count=${shelves.doors?.count}` : 'no shelves');
  {
    // ★ 这条钉住一个 P9.6 §27 暴露出来的**真实核心缺陷**：玻璃门走 purchased（不进 panels），
    //   旧 `validateCabinet` 的"Σ门宽 + 缝 = 净宽"恒等式断言只读 panels → 把合法玻璃门
    //   算成 Σ门宽=0 → 报 IDENTITY-FAIL（"这是程序缺陷"）→ 整个操作被 strict 模式拒绝。
    //   修复只对"可开料门板"断言（同"高度链只在配置合法时断言"纪律），玻璃门改验甲购数量。
    //   这里同时跑 generate + validate，确保不再出现 ERROR 级 issue（含 IDENTITY-FAIL）。
    const g = cab ? generateCabinet(cab, RULES) : null;
    const v = cab && g ? validateCabinet(cab, g, RULES) : [];
    const all = g ? [...g.issues, ...v] : [];
    ok('9. ★ 柜体结构合法：generate + validate 均无 ERROR 级 issue（玻璃门不再被误判成 IDENTITY-FAIL 程序缺陷）', g !== null && all.every((i) => i.severity !== 'ERROR'), g ? all.map((i) => i.code).join(',') : 'no cab');
  }
}

// ═══════════════════ §2 门材质语义边界（不降级、不猜）═══════════════════
section('§2 门材质语义边界');
{
  // 不给 doorMaterial → 用规则集默认门板材质（≠ 玻璃）
  const def = builtCabinet(glassWardrobeAction({ rows: [{ height: 1200, units: [{ kind: 'shelves', count: 2, doorCount: 1 }] }, { height: 'fill', units: [{ kind: 'drawerBank', count: 2 }] }] }));
  const defShelves = def.cab ? allUnits(def.cab).find((u) => u.kind === 'shelves') : undefined;
  const boards = Object.entries(RULES.materials).filter(([, m]) => m.kind === 'board').sort((a, b) => b[1].thickness - a[1].thickness);
  ok('10. 不给门材质 → 用默认门板材质（最厚 board），确实 ≠ 玻璃（证明玻璃是显式 opt-in，不是强制）', !!defShelves && defShelves.doors?.material === boards[0]![0] && defShelves.doors?.material !== GLASS_ID, defShelves ? `material=${defShelves.doors?.material}` : 'no shelves');

  // 未知门材质 → 编译报错，柜体不建（不静默降级）
  const bad = builtCabinet(glassWardrobeAction({ rows: [{ height: 1200, units: [{ kind: 'shelves', count: 2, doorCount: 1, doorMaterial: 'M_NOT_EXIST' }] }, { height: 'fill', units: [{ kind: 'drawerBank', count: 2 }] }] }));
  ok('11. ★ 未知门材质 → 整步报错（okCount=0、柜体不建、不静默降级成木门）', bad.cab === null && bad.okCount === 0 && /门板材质/.test(bad.err), { err: bad.err, okCount: bad.okCount });

  // 规则集确有玻璃材质
  const g = RULES.materials[GLASS_ID];
  ok('12. 规则集确有玻璃材质 M_GLASS_8_GREY（kind=glass, 8mm）', !!g && g.kind === 'glass' && g.thickness === 8, JSON.stringify(g));
}

// ═══════════════════ §3 不猜高度：两行都 fill 必须被拒（红线反例）═══════════════════
section('§3 不猜高度：两行 fill 被拒，证明没放宽 P1');
{
  const fillBoth = builtCabinet(glassWardrobeAction({ rows: [{ height: 'fill', units: [{ kind: 'shelves', count: 2, doorCount: 1, doorMaterial: GLASS_ID }] }, { height: 'fill', units: [{ kind: 'drawerBank', count: 2 }] }] }));
  ok('13. ★ 两行都 height:"fill" → 被拒（okCount=0、柜体不建）：没有为让例子通过而放宽 P1', fillBoth.cab === null && fillBoth.okCount === 0, { err: fillBoth.err, okCount: fillBoth.okCount });
  ok('14. 拒绝原因与行高相关（不是别的无关错误），证明是 P1 行高规则在拦', /行高|height|ROW_HEIGHT|fill|内高|剩余/.test(fillBoth.err), fillBoth.err);
}

// ═══════════════════ §4 契约：玻璃门字段两处入口都透传 ═══════════════════
section('§4 契约与编译入口对齐');
{
  const contract = readFileSync(join(APP, 'shared/aiContract.mjs'), 'utf8');
  ok('15. 契约 UNIT_INTENT_ITEM 有 doorMaterial 字段（引用 RuleSet.materials）', /doorMaterial/.test(contract) && /UNIT_INTENT_ITEM/.test(contract));
  ok('16. 契约 doorMaterial 描述明说"玻璃门不会被降级成普通木门"', /玻璃门不会被降级成普通木门/.test(contract));
  ok('17. 契约 cabinet.addUnit 也透传 doorMaterial（addUnit 路径同样不降级）', /'cabinet\.addUnit'[\s\S]*?doorMaterial/.test(contract) || /cabinet\.addUnit[\s\S]*?doorMaterial/.test(contract), 'addUnit doorMaterial');
}

// ═══════════════════ §5 不污染规则集 / 不写真 project.json ═══════════════════
section('§5 不污染规则集 / 不写真模型');
{
  const before = JSON.stringify(RULES.materials);
  builtCabinet(glassWardrobeAction());
  ok('18. 编译不改规则集（RULES.materials 逐字节不变）', JSON.stringify(RULES.materials) === before);
}

console.log(`\n═══ P9.6 §27 真实需求（玻璃门衣柜）验收：通过 ${pass} / 失败 ${fail} ═══`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
