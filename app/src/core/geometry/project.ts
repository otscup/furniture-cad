import type { BBox, Issue, Prim, Project, ProjectGeometry, RuleSet, Vec2, Wall } from '../types.ts';
import { bboxOf } from './transform.ts';
import { generateCabinet, getCabinetFootprint } from './generate.ts';
import { buildProjectViews } from './views.ts';
import { buildProjectBodies } from './bodies3d.ts';
import { buildIssue } from '../rules/issueCatalog.ts';
import { drawingSourceProblems, planSourceKeys as makePlanSourceKeys } from '../drawingEdits.ts';

const L_WALL = 'A-WALL';
const L_WALL_TEXT = 'A-TEXT';

/** 墙体在平面上的外形（沿中心线加厚） */
export function wallPolygon(w: Wall): Vec2[] {
  const dx = w.end.x - w.start.x;
  const dy = w.end.y - w.start.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return [];
  const nx = (-dy / len) * (w.thickness / 2);
  const ny = (dx / len) * (w.thickness / 2);
  return [
    { x: w.start.x + nx, y: w.start.y + ny },
    { x: w.end.x + nx, y: w.end.y + ny },
    { x: w.end.x - nx, y: w.end.y - ny },
    { x: w.start.x - nx, y: w.start.y - ny },
  ];
}

function wallPrims(w: Wall): Prim[] {
  const poly = wallPolygon(w);
  if (poly.length === 0) return [];
  const out: Prim[] = [
    { k: 'fill', pts: poly, layer: L_WALL, alpha: 0.22 },
    { k: 'poly', pts: poly, closed: true, layer: L_WALL, lw: 2 },
  ];
  const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
  const mx = (w.start.x + w.end.x) / 2;
  const my = (w.start.y + w.end.y) / 2;
  let rot = (Math.atan2(w.end.y - w.start.y, w.end.x - w.start.x) * 180) / Math.PI;
  if (rot > 90 || rot < -90) rot += 180;
  out.push({ k: 'text', p: { x: mx, y: my }, text: `${Math.round(len)}`, size: 95, layer: L_WALL_TEXT, align: 'c', rot });
  return out;
}

export function generateProject(project: Project, rules: RuleSet): ProjectGeometry {
  const plan: Prim[] = [];
  const planSourceKeys: string[] = [];
  const roomPlans: Record<string, Prim[]> = Object.fromEntries(project.rooms.map((room) => [room.id, []]));
  const roomPlanSourceKeys: Record<string, string[]> = Object.fromEntries(project.rooms.map((room) => [room.id, []]));
  const cabinets: ProjectGeometry['cabinets'] = {};
  const issues: Issue[] = [];

  for (const room of project.rooms) {
    for (const w of room.walls) {
      const prims = wallPrims(w);
      plan.push(...prims);
      roomPlans[room.id]?.push(...prims);
      const keys = makePlanSourceKeys(`wall:${w.id}`, prims);
      planSourceKeys.push(...keys);
      roomPlanSourceKeys[room.id]?.push(...keys);
    }
  }

  for (const cab of project.cabinets) {
    // 单个柜体出错不能让整个项目的派生挂掉（AI 可能给了一个不存在的材质 ID）
    try {
      const g = generateCabinet(cab, rules);
      cabinets[cab.id] = g;
      plan.push(...g.plan);
      roomPlans[cab.roomId]?.push(...g.plan);
      const keys = makePlanSourceKeys(`cabinet:${cab.id}`, g.plan);
      planSourceKeys.push(...keys);
      roomPlanSourceKeys[cab.roomId]?.push(...keys);
      issues.push(...g.issues);
    } catch (e) {
      issues.push(
        buildIssue('GEN-CABINET-FAILED', {
          target: cab.id,
          targetKind: 'cabinet',
          ctx: { cabName: cab.name, reason: (e as Error).message },
        })
      );
    }
  }

  issues.push(...detectCollisions(project));

  const allPts: Vec2[] = [];
  for (const r of project.rooms) for (const w of r.walls) allPts.push(...wallPolygon(w));
  for (const cab of project.cabinets) allPts.push(...getCabinetFootprint(cab));

  const bbox: BBox | null = allPts.length ? bboxOf(allPts) : null;

  /**
   * 四视图图幅：与平面图**同一次派生**产出。
   * 不做 try/catch —— buildProjectViews 内部已对单柜失败做容错（跳过该柜），
   * 这里如果再吞异常，会让"框架出问题"伪装成"这个项目没有视图"。
   */
  const views = buildProjectViews(project, rules);
  for (const problem of drawingSourceProblems(project, planSourceKeys, views.sourceKeys)) {
    const edit = problem.entity;
    issues.push(buildIssue(problem.code, {
      target: edit.id,
      targetKind: 'project',
      ctx: { editId: edit.id, sourceKey: edit.replacesSource ?? '', space: edit.space },
    }));
  }

  /** 3D 体块：同一份派生骨架的第三个视图（内部已对单柜失败容错） */
  const bodies3d = buildProjectBodies(project, rules);

  return { cabinets, plan, planSourceKeys, roomPlans, roomPlanSourceKeys, issues, bbox, views, bodies3d };
}

function overlap(a: BBox, b: BBox): boolean {
  // 严格小于：相切（柜体背靠墙面）不算干涉，这是正确的语义
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y;
}

/** 重叠面积（mm²）：给报错用具体数，用户才知道要挪多少 */
function overlapArea(a: BBox, b: BBox): number {
  const w = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const h = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  return w > 0 && h > 0 ? Math.round(w * h) : 0;
}

/**
 * 干涉 / 撞墙的唯一判据。
 *
 * 导出它是为了让"挑落位"的地方（candidateSpots 只是候选生成，
 * 判断放不放得下必须由这里说了算）能复用同一份答案。
 * 谁要是再去写一遍 AABB，就等于制造了第二份真相源。
 */
export function detectCollisions(project: Project): Issue[] {
  const out: Issue[] = [];
  const boxes: Array<{ id: string; name: string; bbox: BBox; minZ: number; maxZ: number }> = [];
  for (const cab of project.cabinets) {
    const fp = getCabinetFootprint(cab);
    if (fp.length === 0) continue;
    const minZ = cab.params.mountHeight ?? 0;
    boxes.push({ id: cab.id, name: cab.name, bbox: bboxOf(fp), minZ, maxZ: minZ + cab.params.height });
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const verticalOverlap = boxes[i].minZ < boxes[j].maxZ && boxes[i].maxZ > boxes[j].minZ;
      if (verticalOverlap && overlap(boxes[i].bbox, boxes[j].bbox)) {
        out.push(
          buildIssue('RULE-CABINET-OVERLAP', {
            target: `${boxes[i].id} / ${boxes[j].id}`,
            targetKind: 'cabinet',
            ctx: { nameA: boxes[i].name, nameB: boxes[j].name, area: overlapArea(boxes[i].bbox, boxes[j].bbox) },
          })
        );
      }
    }
  }

  for (const room of project.rooms) {
    for (const w of room.walls) {
      const wpoly = wallPolygon(w);
      if (wpoly.length === 0) continue;
      const wb = bboxOf(wpoly);
      for (const b of boxes) {
        if (overlap(b.bbox, wb)) {
          out.push(
            buildIssue('RULE-CABINET-IN-WALL', {
              target: b.id,
              targetKind: 'cabinet',
              ctx: {
                cabName: b.name,
                wallName: w.name,
                thickness: w.thickness,
                pen: Math.round(
                  Math.min(Math.max(b.bbox.max.x - wb.min.x, wb.max.x - b.bbox.min.x), Math.max(b.bbox.max.y - wb.min.y, wb.max.y - b.bbox.min.y))
                ),
                need: Math.round(
                  Math.max(b.bbox.max.x - wb.min.x, wb.max.x - b.bbox.min.x, b.bbox.max.y - wb.min.y, wb.max.y - b.bbox.min.y)
                ),
              },
            })
          );
        }
      }
    }
  }

  return out;
}
