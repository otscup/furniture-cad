/**
 * Manufacturing 层对外出口（P7）。
 * 单一收口：derive + bridge + 类型 + 默认规则。
 */
export * from './model.ts';
export * from './rules.ts';
export { deriveManufacturing } from './derive.ts';
export {
  bomFromManufacturing,
  manufacturingToPanels,
  manufacturingToNeutralExport,
  manufacturingToNeutralExportDefault,
  type BomRow,
} from './bridge.ts';
