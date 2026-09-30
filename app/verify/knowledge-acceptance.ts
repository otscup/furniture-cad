/**
 * P6 验收 —— 设计知识系统（三层：hardRule / designKnowledge / userPreference）
 *
 * 对应用户 8 条测试要求，逐条落断言；防假绿：数值冲突用「五金最小净宽 450
 * vs 喜欢抽屉 400」这条真实例子验，不拿占位数验。
 */

import type { Command } from '../src/core/commandBus.ts';
import {
  makeCandidate,
  makeStatedPreference,
  confirmKnowledge,
  rejectKnowledge,
  appendEvidence,
  hardRuleEntries,
  resolveKnowledge,
  scopeMatches,
  predicatesConflict,
  observeCommand,
  recordObservation,
  knowledgeDigest,
  toJsonl,
  fromJsonl,
  type KnowledgeEntry,
  type HardRuleRef,
} from '../src/ai/knowledge/index.ts';

let pass = 0;
const failures: string[] = [];
let section_ = '';
function section(t: string): void {
  section_ = t;
  console.log(`\n【${t}】`);
}
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`[${section_}] ${name}${detail ? ` :: ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}
function eq(name: string, a: unknown, b: unknown): void {
  ok(name, a === b, `实际 ${JSON.stringify(a)} 期望 ${JSON.stringify(b)}`);
}

// ── 固定夹具 ──

const HARD: HardRuleRef[] = [
  {
    code: 'RULE-HARDWARE-MIN-NET-WIDTH',
    statement: '某五金（抽屉滑轨）最小净宽 450mm',
    predicate: { kind: 'rowHeight', op: 'min', value: 450 },
    scope: {},
  },
];

const hardEntries = hardRuleEntries(HARD, []);
eq('hardRule 引用条目已装配', hardEntries.length, 1);
eq('hardRule 状态 active（引用现有规则，不是重新实现）', hardEntries[0]!.status, 'active');

/** 用户那条「我喜欢所有抽屉都做 400」——与上面 450 的硬规则冲突 */
const pref400 = makeStatedPreference({
  statement: '我喜欢所有抽屉都做 400mm 行高',
  predicate: { kind: 'rowHeight', op: 'prefer', value: 400 },
  detail: '用户在知识面板输入：「我喜欢所有抽屉都做 400mm 行高」',
  seq: 1,
});

/** 一条普通的、与硬规则不冲突的观察候选 */
const cand600 = makeCandidate({
  layer: 'userPreference',
  statement: '行高从 550mm 改成 600mm',
  predicate: { kind: 'rowHeight', op: 'prefer', value: 600 },
  scope: { cabinet: '主卧衣柜' },
  evidence: { at: Date.now(), source: 'user-observed', detail: '属性面板改行高 550 → 600', cabinetId: 'cab_001' },
  confidence: 0.3,
  seq: 2,
});

// ═══════════════ 1. Hard Rule 不会被 User Preference 覆盖 ═══════════════
section('1. Hard Rule > User Preference（450 净宽 vs 喜欢 400）');
{
  const res = resolveKnowledge({}, [hardEntries[0]!, pref400]);
  const pref = res.applicable.filter((r) => r.entry.id === pref400.id);
  eq('偏好被压制：不出现在 applicable', pref.length, 0);
  eq('偏好进 suppressed（保留条目本体）', res.suppressed.length, 1);
  eq('冲突被发现（不是静默覆盖）', res.conflicts.length, 1);
  eq('冲突 kind = hard-rule-beats-preference', res.conflicts[0]!.kind, 'hard-rule-beats-preference');
  ok('冲突理由点名双方原文（保留来源）', res.conflicts[0]!.reason.includes('450') && res.conflicts[0]!.reason.includes('400'), res.conflicts[0]!.reason);
  ok('硬规则仍在 applicable（AI 必须知道边界在哪）', res.applicable.some((r) => r.entry.layer === 'hardRule'));
}

// ═══════════════ 2. Design Knowledge 不会绕过 Rules ═══════════════
section('2. Design Knowledge 不绕过 Rules（与硬规则冲突同样被压制）');
{
  const dk = makeCandidate({
    layer: 'designKnowledge',
    statement: '这类衣柜抽屉行高通常做 400（违反上面 450 硬规则的反例）',
    predicate: { kind: 'rowHeight', op: 'prefer', value: 400 },
    evidence: { at: Date.now(), source: 'ai-inferred', detail: 'AI 从同类案例归纳' },
    confidence: 0.5,
    seq: 3,
  });
  // candidate 不进 applicable（没确认的知识不参与规划）
  const resCand = resolveKnowledge({}, [hardEntries[0]!, dk]);
  eq('candidate（未确认）不进 applicable', resCand.applicable.filter((r) => r.entry.id === dk.id).length, 0);

  const dkActive: KnowledgeEntry = { ...dk, status: 'active', confirmedAt: Date.now() };
  const resActive = resolveKnowledge({}, [hardEntries[0]!, dkActive]);
  eq('确认后的 designKnowledge 与硬规则冲突 → 也被压制', resActive.suppressed.length, 1);
  eq('冲突 kind = hard-rule-beats-knowledge', resActive.conflicts[0]?.kind, 'hard-rule-beats-knowledge');
  ok('Resolver 输出形状里没有任何 action / command 字段（不产生可执行物）', !('actions' in resActive) && !('commands' in resActive) && !('patch' in resActive));
}

// ═══════════════ 3. 用户确认的 Preference 被 Resolver 正确返回 ═══════════════
section('3. 用户确认的 Preference 正确返回');
{
  const ok600: KnowledgeEntry = { ...cand600, status: 'active', confirmedAt: Date.now(), confidence: 1 };
  const res = resolveKnowledge({ cabinetName: '主卧衣柜' }, [hardEntries[0]!, ok600]);
  const hit = res.applicable.find((r) => r.entry.id === ok600.id);
  ok('确认后的偏好出现在 applicable', Boolean(hit), JSON.stringify(res.applicable.map((r) => r.entry.id)));
  eq('confirmed 标记为 true', hit?.confirmed, true);
  ok('why 写明来源与确认状态', Boolean(hit?.why.includes('用户偏好') && hit?.why.includes('已确认')), hit?.why);
  // scope 匹配：换一个柜体名，scoped 偏好不适用
  const res2 = resolveKnowledge({ cabinetName: '玄关鞋柜' }, [hardEntries[0]!, ok600]);
  eq('scope 不匹配（换了柜体）→ 不再返回', res2.applicable.filter((r) => r.entry.id === ok600.id).length, 0);
  ok('scopeMatches 单元：any/未填 = 不限', scopeMatches({}, { cabinetName: '随便' }));
}

// ═══════════════ 4. 一次性修改不会自动成为永久偏好 ═══════════════
section('4. 一次观察 = candidate，不自动升级');
{
  const list = recordObservation([], cand600 ? ({ predicate: cand600.predicate!, statement: cand600.statement, evidence: cand600.evidence[0]!, scopeCabinet: '主卧衣柜' }) : ({} as never));
  eq('观察只产生 1 条 candidate', list.length, 1);
  eq('状态是 candidate（不是 active）', list[0]!.status, 'candidate');
  ok('置信度低（0.3 起步，不可能到 1）', list[0]!.confidence < 1 && list[0]!.confidence >= 0.3, String(list[0]!.confidence));
  // 同一观察重复 10 次：证据累积、置信涨、但**状态不变**、且永远到不了 1
  let l = list;
  for (let i = 0; i < 10; i++) l = recordObservation(l, { predicate: cand600.predicate!, statement: cand600.statement, evidence: { ...cand600.evidence[0]!, at: Date.now() + i }, scopeCabinet: '主卧衣柜' });
  eq('重复 10 次仍是同一条 candidate（合并证据，不是 10 条）', l.length, 1);
  ok('重复观察后置信有上限（0.9，差一步留给用户）', l[0]!.confidence === 0.9, String(l[0]!.confidence));
  eq('状态依然 candidate', l[0]!.status, 'candidate');
  eq('resolve 的 applicable 依然不含它', resolveKnowledge({ cabinetName: '主卧衣柜' }, l).applicable.filter((r) => r.entry.id === l[0]!.id).length, 0);
  // confirm 是唯一升级通道
  const confirmed = confirmKnowledge(l, l[0]!.id);
  eq('用户确认后才 active', confirmed[0]!.status, 'active');
  eq('拒绝通道也工作', rejectKnowledge(l, l[0]!.id)[0]!.status, 'rejected');
}

// ═══════════════ 5. AI 修改与用户修改产生 candidate ═══════════════
section('5. 命令观察：AI 修改与用户修改都产生 candidate，来源可区分');
{
  const mkCmd = (source: Command['source'], label: string): Command => ({
    id: 'cmd_t',
    op: 'cabinet.update',
    source,
    target: { kind: 'cabinet', id: 'cab_001' },
    changes: [],
    label,
  });
  const rowHeightCmd = (source: Command['source'], label: string, to: number): { cmd: Command; diff: Array<{ path: string; from: unknown; to: unknown }> } => ({
    cmd: {
      ...mkCmd(source, label),
      changes: [],
    },
    diff: [{ path: 'layout.rows.0.height', from: 550, to }],
  });
  const ai = rowHeightCmd('ai', 'AI 方案：把抽屉行高调到 500', 500);
  const ui = rowHeightCmd('ui', '属性面板行高 550 → 500', 500);
  const aiObs = observeCommand(ai.cmd, ai.diff as never, '主卧衣柜');
  const userObs = observeCommand(ui.cmd, ui.diff as never, '主卧衣柜');
  eq('AI 命令产生 1 条观察', aiObs.length, 1);
  eq('用户命令产生 1 条观察', userObs.length, 1);
  eq('AI 观察来源 = ai-inferred', aiObs[0]!.evidence.source, 'ai-inferred');
  eq('用户观察来源 = user-observed', userObs[0]!.evidence.source, 'user-observed');
  ok('证据保留命令原话（provenance）', aiObs[0]!.evidence.detail.includes('AI 方案') && userObs[0]!.evidence.detail.includes('属性面板'));
  const both = recordObservation(recordObservation([], aiObs[0]!), userObs[0]!);
  // AI 提 500、用户也改到 500 → 合并为一条 candidate（证据 2 条）
  eq('同值合并：AI 与用户的观察并成一条 candidate', both.length, 1);
  eq('证据 2 条（两条来源都留痕）', both[0]!.evidence.length, 2);
  // 用户改成不同值 → 新 candidate（不覆盖 AI 的）
  const diff = recordObservation(recordObservation([], aiObs[0]!), { ...userObs[0]!, predicate: { kind: 'rowHeight' as const, op: 'prefer', value: 620 } });
  eq('不同值 = 两条 candidate（不静默覆盖）', diff.length, 2);
}

// ═══════════════ 6. provenance 保留 ═══════════════
section('6. 知识来源 / provenance 保留');
{
  const e = makeStatedPreference({
    statement: '抽屉不要做玻璃门',
    detail: '用户原话：「抽屉不要做玻璃门，上次那个翻车了」',
    seq: 7,
  });
  ok('user-stated 证据原话原样保留', e.evidence[0]!.detail.includes('翻车了'), e.evidence[0]!.detail);
  eq('来源 = user-stated', e.evidence[0]!.source, 'user-stated');
  ok('createdAt/updatedAt 存在', typeof e.createdAt === 'number' && typeof e.updatedAt === 'number');
  // appendEvidence 累积证据不改原证据
  const withMore = appendEvidence([e], e.id, { at: Date.now(), source: 'user-observed', detail: '又一次相关修改' }, 0.1);
  eq('原证据还在（追加不覆盖）', withMore[0]!.evidence.length, 2);
  eq('原始那条原话逐字不变', withMore[0]!.evidence[0]!.detail, e.evidence[0]!.detail);
}

// ═══════════════ 7. 冲突发现（同层矛盾）═══════════════
section('7. 同层矛盾被发现，不静默覆盖');
{
  const a = { ...cand600, id: 'kn_a', status: 'active' as const, confirmedAt: 1, predicate: { kind: 'rowHeight' as const, op: 'prefer' as const, value: 600 } };
  const b = { ...cand600, id: 'kn_b', status: 'active' as const, confirmedAt: 1, predicate: { kind: 'rowHeight' as const, op: 'prefer' as const, value: 350 } };
  const res = resolveKnowledge({ cabinetName: '主卧衣柜' }, [a, b]);
  eq('同层两条矛盾偏好 → 冲突 1 条', res.conflicts.length, 1);
  eq('kind = same-layer-contradiction', res.conflicts[0]!.kind, 'same-layer-contradiction');
  ok('双方都还在 applicable（都保留，AI/人工裁决）', res.applicable.length === 2 && res.suppressed.length === 0);
  ok('冲突理由点名双方原文', res.conflicts[0]!.reason.includes('600') && res.conflicts[0]!.reason.includes('350'));
  // 谓词单元：min vs min 不同边界 = 冲突；min <= max = 不冲突
  eq('min vs max（互补约束）不误报', predicatesConflict({ kind: 'cabinetWidth', op: 'min', value: 300 }, { kind: 'cabinetWidth', op: 'max', value: 900 }), false);
  eq('min vs min 不同值报冲突', predicatesConflict({ kind: 'cabinetWidth', op: 'min', value: 300 }, { kind: 'cabinetWidth', op: 'min', value: 450 }), true);
  eq('不同维度不比', predicatesConflict({ kind: 'rowHeight', op: 'prefer', value: 400 }, { kind: 'cabinetWidth', op: 'prefer', value: 400 }), false);
}

// ═══════════════ 8. Resolver 不修改输入 ═══════════════
section('8. Resolver 是纯函数：输入条目深比较不变');
{
  const before = JSON.stringify([hardEntries[0]!, pref400, cand600]);
  resolveKnowledge({ cabinetName: '主卧衣柜' }, [hardEntries[0]!, pref400, cand600]);
  resolveKnowledge({}, [hardEntries[0]!, pref400, cand600]);
  const after = JSON.stringify([hardEntries[0]!, pref400, cand600]);
  eq('resolve 前后条目逐字节一致（conflicts 字段也没被写脏）', before, after);
}

// ═══════════════ 附加：JSONL 往返幂等 + digest ═══════════════
section('9. JSONL 往返幂等 + AI 摘要');
{
  const list = [pref400, cand600, hardEntries[0]!];
  const once = toJsonl(list);
  const back = fromJsonl(once).list;
  eq('往返后条数一致', back.length, 3);
  eq('二次序列化逐字节幂等', toJsonl(back as KnowledgeEntry[]), once);
  ok('statement 原话不丢', back[0]!.statement === pref400.statement);
  ok('evidence 原话不丢', (back[0]!.evidence[0]!.detail ?? '').includes('400'));

  const res = resolveKnowledge({}, [hardEntries[0]!, { ...pref400, id: 'kn_p1' }]);
  // pref400 与 hardEntries 谓词同维（rowHeight）→ 冲突；digest 必须包含警告
  const digest = knowledgeDigest(res);
  ok('digest 含硬规则参考', digest.includes('硬规则'), digest.slice(0, 200));
  ok('digest 含冲突警告与「不得绕过」', res.conflicts.length > 0 && digest.includes('不得绕过'), digest.slice(-300));
  ok('digest 声明「方案仍将通过规则校验」', digest.includes('仍将通过规则校验'));
  const emptyDigest = knowledgeDigest(resolveKnowledge({}, []));
  eq('无知识时 digest 为空（不注入空段落）', emptyDigest, '');
}

// ═══════════════ 附加：观察器只认有限维度 ═══════════════
section('10. 观察器只认有限语义维度（不自动总结所有修改）');
{
  const diffOf = (path: string, from: unknown, to: unknown): never => [{ path, from, to }] as never;
  const weird: Command = { id: 'c', op: 'cabinet.update', source: 'ui', target: { kind: 'cabinet', id: 'x' }, changes: [], label: '挪柜子' };
  eq('位置移动不产生知识（放哪儿是一次性决定）', observeCommand(weird, diffOf('placement.x', 0, 700)).length, 0);
  eq('改名不产生知识', observeCommand(weird, diffOf('name', 'a', 'b')).length, 0);
  const undoCmd: Command = { ...weird, source: 'system' };
  eq('撤销/系统命令不产生知识', observeCommand(undoCmd, diffOf('layout.rows.0.height', 550, 600)).length, 0);
  eq('抽屉数量变化产生观察', observeCommand(weird, diffOf('layout.rows.0.units.0.count', 3, 4)).length, 1);
  eq('分区类型变化产生观察', observeCommand(weird, diffOf('layout.rows.0.units.0.kind', 'shelves', 'drawerBank')).length, 1);
  eq('值没变（from===to）不产生观察', observeCommand(weird, diffOf('layout.rows.0.height', 600, 600)).length, 0);
}

// ── 汇总 ──
console.log(`\n══════════════════════════════════════════════`);
console.log(`  通过 ${pass} · 失败 ${failures.length}`);
if (failures.length > 0) {
  console.log('失败项：');
  for (const f of failures) console.log(` - ${f}`);
  process.exit(1);
}
console.log('P6 成立：硬规则 / 设计知识 / 用户偏好 三层分离，观察不越权、冲突不静默、Resolver 不改模型。');
