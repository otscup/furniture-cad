import { useCallback, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import type { Issue } from '../../core/types.ts';
import type { ImportSource } from '../../core/types.ts';
import { ADAPTERS, parseImport } from '../../ai/import/adapters.ts';
import { compileImport } from '../../ai/import/compileImport.ts';
import { importBlocked, validateNormalized, type NormalizedDesign } from '../../ai/import/normalized.ts';
import { analyzeImageToNormalized, MockVisionProvider, RemoteVisionProvider, type VisionInput } from '../../ai/vision/index.ts';
import { loadToken } from '../../ai/aiClient.ts';
import { commitPlan, dryRunPlan, type PlanRun } from '../../ai/planRunner.ts';
import { compiledRules } from '../../state/memoryStore.ts';
import { PlanRunView } from './PlanRunView.tsx';
import { Pill, Section, Text } from './common.tsx';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  ImportPanel —— 外部设计数据 → 导入（P4 骨架 + P5 图片识别）
 *
 *  ── 与 AI 设计通道同一条路 ──
 *    粘贴/上传 → 解析/识别 → NormalizedDesign → validateNormalized
 *    → compileImport → dryRunPlan（沙盒）→ 人确认 → commitPlan → CommandBus。
 *    JSON / DXF / 酷家乐走 parseImport；图片走 VisionProvider → 诚实映射
 *    （visionResultToNormalized），两路最后都汇到同一个写入口。
 *
 *  ── 图片识别的人机协作闭环（P5）──
 *    选「图片识别」→ 上传图（或点「示例图（离线 Mock）」）→ VisionProvider
 *    识别 → 候选方案（柜体数 / rows / units / 组件 / 组合关系 + 估计尺寸）
 *    → 图片看不见的生产结构（真实深度 / 板厚 / 隐藏隔板 / 真实尺寸）作为
 *    **caveats** 列在预览里，需用户逐项「已知晓」后才允许生成 → 确认落模型。
 *    Vision 不编造看不见的结构；确认后这些项随 Cabinet.origin 留痕审计。
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
  const [imgData, setImgData] = useState<string | null>(null);
  const [imgMime, setImgMime] = useState<string | undefined>(undefined);
  const [hintText, setHintText] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [nd, setNd] = useState<NormalizedDesign | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [visionErr, setVisionErr] = useState<string | null>(null);
  const [run, setRun] = useState<PlanRun | null>(null);
  const [lastApply, setLastApply] = useState('');
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState(false);

  const remoteProvider = useMemo(() => new RemoteVisionProvider({ token: loadToken() }), []);

  const resetDownstream = useCallback(() => {
    setNd(null);
    setRun(null);
    setIssues([]);
    setParseErr(null);
    setVisionErr(null);
    setLastApply('');
    setAck(false);
  }, []);

  const onFile = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (source === 'imageVision') {
      const reader = new FileReader();
      reader.onload = () => {
        setImgData(String(reader.result ?? ''));
        setImgMime(f.type || undefined);
        setFileLabel(f.name);
        resetDownstream();
      };
      reader.readAsDataURL(f);
    } else {
      const reader = new FileReader();
      reader.onload = () => {
        setRaw(String(reader.result ?? ''));
        setFileLabel(f.name);
        resetDownstream();
      };
      reader.readAsText(f);
    }
  }, [source, resetDownstream]);

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

  const runVision = useCallback(async (useMock: boolean) => {
    if (!useMock && !imgData) {
      setVisionErr('请先选择一张图片');
      return;
    }
    setVisionErr(null);
    setBusy(true);
    try {
      const provider = useMock ? new MockVisionProvider() : remoteProvider;
      const input: VisionInput = {
        image: useMock ? 'mock://example' : (imgData as string),
        mime: imgMime,
        filename: fileLabel ?? undefined,
        hint: hintText.trim() || (useMock ? 'fixture:main' : undefined),
      };
      const { design } = await analyzeImageToNormalized(provider, input, {
        label: fileLabel ?? (useMock ? '示例图（离线 Mock）' : undefined),
      });
      setNd(design);
      setIssues(validateNormalized(design, bus.getState()));
      setAck(false);
    } catch (err) {
      setVisionErr((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [imgData, imgMime, fileLabel, hintText, remoteProvider]);

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
    setImgData(null);
    setFileLabel(null);
    setHintText('');
    props.onToast?.(r.blockingErrors > 0 ? 'warn' : 'ok', msg);
  }, [run, bus, props]);

  const blocked = nd ? importBlocked(issues) : false;
  // 图片识别的诚实项：有 caveats 且未「已知晓」→ 不能生成（强制用户确认）
  const hasCaveats = nd
    ? Boolean(nd.caveats && nd.caveats.length) || nd.cabinets.some((c) => c.caveats && c.caveats.length)
    : false;
  const ackNeeded = hasCaveats && !ack;
  const compileDisabled = busy || blocked || ackNeeded;

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

      {/* 输入区：图片识别走 Vision，其余走文本/文件 */}
      {source === 'imageVision' ? (
        <Section title="上传柜体效果图 / 截图">
          <div className="row">
            <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
              选择图片
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => runVision(false)}>
              识别这张图
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => runVision(true)}>
              示例图（离线 Mock）
            </button>
            {fileLabel ? <span className="muted-sm">已选：{fileLabel}</span> : null}
            <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
          </div>
          {imgData ? <img className="import-img-preview" src={imgData} alt="预览" /> : null}
          <input
            className="import-hint"
            placeholder="可选：给模型的提示，如「这是玄关鞋柜」「左柜已知宽 400」"
            value={hintText}
            onChange={(e) => setHintText(e.target.value)}
          />
          <p className="note">
            真实识别走服务端 AI 网关（/api/ai/vision，复用已配置的 baseUrl / key）；
            无 key 时可用「示例图（离线 Mock）」体验完整闭环。Vision 不编造看不见的生产结构。
          </p>
          {visionErr ? <div className="alert alert-error">{visionErr}</div> : null}
        </Section>
      ) : (
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
      )}

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
                  <div className="alert alert-warn">不确定（阻断）：{c.uncertainty.join('；')}</div>
                ) : null}
                {c.caveats && c.caveats.length > 0 ? (
                  <div className="alert alert-info">图片未确认（生成前请知晓）：{c.caveats.join('；')}</div>
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

          {/* 图片识别诚实项确认门 */}
          {hasCaveats ? (
            <label className="import-ack">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              我已逐项确认以上图片未确认项（真实深度 / 板厚 / 隐藏隔板 / 真实尺寸等），按估计或默认生成。
            </label>
          ) : null}

          <div className="row">
            <button type="button" className="btn btn-primary" disabled={compileDisabled} onClick={doCompile}>
              {blocked ? '有拦不住的问题，不能编译' : ackNeeded ? '请先确认图片未确认项' : '编译并预览'}
            </button>
            {blocked ? <span className="muted-sm">红色问题必须先解决（待确认问题 / 形状错误）</span> : null}
            {ackNeeded ? <span className="muted-sm">图片识别的诚实项需勾选「已知晓」后才允许生成</span> : null}
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
