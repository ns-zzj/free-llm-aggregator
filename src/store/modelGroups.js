'use strict';

/**
 * 模型组：用户自己排的一套兜底链。
 *
 * 对外就是一个名字 `ModelGroup/<组名>`；客户端填这个名字，
 * 网关按**组内顺序**逐个试（可以混免费和付费），全都不行才报错。
 *
 * 设计（用户裁定 2026-09-11）：
 *   - 组名就是个普通输入框，随手改、没有"保存"按钮
 *   - 组内支持拖拽排序（和「All模型顺序」页同一套交互）
 *   - 删组不影响模型本身；删模型会自动带走它在各个组里的条目
 */

const { db } = require('../db');
const naming = require('../naming');
const { HttpError } = require('./providers');

function now() {
  return Date.now();
}

/** 组内条目 → 候选（给选源用），形状和 providerModels 的候选保持一致 */
function toCandidate(row, mode) {
  const isPaid = !!row.is_paid;
  return {
    providerId: row.provider_id,
    providerName: row.provider_name,
    isPaid,
    sortOrder: row.item_sort_order,
    localModelId: row.provider_model_id,
    modelId: row.model_id,
    publishedId: naming.modelName({ providerId: row.provider_id, modelId: row.model_id, isPaid }),
    realModelId: row.model_id,
    rateOverride: row.rate_override ? JSON.parse(row.rate_override) : null,
    supportsVision: !!row.supports_vision,
    mode,
  };
}

function toItemApi(row) {
  const isPaid = !!row.is_paid;
  return {
    id: row.item_id,
    providerModelId: row.provider_model_id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    modelId: row.model_id,
    isPaid,
    publishedId: naming.modelName({ providerId: row.provider_id, modelId: row.model_id, isPaid }),
    enabled: !!row.model_enabled && !!row.provider_enabled,
    supportsVision: !!row.supports_vision,
    sortOrder: row.item_sort_order,
  };
}

function toGroupApi(row) {
  return {
    id: row.id,
    name: row.name,
    publishedId: naming.groupName(row.name),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 组内条目连同模型/来源信息（JOIN 上 provider_models，脏条目自然被过滤掉） */
async function itemsOf(groupIds) {
  const query = db('model_group_items as i')
    .join('provider_models as m', 'm.id', 'i.provider_model_id')
    .join('providers as p', 'p.id', 'm.provider_id')
    .select(
      'i.id as item_id',
      'i.group_id',
      'i.provider_model_id',
      'i.sort_order as item_sort_order',
      'm.model_id',
      'm.enabled as model_enabled',
      'm.rate_override',
      'm.supports_vision',
      'p.id as provider_id',
      'p.name as provider_name',
      'p.is_paid',
      'p.enabled as provider_enabled'
    )
    .orderBy([
      { column: 'i.sort_order', order: 'asc' },
      { column: 'i.id', order: 'asc' },
    ]);
  if (Array.isArray(groupIds) && groupIds.length) query.whereIn('i.group_id', groupIds);
  return query;
}

/** 后台列表：每个组带上组内条目 */
async function list() {
  const groups = await db('model_groups').orderBy([
    { column: 'sort_order', order: 'asc' },
    { column: 'id', order: 'asc' },
  ]);
  const items = await itemsOf(groups.map((g) => g.id));
  const byGroup = new Map();
  for (const row of items) {
    if (!byGroup.has(row.group_id)) byGroup.set(row.group_id, []);
    byGroup.get(row.group_id).push(toItemApi(row));
  }
  return groups.map((g) => ({ ...toGroupApi(g), items: byGroup.get(g.id) || [] }));
}

async function getByName(name) {
  const row = await db('model_groups').where({ name: String(name || '').trim() }).first();
  return row ? toGroupApi(row) : null;
}

/** 新建：名字可以用一个"没被占用"的默认名，之后在框里随手改 */
async function create({ name } = {}) {
  let wanted = String(name || '').trim();
  if (!wanted) {
    let n = 1;
    // eslint-disable-next-line no-await-in-loop
    while (await db('model_groups').where({ name: `模型组${n}` }).first()) n += 1;
    wanted = `模型组${n}`;
  }
  const check = naming.validateGroupName(wanted);
  if (!check.ok) throw new HttpError(400, check.reason);
  if (await db('model_groups').where({ name: check.name }).first()) {
    throw new HttpError(400, `已经有一个叫「${check.name}」的组了`);
  }
  const ts = now();
  const max = await db('model_groups').max({ max: 'sort_order' }).first();
  const [id] = await db('model_groups').insert({
    name: check.name,
    sort_order: Number(max && max.max ? max.max : 0) + 10,
    created_at: ts,
    updated_at: ts,
  });
  return toGroupApi(await db('model_groups').where({ id }).first());
}

/** 改名（后台那个输入框失焦即调这个，没有"保存"按钮） */
async function rename(id, name) {
  const row = await db('model_groups').where({ id: Number(id) }).first();
  if (!row) throw new HttpError(404, '模型组不存在');
  const check = naming.validateGroupName(name);
  if (!check.ok) throw new HttpError(400, check.reason);
  if (check.name === row.name) return toGroupApi(row);
  const dup = await db('model_groups').where({ name: check.name }).first();
  if (dup) throw new HttpError(400, `已经有一个叫「${check.name}」的组了`);
  await db('model_groups').where({ id: row.id }).update({ name: check.name, updated_at: now() });
  return toGroupApi(await db('model_groups').where({ id: row.id }).first());
}

async function remove(id) {
  const deleted = await db('model_groups').where({ id: Number(id) }).del();
  if (!deleted) throw new HttpError(404, '模型组不存在');
  return { id: Number(id) };
}

/** 往组里加一个模型（provider_models 的 id）；同一个模型在同一组里只放一次 */
async function addItem(groupId, providerModelId) {
  const group = await db('model_groups').where({ id: Number(groupId) }).first();
  if (!group) throw new HttpError(404, '模型组不存在');
  const model = await db('provider_models').where({ id: Number(providerModelId) }).first();
  if (!model) throw new HttpError(404, '模型不存在（先去「提供商」页里加）');
  const dup = await db('model_group_items')
    .where({ group_id: group.id, provider_model_id: model.id })
    .first();
  if (dup) throw new HttpError(400, '这个模型已经在组里了');
  const max = await db('model_group_items').where({ group_id: group.id }).max({ max: 'sort_order' }).first();
  const [id] = await db('model_group_items').insert({
    group_id: group.id,
    provider_model_id: model.id,
    sort_order: Number(max && max.max ? max.max : 0) + 10,
    created_at: now(),
  });
  await db('model_groups').where({ id: group.id }).update({ updated_at: now() });
  return { id };
}

async function removeItem(groupId, itemId) {
  const deleted = await db('model_group_items')
    .where({ id: Number(itemId), group_id: Number(groupId) })
    .del();
  if (!deleted) throw new HttpError(404, '组里没有这条模型');
  return { id: Number(itemId) };
}

/** 组内拖拽排序：按传入顺序（条目 id 数组）重排 */
async function reorderItems(groupId, orderedIds) {
  const group = await db('model_groups').where({ id: Number(groupId) }).first();
  if (!group) throw new HttpError(404, '模型组不存在');
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new HttpError(400, 'orderedIds 需为非空数组');
  }
  await db.transaction(async (trx) => {
    let order = 10;
    for (const id of orderedIds) {
      const numeric = Number(id);
      if (!Number.isFinite(numeric)) continue;
      // eslint-disable-next-line no-await-in-loop
      const updated = await trx('model_group_items')
        .where({ id: numeric, group_id: group.id })
        .update({ sort_order: order });
      if (updated) order += 10;
    }
    await trx('model_groups').where({ id: group.id }).update({ updated_at: now() });
  });
  return { ok: true };
}

/** 删除某个模型/提供商时，顺手清掉它在各组里的条目（避免留脏行） */
async function pruneForProviderModel(providerModelIds) {
  const ids = (Array.isArray(providerModelIds) ? providerModelIds : [providerModelIds])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
  if (!ids.length) return 0;
  return db('model_group_items').whereIn('provider_model_id', ids).del();
}

async function pruneForProvider(providerId) {
  const rows = await db('provider_models').where({ provider_id: providerId }).select('id');
  return pruneForProviderModel(rows.map((r) => r.id));
}

/**
 * 把 `ModelGroup/<组名>` 解析成候选列表（给选源用）。
 * 组不存在 → unknown-model（404 口径）；组在但里面没有可用模型 → 交给上层按"全挂"处理。
 */
async function resolveCandidates(name) {
  const group = await db('model_groups').where({ name: String(name || '').trim() }).first();
  if (!group) {
    return { mode: 'unknown-model', candidates: [], reason: `没有名叫「${name}」的模型组（去后台「模型组」页建一个）` };
  }
  const rows = await itemsOf([group.id]);
  const candidates = rows
    .filter((r) => r.model_enabled && r.provider_enabled)
    .map((r) => toCandidate(r, 'group'));
  return { mode: 'group', candidates, reason: '' };
}

/** `/openai/models` 与 `/anthropic/models` 里发布每个组 */
async function publishedList() {
  const groups = await db('model_groups').orderBy('id', 'asc');
  return groups.map((g) => ({ id: naming.groupName(g.name), createdAt: g.created_at }));
}

module.exports = {
  list,
  getByName,
  create,
  rename,
  remove,
  addItem,
  removeItem,
  reorderItems,
  pruneForProviderModel,
  pruneForProvider,
  resolveCandidates,
  publishedList,
};
