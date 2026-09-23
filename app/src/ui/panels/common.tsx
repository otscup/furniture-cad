import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 通用表单件。
 *
 * 关键设计：**只读区与可写区在视觉上必须一眼可分**。
 * authored 字段是输入框（能改），derived 字段是带锁标记的纯文本（改不了）。
 * 这不是装饰 —— 它把"AI/用户都不是尺寸权威"这条设计原则摆到界面上。
 */

/**
 * 可折叠分区。
 *
 * `defaultOpen` 的语义是"**只要现在有东西要看，就自动展开**"，不只是初始值。
 * 起因是一次真实反馈：管理后台的「操作日志」写成 defaultOpen={log.length > 0}，
 * 而它挂载时 log 一定是空的 —— 于是保存、拉取、写入全都有回执，用户却一条也看不见，
 * 只能自己去点那个折叠三角。**看不见的日志等于没有日志。**
 * 用户手动折叠过之后，本组件不会再强行展开（依赖不变则 effect 不重跑）。
 */
export function Section(props: { title: string; right?: ReactNode; children: ReactNode; defaultOpen?: boolean }): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen ?? true);

  useEffect(() => {
    if (props.defaultOpen) setOpen(true);
  }, [props.defaultOpen]);

  return (
    <div className="sec">
      <div className="sec-head">
        <button className="sec-toggle" onClick={() => setOpen((o) => !o)} type="button">
          <span className={`caret ${open ? 'open' : ''}`}>▸</span>
          {props.title}
        </button>
        {props.right}
      </div>
      {open ? <div className="sec-body">{props.children}</div> : null}
    </div>
  );
}

export function Row(props: { label: string; children: ReactNode; hint?: string; derived?: boolean }): ReactNode {
  return (
    <div className={`row ${props.derived ? 'row-derived' : ''}`}>
      <label className="row-label" title={props.hint}>
        {props.derived ? <span className="lock">🔒</span> : null}
        {props.label}
      </label>
      <div className="row-value">{props.children}</div>
    </div>
  );
}

export function Text(props: { children: ReactNode; mono?: boolean; strong?: boolean }): ReactNode {
  return <span className={`${props.mono ? 'mono' : ''} ${props.strong ? 'strong' : ''}`}>{props.children}</span>;
}

interface NumFieldProps {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  title?: string;
}

/**
 * 数字输入。用"本地文本态 + 失焦/回车提交"而不是 onChange 直提，
 * 否则输入 "2400" 会在撤消栈里留下 4 条命令（2 / 24 / 240 / 2400）。
 */
export function NumField(props: NumFieldProps): ReactNode {
  const [text, setText] = useState(String(props.value));

  useEffect(() => {
    setText(String(props.value));
  }, [props.value]);

  const commit = (): void => {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      setText(String(props.value));
      return;
    }
    let v = Math.round(n);
    if (props.min !== undefined) v = Math.max(props.min, v);
    if (props.max !== undefined) v = Math.min(props.max, v);
    setText(String(v));
    if (v !== props.value) props.onCommit(v);
  };

  return (
    <div className="numfield">
      <input
        className="input"
        value={text}
        disabled={props.disabled}
        title={props.title}
        inputMode="numeric"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            setText(String(props.value));
            e.currentTarget.blur();
          }
        }}
      />
      {props.suffix ? <span className="suffix">{props.suffix}</span> : null}
    </div>
  );
}

export function TextField(props: { value: string; onCommit: (v: string) => void; disabled?: boolean }): ReactNode {
  const [text, setText] = useState(props.value);
  useEffect(() => {
    setText(props.value);
  }, [props.value]);
  return (
    <input
      className="input"
      value={text}
      disabled={props.disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const t = text.trim();
        if (t && t !== props.value) props.onCommit(t);
        else setText(props.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setText(props.value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

export function Pill(props: { kind: 'ERROR' | 'WARNING' | 'INFO' | 'ok' | 'muted'; children: ReactNode }): ReactNode {
  return <span className={`pill pill-${props.kind}`}>{props.children}</span>;
}
