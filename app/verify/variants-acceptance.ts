import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import * as CMD from '../src/core/commands.ts';
import {
  PLACEMENT_BLOCKING_CODES,
  adoptVariant,
  buildVariants,
  defaultVariant,
  noPresetReason,
  placeVariant,
  topIssue,
} from '../src/core/variants.ts';
import { candidateSpots } from '../src/core/snapPlace.ts';
import type { VariantDraft, VariantSpec } from '../src/core/variants.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  方案候选验收 —— 「先出正面图 → 出两个风格 → 选完再出四视图」
 *
 *  这个脚本要证明的不是"能造出几份方案"，而是三件容易做错的事：
 *
 *   ① **中间产物是候选语义模型，不是正面图。**
 *      取的是正视图还是侧视图，光看"有图元"是看不出来的 ——
 *      所以断言正视图图框的**宽度必须等于柜宽而不是柜深**（侧视图宽 = 柜深）。
 *
 *   ② **风格只改分格，不许改规格。**
 *      三份方案的宽/高/深必须逐字相同。风格是"怎么分"，不是"多大"。
 *
 *   ③ **候选不是模型，采用时 id 必须换。**
 *      候选里的 `unit_001` 与项目里已有的 `unit_001` 会撞 ——
 *      而这种撞法**不报错**，它只是静默地让两个分区共用一条记录。这必须有断言看着。
 *
 *  另有一条重要的**正向**价值断言：方案自带 issue，
 *  所以"客户选风格的时候就能看到门板超宽"，不用选完才发现。
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

function section(t: string): void {
  console.log(`\n${t}`);
}

const SPEC: VariantSpec = { name: '主卧衣柜', width: 2400, height: 2400, depth: 600, roomId: 'room_001' };
const variants = buildVariants(SPEC, rules);
const byId = (id: string): VariantDraft | undefined => variants.find((v) => v.presetId === id);

// ───────────────────────── A. 预设的形状 ─────────────────────────

section('A. 规则集里的风格预设');

const presets = rules.stylePresets ?? [];
ok('规则集配置了 stylePresets', presets.length >= 2, `实际 ${presets.length} 条`);
ok('每条预设都有 id 与中文名', presets.every((p) => Boolean(p.id) && Boolean(p.nameZh)), JSON.stringify(presets.map((p) => p.id)));
ok(
  '每条预设的分区比例都为正（0 会静默退化成默认分区，必须显式配）',
  presets.every((p) => (p.units ?? []).every((u) => u.ratio > 0)),
  JSON.stringify(presets.map((p) => (p.units ?? []).map((u) => u.ratio)))
);

// ───────────────────────── B. 候选的基本性质 ─────────────────────────

section('B. 规格 → 候选方案');

ok('每个预设产出一份候选', variants.length === presets.length, `${variants.length} vs ${presets.length}`);

/**
 * 分区 id 必须在柜内唯一 —— 这是一次真实缺陷留下的断言。
 *
 * `unitsFromPreset` 当初没给 `makeUnit` 传 `takenIds`，于是**每个分区都叫 unit_001**。
 * 板件 id 是 `…_unit_00N_SH1` 拼出来的，三个分区同名就让多块板撞成同一个 id：
 * 校验器报 `DUP-PANEL-ID`，而清单里两块不同的板会变成一块 —— **到了生产就是下错料**。
 * 这种撞法在任何一层都不报错，只是静默共用一条记录。
 * 而「通体四门」只有一个分区，所以这个缺陷在它身上完全看不出来 ——
 * 下面第二条断言就是为了防止"只有单分区方案"时这条变成空断言。
 */
ok(
  '【关键】每份候选的分区 id 在本柜内唯一（三个分区都叫 unit_001 会让板件 id 撞车）',
  variants.every((v) => new Set(v.cabinet.layout.units.map((u) => u.id)).size === v.cabinet.layout.units.length),
  JSON.stringify(variants.map((v) => v.cabinet.layout.units.map((u) => u.id)))
);
ok(
  '至少有一份候选是多个分区（否则上面那条是空断言）',
  variants.some((v) => v.cabinet.layout.units.length > 1),
  JSON.stringify(variants.map((v) => v.cabinet.layout.units.length))
);
ok(
  '没有任何候选报 DUP-PANEL-ID（板件清单里两块不同的板不许变成一块）',
  variants.every((v) => !v.issues.some((i) => i.code === 'DUP-PANEL-ID')),
  JSON.stringify(variants.flatMap((v) => v.issues.filter((i) => i.code === 'DUP-PANEL-ID').map((i) => `${v.presetId}:${i.target}`)))
);
ok('每份候选都没有派生错误', variants.every((v) => !v.error), JSON.stringify(variants.filter((v) => v.error).map((v) => [v.presetId, v.error])));
ok('每份候选都派出了非空的正视图', variants.every((v) => v.front.length > 0), JSON.stringify(variants.map((v) => [v.presetId, v.front.length])));

ok(
  '【铁律】风格只改分格，不改规格：三份候选的宽/高/深逐字等于规格',
  variants.every((v) => v.cabinet.params.width === 2400 && v.cabinet.params.height === 2400 && v.cabinet.params.depth === 600),
  JSON.stringify(variants.map((v) => [v.presetId, v.cabinet.params.width, v.cabinet.params.height, v.cabinet.params.depth]))
);

ok(
  '【铁律】候选不在任何项目里（id 带 variant__ 前缀）',
  variants.every((v) => v.cabinet.id.startsWith('variant__')),
  JSON.stringify(variants.map((v) => v.cabinet.id))
);

ok(
  '分区请求宽之和 === 柜宽（余量归属到最后一个分区，不许差 1mm）',
  variants.every((v) => v.cabinet.layout.units.reduce((a, u) => a + u.requestedWidth, 0) === 2400),
  JSON.stringify(variants.map((v) => [v.presetId, v.cabinet.layout.units.reduce((a, u) => a + u.requestedWidth, 0)]))
);

ok('每份候选都给出了一眼可辨的结构摘要', variants.every((v) => v.summary.length > 0), JSON.stringify(variants.map((v) => v.summary)));

// ───────────────────────── C. 取的是正视图，不是别的视图 ─────────────────────────

section('C. 正面图确实是正视图（不是侧视图 / 俯视图）');

/**
 * 正视图图框：宽 = 柜宽(2400)，高 = 柜高(2400)。
 * 侧视图图框：宽 = 柜深(600)，高 = 柜高(2400)。
 * 俯视图图框：宽 = 柜宽(2400)，高 = 柜深(600)。
 * —— 三个视图两两可区分，所以这一组断言能钉死"取的是哪一个"。
 */
for (const v of variants) {
  const b = v.frontBox;
  const w = b ? Math.round(b.max.x - b.min.x) : -1;
  const h = b ? Math.round(b.max.y - b.min.y) : -1;
  ok(`「${v.nameZh}」图框宽 = 柜宽 2400（不是柜深 600 → 证明取的是正视图不是侧视图）`, w === 2400, `w=${w}`);
  ok(`「${v.nameZh}」图框高 = 柜高 2400（不是柜深 600 → 证明取的是正视图不是俯视图）`, h === 2400, `h=${h}`);
}

// ───────────────────────── D. 风格之间必须真的不同 ─────────────────────────

section('D. 不同风格给出不同的分格');

const unitCounts = variants.map((v) => v.cabinet.layout.units.length);
ok('各方案的分区数不全相同（否则"选风格"就是假的）', new Set(unitCounts).size >= 2, JSON.stringify(unitCounts));

const doorCounts = variants.map((v) => v.cabinet.layout.units.reduce((a, u) => a + (u.doors?.count ?? 0), 0));
ok('各方案的门扇配置不全相同', new Set(doorCounts).size >= 2, JSON.stringify(doorCounts));

const full = byId('STYLE_FULL_FRONT');
const three = byId('STYLE_THREE_PART');
ok('「通体四门」是 1 个满宽分区', full?.cabinet.layout.units.length === 1, JSON.stringify(full?.summary));
ok('「三段分格」是 3 个分区', three?.cabinet.layout.units.length === 3, JSON.stringify(three?.summary));
ok(
  '「通体四门」带门板，「三段分格」只在层板区带门 —— 分格方式确实不同',
  Boolean(full?.cabinet.layout.units[0].doors) && three?.cabinet.layout.units.filter((u) => u.doors).length === 1,
  JSON.stringify([full?.cabinet.layout.units.map((u) => u.doors?.count ?? 0), three?.cabinet.layout.units.map((u) => u.doors?.count ?? 0)])
);

// ───────────────────────── E. 方案自带问题：选风格时就看得见 ─────────────────────────

section('E. 每份候选自带 problem list（客户选风格时就看得见）');

const wide = buildVariants({ ...SPEC, width: 3600 }, rules).find((v) => v.presetId === 'STYLE_FULL_FRONT')!;
/**
 * 注意：这里断言的是"**包含** RULE-DOOR-MAX-WIDTH"，不是"topIssue 就是它"。
 * 3600mm 宽会同时触发好几个 ERROR（板件超幅面排在前），topIssue 返回的是**第一条** ERROR。
 * 第一次写这条断言时写成 `topIssue(...)?.code === 'RULE-DOOR-MAX-WIDTH'` 而失败 ——
 * 那次失败是断言自己写错，不是产品缺陷。
 */
ok(
  '3600mm 宽 + 通体四门 → 单扇门约 895mm，必然触发 RULE-DOOR-MAX-WIDTH',
  wide.issues.some((i) => i.code === 'RULE-DOOR-MAX-WIDTH'),
  JSON.stringify(wide.issues.map((i) => i.code))
);
ok(
  'topIssue 返回 ERROR 优先于 WARNING（没有 ERROR 时才给 WARNING）',
  topIssue(wide)?.severity === 'ERROR',
  JSON.stringify(topIssue(wide)?.code)
);

ok(
  '2400mm 宽 + 通体四门 → 单扇约 588mm，不超 600mm 上限（证明上面的报错不是"一律报错"）',
  !byId('STYLE_FULL_FRONT')?.issues.some((i) => i.code === 'RULE-DOOR-MAX-WIDTH'),
  JSON.stringify(byId('STYLE_FULL_FRONT')?.issues.map((i) => i.code))
);

// ───────────────────────── F. 负样本 ─────────────────────────

section('F. 负样本');

const noPreset: RuleSet = JSON.parse(JSON.stringify(rules));
delete noPreset.stylePresets;
ok('规则集没配 stylePresets → 返回空数组（不许悄悄编一套风格出来）', buildVariants(SPEC, noPreset).length === 0);
ok('没配风格时给出的理由非空且点名了规则集', noPresetReason(noPreset).includes('stylePresets'), noPresetReason(noPreset));

const zeroRatio: RuleSet = JSON.parse(JSON.stringify(rules));
zeroRatio.stylePresets = [{ id: 'STYLE_BAD', nameZh: '比例全零', units: [{ kind: 'shelves', ratio: 0 }] }];
ok(
  '比例全为 0 的预设 → 不崩，退回默认分区（而不是产出 0 宽的分区）',
  (() => {
    const list = buildVariants(SPEC, zeroRatio);
    const u = list[0]?.cabinet.layout.units ?? [];
    return list.length === 1 && u.length > 0 && u.every((x) => x.requestedWidth > 0);
  })(),
  JSON.stringify(buildVariants(SPEC, zeroRatio).map((v) => v.cabinet.layout.units.map((u) => u.requestedWidth)))
);

ok(
  '「默认分区」对照物能造出来（用于确认预设真的覆盖了默认行为）',
  defaultVariant(SPEC, rules).layout.units.length > 0
);

// ───────────────────────── G. 采用：id 必须换 ─────────────────────────

section('G. 采用一份候选 → 落地');

const bus = new CommandBus(sampleProject(rules), rules);
const projectBefore = bus.getState();
const vBefore = bus.getVersion();

const adopted: Cabinet = adoptVariant(variants[0], projectBefore);
ok('采用后柜体 id 不再是候选占位 id', !adopted.id.startsWith('variant__'), adopted.id);
ok(
  '采用后柜体 id 不与项目里已有的撞',
  !projectBefore.cabinets.some((c) => c.id === adopted.id),
  `${adopted.id} vs ${JSON.stringify(projectBefore.cabinets.map((c) => c.id))}`
);

const existingUnitIds = new Set(projectBefore.cabinets.flatMap((c) => c.layout.units.map((u) => u.id)));
ok(
  '【关键】采用后分区 id 不与项目里已有的撞 —— 撞了不报错，只是静默共用一条记录',
  adopted.layout.units.every((u) => !existingUnitIds.has(u.id)),
  `${JSON.stringify(adopted.layout.units.map((u) => u.id))} vs ${JSON.stringify([...existingUnitIds])}`
);
ok('采用后分区 id 在本柜内也不重复', new Set(adopted.layout.units.map((u) => u.id)).size === adopted.layout.units.length);
ok(
  '采用只换 id，不改尺寸与分格',
  adopted.params.width === variants[0].cabinet.params.width &&
    adopted.layout.units.length === variants[0].cabinet.layout.units.length &&
    adopted.layout.units.every((u, i) => u.kind === variants[0].cabinet.layout.units[i].kind)
);

const adopted2: Cabinet = adoptVariant(variants[1], { ...projectBefore, cabinets: [...projectBefore.cabinets, adopted] });
ok('连续采用两份得到两个不同 id', adopted2.id !== adopted.id, `${adopted.id} / ${adopted2.id}`);

section('H. 落地之后四视图能派生出来');

ok('采用前 buildVariants 不改动模型（纯函数）', bus.getVersion() === vBefore, `v${vBefore} → v${bus.getVersion()}`);

const r1 = bus.execute(CMD.createCabinet(adopted));
ok('createCabinet 命令成功', r1.ok === true, JSON.stringify(r1.error ?? ''));
ok('模型版本 +1', bus.getVersion() === vBefore + 1, `v${bus.getVersion()}`);

const after: Project = bus.getState();
ok('项目里的柜体数 +1', after.cabinets.length === projectBefore.cabinets.length + 1, `${after.cabinets.length}`);
ok(
  '落地后的柜体 id 就是采用时生成的那个',
  after.cabinets.some((c) => c.id === adopted.id),
  JSON.stringify(after.cabinets.map((c) => c.id))
);

const geom = generateProject(after, rules);
ok(
  '四视图能从落地后的模型派生出来（每个柜体都有图幅落点）',
  after.cabinets.every((c) => Boolean(geom.views.placements[c.id])),
  JSON.stringify(Object.keys(geom.views.placements))
);
ok(
  '派生出的视图图元非空',
  geom.views.prims.length > 0,
  `prims=${geom.views.prims.length}`
);

// ══════════════════════════════════════════════════════════
section('I. 采用时的落点：候选自己没有位置，落地前必须先找到放得下的地方');

/**
 * 这一组是一次**真实缺陷**留下的。
 *
 * 候选柜体建在 (0,0)（对比阶段不需要位置），而默认项目里 `cab_001` 在 (400,60)、
 * 南墙内表面也在 y=60 —— 于是采用时**必然**同时撞墙和撞柜，被记忆门拦下。
 * 界面上只说一句"被记忆拦住"，用户第一次点「采用这个方案」就失败了。
 *
 * 而这个缺陷在**原本这一整套 41 项里一条都抓不到**：候选是孤立校验的，
 * 不参与项目级干涉检查。所以这里必须用与界面完全相同的判据（CommandBus 干跑）
 * 在新的一份 sampleProject 上重跑一遍"点采用"这条路径。
 */
const busI = new CommandBus(sampleProject(rules), rules);
const projI = busI.getState();

/** 与界面 adopt() 里逐字相同的判据 —— 换一份实现就相当于又造了一个真相源 */
const fitsIn = (trial: Cabinet): boolean => {
  const r = busI.execute(CMD.createCabinet(trial), { dryRun: true });
  if (!r.ok) return false;
  return !r.newIssues.some((i) => i.severity === 'ERROR' && PLACEMENT_BLOCKING_CODES.has(i.code));
};

const spotsI = candidateSpots(projI, 'room_001', 2400);
ok('房间给出了"一串"可试落点（不是一个 —— 一个位置撞了就没得换）', spotsI.length > 1, `${spotsI.length} 个`);
ok(
  '每个落点都真的贴到了某面墙上（不是凭空编的坐标）',
  spotsI.every((s) => Boolean(s.wallId)),
  JSON.stringify(spotsI.slice(0, 3).map((s) => [s.wallId, s.x, s.y]))
);

const rawCab: Cabinet = adoptVariant(variants[0], projI);
ok(
  '【缺陷复现】候选自带的位置 (0,0) 在默认项目里放不下（它既撞墙又撞 cab_001）',
  fitsIn(rawCab) === false,
  `placement=${JSON.stringify(rawCab.placement)}`
);

const placedI = placeVariant(rawCab, projI, fitsIn);
ok('placeVariant 找得到一个放得下的落点', placedI !== null);
ok(
  '找到的落点贴到了墙上（说得出是哪面墙）',
  Boolean(placedI?.wallName),
  String(placedI?.wallName)
);
ok(
  '找到的落点确实通过了干跑（不是"找了但没验"）',
  Boolean(placedI) && fitsIn(placedI!.cabinet),
  JSON.stringify(placedI?.cabinet.placement)
);
ok(
  '落点只改 placement，不动尺寸与分格（找位置不是重新设计）',
  Boolean(placedI) &&
    placedI!.cabinet.params.width === rawCab.params.width &&
    placedI!.cabinet.layout.units.length === rawCab.layout.units.length &&
    placedI!.cabinet.layout.units.every((u, i) => u.id === rawCab.layout.units[i].id),
  JSON.stringify(placedI?.cabinet.placement)
);

const vI = busI.getVersion();
const rI = placedI ? busI.execute(CMD.createCabinet(placedI.cabinet)) : null;
ok('沿着找到的落点真的落地成功（不再被记忆门拦下）', rI?.ok === true, String(rI?.error ?? '(没有落点)'));
ok('落地后模型版本 +1', busI.getVersion() === vI + 1, `v${vI} → v${busI.getVersion()}`);
ok(
  '落地后项目里没有新增撞墙 / 撞柜的 ERROR',
  (() => {
    const g = generateProject(busI.getState(), rules);
    return !g.issues.some((i) => i.severity === 'ERROR' && PLACEMENT_BLOCKING_CODES.has(i.code));
  })(),
  JSON.stringify(
    generateProject(busI.getState(), rules)
      .issues.filter((i) => PLACEMENT_BLOCKING_CODES.has(i.code))
      .map((i) => `${i.code}|${i.target}`)
  )
);

// ── 负样本：房间塞不下时必须如实返回 null，不许退化成"先放进去再说" ──
const hugeSpec: VariantSpec = { ...SPEC, width: 9000 };
const hugeVariants = buildVariants(hugeSpec, rules);
const hugeCab: Cabinet = adoptVariant(hugeVariants[0], projI);
ok(
  '房间放不下时 placeVariant 返回 null（不许退化成按原位塞进去）',
  placeVariant(hugeCab, projI, fitsIn) === null,
  `width=${hugeCab.params.width}`
);

// ───────────────────────── 汇总 ─────────────────────────

console.log(`\n${'─'.repeat(60)}`);
if (fail === 0) {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log('方案候选成立：中间产物是候选语义模型而不是正面图，风格只改分格不改规格，采用时 id 必须换。');
} else {
  console.log(`通过 ${pass} 项，失败 ${fail} 项\n`);
  console.log(`失败项：${failures.join('、')}`);
  process.exitCode = 1;
}
