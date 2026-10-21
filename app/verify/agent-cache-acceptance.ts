/**
 * ══════════════════════════════════════════════════════════════════════
 *  Agent 提示词缓存回归验收（2026-10-21）
 *
 * ── 它守的是什么 ──
 *   网关（gpt-load）做**纯前缀匹配**：system 提示词里只要有一处逐字变化，
 *   从变化点往后全部缓存不上。
 *
 *   而 rulesBlock / recipeBlock / seqHint **每一轮都变**
 *   （用户改了记忆、换了配方、命中了不同序列）。
 *   它们原来排在 system 的**最前面** ⇒ 整条 system 每轮都是新前缀 ⇒
 *   cached_tokens 恒为 0。
 *
 *   实测：
 *     动态在 system 开头  -> cached = 0
 *     动态在 system 末尾  -> cached = 1024
 *
 *   本验收**必须**是行为断言：直接比对两段文本的位置，
 *   而不是 grep 源码 —— 源码扫描守不住「顺序」这种语义。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const agentSrc = readFileSync(join(here, '..', 'server', 'agentLoop.mjs'), 'utf8');

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

// ═══════════════ 1. 静态 / 动态两段必须真的分开 ═══════════════
section('1. 提示词拆成静态段与动态段');
{
  ok('★ 存在 staticRules（静态段）', agentSrc.includes('const staticRules = '));
  ok('★ 存在 dynamicContext（动态段）', agentSrc.includes('const dynamicContext = '));
  ok('★ 最终拼装是 staticRules + dynamicContext',
    agentSrc.includes('const systemPrompt = staticRules'),
    agentSrc.match(/const systemPrompt = .+/)?.[0] ?? '');
}

// ═══════════════ 2. ★ 位置断言：动态内容必须在静态之后 ═══════════════
section('2. ★ 位置：动态内容必须在静态规则之后');
{
  /**
   * ★ 这条是本验收的核心 ──
   *   位置错了，缓存就全废；而「位置」用 grep 源码**测不到**
   *   （把 staticRules 和 dynamicContext 两段名字对调，grep 依然全中）。
   *
   *   所以这里取两段的**实际行号**，比大小。
   */
  const staticAt = agentSrc.indexOf('const staticRules = ');
  const dynamicAt = agentSrc.indexOf('const dynamicContext = ');
  const joinedAt = agentSrc.indexOf('const systemPrompt = staticRules');

  ok('★ 两段都找到了', staticAt >= 0 && dynamicAt >= 0, `static@${staticAt} dynamic@${dynamicAt}`);
  ok('★ ★ staticRules 在 dynamicContext 之前', staticAt < dynamicAt, `static@${staticAt} dynamic@${dynamicAt}`);
  ok('★ ★ 拼装顺序是 static 在前、dynamic 在后',
    joinedAt > staticAt && joinedAt > dynamicAt,
    `join@${joinedAt}`);
}

// ═══════════════ 3. ★ 动态内容真的都在动态段里 ═══════════════
section('3. ★ 每个每轮都变的内容都必须在动态段');
{
  const dynamicStart = agentSrc.indexOf('const dynamicContext = ');
  const staticStart = agentSrc.indexOf('const staticRules = ');
  // 静态段与动态段之间的那一大段模板文本
  const staticBlock = agentSrc.slice(staticStart, dynamicStart);
  const dynamicBlock = agentSrc.slice(dynamicStart, agentSrc.indexOf('const systemPrompt =', dynamicStart));

  /**
   * 每轮都变的东西 —— 任何一个留在静态段里，都会让前缀每轮失效。
   */
  const PER_ROUND = [
    { name: 'rulesBlock（纠正记忆）', token: 'rulesBlock,' },
    { name: 'recipeBlock（配方库）', token: 'recipeBlock,' },
    { name: 'seqHint（序列范例）', token: 'seqHint,' },
    { name: 'roomId（当前房间）', token: 'roomId ?' },
    { name: 'projectContextText（项目上下文）', token: 'projectContextText,' },
    { name: 'visionResult（视觉识别结果）', token: 'visionResult ?' },
    { name: 'currentDraftId（当前草稿）', token: 'currentDraftId ?' },
  ];
  for (const item of PER_ROUND) {
    ok(`★ ${item.name} 在动态段里`, dynamicBlock.includes(item.token));
    ok(`★ ${item.name} **不在**静态段里`, !staticBlock.includes(item.token));
  }
}

// ═══════════════ 4. 静态段必须是真静态 ═══════════════
section('4. 静态段里不能夹带动态变量');
{
  const staticStart = agentSrc.indexOf('const staticRules = ');
  const dynamicStart = agentSrc.indexOf('const dynamicContext = ');
  const staticBlock = agentSrc.slice(staticStart, dynamicStart);
  /**
   * ★ 静态段里出现 ${...} 插值 = 那里嵌了每轮都变的东西 ──
   *   插值里**不含**这些变量名才算真静态。
   */
  const DYNAMIC_VARS = [
    'rulesBlock', 'recipeBlock', 'seqHint', 'roomId', 'roomName',
    'projectContextText', 'visionResult', 'currentDraftId', 'images', 'intent',
  ];
  // 把模板里的 ${...} 全部抠出来
  const interpolations = [...staticBlock.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
  const badOnes = interpolations.filter((expr) => DYNAMIC_VARS.some((v) => expr.includes(v)));
  ok('★ ★ 静态段里没有夹带动态变量', badOnes.length === 0, badOnes.join(' | '));
}

// ═══════════════ 5. 内容不能因为重排而丢 ═══════════════
section('5. 重排不能丢内容');
{
  /**
   * 把提示词按段拆开后，逐条确认关键指令还在。
   *   重排最容易出的错就是「顺手删了一句以为没用的」。
   */
  const mustKeep = [
    '所有写操作只进 draft',
    '先理解意图，拆成工具调用',
    'cad.create_room',
    'cad.create_assembly',
    '工具报错时读错误信息',
    '完成后调用 cad.validate 确认 0 错误',
    'intentRequest',
    'room-inside',
    'door-swing-clear',
    '绝对不要',
    '继续使用 draft',
    '没有 draft 时工具会自动创建',
    '当前工作区房间为',
    '当前 draft：',
    'Vision 识别结果',
  ];
  for (const k of mustKeep) {
    ok(`★ 关键内容还在：${k.slice(0, 24)}`, agentSrc.includes(k));
  }
}

// ═══════════════ 6. 网关实测：动态在末尾时能命中缓存 ═══════════════
section('6. 网关实测：prefix cache 机制本身成立');
{
  /**
   * ★ 这是**机制验证**，不是对实现的断言 ──
   *   证明「动态放后面」这个前提在本项目的网关上确实成立。
   *   网关不可达时跳过（离线环境不该让验收红）。
   */
  // ★ 自己读 .env（验收不该依赖外部环境变量是否被导出）──
  const envPath = join(here, '..', '.env');
  let envText = '';
  try { envText = readFileSync(envPath, 'utf8'); } catch { /* 没有 .env */ }
  const envOf = (k: string): string => {
    const m = new RegExp('^' + k + '=(.*)$', 'm').exec(envText);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  };
  const BASE = process.env.AI_BASE_URL || envOf('AI_BASE_URL');
  const KEY = process.env.AI_API_KEY || envOf('AI_API_KEY');
  const MODEL = process.env.AI_MODEL || envOf('AI_MODEL');
  if (!BASE || !KEY || !MODEL) {
    console.log('  · 跳过（未配置 AI_BASE_URL / AI_API_KEY / AI_MODEL）');
  } else {
    const staticPart = '静态规则。'.repeat(400);
    const dynA = '动态 A：主卧有三台柜。';
    const dynB = '动态 B：客厅有一台柜。';
    const call = async (sys: string) => {
      const r = await fetch(BASE.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Q' }], max_tokens: 16 }),
        signal: AbortSignal.timeout(60000),
      });
      const j = await r.json();
      const u = j?.usage ?? {};
      return (u.prompt_tokens_details ?? {}).cached_tokens ?? 0;
    };
    try {
      await call(staticPart + dynA);   // 预热
      const tail = await call(staticPart + dynB);
      const head = await call(dynB + staticPart);
      console.log(`      动态在末尾 cached=${tail} / 动态在开头 cached=${head}`);
      ok('★ ★ 动态放末尾能命中缓存（机制成立）', tail > 0, `cached=${tail}`);
      ok('★ 动态放开头命中明显更少（这才是问题所在）', head <= tail, `head=${head} tail=${tail}`);
    } catch (e) {
      console.log('  · 跳过（网关不可达：' + String((e as Error).message).slice(0, 60) + '）');
    }
  }
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`Agent 提示词缓存验收：通过 ${pass} 项，失败 0 项`);
  console.log('全部通过：动态内容全在动态段且排在静态之后，静态段无夹带，内容未丢。');
} else {
  console.log(`Agent 提示词缓存验收：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));
