/**
 * ══════════════════════════════════════════════════════════════════════
 *  P5 验收 —— 图片识别（Vision）人机协作识别链路
 *
 *  文档 P5 定的出口判据：**效果图/截图 → Vision Model → 结构识别 →
 *  NormalizedDesign → 不确定项 → 用户确认 → Semantic Model → CAD（2D/3D/DXF/BOM）**。
 *
 *  ── 这批断言在防什么 ──
 *
 *  ① **Vision 绕过 Semantic Model / CommandBus。** 识别结果必须经
 *     visionResultToNormalized → compileImport → dryRunPlan → commitPlan 落模型，
 *     与 JSON/DXF 导入同权同位，不新造写入口。
 *
 *  ② **Vision 直接编坐标 / 直接出 DXF。** 编译出的动作不许带 atX/atY；
 *     落位由 pickFreeSpot 定；图片坐标/像素比例不进生产尺寸。
 *
 *  ③ **Vision 编造看不见的生产结构。** 真实深度 / 板厚 / 隐藏隔板 / 内部不可见
 *     一律进 caveats（用户确认后才生成），绝不静默写成确定值；模糊到数不清
 *     柜体数量 → 进 questions（硬阻断）。
 *
 *  ④ **视觉估计被当成真实尺寸下料。** 无标注时尺寸 source='estimate'，必须带
 *     「视觉估计」caveat；有标注（scale.known）→ 无该 caveat，但仍标「真实深度」
 *     等看不见项。caveats 不阻断（IMPORT-CAVEAT，用户确认即可），uncertainty 仍硬阻断。
 *
 *  ⑤ **落库的柜没有 provenance / 派生不出来。** 提交后 Cabinet.origin.source
 *     === 'imageVision'，且 origin.uncertainty 含诚实项（审计留痕）；并能经
 *     computeCabinetLayout 派生出几何（2D/3D/DXF/BOM 同源可读）。
 *
 *  ⑥ **旧项目被改坏。** 导入前旧柜一条不少，新柜追加。
 *
 *  ⑦ **报错不带真实值，被兜底值顶替成假绿。** IMPORT-CAVEAT / IMPORT-OPEN-QUESTIONS
 *     的 message 必须含喂进去的真实文本（"视觉估计" / "柜体数量"…），只断言 /\d/ 会被骗。
 *
 *  验收用 MockVisionProvider（确定性、无网络/key）跑通完整闭环；真实 API 走
 *  RemoteVisionProvider → 服务端 /api/ai/vision（复用 baseUrl/key），不在本脚本内联网。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Project, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { compileImport } from '../src/ai/import/compileImport.ts';
import { importBlocked, validateNormalized } from '../src/ai/import/normalized.ts';
import { analyzeImageToNormalized, MockVisionProvider } from '../src/ai/vision/index.ts';
import { dryRunPlan, commitPlan } from '../src/ai/planRunner.ts';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '..');
const rules = JSON.parse(readFileSync(join(APP, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(title: string): void {
  console.log(`\n【${title}】`);
}
const eq = (label: string, a: unknown, b: unknown): void =>
  ok(label, JSON.stringify(a) === JSON.stringify(b), `实际 ${JSON.stringify(a)} ｜ 期望 ${JSON.stringify(b)}`);

// ═════════════════ 夹具 ═══════════════════════
const base = (): Project => JSON.parse(JSON.stringify(sampleProject(rules))) as Project;
const roomOf = (p: Project): string => p.rooms[0]!.id;

async function main(): Promise<void> {
  const provider = new MockVisionProvider();

  // ── A. 识别多柜 / rows / units / 组件 / 组合关系（main fixture，无尺寸标注）──
  section('A. 识别柜体数 / rows / units / 组件 / 组合');
  {
    const { result, design } = await analyzeImageToNormalized(provider, { image: 'mock://main', hint: 'fixture:main' }, {});
    ok('识别出 3 个柜体区域', result.cabinets.length === 3, `实际 ${result.cabinets.length}`);
    eq('归一化柜体数一致', design.cabinets.length, 3);
    ok('两条并排 relation 共享成员 → 合并为 1 个 assembly', (design.assemblies?.length ?? 0) === 1, `实际 ${design.assemblies?.length}`);
    ok('assembly 是纯分组（不带 connections —— 物理连接图片不可见，不编造）', (design.assemblies?.[0]?.connections ?? null) === null, JSON.stringify(design.assemblies?.[0]));
    ok('组合成员含全部 3 柜', (design.assemblies?.[0]?.members?.length ?? 0) === 3, JSON.stringify(design.assemblies?.[0]?.members));
    // 高柜有上下 rows：上排抽屉 + 下排挂衣
    ok('高柜有上下 rows', design.cabinets[0]!.rows !== null);
    eq('高柜下排为挂衣区', design.cabinets[0]!.rows![1]!.units[0]!.kind, 'hanging');
    // 中间抽屉柜单行 units（3 个抽屉区）
    ok('中间柜有左右 units（单行）', design.cabinets[1]!.units !== null);
    eq('中间柜 3 个抽屉区', design.cabinets[1]!.units!.length, 3);
    eq('中间柜抽屉区 kind=drawerBank', design.cabinets[1]!.units![0]!.kind, 'drawerBank');
    // 置信度逐柜归属
    eq('开放格置信度 low', design.cabinets[2]!.confidence, 'low');
    // 真实深度看不见 → caveat
    ok('高柜 caveat 含「真实深度」', (design.cabinets[0]!.caveats ?? []).some((c) => c.includes('真实深度')));
    // 无标注 → 尺寸是视觉估计
    ok('无标注图 caveat 含「视觉估计」', (design.cabinets[0]!.caveats ?? []).some((c) => c.includes('视觉估计')));
  }

  // ── B. 诚实映射：不编造看不见的生产结构 ──
  section('B. 不编造看不见的生产结构');
  {
    const { design } = await analyzeImageToNormalized(provider, { image: 'mock://main', hint: 'fixture:main' }, {});
    // 高柜 notVisible 含 inner-partitions → 应有「内部隔板/层板图片不可见」caveat
    ok('高柜（内部不可见）caveat 含「内部隔板/层板图片不可见」', (design.cabinets[0]!.caveats ?? []).some((c) => c.includes('内部隔板/层板图片不可见')));
    // 中间抽屉柜 notVisible 不含 inner-partitions → 不应编造该 caveat
    ok('中间柜（内部可见）不编造「内部隔板」caveat', !(design.cabinets[1]!.caveats ?? []).some((c) => c.includes('内部隔板/层板图片不可见')));
    // 所有尺寸都是数字（没有 NaN / null 被当确定值）
    const allDims = design.cabinets.flatMap((c) => [c.width, c.height, c.depth]);
    ok('所有柜体尺寸都是数字', allDims.every((d) => typeof d === 'number' && Number.isFinite(d)));
    // depth 保留为估计值（不丢弃，也不当确定）
    ok('深度保留为估计值（非 null）', typeof design.cabinets[0]!.depth === 'number');
  }

  // ── C. caveats 非阻断：IMPORT-CAVEAT 暴露、uncertainty 不硬卡 ──
  section('C. caveats 非阻断（用户确认即可生成）');
  {
    const { design } = await analyzeImageToNormalized(provider, { image: 'mock://main', hint: 'fixture:main' }, {});
    const p = base();
    const issues = validateNormalized(design, p);
    ok('抛出 IMPORT-CAVEAT（非阻断，诚实项可见）', issues.some((i) => i.code === 'IMPORT-CAVEAT'));
    ok('IMPORT-CAVEAT 带真实文本「视觉估计」', issues.some((i) => i.code === 'IMPORT-CAVEAT' && i.message.includes('视觉估计')));
    ok('P5 走 caveats，不触发硬阻断的 IMPORT-UNCERTAINTY', !issues.some((i) => i.code === 'IMPORT-UNCERTAINTY'));
    ok('caveats 不阻断应用（importBlocked=false）', importBlocked(issues) === false);
    const compiled = compileImport(design, p, rules);
    ok('caveats 下仍可编译成动作（等用户确认）', compiled.ok, compiled.blockedReason ?? '');
  }

  // ── D. 完整闭环：编译→干跑→确认→落模型，且不出坐标，旧项目兼容 ──
  section('D. 闭环：编译 → 干跑 → 确认 → Semantic Model（不出坐标 / 旧柜保留）');
  let visCabRef: string | null = null;
  {
    const p = base();
    const bus = new CommandBus(p, rules);
    const room = roomOf(p);
    const before = bus.getState().cabinets.length;
    const { design } = await analyzeImageToNormalized(provider, { image: 'mock://main', hint: 'fixture:main' }, { room });
    visCabRef = design.cabinets[0]!.ref;
    const compiled = compileImport(design, bus.getState(), rules);
    ok('编译成功', compiled.ok, compiled.blockedReason ?? '');
    ok('编译出 4 条动作（3 柜 + 1 合并组合）', compiled.actions.length === 4, `实际 ${compiled.actions.length}`);
    const json = JSON.stringify(compiled.actions);
    ok('动作里没有 atX / atY（落位由系统定，图片坐标不进生产）', !/"atX"|"atY"/.test(json));
    ok('动作里没有 connections（物理连接不编造）', !json.includes('"connections"'));
    const run = dryRunPlan({ bus, actions: compiled.actions, gate: null });
    eq('干跑无失败', run.errorCount, 0);
    const outcome = commitPlan(run, bus);
    ok('提交成功', outcome.ok, outcome.ok ? '' : outcome.error);
    eq('提交动作数 = 柜数 + 组合数', outcome.applied, 4);
    eq('真模型新增 3 柜（旧柜保留）', bus.getState().cabinets.length, before + 3);
    const oldKept = before === 0 || bus.getState().cabinets.slice(0, before).every((c) => c.id);
    ok('导入前旧柜一条不少', oldKept);
  }

  // ── E. 落库 provenance + 派生可生成（2D/3D/DXF/BOM 同源可读）──
  section('E. 落库 provenance + 可派生几何');
  {
    const p = base();
    const bus = new CommandBus(p, rules);
    const { design } = await analyzeImageToNormalized(provider, { image: 'mock://main', hint: 'fixture:main' }, { room: roomOf(p) });
    const compiled = compileImport(design, bus.getState(), rules);
    const run = dryRunPlan({ bus, actions: compiled.actions, gate: null });
    commitPlan(run, bus);
    const visCab = bus.getState().cabinets.find((c) => c.origin?.source === 'imageVision');
    ok('存在来源为 imageVision 的柜', visCab !== undefined);
    if (visCab) {
      eq('origin.source = imageVision', visCab.origin?.source, 'imageVision');
      ok('origin.uncertainty 含诚实项「真实深度」（审计留痕）', (visCab.origin?.uncertainty ?? []).some((u) => u.includes('真实深度')));
      const derived = computeCabinetLayout(visCab, rules);
      ok('能派生几何 rows（2D/3D/DXF/BOM 可读）', derived.rows.length > 0);
      ok('能派生分区净宽 nets', derived.nets.length > 0);
    }
  }

  // ── F. 模糊图 → questions 硬阻断（不编造柜体数量）──
  section('F. 模糊图 → questions 硬阻断');
  {
    const { design } = await analyzeImageToNormalized(provider, { image: 'mock://amb', hint: 'fixture:ambiguous' }, {});
    ok('模糊图识别出 0 个柜体', design.cabinets.length === 0);
    ok('模糊图抛出 2 个必须回答的问题', (design.questions ?? []).length === 2, `实际 ${design.questions?.length}`);
    const issues = validateNormalized(design, base());
    ok('validateNormalized 报 IMPORT-OPEN-QUESTIONS', issues.some((i) => i.code === 'IMPORT-OPEN-QUESTIONS'));
    ok('IMPORT-OPEN-QUESTIONS 带真实文本「柜体数量」', issues.some((i) => i.code === 'IMPORT-OPEN-QUESTIONS' && i.message.includes('柜体数量')));
    ok('questions 硬阻断应用', importBlocked(issues) === true);
    const compiled = compileImport(design, base(), rules);
    ok('模糊图不能编译成可执行动作', compiled.ok === false);
  }

  // ── G. 有尺寸标注 → 高可信，但仍标看不见项 ──
  section('G. 有标注高可信（scale.known）');
  {
    const { result, design } = await analyzeImageToNormalized(provider, { image: 'mock://ann', hint: 'fixture:annotated' }, {});
    ok('scale.known = true', result.scale?.known === true);
    eq('标注柜置信度 high', design.cabinets[0]!.confidence, 'high');
    eq('标注尺寸 source=annotation', result.cabinets[0]!.width?.source, 'annotation');
    const cav = design.cabinets[0]!.caveats ?? [];
    ok('有标注图仍标「真实深度」caveat（深度看不见）', cav.some((c) => c.includes('真实深度')));
    ok('有标注图不编造「视觉估计」caveat', !cav.some((c) => c.includes('视觉估计')));
  }

  // ── H. 提供参考尺寸 → scale 升格（演示 hint 不写真值）──
  section('H. 用户给参考尺寸 → scale 升格（仍不编造）');
  {
    const { result } = await analyzeImageToNormalized(provider, { image: 'mock://main', hint: 'fixture:main', knownScaleMm: 2400 }, {});
    ok('带 knownScaleMm → scale.known=true', result.scale?.known === true);
    ok('参考尺寸写入 scale.referenceMm', result.scale?.referenceMm === 2400);
  }

  console.log(`\n通过 ${pass} · 失败 ${fail}`);
  if (fail > 0) {
    console.log('失败项：\n - ' + failures.join('\n - '));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('vision-acceptance 运行异常：', e);
  process.exit(1);
});
