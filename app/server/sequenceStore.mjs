/**
 * ══════════════════════════════════════════════════════════════════════
 *  操作序列存储（服务端）
 *
 *  落点：memory/sequences.jsonl（每行一条 JSON）。
 *
 *  ★ 为什么放在服务端而不是浏览器 ──
 *   序列是**项目级**知识：这次成功的操作序列，下次在这个项目里还能用。
 *   放浏览器就换台电脑就没了；放服务端才符合"这个项目已经这么做过"的语义。
 *
 *  ★ 写盘必须容错 ──
 *   序列是**优化**，不是功能前提。写盘失败绝不能让一次正常的 Agent 运行失败。
 *   读盘失败同理 —— 返回空列表，Agent 照常走模型。
 *   这与 workspaceHost 的"通知失败不改变装载结果"是同一条纪律。
 * ══════════════════════════════════════════════════════════════════════
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

import { canReplay, extractReplayable, sequenceKey, matchSequences, resolveSimilarityThreshold } from '../shared/sequenceStore.mjs';

/**
 * @param {string} path 序列文件路径
 * @returns {Array} 全部记录
 */
export function readSequences(path) {
  try {
    if (!existsSync(path)) return [];
    const out = [];
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const item = JSON.parse(t);
        if (item && typeof item === 'object' && item.key) out.push(item);
      } catch {
        /* 坏行跳过，不影响其余 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 记一条成功序列。
 *
 * 同一个 key 再来一次就**替换**（保留最近的一次），并累加命中计数。
 * 文件用「读-改-原子替换」写，避免并发时把文件写坏。
 *
 * @param {string} path 序列文件路径
 * @param {object} record {key, intent, families, steps, summary}
 * @returns {boolean} 是否写入成功
 */
export function recordSequence(path, record) {
  try {
    if (!record || !record.key) return false;
    const steps = Array.isArray(record.steps) ? record.steps : [];
    const gate = canReplay(steps);
    if (!gate.ok) return false;

    const all = readSequences(path);
    const prev = all.find((x) => x.key === record.key);
    const entry = {
      key: record.key,
      intent: String(record.intent ?? '').slice(0, 200),
      families: Array.isArray(record.families) ? record.families : [],
      steps,
      summary: String(record.summary ?? '').slice(0, 300),
      at: Date.now(),
      hits: (prev?.hits ?? 0) + 1,
    };
    const merged = [entry, ...all.filter((x) => x.key !== record.key)].slice(0, 200);

    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, merged.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 找一条可以完全重放的序列。
 *
 * ★ 只接受**完全一致**的 key ──
 *   完全一致意味着意图文本规范化后相同、动作族相同。
 *   这样重放出来的参数才真的适用于这次的需求 ——
 *   「宽 600」的重放拿去满足「宽 800」的需求，那就是错的。
 *
 * @param {string} path 序列文件路径
 * @param {string} key sequenceKey 的结果
 * @returns {object|null}
 */
export function findReplayable(path, key) {
  if (!key) return null;
  const all = readSequences(path);
  for (const s of all) {
    if (s.key !== key) continue;
    const gate = canReplay(s.steps);
    if (!gate.ok) continue;
    return s;
  }
  return null;
}

/**
 * 找一条可以当**提示词范例**的相似序列。
 *
 * 相似 = key 不同但动作族有交集，且序列本身可重放。
 * 命中时把上次的操作序列给模型当范例，模型会照着抄，步数更少。
 *
 * @param {string} path 序列文件路径
 * @param {string[]} families 本次的动作族
 * @param {string} excludeKey 要排除的 key（自己）
 * @param {string} intent 本次的意图原话（用于算相似度）
 * @param {number} [threshold] 相似度阈值（默认 SIMILARITY_THRESHOLD）
 * @returns {object|null}
 */
export function findSimilar(path, families = [], excludeKey = '', intent = '', threshold = undefined) {
  const all = readSequences(path);
  const fam = new Set(families);
  if (fam.size === 0) return null;
  const pool = all
    .filter((s) => s.key !== excludeKey)
    .filter((s) => canReplay(s.steps).ok);
  /**
   * ★ 有意图原话 ⇒ 走**相似度匹配** ──
   *   原来这里只按动作族筛，然后取**最近一条** ——
   *   那可能是一条毫不相干的序列（只要动作族碰巧相同）。
   *   给模型一段不相关的范例，它会照抄 —— 比不给更糟。
   *
   *   现在按 bigram 相似度排序，**低于阈值一律不返回**。
   */
  if (intent) {
    const matched = matchSequences(pool, intent, families, threshold === undefined ? {} : { threshold });
    return matched[0] ?? null;
  }
  // 没有意图原话（老数据/降级路径）：退回到「最近一条」，但仍要求动作族相同
  const candidates = pool
    .filter((s) => Array.isArray(s.families) && s.families.some((f) => fam.has(f)))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return candidates[0] ?? null;
}

/**
 * ★ 一次请求要用的两条序列，一次算完 ★
 *
 *   · replay  —— 完全一致的历史序列 ⇒ 直接重放（0 次模型调用）
 *   · similar —— 够像的历史序列 ⇒ 当提示词范例
 *
 * ★ 为什么要把这两个决定收在一个函数里 ──
 *   以前是 server.mjs 里两行散着调的。问题是**测不到**：
 *   server.mjs 一 import 就会起服务（读 .env、监听端口），
 *   验收脚本引不动 —— 于是只能用源码扫描断言，
 *   而源码扫描守不住行为（改坏调用点的参数，函数名还在，断言照样绿）。
 *
 *   这与 shared/ruleRetrieval.mjs 里 selectProjectRules 是同一个教训。
 *   所以「这次该用哪条序列」这个决定放在**可 import 的模块**里，
 *   服务端只负责把路径、意图、动作族传进来。
 *
 * ★ 阈值为什么直接收 env 而不是收一个数字 ──
 *   阈值有两个来源：.env 的配置项、还有默认值。
 *   如果「读配置」这一步留在 server.mjs 里（它 import 即起服务），
 *   这一步就**测不到** —— 只能扫源码。
 *   所以这里直接收 env：解析在模块内完成，验收能直接测。
 *
 * @param {string} path 序列文件路径
 * @param {string} intent 本次的意图原话
 * @param {string[]} families 本次的动作族
 * @param {object} [env] .env 的内容（读 SEQ_SIMILARITY_THRESHOLD）
 * @param {number} [threshold] 直接指定阈值（不给才读 env）
 * @returns {{replay: object|null, similar: object|null}}
 */
export function pickSequences(path, intent, families = [], env = null, threshold = undefined) {
  const key = sequenceKey(intent, families);
  const replay = findReplayable(path, key);
  // 完全一致的那条已经走重放路径了，不必再当范例
  const limit = threshold === undefined ? similarityThresholdFor(env) : threshold;
  const similar = findSimilar(path, families, key, intent, limit);
  return { replay, similar };
}


/**
 * 从 .env 里取相似度阈值。
 *
 * ★ 为什么要单独一个函数 ──
 *   .env 的解析住在 server.mjs 里，验收引不动它。
 *   把「读哪个键、怎么兜底」放到可 import 的模块里，
 *   验收就能直接测这几条规则（合法值 / 越界 / 空 / 非数字）。
 *
 * @param {object} env readEnv() 的结果
 * @returns {number}
 */
export function similarityThresholdFor(env) {
  return resolveSimilarityThreshold(env?.SEQ_SIMILARITY_THRESHOLD);
}

/**
 * 从一次成功的 Agent 运行里提取并落盘序列。
 *
 * @param {string} path 序列文件路径
 * @param {object} opts {intent, families, steps, summary}
 * @returns {boolean}
 */
export function saveRunSequence(path, opts) {
  const { intent, families, steps, summary } = opts;
  const key = sequenceKey(intent, families);
  if (!key) return false;
  const replayable = extractReplayable(steps);
  if (replayable.length === 0) return false;
  return recordSequence(path, { key, intent, families, steps: replayable, summary });
}
