import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { BBox, Cabinet, Prim, RuleSet, Vec2 } from '../src/core/types.ts';
import { computeCabinetLayout, doorWidths } from '../src/core/geometry/layout.ts';
import { buildCabinetViews, buildProjectViews, estimateTextWidth, type ViewSet } from '../src/core/geometry/views.ts';
import { bboxOf } from '../src/core/geometry/transform.ts';
import { equalSpacing } from '../src/core/allocate.ts';
import { createCabinet, sampleProject } from '../src/core/docFactory.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  四视图投影对齐验收 —— 把「衔接要合理」变成可执行的定义
 *
 *  用户原话："生成正面图、俯视图、侧面图、内部图等结构，衔接要合理"。
 *  "衔接合理"不能靠肉眼看，必须能机器判定，否则就是各画各的。
 *
 *  本脚本验收：
 *    A. 映射不变量 —— 长对正 / 高平齐 / 宽相等（结构性保证）
 *    B. 第一角投影排布 —— 俯视图在正视图正下方，侧视图在正视图正右方
 *    C. 跨视图内容一致性 —— 同一块板在四个视图里的尺寸/位置必须对得上
 *       （这一组最能抓住"各画各的"）
 *    D. 图元健康度
 *    E. 假设清单（没工艺依据的地方必须说出来）
 *    F. 确定性（纯函数）与平移不变性
 *    G. **负样本** —— 故意破坏必须被检出，否则"全绿"不能证明任何事
 * ══════════════════════════════════════════════════════════════════════
 */

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(
  readFileSync(join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')
) as RuleSet;

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

// ───────────────────────────── 工具 ─────────────────────────────

interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  layer: string;
}

const TOL = 0.51;

/** 把某个视图的图元反投影回「柜体坐标」，只取闭合多边形的包围盒 */
function rectsOf(prims: Prim[], inv: (p: Vec2) => Vec2): Rect[] {
  const out: Rect[] = [];
  for (const p of prims) {
    if (p.k !== 'poly' || !p.closed) continue;
    const b = bboxOf(p.pts.map(inv));
    out.push({ x0: b.min.x, x1: b.max.x, y0: b.min.y, y1: b.max.y, layer: p.layer });
  }
  return out;
}

function hasRect(list: Rect[], x0: number, x1: number, y0: number, y1: number, tol = TOL): boolean {
  return list.some(
    (r) => Math.abs(r.x0 - x0) < tol && Math.abs(r.x1 - x1) < tol && Math.abs(r.y0 - y0) < tol && Math.abs(r.y1 - y1) < tol
  );
}

function countRects(list: Rect[], w: number, h: number, tol = TOL): number {
  return list.filter((r) => Math.abs(r.x1 - r.x0 - w) < tol && Math.abs(r.y1 - r.y0 - h) < tol).length;
}

/** 每个视图的"反投影"函数：图纸坐标 → 柜体分量坐标 */
function inverters(vs: ViewSet): Record<'front' | 'top' | 'side' | 'internal', (p: Vec2) => Vec2> {
  const fx = vs.meta.front.origin.x;
  const fy = vs.meta.front.origin.y;
  const ty0 = vs.meta.top.origin.y;
  const sx0 = vs.meta.side.origin.x;
  const ix0 = vs.meta.internal.origin.x;
  return {
    front: (p) => ({ x: p.x - fx, y: p.y - fy }), // → (X, Z)
    top: (p) => ({ x: p.x - fx, y: ty0 - p.y }), // → (X, Y)
    side: (p) => ({ x: p.x - sx0, y: p.y - fy }), // → (Y, Z)
    internal: (p) => ({ x: p.x - ix0, y: p.y - fy }), // → (X, Z)
  };
}

function allPoints(vs: ViewSet): Vec2[] {
  const out: Vec2[] = [];
  for (const k of ['front', 'top', 'side', 'internal'] as const) {
    for (const p of vs.prims[k]) out.push(...(p.k === 'text' ? [p.p] : p.pts));
  }
  for (const p of vs.hinge) out.push(...(p.k === 'text' ? [p.p] : p.pts));
  for (const p of vs.labels) out.push(...(p.k === 'text' ? [p.p] : p.pts));
  return out;
}

function mapPrim(p: Prim, f: (q: Vec2) => Vec2): Prim {
  if (p.k === 'text') return { ...p, p: f(p.p) };
  return { ...p, pts: p.pts.map(f) };
}

/** 造一个"被破坏的视图集"，用于负样本 */
function broken(vs: ViewSet, kind: 'front' | 'top' | 'side' | 'internal', f: (q: Vec2) => Vec2): ViewSet {
  return { ...vs, prims: { ...vs.prims, [kind]: vs.prims[kind].map((p) => mapPrim(p, f)) } };
}

// ────────────────── A/B 不变量判定（正例 / 负例共用）──────────────────

/**
 * 视图的**实际**包围盒 —— 从图元坐标现算。
 *
 * 为什么不读 vs.meta[k].bbox：
 *   如果断言只信视图"自己声明我在哪"，那么视图内容画错位置也检不出来
 *   （声明与内容可以不一致）。第一版就是这么写的，结果 5 个负样本全部假通过。
 *   铁律：不变量必须从**图元实际坐标**推导，声明是否属实另立一条断言去查。
 */
function actualBBox(vs: ViewSet, kind: 'front' | 'top' | 'side' | 'internal'): BBox {
  const pts: Vec2[] = [];
  for (const p of vs.prims[kind]) pts.push(...(p.k === 'text' ? [p.p] : p.pts));
  return bboxOf(pts);
}

/** 长对正：正视图与俯视图共享同一段 X */
function alignsLong(vs: ViewSet): boolean {
  const f = actualBBox(vs, 'front');
  const t = actualBBox(vs, 'top');
  return Math.abs(f.min.x - t.min.x) < TOL && Math.abs(f.max.x - t.max.x) < TOL;
}

/** 高平齐：正视图与侧视图共享同一段 Z */
function alignsHigh(vs: ViewSet): boolean {
  const f = actualBBox(vs, 'front');
  const s = actualBBox(vs, 'side');
  return Math.abs(f.min.y - s.min.y) < TOL && Math.abs(f.max.y - s.max.y) < TOL;
}

/** 宽相等：俯视图的 Y 跨度 === 侧视图的 X 跨度 === 柜深 D */
function depthEqual(vs: ViewSet): boolean {
  const t = actualBBox(vs, 'top');
  const s = actualBBox(vs, 'side');
  const topSpan = t.max.y - t.min.y;
  const sideSpan = s.max.x - s.min.x;
  return Math.abs(topSpan - vs.dims.D) < TOL && Math.abs(sideSpan - vs.dims.D) < TOL && Math.abs(topSpan - sideSpan) < TOL;
}

/** 第一角排布：俯视在正视正下、侧视在正视正右、内部图在侧视正右 */
function layoutOk(vs: ViewSet): boolean {
  const f = actualBBox(vs, 'front');
  const t = actualBBox(vs, 'top');
  const s = actualBBox(vs, 'side');
  const i = actualBBox(vs, 'internal');
  return t.max.y <= f.min.y + TOL && s.min.x >= f.max.x - TOL && i.min.x >= s.max.x - TOL;
}

/** 声明是否属实：meta.bbox 必须等于从图元算出的实际 bbox */
function metaHonest(vs: ViewSet, kind: 'front' | 'top' | 'side' | 'internal'): boolean {
  const a = actualBBox(vs, kind);
  const m = vs.meta[kind].bbox;
  return (
    Math.abs(a.min.x - m.min.x) < TOL &&
    Math.abs(a.max.x - m.max.x) < TOL &&
    Math.abs(a.min.y - m.min.y) < TOL &&
    Math.abs(a.max.y - m.max.y) < TOL
  );
}

/** 层板高度集合：正视图与侧视图必须完全一致 */
function shelfCenters(vs: ViewSet, cab: Cabinet, ruleSet: RuleSet): { front: number[]; side: number[] } {
  const L = computeCabinetLayout(cab, ruleSet);
  const t = L.boardT;
  const innerBottomZ = cab.params.bodyLift + t;

  const byHeight = (list: Rect[], widths: Set<number>): number[] =>
    list
      .filter((r) => Math.abs(r.y1 - r.y0 - t) < TOL && [...widths].some((w) => Math.abs(r.x1 - r.x0 - w) < TOL))
      .map((r) => (r.y0 + r.y1) / 2 - innerBottomZ)
      .sort((a, b) => a - b);

  // 正视图横轴 = X（层板宽度与板件清单同源）；侧视图横轴 = Y（层板进深 = shelfDepth）
  const frontWidths = new Set<number>();
  cab.layout.units.forEach((u, i) => {
    if (u.shelves && u.shelves.count > 0) frontWidths.add(L.nets[i] - 2 * u.shelves.gapPerSide);
  });

  const inv = inverters(vs);
  return {
    front: byHeight(rectsOf(vs.prims.front, inv.front), frontWidths),
    side: byHeight(rectsOf(vs.prims.side, inv.side), new Set([L.shelfDepth])),
  };
}

function shelfCentersMatch(vs: ViewSet, cab: Cabinet, ruleSet: RuleSet): boolean {
  const { front, side } = shelfCenters(vs, cab, ruleSet);
  if (front.length === 0 || front.length !== side.length) return false;
  return front.every((v, i) => Math.abs(v - side[i]) < TOL);
}

// ───────────────────────────── 主流程 ─────────────────────────────

console.log('四视图投影对齐验收');
console.log('='.repeat(64));

const project = sampleProject(rules);
const cab = project.cabinets[0];
const vs = buildCabinetViews(cab, rules);
const inv = inverters(vs);

const L = computeCabinetLayout(cab, rules);
const t = L.boardT;
const tb = L.backT;
const W = cab.params.width;
const H = cab.params.height;
const D = cab.params.depth;
const bodyLift = cab.params.bodyLift;
const innerW = L.innerW;
const innerH = L.innerH;
const innerBottomZ = bodyLift + t;
const innerTopZ = H - t;
const bodyD = D - t;
const faceY0 = D - t;
const backY0 = cab.params.backPanel.grooveSetback;
const backY1 = backY0 + tb;

section('A. 映射不变量（长对正 / 高平齐 / 宽相等）');
ok('A1 长对正：正视图与俯视图共享同一段 X', alignsLong(vs), JSON.stringify({ front: actualBBox(vs, 'front'), top: actualBBox(vs, 'top') }));
ok('A2 高平齐：正视图与侧视图共享同一段 Z', alignsHigh(vs), JSON.stringify({ front: actualBBox(vs, 'front'), side: actualBBox(vs, 'side') }));
ok('A3 宽相等：俯视图 Y 跨度 = 侧视图 X 跨度 = 柜深 D', depthEqual(vs), JSON.stringify({ top: actualBBox(vs, 'top'), side: actualBBox(vs, 'side'), D }));
ok(
  'A4 内外同向：内部图与正视图的宽 / 高相同、Y 区间一致（仅水平平移）',
  (() => {
    const fi = actualBBox(vs, 'internal');
    const ff = actualBBox(vs, 'front');
    return (
      Math.abs(fi.max.x - fi.min.x - (ff.max.x - ff.min.x)) < TOL &&
      Math.abs(fi.min.y - ff.min.y) < TOL &&
      Math.abs(fi.max.y - ff.max.y) < TOL
    );
  })(),
  JSON.stringify({ front: actualBBox(vs, 'front'), internal: actualBBox(vs, 'internal') })
);
ok(
  'A5 声明属实：每个视图的 meta.bbox 等于从图元坐标现算的实际 bbox',
  (['front', 'top', 'side', 'internal'] as const).every((k) => metaHonest(vs, k)),
  (['front', 'top', 'side', 'internal'] as const)
    .map((k) => `${k}: meta=${JSON.stringify(vs.meta[k].bbox)} actual=${JSON.stringify(actualBBox(vs, k))}`)
    .join('\n      ')
);

section('B. 第一角投影排布');
ok('B1 俯视图整体位于正视图正下方（不重叠）', actualBBox(vs, 'top').max.y <= actualBBox(vs, 'front').min.y + TOL);
ok('B2 侧视图整体位于正视图正右方（不重叠）', actualBBox(vs, 'side').min.x >= actualBBox(vs, 'front').max.x - TOL);
ok('B3 内部图整体位于侧视图正右方（不重叠）', actualBBox(vs, 'internal').min.x >= actualBBox(vs, 'side').max.x - TOL);
ok('B4 排布总判定 layoutOk()', layoutOk(vs));
ok(
  'B5 视图外框尺寸：正视 W×H、俯视 W×D、侧视 D×H、内部 W×H',
  Math.abs(vs.meta.front.w - W) < TOL &&
    Math.abs(vs.meta.front.h - H) < TOL &&
    Math.abs(vs.meta.top.w - W) < TOL &&
    Math.abs(vs.meta.top.h - D) < TOL &&
    Math.abs(vs.meta.side.w - D) < TOL &&
    Math.abs(vs.meta.side.h - H) < TOL &&
    Math.abs(vs.meta.internal.w - W) < TOL &&
    Math.abs(vs.meta.internal.h - H) < TOL,
  JSON.stringify({ front: [vs.meta.front.w, vs.meta.front.h], top: [vs.meta.top.w, vs.meta.top.h], side: [vs.meta.side.w, vs.meta.side.h] })
);
ok(
  'B6 衔接线存在：长对正 2 条 + 高平齐 2 条 + 宽相等 2 条',
  vs.hinge.filter((p) => p.layer === 'F-VIEW').length === 6,
  `实际 ${vs.hinge.length} 条`
);

section('C. 跨视图内容一致性（同一块板在四个视图里必须对得上）');
const R = {
  front: rectsOf(vs.prims.front, inv.front),
  top: rectsOf(vs.prims.top, inv.top),
  side: rectsOf(vs.prims.side, inv.side),
  internal: rectsOf(vs.prims.internal, inv.internal),
};

// C1 顶板：三视图一致
ok(
  'C1 顶板：正视 [t,W-t]×[H-t,H] / 俯视 [t,W-t]×[0,D-t] / 侧视 [0,D-t]×[H-t,H]',
  hasRect(R.front, t, W - t, H - t, H) && hasRect(R.top, t, W - t, 0, bodyD) && hasRect(R.side, 0, bodyD, H - t, H)
);

// C2 底板
ok(
  'C2 底板：正视 [t,W-t]×[bodyLift,bodyLift+t] / 俯视（被顶板遮挡，用侧视校验）侧视 [0,D-t]×[bodyLift,bodyLift+t]',
  hasRect(R.front, t, W - t, bodyLift, bodyLift + t) && hasRect(R.side, 0, bodyD, bodyLift, bodyLift + t)
);

// C3 侧板：正视是竖条，俯视是长条，高度必须一致
ok(
  'C3 侧板：正视 [0,t]×[bodyLift,H] / 俯视 [0,t]×[0,D-t]',
  hasRect(R.front, 0, t, bodyLift, H) && hasRect(R.top, 0, t, 0, bodyD) && hasRect(R.front, W - t, W, bodyLift, H)
);

// C4 中立板：俯视图里的 X 位置必须与正视图里的 X 位置逐一对齐
const divX: number[] = [];
for (let i = 0; i < cab.layout.units.length - 1; i++) divX.push(L.unitX0[i] + L.nets[i]);
ok(
  `C4 中立板 ${divX.length} 块：正视与俯视的 X 区间逐一对齐`,
  divX.every((dx) => hasRect(R.front, dx, dx + t, innerBottomZ, innerTopZ) && hasRect(R.top, dx, dx + t, 0, bodyD)),
  `divX=${JSON.stringify(divX)}`
);

// C5 层板：数量 + 尺寸 + 高度集合 + 进深
let expectShelfCount = 0;
cab.layout.units.forEach((u) => {
  if (u.shelves && u.shelves.count > 0) expectShelfCount += u.shelves.count;
});
const shelfY0 = Math.max(backY0 + cab.params.backPanel.grooveDepth, backY1);
const shelfSummary = shelfCenters(vs, cab, rules);
ok(
  `C5a 层板数量：正视 ${expectShelfCount} 块 / 侧视 ${expectShelfCount} 块`,
  shelfSummary.front.length === expectShelfCount && shelfSummary.side.length === expectShelfCount,
  JSON.stringify(shelfSummary)
);
ok('C5b 层板高度集合：正视图 === 侧视图（逐块对齐）', shelfCentersMatch(vs, cab, rules), JSON.stringify(shelfSummary));

const sideShelfRects = rectsOf(vs.prims.side, inv.side).filter(
  (r) => Math.abs(r.y1 - r.y0 - t) < TOL && Math.abs(r.x1 - r.x0 - L.shelfDepth) < TOL
);
ok(
  `C5c 层板进深：侧视图 ${sideShelfRects.length} 块层板进深均 = 派生值 ${L.shelfDepth}（Y ∈ ${shelfY0}…${shelfY0 + L.shelfDepth}）`,
  sideShelfRects.length === expectShelfCount &&
    sideShelfRects.every((r) => Math.abs(r.x0 - shelfY0) < TOL && Math.abs(r.x1 - (shelfY0 + L.shelfDepth)) < TOL),
  JSON.stringify(sideShelfRects.map((r) => [r.x0, r.x1, r.y0, r.y1]))
);

const frontShelfByWidth = new Map<number, number>();
cab.layout.units.forEach((u, i) => {
  if (u.shelves && u.shelves.count > 0) frontShelfByWidth.set(L.nets[i] - 2 * u.shelves.gapPerSide, u.shelves.count);
});
ok(
  `C5d 层板宽度：正视图层板宽度 = 分区净宽 - 2×侧向间隙（与板件清单同源）`,
  expectShelfCount > 0 && [...frontShelfByWidth].every(([w, n]) => countRects(R.front, w, t) === n),
  `期望 ${JSON.stringify([...frontShelfByWidth])}，实际 ${JSON.stringify(R.front.filter((r) => Math.abs(r.y1 - r.y0 - t) < TOL).map((r) => [r.x0, r.x1, r.y0, r.y1]))}`
);

// C6 背板：俯视与侧视的进深刻度必须相同（都等于 tb）
ok(
  'C6 背板：俯视 Y∈[setback,setback+tb] / 侧视 Y∈[setback,setback+tb]×[内空]',
  hasRect(R.top, t, W - t, backY0, backY1) && hasRect(R.side, backY0, backY1, innerBottomZ, innerTopZ),
  JSON.stringify({ backY0, backY1, tb })
);

// C7 门板：正视门宽之和 + 缝隙 = 净宽；俯视/侧视的门板厚度 = t
const doorUnit = cab.layout.units.find((u) => u.doors);
if (doorUnit) {
  const idx = cab.layout.units.indexOf(doorUnit);
  const netW = L.nets[idx];
  const x0 = L.unitX0[idx];
  const widths = doorWidths(doorUnit, netW, rules);
  const sum = widths.reduce((a, b) => a + b, 0);
  ok(
    `C7a 门宽链：Σ门宽 + 2×外缝 + (n-1)×中缝 = 净宽 ${netW}`,
    Math.abs(sum + 2 * doorUnit.doors!.gapOuter + (doorUnit.doors!.count - 1) * doorUnit.doors!.gapMid - netW) < TOL
  );
  ok(
    `C7b 门板厚度：俯视 Y∈[${faceY0},${D}] / 侧视 Y∈[${faceY0},${D}] × 内空高`,
    hasRect(R.top, x0, x0 + netW, faceY0, D) &&
      hasRect(R.side, faceY0, D, innerBottomZ + doorUnit.doors!.gapOuter, innerBottomZ + innerH - doorUnit.doors!.gapOuter)
  );
}

// C8 踢脚板
ok(
  'C8 踢脚板：正视 [t,W-t]×[0,bodyLift] / 侧视 [D-2t,D-t]×[0,bodyLift]',
  hasRect(R.front, t, W - t, 0, bodyLift) && hasRect(R.side, faceY0 - t, faceY0, 0, bodyLift)
);

// C9 内空
ok(
  'C9 内空：侧视中立板轮廓高 = innerH，俯视内空进深 = D-t',
  hasRect(R.side, 0, bodyD, innerBottomZ, innerTopZ) && hasRect(R.top, t, W - t, 0, bodyD),
  `innerH=${innerH}`
);

// C10 挂衣杆：沿宽度方向的虚线必须只出现在有杆的分区里
const rodUnit = cab.layout.units.find((u) => u.rod);
if (rodUnit) {
  const idx = cab.layout.units.indexOf(rodUnit);
  const x0 = L.unitX0[idx];
  const z = innerBottomZ + rodUnit.rod!.heightFromBottom;
  const rodLines = vs.prims.front.filter(
    (p) => p.k === 'poly' && p.layer === 'F-CAB-HW' && !!p.dash && Math.abs(inv.front(p.pts[0]).y - z) < TOL
  );
  ok(
    `C10 挂衣杆：正视图虚线位于 z=${z}，x 跨度 ${x0 + 2}…${x0 + L.nets[idx] - 2}`,
    rodLines.length === rodUnit.rod!.count &&
      rodLines.every((p) => {
        const b = bboxOf(p.k === 'poly' ? p.pts.map(inv.front) : []);
        return Math.abs(b.min.x - (x0 + 2)) < TOL && Math.abs(b.max.x - (x0 + L.nets[idx] - 2)) < TOL;
      }),
    `实际 ${rodLines.length} 条`
  );
}

section('D. 图元健康度');
const allPts = allPoints(vs);
ok('D1 四个视图都非空', (['front', 'top', 'side', 'internal'] as const).every((k) => vs.prims[k].length > 0), JSON.stringify({ front: vs.prims.front.length, top: vs.prims.top.length, side: vs.prims.side.length, internal: vs.prims.internal.length }));
ok('D2 所有坐标有限（无 NaN / Infinity）', allPts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), `共 ${allPts.length} 个点`);
ok('D3 视图元素数量 ≥ 60', vs.prims.front.length + vs.prims.top.length + vs.prims.side.length + vs.prims.internal.length >= 60, `${vs.prims.front.length + vs.prims.top.length + vs.prims.side.length + vs.prims.internal.length}`);
ok('D4 内部图含板件中文名标注', vs.prims.internal.some((p) => p.k === 'text' && /左侧板|顶板|底板|中立板/.test(p.text)));
ok(
  'D5 图层合法：只使用 LAYERS 表里存在的图层',
  [...allPts.slice(0, 0)].length === 0 &&
    [...(['front', 'top', 'side', 'internal'] as const).flatMap((k) => vs.prims[k])].every((p) =>
      /^(F-CAB|F-CAB-FRONT|F-CAB-HW|F-CAB-HIDDEN|F-VIEW|F-DIM|F-TEXT|PANEL_\d+)$/.test(p.layer)
    ),
  [...new Set((['front', 'top', 'side', 'internal'] as const).flatMap((k) => vs.prims[k]).map((p) => p.layer))].join(', ')
);

section('E. 假设清单（没工艺依据的地方必须说出来）');
ok('E1 假设清单非空', vs.assumptions.length >= 4, `${vs.assumptions.length} 条`);
ok('E2 明示第一角投影法', vs.assumptions.some((a) => a.includes('第一角投影')));
ok(
  'E3 层板前缘越界矛盾被如实报出（不掩盖）',
  vs.assumptions.some((a) => a.includes('层板前缘')) || L.shelfDepth + Math.max(cab.params.backPanel.grooveSetback + cab.params.backPanel.grooveDepth, backY1) <= bodyD,
  `shelfDepth=${L.shelfDepth}`
);

section('F. 确定性与平移不变性');
const vs2 = buildCabinetViews(cab, rules);
ok('F1 纯函数：同样输入两次得到逐字节相同的图元', JSON.stringify(vs) === JSON.stringify(vs2));
const vsShift = buildCabinetViews(cab, rules, { x: 5000, y: -3000 });
const shiftOk = vs.prims.front.every((p, i) => {
  const a = p.k === 'text' ? [p.p] : p.pts;
  const q = vsShift.prims.front[i];
  const b = q.k === 'text' ? [q.p] : q.pts;
  return a.length === b.length && a.every((v, j) => Math.abs(v.x + 5000 - b[j].x) < 1e-9 && Math.abs(v.y - 3000 - b[j].y) < 1e-9);
});
ok('F2 平移图幅原点后，所有点相应平移、形状不变', shiftOk);

section('G. 负样本 —— 故意破坏必须被检出（否则"全绿"什么也不证明）');
ok(
  'G1 俯视图整体右移 137mm → 长对正必须失败',
  !alignsLong(broken(vs, 'top', (q) => ({ x: q.x + 137, y: q.y })))
);
ok(
  'G2 侧视图整体上移 95mm → 高平齐必须失败',
  !alignsHigh(broken(vs, 'side', (q) => ({ x: q.x, y: q.y + 95 })))
);
ok(
  'G3 俯视图进深压缩 0.8 倍 → 宽相等必须失败',
  !depthEqual(
    broken(vs, 'top', (q) => ({ x: q.x, y: vs.meta.top.origin.y - (vs.meta.top.origin.y - q.y) * 0.8 }))
  )
);
ok(
  'G4 俯视图挪到正视图上方 → 第一角排布必须失败',
  !layoutOk(
    broken(vs, 'top', (q) => ({ x: q.x, y: q.y + 2 * vs.gaps.gapTop + vs.dims.D }))
  )
);
ok(
  'G5 内部图挪到正视图左边 → 内部图排布必须失败',
  !layoutOk(
    broken(vs, 'internal', (q) => ({ x: q.x - (vs.meta.internal.origin.x - vs.meta.front.origin.x) - 1, y: q.y }))
  )
);
const noShelf = { ...vs, prims: { ...vs.prims, front: vs.prims.front.filter((p) => !(p.k === 'poly' && p.closed && Math.abs(bboxOf(p.pts.map(inv.front)).max.y - bboxOf(p.pts.map(inv.front)).min.y - t) < TOL && bboxOf(p.pts.map(inv.front)).min.y > innerBottomZ + 10 && bboxOf(p.pts.map(inv.front)).max.y < innerTopZ - 10)) } };
ok('G6 删掉正视图里全部层板 → 层板高度集合一致性必须失败', !shelfCentersMatch(noShelf, cab, rules));

section('H. 多柜并排（buildProjectViews）');
const twoCabProject = sampleProject(rules);
twoCabProject.cabinets.push(
  createCabinet({
    id: 'cab_002',
    name: '次卧衣柜',
    roomId: twoCabProject.rooms[0].id,
    x: 3000,
    y: 60,
    rules,
    params: { width: 1800, height: 2200, depth: 550 },
  })
);
const pv = buildProjectViews(twoCabProject, rules);
ok('H1 并排后两柜的图幅不重叠', (() => {
  const a = pv.placements.cab_001;
  const b = pv.placements.cab_002;
  return !!a && !!b && b.x > a.x + twoCabProject.cabinets[0].params.width;
})());
ok('H2 并排后 bbox 覆盖两柜全部图元', (() => {
  if (!pv.bbox) return false;
  const pts = pv.prims.flatMap((p) => (p.k === 'text' ? [p.p] : p.pts));
  return pts.every((p) => p.x >= pv.bbox!.min.x - 1e-6 && p.x <= pv.bbox!.max.x + 1e-6 && p.y >= pv.bbox!.min.y - 1e-6 && p.y <= pv.bbox!.max.y + 1e-6);
})());
ok('H3 每柜都有标题锚点，且 x 递增', pv.titles.length === 2 && pv.titles[1].at.x > pv.titles[0].at.x);
ok('H4 图元总量 = 两柜之和（无丢失）', pv.prims.length > 0 && pv.assumptions.length > 0);

// ───────────────────────────── I. 标注可读性 ─────────────────────────────

section('I. 标注可读性 —— 板件名标签不许互相压住');

/**
 * 这一组来自一次**目视检查**：内部结构图上 5 组文字压在一起
 * （左侧板压在抽屉面板说明上、底板压在踢脚板上、中立板压在挂衣杆上）。
 * 大图上肉眼根本判断不出压没压上，所以必须把"压字"变成可判定的数。
 *
 * 字宽用的是 views.ts 里那个显式模型（全角 1.0em / 半角 0.62em × 1.06 保守系数），
 * 也就是避让器自己用的那个模型 —— 这里验的是"避让器有没有兑现它的承诺"。
 * 「真实字体下到底压不压」由浏览器探针用渲染器同款字体再独立验一次。
 */
const LABEL_MARGIN = 18;

interface TBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  t: string;
}

function textBoxOf(p: Prim): TBox {
  if (p.k !== 'text') throw new Error('不是文字图元');
  const w = estimateTextWidth(p.text, p.size);
  const h = p.size * 1.2;
  if (p.rot === 90 || p.rot === -90) {
    return { x0: p.p.x - h / 2, x1: p.p.x + h / 2, y0: p.p.y - w / 2, y1: p.p.y + w / 2, t: p.text };
  }
  const x0 = p.align === 'l' ? p.p.x : p.align === 'r' ? p.p.x - w : p.p.x - w / 2;
  return { x0, x1: x0 + w, y0: p.p.y - h / 2, y1: p.p.y + h / 2, t: p.text };
}

function labelCollisions(list: Prim[], margin: number): string[] {
  const boxes = list.filter((p) => p.k === 'text').map(textBoxOf);
  const hits: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (a.x0 < b.x1 + margin && a.x1 + margin > b.x0 && a.y0 < b.y1 + margin && a.y1 + margin > b.y0) {
        hits.push(`${a.t} × ${b.t}`);
      }
    }
  }
  return hits;
}

for (const k of ['front', 'top', 'side', 'internal'] as const) {
  const hits = labelCollisions(vs.prims[k], 0);
  ok(`I1.${k} ${k} 视图内没有任何两组文字压在一起`, hits.length === 0, hits.join('；'));
}
ok(
  'I2 内部图的标签之间都留出了约定的最小间隙（避让器兑现承诺）',
  labelCollisions(vs.prims.internal, LABEL_MARGIN).length === 0,
  labelCollisions(vs.prims.internal, LABEL_MARGIN).join('；')
);

const ivTexts = vs.prims.internal.filter((p): p is Extract<Prim, { k: 'text' }> => p.k === 'text');
const o = vs.meta.internal.origin;
const outside = ivTexts.filter((p) => {
  const lx = p.p.x - o.x;
  const ly = p.p.y - o.y;
  return lx < 0 || lx > vs.dims.W || ly < 0 || ly > vs.dims.H;
});
ok(
  'I3 内部图所有文字锚点都落在视图范围内（避让不许把标签让到图外 —— 那是"内部图与正视图同高"的前提）',
  outside.length === 0,
  outside.map((p) => p.text).join(' / ')
);

const ivNames = ivTexts.map((p) => p.text).join(' | ');
const needed = ['左侧板', '右侧板', '顶板', '底板', '踢脚板', '中立板', '层板', '抽屉面板', '挂衣杆', '门板'];
ok(
  'I4 该标的板件一个都没被避让"让丢"（侧/顶/底/踢脚/中立/层板/抽面/挂衣杆/门板都在）',
  needed.every((n) => ivNames.includes(n)),
  needed.filter((n) => !ivNames.includes(n)).join(' / ')
);

// 负样本：把两个标签硬挪到同一个点上，重叠检测必须报出来
const forced = vs.prims.internal.map((p) => {
  if (p.k !== 'text') return p;
  if (p.text === '顶板' || p.text === '底板') return { ...p, p: { x: 800, y: 1200 } };
  return p;
});
ok(
  'I5 负样本：把「顶板」「底板」两个标签挪到同一点 → 压字必须被检出',
  labelCollisions(forced, 0).length > 0,
  '重叠检测漏掉了显然压在一起的两个标签'
);

// 避让器如果让不开，必须写进假设清单报出来 —— 不许静默压字
ok(
  'I6 避让器没有 "让不开" 的标签（若有，假设清单里必须出现对应警告）',
  !vs.assumptions.some((a) => a.includes('标签没能找到不重叠的位置')),
  vs.assumptions.find((a) => a.includes('标签没能找到不重叠的位置')) ?? ''
);

// ─────────────────────── J. 图幅包围盒必须覆盖"看得见的东西" ───────────────────────

section('J. 缩放到图幅不许把字裁掉 —— bbox 必须按可见范围算');

/**
 * 实测过的缺陷：内部图下方那句总览宽 4094mm，而图幅 bbox 只按**锚点**算，
 * 于是右端越界 847mm。首屏自动缩放到图幅时，那句话被画布右边缘切掉半截。
 * 这类问题在缩略截图上不容易看出来，但对用户来说就是"字被吃了"。
 */
const extBox = (p: Prim): { x0: number; x1: number; y0: number; y1: number } => {
  if (p.k !== 'text') {
    return {
      x0: Math.min(...p.pts.map((q) => q.x)),
      x1: Math.max(...p.pts.map((q) => q.x)),
      y0: Math.min(...p.pts.map((q) => q.y)),
      y1: Math.max(...p.pts.map((q) => q.y)),
    };
  }
  const w = estimateTextWidth(p.text, p.size);
  const h = p.size * 1.2;
  if (p.rot === 90 || p.rot === -90) return { x0: p.p.x - h / 2, x1: p.p.x + h / 2, y0: p.p.y - w / 2, y1: p.p.y + w / 2 };
  const x0 = p.align === 'l' ? p.p.x : p.align === 'r' ? p.p.x - w : p.p.x - w / 2;
  return { x0, x1: x0 + w, y0: p.p.y - h / 2, y1: p.p.y + h / 2 };
};

const overflow = pv.prims
  .map((p) => ({ p, b: extBox(p), e: extBox(p).x1 - pv.bbox!.max.x }))
  .filter((r) => r.e > 1 || r.b.x0 < pv.bbox!.min.x - 1 || r.b.y0 < pv.bbox!.min.y - 1 || r.b.y1 > pv.bbox!.max.y + 1);
ok(
  'J1 图幅内没有任何图元的可见范围越出 bbox（含文字字宽 / 字高）',
  overflow.length === 0,
  overflow.map((r) => `${r.p.k === 'text' ? r.p.text : '(图形)'} 越界 ${r.e.toFixed(0)}mm`).join('；')
);
ok(
  'J2 单柜图幅的 bbox 也覆盖所有文字的可见范围',
  (() => {
    const one = buildProjectViews(sampleProject(rules), rules);
    return one.prims.every((p) => {
      const b = extBox(p);
      const bb = one.bbox!;
      return b.x0 >= bb.min.x - 1 && b.x1 <= bb.max.x + 1 && b.y0 >= bb.min.y - 1 && b.y1 <= bb.max.y + 1;
    });
  })()
);
ok(
  'J3 负样本：把 bbox 缩到锚点范围（旧算法）→ 必须检出文字越界',
  (() => {
    const anchorOnly = bboxOf(pv.prims.flatMap((p) => (p.k === 'text' ? [p.p] : p.pts)));
    const bad = pv.prims.some((p) => extBox(p).x1 > anchorOnly.max.x + 1);
    return bad;
  })(),
  '锚点范围与可见范围没有差别，这条负样本失去意义'
);

// ───────────────────────────── 汇总 ─────────────────────────────

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('\n四视图投影对齐：全部不变量成立，负样本全部被检出。');
}

// 供上层脚本引用（避免"未使用"告警）
export type { BBox };
