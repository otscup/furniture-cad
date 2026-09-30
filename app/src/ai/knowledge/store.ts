/**
 * 知识的落盘。与 correctionStore 同一套模式：
 *  · JSONL（一行一条）—— 追加安全、坏行隔离、git diff 可读
 *  · 浏览器 localStorage；Node（验收）退化为内存态
 *  · 键序固定 —— 往返逐字节幂等
 *
 * 知识**不进 project.json**：它是跨项目的用户资产，塞进项目文件会让
 * 「项目往返契约」背上另一个 schema 版本。独立键位，与记忆同样待遇。
 */

import type { KnowledgeEntry } from './model.ts';

const KEY = 'furniture-cad.knowledge.v1';

interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function storage(): StorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (g?.localStorage && typeof g.localStorage.getItem === 'function') return g.localStorage as StorageLike;
  } catch {
    /* 隐私模式 / SSR / Node：降级为内存态 */
  }
  return null;
}

let memoryFallback: KnowledgeEntry[] | null = null;

export function loadKnowledge(): KnowledgeEntry[] {
  const s = storage();
  if (!s) {
    if (!memoryFallback) memoryFallback = [];
    return memoryFallback;
  }
  const raw = s.getItem(KEY);
  if (!raw) return [];
  const parsed = fromJsonl(raw);
  if (parsed.bad.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[knowledge] 有 ${parsed.bad.length} 行知识解析失败，已跳过：${parsed.bad[0]}`);
  }
  return parsed.list;
}

export function saveKnowledge(list: KnowledgeEntry[]): void {
  const s = storage();
  if (!s) {
    memoryFallback = list;
    return;
  }
  s.setItem(KEY, toJsonl(list));
}

// ───────────────────────────── JSONL 编解码 ─────────────────────────────

const KEY_ORDER = ['id', 'layer', 'statement', 'predicate', 'scope', 'evidence', 'confidence', 'status', 'confirmedAt', 'conflicts', 'createdAt', 'updatedAt'] as const;

function stableStringify(e: KnowledgeEntry): string {
  const src = e as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  for (const k of Object.keys(src)) {
    if (!(k in out) && src[k] !== undefined) out[k] = src[k];
  }
  return JSON.stringify(out);
}

export function toJsonl(list: KnowledgeEntry[]): string {
  return list.map(stableStringify).join('\n');
}

export interface JsonlParseResult {
  list: KnowledgeEntry[];
  bad: string[];
}

export function fromJsonl(text: string): JsonlParseResult {
  const list: KnowledgeEntry[] = [];
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Partial<KnowledgeEntry>;
      if (!o.id || !o.layer || !o.statement || !o.status) throw new Error('缺少 id / layer / statement / status');
      const item: KnowledgeEntry = {
        id: String(o.id),
        layer: o.layer,
        statement: String(o.statement),
        scope: (o.scope ?? {}) as KnowledgeEntry['scope'],
        evidence: Array.isArray(o.evidence)
          ? o.evidence.map((v) => ({
              at: Number((v as KnowledgeEvidence0).at) || 0,
              source: ((v as KnowledgeEvidence0).source ?? 'system') as KnowledgeEntry['evidence'][number]['source'],
              detail: String((v as KnowledgeEvidence0).detail ?? ''),
              ...((v as KnowledgeEvidence0).cabinetId !== undefined ? { cabinetId: String((v as KnowledgeEvidence0).cabinetId) } : {}),
            }))
          : [],
        confidence: Number(o.confidence) || 0,
        status: o.status,
        conflicts: Array.isArray(o.conflicts) ? o.conflicts.map(String) : [],
        createdAt: Number(o.createdAt) || 0,
        updatedAt: Number(o.updatedAt) || 0,
      };
      if (o.predicate !== undefined) item.predicate = o.predicate;
      if (o.confirmedAt !== undefined) item.confirmedAt = Number(o.confirmedAt);
      list.push(item);
    } catch (e) {
      bad.push(`${(e as Error).message} :: ${t.slice(0, 90)}`);
    }
  }
  return { list, bad };
}

type KnowledgeEvidence0 = KnowledgeEntry['evidence'][number];
