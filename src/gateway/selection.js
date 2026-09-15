'use strict';

/**
 * 选源：先过滤"此刻可用"，再按用户排序。
 *
 * 对外模型名的形态由 providerModels.resolveCandidates / modelGroups 判定（mode）：
 *   all        虚拟模型 `All`：全部启用的模型都算候选，逐个换源（免费在前、付费兜底）
 *   group      `ModelGroup/<组名>`：按组内顺序换源（组内可以混免费付费）
 *   pinned     指定来源（`Free/x/y` 或 `Pay/x/y`）：只有一个候选，不换源
 *   invalid    名字不合规（没带来源 / 没带类别前缀 / 前缀用错 / 该来源下没有这个模型）
 *
 * `needsVision`：这次请求带了图片。候选缩到标了「支持图片理解」的模型；
 * 一个都没有 → `visionUnsupported: true`（配置问题，上层报 400 而不是 503）。
 */

const providerModels = require('../store/providerModels');
const sourceState = require('../store/sourceState');
const providers = require('../store/providers');
const rateState = require('../store/rateState');

async function selectCandidates(requestedModel, { needsVision = false } = {}) {
  const resolved = await providerModels.resolveCandidates(requestedModel);
  const mode = resolved.mode;
  const matched = resolved.candidates || [];

  if (mode === 'invalid' || mode === 'unknown-provider' || mode === 'paid-mismatch' || mode === 'unknown-model') {
    return { mode, available: [], skipped: [], invalidReason: resolved.reason || '' };
  }

  // 带了图，但候选里压根没有一个"能看图"的：等多久都不会好 —— 交给上层报 400
  if (needsVision && !matched.some((candidate) => candidate.supportsVision)) {
    return { mode, available: [], skipped: [], needsVision, visionUnsupported: true };
  }

  const available = [];
  const skipped = [];

  for (const candidate of matched) {
    // 带了图但这个模型没标"支持图片理解"：跳过（绝不把图偷偷丢掉再发出去）
    if (needsVision && !candidate.supportsVision) {
      skipped.push({ ...candidate, status: 'no_vision', reason: '这个模型没有标「支持图片理解」' });
      continue;
    }

    // 取"带解密后 apiKey"的完整配置（调用上游需要）
    // eslint-disable-next-line no-await-in-loop
    const provider = await providers.getWithKey(candidate.providerId);
    if (!provider || !provider.enabled) {
      skipped.push({ ...candidate, status: 'disabled', reason: '提供商已禁用' });
      continue;
    }

    // 状态是 (提供商, 模型) 级的：同家别的模型不受影响
    // eslint-disable-next-line no-await-in-loop
    const ok = await sourceState.isAvailable(candidate.providerId, candidate.realModelId);
    if (!ok) {
      // eslint-disable-next-line no-await-in-loop
      const state = await sourceState.get(candidate.providerId, candidate.realModelId);
      skipped.push({
        ...candidate,
        status: state.status,
        reason: state.reason || state.status,
        cooldownRemainingSeconds: state.cooldownRemainingSeconds,
      });
      continue;
    }

    // 速率准入：只看不消耗（真正消耗在发送前由 admit 完成）
    const { limits, modelKey } = rateState.effectiveLimits(provider, candidate);
    // eslint-disable-next-line no-await-in-loop
    const admission = await rateState.peek({ providerId: candidate.providerId, modelKey, limits });
    if (!admission.allowed) {
      skipped.push({
        ...candidate,
        status: 'rate_limited',
        reason: admission.reason,
        cooldownRemainingSeconds: admission.etaMs > 0 ? Math.ceil(admission.etaMs / 1000) : undefined,
      });
      continue;
    }

    available.push({ ...candidate, provider, limits, modelKey });
  }

  return { mode, available, skipped, needsVision };
}

/** 最早恢复时间（秒）—— 用作 Retry-After */
function earliestRetryAfterSeconds(skipped) {
  const values = skipped
    .map((item) => item.cooldownRemainingSeconds)
    .filter((value) => typeof value === 'number' && value > 0);
  return values.length ? Math.min(...values) : null;
}

module.exports = { selectCandidates, earliestRetryAfterSeconds };
