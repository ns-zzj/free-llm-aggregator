'use strict';

/**
 * 凭据加密 —— 全部使用现成库，不自研密码学：
 *  - 上游 apiKey / 下游访问口令 / 管理口令：libsodium (NaCl) 的 secretbox 认证加密
 *
 * 管理口令 2026-09-15 起**不再用 argon2 哈希**（用户要求）：改成和下游 apikey 同一套
 * 可逆加密。理由一是省资源（argon2 每次校验 64 MiB 内存 + 3 轮计算，而"失败锁定"本身
 * 已经能挡住爆破），二是少一个原生模块（argon2 要编译，镜像构建也更麻烦）。
 * 代价如实写在 README「已知限制」里：**数据目录 + APP_SECRET 一起泄露 = 管理口令明文**。
 */

const sodiumFactory = require('libsodium-wrappers');

const config = require('./config');

const CIPHER_VERSION = 'v1';
const KEY_BYTES = 32;

let sodium = null;
let cryptoKey = null;

/**
 * 初始化：校验主密钥并派生加密密钥。
 *
 * 主密钥本身由 `src/appSecret.js` 解析（环境变量 → 数据目录里的 app-secret.key → 自动生成并落盘），
 * 所以这里正常情况下一定拿得到；只剩"有人显式填了个太短的"这一种错误要拦。
 */
async function init() {
  await sodiumFactory.ready;
  sodium = sodiumFactory;

  if (!config.appSecret) {
    throw new Error('缺少 APP_SECRET（凭据加密主密钥）：正常情况下会自动生成到数据目录，请检查数据目录是否可写');
  }
  if (config.appSecret.length < 16) {
    throw new Error(
      'APP_SECRET 太短（<16 字符）：要么删掉它让程序自动生成，要么换一个 ≥32 字符的随机串，' +
        '生成示例：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }

  // 用 BLAKE2b 把任意长度的主密钥派生成 32 字节密钥
  cryptoKey = sodium.crypto_generichash(KEY_BYTES, Buffer.from(config.appSecret, 'utf8'));
  return true;
}

function assertReady() {
  if (!sodium || !cryptoKey) {
    throw new Error('加密模块未初始化：启动时应先 await crypto.init()');
  }
}

/** 加密字符串 → "v1:base64(nonce):base64(密文)"；空值返回 null */
function encrypt(plainText) {
  assertReady();
  if (plainText === null || plainText === undefined || plainText === '') return null;
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(String(plainText), nonce, cryptoKey);
  return `${CIPHER_VERSION}:${Buffer.from(nonce).toString('base64')}:${Buffer.from(cipher).toString('base64')}`;
}

/** 解密；失败抛出可读错误（最常见原因是 APP_SECRET 换了） */
function decrypt(encoded) {
  assertReady();
  if (!encoded) return null;
  const parts = String(encoded).split(':');
  if (parts.length !== 3 || parts[0] !== CIPHER_VERSION) {
    throw new Error('密文格式无法识别（可能来自旧版本或数据已损坏）');
  }
  const nonce = Buffer.from(parts[1], 'base64');
  const cipher = Buffer.from(parts[2], 'base64');
  let plain;
  try {
    plain = sodium.crypto_secretbox_open_easy(cipher, nonce, cryptoKey);
  } catch (err) {
    throw new Error('解密失败：APP_SECRET 是否与加密时一致？');
  }
  if (!plain || typeof plain === 'boolean') {
    throw new Error('解密失败：APP_SECRET 是否与加密时一致？');
  }
  return Buffer.from(plain).toString('utf8');
}

/** 界面上回显用的掩码：sk-abc***xyz */
function mask(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-3)}`;
}

module.exports = {
  init,
  encrypt,
  decrypt,
  mask,
};
