'use strict';

/**
 * 广告任务令牌与查看券单测
 *
 * 依据：《项目说明书-月老办事处》§2.2（流程 B：看广告 → 发券 → 一次性消费解锁）、§5.4（防重放）。
 * 覆盖：令牌 TTL 与归属、完整观看判定、券一次性消费、跨档案复用拦截、过期语义、豁免通道、复看记录。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryStore } = require('../server/lib/store.js');
const { ERROR_CODES, LIMITS, PROFILE_STATUS } = require('../miniapp/shared/client-constants.js');
const { createTask, claimTicket, consumeTicket, recordUnlock } = require('../server/lib/ticket.js');

const NOW = Date.UTC(2026, 0, 1);

function putTarget(store, id, status) {
  store.saveProfile({
    profileId: id,
    openid: `owner_${id}`,
    gender: 'female',
    birthYear: 1998,
    contactType: 'douyin',
    normalizedContact: `cand_${id}`,
    contactHash: `hash_${id}`,
    status: status || PROFILE_STATUS.ACTIVE,
    createdAt: 0,
    updatedAt: 0,
  });
}

async function throwsCode(fn, code) {
  await assert.rejects(async () => fn(), (err) => err && err.code === code);
}

test('createTask：目标不存在 / 已下架 / 未登录均拒绝，合法则发放一次性令牌', async () => {
  const store = createMemoryStore({});
  putTarget(store, 'MM-T1');
  putTarget(store, 'MM-T2', PROFILE_STATUS.OFFLINE);

  await throwsCode(() => createTask(store, { openid: 'me', profileId: 'MM-NONE', now: NOW }), ERROR_CODES.PROFILE_NOT_FOUND);
  await throwsCode(() => createTask(store, { openid: 'me', profileId: 'MM-T2', now: NOW }), ERROR_CODES.PROFILE_OFFLINE);
  await throwsCode(() => createTask(store, { openid: '', profileId: 'MM-T1', now: NOW }), ERROR_CODES.NOT_REGISTERED);

  const task = await createTask(store, { openid: 'me', profileId: 'MM-T1', now: NOW });
  assert.match(task.token, /^t_[a-f0-9]{24}$/);
  assert.equal(task.exempt, false);
  assert.equal(task.expiresAt, NOW + LIMITS.TASK_TTL_MS);
});

test('claimTicket：未完整观看不发券，并报 TASK_NOT_FINISHED', async () => {
  const store = createMemoryStore({});
  putTarget(store, 'MM-T1');
  const task = await createTask(store, { openid: 'me', profileId: 'MM-T1', now: NOW });

  await throwsCode(
    () => claimTicket(store, { openid: 'me', taskToken: task.token, adFinished: false, playedMs: 1000, now: NOW }),
    ERROR_CODES.TASK_NOT_FINISHED,
  );
});

test('claimTicket：完整观看后发放查看券（TTL = TICKET_TTL_MS）', async () => {
  const store = createMemoryStore({});
  putTarget(store, 'MM-T1');
  const task = await createTask(store, { openid: 'me', profileId: 'MM-T1', now: NOW });

  const ticket = await claimTicket(store, { openid: 'me', taskToken: task.token, adFinished: true, playedMs: 15000, now: NOW });
  assert.match(ticket.ticketId, /^k_[a-f0-9]{24}$/);
  assert.equal(ticket.profileId, 'MM-T1');
  assert.equal(ticket.expiresAt, NOW + LIMITS.TICKET_TTL_MS);
});

test('claimTicket：令牌一次性 —— 复用、错归属、过期均拒绝', async () => {
  const store = createMemoryStore({});
  putTarget(store, 'MM-T1');
  const task = await createTask(store, { openid: 'me', profileId: 'MM-T1', now: NOW });

  await throwsCode(() => claimTicket(store, { openid: 'me', taskToken: 't_bogus', adFinished: true, now: NOW }), ERROR_CODES.TASK_NOT_FOUND);
  await throwsCode(() => claimTicket(store, { openid: 'other', taskToken: task.token, adFinished: true, now: NOW }), ERROR_CODES.TASK_NOT_FOUND);

  await claimTicket(store, { openid: 'me', taskToken: task.token, adFinished: true, now: NOW });
  await throwsCode(() => claimTicket(store, { openid: 'me', taskToken: task.token, adFinished: true, now: NOW }), ERROR_CODES.TASK_NOT_FOUND);

  const overdue = await createTask(store, { openid: 'me', profileId: 'MM-T1', now: NOW });
  await throwsCode(
    () => claimTicket(store, { openid: 'me', taskToken: overdue.token, adFinished: true, now: NOW + LIMITS.TASK_TTL_MS + 1 }),
    ERROR_CODES.TASK_NOT_FOUND,
  );
});

test('claimTicket：豁免通道（exempt）无需完整观看即可发券', async () => {
  const store = createMemoryStore({});
  putTarget(store, 'MM-T1');
  const task = await createTask(store, { openid: 'me', profileId: 'MM-T1', now: NOW, exempt: true });

  const ticket = await claimTicket(store, { openid: 'me', taskToken: task.token, adFinished: false, now: NOW });
  assert.equal(ticket.profileId, 'MM-T1');
});

test('consumeTicket：一次性消费；跨档案复用与重复消费均拒绝；过期单独报 TICKET_EXPIRED', async () => {
  const store = createMemoryStore({});
  putTarget(store, 'MM-T1');
  const task = await createTask(store, { openid: 'me', profileId: 'MM-T1', now: NOW });
  const ticket = await claimTicket(store, { openid: 'me', taskToken: task.token, adFinished: true, now: NOW });

  await throwsCode(() => consumeTicket(store, { openid: 'me', profileId: 'MM-T2', ticketId: ticket.ticketId, now: NOW }), ERROR_CODES.TICKET_NOT_FOUND);
  await throwsCode(() => consumeTicket(store, { openid: 'other', profileId: 'MM-T1', ticketId: ticket.ticketId, now: NOW }), ERROR_CODES.TICKET_NOT_FOUND);

  assert.equal((await consumeTicket(store, { openid: 'me', profileId: 'MM-T1', ticketId: ticket.ticketId, now: NOW })).ticketId, ticket.ticketId);
  await throwsCode(() => consumeTicket(store, { openid: 'me', profileId: 'MM-T1', ticketId: ticket.ticketId, now: NOW }), ERROR_CODES.TICKET_NOT_FOUND);

  const task2 = await createTask(store, { openid: 'me', profileId: 'MM-T1', now: NOW });
  const ticket2 = await claimTicket(store, { openid: 'me', taskToken: task2.token, adFinished: true, now: NOW });
  await throwsCode(
    () => consumeTicket(store, { openid: 'me', profileId: 'MM-T1', ticketId: ticket2.ticketId, now: NOW + LIMITS.TICKET_TTL_MS + 1 }),
    ERROR_CODES.TICKET_EXPIRED,
  );
});

test('recordUnlock：写入 30 天免费复看窗口', async () => {
  const store = createMemoryStore({});
  const record = await recordUnlock(store, { openid: 'me', profileId: 'MM-T1', now: NOW });
  assert.equal(record.expiresAt, NOW + LIMITS.FREE_REVISIT_MS);
  assert.equal(store.getUnlock('me', 'MM-T1').unlockedAt, NOW);
});
