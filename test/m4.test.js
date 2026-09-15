'use strict';

/**
 * M4 端到端测试：对外模型名规则 + All 自动换源
 *   - /v1/models 只发布 All 与「带类别前缀」的模型名（Free/ 免费、Pay/ 付费）
 *   - All：按「All模型顺序」页的顺序自动选，失败自动换下一个（免费在前、付费兜底），全挂统一 503
 *   - 指定来源（`Free/来源id/模型名`、`Pay/来源id/模型名`）：不换源，本机限速报 429，上游错误原样转发
 *   - 不带来源 / 来源不存在 / PAY 用错 → 404 并提示正确格式
 */

const test = require('node:test');
// 同 m0：用例之间复位「失败锁定」（本文件 M4-7 那种"连打 8 条错误请求验文案"的用例，
// 不复位的话后面的用例会莫名其妙吃到 429）
test.beforeEach(() => require('../src/app').v1FailureGuard.reset());
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const tmpRoot = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm4-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'm4-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-m4-key';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';

const ACCESS_KEY = process.env.ACCESS_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ------------------------------------------------------------------ 假上游

function createMockUpstream({ tag }) {
  const state = { mode: 'ok', calls: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      state.calls.push({ url: req.url, body });
      if (state.mode === 'rate_limit') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '7' });
        res.end(JSON.stringify({ error: { message: `${tag}: Rate limit reached`, type: 'rate_limit_error' } }));
        return;
      }
      if (state.mode === 'server_error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `${tag}: upstream boom` } }));
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

// ------------------------------------------------------------------ 脚手架

let mockFree;
let mockPaid;
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
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null, headers: res.headers };
}

test.before(async () => {
  mockFree = await createMockUpstream({ tag: 'free' });
  mockPaid = await createMockUpstream({ tag: 'paid' });
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

  const create = async (body) => {
    const res = await adminApi('/providers', { method: 'POST', body });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  };
  await create({
    id: 'free-a',
    name: '免费来源 A',
    baseUrl: mockFree.baseUrl,
    apiKey: 'key-free-a',
    rateLimits: [],
    rejectPolicy: 'cooldown_probe',
    cooldownSeconds: 300,
  });
  await create({
    id: 'paid-b',
    name: '付费兜底 B',
    baseUrl: mockPaid.baseUrl,
    apiKey: 'key-paid-b',
    isPaid: true,
    rateLimits: [],
    rejectPolicy: 'cooldown_probe',
    cooldownSeconds: 300,
  });

  for (const providerId of ['free-a', 'paid-b']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi(`/providers/${providerId}/models`, {
      method: 'POST',
      body: { modelId: 'm-x' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
});

test.after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  const { db } = require('../src/db');
  await db.destroy();
  for (const mock of [mockFree, mockPaid]) {
    if (mock) await new Promise((resolve) => mock.server.close(resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ 用例

test('M4-1) /v1/models 发布 All + 带类别前缀的模型名（Free/ 免费、Pay/ 付费）', async () => {
  const res = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(
    json.data.map((m) => m.id),
    ['All', 'Free/free-a/m-x', 'Pay/paid-b/m-x'],
    '模型名必须带类别前缀，All 排第一'
  );
  assert.equal(json.data[0].owned_by, 'llm-aggregator');
  assert.equal(json.data[1].owned_by, 'Free/free-a');
  assert.equal(json.data[2].owned_by, 'Pay/paid-b');

  // 单个查询也要支持带斜杠的名字
  const one = await fetch(`${baseUrl}/v1/models/Pay/paid-b/m-x`, {
    headers: { authorization: `Bearer ${ACCESS_KEY}` },
  });
  assert.equal(one.status, 200, 'Pay/... 这种带斜杠的名字也要能查');
  assert.equal((await one.json()).id, 'Pay/paid-b/m-x');
});

test('M4-2) All：免费来源挂了自动换到付费兜底', async () => {
  mockFree.state.mode = 'rate_limit';
  const freeCalls = mockFree.state.calls.length;
  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].message.content, 'pong-from-paid', '应由付费来源兜底');
  assert.equal(res.json.model, 'All', '对外保持客户端请求的模型名');
  assert.ok(mockFree.state.calls.length > freeCalls, '先试了免费来源');
  assert.equal(mockPaid.state.calls.at(-1).body.model, 'm-x', '发给上游的应是真实模型名');

  const logs = await adminApi('/logs?limit=3');
  assert.equal(logs.json[0].status, 'fallback');
  assert.equal(logs.json[0].providerId, 'paid-b');
  assert.equal(logs.json[0].isPaidFallback, true, '应标记"用了付费兜底"');
  assert.equal(logs.json[0].modelName, 'All(m-x)', 'All 要显示出实际用的模型');
  assert.equal(logs.json[0].sourceLabel, 'Pay/paid-b');
});

test('M4-3) All：免费与付费全挂 → 统一 503，不暴露上游细节', async () => {
  mockPaid.state.mode = 'server_error';
  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 503, JSON.stringify(res.json));
  const body = JSON.stringify(res.json);
  assert.ok(!body.includes('free-a') && !body.includes('paid-b'), '不应暴露来源 id');
  assert.ok(!body.includes('Rate limit reached') && !body.includes('upstream boom'), '不应转发上游错误原文');
  // 免费来源已在冷却，付费来源这次失败 → 两个都不可用
  const overview = await adminApi('/overview');
  const paidState = overview.json.providers.find((p) => p.id === 'paid-b').state;
  assert.equal(paidState.status, 'cooldown');

  mockFree.state.mode = 'ok';
  mockPaid.state.mode = 'ok';
  await adminApi('/providers/free-a/state', { method: 'POST', body: { status: 'available' } });
  await adminApi('/providers/paid-b/state', { method: 'POST', body: { status: 'available' } });
});

test('M4-4) 指定免费来源：上游 429 原样转发（含 Retry-After），不换源', async () => {
  mockFree.state.mode = 'rate_limit';
  const paidBefore = mockPaid.state.calls.length;
  const res = await chat({ model: 'Free/free-a/m-x', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 429, JSON.stringify(res.json));
  assert.equal(res.headers.get('retry-after'), '7', '上游的 Retry-After 应转发给下游');
  assert.match(res.json.error.message, /Rate limit reached/, '上游错误原文应转发');
  assert.equal(mockPaid.state.calls.length, paidBefore, '指定来源时不换源');

  mockFree.state.mode = 'ok';
  await adminApi('/providers/free-a/state', { method: 'POST', body: { status: 'available' } });
});

test('M4-5) 指定付费来源：Pay/ 前缀可用，且不走免费来源', async () => {
  mockPaid.state.mode = 'ok';
  await adminApi('/providers/paid-b/state', { method: 'POST', body: { status: 'available' } });
  const freeBefore = mockFree.state.calls.length;

  const res = await chat({ model: 'Pay/paid-b/m-x', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].message.content, 'pong-from-paid');
  assert.equal(res.json.model, 'm-x', '指定来源时上游写啥就是啥');
  assert.equal(mockFree.state.calls.length, freeBefore, '指定付费来源时不应去碰免费来源');

  // 日志展示：请求模型只留模型名，来源带 Pay/ 前缀（付费来源一眼看出来）
  const logs = await adminApi('/logs?limit=1');
  assert.equal(logs.json[0].requestModel, 'Pay/paid-b/m-x', '原始请求名照原样存着');
  assert.equal(logs.json[0].modelName, 'm-x');
  assert.equal(logs.json[0].sourceLabel, 'Pay/paid-b');
});

test('M4-6) 指定来源不可用（冷却中）→ 503，不偷偷换源', async () => {
  // 先让它因为上游 429 进冷却
  mockFree.state.mode = 'rate_limit';
  const warm = await chat({ model: 'Free/free-a/m-x', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(warm.status, 429, JSON.stringify(warm.json));
  // 上游恢复正常，但来源还在冷却里 → 指定来源的请求应该直接报错，而不是换到付费来源
  mockFree.state.mode = 'ok';

  const paidBefore = mockPaid.state.calls.length;
  const res = await chat({ model: 'Free/free-a/m-x', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 503, JSON.stringify(res.json));
  assert.equal(res.json.error.code, 'source_unavailable');
  assert.match(res.json.error.message, /上游限流/);
  assert.equal(mockPaid.state.calls.length, paidBefore, '指定来源时不换源');
  assert.ok(res.headers.get('retry-after'), '应给出建议重试时间');

  await adminApi('/providers/free-a/state', { method: 'POST', body: { status: 'available' } });
});

test('M4-7) 模型名不合规 → 404 并提示正确格式', async () => {
  const cases = [
    ['m-x', /要写全/, '裸模型名（连来源都没带）'],
    ['auto', /已改名为/, 'auto 不再认，要提示改成 All'],
    ['nope/m-x', /不存在/, '来源不存在'],
    ['free-a/nope', /要带上类别/, '免费来源漏了 Free/'],
    ['paid-b/m-x', /要带上类别/, '付费来源漏了 Pay/'],
    ['Pay/free-a/m-x', /不是付费来源/, '免费来源不该加 Pay/'],
    ['Pay/paid-b/nope', /没有启用中的模型/, '付费来源下没有这个模型'],
    ['ModelGroup/查无此组', /没有名叫/, '模型组不存在'],
  ];
  for (const [i, [name, pattern, label]] of cases.entries()) {
    // 这些都是故意打错的错误路径，验的是文案 —— 每 4 条复位一次「失败锁定」，
    // 不然第 6 条起就会吃到 429（同 IP 连续 5 次失败锁 5 分钟，由 test/m6.test.js 专门验）
    if (i > 0 && i % 4 === 0) require('../src/app').v1FailureGuard.reset();
    // eslint-disable-next-line no-await-in-loop
    const res = await chat({ model: name, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.status, 404, `${label}（${name}）应 404，实际 ${res.status}`);
    assert.equal(res.json.error.code, 'model_not_found');
    assert.match(res.json.error.message, pattern, `${label}（${name}）的提示文案`);
  }
});

test('M4-8) 类别前缀大小写不敏感（pay/、FREE/ 也认，老客户端的大写 PAY/ 不会当场断）', async () => {
  const lower = await chat({ model: 'free/free-a/m-x', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(lower.status, 200, JSON.stringify(lower.json));
  assert.equal(mockFree.state.calls.at(-1).body.model, 'm-x', '前缀只是名字，发给上游的还是真实模型名');

  mockPaid.state.mode = 'ok';
  await adminApi('/providers/paid-b/state', { method: 'POST', body: { status: 'available' } });
  const upperPaid = await chat({ model: 'PAY/paid-b/m-x', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(upperPaid.status, 200, '大写 PAY/ 照样认（升级不打断在用的客户端）');
  assert.equal(mockPaid.state.calls.at(-1).body.model, 'm-x');
});

test('M4-9) 「测试」按钮写的日志跟客户端请求长得一样（发布名）', async () => {
  mockPaid.state.mode = 'ok';
  await adminApi('/providers/paid-b/state', { method: 'POST', body: { status: 'available' } });
  const result = await adminApi('/providers/paid-b/test', { method: 'POST', body: { modelId: 'm-x' } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.ok, true, JSON.stringify(result.json));

  const logs = await adminApi('/logs?limit=1');
  assert.equal(logs.json[0].requestModel, 'Pay/paid-b/m-x', '测试记录也按发布名写，和客户端请求一致');
  // 测试/探测也是真调用，用量要记账 —— 主页「今日 token」是"今天所有请求全加起来"，不能漏这一类
  assert.equal(logs.json[0].promptTokens, 5, '测试的输入 token 要记下来');
  assert.equal(logs.json[0].completionTokens, 2, '输出 token 也要记');
  assert.equal(logs.json[0].modelName, 'm-x');
  assert.equal(logs.json[0].sourceLabel, 'Pay/paid-b');
  assert.equal(logs.json[0].isProbe, false, '测试算真实调用');
});

test('M4-10) 日志拆分规则：模型名带斜杠的上游名不会被误当成来源', async () => {
  const callLog = require('../src/store/callLog');
  const providerIds = new Set(['deepseek', 'modelscope-cn']);
  const paid = callLog.toApi(
    {
      request_model: 'Pay/deepseek/deepseek-v4-flash',
      provider_id: 'deepseek',
      real_model: 'deepseek-v4-flash',
      provider_is_paid: 1,
    },
    { providerIds }
  );
  assert.equal(paid.modelName, 'deepseek-v4-flash');
  assert.equal(paid.sourceLabel, 'Pay/deepseek');

  const free = callLog.toApi(
    {
      request_model: 'Free/modelscope-cn/deepseek-ai/DeepSeek-V4-Flash-0731',
      provider_id: 'modelscope-cn',
      real_model: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      provider_is_paid: 0,
    },
    { providerIds }
  );
  assert.equal(free.modelName, 'deepseek-ai/DeepSeek-V4-Flash-0731', '上游名里的斜杠要保留');
  assert.equal(free.sourceLabel, 'Free/modelscope-cn', '免费来源带 Free/ 前缀，一眼看出免费还是付费');

  const virtual = callLog.toApi(
    {
      request_model: 'All',
      provider_id: 'modelscope-cn',
      real_model: 'Qwen/Qwen3.8-Flash-Next',
      provider_is_paid: 0,
    },
    { providerIds }
  );
  assert.equal(virtual.modelName, 'All(Qwen/Qwen3.8-Flash-Next)', 'All 要写出实际用的模型');
  assert.equal(virtual.sourceLabel, 'Free/modelscope-cn');

  // All 没挑到任何来源时（real_model 为空）也不要显示成空串
  const autoNoSource = callLog.toApi(
    { request_model: 'All', provider_id: null, real_model: null, provider_is_paid: 0 },
    { providerIds }
  );
  assert.equal(autoNoSource.modelName, 'All');
  assert.equal(autoNoSource.sourceLabel, '', '没有来源时来源列留空');

  // 历史记录：探测行直接写了带斜杠的上游模型名，第一段不是来源 id → 整串保留
  const legacy = callLog.toApi(
    {
      request_model: 'deepseek-ai/DeepSeek-V4.1-Flash',
      provider_id: 'modelscope-cn',
      real_model: 'deepseek-ai/DeepSeek-V4.1-Flash',
      provider_is_paid: 0,
      is_probe: 1,
    },
    { providerIds }
  );
  assert.equal(legacy.modelName, 'deepseek-ai/DeepSeek-V4.1-Flash', '第一段不是来源 id 时不能乱切');
});

test('M4-11) All 会发布上下文长度（默认 256000、后台可改、填 0 不发布）', async () => {
  const readModels = async () =>
    (await (await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } })).json()).data;

  const initial = await readModels();
  const virtual = initial.find((m) => m.id === 'All');
  assert.equal(virtual.context_length, 256000, '默认 256000：按最窄的来源给');
  assert.equal(virtual.context_window, 256000, '两个字段名都发（不同客户端认不同的）');
  const concrete = initial.find((m) => m.id !== 'All');
  assert.equal(concrete.context_length, undefined, '具体模型暂不发布窗口（模型级配置以后再说）');

  // 改小
  const patched = await adminApi('/settings', { method: 'PATCH', body: { auto_context_tokens: 131072 } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(patched.json.auto_context_tokens, '131072');
  assert.equal((await readModels()).find((m) => m.id === 'All').context_length, 131072);

  // 单查也要一致
  const one = await (
    await fetch(`${baseUrl}/v1/models/All`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } })
  ).json();
  assert.equal(one.context_length, 131072);

  // 填 0 = 不发布该字段（客户端退回自己的默认值）
  await adminApi('/settings', { method: 'PATCH', body: { auto_context_tokens: 0 } });
  const off = (await readModels()).find((m) => m.id === 'All');
  assert.equal(off.context_length, undefined);
  assert.equal(off.context_window, undefined);

  // 还原，别影响别的用例
  await adminApi('/settings', { method: 'PATCH', body: { auto_context_tokens: 256000 } });
  assert.equal((await readModels()).find((m) => m.id === 'All').context_length, 256000);
});

test('M4-12) 概览统计：免费/付费 token 分开算、失败次数、可用模型（冷却算可用、故障不算）', async () => {
  const readStats = async () => (await adminApi('/overview')).json.stats;
  const setState = (id, status) => adminApi(`/providers/${id}/state`, { method: 'POST', body: { status } });

  await setState('free-a', 'available');
  await setState('paid-b', 'available');
  mockFree.state.mode = 'ok';
  mockPaid.state.mode = 'ok';
  const before = await readStats();

  // 一次免费成功 + 一次付费成功（假上游每次返回 prompt 5 + completion 2 = 7 tokens）
  const free = await chat({ model: 'Free/free-a/m-x', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(free.status, 200, JSON.stringify(free.json));
  const paid = await chat({ model: 'Pay/paid-b/m-x', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));

  // 再来一次失败（免费来源挂掉 → 它进冷却）
  mockFree.state.mode = 'server_error';
  const bad = await chat({ model: 'Free/free-a/m-x', messages: [{ role: 'user', content: 'ping' }] });
  assert.ok(bad.status >= 400, `这次应该失败，实际 ${bad.status}`);

  const after = await readStats();
  assert.equal(after.requestsToday - before.requestsToday, 3, '两次成功 + 一次失败');
  assert.equal(after.failuresToday - before.failuresToday, 1, '失败只算那一次');
  assert.equal(after.freeTokens.total - before.freeTokens.total, 7, '免费那次用了 7 个 token');
  assert.equal(after.paidTokens.total - before.paidTokens.total, 7, '付费那次也 7 个，但要分开计');
  assert.equal(after.freeTokens.prompt + after.freeTokens.completion, after.freeTokens.total, '输入+输出=总数');

  // 冷却中照样算可用（用户裁定：冷却的算、故障的不算）
  assert.ok(after.modelStats.cooling >= 1, '免费来源刚进冷却，要计入"冷却中"');
  assert.equal(
    after.modelStats.available + after.modelStats.erroring + after.modelStats.disabled,
    after.modelStats.total,
    '可用 + 故障 + 已禁用 = 总数，不能漏算'
  );
  const availableBefore = after.modelStats.available;

  // 手动停用 → 转「故障（需人工）」，这时才不计入可用
  await setState('free-a', 'stopped');
  const stopped = await readStats();
  assert.equal(stopped.modelStats.available, availableBefore - 1, '停用后可用数 -1');
  assert.ok(stopped.modelStats.erroring >= 1, '故障的单独计数');

  // 恢复，别影响别的用例
  await setState('free-a', 'available');
  mockFree.state.mode = 'ok';
  assert.equal((await readStats()).modelStats.available, availableBefore, '恢复后可用数回来了');
});

test('M4-13) 时区是应用自己的设置：默认 UTC 不加后缀，改了之后"今日"的零点跟着走', async () => {
  const timezone = require('../src/store/timezone');
  const DAY = 24 * 60 * 60 * 1000;
  const readStats = async () => (await adminApi('/overview')).json.stats;

  // 默认：UTC，卡片上啥也不加（用户裁定："默认 utc 啥也不加"）
  const def = await readStats();
  assert.equal(def.tzLabel, '', '默认 UTC 不显示后缀');
  assert.equal(def.dayStart % DAY, 0, 'UTC 的"今日"从 UTC 整点开始');
  assert.ok(def.dayStart <= Date.now() && Date.now() < def.dayStart + DAY, '今天要包含此刻');

  // 改成 UTC+8：后缀出现，零点平移到 UTC+8 的 00:00
  const set = await adminApi('/settings', { method: 'PATCH', body: { utc_offset_hours: 8 } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.utc_offset_hours, '8');
  const plus8 = await readStats();
  assert.equal(plus8.tzLabel, 'UTC+8');
  assert.equal((plus8.dayStart + 8 * 3600000) % DAY, 0, 'UTC+8 的零点 = UTC 时间戳 + 8h 后正好是整日界');
  assert.ok(plus8.dayStart <= Date.now() && Date.now() < plus8.dayStart + DAY, '换时区后今天照样包含此刻');

  // 半小时时区也认（5.5 = UTC+5:30），并且 **不落库成奇怪的精度**
  await adminApi('/settings', { method: 'PATCH', body: { utc_offset_hours: 5.5 } });
  assert.equal((await readStats()).tzLabel, 'UTC+5:30');
  assert.equal(timezone.getOffsetHours(), 5.5, '内存里立刻生效（不用重启）');

  // 越界会被挡（-12 ~ +14）
  for (const bad of [-13, 15, 'abc']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi('/settings', { method: 'PATCH', body: { utc_offset_hours: bad } });
    assert.equal(res.status, 400, `${bad} 应被拒`);
  }

  // rpd/tpd 的日窗口用的是同一个零点（不然"今日请求数"和"额度什么时候回来"会打架）
  const rateState = require('../src/store/rateState');
  const ts = Date.now();
  assert.equal(rateState.windowStartFor('rpd', ts), timezone.dayStart(ts), 'rpd 窗口起点 = 同一个"今日"零点');
  assert.equal(rateState.windowStartFor('rpm', ts), Math.floor(ts / 60000) * 60000, '分钟窗口不受时区影响');

  // 还原
  await adminApi('/settings', { method: 'PATCH', body: { utc_offset_hours: 0 } });
  const back = await readStats();
  assert.equal(back.tzLabel, '', '还原成默认后又没有后缀了');
  assert.equal(timezone.getOffsetHours(), 0);
});

test('M4-14) baseUrl 不接受链路本地/元数据地址（审计 M5）', async () => {
  const bad = [
    'http://169.254.169.254/latest/meta-data',
    'http://169.254.0.1/v1',
    'http://[fe80::1]/v1',
    'http://metadata.google.internal/v1',
  ];
  for (const baseUrl of bad) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi('/providers', {
      method: 'POST',
      body: { id: `bad-${Math.random().toString(36).slice(2, 8)}`, name: '坏地址', baseUrl, apiKey: 'k', rateLimits: [] },
    });
    assert.equal(res.status, 400, `${baseUrl} 应该被拒`);
    assert.match(res.json.error.message, /链路本地|元数据/);
  }

  // 内网自建推理服务仍然允许（那是合法用法，不是攻击面）
  const local = await adminApi('/providers', {
    method: 'POST',
    body: { id: 'lan-llm', name: '内网自建', baseUrl: 'http://192.168.1.50:11434/v1', apiKey: 'k', rateLimits: [] },
  });
  assert.equal(local.status, 201, '内网地址不该被一刀切禁掉');
  await adminApi('/providers/lan-llm', { method: 'DELETE' });
});

test('M4-15) 上游 302 不被跟随（审计 M5）：重定向目标一次都没被请求', async () => {
  const http = require('node:http');
  // "内网/元数据"目标：只要被请求到就记数
  const internal = { calls: 0 };
  const internalServer = http.createServer((req, res) => {
    internal.calls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ secret: 'internal-metadata' }));
  });
  await new Promise((resolve) => internalServer.listen(0, '127.0.0.1', resolve));
  const internalPort = internalServer.address().port;

  // 上游：永远 302 到那个目标
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/latest/meta-data` });
    res.end();
  });
  await new Promise((resolve) => redirector.listen(0, '127.0.0.1', resolve));
  const redirectPort = redirector.address().port;

  try {
    const created = await adminApi('/providers', {
      method: 'POST',
      body: {
        id: 'redir',
        name: '会重定向的上游',
        baseUrl: `http://127.0.0.1:${redirectPort}/v1`,
        apiKey: 'k',
        rateLimits: [],
        rejectPolicy: 'cooldown_probe',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const model = await adminApi('/providers/redir/models', { method: 'POST', body: { modelId: 'm-redir' } });
    assert.equal(model.status, 201, JSON.stringify(model.json));

    const res = await chat({ model: 'Free/redir/m-redir', messages: [{ role: 'user', content: 'ping' }] });
    assert.ok(res.status >= 400, `跟随重定向才可能成功，这里必须失败，实际 ${res.status}`);
    assert.equal(internal.calls, 0, '重定向目标（内网/元数据）一次都不能被请求');
    assert.ok(!JSON.stringify(res.json).includes('internal-metadata'), '更不能把内网响应当模型回答转出去');
  } finally {
    await adminApi('/providers/redir', { method: 'DELETE' }).catch(() => {});
    await new Promise((resolve) => redirector.close(resolve));
    await new Promise((resolve) => internalServer.close(resolve));
  }
});
