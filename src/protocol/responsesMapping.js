'use strict';

/**
 * **chat/completions ↔ Responses 的翻译层**（一套代码，两个方向都用）
 *
 * 为什么单独一个文件：Responses 这层翻译有两个用户 ——
 *   ① 上游适配器（`src/gateway/adapters/openai-responses.js`）：内部形状 → Responses 请求、Responses 响应 → 内部形状
 *   ② 下游客户端面（`src/protocol/faces/openai-responses.js`）：Responses 请求 → 内部形状、内部响应 → Responses 形状
 * 两边要的映射**正好是互逆的**，写两遍迟早漂移（改了一边忘了另一边），所以放一处。
 *
 * 内部形状永远是 OpenAI chat completions（见 `src/gateway/adapters/common.js` 顶部的约定）。
 *
 * 字段对照（只列我们真的会翻的）：
 *   messages            ↔ input(items) + instructions
 *   max_tokens          ↔ max_output_tokens
 *   tools[]（套 function）↔ tools[]（扁平：type/name/parameters/strict）
 *   tool_calls / role:tool ↔ function_call / function_call_output items
 *   response_format     ↔ text.format
 *   prompt_tokens       ↔ input_tokens
 *   completion_tokens   ↔ output_tokens
 *   finish_reason       ↔ status / incomplete_details.reason
 */

const nodeCrypto = require('crypto');

// ============================================================ 小工具

function id(prefix) {
  return `${prefix}_${nodeCrypto.randomBytes(12).toString('hex')}`;
}

/** content（字符串 / parts 数组）→ 纯文本 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
        return String(part.text || '');
      }
      return '';
    })
    .join('');
}

function parseJsonObject(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function stringifyArguments(value) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value === undefined ? {} : value);
}

/**
 * Responses 响应对象的**完整骨架**（字段清单照着实测的真 API 抄的）。
 *
 * 为什么不能只给 id/output/usage 那几项：官方 SDK（以及用它的客户端，比如 Chatbox）
 * 会用 zod schema 校验事件与响应对象，**缺字段就判定非法、整条事件被丢掉** ——
 * 表现就是"调用成功但一个字都不显示"。实测对比过 DeepSeek 的真实返回，
 * 下面这些字段一个都不少。
 */
function responsesSkeleton({ id: responseId, model, status = 'in_progress', createdAt = null } = {}) {
  return {
    id: responseId,
    object: 'response',
    created_at: createdAt === null ? Math.floor(Date.now() / 1000) : createdAt,
    status,
    background: false,
    completed_at: null,
    content_filters: null,
    error: null,
    frequency_penalty: 0,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    max_tool_calls: null,
    model: model || '',
    moderation: null,
    output: [],
    parallel_tool_calls: true,
    presence_penalty: 0,
    previous_response_id: null,
    prompt_cache_key: null,
    prompt_cache_retention: null,
    reasoning: { effort: null, summary: null },
    safety_identifier: null,
    service_tier: null,
    store: false,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_logprobs: 0,
    top_p: 1,
    truncation: 'disabled',
    usage: null,
    user: null,
    metadata: {},
  };
}

/** output_text 内容块（`logprobs: []` 是官方形状的一部分，缺了 SDK 会报字段缺失） */
function outputTextPart(text) {
  return { type: 'output_text', annotations: [], logprobs: [], text: String(text || '') };
}

// ============================================================ 请求：chat → Responses（上游用）

/**
 * chat 的 content → Responses 的 content：
 * 纯文本给字符串（最好认）；带图才给 parts 数组（`input_text` + `input_image`）。
 */
function toResponsesContent(role, content) {
  if (typeof content === 'string') return content || null;
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if ((part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') {
      parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
      continue;
    }
    if (part.type === 'image_url' && part.image_url && part.image_url.url) {
      parts.push({ type: 'input_image', image_url: String(part.image_url.url) });
    }
  }
  if (!parts.length) return null;
  if (parts.every((p) => p.type !== 'input_image')) return parts.map((p) => p.text).join('');
  return parts;
}

/**
 * chat 的 `messages` → Responses 的 `instructions` + `input`：
 *   system / developer → instructions（多段用空行拼）
 *   tool（工具结果）   → function_call_output item
 *   助手的 tool_calls  → function_call item（排在助手正文前）
 *   其余               → { role, content }
 */
function chatMessagesToResponsesInput(messages) {
  const instructions = [];
  const input = [];
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || 'user');

    if (role === 'system' || role === 'developer') {
      const text = textOf(msg.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(msg.tool_call_id || ''),
        output: textOf(msg.content),
      });
      continue;
    }
    if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const call of msg.tool_calls) {
        if (!call || !call.function) continue;
        input.push({
          type: 'function_call',
          call_id: String(call.id || ''),
          name: String(call.function.name || ''),
          arguments: stringifyArguments(call.function.arguments),
        });
      }
    }
    const content = toResponsesContent(role, msg.content);
    if (content === null) continue;
    input.push({ role, content });
  }
  return { instructions: instructions.join('\n\n'), input };
}

/** chat 的 tools → Responses 的 tools（函数定义不再套一层 function） */
function chatToolsToResponses(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const tool of tools) {
    const fn = tool && tool.function ? tool.function : tool && tool.type === 'function' ? tool : null;
    if (!fn || !fn.name) continue;
    const entry = {
      type: 'function',
      name: String(fn.name),
      parameters: fn.parameters || { type: 'object', properties: {} },
      strict: fn.strict === true,
    };
    if (fn.description) entry.description = String(fn.description);
    out.push(entry);
  }
  return out.length ? out : null;
}

function chatToolChoiceToResponses(choice) {
  if (!choice) return null;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function' && choice.function && choice.function.name) {
    return { type: 'function', name: String(choice.function.name) };
  }
  return null;
}

/** chat 的 response_format → Responses 的 text.format */
function chatFormatToResponsesText(responseFormat) {
  if (!responseFormat || typeof responseFormat !== 'object') return null;
  if (responseFormat.type === 'json_object') return { type: 'json_object' };
  if (responseFormat.type === 'json_schema') {
    const schema = responseFormat.json_schema || {};
    const format = { type: 'json_schema', strict: schema.strict !== false };
    if (schema.name) format.name = String(schema.name);
    if (schema.description) format.description = String(schema.description);
    if (schema.schema) format.schema = schema.schema;
    return format;
  }
  return null;
}

/** chat 请求体 → Responses 请求体（不含 url / headers） */
function chatRequestToResponses(chatBody, model) {
  const body = chatBody || {};
  const { instructions, input } = chatMessagesToResponsesInput(body.messages);
  const payload = { model, input, store: false }; // store 恒为 false：网关无状态，不替用户在上游留会话
  if (instructions) payload.instructions = instructions;

  const maxOut = Number(body.max_completion_tokens) || Number(body.max_tokens) || 0;
  if (maxOut > 0) payload.max_output_tokens = Math.floor(maxOut);
  if (body.temperature !== undefined) payload.temperature = body.temperature;
  if (body.top_p !== undefined) payload.top_p = body.top_p;
  if (body.reasoning_effort) payload.reasoning = { effort: String(body.reasoning_effort) };

  const tools = chatToolsToResponses(body.tools);
  if (tools) payload.tools = tools;
  const toolChoice = chatToolChoiceToResponses(body.tool_choice);
  if (toolChoice) payload.tool_choice = toolChoice;
  const text = chatFormatToResponsesText(body.response_format);
  if (text) payload.text = { format: text };
  return payload;
}

// ============================================================ 响应：Responses → chat（上游用）

/** Responses 的响应体 → chat.completion；认不出来返回 null */
function responsesResponseToChat(json, ctx = {}) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.output)) return null;

  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const item of json.output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!part || typeof part !== 'object') continue;
        if (typeof part.text === 'string') text += part.text;
        else if (typeof part.refusal === 'string') text += part.refusal;
      }
      continue;
    }
    if (item.type === 'reasoning') {
      for (const part of [].concat(item.summary || [], item.content || [])) {
        if (part && typeof part.text === 'string') reasoning += part.text;
      }
      continue;
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: String(item.call_id || item.id || ''),
        type: 'function',
        function: { name: String(item.name || ''), arguments: stringifyArguments(item.arguments) },
      });
    }
  }

  const message = { role: 'assistant', content: text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;

  const usage = json.usage || {};
  const promptTokens = Number(usage.input_tokens) || 0;
  const completionTokens = Number(usage.output_tokens) || 0;
  const incompleteReason = (json.incomplete_details && json.incomplete_details.reason) || '';
  const finishReason = toolCalls.length ? 'tool_calls' : incompleteReason === 'max_output_tokens' ? 'length' : 'stop';

  const out = {
    id: json.id || id('chatcmpl'),
    object: 'chat.completion',
    created: Number(json.created_at) || Math.floor(Date.now() / 1000),
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: Number(usage.total_tokens) || promptTokens + completionTokens,
    },
  };
  if (json.model) out.model = json.model;
  return out;
}

/** Responses 的流事件 → chat chunk（上游用）；state 见 adapter 里的说明；chunkOf 由调用方给（要绑 ctx） */
function responsesEventToChat(evt, ctx, state, chunkOf) {
  if (!evt || typeof evt !== 'object') return null;
  const response = evt.response;
  if (response && response.model) ctx.upstreamModel = response.model;
  if (typeof chunkOf !== 'function') return null;

  switch (evt.type) {
    case 'response.created':
      return { chunks: [chunkOf({ role: 'assistant', content: '' })] };
    case 'response.output_text.delta':
      return typeof evt.delta === 'string' && evt.delta ? { chunks: [chunkOf({ content: evt.delta })] } : null;
    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      return typeof evt.delta === 'string' && evt.delta ? { chunks: [chunkOf({ reasoning_content: evt.delta })] } : null;
    case 'response.output_item.added': {
      const item = evt.item || {};
      if (item.type !== 'function_call') return null;
      const index = state.toolCursor;
      state.toolCursor += 1;
      state.byIndex.set(evt.output_index, index);
      return {
        chunks: [
          chunkOf({
            tool_calls: [
              {
                index,
                id: String(item.call_id || item.id || ''),
                type: 'function',
                function: { name: String(item.name || ''), arguments: '' },
              },
            ],
          }),
        ],
      };
    }
    case 'response.function_call_arguments.delta': {
      if (typeof evt.delta !== 'string' || !evt.delta) return null;
      const index = state.byIndex.has(evt.output_index) ? state.byIndex.get(evt.output_index) : 0;
      return { chunks: [chunkOf({ tool_calls: [{ index, function: { arguments: evt.delta } }] })] };
    }
    case 'response.completed': {
      const usage = (response && response.usage) || {};
      const patch = {};
      if (Number(usage.input_tokens)) patch.prompt_tokens = Number(usage.input_tokens);
      if (Number(usage.output_tokens)) patch.completion_tokens = Number(usage.output_tokens);
      const finished = state.toolCursor > 0 ? 'tool_calls' : 'stop';
      return { chunks: [chunkOf({}, finished), '[DONE]'], usage: Object.keys(patch).length ? patch : null };
    }
    case 'response.incomplete':
      return { chunks: [chunkOf({}, 'length'), '[DONE]'] };
    case 'response.failed':
    case 'error': {
      const err = evt.error || (response && response.error) || {};
      const message = err.message || err.code || '上游在流里报了错';
      return { error: String(message) };
    }
    default:
      return null;
  }
}

// ============================================================ 请求：Responses → chat（下游客户端面用）

/** Responses 的 tools → chat 的 tools（包回 function） */
function responsesToolsToChat(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const tool of tools) {
    if (!tool) continue;
    // 内建工具（web_search / file_search / code_interpreter…）我们给不了，直接丢掉，
    // 免得把"我们不支持的家伙"转成 function 骗上游。
    if (tool.type !== 'function') continue;
    const name = tool.name || (tool.function && tool.function.name);
    if (!name) continue;
    const entry = { type: 'function', function: { name: String(name) } };
    const params = tool.parameters || (tool.function && tool.function.parameters);
    entry.function.parameters = params || { type: 'object', properties: {} };
    const description = tool.description || (tool.function && tool.function.description);
    if (description) entry.function.description = String(description);
    out.push(entry);
  }
  return out.length ? out : null;
}

function responsesToolChoiceToChat(choice) {
  if (!choice) return null;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'function' && choice.name) return { type: 'function', function: { name: String(choice.name) } };
  return null;
}

/** Responses 的 text.format → chat 的 response_format */
function responsesTextToChatFormat(text) {
  const format = text && text.format;
  if (!format || typeof format !== 'object') return null;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name || 'response',
        schema: format.schema || { type: 'object' },
        strict: format.strict !== false,
      },
    };
  }
  return null;
}

/** Responses 的 input items → chat 的 messages */
function responsesInputToChatMessages(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: 'system', content: String(instructions) });

  const items = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
  let pendingToolCalls = null; // 同一轮里可能连着几个 function_call
  const flushToolCalls = () => {
    if (pendingToolCalls && pendingToolCalls.length) {
      messages.push({ role: 'assistant', content: '', tool_calls: pendingToolCalls });
    }
    pendingToolCalls = null;
  };

  for (const item of items) {
    if (item === null || item === undefined) continue;
    if (typeof item === 'string') {
      flushToolCalls();
      messages.push({ role: 'user', content: item });
      continue;
    }
    if (typeof item !== 'object') continue;

    if (item.type === 'function_call') {
      pendingToolCalls = pendingToolCalls || [];
      pendingToolCalls.push({
        id: String(item.call_id || item.id || ''),
        type: 'function',
        function: { name: String(item.name || ''), arguments: stringifyArguments(item.arguments) },
      });
      continue;
    }
    if (item.type === 'function_call_output') {
      flushToolCalls();
      messages.push({
        role: 'tool',
        tool_call_id: String(item.call_id || ''),
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
      continue;
    }
    if (item.type === 'reasoning') continue; // 思考项：我们没有对应的表示，丢掉

    // message item（input_text / input_image / output_text）
    flushToolCalls();
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'system' || item.role === 'developer' ? 'system' : 'user';
    if (typeof item.content === 'string') {
      messages.push({ role, content: item.content });
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    const parts = [];
    for (const part of item.content) {
      if (!part || typeof part !== 'object') continue;
      if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') {
        parts.push({ type: 'text', text: part.text });
      } else if (part.type === 'input_image' && part.image_url) {
        parts.push({ type: 'image_url', image_url: { url: String(part.image_url) } });
      }
    }
    if (!parts.length) continue;
    const asString = parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts;
    messages.push({ role, content: asString });
  }
  flushToolCalls();
  return messages;
}

/**
 * Responses 的请求体 → chat 请求体（下游客户端面用）。
 * 返回 `{ body }` 或 `{ error: { status, message } }`。
 *
 * 无状态网关的规矩（用户裁定）：`store` 我们不吃（恒等于关掉），`previous_response_id`
 * **明确报错**而不是装作支持 —— 装作支持的话客户端会以为上下文还在，实际丢了，比报错难查得多。
 */
function responsesRequestToChat(raw = {}) {
  const body = {};
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) return { error: { status: 400, message: '缺少 model 字段' } };
  body.model = model;

  if (raw.previous_response_id) {
    return {
      error: {
        status: 400,
        message:
          '本网关是无状态的：不支持 previous_response_id。请每次都把完整 input 传上来' +
          '（或者用 chat/completions 那套由客户端自己维护上下文）。',
        code: 'stateless_gateway',
      },
    };
  }

  const messages = responsesInputToChatMessages(raw.input, raw.instructions);
  if (!messages.some((m) => m.role !== 'system')) {
    return { error: { status: 400, message: '缺少 input 字段' } };
  }
  body.messages = messages;

  const maxOut = Number(raw.max_output_tokens);
  if (Number.isFinite(maxOut) && maxOut > 0) body.max_tokens = Math.floor(maxOut);
  if (raw.temperature !== undefined) body.temperature = raw.temperature;
  if (raw.top_p !== undefined) body.top_p = raw.top_p;
  if (raw.reasoning && raw.reasoning.effort) body.reasoning_effort = String(raw.reasoning.effort);

  const tools = responsesToolsToChat(raw.tools);
  if (tools) body.tools = tools;
  const toolChoice = responsesToolChoiceToChat(raw.tool_choice);
  if (toolChoice) body.tool_choice = toolChoice;
  const format = responsesTextToChatFormat(raw.text);
  if (format) body.response_format = format;
  if (raw.stream === true) body.stream = true;

  return { body };
}

// ============================================================ 响应：chat → Responses（下游客户端面用）

/** chat.completion → Responses 响应体 */
function chatResponseToResponses(payload, ctx = {}) {
  const choice = (payload.choices && payload.choices[0]) || {};
  const message = choice.message || {};
  const output = [];

  if (message.reasoning_content) {
    // 思考和流式那条路保持一致：放在 content 里的 reasoning_text 块（实测 DeepSeek 也是这个形状），
    // 而不是 summary —— summary 只有做了摘要的模型才有，原文放这儿客户端读不到。
    output.push({
      id: id('rs'),
      type: 'reasoning',
      status: 'completed',
      content: [{ type: 'reasoning_text', text: String(message.reasoning_content) }],
      summary: [],
    });
  }
  for (const call of message.tool_calls || []) {
    output.push({
      type: 'function_call',
      id: id('fc'),
      call_id: String(call.id || id('call')),
      name: (call.function && call.function.name) || '',
      arguments: stringifyArguments(call.function && call.function.arguments),
      status: 'completed',
    });
  }
  const hasVisible = String(message.content || '').length > 0;
  // 只有思考/工具、没有正文时不要硬塞一个空 message 项（真 API 在被截断时也只有 reasoning 项）
  if (hasVisible || output.length === 0) {
    output.push({
      type: 'message',
      id: id('msg'),
      role: 'assistant',
      status: 'completed',
      content: [outputTextPart(message.content)],
      phase: 'final_answer', // 实测真 API 会带这个字段（Codex 一类客户端会看）
    });
  }

  const usage = payload.usage || {};
  const inputTokens = Number(usage.prompt_tokens) || 0;
  const outputTokens = Number(usage.completion_tokens) || 0;
  const finishReason = choice.finish_reason;
  const truncated = finishReason === 'length';

  const responseId = payload.id && /^resp_/.test(String(payload.id)) ? payload.id : id('resp');
  const out = responsesSkeleton({
    id: responseId,
    model: payload.model || ctx.requestedModel || '',
    status: truncated ? 'incomplete' : 'completed',
    createdAt: Number(payload.created) || Math.floor(Date.now() / 1000),
  });
  out.output = output;
  out.output_text = String(message.content || '');
  out.completed_at = truncated ? null : out.created_at;
  out.incomplete_details = truncated ? { reason: 'max_output_tokens' } : null;
  out.usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: Number(usage.total_tokens) || inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  return out;
}

module.exports = {
  // 通用小工具
  id,
  textOf,
  parseJsonObject,
  stringifyArguments,
  responsesSkeleton,
  outputTextPart,
  // 上游方向：chat ↔ Responses
  chatRequestToResponses,
  chatMessagesToResponsesInput,
  chatToolsToResponses,
  responsesResponseToChat,
  responsesEventToChat,
  // 下游方向：Responses ↔ chat
  responsesRequestToChat,
  responsesInputToChatMessages,
  responsesToolsToChat,
  chatResponseToResponses,
};
