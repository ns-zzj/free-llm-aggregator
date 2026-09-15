'use strict';

/**
 * 003：来源状态补一个"最近失败的上游模型"。
 *
 * 为什么需要：同一个提供商下，不同模型的额度/限流往往是各自独立的
 * （典型例子：ModelScope 上今天这个模型用完了、另一个还正常）。
 * 所以恢复探测不该死盯着某个固定模型，而应该**优先去探那个刚刚失败的模型**——
 * 探它恢复了，才说明真正卡住的那条路通了。
 *
 * 说明：providers.probe_model 字段废弃不再使用（UI 已移除），列保留以免动表。
 */

exports.up = async function up(knex) {
  await knex.schema.alterTable('source_state', (t) => {
    t.string('last_failed_model');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('source_state', (t) => {
    t.dropColumn('last_failed_model');
  });
};
