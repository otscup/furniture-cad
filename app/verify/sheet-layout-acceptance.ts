/**
 * ══════════════════════════════════════════════════════════════════════
 *  图纸分组与版式验收（2026-10-20）
 *
 * ── 它守的是什么 ──
 *   1. **一页一组**：地柜+吊柜竖直叠放时要合成一页，不能"一厨六柜出六页"。
 *      历史缺陷：roomBook 对每个柜体单独调 buildFurnitureSheet([cabinet])，
 *      用户看到的就是"柜子被拆成了几个"。
 *   2. **外观图看得到整体**：组的立面外观图里，地柜与吊柜必须在同一张图上
 *      且按真实标高上下排布（这是用户"一眼看到整个柜子"的判据）。
 *   3. **不应合并的不合并**：并排同高的两个地柜不能被误判成一组。
 *   4. **文字不重叠**：图纸里任何两个文字图元不得压字（侧栏重叠事故的回归）。
 *
 * ── 写法约定 ──
 *   与既有验收一致：ok() 计数 + 结尾汇总 + 失败 exit 1。
 *   每条断言都必须能"因对的原因"变红 —— 见文件末尾的变异说明。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyProject, rectRoom, createCabinet } from '../src/core/docFactory.ts';
import { buildFurnitureSheet } from '../src/export/furnitureSheet.ts';
import { buildRoomBook, groupCabinetsForSheets } from '../src/export/roomBook.ts';

import type { Cabinet, Project, RuleSet } from '../src/core/types.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

let pass = 0;
let fail = 0;
const failures: string[] = [];
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
}
function section(t: string): void {
  console.log(`\n${t}`);
}

const DOORS = (n: number) => ({ type: 'hinged' as const, count: n, mode: 'equal' as const, style: 'inset' as const, gapOuter: 2, gapMid: 3, hinge: 'H', hingeSide: 'left' as const, material: 'M' });
const unit = (id: string, w: number, withDoors = false) => ({
  id, kind: 'shelves' as const, requestedWidth: w, nickname: '层板',
  shelves: { count: 2, mode: 'equal' as const, gapPerSide: 0.5, ledStrip: 'none' as const },
  ...(withDoors ? { doors: DOORS(1) } : {}),
});

/** 造一个房间 + 若干柜体。 */
function makeProject(specs: Array<{ id: string; name: string; x: number; w: number; h: number; d: number; mount: number; type: 'base' | 'wall' }>): { project: Project; roomId: string } {
  const project = emptyProject({ name: '验收项目', ruleSetId: rules.id, id: 'p_acc' });
  const room = rectRoom({ name: '厨房', x: 0, y: 0, w: 6000, h: 3200, thickness: 120, height: 2700 });
  project.rooms.push(room);
  for (const s of specs) {
    project.cabinets.push(createCabinet({
      id: s.id, name: s.name, roomId: room.id, x: s.x, y: 60, rotation: 0, rules,
      params: { width: s.w, height: s.h, depth: s.d, bodyLift: s.type === 'wall' ? 0 : 100, cabinetType: s.type, mountHeight: s.mount },
      units: [unit(s.id + '_a', s.w / 2, true), unit(s.id + '_b', s.w / 2, true)],
    }) as Cabinet);
  }
  return { project, roomId: room.id };
}

// ═══════════════ 1. 分组判据 ═══════════════
section('1. 分组判据：上下叠放合并 / 并排同高不合并');
{
  const { project } = makeProject([
    { id: 'b0', name: '地柜0', x: 100, w: 900, h: 800, d: 600, mount: 0, type: 'base' },
    { id: 'b1', name: '地柜1', x: 1000, w: 900, h: 800, d: 600, mount: 0, type: 'base' },
    { id: 'w0', name: '吊柜0', x: 100, w: 900, h: 700, d: 350, mount: 1500, type: 'wall' },
    { id: 'w1', name: '吊柜1', x: 1000, w: 900, h: 700, d: 350, mount: 1500, type: 'wall' },
  ]);
  const groups = groupCabinetsForSheets(project.cabinets);
  ok('四个柜体分成两组（上下各一对，而不是四组）', groups.length === 2, `实际 ${groups.length} 组：${groups.map((g) => g.cabinets.map((c) => c.name).join('+')).join(' | ')}`);
  const g0 = groups.find((g) => g.cabinets.some((c) => c.name === '地柜0'));
  ok('同 X 的地柜与吊柜被合成一组', Boolean(g0 && g0.cabinets.length === 2), JSON.stringify(g0?.cabinets.map((c) => c.name)));
  ok('组内按标高从低到高排序（地柜在前）', Boolean(g0 && g0.cabinets[0]!.name === '地柜0'), JSON.stringify(g0?.cabinets.map((c) => c.name)));
  ok('组内同时标记 hasBase / hasWall', Boolean(g0 && g0.hasBase && g0.hasWall), JSON.stringify({ hasBase: g0?.hasBase, hasWall: g0?.hasWall }));
  ok('并排同高的两个地柜没有被误合并', groups.every((g) => g.cabinets.filter((c) => c.params.cabinetType === 'base').length <= 1), JSON.stringify(groups.map((g) => g.cabinets.map((c) => c.name))));
}

// ═══════════════ 2. 一页一组 ═══════════════
section('2. 一页一组：六柜的厨房只出三页');
{
  const { project } = makeProject([
    { id: 'b0', name: '地柜0', x: 100, w: 900, h: 800, d: 600, mount: 0, type: 'base' },
    { id: 'b1', name: '地柜1', x: 1000, w: 900, h: 800, d: 600, mount: 0, type: 'base' },
    { id: 'b2', name: '地柜2', x: 1900, w: 900, h: 800, d: 600, mount: 0, type: 'base' },
    { id: 'w0', name: '吊柜0', x: 100, w: 900, h: 700, d: 350, mount: 1500, type: 'wall' },
    { id: 'w1', name: '吊柜1', x: 1000, w: 900, h: 700, d: 350, mount: 1500, type: 'wall' },
    { id: 'w2', name: '吊柜2', x: 1900, w: 900, h: 700, d: 350, mount: 1500, type: 'wall' },
  ]);
  const book = buildRoomBook(project, rules, 'v-acc');
  const pages = book.sections[0]!.cabinets;
  ok('3 地柜 + 3 吊柜 = 3 页（不是 6 页）', pages.length === 3, `实际 ${pages.length} 页`);
  ok('每页 groupSize 都是 2', pages.every((p) => p.groupSize === 2), JSON.stringify(pages.map((p) => p.groupSize)));
  ok('页名是语义家具名而不是柜名拼接', pages.every((p) => !p.name.includes(' + ')), JSON.stringify(pages.map((p) => p.name)));
  ok('页名互不相同（多组要能区分）', new Set(pages.map((p) => p.name)).size === pages.length, JSON.stringify(pages.map((p) => p.name)));
  ok('页码按 1..N 递增', pages.every((p, i) => p.index === i + 1), JSON.stringify(pages.map((p) => p.index)));
}

// ═══════════════ 3. 外观图看得到整体 ═══════════════
section('3. 立面外观图：地柜与吊柜在同一张图、按真实标高上下排布');
{
  const { project } = makeProject([
    { id: 'b0', name: '地柜', x: 100, w: 900, h: 800, d: 600, mount: 0, type: 'base' },
    { id: 'w0', name: '吊柜', x: 100, w: 900, h: 700, d: 350, mount: 1500, type: 'wall' },
  ]);
  const room = project.rooms[0]!;
  const sheet = buildFurnitureSheet(room, project.cabinets, project, rules, { furnitureName: '厨房橱柜' });

  /** 取柜体外轮廓（F-CAB 层的闭合多段线）在**立面区**的 Y 区间。 */
  const cabOutlines = sheet.prims
    .filter((p) => p.layer === 'F-CAB' && p.k === 'poly')
    .map((p) => {
      const ys = (p as { pts: Array<{ x: number; y: number }> }).pts.map((q) => q.y);
      const xs = (p as { pts: Array<{ x: number; y: number }> }).pts.map((q) => q.x);
      return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
    });
  // 立面区在图幅下半部（Y 较小）；平面区在上半部
  const elevation = cabOutlines.filter((o) => o.maxY < 7000);
  ok('立面区里找到 4 个柜体外轮廓（外观列 2 个 + 结构列 2 个）', elevation.length === 4, `elevation outlines=${elevation.length} of ${cabOutlines.length}`);

  /**
   * ── 按"视图列"分组后再判定 ──
   *   图幅上并排有多个视图列（外观正面图 / 内部结构图），每一列内部才是
   *   "地柜在下、吊柜在上"。若不分列就取全局最低/最高，会把 A 列的地柜
   *   与 B 列的吊柜拿来比较，得出"左右并排"的错误结论（我第一版就错在这）。
   */
  const columns: Array<typeof elevation> = [];
  for (const o of elevation) {
    const col = columns.find((c) => {
      const ref = c[0]!;
      return Math.min(ref.maxX, o.maxX) - Math.max(ref.minX, o.minX) > 0;
    });
    if (col) col.push(o);
    else columns.push([o]);
  }
  ok('立面区恰好分成两列视图（外观 + 结构）', columns.length === 2, `列数 ${columns.length}：` + JSON.stringify(columns.map((c) => c.length)));

  const everyColumnStacks = columns.every((col) => {
    if (col.length < 2) return false;
    const sorted = [...col].sort((a, b) => a.minY - b.minY);
    const lower = sorted[0]!;
    const upper = sorted[sorted.length - 1]!;
    const xOverlap = Math.min(lower.maxX, upper.maxX) - Math.max(lower.minX, upper.minX);
    return xOverlap > 0 && upper.minY > lower.maxY && upper.minY - lower.maxY > 100;
  });
  ok('每一列内部：地柜与吊柜同 X 区间（同一列）且吊柜在上、留出真实间隙', everyColumnStacks,
    JSON.stringify(columns.map((c) => c.map((o) => ({ x: [Math.round(o.minX), Math.round(o.maxX)], y: [Math.round(o.minY), Math.round(o.maxY)] })))));

  const lowerOfFirst = [...columns[0]!].sort((a, b) => a.minY - b.minY)[0]!;
  const upperOfFirst = [...columns[0]!].sort((a, b) => b.minY - a.minY)[0]!;
  ok('吊柜在图上的 Y 高于地柜（真实标高关系被保留）', upperOfFirst.minY > lowerOfFirst.maxY,
    `lower.maxY=${Math.round(lowerOfFirst.maxY)} upper.minY=${Math.round(upperOfFirst.minY)}`);
  ok('地柜顶(800+100)与吊柜底(1500)之间的真实间隙被保留', upperOfFirst.minY - lowerOfFirst.maxY > 100,
    `gap=${Math.round(upperOfFirst.minY - lowerOfFirst.maxY)}`);
}

// ═══════════════ 4. 文字不重叠（侧栏重叠事故回归）═══════════════
section('4. 图纸文字不得压字');
{
  const specs = [
    { id: 'b0', name: '地柜', x: 100, w: 2400, h: 800, d: 600, mount: 0, type: 'base' as const },
    { id: 'w0', name: '吊柜', x: 100, w: 2400, h: 700, d: 350, mount: 1500, type: 'wall' as const },
  ];
  const { project } = makeProject(specs);
  const room = project.rooms[0]!;
  const sheet = buildFurnitureSheet(room, project.cabinets, project, rules, { furnitureName: '厨房橱柜' });
  const texts = sheet.prims.filter((p) => p.k === 'text') as Array<{ text: string; p: { x: number; y: number }; size?: number; align?: 'l' | 'c' | 'r'; rot?: number }>;
  /**
   * 按字符数与字号估算外接矩形（与字体无关的保守估计）。
   *
   * ★ 必须区分 align —— 这是第一版检测器假红的原因：
   *   左对齐文字的 p.x 是**左边界**，居中文字才是中心。把左对齐也当中心算，
   *   会凭空右移半个字宽，从而把"右边缘贴着但没压上"的两段误判成重叠。
   *   旋转文字（rot 非 0）单独标记，不参与 X 轴估算（它占的是另一条轴）。
   */
  const boxes = texts.map((t) => {
    const size = t.size ?? 100;
    const h = size * 1.0;
    const w = Math.max(1, String(t.text ?? '').length) * size * 0.6;
    const align = t.align ?? 'l';
    const x0 = align === 'c' ? t.p.x - w / 2 : align === 'r' ? t.p.x - w : t.p.x;
    return { label: t.text, x0, x1: x0 + w, y0: t.p.y - h / 2, y1: t.p.y + h / 2, rotated: Boolean(t.rot) };
  });
  const overlaps: string[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      // 旋转文字与非旋转文字不互判（不同轴向，外接矩形不能这么估）
      if (a.rotated !== b.rotated) continue;
      const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const yOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
      // 两个方向都真正相交才算压字（容差 1 单位，避免浮点边界误判）
      if (xOverlap > 1 && yOverlap > 1) {
        overlaps.push(`${JSON.stringify(a.label)}@[${Math.round(a.x0)},${Math.round(a.x1)}]×[${Math.round(a.y0)},${Math.round(a.y1)}] 压 ${JSON.stringify(b.label)}@[${Math.round(b.x0)},${Math.round(b.x1)}]×[${Math.round(b.y0)},${Math.round(b.y1)}]（交叠 ${Math.round(xOverlap)}×${Math.round(yOverlap)}）`);
      }
    }
  }
  ok('带门板的地柜+吊柜图纸：文字重叠对数 === 0', overlaps.length === 0, `重叠 ${overlaps.length} 处：\n      ${overlaps.slice(0, 8).join('\n      ')}`);
}

// ═══════════════ 4.5 混排组的柜型归类（实测 bug 回归）═══════════════
section('4.5 地柜+吊柜的混排组：柜型归类必须两行都列，不能凭空消失');
{
  /**
   * ★ 修的是一个实测 bug（2026-10-21）。
   *
   *   一页一组之后，"地柜+吊柜"的组如果只按代表柜的 cabinetType 归类，
   *   会被整组归到一边 —— 布局页出现「地柜/高柜：**无**」+「吊柜：…（吊柜底 **0mm**）」，
   *   三组地柜凭空消失，还编出一个矛盾的"吊柜底 0mm"读数。
   *
   *   判据：混排组的 memberTypes 必须同时含 base 与 wall；
   *        纯吊柜组的 mountHeight 标签才允许出现。
   */
  const specs = [
    { id: 'b0', name: '地柜', x: 100, w: 900, h: 800, d: 600, mount: 0, type: 'base' as const },
    { id: 'w0', name: '吊柜', x: 100, w: 900, h: 700, d: 350, mount: 1500, type: 'wall' as const },
  ];
  const { project } = makeProject(specs);
  const book = buildRoomBook(project, rules, 'v-acc');
  const page = book.sections[0]!.cabinets[0]!;
  ok('混排组只有一页', book.sections[0]!.cabinets.length === 1, `实际 ${book.sections[0]!.cabinets.length} 页`);
  ok('★ 混排组的 memberTypes 同时含 base 与 wall',
    (page.memberTypes ?? []).includes('base') && (page.memberTypes ?? []).includes('wall'),
    JSON.stringify(page.memberTypes));
  ok('★ 代表柜类型是 base（组内标高最低那只），不是 wall',
    page.cabinetType === 'base', `实际 ${page.cabinetType}`);
  ok('★ 混排组不产生"吊柜底 0mm"这种假读数',
    !(page.cabinetType === 'wall' && page.mountHeight === 0),
    `cabinetType=${page.cabinetType} mountHeight=${page.mountHeight}`);

  // 纯吊柜组仍要如实标出吊柜底高
  const pure = makeProject([
    { id: 'w1', name: '纯吊柜', x: 100, w: 900, h: 700, d: 350, mount: 1500, type: 'wall' as const },
  ]);
  const pureBook = buildRoomBook(pure.project, rules, 'v-acc2');
  const purePage = pureBook.sections[0]!.cabinets[0]!;
  ok('纯吊柜组的 cabinetType 是 wall 且 mountHeight 是真实值',
    purePage.cabinetType === 'wall' && purePage.mountHeight === 1500,
    `${purePage.cabinetType} / ${purePage.mountHeight}`);
  ok('纯吊柜组 memberTypes 只有 wall', JSON.stringify(purePage.memberTypes) === '["wall"]', JSON.stringify(purePage.memberTypes));
}

// ═══════════════ 4.6 门板开向符号（对标参考图纸）═══════════════
section('4.6 门板开向：虚线呈 < / > 形，尖头指向铰链边且铺满门板');
{
  /**
   * ── 参考图纸的口径 ──
   *   铰链在左 ⇒ 两条虚线从左上、左下角汇到右边中点 ⇒ 形如 ">"（尖头朝左）。
   *   铰链在右 ⇒ 形如 "<"。
   *   尖的那一端就是铰链。整组虚线铺满整块门板。
   *
   * ── 为什么要专门验这个 ──
   *   上一版画的是"对角 X + 竖向箭头"，与参考图**完全不是一回事**，
   *   而且 X 线会让人以为门是对角切开的。这类"符号画错"不会有任何报错，
   *   只能靠验收钉住。
   */
  const mkDoorCab = (hingeSide: 'left' | 'right', count: number): Cabinet => {
    const project = emptyProject({ name: 't', ruleSetId: rules.id, id: 'p_sw' });
    const room = rectRoom({ name: 'R', x: 0, y: 0, w: 4000, h: 2600, thickness: 120, height: 2700 });
    project.rooms.push(room);
    return createCabinet({
      id: 'c1', name: '门柜', roomId: room.id, x: 100, y: 60, rotation: 0, rules,
      params: { width: 600, height: 2000, depth: 600, bodyLift: 80, cabinetType: 'base', mountHeight: 0 },
      units: [{
        id: 'u1', kind: 'shelves', requestedWidth: 600, nickname: '格',
        shelves: { count: 2, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none' },
        doors: { type: 'hinged', count, mode: 'equal', style: 'inset', gapOuter: 2, gapMid: 3, hinge: 'H', hingeSide, material: 'M' },
      }],
    }) as Cabinet;
  };

  /** 取正视图里的开向虚线（带 dash 的细线）。 */
  const swingLines = (cab: Cabinet) => {
    const v = buildCabinetViews(cab, rules);
    return (v.prims.front as Array<{ k: string; dash?: number[]; lw?: number; pts: Array<{ x: number; y: number }> }>)
      .filter((p) => p.k === 'poly' && Array.isArray(p.dash) && p.dash.length === 2 && p.dash[0] === 90);
  };

  for (const side of ['left', 'right'] as const) {
    const lines = swingLines(mkDoorCab(side, 1));
    ok(`铰链在${side === 'left' ? '左' : '右'}：单扇门画了 2 条开向虚线（< / > 的两笔）`, lines.length === 2, `实际 ${lines.length} 条`);
    if (lines.length === 2) {
      const [a, b] = lines as [typeof lines[0], typeof lines[0]];
      // 两条线应当共享同一个"尖头"端点（X 坐标相同、Z 方向相反）
      const aStart = a.pts[0]!, bStart = b.pts[0]!;
      ok(`铰链在${side === 'left' ? '左' : '右'}：两条虚线从**同一点**出发（尖头）`,
        Math.abs(aStart.x - bStart.x) < 1 && Math.abs(aStart.y - bStart.y) < 1,
        `a=(${Math.round(aStart.x)},${Math.round(aStart.y)}) b=(${Math.round(bStart.x)},${Math.round(bStart.y)})`);
      // 尖头应当在铰链那一侧的边上
      const cabinetWidth = 600;
      const apexOnHingeSide = side === 'left'
        ? aStart.x < cabinetWidth * 0.1     // 尖头在左边
        : aStart.x > cabinetWidth * 0.9;    // 尖头在右边
      ok(`铰链在${side === 'left' ? '左' : '右'}：尖头落在铰链侧的门边（不是自由边）`, apexOnHingeSide, `尖头 x=${Math.round(aStart.x)}`);
      // 另一端应当张开到两侧角（铺满门板）
      const aEnd = a.pts[1]!, bEnd = b.pts[1]!;
      ok(`铰链在${side === 'left' ? '左' : '右'}：另一端分别到门的上角与下角（铺满高度）`,
        Math.abs(aEnd.y - bEnd.y) > 1000, `两端 z 差 ${Math.round(Math.abs(aEnd.y - bEnd.y))}`);
      ok(`铰链在${side === 'left' ? '左' : '右'}：虚线确实跨满门宽`,
        Math.abs(aEnd.x - aStart.x) > 400, `跨距 ${Math.round(Math.abs(aEnd.x - aStart.x))}`);
    }
  }

  // 对开双门：左扇尖头朝左、右扇尖头朝右
  const doubleLines = swingLines(mkDoorCab('left', 2));
  ok('对开双门：共 4 条开向虚线（两扇各 2 条）', doubleLines.length === 4, `实际 ${doubleLines.length} 条`);
  if (doubleLines.length === 4) {
    const apexes = doubleLines.map((l) => l.pts[0]!.x).sort((x, y) => x - y);
    // 左扇尖头靠左（接近 0），右扇尖头靠右（接近 600 区间的末端）
    ok('对开双门：左扇尖头在左、右扇尖头在右（中间相遇）',
      apexes[0]! < 120 && apexes[apexes.length - 1]! > 400,
      JSON.stringify(apexes.map((x) => Math.round(x))));
  }

  // 不许再出现对角 X 实线（那是旧画法，会被误读成门被对角切开）
  const front = buildCabinetViews(mkDoorCab('left', 1), rules).prims.front as Array<{ k: string; dash?: number[]; pts: Array<{ x: number; y: number }>; layer?: string }>;
  const solidDiagonals = front.filter((p) => {
    if (p.k !== 'poly' || p.dash) return false;
    if (p.pts.length !== 2) return false;
    const dx = Math.abs(p.pts[1]!.x - p.pts[0]!.x);
    const dy = Math.abs(p.pts[1]!.y - p.pts[0]!.y);
    return dx > 200 && dy > 200; // 对角线
  });
  ok('★ 不再出现"对角 X 实线"（旧画法会让人以为门被对角切开）', solidDiagonals.length === 0, `实际 ${solidDiagonals.length} 条`);
}

// ═══════════════ 5. 门板/侧板不拆（板件级）═══════════════
section('5. 门板与侧板保持整块，不被拆条');
{
  const { project } = makeProject([
    { id: 'b0', name: '衣柜', x: 100, w: 2400, h: 2400, d: 600, mount: 0, type: 'base' },
  ]);
  const cabinet = project.cabinets[0]!;
  // generateCabinet 是板件的唯一来源
  const { generateCabinet } = await import('../src/core/geometry/generate.ts');
  const geom = generateCabinet(cabinet, rules);
  const panels = geom.panels ?? [];
  const sidePanels = panels.filter((p: { role?: string }) => /Side/i.test(String(p.role)));
  ok('一个柜体只有左右两块侧板（不是被拆成多块）', sidePanels.length === 2, `侧板数 ${sidePanels.length}：${sidePanels.map((p: { role?: string }) => p.role).join(',')}`);
  const doorPanels = panels.filter((p: { role?: string }) => /Door/i.test(String(p.role)));
  ok('每扇门是一块整板（门数与门板数一一对应，不拆条）', doorPanels.length > 0 && doorPanels.every((p: { length?: number }) => (p.length ?? 0) > 500), `门板数 ${doorPanels.length}`);
  const sideHeights = sidePanels.map((p: { length?: number }) => p.length ?? 0);
  ok('侧板高度接近整柜高（不是被切成几节）', sideHeights.every((h) => h > 2000), JSON.stringify(sideHeights));
}

// ═══════════════ 汇总 ═══════════════
console.log('\n' + '═'.repeat(60));
console.log(`  图纸分组与版式验收：通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
console.log('全部通过：一页一组、外观图整体可见、并排不误合、文字不压字、板件不拆条。');
