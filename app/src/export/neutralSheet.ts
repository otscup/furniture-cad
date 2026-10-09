import type { BBox, Cabinet, CabinetGeometry, Issue, Panel, Prim, Project, PurchasedItem, RuleSet, Vec2 } from '../core/types.ts';
import { generateProject } from '../core/geometry/project.ts';
import { buildFurnitureSheet, groupByRoom } from './furnitureSheet.ts';
import { drawingPrims, planSourceKeys as makePlanSourceKeys } from '../core/drawingEdits.ts';
import { cabinetWarningIssues, formatCabinetWarning } from './warningNotes.ts';
import { validateSharedPanels } from '../core/sharedPanels.ts';

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

import type { SharedPanelTrace } from '../core/types.ts';

export type NeutralPrim =
  | { k: 'poly'; pts: Vec2[]; closed: boolean; layer: string; lw: number; dash?: number[] }
  | { k: 'fill'; pts: Vec2[]; layer: string; alpha: number }
  | { k: 'text'; p: Vec2; text: string; size: number; layer: string; align: 'l' | 'c' | 'r'; rot?: number };

export interface NeutralSheet {
  /** 一张图纸（平面图 或 四视图图幅） */
  name: string;
  nameZh: string;
  /** 区分房间级平面图与逐柜生产图，DXF 两者都写入独立纸空间 layout。 */
  kind?: 'room-plan' | 'cabinet' | 'shared-panel';
  /** 柜体图纸追溯字段；房间布局页可只提供 roomId。 */
  roomId?: string;
  cabinetId?: string;
  sharedPanelId?: string;
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
    sharedPanelTrace?: SharedPanelTrace;
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
const REFERENCE_SAFETY_NOTE = '参考预留｜非 CNC 开孔｜待拆单确认';

function hasUnmachinedReference(cabinet: Cabinet): boolean {
  const units = [
    ...(cabinet.layout.units ?? []),
    ...(cabinet.layout.backUnits ?? []),
    ...(cabinet.layout.rows ?? []).flatMap((row) => row.units),
  ];
  return (cabinet.params.counterCutouts?.length ?? 0) > 0 || units.some((unit) => unit.kind === 'appliance');
}

function safetyNotePrim(x: number, y: number, size: number): Prim {
  return { k: 'text', p: { x, y }, text: REFERENCE_SAFETY_NOTE, size, layer: 'F-ANNOT-RED', align: 'l' };
}

function warningNotePrims(cabinet: Cabinet, geometry: CabinetGeometry, rules: RuleSet): Prim[] {
  const result: Prim[] = [];
  let row = 0;
  for (const issue of cabinetWarningIssues(cabinet, geometry, rules)) {
    const text = formatCabinetWarning(cabinet, issue);
    const chars = Array.from(text);
    for (let offset = 0; offset < chars.length; offset += 100) {
      result.push({
        k: 'text',
        p: { x: 450, y: 9380 - row * 165 },
        text: chars.slice(offset, offset + 100).join(''),
        size: 115,
        layer: 'F-ANNOT-RED',
        align: 'l',
      });
      row++;
    }
  }
  return result;
}

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
  ...(p.sharedPanelTrace ? { sharedPanelTrace: p.sharedPanelTrace } : {}),
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
  panelsOverride?: Panel[],
  /** 可选房间级 PLAN 范围；undefined 表示全部房间，空数组表示不导出 PLAN。 */
  selectedRoomIds?: string[],
): NeutralExport {
  const geom = generateProject(project, rules);
  // cabinets 是 { [cabinetId]: CabinetGeometry }，不是数组 —— 取出值再聚合
  const cabinetGeoms = Object.values(geom.cabinets);
  const sheets: NeutralSheet[] = [];

  if (which.includes('plan')) {
    // 平面图是可选的房间级图纸：按 Project.rooms 顺序独立出页，
    // 不把多个房间缩放或叠放在同一个模型空间；几何仍取自本次统一派生。
    const selectedRoomIdSet = selectedRoomIds === undefined ? null : new Set(selectedRoomIds);
    project.rooms.forEach((room, index) => {
      if (selectedRoomIdSet && !selectedRoomIdSet.has(room.id)) return;
      const roomProject = {
        ...project,
        drawingEdits: (project.drawingEdits ?? []).filter(e => e.space === 'plan' && e.roomId === room.id),
      };
      const prims = drawingPrims(roomProject, 'plan', geom.roomPlans[room.id] ?? [], geom.roomPlanSourceKeys[room.id] ?? []);
      if (prims.length === 0) return;
      const planPrims = [...prims];
      const planBox = bboxOf(prims);
      if (planBox && project.cabinets.some((cabinet) => cabinet.roomId === room.id && hasUnmachinedReference(cabinet))) {
        // 放在房间平面轮廓上方的独立注记带，不覆盖墙、柜体或尺寸链。
        planPrims.push(safetyNotePrim(planBox.min.x, planBox.max.y + 250, 160));
      }
      sheets.push({
        name: `PLAN_${String(index + 1).padStart(3, '0')}`,
        nameZh: `${room.name}·平面布置图`,
        kind: 'room-plan',
        roomId: room.id,
        bbox: bboxOf(planPrims),
        prims: planPrims.map(toNeutralPrim),
      });
    });

    // 孤立 roomId 的柜体不静默丢失：在已知房间之后单独输出“未分配”平面图。
    const roomIds = new Set(project.rooms.map((room) => room.id));
    const unassignedBase = selectedRoomIdSet
      ? []
      : project.cabinets
          .filter((cabinet) => !roomIds.has(cabinet.roomId))
          .flatMap((cabinet) => geom.cabinets[cabinet.id]?.plan ?? []);
    const unassignedKeys = selectedRoomIdSet ? [] : project.cabinets
      .filter(cabinet => !roomIds.has(cabinet.roomId))
      .flatMap(cabinet => makePlanSourceKeys(`cabinet:${cabinet.id}`, geom.cabinets[cabinet.id]?.plan ?? []));
    const unassignedProject = {
      ...project,
      drawingEdits: (project.drawingEdits ?? []).filter(e => e.space === 'plan' && (!e.roomId || !roomIds.has(e.roomId))),
    };
    const unassignedPrims = selectedRoomIdSet ? [] : drawingPrims(unassignedProject, 'plan', unassignedBase, unassignedKeys);
    if (unassignedPrims.length > 0) {
      sheets.push({
        name: 'PLAN_UNASSIGNED',
        nameZh: '未分配房间·平面布置图',
        kind: 'room-plan',
        bbox: bboxOf(unassignedPrims),
        prims: unassignedPrims.map(toNeutralPrim),
      });
    }
  }

  if (which.includes('sheet')) {
    // ── 一柜一 DXF layout：所有三视图来自该柜同一份语义模型 ──
    const groups = groupByRoom(project);
    let sheetIndex = 0;
    for (const group of groups) {
      for (const cabinet of group.cabinets) {
        sheetIndex += 1;
        const sheet = buildFurnitureSheet(group.room, [cabinet], project, rules, { furnitureName: cabinet.name });
        const idSuffix = cabinet.id.replace(/[^A-Za-z0-9]/g, '').slice(-8) || String(sheetIndex);
        const sheetPrims = [...sheet.prims];
        if (hasUnmachinedReference(cabinet)) {
          // 单柜页主视图上方有预留的标题带；纸空间坐标与图框同源（A3: 14000×10000）。
          sheetPrims.push(safetyNotePrim(450, 9650, 180));
        }
        const cabinetGeometry = geom.cabinets[cabinet.id];
        if (cabinetGeometry) sheetPrims.push(...warningNotePrims(cabinet, cabinetGeometry, rules));
        sheets.push({
          name: `CAB_${String(sheetIndex).padStart(3, '0')}_${idSuffix}`,
          nameZh: `${group.room.name}·${cabinet.name}·${idSuffix}`,
          kind: 'cabinet',
          roomId: group.room.id,
          cabinetId: cabinet.id,
          bbox: bboxOf(sheetPrims),
          prims: sheetPrims.map(toNeutralPrim),
        });
      }
    }
    // 空项目不伪造柜体图纸，避免误认为存在可生产柜体。
    if (sheetIndex === 0 && groups.length === 0) {
      sheets.push({
        name: 'SHEET_1',
        nameZh: '家具生产图（空）',
        bbox: null,
        prims: [],
      });
    }
  }

  const sharedIssues = validateSharedPanels(project, rules);
  const allIssues = [...geom.issues, ...sharedIssues];
  const blocking = allIssues.filter((i) => i.severity === 'ERROR');

  const exportPanels = (panelsOverride ?? cabinetGeoms.flatMap((c) => c.panels)).map(panelRow);
  if (which.includes('sheet')) {
    const groups = new Map<string, typeof exportPanels>();
    for (const panel of exportPanels) {
      const id = panel.sharedPanelTrace?.id;
      if (!id) continue;
      const group = groups.get(id) ?? [];
      group.push(panel);
      groups.set(id, group);
    }
    for (const [id, group] of groups) {
      const trace = group[0]!.sharedPanelTrace!;
      const prims: Prim[] = [];
      for (const panel of group) {
        const panelTrace = panel.sharedPanelTrace!;
        const segment = trace.segmentation.segments.find((item) => item.id === panelTrace.segmentId);
        if (!segment) continue;
        const x = segment.x - trace.bounds.minX;
        const y = segment.y - trace.bounds.minY;
        prims.push({ k: 'poly', pts: [{ x, y }, { x: x + segment.length, y }, { x: x + segment.length, y: y + segment.width }, { x, y: y + segment.width }], closed: true, layer: `PANEL_${panel.thickness}`, lw: 2 });
        prims.push({ k: 'text', p: { x: x + segment.length / 2, y: y + segment.width / 2 }, text: `${id} / ${segment.id} / ${segment.length}×${segment.width}×${panel.thickness}mm`, size: 70, layer: 'F-TEXT', align: 'c' });
      }
      for (const hole of trace.machining.holes) {
        const radius = hole.diameter / 2;
        const points = Array.from({ length: 24 }, (_, index) => {
          const angle = index * Math.PI * 2 / 24;
          return { x: hole.x + Math.cos(angle) * radius, y: hole.y + Math.sin(angle) * radius };
        });
        prims.push({ k: 'poly', pts: points, closed: true, layer: 'PANEL_SHARED_HOLE', lw: 2 });
      }
      const edges = Object.entries(trace.edgeTreatment).map(([side, edge]) => `${side}:${edge ?? '不封边'}`).join('，');
      const segmentText = trace.segmentation.segments.map((segment) => `${segment.id}@${segment.x},${segment.y} ${segment.length}×${segment.width}`).join(';');
      const holeText = trace.machining.holes.map((hole) => `${hole.id}:${hole.kind}@${hole.x},${hole.y} Ø${hole.diameter} 深${hole.depth}`).join(';') || '无';
      const details = [
        `sharedPanelId=${id}; name=${group[0]!.nameZh}`,
        `members=${trace.memberCabinetIds.join('|')}; replacesPanelIds=${trace.replacesPanelIds.join('|')}`,
        `overall=${trace.length}×${trace.width}×${trace.thickness}mm; bounds=${trace.bounds.minX},${trace.bounds.minY}~${trace.bounds.maxX},${trace.bounds.maxY}; elevation=${trace.elevation}mm`,
        `material=${trace.material}; finish=${trace.finish}; grainDirection=${trace.grainDirection}; grainReference=finished-length/width-axis; nestingBoundary=no-professional-sheet-nesting-or-stock-rotation-optimization`,
        `edgeTreatment=${edges}`,
        `overhang(front,back,left,right)=${trace.overhang.front},${trace.overhang.back},${trace.overhang.left},${trace.overhang.right}mm`,
        `segmentationConfirmed=${trace.segmentation.confirmed}; segments=${segmentText}`,
        `support=${trace.supportMethod}; supportCabinetIds=${trace.supportCabinetIds.join('|')}`,
        `machining=${trace.machining.status}; holes=${holeText}`,
        'Drawing metadata and confirmed hole locations only; not a machine-specific CNC postprocessor output.',
      ];
      details.forEach((text, index) => prims.push({ k: 'text', p: { x: 0, y: -150 - index * 75 }, text, size: 50, layer: 'F-TEXT', align: 'l' }));
      sheets.push({ name: `SHARED_${id.replace(/[^A-Za-z0-9_-]/g, '_')}`, nameZh: `共享板·${id}`, kind: 'shared-panel', sharedPanelId: id, bbox: bboxOf(prims), prims: prims.map(toNeutralPrim) });
    }
  }

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
    panels: exportPanels,
    purchased: cabinetGeoms.flatMap((c) => c.purchased.map(purchasedRow)),
    issues: allIssues,
    stats: {
      panelKinds: exportPanels.length,
      totalPieces: exportPanels.reduce((sum, panel) => sum + panel.qty, 0),
      boardAreaM2: Math.round(exportPanels.reduce((sum, panel) => sum + panel.length * panel.width * panel.qty / 1e6, 0) * 100) / 100,
      estWeightKg: Math.round(cabinetGeoms.reduce((a, c) => a + c.stats.estWeightKg, 0)),
    },
  };
}
