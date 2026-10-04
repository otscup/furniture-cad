import type { BBox, Issue, Panel, Prim, Project, PurchasedItem, RuleSet, Vec2 } from '../core/types.ts';
import { generateProject } from '../core/geometry/project.ts';
import { buildFurnitureSheet, groupByRoom } from './furnitureSheet.ts';

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
  /** 甲购/外采件（玻璃门等，按材质 kind 从板件清单分流出来，不进开料） */
  purchased: Array<{
    id: string;
    nameZh: string;
    kind: string;
    material: string;
    spec: string;
    qty: number;
    belongsTo: string;
  }>;
  stats: { panelKinds: number; totalPieces: number; boardAreaM2: number; estWeightKg: number };
}

export const GENERATOR_VERSION = 'neutral-0.2';

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

const purchasedRow = (x: PurchasedItem) => ({
  id: x.id,
  nameZh: x.nameZh,
  kind: x.kind,
  material: x.material,
  spec: x.spec,
  qty: x.qty,
  belongsTo: x.belongsTo,
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
  modelVersion: string,
  /** 兼容层（P7）：直接喂入已派生好的板件（如制造层回投影的板件），跳过从 geom 取板件。
   *  不传 = 旧行为（从 generateProject 取）。DXF 由此可消费 Manufacturing 的确定性结果。 */
  panelsOverride?: Panel[]
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
    // ── 一页一件家具：按房间分组，每个房间一张生产图纸 ──
    // 旧的 buildProjectViews 把所有柜子横向排成一排（cursor 累加），DXF 坐标飞到 X: -650~56140。
    // 现在每个房间独立成图：地柜平面 + 吊柜平面 + 立面外观 + 立面结构 + 图框，坐标控制在 0~10000 内。
    const groups = groupByRoom(project);
    groups.forEach((g, i) => {
      const sheet = buildFurnitureSheet(g.room, g.cabinets, project, rules);
      sheets.push({
        name: `SHEET_${i + 1}`,
        nameZh: `${g.room.name}·家具生产图`,
        bbox: sheet.bbox,
        prims: sheet.prims.map(toNeutralPrim),
      });
    });
    // 没有任何柜体的项目：给一张空图，避免"导出成功但文件是空的"的误导
    if (groups.length === 0) {
      sheets.push({
        name: 'SHEET_1',
        nameZh: '家具生产图（空）',
        bbox: null,
        prims: [],
      });
    }
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
    panels: (panelsOverride ?? cabinetGeoms.flatMap((c) => c.panels)).map(panelRow),
    purchased: cabinetGeoms.flatMap((c) => c.purchased.map(purchasedRow)),
    issues: geom.issues,
    stats: {
      panelKinds: cabinetGeoms.reduce((a, c) => a + c.stats.panelKinds, 0),
      totalPieces: cabinetGeoms.reduce((a, c) => a + c.stats.totalPieces, 0),
      boardAreaM2: Math.round(cabinetGeoms.reduce((a, c) => a + c.stats.boardAreaM2, 0) * 100) / 100,
      estWeightKg: Math.round(cabinetGeoms.reduce((a, c) => a + c.stats.estWeightKg, 0)),
    },
  };
}
