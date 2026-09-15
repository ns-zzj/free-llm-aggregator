'use strict';

const config = require('./config');
const logger = require('./logger');
const net = require('./net');
const cryptoUtil = require('./crypto');
const { db, migrate } = require('./db');
const settings = require('./store/settings');
const accessKeys = require('./store/accessKeys');
const providersStore = require('./store/providers');
const sourceState = require('./store/sourceState');
const timezone = require('./store/timezone');
const callLog = require('./store/callLog');
const auth = require('./auth');
const probe = require('./gateway/probe');
const { createApp } = require('./app');

const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;
// 探测循环的"醒来"间隔：每秒看一次有没有到点该重测的模型。
// 具体重测时刻由每个模型的 cooldown_until（来源上的"冷却秒数"）决定，没有全局间隔设置。
const PROBE_TICK_MS = Number(process.env.PROBE_TICK_MS) > 0 ? Number(process.env.PROBE_TICK_MS) : 1000;

/**
 * 监听 HTTP —— 默认**双栈**（`::`）：一个端口同时接受 IPv4 与 IPv6。
 *
 * 用户 2026-09-12 的要求：服务器有 IPv6 地址，网页后台和 API 调用都要能走 IPv6。
 * `::` 在 Linux/Windows 上默认就是"双栈"（不设 IPV6_V6ONLY），IPv4 客户端会被记成
 * `::ffff:x.x.x.x`（IPv4-mapped）—— src/net.js 的判定认这种写法，所以管理端的限内网闸
 * 不会因为走 IPv4 就把局域网用户挡在外面。
 *
 * BIND 的语义：
 *   留空 或 `0.0.0.0` → **所有地址**：先试双栈 `::`（IPv4 也照样进得来），
 *                        这台机器没有 IPv6 就自动退回 `0.0.0.0`
 *   其它具体地址      → **就只监听它**（`127.0.0.1` 只本机、`::1` 只 IPv6 环回……），
 *                        绑不上就报错退出 —— 用户写死的地址不能被悄悄换掉
 *
 * 已知取舍：没有"所有 IPv4 但不要 IPv6"这种组合。实际影响很小：从 IPv6 进来的公网客户端
 * 本来就会被管理端来源闸挡在后台之外，真要拦网络层用防火墙即可。
 */
function bindCandidates() {
  const raw = config.bind;
  if (!raw || raw === '0.0.0.0') return ['::', '0.0.0.0'];
  return [raw];
}

async function listenHttp(app) {
  const candidates = bindCandidates();
  const wantsAny = !config.bind || config.bind === '0.0.0.0';
  let lastError = null;
  for (const host of candidates) {
    const server = app.listen(config.port, host);
    try {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
      return { server, host, dualStack: host === '::', wantsAny, fallback: wantsAny && host !== '::' };
    } catch (err) {
      lastError = err;
      server.close();
      if (candidates.length > 1) {
        logger.warn('监听地址绑定失败，退回下一个', { host, error: err.message });
      }
    }
  }
  throw lastError || new Error('无法监听端口');
}

/** 首次启动：用环境变量 ACCESS_KEY 创建一个访问口令（没有则提示） */
async function ensureAccessKey() {
  if ((await accessKeys.count()) > 0) {
    // 有"解不开"的口令（0010 之前的老数据，或者 APP_SECRET 换过）→ 那种行已经没法校验了，提示换一条
    const unusable = await accessKeys.countUnusable();
    if (unusable > 0) {
      logger.warn(
        `有 ${unusable} 条下游口令无法还原（老版本只存过哈希，或 APP_SECRET 换过）—— 它们校验不过，` +
          '等于失效了。去后台「密码」页点「更改 apikey」换一条新的。'
      );
    }
    // 库里已经有凭据 → 环境变量那两个明文就不再需要（提醒一次，别让它一直躺在那儿）
    const leftovers = ['ACCESS_KEY', 'ADMIN_PASSWORD'].filter((name) => String(process.env[name] || '').trim());
    if (leftovers.length) {
      logger.warn(
        `${leftovers.join(' / ')} 还设着，但已经用不上了（库里已有凭据，只在首次启动时会读它们）：` +
          `建议把它们从 ${config.envFileName} / compose 的环境变量里删掉，凭据以库为准` +
          '（下游口令在后台「密码」页可看可改）。'
      );
    }
    return;
  }
  const envKey = String(process.env.ACCESS_KEY || '').trim();
  if (envKey) {
    const created = await accessKeys.create({
      name: 'bootstrap（来自 ACCESS_KEY 环境变量）',
      key: envKey,
      notes: '首次启动自动创建；之后可在后台「密码」页查看/更换',
    });
    logger.info(`已用环境变量 ACCESS_KEY 创建访问口令（id=${created.id}）`);
    return;
  }
  logger.warn(
    '当前没有任何访问口令：/v1/* 会拒绝所有请求。请在后台「密码」页设置一个，或设置 ACCESS_KEY 环境变量后重启。'
  );
}

/** 为每个提供商（及其每个模型）补齐状态行（后台才能显示"可用/冷却/停用"） */
async function ensureSourceStates() {
  const list = await providersStore.list();
  for (const provider of list) {
    // eslint-disable-next-line no-await-in-loop
    await sourceState.ensureForProvider(provider.id);
  }
}

async function housekeeping() {
  auth.cleanupSessions();
  const days = (await settings.getNumber('log_retention_days')) || 30;
  const deleted = await callLog.prune(days * 24 * 60 * 60 * 1000);
  if (deleted) logger.info(`清理过期调用日志 ${deleted} 条`);
}

async function bootstrap() {
  // 0) 先把"每个配置值从哪来"打出来：环境变量 / normal.env / 内置默认，各是哪一层；
  //    还有"文件里写了却被环境变量盖掉"的提醒 —— 排查问题不用猜（用户 2026-09-13 的要求）。
  logger.info(
    `配置来源（优先级：环境变量 > ${config.envFileName} > 内置默认）：\n` +
      config.describeConfigSources().join('\n')
  );

  // 1) 加密模块。主密钥来源见 src/appSecret.js：环境变量 / normal.env → 数据目录 → 自动生成并落盘
  await cryptoUtil.init();
  const secretOrigin = config.describeAppSecretOrigin();
  if (config.appSecretSource === 'ephemeral') {
    logger.warn(`凭据加密主密钥：${secretOrigin}`);
  } else {
    logger.info(`凭据加密主密钥：${secretOrigin}`);
  }
  if (config.appSecretNote) logger.warn(config.appSecretNote);

  // 2) 数据库迁移（把没跑过的建表脚本补上）
  const { applied } = await migrate();
  if (applied.length) logger.info(`数据库迁移完成：${applied.length} 个脚本`, { applied });

  // 3) 首次启动的管理口令 + 访问口令 + 来源状态
  const adminPassword = await settings.ensureAdminPasswordFromEnv(config.adminPassword);
  if (adminPassword.created) logger.info('已用 ADMIN_PASSWORD 初始化管理口令');
  if (adminPassword.legacy) {
    // 从旧版本升级上来的库：管理口令以前存的是 argon2 哈希，现在读不出来了。
    // **不**自动当成"没设过"（那等于把后台白送给内网第一个打开它的人），所以这里必须吵到用户看见。
    logger.error(
      '⚠ 库里的管理口令是旧版本存的格式（argon2 哈希），新版本已经读不出来 —— ' +
        '后台现在谁也登不进去（不是坏了，是防止静默放行）。' +
        '处理办法：执行 node scripts/reset-credentials.js（Docker 里：docker exec nszzj-free-llm-aggregator node scripts/reset-credentials.js），' +
        '然后在 /admin 重新设置管理密码和下游 apikey。'
    );
  }
  if (config.adminTrustedPeers.length) {
    logger.warn(
      `ADMIN_TRUSTED_PEERS 设了 ${config.adminTrustedPeers.length} 项（${config.adminTrustedPeers.join(', ')}）：` +
        '来自这些地址的请求会**一律放行**后台；另外带了 X-Forwarded-For 的请求，头里的地址命中名单也会放行。' +
        '⚠ X-Forwarded-For 是客户端可以自己写的头 —— 这条规则安全的前提是"外面绕不过你的代理、没法直连本服务"。'
    );
  }
  if (config.adminPublicInternet === true) {
    logger.warn(
      'ALLOW_PUBLIC_INTERNET=true（已认）→ 公网可以直接访问后台。' +
        '**前提是前面有 TLS**（反代 / Cloudflare Tunnel）—— 否则管理口令和会话 cookie 会明文过网，跟没设防一样。' +
        (adminPassword.needsSetup
          ? '  ⚠ 而且现在还没设置管理密码：谁先访问 /admin 谁就能把密码占了，请尽快完成「首次设置」。'
          : '')
    );
  }
  // 「给了值但不认」的一律单独吵一声（用户要求：认了啥 / 不认（默认用的啥）都要能看见）。
  // 具体用的是哪一层的值，看开头那张配置来源表。
  for (const [key, r] of Object.entries(config.settingResolutions || {})) {
    if (!r.rejected.length) continue;
    const settled = { env: '环境变量', file: `${config.envFileName} 文件`, default: '内置默认' }[r.from];
    logger.warn(
      `${key} 收到的值不认：${r.rejected.map((x) => `「${x.raw}」`).join(' / ')} —— 要求是${r.hint}。` +
        `已忽略，改用它下面那一层的值（当前用的是：${settled}）。`
    );
  }
  await ensureAccessKey();
  await ensureSourceStates();
  // 时区（UTC 偏移）：管"今日"统计与 rpd/tpd 日额度的零点，启动读一次进内存；后台改完立刻生效
  const offsetHours = await timezone.loadOffsetHours();
  logger.info(
    `时区：${offsetHours === 0 ? 'UTC（默认，卡片上不加后缀）' : timezone.label()}（后台「设置」页可改）`
  );

  // 4) 启动 HTTP 服务
  const app = createApp();
  const { server, host, dualStack, fallback } = await listenHttp(app);
  const urlHost = net.hostForUrl(host);
  logger.info(
    `服务已启动：http://${urlHost}:${config.port}/v1 （管理后台 http://${urlHost}:${config.port}/admin ）`,
    {
      bind: host,
      dualStack,
      ipv6: dualStack ? `http://[::1]:${config.port}` : null,
      note: fallback ? `这台机器绑不上 :: （可能没启用 IPv6），退回只监听 IPv4` : null,
    }
  );

  const timer = setInterval(() => {
    housekeeping().catch((err) => logger.error('定时任务异常', { error: err.message }));
  }, HOUSEKEEPING_INTERVAL_MS);
  timer.unref();
  housekeeping().catch(() => {});

  // 倒计时探测循环：每秒醒一次，把"冷却已到期"的模型逐个探测
  let probing = false;
  const probeTimer = setInterval(async () => {
    if (probing) return;
    probing = true;
    try {
      const results = await probe.runProbeCycle();
      for (const result of results) {
        if (result.ok) {
          logger.info('来源探测恢复', {
            provider: result.providerId,
            modelId: result.modelId,
            latencyMs: result.latencyMs,
          });
        }
      }
    } catch (err) {
      logger.error('探测循环异常', { error: err.message });
    } finally {
      probing = false;
    }
  }, PROBE_TICK_MS);
  probeTimer.unref();
  // 服务关掉后（比如测试里 close 掉、或正常退出）就别再跑定时任务了
  server.on('close', () => {
    clearInterval(timer);
    clearInterval(probeTimer);
  });

  const shutdown = async (signal) => {
    logger.info(`收到 ${signal}，正在退出…`);
    clearInterval(timer);
    clearInterval(probeTimer);
    server.close();
    try {
      await db.destroy();
    } catch (err) {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error(`启动失败：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { bootstrap, housekeeping };
