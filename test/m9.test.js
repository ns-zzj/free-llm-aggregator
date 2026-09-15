'use strict';

/**
 * M9：**图片（视觉）支持**
 *
 * 用户 2026-09-12 的设计（原话）：
 *   "给下游的信息就是支持接受图片。然后看列表里哪个支持图片理解。没有就报错。
 *    因为给下游发能不能接受图片都不能动态调整，下游只会获取一次这个模型能不能发图片。
 *    所以只能接受，收到了再看上游行不行。"
 *
 * 拆成可验证的几条：
 *   - 虚拟名字（`All` / `ModelGroup/<组名>`）**永远**对外声明"能收图"，哪怕当下一个能看图的都没有
 *     （下游只在拉列表时看一眼能力，不能动态调整）
 *   - 具体模型按各自的标记声明（`architecture.input_modalities` 等，OpenRouter 那套写法）
 *   - 真收到带图的请求：候选只保留标了「支持图片理解」的模型；**一个都没有 → 400**（配置问题）
 *   - 有能看图的但此刻都不可用 → 503（可恢复），和 400 分开
 *   - 指定一个不支持图片的模型 + 带图 → 400，且**不打上游**（不浪费、也不把图偷偷丢掉）
 *   - anthropic 适配器要把 OpenAI 的图片块翻译成 Anthropic 的 image 块（data URL 与 http URL 两种）
 */

const test = require('node:test');
// 同 m0：用例之间复位「失败锁定」（它按来源 IP 记，而本文件有些用例会连着打错误请求）
test.beforeEach(() => require('../src/app').v1FailureGuard.reset());
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const tmpRoot = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm9-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'm9-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-m9-key';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';

const ACCESS_KEY = process.env.ACCESS_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

/** OpenAI 形状的假上游：把收到的 body 记下来，方便断言"图有没有被丢掉" */
function createOpenAiMock({ tag }) {
  const state = { mode: 'ok', calls: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      state.calls.push({ url: req.url, body });
      if (state.mode === 'server_error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `${tag} boom` } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${tag}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: `pong-from-${tag}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

/** Anthropic 形状的假上游：只用来验证图片块翻译得对不对 */
function createAnthropicMock() {
  const state = { calls: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      state.calls.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_mock',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: 'pong-from-anthropic' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 11, output_tokens: 3 },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

let mockVision;
let mockText;
let mockAnthropic;
let appServer;
let baseUrl;
let cookie = '';
const modelIds = {};

async function adminApi(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}/api/admin${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function chat(body) {
  const res = await fetch(`${baseUrl}/openai/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

const readModels = async () =>
  (await (await fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } })).json()).data;
const modelEntry = async (id) => (await readModels()).find((m) => m.id === id);

/** 一张 1x1 的透明 PNG（data URL） */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function imageMessage(text = '这是什么？') {
  return {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: PNG_DATA_URL } },
    ],
  };
}

const setVision = (id, supportsVision) => adminApi(`/models/${id}`, { method: 'PATCH', body: { supportsVision } });

test.before(async () => {
  mockVision = await createOpenAiMock({ tag: 'vision' });
  mockText = await createOpenAiMock({ tag: 'text' });
  mockAnthropic = await createAnthropicMock();
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

  const createProvider = async (body) => {
    const res = await adminApi('/providers', { method: 'POST', body });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  };
  await createProvider({
    id: 'vis-a',
    name: '能看图的来源',
    baseUrl: mockVision.baseUrl,
    apiKey: 'key-vis',
    rateLimits: [],
    rejectPolicy: 'cooldown_probe',
    cooldownSeconds: 300,
  });
  await createProvider({
    id: 'text-b',
    name: '只能读字的来源',
    baseUrl: mockText.baseUrl,
    apiKey: 'key-text',
    rateLimits: [],
    rejectPolicy: 'cooldown_probe',
    cooldownSeconds: 300,
  });
  await createProvider({
    id: 'anth',
    name: 'Anthropic 形状的来源',
    adapter: 'anthropic',
    baseUrl: mockAnthropic.baseUrl,
    apiKey: 'key-anth',
    rateLimits: [],
    rejectPolicy: 'cooldown_probe',
    cooldownSeconds: 300,
  });

  for (const [providerId, modelId] of [
    ['vis-a', 'vm1'],
    ['text-b', 'tm1'],
    ['text-b', 'tm2'],
    ['anth', 'claude-x'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi(`/providers/${providerId}/models`, { method: 'POST', body: { modelId } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    modelIds[`${providerId}/${modelId}`] = res.json.id;
  }
  // 只有 vm1 和 claude-x 标"支持图片理解"
  await setVision(modelIds['vis-a/vm1'], true);
  await setVision(modelIds['anth/claude-x'], true);
});

test.after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  const { db } = require('../src/db');
  await db.destroy();
  for (const mock of [mockVision, mockText, mockAnthropic]) {
    if (mock) await new Promise((resolve) => mock.server.close(resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('M9-1) /openai/models：虚拟名字一律声明能收图，具体模型按标记声明', async () => {
  const all = await modelEntry('All');
  assert.deepEqual(all.input_modalities, ['text', 'image'], 'All 的顶层要声明能收图');
  assert.deepEqual(all.architecture.input_modalities, ['text', 'image'], 'OpenRouter 那套写法也要有');
  assert.equal(all.architecture.modality, 'text+image->text');
  assert.deepEqual(all.architecture.output_modalities, ['text']);

  const visionModel = await modelEntry('Free/vis-a/vm1');
  assert.deepEqual(visionModel.input_modalities, ['text', 'image'], '标了图片的模型对外声明能收图');

  const textModel = await modelEntry('Free/text-b/tm1');
  assert.deepEqual(textModel.input_modalities, ['text'], '没标的只能收文字');
  assert.equal(textModel.architecture.modality, 'text->text');

  // 模型组也一律声明能收图
  const group = (await adminApi('/model-groups', { method: 'POST', body: { name: '图片组' } })).json;
  await adminApi(`/model-groups/${group.id}/items`, { method: 'POST', body: { providerModelId: modelIds['text-b/tm1'] } });
  const groupEntry = await modelEntry('ModelGroup/图片组');
  assert.deepEqual(groupEntry.input_modalities, ['text', 'image'], '模型组也要声明能收图');

  // 关键：把能看图的标记全关掉，虚拟名字**照样**声明能收图
  await setVision(modelIds['vis-a/vm1'], false);
  await setVision(modelIds['anth/claude-x'], false);
  const allNoVision = await modelEntry('All');
  assert.deepEqual(allNoVision.input_modalities, ['text', 'image'], '没有能看图的模型时，All 依然要声明能收图');
  await setVision(modelIds['vis-a/vm1'], true);
  await setVision(modelIds['anth/claude-x'], true);
});

test('M9-2) 带图的请求：只走标了图片的模型，图原样送上去', async () => {
  const visionBefore = mockVision.state.calls.length;
  const textBefore = mockText.state.calls.length;

  const res = await chat({ model: 'All', messages: [imageMessage()] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].message.content, 'pong-from-vision');

  assert.equal(mockVision.state.calls.length, visionBefore + 1, '走的是能看图的来源');
  assert.equal(mockText.state.calls.length, textBefore, '不能看图的来源一次都不该被调用');

  const sent = mockVision.state.calls.at(-1).body;
  assert.ok(Array.isArray(sent.messages[0].content), '发给上游的 content 还是数组（没被拍平成字符串）');
  assert.equal(sent.messages[0].content[1].type, 'image_url');
  assert.equal(sent.messages[0].content[1].image_url.url, PNG_DATA_URL, '图片要原样送上去，不能丢');
});

test('M9-3) 一个能看图的模型都没有 → 400（配置问题，不是 503）', async () => {
  // 两个标了图片的模型都关掉，才算"一个都没有"
  await setVision(modelIds['vis-a/vm1'], false);
  await setVision(modelIds['anth/claude-x'], false);
  const visionBefore = mockVision.state.calls.length;
  const anthBefore = mockAnthropic.state.calls.length;
  try {
    const res = await chat({ model: 'All', messages: [imageMessage()] });
    assert.equal(res.status, 400, JSON.stringify(res.json));
    assert.equal(res.json.error.code, 'image_not_supported');
    assert.match(res.json.error.message, /支持图片/);
    assert.equal(mockVision.state.calls.length, visionBefore, '不该白打上游');
    assert.equal(mockAnthropic.state.calls.length, anthBefore, '也不能偷偷丢掉图片打别的模型');
  } finally {
    await setVision(modelIds['vis-a/vm1'], true);
    await setVision(modelIds['anth/claude-x'], true);
  }

  // 文字请求不受影响（还是能正常走）
  const ok = await chat({ model: 'All', messages: [{ role: 'user', content: '你好' }] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('M9-4) 指定一个不能看图的模型 + 带图 → 400，且不打上游', async () => {
  const before = mockText.state.calls.length;
  const res = await chat({ model: 'Free/text-b/tm1', messages: [imageMessage()] });
  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.equal(res.json.error.code, 'image_not_supported');
  assert.match(res.json.error.message, /tm1|Free\/text-b\/tm1/, '要点出是哪个模型');
  assert.equal(mockText.state.calls.length, before, '不该把图丢掉再发过去');
});

test('M9-5) 能看图的模型此刻都不可用 → 503（这个会自己好，和 400 区分开）', async () => {
  // 只留 vm1 一个图片模型（把另一个的标记关掉），然后把它打成故障
  await setVision(modelIds['anth/claude-x'], false);
  await adminApi('/providers/vis-a/state', { method: 'POST', body: { status: 'stopped' } });
  try {
    const res = await chat({ model: 'All', messages: [imageMessage()] });
    assert.equal(res.status, 503, JSON.stringify(res.json));
    assert.equal(res.json.error.code, 'no_available_source', '是"暂时不可用"，不是"不支持图片"');
  } finally {
    await adminApi('/providers/vis-a/state', { method: 'POST', body: { status: 'available' } });
    await setVision(modelIds['anth/claude-x'], true);
  }
  // 恢复之后同一条请求就能过
  const ok = await chat({ model: 'All', messages: [imageMessage()] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
});

test('M9-6) anthropic 适配器：图片要翻成 Anthropic 的 image 块（data URL 与 http URL 两种）', async () => {
  const before = mockAnthropic.state.calls.length;
  const res = await chat({ model: 'Free/anth/claude-x', messages: [imageMessage('看看这个')] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].message.content, 'pong-from-anthropic');

  const sent = mockAnthropic.state.calls.at(-1).body;
  const blocks = sent.messages[0].content;
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'image', 'data URL 要翻成 base64 的 image 块');
  assert.equal(blocks[1].source.type, 'base64');
  assert.equal(blocks[1].source.media_type, 'image/png');
  assert.ok(blocks[1].source.data.length > 10, 'base64 数据要带过去');
  assert.ok(!String(blocks[1].source.data).startsWith('data:'), 'data: 前缀要去掉（Anthropic 只认纯 base64）');

  // http(s) 图片：Anthropic 走 url 类型的 source
  await chat({
    model: 'Free/anth/claude-x',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '这张呢' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } },
        ],
      },
    ],
  });
  const httpBlocks = mockAnthropic.state.calls.at(-1).body.messages[0].content;
  assert.deepEqual(httpBlocks[1], { type: 'image', source: { type: 'url', url: 'https://example.com/a.jpg' } });
  assert.ok(mockAnthropic.state.calls.length > before);
});
