'use strict';

const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, 'data', 'app.db');

// 确保数据目录存在（Docker 里挂载 ./data）。权限尽量收紧：里面有数据库和主密钥文件，
// 默认的 0777 会让同机器其他用户也能读（审计 M7；Windows 上 mode 不生效，需要用 ACL，见 README）。
if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true, mode: 0o700 });
}

// 测试专用一套；其余（含 NODE_ENV=production 与默认）走生产配置。
// 注意：这里必须**先**挡住"测试打到真实库"（审计 L9）—— 测试文件都会显式把 DB_PATH 指到
// .tmp 下的临时目录，但要是哪个新测试忘了设，`dotenv` 会把 normal.env 里的 DB_PATH（真库）
// 带进来，于是测试就在真库上跑（还可能把它删了）。默认路径出现在测试环境里一定是搞错了。
const isTest = process.env.NODE_ENV === 'test';
const DEFAULT_DB_PATH = path.join(__dirname, 'data', 'app.db');
if (isTest && DB_PATH === DEFAULT_DB_PATH) {
  throw new Error(
    'NODE_ENV=test 时不能使用默认数据库路径 ' +
      DEFAULT_DB_PATH +
      '：测试必须自己把 DB_PATH 指到一个临时目录（否则会拿真实数据做实验）。'
  );
}

function buildConfig(filename) {
  return {
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    migrations: {
      directory: path.join(__dirname, 'migrations'),
      tableName: 'knex_migrations',
    },
    pool: {
      // SQLite：WAL 提升并发读；强制外键；busy 超时避免瞬时锁冲突
      afterCreate: (conn, done) => {
        try {
          conn.pragma('journal_mode = WAL');
          conn.pragma('foreign_keys = ON');
          conn.pragma('busy_timeout = 5000');
          done(null, conn);
        } catch (err) {
          done(err, conn);
        }
      },
    },
  };
}

module.exports = {
  development: buildConfig(DB_PATH),
  production: buildConfig(DB_PATH),
  test: buildConfig(process.env.DB_PATH || ':memory:'),
};
