'use strict';

/**
 * 随机匹配（《项目说明书》§2.2 流程 B）
 *
 * 取消广场与列表后，获取 = 服务端按用户选定的签筒随机推送 1 份档案。规则（已冻结）：
 *   ① 按调用方传入的签筒偏好（`pool`：male / female）筛选同性别的在架档案；
 *   ② 排除自己、排除已下线的档案；
 *   ③ **已获取过的档案不再重复推送**，除非池子已无新档可给 —— 此时回退展示历史记录（免费复看 30 天内）；
 *   ④ 池内无候选 → poolEmpty（说明书 §9.2 最高风险项：池子供需失衡）。
 */

const { LIMITS, PROFILE_STATUS } = require('../../miniapp/shared/client-constants.js');
const { toPublicProfile } = require('./profile.js');

/** 默认随机源；单测注入确定性 random 以保证可断言 */
function defaultRandom(max) {
  return Math.floor(Math.random() * max);
}

/** 签筒偏好取值（客户端 poolOptions 与服务端校验共用的白名单） */
const POOLS = ['male', 'female'];

/**
 * 抽取 1 份档案。
 *
 * `pool` 为用户选定的签筒（male / female）；缺省或不合法时不筛性别，从全部在架档案里随机取一份。
 * 用户**无需先留缘签即可取签**（直接取用）。
 *
 * @param {object} store 存储
 * @param {object} args `{ openid, pool, now, random }`
 * @returns {Promise<{poolEmpty:boolean, card:object|null}>}
 */
async function pickMatch(store, args) {
  const { openid, pool } = args;
  const now = args.now;
  const random = typeof args.random === 'function' ? args.random : defaultRandom;
  const wantGender = POOLS.indexOf(pool) >= 0 ? pool : '';

  const candidates = (await store.listActiveProfiles())
    .filter((p) => p.openid !== openid && p.status === PROFILE_STATUS.ACTIVE && (!wantGender || p.gender === wantGender));

  const unlockedIds = new Set((await store.listUnlocks(openid)).map((u) => u.profileId));
  const fresh = candidates.filter((p) => !unlockedIds.has(p.profileId));

  if (fresh.length) {
    const picked = fresh[random(fresh.length)];
    return { poolEmpty: false, card: await toMatchCard(picked, { now, store, openid }) };
  }

  // ③ 池子已无新档：回退到历史记录（30 天内免费复看；超过则需重新解锁）
  if (candidates.length) {
    const picked = candidates[random(candidates.length)];
    return { poolEmpty: false, card: await toMatchCard(picked, { now, store, openid }) };
  }

  // ④ 池子为空
  return { poolEmpty: true, card: null };
}

/** 卡片视图：带解锁态与免费复看标记，缘签一律掩码 */
async function toMatchCard(candidate, { now, store, openid }) {
  const view = toPublicProfile(candidate, now);
  const unlock = await store.getUnlock(openid, candidate.profileId);
  if (unlock) {
    view.unlocked = true;
    view.unlockedAt = unlock.unlockedAt;
    view.expiresAt = unlock.expiresAt;
    view.freeRevisit = now - unlock.unlockedAt < LIMITS.FREE_REVISIT_MS;
  } else {
    view.unlocked = false;
  }
  return view;
}

module.exports = { pickMatch, toMatchCard, POOLS };
