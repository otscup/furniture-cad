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
  Vec2,
} from '../types.ts';
import { equalSpacing, round1 } from '../allocate.ts';
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
  const innerH = L.innerH;
  const layerOf = (th: number): string => `PANEL_${th}`;
  /** 双面柜（岛台）派生骨架：undefined = 单面柜 */
  const DB = L.double;

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
  push({ id: `P_${cabId}_KICK`, role: 'KickBoard', nameZh: '踢脚板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: p.bodyLift, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '上棱 1mm', layer: layerOf(t) });

  // ── 双面柜（岛台）增件：共用中板 + 后踢脚，且**没有背板**（中板就是两排共用的"背"）──
  if (DB) {
    push({ id: `P_${cabId}_MID`, role: 'MiddlePanel', nameZh: '共用中板（双面）', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: bodyH, grain: 'length', edge: edge(null, null, null, null), edgeLabel: '不封边（藏于柜内）', layer: layerOf(t) });
    push({ id: `P_${cabId}_KICKB`, role: 'KickBoardBack', nameZh: '踢脚板-后', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: p.bodyLift, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '上棱 1mm', layer: layerOf(t) });
    issues.push({
      severity: 'INFO',
      code: 'DOUBLE-NO-BACKPANEL',
      target: cabId,
      targetKind: 'cabinet',
      message: `双面柜不设背板：前后两排背靠背，共用 ${t}mm 中板（排深 ${DB.backRowDepth} + 中板 ${DB.midT} + ${DB.frontRowDepth} = 总深 ${p.depth}mm）。params.backPanel 的槽位参数不参与本柜派生。`,
    });
  }

  const unitCount = cab.layout.units.length;
  for (let i = 0; i < unitCount - 1; i++) {
    push({ id: `P_${cabId}_DIV${i + 1}`, role: 'DividerPanel', nameZh: `中立板${i + 1}`, belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerH, width: p.depth, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '前边 1mm', layer: layerOf(t) });
  }

  // ───────── 2. 宽度分配 ─────────
  const netTotal = L.netTotal;
  const nets = L.nets;
  const unitX0 = L.unitX0;

  const drifted: string[] = [];
  cab.layout.units.forEach((u, i) => {
    if (nets[i] !== u.requestedWidth) {
      drifted.push(`${u.nickname ?? u.id} 期望净宽 ${u.requestedWidth} → 实际 ${nets[i]}（${nets[i] - u.requestedWidth >= 0 ? '+' : ''}${nets[i] - u.requestedWidth}mm）`);
    }
  });
  if (drifted.length > 0) {
    issues.push({
      severity: 'INFO',
      code: 'ALLOC-FIT-TOTAL',
      target: cabId,
      targetKind: 'cabinet',
      message: `总宽 ${p.width}mm 固定，扣除两侧板 ${t}×2 与立板 ${t}×${unitCount - 1} 后可用净宽 ${netTotal}mm，按期望比例重新分配：${drifted.join('；')}。这是「总宽优先」策略的必然结果，不是错误。`,
      fixHint: '如需严格满足净宽，请把 layout.widthMode 改为 fit_units（总宽将随之变化）',
    });
  }

  // 诚实优先：未实现的东西必须在界面上说出来，而不是悄悄忽略
  if (cab.layout.widthMode === 'fit_units') {
    issues.push({
      severity: 'INFO',
      code: 'LAYOUT-MODE-NOT-IMPLEMENTED',
      target: cabId,
      targetKind: 'cabinet',
      message: 'layout.widthMode = fit_units 尚未实现：当前生成器一律按「总宽优先」分配净宽，params.width 仍是唯一权威。',
      fixHint: 'Phase 2 将实现"按净宽反算总宽"（需先解决与 params.width 的权威冲突）。在此之前请使用 fit_total。',
    });
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
    const orientZh =
      backSplit.orientation === 'A'
        ? `块宽对短板边（≤${sheetS}）、块高对长板边（≤${sheetL}）`
        : `块宽对长板边（≤${sheetL}）、块高对短板边（≤${sheetS}）`;
    issues.push({
      severity: 'WARNING',
      code: 'RULE-BACKPANEL-SPLIT',
      target: cabId,
      targetKind: 'cabinet',
      message: `背板 ${Math.round(backW)}×${Math.round(backH)}mm 超出板材最大幅面 ${sheetL}×${sheetS}，已按 ${nW} 列 × ${nH} 行拆为 ${backPieces} 块。摆放取向 ${backSplit.orientation}：${orientZh}；单块最大 ${Math.round(maxCol)}×${Math.round(maxRow)}mm。`,
      fixHint: '确认拼接方向与压条方案；或改用 5mm 背板条（条状背板不受幅面限制）',
    });
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
   */
  const unitNetH = (u: Cabinet['layout']['units'][number]): number =>
    u.kind === 'appliance' && u.appliance ? innerH - u.appliance.openingHeight - t : innerH;

  /** 电器格的结构与清单派生：过梁板（洞口顶）+ 甲购件（机器本身不走开料机） */
  function buildAppliance(uid: string, unit: Cabinet['layout']['units'][number], netW: number, rowShelfDepth: number): void {
    const a = unit.appliance!;
    // 过梁板：洞口的顶，跨整个分区净宽（洞口窄于净宽时两侧余量条同板连带）
    push({ id: `P_${cabId}_${uid}_APLT`, role: 'ApertureLintel', nameZh: '洞口过梁板', belongsTo: `${cabId}.${uid}`, group: uid, material: p.boardMaterial, thickness: t, length: netW, width: rowShelfDepth, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: `前边 1mm；位置：距柜内底 ${a.openingHeight}mm（洞口顶）`, layer: layerOf(t) });
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

  /** 一排分区的派生（前排 / 后排共用 —— 同一套 build 函数，只差净宽表与层板深） */
  function buildRow(units: Cabinet['layout']['units'], netsRow: number[], rowShelfDepth: number): void {
    units.forEach((u, i) => {
      const netW = netsRow[i];
      const netH = unitNetH(u);
      if (u.kind === 'appliance' && u.appliance) {
        buildAppliance(u.id, u, netW, rowShelfDepth);
        // 电器格带门 = 洞口与门板打架 —— 如实报 ERROR 并不产出矛盾板件，不静默画一个怪门
        if (u.doors) {
          issues.push({ severity: 'ERROR', code: 'RULE-APPLIANCE-DOOR', target: `${cabId}.${u.id}`, targetKind: 'unit', message: `电器格「${u.nickname ?? u.id}」带了门板，但洞口（${u.appliance.openingWidth}×${u.appliance.openingHeight}）与门板在同一张脸上互相冲突。`, fixHint: '去掉门（机器露前脸是常规做法），或把这个分区改成普通层板格' });
        }
      }
      if (u.drawers) buildDrawerBank(u.id, u, netW, netH);
      if (u.shelves && u.shelves.count > 0) buildShelves(u.id, u.shelves, netW, netH, rowShelfDepth);
      if (u.rod && u.rod.count > 0) {
        hardware.push({ id: `HW_${cabId}_${u.id}_ROD`, nameZh: '挂衣杆', kind: 'rod', qty: u.rod.count, spec: `${rules.hardware[u.rod.hardware]?.name ?? u.rod.hardware} L=${netW - 2}mm，距柜内底 ${u.rod.heightFromBottom}mm`, belongsTo: `${cabId}.${u.id}` });
      }
      if (u.doors && u.kind !== 'appliance') buildDoors(u.id, u, netW, netH);
    });
  }

  buildRow(cab.layout.units, nets, shelfDepth);
  if (DB) buildRow(cab.layout.backUnits!, DB.backNets, DB.backShelfDepth);

  function buildDrawerBank(uid: string, unit: Cabinet['layout']['units'][number], netW: number, netH: number): void {
    const d = unit.drawers!;
    const cellH = drawerCellHeights(unit, netH, rules);
    for (let k = 0; k < d.count; k++) {
      const frontH = cellH[k] - 2 * d.gap;
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

  function buildShelves(uid: string, s: NonNullable<Cabinet['layout']['units'][number]['shelves']>, netW: number, netH: number, sDepth: number): void {
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
      push({ id: `P_${cabId}_${uid}_SH${k + 1}`, role: 'ShelfPanel', nameZh: tilt > 0 ? `斜层板-${k + 1}` : `层板-${k + 1}`, belongsTo: `${cabId}.${uid}`, group: uid, material: p.boardMaterial, thickness: t, length: realLen, width: sDepth, grain: 'length', edge: edge(E1, null, E1, null), edgeLabel: `前边 1mm；位置：距柜内底 ${pos}mm${tiltNote}`, layer: layerOf(t) });
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
      issues.push({ severity: 'WARNING', code: 'RULE-DOOR-MATERIAL', target: `${cabId}.${uid}`, targetKind: 'unit', message: `门板材质「${dr.material}」不在材质库，已回退「${p.boardMaterial}」`, fixHint: '改用规则集里存在的材质 ID' });
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

  plan.push({ k: 'fill', pts: toWorld(rectPts(0, 0, W, D)), layer: L_PLAN, alpha: 0.12 });
  plan.push({ k: 'poly', pts: toWorld(rectPts(0, 0, W, D)), closed: true, layer: L_PLAN, lw: 2 });

  // 结构板（侧板/立板）在平面上是横跨进深的线；双面柜的立板各自只跨本排箱体
  const structLines: Array<[number, number, number, number]> = [
    [0, t, 0, D],
    [W - t, W, 0, D],
  ];
  for (let i = 0; i < unitCount - 1; i++) {
    const dx = unitX0[i] + nets[i];
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
  const drawFaceLines = (units: Cabinet['layout']['units'], netsRow: number[], x0s: number[], yFront: number, towardFront: boolean): void => {
    units.forEach((u, i) => {
      if (!u.doors && !u.drawers && u.kind !== 'appliance') return;
      const x0 = x0s[i];
      const x1 = x0 + netsRow[i];
      plan.push({ k: 'poly', pts: toWorld([{ x: x0, y: yFront }, { x: x1, y: yFront }]), closed: false, layer: L_FRONT, lw: 2.4 });
      if (u.doors && u.doors.count > 1) {
        for (let k = 1; k < u.doors.count; k++) {
          const xk = x0 + (netsRow[i] * k) / u.doors.count;
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
        const ow = Math.min(a.openingWidth, netsRow[i]);
        const od = Math.min(a.openingDepth, towardFront ? D - yFront : yFront);
        const ox0 = x0 + (netsRow[i] - ow) / 2;
        const ox1 = ox0 + ow;
        const oy0 = towardFront ? D - od : od;
        const oy1 = towardFront ? D : 0;
        plan.push({ k: 'poly', pts: toWorld([{ x: ox0, y: oy0 }, { x: ox1, y: oy0 }, { x: ox1, y: oy1 }, { x: ox0, y: oy1 }]), closed: true, layer: L_HW, lw: 1.2, dash: [90, 50] });
        plan.push({ k: 'text', p: localToWorld({ x: (ox0 + ox1) / 2, y: (oy0 + oy1) / 2 }, origin, rotation), text: a.name, size: 80, layer: L_TEXT, align: 'c', rot: rotation });
      }
    });
  };
  drawFaceLines(cab.layout.units, nets, unitX0, D - t, true);
  if (DB) drawFaceLines(cab.layout.backUnits!, DB.backNets, DB.backUnitX0, t, false);

  // 平面标注：柜体宽 + 深（贴在柜体外侧）
  const dimY = -180;
  plan.push({ k: 'poly', pts: toWorld([{ x: 0, y: dimY }, { x: W, y: dimY }]), closed: false, layer: L_DIM, lw: 0.8 });
  plan.push({ k: 'poly', pts: toWorld([{ x: 0, y: dimY - 30 }, { x: 0, y: 0 }]), closed: false, layer: L_DIM, lw: 0.8 });
  plan.push({ k: 'poly', pts: toWorld([{ x: W, y: dimY - 30 }, { x: W, y: 0 }]), closed: false, layer: L_DIM, lw: 0.8 });
  plan.push({ k: 'text', p: localToWorld({ x: W / 2, y: dimY - 90 }, origin, rotation), text: `${W}`, size: 90, layer: L_DIM, align: 'c', rot: rotation });

  plan.push({ k: 'text', p: localToWorld({ x: W / 2, y: D / 2 - 60 }, origin, rotation), text: cab.name, size: 110, layer: L_TEXT, align: 'c', rot: rotation });
  plan.push({ k: 'text', p: localToWorld({ x: W / 2, y: D / 2 + 60 }, origin, rotation), text: `${W}×${p.height}×${D}`, size: 80, layer: L_TEXT, align: 'c', rot: rotation });

  // ───────── 6. 2D 图元：立面（局部坐标，y 向上）─────────
  const baseY = p.bodyLift;
  const innerBottomY = baseY + t;
  elevation.push({ k: 'poly', pts: rectPts(0, 0, W, p.height), closed: true, layer: L_PLAN, lw: 1.6 });
  elevation.push({ k: 'poly', pts: rectPts(t, 0, innerW, p.bodyLift), closed: true, layer: L_STRUCT, lw: 1 });
  elevation.push({ k: 'poly', pts: rectPts(0, baseY, t, bodyH), closed: true, layer: L_STRUCT, lw: 1 });
  elevation.push({ k: 'poly', pts: rectPts(W - t, baseY, t, bodyH), closed: true, layer: L_STRUCT, lw: 1 });
  elevation.push({ k: 'poly', pts: rectPts(t, p.height - t, innerW, t), closed: true, layer: L_STRUCT, lw: 1 });
  elevation.push({ k: 'poly', pts: rectPts(t, baseY, innerW, t), closed: true, layer: L_STRUCT, lw: 1 });
  for (let i = 0; i < unitCount - 1; i++) {
    elevation.push({ k: 'poly', pts: rectPts(unitX0[i] + nets[i], innerBottomY, t, innerH), closed: true, layer: L_STRUCT, lw: 1 });
  }
  cab.layout.units.forEach((u, i) => {
    const x0 = unitX0[i];
    const netW = nets[i];
    // 电器格：洞口占掉下部，上部的抽屉/层板从过梁板之上开始；洞口本身画虚线框
    const apZ0 = u.kind === 'appliance' && u.appliance ? u.appliance.openingHeight + t : 0;
    if (u.kind === 'appliance' && u.appliance) {
      const a = u.appliance;
      const ow = Math.min(a.openingWidth, netW);
      const ax0 = x0 + (netW - ow) / 2;
      elevation.push({ k: 'poly', pts: rectPts(ax0, innerBottomY, ow, Math.min(a.openingHeight, innerH)), closed: true, layer: L_HW, lw: 1.2, dash: [90, 50] });
      elevation.push({ k: 'text', p: { x: x0 + netW / 2, y: innerBottomY + Math.min(a.openingHeight, innerH) / 2 }, text: `${a.name} ${a.openingWidth}×${a.openingHeight}`, size: 80, layer: L_TEXT, align: 'c' });
    }
    if (u.shelves && u.shelves.count > 0) {
      const tilt = u.shelves.tilt ?? 0;
      const shift = tilt > 0 ? Math.round(netW * Math.tan((tilt * Math.PI) / 180)) : 0;
      equalSpacing(innerH, u.shelves.count).forEach((pos) => {
        const yb = innerBottomY + pos;
        // 斜层板：平行四边形（右端下沉 shift），与四视图（views.ts）同源表达
        const pts =
          shift > 0
            ? [
                { x: x0, y: yb },
                { x: x0 + netW, y: yb - shift },
                { x: x0 + netW, y: yb - shift + t },
                { x: x0, y: yb + t },
              ]
            : rectPts(x0, yb, netW, t);
        elevation.push({ k: 'poly', pts, closed: true, layer: L_STRUCT, lw: 1 });
      });
    }
    if (u.drawers) {
      const netH = innerH - apZ0;
      const cellH = drawerCellHeights(u, netH, rules);
      let y = innerBottomY + apZ0 + u.drawers.gap;
      for (let k = 0; k < cellH.length; k++) {
        elevation.push({ k: 'poly', pts: rectPts(x0 + u.drawers.gap, y, netW - 2 * u.drawers.gap, cellH[k] - 2 * u.drawers.gap), closed: true, layer: L_FRONT, lw: 1.4 });
        y += cellH[k] + u.drawers.gap;
      }
    }
    if (u.doors) {
      const widths = doorWidths(u, netW, rules);
      let x = x0 + u.doors.gapOuter;
      for (const w of widths) {
        elevation.push({ k: 'poly', pts: rectPts(x, innerBottomY + u.doors.gapOuter, w, innerH - 2 * u.doors.gapOuter), closed: true, layer: L_FRONT, lw: 1.4 });
        x += w + u.doors.gapMid;
      }
    }
    if (u.rod) {
      elevation.push({ k: 'poly', pts: [{ x: x0 + 2, y: innerBottomY + u.rod.heightFromBottom }, { x: x0 + netW - 2, y: innerBottomY + u.rod.heightFromBottom }], closed: false, layer: L_HW, lw: 1.4, dash: [40, 20, 6, 20] });
    }
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
