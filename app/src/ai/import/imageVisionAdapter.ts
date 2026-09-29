import type { ImportSource } from '../../core/types.ts';
import { nextId } from '../../core/ids.ts';
import type { NormalizedDesign } from './normalized.ts';
import { arrOrNull, isPlainObject, numOrU, strOrNull } from './normalized.ts';

/**
 * 图片 / Vision 适配器 —— P4 仅收「Vision 模型已产出的结构化结果 JSON」，
 * **不做真正的视觉识别**（那是 P5 的活）。
 *
 * 边界：真实的「户型图/照片 → 语义柜体」视觉识别在 P5。这里只定义
 * 「Vision 结果 → NormalizedDesign」的接收边界——上游 Vision 模型（或人工）
 * 给出已经是 NormalizedDesign 形状（或极简柜体数组）的结果，本适配器收下，
 * 标 low 置信度 + unverifiedCapabilities（图片识别未验证），并强制 uncertainty
 * 提示「图片识别结果未经人工确认」。绝不假装视觉识别已经发生。
 */
export interface ImageVisionImportOptions {
  label?: string;
  batchId?: string;
}

export function parseImageVisionImport(visionResultJson: string | unknown, opts: ImageVisionImportOptions = {}): NormalizedDesign {
  const source: ImportSource = 'imageVision';
  const batchId = opts.batchId ?? nextId('import', []);
  let data: unknown = visionResultJson;
  if (typeof visionResultJson === 'string') {
    try {
      data = JSON.parse(visionResultJson);
    } catch {
      data = null;
    }
  }
  if (!isPlainObject(data) || !Array.isArray(data.cabinets) || data.cabinets.length === 0) {
    return {
      title: '图片识别导入（边界占位）',
      summary: '图片识别（Vision）在 P4 仅预留接收边界，真实视觉识别是 P5 能力',
      source,
      label: opts.label,
      batchId,
      cabinets: [],
      questions: ['图片识别结果不是合法的柜体数组。P4 不执行视觉识别：请由上游 Vision 模型/人工给出 NormalizedDesign 形状的结果再传入。'],
      unverifiedCapabilities: ['vision-floor-plan-recognition'],
    };
  }
  const raw = data as Record<string, unknown>;
  return {
    title: typeof raw.title === 'string' ? raw.title : '图片识别导入',
    summary: strOrNull(raw.summary),
    source,
    label: opts.label,
    batchId,
    room: strOrNull(raw.room),
    cabinets: (raw.cabinets as unknown[]).map((c, i) => {
      const o = isPlainObject(c) ? (c as Record<string, unknown>) : {};
      const ref = typeof o.ref === 'string' && o.ref ? o.ref : `vis_${i + 1}`;
      const conf = o.confidence === 'high' || o.confidence === 'medium' || o.confidence === 'low' ? o.confidence : 'low';
      return {
        ref,
        name: typeof o.name === 'string' ? o.name : ref,
        room: strOrNull(o.room),
        width: numOrU(o.width),
        height: numOrU(o.height),
        depth: numOrU(o.depth),
        units: (o.units as NormalizedDesign['cabinets'][number]['units']) ?? null,
        rows: (o.rows as NormalizedDesign['cabinets'][number]['rows']) ?? null,
        backUnits: (o.backUnits as NormalizedDesign['cabinets'][number]['backUnits']) ?? null,
        rotation: numOrU(o.rotation),
        confidence: conf,
        uncertainty: [
          '图片识别结果未经人工确认',
          ...(Array.isArray(o.uncertainty) ? (o.uncertainty as unknown[]).filter((u) => typeof u === 'string') : []),
        ],
      };
    }),
    assumptions: arrOrNull(raw.assumptions),
    unverifiedCapabilities: ['vision-floor-plan-recognition'],
  };
}
