'use strict';

/**
 * 广告任务令牌与查看券（《项目说明书》§2.2 流程 B、§5.4 风控）
 *
 * 三步链路，全部服务端记账：
 *   createAdTask → 发放一次性任务令牌（绑定 openid + 目标档案，TTL = LIMITS.TASK_TTL_MS）
 *   claimTicket  → 校验「完整观看」后发放查看券（TTL = LIMITS.TICKET_TTL_MS，绑定目标档案）
 *   consumeTicket→ revealContact 时一次性消费（防重放：券用过即废）
 *
 * 防篡改要点：令牌与券均为服务端生成、一次性、绑定目标档案，客户端无法伪造或跨档案复用。
 */

const crypto = require('node:crypto');
const { LIMITS, PROFILE_STATUS } = require('../../miniapp/shared/client-constants.js');
const { ERROR_CODES, domainError } = require('./errors.js');

function token(prefix) {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * 发放广告任务令牌。
 * @param {object} args `{ profileId, exempt }` exempt=true 表示走「广告连续失败豁免」通道，无需完整观看
 */
async function createTask(store, { openid, profileId, now, exempt }) {
  if (!openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');

  const target = await store.getProfileById(profileId);
  if (!target) throw domainError(ERROR_CODES.PROFILE_NOT_FOUND);
  if (target.status !== PROFILE_STATUS.ACTIVE) throw domainError(ERROR_CODES.PROFILE_OFFLINE);

  const task = {
    token: token('t_'),
    openid,
    profileId,
    exempt: !!exempt,
    used: false,
    createdAt: now,
    expiresAt: now + LIMITS.TASK_TTL_MS,
  };
  await store.saveTask(task);
  return task;
}

/**
 * 完整观看后发放查看券。
 * `adFinished` 必须严格为 true（客户端侧以 `res.isEndReached === true` 判定，说明书 §5.4）。
 * 豁免通道的任务跳过该判定。
 */
async function claimTicket(store, { openid, taskToken, adFinished, playedMs, now }) {
  if (!openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');

  const task = await store.getTask(taskToken);
  if (!task || task.openid !== openid || task.used) throw domainError(ERROR_CODES.TASK_NOT_FOUND);
  if (now > task.expiresAt) throw domainError(ERROR_CODES.TASK_NOT_FOUND, 'task_expired');

  if (!task.exempt && adFinished !== true) throw domainError(ERROR_CODES.TASK_NOT_FINISHED, `played_ms=${Number(playedMs) || 0}`);

  task.used = true;
  task.usedAt = now;
  // 云库对读出的令牌不做原地更新：改完必须显式回写，否则「一次性」不成立
  await store.saveTask(task);

  const ticket = {
    ticketId: token('k_'),
    openid,
    profileId: task.profileId,
    used: false,
    createdAt: now,
    expiresAt: now + LIMITS.TICKET_TTL_MS,
  };
  await store.saveTicket(ticket);

  return { ticketId: ticket.ticketId, expiresAt: ticket.expiresAt, profileId: ticket.profileId };
}

/**
 * 一次性消费查看券（revealContact 的唯一准入条件）。
 * 不存在 / 已使用 → TICKET_NOT_FOUND；过期 → TICKET_EXPIRED；档案不匹配 → TICKET_NOT_FOUND（防跨档案复用）。
 */
async function consumeTicket(store, { openid, profileId, ticketId, now }) {
  const ticket = await store.getTicket(ticketId);
  if (!ticket || ticket.openid !== openid || ticket.used || ticket.profileId !== profileId) {
    throw domainError(ERROR_CODES.TICKET_NOT_FOUND);
  }
  if (now > ticket.expiresAt) throw domainError(ERROR_CODES.TICKET_EXPIRED);

  ticket.used = true;
  ticket.usedAt = now;
  // 同 claimTicket：消费状态需显式回写才落库（防重放）
  await store.saveTicket(ticket);
  return ticket;
}

/** 记录一次解锁（30 天内免费复看，说明书 §5.3） */
async function recordUnlock(store, { openid, profileId, now }) {
  return store.saveUnlock(openid, profileId, {
    unlockedAt: now,
    expiresAt: now + LIMITS.FREE_REVISIT_MS,
  });
}

module.exports = { createTask, claimTicket, consumeTicket, recordUnlock };
