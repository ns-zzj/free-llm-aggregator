'use strict';

/**
 * 跨站请求防线（CSRF）—— 用户 2026-09-13 的审计里 S1 那条：
 *
 *   `/api/admin/setup` 只靠"TCP 对端是内网"当闸，而它**不需要 cookie**，
 *   所以 `sameSite: 'lax'` 保护不到它；`express.urlencoded` 又让它能被一个跨站
 *   `<form method=post>` 直接打进来（简单请求、不触发 CORS 预检）。
 *   已实证：局域网里任何人访问一个攻击者页面，就能把管理密码设成攻击者的值、
 *   顺带装上一条他自己知道的下游 key。
 *
 * 判据（只信浏览器自己发的这两个头，不看 Referer）：
 *   - `Sec-Fetch-Site`：只放行 `same-origin`（我们自己的页面）和 `none`（直接导航 / 非浏览器）。
 *     `cross-site` / `same-site` 一律拒。
 *   - `Origin`：比**主机名**（含端口）即可，不比 scheme —— 反代做 TLS 终止而不发
 *     `X-Forwarded-Proto` 时，`req.protocol` 会是 http 而 Origin 是 https，
 *     比 scheme 会把正常的管理员挡在外面；主机名不同才是不该放的那种。
 *   - **两个头都没有** → 放行：那是 curl / 客户端脚本 / 老式表单的场景，
 *     本来就不是浏览器跨站（能发这种请求的人早就在内网里了，策略上早就视为可信）。
 *
 * 为什么不改成"只有环回能首次设置"：用户明确要"本机或内网都能设"（家里服务器从
 * 局域网第一次设置很常见），把它收窄成环回等于强迫所有人先学 SSH 隧道。
 * 这道防线针对的是"浏览器被劫持"，不是"内网用户能不能设"。
 */

const logger = require('./logger');

/** 只允许这两种；其余（cross-site / same-site / 未来的新值）一律拒 */
const SAFE_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * 这个请求看起来是不是"跨站发起的"。
 * @returns {{ ok: boolean, reason: string }} ok=false 表示应当拒绝
 */
function checkSameSite(req) {
  const site = String(req.get('sec-fetch-site') || '').toLowerCase();
  if (site && !SAFE_FETCH_SITES.has(site)) {
    return { ok: false, reason: `Sec-Fetch-Site: ${site}` };
  }

  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try {
      host = new URL(origin).host.toLowerCase();
    } catch (err) {
      host = null;
    }
    if (!host) return { ok: false, reason: `Origin 无法解析：${origin}` };
    // 本站的"自己"可能有两个名字：Host 头 + 反代写入的 X-Forwarded-Host（有些反代会改写 Host）
    const selves = [String(req.get('host') || '').toLowerCase(), String(req.get('x-forwarded-host') || '').toLowerCase()].filter(
      Boolean
    );
    if (!selves.includes(host)) {
      return { ok: false, reason: `Origin(${host}) 与本站(${selves.join(' / ')}）不一致` };
    }
  }

  return { ok: true, reason: '' };
}

/**
 * 中间件：挡掉跨站的状态变更请求。
 * 只作用于会改数据的 method；GET（我们的后台接口没有会改数据的 GET）放行。
 */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const check = checkSameSite(req);
  if (check.ok) return next();
  logger.warn('拒绝跨站请求', { method: req.method, path: req.path, detail: check.reason, ip: req.socket && req.socket.remoteAddress });
  return res.status(403).json({
    error: {
      message:
        `拒绝跨站请求（${check.reason}）。这类请求只能从本机/内网直接发起；` +
        '用 curl 或客户端脚本调用不受影响（它们不发这两个头）。',
      type: 'invalid_request_error',
      code: 'cross_site_blocked',
    },
  });
}

module.exports = { csrfGuard, checkSameSite, SAFE_FETCH_SITES };
