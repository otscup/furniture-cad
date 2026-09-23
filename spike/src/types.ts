export interface BackPanelSpec {
  material: string;
  method: 'groove' | 'inset';
  grooveDepth: number;
  grooveSetback: number;
  clearance: number;
}

export interface CabinetParams {
  width: number;
  height: number;
  depth: number;
  boardMaterial: string;
  backPanel: BackPanelSpec;
  bodyLift: number;
  shelfFrontClearance: number;
}

export interface DrawerSpec {
  count: number;
  runner: string;
  runnerLength: number;
  sideThickness: number;
  bottomThickness: number;
  bottomGrooveDepth: number;
  gap: number;
  boxHeightDeduct: number;
}

export interface UnitSpec {
  id: string;
  kind: 'drawerBank' | 'hanging' | 'shelves' | 'open';
  requestedWidth: number;
  drawers?: DrawerSpec;
  shelves?: { count: number; mode: 'equal'; gapPerSide: number };
  doors?: {
    type: 'hinged';
    count: number;
    mode: 'equal';
    style: 'inset';
    gapOuter: number;
    gapMid: number;
    hinge: string;
  };
  rod?: { count: number; heightFromBottom: number; hardware: string };
}

export interface SemanticModel {
  schemaVersion: string;
  id: string;
  type: 'Cabinet';
  name: string;
  units: 'mm';
  params: CabinetParams;
  layout: { type: 'row'; widthMode: 'fit_total' | 'fit_units'; units: UnitSpec[] };
}

export interface MaterialDef {
  name: string;
  thickness: number;
  kind: string;
  maxSheet: [number, number];
  grain: boolean;
  density: number;
}

export interface RuleSet {
  id: string;
  name: string;
  materials: Record<string, MaterialDef>;
  edgebanding: Record<string, { name: string; thickness: number }>;
  hardware: Record<string, { name: string; unit: string }>;
  limits: {
    maxSheetSize: [number, number];
    minPanelSize: number;
    maxPanelWeightKg: number;
    maxDoorWidth: number;
    maxDoorHeight: number;
    maxShelfSpan: number;
    maxSingleCabinetHeight: number;
    maxSingleCabinetWidth: number;
    hingeSpacingMax: number;
  };
  policy: {
    remainderPolicy: 'bottom' | 'top' | 'distribute';
    widthAllocationPolicy: 'fit_total' | 'fit_units';
    edgeBandingRule: string;
  };
}

export type EdgeId = string | null;

export interface EdgeSpec {
  top: EdgeId;
  bottom: EdgeId;
  left: EdgeId;
  right: EdgeId;
}

export interface Panel {
  id: string;
  role: string;
  nameZh: string;
  belongsTo: string;
  group: string;
  material: string;
  thickness: number;
  length: number;
  width: number;
  qty: number;
  grain: 'length' | 'width' | 'none';
  edge: EdgeSpec;
  edgeLabel: string;
  layer: string;
}

export interface HardwareItem {
  id: string;
  nameZh: string;
  kind: string;
  qty: number;
  spec: string;
  belongsTo: string;
}

export interface Issue {
  severity: 'ERROR' | 'WARNING' | 'INFO';
  code: string;
  target: string;
  message: string;
  fixHint?: string;
}

export interface PanelModel {
  cabinetId: string;
  cabinetName: string;
  outer: { width: number; height: number; depth: number };
  inner: { width: number; height: number };
  bodyHeight: number;
  units: Array<{
    id: string;
    kind: string;
    netWidth: number;
    netHeight: number;
    x0: number;
    requestedWidth: number;
  }>;
  panels: Panel[];
  hardware: HardwareItem[];
  issues: Issue[];
  stats: { panelKinds: number; totalPieces: number; boardAreaM2: number; estWeightKg: number };
}
