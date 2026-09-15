'use strict';

/**
 * M11：**下游 Anthropic 方言**（`/anthropic/messages`）
 *
 * 这个测试要证明的是 2.0.0 的核心主张：**客户端说什么方言，和上游是什么协议，完全解耦**。
 *   - 客户端：Anthropic Messages（x-api-key、system 独立、max_tokens 必填、块数组、命名事件流）
 *   - 上游：既有 openai-compatible（假上游 A），也有 anthropic（假上游 B）
 *   → 同一个客户端请求，两边都能用；客户端看到的形状**始终是 Anthropic 的**。
 *
 * 另外覆盖：x-api-key 鉴权、错误体是 Anthropic 形状、/anthropic/models、未实现端点的 404 形状。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const tmpRoot = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm11-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'm11-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-m11-key';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';

const ACCESS_KEY = process.env.ACCESS_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const OA_KEY = 'sk-oa-key';
const AN_KEY = 'sk-ant-key';

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

/** 假 openai-compatible 上游 */
function createMockOpenAI() {
  const state = { calls: [], mode: 'ok' };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    state.calls.push({ url: req.url, headers: req.headers, body });

    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'wrong path' } }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${OA_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key', type: 'authentication_error' } }));
      return;
    }

    const wantsTool = Array.isArray(body.tools) && body.tools.length && state.mode !== 'plain';

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
      chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
      chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: '你' } }] });
      chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { content: '好' } }] });
      chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 1700000000,
        model: body.model,
        choices: [
          {
            index: 0,
            message: wantsTool
              ? { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SH"}' } }] }
              : { role: 'assistant', content: '你好呀' },
            finish_reason: wantsTool ? 'tool_calls' : 'stop',
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

/** 假 anthropic 上游：严格按 Messages API 校验（这样"能过假上游"才等于"能打真上游"） */
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
    if (req.headers['x-api-key'] !== AN_KEY) return fail(401, 'authentication_error', 'bad key');
    if (!req.headers['anthropic-version']) return fail(400, 'invalid_request_error', 'missing version');
    if (!body.max_tokens) return fail(400, 'invalid_request_error', 'max_tokens: field required');
    if (!Array.isArray(body.messages) || !body.messages.length) return fail(400, 'invalid_request_error', 'messages required');

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'msg_upstream_1',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: '来自 Anthropic 上游' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 5 },
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

let mockOa;
let mockAn;
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
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** 以 Anthropic 客户端的身份发请求（x-api-key + Anthropic 形状） */
async function anthropicApi(pathname, { body, key = ACCESS_KEY, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}/anthropic${pathname}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(key ? { 'x-api-key': key } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

function parseSse(text) {
  const events = [];
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const event = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim() || null;
    const raw = (lines.find((l) => l.startsWith('data:')) || '').slice(5).trim();
    if (raw === undefined) continue;
    events.push({ event, data: raw ? JSON.parse(raw) : null });
  }
  return events;
}

test.before(async () => {
  mockOa = await createMockOpenAI();
  mockAn = await createMockAnthropic();
  const { bootstrap } = require('../src/index');
  appServer = await bootstrap();
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookies =
    typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  cookie = cookies.map((c) => String(c).split(';')[0]).join('; ');

  for (const provider of [
    { id: 'oa', name: 'OpenAI 兼容', baseUrl: mockOa.baseUrl, apiKey: OA_KEY, adapter: 'openai-compatible' },
    { id: 'an', name: 'Anthropic', baseUrl: mockAn.baseUrl, apiKey: AN_KEY, adapter: 'anthropic' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi('/providers', {
      method: 'POST',
      body: { ...provider, rateLimits: [], rejectPolicy: 'cooldown_probe', cooldownSeconds: 300 },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
  for (const [providerId, modelId] of [
    ['oa', 'm-x'],
    ['an', 'claude-sonnet-4-5'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi(`/providers/${providerId}/models`, { method: 'POST', body: { modelId } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
});

test.after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  if (mockOa) await new Promise((resolve) => mockOa.server.close(resolve));
  if (mockAn) await new Promise((resolve) => mockAn.server.close(resolve));
  const { db } = require('../src/db');
  await db.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('M11-1) 非流式：Anthropic 客户端 → OpenAI 上游，回来仍是 Anthropic 形状', async () => {
  const res = await anthropicApi('/messages', {
    body: {
      model: 'Free/oa/m-x',
      max_tokens: 128,
      system: '你是助手',
      messages: [{ role: 'user', content: '你好' }],
    },
  });
  assert.equal(res.status, 200, res.text);

  // —— 上游收到的是内部形状（system 作为 messages 里的第一条、max_tokens 原样传下去）——
  const call = mockOa.state.calls.at(-1);
  assert.equal(call.url, '/v1/chat/completions');
  assert.equal(call.body.model, 'm-x');
  assert.equal(call.body.max_tokens, 128);
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ]);

  // —— 客户端拿到的是 Anthropic 形状 ——
  assert.equal(res.json.type, 'message');
  assert.equal(res.json.role, 'assistant');
  assert.match(res.json.id, /^msg_/);
  assert.deepEqual(res.json.content, [{ type: 'text', text: '你好呀' }]);
  assert.equal(res.json.stop_reason, 'end_turn');
  assert.equal(res.json.usage.input_tokens, 11);
  assert.equal(res.json.usage.output_tokens, 4);
});

test('M11-2) 工具：请求里的 tool_result/tool_use 翻成内部形状，工具调用回成 tool_use 块', async () => {
  const res = await anthropicApi('/messages', {
    body: {
      model: 'Free/oa/m-x',
      max_tokens: 256,
      messages: [
        { role: 'user', content: '上海天气' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SH' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴 26 度' }, { type: 'text', text: '那穿什么' }] },
      ],
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      tool_choice: { type: 'auto' },
    },
  });
  assert.equal(res.status, 200, res.text);

  const body = mockOa.state.calls.at(-1).body;
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SH"}' } }],
  });
  assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'toolu_1', content: '晴 26 度' });
  assert.deepEqual(body.messages[3], { role: 'user', content: '那穿什么' });
  assert.equal(body.tools[0].type, 'function', '工具定义要包成 function（内部形状）');
  assert.equal(body.tools[0].function.name, 'get_weather');
  assert.equal(body.tool_choice, 'auto');

  // 客户端拿到 tool_use 块（input 是对象，不是 JSON 字符串）
  const toolUse = res.json.content.find((b) => b.type === 'tool_use');
  assert.ok(toolUse, JSON.stringify(res.json.content));
  assert.equal(toolUse.name, 'get_weather');
  assert.deepEqual(toolUse.input, { city: 'SH' });
  assert.equal(res.json.stop_reason, 'tool_use');
});

test('M11-3) 流式：命名事件序列（没有 [DONE] 这种东西）', async () => {
  const res = await anthropicApi('/messages', {
    body: {
      model: 'Free/oa/m-x',
      max_tokens: 64,
      messages: [{ role: 'user', content: '你好' }],
      stream: true,
    },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const events = parseSse(res.text);
  assert.equal(events[0].event, 'message_start');
  assert.equal(events[0].data.message.role, 'assistant');
  assert.match(events[0].data.message.id, /^msg_/);

  const text = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
    .map((e) => e.data.delta.text)
    .join('');
  assert.equal(text, '你好');

  const last = events.at(-1);
  assert.equal(last.event, 'message_stop');
  const delta = events.find((e) => e.event === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'end_turn');
  assert.equal(delta.data.usage.output_tokens, 2, '用量在 message_delta 里给');
  assert.ok(!res.text.includes('[DONE]'), 'Anthropic 没有 [DONE] 这种收尾');
});

test('M11-4) 鉴权：x-api-key 认，口令不对按 Anthropic 的错误形状回', async () => {
  const ok = await anthropicApi('/models');
  assert.equal(ok.status, 200, 'x-api-key 应该能过');

  const bad = await anthropicApi('/models', { key: 'sk-wrong' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.type, 'error');
  assert.equal(bad.json.error.type, 'authentication_error');

  const none = await anthropicApi('/models', { key: '' });
  assert.equal(none.status, 401);
  assert.equal(none.json.error.type, 'authentication_error');
});

test('M11-5) 参数校验：缺 max_tokens 直接 400（Anthropic 官方也要求必填）', async () => {
  const res = await anthropicApi('/messages', {
    body: { model: 'Free/oa/m-x', messages: [{ role: 'user', content: 'x' }] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.type, 'error');
  assert.equal(res.json.error.type, 'invalid_request_error');
  assert.match(res.json.error.message, /max_tokens/);
  assert.equal(mockOa.state.calls.filter((c) => c.body.messages && c.body.messages.length === 1 && c.body.messages[0].content === 'x').length, 0, '不该把没校验过的请求打到上游');
});

test('M11-6) GET /anthropic/models 是 Anthropic 的形状，名字和 /openai/models 一套', async () => {
  const res = await anthropicApi('/models');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.data));
  const ids = res.json.data.map((m) => m.id);
  assert.ok(ids.includes('All'), ids.join(','));
  assert.ok(ids.includes('Free/oa/m-x'), ids.join(','));
  const first = res.json.data[0];
  assert.equal(first.type, 'model');
  assert.equal(typeof first.display_name, 'string');
  assert.equal(res.json.has_more, false);
});

test('M11-7) 同一个 Anthropic 请求换到 anthropic 上游照样能用（方言与上游解耦）', async () => {
  const res = await anthropicApi('/messages', {
    body: { model: 'Free/an/claude-sonnet-4-5', max_tokens: 64, system: 'sys', messages: [{ role: 'user', content: '你好' }] },
  });
  assert.equal(res.status, 200, res.text);

  // 上游 anthropic 收到的是 Messages 形状（x-api-key、system 提出来、max_tokens 必填）
  const call = mockAn.state.calls.at(-1);
  assert.equal(call.url, '/v1/messages');
  assert.equal(call.headers['x-api-key'], AN_KEY);
  assert.equal(call.body.system, 'sys');
  assert.equal(call.body.max_tokens, 64);

  // 客户端看到的还是 Anthropic 形状（只不过这次是上游给的原生 message 翻过来的）
  assert.equal(res.json.type, 'message');
  assert.deepEqual(res.json.content, [{ type: 'text', text: '来自 Anthropic 上游' }]);
  assert.equal(res.json.usage.input_tokens, 7);
});

test('M11-8) 未实现的端点：按 Anthropic 的错误形状回 404', async () => {
  const res = await anthropicApi('/embeddings', { body: {} });
  assert.equal(res.status, 404);
  assert.equal(res.json.type, 'error');
  assert.equal(res.json.error.type, 'not_found_error');
});
