import type { Issue, Project } from '../types.ts';
import { buildIssue } from '../rules/issueCatalog.ts';
import { openingName, roomLoop } from './model.ts';
import { deriveSpatialFacts, type SpatialFacts } from './derive.ts';
import {
  DOOR_DIRECTION_ZH,
  DOOR_HINGE_ZH,
  deriveDoorSwing,
  type DoorClearanceFact,
  type DoorSwingFact,
} from './door.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  空间校验（P8.7）—— 把空间事实翻成结构化 issue（人话出自 issueCatalog）
 *
 *  只报空间层**独有**的问题，绝不重复 geometry 层已有的规则：
 *   - 柜体嵌墙 → RULE-CABINET-IN-WALL（geometry，硬错误）已覆盖；
 *     空间层不重复报，只把 touching/near/crossing 作为事实给出。
 *   - 这里报：墙退化 / 房间不成回路 / 回路自交折叠 / 洞口 span 非法 /
 *     柜在房间外 / 柜盖住洞口 / **柜在门扇开启范围内（P8.9）**。
 *
 *  全部只报事实与提示，**没有一条会给"自动移柜"式的修复** ——
 *  空间问题怎么解（挪柜 / 改墙 / 改洞口 / 换铰链侧）是设计决定。
 * ══════════════════════════════════════════════════════════════════════
 */

export interface SpatialReport {
  facts: SpatialFacts;
  /**
   * 门扇开启事实（P8.9）：铰链侧 / 开启朝向 / 判定的确定性包络（unknown 时无包络）。
   * 全部只读派生；没指定开启语义的门也在这里（status='unknown'），
   * 因为"用户还没说"本身就是一条要照实显示的事实。
   */
  doors: DoorSwingFact[];
  /** 柜体 ↔ 门扇扇区的净空判定（P8.9），与 doors 一一对应地展开到"每扇门 × 每只柜" */
  clearances: DoorClearanceFact[];
  issues: Issue[];
}

const PROBLEM_ZH: Record<string, string> = {
  open: '墙没有连成闭合回路（有断口）',
  dup: '回路里有重复顶点（两段墙接到同一个点又原地折回）',
  branch: '墙没有组成单一回路（有分支或多个独立的环）',
  selfx: '房间边界自相交（两段不相邻的墙互相穿过）',
};

export function deriveSpatial(project: Project): SpatialReport {
  const issues: Issue[] = [];

  // ── 墙 / 回路 / 洞口的结构问题 ──
  for (const room of project.rooms) {
    for (const w of room.walls) {
      if (w.start.x === w.end.x && w.start.y === w.end.y) {
        issues.push(
          buildIssue('SPATIAL-WALL-ZERO', {
            target: w.id,
            targetKind: 'project',
            ctx: { roomName: room.name, wallName: w.name },
          })
        );
      }
      if (w.openings) {
        const len = Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y);
        for (const o of w.openings) {
          if (o.offset < 0 || o.width <= 0 || o.offset + o.width > len) {
            issues.push(
              buildIssue('SPATIAL-OPENING-SPAN', {
                target: o.id,
                targetKind: 'project',
                ctx: {
                  roomName: room.name,
                  wallName: w.name,
                  openingName: openingName(o),
                  offset: o.offset,
                  width: o.width,
                  wallLen: Math.round(len),
                  over: Math.max(0, o.offset + o.width - Math.round(len)),
                  negOffset: o.offset < 0 ? o.offset : undefined,
                },
              })
            );
          }
        }
      }
    }
    const loop = roomLoop(room.walls);
    if (loop.status === 'open') {
      issues.push(
        buildIssue('SPATIAL-ROOM-OPEN', { target: room.id, targetKind: 'project', ctx: { roomName: room.name } })
      );
    } else if (loop.status !== 'ok' && loop.status !== 'empty') {
      issues.push(
        buildIssue('SPATIAL-ROOM-SHAPE', {
          target: room.id,
          targetKind: 'project',
          ctx: { roomName: room.name, what: PROBLEM_ZH[loop.status] ?? loop.status, kind: loop.status },
        })
      );
    }
  }

  const facts = deriveSpatialFacts(project);

  // ── 柜体 ↔ 房间 / 洞口 ──
  const roomById = new Map(project.rooms.map((r) => [r.id, r]));
  for (const cf of facts.cabinets) {
    const cab = project.cabinets.find((c) => c.id === cf.cabId);
    if (!cab) continue;
    if (cf.room === 'outside') {
      const room = roomById.get(cab.roomId);
      issues.push(
        buildIssue('SPATIAL-CABINET-OUTSIDE', {
          target: cab.id,
          targetKind: 'cabinet',
          ctx: { cabName: cab.name, roomName: room?.name ?? cab.roomId },
        })
      );
    }
    if (cf.openings.some((o) => o.relation === 'overlap')) {
      for (const o of cf.openings) {
        if (o.relation !== 'overlap') continue;
        // 找洞口所属墙/房间，报一条带人话定位的 ERROR
        for (const room of project.rooms) {
          for (const w of room.walls) {
            const op = w.openings?.find((x) => x.id === o.openingId);
            if (!op) continue;
            issues.push(
              buildIssue('SPATIAL-CABINET-OPENING', {
                target: cab.id,
                targetKind: 'cabinet',
                ctx: {
                  cabName: cab.name,
                  roomName: room.name,
                  wallName: w.name,
                  openingName: openingName(op),
                  kindZh: op.kind === 'door' ? '门洞' : '窗洞',
                  width: op.width,
                },
              })
            );
          }
        }
      }
    }
    // 柜体穿墙本身不在这里报：RULE-CABINET-IN-WALL（geometry 层）是唯一硬规则；
    // cf.walls 里的 crossing 事实供 UI / 上层组合消费（比如显示"这面墙被穿过"）。
  }

  // ── 门扇开启（P8.9）：柜体落在门扇扫过的扇区里 ──
  //
  // 与 SPATIAL-CABINET-OPENING 的分工（**不重复报**）：
  //   · CABINET-OPENING   = 柜体占了洞口本体 + 门口 600mm 通行带（P8.7，人流通道）；
  //   · CABINET-DOOR-SWING= 柜体落在**门扇真正扫过的 90° 扇区**里（门开不了）。
  //   一只柜可以只犯其中一条（贴着门垛站在扇区里但没挡通道，或反之），
  //   所以两条都要有；同一只柜同时犯两条时两条都报，各自说的是不同的事。
  //   unknown（没指定铰链/方向、房间不闭合、洞口非法）**不报 issue** ——
  //   判不出来就不说话；界面按 DOOR_UNKNOWN_ZH 显示"未指定/判不出"。
  const { doors, clearances } = deriveDoorSwing(project);
  const doorByKey = new Map(doors.map((d) => [`${d.wallId}|${d.openingId}`, d]));
  for (const c of clearances) {
    if (c.status !== 'overlap') continue; // touch 只是贴到扇区边界（由 TOUCH 容差定义，不算撞）
    const cab = project.cabinets.find((x) => x.id === c.cabinetId);
    const door = doorByKey.get(`${c.wallId}|${c.openingId}`);
    const env = door?.envelope;
    if (!cab || !door || !env) continue;
    const room = project.rooms.find((r) => r.id === door.roomId);
    const wall = room?.walls.find((w) => w.id === door.wallId);
    const op = wall?.openings?.find((o) => o.id === door.openingId);
    if (!room || !wall || !op) continue;
    issues.push(
      buildIssue('DESIGN-CABINET-DOOR-SWING', {
        target: cab.id,
        targetKind: 'cabinet',
        ctx: {
          cabName: cab.name,
          roomName: room.name,
          wallName: wall.name,
          openingName: openingName(op),
          width: op.width,
          hingeZh: DOOR_HINGE_ZH[op.hinge ?? 'start'],
          dirZh: DOOR_DIRECTION_ZH[op.swingDirection ?? 'into-room'],
          intrusion: c.intrusion ?? 0,
        },
      })
    );
  }

  return { facts, doors, clearances, issues };
}
