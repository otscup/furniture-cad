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
  const sum = requested.reduce((a, b) => a + b, 0);
  if (sum <= 0) return requested.map(() => 0);

  const raw = requested.map((r) => (total * r) / sum);
  const out = raw.map((v) => Math.floor(v));

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

/** 沿高度方向等分点（用于层板定位）：返回 count 个"距底部的高度"。 */
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
