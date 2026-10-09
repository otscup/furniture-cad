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
import { findDuplicateUnitIds } from '../src/core/unitIdentity.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EMIT_NEUTRAL_TS = join(ROOT, 'scripts', 'emit-neutral.ts');
const EMIT_ROOMBOOK_TS = join(ROOT, 'scripts', 'emit-roombook.ts');
const VALIDATE_EXPORT_TS = join(ROOT, 'scripts', 'validate-export.ts');
const EXPORT_DXF_PY = join(ROOT, 'py', 'export_dxf.py');

/** 正式导出遇到 ERROR 时返回给 HTTP/MCP 的可识别阻断错误。 */
export class ExportBlockedError extends Error {
  constructor(issues) {
    super(`发现 ${issues.length} 条校验 ERROR，正式导出已阻止。请先修复这些问题后再导出。`);
    this.name = 'ExportBlockedError';
    this.code = 'EXPORT_BLOCKED';
    this.statusCode = 422;
    this.issues = issues;
  }
}

export class UnitIdentityConflictError extends Error {
  constructor(conflicts) {
    super(`身份冲突：检测到重复 Unit/backUnit ID：${conflicts.map(({ id, locations }) => `${id}（${locations.join('、')}）`).join('；')}。正式生产导出已拒绝；不会自动重编号或改写项目。需要显式修复/迁移后重试。`);
    this.name = 'UnitIdentityConflictError';
    this.code = 'WORKSPACE_UNIT_ID_CONFLICT';
    this.statusCode = 422;
    this.conflicts = conflicts;
  }
}

/** 每次请求都在服务端用唯一校验源重算；WARNING 留作非阻断提示，只有 ERROR 拒绝。 */
async function assertExportable(project) {
  const identityConflicts = findDuplicateUnitIds(project);
  if (identityConflicts.length) throw new UnitIdentityConflictError(identityConflicts);
  const supportedSheetViews = new Set(['top', 'front', 'internal']);
  const cabinetIds = new Set((Array.isArray(project?.cabinets) ? project.cabinets : []).map((cabinet) => cabinet?.id));
  const unsupportedDrawingIssues = (Array.isArray(project?.drawingEdits) ? project.drawingEdits : [])
    .filter((edit) => edit?.space === 'sheet' && (!supportedSheetViews.has(edit.view) || !edit.cabinetId || !cabinetIds.has(edit.cabinetId)))
    .map((edit) => ({
      severity: 'ERROR',
      code: 'DRAWING_VIEW_NOT_EXPORTABLE',
      target: String(edit?.id ?? 'drawing-edits'),
      targetKind: 'project',
      message: `二维图元覆盖 ${String(edit?.id ?? '(无 ID)')} 的 sheet view=${String(edit?.view ?? '(缺失)')} 或柜体归属未被屏幕/PDF/DXF 共同支持，已阻止导出以避免静默漏图。`,
      fixHint: '将该覆盖恢复到存在的柜体及 top/front/internal 视图，或先删除该覆盖后再导出。',
    }));
  if (unsupportedDrawingIssues.length > 0) throw new ExportBlockedError(unsupportedDrawingIssues);
  const result = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', VALIDATE_EXPORT_TS], {
    input: JSON.stringify({ project }),
  });
  let validation;
  try {
    validation = JSON.parse(result.out);
  } catch {
    throw new Error('导出前校验器未返回有效结果');
  }
  const errors = Array.isArray(validation.issues)
    ? validation.issues.filter((issue) => issue.severity === 'ERROR')
    : [];
  if (errors.length > 0) throw new ExportBlockedError(errors);
}

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

/** 二进制子进程：PDF 不可经 UTF-8 字符串往返，否则文件字节会被破坏。 */
function runBuffer(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, ...opts });
    const chunks = [];
    let size = 0;
    let err = '';
    let exceeded = false;
    if (opts.input !== undefined) p.stdin.end(opts.input);
    p.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024 * 1024) {
        exceeded = true;
        p.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    p.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (exceeded) return reject(new Error('PDF 输出超过 256 MB，已停止渲染'));
      if (code !== 0) return reject(new Error(`${cmd} 退出码 ${code}：${(err || '未知渲染错误').slice(0, 800)}`));
      resolve({ buffer: Buffer.concat(chunks, size), stderr: err });
    });
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
export async function exportDxf(project, { which = ['plan', 'sheet'], version = 'R2007', modelVersion = 'unknown', planRoomIds } = {}) {
  await assertExportable(project);
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
      input: JSON.stringify({ project, which, modelVersion: String(modelVersion), planRoomIds }),
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
  await assertExportable(project);
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', EMIT_NEUTRAL_TS], {
    input: JSON.stringify({ project, which: [], modelVersion: String(modelVersion) }),
  });
  const n = JSON.parse(r.out);
  const rows = [
    ['序号', '板件ID', '名称', '角色', '所属', '材质', '厚(mm)', '长(mm)', '宽(mm)', '数量', '纹理方向（相对成品板长/宽轴）', '单件面积(m²)', '共享件ID', '共享段ID', '成员柜ID', '替代柜顶ID', '饰面/封边/外挑/支撑/CNC'],
  ];
  // 开料习惯：先按材质 + 厚度分组，组内按面积从大到小 —— 排版时一眼看到大板
  const panels = [...n.panels].sort(
    (a, b) => a.material.localeCompare(b.material) || a.thickness - b.thickness || b.length * b.width - a.length * a.width
  );
  panels.forEach((p, i) => {
    rows.push([
      i + 1, p.id, p.nameZh, p.role, p.belongsTo, p.material, p.thickness, p.length, p.width, p.qty, p.grain,
      ((p.length * p.width) / 1e6).toFixed(3),
      p.sharedPanelTrace?.id ?? '',
      p.sharedPanelTrace?.segmentId ?? '',
      p.sharedPanelTrace?.memberCabinetIds?.join('|') ?? '',
      p.sharedPanelTrace?.replacesPanelIds?.join('|') ?? '',
      p.sharedPanelTrace ? JSON.stringify({ overallSize: [p.sharedPanelTrace.length, p.sharedPanelTrace.width, p.sharedPanelTrace.thickness], bounds: p.sharedPanelTrace.bounds, elevation: p.sharedPanelTrace.elevation, material: p.sharedPanelTrace.material, finish: p.sharedPanelTrace.finish, grainDirection: p.sharedPanelTrace.grainDirection, grainReference: '相对成品板长/宽轴', nestingBoundary: '不提供专业开料优化或板材旋转优化', edgeTreatment: p.sharedPanelTrace.edgeTreatment, overhang: p.sharedPanelTrace.overhang, segmentation: p.sharedPanelTrace.segmentation, support: { method: p.sharedPanelTrace.supportMethod, cabinetIds: p.sharedPanelTrace.supportCabinetIds }, machining: p.sharedPanelTrace.machining }) : '',
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
export async function exportRoombook(project, { modelVersion = 'unknown', layoutRoomIds } = {}) {
  await assertExportable(project);
  const r = await run(process.execPath, ['--experimental-strip-types', '--no-warnings', EMIT_ROOMBOOK_TS], {
    input: JSON.stringify({ project, modelVersion: String(modelVersion), ...(Array.isArray(layoutRoomIds) ? { layoutRoomIds } : {}) }),
  });
  const html = r.out || '';
  if (!html.trim()) throw new Error(r.err || '生成器无输出');
  const filename = `${String(project.name || 'project')}_图纸册_${new Date().toISOString().slice(0, 10)}.html`;
  return { html, filename };
}

/**
 * 服务端真实 PDF 导出：复用 roomBook HTML 的 A3 横向页面和单柜 SVG，
 * 不依赖用户本机浏览器、打印缩放或「打印背景」设置。
 */
export async function exportPdf(project, { modelVersion = 'unknown', layoutRoomIds = [] } = {}) {
  const selectedLayoutRoomIds = Array.isArray(layoutRoomIds)
    ? layoutRoomIds.filter((id) => typeof id === 'string' && (project?.rooms ?? []).some((room) => room.id === id))
    : [];
  const { html, filename: htmlFilename } = await exportRoombook(project, { modelVersion, layoutRoomIds: selectedLayoutRoomIds });
  const renderScript = [
    'import sys',
    'from weasyprint import HTML',
    'source = sys.stdin.buffer.read().decode("utf-8")',
    'document = HTML(string=source, media_type="print").render()',
    'sys.stdout.buffer.write(document.write_pdf())',
    'print("__FC_PDF_PAGES__=" + str(len(document.pages)), file=sys.stderr)',
  ].join('\n');
  const rendered = await runBuffer(pythonExe(), ['-c', renderScript], { input: html, stdio: ['pipe', 'pipe', 'pipe'] });
  const pdf = rendered.buffer;
  if (pdf.length < 8 || pdf.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('PDF 渲染器未返回有效的 PDF 文件');
  }
  const pageCount = Number(/__FC_PDF_PAGES__=(\d+)/.exec(rendered.stderr)?.[1] ?? 0);
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('PDF 渲染器未返回有效的页数元数据');
  return { pdf, pageCount, filename: htmlFilename.replace(/\.html$/i, '.pdf') };
}
