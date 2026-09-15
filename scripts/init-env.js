'use strict';

/**
 * 生成配置文件 `normal.env`（`normal.env.example` 的副本）
 *   `node scripts/init-env.js`   或   `npm run init`
 *
 * 2026-09-12 之后**什么都不填也能跑**：
 *   - 主密钥 APP_SECRET 缺省会自动生成并保存在数据目录（`data/app-secret.key`），重启/重建容器都不变；
 *   - 管理密码和下游 apikey 在网页「首次设置」页里设，不落明文文件。
 *
 * 2026-09-13 改名：以前叫 `.env`（点开头的隐藏文件），现在叫 **`normal.env`** —— 看得见的名字，
 * 不容易让人犯嘀咕。优先级是 **环境变量 > `normal.env` > 内置默认**，
 * 所以这个文件只是"没设环境变量时的保底"，不是唯一入口。
 *
 * 所以这个脚本只剩"给你一份可以改的配置模板"这个作用。
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const envPath = path.join(root, 'normal.env');
const examplePath = path.join(root, 'normal.env.example');

if (fs.existsSync(envPath)) {
  console.log('normal.env 已存在，未做任何修改（要重新生成请先删除它）。');
  process.exit(0);
}
if (!fs.existsSync(examplePath)) {
  console.error('找不到 normal.env.example，无法生成 normal.env');
  process.exit(1);
}

fs.writeFileSync(envPath, fs.readFileSync(examplePath, 'utf8'), 'utf8');

console.log('已生成 normal.env（内容全是注释和默认值，可以直接不填）。');
console.log('');
console.log('其实不生成也能跑：主密钥会自动生成到 data/app-secret.key。');
console.log('而且这个文件只是**保底**：容器/宿主机的环境变量优先级更高，设了环境变量就以它为准。');
console.log('');
console.log('只有在这些情况下才需要改它：');
console.log('  APP_SECRET                      想自己管主密钥（比如从密钥管理注入），填一个 ≥32 字符随机串');
console.log('  PORT / BIND                     改端口、或只监听某个地址');
console.log('  DB_PATH                         把数据库放到别处');
console.log('  ADMIN_TRUSTED_PEERS             套了反代 / 不用 host 网络时才需要');
console.log('');
console.log('启动日志里会有一张「每个值从哪来」的表（环境变量 / normal.env / 内置默认），');
console.log('所以改了不生效时不用猜 —— 看日志就知道是不是被环境变量盖掉了。');
console.log('');
console.log('下一步： npm start   然后打开 http://localhost:8787/admin');
console.log('        第一屏就是「首次设置」，在那儿设管理密码和下游 apikey。');
