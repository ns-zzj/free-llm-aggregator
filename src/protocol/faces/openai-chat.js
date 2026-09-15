'use strict';

/**
 * 客户端面：**OpenAI chat-completions 方言**（挂在 `/openai`）
 *
 * 这个模块只负责一件事：**决定客户端看到的形状** —— 响应体、SSE 事件、错误体、模型列表。
 * 业务（选源、限速、换源、记账、打上游）全在 `src/routes/v1.js` 里，这里一行都不碰。
 *
 * 为什么拆出来（2.0.0 的动机）：下游要有三种方言（openai-chat / openai-responses /
 * anthropic-messages），它们的**响应形状、SSE 事件格式、错误体**三样都不一样。
 * 分到各自的"面"里之后，加一种方言 = 加一个文件，核心逻辑一行不用动。
 *
 * ⚠ 这个面是**零翻译**的：我们的内部形状本来就定成 OpenAI chat completions
 * （见 `src/gateway/adapters/common.js` 顶部的约定）。所以这里主要是"拼装"，
 * 不是"翻译"。真正要翻译的是另外三种协议（anthropic / responses / cloudflare）。
 *
 * 面不做的事（保持纯函数/纯渲染，方便测试和复用）：
 *   - 不 require 任何 store（settings / providers / modelGroups…）——数据由调用方取好传进来
 *   - 不决定选哪个来源、也不写日志
 */

const nodeCrypto = require('crypto');

const naming = require('../../naming');
const { responseModel } = require('../../gateway/adapters/common');

const SERVICE_NAME = 'llm-aggregator';

// ============================================================ 错误体

/** OpenAI 的错误形状：`{ error: { message, type, code? } }` */
function sendError(res, status, message, { type = 'invalid_request_error', code = null } = {}) {
  const error = { message, type };
  if (code) error.code = code;
  return res.status(status).json({ error });
}

/**
 * 把上游的错误**原样**转发给下游（指定了来源的请求用）。
 * 上游返回的 JSON 里有 `error` 就整块透传（保住它自己的 type/code/参数提示），
 * 否则按 `info` 造一个形状一样的。
 */
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
    error: {
      message: (info && info.message) || '上游返回错误',
      type: 'upstream_error',
      code: (info && info.type) || 'upstream_error',
    },
  });
}

/** 写 `retry-after` 头（秒）；0 或负数不写 */
function setRetryAfter(res, seconds) {
  if (seconds > 0) res.set('retry-after', String(seconds));
  return seconds;
}

// ============================================================ 模型列表

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
 * 虚拟名字（`All` / 模型组）的上下文长度：客户端靠它决定什么时候压缩上下文。
 * 它们可能落到任何一个来源，所以只能按**最窄**的那个给（后台可改；填 0 = 不发布）。
 * 顺手把两个字段名都发出去：`context_length` 是 OpenRouter 那套约定，`context_window` 是另一拨客户端认的。
 */
function contextFields(contextTokens) {
  const tokens = Number(contextTokens);
  if (!Number.isFinite(tokens) || tokens <= 0) return {};
  return { context_length: tokens, context_window: tokens };
}

/**
 * `/openai/models` 的响应体。
 *
 * 数据由调用方取好传进来（面里不碰存储）：
 *   rows          启用中的模型（providerModels.listAll({ onlyEnabled: true })）
 *   groups        已发布的模型组（modelGroups.publishedList()）
 *   contextTokens 后台设置里的 auto_context_tokens
 */
function modelListPayload({ rows = [], groups = [], contextTokens = 0 } = {}) {
  const seen = new Map();
  const context = contextFields(contextTokens);
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
  for (const group of groups) {
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

// ============================================================ 非流式

/**
 * 非流式对话的出口。
 * 内部形状就是 OpenAI chat completions，所以这里**原样**发出去；
 * 留这个函数是为了让"面"有统一出口（别的方言在各自的面里做真翻译）。
 */
function sendPayload(res, payload) {
  return res.json(payload);
}

// ============================================================ 流式（SSE）

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

/**
 * SSE 写入器：客户端面负责"怎么写"，业务侧只说要写什么。
 *
 *   chunk(obj)   —— 写一个 `data: {json}`（一个 OpenAI chunk）
 *   usage(usage) —— 补一个"只有 usage、没有 choices"的收尾 chunk（OpenAI 的 include_usage）
 *   done()       —— 写收尾的 `data: [DONE]`
 *   raw(line)    —— 原样写一行（透传型的上游可能带非 JSON 行）
 *   end()        —— 结束响应（幂等，已经结束就不动）
 */
function createStreamWriter(res, ctx = {}) {
  return {
    chunk(obj) {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
    usage(usage) {
      if (!usage) return;
      this.chunk(usageChunk(ctx, usage));
    },
    done() {
      if (!res.writableEnded) res.write('data: [DONE]\n\n');
    },
    raw(line) {
      if (!res.writableEnded) res.write(`${line}\n`);
    },
    end() {
      try {
        if (!res.writableEnded) res.end();
      } catch (err) {
        /* 客户端已经断开：忽略 */
      }
    },
  };
}

/** 开始一个 SSE 响应：写响应头并返回写入器 */
function beginStream(res, ctx = {}) {
  res.status(200).set(SSE_HEADERS);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return createStreamWriter(res, ctx);
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
  const model = responseModel(ctx, ctx && ctx.upstreamModel);
  if (model !== undefined && model !== null) chunk.model = model;
  return chunk;
}

// ============================================================ 假数据端点
// 有些客户端上来先探测用量/额度，真值我们没有（上游也不给），给零值占位比 404 友好。

function fakeUsagePayload() {
  return { object: 'list', data: [], has_more: false, total_usage: 0, daily_costs: [] };
}

function fakeBillingPayload() {
  return {
    object: 'billing_subscription',
    plan: { title: 'self-hosted', id: 'self-hosted' },
    hard_limit_usd: null,
    soft_limit_usd: null,
    system_hard_limit_usd: null,
    access_until: null,
    has_payment_method: false,
  };
}

function fakeCreditsPayload() {
  return {
    object: 'credit_summary',
    total_granted: 0,
    total_used: 0,
    total_available: 0,
    credit_grants: [],
  };
}

module.exports = {
  SERVICE_NAME,
  // 错误
  sendError,
  forwardUpstreamError,
  setRetryAfter,
  // 模型列表
  modalityFields,
  contextFields,
  modelListPayload,
  // 响应
  sendPayload,
  beginStream,
  createStreamWriter,
  usageChunk,
  // 假数据端点
  fakeUsagePayload,
  fakeBillingPayload,
  fakeCreditsPayload,
};
