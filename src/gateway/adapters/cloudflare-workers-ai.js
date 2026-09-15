'use strict';

/**
 * cloudflare-workers-ai：Cloudflare Workers AI（`POST {baseUrl}/accounts/{账号}/ai/run/{模型}`）。
 *
 * 和 OpenAI 的差异：
 *   - 模型名在**路径**里（形如 `@cf/meta/llama-3.1-8b-instruct`），请求体里不传 model
 *   - 账号 ID 是地址的一部分：后台填「账号 ID」即可，baseUrl 固定 `https://api.cloudflare.com/client/v4`
 *   - 鉴权就是 `Authorization: Bearer <API Token>`
 *   - 响应是 `{result:{response:"..."}, success:true, errors:[]}`；用量在 `result.usage`
 *   - 流式 SSE 的每一条是 `{"response":"增量","usage":{...}}`，最后 `data: [DONE]`
 *   - 出错时可能 HTTP 200 但 `success:false`（下面 bodyError 专门处理这种）
 */

/**
 * Workers AI 的 `/ai/run` 有**两种返回方言**（都是真机验证过的）：
 *
 *   方言 A「经典」：`{result:{response:"文本"}}`，流式每块 `{"response":"增量"}`
 *      —— 老的文本生成模型（llama-3.1-8b-instruct 等）
 *
 *   方言 B「OpenAI 形状」：`{result:{choices:[{message:{content, reasoning}}]}}`，
 *      流式是 `{"choices":[{"delta":{"content"/"reasoning":"增量"}}]}`，
 *      收尾再补一个方言 A 的 `{"response":"","usage":{...}}`（累计用量）
 *      —— 较新的模型（`@cf/nvidia/nemotron-3-120b-a12b` 等）
 *      ⚠️ 方言 B 的两个坑：`content` 可能是 **null**（推理模型的 token 全花在思考上），
 *         推理内容叫 `reasoning`（不是 OpenAI 的 `reasoning_content`）。
 *
 *   方言 C「Responses API」：`{result:{output:[...]}}` / 流式 `response.output_text.delta`
 *      —— 少数新模型（gpt-oss 系）。**这条没真机验证过**，只做了容错解析，认不出来就返回 null。
 */

const { firstLineOf, chunkOf, responseModel, positiveInt, PROBE_MAX_TOKENS } = require('./common');
const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
/**
 * 客户端没传输出上限时填的值（用户 2026-09-15 定：2048 → 8192）。
 * 只有"客户端没传 max_tokens"时才用得上；传了永远客户端说了算。
 * CF 上不同模型的输出上限差别很大，真碰上某个小模型报"超过上限"的 400，改这个值
 * 或者把它做成"每个提供商可配"即可。
 */
const DEFAULT_MAX_TOKENS = 8192;

// Workers AI 只认这些参数，其它字段传过去可能被拒（OpenAI 的扩展字段尤其）
const ALLOWED_PARAMS = [
  'messages',
  'stream',
  'max_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'top_k',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'response_format',
  'tools',
  'tool_choice',
];

function runUrl(provider, realModelId) {
  const base = String(provider.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const accountId = String(provider.accountId || '').trim();
  const path = accountId ? `/accounts/${accountId}/ai/run/${realModelId}` : `/ai/run/${realModelId}`;
  return `${base}${path}`;
}

function headersFor(provider, stream) {
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

function buildPayload(clientBody, stream, maxTokensDefault) {
  const payload = {};
  for (const key of ALLOWED_PARAMS) {
    if (clientBody[key] !== undefined) payload[key] = clientBody[key];
  }
  if (payload.messages === undefined) payload.messages = [{ role: 'user', content: 'ping' }];
  payload.max_tokens = positiveInt(payload.max_tokens ?? payload.max_completion_tokens, maxTokensDefault);
  delete payload.max_completion_tokens;
  if (stream) payload.stream = true;
  else delete payload.stream;
  return payload;
}

function buildChatRequest(provider, realModelId, clientBody, { stream = false } = {}) {
  return {
    url: runUrl(provider, realModelId),
    headers: headersFor(provider, stream),
    payload: buildPayload(clientBody, stream, DEFAULT_MAX_TOKENS),
  };
}

function buildProbeRequest(provider, realModelId) {
  return {
    url: runUrl(provider, realModelId),
    headers: headersFor(provider, false),
    payload: { messages: [{ role: 'user', content: 'ping' }], max_tokens: PROBE_MAX_TOKENS },
  };
}

/** 从 message/顶层里取推理内容（两种命名都认） */
function reasoningOf(src, fallbackSrc) {
  if (typeof src.reasoning === 'string' && src.reasoning) return src.reasoning;
  if (typeof src.reasoning_content === 'string' && src.reasoning_content) return src.reasoning_content;
  if (fallbackSrc) return reasoningOf(fallbackSrc, null);
  return null;
}

/** 方言 C：Responses API 的文本 */
function responsesApiText(result) {
  if (typeof result.output_text === 'string' && result.output_text) return result.output_text;
  if (!Array.isArray(result.output)) return null;
  const parts = [];
  for (const item of result.output) {
    if (!item || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (block && block.type === 'output_text' && typeof block.text === 'string') parts.push(block.text);
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.length ? parts.join('') : null;
}

function usageOf(usage) {
  if (!usage) return null;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  if (!prompt && !completion) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: Number(usage.total_tokens) || prompt + completion,
  };
}

function normalizeResponse(json, ctx) {
  if (!json || typeof json !== 'object') return null;
  if (json.success === false) return null; // 200 但业务失败：交给上层当"上游返回了无法解析的内容"处理
  const result = json.result;
  if (!result || typeof result !== 'object') return null;

  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  const message = choice && choice.message && typeof choice.message === 'object' ? choice.message : null;

  let text = null;
  let reasoning = null;
  let finishReason = 'stop';
  let toolCalls = null;

  if (message) {
    // 方言 B：OpenAI 形状（content 可能是 null，推理模型的正文要等思考完才出）
    text = typeof message.content === 'string' ? message.content : '';
    reasoning = reasoningOf(message, result);
    finishReason = choice.finish_reason || 'stop';
    // 工具调用：这一层本来就是 OpenAI 形状，原样透传（别重建消息把它丢掉）
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) toolCalls = message.tool_calls;
  } else if (typeof result.response === 'string') {
    // 方言 A：经典（工具调用在 result 顶层）
    text = result.response;
    reasoning = reasoningOf(result, null);
    if (Array.isArray(result.tool_calls) && result.tool_calls.length) toolCalls = result.tool_calls;
  } else if (result.response !== undefined && result.response !== null) {
    text = JSON.stringify(result.response);
  } else {
    // 方言 C：Responses API
    text = responsesApiText(result);
    reasoning = reasoningOf(result, null);
  }

  if (text === null && !reasoning && !toolCalls) return null;
  if (text === null) text = '';

  const usage = usageOf(result.usage) || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const outMessage = { role: 'assistant', content: text };
  if (reasoning) {
    // 两种命名都给：有的客户端认 reasoning_content（DeepSeek 那套），有的直接认 reasoning
    outMessage.reasoning_content = reasoning;
    outMessage.reasoning = reasoning;
  }
  if (toolCalls) outMessage.tool_calls = toolCalls;
  const out = {
    id: (result.id && String(result.id)) || (json.id && String(json.id)) || `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Number(result.created) || Math.floor(Date.now() / 1000),
    choices: [{ index: 0, message: outMessage, finish_reason: finishReason }],
    usage,
  };
  // 指定来源：上游写啥就是啥（没写就不带这个字段）；auto：保持客户端请求的名字
  const model = responseModel(ctx, result.model);
  if (model !== undefined && model !== null) out.model = model;
  return out;
}

function normalizeStreamData(data, ctx) {
  if (data === '[DONE]') return { chunks: ['[DONE]'] };
  let payload;
  try {
    payload = JSON.parse(data);
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.success === false) {
    const msg = firstLineOf(JSON.stringify({ error: (payload.errors && payload.errors[0]) || {} }));
    return { error: msg || '上游在流里报了错' };
  }
  // 上游的真实模型名（方言 B 的每块都带），记在 ctx 上给后续 chunk 共用
  if (typeof payload.model === 'string' && payload.model) ctx.upstreamModel = payload.model;

  // 方言 B：OpenAI 形状的 chunk（含 reasoning 增量、tool_calls 参数碎片）
  if (Array.isArray(payload.choices)) {
    const choice = payload.choices[0] || {};
    const delta = choice.delta || {};
    const out = {};
    if (typeof delta.content === 'string' && delta.content) out.content = delta.content;
    const reasoning = reasoningOf(delta, null);
    if (reasoning) {
      // 两种命名都给：CF 自己叫 reasoning，客户端多数认 reasoning_content
      out.reasoning_content = reasoning;
      out.reasoning = reasoning;
    }
    // 工具调用：本来就是 OpenAI 形状的碎片，原样透传（含 id/name/arguments 分片）
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) out.tool_calls = delta.tool_calls;
    const chunks = [];
    if (Object.keys(out).length) chunks.push(chunkOf(ctx, out, choice.finish_reason || null));
    else if (choice.finish_reason) chunks.push(chunkOf(ctx, {}, choice.finish_reason));
    return { chunks, usage: usageOf(payload.usage) };
  }

  // 方言 C：Responses API 事件
  if (typeof payload.type === 'string' && payload.type.startsWith('response.')) {
    if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string') {
      return { chunks: [chunkOf(ctx, { content: payload.delta })] };
    }
    if (payload.type === 'response.completed' || payload.type === 'response.done') {
      const usage = payload.response && payload.response.usage ? payload.response.usage : null;
      const mapped = usage
        ? {
            prompt_tokens: Number(usage.input_tokens) || 0,
            completion_tokens: Number(usage.output_tokens) || 0,
          }
        : null;
      return { chunks: [chunkOf(ctx, {})], usage: mapped };
    }
    return { chunks: [] };
  }

  // 方言 A：经典（收尾那一块也长这样，自带累计用量，正好覆盖前面 OpenAI chunk 的碎片用量）
  if (payload.response !== undefined) {
    const text = typeof payload.response === 'string' ? payload.response : JSON.stringify(payload.response);
    const delta = {};
    if (text) delta.content = text;
    const reasoning = reasoningOf(payload, null);
    if (reasoning) {
      delta.reasoning_content = reasoning;
      delta.reasoning = reasoning;
    }
    return { chunks: Object.keys(delta).length ? [chunkOf(ctx, delta)] : [], usage: usageOf(payload.usage) };
  }

  return null;
}

/** HTTP 200 但 body 里说失败（Workers AI 有时这样） */
function bodyError(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return null;
  }
  if (!json || typeof json !== 'object') return null;
  if (json.success === false) {
    const first = (json.errors && json.errors[0]) || {};
    const message = first.message || (json.messages && json.messages[0] && json.messages[0].message) || '上游返回失败';
    const code = first.code || null;
    const type = /no such model|not found|unknown model/i.test(String(message)) ? 'not_found' : 'upstream_body_error';
    return { type, retryable: true, message: String(message).slice(0, 300), forcePolicy: null, code };
  }
  if (json.result === undefined || json.result === null) {
    return { type: 'upstream_body_error', retryable: true, message: '上游没有返回结果', forcePolicy: null };
  }
  return null;
}

/**
 * 错误归类（比通用规则多两条 Workers AI 特有的）：
 *   1) 400/404 说"没有这个模型" → 当 not_found（可换源），而不是"请求有问题"
 *   2) 403 + 提到付费计划 / 错误码 5035 → **免费计划跑不了这个模型**。
 *      这条归类很重要：它不是"密钥无效"，所以不能含糊地报 auth；
 *      同时它对这个模型是**永久性**的，所以 forcePolicy=stop_manual 直接转「故障（需人工）」，
 *      免得对着一个免费计划根本跑不了的模型一直探测。
 */
function classifyError(status, text, fallback) {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  if (/no such model|model not found|unknown model/.test(lower)) {
    return { type: 'not_found', retryable: true, message: '上游没有这个模型', forcePolicy: null };
  }
  if (status === 403 && /(paid plan|requires workers paid|upgrade|"code"\s*:\s*5035|5035)/.test(lower)) {
    const detail = firstLineOf(raw);
    return {
      type: 'plan_required',
      retryable: true, // 换下一个来源能解决，所以对 auto 要能继续换源
      message: `这个模型需要 Workers Paid 计划（免费计划不可用）${detail ? `：${detail}` : ''}`,
      forcePolicy: 'stop_manual', // 对该模型是永久性的：停用、不再探测
    };
  }
  return fallback(status, text);
}

module.exports = {
  id: 'cloudflare-workers-ai',
  label: 'cloudflare-workers-ai（Cloudflare Workers AI）',
  baseUrlHint: 'https://api.cloudflare.com/client/v4',
  needsAccountId: true,
  translates: true,
  buildChatRequest,
  buildProbeRequest,
  normalizeResponse,
  normalizeStreamData,
  bodyError,
  classifyError,
};
