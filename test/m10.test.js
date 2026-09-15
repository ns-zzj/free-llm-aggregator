'use strict';

/**
 * M10：上游 **openai-responses** 适配器（OpenAI Responses API）
 *
 * 客户端还是说 chat/completions（我们的内部形状），适配器负责在上游那一侧翻译：
 *   - 请求：`messages` → `input`(items) + `instructions`；`max_tokens` → `max_output_tokens`；
 *     tools 变扁（不再套一层 function）；`response_format` → `text.format`；**一定带 `store:false`**
 *   - 响应：`output`(items) → `choices[].message`；`input_tokens/output_tokens` → prompt/completion
 *   - 流式：命名事件（response.output_text.delta / response.completed…）→ chat chunk + [DONE]
 *   - HTTP 200 但 `status:'failed'` → 算上游失败（不能当成正常结果）
 *
 * 假上游按真实 API 的形状**严格校验**：形状不对就直接 400 —— 这样"过得了假上游"才等于"打真上游也不挂"。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const tmpRoot = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm10-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'm10-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-m10-key';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';

const ACCESS_KEY = process.env.ACCESS_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const UPSTREAM_KEY = 'sk-resp-test-key';
const UPSTREAM_MODEL = 'gpt-5.4-mini';

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

function sse(res, type, payload) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
}

/** 假 Responses 上游：严格按 Responses API 的形状校验 */
function createMockResponses() {
  const state = { calls: [], mode: 'ok', failMessage: '' };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    state.calls.push({ url: req.url, headers: req.headers, body });

    const fail = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message } }));
    };

    if (!req.url.endsWith('/v1/responses')) return fail(404, 'wrong path');
    if (req.headers.authorization !== `Bearer ${UPSTREAM_KEY}`) return fail(401, 'bad key');

    // ---- 形状校验（真实 API 就是这么挑错的）----
    if (Array.isArray(body.messages)) return fail(400, 'messages is not a Responses field, use input');
    if (!Array.isArray(body.input)) return fail(400, 'input: field required');
    if (body.store !== false) return fail(400, 'store must be false for this gateway');
    if (body.previous_response_id) return fail(400, 'previous_response_id is not supported');

    if (state.mode === 'failed') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'resp_failed', status: 'failed', error: { code: 'server_error', message: 'model crashed' } }));
      return;
    }

    const usage = { input_tokens: 11, output_tokens: 3, total_tokens: 14 };

    if (state.mode === 'stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, 'response.created', { response: { id: 'resp_1', model: UPSTREAM_MODEL } });
      sse(res, 'response.in_progress', { response: { id: 'resp_1', model: UPSTREAM_MODEL } });
      sse(res, 'response.reasoning_summary_text.delta', { delta: '想一下' });
      sse(res, 'response.output_text.delta', { delta: 'po' });
      sse(res, 'response.output_text.delta', { delta: 'ng' });
      sse(res, 'response.output_text.done', { text: 'pong' });
      sse(res, 'response.completed', {
        response: { id: 'resp_1', model: UPSTREAM_MODEL, status: 'completed', usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } },
      });
      res.end();
      return;
    }

    if (body.tools && body.tools.length) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'resp_tool',
          created_at: 1700000000,
          model: UPSTREAM_MODEL,
          status: 'completed',
          output: [
            { type: 'function_call', call_id: 'call_1', name: body.tools[0].name, arguments: '{"city":"SH"}' },
          ],
          usage,
        })
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_1',
        created_at: 1700000000,
        model: UPSTREAM_MODEL,
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: '先想' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] },
        ],
        usage,
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

let mock;
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

async function chat(body, { accept } = {}) {
  const res = await fetch(`${baseUrl}/openai/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ACCESS_KEY}`,
      ...(accept ? { accept } : {}),
    },
    body: JSON.stringify(body),
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

/** 把 SSE 文本拆成 [{event, data}] */
function parseSse(text) {
  const events = [];
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const event = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim() || null;
    const data = (lines.find((l) => l.startsWith('data:')) || '').slice(5).trim() || null;
    if (data === null) continue;
    events.push({ event, data });
  }
  return events;
}

test.before(async () => {
  mock = await createMockResponses();
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

  const provider = await adminApi('/providers', {
    method: 'POST',
    body: {
      id: 'rsp',
      name: 'OpenAI Responses',
      baseUrl: mock.baseUrl,
      apiKey: UPSTREAM_KEY,
      adapter: 'openai-responses',
      rateLimits: [],
      rejectPolicy: 'cooldown_probe',
      cooldownSeconds: 300,
    },
  });
  assert.equal(provider.status, 201, JSON.stringify(provider.json));
  assert.equal(provider.json.adapter, 'openai-responses');

  const model = await adminApi('/providers/rsp/models', { method: 'POST', body: { modelId: UPSTREAM_MODEL } });
  assert.equal(model.status, 201, JSON.stringify(model.json));
  // 标成"能看图"：否则带图的请求会在选源阶段被挡掉（那是 M9 的行为，别在这条测试里踩它）
  const vision = await adminApi(`/models/${model.json.id}`, { method: 'PATCH', body: { supportsVision: true } });
  assert.equal(vision.status, 200, JSON.stringify(vision.json));
});

test.after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  if (mock) await new Promise((resolve) => mock.server.close(resolve));
  const { db } = require('../src/db');
  await db.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('M10-1) 非流式：messages → input+instructions，output items → choices', async () => {
  const res = await chat({
    model: `Free/rsp/${UPSTREAM_MODEL}`,
    messages: [
      { role: 'system', content: '你是助手' },
      { role: 'user', content: 'ping' },
    ],
  });
  assert.equal(res.status, 200, res.text);

  // —— 上游收到了什么 ——
  const call = mock.state.calls.at(-1);
  assert.equal(call.url, '/v1/responses', '端点必须是 /responses');
  assert.equal(call.body.store, false, '必须带 store:false（不在上游留会话状态）');
  assert.equal(call.body.model, UPSTREAM_MODEL);
  assert.ok(!('messages' in call.body), '不能把 messages 透传给 Responses');
  assert.equal(call.body.instructions, '你是助手', 'system 要提到 instructions');
  assert.deepEqual(call.body.input, [{ role: 'user', content: 'ping' }]);

  // —— 客户端拿到了什么 ——
  const out = res.json;
  assert.equal(out.object, 'chat.completion');
  assert.equal(out.choices[0].message.role, 'assistant');
  assert.equal(out.choices[0].message.content, 'pong');
  assert.equal(out.choices[0].message.reasoning_content, '先想', 'reasoning 摘要要翻成 reasoning_content');
  assert.equal(out.choices[0].finish_reason, 'stop');
  assert.equal(out.usage.prompt_tokens, 11, 'input_tokens → prompt_tokens');
  assert.equal(out.usage.completion_tokens, 3, 'output_tokens → completion_tokens');
  assert.equal(out.usage.total_tokens, 14);
  assert.equal(out.model, UPSTREAM_MODEL, '指定来源：上游写啥就是啥');
});

test('M10-2) 工具调用：tools 变扁发上去，function_call 翻成 tool_calls', async () => {
  const res = await chat({
    model: `Free/rsp/${UPSTREAM_MODEL}`,
    messages: [{ role: 'user', content: '上海天气' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ],
    max_tokens: 256,
  });
  assert.equal(res.status, 200, res.text);

  const call = mock.state.calls.at(-1);
  assert.equal(call.body.max_output_tokens, 256, 'max_tokens → max_output_tokens');
  assert.ok(!('max_tokens' in call.body), '不能把 max_tokens 透传过去');
  assert.equal(call.body.tools.length, 1);
  assert.equal(call.body.tools[0].type, 'function');
  assert.equal(call.body.tools[0].name, 'get_weather', 'Responses 的函数定义不套 function 这层');
  assert.equal(call.body.tools[0].parameters.type, 'object');
  assert.equal(call.body.tools[0].strict, false);

  const message = res.json.choices[0].message;
  assert.equal(message.tool_calls[0].id, 'call_1', 'call_id → tool_calls[].id');
  assert.equal(message.tool_calls[0].function.name, 'get_weather');
  assert.equal(message.tool_calls[0].function.arguments, '{"city":"SH"}');
  assert.equal(res.json.choices[0].finish_reason, 'tool_calls');
});

test('M10-3) 多轮工具：助手发起的调用与工具结果都翻成 item', async () => {
  const res = await chat({
    model: `Free/rsp/${UPSTREAM_MODEL}`,
    messages: [
      { role: 'user', content: '上海天气' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SH"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '晴 26 度' },
    ],
  });
  assert.equal(res.status, 200, res.text);

  const input = mock.state.calls.at(-1).body.input;
  assert.deepEqual(input[0], { role: 'user', content: '上海天气' });
  assert.deepEqual(input[1], {
    type: 'function_call',
    call_id: 'call_1',
    name: 'get_weather',
    arguments: '{"city":"SH"}',
  });
  assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'call_1', output: '晴 26 度' });
});

test('M10-4) 带图请求：content 变成 input_text + input_image 的 parts', async () => {
  const res = await chat({
    model: `Free/rsp/${UPSTREAM_MODEL}`,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这是什么' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });
  assert.equal(res.status, 200, res.text);
  const input = mock.state.calls.at(-1).body.input;
  assert.deepEqual(input[0].content, [
    { type: 'input_text', text: '这是什么' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
  ]);
});

test('M10-5) 流式：命名事件翻成 chat chunk，结尾给 usage 与 [DONE]', async () => {
  mock.state.mode = 'stream';
  try {
    const res = await chat({
      model: `Free/rsp/${UPSTREAM_MODEL}`,
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

    const events = parseSse(res.text);
    const chunks = events.filter((e) => e.event === null && e.data !== '[DONE]').map((e) => JSON.parse(e.data));
    assert.ok(!events.some((e) => e.event), '客户端只该看到 data: 行，不该有 event: 行');

    // 起手 chunk 带 role（OpenAI 的形状）
    assert.equal(chunks[0].choices[0].delta.role, 'assistant');
    const deltaOf = (c, field) => (c.choices[0] && c.choices[0].delta ? c.choices[0].delta[field] : '') || '';
    const text = chunks.map((c) => deltaOf(c, 'content')).join('');
    assert.equal(text, 'pong', '两段 delta 要拼回完整文本');
    const reasoning = chunks.map((c) => deltaOf(c, 'reasoning_content')).join('');
    assert.equal(reasoning, '想一下');
    // 收尾：带 finish_reason 的 chunk + 只有 usage 的 chunk
    const last = chunks.at(-1);
    assert.equal(last.choices.length, 0, '最后一个是只有 usage 的 chunk');
    assert.equal(last.usage.prompt_tokens, 7);
    assert.equal(last.usage.completion_tokens, 2);
    assert.ok(
      chunks.some((c) => c.choices.length && c.choices[0].finish_reason === 'stop'),
      '要有一个带 finish_reason 的收尾 chunk'
    );
    assert.ok(events.some((e) => e.data === '[DONE]'), '结尾要有 [DONE]');
  } finally {
    mock.state.mode = 'ok';
  }
});

test('M10-6) HTTP 200 但 status:failed → 算上游失败，不能当正常结果返回', async () => {
  mock.state.mode = 'failed';
  try {
    const res = await chat({
      model: `Free/rsp/${UPSTREAM_MODEL}`,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(res.status, 502, `应该报上游失败，实际 ${res.status} ${res.text}`);
    assert.match(res.json.error.message, /model crashed/, '要把上游的原因带上');
  } finally {
    mock.state.mode = 'ok';
  }
});

test('M10-7) 适配器注册表里有它（后台下拉框现在从接口取，不再各抄一份）', async () => {
  const adapter = require('../src/gateway/adapter');
  assert.ok(adapter.ADAPTER_IDS.includes('openai-responses'), adapter.ADAPTER_IDS.join(','));
  const list = await adminApi('/adapters');
  const ids = (list.json.adapters || []).map((a) => a.id);
  assert.deepEqual(ids, adapter.ADAPTER_IDS, '接口返回的清单要和注册表一致');
  assert.ok(ids.includes('openai-responses'), `后台能选的协议：${ids.join(',')}`);
});
