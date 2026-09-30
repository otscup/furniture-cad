/**
 * ══════════════════════════════════════════════════════════════════════
 *  落位上下文的派生（P8.4）—— 观察器要知道"这次改动发生在什么情形里"
 *
 *  ── 为什么非要这一步 ──
 *    「用户把副臂从 90° 转成 270°」本身只是一条数字变化。脱离上下文，
 *    它就会被记成"这个用户喜欢 270°"—— 那正是把设计习惯冒充成规则。
 *    记成"**在右转角 L 型里**他偏好 270°"才是可复用的知识。
 *
 *  ── 取值全部来自已有确定性事实，一个都不新造 ──
 *    · contact  ← P2：优先 `Connection.kind`（authored 声明，语义锚点），
 *                 没有声明才退化到 `deriveContacts().kind`（派生的几何事实）。
 *    · turnSide ← P8.3 `cornerTurnSide()`，**以对方柜为视角**：
 *                 站在参照柜背面朝它门脸看目标柜在哪侧。这样转目标柜时
 *                 上下文**不变**（否则改一次朝向就换一个上下文，永远沉淀不出知识）。
 *
 *  ── 拿不到上下文就返回 null ──
 *    null 的意思不是"用默认上下文"，而是**这条改动不产生知识** ——
 *    说不出是哪一类情形，就没法安全地复用它（宁可少记一条，不可记错一条）。
 *
 *  ── 方向纪律 ──
 *    本文件属于 knowledge 层，可以 import core；**core 永不 import knowledge**
 *    （`placement.ts` 里不许出现 knowledge —— 落位解析必须保持纯确定性）。
 * ══════════════════════════════════════════════════════════════════════
 */

import type { Cabinet, Project } from '../../core/types.ts';
import { deriveContacts } from '../../core/relations.ts';
import { cornerTurnSide } from '../../core/placementDesign.ts';
import type { PlacementContext } from './model.ts';

/** 组合里声明的、与这只柜相关的另一只柜（声明优先，语义锚点） */
function declaredPartner(project: Project, cabinetId: string): { other: string; kind: string } | null {
  const byId = new Map(project.cabinets.map((c) => [c.id, c]));
  for (const asm of project.assemblies ?? []) {
    for (const conn of asm.connections ?? []) {
      const hit =
        conn.a.cabinetId === cabinetId
          ? conn.b.cabinetId
          : conn.b.cabinetId === cabinetId
            ? conn.a.cabinetId
            : null;
      if (hit === null || !byId.has(hit)) continue;
      return { other: hit, kind: conn.kind };
    }
  }
  return null;
}

/** 几何上真正相接的另一只柜（声明缺失时的退化路径） */
function derivedPartner(project: Project, cabinetId: string): { other: string; kind: string } | null {
  const byId = new Map(project.cabinets.map((c) => [c.id, c]));
  for (const ct of deriveContacts(project)) {
    const other = ct.a === cabinetId ? ct.b : ct.b === cabinetId ? ct.a : null;
    if (other === null || !byId.has(other)) continue;
    return { other, kind: ct.kind };
  }
  return null;
}

/**
 * 这只柜当前的落位上下文。**纯函数**，不改 project。
 * 返回 null = 上下文不可判定（这只柜没跟谁构成可命名的接触关系 / 是 stack 需要 Z）。
 */
export function placementContextOf(project: Project, cabinetId: string): PlacementContext | null {
  const byId = new Map(project.cabinets.map((c) => [c.id, c]));
  const self = byId.get(cabinetId);
  if (!self) return null;

  const partner = declaredPartner(project, cabinetId) ?? derivedPartner(project, cabinetId);
  if (!partner) return null;
  // stack 需要 Z 轴 —— 本阶段不做，如实说"不可判定"，绝不退化成 corner
  if (partner.kind === 'stack') return null;
  const contact = partner.kind === 'corner' ? 'corner' : 'butt';

  const other: Cabinet | undefined = byId.get(partner.other);
  if (!other) return null;
  if (contact !== 'corner') return { contact };
  // 视角取**对方**：转自己时这个值不变，知识才能沉淀
  return { contact: 'corner', turnSide: cornerTurnSide(other, self) };
}
