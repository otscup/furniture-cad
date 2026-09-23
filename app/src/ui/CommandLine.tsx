import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 命令行（CAD 的灵魂之一）
 *
 * 除了键盘效率，它在本项目里还有一个更重要的作用：
 * **演示"UI 与 AI 走同一条写入路径"** —— 以 "{" 开头的内容会被当作一条
 * 完整的 Command JSON 直接送进 CommandBus，与鼠标拖动没有任何区别。
 * 这就是主方案里"四条路同权同位"的可验证形态。
 */

export interface CommandLineProps {
  onCommand: (text: string) => string | null;
  onClose: () => void;
  lastMessage: string;
}

const HELP: Array<[string, string]> = [
  ['L / WALL', '画墙工具（两次点击）'],
  ['CAB', '放柜体工具（点击放置）'],
  ['S / ESC', '回到选择工具 / 取消当前操作'],
  ['M', '移动选中柜体（指定基点 → 第二点）'],
  ['CO', '复制选中柜体'],
  ['RO', '选中柜体旋转 90°'],
  ['E / DEL', '删除选中对象'],
  ['W 2400', '选中柜体宽度设为 2400mm'],
  ['W+100 / W-100', '宽度增减 100mm'],
  ['H 2200 / D 600', '高度 / 深度设为指定值'],
  ['U / REDO', '撤销 / 重做'],
  ['ZE', '缩放到图幅'],
  ['GRID / SNAP / ORTHO', '切换栅格 / 捕捉 / 正交'],
  ['ROOM', '新建 3.2×2.6m 矩形房间'],
  ['{ ... }', '把一段 Command JSON 直接送进 CommandBus（AI 通道演示）'],
];

export function CommandLine(props: CommandLineProps): ReactNode {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = (): void => {
    const raw = text.trim();
    if (!raw) return;
    const err = props.onCommand(raw);
    setMsg(err ?? `已执行：${raw.slice(0, 60)}`);
    setText('');
    if (raw.toUpperCase() === 'HELP' || raw === '?' || raw === '帮助') setShowHelp(true);
  };

  return (
    <div className="cmdline">
      <span className="cmd-prompt">命令:</span>
      <input
        ref={inputRef}
        className="cmd-input"
        value={text}
        placeholder="输入命令后回车（HELP 查看全部）"
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') {
            setText('');
            props.onClose();
          }
        }}
      />
      <span className="cmd-msg">{msg || props.lastMessage}</span>
      <button type="button" className="cmd-help" onClick={() => setShowHelp((s) => !s)}>
        HELP
      </button>
      {showHelp ? (
        <div className="cmd-helpbox">
          <table>
            <tbody>
              {HELP.map(([k, v]) => (
                <tr key={k}>
                  <td className="mono">{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
