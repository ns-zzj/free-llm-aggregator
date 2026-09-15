'use strict';

/**
 * 来源地址判定 + 监听地址工具（只给"管理端限内网 / 首次设置"这类**不该暴露给公网**的操作用）。
 *
 * 注意：**不能用 `req.ip`** —— 应用里设了 `app.set('trust proxy', true)`，
 * 它会信任 `X-Forwarded-For`，公网请求随便带个头就能把自己说成本机。
 * 这里一律用 **TCP 对端地址**（`req.socket.remoteAddress`），伪造不了。
 * 套 Cloudflare Tunnel / 本机反代时，对端就是 127.0.0.1 → 按"允许"处理，符合预期。
 *
 * IPv6（用户 2026-09-12 要求："服务器有 ipv6 地址，网页后台和 api 调用都应该支持 ipv6"）：
 *   - 默认**双栈监听**（`::`，见 src/index.js），一个端口同时接 IPv4 与 IPv6；
 *   - 双栈下，IPv4 客户端的对端地址会变成 **IPv4-mapped** 形式（`::ffff:192.168.1.5`），
 *     所以判定必须能把这层壳拆掉 —— 否则"从局域网用 IPv4 访问后台"会被误判成公网挡在外面；
 *   - 内网口径：`::1`（环回）、`fc00::/7`（唯一本地）、`fe80::/10`（链路本地）、
 *     以及全部 IPv4 私网段（含 mapped / v4-compatible 形式）；
 *   - 公网 IPv6（`2001:...`、`2400:...` 等）**一律不算内网**，跟公网 IPv4 一个待遇。
 */

/** IPv4 私网/本机段（172.16.0.0/12 单独按数值判，见 isPrivateV4） */
const PRIVATE_V4 = /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0$)/;

function isPrivateV4(s) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(s)) return false;
  if (PRIVATE_V4.test(s)) return true;
  const m = /^172\.(\d+)\./.exec(s);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/** 去掉方括号与 zone 后缀（`[::1]`、`fe80::1%eth0` 都还原成裸地址） */
function normalize(ip) {
  return String(ip || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '');
}

/** 把 IPv6 拆成 8 个 16 位整数；不是合法 IPv6 就返回 null */
function parseV6(s) {
  if (!s.includes(':') || !/^[0-9a-f:]+$/i.test(s)) return null;
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (parts.length === 2 ? fill < 0 : fill !== 0) return null;
  const hextets = parts.length === 2 ? [...head, ...Array(fill).fill('0'), ...tail] : head;
  if (hextets.length !== 8) return null;
  const nums = [];
  for (const h of hextets) {
    if (!/^[0-9a-f]{1,4}$/i.test(h)) return null;
    nums.push(parseInt(h, 16));
  }
  return nums;
}

function isPrivateAddress(ip) {
  const s = normalize(ip);
  if (!s) return false;

  // 带点号的两种可能：纯 IPv4，或"内嵌 IPv4 的 IPv6"（::ffff:1.2.3.4 / ::1.2.3.4）
  if (s.includes('.')) {
    const cut = s.lastIndexOf(':');
    const dotted = cut >= 0 ? s.slice(cut + 1) : s;
    if (cut < 0) return isPrivateV4(dotted);
    const prefix = s
      .slice(0, cut)
      .replace(/:+$/, '')
      .replace(/:/g, '')
      .toLowerCase();
    // 只有"全 0"（v4-compatible）或"全 0 + ffff"（v4-mapped）才跟着里面那个 IPv4 判；
    // 别的（如 64:ff9b::8.8.8.8 这种 NAT64）不认，按公网处理。
    if (prefix === '' || /^0*$/.test(prefix) || /^0*ffff$/.test(prefix)) return isPrivateV4(dotted);
    return false;
  }

  const nums = parseV6(s);
  if (!nums) return isPrivateV4(s); // 既不是合法 IPv6 也不是 IPv4 → false

  if (nums.slice(0, 7).every((n) => n === 0) && nums[7] === 1) return true; // ::1 环回
  // ::ffff:7f00:1 这种"十六进制写法"的 IPv4-mapped（有些协议栈会这么给）
  if (nums.slice(0, 5).every((n) => n === 0) && nums[5] === 0xffff) {
    const v4 = [nums[6] >> 8, nums[6] & 0xff, nums[7] >> 8, nums[7] & 0xff].join('.');
    return isPrivateV4(v4);
  }
  if ((nums[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 唯一本地地址
  if ((nums[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
  return false;
}

/** 取 TCP 对端地址（不看任何请求头） */
function clientAddress(req) {
  const socket = req && req.socket;
  if (!socket) return '';
  return socket.remoteAddress || '';
}

/**
 * 监听地址 → 能拼进 URL 的写法。
 * IPv6 字面量在 URL 里必须加方括号（`http://[::1]:8787`），不然浏览器解析不出来。
 */
function hostForUrl(host) {
  const s = normalize(host);
  if (!s || s === '::' || s === '0.0.0.0') return 'localhost';
  return s.includes(':') ? `[${s}]` : s;
}

/**
 * 容器 / 虚拟机的**默认网关地址**。对端是这些地址时，几乎肯定是中间那层把真实客户端 IP
 * 抹掉了（Docker bridge 的 userland proxy → 172.17.0.1；rootless Docker / slirp4netns → 10.0.2.2）。
 * 此时"看着像内网"是假象 —— 见审计 H1：这道闸是唯一挡公网的后台防线，不能有静默失效模式，
 * 所以默认**不信**它们；确实是你自己的反代/网桥，就在 ADMIN_TRUSTED_PEERS 里显式声明。
 */
const SUSPECT_PEER_CIDRS = ['172.17.0.0/16', '10.0.2.0/24'];

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** IPv4 是否落在 CIDR 里（IPv6 不做网段，声明里写完整地址即可） */
function inCidr4(ip, cidr) {
  const [base, bitsRaw] = String(cidr).split('/');
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/** 地址是否命中一个白名单（支持单个地址，或 IPv4 的 CIDR） */
function inList(ip, list) {
  const s = normalize(ip);
  if (!s) return false;
  for (const item of Array.isArray(list) ? list : []) {
    const target = normalize(item);
    if (!target) continue;
    if (target.includes('/')) {
      if (!s.includes(':') && inCidr4(s, target)) return true;
      continue;
    }
    if (s.toLowerCase() === target.toLowerCase()) return true;
  }
  return false;
}

function isLoopback(ip) {
  const s = normalize(ip).toLowerCase();
  if (!s) return false;
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return true;
  return s.replace(/^::ffff:/, '').startsWith('127.');
}

/** 把 X-Forwarded-For 拆成地址列表（逗号分隔，可能有多段）。**这个头客户端可以自己写。** */
function forwardedAddresses(forwardedFor) {
  return String(forwardedFor || '')
    .split(',')
    .map((part) => normalize(part))
    .filter(Boolean);
}

/**
 * 管理端该不该放这个来源进来（审计 H1 的 fail-closed 版本）。
 *
 * 判定顺序（每一步都写清楚为什么这么排）：
 *   1) 对端在 ADMIN_TRUSTED_PEERS 里显式声明过 → 放（你自己的反代/网桥，你自己负责）
 *   1b) 带了 X-Forwarded-For，且头里的地址命中 ADMIN_TRUSTED_PEERS → 放
 *       （用户 2026-09-13 的要求。⚠ 见下面的警告：这个头能伪造，安全前提是"外面绕不过你的代理"）
 *   2) 环回 → 放（本机、SSH 隧道、装在本机的反代）
 *   3) 带了 X-Forwarded-For → **拒**：说明中间有代理，真实来源已经不可信了
 *   4) 对端是容器/虚拟机默认网关 → **拒**：真实 IP 被抹掉的典型特征
 *   5) 其它私网地址 → 放（正常的内网直连）
 *   6) 其余（公网）→ 拒
 *
 * ⚠ 关于 1b：`X-Forwarded-For` 是**请求头**，客户端想写什么就写什么。所以"头里的地址命中名单
 * 就放行"这件事只有在下面这个前提下才安全：
 *   **外面的人只能通过你自己那个代理访问本服务，没法绕过去直连端口。**
 * 否则任何知道名单里某个地址的人，在自己的请求里塞一个头就能进后台。真要不放心就别设
 * `ADMIN_TRUSTED_PEERS`（默认就是空的，那时 1b 永远不生效）。
 *
 * `ALLOW_PUBLIC_INTERNET=true` 时的行为：**上面整套都不看了，公网来源直接放行**（于是带
 * X-Forwarded-For 的、对端是 Docker 网关的，全都放行）—— 这本来就是那个开关的意思。
 *
 * @returns {{ ok: boolean, reason: string, via: string, matched?: string }}
 */
function checkAdminPeer(ip, { forwardedFor = '', trustedPeers = [] } = {}) {
  const s = normalize(ip);
  if (!s) return { ok: false, reason: '没拿到来源地址', via: 'none' };
  if (inList(s, trustedPeers)) return { ok: true, reason: '', via: 'declared' };

  // 1b) X-Forwarded-For 里的地址命中白名单 → 放（via='forwarded'，日志里能看出是这条规则放的行）
  const forwarded = forwardedAddresses(forwardedFor);
  const matchedForwarded = forwarded.find((addr) => inList(addr, trustedPeers));
  if (matchedForwarded) return { ok: true, reason: '', via: 'forwarded', matched: matchedForwarded };

  if (isLoopback(s)) return { ok: true, reason: '', via: 'loopback' };
  if (forwarded.length) {
    return { ok: false, reason: '请求经过了代理（带了 X-Forwarded-For），真实来源已不可信', via: 'proxied' };
  }
  if (inList(s, SUSPECT_PEER_CIDRS)) {
    return { ok: false, reason: `来源 ${s} 是容器/虚拟机的默认网关地址，真实客户端 IP 被抹掉了`, via: 'gateway' };
  }
  if (isPrivateAddress(s)) return { ok: true, reason: '', via: 'private' };
  return { ok: false, reason: '来源看起来是公网', via: 'public' };
}

module.exports = {
  isPrivateAddress,
  clientAddress,
  hostForUrl,
  normalize,
  inList,
  isLoopback,
  checkAdminPeer,
  forwardedAddresses,
  SUSPECT_PEER_CIDRS,
};
