import type {
  Cabinet,
  CabinetGeometry,
  EdgeSpec,
  HardwareItem,
  Issue,
  Panel,
  Prim,
  PurchasedItem,
  RuleSet,
  UnitSpec,
  Vec2,
} from '../types.ts';
import { equalSpacing, round1 } from '../allocate.ts';
import { buildIssue } from '../rules/issueCatalog.ts';
import { localToWorld, polyLocalToWorld, rectPts } from './transform.ts';
import {
  backPanelSplit,
  computeCabinetLayout,
  doorWidths,
  drawerBoxParts,
  drawerCellHeights,
} from './layout.ts';

const E1 = 'E_1MM';
const E04 = 'E_04MM';

const L_PLAN = 'F-CAB';
const L_STRUCT = 'F-CAB-STRUCT';
const L_FRONT = 'F-CAB-FRONT';
const L_HW = 'F-CAB-HW';
const L_DIM = 'F-DIM';
const L_TEXT = 'F-TEXT';

function edge(top: string | null, bottom: string | null, left: string | null, right: string | null): EdgeSpec {
  return { top, bottom, left, right };
}

/** 柜体在平面上的四个角（世界坐标） */
export function getCabinetFootprint(cab: Cabinet): Vec2[] {
  const { x, y, rotation } = cab.placement;
  return polyLocalToWorld(rectPts(0, 0, cab.params.width, cab.params.depth), { x, y }, rotation);
}

/**
 * ★ 核心：Semantic Model → Panel Model + 2D 图元
 * 纯函数，无副作用，可被穷举单测（恒等式断言见 rules/validate.ts）
 */
export function generateCabinet(cab: Cabinet, rules: RuleSet): CabinetGeometry {
  const issues: Issue[] = [];
  const panels: Panel[] = [];
  const hardware: HardwareItem[] = [];
  const purchased: PurchasedItem[] = [];
  const plan: Prim[] = [];
  const planReferenceLabels: string[] = [];
  const elevation: Prim[] = [];

  const p = cab.params;
  const matBoard = rules.materials[p.boardMaterial];
  const matBack = rules.materials[p.backPanel.material];
  if (!matBoard || !matBack) throw new Error(`材质库缺少定义: ${p.boardMaterial} / ${p.backPanel.material}`);

  const L = computeCabinetLayout(cab, rules);
  const t = L.boardT;
  const tb = L.backT;
  const cabId = cab.id;
  const bodyH = L.bodyH;
  const innerW = L.innerW;
  const layerOf = (th: number): string => `PANEL_${th}`;
  /**
   * 柜内底面的 Z（底板上表面）—— **唯一**的"距柜内底 Xmm"基准点。
   * 多行柜里每一行的层板/挂衣杆位置都换算到这个绝对基准上，
   * 这样板件上的位置数字对车间只有一个读法（不用先问"哪一行的内底"）。
   * 单行柜下它与 v0.2 使用的 `bodyLift + t` 完全等价 → 文案逐字不变。
   */
  const innerBottomZ = p.bodyLift + t;
  /** 双面柜（岛台）派生骨架：undefined = 单面柜 */
  const DB = L.double;
  const isWallCabinet = (p.cabinetType ?? ((p.mountHeight ?? 0) > 0 ? 'wall' : 'base')) === 'wall';
  const hasKick = !isWallCabinet && p.bodyLift > 0;

  const push = (pn: Omit<Panel, 'qty'> & { qty?: number }): void => {
    panels.push({ qty: 1, ...pn });
  };

  // ───────── 1. 箱体结构板 ─────────
  // 见光板（Phase E 表达异形）：外露端板做 R36 前缘圆弧工艺。
  // 不改结构板数量，只改端板命名 + 标注（侧视图前缘圆弧由 views.ts 画）。
  const fe = p.finishedEnds ?? 'none';
  const isFinished = (side: 'left' | 'right'): boolean => fe === 'both' || fe === side;
  const feLabel = (side: 'left' | 'right'): string =>
    isFinished(side) ? '；前缘 R36 圆弧见光（工艺）' : '';
  push({ id: `P_${cabId}_LS`, role: 'LeftSidePanel', nameZh: isFinished('left') ? '见光板-左' : '左侧板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: bodyH, width: p.depth, grain: 'length', edge: edge(null, E04, E1, null), edgeLabel: '前边 1mm；上端 1mm；下端 0.4mm' + feLabel('left'), layer: layerOf(t) });
  push({ id: `P_${cabId}_RS`, role: 'RightSidePanel', nameZh: isFinished('right') ? '见光板-右' : '右侧板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: bodyH, width: p.depth, grain: 'length', edge: edge(null, E04, null, E1), edgeLabel: '前边 1mm；上端 1mm；下端 0.4mm（镜像）' + feLabel('right'), layer: layerOf(t) });
  push({ id: `P_${cabId}_TOP`, role: 'TopPanel', nameZh: '顶板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: p.depth, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '前边 1mm', layer: layerOf(t) });
  push({ id: `P_${cabId}_BOT`, role: 'BottomPanel', nameZh: '底板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: p.depth, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '前边 1mm', layer: layerOf(t) });
  if (hasKick) {
    push({ id: `P_${cabId}_KICK`, role: 'KickBoard', nameZh: '踢脚板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: p.bodyLift, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '上棱 1mm', layer: layerOf(t) });
  }

  // ── 双面柜（岛台）增件：共用中板 + 后踢脚，且**没有背板**（中板就是两排共用的"背"）──
  if (DB) {
    push({ id: `P_${cabId}_MID`, role: 'MiddlePanel', nameZh: '共用中板（双面）', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: bodyH, grain: 'length', edge: edge(null, null, null, null), edgeLabel: '不封边（藏于柜内）', layer: layerOf(t) });
    if (hasKick) {
      push({ id: `P_${cabId}_KICKB`, role: 'KickBoardBack', nameZh: '踢脚板-后', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: p.bodyLift, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '上棱 1mm', layer: layerOf(t) });
    }
    issues.push(buildIssue('DOUBLE-NO-BACKPANEL', { target: cabId, targetKind: 'cabinet', ctx: { cabName: cab.name, boardT: t, backRowDepth: DB.backRowDepth, midT: DB.midT, frontRowDepth: DB.frontRowDepth, depth: p.depth } }));
  }

  /**
   * 中立板与行隔板 —— 两者都来自**行结构**（canonical 的 `L.rows`），
   * 不是"谁手加的一块板"。这里不认识 rows/units 两种文件形状，也不需要认识。
   *
   *   · 中立板：每行内部、行内相邻分区之间的竖板。长度 = **该行净高**
   *     （不是整柜净高 —— 多行柜里拿整柜净高做中立板，上层中立板会捅穿顶板）。
   *   · 行隔板：行与行之间那块贯通横隔板，长度 = 内空宽（夹在两块侧板之间）。
   *
   * 单行柜：行内 `units.length-1` 块中立板、0 块行隔板 →
   * id（`P_cab_DIV1`）、长度（innerH）、文案与 v0.2 **逐字相同**。
   */
  const multiRowCab = L.rows.length > 1;
  L.rows.forEach((r, ri) => {
    const rowSuffix = multiRowCab ? `（第${ri + 1}行）` : '';
    for (let i = 0; i < r.units.length - 1; i++) {
      push({ id: `P_${cabId}_${r.panelTag}DIV${i + 1}`, role: 'DividerPanel', nameZh: `中立板${i + 1}${rowSuffix}`, belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: r.netH, width: p.depth, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '前边 1mm', layer: layerOf(t) });
    }
  });
  L.rowDividers.forEach((z, k) => {
    push({
      id: `P_${cabId}_RD${k + 1}`,
      role: 'RowDividerPanel',
      nameZh: `行隔板${k + 1}`,
      belongsTo: cabId,
      group: '箱体',
      material: p.boardMaterial,
      thickness: t,
      length: innerW,
      width: p.depth,
      grain: 'length',
      edge: edge(null, null, E1, null),
      edgeLabel: `前边 1mm；位置：距柜内底 ${z - innerBottomZ}mm`,
      layer: layerOf(t),
    });
  });

  // ───────── 2. 宽度分配（逐行）─────────
  // 每行独立分配（见 layout.ts 的 allocateRowWidths）；这里只取用，不重算。
  const netTotal = L.netTotal;

  /**
   * 期望净宽与实际净宽的偏差，**逐行**收集。
   * 单行柜下 drift 文案与 v0.2 逐字相同（不带行号）。
   */
  const drifted: string[] = [];
  L.rows.forEach((r, ri) => {
    const rowSuffix = L.rows.length > 1 ? `（第${ri + 1}行）` : '';
    r.units.forEach((u, i) => {
      if (r.nets[i] !== u.requestedWidth) {
        drifted.push(`${u.nickname ?? u.id}${rowSuffix} 期望净宽 ${u.requestedWidth} → 实际 ${r.nets[i]}（${r.nets[i]! - u.requestedWidth >= 0 ? '+' : ''}${r.nets[i]! - u.requestedWidth}mm）`);
      }
    });
  });
  if (drifted.length > 0) {
    issues.push(buildIssue('ALLOC-FIT-TOTAL', { target: cabId, targetKind: 'cabinet', ctx: { cabName: cab.name, width: p.width, netTotal, drift: drifted.join('；') } }));
  }

  // 诚实优先：未实现的东西必须在界面上说出来，而不是悄悄忽略
  if (cab.layout.widthMode === 'fit_units') {
    issues.push(buildIssue('LAYOUT-MODE-NOT-IMPLEMENTED', { target: cabId, targetKind: 'cabinet', ctx: { cabName: cab.name, width: p.width } }));
  }

  // ───────── 3. 背板（超幅面自动拆块，两个方向都要拆）─────────
  // 双面柜没有背板（共用中板替代）—— 整段跳过，不做"拆出 0 块"的假计算。
  if (!DB) {
  /**
   * 拆分方案来自 layout.ts 的 backPanelSplit —— 与分解图（assembly.ts）共用同一份。
   * 这里不再自己算 nW/nH：那正是"清单 6 块、图上 4 块"这类不一致的温床。
   */
  const backSplit = backPanelSplit(cab, L, rules);
  const backW = backSplit.w;
  const backH = backSplit.h;
  const nW = backSplit.nW;
  const nH = backSplit.nH;
  const backPieces = backSplit.pieces;

  if (backPieces > 1) {
    const [sheetL, sheetS] = rules.limits.maxSheetSize;
    // 摆放取向写进提示 —— 工人开料需要知道"块对板材的哪条边"，
    // 只说 nW×nH 等于把最后一步心算留给车间（拆块方案里选好的取向不该在这里丢失）
    const maxCol = Math.max(...backSplit.colW);
    const maxRow = Math.max(...backSplit.rowH);
    // 带上 "A/B" 这个标签：工人开料时说的是"按 A 面放"，只给一句解释他要再翻译一遍
    const orientZh =
      backSplit.orientation === 'A'
        ? `摆放取向 A：块宽对短板边（≤${sheetS}）、块高对长板边（≤${sheetL}）`
        : `摆放取向 B：块宽对长板边（≤${sheetL}）、块高对短板边（≤${sheetS}）`;
    issues.push(buildIssue('RULE-BACKPANEL-SPLIT', { target: cabId, targetKind: 'cabinet', ctx: { cabName: cab.name, bw: Math.round(backW), bh: Math.round(backH), sheetL, sheetS, cols: nW, rows: nH, pieces: backPieces, maxCol: Math.round(maxCol), maxRow: Math.round(maxRow), orientZh } }));
  }

  const colW = backSplit.colW;
  const rowH = backSplit.rowH;
  let backIndex = 0;
  for (let r = 0; r < nH; r++) {
    for (let c = 0; c < nW; c++) {
      backIndex++;
      const nameZh = backPieces > 1 ? `背板-${r + 1}${String.fromCharCode(65 + c)}` : '背板';
      push({
        id: `P_${cabId}_BACK${backIndex}`,
        role: 'BackPanel',
        nameZh,
        belongsTo: cabId,
        group: '箱体',
        material: p.backPanel.material,
        thickness: tb,
        length: rowH[r],
        width: colW[c],
        grain: 'none',
        edge: edge(null, null, null, null),
        edgeLabel: '不封边',
        layer: layerOf(tb),
      });
    }
  }
  } // end if (!DB) —— 双面柜没有背板段

  // ───────── 4. 各分区 ─────────
  const shelfDepth = L.shelfDepth;

  /**
   * 分区净高的口径：电器格（appliance）的洞口占掉下部 openingHeight + 一块过梁板，
   * 洞口上面的抽屉只拥有**剩余**净高 —— 恒等式与图面都必须用这个口径。
   *
   * 净高的上限是**这一行**的净高（`rowNetH`），不是整柜内空高：
   * 多行柜里拿整柜内空高算某一行的抽屉分格，分格会一路捅到别的行里去。
   */
  const unitNetH = (u: UnitSpec, rowNetH: number): number =>
    u.kind === 'appliance' && u.appliance ? rowNetH - u.appliance.openingHeight - t : rowNetH;

  /** 电器格的结构与清单派生：过梁板（洞口顶）+ 甲购件（机器本身不走开料机） */
  function buildAppliance(uid: string, unit: UnitSpec, netW: number, rowShelfDepth: number, zOffset: number): void {
    const a = unit.appliance!;
    // 过梁板：洞口的顶，跨整个分区净宽（洞口窄于净宽时两侧余量条同板连带）
    push({ id: `P_${cabId}_${uid}_APLT`, role: 'ApertureLintel', nameZh: '洞口过梁板', belongsTo: `${cabId}.${uid}`, group: uid, material: p.boardMaterial, thickness: t, length: netW, width: rowShelfDepth, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: `前边 1mm；位置：距柜内底 ${zOffset + a.openingHeight}mm（洞口顶）`, layer: layerOf(t) });
    purchased.push({
      id: `PC_${cabId}_${uid}_APP`,
      nameZh: `${a.name}（甲购 · 嵌入式电器）`,
      kind: 'appliance',
      material: '-',
      spec: `预留洞口 ${a.openingWidth}(宽)×${a.openingHeight}(高)×${a.openingDepth}(深)mm —— 洞口尺寸为机器尺寸 + 安装余量，安装前现场复核`,
      qty: 1,
      belongsTo: `${cabId}.${uid}`,
    });
  }

  /**
   * 一排分区的派生。四个调用方共用同一套 build 函数，只差四样：
   * 净宽表 / 层板深 / **该排净高** / **该排内空底面相对柜内底的偏移**（Z）。
   *
   *   ① 垂直各行（`L.rows`）—— 高度与 Z 各不相同；
   *   ② 双面柜背面排 —— 净高 = 整柜内空高、Z 偏移 = 0。
   *
   * 单行柜下偏移恒为 0、净高恒为 innerH → 与 v0.2 的板件与文案逐字相同。
   */
  function buildRow(units: UnitSpec[], netsRow: number[], rowShelfDepth: number, rowNetH: number, zOffset: number): void {
    units.forEach((u, i) => {
      const netW = netsRow[i]!;
      const netH = unitNetH(u, rowNetH);
      if (u.kind === 'appliance' && u.appliance) {
        buildAppliance(u.id, u, netW, rowShelfDepth, zOffset);
        // 电器格带门 = 洞口与门板打架 —— 如实报 ERROR 并不产出矛盾板件，不静默画一个怪门
        if (u.doors) {
          issues.push(buildIssue('RULE-APPLIANCE-DOOR', { target: `${cabId}.${u.id}`, targetKind: 'unit', ctx: { cabId, cab, unitIndex: i, unitName: u.nickname ?? u.id, unitId: u.id, applianceName: u.appliance.name } }));
        }
      }
      if (u.drawers) buildDrawerBank(u.id, u, netW, netH);
      if (u.shelves && u.shelves.count > 0) buildShelves(u.id, u.shelves, netW, netH, rowShelfDepth, zOffset);
      if (u.rod && u.rod.count > 0) {
        hardware.push({ id: `HW_${cabId}_${u.id}_ROD`, nameZh: '挂衣杆', kind: 'rod', qty: u.rod.count, spec: `${rules.hardware[u.rod.hardware]?.name ?? u.rod.hardware} L=${netW - 2}mm，距柜内底 ${zOffset + u.rod.heightFromBottom}mm`, belongsTo: `${cabId}.${u.id}` });
      }
      if (u.doors && u.kind !== 'appliance') buildDoors(u.id, u, netW, netH);
    });
  }

  // ① 垂直各行（canonical）：每行用**自己的**净宽表、净高与 Z 偏移
  L.rows.forEach((r) => buildRow(r.units, r.nets, shelfDepth, r.netH, r.z0 - innerBottomZ));
  // ② 双面柜背面排（与垂直行正交；多行 × 双面由校验器明确报"本阶段不支持"）
  if (DB) buildRow(cab.layout.backUnits!, DB.backNets, DB.backShelfDepth, L.innerH, 0);

  function buildDrawerBank(uid: string, unit: UnitSpec, netW: number, netH: number): void {
    const d = unit.drawers!;
    const cellH = drawerCellHeights(unit, netH, rules);
    for (let k = 0; k < d.count; k++) {
      // cellH 已由 layout.drawerCellHeights 扣除全部 (n+1) 道缝，这里直接作为面板高度，
      // 不得再扣 2×gap（否则面板比格子矮 2×gap，Σ面板高比净高短 2n×gap）。
      const frontH = cellH[k];
      const frontW = netW - 2 * d.gap;
      push({ id: `P_${cabId}_${uid}_DF${k + 1}`, role: 'DrawerFront', nameZh: `抽屉面板-${k + 1}`, belongsTo: `${cabId}.${uid}`, group: uid, material: p.boardMaterial, thickness: t, length: frontH, width: frontW, grain: 'length', edge: edge(E1, E1, E1, E1), edgeLabel: '四周 1mm（可见面）', layer: layerOf(t) });
      // 箱体尺寸来自 layout.ts 的 drawerBoxParts —— 与分解图共用同一份，不许各自算
      const box = drawerBoxParts(d, frontH, netW);
      push({ id: `P_${cabId}_${uid}_DS${k + 1}`, role: 'DrawerSide', nameZh: `抽屉侧板-${k + 1}`, belongsTo: `${cabId}.${uid}`, group: uid, material: 'M_BOARD_15_WOOD', thickness: d.sideThickness, length: box.sideLen, width: box.boxH, grain: 'length', edge: edge(E1, null, null, null), edgeLabel: '上棱 1mm', layer: layerOf(d.sideThickness), qty: 2 });
      push({ id: `P_${cabId}_${uid}_DB${k + 1}`, role: 'DrawerBack', nameZh: `抽屉后板-${k + 1}`, belongsTo: `${cabId}.${uid}`, group: uid, material: 'M_BOARD_15_WOOD', thickness: d.sideThickness, length: box.backLen, width: box.boxH, grain: 'length', edge: edge(E1, null, null, null), edgeLabel: '上棱 1mm', layer: layerOf(d.sideThickness) });
      push({ id: `P_${cabId}_${uid}_DBOT${k + 1}`, role: 'DrawerBottom', nameZh: `抽屉底板-${k + 1}`, belongsTo: `${cabId}.${uid}`, group: uid, material: 'M_BOARD_5', thickness: d.bottomThickness, length: box.bottomL, width: box.bottomW, grain: 'none', edge: edge(null, null, null, null), edgeLabel: '嵌槽，不封边', layer: layerOf(d.bottomThickness) });
    }
    hardware.push({ id: `HW_${cabId}_${uid}_RUNNER`, nameZh: '抽屉滑轨', kind: 'runner', qty: d.count, spec: `${rules.hardware[d.runner]?.name ?? d.runner}，L=${d.runnerLength}mm`, belongsTo: `${cabId}.${uid}` });
  }

  function buildShelves(uid: string, s: NonNullable<UnitSpec['shelves']>, netW: number, netH: number, sDepth: number, zOffset: number): void {
    const shelfW = netW - 2 * s.gapPerSide;
    /**
     * 斜层板（Phase E 图元扩展）：板件真实裁切长 = 水平跨度 / cos(tilt)。
     * 净宽分配仍按水平投影（tilt 不改变分区占用），只让板件更长、图面倾斜。
     * tilt=0（默认）时 realLen === shelfW，与旧行为完全一致（不留隐式分支）。
     */
    const tilt = s.tilt ?? 0;
    const tiltRad = (tilt * Math.PI) / 180;
    const cosT = Math.cos(tiltRad);
    const realLen = tilt > 0 ? Math.max(1, Math.round(shelfW / cosT)) : shelfW;
    const tiltNote = tilt > 0 ? `；斜 ${tilt}°（裁切长 ${realLen}mm = 水平 ${shelfW}mm ÷ cos${tilt}°）` : '';
    equalSpacing(netH, s.count).forEach((pos, k) => {
      push({ id: `P_${cabId}_${uid}_SH${k + 1}`, role: 'ShelfPanel', nameZh: tilt > 0 ? `斜层板-${k + 1}` : `层板-${k + 1}`, belongsTo: `${cabId}.${uid}`, group: uid, material: p.boardMaterial, thickness: t, length: realLen, width: sDepth, grain: 'length', edge: edge(E1, null, E1, null), edgeLabel: `前边 1mm；位置：距柜内底 ${zOffset + pos}mm${tiltNote}`, layer: layerOf(t) });
    });
    hardware.push({ id: `HW_${cabId}_${uid}_PIN`, nameZh: '层板托', kind: 'shelfPin', qty: s.count * 4, spec: '每块层板 4 只', belongsTo: `${cabId}.${uid}` });
    if (s.ledStrip && s.ledStrip !== 'none') {
      // 灯带：安装位是语义字段（center/front/angled45），五金 ID 由安装位映射到规则集目录
      const ledId = s.ledStrip === 'center' ? 'HW_LED_CENTER' : s.ledStrip === 'front' ? 'HW_LED_FRONT' : 'HW_LED_ANGLED45';
      hardware.push({
        id: `HW_${cabId}_${uid}_LED`,
        nameZh: '层板灯带',
        kind: 'ledStrip',
        qty: s.count,
        spec: `${rules.hardware[ledId]?.name ?? ledId}，每块层板 1 条（L=${Math.round(netW)}mm）`,
        belongsTo: `${cabId}.${uid}`,
      });
    }
  }

  function buildDoors(uid: string, unit: Cabinet['layout']['units'][number], netW: number, netH: number): void {
    const dr = unit.doors!;
    const doorH = netH - 2 * dr.gapOuter;
    const widths = doorWidths(unit, netW, rules);
    /**
     * 门板材质从语义字段 dr.material 派生（docFactory 已显式补齐）。
     * 未知材质 ID 不静默吞掉 —— 报 WARNING 并回退柜体板材，否则一张
     * 引用了已删材质的门板会带着错误厚度一路走到开料。
     */
    const mId = dr.material && rules.materials[dr.material] ? dr.material : p.boardMaterial;
    if (mId !== dr.material) {
      issues.push(
        buildIssue('RULE-DOOR-MATERIAL', {
          target: `${cabId}.${uid}`,
          targetKind: 'unit',
          ctx: {
            unitName: unit.nickname ?? uid,
            unitId: uid,
            doorMaterial: dr.material,
            fallback: p.boardMaterial,
            // 说清"材质库里现在有什么"，比只说"找不到"有用
            candidates: Object.keys(rules.materials),
          },
        })
      );
    }
    const mDef = rules.materials[mId]!;
    if (mDef.kind === 'glass') {
      /**
       * 清单分流：玻璃门是甲购/外采件 —— 它不走开料机，进 purchased
       * （开料单上单独一节），绝不混进板件清单。这是「派生视图按用途分流」
       * 的实例：模型里只有 material 一个字段，分流发生在派生层。
       */
      widths.forEach((w, k) => {
        purchased.push({
          id: `PC_${cabId}_${uid}_GLASS${k + 1}`,
          nameZh: `玻璃门-${k + 1}`,
          kind: 'glassDoor',
          material: mId,
          spec: `${mDef.name}，${Math.round(doorH)}×${Math.round(w)}×${mDef.thickness}mm，四周铝合金框（黑框灰玻）`,
          qty: 1,
          belongsTo: `${cabId}.${uid}`,
        });
      });
    } else {
      widths.forEach((w, k) => {
        push({ id: `P_${cabId}_${uid}_DOOR${k + 1}`, role: 'DoorPanel', nameZh: `门板-${k + 1}`, belongsTo: `${cabId}.${uid}`, group: uid, material: mId, thickness: mDef.thickness, length: doorH, width: w, grain: mDef.grain ? 'length' : 'none', edge: edge(E1, E1, E1, E1), edgeLabel: '四周 1mm（可见面）', layer: layerOf(mDef.thickness) });
      });
    }
    const hingePerDoor = Math.max(2, Math.ceil(doorH / rules.limits.hingeSpacingMax));
    hardware.push({ id: `HW_${cabId}_${uid}_HINGE`, nameZh: '门铰链', kind: 'hinge', qty: hingePerDoor * dr.count, spec: `${rules.hardware[dr.hinge]?.name ?? dr.hinge}，每扇 ${hingePerDoor} 只（门高 ${Math.round(doorH)}mm ÷ 间距上限 ${rules.limits.hingeSpacingMax}mm）`, belongsTo: `${cabId}.${uid}` });
    hardware.push({ id: `HW_${cabId}_${uid}_HANDLE`, nameZh: '拉手', kind: 'handle', qty: dr.count, spec: 'HW_HANDLE_128 128mm 孔距', belongsTo: `${cabId}.${uid}` });
  }

  // ───────── 5. 2D 图元：平面 ─────────
  const { x: ox, y: oy, rotation } = cab.placement;
  const origin = { x: ox, y: oy };
  const W = p.width;
  const D = p.depth;

  const toWorld = (pts: Vec2[]): Vec2[] => polyLocalToWorld(pts, origin, rotation);

  plan.push({ k: 'fill', pts: toWorld(rectPts(0, 0, W, D)), layer: L_PLAN, alpha: isWallCabinet ? 0.035 : 0.12 });
  plan.push({ k: 'poly', pts: toWorld(rectPts(0, 0, W, D)), closed: true, layer: L_PLAN, lw: 2, ...(isWallCabinet ? { dash: [120, 70] } : {}) });
  for (const cutout of p.counterCutouts ?? []) {
    const pts = toWorld([{ x: cutout.x, y: cutout.y }, { x: cutout.x + cutout.width, y: cutout.y }, { x: cutout.x + cutout.width, y: cutout.y + cutout.depth }, { x: cutout.x, y: cutout.y + cutout.depth }]);
    plan.push({ k: 'poly', pts, closed: true, layer: L_HW, lw: 1.6, dash: [90, 50] });
    planReferenceLabels.push(`${cutout.name} ${cutout.width}×${cutout.depth}`);
  }

  // 结构板（侧板/立板）在平面上是横跨进深的线；双面柜的立板各自只跨本排箱体
  const structLines: Array<[number, number, number, number]> = [
    [0, t, 0, D],
    [W - t, W, 0, D],
  ];
  /**
   * 中立板的平面位置**逐行取并集**：多行柜里各行的中立板可以落在不同的 X
   * （上行 2 格、下行 3 格），俯视图上要把它们都画出来 —— 只画第一行会漏掉下行的隔板。
   * 单行柜：并集就是原来那一串，逐条相同。
   */
  const dividerXs = new Set<number>();
  L.rows.forEach((r) => {
    for (let i = 0; i < r.units.length - 1; i++) dividerXs.add(r.unitX0[i]! + r.nets[i]!);
  });
  for (const dx of dividerXs) {
    structLines.push([dx, dx + t, DB ? DB.midY0 + DB.midT : 0, D]);
  }
  if (DB) {
    cab.layout.backUnits!.forEach((_, i) => {
      const dx = DB.backUnitX0[i] + DB.backNets[i];
      structLines.push([dx, dx + t, 0, DB.midY0]);
    });
    // 中板：两条横线（厚度方向），跨全宽
    plan.push({ k: 'poly', pts: toWorld([{ x: t, y: DB.midY0 }, { x: W - t, y: DB.midY0 }]), closed: false, layer: L_STRUCT, lw: 1.6 });
    plan.push({ k: 'poly', pts: toWorld([{ x: t, y: DB.midY0 + DB.midT }, { x: W - t, y: DB.midY0 + DB.midT }]), closed: false, layer: L_STRUCT, lw: 1.6 });
  }
  for (const [xa, xb, ya, yb] of structLines) {
    plan.push({ k: 'poly', pts: toWorld([{ x: (xa + xb) / 2, y: ya }, { x: (xa + xb) / 2, y: yb }]), closed: false, layer: L_STRUCT, lw: 1.6 });
  }

  // 门板 / 抽屉面板：贴前脸的一条线（双面柜的背面脸在 y = t 侧，对称地画）
  const drawFaceLines = (units: UnitSpec[], netsRow: number[], x0s: number[], yFront: number, towardFront: boolean): void => {
    units.forEach((u, i) => {
      if (!u.doors && !u.drawers && u.kind !== 'appliance') return;
      const x0 = x0s[i]!;
      const x1 = x0 + netsRow[i]!;
      plan.push({ k: 'poly', pts: toWorld([{ x: x0, y: yFront }, { x: x1, y: yFront }]), closed: false, layer: L_FRONT, lw: 2.4 });
      if (u.doors && u.doors.count > 1) {
        for (let k = 1; k < u.doors.count; k++) {
          const xk = x0 + (netsRow[i]! * k) / u.doors.count;
          plan.push({ k: 'poly', pts: toWorld([{ x: xk, y: yFront }, { x: xk, y: towardFront ? D : 0 }]), closed: false, layer: L_FRONT, lw: 1 });
        }
      }
      if (u.drawers && u.drawers.count > 1) {
        // 分格线与原版同口径：横跨整柜进深（平面图上表达"这一列是 N 格抽屉"）
        for (let k = 1; k < u.drawers.count; k++) {
          const yk = towardFront ? D - (D * k) / u.drawers.count : (D * k) / u.drawers.count;
          plan.push({ k: 'poly', pts: toWorld([{ x: x0, y: yk }, { x: x1, y: yk }]), closed: false, layer: L_FRONT, lw: 0.8 });
        }
      }
      if (u.kind === 'appliance' && u.appliance) {
        // 电器外框：洞口宽居中于净宽、深按洞口深贴脸，虚线表达"此处留空放机器"
        const a = u.appliance;
        const ow = Math.min(a.openingWidth, netsRow[i]!);
        const od = Math.min(a.openingDepth, towardFront ? D - yFront : yFront);
        const ox0 = x0 + (netsRow[i]! - ow) / 2;
        const ox1 = ox0 + ow;
        const oy0 = towardFront ? D - od : od;
        const oy1 = towardFront ? D : 0;
        plan.push({ k: 'poly', pts: toWorld([{ x: ox0, y: oy0 }, { x: ox1, y: oy0 }, { x: ox1, y: oy1 }, { x: ox0, y: oy1 }]), closed: true, layer: L_HW, lw: 1.2, dash: [90, 50] });
        planReferenceLabels.push(`${a.name} ${a.openingWidth}×${a.openingHeight}`);
      }
    });
  };
  // 各行的前脸线都画在俯视图上（行在垂直方向叠，平面图上重合成同一段 → 逐行画同样正确）
  L.rows.forEach((r) => drawFaceLines(r.units, r.nets, r.unitX0, D - t, true));
  if (DB) drawFaceLines(cab.layout.backUnits!, DB.backNets, DB.backUnitX0, t, false);

  // 预留说明放在投影框外的独立行；虚线框内只保留几何轮廓，避免标签被线条或隔板穿过。
  planReferenceLabels.forEach((text, index) => {
    plan.push({ k: 'text', p: localToWorld({ x: W / 2, y: D + 220 + index * 120 }, origin, rotation), text, size: 65, layer: L_HW, align: 'c', rot: rotation });
  });

  // 平面标注：柜体宽 + 深（贴在柜体外侧）。吊柜与地柜尺寸线分行，避免投影重叠。
  const dimY = isWallCabinet ? -350 : -180;
  plan.push({ k: 'poly', pts: toWorld([{ x: 0, y: dimY }, { x: W, y: dimY }]), closed: false, layer: L_DIM, lw: 0.8 });
  plan.push({ k: 'poly', pts: toWorld([{ x: 0, y: dimY - 30 }, { x: 0, y: 0 }]), closed: false, layer: L_DIM, lw: 0.8 });
  plan.push({ k: 'poly', pts: toWorld([{ x: W, y: dimY - 30 }, { x: W, y: 0 }]), closed: false, layer: L_DIM, lw: 0.8 });
  plan.push({ k: 'text', p: localToWorld({ x: W / 2, y: dimY - 90 }, origin, rotation), text: `${W}`, size: 90, layer: L_DIM, align: 'c', rot: rotation });

  if (isWallCabinet) {
    // 上柜文字放到两类柜体投影之外，并明确底标高；不再与地柜标签叠在同一行。
    const labelY = D + 420 + planReferenceLabels.length * 130;
    plan.push({ k: 'text', p: localToWorld({ x: W / 2, y: labelY }, origin, rotation), text: `${cab.name} 吊柜底 ${p.mountHeight ?? 0}mm`, size: 80, layer: L_TEXT, align: 'c', rot: rotation });
    plan.push({ k: 'text', p: localToWorld({ x: W / 2, y: labelY + 110 }, origin, rotation), text: `${W}×${p.height}×${D}`, size: 80, layer: L_TEXT, align: 'c', rot: rotation });
  } else {
    // 地柜标注也移到投影外，水槽/灶具的台面预留标记不再被文字盖住。
    const labelY = D + 720 + planReferenceLabels.length * 180;
    plan.push({ k: 'text', p: localToWorld({ x: W / 2, y: labelY }, origin, rotation), text: cab.name, size: 80, layer: L_TEXT, align: 'c', rot: rotation });
    plan.push({ k: 'text', p: localToWorld({ x: W / 2, y: labelY + 110 }, origin, rotation), text: `${W}×${p.height}×${D}`, size: 80, layer: L_TEXT, align: 'c', rot: rotation });
  }

  // ───────── 6. 2D 图元：立面（局部坐标，y 向上）─────────
  const baseY = p.bodyLift;
  elevation.push({ k: 'poly', pts: rectPts(0, 0, W, p.height), closed: true, layer: L_PLAN, lw: 1.6 });
  elevation.push({ k: 'poly', pts: rectPts(t, 0, innerW, p.bodyLift), closed: true, layer: L_STRUCT, lw: 1 });
  elevation.push({ k: 'poly', pts: rectPts(0, baseY, t, bodyH), closed: true, layer: L_STRUCT, lw: 1 });
  elevation.push({ k: 'poly', pts: rectPts(W - t, baseY, t, bodyH), closed: true, layer: L_STRUCT, lw: 1 });
  elevation.push({ k: 'poly', pts: rectPts(t, p.height - t, innerW, t), closed: true, layer: L_STRUCT, lw: 1 });
  elevation.push({ k: 'poly', pts: rectPts(t, baseY, innerW, t), closed: true, layer: L_STRUCT, lw: 1 });
  // 行隔板（贯通横隔板）：立面上一块横贯内宽的横板；单行柜无此行 → 与 v0.2 逐图元相同
  L.rowDividers.forEach((z) => {
    elevation.push({ k: 'poly', pts: rectPts(t, z, innerW, t), closed: true, layer: L_STRUCT, lw: 1 });
  });
  // 各行内部的中立板：纵向只跨**本行**净高（不再跨整柜内空高）
  L.rows.forEach((r) => {
    for (let i = 0; i < r.units.length - 1; i++) {
      elevation.push({ k: 'poly', pts: rectPts(r.unitX0[i]! + r.nets[i]!, r.z0, t, r.netH), closed: true, layer: L_STRUCT, lw: 1 });
    }
  });
  L.rows.forEach((r) => {
    r.units.forEach((u, i) => {
      const x0 = r.unitX0[i]!;
      const netW = r.nets[i]!;
      const rowZ0 = r.z0;
      const rowNetH = r.netH;
      // 电器格：洞口占掉下部，上部的抽屉/层板从过梁板之上开始；洞口本身画虚线框
      const apZ0 = u.kind === 'appliance' && u.appliance ? u.appliance.openingHeight + t : 0;
      if (u.kind === 'appliance' && u.appliance) {
        const a = u.appliance;
        const ow = Math.min(a.openingWidth, netW);
        const ax0 = x0 + (netW - ow) / 2;
        elevation.push({ k: 'poly', pts: rectPts(ax0, rowZ0, ow, Math.min(a.openingHeight, rowNetH)), closed: true, layer: L_HW, lw: 1.2, dash: [90, 50] });
        elevation.push({ k: 'text', p: { x: x0 + netW / 2, y: rowZ0 + Math.min(a.openingHeight, rowNetH) / 2 }, text: `${a.name} ${a.openingWidth}×${a.openingHeight}`, size: 80, layer: L_TEXT, align: 'c' });
      }
      if (u.shelves && u.shelves.count > 0) {
        const tilt = u.shelves.tilt ?? 0;
        // 层板图元与真实 ShelfPanel 同源：宽 = 净宽 - 2×gapPerSide（两侧留缝），不是满净宽。
        const sw = netW - 2 * u.shelves.gapPerSide;
        const sx0 = x0 + u.shelves.gapPerSide;
        const shift = tilt > 0 ? Math.round(netW * Math.tan((tilt * Math.PI) / 180)) : 0;
        equalSpacing(rowNetH, u.shelves.count).forEach((pos) => {
          const yb = rowZ0 + pos;
          // 斜层板：平行四边形（右端下沉 shift），与四视图（views.ts）同源表达
          const pts =
            shift > 0
              ? [
                  { x: sx0, y: yb },
                  { x: sx0 + sw, y: yb - shift },
                  { x: sx0 + sw, y: yb - shift + t },
                  { x: sx0, y: yb + t },
                ]
              : rectPts(sx0, yb, sw, t);
          elevation.push({ k: 'poly', pts, closed: true, layer: L_STRUCT, lw: 1 });
        });
      }
      if (u.drawers) {
        const netH = rowNetH - apZ0;
        const cellH = drawerCellHeights(u, netH, rules);
        let y = rowZ0 + apZ0 + u.drawers.gap;
        for (let k = 0; k < cellH.length; k++) {
          elevation.push({ k: 'poly', pts: rectPts(x0 + u.drawers.gap, y, netW - 2 * u.drawers.gap, cellH[k]!), closed: true, layer: L_FRONT, lw: 1.4 });
          y += cellH[k]! + u.drawers.gap;
        }
      }
      // 电器格（appliance）即使语义带 doors，也不画门 —— 门是给柜体分区用的，
      // 电器格画门会凭空造出不存在的 DoorPanel（与 buildRow 的守卫口径一致）。
      if (u.doors && u.kind !== 'appliance') {
        const widths = doorWidths(u, netW, rules);
        let x = x0 + u.doors.gapOuter;
        for (const w of widths) {
          elevation.push({ k: 'poly', pts: rectPts(x, rowZ0 + u.doors.gapOuter, w, rowNetH - 2 * u.doors.gapOuter), closed: true, layer: L_FRONT, lw: 1.4 });
          x += w + u.doors.gapMid;
        }
      }
      if (u.rod) {
        elevation.push({ k: 'poly', pts: [{ x: x0 + 2, y: rowZ0 + u.rod.heightFromBottom }, { x: x0 + netW - 2, y: rowZ0 + u.rod.heightFromBottom }], closed: false, layer: L_HW, lw: 1.4, dash: [40, 20, 6, 20] });
      }
    });
  });

  // ───────── 7. 统计 ─────────
  const totalPieces = panels.reduce((a, x) => a + x.qty, 0);
  let areaMm2 = 0;
  let weightKg = 0;
  for (const x of panels) {
    const a = x.length * x.width * x.qty;
    areaMm2 += a;
    const dens = rules.materials[x.material]?.density ?? 0.72;
    weightKg += (a / 1e6) * (x.thickness / 1000) * dens * 1000;
  }

  return {
    cabinetId: cabId,
    panels,
    hardware,
    purchased,
    plan,
    elevation,
    issues,
    stats: { panelKinds: panels.length, totalPieces, boardAreaM2: round1(areaMm2 / 1e6), estWeightKg: round1(weightKg) },
    layout: L,
  };
}
