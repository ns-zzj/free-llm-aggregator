'use strict';

/**
 * 调用日志（不记录访问口令维度；探测请求单独标记）
 */

const { db } = require('../db');
const naming = require('../naming');

/**
 * 请求里的模型名 → 只留模型部分（去掉 `Free/`、`Pay/` 前缀和 `来源id/` 前缀）。
 * 日志表把"模型"和"来源"分成两列，请求模型这一列就只显示模型本身：
 *   `Pay/deepseek/deepseek-v4-flash` → `deepseek-v4-flash`
 *   `Free/modelscope-cn/deepseek-ai/DeepSeek-V4-Flash` → `deepseek-ai/DeepSeek-V4-Flash`（上游名里的斜杠保留）
 *   `All` / `ModelGroup/xxx` → 原样显示（本来就是虚拟名字）
 *
 * 注意：只有第一段确实是**已知来源 id** 时才当来源拆掉。否则（比如历史上探测记录里
 * 直接写的 `deepseek-ai/DeepSeek-V4.1-Flash`）整串都是模型名，不能乱切。
 */
function modelPartOf(requestedModel, providerIds) {
  const raw = String(requestedModel || '');
  // 虚拟名字（All / 模型组）：不是"来源/模型"的形状，原样返回
  const parsed = naming.parse(raw);
  if (parsed.kind === 'all' || parsed.kind === 'group') return raw;
  let body = raw;
  if (parsed.kind === 'pinned') body = `${parsed.providerId}/${parsed.modelName}`;
  const slash = body.indexOf('/');
  if (slash <= 0) return body;
  if (!providerIds || providerIds.size === 0 || !providerIds.has(body.slice(0, slash))) return body;
  return body.slice(slash + 1);
}

function toApi(row, { providerIds } = {}) {
  if (!row) return null;
  // 探测/测试记录写的就是发布名，所以这里可以统一按发布名拆
  const requested = String(row.request_model || '');
  // All / 模型组请求：模型这一列写成「All(实际用的模型)」，一眼看出这次自动挑中了谁
  const parsedRequested = naming.parse(requested);
  const isVirtual = parsedRequested.kind === 'all' || parsedRequested.kind === 'group';
  const virtualLabel = parsedRequested.kind === 'group' ? naming.groupName(parsedRequested.name) : naming.ALL;
  const modelName = isVirtual
    ? row.real_model
      ? `${virtualLabel}(${row.real_model})`
      : virtualLabel
    : modelPartOf(requested, providerIds) || row.real_model || '';
  const isPaid = row.provider_is_paid !== undefined ? !!row.provider_is_paid : false;
  return {
    id: row.id,
    ts: row.ts,
    requestModel: row.request_model || '',
    modelName,
    sourceLabel: row.provider_id ? naming.sourceLabel(row.provider_id, isPaid) : '',
    providerId: row.provider_id || '',
    realModel: row.real_model || '',
    status: row.status || '',
    isPaidFallback: !!row.is_paid_fallback,
    isProbe: !!row.is_probe,
    isStream: !!row.is_stream,
    errorType: row.error_type || '',
    latencyMs: row.latency_ms || null,
    ttfbMs: row.ttfb_ms || null,
    promptTokens: row.prompt_tokens || null,
    completionTokens: row.completion_tokens || null,
    requestId: row.request_id || '',
    detail: row.detail || '',
  };
}

async function add(entry) {
  const row = {
    ts: entry.ts || Date.now(),
    request_model: entry.requestModel || null,
    provider_id: entry.providerId || null,
    real_model: entry.realModel || null,
    status: entry.status || null,
    is_paid_fallback: entry.isPaidFallback ? 1 : 0,
    is_probe: entry.isProbe ? 1 : 0,
    error_type: entry.errorType || null,
    latency_ms: entry.latencyMs === undefined ? null : entry.latencyMs,
    ttfb_ms: entry.ttfbMs === undefined ? null : entry.ttfbMs,
    is_stream: entry.isStream ? 1 : 0,
    prompt_tokens: entry.promptTokens === undefined ? null : entry.promptTokens,
    completion_tokens: entry.completionTokens === undefined ? null : entry.completionTokens,
    request_id: entry.requestId || null,
    detail: entry.detail ? String(entry.detail).slice(0, 2000) : null,
  };
  const [id] = await db('call_log').insert(row);
  return id;
}

async function recent({ limit = 100, providerId, status, model } = {}) {
  // join 一下 providers 只为拿 is_paid（日志里"来源"要显示成 PAY/xxx 还是 xxx）
  const query = db('call_log')
    .leftJoin('providers as p', 'p.id', 'call_log.provider_id')
    .select('call_log.*', 'p.is_paid as provider_is_paid')
    .orderBy('call_log.id', 'desc')
    .limit(Math.min(Number(limit) || 100, 500));
  if (providerId) query.where('call_log.provider_id', providerId);
  if (status) query.where('call_log.status', status);
  if (model) query.where('call_log.request_model', model);
  const rows = await query;
  const providerIds = new Set((await db('providers').select('id')).map((r) => r.id));
  return rows.map((row) => toApi(row, { providerIds }));
}

/** 清理过期日志（保留天数由设置决定） */
async function prune(olderThanMs) {
  const cutoff = Date.now() - Number(olderThanMs);
  return db('call_log').where('ts', '<', cutoff).del();
}

async function countSince(ts) {
  const row = await db('call_log').where('ts', '>=', ts).count({ n: '*' }).first();
  return Number(row?.n || 0);
}

/**
 * 「今日」汇总（主页概览卡用）：请求数、失败数、按"命中的来源是否付费"分开的 token 用量。
 * 一条 SQL 聚合搞定（自用工具，一天几百到几万行，没有必要预计算）。
 *
 * 口径说明（这几个决定会影响数字怎么读，所以写清楚）：
 *   - **失败** = `status='fail'` 且 `error_type` 不是 `client_abort`
 *     —— 客户端自己取消的那次不算服务失败（否则你每打断一次流，失败数就 +1）。
 *   - **免费/付费怎么分**：用写日志那一刻记下的 `is_paid_fallback`（它记的就是"这次命中的是不是付费来源"），
 *     而不是现在 join 回 providers 看 `is_paid` —— 来源后来被改属性或删掉了，历史日志也不该跟着变。
 *   - **token** 取 `prompt + completion`；失败但已经产生用量的（比如流到一半断掉）也计入，
 *     那是真花出去的钱，不该被"失败"两个字藏起来。
 */
async function statsSince(ts) {
  const row = await db('call_log')
    .where('ts', '>=', ts)
    .select(
      db.raw('COUNT(*) AS requests'),
      db.raw("SUM(CASE WHEN status = 'fail' AND COALESCE(error_type, '') <> 'client_abort' THEN 1 ELSE 0 END) AS failures"),
      db.raw(
        'SUM(CASE WHEN COALESCE(is_paid_fallback, 0) = 0 THEN COALESCE(prompt_tokens, 0) ELSE 0 END) AS free_prompt'
      ),
      db.raw(
        'SUM(CASE WHEN COALESCE(is_paid_fallback, 0) = 0 THEN COALESCE(completion_tokens, 0) ELSE 0 END) AS free_completion'
      ),
      db.raw(
        'SUM(CASE WHEN COALESCE(is_paid_fallback, 0) = 1 THEN COALESCE(prompt_tokens, 0) ELSE 0 END) AS paid_prompt'
      ),
      db.raw(
        'SUM(CASE WHEN COALESCE(is_paid_fallback, 0) = 1 THEN COALESCE(completion_tokens, 0) ELSE 0 END) AS paid_completion'
      )
    )
    .first();

  const num = (value) => Number(value) || 0;
  const pack = (prompt, completion) => ({ prompt, completion, total: prompt + completion });
  return {
    requests: num(row && row.requests),
    failures: num(row && row.failures),
    freeTokens: pack(num(row && row.free_prompt), num(row && row.free_completion)),
    paidTokens: pack(num(row && row.paid_prompt), num(row && row.paid_completion)),
  };
}

module.exports = { add, recent, prune, countSince, statsSince, toApi };
