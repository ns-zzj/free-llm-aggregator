'use strict';

/**
 * 010：下游访问口令**只留能还原的那一份**（删掉不可还原的 `key_hash`）。
 *
 * 用户裁定 2026-09-12：
 *   "给下游 apikey 存储改一下吧。不留不能还原的密钥了。只留能还原的那个。"
 *
 * 为什么这是对的：我们从 007 起就已经存了一份能解出来的密文（`key_enc`，libsodium secretbox），
 * 后台靠它显示掩码/一键复制。既然密文在库里，那份 argon2 哈希就**不再提供任何额外保护** ——
 * 拿到整库的人要么能拿到 APP_SECRET（那密文就是明文），要么拿不到（那哈希也只能硬碰运气，
 * 而这是一条 32 字节随机的口令，本来就没法猜）。留着它只是"两套真相"：改口令要同时写两份、
 * 判断"能不能显示"要看另一列、老数据还会出现哈希能校验但密文没有的怪状态。
 *
 * 于是校验方式也跟着变：解密出来做**常量时间比对**（比原来每条 argon2 校验还快得多）。
 *
 * 代价（如实写下来）：库 + APP_SECRET 一起泄露 = 下游口令直接暴露。这跟过去"明文写在 .env 里"
 * 的风险等级一样，但比那时可控（.env 可以删掉、密钥可以单独注入）。管理密码不受影响：
 * 它**继续只存 argon2 哈希**、不可还原 —— 那是故意的，我们要的就是它不可还原。
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('access_keys', (t) => {
    t.dropColumn('key_hash');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('access_keys', (t) => {
    // 回滚只能把列加回来（值已经没了，留空）。老版本靠它校验，所以回滚后需要重新设一次口令。
    t.text('key_hash');
  });
};
