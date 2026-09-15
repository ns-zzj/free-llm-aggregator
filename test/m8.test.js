'use strict';

/**
 * M8：网络监听与 IPv6
 *
 * 用户 2026-09-12 的要求："服务器有 ipv6 地址，网页后台和 api 调用都应该支持 ipv6。"
 *
 * 覆盖：
 *   - 不设 BIND 时**默认双栈监听**（`::`）：同一个端口，IPv4（127.0.0.1）和 IPv6（[::1]）都连得上
 *   - 双栈下 IPv4 客户端的对端地址是 **IPv4-mapped**（`::ffff:127.0.0.1`）——
 *     管理端限内网闸必须照样放行，否则"从局域网用 IPv4 打开后台"会被误挡
 *   - 走 IPv6 时：`/healthz`、`/v1/models`（客户端面）、`/api/admin/*`（后台，含登录会话）全部正常
 *   - **公网 IPv6 来源**访问后台 → 403（和不安全的公网 IPv4 一个待遇）
 *   - 显式 `BIND` 写错 → 启动**直接失败**（默认值可以自动退回，用户写死的地址不能悄悄换）
 *   - `hostForUrl()`：IPv6 字面量要加方括号，通配地址显示成 localhost
 *
 * 这台机器没有 IPv6 时（`::` 绑不上、自动退回 0.0.0.0），IPv6 那几条会 skip 而不是失败。
 */

const test = require('node:test');
// 同 m0：用例之间复位「失败锁定」（它按来源 IP 记，而本文件有些用例会连着打错误请求）
test.beforeEach(() => require('../src/app').v1FailureGuard.reset());
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const tmpRoot = path.join(__dirname, '..', '.tmp');
fs.mkdirSync(tmpRoot, { recursive: true });
const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'm8-'));

process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tmpDir, 'app.db');
process.env.APP_SECRET = 'm8-test-secret-0123456789abcdef0123456789';
process.env.ADMIN_PASSWORD = 'admin-pass-123';
process.env.ACCESS_KEY = 'sk-agg-m8-key';
process.env.LOG_LEVEL = 'error';
process.env.PORT = '0';
// 关键：显式置空 = 走"自动双栈"那条默认路径（dotenv 不会覆盖已存在的变量，哪怕它是空串）
process.env.BIND = '';

const ACCESS_KEY = process.env.ACCESS_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const net = require('../src/net');

let appServer;
let port = 0;
let ipv6 = false;
let cookie = '';

function url(host, pathname) {
  // host 形如 '127.0.0.1' 或 '[::1]'
  return `http://${host}:${port}${pathname}`;
}

async function adminApi(pathname, { method = 'GET', body, host = '127.0.0.1' } = {}) {
  const res = await fetch(url(host, `/api/admin${pathname}`), {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test.before(async () => {
  const { bootstrap } = require('../src/index');
  appServer = await bootstrap();
  const info = appServer.address();
  port = info.port;
  ipv6 = info.family === 'IPv6' || info.family === 6;

  const login = await fetch(url('127.0.0.1', '/api/admin/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200, '登录应该成功');
  const cookies =
    typeof login.headers.getSetCookie === 'function' ? login.headers.getSetCookie() : [login.headers.get('set-cookie')];
  cookie = cookies.map((c) => String(c).split(';')[0]).join('; ');
});

test.after(async () => {
  if (appServer) await new Promise((resolve) => appServer.close(resolve));
  const { db } = require('../src/db');
  await db.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('M8-1) 默认双栈监听：同一个端口，IPv4 和 IPv6 都连得上', async (t) => {
  const info = appServer.address();
  assert.equal(info.address, ipv6 ? '::' : '0.0.0.0', `默认应该绑双栈的 ::，实际绑到了 ${info.address}`);

  const v4 = await fetch(url('127.0.0.1', '/healthz'));
  assert.equal(v4.status, 200, 'IPv4 照常');

  if (!ipv6) return t.skip('这台机器绑不上 :: （没有 IPv6），跳过 IPv6 部分');
  const v6 = await fetch(url('[::1]', '/healthz'));
  assert.equal(v6.status, 200, 'IPv6（[::1]）也要能连上同一个端口');
  assert.equal((await v6.json()).ok, true, '走 IPv6 拿到的是同一个服务的健康检查');
});

test('M8-2) 双栈下 IPv4 客户端记成 ::ffff:…：管理端限内网闸照样放行', async () => {
  const status = await adminApi('/setup/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.allowedFromHere, true, '本机/内网来源要放行');
  assert.equal(status.json.adminAllowedHere, true, '管理端也要放行（::ffff:127.0.0.1 必须算内网）');
  assert.match(
    status.json.clientIp,
    /^(::ffff:127\.0\.0\.1|127\.0\.0\.1|::1)$/,
    `双栈下 IPv4 客户端一般是 ::ffff:127.0.0.1，实际 ${status.json.clientIp}`
  );
});

test('M8-3) 走 IPv6：客户端面和后台都正常', async (t) => {
  if (!ipv6) return t.skip('这台机器没有 IPv6，跳过');

  // 客户端面：/v1/models
  const models = await fetch(url('[::1]', '/openai/models'), { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
  assert.equal(models.status, 200, 'IPv6 调用 /v1 要正常');
  const payload = await models.json();
  assert.ok(payload.data.some((m) => m.id === 'All'), '模型列表照常发布 All');

  // 后台：带会话 cookie 走 IPv6
  const me = await fetch(url('[::1]', '/api/admin/me'), { headers: { cookie } });
  assert.equal(me.status, 200, 'IPv6 打开后台接口要正常（会话在 IPv6 下同样有效）');

  const status = await fetch(url('[::1]', '/api/admin/setup/status'));
  const statusJson = await status.json();
  assert.equal(statusJson.adminAllowedHere, true, '::1 是环回，属于内网');
  assert.equal(statusJson.clientIp, '::1', '对端地址应该是纯 IPv6 的 ::1');
});

test('M8-4) 公网 IPv6 来源访问后台 → 403（和公网 IPv4 一个待遇）', async () => {
  const real = net.clientAddress;
  const asPublicV6 = () => {
    net.clientAddress = () => '2001:4860:4860::8888';
  };
  asPublicV6();
  try {
    const blocked = await adminApi('/settings');
    assert.equal(blocked.status, 403, '公网 IPv6 也要被挡');
    assert.equal(blocked.json.error.code, 'admin_local_only');

    // 客户端面不受影响
    const models = await fetch(url('127.0.0.1', '/openai/models'), { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(models.status, 200);

    // 内网 IPv6（唯一本地地址）依旧放行
    net.clientAddress = () => 'fd00::7';
    assert.equal((await adminApi('/me')).status, 200, 'fd00::/7 是内网，要放行');
  } finally {
    net.clientAddress = real;
  }
});

test('M8-5) 显式 BIND 写错 → 启动直接失败（默认值可以退回，写死的地址不能悄悄换）', async () => {
  const exitCode = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['-e', "require('./src/index').bootstrap().then(()=>process.exit(0)).catch(()=>process.exit(3))"],
      {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          PORT: '0',
          DB_PATH: path.join(tmpDir, 'child.db'),
          BIND: '203.0.113.1', // 不是本机地址，绑不上
          LOG_LEVEL: 'error',
        },
        stdio: 'ignore',
      }
    );
    child.on('exit', (code) => resolve(code));
  });
  assert.equal(exitCode, 3, '显式 BIND 绑不上时必须报错退出，不能换成别的地址继续跑');
});

test('M8-6) hostForUrl：IPv6 要加方括号，通配地址显示成 localhost', () => {
  assert.equal(net.hostForUrl('::1'), '[::1]');
  assert.equal(net.hostForUrl('fd00::5'), '[fd00::5]');
  assert.equal(net.hostForUrl('[::1]'), '[::1]', '已经是带括号的写法也不要重复加');
  assert.equal(net.hostForUrl('::'), 'localhost');
  assert.equal(net.hostForUrl('0.0.0.0'), 'localhost');
  assert.equal(net.hostForUrl(''), 'localhost');
  assert.equal(net.hostForUrl('192.168.1.9'), '192.168.1.9');
});

test('M8-7) BIND=0.0.0.0 也算"所有地址"：升级成双栈，而不是被钉死在 IPv4', async (t) => {
  // 老 .env 里基本都写着 BIND=0.0.0.0（以前我们自己的默认值），
  // 写它的人想表达的是"监听所有地址"，不是"只要 IPv4" —— 所以它也要能吃到 IPv6。
  const outFile = path.join(tmpDir, 'bind-any.json');
  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('fs');require('./src/index').bootstrap().then(s=>{fs.writeFileSync(process.env.OUT,JSON.stringify(s.address()));process.exit(0)}).catch(()=>process.exit(3))",
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          PORT: '0',
          DB_PATH: path.join(tmpDir, 'child-any.db'),
          BIND: '0.0.0.0',
          OUT: outFile,
          LOG_LEVEL: 'error',
        },
        stdio: 'ignore',
      }
    );
    child.on('exit', (c) => resolve(c));
  });
  assert.equal(code, 0, '应该能正常起来');
  const bound = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  if (!ipv6) {
    assert.equal(bound.address, '0.0.0.0', '这台机器没有 IPv6 时自动退回 IPv4');
    return t.skip('这台机器没有 IPv6，只验证了"能退回 IPv4"这一半');
  }
  assert.equal(bound.address, '::', `BIND=0.0.0.0 应该绑成双栈 ::，实际 ${bound.address}`);
  assert.equal(bound.family, 'IPv6');
});

test('M8-8) 源 IP 被 NAT/代理抹掉时管理端闸 fail-closed（审计 H1）', async () => {
  // 判定矩阵（纯函数）
  assert.equal(net.checkAdminPeer('127.0.0.1').ok, true, '环回');
  assert.equal(net.checkAdminPeer('::ffff:192.168.1.5').ok, true, '内网直连（双栈下的 IPv4-mapped 写法）');
  assert.equal(net.checkAdminPeer('fd00::7').ok, true, '唯一本地地址');

  const gw = net.checkAdminPeer('172.17.0.1');
  assert.equal(gw.ok, false, 'Docker 默认网桥网关：真实 IP 被抹掉的典型特征 → 默认拒');
  assert.equal(gw.via, 'gateway');
  assert.equal(net.checkAdminPeer('10.0.2.2').ok, false, 'rootless Docker / slirp 的网关 → 默认拒');
  assert.equal(net.checkAdminPeer('172.16.4.4').ok, true, '普通内网段（不是网桥网关）照常放');
  assert.equal(net.checkAdminPeer('203.0.113.9').ok, false, '公网');

  const proxied = net.checkAdminPeer('192.168.1.5', { forwardedFor: '203.0.113.9' });
  assert.equal(proxied.ok, false, '带了 X-Forwarded-For 就不敢信（中间有代理，来源已不可信）');
  assert.equal(proxied.via, 'proxied');
  assert.equal(
    net.checkAdminPeer('127.0.0.1', { forwardedFor: '203.0.113.9' }).ok,
    true,
    '装在本机的反代：对端是环回，照常放行'
  );
  assert.equal(net.checkAdminPeer('172.17.0.1', { trustedPeers: ['172.17.0.1'] }).ok, true, '显式声明了才放');
  assert.equal(
    net.checkAdminPeer('10.0.2.9', { trustedPeers: ['10.0.2.0/24'] }).ok,
    true,
    '白名单支持 CIDR'
  );

  // 端到端：假装请求来自 Docker 网桥网关
  const real = net.clientAddress;
  try {
    net.clientAddress = () => '172.17.0.1';
    const blocked = await fetch(url('127.0.0.1', '/api/admin/me'));
    assert.equal(blocked.status, 403, '网关来源要默认拒绝（不能因为"看着像内网"就放）');
    const body = await blocked.json();
    assert.equal(body.error.code, 'admin_local_only');
    assert.equal(body.error.via, 'gateway');
    assert.match(body.error.message, /ADMIN_TRUSTED_PEERS/, '要把修法写在错误里');

    // 伪造 X-Forwarded-For 想冒充本机？没用
    const spoofed = await fetch(url('127.0.0.1', '/api/admin/me'), { headers: { 'x-forwarded-for': '127.0.0.1' } });
    assert.equal(spoofed.status, 403, '伪造 XFF 也不该放行');

    // /v1/* 不受影响（客户端面本来就要对外）
    const models = await fetch(url('127.0.0.1', '/openai/models'), { headers: { authorization: `Bearer ${ACCESS_KEY}` } });
    assert.equal(models.status, 200, '管理端闸只挡后台，客户端面照常');
  } finally {
    net.clientAddress = real;
  }
});

test('M8-9) ALLOW_PUBLIC_INTERNET 严格只认 true / false（大小写不敏感），其余 = 没配', async () => {
  // 后台那个「管理端限内网」开关已经删掉（用户 2026-09-13 要求），
  // 于是"公网能不能进后台"只剩这一个环境变量当出处 —— 它的解析规则必须钉死：
  // 写错一个字母（yes / 1 / TRUE 之外的花样）就等于"没配"，默认还是最安全的那一档。
  // 解析发生在 require 时，一个进程只能验一个值 → 每个值开一个子进程，结果落文件（沿用本文件其它子进程的写法）。
  const cases = [
    ['true', true, false],
    ['TRUE', true, false],
    [' True ', true, false],
    ['false', false, false],
    ['FALSE', false, false],
    ['yes', false, true],
    ['1', false, true],
    ['0', false, true],
    ['', false, false], // 空串 = 没配（不算"写错了"）
  ];
  for (const [raw, expected, expectsReject] of cases) {
    const outFile = path.join(tmpDir, `public-internet-${raw.trim() || 'empty'}.json`);
    const env = {
      ...process.env,
      PORT: '0',
      DB_PATH: path.join(tmpDir, 'child-public-internet.db'),
      OUT: outFile,
      LOG_LEVEL: 'error',
      APP_SECRET: 'm8-child-secret-0123456789abcdef0123456789',
    };
    if (raw === '') env.ALLOW_PUBLIC_INTERNET = '';
    else env.ALLOW_PUBLIC_INTERNET = raw;
    const code = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '-e',
          "const fs=require('fs');const c=require('./src/config');" +
            "fs.writeFileSync(process.env.OUT,JSON.stringify({v:c.adminPublicInternet,raw:c.adminPublicInternetRaw," +
            "rejected:(c.settingResolutions.ALLOW_PUBLIC_INTERNET||{}).rejected||[]}))",
        ],
        { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }
      );
      child.on('exit', (c) => resolve(c));
    });
    assert.equal(code, 0, `子进程应该正常退出（ALLOW_PUBLIC_INTERNET=${JSON.stringify(raw)}）`);
    const got = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.equal(
      got.v,
      expected,
      `ALLOW_PUBLIC_INTERNET=${JSON.stringify(raw)} 应该解析成 ${expected}，实际 ${got.v}`
    );
    assert.equal(
      got.rejected.length > 0,
      expectsReject,
      `ALLOW_PUBLIC_INTERNET=${JSON.stringify(raw)} 的"不认"记录不对：${JSON.stringify(got.rejected)}`
    );
  }

  // 完全不设这个变量（连空串都不是）：同样走内置默认 false
  const outFile = path.join(tmpDir, 'public-internet-unset.json');
  const env = {
    ...process.env,
    PORT: '0',
    DB_PATH: path.join(tmpDir, 'child-public-internet.db'),
    OUT: outFile,
    LOG_LEVEL: 'error',
    APP_SECRET: 'm8-child-secret-0123456789abcdef0123456789',
  };
  delete env.ALLOW_PUBLIC_INTERNET;
  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('fs');const c=require('./src/config');" +
          "fs.writeFileSync(process.env.OUT,JSON.stringify({v:c.adminPublicInternet,raw:c.adminPublicInternetRaw}))",
      ],
      { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }
    );
    child.on('exit', (c) => resolve(c));
  });
  assert.equal(code, 0);
  const got = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(got.v, false, '没配 → 内置默认 false');
  assert.equal(got.raw, null, '没配就没有"收到的原值"');
});
