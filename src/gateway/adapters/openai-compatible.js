'use strict';

/**
 * openai-compatible：覆盖绝大多数平台（NVIDIA NIM / ModelScope / 各家中转……）。
 * 请求与响应都**原样透传**，只改模型名、只删本服务自己的扩展字段。
 */

const { responseModel } = require('./common');

/**
 * chat/completions 的请求体**不删字段**（各家兼容实现各有所需），
 * 只清掉流式开关和本服务扩展字段。
 */
function buildChatRequest(provider, realModelId, clientBody, { stream = false } = {}) {
  const url = `${String(provider.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;

  const payload = { ...clientBody, model: realModelId };
  if (stream) {
    payload.stream = true;
  } else {
    delete payload.stream;
    delete payload.stream_options;
  }
  // 本服务的扩展字段不外传
  delete payload.aggregator;
  return { url, headers, payload };
}

function buildProbeRequest(provider, realModelId) {
  const url = `${String(provider.baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return {
    url,
    headers,
    payload: {
      model: realModelId,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
    },
  };
}

/** 上游本来就是 OpenAI 形状：只把模型名换成客户端请求的那个 */
function normalizeResponse(json, ctx) {
  if (!json || typeof json !== 'object') return null;
  const out = { ...json };
  const model = responseModel(ctx, json.model);
  if (model === undefined || model === null) delete out.model;
  else out.model = model;
  return out;
}

function normalizeStreamData(data, ctx) {
  if (data === '[DONE]') return { chunks: ['[DONE]'] };
  let payload;
  try {
    payload = JSON.parse(data);
  } catch (err) {
    return { passthrough: true }; // 不是 JSON：原样透传（有些平台会发非标准数据）
  }
  if (payload && typeof payload === 'object' && payload.model !== undefined) {
    // 指定来源：上游写啥就是啥；auto：改成客户端请求的名字
    payload.model = responseModel(ctx, payload.model);
  }
  return { chunks: [payload], usage: payload && payload.usage ? payload.usage : null };
}

module.exports = {
  id: 'openai-compatible',
  label: 'openai-compatible（OpenAI 兼容接口）',
  baseUrlHint: 'https://integrate.api.nvidia.com/v1',
  translates: false,
  buildChatRequest,
  buildProbeRequest,
  normalizeResponse,
  normalizeStreamData,
};
