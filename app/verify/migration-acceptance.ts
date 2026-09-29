import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, Project, RuleSet } from '../src/core/types.ts';
import { createCabinet, makeUnit, sampleProject } from '../src/core/docFactory.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { parseProjectFile, serializeProjectFile } from '../src/core/projectFile.ts';
import {
  SINGLE_ROW_ID,
  allUnits,
  canonicalUnits,
  isMultiRow,
  layoutRows,
  normalizeLayout,
  toFileLayout,
  toFileProject,
} from '../src/core/layoutModel.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  P0 迁移验收 —— 「旧柜体一个字节都不动，新形状已经有唯一口径」
 *
 *  P0 的全部承诺就是两句话，这个脚本逐条把它们钉成可回归的断言：
 *
 *   ① **零行为变更**：v0.2 形状的文件读进来再存回去，逐字节相同；
 *      派生骨架（宽度链/内空/分区起点）与冻结基线逐值相同。
 *      证明方式是**外部指纹**，不是"跑一遍没报错"：
 *      文件 sha256 与 P0 之前的基线相等，派生数值与基线相等。
 *
 *   ② **唯一口径**：`rows` / `units` 两种形状只在 core/layoutModel.ts 里被判断，
 *      别处只面对 canonical（行数组）。所以这里要证：单行柜的 canonical
 *      与旧字段**逐项同一**（连对象引用都相同），多行柜的读写是**可往返**的。
 *
 *  另外两件必须验的事：
 *   · 多行柜**刻意不写 units** —— 旧读者要拒绝，而不是把第一行当整柜算尺寸；
 *   · 非法行（空行/缺 id/重复 id/坏高度/空分区/跨行撞 id）必须在门口被拒，
 *     每条拒绝规则都要有**正样本对照**，否则"永远绿"的校验器等于没有校验器。
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

const reject = (raw: unknown): string | null => {
  const r = parseProjectFile(typeof raw === 'string' ? raw : JSON.stringify(raw));
  return r.ok ? null : r.error;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const SAVED_AT = '2026-09-24T10:00:00.000Z';

/** P0 冻结的 v0.2 文件指纹：改不动它才能说"零行为变更" */
const V02_FILE_SHA = '1de6c55ab2000f56c49cf9af700ec83db27bad3062eb2b2aaf892fcc2a45ac2b';
/** P0 冻结的 v0.2 派生骨架（cab_001：2400×2400×600，板厚 18，背板 9） */
const V02_DERIVED = { innerW: 2364, innerH: 2284, netTotal: 2328, nets: [582, 1164, 582], unitX0: [18, 618, 1800], boardT: 18, backT: 9, bodyH: 2320, shelfDepth: 570 };

function projectWith(cab: Cabinet): Project {
  const p = sampleProject(rules);
  p.cabinets = [cab];
  return p;
}

/** Case 2 夹具：上行通顶储物（固定 480）+ 下行三分区（吃掉剩余） */
function case2Cabinet(id: string): Cabinet {
  const cab = createCabinet({
    id,
    name: '通顶衣柜',
    roomId: 'room_001',
    x: 1000,
    y: 60,
    rules,
    params: { width: 2400, height: 2400, depth: 600 },
    units: [
      makeUnit({ id: 'unit_101', kind: 'hanging', requestedWidth: 1200, rules, rodHeight: 1200 }),
      makeUnit({ id: 'unit_102', kind: 'drawerBank', requestedWidth: 600, rules, count: 4 }),
      makeUnit({ id: 'unit_103', kind: 'shelves', requestedWidth: 600, rules, count: 4 }),
    ],
  });
  cab.layout.rows = [
    { id: 'row_001', height: 480, units: [makeUnit({ id: 'unit_201', kind: 'shelves', requestedWidth: 2400, rules, count: 2 })] },
    { id: 'row_002', height: 'fill', units: cab.layout.units.map((u) => structuredClone(u)) },
  ];
  return cab;
}

// ─────────────────── A. 单行（v0.2）逐字节往返 ───────────────────

console.log('\n── A. 单行（v0.2）逐字节往返：存量文件一个字节都不动 ──');

const projA = sampleProject(rules);
const rawA = serializeProjectFile(projA, SAVED_AT);
const parsedA = parseProjectFile(rawA);

ok('A1 v0.2 文件能被解析', parsedA.ok, parsedA.ok ? '' : parsedA.error);
if (parsedA.ok) {
  const rawA2 = serializeProjectFile(parsedA.project, SAVED_AT);
  ok('A2 读进来再存回去，逐字节相同', rawA2 === rawA, `长度 ${rawA.length} → ${rawA2.length}`);
  ok('A3 单行文件里不出现 rows 字段', !/"rows"/.test(rawA2));
  ok(
    'A4 layout 键序仍是 type,widthMode,units（键序变了就是假 diff）',
    same(Object.keys(parsedA.project.cabinets[0].layout), ['type', 'widthMode', 'units']),
    JSON.stringify(Object.keys(parsedA.project.cabinets[0].layout))
  );
  ok('A5 解析不做形状折算：读出来与原文逐字段相同', same(parsedA.project, projA));
  ok('A6 schemaVersion 本阶段不升版（旧文件保持 0.2）', parsedA.project.schemaVersion === '0.2', parsedA.project.schemaVersion);
}
// 断言自检：证明 A2 比的是**真的字符串**，不是恒真比较
ok(
  'A7 对照：换 savedAt 后文件必然不同（A2 不是恒真）',
  serializeProjectFile(projA, '2026-01-01T00:00:00.000Z') !== rawA
);
ok(
  `A8 文件指纹与 P0 前的基线相同（sha256=${V02_FILE_SHA.slice(0, 8)}…）`,
  createHash('sha256').update(rawA).digest('hex') === V02_FILE_SHA,
  `实为 ${createHash('sha256').update(rawA).digest('hex')}`
);

// 双面柜（岛台）：也是单行形状，外加 backUnits —— 同样必须逐字节往返
const island = createCabinet({
  id: 'cab_island',
  name: '岛台',
  roomId: 'room_001',
  x: 0,
  y: 0,
  rules,
  params: { width: 1800, height: 900, depth: 900 },
  units: [
    makeUnit({ id: 'unit_401', kind: 'shelves', requestedWidth: 900, rules, count: 3 }),
    makeUnit({ id: 'unit_402', kind: 'drawerBank', requestedWidth: 900, rules, count: 3 }),
  ],
  backUnits: [
    makeUnit({ id: 'unit_501', kind: 'open', requestedWidth: 900, rules }),
    makeUnit({ id: 'unit_502', kind: 'shelves', requestedWidth: 900, rules, count: 2 }),
  ],
});
const rawIsland = serializeProjectFile(projectWith(island), SAVED_AT);
const parsedIsland = parseProjectFile(rawIsland);
ok(
  'A9 双面柜（backUnits）往返逐字节相同',
  parsedIsland.ok && serializeProjectFile(parsedIsland.project, SAVED_AT) === rawIsland,
  parsedIsland.ok ? '' : parsedIsland.error
);

// ─────────────────── B. canonical 读侧 + 单行等价 ───────────────────

console.log('\n── B. canonical 读侧：单行柜与旧字段逐项同一 ──');

const cab0 = projA.cabinets[0];
const rowsB = layoutRows(cab0.layout);
ok('B1 无 rows ⇒ canonical 恰好 1 行（调用方永远不必判断 rows 在不在）', rowsB.length === 1, `${rowsB.length} 行`);
ok('B2 该行 id 是稳定规范名 row_001（读两次不会变）', rowsB[0]?.id === SINGLE_ROW_ID, String(rowsB[0]?.id));
ok('B3 该行 height = fill（吃掉全部内高）', rowsB[0]?.height === 'fill', String(rowsB[0]?.height));
ok(
  'B4 canonicalUnits 与 layout.units **逐项同一对象**（没拷贝、没重排、没补默认值）',
  canonicalUnits(cab0.layout).length === cab0.layout.units.length &&
    canonicalUnits(cab0.layout).every((u, i) => u === cab0.layout.units[i])
);
ok('B5 isMultiRow = false（单行柜不会被误判成分层柜）', isMultiRow(cab0.layout) === false);
ok(
  'B6 allUnits 与 layout.units 逐项同一',
  allUnits(cab0.layout).length === cab0.layout.units.length && allUnits(cab0.layout).every((u, i) => u === cab0.layout.units[i])
);
const nB = normalizeLayout(cab0.layout);
ok('B7 normalizeLayout 保留 type / widthMode', nB.type === cab0.layout.type && nB.widthMode === cab0.layout.widthMode);
ok('B8 双面柜的 backUnits 原样透传（不与行混在一起）', normalizeLayout(island.layout).backUnits === island.layout.backUnits);

// 派生骨架与冻结基线逐值相同 —— 单行等价的硬证据
const L0 = computeCabinetLayout(cab0, rules);
ok(
  `B9 派生骨架与 v0.2 基线逐值相同（innerW=${V02_DERIVED.innerW} innerH=${V02_DERIVED.innerH} netTotal=${V02_DERIVED.netTotal}）`,
  L0.innerW === V02_DERIVED.innerW && L0.innerH === V02_DERIVED.innerH && L0.netTotal === V02_DERIVED.netTotal,
  `实为 ${L0.innerW}/${L0.innerH}/${L0.netTotal}`
);
ok(
  `B10 宽度分配与基线逐值相同（nets=${JSON.stringify(V02_DERIVED.nets)}）`,
  same(L0.nets, V02_DERIVED.nets),
  JSON.stringify(L0.nets)
);
ok(
  `B11 分区起点与基线逐值相同（unitX0=${JSON.stringify(V02_DERIVED.unitX0)}）`,
  same(L0.unitX0, V02_DERIVED.unitX0),
  JSON.stringify(L0.unitX0)
);
ok(
  `B12 其余骨架量相同（boardT=${V02_DERIVED.boardT} backT=${V02_DERIVED.backT} bodyH=${V02_DERIVED.bodyH} shelfDepth=${V02_DERIVED.shelfDepth}）`,
  L0.boardT === V02_DERIVED.boardT && L0.backT === V02_DERIVED.backT && L0.bodyH === V02_DERIVED.bodyH && L0.shelfDepth === V02_DERIVED.shelfDepth,
  `${L0.boardT}/${L0.backT}/${L0.bodyH}/${L0.shelfDepth}`
);
// 反证：这些数字确实来自数据 —— 改一档宽度，netTotal 必变
const mutW = structuredClone(cab0);
mutW.params.width = 2000;
ok(
  'B13 对照：把柜宽改成 2000 后 netTotal 必变（B9–B12 不是恒真比较）',
  computeCabinetLayout(mutW, rules).netTotal !== V02_DERIVED.netTotal
);

// ─────────────────── C. canonical 写侧 ───────────────────

console.log('\n── C. canonical 写侧：单行塌回 units，多行只写 rows ──');

const fSingle = toFileLayout(cab0.layout);
ok('C1 单行写侧不写出 rows 字段', !('rows' in fSingle));
ok(
  'C2 单行写侧键序与原键序一致',
  same(Object.keys(fSingle), Object.keys(cab0.layout)),
  JSON.stringify(Object.keys(fSingle))
);
ok('C3 单行写侧 units 就是原数组（不重建、不重排）', fSingle.units === cab0.layout.units);

const nearly = structuredClone(cab0);
nearly.layout.rows = [{ id: SINGLE_ROW_ID, height: 'fill', units: cab0.layout.units }];
const fNearly = toFileLayout(nearly.layout);
ok('C4 内存里带 1 行 rows 的单行柜也会塌回 units（不写冗余 rows）', !('rows' in fNearly) && fNearly.units === cab0.layout.units);

const multi = case2Cabinet('cab_multi');
const fMulti = toFileLayout(multi.layout);
ok('C5 多行写侧写出 rows（2 行）', Array.isArray(fMulti.rows) && fMulti.rows.length === 2);
ok(
  'C6 多行写侧**刻意不写 units**（旧读者必须拒绝，而不是把第一行当整柜算尺寸）',
  !('units' in fMulti)
);
ok('C7 多行写侧的 rows 内容与原 rows 相同', same(fMulti.rows, multi.layout.rows));

const projMulti = projectWith(multi);
const beforeJSON = JSON.stringify(projMulti);
const fileView = toFileProject(projMulti);
ok('C8 toFileProject 不改动入参（写视图不是就地规范化）', JSON.stringify(projMulti) === beforeJSON);
ok(
  'C9 toFileProject 输出里该柜只有 rows、没有 units',
  !('units' in fileView.cabinets[0].layout) && Array.isArray(fileView.cabinets[0].layout.rows)
);

// ─────────────────── D. 多行读写往返 + 非法行必须被拒 ───────────────────

console.log('\n── D. 多行往返 + 非法行在门口被拒（每条拒绝规则都有正样本对照）──');

const rawMulti = serializeProjectFile(projMulti, SAVED_AT);
const parsedMulti = parseProjectFile(rawMulti);
ok('D1 多行文件能解析', parsedMulti.ok, parsedMulti.ok ? '' : parsedMulti.error);
if (parsedMulti.ok) {
  ok('D2 多行文件往返逐字节相同', serializeProjectFile(parsedMulti.project, SAVED_AT) === rawMulti);
  /**
   * 注意判据的粒度：文件里当然到处是 "units" 字样（`rows[].units` 就是分区数组）。
   * 这里要证的是 **layout 顶层没有 units 镜像** —— 所以必须解析出来看键，
   * 而不是全文搜字符串（第一次就是这么写错的，被这条断言自己抓住）。
   */
  const layoutKeysMulti = Object.keys(
    (JSON.parse(rawMulti) as { project: { cabinets: Array<{ layout: Record<string, unknown> }> } }).project.cabinets[0]!.layout
  );
  ok(
    'D3 多行文件的 layout 顶层没有 units 镜像（键序 type,widthMode,rows）',
    same(layoutKeysMulti, ['type', 'widthMode', 'rows']),
    JSON.stringify(layoutKeysMulti)
  );
  const rowsD = layoutRows(parsedMulti.project.cabinets[0].layout);
  ok(
    'D4 读回来的行数与行高对得上（480 / fill）',
    rowsD.length === 2 && rowsD[0]!.height === 480 && rowsD[1]!.height === 'fill',
    rowsD.map((r) => String(r.height)).join(',')
  );
  ok(
    'D5 canonicalUnits 读回的是最上面一行（rows[0]）',
    canonicalUnits(parsedMulti.project.cabinets[0].layout)[0]?.id === 'unit_201',
    String(canonicalUnits(parsedMulti.project.cabinets[0].layout)[0]?.id)
  );
  ok('D6 allUnits 覆盖两行全部分区（1 + 3 = 4）', allUnits(parsedMulti.project.cabinets[0].layout).length === 4);
  ok('D7 isMultiRow = true', isMultiRow(parsedMulti.project.cabinets[0].layout) === true);
}

/** 在合法多行文件上做定向破坏，得到负样本（避免手搓样本时写错别的地方） */
const mutateRows = (fn: (rows: Array<Record<string, unknown>>) => void): string => {
  const e = JSON.parse(rawMulti) as { project: { cabinets: Array<{ layout: { rows: Array<Record<string, unknown>> } }> } };
  fn(e.project.cabinets[0]!.layout.rows);
  return JSON.stringify(e);
};
const unitIdsOf = (r: Array<Record<string, unknown>>, i: number) => (r[i] as { units: Array<{ id: string }> }).units;

/**
 * 负样本判据必须精确到**原因**，不能只看"被拒了"。
 * 一次真实教训：破坏 A 处让 B 处的检查先说话，断言照样绿 —— 而那条规则其实坏的。
 * 所以每条负样本都断言报错文案里的关键词。
 */
const rejectWhy = (raw: string, expect: RegExp): string | null => {
  const err = reject(raw);
  if (err === null) return '竟然通过了（负样本失效）';
  return expect.test(err) ? null : `被拒了，但不是因为这个原因：${err}`;
};

ok('D8 rows = [] 被拒（至少保留一行）', rejectWhy(mutateRows((r) => { r.length = 0; }), /rows 是空的/) === null, rejectWhy(mutateRows((r) => { r.length = 0; }), /rows 是空的/) ?? '');
ok('D9 行缺少 id 被拒', rejectWhy(mutateRows((r) => { delete (r[0] as { id?: string }).id; }), /有行缺少 id/) === null);
ok('D10 行 id 重复被拒', rejectWhy(mutateRows((r) => { r[1]!.id = r[0]!.id; }), /行 id 重复/) === null);
ok('D11 height = 0 被拒', rejectWhy(mutateRows((r) => { r[0]!.height = 0; }), /height 必须是正整数或 'fill'/) === null);
ok('D12 height = -100 被拒', rejectWhy(mutateRows((r) => { r[0]!.height = -100; }), /height 必须是正整数或 'fill'/) === null);
ok('D13 height = 1.5（浮点）被拒 —— 生产尺寸里禁止浮点', rejectWhy(mutateRows((r) => { r[0]!.height = 1.5; }), /height 必须是正整数或 'fill'/) === null);
ok("D14 height = 'auto'（未知字面量）被拒", rejectWhy(mutateRows((r) => { r[0]!.height = 'auto'; }), /height 必须是正整数或 'fill'/) === null);
ok('D15 行的 units = [] 被拒（空行不是柜子）', rejectWhy(mutateRows((r) => { unitIdsOf(r, 0).length = 0; }), /分区是空的/) === null);
ok('D16 行缺少 units 被拒', rejectWhy(mutateRows((r) => { delete (r[0] as { units?: unknown }).units; }), /分区是空的/) === null);
ok(
  'D17 跨行撞分区 id 被拒（板件 id 由分区派生 → 撞名 = 清单少板件 = 下错料）',
  rejectWhy(mutateRows((r) => { unitIdsOf(r, 1)[0]!.id = unitIdsOf(r, 0)[0]!.id; }), /row_002 的分区 id 重复：unit_201/) === null,
  reject(mutateRows((r) => { unitIdsOf(r, 1)[0]!.id = unitIdsOf(r, 0)[0]!.id; })) ?? ''
);
ok(
  'D18 正样本对照：把撞车的 id 改成新名后**通过**（D17 不是恒真）',
  reject(mutateRows((r) => { unitIdsOf(r, 1)[0]!.id = 'unit_999'; })) === null,
  reject(mutateRows((r) => { unitIdsOf(r, 1)[0]!.id = 'unit_999'; })) ?? ''
);
ok("D19 正样本对照：height 用 'fill' 或正整数都合法", reject(mutateRows((r) => { r[0]!.height = 480; r[1]!.height = 'fill'; })) === null);

// 第三方工具可能同时写 rows 和过期的 units 镜像 —— 必须能打开，但要说清以谁为准
const staleMirror = mutateRows(() => { /* 保留 rows 不动 */ });
const staleObj = JSON.parse(staleMirror) as { project: { cabinets: Array<{ layout: { units?: unknown } }> } };
staleObj.project.cabinets[0]!.layout.units = [{ id: 'unit_stale', kind: 'open', requestedWidth: 100 }];
const staleParsed = parseProjectFile(JSON.stringify(staleObj));
ok('D20 rows 与过期 units 镜像并存时仍能打开（rows 权威）', staleParsed.ok);
ok(
  'D21 但必须留下 warning，且说清"以 rows 为准"（不许静默选一个）',
  staleParsed.ok && staleParsed.warnings.some((w) => w.includes('rows')),
  staleParsed.ok ? JSON.stringify(staleParsed.warnings) : ''
);
ok(
  'D22 warning 不是挡箭牌：读回来的第一行仍来自 rows，不是那个过期镜像',
  staleParsed.ok && canonicalUnits(staleParsed.project.cabinets[0]!.layout)[0]?.id === 'unit_201',
  staleParsed.ok ? String(canonicalUnits(staleParsed.project.cabinets[0]!.layout)[0]?.id) : ''
);

// ─────────────────── E. 未知可选字段（降级/回滚护栏）───────────────────

console.log('\n── E. 未知可选字段：旧代码降级不炸、序列化不当清理器 ──');

const unknownObj = JSON.parse(rawA) as Record<string, unknown> & {
  project: Record<string, unknown> & { cabinets: Array<Record<string, unknown>> };
};
unknownObj.project['assemblies'] = [{ id: 'asm_001', memberIds: ['cab_001'] }];
unknownObj.project['futureProjectField'] = { anything: true };
(unknownObj.project.cabinets[0]!['layout'] as Record<string, unknown>)['futureLayoutField'] = 42;
const parsedUnknown = parseProjectFile(JSON.stringify(unknownObj));
ok('E1 未知可选字段不影响打开（未来字段/未来装配不炸旧读者）', parsedUnknown.ok, parsedUnknown.ok ? '' : parsedUnknown.error);
if (parsedUnknown.ok) {
  const round = serializeProjectFile(parsedUnknown.project, SAVED_AT);
  ok(
    'E2 未知字段原样保留（序列化不是清理器，不许"顺手规范化"）',
    /"assemblies"/.test(round) && /"futureProjectField"/.test(round) && /"futureLayoutField"/.test(round)
  );
  ok('E3 未知字段没把形状搞乱：单行柜仍不写 rows', !/"rows"/.test(round));
}

// ─────────────────── 汇总 ───────────────────

console.log(`\n${'─'.repeat(60)}`);
if (fail === 0) {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log('P0 迁移成立：存量文件逐字节不动、派生骨架与基线逐值相同、rows/units 只有一个口径、非法行在门口被拒。');
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log(`失败项：${failures.join('、')}`);
  process.exitCode = 1;
}
