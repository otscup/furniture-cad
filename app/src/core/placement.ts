import type { Project } from './types.ts';
import { bboxOf, polyLocalToWorld, rectPts } from './geometry/transform.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  Deterministic Placement Engine（v0.3，P8.1）
 *
 *  PlacementIntent → validate → resolve → ResolvedPlacement
 *
 *  ── 它解决什么 ──
 *    AI / Vision / Import 只表达"想怎么放"（相邻、对齐、贴合），
 *    最终 x/y 必须由这里的纯函数算出来。AI 直接给坐标当最终位置，
 *    等于让没有墙坐标可看的一方去猜几何 —— 实测必然扎进墙里。
 *
 *  ── canonical source 不变 ──
 *    空间位置的真相源仍然是 `Cabinet.placement {x, y, rotation}`
 *    （types.ts，柜体背面左角 + 绕该点逆时针旋转角）。本模块**不新增**
 *    任何持久化位置字段：ResolvedPlacement 是管道里的中间产物，
 *    用户确认后经 CommandBus（op `cabinet.place`）写回 placement ——
 *    提交之后"解析结果"与"模型字段"是同一个值，不是两份真相。
 *
 *  ── authored 与 resolved 的分界 ──
 *    · authored absolute：用户显式给出的绝对坐标（界面拖动 / 属性面板 /
 *      MCP 显式输入 / 既有 `cabinet.move`）。这是**授权输入**，引擎只做
 *      取整与校验，不做"解析"。
 *    · resolved placement：由关系（adjacent / align）确定性算出。
 *      AI 的新接口（cabinet.place）只收语义关系，**不收坐标**；
 *      旧 `cabinet.move` 保留为兼容路径，但它属于 authored，不属于 resolved。
 *    两者在类型上就分开了（`origin: 'authored'` 是 absolute 分支的必填字段），
 *    不允许混在同一个字段里悄悄切换。
 *
 *  ── 纯函数纪律 ──
 *    不改 Semantic Model、不调 AI、不依赖 UI、不生成 DXF、不改 Geometry；
 *    同输入必同输出（无随机、无时钟、无浮点以外的隐藏状态）。
 *    旋转 bbox 用的是 geometry/transform.ts 的同一套 localToWorld
 *    （90° 吸附修正也在那里）—— 全项目只有一份旋转实现，这里不写第二份。
 *
 *  ── 与 Assembly 的分界 ──
 *    FurnitureAssembly/Connection 说的是"谁和谁是一组、怎么连"（语义关系，
 *    无坐标）；Placement 说的是"对象在哪"。两者可以关联（相邻落位后声明
 *    butt 连接很常见），但互不替代：有 assembly 不等于 A 一定在 B 右边。
 * ══════════════════════════════════════════════════════════════════════
 */

/** 落位关系（封闭词汇表，P8.1 只做确定性最强的三种） */
export type PlacementRelation = 'absolute' | 'adjacent' | 'align';

/**
 * 相邻方向 —— target 落在 reference 的哪一侧。
 * 方向名沿用柜体局部/世界约定：+X 宽（左→右）、+Y 深（背面→正面），
 * `front` = 门脸那一侧（+Y），`back` = 贴墙那一侧（Y 小的一端）。
 */
export type PlacementSide = 'left' | 'right' | 'front' | 'back';

/**
 * 对齐方式：
 *   `left`/`right` = 世界 X 上的左/右边缘齐平；
 *   `front`/`back` = 世界 Y 上的前/后边缘齐平；
 *   `center`       = 包围盒中心重合（X、Y 都对齐）。
 */
export type PlacementAlignment = 'left' | 'right' | 'front' | 'back' | 'center';

/** 引擎的输入快照：一只柜体的落位相关事实（从 Project 派生，只读） */
export interface PlacementSceneItem {
  id: string;
  x: number;
  y: number;
  rotation: number;
  width: number;
  depth: number;
}

export type PlacementScene = PlacementSceneItem[];

/**
 * 落位意图 —— 语义，不是坐标。
 *
 * · `absolute`：**authored** 显式坐标（用户/授权通道给的），引擎只校验+取整。
 *   `origin` 必须显式等于 `'authored'` —— 没有"缺省当 authored"这回事，
 *   缺了就是 INTENT-INVALID（防止 AI 输出被当成用户授权的绝对坐标）。
 * · `adjacent`：target 贴在 reference 的 `side` 一侧（面贴合，零缝隙）；
 *   `alignment` 控制共享轴上的对齐，缺省按行业惯例：并排（side=left/right）
 *   背面齐（'back'），前后叠（side=front/back）左缘齐（'left'）。
 * · `align`：只动一条轴，让 target 与 reference 的指定边缘/中心齐平；
 *   `alignment` 必填。
 *
 * 相邻（adjacent）本身就是 attach / touch（面贴合）—— 不再设第四个同义词。
 */
export type PlacementIntent =
  | {
      relation: 'absolute';
      targetId: string;
      x: number;
      y: number;
      rotation?: number;
      /** 必须显式 'authored'：绝对坐标只接受授权输入（见类注释"authored 与 resolved 的分界"） */
      origin: 'authored';
    }
  | {
      relation: 'adjacent';
      targetId: string;
      referenceId: string;
      side: PlacementSide;
      /** 并排（left/right）允许 back/front/center；前后（front/back）允许 left/right/center */
      alignment?: PlacementAlignment;
    }
  | {
      relation: 'align';
      targetId: string;
      referenceId: string;
      alignment: PlacementAlignment;
    };

/** 解析结果：整数 mm 的世界坐标 + 旋转角（deg）。可直接交给 `cabinet.place` 命令 */
export interface ResolvedPlacement {
  x: number;
  y: number;
  rotation: number;
}

/** 结构化错误码（引擎层，不进模型 issues —— 解析失败发生在模型写入之前） */
export type PlacementErrorCode =
  | 'PLACEMENT-TARGET-NOT-FOUND'
  | 'PLACEMENT-REFERENCE-NOT-FOUND'
  | 'PLACEMENT-SELF-REFERENCE'
  | 'PLACEMENT-CYCLE'
  | 'PLACEMENT-GEOMETRY-MISSING'
  | 'PLACEMENT-SIZE-INVALID'
  | 'PLACEMENT-INTENT-INVALID'
  | 'PLACEMENT-UNRESOLVED';

export interface PlacementError {
  code: PlacementErrorCode;
  /** 人话 + 具体数字（与 issueCatalog 同一态度：报错要给得出"差多少"） */
  message: string;
  targetId?: string;
  referenceId?: string;
}

export type PlacementResolve =
  | { ok: true; placement: ResolvedPlacement }
  | { ok: false; error: PlacementError };

/** 批量解析：全成或全不成（AI 计划原子性：一条被拒 → 整份不执行） */
export type PlacementBatchResolve =
  | { ok: true; resolved: Array<{ intent: PlacementIntent; placement: ResolvedPlacement }> }
  | { ok: false; error: PlacementError };

/** 各关系允许的对齐集合（封闭表；校验与报错都从这里读，不写第二份） */
export const ADJACENT_ALIGNMENTS: Record<PlacementSide, PlacementAlignment[]> = {
  left: ['back', 'front', 'center'],
  right: ['back', 'front', 'center'],
  front: ['left', 'right', 'center'],
  back: ['left', 'right', 'center'],
};
export const ADJACENT_DEFAULT_ALIGNMENT: Record<PlacementSide, PlacementAlignment> = {
  left: 'back',
  right: 'back',
  front: 'left',
  back: 'left',
};
export const ALIGN_ALIGNMENTS: PlacementAlignment[] = ['left', 'right', 'front', 'back', 'center'];
export const PLACEMENT_SIDES: PlacementSide[] = ['left', 'right', 'front', 'back'];

const fail = (code: PlacementErrorCode, message: string, targetId?: string, referenceId?: string): PlacementResolve => ({
  ok: false,
  error: { code, message, ...(targetId ? { targetId } : {}), ...(referenceId ? { referenceId } : {}) },
});

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * 落位包围盒：与 `getCabinetFootprint`（geometry/generate.ts）同一套变换原语
 * （rectPts + localToWorld，含 90° 三角函数吸附）。平移原点必平移包围盒 ——
 * 所以相邻/对齐全部表达成"位移增量"，对任意旋转角都成立，不需要分角度讨论。
 */
function footprintBox(it: PlacementSceneItem): { min: { x: number; y: number }; max: { x: number; y: number } } {
  return bboxOf(polyLocalToWorld(rectPts(0, 0, it.width, it.depth), { x: it.x, y: it.y }, it.rotation));
}

/** Project → 引擎快照。只读派生，不改动 project（width/depth 来自语义参数，非几何） */
export function sceneFromProject(project: Project): PlacementScene {
  return project.cabinets.map((c) => ({
    id: c.id,
    x: c.placement.x,
    y: c.placement.y,
    rotation: c.placement.rotation,
    width: c.params.width,
    depth: c.params.depth,
  }));
}

/** 单条意图的形状与取值校验（对不对项目无关的部分） */
function validateIntentShape(intent: PlacementIntent): PlacementError | null {
  if (!intent || typeof intent !== 'object') {
    return { code: 'PLACEMENT-INTENT-INVALID', message: '落位意图必须是一个对象' };
  }
  if (typeof intent.targetId !== 'string' || intent.targetId === '') {
    return { code: 'PLACEMENT-INTENT-INVALID', message: '落位意图缺 targetId（要放置哪个柜体）' };
  }
  if (intent.relation === 'absolute') {
    if (intent.origin !== 'authored') {
      return {
        code: 'PLACEMENT-INTENT-INVALID',
        message: `absolute 落位只接受显式授权输入（origin 必须为 'authored'），收到「${String(intent.origin)}」——AI 不得把绝对坐标当最终位置提交`,
        targetId: intent.targetId,
      };
    }
    if (!isFiniteNum(intent.x) || !isFiniteNum(intent.y)) {
      return {
        code: 'PLACEMENT-INTENT-INVALID',
        message: `absolute 落位的 x/y 必须是有限数字，收到 (${String(intent.x)}, ${String(intent.y)})`,
        targetId: intent.targetId,
      };
    }
    if (intent.rotation !== undefined && !isFiniteNum(intent.rotation)) {
      return {
        code: 'PLACEMENT-INTENT-INVALID',
        message: `absolute 落位的 rotation 必须是有限数字，收到 ${String(intent.rotation)}`,
        targetId: intent.targetId,
      };
    }
    return null;
  }
  if (intent.relation === 'adjacent' || intent.relation === 'align') {
    if (typeof intent.referenceId !== 'string' || intent.referenceId === '') {
      return { code: 'PLACEMENT-INTENT-INVALID', message: `${intent.relation} 落位缺 referenceId（参照哪个柜体）`, targetId: intent.targetId };
    }
    if (intent.relation === 'adjacent') {
      if (!PLACEMENT_SIDES.includes(intent.side)) {
        return {
          code: 'PLACEMENT-INTENT-INVALID',
          message: `adjacent 的 side 只能是 ${PLACEMENT_SIDES.join(' / ')}，收到「${String(intent.side)}」`,
          targetId: intent.targetId,
          referenceId: intent.referenceId,
        };
      }
      const allowed = ADJACENT_ALIGNMENTS[intent.side];
      const a = intent.alignment ?? ADJACENT_DEFAULT_ALIGNMENT[intent.side];
      if (!allowed.includes(a)) {
        return {
          code: 'PLACEMENT-INTENT-INVALID',
          message: `adjacent side=${intent.side} 的 alignment 只能是 ${allowed.join(' / ')}，收到「${String(intent.alignment)}」`,
          targetId: intent.targetId,
          referenceId: intent.referenceId,
        };
      }
      return null;
    }
    // align
    if (!ALIGN_ALIGNMENTS.includes(intent.alignment)) {
      return {
        code: 'PLACEMENT-INTENT-INVALID',
        message: `align 的 alignment 只能是 ${ALIGN_ALIGNMENTS.join(' / ')}，收到「${String(intent.alignment)}」`,
        targetId: intent.targetId,
        referenceId: intent.referenceId,
      };
    }
    return null;
  }
  return {
    code: 'PLACEMENT-INTENT-INVALID',
    message: `落位关系只支持 absolute / adjacent / align，收到「${String((intent as { relation?: unknown }).relation)}」`,
    targetId: typeof (intent as { targetId?: unknown }).targetId === 'string' ? (intent as { targetId: string }).targetId : undefined,
  };
}

/** 几何合法性：包围盒要算得出来（尺寸有限且为正） */
function checkGeometry(it: PlacementSceneItem): PlacementError | null {
  if (!isFiniteNum(it.x) || !isFiniteNum(it.y) || !isFiniteNum(it.rotation)) {
    return {
      code: 'PLACEMENT-GEOMETRY-MISSING',
      message: `柜体 ${it.id} 的落位数据不完整（x=${String(it.x)}, y=${String(it.y)}, rotation=${String(it.rotation)}），无法参与落位解析`,
      targetId: it.id,
    };
  }
  if (!isFiniteNum(it.width) || !isFiniteNum(it.depth) || it.width <= 0 || it.depth <= 0) {
    return {
      code: 'PLACEMENT-SIZE-INVALID',
      message: `柜体 ${it.id} 的尺寸非法（宽=${String(it.width)}, 深=${String(it.depth)}）——落位需要正的有限尺寸`,
      targetId: it.id,
    };
  }
  return null;
}

/**
 * 解析单条落位意图（纯函数）。
 *
 * 成功给出 `ResolvedPlacement`（整数 mm）；任何失败都返回结构化错误，
 * **绝不静默回退到 (0,0,0)** —— "失败放原点"会让柜体悄悄扎进墙里还装作成功。
 */
export function resolvePlacement(intent: PlacementIntent, scene: PlacementScene): PlacementResolve {
  const shapeErr = validateIntentShape(intent);
  if (shapeErr) return { ok: false, error: shapeErr };

  const target = scene.find((s) => s.id === intent.targetId);
  if (!target) {
    return fail(
      'PLACEMENT-TARGET-NOT-FOUND',
      `找不到要放置的柜体 ${intent.targetId}（场景里有 ${scene.length} 个柜体）`,
      intent.targetId
    );
  }

  if (intent.relation === 'absolute') {
    return {
      ok: true,
      placement: {
        x: Math.round(intent.x),
        y: Math.round(intent.y),
        rotation: Math.round(intent.rotation ?? target.rotation),
      },
    };
  }

  if (intent.targetId === intent.referenceId) {
    return fail('PLACEMENT-SELF-REFERENCE', `柜体 ${intent.targetId} 不能以自己为落位参照`, intent.targetId, intent.referenceId);
  }

  const reference = scene.find((s) => s.id === intent.referenceId);
  if (!reference) {
    return fail(
      'PLACEMENT-REFERENCE-NOT-FOUND',
      `找不到参照柜体 ${intent.referenceId}（场景里有 ${scene.length} 个柜体）`,
      intent.targetId,
      intent.referenceId
    );
  }

  const geomErr = checkGeometry(target) ?? checkGeometry(reference);
  if (geomErr) return { ok: false, error: geomErr };

  const tb = footprintBox(target);
  const rb = footprintBox(reference);
  // 位移增量：平移原点必平移包围盒，所以对任意 rotation 都成立
  let dx = 0;
  let dy = 0;

  if (intent.relation === 'adjacent') {
    const align: PlacementAlignment = intent.alignment ?? ADJACENT_DEFAULT_ALIGNMENT[intent.side];
    switch (intent.side) {
      case 'right': // target 左缘 = reference 右缘（面贴合，零缝隙）
        dx = rb.max.x - tb.min.x;
        break;
      case 'left':
        dx = rb.min.x - tb.max.x;
        break;
      case 'front': // target 背面 = reference 前脸（往 +Y 方向续）
        dy = rb.max.y - tb.min.y;
        break;
      case 'back': // target 前脸 = reference 背面（往 -Y 方向续）
        dy = rb.min.y - tb.max.y;
        break;
    }
    // 共享轴上的对齐
    if (intent.side === 'left' || intent.side === 'right') {
      if (align === 'back') dy = rb.min.y - tb.min.y;
      else if (align === 'front') dy = rb.max.y - tb.max.y;
      else dy = (rb.min.y + rb.max.y) / 2 - (tb.min.y + tb.max.y) / 2;
    } else {
      if (align === 'left') dx = rb.min.x - tb.min.x;
      else if (align === 'right') dx = rb.max.x - tb.max.x;
      else dx = (rb.min.x + rb.max.x) / 2 - (tb.min.x + tb.max.x) / 2;
    }
  } else {
    // align：只动指定的那条轴（center 动两条）
    switch (intent.alignment) {
      case 'left':
        dx = rb.min.x - tb.min.x;
        break;
      case 'right':
        dx = rb.max.x - tb.max.x;
        break;
      case 'front':
        dy = rb.max.y - tb.max.y;
        break;
      case 'back':
        dy = rb.min.y - tb.min.y;
        break;
      case 'center':
        dx = (rb.min.x + rb.max.x) / 2 - (tb.min.x + tb.max.x) / 2;
        dy = (rb.min.y + rb.max.y) / 2 - (tb.min.y + tb.max.y) / 2;
        break;
    }
  }

  return {
    ok: true,
    placement: {
      x: Math.round(target.x + dx),
      y: Math.round(target.y + dy),
      rotation: target.rotation,
    },
  };
}

/**
 * 批量解析（全成或全不成）。
 *
 * 依赖排序：一条意图的 reference 若也在本批被重新落位，必须先用**解析后**的
 * 新位置（"A 排 B 右边、C 排 A 右边"的连续拼接）。依赖成环（A 参照 B、
 * B 参照 A，两者都要重摆）没有确定性的先后可言 → 结构化 CYCLE 错误，
 * 列出成环的柜体，绝不按数组顺序碰运气。
 */
export function resolvePlacements(intents: PlacementIntent[], scene: PlacementScene): PlacementBatchResolve {
  // ① 逐条形状校验（任何一条非法 → 整批拒绝）
  for (const intent of intents) {
    const err = validateIntentShape(intent);
    if (err) return { ok: false, error: err };
  }

  // ② 依赖图：intent[i] 依赖 intent[j] ⇔ intents[j].targetId === intents[i].referenceId
  const byTarget = new Map<string, number[]>();
  intents.forEach((it, i) => {
    const list = byTarget.get(it.targetId) ?? [];
    list.push(i);
    byTarget.set(it.targetId, list);
  });
  const deps: number[][] = intents.map((it) => {
    if (it.relation === 'absolute') return [];
    if (it.referenceId === it.targetId) return []; // self-reference 留给单条解析给出更准的错误
    return byTarget.get(it.referenceId) ?? [];
  });
  // Kahn 拓扑排序（稳定：按输入序号取最小，保证同输入同输出）
  const inDeg = deps.map((d) => d.length);
  const dependents: number[][] = intents.map(() => []);
  deps.forEach((d, i) => {
    for (const j of d) dependents[j].push(i);
  });
  const ready: number[] = [];
  inDeg.forEach((d, i) => {
    if (d === 0) ready.push(i);
  });
  const order: number[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const i = ready.shift()!;
    order.push(i);
    for (const k of dependents[i]) {
      inDeg[k]--;
      if (inDeg[k] === 0) ready.push(k);
    }
  }
  if (order.length < intents.length) {
    const stuck = intents.filter((_, i) => !order.includes(i)).map((it) => it.targetId);
    return {
      ok: false,
      error: {
        code: 'PLACEMENT-CYCLE',
        message: `落位意图互相参照成环（涉及：${[...new Set(stuck)].join('、')}）—— 没有确定的先后，请拆成两批或改用绝对落位`,
      },
    };
  }

  // ③ 按依赖序解析；每条解析结果写进工作副本，供后续意图参照
  const working: PlacementScene = scene.map((s) => ({ ...s }));
  const resolved: Array<{ intent: PlacementIntent; placement: ResolvedPlacement }> = new Array(intents.length);
  for (const i of order) {
    const r = resolvePlacement(intents[i], working);
    if (!r.ok) return { ok: false, error: r.error };
    resolved[i] = { intent: intents[i], placement: r.placement };
    const t = working.find((s) => s.id === intents[i].targetId);
    if (t) {
      t.x = r.placement.x;
      t.y = r.placement.y;
      t.rotation = r.placement.rotation;
    }
  }
  return { ok: true, resolved };
}
