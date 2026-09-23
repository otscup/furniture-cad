import type {
  EdgeSpec,
  HardwareItem,
  Issue,
  Panel,
  PanelModel,
  RuleSet,
  SemanticModel,
  UnitSpec,
} from './types.ts';
import { allocateWidths, equalSpacing, round1, splitEqual } from './allocate.ts';

const E1 = 'E_1MM';
const E04 = 'E_04MM';

function edge(top: string | null, bottom: string | null, left: string | null, right: string | null): EdgeSpec {
  return { top, bottom, left, right };
}

/**
 * 约定（板件图绘制方向）：矩形以 length 竖向、width 横向绘制。
 *   left / right 边 —— 长度 = length
 *   top  / bottom 边 —— 长度 = width
 * 例如侧板 length=2320(高)、width=600(深)，则 left/right 是前边与后边，top/bottom 是上端与下端。
 */
export function generatePanelModel(model: SemanticModel, rules: RuleSet): PanelModel {
  const issues: Issue[] = [];
  const panels: Panel[] = [];
  const hardware: HardwareItem[] = [];

  const p = model.params;
  const matBoard = rules.materials[p.boardMaterial];
  const matBack = rules.materials[p.backPanel.material];
  if (!matBoard || !matBack) {
    throw new Error(`材质库缺少定义: ${p.boardMaterial} / ${p.backPanel.material}`);
  }
  const t = matBoard.thickness;
  const tb = matBack.thickness;
  const cab = model.id;

  const bodyH = p.height - p.bodyLift;
  const innerW = p.width - 2 * t;
  const innerH = bodyH - 2 * t;

  const layerOf = (thickness: number): string => `PANEL_${thickness}`;

  const push = (pn: Omit<Panel, 'qty'> & { qty?: number }): void => {
    panels.push({ qty: 1, ...pn });
  };

  // ───────────────────────────── 1. 箱体结构板 ─────────────────────────────
  push({
    id: `P_${cab}_LS`,
    role: 'LeftSidePanel',
    nameZh: '左侧板',
    belongsTo: cab,
    group: '箱体',
    material: p.boardMaterial,
    thickness: t,
    length: bodyH,
    width: p.depth,
    grain: 'length',
    edge: edge(null, E04, E1, null),
    edgeLabel: '前边 1mm；上端 1mm；下端 0.4mm',
    layer: layerOf(t),
  });
  push({
    id: `P_${cab}_RS`,
    role: 'RightSidePanel',
    nameZh: '右侧板',
    belongsTo: cab,
    group: '箱体',
    material: p.boardMaterial,
    thickness: t,
    length: bodyH,
    width: p.depth,
    grain: 'length',
    edge: edge(null, E04, null, E1),
    edgeLabel: '前边 1mm；上端 1mm；下端 0.4mm（镜像）',
    layer: layerOf(t),
  });
  push({
    id: `P_${cab}_TOP`,
    role: 'TopPanel',
    nameZh: '顶板',
    belongsTo: cab,
    group: '箱体',
    material: p.boardMaterial,
    thickness: t,
    length: innerW,
    width: p.depth,
    grain: 'length',
    edge: edge(null, null, E1, null),
    edgeLabel: '前边 1mm',
    layer: layerOf(t),
  });
  push({
    id: `P_${cab}_BOT`,
    role: 'BottomPanel',
    nameZh: '底板',
    belongsTo: cab,
    group: '箱体',
    material: p.boardMaterial,
    thickness: t,
    length: innerW,
    width: p.depth,
    grain: 'length',
    edge: edge(null, null, E1, null),
    edgeLabel: '前边 1mm',
    layer: layerOf(t),
  });
  push({
    id: `P_${cab}_KICK`,
    role: 'KickBoard',
    nameZh: '踢脚板',
    belongsTo: cab,
    group: '箱体',
    material: p.boardMaterial,
    thickness: t,
    length: innerW,
    width: p.bodyLift,
    grain: 'length',
    edge: edge(null, null, E1, null),
    edgeLabel: '上棱 1mm',
    layer: layerOf(t),
  });

  // 立板：分区数 - 1
  const unitCount = model.layout.units.length;
  for (let i = 0; i < unitCount - 1; i++) {
    push({
      id: `P_${cab}_DIV${i + 1}`,
      role: 'DividerPanel',
      nameZh: `中立板${i + 1}`,
      belongsTo: cab,
      group: '箱体',
      material: p.boardMaterial,
      thickness: t,
      length: innerH,
      width: p.depth,
      grain: 'length',
      edge: edge(null, null, E1, null),
      edgeLabel: '前边 1mm',
      layer: layerOf(t),
    });
  }

  // ───────────────────────────── 2. 宽度分配 ─────────────────────────────
  const netTotal = innerW - (unitCount - 1) * t;
  const requested = model.layout.units.map((u) => u.requestedWidth);
  const nets = allocateWidths(netTotal, requested);

  const unitX0: number[] = [];
  {
    let x = t;
    for (let i = 0; i < unitCount; i++) {
      unitX0.push(x);
      x += nets[i];
      if (i < unitCount - 1) x += t;
    }
  }

  const drifted: string[] = [];
  model.layout.units.forEach((u, i) => {
    if (nets[i] !== u.requestedWidth) {
      drifted.push(`${u.id} 期望净宽 ${u.requestedWidth} → 实际 ${nets[i]}（${nets[i] - u.requestedWidth >= 0 ? '+' : ''}${nets[i] - u.requestedWidth}mm）`);
    }
  });
  if (drifted.length > 0) {
    issues.push({
      severity: 'INFO',
      code: 'ALLOC-FIT-TOTAL',
      target: cab,
      message:
        `总宽 ${p.width}mm 固定，扣除两侧板 ${t}×2 与立板 ${t}×${unitCount - 1} 后可用净宽 ${netTotal}mm，` +
        `按期望比例重新分配：${drifted.join('；')}。这是「总宽优先」策略的必然结果，不是错误。`,
      fixHint: '如需严格满足净宽，请改用 layout.widthMode = "fit_units"（总宽将随之变化）',
    });
  }

  // ───────────────────────────── 3. 背板（含超幅面拆块）─────────────────────────────
  const bp = p.backPanel;
  const backW = innerW + 2 * bp.grooveDepth - 2 * bp.clearance;
  const backH = innerH + 2 * bp.grooveDepth - 2 * bp.clearance;
  const [sheetL, sheetS] = rules.limits.maxSheetSize;

  // 背板长边放在板材长边方向，剩余方向受窄边限制
  const maxSpan = sheetL >= backW ? sheetS : sheetL;
  const pieces = Math.max(1, Math.ceil(backH / maxSpan));
  if (pieces > 1) {
    issues.push({
      severity: 'WARNING',
      code: 'RULE-BACKPANEL-SPLIT',
      target: cab,
      message: `背板 ${Math.round(backW)}×${Math.round(backH)}mm 超出板材最大幅面 ${sheetL}×${sheetS}，已按高度方向拆为 ${pieces} 块。`,
      fixHint: '确认拼接方向与压条方案；或改用 5mm 背板条 + 中密度板',
    });
  }
  const segLen = splitEqual(backH, pieces, 0, 'bottom');
  segLen.forEach((h, i) => {
    push({
      id: `P_${cab}_BACK${i + 1}`,
      role: 'BackPanel',
      nameZh: pieces > 1 ? `背板-${i + 1}` : '背板',
      belongsTo: cab,
      group: '箱体',
      material: p.backPanel.material,
      thickness: tb,
      length: h,
      width: backW,
      grain: 'none',
      edge: edge(null, null, null, null),
      edgeLabel: '不封边',
      layer: layerOf(tb),
    });
  });

  // ───────────────────────────── 4. 各分区 ─────────────────────────────
  const shelfDepth = p.depth - (bp.grooveSetback + bp.grooveDepth) - p.shelfFrontClearance;

  model.layout.units.forEach((u: UnitSpec, i: number) => {
    const netW = nets[i];
    const netH = innerH;

    if (u.drawers) {
      buildDrawerBank(u, netW, netH);
    }
    if (u.shelves && u.shelves.count > 0) {
      buildShelves(u, netW, netH, shelfDepth);
    }
    if (u.rod && u.rod.count > 0) {
      const rodLen = netW - 2;
      hardware.push({
        id: `HW_${cab}_${u.id}_ROD`,
        nameZh: '挂衣杆',
        kind: 'rod',
        qty: u.rod.count,
        spec: `${rules.hardware[u.rod.hardware]?.name ?? u.rod.hardware} L=${rodLen}mm，距柜内底 ${u.rod.heightFromBottom}mm`,
        belongsTo: `${cab}.${u.id}`,
      });
    }
    if (u.doors) {
      buildDoors(u, netW, netH);
    }
  });

  function buildDrawerBank(u: UnitSpec, netW: number, netH: number): void {
    const d = u.drawers!;
    const gapTotal = (d.count + 1) * d.gap;
    const cellH = splitEqual(netH, d.count, gapTotal, rules.policy.remainderPolicy);

    for (let k = 0; k < d.count; k++) {
      const frontH = cellH[k] - 2 * d.gap;
      const frontW = netW - 2 * d.gap;

      push({
        id: `P_${cab}_${u.id}_DF${k + 1}`,
        role: 'DrawerFront',
        nameZh: `抽屉面板-${k + 1}`,
        belongsTo: `${cab}.${u.id}`,
        group: u.id,
        material: p.boardMaterial,
        thickness: t,
        length: frontH,
        width: frontW,
        grain: 'length',
        edge: edge(E1, E1, E1, E1),
        edgeLabel: '四周 1mm（可见面）',
        layer: layerOf(t),
      });

      const boxH = frontH - d.boxHeightDeduct;
      const boxW = netW - 25; // 三节轨单边 12.5mm 让位
      const sideLen = d.runnerLength;
      const backLen = boxW - 2 * d.sideThickness;
      const botW = backLen + 2 * d.bottomGrooveDepth - 1;
      const botL = sideLen + 2 * d.bottomGrooveDepth - 1;

      push({
        id: `P_${cab}_${u.id}_DS${k + 1}`,
        role: 'DrawerSide',
        nameZh: `抽屉侧板-${k + 1}`,
        belongsTo: `${cab}.${u.id}`,
        group: u.id,
        material: 'M_BOARD_15_WOOD',
        thickness: d.sideThickness,
        length: sideLen,
        width: boxH,
        grain: 'length',
        edge: edge(E1, null, null, null),
        edgeLabel: '上棱 1mm',
        layer: layerOf(d.sideThickness),
        qty: 2,
      });
      push({
        id: `P_${cab}_${u.id}_DB${k + 1}`,
        role: 'DrawerBack',
        nameZh: `抽屉后板-${k + 1}`,
        belongsTo: `${cab}.${u.id}`,
        group: u.id,
        material: 'M_BOARD_15_WOOD',
        thickness: d.sideThickness,
        length: backLen,
        width: boxH,
        grain: 'length',
        edge: edge(E1, null, null, null),
        edgeLabel: '上棱 1mm',
        layer: layerOf(d.sideThickness),
      });
      push({
        id: `P_${cab}_${u.id}_DBOT${k + 1}`,
        role: 'DrawerBottom',
        nameZh: `抽屉底板-${k + 1}`,
        belongsTo: `${cab}.${u.id}`,
        group: u.id,
        material: 'M_BOARD_5',
        thickness: d.bottomThickness,
        length: botL,
        width: botW,
        grain: 'none',
        edge: edge(null, null, null, null),
        edgeLabel: '嵌槽，不封边',
        layer: layerOf(d.bottomThickness),
      });
    }

    hardware.push({
      id: `HW_${cab}_${u.id}_RUNNER`,
      nameZh: '抽屉滑轨',
      kind: 'runner',
      qty: d.count,
      spec: `${rules.hardware[d.runner]?.name ?? d.runner}，L=${d.runnerLength}mm`,
      belongsTo: `${cab}.${u.id}`,
    });
  }

  function buildShelves(u: UnitSpec, netW: number, netH: number, sDepth: number): void {
    const s = u.shelves!;
    const shelfW = netW - 2 * s.gapPerSide;
    const positions = equalSpacing(netH, s.count);
    positions.forEach((pos, k) => {
      push({
        id: `P_${cab}_${u.id}_SH${k + 1}`,
        role: 'ShelfPanel',
        nameZh: `层板-${k + 1}`,
        belongsTo: `${cab}.${u.id}`,
        group: u.id,
        material: p.boardMaterial,
        thickness: t,
        length: shelfW,
        width: sDepth,
        grain: 'length',
        edge: edge(E1, null, E1, null),
        edgeLabel: `前边 1mm；位置：距柜内底 ${pos}mm`,
        layer: layerOf(t),
      });
    });
    hardware.push({
      id: `HW_${cab}_${u.id}_PIN`,
      nameZh: '层板托',
      kind: 'shelfPin',
      qty: s.count * 4,
      spec: '每块层板 4 只',
      belongsTo: `${cab}.${u.id}`,
    });
  }

  function buildDoors(u: UnitSpec, netW: number, netH: number): void {
    const dr = u.doors!;
    const doorH = netH - 2 * dr.gapOuter;
    const availW = netW - 2 * dr.gapOuter - (dr.count - 1) * dr.gapMid;
    const widths = splitEqual(availW, dr.count, 0, rules.policy.remainderPolicy);

    widths.forEach((w, k) => {
      push({
        id: `P_${cab}_${u.id}_DOOR${k + 1}`,
        role: 'DoorPanel',
        nameZh: `${dr.count} 扇门之第 ${k + 1} 扇`,
        belongsTo: `${cab}.${u.id}`,
        group: u.id,
        material: p.boardMaterial,
        thickness: t,
        length: doorH,
        width: w,
        grain: 'length',
        edge: edge(E1, E1, E1, E1),
        edgeLabel: '四周 1mm（可见面）',
        layer: layerOf(t),
      });
    });

    const hingePerDoor = Math.max(2, Math.ceil(doorH / rules.limits.hingeSpacingMax));
    hardware.push({
      id: `HW_${cab}_${u.id}_HINGE`,
      nameZh: '门铰链',
      kind: 'hinge',
      qty: hingePerDoor * dr.count,
      spec: `${rules.hardware[dr.hinge]?.name ?? dr.hinge}，每扇 ${hingePerDoor} 只（按门高 ${Math.round(doorH)}mm / 间距上限 ${rules.limits.hingeSpacingMax}mm 计算）`,
      belongsTo: `${cab}.${u.id}`,
    });
    hardware.push({
      id: `HW_${cab}_${u.id}_HANDLE`,
      nameZh: '拉手',
      kind: 'handle',
      qty: dr.count,
      spec: 'HW_HANDLE_128 128mm 孔距',
      belongsTo: `${cab}.${u.id}`,
    });
  }

  // ───────────────────────────── 5. 统计 ─────────────────────────────
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
    cabinetId: cab,
    cabinetName: model.name,
    outer: { width: p.width, height: p.height, depth: p.depth },
    inner: { width: innerW, height: innerH },
    bodyHeight: bodyH,
    units: model.layout.units.map((u, i) => ({
      id: u.id,
      kind: u.kind,
      netWidth: nets[i],
      netHeight: innerH,
      x0: unitX0[i],
      requestedWidth: u.requestedWidth,
    })),
    panels,
    hardware,
    issues,
    stats: {
      panelKinds: panels.length,
      totalPieces,
      boardAreaM2: round1(areaMm2 / 1e6),
      estWeightKg: round1(weightKg),
    },
  };
}
