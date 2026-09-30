/**
 * ID 生成 —— 确定性、可读、可预测。
 *
 * 为什么不用 uuid / nanoid：
 *  1. CAD 里 ID 会出现在图层名、标注、清单、DXF 块名里，人能读懂比"够随机"重要
 *  2. 确定性 ID 让"同一份模型导出两次得到同一份 DXF"成为可断言的性质
 *  3. 删除后重建不会产生 ID 洪泛，模型文件 diff 干净
 */

const pad3 = (n: number): string => String(n).padStart(3, '0');

/** 在 taken 中找一个未占用的 `prefix_001` 形式 ID */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? (taken as Set<string>) : new Set(taken);
  let n = 1;
  while (set.has(`${prefix}_${pad3(n)}`)) n++;
  return `${prefix}_${pad3(n)}`;
}

/** 命令 ID：只用于审计日志，不进入模型，允许带时间戳 */
let cmdSeq = 0;
export function newCommandId(op: string): string {
  cmdSeq++;
  return `cmd_${op.replace(/\W+/g, '_')}_${Date.now().toString(36)}_${cmdSeq.toString(36)}`;
}
