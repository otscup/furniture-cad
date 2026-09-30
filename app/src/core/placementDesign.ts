/**
 * ══════════════════════════════════════════════════════════════════════
 *  Design Placement Validation（v0.3，P8.3）
 *
 *  ── 它解决什么 ──
 *    P8.2 撞出来的事实：**几何上合法的落位 ≠ 设计语义上合理的落位**。
 *    副臂 rotation=90 能严丝合缝贴到主臂右端（几何成立），但贴上去的是它的
 *    **门脸** —— 柜门朝里开、被主臂挡死。Resolver 该说"能放"（它确实能放），
 *    可系统不该就此闭嘴。这一层就是要在 Resolver 之后补上那句话。
 *
 *  ── 分层（不许越界）──
 *    Placement Resolver  "它能不能放在那里？"  → ResolvedPlacement
 *    Design Validator    "这样放符不符合设计语义？" → valid / warning / error
 *    Geometry            "实际空间几何是什么？"
 *    Manufacturing       "从最终几何派生制造信息"
 *
 *    **Validator 不重算 Placement**：它拿到的是已经解析好的结果，只做判断。
 *    它也不改 rotation —— 发现可疑只报结构化结果 + 候选朝向，
 *    "转不转、转成哪个"是设计决定，交给 AI / 用户，本模块不代劳（见 §不替用户选）。
 *
 *  ── 复用，不复制 ──
 *    · 接触判定：`relations.deriveContacts()` —— 全项目唯一一处"两柜怎么挨着"。
 *      本模块**只消费**它的结论（连"是不是 corner"都问它要），不写第二份接触/转角检测。
 *    · 声明的硬事实：`relations.validateAssemblies()` —— 声明 corner 却实际 butt
 *      这类"一定非法"的结论 P2 已经能证明，这里直接透传（status=error），不重写。
 *    · 面朝向：`placement.faceDirection()` —— 唯一的旋转实现，本文件没有三角函数。
 *
 *  ── 三条纪律 ──
 *    ① 只建立在**唯一可判定**的事实上。"门脸紧贴着邻居 ⇒ 门打不开"是几何事实；
 *       "L 型必须 rotation=270"是设计习惯 —— 后者不写死（左右转角、镜像、
 *       不同家具都能有别的合理朝向），所以可疑只报 warning，并且把**所有**同样
 *       成立的候选朝向列出来，不替用户挑一个。
 *    ② 纯函数：不改 Model、不改 placement、不调 AI、不依赖 UI、同输入同输出。
 *    ③ 不进主规则链：设计语义是**提示**不是硬规则。进了主链就等于把"可能合理"
 *       的布局报成项目错误，那会把 P6 的 Hard Rule > Design Knowledge > User
 *       Preference 挤掉 —— 用户偏好本该能影响选择，不该被硬规则堵死。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Cabinet, ConnectionEdge, Project, Vec2 } from './types.ts';
import { bboxOf } from './geometry/transform.ts';
import { getCabinetFootprint } from './geometry/generate.ts';
import { deriveContacts, validateAssemblies } from './relations.ts';
import { buildIssue } from './rules/issueCatalog.ts';
import {
  faceSegmentOf,
  frontDirection,
  sceneItemOf,
  type PlacementBatchResolve,
  type PlacementError,
  type PlacementIntent,
  type ResolvedPlacement,
} from './placement.ts';

/** 设计语义结论：valid = 没问题；warning = 几何成立但语义可疑；error = 已证明非法 */
export type DesignPlacementStatus = 'valid' | 'warning' | 'error';

export type DesignPlacementCode =
  /** 并排/前后相接（butt）：某柜的门脸正贴着邻居 —— 门被挡住 */
  | 'DESIGN-FRONT-BLOCKED'
  /** 角接（corner / L 型）：几何接触成立，但某柜门脸朝组合内侧 */
  | 'DESIGN-ORIENTATION-SUSPECT'
  /** P2 已经证明的硬冲突（声明与派生不符）—— 透传，不重写 */
  | 'DESIGN-ASSEMBLY'
  /** 落位根本没解析出来（解析层失败）—— 透传解析层的结构化错误 */
  | 'DESIGN-RESOLVE-FAILED';

/** 一个"同样成立"的朝向候选。**列出 ≠ 推荐**：本模块不替用户选 */
export interface DesignAlternative {
  rotation: number;
  /** 该朝向下门脸的世界朝向（人话） */
  front: string;
  note: string;
}

export interface DesignPlacementFinding {
  status: DesignPlacementStatus;
  code: DesignPlacementCode;
  /** 文案来自 issueCatalog（唯一真相源），本模块不自己拼 */
  message: string;
  hint?: string;
  /** 被判可疑的那只柜（error 时可能是组合 id） */
  cabinetId?: string;
  /** 挡住它（或与它相接）的那只柜 */
  neighborId?: string;
  assemblyId?: string;
  /** 透传 P2 时报原始规则码，便于追责到 P2 的实现 */
  sourceCode?: string;
  alternatives?: DesignAlternative[];
  /** true = 有多个同样成立的朝向，本模块不代为决定 */
  ambiguous?: boolean;
}

/** 派生出来的接触事实（全部来自 deriveContacts，本模块不重新判定接触） */
export interface DesignContactFact {
  a: string;
  b: string;
  kind: 'butt' | 'corner';
  edgeA: ConnectionEdge;
  edgeB: ConnectionEdge;
  /** 角接时的转角方向：站在 A 的背面朝 A 的门脸看，B 在左手边 = 'left' */
  turn?: 'left' | 'right';
}

export interface DesignPlacementReport {
  status: DesignPlacementStatus;
  findings: DesignPlacementFinding[];
  contacts: DesignContactFact[];
}

const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const centerOf = (fp: Vec2[]): Vec2 => {
  const b = bboxOf(fp);
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
};

/** 世界方向的人话（只覆盖轴对齐；斜向如实说"斜向 N°"，不假装是四向之一） */
export function directionZh(v: Vec2): string {
  if (Math.abs(v.x) < 1e-9 && Math.abs(v.y) < 1e-9) return '（零向量，朝向非法）';
  if (Math.abs(v.y) > Math.abs(v.x)) return v.y > 0 ? '前（+Y）' : '后（-Y）';
  if (Math.abs(v.x) > Math.abs(v.y)) return v.x > 0 ? '右（+X）' : '左（-X）';
  const deg = Math.round((Math.atan2(v.y, v.x) * 180) / Math.PI);
  return `斜向 ${deg}°`;
}

/**
 * 从 `origin` 沿 `dir` 射出的射线是否穿过 `box`（slab 法）。
 *
 * 起点取门脸中点、方向取门脸外法线：命中 = 门开出去就撞上那只柜。
 * 只用于**已经相接**的柜对（接触来自 deriveContacts）—— 隔了 2m 的柜不该报，
 * 那是开门半径/碰撞优化的事，本阶段不做。
 */
function rayHitsBox(origin: Vec2, dir: Vec2, box: { min: Vec2; max: Vec2 }): boolean {
  let t0 = 0;
  let t1 = Infinity;
  for (const ax of ['x', 'y'] as const) {
    const d = dir[ax];
    if (Math.abs(d) < 1e-9) {
      if (origin[ax] < box.min[ax] || origin[ax] > box.max[ax]) return false;
      continue;
    }
    let ta = (box.min[ax] - origin[ax]) / d;
    let tb = (box.max[ax] - origin[ax]) / d;
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return true;
}

/** 柜体的门脸（正面）是否朝着 `other` —— 门开出去会不会撞上它 */
export function frontFacesCabinet(cab: Cabinet, other: Cabinet): boolean {
  const seg = faceSegmentOf(sceneItemOf(cab), 'front');
  const mid: Vec2 = { x: (seg.start.x + seg.end.x) / 2, y: (seg.start.y + seg.end.y) / 2 };
  return rayHitsBox(mid, frontDirection(cab), bboxOf(getCabinetFootprint(other)));
}

/**
 * 角接的转角方向：**站在 A 的背面朝 A 的门脸看**，B 在左手边还是右手边。
 *
 * 这是**事实**不是规则 —— 左右转角都可能完全合理，本模块只负责说清是哪一个，
 * 不说哪个对。
 */
export function cornerTurnSide(a: Cabinet, b: Cabinet): 'left' | 'right' {
  const f = frontDirection(a);
  const left: Vec2 = { x: -f.y, y: f.x }; // 朝向 f 时，左手边 = f 逆时针转 90°
  const ca = centerOf(getCabinetFootprint(a));
  const cb = centerOf(getCabinetFootprint(b));
  const v: Vec2 = { x: cb.x - ca.x, y: cb.y - ca.y };
  return dot2(v, left) > 0 ? 'left' : 'right';
}

/**
 * 门脸不朝内的其它轴向朝向（在当前原点下逐一试算）。
 *
 * 只列**同样避开门脸朝内**的候选，不排序、不推荐、不给"最佳"：
 * 这里可能有 3 个都成立，选哪个是设计决定（转角方向、开门方向、房间朝向）。
 * 每个候选都写明"位置需按该朝向重新解析" —— 改朝向会改 footprint，
 * 本模块不重算落位，说了才算诚实（预览 ≠ 提交的教训）。
 */
function orientationAlternatives(cab: Cabinet, other: Cabinet): DesignAlternative[] {
  const cur = ((Math.round(cab.placement.rotation) % 360) + 360) % 360;
  const out: DesignAlternative[] = [];
  for (const rot of [0, 90, 180, 270]) {
    if (rot === cur) continue;
    const trial: Cabinet = { ...cab, placement: { ...cab.placement, rotation: rot } };
    if (frontFacesCabinet(trial, other)) continue;
    const zh = directionZh(frontDirection(trial));
    out.push({
      rotation: rot,
      front: zh,
      note: `门脸朝${zh}；位置需按该朝向重新解析（本模块不改 placement、不替你选）`,
    });
  }
  return out;
}

/** 把已解析的落位套到项目副本上（纯函数，不动入参） */
export function withResolvedPlacements(
  project: Project,
  resolved: Array<{ intent: PlacementIntent; placement: ResolvedPlacement }>
): Project {
  const map = new Map(resolved.map((r) => [r.intent.targetId, r.placement]));
  return {
    ...project,
    cabinets: project.cabinets.map((c) => {
      const p = map.get(c.id);
      return p ? { ...c, placement: { ...c.placement, x: p.x, y: p.y, rotation: p.rotation } } : c;
    }),
  };
}

const statusOf = (f: DesignPlacementFinding[]): DesignPlacementStatus =>
  f.some((x) => x.status === 'error') ? 'error' : f.length > 0 ? 'warning' : 'valid';

/**
 * 设计语义校验（纯函数）—— 输入一个**已落位**的项目（可以是干跑草稿，也可以
 * 是真模型），输出分层结论。
 *
 * ① 硬事实：P2 已经能证明的（声明的连接 vs 派生出的接触）→ 透传，ERROR 进 error。
 * ② 面向语义：相接的两柜，有没有谁的门脸朝内 → warning + 候选朝向（不替选）。
 * ③ 汇总：有 error ⇒ error；只有 warning ⇒ warning；都没有 ⇒ valid。
 */
export function validatePlacementDesign(project: Project): DesignPlacementReport {
  const findings: DesignPlacementFinding[] = [];

  // ① P2 的硬事实 —— 直接复用它的实现与文案，本模块不重写接触/转角判定
  for (const issue of validateAssemblies(project)) {
    if (issue.severity === 'INFO') continue; // 信息提示（如"stack 没核过"）不是设计疑问
    findings.push({
      status: issue.severity === 'ERROR' ? 'error' : 'warning',
      code: 'DESIGN-ASSEMBLY',
      message: issue.message,
      hint: issue.fixHint,
      assemblyId: issue.target,
      sourceCode: issue.code,
    });
  }

  const byId = new Map(project.cabinets.map((c) => [c.id, c]));
  // ② 面向语义：接触事实**只从 P2 派生层取**
  const contacts: DesignContactFact[] = [];
  for (const ct of deriveContacts(project)) {
    const A = byId.get(ct.a);
    const B = byId.get(ct.b);
    if (!A || !B) continue;
    contacts.push({
      a: ct.a,
      b: ct.b,
      kind: ct.kind,
      edgeA: ct.edgeA,
      edgeB: ct.edgeB,
      ...(ct.kind === 'corner' ? { turn: cornerTurnSide(A, B) } : {}),
    });

    const blocked: Array<{ cab: Cabinet; other: Cabinet }> = [];
    if (frontFacesCabinet(A, B)) blocked.push({ cab: A, other: B });
    if (frontFacesCabinet(B, A)) blocked.push({ cab: B, other: A });
    for (const { cab, other } of blocked) {
      const alts = orientationAlternatives(cab, other);
      const issue = buildIssue(ct.kind === 'corner' ? 'DESIGN-ORIENTATION-SUSPECT' : 'DESIGN-FRONT-BLOCKED', {
        target: cab.id,
        targetKind: 'cabinet',
        ctx: {
          cabName: cab.name,
          otherName: other.name,
          rotation: Math.round(cab.placement.rotation),
          front: directionZh(frontDirection(cab)),
          faceWidth: Math.round(cab.params.width),
          count: blocked.length,
          altCount: alts.length,
          alternatives: alts.map((a) => `${a.rotation}°（门脸朝${a.front}）`).join('； ') || '（无）',
        },
      });
      findings.push({
        status: 'warning',
        code: ct.kind === 'corner' ? 'DESIGN-ORIENTATION-SUSPECT' : 'DESIGN-FRONT-BLOCKED',
        message: issue.message,
        hint: issue.fixHint,
        cabinetId: cab.id,
        neighborId: other.id,
        alternatives: alts,
        ambiguous: alts.length > 1,
      });
    }
  }

  return { status: statusOf(findings), findings, contacts };
}

/**
 * 「落位意图 → 解析 → 设计结论」的一次性入口（纯函数）。
 *
 * · 解析失败 ⇒ status=error，原样透传解析层的结构化错误（不静默当 valid）。
 * · 解析成功 ⇒ 把结果套到**副本**上再交给设计校验（入参不动）。
 *
 * 这样 AI / Proposal 只要调一次就拿到"能不能放 + 放得合不合理"两件事，
 * 而两件事的实现仍然各在各的层里。
 */
export function designCheckResolved(project: Project, batch: PlacementBatchResolve): DesignPlacementReport {
  if (!batch.ok) {
    return {
      status: 'error',
      contacts: [],
      findings: [
        {
          status: 'error',
          code: 'DESIGN-RESOLVE-FAILED',
          message: batch.error.message,
          cabinetId: batch.error.targetId,
          neighborId: batch.error.referenceId,
        },
      ],
    };
  }
  return validatePlacementDesign(withResolvedPlacements(project, batch.resolved));
}

/** 单条解析结果的同款入口（解析层给的是单条时不必凑批量） */
export function designCheckPlacement(
  project: Project,
  intent: PlacementIntent,
  result: { ok: true; placement: ResolvedPlacement } | { ok: false; error: PlacementError }
): DesignPlacementReport {
  return designCheckResolved(
    project,
    result.ok
      ? { ok: true, resolved: [{ intent, placement: result.placement }] }
      : { ok: false, error: result.error }
  );
}
