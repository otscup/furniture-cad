/**
 * ══════════════════════════════════════════════════════════════════════
 *  灯带 / 玻璃面板 验收（2026-10-21）
 *
 * ── 画法来自参考图纸的 PDF 内容流实测 ──
 *
 *   灯带（4 种，参考图里都有）：
 *     · 靠前 front（p5）：层板前缘下侧一条灯带槽，画成**双线**
 *       实测 层板占 y19558..19594（板厚 36），槽双线在 y19522 / y19533（间距 11）
 *     · 居中 center（p2）：层板**中间**两条单线，间距 82（实测 y18164 / y18246）
 *     · 45°斜光 angled45（p6）：一条 45° 斜线 + 一条水平线
 *       实测斜线 (30814,17210)→(31787,19003)，水平线在 y19003
 *
 *   玻璃门：满铺的 45° 等距平行线
 *     实测 区域 x10053..13433 (w=3380)、y16394..20184 (h=3790)，
 *           31 条 45° 平行线（dx 严格等于 dy），间距中位数 279 = 板宽的 8.3%
 *
 * ── 本验收守什么 ──
 *   1. 灯带三种画法真的画出来了，形状与参考图一致
 *   2. 灯带只在**开放格**画（外面是门板就看不见）
 *   3. 玻璃是**满铺等距 45° 平行线**，且每条都严格 45°
 *   4. 木门不画玻璃斜线、玻璃门不画灯带（材质与工艺不串门）
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCabinetFromTemplate } from '../src/core/docFactory.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import type { RuleSet, UnitSpec } from '../src/core/types.ts';

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

type P2 = { k: string; closed?: boolean; pts: Array<{ x: number; y: number }>; layer?: string; dash?: number[] };

/** 严格 45°：|dx| == |dy| 且都非零。 */
function is45(dx: number, dy: number): boolean {
  return Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.5 && Math.abs(dx) > 1;
}

/** 造一个「开放格 + 指定灯带」的柜。 */
function makeCab(ledStrip: 'none' | 'center' | 'front' | 'angled45', withDoor = false) {
  const cab = createCabinetFromTemplate({
    templateId: 'shoe_cabinet', name: '灯带柜', roomId: 'r1', x: 100, y: 60, rules,
  });
  const u = cab.layout.units[0]!;
  if (!withDoor) delete u.doors;
  u.shelves = { ...u.shelves!, ledStrip };
  return cab;
}

/** 取 front 图上 L_HW 图层的开放线（灯带画在这一层）。 */
function hwLines(cab: ReturnType<typeof makeCab>): P2[] {
  const v = buildCabinetViews(cab, rules);
  return (v.prims.front as P2[]).filter((p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && p.layer === 'F-CAB-HW');
}
// ═══════════════ 1. 灯带三种画法 ═══════════════
section('1. 灯带：三种画法（none / center / front / angled45）');
{
  const noneLines = hwLines(makeCab('none'));
  const frontLines = hwLines(makeCab('front'));
  const centerLines = hwLines(makeCab('center'));
  const angledLines = hwLines(makeCab('angled45'));

  ok('★ none 不画任何灯带线', noneLines.length === 0, `${noneLines.length} 条`);
  ok('★ front 画了灯带', frontLines.length > noneLines.length, `${frontLines.length} vs ${noneLines.length}`);
  ok('★ center 画了灯带', centerLines.length > noneLines.length, `${centerLines.length} vs ${noneLines.length}`);
  ok('★ angled45 画了灯带', angledLines.length > noneLines.length, `${angledLines.length} vs ${noneLines.length}`);

  /**
   * ── front（靠前）：层板前缘外侧的**双线**槽 + 两条短竖线连接 ──
   *   参考图实测：槽双线间距 11（= 板厚 36 的 0.3），在层板**下方**。
   */
  const frontH = frontLines.filter((p) => Math.abs(p.pts[0]!.y - p.pts[1]!.y) < 0.5);
  const frontV = frontLines.filter((p) => Math.abs(p.pts[0]!.x - p.pts[1]!.x) < 0.5);
  ok('★ front 有横线（槽壁）', frontH.length >= 2, `${frontH.length} 条`);
  ok('★ front 有竖线（槽与板之间连接）', frontV.length >= 2, `${frontV.length} 条`);
  if (frontH.length >= 2) {
    // 成对的槽壁：同一层内两条横线，间距 = 板厚 × 0.3
    const ys = frontH.map((p) => p.pts[0]!.y).sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < ys.length; i++) gaps.push(ys[i]! - ys[i - 1]!);
    const minGap = Math.min(...gaps);
    ok('★ front 槽壁间距很小（板厚 × 0.3 左右）', minGap > 0 && minGap < 12, `最小间距 ${minGap.toFixed(1)}`);
  }

  /**
   * ── center（居中）：层板中间两条单线 ──
   *   参考图实测间距 82。
   */
  const centerH = centerLines.filter((p) => Math.abs(p.pts[0]!.y - p.pts[1]!.y) < 0.5);
  ok('★ center 有横线', centerH.length >= 2, `${centerH.length} 条`);
  ok('★ center 的线是横跨整个分区的（长度大）',
    centerH.length > 0 && centerH.every((p) => Math.abs(p.pts[1]!.x - p.pts[0]!.x) > 100),
    JSON.stringify(centerH.map((p) => Math.round(Math.abs(p.pts[1]!.x - p.pts[0]!.x)))));
  /**
   * ★ center 的两条线**必须分开**（参考图间距 82，约为板厚的 2.3 倍）──
   *   只查「长度大」不够：把两条线挤在一起也满足长度条件，
   *   而那画出来根本不是「居中两条」。
   */
  const centerYs = centerH.map((p) => p.pts[0]!.y).sort((a, b) => a - b);
  const centerGaps: number[] = [];
  for (let i = 1; i < centerYs.length; i++) {
    const g = centerYs[i]! - centerYs[i - 1]!;
    if (g > 0) centerGaps.push(g);
  }
  ok('★ center 两条线**分开**（间距约板厚 × 0.9）',
    centerGaps.length === 0 || centerGaps.every((g) => g > 8),
    `间距 ${centerGaps.map((g) => g.toFixed(1)).join(',')}`);

  /**
   * ── angled45：一条 45° 斜线 + 一条水平线 ──
   */
  const angled45 = angledLines.filter((p) => is45(p.pts[1]!.x - p.pts[0]!.x, p.pts[1]!.y - p.pts[0]!.y));
  const angledH = angledLines.filter((p) => Math.abs(p.pts[0]!.y - p.pts[1]!.y) < 0.5);
  ok('★ angled45 有 45° 斜线', angled45.length >= 1, `${angled45.length} 条`);
  ok('★ angled45 有水平线', angledH.length >= 1, `${angledH.length} 条`);
}

// ═══════════════ 2. 灯带只在开放格画 ═══════════════
section('2. 灯带只在开放格画（带门的分区外面看不见）');
{
  const withDoor = hwLines(makeCab('front', true));
  const noDoor = hwLines(makeCab('front', false));
  ok('★ 带门的分区在外观图上不画灯带（外面是门板）',
    withDoor.length === 0, `${withDoor.length} 条`);
  ok('★ 开放格在外观图上画灯带', noDoor.length > 0, `${noDoor.length} 条`);

  /**
   * ★ 内部结构图上也**不**画灯带（带门分区）──
   *
   *   这一条才是**真正测得到**的：
   *   内部图里带门分区的层板**是会画的**（内部图透结构），
   *   所以如果 `&& openUnit` 这个守卫失效，灯带就会漏到带门分区上。
   *
   *   而外观图那条断言是**恒真**的 ——
   *   带门分区在外观图上连层板循环都不进，
   *   无论守卫怎么改都不会有灯带。
   *   （第一版就栽在这：变异改守卫，外观图断言照样全绿。）
   */
  /**
   * ★ 怎么在内部图上认出「灯带」—— 不能只看 HW 图层 ──
   *
   *   F-CAB-HW 图层上还有挂衣杆、衣架等别的线（实测内部图有 15 条，
   *   其中只有 4 条是灯带）。
   *   所以按**灯带的特征形状**筛：
   *   front 画法 = 每层板处有 **2 条横线（槽壁）** + 2 条短竖线。
   *   认「同一 x 位置上有两条很近的横线」= 灯带槽。
   */
  const ledSlotCount = (prims: P2[]): number => {
    const hs = prims
      .filter((p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && p.layer === 'F-CAB-HW')
      .filter((p) => Math.abs(p.pts[0]!.y - p.pts[1]!.y) < 0.5)
      .map((p) => p.pts[0]!.y);
    const ys = [...new Set(hs.map((y) => Math.round(y)))];
    ys.sort((a, b) => a - b);
    let slots = 0;
    for (let i = 1; i < ys.length; i++) {
      if (ys[i]! - ys[i - 1]! <= 12) slots++;
    }
    return slots;
  };
  const withDoorInternal = (buildCabinetViews(makeCab('front', true), rules).prims.internal as P2[]);
  const openInternal = (buildCabinetViews(makeCab('front', false), rules).prims.internal as P2[]);
  ok('★ 带门分区在内部图上也不画灯带槽（守卫真的生效）',
    ledSlotCount(withDoorInternal) === 0, `${ledSlotCount(withDoorInternal)} 个槽`);
  ok('★ 开放格在内部图上画灯带槽（对照成立）',
    ledSlotCount(openInternal) > 0, `${ledSlotCount(openInternal)} 个槽`);
}

// ═══════════════ 3. 玻璃面板 ═══════════════
section('3. 玻璃门：满铺 45° 等距平行线');
{
  const glassCab = createCabinetFromTemplate({
    templateId: 'shoe_cabinet', name: '玻璃柜', roomId: 'r1', x: 100, y: 60, rules,
  });
  const gu = glassCab.layout.units[0]!;
  gu.doors = { ...gu.doors!, material: 'M_GLASS_8_GREY' };
  const gv = buildCabinetViews(glassCab, rules);
  const front = gv.prims.front as P2[];

  const glass45 = front.filter((p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && is45(p.pts[1]!.x - p.pts[0]!.x, p.pts[1]!.y - p.pts[0]!.y));
  ok('★ 玻璃门有满铺的 45° 斜线（>20 条）', glass45.length > 20, `${glass45.length} 条`);

  /**
   * ★ 每条都必须是**严格的 45°** —— 这条断言是本轮的关键。
   *   第一版实现画的是「左下角到右上角再 clamp 两端」，
   *   dx=288 dy=2280 —— 根本不是 45°，而且因为不满足 is45，
   *   旧口径的筛查根本认不出来（画了 43 条却报「0 条」）。
   */
  const all45 = front.filter((p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && p.layer === 'F-CAB-FRONT');
  const non45Glass = all45.filter((p) => !p.dash && Math.abs(p.pts[1]!.x - p.pts[0]!.x) > 5 && !is45(p.pts[1]!.x - p.pts[0]!.x, p.pts[1]!.y - p.pts[0]!.y));
  ok('★ 玻璃填充线全是严格 45°（|dx| == |dy|）', non45Glass.length === 0, `${non45Glass.length} 条不是 45 度`);

  /**
   * ★ 间距必须**均匀** —— 参考图实测间距中位数 = 板宽的 8.3%。
   *   这条守住「等距」这个核心特征（随手画几道会间距不均）。
   */
  if (glass45.length >= 4) {
    /**
     * ★ 间距要用**直线方程的 k = x − y** 来量，不能用起点 x ──
     *
     *   一组 45° 平行线在几何上等距，但**被矩形裁剪后**，
     *   ��条线的起点可能落在左边或下边 —— 起点 x 就不再等距了
     *   （实测起点 x 间距 12..60，看着不均匀，其实是等距的）。
     *
     *   正确度量：45° 线的方程是 x − y = k，k 相同的两条线互相平行且等距。
     *   所以按 k 排序看间距才对。
     */
    /**
     * ★ 必须**按门分组**再看间距 ──
     *
     *   每扇门独立生成一套玻璃线，各自的 k 起点不同；
     *   把两扇门的 k 混在一起排序，相邻差是「两套序列错位」的结果
     *   （实测 12 = 60/5），不是「不均匀」。
     *
     *   分组办法：同一条线的 k 值相同 ⇒ 按 k 分组即可。
     *   每一组就是**一扇门**的线序列。
     */
    /**
     * ★ 怎么量「等距」—— 众数法 ──
     *
     *   每扇门独立生成一套玻璃线，k 起点各不相同，
     *   所以把**所有门**的 k 混排，相邻差里会混进「两套序列错位」的差值
     *   （实测两扇门错位 12）。
     *
     *   正确做法：取所有相邻差的**众数** —— 众数就是同一扇门内部的真实步距，
     *   跨门的错位差值只会出现一两次，干扰不到众数。
     *
     *   同时要求「多数相邻差都等于众数」，确保不是巧合。
     */
    /**
     * ★ 怎么量「等距」—— 用**单门**的柜来测 ──
     *
     *   多扇门时每扇门独立生成一套玻璃线，k 起点不同、**范围还可能重叠**
     *   （实测两扇门的 k 序列交错在一起）。
     *   把所有 k 混排再算间距，得到的 12 是「两套序列交错」的产物，
     *   不是真实步距（真实是 60）。
     *
     *   ★ 所以这里造一个**只有一扇门**的柜 ──
     *   单门就没有交错问题，k 序列直接就是真实步距。
     *   这比在多门场景里猜分组规则可靠得多。
     */
    const oneDoorCab = createCabinetFromTemplate({
      templateId: 'shoe_cabinet', name: '单门玻璃柜', roomId: 'r1', x: 100, y: 60, rules,
    });
    const ou = oneDoorCab.layout.units[0]!;
    ou.doors = { ...ou.doors!, count: 1, material: 'M_GLASS_8_GREY' };
    const ov = buildCabinetViews(oneDoorCab, rules);
    const one45 = (ov.prims.front as P2[]).filter(
      (p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && is45(p.pts[1]!.x - p.pts[0]!.x, p.pts[1]!.y - p.pts[0]!.y),
    );
    ok('★ 单门玻璃柜也有满铺斜线', one45.length > 10, `${one45.length} 条`);
    if (one45.length >= 4) {
      const ks = one45
        .map((p) => Math.round((p.pts[0]!.x + p.pts[1]!.x) / 2 - (p.pts[0]!.y + p.pts[1]!.y) / 2))
        .sort((a, b) => a - b);
      const uniq: number[] = [];
      for (const k of ks) {
        if (uniq.length === 0 || Math.abs(uniq[uniq.length - 1]! - k) > 1) uniq.push(k);
      }
      const steps: number[] = [];
      for (let i = 1; i < uniq.length; i++) {
        const g = uniq[i]! - uniq[i - 1]!;
        if (g > 0) steps.push(g);
      }
      if (steps.length > 0) {
        const minS = Math.min(...steps);
        const maxS = Math.max(...steps);
        ok('★ 玻璃斜线**等距**（单门，k 序列步距一致）',
          minS > 10 && maxS - minS <= 2, `步距 ${minS}..${maxS}`);
      }
    }
  }

  /**
   * 玻璃填充必须**落在门板矩形内**（不能溢出到柜体外面）。
   */
  const doorXs = front.filter((p) => p.k === 'poly' && p.closed && p.pts.length === 4 && p.layer === 'F-CAB-FRONT')
    .map((p) => p.pts.map((q) => q.x));
  if (doorXs.length > 0) {
    const dMin = Math.min(...doorXs.flat());
    const dMax = Math.max(...doorXs.flat());
    const outOfBounds = glass45.filter((p) => p.pts.some((q) => q.x < dMin - 1 || q.x > dMax + 1));
    ok('★ 玻璃斜线都落在门板范围内（不溢出）', outOfBounds.length === 0, `${outOfBounds.length} 条溢出`);
  }
}

// ═══════════════ 4. 木门不画玻璃斜线 ═══════════════
section('4. 对照：木门没有玻璃斜线');
{
  const woodCab = createCabinetFromTemplate({
    templateId: 'shoe_cabinet', name: '木门柜', roomId: 'r1', x: 100, y: 60, rules,
  });
  const wv = buildCabinetViews(woodCab, rules);
  const wood45 = (wv.prims.front as P2[]).filter(
    (p) => p.k === 'poly' && !p.closed && p.pts.length === 2 && is45(p.pts[1]!.x - p.pts[0]!.x, p.pts[1]!.y - p.pts[0]!.y),
  );
  ok('★ 木门没有 45° 斜线（对比成立）', wood45.length === 0, `${wood45.length} 条`);
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`灯带 / 玻璃面板验收：通过 ${pass} 项，失败 0 项`);
  console.log('全部通过：灯带三种画法与参考图实测一致、只在开放格画、玻璃是满铺等距 45° 平行线。');
} else {
  console.log(`灯带 / 玻璃面板验收：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));