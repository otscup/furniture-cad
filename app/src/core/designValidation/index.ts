/**
 * 统一设计验证层（P8.8）—— Placement 设计语义 + 空间事实 + 语义解释，合一个回答。
 *
 * 对外只暴露四个入口：
 *  - validateDesign(project, opts?)   → DesignValidationReport（组合层，唯一入口）
 *  - designViewFor(report, cabId)     → 单柜视图（界面「空间检查」区消费）
 *  - verifyWallAttachment(project, decl, facts?) → 声明的「贴墙」与事实是否一致
 *  - 类型与阈值：DESIGN_TOL / WallContactKind / WALL_CONTACT_ZH / WallAttachDecl
 *
 * 本层**不做**：自动布局、自动贴墙、自动修复、门扇开启模拟、人流分析、DXF/BIM/Z 轴。
 */
export { validateDesign, designViewFor } from './validate.ts';
export {
  contactFaceOf,
  describeOpeningProximity,
  describeWallContacts,
  nearestWallDistance,
  verifyWallAttachment,
  wallContactKind,
  FACE_ZH,
  type WallAttachDecl,
  type WallAttachFact,
  type WallAttachVerdict,
} from './interpret.ts';
export {
  DESIGN_TOL,
  WALL_CONTACT_ZH,
  wallContactZh,
  fromPlacementFinding,
  type CabinetDesignView,
  type DesignValidationFinding,
  type DesignValidationLayer,
  type DesignValidationReport,
  type DesignValidationStatus,
  type WallContactFact,
  type WallContactKind,
} from './model.ts';
