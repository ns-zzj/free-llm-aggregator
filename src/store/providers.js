'use strict';

/**
 * 提供商配置的数据访问（apiKey 加密存储，读取时按需解密）
 */

const { db } = require('../db');
const cryptoUtil = require('../crypto');
const adapterRegistry = require('../gateway/adapters');

// 只保留真正实现了的适配器（白名单直接来自适配器注册表：选了它，代码里就一定有对应实现，
// 不会出现"下拉框里有、实际拿 OpenAI 格式去打不兼容接口"的情况）
const ADAPTERS = adapterRegistry.ids;
const REJECT_POLICIES = ['keep_trying', 'cooldown_probe', 'stop_manual'];
const RATE_KINDS = ['rpm', 'rpd', 'tpm', 'tpd', 'concurrency'];
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,48}$/;

function parseRateLimits(value) {
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr : [];
  } catch (err) {
    return [];
  }
}

function now() {
  return Date.now();
}

function safeDecrypt(enc) {
  if (!enc) return '';
  try {
    return cryptoUtil.decrypt(enc) || '';
  } catch (err) {
    return '';
  }
}

function toApi(row, { revealKey = false } = {}) {
  if (!row) return null;
  const plain = safeDecrypt(row.api_key_enc);
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    isPaid: !!row.is_paid,
    adapter: row.adapter,
    baseUrl: row.base_url,
    apiKey: revealKey ? plain : undefined,
    apiKeyMasked: plain ? cryptoUtil.mask(plain) : row.api_key_enc ? '(无法解密：APP_SECRET 已变更？)' : '',
    hasApiKey: !!row.api_key_enc,
    accountId: row.account_id || '',
    // 注：proxy_url 这一列还在库里，但从来没被任何代码使用过（审计 L6），所以不再对外返回，
    // 也不再接受写入 —— 免得有人以为配了代理其实没生效。
    rejectPolicy: row.reject_policy,
    cooldownSeconds: row.cooldown_seconds,
    rateLimits: parseRateLimits(row.rate_limits),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 校验并规整输入；isCreate 时要求 id */
function validate(input, { isCreate }) {
  const out = {};
  if (isCreate) {
    const id = String(input.id || '').trim().toLowerCase();
    if (!ID_PATTERN.test(id)) {
      throw new HttpError(400, 'id 只能用小写字母/数字/下划线/连字符，2–49 位，例如 nvidia-nim');
    }
    out.id = id;
  }
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw new HttpError(400, 'name 不能为空');
    out.name = name;
  } else if (isCreate) {
    throw new HttpError(400, 'name 不能为空');
  }

  if (input.baseUrl !== undefined) {
    const baseUrl = String(input.baseUrl).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(baseUrl)) throw new HttpError(400, 'baseUrl 必须以 http:// 或 https:// 开头');
    // 审计 M5：链路本地/元数据地址永远不可能是合法的模型上游，直接拒。
    // （内网自建推理服务是合法用法，所以私网地址不禁；重定向也已经关掉了）
    const host = (() => {
      try {
        return new URL(baseUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      } catch (err) {
        return '';
      }
    })();
    const blocked =
      /^169\.254\./.test(host) ||
      host === 'metadata.google.internal' ||
      host === 'metadata' ||
      /^fe80:/i.test(host) ||
      host === 'fd00:ec2::254';
    if (!host || blocked) throw new HttpError(400, `baseUrl 的主机不能是链路本地/元数据地址（${host || '无法解析'}）`);
    out.base_url = baseUrl;
  } else if (isCreate) {
    throw new HttpError(400, 'baseUrl 不能为空');
  }

  if (input.adapter !== undefined) {
    if (!ADAPTERS.includes(input.adapter)) {
      throw new HttpError(400, `adapter 只能是 ${ADAPTERS.join(' / ')}`);
    }
    out.adapter = input.adapter;
  }
  if (input.rejectPolicy !== undefined) {
    if (!REJECT_POLICIES.includes(input.rejectPolicy)) {
      throw new HttpError(400, `rejectPolicy 只能是 ${REJECT_POLICIES.join(' / ')}`);
    }
    out.reject_policy = input.rejectPolicy;
  }
  if (input.cooldownSeconds !== undefined) {
    const s = Number(input.cooldownSeconds);
    if (!Number.isFinite(s) || s < 5) throw new HttpError(400, 'cooldownSeconds 需 ≥ 5 秒');
    out.cooldown_seconds = Math.round(s);
  }
  if (input.enabled !== undefined) out.enabled = input.enabled ? 1 : 0;
  if (input.isPaid !== undefined) out.is_paid = input.isPaid ? 1 : 0;
  if (input.accountId !== undefined) out.account_id = String(input.accountId).trim() || null;
  // proxyUrl 有意不再接受（审计 L6：字段存了但从不使用，等于骗人）
  // ★速率填写框：value=0 表示不做本地限制
  if (input.rateLimits !== undefined) {
    if (input.rateLimits === null || input.rateLimits === '') {
      out.rate_limits = null;
    } else {
      let arr;
      try {
        arr = typeof input.rateLimits === 'string' ? JSON.parse(input.rateLimits) : input.rateLimits;
      } catch (err) {
        throw new HttpError(400, 'rateLimits 不是合法 JSON');
      }
      if (!Array.isArray(arr)) throw new HttpError(400, 'rateLimits 需为数组');
      out.rate_limits = arr.length
        ? JSON.stringify(
            arr.map((item) => {
              const kind = String((item && item.kind) || '').toLowerCase();
              const value = Number(item && item.value);
              if (!RATE_KINDS.includes(kind)) {
                throw new HttpError(400, `速率类型只能是 ${RATE_KINDS.join(' / ')}`);
              }
              if (!Number.isFinite(value) || value < 0) {
                throw new HttpError(400, '速率数值需为 ≥ 0 的数字（填 0 表示不做本地限制）');
              }
              return { kind, value: Math.round(value) };
            })
          )
        : null;
    }
  }
  if (input.sortOrder !== undefined) {
    const n = Number(input.sortOrder);
    if (!Number.isFinite(n)) throw new HttpError(400, 'sortOrder 需为数字');
    out.sort_order = Math.round(n);
  }
  // apiKey：undefined = 不改；空字符串 = 清空；其它 = 重新加密保存
  if (input.apiKey !== undefined && !input.apiKeyIsMasked) {
    const key = String(input.apiKey);
    out.api_key_enc = key === '' ? null : cryptoUtil.encrypt(key);
  }
  return out;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function list() {
  const rows = await db('providers').orderBy([
    { column: 'is_paid', order: 'asc' },
    { column: 'sort_order', order: 'asc' },
    { column: 'id', order: 'asc' },
  ]);
  return rows.map((r) => toApi(r));
}

async function get(id, options) {
  const row = await db('providers').where({ id }).first();
  return toApi(row, options);
}

/** 内部使用：连解密后的 key 一起返回（网关调用上游时用） */
async function getWithKey(id) {
  const row = await db('providers').where({ id }).first();
  if (!row) return null;
  return { ...toApi(row, { revealKey: true }), apiKey: safeDecrypt(row.api_key_enc) };
}

async function create(input) {
  const data = validate(input, { isCreate: true });
  const existing = await db('providers').where({ id: data.id }).first();
  if (existing) throw new HttpError(400, `提供商 id「${data.id}」已存在`);
  if (data.sort_order === undefined) {
    const maxRow = await db('providers').max({ max: 'sort_order' }).first();
    data.sort_order = Number(maxRow?.max || 0) + 10;
  }
  const ts = now();
  await db('providers').insert({
    adapter: adapterRegistry.DEFAULT_ADAPTER,
    reject_policy: 'cooldown_probe',
    cooldown_seconds: 300,
    ...data,
    created_at: ts,
    updated_at: ts,
  });
  return get(data.id);
}

async function update(id, input) {
  const current = await db('providers').where({ id }).first();
  if (!current) throw new HttpError(404, `提供商「${id}」不存在`);
  const data = validate(input, { isCreate: false });
  if (Object.keys(data).length === 0) return get(id);
  await db('providers').where({ id }).update({ ...data, updated_at: now() });
  return get(id);
}

async function remove(id) {
  const deleted = await db('providers').where({ id }).del();
  if (!deleted) throw new HttpError(404, `提供商「${id}」不存在`);
  return { id };
}

/** 拖拽排序：传入按顺序排列的 id 数组，按 10 递增写回 sort_order（组内顺序由前端保证） */
async function reorder(orderedIds) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
    throw new HttpError(400, 'orderedIds 需为非空数组');
  }
  const ts = now();
  await db.transaction(async (trx) => {
    let order = 10;
    for (const id of orderedIds) {
      const updated = await trx('providers').where({ id: String(id) }).update({ sort_order: order, updated_at: ts });
      if (updated) order += 10;
    }
  });
  return list();
}

module.exports = {
  ADAPTERS,
  REJECT_POLICIES,
  HttpError,
  list,
  get,
  getWithKey,
  create,
  update,
  remove,
  reorder,
};
