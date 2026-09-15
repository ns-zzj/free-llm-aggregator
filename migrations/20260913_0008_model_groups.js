'use strict';

/**
 * 008：模型组（ModelGroup/<组名>）+ 删掉模型的「对外显示名 / 别名」两列。
 *
 * 用户裁定 2026-09-11：
 *   1) 命名统一成 `All` / `Free/<来源id>/<模型名>` / `Pay/<来源id>/<模型名>` /
 *      `ModelGroup/<组名>`；
 *   2) 「对外显示名」和「别名」删掉 —— "没啥用了"，模型对外名就等于
 *      `[Free|Pay]/<来源id>/<上游模型名>`，日志、/v1/models、报错提示都用这一套；
 *      库里的两列一并删，不留墓碑。
 *
 * 模型组 = 用户自己排的一套兜底链（组内顺序 = 选源优先级，允许免费与付费混排），
 * 客户端填 `ModelGroup/<组名>` 就按组内顺序试，失败往下换，换完都没有才报错。
 *
 * 建表放在 dropColumn **之后**：SQLite 删列的某些实现会重建 provider_models，
 * 先建外键引用它容易被重建搞乱。
 */

exports.up = async function up(knex) {
  // 1) 先删废弃的两列（display_name / aliases）
  await knex.schema.alterTable('provider_models', (t) => {
    t.dropColumn('display_name');
    t.dropColumn('aliases');
  });

  // 2) 模型组
  await knex.schema.createTable('model_groups', (t) => {
    t.increments('id').primary();
    t.string('name').notNullable().unique(); // 对外就是 ModelGroup/<name>
    t.integer('sort_order').notNullable().defaultTo(0);
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  // 3) 组内条目：一条 = 某个提供商下的某个模型（同一个模型可以出现在多个组里）
  await knex.schema.createTable('model_group_items', (t) => {
    t.increments('id').primary();
    t.integer('group_id')
      .notNullable()
      .references('id')
      .inTable('model_groups')
      .onDelete('CASCADE');
    t.integer('provider_model_id')
      .notNullable()
      .references('id')
      .inTable('provider_models')
      .onDelete('CASCADE');
    t.integer('sort_order').notNullable().defaultTo(0); // 组内顺序 = 优先级
    t.bigInteger('created_at').notNullable();
    t.unique(['group_id', 'provider_model_id']); // 同一个模型在一个组里只放一次
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('model_group_items');
  await knex.schema.dropTableIfExists('model_groups');
  await knex.schema.alterTable('provider_models', (t) => {
    t.string('display_name');
    t.text('aliases');
  });
};
