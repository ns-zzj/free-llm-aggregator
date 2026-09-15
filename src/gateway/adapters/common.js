'use strict';

/**
 * 适配器共用的工具函数。
 *
 * 一个适配器要提供：
 *   buildChatRequest(provider, realModelId, clientBody, { stream })  → { url, headers, payload }
 *   buildProbeRequest(provider, realModelId)                         → { url, headers, payload }
 *   normalizeResponse(json, ctx)                                     → OpenAI 形状的响应对象；认不出来返回 null
 *   normalizeStreamData(data, ctx)                                   → { chunks: [...] }（见下）
 *
 * normalizeStreamData 的返回值约定：
 *   { chunks: [<OpenAI 形状的 chunk 对象>, '[DONE]'] }  正常翻译
 *   { passthrough: true }                              这一行不认识，原样透传
 *   { error: '...' }                                   上游在流里报了错
 *   null                                               这一行直接丢掉（心跳之类）
 * 另外可以带 usage（{prompt_tokens}/{completion_tokens}），由 pipeSse 累加。
 *
 * 翻译型适配器（非 OpenAI 协议）还要声明 `translates = true`，
 * 这样 pipeSse 会把上游的 `event:` 之类的行丢掉，只输出我们生成的 `data:` 行。
 */

const DEFAULT_MAX_TOKENS = 4096;

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

function firstLineOf(text) {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const msg = parsed?.error?.message || parsed?.message;
    if (msg) return String(msg).slice(0, 300);
  } catch (err) {
    /* 不是 JSON，按文本处理 */
  }
  return String(text).split('\n')[0].slice(0, 300);
}

/**
 * 响应里的 `model` 字段怎么写（用户裁定 2026-09-11）：
 *   pinned（指定了来源）→ **上游写啥就是啥**，上游没写就没有（不篡改用户的数据）
 *   auto（虚拟模型）    → 保持客户端请求的名字；否则客户端把响应里的真实模型名回填到
 *                        下一次请求就会 404（裸名字是明确不接受的）
 * 返回 undefined 表示这个字段不该出现。
 */
function responseModel(ctx, upstreamModel) {
  if (ctx && ctx.mode === 'pinned') return upstreamModel;
  return (ctx && ctx.requestedModel) || upstreamModel;
}

/** 造一个 OpenAI 形状的流式 chunk（model 字段按上面的规则；上游没给就不带） */
function chunkOf(ctx, delta, finishReason = null, extra = {}) {
  const chunk = {
    id: (ctx && ctx.chunkId) || `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra,
  };
  const model = responseModel(ctx, ctx && ctx.upstreamModel);
  if (model !== undefined && model !== null) chunk.model = model;
  return chunk;
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

module.exports = { DEFAULT_MAX_TOKENS, joinUrl, firstLineOf, chunkOf, responseModel, positiveInt };
