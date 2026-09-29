import type { Cabinet, Issue, Project, RuleSet, Vec2 } from '../types.ts';
import { getCabinetFootprint } from '../geometry/generate.ts';
import { bboxOf, polyLocalToWorld } from '../geometry/transform.ts';
import { computeCabinetLayout, doorWidths } from '../geometry/layout.ts';
import { buildIssue } from './issueCatalog.ts';
import { canonicalUnits } from '../layoutModel.ts';
import { authoredConnections, pairKey } from '../relations.ts';

/**
 * ════════════════════════════════════════════════════════════════════
 *  L 型转角干涉检查（Phase E）
 *
 *  为什么需要它：墙角处的 L 型衣柜 / 转角柜，两臂分别背靠两条垂直墙，
 *  在墙角**相接**。它们的箱体一般不重叠（重叠由 detectCollisions 的
 *  RULE-CABINET-OVERLAP 管），但**内端的铰链门打开时会扫到垂直的那条柜**——
 *  这是销售图纸里真实的"转角柜翻门撞邻柜"问题，重叠检测抓不到（门是摆动的）。
 *
 *  判定（保守但明确）：
 *    1. 同房间、两柜都轴对齐（rotation % 90 == 0）；
 *    2. 两柜轴线垂直（rotation 差 90° / 270°）→ 这是 L 而非并排；
 *    3. 两柜平面 footprints 在墙角**共一个角点**（不重叠，只相切于角）；
 *    4. 对任意一柜，若其**朝向墙角的内端分区带铰链门**，则该门以铰链为心、
 *       门宽为半径的摆动圆若扫进垂直柜的 footprint → WARNING。
 *
 *  用整圆是保守近似（门实际只摆 90~110°），WARNING 是软建议（不阻断），
 *  宁可多报也不漏报转角撞门。生产硬阻断仍由 mem_003 / detectCollisions 负责。
 * ═════════════════════════════════════════════════════════════════════
 */

const TOL = 2; // mm：角点重合容差（相切不算干涉，与 detectCollisions 同语义）

function axisAligned(cab: Cabinet): boolean {
  return (((cab.placement.rotation % 90) + 360) % 90) === 0;
}

/** 两柜轴线是否垂直（rotation 差 90° 或 270°） */
function isPerpendicular(a: Cabinet, b: Cabinet): boolean {
  const d = (((a.placement.rotation - b.placement.rotation) % 180) + 180) % 180;
  return d === 90;
}

/** 两 footprint 是否共享一个角点（在容差内） */
function sharedCorner(fpA: Vec2[], fpB: Vec2[]): Vec2 | null {
  for (const p of fpA) {
    for (const q of fpB) {
      if (Math.abs(p.x - q.x) <= TOL && Math.abs(p.y - q.y) <= TOL) return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
    }
  }
  return null;
}

/** 点到轴对齐 bbox 的距离（点在框内为 0） */
function distPointToBBox(p: Vec2, bb: { min: Vec2; max: Vec2 }): number {
  const dx = Math.max(bb.min.x - p.x, 0, p.x - bb.max.x);
  const dy = Math.max(bb.min.y - p.y, 0, p.y - bb.max.y);
  return Math.hypot(dx, dy);
}

function boxesOverlap(a: { min: Vec2; max: Vec2 }, b: { min: Vec2; max: Vec2 }): boolean {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.y < b.max.y && a.max.y > b.min.y;
}

export function validateCornerInterference(project: Project, rules: RuleSet): Issue[] {
  const out: Issue[] = [];
  const byRoom = new Map<string, Cabinet[]>();
  for (const c of project.cabinets) {
    if (!c.roomId) continue;
    const arr = byRoom.get(c.roomId) ?? [];
    arr.push(c);
    byRoom.set(c.roomId, arr);
  }

  /**
   * 「要检查哪些柜对」= **声明的转角** ∪ **推断的转角**，去重后各查一次。
   *
   * ── 为什么声明排在推断前面 ──
   *   用户说"这两段是 L 型"是**事实**；靠落位猜出来的是**兜底**。
   *   以前只有兜底，于是调一次容差、或两柜差 3mm 没贴上，检查就静默消失 ——
   *   转角撞门这种事，漏检一次就是车间返工一次。
   *   现在声明过的对**一定**进队列，推断只是补上"用户没声明但确实摆成 L"的那些。
   *
   * ── 为什么仍然保留推断 ──
   *   大多数存量项目没有任何组合声明（v0.2 文件根本没有这个字段）。
   *   若要求先声明才查，等于把已经工作了几轮的转角检查一夜之间关掉。
   *
   * ── 不重复报 ──
   *   两条路径给的柜对按 `pairKey` 去重，同一对只检查一次（否则用户看到两条
   *   一模一样的 WARNING，会以为有两个地方撞了）。
   */
  const declared = new Set<string>();
  for (const { conn } of authoredConnections(project)) {
    if (conn.kind === 'corner') declared.add(pairKey(conn.a.cabinetId, conn.b.cabinetId));
  }

  for (const [, cabs] of byRoom) {
    const fps = new Map<string, Vec2[]>();
    const bbs = new Map<string, { min: Vec2; max: Vec2 }>();
    for (const c of cabs) {
      const fp = getCabinetFootprint(c);
      fps.set(c.id, fp);
      bbs.set(c.id, bboxOf(fp));
    }
    const seen = new Set<string>();
    const pairs: Array<[Cabinet, Cabinet]> = [];
    // ① 声明过的转角对先入队（成员必须都在这个房间里）
    for (const [A, B] of (function* (): Generator<[Cabinet, Cabinet]> {
      for (let i = 0; i < cabs.length; i++) {
        for (let j = i + 1; j < cabs.length; j++) {
          if (declared.has(pairKey(cabs[i]!.id, cabs[j]!.id))) yield [cabs[i]!, cabs[j]!];
        }
      }
    })()) {
      seen.add(pairKey(A.id, B.id));
      pairs.push([A, B]);
    }
    // ② 推断兜底：其余所有柜对
    for (let i = 0; i < cabs.length; i++) {
      for (let j = i + 1; j < cabs.length; j++) {
        const k = pairKey(cabs[i]!.id, cabs[j]!.id);
        if (seen.has(k)) continue;
        seen.add(k);
        pairs.push([cabs[i]!, cabs[j]!]);
      }
    }

    for (const [A, B] of pairs) {
      const fpA = fps.get(A.id)!;
      const fpB = fps.get(B.id)!;
      if (fpA.length < 4 || fpB.length < 4) continue;
      if (!axisAligned(A) || !axisAligned(B)) continue;
      if (!isPerpendicular(A, B)) continue;
      const corner = sharedCorner(fpA, fpB);
      if (!corner) continue;
      // 重叠由 detectCollisions 管，这里只管"相接但不重叠"的 L 转角
      if (boxesOverlap(bbs.get(A.id)!, bbs.get(B.id)!)) continue;

      checkSwing(A, B, corner, bbs.get(B.id)!, rules, out);
      checkSwing(B, A, corner, bbs.get(A.id)!, rules, out);
    }
  }
  return out;
}

/**
 * 检查 src 柜"朝向角点的内端"若有铰链门，门摆是否扫到 other 的 footprint。
 */
function checkSwing(
  src: Cabinet,
  other: Cabinet,
  corner: Vec2,
  bbOther: { min: Vec2; max: Vec2 },
  rules: RuleSet,
  out: Issue[]
): void {
  const o = src.placement;
  const W = src.params.width;
  const D = src.params.depth;
  // 两端前角（局部 y = D 为前脸）的世界坐标，取离墙角更近的一端为"内端"
  const endL = polyLocalToWorld([{ x: 0, y: D }], o, o.rotation)[0]!;
  const endR = polyLocalToWorld([{ x: W, y: D }], o, o.rotation)[0]!;
  const innerLocalX = Math.hypot(endL.x - corner.x, endL.y - corner.y) <= Math.hypot(endR.x - corner.x, endR.y - corner.y) ? 0 : W;

  const L = computeCabinetLayout(src, rules);
  const nUnits = L.unitX0.length;
  if (nUnits === 0) return;
  // 找覆盖该内端局部 X 的分区。
  // 注意：墙角往往正好落在端板（side panel）里，比分区外缘还靠外约一个板厚——
  // 精确匹配会漏掉这种最真实的 L 转角。所以匹配不到时，取靠角点的那一端分区。
  let unitIdx = -1;
  for (let i = 0; i < nUnits; i++) {
    if (innerLocalX >= L.unitX0[i]! - TOL && innerLocalX <= L.unitX0[i]! + L.nets[i]! + TOL) {
      unitIdx = i;
      break;
    }
  }
  if (unitIdx < 0) unitIdx = innerLocalX <= W / 2 ? 0 : nUnits - 1;
  const u = canonicalUnits(src.layout)[unitIdx];
  if (!u || !u.doors) return;
  const widths = doorWidths(u, L.nets[unitIdx]!, rules);
  const radius = Math.max(...widths);
  if (radius <= 0) return;

  // 铰链在该分区靠角点的那一端外缘（门绕分区外缘开，而非柜体外角）。
  const partLeft = L.unitX0[unitIdx]!;
  const partRight = L.unitX0[unitIdx]! + L.nets[unitIdx]!;
  const hingeLocalX = innerLocalX <= W / 2 ? partLeft : partRight;
  const hinge = polyLocalToWorld([{ x: hingeLocalX, y: D }], o, o.rotation)[0]!;
  if (distPointToBBox(hinge, bbOther) <= radius + TOL) {
    out.push(
      buildIssue('CORNER-DOOR-SWING', {
        target: `${src.id} / ${other.id}`,
        targetKind: 'cabinet',
        ctx: { nameSrc: src.name, nameOther: other.name, radius: Math.round(radius) },
      })
    );
  }
}
