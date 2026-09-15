'use strict';

/**
 * 鉴权：
 *  - 管理后台：口令登录 → 内存 session（cookie）
 *  - 客户端 /v1/*：访问口令（门禁级，不做限流）
 */

const nodeCrypto = require('crypto');

const config = require('./config');
const logger = require('./logger');
const net = require('./net');
const settings = require('./store/settings');
const accessKeys = require('./store/accessKeys');

const SESSION_COOKIE = 'agg_session';
const sessions = new Map();

function createSession() {
  const token = nodeCrypto.randomBytes(32).toString('base64url');
  const issuedAt = Date.now();
  sessions.set(token, { expiresAt: issuedAt + config.sessionTtlMs, issuedAt });
  return token;
}

function getSession(token) {
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function destroySession(token) {
  sessions.delete(token);
}

function cleanupSessions() {
  const nowTs = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= nowTs) sessions.delete(token);
  }
}

async function login(password) {
  if (!(await settings.verifyAdminPassword(password))) return null;
  return createSession();
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: config.sessionTtlMs,
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE);
}

/** 后台接口鉴权；还没设置管理密码时明确告诉前端"先去首次设置" */
async function requireAdmin(req, res, next) {
  if (!(await settings.hasAdminPassword())) {
    return res.status(403).json({
      error: { message: '还没设置管理密码，请先完成首次设置', type: 'auth_error', code: 'setup_required' },
    });
  }
  const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
  const session = getSession(token);
  if (!session) {
    return res.status(401).json({ error: { message: '未登录或登录已过期', type: 'auth_error' } });
  }
  // 管理密码改过之后，比它更早签发的会话一律作废（审计 M4）：
  // 否则"改密码"这个动作踢不掉已经拿到会话的人，他还能继续用满 12 小时。
  const changedAt = Number(await settings.get('admin_password_changed_at')) || 0;
  if (session.issuedAt && session.issuedAt < changedAt) {
    destroySession(token);
    clearSessionCookie(res);
    return res.status(401).json({
      error: { message: '登录已失效（管理密码改过了），请重新登录', type: 'auth_error', code: 'session_stale' },
    });
  }
  return next();
}

/**
 * 管理端来源闸：只放本机/内网进来（无开关，永远默认开）。
 *
 * 为什么要有：后台和 /v1 是**同一个端口**，而 /v1 天生就是要暴露出去的。
 * 于是"我把 API 开放出去"这个动作会顺带把后台也端到公网上 —— 这不是用户粗心，
 * 是这东西的默认形态本身有坑。所以在产品这一层挡住，而不是写进文档指望人记得。
 *
 * 判定用 TCP 对端地址（`src/net.js` 的 `checkAdminPeer`），**不信 X-Forwarded-For**。
 * 审计 H1：源 IP 一旦被 NAT/代理/容器网桥抹成网关地址（172.17.0.1 / 10.0.2.2），
 * "看着像内网"就是假象 —— 所以那种情况下**默认拒绝**（fail-closed），
 * 要放就在 `ADMIN_TRUSTED_PEERS` 里显式声明它。
 */
/**
 * 公网来源到底放不放行 —— **单一出处**：`/setup`、`/setup/status`、`requireLocalAdmin` 都用它，
 * 免得三处判断不一致。
 *
 * 只看 `ALLOW_PUBLIC_INTERNET` 这一个变量（严格解析见 src/config.js）：
 *   true                                     → 放行
 *   其他（false / 没设 / 不认，比如 yes、1）  → 不放行（内置默认 false）
 * 没有第二个开关了：后台那个「管理端限内网」已按用户要求（2026-09-13）删除。
 */
function publicSourceAllowed() {
  return config.adminPublicInternet === true;
}

async function requireLocalAdmin(req, res, next) {
  const ip = net.clientAddress(req);
  const check = net.checkAdminPeer(ip, {
    forwardedFor: req.get('x-forwarded-for'),
    trustedPeers: config.adminTrustedPeers,
  });
  if (check.ok) return next(); // 本机/内网直连 → 永远放行
  if (publicSourceAllowed()) return next(); // 公网来源 → 看 ALLOW_PUBLIC_INTERNET
  logger.warn('管理端来源被拒', { ip, via: check.via, reason: check.reason, method: req.method, path: req.path });
  const fix =
    check.via === 'gateway' || check.via === 'proxied'
      ? '如果这是你自己的反代或 Docker 网桥，把它的地址加进环境变量 ADMIN_TRUSTED_PEERS（逗号分隔，支持 CIDR）；' +
        '或者换成 host 网络模式（源 IP 会保真）。'
      : '要在外面管，用 SSH 隧道进来最简单：ssh -L 8787:127.0.0.1:8787 用户@这台机器，然后开 http://localhost:8787/admin。';
  return res.status(403).json({
    error: {
      message:
        `管理端只允许从本机或内网直接访问（${check.reason}）。${fix}` +
        '确实要让公网直接访问后台：把 ALLOW_PUBLIC_INTERNET 设成 "true"' +
        '（只认 true / false 这两个值，其他写法都会被忽略；改完要重启容器）——' +
        '⚠ 前提是前面**有 TLS**，否则管理口令和会话 cookie 会被同网络的人捞走。' +
        '不设这个变量就永远是"只允许本机/内网"，后台里没有能改它的开关。',
      type: 'auth_error',
      code: 'admin_local_only',
      via: check.via,
    },
  });
}

function bearerToken(req) {
  const header = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

/** 客户端 /v1/* 鉴权 */
async function requireAccessKey(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      if (await settings.getBool('allow_no_key')) return next();
      return res.status(401).json({
        error: {
          message: '缺少访问口令：请在 Authorization: Bearer <口令> 中提供（口令在后台「访问口令」页创建）',
          type: 'invalid_request_error',
          code: 'missing_api_key',
        },
      });
    }
    if (await accessKeys.verify(token)) return next();
    logger.warn('访问口令不匹配', { ip: req.ip, path: req.path });
    return res.status(401).json({
      error: { message: '访问口令不正确', type: 'invalid_request_error', code: 'invalid_api_key' },
    });
  } catch (err) {
    logger.error('客户端鉴权异常', { error: err.message });
    return res.status(500).json({ error: { message: '服务内部错误', type: 'server_error' } });
  }
}

module.exports = {
  SESSION_COOKIE,
  login,
  createSession,
  getSession,
  destroySession,
  cleanupSessions,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
  requireLocalAdmin,
  publicSourceAllowed,
  requireAccessKey,
  bearerToken,
};
