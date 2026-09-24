/**
 * ══════════════════════════════════════════════════════════════════════
 *  PickLine —— 几何 → 语义的反查层（设计文档《Local-Pick-Edit》§2.2，A1/A4）
 *
 *  ── 为什么这一层必须存在 ──
 *    模型里没有任何"线"这个对象（铁律：拖动 = 改语义参数，严禁改线条）。
 *    "点选这条线让 AI 把它挪 50mm"不能做 —— 那是引入第二真相源。
 *    能做的是：点到的线 → 解析成 { cabinetId, part, paramPath }，
 *    AI 改的永远是语义参数，几何重新派生。
 *
 *  ── 为什么由视图生成器调用，而不是"事后反查" ──
 *    事后反查 = 另写一份判定逻辑，会和生成器漂移，两边一起错就永远发现不了。
 *    本模块只消费与画图**同一份**派生骨架（computeCabinetLayout 的结果），
 *    且由 views.ts 在生成正视图图元的同一处调用 —— 同源，不漂移。
 *
 *  ── 部件词汇表是闭合的（6 类）──
 *    外轮廓（宽/高）、踢脚线、分区线、门缝、层板线、抽屉分格线。
 *    定得太细，词汇表会膨胀到模型选不对 —— 与 18 个动作的取舍是同一件事。
 *
 *  ── AI 收到什么 ──
 *    永远是 { cabinetId, part, paramPath }，永远收不到坐标。
 *    paramPath 就是 AI 最终要改的那条写路径（CommandBus 白名单内）。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Cabinet, Vec2, CabinetDerived, RuleSet } from '../types.ts';
import { equalSpacing } from '../allocate.ts';
import { drawerCellHeights } from './layout.ts';

/** 语义部件：闭合词汇表，契约与编译器都按这份清单校验 */
export type CabinetPart =
  | 'outer.width' // 左右最外轮廓（= 柜宽）
  | 'outer.height' // 上下最外轮廓（= 柜高）
  | 'bodyLift' // 踢脚线
  | 'unit.divider' // 分区之间的中立板竖线
  | 'door.gapMid' // 门扇之间的中缝
  | 'shelf.line' // 层板线
  | 'drawer.divider'; // 抽屉分格线

export const PART_ZH: Record<CabinetPart, string> = {
  'outer.width': '左右外轮廓（柜宽）',
  'outer.height': '上下外轮廓（柜高）',
  'bodyLift': '踢脚线',
  'unit.divider': '分区中立板',
  'door.gapMid': '门扇中缝',
  'shelf.line': '层板线',
  'drawer.divider': '抽屉分格线',
};

/** 每个部件"由哪个参数决定"的映射 —— 编译器用它校验 AI 改的路径与部件一致 */
export function partParamPath(part: CabinetPart, unitIndex: number): string {
  switch (part) {
    case 'outer.width':
      return 'params.width';
    case 'outer.height':
      return 'params.height';
    case 'bodyLift':
      return 'params.bodyLift';
    case 'unit.divider':
      return `layout.units[${unitIndex}].requestedWidth`;
    case 'door.gapMid':
      return `layout.units[${unitIndex}].doors.gapMid`;
    case 'shelf.line':
      return `layout.units[${unitIndex}].shelves.count`;
    case 'drawer.divider':
      return `layout.units[${unitIndex}].drawers.count`;
  }
}

export interface PickLine {
  /** 线画在哪个视图里（正视图上的线和内部图上的层板线不是一回事） */
  view: 'front' | 'internal';
  cabinetId: string;
  part: CabinetPart;
  /** 部件落在哪个分区上（外轮廓/踢脚类为 0）—— 界面显示与编译校验都用 */
  unitIndex: number;
  /** AI 最终改的写路径 */
  paramPath: string;
  labelZh: string;
  /** 图元上的点（图幅绝对坐标），用于命中测试 */
  pts: Vec2[];
}

/** 一个柜体上"到底存在哪些可点部件"的语义清单 —— 编译器校验 part 是否仍然存在就靠它 */
export function pickPartsOf(cab: Cabinet): Array<{ part: CabinetPart; unitIndex: number; paramPath: string; labelZh: string }> {
  const out: Array<{ part: CabinetPart; unitIndex: number; paramPath: string; labelZh: string }> = [];
  const push = (part: CabinetPart, unitIndex: number): void => {
    out.push({ part, unitIndex, paramPath: partParamPath(part, unitIndex), labelZh: PART_ZH[part] });
  };
  push('outer.width', 0);
  push('outer.height', 0);
  push('bodyLift', 0);
  for (let i = 0; i < cab.layout.units.length - 1; i++) push('unit.divider', i);
  cab.layout.units.forEach((u, i) => {
    if (u.doors && u.doors.count > 1) push('door.gapMid', i);
    if (u.shelves && u.shelves.count > 0) push('shelf.line', i);
    if (u.drawers && u.drawers.count > 1) push('drawer.divider', i);
  });
  return out;
}

type Mapper = (a: number, b: number) => Vec2;

/**
 * 生成正视图（+ 内部结构图）的 PickLine 表。
 *
 * 由 views.ts 在画正视图图元的同一处调用：mapper 传的就是画图用的那对，
 * 点位与图元逐位一致 —— 命中测试命中的就是屏幕上看得见的那条线。
 */
export function buildFrontPickLines(
  cab: Cabinet,
  L: CabinetDerived,
  rules: RuleSet,
  mapFront: Mapper,
  mapInt: Mapper
): PickLine[] {
  const out: PickLine[] = [];
  const add = (view: PickLine['view'], part: CabinetPart, unitIndex: number, pts: Vec2[]): void => {
    out.push({ view, cabinetId: cab.id, part, unitIndex, paramPath: partParamPath(part, unitIndex), labelZh: PART_ZH[part], pts });
  };
  const W = cab.params.width;
  const H = cab.params.height;
  const bodyLift = cab.params.bodyLift;
  const t = L.boardT;
  const innerBottomZ = bodyLift + t;
  const innerTopZ = H - t;
  const innerH = L.innerH;
  const nets = L.nets;
  const unitX0 = L.unitX0;
  const units = cab.layout.units;

  // 外轮廓（正视图）：左右边 = 柜宽，上下边 = 柜高
  add('front', 'outer.width', 0, [mapFront(0, 0), mapFront(0, H)]);
  add('front', 'outer.width', 0, [mapFront(W, 0), mapFront(W, H)]);
  add('front', 'outer.height', 0, [mapFront(0, 0), mapFront(W, 0)]);
  add('front', 'outer.height', 0, [mapFront(0, H), mapFront(W, H)]);
  // 踢脚线：踢脚区的顶边
  add('front', 'bodyLift', 0, [mapFront(0, bodyLift), mapFront(W, bodyLift)]);
  // 分区中立板的竖线（内空段）
  for (let i = 0; i < units.length - 1; i++) {
    const x = unitX0[i] + nets[i];
    add('front', 'unit.divider', i, [mapFront(x, innerBottomZ), mapFront(x, innerTopZ)]);
  }
  // 门扇中缝（正视图上有门的分区）
  units.forEach((u, i) => {
    if (!u.doors || u.doors.count <= 1) return;
    const x0 = unitX0[i];
    const x1 = x0 + nets[i];
    const z0 = innerBottomZ + u.doors.gapOuter;
    const z1 = innerBottomZ + innerH - u.doors.gapOuter;
    for (let k = 1; k < u.doors.count; k++) {
      const xk = x0 + ((x1 - x0) * k) / u.doors.count;
      add('front', 'door.gapMid', i, [mapFront(xk, z0), mapFront(xk, z1)]);
    }
  });
  // 层板线 / 抽屉分格线画在内部结构图里（正视图上被门板挡住，点它就是自欺）
  units.forEach((u, i) => {
    const x0 = unitX0[i];
    const x1 = x0 + nets[i];
    if (u.shelves && u.shelves.count > 0) {
      for (const pos of equalSpacing(innerH, u.shelves.count)) {
        const z = innerBottomZ + pos;
        add('internal', 'shelf.line', i, [mapInt(x0, z), mapInt(x1, z)]);
      }
    }
    if (u.drawers && u.drawers.count > 1) {
      // 分格边界 = 上一格的顶面 + 让位缝（与 views.ts 侧视图/内部图画格的方式同一套推进）
      const cellH = drawerCellHeights(u, innerH, rules);
      let z = innerBottomZ + u.drawers.gap;
      for (let k = 0; k < cellH.length - 1; k++) {
        z += cellH[k];
        add('internal', 'drawer.divider', i, [mapInt(x0, z), mapInt(x1, z)]);
        z += u.drawers.gap;
      }
    }
  });
  return out;
}
