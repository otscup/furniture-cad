import type { VisionInput, VisionProvider, VisionResult } from '../types.ts';

/**
 * RemoteVisionProvider —— 走「服务端 AI 网关」的真实视觉识别实现。
 *
 * 解耦要点：
 *   · **不在这里硬编码任何厂商名 / 模型名 / API 形态**。它只调本应用的
 *     `/api/ai/vision` 路由，该路由复用 server.mjs 既有的 AI 网关配置
 *     （`env.AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`，与 /api/ai/chat|plan|design
 *     同一套），换服务商 = 在管理后台填 baseUrl，不改代码、不重启。
 *   · 服务端把图（data URL）连同「请返回 VisionResult JSON」的指令发给
 *     OpenAI 兼容的 `/chat/completions`（带 image_url 内容块）。任何支持
 *     vision 的兼容端点（OpenAI / Gemini / Claude / 本地模型 / 网关）都能直接接。
 *   · 本实现**只做识别，不碰几何、不写模型**—— 拿到 VisionResult 后，剩下的
 *     映射 / 校验 / 预览 / 确认 / CommandBus 全部走 P4 统一链路。
 *
 * 离线 / 无 key 时不要用它（会连不上）：验收与离线演示用 MockVisionProvider。
 */
export interface RemoteVisionProviderOptions {
  /** 默认 '/api/ai/vision'（同源） */
  endpoint?: string;
  /** 登录 token（local-open 模式留空） */
  token?: string | null;
  /** 默认模型（不填用服务端 env.AI_MODEL） */
  model?: string;
}

export class RemoteVisionProvider implements VisionProvider {
  id = 'remote';
  private endpoint: string;
  private token: string | null;
  private model?: string;

  constructor(opts: RemoteVisionProviderOptions = {}) {
    this.endpoint = opts.endpoint ?? '/api/ai/vision';
    this.token = opts.token ?? null;
    this.model = opts.model;
  }

  async analyze(input: VisionInput): Promise<VisionResult> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          image: input.image,
          mime: input.mime,
          filename: input.filename,
          hint: input.hint,
          knownScaleMm: input.knownScaleMm,
          model: input.model ?? this.model,
        }),
      });
    } catch (e) {
      throw new Error(`连不上视觉识别服务：${(e as Error).message}（请确认 npm run server 在跑）`);
    }
    let body: Record<string, unknown>;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`视觉识别服务返回了非 JSON（HTTP ${res.status}）`);
    }
    if (!body.ok) {
      const err = String(body.error ?? `视觉识别失败（HTTP ${res.status}）`);
      // 把模型原文（若有）也带上，方便人直接看模型说了什么
      const raw = typeof body.raw === 'string' && body.raw ? `　模型原文：${body.raw.slice(0, 300)}` : '';
      throw new Error(err + raw);
    }
    const result = body.result as VisionResult | undefined;
    if (!result || !Array.isArray(result.cabinets)) {
      throw new Error('视觉识别服务返回的结果形状不对（缺少 cabinets 数组）');
    }
    return result;
  }
}
