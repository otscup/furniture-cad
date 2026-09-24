/**
 * CSV 单元格转义：含逗号/引号/换行时必须包起来，内部引号翻倍。
 * 从 server.mjs 抽出 —— auditCsv 与 server 共用同一份，不许两份实现漂移。
 */
export function csvCell(v) {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
