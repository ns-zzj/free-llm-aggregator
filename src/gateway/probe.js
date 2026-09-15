'use strict';

/**
 * 倒计时探测（M2）——**按 (提供商, 模型) 逐个探测**：
 *  冷却到期的模型会被自动发一次极小请求验证是否恢复；
 *  成功 → 该模型恢复可用；失败 → 该模型继续下一轮冷却（额度刷新后自动复活）。
 *
 * 状态是模型级的，所以同家别的模型不受影响（例如 ModelScope 一个模型额度用完了，
 * 另一个模型照常使用，只有前者会被冷却和探测）。
 */

const adapter = require('./adapter');
const providersStore = require('../store/providers');
const providerModels = require('../store/providerModels');
const sourceState = require('../store/sourceState');
const rateState = require('../store/rateState');
const callLog = require('../store/callLog');
const settings = require('../store/settings');
const probeSchedule = require('../store/probeSchedule');
const naming = require('../naming');
const logger = require('../logger');

const PROBE_TIMEOUT_MS = 30 * 1000;

/**
 * 日志里「请求模型」一列统一写**对外发布名**（`Free/<来源id>/<上游模型名>` 或 `Pay/...`）。
 * 这样探测/测试记录和客户端请求记录看起来是一回事——前端再从这一列里拆出
 * 「模型」和「来源」两列展示（callLog.toApi 里的 modelName / sourceLabel）。
 */
function publishedModel(provider, modelId) {
  return naming.modelName({ providerId: provider.id, modelId, isPaid: !!provider.isPaid });
}

/**
 * 从探测/测试的响应里抠出用量（各协议形状不同，交给适配器翻译）。
 * 抠不到就返回 null —— 记 null 表示"上游没报"，而不是 0（0 是"真的一颗都没用"）。
 */
function probeUsage(provider, text, modelId) {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    const out = adapter.normalizeResponse(provider, parsed, {
      requestedModel: publishedModel(provider, modelId),
      mode: 'pinned',
    });
    return (out && out.usage) || null;
  } catch (err) {
    return null; // 响应不是 JSON / 认不出来 —— 探测成功与否不看这个，只管记账
  }
}

/**
 * 失败之后先算出"该怎么办"：
 *
 * 1) **非可重试的错直接转「需人工」**（用户裁定 2026-09-11）：
 *    400/422 这类"上游根本不接受这个模型"（模型名写错、参数被拒）的错，
 *    探测一万次也不会好 —— 那是配置问题，得人去改。所以不进冷却、不探测。
 *    （以前是无条件按"倒计时检测"处理，结果配错一个模型名会白探 10 次才放弃。）
 *
 * 2) **等待时长按退避表推进**：冷却期间每失败一次就前进一段，
 *    最后一段原地重计。**手动测试也算一次失败** —— 否则你在 60 秒档手点一下「测试」，
 *    等待又被打回第一段（15 秒）了，表就白排了。
 */
async function decideFailure(provider, model, info) {
  const before = await sourceState.get(provider.id, model.modelId);
  const inCooldown = Boolean(before && before.status === 'cooldown');
  const attempts = inCooldown ? await sourceState.bumpProbeAttempts(provider.id, model.modelId) : 0;
  if (info.retryable === false) {
    return { attempts, needsManual: true, cooldownSeconds: null };
  }
  return { attempts, needsManual: false, cooldownSeconds: await probeSchedule.nextWaitSeconds(attempts) };
}

/**
 * 探测失败之后：达到全局设置的上限（倒计时检测次数上限）就**停止自动探测、转为"需人工"**，
 * 免得对着一个修不好的模型一直发请求。
 * 注意：连续失败次数由 decideFailure 先累加（退避表的下一段要靠它算），这里只做"到上限就放弃"。
 */
async function applyProbeCap(provider, model, state, attempts) {
  const cap = (await settings.getNumber('probe_max_attempts')) || 0;
  if (cap <= 0 || attempts < cap) {
    return { state, attempts, cap };
  }

  const stopped = await sourceState.setStatus(provider.id, model.modelId, 'stopped', {
    reason: `连续探测 ${attempts} 次未恢复（上限 ${cap}），已停止自动探测，需人工处理`,
  });
  await callLog.add({
    providerId: provider.id,
    realModel: model.modelId,
    requestModel: publishedModel(provider, model.modelId),
    status: 'fail',
    isProbe: true,
    errorType: 'probe_give_up',
    detail: `连续探测 ${attempts} 次未恢复，已转为「故障（需人工）」`,
  });
  logger.warn('连续探测未恢复，转为需人工', {
    providerId: provider.id,
    modelId: model.modelId,
    attempts,
    cap,
  });
  return { state: stopped, attempts, cap, givenUp: true };
}

/**
 * 探测/测试单个模型。
 *   asCall=false（默认）：定时探测或「立即探测」——占额度、写日志（标记为探测），失败按"倒计时检测"处理
 *   asCall=true：「测试」按钮——**按真实调用对待**：占速率额度、写普通调用日志、失败按该来源配置的策略处理，
 *                     这样点完测试也能看到限速倒计时、日志里也能查到这一笔
 */
async function probeModel(provider, model, { manual = false, asCall = false } = {}) {
  const { limits, modelKey } = rateState.effectiveLimits(provider, {
    rateOverride: model.rateOverride,
    localModelId: model.id,
  });
  const lease = await rateState.admit({ providerId: provider.id, modelKey, limits });
  if (!lease.allowed) {
    if (asCall) {
      // 限速不是故障：如实记一笔调用，但不改模型状态
      await callLog.add({
        providerId: provider.id,
        realModel: model.modelId,
        requestModel: publishedModel(provider, model.modelId), // 日志页要能看出测的是哪个模型
        status: 'fail',
        errorType: 'rate_limited',
        isProbe: false,
        detail: `手动测试：本地限速中（${lease.reason}）`,
      });
      return {
        ok: false,
        model: model.modelId,
        rateLimited: true,
        retryAfterSeconds: Math.ceil((lease.etaMs || 0) / 1000),
        message: `本地限速中，还需约 ${Math.ceil((lease.etaMs || 0) / 1000)} 秒`,
      };
    }
    // 定时探测被本地闸门挡下：把探测往后推一点，别硬撞
    const waitMs = Math.min(Math.max(lease.etaMs || 0, 15 * 1000), 5 * 60 * 1000);
    await sourceState.markFailure(provider.id, model.modelId, {
      policy: 'cooldown_probe',
      cooldownSeconds: Math.ceil(waitMs / 1000),
      reason: `本地闸门未放行（${lease.reason}）`,
      errorType: 'rate_limited',
    });
    logger.info('探测被本地速率闸门挡下，稍后再试', { providerId: provider.id, modelId: model.modelId, reason: lease.reason });
    return { providerId: provider.id, modelId: model.modelId, ok: false, reason: lease.reason };
  }

  const startedAt = Date.now();
  const recordedAsProbe = !asCall;
  const prefix = asCall ? '手动测试' : '探测';
  try {
    const { url, headers, payload } = adapter.buildProbeRequest(provider, model.modelId);
    const upstream = await adapter.fetchWithTimeout(
      url,
      { method: 'POST', headers, body: JSON.stringify(payload) },
      PROBE_TIMEOUT_MS
    );
    const text = await upstream.text();
    const latencyMs = Date.now() - startedAt;

    if (upstream.ok) {
      // 有些协议（如 Cloudflare Workers AI）会 HTTP 200 但 body 里说失败，不能当成功
      const embedded = adapter.bodyError(provider, text);
      if (embedded) {
        const info = { ...embedded, retryable: true };
        const decision = await decideFailure(provider, model, info);
        const state = await sourceState.markFailure(provider.id, model.modelId, {
          policy: decision.needsManual ? 'stop_manual' : asCall ? provider.rejectPolicy : 'cooldown_probe',
          cooldownSeconds: decision.cooldownSeconds || undefined,
          reason: decision.needsManual
            ? `${prefix}失败（这类错误探测也不会好，已转「需人工」）：${info.message}`
            : `${prefix}失败：${info.message}`,
          errorType: info.type,
          forcePolicy: decision.needsManual ? 'stop_manual' : asCall ? info.forcePolicy || undefined : undefined,
        });
        await callLog.add({
          providerId: provider.id,
          realModel: model.modelId,
          requestModel: publishedModel(provider, model.modelId),
          status: 'fail',
          isProbe: recordedAsProbe,
          errorType: info.type,
          latencyMs,
          detail: `${prefix}失败：${info.message}`,
        });
        const finalState =
          recordedAsProbe && !decision.needsManual
            ? (await applyProbeCap(provider, model, state, decision.attempts)).state
            : state;
        logger.info(`${prefix}未通过（HTTP 200 但上游说失败）`, {
          providerId: provider.id,
          modelId: model.modelId,
          errorType: info.type,
          newStatus: finalState.status,
          asCall,
        });
        return {
          ok: false,
          model: model.modelId,
          modelId: model.modelId,
          latencyMs,
          httpStatus: upstream.status,
          errorType: info.type,
          message: info.message,
          retryable: true,
          raw: text.slice(0, 500),
          state: finalState,
        };
      }
      await sourceState.markSuccess(provider.id, model.modelId);
      // 探测/测试也是真调用，用量要记账 —— 不然主页「今日 token」会漏掉这一部分
      // （每次只有 max_tokens=1 的量，但 CF 那类按 token 计费的平台该算还是得算）
      const usage = probeUsage(provider, text, model.modelId);
      await callLog.add({
        providerId: provider.id,
        realModel: model.modelId,
        requestModel: publishedModel(provider, model.modelId),
        status: 'ok',
        isProbe: recordedAsProbe,
        latencyMs,
        promptTokens: usage ? usage.prompt_tokens : null,
        completionTokens: usage ? usage.completion_tokens : null,
        detail: asCall ? '手动测试成功' : manual ? '手动探测成功' : '倒计时探测成功，模型恢复可用',
      });
      logger.info(`${prefix}成功`, { providerId: provider.id, modelId: model.modelId, latencyMs, asCall });
      return {
        ok: true,
        model: model.modelId,
        modelId: model.modelId,
        latencyMs,
        httpStatus: upstream.status,
        raw: text.slice(0, 500),
        state: await sourceState.get(provider.id, model.modelId),
      };
    }

    const info = adapter.classifyError(upstream.status, text, provider);
    const retryAfter = upstream.headers.get('retry-after');
    const retryAfterSeconds = retryAfter ? Number(retryAfter) : NaN;
    const decision = await decideFailure(provider, model, info);
    let cooldownSeconds = decision.cooldownSeconds;
    if (info.type === 'rate_limit' && cooldownSeconds) {
      if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
        cooldownSeconds = Math.max(cooldownSeconds, Math.ceil(retryAfterSeconds));
      }
      await rateState.noteRateLimited({
        providerId: provider.id,
        modelKey,
        limits,
        retryAfterMs: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : null,
      });
    }
    const state = await sourceState.markFailure(provider.id, model.modelId, {
      // 测试按来源自身配置的策略处理；定时探测固定用"倒计时检测"；
      // 但"探测也不会好"的错（400/422 这类）一律转需人工
      policy: decision.needsManual ? 'stop_manual' : asCall ? provider.rejectPolicy : 'cooldown_probe',
      cooldownSeconds: cooldownSeconds || undefined,
      reason: decision.needsManual
        ? `${prefix}失败（这类错误探测也不会好，已转「需人工」）：${info.message}`
        : `${prefix}失败：${info.message}`,
      errorType: info.type,
      forcePolicy: decision.needsManual ? 'stop_manual' : asCall ? info.forcePolicy || undefined : undefined,
    });
    await callLog.add({
      providerId: provider.id,
      realModel: model.modelId,
      requestModel: publishedModel(provider, model.modelId),
      status: 'fail',
      isProbe: recordedAsProbe,
      errorType: info.type,
      latencyMs,
      detail: `${prefix}失败：${info.message}`,
    });
    // 自动探测失败要计数：连续 N 次没恢复就转"需人工"（手动测试不计入，它本身不算"检测"；
    // 已经在上面转成需人工的也不用再判）
    const finalState =
      recordedAsProbe && !decision.needsManual
        ? (await applyProbeCap(provider, model, state, decision.attempts)).state
        : state;
    logger.info(`${prefix}未通过`, {
      providerId: provider.id,
      modelId: model.modelId,
      errorType: info.type,
      nextProbeInSeconds: cooldownSeconds || 0,
      needsManual: decision.needsManual,
      newStatus: finalState.status,
      asCall,
    });
    return {
      ok: false,
      model: model.modelId,
      modelId: model.modelId,
      latencyMs,
      httpStatus: upstream.status,
      errorType: info.type,
      message: info.message,
      retryable: info.retryable,
      raw: text.slice(0, 500),
      state: finalState,
    };
  } catch (err) {
    const info = adapter.classifyException(err);
    const decision = await decideFailure(provider, model, info);
    const state = await sourceState.markFailure(provider.id, model.modelId, {
      policy: decision.needsManual ? 'stop_manual' : asCall ? provider.rejectPolicy : 'cooldown_probe',
      cooldownSeconds: decision.cooldownSeconds || undefined,
      reason: decision.needsManual
        ? `${prefix}异常（这类错误探测也不会好，已转「需人工」）：${info.message}`
        : `${prefix}异常：${info.message}`,
      errorType: info.type,
    });
    await callLog.add({
      providerId: provider.id,
      realModel: model.modelId,
      requestModel: publishedModel(provider, model.modelId),
      status: 'fail',
      isProbe: recordedAsProbe,
      errorType: info.type,
      latencyMs: Date.now() - startedAt,
      detail: `${prefix}异常：${info.message}`,
    });
    const finalState =
      recordedAsProbe && !decision.needsManual
        ? (await applyProbeCap(provider, model, state, decision.attempts)).state
        : state;
    logger.info(`${prefix}异常`, {
      providerId: provider.id,
      modelId: model.modelId,
      errorType: info.type,
      needsManual: decision.needsManual,
      asCall,
    });
    return {
      ok: false,
      model: model.modelId,
      modelId: model.modelId,
      errorType: info.type,
      message: info.message,
      state: finalState,
    };
  } finally {
    lease.release();
  }
}

/** 后台「测试」按钮：按真实调用处理（占速率、写调用日志、失败按策略改状态） */
async function testModel(providerId, modelId = null) {
  const provider = await providersStore.getWithKey(providerId);
  if (!provider) return { ok: false, notFound: true, message: '提供商不存在' };
  const models = await providerModels.listByProvider(providerId);
  const target =
    (modelId && models.find((m) => m.modelId === modelId)) || models.find((m) => m.enabled) || models[0] || null;
  if (!target) return { ok: false, message: '该提供商下没有模型，请先添加模型' };
  return probeModel(provider, target, { manual: true, asCall: true });
}

/**
 * 手动探测某个提供商的模型：
 *  - 不传 modelIds 时探测它下面所有启用的模型（后台「立即探测」按钮）
 */
async function probeProvider(providerId, { manual = true, modelIds = null } = {}) {
  const provider = await providersStore.getWithKey(providerId);
  if (!provider) return { ok: false, reason: '提供商不存在', results: [] };
  if (!provider.enabled) return { ok: false, reason: '提供商已禁用', results: [] };

  const all = await providerModels.listByProvider(providerId);
  const targets = all.filter((m) => m.enabled && (!modelIds || modelIds.includes(m.modelId)));
  if (targets.length === 0) return { ok: false, reason: '该提供商没有启用的模型', results: [] };

  const results = [];
  for (const model of targets) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await probeModel(provider, model, { manual }));
  }
  return { ok: results.some((r) => r.ok), results };
}

/** 一轮探测：处理所有"冷却已到期"的 (提供商, 模型) */
async function runProbeCycle({ limit = 10 } = {}) {
  const due = await sourceState.dueForProbe(limit);
  const results = [];
  for (const row of due) {
    // eslint-disable-next-line no-await-in-loop
    const provider = await providersStore.getWithKey(row.provider_id); // 必须带解密的 apiKey，否则真实上游会 401
    if (!provider) continue;
    if (provider.rejectPolicy !== 'cooldown_probe') {
      // 策略被改成"停用不检测"了 → 交给人工
      // eslint-disable-next-line no-await-in-loop
      await sourceState.setStatus(row.provider_id, row.model_id, 'stopped', { reason: '策略为停用不检测，需人工恢复' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const models = await providerModels.listByProvider(row.provider_id);
    const model = models.find((m) => m.modelId === row.model_id);
    if (!model) {
      // 模型已从配置里删掉：这条状态没有意义了，复位避免干扰
      // eslint-disable-next-line no-await-in-loop
      await sourceState.markSuccess(row.provider_id, row.model_id);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    results.push(await probeModel(provider, model, { manual: false }));
  }
  return results;
}

module.exports = { probeModel, probeProvider, testModel, runProbeCycle };
