/**
 * ══════════════════════════════════════════════════════════════════════
 *  进程内串行写队列（P10.0 · S1-E 并发写保护）
 *
 *  ── 它解决什么 ──
 *   account 库 / Workspace 文件等 JSON 持久写入，原先各自 `writeFileSync`，
 *   在「读-改-写」跨越一次 await、或多请求并发 save 时，会出现后写覆盖前写、
 *   整文件丢失他人条目的事故（auth.mjs 的 #save 注释里已自认这一风险）。
 *
 *  ── 性质 ──
 *   · 同一文件路径的写**按提交顺序串行**执行；不同路径之间可并行。
 *   · 单个写任务失败**不会吞掉后续队列**（错误只传播给该次调用的 await 方，
 *     队列链照常继续处理下一个任务）。
 *   · 写采用 tmp + rename 原子替换，避免写到一半断电留下半个 JSON。
 *   · **不改变现有文件格式**：调用方负责把「内存真相」序列化成字符串，
 *     队列只负责把它原子、有序地落盘。本模块不读、不解析、不合并任何业务数据。
 *   · 不换数据库、不引入第二存储系统（与 P10.0 架构审查 IR-5 一致）。
 * ══════════════════════════════════════════════════════════════════════
 */
import { renameSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 每条路径一条 promise 链。链的当前末端 = 该路径「上一个已排队的写」的完成态。
 * 新任务挂在末端之后，保证：上一个写完，下一个才写。
 */
const chains = new Map();

/**
 * 把一次写任务排入某路径的串行队列。
 * @param {string} path 目标文件路径（队列键）
 * @param {() => (void | Promise<void>)} task 写任务；调用方在闭包里已持有最新内存真相
 * @returns {Promise<void>} 该任务自身的结果（可被调用方 await；失败只影响这一次）
 */
export function enqueueWrite(path, task) {
  const prev = chains.get(path) ?? Promise.resolve();
  // 无论上一个成功还是失败，都运行「本次」任务 —— 失败隔离靠这里的两个分支都指向同一 task。
  const next = prev.then(task, task).finally(() => {
    if (chains.get(path) === next) chains.delete(path);
  });
  chains.set(path, next);
  return next;
}

/**
 * 原子写字符串到文件（tmp + rename）。本函数本身不读旧文件、不做 read-modify-write；
 * 串行化由 enqueueWrite 保证。调用方应传入「当前内存真相」的完整内容。
 */
export async function writeFileAtomic(path, content) {
  return enqueueWrite(path, () => {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, path);
  });
}

/** 便捷：把对象原子写成 JSON 文件。 */
export async function writeJsonAtomic(path, obj) {
  return writeFileAtomic(path, JSON.stringify(obj, null, 2));
}
