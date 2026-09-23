import type { CheckSpec, Correction, CorrectionScope } from './memory.ts';
import { seedCorrections } from './seedCorrections.ts';

/**
 * 记忆的落盘与搬运。
 *
 * 存储形态选 **JSONL**（一行一条 JSON）而不是一个大 JSON 数组，理由：
 *  · 追加一条记忆 = 追加一行，不需要重写整个文件（记忆是只增的日志）
 *  · 单条损坏不影响其余（逐行解析，坏行单独报出来）
 *  · 可以直接塞进 git diff 看"人和 AI 各自改过哪条记忆"
 *  · 与 Phase 2 的审计日志、Correction 回流管线同一种格式
 *
 * 浏览器里用 localStorage 做默认持久化；Node（验收脚本）里退化为内存态。
 */

const KEY = 'furniture-cad.corrections.v1';

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
    /* 隐私模式 / SSR：降级为内存态 */
  }
  return null;
}

/** 内存兜底（Node / 隐私模式）：同一次进程内保持一致 */
let memoryFallback: Correction[] | null = null;

export function loadCorrections(): Correction[] {
  const s = storage();
  if (!s) {
    if (!memoryFallback) memoryFallback = seedCorrections();
    return memoryFallback;
  }
  const raw = s.getItem(KEY);
  if (!raw) {
    const seeded = seedCorrections();
    s.setItem(KEY, toJsonl(seeded));
    return seeded;
  }
  const parsed = fromJsonl(raw);
  if (parsed.list.length === 0) {
    // 文件被打空或全坏 —— 重新种入，并把坏行数如实报出去（不静默吞）
    const seeded = seedCorrections();
    s.setItem(KEY, toJsonl(seeded));
    return seeded;
  }
  if (parsed.bad.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[memory] 有 ${parsed.bad.length} 行记忆解析失败，已跳过：${parsed.bad[0]}`);
  }
  return parsed.list;
}

export function saveCorrections(list: Correction[]): void {
  const s = storage();
  if (!s) {
    memoryFallback = list;
    return;
  }
  s.setItem(KEY, toJsonl(list));
}

// ───────────────────────────── JSONL 编解码 ─────────────────────────────

/**
 * 固定的键顺序。
 *
 * 为什么不直接用 JSON.stringify(c)：
 *  · 记忆文件是要进 git 的。键顺序随对象构造顺序漂移，diff 里就会出现
 *    一整行"变了但其实没变"的假变更，几轮下来没人再认真看 diff。
 *  · 往返（toJsonl → fromJsonl → toJsonl）必须逐字节幂等，否则"记忆文件
 *    是否被改动过"就无法用哈希判断。
 */
const KEY_ORDER = ['id', 'at', 'scope', 'origin', 'nl', 'evidence', 'status', 'pendingReason', 'checkSpec', 'tags'] as const;

function stableStringify(c: Correction): string {
  const src = c as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of KEY_ORDER) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  // 兜底：后加的新字段也照原样带上 —— 否则 schema 一升级，字段就被静默丢掉
  for (const k of Object.keys(src)) {
    if (!(k in out) && src[k] !== undefined) out[k] = src[k];
  }
  return JSON.stringify(out);
}

export function toJsonl(list: Correction[]): string {
  return list.map(stableStringify).join('\n');
}

export interface JsonlParseResult {
  list: Correction[];
  /** 解析失败的行（原样保留，便于人工排查），不静默丢弃 */
  bad: string[];
}

export function fromJsonl(text: string): JsonlParseResult {
  const list: Correction[] = [];
  const bad: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Partial<Correction>;
      if (!o.id || !o.nl || !o.status) throw new Error('缺少 id / nl / status');
      /**
       * 可选字段只在**真的有值**时才挂上去。
       *
       * 写成 `pendingReason: o.pendingReason` 看似等价，实际是凭空造出一个
       * `pendingReason: undefined` 的键 —— JSON 里没有 undefined 的概念，
       * 往返一次就会多出这个键，深比较当场不等（H2 就是这么被抓住的）。
       */
      const item: Correction = {
        id: String(o.id),
        at: Number(o.at) || 0,
        scope: (o.scope ?? 'global') as CorrectionScope,
        origin: o.origin === 'self' ? 'self' : 'user',
        nl: String(o.nl),
        evidence: Array.isArray(o.evidence) ? o.evidence.map(String) : [],
        status: o.status,
        tags: Array.isArray(o.tags) ? o.tags.map(String) : [],
      };
      if (o.pendingReason !== undefined) item.pendingReason = String(o.pendingReason);
      if (o.checkSpec !== undefined) item.checkSpec = o.checkSpec as CheckSpec;
      list.push(item);
    } catch (e) {
      bad.push(`${(e as Error).message} :: ${t.slice(0, 90)}`);
    }
  }
  return { list, bad };
}

// ───────────────────────────── 增删改 ─────────────────────────────

/**
 * 追加一条记忆。
 *
 * 注意 status 的默认值是 **pending 而不是 active**：
 * 一条刚记下的自然语言，在没有任何可执行检查之前，本来就还不具备拦截能力。
 * 把它标成 active 只是自我安慰 —— 界面上会出现"已生效"的假象。
 */
export function addCorrection(
  list: Correction[],
  input: { nl: string; scope?: CorrectionScope; evidence?: string[]; tags?: string[]; checkSpec?: CheckSpec }
): Correction[] {
  const id = `mem_${String(list.length + 1).padStart(3, '0')}_${Date.now().toString(36)}`;
  const item: Correction = {
    id,
    at: Date.now(),
    scope: input.scope ?? 'global',
    origin: 'user',
    nl: input.nl.trim(),
    evidence: input.evidence ?? [],
    status: input.checkSpec ? 'active' : 'pending',
    pendingReason: input.checkSpec ? undefined : '尚未编译出可执行检查（需要先确定判定条件）',
    checkSpec: input.checkSpec,
    tags: input.tags ?? [],
  };
  return [...list, item];
}

export function setStatus(list: Correction[], id: string, status: Correction['status'], pendingReason?: string): Correction[] {
  return list.map((c) => (c.id === id ? { ...c, status, pendingReason: status === 'pending' ? pendingReason : undefined } : c));
}

export function removeCorrection(list: Correction[], id: string): Correction[] {
  return list.filter((c) => c.id !== id);
}
