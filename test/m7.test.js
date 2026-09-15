'use strict';

/**
 * M7 端到端测试：**模型组**（`ModelGroup/<组名>`）+ 新命名的几条硬约束
 *
 * 用户裁定 2026-09-11：
 *   - 名字就四套：`All`、`Free/<来源id>/<模型名>`、`Pay/<来源id>/<模型名>`、`ModelGroup/<组名>`
 *   - 模型组 = 用户自己排的一套兜底链：**组内顺序 = 选源优先级**，可以混免费和付费
 *   - 组名就是个普通字符串（随手改，没有"保存"）；删组不影响模型；删模型要顺手清掉组里的条目
 *
 * 覆盖：
 *   - /openai/models 里发布 All / Free / Pay / ModelGroup，虚拟名字带上下文长度
 *   - 请求 ModelGroup/<组名>：按组内顺序换源（先免费后付费也照样按组里排的来）
 *   - 组内顺序真的生效（拖拽排序后换源顺序跟着变）
 *   - 组内可以混免费与付费
 *   - 组名改名后：新名字能用、旧名字 404
 *   - 重名 / 非法组名（带斜杠、空格）会被挡
 *   - 组里没模型 / 组里模型全挂 → 统一 503
 *   - 删模型 → 组里的条目自动消失（不留脏行）
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
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm7-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'm7-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-m7-key';
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
const modelIds = {}; // 'free-a/m1' → provider_models.id

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
  return { status: res.status, text, json: text ? JSON.parse(text) : null, headers: res.headers };
}

const readModels = async () =>
  (await (await fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${ACCESS_KEY}` } })).json()).data;

async function listGroups() {
  const res = await adminApi('/model-groups');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json;
}

/** 把两个假来源拨回"可用"：上一条用例把它们打成故障后，状态是留在库里的（冷却中） */
async function resetSources() {
  mockFree.state.mode = 'ok';
  mockPaid.state.mode = 'ok';
  await adminApi('/providers/free-a/state', { method: 'POST', body: { status: 'available' } });
  await adminApi('/providers/paid-b/state', { method: 'POST', body: { status: 'available' } });
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
  const cookies =
    typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  cookie = cookies.map((c) => String(c).split(';')[0]).join('; ');

  const createProvider = async (body) => {
    const res = await adminApi('/providers', { method: 'POST', body });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  };
  await createProvider({
    id: 'free-a',
    name: '免费来源 A',
    baseUrl: mockFree.baseUrl,
    apiKey: 'key-free-a',
    rateLimits: [],
    rejectPolicy: 'cooldown_probe',
    cooldownSeconds: 300,
  });
  await createProvider({
    id: 'paid-b',
    name: '付费兜底 B',
    baseUrl: mockPaid.baseUrl,
    apiKey: 'key-paid-b',
    isPaid: true,
    rateLimits: [],
    rejectPolicy: 'cooldown_probe',
    cooldownSeconds: 300,
  });

  // free-a 下两个模型、paid-b 下一个模型
  for (const [providerId, modelId] of [
    ['free-a', 'm1'],
    ['free-a', 'm2'],
    ['paid-b', 'p1'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi(`/providers/${providerId}/models`, { method: 'POST', body: { modelId } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    modelIds[`${providerId}/${modelId}`] = res.json.id;
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

test('M7-1) /openai/models：发布的四类名字都带类别前缀，模型的显示名/别名字段已经不存在', async () => {
  const data = await readModels();
  const ids = data.map((m) => m.id);
  assert.deepEqual(
    ids,
    ['All', 'Free/free-a/m1', 'Free/free-a/m2', 'Pay/paid-b/p1'],
    'All 排第一，其余按「All模型顺序」（免费在前）'
  );
  assert.equal(data.find((m) => m.id === 'Free/free-a/m1').owned_by, 'Free/free-a');
  assert.equal(data.find((m) => m.id === 'Pay/paid-b/p1').owned_by, 'Pay/paid-b');

  // 显示名 / 别名这两个字段已经彻底没了（接口里连字段名都不出现）
  const concrete = data.find((m) => m.id === 'Free/free-a/m1');
  assert.equal(concrete.display_name, undefined);
  assert.equal(concrete.displayName, undefined);
  assert.equal(concrete.aliases, undefined);

  // 模型列表接口里也不再回这两个字段
  const models = await adminApi('/models');
  const first = models.json[0];
  assert.equal(first.displayName, undefined, '/api/admin/models 不该再回 displayName');
  assert.equal(first.aliases, undefined, '/api/admin/models 不该再回 aliases');
  assert.match(first.publishedId, /^(Free|Pay)\//);
});

test('M7-2) 建组 / 改名 / 重名 / 非法名 / 删组', async () => {
  const created = await adminApi('/model-groups', { method: 'POST', body: {} });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.name, '模型组1', '不填名字给个默认名');
  assert.equal(created.json.publishedId, 'ModelGroup/模型组1');
  const groupId = created.json.id;

  // 随手改名（后台那个输入框失焦就调这个）
  const renamed = await adminApi(`/model-groups/${groupId}`, { method: 'PATCH', body: { name: '便宜优先' } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
  assert.equal(renamed.json.publishedId, 'ModelGroup/便宜优先');

  // 重名要挡
  const second = await adminApi('/model-groups', { method: 'POST', body: { name: '另一个组' } });
  assert.equal(second.status, 201);
  const dup = await adminApi(`/model-groups/${second.json.id}`, { method: 'PATCH', body: { name: '便宜优先' } });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error.message, /已经有一个叫/);

  // 组名不能带斜杠/空格（否则 ModelGroup/a/b 没法解析）
  for (const bad of ['a/b', '有 空格', '   ']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi(`/model-groups/${second.json.id}`, { method: 'PATCH', body: { name: bad } });
    assert.equal(res.status, 400, `组名「${bad}」应被拒`);
  }

  // 空名 / 太长的名字
  assert.equal((await adminApi('/model-groups', { method: 'POST', body: { name: '' } })).status, 201, '空名给默认名');
  const long = await adminApi('/model-groups', { method: 'POST', body: { name: 'x'.repeat(65) } });
  assert.equal(long.status, 400);

  // 删组
  const removed = await adminApi(`/model-groups/${groupId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  const groups = await listGroups();
  assert.equal(groups.find((g) => g.id === groupId), undefined);

  // 收干净：把剩下的组都删掉，免得影响后面的用例
  for (const g of groups) {
    // eslint-disable-next-line no-await-in-loop
    await adminApi(`/model-groups/${g.id}`, { method: 'DELETE' });
  }
  assert.equal((await listGroups()).length, 0);
});

test('M7-3) 组内加模型/删模型 + 组对外发布（带上下文长度）', async () => {
  const group = (await adminApi('/model-groups', { method: 'POST', body: { name: '主链路' } })).json;

  const added = await adminApi(`/model-groups/${group.id}/items`, {
    method: 'POST',
    body: { providerModelId: modelIds['free-a/m1'] },
  });
  assert.equal(added.status, 201, JSON.stringify(added.json));

  // 同一个模型不能加两次
  const dup = await adminApi(`/model-groups/${group.id}/items`, {
    method: 'POST',
    body: { providerModelId: modelIds['free-a/m1'] },
  });
  assert.equal(dup.status, 400);
  assert.match(dup.json.error.message, /已经在组里/);

  // 不存在的模型
  const missing = await adminApi(`/model-groups/${group.id}/items`, {
    method: 'POST',
    body: { providerModelId: 999999 },
  });
  assert.equal(missing.status, 404);

  const groups = await listGroups();
  const fresh = groups.find((g) => g.id === group.id);
  assert.equal(fresh.items.length, 1);
  assert.equal(fresh.items[0].publishedId, 'Free/free-a/m1');
  assert.equal(fresh.items[0].providerName, '免费来源 A');

  // /openai/models 里发布了这个组，而且带上下文长度（客户端靠它决定何时压缩上下文）
  const published = (await readModels()).find((m) => m.id === 'ModelGroup/主链路');
  assert.ok(published, '模型组要发布到 /openai/models');
  assert.equal(published.context_length, 256000);
  assert.equal(published.context_window, 256000);
  assert.equal(published.owned_by, 'llm-aggregator');

  // 删条目
  const del = await adminApi(`/model-groups/${group.id}/items/${fresh.items[0].id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await listGroups()).find((g) => g.id === group.id).items.length, 0);
});

test('M7-4) 请求 ModelGroup/<组名>：按组内顺序换源，免费付费可混', async () => {
  const group = (await adminApi('/model-groups', { method: 'POST', body: { name: '混合链' } })).json;
  // 故意把付费排在免费前面：组内顺序说了算，不按"免费在前"那个规矩
  for (const key of ['paid-b/p1', 'free-a/m1']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await adminApi(`/model-groups/${group.id}/items`, {
      method: 'POST',
      body: { providerModelId: modelIds[key] },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }

  const paidBefore = mockPaid.state.calls.length;
  const freeBefore = mockFree.state.calls.length;
  const res = await chat({ model: 'ModelGroup/混合链', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].message.content, 'pong-from-paid', '组里付费排第一 → 先走付费');
  assert.equal(res.json.model, 'ModelGroup/混合链', '虚拟名字按客户端请求的原样回');
  assert.equal(mockPaid.state.calls.length, paidBefore + 1);
  assert.equal(mockFree.state.calls.length, freeBefore, '第一个就成功了，不该碰后面的');

  // 第一个挂了 → 换到组里第二个
  mockPaid.state.mode = 'server_error';
  const fallback = await chat({ model: 'ModelGroup/混合链', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(fallback.status, 200, JSON.stringify(fallback.json));
  assert.equal(fallback.json.choices[0].message.content, 'pong-from-free', '组里下一个兜底');
  mockPaid.state.mode = 'ok';

  // 日志：模型列写「ModelGroup/名字(实际模型)」，来源列写命中的那个
  const logs = await adminApi('/logs?limit=3');
  assert.equal(logs.json[0].status, 'fallback');
  assert.equal(logs.json[0].providerId, 'free-a');
  assert.equal(logs.json[0].modelName, 'ModelGroup/混合链(m1)', '虚拟名字要带出实际用的模型');
  assert.equal(logs.json[0].sourceLabel, 'Free/free-a');

  // 组内顺序真的生效：拖拽排序把免费挪到前面
  const items = (await listGroups()).find((g) => g.id === group.id).items;
  const freeItem = items.find((i) => i.publishedId === 'Free/free-a/m1');
  const paidItem = items.find((i) => i.publishedId === 'Pay/paid-b/p1');
  const reorder = await adminApi(`/model-groups/${group.id}/reorder`, {
    method: 'POST',
    body: { orderedIds: [freeItem.id, paidItem.id] },
  });
  assert.equal(reorder.status, 200, JSON.stringify(reorder.json));
  const afterReorder = await chat({ model: 'ModelGroup/混合链', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(afterReorder.json.choices[0].message.content, 'pong-from-free', '拖拽之后免费排第一');

  // 组里全挂 → 统一 503（不暴露上游细节）
  mockFree.state.mode = 'server_error';
  mockPaid.state.mode = 'server_error';
  const allDead = await chat({ model: 'ModelGroup/混合链', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(allDead.status, 503, JSON.stringify(allDead.json));
  assert.ok(!JSON.stringify(allDead.json).includes('free-a'), '不暴露来源 id');
  await resetSources();
});

test('M7-5) 改名后：新名字能用，旧名字 404；改名即时生效（不用重启）', async () => {
  const group = (await adminApi('/model-groups', { method: 'POST', body: { name: '旧名字' } })).json;
  await adminApi(`/model-groups/${group.id}/items`, { method: 'POST', body: { providerModelId: modelIds['free-a/m2'] } });

  const before = await chat({ model: 'ModelGroup/旧名字', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(before.status, 200, JSON.stringify(before.json));

  await adminApi(`/model-groups/${group.id}`, { method: 'PATCH', body: { name: '新名字' } });

  const after = await chat({ model: 'ModelGroup/新名字', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(after.status, 200, JSON.stringify(after.json));
  assert.equal(after.json.choices[0].message.content, 'pong-from-free');

  const old = await chat({ model: 'ModelGroup/旧名字', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(old.status, 404, '旧名字应该已经没了');
  assert.match(old.json.error.message, /没有名叫/);

  // 发布列表也跟着变
  const ids = (await readModels()).map((m) => m.id);
  assert.ok(ids.includes('ModelGroup/新名字'));
  assert.ok(!ids.includes('ModelGroup/旧名字'));
});

test('M7-6) 空组 / 组里模型全被删掉 → 503；删模型会清掉组里的条目', async () => {
  const group = (await adminApi('/model-groups', { method: 'POST', body: { name: '空组' } })).json;
  const empty = await chat({ model: 'ModelGroup/空组', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(empty.status, 503, '组里什么都没有 → 和不分来源可用时的口径一致');

  // 加两个模型，然后把其中一个从提供商那里删掉 → 组里的条目要跟着消失
  await adminApi(`/model-groups/${group.id}/items`, { method: 'POST', body: { providerModelId: modelIds['free-a/m2'] } });
  const tmp = await adminApi('/providers/free-a/models', { method: 'POST', body: { modelId: 'm3' } });
  assert.equal(tmp.status, 201, JSON.stringify(tmp.json));
  await adminApi(`/model-groups/${group.id}/items`, { method: 'POST', body: { providerModelId: tmp.json.id } });
  assert.equal((await listGroups()).find((g) => g.id === group.id).items.length, 2);

  const del = await adminApi(`/models/${tmp.json.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  const afterDelete = (await listGroups()).find((g) => g.id === group.id);
  assert.equal(afterDelete.items.length, 1, '删掉模型后组里只剩 1 条，不留指向空气的行');
  assert.equal(afterDelete.items[0].publishedId, 'Free/free-a/m2');

  // 库里也不能有孤儿行
  const { db } = require('../src/db');
  const orphans = await db('model_group_items')
    .leftJoin('provider_models', 'provider_models.id', 'model_group_items.provider_model_id')
    .whereNull('provider_models.id');
  assert.equal(orphans.length, 0, 'model_group_items 里不该有指向已删模型的行');
});

test('M7-7) 组里模型被禁用 → 不进候选；全禁用 → 503', async () => {
  await resetSources();
  const group = (await adminApi('/model-groups', { method: 'POST', body: { name: '禁用测试' } })).json;
  for (const key of ['free-a/m2', 'paid-b/p1']) {
    // eslint-disable-next-line no-await-in-loop
    await adminApi(`/model-groups/${group.id}/items`, { method: 'POST', body: { providerModelId: modelIds[key] } });
  }
  await adminApi(`/models/${modelIds['free-a/m2']}`, { method: 'PATCH', body: { enabled: false } });

  const res = await chat({ model: 'ModelGroup/禁用测试', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.choices[0].message.content, 'pong-from-paid', '被禁用的模型要跳过');

  await adminApi(`/models/${modelIds['paid-b/p1']}`, { method: 'PATCH', body: { enabled: false } });
  const dead = await chat({ model: 'ModelGroup/禁用测试', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(dead.status, 503);

  // 还原，别影响别的用例
  await adminApi(`/models/${modelIds['free-a/m2']}`, { method: 'PATCH', body: { enabled: true } });
  await adminApi(`/models/${modelIds['paid-b/p1']}`, { method: 'PATCH', body: { enabled: true } });
});

test('M7-8) 模型组和 All 互不影响：组里没排的模型，All 照样会用', async () => {
  await resetSources();
  const before = mockFree.state.calls.length;
  const res = await chat({ model: 'All', messages: [{ role: 'user', content: 'ping' }] });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.model, 'All');
  assert.ok(mockFree.state.calls.length > before, 'All 按自己的顺序选，不受模型组影响');
});
