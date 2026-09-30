import { useCallback, useMemo, useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import {
  currentKnowledge,
  loadKnowledge,
  saveKnowledge,
  confirmKnowledge,
  rejectKnowledge,
  makeStatedPreference,
  resolveKnowledge,
  knowledgeDigest,
  type KnowledgeEntry,
  type KnowledgePredicate,
} from '../../ai/knowledge/index.ts';
import { Pill, Section, Text } from './common.tsx';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  KnowledgePanel（P6）—— 三层知识的轻量调试入口
 *
 *  能看到：当前知识 / 层 / 来源 / 置信度 / scope / 确认状态 / 冲突。
 *  能操作：确认候选生效 / 拒绝候选 / 手动添加偏好（user-stated → active）。
 *  不做的：复杂知识管理后台（第一版只验证闭环）。
 * ══════════════════════════════════════════════════════════════════════
 */

const LAYER_ZH: Record<KnowledgeEntry['layer'], string> = {
  hardRule: '硬规则',
  designKnowledge: '设计知识',
  userPreference: '用户偏好',
};

const LAYER_PILL: Record<KnowledgeEntry['layer'], 'ERROR' | 'WARNING' | 'INFO'> = {
  hardRule: 'ERROR',
  designKnowledge: 'INFO',
  userPreference: 'WARNING',
};

const ORIGIN_ZH: Record<string, string> = {
  'ai-inferred': 'AI 推测',
  'user-observed': '行为观察',
  'user-stated': '用户明说',
  system: '系统',
};

const PRED_ZH: Record<string, string> = {
  drawerCount: '分区件数',
  rowHeight: '行高',
  cabinetWidth: '柜宽',
  cabinetDepth: '柜深',
  unitKind: '分区类型',
  layoutStyle: '布局风格',
};

function EntryCard(props: { e: KnowledgeEntry; onConfirm?: () => void; onReject?: () => void; conflictNote?: string }): ReactNode {
  const { e } = props;
  return (
    <div className="kn-entry">
      <div className="kn-entry-head">
        <Pill kind={LAYER_PILL[e.layer]}>{LAYER_ZH[e.layer]}</Pill>
        <Text mono>{e.id.slice(0, 16)}</Text>
        <span className="muted-sm">
          {ORIGIN_ZH[e.evidence[0]?.source ?? 'system']} · 置信 {Math.round(e.confidence * 100)}%
          {e.scope.cabinet && e.scope.cabinet !== 'any' ? ` · 柜「${e.scope.cabinet}」` : ''}
          {e.scope.room && e.scope.room !== 'any' ? ` · 房间「${e.scope.room}」` : ''}
        </span>
        {e.status === 'active' ? <Pill kind="ok">生效</Pill> : e.status === 'candidate' ? <Pill kind="WARNING">候选</Pill> : <Pill kind="muted">已拒绝</Pill>}
      </div>
      <div className="kn-statement">{e.statement}</div>
      {e.predicate ? (
        <div className="muted-sm">
          谓词：{PRED_ZH[e.predicate.kind] ?? e.predicate.kind} {e.predicate.op === 'prefer' ? '建议' : e.predicate.op} {String(e.predicate.value)}
        </div>
      ) : null}
      {props.conflictNote ? <div className="alert alert-warn">冲突：{props.conflictNote}</div> : null}
      <div className="muted-sm kn-evidence">
        证据 {e.evidence.length} 条
        {e.evidence.length > 0 ? `：${e.evidence[e.evidence.length - 1]!.detail.slice(0, 60)}` : ''}
      </div>
      {e.status === 'candidate' && (props.onConfirm || props.onReject) ? (
        <div className="row-btns">
          {props.onConfirm ? (
            <button type="button" className="btn" onClick={props.onConfirm}>
              确认生效
            </button>
          ) : null}
          {props.onReject ? (
            <button type="button" className="btn btn-ghost" onClick={props.onReject}>
              拒绝
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function KnowledgePanel(props: { bus: CommandBus; version: number; onToast?: (kind: 'ok' | 'info' | 'warn' | 'error', text: string) => void }): ReactNode {
  const { bus } = props;
  const [tick, setTick] = useState(0);
  const [prefText, setPrefText] = useState('');
  const [predKind, setPredKind] = useState<string>('none');
  const [predValue, setPredValue] = useState('');
  const refresh = useCallback(() => setTick((v) => v + 1), []);

  // version 变化（观察器可能刚记了新候选）时重读
  useEffect(() => {
    setTick((v) => v);
  }, [props.version]);

  const entries = useMemo(() => currentKnowledge(), [tick]);
  const userEntries = useMemo(() => loadKnowledge(), [tick]);
  const project = bus.getState();
  const roomName = project.rooms[0]?.name;
  const resolution = useMemo(() => resolveKnowledge({ roomName }, entries), [entries, roomName]);
  const conflictById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of resolution.conflicts) {
      m.set(c.loser.id, c.reason);
      m.set(c.winner.id, c.reason);
    }
    return m;
  }, [resolution]);

  const doConfirm = useCallback(
    (id: string) => {
      saveKnowledge(confirmKnowledge(loadKnowledge(), id));
      refresh();
      props.onToast?.('ok', '该候选知识已生效（会被 AI 规划参考；硬规则仍然优先）');
    },
    [props],
  );
  const doReject = useCallback(
    (id: string) => {
      saveKnowledge(rejectKnowledge(loadKnowledge(), id));
      refresh();
    },
    [],
  );

  const doAdd = useCallback(() => {
    const t = prefText.trim();
    if (!t) return;
    let predicate: KnowledgePredicate | undefined;
    const v = predValue.trim();
    if (predKind !== 'none' && v !== '') {
      const asNum = Number(v);
      const kind = predKind as KnowledgePredicate['kind'];
      predicate = { kind, op: 'prefer', value: Number.isFinite(asNum) && v.match(/^\d+$/) ? asNum : v };
    }
    const list = loadKnowledge();
    const next = [...list, makeStatedPreference({ statement: t, predicate, detail: `用户在知识面板输入：「${t}」`, seq: list.length + 1 })];
    saveKnowledge(next);
    setPrefText('');
    setPredValue('');
    refresh();
    props.onToast?.('ok', '偏好已记录并生效（硬规则仍优先，冲突会明确暴露）');
  }, [prefText, predKind, predValue, props]);

  const digest = knowledgeDigest(resolution);

  return (
    <div className="panel knowledge-panel">
      <Section title="设计知识（三层）">
        <p className="note">
          硬规则 &gt; 设计知识 &gt; 用户偏好。硬规则来自规则集与记忆门（只引用，执行体仍是 Rules + CommandBus）；
          设计知识与偏好只作 AI 规划参考，<b>永远不绕过校验</b>。你的修改会被观察成<b>候选</b>（不自动生效），
          确认后才参与规划。冲突会明确暴露，不静默覆盖。
        </p>
        <div className="muted-sm">
          当前解析（房间「{roomName ?? '—'}」）：可用 {resolution.applicable.length} 条 · 冲突 {resolution.conflicts.length} 条 ·
          被硬规则压制 {resolution.suppressed.length} 条
        </div>
      </Section>

      <Section title="生效与候选">
        {userEntries.length === 0 ? (
          <div className="note ok">还没有观察或手动添加的知识。改改柜体（行高 / 抽屉数 / 分区类型 / 柜宽深）就会在这里出现候选。</div>
        ) : (
          [...userEntries].reverse().map((e) => (
            <EntryCard key={e.id} e={e} conflictNote={conflictById.get(e.id)} onConfirm={e.status === 'candidate' ? () => doConfirm(e.id) : undefined} onReject={e.status === 'candidate' ? () => doReject(e.id) : undefined} />
          ))
        )}
      </Section>

      <Section title="手动添加偏好">
        <textarea
          className="import-text"
          rows={2}
          placeholder="例：玄关鞋柜的抽屉行高做 350 就够"
          value={prefText}
          onChange={(e) => setPrefText(e.target.value)}
        />
        <div className="row" style={{ gridTemplateColumns: 'auto 1fr auto' }}>
          <select className="import-hint" style={{ width: 130 }} value={predKind} onChange={(e) => setPredKind(e.target.value)}>
            <option value="none">不设可判定谓词</option>
            {Object.entries(PRED_ZH).map(([k, zh]) => (
              <option key={k} value={k}>
                {zh}
              </option>
            ))}
          </select>
          <input className="import-hint" placeholder="建议值（可留空）" value={predValue} onChange={(e) => setPredValue(e.target.value)} />
          <button type="button" className="btn btn-primary" disabled={!prefText.trim()} onClick={doAdd}>
            记为偏好
          </button>
        </div>
        <p className="note">手动添加 = 你明确说「以后都这样做」，直接生效（user-stated，置信 1）；与硬规则冲突时会立刻暴露而不是被悄悄采用。</p>
      </Section>

      {resolution.conflicts.length > 0 ? (
        <Section title={`冲突（${resolution.conflicts.length} 条，不静默覆盖）`}>
          {resolution.conflicts.map((c, i) => (
            <div key={i} className="alert alert-warn">
              <Pill kind="WARNING">{c.kind}</Pill> {c.reason}
            </div>
          ))}
        </Section>
      ) : null}

      <Section title="给 AI 的知识摘要（调试）">
        {digest ? <pre className="kn-digest">{digest}</pre> : <div className="note">当前没有可注入 AI 的知识。生成设计方案时，此摘要会拼进 system prompt。</div>}
      </Section>
    </div>
  );
}
