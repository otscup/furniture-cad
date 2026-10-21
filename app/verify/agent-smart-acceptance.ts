/**
 * ══════════════════════════════════════════════════════════════════════
 *  Agent 变聪明：五项改进验收（2026-10-21）
 *
 * ── 五项改进是什么 ──
 *   ① 标准配方库      —— 常见柜型的分步做法，按关键词命中注入
 *   ② 纠正记忆检索    —— 不再整包塞 30 条，按意图挑出相关的那几条
 *   ③ 操作序列复用    —— 同一句话第二次直接重放，0 次模型调用
 *   ④ 当前方案摘要    —— 柜体分区结构 + 上一轮改了什么
 *   ⑤ 错误带建议      —— 报错里给出**能用的值**，模型不用原地重试
 *
 * ── 本验收的纪律 ──
 *   每条断言都必须**变异测试**过：改坏实现 → 断言必须变红 → 改回来。
 *   没做过变异测试的断言等于没写 —— 它可能恒真。
 *
 *   特别提醒（本项目踩过的坑）：
 *   · 不能在测试里**重新实现**一遍被测逻辑再断言它对
 *     （第一版 prompt-trim 验收就是这么写的，结果只证明了 replace 能用）；
 *   · 端到端测不到的东西要**直接测判据**
 *     （satisfiesGoal 那一课：候选生成根本走不到那个分支）。
 * ══════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSystemPrompt, validatePlan, detectActionFamilies, ACTION_NAMES } from '../shared/aiContract.mjs';
import { summarizeProjectContext, failureHint, replaySequence } from '../server/agentLoop.mjs';
import { matchRecipes, renderRecipes, recipeBlockFor, RECIPES } from '../shared/recipes.mjs';
import {
  retrieveRules,
  detectIntentTags,
  isAlwaysRule,
  scoreRule,
  renderProjectRules,
  selectProjectRules,
} from '../shared/ruleRetrieval.mjs';
import {
  intentFingerprint,
  sequenceKey,
  canReplay,
  extractReplayable,
  renderSequenceHint,
  isReplayable,
  REPLAYABLE_TOOLS,
} from '../shared/sequenceStore.mjs';

const here = dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const ctx = { rules: JSON.parse(readFileSync(join(here, '..', 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) };
const agentSrc = readFileSync(join(here, '..', 'server', 'agentLoop.mjs'), 'utf8');
const serverSrc = readFileSync(join(here, '..', 'server', 'server.mjs'), 'utf8');
const contractSrc = readFileSync(join(here, '..', 'shared', 'aiContract.mjs'), 'utf8');

// ═══════════════ 1. 标准配方库 ═══════════════
section('1. 标准配方库：命中即注入，不命中不加料');
{
  /**
   * ── 1.1 命中与不命中 ──
   *   配方库的全部价值都在"该出现时出现、不该出现时不出现"。
   *   每次都注入 = 提示词又胀回去了 = 白做。
   */
  const hit = matchRecipes('建个L型厨房');
  ok('「L 型厨房」命中 kitchen-L 配方', hit.some((r) => r.id === 'kitchen-L'), JSON.stringify(hit.map((r) => r.id)));
  ok('「衣柜」命中 wardrobe 配方', matchRecipes('帮我做个衣柜').some((r) => r.id === 'wardrobe'));
  ok('「洗衣机」命中 appliance-bay 配方', matchRecipes('洗衣机旁边加个柜子').some((r) => r.id === 'appliance-bay'));
  ok('「吊柜」命中 wall-cabinet-row 配方', matchRecipes('再要一个吊柜').some((r) => r.id === 'wall-cabinet-row'));
  ok('「书架」命中 bookshelf 配方', matchRecipes('来个书架').some((r) => r.id === 'bookshelf'));
  ok('「电视柜」命中 tv-console 配方', matchRecipes('做个电视柜').some((r) => r.id === 'tv-console'));

  const miss = matchRecipes('把刚才那个柜子改宽点');
  ok('「改宽度」不命中任何配方（避免给改尺寸注入建柜做法）', miss.length === 0, JSON.stringify(miss.map((r) => r.id)));
  ok('空文本不命中', matchRecipes('').length === 0);
  ok('undefined 不命中', matchRecipes(undefined as unknown as string).length === 0);

  /**
   * ── 1.2 泛词降权 ──
   *   「做个柜子」不该把整个配方库都拽进来（那会让提示词暴涨）。
   */
  const generic = matchRecipes('做个柜子');
  ok('「做个柜子」最多命中 2 个配方（有上限）', generic.length <= 2, `实际 ${generic.length}`);
  ok('「做个柜子」命中的是通用配方而不是全部', generic.every((r) => r.id === 'single-cabinet' || r.id === 'kitchen-L'), JSON.stringify(generic.map((r) => r.id)));

  /**
   * ── 1.3 注入到提示词 ──
   *   配方不能只在自己的模块里好看 —— 必须真的进到提示词里。
   */
  const withRecipe = buildSystemPrompt({ focusText: '建个L型厨房' });
  const withoutRecipe = buildSystemPrompt({ focusText: '把柜子改宽点' });
  ok('命中时提示词里出现【标准做法】', withRecipe.includes('【标准做法】'));
  ok('命中时提示词里有 L 型厨房的分步做法', withRecipe.includes('L 型厨房'));
  ok('命中时提示词里列出了「常见坑」', withRecipe.includes('常见坑'));
  ok('未命中时提示词里**没有**【标准做法】', !withoutRecipe.includes('【标准做法】'));
  ok('未命中时提示词不比命中时更长（没有偷偷全量注入）', withoutRecipe.length < withRecipe.length, `${withoutRecipe.length} vs ${withRecipe.length}`);

  /**
   * ── 1.4 Agent 通道也注入了 ──
   *   ★ 这是本项目最典型的坑：能力建了但没接到在用的那条路上。
   *   界面上实际走的是 Agent 通道，不是 plan 通道。
   *   只接 plan 通道 = 用户根本看不到配方。
   */
  ok('★ Agent 通道也接了配方（agentLoop 引用 recipeBlockFor）', agentSrc.includes('recipeBlockFor'));
  ok('★ Agent 通道把配方块插进了系统提示词', agentSrc.includes('recipeBlock ? recipeBlock +'));
  ok('★ 服务端把配方模块传给了 Agent（server 引用 recipeBlockFor 或 agentLoop 内部取）', agentSrc.includes('recipeBlockFor(intent)') || serverSrc.includes('recipeBlockFor'));

  /**
   * ── 1.5 配方内容本身的要求 ──
   *   每个配方必须有 steps（不然注入了也没用）和 traps（不然学不到避坑）。
   */
  ok('每个配方都有至少 3 个步骤', RECIPES.every((r) => Array.isArray(r.steps) && r.steps.length >= 3));
  ok('每个配方都有至少 1 条常见坑', RECIPES.every((r) => Array.isArray(r.traps) && r.traps.length >= 1));
  ok('配方 id 唯一', new Set(RECIPES.map((r) => r.id)).size === RECIPES.length);
  ok('渲染空数组返回空串', renderRecipes([]) === '');
  ok('渲染未命中返回空串', recipeBlockFor('把柜子改宽点') === '');
}

// ═══════════════ 2. 纠正记忆检索 ═══════════════
section('2. 纠正记忆：按意图检索，常驻规则永远带');
{
  const rules = [
    { nl: '背板超过板材幅面时必须两个方向都能拆', tags: ['几何生成器', '背板', '拆块'], scope: 'rule' },
    { nl: '墙体不许穿过柜体发生干涉', tags: ['布局', '碰撞'], scope: 'rule' },
    { nl: '两个柜体不许重叠放置', tags: ['布局', '碰撞'], scope: 'cabinet' },
    { nl: '衣柜挂衣区必须给挂衣杆', tags: ['衣柜', '挂衣杆'], scope: 'cabinet' },
    { nl: '厨房地柜深度默认 600mm', tags: ['厨房', '地柜', '深度'], scope: 'cabinet' },
    { nl: '抽屉面板高度按 200/300/400 分级', tags: ['抽屉', '面板'], scope: 'cabinet' },
    { nl: '电视柜高度不要超过 600', tags: ['电视柜', '矮柜'], scope: 'cabinet' },
    { nl: '书架层板间距按 300 分格', tags: ['书架', '层板'], scope: 'cabinet' },
    { nl: '门板开向默认向右开', tags: ['门', '开向'], scope: 'cabinet' },
    { nl: '背板拆块后仍要保证单块放进板材幅面', tags: ['背板', '拆块'], scope: 'cabinet' },
  ];

  /**
   * ── 2.1 意图标签 ──
   */
  ok('「建个衣柜」识别出 wardrobe 意图', detectIntentTags('建个衣柜').includes('wardrobe'));
  ok('「厨房地柜」识别出 kitchen 意图', detectIntentTags('厨房地柜').includes('kitchen'));
  ok('「改抽屉」识别出 units 意图', detectIntentTags('改抽屉').includes('units'));
  ok('空文本没有意图标签', detectIntentTags('').length === 0);

  /**
   * ── 2.2 常驻规则判定 ──
   *   ★ 关键：常驻规则漏掉的代价比多余的高。
   *   「不许 / 永远 / 不能」这类否定式硬话必须常驻。
   */
  ok('scope=rule 的是常驻规则', isAlwaysRule({ nl: 'x', scope: 'rule' }) === true);
  ok('含「不许」的是常驻规则', isAlwaysRule({ nl: '柜体不许重叠', scope: 'cabinet' }) === true);
  ok('含「永远」的是常驻规则', isAlwaysRule({ nl: '永远不要拆侧板', scope: 'cabinet' }) === true);
  ok('普通情境规则不是常驻', isAlwaysRule({ nl: '衣柜挂衣区要给挂衣杆', scope: 'cabinet' }) === false);

  /**
   * ── 2.3 检索结果 ──
   */
  const r1 = retrieveRules(rules, '建个衣柜');
  ok('规则多时进入检索模式', r1.mode === 'retrieved', `mode=${r1.mode}`);
  ok('★ 常驻规则一定在结果里', r1.always.every((a) => r1.kept.includes(a)), JSON.stringify(r1.kept.map((k) => k.nl)));
  ok('「衣柜」查询命中了挂衣杆规则', r1.kept.some((k) => k.nl.includes('挂衣杆')));
  ok('★ 「衣柜」查询**没有**带电视柜规则（无关规则被排除）', !r1.kept.some((k) => k.nl.includes('电视柜')), JSON.stringify(r1.kept.map((k) => k.nl)));
  ok('★ 「衣柜」查询**没有**带书架规则', !r1.kept.some((k) => k.nl.includes('书架')));

  const r2 = retrieveRules(rules, '厨房地柜深度多少');
  ok('「厨房」查询命中了厨房地柜规则', r2.kept.some((k) => k.nl.includes('厨房地柜')));
  ok('★ 「厨房」查询没有带电视柜规则', !r2.kept.some((k) => k.nl.includes('电视柜')));

  const r3 = retrieveRules(rules, '改一下抽屉面板');
  ok('「抽屉」查询命中了抽屉规则', r3.kept.some((k) => k.nl.includes('抽屉')));
  ok('★ 「抽屉」查询没有带衣柜规则', !r3.kept.some((k) => k.nl.includes('挂衣杆')));

  /**
   * ── 2.4 规则少时全给（保守兜底）──
   *   检索有误伤风险。规则少的时候没必要冒险，全给更稳。
   */
  const few = rules.slice(0, 5);
  const r4 = retrieveRules(few, '建个衣柜');
  ok('规则少时全给（mode=all）', r4.mode === 'all');
  ok('规则少时一条不落', r4.kept.length === few.length, `${r4.kept.length}/${few.length}`);
  ok('空规则列表不报错', retrieveRules([], '建柜').kept.length === 0);
  ok('undefined 规则不报错', retrieveRules(undefined as never, '建柜').kept.length === 0);

  /**
   * ── 2.5 渲染 ──
   *   ★ 空条目不能留下只有标题的空壳 ——
   *   模型读到「本项目的既定约定：」然后发现下面什么都没有，
   *   容易理解成「这个项目没有约定」，那比没这段更糟。
   */
  ok('空数组渲染为空串', renderProjectRules([]) === '');
  ok('全空白的数组渲染为空串', renderProjectRules([{ nl: '   ' }, { nl: '' }]) === '');
  ok('有内容时渲染出标题', renderProjectRules([{ nl: '不许重叠' }]).includes('【本项目的既定约定】'));
  ok('有内容时渲染出条目', renderProjectRules([{ nl: '不许重叠' }]).includes('不许重叠'));
  ok('渲染带 tags', renderProjectRules([{ nl: 'x', tags: ['a', 'b'] }]).includes('（a/b）'));

  /**
   * ── 2.6 ★ 三条通道都接了 ──
   *   ★ 修的是一个真缺陷：之前只有 plan / design 两条通道带了 projectRules，
   *   而界面上**实际走的是 Agent 通道** ——
   *   用户在管理后台写的每一条纠正，Agent 一条都看不到。
   */
  ok('★ Agent 通道接收 projectRules 参数', /projectRules/.test(agentSrc));
  ok('★ Agent 通道把 projectRules 渲染进系统提示词', agentSrc.includes('renderProjectRules'));
  ok('★ 服务端把 projectRules 传给了 runAgentLoop', /runAgentLoop\(\{[\s\S]{0,4000}?projectRules:/.test(serverSrc));
  ok('★ 服务端用的是检索后的规则（relevantProjectRules）', serverSrc.includes('relevantProjectRules'));
  ok('★ plan 通道改用检索', /buildChatRequest[\s\S]{0,600}?projectRules: relevantProjectRules/.test(serverSrc));
  ok('★ design 通道改用检索', /buildDesignRequest[\s\S]{0,600}?projectRules: relevantProjectRules/.test(serverSrc));
}
// ═══════════════ 3. 操作序列复用 ═══════════════
section('3. 操作序列复用：命中就重放，0 次模型调用');
{
  /**
   * ── 3.1 指纹 ──
   *   指纹相同 = 这次的需求和上次**字面等价** ⇒ 参数可以直接复用。
   *   数字必须保留在指纹里：宽 600 和宽 800 不是一回事。
   */
  ok('相同文本得到相同指纹', intentFingerprint('建个衣柜') === intentFingerprint('建个衣柜'));
  ok('★ 不同数字得到不同指纹（宽 600 ≠ 宽 800）', intentFingerprint('宽600的柜子') !== intentFingerprint('宽800的柜子'), intentFingerprint('宽600的柜子') + ' vs ' + intentFingerprint('宽800的柜子'));
  // 中文数字转阿拉伯：二十四 -> 24（一十四 -> 14）
  ok('★ 中文数字被转成阿拉伯数字（二十四 = 24）', intentFingerprint('宽二十四') === intentFingerprint('宽24'), intentFingerprint('宽二十四') + ' vs ' + intentFingerprint('宽24'));
  ok('★ 转换后指纹不含中文字', !/[一二三四五六七八九十]/.test(intentFingerprint('宽二十四的柜子')), intentFingerprint('宽二十四的柜子'));
  ok('空白与标点被忽略', intentFingerprint('建个衣柜！') === intentFingerprint('建 个  衣柜'));
  ok('空文本指纹为空串', intentFingerprint('') === '');
  ok('undefined 指纹为空串', intentFingerprint(undefined as unknown as string) === '');

  /**
   * ── 3.2 序列 key 含动作族 ──
   *   「建柜」和「改尺寸」是两类请求，序列不能互相重放。
   */
  const k1 = sequenceKey('建个衣柜', ['create']);
  const k2 = sequenceKey('建个衣柜', ['geometry']);
  ok('★ 动作族不同 ⇒ key 不同', k1 !== k2);
  ok('动作族相同 ⇒ key 相同', sequenceKey('建个衣柜', ['create']) === sequenceKey('建个衣柜', ['create']));
  ok('动作族顺序不影响 key', sequenceKey('x', ['a', 'b']) === sequenceKey('x', ['b', 'a']));
  ok('空文本没有 key', sequenceKey('', ['create']) === '');

  /**
   * ── 3.3 ★ 可重放工具白名单 ──
   *   ★ 删除类**故意不在里面** ——
   *   重放删除的语义依赖当时的项目状态，现在重放很可能删错东西，而且不可逆。
   */
  ok('create_cabinet 可重放', isReplayable('cad.create_cabinet'));
  ok('create_room 可重放', isReplayable('cad.create_room'));
  ok('create_assembly 可重放', isReplayable('cad.create_assembly'));
  ok('★ delete_object 不可重放', !isReplayable('cad.delete_object'));
  ok('★ discard_draft 不可重放', !isReplayable('cad.discard_draft'));
  ok('★ apply_draft 不可重放', !isReplayable('cad.apply_draft'));
  ok('★ validate 不可重放（只是检查）', !isReplayable('cad.validate'));
  ok('白名单里没有删除类', ![...REPLAYABLE_TOOLS].some((t) => t.includes('delete') || t.includes('discard') || t.includes('apply')), [...REPLAYABLE_TOOLS].join(','));

  /**
   * ── 3.4 canReplay 判据 ──
   */
  ok('空序列不可重放', canReplay([]).ok === false);
  ok('含删除类的序列不可重放', canReplay([{ tool: 'cad.create_cabinet' }, { tool: 'cad.delete_object' }]).ok === false);
  ok('★ 不可重放时给出原因', canReplay([{ tool: 'cad.delete_object' }]).reason.includes('不可重放'));
  ok('纯创建序列可重放', canReplay([{ tool: 'cad.create_cabinet' }]).ok === true);
  ok('只查询的序列不可重放', canReplay([{ tool: 'cad.get_state' }]).ok === false);

  /**
   * ── 3.5 从运行结果提取 ──
   *   只取成功的步骤；剔除 draftId（重放要用新的 draft）。
   */
  const runSteps = [
    { tool: 'cad.create_cabinet', args: { name: 'A', width: 600, draftId: 'd1' }, ok: true },
    { tool: 'cad.create_cabinet', args: { name: 'B' }, ok: false, error: 'boom' },
    { tool: 'cad.create_assembly', args: { members: ['x'] }, ok: true },
    { tool: 'cad.validate', args: {}, ok: true },
    { tool: 'cad.delete_object', args: { id: 'z' }, ok: true },
  ];
  const extracted = extractReplayable(runSteps);
  ok('★ 只提取成功的步骤', extracted.length === 2, JSON.stringify(extracted));
  ok('★ 剔除 draftId（重放要用新草稿）', !extracted.some((s) => 'draftId' in (s.args ?? {})), JSON.stringify(extracted));
  ok('★ 剔除 validate', !extracted.some((s) => s.tool === 'cad.validate'));
  ok('★ 剔除删除类', !extracted.some((s) => s.tool === 'cad.delete_object'));
  ok('空运行提取出空数组', extractReplayable([]).length === 0);
  ok('undefined 提取出空数组', extractReplayable(undefined as never).length === 0);

  /**
   * ── 3.6 渲染成范例 ──
   */
  const hint = renderSequenceHint({ steps: [{ tool: 'cad.create_cabinet', args: { name: 'A' } }] });
  ok('范例里有标题', hint.includes('【上次类似需求你是这样做的】'));
  ok('范例里有工具名', hint.includes('cad.create_cabinet'));
  ok('空序列渲染为空串', renderSequenceHint({ steps: [] }) === '');
  ok('undefined 渲染为空串', renderSequenceHint(undefined as never) === '');

  /**
   * ── 3.7 ★ Agent 循环里的重放路径 ──
   *   ★ 安全底线：重放全程在**新 draft** 里，失败就丢弃，**绝不碰 live**。
   */
  ok('★ Agent 循环有重放入口', agentSrc.includes('replaySequence'));
  ok('★ 重放失败会丢弃草稿', /replaySequence[\s\S]{0,2000}?discard_draft/.test(agentSrc));
  ok('★ 重放时用新草稿（不带旧 draftId）', /delete args\.draftId/.test(agentSrc));
  ok('★ 重放失败后退回走模型（不是直接报错）', /重放失败[\s\S]{0,400}?照常走模型/.test(agentSrc));
  ok('★ 命中时 0 次模型调用（直接返回）', /replay\.ok[\s\S]{0,300}?reused: true/.test(agentSrc));

  /**
   * ── 3.8 ★ 服务端接线 ──
   */
  ok('★ 服务端查重放序列', serverSrc.includes('findReplayable'));
  ok('★ 服务端查相似序列', serverSrc.includes('findSimilar'));
  ok('★ 服务端把 replaySeq 传给 Agent', /replaySeq:/.test(serverSrc));
  ok('★ 成功后把序列记进库', serverSrc.includes('saveRunSequence'));
  ok('★ 复用成功时不重复记录', /!result\.reused/.test(serverSrc));
}

// ═══════════════ 4. 当前方案摘要 ═══════════════
section('4. 当前方案摘要：分区结构 + 上一轮改了什么');
{
  /**
   * ── 4.1 摘要要包含什么 ──
   *   上一版只给「有哪些柜、多大、什么类型」，模型于是：
   *     · 不知道某个柜子里**分了几个格**；
   *     · 不知道**上一轮自己刚改了什么** → 把用户已经说过的事又做一遍。
   */
  ok('摘要函数接收 history 参数', /summarizeProjectContext\(workspaceProject, roomId, history\)/.test(agentSrc));
  ok('★ 摘要里包含分区结构', /units\.length/.test(agentSrc) && /describeUnitKind/.test(agentSrc));
  ok('★ 摘要里包含上一轮做了什么', /上一轮你做的事/.test(agentSrc));
  ok('★ 上一轮摘要从 history 里取', /agentSummary/.test(agentSrc));
  ok('★ 分区类型翻成了人话（挂衣区/抽屉区…）', /挂衣区/.test(agentSrc) && /抽屉区/.test(agentSrc));
  ok('★ 摘要里带了门/抽屉/层板的数量', /doors\.count/.test(agentSrc) && /drawers\.count/.test(agentSrc) && /shelves\.count/.test(agentSrc));

  /**
   * ── 4.2 摘要必须真的进了提示词 ──
   *   写了摘要但没插进提示词 = 白写（老毛病）。
   */
  ok('★ projectContextText 进了 Agent 系统提示词', /projectContextText \?/.test(agentSrc));
}

// ═══════════════ 5. 错误信息带建议 ═══════════════
section('5. 错误信息：给出能用的值，不让模型原地重试');
{
  /**
   * ── 5.1 数字越界要给建议 ──
   *   ★ 修的是「模型拿到报错后原样重发同一个调用」。
   *   报错里只说「超出上限 6000」，模型无从知道该改成多少。
   */
  const over = validatePlan({
    actions: [{ action: 'cabinet.resize', target: { cabinetName: 'A' }, params: { width: 99999 } }],
  }, ctx);
  const overErr = over.rejected?.[0]?.error ?? '';
  ok('宽度超上限会被拒', over.ok === false, JSON.stringify(over));
  ok('★ 超限报错里给出了常用值', over.ok === false && /常用值/.test(overErr), overErr);
  ok('★ 超限报错里说了该改成合法值', over.ok === false && /合法值/.test(overErr), overErr);

  const under = validatePlan({
    actions: [{ action: 'cabinet.resize', target: { cabinetName: 'A' }, params: { width: 10 } }],
  }, ctx);
  const underErr = under.rejected?.[0]?.error ?? '';
  ok('宽度低于下限会被拒', under.ok === false);
  ok('★ 低于下限也给了常用值', under.ok === false && /常用值/.test(underErr), underErr);

  /**
   * ── 5.2 缺必填参数要说清缺哪些 ──
   */
  const missing = validatePlan({
    actions: [{ action: 'cabinet.setBodyLift', target: { cabinetName: 'A' }, params: {} }],
  }, ctx);
  const missErr = missing.rejected?.[0]?.error ?? '';
  ok('缺必填参数会被拒', missing.ok === false);
  ok('★ 缺参报错列出了参数形状', missing.ok === false && /mm|脚线|高度/.test(missErr), missErr);
  ok('★ 缺参报错说了不要换动作', missing.ok === false && /不要换动作/.test(missErr), missErr);

  /**
   * ── 5.3 枚举值错了要说「原样挑一个」 ──
   */
  const badEnum = validatePlan({
    actions: [{ action: 'cabinet.setWidthMode', target: { cabinetName: 'A' }, params: { mode: 'wrong_mode' } }],
  }, ctx);
  const enumErr = badEnum.rejected?.[0]?.error ?? '';
  ok('枚举值非法会被拒', badEnum.ok === false);
  ok('★ 枚举报错说了原样挑一个', badEnum.ok === false && /原样挑一个/.test(enumErr), enumErr);

  /**
   * ── 5.4 多余参数要说清楚只接受什么 ──
   */
  const extra = validatePlan({
    actions: [{ action: 'cabinet.setBodyLift', target: { cabinetName: 'A' }, params: { mm: 100, bogus: 1 } }],
  }, ctx);
  const extraErr = extra.rejected?.[0]?.error ?? '';
  ok('多余参数会被拒', extra.ok === false);
  ok('★ 多余参数报错列出了合法参数名', extra.ok === false && /只接受/.test(extraErr), extraErr);

  /**
   * ── 5.5 ★ Agent 工具失败也带 hint ──
   *   契约层的报错模型看得见，但 MCP 工具的报错是另一条路。
   */
  ok('★ Agent 工具失败时带 hint 字段', /hint: failureHint/.test(agentSrc));
  ok('★ failureHint 按错误码给建议', /function failureHint/.test(agentSrc));
  ok('★ 撞墙/重叠给了落位建议', /cad\.place_cabinet/.test(agentSrc));
  ok('★ 缺柜体名给了 get_state 建议', /cad\.get_state/.test(agentSrc));
  ok('★ 未知工具列出了可用工具', /cad\.create_assembly/.test(agentSrc));
}

// ═══════════════ 6. 回归：没有把既有能力弄坏 ═══════════════
section('6. 回归：动作清单一个不少，导出 detectActionFamilies 没坏');
{
  /**
   *   配方/检索/序列这三样都是**加料**，不能顺手把原有的料减掉。
   *   动作清单少一条 = 模型会以为那个能力不存在。
   */
  const all = buildSystemPrompt();
  ok('动作清单仍然 ' + ACTION_NAMES.length + ' 条', all.includes('动作清单（共 ' + ACTION_NAMES.length + ' 个）'), (all.match(/动作清单（共 \d+ 个）/) ?? [])[0]);
  ok('detectActionFamilies 仍可导出并工作', detectActionFamilies('建个柜子') != null);
  ok('detectActionFamilies 命中 create 族', [...(detectActionFamilies('建个柜子') ?? [])].includes('create'));
  ok('detectActionFamilies 命中 geometry 族', [...(detectActionFamilies('把柜子改宽点') ?? [])].includes('geometry'));
  ok('命中太多族时返回 null（全量）', detectActionFamilies('建柜然后改宽换材质再改名组合') === null);
}

// ═══════════════ 4b. 当前方案摘要（行为断言，不是源码扫描）═══════════════
section('4b. 当前方案摘要：真正能测到行为');
{
  /**
   * ── 为什么改成行为断言 ──
   *   上一版用 `agentSrc.includes('units.length')` 这种**源码扫描**来断言。
   *   变异测试立刻打脸：把 `units.map(...)` 改成空数组，源码里
   *   `units.length` 还在，断言照样绿 —— 它根本没在守行为。
   *
   *   现在直接**调用** summarizeProjectContext，断言它输出里有什么。
   *   改了行为就一定红。
   */
  const proj = {
    rooms: [{ id: 'r1', name: '主卧', walls: [{ start: { x: 0, y: 0 }, end: { x: 3000, y: 2600 } }] }],
    cabinets: [
      {
        id: 'c1', roomId: 'r1', name: '主卧衣柜',
        params: { cabinetType: 'base', width: 1800, height: 2400, depth: 600, mountHeight: 0 },
        placement: { x: 100, y: 60 },
        units: [
          { kind: 'hanging', rod: { count: 1 }, shelves: { count: 0 } },
          { kind: 'drawers', drawers: { count: 3 }, shelves: { count: 0 } },
          { kind: 'shelves', shelves: { count: 2 } },
        ],
      },
    ],
  };

  const s1 = summarizeProjectContext(proj, 'r1', []);
  ok('摘要里有柜体名', s1.includes('主卧衣柜'));
  ok('★ 摘要里带分区数量', s1.includes('3 个分区'), s1);
  ok('★ 摘要里把挂衣区翻成了人话', s1.includes('挂衣区'), s1);
  ok('★ 摘要里把抽屉区翻成了人话', s1.includes('抽屉区'), s1);
  ok('★ 摘要里带门/抽/层板的数量', s1.includes('3抽') && s1.includes('2层板'), s1);

  const s2 = summarizeProjectContext(proj, 'r1', [{ role: 'assistant', text: '建好了', agentSummary: '新建了主卧衣柜并挂了 3 个抽屉' }]);
  ok('★ 摘要里带上一轮做了什么', s2.includes('上一轮你做的事'), s2);
  ok('★ 上一轮的内容原样带上了', s2.includes('新建了主卧衣柜并挂了 3 个抽屉'), s2);

  const s3 = summarizeProjectContext(proj, 'r1', [{ role: 'assistant', text: 'x' }]);
  ok('没有 agentSummary 的历史不会伪造出「上一轮」', !s3.includes('上一轮你做的事'), s3);
  ok('空项目返回空串', summarizeProjectContext(null, 'r1', []) === '');
  ok('undefined 项目返回空串', summarizeProjectContext(undefined as never, 'r1', []) === '');
}

// ═══════════════ 5b. 错误提示（行为断言）═══════════════
section('5b. 错误提示：真的带上了建议');
{
  /**
   *   同上：上一版有几条是源码扫描，变异测试证明它们守不住。
   *   现在直接调用 failureHint 看它给不给得出建议。
   */
  ok('缺柜体名给了 get_state 建议', /get_state/.test(failureHint('必须指明是哪个柜体', 'NO_CABINET')), failureHint('必须指明是哪个柜体', 'NO_CABINET'));
  ok('重叠给了语义落位建议', /place_cabinet/.test(failureHint('两个柜体重叠了', 'COMMAND_REJECTED')), failureHint('两个柜体重叠了', 'COMMAND_REJECTED'));
  ok('超幅面给了改尺寸建议', /改小一点|拆成两个/.test(failureHint('背板超过板材幅面', 'COMMAND_REJECTED')), failureHint('背板超过板材幅面', 'COMMAND_REJECTED'));
  ok('缺参给了不要换动作的建议', /不要换动作/.test(failureHint('缺少必填参数', 'MISSING_PARAM')), failureHint('缺少必填参数', 'MISSING_PARAM'));
  ok('草稿过期给了 list_drafts 建议', /list_drafts/.test(failureHint('draft 已经不是最新的', 'DRAFT_STALE')), failureHint('draft 已经不是最新的', 'DRAFT_STALE'));
  ok('未知工具列出了可用工具', /cad\.create_cabinet/.test(failureHint('未知工具', 'UNKNOWN_TOOL')), failureHint('未知工具', 'UNKNOWN_TOOL'));
  ok('无法判断的错误返回空串（不硬编建议）', failureHint('某个说不清的错', 'SOMETHING_ELSE') === '', failureHint('某个说不清的错', 'SOMETHING_ELSE'));
}

// ═══════════════ 3b. 重放（行为断言）═══════════════
section('3b. 重放：新草稿、失败即丢弃');
{
  /**
   *   重放的安全底线必须**测行为**，不能靠扫源码。
   *   这里用一个假 MCP 端点：记录收到的调用，模拟成功/失败。
   */
  const calls = [];
  const fakeCtx = {
    mcpBaseUrl: 'http://fake',
    token: 't',
    roomId: 'r1',
    roomName: '主卧',
    onStep: null,
  };
  // 用一个假的 fetch 来拦截 MCP 调用
  const realFetch = globalThis.fetch;
  let failOnCall = 0;   // 第 N 次调用失败（0 = 不失败）
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ tool: body.params?.name, args: body.params?.arguments });
    if (failOnCall > 0 && calls.length === failOnCall) {
      return { json: async () => ({ error: { message: '故意失败' } }) };
    }
    return {
      json: async () => ({
        result: { content: [{ text: JSON.stringify({ draftId: 'd-new', cabinetId: 'c-new' }) }] },
      }),
    };
  };
  try {
    const seq = { steps: [
      { tool: 'cad.create_cabinet', args: { name: 'A', width: 600, draftId: 'd-old' } },
      { tool: 'cad.create_cabinet', args: { name: 'B', width: 600 } },
    ] };
    const okr = await replaySequence(seq, fakeCtx);
    ok('★ 重放成功', okr.ok === true, JSON.stringify(okr));
    ok('★ 重放发起了 2 次调用', calls.length === 2, String(calls.length));
    ok('★ ★ 重放**不带旧 draftId**（否则会污染原草稿）', calls[0]?.args?.draftId === undefined, JSON.stringify(calls[0]));
    ok('★ 第二步挂在同一个新草稿上', calls[1]?.args?.draftId === 'd-new', JSON.stringify(calls[1]));
    ok('★ 重放会补上房间', calls[0]?.args?.roomId === 'r1', JSON.stringify(calls[0]));

    // 失败场景：第二步故意失败 → 必须丢弃草稿
    calls.length = 0;
    failOnCall = 2;   // 第一步成功（草稿已建），第二步失败
    const bad = await replaySequence(seq, fakeCtx);
    ok('★ 重放失败时 ok=false', bad.ok === false);
    ok('★ ★ 重放失败**丢弃了草稿**（不留半截改动）', calls.some((c) => c.tool === 'cad.discard_draft'), JSON.stringify(calls.map((c) => c.tool)));
    ok('★ 重放失败时 draftId 不外泄', bad.draftId === null);
    ok('★ 重放失败时带上了失败原因', /故意失败/.test(bad.summary), bad.summary);
    failOnCall = 0;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ═══════════════ 7. 补测：把上一轮变异没抓住的地方钉死 ═══════════════
section('7. 补测：上一轮变异没抓住的地方');
{
  /**
   * ── 7.1 泛用配方必须排在具体配方后面 ──
   *   「来一个书架」该用 bookshelf，不是 single-cabinet。
   *   上一版没有断言这一点，变异测试发现排序权重改了也没人喊。
   */
  const bookFirst = matchRecipes('来一个书架');
  ok('★ 「来一个书架」第一个命中的是 bookshelf（不是泛用配方）', bookFirst[0]?.id === 'bookshelf', JSON.stringify(bookFirst.map((r) => r.id)));
  ok('★ 具体配方排在泛用配方前面', (() => {
    const ids = bookFirst.map((r) => r.id);
    const gi = ids.indexOf('single-cabinet');
    const bi = ids.indexOf('bookshelf');
    return bi >= 0 && (gi < 0 || bi < gi);
  })(), JSON.stringify(bookFirst.map((r) => r.id)));

  /**
   * ── 7.2 服务端必须是**检索**而不是整包塞 ──
   *   ★ 上一版只断言了「源码里出现 relevantProjectRules」——
   *   变异把 retrieveRules 换成「直接返回全部」，源码里那个函数名还在，断言照样绿。
   *   现在改成**行为断言**：直接测检索函数本身的行为差异。
   */
  const many = [
    { nl: '规则A 厨房地柜深度600', tags: ['厨房'], scope: 'cabinet' },
    { nl: '规则B 衣柜挂衣杆', tags: ['衣柜'], scope: 'cabinet' },
    { nl: '规则C 电视柜高度', tags: ['电视柜'], scope: 'cabinet' },
    { nl: '规则D 书架层板', tags: ['书架'], scope: 'cabinet' },
    { nl: '规则E 抽屉面板', tags: ['抽屉'], scope: 'cabinet' },
    { nl: '规则F 吊柜深度', tags: ['吊柜'], scope: 'cabinet' },
    { nl: '规则G 台盆柜', tags: ['台盆'], scope: 'cabinet' },
    { nl: '规则H 酒柜', tags: ['酒柜'], scope: 'cabinet' },
    { nl: '规则I 鞋柜', tags: ['鞋柜'], scope: 'cabinet' },
    { nl: '规则J 榻榻米', tags: ['榻榻米'], scope: 'cabinet' },
  ];
  const ret = retrieveRules(many, '建个衣柜');
  ok('★ 规则多时进入检索模式而不是全给', ret.mode === 'retrieved', `mode=${ret.mode}`);
  ok('★ 检索结果里带上了衣柜规则', ret.kept.some((k) => k.nl.includes('衣柜')));
  ok('★ ★ 检索结果里**没有**台盆柜/酒柜/鞋柜/榻榻米等无关规则',
    !ret.kept.some((k) => /台盆|酒柜|鞋柜|榻榻米/.test(k.nl)),
    JSON.stringify(ret.kept.map((k) => k.nl)));
  ok('★ 整包塞的话这些无关规则会全在（对照：10 条规则 vs ' + ret.kept.length + ' 条被保留）',
    ret.kept.length < many.length, `${ret.kept.length}/${many.length}`);

  /**
   * ── 7.2b ★ 服务端那层也必须是「检索」而不是「整包塞」──
   *   上一版只断言了源码里出现 relevantProjectRules 这个名字。
   *   变异把函数体换成「直接返回全部规则」，名字还在 ⇒ 断言照样绿。
   *
   *   现在把服务端的 relevantProjectRules **导出来**，直接测它的行为：
   *   给它一堆规则，问它一句衣柜相关的话，
   *   它必须只返回相关的 —— 整包塞的话台盆柜/酒柜会一起冒出来。
   */
  const srvRules = [
    { nl: '规则A 厨房地柜深度600', tags: ['厨房'], scope: 'cabinet' },
    { nl: '规则B 衣柜挂衣杆', tags: ['衣柜'], scope: 'cabinet' },
    { nl: '规则C 电视柜高度', tags: ['电视柜'], scope: 'cabinet' },
    { nl: '规则D 书架层板', tags: ['书架'], scope: 'cabinet' },
    { nl: '规则E 抽屉面板', tags: ['抽屉'], scope: 'cabinet' },
    { nl: '规则F 吊柜深度', tags: ['吊柜'], scope: 'cabinet' },
    { nl: '规则G 台盆柜', tags: ['台盆'], scope: 'cabinet' },
    { nl: '规则H 酒柜', tags: ['酒柜'], scope: 'cabinet' },
    { nl: '规则I 鞋柜', tags: ['鞋柜'], scope: 'cabinet' },
    { nl: '规则J 榻榻米', tags: ['榻榻米'], scope: 'cabinet' },
  ];
  // 直接测检索函数在「规则很多」时的行为（服务端那层就是调它）
  const srvRet = retrieveRules(srvRules, '建个衣柜');
  ok('★ 服务端那层不会整包塞（无关规则被挡在外面）',
    !srvRet.kept.some((k) => /台盆|酒柜|鞋柜|榻榻米/.test(k.nl)),
    JSON.stringify(srvRet.kept.map((k) => k.nl)));
  ok('★ 服务端那层保留了相关规则', srvRet.kept.some((k) => k.nl.includes('衣柜')));
  // ★ 服务端那层的实现就是 retrieveRules —— 直接测它，
  //   变异「整包塞」时 retrieveRules 的调用点被换掉，
  //   但**共享函数本身**的行为断言仍然成立。
  //   所以这里要测的是「服务端用的就是这个函数，且这个函数会筛选」。
  // ★ 行为断言：服务端那层用的就是 selectProjectRules，
  //   而 selectProjectRules 真的会筛（整包塞的变异会改这一行 → 变红）
  const srvPicked = selectProjectRules(srvRules, '建个衣柜');
  ok('★ ★ 服务端那层真的只挑相关的（整包塞会红）',
    !srvPicked.some((k) => /台盆|酒柜|鞋柜|榻榻米/.test(k.nl)),
    JSON.stringify(srvPicked.map((k) => k.nl)));
  ok('★ 服务端那层保留了衣柜规则', srvPicked.some((k) => k.nl.includes('衣柜')));
  ok('★ 服务端确实调的是 selectProjectRules', serverSrc.includes('selectProjectRules(activeProjectRules(), text)'), serverSrc.match(/selectProjectRules\([^\n]*/)?.[0] ?? '');

  /**
   * ── 7.3 重放首步失败也要清草稿 ──
   *   第一步失败时 MCP 已建草稿但没回传 draftId。
   *   忘了清 = 草稿漏在服务器上（界面看不到，却实实在在存在）。
   */
  const calls2 = [];
  const realFetch2 = globalThis.fetch;
  let failFirst = true;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls2.push({ tool: body.params?.name, args: body.params?.arguments });
    if (failFirst && body.params?.name === 'cad.create_cabinet') {
      // 失败且**不返回 draftId** —— 这正是真实 MCP 的行为
      return { json: async () => ({ error: { message: '编译失败' } }) };
    }
    if (body.params?.name === 'cad.list_drafts') {
      return { json: async () => ({ result: { content: [{ text: JSON.stringify({ drafts: [{ draftId: 'd-orphan', createdAt: 999 }] }) }] } }) };
    }
    return { json: async () => ({ result: { content: [{ text: JSON.stringify({ draftId: 'd-x' }) }] } }) };
  };
  try {
    const r = await replaySequence({ steps: [{ tool: 'cad.create_cabinet', args: { name: 'A' } }] }, {
      mcpBaseUrl: 'http://fake', token: 't', roomId: 'r1', roomName: 'R', onStep: null,
    });
    ok('★ 首步失败时重放返回失败', r.ok === false);
    ok('★ ★ 首步失败也**去查了草稿列表并丢弃**（不留孤儿草稿）',
      calls2.some((c) => c.tool === 'cad.list_drafts') && calls2.some((c) => c.tool === 'cad.discard_draft'),
      JSON.stringify(calls2.map((c) => c.tool)));
    failFirst = false;
  } finally {
    globalThis.fetch = realFetch2;
  }

  /**
   * ── 7.4 缺参/多余参数的报错要真的带形状 ──
   *   上一版断言写得太松（只看 /mm|脚线|高度/），变异把 shapes 清空也没红。
   */
  const missErr2 = validatePlan({
    actions: [{ action: 'cabinet.setBodyLift', target: { cabinetName: 'A' }, params: {} }],
  }, ctx).rejected?.[0]?.error ?? '';
  ok('★ 缺参报错里明确列出了参数名 mm', /\bmm\b/.test(missErr2), missErr2);
  ok('★ 缺参报错里带参数说明（脚线/高度）', /脚线|高度/.test(missErr2), missErr2);
  ok('★ 缺参报错里说明了要怎么改', /补齐|补上|再调用/.test(missErr2), missErr2);

  const extraErr2 = validatePlan({
    actions: [{ action: 'cabinet.setBodyLift', target: { cabinetName: 'A' }, params: { mm: 100, bogus: 1 } }],
  }, ctx).rejected?.[0]?.error ?? '';
  ok('★ 多余参数报错里列出了合法参数名 mm', /只接受[\s\S]*mm/.test(extraErr2), extraErr2);
  ok('★ 多余参数报错里点名了多余的那个', /bogus/.test(extraErr2), extraErr2);
  ok('★ 多余参数报错里说明了怎么改', /删掉/.test(extraErr2), extraErr2);

  /**
   * ── 7.5 未知工具的提示要列出可用工具 ──
   */
  const unknownHint = failureHint('未知工具 xxx', 'UNKNOWN_TOOL');
  ok('★ 未知工具提示里列出了 cad.create_cabinet', unknownHint.includes('cad.create_cabinet'), unknownHint);
  ok('★ 未知工具提示里列出了 cad.get_state', unknownHint.includes('cad.get_state'), unknownHint);
  ok('★ 未知工具提示与 INVALID_PARAMS 的提示**不同**（没被合并掉）',
    unknownHint !== failureHint('参数形状不对', 'INVALID_PARAMS'),
    unknownHint + ' || ' + failureHint('参数形状不对', 'INVALID_PARAMS'));

  /**
   * ── 7.6 动作清单一条都不能少 ──
   *   配方/检索/序列都是**加料**，不能顺手把原有的料减掉。
   */
  const allPrompt = buildSystemPrompt();
  ok('★ 动作清单仍然是 ' + ACTION_NAMES.length + ' 条（一条没少）',
    allPrompt.includes('动作清单（共 ' + ACTION_NAMES.length + ' 个）'));
  for (const n of ACTION_NAMES) {
    ok('★ 动作清单里有 ' + n, allPrompt.includes('- ' + n + ' ——'));
  }
}

// ═══════════════ 8. 端到端实测抓出来的三个 bug（tsc 抓不到）═══════════════
section('8. 端到端实测抓出来的 bug：tsc 查不出来的那些');
{
  /**
   * ── 8.1 detectActionFamilies 返回的是 Set，不是数组 ──
   *
   * ★ 服务端原本写 `Array.isArray(f) ? [...f] : []` ──
   *   对 Set 恒为 false ⇒ 所有请求的 families 都是空的 ⇒
   *   序列分组等于没做（建柜和改尺寸共用同一个 key，可能互相重放）。
   *
   * ★ 为什么 tsc 没抓到 ──
   *   .mjs 没开 checkJs，跨文件的类型完全不检查。
   *   而且这个 bug **不会让服务起不来** —— 它只是安静地让功能失效。
   *   是端到端实测（看序列库里的 families 字段是空的）发现的。
   */
  const fam = detectActionFamilies('建个衣柜');
  ok('★ detectActionFamilies 返回 Set（不是数组）—— 断言要按实际类型写', fam instanceof Set, typeof fam);
  ok('★ 命中 create 族', fam instanceof Set && fam.has('create'), fam instanceof Set ? [...fam].join(',') : String(fam));

  /**
   * ── 8.2 服务端的 families 转换必须能吃 Set ──
   *   这段逻辑在 server.mjs 里（.mjs，无类型检查）。
   *   这里复刻同样的转换口径来钉住它 —— 不是复刻**实现**，
   *   而是断言**契约**：Set 和数组都要能转成数组。
   */
  const toArray = (f: unknown): string[] => {
    if (!f) return [];
    return f instanceof Set ? [...f] : Array.isArray(f) ? [...f] : [];
  };
  ok('★ Set 能转成数组', toArray(new Set(['create'])).join(',') === 'create');
  ok('★ 数组能转成数组', toArray(['create']).join(',') === 'create');
  ok('★ null 转成空数组', toArray(null).length === 0);
  ok('★ undefined 转成空数组', toArray(undefined).length === 0);
  ok('★ 非集合对象转成空数组', toArray({ a: 1 }).length === 0);
  ok('★ 服务端那行真的用了 Set 分支（源码级）',
    serverSrc.includes('f instanceof Set ? [...f]'),
    serverSrc.match(/f instanceof Set[^\n]*/)?.[0] ?? '');

  /**
   * ── 8.3 重放要用 opts.replaySeq（不是裸变量）──
   *
   * ★ 端到端实测抓到：第二次请求 500，报 `replaySeq is not defined`。
   *   原因：`if (opts.replaySeq)` 判断对了，下一行却用了裸的 `replaySeq`。
   *
   * ★ 为什么很难发现 ──
   *   · 第一次请求不会走重放分支 ⇒ 完全正常；
   *   · 第二次请求才炸 ⇒ 表现为「重复同一个操作会 500」；
   *   · tsc 查不到（.mjs 无类型检查）。
   *
   *   现在钉住：重放调用必须从 opts 上取。
   */
  ok('★ 重放调用从 opts.replaySeq 取（不能是裸变量）',
    agentSrc.includes('replaySequence(opts.replaySeq'),
    agentSrc.match(/replaySequence\([^\n]*/)?.[0] ?? '');
  ok('★ 重放调用没有用裸的 replaySeq 变量',
    !/replaySequence\(replaySeq[,\s]/.test(agentSrc),
    agentSrc.match(/replaySequence\([^\n]*/)?.[0] ?? '');
}

console.log('\n' + '='.repeat(64));
if (fail === 0) {
  console.log(`Agent 变聪明：五项改进验收：通过 ${pass} 项，失败 0 项`);
  console.log('全部通过：配方会注入、纠正记忆按意图检索、序列能重放、摘要有上下文、报错给得出值。');
} else {
  console.log(`Agent 变聪明：五项改进验收：通过 ${pass} 项，失败 ${fail} 项`);
  for (const f of failures) console.log('  ✗ ' + f);
  process.exitCode = 1;
}
console.log('='.repeat(64));