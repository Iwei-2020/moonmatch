'use strict';

/**
 * 随机匹配（《项目说明书》§2.2 流程 B、附录 A Q3 结论）
 *
 * 取消广场与列表后，获取 = 服务端随机推送 1 份档案。规则（已冻结）：
 *   ① 默认异性偏好；
 *   ② 年龄邻近优先，按 LIMITS.MATCH_AGE_STEPS 逐级放宽，relaxationLevel = 0..3（埋点 match_result 上报）；
 *   ③ 排除自己、排除已下线的档案；
 *   ④ **已获取过的档案不再重复推送**，除非池子已无新档可给 —— 此时回退展示历史记录（免费复看 30 天内）；
 *   ⑤ 全放宽仍无候选 → poolEmpty（说明书 §9.2 最高风险项：池子供需失衡）。
 */

const { LIMITS, PROFILE_STATUS } = require('../../miniapp/shared/client-constants.js');
const { ageOf, toPublicProfile } = require('./profile.js');

/** 默认随机源；单测注入确定性 random 以保证可断言 */
function defaultRandom(max) {
  return Math.floor(Math.random() * max);
}

function oppositeOf(gender) {
  return gender === 'male' ? 'female' : 'male';
}

/**
 * 抽取 1 份档案。
 *
 * `profile` 允许为 null：用户**无需先留缘签即可取签**（直接取用），
 * 此时退化为「盲取」——不筛异性、不做年龄邻近，从全部在架档案里随机取一份，
 * relaxationLevel 记为梯度末端（等同「不限年龄」）。
 *
 * @param {object} store 存储
 * @param {object} args `{ openid, profile, now, random }`
 * @returns {Promise<{poolEmpty:boolean, relaxationLevel:number, card:object|null}>}
 */
async function pickMatch(store, args) {
  const { openid, profile } = args;
  const now = args.now;
  const random = typeof args.random === 'function' ? args.random : defaultRandom;
  const steps = LIMITS.MATCH_AGE_STEPS;

  const myAge = profile ? ageOf(profile.birthYear, now) : null;
  const wantGender = profile ? oppositeOf(profile.gender) : '';

  const candidates = (await store.listActiveProfiles())
    .filter((p) => p.openid !== openid && p.status === PROFILE_STATUS.ACTIVE && (!wantGender || p.gender === wantGender));

  const unlockedIds = new Set((await store.listUnlocks(openid)).map((u) => u.profileId));
  const fresh = candidates.filter((p) => !unlockedIds.has(p.profileId));

  if (fresh.length) {
    // 盲取：无自有档案时不筛年龄，直接随机取一份
    if (myAge === null) {
      const picked = fresh[random(fresh.length)];
      return {
        poolEmpty: false,
        relaxationLevel: steps.length - 1,
        card: await toMatchCard(picked, { now, store, openid }),
      };
    }

    // ③ 年龄邻近逐级放宽（仅对未获取过的档案）
    for (let level = 0; level < steps.length; level += 1) {
      const step = steps[level];
      const bucket = fresh.filter((p) => Math.abs(ageOf(p.birthYear, now) - myAge) <= step);
      if (bucket.length) {
        const picked = bucket[random(bucket.length)];
        return { poolEmpty: false, relaxationLevel: level, card: await toMatchCard(picked, { now, store, openid }) };
      }
    }
  }

  // ④ 池子已无新档：回退到历史记录（30 天内免费复看；超过则需重新解锁）
  if (candidates.length) {
    const picked = candidates[random(candidates.length)];
    return {
      poolEmpty: false,
      relaxationLevel: steps.length - 1,
      card: await toMatchCard(picked, { now, store, openid }),
    };
  }

  // ⑤ 池子为空
  return { poolEmpty: true, relaxationLevel: steps.length, card: null };
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

module.exports = { pickMatch, toMatchCard, oppositeOf };
