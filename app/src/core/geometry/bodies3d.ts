/**
 * ══════════════════════════════════════════════════════════════════════
 *  3D 体块派生 —— 语义模型的第三个视图（平面 / 图幅之后）。
 *
 *  ── 它是什么 ──
 *    从 CabinetDerived（派生骨架）现算一组轴对齐盒（中心 + 尺寸 + 柜体旋转），
 *    给 Three.js 渲染。与 2D 图元同一地位：**派生视图，永不写回模型**。
 *
 *  ── 为什么不是"把 Panel 清单摆进 3D" ──
 *    Panel 是清单级数据（长/宽/厚 + 数量），本来就没有单板摆放信息；
 *    而"摆放"在语义模型里由 layout 结构决定（层板位置 = equalSpacing(netH)，
 *    门宽 = doorWidths，分区起点 = unitX0）——这些都是**现算的派生骨架**。
 *    本文件消费同一份 computeCabinetLayout 结果，与 2D 生成器同源，不漂移。
 *
 *  ── 坐标约定 ──
 *    局部：+X 沿柜宽（左→右）、+Y 沿进深（背面→正面）、+Z 高度（0 = 地面）。
 *    与 transform.ts 的 localToWorld 一致（placement = 背面左角，逆时针 rot）。
 *    输出为世界坐标盒中心 + rot；Three 侧映射 three(x, z)=world(x, y)、
 *    three.y = world.z，rotation.y = -rot（右手系差异，验收探针核对）。
 * ══════════════════════════════════════════════════════════════════════
 */
import type { Cabinet, RuleSet, UnitSpec } from '../types.ts';
import { computeCabinetLayout, doorWidths, drawerCellHeights } from './layout.ts';
import { equalSpacing } from '../allocate.ts';
import { localToWorld } from './transform.ts';

export interface Box3D {
  id: string;
  cabId: string;
  cabName: string;
  role: BoxRole;
  nameZh: string;
  /** 盒中心的世界平面坐标（x, y）与高度 z */
  cx: number;
  cy: number;
  cz: number;
  /** 尺寸：沿柜宽 / 沿进深 / 高（mm） */
  sx: number;
  sy: number;
  sz: number;
  /** 柜体旋转角（deg，同 placement.rotation） */
  rot: number;
  /** 材质 ID —— 渲染层用它配色（不是模型材质，视觉分组用） */
  material: string;
}

export type BoxRole =
  | 'side'
  | 'top'
  | 'bottom'
  | 'back'
  | 'plinth'
  | 'divider'
  | 'shelf'
  | 'door'
  | 'drawer'
  | 'rod';

/**
 * 单柜 3D 体块。板厚/层板位/门宽全部来自 computeCabinetLayout 与
 * 2D 生成器同款的公式（equalSpacing / doorWidths / drawerCellHeights），
 * 不另立第二套算法。
 */
export function buildCabinetBodies(cab: Cabinet, rules: RuleSet): Box3D[] {
  const p = cab.params;
  const L = computeCabinetLayout(cab, rules);
  const t = L.boardT;
  const out: Box3D[] = [];
  const { x: ox, y: oy } = cab.placement;
  const rot = cab.placement.rotation;

  /** 局部盒（x0..x1, y0..y1, z0..z1）→ 世界中心盒 */
  const push = (role: BoxRole, id: string, nameZh: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, material: string): void => {
    const lcx = (x0 + x1) / 2;
    const lcy = (y0 + y1) / 2;
    const w = localToWorld({ x: lcx, y: lcy }, { x: ox, y: oy }, rot);
    out.push({
      id, cabId: cab.id, cabName: cab.name, role, nameZh,
      cx: w.x, cy: w.y, cz: (z0 + z1) / 2,
      sx: Math.round(x1 - x0), sy: Math.round(y1 - y0), sz: Math.round(z1 - z0),
      rot, material,
    });
  };

  const mat = p.boardMaterial;
  const zBot = p.bodyLift; // 箱体底
  const zTop = p.height; // 箱体顶

  // 箱体：左右侧板（全高 bodyH，深全深）
  push('side', `${cab.id}_LS`, '左侧板', 0, t, 0, p.depth, zBot, zTop, mat);
  push('side', `${cab.id}_RS`, '右侧板', p.width - t, p.width, 0, p.depth, zBot, zTop, mat);
  // 顶板 / 底板（长 innerW，夹在两块侧板之间）
  push('top', `${cab.id}_TOP`, '顶板', t, p.width - t, 0, p.depth, zTop - t, zTop, mat);
  push('bottom', `${cab.id}_BOT`, '底板', t, p.width - t, 0, p.depth, zBot, zBot + t, mat);
  // 背板（贴背面，全内宽全箱高）；双面柜没有背板 —— 中板 + 后踢脚替代
  const DB = L.double;
  if (DB) {
    push('back', `${cab.id}_MID`, '共用中板（双面）', t, p.width - t, DB.midY0, DB.midY0 + DB.midT, zBot, zTop, mat);
    if (p.bodyLift > 0) {
      push('plinth', `${cab.id}_KICKB`, '踢脚板-后', t, p.width - t, 0, t, 0, p.bodyLift, mat);
    }
  } else {
    push('back', `${cab.id}_BACK`, '背板', t, p.width - t, 0, L.backT, zBot, zTop, p.backPanel.material);
  }
  // 踢脚板（前脸底部，贴前边）
  if (p.bodyLift > 0) {
    push('plinth', `${cab.id}_KICK`, '踢脚板', t, p.width - t, p.depth - t, p.depth, 0, p.bodyLift, mat);
  }

  // 分区间中立板（全 innerH）
  for (let i = 0; i < cab.layout.units.length - 1; i++) {
    const x0 = L.unitX0[i] + L.nets[i];
    push('divider', `${cab.id}_DIV${i + 1}`, `中立板${i + 1}`, x0, x0 + t, DB ? DB.midY0 + DB.midT : 0, p.depth, zBot + t, zTop - t, mat);
  }
  if (DB) {
    cab.layout.backUnits!.forEach((_: UnitSpec, i: number) => {
      const x0 = DB.backUnitX0[i] + DB.backNets[i];
      push('divider', `${cab.id}_BDIV${i + 1}`, `中立板-后${i + 1}`, x0, x0 + t, 0, DB.midY0, zBot + t, zTop - t, mat);
    });
  }

  /** 一排分区的 3D 表达：层板/门/抽的 Y 区间由"这排的脸在哪"决定 */
  const drawRow = (
    units: UnitSpec[],
    netsRow: number[],
    x0s: number[],
    shelfY0: number,
    shelfY1: number,
    /** 门/抽面占据的 Y 区间（前排 = [depth, depth+t]，后排 = [-t, 0]） */
    faceY0: number,
    faceY1: number,
    /** 这排里电器格洞口之上的 Z 起点偏移（非电器格恒 0） */
    side: 'front' | 'back'
  ): void => {
    units.forEach((u: UnitSpec, i: number) => {
      const x0 = x0s[i];
      const netW = netsRow[i];
      const innerBottom = zBot + t; // 柜内底（底板上表面）
      const netH = u.kind === 'appliance' && u.appliance ? L.innerH - u.appliance.openingHeight - t : L.innerH;
      const zOffset = u.kind === 'appliance' && u.appliance ? u.appliance.openingHeight + t : 0;

      if (u.shelves && u.shelves.count > 0) {
        const sw = netW - 2 * u.shelves.gapPerSide;
        const sx0 = x0 + u.shelves.gapPerSide;
        equalSpacing(L.innerH, u.shelves.count).forEach((pos, k) => {
          // pos = 距柜内底的层板位置（与 Panel 清单同一 equalSpacing）
          push('shelf', `${cab.id}_${u.id}_SH${k + 1}`, `层板-${k + 1}`,
            sx0, sx0 + sw, shelfY0, shelfY1,
            innerBottom + pos - t / 2, innerBottom + pos + t / 2, mat);
        });
      }

      if (u.doors) {
        const dr = u.doors;
        const widths = doorWidths(u, netW, rules);
        const doorH = L.innerH - 2 * dr.gapOuter;
        let dx = x0 + dr.gapOuter;
        widths.forEach((w, k) => {
          push('door', `${cab.id}_${u.id}_DOOR${k + 1}`, `门板-${k + 1}`,
            dx, dx + w, faceY0, faceY1,
            zBot + t + dr.gapOuter, zBot + t + dr.gapOuter + doorH, mat);
          dx += w + dr.gapMid;
        });
      }

      if (u.drawers) {
        const d = u.drawers;
        const cellH = drawerCellHeights(u, netH, rules);
        let z = innerBottom + zOffset;
        cellH.forEach((ch, k) => {
          push('drawer', `${cab.id}_${u.id}_DF${k + 1}`, `抽屉面板-${k + 1}`,
            x0 + d.gap, x0 + netW - d.gap, faceY0, faceY1,
            z + d.gap, z + ch - d.gap, mat);
          z += ch;
        });
      }

      if (u.kind === 'appliance' && u.appliance) {
        // 电器本体：半透明感的"洞口占位盒"（甲购件，视觉上与柜体板区分）
        const a = u.appliance;
        const ow = Math.min(a.openingWidth, netW);
        const ax0 = x0 + (netW - ow) / 2;
        const od = Math.min(a.openingDepth, side === 'front' ? p.depth - t : DB ? DB.backRowDepth : p.depth - t);
        const ay0 = side === 'front' ? p.depth - od : 0;
        push('rod', `${cab.id}_${u.id}_APP`, `${a.name}（甲购）`,
          ax0, ax0 + ow, ay0, ay0 + od,
          innerBottom, innerBottom + Math.min(a.openingHeight, L.innerH), 'APPLIANCE_PLACEHOLDER');
      }

      if (u.rod && u.rod.count > 0) {
        // 挂衣杆用细长盒表达（圆柱渲染留给后续，视觉可辨即可）：
        // 沿柜宽横向、进深居中、离柜内底 rodHeight
        const rz = innerBottom + u.rod.heightFromBottom;
        const yMid = (shelfY0 + shelfY1) / 2;
        push('rod', `${cab.id}_${u.id}_ROD`, '挂衣杆',
          x0 + 30, x0 + netW - 30, yMid - 15, yMid + 15,
          rz - 15, rz + 15, mat);
      }
    });
  };

  // 前排：层板贴中板前表面（双面柜）或背板前表面（单面柜）
  drawRow(
    cab.layout.units,
    L.nets,
    L.unitX0,
    DB ? DB.midY0 + DB.midT : L.backT,
    DB ? DB.midY0 + DB.midT + L.shelfDepth : L.backT + L.shelfDepth,
    p.depth,
    p.depth + t,
    'front'
  );
  if (DB) {
    // 后排：脸在 y=0 侧（朝 -Y），门贴 y ∈ [-t, 0]
    drawRow(cab.layout.backUnits!, DB.backNets, DB.backUnitX0, DB.midY0 - DB.backShelfDepth, DB.midY0, -t, 0, 'back');
  }

  return out;
}

/** 全项目 3D 体块（多柜合并；单柜派生失败跳过该柜，不拖垮整张图 —— 与 2D 同策略） */
export function buildProjectBodies(project: { cabinets: Cabinet[] }, rules: RuleSet): Box3D[] {
  const out: Box3D[] = [];
  for (const cab of project.cabinets) {
    try {
      out.push(...buildCabinetBodies(cab, rules));
    } catch {
      // 材质缺失等单柜派生失败：跳过（issues 已在 2D 派生里报过，不重复报）
    }
  }
  return out;
}
