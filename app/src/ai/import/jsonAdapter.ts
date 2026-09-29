import type { ImportSource } from '../../core/types.ts';
import { nextId } from '../../core/ids.ts';
import type { NormalizedDesign, NormalizedCabinet } from './normalized.ts';
import { arrOrNull, isPlainObject, numOrU, strOrNull } from './normalized.ts';

/**
 * JSON 适配器 —— 确定性、可跑通示例（P4 真正落地的适配器）。
 *
 * 输入两类 JSON：
 *   A. 已接近 NormalizedDesign / DesignProposal 形状的（含 cabinets 数组）——
 *      直接投影，保留每条柜的 confidence / uncertainty（若 present）。
 *   B. 「简单柜体清单」形状（数组，或 { cabinets: [...] } 但字段更简单）——每行
 *      { name, room?, width?, height?, depth?, rotation?, units?, rows?, backUnits? }，
 *      缺 ref 时按 cab1 / cab2... 自动补；其余字段原样透传。
 *
 * 关键纪律：
 *   · 不产出任何坐标（atX / atY / 板件）。落位由系统定。
 *   · 解析是纯函数、确定性，不需要 LLM / API key —— 完全客户端运行。
 *   · 来源归属写进 NormalizedDesign.source / label / batchId，最终落到 Cabinet.origin。
 */
export interface JsonImportOptions {
  label?: string;
  /** 调用方提供的批次 id；不给则自动生成 */
  batchId?: string;
}

export function parseJsonImport(rawText: string, opts: JsonImportOptions = {}): NormalizedDesign {
  const source: ImportSource = 'json';
  const batchId = opts.batchId ?? nextId('import', []);
  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch (e) {
    // 形状门会把它拦下（IMPORT-SHAPE）；这里给一个结构化占位以便校验产出人话
    return {
      title: 'JSON 导入（解析失败）',
      source,
      label: opts.label,
      batchId,
      cabinets: [],
      assumptions: [`JSON 解析失败：${(e as Error).message}`],
    };
  }
  return projectFromAny(data, source, batchId, opts.label);
}

function projectFromAny(data: unknown, source: ImportSource, batchId: string, label?: string): NormalizedDesign {
  // 形状 A：含 cabinets 数组
  if (isPlainObject(data) && Array.isArray(data.cabinets)) {
    const raw = data as Record<string, unknown>;
    return {
      title: typeof raw.title === 'string' && raw.title ? raw.title : 'JSON 导入',
      summary: strOrNull(raw.summary),
      source,
      label,
      batchId,
      room: strOrNull(raw.room),
      cabinets: (raw.cabinets as unknown[]).map((c, i) => cabinetFromAny(c, i)),
      assemblies: (raw.assemblies as NormalizedDesign['assemblies']) ?? null,
      assumptions: arrOrNull(raw.assumptions),
      questions: arrOrNull(raw.questions),
      unverifiedCapabilities: arrOrNull(raw.unverifiedCapabilities),
    };
  }
  // 形状 B：柜体数组
  if (Array.isArray(data)) {
    return {
      title: 'JSON 导入',
      source,
      label,
      batchId,
      cabinets: (data as unknown[]).map((c, i) => cabinetFromAny(c, i)),
    };
  }
  // 其它形状：交给形状门判 IMPORT-SHAPE（返回空 cabinets，validateNormalized 会报）
  return { title: 'JSON 导入', source, label, batchId, cabinets: [] };
}

function cabinetFromAny(c: unknown, i: number): NormalizedCabinet {
  if (!isPlainObject(c)) {
    return { ref: `cab${i + 1}`, name: `柜${i + 1}`, uncertainty: ['该项不是对象，无法解析'] };
  }
  const raw = c as Record<string, unknown>;
  const ref = typeof raw.ref === 'string' && raw.ref ? raw.ref : `cab${i + 1}`;
  const cab: NormalizedCabinet = {
    ref,
    name: typeof raw.name === 'string' ? raw.name : ref,
    room: strOrNull(raw.room),
    width: numOrU(raw.width),
    height: numOrU(raw.height),
    depth: numOrU(raw.depth),
    units: (raw.units as NormalizedCabinet['units']) ?? null,
    rows: (raw.rows as NormalizedCabinet['rows']) ?? null,
    backUnits: (raw.backUnits as NormalizedCabinet['backUnits']) ?? null,
    rotation: numOrU(raw.rotation),
  };
  if (raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low') cab.confidence = raw.confidence;
  if (Array.isArray(raw.uncertainty)) cab.uncertainty = raw.uncertainty.filter((u) => typeof u === 'string');
  return cab;
}
