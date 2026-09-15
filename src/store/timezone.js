'use strict';

/**
 * 「本应用的一天从几点算起」—— 用户裁定 2026-09-12：
 *   "让用户自己设置吧。默认 utc 啥也不加。有些 linux 可能没设置过，还保留着默认的 utc。"
 *
 * 所以**不看操作系统时区、也不看 TZ 环境变量**（那正是不可控的来源：很多 Linux 装完就是
 * UTC，用户自己也没意识到）。改成一个显式设置 `utc_offset_hours`，默认 **0 = UTC**，
 * 在后台「设置」页里填。
 *
 * 它管两件事，而且**必须是同一个零点**，否则数字会互相打架：
 *   1) 主页概览卡的「今日」（请求数 / 失败数 / token 用量）—— src/admin/routes.js
 *   2) **rpd / tpd 日额度窗口的重置时刻**（rateState 里按自然日切）—— src/store/rateState.js
 * 以前这两处都偷偷用进程本地时区：容器里 TZ 没设就是 UTC，设了又是另一个日子，
 * 用户看到的"今日"和"额度什么时候回来"可能不是同一个零点。
 *
 * 为什么缓存成进程内变量：rateState 的窗口计算是**同步**的（每次准入都要算，不能 await），
 * 不方便每次都查库。启动时读一次、后台改设置时立刻更新即可（不用重启）。
 */

const settings = require('./settings');

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MIN_OFFSET = -12;
const MAX_OFFSET = 14;

let offsetHours = 0;

function clamp(value) {
  return Math.min(MAX_OFFSET, Math.max(MIN_OFFSET, value));
}

/** 设置值是否可用（后台接口校验用） */
function isValidOffset(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= MIN_OFFSET && n <= MAX_OFFSET;
}

/** 立刻生效（后台「设置」页保存时调） */
function setOffsetHours(value) {
  offsetHours = isValidOffset(value) ? Math.round(Number(value) * 100) / 100 : 0;
  return offsetHours;
}

function getOffsetHours() {
  return offsetHours;
}

/** 启动时从设置里读一次 */
async function loadOffsetHours() {
  return setOffsetHours(await settings.getNumber('utc_offset_hours'));
}

/**
 * 这个"应用自然日"的起点（真实 UTC 毫秒时间戳）。
 * 做法：先把时间戳平移到"配置时区"的刻度上，按 24 小时取整，再平移回来。
 */
function dayStart(ts = Date.now()) {
  const shifted = ts + offsetHours * HOUR_MS;
  return Math.floor(shifted / DAY_MS) * DAY_MS - offsetHours * HOUR_MS;
}

/**
 * 卡片上那个后缀：**UTC 时啥也不加**（这是默认，没什么好标的），
 * 其它情况给人看 `UTC+8` / `UTC+5:30` / `UTC-3`。
 */
function label() {
  if (offsetHours === 0) return '';
  const sign = offsetHours > 0 ? '+' : '-';
  const abs = Math.abs(offsetHours);
  const hours = Math.floor(abs);
  const minutes = Math.round((abs - hours) * 60);
  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

module.exports = {
  DAY_MS,
  MIN_OFFSET,
  MAX_OFFSET,
  isValidOffset,
  setOffsetHours,
  getOffsetHours,
  loadOffsetHours,
  dayStart,
  label,
};
