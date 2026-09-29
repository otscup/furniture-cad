import type { ImportSource } from '../../core/types.ts';
import { nextId } from '../../core/ids.ts';
import type { NormalizedDesign, NormalizedCabinet } from './normalized.ts';

/**
 * DXF 适配器 —— P4 仅做「边界占位 + 保守意图提取」，**不产板件坐标**。
 *
 * 真实「DXF 几何 → 语义柜体」的可靠识别是 P5 的活。这里只做一件确定性的事：
 * 从 DXF 文本里数 INSERT 实体（块引用，通常一个块 = 一个柜体实例），
 * 把每个块投影成一个 NormalizedCabinet —— 但：
 *   · **不把 DXF 的 x / y 当落位**（DXF 坐标是几何，落位是系统定的事）；
 *   · 块若不携带可解析尺寸，宽高深留空（走规则集默认），并标 uncertainty；
 *   · 整体 confidence='low'，unverifiedCapabilities 列出真正要做的识别；
 *   · 形状门仍由 validateNormalized → proposalShapeError 把守。
 *
 * 这是「诚实的弱解析」：它真的读了 DXF，但把「我不确定」写在脸上，不假装成功。
 * 验收断言据此校验：产物不携带落位坐标、confidence=low、unverifiedCapabilities 非空。
 */
export interface DxfImportOptions {
  label?: string;
  batchId?: string;
}

export function parseDxfImport(rawText: string, opts: DxfImportOptions = {}): NormalizedDesign {
  const source: ImportSource = 'dxf';
  const batchId = opts.batchId ?? nextId('import', []);
  const inserts = extractInserts(rawText);
  const cabinets: NormalizedCabinet[] = inserts.map((ins, i) => {
    const ref = ins.name ? `dxf_${ins.name}` : `dxf_${i + 1}`;
    const cab: NormalizedCabinet = {
      ref,
      name: ins.name ? `DXF·${ins.name}` : `DXF柜${i + 1}`,
      // 注意：ins.x / ins.y 是 DXF 几何坐标，**不进落位**（落位由系统定）
      width: ins.w ?? null,
      height: ins.h ?? null,
      depth: null,
      confidence: 'low',
      uncertainty: [
        'DXF 仅提取到块引用，未识别内部结构与板厚；宽高深按块尺寸估算（不可靠）',
        'DXF 原始坐标未用作落位，将由系统在房间内自动找位',
      ],
    };
    return cab;
  });
  return {
    title: 'DXF 导入',
    summary: `从 DXF 提取到 ${inserts.length} 个块引用（保守意图提取，非几何识别）`,
    source,
    label: opts.label,
    batchId,
    cabinets,
    unverifiedCapabilities: ['dxf-block-recognition', 'dxf-dimension-text', 'dxf-internal-structure'],
    assumptions: ['DXF 几何→语义柜体的可靠识别是 P5 能力，P4 仅预留边界'],
  };
}

interface InsertRef {
  name: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

/** 最小启发式：从 DXF 文本里抽 INSERT 实体（名字 + 坐标 + 可选的 xscale/yscale 当尺寸） */
function extractInserts(text: string): InsertRef[] {
  const out: InsertRef[] = [];
  const parts = text.split(/^\s*0\s*\n\s*INSERT\s*$/gim);
  // parts[0] 是第一个 INSERT 之前的头部，跳过
  for (let i = 1; i < parts.length; i++) {
    const b = parts[i] ?? '';
    const name = groupText(b, 2) ?? `blk${i}`;
    const x = groupNum(b, 10);
    const y = groupNum(b, 20);
    const xs = groupNum(b, 41); // X 比例（AutoCAD 块缩放）
    const ys = groupNum(b, 43); // Y 比例
    out.push({
      name,
      x,
      y,
      w: xs && xs > 0 ? Math.round(xs * 1000) : undefined,
      h: ys && ys > 0 ? Math.round(ys * 1000) : undefined,
    });
  }
  return out;
}

function groupText(block: string, code: number): string | undefined {
  const m = block.match(new RegExp(`\\n${code}\\n([^\\n]+)`));
  return m ? m[1].trim() : undefined;
}
function groupNum(block: string, code: number): number | undefined {
  const m = block.match(new RegExp(`\\n${code}\\n([-\\d.]+)`));
  return m ? Number(m[1]) : undefined;
}
