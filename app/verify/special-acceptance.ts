/**
 * 异形图元验收（Phase E）。
 *
 * 覆盖方案文档 §7 末项「异形图元」四类需求：
 *   1. 酒柜斜层板（结构异形 → 图元扩展）：tilt 语义落地、板件真实裁切长
 *      realLen = 水平跨度 / cos(tilt)、板件名「斜层板-k」、edge 标注含公式；
 *   2. 圆弧见光板 R36（表达异形 → 命名 + 侧视图圆弧，不改结构板数量）：
 *      外露端板命名「见光板-左/右」、edge 标注前缘 R36、四视图画圆弧；
 *   3. L 型转角干涉检查（结构异形 → 独立校验文件）：内端铰链门摆圆扫到邻柜
 *      产出 CORNER-DOOR-SWING WARNING（软建议，不阻断）；负样本不误报；
 *   4. 命令总线白名单放行 finishedEnds 与 shelves.tilt（语义字段唯一写入口）。
 *
 * 设计纪律：所有派生量从同一份语义模型现算，断言抓「真派生值」，
 * 不靠字符串巧合；验收方法论（见主方案）—— 先假定自己错，再把视觉约定转成硬断言。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Cabinet, Project, RuleSet } from '../src/core/types.ts';
import { createCabinetFromTemplate, sampleProject } from '../src/core/docFactory.ts';
import { generateCabinet } from '../src/core/geometry/generate.ts';
import { buildCabinetViews } from '../src/core/geometry/views.ts';
import { computeCabinetLayout } from '../src/core/geometry/layout.ts';
import { validateCornerInterference } from '../src/core/rules/corner.ts';
import { CommandBus } from '../src/core/commandBus.ts';
import { compileCorrections } from '../src/ai/memory.ts';
import { loadCorrections } from '../src/ai/correctionStore.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const rules = JSON.parse(readFileSync(join(root, 'src', 'core', 'ruleset', 'factory-default.json'), 'utf8')) as RuleSet;

const TOL = 1.0; // mm：圆弧半径 / 角点容差
let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
    console.log(`  ✗ ${name} —— ${detail}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

// ── 公共夹具 ──
const makeWine = (params?: Record<string, unknown>): Cabinet =>
  createCabinetFromTemplate({ templateId: 'wine_cabinet', name: '酒柜A', roomId: 'room1', x: 0, y: 0, rotation: 0, rules, params: params as never });

const clone = (c: Cabinet): Cabinet => JSON.parse(JSON.stringify(c)) as Cabinet;

// ════════════════════════════════════════════════════════════════
section('1. 模板 wine_cabinet：tilt 语义落地、默认显式');
{
  const wine = makeWine();
  const u = wine.layout.units[0]!;
  ok('wine_cabinet 单分区 shelves.tilt = 12（模板 → makeUnit → layout 同源）', u.shelves?.tilt === 12, `tilt=${u.shelves?.tilt}`);
  ok('shelves.ledStrip 显式默认 none（不靠字段缺失表达状态）', u.shelves?.ledStrip === 'none');
  ok('shelves.count = 6 与模板一致', u.shelves?.count === 6, `count=${u.shelves?.count}`);
  ok('柜体外形参数来自模板（宽 600 / 高 2000 / 深 350）',
    wine.params.width === 600 && wine.params.height === 2000 && wine.params.depth === 350,
    `${wine.params.width}/${wine.params.height}/${wine.params.depth}`);
  // 对照：default 模板 tilt 必须默认 0（显式补齐，不是缺失）
  const def = createCabinetFromTemplate({ templateId: 'default', roomId: 'room1', x: 0, y: 0, rules });
  ok('default 模板 shelves.tilt 显式 = 0（非 undefined）', def.layout.units.every((x) => (x.shelves?.tilt ?? 0) === 0));
}

// ════════════════════════════════════════════════════════════════
section('2. 斜层板板件：nameZh / realLen / edgeLabel（结构图元扩展）');
{
  const wine = makeWine();
  const L = computeCabinetLayout(wine, rules);
  const netW = L.nets[0]!;
  const g = generateCabinet(wine, rules);
  const shelves = g.panels.filter((p) => p.role === 'ShelfPanel');
  ok('斜层板数量 = 6', shelves.length === 6, `n=${shelves.length}`);
  ok('全部板件名「斜层板-k」', shelves.every((p) => p.nameZh.startsWith('斜层板-')), JSON.stringify(shelves.map((p) => p.nameZh)));

  // realLen = round((netW - 2*gapPerSide) / cos(tilt))，gapPerSide 默认 0.5
  const tilt = 12;
  const shelfW = netW - 2 * 0.5;
  const expectedRealLen = Math.max(1, Math.round(shelfW / Math.cos((tilt * Math.PI) / 180)));
  ok(`realLen = round(${shelfW}mm ÷ cos${tilt}°) = ${expectedRealLen}mm 全部板件长度达标`, shelves.every((p) => p.length === expectedRealLen), `got=${shelves.map((p) => p.length)}`);
  ok('realLen 严格大于水平跨度（斜板更长，非水平板件）', expectedRealLen > shelfW, `realLen=${expectedRealLen} shelfW=${shelfW}`);

  // edge 标注必须携带裁切长公式，让生产看到「为什么这块板比分区宽长」
  const labeled = shelves.every((p) => p.edgeLabel.includes(`斜 ${tilt}°`) && p.edgeLabel.includes('裁切长') && p.edgeLabel.includes(`${expectedRealLen}mm`));
  ok('edge 标注含「斜 12° / 裁切长 / 真实 mm 数」三段（生产可追溯）', labeled, shelves[0]?.edgeLabel ?? '');

  // 同源交叉：四视图立面斜层板也用同一 realLen（generate.ts elevation 用 netW + shift，板件长守恒）
  const R = buildCabinetViews(wine, rules);
  const shelfPolys = R.prims.internal.filter((p) => p.k === 'poly' && p.closed && p.pts.length === 4);
  ok('内部结构图斜层板画成平行四边形（4 点闭合 poly）', shelfPolys.length >= 6, `polys=${shelfPolys.length}`);

  // tilt=0 对照组：同一酒柜模板把 tilt 归零，板件名「层板-k」、realLen === shelfW（与旧行为一致）
  const flat = makeWine();
  flat.layout.units.forEach((x) => { if (x.shelves) x.shelves.tilt = 0; });
  const gf = generateCabinet(flat, rules);
  const flatShelves = gf.panels.filter((p) => p.role === 'ShelfPanel');
  ok('tilt=0 时板件名「层板-k」、长度 = 水平跨度（斜板不变量不污染平层板）',
    flatShelves.length > 0 && flatShelves.every((p) => p.nameZh.startsWith('层板-') && p.length === Math.round((L.nets[0]! - 1))),
    JSON.stringify(flatShelves.slice(0, 3).map((p) => [p.nameZh, p.length])));
}

// ════════════════════════════════════════════════════════════════
section('3. 圆弧见光板 R36（表达异形：命名 + edge 标注，不改结构板数）');
{
  const base = makeWine();
  const g0 = generateCabinet(base, rules);
  const nPanels0 = g0.panels.length;

  const fe = makeWine({ finishedEnds: 'both' } as never);
  const g = generateCabinet(fe, rules);
  ok('finishedEnds=both 不增加结构板件数（仅端板工艺表达）', g.panels.length === nPanels0, `both=${g.panels.length} none=${nPanels0}`);

  const left = g.panels.find((p) => p.role === 'LeftSidePanel');
  const right = g.panels.find((p) => p.role === 'RightSidePanel');
  ok('左端板命名「见光板-左」', left?.nameZh === '见光板-左', left?.nameZh ?? 'missing');
  ok('右端板命名「见光板-右」', right?.nameZh === '见光板-右', right?.nameZh ?? 'missing');
  ok('edge 标注含「前缘 R36 圆弧（工艺）」', !!left?.edgeLabel.includes('R36') && !!right?.edgeLabel.includes('R36'), `${left?.edgeLabel} | ${right?.edgeLabel}`);

  // none 对照：命名仍是「左侧板 / 右侧板」
  const noneLeft = g0.panels.find((p) => p.role === 'LeftSidePanel');
  ok('finishedEnds=none 端板命名「左侧板」（对照成立）', noneLeft?.nameZh === '左侧板', noneLeft?.nameZh ?? 'missing');

  // 单边：left 只改左端
  const feL = makeWine({ finishedEnds: 'left' } as never);
  const gL = generateCabinet(feL, rules);
  ok('finishedEnds=left 仅左端板命名「见光板-左」、右端仍「右侧板」',
    gL.panels.find((p) => p.role === 'LeftSidePanel')?.nameZh === '见光板-左' &&
    gL.panels.find((p) => p.role === 'RightSidePanel')?.nameZh === '右侧板',
    `${gL.panels.find((p) => p.role === 'LeftSidePanel')?.nameZh} / ${gL.panels.find((p) => p.role === 'RightSidePanel')?.nameZh}`);
}

// ════════════════════════════════════════════════════════════════
section('4. 四视图：见光板圆弧图元 + 假设标注');
{
  const fe = makeWine({ finishedEnds: 'both' } as never);
  const R = buildCabinetViews(fe, rules);
  const fxc = R.meta.front.origin.x;
  const fyc = R.meta.front.origin.y;
  const Lg = computeCabinetLayout(fe, rules);
  const t = Lg.boardT;
  const W = fe.params.width;
  const H = fe.params.height;

  /** 检测前视图里是否存在以 (cx,cy) 为圆心、半径≈r 的离散圆弧 poly */
  const hasQuarterCircle = (prims: typeof R.prims.front, cx: number, cy: number, r: number): boolean =>
    prims.some((p) => {
      if (p.k !== 'poly' || p.closed || p.pts.length < 3) return false;
      // 所有点都在半径 r±TOL 上，且分布在正确象限（上端角向外偏）
      return p.pts.every((q) => Math.abs(Math.hypot(q.x - cx, q.y - cy) - r) <= TOL) &&
        p.pts.length >= 4; // 离散成多段折线
    });

  // 前视图：左上端角 (t,H)、右上端角 (W-t,H)
  const arcL = hasQuarterCircle(R.prims.front, fxc + t, fyc + H, 36);
  const arcR = hasQuarterCircle(R.prims.front, fxc + (W - t), fyc + H, 36);
  ok('前视图左端角有 R36 圆弧（离散折线）', arcL, `cx=${fxc + t}`);
  ok('前视图右端角有 R36 圆弧（离散折线）', arcR, `cx=${fxc + W - t}`);

  // 侧视图：近端（左）端板前上角画圆弧
  const sxc = R.meta.side.origin.x;
  const syc = R.meta.side.origin.y;
  const faceY0 = fe.params.depth - t;
  const arcSide = hasQuarterCircle(R.prims.side, sxc + faceY0, syc + H, 36);
  ok('侧视图近端角有 R36 圆弧', arcSide);

  // none 对照：前视图不应有 R36 圆弧
  const R0 = buildCabinetViews(makeWine(), rules);
  ok('finishedEnds=none 前视图无 R36 圆弧（对照成立）',
    !hasQuarterCircle(R0.prims.front, R0.meta.front.origin.x + t, R0.meta.front.origin.y + H, 36));

  ok('assumptions 含见光板 R36 工艺说明', R.assumptions.some((a) => a.includes('见光板') && a.includes('R36')), R.assumptions.join(' | '));
  ok('assumptions 含斜层板裁切长说明', R.assumptions.some((a) => a.includes('斜层板') && a.includes('裁切')), R.assumptions.join(' | '));
}

// ════════════════════════════════════════════════════════════════
section('5. L 型转角干涉：正样本报 WARNING，负样本不误报（软建议不阻断）');
{
  // 注意：每个柜必须显式唯一 id —— validateCornerInterference 用 c.id 作 footprint/bbox 的 Map key，
  // 撞 id 会让 fps.get 串台、boxesOverlap(自己,自己)=true 被跳过，导致「假阴性」。
  // 正样本：A=鞋柜（带门，宽 900，内端朝墙角）在 (0,0) rot0；
  //        B=无门鞋柜（宽 900）在 (900,900) rot270（垂直，墙角相接）。
  // 共享角点 (900,0)；A 内端铰链门摆圆扫进 B footprint → WARNING。
  const A = createCabinetFromTemplate({ id: 'cA', templateId: 'shoe_cabinet', name: '转角柜A', roomId: 'r1', x: 0, y: 0, rotation: 0, rules });
  const B = createCabinetFromTemplate({ id: 'cB', templateId: 'shoe_cabinet', name: '转角柜B', roomId: 'r1', x: 900, y: 900, rotation: 270, rules });
  B.layout.units.forEach((u) => { u.doors = undefined; }); // B 无门：只验证 A 内端门扫进 B
  const pos: Project = { cabinets: [A, B] } as Project;
  const warn = validateCornerInterference(pos, rules).filter((i) => i.code === 'CORNER-DOOR-SWING');
  ok('正样本：产出 CORNER-DOOR-SWING WARNING', warn.length >= 1, `n=${warn.length} ${JSON.stringify(warn.map((i) => i.message))}`);
  ok('WARNING 不阻断生产（severity=WARNING，非 ERROR）', warn.every((i) => i.severity === 'WARNING'), JSON.stringify(warn.map((i) => i.severity)));
  ok('WARNING 含两柜名与可读建议', warn.every((i) => i.message.includes('转角柜A') && i.message.includes('转角柜B') && !!i.fixHint), JSON.stringify(warn.map((i) => i.message)));

  // 负样本 1：平行并排（不垂直）→ 不报
  const A1 = createCabinetFromTemplate({ id: 'n1a', templateId: 'shoe_cabinet', name: '平柜A', roomId: 'r2', x: 0, y: 0, rotation: 0, rules });
  const B1 = createCabinetFromTemplate({ id: 'n1b', templateId: 'shoe_cabinet', name: '平柜B', roomId: 'r2', x: 1200, y: 0, rotation: 0, rules });
  ok('负样本1（平行并排，不垂直）：无 CORNER-DOOR-SWING', validateCornerInterference({ cabinets: [A1, B1] } as Project, rules).filter((i) => i.code === 'CORNER-DOOR-SWING').length === 0);

  // 负样本 2：标准 L 相接（共角、垂直、不重叠）但两端都无门 → 不误报
  const A2 = createCabinetFromTemplate({ id: 'n2a', templateId: 'shoe_cabinet', name: '无门转角A', roomId: 'r3', x: 0, y: 0, rotation: 0, rules });
  const B2 = createCabinetFromTemplate({ id: 'n2b', templateId: 'shoe_cabinet', name: '无门转角B', roomId: 'r3', x: 900, y: 900, rotation: 270, rules });
  A2.layout.units.forEach((u) => { u.doors = undefined; });
  B2.layout.units.forEach((u) => { u.doors = undefined; });
  ok('负样本2（L 相接但两端无门）：无 CORNER-DOOR-SWING（不误报）', validateCornerInterference({ cabinets: [A2, B2] } as Project, rules).filter((i) => i.code === 'CORNER-DOOR-SWING').length === 0);

  // 负样本 3：同房间但相距很远（无共角点）→ 不报
  const A3 = createCabinetFromTemplate({ id: 'n3a', templateId: 'shoe_cabinet', name: '远柜A', roomId: 'r4', x: 0, y: 0, rotation: 0, rules });
  const B3 = createCabinetFromTemplate({ id: 'n3b', templateId: 'shoe_cabinet', name: '远柜B', roomId: 'r4', x: 3000, y: 3000, rotation: 90, rules });
  ok('负样本3（相距很远，无共角点）：无 CORNER-DOOR-SWING', validateCornerInterference({ cabinets: [A3, B3] } as Project, rules).filter((i) => i.code === 'CORNER-DOOR-SWING').length === 0);

  // 跨房间不报：同位置但不同 roomId
  const A4 = createCabinetFromTemplate({ id: 'n4a', templateId: 'shoe_cabinet', name: '跨房A', roomId: 'rx', x: 0, y: 0, rotation: 0, rules });
  const B4 = createCabinetFromTemplate({ id: 'n4b', templateId: 'shoe_cabinet', name: '跨房B', roomId: 'ry', x: 900, y: 900, rotation: 270, rules });
  ok('跨房间：即使几何相接也不报（按 roomId 分组）', validateCornerInterference({ cabinets: [A4, B4] } as Project, rules).filter((i) => i.code === 'CORNER-DOOR-SWING').length === 0);
}

// ════════════════════════════════════════════════════════════════
section('6. 命令总线白名单：finishedEnds 与 shelves.tilt 唯一写入口');
{
  // 用 sampleProject 构造合法 Project（含 rooms），再把酒柜并入，操作该柜。
  // 必须给 wine 显式 id：否则默认 id 也会是 cab_001，与 sampleProject 首柜撞车，find 命中错柜。
  const proj = sampleProject(rules);
  const wine = createCabinetFromTemplate({ templateId: 'wine_cabinet', id: 'wine_E', name: '酒柜A', roomId: 'room1', x: 0, y: 0, rotation: 0, rules });
  proj.cabinets.push(wine);
  const wb = new CommandBus(proj, rules);
  const cab = wb.getState().cabinets.find((c) => c.id === 'wine_E')!;
  const v0 = wb.getVersion();

  const r1 = wb.execute({ id: 'e1', op: 'cabinet.update', source: 'ui', target: { kind: 'cabinet', id: cab.id }, changes: [{ path: 'params.finishedEnds', op: 'set', value: 'both' }] }, '设见光板');
  const r2 = wb.execute({ id: 'e2', op: 'cabinet.layout', source: 'ui', target: { kind: 'cabinet', id: cab.id }, changes: [{ path: 'layout.units[0].shelves.tilt', op: 'set', value: 15 }] }, '设斜层板倾角');
  ok('白名单放行 finishedEnds 与 shelves.tilt（都执行、无 error、版本推进 2）',
    !r1.error && !r2.error && wb.getVersion() === v0 + 2,
    `v=${wb.getVersion()} r1=${JSON.stringify(r1.error)} r2=${JSON.stringify(r2.error)}`);

  const after = wb.getState().cabinets.find((c) => c.id === 'wine_E')!;
  ok('提交后 finishedEnds=both、tilt=15 落到模型', after.params.finishedEnds === 'both' && after.layout.units[0]!.shelves!.tilt === 15,
    `fe=${after.params.finishedEnds} tilt=${after.layout.units[0]!.shelves!.tilt}`);

  // 派生随模型现算：改 tilt 后板件长立即变化
  const gAfter = generateCabinet(after, rules);
  const Lg = computeCabinetLayout(after, rules);
  const expected = Math.round((Lg.nets[0]! - 1) / Math.cos((15 * Math.PI) / 180));
  ok('派生板件实时反映新 tilt（realLen 重算）', gAfter.panels.filter((p) => p.role === 'ShelfPanel').every((p) => p.length === expected), `exp=${expected}`);

  // undo 可回退（总线语义：AI / UI / 脚本同权）
  wb.undo();
  wb.undo();
  const back = wb.getState().cabinets.find((c) => c.id === 'wine_E')!;
  ok('undo 两条后 finishedEnds 回 none、tilt 回 12（回到模板默认）', back.params.finishedEnds === 'none' && back.layout.units[0]!.shelves!.tilt === 12,
    `fe=${back.params.finishedEnds} tilt=${back.layout.units[0]!.shelves!.tilt}`);
}

// ══════════════════════════════════════════════════════════════
section('7. cabinet.create 走真实记忆门（浏览器 B33 同款路径，防回归）');
{
  // 之前浏览器 B33 的 bug：探针的 cabinet.create 命令漏了 changes 字段，
  // 记忆门 pathForbidden 检查读 cmd.changes.some 直接崩（页面 uncaught）。
  // 这条命令在 node 单测里被漏掉，因为单测总带 changes:[]。这里补上，
  // 并显式验证「不带 changes 也不许崩门」。
  const proj = sampleProject(rules);
  const wb = new CommandBus(proj, rules);
  wb.setGate(compileCorrections(loadCorrections()).gate); // 与浏览器一致：挂记忆门

  const wine = createCabinetFromTemplate({ templateId: 'wine_cabinet', id: 'wine_create', name: '酒柜A', roomId: 'room1', x: 2000, y: 2000, rotation: 0, rules, takenIds: proj.cabinets.map((c) => c.id) });
  const v0 = wb.getVersion();
  // 放点 (2000,2000) 远离墙、不重叠 → 不被记忆拦截，应干净落库
  const r = wb.execute({ id: 'c_create', op: 'cabinet.create', source: 'ui', target: { kind: 'project', id: 'project' }, changes: [], payload: { cabinet: wine } }, '建酒柜');
  ok('cabinet.create 带 changes:[] 走真实记忆门：成功落库、版本 +1、tilt=12 落地', !r.error && r.ok && wb.getVersion() === v0 + 1 && wb.getState().cabinets.find((c) => c.id === 'wine_create')?.layout.units[0]?.shelves?.tilt === 12, `err=${r.error ?? '(none)'} v=${wb.getVersion()}`);

  // 防御：漏掉 changes 字段的命令，记忆门不得崩（pathForbidden 用 ?? [] 兜底）
  const wine2 = createCabinetFromTemplate({ templateId: 'wine_cabinet', id: 'wine_nochg', name: '酒柜B', roomId: 'room1', x: 2200, y: 2200, rotation: 0, rules, takenIds: wb.getState().cabinets.map((c) => c.id) });
  let threw = false;
  try {
    wb.execute({ id: 'c_nochg', op: 'cabinet.create', source: 'ui', payload: { cabinet: wine2 } } as never, '建酒柜(漏changes)');
  } catch {
    threw = true;
  }
  ok('cabinet.create 漏掉 changes 字段也不会让记忆门崩（门崩比漏拦更糟）', !threw, `threw=${threw}`);

  // 记忆拦截仍生效：把酒柜扎进墙里（x,y 很小）应被 mem_002 拦下，且不崩
  const wine3 = createCabinetFromTemplate({ templateId: 'wine_cabinet', id: 'wine_wall', name: '酒柜C', roomId: 'room1', x: 40, y: 40, rotation: 0, rules, takenIds: wb.getState().cabinets.map((c) => c.id) });
  const rWall = wb.execute({ id: 'c_wall', op: 'cabinet.create', source: 'ui', target: { kind: 'project', id: 'project' }, changes: [], payload: { cabinet: wine3 } }, '建酒柜(入墙)');
  ok('记忆门照常拦「扎进墙里」的 create（非崩溃、返回 error）', !rWall.ok && !!rWall.error && !!rWall.memoryHits?.length, `err=${rWall.error ?? '(none)'} hits=${rWall.memoryHits?.length ?? 0}`);
}

console.log(`\n═══ 异形图元（Phase E）：通过 ${pass} 项，失败 ${fail} 项 ═══`);
if (fail > 0) {
  console.log('\n失败清单：');
  for (const f of failures) console.log(`  · ${f}`);
  process.exit(1);
}
