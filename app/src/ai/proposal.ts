import type { ConnectionKind, Issue, Project, RuleSet, UnitSpec } from '../core/types.ts';
import { buildIssue } from '../core/rules/issueCatalog.ts';
import { defaultCabinetParams } from '../core/docFactory.ts';
import { ACTIONS } from '../../shared/aiContract.mjs';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  DesignProposal —— 需求级设计方案（v0.3，P3）
 *
 *  ── 它是什么，不是什么 ──
 *    · 是 **AI 对需求的理解与规划**："玄关要一个鞋柜，下面放鞋、上面放钥匙，
 *      旁边再接一个挂衣区，两柜成 L 型"。
 *    · **不是**命令、不是几何、不是板件清单、不是改动方案（那是 draft 的活）。
 *    · 它**不进正式模型**：只有 `compileProposal` 把它翻译成 AiAction，
 *      再走既有的 干跑 → 预览 → 确认 → commitPlan 那条链路。
 *
 *  ── 为什么必须比"直接让 AI 出动作"多这一层 ──
 *    直接出动作时，模型要同时决定"做什么"和"怎么做"（先建柜、再建组合、
 *    组合还得等柜体 id 出来）。前者是设计，后者是工程 —— 让模型干工程活，
 *    它只能猜（猜 id、猜顺序、猜结构），猜错了就是整份拒收。
 *    这一层把工程活交回确定性代码：模型说清"要什么"，系统决定"怎么建"。
 *
 *  ── 三条硬边界 ──
 *    ① **没有坐标**：本文件里出现的数只有尺寸（宽/高/深）与数量，
 *       没有任何 x / y / z / 板件 / 图元。落位由 `pickFreeSpot` 定。
 *    ② **不是后门**：编译产物是 AiAction，仍然过契约校验、过 CommandBus、
 *       过 strict 规则校验 —— 与 AI 直接输出的动作同权同位。
 *    ③ **不确定要写在脸上**：`assumptions`（我按什么假设做的）与
 *       `questions`（哪些必须你来定）是两个独立字段；有 `questions`
 *       的方案**不允许被应用** —— 宁可停下来问，不可替用户拍板。
 *
 *  ── 结构复用（不重新发明柜体模型）──
 *    分区意图的形状与契约里 `cabinet.create` 的 `units` **完全一致**，
 *    构造仍然走 `unitsFromIntents` → `makeUnit`（唯一构造点）。
 *    上下分层用 P1 的 `rows`，组合用 P2 的 `FurnitureAssembly` + `Connection`。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 分区意图 —— 形状与契约 `cabinet.create.units` 逐字段一致（同源，不另起一套） */
export interface ProposalUnit {
  kind: string;
  nickname?: string;
  /** 期望宽（mm）。不给 = 与其它分区按比例摊总宽 */
  width?: number | null;
  /** 抽屉数 / 层板数 */
  count?: number | null;
  /** 门扇数（0 = 开放格） */
  doorCount?: number | null;
  /** 挂衣区挂杆高 */
  rodHeight?: number | null;
  // ── 电器格（kind='appliance'）──
  applianceName?: string | null;
  openingWidth?: number | null;
  openingHeight?: number | null;
  openingDepth?: number | null;
  topDrawers?: number | null;
}

/** 一行（垂直分层，自上而下） */
export interface ProposalRow {
  /** 行净高；'fill' = 吃掉剩余；不给 = 均分 */
  height?: number | 'fill' | null;
  units: ProposalUnit[];
}

export interface ProposalCabinet {
  /** 方案内引用名。组合用它引用本柜 —— **不依赖 id**（柜还没建，id 不存在） */
  ref: string;
  name?: string | null;
  /** 房间 id 或名字；不给则用方案的 `room` */
  room?: string | null;
  width?: number | null;
  height?: number | null;
  depth?: number | null;
  /** 单行柜：从左到右一列分区 */
  units?: ProposalUnit[] | null;
  /** 多行柜（上下分层）；给了就以它为准 */
  rows?: ProposalRow[] | null;
  /** 双面柜（岛台）背面排 */
  backUnits?: ProposalUnit[] | null;
  /** 朝向意图（0/90/180/270）。落位由系统定，这里只说"朝哪边" */
  rotation?: number | null;
}

export interface ProposalConnection {
  /** cabinet ref */
  a: string;
  /** cabinet ref */
  b: string;
  kind: ConnectionKind;
}

export interface ProposalAssembly {
  ref: string;
  name?: string | null;
  members: string[];
  connections?: ProposalConnection[] | null;
}

export interface DesignProposal {
  id?: string;
  /** 一句话标题（界面顶着的那句） */
  title: string;
  /** 方案说明：AI 为什么这样规划 */
  summary?: string | null;
  /** 默认目标房间（id 或名字）。柜体没给 room 时用这个 */
  room?: string | null;
  cabinets: ProposalCabinet[];
  assemblies?: ProposalAssembly[] | null;
  /** AI 自己声明的假设（"深度没说，按 600"） */
  assumptions?: string[] | null;
  /** 必须用户回答的问题 —— **非空时不允许应用到模型** */
  questions?: string[] | null;
}

// ═══════════════════════════ 形状门（AI 输出的第一道关）══════════════════════════

/**
 * 形状校验：**只管它是不是这个形状**，不管它对不对。
 *
 * 实现在 `shared/aiContract.mjs` —— 服务端（AI 输出进系统的第一道门）与前端
 * 共用同一份。这里只做转发：**两份实现迟早会分家**，分家的那天就是
 * "服务端放过的方案，前端说它不合法"。
 */
export { proposalShapeError } from '../../shared/aiContract.mjs';

// ═══════════════════════════ 语义校验（对着项目与规则集）══════════════════════════

const UNIT_KINDS: UnitSpec['kind'][] = ['drawerBank', 'hanging', 'shelves', 'open', 'appliance'];
const CONN_KINDS: ConnectionKind[] = ['corner', 'butt', 'stack'];

/**
 * 柜体尺寸范围 —— **直接读契约**，不在这里再写死一遍数字。
 *
 * 写死一份必然与契约分家（契约改了、这边的报错还在说旧范围），
 * 而报错说的范围不对，比没有这条校验更糟 —— 用户按它改完还是被拒。
 */
function sizeRange(dim: 'width' | 'height' | 'depth'): { min: number; max: number } {
  const p = (ACTIONS['cabinet.create']?.params as unknown as Record<string, { min?: number; max?: number }> | undefined)?.[dim];
  return { min: Number(p?.min ?? 0), max: Number(p?.max ?? 0) };
}

const DIM_ZH: Record<'width' | 'height' | 'depth', string> = { width: '宽', height: '高', depth: '深' };

/**
 * 语义校验：报的是"这个方案能不能落成模型"，每条都给得出具体信息。
 *
 * 与 `validateAssemblies` 的分工：那边校验**已在模型里**的组合，
 * 这里校验**还没进模型**的方案 —— 所以引用用 ref 而不是 id。
 */
export function validateProposal(p: DesignProposal, project: Project): Issue[] {
  const out: Issue[] = [];
  const t = (suffix: string): string => `proposal${suffix}`;
  const rooms = project.rooms;

  if (!Array.isArray(p.cabinets) || p.cabinets.length === 0) {
    out.push(buildIssue('PROPOSAL-EMPTY', { target: t(''), targetKind: 'project', ctx: { count: 0 } }));
    return out;
  }

  // 房间：方案级默认值 + 每个柜体的 room 都要能落到一个真房间
  const resolveRoom = (v: string | null | undefined): string | null => {
    if (!v) return null;
    return rooms.some((r) => r.id === v || r.name === v) ? v : null;
  };
  if (p.room !== undefined && p.room !== null && resolveRoom(p.room) === null) {
    out.push(buildIssue('PROPOSAL-ROOM-MISSING', {
      target: t(''), targetKind: 'project',
      ctx: { room: String(p.room), count: rooms.length, names: rooms.map((r) => r.name).join('、') || '（项目里还没有房间）' },
    }));
  }

  // ref 唯一（组合靠它引用柜体，重复 = 引用到错的那个）
  const seenRef = new Map<string, number>();
  p.cabinets.forEach((c, i) => {
    const ref = String(c.ref ?? '');
    if (ref === '') {
      out.push(buildIssue('PROPOSAL-CAB-NO-REF', { target: t(`.cabinets[${i}]`), targetKind: 'project', ctx: { index: i + 1 } }));
      return;
    }
    const n = (seenRef.get(ref) ?? 0) + 1;
    seenRef.set(ref, n);
    if (n > 1) {
      out.push(buildIssue('PROPOSAL-CAB-DUP-REF', { target: t(`.cabinets[${i}]`), targetKind: 'project', ctx: { ref, count: n } }));
    }
    if (c.room !== undefined && c.room !== null && resolveRoom(c.room) === null) {
      out.push(buildIssue('PROPOSAL-ROOM-MISSING', {
        target: t(`.cabinets[${i}]`), targetKind: 'project',
        ctx: { room: String(c.room), count: rooms.length, names: rooms.map((r) => r.name).join('、') || '（项目里还没有房间）' },
      }));
    }
    for (const dim of ['width', 'height', 'depth'] as const) {
      const v = c[dim];
      if (v === undefined || v === null) continue;
      const r = sizeRange(dim);
      if (!Number.isFinite(v) || v < r.min || v > r.max) {
        out.push(buildIssue('PROPOSAL-SIZE-RANGE', {
          target: t(`.cabinets[${i}]`), targetKind: 'project',
          ctx: { ref, dim: DIM_ZH[dim], value: Math.round(Number(v)), min: r.min, max: r.max },
        }));
      }
    }
    // 分区类型：逐个查，报"第几行的第几格"—— 只说"有错"用户没法改
    const unitsOf: Array<{ where: string; list: ProposalUnit[] }> = [];
    if (c.units) unitsOf.push({ where: `柜体「${ref}」`, list: c.units });
    if (c.backUnits) unitsOf.push({ where: `柜体「${ref}」背面排`, list: c.backUnits });
    (c.rows ?? []).forEach((r, j) => unitsOf.push({ where: `柜体「${ref}」第 ${j + 1} 行`, list: r.units ?? [] }));
    for (const { where, list } of unitsOf) {
      list.forEach((u, k) => {
        if (!UNIT_KINDS.includes(u.kind as UnitSpec['kind'])) {
          out.push(buildIssue('PROPOSAL-UNIT-KIND', {
            target: t(`.cabinets[${i}]`), targetKind: 'project',
            ctx: { where, index: k + 1, kind: String(u.kind), count: UNIT_KINDS.length, kinds: UNIT_KINDS.join(' / ') },
          }));
        }
      });
    }
  });

  // 组合：成员 ref 必须在本方案里，且至少两个；连接的 kind 必须是三种之一
  for (const [i, a] of (p.assemblies ?? []).entries()) {
    const ref = String(a.ref ?? `第 ${i + 1} 个组合`);
    if (!Array.isArray(a.members) || a.members.length < 2) {
      out.push(buildIssue('PROPOSAL-ASM-MIN', { target: t(`.assemblies[${i}]`), targetKind: 'project', ctx: { ref, count: a.members?.length ?? 0 } }));
    }
    for (const m of a.members ?? []) {
      if (!seenRef.has(String(m))) {
        out.push(buildIssue('PROPOSAL-ASM-MEMBER', {
          target: t(`.assemblies[${i}]`), targetKind: 'project',
          ctx: { ref, member: String(m), count: p.cabinets.length },
        }));
      }
    }
    for (const c of a.connections ?? []) {
      if (!CONN_KINDS.includes(c.kind)) {
        out.push(buildIssue('PROPOSAL-CONN-KIND', {
          target: t(`.assemblies[${i}]`), targetKind: 'project',
          ctx: { ref, kind: String(c.kind), count: CONN_KINDS.length, kinds: CONN_KINDS.join(' / ') },
        }));
      }
      for (const side of ['a', 'b'] as const) {
        const v = String(c[side] ?? '');
        if (!(a.members ?? []).includes(v)) {
          out.push(buildIssue('PROPOSAL-CONN-REF', {
            target: t(`.assemblies[${i}]`), targetKind: 'project',
            ctx: { ref, member: v, side: side === 'a' ? 'a 端' : 'b 端', count: (a.members ?? []).length },
          }));
        }
      }
    }
  }

  const questions = (p.questions ?? []).filter((q) => typeof q === 'string' && q.trim() !== '');
  if (questions.length > 0) {
    out.push(buildIssue('PROPOSAL-OPEN-QUESTIONS', {
      target: t(''), targetKind: 'project',
      ctx: { count: questions.length, first: questions[0] ?? '' },
    }));
  }
  return out;
}

/** 有这些问题就不能应用到模型（ERROR，或"必须你先回答"） */
export function proposalBlocked(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'ERROR' || i.code === 'PROPOSAL-OPEN-QUESTIONS');
}

/** 规则集默认值（补齐方案里没给的尺寸时用） */
export function defaultSizes(rules: RuleSet): { width: number; height: number; depth: number } {
  const b = defaultCabinetParams(rules);
  return { width: b.width, height: b.height, depth: b.depth };
}
