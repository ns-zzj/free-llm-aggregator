'use strict';

/**
 * 初始表结构 —— 对应 docs/设计文档.md §8
 * 说明：时间统一用 epoch 毫秒（INTEGER）；布尔用 0/1。
 */

exports.up = async function up(knex) {
  // 提供商配置
  await knex.schema.createTable('providers', (t) => {
    t.string('id').primary();                                   // slug，如 modelscope
    t.string('name').notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.boolean('is_paid').notNullable().defaultTo(false);
    t.string('adapter').notNullable().defaultTo('openai-compatible');
    t.string('base_url').notNullable();
    t.text('api_key_enc');                                      // libsodium secretbox 密文（base64）
    t.string('account_id');                                     // Cloudflare 用
    t.string('proxy_url');
    t.string('reject_policy').notNullable().defaultTo('cooldown_probe');
    t.integer('cooldown_seconds').notNullable().defaultTo(300);
    t.string('probe_model');
    t.text('rate_limits');                                      // ★速率填写框 JSON：[{kind:'rpm',value:40}]；value=0 表示不做本地限制
    t.integer('sort_order').notNullable().defaultTo(0);
    t.text('notes');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  // 模型配置（挂在提供商下）
  await knex.schema.createTable('provider_models', (t) => {
    t.increments('id');
    t.string('provider_id')
      .notNullable()
      .references('id')
      .inTable('providers')
      .onDelete('CASCADE');
    t.string('model_id').notNullable();                          // 上游真实模型 id
    t.string('display_name');                                    // 对外暴露名（留空=model_id）
    t.text('aliases');                                           // JSON 数组
    t.boolean('enabled').notNullable().defaultTo(true);
    t.text('rate_override');                                     // JSON：模型级速率覆盖（M2 用）
    t.integer('context_tokens');
    t.text('notes');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.unique(['provider_id', 'model_id']);
  });

  // 客户端访问口令（只存哈希）
  await knex.schema.createTable('access_keys', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.text('key_hash').notNullable();
    t.boolean('enabled').notNullable().defaultTo(true);
    t.text('notes');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  // 速率/额度运行态（M2 使用）
  await knex.schema.createTable('rate_state', (t) => {
    t.string('provider_id')
      .notNullable()
      .references('id')
      .inTable('providers')
      .onDelete('CASCADE');
    t.string('model_id').notNullable().defaultTo('');
    t.string('window_kind').notNullable();                       // rpm / rpd / ...
    t.integer('used').notNullable().defaultTo(0);
    t.bigInteger('window_start');
    t.bigInteger('next_slot_at');
    t.integer('quota_used').notNullable().defaultTo(0);
    t.bigInteger('quota_reset_at');
    t.bigInteger('updated_at');
    t.primary(['provider_id', 'model_id', 'window_kind']);
  });

  // 来源状态（可用 / 冷却 / 停用 / 额度耗尽）
  await knex.schema.createTable('source_state', (t) => {
    t.string('provider_id')
      .primary()
      .references('id')
      .inTable('providers')
      .onDelete('CASCADE');
    t.string('status').notNullable().defaultTo('available');
    t.text('reason');
    t.bigInteger('cooldown_until');
    t.bigInteger('next_probe_at');
    t.integer('consecutive_failures').notNullable().defaultTo(0);
    t.text('last_error');
    t.bigInteger('last_success_at');
    t.bigInteger('updated_at');
  });

  // 调用日志
  await knex.schema.createTable('call_log', (t) => {
    t.increments('id');
    t.bigInteger('ts').notNullable();
    t.string('request_model');
    t.string('provider_id');
    t.string('real_model');
    t.string('status');                                          // ok | fallback | fail
    t.boolean('is_paid_fallback').notNullable().defaultTo(false);
    t.boolean('is_probe').notNullable().defaultTo(false);
    t.string('error_type');
    t.integer('latency_ms');
    t.integer('prompt_tokens');
    t.integer('completion_tokens');
    t.string('request_id');
    t.text('detail');
    t.index(['ts']);
    t.index(['provider_id']);
  });

  // 全局设置
  await knex.schema.createTable('settings', (t) => {
    t.string('key').primary();
    t.text('value');
    t.bigInteger('updated_at');
  });
};

exports.down = async function down(knex) {
  const tables = [
    'settings',
    'call_log',
    'source_state',
    'rate_state',
    'access_keys',
    'provider_models',
    'providers',
  ];
  for (const table of tables) {
    await knex.schema.dropTableIfExists(table);
  }
};
