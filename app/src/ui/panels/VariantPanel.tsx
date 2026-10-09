import { useState } from 'react';
import type { ReactNode } from 'react';

import type { BBox, Prim, Vec2 } from '../../core/types.ts';
import type { Command, CommandBus } from '../../core/commandBus.ts';
import * as CMD from '../../core/commands.ts';
import {
  PLACEMENT_BLOCKING_CODES,
  adoptVariant,
  buildVariants,
  noPresetReason,
  placeVariant,
  topIssue,
} from '../../core/variants.ts';
import type { VariantDraft, VariantSpec } from '../../core/variants.ts';
import { Section, Row, Text, NumField, Pill } from './common.tsx';
import type { ToastKind } from '../types.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  方案对比 —— 「先出正面图 → 出几种风格 → 选完再出四视图」
 *
 *  ── 本面板显示的每一张正面图都是**派生视图**，只用于对比 ──
 *    它背后是一份候选语义模型；点「采用」才是把那份候选变成模型。
 *    顺序不能倒过来：从正面图反推参数是做不到的 —— 正面图里没有进深，
 *    600 从哪来没有答案。见 docs/Design-Local-Pick-Edit-and-Staged-Generation.md §3.2
 *
 *  ── 每份候选都带着自己的 problem list ──
 *    这是这个流程最有价值的地方：**客户选风格的时候就看得见门板超宽**，
 *    而不是选完、改完、出了四视图才发现。
 *
 *  ── 一份都不能静默 ──
 *    · 规则集没配 stylePresets  → 如实说"这个工厂没配风格"，不编一套出来
 *    · 某份候选派生失败        → 告警样式显示原因，不显示"没问题"
 * ══════════════════════════════════════════════════════════════════════
 */

export interface VariantPanelProps {
  bus: CommandBus;
  version: number;
  run: (cmd: Command) => boolean;
  onToast: (kind: ToastKind, text: string) => void;
  /** 采用成功后回调（用于把界面切到四视图 / 选中新柜体） */
  onAdopted?: (cabinetId: string) => void;
  readOnly?: boolean;
}

/** 缩略图取景留白（mm）—— 图框外留一点，避免最外轮廓贴边被裁 */
const PAD = 60;

/**
 * 正视图缩略图。
 *
 * ── 为什么这里有一段自己的 SVG ──
 *   主渲染器画的是"一个相机 + 一个场景"（平面图 / 四视图图幅），
 *   而方案对比要的是 N 个**各自独立取景**的小图幅 —— 它们尺度不同、坐标原点不同，
 *   塞进同一个相机反而不对。所以这里另写一段极简的投影。
 *
 * ── 但它不是"第二个几何来源" ──
 *   画的是 `prims.front`，也就是 `buildCabinetViews()` 的**同一份产物**，
 *   主渲染器画四视图时用的也是它。几何仍然只有一个来源。
 *
 * ── 一处必须处理的细节：Y 轴 ──
 *   CAD 里 +Y 向上，SVG 里 +Y 向下。整块内容套一层 `scale(1,-1)` 即可；
 *   文字要再翻回来，否则是镜像的。
 */
function FrontThumb(props: { prims: Prim[]; box: BBox | null }): ReactNode {
  const { prims, box } = props;
  if (!box || prims.length === 0) {
    return <div className="vthumb vthumb-empty">（没有可显示的正视图）</div>;
  }
  const minX = box.min.x - PAD;
  const minY = box.min.y - PAD;
  const w = box.max.x - box.min.x + PAD * 2;
  const h = box.max.y - box.min.y + PAD * 2;
  // viewBox 的 y 取负区间，配合 scale(1,-1) 让内容可以直接用真实坐标
  const viewBox = `${minX} ${-(minY + h)} ${w} ${h}`;

  const pts = (a: Vec2[]): string => a.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <svg className="vthumb" viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label="方案正视图缩略图">
      <g transform="scale(1,-1)">
        {prims.map((pr, i) => {
          if (pr.k === 'poly') {
            return (
              <polyline
                key={i}
                points={pts(pr.pts)}
                fill="none"
                stroke={strokeOf(pr.layer)}
                strokeWidth={pr.lw * 1.6}
                strokeDasharray={pr.dash ? pr.dash.join(' ') : undefined}
              />
            );
          }
          if (pr.k === 'fill') {
            return <polygon key={i} points={pts(pr.pts)} fill={fillOf(pr.layer)} stroke="none" />;
          }
          return (
            <text
              key={i}
              transform={`translate(${pr.p.x},${pr.p.y}) scale(1,-1)`}
              fontSize={pr.size}
              fill={strokeOf(pr.layer)}
              textAnchor={pr.align === 'c' ? 'middle' : pr.align === 'r' ? 'end' : 'start'}
            >
              {pr.text}
            </text>
          );
        })}
      </g>
    </svg>
  );
}

/** 图层 → 颜色。只做"看得出结构层次"这一件事，不追求与出图一致（那是 CTB/STB 的活） */
function strokeOf(layer: string): string {
  if (layer.startsWith('F-VIEW')) return '#94a3b8';
  if (layer.includes('HIDDEN')) return '#cbd5e1';
  if (layer.startsWith('PANEL')) return '#334155';
  return '#0f172a';
}
function fillOf(layer: string): string {
  if (layer.startsWith('PANEL')) return '#e2e8f0';
  return '#f1f5f9';
}

export function VariantPanel(props: VariantPanelProps): ReactNode {
  const { bus, run, onToast, onAdopted } = props;
  const project = bus.getState();
  const rules = bus.getRules();
  const presets = rules.stylePresets ?? [];

  const [name, setName] = useState('主卧衣柜');
  const [width, setWidth] = useState(2400);
  const [height, setHeight] = useState(2400);
  const [depth, setDepth] = useState(600);
  const [roomId, setRoomId] = useState(project.rooms[0]?.id ?? '');
  const [drafts, setDrafts] = useState<VariantDraft[] | null>(null);

  /**
   * 规格变了就把已生成的候选作废。
   * 为什么不是"自动重算"：候选是**一次对比**的产物，
   * 静默跟着输入框变会让"我刚才看的是哪一份"这件事说不清 ——
   * 与其自动变，不如显式失效并让人再点一次。
   */
  const invalidate = (): void => setDrafts(null);

  const generate = (): void => {
    if (props.readOnly) return;
    if (!roomId) {
      onToast('warn', '项目里还没有房间，先建一个房间再生成方案');
      return;
    }
    const spec: VariantSpec = { name, width, height, depth, roomId };
    const next = buildVariants(spec, rules);
    setDrafts(next);
    if (next.length === 0) {
      onToast('warn', noPresetReason(rules));
    } else {
      onToast('ok', `已生成 ${next.length} 份候选方案（正面图对比）`);
    }
  };

  /**
   * 「放得下吗」用 CommandBus 的干跑去问，而不是自己算 AABB。
   * 干跑会连记忆门一起过，所以"贴墙放会不会被你上次说的话拦住"在采用前就有答案。
   */
  const adopt = (d: VariantDraft): void => {
    if (props.readOnly) return;
    const base = adoptVariant(d, bus.getState());
    const placed = placeVariant(base, bus.getState(), (trial) => {
      const r = bus.execute(CMD.createCabinet(trial), { dryRun: true });
      if (!r.ok) return false;
      return !r.newIssues.some((i) => i.severity === 'ERROR' && PLACEMENT_BLOCKING_CODES.has(i.code));
    });
    if (!placed) {
      onToast(
        'error',
        `「${d.nameZh}」在房间里放不下：沿每一面墙都试过，全都撞墙或撞到已有的柜体。先把柜体挪开，或改小宽度再生成。`
      );
      return;
    }
    const cab = placed.cabinet;
    const okRun = run(CMD.createCabinet(cab));
    if (!okRun) {
      onToast('error', `采用失败：「${d.nameZh}」没有被接受`);
      return;
    }
    onToast(
      'ok',
      `已采用「${d.nameZh}」→ ${cab.name}（${cab.params.width}×${cab.params.height}×${cab.params.depth}）` +
        (placed.wallName ? `，贴「${placed.wallName}」放置` : '') +
        '。四视图已从它派生。'
    );
    onAdopted?.(cab.id);
  };

  const countOf = (d: VariantDraft, sev: 'ERROR' | 'WARNING'): number => d.issues.filter((i) => i.severity === sev).length;

  /** 规格摘要 —— 让人确认"我生成的是不是这个尺寸" */
  const specText = `${width} × ${height} × ${depth}`;

  return (
    <div className="panel-scroll">
      {presets.length === 0 ? (
        <div className="banner">
          <b>{noPresetReason(rules)}</b>
        </div>
      ) : null}

      <Section title="规格">
        <Row label="名称">
          <input className="input" value={name} onChange={(e) => { setName(e.target.value); invalidate(); }} />
        </Row>
        <Row label="宽 W" hint="柜体总宽">
          <NumField value={width} min={300} max={6000} suffix="mm" onCommit={(v) => { setWidth(v); invalidate(); }} />
        </Row>
        <Row label="高 H">
          <NumField value={height} min={300} max={4000} suffix="mm" onCommit={(v) => { setHeight(v); invalidate(); }} />
        </Row>
        <Row label="深 D" hint="含门板厚">
          <NumField value={depth} min={200} max={1200} suffix="mm" onCommit={(v) => { setDepth(v); invalidate(); }} />
        </Row>
        <Row label="房间">
          <select className="input" value={roomId} onChange={(e) => { setRoomId(e.target.value); invalidate(); }}>
            {project.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Row>
        <div className="vgen">
          <button type="button" className="tb-btn primary" disabled={props.readOnly || presets.length === 0} onClick={generate}>
            生成方案对比
          </button>
          <span className="ts">{specText}</span>
        </div>
      </Section>

      <Section
        title={drafts ? `候选方案（${drafts.length}）· 正面图对比` : '候选方案（尚未生成）'}
        defaultOpen={drafts !== null}
      >
        {drafts === null ? (
          <div className="ts">填好规格后点「生成方案对比」。每一份给出的是<b>候选语义方案</b>，正面图只是它的对比视图。</div>
        ) : drafts.length === 0 ? (
          <div className="ts">{noPresetReason(rules)}</div>
        ) : (
          drafts.map((d) => {
            const top = topIssue(d);
            return (
              <div className="vcard" key={d.id}>
                <div className="vcard-head">
                  <b>{d.nameZh}</b>
                  {d.error ? <Pill kind="ERROR">派生失败</Pill> : top ? <Pill kind={top.severity}>{top.severity === 'ERROR' ? '有 ERROR' : '有 WARNING'}</Pill> : <Pill kind="ok">无问题</Pill>}
                </div>

                <FrontThumb prims={d.front} box={d.frontBox} />

                <div className="ts">{d.summary}</div>
                {d.note ? <div className="ts vnote">{d.note}</div> : null}

                <div className="vstats">
                  <span>板件 {d.stats.pieces} 件 / {d.stats.panelKinds} 类</span>
                  <span>{d.stats.boardAreaM2.toFixed(2)} m²</span>
                  <span>约 {d.stats.estWeightKg.toFixed(0)} kg</span>
                </div>

                {d.error ? <div className="verr">派生失败：{d.error}</div> : null}

                {top ? (
                  <div className={`vissue vissue-${top.severity.toLowerCase()}`}>
                    {top.severity === 'ERROR' ? '✗ ' : '⚠ '}
                    {top.message}
                    {top.fixHint ? `　建议：${top.fixHint}` : ''}
                    {d.issues.length > 1 ? `　（另有 ${d.issues.length - 1} 条）` : ''}
                  </div>
                ) : (
                  <div className="ts">校验通过：ERROR {countOf(d, 'ERROR')} · WARNING {countOf(d, 'WARNING')}</div>
                )}

                <button type="button" className="tb-btn" disabled={props.readOnly} onClick={() => adopt(d)}>
                  采用这个方案
                </button>
              </div>
            );
          })
        )}
      </Section>

      <Section title="这个流程是怎么走的" defaultOpen={false}>
        <div className="ts">
          1. 填规格 → 生成 <b>N 份候选语义方案</b>（每份是一个完整的柜体模型）。
        </div>
        <div className="ts">
          2. 每份各自派生出<b>正视图</b>，并排对比 —— 图上看到的就是它们各自的正面。
        </div>
        <div className="ts">
          3. 每份都带着自己的<b>校验结果</b>，所以选的时候就能看到"门板超宽"这类问题。
        </div>
        <div className="ts">
          4. 点「采用」→ 那份候选<b>成为模型</b>（走和鼠标放柜体完全相同的那条写入路径）。
        </div>
        <div className="ts">
          5. 四视图<b>从落地后的模型派生</b>，长对正 / 高平齐 / 宽相等是结构性保证。
        </div>
        <div className="ts vnote">
          <b>为什么不是"从正面图生成四视图"</b>：正面图里只有宽和高，没有进深。
          从它反推侧视图和俯视图只能靠猜 —— 而猜出来的东西对不上正面图。
          所以中间产物是方案，不是图；界面上你看到的仍然是"先看正面图"。
        </div>
        <div className="ts vnote">
          <b>已知边界</b>：柜体分区目前只有左右并排（<Text mono>layout.type = 'row'</Text>），
          所以「上下分段」这种水平分隔现在表达不出来。预设里没有假装有这一项。
        </div>
      </Section>
    </div>
  );
}
