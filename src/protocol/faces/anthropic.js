'use strict';

/**
 * 客户端面：**Anthropic Messages 方言**（挂在 `/anthropic`）
 *
 * 和 openai-chat 面一样，这个模块只管"客户端看到什么形状"：
 *   ① 进来：`POST /anthropic/messages` 的请求体 → 我们的内部形状（OpenAI chat completions）
 *   ② 出去：内部响应/流 → Anthropic 的 message / 命名事件 / 错误体
 *
 * 为什么能这么薄：核心逻辑（选源、换源、限速、记账）一行都不用改 —— `src/routes/v1.js`
 * 的 `chatCompletions` 已经被改成"可换面"的：路由把 `req.face` 换成这个面、
 * 把内部请求体放进 `req.internalBody` 就完事。
 *
 * 形状要点（对着 Anthropic 官方 Messages API）：
 *   - 请求：`system` 单独一个字段、`max_tokens` **必填**、content 是块数组（text/image/tool_use/tool_result）
 *   - 鉴权：`x-api-key`（Claude Code 走 ANTHROPIC_AUTH_TOKEN 时是 Bearer，两种都认）
 *   - 响应：`{ id:'msg_…', type:'message', role:'assistant', content:[…], stop_reason, usage:{input_tokens,output_tokens} }`
 *   - 流式：**命名事件** message_start → content_block_start/delta/stop → message_delta → message_stop
 *   - 错误：`{ type:'error', error:{ type, message } }`，类型名是 Anthropic 那一套
 *
 * 有意不做的事：
 *   - `thinking` 块：Anthropic 的思考块要签名（signature），我们没法给出合法的，所以既不收也不发
 *   - 非流式响应里不塞 `stop_sequence` 的值（我们没有"命中停止词"这个概念，给 null）
 */

const nodeCrypto = require('crypto');

// ============================================================ 小工具

function messageId() {
  return `msg_${nodeCrypto.randomBytes(12).toString('hex')}`;
}

function toolUseId() {
  return `toolu_${nodeCrypto.randomBytes(12).toString('hex')}`;
}

function parseJsonObject(value) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {}; // 参数是半截 JSON：给空对象，别让客户端解析崩掉
  }
}

/** 块数组（或字符串）→ 纯文本 */
function textOfBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      return '';
    })
    .join('');
}

/** Anthropic 的 image source → 我们自己用的 url（base64 走 data URL） */
function imageUrlOf(source) {
  if (!source || typeof source !== 'object') return '';
  if (source.type === 'base64' && source.data) {
    return `data:${source.media_type || 'image/png'};base64,${source.data}`;
  }
  if (source.type === 'url' && source.url) return String(source.url);
  return '';
}

/** 我们的 finish_reason → Anthropic 的 stop_reason */
function mapFinishReason(reason) {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    case 'stop':
      return 'end_turn';
    default:
      return reason ? 'end_turn' : null;
  }
}

/** HTTP 状态码/内部 type → Anthropic 的错误类型名 */
function mapErrorType(status) {
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 404) return 'not_found_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status >= 500) return 'api_error';
  return 'invalid_request_error';
}

// ============================================================ 进：请求解析

/**
 * Anthropic 的请求体 → 我们的内部形状（OpenAI chat completions）。
 * 返回 `{ body }` 或 `{ error: { status, message } }`。
 */
function parseBody(raw = {}) {
  const body = {};
  const model = typeof raw.model === 'string' ? raw.model.trim() : '';
  if (!model) return { error: { status: 400, message: 'model: field required' } };
  body.model = model;

  // Anthropic 的 max_tokens 是必填项（官方 API 就这么要求），我们照做，
  // 不然会把一个"缺参数"的请求原样塞给上游、换一堆源最后报 503。
  const maxTokens = Number(raw.max_tokens);
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return { error: { status: 400, message: 'max_tokens: field required (must be a positive integer)' } };
  }
  body.max_tokens = Math.floor(maxTokens);

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    return { error: { status: 400, message: 'messages: field required' } };
  }

  const messages = [];
  const systemText = textOfBlocks(raw.system);
  if (systemText) messages.push({ role: 'system', content: systemText });

  for (const msg of raw.messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content ?? '') }];

    const parts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text) parts.push({ type: 'text', text: block.text });
        continue;
      }
      if (block.type === 'image') {
        const url = imageUrlOf(block.source);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
        continue;
      }
      if (block.type === 'tool_use') {
        toolCalls.push({
          id: String(block.id || toolUseId()),
          type: 'function',
          function: {
            name: String(block.name || ''),
            arguments: JSON.stringify(block.input === undefined ? {} : block.input),
          },
        });
        continue;
      }
      if (block.type === 'tool_result') {
        // Anthropic 把工具结果放在 user 消息里；我们拆成独立的 tool 消息（内部形状的要求）
        toolResults.push({
          role: 'tool',
          tool_call_id: String(block.tool_use_id || ''),
          content: typeof block.content === 'string' ? block.content : textOfBlocks(block.content) || JSON.stringify(block.content ?? ''),
        });
        continue;
      }
      // thinking / redacted_thinking 之类：丢掉（见文件头说明）
    }

    // 工具结果要排在正文前面（它逻辑上发生在上一轮）
    for (const result of toolResults) messages.push(result);

    const asString = parts.every((p) => p.type === 'text') ? parts.map((p) => p.text).join('') : parts;
    const hasContent = typeof asString === 'string' ? asString.length > 0 : asString.length > 0;
    if (role === 'assistant') {
      if (!hasContent && !toolCalls.length) continue;
      const entry = { role: 'assistant', content: hasContent ? asString : '' };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      messages.push(entry);
      continue;
    }
    if (hasContent) messages.push({ role: 'user', content: asString });
  }

  if (!messages.some((m) => m.role !== 'system')) {
    return { error: { status: 400, message: 'messages: field required' } };
  }
  body.messages = messages;

  if (Array.isArray(raw.tools) && raw.tools.length) {
    const tools = [];
    for (const tool of raw.tools) {
      if (!tool || typeof tool !== 'object' || !tool.name) continue;
      const entry = {
        type: 'function',
        function: {
          name: String(tool.name),
          parameters: tool.input_schema || { type: 'object', properties: {} },
        },
      };
      if (tool.description) entry.function.description = String(tool.description);
      tools.push(entry);
    }
    if (tools.length) body.tools = tools;
  }

  if (raw.tool_choice && typeof raw.tool_choice === 'object') {
    const type = String(raw.tool_choice.type || 'auto');
    if (type === 'any') body.tool_choice = 'required';
    else if (type === 'tool' && raw.tool_choice.name) {
      body.tool_choice = { type: 'function', function: { name: String(raw.tool_choice.name) } };
    } else if (type === 'none') body.tool_choice = 'none';
    else body.tool_choice = 'auto';
  }

  if (raw.temperature !== undefined) body.temperature = raw.temperature;
  if (raw.top_p !== undefined) body.top_p = raw.top_p;
  if (Array.isArray(raw.stop_sequences) && raw.stop_sequences.length) body.stop = raw.stop_sequences;
  if (raw.stream === true) body.stream = true;

  return { body };
}

// ============================================================ 出：错误与响应

/** Anthropic 的错误形状：`{ type:'error', error:{ type, message } }` */
function sendError(res, status, message, { type = null, code = null } = {}) {
  const error = { type: type && /_error$/.test(String(type)) ? String(type) : mapErrorType(status), message: String(message) };
  if (code) error.code = code; // 多余字段不影响客户端，排查时有用
  return res.status(status).json({ type: 'error', error });
}

/** 上游错误：上游本来就是 Anthropic 形状就原样透传，否则翻成 Anthropic 错误体 */
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
  if (parsed && parsed.type === 'error' && parsed.error) return res.status(status).json(parsed);
  const message =
    (parsed && parsed.error && (parsed.error.message || parsed.error.type)) ||
    (info && info.message) ||
    '上游返回错误';
  return sendError(res, status, String(message), { type: mapErrorType(status) });
}

function setRetryAfter(res, seconds) {
  if (seconds > 0) res.set('retry-after', String(seconds));
  return seconds;
}

/** 内部响应（chat.completion）→ Anthropic 的 message */
function toAnthropicMessage(payload, ctx = {}) {
  const choice = (payload.choices && payload.choices[0]) || {};
  const message = choice.message || {};
  const content = [];
  if (message.content) content.push({ type: 'text', text: String(message.content) });
  for (const call of message.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: String(call.id || toolUseId()),
      name: (call.function && call.function.name) || '',
      input: parseJsonObject(call.function && call.function.arguments),
    });
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const usage = payload.usage || {};
  return {
    id: messageId(),
    type: 'message',
    role: 'assistant',
    model: payload.model || ctx.requestedModel || '',
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens) || 0,
      output_tokens: Number(usage.completion_tokens) || 0,
    },
  };
}

/** 非流式出口 */
function sendPayload(res, payload, ctx = {}) {
  return res.json(toAnthropicMessage(payload, ctx));
}

// ============================================================ 出：流式（命名事件）

const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

function beginStream(res, ctx = {}) {
  res.status(200).set(SSE_HEADERS);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return createStreamWriter(res, ctx);
}

/**
 * 流式写入器：把内部的 OpenAI chunk 翻成 Anthropic 的命名事件。
 *
 * 状态（每次请求一份）：
 *   textIndex    —— 当前打开的 text 块（没什么可写时不开）
 *   blockCursor  —— 下一个块号
 *   openTool     —— 当前打开的工具块（OpenAI 按 index 交错，Anthropic 的块是顺序的）
 *   usage        —— 攒起来，message_delta 里一起发
 *
 * 事件序列：message_start → [content_block_start/delta/stop 若干] → message_delta → message_stop
 */
function createStreamWriter(res, ctx = {}) {
  const id = messageId();
  const model = ctx.requestedModel || '';
  const state = {
    started: false,
    textIndex: null,
    blockCursor: 0,
    openTool: null,
    stopReason: null,
    sawTool: false,
    errored: false,
    finished: false,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  const send = (event, payload) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify({ type: event, ...payload })}\n\n`);
  };

  const ensureStart = () => {
    if (state.started) return;
    state.started = true;
    send('message_start', {
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: state.usage.input_tokens, output_tokens: 0 },
      },
    });
  };

  const openText = () => {
    if (state.textIndex !== null) return;
    state.textIndex = state.blockCursor;
    state.blockCursor += 1;
    send('content_block_start', { index: state.textIndex, content_block: { type: 'text', text: '' } });
  };

  const closeText = () => {
    if (state.textIndex === null) return;
    send('content_block_stop', { index: state.textIndex });
    state.textIndex = null;
  };

  const openTool = (call) => {
    closeText();
    const index = state.blockCursor;
    state.blockCursor += 1;
    state.openTool = { oaiIndex: call.index === undefined ? 0 : call.index, index };
    state.sawTool = true;
    send('content_block_start', {
      index,
      content_block: {
        type: 'tool_use',
        id: String(call.id || toolUseId()),
        name: (call.function && call.function.name) || '',
        input: {},
      },
    });
    return index;
  };

  const closeTool = () => {
    if (!state.openTool) return;
    send('content_block_stop', { index: state.openTool.index });
    state.openTool = null;
  };

  const mergeUsage = (usage) => {
    if (!usage) return;
    if (usage.prompt_tokens !== undefined) state.usage.input_tokens = Number(usage.prompt_tokens) || 0;
    if (usage.completion_tokens !== undefined) state.usage.output_tokens = Number(usage.completion_tokens) || 0;
  };

  const finish = () => {
    if (state.finished) return;
    state.finished = true;
    if (state.errored) return; // 出错只发 error 事件，不再补收尾
    ensureStart();
    closeText();
    closeTool();
    const stopReason = state.stopReason || (state.sawTool ? 'tool_use' : 'end_turn');
    send('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: state.usage.output_tokens },
    });
    send('message_stop', {});
  };

  return {
    /** 一个内部 chunk（OpenAI chat.completion.chunk）→ 0~n 个 Anthropic 事件 */
    chunk(irChunk) {
      if (!irChunk || state.finished) return;
      // 流内错误（上面在流中途断掉时塞进来的那种）
      if (irChunk.error) {
        ensureStart();
        closeText();
        closeTool();
        send('error', {
          error: { type: 'api_error', message: String(irChunk.error.message || '上游错误') },
        });
        state.errored = true;
        return;
      }
      ensureStart();
      if (irChunk.usage) mergeUsage(irChunk.usage);

      const choice = irChunk.choices && irChunk.choices[0];
      if (!choice) return; // 只有 usage 的收尾 chunk：已经记下了
      const delta = choice.delta || {};

      if (typeof delta.content === 'string' && delta.content) {
        openText();
        send('content_block_delta', {
          index: state.textIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
      }

      for (const call of delta.tool_calls || []) {
        const oaiIndex = call.index === undefined ? 0 : call.index;
        if (!state.openTool || state.openTool.oaiIndex !== oaiIndex) {
          closeTool();
          openTool({ ...call, index: oaiIndex });
        }
        const args = call.function && call.function.arguments;
        if (args) {
          send('content_block_delta', {
            index: state.openTool.index,
            delta: { type: 'input_json_delta', partial_json: String(args) },
          });
        }
      }

      if (choice.finish_reason) state.stopReason = mapFinishReason(choice.finish_reason);
    },

    /** 用量：Anthropic 在 message_delta 里给，这里先攒着 */
    usage(usage) {
      mergeUsage(usage);
    },

    /** 上游的非 data 行：Anthropic 客户端不认，丢掉 */
    raw() {},

    /** 收尾（客户端的 message_stop 在这里发） */
    done() {
      finish();
    },

    /** 结束响应 */
    end() {
      finish();
      try {
        if (!res.writableEnded) res.end();
      } catch (err) {
        /* 客户端已经断开：忽略 */
      }
    },
  };
}

module.exports = {
  // 进
  parseBody,
  // 出
  sendError,
  forwardUpstreamError,
  setRetryAfter,
  sendPayload,
  beginStream,
  createStreamWriter,
  // 给测试/别处复用的小工具
  toAnthropicMessage,
  mapFinishReason,
  mapErrorType,
  textOfBlocks,
  imageUrlOf,
};
