import type { Prim, Project } from '../core/types.ts';
import { deriveDoorSwing } from '../core/spatial/index.ts';

/**
 * 门扇开启范围 → 2D 图元（P8.9）。
 *
 * ── 为什么单独一个文件、而不是写在 Viewport.tsx 里 ──
 *   ① 它是**纯函数**（project → Prim[]），与 React 无关，放这里能被验收脚本
 *      直接 import 断言"图上的扇形 === 校验用的扇形"（Viewport.tsx 是 JSX，
 *      node 跑不了，只能扫源码 —— 那验不出"同源"这件事）。
 *   ② 渲染器只负责画：包络怎么算、算出来是不是 unknown，全在空间层说了算。
 *      界面**不许自己再画一条弧** —— 一旦两处各画一份，
 *      "图上没撞、报告说撞了"这种最让人不信任软件的情况就会出现。
 *
 * unknown（没指定铰链/方向、房间不闭合、洞口非法…）**不画**：
 * 没判出来就不假装有范围，界面照实显示"未指定"。
 */
export function doorSwingPrimsOf(project: Project): Prim[] {
  const { doors } = deriveDoorSwing(project);
  const out: Prim[] = [];
  for (const d of doors) {
    const env = d.envelope;
    if (d.status !== 'ok' || !env) continue;
    out.push({ k: 'fill', pts: env.poly, layer: 'A-DOOR-SWING', alpha: 0.1 });
    out.push({ k: 'poly', pts: [...env.poly, env.poly[0]!], closed: false, layer: 'A-DOOR-SWING', lw: 1.2, dash: [160, 70] });
  }
  return out;
}
