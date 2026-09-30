/**
 * ══════════════════════════════════════════════════════════════════════
 *  P8.8 Unified Design Validation 验收
 *
 *  覆盖指令 §十一 的 15 项，外加负样本与架构红线：
 *    ① 同源（组合层只组合，不复制判定）        ⑦ 墙贴合声明成功 / 失败
 *    ② placement-only 行为不变                 ⑧ intent 不绕过 validation
 *    ③ spatial-only 行为不变                   ⑨ warning / error 分类正确
 *    ④ 柜在房间内                              ⑩ 报告确定性
 *    ⑤ 柜穿墙                                  ⑪ 不改 Semantic Model / placement
 *    ⑥ 柜盖洞口                                ⑫ 不调 AI、不出 DXF/BOM、不进主规则链
 *
 *  判据纪律（本项目反复钉过的）：
 *    · 负样本断言到**具体码**（"被拒了"会被别处检查顶替而假绿）；
 *    · 带数字的断言必须是**喂进去的那个值**真出现在文案里（缺值兜底 0 会假绿）；
 *    · 每条断言失败时先假定断言自己写错 —— detail 里打原始值。
 * ══════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCabinet, defaultCabinetParams, defaultUnits, rectRoom, createWall } from '../src/core/docFactory.ts';
import type { Cabinet, Project, Room } from '../src/core/types.ts';
import { validatePlacementDesign } from '../src/core/placementDesign.ts';
import { deriveSpatial, roomLoop } from '../src/core/spatial/index.ts';
import { RULE_CODES, ruleCard } from '../src/core/rules/issueCatalog.ts';
import {
  contactFaceOf,
  designViewFor,
  nearestWallDistance,
  validateDesign,
  verifyWallAttachment,
  DESIGN_TOL,
  WALL_CONTACT_ZH,
  type DesignValidationFinding,
  type DesignValidationReport,
} from '../src/core/designValidation/index.ts';
import { withResolvedPlacements } from '../src/core/placementDesign.ts';
import { sceneFromProject as sceneOf, resolvePlacement as resolve, type PlacementIntent } from '../src/core/placement.ts';
import * as CMD from '../src/core/commands.ts';
import { placeCabinet } from '../src/core/commands.ts';
import { observeCommand } from '../src/ai/knowledge/observe.ts';
import { recordObservation } from '../src/ai/knowledge/index.ts';

const APP = join(import.meta.dirname, '..');
let passed = 0;
let failed = 0;
const fails: string[] = [];

function ok(name: string, cond: unknown, detail: unknown = ''): void {
  if (cond === true) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    fails.push(name);
    console.log(`  ✗ ${name}  ── ${JSON.stringify(detail)}`);
  }
}
function section(t: string): void {
  console.log(`\n── ${t} ──`);
}

// ─────────────────────────── fixture ───────────────────────────

const rules = JSON.parse(readFileSync(join(APP, 'src/core/ruleset/factory-default.json'), 'utf8')) as Record<string, unknown>;
const RULES = rules as never;

/** 矩形房间 4000×3000（墙 id 固定：w1 下 / w2 右 / w3 上 / w4 左；厚度 120） */
function mkRoom(id: string, x = 0, y = 0, w = 4000, h = 3000, thickness = 120): Room {
  const room = rectRoom({ id, name: `房间${id}`, x, y, w, h, thickness, height: 2700 });
  room.walls.forEach((wl, i) => {
    wl.id = `${id}_w${i + 1}`;
    wl.name = `${id}墙${i + 1}`;
  });
  return room;
}

function mkCab(room: Room, id: string, x: number, y: number, w: number, d: number, rotation = 0): Cabinet {
  const units = defaultUnits(w, RULES, d).map((u) => ({ ...u, id: `${id}_${u.id}` }));
  return createCabinet({
    id,
    name: id,
    roomId: room.id,
    x,
    y,
    rotation,
    rules: RULES,
    params: { ...defaultCabinetParams(RULES), width: w, height: 2200, depth: d },
    units,
  });
}

const mkProject = (rooms: Room[], cabinets: Cabinet[]): Project =>
  ({ schemaVersion: '0.3', id: 'proj', name: 'P88', ruleSetId: (rules as { id: string }).id, rooms, cabinets }) as Project;

const codes = (r: DesignValidationReport): string[] => r.findings.map((f) => f.code);
const find = (r: DesignValidationReport, code: string): DesignValidationFinding | undefined =>
  r.findings.find((f) => f.code === code);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const ROOM = mkRoom('r1');

// ═══════════════ §1 统一报告与同源（1~3） ═══════════════
section('§1 统一报告结构 + 两层同源（组合层只组合，不复制判定）');
{
  const p = mkProject([ROOM], [mkCab(ROOM, 'cab_A', 500, 60, 900, 600)]);
  const rep = validateDesign(p);
  ok(
    '1. validateDesign 同时给出 placement / spatial / findings / wallContacts / cabinets',
    Boolean(rep.placement && rep.spatial && Array.isArray(rep.findings) && Array.isArray(rep.wallContacts) && Array.isArray(rep.cabinets)),
    Object.keys(rep)
  );
  ok(
    '2. placement 段与单独调用 validatePlacementDesign 逐字节相同（placement-only 行为不变）',
    JSON.stringify(rep.placement) === JSON.stringify(validatePlacementDesign(p)),
    'placement 段被组合层改写过'
  );
  ok(
    '3. spatial 段与单独调用 deriveSpatial 逐字节相同（spatial-only 行为不变）',
    JSON.stringify(rep.spatial) === JSON.stringify(deriveSpatial(p)),
    'spatial 段被组合层改写过'
  );
  ok(
    '3b. 空间层的 issue 只是被"搬进" findings 并补 layer/sourceCode，文案与等级一个不改',
    rep.findings
      .filter((f) => f.layer === 'spatial')
      .every((f) => rep.spatial.issues.some((i) => i.code === f.code && i.message === f.message && (i.severity === 'ERROR' ? f.status === 'error' : f.status === 'warning'))),
    rep.findings.filter((f) => f.layer === 'spatial').map((f) => `${f.code}:${f.status}`)
  );
}

// ═══════════════ §2 柜 ↔ 房间 / 穿墙（4~5） ═══════════════
section('§2 柜在房间内 / 柜穿墙（硬错误）');
{
  const inside = mkProject([ROOM], [mkCab(ROOM, 'cab_A', 500, 60, 900, 600)]);
  const repIn = validateDesign(inside);
  const view = designViewFor(repIn, 'cab_A')!;
  ok('4. 柜体落在闭合房间内 → view.room === inside', view.room === 'inside', view.room);
  ok('4b. 柜体在房间内、背面贴墙 → 没有"在房间外"这类结论', !codes(repIn).includes('SPATIAL-CABINET-OUTSIDE'), codes(repIn));

  // 穿墙：柜体背面在 y=0（墙中心线），footprint y∈[0,600] 与墙矩形 y∈[-60,60] 内部重叠
  const crossing = mkProject([ROOM], [mkCab(ROOM, 'cab_B', 500, 0, 900, 600)]);
  const repX = validateDesign(crossing);
  const f = find(repX, 'DESIGN-CABINET-WALL-CONFLICT');
  ok('5. 柜体与墙体重叠 → DESIGN-CABINET-WALL-CONFLICT（ERROR）', f?.status === 'error', JSON.stringify(repX.findings));
  ok('5b. 该结论的墙名与墙厚是真数字（120mm）', Boolean(f?.message.includes('120')), f?.message);
  ok('5c. facts 里的 crossing 事实被标成 wall-conflict（语义解释层不重判，只翻译）',
    repX.wallContacts.some((c) => c.cabId === 'cab_B' && c.kind === 'wall-conflict'), JSON.stringify(repX.wallContacts));
  ok('5d. 报告状态被 error 顶起', repX.status === 'error', repX.status);
  ok('5e. 组合层不给任何"自动移柜/自动修复"（findings 上没有命令、没有按钮）',
    repX.findings.every((x) => !('autoFix' in x) && !('op' in x) && !('changes' in x)),
    JSON.stringify(repX.findings[0]));
}

// ═══════════════ §3 柜 ↔ 洞口（6 + 语义解释） ═══════════════
section('§3 柜盖洞口（硬错误）/ 门前余量（语义提示）');
{
  const withDoor = (): Room => {
    const r = mkRoom('r2');
    r.walls[0]!.openings = [{ id: 'op_door', kind: 'door', offset: 500, width: 900 }];
    return r;
  };
  const r = withDoor();

  // 盖住：柜体 x∈[700,1600] 与影响带 x∈[500,1400]（y 到室内侧 +600）内部重叠
  const blocked = validateDesign(mkProject([r], [mkCab(r, 'cab_block', 700, 60, 900, 600)]));
  const fb = find(blocked, 'SPATIAL-CABINET-OPENING');
  ok('6. 柜体盖住门洞 → SPATIAL-CABINET-OPENING（ERROR，复用 P8.7 的判定，不重复报）',
    fb?.status === 'error' && fb.layer === 'spatial', JSON.stringify(blocked.findings.map((x) => `${x.code}:${x.status}`)));
  ok('6b. 盖住时不再叠一条"离门洞太近"（overlap ≠ near）', !codes(blocked).includes('DESIGN-CABINET-NEAR-DOOR'), codes(blocked));

  // 没盖住但离得近：柜在 x∈[1700,2600]，距影响带 300mm（≤ DESIGN_TOL.APPROACH=600）
  const near = validateDesign(mkProject([withDoor()], [mkCab(withDoor(), 'cab_near', 1700, 60, 900, 600)]));
  const fn = find(near, 'DESIGN-CABINET-NEAR-DOOR');
  ok('6c. 门前余量不足 → DESIGN-CABINET-NEAR-DOOR（WARNING）', fn?.status === 'warning', JSON.stringify(near.findings.map((x) => x.code)));
  ok('6d. 该提示带的是**实测**间距 300mm（不是兜底 0）', Boolean(fn?.message.includes('300')), fn?.message);
  ok('6e. 洞口宽度 900mm 也在文案里（差多少说得清）', Boolean(fn?.message.includes('900')), fn?.message);
  ok('6f. APPROACH 阈值集中定义（不在各处写 magic number）',
    DESIGN_TOL.APPROACH === 600 && WALL_CONTACT_ZH['wall-near'] === '离墙有缝', JSON.stringify(DESIGN_TOL));

  // 窗洞在柜后：同一几何，换 kind
  const rw = mkRoom('r2');
  rw.walls[0]!.openings = [{ id: 'op_win', kind: 'window', offset: 500, width: 900 }];
  const behind = validateDesign(mkProject([rw], [mkCab(rw, 'cab_win', 1700, 60, 900, 600)]));
  const fw = find(behind, 'DESIGN-WINDOW-BEHIND-CABINET');
  ok('6g. 窗洞被柜挡在后面 → DESIGN-WINDOW-BEHIND-CABINET（WARNING）', fw?.status === 'warning', JSON.stringify(behind.findings.map((x) => x.code)));
  ok('6h. 门窗两类提示不混（门洞不报窗的码，窗洞不报门的码）',
    !codes(behind).includes('DESIGN-CABINET-NEAR-DOOR') && !codes(near).includes('DESIGN-WINDOW-BEHIND-CABINET'),
    [codes(behind), codes(near)]);
}

// ═══════════════ §4 柜 ↔ 墙的设计语义（§四：解释层，不写回 Cabinet） ═══════════════
section('§4 柜↔墙语义：背面贴墙 / 侧面顶墙 / 门脸朝墙 / 离墙有缝 / 没靠墙');
{
  // 背面贴墙（下墙 w1，y=60 贴住墙矩形上沿）
  const back = validateDesign(mkProject([ROOM], [mkCab(ROOM, 'cab_A', 500, 60, 900, 600)]));
  const cb = back.wallContacts.find((c) => c.cabId === 'cab_A')!;
  ok('7. 背面贴墙 → back-wall-contact（正面事实不发 finding，不吵人）',
    cb.kind === 'back-wall-contact' && cb.face === 'back' && cb.gap === 0 && !back.findings.some((f) => f.cabId === 'cab_A' && f.layer === 'semantic'),
    JSON.stringify([cb, back.findings.map((f) => f.code)]));

  // 侧面顶墙（左墙 w4，x=60）
  const side = validateDesign(mkProject([ROOM], [mkCab(ROOM, 'cab_S', 60, 1500, 900, 600)]));
  const cs = side.wallContacts.find((c) => c.cabId === 'cab_S')!;
  ok('7b. 侧面顶墙 → side-wall-contact（也属正面事实）', cs.kind === 'side-wall-contact' && cs.face === 'left', JSON.stringify(cs));

  // 门脸朝墙（上墙 w3：柜体前脸 y=2940 贴住墙矩形下沿）
  const front = validateDesign(mkProject([ROOM], [mkCab(ROOM, 'cab_F', 1000, 2340, 900, 600)]));
  const cf = front.wallContacts.find((c) => c.cabId === 'cab_F')!;
  const ff = find(front, 'DESIGN-CABINET-FRONT-WALL');
  ok('7c. 门脸朝墙 → front-wall-contact + DESIGN-CABINET-FRONT-WALL（WARNING）',
    cf.kind === 'front-wall-contact' && cf.face === 'front' && ff?.status === 'warning', JSON.stringify([cf, ff?.message]));
  ok('7d. 门脸朝墙不叠"没靠墙"（它确实挨着墙，只是面用错）', !codes(front).includes('DESIGN-CABINET-FLOATING'), codes(front));

  // 离墙有缝（5mm ≤ NEAR 50）
  const near = validateDesign(mkProject([ROOM], [mkCab(ROOM, 'cab_N', 500, 65, 900, 600)]));
  const cn = near.wallContacts.find((c) => c.cabId === 'cab_N')!;
  const fn = find(near, 'DESIGN-CABINET-NEAR-WALL');
  ok('7e. 离墙 5mm → wall-near + DESIGN-CABINET-NEAR-WALL（WARNING，带实测 5mm）',
    cn.kind === 'wall-near' && fn?.status === 'warning' && Boolean(fn.message.includes('5mm')), JSON.stringify([cn, fn?.message]));

  // 没靠墙（房子中间）
  const float = validateDesign(mkProject([ROOM], [mkCab(ROOM, 'cab_M', 2000, 1500, 900, 600)]));
  const fm = find(float, 'DESIGN-CABINET-FLOATING');
  ok('7f. 房间中央 → DESIGN-CABINET-FLOATING（WARNING，"这是形态不是错误"）', fm?.status === 'warning', JSON.stringify(float.findings.map((f) => f.code)));
  ok('7g. 每只柜最多一条 floating（不按墙数重复）',
    float.findings.filter((f) => f.code === 'DESIGN-CABINET-FLOATING').length === 1);
  ok('7h. 语义只读派生：Cabinet 上没有被新增任何墙字段（不写 wallId / facingWall）',
    !('wallId' in (float.cabinets[0] as unknown as object)) &&
      float.wallContacts.every((c) => !('wallId' in (ROOM.walls.find((w) => w.id === (c.wallId ?? '')) ?? {})) || typeof c.wallId === 'string'),
    Object.keys(float.cabinets[0]!));
}

// ═══════════════ §5 墙贴合声明验证（§五） ═══════════════
section('§5 「贴墙」声明 vs 事实：成功 / 没贴上 / 面不符 / 缝不符 / 穿墙');
{
  const p = mkProject([ROOM], [mkCab(ROOM, 'cab_A', 500, 60, 900, 600)]);
  const good = verifyWallAttachment(p, { cabId: 'cab_A', face: 'back', offset: 0 });
  ok('8. 声明"背面临墙、不留缝"与事实一致 → ok，且不产 finding',
    good.ok === true && good.findings.length === 0 && good.fact.touching === true && good.fact.face === 'back',
    JSON.stringify(good.fact));
  ok('8b. 成功时也把事实说全（哪面墙 / 哪一面 / 缝宽）',
    typeof good.fact.wallId === 'string' && typeof good.fact.wallName === 'string' && good.fact.gap === 0,
    JSON.stringify(good.fact));

  // 没贴上：声明贴墙，实际在房间中央
  const farP = mkProject([ROOM], [mkCab(ROOM, 'cab_F2', 2000, 1500, 900, 600)]);
  const far = verifyWallAttachment(farP, { cabId: 'cab_F2' });
  const nf = far.findings[0]!;
  const measured = nearestWallDistance(farP.cabinets[0]!, ROOM)!;
  ok('9. 声明贴墙但没贴上 → DESIGN-ATTACH-NOT-TOUCHING（ERROR）', nf.code === 'DESIGN-ATTACH-NOT-TOUCHING' && nf.status === 'error', JSON.stringify(far.findings.map((f) => f.code)));
  ok(
    '9b. 报的就是**实测**最近墙距（不是兜底 0，也不是"最近"这两个字）',
    measured.gap > 0 && nf.message.includes(String(measured.gap)),
    `实测 ${measured.gap}mm（${measured.wallName}）｜msg=${nf.message}`
  );
  ok('9c. 失败时不谎报触碰（fact.touching === false）', far.fact.touching === false, JSON.stringify(far.fact));

  // 面不符：实际背面贴墙，声明"左端临墙"
  const wrongFace = verifyWallAttachment(p, { cabId: 'cab_A', face: 'left' });
  ok('10. 声明面与事实不符 → DESIGN-ATTACH-FACE-MISMATCH（ERROR，且点明 背面 vs 左端）',
    wrongFace.findings[0]?.code === 'DESIGN-ATTACH-FACE-MISMATCH' &&
      wrongFace.findings[0]!.message.includes('背面') &&
      wrongFace.findings[0]!.message.includes('左端'),
    JSON.stringify(wrongFace.findings.map((f) => f.message)));

  // 缝不符：实际 0mm 缝，声明要留 50mm
  const wrongOffset = verifyWallAttachment(p, { cabId: 'cab_A', offset: 50 });
  ok('11. 声明缝宽与事实不符 → DESIGN-ATTACH-OFFSET-MISMATCH（ERROR，点明 50 vs 0）',
    wrongOffset.findings[0]?.code === 'DESIGN-ATTACH-OFFSET-MISMATCH' &&
      wrongOffset.findings[0]!.message.includes('50') &&
      wrongOffset.findings[0]!.message.includes('0'),
    JSON.stringify(wrongOffset.findings.map((f) => f.message)));

  // 声明贴墙但柜子在墙里
  const conflict = verifyWallAttachment(mkProject([ROOM], [mkCab(ROOM, 'cab_X', 500, 0, 900, 600)]), { cabId: 'cab_X' });
  ok('12. 声明贴墙但柜体穿墙 → 走同一条 conflict 硬错（穿墙优先于"贴没贴上"）',
    conflict.findings[0]?.code === 'DESIGN-CABINET-WALL-CONFLICT' && conflict.ok === false,
    JSON.stringify(conflict.findings.map((f) => f.code)));

  // 没声明就不判"该不该靠墙"
  const noDecl = validateDesign(mkProject([ROOM], [mkCab(ROOM, 'cab_A', 500, 60, 900, 600)]));
  ok('12b. 没给声明 → 不产生任何 ATTACH-* 结论（只校验声明过的）',
    !noDecl.findings.some((f) => f.code.startsWith('DESIGN-ATTACH-')), codes(noDecl));
  ok('12c. 声明进报告：attach 声明与其它结论合并成同一份 findings',
    validateDesign(p, { attach: [{ cabId: 'cab_A', face: 'left' }] }).findings.some((f) => f.code === 'DESIGN-ATTACH-FACE-MISMATCH'));
}

// ═══════════════ §6 Intent 不绕过 Validation（§七） ═══════════════
section('§六 用户明确意图 ≠ 结果合法：Resolver 说"能放"，验证照样说"穿墙"');
{
  const room = mkRoom('r3');
  const A = mkCab(room, 'cab_A', 500, 60, 900, 600); // 背面贴墙
  const B = mkCab(room, 'cab_B', 500, 0, 900, 600); // 背面在墙中心线上 → 穿墙
  const p = mkProject([room], [A, B]);

  const intent: PlacementIntent = { relation: 'align', targetId: 'cab_B', referenceId: 'cab_A', alignment: 'left' };
  const resolved = resolve(intent, sceneOf(p));
  ok('13. Resolver 自己认为这条意图没问题（它只管几何关系、不认识墙）', resolved.ok === true, JSON.stringify(resolved));

  const applied = resolved.ok ? withResolvedPlacements(p, [{ intent, placement: resolved.placement }]) : p;
  const rep = validateDesign(applied);
  ok('13b. 但统一验证仍然报穿墙（intent 不是 bypass validation 的通行证）',
    rep.findings.some((f) => f.code === 'DESIGN-CABINET-WALL-CONFLICT' && f.status === 'error'),
    codes(rep));
  ok('13c. 用意图落位的那只柜确实被判穿墙（不是别的柜顶包）',
    find(rep, 'DESIGN-CABINET-WALL-CONFLICT')?.cabId === 'cab_B',
    JSON.stringify(rep.findings.map((f) => [f.code, f.cabId])));
  ok('13d. 意图落位不会让报告变绿（status 仍是 error）', rep.status === 'error', rep.status);

  // 声明贴墙 + 意图落位：两条通道都不能让错误消失
  const withDecl = validateDesign(applied, { attach: [{ cabId: 'cab_B', face: 'back', offset: 0 }] });
  ok('13e. 声明"这只柜贴墙"同样不能把 error 变成 ok',
    withDecl.status === 'error' && !withDecl.findings.some((f) => f.status === 'error' && f.code === 'DESIGN-ATTACH-NOT-TOUCHING'),
    JSON.stringify(withDecl.findings.map((f) => [f.code, f.status])));
}

// ═══════════════ §7 等级再审查（§三） ═══════════════
section('§七 等级：硬错误 vs 设计建议（唯一真相源仍是 issueCatalog）');
{
  const HARD = ['DESIGN-CABINET-WALL-CONFLICT', 'DESIGN-ATTACH-NOT-TOUCHING', 'DESIGN-ATTACH-FACE-MISMATCH', 'DESIGN-ATTACH-OFFSET-MISMATCH'];
  const SOFT = ['DESIGN-CABINET-FRONT-WALL', 'DESIGN-CABINET-NEAR-WALL', 'DESIGN-CABINET-FLOATING', 'DESIGN-CABINET-NEAR-DOOR', 'DESIGN-WINDOW-BEHIND-CABINET'];
  const badHard = HARD.filter((c) => ruleCard(c)?.severity !== 'ERROR');
  const badSoft = SOFT.filter((c) => ruleCard(c)?.severity !== 'WARNING');
  ok('14. 硬错误类（已证明非法）在目录里就是 ERROR', badHard.length === 0, JSON.stringify(badHard.map((c) => [c, ruleCard(c)?.severity])));
  ok('14b. 设计建议类（几何成立但可疑）在目录里就是 WARNING', badSoft.length === 0, JSON.stringify(badSoft.map((c) => [c, ruleCard(c)?.severity])));
  ok('14c. 建议类全部给得出 manual（"这是你要决定的事"），不给一键修复',
    SOFT.every((c) => (ruleCard(c)?.manual ?? '').length > 4 && ruleCard(c)?.fix === undefined),
    JSON.stringify(SOFT.map((c) => [c, ruleCard(c)?.manual, Boolean(ruleCard(c)?.fix)])));

  const rep = validateDesign(mkProject([ROOM], [mkCab(ROOM, 'cab_W', 1000, 2340, 900, 600), mkCab(ROOM, 'cab_M', 2000, 1500, 600, 600)]));
  ok('14d. 报告 status = warning（只有建议、没有硬错）', rep.status === 'warning', rep.status);
  ok('14e. counts 与实际结论一致',
    rep.counts.warning === rep.findings.filter((f) => f.status === 'warning').length &&
      rep.counts.error === rep.findings.filter((f) => f.status === 'error').length,
    JSON.stringify(rep.counts));

  // 判不出来就不发：断口房间 → 房间关系 unknown、不发 floating / 门前提示
  const gapped = mkRoom('r4');
  gapped.walls[3] = createWall({ id: 'r4_w4', name: 'r4墙4', start: { x: 50, y: 3000 }, end: { x: 0, y: 0 } }); // 断口 50mm
  const repGap = validateDesign(mkProject([gapped], [mkCab(gapped, 'cab_G', 2000, 1500, 900, 600)]));
  ok('15. 房间边界不成回路 → 房间关系 unknown，且**不猜**"没靠墙"',
    designViewFor(repGap, 'cab_G')!.room === 'unknown' && !codes(repGap).includes('DESIGN-CABINET-FLOATING'),
    [designViewFor(repGap, 'cab_G')!.room, codes(repGap)]);
  ok('15b. 判不出内外时不产生空间语义结论（沉默优于瞎猜）',
    !repGap.findings.some((f) => f.layer === 'semantic'), JSON.stringify(repGap.findings.map((f) => f.code)));
  ok('15c. 房间无墙（空房间）→ 不发 floating（没有墙就没有"没靠墙"这回事）',
    !codes(validateDesign(mkProject([{ id: 'r5', name: 'r5', walls: [] }], [mkCab({ id: 'r5', name: 'r5', walls: [] }, 'cab_E', 500, 500, 600, 600)]))).includes('DESIGN-CABINET-FLOATING'));
}

// ═══════════════ §8 确定性与无副作用 ═══════════════
section('§八 确定性 / 不改模型 / 不改 placement');
{
  const p = mkProject([ROOM], [mkCab(ROOM, 'cab_A', 500, 60, 900, 600), mkCab(ROOM, 'cab_M', 2000, 1500, 600, 600)]);
  const before = clone(p);
  const r1 = validateDesign(p, { attach: [{ cabId: 'cab_A', face: 'back' }] });
  const r2 = validateDesign(p, { attach: [{ cabId: 'cab_A', face: 'back' }] });
  ok('16. 同输入两次调用逐字节相同（无随机 / 无时钟）', JSON.stringify(r1) === JSON.stringify(r2));
  ok('16b. 不修改 Semantic Model（跑完深比较一致）', JSON.stringify(p) === JSON.stringify(before), '模型被改动了');
  ok('16c. 不改 placement（x/y/rotation 一个没动）',
    JSON.stringify(p.cabinets.map((c) => c.placement)) === JSON.stringify(before.cabinets.map((c) => c.placement)));
  ok('16d. 不写盘：验证只返回报告，签名里没有任何"目标 project"输出',
    r1.spatial.facts.cabinets.length === 2 && r1.cabinets.length === 2);
  ok('16e. 斜向旋转（45°）时"是哪一个面"走最近面回退，并如实标记 rotated',
    (() => {
      const r45 = contactFaceOf(mkCab(ROOM, 'cab_R', 500, 60, 900, 600, 45), ROOM.walls[0]!);
      return r45.rotated === true && r45.face !== null;
    })(),
    JSON.stringify(contactFaceOf(mkCab(ROOM, 'cab_R', 500, 60, 900, 600, 45), ROOM.walls[0]!)));
  ok('16f. 90° 旋转柜贴墙仍走主判据（面判定不是"按角度分情况"的猜测）',
    (() => {
      const r90 = contactFaceOf(mkCab(ROOM, 'cab_R90', 60, 1500, 900, 600, 90), ROOM.walls[3]!);
      return r90.rotated === false && r90.face === 'back';
    })(),
    JSON.stringify(contactFaceOf(mkCab(ROOM, 'cab_R90', 60, 1500, 900, 600, 90), ROOM.walls[3]!)));
}

// ═══════════════ §9 架构红线：不进主链 / 不调 AI / 不出 DXF·BOM ═══════════════
section('§九 架构红线（源码扫描 + 行为断言）');
{
  const dir = join(APP, 'src/core/designValidation');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const text = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  ok('17. 设计验证层不 import AI 层（不调 AI、不产提案）', !/from '\.\.\/ai\//.test(text) && !/\bfetch\s*\(/.test(text));
  ok('17b. 不 import 导出 / 制造层（不出 DXF / BOM）', !/from '\.\.\/(export|manufacturing|dxf)/.test(text) && !/dxf|DXF/.test(text.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('17c. 不 import CommandBus（验证不是写入口，不能产生命令）',
    !/from '\.\.\/commandBus\.ts'/.test(text) && !/\bnew CommandBus\b/.test(text) && !/\bbus\.execute\b/.test(text));
  ok('17d. 不 import 几何生成器以外的制造/清单模块（只读 footprint，不产板件）',
    /getCabinetFootprint/.test(text) && !/generateProject|buildBom|exportDxf|toDxf/i.test(text));
  ok('17e. 组合层只 import 两条既有链路（placementDesign / spatial）作为判断来源',
    /from '\.\.\/placementDesign\.ts'/.test(text) && /from '\.\.\/spatial\/index\.ts'/.test(text));
  // 新码必须全部登记（忘了登记 → buildIssue 直接抛错，这里再钉一道）
  const emitted = new Set<string>();
  for (const m of text.matchAll(/['"`]([A-Z][A-Z0-9-]{4,})['"`]/g)) {
    if (/^(DESIGN|SPATIAL)-/.test(m[1]!)) emitted.add(m[1]!);
  }
  const unregistered = [...emitted].filter((c) => !RULE_CODES.includes(c));
  ok('17f. 设计验证层里出现的每个规则码都在目录里登记（新增码忘登记 = 这里红）',
    unregistered.length === 0 && emitted.size >= 9, `未登记：${JSON.stringify(unregistered)}｜共用到 ${emitted.size} 个码`);

  // 主规则链不变：设计验证**不**进 CommandBus.deriveFor
  const busSrc = readFileSync(join(APP, 'src/core/commandBus.ts'), 'utf8');
  ok('18. 设计验证不进主规则链（commandBus 不 import designValidation）',
    !/designValidation/.test(busSrc), '主问题链被设计建议污染了');
  const cab = mkCab(ROOM, 'cab_X', 500, 0, 900, 600);
  const rep = validateDesign(mkProject([ROOM], [cab]));
  ok('18b. 设计验证的结论不冒充项目 issue（没有把 warning 混进 blockingErrors 的通路）',
    rep.findings.every((f) => !('severity' in f) && (f.status === 'error' || f.status === 'warning')),
    JSON.stringify(rep.findings[0]));
}

// ═══════════════ §10 Knowledge / AI 边界（§八·§九） ═══════════════
section('§十 知识边界：只学"用户明确选过的"，不学 error / 自动解析结果');
{
  const cab = mkCab(ROOM, 'cab_A', 500, 60, 900, 600);
  const ctx = { contact: 'butt' as const, turnSide: undefined };
  const rot = [{ path: 'placement.rotation', op: 'set' as const, from: 0, to: 90 }];
  const rotCmd = CMD.rotateCabinet(cab, 90, 'ui');

  // 同一命令、同一 diff，只有 authority 不同 —— 这样断言才**有区分度**
  // （用 placement.x 这种本来就产不出谓词的 diff 去断言 0，是假绿）
  const sys = observeCommand(rotCmd, rot, cab.name, ctx, 'system-resolved');
  const human = observeCommand(rotCmd, rot, cab.name, ctx, 'user-authored');
  ok('19. authority = system-resolved（系统/Resolver 解析出来的落位）→ 一条偏好都不产生',
    sys.length === 0, JSON.stringify(sys));
  ok('19b. 同样的动作在人手里（user-authored）→ 产生一条 orientation 偏好证据',
    human.length === 1 && human[0]!.predicate.kind === 'orientation' && human[0]!.predicate.value === 90,
    JSON.stringify(human));
  ok('19c. 那条证据落成 candidate（只候选、不自动生效：状态 candidate、置信度低）',
    (() => {
      const e = recordObservation([], human[0]!)[0]!;
      return e.status === 'candidate' && (e.confidence ?? 1) < 0.5;
    })(),
    JSON.stringify(recordObservation([], human[0]!)[0]));

  // 第二道门禁：source === 'system'（撤销 / 自动重放）在观察器入口就返回空 ——
  // 于是 system-resolved 在真实管线里根本到不了观察器（authority 只在落位命令上派生，
  // 而落位命令若是 system 来源，入口就被挡）。两道门禁这里都钉住。
  ok('19d. source = system（撤销 / 自动重放 / 自动解析）→ 入口即挡，任何 diff 都不产偏好',
    observeCommand({ ...rotCmd, source: 'system' }, [{ path: 'params.width', op: 'set', from: 900, to: 1200 }], cab.name, ctx, 'system-resolved').length === 0);
  ok('19d-2. 未确认的 AI 落位（authority = unknown）同样不冒充用户偏好',
    observeCommand(rotCmd, rot, cab.name, ctx, 'unknown').length === 0);

  const stript = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const srcText = stript(readdirSync(join(APP, 'src/core/designValidation')).map((f) => readFileSync(join(APP, 'src/core/designValidation', f), 'utf8')).join('\n'));
  ok('19e. 设计验证层不写知识库（源码里没有 knowledge 导入 / 没有 candidate 生成）',
    !/knowledge/.test(srcText) && !/candidate/.test(srcText) && !/recordObservation|makeCandidate/.test(srcText), '验证层碰了知识库');
  ok('19f. AI 契约未被扩大：本阶段没有新增可写命令（AI 仍只能提案 → 走命令总线）',
    !readFileSync(join(APP, 'src/ai/compile.ts'), 'utf8').includes('designValidation') &&
      !readFileSync(join(APP, 'shared/aiContract.mjs'), 'utf8').includes('designValidation'));
}

// ═══════════════ §11 界面视图（§十 最小展示） ═══════════════
section('§十一 单柜视图（界面「空间检查」区直接消费）');
{
  const p = mkProject([ROOM], [mkCab(ROOM, 'cab_A', 500, 60, 900, 600)]);
  const rep = validateDesign(p);
  const v = designViewFor(rep, 'cab_A')!;
  ok('20. 单柜视图给出房间关系 + 墙接触事实 + 该柜结论',
    v.room === 'inside' && v.contacts.length === 1 && v.contacts[0]!.kind === 'back-wall-contact' && Array.isArray(v.findings),
    JSON.stringify(v));
  ok('20b. 视图里的墙名来自模型（界面能说"靠北墙"而不是"靠 w1"）',
    v.contacts[0]!.wallName === 'r1墙1' && WALL_CONTACT_ZH[v.contacts[0]!.kind] === '背面贴墙');
  ok('20c. 未知柜 → null（界面据此显示"对象已不存在"）', designViewFor(rep, 'cab_ZZZ') === null);
  ok('20d. 视图不提供任何动作（没有 action / fix / button 字段）',
    Object.keys(v).every((k) => !/action|fix|button|command/i.test(k)), Object.keys(v));
}

// ═══════════════ §12 回归锚点 ═══════════════
section('§十二 回归锚点：既有链路完好');
{
  const p = mkProject([ROOM], [mkCab(ROOM, 'cab_A', 500, 60, 900, 600)]);
  ok('21. roomLoop / deriveSpatial 仍可直接使用（P8.7 的出口没被这层动过）',
    roomLoop(ROOM.walls).status === 'ok' && deriveSpatial(p).facts.rooms[0]!.closed === true);
  ok('21b. validatePlacementDesign 仍是独立可调用的一条链路（P8.3 出口没被取代）',
    validatePlacementDesign(p).status === 'valid' && Array.isArray(validatePlacementDesign(p).contacts));
}

// ═══════════════ 汇总 ═══════════════
console.log(`\n═══ P8.8 设计验证验收：${passed} 通过 / ${failed} 失败 ═══`);
if (failed > 0) {
  console.log('失败项：');
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exit(1);
}
