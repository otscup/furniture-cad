/**
 * ══════════════════════════════════════════════════════════════════════
 *  按房间排序的图纸册（Phase D）—— 销售图纸 HTML 打印版
 *
 *  ── 它是什么 ──
 *  把"多房间多柜体的项目"编排成一份可打印的图纸册：
 *    封面（项目 + 客户表 + 版本三件套）→ 每房间一节 → 每柜一页
 *    （三图组合：平面 / 门板外观 / 内部结构）→ 尾页汇总清单。
 *
 *  ── 它不是什么 ──
 *  **零新几何**。三图全部来自既有派生链（CabinetGeometry.plan +
 *  buildCabinetViews），本文件只做"编排 + 排版"。
 *  排序也不发明规则：房间按 rooms 数组顺序（模型顺序即语义），
 *  房内柜体按 (y, x) 排序 —— 全部来自模型，导出器不做主。
 *
 *  ── 两层 API ──
 *  buildRoomBook()  → 结构化数据（验收可直接断言排序与分组）
 *  roomBookHtml()   → 打印 HTML（@page 分页，浏览器打印即 PDF）
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Cabinet, Prim, Project, PurchasedItem, RuleSet } from '../core/types.ts';
import { generateProject } from '../core/geometry/project.ts';
import { buildCabinetViews } from '../core/geometry/views.ts';
import { GENERATOR_VERSION } from './neutralSheet.ts';

// ─────────────────────────── SVG（Y 向上 CAD → Y 向下 SVG）───────────────────────────

/** 图层 → 颜色。打印件：结构黑、隐藏浅灰、五金中灰（虚线在 Prim 上自带） */
function strokeOf(layer: string): string {
  if (layer.includes('HIDDEN')) return '#b0b7c3';
  if (layer.includes('HW')) return '#555b66';
  if (layer.startsWith('F-DIM') || layer.startsWith('F-TEXT')) return '#333a45';
  return '#111318';
}
function fillOf(layer: string): string {
  void layer;
  return '#eef0f4';
}

function primPoints(prims: Prim[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const eat = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const p of prims) {
    if (p.k === 'text') eat(p.p.x, p.p.y);
    else for (const q of p.pts) eat(q.x, q.y);
  }
  return { minX, minY, maxX, maxY };
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const PAD = 120;

/** Prim 数组 → SVG 字符串（viewBox 取内容 bbox；scale(1,-1) 处理 Y 轴，文字再翻回） */
export function primsToSvg(prims: Prim[], cls: string): string {
  if (prims.length === 0) return `<svg class="${cls}" role="img"></svg>`;
  const b = primPoints(prims);
  const minX = b.minX - PAD;
  const minY = b.minY - PAD;
  const w = b.maxX - b.minX + PAD * 2;
  const h = b.maxY - b.minY + PAD * 2;
  const body: string[] = [];
  for (const p of prims) {
    if (p.k === 'poly') {
      const pts = p.pts.map((q) => `${q.x},${q.y}`).join(' ');
      const dash = p.dash ? ` stroke-dasharray="${p.dash.join(' ')}"` : '';
      body.push(`<polyline points="${pts}" fill="none" stroke="${strokeOf(p.layer)}" stroke-width="${p.lw * 1.6}"${dash}/>`);
    } else if (p.k === 'fill') {
      const pts = p.pts.map((q) => `${q.x},${q.y}`).join(' ');
      body.push(`<polygon points="${pts}" fill="${fillOf(p.layer)}" fill-opacity="${p.alpha}" stroke="none"/>`);
    } else {
      const anchor = p.align === 'c' ? 'middle' : p.align === 'r' ? 'end' : 'start';
      body.push(
        `<text transform="translate(${p.p.x},${p.p.y}) scale(1,-1)" font-size="${p.size}" fill="${strokeOf(p.layer)}" text-anchor="${anchor}" font-family="sans-serif">${esc(p.text)}</text>`
      );
    }
  }
  return `<svg class="${cls}" viewBox="${minX} ${-(minY + h)} ${w} ${h}" preserveAspectRatio="xMidYMid meet" role="img"><g transform="scale(1,-1)">${body.join('')}</g></svg>`;
}

// ─────────────────────────── 结构化数据 ───────────────────────────

export interface RoomBookCabinet {
  id: string;
  name: string;
  index: number;
  width: number;
  height: number;
  depth: number;
  boardMaterial: string;
  backMaterial: string;
  doorMaterial: string | null;
  planSvg: string;
  frontSvg: string;
  internalSvg: string;
  panelKinds: number;
  panelPieces: number;
  hardware: Array<{ nameZh: string; qty: number; spec: string }>;
  purchased: PurchasedItem[];
}

export interface RoomBookSection {
  roomId: string;
  roomName: string;
  cabinets: RoomBookCabinet[];
}

export interface RoomBook {
  projectName: string;
  modelVersion: string;
  generatorVersion: string;
  ruleSetId: string;
  ruleSetName: string;
  sections: RoomBookSection[];
  /** 尾页汇总：按柜归类的清单（模型顺序） */
  summary: Array<{
    cabinet: string;
    room: string;
    panelKinds: number;
    panelPieces: number;
    hardwareKinds: number;
    hardwarePieces: number;
    purchased: number;
  }>;
  totals: { cabinets: number; panelKinds: number; panelPieces: number; purchased: number };
}

/**
 * 编排：房间按 rooms 数组顺序，房内柜体按 (y, x) 排序。
 * 没有归属房间的柜体进「未分配」节（放最后，明确标出 —— 不静默丢）。
 */
export function buildRoomBook(project: Project, rules: RuleSet, modelVersion: string): RoomBook {
  const geom = generateProject(project, rules);

  const buildCab = (cab: Cabinet, index: number): RoomBookCabinet => {
    const g = geom.cabinets[cab.id]!;
    const vs = buildCabinetViews(cab, rules);
    const doorUnit = cab.layout.units.find((u) => u.doors);
    const doorMatName = doorUnit?.doors?.material ? (rules.materials[doorUnit.doors.material]?.name ?? doorUnit.doors.material) : null;
    return {
      id: cab.id,
      name: cab.name,
      index,
      width: cab.params.width,
      height: cab.params.height,
      depth: cab.params.depth,
      boardMaterial: rules.materials[cab.params.boardMaterial]?.name ?? cab.params.boardMaterial,
      backMaterial: rules.materials[cab.params.backPanel.material]?.name ?? cab.params.backPanel.material,
      doorMaterial: doorMatName,
      planSvg: primsToSvg(g.plan, 'dwg'),
      frontSvg: primsToSvg(vs.prims.front, 'dwg'),
      internalSvg: primsToSvg(vs.prims.internal, 'dwg'),
      panelKinds: g.stats.panelKinds,
      panelPieces: g.stats.totalPieces,
      hardware: g.hardware.map((h) => ({ nameZh: h.nameZh, qty: h.qty, spec: h.spec })),
      purchased: g.purchased,
    };
  };

  const sections: RoomBookSection[] = [];
  for (const room of project.rooms) {
    const inRoom = project.cabinets
      .filter((c) => c.roomId === room.id)
      .sort((a, b) => a.placement.y - b.placement.y || a.placement.x - b.placement.x);
    sections.push({ roomId: room.id, roomName: room.name, cabinets: inRoom.map((c, i) => buildCab(c, i + 1)) });
  }
  const orphans = project.cabinets.filter((c) => !project.rooms.some((r) => r.id === c.roomId));
  if (orphans.length > 0) {
    sections.push({ roomId: '', roomName: '未分配房间', cabinets: orphans.map((c, i) => buildCab(c, i + 1)) });
  }

  const summary = sections.flatMap((s) =>
    s.cabinets.map((c) => {
      const g = geom.cabinets[c.id]!;
      return {
        cabinet: c.name,
        room: s.roomName,
        panelKinds: c.panelKinds,
        panelPieces: c.panelPieces,
        hardwareKinds: g.hardware.length,
        hardwarePieces: g.hardware.reduce((a, h) => a + h.qty, 0),
        purchased: c.purchased.length,
      };
    })
  );

  return {
    projectName: project.name,
    modelVersion,
    generatorVersion: GENERATOR_VERSION,
    ruleSetId: rules.id,
    ruleSetName: rules.name,
    sections,
    summary,
    totals: {
      cabinets: summary.length,
      panelKinds: summary.reduce((a, s) => a + s.panelKinds, 0),
      panelPieces: summary.reduce((a, s) => a + s.panelPieces, 0),
      purchased: summary.reduce((a, s) => a + s.purchased, 0),
    },
  };
}

// ─────────────────────────── HTML 渲染 ───────────────────────────

const CSS = `
  * { box-sizing: border-box; }
  body { font-family: "Microsoft YaHei", "PingFang SC", sans-serif; color: #111318; margin: 0; }
  .page { page-break-after: always; padding: 10mm 12mm; }
  .page:last-child { page-break-after: auto; }
  h1 { font-size: 22pt; margin: 4mm 0; }
  h2 { font-size: 14pt; margin: 3mm 0 2mm; border-bottom: 1.5pt solid #111318; padding-bottom: 1mm; }
  table { border-collapse: collapse; width: 100%; font-size: 9pt; }
  th, td { border: 0.5pt solid #444; padding: 1.2mm 2mm; text-align: left; }
  th { background: #f0f1f4; }
  .meta { font-size: 9pt; color: #444; margin: 2mm 0; }
  .cover-table { width: 70%; margin: 8mm 0; font-size: 11pt; }
  .cover-table td { height: 10mm; }
  .cabinet-head { display: flex; justify-content: space-between; align-items: baseline; }
  .cabinet-spec { font-size: 10pt; }
  .triptych { display: flex; gap: 3mm; margin: 2mm 0; }
  .triptych figure { margin: 0; flex: 1; min-width: 0; }
  .triptych svg { width: 100%; height: 62mm; border: 0.5pt solid #999; background: #fff; }
  .triptych figcaption { font-size: 8.5pt; text-align: center; color: #444; padding: 0.8mm 0; }
  .mat-line { font-size: 9pt; margin: 1.5mm 0; }
  @page { size: A4 landscape; margin: 0; }
  @media print { .no-print { display: none; } }
  .print-hint { background: #fffbe6; border: 0.5pt solid #e0c96b; padding: 2mm 3mm; font-size: 9pt; margin-bottom: 3mm; }
`;

export function roomBookHtml(book: RoomBook): string {
  const parts: string[] = [];

  // ── 封面 ──
  parts.push(`<section class="page">`);
  parts.push(`<div class="print-hint no-print">打印成 PDF：浏览器菜单 → 打印 → 目标选「另存为 PDF」→ 布局「横向」→ 勾选「背景图形」。</div>`);
  parts.push(`<h1>${esc(book.projectName)} · 图纸册</h1>`);
  parts.push(`<div class="meta">客户信息（签订时填写）</div>`);
  parts.push(`<table class="cover-table"><tr><th>客户</th><td></td><th>电话</th><td></td></tr>`);
  parts.push(`<tr><th>地址</th><td colspan="3"></td></tr>`);
  parts.push(`<tr><th>出图日期</th><td>${new Date().toISOString().slice(0, 10)}</td><th>图纸册编号</th><td>${esc(book.modelVersion)}</td></tr></table>`);
  parts.push(`<h2>版本三件套（生产数据可复现红线）</h2>`);
  parts.push(`<table><tr><th>模型版本</th><td>${esc(book.modelVersion)}</td><th>生成器版本</th><td>${esc(book.generatorVersion)}</td><th>规则集</th><td>${esc(book.ruleSetId)}（${esc(book.ruleSetName)}）</td></tr></table>`);
  parts.push(`<h2>项目概况</h2>`);
  parts.push(`<table><tr><th>房间数</th><td>${book.sections.filter((s) => s.roomId !== '').length}</td><th>柜体数</th><td>${book.totals.cabinets}</td><th>板件种类</th><td>${book.totals.panelKinds}</td><th>板件总数</th><td>${book.totals.panelPieces}</td><th>甲购件</th><td>${book.totals.purchased}</td></tr></table>`);
  parts.push(`</section>`);

  // ── 每房间每柜 ──
  for (const sec of book.sections) {
    parts.push(`<section class="page">`);
    parts.push(`<h2>${esc(sec.roomName)}</h2>`);
    for (const c of sec.cabinets) {
      parts.push(`<div class="cabinet-head"><h3 style="margin:2mm 0">${esc(c.name)} <span style="color:#666;font-size:9pt">${esc(c.id)}</span></h3>`);
      parts.push(`<div class="cabinet-spec">W ${c.width} × H ${c.height} × D ${c.depth} mm</div></div>`);
      parts.push(`<div class="mat-line">板材：${esc(c.boardMaterial)}　背板：${esc(c.backMaterial)}${c.doorMaterial ? `　门板：${esc(c.doorMaterial)}` : ''}</div>`);
      parts.push(`<div class="triptych">`);
      parts.push(`<figure>${c.planSvg}<figcaption>平面图</figcaption></figure>`);
      parts.push(`<figure>${c.frontSvg}<figcaption>立面外观（门板图）</figcaption></figure>`);
      parts.push(`<figure>${c.internalSvg}<figcaption>立面结构（内视图）</figcaption></figure>`);
      parts.push(`</div>`);
      if (c.hardware.length > 0) {
        parts.push(`<table><tr><th>五金</th><th>数量</th><th>规格</th></tr>`);
        for (const h of c.hardware) parts.push(`<tr><td>${esc(h.nameZh)}</td><td>${h.qty}</td><td>${esc(h.spec)}</td></tr>`);
        parts.push(`</table>`);
      }
      if (c.purchased.length > 0) {
        parts.push(`<table style="margin-top:1.5mm"><tr><th>甲购/外采件</th><th>材质</th><th>规格</th><th>数量</th></tr>`);
        for (const p of c.purchased) parts.push(`<tr><td>${esc(p.nameZh)}</td><td>${esc(p.material)}</td><td>${esc(p.spec)}</td><td>${p.qty}</td></tr>`);
        parts.push(`</table>`);
      }
    }
    parts.push(`</section>`);
  }

  // ── 尾页汇总 ──
  parts.push(`<section class="page">`);
  parts.push(`<h2>清单汇总（按柜归类）</h2>`);
  parts.push(`<table><tr><th>房间</th><th>柜体</th><th>板件种类</th><th>板件总数</th><th>五金种类</th><th>五金总数</th><th>甲购件</th></tr>`);
  for (const s of book.summary) {
    parts.push(`<tr><td>${esc(s.room)}</td><td>${esc(s.cabinet)}</td><td>${s.panelKinds}</td><td>${s.panelPieces}</td><td>${s.hardwareKinds}</td><td>${s.hardwarePieces}</td><td>${s.purchased}</td></tr>`);
  }
  parts.push(`</table>`);
  parts.push(`<p class="meta">生成：${esc(book.generatorVersion)} · 模型 ${esc(book.modelVersion)} · 规则集 ${esc(book.ruleSetId)} —— 首批生产必须人工全检。</p>`);
  parts.push(`</section>`);

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(book.projectName)} · 图纸册</title><style>${CSS}</style></head><body>${parts.join('')}</body></html>`;
}
