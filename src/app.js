'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const adminRoutes = require('./admin/routes');
const v1Routes = require('./routes/v1');
const anthropicRoutes = require('./routes/anthropic');
const anthropicFace = require('./protocol/faces/anthropic');
const openaiFace = require('./protocol/faces/openai-chat');
const auth = require('./auth');
const csrf = require('./csrf');
const net = require('./net');
const { createWindowLimiter, createFailureGuard } = require('./limiter');
const logger = require('./logger');

/** 前端上报的限速：每 IP 30 条/分钟 + 全局 300 条/分钟（审计 L4：局域网里谁都能灌日志） */
const clientLogLimiter = createWindowLimiter({ limit: 30, windowMs: 60 * 1000, globalLimit: 300 });

/**
 * 客户端面（`/openai`、`/anthropic`）的失败锁定（用户 2026-09-15 要求："这是后台的，api 也一样"）。
 *
 * 为什么要有：客户端写错一个模型名、或者上游全挂的时候，它会在一个循环里一直撞 ——
 * 每个请求都要查库选源、写一行调用日志、往 stderr 打一行；不限速的话这些资源是白烧的。
 *
 * 规矩和后台登录完全一样（同一个 `createFailureGuard`）：
 *   同一个 IP 连续失败 5 次 → 锁 5 分钟；之后每再失败一次翻倍，1 小时封顶；
 *   24 小时没新的失败就忘掉；**只要成功一次就立刻解禁**。
 *
 * 什么算"失败"：响应状态码 ≥ 400（口令不对、模型名不对、来源全挂、上游报错……都算），
 * 2xx 算成功。**这个判断放在响应结束时做**，所以流式请求也照样算数。
 * 被本闸自己挡掉的那次 429 不计数（否则会一直自己把自己锁下去）。
 */
const v1FailureGuard = createFailureGuard();

function v1FailureGuardMiddleware(req, res, next) {
  const ip = net.clientAddress(req) || 'unknown';
  const gate = v1FailureGuard.check(ip);
  if (!gate.allowed) {
    res.set('retry-after', String(gate.retryAfterSeconds));
    logger.warn('客户端请求被限速', { ip, path: req.path, retryAfterSeconds: gate.retryAfterSeconds });
    // 错误体按当前方言渲染（Anthropic 客户端不认 OpenAI 的错误形状）
    const face = String(req.baseUrl || '').startsWith('/anthropic') ? anthropicFace : openaiFace;
    return face.sendError(res, 429, `这个来源连续失败太多次了，请 ${gate.retryAfterSeconds} 秒后再试（成功一次即可立刻解除）`, {
      code: 'too_many_failures',
    });
  }
  res.on('finish', () => {
    if (res.statusCode >= 400) v1FailureGuard.fail(ip);
    else v1FailureGuard.succeed(ip);
  });
  return next();
}

/**
 * 安全响应头（审计 M3）。全仓以前只有 x-powered-by 关掉了这一处加固。
 * CSP 的 script-src 能收紧到 'self' 是因为 admin.html 里的内联脚本已经外置成 /boot.js；
 * style-src 保留 'unsafe-inline' 是因为前端有几处用 setAttribute('style', …) 设列宽/边距，
 * 而样式注入的风险远低于脚本注入。
 */
function securityHeaders(req, res, next) {
  res.set('x-content-type-options', 'nosniff');
  res.set('x-frame-options', 'DENY');
  res.set('referrer-policy', 'no-referrer');
  // 后台接口都带敏感内容（口令掩码/明文/masked key/配置），一律不许缓存
  if (req.path.startsWith('/api/admin') || req.path === '/api/client-log') {
    res.set('cache-control', 'no-store');
  }
  if (req.path === '/' || req.path === '/admin' || req.path === '/admin/') {
    res.set(
      'content-security-policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "form-action 'self'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; ')
    );
  }
  next();
}

/**
 * 协议族前缀后面的那一段 `/v1` 可有可无 —— 这里统一把它吃掉，后面就不用为
 * "带 v1 的写法"再多写一遍路由。只认紧跟在 `/openai` / `/anthropic` 后面的那一段：
 *
 *   /openai/v1/models        → /openai/models
 *   /openai/v1               → /openai
 *   /openai/v1/v1/models     → /openai/v1/models（只吃一段，剩下的交给 404）
 *   /anthropic/v1/messages   → /anthropic/messages
 *
 * 只改 req.url（Express 的路由匹配看它），不动 req.path 之外的任何东西；查询串原样带着。
 */
function stripOptionalV1(req, res, next) {
  const q = req.url.indexOf('?');
  const path = q === -1 ? req.url : req.url.slice(0, q);
  const rest = q === -1 ? '' : req.url.slice(q);
  const rewritten = path.replace(/^\/(openai|anthropic)\/v1(?=\/|$)/, '/$1');
  if (rewritten !== path) req.url = rewritten + rest;
  return next();
}

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '32mb' }));
  // 表单提交（后台登录在 JS 失效时走这条原生路径）
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(securityHeaders);

  // 临时诊断：记录后台页面与静态资源的请求，便于排查"JS 没跑起来 / 浏览器用了缓存"
  app.use((req, res, next) => {
    const watched = ['/admin', '/app.js', '/style.css', '/api/admin/login', '/api/admin/me'];
    if (!watched.includes(req.path)) return next();
    const started = Date.now();
    res.on('finish', () => {
      logger.info('HTTP', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - started,
        cached: req.get('if-none-match') || req.get('if-modified-since') ? 'yes' : 'no',
        ua: String(req.get('user-agent') || '').slice(0, 100),
      });
    });
    return next();
  });

  // 前端错误回传：浏览器里发生的 JS 报错会 POST 到这里，落到服务端日志。
  // （跟着管理端一起限内网：公网谁都能往这里灌日志，没必要）
  app.post('/api/client-log', auth.requireLocalAdmin, csrf.csrfGuard, (req, res) => {
    const who = net.clientAddress(req) || 'unknown';
    const gate = clientLogLimiter.check(who);
    if (!gate.allowed) {
      res.set('retry-after', String(gate.retryAfterSeconds));
      return res.status(429).json({ error: { message: '上报太频繁，稍后再试', type: 'rate_limit_error' } });
    }
    clientLogLimiter.hit(who);
    const body = req.body || {};
    logger.warn('前端上报', {
      kind: String(body.kind || 'error').slice(0, 40),
      message: String(body.message || '').slice(0, 1000),
      source: String(body.source || '').slice(0, 300),
      line: body.line || null,
      column: body.column || null,
      stack: String(body.stack || '').slice(0, 800),
      page: String(body.page || '').slice(0, 200),
      ua: String(req.get('user-agent') || '').slice(0, 120),
    });
    res.status(204).end();
  });

  app.use('/api/admin', adminRoutes);

  // ============================================================ 客户端面（协议族前缀）
  /**
   * 客户端地址按**协议族**分前缀（2.0.0）：
   *
   *   /openai/...      说 OpenAI 方言：models、chat/completions、responses、假数据端点
   *   /anthropic/...   说 Anthropic 方言：messages、models
   *
   * 地址里那一段 `/v1` **可有可无**（客户端爱加不加，两种写法都认）：
   *   /openai/models  ==  /openai/v1/models
   *   /anthropic/messages  ==  /anthropic/v1/messages
   *
   * 为什么不再用「全都挂在 /v1 下」：下游协议一多，`/v1/messages`、`/v1/chat/completions`、
   * `/v1/responses` 就只能靠路径名去猜对方说的是哪套方言，加端点也越来越别扭。
   * 前缀分开之后，"填哪个地址"就等于"声明我说哪种话"，README 里也更好讲。
   *
   * 旧地址（裸 `/v1/*`）**刻意不保留**：项目刚发布、没有真实用户，留着只会让文档和代码
   * 里多出一套要解释的兼容规则（用户 2026-09-15 裁定）。
   */
  app.use(stripOptionalV1);
  app.use('/openai', v1FailureGuardMiddleware);
  app.use('/openai', v1Routes);
  app.use('/anthropic', v1FailureGuardMiddleware);
  app.use('/anthropic', anthropicRoutes);

  // 健康检查（容器 healthcheck 用，无需鉴权）
  app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

  // 浏览器会顺手请求 favicon，直接给个空响应，避免日志里出现无意义的 404
  app.get('/favicon.ico', (req, res) => res.status(204).end());

  // 前缀根路径：把这一族下面有什么端点数出来（填错地址时一眼能看出原因）
  app.get('/openai', (req, res) => {
    res.json({
      object: 'list',
      endpoints: ['models', 'models/<名字>', 'chat/completions', 'responses', 'usage', 'billing/subscription', 'credits'],
      note: '地址里的 /v1 可有可无',
    });
  });

  app.get('/anthropic', (req, res) => {
    res.json({
      endpoints: ['messages', 'models'],
      note: 'Anthropic 方言；地址里的 /v1 可有可无',
    });
  });

  // 未实现的 /openai/* 端点：统一 404（OpenAI 格式），避免客户端拿到奇怪响应
  app.use('/openai', (req, res) => {
    res.status(404).json({
      error: {
        message: `未实现该端点：${req.method} /openai${req.path}`,
        type: 'invalid_request_error',
      },
    });
  });

  // 未实现的 /anthropic/* 端点：按 Anthropic 的错误形状回（客户端才认）
  app.use('/anthropic', (req, res) => {
    anthropicFace.sendError(res, 404, `未实现该端点：${req.method} /anthropic${req.path}`, { type: 'not_found_error' });
  });

  // 管理后台页面（原生 HTML/CSS/JS）
  const publicDir = path.join(__dirname, '..', 'public');
  app.get(['/', '/admin', '/admin/'], (req, res) => res.sendFile(path.join(publicDir, 'admin.html')));
  app.use(express.static(publicDir));

  app.use((req, res) => {
    res.status(404).json({ error: { message: 'Not Found', type: 'invalid_request_error' } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { message: '请求体不是合法 JSON', type: 'invalid_request_error' } });
    }
    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
      logger.error('请求处理异常', { path: req.path, error: err.message });
    } else {
      logger.warn('请求被拒绝', { path: req.path, status, error: err.message });
    }
    return res.status(status).json({
      error: {
        message: status >= 500 ? '服务内部错误' : err.message,
        type: status === 401 ? 'auth_error' : 'invalid_request_error',
      },
    });
  });

  return app;
}

module.exports = { createApp, v1FailureGuard };
