import type { BBox, Vec2 } from '../core/types.ts';

/**
 * 相机 —— 世界坐标(mm, Y 向上) ↔ 屏幕坐标(px, Y 向下)
 *
 * 关键约定：模型空间永远 1:1（世界坐标就是毫米，绝不缩放模型）。
 * 缩放只发生在"相机"这一个地方，出图时由图纸空间处理。
 * 这样任何一次缩放都不会改变任何生产尺寸。
 */
export interface Camera {
  /** 视口中心对应的世界坐标 */
  cx: number;
  cy: number;
  /** 每毫米对应多少屏幕像素 */
  scale: number;
}

export const MIN_SCALE = 0.002;
export const MAX_SCALE = 8;

export const clampScale = (s: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

export function worldToScreen(p: Vec2, cam: Camera, vw: number, vh: number): Vec2 {
  return { x: vw / 2 + (p.x - cam.cx) * cam.scale, y: vh / 2 - (p.y - cam.cy) * cam.scale };
}

export function screenToWorld(p: Vec2, cam: Camera, vw: number, vh: number): Vec2 {
  return { x: cam.cx + (p.x - vw / 2) / cam.scale, y: cam.cy - (p.y - vh / 2) / cam.scale };
}

/** 以屏幕上某点为锚点缩放（滚轮缩放时鼠标下的世界点保持不动） */
export function zoomAt(cam: Camera, factor: number, anchorScreen: Vec2, vw: number, vh: number): Camera {
  const before = screenToWorld(anchorScreen, cam, vw, vh);
  const next: Camera = { ...cam, scale: clampScale(cam.scale * factor) };
  const after = screenToWorld(anchorScreen, next, vw, vh);
  return { cx: next.cx + (before.x - after.x), cy: next.cy + (before.y - after.y), scale: next.scale };
}

/** 按住中键/空格拖动时平移：屏幕位移 → 世界位移 */
export function panByScreen(cam: Camera, dxScreen: number, dyScreen: number): Camera {
  return { ...cam, cx: cam.cx - dxScreen / cam.scale, cy: cam.cy + dyScreen / cam.scale };
}

export function fitBBox(b: BBox | null, vw: number, vh: number, padPx = 48): Camera {
  if (!b) return { cx: 0, cy: 0, scale: 0.2 };
  const w = Math.max(b.max.x - b.min.x, 100);
  const h = Math.max(b.max.y - b.min.y, 100);
  const scale = clampScale(Math.min((vw - 2 * padPx) / w, (vh - 2 * padPx) / h));
  return { cx: (b.min.x + b.max.x) / 2, cy: (b.min.y + b.max.y) / 2, scale };
}

const GRID_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];

/** 自适应网格步长：目标屏幕上每格 ≥ minPx */
export function niceGridStep(scale: number, minPx = 14): number {
  for (const s of GRID_STEPS) {
    if (s * scale >= minPx) return s;
  }
  return GRID_STEPS[GRID_STEPS.length - 1];
}

/** 屏幕像素容差 → 世界毫米容差 */
export function pxToWorld(px: number, scale: number): number {
  return px / scale;
}

/** 世界显示精度：小于 10mm 时显示一位小数 */
export function fmtMm(v: number): string {
  return Math.abs(v) < 0.05 ? '0' : Math.abs(v) < 10 && !Number.isInteger(v) ? v.toFixed(1) : String(Math.round(v));
}
