/**
 * ══════════════════════════════════════════════════════════════════════
 *  P8.2 验收 —— Semantic Attach / Contact Placement
 *
 *  出口判据：AttachIntent → 确定性**面接触**解析 → ResolvedPlacement。
 *
 *  ── 这一批断言真正在防什么 ──
 *   ① **attach 被偷偷实现成 "adjacent + gap 0"。** attach 的两个面必须
 *      有名有姓地参与计算：A.right ↔ B.left 是"两个面所在平面重合"，
 *      不是"往右挪一格"。所以这里断言**面平面真的贴合**（独立重算面端点），
 *      而不只是断言结果数字碰巧等于 adjacent。
 *   ② **面朝向对不上却照样放。** right ↔ right 在几何上不可能贴合 ——
 *      必须报 FACE-NOT-OPPOSING（带夹角数字），绝不退化成"那就相邻着放"。
 *   ③ **第二套面语义 / 第二套旋转数学 / 第二套 bbox。** 面名与面↔边映射
 *      只从 relations.ts 的 EDGE_ORDER 借（源码扫描佐证），旋转只走
 *      transform.ts 的 localToWorld（源码里不许出现 Math.cos/sin）。
 *   ④ **静默回原点。** 任何失败给结构化错误，绝不 fallback (0,0,0)。
 *   ⑤ **绕过 CommandBus。** attach 只是"一种解析方式"，写回仍然只用
 *      `cabinet.place` 一条命令（不新增 cabinet.attach）。
 *   ⑥ **AI 夹带坐标。** contract / 形状门 / compileAction 三层都不收 x/y。
 *   ⑦ **两套接触真相。** Placement 算出来的贴合，必须能被 P2 的
 *      `deriveContacts()`（全项目唯一的接触判定）独立验出来 —— 复用，
 *      不复制；且 deriveContacts 反过来不许改 placement。
 *
 *  注：面端点/包围盒在验收侧**故意独立重算**，不 import 被测实现自我证明。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, Prim, Project, RuleSet, Vec2 } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom, sampleProject } from '../src/core/docFactory.ts';
import { findDuplicateUnitIds } from '../src/core/unitIdentity.mjs';
import {
  ATTACH_ALIGNMENTS,
  ATTACH_DEFAULT_ALIGNMENT,
  PLACEMENT_FACES,
  resolvePlacement,
  resolvePlacements,
  sceneFromProject,
  type PlacementFace,
  type PlacementIntent,
  type PlacementScene,
} from '../src/core/placement.ts';
import { bboxOf, distToSegment } from '../src/core/geometry/transform.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { deriveContacts } from '../src/core/relations.ts';
import { compileAction, type AiAction } from '../src/ai/compile.ts';
import { validateProposal, type DesignProposal } from '../src/ai/proposal.ts';
import { compileProposal } from '../src/ai/compileProposal.ts';
import { commitPlan, dryRunPlan } from '../src/ai/planRunner.ts';
import { ACTIONS, proposalShapeError } from '../shared/aiContract.mjs';
import * as CMD from '../src/core/commands.ts';

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
function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
type Box = { min: Vec2; max: Vec2 };

/** 测试夹具的柜体共享一个全局 Unit ID 命名空间；不触碰生产自动修复/放行逻辑。 */
function assignFixtureUnitIds(project: Project): Project {
  project.cabinets.forEach((cabinet, cabinetIndex) => {
    const prefix = `unit_fixture_${cabinet.id || cabinetIndex + 1}`;
    const assign = (units: Array<{ id: string }> | undefined, group: string): void => {
      units?.forEach((unit, index) => { unit.id = `${prefix}_${group}_${index + 1}`; });
    };
    const rows = cabinet.layout.rows;
    if (Array.isArray(rows) && rows.length > 0) {
      rows.forEach((row, rowIndex) => assign(row.units, `row_${rowIndex + 1}`));
      cabinet.layout.units = structuredClone(rows[0]!.units);
    } else {
      assign(cabinet.layout.units, 'main');
    }
    assign(cabinet.layout.backUnits, 'back');
  });
  return project;
}

// ───────────── 测试场景 ─────────────

/** A(400,60) 2400×600 rot0；B(1000,1000) 800×550 rot0；C(2000,2000) 800×600 rot0 */
function mkProject(): Project {
  const room = rectRoom({ name: '测试房', x: 0, y: 0, w: 8000, h: 6000, thickness: 100, height: 2700 });
  const mk = (id: string, name: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet =>
    createCabinet({
      id,
      name,
      roomId: room.id,
      x,
      y,
      rotation,
      rules,
      params: { ...defaultCabinetParams(rules), width: w, height: 2200, depth: d },
      units: defaultUnits(w, rules, d),
    });
  return assignFixtureUnitIds({
    schemaVersion: '0.3',
    id: 'proj_p82',
    name: 'P8.2 贴合验收',
    ruleSetId: rules.id,
    rooms: [room],
    cabinets: [
      mk('cab_A', '基准柜A', 400, 60, 2400, 600),
      mk('cab_B', '贴合柜B', 1000, 1000, 800, 550),
      mk('cab_C', '链柜C', 2000, 2000, 800, 600),
    ],
  });
}

/** 验收侧独立重算：一个面在世界坐标下的两个端点（自然方向：左右面沿进深、前后端面沿宽） */
function faceSeg(cab: Cabinet, face: PlacementFace): { start: Vec2; end: Vec2 } {
  const r = (cab.placement.rotation * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const W = cab.params.width;
  const D = cab.params.depth;
  const local: Record<PlacementFace, { start: [number, number]; end: [number, number] }> = {
    back: { start: [0, 0], end: [W, 0] },
    right: { start: [W, 0], end: [W, D] },
    front: { start: [0, D], end: [W, D] },
    left: { start: [0, 0], end: [0, D] },
  };
  const toWorld = (p: [number, number]): Vec2 => ({
    x: cab.placement.x + p[0] * c - p[1] * s,
    y: cab.placement.y + p[0] * s + p[1] * c,
  });
  return { start: toWorld(local[face].start), end: toWorld(local[face].end) };
}

function cabBox(cab: Cabinet): Box {
  return bboxOf([faceSeg(cab, 'back').start, faceSeg(cab, 'back').end, faceSeg(cab, 'front').start, faceSeg(cab, 'front').end]);
}

/** 把解析结果落到柜体上（不改语义模型，只改内存里的 placement，用于几何复核） */
function applyTo(cab: Cabinet, p: { x: number; y: number; rotation: number }): Cabinet {
  return { ...cab, placement: { x: p.x, y: p.y, rotation: p.rotation } };
}

/**
 * 独立复核"两个面真的贴合"：① 共面（点到**直线**的距离 ≈ 0，把 a 向两端延长 20 倍
 * 再量点到线段距离 —— 这样"目标面比参照面长、伸出去一截"也算共面）
 * ② 沿面方向投影有正重叠。
 *
 * 为什么不能只量"两端点都落在对方线段内"：面接触**不等于整条边重合**
 * （600 深的柜贴 550 深的柜，起始端对齐时长的那头必然伸出 50mm），
 * 那条判据会把真实的贴合判成没贴上 —— P2 的 edgesFlush 就栽在这里（已在 P8.2 修掉）。
 */
function facesFlush(a: { start: Vec2; end: Vec2 }, b: { start: Vec2; end: Vec2 }): boolean {
  const dx = a.end.x - a.start.x;
  const dy = a.end.y - a.start.y;
  const ext = {
    start: { x: a.start.x - dx * 20, y: a.start.y - dy * 20 },
    end: { x: a.end.x + dx * 20, y: a.end.y + dy * 20 },
  };
  const onLine = distToSegment(b.start, ext.start, ext.end) < 0.5 && distToSegment(b.end, ext.start, ext.end) < 0.5;
  const l = Math.hypot(dx, dy) || 1;
  const u = { x: dx / l, y: dy / l };
  const proj = (p: Vec2): number => (p.x - a.start.x) * u.x + (p.y - a.start.y) * u.y;
  const lo = Math.min(proj(b.start), proj(b.end));
  const hi = Math.max(proj(b.start), proj(b.end));
  return onLine && Math.min(hi, l) - Math.max(lo, 0) > 0.5;
}

function attachIntent(
  targetId: string,
  referenceId: string,
  targetFace: PlacementFace,
  referenceFace: PlacementFace,
  extra: { alignment?: 'start' | 'center' | 'end'; offset?: number } = {}
): PlacementIntent {
  return { relation: 'attach', targetId, referenceId, targetFace, referenceFace, ...extra };
}

// ═══════════════════ §1 基础：四个垂直面的真实贴合 ═══════════════════
section('§1 基础：A.right↔B.left 这类面接触的确定性数值');
{
  const project = mkProject();
  const scene = sceneFromProject(project);
  const A = project.cabinets[0]!;
  const B = project.cabinets[1]!;

  // ① B.left ↔ A.right：B 的左端贴 A 的右端 → B.x = 400+2400 = 2800；start = 背面齐 → y=60
  const r1 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), scene);
  ok('B.left ↔ A.right：左端贴右端（x=2800）', r1.ok && r1.placement.x === 2800, JSON.stringify(r1));
  ok('B.left ↔ A.right：缺省对齐是 start（背面齐 y=60，不是隐式 center）', r1.ok && r1.placement.y === 60, JSON.stringify(r1));
  const adj = resolvePlacement({ relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }, scene);
  ok('轴对齐时 attach 与 adjacent 同值（两条路同一个数：面平面 === 贴合包围盒）', r1.ok && adj.ok && r1.placement.x === adj.placement.x && r1.placement.y === adj.placement.y);

  // ② 四个方向
  const r2 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'right', 'left'), scene);
  ok('B.right ↔ A.left：右端贴左端（x=-400）', r2.ok && r2.placement.x === -400, JSON.stringify(r2));
  const r3 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'back', 'front'), scene);
  ok('B.back ↔ A.front：背面贴正面（y=660）', r3.ok && r3.placement.y === 660 && r3.placement.x === 400, JSON.stringify(r3));
  const r4 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'front', 'back'), scene);
  ok('B.front ↔ A.back：正面贴背面（y=-490）', r4.ok && r4.placement.y === -490, JSON.stringify(r4));

  // ③ offset：只沿接触面外法线留缝，另一轴不受影响
  const r5 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right', { offset: 20 }), scene);
  ok('offset=20：沿法向留 20mm 缝（x=2820）', r5.ok && r5.placement.x === 2820, JSON.stringify(r5));
  ok('offset 只动法向、不动另一轴（y 仍是 60）', r5.ok && r5.placement.y === 60);
  const r6 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right', { offset: 0 }), scene);
  ok('offset=0：真正贴合（x=2800）', r6.ok && r6.placement.x === 2800);

  // ④ alignment：start / center / end（不是"总是 center"）
  const rc = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right', { alignment: 'center' }), scene);
  ok('左右面 + center：面中心对齐（y=85）', rc.ok && rc.placement.y === 85, JSON.stringify(rc));
  const re = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right', { alignment: 'end' }), scene);
  ok('左右面 + end：末端（正面）对齐（y=110）', re.ok && re.placement.y === 110, JSON.stringify(re));
  const fc = resolvePlacement(attachIntent('cab_B', 'cab_A', 'back', 'front', { alignment: 'center' }), scene);
  ok('前后端面 + center：x=1200', fc.ok && fc.placement.x === 1200 && fc.placement.y === 660, JSON.stringify(fc));
  const fe = resolvePlacement(attachIntent('cab_B', 'cab_A', 'back', 'front', { alignment: 'end' }), scene);
  ok('前后端面 + end：右端齐（x=2000）', fe.ok && fe.placement.x === 2000, JSON.stringify(fe));

  // ⑤ 独立几何复核：面端点真的重合（不是数字碰巧）
  const B1 = applyTo(B, r1.ok ? r1.placement : { x: 0, y: 0, rotation: 0 });
  const segA = faceSeg(A, 'right');
  const segB = faceSeg(B1, 'left');
  ok('start 对齐：两个面的起始端点重合（差 < 0.5mm）',
    Math.hypot(segA.start.x - segB.start.x, segA.start.y - segB.start.y) < 0.5,
    JSON.stringify([segA, segB]));
  const B5 = applyTo(B, r5.ok ? r5.placement : { x: 0, y: 0, rotation: 0 });
  const segB5 = faceSeg(B5, 'left');
  ok('offset=20：两面所在平面相距 20mm（几何事实，不是参数被记住）',
    Math.abs(distToSegment(segB5.start, segA.start, segA.end) - 20) < 0.5,
    `dist=${distToSegment(segB5.start, segA.start, segA.end)}`);

  // ⑥ rotation 不被 attach 改（两柜同朝向才能贴合，这里用 90°/90° 的合法组合）
  const p90 = mkProject();
  p90.cabinets[0]!.placement.rotation = 90;
  p90.cabinets[1]!.placement.rotation = 90;
  const r90 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), sceneFromProject(p90));
  ok('attach 不改变目标柜朝向（保留 rot=90）', r90.ok && r90.placement.rotation === 90, JSON.stringify(r90));

  // ⑦ 缺省对齐常量：不是 center
  ok('缺省对齐常量是 start（不是隐式 center）', ATTACH_DEFAULT_ALIGNMENT === 'start' && ATTACH_ALIGNMENTS.join('/') === 'start/center/end');
  ok('可贴合的面只有 4 个垂直面（top/bottom 需要 Z，本阶段不做）',
    PLACEMENT_FACES.length === 4 && !PLACEMENT_FACES.includes('top' as never) && !PLACEMENT_FACES.includes('bottom' as never),
    JSON.stringify(PLACEMENT_FACES));
}

// ═══════════════════ §2 几何：尺寸差异与 rotation ═══════════════════
section('§2 几何：不同尺寸 / 不同朝向 / target-reference 互换');
{
  // 不同深度：左右面贴合的 x 与深度无关
  const p1 = mkProject();
  p1.cabinets[1]!.params.depth = 318;
  const d1 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), sceneFromProject(p1));
  ok('不同深度：x/y 不受影响（2800, 60）', d1.ok && d1.placement.x === 2800 && d1.placement.y === 60, JSON.stringify(d1));

  // 不同宽度：x 只由"参照右端"和"目标左端"定，与目标宽无关
  const p2 = mkProject();
  p2.cabinets[1]!.params.width = 1200;
  const d2 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), sceneFromProject(p2));
  ok('不同宽度：x 仍是 2800（贴合的是面，不是中心）', d2.ok && d2.placement.x === 2800, JSON.stringify(d2));

  // target / reference 互换：A.right ↔ B.left → A 到 B 左边（A.x = 1000-2400 = -1400）
  const p3 = mkProject();
  const sw = resolvePlacement(attachIntent('cab_A', 'cab_B', 'right', 'left'), sceneFromProject(p3));
  ok('target/reference 互换：A.right ↔ B.left → A.x=-1400（A 在 B 左侧）', sw.ok && sw.placement.x === -1400 && sw.placement.y === 1000, JSON.stringify(sw));

  // rotation：两柜同朝向（相对旋转 = 0）时四角都成立
  const cases: Array<[number, number, number]> = [
    [0, 2800, 60],
    [90, 400, 2460],
    [180, -2000, 60],
    [270, 400, -2340],
  ];
  for (const [rot, ex, ey] of cases) {
    const p = mkProject();
    p.cabinets[0]!.placement.rotation = rot;
    p.cabinets[1]!.placement.rotation = rot;
    const r = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), sceneFromProject(p));
    ok(`两柜同朝 ${rot}°：B.left ↔ A.right → (${ex}, ${ey})`, r.ok && r.placement.x === ex && r.placement.y === ey, JSON.stringify(r));
    // 独立复核：两面所在平面真贴合（面的两个端点都落在对方面上）+ 两柜不重叠
    if (r.ok) {
      const A = applyTo(p.cabinets[0]!, p.cabinets[0]!.placement);
      const B = applyTo(p.cabinets[1]!, r.placement);
      ok(`  ${rot}°：独立重算的两面共面且有重叠，两柜不侵入`,
        facesFlush(faceSeg(A, 'right'), faceSeg(B, 'left')) && !boxesOverlap(cabBox(A), cabBox(B)),
        JSON.stringify([faceSeg(A, 'right'), faceSeg(B, 'left')]));
    }
  }

  // 非 90°：模型允许任意角度，attach 对同角两柜仍确定性（用独立几何复核）
  const p45 = mkProject();
  p45.cabinets[0]!.placement.rotation = 45;
  p45.cabinets[1]!.placement.rotation = 45;
  const scene45 = sceneFromProject(p45);
  const q1 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), scene45);
  const q2 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), scene45);
  ok('非 90°（45°/45°）：可解析且同输入同输出', q1.ok && q2.ok && eq(q1, q2), JSON.stringify(q1));
  if (q1.ok) {
    const A = applyTo(p45.cabinets[0]!, p45.cabinets[0]!.placement);
    const B = applyTo(p45.cabinets[1]!, q1.placement);
    const sa = faceSeg(A, 'right');
    const sb = faceSeg(B, 'left');
    ok('非 90°：独立重算两面仍共面且有重叠（解析精确，不靠包围盒近似）',
      facesFlush(sa, sb), JSON.stringify([sa, sb]));
    // 诚实标注：P2 的 deriveContacts 只覆盖轴对齐，非轴对齐不声称"已验证接触"
    const c45 = deriveContacts({ ...p45, cabinets: [A, B] });
    ok('非 90°：P2 deriveContacts 不覆盖非轴对齐（不假装验过，如实记为未覆盖）', c45.length === 0, JSON.stringify(c45));
  }
}

/** 两盒是否真有面积重叠（相切不算） */
function boxesOverlap(a: Box, b: Box): boolean {
  return a.min.x < b.max.x - 0.5 && a.max.x > b.min.x + 0.5 && a.min.y < b.max.y - 0.5 && a.max.y > b.min.y + 0.5;
}

// ═══════════════════ §3 混合关系链 ═══════════════════
section('§3 混合关系链：attach + adjacent / align / attach 按依赖确定性解析');
{
  const project = mkProject();
  const scene = sceneFromProject(project);

  // attach + adjacent：B attach A，C adjacent B（C 必须用 B 解析后的新位置）
  const mix1 = resolvePlacements(
    [
      { relation: 'adjacent', targetId: 'cab_C', referenceId: 'cab_B', side: 'right' },
      attachIntent('cab_B', 'cab_A', 'left', 'right'),
    ],
    scene
  );
  ok('attach + adjacent：全批成功（乱序也按依赖排）', mix1.ok, JSON.stringify(mix1));
  const got1 = new Map(mix1.ok ? mix1.resolved.map((r) => [r.intent.targetId, r.placement]) : []);
  ok('attach + adjacent：B 贴 A 右端（2800, 60）', got1.get('cab_B')?.x === 2800 && got1.get('cab_B')?.y === 60, JSON.stringify(got1.get('cab_B')));
  ok('attach + adjacent：C 贴 B 的新右端（3600, 60）', got1.get('cab_C')?.x === 3600 && got1.get('cab_C')?.y === 60, JSON.stringify(got1.get('cab_C')));

  // attach + align：C align A（front 边缘齐）
  const mix2 = resolvePlacements(
    [attachIntent('cab_B', 'cab_A', 'left', 'right'), { relation: 'align', targetId: 'cab_C', referenceId: 'cab_A', alignment: 'front' }],
    scene
  );
  ok('attach + align：全批成功', mix2.ok, JSON.stringify(mix2));
  const got2 = new Map(mix2.ok ? mix2.resolved.map((r) => [r.intent.targetId, r.placement]) : []);
  // C 深 600 = A 深 600 → 前缘齐 ⇒ C.y = 660-600 = 60；align 只动 Y ⇒ x 保持 2000
  ok('attach + align：C 与 A 前缘齐且 X 不动（2000, 60）', got2.get('cab_C')?.y === 60 && got2.get('cab_C')?.x === 2000, JSON.stringify(got2.get('cab_C')));

  // attach + attach 三柜链：C attach B，B attach A
  const mix3 = resolvePlacements(
    [attachIntent('cab_C', 'cab_B', 'left', 'right'), attachIntent('cab_B', 'cab_A', 'left', 'right')],
    scene
  );
  ok('attach + attach：三柜链全批成功', mix3.ok, JSON.stringify(mix3));
  const got3 = new Map(mix3.ok ? mix3.resolved.map((r) => [r.intent.targetId, r.placement]) : []);
  const b3 = got3.get('cab_B');
  const c3 = got3.get('cab_C');
  ok('链：B 贴 A（2800, 60）', b3?.x === 2800 && b3?.y === 60, JSON.stringify(b3));
  ok('链：C 贴 B 解析后的新右端（3600, 60）', c3?.x === 3600 && c3?.y === 60, JSON.stringify(c3));

  // 混合成环：A attach B，B adjacent A → CYCLE，全批拒绝
  const cyc = resolvePlacements(
    [attachIntent('cab_A', 'cab_B', 'left', 'right'), { relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' }],
    scene
  );
  ok('混合成环 → PLACEMENT-CYCLE（全批拒绝，不按顺序碰运气）', !cyc.ok && cyc.error.code === 'PLACEMENT-CYCLE', JSON.stringify(cyc));
}

// ═══════════════════ §4 错误路径 ═══════════════════
section('§4 错误路径：结构化错误，绝不 fallback 到 (0,0,0)');
{
  const scene = sceneFromProject(mkProject());
  const e1 = resolvePlacement(attachIntent('nope', 'cab_A', 'left', 'right'), scene);
  ok('target 不存在 → PLACEMENT-TARGET-NOT-FOUND', !e1.ok && e1.error.code === 'PLACEMENT-TARGET-NOT-FOUND', JSON.stringify(e1));
  const e2 = resolvePlacement(attachIntent('cab_B', 'ghost', 'left', 'right'), scene);
  ok('reference 不存在 → PLACEMENT-REFERENCE-NOT-FOUND', !e2.ok && e2.error.code === 'PLACEMENT-REFERENCE-NOT-FOUND', JSON.stringify(e2));
  const e3 = resolvePlacement(attachIntent('cab_B', 'cab_B', 'left', 'right'), scene);
  ok('自参照 → PLACEMENT-SELF-REFERENCE', !e3.ok && e3.error.code === 'PLACEMENT-SELF-REFERENCE', JSON.stringify(e3));
  const e4 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'top' as never, 'right'), scene);
  ok('非法面（top，需要 Z）→ PLACEMENT-INTENT-INVALID', !e4.ok && e4.error.code === 'PLACEMENT-INTENT-INVALID', JSON.stringify(e4));
  const e5 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right', { alignment: 'left' as never }), scene);
  ok('attach 用了 adjacent 的对齐词 → PLACEMENT-INTENT-INVALID', !e5.ok && e5.error.code === 'PLACEMENT-INTENT-INVALID', JSON.stringify(e5));

  // 面朝向对不上：right ↔ right（外法线同向，几何上不可能贴合）
  const e6 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'right', 'right'), scene);
  ok('两面朝向不相对（right ↔ right）→ PLACEMENT-FACE-NOT-OPPOSING', !e6.ok && e6.error.code === 'PLACEMENT-FACE-NOT-OPPOSING', JSON.stringify(e6));
  ok('  报错带具体夹角数字（180°）', !e6.ok && e6.error.message.includes('180'), e6.ok ? '' : e6.error.message);
  const e6b = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'front'), scene);
  ok('面朝向相差 90° → PLACEMENT-FACE-NOT-OPPOSING（报 90）', !e6b.ok && e6b.error.code === 'PLACEMENT-FACE-NOT-OPPOSING' && e6b.error.message.includes('90'), JSON.stringify(e6b));

  // 相对旋转不是 90° 的整数倍 → 两面永远平行不了
  const pRel = mkProject();
  pRel.cabinets[1]!.placement.rotation = 45;
  const e7 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), sceneFromProject(pRel));
  ok('相对旋转非 90° 倍数（0° vs 45°）→ FACE-NOT-OPPOSING', !e7.ok && e7.error.code === 'PLACEMENT-FACE-NOT-OPPOSING', JSON.stringify(e7));

  // offset 非法
  const e8 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right', { offset: -20 }), scene);
  ok('offset 负数（重叠）→ 拒收（重叠是碰撞，落位层不造）', !e8.ok && e8.error.code === 'PLACEMENT-INTENT-INVALID', JSON.stringify(e8));
  ok('  offset 报错带收到的那个数（-20）', !e8.ok && e8.error.message.includes('-20'), e8.ok ? '' : e8.error.message);
  const e9 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right', { offset: Number.NaN }), scene);
  ok('offset 非有限数 → 拒收', !e9.ok && e9.error.code === 'PLACEMENT-INTENT-INVALID');

  // 几何缺失 / 尺寸非法
  const badGeom = scene.map((s) => (s.id === 'cab_A' ? { ...s, x: Number.NaN } : s));
  const e10 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), badGeom);
  ok('参照柜落位数据缺失 → PLACEMENT-GEOMETRY-MISSING', !e10.ok && e10.error.code === 'PLACEMENT-GEOMETRY-MISSING', JSON.stringify(e10));
  const badSize = scene.map((s) => (s.id === 'cab_A' ? { ...s, width: 0 } : s));
  const e11 = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), badSize);
  ok('尺寸非法 → PLACEMENT-SIZE-INVALID', !e11.ok && e11.error.code === 'PLACEMENT-SIZE-INVALID', JSON.stringify(e11));

  // 绝不静默回原点：所有失败路径都没有 ok:true，也没有 (0,0)
  const all = [e1, e2, e3, e4, e5, e6, e6b, e7, e8, e9, e10, e11];
  ok('全部失败路径：无一条返回 ok（更没有静默 (0,0,0)）', all.every((r) => !r.ok));
}

// ═══════════════════ §5 架构边界 ═══════════════════
section('§5 架构：纯函数 / 单一真相源 / 不复制 Relations / preview==commit');
{
  const project = mkProject();
  const fixtureDuplicates = findDuplicateUnitIds(project);
  ok('三柜架构 fixture 构造后 Unit ID 全局唯一（CommandBus 前置断言）', fixtureDuplicates.length === 0, JSON.stringify(fixtureDuplicates));
  const scene = sceneFromProject(project);
  const intent = attachIntent('cab_B', 'cab_A', 'left', 'right', { alignment: 'center' });
  const sceneBefore = JSON.stringify(scene);
  const projectBefore = JSON.stringify(project);
  const intentBefore = JSON.stringify(intent);
  const a1 = resolvePlacement(intent, scene);
  const a2 = resolvePlacement(intent, scene);
  ok('同输入两次解析逐位相同（无随机、无时钟）', eq(a1, a2));
  ok('场景快照未被修改', JSON.stringify(scene) === sceneBefore);
  ok('语义模型未被修改（解析不写模型）', JSON.stringify(project) === projectBefore);
  ok('意图对象未被修改', JSON.stringify(intent) === intentBefore);
  ok('结果是整数 mm（不把浮点误差带进生产尺寸）', a1.ok && Number.isInteger(a1.placement.x) && Number.isInteger(a1.placement.y) && Number.isInteger(a1.placement.rotation));

  // 尺寸真相只有一个源：scene 直接来自语义参数
  ok('尺寸只读语义参数（不产生第二尺寸真相源）',
    scene.every((s) => {
      const c = project.cabinets.find((x) => x.id === s.id)!;
      return s.width === c.params.width && s.depth === c.params.depth;
    }));

  // 源码扫描：不新增第二套旋转数学 / 不复制面映射 / 不复制接触算法 / 不新增 bbox
  const src = readFileSync(join(APP, 'src', 'core', 'placement.ts'), 'utf8');
  ok('不新增第二套旋转数学（placement.ts 里没有 Math.cos / Math.sin）', !src.includes('Math.cos') && !src.includes('Math.sin'));
  ok('不新增第二套 bbox（用 transform 的 bboxOf，自己没写 bbox 函数）', src.includes('bboxOf') && !/function\s+bbox/i.test(src));
  ok('面↔边映射借 P2 的 EDGE_ORDER（不抄第二份面表）', src.includes('EDGE_ORDER') && !src.includes("['back', 'right', 'front', 'left']"));
  ok('不复制 Relations 的接触判定（没有 deriveContacts / edgesFlush / CONTACT_TOL）',
    !src.includes('deriveContacts') && !src.includes('edgesFlush') && !src.includes('CONTACT_TOL'));

  // ── 唯一写入口仍然是 cabinet.place（不新增 cabinet.attach）──
  const bus = new CommandBus(project, rules);
  const v0 = bus.getVersion();
  const r = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), sceneFromProject(bus.getState()));
  ok('CommandBus 正向用例：attach 解析成功并给出 (2800, 60)', r.ok && r.placement.x === 2800 && r.placement.y === 60, JSON.stringify(r));
  const cabB = bus.getState().cabinets.find((c) => c.id === 'cab_B')!;
  const cmd = r.ok ? CMD.placeCabinet(cabB, r.placement, 'ai') : null;
  ok('attach 的解析结果仍走 cabinet.place（没有第二套写入命令）', cmd?.op === 'cabinet.place', cmd?.op ?? '解析失败，未执行命令');
  ok('  一条命令原子写三字段（白名单 placement.x/y/rotation）',
    !!cmd && cmd.changes.length === 3 && cmd.changes.every((ch) => /^placement\.(x|y|rotation)$/.test(ch.path)));
  const dry = cmd ? bus.execute(cmd, { dryRun: true }) : null;
  ok('干跑执行成功', dry?.ok === true, JSON.stringify(dry));
  ok('干跑不动模型（版本不变）', dry?.ok === true && bus.getVersion() === v0);
  const exec = cmd ? bus.execute(cmd) : null;
  const after = bus.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
  ok('提交执行成功', exec?.ok === true, JSON.stringify(exec));
  ok('提交后 placement === 解析值（落位为 2800,60）', exec?.ok === true && after.x === 2800 && after.y === 60 && r.ok && after.x === r.placement.x && after.y === r.placement.y, JSON.stringify(after));
  ok('预览 === 提交（diff 逐值相同）', dry?.ok === true && exec?.ok === true && eq(dry.diff, exec.diff), JSON.stringify({ dry: dry?.diff, commit: exec?.diff }));

  // ── 复用 P2 的 deriveContacts 独立验证"真的贴上了" ──
  const st = bus.getState();
  const contacts = deriveContacts(st);
  const pair = contacts.find((c) => (c.a === 'cab_A' && c.b === 'cab_B') || (c.a === 'cab_B' && c.b === 'cab_A'));
  ok('P2 deriveContacts 独立验出这两柜确实相接（kind=butt）', !!pair && pair.kind === 'butt', JSON.stringify(contacts));
  ok('  接触的边就是 attach 声明的那两个面（right ↔ left）',
    !!pair && ((pair.a === 'cab_A' && pair.edgeA === 'right' && pair.edgeB === 'left') || (pair.a === 'cab_B' && pair.edgeA === 'left' && pair.edgeB === 'right')),
    JSON.stringify(pair));
  ok('deriveContacts 不反过来改 placement（只读派生）',
    st.cabinets.find((c) => c.id === 'cab_B')!.placement.x === 2800 && st.cabinets.find((c) => c.id === 'cab_A')!.placement.x === 400);

  // offset > 0 = 留缝 → 不算接触（几何事实，不是"贴上了但记了个缝"）
  const bus2 = new CommandBus(mkProject(), rules);
  const gapFixtureDuplicates = findDuplicateUnitIds(bus2.getState());
  ok('offset=20 负向用例从有效唯一 ID fixture 开始', gapFixtureDuplicates.length === 0, JSON.stringify(gapFixtureDuplicates));
  const rGap = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right', { offset: 20 }), sceneFromProject(bus2.getState()));
  ok('offset=20 attach 解析成功并给出 (2820, 60)', rGap.ok && rGap.placement.x === 2820 && rGap.placement.y === 60, JSON.stringify(rGap));
  const cabB2 = bus2.getState().cabinets.find((c) => c.id === 'cab_B')!;
  const gapCmd = rGap.ok ? CMD.placeCabinet(cabB2, rGap.placement, 'ai') : null;
  const gapExec = gapCmd ? bus2.execute(gapCmd) : null;
  const gapPlacement = bus2.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
  ok('offset=20 CommandBus 执行成功且实际落位为 (2820, 60)', gapExec?.ok === true && gapPlacement.x === 2820 && gapPlacement.y === 60, JSON.stringify({ result: gapExec, placement: gapPlacement }));
  const gapContacts = deriveContacts(bus2.getState()).filter(
    (c) => (c.a === 'cab_A' && c.b === 'cab_B') || (c.a === 'cab_B' && c.b === 'cab_A')
  );
  ok('offset=20：有效执行后两柜之间是 20mm 缝，deriveContacts 如实不算接触', gapExec?.ok === true && gapPlacement.x === 2820 && gapPlacement.y === 60 && gapContacts.length === 0, JSON.stringify({ placement: gapPlacement, contacts: gapContacts }));

  // ── 2D / 3D 消费同一份 resolved placement ──
  const p3d = mkProject();
  const g0 = generateProject(p3d, rules);
  const planBefore = primBox(g0.cabinets['cab_B']!.plan);
  const cxBefore = meanCx(g0.bodies3d.filter((b) => b.cabId === 'cab_B'));
  const bus3 = new CommandBus(p3d, rules);
  const r3d = resolvePlacement(attachIntent('cab_B', 'cab_A', 'left', 'right'), sceneFromProject(bus3.getState()));
  ok('2D/3D 正向用例：attach 解析成功并给出 (2800, 60)', r3d.ok && r3d.placement.x === 2800 && r3d.placement.y === 60, JSON.stringify(r3d));
  const cabB3 = bus3.getState().cabinets.find((c) => c.id === 'cab_B')!;
  const cmd3 = r3d.ok ? CMD.placeCabinet(cabB3, r3d.placement, 'ai') : null;
  const exec3 = cmd3 ? bus3.execute(cmd3) : null;
  const placement3 = bus3.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
  ok('2D/3D CommandBus 执行成功且实际落位为 (2800, 60)', exec3?.ok === true && placement3.x === 2800 && placement3.y === 60, JSON.stringify({ result: exec3, placement: placement3 }));
  const g1 = generateProject(bus3.getState(), rules);
  const planAfter = primBox(g1.cabinets['cab_B']!.plan);
  const cxAfter = meanCx(g1.bodies3d.filter((b) => b.cabId === 'cab_B'));
  const DX = 2800 - 1000;
  ok('2D（plan 图元）位移 === 解析位移', exec3?.ok === true && placement3.x === 2800 && placement3.y === 60 && Math.abs(planAfter.min.x - planBefore.min.x - DX) < 0.5, `${planAfter.min.x - planBefore.min.x}`);
  ok('3D（bodies3d）位移 === 同一个解析位移', exec3?.ok === true && placement3.x === 2800 && placement3.y === 60 && Math.abs(cxAfter - cxBefore - DX) < 0.5, `${cxAfter - cxBefore}`);
}

function primBox(prims: Prim[]): Box {
  return bboxOf(prims.flatMap((p) => (p.k === 'text' ? [p.p] : p.pts)));
}
function meanCx(bs: Array<{ cx: number }>): number {
  return bs.length === 0 ? 0 : bs.reduce((a, b) => a + b.cx, 0) / bs.length;
}

// ═══════════════════ §6 Proposal / AI 边界 ═══════════════════
section('§6 Proposal / AI：能说"哪两个面贴"，但不能给坐标');
{
  const baseProposal: DesignProposal = {
    title: 'P8.2 贴合验收',
    room: '主卧',
    cabinets: [
      { ref: 'base', name: '贴合基准柜', width: 1200, height: 2200, depth: 550 },
      { ref: 'next', name: '贴合柜', width: 800, height: 2200, depth: 600, placement: { relation: 'attach', reference: 'base', targetFace: 'left', referenceFace: 'right' } },
    ],
  };
  const placeIssueCodes = (p: DesignProposal): string[] =>
    validateProposal(p, sampleProject(rules)).filter((i) => i.code.startsWith('PROPOSAL-PLACE')).map((i) => i.code);
  ok('合法 attach 意图：validateProposal 无 PLACE 类错误', placeIssueCodes(baseProposal).length === 0, JSON.stringify(placeIssueCodes(baseProposal)));

  const compile = compileProposal(baseProposal, sampleProject(rules), rules);
  ok('编译成功', compile.ok, compile.blockedReason ?? '');
  const placeActions = compile.actions.filter((a) => a.action === 'cabinet.place');
  ok('attach 编译出 cabinet.place（不是新动作）', placeActions.length === 1, JSON.stringify(compile.actions.map((a) => a.action)));
  ok('参数带两个面名、不含坐标',
    String(placeActions[0]!.params.targetFace) === 'left' &&
      String(placeActions[0]!.params.referenceFace) === 'right' &&
      !('x' in placeActions[0]!.params) && !('y' in placeActions[0]!.params),
    JSON.stringify(placeActions[0]!.params));
  ok('target 与 reference 都是 $ref 占位（AI 编不出 id）',
    placeActions[0]!.target.cabinetId === '$ref:next' && String(placeActions[0]!.params.reference) === '$ref:base');
  ok('缺省对齐写进 notes（系统按惯例取了什么，界面要显示）', compile.notes.some((n) => n.includes('start')), JSON.stringify(compile.notes));

  // 干跑 → 提交：贴合关系成立，且 preview === commit
  const bus = new CommandBus(sampleProject(rules), rules);
  const run = dryRunPlan({ bus, actions: compile.actions });
  ok('干跑全部步骤通过', run.steps.every((s) => s.ok), JSON.stringify(run.steps.filter((s) => !s.ok).map((s) => s.error)));
  const draftBase = run.draft.cabinets.find((c) => c.name === '贴合基准柜')!;
  const draftNext = run.draft.cabinets.find((c) => c.name === '贴合柜')!;
  const sb = faceSeg(draftBase, 'right');
  const sn = faceSeg(draftNext, 'left');
  ok('草稿里两个面真的贴合（独立重算：共面 + 有重叠，深度不同也成立）', facesFlush(sb, sn), JSON.stringify([sb, sn]));
  ok('草稿里起始端对齐（缺省 start）', Math.hypot(sb.start.x - sn.start.x, sb.start.y - sn.start.y) < 0.5);
  const committed = commitPlan(run, bus);
  ok('提交成功', committed.ok, committed.ok ? '' : committed.error);
  const fBase = bus.getState().cabinets.find((c) => c.name === '贴合基准柜')!.placement;
  const fNext = bus.getState().cabinets.find((c) => c.name === '贴合柜')!.placement;
  ok('预览 === 提交：placement 逐值相等',
    fBase.x === draftBase.placement.x && fBase.y === draftBase.placement.y &&
      fNext.x === draftNext.placement.x && fNext.y === draftNext.placement.y && fNext.rotation === draftNext.placement.rotation);
  const pContacts = deriveContacts(bus.getState()).filter(
    (c) => (c.a === draftBase.id && c.b === draftNext.id) || (c.a === draftNext.id && c.b === draftBase.id)
  );
  ok('提交后 P2 deriveContacts 验出相接（right ↔ left）',
    pContacts.length === 1 && pContacts[0]!.kind === 'butt' &&
      ((pContacts[0]!.a === draftBase.id && pContacts[0]!.edgeA === 'right' && pContacts[0]!.edgeB === 'left') ||
        (pContacts[0]!.a === draftNext.id && pContacts[0]!.edgeA === 'left' && pContacts[0]!.edgeB === 'right')),
    JSON.stringify(pContacts));

  // 可复现
  const bus2 = new CommandBus(sampleProject(rules), rules);
  const run2 = dryRunPlan({ bus: bus2, actions: compileProposal(baseProposal, sampleProject(rules), rules).actions });
  const next2 = run2.draft.cabinets.find((c) => c.name === '贴合柜')!;
  ok('same intent → same resolved placement（可复现）', next2.placement.x === draftNext.placement.x && next2.placement.y === draftNext.placement.y);

  // ── 负样本：每条精确到码 ──
  const noFace: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'base', name: '甲' },
    { ref: 'next', name: '乙', placement: { relation: 'attach', reference: 'base', referenceFace: 'right' } as never },
  ] };
  ok('attach 缺 targetFace → PROPOSAL-PLACE-FACE', placeIssueCodes(noFace).includes('PROPOSAL-PLACE-FACE'), JSON.stringify(placeIssueCodes(noFace)));
  const badFace: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'base', name: '甲' },
    { ref: 'next', name: '乙', placement: { relation: 'attach', reference: 'base', targetFace: 'top', referenceFace: 'right' } as never },
  ] };
  ok('attach 的面写了 top → PROPOSAL-PLACE-FACE', placeIssueCodes(badFace).includes('PROPOSAL-PLACE-FACE'));
  const badAlign: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'base', name: '甲' },
    { ref: 'next', name: '乙', placement: { relation: 'attach', reference: 'base', targetFace: 'left', referenceFace: 'right', alignment: 'left' } as never },
  ] };
  ok('attach 用了 adjacent 的对齐词 → PROPOSAL-PLACE-ALIGNMENT', placeIssueCodes(badAlign).includes('PROPOSAL-PLACE-ALIGNMENT'), JSON.stringify(placeIssueCodes(badAlign)));
  const badOffset: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'base', name: '甲' },
    { ref: 'next', name: '乙', placement: { relation: 'attach', reference: 'base', targetFace: 'left', referenceFace: 'right', offset: -5 } },
  ] };
  ok('attach 的 offset 是负数 → PROPOSAL-PLACE-OFFSET', placeIssueCodes(badOffset).includes('PROPOSAL-PLACE-OFFSET'), JSON.stringify(placeIssueCodes(badOffset)));
  const cyc: DesignProposal = { ...baseProposal, cabinets: [
    { ref: 'a', name: '甲', placement: { relation: 'attach', reference: 'b', targetFace: 'left', referenceFace: 'right' } },
    { ref: 'b', name: '乙', placement: { relation: 'attach', reference: 'a', targetFace: 'left', referenceFace: 'right' } },
  ] };
  ok('attach 互为参照成环 → PROPOSAL-PLACE-CYCLE', placeIssueCodes(cyc).includes('PROPOSAL-PLACE-CYCLE'), JSON.stringify(placeIssueCodes(cyc)));

  // 形状门：attach 里夹带坐标一样拒收
  const shapeErr = proposalShapeError({ title: 't', cabinets: [{ ref: 'a', placement: { relation: 'attach', reference: 'b', targetFace: 'left', referenceFace: 'right', x: 100 } }] });
  ok('形状门：attach 夹带 x → 拒收', typeof shapeErr === 'string' && shapeErr.includes('坐标'), String(shapeErr));
  const shapeTop = proposalShapeError({ title: 't', cabinets: [{ ref: 'a', placement: { relation: 'attach', reference: 'b', targetFace: 'top', referenceFace: 'right' } }] });
  ok('形状门：面名写了 top → 拒收（形状门挡封闭词汇表）', typeof shapeTop === 'string' && shapeTop.includes('top'), String(shapeTop));
  const shapeOk = proposalShapeError({ title: 't', cabinets: [{ ref: 'a', placement: { relation: 'attach', reference: 'b', targetFace: 'left', referenceFace: 'right', offset: 10 } }] });
  ok('形状门：合法 attach 放行', shapeOk === null, String(shapeOk));

  // 契约：relation 词汇含 attach，参数里有两张面，仍然没有坐标
  const cp = (ACTIONS as Record<string, { params: Record<string, { values?: string[] }> }>)['cabinet.place']!.params;
  ok('契约：relation 词汇含 attach', (cp.relation?.values ?? []).includes('attach'), JSON.stringify(cp.relation?.values));
  ok('契约：有 targetFace / referenceFace / offset 三个参数', !!(cp.targetFace && cp.referenceFace && cp.offset));
  ok('契约：仍然没有 x / y 参数（结构性保证）', !('x' in cp) && !('y' in cp), JSON.stringify(Object.keys(cp)));
  ok('契约：面只有四个垂直面（没有 top/bottom）',
    (cp.targetFace?.values ?? []).join('/') === 'left/right/front/back', JSON.stringify(cp.targetFace?.values));

  // compileAction：AI 直接给 attach → 编译成带整数坐标的 cabinet.place
  // 样本项目只有一只柜，补一只参照柜（同房间、轴对齐）才谈得上贴合
  const fresh = sampleProject(rules);
  fresh.cabinets.push(
    createCabinet({
      id: 'cab_ref',
      name: '参照柜',
      roomId: fresh.rooms[0]!.id,
      x: 2600,
      y: 60,
      rotation: 0,
      rules,
      params: { ...defaultCabinetParams(rules), width: 800, height: 2200, depth: 550 },
      units: defaultUnits(800, rules, 550),
    })
  );
  assignFixtureUnitIds(fresh);
  const freshDuplicates = findDuplicateUnitIds(fresh);
  ok('AI compile fixture（含 cab_ref）构造后 Unit ID 全局唯一', freshDuplicates.length === 0, JSON.stringify(freshDuplicates));
  const action: AiAction = {
    action: 'cabinet.place',
    target: { cabinetName: '主卧衣柜' },
    params: { relation: 'attach', reference: '参照柜', targetFace: 'right', referenceFace: 'left', alignment: 'center' },
    reason: '验收：AI 表达面接触',
    index: 0,
  };
  const compiled = compileAction(action, fresh, rules);
  ok('AI 的 attach 意图 → 编译出 cabinet.place 命令（坐标由系统算）',
    compiled.ok && compiled.command.op === 'cabinet.place' && compiled.command.changes.length === 3, JSON.stringify(compiled.ok ? compiled.command.changes : compiled.error));
  ok('  命令里的坐标是引擎算出来的整数（AI 没给过坐标）',
    compiled.ok && compiled.command.changes.every((ch) => Number.isInteger(ch.value)), JSON.stringify(compiled.ok ? compiled.command.changes : ''));
  const attachWithCoord = compileAction({ ...action, params: { ...action.params, x: 999 } as never }, fresh, rules);
  ok('AI 在 attach 里夹带坐标：契约无此参数 → 编译不认（坐标不进命令）',
    attachWithCoord.ok && attachWithCoord.command.changes.every((ch) => /^placement\.(x|y|rotation)$/.test(ch.path)),
    attachWithCoord.ok ? '' : String(attachWithCoord.error));
  // 更强的判据：夹带的 999 对解析结果**一点影响都没有**（否则就是曲线坐标通道）
  ok('  夹带的 x=999 完全不影响解析结果（与没夹带时逐值相同）',
    attachWithCoord.ok && compiled.ok && eq(attachWithCoord.command.changes, compiled.command.changes),
    JSON.stringify(attachWithCoord.ok ? attachWithCoord.command.changes : attachWithCoord.error));
}

// ═══════════════════ 汇总 ═══════════════════
console.log(`\n总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败断言：');
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
