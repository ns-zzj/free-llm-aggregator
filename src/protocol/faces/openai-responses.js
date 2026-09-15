'use strict';

/**
 * 客户端面：**OpenAI Responses 方言**（挂在 `/openai/responses`）
 *
 * 客户端说 Responses（新版 OpenAI SDK、Codex CLI、Agents SDK 那类），我们照收；
 * 内部形状仍然是 chat completions，翻译在 `src/protocol/responsesMapping.js` 里
 * （那边同时服务上游的 openai-responses 适配器 —— 一套映射两个方向共用）。
 *
 * 和 chat 面的差别：
 *   - 请求是 `input`(items) + `instructions`，不是 `messages`
 *   - 响应是 `output`(items) + `status` + `usage.input_tokens/output_tokens`，不是 `choices`
 *   - 流式是命名事件（`response.created` / `response.output_text.delta` / `response.completed`）
 *   - **无状态网关**：`store` 恒等于关掉，`previous_response_id` 直接 400（见 parseBody 的说明）
 */

const mapping = require('../responsesMapping');

// ============================================================ 进

/**
 * Responses 请求体 → 内部 chat 形状。
 * 返回 `{ body }` 或 `{ error: { status, message, code? } }`。
 */
function parseBody(raw = {}) {
  return mapping.responsesRequestToChat(raw);
}

// ============================================================ 出：错误与响应

/** Responses 的错误体就是 OpenAI 那套：`{ error: { message, type, code, param } }` */
function sendError(res, status, message, { type = null, code = null } = {}) {
  const errorType =
    type && /_error$/.test(String(type)) ? String(type) : status === 429 ? 'rate_limit_error' : status >= 500 ? 'server_error' : 'invalid_request_error';
  const error = { message: String(message), type: errorType, param: null, code: code || null };
  return res.status(status).json({ error });
}

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
  if (parsed && parsed.error && typeof parsed.error === 'object') {
    return res.status(status).json({ error: { param: null, code: null, ...parsed.error } });
  }
  return sendError(res, status, (info && info.message) || '上游返回错误');
}

function setRetryAfter(res, seconds) {
  if (seconds > 0) res.set('retry-after', String(seconds));
  return seconds;
}

/** 内部 chat.completion → Responses 响应体 */
function sendPayload(res, payload, ctx = {}) {
  return res.json(mapping.chatResponseToResponses(payload, ctx));
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
 * 流式写入器：内部的 chat chunk → Responses 的命名事件。
 *
 * 客户端的期望（按 OpenAI 的 Responses 流式规范）：
 *   response.created            ← 开头，带一个 status:in_progress 的 response 骨架
 *   response.output_item.added  ← 新增一个输出项（message / function_call）
 *   response.content_part.added ← message 项里的 output_text 部分开始
 *   response.output_text.delta  ← 正文增量
 *   response.function_call_arguments.delta ← 工具参数增量
 *   response.output_text.done / content_part.done / output_item.done ← 各自收尾
 *   response.completed          ← 带最终 output 与 usage
 *
 * 我们内部只有"一个助手消息 + 若干工具调用"，所以状态很简单：正文项一个、工具项按 index 建。
 */
function createStreamWriter(res, ctx = {}) {
  const responseId = mapping.id('resp');
  const model = ctx.requestedModel || '';
  const state = {
    started: false,
    finished: false,
    errored: false,
    reasoningItem: null, // 思考项（推理模型）：{ index, itemId, partAdded }
    reasoningText: '',
    textItem: null, // { index, itemId, partAdded }
    text: '',
    toolItems: new Map(), // OpenAI tool_calls index → { index, itemId, callId, name, args }
    toolCursor: 0,
    itemCursor: 0,
    nextOutputIndex: 0,
    seq: 0, // sequence_number：每个事件 +1
    createdAt: Math.floor(Date.now() / 1000),
    finishReason: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };

  const send = (event, payload) => {
    if (res.writableEnded) return;
    state.seq += 1;
    res.write(`event: ${event}\n`);
    // sequence_number 是官方形状的一部分：实测真 API 每个事件都带它，
    // 而用官方 SDK（zod schema）的客户端会因为缺这个字段把**整条事件判为非法**丢掉 ——
    // 表现就是"调用成功但一个字都不显示"。
    res.write(`data: ${JSON.stringify({ type: event, ...payload, sequence_number: state.seq })}\n\n`);
  };

  const responseSkeleton = (status) =>
    mapping.responsesSkeleton({ id: responseId, model, status, createdAt: state.createdAt });

  const ensureStart = () => {
    if (state.started) return;
    state.started = true;
    send('response.created', { response: responseSkeleton('in_progress') });
    send('response.in_progress', { response: responseSkeleton('in_progress') }); // 真 API 紧接着就有这个
  };

  const outputIndexOf = (kind, key) => {
    if (kind === 'reasoning') {
      // 思考项（推理模型）：没有它的话，"预算全花在思考上"的那种响应客户端会一个字都收不到
      if (!state.reasoningItem) {
        state.reasoningItem = { index: state.nextOutputIndex, itemId: mapping.id('rs'), partAdded: false };
        state.nextOutputIndex += 1;
        send('response.output_item.added', {
          output_index: state.reasoningItem.index,
          item: { id: state.reasoningItem.itemId, type: 'reasoning', status: 'in_progress', content: [], summary: [] },
        });
      }
      return state.reasoningItem;
    }
    if (kind === 'text') {
      if (!state.textItem) {
        state.textItem = { index: state.nextOutputIndex, itemId: mapping.id('msg'), partAdded: false };
        state.nextOutputIndex += 1;
        send('response.output_item.added', {
          output_index: state.textItem.index,
          // phase 是官方形状里的字段（Codex 那类客户端会看），logprobs 也要给
          item: { id: state.textItem.itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [], phase: 'final_answer' },
        });
      }
      return state.textItem;
    }
    if (!state.toolItems.has(key)) {
      const entry = { index: state.nextOutputIndex, itemId: mapping.id('fc'), callId: '', name: '', args: '' };
      state.nextOutputIndex += 1;
      state.toolItems.set(key, entry);
      send('response.output_item.added', {
        output_index: entry.index,
        item: { id: entry.itemId, type: 'function_call', call_id: entry.callId, name: entry.name, arguments: '', status: 'in_progress' },
      });
    }
    return state.toolItems.get(key);
  };

  const finalOutput = () => {
    const output = [];
    const ordered = [];
    if (state.reasoningItem) ordered.push({ index: state.reasoningItem.index, kind: 'reasoning' });
    if (state.textItem) ordered.push({ index: state.textItem.index, kind: 'text' });
    for (const entry of state.toolItems.values()) ordered.push({ index: entry.index, kind: 'tool', entry });
    ordered.sort((a, b) => a.index - b.index);
    for (const item of ordered) {
      if (item.kind === 'reasoning') {
        output.push({
          id: state.reasoningItem.itemId,
          type: 'reasoning',
          status: 'completed',
          content: state.reasoningText ? [{ type: 'reasoning_text', text: state.reasoningText }] : [],
          summary: [],
        });
      } else if (item.kind === 'text') {
        output.push({
          id: state.textItem.itemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [mapping.outputTextPart(state.text)],
          phase: 'final_answer',
        });
      } else {
        output.push({
          id: item.entry.itemId,
          type: 'function_call',
          call_id: item.entry.callId,
          name: item.entry.name,
          arguments: item.entry.args,
          status: 'completed',
        });
      }
    }
    return output;
  };

  const finish = () => {
    if (state.finished) return;
    state.finished = true;
    if (state.errored) return;
    ensureStart();
    if (state.reasoningItem) {
      send('response.reasoning_text.done', {
        output_index: state.reasoningItem.index,
        content_index: 0,
        item_id: state.reasoningItem.itemId,
        text: state.reasoningText,
      });
      send('response.content_part.done', {
        output_index: state.reasoningItem.index,
        content_index: 0,
        item_id: state.reasoningItem.itemId,
        part: { type: 'reasoning_text', text: state.reasoningText },
      });
      send('response.output_item.done', {
        output_index: state.reasoningItem.index,
        item: {
          id: state.reasoningItem.itemId,
          type: 'reasoning',
          status: 'completed',
          content: state.reasoningText ? [{ type: 'reasoning_text', text: state.reasoningText }] : [],
          summary: [],
        },
      });
    }
    if (state.textItem) {
      send('response.output_text.done', {
        output_index: state.textItem.index,
        content_index: 0,
        item_id: state.textItem.itemId,
        text: state.text,
      });
      send('response.content_part.done', {
        output_index: state.textItem.index,
        content_index: 0,
        item_id: state.textItem.itemId,
        part: mapping.outputTextPart(state.text),
      });
      send('response.output_item.done', {
        output_index: state.textItem.index,
        item: {
          id: state.textItem.itemId,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [mapping.outputTextPart(state.text)],
          phase: 'final_answer',
        },
      });
    }
    for (const entry of state.toolItems.values()) {
      send('response.function_call_arguments.done', {
        output_index: entry.index,
        item_id: entry.itemId,
        arguments: entry.args,
      });
      send('response.output_item.done', {
        output_index: entry.index,
        item: { id: entry.itemId, type: 'function_call', call_id: entry.callId, name: entry.name, arguments: entry.args, status: 'completed' },
      });
    }
    const truncated = state.finishReason === 'length';
    const completed = { ...responseSkeleton(truncated ? 'incomplete' : 'completed'), output: finalOutput() };
    // `output_text` 是 SDK 的便利字段（官方 SDK 自己从 output 里算），但这儿也直接给上：
    // 不用官方 SDK、直接读这个字段的客户端不少，缺了它就"什么都看不到"
    completed.output_text = state.text;
    completed.usage = {
      input_tokens: state.usage.input_tokens,
      output_tokens: state.usage.output_tokens,
      total_tokens: state.usage.input_tokens + state.usage.output_tokens,
    };
    if (truncated) {
      // 被 max_output_tokens 截断：真 API 用 incomplete 收尾（推理模型"预算全花在思考上"就是这种）
      completed.incomplete_details = { reason: 'max_output_tokens' };
      send('response.incomplete', { response: completed });
      return;
    }
    send('response.completed', { response: completed });
  };

  const mergeUsage = (usage) => {
    if (!usage) return;
    if (usage.prompt_tokens !== undefined) state.usage.input_tokens = Number(usage.prompt_tokens) || 0;
    if (usage.completion_tokens !== undefined) state.usage.output_tokens = Number(usage.completion_tokens) || 0;
  };

  return {
    chunk(irChunk) {
      if (!irChunk || state.finished) return;
      if (irChunk.error) {
        ensureStart();
        send('error', { code: 'upstream_error', message: String(irChunk.error.message || '上游错误'), param: null });
        state.errored = true;
        return;
      }
      ensureStart();
      if (irChunk.usage) mergeUsage(irChunk.usage);
      const choice = irChunk.choices && irChunk.choices[0];
      if (!choice) return;
      const delta = choice.delta || {};

      // 思考增量（推理模型）。不发的话，"预算全花在思考上"的响应客户端会一个字都看不到 ——
      // 事件名跟 DeepSeek / OpenAI 的原始思考通道一致（response.reasoning_text.delta）。
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        const item = outputIndexOf('reasoning');
        if (!item.partAdded) {
          item.partAdded = true;
          send('response.content_part.added', {
            output_index: item.index,
            content_index: 0,
            item_id: item.itemId,
            part: { type: 'reasoning_text', text: '' },
          });
        }
        state.reasoningText += delta.reasoning_content;
        send('response.reasoning_text.delta', {
          output_index: item.index,
          content_index: 0,
          item_id: item.itemId,
          delta: delta.reasoning_content,
        });
      }

      if (typeof delta.content === 'string' && delta.content) {
        const item = outputIndexOf('text');
        if (!item.partAdded) {
          item.partAdded = true;
          send('response.content_part.added', {
            output_index: item.index,
            content_index: 0,
            item_id: item.itemId,
            part: mapping.outputTextPart(''),
          });
        }
        state.text += delta.content;
        send('response.output_text.delta', {
          output_index: item.index,
          content_index: 0,
          item_id: item.itemId, // 真 API 带这个字段，官方 SDK 的 schema 也要求它
          logprobs: [],
          delta: delta.content,
        });
      }

      for (const call of delta.tool_calls || []) {
        const key = call.index === undefined ? 0 : call.index;
        const entry = outputIndexOf('tool', key);
        if (call.id) entry.callId = String(call.id);
        if (call.function && call.function.name) entry.name = String(call.function.name);
        const args = call.function && call.function.arguments;
        if (args) {
          entry.args += String(args);
          send('response.function_call_arguments.delta', {
            output_index: entry.index,
            item_id: entry.itemId,
            delta: String(args),
          });
        }
      }

      if (choice.finish_reason) state.finishReason = choice.finish_reason;
    },

    usage(usage) {
      mergeUsage(usage);
    },

    raw() {},

    done() {
      finish();
    },

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
  parseBody,
  sendError,
  forwardUpstreamError,
  setRetryAfter,
  sendPayload,
  beginStream,
  createStreamWriter,
};
