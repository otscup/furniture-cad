import { useSyncExternalStore } from 'react';
import rulesetJson from '../core/ruleset/factory-default.json';
import type { RuleSet } from '../core/types.ts';
import { CommandBus } from '../core/commandBus.ts';
import { sampleProject } from '../core/docFactory.ts';

/**
 * 编辑器单例。应用只有一个文档、一台总线。
 *
 * 为什么用 useSyncExternalStore 而不是把 Project 塞进 React state：
 *   模型不是 UI 状态。它由 CommandBus 独占持有，React 只是订阅者之一。
 *   如果让 React 持有一份副本，就出现两个真相源 —— 这正是本项目要极力避免的。
 *   React 只订阅一个 version 数字，模型本体永远只有一份。
 */

export const RULESET = rulesetJson as unknown as RuleSet;

export const bus = new CommandBus(sampleProject(RULESET), RULESET);

const subscribe = (cb: () => void): (() => void) => bus.subscribe(cb);
const getVersion = (): number => bus.getVersion();
const getServerVersion = (): number => 0;

/** 订阅模型版本；模型一变，调用组件就重渲染 */
export function useBusVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getServerVersion);
}
