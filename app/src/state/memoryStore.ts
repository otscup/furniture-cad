import { useSyncExternalStore } from 'react';
import type { CheckSpec, Correction, CorrectionScope } from '../ai/memory.ts';
import { compileCorrections, summarize } from '../ai/memory.ts';
import {
  addCorrection,
  loadCorrections,
  removeCorrection,
  saveCorrections,
  setStatus,
} from '../ai/correctionStore.ts';
import { bus } from './store.ts';

/**
 * ══════════════════════════════════════════════════════════════════════
 *  记忆状态 —— 全应用唯一一份 correction 列表
 *
 *  与模型的关系（很重要）：
 *    模型由 CommandBus 独占；记忆在 CommandBus **外面**，作为它的门。
 *    记忆变化 → 重新编译 → bus.setGate(...)。
 *    因此"记忆"永远不会进到 model.json 里，导出/备份/回放都不带它。
 *
 *  为什么门设在 store 初始化时就装上：
 *    如果等用户打开"记忆"面板才装门，那在此之前的所有操作都不受记忆约束 ——
 *    这正好是最容易犯错的时段（刚打开软件、急着改尺寸）。
 * ══════════════════════════════════════════════════════════════════════
 */

let corrections: Correction[] = loadCorrections();
const listeners = new Set<() => void>();

/** 最近一次门拦下的记录（用于界面上"刚刚被哪条记忆拦了"） */
let lastHit: { at: number; correctionId: string; label: string; text: string } | null = null;

function notify(): void {
  for (const l of listeners) l();
}

function applyGate(): void {
  bus.setGate(compileCorrections(corrections).gate);
}

applyGate();

// ── 读 ──

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export function getCorrections(): Correction[] {
  return corrections;
}

export function useCorrections(): Correction[] {
  return useSyncExternalStore(subscribe, getCorrections, getCorrections);
}

export function useMemoryStats(): ReturnType<typeof summarize> {
  return summarize(useCorrections());
}

export function getLastHit(): typeof lastHit {
  return lastHit;
}

/** 记录一次拦下（由 App 在执行失败时调用），让界面能"当场说清是哪条记忆拦的" */
export function noteHit(correctionId: string, label: string, text: string): void {
  lastHit = { at: Date.now(), correctionId, label, text };
  notify();
}

// ── 写 ──

export function applyCorrections(next: Correction[]): void {
  corrections = next;
  saveCorrections(next);
  applyGate();
  notify();
}

export function addMemory(input: {
  nl: string;
  scope?: CorrectionScope;
  tags?: string[];
  checkSpec?: CheckSpec;
  evidence?: string[];
}): Correction {
  const next = addCorrection(corrections, input);
  applyCorrections(next);
  return next[next.length - 1];
}

export function setMemoryStatus(id: string, status: Correction['status'], pendingReason?: string): void {
  applyCorrections(setStatus(corrections, id, status, pendingReason));
}

export function dropMemory(id: string): void {
  applyCorrections(removeCorrection(corrections, id));
}

/** 强制重新读盘（多窗口 / 手工编辑过存储时用） */
export function reloadMemory(): void {
  applyCorrections(loadCorrections());
}

/** 编译结果（给界面显示"这条记忆现在具体在查什么"） */
export function compiledRules(): ReturnType<typeof compileCorrections> {
  return compileCorrections(corrections);
}
