import type { ReactNode } from 'react';
import { useState } from 'react';
import type { Project } from '../../core/types.ts';
import type { PlannerPlan } from '../../core/planner/model.ts';
import type { DesignScoreComponent, DesignScoreHardFailure } from '../../core/designScore/model.ts';
import { designScoreHitZh } from '../../core/designScore/index.ts';
import { plannerPlanSummaryZh } from '../../core/planner/plan.ts';
import { Pill, Row, Text } from './common.tsx';
import { buildCandidateComparison, sortComparisonRows } from './candidateCompareLogic.ts';
import { candidatePlacementZh } from '../../core/candidateLayout/model.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  Multi-Candidate Compare UI（P9.6）—— 只消费运行态，绝不生产
 *
 *  ── 这条组件的全部 ──
 *    把 P9.3 `CandidateLayout` + P9.4 `DesignScore` + P9.5 `PlannerPlan` 的
 *    **运行态**结果并列展示给用户，让用户手动选一份。
 *
 *  ── 红线（每条都在代码里落点）──
 *    ① 不造 winner：只有"选择此方案"按钮，**绝不**出现"最佳/推荐/winner/auto-select"；
 *       排序只用 `compareDesignScores()`，且旁注"显示排序，非 winner 判定"。
 *    ② 不重算：collision / wall contact / room relation / opening / door swing /
 *       score / preference 全部直接读 `plan` 里既有字段，本组件**不调任何判定函数**。
 *    ③ 不写模型：选中只改 UI 高亮 + 上抛 `onSelect`；落地必须经 `onPreview` →
 *       既有 `dryRunPlan` → `PlanRunView` → `commitPlan`（第二条提交链路不存在）。
 *    ④ 不持久化：candidate / score / comparison / selected 都不进 `project.json`；
 *       `selectedCandidateId` 是 UI/session 态（由父层用一个独立前缀的 sessionStorage key 管）。
 *    ⑤ 不复用 `adoptVariant`：候选只引用已有柜，落地走 `cabinet.move`+`cabinet.rotate` 命令。
 *
 *  ── DTO（§三）：纯展示投影，绝不持有 x/y/rotation/polygon ──
 *    `CandidateComparison` 只引用既有 `layout`/`score`，不为比较新增任何几何字段。
 *  ── 纯逻辑层在 `candidateCompareLogic.ts`（无 JSX、可单测）──
 *    本文件只负责把那份 DTO 渲染成界面，不持有任何判定/几何/写路径。
 * ══════════════════════════════════════════════════════════════════════
 */

// ── 渲染组件 ──

const HIT_KIND: Record<'yes' | 'no' | 'unknown', 'ok' | 'ERROR' | 'WARNING'> = {
  yes: 'ok',
  no: 'ERROR',
  unknown: 'WARNING',
};

function cabinetNameOf(project: Project, targetId: string): string {
  return project.cabinets.find((c) => c.id === targetId)?.name ?? targetId;
}

function HitPill({ hit }: { hit: 'yes' | 'no' | 'unknown' }): ReactNode {
  return <Pill kind={HIT_KIND[hit]}>{designScoreHitZh(hit)}</Pill>;
}

function ComponentRow({ c }: { c: DesignScoreComponent }): ReactNode {
  return (
    <li className="cc-comp">
      <HitPill hit={c.hit === 'yes' ? 'yes' : c.hit === 'no' ? 'no' : 'unknown'} />
      <Text mono>{c.label}</Text>
      <span className="cc-why">{c.why}</span>
    </li>
  );
}

function HardFailure({ f }: { f: DesignScoreHardFailure }): ReactNode {
  return (
    <li className="alert alert-error">
      <Pill kind="ERROR">{f.code}</Pill> {f.message}
    </li>
  );
}

export interface CandidateComparePanelProps {
  plan: PlannerPlan;
  /** 只读：仅用于显示柜体名字，绝不据此计算几何 */
  project: Project;
  selectedCandidateId: string | null;
  onSelect: (candidateId: string) => void;
  onPreview: (candidateId: string) => void;
  onClose: () => void;
}

export function CandidateComparePanel(props: CandidateComparePanelProps): ReactNode {
  const { plan, project, selectedCandidateId, onSelect, onPreview, onClose } = props;
  const [sortByScore, setSortByScore] = useState(false);
  const cmp = buildCandidateComparison(plan);
  const rows = sortComparisonRows(cmp.rows, sortByScore);

  if (plan.candidates.length === 0) {
    return (
      <div className="panel-scroll">
        <div className="note">
          {plannerPlanSummaryZh(plan)}。当前没有可枚举的候选——通常是因为没有 **active** 设计意图，或所有意图本阶段不产生候选。
        </div>
        {plan.unresolved.length > 0 ? (
          <ul className="diff-list">
            {plan.unresolved.map((u, i) => (
              <li key={i} className="muted-sm">{u.reason ?? JSON.stringify(u)}</li>
            ))}
          </ul>
        ) : null}
        <div className="btn-row">
          <button type="button" className="tb-btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    );
  }

  return (
    <div className="panel-scroll">
      <div className="note">
        {plannerPlanSummaryZh(plan)}。下面每份候选都是**确定性枚举 + 确定性评分**的结果，坐标来自落位引擎、分数来自评分层——
        本界面不重算、不替你选。**选哪份由你拍板**，选完点"预览"走既定提交链路。
      </div>

      <div className="cc-sort">
        <label>
          <input type="checkbox" checked={sortByScore} onChange={(e) => setSortByScore(e.target.checked)} />
          按分数排序（<b>仅展示排序，不做优劣判定</b> —— 不替你选哪份更好）
        </label>
      </div>

      {rows.map((row) => {
        const selected = row.layout.id === selectedCandidateId;
        return (
          <div key={row.layout.id} className={`cc-card ${selected ? 'cc-card-selected' : ''}`}>
            <div className="cc-card-head">
              <b>候选 {row.label}</b>
              <Pill kind={row.score.status === 'valid' ? 'ok' : 'ERROR'}>
                {row.score.status === 'valid' ? '可用' : '不可行'}
              </Pill>
              <span className="muted-sm">
                {row.layout.placements.map((p) => cabinetNameOf(project, p.targetId)).join('、')}
              </span>
            </div>

            {row.layout.placements.length > 1 ? (
              <div className="cc-multi">
                <div className="ts">整体方案（{row.layout.placements.length} 柜同时落位）：</div>
                <ul className="diff-list">
                  {row.layout.placements.map((p) => (
                    <li key={p.targetId} className="muted-sm">{candidatePlacementZh(p, project)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {row.score.status === 'infeasible' ? (
              <ul className="diff-list">
                {row.score.hardFailures.map((f, i) => (
                  <HardFailure key={i} f={f} />
                ))}
              </ul>
            ) : (
              <>
                <Row label="总分（命中项数，无权重）" derived>
                  <Text mono>{row.score.total ?? 0}</Text>
                </Row>
                <div className="ts">条件 / 偏好命中：</div>
                <ul className="diff-list">
                  {row.score.components.map((c, i) => (
                    <ComponentRow key={i} c={c} />
                  ))}
                </ul>
                {row.score.preferenceMatches.length > 0 ? (
                  <div className="muted-sm">
                    偏好命中 {row.score.preferenceMatches.length} 条（加权建议，永不进阻断错误）
                  </div>
                ) : null}
              </>
            )}

            {row.layout.explanations.length > 0 ? (
              <ul className="diff-list">
                {row.layout.explanations.map((e, i) => (
                  <li key={i} className="muted-sm">{e}</li>
                ))}
              </ul>
            ) : null}

            {row.layout.unresolved.length > 0 ? (
              <div className="cc-unresolved">
                未满足：{row.layout.unresolved.map((u) => u.reason ?? '未满足').join('；')}
              </div>
            ) : (
              <div className="muted-sm">满足的设计意图已在上方命中项中标出</div>
            )}

            <div className="btn-row">
              <button
                type="button"
                className={selected ? 'tb-btn primary' : 'tb-btn'}
                onClick={() => onSelect(row.layout.id)}
              >
                {selected ? '✓ 已选择此方案' : '选择此方案'}
              </button>
              <button
                type="button"
                className="tb-btn"
                disabled={row.score.status === 'infeasible'}
                onClick={() => onPreview(row.layout.id)}
              >
                预览此方案
              </button>
            </div>
          </div>
        );
      })}

      {cmp.intentMatrix.length > 0 ? (
        <div className="cc-matrix">
          <div className="ts">设计意图满足对比（yes=满足 / no=不满足 / unknown=判不出，不折算 0 分）：</div>
          <table className="cc-table">
            <thead>
              <tr>
                <th>设计意图</th>
                {rows.map((r) => (
                  <th key={r.layout.id}>候选 {r.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cmp.intentMatrix.map((m) => (
                <tr key={m.intentId}>
                  <td>{m.label}</td>
                  {rows.map((r) => (
                    <td key={r.layout.id}>
                      <HitPill hit={m.byCandidate[r.layout.id] ?? 'unknown'} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {plan.unresolved.length > 0 ? (
        <div className="cc-plan-unresolved">
          <div className="ts">本规划未解决事项：</div>
          <ul className="diff-list">
            {plan.unresolved.map((u, i) => (
              <li key={i} className="muted-sm">{u.reason ?? JSON.stringify(u)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="btn-row">
        <button type="button" className="tb-btn" onClick={onClose}>关闭对比</button>
      </div>
    </div>
  );
}
