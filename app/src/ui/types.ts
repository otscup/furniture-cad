export type Tool = 'select' | 'wall' | 'cabinet';

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
