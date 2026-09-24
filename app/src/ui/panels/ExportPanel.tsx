import { useState } from 'react';
import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { ToastKind } from '../types.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  导出：DXF 图纸 + 开料单
 *
 *  ── 这个面板只做"把当前模型交给后端"，不做任何几何计算 ──
 *
 *  模型 100% 归 CommandBus，这里只把 `bus.getState()` 整个 project 发过去；
 *  几何由后端从语义模型重算（见 server/server.mjs 的 /api/export/*）。
 *  如果这里改成"先把图元算好再上传"，就等于让浏览器成为几何的第二个来源，
 *  "图 = 料" 这条线会当场断掉。
 *
 *  ── 为什么导出前必须先摆出问题 ──
 *    一张"看起来没问题"的图纸比一张报错的图纸危险得多：
 *    它会一路走到开料才被人发现。所以有 ERROR 时，这个面板先把话说清楚，
 *    而不是让人高高兴兴导出一份错图。
 *
 *  ── MVP 只出 DXF，不出 DWG ──
 *    DWG 涉及 ODA 授权，商业级无 Web/SaaS 使用权（见主方案红线）。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface ExportPanelProps {
  bus: CommandBus;
  version: number;
  token: string | null;
  onToast: (kind: ToastKind, msg: string) => void;
}

/** 从 Content-Disposition 里取文件名（RFC 5987 的 filename*=UTF-8''… 优先） */
function fileNameOf(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const m = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* 编码坏了就退回 ASCII 名，不要因此让整个下载失败 */
    }
  }
  const m2 = /filename="([^"]+)"/i.exec(header);
  return m2 ? m2[1] : fallback;
}

export function ExportPanel(props: ExportPanelProps): ReactNode {
  const { bus, version, token, onToast } = props;
  const [plan, setPlan] = useState(true);
  const [sheet, setSheet] = useState(true);
  const [dxfVersion, setDxfVersion] = useState<'R2007' | 'R2000'>('R2007');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string>('');

  const issues = bus.issues();
  const errors = issues.filter((i) => i.severity === 'ERROR');
  const warnings = issues.filter((i) => i.severity === 'WARNING');

  async function post(kind: 'dxf' | 'cutlist'): Promise<void> {
    if (busy) return;
    setBusy(true);
    setLast('');
    try {
      const res = await fetch(`/api/export/${kind}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          project: bus.getState(),
          which: [plan ? 'plan' : null, sheet ? 'sheet' : null].filter(Boolean),
          version: dxfVersion,
          modelVersion: `v${version}`,
        }),
      });
      if (!res.ok) {
        const t = await res.text();
        let why = t;
        try {
          why = JSON.parse(t)?.error ?? t;
        } catch {
          /* 不是 JSON 就原样显示 */
        }
        onToast('error', `导出失败：${why}`);
        return;
      }
      const blob = await res.blob();
      const name = fileNameOf(res.headers.get('Content-Disposition'), kind === 'dxf' ? 'export.dxf' : 'cutlist.csv');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setLast(`${name}（${Math.round(blob.size / 1024)} KB）`);
      onToast('ok', `已导出 ${name}`);
    } catch (e) {
      onToast('error', `导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel-scroll">
      {errors.length > 0 ? (
        <div className="vissue vissue-error">
          ✗ 当前模型还有 {errors.length} 条 ERROR。可以先导出，但这份图纸会带着这些问题走到开料 ——
          <b>建议先到「问题」页签处理掉。</b>
          <div className="ts">第一条：{errors[0].message}</div>
        </div>
      ) : (
        <div className="ts">
          校验通过：ERROR 0{warnings.length > 0 ? ` · WARNING ${warnings.length}` : ''}。
        </div>
      )}

      <div className="exp-group">
        <div className="exp-title">图纸内容</div>
        <label className="exp-check">
          <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
          平面布置图（房间 + 墙体 + 柜体落位）
        </label>
        <label className="exp-check">
          <input type="checkbox" checked={sheet} onChange={(e) => setSheet(e.target.checked)} />
          四视图图幅（正视 / 侧视 / 俯视 / 内部）
        </label>
        {!plan && !sheet ? <div className="verr">至少选一张图，否则导出的文件是空的。</div> : null}
      </div>

      <div className="exp-group">
        <div className="exp-title">DXF 版本</div>
        <select className="input" value={dxfVersion} onChange={(e) => setDxfVersion(e.target.value as 'R2007' | 'R2000')}>
          <option value="R2007">R2007（原生 UTF-8，中文零转义）—— 主交付</option>
          <option value="R2000">R2000（GBK，给老版本 / 部分国产 CAD 作兼容备用）</option>
        </select>
        <div className="ts vnote">
          模型空间保持 1:1，不缩放、不画图框 —— 打印比例交给图纸空间（视口比例），缩放模型是出图事故的头号来源。
        </div>
      </div>

      <div className="exp-group">
        <button type="button" className="tb-btn primary" disabled={busy || (!plan && !sheet)} onClick={() => void post('dxf')}>
          {busy ? '正在导出…' : '导出 DXF 图纸'}
        </button>
        <button type="button" className="tb-btn" disabled={busy} onClick={() => void post('cutlist')}>
          {busy ? '正在生成…' : '导出开料单 CSV'}
        </button>
      </div>

      {last ? <div className="ts">上次导出：{last}</div> : null}

      <div className="exp-group">
        <div className="ts vnote">
          导出的是<b>当前模型 v{version}</b>。文件里自带「模型版本 + 生成器版本 + 规则集版本」三件套，
          任何一次交付都能完整复现。
        </div>
        <div className="ts vnote">MVP 阶段只输出 DXF。DWG 涉及 ODA 授权，商业级不含 Web/SaaS 使用权。</div>
      </div>
    </div>
  );
}
