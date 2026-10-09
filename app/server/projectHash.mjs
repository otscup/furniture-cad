import { createHash } from 'node:crypto';

/** 确定性 JSON：对象键排序、数组顺序保留，与客户端项目快照契约一致。 */
export function canonicalProjectJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalProjectJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalProjectJson(value[key])}`).join(',')}}`;
}

/** 项目语义内容的 SHA-256；不包含 workspace 的并发版本元数据。 */
export function hashProjectSnapshot(project) {
  return createHash('sha256').update(canonicalProjectJson(project)).digest('hex');
}
