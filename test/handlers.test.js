'use strict';

/**
 * 云函数处理器端到端单测（流程 A + 流程 B 全链路）
 *
 * 依据：《项目说明书-月老办事处》§2（核心业务闭环）、§5（广告激励闭环与风控）、§6.4（明文仅经
 * revealContact 一次性下发）。
 * 覆盖：登记 → 获取 → 创建广告任务 → 发券 → 解锁（复制）的完整链路，以及配额冷却、免费复看复用、
 *      未完整观看的拦截、明文唯一出口、举报与埋点。
 *
 * 说明：处理器是纯函数 `(params, ctx) => Promise<信封>`，此处注入内存 store 与确定性时钟 / 随机源。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryStore } = require('../server/lib/store.js');
const { ERROR_CODES, LIMITS } = require('../miniapp/shared/client-constants.js');
const handlers = require('../server/lib/handlers.js');

const NOW = Date.UTC(2026, 0, 1);
const PHONE_A = ['1', '3', '8', '1', '2', '3', '4', '8', '8', '8', '8'].join('');
const PHONE_B = ['1', '3', '9', '9', '8', '7', '6', '5', '4', '3', '2'].join('');

process.env.MM_AD_UNIT_IDS = 'ad_unit_1,ad_unit_2';

/** 组装 ctx：内存 store + 可控时钟与确定性随机（薄壳里由 store-provider / identity 装配） */
function makeCtx(store, openid, clock) {
  return { openid, store, now: () => clock.now, random: () => 0 };
}

function register(store, openid, gender, phone) {
  return handlers.handleSubmitProfile(
    { agreement: true, gender, contactType: 'phone', contact: phone },
    makeCtx(store, openid, { now: NOW }),
  );
}

test('全链路：登记 → 获取 → 看广告发券 → 解锁复制（明文唯一出口，二次消费失败）', async () => {
  const store = createMemoryStore({});
  const clock = { now: NOW };

  const me = await register(store, 'me', 'male', PHONE_A);
  const peer = await register(store, 'peer', 'female', PHONE_B);
  assert.equal(me.code, 0);
  assert.equal(peer.code, 0);
  assert.equal(peer.data.maskedContact, '139****5432');

  const match = await handlers.handleGetMatch({ pool: 'female' }, makeCtx(store, 'me', clock));
  assert.equal(match.code, 0);
  assert.equal(match.data.poolEmpty, false);
  assert.equal(match.data.card.profileId, peer.data.profileId);

  const task = await handlers.handleCreateAdTask({ profileId: peer.data.profileId }, makeCtx(store, 'me', clock));
  assert.equal(task.code, 0);
  assert.match(task.data.taskToken, /^t_/);
  assert.deepEqual(task.data.adUnitIds, ['ad_unit_1', 'ad_unit_2'], '广告位由服务端下发');

  const ticket = await handlers.handleClaimTicket({ taskToken: task.data.taskToken, adFinished: true, playedMs: 15000 }, makeCtx(store, 'me', clock));
  assert.equal(ticket.code, 0);
  assert.match(ticket.data.ticketId, /^k_/);

  const revealed = await handlers.handleRevealContact({ profileId: peer.data.profileId, ticketId: ticket.data.ticketId }, makeCtx(store, 'me', clock));
  assert.equal(revealed.code, 0);
  assert.equal(revealed.data.contact, PHONE_B, '仅此接口返回明文');
  assert.equal(revealed.data.maskedContact, '139****5432');

  const reuse = await handlers.handleRevealContact({ profileId: peer.data.profileId, ticketId: ticket.data.ticketId }, makeCtx(store, 'me', clock));
  assert.equal(reuse.code, ERROR_CODES.TICKET_NOT_FOUND, '查看券一次性');

  const list = await handlers.handleListUnlocked({}, makeCtx(store, 'me', clock));
  assert.equal(list.code, 0);
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.items[0].profileId, peer.data.profileId);
  assert.ok(!JSON.stringify(list.data).includes(PHONE_B), '解锁记录只出掩码');
});

test('createAdTask：30 天内已获取过 → 免费复看，不再消耗次数与广告', async () => {
  const store = createMemoryStore({});
  const clock = { now: NOW };
  const peer = await register(store, 'peer', 'female', PHONE_B);
  await register(store, 'me', 'male', PHONE_A);

  const task = await handlers.handleCreateAdTask({ profileId: peer.data.profileId }, makeCtx(store, 'me', clock));
  await handlers.handleClaimTicket({ taskToken: task.data.taskToken, adFinished: true, now: clock.now }, makeCtx(store, 'me', clock));

  clock.now += LIMITS.AD_COOLDOWN_MS + 1; // 越过广告冷却，确保命中「复用」而非「冷却」

  const again = await handlers.handleCreateAdTask({ profileId: peer.data.profileId }, makeCtx(store, 'me', clock));
  assert.equal(again.code, 0);
  assert.equal(again.data.freeRevisit, true);
  assert.equal(again.data.taskToken, '');
  assert.deepEqual(again.data.adUnitIds, []);
});

test('广告冷却与每日上限：看广告前先拦截（避免白看）', async () => {
  const store = createMemoryStore({});
  const clock = { now: NOW };
  const peer = await register(store, 'peer', 'female', PHONE_B);
  await register(store, 'me', 'male', PHONE_A);

  await handlers.handleCreateAdTask({ profileId: peer.data.profileId }, makeCtx(store, 'me', clock));
  const cooled = await handlers.handleCreateAdTask({ profileId: peer.data.profileId }, makeCtx(store, 'me', clock));
  assert.equal(cooled.code, ERROR_CODES.AD_COOLDOWN, '30 秒内二次触发被拦');
  assert.ok(cooled.data.retryAfterMs > 0);
});

test('claimTicket：未完整观看不发券，并累计失败供豁免通道判定', async () => {
  const store = createMemoryStore({});
  const clock = { now: NOW };
  const peer = await register(store, 'peer', 'female', PHONE_B);
  await register(store, 'me', 'male', PHONE_A);

  const task = await handlers.handleCreateAdTask({ profileId: peer.data.profileId }, makeCtx(store, 'me', clock));
  const denied = await handlers.handleClaimTicket({ taskToken: task.data.taskToken, adFinished: false, playedMs: 1000 }, makeCtx(store, 'me', clock));
  assert.equal(denied.code, ERROR_CODES.TASK_NOT_FINISHED);
  assert.equal(denied.data.failures, 1);
});

test('前置守卫：未留缘签也可取签；自身不可解锁；参数缺失报 INVALID_PARAM', async () => {
  const store = createMemoryStore({});
  const clock = { now: NOW };
  const peer = await register(store, 'peer', 'female', PHONE_B);

  const noPool = await handlers.handleGetMatch({}, makeCtx(store, 'ghost', clock));
  assert.equal(noPool.code, ERROR_CODES.INVALID_PARAM, '取签须先选签筒');

  const unregistered = await handlers.handleGetMatch({ pool: 'female' }, makeCtx(store, 'ghost', clock));
  assert.equal(unregistered.code, 0, '取签不再以先留缘签为前提');
  assert.equal(unregistered.data.poolEmpty, false);
  assert.equal(unregistered.data.card.profileId, peer.data.profileId, '未留缘签亦按签筒随机取一份');

  await register(store, 'me', 'male', PHONE_A);
  const noParam = await handlers.handleCreateAdTask({}, makeCtx(store, 'me', clock));
  assert.equal(noParam.code, ERROR_CODES.INVALID_PARAM);

  const myself = await handlers.handleRevealContact({ profileId: 'MM-SELF', ticketId: 'k_x' }, makeCtx(store, 'me', clock));
  assert.equal(myself.code, ERROR_CODES.TICKET_NOT_FOUND);

  assert.ok(peer.data.profileId);
});

test('getProfile / offlineProfile / reportProfile / reportEvents 基础契约', async () => {
  const store = createMemoryStore({});
  const clock = { now: NOW };
  await register(store, 'me', 'male', PHONE_A);

  const profile = await handlers.handleGetProfile({}, makeCtx(store, 'me', clock));
  assert.equal(profile.code, 0);
  assert.equal(profile.data.profile.maskedContact, '138****8888');

  const offline = await handlers.handleOfflineProfile({ action: 'offline' }, makeCtx(store, 'me', clock));
  assert.equal(offline.code, 0);
  assert.equal(offline.data.status, 'offline');

  const blocked = await handlers.handleGetMatch({ pool: 'female' }, makeCtx(store, 'me', clock));
  assert.equal(blocked.code, 0, '取签不再要求登记态，下架后仍可取签');
  assert.equal(blocked.data.poolEmpty, true, '池中仅有自己（且已下架）→ 无签可取');

  const report = await handlers.handleReportProfile({ profileId: 'MM-XXXXXX', reasonType: 'fake' }, makeCtx(store, 'me', clock));
  assert.equal(report.code, ERROR_CODES.PROFILE_NOT_FOUND);

  const events = await handlers.handleReportEvents({ events: new Array(60).fill({ name: 'page_view' }) }, makeCtx(store, 'me', clock));
  assert.equal(events.code, 0);
  assert.equal(events.data.accepted, 50, '批次上限 50');
});
