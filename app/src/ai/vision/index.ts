/**
 * Vision 层统一出口（P5）。
 *
 * 设计约束（与 core 解耦）：
 *   · VisionProvider 只识别、不写模型、不碰几何；
 *   · 识别结果经 visionResultToNormalized 诚实映射成 NormalizedDesign；
 *   · 之后完全复用 P4 的 Import 链路（compileImport → dryRunPlan → 预览 → commitPlan）。
 */
export type {
  Confidence,
  DimSource,
  VisionCabinet,
  VisionComponent,
  VisionComponentType,
  VisionDim,
  VisionInput,
  VisionProvider,
  VisionRelation,
  VisionRelationKind,
  VisionResult,
  VisionRow,
  VisionScale,
  VisionUnit,
  NotVisibleReason,
} from './types.ts';
export { MockVisionProvider } from './providers/mock.ts';
export { RemoteVisionProvider, type RemoteVisionProviderOptions } from './providers/remote.ts';
export { visionResultToNormalized, type VisionToNormalizedOptions } from './visionResultToNormalized.ts';
export {
  analyzeImageToNormalized,
  createVisionProvider,
  defaultVisionProvider,
  type VisionProviderKind,
} from './factory.ts';
