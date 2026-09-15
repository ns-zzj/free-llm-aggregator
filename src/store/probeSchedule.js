'use strict';

/**
 * 倒计时探测的「等待时长表」（退避表，全局设置，用户可编）。
 *
 * 语义：**第 N 项 = 第 N 次探测之前等多久**；最后一项带"后续"含义
 *       ——第 N 次及以后都用它。例：
 *
 *   [15, 60, 300]  →  失败后 15 秒探一次（抖动早就恢复了）
 *                     再失败 → 60 秒后探
 *                     再失败 → 300 秒后探，之后每 300 秒一次（额度类只能慢慢等）
 *
 * 为什么用表而不是写死一个秒数（用户裁定 2026-09-11）：
 *   上游不会告诉我们"什么时候能好"（实测 ModelScope / DeepSeek 连限流响应头都不发），
 *   所以只能探测。写死一个值必然是猜：猜小了白打上游，猜大了抖动也要等很久。
 *   退避把"猜一个正确的秒数"变成"不用猜"——从短间隔起步、逐步拉长，让上游自己告诉我们。
 */

const settings = require('./settings');

const DEFAULT_SCHEDULE = [15, 60, 300];
const MAX_ROWS = 20;

/** 规整用户填的值：正整数、最多 MAX_ROWS 段；认不出来就用默认表 */
function parse(value) {
  let arr = value;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch (err) {
      return [...DEFAULT_SCHEDULE];
    }
  }
  if (!Array.isArray(arr)) return [...DEFAULT_SCHEDULE];
  const cleaned = arr
    .map((n) => Math.round(Number(n)))
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, MAX_ROWS);
  return cleaned.length ? cleaned : [...DEFAULT_SCHEDULE];
}

async function get() {
  return parse(await settings.get('probe_backoff_seconds'));
}

/** 已经连续探测失败 attempts 次之后，下一次探测前该等多少秒（超出表长就用最后一段） */
function waitSecondsFor(schedule, attempts) {
  const list = schedule && schedule.length ? schedule : DEFAULT_SCHEDULE;
  const index = Math.min(Math.max(Number(attempts) || 0, 0), list.length - 1);
  return list[index];
}

async function nextWaitSeconds(attempts) {
  return waitSecondsFor(await get(), attempts);
}

module.exports = { DEFAULT_SCHEDULE, MAX_ROWS, parse, get, waitSecondsFor, nextWaitSeconds };
