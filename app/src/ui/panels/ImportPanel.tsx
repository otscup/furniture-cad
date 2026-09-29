import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Issue } from '../../core/types.ts';
import type { ImportSource } from '../../core/types.ts';
import { ADAPTERS, parseImport } from '../../ai/import/adapters.ts';
import { compileImport } from '../../ai/import/compileImport.ts';
import { importBlocked, validateNormalized, type NormalizedDesign } from '../../ai/import/normalized.ts';
import { commitPlan, dryRunPlan, type PlanRun } from '../../ai/planRunner.ts';
import { compiledRules } from '../../state/memoryStore.ts';
import { PlanRunView } from './PlanRunView.tsx';
import { Pill, Section, Text } from './common.tsx';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  ImportPanel —— 外部设计数据 → 导入（P4）
 *
 *  ── 与 AI 设计通道同一条路 ──
 *    粘贴/上传 → parseImport（适配器）→ NormalizedDesign → validateNormalized
 *    → compileImport（确定性编译成 AiAction[]，注入来源归属）→ dryRunPlan（沙盒）
 *    → 人确认 → commitPlan → CommandBus。
 *    与 AI 通道唯一区别是「设计意图从哪来」：那边是 LLM，这边是适配器。
 *    落到模型这一步**完全相同**，所以 Import 在结构上不可能绕过 Rules / Geometry / 审计。
 *
 *  ── 失败 / 不完整 / 不确定必须写在脸上（不静默）──
 *    · 形状错 → IMPORT-SHAPE，红，不能编译；
 *    · 有不确定项 → IMPORT-UNCERTAINTY，红，阻断；
 *    · 有待确认问题 → IMPORT-OPEN-QUESTIONS，阻断；
 *    · 来源未验证 → IMPORT-UNVERIFIED-CAPABILITY，黄，必须显示；
 *    · 整体低置信度 → IMPORT-LOW-CONFIDENCE，黄，提示逐柜核对。
 *  这些一律在「编译并预览」之前拦住，绝不替用户把估出来的尺寸猜成下料尺寸。
 * ══════════════════════════════════════════════════════════════════════
 */

const SOURCES: ImportSource[] = ['json', 'dxf', 'kujiale', 'imageVision'];

export function ImportPanel(props: {
  bus: CommandBus;
  version: number;
  onToast?: (kind: 'ok' | 'info' | 'warn' | 'error', text: string) => void;
}): ReactNode {
  const { bus } = props;
  const [source, setSource] = useState<ImportSource>('json');
  const [raw, setRaw] = useState('');
  const [fileLabel, setFileLabel] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [nd, setNd] = useState<NormalizedDesign | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [run, setRun] = useState<PlanRun | null>(null);
  const [lastApply, setLastApply] = useState('');
  const [busy, setBusy] = useState(false);

  const onFile = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      setRaw(String(reader.result ?? ''));
      setFileLabel(f.name);
      setNd(null);
      setRun(null);
      setIssues([]);
      setParseErr(null);
      setLastApply('');
    };
    reader.readAsText(f);
  }, []);

  const resetDownstream = useCallback(() => {
    setNd(null);
    setRun(null);
    setIssues([]);
    setParseErr(null);
    setLastApply('');
  }, []);

  const doParse = useCallback(() => {
    resetDownstream();
    try {
      const parsed = parseImport(source, raw, { label: fileLabel ?? undefined });
      setNd(parsed);
      setIssues(validateNormalized(parsed, bus.getState()));
    } catch (err) {
      setParseErr((err as Error).message);
    }
  }, [source, raw, fileLabel, bus, resetDownstream]);

  const doCompile = useCallback(() => {
    if (!nd) return;
    setBusy(true);
    try {
      const compiled = compileImport(nd, bus.getState(), bus.getRules());
      if (!compiled.ok) {
        setIssues(compiled.issues);
        props.onToast?.('warn', compiled.blockedReason ?? '这份导入还不能编译成动作');
        return;
      }
      const g = compiledRules().gate;
      setRun(dryRunPlan({ bus, actions: compiled.actions, gate: g }));
    } finally {
      setBusy(false);
    }
  }, [nd, bus, props]);

  const doApply = useCallback(() => {
    if (!run) return;
    const r = commitPlan(run, bus);
    if (!r.ok) {
      setLastApply(`✗ ${r.error}`);
      props.onToast?.('error', r.error);
      return;
    }
    const msg = `已导入 ${r.applied} 条（跳过 ${r.skipped} 条）· 模型里还有 ${r.blockingErrors} 条 ERROR`;
    setLastApply(msg);
    setRun(null);
    setNd(null);
    setRaw('');
    setFileLabel(null);
    props.onToast?.(r.blockingErrors > 0 ? 'warn' : 'ok', msg);
  }, [run, bus, props]);

  const blocked = nd ? importBlocked(issues) : false;

  return (
    <div className="panel import-panel">
      <Section title="导入外部设计">
        <p className="note">
          外部数据（JSON / DXF / 酷家乐 / 图片识别）经适配器解析成统一的中间表示，
          再走与 AI 设计<b>完全相同</b>的「编译 → 沙盒干跑 → 确认 → 写模型」链路。
          导入不绕过 Semantic Model / Rules / CommandBus，也不会直接变成板件坐标。
        </p>
      </Section>

      {/* 来源选择 */}
      <div className="import-sources">
        {SOURCES.map((s) => {
          const meta = ADAPTERS[s];
          return (
            <button
              key={s}
              type="button"
              className={`import-source ${source === s ? 'on' : ''}`}
              onClick={() => {
                setSource(s);
                resetDownstream();
              }}
            >
              <b>{meta.label}</b>
              {!meta.verified ? <span className="tag tag-warn">待验证</span> : <span className="tag tag-ok">可用</span>}
              <span className="muted-sm">{meta.note}</span>
            </button>
          );
        })}
      </div>

      {/* 输入 */}
      <Section title={`粘贴 ${ADAPTERS[source].label} 数据`}>
        <textarea
          className="import-text"
          value={raw}
          placeholder={
            source === 'json'
              ? '粘贴一个含 cabinets 数组的 JSON（例：{"title":"玄关","cabinets":[{"ref":"shoe","width":900,"height":2400,"depth":350}]}）'
              : source === 'dxf'
                ? '粘贴 DXF 文本（将保守提取块引用，不产坐标，标 low 置信度）'
                : '粘贴结构化结果 JSON（酷家乐草稿 / 图片识别结果）'
          }
          onChange={(e) => setRaw(e.target.value)}
          rows={8}
        />
        <div className="row">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            上传文件
          </button>
          {fileLabel ? <span className="muted-sm">已选：{fileLabel}</span> : null}
          <input ref={fileRef} type="file" accept=".json,.dxf,.txt" style={{ display: 'none' }} onChange={onFile} />
          <button type="button" className="btn btn-primary" disabled={!raw.trim()} onClick={doParse}>
            解析导入
          </button>
        </div>
        {parseErr ? <div className="alert alert-error">{parseErr}</div> : null}
      </Section>

      {/* 归一化结果 + 校验 */}
      {nd ? (
        <Section title={`归一化结果 · ${nd.cabinets.length} 个柜体`}>
          <div className="import-meta">
            <Pill kind="INFO">来源 {nd.source}</Pill>
            {nd.label ? <span className="muted-sm">文件：{nd.label}</span> : null}
            <span className="muted-sm">批次：{nd.batchId}</span>
            {nd.unverifiedCapabilities && nd.unverifiedCapabilities.length > 0 ? (
              <span className="tag tag-warn">未验证能力：{nd.unverifiedCapabilities.join('、')}</span>
            ) : null}
          </div>
          <ul className="import-cab-list">
            {nd.cabinets.map((c, i) => (
              <li key={i} className="import-cab">
                <Text mono>{String(c.ref)}</Text> {c.name ? `「${c.name}」` : ''}
                {c.width || c.height || c.depth ? (
                  <span className="muted-sm"> {[c.width, c.height, c.depth].map((v) => v ?? '—').join('×')}mm</span>
                ) : null}
                {c.confidence ? (
                  <Pill kind={c.confidence === 'low' ? 'WARNING' : c.confidence === 'high' ? 'ok' : 'INFO'}>{c.confidence}</Pill>
                ) : null}
                {c.uncertainty && c.uncertainty.length > 0 ? (
                  <div className="alert alert-warn">不确定：{c.uncertainty.join('；')}</div>
                ) : null}
              </li>
            ))}
          </ul>
          {issues.length > 0 ? (
            <div className="import-issues">
              {issues.map((x, i) => (
                <div
                  key={i}
                  className={`alert ${x.severity === 'ERROR' ? 'alert-error' : x.severity === 'WARNING' ? 'alert-warn' : 'alert-info'}`}
                >
                  <Pill kind={x.severity === 'ERROR' ? 'ERROR' : x.severity === 'WARNING' ? 'WARNING' : 'INFO'}>{x.severity}</Pill>{' '}
                  <Text mono>{x.code}</Text> {x.message}
                </div>
              ))}
            </div>
          ) : (
            <div className="note ok">✓ 形状与来源校验通过</div>
          )}

          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy || blocked} onClick={doCompile}>
              {blocked ? '有拦不住的问题，不能编译' : '编译并预览'}
            </button>
            {blocked ? <span className="muted-sm">红色问题必须先解决（不确定项 / 待确认问题 / 形状错误）</span> : null}
          </div>
        </Section>
      ) : null}

      {/* 预览 = 提交 */}
      {run ? (
        <Section title="预览（与提交完全相同）">
          <PlanRunView
            run={run}
            onApply={doApply}
            onDismiss={() => {
              setRun(null);
            }}
            lastApply={lastApply}
            applyLabel="应用导入"
            dismissLabel="丢弃"
          />
        </Section>
      ) : null}
    </div>
  );
}
