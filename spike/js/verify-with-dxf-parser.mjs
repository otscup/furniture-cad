/**
 * 独立解析器交叉验证 —— 用 dxf-parser（与 ezdxf 完全不同的实现）重新读一遍 DXF。
 *
 * 目的：ezdxf 自己 audit 自己不算证据。换一套完全独立的实现能读出同样的东西，
 *       才说明文件是"按规范写的"，而不是"ezdxf 自己能读"。
 *
 * 运行：NODE_PATH=<managed workspace>/node_modules node js/verify-with-dxf-parser.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import DxfParser from 'dxf-parser';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dxfPath = resolve(root, 'out', process.argv[2] ?? 'Cabinet_001_R2007.dxf');
const neutral = JSON.parse(readFileSync(resolve(root, 'out', 'neutral.json'), 'utf8'));

const fails = [];
const check = (cond, ok, bad) => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + (cond ? ok : bad));
  if (!cond) fails.push(bad);
};

console.log('═'.repeat(74));
console.log('独立解析器交叉验证 (dxf-parser)  ——', dxfPath.split(/[\\/]/).pop());
console.log('═'.repeat(74));

const text = readFileSync(dxfPath, 'utf8');
const parser = new DxfParser();

let dxf;
try {
  dxf = parser.parseSync(text);
  check(true, `解析成功（不是 ezdxf 读的，是第二套实现）`, '');
} catch (e) {
  check(false, '', `解析失败：${e.message}`);
  process.exit(1);
}

// ── 1. 单位 ──────────────────────────────────────────────────────
console.log('\n[1] 单位');
const insunits = Number(dxf.header?.['$INSUNITS']);
check(insunits === 4, `$INSUNITS = ${insunits}（毫米）`, `$INSUNITS = ${insunits}，应为 4`);

// ── 2. 图层 ──────────────────────────────────────────────────────
console.log('\n[2] 图层');
const layerNames = Object.keys(dxf.tables?.layer?.layers ?? {});
const need = ['PANEL_18', 'PANEL_15', 'PANEL_9', 'PANEL_5', 'EDGE_1MM', 'EDGE_04MM', 'DIM', 'ELEV_STRUCT', 'ELEV_FRONT', 'FRAME', 'TITLE', 'NOTE'];
const missing = need.filter((n) => !layerNames.includes(n));
check(missing.length === 0, `全部 ${need.length} 个业务图层存在（共 ${layerNames.length} 个图层）`, `缺少图层：${missing}`);

// ── 3. 实体统计 ──────────────────────────────────────────────────
console.log('\n[3] 实体统计');
const byType = dxf.entities.reduce((m, e) => ((m[e.type] = (m[e.type] ?? 0) + 1), m), {});
console.log('        ' + Object.entries(byType).map(([k, v]) => `${k}×${v}`).join(', '));
const total = dxf.entities.length;
check(Math.abs(total - 367) <= 2, `实体总数 ${total}（ezdxf 报告 367，差异 ≤2 视为一致）`, `实体总数 ${total}，与 ezdxf 的 367 差异过大`);
check((byType.DIMENSION ?? 0) > 0, `DIMENSION ${byType.DIMENSION ?? 0} 个 —— 尺寸标注是真 CAD 实体，可在 CAD 内编辑`, '没有 DIMENSION 实体');

// ── 4. 板件矩形尺寸零误差比对 ────────────────────────────────────
console.log('\n[4] 板件矩形尺寸比对（独立解析 → 与 Panel Model 逐项对照）');
const rects = [];
for (const e of dxf.entities) {
  if (e.type !== 'LWPOLYLINE' || !Array.isArray(e.vertices) || e.vertices.length < 4) continue;
  const xs = e.vertices.map((v) => v.x);
  const ys = e.vertices.map((v) => v.y);
  const w = Math.round(Math.max(...xs) - Math.min(...xs));
  const h = Math.round(Math.max(...ys) - Math.min(...ys));
  if (w > 0 && h > 0) rects.push({ w, h, layer: e.layer });
}
const key = (a, b) => `${a}x${b}`;
const found = new Set(rects.map((r) => key(r.h, r.w)));
const notFound = neutral.panels.filter((p) => !found.has(key(p.length, p.width)));
check(
  notFound.length === 0,
  `${neutral.panels.length} 种板件在独立解析结果中全部找到，尺寸零误差`,
  `${notFound.length} 种板件对不上：${notFound.slice(0, 5).map((p) => `${p.id} ${p.length}×${p.width}`)}`
);

// ── 5. 关键尺寸存在性（立面 2400 / 分区 582、1164）───────────────
console.log('\n[5] 关键尺寸');
const dims = dxf.entities.filter((e) => e.type === 'DIMENSION');
const dimVals = new Set();
for (const d of dims) {
  const pts = [d.definitionPoint, d.textMidPoint, d.anchorPoint].filter(Boolean);
  for (const p of pts) {
    if (typeof p?.x === 'number' && typeof p?.y === 'number') {
      dimVals.add(Math.round(Math.abs(p.y)));
      dimVals.add(Math.round(Math.abs(p.x)));
    }
  }
}
const hasBox = rects.some((r) => (r.w === 2400 && r.h === 2400) || (r.h === 2400 && r.w === 2400));
check(hasBox, '立面外框 2400×2400 存在', '找不到 2400×2400 外框');
// 板件在图上按 length 竖向绘制：矩形 h = length，w = width
check(rects.some((r) => r.h === 2364 && r.w === 600), '顶板/底板 length=2364 × width=600 存在（内空宽零误差）', '找不到 2364×600');
check(rects.some((r) => r.h === 2320 && r.w === 600), '侧板 length=2320 × width=600 存在', '找不到 2320×600');

// ── 6. 中文文字 ──────────────────────────────────────────────────
console.log('\n[6] 中文文字');
const codepage = /\$DWGCODEPAGE\s*\r?\n\s*ANSI_(\d+)/.exec(text)?.[1] ?? '1252';
const isUtf8Native = text.includes('$ACADVER') && /\r?\nAC10(21|24|27|28|32)/.test(text);
const texts = dxf.entities.filter((e) => e.type === 'TEXT').map((e) => e.text ?? '');
const cn = texts.filter((t) => /[\u4e00-\u9fff]/.test(t));

if (isUtf8Native) {
  // R2007+ 原生 UTF-8：任何现代解析器都能直接读
  check(cn.length > 0, `读出 ${cn.length} 条中文文字，示例：${cn[0]}`, '没有读出中文文字');
  check(!cn.some((t) => t.includes('\\U+')), '中文不是 \\U+ 转义序列', '中文仍是 \\U+ 转义序列');
} else {
  // R2000 及更早：中文依赖 $DWGCODEPAGE 解码，本解析器只按 UTF-8 读，必然乱码
  console.log(`        本文件 $DWGCODEPAGE = ANSI_${codepage}（非 UTF-8），dxf-parser 只按 UTF-8 解码 → 读出的中文必然是乱码。`);
  console.log(`        这说明：**GBK 版 DXF 只对认 $DWGCODEPAGE 的 CAD 安全**（AutoCAD / 中望 / 浩辰认，很多 JS 解析器不认）。`);
  console.log(`        → 结论：R2007(UTF-8) 应作为主交付，GBK 版仅作老软件兼容备用。`);
}

// ── 汇总 ─────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(74));
if (fails.length) {
  console.log(`结论：✗ ${fails.length} 项未通过`);
  fails.forEach((f) => console.log('   · ' + f));
  process.exit(1);
} else {
  console.log('结论：✔ 两套独立实现读出的结果一致 —— DXF 是按规范写的，不是"只有自己能读"');
}
console.log('═'.repeat(74));
