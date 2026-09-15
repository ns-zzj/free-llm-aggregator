'use strict';

/**
 * 009：模型加一列「支持图片理解」（`supports_vision`）。
 *
 * 用户 2026-09-12 的设计：
 *   - 虚拟名字（`All` / `ModelGroup/<组名>`）**永远对外声明"能收图"** ——
 *     因为下游客户端只在拉 `/v1/models` 时看一眼能力，之后不会动态调整（用户原话：
 *     "给下游发能不能接受图片都不能动态调整，下游只会获取一次这个模型能不能发图片"），
 *     所以只能先答应下来，真收到图之后再按能力筛源；
 *   - 具体模型（`Free/…` / `Pay/…`）按这一列的标记对外声明；
 *   - 收到带图的请求时，只把候选缩小到这一列为真的模型；一个都没有就报错（不偷偷丢图）。
 *
 * 默认 0（不支持）：老数据升级过来不会凭空多出一个"能看图"的假能力。
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('provider_models', (t) => {
    t.integer('supports_vision').notNullable().defaultTo(0);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('provider_models', (t) => {
    t.dropColumn('supports_vision');
  });
};
