/**
 * 图纸静态检查（cad.lint_drawing 的内核）。
 *
 * ★ 为什么必须有：几何校验只回答"柜子做不做得出"，从不回答"图纸印出来能不能读"。
 *   实测已出现挂衣杆/层板文字压在衣物线条上 —— 两个图元都在同一份派生结果里，
 *   但没有任何一层把它们放在一起比较过（labels.ts 的避让只登记标签，从不登记线条）。
 *   于是更强的模型也只是看不见同一个东西：读不到，就改不了。
 *
 * 只报**能确定性判定、而且当前图纸本来是干净的**两件事：
 *   DRAW_TEXT_OVER_CONTENT  文字压在本该有留白的内容层（衣物/五金示意）上
 *   DRAW_TEXT_OVERLAP       两段文字互相压字
 *
 * ★ 为什么不报"文字被任意线条穿过"（第一版这么写过，已在真实样例柜上否掉）：
 *   板件名（顶板/左侧板/踢脚板）本来就横跨自己那块 18mm 板的边线 —— 这是本
 *   项目图纸的既定画法，一条 21 警告的规则等于没有规则。真正压得看不清的是
 *   挂在 F-CAB-HW（衣物/五金示意）上的那几段文字，因此只认这一层的内容线。
 *
 * 纯函数：Prim[] 进，Issue[] 出。不读文件、不碰状态、不改图。
 */
import type { BBox, Issue, Prim, Vec2 } from '../types.ts';
import { primVisualExtent } from './labels.ts';

/**
 * 内容层：这一层是"画给人看的东西"（衣物、挂衣杆、五金示意），密度高，
 * 文字压上去必然两样都读不清。图层名同 views.ts:80-86（那边没导出，只读不改）。
 */
const CONTENT_LAYERS = new Set(['F-CAB-HW']);

type TextPrim = Extract<Prim, { k: 'text' }>;
type InkPrim = Extract<Prim, { k: 'poly' }> | Extract<Prim, { k: 'fill' }>;

function bboxOf(pts: Vec2[]): BBox {
  const box: BBox = { min: { x: Infinity, y: Infinity }, max: { x: -Infinity, y: -Infinity } };
  for (const p of pts) {
    if (p.x < box.min.x) box.min.x = p.x;
    if (p.y < box.min.y) box.min.y = p.y;
    if (p.x > box.max.x) box.max.x = p.x;
    if (p.y > box.max.y) box.max.y = p.y;
  }
  return box;
}

/** Liang–Barsky：线段是否真正穿过矩形内部（擦边、碰到角点都不算）。 */
function segHitsBox(a: Vec2, b: Vec2, box: BBox): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - box.min.x, box.max.x - a.x, a.y - box.min.y, box.max.y - a.y];
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 4; i += 1) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return t0 < t1;
}

function overlapArea(a: BBox, b: BBox): number {
  const w = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const h = Math.min(a.max.y, b.max.y) - Math.max(a.min.y, b.min.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export interface LintScope {
  /** 图纸上看到的视图名（Issue 里要能定位到具体视图，否则等于没说） */
  view: string;
  /** Issue.target —— 柜子 id 等 */
  target: string;
  targetKind?: Issue['targetKind'];
}

export function lintPrims(prims: Prim[], scope: LintScope): Issue[] {
  const issues: Issue[] = [];
  const targetKind = scope.targetKind ?? 'cabinet';
  const texts = prims.filter((p): p is TextPrim => p.k === 'text');
  if (texts.length === 0) return issues;
  const boxes = texts.map((t) => bboxOf(primVisualExtent(t)));
  const strokes = prims.filter((p): p is InkPrim => (p.k === 'poly' || p.k === 'fill') && CONTENT_LAYERS.has(p.layer));

  // ① 文字压在内容层上
  for (let i = 0; i < texts.length; i += 1) {
    let hits = 0;
    for (const s of strokes) {
      const pts = s.pts;
      const n = s.k === 'poly' && s.closed ? pts.length : pts.length - 1;
      for (let k = 0; k < n; k += 1) {
        if (segHitsBox(pts[k], pts[(k + 1) % pts.length], boxes[i])) {
          hits += 1;
          break; // 同一轮廓只记一次
        }
      }
    }
    if (hits > 0) {
      issues.push({
        severity: 'WARNING',
        code: 'DRAW_TEXT_OVER_CONTENT',
        target: scope.target,
        targetKind,
        message: `${scope.view}：文字「${texts[i].text}」压在 ${hits} 处衣物/五金示意线条上`,
        fixHint: '把这段文字移到留白处（或换个单元格标注）；压在衣物线条上打印出来两样都读不清。',
      });
    }
  }

  // ② 两段文字互相压字
  for (let i = 0; i < texts.length; i += 1) {
    for (let j = i + 1; j < texts.length; j += 1) {
      if (overlapArea(boxes[i], boxes[j]) <= 0) continue;
      issues.push({
        severity: 'WARNING',
        code: 'DRAW_TEXT_OVERLAP',
        target: scope.target,
        targetKind,
        message: `${scope.view}：文字「${texts[i].text}」与「${texts[j].text}」重叠`,
        fixHint: '两段文字互相压字，调整排版位置。',
      });
    }
  }

  return issues;
}
