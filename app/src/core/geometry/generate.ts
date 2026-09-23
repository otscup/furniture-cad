import type {
  Cabinet,
  CabinetGeometry,
  EdgeSpec,
  HardwareItem,
  Issue,
  Panel,
  Prim,
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

  const push = (pn: Omit<Panel, 'qty'> & { qty?: number }): void => {
    panels.push({ qty: 1, ...pn });
  };

  // ───────── 1. 箱体结构板 ─────────
  push({ id: `P_${cabId}_LS`, role: 'LeftSidePanel', nameZh: '左侧板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: bodyH, width: p.depth, grain: 'length', edge: edge(null, E04, E1, null), edgeLabel: '前边 1mm；上端 1mm；下端 0.4mm', layer: layerOf(t) });
  push({ id: `P_${cabId}_RS`, role: 'RightSidePanel', nameZh: '右侧板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: bodyH, width: p.depth, grain: 'length', edge: edge(null, E04, null, E1), edgeLabel: '前边 1mm；上端 1mm；下端 0.4mm（镜像）', layer: layerOf(t) });
  push({ id: `P_${cabId}_TOP`, role: 'TopPanel', nameZh: '顶板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: p.depth, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '前边 1mm', layer: layerOf(t) });
  push({ id: `P_${cabId}_BOT`, role: 'BottomPanel', nameZh: '底板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: p.depth, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '前边 1mm', layer: layerOf(t) });
  push({ id: `P_${cabId}_KICK`, role: 'KickBoard', nameZh: '踢脚板', belongsTo: cabId, group: '箱体', material: p.boardMaterial, thickness: t, length: innerW, width: p.bodyLift, grain: 'length', edge: edge(null, null, E1, null), edgeLabel: '上棱 1mm', layer: layerOf(t) });

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
    issues.push({
      severity: 'WARNING',
      code: 'RULE-BACKPANEL-SPLIT',
      target: cabId,
      targetKind: 'cabinet',
      message: `背板 ${Math.round(backW)}×${Math.round(backH)}mm 超出板材最大幅面 ${sheetL}×${sheetS}，已按 ${nW} 列 × ${nH} 行拆为 ${backPieces} 块。`,
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

  // ───────── 4. 各分区 ─────────
  const shelfDepth = L.shelfDepth;

  cab.layout.units.forEach((u, i) => {
    const netW = nets[i];
    const netH = innerH;
    if (u.drawers) buildDrawerBank(u.id, u, netW, netH);
    if (u.shelves && u.shelves.count > 0) buildShelves(u.id, u.shelves, netW, netH, shelfDepth);
    if (u.rod && u.rod.count > 0) {
      hardware.push({ id: `HW_${cabId}_${u.id}_ROD`, nameZh: '挂衣杆', kind: 'rod', qty: u.rod.count, spec: `${rules.hardware[u.rod.hardware]?.name ?? u.rod.hardware} L=${netW - 2}mm，距柜内底 ${u.rod.heightFromBottom}mm`, belongsTo: `${cabId}.${u.id}` });
    }
    if (u.doors) buildDoors(u.id, u, netW, netH);
  });

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
    equalSpacing(netH, s.count).forEach((pos, k) => {
      push({ id: `P_${cabId}_${uid}_SH${k + 1}`, role: 'ShelfPanel', nameZh: `层板-${k + 1}`, belongsTo: `${cabId}.${uid}`, group: uid, material: p.boardMaterial, thickness: t, length: shelfW, width: sDepth, grain: 'length', edge: edge(E1, null, E1, null), edgeLabel: `前边 1mm；位置：距柜内底 ${pos}mm`, layer: layerOf(t) });
    });
    hardware.push({ id: `HW_${cabId}_${uid}_PIN`, nameZh: '层板托', kind: 'shelfPin', qty: s.count * 4, spec: '每块层板 4 只', belongsTo: `${cabId}.${uid}` });
  }

  function buildDoors(uid: string, unit: Cabinet['layout']['units'][number], netW: number, netH: number): void {
    const dr = unit.doors!;
    const doorH = netH - 2 * dr.gapOuter;
    const widths = doorWidths(unit, netW, rules);
    widths.forEach((w, k) => {
      push({ id: `P_${cabId}_${uid}_DOOR${k + 1}`, role: 'DoorPanel', nameZh: `门板-${k + 1}`, belongsTo: `${cabId}.${uid}`, group: uid, material: p.boardMaterial, thickness: t, length: doorH, width: w, grain: 'length', edge: edge(E1, E1, E1, E1), edgeLabel: '四周 1mm（可见面）', layer: layerOf(t) });
    });
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

  // 结构板（侧板/立板）在平面上是横跨进深的线
  const structLines: Array<[number, number]> = [
    [0, t],
    [W - t, W],
  ];
  for (let i = 0; i < unitCount - 1; i++) {
    const dx = unitX0[i] + nets[i];
    structLines.push([dx, dx + t]);
  }
  for (const [a, b] of structLines) {
    const xc = (a + b) / 2;
    plan.push({ k: 'poly', pts: toWorld([{ x: xc, y: 0 }, { x: xc, y: D }]), closed: false, layer: L_STRUCT, lw: 1.6 });
  }

  // 门板 / 抽屉面板：贴前脸的一条线
  cab.layout.units.forEach((u, i) => {
    if (!u.doors && !u.drawers) return;
    const x0 = unitX0[i];
    const x1 = x0 + nets[i];
    const yFront = D - t;
    plan.push({ k: 'poly', pts: toWorld([{ x: x0, y: yFront }, { x: x1, y: yFront }]), closed: false, layer: L_FRONT, lw: 2.4 });
    if (u.doors && u.doors.count > 1) {
      for (let k = 1; k < u.doors.count; k++) {
        const xk = x0 + (nets[i] * k) / u.doors.count;
        plan.push({ k: 'poly', pts: toWorld([{ x: xk, y: yFront }, { x: xk, y: D }]), closed: false, layer: L_FRONT, lw: 1 });
      }
    }
    if (u.drawers && u.drawers.count > 1) {
      for (let k = 1; k < u.drawers.count; k++) {
        const yk = D - (D * k) / u.drawers.count;
        plan.push({ k: 'poly', pts: toWorld([{ x: x0, y: yk }, { x: x1, y: yk }]), closed: false, layer: L_FRONT, lw: 0.8 });
      }
    }
  });

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
    if (u.shelves && u.shelves.count > 0) {
      equalSpacing(innerH, u.shelves.count).forEach((pos) => {
        elevation.push({ k: 'poly', pts: rectPts(x0, innerBottomY + pos, netW, t), closed: true, layer: L_STRUCT, lw: 1 });
      });
    }
    if (u.drawers) {
      const cellH = drawerCellHeights(u, innerH, rules);
      let y = innerBottomY + u.drawers.gap;
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
    plan,
    elevation,
    issues,
    stats: { panelKinds: panels.length, totalPieces, boardAreaM2: round1(areaMm2 / 1e6), estWeightKg: round1(weightKg) },
    layout: L,
  };
}
