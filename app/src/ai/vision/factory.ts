import type { NormalizedDesign } from '../import/normalized.ts';
import { MockVisionProvider } from './providers/mock.ts';
import { RemoteVisionProvider, type RemoteVisionProviderOptions } from './providers/remote.ts';
import type { VisionInput, VisionProvider, VisionResult } from './types.ts';
import { visionResultToNormalized, type VisionToNormalizedOptions } from './visionResultToNormalized.ts';

/**
 * VisionProvider 工厂 —— 让「换服务商」成为配置，而非改 core。
 *
 *   · 'mock'   → MockVisionProvider（验收 / 离线 / 回退，确定性、无网络）
 *   · 'remote' → RemoteVisionProvider（走服务端 AI 网关 /api/ai/vision，复用
 *                server.mjs 既有的 baseUrl/apiKey/model 配置，不硬编码厂商）
 *
 * 真实环境里应用默认用 'remote'；测试与离线演示用 'mock'。新增一家服务商 =
 * 写一个新的 VisionProvider 实现并在这里登记，Semantic Model / Geometry / Rules
 * 一行都不用动。
 */
export type VisionProviderKind = 'mock' | 'remote';

export function createVisionProvider(kind: VisionProviderKind, opts?: RemoteVisionProviderOptions): VisionProvider {
  if (kind === 'mock') return new MockVisionProvider();
  return new RemoteVisionProvider(opts ?? {});
}

/** 应用默认拿到的 Provider（真实视觉识别走服务端网关） */
export function defaultVisionProvider(opts?: RemoteVisionProviderOptions): VisionProvider {
  return createVisionProvider('remote', opts);
}

/**
 * 一条龙：识别一张图 → 诚实映射成 NormalizedDesign。
 * 不直接写模型、不碰几何—— 返回的仍是 NormalizedDesign，交由 P4 统一链路
 * （validateNormalized → compileImport → 预览 → 确认 → CommandBus）处理。
 */
export async function analyzeImageToNormalized(
  provider: VisionProvider,
  input: VisionInput,
  opts: VisionToNormalizedOptions = {},
): Promise<{ result: VisionResult; design: NormalizedDesign }> {
  const result = await provider.analyze(input);
  const design = visionResultToNormalized(result, opts);
  return { result, design };
}
