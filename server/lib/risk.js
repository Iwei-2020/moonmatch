'use strict';

/**
 * 风控与带量记账（《项目说明书》§5.3 频次限制、§5.4 风控规则）
 *
 * 铁律：**次数发放与消耗 100% 由服务端记账**，客户端计数仅用于 UI 提示，不作为发放依据。
 * 本模块只做「判定」与「记账」，全部返回结构化结果，不抛错（由 handlers 决定如何收敛成信封）。
 */

const { LIMITS } = require('../../miniapp/shared/client-constants.js');

const HOUR_MS = 3600000;
const MINUTE_MS = 60000;
/** 单位时间异常频次阈值（说明书 §5.4）：1 分钟 >3 次、1 小时 >10 次 → 临时冻结 */
const FREQ_MIN_LIMIT = 3;
const FREQ_HOUR_LIMIT = 10;

/** 自然日键（按 Asia/Shanghai 划分自然日，与「明天再来」的文案语义一致） */
function dayKey(now, tzOffsetMs) {
  const offset = tzOffsetMs === undefined ? 8 * HOUR_MS : tzOffsetMs;
  return new Date(now + offset).toISOString().slice(0, 10);
}

/** 新用户判定：注册（首次登记）后 NEW_USER_WINDOW_MS 内适用更严格的解锁上限 */
function isNewUser(profile, now) {
  if (!profile || !profile.createdAt) return false;
  return now - profile.createdAt < LIMITS.NEW_USER_WINDOW_MS;
}

/** 读当日计数（云库为异步，统一 await）。 */
async function counters(store, openid, now) {
  return store.countersOf(openid, dayKey(now));
}

/**
 * 记账后**显式回写**：内存实现是就地改同一对象，云库实现不做原地更新，
 * 必须调用 `saveCounters` 才能落库（否则改动只停留在内存副本上）。
 */
async function persistCounters(store, openid, now, c) {
  await store.saveCounters(openid, dayKey(now), c);
  return c;
}

/** 记录一次操作时间戳，并按窗口裁剪（内存占用有界） */
function recordAction(c, now) {
  c.recent.push(now);
  const cutoff = now - HOUR_MS;
  c.recent = c.recent.filter((t) => t >= cutoff);
}

/**
 * 单位时间异常频次判定（说明书写法为「临时冻结 1 小时并告警」，此处输出是否需要冻结）。
 */
async function checkFrequency(store, { openid, now }) {
  const c = await counters(store, openid, now);
  const recent = c.recent.filter((t) => t >= now - HOUR_MS);
  const inMinute = recent.filter((t) => t >= now - MINUTE_MS).length;
  if (inMinute > FREQ_MIN_LIMIT || recent.length > FREQ_HOUR_LIMIT) {
    return { blocked: true, reason: inMinute > FREQ_MIN_LIMIT ? 'per_minute' : 'per_hour' };
  }
  return { blocked: false };
}

/**
 * 广告触发前置校验：冷却 + 解锁配额（在让用户看广告之前就要拦，避免白看一条广告）。
 */
async function checkAdTrigger(store, { openid, now, profile }) {
  const freq = await checkFrequency(store, { openid, now });
  if (freq.blocked) return { ok: false, code: 'RISK_BLOCKED', reason: freq.reason };

  const c = await counters(store, openid, now);
  const sinceAd = now - c.lastAdAt;
  if (c.lastAdAt && sinceAd < LIMITS.AD_COOLDOWN_MS) {
    return { ok: false, code: 'AD_COOLDOWN', retryAfterMs: LIMITS.AD_COOLDOWN_MS - sinceAd };
  }

  const quota = LIMITS.DAILY_UNLOCK;
  if (c.unlock >= quota) return { ok: false, code: 'DAILY_UNLOCK_LIMIT' };
  if (isNewUser(profile, now) && c.unlock >= LIMITS.NEW_USER_DAILY_UNLOCK) {
    return { ok: false, code: 'DAILY_UNLOCK_LIMIT', reason: 'new_user' };
  }

  return { ok: true };
}

/** 记账：广告触发（同时进入异常频次窗口） */
async function noteAdTrigger(store, { openid, now }) {
  const c = await counters(store, openid, now);
  c.lastAdAt = now;
  recordAction(c, now);
  return persistCounters(store, openid, now, c);
}

/**
 * 广告连续失败计数（可服务端观测的失败信号 = 未完整观看就关闭）。
 * 达到 LIMITS.AD_FAILURE_EXEMPT 次即触发当日豁免通道（说明书 §5.3）。
 */
async function noteAdFailure(store, { openid, now }) {
  const c = await counters(store, openid, now);
  c.adFail += 1;
  await persistCounters(store, openid, now, c);
  return { failures: c.adFail, exemptAvailable: c.adFail >= LIMITS.AD_FAILURE_EXEMPT && !c.exemptUsed };
}

/**
 * 消费一次广告失败豁免：当日仅一次，用掉即作废（避免豁免成为常态通道）。
 * @returns {Promise<boolean>} 本次是否成功取得豁免
 */
async function grantExempt(store, { openid, now }) {
  const c = await counters(store, openid, now);
  if (c.adFail < LIMITS.AD_FAILURE_EXEMPT || c.exemptUsed) return false;
  c.exemptUsed = true;
  c.adFail = 0;
  await persistCounters(store, openid, now, c);
  return true;
}

/** 广告完整观看成功 → 重置连续失败计数 */
async function noteAdSuccess(store, { openid, now }) {
  const c = await counters(store, openid, now);
  c.adFail = 0;
  return persistCounters(store, openid, now, c);
}

/** 匹配前置校验：冷却 + 每日匹配上限 */
async function checkMatch(store, { openid, now }) {
  const freq = await checkFrequency(store, { openid, now });
  if (freq.blocked) return { ok: false, code: 'RISK_BLOCKED', reason: freq.reason };

  const c = await counters(store, openid, now);
  const sinceMatch = now - c.lastMatchAt;
  if (c.lastMatchAt && sinceMatch < LIMITS.MATCH_COOLDOWN_MS) {
    return { ok: false, code: 'MATCH_COOLDOWN', retryAfterMs: LIMITS.MATCH_COOLDOWN_MS - sinceMatch };
  }
  if (c.match >= LIMITS.DAILY_MATCH) return { ok: false, code: 'DAILY_MATCH_LIMIT' };

  return { ok: true };
}

/** 记账：一次成功匹配 */
async function noteMatch(store, { openid, now }) {
  const c = await counters(store, openid, now);
  c.match += 1;
  c.lastMatchAt = now;
  recordAction(c, now);
  return persistCounters(store, openid, now, c);
}

/** 记账：一次解锁（= 一条激励视频完整观看并发放成功） */
async function noteUnlock(store, { openid, now }) {
  const c = await counters(store, openid, now);
  c.unlock += 1;
  recordAction(c, now);
  return persistCounters(store, openid, now, c);
}

/** 当前配额快照（供客户端展示；服务端为准）。`remainUnlock` 为今日剩余解签额度，供页面直接展示 */
async function quotaSnapshot(store, { openid, now, profile }) {
  const c = await counters(store, openid, now);
  const unlockLimit = isNewUser(profile, now) ? LIMITS.NEW_USER_DAILY_UNLOCK : LIMITS.DAILY_UNLOCK;
  return {
    day: dayKey(now),
    matchUsed: c.match,
    matchLimit: LIMITS.DAILY_MATCH,
    unlockUsed: c.unlock,
    unlockLimit,
    remainUnlock: Math.max(0, unlockLimit - c.unlock),
  };
}

module.exports = {
  dayKey,
  isNewUser,
  checkFrequency,
  checkAdTrigger,
  noteAdTrigger,
  noteAdFailure,
  grantExempt,
  noteAdSuccess,
  checkMatch,
  noteMatch,
  noteUnlock,
  quotaSnapshot,
};
