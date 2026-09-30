/**
 * ══════════════════════════════════════════════════════════════════════
 *  P8.3 验收 —— Placement Design / Assembly Validation
 *
 *  出口判据：**几何上合法的落位 ≠ 设计语义上合理的落位**，系统必须能把
 *  后者明确说出来（warning + 候选朝向），且**不许替用户改**。
 *
 *  ── 这一批断言真正在防什么 ──
 *   ① **Validator 重新算 Placement。** 它只消费 ResolvedPlacement，
 *      不重新解析、不改 rotation —— 前后 placement 逐值相等是硬断言。
 *   ② **设计习惯被硬编码成规则。** 不许出现"corner 必须 rotation=270"：
 *      左右转角/镜像都可能合理。可疑只报 warning，并把**所有**同样成立的
 *      候选朝向列出来（ambiguous=true），不排序、不推荐、不自动选。
 *   ③ **第二套 facing / 第二套接触判定。** facing 只从 placement.ts 派生的
 *      frontDirection 取（源码扫描：本模块无 cos/sin）；接触只从 P2 的
 *      deriveContacts 取；P2 能证明的硬冲突直接透传，不重写。
 *   ④ **几何合法被当成设计正确。** 核心 fixture：副臂 rotation=90 严丝合缝
 *      贴住主臂右端（P2 判接触成立、解析成功），但贴上去的是**门脸** ——
 *      必须报 warning，且给出 270 等候选。
 *   ⑤ **warning 变拦截。** 有设计疑问时计划仍然可提交（提示不是硬规则），
 *      且 preview === commit 依旧成立。
 *   ⑥ **静默通过。** 解析失败必须变成 status=error（透传解析层结构化错误），
 *      绝不因为"没算出来"就当 valid。
 *
 *  注：方向向量在验收侧**故意独立重算**（整数三角），不 import 被测实现自我证明。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, FurnitureAssembly, Prim, Project, RuleSet, Vec2 } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import {
  frontDirection,
  backDirection,
  leftDirection,
  rightDirection,
  resolvePlacement,
  sceneFromProject,
  type PlacementIntent,
} from '../src/core/placement.ts';
import {
  cornerTurnSide,
  designCheckPlacement,
  frontFacesCabinet,
  validatePlacementDesign,
  withResolvedPlacements,
  type DesignPlacementReport,
} from '../src/core/placementDesign.ts';
import { bboxOf } from '../src/core/geometry/transform.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { deriveContacts } from '../src/core/relations.ts';
import { compileAction, type AiAction } from '../src/ai/compile.ts';
import { commitPlan, dryRunPlan } from '../src/ai/planRunner.ts';

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

// ───────────── 测试场景 ─────────────

const ROOM = rectRoom({ name: '测试房', x: 0, y: 0, w: 9000, h: 6000, thickness: 100, height: 2700 });

function mkCab(id: string, name: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet {
  return createCabinet({
    id,
    name,
    roomId: ROOM.id,
    x,
    y,
    rotation,
    rules,
    params: { ...defaultCabinetParams(rules), width: w, height: 2200, depth: d },
    units: defaultUnits(w, rules, d),
  });
}

function mkProject(cabs: Cabinet[], assemblies?: FurnitureAssembly[]): Project {
  return {
    schemaVersion: '0.3',
    id: 'proj_p83',
    name: 'P8.3 设计语义验收',
    ruleSetId: rules.id,
    rooms: [ROOM],
    cabinets: cabs,
    ...(assemblies ? { assemblies } : {}),
  };
}

const asmCorner = (id: string, a: string, b: string): FurnitureAssembly => ({
  id,
  name: 'L 型组合',
  roomId: ROOM.id,
  memberIds: [a, b],
  connections: [{ id: `${id}_c1`, kind: 'corner', a: { cabinetId: a }, b: { cabinetId: b }, origin: 'authored' }],
});

/** 主臂 A：rot0，(2000,60) 1500×600 ⇒ 占 x[2000,3500] y[60,660]，门脸朝 +Y */
const armA = (): Cabinet => mkCab('cab_A', '主臂A', 2000, 60, 1500, 600, 0);

/** 副臂 rot270 落在 A 的右前角 ⇒ 标准 L（corner 相接，门脸朝 +X 不朝内） */
const armBGood = (): Cabinet => mkCab('cab_B', '副臂B', 3500, 1560, 900, 600, 270);
/** 副臂 rot90 贴死 A 的右端 ⇒ 几何上严丝合缝，但贴的是**门脸**（P8.2 真实案例） */
const armBBad = (): Cabinet => mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90);

/** 验收侧独立重算：柜体四向的世界朝向（整数三角，不 import 被测实现） */
function dirsOf(cab: Cabinet): { front: Vec2; back: Vec2; left: Vec2; right: Vec2 } {
  const r = (cab.placement.rotation * Math.PI) / 180;
  const c = Math.round(Math.cos(r));
  const s = Math.round(Math.sin(r));
  const rot = (v: Vec2): Vec2 => ({ x: v.x * c - v.y * s, y: v.x * s + v.y * c });
  const front = rot({ x: 0, y: 1 });
  const right = rot({ x: 1, y: 0 });
  return {
    front,
    back: { x: -front.x, y: -front.y },
    right,
    left: { x: -right.x, y: -right.y },
  };
}
const near = (a: Vec2, b: Vec2): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/** 验收侧独立重算：足迹包围盒 */
function footprintBox(cab: Cabinet): Box {
  const r = (cab.placement.rotation * Math.PI) / 180;
  const c = Math.round(Math.cos(r));
  const s = Math.round(Math.sin(r));
  const pts = [
    { x: 0, y: 0 },
    { x: cab.params.width, y: 0 },
    { x: cab.params.width, y: cab.params.depth },
    { x: 0, y: cab.params.depth },
  ].map((p) => ({ x: cab.placement.x + p.x * c - p.y * s, y: cab.placement.y + p.x * s + p.y * c }));
  return bboxOf(pts);
}
function primBox(prims: Prim[]): Box {
  return bboxOf(prims.flatMap((p) => (p.k === 'text' ? [p.p] : p.pts)));
}
const boxesOverlap = (a: Box, b: Box): boolean =>
  a.min.x < b.max.x - 2 && a.max.x > b.min.x + 2 && a.min.y < b.max.y - 2 && a.max.y > b.min.y + 2;

// ═══════════════════ §1 facing 语义（派生，不新增字段）═══════════════════
section('§1 Orientation / Facing：由 rotation 派生，模型里不加第二个真相');
{
  for (const rot of [0, 90, 180, 270]) {
    const cab = mkCab('cab_r', '朝向柜', 2000, 60, 1200, 600, rot);
    const want = dirsOf(cab);
    ok(
      `  rotation ${rot}°：frontDirection 与独立重算一致`,
      near(frontDirection(cab), want.front),
      JSON.stringify([frontDirection(cab), want.front])
    );
    ok(
      `  rotation ${rot}°：back / left / right 三向同样一致`,
      near(backDirection(cab), want.back) && near(leftDirection(cab), want.left) && near(rightDirection(cab), want.right),
      JSON.stringify([backDirection(cab), leftDirection(cab), rightDirection(cab)])
    );
    ok(
      `  rotation ${rot}°：front ⟂ right 且 front 与 back 反向（同一套旋转出来的）`,
      Math.abs(frontDirection(cab).x * rightDirection(cab).x + frontDirection(cab).y * rightDirection(cab).y) < 1e-6 &&
        near(frontDirection(cab), { x: -backDirection(cab).x, y: -backDirection(cab).y })
    );
  }
  const cab = armA();
  const keys = Object.keys(cab.placement).sort();
  ok('模型里没有 facing / orientation 之类的第二字段（placement 仍只有 x/y/rotation）', eq(keys, ['rotation', 'x', 'y']), JSON.stringify(keys));
  ok('柜体上没有 facing 字段（朝向是派生的，写进模型就是第二份真相）', !('facing' in cab) && !('front' in cab));
  ok('facing 只用 placement.ts 的实现：placementDesign.ts 源码里没有 cos/sin（无第二套旋转数学）', (() => {
    const src = readFileSync(join(APP, 'src', 'core', 'placementDesign.ts'), 'utf8');
    return !/Math\.cos\s*\(|Math\.sin\s*\(/.test(src);
  })());
}

// ═══════════════════ §2 resolved + valid（好 L）══════════════════
section('§2 几何成立且设计语义也成立 ⇒ valid（不给假警报）');
{
  const A = armA();
  const B = armBGood();
  const project = mkProject([A, B]);
  const contacts = deriveContacts(project);
  ok('P2 派生：两只柜确实是 corner 相接（独立接触判定）', contacts.length === 1 && contacts[0]!.kind === 'corner', JSON.stringify(contacts));
  ok('两只柜不重叠（重叠归碰撞，不该被当关系）', !boxesOverlap(footprintBox(A), footprintBox(B)));

  const rep = validatePlacementDesign(project);
  ok('设计结论 = valid（没有 warning，也没有 error）', rep.status === 'valid' && rep.findings.length === 0, JSON.stringify(rep.findings));
  ok('接触事实带上转角方向（右转角）', rep.contacts.length === 1 && rep.contacts[0]!.turn === 'right', JSON.stringify(rep.contacts));
  ok('cornerTurnSide 与独立判断一致：副臂在 A 的右手边', cornerTurnSide(A, B) === 'right');
  ok('两只柜的门脸都不朝内（这是"好 L"的判据本身）', !frontFacesCabinet(A, B) && !frontFacesCabinet(B, A));
}

// ═══════════════════ §3 核心：几何合法 ≠ 设计正确 ═══════════════════
section('§3 真实 fixture：几何严丝合缝，但贴上去的是门脸（P8.2 撞出来的那一种）');
{
  const A = armA();
  const B = armBBad();
  const project = mkProject([A, B]);
  const contacts = deriveContacts(project);
  // ① 几何这边全部成立：接触判定说它们连着，且不重叠
  ok('几何上完全成立：P2 判定两柜相接', contacts.length === 1, JSON.stringify(contacts));
  ok('几何上完全成立：不重叠（不是碰撞）', !boxesOverlap(footprintBox(A), footprintBox(B)));
  ok('相贴的正是 B 的门脸那一面（独立复核：B 的 front 面与 A 的右端共面）', (() => {
    const ba = footprintBox(A);
    const bb = footprintBox(B);
    // B rot90：门脸朝 -X，贴在 A 的右端 ⇒ B.min.x 与 A.max.x 相切
    return Math.abs(bb.min.x - ba.max.x) < 0.5 && Math.abs(frontDirection(B).x + 1) < 1e-6;
  })());

  // ② 设计语义这边必须说话
  const rep = validatePlacementDesign(project);
  ok('设计结论 = warning（几何成立但语义可疑）', rep.status === 'warning', JSON.stringify(rep.status));
  ok('只点名了门脸朝内的那只柜（不株连）', rep.findings.length === 1 && rep.findings[0]!.cabinetId === 'cab_B', JSON.stringify(rep.findings.map((f) => f.cabinetId)));
  const f = rep.findings[0]!;
  ok('码是 DESIGN-FRONT-BLOCKED（并排贴合语境）', f.code === 'DESIGN-FRONT-BLOCKED', f.code);
  ok('文案带得出现场数字：rotation 与门脸宽度（不是"检查一下"）',
    f.message.includes('90') && f.message.includes(String(B.params.width)) && f.message.includes('副臂B'), f.message);
  ok('文案说出挡它的是谁', f.message.includes('主臂A'), f.message);

  // ③ 候选朝向：列出来但不替选
  const alts = f.alternatives ?? [];
  ok('给出候选朝向（含用户直觉里更合理的 270°）', alts.some((a) => a.rotation === 270), JSON.stringify(alts));
  ok('候选不止一个 ⇒ ambiguous=true（左右转角/镜像都可能合理，系统不替用户选）', f.ambiguous === true && alts.length > 1, JSON.stringify(alts));
  ok('当前朝向不在候选里（候选是"别的可能"，不是复述现状）', !alts.some((a) => a.rotation === 90), JSON.stringify(alts));
  ok('每个候选都写明"位置要按新朝向重新解析"（不说半截话）', alts.every((a) => a.note.includes('重新解析')), JSON.stringify(alts));

  // ④ 不许自动改 rotation
  ok('Validator 没改 rotation（B 仍是 90°）', B.placement.rotation === 90);
  ok('Validator 没改 placement（x/y 原地不动）', B.placement.x === 4100 && B.placement.y === 60);
  ok('finding 上没有一键修复（转哪个方向是设计决定，界面不许给假按钮）', !('autoFix' in f) && !('fix' in f));
}

// ═══════════════════ §4 门对门（两只柜门脸相对）══════════════════
section('§4 两只柜门脸相对 ⇒ 两边都点名，且报出"2 只"');
{
  const A = mkCab('cab_A', '下柜A', 2000, 60, 1500, 600, 0); // y[60,660] 门脸朝 +Y
  const B = mkCab('cab_B', '上柜B', 2800, 1260, 800, 600, 180); // y[660,1260] 门脸朝 -Y
  const project = mkProject([A, B]);
  const rep = validatePlacementDesign(project);
  ok('两只柜门脸互相朝着对方', frontFacesCabinet(A, B) && frontFacesCabinet(B, A));
  ok('status = warning', rep.status === 'warning');
  ok('两只柜各一条（共 2 条）', rep.findings.length === 2, JSON.stringify(rep.findings.map((x) => x.cabinetId)));
  ok('文案说清这一对里有 2 只柜门脸朝内', rep.findings.every((x) => x.message.includes('2 只柜门脸朝内')), rep.findings[0]?.message ?? '');
  ok('两条互为对方（不是同一只柜报两遍）', rep.findings[0]!.cabinetId !== rep.findings[1]!.cabinetId);
}

// ═══════════════════ §5 corner 左 / 右转角 ═══════════════════
section('§5 corner 的左转角与右转角都成立（不把某一方向写成唯一正确）');
{
  const A = armA();
  const right = mkCab('cab_R', '右转副臂', 3500, 1560, 900, 600, 270);
  const left = mkCab('cab_L', '左转副臂', 2000, 660, 900, 600, 90);
  const pR = mkProject([A, right]);
  const pL = mkProject([A, left]);
  ok('右转角：P2 判 corner', deriveContacts(pR).length === 1 && deriveContacts(pR)[0]!.kind === 'corner');
  ok('左转角：P2 判 corner', deriveContacts(pL).length === 1 && deriveContacts(pL)[0]!.kind === 'corner');
  ok('右转角：cornerTurnSide = right', cornerTurnSide(A, right) === 'right');
  ok('左转角：cornerTurnSide = left', cornerTurnSide(A, left) === 'left');
  ok('右转角：设计结论 valid（不因为"不是某个固定角度"就报警）', validatePlacementDesign(pR).status === 'valid', JSON.stringify(validatePlacementDesign(pR).findings));
  ok('左转角：设计结论 valid', validatePlacementDesign(pL).status === 'valid', JSON.stringify(validatePlacementDesign(pL).findings));
  ok('左右转角互不相同（说明方向真的被算出来了，不是常量）', cornerTurnSide(A, right) !== cornerTurnSide(A, left));
}

// ═══════════════════ §6 不同宽深 / 不同 alignment ═══════════════════
section('§6 不同柜宽 / 550·600 柜深 / start·center·end 对齐：都不该假报警');
{
  const A = mkCab('cab_A', '基准柜', 400, 60, 2400, 600, 0);
  for (const [w, d] of [[800, 550], [800, 600], [1200, 550], [600, 600]] as const) {
    for (const alignment of ['start', 'center', 'end'] as const) {
      const B = mkCab('cab_B', '贴合柜', 3000, 1000, w, d, 0);
      const project = mkProject([A, B]);
      const intent: PlacementIntent = {
        relation: 'attach',
        targetId: 'cab_B',
        referenceId: 'cab_A',
        targetFace: 'left',
        referenceFace: 'right',
        alignment,
      };
      const r = resolvePlacement(intent, sceneFromProject(project));
      const rep = designCheckPlacement(project, intent, r);
      ok(`  ${w}×${d} alignment=${alignment}：解析成功且设计结论 valid`,
        r.ok && rep.status === 'valid',
        r.ok ? JSON.stringify(rep.findings) : String(r.error.message));
      if (r.ok) {
        const applied = withResolvedPlacements(project, [{ intent, placement: r.placement }]);
        const ct = deriveContacts(applied);
        ok(`  ${w}×${d} alignment=${alignment}：P8 解析出的贴合能被 P2 独立验出来（两层说法一致）`,
          ct.length === 1 && ct[0]!.kind === 'butt',
          JSON.stringify(ct));
      }
    }
  }
  // 550 与 600 混深：start 对齐时长边伸出 50mm，仍然是真贴合且不报设计疑问
  const A2 = mkCab('cab_A', '深柜', 400, 60, 2400, 600, 0);
  const B2 = mkCab('cab_B', '浅柜', 3000, 1000, 800, 550, 0);
  const project2 = mkProject([A2, B2]);
  const intent2: PlacementIntent = { relation: 'attach', targetId: 'cab_B', referenceId: 'cab_A', targetFace: 'left', referenceFace: 'right' };
  const r2 = resolvePlacement(intent2, sceneFromProject(project2));
  const rep2 = designCheckPlacement(project2, intent2, r2);
  ok('550 贴 600（面长不同）：仍然 valid —— 面接触不等于整边重合', r2.ok && rep2.status === 'valid', r2.ok ? JSON.stringify(rep2.findings) : String(r2.error.message));
}

// ═══════════════════ §7 与 P2 的边界：硬冲突透传，不重写 ═══════════════════
section('§7 P2 能证明的硬冲突 ⇒ status=error（复用它的结论，不另写一份判定）');
{
  // 声明 corner，实际是 butt（门脸贴死）⇒ P2 判 ASSEMBLY-KIND-MISMATCH
  const A = armA();
  const B = armBBad();
  const declared = mkProject([A, B], [asmCorner('asm_1', 'cab_A', 'cab_B')]);
  const rep = validatePlacementDesign(declared);
  ok('status = error（已证明非法，不是"可疑"）', rep.status === 'error', JSON.stringify(rep.status));
  const hard = rep.findings.filter((f) => f.code === 'DESIGN-ASSEMBLY');
  ok('透传 P2 的规则码（不自己重写一遍接触/转角判定）', hard.length > 0 && hard[0]!.sourceCode === 'ASSEMBLY-KIND-MISMATCH', JSON.stringify(hard.map((h) => h.sourceCode)));
  ok('文案直接用 P2 的原话（唯一真相源仍是 issueCatalog）', hard[0]!.message.includes('L 型') || hard[0]!.message.includes('角接'), hard[0]!.message);
  ok('同一份里设计疑问仍在（error 不掩盖 warning）', rep.findings.some((f) => f.code === 'DESIGN-FRONT-BLOCKED'));

  // 声明 corner 且真的是 corner ⇒ valid
  const good = mkProject([armA(), armBGood()], [asmCorner('asm_2', 'cab_A', 'cab_B')]);
  ok('声明 corner + 真 corner ⇒ valid（不假报警）', validatePlacementDesign(good).status === 'valid', JSON.stringify(validatePlacementDesign(good).findings));
}

// ═══════════════════ §8 resolved + error（解析没出来 ≠ valid）══════════════════
section('§8 落位没解析出来 ⇒ error（绝不因为"算不出"就当没问题）');
{
  const A = armA();
  const B = mkCab('cab_B', '副臂B', 4100, 60, 900, 600, 90);
  const project = mkProject([A, B]);
  const before = JSON.stringify(project);

  const self: PlacementIntent = { relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_B', side: 'right' };
  const rs = resolvePlacement(self, sceneFromProject(project));
  const repSelf = designCheckPlacement(project, self, rs);
  ok('自参照解析失败 ⇒ status=error', !rs.ok && repSelf.status === 'error', JSON.stringify([rs, repSelf.status]));
  ok('码是 DESIGN-RESOLVE-FAILED（透传解析层，不自己编一条）', repSelf.findings[0]?.code === 'DESIGN-RESOLVE-FAILED');
  ok('错误信息原样带出来（含解析层的结构化原因）', repSelf.findings[0]!.message.includes('自己'), repSelf.findings[0]!.message);

  const same_face: PlacementIntent = { relation: 'attach', targetId: 'cab_B', referenceId: 'cab_A', targetFace: 'right', referenceFace: 'right' };
  const rf = resolvePlacement(same_face, sceneFromProject(project));
  const repFace = designCheckPlacement(project, same_face, rf);
  ok('两个面朝向对不上 ⇒ error（不退化成相邻）', !rf.ok && repFace.status === 'error', JSON.stringify([rf.ok, repFace.status]));
  ok('语义校验没有偷偷改模型（解析失败也不许动）', JSON.stringify(project) === before);
}

// ═══════════════════ §9 架构：纯函数 · 不改模型 · 同输入同结果 ═══════════════════
section('§9 架构：Validator 是纯函数（不改模型、不改 placement、同输入同结果）');
{
  const A = armA();
  const B = armBBad();
  const project = mkProject([A, B], [asmCorner('asm_1', 'cab_A', 'cab_B')]);
  const before = JSON.stringify(project);
  const placementBefore = JSON.stringify(project.cabinets.map((c) => c.placement));

  const r1 = validatePlacementDesign(project);
  const r2 = validatePlacementDesign(project);
  ok('同输入同结果（两次结论逐字节相同）', eq(r1, r2));
  ok('没改 Semantic Model（整个 project 前后一致）', JSON.stringify(project) === before);
  ok('没改任何 placement', JSON.stringify(project.cabinets.map((c) => c.placement)) === placementBefore);
  ok('没往柜体上挂设计结论之类的派生字段（派生不落模型）',
    eq(Object.keys(project.cabinets[0]!), Object.keys(armA())));

  // 解析结果套到副本上：原项目必须原样
  // 用一个**还没贴上去**的副臂（放在 6000，解析后才挪到主臂右端）——
  // 若拿"本来就已经贴着"的柜来测，解析前后位置相同，"只有目标柜变了"就成了空断言。
  const intent: PlacementIntent = { relation: 'adjacent', targetId: 'cab_B', referenceId: 'cab_A', side: 'right' };
  const moving = mkProject([armA(), mkCab('cab_B', '副臂B', 6000, 60, 900, 600, 90)]);
  const movingBefore = JSON.stringify(moving);
  const rr = resolvePlacement(intent, sceneFromProject(moving));
  const applied = withResolvedPlacements(moving, [{ intent, placement: rr.ok ? rr.placement : { x: 0, y: 0, rotation: 0 } }]);
  ok('withResolvedPlacements 不动原项目（返回副本）', JSON.stringify(moving) === movingBefore && rr.ok);
  ok('副本里只有目标柜的位置变了（参照柜原地不动）', (() => {
    const moved = applied.cabinets.filter((c) => !eq(c.placement, moving.cabinets.find((p) => p.id === c.id)!.placement));
    return moved.length === 1 && moved[0]!.id === 'cab_B';
  })(), rr.ok ? JSON.stringify(rr.placement) : '解析失败');

  // 源码扫描：复用而非复制
  const src = readFileSync(join(APP, 'src', 'core', 'placementDesign.ts'), 'utf8');
  ok('复用 P2 的接触判定（源码里出现 deriveContacts，且没有第二份 contact 实现）',
    src.includes('deriveContacts') && !/edgesFlush|overlapLen|CONTACT_TOL/.test(src));
  ok('复用 P2 的声明校验（validateAssemblies），不另写一套组合校验', src.includes('validateAssemblies'));
  ok('不复制面↔边映射（源码里没有 rectPts 面表）', !/rectPts\s*\(/.test(src));
  ok('文案走 issueCatalog（唯一真相源），不自己拼 message', src.includes('buildIssue') && !/message:\s*`/.test(src));
}

// ═══════════════════ §10 warning 不拦截 · preview == commit ═══════════════════
section('§10 设计疑问不拦截提交（提示不是硬规则），且 preview === commit 依然成立');
{
  // ① 干净落位：干跑预览带着 design 结论，提交后与预览逐值相同
  const project = mkProject([mkCab('cab_A', '主卧衣柜', 400, 60, 2400, 600, 0), mkCab('cab_B', '次卧衣柜', 4000, 60, 800, 600, 0)]);
  const action: AiAction = {
    action: 'cabinet.place',
    target: { cabinetName: '次卧衣柜' },
    params: { relation: 'attach', reference: '主卧衣柜', targetFace: 'left', referenceFace: 'right', alignment: 'center' },
    reason: '验收：贴到基准柜右侧',
    index: 0,
  };
  const compiled = compileAction(action, project, rules);
  ok('AI 表达 attach → 编译成功（仍然不给坐标）', compiled.ok, compiled.ok ? '' : String(compiled.error));
  ok('编译结果带上设计语义结论（AI 链路能拿到）', compiled.ok && compiled.design !== undefined && compiled.design.status === 'valid',
    compiled.ok ? JSON.stringify(compiled.design) : '');

  const bus = new CommandBus(project, rules);
  const run = dryRunPlan({ bus, actions: [action] });
  ok('干跑预览也带着设计结论（预览阶段就能看见疑问）', run.design !== undefined && run.design.status === 'valid', JSON.stringify(run.design?.status));
  const draftB = run.draft.cabinets.find((c) => c.id === 'cab_B')!.placement;
  const cm = commitPlan(run, bus);
  const finalB = bus.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
  ok('提交成功', cm.ok, cm.error ?? '');
  ok('preview === commit（提交后的 placement 与预览草稿逐值相同）', eq(draftB, finalB), JSON.stringify([draftB, finalB]));

  // ② 门脸贴邻居：warning 照报，但**不拦截**
  const bad = mkProject([armA(), mkCab('cab_B', '副臂B', 6000, 60, 900, 600, 90)]);
  const badAction: AiAction = {
    action: 'cabinet.place',
    target: { cabinetName: '副臂B' },
    params: { relation: 'adjacent', reference: '主臂A', side: 'right' },
    reason: '验收：副臂贴主臂右侧（rot90，门脸朝内）',
    index: 0,
  };
  const badBus = new CommandBus(bad, rules);
  const badRun = dryRunPlan({ bus: badBus, actions: [badAction] });
  const badFindings = badRun.design?.findings ?? [];
  ok('几何成立但门脸朝内 ⇒ 干跑预览里出现设计疑问', badRun.design?.status === 'warning' && badFindings.some((f) => f.code === 'DESIGN-FRONT-BLOCKED'), JSON.stringify(badRun.design?.status));
  ok('有疑问也照样能提交（warning 不是拦截）', badRun.blockingErrors === 0 && badRun.errorCount === 0, JSON.stringify([badRun.blockingErrors, badRun.errorCount]));
  const badCommit = commitPlan(badRun, badBus);
  ok('确实提交成功（提示归提示，不偷偷拒绝）', badCommit.ok, badCommit.error ?? '');
  const placed = badBus.getState().cabinets.find((c) => c.id === 'cab_B')!.placement;
  ok('提交后 rotation 仍是 90（系统没有"顺手"替用户改成 270）', placed.rotation === 90, JSON.stringify(placed));
  ok('提交后的位置与预览一致（可疑也不影响 preview===commit）',
    eq(placed, badRun.draft.cabinets.find((c) => c.id === 'cab_B')!.placement));
}

// ═══════════════════ §11 2D / 3D 仍消费同一份 resolved placement ═══════════════════
section('§11 设计层不产生第二套位置：2D 与 3D 仍同源于一次 derive');
{
  const project = mkProject([mkCab('cab_A', '主卧衣柜', 400, 60, 2400, 600, 0), mkCab('cab_B', '次卧衣柜', 4000, 60, 800, 600, 0)]);
  const before = generateProject(project, rules);
  const planBefore = primBox(before.cabinets['cab_B']!.plan);
  const cxBefore = meanCx(before.bodies3d.filter((b) => b.cabId === 'cab_B'));

  const intent: PlacementIntent = { relation: 'attach', targetId: 'cab_B', referenceId: 'cab_A', targetFace: 'left', referenceFace: 'right' };
  const r = resolvePlacement(intent, sceneFromProject(project));
  const applied = withResolvedPlacements(project, [{ intent, placement: r.ok ? r.placement : { x: 0, y: 0, rotation: 0 } }]);
  const after = generateProject(applied, rules);
  const planAfter = primBox(after.cabinets['cab_B']!.plan);
  const cxAfter = meanCx(after.bodies3d.filter((b) => b.cabId === 'cab_B'));
  const dx = (r.ok ? r.placement.x : 0) - 4000;
  ok('2D（plan 图元）位移与解析结果一致', Math.abs(planAfter.min.x - planBefore.min.x - dx) < 0.5, `${planAfter.min.x - planBefore.min.x} vs ${dx}`);
  ok('3D（bodies3d）位移与解析结果一致', Math.abs(cxAfter - cxBefore - dx) < 0.5, `${cxAfter - cxBefore} vs ${dx}`);
  ok('2D 与 3D 位移相同（同一份 resolved placement）', Math.abs(planAfter.min.x - planBefore.min.x - (cxAfter - cxBefore)) < 0.5);
  // 设计层没有给出"另一个位置"：结论里没有任何坐标字段
  const rep: DesignPlacementReport = validatePlacementDesign(applied);
  ok('design 结论里不含坐标（它只说合不合理，不产出第二个位置）', !/\d{3,}/.test(JSON.stringify(rep.findings.map((f) => f.code))));
}
function meanCx(bs: Array<{ cx: number }>): number {
  return bs.length === 0 ? 0 : bs.reduce((a, b) => a + b.cx, 0) / bs.length;
}

// ═══════════════════ 汇总 ═══════════════════
console.log(`\n总计 ${pass + fail} 项：通过 ${pass}，失败 ${fail}`);
if (fail > 0) {
  console.log('\n失败断言：');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
