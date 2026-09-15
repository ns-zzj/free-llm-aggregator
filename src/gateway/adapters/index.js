'use strict';

/**
 * 适配器注册表：`provider.adapter` 的值 → 具体实现。
 * 快捷键（白名单、后台下拉框）都从这里取，避免"下拉框里有、代码里没有"。
 */

const openaiCompatible = require('./openai-compatible');
const openaiResponses = require('./openai-responses');
const anthropic = require('./anthropic');
const cloudflare = require('./cloudflare-workers-ai');

const DEFAULT_ADAPTER = openaiCompatible.id;

const LIST = [openaiCompatible, openaiResponses, anthropic, cloudflare];
const BY_ID = new Map(LIST.map((impl) => [impl.id, impl]));

function get(id) {
  return BY_ID.get(String(id || '')) || openaiCompatible;
}

/** 给后台下拉框用的元信息 */
function describeAll() {
  return LIST.map((impl) => ({
    id: impl.id,
    label: impl.label,
    baseUrlHint: impl.baseUrlHint || '',
    needsAccountId: !!impl.needsAccountId,
  }));
}

module.exports = { DEFAULT_ADAPTER, ids: LIST.map((impl) => impl.id), LIST, get, describeAll };
