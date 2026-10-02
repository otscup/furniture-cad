import type {
  ApplianceSpec,
  Cabinet,
  CabinetParams,
  CabinetRow,
  DrawerSpec,
  ImportOrigin,
  Project,
  Room,
  RuleSet,
  UnitSpec,
  Wall,
} from './types.ts';
import { nextId } from './ids.ts';
import { ROW_HEIGHT_FILL } from './layoutModel.ts';
import { findCabinetTemplate, resolveTemplateUnitWidths, resolveTemplateUnitWidthList } from './templates.ts';

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
    finishedEnds: 'none',
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
/**
 * 默认门板材质：规则集里 kind='board' 且厚度最大的那块（门板要刚度，取厚板）。
 * 不硬编码材质 ID —— 换工厂规则集后自动跟随；找不出 board 材质时才兜底第一个。
 */
function pickDoorMaterial(rules: RuleSet): string {
  const boards = Object.entries(rules.materials).filter(([, m]) => m.kind === 'board');
  if (boards.length === 0) return Object.keys(rules.materials)[0]!;
  return boards.sort((a, b) => b[1].thickness - a[1].thickness)[0]![0];
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
  /** 双面柜（岛台）的背面分区。给出即建 type='double'；row 柜不传 */
  backUnits?: UnitSpec[];
  /**
   * 垂直行（v0.3，P1 的形状；P3 起 AI 通道也走这里）。
   *
   * **1 行 = 塌回 units**（不写冗余 rows，与 v0.2 逐字节相同）；
   * ≥2 行 = 上下分层，行序自上而下。行 id 在这里生成（跨行累积 takenIds，
   * 撞 id 不报错只静默共用记录 —— 那是清单事故，不是小毛病）。
   */
  rows?: Array<{ height?: number | 'fill'; units: UnitSpec[] }>;
  /** 导入来源归属（P4）。从外部数据进来时由 Import 链路写入，authored 柜为 undefined */
  origin?: ImportOrigin;
  rules: RuleSet;
  takenIds?: Iterable<string>;
}): Cabinet {
  const base = defaultCabinetParams(opts.rules);
  const params: CabinetParams = {
    ...base,
    ...opts.params,
    backPanel: { ...base.backPanel, ...(opts.params?.backPanel ?? {}) },
  };
  let units = opts.units && opts.units.length > 0 ? opts.units : defaultUnits(params.width, opts.rules, params.depth);
  /**
   * 背面分区的 id 兜底：板件 id 是 `P_{cab}_{unit.id}_…` 拼出来的，
   * 前后排撞 id = 两块不同的板共用一条清单记录（生产下错料）。
   * 与 nextId 的 takenIds 铁条目同源：批量造对象先建 takenIds Set。
   */
  let backUnits: UnitSpec[] | undefined;
  if (opts.backUnits && opts.backUnits.length > 0) {
    const taken = new Set<string>(units.map((u) => u.id));
    backUnits = opts.backUnits.map((u) => {
      if (!taken.has(u.id)) {
        taken.add(u.id);
        return u;
      }
      const fixed = { ...u, id: nextId('unit', taken) };
      taken.add(fixed.id);
      return fixed;
    });
  }
  /**
   * 垂直行：只有真分了上下两层（≥2 行）才写 `rows`，1 行塌回 units ——
   * 形状判断只在 layoutModel 一家，这里是"构造时就不产出冗余形状"。
   */
  let rows: CabinetRow[] | undefined;
  if (opts.rows && opts.rows.length > 0) {
    const rowTaken = new Set<string>(units.map((u) => u.id));
    rows = opts.rows.map((r) => {
      const id = nextId('row', rowTaken);
      rowTaken.add(id);
      return { id, height: r.height ?? ROW_HEIGHT_FILL, units: r.units };
    });
    if (rows.length === 1) {
      // 单行：塌回，不留 rows（等价 v0.2 形状）
      units = rows[0]!.units.length > 0 ? rows[0]!.units : units;
      rows = undefined;
    } else {
      // 多行：units 留第一行的镜像（字段必填，存盘时由 toFileLayout 省略），
      // 读侧一律以 rows 为权威 —— 不会有人把第一行当成整柜。
      units = rows[0]!.units;
    }
  }

  return {
    id: opts.id ?? nextId('cab', opts.takenIds ?? []),
    name: opts.name,
    roomId: opts.roomId,
    placement: { x: Math.round(opts.x), y: Math.round(opts.y), rotation: opts.rotation ?? 0 },
    params,
    ...(opts.origin ? { origin: opts.origin } : {}),
    layout: {
      type: backUnits ? 'double' : 'row',
      widthMode: 'fit_total',
      units,
      ...(backUnits ? { backUnits } : {}),
      ...(rows ? { rows } : {}),
    },
  };
}

/**
 * 按柜型预设构造柜体 —— 模板机制的唯一解释点（Phase B）。
 *
 * 模板只是声明式骨架（见 core/templates.ts），真正的分区构造仍然全部
 * 走 makeUnit：五金从规则集挑、子规格一个不漏。模板不产生第二套构造
 * 逻辑，UI / AI / MCP / 命令行四条通道共用这一个入口。
 */
export function createCabinetFromTemplate(opts: {
  templateId: string;
  name?: string;
  roomId: string;
  x: number;
  y: number;
  rotation?: number;
  rules: RuleSet;
  takenIds?: Iterable<string>;
  id?: string;
  params?: Partial<CabinetParams>;
}): Cabinet {
  const tpl = findCabinetTemplate(opts.templateId);
  const widths = resolveTemplateUnitWidths(tpl);
  const units: UnitSpec[] =
    tpl.units.length === 0
      ? defaultUnits(tpl.params.width, opts.rules, tpl.params.depth)
      : tpl.units.map((u, i) =>
          makeUnit({
            id: `unit_${String(i + 1).padStart(3, '0')}`,
            kind: u.kind,
            requestedWidth: widths[i]!,
            nickname: u.nickname,
            rules: opts.rules,
            depth: tpl.params.depth,
            count: u.count,
            rodHeight: u.rodHeight,
            tilt: u.tilt,
            doors: u.doors ? { count: u.doors.count, hingeSide: u.doors.hingeSide } : undefined,
            appliance: u.appliance,
          })
        );
  // 双面模板：背面分区跟着构造，id 从前排之后接着排（takenIds 累积，撞 id 是清单事故）
  let backUnits: UnitSpec[] | undefined;
  if (tpl.backUnits && tpl.backUnits.length > 0) {
    const backWidths = resolveTemplateUnitWidthList(tpl.backUnits, tpl.params.width);
    const taken = new Set(units.map((u) => u.id));
    backUnits = tpl.backUnits.map((u, i) => {
      const unit = makeUnit({
        id: nextId('unit', taken),
        kind: u.kind,
        requestedWidth: backWidths[i]!,
        nickname: u.nickname,
        rules: opts.rules,
        // 双面柜每排箱体深 = (总深 - 板厚) / 2（中板居中，与 layout.ts 派生一致）
        depth: Math.floor((tpl.params.depth - (opts.rules.materials[defaultCabinetParams(opts.rules).boardMaterial]?.thickness ?? 18)) / 2),
        count: u.count,
        rodHeight: u.rodHeight,
        tilt: u.tilt,
        doors: u.doors ? { count: u.doors.count, hingeSide: u.doors.hingeSide } : undefined,
        appliance: u.appliance,
      });
      taken.add(unit.id);
      return unit;
    });
  }
  // 模板外形参数覆盖默认值；bodyLift 只有显式给了才覆盖（undefined 不许抹掉默认 80）
  const tplParams: Partial<CabinetParams> = {
    width: tpl.params.width,
    height: tpl.params.height,
    depth: tpl.params.depth,
  };
  if (tpl.params.bodyLift != null) tplParams.bodyLift = tpl.params.bodyLift;
  return createCabinet({
    id: opts.id,
    name: opts.name ?? tpl.name,
    roomId: opts.roomId,
    x: opts.x,
    y: opts.y,
    rotation: opts.rotation,
    rules: opts.rules,
    takenIds: opts.takenIds,
    params: { ...tplParams, ...opts.params },
    units,
    backUnits,
  });
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
   * 斜层板倾角（度）。仅 shelves 分区使用；由模板/AI/UI 透传，
   * 缺省 0（平层板，显式默认）。不靠"字段缺失"表达倾斜状态。
   */
  tilt?: number;
  /**
   * 灯带安装位。仅 shelves 分区使用；由模板/AI/UI 透传，
   * 缺省 'none'（不装，显式默认）。
   */
  ledStrip?: 'none' | 'center' | 'front' | 'angled45';
  /**
   * 门板。**必须在这里挂，不能在调用方自己拼 UnitSpec** ——
   * 本函数是"新分区的唯一构造点"，门板引用规则集里的 `pickHinge()`，
   * 调用方拿不到、也不该自己去挑铰链型号。
   * 风格预设（RuleSet.stylePresets）通过它给分区带门。
   */
  doors?: {
    count: number;
    gapMid?: number;
    gapOuter?: number;
    hingeSide?: 'left' | 'right';
    /** 门板材质 ID（引用 RuleSet.materials）；缺省 = 规则集默认门板材质 */
    material?: string;
  };
  /**
   * 仅 kind='appliance'：洞口与上下分体。**缺省值在这里显式补齐**
   * （洗衣机 650×850×600 洞 + 上面两抽），不留"字段缺失 = 状态不明"。
   */
  appliance?: {
    name?: string;
    openingWidth?: number;
    openingHeight?: number;
    openingDepth?: number;
    topDrawers?: number;
  };
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
        shelves: { count: clampInt(opts.count ?? 4, 1, 12), mode: 'equal', gapPerSide: 0.5, ledStrip: opts.ledStrip ?? 'none', tilt: opts.tilt ?? 0 },
      };
      break;
    case 'hanging':
      unit = {
        ...base,
        nickname,
        // 挂衣区自带一块顶层层板 —— 与 defaultUnits 的挂衣区结构一致
        rod: { count: 1, heightFromBottom: Math.round(opts.rodHeight ?? 1800), hardware: pickRod(opts.rules) },
        shelves: { count: 1, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none' },
      };
      break;
    case 'appliance': {
      const a = opts.appliance ?? {};
      const openingDepth = Math.round(a.openingDepth ?? Math.min(opts.depth ?? 600, 600));
      const spec: ApplianceSpec = {
        name: (a.name ?? '洗衣机').slice(0, 20),
        openingWidth: clampInt(a.openingWidth ?? 650, 200, 2000),
        openingHeight: clampInt(a.openingHeight ?? 850, 200, 3000),
        openingDepth,
        topDrawers: clampInt(a.topDrawers ?? 2, 0, 6),
      };
      unit = { ...base, nickname, appliance: spec };
      // 上下分体的"上"：洞口上面一排抽屉 —— 抽屉子规格直接挂在同分区上，
      // 生成器按"洞口以上净高"派生它们，清单/视图/恒等式同源。
      if (spec.topDrawers > 0) {
        const d = defaultDrawerSpec(opts.rules, opts.depth ?? 600);
        unit.drawers = { ...d, count: spec.topDrawers };
      }
      break;
    }
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
      hingeSide: opts.doors.hingeSide ?? 'left',
      material: opts.doors.material ?? pickDoorMaterial(opts.rules),
    };
  }
  return unit;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

export function defaultNickname(kind: UnitSpec['kind']): string {  switch (kind) {
    case 'drawerBank':
      return '抽屉';
    case 'hanging':
      return '挂衣';
    case 'shelves':
      return '层板';
    case 'appliance':
      return '电器格';
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
export function defaultUnits(width: number, rules: RuleSet, depth = 600): UnitSpec[] {
  if (width < 700) {
    return [makeUnit({ id: 'unit_001', kind: 'shelves', requestedWidth: width, rules, count: 3 })];
  }
  const a = Math.round(width * 0.25);
  const b = Math.round(width * 0.5);
  const c = width - a - b;
  return [
    makeUnit({ id: 'unit_001', kind: 'drawerBank', requestedWidth: a, rules, count: 3, depth }),
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
  /** 显式指定房间 ID（测试/夹具用；缺省自动分配） */
  id?: string;
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
  return createRoom({ id: opts.id, name: opts.name, walls, takenIds: opts.takenIds });
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
        shelves: { count: 1, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none' },
      },
      {
        id: 'unit_003',
        kind: 'shelves',
        requestedWidth: 600,
        nickname: '层板',
        shelves: { count: 4, mode: 'equal', gapPerSide: 0.5, ledStrip: 'none' },
        doors: {
          type: 'hinged',
          count: 2,
          mode: 'equal',
          style: 'inset',
          gapOuter: 2,
          gapMid: 3,
          hinge: pickHinge(rules),
          hingeSide: 'left',
          material: pickDoorMaterial(rules),
        },
      },
    ],
  });

  const project = emptyProject({ name: '示例户型', ruleSetId: rules.id, id: 'project_001' });
  project.rooms.push(room);
  project.cabinets.push(cabinet);
  return project;
}
