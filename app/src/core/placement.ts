import type { Cabinet, ConnectionEdge, Project, Vec2 } from './types.ts';
import { bboxOf, localToWorld, polyLocalToWorld, rectPts } from './geometry/transform.ts';
// 面名 ↔ 几何边的映射**只从 relations.ts 借**：P2 已经为 Connection 声明
// 定死了"第几条边叫 back/right/front/left"（EDGE_ORDER）。Attach 的面语义若
// 再抄一份，就会出现"声明的 right"与"几何的 right"各指一条边 —— 那正是
// relations.ts 文件头记着的第二类真相源。这里只借常量，不借它的接触算法。
import { EDGE_ORDER } from './relations.ts';

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
 *    · resolved placement：由关系（adjacent / align / attach）确定性算出。
 *      attach（P8.2）说清"哪两个面贴在一起"——两个面各有其名、参与计算，
 *      朝向对不上就是贴合不了（报 FACE-NOT-OPPOSING），不会退化成相邻。
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

/**
 * 落位关系（封闭词汇表）
 * · P8.1：absolute / adjacent / align
 * · P8.2：attach —— **面接触**：target 的指定面与 reference 的指定面贴合
 */
export type PlacementRelation = 'absolute' | 'adjacent' | 'align' | 'attach';

/**
 * 可参与贴合的面 = P2 的 `ConnectionEdge`（back/front/left/right）—— 同一套语义面，
 * 不另起一套面词汇。P8.2 只做 XY 四个**垂直面**：top / bottom 需要 Z，本阶段没有。
 */
export type PlacementFace = ConnectionEdge;

/**
 * 接触面上的对齐（沿面自身的自然方向）：
 *   `start`  = 两端里起始端对齐（左右面＝背面端，前后端面＝左端）
 *   `center` = 面中心对齐
 *   `end`    = 末端对齐
 * 缺省是 `start`（与 adjacent 的"并排背面齐 / 前后左缘齐"同惯例）—— **不是**隐式 center。
 */
export type AttachAlignment = 'start' | 'center' | 'end';

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
    }
  | {
      /**
       * attach（P8.2）：target 的 `targetFace` 面 与 reference 的 `referenceFace` 面
       * **真正贴合** —— 不是"相邻 + 缝隙 0"的另一个说法：两个面各自有名有姓，
       * 解析按"两个面所在平面重合"来算，面朝向对不上（比如 right ↔ right）
       * 是几何上不可能贴合，直接报 FACE-NOT-OPPOSING，不静默退化成相邻。
       */
      relation: 'attach';
      targetId: string;
      referenceId: string;
      targetFace: PlacementFace;
      referenceFace: PlacementFace;
      /** 沿接触面自然方向的对齐；缺省 start（不隐式取 center） */
      alignment?: AttachAlignment;
      /** 缝隙（mm）：只沿 reference 外法线方向偏移，0 = 真正贴合；负数（重叠）拒收 */
      offset?: number;
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
  | 'PLACEMENT-FACE-NOT-OPPOSING'
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

/** 可贴合的面：**直接取 P2 的 EDGE_ORDER** —— 面词汇与面↔边映射都不许有第二份 */
export const PLACEMENT_FACES: PlacementFace[] = [...EDGE_ORDER];
export const ATTACH_ALIGNMENTS: AttachAlignment[] = ['start', 'center', 'end'];
/** attach 的缺省对齐：起始端齐（与 adjacent 的并排背面齐 / 前后左缘齐同惯例） */
export const ATTACH_DEFAULT_ALIGNMENT: AttachAlignment = 'start';

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

/** Cabinet → 引擎快照项（只读派生，不动模型） */
export function sceneItemOf(cab: Cabinet): PlacementSceneItem {
  return {
    id: cab.id,
    x: cab.placement.x,
    y: cab.placement.y,
    rotation: cab.placement.rotation,
    width: cab.params.width,
    depth: cab.params.depth,
  };
}

/** Project → 引擎快照。只读派生，不改动 project（width/depth 来自语义参数，非几何） */
export function sceneFromProject(project: Project): PlacementScene {
  return project.cabinets.map(sceneItemOf);
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
  if (intent.relation === 'adjacent' || intent.relation === 'align' || intent.relation === 'attach') {
    if (typeof intent.referenceId !== 'string' || intent.referenceId === '') {
      return { code: 'PLACEMENT-INTENT-INVALID', message: `${intent.relation} 落位缺 referenceId（参照哪个柜体）`, targetId: intent.targetId };
    }
    if (intent.relation === 'attach') {
      for (const [who, val] of [['targetFace', intent.targetFace], ['referenceFace', intent.referenceFace]] as const) {
        if (!PLACEMENT_FACES.includes(val)) {
          return {
            code: 'PLACEMENT-INTENT-INVALID',
            message: `attach 的 ${who} 只能是 ${PLACEMENT_FACES.join(' / ')} 四个垂直面（top / bottom 需要 Z 坐标，本阶段不做），收到「${String(val)}」`,
            targetId: intent.targetId,
            referenceId: intent.referenceId,
          };
        }
      }
      const a = intent.alignment ?? ATTACH_DEFAULT_ALIGNMENT;
      if (!ATTACH_ALIGNMENTS.includes(a)) {
        return {
          code: 'PLACEMENT-INTENT-INVALID',
          message: `attach 的 alignment 只能是 ${ATTACH_ALIGNMENTS.join(' / ')}，收到「${String(intent.alignment)}」`,
          targetId: intent.targetId,
          referenceId: intent.referenceId,
        };
      }
      if (intent.offset !== undefined && (!isFiniteNum(intent.offset) || intent.offset < 0)) {
        return {
          code: 'PLACEMENT-INTENT-INVALID',
          message: `attach 的 offset 必须是 ≥ 0 的数字（缝隙 mm；负数是重叠，重叠属于碰撞不由落位层造），收到 ${String(intent.offset)}`,
          targetId: intent.targetId,
          referenceId: intent.referenceId,
        };
      }
      return null;
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
    message: `落位关系只支持 absolute / adjacent / align / attach，收到「${String((intent as { relation?: unknown }).relation)}」`,
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

const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
const fmtVec = (v: Vec2): string => `${Math.round(v.x * 1000) / 1000}, ${Math.round(v.y * 1000) / 1000}`;

/**
 * 一个空间面在世界坐标下的事实：外法线 + 自然方向上的起点/终点。
 *
 * ── 为什么"自然方向"要规定 ──
 *   start / end 对齐必须有唯一读法：左右面沿进深读（背面→正面），
 *   前后端面沿宽读（左端→右端）。这个方向**从边自身的轴向推出来**
 *   （|dx| ≥ |dy| ⇒ 沿宽），不写第二张"哪个面朝哪"的表。
 *
 * ── 为什么外法线也推 ──
 *   面中点 − 体中心，矩形局部边轴对齐，减出来就是纯法向。旋转仍走
 *   transform.ts 的 `localToWorld`（全项目唯一旋转实现），这里没有第二套三角函数。
 */
export function faceSegmentOf(it: PlacementSceneItem, face: PlacementFace): { normal: Vec2; start: Vec2; end: Vec2 } {
  const local = rectPts(0, 0, it.width, it.depth);
  const i = EDGE_ORDER.indexOf(face);
  const p0 = local[i]!;
  const p1 = local[(i + 1) % 4]!;
  const axis: Vec2 = Math.abs(p1.x - p0.x) >= Math.abs(p1.y - p0.y) ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const t0 = dot2(p0, axis);
  const t1 = dot2(p1, axis);
  const startLocal = t0 <= t1 ? p0 : p1;
  const endLocal = t0 <= t1 ? p1 : p0;
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const center = { x: it.width / 2, y: it.depth / 2 };
  const nl = { x: mid.x - center.x, y: mid.y - center.y };
  const len = Math.hypot(nl.x, nl.y) || 1;
  const origin = { x: it.x, y: it.y };
  return {
    normal: localToWorld({ x: nl.x / len, y: nl.y / len }, { x: 0, y: 0 }, it.rotation),
    start: localToWorld(startLocal, origin, it.rotation),
    end: localToWorld(endLocal, origin, it.rotation),
  };
}

/**
 * 一个面的**外法线**（单位向量，世界坐标）—— 全项目唯一的"面朝向"实现。
 *
 * 设计语义层（P8.3）要判断"门脸朝哪"，只能从这里取，不许自己再写一遍
 * 旋转：多一份实现就多一处"界面说朝左、清单说朝右"的机会。
 */
export function faceDirectionOf(it: PlacementSceneItem, face: PlacementFace): Vec2 {
  return faceSegmentOf(it, face).normal;
}

/**
 * 柜体某个面朝世界的哪个方向 —— **由 rotation 派生**，不新增语义字段。
 *
 * 为什么不加 `Cabinet.facing` 之类的字段：它和 rotation 是同一件事的两种写法，
 * 写进模型就是第二份真相（改了 rotation 忘了改 facing，系统就会自相矛盾）。
 * 需要朝向时派生即可，派生的东西不会与模型不一致。
 */
export function faceDirection(cab: Cabinet, face: PlacementFace): Vec2 {
  return faceDirectionOf(sceneItemOf(cab), face);
}
/** 门脸（正面）朝向 */
export const frontDirection = (cab: Cabinet): Vec2 => faceDirection(cab, 'front');
/** 背面（贴墙侧）朝向 */
export const backDirection = (cab: Cabinet): Vec2 => faceDirection(cab, 'back');
/** 左端朝向 */
export const leftDirection = (cab: Cabinet): Vec2 => faceDirection(cab, 'left');
/** 右端朝向 */
export const rightDirection = (cab: Cabinet): Vec2 => faceDirection(cab, 'right');

/**
 * attach 解析（纯函数）：两个**有名有姓的面**贴合。
 *
 * ① 两面必须朝向相对（外法线反向平行）—— right ↔ right 这种在几何上不可能贴合，
 *    报 FACE-NOT-OPPOSING，绝不退化成"那就相邻着放吧"。
 * ② 法向：target 的面平面 = reference 的面平面 + offset（沿 reference 外法线外推）。
 * ③ 切向：沿接触面自然方向做 start / center / end 对齐。
 * 一切表达成**位移增量**（平移原点必平移整只柜），对任意合法 rotation 都成立，
 * 不需要按角度分情况讨论。
 */
function resolveAttach(
  target: PlacementSceneItem,
  reference: PlacementSceneItem,
  targetFace: PlacementFace,
  referenceFace: PlacementFace,
  align: AttachAlignment,
  offset: number
): PlacementResolve {
  const T = faceSegmentOf(target, targetFace);
  const R = faceSegmentOf(reference, referenceFace);
  const facing = dot2(T.normal, R.normal);
  if (facing > -1 + 1e-9) {
    const angle = Math.round((Math.acos(Math.min(1, Math.max(-1, -facing))) * 180) / Math.PI);
    return fail(
      'PLACEMENT-FACE-NOT-OPPOSING',
      `柜体 ${target.id} 的 ${targetFace} 面（世界朝向 ${fmtVec(T.normal)}）与柜体 ${reference.id} 的 ${referenceFace} 面（世界朝向 ${fmtVec(R.normal)}）不是相对的两个面 —— 两面夹角 ${angle}°，贴合不了（可贴合的相对面：left↔right、right↔left、front↔back、back↔front，且两柜相对旋转须是 90° 的整数倍）`,
      target.id,
      reference.id
    );
  }

  const nR = R.normal;
  const along = dot2(R.start, nR) + offset - dot2(T.start, nR);

  const tv = { x: T.end.x - T.start.x, y: T.end.y - T.start.y };
  const tl = Math.hypot(tv.x, tv.y) || 1;
  const tHat = { x: tv.x / tl, y: tv.y / tl };
  const pT0 = dot2(T.start, tHat);
  const pT1 = dot2(T.end, tHat);
  const pR0 = dot2(R.start, tHat);
  const pR1 = dot2(R.end, tHat);
  const loT = Math.min(pT0, pT1);
  const hiT = Math.max(pT0, pT1);
  const loR = Math.min(pR0, pR1);
  const hiR = Math.max(pR0, pR1);
  const shift =
    align === 'start' ? loR - loT : align === 'end' ? hiR - hiT : (loR + hiR) / 2 - (loT + hiT) / 2;

  return {
    ok: true,
    placement: {
      x: Math.round(target.x + along * nR.x + shift * tHat.x),
      y: Math.round(target.y + along * nR.y + shift * tHat.y),
      rotation: target.rotation,
    },
  };
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

  // attach 走真实面平面（不走包围盒）：bbox 对旋转过的柜是放大了的近似，
  // 而"两个面贴合"要的是精确的面平面 —— 轴对齐时两者一致，旋转时只有面平面是对的。
  if (intent.relation === 'attach') {
    return resolveAttach(
      target,
      reference,
      intent.targetFace,
      intent.referenceFace,
      intent.alignment ?? ATTACH_DEFAULT_ALIGNMENT,
      intent.offset ?? 0
    );
  }

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
