'use strict';

/**
 * M12：**下游 Responses 方言**（`/openai/responses`）
 *
 * 覆盖 2.0.0 的最后一块：客户端说 Responses，我们内部照旧是 chat completions。
 * 两个上游都要能配：
 *   - openai-compatible（假上游 A）：最常见的情况
 *   - openai-responses（假上游 B）：我们自己翻译出去、再翻译回来 —— 一来一回正好验两个方向的映射
 *
 * 另外覆盖：无状态网关的两条规矩（store 恒等于关、previous_response_id 明确 400）、
 * 流式的命名事件、错误体形状、未实现端点。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const tmpRoot = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm12-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'm12-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-m12-key';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';

const ACCESS_KEY = process.env.ACCESS_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const OA_KEY = 'sk-oa-key';
const RSP_KEY = 'sk-rsp-key';

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
  });
}

function createMockOpenAI() {
  const state = { calls: [], mode: 'ok' };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    state.calls.push({ url: req.url, headers: req.headers, body });
    if (!req.url.endsWith('/chat/completions') || req.headers.authorization !== `Bearer ${OA_KEY}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad', type: 'authentication_error' } }));
      return;
    }

    // 推理模型只出思考、正文被预算截断（实测 DeepSeek V4 会给这种响应）
    if (state.mode === 'reasoning-only') {
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
        chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
        chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { reasoning_content: '想' } }] });
        chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { reasoning_content: '一下' } }] });
        chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] });
        chunk({ id: 'c1', object: 'chat.completion.chunk', model: body.model, choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } });
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-r',
          object: 'chat.completion',
          created: 1700000002,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: '想一下' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
        })
      );
      return;
    }

    const wantsTool = Array.isArray(body.tools) && body.tools.length;

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

/** 假 Responses 上游：严格按 Responses 的形状校验 */
function createMockResponses() {
  const state = { calls: [] };
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    state.calls.push({ url: req.url, headers: req.headers, body });

    const fail = (status, message) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
    };
    if (!req.url.endsWith('/v1/responses')) return fail(404, 'wrong path');
    if (req.headers.authorization !== `Bearer ${RSP_KEY}`) return fail(401, 'bad key');
    if (Array.isArray(body.messages)) return fail(400, 'use input, not messages');
    if (body.store !== false) return fail(400, 'store must be false');

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'resp_upstream_1',
        created_at: 1700000001,
        model: body.model,
        status: 'completed',
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '来自 Responses 上游' }] }],
        usage: { input_tokens: 13, output_tokens: 6, total_tokens: 19 },
      })
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

let mockOa;
let mockRsp;
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

/** 以 Responses 客户端的身份发请求 */
async function responsesApi({ body, key = ACCESS_KEY }) {
  const res = await fetch(`${baseUrl}/openai/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
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

function parseSse(text) {
  const events = [];
  for (const block of String(text).split('\n\n')) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    const event = (lines.find((l) => l.startsWith('event:')) || '').slice(6).trim() || null;
    const raw = (lines.find((l) => l.startsWith('data:')) || '').slice(5).trim();
    if (!raw) continue;
    events.push({ event, data: JSON.parse(raw) });
  }
  return events;
}

test.before(async () => {
  mockOa = await createMockOpenAI();
  mockRsp = await createMockResponses();
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
    { id: 'rsp', name: 'Responses', baseUrl: mockRsp.baseUrl, apiKey: RSP_KEY, adapter: 'openai-responses' },
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
    ['rsp', 'gpt-5.4-mini'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi(`/providers/${providerId}/models`, { method: 'POST', body: { modelId } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
});

test.after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  if (mockOa) await new Promise((resolve) => mockOa.server.close(resolve));
  if (mockRsp) await new Promise((resolve) => mockRsp.server.close(resolve));
  const { db } = require('../src/db');
  await db.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('M12-1) 非流式：Responses 请求 → openai-compatible 上游 → 回来还是 Responses 形状', async () => {
  const res = await responsesApi({
    body: {
      model: 'Free/oa/m-x',
      instructions: '你是助手',
      input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
      max_output_tokens: 128,
    },
  });
  assert.equal(res.status, 200, res.text);

  // 上游收到的是内部形状（instructions 变 system 消息、max_output_tokens 变 max_tokens）
  const call = mockOa.state.calls.at(-1);
  assert.deepEqual(call.body.messages, [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
  ]);
  assert.equal(call.body.max_tokens, 128);

  // 客户端拿到 Responses 形状
  assert.equal(res.json.object, 'response');
  assert.match(res.json.id, /^resp_/);
  assert.equal(res.json.status, 'completed');
  const messageItem = res.json.output.find((o) => o.type === 'message');
  assert.ok(messageItem, JSON.stringify(res.json.output));
  // 形状对着实测的真 API：output_text 块带 annotations + logprobs，message 项带 phase
  assert.deepEqual(messageItem.content, [{ type: 'output_text', text: '你好呀', annotations: [], logprobs: [] }]);
  assert.equal(messageItem.phase, 'final_answer');
  assert.equal(res.json.usage.input_tokens, 11);
  assert.equal(res.json.usage.output_tokens, 4);
});

test('M12-2) 工具调用：function_call 项往返（input/output 项都翻对）', async () => {
  const res = await responsesApi({
    body: {
      model: 'Free/oa/m-x',
      input: [
        { role: 'user', content: '上海天气' },
        { type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '{"city":"SH"}' },
        { type: 'function_call_output', call_id: 'call_9', output: '晴 26 度' },
      ],
      tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: {} } }],
    },
  });
  assert.equal(res.status, 200, res.text);

  const body = mockOa.state.calls.at(-1).body;
  assert.deepEqual(body.messages[1], {
    role: 'assistant',
    content: '',
    tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'get_weather', arguments: '{"city":"SH"}' } }],
  });
  assert.deepEqual(body.messages[2], { role: 'tool', tool_call_id: 'call_9', content: '晴 26 度' });
  assert.equal(body.tools[0].type, 'function', '工具定义要包回 function 给上游');

  // 客户端看到 function_call 项（arguments 是字符串）
  const fn = res.json.output.find((o) => o.type === 'function_call');
  assert.ok(fn, JSON.stringify(res.json.output));
  assert.equal(fn.name, 'get_weather');
  assert.equal(fn.arguments, '{"city":"SH"}');
  assert.equal(fn.call_id, 'call_1', '内部 id 要原样带出来，客户端才能对上');
});

test('M12-3) 流式：响应是命名事件（response.created → deltas → response.completed）', async () => {
  const res = await responsesApi({
    body: { model: 'Free/oa/m-x', input: '你好', stream: true },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);

  const events = parseSse(res.text);
  assert.equal(events[0].event, 'response.created');
  assert.equal(events[0].data.response.status, 'in_progress');

  const text = events
    .filter((e) => e.event === 'response.output_text.delta')
    .map((e) => e.data.delta)
    .join('');
  assert.equal(text, '你好');

  const completed = events.find((e) => e.event === 'response.completed');
  assert.ok(completed, '结尾要有 response.completed');
  assert.equal(completed.data.response.status, 'completed');
  assert.equal(completed.data.response.usage.input_tokens, 9);
  assert.equal(completed.data.response.usage.output_tokens, 2);
  const item = completed.data.response.output.find((o) => o.type === 'message');
  assert.equal(item.content[0].text, '你好');
  assert.equal(events.at(-1).event, 'response.completed', 'completed 是最后一个事件');
});

test('M12-4) 跨协议：同一个 Responses 请求打到 openai-responses 上游（两个方向都翻）', async () => {
  const res = await responsesApi({
    body: { model: 'Free/rsp/gpt-5.4-mini', instructions: 'sys', input: '你好' },
  });
  assert.equal(res.status, 200, res.text);

  const call = mockRsp.state.calls.at(-1);
  assert.equal(call.url, '/v1/responses', '上游是 Responses 就该打 /responses');
  assert.equal(call.body.store, false);
  assert.equal(call.body.instructions, 'sys');
  assert.deepEqual(call.body.input, [{ role: 'user', content: '你好' }]);

  const messageItem = res.json.output.find((o) => o.type === 'message');
  assert.equal(messageItem.content[0].text, '来自 Responses 上游');
  assert.equal(res.json.model, 'gpt-5.4-mini');
  assert.equal(res.json.usage.input_tokens, 13);
});

test('M12-5) 无状态：previous_response_id 明确 400，store 恒等于关掉', async () => {
  const res = await responsesApi({
    body: { model: 'Free/oa/m-x', input: '你好', previous_response_id: 'resp_abc' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error.code, 'stateless_gateway');
  assert.match(res.json.error.message, /无状态/);
  assert.equal(mockOa.state.calls.at(-1).body.model, 'm-x', '不该把这种请求打到上游（这条是上一次测试留下的调用，不变）');

  // store:true 我们不吃（网关无状态），照常给结果
  const withStore = await responsesApi({ body: { model: 'Free/oa/m-x', input: '你好', store: true } });
  assert.equal(withStore.status, 200);
  assert.equal(withStore.json.object, 'response');
});

test('M12-6) 参数校验与鉴权：缺 input 400；口令不对 401（OpenAI 错误形状）', async () => {
  const noInput = await responsesApi({ body: { model: 'Free/oa/m-x' } });
  assert.equal(noInput.status, 400);
  assert.equal(typeof noInput.json.error.message, 'string');

  const bad = await responsesApi({ body: { model: 'Free/oa/m-x', input: 'x' }, key: 'sk-wrong' });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.error.code, 'invalid_api_key');

  const noModel = await responsesApi({ body: { input: 'x' } });
  assert.equal(noModel.status, 400);
});

test('M12-7) 推理模型只出思考（预算被截断）：思考要能传下去，收尾用 incomplete', async () => {
  // 这是实测 DeepSeek V4 的行为：max_output_tokens 是"思考+正文"共享的预算，
  // 给太小就只在 reasoning 里输出，一条 message 都没有。客户端不能因此什么都看不到。
  mockOa.state.mode = 'reasoning-only';
  try {
    const streamRes = await responsesApi({
      body: { model: 'Free/oa/m-x', input: '你好', stream: true },
    });
    assert.equal(streamRes.status, 200);
    const events = parseSse(streamRes.text);
    const reasoning = events
      .filter((e) => e.event === 'response.reasoning_text.delta')
      .map((e) => e.data.delta)
      .join('');
    assert.equal(reasoning, '想一下', '思考增量要发出去（不然客户端一个字都收不到）');
    const last = events.at(-1);
    assert.equal(last.event, 'response.incomplete', '被 max_output_tokens 截断要用 incomplete 收尾');
    assert.equal(last.data.response.status, 'incomplete');
    assert.equal(last.data.response.incomplete_details.reason, 'max_output_tokens');
    const reasoningItem = last.data.response.output.find((o) => o.type === 'reasoning');
    assert.ok(reasoningItem, JSON.stringify(last.data.response.output));
    assert.equal(reasoningItem.content[0].text, '想一下');
    assert.ok(!last.data.response.output.some((o) => o.type === 'message'), '没正文就不该硬塞空的 message 项');
  } finally {
    mockOa.state.mode = 'ok';
  }

  // 非流式同理：只有一个 reasoning 项，status=incomplete
  mockOa.state.mode = 'reasoning-only';
  try {
    const res = await responsesApi({ body: { model: 'Free/oa/m-x', input: '你好' } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, 'incomplete');
    assert.equal(res.json.incomplete_details.reason, 'max_output_tokens');
    assert.equal(res.json.output.length, 1);
    assert.equal(res.json.output[0].type, 'reasoning');
    assert.equal(res.json.output[0].content[0].text, '想一下');
  } finally {
    mockOa.state.mode = 'ok';
  }
});
