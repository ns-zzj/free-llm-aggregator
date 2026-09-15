'use strict';

/**
 * 数据库回滚的**安全封装**（审计 M6）。
 *
 * 直接 `knex migrate:rollback` 是条危险命令 —— 0010/0009 之后每回滚一步都在删表删列，
 * 0001 的 down 更是按顺序 drop 掉 7 张表，providers 的 CASCADE 会带走 provider_models /
 * rate_state，SQLite 又没有时间点恢复。一条命令就能把全部上游凭据和配置抹掉。
 *
 * 所以这里加三个约束：
 *   1) 必须显式 `--yes`（防手滑/防脚本里被误调用）；
 *   2) **先自动备份数据目录**，备份失败就不回滚；
 *   3) 数据库用 SQLite 的**在线备份**（不是逐文件拷贝）—— 见下面 backup() 的说明。
 *
 *   node scripts/db-rollback.js --yes [--steps 1]
 *   npm run migrate:rollback -- --yes [--steps 1]
 *
 * `--steps N` = 回滚**最近的 N 个批次**（默认 1）。
 * 注意（2026-09-13 复审修的 bug）：以前这里是 spawn 了 knex 的 CLI 并传 `--all`，
 * 而 knex CLI 的 `migrate:rollback` **只认 `--all` 这个开关、不认"步数"**
 * （node_modules/knex/bin/cli.js 的 action 里只读 cmd.all，位置参数直接被忽略）。
 * 于是 `--steps 1` 实际会**回滚全部迁移** —— 一个防手滑的工具自己滑手，比原命令还狠。
 * 现在改成直接调 knex API，`all=false` 一次回滚一个批次，循环 steps 次。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const dbFile = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT, 'data', 'app.db');
const dataDir = path.dirname(dbFile);
const dbName = path.basename(dbFile);

const args = process.argv.slice(2);
const yes = args.includes('--yes');
const stepsIndex = args.indexOf('--steps');
const steps = stepsIndex >= 0 ? Number(args[stepsIndex + 1]) : 1;

if (!yes) {
  console.error('这个命令会回滚迁移（删表/删列，SQLite 没有时间点恢复），因此必须显式确认：');
  console.error('  node scripts/db-rollback.js --yes [--steps 1]');
  console.error('');
  console.error('它会在回滚前把数据目录备份一份（data-backup-<时间戳>/），备份失败就不回滚。');
  console.error('--steps N = 回滚最近 N 个批次（默认 1）；不写就是只回滚最后一批。');
  process.exit(1);
}
if (!Number.isInteger(steps) || steps < 1) {
  console.error('--steps 需要是正整数');
  process.exit(1);
}

/**
 * 备份数据目录，返回备份目录路径（没有数据目录就返回 null）。
 *
 * **数据库不能逐文件拷贝**：WAL 模式下 app.db 与 app.db-wal 是两个文件，fs.cpSync 按顺序
 * 读它们，写操作一交错就会拷出一个撕裂的库（能打开、数据不对，或者干脆打不开）——
 * 而备份恰恰是你要拿来救命的东西，不能是这种状态。
 * 所以数据库走 SQLite 自己的在线备份 API（better-sqlite3 的 db.backup()，底层 sqlite3_backup_*）：
 * 它保证快照一致，而且**服务不用停**。
 *
 * 同时**不拷** -wal / -shm：一致的 app.db 旁边再放一个旧 -wal，SQLite 会照着它去读，反而读错。
 */
async function backup() {
  if (!fs.existsSync(dataDir)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = path.join(ROOT, `data-backup-${stamp}`);
  fs.mkdirSync(dest, { recursive: true });

  // 1) 非数据库文件原样拷（app-secret.key 等）
  for (const name of fs.readdirSync(dataDir)) {
    if (name === dbName || name.startsWith(`${dbName}-`)) continue;
    fs.cpSync(path.join(dataDir, name), path.join(dest, name), { recursive: true });
  }

  // 2) 数据库走在线备份
  if (fs.existsSync(dbFile)) {
    const Database = require('better-sqlite3');
    const conn = new Database(dbFile, { readonly: true, fileMustExist: true, timeout: 5000 });
    try {
      await conn.backup(path.join(dest, dbName));
    } finally {
      conn.close();
    }
  }
  return dest;
}

/** 真正干活的部分（以后写测试可以直接 require 它） */
async function rollback({ steps: count = 1 } = {}) {
  const knexFactory = require('knex');
  const knexfile = require('../knexfile');
  const db = knexFactory(knexfile[process.env.NODE_ENV === 'test' ? 'test' : 'production']);
  const rolled = [];
  try {
    for (let i = 0; i < count; i += 1) {
      // 第二个参数 all=false：只回滚**最后一个批次**
      // eslint-disable-next-line no-await-in-loop
      const [batchNo, log] = await db.migrate.rollback({}, false);
      if (!log || log.length === 0) break; // 已经没有可回滚的了
      rolled.push({ batchNo, count: log.length, migrations: log });
    }
  } finally {
    await db.destroy().catch(() => {});
  }
  return rolled;
}

async function main() {
  let dest = null;
  try {
    dest = await backup();
  } catch (err) {
    console.error(`备份数据目录失败：${err.message} —— 已中止，不回滚。`);
    process.exit(1);
  }
  if (dest) console.log(`已备份数据目录 → ${path.relative(ROOT, dest)}`);

  let rolled;
  try {
    rolled = await rollback({ steps });
  } catch (err) {
    console.error(`回滚失败（或部分失败）：${err.message}`);
    if (dest) console.error(`备份还在：${path.relative(ROOT, dest)} —— 需要的话可以拿它恢复。`);
    process.exit(1);
  }

  if (rolled.length === 0) {
    console.log('已经到底了：没有可回滚的迁移（数据库没动）。');
  } else {
    for (const item of rolled) console.log(`批次 ${item.batchNo} 已回滚：${item.count} 个迁移`);
    console.log(`共回滚 ${rolled.length} 个批次。`);
  }
  if (dest) console.log(`要恢复就用刚备份的 ${path.relative(ROOT, dest)}。`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`回滚失败：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { backup, rollback };
