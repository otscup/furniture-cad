/**
 * 相机调试出口 —— 仅供验收探针读取，不是 UI 状态，不参与任何渲染管线。
 *
 * ── 为什么需要它 ──
 *   图幅（sheet）模式按设计不显示 X/Y 坐标读数（B20 有断言：图幅是"看图"模式，
 *   读数属于编辑模式），因此浏览器探针无法在图幅内用 HUD 两点反解做相机标定。
 *   同时切到图幅必然触发一次重新取景（fit 到四图幅总 bbox）——
 *   平面图标定的相机带不过去（B26 三连失败的真实根因：探针假设
 *   "相机跨模式共享、切模式不动相机"，实际 sheet 一进来就 fit）。
 *
 *   出路：产品代码把真实相机同步到这个模块级单例，探针 import 后用
 *   camera.ts 的 worldToScreen 自行换算 —— 读的是真实相机，不是另一份近似。
 *
 * ── 边界 ──
 *   只读出口：App/Viewport 只写这里，业务代码永远不读这里；
 *   探针也只读不写。它不能成为第二真相源 —— 模型/几何与它无关。
 */
import type { Camera } from './camera.ts';

export const camDebug: { cam: Camera | null; vw: number; vh: number } = {
  cam: null,
  vw: 0,
  vh: 0,
};
