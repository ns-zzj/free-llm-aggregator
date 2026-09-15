'use strict';

const knexFactory = require('knex');
const knexfile = require('../knexfile');

// 测试专用一套；其余（含 NODE_ENV=production）走生产配置。
// 审计 M6 顺带指出：以前这里是 `test ? 'test' : 'development'`，
// 于是 NODE_ENV=production 也读 development —— knexfile 里的 production 配置从来没生效过。
const envName = process.env.NODE_ENV === 'test' ? 'test' : 'production';

const db = knexFactory(knexfile[envName]);

/**
 * 执行数据库迁移（把未跑过的建表/改表脚本按顺序补上）。
 * 由服务启动时和测试里调用。
 */
async function migrate() {
  const [batch, applied] = await db.migrate.latest();
  return { batch, applied };
}

module.exports = { db, migrate };
