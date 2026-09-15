'use strict';

/**
 * 002：调用日志补两个字段
 *  - ttfb_ms  首字节延迟（流式场景有意义）
 *  - is_stream 本次是否为流式请求
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('call_log', (t) => {
    t.integer('ttfb_ms');
    t.boolean('is_stream').notNullable().defaultTo(false);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('call_log', (t) => {
    t.dropColumn('ttfb_ms');
    t.dropColumn('is_stream');
  });
};
