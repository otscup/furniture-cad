/**
 * ══════════════════════════════════════════════════════════════════════
 *  纠正记忆 → 提示词 接线验收（2026-10-21）
 *
 * ── 它守的是什么 ──
 *   这个系统早就有"纠正记忆"：管理后台可编辑 corrections.jsonl、memoryStore 有投影、
 *   currentKnowledge() 也汇总好了 —— 但它**从来没传给 LLM**。
 *   用户在管理后台写的每一条纠正，AI 完全看不到，每次都得在对话里重新说一遍。
 *
 *   本条验收钉住四件事：
 *   1. buildSystemPrompt 真的能把规则念给模型（且位置靠前、带标签）
 *   2. 空规则**不产生空标题**（空标题会让模型以为"没有约定"）
 *   3. 只注入 status=active 的条目（pending/rejected 是未确认的，不该当既定约定）
 *   4. 服务端真的在调 AI 时传了它（源码级，不是"函数支持了但没人调用"）
 *
 * ── 为什么第 4 条必须是源码级 ──
 *   "能力建好了但没接线"是这个项目最反复出现的缺陷模式（见 MCP-DOT-AND-NEXT 文档）。
 *   只断言 buildSystemPrompt 支持参数，证明不了任何请求真的带上了它。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChatRequest, buildDesignRequest, buildSystemPrompt } from '../shared/aiContract.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const SNAPSHOT = { projectName: 't', rooms: [], cabinets: [] };
const RULES = [
  { nl: '本店默认柜体深度 600mm，不要用别的值', tags: ['工艺'] },
  { nl: '面板侧板都是一块整板，不许拆条', tags: ['工艺'] },
  { nl: '地柜与吊柜合成一页出图', tags: ['图纸', '导出'] },
];

// ═══════════════ 1. 注入行为 ═══════════════
section('1. buildSystemPrompt 真的把规则念给模型');
{
  const without = buildSystemPrompt();
  ok('不带规则时没有「本项目的既定约定」段', !without.includes('本项目的既定约定'));

  const withRules = buildSystemPrompt({ projectRules: RULES });
  ok('带规则时出现约定段', withRules.includes('本项目的既定约定'));
  ok('三条规则全部出现', RULES.every((r) => withRules.includes(r.nl)),
    RULES.filter((r) => !withRules.includes(r.nl)).map((r) => r.nl).join(' / '));
  ok('标签被带上（模型能看出这是哪一类约定）', withRules.includes('工艺') && withRules.includes('图纸/导出'));

  /**
   * 位置：必须在**动作清单之前**。
   * 动作清单有 28 条、几千字，放在它后面容易被冲淡 ——
   * 这些是"既定事实"，应该先于"可选动作"被读到。
   */
  const rulePos = withRules.indexOf('本项目的既定约定');
  const actionPos = withRules.indexOf('动作清单');
  ok('约定段出现在动作清单之前（先读事实再读可选动作）',
    rulePos >= 0 && actionPos > rulePos, `rule@${rulePos} action@${actionPos}`);
  ok('约定段足够靠前（前 200 字内）', rulePos >= 0 && rulePos < 200, `位置 ${rulePos}`);
}

// ═══════════════ 2. 空规则不留空标题 ═══════════════
section('2. 空规则不产生空标题（否则模型会以为"没有约定"）');
{
  ok('空数组：无约定段', !buildChatRequest('m', 'hi', SNAPSHOT, { projectRules: [] }).messages[0]!.content.includes('本项目的既定约定'));
  ok('不传参数：无约定段', !buildChatRequest('m', 'hi', SNAPSHOT, {}).messages[0]!.content.includes('本项目的既定约定'));
  ok('undefined：无约定段', !buildChatRequest('m', 'hi', SNAPSHOT, { projectRules: undefined }).messages[0]!.content.includes('本项目的既定约定'));
  // 只有空白 nl 的条目也不该留下标题
  ok('规则条目全是空白：无约定段',
    !buildSystemPrompt({ projectRules: [{ nl: '   ' }, { nl: '' }] }).includes('本项目的既定约定'));
}

// ═══════════════ 3. 两条通道都带 ═══════════════
section('3. 规划通道与设计方案通道都带同一份约定');
{
  const chat = buildChatRequest('m', 'hi', SNAPSHOT, { projectRules: RULES }).messages[0]!.content;
  const design = buildDesignRequest('m', 'hi', SNAPSHOT, { projectRules: RULES }).messages[0]!.content;
  ok('规划通道带全部三条', RULES.every((r) => chat.includes(r.nl)));
  ok('设计方案通道也带全部三条', RULES.every((r) => design.includes(r.nl)),
    '不带就会"规划时知道面板不拆、出方案时又忘了"');
}

// ═══════════════ 4. 服务端真的传了（源码级） ═══════════════
section('4. 服务端真的在调 AI 时传了它（不是"函数支持了但没人调用"）');
{
  const serverSrc = readFileSync(join(root, 'server', 'server.mjs'), 'utf8');
  const mustHave: Array<[string, string]> = [
    ['activeProjectRules', '从 corrections.jsonl 读 active 条目的函数'],
    ["item.status !== 'active'", '只取 status=active（pending/rejected 不进提示词）'],
    ['projectRules: activeProjectRules()', '调 AI 时真的把规则传下去'],
  ];
  for (const [needle, what] of mustHave) {
    ok(`★ server.mjs 源码含「${what}」`, serverSrc.includes(needle), `没找到：${needle}`);
  }
  ok('★ 两条 AI 通道都传了 projectRules（至少两处调用）',
    (serverSrc.match(/projectRules:\s*activeProjectRules\(\)/g) ?? []).length >= 2,
    `实际 ${(serverSrc.match(/projectRules:\s*activeProjectRules\(\)/g) ?? []).length} 处`);
}

// ═══════════════ 5. 读文件失败不让 AI 崩 ═══════════════
section('5. 记忆文件读不了时降级为空，不让 AI 通道失败');
{
  const serverSrc = readFileSync(join(root, 'server', 'server.mjs'), 'utf8');
  /**
   * activeProjectRules 必须整体包在 try/catch 里并 return []。
   * 记忆是"加分项"不是"前置条件" —— 这与 workspaceHost 的
   * "通知失败不改变装载结果"是同一条纪律。
   */
  const fnMatch = /function activeProjectRules\(\)[\s\S]*?\n}/.exec(serverSrc);
  ok('★ activeProjectRules 函数存在', Boolean(fnMatch));
  if (fnMatch) {
    const body = fnMatch[0];
    ok('★ 函数整体有 try/catch 兜底', body.includes('try {') && body.includes('catch'));
    ok('★ catch 里返回空数组（不是抛错、不是返回 undefined）', /catch\s*\{[\s\S]*?return\s*\[\]/.test(body), body.slice(-200));
  }
}

// ═══════════════ 汇总 ═══════════════
console.log('\n' + '═'.repeat(60));
console.log(`  纠正记忆接线验收：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：规则真的进了提示词、位置靠前、空规则不留标题、两条通道都带、读失败能降级。');
