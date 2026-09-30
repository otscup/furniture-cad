export * from './model.ts';
export * from './resolver.ts';
export * from './observe.ts';
export * from './store.ts';
export * from './digest.ts';
export * from './placementContext.ts';

import { loadCorrections } from '../correctionStore.ts';
import { hardRuleEntries, type KnowledgeEntry } from './model.ts';
import { loadKnowledge } from './store.ts';

/**
 * 当前全部知识 = 用户/观察知识（store）+ hardRule 层（规则引用 + active 记忆门）。
 * hardRule 只引用不复制 —— 执行体仍是 Rules Engine 和 CommandBus 门两处。
 */
export function currentKnowledge(): KnowledgeEntry[] {
  return [...hardRuleEntries([], loadCorrections()), ...loadKnowledge()];
}
