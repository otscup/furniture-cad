/**
 * 导出核心（P10.0 S6）：三条导出链的共享实现。
 *
 * HTTP `/api/export/*` 与 MCP `cad.export_*` 共用这一套 —— 不另起第二套导出逻辑。
 * 区别只在"怎么把文件交出去"：HTTP 走流式下载，MCP 走 base64 JSON。
 *
 * 三条链：
 *   exportDxf      : project → emit-neutral.ts → export_dxf.py → DXF Buffer
 *   exportCutlist  : project → emit-neutral.ts → JS 组 CSV → CSV string
 *   exportRoombook : project → emit-roombook.ts → HTML string
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvCell } from './csvCell.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EMIT_NEUTRAL_TS = join(ROOT, 'scripts', 'emit-neutral.ts');
const EMIT_ROOMBOOK_TS = join(ROOT, 'scripts', 'emit-roombook.ts');
const EXPORT_DXF_PY = join(ROOT, 'py', 'export_dxf.py');

/** 跑一个子进程并收齐 stdout/stderr。cwd 固定到项目根，相对路径才不会飘。 */
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, ...opts });
    let out = '';
    let err = '';
    if (opts.input !== undefined) p.stdin.end(opts.input);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} 退出码 ${code}：${(err || out).slice(0, 600)}`))
    );
  });
}

/**
 * Python 解释器：优先环境变量，其次项目根的 .venv。找不到就如实报错，
 * 不许"假装导出成功"。
 */
function pythonExe() {
  const cand = [
    process.env.APP_PYTHON,
    join(ROOT, '.venv', 'Scripts', 'python.exe'),
    join(ROOT, '..', '.venv', 'Scripts', 'python.exe'),
    join(ROOT, '..', '.venv', 'bin', 'python'),
    'python',
  ]
    .filter(Boolean)
    .filter((c) => (c.includes('/') || c.includes('\\') ? existsSync(c) : true));
  return cand[0] ?? 'python';
}

/**
 * DXF 导出：返回 { buffer, filename, info }。
 * which: ['plan','sheet'] 子集；version: 'R2007' | 'R2000'
 */
export async function exportDxf(project, { which = ['plan', 'sheet'], version = 'R2007', modelVersion = 'unknown' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'furniture-dxf-'));
  const neutralPath = join(dir, 'neutral.json');
  const dxfPath = join(dir, 'out.dxf');
  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      console.error('[dxf] 临时目录清理失败（已忽略）：', dir, e?.message ?? e);
    }
  };
  try {
    const neutralOut = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', EMIT_NEUTRAL_TS], {
      input: JSON.stringify({ project, which, modelVersion: String(modelVersion) }),
    });
    writeFileSync(neutralPath, neutralOut.out, 'utf8');
    const infoRaw = await run(pythonExe(), [EXPORT_DXF_PY, neutralPath, dxfPath, version]);
    const info = JSON.parse(infoRaw.out || '{}');
    const buffer = readFileSync(dxfPath);
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `${String(project.name || 'project')}_${which.join('-')}_${stamp}_${version}.dxf`;
    return { buffer, filename, info };
  } finally {
    cleanup();
  }
}

/**
 * 开料单 CSV 导出：返回 { csv, filename, stats }。
 * 纯文本 CSV，带 BOM（Excel 直接开中文不乱码）。
 */
export async function exportCutlist(project, { modelVersion = 'unknown' } = {}) {
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', EMIT_NEUTRAL_TS], {
    input: JSON.stringify({ project, which: [], modelVersion: String(modelVersion) }),
  });
  const n = JSON.parse(r.out);
  const rows = [
    ['序号', '板件ID', '名称', '角色', '所属', '材质', '厚(mm)', '长(mm)', '宽(mm)', '数量', '纹理', '单件面积(m²)'],
  ];
  // 开料习惯：先按材质 + 厚度分组，组内按面积从大到小 —— 排版时一眼看到大板
  const panels = [...n.panels].sort(
    (a, b) => a.material.localeCompare(b.material) || a.thickness - b.thickness || b.length * b.width - a.length * a.width
  );
  panels.forEach((p, i) => {
    rows.push([
      i + 1, p.id, p.nameZh, p.role, p.belongsTo, p.material, p.thickness, p.length, p.width, p.qty, p.grain,
      ((p.length * p.width) / 1e6).toFixed(3),
    ]);
  });
  // 甲购/外采件（玻璃门等）单独一节 —— 它们不走开料机，混进板件清单会误导排产
  if (n.purchased && n.purchased.length > 0) {
    rows.push([]);
    rows.push(['—— 甲购/外采件（不进开料）——']);
    rows.push(['序号', '件ID', '名称', '类型', '所属', '材质', '规格/工艺要求', '数量']);
    n.purchased.forEach((x, i) => {
      rows.push([i + 1, x.id, x.nameZh, x.kind, x.belongsTo, x.material, x.spec, x.qty]);
    });
  }
  const csv = '﻿' + rows.map((r2) => r2.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const filename = `${String(project.name || 'project')}_开料单_${new Date().toISOString().slice(0, 10)}.csv`;
  return { csv, filename, stats: n.stats };
}

/**
 * 图纸册 HTML 导出：返回 { html, filename }。
 * 浏览器打开后「打印 → 另存为 PDF」。
 */
export async function exportRoombook(project, { modelVersion = 'unknown' } = {}) {
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', EMIT_ROOMBOOK_TS], {
    input: JSON.stringify({ project, modelVersion: String(modelVersion) }),
  });
  const html = r.out || '';
  if (!html.trim()) throw new Error(r.err || '生成器无输出');
  const filename = `${String(project.name || 'project')}_图纸册_${new Date().toISOString().slice(0, 10)}.html`;
  return { html, filename };
}
