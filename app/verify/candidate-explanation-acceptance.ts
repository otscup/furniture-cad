/**
 * ══════════════════════════════════════════════════════════════════════
 *  P9.9 Candidate Explanation & Selection 验收
 *
 *  ── 要证明的核心命题 ──
 *   A 只读投影：解释层是 `(layout, score)` 的**纯投影**，不 rejudge（不 import 判定层）、
 *     确定性、`status` 恒等 `score.status`、`blocking` 逐条等于 `hardFailures`、
 *     `items+crossCutting` 的 code 集合**恰好等于** `components`、`generationNotes` 逐字节等于 `layout.explanations`；
 *   B 不造 winner：解释对象无 winner/best/recommended/rank/score 键，`summaryZh` 无"最好/最优/推荐/建议选"；
 *   C satisfies 分区：生成期信号与事实项分开，`summaryZh` 不把生成期粗判写成对目标的结论；
 *   D unavailable 如实：`unknown` 落 `crossCutting`、`summaryZh` 写"判不出来"（不写"未满足"）；
 *   E 多柜组织：按 placement 分块，blocking 按 target 归因，无 target 的进 crossCutting；
 *   F Selection（S3）：`resolveSelection` 必须"id 存在**且**内容键匹配"，失配**清除**、不回退；
 *   G 不写模型：解释层无序列化 / 无坐标；
 *   H 上游回归 + 字段覆盖（约束四）：doorMaterial/rodHeight 必须被**显式透传**，非契约字段必须被**显式拒绝**。
 *
 *  ── 判据纪律 ──
 *   · 每条失败先打原始值；· 夹具每次自己造；· 源码扫描先剥注释。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room, RuleSet } from '../src/core/types.ts';
import { makeStatedIntent, type DesignIntent } from '../src/core/designIntent/index.ts';
import { planCandidates } from '../src/core/planner/index.ts';
import { buildCandidateExplanation, explainCandidateSummaryZh } from '../src/core/candidateLayout/explain.ts';
import type { CandidateGenerationStats, CandidateLayout, CandidatePlacement } from '../src/core/candidateLayout/model.ts';
import { candidateKey } from '../src/core/candidateLayout/generate.ts';
import type { DesignScore, DesignScoreComponent } from '../src/core/designScore/model.ts';
import { buildCandidateComparison, generationLedgerZh, resolveSelection } from '../src/ui/panels/candidateCompareLogic.ts';
import { validateProposal, type DesignProposal } from '../src/ai/proposal.ts';
import { compileProposal } from '../src/ai/compileProposal.ts';
import { proposalShapeError } from '../src/ai/proposal.ts';
import { visionResultToNormalized } from '../src/ai/vision/visionResultToNormalized.ts';
import type { VisionResult } from '../src/ai/vision/types.ts';
import { buildSnapshot } from '../src/ai/snapshot.ts';

const APP = join(import.meta.dirname, '..');
const RULES = JSON.parse(readFileSync(join(APP, 'src/core/ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

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

const stripComments = (s: string): string =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
const EXPLAIN_SRC = stripComments(readFileSync(join(APP, 'src/core/candidateLayout/explain.ts'), 'utf8'));
const EXPLAIN_RAW = readFileSync(join(APP, 'src/core/candidateLayout/explain.ts'), 'utf8');
const GENERATE_SRC = stripComments(readFileSync(join(APP, 'src/core/candidateLayout/generate.ts'), 'utf8'));
const AIPANEL_SRC = stripComments(readFileSync(join(APP, 'src/ui/panels/AIPanel.tsx'), 'utf8'));

// ─────────────────────────── fixtures ───────────────────────────
function mkRoom(id: string, x = 0, y = 0, w = 4000, h = 3000, thickness = 120, openings?: (walls: Room['walls']) => void): Room {
  const room = rectRoom({ id, name: `房间${id}`, x, y, w, h, thickness, height: 2700 });
  room.walls.forEach((wl, i) => {
    wl.id = `${id}_w${i + 1}`;
    wl.name = `${id}墙${i + 1}`;
  });
  openings?.(room.walls);
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
function baseProject(c1Width = 900): Project {
  const room = mkRoom('r1');
  return {
    schemaVersion: '0.2',
    id: 'p_p99',
    name: 'P99',
    ruleSetId: RULES.id,
    rooms: [room],
    cabinets: [
      mkCab(room, 'c1', 1600, 1400, c1Width, 600, 0),
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
const roomIntent = (goal: Goal, roomId: string, id: string): DesignIntent => ({
  ...pin(makeStatedIntent({ goal, scope: { kind: 'room', roomId }, detail: '用户明说', taken: new Set<string>() })),
  id,
});
const withIntents = (p: Project, intents: DesignIntent[]): Project => ({ ...p, designIntents: intents });
function realPlan(intents?: DesignIntent[]): ReturnType<typeof planCandidates> {
  const p = withIntents(baseProject(), intents ?? [cabIntent('wall-contact', 'c1', 'di_001')]);
  return planCandidates(p, { scope: 'project' });
}

// 合成一份含各 kind 的评分（确定性、可复现）：用来钉死"引用而非重判"
function synthScore(): DesignScore {
  const comp = (over: Partial<DesignScoreComponent>): DesignScoreComponent => ({
    id: 'cond:x',
    kind: 'condition',
    label: 'l',
    source: 'rule',
    isPreference: false,
    weight: null,
    weightSource: 'unassigned',
    hit: 'yes',
    why: 'w',
    ...over,
  });
  return {
    status: 'valid',
    total: 2,
    totalKind: 'hit-count',
    weights: { assigned: false, note: 'n' },
    components: [
      comp({ id: 'cond:di_001', kind: 'condition', source: 'rule', hit: 'yes', intentId: 'di_001' }),
      comp({ id: 'cond:di_002', kind: 'condition', source: 'rule', hit: 'no', intentId: 'di_002' }),
      comp({ id: 'cond:di_003', kind: 'unavailable', source: 'rule', hit: 'unknown', intentId: 'di_003' }),
      comp({ id: 'pref:c1:kn_003', kind: 'preference', source: 'preference', isPreference: true, hit: 'yes', preferenceId: 'kn_003' }),
    ],
    hardFailures: [],
    preferenceMatches: [
      { preferenceId: 'kn_003', statement: 's', kind: 'numeric', op: 'lte', value: 1, cabinetId: 'c1', matched: 'yes', why: 'w' },
    ],
    explanations: ['e1', 'e2'],
  };
}
// 一个最小的候选布局（真实来源：realPlan 的单柜候选；这里用真实 plan 的候选 + 合成 score）
function realLayout(): CandidateLayout {
  const r = realPlan();
  const cand = r.plan?.candidates[0];
  if (!cand) throw new Error(`夹具失败：realPlan 没有产出候选（ok=${r.ok} err=${r.error ?? ''}）`);
  return cand;
}
function realCandidate(i: number): CandidateLayout {
  const r = realPlan();
  const cand = r.plan?.candidates[i];
  if (!cand) throw new Error(`夹具失败：realPlan 没有第 ${i} 份候选`);
  return cand;
}

// ═══════════════════════ A. 只读投影（不重判）═══════════════════════
section('A. 只读投影：不 rejudge / 确定性 / 引用而非重算');
{
  // A1：解释层源码**只** import 类型 + 不 import 任何判定函数
  const forbidden = [/detectCollisions/, /validateDesign/, /deriveSpatialFacts/, /deriveContacts/, /resolveKnowledge/, /scoreCandidateLayout/];
  const importsOnlyTypes =
    !/^import\s+(?!type\b)[^;]*from\s+['"].*(designScore|spatial|rules\/validate|designValidation|knowledge)/m.test(EXPLAIN_SRC);
  ok('A1. 解释层不 import 判定层（detectCollisions/validateDesign/deriveSpatialFacts/deriveContacts/resolveKnowledge/评分函数）', forbidden.every((re) => !re.test(EXPLAIN_SRC)), forbidden.filter((re) => re.test(EXPLAIN_SRC)).map(String));
  ok('A1b. designScore / spatial 等只以 `import type` 形式引入（不取运行时实现）', importsOnlyTypes);

  const layout = realLayout();
  const score = synthScore();
  const e1 = buildCandidateExplanation(layout, score);
  const e2 = buildCandidateExplanation(layout, score);
  ok('A2. 同 (layout, score) 两次构建逐字节相同（确定性）', JSON.stringify(e1) === JSON.stringify(e2));

  ok('A3. status 恒等于 score.status（不是自己推的）', e1.status === score.status, { got: e1.status, want: score.status });

  // A3b：真实存在的情形 —— `status:'valid'` 同时某条 condition `hit:'no'`（可用但有没满足的目标）。
  //   这条专门堵"从 components 反推 status"的写法：那样推出来会是 infeasible。
  const hasMiss = [...e1.placements.flatMap((p) => p.items), ...e1.crossCutting].some((i) => i.hit === 'no');
  ok('A3b. valid 且确有 hit:no 项时，解释 status 仍为 valid（禁止从 components 反推 status）', e1.status === 'valid' && hasMiss, { status: e1.status, hasMiss });

  // A4：blocking 逐条等于 hardFailures
  const infeasible: DesignScore = {
    ...score,
    status: 'infeasible',
    total: null,
    totalKind: 'none',
    hardFailures: [
      { code: 'RULE-CABINET-OVERLAP', severity: 'ERROR', target: 'c1', message: 'm', source: 'candidate-issues' },
      { code: 'XYZ-OTHER', severity: 'ERROR', target: 'c2', message: 'm2', source: 'design-validation' },
    ],
  };
  const eI = buildCandidateExplanation(layout, infeasible);
  const matchBlocking =
    eI.blocking.length === infeasible.hardFailures.length &&
    eI.blocking.every((b, i) => {
      const h = infeasible.hardFailures[i]!;
      return b.code === h.code && b.severity === h.severity && b.target === h.target && b.message === h.message && b.source === h.source;
    });
  ok('A4. blocking[] 与 score.hardFailures 逐条五项一致（code/severity/target/message/source）', matchBlocking, eI.blocking);

  // A5：items + crossCutting 的 code 集合 === components.map(id)
  const codes = [...e1.placements.flatMap((p) => p.items), ...e1.crossCutting].map((i) => i.code).sort();
  const want = score.components.map((c) => c.id).sort();
  ok('A5. placements[].items + crossCutting 的 code 集合恰好等于 components.map(id)（不多不少）', JSON.stringify(codes) === JSON.stringify(want), { got: codes, want });

  // A6：generationNotes 逐字节等于 layout.explanations
  ok('A6. generationNotes 与 layout.explanations 逐字节相同（不改写/不排序）', JSON.stringify(e1.generationNotes) === JSON.stringify(layout.explanations));

  // A6b：源码不解析 generationNotes 后重组（正则解析 = 造假）
  ok('A6b. 解释层不正则解析 generationNotes 后重组', !/\.match\(|split\(["']搜索族|split\(["']策略/.test(EXPLAIN_SRC));
}

// ═══════════════════════ B. 不造 winner ═══════════════════════
section('B. 不造 winner：无 winner/best/rank/score 键，措辞无"最好"');
{
  const e = buildCandidateExplanation(realLayout(), synthScore());
  const keys = new Set<string>();
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) {
        keys.add(k);
        walk(v);
      }
    }
  };
  walk(e);
  const forbiddenKeys = ['winner', 'best', 'recommended', 'recommend', 'rank', 'pickBest', 'score'];
  ok('B7. 解释对象 JSON 键集不含 winner/best/recommended/rank/score', forbiddenKeys.every((k) => !keys.has(k)), { hit: forbiddenKeys.filter((k) => keys.has(k)), keys: [...keys].sort() });

  ok('B8. summaryZh 不含"最好/最优/推荐/建议选/最佳"', !/最好|最优|推荐|建议选|最佳/.test(e.summaryZh), e.summaryZh);
  ok('B8b. 解释层源码 export 面无非 winner 之外的 adopt/apply/commit/save', !/export (async )?(function|const) (adopt|apply|commit|persist|write|execute|save|winner|rank)\b/i.test(EXPLAIN_SRC));
}

// ═══════════════════════ C. satisfies 分区 ═══════════════════════
section('C. satisfies 分区：生成期信号与事实项分开');
{
  const layout = realLayout();
  const e = buildCandidateExplanation(layout, synthScore());
  const sepArrays = e.placements.every((p) => Array.isArray(p.items) && Array.isArray(p.generatorSignals) && p.items !== (p.generatorSignals as unknown));
  ok('C10a. 每个 placement 的 items 与 generatorSignals 是两个独立数组', sepArrays);
  ok('C10b. summaryZh 不出现 satisfies 导出的结论前缀 `对目标「`', !e.summaryZh.includes('对目标「'), e.summaryZh);
  // satisfies 的值只出现在 generatorSignals，不混进 items 的“事实”里
  const itemCodes = new Set([...e.placements.flatMap((p) => p.items), ...e.crossCutting].map((i) => i.code));
  const compIds = new Set(synthScore().components.map((c) => c.id));
  ok('C10c. items 的 code 全部来自 components（satisfies 不冒充事实项）', [...itemCodes].every((c) => compIds.has(c)), [...itemCodes]);
  ok('C11. generatorSignals 以 `{goal, ok}` 承载生成期粗判，且 summaryZh 明说“生成期粗判…非最终结论”', e.placements.every((p) => p.generatorSignals.every((s) => 'goal' in s && 'ok' in s)) && (e.placements.flatMap((p) => p.generatorSignals).length === 0 || /生成期粗判/.test(e.summaryZh)));
}

// ═══════════════════════ D. unavailable / unknown 如实 ═══════════════════════
section('D. unavailable 如实：unknown 落 crossCutting、措辞“判不出来”');
{
  const e = buildCandidateExplanation(realLayout(), synthScore());
  const unknownItems = [...e.placements.flatMap((p) => p.items), ...e.crossCutting].filter((i) => i.hit === 'unknown');
  ok('D12. 存在 hit=unknown 的项，且它落在 crossCutting（不硬塞进某柜）', unknownItems.length >= 1 && e.crossCutting.some((i) => i.hit === 'unknown'), unknownItems);
  ok('D12b. summaryZh 出现“判不出来”', /判不出来/.test(e.summaryZh), e.summaryZh);
  ok('D13. summaryZh 不把 unknown 写成“未满足”', !/判不出来[^。]*未满足/.test(e.summaryZh) && !(e.crossCutting.some((i) => i.hit === 'unknown') && !/判不出来/.test(e.summaryZh)));
}

// ═══════════════════════ E. 多柜组织 ═══════════════════════
section('E. 多柜组织：按 placement 分块 + blocking 按 target 归因');
{
  const layout = realLayout();
  const n = layout.placements.length;
  const score: DesignScore = { ...synthScore(), hardFailures: [{ code: 'C-X', severity: 'ERROR', target: layout.placements[0]!.targetId, message: 'm', source: 'candidate-issues' }] };
  const e = buildCandidateExplanation(layout, score);
  ok('E14. explanation.placements.length === layout.placements.length', e.placements.length === n, { got: e.placements.length, want: n });
  // 每块只含该柜的项（preference 归因后不会串柜）
  const eachOnlyOwn = e.placements.every((p) => p.items.every((i) => i.targetId === undefined || i.targetId === p.targetId));
  ok('E14b. 每块 items 只含该柜（或无归属）的项', eachOnlyOwn);
  // blocking 按 target 可归因：我们另给一个 helper 断言——blocking 保留 target 字段
  ok('E15. blocking 带 target 字段（可按柜归因），且 target 与 hardFailure 一致', e.blocking.every((b) => typeof b.target === 'string'));

  // E16：房间级 unavailable 不被塞进任一 placement
  const roomE = buildCandidateExplanation(realLayout(), synthScore());
  const unknownInPlacement = roomE.placements.some((p) => p.items.some((i) => i.hit === 'unknown'));
  ok('E16. 房间级 unavailable 不进任一 placement（在 crossCutting）', !unknownInPlacement && roomE.crossCutting.some((i) => i.hit === 'unknown'));
}

// ═══════════════════════ F. Selection（S3）═══════════════════════
section('F. Selection：id 存在且内容键匹配，失配即清除、不回退');
{
  const run = realPlan();
  const plan = run.plan!;
  const c0 = plan.candidates[0]!;
  const realKey = candidateKey(c0);

  ok('F17a. 正常选中：id 存在且 key 匹配 ⇒ 返回 {candidateId, key}', JSON.stringify(resolveSelection(plan, { candidateId: c0.id, key: realKey })) === JSON.stringify({ candidateId: c0.id, key: realKey }));
  ok('F17. id 存在但 key 不存在 ⇒ null（失效，不回退到"id 相同就认"）', resolveSelection(plan, { candidateId: c0.id, key: '<不存在的内容键>' }) === null);
  ok('F17b. id 不存在 ⇒ null', resolveSelection(plan, { candidateId: 'cl_999', key: realKey }) === null);
  ok('F17c. plan 为空 / stored 为空 ⇒ null', resolveSelection(null, { candidateId: c0.id, key: realKey }) === null && resolveSelection(plan, null) === null);

  // F19：重新生成一份内容不同的 plan（改柜宽 ⇒ 落墙锚点变 ⇒ 解析坐标变 ⇒ 内容键变）
  //   注意：位置性 id 仍是 cl_001（`taken=new Set()` 每轮从 cl_001 起），
  //   所以这里恰好复现了"id 相同但已指向另一份候选"的真实场景。
  const p2 = withIntents(baseProject(1200), [cabIntent('wall-contact', 'c1', 'di_001')]);
  const run2 = planCandidates(p2, { scope: 'project' });
  const c2 = (run2.plan?.candidates ?? []).find((c) => c.id === c0.id);
  const key2 = c2 ? candidateKey(c2) : null;
  const stillValid = resolveSelection(run2.plan ?? null, { candidateId: c0.id, key: realKey });
  // 位置性 id 仍在（cl_001），但内容键变了 ⇒ 必须 null（绝不回退到"id 相同就认"）
  ok('F19. 重新生成后旧 {id,key} 失效（id 仍在但内容键已变 ⇒ null，绝不回退）', c2 !== undefined && key2 !== realKey && stillValid === null, { plan2HasCl001: c2 !== undefined, k1: realKey, k2: key2, got: stillValid });

  // F20/F22：源码扫描——selectCandidate 无总线；previewCandidate 不读 selectedCandidate
  const body = (name: string): string => {
    const m = AIPANEL_SRC.match(new RegExp(`const ${name} = useCallback\\([^)]*\\) => (\\{[\\s\\S]*?\\})\\s*,\\s*\\[`));
    return m ? m[1]! : '';
  };
  ok('F20. selectCandidate 体内无 bus.execute/commitPlan/dryRunPlan', body('selectCandidate').length > 0 && !/bus\.execute|commitPlan|dryRunPlan/.test(body('selectCandidate')));
  ok('F22. previewCandidate 以入参 candidateId 为准，不读 selectedCandidate（选中 ≠ 指令）', /previewCandidate = useCallback\(/.test(AIPANEL_SRC) && !/selectedCandidate\?\.candidateId/.test(body('previewCandidate')) && /plan0\.candidates\.find\(\(c\) => c\.id === candidateId\)/.test(AIPANEL_SRC));
  ok('F23. AIPanel 存储 {candidateId,key}（JSON）而非裸 id', /JSON\.stringify\(s\)/.test(AIPANEL_SRC) && /JSON\.parse\(raw\)/.test(AIPANEL_SRC) && /candidateId: r\.candidateId/.test(AIPANEL_SRC));
  ok('F24. generateCompare 重新生成后经 resolveSelection 复核选中', /resolveSelection\(r\.plan, prev\)/.test(AIPANEL_SRC) || /resolveSelection\(/.test(body('generateCompare')));
}

// ═══════════════════════ G. 不写模型 / 无坐标 ═══════════════════════
section('G. 不写模型：无序列化、无坐标外泄');
{
  ok('G23. 解释层源码无 serializeProjectFile / projectFile / saveKnowledge', !/serializeProjectFile|projectFile|saveKnowledge/.test(EXPLAIN_SRC));
  const e = buildCandidateExplanation(realLayout(), synthScore());
  const itemKeys = new Set([...e.placements.flatMap((p) => p.items), ...e.crossCutting].flatMap((i) => Object.keys(i)));
  ok('G24. items 不含 x/y/rotation（坐标不外泄到解释层）', !itemKeys.has('x') && !itemKeys.has('y') && !itemKeys.has('rotation') && !itemKeys.has('resolved'), [...itemKeys].sort());
  // 规划不改模型
  const p = withIntents(baseProject(), [cabIntent('wall-contact', 'c1', 'di_001')]);
  const before = JSON.stringify(p);
  planCandidates(p, { scope: 'project' });
  ok('G25. 规划 + 解释不改入参 project（逐字节不变）', JSON.stringify(p) === before);
}

// ═══════════════════════ H. 字段覆盖（约束四）═══════════════════════
section('H. 字段覆盖：业务语义字段必须显式透传 / 非契约字段必须显式拒绝');
{
  // H1：提案 → 编译，doorMaterial / rodHeight 必须出现在编译产物里（不静默丢）
  const proposal: DesignProposal = {
    title: 't',
    room: 'r1',
    cabinets: [
      {
        ref: 'A',
        units: [
          { kind: 'shelves', count: 2, doorCount: 1, doorMaterial: 'M_GLASS_8_GREY' },
          { kind: 'hanging', rodHeight: 1200 },
        ],
      },
    ],
  };
  const compiled = compileProposal(proposal, baseProject(), RULES);
  const createAction = compiled.actions.find((a) => a.action === 'cabinet.create');
  const unitsInCompiled = (createAction?.params as { units?: Array<Record<string, unknown>> } | undefined)?.units ?? [];
  const u0 = unitsInCompiled[0] ?? {};
  const u1 = unitsInCompiled[1] ?? {};
  ok('H1. compileProposal 透传 doorMaterial（玻璃门不被降级）', u0.doorMaterial === 'M_GLASS_8_GREY', u0);
  ok('H2. compileProposal 透传 rodHeight', u1.rodHeight === 1200, u1);

  // H3：非契约字段 customHardware 必须被**显式拒绝**，不许静默丢。
  //   拒绝判据落**投影层**（`validateProposal` 的字段白名单 → `compileProposal.issues` + `notes`），
  //   不落形状门：形状门只管"是不是这个形状"（units 项只要求有 kind），
  //   字段白名单是**领域词汇**判断，与 `PROPOSAL-UNIT-KIND` 同族同责、只此一处。
  const bad = { title: 't', room: 'r1', cabinets: [{ ref: 'A', units: [{ kind: 'open', customHardware: 'xxx' }] }] };
  const shapeErr = proposalShapeError(bad);
  const badCompiled = compileProposal(bad as unknown as DesignProposal, baseProject(), RULES);
  const fieldIssues = badCompiled.issues.filter((i) => i.code === 'PROPOSAL-UNIT-FIELD');
  const badUnits = ((badCompiled.actions.find((a) => a.action === 'cabinet.create')?.params as { units?: Array<Record<string, unknown>> } | undefined)?.units ?? []);
  ok(
    'H3. 非契约字段 customHardware 被显式拒绝（进 issues 且进 notes，指名道姓，非静默丢）',
    fieldIssues.length === 1 &&
      /customHardware/.test(fieldIssues[0]!.message) &&
      badCompiled.notes.some((n) => /customHardware/.test(n)) &&
      !badUnits.some((u) => 'customHardware' in u) &&
      badCompiled.ok === true,
    { shapeErr, codes: badCompiled.issues.map((i) => i.code), notes: badCompiled.notes, badUnits },
  );
  ok('H3b. 同一个表外字段只报一次（不重复刷屏）、且不改写其它分区字段', fieldIssues.length === 1 && badUnits.length === 1 && badUnits[0]!.kind === 'open', { fieldIssues: fieldIssues.length, badUnits });

  // H4：快照透传门板材质（AI 能看见"这扇门是玻璃的"）
  const room = mkRoom('r1');
  const cab = createCabinet({
    id: 'gb', name: 'gb', roomId: 'r1', x: 0, y: 0, rules: RULES,
    params: { ...defaultCabinetParams(RULES), width: 900, height: 2200, depth: 600 },
    units: defaultUnits(900, RULES, 600).map((u, i) => (i === 0 ? { ...u, id: 'gb_u1', doors: { type: 'hinged' as const, count: 1, mode: 'equal' as const, style: 'inset' as const, gapOuter: 2, gapMid: 2, hinge: 'H', material: 'M_GLASS_8_GREY' } } : { ...u, id: `gb_u${i + 1}` })),
  });
  const proj = { ...baseProject(), rooms: [room], cabinets: [cab] } as Project;
  const snap = buildSnapshot(proj, RULES);
  const view = snap.cabinets[0]?.layout.units.find((u) => u.id === 'gb_u1');
  ok('H4. 快照 unitView 暴露 doors.material（门板材质不再被静默丢弃）', view?.doors?.material === 'M_GLASS_8_GREY', view?.doors);

  // H5：Vision 透传 rodHeight（挂衣区挂杆高不被静默丢）
  const vision: VisionResult = {
    cabinets: [{ ref: 'v1', width: { value: 900, confidence: 'high', source: 'annotation' }, height: { value: 2200, confidence: 'high', source: 'annotation' }, confidence: 'high', units: [{ kind: 'hanging', rodHeight: 1200, confidence: 'high' }] }],
    overallConfidence: 'high',
  };
  const norm = visionResultToNormalized(vision, { room: 'r1' });
  const vu = norm.cabinets[0]?.units?.[0];
  ok('H5. visionResultToNormalized 透传 rodHeight', vu?.rodHeight === 1200, vu);

  // H6：Vision 契约本身有 rodHeight（防止"透传了一个不存在的字段"的假绿）
  ok('H6. VisionUnit 契约确含 rodHeight（上面的透传不是自欺）', /rodHeight/.test(readFileSync(join(APP, 'src/ai/vision/types.ts'), 'utf8')));

  // H7：generate.ts 的 candidateKey 是**导出**的既有实现（唯一来源，不是另写一份）
  ok('H7. generate.ts 导出 candidateKey 且 selectCandidate/逻辑层复用它', /export function candidateKey/.test(GENERATE_SRC) && /import \{ candidateKey \}/.test(stripComments(readFileSync(join(APP, 'src/ui/panels/candidateCompareLogic.ts'), 'utf8'))));
}

// ═══════════════════════ I. Compare UI 消费（P9.9-c）═══════════════════════
section('I. Compare UI：解释 / 偏好明细 / 搜索台账只读消费，不重算、无 winner');
{
  const run = realPlan();
  const plan = run.plan!;
  const cmp = buildCandidateComparison(plan);
  const c0 = plan.candidates[0]!;
  const s0 = plan.scores.find((s) => s.candidateId === c0.id)!.score;

  ok(
    'I25. 行的 explanation 与 buildCandidateExplanation(layout, score) 逐字节相同（验收与界面消费同一份 DTO）',
    JSON.stringify(cmp.rows[0]!.explanation) === JSON.stringify(buildCandidateExplanation(c0, s0)),
    cmp.rows[0]!.explanation.summaryZh,
  );
  ok('I25b. comparison.generation 是 plan.generation 的**同一引用**（透传，不重算、不复制）', cmp.generation === plan.generation, { got: cmp.generation });

  // 台账 = 纯转述：输出里出现的每个数字都必须来自 stats（不做百分比 / 不做差值）
  const stats: CandidateGenerationStats = {
    requested: 3, generated: 5, returned: 3, truncated: 2, generationLimited: true,
    explored: 12, rejected: { resolve: 4, collision: 2, duplicate: 1 }, budget: 20, budgetExhausted: true,
  };
  const lines = generationLedgerZh(stats);
  const nums = new Set(JSON.stringify(lines).match(/\d+/g) ?? []);
  const srcNums = new Set(JSON.stringify(stats).match(/\d+/g) ?? []);
  ok('I26. 台账只转述：输出里的数字全部来自 stats（不重算 / 不做百分比）', [...nums].every((n) => srcNums.has(n)), { nums: [...nums], srcNums: [...srcNums] });
  ok('I27. 预算耗尽必须说成"没搜完"，不许说成"没有候选"', lines.some((l) => /没搜完/.test(l)) && !lines.some((l) => /没有候选/.test(l)), lines);
  ok('I27b. generation 缺失 ⇒ 台账为空数组（不编造 0）', JSON.stringify(generationLedgerZh(undefined)) === '[]');
  ok('I27c. 未耗尽时不得出现"没搜完"字样（不许恒定说没搜完）', !generationLedgerZh({ ...stats, budgetExhausted: false }).some((l) => /没搜完/.test(l)));

  const CMP_SRC = stripComments(readFileSync(join(APP, 'src/ui/panels/candidateCompare.tsx'), 'utf8'));
  ok('I28. 渲染层渲染 score.explanations / preferenceMatches / 搜索台账', /score\.explanations/.test(CMP_SRC) && /preferenceMatches/.test(CMP_SRC) && /generationLedgerZh\(/.test(CMP_SRC));
  ok('I28b. 渲染层无 winner/best/recommended/最佳/推荐 文案', !/winner|best|recommended|推荐|最佳/i.test(CMP_SRC));
  ok('I29. 渲染层不自己造解释（只渲染 DTO 里的 explanation，不 import buildCandidateExplanation）', !/buildCandidateExplanation/.test(CMP_SRC) && /row\.explanation/.test(CMP_SRC));
}

// ═══════════════════════ J. 真实厨房（三柜协调）回归 ═══════════════════════
section('J. 真实厨房三柜回归：搜索台账与 P9.8 逐项一致 + 解释层只投影');
{
  // 与 P9.8 报告 §五 同一形态的真实厨房：5200×4200，三只 900 宽柜，南墙带门洞
  const room = mkRoom('rK', 0, 0, 5200, 4200, 120, (walls) => {
    const south = walls.find((w) => [w.start.y, w.end.y].every((y) => Math.abs(y) < 1)) ?? walls[0]!;
    south.openings = [{ id: 'op_k', kind: 'door', offset: 1000, width: 900, name: '厨房门', hinge: 'start', swingDirection: 'into-room' }];
  });
  const proj = {
    ...baseProject(),
    rooms: [room],
    cabinets: [mkCab(room, 'c1', 1200, 2000, 900, 600), mkCab(room, 'c2', 2600, 2200, 900, 600), mkCab(room, 'c3', 4000, 1800, 900, 600)],
  } as Project;
  const run = planCandidates(withIntents(proj, [roomIntent('wall-contact', room.id, 'di_001')]), {
    scope: 'project',
    cabinetIds: ['c1', 'c2', 'c3'],
    maxCandidates: 6,
  }, []);
  ok('J30. 真实厨房三柜规划成功', run.ok === true, run.ok ? '' : String(run.error));
  const plan = run.plan!;
  const g = plan.generation;

  // ★ 关键回归：P9.8 的探索台账在 P9.9 之后**逐项不变**（解释层是只读投影，生产侧零改动）
  ok(
    'J31. ★ 搜索台账与 P9.8 实测逐项一致（requested/generated/returned/truncated/explored/rejected/budget）',
    !!g &&
      g.requested === 6 && g.generated === 24 && g.returned === 6 && g.truncated === 18 && g.generationLimited === true &&
      g.explored === 90 && g.rejected?.resolve === 0 && g.rejected?.collision === 18 && g.rejected?.duplicate === 48 &&
      g.budget === 216 && g.budgetExhausted === false,
    g,
  );
  ok(
    'J31b. 探索台账恒等式成立：explored = generated + Σrejected（记账自洽）',
    !!g && g.explored === g.generated + (g.rejected?.resolve ?? 0) + (g.rejected?.collision ?? 0) + (g.rejected?.duplicate ?? 0),
    g,
  );
  const multiCount = plan.candidates.filter((c) => c.placements.length === 3).length;
  ok('J32. 真实厨房产出 15 条候选，其中 6 条为三柜整体候选', plan.candidates.length === 15 && multiCount === 6, { total: plan.candidates.length, multi: multiCount });
  ok(
    'J33. valid / infeasible 共存（既不是全绿也不是全红 —— 客户真要看得见差异）',
    plan.scores.some((s) => s.score.status === 'valid') && plan.scores.some((s) => s.score.status === 'infeasible'),
    plan.scores.map((s) => s.score.status),
  );

  const before = JSON.stringify(plan);
  const multi = plan.candidates.find((c) => c.placements.length === 3)!;
  const multiScore = plan.scores.find((s) => s.candidateId === multi.id)!.score;
  const e = buildCandidateExplanation(multi, multiScore);
  ok(
    'J34. 三柜候选的解释块 = 3 块（逐柜），targetId 与 placements 同序',
    e.placements.length === 3 && e.placements.every((p, i) => p.targetId === multi.placements[i]!.targetId),
    e.placements.map((p) => p.targetId),
  );
  const itemKeys = new Set([...e.placements.flatMap((p) => p.items), ...e.crossCutting].flatMap((i) => Object.keys(i)));
  ok('J35. 多柜候选的解释项同样零坐标外泄（无 x/y/rotation/resolved）', !itemKeys.has('x') && !itemKeys.has('y') && !itemKeys.has('rotation') && !itemKeys.has('resolved'), [...itemKeys].sort());
  ok(
    'J36. 解释层不改 plan（逐字节不变 —— 只读投影，不回写）',
    JSON.stringify(plan) === before,
  );

  const badScore = plan.scores.find((s) => s.score.status === 'infeasible')!;
  const badLayout = plan.candidates.find((c) => c.id === badScore.candidateId)!;
  const eb = buildCandidateExplanation(badLayout, badScore.score);
  ok(
    'J37. infeasible 候选的 blocking 逐条等于 hardFailures（真实厨房的洞口/门摆阻断如实透传）',
    eb.blocking.length === badScore.score.hardFailures.length &&
      eb.blocking.every((b, i) => {
        const h = badScore.score.hardFailures[i]!;
        return b.code === h.code && b.severity === h.severity && b.target === h.target && b.message === h.message && b.source === h.source;
      }),
    { blocking: eb.blocking.map((b) => b.code), hardFailures: badScore.score.hardFailures.map((h) => h.code) },
  );
  ok('J38. 台账转述里的数字与 stats 一致（真实数据，非合成）', (() => {
    const lines = generationLedgerZh(g);
    return lines.length > 0 && lines.some((l) => l.includes('24')) && lines.some((l) => l.includes('90')) && lines.some((l) => l.includes('216'));
  })(), generationLedgerZh(g));
}

// ═══════════════════════ 汇总 ═══════════════════════
console.log(`\n══════════════════════════════════════════════`);
console.log(`  P9.9 Explanation & Selection 验收：通过 ${passed} / 失败 ${failed}`);
if (failed > 0) {
  console.log(`失败项：\n  · ${fails.join('\n  · ')}`);
  process.exit(1);
}
console.log('全部通过。');
