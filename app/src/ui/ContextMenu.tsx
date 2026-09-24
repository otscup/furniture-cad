import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  右键上下文菜单（Task #24）
 *
 *  ── 纯视图组件：不认识模型 ──
 *   菜单长什么样、有哪些项，全部由 App 按「当前选中了什么」算好传进来。
 *   这里只负责：定位、贴边、关闭时机、把点击转回 onClose+onSelect。
 *   它不 import bus —— 菜单里不可能藏着一条绕过 CommandBus 的写路径。
 *
 *  ── 关闭时机（CAD 的手感）──
 *   · 点菜单项 → 执行 + 关
 *   · 点菜单外任意处 → 关（pointerdown 捕获阶段，先于其它逻辑）
 *   · Esc → 关
 *   · 窗口尺寸变化 / 失焦 → 关（位置已经没有意义了）
 *   再次右键时 App 直接 setState 换位置 —— 菜单跟着光标走，不闪一次空白。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface CtxItem {
  key: string;
  label: string;
  /** 快捷键提示（只展示，不负责绑定） */
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  /** key 以 sep 开头的分隔项不需要它 */
  onSelect?: () => void;
}

export function ContextMenu(props: { x: number; y: number; items: CtxItem[]; onClose: () => void }): ReactNode {
  const { x, y, items, onClose } = props;
  const ref = useRef<HTMLDivElement>(null);
  /** 贴边修正量：先渲染到光标处，量出真实尺寸后把越界部分推回屏内 */
  const [shift, setShift] = useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = Math.max(0, x + r.width + 8 - window.innerWidth);
    const dy = Math.max(0, y + r.height + 8 - window.innerHeight);
    setShift((s) => (s.dx === dx && s.dy === dy ? s : { dx, dy }));
  }, [x, y, items.length]);

  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const onOther = (): void => onClose();
    // capture：菜单外的任何按下（包括另一处右键）都先收掉菜单
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', onOther);
    window.addEventListener('blur', onOther);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', onOther);
      window.removeEventListener('blur', onOther);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: x - shift.dx, top: y - shift.dy }}
      // 菜单上右键不许弹浏览器自己的菜单，也不许冒泡去重新定位
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it) =>
        it.key.startsWith('sep') ? (
          <div key={it.key} className="ctx-sep" />
        ) : (
          <button
            key={it.key}
            type="button"
            className={`ctx-item${it.danger ? ' ctx-danger' : ''}`}
            disabled={it.disabled}
            title={it.hint ? `${it.label}（${it.hint}）` : undefined}
            onClick={() => {
              onClose();
              it.onSelect?.();
            }}
          >
            <span className="ctx-label">{it.label}</span>
            {it.hint ? <kbd>{it.hint}</kbd> : null}
          </button>
        )
      )}
    </div>
  );
}
