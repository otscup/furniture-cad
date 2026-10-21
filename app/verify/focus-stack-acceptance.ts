/**
 * ══════════════════════════════════════════════════════════════════════
 *  焦点栈验收（2026-10-21）
 *
 * ── 它守的是什么 ──
 *   跨轮指代（「再宽点」「第一格」「那个抽屉」）全靠焦点栈。
 *   没有它，模型每轮都要从自由文本里**重新推断**焦点 ⇒ 它飘
 *   （NLU 评测卡实测多轮场景 pass^3 只有 75%，三个场景里最弱）。
 *
 *   焦点栈把三件事变成**结构化事实**给模型：
 *     ① 盯着哪只柜（id + 名字）
 *     ② 上一轮改了哪些字段、改成多少
 *     ③ 改动后的**绝对值**（相对量换算的基准）
 *
 * ── 为什么这些断言必须是行为式的 ──
 *   「提示词里有没有焦点」用源码扫描测不出来（改了写法就误报）。
 *   这里直接**调用** deriveFocusFromHistory + renderFocusStack，
 *   断言它们的输出。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveFocusFromHistory, deriveFocusFacts, renderFocusStack } from '../shared/focusStack.mjs';
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

function buildProject() {
  const project = emptyProject({ name: 'p', ruleSetId: rules.id, id: 'p' });
  const room = rectRoom({ name: '主卧', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  project.rooms.push(room);
  project.cabinets.push(createCabinet({
    id: 'c1', name: '主卧衣柜', roomId: room.id, x: 100, y: 60, rotation: 0, rules,
    params: { width: 1800, height: 2400, depth: 600, bodyLift: 80, cabinetType: 'tall', mountHeight: 0 },
    units: [
      { id: 'u1', kind: 'hanging', requestedWidth: 1200, nickname: '挂衣区', rod: { count: 1, heightFromBottom: 1800 } },
      { id: 'u2', kind: 'shelves', requestedWidth: 600, nickname: '层板格', shelves: { count: 3, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 } },
    ],
  }));
  project.cabinets.push(createCabinet({
    id: 'c2', name: '主卧床尾柜', roomId: room.id, x: 2100, y: 60, rotation: 0, rules,
    params: { width: 900, height: 2000, depth: 600, bodyLift: 80, cabinetType: 'base', mountHeight: 0 },
    units: [{ id: 'u3', kind: 'shelves', requestedWidth: 900, nickname: '抽屉格', drawers: { count: 3, gap: 0, runner: 'M_RUNNER', runnerLength: 450, boxHeightDeduct: 0, style: 'plain' } }],
  }));
  return project;
}

// ═══════════════ 1. 从结构化步骤推导焦点 ═══════════════
section('1. 从工具调用记录推导焦点事实');
{
  const project = buildProject();
  const steps = [
    { round: 1, tool: 'cad.create_cabinet', ok: true, args: { cabinetId: 'c1', name: '主卧衣柜' } },
    { round: 1, tool: 'cabinet.layout', ok: true, args: { cabinetId: 'c1' }, changes: [{ path: 'params.width', op: 'set', value: 2000 }] },
  ];
  const facts = deriveFocusFacts(steps, project);
  ok('★ 推出了一条焦点', facts.length === 1, JSON.stringify(facts));
  ok('★ 柜体 id 对', facts[0]?.cabinetId === 'c1', String(facts[0]?.cabinetId));
  ok('★ 柜体名对（用户这么叫它）', facts[0]?.cabinetName === '主卧衣柜', String(facts[0]?.cabinetName));
  ok('★ 改动的字段被认出来（宽）', facts[0]?.changes?.[0]?.field === '宽', JSON.stringify(facts[0]?.changes));
  ok('★ 改成的值带上了', facts[0]?.changes?.[0]?.to === 2000, String(facts[0]?.changes?.[0]?.to));
  ok('★ ★ 绝对值快照带上了（相对量换算的基准）',
    facts[0]?.snapshot?.width === 1800,
    JSON.stringify(facts[0]?.snapshot));
}

// ═══════════════ 2. 失败的步骤不进焦点 ═══════════════
section('2. 只有成功的步骤才算事实');
{
  const project = buildProject();
  const facts = deriveFocusFacts([
    { round: 1, tool: 'cad.update_object', ok: false, args: { cabinetId: 'c1' }, error: '参数越界' },
  ], project);
  ok('★ 失败的步骤不产生焦点', facts.length === 0, JSON.stringify(facts));
}

// ═══════════════ 3. 从对话历史推导 ═══════════════
section('3. 从对话历史推导焦点');
{
  const project = buildProject();
  const steps = [
    { round: 1, tool: 'cabinet.layout', ok: true, args: { cabinetId: 'c2' }, changes: [{ path: 'params.width', op: 'set', value: 1200 }] },
  ];
  const history = [
    { role: 'user', text: '把床尾柜加宽到 1200' },
    { role: 'assistant', text: '好的', agentSummary: '改好了', agentSteps: JSON.stringify(steps) },
  ];
  const facts = deriveFocusFromHistory(history, project);
  ok('★ 从历史推出焦点', facts.length === 1, JSON.stringify(facts));
  ok('★ 焦点柜体是「主卧床尾柜」', facts[0]?.cabinetName === '主卧床尾柜', String(facts[0]?.cabinetName));

  // 退化路径：只有人话，没有结构化步骤
  const history2 = [
    { role: 'user', text: '把床尾柜加宽' },
    { role: 'assistant', text: '好的', agentSummary: '已把「主卧床尾柜」宽改成 1200' },
  ];
  const facts2 = deriveFocusFromHistory(history2, project);
  ok('★ ★ 退化路径：从人话里也能抠出柜体名', facts2[0]?.cabinetName === '主卧床尾柜', JSON.stringify(facts2));
  ok('★ ★ 退化路径也带上了绝对值（相对量换算需要）', facts2[0]?.snapshot?.width === 900, JSON.stringify(facts2[0]?.snapshot));

  // 没有历史
  ok('★ 没有历史就没有焦点', deriveFocusFromHistory([], project).length === 0);
}

// ═══════════════ 4. 渲染进提示词 ═══════════════
section('4. 渲染进提示词');
{
  const project = buildProject();
  const steps = [
    { round: 1, tool: 'cabinet.layout', ok: true, args: { cabinetId: 'c1' }, changes: [{ path: 'params.width', op: 'set', value: 2000 }] },
  ];
  const facts = deriveFocusFacts(steps, project);
  const text = renderFocusStack(facts);
  ok('★ 渲染出了内容', text.length > 0);
  ok('★ ★ 渲染里有柜体名', text.includes('主卧衣柜'));
  ok('★ ★ 渲染里有 cabinetId', text.includes('cabinetId=c1'));
  ok('★ ★ 渲染里有当前绝对值（相对量换算的基准）', text.includes('宽 1800mm'), text.slice(0, 200));
  ok('★ 渲染里说了「用绝对值换算」', text.includes('绝对值'));
  ok('★ 渲染里说了「别替用户挑」', text.includes('问清楚'));
  ok('★ 没有事实时渲染空串', renderFocusStack([]) === '');
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`焦点栈验收：通过 ${pass} 项，失败 0 项`);
  console.log('全部通过：焦点能推导、能渲染、失效边界正确。');
} else {
  console.log(`焦点栈验收：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
