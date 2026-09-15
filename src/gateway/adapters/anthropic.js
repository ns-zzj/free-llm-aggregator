'use strict';

/**
 * anthropic：Anthropic Messages API（`POST {baseUrl}/v1/messages`）。
 *
 * 和 OpenAI 的差异（我们负责翻译，客户端只看 OpenAI 形状）：
 *   - 鉴权用 `x-api-key`（同时带上 Authorization，兼容那些"Anthropic 兼容"中转）
 *   - system 提示词要单独放 `system` 字段，messages 里只能有 user/assistant 且要交替
 *   - `max_tokens` 必填
 *   - 响应是 `content: [{type:'text'|'thinking', ...}]`，用量是 input_tokens/output_tokens
 *   - 流式是 `event: content_block_delta` 这种命名事件，要翻成 OpenAI 的 chunk
 */

const { DEFAULT_MAX_TOKENS, firstLineOf, chunkOf, responseModel, positiveInt } = require('./common');

const ANTHROPIC_VERSION = '2023-06-01';

/** baseUrl 填 `https://api.anthropic.com` 或 `.../v1` 都行 */
function messagesUrl(provider) {
  const base = String(provider.baseUrl).replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
}

function headersFor(provider, stream) {
  const headers = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
  };
  if (provider.apiKey) {
    headers['x-api-key'] = provider.apiKey;
    headers.authorization = `Bearer ${provider.apiKey}`; // 兼容 Anthropic 兼容中转
  }
  return headers;
}

/** OpenAI 的 content（字符串或 parts 数组）→ Anthropic 的 content blocks 数组 */
function toBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text) {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url' && part.image_url && part.image_url.url) {
      const url = String(part.image_url.url);
      const dataUrl = url.match(/^data:([^;,]+);base64,(.*)$/);
      if (dataUrl) blocks.push({ type: 'image', source: { type: 'base64', media_type: dataUrl[1], data: dataUrl[2] } });
      else blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks;
}

/** OpenAI 的 arguments（JSON 字符串，可能是流式拼出来的）→ Anthropic 的 input（对象） */
function parseArguments(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {}; // 参数是半截 JSON：给空对象，别把上游搞 400
  }
}

/** Anthropic 的 tool_result 内容只接受字符串或块数组 */
function toToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const blocks = toBlocks(content);
    return blocks.length ? blocks : '';
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content);
}

/**
 * OpenAI messages → Anthropic messages。三处结构差异在这里对齐：
 *   1. `role:'tool'` 的消息 → **user 消息里的 tool_result 块**（用 tool_use_id 关联）
 *   2. `assistant.tool_calls` → assistant 消息里的 **tool_use 块**（arguments 字符串 → input 对象）
 *   3. 同角色相邻消息合并（Anthropic 要求 user/assistant 严格交替）
 */
function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];

  const append = (role, blocks) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
      return;
    }
    out.push({ role, content: blocks });
  };

  for (const msg of messages || []) {
    if (!msg) continue;
    const role = msg.role;

    if (role === 'system' || role === 'developer') {
      const text = typeof msg.content === 'string' ? msg.content : toBlocks(msg.content).map((b) => b.text || '').join('\n');
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'tool' || role === 'function') {
      const block = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || msg.name || '',
        content: toToolResultContent(msg.content),
      };
      if (msg.is_error) block.is_error = true;
      // 只往"纯工具结果的 user 消息"里合并；别把工具结果混进用户的正常提问
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (role === 'assistant') {
      const blocks = toBlocks(msg.content);
      for (const call of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
        if (!call) continue;
        const fn = call.function && typeof call.function === 'object' ? call.function : call;
        const name = fn.name || call.name;
        if (!name) continue;
        blocks.push({
          type: 'tool_use',
          id: call.id || call.tool_call_id || `toolu_${Math.random().toString(36).slice(2, 14)}`,
          name,
          input: parseArguments(fn.arguments !== undefined ? fn.arguments : fn.input),
        });
      }
      if (blocks.length === 0) continue;
      append('assistant', blocks);
      continue;
    }

    if (role === 'user') {
      const blocks = toBlocks(msg.content);
      if (blocks.length === 0) continue;
      append('user', blocks);
      continue;
    }
  }

  if (out.length === 0) out.push({ role: 'user', content: [{ type: 'text', text: 'ping' }] });
  if (out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  return { system: systemParts.join('\n\n'), messages: out };
}

/** OpenAI tools → Anthropic tools（去掉 type:'function' 那层包装，parameters → input_schema） */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool) continue;
    const fn = tool.type === 'function' && tool.function ? tool.function : tool;
    if (!fn || !fn.name) continue;
    const entry = { name: String(fn.name) };
    if (fn.description) entry.description = String(fn.description);
    entry.input_schema =
      fn.parameters && typeof fn.parameters === 'object' ? fn.parameters : { type: 'object', properties: {} };
    if (fn.strict !== undefined) entry.strict = !!fn.strict; // 有些中转会带，Anthropic 也认
    out.push(entry);
  }
  return out.length ? out : undefined;
}

/** OpenAI tool_choice → Anthropic tool_choice（三态 + 指定工具；parallel_tool_calls:false 一并带上） */
function toAnthropicToolChoice(choice, parallelToolCalls) {
  const disableParallel = parallelToolCalls === false ? { disable_parallel_tool_use: true } : {};
  if (choice === undefined || choice === null || choice === '' || choice === 'auto') {
    return { type: 'auto', ...disableParallel };
  }
  if (choice === 'required' || choice === 'any') return { type: 'any', ...disableParallel };
  if (choice === 'none') return { type: 'none' };
  if (typeof choice === 'object') {
    if (choice.type === 'function' && choice.function && choice.function.name) {
      return { type: 'tool', name: choice.function.name };
    }
    if (choice.type === 'tool' && choice.name) return { type: 'tool', name: choice.name };
    if (['auto', 'any', 'none'].includes(choice.type)) return { ...choice, ...disableParallel };
  }
  return { type: 'auto', ...disableParallel }; // 认不出来就交给上游自己决定
}

function buildPayload(provider, realModelId, clientBody, stream) {
  const { system, messages } = toAnthropicMessages(clientBody.messages);
  const payload = {
    model: realModelId,
    max_tokens: positiveInt(clientBody.max_tokens, DEFAULT_MAX_TOKENS),
    messages,
  };
  if (system) payload.system = system;
  if (clientBody.temperature !== undefined) payload.temperature = clientBody.temperature;
  if (clientBody.top_p !== undefined) payload.top_p = clientBody.top_p;
  if (clientBody.stop !== undefined) {
    payload.stop_sequences = Array.isArray(clientBody.stop) ? clientBody.stop : [clientBody.stop];
  }
  // 工具调用：有 tools 才谈 tool_choice（Anthropic 在没有 tools 时带 tool_choice 会报错）
  const tools = toAnthropicTools(clientBody.tools);
  if (tools) {
    payload.tools = tools;
    payload.tool_choice = toAnthropicToolChoice(clientBody.tool_choice, clientBody.parallel_tool_calls);
  } else if (clientBody.tool_choice === 'none') {
    payload.tool_choice = { type: 'none' };
  }
  if (stream) payload.stream = true;
  return payload;
}

function buildChatRequest(provider, realModelId, clientBody, { stream = false } = {}) {
  return {
    url: messagesUrl(provider),
    headers: headersFor(provider, stream),
    payload: buildPayload(provider, realModelId, clientBody, stream),
  };
}

function buildProbeRequest(provider, realModelId) {
  return {
    url: messagesUrl(provider),
    headers: headersFor(provider, false),
    payload: {
      model: realModelId,
      max_tokens: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    },
  };
}

function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return reason ? 'stop' : null;
  }
}

/** Anthropic 的 message 对象 → OpenAI 的 chat.completion（含 tool_use 块 → tool_calls） */
function normalizeResponse(json, ctx) {
  if (!json || json.type !== 'message' || !Array.isArray(json.content)) return null;
  const text = json.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
  const thinking = json.content.filter((b) => b && b.type === 'thinking').map((b) => b.thinking || '').join('');
  const toolCalls = json.content
    .filter((b) => b && b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: b.name, arguments: JSON.stringify(b.input === undefined ? {} : b.input) },
    }));
  const usage = json.usage || {};
  const promptTokens = Number(usage.input_tokens) || 0;
  const completionTokens = Number(usage.output_tokens) || 0;
  const message = { role: 'assistant', content: text };
  if (thinking) message.reasoning_content = thinking;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const out = {
    id: json.id || `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? 'tool_calls' : mapStopReason(json.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
  // 指定来源：上游写啥就是啥（没写就不带这个字段）；auto：保持客户端请求的名字
  const model = responseModel(ctx, json.model);
  if (model !== undefined && model !== null) out.model = model;
  return out;
}

/**
 * 流式：把 Anthropic 的命名事件翻成 OpenAI 的 chunk。
 *   message_start       → 一个只带 role 的 chunk（顺带取 input_tokens）
 *   content_block_start → 工具块开始时先给一个带 id + 函数名的 tool_calls 增量（arguments 为空）
 *   content_block_delta → content / reasoning_content / tool_calls.arguments 增量
 *   message_delta       → 带 finish_reason 的收尾 chunk（顺带取 output_tokens）
 *   message_stop        → [DONE]
 *   ping / content_block_stop / signature_delta → 丢掉
 *   error               → 交给上层按"流中途报错"处理
 *
 * 工具调用要跨事件记住状态（Anthropic 是"块事件流"，OpenAI 是"按 index 交错的 delta 碎片"），
 * 所以把每个 content block 的 index → OpenAI 的 tool_calls index 记在 ctx 上（ctx 是每次请求独有的）。
 */
function streamState(ctx) {
  if (!ctx.anthropicState) ctx.anthropicState = { toolCursor: 0, blocks: new Map() };
  return ctx.anthropicState;
}

function normalizeStreamData(data, ctx) {
  let evt;
  try {
    evt = JSON.parse(data);
  } catch (err) {
    return null; // Anthropic 的 data 一定是 JSON；解析不了就丢掉
  }
  if (!evt || typeof evt !== 'object') return null;
  const state = streamState(ctx);

  switch (evt.type) {
    case 'message_start': {
      const usage = (evt.message && evt.message.usage) || {};
      const promptTokens = Number(usage.input_tokens) || 0;
      // 上游的真实模型名只在 message_start 里出现，记在 ctx 上给后续 chunk 共用
      if (evt.message && evt.message.model) ctx.upstreamModel = evt.message.model;
      return {
        chunks: [chunkOf(ctx, { role: 'assistant', content: '' })],
        usage: promptTokens ? { prompt_tokens: promptTokens } : null,
      };
    }
    case 'content_block_start': {
      const block = evt.content_block || {};
      if (block.type !== 'tool_use') return { chunks: [] }; // 文本/思考块的内容走 delta，不用开场
      const toolIndex = state.toolCursor++;
      state.blocks.set(evt.index, toolIndex);
      return {
        chunks: [
          chunkOf(ctx, {
            tool_calls: [
              {
                index: toolIndex,
                id: block.id,
                type: 'function',
                function: { name: block.name || '', arguments: '' },
              },
            ],
          }),
        ],
      };
    }
    case 'content_block_delta': {
      const delta = evt.delta || {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        return { chunks: [chunkOf(ctx, { content: delta.text })] };
      }
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        return { chunks: [chunkOf(ctx, { reasoning_content: delta.thinking })] };
      }
      if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const toolIndex = state.blocks.has(evt.index) ? state.blocks.get(evt.index) : 0;
        return {
          chunks: [chunkOf(ctx, { tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] })],
        };
      }
      return { chunks: [] }; // signature_delta 之类，客户端不需要
    }
    case 'message_delta': {
      const usage = evt.usage || {};
      const completionTokens = Number(usage.output_tokens) || 0;
      return {
        chunks: [chunkOf(ctx, {}, mapStopReason(evt.delta && evt.delta.stop_reason))],
        usage: completionTokens ? { completion_tokens: completionTokens } : null,
      };
    }
    case 'message_stop':
      return { chunks: ['[DONE]'] };
    case 'error': {
      const error = evt.error || {};
      return { error: firstLineOf(JSON.stringify({ error })) || '上游在流里报了错' };
    }
    default:
      return { chunks: [] };
  }
}

module.exports = {
  id: 'anthropic',
  label: 'anthropic（Anthropic Messages API）',
  baseUrlHint: 'https://api.anthropic.com/v1',
  translates: true,
  buildChatRequest,
  buildProbeRequest,
  normalizeResponse,
  normalizeStreamData,
};
