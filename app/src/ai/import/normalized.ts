import type { ImportOrigin, ImportSource, Issue, Project } from '../../core/types.ts';
import { buildIssue } from '../../core/rules/issueCatalog.ts';
import { proposalShapeError } from '../../../shared/aiContract.mjs';
import {
  type DesignProposal,
  type ProposalCabinet,
  type ProposalUnit,
  type ProposalRow,
  type ProposalAssembly,
  validateProposal,
} from '../proposal.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  NormalizedDesign —— External Data → Import Adapter → Normalized Design
 *
 *  ── 它在链路里的位置 ──
 *    外部数据（JSON / DXF / 酷家乐 / 图片识别）经各自的 Adapter 解析后，
 *    **统一落成 NormalizedDesign**，再经 `compileImport` 确定性地编译成
 *    AiAction（与 P3 DesignProposal 走同一条 dryRun → 预览 → 确认 → commitPlan
 *    的链路）。Adapter 是「翻译」，NormalizedDesign 是「翻译后的标准语」。
 *
 *  ── 与 DesignProposal 的关系 ──
 *    柜体形状（units / rows / backUnits / rotation）**完全一致**，复用同一套
 *    ProposalCabinet，不另起一套。多出来的只是「来源归属」：
 *      · `source` 来源平台；`label` 人类可读来源；`batchId` 批次
 *      · 每条柜体有 `confidence` / `uncertainty`（per-cabinet 归属）
 *      · `unverifiedCapabilities` 适配器未验证的能力（酷家乐 / 图片识别占位时填）
 *
 *  ── 三条硬边界（与 DesignProposal 同源）──
 *    ① **没有坐标**：这里出现的数只有尺寸与数量。落位由 pickFreeSpot 定。
 *    ② **不是后门**：编译产物是 AiAction，仍过契约 / CommandBus / 规则校验。
 *    ③ **不确定就问不猜**：uncertainty / questions 非空 → 阻断应用。
 * ══════════════════════════════════════════════════════════════════════
 */

export type NormalizedUnit = ProposalUnit;
export type NormalizedRow = ProposalRow;
export type NormalizedAssembly = ProposalAssembly;

/** 同形 ProposalCabinet + per-cabinet 来源归属 */
export interface NormalizedCabinet extends ProposalCabinet {
  /** 单柜来源（缺省 = 整批 source）。适配器可逐柜覆盖 */
  source?: ImportSource;
  /** 适配器对该柜的置信度（不给 = 用整批） */
  confidence?: 'high' | 'medium' | 'low';
  /** 该柜没可靠确定的内容（阻断应用） */
  uncertainty?: string[];
}

export interface NormalizedDesign {
  id?: string;
  title: string;
  summary?: string | null;
  /** 来源平台标识 */
  source: ImportSource;
  /** 人类可读来源（文件名 / URL / 平台名 / 批次说明） */
  label?: string;
  /** 同一批次导入共享的 id（适配器生成，落进每条 Cabinet.origin） */
  batchId: string;
  room?: string | null;
  cabinets: NormalizedCabinet[];
  assemblies?: NormalizedAssembly[] | null;
  assumptions?: string[] | null;
  /** 必须用户回答的问题 —— 非空阻断应用 */
  questions?: string[] | null;
  /** 适配器未验证的能力（酷家乐 / 图片识别占位时填，不阻断但必须显示） */
  unverifiedCapabilities?: string[] | null;
}

// ════════════════════ 校验（对着项目与规则集，带数字）═══════════════════════

/**
 * NormalizedDesign 校验。
 * 形状门复用契约 proposalShapeError（宽松，忽略 source/confidence 等多余字段）；
 * 房间 / 尺寸 / 分区 / 组合复用 validateProposal 的 PROPOSAL-*（通用方案校验）；
 * 导入专属的 EMPTY / OPEN-QUESTIONS / UNCERTAINTY / UNVERIFIED-CAPABILITY
 * 用 IMPORT-*（带数字，不会被兜底值顶替成假绿）。
 *
 * 与 DesignProposal 的区别：导入多管"来源可信 / 不确定项"，且形状门要带数字
 * （IMPORT-SHAPE 直接吃 proposalShapeError 的人话，不自己编范围）。
 */
export function validateNormalized(nd: NormalizedDesign, project: Project): Issue[] {
  const out: Issue[] = [];
  const t = (suffix: string): string => `import${suffix}`;

  // 1. 形状门（复用契约，唯一实现）；宽松忽略 source/confidence 等多余字段
  const shapeErr = proposalShapeError(nd as unknown as Record<string, unknown>);
  if (shapeErr) {
    out.push(buildIssue('IMPORT-SHAPE', { target: t(''), targetKind: 'project', ctx: { detail: shapeErr } }));
    return out;
  }

  // 2. 空
  if (!Array.isArray(nd.cabinets) || nd.cabinets.length === 0) {
    out.push(buildIssue('IMPORT-EMPTY', { target: t(''), targetKind: 'project', ctx: { count: 0 } }));
    return out;
  }

  // 3. 通用方案校验（房间 / 尺寸 / 分区 / 组合）—— 投影掉 import 专属字段；
  //    questions 剥离，OPEN-QUESTIONS 由下面第 5 步用 IMPORT-* 报（避免与 PROPOSAL-* 重复）
  const projected: DesignProposal = {
    title: nd.title,
    summary: nd.summary ?? null,
    room: nd.room ?? null,
    cabinets: nd.cabinets.map((c) => ({
      ref: c.ref,
      name: c.name,
      room: c.room,
      width: c.width,
      height: c.height,
      depth: c.depth,
      units: c.units,
      rows: c.rows,
      backUnits: c.backUnits,
      rotation: c.rotation,
    })),
    assemblies: nd.assemblies ?? null,
    assumptions: nd.assumptions ?? null,
    questions: null,
  };
  out.push(...validateProposal(projected, project));

  // 4. 未验证能力（不阻断，必须显示）
  for (const cap of nd.unverifiedCapabilities ?? []) {
    if (typeof cap === 'string' && cap.trim() !== '') {
      out.push(buildIssue('IMPORT-UNVERIFIED-CAPABILITY', { target: t(''), targetKind: 'project', ctx: { source: nd.source, capability: cap } }));
    }
  }

  // 5. 开放问题（阻断）
  const questions = (nd.questions ?? []).filter((q) => typeof q === 'string' && q.trim() !== '');
  if (questions.length > 0) {
    out.push(buildIssue('IMPORT-OPEN-QUESTIONS', { target: t(''), targetKind: 'project', ctx: { count: questions.length, first: questions[0] } }));
  }

  // 6. 不确定项（阻断 —— 不替用户猜）
  const uncertainty = nd.cabinets
    .flatMap((c) => c.uncertainty ?? [])
    .filter((u) => typeof u === 'string' && u.trim() !== '');
  if (uncertainty.length > 0) {
    out.push(buildIssue('IMPORT-UNCERTAINTY', { target: t(''), targetKind: 'project', ctx: { count: uncertainty.length, first: uncertainty[0] } }));
  }

  // 7. 整体置信度（不阻断，提示逐柜核对）—— 只数适配器**明确**标 low 的
  const lowCount = nd.cabinets.filter((c) => c.confidence === 'low').length;
  if (lowCount > 0) {
    out.push(buildIssue('IMPORT-LOW-CONFIDENCE', {
      target: t(''),
      targetKind: 'project',
      ctx: { count: lowCount, sources: nd.source },
    }));
  }

  return out;
}

/** 有这些问题就不能应用到模型（ERROR，或"必须你先回答"，或"有未确定内容"） */
export function importBlocked(issues: Issue[]): boolean {
  return issues.some(
    (i) => i.severity === 'ERROR' || i.code === 'IMPORT-OPEN-QUESTIONS' || i.code === 'IMPORT-UNCERTAINTY',
  );
}

/** 投影成 DesignProposal（去掉 import 专属字段，questions 置空由 IMPORT-* 报） */
export function normalizedToProposal(nd: NormalizedDesign): DesignProposal {
  return {
    title: nd.title,
    summary: nd.summary ?? null,
    room: nd.room ?? null,
    cabinets: nd.cabinets.map((c) => ({
      ref: c.ref,
      name: c.name,
      room: c.room,
      width: c.width,
      height: c.height,
      depth: c.depth,
      units: c.units,
      rows: c.rows,
      backUnits: c.backUnits,
      rotation: c.rotation,
    })),
    assemblies: nd.assemblies ?? null,
    assumptions: nd.assumptions ?? null,
    questions: null,
  };
}

// ─────────────────────────── 共享工具（适配器复用）───────────────────────────

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
export function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
export function numOrU(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
export function arrOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const r = v.filter((x) => typeof x === 'string' && x.trim() !== '');
  return r.length ? r : null;
}

/** 拆出一条导入来源归属（供 compileImport 注入动作） */
export function originForCabinet(nd: NormalizedDesign, c: NormalizedCabinet): ImportOrigin {
  return {
    source: c.source ?? nd.source,
    label: nd.label,
    batchId: nd.batchId,
    confidence: c.confidence,
    uncertainty: c.uncertainty,
  };
}
