import type { Issue, Project } from '../types.ts';
import { validatePlacementDesign } from '../placementDesign.ts';
import { deriveSpatial, type SpatialReport } from '../spatial/index.ts';
import {
  fromPlacementFinding,
  type CabinetDesignView,
  type DesignValidationFinding,
  type DesignValidationReport,
  type DesignValidationStatus,
} from './model.ts';
import { describeOpeningProximity, describeWallContacts, verifyWallAttachment, type WallAttachDecl } from './interpret.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  Unified Design Validation（P8.8）—— 把两条既有链路合成一个回答
 *
 *      Semantic Model
 *            │
 *      Placement Resolver ──→ Placement Design Report（P8.3：柜间设计语义）
 *            │                                    │
 *            └──────────→ Spatial Report（P8.7：空间事实）──→ 组合（本文件）
 *                                                 │
 *                                          Unified Design Validation
 *
 *  ── 组合层的三条纪律 ──
 *    ① **只组合，不复制**：placement 的结论只来自 `validatePlacementDesign`，
 *      空间事实只来自 `deriveSpatial`，两条链路原样透传（`report.placement`
 *      / `report.spatial` 与单独调用逐字节相同 —— 验收 §2/§3 钉死）。
 *       本层唯一"新增"的是**解释**（`interpret.ts`：哪一面抵墙 / 门前余量 /
 *       声明与事实是否一致），它读事实、不重判事实。
 *    ② **纯函数**：不改 Model、不改 placement、不调 AI、不依赖 UI、
 *       不出几何 / DXF / BOM、无随机无时钟 —— 同输入必同输出（验收 §11）。
 *    ③ **不进主规则链**：设计验证是"把话说明白"的视图，不是硬规则。
 *       它**不**写进 CommandBus.deriveFor 的 issues（那里只有可阻断生产的硬规则），
 *       也绝不给任何"自动修复"按钮 —— 怎么解是设计决定。
 *
 *  ── 等级（§三：重新审查后的口径，唯一真相源仍是 issueCatalog）──
 *    ERROR（已证明非法）：与墙体重叠、声明贴墙而事实不符/面不符/缝不符
 *    WARNING（几何成立但可疑）：门脸朝墙、离墙有缝、没靠墙、门前余量、窗被挡
 *    没有"看起来不好"这类判不出规则的等级 —— 判不出来就不发。
 * ══════════════════════════════════════════════════════════════════════
 */

/** ISSUE 严重度 → 设计验证等级。INFO 不是设计有效性结论，直接不进 findings（与 P8.3 口径一致） */
const statusOfIssue = (i: Issue): 'warning' | 'error' | null => (i.severity === 'ERROR' ? 'error' : i.severity === 'WARNING' ? 'warning' : null);

/** 同一件事只留一条：同 (code, cabId, wallId, openingId) 的重复结论合并（语义解释层与验证器可能同时命中） */
function dedupe(list: DesignValidationFinding[]): DesignValidationFinding[] {
  const seen = new Set<string>();
  const out: DesignValidationFinding[] = [];
  for (const f of list) {
    const key = `${f.code}|${f.cabId ?? ''}|${f.wallId ?? ''}|${f.openingId ?? ''}|${f.sourceCode ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

const worst = (list: DesignValidationFinding[]): DesignValidationStatus =>
  list.some((f) => f.status === 'error') ? 'error' : list.length > 0 ? 'warning' : 'valid';

/**
 * 统一设计验证（纯函数）。
 *
 * @param opts.attach 显式「贴墙」声明（authored 输入，见 `interpret.WallAttachDecl`）。
 *        P8.8 不新增模型字段：谁想声明"这只柜应该靠墙"，就把声明传进来，
 *        验证结果与其它结论合并成同一份报告。
 */
export function validateDesign(project: Project, opts?: { attach?: WallAttachDecl[] }): DesignValidationReport {
  // ① 两条既有链路：原样取用，一个字段都不改
  const placement = validatePlacementDesign(project);
  const spatial: SpatialReport = deriveSpatial(project);

  // ② 解释层：事实 → 设计语义（不改事实）
  const wall = describeWallContacts(project, spatial.facts);
  const openings = describeOpeningProximity(project, spatial.facts);
  const attachFindings = (opts?.attach ?? []).flatMap((decl) => verifyWallAttachment(project, decl, spatial.facts).findings);

  // ③ 合并：placement 层结论 + spatial 层 issue + 解释层结论
  //
  // 空间 issue 的 target 可能是墙 / 洞口 / 房间（targetKind 都是 'project'），
  // 这里按 id **查一次**把归属还原出来 —— 界面要按柜体分组显示，光有 id 不够。
  const wallIds = new Set(project.rooms.flatMap((r) => r.walls.map((w) => w.id)));
  const openingIds = new Set(project.rooms.flatMap((r) => r.walls.flatMap((w) => (w.openings ?? []).map((o) => o.id))));
  const spatialFindings: DesignValidationFinding[] = [];
  for (const i of spatial.issues) {
    const status = statusOfIssue(i);
    if (!status) continue; // INFO 不是可判定结论
    const where = i.targetKind === 'cabinet' ? { cabId: i.target } : wallIds.has(i.target) ? { wallId: i.target } : openingIds.has(i.target) ? { openingId: i.target } : {};
    spatialFindings.push({
      layer: 'spatial',
      status,
      code: i.code,
      message: i.message,
      ...(i.fixHint !== undefined ? { hint: i.fixHint } : {}),
      ...where,
      sourceCode: i.code,
    });
  }

  const findings = dedupe([
    ...placement.findings.map(fromPlacementFinding),
    ...spatialFindings,
    ...wall.findings,
    ...openings,
    ...attachFindings,
  ]);

  // ④ 按柜体分组（界面「空间检查」区直接消费）
  const cabinets: CabinetDesignView[] = project.cabinets.map((cab) => {
    const room = project.rooms.find((r) => r.id === cab.roomId);
    const cf = spatial.facts.cabinets.find((c) => c.cabId === cab.id);
    return {
      cabId: cab.id,
      cabName: cab.name,
      roomId: cab.roomId,
      roomName: room?.name ?? cab.roomId,
      room: cf?.room ?? 'unknown',
      contacts: wall.contacts.filter((c) => c.cabId === cab.id),
      // 只放**明确挂在这只柜上**的结论：房间/墙/洞口自身的结构问题（不成回路、
      // 洞口 span 非法…）不属于任何柜，混进每只柜的视图会让用户以为是柜的问题。
      findings: findings.filter((f) => f.cabId === cab.id),
    };
  });

  return {
    status: worst(findings),
    placement,
    spatial,
    // 门扇开启（P8.9）：**原样**引用空间层的派生结果，组合层不重判一次。
    doorSwing: { doors: spatial.doors, clearances: spatial.clearances },
    findings,
    counts: {
      error: findings.filter((f) => f.status === 'error').length,
      warning: findings.filter((f) => f.status === 'warning').length,
    },
    wallContacts: wall.contacts,
    cabinets,
  };
}

/** 单只柜体的设计视图（找不到就返回 null，界面据此显示"对象已不存在"） */
export function designViewFor(report: DesignValidationReport, cabId: string): CabinetDesignView | null {
  return report.cabinets.find((c) => c.cabId === cabId) ?? null;
}
