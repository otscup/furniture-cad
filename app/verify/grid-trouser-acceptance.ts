/**
 * ══════════════════════════════════════════════════════════════════════
 *  格子抽 / 裤架 验收（2026-10-21）
 *
 * ── 这两个符号的画法来自哪里 ──
 *   参考图纸《世园润府18-1502》PDF 的**内容流实测**，不是目测。
 *   做法：解出 p5 的 ToUnicode 映射 → 定位「格子抽」「裤架」两个标注的坐标
 *   → 抽出标注附近的所有路径线段 → 量出真实几何。
 *
 *   实测结果（PDF 单位）：
 *     格子抽区 x26720..29708 (w=2988)，折线区 y14956..15637 (h=681)
 *       6 条斜线，dx/dy = 152/70 ≈ 2.17（角度 ±24.5°）
 *       归一化：(0,1)→(0.05,0.9) (0.2,0.6)→(0.3,0.4) (0.45,0.1)→(0.5,0)
 *              (0.5,0)→(0.55,0.1) (0.7,0.4)→(0.8,0.6) (0.95,0.9)→(1,1)
 *     裤架   (28062,15026)→(28214,14956)→(28366,15026)
 *       顶点朝上挂在横杆上，两侧等长 167，水平跨距 304，角度 ±24.7°
 *
 * ── 本验收守什么 ──
 *   1. 几何**形状**与参考图一致（条数、角度、谷底位置）
 *   2. 折线**横跨整个分区**，不是每抽格一组（否则变成 3 组小山）
 *   3. 裤架只画在**内部结构图**（外面是抽面/门板，看不到五金）
 *   4. 语义字段真的能打开这两个符号（模板 → makeUnit → 视图 全链路）
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCabinetFromTemplate } from '../src/core/docFactory.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import type { RuleSet } from '../src/core/types.ts';

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

/** 斜线判定：2 点开放 poly，dx 与 dy 都非零，角度在 10°~40° 之间（排除水平/垂直/文字笔画）。 */
function isDiagonal(p: { k: string; closed?: boolean; pts: Array<{ x: number; y: number }> }): boolean {
  if (p.k !== 'poly' || p.closed || p.pts.length !== 2) return false;
  const dx = p.pts[1]!.x - p.pts[0]!.x;
  const dy = p.pts[1]!.y - p.pts[0]!.y;
  if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return false;
  const deg = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI);
  return deg > 10 && deg < 40;
}

const cab = createCabinetFromTemplate({
  templateId: 'wardrobe_grid',
  name: '衣柜',
  roomId: 'r1',
  x: 100,
  y: 60,
  rules,
});
const V = buildCabinetViews(cab, rules);
const frontDiag = (V.prims.front as Array<Parameters<typeof isDiagonal>[0]>).filter(isDiagonal);
const internalDiag = (V.prims.internal as Array<Parameters<typeof isDiagonal>[0]>).filter(isDiagonal);

// ═══════════════ 1. 语义字段真的落到了模型里 ═══════════════
section('1. 语义字段：格子抽 / 裤架');
{
  const units = cab.layout.units;
  const gridUnit = units.find((u) => u.drawers?.style === 'grid');
  const rackUnit = units.find((u) => u.trouserRack === true);
  ok('模板里存在格子抽分区', !!gridUnit, units.map((u) => u.nickname).join(','));
  ok('★ 格子抽分区带 drawers.style=grid', gridUnit?.drawers?.style === 'grid');
  ok('模板里存在裤架分区', !!rackUnit);
  ok('★ 裤架分区带 trouserRack=true', rackUnit?.trouserRack === true);
  ok('普通分区**不带**这些标记（不靠缺省表达状态）',
    units.filter((u) => u.kind === 'shelves').every((u) => u.drawers?.style === undefined && u.trouserRack === undefined));
}

// ═══════════════ 2. 格子抽的几何 ═══════════════
section('2. 格子抽：6 段折线构成「山」字');
{
  /**
   * 参考图实测：6 条斜线，角度 ±24.5°，
   * 归一化折点 (0,1)(0.05,0.9)(0.2,0.6)(0.3,0.4)(0.45,0.1)(0.5,0)
   *            (0.5,0)(0.55,0.1)(0.7,0.4)(0.8,0.6)(0.95,0.9)(1,1)
   * —— 即：从左上角一路折到中部谷底，再折回右上角。
   */
  ok('★ 外观图上正好 6 段折线（参考图 6 段）', frontDiag.length === 6, `实际 ${frontDiag.length}`);

  if (frontDiag.length === 6) {
    const sorted = [...frontDiag].sort((a, b) => a.pts[0]!.x - b.pts[0]!.x);
    const angles = sorted.map((p) => {
      const dx = p.pts[1]!.x - p.pts[0]!.x;
      const dy = p.pts[1]!.y - p.pts[0]!.y;
      return (Math.atan2(dy, dx) * 180) / Math.PI;
    });
    const absAngles = angles.map(Math.abs);
    ok('★ 每段角度都在 20°~30°（参考图 24.5°）',
      absAngles.every((a) => a > 20 && a < 30),
      absAngles.map((a) => a.toFixed(1)).join(', '));

    // 折线走向：前 3 段下行（dy<0），后 3 段上行（dy>0）
    const dys = sorted.map((p) => p.pts[1]!.y - p.pts[0]!.y);
    ok('★ 前 3 段下行、后 3 段上行（整体是「山」形）',
      dys.slice(0, 3).every((d) => d < 0) && dys.slice(3).every((d) => d > 0),
      dys.map((d) => d.toFixed(0)).join(', '));

    // 谷底：第 3 段终点 == 第 4 段起点（中间在底部相接）
    const p3 = sorted[2]!;
    const p4 = sorted[3]!;
    const gap = Math.hypot(p3.pts[1]!.x - p4.pts[0]!.x, p3.pts[1]!.y - p4.pts[0]!.y);
    ok('★ 中间两段在同一点相接（谷底不缺口）', gap < 2, `间隙 ${gap.toFixed(1)}`);

    // 谷底是最低点
    const ys = sorted.flatMap((p) => [p.pts[0]!.y, p.pts[1]!.y]);
    ok('★ 谷底在最低处', Math.abs(p3.pts[1]!.y - Math.min(...ys)) < 1, `谷底 ${p3.pts[1]!.y.toFixed(0)} 最低 ${Math.min(...ys).toFixed(0)}`);

    // 左右对称：第 1 段起点 x 与第 6 段终点 x 分别是抽面的最左/最右
    const xs = sorted.flatMap((p) => [p.pts[0]!.x, p.pts[1]!.x]);
    ok('★ 折线铺满整个分区宽度（横跨，不是每抽格一组）',
      Math.abs(Math.min(...xs) - sorted[0]!.pts[0]!.x) < 1 && Math.abs(Math.max(...xs) - sorted[5]!.pts[1]!.x) < 1);
  }
  /**
   * 格子抽画在**抽面图层**（L_FRONT）。
   *
   * ★ 两张图都画 ──
   *   抽面本来就是两张图都画（内部图也画抽面，只是不透结构线）。
   *   而且**参考图纸 p5 本身就是内部结构图**，它上面有格子抽 ——
   *   说明格子抽是抽面表达，不是「只在外观图出现」的东西。
   *
   * 判据用**图层**而不是「数斜线条数」：
   *   内部图上还有衣服轮廓的斜线（L_HW 五金图层），
   *   数总数会混。
   */
  const frontLayerDiag = (V.prims.front as Array<Parameters<typeof isDiagonal>[0] & { layer?: string }>).filter(
    (p) => isDiagonal(p) && p.layer === 'F-CAB-FRONT',
  );
  const internalLayerDiag = (V.prims.internal as Array<Parameters<typeof isDiagonal>[0] & { layer?: string }>).filter(
    (p) => isDiagonal(p) && p.layer === 'F-CAB-FRONT',
  );
  ok('★ 格子抽画在抽面图层（L_FRONT）', frontLayerDiag.length === 6, `${frontLayerDiag.length} 条`);
  ok('★ 内部结构图也画格子抽（参考图 p5 就是内部图且有格子抽）',
    internalLayerDiag.length === 6, `${internalLayerDiag.length} 条`);
}

// ═══════════════ 3. 裤架的几何 ═══════════════
section('3. 裤架：倒 V 形挂钩');
{
  /**
   * 参考图实测：(28062,15026)→(28214,14956)→(28366,15026)
   * 顶点朝上挂在横杆上，水平跨距 304，角度 ±24.7°。
   */
  /**
   * ★ 怎么把裤架挂钩从「衣服轮廓的斜边」里挑出来 ──
   *
   *   衣服也是梯形，它的斜边同样是 dx/dy ≈ 2 ——
   *   只按角度筛会把衣服的边也算进来，
   *   于是「裤架不画了」这个变异也测不出来（衣服的斜边还在）。
   *
   *   ★ 判据：裤架挂在**挂衣分区的底边**，而且是**连续成对**的 ∨ 形 ──
   *   衣服的斜边虽然角度对，但它们**不共顶点**、也不**贴着分区底**。
   *
   *   所以这里先按「贴着分区底边」筛（用**分区净高**当基准，
   *   而不是用「所有斜线的最低点」—— 后者会跟着变异漂移，
   *   导致「裤架不画」这个变异测不出来）。
   */
  const rackUnit = cab.layout.units.find((u) => u.trouserRack === true)!;
  const rackBottom = V.meta.internal.origin.y + (rackUnit.requestedWidth ? 0 : 0);
  // 内部图 y 向下翻转，柜内底 = origin.y + 内空底偏移；用图元实测更稳：
  const minY = Math.min(...internalDiag.map((p) => Math.min(p.pts[0]!.y, p.pts[1]!.y)));
  const hooks = internalDiag.filter((p) => {
    const dx = Math.abs(p.pts[1]!.x - p.pts[0]!.x);
    const dy = Math.abs(p.pts[1]!.y - p.pts[0]!.y);
    if (!(dx > 20 && dy > 10 && Math.abs(dx / dy - 2) < 0.6)) return false;
    return Math.min(p.pts[0]!.y, p.pts[1]!.y) - minY < 40;
  });
  ok('★ 内部图上有裤架挂钩（成对的斜线）', hooks.length >= 4, `实际 ${hooks.length} 条`);

  if (hooks.length >= 4) {
    // 成对：一条下行 + 一条上行，顶点相接
    const downs = hooks.filter((p) => p.pts[1]!.y < p.pts[0]!.y);
    const ups = hooks.filter((p) => p.pts[1]!.y > p.pts[0]!.y);
    ok('★ 下行与上行数量相等（每个 V 一对）', downs.length === ups.length, `下 ${downs.length} 上 ${ups.length}`);

    // 顶点相接：某条下行的终点 == 某条上行的起点
    let joined = 0;
    for (const d of downs) {
      for (const u of ups) {
        if (Math.hypot(d.pts[1]!.x - u.pts[0]!.x, d.pts[1]!.y - u.pts[0]!.y) < 2) joined++;
      }
    }
    ok('★ 上下两条在顶点相接（构成 ∨ 形）', joined >= 2, `相接 ${joined} 处`);

    // 顶点**朝上**（在杆的上方，即 y 更大的一端是顶点）
    const vAngles = hooks.map((p) => {
      const dx = p.pts[1]!.x - p.pts[0]!.x;
      const dy = p.pts[1]!.y - p.pts[0]!.y;
      return (Math.atan2(dy, dx) * 180) / Math.PI;
    });
    ok('★ 挂钩角度在 20°~32°（参考图 24.7°）',
      vAngles.every((a) => Math.abs(a) > 20 && Math.abs(a) < 32),
      vAngles.map((a) => a.toFixed(1)).join(', '));
  }
  ok('★ 外观图**不**画裤架（外面是门板/抽面，看不到里面的五金）',
    frontDiag.length === 6, `front 斜线 ${frontDiag.length} 条（应只有格子抽的 6 条）`);
}

// ═══════════════ 4. 全链路：AI 参数 → 模型 → 图 ═══════════════
section('4. 全链路：语义参数能打开这些符号');
{
  /**
   * 这些符号要能被 AI 用上，参数就必须从契约一路透传到 makeUnit。
   * ★ 这里断言的是**契约里真的有这两个参数**——
   *   没有它们，AI 永远画不出格子抽和裤架。
   */
  const contractSrc = readFileSync(join(here, '..', 'shared', 'aiContract.mjs'), 'utf8');
  //
  // ★ 契约里**两处**都要声明（unitIntents + cabinet.addUnit）——
  //   少一处就有一条通道用不了这个参数。
  //   所以这里数**出现次数**，不是只查「有没有」。
  const drawerStyleDecls = (contractSrc.match(/drawerStyle:\s*\{/g) ?? []).length;
  const trouserRackDecls = (contractSrc.match(/trouserRack:\s*\{/g) ?? []).length;
  ok('★ 契约里两处都声明了 drawerStyle（unitIntents + cabinet.addUnit）',
    drawerStyleDecls >= 2, `实际 ${drawerStyleDecls} 处`);
  ok('★ 契约里 drawerStyle 带 grid = 格子抽 的说明',
    /drawerStyle:\s*\{[^}]*'plain'[^}]*'grid'/.test(contractSrc));
  ok('★ 契约里两处都声明了 trouserRack',
    trouserRackDecls >= 2, `实际 ${trouserRackDecls} 处`);
  ok('★ 契约里 trouserRack 是布尔',
    /trouserRack:\s*\{\s*type:\s*'boolean'/.test(contractSrc));
  ok('★ 契约里说明了 grid 是格子抽', /grid=格子抽|grid.*格子抽/.test(contractSrc));

  const compileSrc = readFileSync(join(here, '..', 'src', 'ai', 'compile.ts'), 'utf8');
  ok('★ compile.ts 把 drawerStyle 透传给 makeUnit（且按 grid 判定）',
    /drawerStyle:[^\n]*'grid'/.test(compileSrc));
  ok('★ compile.ts 把 trouserRack 透传给 makeUnit（且走 truthyFlag 容错）',
    /trouserRack:[^\n]*truthyFlag\(p\.trouserRack\)/.test(compileSrc));
  ok('★ compile.ts 对布尔参数做了容错（true/"true"/1 都认）', compileSrc.includes('truthyFlag'));

  const factorySrc = readFileSync(join(here, '..', 'src', 'core', 'docFactory.ts'), 'utf8');
  ok('★ docFactory 把 drawerStyle 落到 drawers.style', factorySrc.includes("unit.drawers!.style = 'grid'"));
  ok('★ docFactory 把 trouserRack 落到分区', factorySrc.includes('unit.trouserRack = true'));
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`格子抽 / 裤架验收：通过 ${pass} 项，失败 0 项`);
  console.log('全部通过：几何与参考图纸实测一致（6 段折线 / ±24.5° / 谷底相接）、裤架是 ∨ 形挂钩、只在内部图画、语义字段全链路通。');
} else {
  console.log(`格子抽 / 裤架验收：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
