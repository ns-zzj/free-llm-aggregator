'use strict';

/**
 * 模型配置（挂在提供商下）：model_id / 启用 / 模型级速率覆盖 / 上下文长度 / 排序
 *
 * 对外模型名一律走 src/naming.js（`Free/x/y`、`Pay/x/y`、`All`、`ModelGroup/组名`）。
 * 「对外显示名」和「别名」两个字段已按用户要求删掉（2026-09-11）：模型对外就是
 * `[Free|Pay]/<来源id>/<上游模型名>`，一个名字一个含义，不再有第二套叫法。
 */

const { db } = require('../db');
const naming = require('../naming');
const modelGroups = require('./modelGroups');
const { HttpError } = require('./providers');

function now() {
  return Date.now();
}

function toApi(row, provider) {
  if (!row) return null;
  const isPaid = provider
    ? !!(provider.isPaid !== undefined ? provider.isPaid : provider.is_paid)
    : !!row.is_paid;
  return {
    id: row.id,
    providerId: row.provider_id,
    providerName: provider ? provider.name : undefined,
    isPaid,
    modelId: row.model_id,
    // 下游请求时要用的完整模型名
    publishedId: naming.modelName({ providerId: row.provider_id, modelId: row.model_id, isPaid }),
    enabled: !!row.enabled,
    // 能不能看图片（用户手工标；虚拟名字对外一律声明"能收图"，见 migration 0009 的说明）
    supportsVision: !!row.supports_vision,
    rateOverride: row.rate_override ? JSON.parse(row.rate_override) : null,
    contextTokens: row.context_tokens || null,
    sortOrder: row.sort_order || 0,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validate(input, { isCreate }) {
  const out = {};
  if (isCreate) {
    const modelId = String(input.modelId || '').trim();
    if (!modelId) throw new HttpError(400, 'modelId 不能为空（填上游真实模型 id）');
    out.model_id = modelId;
  }
  if (input.enabled !== undefined) out.enabled = input.enabled ? 1 : 0;
  if (input.supportsVision !== undefined) out.supports_vision = input.supportsVision ? 1 : 0;
  if (input.rateOverride !== undefined) {
    if (input.rateOverride === null || input.rateOverride === '') out.rate_override = null;
    else {
      const obj = typeof input.rateOverride === 'string' ? JSON.parse(input.rateOverride) : input.rateOverride;
      out.rate_override = JSON.stringify(obj);
    }
  }
  if (input.contextTokens !== undefined) {
    const n = Number(input.contextTokens);
    out.context_tokens = Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  if (input.notes !== undefined) out.notes = String(input.notes) || null;
  return out;
}

async function listByProvider(providerId) {
  const provider = await db('providers').where({ id: providerId }).first();
  const rows = await db('provider_models').where({ provider_id: providerId }).orderBy('model_id', 'asc');
  return rows.map((r) => toApi(r, provider));
}

/** 列表顺序 = 优先级顺序：免费组在前，组内按"模型条目"的 sort_order 排 */
async function listAll({ onlyEnabled = false } = {}) {
  const query = db('provider_models as m')
    .join('providers as p', 'p.id', 'm.provider_id')
    .select('m.*', 'p.name as provider_name', 'p.is_paid', 'p.enabled as provider_enabled', 'p.sort_order as provider_sort_order')
    .orderBy([
      { column: 'p.is_paid', order: 'asc' },
      { column: 'm.sort_order', order: 'asc' },
      { column: 'p.sort_order', order: 'asc' },
      { column: 'm.model_id', order: 'asc' },
    ]);
  if (onlyEnabled) {
    query.where('m.enabled', 1).andWhere('p.enabled', 1);
  }
  const rows = await query;
  return rows.map((r) => toApi(r, { name: r.provider_name, isPaid: r.is_paid }));
}

async function create(providerId, input) {
  const provider = await db('providers').where({ id: providerId }).first();
  if (!provider) throw new HttpError(404, `提供商「${providerId}」不存在`);
  const data = validate(input, { isCreate: true });
  const dup = await db('provider_models').where({ provider_id: providerId, model_id: data.model_id }).first();
  if (dup) throw new HttpError(400, `该提供商下已有模型「${data.model_id}」`);
  // 新模型默认排到最后（保持"先加的在前"的稳定顺序）
  const maxRow = await db('provider_models').max({ max: 'sort_order' }).first();
  data.sort_order = Number(maxRow && maxRow.max ? maxRow.max : 0) + 10;
  const ts = now();
  const [id] = await db('provider_models').insert({
    provider_id: providerId,
    enabled: 1,
    ...data,
    created_at: ts,
    updated_at: ts,
  });
  const row = await db('provider_models').where({ id }).first();
  return toApi(row, provider);
}

/** 主页拖拽排序：传入按顺序排列的模型条目 id 数组，按 10 递增写回 */
async function reorder(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new HttpError(400, 'orderedIds 需为非空数组');
  }
  const ts = now();
  await db.transaction(async (trx) => {
    let order = 10;
    for (const id of orderedIds) {
      const numeric = Number(id);
      if (!Number.isFinite(numeric)) continue;
      // eslint-disable-next-line no-await-in-loop
      const updated = await trx('provider_models').where({ id: numeric }).update({ sort_order: order, updated_at: ts });
      if (updated) order += 10;
    }
  });
  return listAll();
}

async function update(id, input) {
  const row = await db('provider_models').where({ id }).first();
  if (!row) throw new HttpError(404, '模型不存在');
  const data = validate(input, { isCreate: false });
  if (Object.keys(data).length === 0) return toApi(row);
  await db('provider_models').where({ id }).update({ ...data, updated_at: now() });
  const fresh = await db('provider_models').where({ id }).first();
  const provider = await db('providers').where({ id: fresh.provider_id }).first();
  return toApi(fresh, provider);
}

async function remove(id) {
  const row = await db('provider_models').where({ id: Number(id) }).first();
  const deleted = await db('provider_models').where({ id: Number(id) }).del();
  if (!deleted) throw new HttpError(404, '模型不存在');
  // 顺手清掉它在各个模型组里的条目，别在组里留一条指向空气的行
  await modelGroups.pruneForProviderModel(Number(id));
  return { id: Number(id), modelId: row ? row.model_id : undefined };
}

function toCandidate(r, mode, isPaid) {
  return {
    providerId: r.provider_id,
    providerName: r.provider_name,
    isPaid,
    sortOrder: r.sort_order,
    localModelId: r.id,
    modelId: r.model_id,
    publishedId: naming.modelName({ providerId: r.provider_id, modelId: r.model_id, isPaid }),
    realModelId: r.model_id,
    rateOverride: r.rate_override ? JSON.parse(r.rate_override) : null,
    supportsVision: !!r.supports_vision,
    mode,
  };
}

function byPriority(a, b) {
  if (a.is_paid !== b.is_paid) return a.is_paid - b.is_paid; // 免费组在前
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order; // 主页里排得靠上的先用
  if (a.provider_sort_order !== b.provider_sort_order) return a.provider_sort_order - b.provider_sort_order;
  return String(a.provider_id).localeCompare(String(b.provider_id));
}

/**
 * 把请求里的模型名解析成候选 (provider, model) 列表，并判定请求类型。
 *
 * 返回 `{ mode, candidates, reason }`：
 *   all             —— 虚拟模型 `All`：全部启用来源的启用模型，按「All模型顺序」页的顺序（免费在前）逐个换源
 *   group           —— `ModelGroup/<组名>`：按组内顺序换源（可混免费付费）
 *   pinned          —— `Free/<来源id>/<模型名>` 或 `Pay/<来源id>/<模型名>`：只有一个候选，**不换源**
 *   invalid         —— 名字不合规（没带来源 / 没带 Free- Pay- 类别 / 前缀用错）
 *   unknown-provider—— 来源不存在 / 已禁用
 *   paid-mismatch   —— Free/ Pay/ 前缀和来源的免费/付费属性不匹配
 *   unknown-model   —— 该来源下没有这个名字（或已禁用）
 */
async function resolveCandidates(requestedModel) {
  const parsed = naming.parse(requestedModel);

  if (parsed.kind === 'invalid') {
    return { mode: 'invalid', candidates: [], reason: parsed.reason };
  }

  if (parsed.kind === 'all') {
    const rows = await db('provider_models as m')
      .join('providers as p', 'p.id', 'm.provider_id')
      .select('m.*', 'p.name as provider_name', 'p.is_paid', 'p.enabled as provider_enabled', 'p.sort_order as provider_sort_order')
      .where('m.enabled', 1)
      .andWhere('p.enabled', 1);
    rows.sort(byPriority);
    return { mode: 'all', candidates: rows.map((r) => toCandidate(r, 'all', !!r.is_paid)), reason: '' };
  }

  if (parsed.kind === 'group') {
    return modelGroups.resolveCandidates(parsed.name);
  }

  if (parsed.kind === 'no-prefix') {
    // 老写法 `<来源id>/<模型名>`：来源存在就告诉他准确的完整名字，比一句"不存在"有用得多
    const provider = await db('providers').where({ id: parsed.providerId }).first();
    if (!provider) {
      return {
        mode: 'unknown-provider',
        candidates: [],
        reason: `来源「${parsed.providerId}」不存在（${naming.fullNameHint()}）`,
      };
    }
    return {
      mode: 'invalid',
      candidates: [],
      reason:
        `名字要带上类别：写成 ` +
        naming.modelName({ providerId: provider.id, modelId: parsed.modelName, isPaid: !!provider.is_paid }),
    };
  }

  const { providerId, modelName, isPaid: wantPaid } = parsed;
  const provider = await db('providers').where({ id: providerId }).first();
  if (!provider) {
    return { mode: 'unknown-provider', candidates: [], reason: `来源「${providerId}」不存在` };
  }
  if (!provider.enabled) {
    return { mode: 'unknown-provider', candidates: [], reason: `来源「${providerId}」已禁用` };
  }
  if (!!provider.is_paid !== wantPaid) {
    return {
      mode: 'paid-mismatch',
      candidates: [],
      reason: provider.is_paid
        ? `「${providerId}」是付费来源，名字要写成 ${naming.modelName({ providerId, modelId: modelName, isPaid: true })}`
        : `「${providerId}」不是付费来源，名字要写成 ${naming.modelName({ providerId, modelId: modelName, isPaid: false })}`,
    };
  }

  const rows = await db('provider_models')
    .where({ provider_id: providerId })
    .andWhere('enabled', 1)
    .orderBy('model_id', 'asc');

  const matched = rows.filter((r) => r.model_id === modelName);
  if (matched.length === 0) {
    return { mode: 'unknown-model', candidates: [], reason: `来源「${providerId}」下没有启用中的模型「${modelName}」` };
  }

  const decorated = matched.map((r) => ({
    ...r,
    provider_name: provider.name,
    is_paid: provider.is_paid,
    provider_sort_order: provider.sort_order || 0,
  }));
  decorated.sort(byPriority);
  return {
    mode: 'pinned',
    candidates: decorated.map((r) => toCandidate(r, 'pinned', !!provider.is_paid)),
    reason: '',
  };
}

module.exports = {
  listByProvider,
  listAll,
  create,
  update,
  remove,
  reorder,
  resolveCandidates,
};
