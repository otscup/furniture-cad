import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import { VIEW_KINDS, VIEW_NAME, VIEW_NOTE } from '../../core/geometry/views.ts';
import { EXPLODE_LANE_STEP, EXPLODE_TIER_BASE } from '../../core/geometry/assembly.ts';
import { Pill, Row, Section, Text } from './common.tsx';

/**
 * 视图面板 —— 把「四视图是怎么来的、哪里是假设」摆在界面上。
 *
 * 这一栏存在的理由：
 *  1. 视图不是画出来的，是**投影派生**的；用户有权知道派生规则
 *  2. 没有工艺依据的地方（踢脚取向、挂衣杆进深、层板与门板的越界…）
 *     必须显式列出，而不是悄悄画进图里
 *  3. 分解图（爆炸图）是**可选的生产图**，它"与开料清单一一对应"
 *     这件事必须能在界面上核对，而不是靠信任
 */
export function ViewsPanel(props: {
  bus: CommandBus;
  version: number;
  mode: 'plan' | 'sheet' | '3d';
  setMode: (m: 'plan' | 'sheet' | '3d') => void;
  explode: boolean;
  setExplode: (v: boolean) => void;
}): ReactNode {
  const geom = props.bus.derive().geom;
  const vs = geom.views;
  const cabs = props.bus.getState().cabinets;
  const first = cabs.length > 0 ? vs.placements[cabs[0].id] : undefined;
  const ex = props.explode ? props.bus.deriveExplode(true) : null;

  return (
    <div className="panel-scroll">
      <Section title="视图模式">
        <div className="btn-row">
          <button
            type="button"
            className={`tb-btn ${props.mode === 'plan' ? 'active' : ''}`}
            onClick={() => props.setMode('plan')}
          >
            平面图（可编辑）
          </button>
          <button
            type="button"
            className={`tb-btn ${props.mode === 'sheet' ? 'active' : ''}`}
            onClick={() => props.setMode('sheet')}
          >
            ▤ 四视图图幅
          </button>
        </div>
        <div className="hint-line">
          四视图是<strong>只读派生视图</strong>：它和平面图来自同一份语义模型、同一次派生。要改尺寸请回平面图。
        </div>
      </Section>

      <Section title={`四视图（${cabs.length} 个柜体）`}>
        {cabs.length === 0 ? (
          <div className="hint-line">项目里还没有柜体，先在平面图里放一个。</div>
        ) : (
          <>
            <Row label="柜体">
              <Text strong>{cabs.length === 1 ? cabs[0].name : `${cabs.length} 个（图幅内左右并排）`}</Text>
            </Row>
            <Row label="图幅原点">
              <Text mono>
                {first ? `x=${Math.round(first.x)} y=${Math.round(first.y)}` : '—'}
              </Text>
            </Row>
            <div className="view-list">
              {VIEW_KINDS.map((k) => (
                <div key={k} className="view-item">
                  <div className="view-item-head">
                    <b>{VIEW_NAME[k]}</b>
                    <Pill kind="muted">投影</Pill>
                  </div>
                  <div className="view-item-note">{VIEW_NOTE[k]}</div>
                </div>
              ))}
            </div>
            <div className="hint-line">
              排布依据：第一角投影（GB / ISO-E）。俯视图置于正视图正下方 → <b>长对正</b>；侧视图置于正视图正右方 →{' '}
              <b>高平齐</b>；俯视图进深跨度 = 侧视图进深跨度 = 柜深 → <b>宽相等</b>。三条都是结构性的映射不变量，
              由 <Text mono>verify/views-acceptance.ts</Text> 逐条断言（含 6 个负样本）。
            </div>
          </>
        )}
      </Section>

      <Section title="分解图（爆炸图）" defaultOpen={props.explode}>
        <div className="btn-row">
          <button
            type="button"
            className={`tb-btn ${props.explode ? 'active' : ''}`}
            onClick={() => props.setExplode(!props.explode)}
          >
            {props.explode ? '✓ 已开启（点击关闭）' : '开启分解图'}
          </button>
        </div>
        <div className="hint-line">
          分解图是<strong>可选的生产图</strong>：四视图调整好之后再开。它按开料清单<b>逐件</b>把板件摆开（轴测投影 30°），
          件号与明细栏和清单一一对应。关闭时<strong>连装配数据都不会算</strong>，零开销。
        </div>
        {ex && ex.enabled ? (
          <>
            <Row label="柜体 / 板件">
              <Text mono>
                {ex.check.cabinets} 个 / 清单 {ex.check.panelKinds} 种 {ex.check.pieces} 件
              </Text>
            </Row>
            <Row label="图上摆出">
              <Text mono>
                {ex.check.instances} 件 / {ex.check.drawnNos} 个件号
              </Text>
            </Row>
            <Row label="与清单核对">
              {ex.check.ok ? (
                <Pill kind="ok">件数一一对应</Pill>
              ) : (
                <Pill kind="ERROR">
                  对不上{ex.check.unplaced.length > 0 ? `：${ex.check.unplaced.join('、')} 摆不出来` : ''}
                </Pill>
              )}
            </Row>
            {ex.check.mismatches > 0 ? (
              <Row label="已知差异">
                <Pill kind="WARNING">{ex.check.mismatches} 块裁切进深 ≠ 落位进深（depth 语义待确认）</Pill>
              </Row>
            ) : null}
            <Row label="图幅大小">
              <Text mono>
                {ex.bbox
                  ? `${Math.round(ex.bbox.max.x - ex.bbox.min.x)} × ${Math.round(ex.bbox.max.y - ex.bbox.min.y)} mm`
                  : '—'}
              </Text>
            </Row>
            <div className="hint-line">
              爆炸位移：{EXPLODE_TIER_BASE.map((v, i) => `第${i + 1}层 ${v}`).join(' / ')} mm，层内多件同向按{' '}
              {EXPLODE_LANE_STEP}mm 递增错开。<b>位移量只是图面表达</b>，没有工艺含义，不要当成装配顺序或拆卸行程。
            </div>
            <div className="hint-line">
              逐条断言见 <Text mono>verify/assembly-acceptance.ts</Text>（含负样本：故意让图上少一件、让件号重复、
              让气泡压在一起，都必须被检出）。
            </div>
          </>
        ) : (
          <div className="hint-line">当前关闭 —— 图幅上不会出现分解图。</div>
        )}
      </Section>

      <Section title={`图元统计`}>
        <Row label="视图图元合计">
          <Text mono>{vs.prims.length}</Text>
        </Row>
        <Row label="投影衔接线">
          <Text mono>{vs.prims.filter((p) => p.layer === 'F-VIEW').length} 条（长对正 2 · 高平齐 2 · 宽相等 2）</Text>
        </Row>
        <Row label="标题与标注">
          <Text mono>{vs.prims.filter((p) => p.layer === 'F-DIM' || p.layer === 'F-TEXT').length}</Text>
        </Row>
        <Row label="图幅包围盒">
          <Text mono>
            {vs.bbox
              ? `${Math.round(vs.bbox.min.x)},${Math.round(vs.bbox.min.y)} → ${Math.round(vs.bbox.max.x)},${Math.round(vs.bbox.max.y)}`
              : '—'}
          </Text>
        </Row>
      </Section>

      <Section title={`派生假设（${vs.assumptions.length} 条）`} defaultOpen={vs.assumptions.length > 0}>
        {vs.assumptions.length === 0 ? (
          <div className="hint-line">暂无假设。</div>
        ) : (
          <ol className="assume-list">
            {vs.assumptions.map((a, i) => (
              <li key={i} className={a.startsWith('⚠') ? 'assume-warn' : ''}>
                {a}
              </li>
            ))}
          </ol>
        )}
        <div className="hint-line">
          这些是<b>没有工艺依据、为出图必须选定</b>的取向。换工厂时它们应该随规则集一起被替换，而不是留在代码里。
        </div>
      </Section>
    </div>
  );
}
