'use strict';

/**
 * 进程内的小限速器（审计 M2 登录爆破 / L4 日志灌水）。
 *
 * 单实例假设（定时任务也在进程内、数据库是本地文件），所以内存计数就够，不用引入外部存储。
 * 两件事分开做：
 *   - `createWindowLimiter`：窗口计数（比如"每 IP 每分钟最多 30 条前端上报"）
 *   - `createFailureGuard`：失败锁定（连续失败 N 次就锁一段时间，成功即解禁）
 *
 * 都要定期 `prune()`，不然被扫的 IP 会把 Map 撑大（审计里也点了会话 Map 无上限这条）。
 */

const MINUTE = 60 * 1000;

/** 内存上限（见 enforceCap）：超过它就淘汰最久没失败过的记录 */
const MAX_TRACKED_KEYS = 1000;

function createWindowLimiter({ limit = 30, windowMs = MINUTE, globalLimit = 0 } = {}) {
  const hits = new Map();
  let global = { count: 0, resetAt: 0 };

  return {
    /** 现在能不能收这一条（不计数） */
    check(key) {
      const ts = Date.now();
      if (hits.size > 1000) this.prune(); // 自己去重，免得被扫的 IP 把 Map 撑大
      if (globalLimit) {
        if (ts >= global.resetAt) global = { count: 0, resetAt: ts + windowMs };
        if (global.count >= globalLimit) {
          return { allowed: false, retryAfterSeconds: Math.ceil((global.resetAt - ts) / 1000), scope: 'global' };
        }
      }
      const entry = hits.get(key);
      if (!entry || ts >= entry.resetAt) return { allowed: true, retryAfterSeconds: 0, scope: '' };
      if (entry.count >= limit) {
        return { allowed: false, retryAfterSeconds: Math.ceil((entry.resetAt - ts) / 1000), scope: 'key' };
      }
      return { allowed: true, retryAfterSeconds: 0, scope: '' };
    },
    hit(key) {
      const ts = Date.now();
      const entry = hits.get(key);
      if (!entry || ts >= entry.resetAt) hits.set(key, { count: 1, resetAt: ts + windowMs });
      else entry.count += 1;
      if (globalLimit) global.count += 1;
    },
    prune() {
      const ts = Date.now();
      for (const [key, entry] of hits) if (ts >= entry.resetAt) hits.delete(key);
    },
    size: () => hits.size,
  };
}

/**
 * 失败锁定。参数是用户 2026-09-15 定的（后台登录和 `/v1` 共用同一套语义）：
 *
 *   连续失败 5 次 → 锁 5 分钟；之后每再失败一次**翻倍**（10m → 20m → 40m → 1 小时封顶）
 *   24 小时没新的失败 → 忘掉这个人（重新从 0 算）
 *   成功一次 → 立刻解禁（计数清零）
 *
 * **故意不做全局兜底**（原来有一条"1 分钟内全局失败 100 次就把所有 IP 一起锁"）：
 * 用户原话的意思是，会不计成本换一堆 IP 来打的人，代价已经高到离谱了 —— 真碰上这种，
 * 让他把这一堆免费 API 拿去用又何妨。与其为这种场景加一层会误伤正常用户的机制，不如不加。
 *
 * `enforceCap()` 不是"封锁上限"（不会因此少锁谁），只是**内存**上限：不许 Map 被刷爆。
 */
function createFailureGuard({
  threshold = 5, // 连续失败到这个数就开始锁
  baseLockMs = 5 * MINUTE, // 第一次锁多久
  maxLockMs = 60 * MINUTE, // 翻倍封顶
  forgettingMs = 24 * 60 * MINUTE, // 这么久没再失败就忘掉
} = {}) {
  const entries = new Map();

  return {
    /** 现在能不能试（不计数） */
    check(key) {
      const ts = Date.now();
      if (entries.size > MAX_TRACKED_KEYS) this.enforceCap();
      const entry = entries.get(key);
      if (!entry) return { allowed: true, retryAfterSeconds: 0 };
      if (entry.lockedUntil > ts) {
        return { allowed: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - ts) / 1000) };
      }
      // 锁早过期了，而且很久没再失败 → 忘掉他，别让他永远背着一个高倍数的锁
      if (ts - entry.lastFailureAt > forgettingMs) entries.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    },
    /** 记一次失败，返回这次锁了多久（没到阈值就是 0） */
    fail(key) {
      const ts = Date.now();
      const entry = entries.get(key) || { failures: 0, lockedUntil: 0, lockMs: 0, lastFailureAt: 0 };
      entry.failures += 1;
      entry.lastFailureAt = ts;
      let lockedSeconds = 0;
      if (entry.failures >= threshold) {
        entry.lockMs = Math.min(entry.lockMs ? entry.lockMs * 2 : baseLockMs, maxLockMs);
        entry.lockedUntil = ts + entry.lockMs;
        lockedSeconds = Math.ceil(entry.lockMs / 1000);
      }
      entries.set(key, entry);
      return { failures: entry.failures, lockedSeconds };
    },
    /** 成功一次 → 解禁（用户要求：成功就把这个 IP 放掉） */
    succeed(key) {
      entries.delete(key);
    },
    prune() {
      const ts = Date.now();
      for (const [key, entry] of entries) {
        if (entry.lockedUntil <= ts && ts - entry.lastFailureAt > forgettingMs) entries.delete(key);
      }
    },
    /** 只做内存保护：超上限时淘汰"最久没失败过"的记录（不影响该锁的人继续被锁） */
    enforceCap() {
      this.prune();
      if (entries.size <= MAX_TRACKED_KEYS) return;
      const oldestFirst = [...entries.entries()].sort((a, b) => a[1].lastFailureAt - b[1].lastFailureAt);
      const target = Math.floor(MAX_TRACKED_KEYS * 0.75);
      for (const [key] of oldestFirst) {
        if (entries.size <= target) break;
        entries.delete(key);
      }
    },
    size: () => entries.size,
    /** 清空所有记录（给测试用：用例之间不该互相背着别人的失败次数） */
    reset() {
      entries.clear();
    },
    params: { threshold, baseLockMs, maxLockMs, forgettingMs },
  };
}

module.exports = { createWindowLimiter, createFailureGuard, MINUTE };
