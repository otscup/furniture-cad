/**
 * ══════════════════════════════════════════════════════════════════════
 *  NLU 评测卡（2026-10-21）
 *
 * ── 它是什么 ──
 *   一组**真实用户口语**的说法 + 期望动作 + 程序化判分。
 *   不靠 LLM judge，靠「模型输出的动作名是否命中期望」。
 *
 * ── 为什么要有 ──
 *   「agent 能不能听懂人话」这件事**一直没有度量**。
 *   之前只能靠「试用时感觉还行」。
 *   有了这张卡，改提示词/换模型/加动作之后，
 *   能不能听懂就变成一个**可比较的数字**。
 *
 * ── 两种判定 ──
 *   ① **动作命中**：模型选了对的动作（最直接）。
 *   ② **正确澄清**：信息不足时**应该追问**而不是瞎猜。
 *      —— 这一项比动作命中率更贴近用户感受。
 *     「建个柜子」这种请求，正确行为是问「什么柜子、多宽、多高」，
 *     不是随便造一个。
 *
 * ── 怎么跑 ──
 *   node --experimental-strip-types verify/nlu-eval.ts
 *   联网跑（要真实调模型）。离线时自动跳过并说明。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemPrompt } from '../shared/aiContract.mjs';
import { summarizeProjectContext } from '../server/agentLoop.mjs';
import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
import type { RuleSet } from '../src/core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const rules = JSON.parse(readFileSync(join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

// ── 网关配置（自己读 .env，验收不该依赖外部环境变量是否导出）──
const envText = (() => { try { return readFileSync(join(here, '..', '.env'), 'utf8'); } catch { return ''; } })();
const envOf = (k: string): string => {
  const m = new RegExp('^' + k + '=(.*)$', 'm').exec(envText);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
};
const BASE = process.env.AI_BASE_URL || envOf('AI_BASE_URL');
const KEY = process.env.AI_API_KEY || envOf('AI_API_KEY');
const MODEL = process.env.AI_MODEL || envOf('AI_MODEL');

/** 造一个真实项目：主卧 + 客厅，各有柜子 */
function buildProject() {
  const project = emptyProject({ name: 'nlu', ruleSetId: rules.id, id: 'nlu' });
  const bedroom = rectRoom({ name: '主卧', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  const living = rectRoom({ name: '客厅', x: 10000, y: 0, w: 5000, h: 4000, thickness: 120, height: 2700 });
  project.rooms.push(bedroom, living);
  const mk = (id: string, name: string, roomId: string, x: number, kind: string) =>
    createCabinet({
      id, name, roomId, x, y: 60, rotation: 0, rules,
      params: { width: 1800, height: 2400, depth: 600, bodyLift: 80, cabinetType: kind, mountHeight: 0 },
      units: [{ id: id + 'u', kind: 'hanging', requestedWidth: 1800, nickname: '挂衣区' }],
    });
  project.cabinets.push(mk('c1', '主卧衣柜', bedroom.id, 100, 'tall'));
  project.cabinets.push(mk('c2', '主卧床尾柜', bedroom.id, 2100, 'base'));
  project.cabinets.push(mk('c3', '客厅电视柜', living.id, 100, 'base'));
  return { project, bedroom };
}

/**
 * ★ 评测用例 ──
 *
 * wantActions：期望模型选的动作（任一命中即算动作命中）
 * wantClarify：该请求**信息不足**，正确行为是**追问**（而不是硬猜）
 *
 * 用例刻意用**口语**，不是命令式：
 *   「给我来个衣柜」而不是「创建柜体 type=tall」
 *   「刚才那个柜子太宽了」而不是「resize width=800」
 *   —— 前者才是用户真会说的话。
 */
interface NluCase {
  q: string;
  wantActions: string[];
  wantClarify?: boolean;
  note?: string;
}
const CASES: NluCase[] = [
  { q: '给我来个衣柜', wantActions: ['cabinet.create'] },
  { q: '刚才那个柜子太宽了，缩到800', wantActions: ['cabinet.resize'] },
  { q: '主卧的床旁边那个柜子往左挪一点', wantActions: ['cabinet.nudge', 'cabinet.move'] },
  { q: '那个挂衣区下面加一层格子', wantActions: ['cabinet.addUnit', 'cabinet.setUnitParam'] },
  { q: '换成玻璃门', wantActions: ['cabinet.setUnitParam', 'cabinet.addUnit'] },
  { q: '加个裤架', wantActions: ['cabinet.setUnitParam', 'cabinet.addUnit'] },
  { q: '这柜子下面留个洗衣机的位置', wantActions: ['cabinet.addUnit'] },
  { q: '把两个柜子连起来', wantActions: ['assembly.create'] },
  { q: '叫「主卧衣柜」', wantActions: ['cabinet.rename'] },
  { q: '层板再多加两层', wantActions: ['cabinet.setUnitParam'] },
  { q: '踢脚改成100', wantActions: ['cabinet.setBodyLift'] },
  { q: '再来一个一样的', wantActions: ['cabinet.duplicate'] },
  /**
   * ★ 需要澄清的用例 ──
   *   这些请求**信息不足**，正确行为是追问。
   *   「建个柜子」缺太多信息（柜型/宽/高/位置），
   *   模型如果直接造一个 600×800×600 的柜子，就是**在替用户做决定**。
   */
  { q: '建个柜子', wantActions: [], wantClarify: true, note: '柜型/宽高/位置都不明' },
  { q: '再宽点', wantActions: [], wantClarify: true, note: '相对量但没基准' },
  { q: '加个抽屉', wantActions: [], wantClarify: true, note: '哪个柜？多宽？' },
];

async function chat(model: string, messages: unknown[], maxTokens = 8192) {
  const t0 = Date.now();
  const r = await fetch(BASE.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.1 }),
    signal: AbortSignal.timeout(180000),
  });
  const txt = await r.text();
  const ms = Date.now() - t0;
  if (!r.ok) return { ok: false, status: r.status, ms, raw: txt.slice(0, 200) };
  const j = JSON.parse(txt);
  const m = (j?.choices?.[0]?.message ?? {}) as { content?: string };
  return { ok: true, ms, content: String(m.content ?? ''), finish: j?.choices?.[0]?.finish_reason, usage: j?.usage };
}

const { project, bedroom } = buildProject();
const ctx = summarizeProjectContext(project, bedroom.id, []);
const sys = buildSystemPrompt({});

if (!BASE || !KEY || !MODEL) {
  console.log('未配置 AI_BASE_URL / AI_API_KEY / AI_MODEL —— 跳过（联网评测需要网关）');
  console.log('='.repeat(64));
  process.exit(0);
}

console.log(`模型：${MODEL}`);
console.log(`用例：${CASES.length} 条`);
console.log('='.repeat(64));

let actionHit = 0;
let actionTotal = 0;
let clarifyHit = 0;
let clarifyTotal = 0;
const details: string[] = [];

for (const c of CASES) {
  const r = await chat(MODEL, [
    { role: 'system', content: sys },
    { role: 'user', content: ctx + '\n\n用户说：' + c.q },
  ]);
  let actions: string[] = [];
  let reply = '';
  let parseFail = false;
  if (r.ok) {
    const t = r.content.trim();
    const js = t.replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/\s*```[\s\S]*$/, '').trim();
    try {
      const j = JSON.parse(js || t) as { actions?: Array<{ action?: string }>; reply?: string };
      actions = (j.actions ?? []).map((a) => String(a.action ?? ''));
      reply = String(j.reply ?? '');
    } catch {
      parseFail = true;
    }
  }
  if (c.wantClarify) {
    clarifyTotal++;
    // 正确澄清 = 没有瞎给动作（动作数组为空）
    const didClarify = actions.length === 0;
    if (didClarify) clarifyHit++;
    console.log(`  ${didClarify ? 'v' : 'x'} ${c.q.padEnd(24)} 期望=追问  实际=${actions.join('/') || '(追问)'}  ${r.ms}ms`);
    if (!didClarify) details.push(`${c.q} —— 应该追问却直接给了动作：${actions.join(', ')}`);
  } else {
    actionTotal++;
    const hit = c.wantActions.some((w) => actions.includes(w));
    if (hit) actionHit++;
    console.log(`  ${hit ? 'v' : 'x'} ${c.q.padEnd(24)} 期望=${c.wantActions.join('/')}  实际=${actions.join('/') || (parseFail ? '(JSON 截断)' : '-')}  ${r.ms}ms`);
    if (!hit && reply) details.push(`${c.q} —— 模型答：${reply.slice(0, 90)}`);
  }
}

console.log('='.repeat(64));
const actionRate = actionTotal ? actionHit / actionTotal : 0;
const clarifyRate = clarifyTotal ? clarifyHit / clarifyTotal : 0;
console.log(`动作命中率：${actionHit}/${actionTotal} = ${(actionRate * 100).toFixed(0)}%`);
console.log(`正确澄清率：${clarifyHit}/${clarifyTotal} = ${(clarifyRate * 100).toFixed(0)}%`);
if (details.length) {
  console.log('');
  console.log('未命中明细：');
  for (const d of details) console.log('  · ' + d);
}
console.log('='.repeat(64));
console.log('');
console.log('★ 这是**评测**不是**断言** —— 分数低不代表功能坏了。');
console.log('  用途：改提示词 / 换模型 / 加动作之后，拿它对比前后。');
console.log('  门槛建议：动作命中率不低于改动前的水平。');
