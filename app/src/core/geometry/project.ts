import type { BBox, Issue, Prim, Project, ProjectGeometry, RuleSet, Vec2, Wall } from '../types.ts';
import { bboxOf } from './transform.ts';
import { generateCabinet, getCabinetFootprint } from './generate.ts';
import { buildProjectViews } from './views.ts';
import { buildProjectBodies } from './bodies3d.ts';

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
  const cabinets: ProjectGeometry['cabinets'] = {};
  const issues: Issue[] = [];

  for (const room of project.rooms) {
    for (const w of room.walls) {
      plan.push(...wallPrims(w));
    }
  }

  for (const cab of project.cabinets) {
    // 单个柜体出错不能让整个项目的派生挂掉（AI 可能给了一个不存在的材质 ID）
    try {
      const g = generateCabinet(cab, rules);
      cabinets[cab.id] = g;
      plan.push(...g.plan);
      issues.push(...g.issues);
    } catch (e) {
      issues.push({
        severity: 'ERROR',
        code: 'GEN-CABINET-FAILED',
        target: cab.id,
        targetKind: 'cabinet',
        message: `「${cab.name}」几何生成失败：${(e as Error).message}`,
        fixHint: '检查材质 ID 是否存在于规则集、参数是否为合法数值',
      });
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

  /** 3D 体块：同一份派生骨架的第三个视图（内部已对单柜失败容错） */
  const bodies3d = buildProjectBodies(project, rules);

  return { cabinets, plan, issues, bbox, views, bodies3d };
}

function overlap(a: BBox, b: BBox): boolean {
  // 严格小于：相切（柜体背靠墙面）不算干涉，这是正确的语义
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y;
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
  const boxes: Array<{ id: string; name: string; bbox: BBox }> = [];

  for (const cab of project.cabinets) {
    const fp = getCabinetFootprint(cab);
    if (fp.length === 0) continue;
    boxes.push({ id: cab.id, name: cab.name, bbox: bboxOf(fp) });
  }

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (overlap(boxes[i].bbox, boxes[j].bbox)) {
        out.push({
          severity: 'ERROR',
          code: 'RULE-CABINET-OVERLAP',
          target: `${boxes[i].id} / ${boxes[j].id}`,
          targetKind: 'cabinet',
          message: `「${boxes[i].name}」与「${boxes[j].name}」在平面上发生重叠，存在柜体碰撞。`,
          fixHint: '移动其中一个柜体，或缩短柜体宽度',
        });
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
          out.push({
            severity: 'ERROR',
            code: 'RULE-CABINET-IN-WALL',
            target: b.id,
            targetKind: 'cabinet',
            message: `「${b.name}」与墙体「${w.name}」发生干涉（墙厚 ${w.thickness}mm）。`,
            fixHint: '将柜体贴合到墙面外侧，或调整墙位',
          });
        }
      }
    }
  }

  return out;
}
