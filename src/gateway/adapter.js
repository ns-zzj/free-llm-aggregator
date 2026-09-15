'use strict';

/**
 * 上游适配器门面：按 `provider.adapter` 分发到具体协议实现（见 ./adapters/）。
 *
 * 已实现：
 *   - openai-compatible       覆盖绝大多数平台（NVIDIA NIM / ModelScope / 各家中转……），请求响应原样透传
 *   - openai-responses        OpenAI 的 Responses API（`{baseUrl}/responses`）：input/instructions + output items
 *   - anthropic               Anthropic Messages API（`{baseUrl}/messages`），翻译成 OpenAI 形状
 *   - cloudflare-workers-ai   Cloudflare Workers AI（`/accounts/{id}/ai/run/{model}`），同样翻译
 *
 * 新增协议的做法：在 ./adapters/ 下加一个实现并注册进 ./adapters/index.js，
 * 后台下拉框会自动多出这个选项（白名单来自同一个注册表）。
 */

const registry = require('./adapters');
const logger = require('../logger');
const { joinUrl, responseModel } = require('./adapters/common');

const DEFAULT_TIMEOUT_MS = 120000;

const QUOTA_KEYWORDS = [
  'insufficient_quota',
  'quota',
  'resource_exhausted',
  'allocationquota',
  'insufficient credit',
  'credits',
  'daily limit',
  'limit reached',
  'out of capacity',
  '余额不足',
  '额度',
];

const ADAPTER_IDS = registry.ids;
const DEFAULT_ADAPTER = registry.DEFAULT_ADAPTER;

function adapterFor(provider) {
  return registry.get(provider && provider.adapter);
}

function buildChatRequest(provider, realModelId, clientBody, options) {
  return adapterFor(provider).buildChatRequest(provider, realModelId, clientBody || {}, options || {});
}

function buildProbeRequest(provider, realModelId) {
  return adapterFor(provider).buildProbeRequest(provider, realModelId);
}

/**
 * 把上游响应翻译成 OpenAI 形状；认不出来返回 null
 * （调用方按"上游返回了无法解析的内容"处理：自动换源 / 指定来源时报错）
 */
function normalizeResponse(provider, json, ctx) {
  return adapterFor(provider).normalizeResponse(json, ctx || {});
}

/** 把上游 SSE 的一条 data 负载翻译成 OpenAI chunk（约定见 ./adapters/common.js） */
function normalizeStreamData(provider, data, ctx) {
  return adapterFor(provider).normalizeStreamData(data, ctx || {});
}

/** 翻译型适配器：上游的 `event:` 之类要丢掉，只输出我们生成的 `data:` 行 */
function translatesStream(provider) {
  return !!adapterFor(provider).translates;
}

/** HTTP 200 但 body 里说失败（Workers AI 会这样）；没有这种协议的适配器返回 null */
function bodyError(provider, text) {
  const impl = adapterFor(provider);
  return typeof impl.bodyError === 'function' ? impl.bodyError(text) : null;
}

/**
 * 归类上游错误：
 *  - retryable=true  → 换下一个源
 *  - retryable=false → 说明这个请求本身有问题（内容被拒/参数错误），换源也解决不了，直接返回客户端
 *  - forcePolicy='stop_manual' → 认证类错误（key 失效），探测无意义，直接停用到人工处理
 * 传了 provider 时，先让该协议的适配器有机会改写（例如 CF 把 "no such model" 当 not_found）。
 */
function classifyError(status, bodyText, provider) {
  const base = classifyErrorBase(status, bodyText);
  const impl = provider ? adapterFor(provider) : null;
  if (impl && typeof impl.classifyError === 'function') {
    return impl.classifyError(status, bodyText, classifyErrorBase) || base;
  }
  return base;
}

function classifyErrorBase(status, bodyText) {
  const text = String(bodyText || '');
  const lower = text.toLowerCase();
  const isQuota = QUOTA_KEYWORDS.some((kw) => lower.includes(kw));

  if (status === 401 || status === 403) {
    if (isQuota) {
      return { type: 'quota', retryable: true, message: '上游额度不足', forcePolicy: null };
    }
    return { type: 'auth', retryable: true, message: '上游拒绝：密钥无效或无权限', forcePolicy: 'stop_manual' };
  }
  if (status === 402) {
    return { type: 'quota', retryable: true, message: '上游额度/余额不足', forcePolicy: null };
  }
  if (status === 429) {
    return { type: 'rate_limit', retryable: true, message: '上游限流', forcePolicy: null };
  }
  if (status === 404) {
    // 404 = 上游明确说"没有这个模型"：配置写错了（或模型下线了），
    // 对路由来说是"这个来源给不了"→ 可以换源；但这个模型本身要转「需人工」，
    // 否则会一直被选到、每次白撞一次。
    return { type: 'not_found', retryable: true, message: '上游没有这个模型', forcePolicy: 'stop_manual' };
  }
  if (status >= 500) {
    return { type: 'server', retryable: true, message: `上游服务错误（HTTP ${status}）`, forcePolicy: null };
  }
  if (status === 400 || status === 422 || status === 413) {
    return { type: 'request', retryable: false, message: firstLineOf(text) || '请求被上游拒绝', forcePolicy: null };
  }
  return { type: 'unknown', retryable: true, message: `上游返回未知状态（HTTP ${status}）`, forcePolicy: null };
}

function classifyException(err) {
  const name = err?.name || '';
  const message = err?.message || String(err);
  if (name === 'AbortError' || /timeout/i.test(message)) {
    return { type: 'timeout', retryable: true, message: '上游超时' };
  }
  return { type: 'network', retryable: true, message: `连接上游失败：${message}` };
}

function firstLineOf(text) {
  if (!text) return '';
  try {
    const parsed = JSON.parse(text);
    const msg = parsed?.error?.message || parsed?.message || (parsed?.errors && parsed.errors[0] && parsed.errors[0].message);
    if (msg) return String(msg).slice(0, 300);
  } catch (err) {
    /* 不是 JSON，按文本处理 */
  }
  return String(text).split('\n')[0].slice(0, 300);
}

/**
 * 带超时的 fetch（Node 18+ 自带 fetch / AbortController）。
 *
 * **不跟随重定向**（审计 M5）：上游可以 302 到 http://169.254.169.254/… 之类的内网/元数据地址，
 * 而 openai-compatible 又会把任意 JSON 当补全结果转给调用方 —— 那就成了一条读内网的回路。
 * 上游是 LLM 接口，正常不会重定向，所以直接 `redirect: 'error'`。
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { redirect: 'error', ...options, signal: controller.signal });
  } catch (err) {
    logger.debug('上游请求失败', { url, error: err.message });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 流式请求：只在"等响应头"阶段限时，拿到响应头后交给调用方按需中止
 * （长生成不能被总超时掐掉；由空闲看门狗与客户端断连负责收尾）
 */
async function openStream(url, options = {}, { connectTimeoutMs = 60000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
  try {
    const response = await fetch(url, { redirect: 'error', ...options, signal: controller.signal });
    clearTimeout(timer);
    return { response, abort: () => controller.abort() };
  } catch (err) {
    clearTimeout(timer);
    logger.debug('上游流式请求失败', { url, error: err.message });
    throw err;
  }
}

/** 解析上游 SSE 的一行，返回 { event, data, raw } 或 null（空行/注释） */
function parseSseLine(line) {
  if (!line) return null;
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.trim()) return null;
  if (trimmed.startsWith(':')) return null; // 心跳注释
  if (!trimmed.startsWith('data:')) return { event: null, data: null, raw: trimmed };
  const data = trimmed.slice(5).replace(/^ /, '');
  return { event: null, data, raw: trimmed };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ADAPTER_IDS,
  DEFAULT_ADAPTER,
  adapterFor,
  /** 给后台下拉框用的协议清单（唯一出处是适配器注册表，前端别再抄一份） */
  describeAdapters: registry.describeAll,
  translateStreamData: normalizeStreamData,
  translatesStream,
  bodyError,
  joinUrl,
  responseModel,
  buildChatRequest,
  buildProbeRequest,
  normalizeResponse,
  normalizeStreamData,
  classifyError,
  classifyException,
  fetchWithTimeout,
  openStream,
  parseSseLine,
};
