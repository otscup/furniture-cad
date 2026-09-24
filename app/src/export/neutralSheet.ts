import type { BBox, Issue, Panel, Prim, Project, RuleSet, Vec2 } from '../core/types.ts';
import { generateProject } from '../core/geometry/project.ts';
import { buildProjectViews } from '../core/geometry/views.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  Project → 中立交换格式（给 DXF 序列化用）
 *
 *  ── 这个文件守的是项目最硬的一条架构线 ──
 *
 *      **几何全部在 TS 侧算好，Python 只做序列化，不做任何计算。**
 *
 *  这条线不是洁癖，它是"图 = 料"的唯一保证：
 *  界面上看到的四视图、清单里的板件、DXF 里的线条，全部派生自同一份 Prim。
 *  一旦 Python 开始自己算标注或自己排图，就等于有了第二份几何真相源，
 *  "图上 2400、料单 2399" 这类问题会从结构上变得可能。
 *
 *  所以这里做的事情非常少：把已经算好的图元原样搬进一个 JSON。
 *  连标注文字的位置与内容都不碰 —— 它们是 labels.ts 算的。
 *
 *  ── 坐标约定 ──
 *  Prim 的坐标是 **Y 轴向上**（CAD 约定）。界面渲染时才做 `scale(1,-1)` 翻转
 *  （见 VariantPanel 的 FrontThumb）。DXF 同样是 Y 向上，所以这里原样透传。
 * ══════════════════════════════════════════════════════════════════════
 */

export type NeutralPrim =
  | { k: 'poly'; pts: Vec2[]; closed: boolean; layer: string; lw: number; dash?: number[] }
  | { k: 'fill'; pts: Vec2[]; layer: string; alpha: number }
  | { k: 'text'; p: Vec2; text: string; size: number; layer: string; align: 'l' | 'c' | 'r'; rot?: number };

export interface NeutralSheet {
  /** 一张图纸（平面图 或 四视图图幅） */
  name: string;
  nameZh: string;
  bbox: { min: Vec2; max: Vec2 } | null;
  prims: NeutralPrim[];
}

export interface NeutralExport {
  meta: {
    projectName: string;
    generatorVersion: string;
    ruleSetId: string;
    ruleSetName: string;
    generatedAt: string;
    /** 生产数据三件套：模型版本 + 生成器版本 + 规则集版本（见主方案红线） */
    traceability: { modelVersion: string; generatorVersion: string; ruleSetVersion: string };
    units: 'mm';
    /** DXF $INSUNITS = 4 表示毫米 */
    insUnits: 4;
    warnings: string[];
  };
  sheets: NeutralSheet[];
  /** 开料单（板件清单） */
  panels: Array<{
    id: string;
    nameZh: string;
    role: string;
    belongsTo: string;
    material: string;
    thickness: number;
    length: number;
    width: number;
    qty: number;
    grain: string;
  }>;
  issues: Issue[];
  stats: { panelKinds: number; totalPieces: number; boardAreaM2: number; estWeightKg: number };
}

export const GENERATOR_VERSION = 'neutral-0.1';

const toNeutralPrim = (p: Prim): NeutralPrim => {
  // Prim 与 NeutralPrim 结构一致；这里逐个字段写出来，是为了让"两边结构漂移"
  // 在编译期就报错，而不是等到 DXF 里少画一条线才发现。
  switch (p.k) {
    case 'poly':
      return { k: 'poly', pts: p.pts, closed: p.closed, layer: p.layer, lw: p.lw, ...(p.dash ? { dash: p.dash } : {}) };
    case 'fill':
      return { k: 'fill', pts: p.pts, layer: p.layer, alpha: p.alpha };
    case 'text':
      return { k: 'text', p: p.p, text: p.text, size: p.size, layer: p.layer, align: p.align, ...(p.rot !== undefined ? { rot: p.rot } : {}) };
  }
};

const bboxOf = (prims: Prim[]): BBox | null => {
  if (prims.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const pr of prims) {
    const pts = pr.k === 'text' ? [pr.p] : pr.pts;
    for (const q of pts) {
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
};

const panelRow = (p: Panel) => ({
  id: p.id,
  nameZh: p.nameZh,
  role: p.role,
  belongsTo: p.belongsTo,
  material: p.material,
  thickness: p.thickness,
  length: p.length,
  width: p.width,
  qty: p.qty,
  grain: p.grain,
});

/**
 * 项目 → 中立交换格式。
 *
 * @param which 要哪几张图纸。平面图与四视图是**两张不同的图**，
 *   分开导出而不是塞进一个文件 —— CAD 里一个模型空间画两张图只会让打印比例出错。
 */
export function toNeutralExport(
  project: Project,
  rules: RuleSet,
  which: Array<'plan' | 'sheet'>,
  modelVersion: string
): NeutralExport {
  const geom = generateProject(project, rules);
  // cabinets 是 { [cabinetId]: CabinetGeometry }，不是数组 —— 取出值再聚合
  const cabinetGeoms = Object.values(geom.cabinets);
  const sheets: NeutralSheet[] = [];

  if (which.includes('plan')) {
    const prims = geom.plan;
    sheets.push({
      name: 'PLAN',
      nameZh: '平面布置图',
      bbox: bboxOf(prims),
      prims: prims.map(toNeutralPrim),
    });
  }

  if (which.includes('sheet')) {
    const vs = buildProjectViews(project, rules);
    sheets.push({
      name: 'SHEET',
      nameZh: '四视图图幅',
      bbox: vs.bbox,
      prims: vs.prims.map(toNeutralPrim),
    });
  }

  const blocking = geom.issues.filter((i) => i.severity === 'ERROR');

  return {
    meta: {
      projectName: project.name,
      generatorVersion: GENERATOR_VERSION,
      ruleSetId: rules.id,
      ruleSetName: rules.name,
      generatedAt: new Date().toISOString(),
      traceability: {
        modelVersion,
        generatorVersion: GENERATOR_VERSION,
        ruleSetVersion: rules.id,
      },
      units: 'mm',
      insUnits: 4,
      /**
       * 有 ERROR 仍然允许导出 —— 但必须写在文件里。
       * 一张"看起来没问题"的图纸比一张报错的图纸危险得多：
       * 它会一路走到开料才被人发现。所以这里把 ERROR 原话带进 meta，
       * 并在界面上导出前就提示（见 ExportPanel）。
       */
      warnings: blocking.map((i) => `[${i.code}] ${i.message}`),
    },
    sheets,
    panels: cabinetGeoms.flatMap((c) => c.panels.map(panelRow)),
    issues: geom.issues,
    stats: {
      panelKinds: cabinetGeoms.reduce((a, c) => a + c.stats.panelKinds, 0),
      totalPieces: cabinetGeoms.reduce((a, c) => a + c.stats.totalPieces, 0),
      boardAreaM2: Math.round(cabinetGeoms.reduce((a, c) => a + c.stats.boardAreaM2, 0) * 100) / 100,
      estWeightKg: Math.round(cabinetGeoms.reduce((a, c) => a + c.stats.estWeightKg, 0)),
    },
  };
}
