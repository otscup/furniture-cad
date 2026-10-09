import type { EdgeSpec, Issue, Panel, Project, RuleSet, SharedPanel, SharedPanelMemberSnapshot, SharedPanelTrace } from './types.ts';
import { buildIssue } from './rules/issueCatalog.ts';
import { getCabinetFootprint } from './geometry/generate.ts';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const roundTripPanelIds = (memberIds: string[]) => memberIds.map((id) => `P_${id}_TOP`).sort();

function parseOverhang(value: unknown): SharedPanel['overhang'] | null {
  if (!isRecord(value) || !isInt(value.front) || !isInt(value.back) || !isInt(value.left) || !isInt(value.right)) return null;
  return { front: value.front, back: value.back, left: value.left, right: value.right };
}

function cabinetSnapshot(cabinet: Project['cabinets'][number]): SharedPanelMemberSnapshot {
  return {
    cabinetId: cabinet.id,
    roomId: cabinet.roomId,
    x: cabinet.placement.x,
    y: cabinet.placement.y,
    rotation: cabinet.placement.rotation,
    width: cabinet.params.width,
    height: cabinet.params.height,
    depth: cabinet.params.depth,
    mountHeight: cabinet.params.mountHeight ?? 0,
    bodyLift: cabinet.params.bodyLift,
    boardMaterial: cabinet.params.boardMaterial,
  };
}

/** Capture only cabinet facts that affect a shared top's membership/extent/elevation. */
export function snapshotSharedPanelMembers(project: Project, memberCabinetIds: string[]): SharedPanelMemberSnapshot[] {
  const byId = new Map(project.cabinets.map((cabinet) => [cabinet.id, cabinet]));
  return memberCabinetIds.map((id) => byId.get(id)).filter((cabinet): cabinet is Project['cabinets'][number] => Boolean(cabinet))
    .map(cabinetSnapshot).sort((a, b) => a.cabinetId.localeCompare(b.cabinetId));
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** The exact confirmation payload. It is a freshness marker, not a security signature. */
export function sharedPanelConfirmationPayload(panel: SharedPanel): string {
  const { confirmation: _confirmation, ...authored } = panel;
  return stableStringify(authored);
}

/** Call only after a person confirms every manufacturing field; never call from inference. */
export function confirmSharedPanel(panel: SharedPanel, project: Project): SharedPanel {
  const withCurrentMembers: SharedPanel = {
    ...structuredClone(panel),
    memberSnapshots: snapshotSharedPanelMembers(project, panel.memberCabinetIds),
    confirmation: { status: 'confirmed', fingerprint: '' },
  };
  withCurrentMembers.confirmation.fingerprint = sharedPanelConfirmationPayload(withCurrentMembers);
  return withCurrentMembers;
}

function memberSnapshotIsCurrent(snapshot: unknown, cabinet: Project['cabinets'][number]): boolean {
  if (!isRecord(snapshot)) return false;
  return stableStringify(snapshot) === stableStringify(cabinetSnapshot(cabinet));
}

function fieldProblems(panel: SharedPanel, project: Project, rules: RuleSet): string[] {
  const p = panel as unknown as Record<string, any>;
  const problems: string[] = [];
  const cabinets = new Map(project.cabinets.map((cabinet) => [cabinet.id, cabinet]));
  const rawMembers: unknown[] = Array.isArray(p.memberCabinetIds) ? p.memberCabinetIds : [];
  const members = rawMembers.filter(isNonEmpty);

  if (!isNonEmpty(p.id)) problems.push('缺少稳定共享件 ID');
  if (!isNonEmpty(p.name)) problems.push('缺少共享件名称');
  if (!Array.isArray(p.memberCabinetIds) || rawMembers.length < 2) problems.push('至少要明确选择两个成员柜');
  if (rawMembers.some((id) => !isNonEmpty(id))) problems.push('成员柜 ID 必须全部是非空字符串');
  if (new Set(members).size !== members.length) problems.push('成员柜 ID 重复');
  if (members.some((id) => !cabinets.has(id))) problems.push('成员柜已删除或不存在');
  const memberRooms = [...new Set(members.map((id) => cabinets.get(id)?.roomId).filter(Boolean))];
  if (memberRooms.length > 1) problems.push('成员柜不在同一房间');

  const replaced = Array.isArray(p.replacesPanelIds) ? p.replacesPanelIds : [];
  if (replaced.some((id: unknown) => typeof id !== 'string') || stableStringify([...replaced].sort()) !== stableStringify(roundTripPanelIds(members))) {
    problems.push('替代柜顶 ID 必须与成员柜一一对应');
  }

  const bounds = p.bounds;
  if (!isRecord(bounds) || !['minX', 'minY', 'maxX', 'maxY'].every((key) => isInt(bounds[key]))) {
    problems.push('共享板几何范围必须是整数毫米');
  } else if ((bounds.maxX as number) <= (bounds.minX as number) || (bounds.maxY as number) <= (bounds.minY as number)) {
    problems.push('共享板几何范围必须为正面积');
  }
  const overhang = parseOverhang(p.overhang);
  if (!overhang) problems.push('前后左右外挑量未确认（整数毫米，允许显式填 0）');
  else if (Object.values(overhang).some((value) => value < 0)) {
    problems.push('负外挑未定义内缩工艺，必须阻断；四边外挑只能是非负整数毫米');
  }
  if (overhang && Object.values(overhang).every((value) => value >= 0) &&
    rawMembers.length === members.length && members.length >= 2 && members.every((id) => cabinets.has(id))) {
    const points = members.flatMap((id) => getCabinetFootprint(cabinets.get(id)!));
    const cabinetEnvelope = {
      minX: Math.min(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
    };
    if (!Object.values(cabinetEnvelope).every(Number.isSafeInteger)) {
      problems.push('成员柜联合矩形边界不是整数毫米；当前矩形共享件不做隐式取整');
    } else if (isRecord(bounds) && ['minX', 'minY', 'maxX', 'maxY'].every((key) => isInt(bounds[key]))) {
      const expectedBounds = {
        minX: cabinetEnvelope.minX - overhang.left,
        minY: cabinetEnvelope.minY - overhang.back,
        maxX: cabinetEnvelope.maxX + overhang.right,
        maxY: cabinetEnvelope.maxY + overhang.front,
      };
      if (stableStringify(bounds) !== stableStringify(expectedBounds)) {
        problems.push('成品 bounds 必须精确等于成员柜联合范围加四边已确认外挑（左/右沿 X，后/前沿 Y）');
      }
    }
  }
  if (!isInt(p.elevation) || (p.elevation as number) < 0) problems.push('共享板标高必须是非负整数毫米');
  if (!isInt(p.length) || !isInt(p.width) || (p.length as number) <= 0 || (p.width as number) <= 0) {
    problems.push('长宽必须是正整数毫米');
  } else if (isRecord(bounds) && isInt(bounds.minX) && isInt(bounds.minY) && isInt(bounds.maxX) && isInt(bounds.maxY) &&
    (p.length !== (bounds.maxX as number) - (bounds.minX as number) || p.width !== (bounds.maxY as number) - (bounds.minY as number))) {
    problems.push('长宽必须与已确认的矩形几何范围一致');
  }
  if (!isInt(p.thickness) || (p.thickness as number) <= 0) problems.push('厚度必须是正整数毫米');
  const materialDef = isNonEmpty(p.material) ? rules.materials[p.material] : undefined;
  if (!materialDef || materialDef.kind !== 'board') problems.push('材料缺失、不是板材或不在当前材料规则集中');
  else if (isInt(p.thickness) && p.thickness !== materialDef.thickness) problems.push(`厚度 ${p.thickness}mm 与材料「${p.material}」标称 ${materialDef.thickness}mm 不一致`);
  if (!isNonEmpty(p.finish)) problems.push('饰面/表面处理未确认');
  if (!['length', 'width', 'none'].includes(p.grainDirection)) problems.push('成品板纹理方向未明确持久化确认');
  if (p.grain !== p.grainDirection) problems.push('制造纹理字段必须与明确确认的 grainDirection 一致');
  if (materialDef?.grain === true && !['length', 'width'].includes(p.grainDirection)) problems.push('该材料需要纹理方向，必须确认沿成品板长轴或宽轴');
  if (materialDef?.grain === false && p.grainDirection !== 'none') problems.push('该材料定义为无纹理，必须显式确认 grainDirection=none');

  const edges = p.edgeTreatment;
  if (!isRecord(edges) || !['top', 'bottom', 'left', 'right'].every((key) => edges[key] === null || (typeof edges[key] === 'string' && Boolean(rules.edgebanding[edges[key]])))) {
    problems.push('四边封边规格未确认（每边需给封边 ID 或明确填 null）');
  }
  const segmentation = p.segmentation;
  if (!isRecord(segmentation) || segmentation.confirmed !== true || !Array.isArray(segmentation.segments) || segmentation.segments.length === 0) {
    problems.push('接缝/分段方案未确认；必须明确为整件或填写人工确认的分段');
  } else if (isRecord(bounds) && isInt(bounds.minX) && isInt(bounds.minY) && isInt(bounds.maxX) && isInt(bounds.maxY)) {
    const segments = segmentation.segments as unknown[];
    const normalized = segments.filter(isRecord);
    if (normalized.length !== segments.length || normalized.some((s) => !isNonEmpty(s.id) || !isInt(s.x) || !isInt(s.y) || !isInt(s.length) || !isInt(s.width) || (s.length as number) <= 0 || (s.width as number) <= 0)) {
      problems.push('分段必须有唯一 ID、位置及正整数尺寸');
    } else {
      const ids = normalized.map((s) => s.id as string);
      if (new Set(ids).size !== ids.length) problems.push('分段 ID 重复');
      const outOfRange = normalized.some((s) => (s.x as number) < (bounds.minX as number) || (s.y as number) < (bounds.minY as number) ||
        (s.x as number) + (s.length as number) > (bounds.maxX as number) || (s.y as number) + (s.width as number) > (bounds.maxY as number));
      const overlapping = normalized.some((a, i) => normalized.slice(i + 1).some((b) =>
        (a.x as number) < (b.x as number) + (b.length as number) && (a.x as number) + (a.length as number) > (b.x as number) &&
        (a.y as number) < (b.y as number) + (b.width as number) && (a.y as number) + (a.width as number) > (b.y as number)));
      const area = normalized.reduce((sum, s) => sum + (s.length as number) * (s.width as number), 0);
      if (outOfRange || overlapping || area !== ((bounds.maxX as number) - (bounds.minX as number)) * ((bounds.maxY as number) - (bounds.minY as number))) {
        problems.push('人工分段必须无重叠、完全覆盖共享矩形范围；系统不替用户设计拼缝');
      }
      const [sheetA, sheetB] = materialDef?.maxSheet ?? rules.limits.maxSheetSize;
      const tooLarge = normalized.some((s) => !((s.length as number) <= sheetA && (s.width as number) <= sheetB) && !((s.length as number) <= sheetB && (s.width as number) <= sheetA));
      if (tooLarge) problems.push(`至少一段超出板材幅面 ${sheetA}×${sheetB}mm`);
    }
  }

  const support = p.support;
  if (!isRecord(support) || support.confirmed !== true || !isNonEmpty(support.method) || !Array.isArray(support.memberCabinetIds) || support.memberCabinetIds.length === 0 ||
    support.memberCabinetIds.some((id: unknown) => !members.includes(String(id)))) {
    problems.push('支撑方式及承托柜体未确认');
  }
  const machining = p.machining;
  if (!isRecord(machining) || typeof machining.status !== 'string' || !['confirmed-none', 'confirmed-holes', 'reference-only', 'unconfirmed'].includes(machining.status)) {
    problems.push('孔位/CNC 加工状态未确认');
  } else if (machining.status === 'reference-only') {
    problems.push('孔位仍是参考标记，不是已确认 CNC 加工数据');
  } else if (machining.status === 'unconfirmed') {
    problems.push('CNC 孔位尚未确认');
  } else if (machining.status === 'confirmed-none') {
    if (!Array.isArray(machining.holes) || machining.holes.length !== 0) problems.push('标记无孔时必须显式保存空孔位数组；如有孔请记录类型、坐标、直径和深度');
  } else if (machining.status === 'confirmed-holes') {
    const holes = Array.isArray(machining.holes) ? machining.holes.filter(isRecord) : [];
    if (!Array.isArray(machining.holes) || holes.length === 0 || holes.length !== machining.holes.length) {
      problems.push('有孔加工时必须逐孔填写记录，不能留空');
    } else {
      if (new Set(holes.map((hole) => hole.id)).size !== holes.length) problems.push('CNC 孔位 ID 重复');
      for (const hole of holes) {
        if (!isNonEmpty(hole.id) || !isNonEmpty(hole.kind) || !isInt(hole.x) || !isInt(hole.y) || !isInt(hole.diameter) || !isInt(hole.depth) ||
          (hole.diameter as number) <= 0 || (hole.depth as number) <= 0 || (hole.depth as number) > (p.thickness as number) ||
          (hole.x as number) - (hole.diameter as number) / 2 < 0 || (hole.y as number) - (hole.diameter as number) / 2 < 0 ||
          (hole.x as number) + (hole.diameter as number) / 2 > (p.length as number) || (hole.y as number) + (hole.diameter as number) / 2 > (p.width as number)) {
          problems.push(`孔位「${String(hole.id ?? '(缺 ID)')}」必须明确类型、局部坐标、正孔径与不超过板厚的正孔深，且完整落在板内`);
          continue;
        }
        const segments = isRecord(segmentation) && Array.isArray(segmentation.segments) ? segmentation.segments.filter(isRecord) : [];
        const r = (hole.diameter as number) / 2;
        const fitsSegmentCount = segments.filter((segment) => {
          if (!isInt(segment.x) || !isInt(segment.y) || !isInt(segment.length) || !isInt(segment.width) || !isRecord(bounds)) return false;
          const localX = (segment.x as number) - (bounds.minX as number);
          const localY = (segment.y as number) - (bounds.minY as number);
          return (hole.x as number) - r >= localX && (hole.y as number) - r >= localY &&
            (hole.x as number) + r <= localX + (segment.length as number) && (hole.y as number) + r <= localY + (segment.width as number);
        }).length;
        if (fitsSegmentCount !== 1) problems.push(`孔位「${hole.id}」必须完整落入且只落入一个人工确认分段（不能跨接缝）`);
      }
    }
  }

  const snapshots: unknown[] = Array.isArray(p.memberSnapshots) ? p.memberSnapshots : [];
  if (!Array.isArray(p.memberSnapshots)) {
    problems.push('成员柜快照必须与成员 cabinetId 精确一一对应');
  } else {
    const snapshotIds = snapshots.map((snapshot) => isRecord(snapshot) ? snapshot.cabinetId : undefined);
    const validSnapshotIds = snapshotIds.filter(isNonEmpty);
    const duplicateSnapshotIds = new Set(validSnapshotIds).size !== validSnapshotIds.length;
    const exactSnapshotIds = snapshots.length === members.length && !duplicateSnapshotIds &&
      snapshotIds.every(isNonEmpty) && members.every((id) => snapshotIds.filter((snapshotId) => snapshotId === id).length === 1) &&
      snapshotIds.every((id) => members.includes(id));
    if (!exactSnapshotIds) problems.push('成员柜快照必须与成员 cabinetId 精确一一对应，不得重复占位、遗漏或包含额外成员');
    const snapshotIsStale = snapshots.some((snapshot: unknown) => {
      if (!isRecord(snapshot) || !isNonEmpty(snapshot.cabinetId)) return true;
      const cabinet = cabinets.get(snapshot.cabinetId);
      return !cabinet || !members.includes(snapshot.cabinetId) || !memberSnapshotIsCurrent(snapshot, cabinet);
    }) || members.some((id) => {
      const cabinet = cabinets.get(id);
      const matchingSnapshot = snapshots.find((snapshot) => isRecord(snapshot) && snapshot.cabinetId === id);
      return !cabinet || !matchingSnapshot || !memberSnapshotIsCurrent(matchingSnapshot, cabinet);
    });
    if (snapshotIsStale) problems.push('成员柜快照缺失，或尺寸/位置/标高/材料已变化导致 stale；须重新核对并确认');
  }

  const [maxA, maxB] = materialDef?.maxSheet ?? rules.limits.maxSheetSize;
  if (isInt(p.length) && isInt(p.width) && p.segmentation?.segments?.length === 1 &&
    !((p.length <= maxA && p.width <= maxB) || (p.length <= maxB && p.width <= maxA))) {
    problems.push(`整件超过板材幅面 ${maxA}×${maxB}mm，需由用户确认拼缝并建立分段`);
  }
  if (p.confirmation?.status !== 'confirmed' || !isNonEmpty(p.confirmation?.fingerprint) ||
    p.confirmation.fingerprint !== sharedPanelConfirmationPayload(panel)) {
    problems.push('共享件关键制造信息未确认，或确认后字段已变化（stale）');
  }
  return [...new Set(problems)];
}

export function validateSharedPanels(project: Project, rules: RuleSet): Issue[] {
  const raw = (project as Project & { sharedPanels?: unknown }).sharedPanels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    return [buildIssue('RULE-SHARED-PANEL-BLOCKED', { target: 'sharedPanels', targetKind: 'project', ctx: { panelId: 'sharedPanels', reasons: '共享件清单不是数组' } })];
  }
  const issues: Issue[] = [];
  const seenIds = new Set<string>();
  const replacedBy = new Map<string, string>();
  for (const candidate of raw) {
    if (!isRecord(candidate)) {
      issues.push(buildIssue('RULE-SHARED-PANEL-BLOCKED', { target: 'sharedPanels', targetKind: 'project', ctx: { panelId: '(非法记录)', reasons: '共享件记录结构非法' } }));
      continue;
    }
    const panel = candidate as unknown as SharedPanel;
    const panelId = isNonEmpty(candidate.id) ? candidate.id : '(缺少 ID)';
    const reasons = fieldProblems(panel, project, rules);
    if (seenIds.has(panelId)) reasons.push('共享件 ID 重复');
    seenIds.add(panelId);
    if (Array.isArray(candidate.replacesPanelIds)) for (const id of candidate.replacesPanelIds) {
      if (typeof id !== 'string') continue;
      const previous = replacedBy.get(id);
      if (previous) reasons.push(`柜顶 ${id} 已被共享件 ${previous} 替代，不能重复归属`);
      else replacedBy.set(id, panelId);
    }
    if (reasons.length) issues.push(buildIssue('RULE-SHARED-PANEL-BLOCKED', {
      target: panelId,
      targetKind: 'project',
      ctx: { panelId, reasons: [...new Set(reasons)].join('；') },
    }));
  }
  return issues;
}

function traceOf(panel: SharedPanel): SharedPanelTrace {
  return {
    id: panel.id,
    segmentId: '',
    memberCabinetIds: [...panel.memberCabinetIds],
    replacesPanelIds: [...panel.replacesPanelIds],
    finish: panel.finish,
    overhang: { ...panel.overhang },
    edgeTreatment: { ...panel.edgeTreatment },
    supportMethod: panel.support.method,
    supportCabinetIds: [...panel.support.memberCabinetIds],
    length: panel.length,
    width: panel.width,
    thickness: panel.thickness,
    material: panel.material,
    grainDirection: panel.grainDirection,
    grain: panel.grain,
    segmentation: { confirmed: panel.segmentation.confirmed, segments: structuredClone(panel.segmentation.segments) },
    machining: structuredClone(panel.machining),
    bounds: { ...panel.bounds },
    elevation: panel.elevation,
  };
}

export function sharedPanelParts(project: Project, rules: RuleSet): Panel[] {
  if (validateSharedPanels(project, rules).length) return [];
  const panels = (project.sharedPanels ?? []) as SharedPanel[];
  return panels.flatMap((panel) => panel.segmentation.segments.map((segment, index) => {
    const trace = traceOf(panel);
    trace.segmentId = segment.id;
    const edge: EdgeSpec = { ...panel.edgeTreatment };
    const edges = Object.entries(edge).map(([side, id]) => `${side}:${id ?? '不封边'}`).join('；');
    return {
      id: `P_SHARED_${panel.id}_${segment.id}`,
      role: 'SharedTopPanel',
      nameZh: panel.segmentation.segments.length === 1 ? panel.name : `${panel.name}·分段${index + 1}`,
      belongsTo: `shared:${panel.id}`,
      group: '跨柜共享制造件',
      material: panel.material,
      thickness: panel.thickness,
      length: segment.length,
      width: segment.width,
      qty: 1,
      grain: panel.grainDirection,
      edge,
      edgeLabel: `${edges}；饰面：${panel.finish}`,
      layer: `PANEL_${panel.thickness}`,
      sharedPanelTrace: trace,
    };
  }));
}

/** Produce metadata and drawing primitives only from fully validated, explicitly confirmed panels. */
export function confirmedSharedPanels(project: Project, rules: RuleSet): SharedPanel[] {
  return validateSharedPanels(project, rules).length ? [] : (project.sharedPanels ?? []) as SharedPanel[];
}
