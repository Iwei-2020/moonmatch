'use strict';

/**
 * 随机匹配单测
 *
 * 依据：《项目说明书-月老办事处》§2.2（流程 B：按签筒随机推送 1 份档案）。
 * 覆盖：按签筒（男/女）筛选、排除自己与下架档案、已获取不重复推送、
 *      无新档时回退历史记录（免费复看）、池空态、卡片解锁标记。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryStore } = require('../server/lib/store.js');
const { LIMITS, PROFILE_STATUS } = require('../miniapp/shared/client-constants.js');
const { pickMatch, toMatchCard } = require('../server/lib/match.js');

const NOW = Date.UTC(2026, 0, 1);

/** 直接写入一份档案（绕过登记流程，便于精确控制性别 / 状态） */
function put(store, seed) {
  const profile = {
    profileId: seed.id,
    openid: seed.openid || seed.id,
    gender: seed.gender,
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

const first = () => 0; // 确定性随机源：总取第一个候选

test('pickMatch：按签筒筛选性别，排除自己与已下架档案', async () => {
  const store = createMemoryStore({});
  put(store, { id: 'MM-ME', openid: 'me', gender: 'male' });
  put(store, { id: 'MM-F1', gender: 'female' });
  put(store, { id: 'MM-M1', gender: 'male' }); // 男签筒之外的性别，排除
  put(store, { id: 'MM-F2', gender: 'female', status: PROFILE_STATUS.OFFLINE }); // 下架，排除

  const picked = await pickMatch(store, { openid: 'me', pool: 'female', now: NOW, random: first });
  assert.equal(picked.poolEmpty, false);
  assert.equal(picked.card.profileId, 'MM-F1');
  assert.equal(picked.card.gender, 'female');
  assert.equal(picked.card.unlocked, false);
  assert.ok(!JSON.stringify(picked.card).includes('cand_MM-F1'), '卡片不得含明文联系方式');
});

test('pickMatch：男签筒只推男性档案', async () => {
  const store = createMemoryStore({});
  put(store, { id: 'MM-F1', gender: 'female' });
  put(store, { id: 'MM-M1', gender: 'male' });

  const picked = await pickMatch(store, { openid: 'me', pool: 'male', now: NOW, random: first });
  assert.equal(picked.poolEmpty, false);
  assert.equal(picked.card.profileId, 'MM-M1');
  assert.equal(picked.card.gender, 'male');
});

test('pickMatch：已获取过的档案不重复推送（有未获取档时优先新档）', async () => {
  const store = createMemoryStore({});
  put(store, { id: 'MM-F1', gender: 'female' });
  put(store, { id: 'MM-F2', gender: 'female' });
  store.saveUnlock('me', 'MM-F1', { unlockedAt: NOW - 1000, expiresAt: NOW + LIMITS.FREE_REVISIT_MS });

  const picked = await pickMatch(store, { openid: 'me', pool: 'female', now: NOW, random: first });
  assert.equal(picked.card.profileId, 'MM-F2', 'random 恒取第一个，但 F1 已获取故应给 F2');
});

test('pickMatch：池内无新档时回退历史记录，卡片标记已解锁', async () => {
  const store = createMemoryStore({});
  put(store, { id: 'MM-F1', gender: 'female' });
  store.saveUnlock('me', 'MM-F1', { unlockedAt: NOW, expiresAt: NOW + LIMITS.FREE_REVISIT_MS });

  const picked = await pickMatch(store, { openid: 'me', pool: 'female', now: NOW, random: first });
  assert.equal(picked.poolEmpty, false);
  assert.equal(picked.card.profileId, 'MM-F1');
  assert.equal(picked.card.unlocked, true);
  assert.equal(picked.card.freeRevisit, true, '30 天内免费复看');
});

test('pickMatch：签筒无任何候选 → poolEmpty', async () => {
  const store = createMemoryStore({});
  put(store, { id: 'MM-ME', openid: 'me', gender: 'male' });

  const picked = await pickMatch(store, { openid: 'me', pool: 'female', now: NOW, random: first });
  assert.equal(picked.poolEmpty, true);
  assert.equal(picked.card, null);
});

test('toMatchCard：未解锁标记 false；解锁后带 unlockedAt 且超出 30 天不再免费复看', async () => {
  const store = createMemoryStore({});
  const cand = put(store, { id: 'MM-F1', gender: 'female' });

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
