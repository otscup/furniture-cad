import type { ReactNode } from 'react';
import { formatCount, formatExact, formatTokens } from '../../shared/quota.mjs';
import type { PlanOption, QuotaDim, QuotaView } from '../ai/quotaTypes.ts';
import { Pill } from './panels/common.tsx';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  用量显示（账号面板 / 管理后台 / AI 面板三处共用）
 *
 *  ── 为什么必须抽成一个组件 ──
 *    "还剩多少额度"这个数要出现在三个地方。三处各写一遍的下场是：
 *    某天改了档位口径（比如免费档从"每月"改成"每日"），只改了两处，
 *    第三处还写着"本月"—— 而它显示的数字一样是错的，只是没人发现。
 *    一处实现，三处引用，"口径漂移"这类事故在这里结构上就不可能发生。
 *
 *  ── 两个维度都要画出来 ──
 *    token 与生成次数**任一**用尽即止。只画一个的话，用户撞上另一条时
 *    看到的是"明明还剩一半，为什么不让生成"—— 那是最难自己排查的一类问题。
 *
 *  ── 被拦住时必须说清是哪一条 ──
 *    "额度用完了"没有任何可操作性：用户不知道该等明天还是该升级档位。
 *    这两件事的下一步动作完全不同，界面必须分得开。
 * ══════════════════════════════════════════════════════════════════════
 */

export type { QuotaDim, QuotaView };

/** 档位下拉里那行说明也在这里生成 —— 与用量显示同一套单位，不会出现"月"与"日"说反 */
export function planOptionLabel(p: PlanOption): string {
  const per = (x?: { period?: string }): string => (x?.period === 'day' ? '每日' : '每月');
  const t = p.tokens?.limit === null || p.tokens?.limit === undefined ? '不限' : `${formatTokens(p.tokens.limit)} token / ${per(p.tokens)}`;
  const g = p.generations?.limit === null || p.generations?.limit === undefined ? '不限' : `${formatCount(p.generations.limit)} 次生成 / ${per(p.generations)}`;
  return `${p.label}（${t} · ${g}）`;
}

function Bar(props: { dim: QuotaDim; label: string; kind: 'tokens' | 'generations' }): ReactNode {
  const d = props.dim;
  /**
   * 不限档不画进度条。
   * 画一条 0% 的条会被读成"还没开始用"，而真相是"根本没有上限" ——
   * 这两件事在界面上必须长得不一样。
   */
  const tone = d.unlimited ? 'ok' : d.pct >= 90 ? 'ERROR' : d.pct >= 70 ? 'WARNING' : 'ok';
  return (
    <div className="quota-dim">
      <div className="quota-dim-head">
        <span className="quota-dim-label">
          {props.label}
          <span className="muted-sm"> · {d.periodText}</span>
        </span>
        <span className="quota-dim-num mono" title={d.unlimited ? '本档位不设上限' : `已用 ${formatExact(d.used)} / 上限 ${formatExact(d.limit ?? 0)}`}>
          {d.usedText} / {d.limitText}
        </span>
      </div>
      {d.unlimited ? null : (
        <div className="quota-bar" data-kind={props.kind}>
          <div className={`quota-bar-fill quota-bar-${tone.toLowerCase()}`} style={{ width: `${Math.max(2, d.pct)}%` }} />
        </div>
      )}
      <div className="quota-dim-foot">
        {d.unlimited ? <span className="muted-sm">不限量</span> : <span className="muted-sm">还剩 {d.remainText}</span>}
        {!d.unlimited && d.pct > 0 ? <span className="muted-sm">{d.pct}%</span> : null}
      </div>
    </div>
  );
}

export function QuotaMeter(props: { quota: QuotaView; /** 紧凑模式：AI 面板里只占一行 */ compact?: boolean }): ReactNode {
  const q = props.quota;
  return (
    <div className={`quota-meter ${props.compact ? 'quota-compact' : ''}`}>
      {!props.compact ? (
        <div className="quota-head">
          <Pill kind={q.blockedBy ? 'ERROR' : 'muted'}>{q.planLabel}</Pill>
          <span className="muted-sm">
            今日已调用 {formatCount(q.calls.day)} 次 · 累计 {formatTokens(q.calls.totalTokens)} token · 累计生成 {formatCount(q.calls.totalGenerations)} 次
          </span>
        </div>
      ) : null}
      <div className="quota-dims">
        <Bar dim={q.tokens} label="token 用量" kind="tokens" />
        <Bar dim={q.generations} label="生成次数" kind="generations" />
      </div>
      {q.blockedBy ? (
        <div className="alert alert-warn quota-blocked">
          <b>已被额度拦住：</b>
          {q.blockReason}
          {q.blockedBy === 'generations' ? '（对话提问只花 token，不计生成次数）' : ''}
        </div>
      ) : null}
    </div>
  );
}
