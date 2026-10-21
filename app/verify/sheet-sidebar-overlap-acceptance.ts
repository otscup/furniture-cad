/**
 * ══════════════════════════════════════════════════════════════════════
 *  图纸侧栏排版验收：文字不得压字（2026-10-20 侧栏重叠事故回归）
 *
 * ── 它守的是什么 ──
 *   侧栏（右侧信息栏）里各段文字必须互不相交。历史事故是 5 处压字：
 *   "门板尺寸"竖排标题压住门板规格行、"寸"压住"下单日期"。
 *
 *   已修的两个根因（都在 furnitureSheet.ts 的 drawSection）：
 *     ① 竖排标题字号固定 150、起点用 ty + 40 - n*vSize*0.6 魔数，
 *        与实际行数无关 —— 行数一多标题就越过分区往下压内容；
 *     ② 分区结束后 ty 只减了内容行高，没扣掉标题最后一字的下半个字格，
 *        紧跟着的 drawRow 就会咬住它（实测交叠 30 单位 = 3mm）。
 *
 * ── 为什么必须多场景 ──
 *   只测"地柜+吊柜各 1 门"是不够的：门板表行数随门数线性增长，
 *   单柜 3 门、6 门、8 门以及地柜+吊柜合页（12/16 门）的压力完全不同。
 *   本次修复的残留缺陷恰恰只在"单柜 3 门"下暴露 —— 那一档必须留在用例里。
 *
 * ── 检测口径 ──
 *   按 (字符数 × 字号 × 0.6) 估宽、字号估高，并**区分 align**：
 *   左对齐的 p.x 是左边界，只有 'c' 才是中心。早期检测器把左对齐也当中心，
 *   凭空右移半个字宽，会把"贴边但没压上"误判成重叠（假红）。
 *
 * ── 变异验证（已做，结论保留在此）──
 *   删掉 furnitureSheet.ts 里 drawSection 末尾那段 titleFloor 收敛
 *   → 本脚本"单柜 3 门"档立刻报 1 处重叠（"寸" × "下单日期"，交叠 90×30），
 *   其余档不受影响。这说明该断言真的绑在修复上，不是恒真。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
import { buildFurnitureSheet } from '../src/export/furnitureSheet.ts';
import type { Cabinet, Prim, Project, RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

/** 与 furnitureSheet.ts 保持一致：底部客户栏上沿 / 侧栏右框。 */
const BOT_H = 1600;
const SIDE_RIGHT = 13900;
const SIDE_LEFT = 11600;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}

const DOORS = (n: number) => ({
  type: 'hinged' as const, count: n, mode: 'equal' as const, style: 'inset' as const,
  gapOuter: 2, gapMid: 3, hinge: 'H', hingeSide: 'left' as const, material: 'M',
});
const unit = (id: string, w: number, doorCount: number) => ({
  id, kind: 'shelves' as const, requestedWidth: w, nickname: '层板',
  shelves: { count: 2, mode: 'equal' as const, gapPerSide: 0.5, ledStrip: 'none' as const },
  ...(doorCount > 0 ? { doors: DOORS(doorCount) } : {}),
});

interface Spec {
  id: string;
  name: string;
  x: number;
  w: number;
  h: number;
  d: number;
  mount: number;
  type: 'base' | 'wall';
  /** 每个分区的门扇数；空数组 = 无门。 */
  doors: number[];
}

function buildSheet(specs: Spec[]): Prim[] {
  const project: Project = emptyProject({ name: '侧栏验收', ruleSetId: rules.id, id: 'p_sidebar' });
  const room = rectRoom({ name: '厨房', x: 0, y: 0, w: 6000, h: 3400, thickness: 120, height: 2700 });
  project.rooms.push(room);
  for (const s of specs) {
    const per = s.doors.length > 0 ? s.doors : [0];
    project.cabinets.push(createCabinet({
      id: s.id, name: s.name, roomId: room.id, x: s.x, y: 60, rotation: 0, rules,
      params: {
        width: s.w, height: s.h, depth: s.d,
        bodyLift: s.type === 'wall' ? 0 : 100,
        cabinetType: s.type, mountHeight: s.mount,
      },
      units: per.map((n, i) => unit(`${s.id}_u${i}`, s.w / per.length, n)),
    }) as Cabinet);
  }
  return buildFurnitureSheet(room, project.cabinets, project, rules, { furnitureName: '厨房橱柜' }).prims;
}

interface Box {
  label: string;
  x0: number; x1: number; y0: number; y1: number; rotated: boolean;
}

/** 按字号保守估算文字外接矩形；左对齐的 p.x 是左边界，'c' 才是中心。 */
function textBoxes(prims: Prim[]): Box[] {
  return prims
    .filter((p) => p.k === 'text')
    .map((p) => {
      const t = p as { text?: string; p: { x: number; y: number }; size?: number; align?: 'l' | 'c' | 'r'; rot?: number };
      const size = t.size ?? 100;
      const w = Math.max(1, String(t.text ?? '').length) * size * 0.6;
      const h = size;
      const align = t.align ?? 'l';
      const x0 = align === 'c' ? t.p.x - w / 2 : align === 'r' ? t.p.x - w : t.p.x;
      return { label: String(t.text ?? ''), x0, x1: x0 + w, y0: t.p.y - h / 2, y1: t.p.y + h / 2, rotated: Boolean(t.rot) };
    });
}

function findOverlaps(boxes: Box[]): string[] {
  const hits: string[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      // 旋转文字与非旋转文字不互判：它们占的是不同轴向，外接矩形不能这么估
      if (a.rotated !== b.rotated) continue;
      const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const yOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      // 容差 1 单位，避免浮点边界误判
      if (xOverlap > 1 && yOverlap > 1) {
        hits.push(`${JSON.stringify(a.label)} × ${JSON.stringify(b.label)}（交叠 ${Math.round(xOverlap)}×${Math.round(yOverlap)}）`);
      }
    }
  }
  return hits;
}

// ═══════════════ 1. 多种门数的压字回归 ═══════════════
console.log('\n1. 侧栏文字压字（多门数压力）');

const CASES: Array<{ label: string; specs: Spec[]; expectScheduleRows: number }> = [
  {
    label: '单柜 3 门（历史缺陷档：曾残留 "寸" × "下单日期"）',
    specs: [{ id: 'c1', name: '主卧衣柜', x: 100, w: 2400, h: 2400, d: 600, mount: 0, type: 'base', doors: [3] }],
    expectScheduleRows: 3,
  },
  {
    label: '单柜 6 门（门板表最密的单柜档）',
    specs: [{ id: 'c1', name: '主卧衣柜', x: 100, w: 2400, h: 2400, d: 600, mount: 0, type: 'base', doors: [6] }],
    expectScheduleRows: 6,
  },
  {
    label: '单柜 8 门',
    specs: [{ id: 'c1', name: '宽衣柜', x: 100, w: 3000, h: 2400, d: 600, mount: 0, type: 'base', doors: [8] }],
    expectScheduleRows: 8,
  },
  {
    label: '无门柜（走后置的移门/掩门/线条三个分区）',
    specs: [{ id: 'c1', name: '开放书架', x: 100, w: 2400, h: 2400, d: 600, mount: 0, type: 'base', doors: [] }],
    expectScheduleRows: 0,
  },
  {
    label: '地柜 + 吊柜合页，共 8 门（roomBook 分组后侧栏会同时列两柜的门）',
    specs: [
      { id: 'b0', name: '地柜', x: 100, w: 2400, h: 800, d: 600, mount: 0, type: 'base', doors: [2, 2] },
      { id: 'w0', name: '吊柜', x: 100, w: 2400, h: 700, d: 350, mount: 1500, type: 'wall', doors: [2, 2] },
    ],
    expectScheduleRows: 8,
  },
  {
    label: '地柜 + 吊柜合页，共 12 门',
    specs: [
      { id: 'b0', name: '地柜', x: 100, w: 2400, h: 800, d: 600, mount: 0, type: 'base', doors: [3, 3] },
      { id: 'w0', name: '吊柜', x: 100, w: 2400, h: 700, d: 350, mount: 1500, type: 'wall', doors: [3, 3] },
    ],
    expectScheduleRows: 12,
  },
  {
    label: '地柜 + 吊柜合页，共 16 门（极限压力：必然触发行数收敛）',
    specs: [
      { id: 'b0', name: '地柜', x: 100, w: 3000, h: 900, d: 600, mount: 0, type: 'base', doors: [4, 4] },
      { id: 'w0', name: '吊柜', x: 100, w: 3000, h: 800, d: 350, mount: 1600, type: 'wall', doors: [4, 4] },
    ],
    expectScheduleRows: 16,
  },
];

for (const testCase of CASES) {
  const prims = buildSheet(testCase.specs);
  const boxes = textBoxes(prims);
  const overlaps = findOverlaps(boxes);
  ok(`${testCase.label}：文字重叠对数 === 0`, overlaps.length === 0,
    `重叠 ${overlaps.length} 处：\n      ${overlaps.slice(0, 8).join('\n      ')}`);

  // 侧栏文字不得侵入底部客户信息栏
  const intoFooter = boxes.filter((b) => b.x0 >= SIDE_LEFT - 40 && b.y0 < BOT_H);
  ok(`${testCase.label}：侧栏文字不侵入底部客户栏（y >= ${BOT_H}）`, intoFooter.length === 0,
    intoFooter.slice(0, 6).map((b) => `${JSON.stringify(b.label)} 底边 ${Math.round(b.y0)}`).join(', '));

  // 侧栏文字不得越过右侧内框线
  const pastRight = boxes.filter((b) => b.x1 > SIDE_RIGHT);
  ok(`${testCase.label}：侧栏文字不越过右内框（x <= ${SIDE_RIGHT}）`, pastRight.length === 0,
    pastRight.slice(0, 6).map((b) => `${JSON.stringify(b.label)} 右边 ${Math.round(b.x1)}`).join(', '));

  // 门板表行数：修复不能靠"静默丢行"换绿
  const scheduleRows = prims.filter((p) => p.k === 'text' && /·门\d+\s+\d+×\d+mm$/.test(String((p as { text?: string }).text ?? '')));
  const truncated = prims.some((p) => p.k === 'text' && /共 \d+ 扇，此处列前 \d+ 扇/.test(String((p as { text?: string }).text ?? '')));
  ok(
    `${testCase.label}：门板表行数如实（${scheduleRows.length}/${testCase.expectScheduleRows} 行，截断则有注记）`,
    scheduleRows.length + (truncated ? 1 : 0) >= testCase.expectScheduleRows &&
      (truncated || scheduleRows.length === testCase.expectScheduleRows),
    `列出行数 ${scheduleRows.length}，期望 ${testCase.expectScheduleRows}，截断注记=${truncated}`,
  );
}

// ═══════════════ 2. 竖排分区标题保留 ═══════════════
console.log('\n2. 参考图纸视觉口径：竖排分区标题仍在');
{
  const prims = buildSheet(CASES[0]!.specs);
  const texts = prims.filter((p) => p.k === 'text') as Array<{ text?: string; p: { x: number; y: number }; size?: number; align?: string }>;
  /** 侧栏竖排标题：单字、居中、字号 >= 90、x 在标题列（约 11850）。 */
  const vertical = texts.filter((t) => {
    const size = t.size ?? 100;
    return size >= 90 && String(t.text ?? '').length === 1 && t.align === 'c' && Math.abs(t.p.x - 11850) < 80;
  });
  const spelled = vertical.map((t) => String(t.text)).join('');
  ok('门板尺寸分区的竖排标题 "门板尺寸" 四字齐全', spelled.includes('门板尺寸'), `实际竖排字：${JSON.stringify(spelled)}`);

  const noDoor = textBoxes(buildSheet(CASES[3]!.specs));
  const noDoorTexts = noDoor.map((b) => b.label).join('|');
  void noDoorTexts;
  const primsNoDoor = buildSheet(CASES[3]!.specs);
  const vertNoDoor = (primsNoDoor.filter((p) => p.k === 'text') as Array<{ text?: string; p: { x: number; y: number }; size?: number; align?: string }>)
    .filter((t) => (t.size ?? 100) >= 90 && String(t.text ?? '').length === 1 && t.align === 'c' && Math.abs(t.p.x - 11850) < 80)
    .map((t) => String(t.text))
    .join('');
  ok('无门柜的移门/掩门/线条三个分区竖排标题齐全', vertNoDoor.includes('移门') && vertNoDoor.includes('掩门') && vertNoDoor.includes('线条'), `实际竖排字：${JSON.stringify(vertNoDoor)}`);
}

// ═══════════════ 汇总 ═══════════════
console.log('\n' + '═'.repeat(60));
console.log(`  图纸侧栏排版验收：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：7 档门数压力下侧栏无压字、不越框、不侵入客户栏，竖排标题保留。');
