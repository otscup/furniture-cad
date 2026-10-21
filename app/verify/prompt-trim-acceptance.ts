/**
 * ══════════════════════════════════════════════════════════════════════
 *  提示词裁剪验收（2026-10-21）
 *
 * ── 它守的是什么 ──
 *   提示词原本每次全量发 28 条动作的完整参数说明（9731 字符）。
 *   Agent 每建一个柜要调 5-6 次模型，每次全量 ⇒ 单柜 33.9 秒。
 *   裁剪后同一任务降到 13.6 秒（-60%）。
 *
 * ── 裁剪的**危险**在哪 ──
 *   省 token 是好事，但**猜错就会让模型用错参数、甚至声称做不到**。
 *   所以本验收必须同时钉住三件事：
 *   1. 该省的真省了（否则改了等于没改）
 *   2. 该保的都保住了（28 条动作**全部**仍在清单里，只是详细程度不同）
 *   3. 猜不出来时**回退全量**（保守兜底，不能为了省 token 而冒险）
 *
 * ══════════════════════════════════════════════════════════════════════
 */
import { buildSystemPrompt, ACTION_NAMES } from '../shared/aiContract.mjs';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`); }
}
function section(t: string): void { console.log(`\n${t}`); }

const FULL = buildSystemPrompt().length;

// ═══════════════ 1. 真的省了 ═══════════════
section('1. 常见场景提示词明显变短');
{
  const cases: Array<[string, string, number]> = [
    // [标签, 用户原话, 至少要省到这个比例（%）]
    ['建柜', '给我建一个宽1800高2000深600的衣柜', 15],
    ['改尺寸', '把这个柜子改成2米4高', 40],
    ['加分区', '右边加一个抽屉区', 15],
    ['改名', '改名叫主卧衣柜A', 50],
    ['换材质', '背板换成9mm的', 50],
  ];
  for (const [label, text, minSave] of cases) {
    const len = buildSystemPrompt({ focusText: text }).length;
    const save = Math.round((1 - len / FULL) * 100);
    ok(`${label}：至少省 ${minSave}%（实际 ${save}%）`, save >= minSave, `${len} / ${FULL}`);
  }
}

// ═══════════════ 2. 该保的必须保住 ═══════════════
section('2. 28 条动作**全部**仍在清单里（裁剪只减参数说明，不减能力）');
{
  /**
   * ★ 这是裁剪最关键的安全网。
   *
   *   如果为了省 token 把某个动作整条删掉，模型会**不知道这个能力存在**，
   *   于是明明能做也说"做不到" —— 那比慢严重得多。
   *
   *   所以判据是：无论怎么裁，`- <动作名> ——` 这一行必须都在。
   */
  const texts = ['给我建一个衣柜', '改成2米4高', '加抽屉', '改名叫A', '换背板', '重新组合'];
  for (const text of texts) {
    const prompt = buildSystemPrompt({ focusText: text });
    const missing = ACTION_NAMES.filter((n) => !prompt.includes(`- ${n} ——`));
    ok(`「${text}」：28 条动作名一个不少`, missing.length === 0, `丢了：${missing.join(', ')}`);
  }
}

// ═══════════════ 3. 保守兜底 ═══════════════
section('3. 猜不出来时回退全量（不能为省 token 冒险）');
{
  const fallbacks: Array<[string, string]> = [
    ['空字符串', ''],
    ['纯空白', '   '],
    ['认不出来的话', '嗯…你觉得呢'],
    ['涉及面很广（命中 3 族以上）', '把厨房地柜吊柜重新排一下，组合成整组，换材质并把名字都改掉'],
  ];
  for (const [label, text] of fallbacks) {
    const len = buildSystemPrompt({ focusText: text }).length;
    /**
     * ★ 口径（2026-10-21 改）──
     *   原来是断言 `len === FULL`（长度必须**精确等于**全量）。
     *   加了标准做法（配方库）之后这个断言不成立了：
     *   「把厨房地柜吊柜重新排一下…」会命中 kitchen-L 配方，
     *   提示词因此比全量**更长**（10346 > 9731）——
     *   而那正是**想要**的行为：命中配方就该加料。
     *
     *   真正要守的是「**没有因为裁剪而少给东西**」：
     *   动作清单必须是**全量**（一条都不少），
     *   而提示词总长 >= 全量（只多不少，绝不少）。
     */
    const prompt = buildSystemPrompt({ focusText: text });
    const missing = ACTION_NAMES.filter((n) => !prompt.includes(`- ${n} ——`));
    ok(`${label}：动作清单是全量（${ACTION_NAMES.length} 条一个不少）`, missing.length === 0, `少了：${missing.join(', ')}`);
    ok(`${label}：提示词不比全量短（${len} >= ${FULL}）`, len >= FULL, `实际 ${len} < ${FULL}`);
  }
  ok('不传 focusText：全量', buildSystemPrompt().length === FULL);
}

// ═══════════════ 4. 裁剪不破坏既有内容 ═══════════════
section('4. 裁剪不影响既定约定与绝对规则');
{
  const rules = [{ nl: '本店默认深度 600mm', tags: ['工艺'] }];
  const prompt = buildSystemPrompt({ focusText: '建个衣柜', projectRules: rules });
  ok('裁剪后仍带【本项目的既定约定】', prompt.includes('本项目的既定约定'));
  ok('裁剪后仍带那条规则原文', prompt.includes('本店默认深度 600mm'));
  ok('裁剪后仍带绝对规则（不能输出几何）', prompt.includes('你**不能**输出几何'));
  ok('裁剪后仍带输出格式说明', prompt.includes('{ "reply"'));
  /**
   * 约定段必须在动作清单之前 —— 裁剪改变了清单长度，但顺序不能变。
   * 这些是"既定事实"，应该先于"可选动作"被读到。
   */
  const rulePos = prompt.indexOf('本项目的既定约定');
  const actionPos = prompt.indexOf('动作清单');
  ok('约定段仍在动作清单之前', rulePos >= 0 && actionPos > rulePos, `rule@${rulePos} action@${actionPos}`);
}

// ═══════════════ 5. 裁剪声明如实 ═══════════════
section('5. 裁剪后的标题如实说明"其余只列名字"');
{
  const prompt = buildSystemPrompt({ focusText: '改名叫A' });
  ok('标题说明了本次详细列出几个、其余几个', /本次详细列出 \d+ 个，其余 \d+ 个/.test(prompt),
    '标题没说清会让模型以为清单变短了');
  ok('标题明确"需要时也可以用"', prompt.includes('可以') && prompt.includes('同名同义'),
    '不说这句，模型可能不敢用没展开的动作');
}

// ═══════════════ 汇总 ═══════════════
console.log('\n' + '═'.repeat(60));
console.log(`  提示词裁剪验收：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：常见场景省 24-66%、28 条动作一个不少、猜不出时回退全量、约定与红线不受影响。');