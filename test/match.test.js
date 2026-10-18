'use strict';

/**
 * 随机匹配单测
 *
 * 依据：《项目说明书-月老办事处》§2.2（流程 B：随机推送 1 份档案）、附录 A Q3（取消广场后按年龄邻近放宽）。
 * 覆盖：异性偏好、排除自己与下架档案、年龄梯度 relaxationLevel、已获取不重复推送、
 *      无新档时回退历史记录（免费复看）、池空态、卡片解锁标记。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryStore } = require('../server/lib/store.js');
const { LIMITS, PROFILE_STATUS } = require('../miniapp/shared/client-constants.js');
const { pickMatch, toMatchCard, oppositeOf } = require('../server/lib/match.js');

const NOW = Date.UTC(2026, 0, 1);
const YEAR = new Date(NOW).getUTCFullYear();

/** 直接写入一份档案（绕过登记流程，便于精确控制性别 / 年龄 / 状态） */
function put(store, seed) {
  const profile = {
    profileId: seed.id,
    openid: seed.openid || seed.id,
    gender: seed.gender,
    birthYear: YEAR - seed.age,
    contactType: 'douyin',
    normalizedContact: `cand_${seed.id}`,
    contactHash: `hash_${seed.id}`,
    status: seed.status || PROFILE_STATUS.ACTIVE,
    createdAt: 0,
    updatedAt: 0,
  };
  store.saveProfile(profile);
  return profile;
}

const first = (max) => 0; // 确定性随机源：总取第一个候选

test('oppositeOf：异性偏好', () => {
  assert.equal(oppositeOf('male'), 'female');
  assert.equal(oppositeOf('female'), 'male');
});

test('pickMatch：只推异性、排除自己与已下架档案，命中年龄梯度 0', async () => {
  const store = createMemoryStore({});
  const me = put(store, { id: 'MM-ME', openid: 'me', gender: 'male', age: 30 });
  put(store, { id: 'MM-F1', gender: 'female', age: 28 });
  put(store, { id: 'MM-M1', gender: 'male', age: 30 }); // 同性，排除
  put(store, { id: 'MM-F2', gender: 'female', age: 45, status: PROFILE_STATUS.OFFLINE }); // 下架，排除

  const picked = await pickMatch(store, { openid: 'me', profile: me, now: NOW, random: first });
  assert.equal(picked.poolEmpty, false);
  assert.equal(picked.card.profileId, 'MM-F1');
  assert.equal(picked.relaxationLevel, 0);
  assert.equal(picked.card.unlocked, false);
  assert.ok(!JSON.stringify(picked.card).includes('cand_MM-F1'), '卡片不得含明文联系方式');
});

test('pickMatch：年龄邻近逐级放宽（±5 → ±8 → ±12 → 不限）', async () => {
  const store = createMemoryStore({});
  const me = put(store, { id: 'MM-ME', openid: 'me', gender: 'male', age: 30 });
  put(store, { id: 'MM-F7', gender: 'female', age: 37 }); // 差 7 → 落到 ±8 一档

  const picked = await pickMatch(store, { openid: 'me', profile: me, now: NOW, random: first });
  assert.equal(picked.card.profileId, 'MM-F7');
  assert.equal(picked.relaxationLevel, 1);
});

test('pickMatch：已获取过的档案不重复推送（有未获取档时优先新档）', async () => {
  const store = createMemoryStore({});
  const me = put(store, { id: 'MM-ME', openid: 'me', gender: 'male', age: 30 });
  put(store, { id: 'MM-F1', gender: 'female', age: 29 });
  put(store, { id: 'MM-F2', gender: 'female', age: 30 });
  store.saveUnlock('me', 'MM-F1', { unlockedAt: NOW - 1000, expiresAt: NOW + LIMITS.FREE_REVISIT_MS });

  const picked = await pickMatch(store, { openid: 'me', profile: me, now: NOW, random: first });
  assert.equal(picked.card.profileId, 'MM-F2', 'random 恒取第一个，但 F1 已获取故应给 F2');
});

test('pickMatch：池内无新档时回退历史记录，卡片标记已解锁', async () => {
  const store = createMemoryStore({});
  const me = put(store, { id: 'MM-ME', openid: 'me', gender: 'male', age: 30 });
  put(store, { id: 'MM-F1', gender: 'female', age: 29 });
  store.saveUnlock('me', 'MM-F1', { unlockedAt: NOW, expiresAt: NOW + LIMITS.FREE_REVISIT_MS });

  const picked = await pickMatch(store, { openid: 'me', profile: me, now: NOW, random: first });
  assert.equal(picked.poolEmpty, false);
  assert.equal(picked.card.profileId, 'MM-F1');
  assert.equal(picked.card.unlocked, true);
  assert.equal(picked.card.freeRevisit, true, '30 天内免费复看');
});

test('pickMatch：无任何候选 → poolEmpty，relaxationLevel 为梯度末端', async () => {
  const store = createMemoryStore({});
  const me = put(store, { id: 'MM-ME', openid: 'me', gender: 'male', age: 30 });

  const picked = await pickMatch(store, { openid: 'me', profile: me, now: NOW, random: first });
  assert.equal(picked.poolEmpty, true);
  assert.equal(picked.card, null);
  assert.equal(picked.relaxationLevel, LIMITS.MATCH_AGE_STEPS.length);
});

test('toMatchCard：未解锁标记 false；解锁后带 unlockedAt 且超出 30 天不再免费复看', async () => {
  const store = createMemoryStore({});
  const cand = put(store, { id: 'MM-F1', gender: 'female', age: 29 });

  const locked = await toMatchCard(cand, { now: NOW, store, openid: 'me' });
  assert.equal(locked.unlocked, false);

  store.saveUnlock('me', 'MM-F1', { unlockedAt: NOW, expiresAt: NOW + LIMITS.FREE_REVISIT_MS });
  const unlocked = await toMatchCard(cand, { now: NOW, store, openid: 'me' });
  assert.equal(unlocked.unlocked, true);
  assert.equal(unlocked.unlockedAt, NOW);
  assert.equal(unlocked.freeRevisit, true);

  const stale = await toMatchCard(cand, { now: NOW + LIMITS.FREE_REVISIT_MS + 1, store, openid: 'me' });
  assert.equal(stale.freeRevisit, false);
});
