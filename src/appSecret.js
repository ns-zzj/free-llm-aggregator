'use strict';

/**
 * 凭据加密主密钥（APP_SECRET）的解析 —— 用户裁定 2026-09-12：
 *   "app_secret 没有就随机生成吧。都 docker 了讲的不就是开箱即用。"
 *
 * 所以顺序是：
 *   1) 环境变量 APP_SECRET 有值 → 用它（老部署/想自己管密钥的人不受影响）
 *   2) 否则看数据目录里的 `app-secret.key`（有就用）
 *   3) 都没有 → **随机生成一个并存进那个文件**（重启、重建容器都还是它）
 *
 * 为什么存文件而不是存库：加密模块要在数据库迁移**之前**就绪（迁移本身可能写入加密字段），
 * 存库会变成先有鸡还是先有蛋。放数据目录旁边，跟库一起备份、一起挂卷，语义最清楚。
 *
 * 代价（如实说）：密钥和密文躺在一起，拿到文件就能解开里面的上游 key ——
 * 但配置文件（normal.env）放在项目里本来就是同一个风险等级，而这样换来的是"装完就能跑"。
 * 想更严就显式设 APP_SECRET（比如注入密钥、或者放在别处只挂进来）。
 */

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');

const FILE_NAME = 'app-secret.key';
const MIN_LENGTH = 16;

function generate() {
  return nodeCrypto.randomBytes(32).toString('base64');
}

/**
 * 解析主密钥。
 * @param {{ dataDir: string, envSecret?: string }} options - dataDir 是数据目录（DB 所在目录）
 * @returns {{ secret: string, source: 'env'|'file'|'generated'|'ephemeral', file: string|null, note: string|null, error: string|null }}
 */
function resolveAppSecret({ dataDir, envSecret } = {}) {
  const fromEnv = String(envSecret || '').trim();
  const dir = dataDir ? String(dataDir) : null;
  const file = dir && dir !== ':memory:' ? path.join(dir, FILE_NAME) : null;
  let saved = null;

  if (file) {
    try {
      if (fs.existsSync(file)) {
        const text = fs.readFileSync(file, 'utf8').trim();
        if (text) saved = text;
      }
    } catch (err) {
      saved = null; // 读不出来就当作没有，下面走生成分支
    }
  }

  if (fromEnv) {
    // 环境变量优先。但两个都在、且不一样时要说一声 —— 那通常意味着"换了密钥"，
    // 已存的上游 apiKey 会解不开（这是最容易让人摸不着头脑的故障）。
    const note =
      saved && saved !== fromEnv
        ? '环境变量 APP_SECRET 与 data/app-secret.key 里的值不一致，将按环境变量来（用旧值加密的上游 key 可能解不开）'
        : null;

    // 审计 H3：文档一直说"备份 = 打包 data/ 目录"，可要是密钥只来自环境变量 / normal.env（或
    // compose 注入），那句话就是假的 —— 只备份 data/ 会永久丢掉密钥。
    // 所以这里一律把环境变量里的密钥**落一份到数据目录**，让文档成立。
    // （以前有个 APP_SECRET_NO_PERSIST=1 可以不落盘，用户 2026-09-13 让删掉了：那个开关很冷门，
    //   而且一旦用了"备份 data/ 就够"这句话又不成立，徒增一个要记的例外。）
    let persisted = saved ? file : null;
    if (!persisted && file) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${fromEnv}\n`, { mode: 0o600 });
        persisted = file;
      } catch (err) {
        persisted = null; // 写不进去就算（只读卷），下面的 note 会提醒备份要带上环境变量
      }
    }
    const persistNote =
      !persisted && file
        ? '注意：这个密钥没能落盘（数据目录不可写），**备份时必须一并保存 APP_SECRET 环境变量**，只备份 data/ 不够'
        : null;
    return {
      secret: fromEnv,
      source: 'env',
      file: persisted,
      note: [note, persistNote].filter(Boolean).join('；') || null,
      error: null,
    };
  }

  if (saved) return { secret: saved, source: 'file', file, note: null, error: null };

  const generated = generate();
  if (!file) {
    return { secret: generated, source: 'ephemeral', file: null, note: null, error: null };
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
    return { secret: generated, source: 'generated', file, note: null, error: null };
  } catch (err) {
    // 写不进去（权限/只读卷）也别让服务起不来：用内存里这个，但重启就换 → 上面会警告
    return { secret: generated, source: 'ephemeral', file, note: null, error: err.message };
  }
}

module.exports = { FILE_NAME, MIN_LENGTH, resolveAppSecret };
