/**
 * ══════════════════════════════════════════════════════════════════════
 *  组合关系层（v0.3，P2）—— 派生与校验的**唯一**实现
 *
 *  ── 这一层要解决的"坐标猜测"问题 ──
 *    v0.2 里"这两个柜是不是一组 L 型"只能靠几何巧合推断：两柜垂直、共享角点、
 *    不重叠 ⇒ 猜它是 L。于是用户把两个柜**放得近**会被当成 L 型，
 *    真的 L 型因为差 3mm 又认不出来。语义模型里根本没有"这是一组"这件事。
 *    P2 把这件事变成**可声明的事实**：`FurnitureAssembly` + `Connection`。
 *
 *  ── 三条纪律（本文件的存在理由）──
 *    ① **关系层不产生几何**。声明组合不改任何板件/尺寸/2D/3D/DXF/BOM。
 *       落位仍由 `snapPlace.joinSpots` 算，干涉仍由 `detectCollisions` 判。
 *    ② **"接不接触"只有这一处判定**。别处（转角检查、AI、UI）一律调用
 *       `deriveContacts()`，不许再写一遍"两柜是不是挨着"。第二份真相源
 *       迟早与这份算出不一样的答案，而那时界面与清单会说不同的话。
 *    ③ **声明与推断必须分开**（`origin`）。推断只能用来表达，不能据此报错 ——
 *       否则用户只是把两个柜放得近，却收到"你说连着其实没连"的 ERROR。
 *
 *  ── 为什么 `stack` 派生不出来 ──
 *    柜体 placement 只有 (x, y, rotation)，没有 Z。没有 Z 就判不了谁在谁上面，
 *    硬算就是猜。所以：允许**声明** stack，但本文件不校验它，只发一条
 *    "你说叠放了，本阶段没有 Z 坐标可核"的提示 —— 如实说没核，不假装核过。
 * ══════════════════════════════════════════════════════════════════════
 */
import type {
  Cabinet,
  Connection,
  ConnectionEdge,
  ConnectionKind,
  FurnitureAssembly,
  Issue,
  Project,
  Vec2,
} from './types.ts';
import { getCabinetFootprint } from './geometry/generate.ts';
import { bboxOf } from './geometry/transform.ts';
import { buildIssue } from './rules/issueCatalog.ts';

/** 相接容差（mm）：与 detectCollisions / corner.ts 同语义 —— 相切算接上，重叠归碰撞管 */
export const CONTACT_TOL = 2;

/**
 * footprint 的四条边与**语义边名**的对应（顺序由 `rectPts` 固定）：
 * 点序 (0,0) (W,0) (W,D) (0,D) ⇒ 边 0 = back(y0)、1 = right(x=W)、2 = front(y=D)、3 = left(x=0)。
 * 这个映射**只能有一处**，否则"声明的 right"与"几何的 right"会各指一条边。
 */
export const EDGE_ORDER: ConnectionEdge[] = ['back', 'right', 'front', 'left'];

export const EDGE_ZH: Record<ConnectionEdge, string> = {
  back: '背面（贴墙侧）',
  front: '正面（门脸）',
  left: '左端',
  right: '右端',
};

export const KIND_ZH: Record<ConnectionKind, string> = {
  corner: '角接（L 型）',
  butt: '续接（并排）',
  stack: '叠放（上下）',
};

/** 派生出来的一段接触：两柜怎么挨着（不含坐标意图，只是几何事实） */
export interface Contact {
  kind: 'butt' | 'corner';
  a: string;
  b: string;
  /** 续接：贴合的那条边（唯一确定）；角接：由角点归属推导（有歧义，故只软校验） */
  edgeA: ConnectionEdge;
  edgeB: ConnectionEdge;
  /** 角接时的共享角点；续接为 null */
  corner: Vec2 | null;
}

const norm = (deg: number): number => ((Math.round(deg) % 360) + 360) % 360;
const axisAligned = (cab: Cabinet): boolean => norm(cab.placement.rotation) % 90 === 0;
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const len = (a: Vec2): number => Math.hypot(a.x, a.y);

/** 点到线段所在直线的距离（用于"共线"判定） */
function distPointToLine(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l = len(ab);
  if (l === 0) return len(sub(p, a));
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / (l * l)));
  return len(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }));
}

/** 点到线段的距离 */
function distPointToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return len(sub(p, a));
  const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return len(sub(p, { x: a.x + ab.x * t, y: a.y + ab.y * t }));
}

/** 两条线段沿自身方向的投影区间是否真的重叠（重叠长度 > 0） */
function overlapLen(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): number {
  const d = sub(a1, a0);
  const l = len(d);
  if (l === 0) return 0;
  const u = { x: d.x / l, y: d.y / l };
  const pa0 = 0;
  const pa1 = l;
  const pb0 = dot(sub(b0, a0), u);
  const pb1 = dot(sub(b1, a0), u);
  return Math.max(0, Math.min(pa1, Math.max(pb0, pb1)) - Math.max(pa0, Math.min(pb0, pb1)));
}

/** 两条边是否共线贴合（平行、距离 ≤ 容差、投影有重叠） */
function edgesFlush(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): boolean {
  const da = sub(a1, a0);
  const db = sub(b1, b0);
  const la = len(da);
  const lb = len(db);
  if (la === 0 || lb === 0) return false;
  // 平行：叉积相对长度可忽略
  const cross = Math.abs(da.x * db.y - da.y * db.x) / (la * lb);
  if (cross > 1e-6) return false;
  if (distPointToLine(b0, a0, a1) > CONTACT_TOL) return false;
  return overlapLen(a0, a1, b0, b1) > CONTACT_TOL;
}

/**
 * 两个 footprint 之间的**最小距离**（mm）。
 * 报"你说连着但没连着"时必须说出**差多少**：只说"没相接"用户得自己拿尺子量，
 * 而这是派生层顺手就能算出来的数（校验器报的是生成器的输出，这里就是生成器的一部分）。
 */
export function minDistance(fpA: Vec2[], fpB: Vec2[]): number {
  let best = Infinity;
  for (const p of fpA) for (const e0 of fpB) best = Math.min(best, distPointToSeg(p, e0, fpB[(fpB.indexOf(e0) + 1) % 4]!));
  for (const p of fpB) for (const e0 of fpA) best = Math.min(best, distPointToSeg(p, e0, fpA[(fpA.indexOf(e0) + 1) % 4]!));
  return Number.isFinite(best) ? Math.round(best) : 0;
}

/** 两个轴对齐 bbox 是否真的有面积重叠（重叠归 detectCollisions，这里跳过） */
function boxesOverlap(a: { min: Vec2; max: Vec2 }, b: { min: Vec2; max: Vec2 }): boolean {
  return a.min.x < b.max.x - CONTACT_TOL && a.max.x > b.min.x + CONTACT_TOL
    && a.min.y < b.max.y - CONTACT_TOL && a.max.y > b.min.y + CONTACT_TOL;
}

/**
 * 角接的边：共享角点在 A 上属于相邻两条边，取**更朝向对方**的那条。
 *
 * 为什么这么定：角点天然属于两条边（比如右上角同时属于 right 与 front），
 * 说"L 型是 right 还是 front 相接"本身就有歧义。取法线朝向对方质心点积更大的
 * 那条 —— 规则确定、可复现、可解释。由于有歧义，声明不符只报 WARNING（软提示），
 * 不报 ERROR：硬规则只能建立在唯一可判定的事实上。
 */
function cornerEdgeOf(fp: Vec2[], corner: Vec2, otherCenter: Vec2): ConnectionEdge {
  let best: ConnectionEdge = 'right';
  let bestDot = -Infinity;
  for (let i = 0; i < 4; i++) {
    const p0 = fp[i]!;
    const p1 = fp[(i + 1) % 4]!;
    if (distPointToSeg(corner, p0, p1) > CONTACT_TOL) continue; // 只考虑含该角点的两条边
    const d = sub(p1, p0);
    const l = len(d) || 1;
    // 外法线：矩形点序为逆时针/顺时针固定，外法线 = 边向量右转 90° 的单位向量（按 (x,y)→(y,-x) 取再按方向修正）
    const n = { x: d.y / l, y: -d.x / l };
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const c = len(sub(p0, mid)) > 0 ? mid : p0;
    // 用"中点 + 法线微推"是否更靠近对方质心来定外法线朝向
    const probe = { x: c.x + n.x, y: c.y + n.y };
    const sign = len(sub(otherCenter, probe)) < len(sub(otherCenter, c)) ? 1 : -1;
    const outward = { x: n.x * sign, y: n.y * sign };
    const v = dot(outward, sub(otherCenter, c));
    if (v > bestDot) {
      bestDot = v;
      best = EDGE_ORDER[i]!;
    }
  }
  return best;
}

/**
 * 从落位派生**全部真实接触**（同房间、轴对齐、相接但不重叠）。
 *
 * 这是全项目唯一一处"两柜是不是挨着、怎么挨着"的实现。
 */
export function deriveContacts(project: Project): Contact[] {
  const out: Contact[] = [];
  const byRoom = new Map<string, Cabinet[]>();
  for (const c of project.cabinets) {
    const arr = byRoom.get(c.roomId) ?? [];
    arr.push(c);
    byRoom.set(c.roomId, arr);
  }

  for (const [, cabs] of byRoom) {
    const fps = new Map<string, Vec2[]>();
    const bbs = new Map<string, { min: Vec2; max: Vec2 }>();
    for (const c of cabs) {
      const fp = getCabinetFootprint(c);
      fps.set(c.id, fp);
      bbs.set(c.id, bboxOf(fp));
    }
    for (let i = 0; i < cabs.length; i++) {
      for (let j = i + 1; j < cabs.length; j++) {
        const A = cabs[i]!;
        const B = cabs[j]!;
        if (!axisAligned(A) || !axisAligned(B)) continue;
        const fpA = fps.get(A.id)!;
        const fpB = fps.get(B.id)!;
        if (boxesOverlap(bbs.get(A.id)!, bbs.get(B.id)!)) continue; // 重叠是碰撞，不是关系

        // ① 续接：任一对边共线贴合
        let butt: Contact | null = null;
        for (let ia = 0; ia < 4 && !butt; ia++) {
          const a0 = fpA[ia]!;
          const a1 = fpA[(ia + 1) % 4]!;
          for (let ib = 0; ib < 4; ib++) {
            const b0 = fpB[ib]!;
            const b1 = fpB[(ib + 1) % 4]!;
            if (edgesFlush(a0, a1, b0, b1)) {
              butt = { kind: 'butt', a: A.id, b: B.id, edgeA: EDGE_ORDER[ia]!, edgeB: EDGE_ORDER[ib]!, corner: null };
              break;
            }
          }
        }
        if (butt) {
          out.push(butt);
          continue;
        }

        // ② 角接：共享一个角点，且两柜轴线垂直
        const d = Math.abs(norm(A.placement.rotation) - norm(B.placement.rotation)) % 360;
        const perp = ((d % 180) + 180) % 180 === 90;
        if (!perp) continue;
        let corner: Vec2 | null = null;
        for (let ia = 0; ia < 4 && !corner; ia++) {
          for (let ib = 0; ib < 4; ib++) {
            if (len(sub(fpA[ia]!, fpB[ib]!)) <= CONTACT_TOL) {
              corner = { x: (fpA[ia]!.x + fpB[ib]!.x) / 2, y: (fpA[ia]!.y + fpB[ib]!.y) / 2 };
              break;
            }
          }
        }
        if (!corner) continue;
        const cB = { x: (bbs.get(B.id)!.min.x + bbs.get(B.id)!.max.x) / 2, y: (bbs.get(B.id)!.min.y + bbs.get(B.id)!.max.y) / 2 };
        const cA = { x: (bbs.get(A.id)!.min.x + bbs.get(A.id)!.max.x) / 2, y: (bbs.get(A.id)!.min.y + bbs.get(A.id)!.max.y) / 2 };
        out.push({
          kind: 'corner',
          a: A.id,
          b: B.id,
          edgeA: cornerEdgeOf(fpA, corner, cB),
          edgeB: cornerEdgeOf(fpB, corner, cA),
          corner,
        });
      }
    }
  }
  return out;
}

/** 一对柜的键（无序），用于去重与查表 */
export const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** 派生出的接触按柜对建索引 */
export function contactIndex(project: Project): Map<string, Contact> {
  const m = new Map<string, Contact>();
  for (const c of deriveContacts(project)) m.set(pairKey(c.a, c.b), c);
  return m;
}

/**
 * 由落位**推断**出的关系（`origin:'inferred'`）—— 只用于表达与界面展示，
 * 不据此报错。真正的事实是用户/AI 声明的那些。
 */
export function inferConnections(project: Project): Connection[] {
  return deriveContacts(project).map((c, i) => ({
    id: `conn_infer_${i + 1}`,
    kind: c.kind,
    a: { cabinetId: c.a, edge: c.edgeA },
    b: { cabinetId: c.b, edge: c.edgeB },
    origin: 'inferred' as const,
  }));
}

/** 项目里所有**声明过**的关系（跨全部 assembly） */
export function authoredConnections(project: Project): Array<{ asm: FurnitureAssembly; conn: Connection }> {
  const out: Array<{ asm: FurnitureAssembly; conn: Connection }> = [];
  for (const asm of project.assemblies ?? []) for (const conn of asm.connections) out.push({ asm, conn });
  return out;
}

/** 组合成员是否**空间上连成一片**（并查集：靠派生出的接触连通） */
function isConnected(memberIds: string[], contacts: Contact[]): boolean {
  if (memberIds.length <= 1) return true;
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const id of memberIds) parent.set(id, id);
  for (const c of contacts) {
    if (!parent.has(c.a) || !parent.has(c.b)) continue;
    const ra = find(c.a);
    const rb = find(c.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const root = find(memberIds[0]!);
  return memberIds.every((id) => find(id) === root);
}

/**
 * 组合关系校验 —— **只校验声明**（`origin:'authored'`）。
 *
 * 不校验推断：推断是"看起来像"，拿它去报错等于用猜测骂用户。
 */
export function validateAssemblies(project: Project): Issue[] {
  const out: Issue[] = [];
  const assemblies = project.assemblies ?? [];
  if (assemblies.length === 0) return out; // 无组合 ⇒ 与 v0.2 完全一致（一条不多）

  const cabById = new Map(project.cabinets.map((c) => [c.id, c]));
  const contacts = contactIndex(project);
  const seenAsm = new Set<string>();
  const ownerOf = new Map<string, string[]>();
  // 同 id 出现几次 —— 报错要报得出"出现了几次"，不是"出现了不止一次"
  const asmIdCount = new Map<string, number>();
  for (const a of assemblies) asmIdCount.set(a.id, (asmIdCount.get(a.id) ?? 0) + 1);

  for (const asm of assemblies) {
    if (seenAsm.has(asm.id)) {
      out.push(buildIssue('ASSEMBLY-ID-DUP', {
        target: asm.id,
        targetKind: 'project',
        ctx: { asmId: asm.id, asmName: asm.name, count: asmIdCount.get(asm.id) ?? 2 },
      }));
      continue;
    }
    seenAsm.add(asm.id);

    if (!project.rooms.some((r) => r.id === asm.roomId)) {
      out.push(buildIssue('ASSEMBLY-ROOM-MISSING', {
        target: asm.id,
        targetKind: 'project',
        ctx: { asmName: asm.name, roomId: asm.roomId, count: project.rooms.length },
      }));
    }
    if (asm.memberIds.length === 0) {
      out.push(buildIssue('ASSEMBLY-EMPTY', { target: asm.id, targetKind: 'project', ctx: { asmName: asm.name, count: 0 } }));
    }

    const seenMember = new Set<string>();
    for (const id of asm.memberIds) {
      if (seenMember.has(id)) {
        out.push(buildIssue('ASSEMBLY-MEMBER-DUP', { target: asm.id, targetKind: 'project', ctx: { asmName: asm.name, cabId: id, count: asm.memberIds.length } }));
        continue;
      }
      seenMember.add(id);
      const cab = cabById.get(id);
      if (!cab) {
        out.push(buildIssue('ASSEMBLY-MEMBER-MISSING', { target: asm.id, targetKind: 'project', ctx: { asmName: asm.name, cabId: id, count: asm.memberIds.length } }));
        continue;
      }
      if (cab.roomId !== asm.roomId) {
        out.push(buildIssue('ASSEMBLY-MEMBER-ROOM', {
          target: asm.id,
          targetKind: 'project',
          ctx: { asmName: asm.name, cabName: cab.name, roomName: project.rooms.find((r) => r.id === cab.roomId)?.name ?? cab.roomId, count: asm.memberIds.length },
        }));
      }
      const owners = ownerOf.get(id) ?? [];
      owners.push(asm.id);
      ownerOf.set(id, owners);
    }

    // 空间上是否连成一片（软提示：一组柜分成两堆，多半是落位错了，但也可能用户有意）
    if (asm.memberIds.length > 1) {
      const mine = deriveContacts(project).filter((c) => seenMember.has(c.a) && seenMember.has(c.b));
      if (!isConnected(asm.memberIds.filter((id) => cabById.has(id)), mine)) {
        out.push(buildIssue('ASSEMBLY-DISCONNECTED', {
          target: asm.id,
          targetKind: 'project',
          ctx: { asmName: asm.name, count: asm.memberIds.length },
        }));
      }
    }

    const seenPair = new Set<string>();
    for (const conn of asm.connections) {
      const key = pairKey(conn.a.cabinetId, conn.b.cabinetId);
      if (conn.a.cabinetId === conn.b.cabinetId) {
        out.push(buildIssue('ASSEMBLY-CONN-SELF', { target: asm.id, targetKind: 'project', ctx: { asmName: asm.name, cabId: conn.a.cabinetId, count: asm.memberIds.length } }));
        continue;
      }
      if (seenPair.has(key)) {
        out.push(buildIssue('ASSEMBLY-CONN-DUP', {
          target: asm.id,
          targetKind: 'project',
          ctx: { asmName: asm.name, nameA: cabById.get(conn.a.cabinetId)?.name ?? conn.a.cabinetId, nameB: cabById.get(conn.b.cabinetId)?.name ?? conn.b.cabinetId, count: asm.memberIds.length },
        }));
        continue;
      }
      seenPair.add(key);

      if (!seenMember.has(conn.a.cabinetId) || !seenMember.has(conn.b.cabinetId)) {
        out.push(buildIssue('ASSEMBLY-CONN-OUTSIDE', {
          target: asm.id,
          targetKind: 'project',
          ctx: { asmName: asm.name, cabId: seenMember.has(conn.a.cabinetId) ? conn.b.cabinetId : conn.a.cabinetId, count: asm.memberIds.length },
        }));
        continue;
      }

      // stack：本阶段没有 Z 坐标，核不了 —— 如实说，不假装核过
      if (conn.kind === 'stack') {
        const sA = cabById.get(conn.a.cabinetId);
        const sB = cabById.get(conn.b.cabinetId);
        const hA = sA?.params.height ?? 0;
        const hB = sB?.params.height ?? 0;
        out.push(buildIssue('ASSEMBLY-STACK-UNVERIFIED', {
          target: asm.id,
          targetKind: 'project',
          ctx: {
            asmName: asm.name,
            nameA: sA?.name ?? conn.a.cabinetId,
            nameB: sB?.name ?? conn.b.cabinetId,
            hA,
            hB,
            total: hA + hB,
          },
        }));
        continue;
      }

      const actual = contacts.get(key);
      if (!actual) {
        const cA = cabById.get(conn.a.cabinetId);
        const cB = cabById.get(conn.b.cabinetId);
        out.push(buildIssue('ASSEMBLY-NOT-TOUCHING', {
          target: asm.id,
          targetKind: 'project',
          ctx: {
            asmName: asm.name,
            nameA: cA?.name ?? conn.a.cabinetId,
            nameB: cB?.name ?? conn.b.cabinetId,
            kindZh: KIND_ZH[conn.kind],
            // 差多少 mm —— 报错要给得出数字，用户才知道该挪多少
            gap: cA && cB ? minDistance(getCabinetFootprint(cA), getCabinetFootprint(cB)) : 0,
          },
        }));
        continue;
      }
      if (actual.kind !== conn.kind) {
        out.push(buildIssue('ASSEMBLY-KIND-MISMATCH', {
          target: asm.id,
          targetKind: 'project',
          ctx: {
            asmName: asm.name,
            nameA: cabById.get(conn.a.cabinetId)?.name ?? conn.a.cabinetId,
            nameB: cabById.get(conn.b.cabinetId)?.name ?? conn.b.cabinetId,
            declared: KIND_ZH[conn.kind],
            actual: KIND_ZH[actual.kind],
            angle: Math.abs(((norm(cabById.get(conn.a.cabinetId)?.placement.rotation ?? 0) - norm(cabById.get(conn.b.cabinetId)?.placement.rotation ?? 0)) % 180 + 180) % 180),
          },
        }));
        continue;
      }
      // 边：续接的贴合边唯一确定 → 硬校验；角接的角点属于两条边，本身有歧义 → 软提示
      const declaredA = conn.a.edge;
      if (declaredA && declaredA !== actual.edgeA) {
        out.push(buildIssue(actual.kind === 'butt' ? 'ASSEMBLY-EDGE-MISMATCH' : 'ASSEMBLY-EDGE-AMBIGUOUS', {
          target: asm.id,
          targetKind: 'project',
          ctx: {
            asmName: asm.name,
            cabName: cabById.get(conn.a.cabinetId)?.name ?? conn.a.cabinetId,
            declared: EDGE_ZH[declaredA],
            actual: EDGE_ZH[actual.edgeA],
            angle: Math.abs(((norm(cabById.get(conn.a.cabinetId)?.placement.rotation ?? 0) - norm(cabById.get(conn.b.cabinetId)?.placement.rotation ?? 0)) % 180 + 180) % 180),
          },
        }));
      }
      const declaredB = conn.b.edge;
      if (declaredB && declaredB !== actual.edgeB) {
        out.push(buildIssue(actual.kind === 'butt' ? 'ASSEMBLY-EDGE-MISMATCH' : 'ASSEMBLY-EDGE-AMBIGUOUS', {
          target: asm.id,
          targetKind: 'project',
          ctx: {
            asmName: asm.name,
            cabName: cabById.get(conn.b.cabinetId)?.name ?? conn.b.cabinetId,
            declared: EDGE_ZH[declaredB],
            actual: EDGE_ZH[actual.edgeB],
            angle: Math.abs(((norm(cabById.get(conn.a.cabinetId)?.placement.rotation ?? 0) - norm(cabById.get(conn.b.cabinetId)?.placement.rotation ?? 0)) % 180 + 180) % 180),
          },
        }));
      }
    }
  }

  // 一个柜同时属于多个组合：整体移动/整组删除会互相打架 —— 允许，但必须说清
  for (const [cabId, owners] of ownerOf) {
    if (owners.length > 1) {
      out.push(buildIssue('ASSEMBLY-MEMBER-SHARED', {
        target: cabId,
        targetKind: 'cabinet',
        ctx: {
          cabName: cabById.get(cabId)?.name ?? cabId,
          names: owners.map((id) => assemblies.find((a) => a.id === id)?.name ?? id).join('、'),
          count: owners.length,
        },
      }));
    }
  }
  return out;
}
