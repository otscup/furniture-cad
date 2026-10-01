/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.2 Spatial Design Intent Vocabulary 验收
 *
 *  ── 要证明的核心命题（七条）──
 *    ① 词表是**封闭**的：不认识的词被拒，且拒的**理由**就是"不在词表里"
 *       （不是被别的检查顺手拦下 —— 那是假绿）；
 *    ② 词表的每一格都**可判定**：condition 类必须指向一个**真实存在**的事实维度
 *       （producer 的文件 + 信号串逐条去那个文件里核对），
 *       priority 类是**唯一**允许没有判定依据的一类；
 *    ③ 意图**写不出坐标**：载荷里禁一切数字（坐标一定是数字 → 物理上无法表达），
 *       scope 在**类型层**就只有 room / cabinet 两种；
 *    ④ 生命周期成立：用户明说 → active；**AI 推断只能 candidate**；
 *       未确认不能进 active；`'system'` 在类型层不存在；
 *    ⑤ 与 `spatialContext` **分离**：两个顶层键互不嵌套、键不重叠、各自只读；
 *    ⑥ **不污染既有层**：`Cabinet.placement` 逐字节不变、几何/制造/清单输出逐字节不变、
 *       不升 `schemaVersion`、无意图的旧文件逐字节不变；
 *    ⑦ 本层**不新增几何判断**：没有一处三角函数、不 import 几何/空间/落位/校验/总线。
 *
 *  ── 判据纪律（本项目反复钉过的）──
 *    · 负样本精确到**原因**（`rejectWhy`）：只断言"被拒了"会被别处的检查顶替而假绿；
 *    · 每条失败先打原始值 —— **先假定断言自己写错**；
 *    · 夹具每次自己造（共享对象引用会让用例互相污染 → 假绿）；
 *    · 参与逐字节比较的意图**必须钉死时间戳**（`Date.now()` 每毫秒都在变）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildSnapshot, snapshotBytes, snapshotContext } from '../src/ai/snapshot.ts';
import { buildSpatialContext } from '../src/ai/spatialContext.ts';
import { buildDesignIntentContext, type AiDesignIntentContext } from '../src/ai/designIntentContext.ts';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room, RuleSet } from '../src/core/types.ts';
import { parseProjectFile, serializeProjectFile } from '../src/core/projectFile.ts';
import { generateProject } from '../src/core/geometry/project.ts';
import { deriveManufacturing } from '../src/core/manufacturing/index.ts';
import { toNeutralExport } from '../src/export/neutralSheet.ts';
import { ACTION_NAMES, buildUserMessage, validateAction } from '../shared/aiContract.mjs';
import {
  CONDITION_GOALS,
  DESIGN_INTENT_DRAFT_KEYS,
  DESIGN_INTENT_FACT_DIMENSIONS,
  DESIGN_INTENT_GOALS,
  DESIGN_INTENT_GOAL_ORDER,
  DESIGN_INTENT_KEYS,
  DESIGN_INTENT_NOT_HELD,
  DESIGN_INTENT_OPENING_KINDS,
  DESIGN_INTENT_PROPOSAL_MAX,
  DESIGN_INTENT_VALUE_KEY,
  DESIGN_INTENT_VALUE_OWNER,
  PRIORITY_GOALS,
  activeDesignIntents,
  confirmIntent,
  danglingIntentError,
  designIntentDraftError,
  designIntentError,
  designIntentGoalZh,
  designIntentId,
  designIntentProposalError,
  designIntentZh,
  isDesignIntentGoal,
  makeCandidateIntent,
  makeStatedIntent,
  modelIntentError,
  partitionModelIntents,
  proposalToCandidates,
  rejectIntent,
  takenIntentIds,
  type DesignIntent,
} from '../src/core/designIntent/index.ts';

const APP = join(import.meta.dirname, '..');
const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset', 'factory-default.json'), 'utf8')) as RuleSet;
/** 逐字节比较前必须固定 savedAt（serializeProjectFile 默认用当前时间） */
const FIXED_SAVED_AT = '2026-10-01T00:00:00.000Z';

let passed = 0;
let failed = 0;
const fails: string[] = [];
function ok(name: string, cond: unknown, detail: unknown = ''): void {
  if (cond === true) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  ✗ ${name}  ── ${JSON.stringify(detail)}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

/**
 * 负样本判据：**必须因为"这个原因"被拒**。
 * 只断言"被拒了"是不够的 —— 别处的一道检查也能让它变红，于是这条断言其实什么都没证明。
 */
function rejectWhy(raw: unknown, re: RegExp, label: string): void {
  const msg = designIntentDraftError(raw);
  ok(label, typeof msg === 'string' && re.test(msg), { 收到: msg ?? null, 期望匹配: String(re) });
}
/** 完整记录闸门的同款判据 */
function rejectFull(raw: unknown, re: RegExp, label: string): void {
  const msg = designIntentError(raw);
  ok(label, typeof msg === 'string' && re.test(msg), { 收到: msg ?? null, 期望匹配: String(re) });
}

// ─────────────────────────── fixtures ───────────────────────────

function mkRoom(id: string, x = 0, y = 0, w = 4000, h = 3000, thickness = 120): Room {
  const room = rectRoom({ id, name: `房间${id}`, x, y, w, h, thickness, height: 2700 });
  room.walls.forEach((wl, i) => {
    wl.id = `${id}_w${i + 1}`;
    wl.name = `${id}墙${i + 1}`;
  });
  return room;
}
function mkCab(room: Room, id: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet {
  const units = defaultUnits(w, RULES, d).map((u) => ({ ...u, id: `${id}_${u.id}` }));
  return createCabinet({
    id,
    name: id,
    roomId: room.id,
    x,
    y,
    rotation,
    rules: RULES,
    params: { ...defaultCabinetParams(RULES), width: w, height: 2200, depth: d },
    units,
  });
}
/** 每次调用都是全新对象 —— 共享引用会让用例互相污染 */
function baseProject(): Project {
  const room = mkRoom('r1');
  return {
    schemaVersion: '0.2',
    id: 'p_di',
    name: 'P92',
    ruleSetId: RULES.id,
    rooms: [room],
    cabinets: [mkCab(room, 'c1', 400, 60, 900, 600, 0), mkCab(room, 'c2', 2000, 1500, 900, 400, 0)],
  } as Project;
}
/** 钉死时间戳：逐字节比较的前提（Date.now 每毫秒都在变） */
const T0 = 1_700_000_000_000;
const pin = (i: DesignIntent, at = T0): DesignIntent => ({
  ...i,
  createdAt: at,
  updatedAt: at,
  evidence: i.evidence.map((e) => ({ ...e, at })),
});
/**
 * 造意图时**显式指定 id**：两个夹具若都从空集合取号就都会拿到 `di_001`，
 * 而撞 id 不会报错、只会让两条意图共用一条记录（本项目反复钉过的坑 ——
 * 本脚本第一次跑就在 §5 撞上过：拒掉一条把另一条也带走了）。
 */
const statedRoom = (id = 'di_001', at = T0): DesignIntent => ({
  ...pin(
    makeStatedIntent({
      goal: 'storage-priority',
      scope: { kind: 'room', roomId: 'r1' },
      statement: '这个厨房以储物为主',
      detail: '用户：厨房以储物为主',
      taken: new Set<string>(),
    }),
    at
  ),
  id,
});
const statedCab = (id = 'di_003', at = T0): DesignIntent => ({
  ...pin(
    makeStatedIntent({
      goal: 'near-opening',
      scope: { kind: 'cabinet', cabinetId: 'c1' },
      openingKind: 'window',
      detail: '用户：柜子尽量靠窗',
      taken: new Set<string>(),
    }),
    at
  ),
  id,
});
const candidateCab = (id = 'di_002', at = T0): DesignIntent => ({
  ...pin(
    makeCandidateIntent({
      goal: 'wall-contact',
      scope: { kind: 'cabinet', cabinetId: 'c1' },
      detail: 'AI 建议靠墙',
      taken: new Set<string>(),
    }),
    at
  ),
  id,
});

const projWithIntents = (intents: DesignIntent[]): Project => ({ ...baseProject(), designIntents: intents });

// ═══════════════════════ §1 词表封闭且每一格可判定 ═══════════════════════
section('§1 词表封闭、每一格都有判定依据');
{
  const EXPECTED_GOALS = [
    'kitchen-workflow',
    'storage-priority',
    'circulation-priority',
    'wall-contact',
    'opening-clear',
    'door-swing-clear',
    'near-opening',
    'standalone',
    'room-inside',
  ];
  ok(
    `1. 词表恰好 ${EXPECTED_GOALS.length} 个词，名称逐字一致（漂移哨兵）`,
    JSON.stringify([...DESIGN_INTENT_GOAL_ORDER]) === JSON.stringify(EXPECTED_GOALS),
    JSON.stringify(DESIGN_INTENT_GOAL_ORDER)
  );
  ok(
    '2. DESIGN_INTENT_GOAL_ORDER 就是词表的声明顺序（顺序只有一处）',
    JSON.stringify(DESIGN_INTENT_GOAL_ORDER) === JSON.stringify(Object.keys(DESIGN_INTENT_GOALS))
  );
  ok(
    '3. priority 3 条 + condition 6 条，两类并集 == 全部词（没有第三类漏网）',
    PRIORITY_GOALS.length === 3 &&
      CONDITION_GOALS.length === 6 &&
      new Set([...PRIORITY_GOALS, ...CONDITION_GOALS]).size === DESIGN_INTENT_GOAL_ORDER.length,
    JSON.stringify({ priority: PRIORITY_GOALS, condition: CONDITION_GOALS })
  );
  /**
   * 本层最关键的一条准入断言：
   * "判定不出依据"是**唯一**允许 priority 类拥有的特权 ——
   * 若有人随手加一个没有 fact 的 condition 词，这条立刻红。
   */
  const nullFact = DESIGN_INTENT_GOAL_ORDER.filter((g) => DESIGN_INTENT_GOALS[g].fact === null);
  ok(
    '4. ★ fact 为空的词 == PRIORITY_GOALS（"判不出依据"只许取舍方向类拥有）',
    JSON.stringify([...nullFact].sort()) === JSON.stringify([...PRIORITY_GOALS].sort()) && nullFact.length === 3,
    JSON.stringify({ nullFact, PRIORITY_GOALS })
  );
  ok(
    '5. 每条 condition 的 fact 都落在事实维度闭集里',
    CONDITION_GOALS.every((g) => DESIGN_INTENT_FACT_DIMENSIONS.includes(DESIGN_INTENT_GOALS[g].fact as never)),
    JSON.stringify(CONDITION_GOALS.map((g) => [g, DESIGN_INTENT_GOALS[g].fact]))
  );
  ok(
    '6. 每条 condition 都登记了产出方（file + signal 都非空）',
    CONDITION_GOALS.every((g) => {
      const p = DESIGN_INTENT_GOALS[g].producer;
      return !!p && typeof p.file === 'string' && p.file.length > 0 && Array.isArray(p.signal) && p.signal.length > 0;
    }),
    JSON.stringify(CONDITION_GOALS.map((g) => [g, DESIGN_INTENT_GOALS[g].producer]))
  );
  ok(
    '7. priority 类**没有**产出方（判不出就是判不出，不编一个文件出来）',
    PRIORITY_GOALS.every((g) => DESIGN_INTENT_GOALS[g].producer === undefined),
    JSON.stringify(PRIORITY_GOALS.map((g) => [g, DESIGN_INTENT_GOALS[g].producer]))
  );
  {
    // ★ 去真实文件里核对信号串 —— "词表不许指向不存在的事实"的机器化
    const cache = new Map<string, string>();
    const read = (rel: string): string | null => {
      const abs = join(APP, 'src', rel);
      let s = cache.get(abs);
      if (s === undefined) {
        try {
          s = readFileSync(abs, 'utf8');
        } catch {
          return null;
        }
        cache.set(abs, s);
      }
      return s;
    };
    const problems: string[] = [];
    for (const g of CONDITION_GOALS) {
      const p = DESIGN_INTENT_GOALS[g].producer!;
      const src = read(p.file);
      if (src === null) {
        problems.push(`${g}: 文件不存在 ${p.file}`);
        continue;
      }
      for (const sig of p.signal) if (!src.includes(sig)) problems.push(`${g}: ${p.file} 里找不到信号串 ${JSON.stringify(sig)}`);
    }
    ok(
      `8. ★ 每条 condition 的 producer 文件与信号串**逐字存在**于真实源码（${CONDITION_GOALS.length} 条全查）`,
      problems.length === 0,
      problems
    );
  }
  {
    // 词表里**不许出现数字**：阈值的唯一出处是规则（SPATIAL_TOL / DESIGN_TOL），不是词表
    const nums: string[] = [];
    (function walk(n: unknown, p: string): void {
      if (typeof n === 'number') {
        nums.push(`${p}=${n}`);
        return;
      }
      if (Array.isArray(n)) return n.forEach((v, i) => walk(v, `${p}[${i}]`));
      if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) walk(v, `${p}.${k}`);
    })(DESIGN_INTENT_GOALS, 'goals');
    ok('9. 词表对象里递归没有任何数字（"多近算贴上"不在意图里，那是规则的事）', nums.length === 0, nums.slice(0, 6));
  }
  ok(
    '10. 每条词的 satisfiedValues 都是字符串枚举（不是坐标、不是区间）',
    DESIGN_INTENT_GOAL_ORDER.every((g) => DESIGN_INTENT_GOALS[g].satisfiedValues.every((v) => typeof v === 'string')),
    JSON.stringify(DESIGN_INTENT_GOAL_ORDER.map((g) => [g, DESIGN_INTENT_GOALS[g].satisfiedValues]))
  );
  ok(
    '11. 每条词的 zh / expect / note 都是非空字符串（不是占位）',
    DESIGN_INTENT_GOAL_ORDER.every(
      (g) => DESIGN_INTENT_GOALS[g].zh.length > 0 && DESIGN_INTENT_GOALS[g].expect.length > 0 && DESIGN_INTENT_GOALS[g].note.length > 0
    )
  );
  ok(
    '12. isDesignIntentGoal：9 个词全 true；未知词（含大小写/空格变体）全 false',
    DESIGN_INTENT_GOAL_ORDER.every((g) => isDesignIntentGoal(g) === true) &&
      ['make-it-pretty', 'Wall-Contact', 'wall-contact ', ' align-with', 'near', ''].every((w) => isDesignIntentGoal(w) === false),
    JSON.stringify(['make-it-pretty', 'Wall-Contact', 'wall-contact '].map((w) => [w, isDesignIntentGoal(w)]))
  );
  ok(
    '13. 事实维度闭集恰好 5 项，且每条 condition 的 fact 都在其中（顺序固定）',
    DESIGN_INTENT_FACT_DIMENSIONS.length === 5 &&
      JSON.stringify(DESIGN_INTENT_FACT_DIMENSIONS) ===
        JSON.stringify([
          'cabinet.wallContacts',
          'cabinet.openingProximity',
          'cabinet.doorClearances',
          'cabinet.roomRelation',
          'cabinet.contacts',
        ]),
    JSON.stringify(DESIGN_INTENT_FACT_DIMENSIONS)
  );
  ok(
    `14. 取值字段只有一个：${DESIGN_INTENT_VALUE_KEY}（='openingKind'），且草案键闭集与记录键闭集都显式含它`,
    DESIGN_INTENT_VALUE_KEY === 'openingKind' && DESIGN_INTENT_DRAFT_KEYS.includes('openingKind') && DESIGN_INTENT_KEYS.includes('openingKind'),
    JSON.stringify({ DESIGN_INTENT_VALUE_KEY, draft: DESIGN_INTENT_DRAFT_KEYS, full: DESIGN_INTENT_KEYS })
  );
  ok(
    '15. 取值字段有且只有一个归属词，且该词在词表里；取值域 = door / window',
    DESIGN_INTENT_VALUE_OWNER === 'near-opening' &&
      isDesignIntentGoal(DESIGN_INTENT_VALUE_OWNER) &&
      JSON.stringify(DESIGN_INTENT_OPENING_KINDS) === JSON.stringify(['door', 'window']),
    JSON.stringify({ DESIGN_INTENT_VALUE_OWNER, DESIGN_INTENT_OPENING_KINDS })
  );
  ok(
    '16. "为什么不收某些词"有机器可读的记录：5 条，每条都点名副主与理由',
    DESIGN_INTENT_NOT_HELD.length === 5 && DESIGN_INTENT_NOT_HELD.every((n) => n.word.length > 0 && n.owner.length > 0 && n.why.length > 0),
    JSON.stringify(DESIGN_INTENT_NOT_HELD.map((n) => n.word))
  );
  ok(
    '17. 用户举例里被判"已有归属"的词确实被登记为不收（align-with / adjacent-to / near / face）',
    ['align-with', 'adjacent-to', 'near', 'face'].every((w) => DESIGN_INTENT_NOT_HELD.some((n) => n.word.includes(w))),
    JSON.stringify(DESIGN_INTENT_NOT_HELD.map((n) => n.word))
  );
  ok(
    '18. 每个 goal 的 spec.kind == 它的键（词表没有"张冠李戴"）',
    DESIGN_INTENT_GOAL_ORDER.every((g) => DESIGN_INTENT_GOALS[g].kind === g)
  );
  ok(
    '19. condition 类的 scope 都要与词的层级自洽（room 词走房间、cabinet 词走柜）',
    DESIGN_INTENT_GOAL_ORDER.every((g) => ['room', 'cabinet'].includes(DESIGN_INTENT_GOALS[g].scope)),
    JSON.stringify(DESIGN_INTENT_GOAL_ORDER.map((g) => [g, DESIGN_INTENT_GOALS[g].scope]))
  );
  ok('20. 人话出口唯一：designIntentGoalZh 对每个词都给非空人话，且与 spec.zh 同源', DESIGN_INTENT_GOAL_ORDER.every((g) => designIntentGoalZh(g) === DESIGN_INTENT_GOALS[g].zh));
}

// ═══════════════════════ §2 未知意图不被接受 ═══════════════════════
section('§2 未知意图不被接受（而且是"因为不在词表里"被拒）');
{
  const cleanScope = { kind: 'cabinet', cabinetId: 'c1' };
  const cleanRoomScope = { kind: 'room', roomId: 'r1' };
  rejectWhy({ goal: 'make-it-pretty', scope: cleanRoomScope }, /不在设计意图词表里/, '21. 负样本：自造词 make-it-pretty → 拒，理由是"不在词表里"');
  rejectWhy({ goal: 'align-with', scope: cleanScope }, /不在设计意图词表里/, '22. 负样本：align-with（已归 PlacementIntent）→ 拒（不是"忽略掉继续"）');
  rejectWhy({ goal: 'prefer-wall', scope: cleanScope }, /不在设计意图词表里/, '23. 负样本：祈使句写法 prefer-wall → 拒（词表用事实维度名 wall-contact）');
  rejectWhy({ goal: 'near-window', scope: cleanScope }, /不在设计意图词表里/, '24. 负样本：near-window → 拒（应收成 near-opening + openingKind:window）');
  rejectWhy({ goal: 'WALL-CONTACT', scope: cleanScope }, /不在设计意图词表里/, '25. 负样本：大小写不匹配 → 拒（词表是逐字闭集）');
  rejectWhy({ goal: 'wall-contact ', scope: cleanScope }, /不在设计意图词表里/, '26. 负样本：尾部空格 → 拒（不做 trim 宽容）');
  rejectWhy({ scope: cleanScope }, /缺 goal/, '27. 负样本：缺 goal → 拒');
  rejectWhy({ goal: null, scope: cleanScope }, /不在设计意图词表里/, '28. 负样本：goal=null → 拒');
  rejectWhy({ goal: 123, scope: cleanScope }, /不许出现数字/, '29. 负样本：goal=123 → 拒，理由是"载荷里不许出现数字"');
  rejectWhy({ goal: {}, scope: cleanScope }, /不在设计意图词表里/, '30. 负样本：goal 是对象 → 拒');
  {
    const msg = designIntentDraftError({ goal: 'make-it-pretty', scope: cleanRoomScope });
    ok(
      '31. 未知词的报错必须点名那个词（否则人看不懂自己哪个词写错了）',
      typeof msg === 'string' && msg.includes('make-it-pretty'),
      msg ?? null
    );
  }
  {
    // 同一个坏词进了**提案**也必须整份废掉（原子性），且指出是第几条
    const prop = { intents: [{ goal: 'wall-contact', scope: cleanScope }, { goal: 'make-it-pretty', scope: cleanScope }] };
    const msg = designIntentProposalError(prop);
    ok(
      '32. 提案里第 2 条是未知词 → 整份被拒，且报出"第 2 条"',
      typeof msg === 'string' && msg.includes('第 2 条') && msg.includes('不在设计意图词表里'),
      msg ?? null
    );
  }
}

// ═══════════════════════ §3 AI 不能写 geometry ═══════════════════════
section('§3 没有坐标写入口：载荷禁一切数字 + scope 无实体 + 提案无元信息');
{
  const s = { kind: 'cabinet', cabinetId: 'c1' };
  rejectWhy({ goal: 'wall-contact', scope: { ...s, x: 100 } }, /不许出现数字/, '33. 负样本：scope 里塞 x:100（坐标走私）→ 拒，理由是"不许出现数字"');
  rejectWhy({ goal: 'wall-contact', scope: { ...s, rotation: 90 } }, /不许出现数字/, '34. 负样本：scope 里塞 rotation:90 → 拒，理由是"不许出现数字"');
  rejectWhy({ goal: 'wall-contact', scope: { ...s, wallId: 'r1_w1' } }, /墙、洞口、坐标都不是意图能指的对象/, '35. 负样本：scope 里塞 wallId → 拒（"关于谁"≠"贴到哪面墙上"）');
  rejectWhy({ goal: 'wall-contact', scope: { kind: 'wall', wallId: 'r1_w1' } }, /不认识的字段：wallId/, '35b. 负样本：scope 直接以墙为主语 → 拒，报出 wallId');
  rejectWhy({ goal: 'wall-contact', scope: { kind: 'wall' } }, /scope\.kind 只能是/, '36. 负样本：scope.kind="wall" → 拒（类型层也表达不出来）');
  rejectWhy({ goal: 'opening-clear', scope: { kind: 'opening', openingId: 'o1' } }, /不认识的字段：openingId/, '37. 负样本：scope 指向洞口 → 拒，报出 openingId（意图不指向洞口）');
  rejectWhy({ goal: 'wall-contact', scope: s, placement: { x: 0, y: 0, rotation: 0 } }, /不认识的字段：placement/, '38. 负样本：塞 placement{x,y,rotation} → 拒，报出字段名 placement');
  rejectWhy({ goal: 'wall-contact', scope: s, rotation: 90 }, /不认识的字段：rotation/, '39. 负样本：顶层塞 rotation → 拒，报出字段名 rotation');
  rejectWhy({ goal: 'near-opening', scope: s, openingKind: 2 }, /不许出现数字/, '40. 负样本：openingKind 塞数字 → 拒');
  rejectWhy({ goal: 'wall-contact', scope: s, openingKind: 'door' }, /只有 goal="near-opening" 用得上/, '41. 负样本：非归属词带 openingKind → 拒（不是静默忽略）');
  rejectWhy({ goal: 'near-opening', scope: s, openingKind: 'gate' }, /openingKind 只能是 door \/ window/, '42. 负样本：openingKind 越域 → 拒');
  rejectWhy({ goal: 'wall-contact', scope: s, statement: { text: '靠墙' } }, /statement 必须是字符串/, '43. 负样本：statement 是对象 → 拒');
  rejectWhy({ goal: 'wall-contact', scope: { ...s, ok: true } }, /不许出现数字/, '44. 负样本：载荷里的布尔值 → 拒（禁的是"一切数字/布尔"，不是"名字叫 x 的字段"）');
  rejectWhy({ goal: 'wall-contact', scope: { ...s, pts: [0, 0] } }, /是数组/, '45. 负样本：载荷里塞点列数组 → 拒（意图不表达点列 / 区间 / 清单）');
  rejectWhy({ goal: 'wall-contact', scope: { ...s, at: { deep: { z: 1 } } } }, /不许出现数字/, '46. 负样本：深层嵌套的数字 → 拒（递归查，不是只查顶层）');
  {
    // 坐标走私的每一条路：要么撞数字筛子，要么撞键闭集 —— 两条路都不通
    const paths: Array<[unknown, RegExp]> = [
      [{ goal: 'wall-contact', scope: { ...s, y: 60 } }, /不许出现数字/],
      [{ goal: 'wall-contact', scope: s, x: 1 }, /不认识的字段/],
      [{ goal: 'wall-contact', scope: s, envelope: [[0, 0], [1, 1]] }, /不认识的字段/],
    ];
    ok(
      '47. ★ 坐标走私的两条路都堵死：scope 内的数撞数字筛子、scope 外的键撞键闭集（没有第三条路）',
      paths.every(([raw, re]) => {
        const m = designIntentDraftError(raw);
        return typeof m === 'string' && re.test(m);
      }),
      paths.map(([raw]) => designIntentDraftError(raw))
    );
  }
  {
    // 草案不许自带元信息（7 个键逐条）
    const metaKeys = ['id', 'status', 'origin', 'confirmedBy', 'evidence', 'createdAt', 'updatedAt'];
    let good = 0;
    const bads: unknown[] = [];
    for (const k of metaKeys) {
      const m = designIntentDraftError({ goal: 'wall-contact', scope: s, [k]: k === 'evidence' ? [] : 'x' });
      if (typeof m === 'string' && m.includes(`不能自带 "${k}"`)) good++;
      else bads.push([k, m ?? null]);
    }
    ok(
      `48. ★ 草案自带元信息（${metaKeys.length} 个键逐条）→ 一律拒，且报错点名叫"不能自己宣布生效"`,
      good === metaKeys.length,
      bads
    );
    const m = designIntentDraftError({ goal: 'wall-contact', scope: s, status: 'active' });
    ok('49. 自带的报错必须点出"提出者不能自己宣布生效"（这条是给 AI 看的教训）', typeof m === 'string' && m.includes('提出者不能自己宣布生效'), m ?? null);
  }
  rejectWhy({ goal: 'wall-contact', scope: s, status: 'active' }, /不能自带 "status"/, '50. 负样本：草案自带 status="active" → 拒（与 48 同一条规矩的具体化）');
  {
    // 提案顶层键闭集
    const good = proposalToCandidates(
      { intents: [{ goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: 'c1' } }], reply: '建议' },
      { taken: new Set<string>(), detail: 't', at: 1 }
    );
    ok('51. 合法提案（intents + reply）→ 通过', good.ok === true, JSON.stringify(good));
    const msg = designIntentProposalError({ intents: [{ goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: 'c1' } }], plan: [] });
    ok('52. 负样本：提案里塞 plan 键 → 拒，报出 plan', typeof msg === 'string' && msg.includes('plan'), msg ?? null);
    ok('53. 负样本：intents 空数组 → 拒（没有意图就别提这一轮）', typeof designIntentProposalError({ intents: [] }) === 'string');
    ok('54. 负样本：intents 不是数组 → 拒', typeof designIntentProposalError({ intents: {} }) === 'string');
    const nine = { intents: Array.from({ length: DESIGN_INTENT_PROPOSAL_MAX + 1 }, () => ({ goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: 'c1' } })) };
    const eight = { intents: Array.from({ length: DESIGN_INTENT_PROPOSAL_MAX }, () => ({ goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: 'c1' } })) };
    ok(
      `55. 一次最多 ${DESIGN_INTENT_PROPOSAL_MAX} 条：9 条拒、8 条过（与 MAX_ACTIONS 同精神）`,
      typeof designIntentProposalError(nine) === 'string' && designIntentProposalError(eight) === null,
      { nine: designIntentProposalError(nine), eight: designIntentProposalError(eight) }
    );
  }
  {
    // 提案产物里没有几何
    const r = proposalToCandidates(
      {
        intents: [
          { goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: 'c1' } },
          { goal: 'near-opening', scope: { kind: 'cabinet', cabinetId: 'c1' }, openingKind: 'door' },
        ],
      },
      { taken: new Set<string>(['di_001']), detail: 'AI 提案', at: 1 }
    );
    if (r.ok) {
      const json = JSON.stringify(r.candidates);
      ok(
        '56. ★ AI 提案的产物里没有 placement / x / y / rotation / {x,y} 任何一个（AI 写不出几何）',
        !json.includes('"placement"') &&
          !json.includes('"rotation"') &&
          !/[{,]\s*"x"\s*:/.test(json) &&
          !/[{,]\s*"y"\s*:/.test(json),
        json.slice(0, 300)
      );
      ok(
        '57. 提案产物一定是 candidate、一定 origin=ai-inferred、一定没有 confirmedBy',
        r.candidates.length === 2 &&
          r.candidates.every((c) => c.status === 'candidate' && c.origin === 'ai-inferred' && c.confirmedBy === undefined),
        JSON.stringify(r.candidates.map((c) => [c.status, c.origin, c.confirmedBy]))
      );
      ok(
        '58. 提案产物 id 不撞车：taken 里已有 di_001 → 新 id 从 di_002 起（撞 id 会静默共用记录）',
        new Set(r.candidates.map((c) => c.id)).size === 2 && !r.candidates.some((c) => c.id === 'di_001'),
        JSON.stringify(r.candidates.map((c) => c.id))
      );
    } else {
      ok('56. ★ AI 提案的产物里没有坐标（提案未被接受 —— 断言无法执行）', false, r.error);
      ok('57. 提案产物一定是 candidate（提案未被接受）', false, r.error);
      ok('58. 提案产物 id 不撞车（提案未被接受）', false, r.error);
    }
  }
  {
    // 契约层：没给 AI 新增任何"写意图"的动作
    ok(
      '59. AI 动作清单仍是 21 条（漂移哨兵：加动作必须同时改这条断言）',
      ACTION_NAMES.length === 21,
      JSON.stringify(ACTION_NAMES)
    );
    ok(
      '60. 没有任何动作名与设计意图有关（intent / design / goal / priority 一律不出现）',
      !ACTION_NAMES.some((n: string) => /intent|design|goal|priority/i.test(n)),
      JSON.stringify(ACTION_NAMES.filter((n: string) => /intent|design|goal|priority/i.test(n)))
    );
    const ctx = snapshotContext(buildSnapshot(projWithIntents([statedRoom()]), RULES));
    const r1 = validateAction({ action: 'design.intent.add', target: { cabinetName: 'c1' }, params: { goal: 'wall-contact' } }, ctx);
    ok('61. 负样本：design.intent.add → UNKNOWN_ACTION（AI 没有写意图的语法）', !r1.ok && r1.code === 'UNKNOWN_ACTION', JSON.stringify(r1));
    const r2 = validateAction({ action: 'cabinet.place', target: { cabinetName: 'c1' }, params: { relation: 'align', reference: 'c2', intent: 'wall-contact' } }, ctx);
    ok('62. 负样本：往合法动作的 params 里塞 intent → EXTRA_PARAM 整条作废（意图不是动作参数）', !r2.ok && r2.code === 'EXTRA_PARAM', JSON.stringify(r2));
  }
  {
    const snap = buildSnapshot(projWithIntents([statedRoom(), candidateCab()]), RULES);
    const msg = buildUserMessage('帮我把柜子挪一下', snap, []);
    ok(
      '63. ★ 提示词里明说本阶段**不能**新增/修改设计意图（否则模型会认真写一段没人读的 intents → 静默丢弃）',
      msg.includes('designIntent') && msg.includes('不能新增或修改设计意图'),
      msg.slice(msg.indexOf('designIntent'), msg.indexOf('designIntent') + 200)
    );
    ok(
      '64. 提示词里同样明说"写了也不会生效"（把"不能"说到位，不留"也许可以试试"的缝）',
      msg.includes('写了也不会生效'),
      null
    );
  }
}

// ═══════════════════════ §4 用户明说的意图（provenance）═══════════════════════
section('§4 用户明说的意图：直接 active + 有出处');
{
  const a = statedRoom();
  ok(
    '65. makeStatedIntent → status="active" + origin="user-stated" + confirmedBy="user-stated"（用户原话就是确认）',
    a.status === 'active' && a.origin === 'user-stated' && a.confirmedBy === 'user-stated',
    JSON.stringify([a.status, a.origin, a.confirmedBy])
  );
  ok(
    '66. evidence 至少一条，source=user-stated，detail 逐字是传进来的原话',
    a.evidence.length >= 1 && a.evidence[0]!.source === 'user-stated' && a.evidence[0]!.detail === '用户：厨房以储物为主',
    JSON.stringify(a.evidence)
  );
  ok('67. evidence.at 是整数时间戳（不是浮点、不是字符串）', a.evidence.every((e) => Number.isInteger(e.at)), JSON.stringify(a.evidence.map((e) => e.at)));
  ok('68. createdAt === updatedAt（新建记录，没有被改过）', a.createdAt === a.updatedAt, JSON.stringify([a.createdAt, a.updatedAt]));
  ok('69. 用户明说的意图可以进模型：modelIntentError(stated) === null', modelIntentError(a) === null, modelIntentError(a));
  ok('70. 完整记录闸门接受它：designIntentError(stated) === null', designIntentError(a) === null, designIntentError(a));
  {
    const project = projWithIntents([a]);
    const zh = designIntentZh(a, project);
    ok(
      '71. 人话里带上"关于谁"（房间名）与目标人话（唯一一处拼装）',
      zh.includes('房间r1') && zh.includes(DESIGN_INTENT_GOALS['storage-priority'].zh),
      zh
    );
    const b = statedCab();
    ok('72. 带 openingKind 的意图在人话里说清"只算窗"', designIntentZh(b, project).includes('只算窗'), designIntentZh(b, project));
  }
  ok(
    '73. 记录键闭集恰好 11 项（多一个键要同时改这条断言）',
    DESIGN_INTENT_KEYS.length === 11 &&
      JSON.stringify([...DESIGN_INTENT_KEYS].sort()) ===
        JSON.stringify(['confirmedBy', 'createdAt', 'evidence', 'goal', 'id', 'openingKind', 'origin', 'scope', 'statement', 'status', 'updatedAt'].sort()),
    JSON.stringify(DESIGN_INTENT_KEYS)
  );
  rejectFull({ ...a, extraField: 1 }, /不认识的字段：extraField/, '74. 负样本：完整记录多一个键 → 拒，报出键名');
  rejectFull({ ...a, id: '' }, /缺 id/, '75. 负样本：id 为空串 → 拒');
  rejectFull({ ...a, status: 'pending' }, /status 只能是 candidate \/ active \/ rejected/, '76. 负样本：status 越域 → 拒');
  rejectFull({ ...a, evidence: 'x' }, /缺 evidence/, '77. 负样本：evidence 不是数组 → 拒');
  rejectFull({ ...a, evidence: [{ at: 1 }] }, /evidence 里有非法条目/, '78. 负样本：evidence 条目缺 detail → 拒');
  rejectFull({ ...a, createdAt: undefined }, /缺 createdAt \/ updatedAt/, '79. 负样本：缺时间戳 → 拒');
  rejectFull({ ...a, origin: 'system' }, /系统不产生设计意图/, '80. ★ 负样本：origin="system" → 拒（系统不产生偏好）');
  rejectFull({ ...a, origin: 'imported' }, /系统不产生设计意图/, '81. 负样本：origin="imported" → 拒（来源只有两种）');
  rejectFull({ ...a, confirmedBy: 'system' }, /confirmedBy 只能是/, '82. 负样本：confirmedBy 越域 → 拒');
  {
    // 只扫**代码行**：文件头注释里正讨论这件事（"把 'system' 从联合类型里去掉"），
    // 扫注释会把"说明它不存在"的那句话当成"它存在"的证据 —— 典型的自己骗自己。
    const src = readFileSync(join(APP, 'src/core/designIntent/model.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');
    ok(
      '83. ★ `system` 在**类型层**就不存在：model.ts 的代码里不出现作为 origin 的 \'system\'',
      !/'system'/.test(code),
      (code.match(/.*'system'.*/g) ?? []).slice(0, 3)
    );
  }
}

// ═══════════════════════ §5 生命周期：candidate ↔ active ═══════════════════════
section('§5 生命周期：AI 只能 candidate，未确认不能进 active');
{
  const c = candidateCab();
  ok(
    '84. makeCandidateIntent → status="candidate" + origin="ai-inferred" + **没有** confirmedBy',
    c.status === 'candidate' && c.origin === 'ai-inferred' && c.confirmedBy === undefined,
    JSON.stringify([c.status, c.origin, c.confirmedBy])
  );
  ok('85. 未确认不能进模型：modelIntentError(candidate) 非空且说明原因', modelIntentError(c)?.includes('只有 active 能进模型') === true, modelIntentError(c));
  ok('86. 完整记录闸门也放行 candidate（它是一条合法记录，只是不该进模型）', designIntentError(c) === null, designIntentError(c));
  {
    const confirmed = confirmIntent([c], c.id);
    const x = confirmed[0]!;
    ok(
      '87. confirmIntent（唯一人工升级通道）→ active + confirmedBy="user-confirmed"',
      x.status === 'active' && x.confirmedBy === 'user-confirmed',
      JSON.stringify([x.status, x.confirmedBy])
    );
    ok(
      '88. 确认会留下证据：evidence 多一条，source="user-confirmed"（谁让它生效的有据可查）',
      x.evidence.length === c.evidence.length + 1 && x.evidence[x.evidence.length - 1]!.source === 'user-confirmed',
      JSON.stringify(x.evidence)
    );
    ok('89. 确认后可以进模型：modelIntentError 为 null', modelIntentError(x) === null, modelIntentError(x));
    ok('90. 确认后 origin 仍是 ai-inferred（没被洗成用户说的 —— 出处不能篡改）', x.origin === 'ai-inferred', x.origin);
  }
  {
    const a = statedRoom();
    const again = confirmIntent([a], a.id);
    ok(
      '91. 对已经 active 的意图再确认一次 → **原样返回**（不重复记证据、不改状态）',
      JSON.stringify(again[0]) === JSON.stringify(a),
      JSON.stringify(again[0])
    );
  }
  {
    const c = candidateCab();
    const rej = rejectIntent([c], c.id, '用户否掉');
    const x = rej[0]!;
    ok('92. rejectIntent → rejected，且留下否掉的原话', x.status === 'rejected' && x.evidence.some((e) => e.detail === '用户否掉'), JSON.stringify(x.status));
    ok('93. ★ rejected **不能靠再确认复活**（"我否过它"这件事必须留痕）', confirmIntent(rej, c.id)[0]!.status === 'rejected', JSON.stringify(confirmIntent(rej, c.id)[0]!.status));
    ok('94. rejected 也进不了模型', modelIntentError(x)?.includes('只有 active 能进模型') === true, modelIntentError(x));
  }
  {
    const a = statedRoom();
    // 模型里放三种状态各一条（文件边界会挡掉后两种，但读侧自己也必须是按 active 过滤的）
    const cand = candidateCab();
    const rej: DesignIntent = { ...statedCab(), status: 'rejected' };
    const project = projWithIntents([a, cand, rej]);
    const got = activeDesignIntents(project);
    ok(
      '95. ★ activeDesignIntents（读侧唯一入口）只返回 active：candidate 与 rejected 都不出现',
      got.length === 1 && got[0]!.id === a.id && project.designIntents!.length === 3,
      JSON.stringify({ got: got.map((i) => [i.id, i.status]), model: project.designIntents!.map((i) => [i.id, i.status]) })
    );
  }
  rejectFull({ ...candidateCab(), confirmedBy: 'user-confirmed' }, /未确认不能算生效/, '96. ★ 负样本：candidate 却自带 confirmedBy → 拒（"未确认却自称生效"是最该防的假象）');
  rejectFull({ ...candidateCab(), status: 'active', confirmedBy: undefined }, /没有人认领|生效必须有人确认/, '97. ★ 负样本：active 却没人认领 → 拒');
  rejectFull({ ...candidateCab(), status: 'active', confirmedBy: 'user-stated' }, /不能自己宣布生效/, '98. ★ 负样本：AI 推断的 active 用 confirmedBy="user-stated" 生效 → 拒');
  rejectFull({ ...statedRoom(), confirmedBy: 'user-confirmed' }, /confirmedBy 应当是 'user-stated'/, '99. 负样本：用户明说的却用 user-confirmed 生效 → 拒（出处自洽）');
  rejectFull({ ...candidateCab(), status: 'candidate', status2: 1 }, /不认识的字段：status2/, '100. 负样本：记录里多一个键 → 拒');
  {
    const cand = candidateCab();
    const model = modelIntentError(cand);
    ok('101. candidate 的报错要说出"确认之后才生效"（教人怎么把它变成 active）', model?.includes('确认之后才生效') === true, model);
    const r = proposalToCandidates({ intents: [{ goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: 'c1' } }] }, { taken: new Set<string>(), detail: 'x', at: 1 });
    ok(
      '102. ★ 提案通道的产物过不了模型闸门（证明"AI 提案 ≠ 生效"）',
      r.ok === true && r.candidates.every((x) => modelIntentError(x) !== null),
      r.ok ? JSON.stringify(r.candidates.map((x) => modelIntentError(x))) : r.error
    );
  }
  {
    const p = baseProject() as Project;
    const good = statedRoom();
    const danglingRoom: DesignIntent = { ...good, id: 'di_901', scope: { kind: 'room', roomId: 'r_missing' } };
    const danglingCab: DesignIntent = { ...good, id: 'di_902', scope: { kind: 'cabinet', cabinetId: 'c_missing' } };
    ok('103. 悬空引用（指向不存在的房间）→ 判出原因并点名 id', danglingIntentError(danglingRoom, p)?.includes('房间 r_missing 已经不存在') === true, danglingIntentError(danglingRoom, p));
    ok('104. 悬空引用（指向不存在的柜）→ 判出原因并点名 id', danglingIntentError(danglingCab, p)?.includes('柜体 c_missing 已经不存在') === true, danglingIntentError(danglingCab, p));
    ok('105. 引用存在时没有理由丢它（不误伤）', danglingIntentError(good, p) === null, danglingIntentError(good, p));
  }
  {
    const p = baseProject();
    const good = statedRoom();
    const cand = { ...candidateCab(), id: 'di_910' };
    const noOwner: DesignIntent = { ...good, id: 'di_911', confirmedBy: undefined };
    const dangling: DesignIntent = { ...good, id: 'di_912', goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: 'c_missing' } };
    const dup: DesignIntent = { ...good };
    const part = partitionModelIntents([good, cand, noOwner, dangling, dup], p);
    ok(
      '106. ★ 文件里的意图分区：合法 active 保留 1 条；candidate / 无人认领 / 悬空 / id 重复 各丢 1 条',
      part.keep.length === 1 && part.dropped.length === 4,
      JSON.stringify({ keep: part.keep.map((k) => k.id), dropped: part.dropped.map((d) => d.why) })
    );
    ok(
      '107. 每条丢弃都给出**可读原因**（不许静默丢）',
      part.dropped.every((d) => typeof d.why === 'string' && d.why.length > 8) &&
        part.dropped.some((d) => d.why.includes('只有 active 能进模型')) &&
        part.dropped.some((d) => d.why.includes('没有人认领') || d.why.includes('生效必须有人确认')) &&
        part.dropped.some((d) => d.why.includes('已经不存在')) &&
        part.dropped.some((d) => d.why.includes('id 重复')),
      part.dropped.map((d) => d.why)
    );
    ok('108. 保留的那条 id == 原 id（内容不重写）', part.keep[0]!.id === good.id, part.keep[0]!.id);
    const notArr = partitionModelIntents('nope', p);
    ok('109. 不是数组 → 一条都不保留、也不编出理由（由调用方按"没有意图"处理）', notArr.keep.length === 0 && notArr.dropped.length === 0);
  }
  {
    const taken = new Set<string>(['di_001', 'di_002']);
    const id = designIntentId(taken);
    ok('110. designIntentId 形式为 di_003（跳过已占用 id —— 撞 id 不会报错，只会静默共用记录）', id === 'di_003', id);
    const p = projWithIntents([{ ...statedRoom(), id: 'di_005' }]);
    ok('111. takenIntentIds(project) 读到项目里已占用的 id', takenIntentIds(p).has('di_005') === true && takenIntentIds(p).size === 1);
  }
}

// ═══════════════════════ §6 与 spatialContext 分离 ═══════════════════════
section('§6 与 spatialContext 分离：两个顶层键，互不嵌套');
{
  const p = projWithIntents([statedRoom(), candidateCab()]);
  const snap = buildSnapshot(p, RULES);
  ok(
    '112. 快照顶层同时有 spatialContext 与 designIntent（两个独立块）',
    'spatialContext' in snap && 'designIntent' in snap,
    Object.keys(snap)
  );
  ok(
    '113. ★ 互不嵌套：spatialContext 里没有 designIntent/intents，designIntent 里没有 spatialContext',
    !JSON.stringify(snap.spatialContext).includes('"designIntent"') &&
      !JSON.stringify(snap.spatialContext).includes('"intents"') &&
      !JSON.stringify(snap.designIntent).includes('"spatialContext"'),
    null
  );
  const block: AiDesignIntentContext = snap.designIntent;
  ok(
    '114. designIntent 块的键恰好 {readOnly, count, intents}（形状固定，多一个都要同时改这条断言）',
    JSON.stringify(Object.keys(block).sort()) === JSON.stringify(['count', 'intents', 'readOnly']),
    Object.keys(block)
  );
  ok('115. 两块都声明只读（readOnly === true）', block.readOnly === true && snap.spatialContext.readOnly === true);
  ok(
    '116. 只有 active 进块：模型里 1 条 active + 1 条 candidate → 块里只有 1 条，且 count 与数组长度一致',
    block.count === 1 && block.intents.length === 1 && block.count === block.intents.length,
    JSON.stringify({ count: block.count, ids: block.intents.map((i) => i.id) })
  );
  ok(
    '117. 块里每条都给 fact（判不出为 null）与 expect 人话（AI 知道该往哪个方向对账）',
    block.intents.every((i) => 'fact' in i && typeof i.expect === 'string' && i.expect.length > 0),
    JSON.stringify(block.intents.map((i) => [i.goal, i.fact]))
  );
  ok(
    '118. goalZh 与 goal 同源（人话只有一处出口）',
    block.intents.every((i) => i.goalZh === DESIGN_INTENT_GOALS[i.goal as never].zh),
    JSON.stringify(block.intents.map((i) => [i.goalZh, i.goal]))
  );
  {
    const empty = buildDesignIntentContext(baseProject());
    ok(
      '119. 空项目也给一个形状齐备的空块（不是 undefined —— 形状稳定才谈得上多轮可比）',
      empty.readOnly === true && empty.count === 0 && JSON.stringify(empty.intents) === '[]',
      JSON.stringify(empty)
    );
    const snap2 = buildSnapshot(baseProject(), RULES);
    ok('120. 空项目的快照里两个块也都在（不因"空"而消失）', 'designIntent' in snap2 && 'spatialContext' in snap2);
  }
  ok(
    '121. 确定性：同一份模型连构两次逐字节相同（排序稳定）',
    JSON.stringify(buildDesignIntentContext(p)) === JSON.stringify(buildDesignIntentContext(p))
  );
  ok('122. 纯投影：buildDesignIntentContext 只有 Project 一个入参（导入/识别的假设没有第二条注入口）', buildDesignIntentContext.length === 1, buildDesignIntentContext.length);
  {
    // 排序按词表顺序，与模型里的存入顺序无关
    const room = statedRoom(); // di_001 storage-priority（词表第 2）
    const cab = statedCab(); //  di_003 near-opening（词表第 7）
    const wall: DesignIntent = { ...candidateCab(), id: 'di_004', status: 'active', confirmedBy: 'user-confirmed' }; // wall-contact（词表第 4）
    const forward = buildDesignIntentContext(projWithIntents([room, cab, wall]));
    const backward = buildDesignIntentContext(projWithIntents([wall, cab, room]));
    ok(
      '123. ★ 排序按词表顺序（不按模型里的存入顺序）：反序存入也输出同一顺序',
      JSON.stringify(forward) === JSON.stringify(backward) &&
        forward.intents.length === 3 &&
        forward.intents[0]!.goal === 'storage-priority' &&
        forward.intents[1]!.goal === 'wall-contact' &&
        forward.intents[2]!.goal === 'near-opening',
      JSON.stringify(forward.intents.map((i) => [i.id, i.goal]))
    );
    ok(
      '124. 块与直接调用 buildDesignIntentContext 逐字节一致（快照里没有第二份实现）',
      JSON.stringify(buildSnapshot(projWithIntents([room, cab, wall]), RULES).designIntent) === JSON.stringify(forward)
    );
    ok(
      '125. spatialContext 仍由它自己算：与直接调 buildSpatialContext 逐字节一致（P9.1 未被本阶段改动）',
      JSON.stringify(buildSnapshot(p, RULES).spatialContext) === JSON.stringify(buildSpatialContext(p))
    );
  }
}

// ═══════════════════════ §7 不污染既有层 ═══════════════════════
section('§7 不污染 Cabinets / 几何 / 制造 / 清单 / schemaVersion');
{
  const p0 = baseProject();
  const p1 = projWithIntents([statedRoom()]);
  ok(
    '126. ★ 加了意图之后 cabinets 逐字节不变（意图不往柜体上挂任何东西）',
    JSON.stringify(p1.cabinets) === JSON.stringify(p0.cabinets)
  );
  {
    const block = buildDesignIntentContext(p1);
    /** 只扫块里的 intents（count 是唯一的数字字段，它是计数不是几何） */
    const hits: string[] = [];
    (function walk(n: unknown, path: string): void {
      if (Array.isArray(n)) {
        if ((n.length === 2 || n.length === 6) && n.every((v) => typeof v === 'number')) hits.push(`${path}=[${n.join(',')}]`);
        n.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        if (typeof o.x === 'number' && typeof o.y === 'number') hits.push(`${path}={x,y}`);
        for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
      }
    })(block.intents, 'designIntent.intents');
    ok('127. 意图载荷里没有 {x,y}、也没有长度 2/6 的数字数组', hits.length === 0, hits.slice(0, 6));
    ok(
      '128. 意图载荷里没有任何 number（除 count 这个计数）',
      (() => {
        const bads: string[] = [];
        (function walk(n: unknown, p2: string): void {
          if (typeof n === 'number') {
            bads.push(`${p2}=${n}`);
            return;
          }
          if (Array.isArray(n)) return n.forEach((v, i) => walk(v, `${p2}[${i}]`));
          if (n && typeof n === 'object') for (const [k, v] of Object.entries(n)) walk(v, `${p2}.${k}`);
        })(block.intents, 'intents');
        return bads.length === 0;
      })()
    );
    ok(
      '129. 载荷里没有 placement / rotation / envelope / pts / poly 这类几何键',
      !['placement', 'rotation', 'envelope', 'pts', 'poly', 'points', 'path'].some((k) => JSON.stringify(block).includes(`"${k}"`))
    );
  }
  {
    // 全快照扫描：{x,y} 只许出现在 cabinets[*].placement
    const snap = buildSnapshot(projWithIntents([statedRoom(), statedCab()]), RULES);
    const hits: string[] = [];
    (function walk(n: unknown, path: string): void {
      if (Array.isArray(n)) {
        if ((n.length === 2 || n.length === 6) && n.every((v) => typeof v === 'number')) hits.push(`${path}=[${n.join(',')}]`);
        n.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (n && typeof n === 'object') {
        const o = n as Record<string, unknown>;
        const isPlacement = /^snapshot\.cabinets\[\d+\]\.placement$/.test(path);
        if (!isPlacement && typeof o.x === 'number' && typeof o.y === 'number') hits.push(`${path}={x,y}`);
        for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
      }
    })(snap, 'snapshot');
    ok('130. ★ 全快照扫描：除 cabinets[*].placement 外没有任何 {x,y}（意图没带坐标进来）', hits.length === 0, hits.slice(0, 6));
  }
  {
    // 几何（DXF / 清单的共同上游）与意图无关
    const g0 = generateProject(baseProject(), RULES);
    const g1 = generateProject(projWithIntents([statedRoom()]), RULES);
    ok('131. ★ generateProject（几何派生的唯一上游）与意图无关：逐字节相同', JSON.stringify(g1) === JSON.stringify(g0));
  }
  {
    const p0 = baseProject();
    const p1 = projWithIntents([statedRoom()]);
    const g = generateProject(p0, RULES);
    const m0 = deriveManufacturing(p0, g, RULES);
    const m1 = deriveManufacturing(p1, g, RULES);
    ok(
      '132. ★ 制造层输出与意图无关：parts / stats / warnings 逐字节相同（意图不进生产）',
      JSON.stringify(m1) === JSON.stringify(m0),
      JSON.stringify([m0.stats.partCount, m1.stats.partCount])
    );
    /**
     * 中性导出自己带 `generatedAt` 时间戳（与 `serializeProjectFile` 的 `savedAt` 同源的坑），
     * 逐字节比较前必须把它摘掉 —— 否则测的是"两次调用间隔了 12 毫秒"，不是"意图有没有影响输出"。
     * 递归摘：这个时间戳**嵌在生成器信息块里**，只删顶层是不够的（第一次就踩到了）。
     */
    const strip = (v: unknown): string => {
      const o = JSON.parse(JSON.stringify(v)) as unknown;
      (function walk(n: unknown): void {
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === 'object') {
          const rec = n as Record<string, unknown>;
          delete rec.generatedAt;
          for (const v2 of Object.values(rec)) walk(v2);
        }
      })(o);
      return JSON.stringify(o);
    };
    const n0 = toNeutralExport(p0, RULES, ['plan', 'sheet'], '0.2');
    const n1 = toNeutralExport(p1, RULES, ['plan', 'sheet'], '0.2');
    ok(
      '133. ★ 清单（neutral export，DXF/开料单的输入）与意图无关：除去生成时间戳后逐字节相同',
      strip(n1) === strip(n0),
      { 有意图: strip(n1).length, 无意图: strip(n0).length }
    );
  }
  {
    const src = ['src/core/manufacturing/derive.ts', 'src/core/manufacturing/model.ts', 'src/core/manufacturing/bridge.ts']
      .map((f) => readFileSync(join(APP, f), 'utf8'))
      .join('\n');
    ok('134. 制造层源码里不出现 designIntent（没有反向依赖）', !src.includes('designIntent'), (src.match(/.*designIntent.*/g) ?? []).slice(0, 3));
  }
  {
    // 文件层：含意图往返逐字节相同、schemaVersion 不升
    const text = serializeProjectFile(projWithIntents([statedRoom()]), FIXED_SAVED_AT);
    const rt = parseProjectFile(text);
    ok('135. 含意图的项目文件往返成功，且意图 1 条保留', rt.ok === true && rt.project.designIntents?.length === 1, rt.ok ? JSON.stringify(rt.project.designIntents?.length) : rt.error);
    ok('136. ★ 含意图往返**逐字节相同**（意图是稳定结构，不是会被洗掉的临时态）', rt.ok && serializeProjectFile(rt.project, FIXED_SAVED_AT) === text);
    ok(
      '137. ★ schemaVersion 仍是 0.2（设计意图今天没有执行体：旧读者忽略它时设计结果逐位相同 → 没有静默做错事的风险 → 不升版）',
      rt.ok && (JSON.parse(text).project as { schemaVersion: string }).schemaVersion === '0.2',
      JSON.stringify(rt.ok ? (JSON.parse(text).project as { schemaVersion: string }).schemaVersion : null)
    );
  }
  {
    // 无意图的旧文件：逐字节不变，且键根本不出现
    const plain = serializeProjectFile(baseProject(), FIXED_SAVED_AT);
    const rt = parseProjectFile(plain);
    ok('138. 无意图的旧文件往返逐字节不变（存量文件零 diff）', rt.ok && serializeProjectFile(rt.project, FIXED_SAVED_AT) === plain);
    ok('139. ★ 无意图的文件里**不出现** designIntents 键（缺省即没有，不写空数组）', !('designIntents' in (JSON.parse(plain).project as object)));
    ok('140. 解析后也不凭空长出 designIntents（属性都进了 JSON —— 不是 undefined 冒充）', rt.ok && !JSON.stringify(rt.project).includes('designIntents'));
  }
  {
    const p = baseProject();
    const good = statedRoom();
    const file = {
      format: 'furniture-cad-project',
      formatVersion: 1,
      savedAt: FIXED_SAVED_AT,
      project: {
        ...p,
        designIntents: [
          good,
          { ...candidateCab(), id: 'di_920' },
          { ...good, id: 'di_921', scope: { kind: 'cabinet', cabinetId: 'c_missing' } },
          { ...good, id: 'di_922', status: 'active', confirmedBy: undefined },
        ],
      },
    };
    const rt = parseProjectFile(JSON.stringify(file));
    ok(
      '141. ★ 文件里的坏意图被**丢弃**（不是让整个项目打不开）：4 条只留 1 条',
      rt.ok === true && rt.project.designIntents?.length === 1,
      rt.ok ? JSON.stringify(rt.project.designIntents?.length) : rt.error
    );
    ok(
      '142. 每条丢弃都变成一条可读警告（用户看得见"少知道了什么"）',
      rt.ok && rt.warnings.filter((w) => w.includes('设计意图被丢弃')).length === 3,
      rt.ok ? JSON.stringify(rt.warnings) : rt.error
    );
  }
  {
    const p = baseProject();
    const file = { format: 'furniture-cad-project', formatVersion: 1, savedAt: FIXED_SAVED_AT, project: { ...p, designIntents: 'oops' } };
    const rt = parseProjectFile(JSON.stringify(file));
    ok(
      '143. designIntents 不是数组 → 警告 + 按"没有任何设计意图"处理（键被抹掉，存盘不会把垃圾写回）',
      rt.ok === true && rt.warnings.some((w) => w.includes('不是数组')) && rt.project.designIntents === undefined,
      rt.ok ? JSON.stringify(rt.warnings) : rt.error
    );
  }
  {
    // 抹掉而不是留着：一个系统认不出的意图不应在存盘时写回文件
    const p = baseProject();
    const file = { format: 'furniture-cad-project', formatVersion: 1, savedAt: FIXED_SAVED_AT, project: { ...p, designIntents: [{ ...candidateCab() }] } };
    const rt = parseProjectFile(JSON.stringify(file));
    ok(
      '144. ★ 被丢弃的意图**不会**被存回文件（留着会让垃圾越写越多、并且下次仍然认不出）',
      rt.ok === true && !serializeProjectFile(rt.project, FIXED_SAVED_AT).includes('"designIntents"'),
      rt.ok ? serializeProjectFile(rt.project, FIXED_SAVED_AT).includes('designIntents') : rt.error
    );
  }
}

// ═══════════════════════ §8 架构：纯语义层与依赖方向 ═══════════════════════
section('§8 架构：纯语义层、依赖方向、不新增几何判断');
{
  const files = ['vocabulary.ts', 'model.ts', 'validate.ts', 'index.ts'];
  const ALLOWED = new Set(['./vocabulary.ts', './model.ts', './validate.ts', '../types.ts', '../ids.ts']);
  const problems: string[] = [];
  const specsAll: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(APP, 'src/core/designIntent', f), 'utf8');
    // 只取代码行（去掉注释行）后再匹配 `from '…'` —— 多行 import 的 from 在续行上，
    // 只扫"以 import 开头的行"会漏检，那样依赖方向断言就是假绿。
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');
    for (const m of code.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1]!;
      specsAll.push(`${f}:${spec}`);
      if (!ALLOWED.has(spec)) problems.push(`${f}: ${spec}`);
    }
  }
  ok(
    '145. ★ 依赖方向：designIntent 层只从同层文件 / types.ts / ids.ts 取数（来源逐条核对，不是"包含即通过"）',
    problems.length === 0,
    problems
  );
  ok(
    '146. ★ 只 import 这 5 个来源，一个不多（几何 / 空间 / 落位 / 校验 / 导出 / 制造 / 知识 / 命令总线 / AI 一个都没进来）',
    (() => {
      const distinct = new Set(specsAll.map((s) => s.slice(s.indexOf(':') + 1)));
      return distinct.size === ALLOWED.size && [...ALLOWED].every((a) => distinct.has(a));
    })(),
    specsAll
  );
  {
    /**
     * 这里刻意**不再扫原文**：词表里逐字写着 `file: 'core/spatial/derive.ts'` 这类**事实维度名**，
     * 扫原文会把"引用一个名字"误判成"依赖那个模块" —— 那正是"同一能力两处判断"的反面：
     * 本层的纪律是**只借名字、不调函数**，所以判据必须是 import 说明符，不是文本。
     */
    const all = files.map((f) => readFileSync(join(APP, 'src/core/designIntent', f), 'utf8')).join('\n');
    const code = all
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');
    const specs = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    ok(
      '147. ★ 依赖里没有一处几何 / 空间 / 落位 / 校验 / 制造 / 命令总线 / 知识（"意图不新增几何判断"没法违反）',
      !specs.some((s) => /geometry|\/spatial\/|placement|designValidation|\/export\/|manufacturing|knowledge|commandBus|\/ai\/|\/vision\/|\/import\//.test(s)),
      specs
    );
    ok('148. 本层没有一处三角函数（不新增几何判断 ⇒ 也不做几何计算）', !/Math\.(sin|cos|tan|atan2)\b/.test(code));
    ok('149. 本层没有随机与性能时钟（无 Math.random / performance.now）', !/Math\.random|performance\.now/.test(code));
    ok('150. 本层不 import 规则层与报错目录（不新增任何 issue 码 —— 判定仍归事实层与规则层）', !specs.some((s) => /issueCatalog|rules\/|ruleSet/.test(s)), specs);
  }
  {
    const src = readFileSync(join(APP, 'src/ai/designIntentContext.ts'), 'utf8');
    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');
    const specs = [...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]!);
    ok(
      '151. ★ AI 只读投影只从 core/designIntent 与 core/types 取数（恰好 3 个来源：model / vocabulary / types）',
      specs.length === 3 &&
        specs.includes('../core/designIntent/model.ts') &&
        specs.includes('../core/designIntent/vocabulary.ts') &&
        specs.includes('../core/types.ts'),
      JSON.stringify(specs)
    );
    ok(
      '152. 投影不 import 几何 / 空间 / 落位 / 命令总线 / 知识（纯投影，无副作用）',
      !specs.some((s) => /geometry|spatial|placement|commandBus|knowledge|designValidation|export|manufacturing/.test(s)),
      JSON.stringify(specs)
    );
    ok('153. 投影不自己算距离：源码里没有三角函数、没有 Math.sqrt', !/Math\.(sin|cos|tan|atan2|sqrt|hypot)\b/.test(code));
  }
  {
    const snap = buildSnapshot(projWithIntents([statedRoom(), statedCab()]), RULES);
    ok(`154. 快照体积仍在预算内（< 40000 字节，当前 ${snapshotBytes(snap)}）`, snapshotBytes(snap) < 40_000, `${snapshotBytes(snap)} bytes`);
    ok(
      '155. 旧白名单不变量不破：快照里仍不出现任何派生字段名',
      (() => {
        const json = JSON.stringify(snap);
        return ['derived', 'panels', 'issues', 'geom', 'views', 'assembly', 'explode', 'hardware', 'legend', 'price', 'cut'].every((k) => !json.includes(`"${k}"`));
      })()
    );
  }
  {
    const dump: string[] = [];
    (function walk(n: unknown, p: string): void {
      if (n && typeof n === 'object' && !Array.isArray(n)) for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
        dump.push(`${p}.${k}`);
        walk(v, `${p}.${k}`);
      }
    })(buildDesignIntentContext(projWithIntents([statedRoom(), statedCab()])), 'designIntent');
    ok(
      '156. 块里的字段名全在预期集合内（没有多出来的形状）',
      dump.every((d) =>
        /^designIntent\.(count|readOnly|intents|intents\[\d+\])/.test(d) ||
        /^designIntent\.intents\[\d+\]\.(id|goal|goalZh|scope|roomId|cabinetId|openingKind|statement|origin|fact|expect)$/.test(d)
      ),
      dump.filter((d) => !/^designIntent\.(count|readOnly|intents)/.test(d)).slice(0, 10)
    );
  }
  {
    const pkg = JSON.parse(readFileSync(join(APP, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    ok(
      '157. ★ 已接进 verify:all（脚本没接进链路等于不存在）',
      typeof pkg.scripts['verify:design-intent'] === 'string' && /verify:design-intent/.test(pkg.scripts['verify:all'] ?? ''),
      { hasScript: typeof pkg.scripts['verify:design-intent'], inAll: /verify:design-intent/.test(pkg.scripts['verify:all'] ?? '') }
    );
  }
}

console.log(`\n═══ P9.2 Spatial Design Intent Vocabulary 验收：通过 ${passed} / 失败 ${failed} ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
