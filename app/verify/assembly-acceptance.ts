import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, Prim, Project, RuleSet, Vec2 } from '../src/core/types.ts';
import { generateCabinet } from '../src/core/geometry/generate.ts';
import { backPanelSplit } from '../src/core/geometry/layout.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { buildAssembly, EXPLODE_LANE_STEP, EXPLODE_TIER_BASE, type Assembly, type PartInstance } from '../src/core/geometry/assembly.ts';
import {
  EXPLODE_SHEET_GAP,
  buildCabinetExplode,
  buildProjectExplode,
  type ExplodeViewSet,
} from '../src/core/geometry/explode.ts';
import { buildProjectViews } from '../src/core/geometry/views.ts';
import { createCabinet, sampleProject } from '../src/core/docFactory.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  分解图（爆炸图）验收 —— 把「可用于生产」变成可执行的定义
 *
 *  用户原话："4 视图调整好后可以选择生成分解图用于生产，也可以选择关闭。"
 *
 *  "可用于生产"落到可判定的条件上只有一条最重要：
 *    **分解图上的每一件，都能在开料清单里找到对应的一行，裁切尺寸逐字相同。**
 *  少了任何一件，或尺寸对不上，这张图就是有害的 —— 工人按它开料会开错。
 *  所以本脚本的正样本是"A 组一一对应"，其余各组是围绕它的防线。
 *
 *  分组：
 *    A. 与开料清单一一对应（件号 / 件数 / 裁切尺寸逐字相同）
 *    B. 三维落位与裁切尺寸的轴对齐（板厚方向正确、另外两轴与裁切尺寸同构）
 *    C. 爆炸位移：分层、错开、真的分开了
 *    D. 开关语义：默认关闭 = 零派生；开/关确定性
 *    E. 与四视图图幅不重叠（位置是算出来的）
 *    F. 图元健康度 / 件号气泡可读性
 *    G. 多柜
 *    H. 确定性 / 平移不变性
 *    I. **负样本** —— 每条"不许发生的事"都要能被检出，否则全绿不证明任何事
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

const TOL = 0.51;
const near = (a: number, b: number, tol = TOL): boolean => Math.abs(a - b) <= tol;

/** 每个实例的包围盒三个跨度（从大到小） */
function spans(box: { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number }): number[] {
  return [box.x1 - box.x0, box.y1 - box.y0, box.z1 - box.z0].sort((a, b) => b - a);
}

function sameMultiset(a: number[], b: number[], tol = TOL): boolean {
  if (a.length !== b.length) return false;
  const bb = [...b];
  for (const v of a) {
    const i = bb.findIndex((x) => Math.abs(x - v) <= tol);
    if (i < 0) return false;
    bb.splice(i, 1);
  }
  return bb.length === 0;
}

function ptsOf(p: Prim): Vec2[] {
  return p.k === 'text' ? [p.p] : p.pts;
}

// ───────────────────────────── 正样本数据 ─────────────────────────────

const project = sampleProject(rules);
const cab = project.cabinets[0];
const cut = generateCabinet(cab, rules);
const as: Assembly = buildAssembly(cab, rules);
const ex: ExplodeViewSet = buildCabinetExplode(cab, rules);

// ═══════════════════════════ A. 与开料清单一一对应 ═══════════════════════════

section('【A】分解图必须与开料清单逐项对应');

ok('A1 件号种类数 === 开料清单行数', as.check.panelKinds === cut.panels.length, `图上 ${as.check.panelKinds} / 清单 ${cut.panels.length}`);
ok(
  'A2 总件数 === 清单 Σqty',
  as.check.pieces === cut.panels.reduce((n, p) => n + p.qty, 0),
  `图上 ${as.check.pieces} / 清单 ${cut.panels.reduce((n, p) => n + p.qty, 0)}`
);
ok('A3 图上实际摆出的件数 === 总件数（qty 必须展开）', as.check.instances === as.check.pieces, `${as.check.instances} vs ${as.check.pieces}`);
ok('A4 明细栏行数 === 件号种类数', as.legend.length === as.check.panelKinds);
ok(
  'A5 件号连续且唯一（1..n）',
  as.legend.every((r, i) => r.no === i + 1),
  `实际：${as.legend.map((r) => r.no).join(',')}`
);
ok('A6 每个 panelId 在明细里只出现一次', new Set(as.legend.map((r) => r.panelId)).size === as.legend.length);
ok(
  'A7 明细行的裁切尺寸/材质/数量逐字取自清单',
  as.legend.every((row) => {
    const p = cut.panels.find((x) => x.id === row.panelId)!;
    return (
      p !== undefined &&
      row.nameZh === p.nameZh &&
      row.cut.length === p.length &&
      row.cut.width === p.width &&
      row.thickness === p.thickness &&
      row.qty === p.qty &&
      row.material === p.material &&
      row.role === p.role
    );
  })
);
ok(
  'A8 每一件实例的裁切尺寸都等于它所属清单行的尺寸',
  as.parts.every((part) => {
    const p = cut.panels.find((x) => x.id === part.panelId)!;
    return p && part.cut.length === p.length && part.cut.width === p.width && part.thickness === p.thickness;
  })
);
ok('A9 版件角色没有摆不出来的（unplaced 为空）', as.check.unplaced.length === 0, as.check.unplaced.join('、'));
ok('A10 摆位槽位数与 qty 全部一致', as.check.slotMismatches.length === 0, JSON.stringify(as.check.slotMismatches));
ok('A11 核对总开关 ok === true', as.check.ok === true);
ok(
  'A12 图上件号集合 === 明细件号集合（不重不漏）',
  JSON.stringify(ex.drawnNos) === JSON.stringify(as.legend.map((r) => r.no))
);
ok(
  'A13 每件实例都能在图上找到（PNAL 面板图元数 === 6 × 件数）',
  ex.prims.filter((p) => p.layer.startsWith('PANEL_')).length === 6 * as.check.instances,
  `实际 ${ex.prims.filter((p) => p.layer.startsWith('PANEL_')).length} / 期望 ${6 * as.check.instances}`
);
ok('A14 五金不进入爆炸件，但出现在明细里', as.parts.every((p) => p.role !== 'Hinge') && as.hardware.length > 0);

// ═══════════════════════════ B. 三维落位与裁切尺寸轴对齐 ═══════════════════════════

section('【B】三维落位的板厚方向与两轴尺寸必须与裁切尺寸同构');

const depthConflictRoles = new Set(['LeftSidePanel', 'RightSidePanel', 'TopPanel', 'BottomPanel', 'DividerPanel']);

/**
 * 嵌槽件（抽屉底板）：裁切尺寸里的 `−1mm` 是**两侧各 0.5mm 的嵌槽装配余量**，
 * 而落位框取的是**槽外沿**，所以被嵌的那一轴会比裁切尺寸宽 1mm。
 * 这是一个可判定且有界的例外（恰好 ≤1mm、且只出现在被嵌的那一轴），
 * 不是"尺寸差不多就行"。
 */
const GROOVE_FIT_ROLES = new Set(['DrawerBottom']);
const GROOVE_FIT_SLACK = 1;

/**
 * B2 的判据：除板厚轴外，另外两轴的跨度必须与**裁切尺寸**（降序）同构。
 *
 * 三类合法情形，全部是「可判定 + 有界」的显式例外：
 *   ① 完全相等 —— 绝大多数板件
 *   ② 箱体结构板：裁切进深取整柜深（含门厚）、装配进深不含门厚，恰好差一个板厚
 *      （Phase 1 起记录在案的 params.depth 语义待确认点，见 dimMismatches）
 *   ③ 嵌槽件：落位框取槽外沿，被嵌的那一轴宽 1mm
 *
 * 抽成函数是为了让负样本 I5 能**真的打到 B2** —— 否则 I5 只验证了 B1，
 * 而"B2 的判据写松了"这件事没有任何一条断言负责。
 */
function restAxesMatchCut(p: PartInstance): boolean {
  const s = spans(p.box);
  const th = s.findIndex((v) => near(v, p.thickness));
  if (th < 0) return false; // 板厚方向都找不到 → B1 的活，这里不给过
  const rest = s.filter((_, i) => i !== th);
  const want = [p.cut.length, p.cut.width].sort((a, b) => b - a);
  if (sameMultiset(rest, want)) return true;
  const d = rest.map((v, i) => v - want[i]);
  if (depthConflictRoles.has(p.role)) {
    const off = d.filter((x) => !near(x, 0)).length;
    if (off === 1 && near(Math.abs(d[0]) + Math.abs(d[1]), p.thickness)) return true;
  }
  if (GROOVE_FIT_ROLES.has(p.role)) {
    if (d.every((x) => x >= -0.05 && x <= GROOVE_FIT_SLACK + 0.05) && d.some((x) => x > 0.4)) return true;
  }
  return false;
}

const b2Bad = (): PartInstance[] => as.parts.filter((p) => !restAxesMatchCut(p));
const fmtBad = (list: PartInstance[]): string =>
  list.map((p) => `${p.nameZh} box=${spans(p.box).map((v) => Math.round(v)).join('/')} cut=${p.cut.length}×${p.cut.width}×${p.thickness}`).join('；');

ok(
  'B1 每件都有一个跨度 === 板厚（板厚方向不能错）',
  as.parts.every((p) => spans(p.box).some((s) => near(s, p.thickness))),
  as.parts.filter((p) => !spans(p.box).some((s) => near(s, p.thickness))).map((p) => p.nameZh).join('、')
);
ok('B2 另外两轴跨度与裁切尺寸同构（箱体板允许 depth 语义差一个板厚）', b2Bad().length === 0, fmtBad(b2Bad()));
ok(
  'B3 所有落位坐标都是有限正尺寸（无 NaN / 负跨度）',
  as.parts.every((p) => {
    const s = spans(p.box);
    return s.every((v) => Number.isFinite(v) && v > 0);
  })
);
ok(
  'B4 落位框全部在柜体范围附近（不外飘出柜体外 1 倍）',
  as.parts.every((p) => {
    const { W, H, D } = as.dims;
    const b = p.box;
    return b.x0 > -W && b.x1 < 2 * W && b.y0 > -D && b.y1 < 2 * D && b.z0 > -H && b.z1 < 2 * H;
  })
);
ok(
  'B5 dimMismatches 只出现在箱体板，且差值恰好是板厚',
  as.check.dimMismatches.every((m) => {
    const part = as.parts.find((p) => p.panelId === m.panelId)!;
    return part !== undefined && depthConflictRoles.has(part.role) && near(Math.abs(m.deltaMm), part.thickness);
  }),
  JSON.stringify(as.check.dimMismatches.map((m) => `${m.nameZh}:${m.deltaMm}`))
);
ok(
  'B6 非箱体板不得出现 dimMismatch',
  as.parts
    .filter((p) => !depthConflictRoles.has(p.role))
    .every((p) => !as.check.dimMismatches.some((m) => m.panelId === p.panelId))
);
ok('B7 depth 语义冲突被如实写进假设清单', as.assumptions.some((a) => a.includes('裁切进深') && a.includes('装配进深')));

// 背板拆块：单独造一个必拆的柜体，验证分块位置连续、不重叠、覆盖内空
const bigCab = createCabinet({
  id: 'cab_split',
  name: '超幅背板柜',
  roomId: project.rooms[0].id,
  x: 0,
  y: 0,
  rules,
  params: { width: 2400, height: 2400, depth: 600 },
});
const bigL = computeCabinetLayout(bigCab, rules);
const bigSplit = backPanelSplit(bigCab, bigL, rules);
const bigAs = buildAssembly(bigCab, rules);
/** 图上真实摆出来的背板块（**不是**重新算一遍 —— 那又是"自己跟自己对"） */
const bigBacks = bigAs.parts.filter((p) => p.role === 'BackPanel');

/** 一组 X-Z 矩形两两是否重叠。"同一块料占两遍"必须能被检出 */
function backsOverlap(boxes: Array<{ x0: number; x1: number; z0: number; z1: number }>): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x1 - b.x0 > TOL && b.x1 - a.x0 > TOL && a.z1 - b.z0 > TOL && b.z1 - a.z0 > TOL) return true;
    }
  }
  return false;
}

/** 把同 Z 区间的块归并成"行"（分块是网格：同一行的块共享同一 Z 区间） */
function backRows(list: PartInstance[]): Array<{ z0: number; z1: number }> {
  const m = new Map<string, { z0: number; z1: number }>();
  for (const b of list) m.set(`${b.box.z0}|${b.box.z1}`, { z0: b.box.z0, z1: b.box.z1 });
  return [...m.values()].sort((a, b) => a.z0 - b.z0);
}

ok('B8 超幅背板确实被拆成多块（>1）', bigSplit.split && bigSplit.pieces > 1, `pieces=${bigSplit.pieces}`);
ok('B9 背板块数 === 拆分方案块数', bigBacks.length === bigSplit.pieces, `图上 ${bigBacks.length} / 方案 ${bigSplit.pieces}`);
/**
 * 背板是**嵌槽件**：裁切宽 = 内空 + 2×(槽深 − 余量)，比内空每侧大。
 * 正确的装配位置是**居中于内空开口** —— 每侧伸进槽里 `槽深 − 余量`。
 * 所以断言不写死坐标，而是断言**两侧伸进槽里的长度相等** + 整体跨度 === 展开尺寸。
 * （最初按"从 t 起算"写断言，于是把产品的 7.5mm 偏移固化成了"期望"；
 *   改成对称性判据之后，产品缺陷立刻现形。）
 */
function backCenteredX(list: PartInstance[], cab: Cabinet, L: typeof bigL): boolean {
  const rows = backRows(list);
  const row = list.filter((b) => near(b.box.z0, rows[0].z0)).map((b) => b.box).sort((a, b) => a.x0 - b.x0);
  for (let i = 1; i < row.length; i++) if (!near(row[i].x0, row[i - 1].x1)) return false;
  const span = row[row.length - 1].x1 - row[0].x0;
  const left = row[0].x0 - L.boardT; // 伸进左侧板槽里的长度（负数 = 没进槽）
  const right = cab.params.width - L.boardT - row[row.length - 1].x1;
  return near(left, right) && near(-left, cab.params.backPanel.grooveDepth - cab.params.backPanel.clearance);
}

function backCenteredZ(list: PartInstance[], cab: Cabinet, L: typeof bigL): boolean {
  const rows = backRows(list);
  for (let i = 1; i < rows.length; i++) if (!near(rows[i].z0, rows[i - 1].z1)) return false;
  const zBase = cab.params.bodyLift + L.boardT;
  const zTop = cab.params.height - L.boardT;
  const bottom = rows[0].z0 - zBase;
  const top = zTop - rows[rows.length - 1].z1;
  return near(bottom, top) && near(-bottom, cab.params.backPanel.grooveDepth - cab.params.backPanel.clearance);
}

ok(
  'B10 背板分块在 X 方向首尾相接、整体跨度 === 展开宽，且居中于内空开口',
  (() => {
    const rows = backRows(bigBacks);
    const row = bigBacks.filter((b) => near(b.box.z0, rows[0].z0)).map((b) => b.box).sort((a, b) => a.x0 - b.x0);
    const span = row[row.length - 1].x1 - row[0].x0;
    return backCenteredX(bigBacks, bigCab, bigL) && near(span, bigSplit.w);
  })(),
  `backs x0/x1: ${bigBacks.map((b) => `${Math.round(b.box.x0)}→${Math.round(b.box.x1)}`).join(', ')} / 期望跨度 ${Math.round(bigSplit.w)} 且左右对称`
);
ok(
  'B11 背板按行在 Z 方向首尾相接（行数 === 方案行数）、整体跨度 === 展开高，且居中',
  (() => {
    const rows = backRows(bigBacks);
    const span = rows[rows.length - 1].z1 - rows[0].z0;
    return rows.length === bigSplit.nH && backCenteredZ(bigBacks, bigCab, bigL) && near(span, bigSplit.h);
  })(),
  `行数 ${backRows(bigBacks).length}/${bigSplit.nH}；z 区间 ${backRows(bigBacks).map((r) => `${Math.round(r.z0)}→${Math.round(r.z1)}`).join(', ')} / 期望跨度 ${Math.round(bigSplit.h)}`
);
ok(
  'B12 背板分块总面积 === 整板面积（不丢料）',
  (() => {
    const parts = bigBacks.reduce((n, b) => n + (b.box.x1 - b.box.x0) * (b.box.z1 - b.box.z0), 0);
    return near(parts, bigSplit.w * bigSplit.h, 2 * Math.max(bigSplit.w, bigSplit.h));
  })()
);
ok(
  'B13 背板分块两两不重叠（同一块料不许占两遍；面积守恒挡不住这个）',
  !backsOverlap(bigBacks.map((b) => b.box)),
  bigBacks.map((b) => `${Math.round(b.box.x0)}-${Math.round(b.box.x1)}/${Math.round(b.box.z0)}-${Math.round(b.box.z1)}`).join(', ')
);

// ═══════════════════════════ C. 爆炸位移 ═══════════════════════════

section('【C】爆炸位移：分层、错开、真的分开了');

/**
 * ⚠ C 组必须对着**图上真实画出来的那一件**验收（ex.drawn），
 *   而不是自己再算一遍位移。`PartInstance.box` 是**原位**包围盒，
 *   爆炸位移是在 explode.ts 里施加的 —— 拿 as.parts 去比位移量，
 *   比的是"自己跟自己的差为 0"，offsetBox 写反方向也照样全绿。
 *   （这一组最初就是这么写错的：6 条断言里 2 条假红。）
 */
ok(
  'C1 每一件的位移量 === 该层基准 + lane×步长',
  ex.drawn.every((d) => near(d.dist, EXPLODE_TIER_BASE[Math.min(d.tier, EXPLODE_TIER_BASE.length - 1)] + d.lane * EXPLODE_LANE_STEP, 0.5)),
  ex.drawn
    .filter((d) => !near(d.dist, EXPLODE_TIER_BASE[Math.min(d.tier, EXPLODE_TIER_BASE.length - 1)] + d.lane * EXPLODE_LANE_STEP, 0.5))
    .map((d) => `${d.nameZh} dist=${d.dist} tier=${d.tier} lane=${d.lane}`)
    .join('；')
);
ok(
  'C2 同一板件的多个实例位移量互不相同（不会叠在一条线上）',
  (() => {
    const byPanel = new Map<string, number[]>();
    for (const d of ex.drawn) {
      const arr = byPanel.get(d.panelId) ?? [];
      arr.push(d.dist);
      byPanel.set(d.panelId, arr);
    }
    for (const [id, arr] of byPanel) {
      if (new Set(arr.map((v) => Math.round(v))).size !== arr.length) {
        return false;
      }
      void id;
    }
    return true;
  })(),
  [...new Set(ex.drawn.map((d) => d.panelId))]
    .filter((id) => {
      const arr = ex.drawn.filter((d) => d.panelId === id).map((d) => d.dist);
      return new Set(arr.map((v) => Math.round(v))).size !== arr.length;
    })
    .join('、')
);
ok(
  'C3 位移方向恒为"朝外/朝前/朝后"，且与 EXPLODE_PLAN 的方向一致（符号不为 0）',
  ex.drawn.every((d) => (d.sign === 1 || d.sign === -1) && d.dist > 0)
);
ok(
  'C4 分层单调：同一方向上层号越大位移基准越大',
  (() => {
    for (const axis of ['x', 'y', 'z'] as const) {
      for (const sign of [1, -1] as const) {
        const rows = ex.drawn.filter((d) => d.axis === axis && d.sign === sign);
        if (rows.length < 2) continue;
        const minOfTier = new Map<number, number>();
        for (const r of rows) {
          const base = EXPLODE_TIER_BASE[Math.min(r.tier, EXPLODE_TIER_BASE.length - 1)];
          minOfTier.set(r.tier, Math.min(minOfTier.get(r.tier) ?? Infinity, base));
        }
        const tiers = [...minOfTier.keys()].sort((a, b) => a - b);
        for (let i = 1; i < tiers.length; i++) if (minOfTier.get(tiers[i])! < minOfTier.get(tiers[i - 1])!) return false;
      }
    }
    return true;
  })()
);
ok(
  'C5 爆炸后任意两件的图纸落点中心不重合',
  (() => {
    for (let i = 0; i < ex.drawn.length; i++) {
      for (let j = i + 1; j < ex.drawn.length; j++) {
        if (Math.hypot(ex.drawn[i].center.x - ex.drawn[j].center.x, ex.drawn[i].center.y - ex.drawn[j].center.y) < 1) return false;
      }
    }
    return true;
  })()
);
ok(
  'C6 爆炸位移量是图面表达、不是工艺参数 —— 必须写进假设清单',
  ex.assumptions.some((a) => a.includes('图面表达') && a.includes('工艺'))
);

// ═══════════════════════════ D. 开关语义 ═══════════════════════════

section('【D】开关语义：默认关闭 = 零派生');

const views = buildProjectViews(project, rules);
const off = buildProjectExplode(project, rules, { enabled: false });
const offAgain = buildProjectExplode(project, rules, { enabled: false });
const on = buildProjectExplode(project, rules, { enabled: true, below: views.bbox });
const onAgain = buildProjectExplode(project, rules, { enabled: true, below: views.bbox });

ok('D1 默认（不传 enabled）就是关闭', buildProjectExplode(project, rules).enabled === false);
ok('D2 关闭时 prims 为空', off.prims.length === 0);
ok('D3 关闭时 bbox 为 null', off.bbox === null);
ok('D4 关闭时 perCabinet 为空（= 连装配数据都没算）', off.perCabinet.length === 0 && off.check.cabinets === 0);
ok('D5 关闭时不产生任何假设/警告文案', off.assumptions.length === 0);
ok('D6 打开时 prims 非空', on.prims.length > 0);
ok('D7 打开时 enabled === true 且 bbox 非空', on.enabled === true && on.bbox !== null);
ok('D8 关→关 结果逐字节相同（幂等）', JSON.stringify(off) === JSON.stringify(offAgain));
ok('D9 开→开 结果逐字节相同（确定性）', JSON.stringify(on) === JSON.stringify(onAgain));
ok(
  'D10 打开会如实带出"与清单核对"的结果',
  on.check.ok === true && on.check.instances === on.check.pieces && on.check.drawnNos === on.check.panelKinds
);

// ═══════════════════════════ E. 与四视图不重叠 ═══════════════════════════

section('【E】分解图必须摆在四视图正下方（位置是算出来的）');

ok('E1 给了四视图 bbox 之后，分解图整体在它下方（不相交）', on.bbox !== null && views.bbox !== null && on.bbox.max.y < views.bbox.min.y);
ok(
  'E2 间距 === EXPLODE_SHEET_GAP（不是"大概在下面"）',
  on.perCabinet.length > 0 && near(on.perCabinet[0].origin.y + on.perCabinet[0].h, views.bbox.min.y - on.gap, 1.1),
  on.perCabinet.map((v) => `${Math.round(v.origin.y + v.h)} vs ${Math.round(views.bbox!.min.y - on.gap)}`).join('；')
);
ok(
  'E3 不给 below 时从 y=0 开始（单测/单独看图时不引入神秘偏移）',
  buildProjectExplode(project, rules, { enabled: true }).perCabinet[0].origin.y === 0
);
ok(
  'E4 负样本：gap 设成 -1e6 会与四视图重叠 → E1 不是恒真',
  (() => {
    const bad = buildProjectExplode(project, rules, { enabled: true, below: views.bbox, gap: -1e6 });
    return !(bad.bbox! .max.y < views.bbox!.min.y);
  })()
);

// ═══════════════════════════ F. 图元健康度 / 气泡可读性 ═══════════════════════════

section('【F】图元健康度与件号气泡可读性');

const LAYER_OK = /^(PANEL_\d+|F-CAB|F-CAB-FRONT|F-CAB-HW|F-CAB-HIDDEN|F-DIM|F-TEXT|F-VIEW|F-EXPLODE|F-EXPLODE-BG)$/;
ok(
  'F1 图层全部在白名单内',
  ex.prims.every((p) => LAYER_OK.test(p.layer)),
  [...new Set(ex.prims.map((p) => p.layer))].filter((l) => !LAYER_OK.test(l)).join('、')
);
ok(
  'F2 所有图元坐标都是有限数',
  ex.prims.every((p) => ptsOf(p).every((q) => Number.isFinite(q.x) && Number.isFinite(q.y)))
);
ok('F3 件号气泡数量 === 实例数', ex.bubbles.length === as.check.instances, `${ex.bubbles.length} vs ${as.check.instances}`);
ok(
  'F4 每个气泡里的件号都能在明细栏找到',
  ex.bubbles.every((b) => as.legend.some((r) => r.no === b.no))
);
ok('F5 没有让不开的气泡', ex.unfitted.length === 0, ex.unfitted.join('、'));

/** 气泡两两不重叠（含间隙） */
function bubbleOverlaps(list: ExplodeViewSet['bubbles'], margin: number): string[] {
  const bad: string[] = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      const d = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y);
      if (d < a.r + b.r + margin) bad.push(`${a.no}×${b.no}(${Math.round(d)}<${a.r + b.r + margin})`);
    }
  }
  return bad;
}
const bCrashes = bubbleOverlaps(ex.bubbles, 0);
ok('F6 件号气泡两两不压在一起', bCrashes.length === 0, bCrashes.slice(0, 8).join('；'));
ok(
  'F7 气泡全部落在图幅 bbox 内（不会被画布边缘切掉）',
  ex.bbox !== null &&
    ex.bubbles.every((b) => b.at.x - b.r >= ex.bbox!.min.x && b.at.x + b.r <= ex.bbox!.max.x && b.at.y - b.r >= ex.bbox!.min.y && b.at.y + b.r <= ex.bbox!.max.y),
  ex.bubbles
    .filter((b) => ex.bbox && (b.at.x - b.r < ex.bbox.min.x || b.at.x + b.r > ex.bbox.max.x || b.at.y - b.r < ex.bbox.min.y || b.at.y + b.r > ex.bbox.max.y))
    .map((b) => `${b.no}`)
    .join('、')
);
ok(
  'F8 明细栏把每一行的名称与尺寸都画出来了',
  as.legend.every(
    (r) =>
      ex.prims.some((p) => p.k === 'text' && p.text === r.nameZh) &&
      ex.prims.some((p) => p.k === 'text' && p.text === `${r.cut.length} × ${r.cut.width} × ${r.thickness}`)
  )
);
ok(
  'F9 图上写出了件号与明细的对应关系（标题/副标题里有说明）',
  ex.prims.some((p) => p.k === 'text' && p.text.includes('分解图')) && ex.prims.some((p) => p.k === 'text' && p.text.includes('等轴测'))
);
ok('F10 图幅尺寸是正数且有限', ex.w > 0 && ex.h > 0 && Number.isFinite(ex.w) && Number.isFinite(ex.h));

// ═══════════════════════════ G. 多柜 ═══════════════════════════

section('【G】多柜：并排、不重叠、件数正确合并');

const two: Project = {
  ...project,
  cabinets: [
    ...project.cabinets,
    createCabinet({
      id: 'cab_002',
      name: '次卧衣柜',
      roomId: project.rooms[0].id,
      x: 3200,
      y: 0,
      rules,
      params: { width: 1800, height: 2200, depth: 550 },
    }),
  ],
};
const twoEx = buildProjectExplode(two, rules, { enabled: true, below: views.bbox });
const twoCut = two.cabinets.map((c) => generateCabinet(c, rules));

ok('G1 两个柜体 → 两张分解图', twoEx.check.cabinets === 2 && twoEx.perCabinet.length === 2);
ok(
  'G2 合并件数 === 两柜之和',
  twoEx.check.pieces === twoCut.reduce((n, g) => n + g.panels.reduce((m, p) => m + p.qty, 0), 0),
  `${twoEx.check.pieces} vs ${twoCut.reduce((n, g) => n + g.panels.reduce((m, p) => m + p.qty, 0), 0)}`
);
ok(
  'G3 合并件号种类数 === 两柜之和',
  twoEx.check.panelKinds === twoCut.reduce((n, g) => n + g.panels.length, 0)
);
ok(
  'G4 两柜分解图并列且不重叠',
  twoEx.perCabinet[0].origin.x + twoEx.perCabinet[0].w <= twoEx.perCabinet[1].origin.x
);
ok('G5 两柜的核对都通过', twoEx.check.ok === true);
ok('G6 合并 bbox 覆盖两张图的全部图元', twoEx.perCabinet.every((v) => v.bbox && twoEx.bbox && v.bbox.min.x >= twoEx.bbox.min.x - 1 && v.bbox.max.y <= twoEx.bbox.max.y + 1));
ok(
  'G7 单柜派生失败不能拖垮整张图（坏材质 ID 的柜体被跳过）',
  (() => {
    const broken: Project = {
      ...project,
      cabinets: [{ ...project.cabinets[0], id: 'cab_bad', params: { ...project.cabinets[0].params, boardMaterial: 'M_NOT_EXIST' } }, ...project.cabinets],
    };
    const r = buildProjectExplode(broken, rules, { enabled: true });
    return r.check.cabinets === 1 && r.perCabinet[0].cabinetId === cab.id;
  })()
);

// ═══════════════════════════ H. 确定性 / 平移不变性 ═══════════════════════════

section('【H】确定性与平移不变性');

ok('H1 同输入 → 图元逐字节相同', JSON.stringify(buildCabinetExplode(cab, rules)) === JSON.stringify(buildCabinetExplode(cab, rules)));
ok(
  'H2 换图幅原点 → 所有点整体平移同一向量（没有别的东西跟着变）',
  (() => {
    const a = buildCabinetExplode(cab, rules, { x: 0, y: 0 });
    const b = buildCabinetExplode(cab, rules, { x: 7000, y: -3000 });
    if (a.prims.length !== b.prims.length) return false;
    for (let i = 0; i < a.prims.length; i++) {
      const pa = ptsOf(a.prims[i]);
      const pb = ptsOf(b.prims[i]);
      if (pa.length !== pb.length) return false;
      for (let j = 0; j < pa.length; j++) {
        if (!near(pa[j].x + 7000, pb[j].x) || !near(pa[j].y - 3000, pb[j].y)) return false;
      }
    }
    return true;
  })()
);
ok('H3 平移后自身尺寸不变', near(buildCabinetExplode(cab, rules, { x: 7000 }).w, ex.w) && near(buildCabinetExplode(cab, rules, { y: -3000 }).h, ex.h));
ok(
  'H4 负样本：把某个点挪 5000 → H2 的检查必须变红',
  (() => {
    const a = buildCabinetExplode(cab, rules, { x: 0, y: 0 });
    const b = buildCabinetExplode(cab, rules, { x: 7000, y: -3000 });
    /**
     * 注意不能只对 `k === 'poly'` 打补丁：prims[0] 是一个 `fill`
     * （第一个可见面的填充）。第一次写这条负样本时就是这么漏的 ——
     * 补丁没生效，负样本"安静地通过"，等于没有负样本。
     */
    const shifted: Prim[] = b.prims.map((p, i) =>
      i === 0 && p.k !== 'text' ? { ...p, pts: p.pts.map((q, j) => (j === 0 ? { x: q.x + 5000, y: q.y } : q)) } : p
    );
    const pa = ptsOf(a.prims[0]);
    const pb = ptsOf(shifted[0]);
    return !near(pa[0].x + 7000, pb[0].x);
  })(),
  '负样本没生效 —— 说明 H2 的比对没有真的覆盖到第一个图元的坐标'
);

// ═══════════════════════════ I. 负样本 ═══════════════════════════

section('【I】负样本：每一条"不许发生的事"都必须能被检出');

/** 用一份被篡改的装配数据跑"图上件数与清单是否一致"的检查 */
function countCheck(tamper: (a: Assembly) => Assembly): { instances: number; pieces: number; ok: boolean } {
  const bad = tamper(structuredClone(as));
  return { instances: bad.parts.length, pieces: bad.check.pieces, ok: bad.check.ok && bad.parts.length === bad.check.pieces };
}

ok(
  'I1 负样本：从装配数据里删掉一件 → 件数核对必须变红',
  (() => {
    const t = countCheck((a) => {
      a.parts.pop();
      a.check.instances = a.parts.length;
      return a;
    });
    return t.instances !== t.pieces;
  })()
);
ok(
  'I2 负样本：把两件的裁切尺寸改成不同 → A8 式检查必须变红',
  (() => {
    const bad = structuredClone(as);
    bad.parts[0].cut = { length: bad.parts[0].cut.length + 7, width: bad.parts[0].cut.width };
    return !bad.parts.every((part) => {
      const p = cut.panels.find((x) => x.id === part.panelId)!;
      return part.cut.length === p.length && part.cut.width === p.width;
    });
  })()
);
ok(
  'I3 负样本：把某个气泡挪进另一个气泡里 → F6 必须检出',
  (() => {
    const bad = ex.bubbles.map((b, i) => (i === 1 ? { ...b, at: { ...ex.bubbles[0].at } } : b));
    return bubbleOverlaps(bad, 0).length > 0;
  })()
);
ok(
  'I4 负样本：把某个气泡挪出图幅 → F7 必须检出',
  (() => {
    const bad = ex.bubbles.map((b, i) => (i === 0 ? { ...b, at: { x: ex.bbox!.min.x - 5000, y: b.at.y } } : b));
    return bad.some((b) => b.at.x - b.r < ex.bbox!.min.x);
  })()
);
ok(
  'I5 负样本：把非板厚轴各放大 3mm → B2 的判据必须检出（不能只靠 B1）',
  (() => {
    const p: PartInstance = structuredClone(as.parts[0]);
    const axes = [
      ['x', p.box.x1 - p.box.x0],
      ['y', p.box.y1 - p.box.y0],
      ['z', p.box.z1 - p.box.z0],
    ] as const;
    const thAxis = axes.find(([, v]) => near(v, p.thickness))![0];
    const bad = { ...p.box };
    if (thAxis !== 'x') bad.x1 += 3;
    if (thAxis !== 'y') bad.y1 += 3;
    if (thAxis !== 'z') bad.z1 += 3;
    p.box = bad;
    // 板厚方向没动 → B1 依然通过。所以这一条真正验的是 B2 的判据本身。
    const b1StillOk = spans(p.box).some((v) => near(v, p.thickness));
    return b1StillOk && !restAxesMatchCut(p);
  })(),
  '负样本没生效 —— B2 的判据太松'
);
ok(
  'I6 负样本：位移量全部按 0 算（不爆炸）→ 柜内必然出现板件互相重叠',
  (() => {
    /**
     * `PartInstance.box` 就是**原位**包围盒（爆炸位移由 explode.ts 施加），
     * 所以"不爆炸"的情形直接看 as.parts 即可 —— 不需要再减一次位移。
     * 这一条要成立，C5 才有意义：说明"件分开了"不是恒真的事，
     * 是爆炸位移做出来的。
     */
    const b = as.parts.map((p) => p.box);
    let overlap = 0;
    for (let i = 0; i < b.length; i++) {
      for (let j = i + 1; j < b.length; j++) {
        const a = b[i];
        const c = b[j];
        const hit = a.x0 < c.x1 - 1 && a.x1 > c.x0 + 1 && a.y0 < c.y1 - 1 && a.y1 > c.y0 + 1 && a.z0 < c.z1 - 1 && a.z1 > c.z0 + 1;
        if (hit) overlap++;
      }
    }
    return overlap > 0;
  })(),
  '原位状态下居然没有任何板件重叠 —— C5 失去意义'
);
ok(
  'I7 负样本：件号重复 → A5 必须检出',
  (() => {
    const bad = as.legend.map((r, i) => (i === 1 ? { ...r, no: 1 } : r));
    return !bad.every((r, i) => r.no === i + 1);
  })()
);
ok(
  'I8 负样本：把明细栏行数与清单行数对齐但改掉数量 → A7 必须检出',
  (() => {
    const bad = as.legend.map((r, i) => (i === 0 ? { ...r, qty: r.qty + 1 } : r));
    return !bad.every((row) => {
      const p = cut.panels.find((x) => x.id === row.panelId)!;
      return row.qty === p.qty;
    });
  })()
);
ok(
  'I9 负样本：把两块背板挪到同一位置 → B13 的重叠检查必须检出',
  (() => {
    const bad = bigBacks.map((b) => structuredClone(b));
    if (bad.length < 2) return false;
    bad[1].box = { ...bad[0].box };
    return backsOverlap(bad.map((b) => b.box));
  })(),
  '负样本没生效 —— 说明 B13 的判据形同虚设'
);
ok(
  'I10 负样本：背板整体偏移"槽深−余量"（= 曾经真实发生的那个缺陷）→ B10 的对称判据必须变红',
  (() => {
    const over = bigCab.params.backPanel.grooveDepth - bigCab.params.backPanel.clearance;
    const bad = bigBacks.map((b) => ({ ...b, box: { ...b.box, x0: b.box.x0 + over, x1: b.box.x1 + over } }));
    return !backCenteredX(bad, bigCab, bigL);
  })(),
  '负样本没生效 —— 说明 B10 的对称判据形同虚设（那它就没资格替产品背书）'
);

// ───────────────────────────── 汇总 ─────────────────────────────

console.log('\n' + '='.repeat(64));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exitCode = 1;
} else {
  console.log('\n分解图：与开料清单一一对应成立，开关语义正确，10 个负样本（I1–I10）全部被检出。');
}

export type { Cabinet };
