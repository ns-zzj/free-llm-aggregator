'use strict';

/**
 * M1 + M2 端到端测试：
 *  M1 流式：SSE 透传、模型名重写、首字节前换源、usage/首字节延迟采集
 *  M2 速率：漏桶配速（rpm）、计数闸门（rpd）、并发计数、429 的 Retry-After 校准、倒计时探测自动恢复
 *
 * 注意：stream-a 配了 rpm=60（每 1s 一个槽位），所以涉及"必须打到 A"的用例
 * 会先用 prepareA() 等一个槽位，避免被本地闸门挡下而误判。
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
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm1m2-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'm1m2-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-m1m2-key';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';
process.env.PROBE_TICK_MS = '1000'; // 加速探测循环

const ACCESS_KEY = process.env.ACCESS_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ------------------------------------------------------------------ 假上游

function createMockUpstream() {
  const state = {
    mode: 'ok', // ok | rate_limit | server_error | down_for_probes
    retryAfterSeconds: 4,
    probeFailsByModel: {}, // 每个模型各自的"探测还失败几次"（状态是模型级的，计数也得按模型）
    failModels: [], // 指定模型单独失败（用来验证"同家不同模型互相独立"）
    calls: [],
    streams: 0,
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      const isProbe = body.max_tokens === 1;
      state.calls.push({ isProbe, stream: body.stream === true, body });

      // 指定模型单独限流（模拟"这个模型额度用完了、同家另一个还正常"）
      if (state.failModels.includes(body.model)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
        res.end(JSON.stringify({ error: { message: 'quota exceeded for this model', type: 'insufficient_quota' } }));
        return;
      }

      // 探测专用：指定模型前 N 次探测失败，之后恢复（模拟"额度没刷新就一直探测"）
      if (state.mode === 'down_for_probes') {
        const remaining = state.probeFailsByModel[body.model] || 0;
        if (isProbe && remaining > 0) {
          state.probeFailsByModel[body.model] = remaining - 1;
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
          res.end(JSON.stringify({ error: { message: 'quota exceeded for today', type: 'insufficient_quota' } }));
          return;
        }
        if (!isProbe) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
          res.end(JSON.stringify({ error: { message: 'quota exceeded for today', type: 'insufficient_quota' } }));
          return;
        }
      }

      if (state.mode === 'rate_limit') {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(state.retryAfterSeconds) });
        res.end(JSON.stringify({ error: { message: 'Rate limit reached', type: 'rate_limit_error' } }));
        return;
      }
      if (state.mode === 'server_error') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream boom' } }));
        return;
      }
      // 模型名写错（真实情况：ModelScope 返回 400 Invalid model id）——
      // 这类错探测一万次也不会好，属于配置问题
      if (state.mode === 'bad_model') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `Invalid model id: ${body.model}` } }));
        return;
      }

      if (body.stream === true) {
        state.streams += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const base = {
          id: 'chatcmpl-mock-stream',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: 'upstream-internal-name',
        };
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
        await sleep(10);
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }] })}\n\n`);
        await sleep(10);
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          })}\n\n`
        );
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'chatcmpl-mock',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: 'upstream-internal-name',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
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

let mockA;
let mockB;
let appServer;
let baseUrl;
let cookie = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function realCalls(mock) {
  return mock.state.calls.filter((c) => !c.isProbe).length;
}

async function adminApi(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${baseUrl}/api/admin${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

async function chat(body, { stream = false } = {}) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ ...body, stream }),
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers, json: stream ? null : safeJson(text) };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

/** 让 A 恢复可用并等出一个速率槽位（rpm=60 → 每 1s 一个） */
async function prepareA() {
  await adminApi('/providers/stream-a/state', { method: 'POST', body: { status: 'available' } });
  await sleep(1200);
}

async function providerSnapshot(providerId) {
  const overview = await adminApi('/overview');
  return overview.json.providers.find((p) => p.id === providerId);
}

async function waitForProvider(providerId, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await providerSnapshot(providerId);
    if (last && predicate(last)) return last;
    await sleep(300);
  }
  throw new Error(`等待状态超时：${JSON.stringify(last && last.state)}`);
}

test.before(async () => {
  mockA = await createMockUpstream();
  mockB = await createMockUpstream();
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

  // 探测循环在测试环境里每秒醒一次（PROBE_TICK_MS=1000），无需再设全局间隔
  await adminApi('/settings', { method: 'PATCH', body: { fake_endpoints_enabled: true } });
  // 退避表调快：默认是 [15, 60, 300]，跑探测相关的用例要等好几分钟；
  // 表本身的值由 M2-10 单测 + M2-11 端到端覆盖，这里只求"探得动"。
  await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [1, 1, 2] } });

  const create = async (id, name, upstreamBaseUrl, extra = {}) => {
    const res = await adminApi('/providers', {
      method: 'POST',
      body: {
        id,
        name,
        baseUrl: upstreamBaseUrl,
        apiKey: `key-${id}`,
        cooldownSeconds: 5,
        rejectPolicy: 'cooldown_probe',
        ...extra,
      },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  };

  await create('stream-a', '流式 A（限速 60rpm）', mockA.baseUrl, { rateLimits: [{ kind: 'rpm', value: 60 }] });
  await create('stream-b', '流式 B（不限速）', mockB.baseUrl, { rateLimits: [] });
  await create('daily', '每日额度源（rpd=2）', mockA.baseUrl, { rateLimits: [{ kind: 'rpd', value: 2 }] });
  // 探测专用来源：没有任何速率限制，避免被本地闸门干扰
  await create('probe-a', '探测专用源', mockA.baseUrl, { rateLimits: [] });
  // 一个来源下挂两个模型（验证"同家不同模型状态互相独立"）
  await create('multi', '一家两模型', mockA.baseUrl, { rateLimits: [] });

  for (const [providerId, modelId] of [
    ['stream-a', 'm-stream'],
    ['stream-b', 'm-stream'],
    ['daily', 'm-daily'],
    ['probe-a', 'm-probe'],
    ['multi', 'm-bad'],
    ['multi', 'm-good'],
  ]) {
    const res = await adminApi(`/providers/${providerId}/models`, { method: 'POST', body: { modelId } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
});

test.after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  const { db } = require('../src/db');
  await db.destroy();
  for (const mock of [mockA, mockB]) {
    if (mock) await new Promise((resolve) => mock.server.close(resolve));
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ M1 流式

test('M1-1) 流式：SSE 透传 + 指定来源时模型名直通 + 采集 usage 与首字节延迟', async () => {
  const res = await chat({ model: 'Free/stream-a/m-stream', messages: [{ role: 'user', content: 'ping' }] }, { stream: true });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
  assert.match(res.text, /"content":"pong"/);
  assert.match(res.text, /data: \[DONE\]/);
  assert.ok(
    res.text.includes('"model":"upstream-internal-name"'),
    '指定来源时不改写：上游写啥就是啥（下游要的就是这家，没必要换成我们的名字）'
  );

  await sleep(200);
  const logs = await adminApi('/logs?limit=3');
  const entry = logs.json.find((l) => l.isStream && l.status !== 'fail');
  assert.ok(entry, '应记录流式调用');
  assert.equal(entry.promptTokens, 5);
  assert.equal(entry.completionTokens, 2);
  assert.ok(entry.ttfbMs !== null, '应记录首字节延迟');
});

test('M1-2) 流式：All 首字节前上游 500 → 静默换源，客户端仍拿到完整流', async () => {
  await prepareA();
  mockA.state.mode = 'server_error';
  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] }, { stream: true });
  assert.equal(res.status, 200, '首字节前应能换源');
  assert.match(res.text, /"content":"pong"/);
  assert.ok(mockB.state.streams > 0, '应由 B 完成本次流式');
  assert.ok(
    res.text.includes('"model":"All"') && !res.text.includes('upstream-internal-name'),
    'All 请求：chunk 里的 model 保持客户端请求的名字（不然客户端把这个真实模型名回填下次请求就 404）'
  );

  await sleep(200);
  const logs = await adminApi('/logs?limit=4');
  assert.equal(logs.json[0].status, 'fallback');
  const failed = logs.json.find((l) => l.providerId === 'stream-a' && l.status === 'fail');
  assert.equal(failed.errorType, 'server');

  mockA.state.mode = 'ok';
});

// ------------------------------------------------------------------ M2 速率

test('M2-1) 漏桶配速：rpm=60 时第二次立即请求绕开该源，约 1 秒后重新优先使用它', async () => {
  mockA.state.mode = 'ok';
  await prepareA();
  const a0 = realCalls(mockA);
  const b0 = realCalls(mockB);

  const first = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(first.status, 200);
  assert.equal(realCalls(mockA), a0 + 1, '第一次应走 A');

  const second = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(second.status, 200);
  assert.equal(realCalls(mockA), a0 + 1, '第二次不该立刻再打到 A（本地闸门挡住）');
  assert.equal(realCalls(mockB), b0 + 1, '第二次应改走 B');

  const snapshot = await providerSnapshot('stream-a');
  assert.ok(snapshot.rate[0].nextSlotInSeconds >= 0, '应展示下个可用时刻');

  await sleep(1200);
  const third = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(third.status, 200);
  assert.equal(realCalls(mockA), a0 + 2, '槽位恢复后应重新优先使用 A');
});

test('M2-2) 计数闸门：rpd=2 用满后报 429（含建议重试时间），并记录已用次数', async () => {
  const first = await chat({ model: 'Free/daily/m-daily', messages: [{ role: 'user', content: 'ping' }] });
  const second = await chat({ model: 'Free/daily/m-daily', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);

  const third = await chat({ model: 'Free/daily/m-daily', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(third.status, 429, JSON.stringify(third.json));
  assert.equal(third.json.error.code, 'rate_limited');
  assert.ok(third.headers.get('retry-after'), '应给出建议重试时间');

  const daily = await providerSnapshot('daily');
  assert.equal(daily.rate[0].used, 2, '应记录已用 2 次');
});

test('M2-3) All：429 + Retry-After → 来源进冷却，且下一次可用时刻被推到 Retry-After 之后', async () => {
  await prepareA();
  mockA.state.mode = 'rate_limit';
  mockA.state.retryAfterSeconds = 4;

  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, '应静默换源到 B');

  const provider = await providerSnapshot('stream-a');
  assert.equal(provider.state.status, 'cooldown');
  assert.ok(provider.state.cooldownRemainingSeconds >= 4, '冷却不应短于 Retry-After');
  assert.ok(provider.rate[0].nextSlotInSeconds >= 3, `下个可用时刻应被推到 Retry-After 之后（实际 ${provider.rate[0].nextSlotInSeconds}s）`);

  const logs = await adminApi('/logs?limit=4');
  const failLog = logs.json.find((l) => l.providerId === 'stream-a' && l.status === 'fail');
  assert.equal(failLog.errorType, 'rate_limit');

  mockA.state.mode = 'ok';
});

test('M2-4) 倒计时探测：额度没刷新就一直探测，刷新后自动恢复可用', async () => {
  await adminApi('/providers/probe-a/state', { method: 'POST', body: { status: 'available' } });
  mockA.state.mode = 'down_for_probes';
  mockA.state.probeFailsByModel = { 'm-probe': 2 };

  const res = await chat({ model: 'Free/probe-a/m-probe', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 429, '指定来源时不换源，上游错误原样转发');

  const cooling = await waitForProvider('probe-a', (p) => p.state.status === 'cooldown', 10000);
  assert.ok(cooling.state.nextProbeAt, '应安排下一次探测');

  const recovered = await waitForProvider('probe-a', (p) => p.state.status === 'available', 40000);
  assert.equal(recovered.state.status, 'available', '额度刷新后应被探测恢复');

  const logs = await adminApi('/logs?limit=30');
  const probes = logs.json.filter((l) => l.isProbe && l.providerId === 'probe-a');
  const summary = logs.json
    .slice(0, 8)
    .map((l) => `${l.providerId}/${l.status}${l.isProbe ? '(探测)' : ''}:${String(l.detail || '').slice(0, 30)}`)
    .join(' | ');
  assert.ok(probes.some((p) => p.status === 'fail'), `应有探测失败记录；最近日志：${summary}`);
  assert.ok(probes.some((p) => p.status === 'ok'), '应有探测成功记录');

  mockA.state.mode = 'ok';
});

test('M2-5) 并发计数：占用后第二次被拒，release 后可再次放行', async () => {
  const rateState = require('../src/store/rateState');
  const limits = [{ kind: 'concurrency', value: 1 }];

  const first = await rateState.admit({ providerId: 'stream-b', modelKey: '', limits });
  assert.equal(first.allowed, true);
  const second = await rateState.admit({ providerId: 'stream-b', modelKey: '', limits });
  assert.equal(second.allowed, false);
  assert.match(second.reason, /并发已满/);
  first.release();
  const third = await rateState.admit({ providerId: 'stream-b', modelKey: '', limits });
  assert.equal(third.allowed, true);
  third.release();
});

test('M2-7) 同一个来源下：一个模型额度用完，另一个模型照常使用', async () => {
  mockA.state.mode = 'ok';
  mockA.state.failModels = ['m-bad'];
  await adminApi('/providers/multi/state', { method: 'POST', body: { status: 'available' } });

  // m-bad 挂了 → 只有它被冷却（指定来源，所以上游 429 直接转发）
  const bad = await chat({ model: 'Free/multi/m-bad', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(bad.status, 429, '指定来源且该模型挂了 → 转发上游错误');

  const overview = await adminApi('/overview');
  const multi = overview.json.providers.find((p) => p.id === 'multi');
  const badState = overview.json.models.find((m) => m.providerId === 'multi' && m.modelId === 'm-bad').state;
  const goodState = overview.json.models.find((m) => m.providerId === 'multi' && m.modelId === 'm-good').state;
  assert.equal(badState.status, 'cooldown', '出问题的那个模型应冷却');
  assert.equal(goodState.status, 'available', '同家的另一个模型不该被牵连');
  assert.equal(multi.state.modelsAvailable, 1, '聚合结果：1/2 个模型可用');
  assert.equal(multi.state.status, 'available', '有一个模型能用，来源就算可用');

  // 另一个模型照常服务
  const good = await chat({ model: 'Free/multi/m-good', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(good.status, 200, '同家另一个模型应正常返回');
  assert.equal(good.json.choices[0].message.content, 'pong');

  mockA.state.failModels = [];
  await adminApi('/providers/multi/state', { method: 'POST', body: { status: 'available' } });
});

test('M2-8) 后台「测试」按真实调用处理：占速率额度 + 写调用日志', async () => {
  // stream-a 的 rpm=60 → 每 1 秒一个槽位；先等一个空槽再测
  await adminApi('/providers/stream-a/state', { method: 'POST', body: { status: 'available' } });
  await sleep(1200);

  const before = mockA.state.calls.length;
  const result = await adminApi('/providers/stream-a/test', { method: 'POST', body: { modelId: 'm-stream' } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.ok, true, JSON.stringify(result.json));
  assert.ok(mockA.state.calls.length > before, '测试确实发到了上游');

  // 1) 占用了速率窗口 → 该模型此刻应显示"限速中"并带倒计时
  const models = await adminApi('/models');
  const entry = models.json.find((m) => m.providerId === 'stream-a' && m.modelId === 'm-stream');
  assert.equal(entry.runtimeStatus, 'rate_limited', `测试应消耗速率额度（实际 ${entry.runtimeStatus}）`);
  assert.ok(entry.rateEtaSeconds >= 1, `应有倒计时秒数（实际 ${entry.rateEtaSeconds}）`);

  // 2) 写进了调用日志（不是"探测"标记，算正常调用）
  const logs = await adminApi('/logs?limit=5');
  const latest = logs.json[0];
  assert.equal(latest.providerId, 'stream-a');
  assert.equal(latest.isProbe, false, '测试算正常调用而不是探测');
  assert.match(latest.detail, /手动测试/);
});

test('M2-9) 连续探测达到上限后停止探测、转为「故障（需人工）」', async () => {
  // 上限设成 2：m-bad 一直失败 → 探两次后就该放弃
  await adminApi('/settings', { method: 'PATCH', body: { probe_max_attempts: 2 } });
  mockA.state.mode = 'ok';
  mockA.state.failModels = ['m-bad'];
  await adminApi('/providers/multi/state', { method: 'POST', body: { status: 'available' } });

  const bad = await chat({ model: 'Free/multi/m-bad', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(bad.status, 429);

  const stopState = await (async () => {
    const deadline = Date.now() + 30000;
    let last = null;
    while (Date.now() < deadline) {
      const overview = await adminApi('/overview');
      last = overview.json.models.find((m) => m.providerId === 'multi' && m.modelId === 'm-bad').state;
      if (last.status === 'stopped') return last;
      // eslint-disable-next-line no-await-in-loop
      await sleep(400);
    }
    return last;
  })();

  assert.equal(stopState.status, 'stopped', `连续探测超限后应转为需人工（实际 ${JSON.stringify(stopState)}）`);
  assert.match(stopState.reason, /连续探测/, '原因里应说明是连续探测超限');
  assert.ok(stopState.probeAttempts >= 2, `应记录探测次数（实际 ${stopState.probeAttempts}）`);

  // 转"需人工"之后不会再被自动探测：等一会儿，探测次数不该再涨
  const attemptsAfterStop = stopState.probeAttempts;
  await sleep(3000);
  const overview = await adminApi('/overview');
  const still = overview.json.models.find((m) => m.providerId === 'multi' && m.modelId === 'm-bad').state;
  assert.equal(still.probeAttempts, attemptsAfterStop, '停止后不应再探测');
  assert.equal(still.status, 'stopped');

  mockA.state.failModels = [];
  await adminApi('/settings', { method: 'PATCH', body: { probe_max_attempts: 10 } });
  await adminApi('/providers/multi/state', { method: 'POST', body: { status: 'available' } });
});

test('M2-10) 退避表：第 N 次探测前等多久，最后一段带"后续"含义；后台可改、乱填会被挡', async () => {
  const probeSchedule = require('../src/store/probeSchedule');
  assert.equal(probeSchedule.waitSecondsFor([15, 60, 300], 0), 15, '第 1 次探测前等 15 秒（还没失败过）');
  assert.equal(probeSchedule.waitSecondsFor([15, 60, 300], 1), 60, '失败过 1 次 → 第 2 次之前等 60 秒');
  assert.equal(probeSchedule.waitSecondsFor([15, 60, 300], 2), 300, '失败过 2 次 → 第 3 次之前等 300 秒');
  assert.equal(probeSchedule.waitSecondsFor([15, 60, 300], 3), 300, '超出表长 → 一直用最后一段（"+后续"）');
  assert.equal(probeSchedule.waitSecondsFor([15, 60, 300], 99), 300);
  assert.deepEqual(probeSchedule.parse('这不是 JSON'), [15, 60, 300], '认不出来就用默认表');
  assert.deepEqual(probeSchedule.parse([0, -1, '30', '60']), [30, 60], '只留大于 0 的整秒，字符串也认');

  // 后台能改，改完立刻生效
  const patched = await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [2, 5, 9] } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(patched.json.probe_backoff_seconds, '[2,5,9]');
  assert.deepEqual(await probeSchedule.get(), [2, 5, 9], '读出来的就是刚存的');

  // 乱填要挡掉（空表 / 0 / 负数）
  const empty = await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [] } });
  assert.equal(empty.status, 400);
  const negative = await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [1, -3] } });
  assert.equal(negative.status, 400);
  const zero = await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [0] } });
  assert.equal(zero.status, 400);

  await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [1, 1, 2] } });
});

test('M2-11) 退避真的生效：失败后先等第 1 段，探测再失败就换成第 2 段', async () => {
  // 用能观测到的短值：2 秒 → 5 秒 → 9 秒
  await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [2, 5, 9] } });
  await adminApi('/providers/probe-a/state', { method: 'POST', body: { status: 'available' } });
  // 用 500（不带 Retry-After）来测纯退避；带 Retry-After 的 429 在 M2-3 里验（两者取大的那个）
  mockA.state.mode = 'server_error';

  await chat({ model: 'Free/probe-a/m-probe', messages: [{ role: 'user', content: 'ping' }] });
  const first = await providerSnapshot('probe-a');
  assert.equal(first.state.status, 'cooldown');
  assert.ok(
    first.state.cooldownRemainingSeconds > 0 && first.state.cooldownRemainingSeconds <= 2,
    `第一次失败应等第 1 段（≤2s），实际 ${first.state.cooldownRemainingSeconds}s`
  );

  // 到期探测一次（失败）→ 下一段应该变成第 2 段（5 秒级）
  const second = await waitForProvider('probe-a', (p) => p.state.cooldownRemainingSeconds > 2, 10000);
  assert.ok(
    second.state.cooldownRemainingSeconds <= 5,
    `探测再失败后应换成第 2 段（≤5s），实际 ${second.state.cooldownRemainingSeconds}s`
  );
  // 连续失败次数是模型级的，从 /models 读
  const models = await adminApi('/models');
  const entry = models.json.find((m) => m.providerId === 'probe-a' && m.modelId === 'm-probe');
  assert.ok(entry.state.probeAttempts >= 1, `应记录了这次探测失败（实际 ${entry.state.probeAttempts}）`);

  // 收尾：恢复正常，别影响后面的用例
  mockA.state.mode = 'ok';
  await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [1, 1, 2] } });
  await adminApi('/providers/probe-a/state', { method: 'POST', body: { status: 'available' } });
});

test('M2-12) 模型名配错（上游 400 Invalid model id）→ 直接转「需人工」，不进冷却、不反复探测', async () => {
  mockA.state.mode = 'bad_model';
  await adminApi('/providers/probe-a/state', { method: 'POST', body: { status: 'available' } });

  const result = await adminApi('/providers/probe-a/test', { method: 'POST', body: { modelId: 'm-probe' } });
  assert.equal(result.status, 200, JSON.stringify(result.json));
  assert.equal(result.json.ok, false);
  assert.equal(result.json.errorType, 'request', '上游 400 → 请求类错误');
  assert.equal(result.json.state.status, 'stopped', '这类错探测也不会好 → 应转「需人工」而不是冷却');
  assert.match(result.json.state.reason, /需人工/);
  assert.match(result.json.state.reason, /Invalid model id/, '原因里要带上游原文，方便排查');
  assert.equal(result.json.state.cooldownRemainingSeconds, 0, '不该排下一次探测');

  // 转「需人工」后不会再被自动探测
  await sleep(2000);
  const overview = await adminApi('/overview');
  const entry = overview.json.models.find((m) => m.providerId === 'probe-a' && m.modelId === 'm-probe');
  assert.equal(entry.runtimeStatus, 'error');
  assert.equal(entry.state.status, 'stopped', '还在需人工，没被探测改回去');
  const logs = await adminApi('/logs?limit=10');
  assert.ok(
    !logs.json.some((l) => l.isProbe && l.providerId === 'probe-a' && l.status === 'fail' && /Invalid model id/.test(String(l.detail))),
    '不该对着它反复探测'
  );

  mockA.state.mode = 'ok';
  await adminApi('/providers/probe-a/state', { method: 'POST', body: { status: 'available' } });
});

test('M2-13) 冷却期间点「测试」：等待时长跳到下一段，而不是打回第一段', async () => {
  await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [3, 30, 300] } });
  await adminApi('/providers/probe-a/state', { method: 'POST', body: { status: 'available' } });
  mockA.state.mode = 'server_error';

  // 一发请求失败 → 落在第 1 段（3 秒）
  await chat({ model: 'Free/probe-a/m-probe', messages: [{ role: 'user', content: 'ping' }] });
  const first = await providerSnapshot('probe-a');
  assert.equal(first.state.status, 'cooldown');
  assert.ok(
    first.state.cooldownRemainingSeconds > 0 && first.state.cooldownRemainingSeconds <= 3,
    `应落在第 1 段（≤3s），实际 ${first.state.cooldownRemainingSeconds}s`
  );

  // 在这个窗口里点「测试」→ 应该前进到第 2 段（30 秒），而不是回到 3 秒
  const second = await adminApi('/providers/probe-a/test', { method: 'POST', body: { modelId: 'm-probe' } });
  assert.equal(second.json.ok, false);
  assert.equal(second.json.state.status, 'cooldown');
  assert.ok(
    second.json.state.cooldownRemainingSeconds > 3 && second.json.state.cooldownRemainingSeconds <= 30,
    `测试后应跳到第 2 段（3s < x ≤ 30s），实际 ${second.json.state.cooldownRemainingSeconds}s`
  );

  // 再点一次 → 第 3 段（300 秒）
  const third = await adminApi('/providers/probe-a/test', { method: 'POST', body: { modelId: 'm-probe' } });
  assert.ok(
    third.json.state.cooldownRemainingSeconds > 30,
    `再测试一次应进入第 3 段（>30s），实际 ${third.json.state.cooldownRemainingSeconds}s`
  );

  // 已经是最后一段了 → 原地重新计时（还是 300s 档，不回第 1 段）
  const fourth = await adminApi('/providers/probe-a/test', { method: 'POST', body: { modelId: 'm-probe' } });
  assert.ok(
    fourth.json.state.cooldownRemainingSeconds > 30,
    `最后一段再测试应原地重计（>30s），实际 ${fourth.json.state.cooldownRemainingSeconds}s`
  );

  // 收尾
  mockA.state.mode = 'ok';
  await adminApi('/settings', { method: 'PATCH', body: { probe_backoff_seconds: [1, 1, 2] } });
  await adminApi('/providers/probe-a/state', { method: 'POST', body: { status: 'available' } });
});

test('M2-6) 速率填 0 = 不做本地限制（永远放行）', async () => {
  const created = await adminApi('/providers', {
    method: 'POST',
    body: {
      id: 'zero-rate',
      name: '不限制来源',
      baseUrl: mockB.baseUrl,
      apiKey: 'key-zero',
      rateLimits: [{ kind: 'rpm', value: 0 }],
      rejectPolicy: 'cooldown_probe',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  await adminApi('/providers/zero-rate/models', { method: 'POST', body: { modelId: 'm-zero' } });

  const rateState = require('../src/store/rateState');
  const provider = { id: 'zero-rate', rateLimits: [{ kind: 'rpm', value: 0 }] };
  const { limits, modelKey } = rateState.effectiveLimits(provider, null);
  const peek = await rateState.peek({ providerId: 'zero-rate', modelKey, limits });
  assert.equal(peek.allowed, true, 'value=0 不应被本地闸门拦');

  const res = await chat({ model: 'Free/zero-rate/m-zero', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200);
});
