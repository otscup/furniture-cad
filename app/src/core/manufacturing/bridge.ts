/**
 * ══════════════════════════════════════════════════════════════════════
 *  Manufacturing 兼容桥（P7）—— 让 BOM / DXF 消费制造层确定性结果
 *
 *  ── 为什么需要桥 ──
 *    主方案要求「Semantic Model → Manufacturing Derivation → BOM / DXF」，
 *    而不是「Semantic → BOM 一套、Semantic → DXF 另一套」。本文件把制造层
 *    接回既有出口，保证两处出口与制造件**同一来源**。
 *
 *  ── 三个桥 ──
 *    ① manufacturingToPanels：制造件**无损回投影**到几何 Panel[]。
 *       因为 ManufacturingPart 完整保留了 Panel 的全部字段，回投影逐字段相等
 *       → DXF 用制造板件 = DXF 用几何板件（图 = 料 不变）。
 *    ② bomFromManufacturing：从制造件产 BOM 行，每行带 sourcePanelId，
 *       可追溯回具体制造件 / 几何板件 / 语义实体。
 *    ③ manufacturingToNeutralExport：DXF 真正消费制造层（经 neutralSheet 的
 *       panelsOverride 兼容参数，旧调用不变）。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { Panel, Project, RuleSet } from '../types.ts';
import { generateProject } from '../geometry/project.ts';
import { toNeutralExport, type NeutralExport } from '../../export/neutralSheet.ts';
import { deriveManufacturing } from './derive.ts';
import { DEFAULT_MANUFACTURING_RULES, type ManufacturingRuleSet } from './rules.ts';
import type { ManufacturingPart, MfgVerification } from './model.ts';

/**
 * BOM 行。与既有「板件清单」字段对齐，额外带 sourcePanelId 追溯制造件。
 * 这样 BOM 与 Manufacturing Part 来源一致（验收可钉）。
 */
export interface BomRow {
  id: string;
  /** 回指制造件 / 几何板件 id（三者同一字符串，1:1 可追溯） */
  sourcePanelId: string;
  nameZh: string;
  role: string;
  category: string;
  material: string;
  thickness: number;
  length: number;
  width: number;
  qty: number;
  grain: string;
  verification: MfgVerification;
  /** 该件未确认的制造方面（BOM 上也能看见，不藏） */
  unverified: string[];
}

/**
 * 制造件 → 几何 Panel（无损）。
 * ManufacturingPart 保留了 Panel 的全部字段，此处逐字段还原，
 * 因此回投影后的 Panel 与原始几何 Panel 完全相等（DXF 来源一致的根）。
 */
export function manufacturingToPanels(parts: ManufacturingPart[]): Panel[] {
  return parts.map((p) => ({
    id: p.id,
    role: p.role,
    nameZh: p.nameZh,
    belongsTo: p.belongsTo,
    group: p.group,
    material: p.material,
    thickness: p.thickness,
    length: p.length,
    width: p.width,
    qty: p.qty,
    grain: p.grain,
    edge: p.edge,
    edgeLabel: p.edgeLabel,
    layer: p.layer,
  }));
}

/** 制造件 → BOM 行（带 sourcePanelId，来源可追溯） */
export function bomFromManufacturing(parts: ManufacturingPart[]): BomRow[] {
  return parts.map((p) => ({
    id: p.id,
    sourcePanelId: p.geometryPanelId,
    nameZh: p.nameZh,
    role: p.role,
    category: p.category,
    material: p.material,
    thickness: p.thickness,
    length: p.length,
    width: p.width,
    qty: p.qty,
    grain: p.grain,
    verification: p.verification,
    unverified: p.unverified,
  }));
}

/**
 * DXF 真正消费制造层：派生几何 → 制造件 → 回投影板件 → 中立导出。
 * 由于回投影无损，输出与 `toNeutralExport`（旧路径）的 panels 逐字段相等。
 */
export function manufacturingToNeutralExport(
  project: Project,
  rules: RuleSet,
  mfgRules: ManufacturingRuleSet,
  which: Array<'plan' | 'sheet'>,
  modelVersion: string,
): NeutralExport {
  const geom = generateProject(project, rules);
  const mfg = deriveManufacturing(project, geom, rules, mfgRules);
  return toNeutralExport(project, rules, which, modelVersion, manufacturingToPanels(mfg.parts));
}

/** 便捷：用默认制造规则 */
export function manufacturingToNeutralExportDefault(
  project: Project,
  rules: RuleSet,
  which: Array<'plan' | 'sheet'>,
  modelVersion: string,
): NeutralExport {
  return manufacturingToNeutralExport(project, rules, DEFAULT_MANUFACTURING_RULES, which, modelVersion);
}
