'use strict';

/**
 * 007：访问口令加一列 **可逆加密** 的密文（`key_enc`）。
 *
 * 为什么以前只有哈希、现在要加密（用户裁定 2026-09-11）：
 *   - 以前：只存 argon2 哈希 → 安全，但**不可逆**，界面上既看不到也复制不出来，
 *     明文只能躺在 `.env`（`ACCESS_KEY=...`）里 —— 用户明确不接受"明文存配置文件"。
 *   - 现在：**哈希照旧保留**（校验走哈希，即使库泄露也难还原），
 *     额外存一份 libsodium secretbox 加密的密文（用 APP_SECRET），
 *     这样后台「密码」页能显示掩码、能一键复制，而 `.env` 里的明文可以删掉。
 *
 * 老数据：迁移前写入的行没有密文（`key_enc` 为 NULL）→ 界面会提示"原始口令不可显示，
 * 请点『更改 apikey』生成新的"，不会假装能显示。
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('access_keys', (t) => {
    t.text('key_enc');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('access_keys', (t) => {
    t.dropColumn('key_enc');
  });
};
