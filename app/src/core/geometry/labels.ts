import type { Prim, Vec2 } from '../types.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  文字尺寸与标签避让 —— 四视图（views.ts）与分解图（explode.ts）共用
 *
 *  为什么这一套必须放在核心几何层、而且只有一份实现：
 *    · 它跑在 Node 里（verify/*.ts 直接 import），没有 canvas 的 measureText；
 *    · "标签不许互相压住"是**生成图元时**就要定下来的事 —— 等渲染器发现
 *      已经来不及了，渲染器没有权限去挪模型层给出的坐标；
 *    · 如果两个视图各写一套避让，就会出现"四视图好好的、分解图压成一团"
 *      这种没人负责的差异。
 * ══════════════════════════════════════════════════════════════════════
 */

export type Align = 'l' | 'c' | 'r';

/**
 * 文字宽度估算。
 *
 * 模型：全角（CJK / 全角标点）1.0 em，其余 0.62 em，再乘 1.06 的保守系数。
 * 保守方向是刻意的：宁可多让出一点空白，也不要让"估算刚好相等、
 * 真实字体却多出两毫米"变成线上压字。
 * 浏览器验收另有断言用**渲染器同款字体**的 measureText 复核，那是独立的第二道关。
 */
const FULLWIDTH = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

export function estimateTextWidth(s: string, size: number): number {
  let em = 0;
  for (const ch of s) em += FULLWIDTH.test(ch) ? 1 : 0.62;
  return em * size * 1.06;
}

export interface LabelBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  text: string;
}

export function labelBox(x: number, y: number, s: string, size: number, align: Align, rot = 0): LabelBox {
  const w = estimateTextWidth(s, size);
  const h = size * 1.2;
  // rot = 90 → 渲染器 rotate(-90°)：文字沿屏幕**向上**走，长边变成竖直方向
  if (rot === 90 || rot === -90) {
    return { x0: x - h / 2, x1: x + h / 2, y0: y - w / 2, y1: y + w / 2, text: s };
  }
  const x0 = align === 'l' ? x : align === 'r' ? x - w : x - w / 2;
  return { x0, x1: x0 + w, y0: y - h / 2, y1: y + h / 2, text: s };
}

export function boxOverlap(a: LabelBox, b: LabelBox, margin: number): boolean {
  return a.x0 < b.x1 + margin && a.x1 + margin > b.x0 && a.y0 < b.y1 + margin && a.y1 + margin > b.y0;
}

/**
 * 图元在纸面上**真正占到的范围**：文字要按字宽/字高算，图形仍按顶点算。
 *
 * 为什么必须和"顶点范围"分开：
 *   整幅图的 bbox 只有一个用途 —— "缩放到图幅"时该把镜头对准多大一块。
 *   对准的范围必须包含文字的真实外沿，否则图幅刚好铺满视口时，
 *   越出锚点的那几个字就被画布边缘切掉了（实测越界过 847mm）。
 *   而**视图级** bbox 的语义是"这个视图的原点范围"，投影不变量依赖它，
 *   两者混用会把一整套断言的含意悄悄换掉。
 */
export function primVisualExtent(p: Prim): Vec2[] {
  if (p.k !== 'text') return p.pts;
  const w = estimateTextWidth(p.text, p.size);
  const h = p.size * 1.2;
  if (p.rot === 90 || p.rot === -90) {
    return [
      { x: p.p.x - h / 2, y: p.p.y - w / 2 },
      { x: p.p.x + h / 2, y: p.p.y + w / 2 },
    ];
  }
  const x0 = p.align === 'l' ? p.p.x : p.align === 'r' ? p.p.x - w : p.p.x - w / 2;
  return [
    { x: x0, y: p.p.y - h / 2 },
    { x: x0 + w, y: p.p.y + h / 2 },
  ];
}

/**
 * 贪心避让：按调用顺序（= 优先级）放标签，每个尽量待在它"应该"在的位置，
 * 撞上了就一档一档让开。
 *
 * 为什么是确定性的贪心而不是"手工微调坐标"：
 *   手工调好的坐标在下一个标签加进来时就全废了，而且没人知道为什么是 −320。
 *   贪心算法让"标签不压字"变成一条**随标签数量增长仍然成立**的性质。
 *   顺序确定 + 起点确定 ⇒ 结果逐字节可复现（F 组断言确定性那一组会盯住它）。
 */
export class LabelPlacer {
  private placed: LabelBox[] = [];
  /** 让不开、只能留在原地的标签（正常应为空；验收会检查） */
  readonly unfitted: string[] = [];
  /**
   * 标签之间强制保留的最小间隙（mm）。
   * 注意不能写成 `constructor(private readonly margin = ...)` ——
   * Node 直接跑 .ts 时用的是 strip-only 模式，**不支持参数属性**，
   * 那种写法会让 `node verify/views-acceptance.ts` 当场语法报错。
   */
  private readonly margin: number;

  constructor(margin = 18) {
    this.margin = margin;
  }

  /**
   * 占位但不动：给那些位置已经由别处决定（尺寸链）的文字登记包围盒，
   * 让后面的标签知道这里已经有人了。
   */
  reserve(x: number, y: number, s: string, size: number, align: Align, rot = 0): void {
    this.placed.push(labelBox(x, y, s, size, align, rot));
  }

  /** 直接登记一个任意尺寸的占据框（气泡件号那种不是文字的占位） */
  reserveBox(x0: number, x1: number, y0: number, y1: number, text = ''): void {
    this.placed.push({ x0, x1, y0, y1, text });
  }

  /** 某点周围是否已经放了东西 */
  isFree(x0: number, x1: number, y0: number, y1: number): boolean {
    const box: LabelBox = { x0, x1, y0, y1, text: '' };
    return !this.placed.some((b) => boxOverlap(b, box, this.margin));
  }

  /**
   * 返回该标签最终应放置的 y。
   * `lo` / `hi` 是该视图局部坐标下**锚点**的允许范围：标签只能在这个视图里让路，
   * 不能被让到视图外面去 —— 否则"内部图与正视图同高"这条不变量当场就破了。
   */
  fit(x: number, y: number, s: string, size: number, align: Align, rot = 0, lo = -Infinity, hi = Infinity): number {
    const step = Math.max(40, size * 0.95);
    const offsets: number[] = [0];
    // 先向上让（板件名习惯压在板件上方），再向下；两侧各给 8 档
    for (let k = 1; k <= 8; k++) offsets.push(-k, k);
    for (const k of offsets) {
      const ny = y + k * step;
      if (ny < lo || ny > hi) continue;
      const box = labelBox(x, ny, s, size, align, rot);
      if (!this.placed.some((b) => boxOverlap(b, box, this.margin))) {
        this.placed.push(box);
        return ny;
      }
    }
    this.placed.push(labelBox(x, y, s, size, align, rot));
    this.unfitted.push(s);
    return y;
  }

  /**
   * 二维让位（分解图的件号气泡用）。
   *
   * 与 fit 的区别：气泡是**独立的小圆标**，可以让到任意方向，
   * 而且分解图没有"视图上下边界"这种约束 —— 让位范围由调用方给。
   *
   * ⚠ 调用方**不要**把被标注的图形本体登记进来。气泡按制图惯例本来就压在
   *   零件上（白底 + 圈保证可读），只有"气泡压气泡"才需要让位。
   *   实测教训：把每个零件的包围盒都 reserve 进去之后，26 个气泡**全部**让不开 ——
   *   因为轴测投影下零件的包围盒互相重叠，任何位置都"有人"。
   *
   * 搜索顺序由距离与固定角度序列生成（不用随机数），因此结果可复现。
   */
  fitXY(
    x: number,
    y: number,
    halfW: number,
    halfH: number,
    label: string,
    bounds?: { x0: number; x1: number; y0: number; y1: number }
  ): Vec2 {
    const step = Math.max(halfW, halfH) * 2.2;
    const dirs = 12;
    const rings = 4;
    const tries: Array<[number, number]> = [[0, 0]];
    for (let r = 1; r <= rings; r++) {
      for (let i = 0; i < dirs; i++) {
        const a = (i / dirs) * Math.PI * 2;
        tries.push([Math.cos(a) * r, Math.sin(a) * r]);
      }
    }
    for (const [ux, uy] of tries) {
      const nx = x + ux * step;
      const ny = y + uy * step;
      if (bounds && (nx - halfW < bounds.x0 || nx + halfW > bounds.x1 || ny - halfH < bounds.y0 || ny + halfH > bounds.y1)) continue;
      if (this.isFree(nx - halfW, nx + halfW, ny - halfH, ny + halfH)) {
        this.reserveBox(nx - halfW, nx + halfW, ny - halfH, ny + halfH, label);
        return { x: nx, y: ny };
      }
    }
    this.unfitted.push(label);
    return { x, y };
  }
}
