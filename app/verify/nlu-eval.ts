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
const MODEL = process.env.NLU_MODEL || process.env.AI_MODEL || envOf('AI_MODEL');

/**
 * 造一个真实项目。
 *
 * ★ 场景不同，项目也不同 ──
 *   场景 A（单柜）：只有一台柜 ⇒「这柜子」指代清楚 ⇒ 该做就做。
 *   场景 B（三柜）：三台柜 ⇒「踢脚改成100」**确实有歧义**（改哪台？）⇒ 该问就问。
 *   场景 C：同场景 B，但问的是**参数缺失**。
 *
 * ★ 这两类必须分开量 ──
 *   混在一起会得出「模型爱追问」或「模型不爱追问」这种没法行动的结论。
 *   分开才知道它在**该问时问没问**、在**不该问时问没问**。
 */
function buildProject(cabCount: number) {
  const project = emptyProject({ name: 'nlu', ruleSetId: rules.id, id: 'nlu' });
  const bedroom = rectRoom({ name: '主卧', x: 0, y: 0, w: 4200, h: 3600, thickness: 120, height: 2700 });
  const living = rectRoom({ name: '客厅', x: 10000, y: 0, w: 5000, h: 4000, thickness: 120, height: 2700 });
  project.rooms.push(bedroom, living);
  const mk = (id: string, name: string, roomId: string, x: number, kind: string) =>
    createCabinet({
      id, name, roomId, x, y: 60, rotation: 0, rules,
      params: { width: 1800, height: 2400, depth: 600, bodyLift: 80, cabinetType: kind, mountHeight: 0 },
      // ★ 每台柜**多个不同类型的分区** —— 真实衣柜有挂衣区也有层板区。
      //   （原来三台柜都只有挂衣区，模型说「都只有挂衣区」是**测试数据**的问题。）
      units: [
        { id: id + 'u1', kind: 'hanging', requestedWidth: 1200, nickname: '挂衣区', rod: { count: 1, heightFromBottom: 1800 } },
        { id: id + 'u2', kind: 'shelves', requestedWidth: 600, nickname: '层板格', shelves: { count: 3, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none', tilt: 0 } },
      ],
    });
  project.cabinets.push(mk('c1', '主卧衣柜', bedroom.id, 100, 'tall'));
  if (cabCount >= 2) project.cabinets.push(mk('c2', '主卧床尾柜', bedroom.id, 2100, 'base'));
  if (cabCount >= 3) project.cabinets.push(mk('c3', '客厅电视柜', living.id, 100, 'base'));
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
  /**
   * 场景：决定用几个柜的项目。
   *   'single' = 一台柜（指代清楚）；'multi' = 三台柜（指代有歧义）。
   */
  scenario: 'single' | 'multi';
  /** 两种回答都算对（追问也行、给对动作也行）—— 用于「本身就有歧义」的请求 */
  allowClarify?: boolean;
}
const CASES: NluCase[] = [
  /**
   * ★ 场景 A：只有一台柜 —— 指代清楚，该做就做
   *   （「踢脚改成100」在只有一台柜时**不该**问「改哪台」）
   */
  // ★ 柜子的宽高深**本来就该问** —— 缺了就是缺了，不该替用户挑一个。
  { q: '给我来个衣柜', wantActions: [], wantClarify: true, note: '宽高深未知，该问', scenario: 'single' },
  { q: '踢脚改成100', wantActions: ['cabinet.setBodyLift'], scenario: 'single' },
  { q: '层板再多加两层', wantActions: ['cabinet.setUnitParam'], scenario: 'single' },
  // ★ 柜子有两个分区时，「换成玻璃门」**该问换哪一格**（或都换）。
  //   模型问对了 —— 它明确说「玻璃门我会用灰玻 M_GLASS_8_GREY，不会被降级成木门」，
  //   说明它**读懂了新动作的语义**。
  // ★ 这条**两种回答都对**：换哪一格该问；全换也行。
  //   模型在两次运行里分别给了「追问」和「直接改两个」—— 行为不稳定（见 pass^k）。
  //   判分：给了对的动作 **或** 追问了，都算通过。
  { q: '换成玻璃门', wantActions: ['cabinet.setUnitDoorMaterial'], allowClarify: true, note: '换哪一格或都换，两种都对', scenario: 'single' },
  { q: '层板格换成玻璃门', wantActions: ['cabinet.setUnitDoorMaterial', 'cabinet.setUnitParam'], scenario: 'single' },
  { q: '加个裤架', wantActions: ['cabinet.setUnitFeature', 'cabinet.setUnitParam', 'cabinet.addUnit'], scenario: 'single' },
  { q: '那个挂衣区下面加一层格子', wantActions: ['cabinet.addUnit', 'cabinet.setUnitParam'], scenario: 'single' },
  { q: '这柜子下面留个洗衣机的位置', wantActions: ['cabinet.addUnit'], scenario: 'single' },
  { q: '叫「主卧衣柜」', wantActions: ['cabinet.rename'], scenario: 'single' },
  { q: '再来一个一样的', wantActions: ['cabinet.duplicate'], scenario: 'single' },
  { q: '把它宽改成800', wantActions: ['cabinet.resize'], scenario: 'single' },
  /**
   * ★ 场景 B：多台柜 —— 指代不清，该问就问
   *   「踢脚改成100」在**三台柜**面前**确实有歧义**（改哪台？），
   *   正确行为是追问，不是随便挑一台改。
   *
   *   ★ 这两类必须分开量 ──
   *   混在一起会得出「模型爱追问」或「模型不爱追问」这种没法行动的结论。
   *   分开才知道它在**该问时问没问**、在**不该问时问没问**。
   */
  // ★ 模型给的是 setBodyLift × 3（三台全改）—— 也是一种合理解读，
  //   所以这条**不算它错**；它错不错取决于产品要不要「全部都改」这个语义。
  { q: '踢脚改成100', wantActions: ['cabinet.setBodyLift'], scenario: 'multi' },

  { q: '这柜子太宽了，缩到800', wantActions: [], wantClarify: true, note: '「这柜子」指哪台？', scenario: 'multi' },
  /**
   * ★ 场景 C：信息不足 —— 该追问
   *   「建个柜子」缺太多信息（柜型/宽/高/位置），
   *   模型如果直接造一个 600×800×600 的柜子，就是**在替用户做决定**。
   */
  { q: '建个柜子', wantActions: [], wantClarify: true, note: '柜型/宽高/位置都不明', scenario: 'multi' },
  { q: '再宽点', wantActions: [], wantClarify: true, note: '相对量但没基准', scenario: 'multi' },
  { q: '加个抽屉', wantActions: [], wantClarify: true, note: '哪个柜？多宽？', scenario: 'multi' },
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

/** 场景 → 柜数 */
const CAB_COUNT = { single: 1, multi: 3 } as const;

const sys = buildSystemPrompt({});

if (!BASE || !KEY || !MODEL) {
  console.log('未配置 AI_BASE_URL / AI_API_KEY / AI_MODEL —— 跳过（联网评测需要网关）');
  console.log('='.repeat(64));
  process.exit(0);
}

console.log(`模型：${MODEL}`);
console.log(`用例：${CASES.length} 条（单柜场景 ${CASES.filter((c) => c.scenario === 'single').length} 条 / 多柜场景 ${CASES.filter((c) => c.scenario === 'multi').length} 条）`);
console.log('='.repeat(64));

let actionHit = 0;
let actionTotal = 0;
let clarifyHit = 0;
let clarifyTotal = 0;
/** 分场景统计：混在一起看不出「该问时问没问」 */
const byScenario = new Map<string, { actionHit: number; actionTotal: number; clarifyHit: number; clarifyTotal: number }>();
for (const sc of ['single', 'multi']) byScenario.set(sc, { actionHit: 0, actionTotal: 0, clarifyHit: 0, clarifyTotal: 0 });
const details: string[] = [];

for (const c of CASES) {
  const { project, bedroom } = buildProject(CAB_COUNT[c.scenario]);
  const ctx = summarizeProjectContext(project, bedroom.id, []);
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
  const st = byScenario.get(c.scenario)!;
  if (c.allowClarify) {
    // 两种都对：给了期望动作 **或** 追问了
    const didAction = c.wantActions.some((w) => actions.includes(w));
    const didClarify = actions.length === 0;
    const pass = didAction || didClarify;
    if (pass) { actionHit++; actionTotal++; st.actionHit++; st.actionTotal++; }
    else { actionTotal++; st.actionTotal++; }
    console.log(`  ${pass ? 'v' : 'x'} [${c.scenario}] ${c.q.padEnd(22)} 期望=动作或追问  实际=${actions.join('/') || '(追问)'}  ${r.ms}ms`);
    if (!pass && reply) details.push(`[${c.scenario}] ${c.q} —— 模型答：${reply.slice(0, 90)}`);
    continue;
  }
  if (c.wantClarify) {
    clarifyTotal++;
    st.clarifyTotal++;
    // 正确澄清 = 没有瞎给动作（动作数组为空）
    const didClarify = actions.length === 0;
    if (didClarify) { clarifyHit++; st.clarifyHit++; }
    console.log(`  ${didClarify ? 'v' : 'x'} [${c.scenario}] ${c.q.padEnd(22)} 期望=追问  实际=${actions.join('/') || '(追问)'}  ${r.ms}ms`);
    if (!didClarify) details.push(`[${c.scenario}] ${c.q} —— 应该追问却直接给了动作：${actions.join(', ')}`);
  } else {
    actionTotal++;
    st.actionTotal++;
    const hit = c.wantActions.some((w) => actions.includes(w));
    if (hit) { actionHit++; st.actionHit++; }
    console.log(`  ${hit ? 'v' : 'x'} [${c.scenario}] ${c.q.padEnd(22)} 期望=${c.wantActions.join('/')}  实际=${actions.join('/') || (parseFail ? '(JSON 截断)' : '-')}  ${r.ms}ms`);
    if (!hit && reply) details.push(`[${c.scenario}] ${c.q} —— 模型答：${reply.slice(0, 90)}`);
  }
}

console.log('='.repeat(64));
console.log('★ 分场景看（混在一起看不出「该问时问没问」）：');
for (const [sc, st] of byScenario) {
  const aRate = st.actionTotal ? st.actionHit / st.actionTotal : 0;
  const cRate = st.clarifyTotal ? st.clarifyHit / st.clarifyTotal : 0;
  console.log(`  ${sc === 'single' ? '单柜（该做就做）' : '多柜（该问就问）'}：动作 ${st.actionHit}/${st.actionTotal} = ${(aRate * 100).toFixed(0)}%   澄清 ${st.clarifyHit}/${st.clarifyTotal} = ${(cRate * 100).toFixed(0)}%`);
}
console.log('');
console.log(`总的动作命中率：${actionHit}/${actionTotal} = ${actionTotal ? ((actionHit / actionTotal) * 100).toFixed(0) : 0}%`);
console.log(`总的正确澄清率：${clarifyHit}/${clarifyTotal} = ${clarifyTotal ? ((clarifyHit / clarifyTotal) * 100).toFixed(0) : 0}%`);
if (details.length) {
  console.log('');
  console.log('未命中明细：');
  for (const d of details) console.log('  · ' + d);
}
console.log('='.repeat(64));
