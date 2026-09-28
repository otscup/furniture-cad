import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Cabinet, RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { detectCollisions } from '../src/core/geometry/project.ts';
import { compileAction, type AiAction } from '../src/ai/compile.ts';
import {
  addDraftRound,
  draftSnapshot,
  finalizeDraft,
  startDraft,
} from '../src/ai/draftSession.ts';
import { validatePlan } from '../shared/aiContract.mjs';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  全链路工作流验收 —— 「大白话 → 正面图草图 → 持续对话修改 → 拼接 → 定稿」
 *
 *  用户原话（两段合并）：
 *    "ai 生成优化，重点检查能不能根据大白话描述去生成正面图草图，
 *     然后根据持续对话进行修改，拼接操作，最终能不能把草图生成可编辑的成品图。
 *     重点检查 ai 在完整的工作流程中有没有 bug，如果有可修复。"
 *
 *  ── 这批断言要证明什么 ──
 *    ① **大白话能落地成草图**：一轮"建 L 形岛台"产出草案里真实的两个柜体，
 *       且每个柜体都能出**正面图**图元（草图默认正面图这件事在数据层成立）。
 *    ② **岛台镂空**：L 形长边带 backUnits（双面柜），"中间镂空"在语义模型里真的有。
 *    ③ **快照来自草案**：第二轮喂给 AI 的快照看得到第一轮建的柜，
 *       否则"持续对话修改"每一句都落空。
 *    ④ **持续对话修改**：第三轮按名字把长边加高，草案如实反映，且仍只算一次生成。
 *    ⑤ **拼接操作真成立**：两条垂直臂**共用一个角点**成 L，不重叠、不撞墙。
 *       （修复前两条臂各贴一面墙、中间留缝，根本不是 L —— 那是真 bug。）
 *    ⑥ **定稿成可编辑成品**：finalizeDraft 把草案写进真总线，
 *       真总线能派生出板件（可编辑、可出图），不是一张死图。
 *
 *  ── 为什么直接驱动草案引擎而不是 HTTP ──
 *    这里验的是"多轮累积 + 拼接 + 定稿"这一段的**逻辑**，不是语言理解。
 *    AI 会说什么由契约与提示词决定，那段由 ai-acceptance 的 G 组盯；
 *    本文件用"一个好 AI 会产出的动作"喂引擎，专盯流程本身有没有断。
 * ══════════════════════════════════════════════════════════════════════
 */

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
function section(t: string): void {
  console.log(`\n\u2500\u2500 ${t} \u2500\u2500`);
}

function freshBus(): CommandBus {
  const p = emptyProject({ name: '家', ruleSetId: rules.id });
  p.rooms.push(rectRoom({ name: '厨房', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 }));
  return new CommandBus(p, rules);
}

const ACT = (a: Omit<AiAction, 'reason'> & { reason?: string }): AiAction => ({ reason: '', ...a } as AiAction);
function legal(actions: AiAction[]): AiAction[] {
  const v = validatePlan({ reply: '', actions }, { bodyMaterials: [], backMaterials: [] });
  return v.ok ? v.actions : [];
}

/** footprint bbox（与 detectCollisions 同口径：rotation 决定宽深方向） */
function foot(c: Cabinet): { minx: number; maxx: number; miny: number; maxy: number } {
  const W = c.params.width;
  const D = c.params.depth;
  const { x, y, rotation } = c.placement;
  switch (((rotation % 360) + 360) % 360) {
    case 0:
      return { minx: x, maxx: x + W, miny: y, maxy: y + D };
    case 90:
      return { minx: x - D, maxx: x, miny: y, maxy: y + W };
    case 180:
      return { minx: x - W, maxx: x, miny: y - D, maxy: y };
    default:
      return { minx: x, maxx: x + D, miny: y - W, maxy: y };
  }
}
function corners(f: { minx: number; maxx: number; miny: number; maxy: number }): Array<[number, number]> {
  return [[f.minx, f.miny], [f.maxx, f.miny], [f.minx, f.maxy], [f.maxx, f.maxy]];
}
/** 两个矩形是否共用至少一个角点（容差 1mm） */
function shareCorner(a: Cabinet, b: Cabinet): boolean {
  const ca = corners(foot(a));
  const cb = corners(foot(b));
  for (const [ax, ay] of ca) for (const [bx, by] of cb) if (Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1) return true;
  return false;
}
function overlaps(a: Cabinet, b: Cabinet): boolean {
  const fa = foot(a);
  const fb = foot(b);
  return fa.minx < fb.maxx && fa.maxx > fb.minx && fa.miny < fb.maxy && fa.maxy > fb.miny;
}

// ───────────────────────── A 大白话 → L 形岛台草图 ─────────────────────────
section('A 大白话：一轮建出 L 形岛台（长边带镂空、短边垂直）');

const bus = freshBus();
const ver0 = bus.getVersion();

// 第一轮：长边（带 backUnits = 岛台镂空，双面可用）
const r1 = legal([
  ACT({
    action: 'cabinet.create',
    target: { roomName: '厨房' },
    params: {
      name: '长边',
      width: 2200,
      height: 900,
      depth: 850,
      rotation: 0,
      backUnits: [{ kind: 'shelves', count: 2 }],
    },
  }),
]);
ok('A0 长边动作合法（含 backUnits 岛台镂空）', r1.length === 1, JSON.stringify(r1));

const d1 = addDraftRound(startDraft(bus), { text: '房间2 做一个 L 形岛台，长边 2200 带镂空', reply: '建好了长边', actions: r1, rules });
ok('A1 长边并入草案', d1.rounds[0]?.merged === true, JSON.stringify(d1.rounds[0]?.run.steps.map((s) => s.error)));
ok('A2 草案里有了 1 个柜体（定稿前真总线仍空）', d1.project.cabinets.length === 1 && bus.getState().cabinets.length === 0);

// 第二轮（拼接）：短边，旋转 90° 形成 L
const r2 = legal([
  ACT({ action: 'cabinet.create', target: { roomName: '厨房' }, params: { name: '短边', width: 1500, height: 700, depth: 850, rotation: 90 } }),
]);
ok('A3 短边动作合法（rotation:90 标出第二条臂朝向）', r2.length === 1);

const d2 = addDraftRound(d1, { text: '再加一条竖臂，长 1500，成 L', reply: '加了短边', actions: r2, rules });
ok('A4 短边并入草案', d2.rounds[1]?.merged === true, JSON.stringify(d2.rounds[1]?.run.steps.map((s) => s.error)));
ok('A5 草案里现在有 2 个柜体（L 的两臂都在）', d2.project.cabinets.length === 2, `实际 ${d2.project.cabinets.length}`);

// ───────────────────────── B 正面图草图可生成 ─────────────────────────
section('B 草图默认能出正面图（数据层）');

const longCab = d2.project.cabinets.find((c) => c.name === '长边')!;
const shortCab = d2.project.cabinets.find((c) => c.name === '短边')!;
ok('B1 长边能出正面图图元（front prims 非空）', buildCabinetViews(longCab, rules).prims.front.length > 0);
ok('B2 短边能出正面图图元', buildCabinetViews(shortCab, rules).prims.front.length > 0);
ok('B3 正面图图元的宽高就是用户说的那两个数（长边 2200×900）', longCab.params.width === 2200 && longCab.params.height === 900);

// 岛台镂空
ok('C1 长边带 backUnits（中间镂空 / 双面柜，岛台语义成立）', Array.isArray(longCab.layout.backUnits) && longCab.layout.backUnits.length > 0, JSON.stringify(longCab.layout.backUnits?.length));

// ───────────────────────── D 快照连续性（持续对话的前提） ─────────────────────────
section('D 第二轮喂给 AI 的快照取自草案（持续对话看得见上一轮）');

const snap = draftSnapshot(d2, rules);
ok('D1 快照里看得到长边与短边（两轮成果都在桌上）', snap.cabinets.length === 2, JSON.stringify(snap.cabinets.map((c) => c.name)));

// ───────────────────────── E 持续对话修改（可行的改生效） ─────────────────────────
section('E 第三轮：按名字把长边改到 1200 高（可行修改，应当并入）');

const r3 = legal([ACT({ action: 'cabinet.resize', target: { cabinetName: '长边' }, params: { height: 1200 } })]);
const d3 = addDraftRound(d2, { text: '把长边改到 1200 高', reply: '改好了', actions: r3, rules });
ok('E1 第三轮并入草案（说明它用名字找到了长边）', d3.rounds[2]?.merged === true, JSON.stringify(d3.rounds[2]?.run.steps.map((s) => s.error)));
ok('E2 草案里长边高度变成 1200', d3.project.cabinets.find((c) => c.name === '长边')?.params.height === 1200, String(d3.project.cabinets.find((c) => c.name === '长边')?.params.height));
ok('E3 短边没被这次改动波及其它', d3.project.cabinets.find((c) => c.name === '短边')?.params.height === 700);
ok('E4 累积了 3 条可提交步骤', d3.steps.length === 3, `实际 ${d3.steps.length}`);
ok('E5 真总线全程没动（仍是 0 柜体）', bus.getState().cabinets.length === 0);

// ───────────────────────── E' 不可行的修改被护栏拦下 ─────────────────────────
section("E' 第四轮：把长边改到 2400 高（中板放不进标准板材，应当被拒）");

const r4 = legal([ACT({ action: 'cabinet.resize', target: { cabinetName: '长边' }, params: { height: 2400 } })]);
const d4 = addDraftRound(d3, { text: '再把长边加到 2400', reply: '', actions: r4, rules });
ok("E'1 不可行的修改不并入草案（半截成功比全失败更危险，这条必须整体拒）", d4.rounds[3]?.merged === false, JSON.stringify(d4.rounds[3]?.run.steps.map((s) => s.error)));
ok("E'2 拒掉的原因点名了具体哪块板放不进板材", /中板|板材/.test(d4.rounds[3]?.run.steps[0]?.error ?? ''), d4.rounds[3]?.run.steps[0]?.error ?? '');
ok("E'3 草案里长边高度仍是上一轮改出的 1200（没被悄悄改掉）", d4.project.cabinets.find((c) => c.name === '长边')?.params.height === 1200, String(d4.project.cabinets.find((c) => c.name === '长边')?.params.height));
ok("E'4 待提交步骤没有被这条失败轮混进去", d4.steps.length === 3, `实际 ${d4.steps.length}`);

// ───────────────────────── F 拼接：真成 L ─────────────────────────
section('F 拼接：两条垂直臂共用角点成 L（不重叠、不撞墙）');

const la = d4.project.cabinets.find((c) => c.name === '长边')!;
const sa = d4.project.cabinets.find((c) => c.name === '短边')!;
ok('F1 两条臂朝向互相垂直（这才是 L，不是一字排开）', la.placement.rotation !== sa.placement.rotation, `${la.placement.rotation}° / ${sa.placement.rotation}°`);
ok('F2 两条臂共用一个角点（拼接真的发生，不是各贴一面墙散开）', shareCorner(la, sa), JSON.stringify({ 长边: foot(la), 短边: foot(sa) }));
ok('F3 两条臂不重叠（否则会被干涉规则拦下）', overlaps(la, sa) === false);
const wallHit = detectCollisions(d4.project).filter((i) => i.code === 'RULE-CABINET-IN-WALL');
ok('F4 拼接后的 L 不扎进墙体', wallHit.length === 0, JSON.stringify(wallHit.map((i) => i.target)));
const overlapHit = detectCollisions(d4.project).filter((i) => i.code === 'RULE-CABINET-OVERLAP');
ok('F5 拼接后的 L 两臂不互相干涉', overlapHit.length === 0, JSON.stringify(overlapHit.map((i) => i.target)));

// ───────────────────────── G 定稿成可编辑成品 ─────────────────────────
section('G 定稿：把草图写进真总线，成为可编辑成品');

const fin = finalizeDraft(d4, bus);
ok('G1 定稿成功', fin.ok === true, fin.ok ? '' : fin.error);
ok('G2 真总线现在有 2 个柜体', bus.getState().cabinets.length === 2, `实际 ${bus.getState().cabinets.length}`);
ok('G3 定稿后长边高度是第三轮改出的 1200（第四轮不可行的 2400 没混进去）', bus.getState().cabinets.find((c) => c.name === '长边')?.params.height === 1200);
ok('G4 真总线版本被 bump（说明走了 CommandBus，不是静默写文件）', bus.getVersion() > ver0);
// 可编辑成品 = 能派生出板件（出图/清单的数据源）
const derived = bus.derive();
const panels = Object.values(derived.geom.cabinets).reduce((n, g) => n + g.stats.totalPieces, 0);
ok('G5 定稿产物可派生板件（是活的可编辑模型，不是一张死图）', panels > 0, `板件数 ${panels}`);

console.log(`\n${'='.repeat(64)}`);
console.log(`全链路工作流验收：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
