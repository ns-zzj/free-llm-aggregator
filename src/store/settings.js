'use strict';

/**
 * 全局设置（键值表）+ 管理口令的初始化/校验
 */

const nodeCrypto = require('crypto');

const { db } = require('../db');
const cryptoUtil = require('../crypto');
const { HttpError } = require('./providers');

const DEFAULTS = {
  allow_no_key: 'false',            // 是否允许不带口令访问 /v1/*
  // 注：「管理端只允许内网来源」以前是这里的一个设置项（admin_local_only，后台「设置」页可切）。
  // 用户 2026-09-13 把它删了 —— 公网放不放行现在只看环境变量 ALLOW_PUBLIC_INTERNET 一个地方。
  fake_endpoints_enabled: 'true',   // usage / billing / credits 假数据端点
  probe_max_attempts: '10',         // 连续探测多少次没恢复就转"需人工"（0 = 一直探测）
  // 倒计时探测的等待时长表（退避）：第 N 项 = 第 N 次探测前等多久，最后一项带"后续"含义。
  // 见 src/store/probeSchedule.js 的说明。填 0 段 = 用默认表。
  probe_backoff_seconds: JSON.stringify([15, 60, 300]),
  log_retention_days: '30',
  // 应用自己的时区（UTC 偏移小时数），默认 0 = UTC。
  // 管两件事，且必须是同一个零点：主页「今日」的统计口径 + rpd/tpd 日额度的重置时刻。
  // **不用操作系统时区、也不看 TZ 环境变量**（很多 Linux 装完就是 UTC，用户自己并没意识到）。
  // 见 src/store/timezone.js 的说明。填 8 = UTC+8，5.5 = UTC+5:30。
  utc_offset_hours: '0',
  // 对外发布的 `auto` 上下文长度（tokens）：客户端靠它决定什么时候压缩上下文。
  // auto 可能落到任何一个来源，所以只能按**最窄**的那个给。填 0 = 不发布这个字段
  // （客户端退回它自己的默认值，通常是 256k）。
  auto_context_tokens: '256000',
  // 管理口令：存的是**可逆密文**（和下游 apikey 同一套 secretbox），见下面 passwordState 的说明。
  // 旧版本存的是 argon2 哈希（键名 admin_password_hash），升级后读不出来 —— 那条单独处理。
  admin_password_enc: '',
};

const PASSWORD_KEY = 'admin_password_enc';
const LEGACY_PASSWORD_KEY = 'admin_password_hash'; // 旧版本存的 argon2 哈希，现在解不出来了

function now() {
  return Date.now();
}

async function get(key) {
  const row = await db('settings').where({ key }).first();
  if (row && row.value !== null && row.value !== undefined) return row.value;
  return Object.prototype.hasOwnProperty.call(DEFAULTS, key) ? DEFAULTS[key] : null;
}

async function getBool(key) {
  return String(await get(key)) === 'true';
}

async function getNumber(key) {
  const n = Number(await get(key));
  return Number.isFinite(n) ? n : null;
}

async function set(key, value) {
  const existing = await db('settings').where({ key }).first();
  const ts = now();
  if (existing) {
    await db('settings').where({ key }).update({ value: value === null ? null : String(value), updated_at: ts });
  } else {
    await db('settings').insert({ key, value: value === null ? null : String(value), updated_at: ts });
  }
  return get(key);
}

/** 返回全部设置（不含管理员口令哈希），供后台展示 */
async function all() {
  const rows = await db('settings').select('key', 'value');
  const merged = { ...DEFAULTS };
  // 管理口令（不管新格式还是旧的哈希）一律不往外吐：后台接口只回掩码/是否需要首次设置
  const secretKeys = new Set([PASSWORD_KEY, LEGACY_PASSWORD_KEY]);
  for (const row of rows) {
    if (secretKeys.has(row.key)) continue;
    merged[row.key] = row.value;
  }
  delete merged[PASSWORD_KEY];
  delete merged[LEGACY_PASSWORD_KEY]; // 连默认值都不回显
  return merged;
}

/**
 * 首次启动：环境变量里有 ADMIN_PASSWORD 就用它初始化（容器部署省一步）；
 * 没有也**不再报错退出** —— 让服务照常起来，由网页上的「首次设置」页来收
 * （用户裁定 2026-09-11：啥也没有的时候应该有个开始屏幕，而不是起不来、也没提示）。
 */
async function ensureAdminPasswordFromEnv(envPassword) {
  const state = await passwordState();
  if (state.state === 'ok') return { created: false, needsSetup: false, legacy: false };
  // 老格式（argon2 哈希）还在库里：**不**当成"没设过"，否则内网谁都能顺手把后台认领走。
  // 这一条只在"从旧版本升级上来"时出现，处理办法见 index.js 的启动警告。
  if (state.state === 'legacy') return { created: false, needsSetup: false, legacy: true };
  if (!envPassword) return { created: false, needsSetup: true, legacy: false };
  if (String(envPassword).length < 6) {
    throw new Error('ADMIN_PASSWORD 太短：至少 6 位（建议更长）');
  }
  await writeAdminPassword(envPassword);
  return { created: true, needsSetup: false, legacy: false };
}

/**
 * 管理口令的存储状态：
 *   `ok`     —— 有一条能解开的密文（正常）
 *   `legacy` —— 库里只有旧版本的 argon2 哈希（从旧版本升级上来的），新版本读不出来
 *   `none`   —— 啥也没有 → 走「首次设置」
 *
 * 为什么不再用哈希（用户 2026-09-15 决定）：argon2 每次校验要 64 MiB 内存 + 3 轮计算，
 * 而这条路的暴力破解本来就被"连续失败 5 次锁 5 分钟"挡着，哈希换来的那点收益不值这个成本，
 * 也少一个要编译的原生模块。改成和下游 apikey 完全一样的可逆密文 + 常量时间比对。
 *
 * 代价（README「已知限制」里也写了）：**数据目录和 APP_SECRET 一起泄露 = 管理口令明文**。
 * 本来那两样凑齐就已经等于下游 apikey 明文，所以没有多开一个新的口子。
 *
 * `legacy` 这一档**故意不当成"没设过"**：要是当成没设过，内网里谁先打开 /admin 谁就能
 * 把后台认领走 —— 静默降级比进不去严重得多。所以它按"有口令、但谁都校验不过"处理，
 * 并且在启动日志里用 error 级别把处理办法说清楚（见 src/index.js）。
 */
async function passwordState() {
  const enc = await get(PASSWORD_KEY);
  if (enc) {
    try {
      const plain = cryptoUtil.decrypt(enc);
      if (plain) return { state: 'ok', plain };
    } catch (err) {
      return { state: 'legacy' }; // 解不开：主密钥换过，或数据坏了 —— 一并按"读不出来"处理
    }
  }
  return { state: (await get(LEGACY_PASSWORD_KEY)) ? 'legacy' : 'none' };
}

/** 写管理口令：加密存一份，并清掉旧格式那一行（不然状态会一直卡在 legacy） */
async function writeAdminPassword(plain) {
  await set(PASSWORD_KEY, cryptoUtil.encrypt(plain));
  await set(LEGACY_PASSWORD_KEY, '');
  await set('admin_password_changed_at', String(now())); // 比它更早签发的会话一律作废（审计 M4）
  return { ok: true };
}

async function hasAdminPassword() {
  return (await passwordState()).state !== 'none';
}

/** 还没设置管理密码 → 需要走「首次设置」（老格式算"有"，要人工重置，见 index.js） */
async function needsSetup() {
  return !(await hasAdminPassword());
}

/** 首次设置：写入管理口令（调用方负责确认"确实还没设置过"） */
async function setAdminPassword(nextPassword) {
  const value = String(nextPassword || '');
  if (value.length < 6) throw new HttpError(400, '管理密码至少 6 位');
  return writeAdminPassword(value);
}

/** 校验管理口令：解密出来做**常量时间**比对（和下游 apikey 同一套做法） */
async function verifyAdminPassword(plain) {
  const candidate = String(plain || '');
  if (!candidate) return false;
  const state = await passwordState();
  if (state.state !== 'ok' || !state.plain) return false;
  const known = Buffer.from(state.plain, 'utf8');
  const wanted = Buffer.from(candidate, 'utf8');
  return known.length === wanted.length && nodeCrypto.timingSafeEqual(known, wanted);
}

/**
 * 修改管理口令。
 * 后台「密码」页的弹窗只让填新密码（用户设计），所以 current 允许省略 ——
 * 这条路由本身已经在管理会话之后（requireAdmin），能进来的就是已登录的管理员；
 * 传了 current 仍然会校验（给脚本/API 调用留个更严的路径）。
 */
async function changeAdminPassword(currentPassword, nextPassword) {
  if (String(currentPassword || '').trim() !== '') {
    if (!(await verifyAdminPassword(currentPassword))) {
      throw new HttpError(400, '当前口令不正确');
    }
  }
  if (String(nextPassword || '').length < 6) {
    throw new HttpError(400, '新口令至少 6 位');
  }
  return writeAdminPassword(nextPassword);
}

module.exports = {
  DEFAULTS,
  get,
  getBool,
  getNumber,
  set,
  all,
  ensureAdminPasswordFromEnv,
  passwordState,
  hasAdminPassword,
  needsSetup,
  setAdminPassword,
  verifyAdminPassword,
  changeAdminPassword,
};
