'use strict';

/**
 * 对外 OpenAI 方言（2.0.0 起挂在 `/openai` 前缀下，地址里的 `/v1` 可有可无）：
 *   - GET  /openai/models、/openai/models/:id
 *   - POST /openai/chat/completions（支持流式 SSE）
 *   - 假数据端点：/openai/usage、/openai/billing/subscription、/openai/credits
 *   - 其余 /openai/* 一律 404（见 src/app.js 里的兜底）
 *
 * 行为准则（见 docs/设计文档.md）：
 *   - 上游失败静默换源；全挂时只回一条统一错误，不暴露上游细节
 *   - 请求类错误（内容被拒/参数错误）直接返回客户端，不改来源状态、不换源
 *   - 流式：首字节前可换源；首字节后不重放，出错即结束本次流
 */

const express = require('express');
const nodeCrypto = require('crypto');

const adapter = require('../gateway/adapter');
const selection = require('../gateway/selection');
const providerModels = require('../store/providerModels');
const sourceState = require('../store/sourceState');
const rateState = require('../store/rateState');
const callLog = require('../store/callLog');
const settings = require('../store/settings');
const modelGroups = require('../store/modelGroups');
const probeSchedule = require('../store/probeSchedule');
const naming = require('../naming');
const auth = require('../auth');
const logger = require('../logger');
const face = require('../protocol/faces/openai-chat');
const responsesFace = require('../protocol/faces/openai-responses');
/** 默认面：`/openai` 前缀下就是它。别的方言（/anthropic）在路由里把 `req.face` 换掉 */
const openaiChat = face;

const router = express.Router();
const STREAM_CONNECT_TIMEOUT_MS = 60 * 1000;
const STREAM_IDLE_TIMEOUT_MS = 120 * 1000;

/**
 * 下游看到的一切形状（错误体 / 模型列表 / SSE 写法 / 假数据端点）都在
 * `src/protocol/faces/openai-chat.js` 里；这里保留 `openaiError` 这个本地别名，
 * 只是为了让下面十几处调用点读起来短一点。
 */
const openaiError = face.sendError;

/**
 * 取一次"发布模型列表"要的数据（面是纯的，数据由这里取好传过去）
 */
async function buildModelList() {
  const [rows, groups, contextTokens] = await Promise.all([
    providerModels.listAll({ onlyEnabled: true }),
    modelGroups.publishedList(),
    settings.getNumber('auto_context_tokens'),
  ]);
  return face.modelListPayload({ rows, groups, contextTokens });
}

/**
 * 这次请求里带图片了吗（OpenAI 的 content parts 写法）。
 * `image_url` 是标准写法；`image` / `input_image` 是些客户端/新协议用的别名，一并认。
 */
function requestHasImage(body) {
  const messages = Array.isArray(body && body.messages) ? body.messages : [];
  for (const message of messages) {
    const content = message && message.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = String(part.type || '');
      if (type === 'image_url' || type === 'image' || type === 'input_image') return true;
    }
  }
  return false;
}

/** 把上游的错误原样转发给下游（指定了来源的请求用）——形状在面里，这里只是短别名 */
const forwardUpstreamError = face.forwardUpstreamError;


/** 本地限速（rpm 没到点）：指定来源时不换源，直接报错让下游等 */
function localRateLimitError(res, publishedModel, lease) {
  const seconds = Math.ceil((lease.etaMs || 0) / 1000);
  if (seconds > 0) res.set('retry-after', String(seconds));
  return openaiError(
    res,
    429,
    `${publishedModel} 本地限速中：${lease.reason || ''}${seconds > 0 ? `，约 ${seconds} 秒后可再试` : ''}`,
    { type: 'rate_limit_error', code: 'rate_limited' }
  );
}

function retryAfterHeader(res, skipped) {
  const seconds = selection.earliestRetryAfterSeconds(skipped);
  if (seconds) res.set('retry-after', String(seconds));
  return seconds;
}

// ---------------------------------------------------------------- /openai/models

router.get('/models', auth.requireAccessKey, async (req, res, next) => {
  try {
    res.json(await buildModelList());
  } catch (err) {
    next(err);
  }
});

router.get('/models/*', auth.requireAccessKey, async (req, res, next) => {
  try {
    const id = String(req.params[0] || '');
    const payload = await buildModelList();
    const target = payload.data.find((m) => m.id === id);
    if (!target) return openaiError(res, 404, `模型「${id}」不存在`, { code: 'model_not_found' });
    return res.json(target);
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------- /openai/chat/completions

router.post('/chat/completions', auth.requireAccessKey, chatCompletions);

/**
 * `/openai/responses`：同一条前缀下的**另一种下游方言**（OpenAI 的 Responses API）。
 * 客户端说 Responses，内部照旧是 chat completions，渲染交给 responses 面 —— 复用的是同一个
 * `chatCompletions`，所以选源/换源/限速/记账这些一行都不用再写一遍。
 */
router.post('/responses', auth.requireAccessKey, (req, res, next) => {
  // 排查客户端兼容性问题时用：LOG_LEVEL=debug 才打，平时一声不吭
  logger.debug('客户端请求体（Responses 方言）', {
    body: JSON.stringify(req.body || {}).slice(0, 800),
  });
  const parsed = responsesFace.parseBody(req.body || {});
  if (parsed.error) {
    return responsesFace.sendError(res, parsed.error.status, parsed.error.message, { code: parsed.error.code });
  }
  req.face = responsesFace;
  req.internalBody = parsed.body;
  return chatCompletions(req, res, next);
});

/**
 * 聊天补全的**协议无关**处理逻辑（选源 / 换源 / 限速 / 打上游 / 记账），
 * 渲染交给"面"：默认是 openai-chat；下游别的方言（比如 `/anthropic/messages`）
 * 只要把 `req.face` 换成自己的面、把内部请求体放进 `req.internalBody`，就能复用这一整套。
 *
 * 内部形状统一是 OpenAI chat completions（见 src/gateway/adapters/common.js），
 * 所以这里看不到任何协议细节 —— 面负责"进"（解析）和"出"（渲染）。
 */
async function chatCompletions(req, res, next) {
  const face = req.face || openaiChat;
  // 下面到处都在用 openaiError / forwardUpstreamError 这两个名字，就地遮罩成"当前面"的实现，
  // 这样十几个调用点一行都不用改（面换了，错误体跟着换）。
  const openaiError = face.sendError;

  const requestId = nodeCrypto.randomUUID();
  try {
    const body = req.internalBody || req.body || {};
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    if (!requestedModel) return openaiError(res, 400, '缺少 model 字段');
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return openaiError(res, 400, '缺少 messages 字段');
    }
    const wantStream = body.stream === true;
    // 这次带了图片吗？带了就只走标了「支持图片理解」的模型（虚拟名字对外虽然一律声明能收图，
    // 但真要发的时候得有个真能看的 —— 见 src/protocol/faces/openai-chat.js 里模型列表那段说明）
    const needsVision = requestHasImage(body);

    const selectionResult = await selection.selectCandidates(requestedModel, { needsVision });
    const { mode, available, skipped, invalidReason, visionUnsupported } = selectionResult;

    // 名字不合规 / 来源不存在 / 类别前缀用错 / 该来源下没有这个模型 —— 都直接报错，并提示正确格式
    if (mode === 'invalid' || mode === 'unknown-provider' || mode === 'paid-mismatch' || mode === 'unknown-model') {
      return openaiError(
        res,
        404,
        `${invalidReason || '模型名不正确'}。完整名字见 GET /openai/models：` +
          `\`${naming.ALL}\`、\`${naming.FREE_PREFIX}<来源id>/<模型名>\`（免费）、` +
          `\`${naming.PAY_PREFIX}<来源id>/<模型名>\`（付费）、\`${naming.GROUP_PREFIX}<组名>\`（模型组）`,
        { code: 'model_not_found' }
      );
    }

    // 带了图，但没有任何一个标了「支持图片理解」的模型 —— 这是配置问题，等也不会好，所以是 400 不是 503
    if (visionUnsupported) {
      logger.warn('请求带图片但没有可用的图片模型', { model: requestedModel, mode, requestId });
      await callLog.add({
        requestModel: requestedModel,
        status: 'fail',
        errorType: 'no_vision_source',
        requestId,
        isStream: wantStream,
        detail: '请求里带了图片，但没有任何模型标了「支持图片理解」',
      });
      const detail =
        mode === 'pinned'
          ? `「${requestedModel}」没有标「支持图片理解」。`
          : `${requestedModel} 名下现在没有任何标了「支持图片理解」的模型。`;
      return openaiError(
        res,
        400,
        `这次请求里带了图片，但${detail}去「提供商」页把能看图的模型标上（编辑提供商 → 模型列表里的「图片」按钮），` +
          '或者这次改用能被看到的模型名。注意：我们不会把图片丢掉再发出去 —— 那样你会收到一个"没看图"的回答。',
        { code: 'image_not_supported' }
      );
    }

    if (available.length === 0) {
      const retryAfter = retryAfterHeader(res, skipped);
      const detail = skipped.map((item) => ({ provider: item.providerId, status: item.status, reason: item.reason }));
      logger.warn('没有可用来源', { model: requestedModel, mode, detail });
      await callLog.add({
        requestModel: requestedModel,
        status: 'fail',
        errorType: 'no_available_source',
        requestId,
        isStream: wantStream,
        detail: JSON.stringify(detail),
      });
      // 指定来源时把"它为什么不能用"说清楚；All / 模型组只说服务不可用（不暴露内部细节）
      if (mode === 'pinned') {
        const first = skipped[0] || {};
        // 本机限速没到点：明确让下游等（429 + Retry-After）
        if (first.status === 'rate_limited') {
          return openaiError(res, 429, `${requestedModel} 本地限速中：${first.reason || ''}`, {
            type: 'rate_limit_error',
            code: 'rate_limited',
          });
        }
        return openaiError(res, 503, `${requestedModel} 暂时不可用：${first.reason || '当前不可用'}`, {
          type: 'server_error',
          code: 'source_unavailable',
        });
      }
      return openaiError(res, 503, retryAfter ? `服务暂时不可用，约 ${retryAfter} 秒后重试` : '服务暂时不可用，请稍后重试', {
        type: 'server_error',
        code: 'no_available_source',
      });
    }

    // All / 模型组：挨个试"此刻可用"的来源（All 是免费在前、付费兜底；模型组按组内顺序）；
    // pinned：只有一个候选，不换源——本机限速报错、上游报错原样转发
    const context = {
      req,
      res,
      face,
      requestId,
      requestedModel,
      body,
      mode,
      skipped,
      candidates: mode === 'pinned' ? available.slice(0, 1) : available,
      isStream: wantStream,
    };

    if (wantStream) return await handleStreaming(context);
    return await handleNonStreaming(context);
  } catch (err) {
    return next(err);
  }
}

/** 非流式：All / 模型组逐个换源；指定来源（pinned）不换源并转发上游错误 */
async function handleNonStreaming({ res, face, requestId, requestedModel, body, skipped, candidates, isStream, mode }) {
  // 就地遮罩：这个函数里的报错/转发都走"当前面"
  const openaiError = face.sendError;
  const forwardUpstreamError = face.forwardUpstreamError;
  let lastFailure = null;
  let attemptIndex = 0;
  const pinned = mode === 'pinned';

  for (const candidate of candidates) {
    attemptIndex += 1;
    const provider = candidate.provider;
    const lease = await rateState.admit({
      providerId: provider.id,
      modelKey: candidate.modelKey,
      limits: candidate.limits,
    });
    if (!lease.allowed) {
      if (pinned) {
        await callLog.add({
          requestModel: requestedModel,
          providerId: provider.id,
          realModel: candidate.realModelId,
          status: 'fail',
          errorType: 'rate_limited',
          requestId,
          isStream,
          detail: `本地限速未放行：${lease.reason}`,
        });
        return localRateLimitError(res, requestedModel, lease);
      }
      lastFailure = { type: 'rate_limited', message: lease.reason };
      continue;
    }

    const startedAt = Date.now();
    try {
      const { url, headers, payload } = adapter.buildChatRequest(provider, candidate.realModelId, body, { stream: false });
      const upstream = await adapter.fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      const text = await upstream.text();
      const latencyMs = Date.now() - startedAt;

      if (!upstream.ok) {
        const info = adapter.classifyError(upstream.status, text, provider);
        await recordFailure({ provider, candidate, info, text, requestId, requestedModel, latencyMs, isStream });
        await afterRetryableFailure({ provider, candidate, info, upstream, requestId, requestedModel });

        if (pinned) {
          // 指定了来源：把上游的错误原样转发给下游，不换源
          logger.info('指定来源的请求失败，转发上游错误', { provider: provider.id, status: upstream.status, type: info.type });
          return forwardUpstreamError(res, upstream, text, info);
        }
        if (!info.retryable) {
          return openaiError(res, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 400, info.message, {
            type: 'invalid_request_error',
            code: info.type,
          });
        }
        lastFailure = info;
        continue;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (err) {
        parsed = null;
      }
      // 按来源的协议翻译成 OpenAI 形状（openai-compatible 是原样，anthropic/CF 会翻）
      // mode 传下去：指定来源时响应里的 model 字段"上游写啥就是啥"，虚拟名字（All/模型组）保持客户端请求的名字
      const out = parsed ? adapter.normalizeResponse(provider, parsed, { requestedModel, mode }) : null;
      if (!out) {
        // 有些协议 HTTP 200 但 body 里说失败（Workers AI）：把里面的原文当失败原因，日志才看得懂
        const embedded = adapter.bodyError(provider, text);
        const info = embedded
          ? { type: embedded.type || 'upstream_body_error', retryable: true, message: embedded.message || '上游返回失败' }
          : { type: 'bad_response', retryable: true, message: '上游返回了无法解析的内容' };
        await recordFailure({ provider, candidate, info, text, requestId, requestedModel, latencyMs, isStream });
        await afterRetryableFailure({ provider, candidate, info, upstream, requestId, requestedModel });
        if (pinned) {
          return openaiError(res, 502, `${requestedModel} 上游返回失败：${info.message}`, {
            type: 'upstream_error',
            code: info.type,
          });
        }
        lastFailure = info;
        continue;
      }

      await recordSuccess({ provider, candidate, requestId, requestedModel, latencyMs, attemptIndex, usage: out.usage, isStream });
      return face.sendPayload(res, out, { requestedModel, mode, isStream: false });
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      const info = adapter.classifyException(err);
      await recordFailure({ provider, candidate, info, text: info.message, requestId, requestedModel, latencyMs, isStream });
      await afterRetryableFailure({ provider, candidate, info, upstream: null, requestId, requestedModel });
      if (pinned) {
        // 连不上上游：没有上游响应可转发，给一个明确的 502
        return openaiError(res, 502, `${requestedModel} 上游连接失败：${info.message}`, {
          type: 'upstream_error',
          code: info.type,
        });
      }
      lastFailure = info;
    } finally {
      lease.release();
    }
  }

  const retryAfter = retryAfterHeader(res, skipped);
  logger.warn('全部候选失败', { model: requestedModel, lastError: lastFailure && lastFailure.message });
  return openaiError(res, 503, retryAfter ? `服务暂时不可用，约 ${retryAfter} 秒后重试` : '服务暂时不可用，请稍后重试', {
    type: 'server_error',
    code: 'all_sources_failed',
  });
}

/** 流式：All / 模型组在首字节前可换源；指定来源（pinned）不换源、转发上游错误 */
async function handleStreaming({ req, res, face, requestId, requestedModel, body, skipped, candidates, mode }) {
  // 就地遮罩：这个函数里的报错/转发都走"当前面"
  const openaiError = face.sendError;
  const forwardUpstreamError = face.forwardUpstreamError;
  let attemptIndex = 0;
  let lastFailure = null;
  const pinned = mode === 'pinned';

  for (const candidate of candidates) {
    attemptIndex += 1;
    const provider = candidate.provider;
    const lease = await rateState.admit({
      providerId: provider.id,
      modelKey: candidate.modelKey,
      limits: candidate.limits,
    });
    if (!lease.allowed) {
      if (pinned) {
        await callLog.add({
          requestModel: requestedModel,
          providerId: provider.id,
          realModel: candidate.realModelId,
          status: 'fail',
          errorType: 'rate_limited',
          requestId,
          isStream: true,
          detail: `本地限速未放行：${lease.reason}`,
        });
        return localRateLimitError(res, requestedModel, lease);
      }
      lastFailure = { type: 'rate_limited', message: lease.reason };
      continue;
    }

    const startedAt = Date.now();
    let stream = null;
    try {
      const { url, headers, payload } = adapter.buildChatRequest(provider, candidate.realModelId, body, { stream: true });
      stream = await adapter.openStream(
        url,
        { method: 'POST', headers, body: JSON.stringify(payload) },
        { connectTimeoutMs: STREAM_CONNECT_TIMEOUT_MS }
      );

      const upstream = stream.response;
      if (!upstream.ok) {
        const text = await upstream.text();
        const info = adapter.classifyError(upstream.status, text, provider);
        await recordFailure({
          provider,
          candidate,
          info,
          text,
          requestId,
          requestedModel,
          latencyMs: Date.now() - startedAt,
          isStream: true,
        });
        await afterRetryableFailure({ provider, candidate, info, upstream, requestId, requestedModel });

        if (pinned) {
          logger.info('指定来源的流式请求失败，转发上游错误', { provider: provider.id, status: upstream.status, type: info.type });
          return forwardUpstreamError(res, upstream, text, info);
        }
        if (!info.retryable) {
          return openaiError(res, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 400, info.message, {
            type: 'invalid_request_error',
            code: info.type,
          });
        }
        lastFailure = info;
        continue;
      }

      // —— 开始向客户端输出（此后不可换源）——
      const writer = face.beginStream(res, { requestedModel, mode });

      const outcome = await pipeSse({ upstream, res, req, requestedModel, provider, mode, face, writer });
      const latencyMs = outcome.firstByteAt ? outcome.firstByteAt - startedAt : Date.now() - startedAt;

      if (outcome.clientAborted) {
        // 客户端主动断开（用户取消）：不算来源故障，只记账
        await callLog.add({
          requestModel: requestedModel,
          providerId: provider.id,
          realModel: candidate.realModelId,
          status: 'fail',
          isPaidFallback: candidate.isPaid,
          errorType: 'client_abort',
          latencyMs,
          ttfbMs: outcome.firstByteAt ? outcome.firstByteAt - startedAt : null,
          isStream: true,
          requestId,
          detail: '客户端提前断开，本次流被中止',
        });
        logger.info('客户端提前断开，已中止上游流', { provider: provider.id, requestId });
        return undefined;
      }

      if (outcome.error) {
        // 中途断开：不重放，记账后结束
        await callLog.add({
          requestModel: requestedModel,
          providerId: provider.id,
          realModel: candidate.realModelId,
          status: 'fail',
          isPaidFallback: candidate.isPaid,
          errorType: outcome.error.type,
          latencyMs,
          ttfbMs: outcome.firstByteAt ? outcome.firstByteAt - startedAt : null,
          isStream: true,
          promptTokens: outcome.usage ? outcome.usage.prompt_tokens : null,
          completionTokens: outcome.usage ? outcome.usage.completion_tokens : null,
          requestId,
          detail: `流中途结束：${outcome.error.message}`,
        });
        logger.warn('流中途结束', { provider: provider.id, error: outcome.error.message });
        return undefined;
      }

      await recordSuccess({
        provider,
        candidate,
        requestId,
        requestedModel,
        latencyMs,
        ttfbMs: outcome.firstByteAt ? outcome.firstByteAt - startedAt : null,
        attemptIndex,
        usage: outcome.usage,
        isStream: true,
      });
      return undefined;
    } catch (err) {
      const info = adapter.classifyException(err);
      await recordFailure({
        provider,
        candidate,
        info,
        text: info.message,
        requestId,
        requestedModel,
        latencyMs: Date.now() - startedAt,
        isStream: true,
      });
      await afterRetryableFailure({ provider, candidate, info, upstream: null, requestId, requestedModel });
      if (res.headersSent) {
        // 已经开始输出：给客户端一个流内错误块后收尾（收尾交给面：Anthropic 要补 message_stop）
        try {
          writer.chunk({ error: { message: '上游连接中断', type: 'server_error' } });
          writer.done();
        } catch (writeErr) {
          /* 客户端可能已断开 */
        }
        writer.end();
        return undefined;
      }
      if (pinned) {
        return openaiError(res, 502, `${requestedModel} 上游连接失败：${info.message}`, {
          type: 'upstream_error',
          code: info.type,
        });
      }
      lastFailure = info;
    } finally {
      lease.release();
    }
  }

  const retryAfter = retryAfterHeader(res, skipped);
  logger.warn('全部候选失败（流式）', { model: requestedModel, lastError: lastFailure && lastFailure.message });
  return openaiError(res, 503, retryAfter ? `服务暂时不可用，约 ${retryAfter} 秒后重试` : '服务暂时不可用，请稍后重试', {
    type: 'server_error',
    code: 'all_sources_failed',
  });
}

/** 只带用量、不带 choices 的收尾 chunk —— 形状在面里（`writer.usage()` 内部就是它） */
const usageChunk = face.usageChunk;

/**
 * 把上游 SSE 透传给客户端：
 *  - openai-compatible：原样透传，只重写 chunk 里的 model
 *  - 翻译型协议（anthropic / cloudflare-workers-ai）：把上游事件翻成 OpenAI chunk 再发
 *  - 收集 usage 用于计量
 *  - 空闲看门狗 + 客户端断连中止上游
 */
async function pipeSse({ upstream, res, req, requestedModel, provider, mode, writer }) {
  let firstByteAt = null;
  let usage = null;
  let buffer = '';
  let closed = false;
  let completed = false;
  let idleTimer = null;
  let error = null;
  let usageSent = false;
  const keepRawLines = !adapter.translatesStream(provider);
  // 同一次流式响应用同一个 chunk id（翻译型协议要用）
  const ctx = { requestedModel, mode, chunkId: `chatcmpl-${nodeCrypto.randomUUID()}` };

  const onClientClose = () => {
    if (closed) return;
    closed = true;
    try {
      upstream.body?.cancel?.();
    } catch (err) {
      /* ignore */
    }
  };
  req.on('close', onClientClose);

  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      error = { type: 'idle_timeout', message: '上游长时间没有输出' };
      onClientClose();
    }, STREAM_IDLE_TIMEOUT_MS);
    if (typeof idleTimer.unref === 'function') idleTimer.unref();
  };

  try {
    resetIdle();
    for await (const chunk of upstream.body) {
      if (closed) break;
      resetIdle();
      if (!firstByteAt) firstByteAt = Date.now();
      buffer += Buffer.from(chunk).toString('utf8');

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        const parsed = adapter.parseSseLine(line);
        if (parsed === null) continue; // 心跳/空行
        if (parsed.data === null) {
          // 非 data 行（如 event:）：翻译型协议要丢掉（客户端只认 OpenAI 的 data: 行）
          if (keepRawLines) writer.raw(parsed.raw);
          continue;
        }
        const result = adapter.normalizeStreamData(provider, parsed.data, ctx);
        if (result === null) continue; // 该协议下不关心的事件（ping 之类）
        if (result.passthrough) {
          writer.raw(parsed.raw); // 不是 JSON 的数据原样透传
          continue;
        }
        if (result.error) {
          error = { type: 'upstream_stream_error', message: result.error };
          onClientClose();
          break;
        }
        if (result.usage) usage = { ...(usage || {}), ...result.usage };
        for (const item of result.chunks || []) {
          if (item === '[DONE]') {
            // 翻译型协议：上游不一定像 OpenAI 那样给一个带 usage 的收尾 chunk，
            // 这里补一个"只有 usage、没有 choices"的 chunk（等价于 OpenAI 的 include_usage）
            if (!usageSent && usage) {
              writer.usage(usage);
              usageSent = true;
            }
            writer.done();
            continue;
          }
          if (item.usage) usageSent = true;
          writer.chunk(item);
        }
      }
    }
    completed = true;
    // 有的协议（Workers AI 之类）流结束时不一定发 [DONE]，用量还是得补上
    if (!usageSent && usage && !res.writableEnded) {
      writer.usage(usage);
      usageSent = true;
    }
  } catch (err) {
    if (!closed) error = { type: 'stream_broken', message: err.message };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    req.off?.('close', onClientClose);
    writer.end();
  }

  return { firstByteAt, usage, error, clientAborted: closed && !completed };
}

// ------------------------------------------------------------ 记账辅助

async function recordFailure({ provider, candidate, info, text, requestId, requestedModel, latencyMs, isStream }) {
  await callLog.add({
    requestModel: requestedModel,
    providerId: provider.id,
    realModel: candidate.realModelId,
    status: 'fail',
    isPaidFallback: candidate.isPaid,
    errorType: info.type,
    latencyMs,
    isStream: Boolean(isStream),
    requestId,
    detail: String(text || '').slice(0, 500),
  });
}

/**
 * 可重试失败：按策略改来源状态；429 时用 Retry-After 校准速率窗口。
 * 等待时长取退避表的第一段（一次请求失败 = 新一轮故障的开始）：
 * 上游抖动几秒就好的话，15 秒后就能探回来，不用白等 5 分钟。
 */
async function afterRetryableFailure({ provider, candidate, info, upstream, requestId, requestedModel }) {
  if (!info.retryable) return;

  let cooldownSeconds = await probeSchedule.nextWaitSeconds(0);
  if (info.type === 'rate_limit') {
    const retryAfter = upstream ? upstream.headers.get('retry-after') : null;
    const parsed = retryAfter ? Number(retryAfter) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) cooldownSeconds = Math.max(cooldownSeconds, Math.ceil(parsed));
    await rateState.noteRateLimited({
      providerId: provider.id,
      modelKey: candidate.modelKey,
      limits: candidate.limits,
      retryAfterMs: Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : null,
    });
  }

  const state = await sourceState.markFailure(provider.id, candidate.realModelId, {
    policy: provider.rejectPolicy,
    cooldownSeconds,
    reason: info.message,
    errorType: info.type,
    forcePolicy: info.forcePolicy || undefined,
  });
  logger.warn('上游失败，按策略处理', {
    provider: provider.id,
    errorType: info.type,
    cooldownSeconds,
    policy: info.forcePolicy || provider.rejectPolicy,
    newStatus: state.status,
    requestId,
    model: requestedModel,
  });
}

async function recordSuccess({ provider, candidate, requestId, requestedModel, latencyMs, ttfbMs = null, attemptIndex, usage, isStream }) {
  await sourceState.markSuccess(provider.id, candidate.realModelId);
  const promptTokens = usage ? usage.prompt_tokens : null;
  const completionTokens = usage ? usage.completion_tokens : null;
  await rateState.noteTokens({
    providerId: provider.id,
    modelKey: candidate.modelKey,
    limits: candidate.limits,
    tokens: (promptTokens || 0) + (completionTokens || 0),
  });
  await callLog.add({
    requestModel: requestedModel,
    providerId: provider.id,
    realModel: candidate.realModelId,
    status: attemptIndex > 1 ? 'fallback' : 'ok',
    isPaidFallback: candidate.isPaid,
    latencyMs,
    ttfbMs,
    isStream: Boolean(isStream),
    promptTokens,
    completionTokens,
    requestId,
  });
}

// --------------------------------------------------- 假数据端点（兼容用）

function fakeEndpointsEnabled() {
  return async (req, res, next) => {
    if (!(await settings.getBool('fake_endpoints_enabled'))) {
      return openaiError(res, 404, '未实现该端点', { type: 'invalid_request_error' });
    }
    return next();
  };
}

router.get('/usage', auth.requireAccessKey, fakeEndpointsEnabled(), (req, res) => {
  res.json(face.fakeUsagePayload());
});

router.get('/billing/subscription', auth.requireAccessKey, fakeEndpointsEnabled(), (req, res) => {
  res.json(face.fakeBillingPayload());
});

router.get('/credits', auth.requireAccessKey, fakeEndpointsEnabled(), (req, res) => {
  res.json(face.fakeCreditsPayload());
});

module.exports = router;
module.exports.openaiError = openaiError;
module.exports.chatCompletions = chatCompletions;
/** 别的方言（/anthropic/models）也要发布同一批名字，形状自己再包一层 */
module.exports.buildModelList = buildModelList;
module.exports.createChatHandler = (faceImpl) => (req, res, next) => {
  req.face = faceImpl;
  return chatCompletions(req, res, next);
};
