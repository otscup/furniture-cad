import type { ReactNode } from 'react';
import { LAYERS } from '../../viewport/layers.ts';

/** 图层面板：只切换"派生视图的可见性"，不改模型 */
export function LayersPanel(props: {
  hiddenLayers: Set<string>;
  toggle: (name: string) => void;
  setAll: (hidden: boolean) => void;
}): ReactNode {
  const groups = new Map<string, typeof LAYERS>();
  for (const l of LAYERS) {
    const arr = groups.get(l.group) ?? [];
    arr.push(l);
    groups.set(l.group, arr);
  }

  return (
    <div className="panel-scroll">
      <div className="btn-row tight">
        <button type="button" className="btn btn-xs" onClick={() => props.setAll(false)}>
          全显
        </button>
        <button type="button" className="btn btn-xs" onClick={() => props.setAll(true)}>
          全隐
        </button>
      </div>

      {[...groups.entries()].map(([group, list]) => (
        <div key={group} className="lyr-group">
          <div className="lyr-group-title">{group}</div>
          {list.map((l) => {
            const on = !props.hiddenLayers.has(l.name);
            return (
              <label key={l.name} className={`lyr-row ${on ? '' : 'off'}`}>
                <input type="checkbox" checked={on} onChange={() => props.toggle(l.name)} />
                <span className="lyr-swatch" style={{ background: l.color }} />
                <span className="lyr-label">{l.label}</span>
                <span className="lyr-name mono">{l.name}</span>
              </label>
            );
          })}
        </div>
      ))}
      <div className="hint-line">图层只决定"看得见什么"，它不参与模型、不参与生产数据。</div>
    </div>
  );
}
