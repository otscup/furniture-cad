import type { ImportSource } from '../../core/types.ts';
import { nextId } from '../../core/ids.ts';
import type { NormalizedDesign } from './normalized.ts';
import { arrOrNull, isPlainObject, numOrU, strOrNull } from './normalized.ts';

/**
 * 酷家乐适配器 —— **P4 仅预留边界，不强行接入 API**（用户明确要求）。
 *
 * 酷家乐的真实接入需要：① 私有格式 / 导出结构解析；② 鉴权与 API。
 * 这两件在 P4 都标记为「待验证能力」：本适配器不假装能解析酷家乐数据，
 * 只把「边界」画对——接收调用方传入的、已经整理成 NormalizedDesign
 * （或极简柜体数组）的草稿，并明确标出未验证能力；若传入数据不符合
 * 已知形状，则返回一个带 OPEN-QUESTIONS 的占位，逼用户改用 JSON 或提供草稿。
 *
 * 关键：它**不静默成功**——要么收下已结构化的结果（标 unverified），
 * 要么反问（标 OPEN-QUESTIONS），绝不给「我解析了酷家乐」的假象。
 */
export interface KujialeImportOptions {
  label?: string;
  batchId?: string;
}

export function parseKujialeImport(payload: unknown, opts: KujialeImportOptions = {}): NormalizedDesign {
  const source: ImportSource = 'kujiale';
  const batchId = opts.batchId ?? nextId('import', []);
  // 仅当调用方已经把酷家乐数据整理成合法柜体数组 / NormalizedDesign 形状时才收下
  if (isPlainObject(payload) && Array.isArray(payload.cabinets) && payload.cabinets.length > 0) {
    const raw = payload as Record<string, unknown>;
    return {
      title: typeof raw.title === 'string' ? raw.title : '酷家乐导入',
      summary: strOrNull(raw.summary),
      source,
      label: opts.label,
      batchId,
      room: strOrNull(raw.room),
      cabinets: (raw.cabinets as unknown[]).map((c, i) => {
        const o = isPlainObject(c) ? (c as Record<string, unknown>) : {};
        const ref = typeof o.ref === 'string' && o.ref ? o.ref : `kj_${i + 1}`;
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
          confidence: 'low',
          uncertainty: ['酷家乐适配器在 P4 仅预留边界，未经真实格式/API 验证'],
        };
      }),
      assumptions: arrOrNull(raw.assumptions),
      unverifiedCapabilities: ['kujiale-format-parsing', 'kujiale-auth-api'],
    };
  }
  // 否则：诚实反问，不假装解析
  return {
    title: '酷家乐导入（边界占位）',
    summary: '酷家乐适配器在 P4 仅预留边界，未接入真实格式/鉴权/API',
    source,
    label: opts.label,
    batchId,
    cabinets: [],
    questions: ['酷家乐的真实数据接入（私有格式解析 / 鉴权 / API）在 P4 尚未实现。请提供已经整理成柜体数组的草稿，或先用 JSON 适配器导入。'],
    unverifiedCapabilities: ['kujiale-format-parsing', 'kujiale-auth-api'],
  };
}
