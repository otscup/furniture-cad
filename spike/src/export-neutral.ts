import type { PanelModel, RuleSet, SemanticModel } from './types.ts';

export interface ElevationRect {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: string;
  label: string;
  dashed?: boolean;
}

export interface NeutralExport {
  meta: Record<string, unknown>;
  panels: PanelModel['panels'];
  hardware: PanelModel['hardware'];
  issues: PanelModel['issues'];
  elevation: {
    outer: { w: number; h: number };
    rects: ElevationRect[];
    dims: Array<{ kind: 'vertical' | 'horizontal'; x: number; y: number; length: number; text: string }>;
  };
  stats: PanelModel['stats'];
}

/**
 * Panel Model → 中立交换格式。
 * 几何全部在 TS 侧算好；Python 只负责序列化成 DXF，不做任何计算。
 * 立面图同样从 Panel Model 派生（而不是重新算一遍），保证"图 = 料"。
 */
export function toNeutralExport(
  model: SemanticModel,
  pm: PanelModel,
  rules: RuleSet,
  generatorVersion: string
): NeutralExport {
  const p = model.params;
  const t = rules.materials[p.boardMaterial].thickness;
  const baseY = p.bodyLift; // 柜内底板下沿的标高
  const innerBottomY = baseY + t; // 内空起始
  const bodyTopY = p.height - t; // 顶板下沿

  const rects: ElevationRect[] = [];

  // 踢脚
  rects.push({ x: t, y: 0, w: pm.inner.width, h: p.bodyLift, layer: 'ELEV_STRUCT', label: '踢脚板' });
  // 左右侧板
  rects.push({ x: 0, y: baseY, w: t, h: pm.bodyHeight, layer: 'ELEV_STRUCT', label: '左侧板' });
  rects.push({ x: p.width - t, y: baseY, w: t, h: pm.bodyHeight, layer: 'ELEV_STRUCT', label: '右侧板' });
  // 顶板 / 底板
  rects.push({ x: t, y: p.height - t, w: pm.inner.width, h: t, layer: 'ELEV_STRUCT', label: '顶板' });
  rects.push({ x: t, y: baseY, w: pm.inner.width, h: t, layer: 'ELEV_STRUCT', label: '底板' });

  // 立板
  for (let i = 0; i < pm.units.length - 1; i++) {
    const x = pm.units[i].x0 + pm.units[i].netWidth;
    rects.push({ x, y: innerBottomY, w: t, h: pm.inner.height, layer: 'ELEV_STRUCT', label: `中立板${i + 1}` });
  }

  for (const u of pm.units) {
    const spec = model.layout.units.find((x) => x.id === u.id)!;

    // 层板（从 Panel Model 反推位置，天然与板件一致）
    const shelves = pm.panels.filter((x) => x.group === u.id && x.role === 'ShelfPanel');
    for (const s of shelves) {
      const m = /距柜内底 (\d+)mm/.exec(s.edgeLabel);
      const pos = m ? Number(m[1]) : 0;
      rects.push({ x: u.x0, y: innerBottomY + pos, w: u.netWidth, h: t, layer: 'ELEV_STRUCT', label: s.nameZh });
    }

    if (spec.drawers) {
      const fronts = pm.panels
        .filter((x) => x.group === u.id && x.role === 'DrawerFront')
        .sort((a, b) => a.id.localeCompare(b.id));
      let y = innerBottomY + spec.drawers.gap;
      for (const f of fronts) {
        rects.push({ x: u.x0 + spec.drawers.gap, y, w: f.width, h: f.length, layer: 'ELEV_FRONT', label: f.nameZh });
        y += f.length + spec.drawers.gap;
      }
    }

    if (spec.doors) {
      const doors = pm.panels
        .filter((x) => x.group === u.id && x.role === 'DoorPanel')
        .sort((a, b) => a.id.localeCompare(b.id));
      let x = u.x0 + spec.doors.gapOuter;
      for (const d of doors) {
        rects.push({
          x,
          y: innerBottomY + spec.doors.gapOuter,
          w: d.width,
          h: d.length,
          layer: 'ELEV_FRONT',
          label: d.nameZh,
        });
        x += d.width + spec.doors.gapMid;
      }
    }

    if (spec.rod) {
      rects.push({
        x: u.x0 + 1,
        y: innerBottomY + spec.rod.heightFromBottom,
        w: u.netWidth - 2,
        h: 0,
        layer: 'ELEV_HW',
        label: '挂衣杆',
        dashed: true,
      });
    }
  }

  const dims: NeutralExport['elevation']['dims'] = [
    { kind: 'vertical', x: -120, y: 0, length: p.height, text: `${p.height}` },
    { kind: 'vertical', x: -60, y: baseY, length: pm.bodyHeight, text: `${pm.bodyHeight}` },
    { kind: 'vertical', x: -190, y: 0, length: p.bodyLift, text: `${p.bodyLift}` },
    { kind: 'horizontal', x: 0, y: -120, length: p.width, text: `${p.width}` },
  ];
  for (const u of pm.units) {
    dims.push({ kind: 'horizontal', x: u.x0, y: -60, length: u.netWidth, text: `${u.netWidth}` });
  }

  return {
    meta: {
      cabinetId: pm.cabinetId,
      cabinetName: pm.cabinetName,
      units: 'mm',
      insUnits: 4,
      outer: pm.outer,
      inner: pm.inner,
      generatorVersion,
      ruleSetId: rules.id,
      ruleSetName: rules.name,
      generatedAt: new Date().toISOString(),
      traceability: {
        modelId: model.id,
        schemaVersion: model.schemaVersion,
        generator: generatorVersion,
        ruleSet: `${rules.id}@1`,
      },
    },
    panels: pm.panels,
    hardware: pm.hardware,
    issues: pm.issues,
    elevation: { outer: { w: p.width, h: p.height }, rects, dims },
    stats: pm.stats,
  };
}
