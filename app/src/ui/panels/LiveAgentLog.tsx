import type { ReactNode } from 'react';
import { AGENT_EVENT_LIMIT } from '../liveAgentLog.ts';
import type { AgentStreamEvent } from '../liveAgentLog.ts';

/**
 * A3：MCP / Agent 实时事件流面板。
 *
 * 为什么是一个独立面板而不是塞进标题栏：
 *  "Agent 正在画第 N 步"是**过程信息**，正文里放一条就够；但用户往往需要
 *  "它刚才那一步到底成没成、调的是什么工具"。那是一条按时间倒序的流水，
 *  需要自己的滚动区与败/成配色 —— 混进 header 会挤掉真正的标题。
 *
 * 纪律：
 *  · 纯展示，不提供任何"回滚/重放"按钮 —— 事件流不是命令入口；
 *  · 最新在最上面，最多 AGENT_EVENT_LIMIT 条（由归约器保证，这里不再截）；
 *  · 没有事件时整块不渲染（不占位、不写"暂无"占位符骗空间）。
 */
export function LiveAgentLog(props: {
  events?: AgentStreamEvent[];
  draftId?: string;
  className?: string;
}): ReactNode {
  const events = props.events ?? [];
  if (events.length === 0) return null;
  return (
    <section
      className={`workspace-agent-log ${props.className ?? ''}`.trim()}
      aria-label="MCP 与 Agent 实时事件流"
      data-testid="workspace-agent-log"
      data-agent-event-count={events.length}
    >
      <header className="workspace-agent-log-head">
        <strong>🛠 Agent 实时事件流</strong>
        <span>
          最新 {events.length} 条（上限 {AGENT_EVENT_LIMIT}）
          {props.draftId ? ` · 草稿 ${props.draftId}` : ''}
        </span>
      </header>
      <ol className="workspace-agent-log-list" aria-live="polite">
        {events.map((event) => (
          <li
            key={event.id}
            className={`workspace-agent-log-item is-${event.kind}${event.toolOk === false ? ' is-failed' : ''}`}
            data-agent-event-kind={event.kind}
            data-agent-event-id={event.id}
          >
            <time className="workspace-agent-log-time" dateTime={new Date(event.at).toISOString()}>
              {new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })}
            </time>
            <span className="workspace-agent-log-text">{event.text}</span>
            {event.round ? <span className="workspace-agent-log-round">第 {event.round} 步</span> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
