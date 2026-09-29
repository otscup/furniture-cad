import type { ImportSource } from '../../core/types.ts';
import { parseJsonImport } from './jsonAdapter.ts';
import { parseDxfImport } from './dxfAdapter.ts';
import { parseKujialeImport } from './kujialeAdapter.ts';
import { parseImageVisionImport } from './imageVisionAdapter.ts';
import type { NormalizedDesign } from './normalized.ts';

/**
 * 适配器索引 —— UI / 自动化统一入口。
 *
 * 每个来源一行元信息：deterministic（解析是否确定性、无需 LLM/API key）、
 * verified（真实能力是否在本环境验证过）。P4 只有 json 是真正跑通的；
 * dxf / kujiale / imageVision 仅边界占位，verified=false，由 IMPORT-UNVERIFIED-CAPABILITY
 * 在导入时把"未验证"写在脸上，不静默假装成功。
 */
export interface AdapterMeta {
  source: ImportSource;
  label: string;
  /** 解析是否确定性、纯客户端、不需要 LLM / key */
  deterministic: boolean;
  /** 真实解析能力是否已在本环境验证（false = 仅边界占位，待 P5+） */
  verified: boolean;
  note: string;
}

export const ADAPTERS: Record<ImportSource, AdapterMeta> = {
  json: { source: 'json', label: 'JSON 柜体清单', deterministic: true, verified: true, note: '确定性解析，可跑通示例' },
  dxf: { source: 'dxf', label: 'DXF（保守意图提取）', deterministic: true, verified: false, note: '仅提取块引用，不产坐标；几何识别待 P5' },
  kujiale: { source: 'kujiale', label: '酷家乐（边界占位）', deterministic: true, verified: false, note: 'P4 仅预留边界，不接入真实 API' },
  imageVision: { source: 'imageVision', label: '图片识别（收 Vision 结果）', deterministic: true, verified: false, note: 'P4 仅接收结构化结果，视觉识别待 P5' },
};

export interface ParseImportOptions {
  label?: string;
  batchId?: string;
}

export function parseImport(source: ImportSource, raw: string | unknown, opts: ParseImportOptions = {}): NormalizedDesign {
  switch (source) {
    case 'json':
      return parseJsonImport(typeof raw === 'string' ? raw : JSON.stringify(raw), opts);
    case 'dxf':
      return parseDxfImport(typeof raw === 'string' ? raw : String(raw), opts);
    case 'kujiale':
      return parseKujialeImport(raw, opts);
    case 'imageVision':
      return parseImageVisionImport(raw, opts);
    default:
      throw new Error(`未知导入来源：${String(source)}`);
  }
}

export { parseJsonImport } from './jsonAdapter.ts';
export { parseDxfImport } from './dxfAdapter.ts';
export { parseKujialeImport } from './kujialeAdapter.ts';
export { parseImageVisionImport } from './imageVisionAdapter.ts';
export { validateNormalized, importBlocked, normalizedToProposal } from './normalized.ts';
export type { NormalizedDesign, NormalizedCabinet } from './normalized.ts';
