/**
 * 设计意图层（P9.2）—— 对外唯一出口。
 *
 *   vocabulary.ts  封闭词表（含事实维度的闭集与"为什么不收某些词"的记录）
 *   model.ts       记录模型 + 生命周期（candidate → active，唯一人工通道）
 *   validate.ts    四道闸门（词表闭集 / 载荷无数字 / 载荷无实体 / 生命周期）+ 提案通道
 *
 * 本层是**纯语义层**：不 import 几何、空间、落位、校验、导出、命令总线。
 * 它与事实层的联系是**名字**（事实维度名），不是调用 —— 这样"意图不新增几何判断"
 * 就不是一句承诺，而是没法违反（想算也得先 import 一个算得了的东西）。
 */
export * from './vocabulary.ts';
export * from './model.ts';
export * from './validate.ts';
