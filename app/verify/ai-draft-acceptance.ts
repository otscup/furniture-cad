import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { RuleSet } from '../src/core/types.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { emptyProject, rectRoom } from '../src/core/docFactory.ts';
import { compileAction, type AiAction } from '../src/ai/compile.ts';
import {
  addDraftRound,
  draftSnapshot,
  finalizeDraft,
  startDraft,
  undoLastRound,
} from '../src/ai/draftSession.ts';
import { validatePlan } from '../shared/aiContract.mjs';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  草案会话验收 —— 「先聊出方案，定稿才落地」
 *
 *  用户原话：
 *    "ai能不能改成对话框形态，根据对话内容先在对话框里面生成图纸或大体结构，
 *     可以持续对话修改。如果方案确定再生成实际可编辑的稿件。"
 *
 *  ── 这批断言要证明什么 ──
 *    ① **第二轮看得见第一轮的成果**。这是"能持续对话修改"的全部前提：
 *       喂给 AI 的快照取自**草案**，不是真项目。少了这条，第二句
 *       "把刚才那个柜子加高"就没有任何着落 —— 表现像模型犯傻，实际是喂错了东西。
 *    ② **定稿前真模型一个字节都没动**。草案活在自己的沙盒里，
 *       柜体数、版本号在定稿前后必须是"0 → N"。
 *    ③ 定稿走的是 `commitPlan`：版本被改动过就必须拒绝，不能"尽力合并"。
 *    ④ 失败的一轮**不并入**草案，也不进待提交步骤 —— 半截成功比全失败更危险。
 *    ⑤ 撤回上一轮能重放出正确状态（不是简单地把数组 pop 掉）。
 *
 *  ── 为什么要单独一个文件 ──
 *    草案是"多轮累积"，和 ai-generate-acceptance 里那种"一次跑完"的模型不同，
 *    断言的前提（上一轮的结果要留在桌上）也不一样，混在一起会互相掩盖失败。
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
function section(title: string): void {
  console.log(`\n【${title}】`);
}

/** 建一个带「厨房」的空项目 —— 与 L 形那批断言同一个几何，保证房间放得下 */
function freshBus(): CommandBus {
  const p = emptyProject({ name: '家', ruleSetId: rules.id });
  p.rooms.push(rectRoom({ name: '厨房', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 }));
  return new CommandBus(p, rules);
}

const ACT = (a: Omit<AiAction, 'reason'> & { reason?: string }): AiAction => ({ reason: '', ...a }) as AiAction;

/** 契约校验：AI 产出的动作必须先过这一关，否则后面编译的都是"它自己编的" */
function legal(actions: AiAction[]): AiAction[] {
  const v = validatePlan({ reply: '', actions }, { bodyMaterials: [], backMaterials: [] });
  return v.ok ? v.actions : [];
}

// ───────────────────────────── A 开案与快照 ─────────────────────────────
section('A 开案：草案是真项目的一份拷贝');

const bus = freshBus();
const cabCount0 = bus.getState().cabinets.length;
const ver0 = bus.getVersion();

const d0 = startDraft(bus);
ok('A1 开案时草案与真项目一致（柜体数相同）', d0.project.cabinets.length === cabCount0, `草案 ${d0.project.cabinets.length} / 真 ${cabCount0}`);
ok('A2 开案时记下真总线版本（定稿要拿它比对）', d0.baseVersion === ver0);
ok('A3 开案时还没有可提交步骤', d0.steps.length === 0);
ok('A4 开案时快照里没有柜体', draftSnapshot(d0, rules).cabinets.length === 0);

// ───────────────────────────── B 第一轮：建柜 ─────────────────────────────
section('B 第一轮：在草案上建一个柜，真模型不许动');

const round1: AiAction[] = legal([
  ACT({ action: 'cabinet.create', target: { roomName: '厨房' }, params: { name: '长边', width: 2200, height: 1000, depth: 750 } }),
]);
ok('B0 建柜动作本身合法（契约放行）', round1.length === 1);

const d1 = addDraftRound(d0, { text: '建一个 L 形橱柜的长边', reply: '建好了', actions: round1, rules });
ok('B1 第一轮并入草案', d1.rounds[0]?.merged === true, JSON.stringify(d1.rounds[0]?.run.steps.map((s) => s.error)));
ok('B2 草案里有了一个柜体', d1.project.cabinets.length === 1, `实际 ${d1.project.cabinets.length}`);
ok('B3 **真总线仍然一个柜体都没有**（定稿前不许动它）', bus.getState().cabinets.length === 0, `真总线 ${bus.getState().cabinets.length}`);
ok('B4 真总线版本号没变', bus.getVersion() === ver0);
ok('B5 累积了 1 条可提交步骤', d1.steps.length === 1);

// ───────────────────────────── C 快照来自草案（最关键） ─────────────────────────────
section('C 第二轮喂给 AI 的快照必须是草案的');

const snap1 = draftSnapshot(d1, rules);
ok('C1 草案快照里看得到第一轮建的柜体', snap1.cabinets.length === 1, JSON.stringify(snap1.cabinets.map((c) => c.name)));
ok('C2 快照里的柜名就是第一轮建的那个', snap1.cabinets[0]?.name === '长边');
ok('C3 快照仍不带任何几何（只有语义参数）', !JSON.stringify(snap1).includes('panels') && !JSON.stringify(snap1).includes('prims'));

// 第二轮：用**名字**引用第一轮建出来的柜 —— 这正是"看得见"才能做到的事
const round2: AiAction[] = legal([
  ACT({ action: 'cabinet.resize', target: { cabinetName: '长边' }, params: { height: 2400 } }),
]);
ok('C4 按名字改尺寸这个动作合法', round2.length === 1);

const d2 = addDraftRound(d1, { text: '把刚才那个柜子加到 2400 高', reply: '加高了', actions: round2, rules });
ok('C5 第二轮并入草案（说明它找到了"刚才那个柜子"）', d2.rounds[1]?.merged === true, JSON.stringify(d2.rounds[1]?.run.steps.map((s) => s.error)));
ok('C6 草案里柜体高度已经变成 2400', d2.project.cabinets[0]?.params.height === 2400, String(d2.project.cabinets[0]?.params.height));
ok('C7 累积了 2 条可提交步骤', d2.steps.length === 2);
ok('C8 真总线依然空着', bus.getState().cabinets.length === 0);

// ───────────────────────────── D 定稿 ─────────────────────────────
section('D 定稿：把累积步骤写进真总线');

const fin = finalizeDraft(d2, bus);
ok('D1 定稿成功', fin.ok === true, fin.ok ? '' : fin.error);
ok('D2 真总线现在有 1 个柜体', bus.getState().cabinets.length === 1, `实际 ${bus.getState().cabinets.length}`);
ok('D3 定稿后高度是第二轮改出来的 2400', bus.getState().cabinets[0]?.params.height === 2400, String(bus.getState().cabinets[0]?.params.height));
ok('D4 真总线版本被 bump 了（说明真的走了 CommandBus）', bus.getVersion() > ver0);
ok('D5 空草案定稿要被拒绝，而不是"什么都不做还报成功"', finalizeDraft(startDraft(bus), bus).ok === false);

// ───────────────────────────── E 失败的一轮不并入 ─────────────────────────────
section('E 失败的那一轮不许污染草案');

const bus2 = freshBus();
const e0 = startDraft(bus2);
const e1 = addDraftRound(e0, {
  text: '建一个柜',
  reply: '',
  actions: round1,
  rules,
});
/**
 * 用的是**半截成功**这个场景，不是"整轮全失败"。
 *
 * 全失败太好验了 —— 失败步骤没有 command，本来也进不了 steps，
 * 那种断言永远为真，验的是空气。真正危险的是下面这种：
 *   第一条改成功了（长边 → 2000），第二条引用了一个不存在的柜子失败了。
 * 如果实现是"成功的就并入、失败的跳过"，草案会停在一个**只改了一半**的状态，
 * 而人看到界面上"改成功了 1 条"，会以为生效了 —— 这是最坏的一种静默错误。
 */
const halfGood: AiAction[] = legal([
  ACT({ action: 'cabinet.resize', target: { cabinetName: '长边' }, params: { height: 2000 } }),
  ACT({ action: 'cabinet.resize', target: { cabinetName: '根本没有这个柜' }, params: { height: 999 } }),
]);
ok('E0 这一轮确实是"一成一败"（前提成立，否则下面四条验的是空气）', halfGood.length === 2 && e1.project.cabinets[0]?.params.height === 1000);

const e2 = addDraftRound(e1, { text: '把长边加到 2000，顺便改一个不存在的柜子', reply: '', actions: halfGood, rules });

ok('E1 半截成功的那一轮整体不并入', e2.rounds[1]?.merged === false);
ok('E2 草案**没被那条成功的 resize 改掉**（仍是 1000 高）', e2.project.cabinets[0]?.params.height === 1000, String(e2.project.cabinets[0]?.params.height));
ok('E3 待提交步骤仍是 1 条（半截那条不许混进去）', e2.steps.length === 1, `实际 ${e2.steps.length}`);
ok('E4 失败原因被留在记录里（界面要显示它，不能静默）', (e2.rounds[1]?.run.steps[1]?.error ?? '').length > 0);
ok('E5 成功那条的状态也被如实记录（它是"没生效"，不是"没说"）', e2.rounds[1]?.run.steps[0]?.ok === true);

// ───────────────────────────── F 撤回 ─────────────────────────────
section('F 撤回上一轮：重放出上一轮之前的状态');

const f1 = undoLastRound(d2, { rules });
ok('F1 撤回后只剩 1 轮', f1.rounds.length === 1);
ok('F2 撤回后高度回到第一轮的 1000', f1.project.cabinets[0]?.params.height === 1000, String(f1.project.cabinets[0]?.params.height));
ok('F3 撤回后可提交步骤只剩 1 条', f1.steps.length === 1);
ok('F4 空草案撤回不炸（返回自身）', undoLastRound(startDraft(bus), { rules }).rounds.length === 0);

// ───────────────────────────── G 版本保护 ─────────────────────────────
section('G 真模型被改动后，定稿必须拒绝');

const bus3 = freshBus();
const g0 = startDraft(bus3);
const g1 = addDraftRound(g0, { text: '建柜', reply: '', actions: round1, rules });
// 模拟"用户在主界面手动拖了一下柜子"：真总线自己走一步
const manual = legal([ACT({ action: 'cabinet.create', target: { roomName: '厨房' }, params: { name: '手动放的柜', width: 600, height: 800, depth: 500 } })]);
const manualCompiled = manual.length > 0 ? compileAction(manual[0], bus3.getState(), rules) : null;
if (manualCompiled?.ok) {
  const r = bus3.execute(manualCompiled.command, { strict: true });
  ok('G0 手动改动确实生效了（这条是 G1~G3 的前提，不成立则后面三条验的是空气）', r.ok === true);
} else {
  ok('G0 手动改动确实生效了（前提）', false, manualCompiled?.error ?? '编译失败');
}
ok('G1 真总线版本已经不是开案时那个', bus3.getVersion() !== g1.baseVersion);
const gFin = finalizeDraft(g1, bus3);
ok('G2 定稿被拒绝（落点已失效，不能尽力合并）', gFin.ok === false);
ok('G3 拒绝理由说清楚了', (gFin.ok ? '' : gFin.error).includes('改动过'), gFin.ok ? '' : gFin.error);

console.log(`\n${'='.repeat(64)}`);
console.log(`草案会话验收：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log(`失败项：\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
