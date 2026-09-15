'use strict';

/**
 * 速率准入（"速率填写框"的落地）：
 *  - rpm        → 漏桶平滑（gap = 60s / N），避免突发把限流撞出来
 *  - tpm/tpd/rpd → 计数闸门（用满即停，窗口重置后恢复）
 *  - concurrency → 进程内并发计数
 *  - value = 0 或未填 → 不做本地限制
 * 429 时用 Retry-After 把下一次可用时刻往后推（校准）。
 */

const { db } = require('../db');
const timezone = require('./timezone');

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const WINDOW_DEFS = {
  rpm: { mode: 'pace', windowMs: MINUTE_MS, unit: 'requests' },
  tpm: { mode: 'count', windowMs: MINUTE_MS, unit: 'tokens' },
  rpd: { mode: 'count', windowMs: DAY_MS, unit: 'requests' },
  tpd: { mode: 'count', windowMs: DAY_MS, unit: 'tokens' },
  concurrency: { mode: 'concurrency' },
};

/** 并发计数（进程内即可，单实例假设） */
const activeCounters = new Map();

function counterKey(providerId) {
  return String(providerId);
}

/**
 * 窗口起点：分钟窗口用滚动分钟，日窗口用**应用配置的时区**切自然日。
 * 日窗口的重置时刻和主页「今日」的统计口径必须是同一个零点，所以都走 timezone.dayStart()
 * （以前这里用的是进程本地时区，见 src/store/timezone.js 的说明）。
 */
function windowStartFor(kind, ts) {
  return kind === 'rpd' || kind === 'tpd' ? timezone.dayStart(ts) : Math.floor(ts / MINUTE_MS) * MINUTE_MS;
}

/** 解析该 (provider, model) 实际生效的速率配置 */
function effectiveLimits(provider, candidate) {
  if (candidate && Array.isArray(candidate.rateOverride) && candidate.rateOverride.length) {
    return { limits: candidate.rateOverride, modelKey: String(candidate.localModelId) };
  }
  return { limits: (provider && provider.rateLimits) || [], modelKey: '' };
}

function normalizeLimits(limits) {
  if (!Array.isArray(limits)) return [];
  return limits
    .map((item) => ({
      kind: String((item && item.kind) || '').toLowerCase(),
      value: Number(item && item.value),
    }))
    .filter((item) => WINDOW_DEFS[item.kind] && Number.isFinite(item.value) && item.value > 0);
}

async function getRow(providerId, modelKey, kind) {
  return db('rate_state').where({ provider_id: providerId, model_id: modelKey, window_kind: kind }).first();
}

async function ensureRow(providerId, modelKey, kind) {
  let row = await getRow(providerId, modelKey, kind);
  const ts = Date.now();
  if (!row) {
    await db('rate_state').insert({
      provider_id: providerId,
      model_id: modelKey,
      window_kind: kind,
      used: 0,
      window_start: windowStartFor(kind, ts),
      next_slot_at: 0,
      quota_used: 0,
      updated_at: ts,
    });
    row = await getRow(providerId, modelKey, kind);
  }
  return row;
}

/** 只判断能不能发（不消耗额度）—— 选源阶段用 */
async function peek({ providerId, modelKey = '', limits }) {
  const list = normalizeLimits(limits);
  if (list.length === 0) return { allowed: true, etaMs: 0, reason: '' };

  const ts = Date.now();
  let etaMs = 0;
  let reason = '';

  for (const { kind, value } of list) {
    const def = WINDOW_DEFS[kind];
    if (def.mode === 'concurrency') {
      const active = activeCounters.get(counterKey(providerId)) || 0;
      if (active >= value) {
        reason = reason || `并发已满（${active}/${value}）`;
      }
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const row = await ensureRow(providerId, modelKey, kind);

    if (def.mode === 'pace') {
      const gap = def.windowMs / value;
      const nextSlotAt = Number(row.next_slot_at || 0);
      if (ts < nextSlotAt) {
        const wait = nextSlotAt - ts;
        if (wait > etaMs) etaMs = wait;
        reason = reason || `${kind} 限速（每 ${Math.round(gap)}ms 一个）`;
      }
      continue;
    }

    // count 模式：窗口内用满即停
    const start = Number(row.window_start || 0);
    const windowStart = windowStartFor(kind, ts);
    const used = start === windowStart ? Number(row.used || 0) : 0;
    if (used >= value) {
      const resetAt = windowStart + def.windowMs;
      const wait = Math.max(0, resetAt - ts);
      if (wait > etaMs) etaMs = wait;
      reason = reason || `${kind} 额度已用满（${used}/${value}）`;
    }
  }

  return { allowed: !reason, etaMs, reason };
}

/** 申请放行：通过则消耗额度，返回 lease（并发型需要 release） */
async function admit({ providerId, modelKey = '', limits }) {
  const list = normalizeLimits(limits);
  if (list.length === 0) return { allowed: true, etaMs: 0, reason: '', release() {} };

  const check = await peek({ providerId, modelKey, limits: list });
  if (!check.allowed) return { ...check, release() {} };

  const ts = Date.now();
  const touched = new Set();

  for (const { kind, value } of list) {
    const def = WINDOW_DEFS[kind];
    if (def.mode === 'concurrency') {
      const key = counterKey(providerId);
      activeCounters.set(key, (activeCounters.get(key) || 0) + 1);
      touched.add(key);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const row = await ensureRow(providerId, modelKey, kind);
    const windowStart = windowStartFor(kind, ts);
    const patch = { updated_at: ts };

    if (def.mode === 'pace') {
      const gap = def.windowMs / value;
      const base = Math.max(ts, Number(row.next_slot_at || 0));
      patch.next_slot_at = Math.round(base + gap);
      patch.used = (Number(row.window_start || 0) === windowStart ? Number(row.used || 0) : 0) + 1;
      patch.window_start = windowStart;
    } else {
      patch.used = (Number(row.window_start || 0) === windowStart ? Number(row.used || 0) : 0) + 1;
      patch.window_start = windowStart;
    }
    // eslint-disable-next-line no-await-in-loop
    await db('rate_state').where({ provider_id: providerId, model_id: modelKey, window_kind: kind }).update(patch);
  }

  return {
    allowed: true,
    etaMs: 0,
    reason: '',
    release() {
      const key = counterKey(providerId);
      if (!touched.has(key)) return;
      const active = activeCounters.get(key) || 0;
      activeCounters.set(key, Math.max(0, active - 1));
    },
  };
}

/** 记 token 消耗（tpm/tpd 的计数闸门用） */
async function noteTokens({ providerId, modelKey = '', limits, tokens }) {
  const amount = Number(tokens);
  if (!Number.isFinite(amount) || amount <= 0) return;
  for (const { kind } of normalizeLimits(limits)) {
    if (!['tpm', 'tpd'].includes(kind)) continue;
    // eslint-disable-next-line no-await-in-loop
    const row = await ensureRow(providerId, modelKey, kind);
    const ts = Date.now();
    const windowStart = windowStartFor(kind, ts);
    const base = Number(row.window_start || 0) === windowStart ? Number(row.quota_used || 0) : 0;
    // eslint-disable-next-line no-await-in-loop
    await db('rate_state')
      .where({ provider_id: providerId, model_id: modelKey, window_kind: kind })
      .update({ quota_used: Math.round(base + amount), window_start: windowStart, updated_at: ts });
  }
}

/** 上游 429：把下一次可用时刻往后推（校准），额度类不在这里处理（交给状态机+探测） */
async function noteRateLimited({ providerId, modelKey = '', limits, retryAfterMs }) {
  const list = normalizeLimits(limits).filter((item) => WINDOW_DEFS[item.kind].mode === 'pace');
  if (list.length === 0) return;
  const ts = Date.now();
  for (const { kind } of list) {
    // eslint-disable-next-line no-await-in-loop
    const row = await ensureRow(providerId, modelKey, kind);
    const wait = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : MINUTE_MS;
    const nextSlotAt = Math.max(Number(row.next_slot_at || 0), ts + wait);
    // eslint-disable-next-line no-await-in-loop
    await db('rate_state')
      .where({ provider_id: providerId, model_id: modelKey, window_kind: kind })
      .update({ next_slot_at: Math.round(nextSlotAt), updated_at: ts });
  }
}

/** 后台展示用：某来源当前的速率/额度状态 */
async function snapshot(provider) {
  const limits = (provider && provider.rateLimits) || [];
  const rows = await db('rate_state').where({ provider_id: provider.id, model_id: '' });
  const byKind = new Map(rows.map((row) => [row.window_kind, row]));
  const ts = Date.now();

  return limits.map((limit) => {
    const kind = String(limit.kind || '').toLowerCase();
    const def = WINDOW_DEFS[kind];
    if (!def) return { kind, value: limit.value };
    if (def.mode === 'concurrency') {
      return {
        kind,
        value: limit.value,
        mode: 'concurrency',
        active: activeCounters.get(counterKey(provider.id)) || 0,
      };
    }
    const row = byKind.get(kind);
    const windowStart = windowStartFor(kind, ts);
    const used = row && Number(row.window_start || 0) === windowStart ? Number(row.used || 0) : 0;
    const quotaUsed = row && Number(row.window_start || 0) === windowStart ? Number(row.quota_used || 0) : 0;
    return {
      kind,
      value: limit.value,
      mode: def.mode,
      used,
      quotaUsed,
      nextSlotAt: row ? Number(row.next_slot_at || 0) : 0,
      nextSlotInSeconds: row && row.next_slot_at > ts ? Math.ceil((row.next_slot_at - ts) / 1000) : 0,
      resetAt: def.mode === 'count' ? windowStart + def.windowMs : null,
    };
  });
}

module.exports = {
  WINDOW_DEFS,
  effectiveLimits,
  normalizeLimits,
  windowStartFor, // 给测试用：日窗口用哪个零点必须和「今日」统计一致
  peek,
  admit,
  noteTokens,
  noteRateLimited,
  snapshot,
};
