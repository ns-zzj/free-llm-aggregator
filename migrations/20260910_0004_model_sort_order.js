'use strict';

/**
 * 004：把"优先级"从提供商级别下移到**模型条目**级别。
 *
 * 背景（用户需求）：主页要显示"所有提供商的所有模型的集合"，并允许直接拖拽排序，
 * 越靠上越优先。这意味着一个提供商下的不同模型可以有各自的优先级
 * （例如 ModelScope 的 qwen 排在 NVIDIA 之前，但 NVIDIA 的 llama 又排在 ModelScope 的另一个模型之前）。
 *
 * 回填策略：按原来的提供商顺序 ×1000 铺开，保证升级后行为与升级前一致，
 * 用户不动手拖就察觉不到差别。
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('provider_models', (t) => {
    t.integer('sort_order').notNullable().defaultTo(0);
  });

  // 用原提供商顺序回填，保持现有优先级不变
  await knex.raw(
    'UPDATE provider_models SET sort_order = ' +
      '(SELECT providers.sort_order FROM providers WHERE providers.id = provider_models.provider_id) * 1000'
  );
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('provider_models', (t) => {
    t.dropColumn('sort_order');
  });
};
