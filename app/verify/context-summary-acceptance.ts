/**
 * ══════════════════════════════════════════════════════════════════════
 *  上下文摘要验收（2026-10-21）
 *
 * ── 它守的是什么 ──
 *   summarizeProjectContext 的输出是**喂给模型的**唯一项目现状来源。
 *   它漏了什么，模型就「读不到」什么 ——
 *   然后模型会诚实地说「我读不到当前分区的层板数」，
 *   用户看到的解释是「AI 听不懂」，而真相是「上下文没给」。
 *
 *   ★ 2026-10-21 抓到的真 bug ──
 *     原来读的是 `c.units`，而那个字段**根本不存在**
 *     （实测 `Array.isArray(cab.units) === false`，分区在 `cab.layout.units`）。
 *     ⇒ 分区结构**从来没进过提示词**，而「补上分区结构」的注释却写着已经补了。
 *     这类「注释说做了、实际没做」的缺陷，只有**行为断言**能抓住。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeProjectContext } from '../server/agentLoop.mjs';
import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
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

// ═══════════════ 1. 分区结构必须真的在摘要里 ═══════════════
section('1. 分区结构（★ 2026-10-21 修的真 bug）');
{
  const project = emptyProject({ name: 'p', ruleSetId: rules.id, id: 'p' });
  const room = rectRoom({ name: '主卧', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  project.rooms.push(room);
  project.cabinets.push(createCabinet({
    id: 'c1', name: '主卧衣柜', roomId: room.id, x: 100, y: 60, rotation: 0, rules,
    params: { width: 1800, height: 2400, depth: 600, bodyLift: 80, cabinetType: 'tall', mountHeight: 0 },
    units: [
      { id: 'u1', kind: 'hanging', requestedWidth: 900, nickname: '挂衣区', rod: { count: 1, heightFromBottom: 1800 }, doors: { count: 1, gapOuter: 0, gapMid: 0, material: 'M_GLASS_8_GREY' } },
      { id: 'u2', kind: 'shelves', requestedWidth: 900, nickname: '层板格', shelves: { count: 3, mode: 'equal', gapPerSide: 0.5, ledStrip: 'front', tilt: 0 } },
    ],
  }));

  const ctx = summarizeProjectContext(project, room.id, []);
  console.log('      摘要实际内容：');
  console.log(ctx.split('\n').map((l) => '        ' + l).join('\n'));

  ok('★ ★ 摘要里有分区数量', /2 个分区/.test(ctx), ctx.slice(0, 200));
  ok('★ ★ 摘要里有分区类型（挂衣区/层板格）', ctx.includes('挂衣区') && ctx.includes('层板格'));
  ok('★ ★ 摘要里有层板数（3）—— 模型要靠它算「再加两层」', /3层板/.test(ctx), ctx.slice(0, 200));
  ok('★ 摘要里有挂衣杆', ctx.includes('挂衣杆'));
  // ★ 2026-10-22 补：**AI 要改的每个数值都得在摘要里**。
  //   原来只有「挂衣区/挂衣杆」，**杆高、分区净宽、门数、电器洞口尺寸都没进去**。
  //   ⇒ 模型遇到「挂衣杆再高 200」会说「系统里没有记录杆高基准值」——
  //   ★ **它说的是事实**。模型不笨，是信息没给全。
  ok('★★ 摘要里有挂衣杆高度（模型要靠它算「再高 200」）', /离底\s*1800/.test(ctx), ctx.slice(0, 260));
  ok('★★ 摘要里有分区净宽（模型要靠它算「再宽 100」）', /900宽/.test(ctx), ctx.slice(0, 260));
  ok('★★ 摘要里有门板材质（「换成玻璃门」得知道现在是什么）', /材质M_GLASS_8_GREY/.test(ctx), ctx.slice(0, 300));
  // ★ 「离地」曾经错写成 mountHeight（挂高）—— 地柜 bodyLift=80 却被显示成「离地=0mm」，
  //   模型据此以为踢脚是 0（「踢脚改成100」就换算错了）。
  ok('★★ 摘要里的踢脚高是 bodyLift（不是 mountHeight）', /踢脚=80mm/.test(ctx), ctx.slice(0, 300));
  ok('★ 摘要里有柜体名与 id', ctx.includes('主卧衣柜') && ctx.includes('cabinetId=c1'));
  ok('★ 摘要里有柜体尺寸', /1800×2400×600/.test(ctx));
}

// ═══════════════ 2. 多行柜的行结构 ═══════════════
section('2. 多行柜：行与分区都要在摘要里');
{
  const project = emptyProject({ name: 'p2', ruleSetId: rules.id, id: 'p2' });
  const room = rectRoom({ name: '主卧', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  project.rooms.push(room);
  project.cabinets.push(createCabinet({
    id: 'cM', name: '多层衣柜', roomId: room.id, x: 100, y: 60, rotation: 0, rules,
    params: { width: 1800, height: 2400, depth: 600, bodyLift: 80, cabinetType: 'tall', mountHeight: 0 },
    // ★ 只给 rows（同时给 units 的话 units 优先，rows 会被忽略 —— 见 docFactory）
    rows: [
      { height: 1200, units: [{ id: 'r1u', kind: 'hanging', requestedWidth: 1800, nickname: '挂衣区' }] },
      { height: 1200, units: [{ id: 'r2u', kind: 'shelves', requestedWidth: 1800, nickname: '下层格', shelves: { count: 4, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 } }] },
    ],
  }));
  const ctx = summarizeProjectContext(project, room.id, []);
  ok('★ ★ 摘要里有行数（上下 2 行）', /上下 2 行/.test(ctx), ctx.slice(0, 220));
  ok('★ ★ 摘要里标明第几行', ctx.includes('第1行') && ctx.includes('第2行'));
  ok('★ ★ 摘要里有下层的层板数（4）', /4层板/.test(ctx), ctx.slice(0, 220));
}

// ═══════════════ 3. 上一轮改了什么 ═══════════════
section('3. 上一轮改了什么（「再宽点」要有落点）');
{
  const project = emptyProject({ name: 'p3', ruleSetId: rules.id, id: 'p3' });
  const room = rectRoom({ name: '主卧', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  project.rooms.push(room);
  const ctx = summarizeProjectContext(project, room.id, [
    { role: 'assistant', text: '好的', agentSummary: '把「主卧衣柜」宽改成了 1800' },
  ]);
  ok('★ 摘要里有上一轮做的事', ctx.includes('宽改成了 1800'), ctx.slice(0, 200));
  ok('★ 提示模型这句话可能是在那基础上继续改', ctx.includes('继续改'));
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`上下文摘要验收：通过 ${pass} 项，失败 0 项`);
  console.log('全部通过：分区结构、行结构、上一轮摘要都真的进了提示词。');
} else {
  console.log(`上下文摘要验收：通过 ${pass} 项，失败 0 项`.replace('0 项', `${fail} 项`));
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
