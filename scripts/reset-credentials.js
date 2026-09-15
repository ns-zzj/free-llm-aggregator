'use strict';

/**
 * 清空凭据 → 回到「首次设置」页（忘了管理密码、又不想手动改库时用）。
 *
 *   node scripts/reset-credentials.js          # 清空管理密码 + 下游口令
 *   node scripts/reset-credentials.js --keep-key   # 只清管理密码（下游口令保留）
 *
 * Docker 里：
 *   docker exec nszzj-free-llm-aggregator node scripts/reset-credentials.js
 *
 * 特点：**不需要重启服务**（服务是按请求判断"要不要首次设置"的），执行完刷新
 * http://<主机>:8787/admin 就会看到首次设置页，在那儿重设管理密码和下游 apikey。
 * 只动这两样，"提供商/模型/日志"都不碰 —— 忘了密码，不是丢了配置。
 */

const cryptoUtil = require('../src/crypto');
const { db, migrate } = require('../src/db');
const settings = require('../src/store/settings');

/** 真正干活的部分（测试里直接 require 这个函数，不用起子进程） */
async function resetCredentials({ keepAccessKeys = false } = {}) {
  await migrate();
  const removedKeys = keepAccessKeys ? 0 : await db('access_keys').del();
  // 管理口令新老两种存法都清掉：新的是密文 admin_password_enc，旧版本是 argon2 哈希
  // （从旧版本升级上来的库只有后者 —— 那也正是这个脚本最常被用到的时候）
  await db('settings').whereIn('key', ['admin_password_enc', 'admin_password_hash']).del();
  // 记下"凭据刚被重置"这一刻：运行中的服务据此立刻作废所有已登录会话（审计 M4）。
  // 这一步必须走库（脚本是独立进程），不能只清内存。
  await settings.set('admin_password_changed_at', String(Date.now()));
  return { removedKeys, keepAccessKeys };
}

async function main() {
  const keepAccessKeys = process.argv.includes('--keep-key');
  await cryptoUtil.init();
  const result = await resetCredentials({ keepAccessKeys });
  await db.destroy();

  console.log('已清空管理密码' + (keepAccessKeys ? '（下游口令保留）' : `与下游口令（删了 ${result.removedKeys} 条）`));
  console.log('');
  console.log('不用重启服务：刷新 http://localhost:8787/admin 就会出现「首次设置」页，');
  console.log('在那儿重新设置管理密码和下游 apikey 即可。提供商/模型/日志都还在。');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`清空失败：${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { resetCredentials };
