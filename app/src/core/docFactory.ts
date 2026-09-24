import type {
  Cabinet,
  CabinetParams,
  DrawerSpec,
  Project,
  Room,
  RuleSet,
  UnitSpec,
  Wall,
} from './types.ts';
import { nextId } from './ids.ts';

/**
 * 文档工厂 —— 所有"新对象"的唯一构造点。
 *
 * UI 的「放置柜体」、AI 的 create_cabinet、MCP 的 create_project、
 * 脚本导入，全部调用这里。理由：
 *  1. 默认值的唯一来源，避免 UI 一套 AI 一套
 *  2. 建立的对象天然满足 schema（不会漏字段）
 *  3. 未来换默认工艺 = 改这一个文件
 */

// ─────────────────────────── 默认参数 ───────────────────────────

/** 轻质隔墙默认厚度（mm）。换工艺 = 改这一个常量或换规则集。 */
export const DEFAULT_WALL_THICKNESS = 120;
/** 默认层高（mm） */
export const DEFAULT_WALL_HEIGHT = 2700;

export function defaultCabinetParams(rules?: RuleSet): CabinetParams {
  const board = rules ? pickBoard(rules) : 'M_BOARD_18_WOOD';
  const back = rules ? pickBack(rules) : 'M_BACK_9';
  return {
    width: 900,
    height: 2400,
    depth: 600,
    boardMaterial: board,
    backPanel: {
      material: back,
      method: 'groove',
      grooveDepth: 8,
      grooveSetback: 12,
      clearance: 0.5,
    },
    bodyLift: 80,
    shelfFrontClearance: 10,
  };
}

/** 从规则集里挑一块"板"、一块"背板"，而不是硬编码材质 ID */
function pickBoard(rules: RuleSet): string {
  const hit = Object.entries(rules.materials).find(([, m]) => m.kind === 'board' && m.thickness >= 18);
  return hit ? hit[0] : Object.keys(rules.materials)[0];
}
function pickBack(rules: RuleSet): string {
  const hit = Object.entries(rules.materials).find(([, m]) => m.kind === 'back' && m.thickness >= 9);
  return hit ? hit[0] : Object.keys(rules.materials)[0];
}
function pickRunner(rules: RuleSet): { id: string; len: number } {
  const hit = Object.entries(rules.hardware).find(([id]) => /runner|RUNNER|滑轨/.test(id));
  const id = hit ? hit[0] : Object.keys(rules.hardware)[0];
  const m = /(\d{3,4})/.exec(id);
  return { id, len: m ? Number(m[1]) : 500 };
}
function pickHinge(rules: RuleSet): string {
  const hit = Object.entries(rules.hardware).find(([id]) => /hinge|HINGE|铰链/.test(id));
  return hit ? hit[0] : Object.keys(rules.hardware)[0];
}
function pickRod(rules: RuleSet): string {
  const hit = Object.entries(rules.hardware).find(([id]) => /rod|ROD|挂衣杆/.test(id));
  return hit ? hit[0] : Object.keys(rules.hardware)[0];
}

export function defaultDrawerSpec(rules: RuleSet, depth = 600): DrawerSpec {
  const r = pickRunner(rules);
  return {
    count: 3,
    runner: r.id,
    runnerLength: Math.min(r.len, depth - 20),
    sideThickness: 15,
    bottomThickness: 5,
    bottomGrooveDepth: 6,
    gap: 2,
    boxHeightDeduct: 30,
  };
}

// ─────────────────────────── 对象构造 ───────────────────────────

export function createCabinet(opts: {
  id?: string;
  name: string;
  roomId: string;
  x: number;
  y: number;
  rotation?: number;
  params?: Partial<CabinetParams>;
  units?: UnitSpec[];
  rules: RuleSet;
  takenIds?: Iterable<string>;
}): Cabinet {
  const base = defaultCabinetParams(opts.rules);
  const params: CabinetParams = {
    ...base,
    ...opts.params,
    backPanel: { ...base.backPanel, ...(opts.params?.backPanel ?? {}) },
  };
  const units = opts.units && opts.units.length > 0 ? opts.units : defaultUnits(params.width, opts.rules);
  return {
    id: opts.id ?? nextId('cab', opts.takenIds ?? []),
    name: opts.name,
    roomId: opts.roomId,
    placement: { x: Math.round(opts.x), y: Math.round(opts.y), rotation: opts.rotation ?? 0 },
    params,
    layout: { type: 'row', widthMode: 'fit_total', units },
  };
}

/**
 * 按 kind 造一个分区 —— **新分区的唯一构造点**。
 *
 * 为什么必须抽出来：默认三分区（defaultUnits）和 AI 的「新增分区」动作
 * 如果各拼一份 UnitSpec，"挂衣区该带哪些子规格"就会有两处实现。
 * 少一个子规格的后果不是报错，而是生成器**静默跳过**这个分区
 * （见 defaultUnits 的注释）—— 界面上看就是"加了个空分区"，非常难查。
 *
 * 子规格一律来自规则集（五金 id 从 rules.hardware 里挑），不硬编码。
 */
export function makeUnit(opts: {
  id?: string;
  kind: UnitSpec['kind'];
  requestedWidth: number;
  nickname?: string;
  rules: RuleSet;
  depth?: number;
  takenIds?: Iterable<string>;
  /** 按 kind 解释：drawerBank = 抽屉数，shelves = 层板数 */
  count?: number;
  /** 仅 hanging 有效：挂衣杆离柜内底高度 */
  rodHeight?: number;
  /**
   * 门板。**必须在这里挂，不能在调用方自己拼 UnitSpec** ——
   * 本函数是"新分区的唯一构造点"，门板引用规则集里的 `pickHinge()`，
   * 调用方拿不到、也不该自己去挑铰链型号。
   * 风格预设（RuleSet.stylePresets）通过它给分区带门。
   */
  doors?: { count: number; gapMid?: number; gapOuter?: number };
}): UnitSpec {
  const id = opts.id ?? nextId('unit', opts.takenIds ?? []);
  const base = { id, kind: opts.kind, requestedWidth: Math.round(opts.requestedWidth) };
  const nickname = opts.nickname ?? defaultNickname(opts.kind);
  let unit: UnitSpec;
  switch (opts.kind) {
    case 'drawerBank': {
      const d = defaultDrawerSpec(opts.rules, opts.depth ?? 600);
      unit = { ...base, nickname, drawers: { ...d, count: clampInt(opts.count ?? d.count, 1, 10) } };
      break;
    }
    case 'shelves':
      unit = {
        ...base,
        nickname,
        shelves: { count: clampInt(opts.count ?? 4, 1, 12), mode: 'equal', gapPerSide: 0.5 },
      };
      break;
    case 'hanging':
      unit = {
        ...base,
        nickname,
        // 挂衣区自带一块顶层层板 —— 与 defaultUnits 的挂衣区结构一致
        rod: { count: 1, heightFromBottom: Math.round(opts.rodHeight ?? 1800), hardware: pickRod(opts.rules) },
        shelves: { count: 1, mode: 'equal', gapPerSide: 0.5 },
      };
      break;
    case 'open':
      // 空区：什么都不带。是合法状态，不是"忘了填"
      unit = { ...base, nickname };
      break;
    default:
      throw new Error(`未知分区类型 ${String(opts.kind)}`);
  }
  if (opts.doors) {
    unit.doors = {
      type: 'hinged',
      count: clampInt(opts.doors.count, 1, 6),
      mode: 'equal',
      style: 'inset',
      gapOuter: opts.doors.gapOuter ?? 2,
      gapMid: opts.doors.gapMid ?? 3,
      hinge: pickHinge(opts.rules),
      hingeSide: 'left',
    };
  }
  return unit;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

export function defaultNickname(kind: UnitSpec['kind']): string {
  switch (kind) {
    case 'drawerBank':
      return '抽屉';
    case 'hanging':
      return '挂衣';
    case 'shelves':
      return '层板';
    case 'open':
      return '空区';
    default:
      return '分区';
  }
}

/**
 * 默认分区：把柜宽按 2:4:2 拆成三个分区。
 * 每个分区都必须带完整的子规格 —— 否则生成器会静默跳过（比报错更危险）。
 */
export function defaultUnits(width: number, rules: RuleSet): UnitSpec[] {
  if (width < 700) {
    return [makeUnit({ id: 'unit_001', kind: 'shelves', requestedWidth: width, rules, count: 3 })];
  }
  const a = Math.round(width * 0.25);
  const b = Math.round(width * 0.5);
  const c = width - a - b;
  return [
    makeUnit({ id: 'unit_001', kind: 'drawerBank', requestedWidth: a, rules, count: 3 }),
    makeUnit({ id: 'unit_002', kind: 'hanging', requestedWidth: b, rules, rodHeight: 1800 }),
    makeUnit({ id: 'unit_003', kind: 'shelves', requestedWidth: c, rules, count: 4 }),
  ];
}

export function createWall(opts: {
  id?: string;
  name: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
  thickness?: number;
  height?: number;
  takenIds?: Iterable<string>;
}): Wall {
  return {
    id: opts.id ?? nextId('wall', opts.takenIds ?? []),
    name: opts.name,
    start: { x: Math.round(opts.start.x), y: Math.round(opts.start.y) },
    end: { x: Math.round(opts.end.x), y: Math.round(opts.end.y) },
    thickness: opts.thickness ?? DEFAULT_WALL_THICKNESS,
    height: opts.height ?? DEFAULT_WALL_HEIGHT,
  };
}

export function createRoom(opts: { id?: string; name: string; walls?: Wall[]; takenIds?: Iterable<string> }): Room {
  return {
    id: opts.id ?? nextId('room', opts.takenIds ?? []),
    name: opts.name,
    walls: opts.walls ?? [],
  };
}

/** 矩形房间：中心线沿给定矩形，四面墙逆时针 */
export function rectRoom(opts: {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  thickness?: number;
  height?: number;
  takenIds?: Iterable<string>;
}): Room {
  const t = opts.thickness ?? DEFAULT_WALL_THICKNESS;
  const h = opts.height ?? DEFAULT_WALL_HEIGHT;
  const x0 = opts.x;
  const y0 = opts.y;
  const x1 = opts.x + opts.w;
  const y1 = opts.y + opts.h;
  const corners: Array<[number, number]> = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const used = new Set(opts.takenIds ?? []);
  const walls: Wall[] = [];
  const labels = ['南墙', '东墙', '北墙', '西墙'];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    const w = createWall({
      name: `${opts.name}${labels[i]}`,
      start: { x: ax, y: ay },
      end: { x: bx, y: by },
      thickness: t,
      height: h,
      takenIds: used,
    });
    used.add(w.id);
    walls.push(w);
  }
  return createRoom({ name: opts.name, walls, takenIds: opts.takenIds });
}

export function emptyProject(opts: { name?: string; ruleSetId: string; id?: string } = { ruleSetId: 'factory_default_v1' }): Project {
  return {
    schemaVersion: '0.2',
    id: opts.id ?? 'project_001',
    name: opts.name ?? '未命名项目',
    ruleSetId: opts.ruleSetId,
    rooms: [],
    cabinets: [],
  };
}

// ─────────────────────────── 示例项目 ───────────────────────────

/**
 * 示例项目：Phase 0 已验证的 2400 衣柜 + 一个矩形房间。
 * 注意 placement 的语义：柜体"背左角"在世界坐标中的位置，局部 +Y = 背→前。
 * 南墙中心线在 y=0，厚 120 → 内表面 y=60。柜体背靠南墙，故 y=60（相切，不算干涉）。
 */
export function sampleProject(rules: RuleSet): Project {
  const room = rectRoom({ name: '主卧', x: 0, y: 0, w: 3200, h: 2600, thickness: 120, height: 2700 });

  const drawers = defaultDrawerSpec(rules, 600);
  const cabinet = createCabinet({
    id: 'cab_001',
    name: '主卧衣柜',
    roomId: room.id,
    x: 400,
    y: 60,
    rotation: 0,
    rules,
    params: { width: 2400, height: 2400, depth: 600, bodyLift: 80, shelfFrontClearance: 10 },
    units: [
      {
        id: 'unit_001',
        kind: 'drawerBank',
        requestedWidth: 600,
        nickname: '抽屉',
        drawers: { ...drawers, count: 3 },
      },
      {
        id: 'unit_002',
        kind: 'hanging',
        requestedWidth: 1200,
        nickname: '挂衣',
        rod: { count: 1, heightFromBottom: 1800, hardware: pickRod(rules) },
        shelves: { count: 1, mode: 'equal', gapPerSide: 0.5 },
      },
      {
        id: 'unit_003',
        kind: 'shelves',
        requestedWidth: 600,
        nickname: '层板',
        shelves: { count: 4, mode: 'equal', gapPerSide: 0.5 },
        doors: {
          type: 'hinged',
          count: 2,
          mode: 'equal',
          style: 'inset',
          gapOuter: 2,
          gapMid: 3,
          hinge: pickHinge(rules),
          hingeSide: 'left',
        },
      },
    ],
  });

  const project = emptyProject({ name: '示例户型', ruleSetId: rules.id, id: 'project_001' });
  project.rooms.push(room);
  project.cabinets.push(cabinet);
  return project;
}
