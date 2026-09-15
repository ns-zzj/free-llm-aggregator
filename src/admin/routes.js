'use strict';

/**
 * 管理后台接口（全部挂在 /api/admin 下；除登录外都需要 session）
 */

const express = require('express');

const { db } = require('../db');
const config = require('../config');
const auth = require('../auth');
const logger = require('../logger');
const providersStore = require('../store/providers');
const providerModels = require('../store/providerModels');
const modelGroups = require('../store/modelGroups');
const accessKeys = require('../store/accessKeys');
const settings = require('../store/settings');
const sourceState = require('../store/sourceState');
const rateState = require('../store/rateState');
const timezone = require('../store/timezone');
const callLog = require('../store/callLog');
const adapter = require('../gateway/adapter');
const probe = require('../gateway/probe');

const router = express.Router();
const { HttpError } = providersStore;

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * 给模型条目算"运行时状态"，供后台展示：
 *   disabled      手动禁用
 *   error         故障（冷却中 / 已停用 / 额度耗尽）
 *   rate_limited  本地 rpm 限速中（同一提供商的模型共享同一个限速窗口）
 *   enabled       可用
 * 同时带上 rateEtaSeconds（限速剩余秒数）便于前端画倒计时。
 */
async function decorateModels(models, states, providers) {
  const stateByModel = new Map(states.map((s) => [`${s.providerId}::${s.modelId}`, s]));
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const rows = [];

  for (const model of models) {
    const provider = providerById.get(model.providerId);
    const state = stateByModel.get(`${model.providerId}::${model.modelId}`) || null;

    let rateLimited = false;
    let rateEtaSeconds = 0;
    let rateReason = '';
    if (provider) {
      const { limits, modelKey, learnedFallback } = rateState.effectiveLimits(provider, {
        rateOverride: model.rateOverride,
        localModelId: model.id,
      });
      // eslint-disable-next-line no-await-in-loop
      const peek = await rateState.peek({ providerId: model.providerId, modelKey, limits, learnedFallback });
      rateLimited = !peek.allowed;
      rateEtaSeconds = peek.etaMs ? Math.ceil(peek.etaMs / 1000) : 0;
      rateReason = peek.reason || '';
    }

    let runtimeStatus = 'enabled';
    if (!model.enabled) runtimeStatus = 'disabled';
    else if (state && ['cooldown', 'stopped', 'quota_exhausted'].includes(state.status)) runtimeStatus = 'error';
    else if (rateLimited) runtimeStatus = 'rate_limited';

    rows.push({ ...model, state, runtimeStatus, rateLimited, rateEtaSeconds, rateReason });
  }

  return rows;
}

/** 按提供商聚合出 [x/x 模型可用]（限速/故障/手动禁用都算不可用） */
function aggregateHealth(decorated) {
  const byProvider = new Map();
  for (const model of decorated) {
    if (!byProvider.has(model.providerId)) {
      byProvider.set(model.providerId, { modelsTotal: 0, modelsAvailable: 0, rateLimited: 0, erroring: 0, disabled: 0 });
    }
    const agg = byProvider.get(model.providerId);
    agg.modelsTotal += 1;
    if (model.runtimeStatus === 'enabled') agg.modelsAvailable += 1;
    else if (model.runtimeStatus === 'rate_limited') agg.rateLimited += 1;
    else if (model.runtimeStatus === 'error') agg.erroring += 1;
    else if (model.runtimeStatus === 'disabled') agg.disabled += 1;
  }
  for (const agg of byProvider.values()) {
    if (agg.modelsTotal === 0) agg.health = 'empty';
    else if (agg.modelsAvailable === agg.modelsTotal) agg.health = 'ok';
    else if (agg.modelsAvailable > 0) agg.health = 'partial';
    else agg.health = 'down';
  }
  return byProvider;
}

// --------------------------------------------------------------- 首次设置
//
// 啥也没有的时候（新装的、或者刚跑过 scripts/reset-credentials.js）：
// 服务照常起来，网页上显示「首次设置」页来收管理密码 + 下游 apikey。
// 安全闸：**只允许从本机/内网发起初始化** —— 不然谁先扫到这个端口谁就能把
// 管理密码占了，顺便拿到你全部上游 key。公网直连一律拒绝。
// 判定用 TCP 对端地址（见 src/net.js），**不信 X-Forwarded-For**（应用开了 trust proxy，
// 否则公网请求带个头就能把自己伪装成本机）。
const net = require('../net');
const csrf = require('../csrf');
const { createFailureGuard } = require('../limiter');

router.get('/setup/status', asyncHandler(async (req, res) => {
  const needsSetup = await settings.needsSetup();
  const access = net.checkAdminPeer(net.clientAddress(req), {
    forwardedFor: req.get('x-forwarded-for'),
    trustedPeers: config.adminTrustedPeers,
  });
  // 公网来源算不算放行：单一出处在 auth.publicSourceAllowed()（只看 ALLOW_PUBLIC_INTERNET）
  const allowedFromHere = access.ok || auth.publicSourceAllowed();
  // 只重置了管理密码的情况：已经有一条下游口令，设置页要把它显示成 sk-****（而不是让用户重填）
  const existingKey = needsSetup && allowedFromHere ? await accessKeys.primary() : null;
  res.json({
    needsSetup,
    allowedFromHere,
    // 管理端能不能从这里进。这条路由是唯一不被 requireLocalAdmin 挡的，专门用来把原因告诉前端。
    // （只有"来源可信 或 允许公网"两种可能，没有别的开关了，所以直接等于 allowedFromHere）
    adminAllowedHere: allowedFromHere,
    clientIp: net.clientAddress(req),
    hasAccessKey: !!(existingKey && existingKey.enabled),
    accessKeyMasked: existingKey && existingKey.enabled ? existingKey.masked || 'sk-********' : '',
    via: access.via,
    reason: needsSetup && !allowedFromHere ? `首次设置只允许从本机或内网直接发起：${access.reason}` : '',
  });
}));

// 跨站防线：放在最前面（setup 也在这条之后的路由里）。
// 审计 S1：/api/admin/setup 不需要 cookie，sameSite=lax 保护不到它，
// 而 express.urlencoded 让它能被跨站 <form> 直接打进来 —— 已实证。
router.use(csrf.csrfGuard);

// 管理端来源闸（放在 setup/status 之后：要么让上面那条把话说清楚，要么直接拦掉）
router.use(auth.requireLocalAdmin);

router.post('/setup', asyncHandler(async (req, res) => {
  if (!(await settings.needsSetup())) {
    throw new HttpError(409, '已经设置过了（要重来请执行 node scripts/reset-credentials.js）');
  }
  const access = net.checkAdminPeer(net.clientAddress(req), {
    forwardedFor: req.get('x-forwarded-for'),
    trustedPeers: config.adminTrustedPeers,
  });
  if (!access.ok && !auth.publicSourceAllowed()) {
    throw new HttpError(403, `首次设置只允许从本机或内网直接发起：${access.reason}`);
  }
  const body = req.body || {};
  const adminPassword = String(body.adminPassword || '');
  if (adminPassword.length < 6) throw new HttpError(400, '管理密码至少 6 位');

  await settings.setAdminPassword(adminPassword);

  // 下游口令：填了就换成它；留空 = 不动（已经有就沿用原来的，没有才自动生成一条）。
  // 「留空」绝不能被当成"换成随机新口令" —— 改管理密码时顺手把下游 key 换掉会连累所有客户端。
  //
  // 三种情况要**分开告诉前端**（用户 2026-09-15 报的 bug）：原来只回一个布尔
  // `accessKeyChanged`，"留空+已有→沿用"和"留空+没有→新生成"被混成同一个 false，
  // 于是首次设置页把刚生成的那条说成"沿用原来的"。
  const wanted = String(body.accessKey || '').trim();
  let key;
  let accessKeyAction;
  if (wanted) {
    key = await accessKeys.change(wanted);
    accessKeyAction = 'changed';
  } else {
    const existing = await accessKeys.primary();
    if (existing) {
      key = existing;
      accessKeyAction = 'kept';
    } else {
      key = await accessKeys.change('');
      accessKeyAction = 'generated';
    }
  }

  const token = auth.createSession();
  auth.setSessionCookie(res, token);
  logger.info('已完成首次设置', {
    ip: net.clientAddress(req),
    accessKeyId: key.id,
    accessKeyAction,
  });
  res.status(201).json({
    ok: true,
    accessKey: key.plaintext || key.key || null,
    accessKeyMasked: key.masked || '',
    accessKeyAction, // changed | kept | generated
    accessKeyChanged: accessKeyAction === 'changed', // 留着：别的调用方可能还在看这个布尔
  });
}));

// ------------------------------------------------------------------- 登录

/**
 * 登录失败限速（审计 M2）：按来源 IP 锁定，参数用 limiter 的默认值（用户 2026-09-15 定的）——
 * 连续失败 5 次锁 5 分钟，之后每再失败一次翻倍（1 小时封顶），24 小时没动静就忘掉，成功即解禁。
 * 客户端面（`/openai`、`/anthropic`）用的是同一套（见 src/app.js 的 v1FailureGuardMiddleware）。
 */
const loginGuard = createFailureGuard();

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const raw = String((req.body && req.body.password) || '');
    // 自动去掉首尾空格与零宽字符：手输/粘贴口令时很容易带上看不见的东西
    const password = raw.replace(/[\u200b-\u200d\ufeff]/g, '').trim();
    // 浏览器原生表单提交（JS 失效时的兜底路径）→ 用 302 跳转返回，而不是 JSON
    const isFormPost = String(req.headers['content-type'] || '').includes('form-urlencoded');
    const clientIp = net.clientAddress(req);

    const gate = loginGuard.check(clientIp);
    if (!gate.allowed) {
      res.set('retry-after', String(gate.retryAfterSeconds));
      logger.warn('登录被限速', { ip: clientIp, retryAfterSeconds: gate.retryAfterSeconds });
      const message = `尝试次数过多，请 ${gate.retryAfterSeconds} 秒后再试`;
      if (isFormPost) return res.redirect(302, `/admin?error=${encodeURIComponent(message)}`);
      throw new HttpError(429, message);
    }

    if (!password) {
      if (isFormPost) return res.redirect(302, `/admin?error=${encodeURIComponent('请输入管理口令')}`);
      throw new HttpError(400, '请输入管理口令');
    }

    const token = await auth.login(password);
    if (!token) {
      const gateAfter = loginGuard.fail(clientIp);
      // 只记录长度这类"形态"信息，**不记录口令指纹**（审计 L5：指纹+长度曾被拼进日志和跳转 URL，
      // 等于把手输口令的 SHA-256 前缀留在磁盘和浏览器历史里，没有任何排查价值）
      logger.warn('后台登录失败', {
        ip: clientIp,
        userAgent: req.get('user-agent') || '',
        formPost: isFormPost,
        receivedLength: password.length,
        rawLength: raw.length,
        hadWhitespace: raw !== raw.trim(),
        failures: gateAfter.failures,
        lockedSeconds: gateAfter.lockedSeconds,
      });
      const tail = gateAfter.lockedSeconds
        ? `尝试次数过多，已暂停 ${gateAfter.lockedSeconds} 秒。`
        : '若浏览器自动填充了旧密码，请用无痕窗口重试；';
      // 老版本的库：管理口令存的是 argon2 哈希，新版本读不出来（不会静默放行，但也进不去）
      const legacyHint =
        (await settings.passwordState()).state === 'legacy'
          ? '⚠ 这个库里的管理口令是旧版本存的格式（argon2 哈希），新版本读不出来 —— ' +
            '执行 node scripts/reset-credentials.js（Docker 里：docker exec nszzj-free-llm-aggregator node scripts/reset-credentials.js）' +
            '清空后重新设置即可。'
          : '';
      const message =
        `管理密码不正确（收到 ${password.length} 个字符）。${tail}${legacyHint}` +
        '忘了密码就执行 node scripts/reset-credentials.js（Docker 里：docker exec nszzj-free-llm-aggregator node scripts/reset-credentials.js），' +
        '清空后刷新本页即可重新设置。';
      if (isFormPost) return res.redirect(302, `/admin?error=${encodeURIComponent(message)}`);
      throw new HttpError(401, message);
    }

    loginGuard.succeed(clientIp);
    auth.setSessionCookie(res, token);
    if (isFormPost) return res.redirect(302, '/admin');
    return res.json({ ok: true });
  })
);

router.post('/logout', (req, res) => {
  const token = req.cookies ? req.cookies[auth.SESSION_COOKIE] : null;
  if (token) auth.destroySession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

router.get('/me', auth.requireAdmin, asyncHandler(async (req, res) => {
  const [accessKeyCount, providerCount, modelCount] = await Promise.all([
    accessKeys.count(),
    (await providersStore.list()).length,
    (await providerModels.listAll()).length,
  ]);
  res.json({ ok: true, accessKeyCount, providerCount, modelCount });
}));

// ------------------------------------------------------------------- 概览

/**
 * 「可用模型」怎么数（用户裁定 2026-09-12：**冷却中的照样算可用，故障的不算**）：
 *   可用   = 提供商启用 且 模型启用 且 状态不是 stopped
 *            （冷却中、额度用尽、本地限速都算可用 —— 它们会自己恢复）
 *   故障   = 状态 stopped（上游认证失败、模型名不存在这类"得人去改"的）
 *   已禁用 = 模型或提供商被手动关掉
 */
function countModelAvailability(decorated, providerList) {
  const providerEnabled = new Map(providerList.map((p) => [p.id, !!p.enabled]));
  const counts = { total: decorated.length, available: 0, cooling: 0, erroring: 0, disabled: 0, rateLimited: 0 };
  for (const model of decorated) {
    const status = (model.state && model.state.status) || '';
    if (!model.enabled || !providerEnabled.get(model.providerId)) {
      counts.disabled += 1;
      continue;
    }
    if (status === 'stopped') {
      counts.erroring += 1;
      continue;
    }
    counts.available += 1;
    if (status === 'cooldown' || status === 'quota_exhausted') counts.cooling += 1;
    else if (model.runtimeStatus === 'rate_limited') counts.rateLimited += 1;
  }
  return counts;
}

router.get(
  '/overview',
  auth.requireAdmin,
  asyncHandler(async (req, res) => {
    const [providerList, states, models, accessKeyCount, recentLogs] = await Promise.all([
      providersStore.list(),
      sourceState.listAll(),
      providerModels.listAll(),
      accessKeys.count(),
      callLog.recent({ limit: 30 }),
    ]);
    // 状态是模型级的；提供商行展示聚合结果（有一个模型能用就算"可用"）
    const validKeys = new Set(models.map((m) => `${m.providerId}::${m.modelId}`));
    const aggregates = await sourceState.aggregatesByProvider(validKeys);
    const decorated = await decorateModels(models, states, providerList);
    const health = aggregateHealth(decorated);
    // 「今日」的零点 = 后台设置里那个 UTC 偏移（默认 0 = UTC），和 rpd/tpd 日额度用同一个
    const dayStart = timezone.dayStart();

    const providersWithState = [];
    for (const provider of providerList) {
      const agg = aggregates.get(provider.id) || { status: 'available', reason: '', cooldownRemainingSeconds: 0, nextProbeAt: null, lastError: '' };
      const counts = health.get(provider.id) || { modelsTotal: 0, modelsAvailable: 0, rateLimited: 0, erroring: 0, disabled: 0, health: 'empty' };
      providersWithState.push({
        ...provider,
        modelCount: counts.modelsTotal,
        state: { ...agg, ...counts },
        // eslint-disable-next-line no-await-in-loop
        rate: await rateState.snapshot(provider),
      });
    }

    const today = await callLog.statsSince(dayStart);
    res.json({
      providers: providersWithState,
      models: decorated,
      stats: {
        // 今日数据（主页那排卡片）
        tzLabel: timezone.label(),
        dayStart,
        requestsToday: today.requests,
        failuresToday: today.failures,
        freeTokens: today.freeTokens,
        paidTokens: today.paidTokens,
        modelStats: countModelAvailability(decorated, providerList),
        // 保留：其他地方（脚本/文档）可能还在读
        callsToday: today.requests,
        accessKeyCount,
        providerCount: providerList.length,
        modelCount: models.length,
      },
      recentLogs,
    });
  })
);

// --------------------------------------------------------------- 提供商 CRUD

/**
 * 支持的**上游协议**清单（后台「提供商」表单那个下拉框用它）。
 * 唯一出处是适配器注册表（src/gateway/adapters/index.js）—— 前端以前自己抄了一份，
 * 结果是"后端加了协议、下拉框里没有"，所以改成从这里取。
 */
router.get('/adapters', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json({ adapters: adapter.describeAdapters() });
}));

router.get('/providers', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await providersStore.list());
}));

router.post('/providers', auth.requireAdmin, asyncHandler(async (req, res) => {
  const created = await providersStore.create(req.body || {});
  await sourceState.ensureForProvider(created.id);
  res.status(201).json(created);
}));

router.patch('/providers/:id', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await providersStore.update(req.params.id, req.body || {}));
}));

router.delete('/providers/:id', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await providersStore.remove(req.params.id));
}));

router.post('/providers/reorder', auth.requireAdmin, asyncHandler(async (req, res) => {
  const orderedIds = (req.body && req.body.orderedIds) || [];
  res.json(await providersStore.reorder(orderedIds));
}));

/** 手动恢复/停用来源状态（作用于该提供商下的所有模型） */
router.post('/providers/:id/state', auth.requireAdmin, asyncHandler(async (req, res) => {
  const status = String((req.body && req.body.status) || '');
  if (!['available', 'stopped'].includes(status)) throw new HttpError(400, 'status 只能是 available 或 stopped');
  if (status === 'available') {
    await sourceState.setStatusForProvider(req.params.id, 'available', { reason: null });
  } else {
    await sourceState.setStatusForProvider(req.params.id, 'stopped', { reason: '手动停用' });
  }
  res.json({ ok: true, states: await sourceState.listByProvider(req.params.id) });
}));

/** 立即探测该来源（不传 modelIds 时探测它下面所有启用的模型） */
router.post('/providers/:id/probe', auth.requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const result = await probe.probeProvider(req.params.id, {
    manual: true,
    modelIds: Array.isArray(body.modelIds) && body.modelIds.length ? body.modelIds : null,
  });
  res.json({ ...result, states: await sourceState.listByProvider(req.params.id) });
}));

/** 一键测试：按真实调用处理（占速率额度、写调用日志、失败按来源策略改状态） */
router.post('/providers/:id/test', auth.requireAdmin, asyncHandler(async (req, res) => {
  const modelId = String((req.body && req.body.modelId) || '').trim() || null;
  const result = await probe.testModel(req.params.id, modelId);
  if (result.notFound) throw new HttpError(404, result.message || '提供商不存在');
  res.json(result);
}));

// ------------------------------------------------------------------ 模型 CRUD

router.get('/providers/:id/models', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await providerModels.listByProvider(req.params.id));
}));

router.post('/providers/:id/models', auth.requireAdmin, asyncHandler(async (req, res) => {
  const created = await providerModels.create(req.params.id, req.body || {});
  // 补齐该提供商下所有模型的状态行，并清掉"还没模型时"留下的空行
  await sourceState.ensureForProvider(req.params.id);
  res.status(201).json(created);
}));

/** 全部模型条目（主页的"所有提供商的所有模型"列表，含禁用项 + 运行时状态） */
router.get('/models', auth.requireAdmin, asyncHandler(async (req, res) => {
  const [models, states, providers] = await Promise.all([
    providerModels.listAll(),
    sourceState.listAll(),
    providersStore.list(),
  ]);
  res.json(await decorateModels(models, states, providers));
}));

/** 「All模型顺序」页拖拽排序：所有模型条目统一排序（越靠上越优先） */
router.post('/models/reorder', auth.requireAdmin, asyncHandler(async (req, res) => {
  const orderedIds = (req.body && req.body.orderedIds) || [];
  res.json(await providerModels.reorder(orderedIds));
}));

router.patch('/models/:id', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await providerModels.update(Number(req.params.id), req.body || {}));
}));

router.delete('/models/:id', auth.requireAdmin, asyncHandler(async (req, res) => {
  const model = await db('provider_models').where({ id: Number(req.params.id) }).first();
  const removed = await providerModels.remove(Number(req.params.id));
  if (model) await sourceState.ensureForProvider(model.provider_id); // 清掉已删模型的状态行
  res.json(removed);
}));

// --------------------------------------------------------------- 模型组 CRUD

router.get('/model-groups', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await modelGroups.list());
}));

/** 新建（名字留空就给个「模型组N」的默认名，之后在框里随手改） */
router.post('/model-groups', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.status(201).json(await modelGroups.create(req.body || {}));
}));

/** 改名：后台那个输入框失焦即调它，没有"保存"按钮 */
router.patch('/model-groups/:id', auth.requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  res.json(await modelGroups.rename(Number(req.params.id), body.name));
}));

router.delete('/model-groups/:id', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await modelGroups.remove(Number(req.params.id)));
}));

/** 组里加一个模型（传 provider_models 的 id） */
router.post('/model-groups/:id/items', auth.requireAdmin, asyncHandler(async (req, res) => {
  const created = await modelGroups.addItem(Number(req.params.id), (req.body || {}).providerModelId);
  res.status(201).json(created);
}));

router.delete('/model-groups/:id/items/:itemId', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await modelGroups.removeItem(Number(req.params.id), Number(req.params.itemId)));
}));

/** 组内拖拽排序（和「All模型顺序」页同一套交互） */
router.post('/model-groups/:id/reorder', auth.requireAdmin, asyncHandler(async (req, res) => {
  const orderedIds = (req.body && req.body.orderedIds) || [];
  res.json(await modelGroups.reorderItems(Number(req.params.id), orderedIds));
}));

// ------------------------------------------------------------- 访问口令 CRUD

router.get('/access-keys', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await accessKeys.list());
}));

/**
 * 后台「密码」页用的那一条下游口令（取最早创建的启用口令）：
 * 返回掩码 + 明文（明文来自库里的密文解密，所以界面能一键复制）。
 * 老数据只存哈希 → key 为 null，界面会提示重新生成。
 */
router.get('/access-keys/primary', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await accessKeys.primary());
}));

/** 「更改 apikey」：换掉下游口令（删掉旧的、建新的），sk- 前缀会自动补上 */
router.post('/access-keys/change', auth.requireAdmin, asyncHandler(async (req, res) => {
  const changed = await accessKeys.change((req.body || {}).key);
  logger.info('已更换下游访问口令', { id: changed.id });
  res.json(changed);
}));

router.post('/access-keys', auth.requireAdmin, asyncHandler(async (req, res) => {
  const created = await accessKeys.create(req.body || {});
  logger.info('已创建访问口令', { id: created.id, name: created.name });
  res.status(201).json(created); // 含 plaintext（仅这一次）
}));

router.patch('/access-keys/:id', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await accessKeys.update(Number(req.params.id), req.body || {}));
}));

router.post('/access-keys/:id/rotate', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await accessKeys.rotate(Number(req.params.id)));
}));

router.delete('/access-keys/:id', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await accessKeys.remove(Number(req.params.id)));
}));

// ------------------------------------------------------------------- 设置

router.get('/settings', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(await settings.all());
}));

router.patch('/settings', auth.requireAdmin, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const allowed = [
    'allow_no_key',
    'fake_endpoints_enabled',
    'probe_max_attempts',
    'probe_backoff_seconds',
    'log_retention_days',
    'auto_context_tokens',
    'utc_offset_hours',
  ];
  for (const key of allowed) {
    if (body[key] === undefined) continue;
    const value = body[key];
    if (key === 'utc_offset_hours') {
      // 时区偏移：-12 ~ +14 小时，允许小数（5.5 = UTC+5:30）。改完立刻生效，不用重启。
      if (!timezone.isValidOffset(value)) {
        throw new HttpError(400, `时区偏移要在 ${timezone.MIN_OFFSET} ~ +${timezone.MAX_OFFSET} 小时之间（填 0 = UTC，8 = UTC+8）`);
      }
      // eslint-disable-next-line no-await-in-loop
      await settings.set(key, String(value));
      timezone.setOffsetHours(value);
      continue;
    }
    if (key === 'probe_backoff_seconds') {
      // 退避表：正整数数组，1 ~ 20 段
      const probeSchedule = require('../store/probeSchedule');
      const arr = Array.isArray(value) ? value : probeSchedule.parse(value);
      if (!Array.isArray(value)) throw new HttpError(400, 'probe_backoff_seconds 需要是数组');
      if (value.length === 0 || value.length > probeSchedule.MAX_ROWS) {
        throw new HttpError(400, `倒计时检测时长需要 1 ~ ${probeSchedule.MAX_ROWS} 段`);
      }
      const cleaned = value.map((n) => Number(n));
      if (cleaned.some((n) => !Number.isFinite(n) || n <= 0)) {
        throw new HttpError(400, '每一段都必须是大于 0 的秒数');
      }
      // eslint-disable-next-line no-await-in-loop
      await settings.set(key, JSON.stringify(cleaned.map((n) => Math.round(n))));
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await settings.set(key, typeof value === 'boolean' ? String(value) : String(value));
  }
  res.json(await settings.all());
}));

router.post('/settings/admin-password', auth.requireAdmin, asyncHandler(async (req, res) => {
  const { current, next } = req.body || {};
  res.json(await settings.changeAdminPassword(current, next));
}));

// ------------------------------------------------------------------- 日志

router.get('/logs', auth.requireAdmin, asyncHandler(async (req, res) => {
  res.json(
    await callLog.recent({
      limit: req.query.limit,
      providerId: req.query.providerId,
      status: req.query.status,
      model: req.query.model,
    })
  );
}));

module.exports = router;

// 统一错误处理（放在 app.js 里接住 HttpError）
module.exports.HttpError = HttpError;
