#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════════════════
 *  变异测试：Agent 五项改进（2026-10-21）
 *
 *  ── 为什么必须有这个 ──
 *    本项目的铁律：**每条断言都要变异测试过**。
 *    没变异过的断言可能恒真 —— 它看起来在保护某个能力，
 *    实际上那个能力坏了它也不会响。
 *
 *    第一版 prompt-trim 验收就栽在这：
 *    它在测试里**重新实现**了一遍 replace(/\./g,'_')，
 *    然后断言自己的实现是对的 —— 证明的只是「replace 能用」。
 *
 *  ── 第二版的教训（本文件自己撞上的）──
 *    第一版验收里有一批**源码扫描**断言（agentSrc.includes('units.length')）。
 *    变异测试立刻打脸：把 units.map() 改成空数组，
 *    源码里 units.length 还在，断言照样绿 —— 它根本没在守行为。
 *    所以第二版把这些改成了**直接调用**被测函数的**行为断言**。
 *
 *  ── 怎么做 ──
 *    每个变异 = 故意把实现改坏 → 跑验收 → 必须变红 → 改回来。
 *    变绿就说明这条断言没在守它该守的东西。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..');

const TARGETS = {
  recipes: join(appDir, 'shared', 'recipes.mjs'),
  retrieval: join(appDir, 'shared', 'ruleRetrieval.mjs'),
  sequence: join(appDir, 'shared', 'sequenceStore.mjs'),
  contract: join(appDir, 'shared', 'aiContract.mjs'),
  agent: join(appDir, 'server', 'agentLoop.mjs'),
  server: join(appDir, 'server', 'server.mjs'),
  serverseq: join(appDir, 'server', 'sequenceStore.mjs'),
};

let pass = 0;
let fail = 0;
const failures = [];

function runAcceptance() {
  try {
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', join(here, 'agent-smart-acceptance.ts')],
      { cwd: appDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const m = out.match(/失败 (\d+) 项/);
    const names = [...out.matchAll(/^  ✗ (.+)$/gm)].map((x) => x[1]);
    return { count: m ? Number(m[1]) : 0, names };
  } catch (e) {
    const out = String(e?.stdout ?? '') + String(e?.stderr ?? '');
    const m = out.match(/失败 (\d+) 项/);
    const names = [...out.matchAll(/^  ✗ (.+)$/gm)].map((x) => x[1]);
    return { count: m ? Number(m[1]) : 99, names };
  }
}

function mutate(label, file, from, to, expectRed) {
  const original = readFileSync(file, 'utf8');
  /**
   * ★ 锚点必须按**该文件真实的换行**去匹配 ──
   *   本项目一部分文件是 CRLF、一部分是 LF。
   *   锚点写成 LF 而目标是 CRLF ⇒ `original.includes(from)` 恒为 false，
   *   变异会「锚点不存在」而根本没测上 ——
   *   看起来是「没测」，实际是「测了个寂寞」。
   */
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const fromReal = from.replace(/\n/g, eol);
  const toReal = to.replace(/\n/g, eol);
  if (!original.includes(fromReal)) {
    fail++;
    failures.push(label + '（变异锚点找不到，源码可能变了）');
    console.log(`  ✗ ${label} — 锚点不存在，测不了`);
    return;
  }
  try {
    writeFileSync(file, original.replace(fromReal, toReal), 'utf8');
    const r = runAcceptance();
    const red = r.count > 0;
    const caught = red && r.names.some((n) => n.includes(expectRed));
    if (caught) {
      pass++;
      console.log(`  ✓ ${label} → ${r.count} 条变红（含「${expectRed}」）`);
    } else {
      fail++;
      failures.push(label + (red ? '（红了但没红在预期断言上：' + r.names.join('|') + '）' : '（变异后仍然全绿 —— 断言没守住）'));
      console.log(`  ✗ ${label} — ${red ? '红了但红错了地方' : '仍然全绿，断言没守住'}`);
    }
  } finally {
    writeFileSync(file, original, 'utf8');
  }
}

/**
 * ★ 安全网：跑之前把所有目标文件备份一份，跑完无条件还原。
 *   （第一版没做这个：某个变异把文件改坏后脚本崩了，
 *    还原没执行，结果源码被留在坏状态 —— 我为此丢了 2388 行 server.mjs。）
 */
const BACKUP = {};
for (const [k, f] of Object.entries(TARGETS)) BACKUP[k] = readFileSync(f, 'utf8');
function restoreAll() {
  for (const [k, f] of Object.entries(TARGETS)) {
    try { writeFileSync(f, BACKUP[k], 'utf8'); } catch { /* 尽力而为 */ }
  }
}
process.on('exit', restoreAll);
process.on('SIGINT', () => { restoreAll(); process.exit(130); });
process.on('uncaughtException', (e) => {
  console.error('变异脚本异常：' + (e?.message ?? e));
  restoreAll();
  process.exit(1);
});

console.log('变异测试：Agent 五项改进');
console.log('='.repeat(64));
console.log('\n每条变异 = 故意改坏实现 → 验收必须变红 → 自动还原');

// ── 1. 配方 ──
console.log('\n1. 配方注入');
mutate('配方不再注入提示词', TARGETS.contract,
  "  const recipeBlock = recipeBlockFor(options.focusText);",
  "  const recipeBlock = '';",
  '【标准做法】');
mutate('配方命中逻辑失效（恒不命中）', TARGETS.recipes,
  "  if (hay.includes(kw)) {",
  "  if (false) {",
  '命中');
mutate('泛用配方不再受创建语义约束', TARGETS.recipes,
  "  if (recipe.generic === true && !isBuildIntent(hay)) return 0;",
  "  if (false) return 0;",
  '不命中');
mutate('泛用配方不再排在具体配方后面', TARGETS.recipes,
  "  if (recipe.generic === true) score *= 0.6;",
  "  if (false) score *= 0.6;",
  '具体配方排在泛用配方前面');

// ── 2. 纠正记忆检索 ──
console.log('\n2. 纠正记忆检索');
mutate('常驻规则不再常驻（scope=rule 也走情境）', TARGETS.retrieval,
  "  if (rule.scope === 'rule') return true;",
  "  if (false) return true;",
  '常驻');
mutate('否定式硬话不再常驻', TARGETS.retrieval,
  "  return /不许|不能|永远|任何|都不|禁止|不得/.test(nl);",
  "  return false;",
  '常驻');
mutate('检索阈值提到不可能（等于不检索）', TARGETS.retrieval,
  "    .filter((x) => x.score >= threshold)",
  "    .filter((x) => x.score >= 1e9)",
  '命中');
mutate('检索不排除无关规则（全部返回）', TARGETS.retrieval,
  "  const matched = scored.slice(0, max).map((x) => x.rule);",
  "  const matched = all.filter((r) => !isAlwaysRule(r));",
  '没有');
mutate('渲染不再过滤空条目（留下空标题壳）', TARGETS.retrieval,
  "    if (!text) continue;",
  "    if (false) continue;",
  '空串');
mutate('★ 服务端整包塞（不再检索）', TARGETS.server,
  "  return selectProjectRules(activeProjectRules(), text);",
  "  return activeProjectRules();",
  '服务端确实调的是 selectProjectRules');

// ── 3. 操作序列复用 ──
console.log('\n3. 操作序列复用');
mutate('删除类被加入可重放白名单', TARGETS.sequence,
  "  'cad.place_cabinet',",
  "  'cad.place_cabinet',\n  'cad.delete_object',",
  'delete_object 不可重放');
mutate('指纹忽略数字（宽600 = 宽800）', TARGETS.sequence,
  "    .replace(/[\\s,，。.!！?？、;；:：~～]/g, '')",
  "    .replace(/[\\s,，。.!！?？、;；:：~～]/g, '').replace(/[0-9]+/g, '')",
  '不同数字');
mutate('★ 重放时沿用旧 draftId（污染原草稿）', TARGETS.agent,
  "    delete args.draftId;",
  "    void args;",
  '不带旧 draftId');
mutate('★ 重放失败不丢弃草稿（留半截改动）', TARGETS.agent,
  "      if (discardTarget) {",
  "      if (false) {",
  '丢弃了草稿');
mutate('★ 重放失败不查草稿列表（首步失败会漏草稿）', TARGETS.agent,
  "      if (!discardTarget) {",
  "      if (false) {",
  '孤儿草稿');
mutate('提取重放步骤时不过滤失败步骤', TARGETS.sequence,
  "    if (!s || s.ok !== true) continue;",
  "    if (!s) continue;",
  '只提取成功');
mutate('重放不补房间（新柜跑到别的房间）', TARGETS.agent,
  "    if (s.tool === 'cad.create_cabinet' && roomId && !args.roomId && !args.roomName) {",
  "    if (false) {",
  '补上房间');

// ── 4. 当前方案摘要（行为）──
console.log('\n4. 当前方案摘要');
mutate('★ 摘要不再带分区结构', TARGETS.agent,
  "          unitStr = `，${units.length} 个分区（${parts.join('、')}）`;",
  "          unitStr = '';",
  '分区数量');
mutate('★ 摘要不再带上一轮改了什么', TARGETS.agent,
  "  if (lastSummary) {",
  "  if (false) {",
  '上一轮做了什么');
mutate('摘要不再进系统提示词', TARGETS.agent,
  "${projectContextText ? `${projectContextText}\\n` : ''}",
  "",
  'projectContextText');

// ── 5. 错误信息带建议（行为）──
console.log('\n5. 错误信息带建议');
mutate('数字越界不再给常用值', TARGETS.contract,
  "  if (parts.length === 0) return '';",
  "  if (true) return '';",
  '常用值');
mutate('缺参不再说明参数形状', TARGETS.contract,
  "        const shapes = missing.map((rk) => { const sp = declared[rk]; if (!sp) return rk; const dd = describeParam(rk, sp, spec); return rk + '(' + dd + ')'; });",
  "        const shapes = [];",
  '参数说明');
mutate('枚举报错不再说原样挑一个', TARGETS.contract,
  "。请从上面这些值里**原样挑一个**（不要自己造词），再调用一次。`;",
  "。`;",
  '原样挑一个');
mutate('多余参数不再列合法参数名', TARGETS.contract,
  "。这个动作只接受：${Object.keys(declared).join('、') || '（无参数）'}。请删掉多余参数再调用。` };",
  "。这个动作有固定的参数集。请删掉多余参数再调用。` };",
  '合法参数名');
mutate('★ 工具失败不再带 hint', TARGETS.agent,
  "            : { error: result.error, code: result.code, hint: failureHint(result.error, result.code) },",
  "            : { error: result.error, code: result.code },",
  'hint');
mutate('★ failureHint 不再给重叠提落位建议', TARGETS.agent,
  "        return '这个位置放不下。改用语义落位（cad.place_cabinet 交给 placement 引擎算位置），或先挪开冲突的柜子，不要硬给 x/y。';",
  "        return '';",
  '语义落位建议');
mutate('★ failureHint 未知工具分支被合并掉', TARGETS.agent,
  "      return '这个工具名不存在。只能用 cad.create_cabinet / cad.place_cabinet / cad.update_object / cad.delete_object / cad.create_room / cad.draw_wall / cad.create_assembly / cad.duplicate_object / cad.validate / cad.get_state / cad.list_drafts。';",
  "      return '参数形状不对。按工具声明的 schema 重新组织参数（只放声明里有的键）。';",
  '未知工具提示里列出了');

// ── 6. 回归 ──
console.log('\n6. 回归');
mutate('动作清单被裁掉（只留 5 条）', TARGETS.contract,
  "  for (const [name, spec] of Object.entries(ACTIONS)) {",
  "  for (const [name, spec] of Object.entries(ACTIONS).slice(0, 5)) {",
  '动作清单里有');


// ── 7. 端到端实测抓出来的 bug ──
console.log('\n7. 端到端实测抓出来的 bug');
mutate('★ 服务端把 Set 当数组（families 永远为空）', TARGETS.server,
  "  return f instanceof Set ? [...f] : Array.isArray(f) ? [...f] : [];",
  "  return Array.isArray(f) ? [...f] : [];",
  '服务端那行真的用了 Set 分支');
mutate('★ 重放用裸的 replaySeq 变量（运行时会 undefined）', TARGETS.agent,
  "    const replay = await replaySequence(opts.replaySeq, {",
  "    const replay = await replaySequence(replaySeq, {",
  '重放调用从 opts.replaySeq 取');
// ── 还原后复跑 ──
// ── 8. 相似度匹配（2026-10-21）──
console.log('\n8. 相似度匹配');
mutate('★ 相似度恒为 0（什么都不像）', TARGETS.sequence,
  "  if (inter === 0) return 0;",
  "  if (inter === 0) return 0; return 0;",
  '高于阈值');
mutate('★ 阈值拦不住（低于阈值也返回）', TARGETS.sequence,
  "    if (similarity < threshold) continue;",
  "    if (false) continue;",
  '同族但内容不像时**不返回**');
mutate('★ 相似度比较不看内容（只看类型）', TARGETS.sequence,
  "    const similarity = similarityOf(seq, intent);",
  "    const similarity = 1;",
  '同族但内容不像时**不返回**');
mutate('★ 删除类序列不再被拦（安全底线）', TARGETS.sequence,
  "    if (!canReplay(seq.steps).ok) continue;",
  "    if (false) continue;",
  '含删除类的序列不会被选为范例');
mutate('★ 动作族闸门失效（建柜序列给改尺寸用）', TARGETS.sequence,
  "    if (!sf.some((f) => fam.has(f))) continue;",
  "    if (false) continue;",
  '动作族不匹配时不返回');
mutate('★ 尺寸数字不区分了（宽600 ≈ 宽800）', TARGETS.sequence,
  "      out += dimensionMarker(num);",
  "      out += num;",
  '「宽600」vs「宽800」**不**折叠');

/**
 * ★ 下面三个变异守的是**实测抓出来的真 bug**。
 *
 *   早先的实现在遇到数字时直接跳到数字处，把数字**前面**的文字吞了：
 *   「建个衣柜宽600」只剩一个尺寸标记，和「做3个吊柜宽600」剩下的东西
 *   一模一样 ⇒ 相似度 1.0 —— 两个完全不同的任务被判成同一件事。
 *
 *   ★ 为什么这类 bug 逃过了验收 ──
 *   当时的断言只测了「宽600」vs「宽800」这种**只有数字不同**的样本，
 *   而它们的比较文本碰巧一样，测不出前缀被吞。
 *   必须补上「**前缀不同**、数字相同」的样本才测得出来。
 */
mutate('★ 数字前面的文字被吞了（不同任务被判成相似）', TARGETS.sequence,
  "    out += base.slice(i, start);",
  "    out += '';",
  '带尺寸的不同任务');
/**
 * ★ 私用区标记退化成裸数字 ──
 *   「#600#」这种写法仍会共享 bigram「00」，
 *   两个只有前缀不同的任务会重新撞在一起。
 *   这条变异守的是「尺寸必须按值区分」。
 */
mutate('★ 私用区标记退化成裸数字（宽600 与 做3个吊柜宽600 又撞上）', TARGETS.sequence,
  "      out += dimensionMarker(num);",
  "      out += num;",
  '「宽600」vs「宽800」**不**折叠');
/**
 * ★ 私用区标记失去区分度（所有数字共用一个标记）──
 *   所有尺寸都变成同一个标记 ⇒ 「宽600」与「宽800」不再有区别。
 */
mutate('★ 私用区标记失去区分度（所有数字共用一个标记）', TARGETS.sequence,
  "  return String.fromCharCode(PUA_BASE + lo, PUA_BASE + hi);",
  "  return String.fromCharCode(PUA_BASE, PUA_BASE + 1);",
  '「宽600」vs「宽800」**不**折叠');
/**
 * ★ 计数不再折叠（「建一个衣柜」与「建个衣柜」不再等价）──
 *   单独一条：守的是「计数折叠」这个能力本身。
 */
mutate('★ 计数不再折叠（一个 ≡ 个）', TARGETS.sequence,
  "    const isCount = countSpans.some(([s, e]) => start >= s && start < e);",
  "    const isCount = false;",
  '计数被折叠');

/**
 * ★ 服务端那层的变异 ──
 *   共享函数测得再好，服务端那层如果还按老办法「取最近一条」，
 *   照样会把不相关的范例塞进提示词 —— 必须单独钉住。
 */
mutate('★ 服务端不按相似度筛（退回「取最近一条」）', TARGETS.serverseq,
  "    const matched = matchSequences(pool, intent, families, threshold === undefined ? {} : { threshold });",
  "    const matched = pool.filter((s) => Array.isArray(s.families) && s.families.some((f) => fam.has(f))).slice(0, 1);",
  '服务端 findSimilar 低于阈值时返回 null');
mutate('★ 服务端不再排除不可重放的序列（删除类序列能进候选池）', TARGETS.serverseq,
  "    .filter((s) => canReplay(s.steps).ok);",
  "    .filter((s) => true);",
  '降级路径（无 intent）也不会返回含删除类的序列');
mutate('★ 序列选择入口不再把意图原话传下去（退回「最近一条」）', TARGETS.serverseq,
  "  const similar = findSimilar(path, families, key, intent, limit);",
  "  const similar = findSimilar(path, families, key, '', limit);",
  '完全不同的意图一条候选都不给（不会退化成「取最近一条」）');
mutate('★ 序列选择入口不再用 .env 的阈值（写死默认）', TARGETS.serverseq,
  "  const limit = threshold === undefined ? similarityThresholdFor(env) : threshold;",
  "  const limit = threshold === undefined ? resolveSimilarityThreshold(undefined) : threshold;",
  '阈值从 .env 一路生效（收紧后同义改写也不够格了）');
mutate('★ 序列选择入口不再查相似范例（只剩重放）', TARGETS.serverseq,
  "  const similar = findSimilar(path, families, key, intent, limit);",
  "  const similar = null;",
  'pickSequences 换说法时给的是范例而不是重放');




console.log('\n' + '-'.repeat(64));
const final = runAcceptance();
if (final.count === 0) {
  pass++;
  console.log('  ✓ 还原后验收恢复全绿');
} else {
  fail++;
  failures.push('还原后验收没有恢复全绿（仍有 ' + final.count + ' 项失败）');
  console.log('  ✗ 还原后验收没有恢复全绿：' + final.names.join(' | '));
}

console.log('='.repeat(64));
if (fail === 0) {
  console.log(`变异测试：通过 ${pass} 项，失败 0 项`);
  console.log('每个变异都被对应断言抓住 —— 断言是真的在守东西。');
} else {
  console.log(`变异测试：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));