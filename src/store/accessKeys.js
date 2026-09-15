'use strict';

/**
 * 下游访问口令（客户端调 /openai/* 或 /anthropic/* 用的 key）。
 *
 * 存储（用户裁定 2026-09-12）：**只存能还原的那一份** —— 用 APP_SECRET 加密的密文 `key_enc`。
 *   校验：解密出来做常量时间比对（不再是哈希比对）。
 *   后台：靠同一份密文显示掩码 / 一键复制。
 * 以前是"哈希（校验）+ 密文（显示）"两套，但密文既然在库里，哈希就不再提供额外保护，
 * 只带来"两套真相"。详见 migrations/20260915_0010_access_key_no_hash.js 里的取舍说明。
 *
 * 管理口令 2026-09-15 起也用同一套（以前是 argon2 哈希）—— 见 src/store/settings.js 的 passwordState。
 */

const nodeCrypto = require('crypto');

const { db } = require('../db');
const cryptoUtil = require('../crypto');
const { HttpError } = require('./providers');

const KEY_PREFIX = 'sk-';

function now() {
  return Date.now();
}

/** 界面展示用：sk- 前缀保留，其余全打码（用户要求"让你知道你输进去的是 apikey"） */
function maskKey(plain) {
  if (!plain) return '';
  const body = String(plain).replace(/^sk-/, '');
  return `sk-${'*'.repeat(Math.max(body.length, 8))}`;
}

function toApi(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    enabled: !!row.enabled,
    notes: row.notes || '',
    hasPlaintext: !!row.key_enc,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 去掉用户可能多打的 sk- 前缀，再统一补上 */
function normalizeKey(input) {
  const raw = String(input || '').trim().replace(/^sk-+/i, '');
  return raw ? `${KEY_PREFIX}${raw}` : '';
}

function generateKey() {
  return `${KEY_PREFIX}agg-${nodeCrypto.randomBytes(24).toString('base64url')}`;
}

async function list() {
  const rows = await db('access_keys').orderBy('id', 'asc');
  return rows.map(toApi);
}

/** 创建口令；明文加密存一份（既用来校验，也用来回显/复制） */
async function create({ name, key, notes } = {}) {
  const label = String(name || '').trim();
  if (!label) throw new HttpError(400, '名称不能为空（例如"我的笔电"）');
  const plain = String(key || '').trim() || generateKey();
  if (plain.length < 8) throw new HttpError(400, '口令太短：至少 8 位');
  const ts = now();
  const [id] = await db('access_keys').insert({
    name: label,
    key_enc: cryptoUtil.encrypt(plain),
    enabled: 1,
    notes: notes ? String(notes) : null,
    created_at: ts,
    updated_at: ts,
  });
  return { ...toApi(await db('access_keys').where({ id }).first()), plaintext: plain };
}

async function update(id, input = {}) {
  const row = await db('access_keys').where({ id }).first();
  if (!row) throw new HttpError(404, '口令不存在');
  const data = { updated_at: now() };
  if (input.name !== undefined) {
    const label = String(input.name).trim();
    if (!label) throw new HttpError(400, '名称不能为空');
    data.name = label;
  }
  if (input.enabled !== undefined) data.enabled = input.enabled ? 1 : 0;
  if (input.notes !== undefined) data.notes = String(input.notes) || null;
  await db('access_keys').where({ id }).update(data);
  return toApi(await db('access_keys').where({ id }).first());
}

/** 一键更换口令：生成新口令并替换密文 */
async function rotate(id) {
  const row = await db('access_keys').where({ id }).first();
  if (!row) throw new HttpError(404, '口令不存在');
  const plain = generateKey();
  await db('access_keys').where({ id }).update({
    key_enc: cryptoUtil.encrypt(plain),
    updated_at: now(),
  });
  return { ...toApi(await db('access_keys').where({ id }).first()), plaintext: plain };
}

async function remove(id) {
  const deleted = await db('access_keys').where({ id }).del();
  if (!deleted) throw new HttpError(404, '口令不存在');
  return { id };
}

/**
 * 后台「密码」页用的那一条：取最早创建的启用口令。
 * 返回明文 + 掩码；解不开（APP_SECRET 换过 / 老数据没密文）时明文为 null，界面会提示重新生成。
 */
async function primary() {
  const row = await db('access_keys').where({ enabled: 1 }).orderBy('id', 'asc').first();
  if (!row) return null;
  const plain = decryptRow(row);
  return { ...toApi(row), key: plain, masked: plain ? maskKey(plain) : '' };
}

/**
 * 「更改 apikey」：**换掉下游口令** —— 删掉所有旧口令、建一条新的。
 * 用户的设计是"一个框管一条口令"，所以这里语义就是"替换"，不做多条并存。
 */
async function change(input, { name = '下游请求口令' } = {}) {
  const plain = normalizeKey(input) || generateKey();
  if (plain.length < 8) throw new HttpError(400, '口令太短：至少 8 位（sk- 之后至少 5 位）');
  const ts = now();
  await db('access_keys').del();
  const [id] = await db('access_keys').insert({
    name,
    key_enc: cryptoUtil.encrypt(plain),
    enabled: 1,
    notes: '后台「密码」页设置',
    created_at: ts,
    updated_at: ts,
  });
  return { ...toApi(await db('access_keys').where({ id }).first()), plaintext: plain, masked: maskKey(plain) };
}

/**
 * 校验客户端口令：把库里每条启用口令**解密出来**做常量时间比对。
 * 解不开（APP_SECRET 换过 / 老数据没密文）就跳过并记一条警告 —— 那种行已经无法使用，
 * 后台会提示重新生成一条。
 */
async function verify(plain) {
  const candidate = String(plain || '').trim();
  if (!candidate) return false;
  const rows = await db('access_keys').where({ enabled: 1 });
  const wanted = Buffer.from(candidate, 'utf8');
  for (const row of rows) {
    const stored = decryptRow(row);
    if (!stored) continue;
    const known = Buffer.from(stored, 'utf8');
    if (known.length === wanted.length && nodeCrypto.timingSafeEqual(known, wanted)) return true;
  }
  return false;
}

/** 解密某一行（解不开返回 null，不抛：调用方要么放行失败、要么当作"显示不出来"） */
function decryptRow(row) {
  if (!row || !row.key_enc) return null;
  try {
    return cryptoUtil.decrypt(row.key_enc);
  } catch (err) {
    return null;
  }
}

async function count({ onlyEnabled = false } = {}) {
  const query = db('access_keys').count({ n: '*' });
  if (onlyEnabled) query.where({ enabled: 1 });
  const row = await query.first();
  return Number(row?.n || 0);
}

/**
 * 有几条口令是**没法用的**：没有密文（0010 之前的老数据，或者 APP_SECRET 换过导致解不开）。
 * 启动时提示一次，让用户知道要去后台「密码」页点「更改 apikey」换一条。
 */
async function countUnusable() {
  const rows = await db('access_keys').where({ enabled: 1 });
  return rows.filter((row) => !decryptRow(row)).length;
}

module.exports = {
  KEY_PREFIX,
  list,
  create,
  update,
  rotate,
  remove,
  primary,
  change,
  verify,
  count,
  countUnusable,
  decryptRow,
  generateKey,
  maskKey,
  normalizeKey,
};
