'use strict';

/**
 * M5 端到端测试：非 OpenAI 协议适配器
 *   - anthropic：`/v1/messages`，system 单独提出来、max_tokens 必填、x-api-key 鉴权，
 *               响应与流式事件都翻成 OpenAI 形状
 *   - cloudflare-workers-ai：`/accounts/{账号}/ai/run/{模型}`，模型只在路径里，
 *               响应 `{result:{response}}` 翻成 OpenAI 形状；HTTP 200 但 success:false 要当失败
 * 全部使用本机假上游，不消耗真实额度。
 */

const test = require('node:test');
// 同 m0：用例之间复位「失败锁定」（它按来源 IP 记，而本文件有些用例会连着打错误请求）
test.beforeEach(() => require('../src/app').v1FailureGuard.reset());
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const tmpRoot = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm5-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'm5-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-m5-key';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';

const ACCESS_KEY = process.env.ACCESS_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ANTHROPIC_KEY = 'sk-ant-test-key';
const CF_TOKEN = 'cf-test-token';
const CF_ACCOUNT = '0123456789abcdef0123456789abcdef';

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

/** 假 Anthropic：严格按 Messages API 的形状校验，形状不对就直接报错（这样测试才有意义） */
function createMockAnthropic() {
  const state = { calls: [] };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    state.calls.push({ url: req.url, headers: req.headers, body });

    const fail = (status, type, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type, message } }));
    };

    if (!req.url.endsWith('/v1/messages')) return fail(404, 'not_found_error', 'wrong path');
    if (req.headers['x-api-key'] !== ANTHROPIC_KEY) return fail(401, 'authentication_error', 'bad key');
    if (req.headers['anthropic-version'] !== '2023-06-01') return fail(400, 'invalid_request_error', 'missing version');
    if (!body.max_tokens) return fail(400, 'invalid_request_error', 'max_tokens: field required');
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return fail(400, 'invalid_request_error', 'messages: field required');
    }
    for (const msg of body.messages) {
      if (msg.role !== 'user' && msg.role !== 'assistant') {
        return fail(400, 'invalid_request_error', `unexpected role: ${msg.role}`);
      }
    }
    if (body.messages.some((m, i) => i > 0 && m.role === body.messages[i - 1].role)) {
      return fail(400, 'invalid_request_error', 'roles must alternate');
    }

    // ---- 工具相关的严格校验（真实 API 就是这样挑错的）----
    if (body.tools !== undefined) {
      if (!Array.isArray(body.tools)) return fail(400, 'invalid_request_error', 'tools: must be an array');
      for (const tool of body.tools) {
        // Anthropic 的工具定义是扁平的：不允许出现 OpenAI 的 type:'function' 包装
        if (!tool || tool.type === 'function') {
          return fail(400, 'invalid_request_error', 'tools: expected a flat {name, input_schema} object');
        }
        if (!tool.name) return fail(400, 'invalid_request_error', 'tools[].name: required');
        if (!tool.input_schema || typeof tool.input_schema !== 'object') {
          return fail(400, 'invalid_request_error', 'tools[].input_schema: required');
        }
      }
    }
    if (body.tool_choice !== undefined && !body.tools) {
      return fail(400, 'invalid_request_error', 'tool_choice: tools must be provided');
    }
    // tool_result 必须待在 user 消息里，且 tool_use_id 要对得上前面出现过的 tool_use
    const seenToolUseIds = new Set();
    let lastBlockTypes = [];
    for (const msg of body.messages) {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      for (const block of blocks) {
        if (!block) continue;
        if (block.type === 'tool_use') {
          seenToolUseIds.add(block.id);
          if (typeof block.input !== 'object') return fail(400, 'invalid_request_error', 'tool_use.input must be an object');
        }
        if (block.type === 'tool_result') {
          if (msg.role !== 'user') return fail(400, 'invalid_request_error', 'tool_result must be in a user message');
          if (!seenToolUseIds.has(block.tool_use_id)) {
            return fail(400, 'invalid_request_error', `unexpected tool_use_id: ${block.tool_use_id}`);
          }
        }
      }
      lastBlockTypes = blocks.map((b) => b && b.type);
    }
    const wantsTool = Array.isArray(body.tools) && body.tools.length > 0 && !lastBlockTypes.includes('tool_result');

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
      send('message_start', {
        type: 'message_start',
        message: { id: 'msg_mock', model: body.model, usage: { input_tokens: 5, output_tokens: 0 } },
      });
      if (wantsTool) {
        // 文本块 + 工具块交替，参数用 input_json_delta 分片发（复刻真实行为）
        send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: '我查一下。' },
        });
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_mock_1', name: body.tools[0].name, input: {} },
        });
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"ci' },
        });
        send('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: 'ty": "北京"}' },
        });
        send('content_block_stop', { type: 'content_block_stop', index: 1 });
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 12 },
        });
        send('message_stop', { type: 'message_stop' });
        res.end();
        return;
      }
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send('ping', { type: 'ping' });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'po' } });
      send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ng' } });
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
      send('message_stop', { type: 'message_stop' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (wantsTool) {
      res.end(
        JSON.stringify({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [
            { type: 'thinking', thinking: '想了一下' },
            { type: 'text', text: '我查一下。' },
            { type: 'tool_use', id: 'toolu_mock_1', name: body.tools[0].name, input: { city: '北京' } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 30, output_tokens: 12 },
        })
      );
      return;
    }
    res.end(
      JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [
          { type: 'thinking', thinking: '想了一下' },
          { type: 'text', text: wantsTool === false && lastBlockTypes.includes('tool_result') ? '工具结果我看到了：北京晴，18 度。' : 'pong-from-anthropic' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 2 },
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      // baseUrl 是**完整前缀**：适配器只在后面拼 `/messages`，不再自动补 `/v1`（用户 2026-09-15 裁定）
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

/** 假 Cloudflare Workers AI */
function createMockCloudflare() {
  const state = { calls: [] };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    state.calls.push({ url: req.url, headers: req.headers, body });

    const match = req.url.match(/\/accounts\/([^/]+)\/ai\/run\/(.+)$/);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, errors: [{ code: 7000, message: 'No route for that URI' }], result: null }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${CF_TOKEN}`) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, errors: [{ code: 9109, message: 'Invalid access token' }], result: null }));
      return;
    }
    const model = decodeURIComponent(match[2]);
    if (model.includes('bad-model')) {
      // 真实情况：HTTP 200 但 success:false
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, errors: [{ code: 7003, message: `No such model: ${model}` }], result: null }));
      return;
    }
    if (model.includes('paid-only')) {
      // 真实情况：免费计划跑不了的模型 → HTTP 403 + 内部错误码 5035
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          success: false,
          errors: [{ code: 5035, message: 'Requires Workers Paid plan. Upgrade your plan to continue.' }],
          result: null,
        })
      );
      return;
    }

    // 方言 B：较新的模型（nemotron 这类）走 OpenAI 形状，正文可能是 null、推理内容叫 reasoning
    if (model.includes('nemotron')) {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = (choices, usage) =>
          res.write(`data: ${JSON.stringify({ object: 'chat.completion.chunk', model, choices, usage })}\n\n`);
        chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }], {
          prompt_tokens: 22,
          completion_tokens: 0,
          total_tokens: 22,
        });
        chunk([{ index: 0, delta: { reasoning: '让我想想' }, finish_reason: null }], {
          prompt_tokens: 0,
          completion_tokens: 1,
          total_tokens: 1,
        });
        chunk([{ index: 0, delta: { content: 'po' }, finish_reason: null }], {
          prompt_tokens: 0,
          completion_tokens: 1,
          total_tokens: 1,
        });
        chunk([{ index: 0, delta: { content: 'ng' }, finish_reason: 'stop' }], {
          prompt_tokens: 0,
          completion_tokens: 1,
          total_tokens: 1,
        });
        // 收尾：一个空 choices 的 chunk，再一个经典方言的累计用量帧
        chunk([], { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
        res.write(`data: ${JSON.stringify({ response: '', usage: { prompt_tokens: 22, completion_tokens: 64, total_tokens: 86 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      // 带工具时：方言 B 的 message 里直接给 OpenAI 形状的 tool_calls
      const toolCalls = Array.isArray(body.tools) && body.tools.length
        ? [
            {
              index: 0,
              id: 'call_cf_mock_1',
              type: 'function',
              function: { name: body.tools[0].function.name, arguments: '{"city":"北京"}' },
            },
          ]
        : [];
      res.end(
        JSON.stringify({
          success: true,
          errors: [],
          messages: [],
          result: {
            id: 'chatcmpl-cf-openai-dialect',
            object: 'chat.completion',
            created: 1789119993,
            model,
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: toolCalls.length ? '我用工具查一下。' : null,
                  reasoning: '让我想想',
                  tool_calls: toolCalls,
                },
                finish_reason: toolCalls.length ? 'tool_calls' : 'length',
              },
            ],
            usage: { prompt_tokens: 22, completion_tokens: 128, total_tokens: 150, neurons: 18.398 },
          },
        })
      );
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({ response: 'po' })}\n\n`);
      res.write(`data: ${JSON.stringify({ response: 'ng', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: { response: 'pong-from-cloudflare', usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } },
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/client/v4` });
    });
  });
}

let mockAnthropic;
let mockCloudflare;
let appServer;
let baseUrl;
let cookie = '';

async function adminApi(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}/api/admin${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

async function chat(body) {
  const res = await fetch(`${baseUrl}/openai/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: body.stream ? null : safeJson(text), headers: res.headers };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

test.before(async () => {
  mockAnthropic = await createMockAnthropic();
  mockCloudflare = await createMockCloudflare();
  const { bootstrap } = require('../src/index');
  appServer = await bootstrap();
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookies = typeof login.headers.getSetCookie === 'function'
    ? login.headers.getSetCookie()
    : [login.headers.get('set-cookie')];
  cookie = cookies.map((c) => String(c).split(';')[0]).join('; ');

  // Cloudflare 来源排在前面：用来验证"它失败就换到 Anthropic"
  const cf = await adminApi('/providers', {
    method: 'POST',
    body: {
      id: 'cf',
      name: 'Cloudflare Workers AI',
      baseUrl: mockCloudflare.baseUrl,
      apiKey: CF_TOKEN,
      accountId: CF_ACCOUNT,
      adapter: 'cloudflare-workers-ai',
      rateLimits: [],
      rejectPolicy: 'cooldown_probe',
      cooldownSeconds: 300,
    },
  });
  assert.equal(cf.status, 201, JSON.stringify(cf.json));
  assert.equal(cf.json.adapter, 'cloudflare-workers-ai');
  assert.equal(cf.json.accountId, CF_ACCOUNT, '账号 ID 要存下来（模型地址要用）');

  const anth = await adminApi('/providers', {
    method: 'POST',
    body: {
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: mockAnthropic.baseUrl,
      apiKey: ANTHROPIC_KEY,
      adapter: 'anthropic',
      rateLimits: [],
      rejectPolicy: 'cooldown_probe',
      cooldownSeconds: 300,
    },
  });
  assert.equal(anth.status, 201, JSON.stringify(anth.json));

  for (const [providerId, modelId] of [
    ['cf', '@cf/meta/llama-3.1-8b-instruct'],
    ['anthropic', 'claude-sonnet-4-5'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi(`/providers/${providerId}/models`, { method: 'POST', body: { modelId } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  // 方言 B 的那个模型（真机上是 @cf/nvidia/nemotron-3-120b-a12b）
  const nemotron = await adminApi('/providers/cf/models', {
    method: 'POST',
    body: { modelId: '@cf/nvidia/nemotron-3-120b-a12b' },
  });
  assert.equal(nemotron.status, 201, JSON.stringify(nemotron.json));

  // 未知协议要被拒（白名单来自适配器注册表）
  const bad = await adminApi('/providers', {
    method: 'POST',
    body: { id: 'bad-adapter', name: 'x', baseUrl: 'https://example.com/v1', adapter: 'gemini' },
  });
  assert.equal(bad.status, 400, '没实现的协议不能存进来');
  assert.match(bad.json.error.message, /anthropic/);
});

test.after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  const { db } = require('../src/db');
  await db.destroy();
  for (const mock of [mockAnthropic, mockCloudflare]) {
    if (mock) await new Promise((resolve) => mock.server.close(resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ Anthropic

test('M5-1) anthropic 非流式：请求按 Messages API 形状发，响应翻成 OpenAI 形状', async () => {
  const res = await chat({
    model: 'Free/anthropic/claude-sonnet-4-5',
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'ping' },
    ],
    temperature: 0.5,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.object, 'chat.completion');
  assert.equal(res.json.model, 'claude-sonnet-4-5', '指定来源时上游写啥就是啥（不写成本地请求名）');
  assert.equal(res.json.choices[0].message.content, 'pong-from-anthropic');
  assert.equal(res.json.choices[0].message.reasoning_content, '想了一下', 'thinking 块映射成 reasoning_content');
  assert.equal(res.json.choices[0].finish_reason, 'stop');
  assert.deepEqual(res.json.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });

  const call = mockAnthropic.state.calls.at(-1);
  assert.equal(call.url, '/v1/messages');
  assert.equal(call.headers['x-api-key'], ANTHROPIC_KEY);
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.model, 'claude-sonnet-4-5', '发给上游的是真实模型名');
  assert.equal(call.body.system, '你是助手', 'system 要单独提出来');
  assert.equal(call.body.messages.length, 1, 'messages 里只留 user/assistant');
  assert.equal(call.body.messages[0].role, 'user');
  assert.ok(call.body.max_tokens > 0, 'max_tokens 必填，没传就补默认值');
  assert.equal(call.body.temperature, 0.5);
});

test('M5-2) anthropic 流式：命名事件翻成 OpenAI chunk，不泄露 event 行', async () => {
  const res = await chat({
    model: 'Free/anthropic/claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'ping' }],
    stream: true,
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  assert.ok(!/^event:/m.test(res.text), 'Anthropic 的 event: 行不能透给客户端');
  assert.ok(!res.text.includes('content_block_delta'), '上游事件名不能出现');
  assert.match(res.text, /"content":"po"/);
  assert.match(res.text, /"content":"ng"/);
  assert.ok(res.text.includes('"model":"claude-sonnet-4-5"'), '指定来源：模型名直通（上游 message_start 里那个）');
  assert.ok(res.text.includes('"finish_reason":"stop"'));
  assert.ok(res.text.includes('"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}'), '用量要收集并附在收尾 chunk 上');
  assert.ok(res.text.trimEnd().endsWith('data: [DONE]'));
});

// ------------------------------------------------------------------ Cloudflare

test('M5-3) cloudflare 非流式：模型走路径、请求体不带 model，响应翻成 OpenAI 形状', async () => {
  const res = await chat({
    model: 'Free/cf/@cf/meta/llama-3.1-8b-instruct',
    messages: [{ role: 'user', content: 'ping' }],
    top_p: 0.9,
    unknown_field: 'should-not-be-forwarded',
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].message.content, 'pong-from-cloudflare');
  assert.deepEqual(res.json.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  assert.equal(res.json.model, undefined, '上游（经典方言）没写 model，那响应里就没有这个字段');

  const call = mockCloudflare.state.calls.at(-1);
  assert.match(call.url, new RegExp(`/accounts/${CF_ACCOUNT}/ai/run/@cf/meta/llama-3\\.1-8b-instruct$`), '账号 id 和模型都要在路径里');
  assert.equal(call.headers.authorization, `Bearer ${CF_TOKEN}`);
  assert.equal(call.body.model, undefined, '模型不能放进请求体');
  assert.equal(call.body.unknown_field, undefined, '不认识的字段不带过去');
  assert.equal(call.body.top_p, 0.9);
  assert.ok(call.body.max_tokens > 0, 'CF 也要 max_tokens');
});

test('M5-4) cloudflare 流式：{response} 增量翻成 delta.content', async () => {
  const res = await chat({
    model: 'Free/cf/@cf/meta/llama-3.1-8b-instruct',
    messages: [{ role: 'user', content: 'ping' }],
    stream: true,
  });
  assert.equal(res.status, 200);
  assert.match(res.text, /"content":"po"/);
  assert.match(res.text, /"content":"ng"/);
  assert.ok(res.text.includes('"completion_tokens":2'), '用量要收集');
  assert.ok(!res.text.includes('"model":'), '经典方言的流里没有 model，我们也不编一个出来');
  assert.ok(res.text.trimEnd().endsWith('data: [DONE]'));
});

test('M5-5) All：Cloudflare 返回 200 但 success:false → 自动换到 Anthropic', async () => {
  // 把 cf 的模型换成假上游会拒绝的那个（同一路径的模型名带 bad-model）
  const added = await adminApi('/providers/cf/models', {
    method: 'POST',
    body: { modelId: '@cf/meta/bad-model' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.json));
  // 让它排在最前，第二顺位放 anthropic（这样才验证"跨协议换源"）
  const models = await adminApi('/models');
  const badModel = models.json.find((m) => m.modelId === '@cf/meta/bad-model');
  const anthModel = models.json.find((m) => m.providerId === 'anthropic');
  const rest = models.json.filter((m) => m.id !== badModel.id && m.id !== anthModel.id);
  await adminApi('/models/reorder', {
    method: 'POST',
    body: { orderedIds: [badModel.id, anthModel.id, ...rest.map((m) => m.id)] },
  });

  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].message.content, 'pong-from-anthropic', '应换到下一个来源');

  const logs = await adminApi('/logs?limit=3');
  const bad = logs.json.find((l) => l.realModel === '@cf/meta/bad-model');
  assert.equal(bad.status, 'fail');
  assert.equal(bad.errorType, 'not_found', 'HTTP 200 但 body 说 No such model → 归类为"没有这个模型"并换源');
  assert.match(bad.detail, /No such model/, '失败原因要写进日志，方便排查');
  assert.equal(logs.json[0].status, 'fallback');
  assert.equal(logs.json[0].providerId, 'anthropic');
});

test('M5-6) 后台「测试」：HTTP 200 但 success:false 要算失败（不能标成恢复）', async () => {
  mockCloudflare.state.calls.length = 0;
  const result = await adminApi('/providers/cf/test', { method: 'POST', body: { modelId: '@cf/meta/bad-model' } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.ok, false, JSON.stringify(result.json));
  assert.equal(result.json.errorType, 'not_found', 'body 里说 No such model → 归类为"没有这个模型"');
  assert.match(result.json.message, /No such model/);
  assert.equal(result.json.state.status, 'cooldown', '按策略进冷却/停用');
});

test('M5-9) CF 的 OpenAI 方言（nemotron 那种）：content 为 null、推理内容叫 reasoning 也要翻对', async () => {
  const res = await chat({
    model: 'Free/cf/@cf/nvidia/nemotron-3-120b-a12b',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.object, 'chat.completion');
  assert.equal(res.json.choices[0].message.content, '', 'content 是 null 时不能整个当失败');
  assert.equal(res.json.choices[0].message.reasoning_content, '让我想想');
  assert.equal(res.json.choices[0].message.reasoning, '让我想想');
  assert.equal(res.json.choices[0].finish_reason, 'length', 'finish_reason 要透传而不是硬写 stop');
  assert.deepEqual(res.json.usage, { prompt_tokens: 22, completion_tokens: 128, total_tokens: 150 });
  assert.equal(res.json.model, '@cf/nvidia/nemotron-3-120b-a12b', '指定来源：上游写啥就是啥');
});

test('M5-10) CF 的 OpenAI 方言：流式 delta.content / delta.reasoning 都要能翻，用量取收尾的累计值', async () => {
  const res = await chat({
    model: 'Free/cf/@cf/nvidia/nemotron-3-120b-a12b',
    messages: [{ role: 'user', content: 'ping' }],
    stream: true,
  });
  assert.equal(res.status, 200);
  const texts = [];
  const reasonings = [];
  let usage = null;
  for (const line of res.text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    const obj = JSON.parse(payload);
    const delta = obj.choices && obj.choices[0] ? obj.choices[0].delta : null;
    if (delta && delta.content) texts.push(delta.content);
    if (delta && delta.reasoning_content) reasonings.push(delta.reasoning_content);
    if (obj.usage) usage = obj.usage;
  }
  assert.equal(texts.join(''), 'pong', '正文要拼得出来');
  assert.equal(reasonings.join(''), '让我想想', '推理增量也要给客户端');
  assert.deepEqual(usage, { prompt_tokens: 22, completion_tokens: 64, total_tokens: 86 }, '用量要用收尾的累计值');
  assert.ok(res.text.includes('"model":"@cf/nvidia/nemotron-3-120b-a12b"'), '指定来源：chunk 里的模型名也是上游自己的');
  assert.ok(res.text.trimEnd().endsWith('data: [DONE]'));
});

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询某个城市的天气',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
];

test('M5-11) anthropic 工具调用：上游收到扁平 tools，客户端拿到 tool_calls（arguments 是 JSON 字符串）', async () => {
  const res = await chat({
    model: 'Free/anthropic/claude-sonnet-4-5',
    messages: [{ role: 'user', content: '北京天气怎么样？用工具查' }],
    tools: TOOLS,
    tool_choice: 'auto',
    max_tokens: 256,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].finish_reason, 'tool_calls');
  assert.equal(res.json.choices[0].message.content, '我查一下。');
  assert.equal(res.json.choices[0].message.reasoning_content, '想了一下');
  const calls = res.json.choices[0].message.tool_calls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'function');
  assert.equal(calls[0].id, 'toolu_mock_1');
  assert.equal(calls[0].function.name, 'get_weather');
  assert.equal(calls[0].function.arguments, '{"city":"北京"}', 'input 要变回 JSON 字符串');
  assert.deepEqual(res.json.usage, { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 });

  const call = mockAnthropic.state.calls.at(-1);
  assert.equal(call.body.tools[0].name, 'get_weather');
  assert.equal(call.body.tools[0].type, undefined, '不能带 OpenAI 的 type:function 包装');
  assert.ok(call.body.tools[0].input_schema, '要转成 input_schema');
  assert.deepEqual(call.body.tool_choice, { type: 'auto' });
});

test('M5-12) anthropic 多轮：role:"tool" 的结果要变成 user 里的 tool_result 块，且 id 对得上', async () => {
  const first = await chat({
    model: 'Free/anthropic/claude-sonnet-4-5',
    messages: [{ role: 'user', content: '北京天气怎么样？用工具查' }],
    tools: TOOLS,
    max_tokens: 256,
  });
  const call = first.json.choices[0].message.tool_calls[0];

  const second = await chat({
    model: 'Free/anthropic/claude-sonnet-4-5',
    messages: [
      { role: 'user', content: '北京天气怎么样？用工具查' },
      { role: 'assistant', content: first.json.choices[0].message.content, tool_calls: [call] },
      { role: 'tool', tool_call_id: call.id, content: '{"temp":18,"weather":"晴"}' },
    ],
    tools: TOOLS,
    max_tokens: 256,
  });
  assert.equal(second.status, 200, JSON.stringify(second.json));
  assert.equal(second.json.choices[0].finish_reason, 'stop');
  assert.match(second.json.choices[0].message.content, /18/);
  assert.equal(second.json.choices[0].message.tool_calls, undefined, '这一轮不该再有工具调用');

  // 假上游是严格校验的：它接受了就说明 tool_use / tool_result 的结构和 id 都对
  const upstream = mockAnthropic.state.calls.at(-1);
  const roles = upstream.body.messages.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user'], 'tool 结果要并成 user 消息，且角色交替');
  const lastBlocks = upstream.body.messages[2].content;
  assert.equal(lastBlocks[0].type, 'tool_result');
  assert.equal(lastBlocks[0].tool_use_id, 'toolu_mock_1');
  assert.equal(lastBlocks[0].content, '{"temp":18,"weather":"晴"}');
});

test('M5-13) anthropic 流式工具调用：input_json_delta 碎片要能拼回合法 JSON', async () => {
  const res = await chat({
    model: 'Free/anthropic/claude-sonnet-4-5',
    messages: [{ role: 'user', content: '北京天气怎么样？用工具查' }],
    tools: TOOLS,
    stream: true,
    max_tokens: 256,
  });
  assert.equal(res.status, 200);
  const fragments = new Map();
  let finish = null;
  for (const line of res.text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6);
    if (payload === '[DONE]') continue;
    const obj = JSON.parse(payload);
    const ch = obj.choices && obj.choices[0];
    if (!ch) continue;
    if (ch.delta && Array.isArray(ch.delta.tool_calls)) {
      for (const frag of ch.delta.tool_calls) {
        const idx = frag.index === undefined ? 0 : frag.index;
        if (!fragments.has(idx)) fragments.set(idx, { id: '', name: '', args: '' });
        const slot = fragments.get(idx);
        if (frag.id) slot.id = frag.id;
        if (frag.function && frag.function.name) slot.name = frag.function.name;
        if (frag.function && frag.function.arguments) slot.args += frag.function.arguments;
      }
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  }
  assert.equal(finish, 'tool_calls');
  assert.equal(fragments.size, 1);
  const slot = fragments.get(0);
  assert.equal(slot.id, 'toolu_mock_1');
  assert.equal(slot.name, 'get_weather');
  assert.deepEqual(JSON.parse(slot.args), { city: '北京' }, '参数碎片要能拼成合法 JSON');
  assert.ok(res.text.includes('"content":"我查一下。"'), '工具调用前的正文也要照常发出去');
  assert.ok(res.text.trimEnd().endsWith('data: [DONE]'));
});

test('M5-14) CF 的 OpenAI 方言：tool_calls 要原样透传，不能再被丢掉', async () => {
  const res = await chat({
    model: 'Free/cf/@cf/nvidia/nemotron-3-120b-a12b',
    messages: [{ role: 'user', content: 'ping' }],
    tools: TOOLS,
    max_tokens: 256,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const calls = res.json.choices[0].message.tool_calls;
  assert.ok(Array.isArray(calls) && calls.length, 'CF 的 tool_calls 必须能到客户端手里');
  assert.equal(calls[0].function.name, 'get_weather');
  assert.equal(res.json.choices[0].finish_reason, 'tool_calls');

  const call = mockCloudflare.state.calls.at(-1);
  assert.ok(Array.isArray(call.body.tools) && call.body.tools.length, '请求里的 tools 要发给上游（在参数白名单里）');
});

test('M5-7) 指定来源时上游报错原样转发（Anthropic 401 → 401）', async () => {
  const wrong = await adminApi('/providers/anthropic', { method: 'PATCH', body: { apiKey: 'wrong-key' } });
  assert.equal(wrong.status, 200, JSON.stringify(wrong.json));

  const res = await chat({ model: 'Free/anthropic/claude-sonnet-4-5', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 401, JSON.stringify(res.json));
  assert.match(JSON.stringify(res.json), /authentication_error|密钥/, '上游错误体原样转发');

  const back = await adminApi('/providers/anthropic', { method: 'PATCH', body: { apiKey: ANTHROPIC_KEY } });
  assert.equal(back.status, 200);
  await adminApi('/providers/anthropic/state', { method: 'POST', body: { status: 'available' } });
});

test('M5-8) 免费计划跑不了的 CF 模型：报"需要付费计划"、转「故障（需人工）」、All 自动跳过', async () => {
  const added = await adminApi('/providers/cf/models', {
    method: 'POST',
    body: { modelId: '@cf/meta/paid-only-instruct' },
  });
  assert.equal(added.status, 201, JSON.stringify(added.json));

  // 1) 后台「测试」：不能含糊地说"密钥无效"，要说清楚是计划问题
  const tested = await adminApi('/providers/cf/test', {
    method: 'POST',
    body: { modelId: '@cf/meta/paid-only-instruct' },
  });
  assert.equal(tested.status, 200);
  assert.equal(tested.json.ok, false);
  assert.equal(tested.json.errorType, 'plan_required', JSON.stringify(tested.json));
  assert.match(tested.json.message, /Workers Paid/, '要看得出是付费计划的问题');
  assert.equal(tested.json.state.status, 'stopped', '对该模型是永久性的 → 转需人工，不再探测');

  // 2) 这个模型被标成故障后，All 不会再试它
  const overview = await adminApi('/overview');
  const entry = overview.json.models.find((m) => m.modelId === '@cf/meta/paid-only-instruct');
  assert.equal(entry.runtimeStatus, 'error');
  assert.match(entry.state.reason, /Workers Paid/, '原因要留在状态里（后台鼠标悬停能看到）');

  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.ok(['pong-from-cloudflare', 'pong-from-anthropic'].includes(res.json.choices[0].message.content));

  const logs = await adminApi('/logs?limit=20');
  assert.ok(
    !logs.json.some((l) => l.realModel === '@cf/meta/paid-only-instruct' && l.status !== 'fail'),
    'All 不该再去碰这个跑不了的模型'
  );

  // 3) 它已经被标成「需人工」，所以指定来源也不会再打上游，而是直接告诉客户端为什么
  const pinned = await chat({
    model: 'Free/cf/@cf/meta/paid-only-instruct',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(pinned.status, 503, JSON.stringify(pinned.json));
  assert.equal(pinned.json.error.code, 'source_unavailable');
  assert.match(pinned.json.error.message, /Workers Paid/, '要告诉客户端是这个模型跑不了（而不是含糊的"服务不可用"）');

  // 4) 人工恢复后，指定来源就会真的打上游，并把 CF 的 403 原文转发回去
  await adminApi('/providers/cf/state', { method: 'POST', body: { status: 'available' } });
  const again = await chat({
    model: 'Free/cf/@cf/meta/paid-only-instruct',
    messages: [{ role: 'user', content: 'ping' }],
  });
  assert.equal(again.status, 403, JSON.stringify(again.json));
  assert.match(JSON.stringify(again.json), /5035|Paid plan/, '指定来源时上游错误原样转发');

  await adminApi(`/models/${added.json.id}`, { method: 'DELETE' });
});
