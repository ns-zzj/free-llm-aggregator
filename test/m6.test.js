'use strict';

/**
 * M6 端到端测试：**首次设置**流程（啥也没有时的那一屏）
 *
 * 覆盖：
 *   - 库里没有任何凭据时，服务**照样起得来**（以前是直接报错退出）
 *   - 后台接口回 403 setup_required；/api/setup/status 告诉前端"需要首次设置"
 *   - 首次设置能一次搞定"管理密码 + 下游 apikey"（留空则自动生成）
 *   - 设置完立刻能用（自动登录 + 下游口令能调 /v1/*）
 *   - 已经设置过再调 /setup → 409
 *   - scripts/reset-credentials.js 清空后又能回到首次设置
 *   - 只重置管理密码时：已经有的下游口令显示成掩码，提交「留空」不会把它换掉
 *   - **公网来源不许初始化**（防着"谁先扫到端口谁就占了管理密码"）
 *   - **管理端默认只允许内网来源**：公网改不了设置、也进不了后台，但 /v1 照常。
 *     这条闸现在只有一个出处：环境变量 `ALLOW_PUBLIC_INTERNET`（后台那个开关已删）——
 *     所以本文件**必须**保证这个变量没被设上，否则下面几条断言全无意义
 *   - **失败锁定**（2026-09-15）：后台登录和 `/v1` 同一套 —— 同 IP 连错 5 次锁 5 分钟、
 *     之后翻倍到 1 小时、24 小时没动静就忘掉、成功一次即解禁
 *   - **不开箱即用不算完**：不设 APP_SECRET 也能起（自动生成到数据目录），而且**重启后还是同一个**
 *     —— 否则每次重启主密钥都变，已存的上游 apiKey 全都解不开
 */

const test = require('node:test');
// 用例之间复位「失败锁定」（按来源 IP 记）。M6-10 / M6-11 是**故意**连打失败来验锁定的，
// 复位只发生在每个用例开始之前，所以它们照样能从 0 累到 5。
test.beforeEach(() => require('../src/app').v1FailureGuard.reset());
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tmpRoot = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'setup-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'setup-test-secret-0123456789abcdef0123456789';
process.env.ACCESS_KEY = '';
process.env.ADMIN_PASSWORD = ''; // 关键：不给初始管理密码
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
process.env.BIND = '127.0.0.1';
// 管理端来源闸的唯一开关：清掉（万一外面的 shell 里 export 过），保证测的是"内置默认 false"那条路
delete process.env.ALLOW_PUBLIC_INTERNET;

let appServer;
let baseUrl;

async function adminApi(pathname, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${baseUrl}/api/admin${pathname}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (err) {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

test.before(async () => {
  const { bootstrap } = require('../src/index');
  appServer = await bootstrap(); // 没有 ADMIN_PASSWORD 也应该能起来
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

test.after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  const { db } = require('../src/db');
  await db.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('M6-1) 没有任何凭据时：服务能起来，后台接口说"需要首次设置"、客户端调用被拒', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200, '服务应该照常可用，而不是起不来');

  const me = await adminApi('/me');
  assert.equal(me.status, 403);
  assert.equal(me.json.error.code, 'setup_required', '要明确告诉前端"去首次设置"，而不是含糊的 401');

  const status = await adminApi('/setup/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.needsSetup, true);
  assert.equal(status.json.allowedFromHere, true, '本机来源允许初始化');

  const models = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: 'Bearer whatever-key' } });
  assert.equal(models.status, 401, '还没有下游口令 → /v1/* 拒绝');
});

test('M6-2) 来源判定：公网地址一律不许初始化，且伪造请求头也不管用', async () => {
  const net = require('../src/net');

  // 判定函数本身（这是安全闸的核心）
  for (const ip of [
    '127.0.0.1',
    '::1',
    '0:0:0:0:0:0:0:1', // ::1 的完整写法
    '[::1]', // 带方括号（URL 里的写法）
    '::ffff:127.0.0.1', // IPv4-mapped：双栈监听下 IPv4 客户端就是这个样子
    '::ffff:10.0.0.7',
    '::ffff:192.168.1.5',
    '::ffff:172.16.4.4',
    '::FFFF:127.0.0.1', // 大小写不敏感
    '::ffff:7f00:1', // IPv4-mapped 的十六进制写法（有些协议栈会这么给）
    '10.0.0.7',
    '192.168.1.5',
    '172.16.4.4',
    '172.31.9.9',
    'fd00::1',
    'fd12:3456:789a::1',
    'fe80::1',
    'fe80::a00:27ff:fe4e:66a1%eth0', // 链路本地带 zone
  ]) {
    assert.equal(net.isPrivateAddress(ip), true, `${ip} 应判为内网/本机`);
  }
  for (const ip of [
    '8.8.8.8',
    '203.0.113.9',
    '172.32.0.1',
    '172.15.0.1',
    '::ffff:8.8.8.8', // mapped 的公网 IPv4 依旧是公网
    '::ffff:203.0.113.9',
    '2001:4860:4860::8888', // 公网 IPv6（Google DNS）
    '2001:db8::1', // 文档用前缀，也是公网口径
    '2606:4700:4700::1111',
    'fe00::1', // fe80::/10 之外的（fe00 不在链路本地范围内）
    'fbff::1', // 不在 fc00::/7 里（fc00::/7 = fc00 ~ fdff）
    '',
    'not-an-ip',
    '999.1.1.1',
  ]) {
    assert.equal(net.isPrivateAddress(ip), false, `${ip} 应判为公网/无效`);
  }

  // 端到端：X-Forwarded-For 写什么都没用 —— 判定用的是 TCP 对端（这里就是 127.0.0.1）
  const spoofed = await fetch(`${baseUrl}/api/admin/setup/status`, {
    headers: { 'x-forwarded-for': '8.8.8.8' },
  });
  const spoofedJson = await spoofed.json();
  assert.equal(spoofedJson.allowedFromHere, true, '只看 socket 地址，不信 X-Forwarded-For');
  assert.match(spoofedJson.clientIp, /127\.0\.0\.1|::1|::ffff:127\.0\.0\.1/, 'clientIp 应是真实对端地址');
});

test('M6-3) 首次设置一次搞定管理密码 + 下游 apikey（留空自动生成）', async () => {
  const done = await adminApi('/setup', { method: 'POST', body: { adminPassword: 'first-pass-123' } });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.match(done.json.accessKey, /^sk-/, '留空应自动生成一条 sk- 开头的口令');

  // 自动登录：设置完直接就是登录态
  const cookies = typeof done.headers.getSetCookie === 'function' ? done.headers.getSetCookie() : [done.headers.get('set-cookie')];
  const cookie = cookies.map((c) => String(c).split(';')[0]).join('; ');
  const me = await adminApi('/me', { cookie });
  assert.equal(me.status, 200, '设置完应该已经登录（免去再登一次）');

  // 下游口令立刻能用
  const models = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${done.json.accessKey}` } });
  assert.equal(models.status, 200, '刚设置的下游口令应能调用 /v1/*');

  // 管理密码立刻能登录
  const login = await adminApi('/login', { method: 'POST', body: { password: 'first-pass-123' } });
  assert.equal(login.status, 200);
  const wrong = await adminApi('/login', { method: 'POST', body: { password: '不对的密码' } });
  assert.equal(wrong.status, 401);

  // 再设置一次 → 409
  const again = await adminApi('/setup', { method: 'POST', body: { adminPassword: 'another-pass' } });
  assert.equal(again.status, 409, '设置过之后不能再来一次');

  // 太短的管理密码 → 400（在"还没设置"的前提下才测得到，所以这里用重置后再试）
  const { resetCredentials } = require('../scripts/reset-credentials.js');
  await resetCredentials();
  const short = await adminApi('/setup', { method: 'POST', body: { adminPassword: '123' } });
  assert.equal(short.status, 400, '管理密码至少 6 位');
});

test('M6-4) reset-credentials 清空凭据 → 回到首次设置页（不用重启）', async () => {
  const { resetCredentials } = require('../scripts/reset-credentials.js');

  // 先确保处于"已设置"状态（M6-3 最后为了测"密码太短"把它重置掉了）
  const setupFirst = await adminApi('/setup', { method: 'POST', body: { adminPassword: 'before-reset-123' } });
  assert.equal(setupFirst.status, 201, JSON.stringify(setupFirst.json));
  const status0 = await adminApi('/setup/status');
  assert.equal(status0.json.needsSetup, false, '此时已设置过');

  const result = await resetCredentials();
  assert.equal(result.removedKeys, 1, '下游口令被清掉');

  const status1 = await adminApi('/setup/status');
  assert.equal(status1.json.needsSetup, true, '清空后台接口立刻就说"需要首次设置"了（不用重启）');
  const me = await adminApi('/me');
  assert.equal(me.status, 403);
  assert.equal(me.json.error.code, 'setup_required');

  // 再来一次完整设置，把状态收干净
  const done = await adminApi('/setup', { method: 'POST', body: { adminPassword: 'second-pass-123', accessKey: 'my-key-123456' } });
  assert.equal(done.status, 201);
  assert.equal(done.json.accessKey, 'sk-my-key-123456', 'sk- 前缀由后端补上');
  const models = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: 'Bearer sk-my-key-123456' } });
  assert.equal(models.status, 200);
});

test('M6-5) 只重置管理密码（下游口令保留）：设置页给掩码，提交「留空」不会把口令换掉', async () => {
  const { resetCredentials } = require('../scripts/reset-credentials.js');
  const { db } = require('../src/db');

  const kept = 'sk-my-key-123456'; // M6-4 结尾留下的那条
  const result = await resetCredentials({ keepAccessKeys: true });
  assert.equal(result.removedKeys, 0, '--keep-key 不碰下游口令');

  // 设置页要能显示「已经有一条：sk-****」+ 更改按钮，而不是让用户重填
  const status = await adminApi('/setup/status');
  assert.equal(status.json.needsSetup, true);
  assert.equal(status.json.hasAccessKey, true);
  assert.equal(status.json.accessKeyMasked, `sk-${'*'.repeat(kept.replace(/^sk-/, '').length)}`, '给的是等长掩码，不是明文');

  const before = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${kept}` } });
  assert.equal(before.status, 200, '重置管理密码不该影响下游调用');

  // 前端在「沿用」状态下干脆不发 accessKey 字段 → 后端必须原样保留
  const done = await adminApi('/setup', { method: 'POST', body: { adminPassword: 'keep-key-pass-123' } });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.equal(done.json.accessKeyChanged, false);
  assert.equal(done.json.accessKey, kept, '沿用原来的口令，并把明文回给后台（客户端还要用它）');

  const after = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${kept}` } });
  assert.equal(after.status, 200, '留空提交绝不能顺手把下游口令换掉');
  assert.equal((await db('access_keys')).length, 1, '还是那一条，没多也没换');

  // 真要换的时候：带上新的 accessKey
  await resetCredentials({ keepAccessKeys: true });
  const changed = await adminApi('/setup', {
    method: 'POST',
    body: { adminPassword: 'keep-key-pass-456', accessKey: 'brand-new-999' },
  });
  assert.equal(changed.status, 201, JSON.stringify(changed.json));
  assert.equal(changed.json.accessKeyChanged, true);
  assert.equal(changed.json.accessKey, 'sk-brand-new-999');

  const oldGone = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${kept}` } });
  assert.equal(oldGone.status, 401, '换过之后旧口令立即失效');
  const newOk = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: 'Bearer sk-brand-new-999' } });
  assert.equal(newOk.status, 200);
});

test('M6-6) 管理端默认只允许内网来源：公网直连改不了设置，/openai 照常', async () => {
  const net = require('../src/net');
  const settings = require('../src/store/settings');
  const auth = require('../src/auth');
  const config = require('../src/config');

  // 公网放行的**唯一**出处是环境变量 ALLOW_PUBLIC_INTERNET（本文件开头清掉了）→ 内置默认 false
  assert.equal(config.adminPublicInternet, false, '没配就是内置默认 false');
  assert.equal(auth.publicSourceAllowed(), false, '默认公网来源不放行');
  // 后台里已经没有能改它的开关了：设置项里不该再有 admin_local_only
  assert.equal(await settings.get('admin_local_only'), null, '那个后台开关已经删掉');

  // 本机身份：登录 + 用后台都正常
  const login = await adminApi('/login', { method: 'POST', body: { password: 'keep-key-pass-456' } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const raw = login.headers.getSetCookie ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  const cookie = raw.map((c) => String(c).split(';')[0]).join('; ');
  assert.equal((await adminApi('/settings', { cookie })).status, 200, '内网来源照常进后台');

  // 假装这些请求来自公网（判定看的是 TCP 对端，所以直接替掉它）
  const realClientAddress = net.clientAddress;
  const asPublic = () => {
    net.clientAddress = () => '203.0.113.9';
  };
  const asReal = () => {
    net.clientAddress = realClientAddress;
  };

  try {
    asPublic();

    // 还带着伪造的 X-Forwarded-For：不该因此被放行
    const spoofed = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie, 'x-forwarded-for': '127.0.0.1' },
      body: JSON.stringify({ allow_no_key: true }),
    });
    assert.equal(spoofed.status, 403, '公网来源 + 伪造头 → 照样拒');
    assert.equal((await spoofed.json()).error.code, 'admin_local_only');
    assert.equal(await settings.get('allow_no_key'), 'false', '设置没被改动');

    // 手里攥着一条有效会话也没用 —— 这道闸在鉴权之前就拦了
    assert.equal((await adminApi('/settings', { cookie })).status, 403);
    assert.equal((await adminApi('/access-keys/primary', { cookie })).status, 403);
    assert.equal((await adminApi('/me', { cookie })).status, 403);

    // 唯一对外说话的出口：setup/status（前端靠它把"为什么进不去"显示出来）
    const status = await adminApi('/setup/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.adminAllowedHere, false);
    assert.equal(status.json.hasAccessKey, false, '公网来源连"有没有口令"都不告诉');
    assert.equal(status.json.accessKeyMasked, '', '也不泄露口令长度（掩码只在来源可信时才回）');

    // 客户端面完全不受影响
    const models = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: 'Bearer sk-brand-new-999' } });
    assert.equal(models.status, 200, '/v1 照常公网可用');

    // 前端上报也一起挡（不然谁都能往服务端日志里灌东西）
    const clientLog = await fetch(`${baseUrl}/api/client-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'test', message: 'should be rejected' }),
    });
    assert.equal(clientLog.status, 403);
  } finally {
    asReal();
  }

  // 用户手里有会话、直接 PATCH 这个键也没用：它已经不在允许改的名单里（键名留着会被静默忽略）
  const patched = await adminApi('/settings', { method: 'PATCH', body: { admin_local_only: false }, cookie });
  assert.equal(patched.status, 200);
  assert.equal(await settings.get('admin_local_only'), null, 'PATCH 也造不出这个设置项来');
  assert.equal(auth.publicSourceAllowed(), false, '改完还是不放行公网');
  // 设置接口也不再吐"被环境变量强制"那个字段了
  const settingsNow = await adminApi('/settings', { cookie });
  assert.equal(settingsNow.json.admin_public_internet_forced, undefined);
  assert.equal(settingsNow.json.admin_local_only, undefined);

  // 真要让公网进来，只有一条路：容器里设 ALLOW_PUBLIC_INTERNET="true" 再重启（在 test/m8.test.js 里验）
  asPublic();
  try {
    assert.equal((await adminApi('/settings', { cookie })).status, 403, '没设那个变量时公网永远进不来');
    assert.equal((await adminApi('/setup/status')).json.adminAllowedHere, false);
  } finally {
    asReal();
  }
});

test('M6-7) 不设 APP_SECRET 也能起：自动生成到数据目录，且重启后还是同一个', async () => {
  const dir = path.join(tmpDir, 'secret-run');
  fs.mkdirSync(dir, { recursive: true });
  const cipherFile = path.join(dir, 'cipher.txt');
  const plainFile = path.join(dir, 'plain.txt');
  const keyFile = path.join(dir, 'app-secret.key');

  // 用子进程跑两次，模拟"装完就跑"和"重启"（APP_SECRET 显式置空 = 走自动生成那条路）
  const runChild = (mode, outFile) =>
    new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          [
            "const fs=require('fs');",
            "const crypto=require('./src/crypto');",
            '(async()=>{await crypto.init();',
            "if(process.env.MODE==='encrypt') fs.writeFileSync(process.env.OUT, crypto.encrypt('hello-secret'));",
            "else fs.writeFileSync(process.env.OUT, String(crypto.decrypt(fs.readFileSync(process.env.IN,'utf8'))));",
            'process.exit(0)})().catch((e)=>{console.error(e.message);process.exit(3)});',
          ].join(''),
        ],
        {
          cwd: path.join(__dirname, '..'),
          env: {
            ...process.env,
            APP_SECRET: '', // 关键：不设主密钥
            DB_PATH: path.join(dir, 'app.db'),
            NODE_ENV: 'test',
            MODE: mode,
            OUT: outFile,
            IN: cipherFile,
            LOG_LEVEL: 'error',
          },
          stdio: 'ignore',
        }
      );
      child.on('exit', (code) => resolve(code));
    });

  assert.equal(await runChild('encrypt', cipherFile), 0, '没有 APP_SECRET 也应该能起来并加密');
  assert.ok(fs.existsSync(keyFile), '应该自动生成 app-secret.key 到数据目录');
  const firstSecret = fs.readFileSync(keyFile, 'utf8').trim();
  assert.ok(firstSecret.length >= 32, '生成的密钥够长');

  assert.equal(await runChild('decrypt', plainFile), 0, '重启后应该还能用同一个密钥');
  assert.equal(fs.readFileSync(plainFile, 'utf8'), 'hello-secret', '解出来的就是当初加密的内容');
  assert.equal(fs.readFileSync(keyFile, 'utf8').trim(), firstSecret, '文件里的密钥不能被改写');

  // 换个数据目录就是另一把密钥（不会所有人共用一个）
  const otherDir = path.join(tmpDir, 'secret-run-2');
  fs.mkdirSync(otherDir, { recursive: true });
  const other = require('../src/appSecret').resolveAppSecret({ dataDir: otherDir });
  assert.equal(other.source, 'generated');
  assert.notEqual(other.secret, firstSecret, '不同数据目录生成不同密钥');

  // 显式给了环境变量就听环境变量的
  const explicit = require('../src/appSecret').resolveAppSecret({ dataDir: dir, envSecret: 'my-own-secret-0123456789abcdef' });
  assert.equal(explicit.source, 'env');
  assert.equal(explicit.secret, 'my-own-secret-0123456789abcdef');
  assert.ok(explicit.note, '和文件里的值不一致时要给出提示（换了密钥会让旧的上游 key 解不开）');
});

test('M6-8) 首次设置不接受跨站表单 POST（审计 S1）：跨站 403、同源/脚本照常', async () => {
  const { resetCredentials } = require('../scripts/reset-credentials.js');
  await resetCredentials(); // 回到"未初始化"，才好测 setup 这条路径

  const form = (extraHeaders) =>
    fetch(`${baseUrl}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders },
      body: new URLSearchParams({
        adminPassword: 'attacker-chosen-password',
        accessKey: 'sk-attacker-known-key',
      }).toString(),
    });

  // ① 浏览器被劫持的场景：跨站表单（简单请求，不触发预检）
  const crossSite = await form({ origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' });
  assert.equal(crossSite.status, 403, '跨站表单必须被拒');
  assert.equal((await crossSite.json()).error.code, 'cross_site_blocked');
  assert.equal((await adminApi('/setup/status')).json.needsSetup, true, '实例不能因此被初始化');
  const attackerKey = await fetch(`${baseUrl}/openai/models`, { headers: { authorization: 'Bearer sk-attacker-known-key' } });
  assert.equal(attackerKey.status, 401, '攻击者那条 key 绝不能生效');

  // ② 只伪造 Origin（没有 Sec-Fetch-Site，老浏览器）：也要拒
  const originOnly = await form({ origin: 'http://evil.example' });
  assert.equal(originOnly.status, 403, 'Origin 与本站不一致就要拒');

  // ③ 同源（我们自己页面的原生表单兜底）：放行
  const sameOrigin = await form({ origin: baseUrl, 'sec-fetch-site': 'same-origin' });
  assert.equal(sameOrigin.status, 201, `同源表单要能正常设置，实际 ${sameOrigin.status}`);

  // ④ 没有任何这两个头（curl / 脚本）：放行 —— 策略上内网直连本来就算可信
  await resetCredentials();
  const script = await fetch(`${baseUrl}/api/admin/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ adminPassword: 'script-pass-123456' }),
  });
  assert.equal(script.status, 201, 'curl/脚本（不发这两个头）不受影响');

  // ⑤ 顺带确认：跨站的**已登录**接口也挡得住（sameSite=lax 之外再加一层）
  const crossSiteMe = await fetch(`${baseUrl}/api/admin/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ log_retention_days: 30 }),
  });
  assert.equal(crossSiteMe.status, 403);
});

test('M6-9) 改了管理密码之后，之前签发的会话立即失效（审计 M4）', async () => {
  // M6-8 最后用脚本路径设置过，先登录拿一条会话
  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'script-pass-123456' }),
  });
  assert.equal(login.status, 200, '先能登录');
  const cookies =
    typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  const oldCookie = cookies.map((c) => String(c).split(';')[0]).join('; ');

  const before = await fetch(`${baseUrl}/api/admin/me`, { headers: { cookie: oldCookie } });
  assert.equal(before.status, 200, '这条会话本来是好用的');

  // 改密码（就带这条会话改）
  const changed = await fetch(`${baseUrl}/api/admin/settings/admin-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: oldCookie },
    body: JSON.stringify({ next: 'after-change-999999' }),
  });
  assert.equal(changed.status, 200, JSON.stringify(await changed.json()));

  // 同一条 cookie 现在必须失效（否则"改密码"踢不掉已经拿到会话的人）
  const after = await fetch(`${baseUrl}/api/admin/me`, { headers: { cookie: oldCookie } });
  assert.equal(after.status, 401, '改密码后旧会话要立刻失效');
  assert.equal((await after.json()).error.code, 'session_stale');

  // 新密码能重新登录
  const relogin = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'after-change-999999' }),
  });
  assert.equal(relogin.status, 200, '新密码可以登录');
});

test('M6-10) 登录失败会被限速（审计 M2）：连错 5 次锁 5 分钟，期间连正确密码也挡', async () => {
  const attempt = (password) =>
    fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });

  let locked = null;
  for (let i = 0; i < 8; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await attempt(`wrong-password-${i}`);
    if (res.status === 429) {
      locked = res;
      break;
    }
    assert.equal(res.status, 401, `第 ${i + 1} 次错密码应该是 401`);
    // 审计 L5：错误文案里不该再出现口令指纹（那等于把手输口令的哈希前缀留在磁盘/浏览器历史里）
    // eslint-disable-next-line no-await-in-loop
    const body = await res.json();
    assert.ok(!/指纹/.test(body.error.message), '登录失败提示不该带口令指纹');
    assert.ok(!/[0-9a-f]{8}/i.test(body.error.message), '也不该带任何哈希前缀');
  }
  assert.ok(locked, '连错之后必须开始返回 429');
  assert.ok(Number(locked.headers.get('retry-after')) > 0, '429 要带 Retry-After');
  // 用户 2026-09-15 定的参数：连续失败 5 次 → 锁 5 分钟（不是 30 秒）
  const retryAfter = Number(locked.headers.get('retry-after'));
  assert.ok(retryAfter > 290 && retryAfter <= 300, `第一次锁应该是 5 分钟，实际 ${retryAfter} 秒`);

  // 锁定期间连正确密码也挡住（否则锁定没意义）
  const correctWhileLocked = await attempt('after-change-999999');
  assert.equal(correctWhileLocked.status, 429, '锁定期间正确密码也先挡');
  // 被限速挡掉的那次不能再计数（否则每请求一次锁就翻倍，永远出不来）
  const stillLocked = await attempt('after-change-999999');
  const stillRetryAfter = Number(stillLocked.headers.get('retry-after'));
  assert.ok(stillRetryAfter <= retryAfter, `被挡掉的请求不该让锁变长：${stillRetryAfter} vs ${retryAfter}`);
});

test('M6-11) /openai 吃同一套失败锁定：同 IP 连错 5 次锁 5 分钟，成功一次即解禁', async () => {
  const net = require('../src/net');
  const accessKeys = require('../src/store/accessKeys');
  const key = (await accessKeys.primary()).key;
  assert.ok(key, '这个测试需要一条能用的下游口令');

  const realClientAddress = net.clientAddress;
  const as = (ip) => {
    net.clientAddress = () => ip;
  };
  const call = (bearer) => fetch(`${baseUrl}/openai/models`, { headers: { authorization: `Bearer ${bearer}` } });
  // 计数是在响应结束时做的，等它计完再断言，免得跟事件循环抢时间
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  try {
    // ① 同一个来源连续失败 5 次 → 第 6 次开始 429（客户端撞错循环就是这个形状）
    as('198.51.100.11');
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(`wrong-key-${i}`);
      assert.equal(res.status, 401, `第 ${i + 1} 次错口令只该是 401`);
      // eslint-disable-next-line no-await-in-loop
      await settle();
    }
    const locked = await call(key);
    assert.equal(locked.status, 429, '5 次失败之后，连正确口令也先挡住');
    assert.equal((await locked.json()).error.code, 'too_many_failures');
    const retryAfter = Number(locked.headers.get('retry-after'));
    assert.ok(retryAfter > 290 && retryAfter <= 300, `第一次锁应该是 5 分钟，实际 ${retryAfter} 秒`);

    // ② 锁定是按来源 IP 记的，不是全局：换一个来源照常
    as('198.51.100.12');
    await settle();
    assert.equal((await call(key)).status, 200, '另一个来源不受影响');
    await settle();

    // ③ 成功一次就把这个 IP 放掉：接着 4 次失败仍然只是 401（没被清掉的话它早该 429 了）
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(`wrong-again-${i}`);
      assert.equal(res.status, 401, `成功已经解禁，第 ${i + 1} 次仍然只该是 401`);
      // eslint-disable-next-line no-await-in-loop
      await settle();
    }
  } finally {
    net.clientAddress = realClientAddress;
  }
});

test('M6-12) 从旧版本升级上来：老格式（argon2 哈希）的管理口令读不出来，但绝不静默放行', async () => {
  // 2026-09-15 起管理口令改成"可逆密文"存储。旧库里那条 argon2 哈希新版本解不出来，
  // 这时**不能**当成"还没设置过" —— 否则内网里谁先打开 /admin 谁就能把后台认领走。
  const net = require('../src/net');
  const settings = require('../src/store/settings');
  const { resetCredentials } = require('../scripts/reset-credentials.js');

  const realClientAddress = net.clientAddress;
  // 私网直连：过得了来源闸；顺带避开 M6-10 在环回地址上留下的那把锁
  net.clientAddress = () => '10.20.30.40';
  try {
    await settings.set('admin_password_enc', '');
    await settings.set('admin_password_hash', '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaHZhbHVlaGFzaHZhbHVl');

    assert.equal((await settings.passwordState()).state, 'legacy', '认得出这是老格式');
    assert.equal(
      await settings.needsSetup(),
      false,
      '老格式算"有口令" —— 不然内网第一个打开后台的人就能把密码设成他自己的'
    );
    assert.equal((await adminApi('/setup/status')).json.needsSetup, false, '界面也不该显示首次设置');

    // 登录：谁都过不了（包括"看起来对"的那个），但错误里要说清怎么办
    const login = await fetch(`${baseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'whatever-123456' }),
    });
    assert.equal(login.status, 401);
    const message = (await login.json()).error.message;
    assert.match(message, /旧版本/, '要告诉用户这是老格式读不出来');
    assert.match(message, /reset-credentials/, '要给出处理命令');

    // 首次设置也得挡住（409：认为已经设置过了），不能让人从这条路把后台拿走
    const setup = await fetch(`${baseUrl}/api/admin/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminPassword: 'attacker-pass-123' }),
    });
    assert.equal(setup.status, 409, '老格式期间不许重新初始化');

    // 真正的出路是 reset-credentials（清空后回到首次设置），这条必须能用
    await resetCredentials({ keepAccessKeys: true });
    assert.equal((await settings.passwordState()).state, 'none', '两个键都清掉了');
    assert.equal(await settings.needsSetup(), true, '清空后回到首次设置');
  } finally {
    net.clientAddress = realClientAddress;
  }
});
