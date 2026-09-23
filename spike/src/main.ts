import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RuleSet, SemanticModel, Issue } from './types.ts';
import { generatePanelModel } from './generate.ts';
import { validate } from './validate.ts';
import { toNeutralExport } from './export-neutral.ts';

const GENERATOR_VERSION = 'spike@0.1.0';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'out');
mkdirSync(outDir, { recursive: true });

const model: SemanticModel = JSON.parse(readFileSync(resolve(root, 'model/cabinet-001.json'), 'utf8'));
const rules: RuleSet = JSON.parse(readFileSync(resolve(root, 'ruleset/factory-default.json'), 'utf8'));

// ─────────── 1. Semantic Model → Panel Model ───────────
const pm = generatePanelModel(model, rules);

// ─────────── 2. 校验（恒等式 + 生产硬规则）───────────
if (model.params.height > 100000) throw new Error('sanity');
const issues: Issue[] = [...pm.issues, ...validate(model, pm, rules)];
pm.issues = issues;

// ─────────── 3. 落盘 ───────────
writeFileSync(resolve(outDir, 'panel-model.json'), JSON.stringify(pm, null, 2), 'utf8');

const neutral = toNeutralExport(model, pm, rules, GENERATOR_VERSION);
writeFileSync(resolve(outDir, 'neutral.json'), JSON.stringify(neutral, null, 2), 'utf8');

// 板件清单 CSV
const csvHeader = ['序号', '板件编号', '名称', '组', '材质', '厚(mm)', '长(mm)', '宽(mm)', '数量', '封边', '木纹'];
const rows = pm.panels.map((x, i) => [
  String(i + 1), x.id, x.nameZh, x.group, x.material, String(x.thickness),
  String(x.length), String(x.width), String(x.qty), x.edgeLabel, x.grain,
]);
writeFileSync(
  resolve(outDir, 'panel-list.csv'),
  '\uFEFF' + [csvHeader, ...rows].map((r) => r.join(',')).join('\r\n') + '\r\n',
  'utf8'
);

// 开料清单 CSV（按材质×厚度汇总）
const groups = new Map<string, { material: string; thickness: number; qty: number; area: number }>();
for (const x of pm.panels) {
  const k = `${x.material}@${x.thickness}`;
  const g = groups.get(k) ?? { material: x.material, thickness: x.thickness, qty: 0, area: 0 };
  g.qty += x.qty;
  g.area += (x.length * x.width * x.qty) / 1e6;
  groups.set(k, g);
}
const cutRows = [...groups.values()].map((g) => [
  rules.materials[g.material]?.name ?? g.material,
  String(g.thickness),
  String(g.qty),
  g.area.toFixed(3),
  ((g.area / ((2440 * 1220) / 1e6)) * 1).toFixed(2),
]);
writeFileSync(
  resolve(outDir, 'cutting-list.csv'),
  '\uFEFF' + [['材质', '厚度(mm)', '件数', '面积(m2)', '净用板(张，未含损耗)'], ...cutRows].map((r) => r.join(',')).join('\r\n') + '\r\n',
  'utf8'
);

// ─────────── 4. 控制台汇报 ───────────
const L = (s: string): void => console.log(s);
L('══════════ Phase 0 Spike · Semantic → Panel → DXF ══════════');
L(`柜体：${pm.cabinetName} (${pm.cabinetId})  外尺寸 ${pm.outer.width}×${pm.outer.height}×${pm.outer.depth}  规则集 ${rules.id}`);
L(`内空：${pm.inner.width} × ${pm.inner.height}   箱体高 ${pm.bodyHeight}   抬高 ${model.params.bodyLift}`);
L('');
L('── 分区宽度分配 ──');
for (const u of pm.units) {
  L(`  ${u.id.padEnd(8)} ${u.kind.padEnd(12)} 期望 ${u.requestedWidth} → 净宽 ${u.netWidth}  x0=${u.x0}`);
}
L('');
L('── 板件清单 ──');
L('  #  编号                          名称             材质        厚   长    宽   数  封边');
pm.panels.forEach((x, i) => {
  L(
    `  ${String(i + 1).padStart(2)} ${x.id.padEnd(30)} ${x.nameZh.padEnd(16)} ${x.material.padEnd(11)} ${String(
      x.thickness
    ).padStart(2)} ${String(x.length).padStart(5)} ${String(x.width).padStart(5)} ${String(x.qty).padStart(2)}  ${x.edgeLabel}`
  );
});
L('');
L('── 五金清单 ──');
for (const h of pm.hardware) L(`  ${h.nameZh.padEnd(8)} ×${String(h.qty).padStart(3)}  ${h.spec}  [${h.belongsTo}]`);
L('');
L('── 校验结果 ──');
const bySev = { ERROR: [] as Issue[], WARNING: [] as Issue[], INFO: [] as Issue[] };
for (const i of issues) bySev[i.severity].push(i);
for (const sev of ['ERROR', 'WARNING', 'INFO'] as const) {
  if (bySev[sev].length === 0) continue;
  L(`  [${sev}] ${bySev[sev].length} 条`);
  for (const i of bySev[sev]) L(`    · ${i.code} @${i.target}\n      ${i.message}${i.fixHint ? `\n      → ${i.fixHint}` : ''}`);
}
if (!bySev.ERROR.length) L('  [ERROR] 0 条 ✔ 恒等式全部成立');
L('');
L('── 统计 ──');
L(`  板件种类 ${pm.stats.panelKinds}  总件数 ${pm.stats.totalPieces}  板材面积 ${pm.stats.boardAreaM2} m²  估重 ${pm.stats.estWeightKg} kg`);
L('════════════════════════════════════════════════════════════');
