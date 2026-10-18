'use strict';

/**
 * 云函数业务处理器（《项目说明书》§2 业务流程、§5 广告与风控、§6.4 脱敏）
 *
 * 设计：handler 为**纯函数** `(params, ctx) => Promise<Envelope>`，ctx 由薄壳装配：
 *   `ctx = { openid, store, now: () => ms, config, random }`
 * 好处：Node 下可直接单测（注入内存 store 与确定性 random），平台相关逻辑全部留在薄壳里。
 *
 * 存储调用一律 `await`：内存实现是同步的、云数据库实现是异步的，统一 await 后两者可互换。
 * 所有 handler 经 `guard` 包裹，异常收敛为失败信封，绝不把堆栈抛给客户端。
 */

const { AD, LIMITS, PROFILE_STATUS } = require('../../miniapp/shared/client-constants.js');
const { ERROR_CODES, domainError } = require('./errors.js');
const { ok, fromError } = require('./envelope.js');
const { maskContact } = require('./mask.js');
const profileLib = require('./profile.js');
const matchLib = require('./match.js');
const ticketLib = require('./ticket.js');
const risk = require('./risk.js');

/** 举报原因白名单（与 P-06 页面单选一致） */
const REPORT_REASONS = ['fake', 'harass', 'other'];
const MAX_EVENT_BATCH = 50;

/**
 * 配置读取：广告位 adUnitId **不在客户端硬编码**，一律由服务端下发（说明书 §5.1），
 * 来源为部署环境变量 `MM_AD_UNIT_IDS`（逗号分隔，取前 AD.POOL_SIZE 个做轮询）。
 * 未配置时返回空数组，客户端据此走「广告加载失败」降级文案，不影响主链路可用性。
 */
function configOf(ctx) {
  const config = ctx.config || {};
  if (!config.adUnitIds) {
    const raw = (typeof process !== 'undefined' && process.env && process.env.MM_AD_UNIT_IDS) || '';
    config.adUnitIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, AD.POOL_SIZE);
    ctx.config = config;
  }
  return config;
}

/** 风险判定结果 → 领域异常（错误码与客户端契约同名，见 client-constants.js） */
function assertAllowed(result) {
  if (result && result.ok === false) {
    throw domainError(ERROR_CODES[result.code] || ERROR_CODES.SERVER_ERROR, result.reason, {
      retryAfterMs: result.retryAfterMs,
    });
  }
}

/** 身份守卫：无 openid 无法记账与判重（平台薄壳从请求头直读，正常链路必不为空） */
function requireOpenid(ctx) {
  if (!ctx.openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');
  return ctx.openid;
}

/**
 * 读「我」的档案，**允许为 null**。
 *
 * 取签不再以「先留缘签」为前提 —— 未留缘签 / 审核中 / 已下架的用户同样可以直接取签；
 * 档案主要用于「自身不可解锁」等归属校验。
 */
async function loadProfile(ctx) {
  requireOpenid(ctx);
  return ctx.store.getProfileByOpenid(ctx.openid);
}

/** 统一异常收敛：任何 handler 的抛出都变成失败信封 */
function guard(handler) {
  return async function wrapped(params, ctx) {
    try {
      return await handler(params || {}, ctx);
    } catch (err) {
      return fromError(err);
    }
  };
}

/* ============================ 登记（流程 A） ============================ */

/** submitProfile：登记 / 变更联系方式（变更后需重新机审，说明书 §2.1 A8） */
const handleSubmitProfile = guard(async (params, ctx) => {
  const result = await profileLib.submitProfile(ctx.store, { openid: ctx.openid, input: params, now: ctx.now() });
  return ok(result);
});

/** getProfile：读取我的档案（未留缘签返回 profile: null，不视为错误），并附今日配额快照供页面展示 */
const handleGetProfile = guard(async (params, ctx) => {
  const now = ctx.now();
  const raw = await ctx.store.getProfileByOpenid(ctx.openid);
  const profile = raw ? profileLib.toPublicProfile(raw) : null;
  const quota = ctx.openid
    ? await risk.quotaSnapshot(ctx.store, { openid: ctx.openid, now, profile: raw })
    : null;
  return ok({ profile, quota });
});

/** offlineProfile：上架 / 下架 */
const handleOfflineProfile = guard(async (params, ctx) => {
  const result = await profileLib.setOffline(ctx.store, { openid: ctx.openid, action: params.action, now: ctx.now() });
  return ok(result);
});

/* ============================ 获取（流程 B） ============================ */

/**
 * getMatch：按用户选定的签筒随机取 1 份缘签。
 * `pool`（male / female）为必填 —— 取签流程由客户端「选男/女签筒」驱动。
 * 池子为空**不是错误**，而是正常业务态（客户端展示「今日的缘签已取完」空态）。
 * 未留缘签的用户也能取签（见 matchLib.pickMatch）。
 */
const handleGetMatch = guard(async (params, ctx) => {
  const now = ctx.now();
  requireOpenid(ctx);

  const pool = params.pool;
  if (matchLib.POOLS.indexOf(pool) === -1) throw domainError(ERROR_CODES.INVALID_PARAM, 'pool_required');

  assertAllowed(await risk.checkMatch(ctx.store, { openid: ctx.openid, now }));

  const picked = await matchLib.pickMatch(ctx.store, {
    openid: ctx.openid,
    pool,
    now,
    random: ctx.random,
  });

  const profile = await ctx.store.getProfileByOpenid(ctx.openid);

  if (picked.poolEmpty) {
    return ok({
      poolEmpty: true,
      card: null,
      quota: await risk.quotaSnapshot(ctx.store, { openid: ctx.openid, now, profile }),
    });
  }

  await risk.noteMatch(ctx.store, { openid: ctx.openid, now });

  return ok({
    poolEmpty: false,
    card: picked.card,
    quota: await risk.quotaSnapshot(ctx.store, { openid: ctx.openid, now, profile }),
  });
});

/**
 * createAdTask：发放广告任务令牌。
 * 关键顺序：**先校验冷却与配额再让用户看广告**，避免用户白看一条广告却拿不到解锁。
 * 命中「广告连续失败豁免」时直接发放 exempt 任务（当日一次，说明书 §5.3）。
 */
const handleCreateAdTask = guard(async (params, ctx) => {
  const now = ctx.now();
  const profile = await loadProfile(ctx);
  const profileId = params.profileId;
  if (!profileId) throw domainError(ERROR_CODES.INVALID_PARAM, 'profile_id_required');
  if (profile && profileId === profile.profileId) throw domainError(ERROR_CODES.INVALID_PARAM, 'self_unlock_forbidden');

  assertAllowed(await risk.checkAdTrigger(ctx.store, { openid: ctx.openid, now, profile }));

  // 已获取过（30 天内）无需再看广告：直接复用历史记录，不消耗次数（说明书 §5.3）
  const existing = await ctx.store.getUnlock(ctx.openid, profileId);
  if (existing && now - existing.unlockedAt < LIMITS.FREE_REVISIT_MS) {
    return ok({ freeRevisit: true, profileId, adUnitIds: [], taskToken: '' });
  }

  const exempt = await risk.grantExempt(ctx.store, { openid: ctx.openid, now });
  await risk.noteAdTrigger(ctx.store, { openid: ctx.openid, now });

  const task = await ticketLib.createTask(ctx.store, { openid: ctx.openid, profileId, now, exempt });
  const config = configOf(ctx);

  return ok({
    taskToken: task.token,
    adUnitIds: exempt ? [] : config.adUnitIds,
    expiresAt: task.expiresAt,
    exempt,
  });
});

/**
 * claimTicket：完整观看后发放查看券。
 * `adFinished !== true` 时**不发放**，同时累计一次广告失败（供豁免通道判定）。
 */
const handleClaimTicket = guard(async (params, ctx) => {
  const now = ctx.now();
  if (!ctx.openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');

  if (params.adFinished !== true) {
    const failure = await risk.noteAdFailure(ctx.store, { openid: ctx.openid, now });
    throw domainError(ERROR_CODES.TASK_NOT_FINISHED, undefined, failure);
  }

  const result = await ticketLib.claimTicket(ctx.store, {
    openid: ctx.openid,
    taskToken: params.taskToken,
    adFinished: params.adFinished,
    playedMs: params.playedMs,
    now,
  });

  await risk.noteAdSuccess(ctx.store, { openid: ctx.openid, now });
  await risk.noteUnlock(ctx.store, { openid: ctx.openid, now });
  await ticketLib.recordUnlock(ctx.store, { openid: ctx.openid, profileId: result.profileId, now });

  const profile = await ctx.store.getProfileByOpenid(ctx.openid);
  return ok({
    ticketId: result.ticketId,
    expiresAt: result.expiresAt,
    profileId: result.profileId,
    quota: await risk.quotaSnapshot(ctx.store, { openid: ctx.openid, now, profile }),
  });
});

/**
 * revealContact：消费查看券并返回明文。
 * **全项目唯一返回明文联系方式的接口**（说明书 §6.4）；客户端拿到后直接写入剪贴板，
 * 不写入视图层 data，不落本地存储。
 */
const handleRevealContact = guard(async (params, ctx) => {
  const now = ctx.now();
  if (!ctx.openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');

  const profileId = params.profileId;
  const ticketId = params.ticketId;
  if (!profileId || !ticketId) throw domainError(ERROR_CODES.INVALID_PARAM, 'profile_id_or_ticket_id_required');

  await ticketLib.consumeTicket(ctx.store, { openid: ctx.openid, profileId, ticketId, now });

  const target = await ctx.store.getProfileById(profileId);
  if (!target) throw domainError(ERROR_CODES.PROFILE_NOT_FOUND);
  if (target.status !== PROFILE_STATUS.ACTIVE) throw domainError(ERROR_CODES.PROFILE_OFFLINE);

  return ok({
    contact: target.normalizedContact,
    contactType: target.contactType,
    maskedContact: maskContact(target.contactType, target.normalizedContact),
  });
});

/** listUnlocked：我的解锁记录（含免费复看标记） */
const handleListUnlocked = guard(async (params, ctx) => {
  const now = ctx.now();
  if (!ctx.openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');

  const records = await ctx.store.listUnlocks(ctx.openid);
  const items = [];

  for (const record of records) {
    const target = await ctx.store.getProfileById(record.profileId);
    if (!target || target.status !== PROFILE_STATUS.ACTIVE) {
      items.push({ profileId: record.profileId, available: false, expired: true });
      continue;
    }
    const view = profileLib.toPublicProfile(target);
    items.push({
      profileId: view.profileId,
      gender: view.gender,
      maskedContact: view.maskedContact,
      contactType: view.contactType,
      unlockedAt: record.unlockedAt,
      expiresAt: record.expiresAt,
      freeRevisit: now - record.unlockedAt < record.expiresAt - record.unlockedAt,
      available: true,
    });
  }

  items.sort((a, b) => (b.unlockedAt || 0) - (a.unlockedAt || 0));
  const profile = await ctx.store.getProfileByOpenid(ctx.openid);
  return ok({ items, quota: await risk.quotaSnapshot(ctx.store, { openid: ctx.openid, now, profile }) });
});

/* ============================ 举报与埋点 ============================ */

/** reportProfile：举报（风控输入源） */
const handleReportProfile = guard(async (params, ctx) => {
  const result = await profileLib.report(ctx.store, { openid: ctx.openid, input: params, now: ctx.now() });
  return ok(result);
});

/**
 * reportEvents：埋点批量上报（说明书 §7.1）。
 * 骨架阶段只做计数与批次上限保护，不落库（真实分析链路由数据侧接入）。
 */
const handleReportEvents = guard(async (params, ctx) => {
  const events = Array.isArray(params.events) ? params.events.slice(0, MAX_EVENT_BATCH) : [];
  return ok({ accepted: events.length });
});

module.exports = {
  handleSubmitProfile,
  handleGetProfile,
  handleOfflineProfile,
  handleGetMatch,
  handleCreateAdTask,
  handleClaimTicket,
  handleRevealContact,
  handleListUnlocked,
  handleReportProfile,
  handleReportEvents,
  REPORT_REASONS,
};
