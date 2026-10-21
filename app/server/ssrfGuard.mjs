/**
 * ══════════════════════════════════════════════════════════════════════
 *  SSRF 防线 —— 判定"这个地址是不是内网"
 *
 * ── 为什么需要这个文件（2026-10-20 审计 P1-1）──
 *   server.mjs 原先只有一条正则：
 *     /^(127\.|10\.|172\.(1[6-9]|...)\.|192\.168\.|0\.0\.0\.0|::1|localhost$|.*\.local$)/
 *   它有两个**已实测**的洞：
 *     ① `::1` 这个分支永远匹配不上 —— `URL.hostname` 对 IPv6 返回的是带方括号的
 *        `[::1]`。同理 `[::ffff:127.0.0.1]` 返回 `[::ffff:7f00:1]`，也过。
 *        实测：起一个只监听 [::1] 的服务，`http://[::1]:port/x.png` 完整取回内容。
 *     ② 只比对**主机名字符串**，从不做 DNS 解析后校验 ⇒ 任意域名解析到内网
 *        即可绕过（含 DNS rebinding）。
 *
 * ── 本模块的口径 ──
 *   · 只放行 http/https；
 *   · IPv4/IPv6 **字面量**先归一化再按网段判定（含 IPv4-mapped IPv6）；
 *   · 域名必须解析，**所有**解析结果都必须是公网地址（任一命中内网即拒）；
 *   · 每一跳重定向都重新走一遍本判定（调用方负责）。
 *
 * 判定采用"默认拒绝"：任何无法确认是公网的情况一律当内网处理。
 * ══════════════════════════════════════════════════════════════════════
 */
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

/** 明确的非公网网段（IPv4，CIDR 用前缀位数表达）。 */
const PRIVATE_V4 = [
  ['0.0.0.0', 8],        // "本网络"
  ['10.0.0.0', 8],       // 私有
  ['100.64.0.0', 10],    // CGNAT（含阿里云元数据 100.100.100.200）
  ['127.0.0.0', 8],      // 回环
  ['169.254.0.0', 16],   // link-local（含云元数据 169.254.169.254）
  ['172.16.0.0', 12],    // 私有
  ['192.0.0.0', 24],     // IETF 协议分配
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // 私有
  ['198.18.0.0', 15],    // 基准测试
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // 组播
  ['240.0.0.0', 4],      // 保留（含 255.255.255.255 广播）
];

/** 把点分十进制转成 32 位无符号整数。 */
function v4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out = (out * 256) + n;
  }
  return out >>> 0;
}

/** IPv4 是否落在私网/保留段。 */
function isPrivateV4(ip) {
  const v = v4ToInt(ip);
  if (v === null) return true; // 解析不出来 ⇒ 当不安全处理
  for (const [base, bits] of PRIVATE_V4) {
    const b = v4ToInt(base);
    if (b === null) continue;
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    if ((v & mask) >>> 0 === (b & mask) >>> 0) return true;
  }
  return false;
}

/**
 * 把 IPv6 字面量展开成 8 个 16 位分组。
 * 支持 `::` 缩写、以及末尾的点分十进制（`::ffff:127.0.0.1`）。
 * @returns {number[] | null} 8 个分组；解析失败返回 null
 */
function expandV6(ip) {
  let s = String(ip).trim();
  // 去掉可能的方括号
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // 去掉 zone id（fe80::1%eth0）
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (s === '') return null;

  // 末尾点分十进制：::ffff:127.0.0.1 → 转成两个 16 位分组
  let tail = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = v4ToInt(maybeV4);
    if (v4 === null) return null;
    tail = [Math.floor(v4 / 65536) >>> 0, v4 % 65536];
    s = s.slice(0, lastColon + 1) + '0:0'; // 占位，稍后替换
    s = s.slice(0, lastColon + 1) + 'X';   // 标记，避免重复计数
  }

  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':').filter((x) => x !== '') : [];
  const rest = parts.length === 2 && parts[1] ? parts[1].split(':').filter((x) => x !== '') : [];

  if (parts.length === 1) {
    // 没有 ::，必须正好 8 组（已把 v4 尾部替换成 X）
    const all = [...head];
    if (tail.length > 0) {
      if (all[all.length - 1] === 'X') all.pop();
      all.push(...tail.map((n) => n.toString(16)));
    }
    if (all.length !== 8) return null;
    const nums = all.map((x) => parseInt(x, 16));
    return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xFFFF) ? nums : null;
  }

  // 有 ::，补齐到 8 组
  const all = [...head];
  if (tail.length > 0) {
    if (all[all.length - 1] === 'X') all.pop();
    all.push(...tail.map((n) => n.toString(16)));
  }
  all.push(...rest);
  if (all.length > 8) return null;
  const missing = 8 - all.length;
  const nums = [];
  for (let i = 0; i < head.length; i++) nums.push(parseInt(head[i], 16));
  for (let i = 0; i < missing; i++) nums.push(0);
  for (let i = 0; i < rest.length; i++) nums.push(parseInt(rest[i], 16));
  if (nums.length !== 8) return null;
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xFFFF) ? nums : null;
}

/** IPv6 是否落在私网/保留段。 */
function isPrivateV6(ip) {
  const g = expandV6(ip);
  if (!g) return true;
  // ::1 回环
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  // :: 未指定
  if (g.every((x) => x === 0)) return true;
  // IPv4-mapped ::ffff:a.b.c.d
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xFFFF) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xFF}.${g[7] >> 8}.${g[7] & 0xFF}`;
    return isPrivateV4(v4);
  }
  // IPv4-compatible ::a.b.c.d（已废弃但仍可能被解析）
  if (g.slice(0, 6).every((x) => x === 0)) {
    const v4 = `${g[6] >> 8}.${g[6] & 0xFF}.${g[7] >> 8}.${g[7] & 0xFF}`;
    return isPrivateV4(v4);
  }
  const first = g[0];
  if ((first & 0xFE00) === 0xFC00) return true; // fc00::/7 ULA
  if ((first & 0xFFC0) === 0xFE80) return true; // fe80::/10 link-local
  if ((first & 0xFF00) === 0xFF00) return true; // ff00::/8 组播
  if (first === 0x2001 && g[1] === 0x0DB8) return true; // 2001:db8::/32 文档段
  return false;
}

/** 单个 IP 字面量是否非公网。 */
export function isPrivateAddress(ip) {
  const kind = isIP(String(ip));
  if (kind === 4) return isPrivateV4(String(ip));
  if (kind === 6) return isPrivateV6(String(ip));
  return true; // 不是 IP ⇒ 调用方应先解析；兜底当不安全
}

/** 主机名是否明显属于本机/内网域名后缀。 */
function isPrivateHostname(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, ''); // 去掉末尾点（localhost. 曾绕过）
  if (h === '') return true;
  if (h === 'localhost') return true;
  if (h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true;
  if (h.endsWith('.internal')) return true;
  if (h.endsWith('.home.arpa')) return true;
  return false;
}

/**
 * 判定一个 URL 是否可以安全外发请求。
 *
 * @param {string|URL} input
 * @param {{skipDns?: boolean}} [opts] skipDns 仅用于"只需要字面量判定"的同步场景
 * @returns {Promise<{ok:true} | {ok:false, reason:string}>}
 */
export async function assertPublicUrl(input, opts = {}) {
  let url;
  try {
    url = input instanceof URL ? input : new URL(String(input));
  } catch {
    return { ok: false, reason: 'url 格式不正确' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '只支持 http/https 链接' };
  }
  // URL.hostname 对 IPv6 会带方括号，这里统一去壳
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '') return { ok: false, reason: '缺少主机名' };

  // ① IP 字面量直接判定（不做 DNS）
  if (isIP(host)) {
    return isPrivateAddress(host) ? { ok: false, reason: '不允许访问内网地址' } : { ok: true };
  }

  // ② 明显的本机/内网域名
  if (isPrivateHostname(host)) {
    return { ok: false, reason: '不允许访问内网地址' };
  }

  if (opts.skipDns) return { ok: true };

  // ③ 域名必须解析，且**所有**结果都必须是公网
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: `域名解析失败：${host}` };
  }
  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, reason: `域名无解析结果：${host}` };
  }
  for (const rec of records) {
    if (isPrivateAddress(rec.address)) {
      return { ok: false, reason: '不允许访问内网地址' };
    }
  }
  return { ok: true };
}
