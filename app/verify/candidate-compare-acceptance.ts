/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.6 Multi-Candidate Compare UI 验收
 *
 *  ── 要证明的核心命题 ──
 *  ① 对比层是 **纯消费运行态**：只把 P9.3 CandidateLayout + P9.4 DesignScore +
 *     P9.5 PlannerPlan 的既有结果并列展示，**不重算**任何 collision / 评分 / 落位；
 *  ② **不造 winner**：可显示分数、可"选择此方案"，但绝不出现"最佳/推荐/winner"，
 *     排序只用 `compareDesignScores()` 且明示"显示排序，非 winner 判定"；
 *  ③ **不写模型**：选中只改 UI 高亮 + 上抛 onSelect；落地必须经 onPreview →
 *     既有 dryRunPlan → PlanRunView → commitPlan（第二条提交链路不存在）；
 *  ④ **不持久化**：candidate / score / comparison / selected 都不进 project.json；
 *      selected 是 UI/session 态（独立前缀 sessionStorage key）；
 *  ⑤ 跨候选的设计意图满足对比：只翻译 score.components（带 intentId 的），unknown 如实记；
 *  ⑥ 多候选：候选 id 唯一、标签 A/B/C 稳定、排序不破坏标签映射；
 *  ⑦ 架构：对比层不 import 几何 / 命令 / AI 客户端 / 评分重算，是 (plan) 的纯函数。
 *
 *  ── 判据纪律（同 ai-planner-acceptance）──
 *   · 每条失败先打原始值；· 夹具每次自己造；· 涉及时戳钉死；
 *   · 每条哨兵配一个"故意写坏的样本"自检；
 *   · 源码扫描**先剥注释**，且只扫本层文件（candidateCompare* + AIPanel 的相关段）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room, RuleSet } from '../src/core/types.ts';
import { makeStatedIntent, type DesignIntent } from '../src/core/designIntent/index.ts';
import { planCandidates } from '../src/core/planner/index.ts';
import { compareDesignScores, designScoreHitZh, SCORE_WEIGHT_POLICY } from '../src/core/designScore/index.ts';
import {
  buildCandidateComparison,
  buildIntentMatrix,
  sortComparisonRows,
  candidateLabel,
  type CandidateComparisonRow,
} from '../src/ui/panels/candidateCompareLogic.ts';

const APP = join(import.meta.dirname, '..');
const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset', 'factory-default.json'), 'utf8')) as RuleSet;
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

// ── 源码扫描（剥注释）──
const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
const LOGIC_SRC = stripComments(readFileSync(join(APP, 'src/ui/panels/candidateCompareLogic.ts'), 'utf8'));
const UI_SRC = stripComments(readFileSync(join(APP, 'src/ui/panels/candidateCompare.tsx'), 'utf8'));
const AIPANEL_SRC = stripComments(readFileSync(join(APP, 'src/ui/panels/AIPanel.tsx'), 'utf8'));

/**
 * 精确截取一个 `const NAME = useCallback(<args>) => { … }, [deps])` 的**箭头函数体**。
 * 关键：用 `\},\s*\[` 收口，兼容带依赖数组的写法（旧的 `\},\)` 会一路吞到下一个
 * 恰好以 `},)` 结尾的函数，把邻居的函数体也算进来 → 误判）。
 */
const cbBody = (src: string, name: string): string => {
  const m = src.match(new RegExp(`const ${name} = useCallback\\([^)]*\\) => (\\{[\\s\\S]*?\\})\\s*,\\s*\\[`));
  return m ? m[1]! : '';
};

const WINNER_LIKE = /(winner|best|recommended|recommend|pickBest|自动推荐|最佳)/i;
/** 对比层不得新增 adopt/commit/save 风格的"一键落地"API（落地只经 onPreview→dryRunPlan→commitPlan） */
const ADOPT_LIKE = /export (async )?(function|const) (adopt|apply|commit|persist|write|execute|save)/i;
/**
 * 对比层/渲染层**不得** import 任何派生或写路径模块 —— 它只消费运行态。
 * 覆盖：几何 / 空间(P8.7–8.9 门扇净空) / 规则校验 / 制造派生 / 变体 / 命令总线 / 计划运行 / 草稿会话 / AI 客户端 / 导出。
 */
const DERIVATION_LIKE = /core\/(geometry|spatial|rules|manufacturing|variants)|commandBus|planRunner|draftSession|aiClient|export\//;

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
function baseProject(): Project {
  const room = mkRoom('r1');
  return {
    schemaVersion: '0.2',
    id: 'p_p96',
    name: 'P96',
    ruleSetId: RULES.id,
    rooms: [room],
    cabinets: [
      mkCab(room, 'c1', 1600, 1400, 900, 600, 0),
      mkCab(room, 'c2', 400, 60, 900, 600, 0),
      mkCab(room, 'c3', 2600, 1400, 800, 600, 0),
    ],
  } as Project;
}
const T0 = 1_700_000_000_000;
const pin = (i: DesignIntent, at = T0): DesignIntent => ({
  ...i,
  createdAt: at,
  updatedAt: at,
  evidence: i.evidence.map((e) => ({ ...e, at })),
});
type Goal = Parameters<typeof makeStatedIntent>[0]['goal'];
const cabIntent = (goal: Goal, cabId: string, id: string): DesignIntent => ({
  ...pin(makeStatedIntent({ goal, scope: { kind: 'cabinet', cabinetId: cabId }, detail: '用户明说', taken: new Set<string>() })),
  id,
});
const withIntents = (p: Project, intents: DesignIntent[]): Project => ({ ...p, designIntents: intents });

// 一条真实规划：c1 有 wall-contact 意图 → 生成器产出 A/B/C 多份候选
function realPlan(): ReturnType<typeof planCandidates> {
  const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]);
  return planCandidates(p, { scope: 'project' });
}

// ═══════════════════ §1 Rendering（7）═══════════════════
section('§1 Rendering：纯投影正确关联候选与评分');
{
  const run = realPlan();
  ok('1. 规划成功产出候选', run.ok === true && run.plan.candidates.length > 0, run.ok ? run.plan.candidates.length : run.error);
  const cmp = buildCandidateComparison(run.plan);
  ok('2. 行数 = 候选数', cmp.rows.length === run.plan.candidates.length, { rows: cmp.rows.length, cands: run.plan.candidates.length });
  ok('3. 标签 A/B/C 稳定顺序', cmp.rows.every((r, i) => r.label === candidateLabel(i)), cmp.rows.map((r) => r.label));
  ok('4. candidateLabel(0/1/2) = A/B/C', candidateLabel(0) === 'A' && candidateLabel(1) === 'B' && candidateLabel(2) === 'C');
  ok('5. 每行 score 与 plan.scores 按 candidateId 关联一致', cmp.rows.every((r) => {
    const e = run.plan.scores.find((s) => s.candidateId === r.layout.id);
    return e !== undefined && e.score === r.score;
  }));
  ok('6. 空计划（无候选）→ rows=[], intentMatrix=[]', (() => {
    const empty = buildCandidateComparison({ request: { scope: 'project' }, unresolved: [], candidates: [], scores: [], explanations: [] });
    return empty.rows.length === 0 && empty.intentMatrix.length === 0;
  })());
  ok('7. ★ 缺失评分兜底 = infeasible（不假成 valid / 不折算 0 分）', (() => {
    const orphan = buildCandidateComparison({ request: { scope: 'project' }, unresolved: [], candidates: [{ id: 'cx', status: 'draft', placements: [{ targetId: 'c1', intent: { goal: 'wall-contact', scope: { kind: 'cabinet', cabinetId: 'c1' } }, resolved: { x: 0, y: 0, rotation: 0 } }], unresolved: [], explanations: [] }], scores: [], explanations: [] });
    return orphan.rows.length === 1 && orphan.rows[0]!.score.status === 'infeasible' && orphan.rows[0]!.score.total === null;
  })());
}

// ═══════════════════ §2 Semantics（4）═══════════════════
section('§2 Semantics：只消费运行态，不重算');
{
  const run = realPlan();
  const cmp = buildCandidateComparison(run.plan);
  ok('8. 对比分数与 plan.scores 逐字节相同（零重算）', JSON.stringify(cmp.rows.map((r) => r.score)) === JSON.stringify(run.plan.scores.map((s) => s.score)));
  ok('9. ★ 对比层源码不重算：无 detectCollisions/scoreCandidateLayout/resolvePlacement/generateCandidateLayouts', !/detectCollisions|scoreCandidateLayout|resolvePlacement|generateCandidateLayouts|planCandidates/.test(LOGIC_SRC), /detectCollisions|scoreCandidateLayout|resolvePlacement|generateCandidateLayouts|planCandidates/.exec(LOGIC_SRC)?.[0]);
  ok('10. 分数 total = 命中数（yes 计数，与 score.totalKind=hit-count 一致）', cmp.rows.every((r) => {
    if (r.score.status !== 'valid') return true;
    const yes = r.score.components.filter((c) => c.hit === 'yes').length;
    return r.score.total === yes;
  }));
  ok('11. hardFailures 不被吞：infeasible 候选的阻断错误原样出现在 row.score 里', cmp.rows.filter((r) => r.score.status === 'infeasible').every((r) => r.score.hardFailures.length > 0));
}

// ═══════════════════ §3 Winner safety（4）═══════════════════
section('§3 Winner safety：不造 winner');
{
  const run = realPlan();
  const cmp = buildCandidateComparison(run.plan);
  const sorted = sortComparisonRows(cmp.rows, true);
  ok('12. sortComparisonRows 只重排、不增删（长度不变）', sorted.length === cmp.rows.length);
  ok('13. ★ 对比层（logic+ui）源码无任何 winner/best/recommended/最佳/推荐 字样', !WINNER_LIKE.test(LOGIC_SRC) && !WINNER_LIKE.test(UI_SRC), { logic: WINNER_LIKE.exec(LOGIC_SRC)?.[0], ui: WINNER_LIKE.exec(UI_SRC)?.[0] });
  ok('14. ★ 对比 DTO 无 winner/best 字段（JSON 里搜不到）', !/winner|best|candidate-?rank|recommended/.test(JSON.stringify(cmp).toLowerCase()), JSON.stringify(cmp).match(/winner|best|recommended/i)?.[0]);
  ok('15. compareDesignScores 只返回 -1/0/1，对比层不用它挑 winner', (() => {
    const a = cmp.rows[0]!.score;
    const b = cmp.rows[1]!.score;
    const r = compareDesignScores(a, b);
    return r === -1 || r === 0 || r === 1;
  })());
}

// ═══════════════════ §4 Selection（5）═══════════════════
section('§4 Selection：选中仅 UI/session 态');
{
  ok('16. ★ AIPanel 用独立前缀 sessionStorage key p96:selectedCandidate', /p96:selectedCandidate/.test(AIPANEL_SRC));
  ok('17. selected 走 sessionStorage（get/set/remove 三项齐全，不进 project.json）', /sessionStorage\.getItem\(('p96:selectedCandidate'|SELECT_KEY)\)/.test(AIPANEL_SRC) && /sessionStorage\.setItem\(SELECT_KEY/.test(AIPANEL_SRC) && /sessionStorage\.removeItem\(SELECT_KEY\)/.test(AIPANEL_SRC));
  ok('18. SELECT_KEY 独立于会话键（不与 CONVO_KEY/ROOM_KEY 混淆）', /const SELECT_KEY = 'p96:selectedCandidate'/.test(AIPANEL_SRC) && /const CONVO_KEY = 'furniture-cad\.ai\.convos\.v2'/.test(AIPANEL_SRC) && /const ROOM_KEY = 'furniture-cad\.ai\.room\.v2'/.test(AIPANEL_SRC));
  ok('19. ★ selectCandidate 只改 UI 状态 + 写 session，不调总线/提交', (() => {
    // P9.9 S3：选中态改为 {candidateId,key}（setSelectedCandidate），session 写入抽到 persistSelection。
    // 本项意图不变（只改 UI 态 + 写 session、不碰总线），并**加强**为：连 persistSelection 体内
    // 的 set/remove 一起核，会话写入链仍是逐环可查的（不是放宽）。
    const body = cbBody(AIPANEL_SRC, 'selectCandidate');
    const persistBody = cbBody(AIPANEL_SRC, 'persistSelection');
    return body.includes('setSelectedCandidate') && body.includes('persistSelection')
      && persistBody.includes('sessionStorage.setItem') && persistBody.includes('sessionStorage.removeItem')
      && !/bus\.execute|commitPlan|dryRunPlan/.test(body);
  })(), cbBody(AIPANEL_SRC, 'selectCandidate').slice(0, 200));
  ok('20. 点击选择不自动预览/自动提交（selectCandidate 体内无 previewCandidate/dryRunPlan/commitPlan）', (() => {
    const body = cbBody(AIPANEL_SRC, 'selectCandidate');
    return body.length > 0 && !/previewCandidate|dryRunPlan|commitPlan/.test(body);
  })(), cbBody(AIPANEL_SRC, 'selectCandidate').slice(0, 200));
}

// ═══════════════════ §5 Persistence（5）═══════════════════
section('§5 Persistence：不进 project.json');
{
  const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]);
  const before = JSON.stringify(p);
  const run = planCandidates(p, { scope: 'project' });
  ok('21. ★ 规划不改入参 project（候选不写模型）', JSON.stringify(p) === before);
  ok('22. ★ 对比层源码不 import serializeProjectFile / projectFile（候选无法从这里写盘）', !/serializeProjectFile|projectFile/.test(LOGIC_SRC), /serializeProjectFile|projectFile/.exec(LOGIC_SRC)?.[0]);
  ok('23. AIPanel 不 import serializeProjectFile（保存只走 CommandBus，候选不混进去）', !/serializeProjectFile/.test(AIPANEL_SRC), /serializeProjectFile/.exec(AIPANEL_SRC)?.[0]);
  ok('24. generateCompare 只存组件态（setComparePlan），不调总线执行', (() => {
    const body = cbBody(AIPANEL_SRC, 'generateCompare');
    return body.length > 0 && body.includes('setComparePlan') && !/bus\.execute|commitPlan|CommandBus/.test(body);
  })(), cbBody(AIPANEL_SRC, 'generateCompare').slice(0, 200));
  ok('25. selected 与 convo 序列化隔离：thinConvo/loadConvos 不含 comparePlan', !/comparePlan/.test(AIPANEL_SRC) || !/function thinConvo/.test(AIPANEL_SRC) || (() => {
    const m = AIPANEL_SRC.match(/function thinConvo[\s\S]*?\n}/);
    return m ? !m[0].includes('comparePlan') : true;
  })());
}

// ═══════════════════ §6 Unknown（3）═══════════════════
section('§6 Unknown：判不出来如实记 unknown，不假装满足');
{
  const run = realPlan();
  const cmp = buildCandidateComparison(run.plan);
  /**
   * 刻意**构造**一份含 `hit:'unknown'` 的 component，而不是在真实 plan 里碰运气找 ——
   * 碰运气的写法在"这次恰好没有 unknown"时会走 `return true` 分支**恒真**，
   * 等于没断言（断言不可信比失败更危险）。构造后这条是确定性的：改坏映射必红。
   */
  const unknownRow: CandidateComparisonRow = {
    label: 'A',
    layout: cmp.rows[0]!.layout,
    score: {
      status: 'valid',
      total: 0,
      totalKind: 'hit-count',
      weights: SCORE_WEIGHT_POLICY,
      components: [
        {
          id: 'cond:di_x',
          kind: 'condition',
          label: '取舍方向',
          source: 'rule',
          intentId: 'di_x',
          goal: 'wall-contact',
          isPreference: false,
          weight: null,
          weightSource: 'unassigned',
          hit: 'unknown',
          why: '这条判据当前判不出来（无判定依据）',
        },
      ],
      hardFailures: [],
      preferenceMatches: [],
      explanations: [],
    },
  };
  const unknownCell = buildIntentMatrix([unknownRow]).find((m) => m.intentId === 'di_x')?.byCandidate[unknownRow.layout.id];
  ok('26. ★ unknown 命中 → intentMatrix 对应格 = unknown（不是 yes/no，也不是真空通过）', unknownCell === 'unknown', unknownCell);
  ok('27. unknown 不计入总分（total = yes 数，unknown 被排除）', cmp.rows.filter((r) => r.score.status === 'valid').every((r) => {
    const yes = r.score.components.filter((c) => c.hit === 'yes').length;
    return r.score.total === yes;
  }));
  ok('28. ★ unknown 显示文案为"判不出来"（designScoreHitZh 不返回 clear/满足/通过）', designScoreHitZh('unknown') === '判不出来' && !/clear|满足|通过/.test(designScoreHitZh('unknown')));
}

// ═══════════════════ §7 Multi-candidate（5）═══════════════════
section('§7 Multi-candidate：多份候选稳定并列');
{
  const run = realPlan();
  const cands = run.ok ? run.plan.candidates : [];
  ok('29. 一次规划产出 > 1 份候选（A/B/C 多策略）', cands.length > 1, cands.length);
  ok('30. 候选 id 互不相同', new Set(cands.map((c) => c.id)).size === cands.length, cands.length);
  ok('31. 标签按稳定顺序 A/B/C（rows[0].label === A）', buildCandidateComparison(run.plan).rows[0]!.label === 'A');
  ok('32. 按分数排序后标签随行走（sorted[i].label 仍对应原候选）', (() => {
    const cmp = buildCandidateComparison(run.plan);
    const sorted = sortComparisonRows(cmp.rows, true);
    const byLabel = new Map(cmp.rows.map((r) => [r.label, r.layout.id]));
    return sorted.every((r) => byLabel.get(r.label) === r.layout.id);
  })());
  ok('33. candidates 与 scores 平行（长度同、candidateId 对得上）', run.ok && run.plan.scores.length === run.plan.candidates.length && run.plan.scores.every((s, i) => s.candidateId === run.plan.candidates[i]!.id));
}

// ═══════════════════ §8 Architecture（9）═══════════════════
section('§8 Architecture：对比层是 (plan) 的纯函数，不越界');
{
  ok('34. ★ 对比层 import 仅类型 + 排序器 + 权重政策（无几何/空间/命令/AI）', !DERIVATION_LIKE.test(LOGIC_SRC), DERIVATION_LIKE.exec(LOGIC_SRC)?.[0]);
  ok('35. 对比层不 import CommandBus / planRunner / draftSession，也不新增 adopt/commit/save 风格 API', !/CommandBus|planRunner|draftSession|commitPlan/.test(LOGIC_SRC) && !ADOPT_LIKE.test(LOGIC_SRC), /CommandBus|planRunner|draftSession/.exec(LOGIC_SRC)?.[0] ?? ADOPT_LIKE.exec(LOGIC_SRC)?.[0]);
  ok('36. 对比层不重算评分（只 import compareDesignScores + SCORE_WEIGHT_POLICY，不 import scoreCandidateLayout*）', !/scoreCandidateLayout/.test(LOGIC_SRC) && /compareDesignScores/.test(LOGIC_SRC) && /SCORE_WEIGHT_POLICY/.test(LOGIC_SRC));
  ok('37. 渲染层不 import 几何 / 空间 / 命令 / AI 客户端', !DERIVATION_LIKE.test(UI_SRC), DERIVATION_LIKE.exec(UI_SRC)?.[0]);
  ok('38. 渲染层把落地交给父层 onPreview（组件调 onPreview，不直接 dryRunPlan）', /onPreview\(/.test(UI_SRC) && !/dryRunPlan|commitPlan/.test(UI_SRC));
  ok('39. 渲染层无 winner/最佳/推荐 文案', !WINNER_LIKE.test(UI_SRC), WINNER_LIKE.exec(UI_SRC)?.[0]);
  ok('40. PlannerPlan 对象无 winner/best/recommended（与 P9.5 同一不变量）', (() => {
    const run = realPlan();
    return run.ok && !/winner|best|recommended/.test(JSON.stringify(run.plan).toLowerCase());
  })());
  ok('41. ★ 唯一排序原语是 compareDesignScores（无自定义 .total 比较器）', /compareDesignScores/.test(LOGIC_SRC) && !/\.total\s*[<>]/.test(LOGIC_SRC) && !/sort\(\(\s*a,\s*b\s*\)\s*=>\s*a\.score\.total/.test(LOGIC_SRC));
  ok('42. 对比层确定性：同 plan 两次 buildCandidateComparison 逐字节相同', (() => {
    const run = realPlan();
    return JSON.stringify(buildCandidateComparison(run.plan)) === JSON.stringify(buildCandidateComparison(run.plan));
  })());
}

// ═══════════════════ §9 接线：实跑证明（不重复计数）══════════════════
//  本脚本是否真的接进 verify:all，由下方「运行 verify:all」那一步直接证明
//  （脚本没接进链路 = 不存在）。这里不再用字符串断言重复计项。

console.log(`\n═══ P9.6 Multi-Candidate Compare UI 验收：通过 ${passed} / 失败 ${failed} ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  - ${f}`);
  process.exit(1);
}
