import type { Cabinet } from '../core/types.ts';
import type { CommandBus } from '../core/commandBus.ts';
import * as CMD from '../core/commands.ts';
import {
  resolvePlacement,
  sceneFromProject,
  toPlacementIntentDecl,
  type PlacementAlignment,
  type PlacementIntent,
  type PlacementFace,
  type AttachAlignment,
} from '../core/placement.ts';
import { designCheckPlacement, type DesignPlacementReport } from '../core/placementDesign.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  语义落位意图 —— UI 入口的纯逻辑层（P8.6）
 *
 *  ── 解决什么 ──
 *    P8.5-B 之前，用户只能拖拽（intent=null）或靠 AI 提案表达落位意图。
 *    这里给用户一个明确入口："B 柜对齐 A 柜右缘"、"B 柜背面贴 A 柜正面"。
 *    用户点的是语义，不是坐标 —— 界面上没有 x/y 输入框。
 *
 *  ── 纪律（P8.6 验收硬边界）──
 *    · 本模块**不实现第二套 resolver**：坐标全部来自 `core/placement.ts`
 *      的 `resolvePlacement`（唯一确定性解析器）；
 *    · 提交走唯一的 `cabinet.place` 命令（source='ui' → 总线派生
 *      user-authored），不新增 uiPlace/uiAlign/uiAttach 平行执行路径；
 *    · 声明用 `toPlacementIntentDecl`（词表与引擎逐字同一份）；
 *    · "放得合不合理"直接消费 P8.3 的 `designCheckPlacement` 报告，
 *      只提示不拦截（设计语义层不替用户做决定）；
 *    · 拖拽（cabinet.move / NumField 改 x/y）不经过这里 → intent=null，
 *      绝不从最终坐标反推 alignment。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 对齐意图：target 与 reference 的指定边缘/中心齐平（alignment 必填） */
export function buildAlignIntent(targetId: string, referenceId: string, alignment: PlacementAlignment): PlacementIntent {
  return { relation: 'align', targetId, referenceId, alignment };
}

/** 贴合意图：两个有名有姓的面贴合；offset 为缝隙 mm（缺省 0 = 真贴合） */
export function buildAttachIntent(
  targetId: string,
  referenceId: string,
  targetFace: PlacementFace,
  referenceFace: PlacementFace,
  alignment?: AttachAlignment,
  offset?: number
): PlacementIntent {
  return {
    relation: 'attach',
    targetId,
    referenceId,
    targetFace,
    referenceFace,
    ...(alignment !== undefined ? { alignment } : {}),
    ...(offset !== undefined ? { offset } : {}),
  };
}

/** 人话 label（审计与撤销列表里要说得出"这次落位是怎么来的"） */
export function placementIntentLabel(cab: Cabinet, ref: Cabinet, intent: PlacementIntent): string {
  if (intent.relation === 'align') {
    const zh: Record<PlacementAlignment, string> = {
      left: '左缘',
      right: '右缘',
      front: '前缘',
      back: '后缘',
      center: '中心',
    };
    return `「${cab.name}」对齐「${ref.name}」${zh[intent.alignment]}`;
  }
  if (intent.relation === 'attach') {
    const gap = intent.offset ? `（缝隙 ${intent.offset}mm）` : '';
    return `「${cab.name}」${intent.targetFace}面贴合「${ref.name}」${intent.referenceFace}面${gap}`;
  }
  return `落位「${cab.name}」`;
}

export type CommitPlacementIntentResult =
  | { ok: true; placement: { x: number; y: number; rotation: number }; report: DesignPlacementReport }
  | { ok: false; error: string };

/**
 * 用户语义落位的唯一提交路径：
 *   Intent → resolvePlacement（唯一 Resolver）→ designCheckPlacement（P8.3 报告，只提示）
 *         → cabinet.place（source='ui'，带 placementIntentDecl）→ CommandBus provenance。
 *
 * 解析失败不改任何状态（两段式纪律的 UI 侧体现：失败就停在 preview 前）。
 */
export function commitPlacementIntent(
  bus: CommandBus,
  cab: Cabinet,
  ref: Cabinet,
  intent: PlacementIntent
): CommitPlacementIntentResult {
  const r = resolvePlacement(intent, sceneFromProject(bus.getState()));
  if (!r.ok) return { ok: false, error: r.error.message };
  // P8.3 报告在**提交前**对"解析后的假想状态"算一次，随结果返回给 UI 展示（只提示不拦截）
  const report = designCheckPlacement(bus.getState(), intent, r);
  const cmd = CMD.placeCabinet(cab, r.placement, 'ui', placementIntentLabel(cab, ref, intent), toPlacementIntentDecl(intent));
  const ex = bus.execute(cmd, { commitLabel: cmd.label });
  if (!ex.ok) return { ok: false, error: ex.error ?? '落位被拒绝' };
  return { ok: true, placement: r.placement, report };
}
