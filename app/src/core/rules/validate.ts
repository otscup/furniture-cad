import type { Cabinet, CabinetGeometry, Issue, RuleSet } from '../types.ts';
import { computeCabinetLayout, doorWidths, drawerCellHeights, backPanelSize } from '../geometry/layout.ts';
import { buildIssue, type IssueCtx } from './issueCatalog.ts';

/**
 * 校验分两类，绝不能混（主方案 §F1）：
 *   A. 恒等式断言 —— 证明几何生成器自己没算错（内建断言，来自 Phase 0 的教训）
 *   B. 生产硬规则 —— 可判定、可阻断的真实工艺限制
 * AI 软建议不在这里产生。
 *
 * 注 1：派生骨架从 geom.layout 取，不重算 —— 校验器必须校验"生成器的输出"，
 *      而不是"自己另算一遍的结果"，否则两边一起错就永远发现不了。
 * 注 2：**报错只能经 buildIssue() 产出**（issueCatalog 是唯一真相源）。
 *       严重度、人话描述、修复建议一律由目录给，这里只负责把"差多少 mm"算对 ——
 *       于是"每条报错都带人话和修法"是结构性成立的，不靠谁记得写。
 */
export function validateCabinet(cab: Cabinet, geom: CabinetGeometry, rules: RuleSet): Issue[] {
  const out: Issue[] = [];
  const p = cab.params;
  const L = geom.layout;
  const t = L.boardT;
  const [sheetL, sheetS] = rules.limits.maxSheetSize;

  const emit = (code: string, target: string, targetKind: Issue['targetKind'], ctx: IssueCtx = {}): void => {
    out.push(buildIssue(code, { target, targetKind, ctx: { cab, ...ctx } }));
  };

  // ───────── A. 恒等式断言 ─────────
  const assertEq = (label: string, a: number, b: number, detail: string): void => {
    if (Math.abs(a - b) > 1e-9) {
      emit('IDENTITY-FAIL', cab.id, 'cabinet', { label, detail, a, b });
    }
  };

  assertEq('箱体高 + 抬高 = 总高', L.bodyH + p.bodyLift, p.height, 'bodyH + bodyLift = height');
  assertEq('内空高 + 2×板厚 = 箱体高', L.innerH + 2 * t, L.bodyH, 'innerH + 2t = bodyH');
  assertEq('内空宽 + 2×板厚 = 总宽', L.innerW + 2 * t, p.width, 'innerW + 2t = width');

  const chainW = t + L.nets.reduce((a, b) => a + b, 0) + (L.nets.length - 1) * t + t;
  assertEq('宽度链', chainW, p.width, 't + Σ净宽 + (n-1)t + t = width');

  // 双面柜：后排有自己的宽度链；且 type 与 backUnits 必须互相配套（自相矛盾的模型不静默画）
  const DB = L.double;
  const hasBack = Array.isArray(cab.layout.backUnits) && cab.layout.backUnits.length > 0;
  if (cab.layout.type === 'double' && !DB) {
    emit('RULE-DOUBLE-NO-BACK', cab.id, 'cabinet');
  }
  if (cab.layout.type !== 'double' && hasBack) {
    emit('RULE-ROW-WITH-BACK', cab.id, 'cabinet');
  }
  if (DB) {
    const chainB = t + DB.backNets.reduce((a, b) => a + b, 0) + (DB.backNets.length - 1) * t + t;
    assertEq('宽度链（背面排）', chainB, p.width, 't + Σ后排净宽 + (m-1)t + t = width');
    assertEq(
      '排深 + 中板 + 前排深 = 总深',
      DB.backRowDepth + DB.midT + DB.frontRowDepth,
      p.depth,
      'backRowDepth + midT + frontRowDepth = depth'
    );
    assertEq('中板厚 = 板厚', DB.midT, t, '中板就是柜体板');
  }

  // 背板：用「面积守恒」而不是「第一块宽度等于公式值」做断言。
  // 理由：背板会按幅面拆成 n 列 × m 行，此时单块的尺寸不再等于整板公式值，
  //       但【拆块后的面积总和】必须与整板面积严格相等 —— 这是拆块逻辑的正确性核心，
  //       而且是普适的（无论怎么拆、拆几块）。
  const backPieces = geom.panels.filter((x) => x.role === 'BackPanel');
  const expectBack = backPanelSize(cab, L);
  if (DB) {
    // 双面柜没有背板 —— 但共用中板必须真的在清单里，否则就是派生漏了
    const mid = geom.panels.filter((x) => x.role === 'MiddlePanel');
    if (mid.length === 0) {
      emit('MISSING-MIDDLE-PANEL', cab.id, 'cabinet');
    }
  } else if (backPieces.length === 0) {
    emit('MISSING-BACKPANEL', cab.id, 'cabinet');
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
        emit('IDENTITY-BACKSPLIT-BAD', bp.id, 'panel', {
          len: bp.length,
          wid: bp.width,
          sheetL,
          sheetS,
        });
      }
    }
  }

  /** 两排分区一起校验（双面柜的背面排与前排同一套恒等式，只差净宽表） */
  const rows: Array<{ units: typeof cab.layout.units; netsRow: number[]; label: string }> = [
    { units: cab.layout.units, netsRow: L.nets, label: '' },
    ...(DB ? [{ units: cab.layout.backUnits!, netsRow: DB.backNets, label: '（背面排）' }] : []),
  ];

  for (const { units, netsRow, label } of rows) {
    units.forEach((u, ui) => {
      const netW = netsRow[ui];
      // 电器格：洞口上面的抽屉只拥有"内空高 − 洞口高 − 过梁板"这段净高
      const netH = u.kind === 'appliance' && u.appliance ? L.innerH - u.appliance.openingHeight - t : L.innerH;
      const unitName = `${u.nickname ?? u.id}${label}`;
      const ctxBase = { unitIndex: ui, unitName, unitId: u.id };

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
          emit('RULE-RUNNER-TOO-LONG', `${cab.id}.${u.id}`, 'unit', { ...ctxBase, runnerLength: u.drawers.runnerLength, depth: p.depth });
        }
        if (boxW <= 0) {
          emit('RULE-DRAWER-NO-ROOM', `${cab.id}.${u.id}`, 'unit', { ...ctxBase, netW, needW: Math.ceil(25 + 12.5 * 2 + t) });
        }
      }

      if (u.shelves && u.shelves.count > 0) {
        const sd = label === '（背面排）' && DB ? DB.backShelfDepth : L.shelfDepth;
        if (sd <= 0) {
          emit('RULE-SHELF-DEPTH', `${cab.id}.${u.id}`, 'unit', { ...ctxBase, sd });
        }
      }
      // 电器格：洞口必须真的装得下（洞口 ≤ 分区净宽；洞口高 + 过梁板 ≤ 内空高；洞口深 ≤ 排深）
      if (u.kind === 'appliance' && u.appliance) {
        const a = u.appliance;
        if (a.openingWidth > netW) {
          emit('RULE-APPLIANCE-FIT-W', `${cab.id}.${u.id}`, 'unit', {
            ...ctxBase,
            applianceName: a.name,
            openingWidth: a.openingWidth,
            netW,
            needW: a.openingWidth + 2 * t,
          });
        }
        if (a.openingHeight + t > L.innerH) {
          emit('RULE-APPLIANCE-FIT-H', `${cab.id}.${u.id}`, 'unit', {
            ...ctxBase,
            applianceName: a.name,
            openingHeight: a.openingHeight,
            boardT: t,
            innerH: L.innerH,
            needH: a.openingHeight + 2 * t + p.bodyLift,
            maxOpening: Math.max(0, Math.floor(L.innerH - t)),
          });
        }
        const rowDepth = DB && label === '（背面排）' ? DB.backRowDepth : DB ? DB.frontRowDepth : p.depth;
        if (a.openingDepth > rowDepth) {
          emit('RULE-APPLIANCE-FIT-D', `${cab.id}.${u.id}`, 'unit', {
            ...ctxBase,
            applianceName: a.name,
            openingDepth: a.openingDepth,
            rowDepth,
            needD: a.openingDepth + t,
          });
        }
      }
    });
  }

  const seen = new Set<string>();
  for (const x of geom.panels) {
    if (seen.has(x.id)) emit('DUP-PANEL-ID', x.id, 'panel', { panelId: x.id });
    seen.add(x.id);
    if (x.belongsTo !== cab.id && !x.belongsTo.startsWith(`${cab.id}.`)) {
      emit('PANEL-ORPHAN', x.id, 'panel', { panelId: x.id, belongsTo: x.belongsTo });
    }
  }

  // ───────── B. 生产硬规则 ─────────
  for (const x of geom.panels) {
    const pctx = { nameZh: x.nameZh, len: x.length, wid: x.width };
    if (x.length < rules.limits.minPanelSize || x.width < rules.limits.minPanelSize) {
      emit('RULE-MIN-PANEL', x.id, 'panel', { ...pctx, min: rules.limits.minPanelSize });
    }
    const fitsGrain = x.length <= sheetL && x.width <= sheetS;
    const fitsRotated = x.length <= sheetS && x.width <= sheetL;
    const ok = x.grain === 'length' ? fitsGrain : fitsGrain || fitsRotated;
    if (!ok) {
      emit('RULE-PANEL-OVER-SHEET', x.id, 'panel', {
        ...pctx,
        sheetL,
        sheetS,
        grainLocked: x.grain === 'length',
      });
    }
    const dens = rules.materials[x.material]?.density ?? 0.72;
    const kg = (x.length / 1000) * (x.width / 1000) * (x.thickness / 1000) * dens * 1000;
    if (kg > rules.limits.maxPanelWeightKg) {
      emit('RULE-PANEL-WEIGHT', x.id, 'panel', {
        ...pctx,
        kg,
        limit: rules.limits.maxPanelWeightKg,
        qty: x.qty,
      });
    }
    for (const e of [x.edge.top, x.edge.bottom, x.edge.left, x.edge.right]) {
      if (e && !rules.edgebanding[e]) {
        emit('RULE-EDGE-UNKNOWN', x.id, 'panel', {
          ...pctx,
          edge: e,
          // 报错要说清"现在能选哪些"，否则用户面对一个不存在的名字无从下手
          candidates: Object.keys(rules.edgebanding),
        });
      }
    }
  }

  if (p.height > rules.limits.maxSingleCabinetHeight) {
    emit('RULE-CABINET-SPLIT-HEIGHT', cab.id, 'cabinet', { cabName: cab.name, height: p.height, limit: rules.limits.maxSingleCabinetHeight });
  }
  if (p.width > rules.limits.maxSingleCabinetWidth) {
    emit('RULE-CABINET-SPLIT-WIDTH', cab.id, 'cabinet', { cabName: cab.name, width: p.width, limit: rules.limits.maxSingleCabinetWidth });
  }

  for (const { units, netsRow } of rows) {
    units.forEach((u, ui) => {
      const netW = netsRow[ui];
      const netH = u.kind === 'appliance' && u.appliance ? L.innerH - u.appliance.openingHeight - t : L.innerH;
      const unitName = u.nickname ?? u.id;
      const ctxBase = { unitIndex: ui, unitName, unitId: u.id };

      if (u.shelves && u.shelves.count > 0 && netW > rules.limits.maxShelfSpan) {
        emit('RULE-SHELF-SPAN', `${cab.id}.${u.id}`, 'unit', { ...ctxBase, netW, max: rules.limits.maxShelfSpan });
      }
      if (u.doors) {
        const doorH = netH - 2 * u.doors.gapOuter;
        const widths = doorWidths(u, netW, rules);
        const maxW = Math.max(...widths);
        if (maxW > rules.limits.maxDoorWidth) {
          emit('RULE-DOOR-MAX-WIDTH', `${cab.id}.${u.id}`, 'unit', {
            ...ctxBase,
            maxW,
            limit: rules.limits.maxDoorWidth,
            count: u.doors.count,
            gapOuter: u.doors.gapOuter,
            gapMid: u.doors.gapMid,
            netW,
          });
        }
        if (doorH > rules.limits.maxDoorHeight) {
          emit('RULE-DOOR-MAX-HEIGHT', `${cab.id}.${u.id}`, 'unit', {
            ...ctxBase,
            doorH,
            limit: rules.limits.maxDoorHeight,
            count: u.doors.count,
            // 门高只受柜高与踢脚影响（门扇数与它无关），目录要给得出该降到多少
            height: p.height,
            bodyLift: p.bodyLift,
          });
        } else if (doorH > 1600) {
          emit('RULE-DOOR-TALL', `${cab.id}.${u.id}`, 'unit', {
            ...ctxBase,
            doorH,
            hinges: Math.ceil(doorH / rules.limits.hingeSpacingMax),
          });
        }
      }
      if (u.drawers) {
        const fronts = geom.panels.filter((x) => x.group === u.id && x.role === 'DrawerFront');
        const maxFront = fronts.length ? Math.max(...fronts.map((x) => x.length)) : 0;
        if (maxFront > 400) {
          emit('RULE-DRAWER-TALL-FRONT', `${cab.id}.${u.id}`, 'unit', {
            ...ctxBase,
            maxFront,
            count: u.drawers.count,
            netH,
          });
        }
      }
    });
  }

  // ───────── C. 单柜自检：layout 重算必须与传入的 layout 一致（防止缓存过期）─────────
  const recomputed = computeCabinetLayout(cab, rules);
  if (JSON.stringify(recomputed.nets) !== JSON.stringify(L.nets)) {
    emit('LAYOUT-CACHE-STALE', cab.id, 'cabinet', { what: '净宽分配对不上' });
  }
  if (JSON.stringify(recomputed.double?.backNets ?? null) !== JSON.stringify(L.double?.backNets ?? null)) {
    emit('LAYOUT-CACHE-STALE', cab.id, 'cabinet', { what: '背面排净宽对不上' });
  }

  return out;
}
