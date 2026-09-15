'use strict';

/**
 * M0 端到端测试：假上游 + 真服务
 * 覆盖：口令鉴权、apiKey 加密入库、/openai/models、非流式对话、失败自动换源、来源冷却、假数据端点
 */

const test = require('node:test');
// 「失败锁定」是按来源 IP 记的（连续 5 次失败锁 5 分钟），而本文件里有好几个用例会连着打
// 一堆故意出错的请求 —— 每个用例都从"没被限速过"的状态开始，免得用例之间互相背锅。
// （测锁定本身的那几条在 test/m6.test.js，它们故意不复位。）
test.beforeEach(() => require('../src/app').v1FailureGuard.reset());
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---- 测试环境变量（必须在加载项目模块之前设置） ----
// 临时数据放在工作区内（.tmp/），避免写系统临时目录
const tmpRoot = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm0-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'unit-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-unit-test-key';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';

const ACCESS_KEY = process.env.ACCESS_KEY;
const UPSTREAM_PLAINTEXT = 'upstream-plain-secret-should-never-be-stored';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// ------------------------------------------------------------------ 假上游

function createMockUpstream() {
  const state = { mode: 'ok', calls: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const parsed = raw ? JSON.parse(raw) : null;
      state.calls.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: parsed });
      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        if (state.mode === 'rate_limit') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests', type: 'rate_limit_error' } }));
          return;
        }
        if (state.mode === 'server_error') {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream overloaded' } }));
          return;
        }
        if (state.mode === 'bad_request') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'content_filter: request rejected' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'chatcmpl-mock',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: parsed && parsed.model,
            choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          })
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    });
  });
}

// ------------------------------------------------------------------ 测试脚手架

let mockA;
let mockB;
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

async function chat(body, { key = ACCESS_KEY } = {}) {
  const res = await fetch(`${baseUrl}/openai/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

function readDbBytes() {
  const files = [process.env.DB_PATH, `${process.env.DB_PATH}-wal`];
  return files
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file).toString('latin1'))
    .join('\n');
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
  assert.equal(login.status, 200, '管理口令登录应成功');
  const cookies = typeof login.headers.getSetCookie === 'function'
    ? login.headers.getSetCookie()
    : [login.headers.get('set-cookie')];
  cookie = cookies.map((c) => String(c).split(';')[0]).join('; ');
  assert.ok(cookie.includes('agg_session'), '应拿到 session cookie');
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

// ------------------------------------------------------------------ 用例

test('1) 未带访问口令访问 /openai/models → 401', async () => {
  const res = await fetch(`${baseUrl}/openai/models`);
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.match(json.error.message, /口令/);
});

test('2) 错误口令 → 401', async () => {
  const res = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: 'Bearer wrong-key' } });
  assert.equal(res.status, 401);
});

test('3) 创建两个提供商（含 apiKey）与模型', async () => {
  // 注意：这里刻意不配速率限制（rateLimits），避免本地闸门干扰"换源"用例；
  // 速率准入的行为由 test/m1m2.test.js 覆盖。
  const created = await adminApi('/providers', {
    method: 'POST',
    body: {
      id: 'mock-a',
      name: '假上游 A',
      baseUrl: mockA.baseUrl,
      apiKey: UPSTREAM_PLAINTEXT,
      rejectPolicy: 'cooldown_probe',
      cooldownSeconds: 300,
      rateLimits: [],
      notes: '测试用',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.hasApiKey, true);
  assert.equal(created.json.apiKey, undefined, '接口不应回显明文 key');

  const second = await adminApi('/providers', {
    method: 'POST',
    body: {
      id: 'mock-b',
      name: '假上游 B',
      baseUrl: mockB.baseUrl,
      apiKey: 'second-upstream-key',
      rejectPolicy: 'cooldown_probe',
    },
  });
  assert.equal(second.status, 201, JSON.stringify(second.json));

  for (const providerId of ['mock-a', 'mock-b']) {
    const model = await adminApi(`/providers/${providerId}/models`, {
      method: 'POST',
      body: { modelId: 'mock-1' },
    });
    assert.equal(model.status, 201, JSON.stringify(model.json));
  }
});

test('4) apiKey 加密入库：库里读不到明文', async () => {
  const { db } = require('../src/db');
  const row = await db('providers').where({ id: 'mock-a' }).first();
  assert.ok(row.api_key_enc.startsWith('v1:'), '密文应带版本前缀');
  assert.ok(!row.api_key_enc.includes(UPSTREAM_PLAINTEXT), '密文里不应含明文');
  const bytes = readDbBytes();
  assert.ok(!bytes.includes(UPSTREAM_PLAINTEXT), '数据库文件中不应出现明文 apiKey');
  const keyRow = await db('access_keys').first();
  // 用户裁定 2026-09-12：下游口令**只留能还原的那一份**（不可还原的哈希已经删掉了）
  const keyCols = (await db.raw('PRAGMA table_info(access_keys)')).map((c) => c.name);
  assert.ok(!keyCols.includes('key_hash'), 'access_keys 不该再有 key_hash（不可还原的那份）');
  assert.ok(keyRow.key_enc.startsWith('v1:'), '只留加密密文：校验和后台显示都走它');
  assert.ok(!keyRow.key_enc.includes(ACCESS_KEY), '密文里不应含明文');
  assert.ok(!bytes.includes(ACCESS_KEY), '数据库文件中不应出现明文访问口令');
});

test('4b) 「密码」页用的一条口令：能取回明文/掩码，更换后旧口令立即失效', async () => {
  // 当前这条（bootstrap 建的）应该能取回明文 —— 后台要拿它做「复制」
  const primary = await adminApi('/access-keys/primary');
  assert.equal(primary.status, 200, JSON.stringify(primary.json));
  assert.equal(primary.json.key, ACCESS_KEY, '能从密文里解回明文');
  assert.equal(primary.json.masked, `sk-${'*'.repeat(ACCESS_KEY.length - 3)}`, '掩码保留 sk- 前缀');
  assert.equal(primary.json.hasPlaintext, true);

  // 换一条：用户只输入 sk- 后面那段，后端自动补前缀
  const changed = await adminApi('/access-keys/change', { method: 'POST', body: { key: 'my-new-key-123456' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.equal(changed.json.plaintext, 'sk-my-new-key-123456', 'sk- 前缀自动补上');
  assert.equal(changed.json.masked, `sk-${'*'.repeat('my-new-key-123456'.length)}`);

  const old = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
  assert.equal(old.status, 401, '旧口令应立即失效');
  const fresh = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: 'Bearer sk-my-new-key-123456' } });
  assert.equal(fresh.status, 200, '新口令可用');

  // 库里仍然没有明文
  assert.ok(!readDbBytes().includes('sk-my-new-key-123456'), '换了之后数据库文件里还是不该有明文');

  // 老数据（没有密文：0010 之前只存过哈希，或 APP_SECRET 换过）不能假装能显示，
  // 也不能通过校验 —— 那种行等于失效，后台会提示换一条
  const { db } = require('../src/db');
  await db('access_keys').update({ key_enc: null });
  const legacy = await adminApi('/access-keys/primary');
  assert.equal(legacy.json.key, null, '没有密文的行取不回明文');
  assert.equal(legacy.json.masked, '');
  assert.equal(legacy.json.hasPlaintext, false);
  const legacyAuth = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: 'Bearer sk-my-new-key-123456' } });
  assert.equal(legacyAuth.status, 401, '没有密文就校验不过（旧口令在这条数据上已经失效）');
  const { countUnusable } = require('../src/store/accessKeys');
  assert.equal(await countUnusable(), 1, '启动时会据此提示"有 N 条口令无法还原"');

  // 换回原来的口令，别影响后面的用例
  const back = await adminApi('/access-keys/change', { method: 'POST', body: { key: ACCESS_KEY } });
  assert.equal(back.json.plaintext, ACCESS_KEY);
  const restored = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
  assert.equal(restored.status, 200);
});

test('5) GET /openai/models 输出去重后的模型（All + 带类别前缀的模型名）', async () => {
  const res = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
  assert.equal(res.status, 200);
  const json = await res.json();
  const ids = json.data.map((m) => m.id);
  assert.deepEqual(ids, ['All', 'Free/mock-a/mock-1', 'Free/mock-b/mock-1'], '模型名必须带类别前缀，All 排第一');
});

test('6) 对话成功：指定来源，上游收到真实模型名与上游 key', async () => {
  const res = await chat({ model: 'Free/mock-a/mock-1', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].message.content, 'pong');
  assert.equal(res.json.model, 'mock-1', '指定来源时"上游写啥就是啥"，不做改写');
  assert.equal(res.json.object, 'chat.completion');
  assert.equal(res.json.usage.prompt_tokens, 5, '上游返回的其它字段原样保留');

  const lastCall = mockA.state.calls.at(-1);
  assert.equal(lastCall.auth, `Bearer ${UPSTREAM_PLAINTEXT}`, '上游应收到解密后的 key');
  assert.equal(lastCall.body.model, 'mock-1', '发给上游的应是真实模型名（不带来源）');
  assert.equal(lastCall.body.stream, undefined, '非流式不传 stream');

  const logs = await adminApi('/logs?limit=3');
  assert.equal(logs.json[0].status, 'ok');
  assert.equal(logs.json[0].providerId, 'mock-a');
});

test('7) All：上游 429 → 客户端无感换源到第二个来源', async () => {
  mockA.state.mode = 'rate_limit';
  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, '应静默换源成功，而不是把 429 抛给客户端');
  assert.equal(res.json.choices[0].message.content, 'pong');
  assert.equal(mockB.state.calls.at(-1).body.model, 'mock-1', '第二次应打到 B');

  const logs = await adminApi('/logs?limit=3');
  assert.equal(logs.json[0].status, 'fallback');
  assert.equal(logs.json[0].providerId, 'mock-b');
  assert.equal(logs.json[1].status, 'fail');
  assert.equal(logs.json[1].errorType, 'rate_limit');

  const overview = await adminApi('/overview');
  const stateA = overview.json.providers.find((p) => p.id === 'mock-a').state;
  assert.equal(stateA.status, 'cooldown', 'A 应进入冷却');
  assert.ok(stateA.cooldownRemainingSeconds > 0 && stateA.cooldownRemainingSeconds <= 300);
});

test('8) All：全部来源都失败 → 统一 503（不含上游细节）', async () => {
  mockB.state.mode = 'rate_limit';
  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 503, JSON.stringify(res.json));
  // A 已在冷却（未参与本次尝试），B 参与但失败 → all_sources_failed
  assert.equal(res.json.error.code, 'all_sources_failed');
  const body = JSON.stringify(res.json);
  assert.ok(!body.includes('Rate limit reached'), '不应把上游错误原文透给客户端');
  assert.ok(!body.includes('mock-a') && !body.includes('mock-b'), '不应暴露上游标识');
  assert.ok(res.headers.get('retry-after'), '应给出建议重试时间');
});

test('9) 手动恢复来源后重新可用', async () => {
  mockA.state.mode = 'ok';
  mockB.state.mode = 'ok';
  const recoverA = await adminApi('/providers/mock-a/state', { method: 'POST', body: { status: 'available' } });
  const recoverB = await adminApi('/providers/mock-b/state', { method: 'POST', body: { status: 'available' } });
  // 状态是模型级的：手动恢复会作用到该提供商下的所有模型
  assert.equal(recoverA.json.ok, true);
  assert.ok(recoverA.json.states.every((s) => s.status === 'available'), JSON.stringify(recoverA.json.states));
  assert.ok(recoverB.json.states.every((s) => s.status === 'available'), JSON.stringify(recoverB.json.states));

  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200);
  assert.equal(mockA.state.calls.at(-1).body.model, 'mock-1', '恢复后应优先用排序靠前的 A');
});

test('10) 请求本身被上游拒绝（内容过滤）→ 直接返回客户端，不换源不停用', async () => {
  mockA.state.mode = 'bad_request';
  const callsBefore = mockB.state.calls.length;
  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 400);
  assert.match(res.json.error.message, /content_filter/);
  assert.equal(mockB.state.calls.length, callsBefore, '400 类错误不应该尝试下一个来源');

  const overview = await adminApi('/overview');
  const stateA = overview.json.providers.find((p) => p.id === 'mock-a').state;
  assert.equal(stateA.status, 'available', '请求类错误不应把来源停用');
  mockA.state.mode = 'ok';
});

test('11) 未知模型 → 404；名字写不全 → 404；假数据端点正常；未实现端点 404', async () => {
  const unknown = await chat({ model: 'no-such-model', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'model_not_found');

  const noSource = await chat({ model: 'mock-1', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(noSource.status, 404, '裸模型名必须报错');
  assert.match(noSource.json.error.message, /要写全/);

  const badProvider = await chat({ model: 'nope/mock-1', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(badProvider.status, 404);
  assert.match(badProvider.json.error.message, /不存在/);

  // 漏了类别前缀：直接告诉他准确写法（比"模型不存在"有用）
  const noPrefix = await chat({ model: 'mock-a/nope', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(noPrefix.status, 404);
  assert.match(noPrefix.json.error.message, /要带上类别/);
  assert.match(noPrefix.json.error.message, /Free\/mock-a\/nope/, '提示里要给出完整名字');

  const badModel = await chat({ model: 'Free/mock-a/nope', messages: [{ role: 'user', content: 'x' }] });
  assert.equal(badModel.status, 404);
  assert.match(badModel.json.error.message, /没有启用中的模型/);

  // 上面连着 5 条 404 正好会把「失败锁定」喂到阈值（同 IP 连续 5 次失败锁 5 分钟，
  // 那是 test/m6.test.js 专门验的东西）。这个用例验的是错误文案和正常端点，
  // 所以在这里复位一次，免得下面的正常请求吃到 429。
  require('../src/app').v1FailureGuard.reset();

  const usage = await fetch(`${baseUrl}/openai/usage`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
  assert.equal(usage.status, 200);
  assert.equal((await usage.json()).object, 'list');

  const notImplemented = await fetch(`${baseUrl}/openai/embeddings`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ACCESS_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(notImplemented.status, 404);
});

test('12) 主页拖拽排序：模型条目顺序决定选源优先级', async () => {
  // 主页展示的是"所有提供商的所有模型"，优先级由模型条目的顺序决定
  const models = await adminApi('/models');
  assert.equal(models.status, 200, JSON.stringify(models.json));
  const aModel = models.json.find((m) => m.providerId === 'mock-a');
  const bModel = models.json.find((m) => m.providerId === 'mock-b');
  assert.ok(aModel && bModel, '应能拿到两个来源的模型条目');

  const reorder = await adminApi('/models/reorder', {
    method: 'POST',
    body: { orderedIds: [bModel.id, aModel.id] },
  });
  assert.equal(reorder.status, 200, JSON.stringify(reorder.json));
  assert.equal(reorder.json[0].providerId, 'mock-b', '排序结果里 B 应排在最前');

  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200);
  assert.equal(mockB.state.calls.at(-1).body.model, 'mock-1', '改序后应优先用 B');

  // 改回来，避免影响后续用例
  await adminApi('/models/reorder', { method: 'POST', body: { orderedIds: [aModel.id, bModel.id] } });
});

test('13) 流式请求不再拒绝（M1 已支持，返回 SSE 响应头）', async () => {
  const res = await chat({ model: 'Free/mock-b/mock-1', stream: true, messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/event-stream/);
});

test('14) 客户端地址：/openai 前缀，里面的 /v1 可有可无；旧的裸 /v1 不再支持', async () => {
  const auth = { authorization: `Bearer ${ACCESS_KEY}` };
  const hit = async (path) => (await fetch(`${baseUrl}${path}`, { headers: auth })).status;

  // 两种写法都认（客户端有的会把 base_url 拼成 .../openai/v1）
  assert.equal(await hit('/openai/models'), 200, '/openai/models');
  assert.equal(await hit('/openai/v1/models'), 200, '/openai/v1/models 也要认');
  assert.equal(await hit('/openai/v1/chat/completions'), 404, 'GET 到 POST 端点是 404，不是 405');
  assert.equal(await hit('/openai'), 200, '前缀根路径给一份端点索引');

  // 只吃掉紧跟在协议族后面的那一段 v1：多写一层就正常 404（别写成"无限吞"）
  assert.equal(await hit('/openai/v1/v1/models'), 404, '只吃一段 v1');

  // 旧的裸 /v1 地址不再保留（2.0.0 的破坏性变更，见 README）
  assert.equal(await hit('/v1/models'), 404, '裸 /v1 已经不用了');
  assert.equal(await hit('/v1/chat/completions'), 404, '裸 /v1 已经不用了');

  // 前缀都得写对
  assert.equal(await hit('/openaiX/models'), 404);
  assert.equal(await hit('/models'), 404, '必须有前缀');
});
