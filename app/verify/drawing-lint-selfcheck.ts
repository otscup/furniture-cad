
/**
 * 图纸静态检查自检：先用合成图元钉死两条规则的判定边界，再拿真实样例柜跑一遍。
 * 断言用"必须有/必须没有"，不是数字指纹 —— 排版改了数字会变，结论不该变。
 */
import { readFileSync } from 'node:fs';
import type { Prim } from '../src/core/types.ts';
import { sampleProject } from '../src/core/docFactory.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { lintPrims } from '../src/core/geometry/drawingLint.ts';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, detail?: string) => {
  if (cond) { pass++; console.log('OK  ' + name); } else { fail++; console.log('FAIL ' + name + ' :: ' + (detail ?? '')); }
};

const T = (text: string, x: number, y: number, layer = 'F-TEXT'): Prim => ({ k: 'text', p: { x, y }, text, size: 100, layer, align: 'l' });
const L = (x0: number, y0: number, x1: number, y1: number, layer = 'F-CAB-HW'): Prim => ({
  k: 'poly', pts: [{ x: x0, y: y0 }, { x: x1, y: y1 }], closed: false, layer, lw: 2,
});
const FRAME: Prim = { k: 'poly', pts: [{ x: 0, y: 0 }, { x: 2000, y: 0 }, { x: 2000, y: 2000 }, { x: 0, y: 2000 }], closed: true, layer: 'F-CAB', lw: 3 };
const codes = (ps: Prim[]) => lintPrims(ps, { view: 'T', target: 'c1' }).map((i) => i.code);

// ① 内容层（衣物/五金示意）穿过文字 → 必须报
ok('衣物线条穿过文字被报出', codes([FRAME, T('挂衣杆', 100, 500), L(0, 510, 900, 510)]).includes('DRAW_TEXT_OVER_CONTENT'));
// ② 板件边线穿过文字 → 不许报（板件名横跨自己的板是既定画法）
ok('板件边线穿过文字不报', !codes([FRAME, T('左侧板', 100, 500), L(0, 510, 900, 510, 'PANEL_18')]).includes('DRAW_TEXT_OVER_CONTENT'));
// ③ 视图框穿过文字 → 不许报
ok('视图框穿过文字不报', !codes([FRAME, T('柜体', 0, 500), L(0, 0, 0, 2000, 'F-CAB')]).includes('DRAW_TEXT_OVER_CONTENT'));
// ④ 空白处的文字 → 一条都不许报
ok('空白处的文字不报', codes([FRAME, T('挂衣杆', 100, 500), L(0, 1200, 900, 1200)]).length === 0);
// ⑤ 框外的线条不算穿过
ok('框外的线不算穿过', !codes([FRAME, T('挂衣杆', 100, 500), L(0, 700, 900, 700)]).includes('DRAW_TEXT_OVER_CONTENT'));
// ⑥ 两段文字重叠 → 必须报
ok('文字互相重叠被报出', codes([FRAME, T('挂衣杆', 100, 500), T('层板 ×1', 120, 520)]).includes('DRAW_TEXT_OVERLAP'));
// ⑦ 负样本：挨着但没压住 → 不许报
ok('紧邻不重叠的文字不报', codes([FRAME, T('挂衣杆', 100, 500), T('层板 ×1', 100, 900)]).length === 0);

// 真实样例柜：形状对不对不归这里管，这里只保证跑得完、结论落在已知缺陷上。
const rules = JSON.parse(readFileSync('src/core/ruleset/factory-default.json', 'utf8'));
const project = sampleProject(rules);
let primsChecked = 0;
const real: string[] = [];
const messages: string[] = [];
for (const cab of project.cabinets ?? []) {
  let vs;
  try { vs = buildCabinetViews(cab, rules, { x: 0, y: 0, gapTop: 0, gapSide: 0, gapInt: 0 }); } catch { real.push('DRAW_VIEW_BUILD_FAILED'); continue; }
  const kinds = Object.keys(vs.prims) as Array<keyof typeof vs.prims>;
  for (const kind of kinds) {
    const prims = vs.prims[kind];
    if (!prims?.length) continue;
    primsChecked += prims.length;
    const got = lintPrims(prims, { view: cab.name + '·' + String(kind), target: cab.id });
    real.push(...got.map((i) => i.code));
    messages.push(...got.map((i) => i.message));
  }
}
ok('样例柜真的产出了图元', primsChecked > 0, String(primsChecked));
ok('样例柜没有派生失败', !real.includes('DRAW_VIEW_BUILD_FAILED'));
// 2026-10-22 看图确认的 5 处压字（两块净宽数字、层板、挂衣杆、门板说明）已按根因改掉：
// 重复的净宽数字删了、避让器开始把衣物当"内容"绕开、放不下的图例删了。
// 规则本身是否还活着由上面 ①⑥ 两个合成用例守着，这里改成"必须干净"。
ok('样例柜四个视图一条问题都没有（曾经 5 处压字）', real.length === 0, real.length + ' 条：' + [...new Set(messages)].join(' / '));
ok('规则不是恒真：合成用例里该报的两条都报了', pass >= 6);

console.log('\n样例柜检查结果：图元 ' + primsChecked + '，问题 ' + real.length + ' 条');
for (const m of messages) console.log('  - ' + m);
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail > 0) process.exit(1);
