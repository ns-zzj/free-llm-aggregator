'use strict';

/**
 * 来源状态机 —— **按 (提供商, 上游模型) 独立维护**。
 *
 * 为什么按模型而不是按提供商：同一个提供商下不同模型的额度/限流往往各自独立
 * （ModelScope 上这个模型用完了、同家另一个还正常），按提供商标记会把好模型一起拖下水。
 *
 * 状态：
 *  - available        可用
 *  - cooldown         冷却中（策略=倒计时检测；到期后由探测任务确认是否恢复）
 *  - stopped          已停用（策略=停用不检测，或认证类错误；需人工恢复）
 *  - quota_exhausted  额度用尽（等重置；目前主要走 cooldown + 探测）
 */

const { db } = require('../db');
const probeSchedule = require('./probeSchedule');

function now() {
  return Date.now();
}

function toApi(row) {
  if (!row) return null;
  const cooldownUntil = row.cooldown_until || null;
  return {
    providerId: row.provider_id,
    providerName: row.provider_name,
    modelId: row.model_id || '',
    status: row.status,
    reason: row.reason || '',
    cooldownUntil,
    cooldownRemainingSeconds:
      row.status === 'cooldown' && cooldownUntil && cooldownUntil > now()
        ? Math.ceil((cooldownUntil - now()) / 1000)
        : 0,
    nextProbeAt: row.next_probe_at || null,
    probeAttempts: row.probe_attempts || 0,
    consecutiveFailures: row.consecutive_failures || 0,
    lastError: row.last_error || '',
    lastSuccessAt: row.last_success_at || null,
    updatedAt: row.updated_at || null,
  };
}

async function ensure(providerId, modelId = '') {
  const key = { provider_id: providerId, model_id: modelId || '' };
  let row = await db('source_state').where(key).first();
  if (!row) {
    await db('source_state').insert({ ...key, status: 'available', consecutive_failures: 0, updated_at: now() });
    row = await db('source_state').where(key).first();
  }
  return row;
}

async function get(providerId, modelId = '') {
  return toApi(await ensure(providerId, modelId));
}

/** 该提供商下所有模型的状态行 */
async function listByProvider(providerId) {
  const rows = await db('source_state').where({ provider_id: providerId }).orderBy('model_id', 'asc');
  return rows.map(toApi);
}

async function listAll() {
  const rows = await db('source_state as s')
    .join('providers as p', 'p.id', 's.provider_id')
    .select('s.*', 'p.name as provider_name')
    .orderBy('p.sort_order', 'asc')
    .orderBy('s.model_id', 'asc');
  return rows.map(toApi);
}

/** 为某提供商下所有已配置模型补状态行（新加模型 / 启动时用） */
async function ensureForProvider(providerId) {
  const models = await db('provider_models').where({ provider_id: providerId }).select('model_id');
  if (models.length === 0) {
    await ensure(providerId, '');
    return;
  }
  for (const model of models) {
    // eslint-disable-next-line no-await-in-loop
    await ensure(providerId, model.model_id);
  }
  // 模型删掉后残留的状态行清掉（不影响任何东西，但别留着误导）
  const keep = models.map((m) => m.model_id);
  await db('source_state').where({ provider_id: providerId }).whereNotIn('model_id', keep).andWhere('model_id', '!=', '').del();
}

async function markSuccess(providerId, modelId = '') {
  await ensure(providerId, modelId);
  const ts = now();
  await db('source_state').where({ provider_id: providerId, model_id: modelId || '' }).update({
    status: 'available',
    reason: null,
    cooldown_until: null,
    next_probe_at: null,
    consecutive_failures: 0,
    probe_attempts: 0, // 探测成功 → 计数清零
    last_success_at: ts,
    updated_at: ts,
  });
}

/** 探测失败时调用：累计"连续探测失败次数"，返回累计值 */
async function bumpProbeAttempts(providerId, modelId = '') {
  await ensure(providerId, modelId);
  const key = { provider_id: providerId, model_id: modelId || '' };
  const row = await db('source_state').where(key).first();
  const next = (row && row.probe_attempts ? row.probe_attempts : 0) + 1;
  await db('source_state').where(key).update({ probe_attempts: next, updated_at: now() });
  return next;
}

/**
 * 记录一次失败，并按策略决定该 (提供商, 模型) 的新状态。
 * @param {object} opts { policy, cooldownSeconds, reason, errorType, forcePolicy }
 */
async function markFailure(providerId, modelId = '', opts = {}) {
  await ensure(providerId, modelId);
  const key = { provider_id: providerId, model_id: modelId || '' };
  const row = await db('source_state').where(key).first();
  const ts = now();
  const failures = (row?.consecutive_failures || 0) + 1;
  const policy = opts.forcePolicy || opts.policy || 'cooldown_probe';
  const data = {
    consecutive_failures: failures,
    last_error: `${opts.errorType || 'error'}: ${opts.reason || ''}`.slice(0, 500),
    updated_at: ts,
  };

  if (policy === 'keep_trying') {
    data.status = 'available';
    data.reason = null;
    data.cooldown_until = null;
    data.next_probe_at = null;
  } else if (policy === 'stop_manual') {
    data.status = 'stopped';
    data.reason = opts.reason || '已停用（需人工启用）';
    data.cooldown_until = null;
    data.next_probe_at = null;
  } else {
    // 等待时长：优先用调用方给的（本地闸门等场景），否则取退避表的第一段
    const seconds =
      Number(opts.cooldownSeconds) > 0 ? Number(opts.cooldownSeconds) : await probeSchedule.nextWaitSeconds(0);
    const until = ts + seconds * 1000;
    data.status = 'cooldown';
    data.reason = opts.reason || `冷却中（${seconds}s 后可探测）`;
    data.cooldown_until = until;
    data.next_probe_at = until;
  }

  await db('source_state').where(key).update(data);
  return toApi(await db('source_state').where(key).first());
}

async function setStatus(providerId, modelId, status, { reason = null } = {}) {
  await ensure(providerId, modelId);
  const patch = { status, reason, updated_at: now() };
  if (status !== 'cooldown') {
    patch.cooldown_until = null;
    patch.next_probe_at = null;
  }
  if (status === 'available') {
    patch.probe_attempts = 0; // 手动恢复/恢复成功 → 重新开始计数
  }
  await db('source_state').where({ provider_id: providerId, model_id: modelId || '' }).update(patch);
  return get(providerId, modelId);
}

/** 提供商级操作（后台"恢复可用/手动停用"）：作用于它下面的所有模型 */
async function setStatusForProvider(providerId, status, { reason = null } = {}) {
  await ensureForProvider(providerId);
  const models = await db('provider_models').where({ provider_id: providerId }).select('model_id');
  const targets = models.length ? models.map((m) => m.model_id) : [''];
  for (const modelId of targets) {
    // eslint-disable-next-line no-await-in-loop
    await setStatus(providerId, modelId, status, { reason });
  }
  return listByProvider(providerId);
}

/**
 * 此刻该模型是否可用。
 * 冷却中的模型即使冷却时间已到，也要等探测确认恢复（status 变回 available）才算可用——
 * 这样"冷却到期 → 探测 → 成功才恢复"的语义在路由里也是一致的。
 */
async function isAvailable(providerId, modelId = '') {
  const row = await ensure(providerId, modelId);
  return row.status === 'available';
}

/** 冷却到期但尚未探测确认的模型（探测任务会消费这些） */
async function dueForProbe(limit = 10) {
  return db('source_state')
    .where({ status: 'cooldown' })
    .andWhere('cooldown_until', '<=', now())
    .limit(limit);
}

/**
 * 按提供商聚合（后台列表用）：只要有一个模型可用就算"可用"。
 * @param {Set<string>} validKeys 可选的 "providerId::modelId" 集合；
 *   传了它就会**忽略不在集合里的状态行**（例如提供商还没模型时留下的 model_id='' 空行）
 */
async function aggregatesByProvider(validKeys = null) {
  const states = await listAll();
  const grouped = new Map();
  for (const state of states) {
    if (validKeys && !validKeys.has(`${state.providerId}::${state.modelId}`)) continue;
    if (!grouped.has(state.providerId)) {
      grouped.set(state.providerId, {
        providerId: state.providerId,
        providerName: state.providerName,
        status: 'available',
        reason: '',
        cooldownRemainingSeconds: 0,
        nextProbeAt: null,
        lastError: '',
        modelsTotal: 0,
        modelsAvailable: 0,
      });
    }
    const agg = grouped.get(state.providerId);
    agg.modelsTotal += 1;
    if (state.nextProbeAt && (!agg.nextProbeAt || state.nextProbeAt < agg.nextProbeAt)) {
      agg.nextProbeAt = state.nextProbeAt;
    }
    // 只有探测确认恢复（status=available）才算可用：
    // "冷却到期但还没探测"不算恢复，否则界面会提前显示可用
    const available = state.status === 'available';
    if (available) agg.modelsAvailable += 1;
    if (!available) {
      // 记录"最需要关注"的状态用于展示：冷却优先（会自动恢复），其次停用
      const priority = { cooldown: 3, quota_exhausted: 4, stopped: 2 };
      const currentPriority = agg.status === 'available' ? 0 : { cooldown: 3, quota_exhausted: 4, stopped: 2 }[agg.status] || 1;
      const nextPriority = priority[state.status] || 1;
      if (nextPriority > currentPriority) {
        agg.status = state.status;
        agg.reason = state.reason;
        agg.cooldownRemainingSeconds = state.cooldownRemainingSeconds;
      }
      if (!agg.lastError && state.lastError) agg.lastError = state.lastError;
    }
  }
  for (const agg of grouped.values()) {
    if (agg.modelsAvailable > 0) {
      agg.status = 'available';
      agg.reason = '';
      agg.cooldownRemainingSeconds = 0;
    }
  }
  return grouped;
}

module.exports = {
  toApi,
  ensure,
  ensureForProvider,
  get,
  listByProvider,
  listAll,
  aggregatesByProvider,
  markSuccess,
  bumpProbeAttempts,
  markFailure,
  setStatus,
  setStatusForProvider,
  isAvailable,
  dueForProbe,
};
