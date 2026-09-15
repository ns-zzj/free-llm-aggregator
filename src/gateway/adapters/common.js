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

/**
 * 客户端**没传**输出上限时，我们替它填的值（只有 anthropic 上游用得上，
 * 因为 Anthropic 的 `max_tokens` 是必填项；其它协议我们不填，走上游自己的默认）。
 *
 * 为什么是 16384：小了会把回答截断（用户原话："2026 都过去四分之三了，别拿 Claude 3 Haiku 说事"），
 * 大了会超出上游的输出上限、被直接 400（更糟）。16384 对现在的 Claude 系
 * （Sonnet 4.x 能到 64k、Opus 32k）都吃得下；真碰上后面挂老模型或小模型的便宜中转，
 * 再把这个值改成「每个提供商可配」就行。
 */
const DEFAULT_MAX_TOKENS = 16384;

/**
 * 探测（「测试」按钮 / 倒计时探测）用的输出上限。
 *
 * 曾经是 1 或 16，想省点 token —— 但那是**上限**、不是计费量：探测发的是 "ping"，
 * 模型回几个 token 就停了，给 1 还是给 1024 花掉的钱几乎一样（用户原话："这能有一厘钱不"）。
 * 给太小反而有真麻烦：
 *   - 推理模型的思考也吃这个预算（DeepSeek 的 Responses：`max_output_tokens` 含思维链），
 *     16 会被思考吃光、正文一个字都不出；
 *   - 有些实现干脆拒掉过小的上限（400），于是"模型其实可用"却被探测判成故障。
 */
const PROBE_MAX_TOKENS = 1024;

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

module.exports = { DEFAULT_MAX_TOKENS, PROBE_MAX_TOKENS, joinUrl, firstLineOf, chunkOf, responseModel, positiveInt };
