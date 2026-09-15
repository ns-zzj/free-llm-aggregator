'use strict';

const fs = require('fs');
const path = require('path');

const { resolveAppSecret } = require('./appSecret');

const ROOT = path.join(__dirname, '..');

/**
 * 配置来源与优先级（用户 2026-09-13 定的）：
 *
 *   1) 容器 / 宿主机的**环境变量**   ← 优先用它（docker-compose.yml 的 environment: 段就在这一层）
 *   2) `normal.env` 文件             ← 保底。**只在非 Docker（npm start）时存在**：
 *                                      镜像里没有它、compose 也没挂它，所以 Docker 那条路上
 *                                      这一层是空的，链路是「环境变量 → 内置默认」。
 *   3) 程序内置的默认值              ← 上面都没有（或都不认）才用
 *
 * 名字刻意不叫 `.env`（点开头的隐藏文件）：看得见的名字更让人放心。它就是一行行 `名字=值`。
 *
 * 关键行为：**某一层给了值但值不合法 → 当作"这一层没配"，继续往下一层找**，
 * 并把"不认谁"写进启动日志（用户要求：认了啥/不认（默认用的啥）都要能看见，别让人猜）。
 * 例：环境变量 PORT=abc → 不认 → 用 normal.env 的 9000；normal.env 也没有 → 用内置默认 8787。
 *
 * 两个**故意不套这个回退**的例外（写错了就是坏配置，要吵出来而不是悄悄兜住）：
 *   - `BIND`：填了个绑不上的地址 → 启动直接失败（原来就是这样）
 *   - `APP_SECRET`：短于 16 字符 → 启动直接失败（怕你换了密钥才发现）
 */
const ENV_FILE_NAME = 'normal.env';
const ENV_FILE = path.join(ROOT, ENV_FILE_NAME);

// 读文件**之前**先留一份快照：用它区分"这个值是外面传进来的"还是"从文件里读的"
const ENV_BEFORE_FILE = { ...process.env };

const envFileExists = fs.existsSync(ENV_FILE);
const dotenvResult = require('dotenv').config({ path: ENV_FILE, quiet: true });
const FILE_VALUES = (dotenvResult && dotenvResult.parsed) || {};
const envFileError =
  dotenvResult && dotenvResult.error && envFileExists ? String(dotenvResult.error.message) : null;

const FROM_LABEL = { env: '环境变量', file: `${ENV_FILE_NAME} 文件` };

function isSet(value) {
  return value !== undefined && String(value).trim() !== '';
}

/**
 * 按「环境变量 → normal.env」的顺序，取第一个**可用**的值；都不行就用内置默认。
 *
 * @param {string} key
 * @param {{ parse?: (raw: string) => any, valid?: (parsed: any) => boolean, fallback: any,
 *           hint?: string, noteOf?: (parsed: any) => string|null }} opts
 * @returns {{ value: any, from: 'env'|'file'|'default', raw: string|null,
 *             rejected: Array<{ from: string, raw: string }>, note: string|null }}
 */
function resolveSetting(key, { parse = (v) => v, valid = () => true, fallback, hint = '', noteOf = null }) {
  const rejected = [];
  for (const from of ['env', 'file']) {
    const raw = from === 'env' ? ENV_BEFORE_FILE[key] : FILE_VALUES[key];
    if (!isSet(raw)) continue;
    const trimmed = String(raw).trim();
    const parsed = parse(trimmed);
    if (valid(parsed)) {
      return { value: parsed, from, raw: trimmed, rejected, note: noteOf ? noteOf(parsed) : null, hint };
    }
    rejected.push({ from, raw: trimmed }); // 不认：记下来，日志里要说
  }
  return { value: fallback, from: 'default', raw: null, rejected, note: null, hint };
}

/** 没做严格校验的那几个，只需要知道"最后用的是哪一层" */
function sourceOf(key) {
  if (isSet(ENV_BEFORE_FILE[key])) {
    const fileSet = isSet(FILE_VALUES[key]);
    const differs = fileSet && String(FILE_VALUES[key]).trim() !== String(ENV_BEFORE_FILE[key]).trim();
    return { source: 'env', shadowed: differs ? String(FILE_VALUES[key]).trim() : null };
  }
  if (isSet(FILE_VALUES[key])) return { source: 'file', shadowed: null };
  return { source: 'default', shadowed: null };
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 逗号分隔的地址表；顺手把"看着就不像地址"的项挑出来（打错了要能看见，别静默失效） */
function parsePeers(raw) {
  const list = [];
  const dropped = [];
  for (const item of String(raw).split(',')) {
    const s = item.trim();
    if (!s) continue;
    const looksLikeAddress = s.includes('/')
      ? /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s)
      : /^[0-9a-f:.]+$/i.test(s) && (s.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
    if (looksLikeAddress) list.push(s);
    else dropped.push(s);
  }
  return { list, dropped };
}

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(ROOT, 'data', 'app.db');

// 主密钥：环境变量 / normal.env → 数据目录里的 app-secret.key → 都没有就随机生成并落盘
const secret = resolveAppSecret({ dataDir: path.dirname(dbPath), envSecret: process.env.APP_SECRET });

/** 需要"较真"的设置项（值不合法就往下找一层，并记下不认谁） */
const SETTINGS = {
  PORT: resolveSetting('PORT', {
    parse: (v) => Number(v),
    // 0 是合法且有用的：让系统自己分配一个空闲端口（测试里就用它）
    valid: (n) => Number.isInteger(n) && n >= 0 && n <= 65535,
    fallback: 8787,
    hint: '要 0–65535 之间的整数（0 = 让系统随机分配）',
  }),
  LOG_LEVEL: resolveSetting('LOG_LEVEL', {
    parse: (v) => String(v).trim().toLowerCase(),
    valid: (s) => ['debug', 'info', 'warn', 'error'].includes(s),
    fallback: 'info',
    hint: '只能是 debug / info / warn / error',
  }),
  SESSION_TTL_MS: resolveSetting('SESSION_TTL_MS', {
    parse: (v) => Number(v),
    valid: (n) => Number.isFinite(n) && n > 0,
    fallback: 12 * 60 * 60 * 1000,
    hint: '要是大于 0 的毫秒数',
  }),
  ALLOW_PUBLIC_INTERNET: resolveSetting('ALLOW_PUBLIC_INTERNET', {
    // 用户 2026-09-13 定的：**只认 true / false**（大小写不敏感），其他一律不认。
    // 不认 / 没配 → 用**内置默认 false**（= 公网进不了后台）。
    // 后台「设置」页那个「管理端限内网」开关已被用户要求删除，所以公网放不放行只看这一个变量。
    parse: (v) => {
      const s = String(v).trim().toLowerCase();
      return s === 'true' ? true : s === 'false' ? false : null;
    },
    valid: (b) => b === true || b === false,
    fallback: false,
    hint: '只认 true / false（大小写不敏感）',
  }),
  ADMIN_TRUSTED_PEERS: resolveSetting('ADMIN_TRUSTED_PEERS', {
    parse: parsePeers,
    valid: (v) => v.list.length > 0,
    fallback: { list: [], dropped: [] },
    hint: '要逗号分隔的地址（IPv4 或 IPv4 网段；IPv6 写完整地址，不支持网段）',
    noteOf: (v) =>
      v.dropped.length ? `忽略了 ${v.dropped.length} 项不像地址的东西：${v.dropped.join(' / ')}` : null,
  }),
};

const config = {
  root: ROOT,
  port: SETTINGS.PORT.value,
  // 监听地址：留空 = 自动（先试双栈 `::`，这台机器没 IPv6 就退回 `0.0.0.0`，见 src/index.js）。
  // 显式填了就用填的那个（写错要报错，别悄悄替用户换地址）—— 所以它**不做**回退。
  bind: String(process.env.BIND || '').trim(),
  appSecret: secret.secret,
  appSecretSource: secret.source,
  // 主密钥的**真实**来源：resolveAppSecret 看到的是"读过文件之后"的 process.env，
  // 所以它会把 normal.env 里的值也报成"来自环境变量"。这里按读文件前的快照纠正回来。
  appSecretFrom: sourceOf('APP_SECRET').source,
  appSecretFile: secret.file,
  appSecretNote: secret.note,
  appSecretError: secret.error,
  adminPassword: String(process.env.ADMIN_PASSWORD || '').trim(),
  // 额外信任的"管理端来源"（反代 / Docker 网桥的地址）。默认空 = 只信环回和真正的内网直连。
  // 详见 src/net.js 的 checkAdminPeer。
  adminTrustedPeers: SETTINGS.ADMIN_TRUSTED_PEERS.value.list,
  // 后台能不能从公网直接访问：只看这一个变量（认了就是认了，不认/没配 = 内置默认 false）。
  // 后台里没有对应开关了（2026-09-13 用户要求删掉），所以这里永远是 true / false。
  adminPublicInternet: SETTINGS.ALLOW_PUBLIC_INTERNET.value,
  adminPublicInternetRaw: SETTINGS.ALLOW_PUBLIC_INTERNET.raw,
  dbPath,
  defaultCooldownSeconds: num(process.env.DEFAULT_COOLDOWN_SECONDS, 300),
  logLevel: SETTINGS.LOG_LEVEL.value,
  sessionTtlMs: SETTINGS.SESSION_TTL_MS.value,
  isTest: process.env.NODE_ENV === 'test',
  envFileName: ENV_FILE_NAME,
  envFile: ENV_FILE,
  envFileExists,
  envFileError,
  settingResolutions: SETTINGS,
};

/** 主密钥来源的人话说明（index.js 启动日志用） */
function describeAppSecretOrigin() {
  if (config.appSecretFrom === 'env') return '来自环境变量 APP_SECRET';
  if (config.appSecretFrom === 'file') return `来自 ${ENV_FILE_NAME} 文件`;
  return {
    file: `来自 ${path.basename(config.appSecretFile || 'app-secret.key')} 文件（数据目录里）`,
    generated: `已自动生成并保存到 ${config.appSecretFile}（备份数据目录就够了，重启不变）`,
    ephemeral: `临时生成（没能写入 ${config.appSecretFile || '数据目录'}：${config.appSecretError || '未知原因'}）—— 重启后会变，已存的上游 key 将无法解密`,
  }[config.appSecretSource] || `来源未知（${config.appSecretSource}）`;
}

/**
 * 启动时打一张「每个配置值从哪来」的表（用户 2026-09-13 的要求：
 * "认了啥 / 不认（默认用的啥）都要在日志里说清，别让人猜"）。
 */
function describeConfigSources() {
  const lines = [];

  const push = (key, displayValue, extra) => {
    const r = SETTINGS[key];
    let line = `  ${key.padEnd(21)} = ${String(displayValue).padEnd(24)} [${FROM_LABEL[r.from] || '内置默认'}]`;
    for (const rej of r.rejected) {
      line += `  ⚠ ${FROM_LABEL[rej.from]}给的是「${rej.raw}」，不认（${r.hint || '格式不对'}）`;
    }
    if (r.note) line += `  ⚠ ${r.note}`;
    if (extra) line += `  ${extra}`;
    lines.push(line);
  };

  push('PORT', config.port);
  push('LOG_LEVEL', config.logLevel);
  push('SESSION_TTL_MS', config.sessionTtlMs);
  push(
    'ADMIN_TRUSTED_PEERS',
    config.adminTrustedPeers.length ? config.adminTrustedPeers.join(', ') : '(无)'
  );

  // ALLOW_PUBLIC_INTERNET：认了 true 才放行；认了 false / 没配 / 不认 → 都是内置默认 false
  {
    const r = SETTINGS.ALLOW_PUBLIC_INTERNET;
    if (r.from === 'default') {
      push('ALLOW_PUBLIC_INTERNET', 'false（内置默认）', '公网进不了后台');
    } else {
      push('ALLOW_PUBLIC_INTERNET', String(r.value), r.value ? '⚠ 公网可以直接访问后台' : '公网进不了后台');
    }
  }

  // 没做严格校验、只报来源的几个
  const plain = (key, displayValue) => {
    const info = sourceOf(key);
    let line = `  ${key.padEnd(21)} = ${String(displayValue).padEnd(24)} [${FROM_LABEL[info.source] || '内置默认'}]`;
    if (info.shadowed !== null) {
      line += `  ⚠ ${ENV_FILE_NAME} 里写的是「${info.shadowed}」，被环境变量盖掉了`;
    }
    lines.push(line);
  };
  plain('BIND', config.bind || '(留空 → 所有地址·双栈)');
  plain('DB_PATH', config.dbPath);

  // 下面几个只报「有没有设」和来源，**值一律不显示**
  const appSecretWhere =
    config.appSecretFrom === 'env'
      ? FROM_LABEL.env
      : config.appSecretFrom === 'file'
        ? FROM_LABEL.file
        : config.appSecretSource === 'file'
          ? 'data/app-secret.key 文件'
          : '本次自动生成';
  const secretRows = [
    ['APP_SECRET', true, appSecretWhere],
    ['ADMIN_PASSWORD', isSet(process.env.ADMIN_PASSWORD), null],
    ['ACCESS_KEY', isSet(process.env.ACCESS_KEY), null],
  ];
  for (const [key, set, forceWhere] of secretRows) {
    const info = sourceOf(key);
    let line = `  ${key.padEnd(21)} = ${set ? '已设置（值不显示）' : '未设置（可在网页里设）'}`;
    if (set) line += `                    [${forceWhere || FROM_LABEL[info.source] || '内置默认'}]`;
    if (info.shadowed !== null) {
      line += `  ⚠ ${ENV_FILE_NAME} 里也有一个不同的值，被环境变量盖掉了`;
    }
    lines.push(line);
  }

  lines.push(
    envFileExists
      ? `  ${ENV_FILE_NAME.padEnd(21)} = 存在，读到 ${Object.keys(FILE_VALUES).length} 项`
      : `  ${ENV_FILE_NAME.padEnd(21)} = 不存在（正常 —— Docker 里本来就没有它，全部按「环境变量 / 内置默认」来）`
  );
  if (envFileError) lines.push(`  ⚠ 读 ${ENV_FILE_NAME} 出错：${envFileError}`);
  return lines;
}

config.describeAppSecretOrigin = describeAppSecretOrigin;
config.describeConfigSources = describeConfigSources;

module.exports = config;
