'use strict';

/**
 * 对外模型名的**唯一出处**（以后改名字只改这个文件）。
 *
 * 规则（用户裁定 2026-09-11）：
 *   All                          —— 虚拟模型：按「All模型顺序」页的拖拽顺序自动选源，失败换下一个
 *   Free/<来源id>/<上游模型名>    —— 免费来源的具体模型（定死这一个来源，**不换源**）
 *   Pay/<来源id>/<上游模型名>     —— 付费来源的具体模型（同上）
 *   ModelGroup/<组名>            —— 用户自己排的一组：组内顺序 = 优先级，失败往下换，可以混免费付费
 *
 * 两个刻意的口径：
 *   1) 前缀**大小写不敏感**（`pay/`、`MODELGROUP/` 也认），但对外一律发布规范写法。
 *      这样升级那一刻，老客户端里写着的 `PAY/xxx/yyy` 不会当场断掉。
 *   2) `auto` 不再认 —— 报错时明确让人改成 `All`，而不是给一句"模型不存在"。
 *
 * 模型名里的斜杠是允许的（上游经常是 `ZhipuAI/GLM-5.3-Flash` 这种），
 * 所以解析只按**第一个**斜杠切来源 id，剩下的整段都是模型名。
 */

const ALL = 'All';
const FREE_PREFIX = 'Free/';
const PAY_PREFIX = 'Pay/';
const GROUP_PREFIX = 'ModelGroup/';
const LEGACY_ALL = 'auto';

/** 具体模型对外的完整名字 */
function modelName({ providerId, modelId, isPaid }) {
  return `${isPaid ? PAY_PREFIX : FREE_PREFIX}${providerId}/${modelId}`;
}

/** 模型组对外的完整名字 */
function groupName(name) {
  return `${GROUP_PREFIX}${name}`;
}

/** 日志「来源」列用的标签：`Free/来源id` 或 `Pay/来源id` */
function sourceLabel(providerId, isPaid) {
  return `${isPaid ? PAY_PREFIX : FREE_PREFIX}${providerId}`;
}

function startsWithPrefix(value, prefix) {
  return value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

/**
 * 解析客户端请求里的模型名 → 结构化结果（纯函数，不查库）：
 *   { kind: 'all' }
 *   { kind: 'group',  name }
 *   { kind: 'pinned', providerId, modelName, isPaid }
 *   { kind: 'no-prefix', providerId, modelName }   没写 Free/ 或 Pay/（调用方查一下来源再给提示）
 *   { kind: 'invalid', reason }
 */
function parse(raw) {
  const wanted = String(raw || '').trim();
  if (!wanted) return { kind: 'invalid', reason: '缺少模型名' };

  const lower = wanted.toLowerCase();
  if (lower === ALL.toLowerCase()) return { kind: 'all' };
  if (lower === LEGACY_ALL) {
    return { kind: 'invalid', reason: `\`${LEGACY_ALL}\` 已改名为 \`${ALL}\`，请把模型名改成 \`${ALL}\`` };
  }
  if (startsWithPrefix(wanted, GROUP_PREFIX)) {
    const name = wanted.slice(GROUP_PREFIX.length).trim();
    if (!name) return { kind: 'invalid', reason: `模型组名不能为空，写法是 ${GROUP_PREFIX}<组名>` };
    return { kind: 'group', name };
  }

  let isPaid = null;
  let rest = '';
  if (startsWithPrefix(wanted, FREE_PREFIX)) {
    isPaid = false;
    rest = wanted.slice(FREE_PREFIX.length);
  } else if (startsWithPrefix(wanted, PAY_PREFIX)) {
    isPaid = true;
    rest = wanted.slice(PAY_PREFIX.length);
  }

  if (isPaid === null) {
    // 没写类别前缀：可能是老写法（<来源id>/<模型名>），也可能是连来源都没带
    const slash = wanted.indexOf('/');
    if (slash > 0 && slash < wanted.length - 1) {
      return { kind: 'no-prefix', providerId: wanted.slice(0, slash), modelName: wanted.slice(slash + 1) };
    }
    return { kind: 'invalid', reason: fullNameHint() };
  }

  const firstSlash = rest.indexOf('/');
  if (firstSlash <= 0 || firstSlash === rest.length - 1) return { kind: 'invalid', reason: fullNameHint() };
  return {
    kind: 'pinned',
    providerId: rest.slice(0, firstSlash),
    modelName: rest.slice(firstSlash + 1),
    isPaid,
  };
}

function fullNameHint() {
  return `模型名要写全：${FREE_PREFIX}<来源id>/<模型名>（免费）或 ${PAY_PREFIX}<来源id>/<模型名>（付费）`;
}

/** 组名规则：不许带斜杠和空白（否则 ModelGroup/a/b 没法解析）、长度限制 */
function validateGroupName(raw) {
  const name = String(raw || '').trim();
  if (!name) return { ok: false, reason: '组名不能为空' };
  if (name.length > 64) return { ok: false, reason: '组名最多 64 个字符' };
  if (/[\/\\]/.test(name)) return { ok: false, reason: '组名里不能有斜杠' };
  if (/\s/.test(name)) return { ok: false, reason: '组名里不能有空格' };
  return { ok: true, name };
}

module.exports = {
  ALL,
  FREE_PREFIX,
  PAY_PREFIX,
  GROUP_PREFIX,
  modelName,
  sourceLabel,
  groupName,
  parse,
  fullNameHint,
  validateGroupName,
};
