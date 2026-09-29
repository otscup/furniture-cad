import type { ReactNode } from 'react';
import type { PlanRun } from '../../ai/planRunner.ts';
import type { Issue } from '../../core/types.ts';
import { Pill, Row, Text } from './common.tsx';

/**
 * 干跑预览的通用渲染块 —— plan 模式与 P3 的 design 模式**共用同一套**。
 *
 * 为什么抽出来：`dryRunPlan` 的产出（PlanRun）对两种模式完全同构，
 * 而原先这段 ~80 行的渲染只在 plan 段出现一次。P3 设计方案也要渲染同样的东西
 * （差异只在外层标题与按钮文案），复制一份必然与这份漂移 ——
 * 而"预览看着对、提交却不一样"是本项目最严重的那种不一致。
 *
 * 注意：本组件**只渲染**，所有动作（应用/丢弃）都靠回调上抛。
 * 它不持有任何状态，也不碰总线 —— 严格守住"预览只是看，点应用才是写"。
 */

function fmt(v: unknown): string {
  if (v === undefined) return '(无)';
  if (typeof v === 'string') return v.length > 40 ? `${v.slice(0, 40)}…` : v;
  return String(v);
}

export function PlanRunView(props: {
  run: PlanRun;
  onApply: () => void;
  onDismiss: () => void;
  lastApply: string;
  /** 应用按钮文案；缺省时按"已应用/应用全部 N 条"自适应 */
  applyLabel?: string;
  dismissLabel?: string;
}): ReactNode {
  const { run, onApply, onDismiss, lastApply } = props;
  const applyLabel = props.applyLabel ?? (run.committed ? `✓ 已应用 ${run.okCount} 条` : `应用全部（${run.okCount} 条）`);
  const dismissLabel = props.dismissLabel ?? '丢弃';
  return (
    <>
      <p className="note">
        下面每一条都已在<b>沙盒模型</b>上真跑过一遍，用的是和提交完全相同的命令 ——
        所以「预览 = 提交」是结构性的，不是两边都写对了。
      </p>
      {run.steps.map((s, i) => (
        <div key={i} className={`plan-step ${s.ok ? '' : 'plan-step-bad'}`}>
          <div className="plan-head">
            <Pill kind={s.ok ? 'ok' : 'ERROR'}>{s.ok ? '可应用' : '失败'}</Pill>
            <Text mono>{s.action.action}</Text>
            <span className="muted-sm">
              {s.action.target.cabinetName ? `→「${s.action.target.cabinetName}」` : ''}
              {s.action.target.unit !== undefined ? ` 分区 ${String(s.action.target.unit)}` : ''}
            </span>
          </div>
          {s.error ? <div className="alert alert-error">{s.error}</div> : null}
          {s.action.reason ? <div className="plan-reason">AI 理由：{s.action.reason}</div> : null}
          {s.ok ? (
            <>
              <div className="plan-label">{s.label}</div>
              <ul className="diff-list">
                {s.diff.slice(0, 8).map((d, j) => (
                  <li key={j}>
                    <Text mono>{d.path}</Text>：{fmt(d.from)} → <b>{fmt(d.to)}</b>
                  </li>
                ))}
                {s.diff.length > 8 ? <li className="muted-sm">…另有 {s.diff.length - 8} 处</li> : null}
              </ul>
              {s.memoryHits.length > 0 ? (
                <div className="alert alert-error">
                  被记忆拦住（你之前纠正过的规矩）：{s.memoryHits.map((h) => h.message).join('；')}
                </div>
              ) : null}
              {s.newIssues.length > 0 ? (
                <div className="plan-issues">
                  {s.newIssues.map((x: Issue, j: number) => (
                    <div key={j}>
                      <Pill kind={x.severity === 'ERROR' ? 'ERROR' : x.severity === 'WARNING' ? 'WARNING' : 'INFO'}>{x.severity}</Pill>{' '}
                      <Text mono>{x.code}</Text> {x.message}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="muted-sm">未新增任何规则问题</div>
              )}
              {s.resolvedIssues.length > 0 ? <div className="muted-sm">顺带消除 {s.resolvedIssues.length} 条问题</div> : null}
              {s.clamped.length > 0 ? <div className="muted-sm">被钳制：{s.clamped.join('；')}</div> : null}
            </>
          ) : null}
        </div>
      ))}
      <div className="btn-row">
        <button type="button" className="tb-btn primary" disabled={run.okCount === 0 || run.committed} onClick={onApply}>
          {applyLabel}
        </button>
        <button type="button" className="tb-btn" onClick={onDismiss}>
          {dismissLabel}
        </button>
      </div>
      <Row label="干跑后模型里仍有 ERROR" derived hint="ERROR 会阻断生产数据导出；WARNING 不阻断">
        {run.blockingErrors > 0 ? <Pill kind="ERROR">{run.blockingErrors}</Pill> : <Pill kind="ok">0</Pill>}
      </Row>
      {run.impact.length > 0 ? (
        <Row
          label="影响面（连带改变）"
          derived
          hint="由干跑前后两次真实派生对比得出。你点选的「一条线」背后连着门板高、抽屉分格、铰链数量 —— 这里列出的是它们实际会怎么变"
        >
          <ul className="diff-list">
            {run.impact.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </Row>
      ) : null}
      {lastApply ? <div className="alert alert-info">{lastApply}</div> : null}
    </>
  );
}
