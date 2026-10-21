/**
 * ══════════════════════════════════════════════════════════════════════
 * 视图缓存性能回归验收（2026-10-21）
 *
 * ── 这次优化的是什么 ──
 *   拖动预览时每次鼠标移动都要重画整幅四视图图幅。
 *   实测（120 柜，预热后）：
 *     generateProject 56.9ms，其中 buildProjectViews 43.2ms（76%）
 *     ⇒ 拖动一帧 52.4ms ≈ 19 FPS —— 明显掉帧。
 *
 *   优化后：
 *     buildProjectViews 43.2 → 11.3ms（3.8×）
 *     generateProject  56.9 → 18.4ms（3.1×）
 *     拖动一帧        52.4 → 19.9ms（2.6×）
 *
 * ── 为什么可以缓存 ──
 *   buildCabinetViews 的四个 mapper 全是 (fx + X, fy + Z) 的**纯平移**，
 *   几何计算与 fx/fy 无关；
 *   而拖动改的是 placement，placement **不进** buildCabinetViews。
 *   所以「按柜子内容 + 排布位置」缓存整个 ViewSet 是安全的。
 *
 * ── 本验收守什么 ──
 *   1. **缓存不能改变任何结果**（图元/指纹/布局逐位一致）
 *   2. **失效边界正确**：改尺寸/加分区必须重画，改落位不需要
 *   3. **性能不会退化**（拖动一帧保持在门槛内）
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
import { buildProjectViews } from '../src/core/geometry/views.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import type { Project, RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

/** 造一个 n 个柜的项目（每房一排，柜互不相同以免缓存键撞车）。 */
function buildProject(n: number): Project {
  const project = emptyProject({ name: 'perf', ruleSetId: rules.id, id: 'perf' });
  const room = rectRoom({ name: 'R', x: 0, y: 0, w: 20000 + n * 900, h: 6000, thickness: 120, height: 2700 });
  project.rooms.push(room);
  for (let i = 0; i < n; i++) {
    project.cabinets.push(createCabinet({
      id: `c${i}`, name: `柜${i}`, roomId: room.id, x: 100 + i * 900, y: 60, rotation: 0, rules,
      params: { width: 800, height: 2400, depth: 600, bodyLift: 80, cabinetType: 'base', mountHeight: 0 },
      units: [{
        id: `u${i}`, kind: 'shelves', requestedWidth: 800, nickname: 'u',
        shelves: { count: 4, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 },
      }],
    }));
  }
  return project;
}

/** 整个 ProjectViewSet 的快照（用于逐位比对）。 */
function snapshot(vs: ReturnType<typeof buildProjectViews>): string {
  return JSON.stringify({
    prims: vs.prims.map((p) => JSON.stringify(p)),
    keys: vs.sourceKeys,
    placements: vs.placements,
    titles: vs.titles,
    bbox: vs.bbox,
    pickLines: vs.pickLines,
  });
}

// ═══════════════ 1. 缓存不能改变结果 ═══════════════
section('1. 缓存命中后结果必须逐位一致');
{
  const project = buildProject(8);
  const first = buildProjectViews(project, rules);
  const second = buildProjectViews(project, rules);   // 第二次命中缓存
  ok('★ 缓存命中后图元逐位一致', snapshot(first) === snapshot(second));
  ok('★ 图元数量一致', first.prims.length === second.prims.length, `${first.prims.length} vs ${second.prims.length}`);
  ok('★ 指纹逐位一致', JSON.stringify(first.sourceKeys) === JSON.stringify(second.sourceKeys));
  ok('★ 排布位置一致', JSON.stringify(first.placements) === JSON.stringify(second.placements));
  ok('★ 整幅 bbox 一致', JSON.stringify(first.bbox) === JSON.stringify(second.bbox));
  ok('★ 拾取线一致', JSON.stringify(first.pickLines) === JSON.stringify(second.pickLines));
}

// ═══════════════ 2. 失效边界 ═══════════════
section('2. 失效边界：改内容要重画，改落位不用');
{
  const project = buildProject(4);
  const base = buildProjectViews(project, rules);

  // 改落位（拖动）—— 图纸视图按柜子内容画，不该变
  const moved = JSON.parse(JSON.stringify(project)) as Project;
  moved.cabinets[1]!.placement.x = 9999;
  moved.cabinets[1]!.placement.y = 8888;
  const afterMove = buildProjectViews(moved, rules);
  ok('★ 改 placement（拖动）后视图不变 —— 可复用', snapshot(base) === snapshot(afterMove));

  // 改尺寸 —— 必须重画
  const resized = JSON.parse(JSON.stringify(project)) as Project;
  resized.cabinets[1]!.params.width = 900;
  const afterResize = buildProjectViews(resized, rules);
  ok('★ 改 params.width 后视图变了 —— 正确失效', snapshot(base) !== snapshot(afterResize));

  // 加分区 —— 必须重画
  const added = JSON.parse(JSON.stringify(project)) as Project;
  added.cabinets[1]!.layout.units.push({
    id: 'unew', kind: 'shelves', requestedWidth: 800, nickname: 'n',
    shelves: { count: 2, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 },
  });
  const afterAdd = buildProjectViews(added, rules);
  ok('★ 加分区后视图变了 —— 正确失效', snapshot(base) !== snapshot(afterAdd));
}

// ═══════════════ 3. 性能不退化 ═══════════════
section('3. 性能：拖动一帧保持在门槛内');
{
  const project = buildProject(120);
  // 预热（第一次调用要建缓存，且 JIT 需要预热）
  for (let i = 0; i < 5; i++) generateProject(project, rules);
  const t0 = process.hrtime.bigint();
  const RUNS = 20;
  for (let i = 0; i < RUNS; i++) generateProject(project, rules);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / RUNS;
  console.log(`      实测 generateProject（120 柜，缓存热）= ${ms.toFixed(2)} ms`);
  /**
   * ★ 门槛怎么定 ──
   *   优化前是 56.9ms，优化后 18.4ms。
   *   门槛取 35ms —— 留了近 2 倍余量（机器波动 + CI 更慢），
   *   但**明确低于**优化前的 56.9ms：一旦有人把缓存去掉，这里会红。
   */
  ok('★ 120 柜的 generateProject（缓存热）< 35 ms（优化前 56.9 ms）', ms < 35, `${ms.toFixed(1)} ms`);
}

// ═══════════════ 4. 修法本身的结构断言 ═══════════════
section('4. 修法本身：缓存键必须含内容与位置，且不含 placement');
{
  const viewsSrc = readFileSync(join(here, '..', 'src', 'core', 'geometry', 'views.ts'), 'utf8');
  ok('★ 存在视图缓存', viewsSrc.includes('LOCAL_VIEW_CACHE'));
  ok('★ 存在指纹缓存', viewsSrc.includes('SOURCE_KEY_CACHE'));
  ok('★ 缓存键含柜子内容指纹', viewsSrc.includes('cabinetContentKey(cab)'));
  /**
   * ★ 缓存键必须含**排布位置 fx**——
   *   指纹含坐标，位置不同指纹就不同；
   *   键里少了 fx ⇒ 不同位置的同一只柜会共用一份指纹 ⇒ 指纹错。
   *
   *   这里查的是**具体表达式**，不是「源码里出现过 fx」。
   */
  ok('★ 缓存键含排布位置（fx 参与 key）',
    viewsSrc.includes("cabinetContentKey(cab) + '@' + fx"),
    viewsSrc.match(/cabinetContentKey\(cab\)[^\n]*/)?.[0] ?? '');
  /**
   * ★ 上限要查**值**而不是「有没有」——
   *   把 256 改成 100000 也是「有上限」，但等于没限。
   *   门槛：上限必须**小于等于 512**（256 是设计值，留一倍余量）。
   */
  const maxMatch = /LOCAL_VIEW_CACHE_MAX\s*=\s*(\d+)/.exec(viewsSrc);
  ok('★ 缓存上限存在且 <= 512（不会无限涨）',
    !!maxMatch && Number(maxMatch[1]) <= 512,
    maxMatch ? `上限 ${maxMatch[1]}` : '找不到上限');
  /**
   * ★ 缓存键**绝不能**含 placement ──
   *   拖动改的就是 placement；键里带了它 ⇒ 每次拖动都缓存未命中 ⇒ 优化白做。
   *   这条断言钉住「键的来源是 cabinetContentKey」而不是整个 cabinet。
   */
  const keyFn = /function cabinetContentKey\([^)]*\): string \{([\s\S]*?)\n\}/.exec(viewsSrc);
  ok('★ 缓存键的函数存在', !!keyFn);
  if (keyFn) {
    ok('★ ★ 缓存键不含 placement', !keyFn[1]!.includes('placement'), keyFn[1]!.slice(0, 120));
    ok('★ 缓存键含 params（尺寸变了要失效）', keyFn[1]!.includes('params'));
    ok('★ 缓存键含 layout.units（加分区要失效）', keyFn[1]!.includes('layout.units'));
  }
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`视图缓存性能验收：通过 ${pass} 项，失败 0 项`);
  console.log('全部通过：缓存不改变结果、失效边界正确、性能保持在线。');
} else {
  console.log(`视图缓存性能验收：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
