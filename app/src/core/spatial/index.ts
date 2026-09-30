/**
 * 空间语义层（P8.7）—— Room / Wall / Opening 的确定性事实与校验。
 *
 * 对外只暴露三个入口：
 *  - deriveSpatial(project)  → SpatialReport { facts, issues }（供派生管线与 UI）
 *  - SpatialFacts 及三个关系枚举（CabRoom/CabWall/CabOpeningRelation）
 *  - model.ts 的容差常量 SPATIAL_TOL 与几何助手（测试/上层复用）
 */
export { deriveSpatial, type SpatialReport } from './validate.ts';
export {
  deriveSpatialFacts,
  classifyCabWall,
  classifyCabRoom,
  classifyCabOpening,
  type SpatialFacts,
  type CabRoomRelation,
  type CabWallRelation,
  type CabOpeningRelation,
} from './derive.ts';
export { SPATIAL_TOL, roomLoop, openingRect, openingName, pointInPoly, polyDistance, polysOverlapInterior, type RoomLoop } from './model.ts';
