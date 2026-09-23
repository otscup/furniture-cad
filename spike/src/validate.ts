import type { Issue, Panel, PanelModel, RuleSet, SemanticModel } from './types.ts';

/**
 * 校验分两类，绝不能混（见主方案 F1）：
 *   A. 恒等式断言 —— 证明几何生成器自己没算错（对应主方案 F2 的 L4「一致性规则」）
 *   B. 生产硬规则 —— 可判定、可阻断的真实工艺限制
 * AI 的软建议不在这里产生。
 */
export function validate(model: SemanticModel, pm: PanelModel, rules: RuleSet): Issue[] {
  const out: Issue[] = [];
  const p = model.params;
  const t = rules.materials[p.boardMaterial].thickness;
  const tb = rules.materials[p.backPanel.material].thickness;
  const bp = p.backPanel;

  const err = (code: string, target: string, message: string, fixHint?: string): void => {
    out.push({ severity: 'ERROR', code, target, message, fixHint });
  };
  const warn = (code: string, target: string, message: string, fixHint?: string): void => {
    out.push({ severity: 'WARNING', code, target, message, fixHint });
  };
  const info = (code: string, target: string, message: string, fixHint?: string): void => {
    out.push({ severity: 'INFO', code, target, message, fixHint });
  };

  // ───────────── A. 恒等式断言 ─────────────
  const assertEq = (label: string, a: number, b: number, detail: string): void => {
    if (Math.abs(a - b) > 1e-9) {
      err('IDENTITY-FAIL', model.id, `恒等式失败 [${label}]：${detail}（左=${a}，右=${b}）`);
    }
  };

  assertEq('箱体高 + 抬高 = 总高', pm.bodyHeight + p.bodyLift, p.height, 'bodyH + bodyLift = height');
  assertEq('内空高 + 2×板厚 = 箱体高', pm.inner.height + 2 * t, pm.bodyHeight, 'innerH + 2t = bodyH');
  assertEq('内空宽 + 2×板厚 = 总宽', pm.inner.width + 2 * t, p.width, 'innerW + 2t = width');

  const chainW = t + pm.units.reduce((a, u) => a + u.netWidth, 0) + (pm.units.length - 1) * t + t;
  assertEq('宽度链', chainW, p.width, 't + Σ净宽 + (n-1)t + t = width');

  const backW = pm.panels.find((x) => x.role === 'BackPanel')?.width ?? 0;
  assertEq(
    '背板宽 = 内空宽 + 2×槽深 - 2×余量',
    backW,
    pm.inner.width + 2 * bp.grooveDepth - 2 * bp.clearance,
    'backW = innerW + 2*grooveDepth - 2*clearance'
  );

  // 每个分区的横向分配链
  for (const u of pm.units) {
    const fronts = pm.panels.filter((x) => x.group === u.id && (x.role === 'DoorPanel' || x.role === 'DrawerFront'));
    if (fronts.length === 0) continue;
    const isDoor = fronts[0].role === 'DoorPanel';
    if (isDoor && model.layout.units.find((x) => x.id === u.id)?.doors) {
      const dr = model.layout.units.find((x) => x.id === u.id)!.doors!;
      const sum = fronts.reduce((a, x) => a + x.width, 0);
      assertEq(
        `门宽之和 + 缝 = 净宽（${u.id}）`,
        sum + 2 * dr.gapOuter + (dr.count - 1) * dr.gapMid,
        u.netWidth,
        'Σ门宽 + 2×外缝 + (n-1)×中缝 = 净宽'
      );
      const sumH = fronts[0].length;
      assertEq(`门高 + 2×外缝 = 净高（${u.id}）`, sumH + 2 * dr.gapOuter, u.netHeight, '门高 + 2×外缝 = 净高');
    }
    if (!isDoor && model.layout.units.find((x) => x.id === u.id)?.drawers) {
      const d = model.layout.units.find((x) => x.id === u.id)!.drawers!;
      const sum = fronts.reduce((a, x) => a + x.length, 0);
      // 竖向缝隙有两组：分格之间/上下的 (n+1) 道，以及每块面板内缩的 2×n 道。
      // Σ面板高 + (n+1)×gap + 2×n×gap = 净高
      assertEq(
        `抽屉面板高之和 + 缝 = 净高（${u.id}）`,
        sum + (d.count + 1) * d.gap + 2 * d.count * d.gap,
        u.netHeight,
        'Σ面板高 + (n+1)×gap + 2n×gap = 净高'
      );
      for (const f of fronts) {
        assertEq(`抽屉面板宽 + 2×缝 = 净宽（${f.id}）`, f.width + 2 * d.gap, u.netWidth, '面板宽 + 2×缝 = 净宽');
      }
    }
  }

  // ID 唯一性
  const seen = new Set<string>();
  for (const x of pm.panels) {
    if (seen.has(x.id)) err('DUP-PANEL-ID', x.id, `板件 ID 重复：${x.id}`);
    seen.add(x.id);
  }

  // ───────────── B. 生产硬规则 ─────────────
  const [sheetL, sheetS] = rules.limits.maxSheetSize;

  for (const x of pm.panels) {
    if (x.length < rules.limits.minPanelSize || x.width < rules.limits.minPanelSize) {
      warn('RULE-MIN-PANEL', x.id, `${x.nameZh} ${x.length}×${x.width}mm 小于最小可用尺寸 ${rules.limits.minPanelSize}mm，属边角料。`, '调整分格或合并板件');
    }
    const fitsGrain = x.length <= sheetL && x.width <= sheetS;
    const fitsRotated = x.length <= sheetS && x.width <= sheetL;
    const ok = x.grain === 'length' ? fitsGrain : fitsGrain || fitsRotated;
    if (!ok) {
      err('RULE-PANEL-OVER-SHEET', x.id, `${x.nameZh} ${x.length}×${x.width}mm 超出板材最大幅面 ${sheetL}×${sheetS}${x.grain === 'length' ? '（有木纹方向，不可旋转）' : ''}。`, '拆块或改用拼板方案');
    }
    const dens = rules.materials[x.material]?.density ?? 0.72;
    const w = (x.length / 1000) * (x.width / 1000) * (x.thickness / 1000) * dens * 1000;
    if (w > rules.limits.maxPanelWeightKg) {
      warn('RULE-PANEL-WEIGHT', x.id, `${x.nameZh} 单件约 ${w.toFixed(1)}kg，超过人工搬运建议上限 ${rules.limits.maxPanelWeightKg}kg（共 ${x.qty} 件）。`, '拆块或双人搬运');
    }
    for (const e of [x.edge.top, x.edge.bottom, x.edge.left, x.edge.right]) {
      if (e && !rules.edgebanding[e]) {
        err('RULE-EDGE-UNKNOWN', x.id, `${x.nameZh} 引用了不存在的封边材料 ${e}。`, '检查 ruleset 的 edgebanding 定义');
      }
    }
  }

  if (p.height > rules.limits.maxSingleCabinetHeight) {
    warn('RULE-CABINET-SPLIT-HEIGHT', model.id, `柜体高 ${p.height}mm 超过单柜建议上限 ${rules.limits.maxSingleCabinetHeight}mm。`, '考虑上下分柜（拆柜）');
  }
  if (p.width > rules.limits.maxSingleCabinetWidth) {
    warn('RULE-CABINET-SPLIT-WIDTH', model.id, `柜体宽 ${p.width}mm 超过单柜建议上限 ${rules.limits.maxSingleCabinetWidth}mm。`, '考虑左右分柜');
  }

  for (const u of model.layout.units) {
    const net = pm.units.find((x) => x.id === u.id)!.netWidth;
    if (u.shelves && u.shelves.count > 0 && net > rules.limits.maxShelfSpan) {
      warn('RULE-SHELF-SPAN', `${model.id}.${u.id}`, `${u.id} 层板跨度 ${net}mm 超过建议上限 ${rules.limits.maxShelfSpan}mm。`, '增加中立板，或加厚层板至 25mm');
    }
    if (u.doors) {
      const doorH = pm.units.find((x) => x.id === u.id)!.netHeight - 2 * u.doors.gapOuter;
      const doorW = Math.max(...pm.panels.filter((x) => x.group === u.id && x.role === 'DoorPanel').map((x) => x.width));
      if (doorW > rules.limits.maxDoorWidth) {
        err('RULE-DOOR-MAX-WIDTH', `${model.id}.${u.id}`, `门板宽度 ${doorW}mm 超过规则允许上限 ${rules.limits.maxDoorWidth}mm。`, '增加门扇数量');
      }
      if (doorH > rules.limits.maxDoorHeight) {
        err('RULE-DOOR-MAX-HEIGHT', `${model.id}.${u.id}`, `门板高度 ${doorH}mm 超过规则允许上限 ${rules.limits.maxDoorHeight}mm。`, '拆为上下两扇');
      } else if (doorH > 1600) {
        info('RULE-DOOR-TALL', `${model.id}.${u.id}`, `门板高 ${doorH}mm，需 ${Math.ceil(doorH / rules.limits.hingeSpacingMax)} 只铰链；建议复核铰链品牌与承重。`);
      }
    }
    if (u.drawers) {
      const fronts = pm.panels.filter((x) => x.group === u.id && x.role === 'DrawerFront');
      const maxFront = Math.max(...fronts.map((x) => x.length));
      if (maxFront > 400) {
        warn('RULE-DRAWER-TALL-FRONT', `${model.id}.${u.id}`, `抽屉面板最高 ${maxFront}mm，超出单抽常用高度（≤400mm）。`, '增加抽屉数量，或改为「抽屉 + 上翻门」组合');
      }
    }
  }

  return out;
}
