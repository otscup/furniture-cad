import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { CommandBus } from '../../core/commandBus.ts';
import { generateProject } from '../../core/geometry/project.ts';
import {
  deriveManufacturing,
  type ManufacturingPart,
  type MfgPartCategory,
} from '../../core/manufacturing/index.ts';
import { Pill, Section, Text } from './common.tsx';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  ManufacturingPanel（P7）—— 制造语义只读视图
 *
 *  能看到：制造件清单（角色/尺寸/材质/封边）、加工操作及其验证状态、
 *          未确认的制造方面（不脑补的那部分，显式暴露）。
 *  不做的：**零写入口**。Manufacturing 是纯派生层，这里没有按钮能改模型；
 *          改设计请回属性面板 / AI 计划，改完这里自动重派生。
 * ══════════════════════════════════════════════════════════════════════
 */

const CATEGORY_ZH: Record<MfgPartCategory, string> = {
  'case-shell': '箱体结构板',
  back: '背板',
  shelf: '层板',
  front: '门板',
  drawer: '抽屉件',
  aperture: '洞口过梁',
  misc: '其他',
};

function PartCard(props: { p: ManufacturingPart }): ReactNode {
  const { p } = props;
  const verifiedOps = p.operations.filter((o) => o.verification === 'verified');
  const unverifiedOps = p.operations.filter((o) => o.verification === 'unverified');
  return (
    <div className="kn-entry">
      <div className="kn-entry-head">
        <Pill kind={p.verification === 'verified' ? 'ok' : 'WARNING'}>
          {p.verification === 'verified' ? '已验证' : '含未确认'}
        </Pill>
        <Text strong>{p.nameZh}</Text>
        <Pill kind="INFO">{CATEGORY_ZH[p.category]}</Pill>
      </div>
      <div className="mono muted-sm">
        {p.length}×{p.width}×{p.thickness} · {p.qty} 件 · {p.materialName}
        {p.grain !== 'none' ? ` · 纹向沿${p.grain === 'length' ? '长' : '宽'}` : ''}
      </div>
      {p.edgeLabel ? <div className="muted-sm">封边：{p.edgeLabel}</div> : null}
      {verifiedOps.length > 0 ? (
        <div className="muted-sm">
          已确认加工：
          {verifiedOps.map((o) => o.nameZh + (o.detail ? `（${o.detail}）` : '')).join('；')}
        </div>
      ) : null}
      {unverifiedOps.length > 0 ? (
        <div className="alert alert-warn">
          未确认（不下到车间）：{unverifiedOps.map((o) => o.nameZh).join('、')}
        </div>
      ) : null}
    </div>
  );
}

export function ManufacturingPanel(props: { bus: CommandBus; version: number }): ReactNode {
  const { bus } = props;
  const project = bus.getState();
  const rules = bus.getRules();

  // version 变化即重派生 —— 派生是纯函数，同输入同输出，界面读数就是会被导出的那个值
  const mfg = useMemo(() => deriveManufacturing(project, generateProject(project, rules), rules), [project, rules, props.version]);

  const cabinetName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of project.cabinets) m.set(c.id, c.name);
    return m;
  }, [project]);

  const byCabinet = useMemo(() => {
    const groups: Array<{ id: string; parts: ManufacturingPart[] }> = [];
    for (const c of project.cabinets) {
      const parts = mfg.cabinets[c.id];
      if (parts && parts.length > 0) groups.push({ id: c.id, parts });
    }
    return groups;
  }, [mfg, project]);

  return (
    <div className="panel knowledge-panel">
      <Section title="制造语义（只读派生）">
        <p className="note">
          本页是 <b>Semantic Model → 制造语义</b> 的确定性派生结果：制造尺寸只读几何板件（单一来源），
          已验证的加工（封边 / 背板工艺）来自规则与语义字段；钻孔 / 连接孔 / 五金安装当前
          <b>无法确定性给出，一律标「未确认」，绝不下到车间</b>。此层不提供任何写入口 —— 改设计请回属性面板。
        </p>
        <div className="muted-sm">
          制造件 {mfg.stats.partCount} 件 · 已验证 {mfg.stats.verifiedCount} · 含未确认 {mfg.stats.unverifiedCount} ·
          规则集 {mfg.ruleSetId} / 制造规则 {mfg.manufacturingRuleSetId}
        </div>
        <div className="muted-sm">
          分类：{Object.entries(mfg.stats.byCategory)
            .filter(([, n]) => n > 0)
            .map(([k, n]) => `${CATEGORY_ZH[k as MfgPartCategory]} ${n}`)
            .join(' · ') || '—'}
        </div>
      </Section>

      {mfg.warnings.length > 0 ? (
        <Section title={`全局制造提示（${mfg.warnings.length} 条）`}>
          {mfg.warnings.map((w, i) => (
            <div key={i} className="alert alert-warn">
              <Pill kind={w.severity === 'warning' ? 'WARNING' : 'INFO'}>{w.code}</Pill> {w.message}
            </div>
          ))}
        </Section>
      ) : null}

      {byCabinet.length === 0 ? (
        <Section title="制造件清单">
          <div className="note ok">当前项目还没有柜体 —— 放一个柜体后，制造件会在这里按柜列出。</div>
        </Section>
      ) : (
        byCabinet.map((g) => (
          <Section key={g.id} title={`柜「${cabinetName.get(g.id) ?? g.id}」· ${g.parts.length} 件`} defaultOpen={byCabinet.length <= 3}>
            {g.parts.map((p) => (
              <PartCard key={p.id} p={p} />
            ))}
          </Section>
        ))
      )}
    </div>
  );
}
