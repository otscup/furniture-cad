/**
 * 尺寸分配与余量归属 —— 这是拆板里最容易出错、也最容易被忽略的部分。
 *
 * 所有返回值都是整数毫米，且保证 Σ返回值 === 输入总量（不丢一毫米，也不多一毫米）。
 * 详细说明见 docs/Phase0-Spike-Report.md「余量归属」一节。
 */

export type RemainderPolicy = 'bottom' | 'top' | 'distribute';

/**
 * 按期望值比例分配总尺寸（用于 layout.widthMode = "fit_total"）。
 * 用户说的是"总宽 2400，左 600 中 1200 右 600"，但 600+1200+600 是三个净宽，
 * 没算两侧板与两块立板的厚度 —— 真实可用净宽只有 2328。
 * 本函数按比例把差额摊掉，并把"期望 vs 实际"的差异交给调用方报 INFO。
 */
export function allocateWidths(total: number, requested: number[]): number[] {
  const n = requested.length;
  if (n === 0) return [];
  // 总净宽为负/零（柜子比排里分区还窄）：放不下，全 0，交给校验器报"装不下"
  if (total <= 0) return new Array(n).fill(0);

  /**
   * 语义修正（一次真缺陷）：
   *   旧实现 `if (sum <= 0) return 全 0` —— 当所有分区**都没给宽**（AI 只说
   *   "岛台带镂空"、省略了背面排宽）时，requested 全是 0，于是背面排净宽全 0，
   *   宽度链恒等式 `t + Σ后排净宽 + … = width` 左=36、右=2200 直接崩，
   *   柜体被严格模式拒掉，"AI 建不出岛台"。
   *   正确语义：**未指定宽（0 / 非有限）应当等分总净宽**，明确指定的才按比例。
   *   这里把 0 / NaN 当"未指定"处理，不再当"明确要 0 宽"。
   */
  const specs = requested.map((r) => (Number.isFinite(Number(r)) && Number(r) > 0 ? Number(r) : 0));
  const specifiedSum = specs.reduce((a, b) => a + b, 0);

  let out: number[];
  if (specifiedSum === 0) {
    // 全部未指定 → 等分（整数化，余量按索引顺序补 1mm，保证 Σ ≡ total）
    const base = Math.floor(total / n);
    out = new Array(n).fill(base);
    let rem = total - base * n;
    for (let i = 0; rem > 0; i = (i + 1) % n, rem--) out[i] += 1;
  } else {
    const raw = specs.map((r) => (total * r) / specifiedSum);
    out = raw.map((v) => Math.floor(v));

    let remainder = total - out.reduce((a, b) => a + b, 0);
    // 按小数部分从大到小补 1mm，保证总和精确
    const order = raw
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac);
    let k = 0;
    while (remainder > 0 && order.length > 0) {
      out[order[k % order.length].i] += 1;
      remainder -= 1;
      k += 1;
    }
  }
  return out;
}

/**
 * 等分：把 total 均分成 count 份，扣掉 gapTotal 的缝隙。
 * 除不尽时的余量按 policy 归属（默认加到最下面一份）。
 * 真实工厂里"余量归谁"必须写死在规则里，否则每台柜子差 1~2mm，装不上。
 */
export function splitEqual(
  total: number,
  count: number,
  gapTotal: number,
  policy: RemainderPolicy = 'bottom'
): number[] {
  if (count <= 0) return [];
  const available = total - gapTotal;
  const base = Math.floor(available / count);
  const remainder = available - base * count;
  const out = new Array<number>(count).fill(base);
  if (remainder === 0) return out;

  if (policy === 'bottom') {
    out[0] += remainder; // 索引 0 = 最下面一份
  } else if (policy === 'top') {
    out[count - 1] += remainder;
  } else {
    for (let i = 0; i < remainder; i++) out[i % count] += 1;
  }
  return out;
}

/**
 * 沿高度方向等分点（用于层板定位）：返回 count 个"距底部的高度"。
 *
 * ⚠️ 分类（P7.2 架构审查）：这是**几何辅助算法**——生成器/视图/3D 用它把层板摆到这些
 * 高度，制造层也用它**读取已派生的层板标高事实**。它**不是制造规则**；制造规则（如层板
 * 托孔的孔型参数）是另一回事。任何"这是工厂工艺规则"的归因都是误读。
 */
export function equalSpacing(total: number, count: number): number[] {
  if (count <= 0) return [];
  const step = total / (count + 1);
  const out: number[] = [];
  for (let i = 1; i <= count; i++) out.push(Math.round(step * i));
  return out;
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
