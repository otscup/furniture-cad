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
  wallInteriorSide,
  type SpatialFacts,
  type CabRoomRelation,
  type CabWallRelation,
  type CabOpeningRelation,
} from './derive.ts';
// `distPointSeg` / `wallNormalUnit` / `openingZoneRect` 于 P8.8 开放给**解释层**复用
// （designValidation 要量"离洞口影响带还有多远"、要判柜体哪一面在抵墙）。
// 开放的是**几何原语**，不是判定：touching / near / crossing / overlap 的判定
// 仍然只有 derive.ts 一处，解释层不许拿这些原语自己再判一遍。
export {
  SPATIAL_TOL,
  roomLoop,
  openingRect,
  openingZoneRect,
  openingName,
  pointInPoly,
  pointOnSeg,
  segsProperCross,
  distPointSeg,
  polyDistance,
  polysOverlapInterior,
  wallNormalUnit,
  type RoomLoop,
  type RoomLoopStatus,
} from './model.ts';
