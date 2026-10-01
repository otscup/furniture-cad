import type { ImportSource } from '../../core/types.ts';
import type { ProposalRow, ProposalUnit } from '../proposal.ts';
import { nextId } from '../../core/ids.ts';
import type { NormalizedAssembly, NormalizedCabinet, NormalizedDesign } from '../import/normalized.ts';
import type {
  Confidence,
  VisionCabinet,
  VisionComponentType,
  VisionResult,
  VisionRow,
  VisionUnit,
} from './types.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  visionResultToNormalized —— 诚实映射层（P5 的核心纪律所在）
 *
 *  VisionResult（模型「看见了什么」）→ NormalizedDesign（系统「理解成什么」）。
 *
 *  ── 绝不编造看不见的生产结构 ──
 *    · 整柜尺寸若是「视觉估计」（图片无标注），保留为估计值但**标成 caveats**
 *      （用户确认前不可直接当生产尺寸下料）；
 *    · 真实深度 / 板厚 / 隐藏隔板 / 柜体连接 图片看不见 → 进 caveats；
 *    · 模型自己都说不清（ambiguous）→ 进 questions（**硬阻断**，必须用户回答）。
 *
 *  ── 可见结构才落进单位/行 ──
 *    只有模型明确给的 rows / units / components 才翻译成 ProposalRow/ProposalUnit；
 *    没给内部结构的柜体，绝不替它脑补层板——只设 caveats 提示「内部按可见分区 +
 *    规则集默认」，把决定权留给用户在 CAD 设计器里确认。
 *
 *  ── 不碰几何、不写模型 ──
 *    产物是 NormalizedDesign，后续走 compileImport → dryRunPlan → 预览 → 确认
 *    → CommandBus，与 JSON / DXF 导入同权同位。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface VisionToNormalizedOptions {
  label?: string;
  batchId?: string;
  /** 默认目标房间（id 或名） */
  room?: string | null;
}

function round(n: number): number {
  return Math.round(Number(n));
}

function mapUnit(u: VisionUnit, cabW: number | null): ProposalUnit {
  const width =
    typeof u.widthMm === 'number'
      ? u.widthMm
      : typeof u.widthRatio === 'number' && cabW !== null
        ? round(u.widthRatio * cabW)
        : null;
  return {
    kind: u.kind,
    width,
    count: typeof u.count === 'number' ? u.count : null,
    doorCount: typeof u.doorCount === 'number' ? u.doorCount : null,
    // ★ P9.9 约束一：挂衣区挂杆高是业务语义字段（VisionUnit 有），此前被静默丢弃 ⇒ 显式透传
    rodHeight: typeof u.rodHeight === 'number' ? u.rodHeight : null,
    applianceName: u.applianceName ?? null,
    openingWidth: u.openingWidth ?? null,
    openingHeight: u.openingHeight ?? null,
  };
}

function mapRow(r: VisionRow, cabH: number | null): ProposalRow {
  const height =
    typeof r.heightMm === 'number'
      ? r.heightMm
      : typeof r.heightRatio === 'number' && cabH !== null
        ? round(r.heightRatio * cabH)
        : null;
  return {
    height,
    units: (r.units ?? []).map((u) => mapUnit(u, null)),
  };
}

export function visionResultToNormalized(result: VisionResult, opts: VisionToNormalizedOptions = {}): NormalizedDesign {
  const source: ImportSource = 'imageVision';
  const batchId = opts.batchId ?? nextId('import', []);
  const scaleKnown = Boolean(result.scale?.known);

  const cabinets: NormalizedCabinet[] = result.cabinets.map((c: VisionCabinet, i: number) => {
    const ref = c.ref || `vis_${i + 1}`;
    const name = c.name || ref;
    const w = c.width?.value ?? null;
    const h = c.height?.value ?? null;
    const d = c.depth?.value ?? null;
    const cabConf: Confidence = c.confidence;

    // 可见结构（有才翻译，绝不脑补）
    const rows = c.rows && c.rows.length > 0 ? c.rows.map((r) => mapRow(r, h)) : null;
    const units = c.units && c.units.length > 0 ? c.units.map((u) => mapUnit(u, w)) : null;

    // ── caveats：图片看不见、需要用户确认的生产结构 ──
    const caveats: string[] = [];
    const anyEstimate = !scaleKnown && (c.width?.source === 'estimate' || c.height?.source === 'estimate' || c.depth?.source === 'estimate');
    if (anyEstimate) {
      const dims = [w ?? '?', h ?? '?', d ?? '?'].join('×');
      caveats.push(`柜体「${name}」尺寸为视觉估计（约 ${dims}mm），图片无可靠尺寸标注，下料前请确认真实生产尺寸`);
    }
    if ((c.notVisible ?? []).includes('depth')) {
      caveats.push(`柜体「${name}」真实深度图片不可见（按估计约 ${d ?? '?'}mm 生成），下料前请确认`);
    }
    if ((c.notVisible ?? []).includes('board-thickness')) {
      caveats.push(`柜体「${name}」板厚图片不可见，按规则集默认板厚生成，请确认`);
    }
    if ((c.notVisible ?? []).includes('inner-partitions')) {
      caveats.push(`柜体「${name}」内部隔板/层板图片不可见，仅按可见分区生成，未见于图片者按规则集默认补齐`);
    }
    if ((c.notVisible ?? []).includes('connection') && (result.relations ?? []).some((r) => r.from === ref || r.to === ref)) {
      caveats.push(`柜体「${name}」与相邻柜体的物理连接方式图片不可见：已按独立柜体落位并归入同一组，确认后可用「按当前落位补全连接」建立真实连接`);
    }

    return {
      ref,
      name,
      room: c.room ?? opts.room ?? null,
      width: w,
      height: h,
      depth: d,
      units,
      rows,
      backUnits: null,
      rotation: typeof c.rotation === 'number' ? c.rotation : null,
      source,
      confidence: cabConf,
      caveats: caveats.length ? caveats : undefined,
      // 注意：这里**不**往 uncertainty（P4 的硬阻断字段）里塞——那些是「连候选都
      // 不敢给」的情形；图片识别的诚实项走 caveats（用户确认即可，不硬卡死）。
    };
  });

  // 组合关系 → NormalizedAssembly（**纯分组，绝不带 connections**）。
  // 为什么不声明 butt/corner：物理连接是生产事实，图片只显示「看起来挨着」——
  // 贴合无缝还是留缝、背后有无收口条，图里看不见。而且干跑执行是逐动作推进的，
  // 编译期 pickFreeSpot 的快照里还没有前序柜体，硬声明续接必然被严格邻接校验
  // 正确地拒收。所以：分组进候选（用户确认后落库），连接方式永远留给用户
  // 确认后用「按当前落位补全连接」补——这正是 P2 铺好的既有路径。
  const REL_ZH: Record<string, string> = {
    'L-shape': 'L 型',
    'side-by-side': '并排',
    stacked: '上下',
    adjacent: '相邻',
  };
  // 共享成员的 relation 合并成一组（一排三个柜子不该拆成两个重叠组合）
  const groups: Array<{ members: string[]; kinds: string[] }> = [];
  for (const rel of result.relations ?? []) {
    const kinds = [...(groups.find((g) => g.members.includes(rel.from) || g.members.includes(rel.to))?.kinds ?? []), rel.kind];
    const hit = groups.find((g) => g.members.includes(rel.from) || g.members.includes(rel.to));
    if (hit) {
      for (const m of [rel.from, rel.to]) if (!hit.members.includes(m)) hit.members.push(m);
      hit.kinds = [...new Set(kinds)];
    } else {
      groups.push({ members: [rel.from, rel.to], kinds: [rel.kind] });
    }
  }
  const assemblies: NormalizedAssembly[] = groups.map((g, i) => ({
    ref: `asm_${String(i + 1).padStart(3, '0')}`,
    name: `图中${[...new Set(g.kinds)].map((k) => REL_ZH[k] ?? k).join('、')}组合`,
    members: g.members,
    connections: null,
  }));

  // 真正说不清的 → questions（硬阻断）
  const questions: string[] = [];
  for (const a of result.ambiguous ?? []) {
    if (typeof a === 'string' && a.trim()) questions.push(a);
  }
  // 识别不到任何尺寸的柜体 → 必须问
  for (const c of result.cabinets) {
    if (c.width == null && c.height == null) {
      questions.push(`柜体「${c.name || c.ref}」识别不到任何尺寸，请告诉它的真实宽/高后再导入`);
    }
  }

  return {
    title: '图片识别导入',
    summary: result.notes && result.notes.length ? result.notes.join('；') : '图片/效果图视觉识别结果',
    source,
    label: opts.label,
    batchId,
    room: opts.room ?? null,
    cabinets,
    assemblies: assemblies.length ? assemblies : null,
    assumptions: null,
    questions: questions.length ? questions : null,
    // P5 真实视觉识别是已验证能力；但具体生产结构仍靠 caveats 暴露，不在此标未验证
    unverifiedCapabilities: null,
  };
}

/** VisionComponentType 仅用于文档/类型完整；映射时组件信息已并入 rows/units 语义，
 *  这里保留常量以衔接未来「逐组件可视化高亮」需求（不引入新依赖）。 */
export const VISION_COMPONENT_TYPES: VisionComponentType[] = ['door', 'drawer', 'open-shelf', 'shelf', 'appliance-cavity'];
