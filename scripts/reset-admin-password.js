'use strict';

/**
 * 重置管理后台口令（忘了口令时用）。
 *
 *   node scripts/reset-admin-password.js              # 从标准输入读新口令（推荐）
 *   echo '新口令' | node scripts/reset-admin-password.js
 *   node scripts/reset-admin-password.js 新口令        # 也能用，但会进 shell 历史和 ps（审计 L7）
 *
 * 服务在运行时也能执行（SQLite 会短暂加锁，稍等即可）。
 */

const cryptoUtil = require('../src/crypto');
const { db, migrate } = require('../src/db');
const settings = require('../src/store/settings');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });
}

async function main() {
  // 命令行参数不再推荐：口令会留在 shell 历史、也会出现在同机器其他用户的 ps 输出里
  const fromArgv = process.argv[2];
  let next = fromArgv;
  if (!next) {
    if (process.stdin.isTTY) {
      console.error('请从标准输入提供新口令，例如：');
      console.error("  echo '新口令' | node scripts/reset-admin-password.js");
      console.error('（命令行直接传口令虽然也支持，但会进 shell 历史和 ps，不建议）');
      process.exit(1);
    }
    next = await readStdin();
  }
  const value = String(next || '').trim();
  if (value.length < 6) {
    console.error('新口令至少 6 位。用法：echo "新口令" | node scripts/reset-admin-password.js');
    process.exit(1);
  }
  await cryptoUtil.init();
  await migrate();
  // 走 settings 的写入路径：加密存一份 + 清掉旧格式那一行 + 让已登录会话立即失效（审计 M4）
  await settings.setAdminPassword(value);
  console.log('已重置管理后台口令。用新口令登录 http://localhost:8787/admin 即可。');
  console.log('（原有登录会话已全部失效）');
  await db.destroy();
}

main().catch((err) => {
  console.error(`重置失败：${err.message}`);
  process.exitCode = 1;
});
