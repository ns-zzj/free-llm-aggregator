'use strict';

/**
 * 005：状态从"提供商级"细化到"(提供商, 上游模型)级"。
 *
 * 为什么：同一个提供商下不同模型的额度/限流往往是各自独立的
 * （典型：ModelScope 上今天这个模型用完了，同家的另一个还正常）。
 * 旧实现一个模型挂了会把整个提供商标记成冷却，同家其它模型被一起跳过。
 *
 * 回填：把旧的提供商级状态**复制到该提供商下每个已配置模型**，
 * 保证升级瞬间的行为与升级前一致；之后各模型再各自独立演化。
 *
 * 顺带丢掉 003 加的 last_failed_model（新表主键里已经有模型了，不再需要提示字段）。
 */

const STATE_COLUMNS = [
  'status',
  'reason',
  'cooldown_until',
  'next_probe_at',
  'consecutive_failures',
  'last_error',
  'last_success_at',
  'updated_at',
];

exports.up = async function up(knex) {
  await knex.schema.createTable('source_state_v2', (t) => {
    t.string('provider_id')
      .notNullable()
      .references('id')
      .inTable('providers')
      .onDelete('CASCADE');
    t.string('model_id').notNullable().defaultTo('');
    t.string('status').notNullable().defaultTo('available');
    t.text('reason');
    t.bigInteger('cooldown_until');
    t.bigInteger('next_probe_at');
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.text('last_error');
    t.bigInteger('last_success_at');
    t.bigInteger('updated_at');
    t.primary(['provider_id', 'model_id']);
  });

  const oldRows = await knex('source_state').select('*');
  for (const row of oldRows) {
    const payload = { provider_id: row.provider_id, model_id: '' };
    for (const column of STATE_COLUMNS) payload[column] = row[column];

    // eslint-disable-next-line no-await-in-loop
    const models = await knex('provider_models').where({ provider_id: row.provider_id }).select('model_id');
    if (models.length === 0) {
      // 该提供商还没配模型：留一条 model_id 为空的记录，等模型加上来再说
      // eslint-disable-next-line no-await-in-loop
      await knex('source_state_v2').insert(payload);
      continue;
    }
    for (const model of models) {
      // eslint-disable-next-line no-await-in-loop
      await knex('source_state_v2').insert({ ...payload, model_id: model.model_id });
    }
  }

  await knex.schema.dropTable('source_state');
  await knex.schema.renameTable('source_state_v2', 'source_state');
};

exports.down = async function down(knex) {
  await knex.schema.createTable('source_state_old', (t) => {
    t.string('provider_id').primary().references('id').inTable('providers').onDelete('CASCADE');
    t.string('status').notNullable().defaultTo('available');
    t.text('reason');
    t.bigInteger('cooldown_until');
    t.bigInteger('next_probe_at');
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.text('last_error');
    t.bigInteger('last_success_at');
    t.bigInteger('updated_at');
    t.string('last_failed_model');
  });

  const rows = await knex('source_state').select('*');
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.provider_id)) continue; // 回退时只保留每个提供商的第一条
    seen.add(row.provider_id);
    const payload = { provider_id: row.provider_id, last_failed_model: row.model_id || null };
    for (const column of STATE_COLUMNS) payload[column] = row[column];
    // eslint-disable-next-line no-await-in-loop
    await knex('source_state_old').insert(payload);
  }

  await knex.schema.dropTable('source_state');
  await knex.schema.renameTable('source_state_old', 'source_state');
};
