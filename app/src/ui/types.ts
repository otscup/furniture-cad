export type Tool = 'select' | 'wall' | 'cabinet' | 'line' | 'polyline' | 'text' | 'dimension' | 'leader';

export interface ToolDef {
  id: Tool;
  label: string;
  shortcut: string;
  hint: string;
}

export const TOOLS: ToolDef[] = [
  { id: 'select', label: '选择', shortcut: 'Esc', hint: '点选 / 框选 / 拖柜体移动 / 拖夹点改尺寸' },
  { id: 'wall', label: '画墙', shortcut: 'L', hint: '两次点击画一段墙（中心线）' },
  { id: 'cabinet', label: '放柜体', shortcut: 'CAB', hint: '点击放置一个标准柜体' },
  { id: 'line', label: '画线', shortcut: 'LI', hint: '两点绘制独立二维线，不改柜体参数' },
  { id: 'polyline', label: '多段线', shortcut: 'PL', hint: '连续点绘制多段线，双击结束' },
  { id: 'text', label: '文字', shortcut: 'T', hint: '点击指定文字位置并输入内容' },
  { id: 'dimension', label: '尺寸', shortcut: 'DIM', hint: '点选两端点添加独立尺寸标注' },
  { id: 'leader', label: '引线', shortcut: 'LE', hint: '点目标和文字位置，添加引线注释' },
];

export type ToastKind = 'ok' | 'info' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

let toastSeq = 0;
export function nextToastId(): number {
  return ++toastSeq;
}
