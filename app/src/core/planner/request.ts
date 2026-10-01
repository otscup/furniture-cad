/**
 * ══════════════════════════════════════════════════════════════════════
 *  规划请求的**语义归一化**（P9.5）
 *
 *  ── 与 `shared/aiContract.mjs` 的 `validatePlannerRequest` 分工 ──
 *    契约（纯 JS、服务端与前端共用）只管**形状**：白名单键、类型、拒几何字段。
 *    这里只管**语义**：这些 id 在**这个项目**里真的存在吗？是 active 意图吗？
 *    目标方向词在闭集里吗？规模是否超过上限？
 *    两边**都在自己的层里**做，不重复也不越界。
 *
 *  ── 三条处理原则（与 §十七 的判据一一对应）──
 *    ① **引用不存在 → 记进 `unresolved`，不静默丢**（"你要的这条我找不到，所以我没按它规划"）；
 *    ② **规模超限 / 目标词不认识 → 整份拒绝**（不裁剪、不猜测 —— 见 model.ts 的注释）；
 *    ③ **绝不补默认值来"让请求跑起来"**：`maxCandidates` 非法才回落到默认，
 *       而"缺 `scope`"这种结构性缺失一律报错（缺了它整份规划的含义都变了）。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Project } from '../types.ts';
import { activeDesignIntents } from '../designIntent/model.ts';
import { DESIGN_INTENT_GOALS, designIntentGoalZh, type DesignIntentGoal } from '../designIntent/vocabulary.ts';
import { MAX_CANDIDATES_PER_TARGET } from '../candidateLayout/model.ts';
import {
  MAX_PLANNER_CABINETS,
  MAX_PLANNER_GOALS,
  MAX_PLANNER_INTENTS,
  type PlannerRequest,
  type PlannerRequestResult,
  type PlannerScope,
  type PlannerUnresolved,
} from './model.ts';

const GOAL_WORDS = new Set(Object.keys(DESIGN_INTENT_GOALS));

/** 夹取候选上限：非法值回落到默认（与 P9.3 `clampMax` 同一口径，不静默给 0） */
function clampMax(v: number | undefined): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) return MAX_CANDIDATES_PER_TARGET;
  return Math.max(1, Math.min(MAX_CANDIDATES_PER_TARGET, Math.floor(v)));
}

/**
 * 把一个（未经信任的）规划请求对着项目归一化。
 *
 * @param raw     AI 或界面给的请求（形状已过契约；这里仍防御性检查一遍）
 * @param project 当前项目（**只读**；本函数绝不修改它）
 */
export function normalizePlannerRequest(raw: unknown, project: Project): PlannerRequestResult {
  const unresolved: PlannerUnresolved[] = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '规划请求不是一个对象', unresolved };
  }
  const r = raw as Record<string, unknown>;

  // ── scope：结构性的，缺了就报错（不猜一个默认值）──
  const scope = r.scope;
  if (scope !== 'room' && scope !== 'project') {
    return {
      ok: false,
      error: `规划请求的 scope 必须是 "room" 或 "project"，收到 ${JSON.stringify(scope ?? null)}`,
      unresolved,
    };
  }

  // ── intentIds：逐条查 active；不存在的**如实记**，不静默丢 ──
  const active = activeDesignIntents(project);
  const activeIds = new Set(active.map((i) => i.id));
  let intentIds: string[] | undefined;
  if (r.intentIds !== undefined) {
    if (!Array.isArray(r.intentIds) || r.intentIds.some((v) => typeof v !== 'string')) {
      return { ok: false, error: 'intentIds 必须是字符串 id 数组', unresolved };
    }
    const list = [...(r.intentIds as string[])];
    if (list.length > MAX_PLANNER_INTENTS) {
      return {
        ok: false,
        // 超限**整份拒绝**（不裁剪）：砍掉几条 = 用户以为全都规划了
        error: `规划请求要按 ${list.length} 条意图规划，超过上限 ${MAX_PLANNER_INTENTS} —— 请拆成几次规划`,
        unresolved,
      };
    }
    const kept: string[] = [];
    for (const id of list) {
      if (activeIds.has(id)) kept.push(id);
      else {
        unresolved.push({
          intentId: id,
          reason: `意图 ${id} 不在生效集合里 —— 只有 active 意图能驱动规划（未确认的 candidate / 已否掉的 rejected / 不存在的都不参与）`,
        });
      }
    }
    intentIds = kept;
  }

  // ── cabinetIds：逐条查存在；不存在的**如实记** ──
  let cabinetIds: string[] | undefined;
  if (r.cabinetIds !== undefined) {
    if (!Array.isArray(r.cabinetIds) || r.cabinetIds.some((v) => typeof v !== 'string')) {
      return { ok: false, error: 'cabinetIds 必须是字符串 id 数组', unresolved };
    }
    const list = [...(r.cabinetIds as string[])];
    if (list.length > MAX_PLANNER_CABINETS) {
      return {
        ok: false,
        // 超限**整份拒绝**（不裁剪）：砍掉柜子 = 静默丢柜
        error: `规划请求要规划 ${list.length} 只柜体，超过上限 ${MAX_PLANNER_CABINETS} —— 请拆成几次规划（本层不裁剪，免得你以为整屋都规划了）`,
        unresolved,
      };
    }
    const kept: string[] = [];
    for (const id of list) {
      if (project.cabinets.some((c) => c.id === id)) kept.push(id);
      else unresolved.push({ cabinetId: id, reason: `柜体 ${id} 不在项目里 —— 本层不会凭空给它造一个候选` });
    }
    cabinetIds = kept;
  }

  // ── generationGoals：词必须在闭集里；不认识就整份拒绝（不猜一个相近的词）──
  let generationGoals: DesignIntentGoal[] | undefined;
  if (r.generationGoals !== undefined) {
    if (!Array.isArray(r.generationGoals) || r.generationGoals.some((v) => typeof v !== 'string')) {
      return { ok: false, error: 'generationGoals 必须是字符串数组（目标方向词）', unresolved };
    }
    const list = [...(r.generationGoals as string[])];
    if (list.length > MAX_PLANNER_GOALS) {
      return {
        ok: false,
        error: `generationGoals 给了 ${list.length} 个目标词，超过上限 ${MAX_PLANNER_GOALS}（词表一共就 ${GOAL_WORDS.size} 个）`,
        unresolved,
      };
    }
    const unknown = list.filter((g) => !GOAL_WORDS.has(g));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `generationGoals 里有词表外的目标词：${unknown.join('、')} —— 目标方向必须来自词表（${[...GOAL_WORDS].map((g) => designIntentGoalZh(g as DesignIntentGoal)).join(' / ')}）`,
        unresolved,
      };
    }
    generationGoals = list as DesignIntentGoal[];
  }

  // ── maxCandidates：夹取（与 P9.3 同口径）──
  const maxCandidates = clampMax(r.maxCandidates as number | undefined);
  if (r.maxCandidates !== undefined && maxCandidates !== r.maxCandidates) {
    unresolved.push({
      reason: `maxCandidates=${JSON.stringify(r.maxCandidates)} 不在 [1, ${MAX_CANDIDATES_PER_TARGET}] 内，已夹到 ${maxCandidates}`,
    });
  }

  const request: PlannerRequest = {
    scope: scope as PlannerScope,
    ...(intentIds !== undefined ? { intentIds } : {}),
    ...(cabinetIds !== undefined ? { cabinetIds } : {}),
    ...(generationGoals !== undefined ? { generationGoals } : {}),
    ...(maxCandidates !== undefined ? { maxCandidates } : {}),
  };
  return { ok: true, request, unresolved };
}
