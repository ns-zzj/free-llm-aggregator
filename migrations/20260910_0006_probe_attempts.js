'use strict';

/**
 * 006：加一个"连续探测失败次数"计数器。
 *
 * 用途：倒计时探测不能无限试下去——连续探测 N 次都没恢复（N 由全局设置"倒计时检测次数上限"决定），
 * 就停止自动探测、转成「故障（需人工）」，免得对着一个修复不了的模型一直发请求。
 *
 * 与 consecutive_failures 的区别：那个统计"连续失败"（含正常调用失败），
 * 这个只统计"探测失败"且**探测成功即清零**，语义更贴合"连续检测几次"。
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('source_state', (t) => {
    t.integer('probe_attempts').notNullable().defaultTo(0);
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('source_state', (t) => {
    t.dropColumn('probe_attempts');
  });
};
