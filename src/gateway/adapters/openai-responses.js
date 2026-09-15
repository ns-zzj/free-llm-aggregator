'use strict';

/**
 * openai-responses：OpenAI 的 **Responses API**（`POST {baseUrl}/responses`），用在**上游**。
 *
 * 翻译逻辑在 `src/protocol/responsesMapping.js`（那边也服务"下游 Responses 面"，
 * 一套 chat↔Responses 的映射两个方向共用，免得两边漂移）。这里只负责：
 *   - 拼 URL 和请求头（`{baseUrl}/responses`、Bearer、SSE 的 accept）
 *   - 把 `store` 钉死成 `false`（网关无状态，不替用户在上游留会话）、流式开关
 *   - 流式状态（工具调用要跨事件记住 output_index → tool_calls index）
 *   - HTTP 200 但 `status:'failed'` 这种"body 里说失败"的判定
 *
 * 只给"上游真的提供 Responses"的来源用（OpenAI 官方、Azure OpenAI 那类）；
 * 绝大多数免费第三方只提供 chat/completions，那种继续用 openai-compatible。
 *
 * 两条硬规矩（用户 2026-09-15 裁定）：
 *   1. 一定带 `store: false`；
 *   2. 不吃 `previous_response_id`（无状态网关，客户端必须自带完整 input）。
 */

const mapping = require('../../protocol/responsesMapping');
const { firstLineOf, chunkOf, responseModel, PROBE_MAX_TOKENS } = require('./common');

/**
 * baseUrl 是**完整前缀**（`https://api.openai.com/v1`），我们只在后面拼 `/responses`，
 * 不替用户补 `/v1`（用户 2026-09-15 定：补不补由用户自己看，后台那一格下面会显示拼出来的地址）。
 */
function responsesUrl(provider) {
  return `${String(provider.baseUrl).replace(/\/+$/, '')}/responses`;
}

function headersFor(provider, stream) {
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

function buildChatRequest(provider, realModelId, clientBody, { stream = false } = {}) {
  const payload = mapping.chatRequestToResponses(clientBody, realModelId);
  if (stream) payload.stream = true;
  // 上游不支持、或者会改变语义的字段，明确清掉
  delete payload.n; // Responses 没有"多个候选"这回事
  return { url: responsesUrl(provider), headers: headersFor(provider, stream), payload };
}

/**
 * 探测用请求：上限给 PROBE_MAX_TOKENS（1024）—— 它是上限不是计费量，给足才不会
 * "思考把预算吃光"或"被严格的实现以 400 拒掉"（见 common.js 里的说明）。
 */
function buildProbeRequest(provider, realModelId) {
  return {
    url: responsesUrl(provider),
    headers: headersFor(provider, false),
    payload: {
      model: realModelId,
      input: 'ping',
      max_output_tokens: PROBE_MAX_TOKENS,
      store: false,
      stream: false,
    },
  };
}

/** Responses 的响应 → chat.completion（model 字段的写法按 responseModel 的规矩） */
function normalizeResponse(json, ctx) {
  const out = mapping.responsesResponseToChat(json, ctx);
  if (!out) return null;
  const model = responseModel(ctx, json.model);
  if (model === undefined || model === null) delete out.model;
  else out.model = model;
  return out;
}

/** 工具调用要跨事件记状态：Responses 的 `output_index` → OpenAI 的 tool_calls index */
function streamState(ctx) {
  if (!ctx.responsesState) ctx.responsesState = { toolCursor: 0, byIndex: new Map() };
  return ctx.responsesState;
}

/** 一条 `data:` 负载 → chat chunk（约定见 adapters/common.js） */
function normalizeStreamData(data, ctx) {
  let evt;
  try {
    evt = JSON.parse(data);
  } catch (err) {
    return null; // Responses 的 data 一定是 JSON
  }
  return mapping.responsesEventToChat(evt, ctx, streamState(ctx), (delta, finish) => chunkOf(ctx, delta, finish));
}

/**
 * HTTP 200 但 body 里说失败（Responses 会在 `status: 'failed'` 时带 `error`）。
 * 签名是 `bodyError(text)` —— 门面只传文本进来。
 */
function bodyError(text) {
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.error && !Array.isArray(parsed.output)) {
    return { type: 'upstream_body_error', message: firstLineOf(JSON.stringify({ error: parsed.error })) || '上游返回失败' };
  }
  if (parsed.status === 'failed') {
    return { type: 'upstream_body_error', message: firstLineOf(text) || '上游返回失败' };
  }
  return null;
}

module.exports = {
  id: 'openai-responses',
  label: 'openai-responses（OpenAI Responses API）',
  baseUrlHint: 'https://api.openai.com/v1',
  translates: true,
  buildChatRequest,
  buildProbeRequest,
  normalizeResponse,
  normalizeStreamData,
  bodyError,
};
