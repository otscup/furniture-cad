import type { VisionInput, VisionProvider, VisionResult } from '../types.ts';

/**
 * MockVisionProvider —— 确定性、无需网络 / key 的视觉识别实现。
 *
 * 用途：
 *   · 验收（verify:vision）用它在无 API key 环境下跑通「图片 → 候选方案 →
 *     确认 → Semantic Model → 2D/3D/DXF/BOM」的完整闭环；
 *   · 离线开发 / 演示；
 *   · 作为「真实 Provider 挂了」时的可回退实现。
 *
 * 它**不是**真去识别图片，而是按 fixture 返回结构化结果。选哪个 fixture 由
 * `input.hint` 里的 `fixture:<name>` 决定（默认 main）。这样同一个 Provider
 * 既能测「正常多柜识别」，也能测「模糊图反问」「有尺寸标注高可信」等分支。
 *
 * 返回的 VisionResult 形状与真实 Provider 完全一致 —— 真实 Provider 只是把
 * 「看一张图」换成模型调用，映射层（visionResultToNormalized）对它俩一视同仁。
 */
export interface MockFixture {
  result: VisionResult;
}

const MAIN: VisionResult = {
  provider: 'mock',
  model: 'mock-fixture-main',
  overallConfidence: 'medium',
  scale: { known: false, confidence: 'low' },
  notes: ['这是一张衣柜墙效果图（无尺寸标注），尺寸为视觉估计'],
  cabinets: [
    {
      ref: 'tall',
      name: '高柜·挂衣',
      width: { value: 600, confidence: 'medium', source: 'estimate' },
      height: { value: 2400, confidence: 'medium', source: 'estimate' },
      depth: { value: 600, confidence: 'low', source: 'estimate' },
      rows: [
        {
          heightMm: 600,
          confidence: 'medium',
          units: [{ kind: 'drawerBank', count: 2, doorCount: 2, confidence: 'medium' }],
        },
        {
          heightMm: 1666,
          confidence: 'medium',
          units: [{ kind: 'hanging', rodHeight: 2000, doorCount: 2, confidence: 'medium' }],
        },
      ],
      components: [
        { type: 'door', location: '整面', confidence: 'medium' },
        { type: 'drawer', location: '上排', confidence: 'medium' },
      ],
      confidence: 'medium',
      notVisible: ['depth', 'board-thickness', 'inner-partitions', 'real-size'],
    },
    {
      ref: 'mid',
      name: '中间·抽屉柜',
      width: { value: 900, confidence: 'medium', source: 'estimate' },
      height: { value: 800, confidence: 'medium', source: 'estimate' },
      depth: { value: 550, confidence: 'low', source: 'estimate' },
      units: [
        { kind: 'drawerBank', count: 3, doorCount: 3, confidence: 'medium' },
        { kind: 'drawerBank', count: 3, doorCount: 3, confidence: 'medium' },
        { kind: 'drawerBank', count: 3, doorCount: 3, confidence: 'medium' },
      ],
      components: [{ type: 'drawer', location: '整排', confidence: 'medium' }],
      confidence: 'medium',
      notVisible: ['depth', 'board-thickness', 'real-size'],
    },
    {
      ref: 'low',
      name: '开放格',
      width: { value: 900, confidence: 'low', source: 'estimate' },
      height: { value: 1000, confidence: 'low', source: 'estimate' },
      depth: { value: 350, confidence: 'low', source: 'estimate' },
      units: [
        { kind: 'shelves', count: 3, doorCount: 0, confidence: 'low' },
        { kind: 'shelves', count: 3, doorCount: 0, confidence: 'low' },
        { kind: 'shelves', count: 3, doorCount: 0, confidence: 'low' },
      ],
      components: [{ type: 'open-shelf', location: '整排', confidence: 'low' }],
      confidence: 'low',
      notVisible: ['depth', 'board-thickness', 'real-size', 'inner-partitions'],
    },
  ],
  relations: [
    { from: 'tall', to: 'mid', kind: 'side-by-side', confidence: 'medium' },
    { from: 'mid', to: 'low', kind: 'side-by-side', confidence: 'medium' },
  ],
};

const ANNOTATED: VisionResult = {
  provider: 'mock',
  model: 'mock-fixture-annotated',
  overallConfidence: 'high',
  scale: { known: true, text: '柜体高 2400', referenceMm: 2400, confidence: 'high' },
  notes: ['图片含尺寸标注「柜体高 2400」'],
  cabinets: [
    {
      ref: 'a',
      name: '标注柜',
      width: { value: 1000, confidence: 'high', source: 'annotation' },
      height: { value: 2400, confidence: 'high', source: 'annotation' },
      depth: { value: 600, confidence: 'low', source: 'estimate' },
      rows: [
        { heightMm: 600, units: [{ kind: 'drawerBank', count: 3, doorCount: 2, confidence: 'high' }], confidence: 'high' },
        { heightMm: 1666, units: [{ kind: 'hanging', rodHeight: 2000, doorCount: 2, confidence: 'high' }], confidence: 'high' },
      ],
      components: [{ type: 'door', location: '整面', confidence: 'high' }],
      confidence: 'high',
      notVisible: ['depth', 'board-thickness'],
    },
  ],
};

const AMBIGUOUS: VisionResult = {
  provider: 'mock',
  model: 'mock-fixture-ambiguous',
  overallConfidence: 'low',
  scale: { known: false, confidence: 'low' },
  cabinets: [],
  ambiguous: [
    '图中柜体数量判断不清（看着像 2 个，也可能是 3 个连在一起）',
    '转角处的连接方式有歧义，无法确定是 L 型还是两个并排',
  ],
  notes: ['模糊 / 遮挡严重的图，模型无法可靠识别'],
};

const FIXTURES: Record<string, VisionResult> = {
  main: MAIN,
  annotated: ANNOTATED,
  ambiguous: AMBIGUOUS,
};

function pickFixture(input: VisionInput): VisionResult {
  const m = /fixture:([a-zA-Z0-9_-]+)/.exec(input.hint ?? '');
  const key = m?.[1] ?? 'main';
  return FIXTURES[key] ?? MAIN;
}

export class MockVisionProvider implements VisionProvider {
  id = 'mock';

  async analyze(input: VisionInput): Promise<VisionResult> {
    // 确定性：不读图片内容，只按 fixture 返回（验收要可复现）
    const base = pickFixture(input);
    // 若用户给了参考尺寸，把它升格成 known scale（演示 hint 的影响，不写真值）
    if (typeof input.knownScaleMm === 'number' && base.scale) {
      return {
        ...base,
        scale: { known: true, referenceMm: input.knownScaleMm, confidence: 'medium', text: `用户提供参考尺寸 ${input.knownScaleMm}mm` },
      };
    }
    return base;
  }
}
