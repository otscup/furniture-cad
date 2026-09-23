import type { Cabinet, CabinetGeometry, Issue, RuleSet } from '../types.ts';
import { computeCabinetLayout, doorWidths, drawerCellHeights, backPanelSize } from '../geometry/layout.ts';

/**
 * 校验分两类，绝不能混（主方案 §F1）：
 *   A. 恒等式断言 —— 证明几何生成器自己没算错（内建断言，来自 Phase 0 的教训）
 *   B. 生产硬规则 —— 可判定、可阻断的真实工艺限制
 * AI 软建议不在这里产生。
 *
 * 注：派生骨架从 geom.layout 取，不重算 —— 校验器必须校验"生成器的输出"，
 *     而不是"自己另算一遍的结果"，否则两边一起错就永远发现不了。
 */
export function validateCabinet(cab: Cabinet, geom: CabinetGeometry, rules: RuleSet): Issue[] {
  const out: Issue[] = [];
  const p = cab.params;
  const L = geom.layout;
  const t = L.boardT;
  const [sheetL, sheetS] = rules.limits.maxSheetSize;

  const err = (code: string, target: string, targetKind: Issue['targetKind'], message: string, fixHint?: string): void => {
    out.push({ severity: 'ERROR', code, target, targetKind, message, fixHint });
  };
  const warn = (code: string, target: string, targetKind: Issue['targetKind'], message: string, fixHint?: string): void => {
    out.push({ severity: 'WARNING', code, target, targetKind, message, fixHint });
  };
  const info = (code: string, target: string, targetKind: Issue['targetKind'], message: string, fixHint?: string): void => {
    out.push({ severity: 'INFO', code, target, targetKind, message, fixHint });
  };

  // ───────── A. 恒等式断言 ─────────
  const assertEq = (label: string, a: number, b: number, detail: string): void => {
    if (Math.abs(a - b) > 1e-9) {
      err('IDENTITY-FAIL', cab.id, 'cabinet', `恒等式失败 [${label}]：${detail}（左=${a}，右=${b}）`);
    }
  };

  assertEq('箱体高 + 抬高 = 总高', L.bodyH + p.bodyLift, p.height, 'bodyH + bodyLift = height');
  assertEq('内空高 + 2×板厚 = 箱体高', L.innerH + 2 * t, L.bodyH, 'innerH + 2t = bodyH');
  assertEq('内空宽 + 2×板厚 = 总宽', L.innerW + 2 * t, p.width, 'innerW + 2t = width');

  const chainW = t + L.nets.reduce((a, b) => a + b, 0) + (L.nets.length - 1) * t + t;
  assertEq('宽度链', chainW, p.width, 't + Σ净宽 + (n-1)t + t = width');

  // 背板：用「面积守恒」而不是「第一块宽度等于公式值」做断言。
  // 理由：背板会按幅面拆成 n 列 × m 行，此时单块的尺寸不再等于整板公式值，
  //       但【拆块后的面积总和】必须与整板面积严格相等 —— 这是拆块逻辑的正确性核心，
  //       而且是普适的（无论怎么拆、拆几块）。
  const backPieces = geom.panels.filter((x) => x.role === 'BackPanel');
  const expectBack = backPanelSize(cab, L);
  if (backPieces.length === 0) {
    err('MISSING-BACKPANEL', cab.id, 'cabinet', '缺少背板板件。');
  } else {
    const totalArea = backPieces.reduce((a, x) => a + x.length * x.width, 0);
    assertEq(
      '背板拆块面积守恒',
      totalArea,
      expectBack.w * expectBack.h,
      `Σ(拆块长×宽) = 整板宽×整板高 = (innerW + 2×槽深 - 2×余量) × (innerH + 2×槽深 - 2×余量)`
    );
    for (const bp of backPieces) {
      const fitsA = bp.length <= sheetL && bp.width <= sheetS;
      const fitsB = bp.length <= sheetS && bp.width <= sheetL;
      if (!fitsA && !fitsB) {
        err(
          'IDENTITY-BACKSPLIT-BAD',
          bp.id,
          'panel',
          `背板拆块 ${bp.length}×${bp.width}mm 两种摆放都放不进板材 ${sheetL}×${sheetS}mm —— 这是拆块算法的缺陷，不是设计问题。`
        );
      }
    }
  }

  cab.layout.units.forEach((u, i) => {
    const netW = L.nets[i];
    const netH = L.innerH;

    if (u.doors) {
      const doors = geom.panels.filter((x) => x.group === u.id && x.role === 'DoorPanel');
      const expect = doorWidths(u, netW, rules);
      assertEq(
        `门宽之和 + 缝 = 净宽（${u.id}）`,
        doors.reduce((a, x) => a + x.width, 0) + 2 * u.doors.gapOuter + (u.doors.count - 1) * u.doors.gapMid,
        netW,
        'Σ门宽 + 2×外缝 + (n-1)×中缝 = 净宽'
      );
      assertEq(`门宽分配与 layout 一致（${u.id}）`, doors.reduce((a, x) => a + x.width, 0), expect.reduce((a, b) => a + b, 0), '门宽来自共享的 doorWidths()');
      if (doors[0]) assertEq(`门高 + 2×外缝 = 净高（${u.id}）`, doors[0].length + 2 * u.doors.gapOuter, netH, '门高 + 2×外缝 = 净高');
    }

    if (u.drawers) {
      const fronts = geom.panels.filter((x) => x.group === u.id && x.role === 'DrawerFront');
      const cells = drawerCellHeights(u, netH, rules);
      assertEq(
        `分格高之和 + 缝 = 净高（${u.id}）`,
        cells.reduce((a, b) => a + b, 0) + (u.drawers.count + 1) * u.drawers.gap,
        netH,
        'Σ分格高 + (n+1)×gap = 净高'
      );
      assertEq(
        `抽屉面板高之和 + 缝 = 净高（${u.id}）`,
        fronts.reduce((a, x) => a + x.length, 0) + (u.drawers.count + 1) * u.drawers.gap + 2 * u.drawers.count * u.drawers.gap,
        netH,
        'Σ面板高 + (n+1)×gap + 2n×gap = 净高'
      );
      for (const f of fronts) {
        assertEq(`抽屉面板宽 + 2×缝 = 净宽（${f.id}）`, f.width + 2 * u.drawers.gap, netW, '面板宽 + 2×缝 = 净宽');
      }
      // 抽屉盒必须能装进分区（深度方向：滑轨长 ≤ 柜深；宽度方向：盒宽 ≤ 净宽）
      const boxW = netW - 25;
      if (u.drawers.runnerLength > p.depth) {
        err('RULE-RUNNER-TOO-LONG', `${cab.id}.${u.id}`, 'unit', `滑轨长 ${u.drawers.runnerLength}mm 超过柜体深度 ${p.depth}mm，抽屉装不进去。`, '缩短滑轨或加深柜体');
      }
      if (boxW <= 0) {
        err('RULE-DRAWER-NO-ROOM', `${cab.id}.${u.id}`, 'unit', `净宽 ${netW}mm 不足以放下抽屉盒（需 ≥ 滑轨单边让位 12.5×2 + 板厚）。`, '加宽分区或改用更窄的滑轨');
      }
    }

    if (u.shelves && u.shelves.count > 0) {
      if (L.shelfDepth <= 0) {
        err('RULE-SHELF-DEPTH', `${cab.id}.${u.id}`, 'unit', `按背板槽位置与前沿让位计算，层板深度为 ${L.shelfDepth}mm，无法生成。`, '检查背板槽位置或增大柜深');
      }
    }
  });

  const seen = new Set<string>();
  for (const x of geom.panels) {
    if (seen.has(x.id)) err('DUP-PANEL-ID', x.id, 'panel', `板件 ID 重复：${x.id}`);
    seen.add(x.id);
    if (x.belongsTo !== cab.id && !x.belongsTo.startsWith(`${cab.id}.`)) {
      err('PANEL-ORPHAN', x.id, 'panel', `板件 ${x.id} 的归属 ${x.belongsTo} 不属于柜体 ${cab.id}，出现悬空板件。`);
    }
  }

  // ───────── B. 生产硬规则 ─────────
  for (const x of geom.panels) {
    if (x.length < rules.limits.minPanelSize || x.width < rules.limits.minPanelSize) {
      warn('RULE-MIN-PANEL', x.id, 'panel', `${x.nameZh} ${x.length}×${x.width}mm 小于最小可用尺寸 ${rules.limits.minPanelSize}mm，属边角料。`, '调整分格或合并板件');
    }
    const fitsGrain = x.length <= sheetL && x.width <= sheetS;
    const fitsRotated = x.length <= sheetS && x.width <= sheetL;
    const ok = x.grain === 'length' ? fitsGrain : fitsGrain || fitsRotated;
    if (!ok) {
      err('RULE-PANEL-OVER-SHEET', x.id, 'panel', `${x.nameZh} ${x.length}×${x.width}mm 超出板材最大幅面 ${sheetL}×${sheetS}${x.grain === 'length' ? '（有木纹方向，不可旋转）' : ''}。`, '拆块或改用拼板方案');
    }
    const dens = rules.materials[x.material]?.density ?? 0.72;
    const kg = (x.length / 1000) * (x.width / 1000) * (x.thickness / 1000) * dens * 1000;
    if (kg > rules.limits.maxPanelWeightKg) {
      warn('RULE-PANEL-WEIGHT', x.id, 'panel', `${x.nameZh} 单件约 ${kg.toFixed(1)}kg，超过人工搬运建议上限 ${rules.limits.maxPanelWeightKg}kg（共 ${x.qty} 件）。`, '拆块或双人搬运');
    }
    for (const e of [x.edge.top, x.edge.bottom, x.edge.left, x.edge.right]) {
      if (e && !rules.edgebanding[e]) err('RULE-EDGE-UNKNOWN', x.id, 'panel', `${x.nameZh} 引用了不存在的封边材料 ${e}。`, '检查规则集的 edgebanding 定义');
    }
  }

  if (p.height > rules.limits.maxSingleCabinetHeight) {
    warn('RULE-CABINET-SPLIT-HEIGHT', cab.id, 'cabinet', `柜体高 ${p.height}mm 超过单柜建议上限 ${rules.limits.maxSingleCabinetHeight}mm。`, '考虑上下分柜（拆柜）');
  }
  if (p.width > rules.limits.maxSingleCabinetWidth) {
    warn('RULE-CABINET-SPLIT-WIDTH', cab.id, 'cabinet', `柜体宽 ${p.width}mm 超过单柜建议上限 ${rules.limits.maxSingleCabinetWidth}mm。`, '考虑左右分柜');
  }

  cab.layout.units.forEach((u, i) => {
    const netW = L.nets[i];
    const netH = L.innerH;
    if (u.shelves && u.shelves.count > 0 && netW > rules.limits.maxShelfSpan) {
      warn('RULE-SHELF-SPAN', `${cab.id}.${u.id}`, 'unit', `${u.nickname ?? u.id} 层板跨度 ${netW}mm 超过建议上限 ${rules.limits.maxShelfSpan}mm。`, '增加中立板，或加厚层板至 25mm');
    }
    if (u.doors) {
      const doorH = netH - 2 * u.doors.gapOuter;
      const widths = doorWidths(u, netW, rules);
      const maxW = Math.max(...widths);
      if (maxW > rules.limits.maxDoorWidth) {
        err('RULE-DOOR-MAX-WIDTH', `${cab.id}.${u.id}`, 'unit', `门板宽度 ${maxW}mm 超过规则允许上限 ${rules.limits.maxDoorWidth}mm。`, '增加门扇数量');
      }
      if (doorH > rules.limits.maxDoorHeight) {
        err('RULE-DOOR-MAX-HEIGHT', `${cab.id}.${u.id}`, 'unit', `门板高度 ${doorH}mm 超过规则允许上限 ${rules.limits.maxDoorHeight}mm。`, '拆为上下两扇');
      } else if (doorH > 1600) {
        info('RULE-DOOR-TALL', `${cab.id}.${u.id}`, 'unit', `门板高 ${doorH}mm，需 ${Math.ceil(doorH / rules.limits.hingeSpacingMax)} 只铰链；建议复核铰链品牌与承重。`);
      }
    }
    if (u.drawers) {
      const fronts = geom.panels.filter((x) => x.group === u.id && x.role === 'DrawerFront');
      const maxFront = fronts.length ? Math.max(...fronts.map((x) => x.length)) : 0;
      if (maxFront > 400) {
        warn('RULE-DRAWER-TALL-FRONT', `${cab.id}.${u.id}`, 'unit', `抽屉面板最高 ${maxFront}mm，超出单抽常用高度（≤400mm）。`, '增加抽屉数量，或改为「抽屉 + 上翻门」组合');
      }
    }
  });

  // ───────── C. 单柜自检：layout 重算必须与传入的 layout 一致（防止缓存过期）─────────
  const recomputed = computeCabinetLayout(cab, rules);
  if (JSON.stringify(recomputed.nets) !== JSON.stringify(L.nets)) {
    err('LAYOUT-CACHE-STALE', cab.id, 'cabinet', '几何缓存与当前模型不一致（净宽分配对不上），说明缓存失效逻辑有 bug。', '不要手动改，这是程序缺陷');
  }

  return out;
}
