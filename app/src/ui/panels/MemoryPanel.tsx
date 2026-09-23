import { useState } from 'react';
import type { ReactNode } from 'react';
import type { CheckSpec } from '../../ai/memory.ts';
import { addMemory, compiledRules, dropMemory, getLastHit, setMemoryStatus, useCorrections } from '../../state/memoryStore.ts';
import { Pill, Row, Section, Text } from './common.tsx';

/**
 * 记忆面板。
 *
 * 界面上最关键的一条设计：**「生效中」和「待编译」必须一眼可分**。
 * 一条只有自然语言、没有可执行判据的记忆，看起来和生效的记忆一模一样，
 * 但它其实什么都拦不住 —— 那是假记忆。所以：
 *   · 待编译的条目直接写出"未生效原因"
 *   · 生效中的条目写出"它现在具体在查什么"（编译产物的 describe）
 *   · 新增记忆时如果不给判定条件，默认就是 pending，并当场告知
 */

const ISSUE_CODES = [
  'RULE-CABINET-IN-WALL',
  'RULE-CABINET-OVERLAP',
  'RULE-PANEL-OVER-SHEET',
  'RULE-DOOR-MAX-WIDTH',
  'RULE-DOOR-MAX-HEIGHT',
  'RULE-RUNNER-TOO-LONG',
  'RULE-DRAWER-NO-ROOM',
  'RULE-SHELF-DEPTH',
  'IDENTITY-BACKSPLIT-BAD',
  'IDENTITY-FAIL',
  'LAYOUT-CACHE-STALE',
];

const VALUE_PATHS = [
  'params.height',
  'params.width',
  'params.depth',
  'params.bodyLift',
  'params.shelfFrontClearance',
  'params.backPanel.grooveDepth',
  'params.backPanel.grooveSetback',
];

type Kind = 'none' | 'noNewIssue' | 'maxValue' | 'minValue' | 'pathForbidden';

export function MemoryPanel(): ReactNode {
  const list = useCorrections();
  const { compiled } = compiledRules();
  const hit = getLastHit();

  const [nl, setNl] = useState('');
  const [kind, setKind] = useState<Kind>('none');
  const [issueCode, setIssueCode] = useState(ISSUE_CODES[0]);
  const [path, setPath] = useState(VALUE_PATHS[0]);
  const [limit, setLimit] = useState('2400');
  const [msg, setMsg] = useState<string | null>(null);

  const describeOf = (id: string): string | null => compiled.find((c) => c.correctionId === id)?.describe ?? null;

  const submit = (): void => {
    const text = nl.trim();
    if (!text) {
      setMsg('请先用你自己的话写下要纠正的问题。');
      return;
    }
    let spec: CheckSpec | undefined;
    if (kind === 'noNewIssue') {
      spec = { kind, issueCode, message: text };
    } else if (kind === 'maxValue' || kind === 'minValue') {
      const v = Number(limit);
      if (!Number.isFinite(v)) {
        setMsg('阈值必须是数字。');
        return;
      }
      spec = { kind, path, value: v, unit: 'mm', message: text };
    } else if (kind === 'pathForbidden') {
      spec = { kind, path, message: text };
    }

    const c = addMemory({ nl: text, checkSpec: spec, tags: ['用户新增'] });
    setNl('');
    setMsg(
      spec
        ? `已记下并编译为可执行检查（${c.id}）。从现在起，任何来源的违规操作都会被它拦下。`
        : `已记下（${c.id}）。它现在是「待编译」—— 没有判定条件就拦不住任何东西，需要你补一个检查种类才能真正生效。`
    );
  };

  const active = list.filter((c) => c.status === 'active').length;
  const pending = list.filter((c) => c.status === 'pending').length;

  return (
    <div className="panel-scroll">
      <Section title={`记忆总览（生效 ${active} · 待编译 ${pending} · 共 ${list.length}）`}>
        <Row label="门的位置">
          <Text>提交前 · CommandBus</Text>
        </Row>
        <div className="hint-line">
          「生效中」= 已编译成可执行检查，挂在唯一写入口上。UI 点击、拖动、AI、MCP、脚本五条路的违规都会被它拦下，
          而且不需要 AI 在线。<br />
          「待编译」= 你说了、我也记下了，但还没有可执行的判据 —— <b>它目前拦不住任何东西</b>，所以不敢标成生效。
        </div>
        {hit ? (
          <div className="mem-hit">
            最近一次拦截：<b>{hit.correctionId}</b>
            <div className="mem-hit-text">{hit.text}</div>
          </div>
        ) : null}
      </Section>

      <Section title="新增一条记忆">
        <textarea
          className="mem-input"
          placeholder="用你自己的话写下要纠正的问题，例如：柜体总高不要超过 2400mm"
          value={nl}
          onChange={(e) => setNl(e.target.value)}
        />
        <Row label="检查种类">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="none">不设（记为待编译）</option>
            <option value="noNewIssue">出现某类问题就拦</option>
            <option value="maxValue">数值不得超过</option>
            <option value="minValue">数值不得低于</option>
            <option value="pathForbidden">禁止写入某路径</option>
          </select>
        </Row>
        {kind === 'noNewIssue' ? (
          <Row label="问题代码">
            <select className="input" value={issueCode} onChange={(e) => setIssueCode(e.target.value)}>
              {ISSUE_CODES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </Row>
        ) : null}
        {kind === 'maxValue' || kind === 'minValue' ? (
          <>
            <Row label="属性路径">
              <select className="input" value={path} onChange={(e) => setPath(e.target.value)}>
                {VALUE_PATHS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="阈值 mm">
              <input className="input" value={limit} onChange={(e) => setLimit(e.target.value)} inputMode="numeric" />
            </Row>
          </>
        ) : null}
        {kind === 'pathForbidden' ? (
          <Row label="路径前缀">
            <input className="input" value={path} onChange={(e) => setPath(e.target.value)} />
          </Row>
        ) : null}
        <div className="btn-row">
          <button type="button" className="tb-btn" onClick={submit}>
            记下这条
          </button>
        </div>
        {msg ? <div className="hint-line strong">{msg}</div> : null}
      </Section>

      <Section title={`全部记忆（${list.length}）`}>
        {list.map((c) => (
          <div className={`mem-item mem-${c.status}`} key={c.id}>
            <div className="mem-head">
              <span className="mem-id">{c.id}</span>
              <Pill kind={c.status === 'active' ? 'ok' : c.status === 'pending' ? 'WARNING' : 'muted'}>
                {c.status === 'active' ? '生效中' : c.status === 'pending' ? '待编译' : '已停用'}
              </Pill>
            </div>
            <div className="mem-nl">「{c.nl}」</div>
            {describeOf(c.id) ? <div className="mem-check">现在在查：{describeOf(c.id)}</div> : null}
            {c.status === 'pending' ? <div className="mem-pending">未生效原因：{c.pendingReason}</div> : null}
            <div className="mem-meta">
              {c.origin === 'user' ? '来自你的纠正' : '系统自省'} · 范围 {c.scope}
              {c.tags.length > 0 ? ` · ${c.tags.join(' / ')}` : ''}
            </div>
            {c.evidence.length > 0 ? (
              <ul className="mem-ev">
                {c.evidence.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            ) : null}
            <div className="btn-row tight">
              {c.status !== 'active' && c.checkSpec ? (
                <button type="button" className="tb-btn" onClick={() => setMemoryStatus(c.id, 'active')}>
                  启用
                </button>
              ) : null}
              {c.status === 'active' ? (
                <button type="button" className="tb-btn" onClick={() => setMemoryStatus(c.id, 'retired')}>
                  停用
                </button>
              ) : null}
              <button type="button" className="tb-btn tb-danger" onClick={() => dropMemory(c.id)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </Section>
    </div>
  );
}
