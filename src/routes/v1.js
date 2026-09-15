'use strict';

/**
 * 对外 OpenAI 兼容接口：
 *   - GET  /v1/models、/v1/models/:id
 *   - POST /v1/chat/completions（支持流式 SSE）
 *   - 假数据端点：/v1/usage、/v1/billing/subscription、/v1/credits
 *   - 其余 /v1/* 一律 404
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

const router = express.Router();
const SERVICE_NAME = 'llm-aggregator';
const STREAM_CONNECT_TIMEOUT_MS = 60 * 1000;
const STREAM_IDLE_TIMEOUT_MS = 120 * 1000;

function openaiError(res, status, message, { type = 'invalid_request_error', code = null } = {}) {
  const error = { message, type };
  if (code) error.code = code;
  return res.status(status).json({ error });
}

/**
 * 对下游发布"能不能收图"。三种写法一起发，因为各家客户端读的不一样：
 *   - `architecture.input_modalities` / `output_modalities` / `modality`：OpenRouter 那套，
 *     读它的客户端最多（[OpenRouter provider 文档](https://openrouter.ai/docs/guides/community/for-providers)）
 *   - 顶层 `input_modalities`：有的客户端直接读这一层
 */
function modalityFields({ vision }) {
  const inputs = vision ? ['text', 'image'] : ['text'];
  return {
    architecture: {
      modality: vision ? 'text+image->text' : 'text->text',
      input_modalities: inputs,
      output_modalities: ['text'],
    },
    input_modalities: inputs,
  };
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

/**
 * 对外发布的模型名规则（详见 src/naming.js）：
 *   All                          —— 虚拟模型：按「All模型顺序」页的顺序自动选，失败自动换源
 *   Free/<来源id>/<上游模型名>    —— 免费来源的具体模型
 *   Pay/<来源id>/<上游模型名>     —— 付费来源的具体模型
 *   ModelGroup/<组名>            —— 用户自定义的一组（组内顺序 = 优先级，可混免费付费）
 * 客户端必须用带类别的完整名字调用（不带类别直接报错，并在报错里给出正确写法）。
 *
 * `All` 和模型组这两类虚拟名字额外带上上下文长度（见 contextFields）：客户端要靠它
 * 决定什么时候压缩上下文，否则它会按自己的默认值（DSH 是 256k）攒上下文，撞上窗口更小的来源就 400。
 *
 * **图片能力（用户裁定 2026-09-12）**：虚拟名字（`All` / 每个模型组）**永远声明"能收图"**，
 * 哪怕当下一个能看图的模型都没有 —— 因为下游只在拉模型列表时看一眼能力、之后不会动态调整
 * （用户原话："下游只会获取一次这个模型能不能发图片。所以只能接受，收到了再看上游行不行"）。
 * 具体模型按各自的标记声明。
 */
async function modelListPayload(rows) {
  const seen = new Map();
  const context = await contextFields();
  seen.set(naming.ALL, {
    id: naming.ALL,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: SERVICE_NAME,
    ...context,
    ...modalityFields({ vision: true }), // 虚拟名字一律答应收图，收到再按能力筛源
  });
  for (const row of rows) {
    const id = naming.modelName({ providerId: row.providerId, modelId: row.modelId, isPaid: row.isPaid });
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      object: 'model',
      created: Math.floor((row.createdAt || Date.now()) / 1000),
      owned_by: naming.sourceLabel(row.providerId, row.isPaid),
      ...modalityFields({ vision: !!row.supportsVision }),
    });
  }
  for (const group of await modelGroups.publishedList()) {
    const id = group.id;
    if (seen.has(id)) continue;
    seen.set(id, {
      id,
      object: 'model',
      created: Math.floor((group.createdAt || Date.now()) / 1000),
      owned_by: SERVICE_NAME,
      ...context,
      ...modalityFields({ vision: true }),
    });
  }
  return { object: 'list', data: [...seen.values()] };
}

/** 把上游的错误原样转发给下游（指定了来源的请求用） */
function forwardUpstreamError(res, upstream, text, info) {
  const retryAfter = upstream && upstream.headers ? upstream.headers.get('retry-after') : null;
  if (retryAfter) res.set('retry-after', retryAfter);
  const status = upstream && upstream.status ? upstream.status : 502;
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    parsed = null;
  }
  if (parsed && parsed.error) return res.status(status).json(parsed);
  return res.status(status).json({
    error: { message: (info && info.message) || '上游返回错误', type: 'upstream_error', code: (info && info.type) || 'upstream_error' },
  });
}

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

// ---------------------------------------------------------------- /v1/models

/**
 * 虚拟名字（`All` / `ModelGroup/<组名>`）的上下文长度：客户端靠它决定什么时候压缩上下文。
 * 它们可能落到任何一个来源，所以只能按最窄的那个给（默认 256k，后台可改；填 0 = 不发布）。
 * 顺手把两个字段名都发出去：`context_length` 是 OpenRouter 那套约定，`context_window` 是另一拨客户端认的。
 */
async function contextFields() {
  const tokens = await settings.getNumber('auto_context_tokens');
  if (!tokens || tokens <= 0) return {};
  return { context_length: tokens, context_window: tokens };
}

router.get('/models', auth.requireAccessKey, async (req, res, next) => {
  try {
    const rows = await providerModels.listAll({ onlyEnabled: true });
    res.json(await modelListPayload(rows));
  } catch (err) {
    next(err);
  }
});

router.get('/models/*', auth.requireAccessKey, async (req, res, next) => {
  try {
    const id = String(req.params[0] || '');
    const rows = await providerModels.listAll({ onlyEnabled: true });
    const payload = await modelListPayload(rows);
    const target = payload.data.find((m) => m.id === id);
    if (!target) return openaiError(res, 404, `模型「${id}」不存在`, { code: 'model_not_found' });
    return res.json(target);
  } catch (err) {
    return next(err);
  }
});

// ------------------------------------------------------- /v1/chat/completions

router.post('/chat/completions', auth.requireAccessKey, async (req, res, next) => {
  const requestId = nodeCrypto.randomUUID();
  try {
    const body = req.body || {};
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    if (!requestedModel) return openaiError(res, 400, '缺少 model 字段');
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return openaiError(res, 400, '缺少 messages 字段');
    }
    const wantStream = body.stream === true;
    // 这次带了图片吗？带了就只走标了「支持图片理解」的模型（虚拟名字对外虽然一律声明能收图，
    // 但真要发的时候得有个真能看的 —— 见 modelListPayload 上的说明）
    const needsVision = requestHasImage(body);

    const selectionResult = await selection.selectCandidates(requestedModel, { needsVision });
    const { mode, available, skipped, invalidReason, visionUnsupported } = selectionResult;

    // 名字不合规 / 来源不存在 / 类别前缀用错 / 该来源下没有这个模型 —— 都直接报错，并提示正确格式
    if (mode === 'invalid' || mode === 'unknown-provider' || mode === 'paid-mismatch' || mode === 'unknown-model') {
      return openaiError(
        res,
        404,
        `${invalidReason || '模型名不正确'}。完整名字见 GET /v1/models：` +
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
});

/** 非流式：All / 模型组逐个换源；指定来源（pinned）不换源并转发上游错误 */
async function handleNonStreaming({ res, requestId, requestedModel, body, skipped, candidates, isStream, mode }) {
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
      return res.json(out);
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
async function handleStreaming({ req, res, requestId, requestedModel, body, skipped, candidates, mode }) {
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
      res.status(200).set({
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      const outcome = await pipeSse({ upstream, res, req, requestedModel, provider, mode });
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
        // 已经开始输出：给客户端一个 SSE 错误块后收尾
        try {
          res.write(`data: ${JSON.stringify({ error: { message: '上游连接中断', type: 'server_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch (writeErr) {
          /* 客户端可能已断开 */
        }
        res.end();
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

/** 只带用量、不带 choices 的收尾 chunk（OpenAI 的 include_usage 就是这个形状） */
function usageChunk(ctx, usage) {
  const prompt = Number(usage && usage.prompt_tokens) || 0;
  const completion = Number(usage && usage.completion_tokens) || 0;
  const chunk = {
    id: (ctx && ctx.chunkId) || `chatcmpl-${nodeCrypto.randomUUID()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    choices: [],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
  const model = adapter.responseModel(ctx, ctx && ctx.upstreamModel);
  if (model !== undefined && model !== null) chunk.model = model;
  return chunk;
}

/**
 * 把上游 SSE 透传给客户端：
 *  - openai-compatible：原样透传，只重写 chunk 里的 model
 *  - 翻译型协议（anthropic / cloudflare-workers-ai）：把上游事件翻成 OpenAI chunk 再发
 *  - 收集 usage 用于计量
 *  - 空闲看门狗 + 客户端断连中止上游
 */
async function pipeSse({ upstream, res, req, requestedModel, provider, mode }) {
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
          if (keepRawLines) res.write(`${parsed.raw}\n`);
          continue;
        }
        const result = adapter.normalizeStreamData(provider, parsed.data, ctx);
        if (result === null) continue; // 该协议下不关心的事件（ping 之类）
        if (result.passthrough) {
          res.write(`${parsed.raw}\n`); // 不是 JSON 的数据原样透传
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
              res.write(`data: ${JSON.stringify(usageChunk(ctx, usage))}\n\n`);
              usageSent = true;
            }
            res.write('data: [DONE]\n\n');
            continue;
          }
          if (item.usage) usageSent = true;
          res.write(`data: ${JSON.stringify(item)}\n\n`);
        }
      }
    }
    completed = true;
    // 有的协议（Workers AI 之类）流结束时不一定发 [DONE]，用量还是得补上
    if (!usageSent && usage && !res.writableEnded) {
      res.write(`data: ${JSON.stringify(usageChunk(ctx, usage))}\n\n`);
      usageSent = true;
    }
  } catch (err) {
    if (!closed) error = { type: 'stream_broken', message: err.message };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    req.off?.('close', onClientClose);
    try {
      if (!res.writableEnded) res.end();
    } catch (err) {
      /* ignore */
    }
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
  res.json({ object: 'list', data: [], has_more: false, total_usage: 0, daily_costs: [] });
});

router.get('/billing/subscription', auth.requireAccessKey, fakeEndpointsEnabled(), (req, res) => {
  res.json({
    object: 'billing_subscription',
    plan: { title: 'self-hosted', id: 'self-hosted' },
    hard_limit_usd: null,
    soft_limit_usd: null,
    system_hard_limit_usd: null,
    access_until: null,
    has_payment_method: false,
  });
});

router.get('/credits', auth.requireAccessKey, fakeEndpointsEnabled(), (req, res) => {
  res.json({
    object: 'credit_summary',
    total_granted: 0,
    total_used: 0,
    total_available: 0,
    credit_grants: [],
  });
});

module.exports = router;
module.exports.openaiError = openaiError;
