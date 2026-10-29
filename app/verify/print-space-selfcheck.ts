/**
 * 打印空间自检：线宽/字号落到 A3 纸面后够不够、压字能不能挪开、
 * 挪不动时是否老实保留并记录。
 *
 * 数字全部从 primsToSvg 真实输出的 SVG 反算（viewBox + stroke-width/font-size），
 * 不复制实现里的公式 —— 公式改错了这里必须红。
 */
import { readFileSync } from 'node:fs';
import type { Prim } from '../src/core/types.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { lintPrims } from '../src/core/geometry/drawingLint.ts';
import {
  LAYOUT_SLOT_MM,
  PAPER_MIN_MM,
  SHEET_SLOT_MM,
  avoidTextOverContent,
  buildRoomBook,
  primsToSvg,
  type PaperSize,
} from '../src/export/roomBook.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log('OK  ' + name); } else { fail++; console.log('FAIL ' + name + ' :: ' + (detail ?? '')); }
};

const OVER_CONTENT = 'DRAW_TEXT_OVER_CONTENT';
const overContent = (prims: Prim[]) =>
  lintPrims(prims, { view: 'T', target: 'c1' }).filter((issue) => issue.code === OVER_CONTENT);

const numAttr = (tag: string, name: string): number =>
  Number(new RegExp(name + '="(-?[0-9.]+)"').exec(tag)?.[1]);

interface Audit { scale: number; bad: string[]; minLine: number; maxLine: number; minText: number }

/** 只看 SVG 就能核：任意一根线/一个字 × 缩放 = 纸面 mm。 */
const auditSvg = (svg: string, paper: PaperSize): Audit => {
  const vb = /viewBox="([0-9.-]+) ([0-9.-]+) ([0-9.]+) ([0-9.]+)"/.exec(svg);
  const vbW = Number(vb?.[3]);
  const vbH = Number(vb?.[4]);
  const scale = Math.min(paper.w / vbW, paper.h / vbH);
  let minLine = Infinity, maxLine = 0, minText = Infinity;
  const bad: string[] = [];
  for (const match of svg.matchAll(/<(polygon|polyline|text)\b[^>]*>/g)) {
    const tag = match[0];
    if (match[1] === 'text') {
      const mm = numAttr(tag, 'font-size') * scale;
      minText = Math.min(minText, mm);
      if (mm < PAPER_MIN_MM.text - 1e-3) bad.push('字号 ' + mm.toFixed(3) + 'mm');
    } else if (tag.includes('stroke-width=')) {
      const mm = numAttr(tag, 'stroke-width') * scale;
      minLine = Math.min(minLine, mm);
      maxLine = Math.max(maxLine, mm);
      if (mm < PAPER_MIN_MM.aux - 1e-3) bad.push('线宽 ' + mm.toFixed(3) + 'mm');
    }
  }
  return { scale, bad, minLine, maxLine, minText };
};

// ① 合成大图：14000×10000 的图幅缩到 A3（scale≈0.03），旧公式的线宽只剩 0.03~0.11mm
const big: Prim[] = [
  { k: 'poly', pts: [{ x: 0, y: 0 }, { x: 14000, y: 0 }, { x: 14000, y: 10000 }, { x: 0, y: 10000 }], closed: true, layer: 'F-CAB', lw: 2.4 },
  { k: 'poly', pts: [{ x: 0, y: 5000 }, { x: 14000, y: 5000 }], closed: false, layer: 'F-CAB-HW', lw: 0.56 },
  { k: 'text', p: { x: 7000, y: 2000 }, text: '层板 ×1', size: 105, layer: 'F-TEXT', align: 'c' },
  { k: 'text', p: { x: 7000, y: 3000 }, text: '内部结构', size: 200, layer: 'F-TEXT', align: 'c' },
];
const bigSvg = primsToSvg(big, 'chk', SHEET_SLOT_MM);
const bigAudit = auditSvg(bigSvg, SHEET_SLOT_MM);
ok('大图缩到 A3 后没有低于打印下限的线/字', bigAudit.bad.length === 0, bigAudit.bad.join(' / '));
ok('主线（lw 2.4）抬到 ≥0.25mm', bigAudit.maxLine >= PAPER_MIN_MM.main - 1e-3, bigAudit.maxLine.toFixed(3) + 'mm');
// 证明这条断言不是白给：旧公式在这一档只有 0.896*scale ≈ 0.027mm
ok('旧公式在同样缩放下确实不合格（断言非空转）', 0.56 * 1.6 * bigAudit.scale < PAPER_MIN_MM.aux, (0.56 * 1.6 * bigAudit.scale).toFixed(4) + 'mm');
ok('字号抬高后仍在纸面 ≥2.2mm', bigAudit.minText >= PAPER_MIN_MM.text - 1e-3, bigAudit.minText.toFixed(3) + 'mm');
ok('不传 paper 时保持老行为（界面预览/脚本兼容）', primsToSvg(big, 'chk').includes('stroke-width="' + 2.4 * 1.6 + '"'));
console.log('   缩放 ' + bigAudit.scale.toFixed(5) + '；线宽 ' + bigAudit.minLine.toFixed(3) + '~' + bigAudit.maxLine.toFixed(3) + 'mm；最小字号 ' + bigAudit.minText.toFixed(2) + 'mm');

// ② 真实样例工程：柜体页（420×297 满页）和平面页（404×226 槽位）逐根线逐个字核
const rules = JSON.parse(readFileSync('src/core/ruleset/factory-default.json', 'utf8'));
const project = sampleProject(rules);
const book = buildRoomBook(project, rules, 'print-space-selfcheck');
const cabinet = book.sections[0]?.cabinets[0];
ok('样例工程产出了柜体页', Boolean(cabinet?.sheetSvg), String(book.sections.length));
if (cabinet) {
  const sheet = auditSvg(cabinet.sheetSvg, SHEET_SLOT_MM);
  ok('柜体页缩到 A3 后线宽/字号全部达标', sheet.bad.length === 0, sheet.bad.join(' / '));
  ok('柜体页最粗的线 ≥0.25mm', sheet.maxLine >= PAPER_MIN_MM.main - 1e-3, sheet.maxLine.toFixed(3) + 'mm');
  console.log('   柜体页缩放 ' + sheet.scale.toFixed(5) + '；线宽 ' + sheet.minLine.toFixed(3) + '~' + sheet.maxLine.toFixed(3) + 'mm；最小字号 ' + sheet.minText.toFixed(2) + 'mm');
}
const layout = book.sections[0]?.layoutSvg;
if (layout) {
  const plan = auditSvg(layout, LAYOUT_SLOT_MM);
  ok('平面页缩到 404×226 槽位后线宽/字号全部达标', plan.bad.length === 0, plan.bad.join(' / '));
  console.log('   平面页缩放 ' + plan.scale.toFixed(5) + '；线宽 ' + plan.minLine.toFixed(3) + '~' + plan.maxLine.toFixed(3) + 'mm；最小字号 ' + plan.minText.toFixed(2) + 'mm');
}

// ③ 真实样例柜：内部视图的压字已在 views.ts 根治（避让器一开始就知道衣物在哪），导出侧不该再有活干
const source = project.cabinets[0]!;
const views = buildCabinetViews(source, rules, { x: 0, y: 0, gapTop: 0, gapSide: 0, gapInt: 0 });
const internal = views.prims.internal!;
ok('样例柜内部视图没有压字（曾 5 处，根治在避让器里）', overContent(internal).length === 0, overContent(internal).map((i) => i.message).join(' / '));
const idle = avoidTextOverContent(internal, { view: source.name + '·internal', target: source.id });
ok('没有压字时导出侧一动不动', idle.moved.length === 0 && idle.kept.length === 0, JSON.stringify([idle.moved, idle.kept]));

// ③b 导出侧仍必须真会挪：合成一张"线穿字"的图，挪开后必须干净
const movable: Prim[] = [
  { k: 'poly', pts: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1400 }, { x: 0, y: 1400 }], closed: true, layer: 'F-CAB', lw: 2.4 },
  { k: 'poly', pts: [{ x: 0, y: 700 }, { x: 1000, y: 700 }], closed: false, layer: 'F-CAB-HW', lw: 1 },
  { k: 'text', p: { x: 500, y: 700 }, text: '层板 ×1', size: 100, layer: 'F-TEXT', align: 'c' },
];
ok('合成图确实压线（挪字用例不是空转）', overContent(movable).length === 1, String(overContent(movable).length));
const relocation = avoidTextOverContent(movable, { view: 'T', target: 'c1' });
ok('压字被挪开且记进 moved', relocation.moved.length === 1 && relocation.kept.length === 0, JSON.stringify([relocation.moved, relocation.kept]));
ok('挪完之后不压线', overContent(relocation.prims).length === 0, overContent(relocation.prims).map((i) => i.message).join(' / '));
ok('挪字不是删字（文字条数不变）',
  relocation.prims.filter((p) => p.k === 'text').length === 1,
  String(relocation.prims.filter((p) => p.k === 'text').length));

// ④ 挪不动：整幅铺满五金示意线时，文字必须留在原位并被记进 kept（不许静默删掉）
const dense: Prim[] = [
  { k: 'poly', pts: [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 1400 }, { x: 0, y: 1400 }], closed: true, layer: 'F-CAB', lw: 2.4 },
];
for (let y = -200; y <= 1600; y += 12) {
  dense.push({ k: 'poly', pts: [{ x: -200, y }, { x: 1200, y }], closed: false, layer: 'F-CAB-HW', lw: 1 });
}
const stuckText: Prim = { k: 'text', p: { x: 300, y: 400 }, text: '挂衣杆 · 距内底 2134', size: 100, layer: 'F-TEXT', align: 'l' };
dense.push(stuckText);
const stuck = avoidTextOverContent(dense, { view: 'T', target: 'c1' });
ok('四周被线条占满时挪不动', stuck.moved.length === 0, 'moved=' + stuck.moved.length);
ok('挪不动时保留但记录', stuck.kept.length === 1 && stuck.kept[0] === '挂衣杆 · 距内底 2134', JSON.stringify(stuck.kept));
const stuckPrim = stuck.prims[stuck.prims.length - 1];
ok('保留的记录在原位（没被偷偷搬走或删掉）', stuckPrim?.k === 'text' && stuckPrim.p.x === 300 && stuckPrim.p.y === 400, JSON.stringify(stuckPrim));
ok('保留的压字仍然被 lint 报出来（没被吞掉）', overContent(stuck.prims).length === 1, String(overContent(stuck.prims).length));

// ⑤ 导出结果里的记录格式：INFO=挪开，WARNING=留着，码值固定
ok('导出结果带 notices 数组', Array.isArray(book.notices), String(book.notices?.length));
ok('notices 只用约定的两个码和两种级别', book.notices.every((n) =>
  (n.code === 'DRAW_TEXT_AUTO_MOVED' && n.severity === 'INFO') || (n.code === 'DRAW_TEXT_MOVE_BLOCKED' && n.severity === 'WARNING')),
  book.notices.map((n) => n.code).join(','));
ok('roombook 的页面件全部是 A3 横向（槽位尺寸与 CSS 对齐）',
  LAYOUT_SLOT_MM.w === 404 && LAYOUT_SLOT_MM.h === 226 && SHEET_SLOT_MM.w === 420 && SHEET_SLOT_MM.h === 297,
  JSON.stringify([LAYOUT_SLOT_MM, SHEET_SLOT_MM]));

console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exit(1);
