/**
 * 审计日志 → CSV 序列化。
 *
 * 独立成模块的理由：这段逻辑必须可被 Node 级验收直接断言
 * （BOM 在不在、转义对不对），而不是只能靠浏览器点按钮间接验证。
 *
 * ── BOM 为什么必须有 ──
 *   CSV 默认编码是 UTF-8，但 Excel 打开无 BOM 的 UTF-8 时按 ANSI 解，
 *   中文全部乱码。带 BOM（\uFEFF）是"接收方用什么打开都不坏"的最低成本方案。
 */
import { csvCell } from './csvCell.mjs';

const HEAD = ['at', 'actor', 'action', 'target', 'result', 'detail'];

/** @param {Array<Record<string, unknown>>} entries @returns {string} */
export function auditCsv(entries) {
  const rows = entries.map((e) => [
    e.at ?? '',
    e.actor ?? '',
    e.action ?? '',
    e.target ?? '',
    e.result ?? '',
    // 其余字段整包塞进 detail —— 审计条目的形状不固定（不同动作带不同字段），
    // 硬编码列会随动作膨胀；JSON 串保真且可再解析。
    JSON.stringify({ ...e, at: undefined, actor: undefined, action: undefined, target: undefined, result: undefined }),
  ]);
  return '\uFEFF' + [HEAD, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
}
