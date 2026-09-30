/**
 * 统一设计验证层（P8.8 + P8.9 门扇开启）—— Placement 设计语义 + 空间事实 + 语义解释，合一个回答。
 *
 * 对外只暴露：
 *  - validateDesign(project, opts?)   → DesignValidationReport（组合层，唯一入口）
 *  - designViewFor(report, cabId)     → 单柜视图（界面「空间检查」区消费）
 *  - verifyWallAttachment(project, decl, facts?) → 声明的「贴墙」与事实是否一致
 *  - 类型与阈值：DESIGN_TOL / WallContactKind / WALL_CONTACT_ZH / WallAttachDecl
 *    / DoorSwingReport（P8.9：门扇开启事实与柜体净空，原样来自空间层）
 *
 * 本层**不做**：自动布局、自动贴墙、自动修复、门开启动画/3D 门扇、
 * 任意开启角度、人流分析、DXF/BIM/Z 轴。门扇开启的**判定**在空间层
 * （core/spatial/door.ts），这里只透传，不重判一次。
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
  type DoorSwingReport,
  type WallContactFact,
  type WallContactKind,
} from './model.ts';
