/**
 * 抖音云函数服务产物：getProfile.js
 *
 * **构建期生成，禁止手改**。源：server/lib/envelope.js / server/lib/errors.js / server/lib/handlers.js / server/lib/identity.js / server/lib/mask.js / server/lib/match.js / server/lib/profile.js / server/lib/risk.js / server/lib/store-cloud.js / server/lib/store-provider.js / server/lib/store.js / server/lib/ticket.js / miniapp/shared/client-constants.js / server/functions/getProfile/index.js
 * 改完源后重跑 `node tools/gen-cloud-functions.js`（生成脚本：tools/gen-cloud-functions.js）。
 *
 * 平台契约：入口 `module.exports = async function (params, context)`，`params` 即 HTTP 请求体本身，
 * 返回值作为 Response Body；调用路径 = 文件名，即 `/getProfile`。
 * 身份：从请求头 `X-TT-OPENID` 直读，无需 login 置换（见 lib/identity.js）。
 */
'use strict';

(function () {
  var __registry = {};
  var __cache = {};

  /** 内部模块解析：命中注册表用打包实现，未命中回落 Node 内置（如 node:crypto）。 */
  function __req(id) {
    if (!Object.prototype.hasOwnProperty.call(__registry, id)) return require(id);
    if (!__cache[id]) {
      var m = { exports: {} };
      __registry[id](m, m.exports, __req);
      __cache[id] = m.exports;
    }
    return __cache[id];
  }

  // ── server/lib/envelope.js
  __registry["server/lib/envelope.js"] = function (module, exports, require) {
'use strict';

/**
 * 统一响应信封（《项目说明书》§8）
 *
 * 形态：`{ code, msg, data }`，code === 0 为成功。
 * 抖音云 `callContainer` 把响应体交给客户端时 `data` 是 **JSON 字符串**，客户端 core/cloud.js 自行 parse
 * 后归一为 `{ ok, code, msg, data }`，因此服务端只需保证信封结构一致。
 */

const { ERROR_CODES, ERROR_NAMES, DomainError } = __req('server/lib/errors.js');

/** 成功信封。 */
function ok(data) {
  return { code: ERROR_CODES.OK, msg: 'ok', data: data === undefined ? {} : data };
}

/**
 * 失败信封。
 * @param {number} code 数值错误码
 * @param {string} [detail] 附加说明（面向日志，不面向用户）
 * @param {object} [meta] 结构化附加信息，挂到 data 上供客户端分支
 */
function fail(code, detail, meta) {
  const name = ERROR_NAMES[code] || 'UNKNOWN_ERROR';
  return {
    code,
    msg: detail ? `${name}: ${detail}` : name,
    data: meta === undefined ? null : meta,
  };
}

/**
 * 把任意异常收敛为失败信封：非 DomainError 一律归为 SERVER_ERROR，避免把内部细节泄漏给前端。
 */
function fromError(err) {
  if (err instanceof DomainError) return fail(err.code, err.detail, err.meta);
  return fail(ERROR_CODES.SERVER_ERROR, err && err.message ? String(err.message) : undefined);
}

/** 判断信封是否成功。 */
function isOk(envelope) {
  return !!envelope && envelope.code === ERROR_CODES.OK;
}

/** 序列化为 JSON 字符串（薄壳返回给平台的响应体形态）。 */
function serialize(envelope) {
  return JSON.stringify(envelope);
}

module.exports = { ok, fail, fromError, isOk, serialize };
  };

  // ── server/lib/errors.js
  __registry["server/lib/errors.js"] = function (module, exports, require) {
'use strict';

/**
 * 服务端错误码（《项目说明书》§8、客户端契约 client-constants.js）
 *
 * 事实来源：`miniapp/shared/client-constants.js` 的 ERROR_CODES —— 服务端与客户端**必须逐条同值**，
 * 否则前端无法把服务端错误收敛成合规文案（如 DAILY_UNLOCK_LIMIT → COPY.DAILY_LIMIT）。
 * 因此此处直接引用同一份契约，而非各自维护一份。
 */

const { ERROR_CODES } = __req('miniapp/shared/client-constants.js');

/** 数值码 → 名称，便于日志排查；名称即信封 msg 的前缀 */
const ERROR_NAMES = Object.fromEntries(Object.entries(ERROR_CODES).map(([name, code]) => [code, name]));

/** 领域异常：携带错误码，由 envelope.fromError 收敛为失败信封，不泄漏内部堆栈 */
class DomainError extends Error {
  constructor(code, detail, meta) {
    super(detail ? `${ERROR_NAMES[code] || 'UNKNOWN_ERROR'}: ${detail}` : ERROR_NAMES[code] || 'UNKNOWN_ERROR');
    this.name = 'DomainError';
    this.code = code;
    this.detail = detail;
    this.meta = meta;
  }
}

/** 快捷构造：`throw domainError(ERROR_CODES.NOT_REGISTERED)` */
function domainError(code, detail, meta) {
  return new DomainError(code, detail, meta);
}

module.exports = { ERROR_CODES, ERROR_NAMES, DomainError, domainError };
  };

  // ── server/lib/handlers.js
  __registry["server/lib/handlers.js"] = function (module, exports, require) {
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

const { AD, LIMITS, PROFILE_STATUS } = __req('miniapp/shared/client-constants.js');
const { ERROR_CODES, domainError } = __req('server/lib/errors.js');
const { ok, fromError } = __req('server/lib/envelope.js');
const { maskContact } = __req('server/lib/mask.js');
const profileLib = __req('server/lib/profile.js');
const matchLib = __req('server/lib/match.js');
const ticketLib = __req('server/lib/ticket.js');
const risk = __req('server/lib/risk.js');

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

/** 取「我」的档案，并断言可参与匹配（未登记 / 审核中 / 已下架均不可获取） */
async function requireActiveProfile(ctx) {
  if (!ctx.openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');
  const profile = await ctx.store.getProfileByOpenid(ctx.openid);
  if (!profile) throw domainError(ERROR_CODES.NOT_REGISTERED);
  if (profile.status === PROFILE_STATUS.PENDING) throw domainError(ERROR_CODES.AUDIT_PENDING);
  if (profile.status !== PROFILE_STATUS.ACTIVE) throw domainError(ERROR_CODES.PROFILE_OFFLINE, profile.status);
  return profile;
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

/** getProfile：读取我的档案（未登记返回 profile: null，不视为错误） */
const handleGetProfile = guard(async (params, ctx) => {
  const profile = await profileLib.getMyProfile(ctx.store, { openid: ctx.openid, now: ctx.now() });
  return ok({ profile });
});

/** offlineProfile：上架 / 下架 */
const handleOfflineProfile = guard(async (params, ctx) => {
  const result = await profileLib.setOffline(ctx.store, { openid: ctx.openid, action: params.action, now: ctx.now() });
  return ok(result);
});

/* ============================ 获取（流程 B） ============================ */

/**
 * getMatch：随机匹配 1 份档案。
 * 池子为空**不是错误**，而是正常业务态（客户端展示「今日可获取的资料已取完」空态）。
 */
const handleGetMatch = guard(async (params, ctx) => {
  const now = ctx.now();
  const profile = await requireActiveProfile(ctx);

  assertAllowed(await risk.checkMatch(ctx.store, { openid: ctx.openid, now }));

  const picked = await matchLib.pickMatch(ctx.store, {
    openid: ctx.openid,
    profile,
    now,
    random: ctx.random,
  });

  if (picked.poolEmpty) {
    return ok({
      poolEmpty: true,
      relaxationLevel: picked.relaxationLevel,
      card: null,
      quota: await risk.quotaSnapshot(ctx.store, { openid: ctx.openid, now, profile }),
    });
  }

  await risk.noteMatch(ctx.store, { openid: ctx.openid, now });

  return ok({
    poolEmpty: false,
    relaxationLevel: picked.relaxationLevel,
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
  const profile = await requireActiveProfile(ctx);
  const profileId = params.profileId;
  if (!profileId) throw domainError(ERROR_CODES.INVALID_PARAM, 'profile_id_required');
  if (profileId === profile.profileId) throw domainError(ERROR_CODES.INVALID_PARAM, 'self_unlock_forbidden');

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
    const view = profileLib.toPublicProfile(target, now);
    items.push({
      profileId: view.profileId,
      gender: view.gender,
      age: view.age,
      maskedContact: view.maskedContact,
      contactType: view.contactType,
      unlockedAt: record.unlockedAt,
      expiresAt: record.expiresAt,
      freeRevisit: now - record.unlockedAt < record.expiresAt - record.unlockedAt,
      available: true,
    });
  }

  items.sort((a, b) => (b.unlockedAt || 0) - (a.unlockedAt || 0));
  return ok({ items });
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
  };

  // ── server/lib/identity.js
  __registry["server/lib/identity.js"] = function (module, exports, require) {
'use strict';

/**
 * 身份解析（《项目说明书》§3.2 工程约定）
 *
 * 抖音云托管服务端**可直接从请求 header 读取用户身份**（`X-TT-OPENID` 等），
 * 无需 `tt.login` + `code2Session` 置换登录态，也不存在 `tt.cloud.callFunction` 形态。
 *
 * 三级取值，全部防御式（取不到不抛错，交由业务层返回 NOT_REGISTERED）：
 *   ① 容器请求头 `context.request.headers['x-tt-openid']`（真实部署路径）；
 *   ② 扁平头对象 `context.headers['x-tt-openid']`（不同装配形态的兼容）；
 *   ③ 参数上的 `params.__openid`（仅本地调试与单测注入使用，**生产不依赖**）。
 */

const OPENID_HEADER = 'x-tt-openid';

/** 从容器事件上下文中取出归一化后的 header 集合 */
function headersOf(context) {
  if (!context || typeof context !== 'object') return {};
  if (context.request && typeof context.request.headers === 'object') return context.request.headers || {};
  if (typeof context.headers === 'object' && context.headers) return context.headers;
  return {};
}

/**
 * 解析调用者 openid。
 * @param {object} [context] 云函数上下文（平台注入）
 * @param {object} [params] 业务参数（仅取调试用的 __openid）
 * @returns {string} 取不到时返回空串
 */
function readOpenid(context, params) {
  const headers = headersOf(context);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === OPENID_HEADER) {
      const value = headers[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  const injected = params && params.__openid;
  return typeof injected === 'string' ? injected : '';
}

module.exports = { OPENID_HEADER, readOpenid };
  };

  // ── server/lib/mask.js
  __registry["server/lib/mask.js"] = function (module, exports, require) {
'use strict';

/**
 * 服务端联系方式脱敏与归一（《项目说明书》§6.4）
 *
 * 合规硬边界：
 *   ① 除 `revealContact` 一次性返回明文外，**任何对外响应只允许出现掩码**；
 *   ② 联系方式比对去重**只允许使用哈希**，不得存明文用于比对；
 *   ③ 微信号 / QQ 不在白名单内（说明书 §6.4：微信号不建议、QQ 不支持）。
 */

const crypto = require('node:crypto');
const { CONTACT_TYPES } = __req('miniapp/shared/client-constants.js');

/** 掩码占位（长度不足或格式非法时的退化形态，避免泄漏位数） */
const MASK_FALLBACK = '****';

/**
 * 归一化：用于去重与校验（不含掩码展示）。
 * 手机号去空格与分隔符；抖音号去空格并小写（保证同一账号的不同书写形式哈希一致）。
 */
function normalizeContact(type, raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  if (type === CONTACT_TYPES.PHONE) return text.replace(/[\s\-()]/g, '');
  return text.toLowerCase();
}

/**
 * 校验联系方式格式（说明书 §6.2 事前字段级机审）。
 * @returns {{ok:boolean, normalized:string, reason?:string}}
 */
function validateContact(type, raw) {
  if (type !== CONTACT_TYPES.PHONE && type !== CONTACT_TYPES.DOUYIN) {
    return { ok: false, normalized: '', reason: 'contact_type_not_allowed' };
  }
  const normalized = normalizeContact(type, raw);

  if (type === CONTACT_TYPES.PHONE) {
    if (!/^1[3-9]\d{9}$/.test(normalized)) return { ok: false, normalized, reason: 'phone_format' };
    return { ok: true, normalized };
  }

  // 抖音号：字母数字与 . _ - ，长度 4–24（过短易伪造，由机审另行判可疑）
  if (!/^[a-z0-9._-]{4,24}$/.test(normalized)) return { ok: false, normalized, reason: 'douyin_format' };
  return { ok: true, normalized };
}

/**
 * 掩码：手机号保前 3 后 4（`138****8888`）；抖音号保前 2 后 2（`dy_ab****yz`）。
 * 格式非法时退化为 `****`，绝不返回任何有效位。
 */
function maskContact(type, raw) {
  const normalized = normalizeContact(type, raw);

  if (type === CONTACT_TYPES.PHONE) {
    if (!/^1[3-9]\d{9}$/.test(normalized)) return MASK_FALLBACK;
    return `${normalized.slice(0, 3)}****${normalized.slice(-4)}`;
  }

  if (type === CONTACT_TYPES.DOUYIN) {
    // 前缀名保留首字母语义（如 dy_abcd → dy_ab****cd）
    if (normalized.length < 6) return 'd****';
    return `${normalized.slice(0, 2)}****${normalized.slice(-2)}`;
  }

  return MASK_FALLBACK;
}

/**
 * 联系方式哈希：仅用于去重比对，不参与任何展示。
 * 加 type 前缀避免「同一串数字被当作两种类型」产生歧义。
 */
function hashContact(type, raw) {
  const normalized = normalizeContact(type, raw);
  return crypto.createHash('sha256').update(`${type}:${normalized}`).digest('hex');
}

module.exports = {
  MASK_FALLBACK,
  normalizeContact,
  validateContact,
  maskContact,
  hashContact,
};
  };

  // ── server/lib/match.js
  __registry["server/lib/match.js"] = function (module, exports, require) {
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

const { LIMITS, PROFILE_STATUS } = __req('miniapp/shared/client-constants.js');
const { ageOf, toPublicProfile } = __req('server/lib/profile.js');

/** 默认随机源；单测注入确定性 random 以保证可断言 */
function defaultRandom(max) {
  return Math.floor(Math.random() * max);
}

function oppositeOf(gender) {
  return gender === 'male' ? 'female' : 'male';
}

/**
 * 抽取 1 份档案。
 * @param {object} store 存储
 * @param {object} args `{ openid, profile, now, random }`
 * @returns {Promise<{poolEmpty:boolean, relaxationLevel:number, card:object|null}>}
 */
async function pickMatch(store, args) {
  const { openid, profile, now } = args;
  const random = typeof args.random === 'function' ? args.random : defaultRandom;
  const steps = LIMITS.MATCH_AGE_STEPS;

  const myAge = ageOf(profile.birthYear, now);
  const wantGender = oppositeOf(profile.gender);

  const candidates = (await store.listActiveProfiles())
    .filter((p) => p.openid !== openid && p.gender === wantGender && p.status === PROFILE_STATUS.ACTIVE);

  const unlockedIds = new Set((await store.listUnlocks(openid)).map((u) => u.profileId));
  const fresh = candidates.filter((p) => !unlockedIds.has(p.profileId));

  // ③ 年龄邻近逐级放宽（仅对未获取过的档案）
  for (let level = 0; level < steps.length; level += 1) {
    const step = steps[level];
    const bucket = fresh.filter((p) => Math.abs(ageOf(p.birthYear, now) - myAge) <= step);
    if (bucket.length) {
      const picked = bucket[random(bucket.length)];
      return { poolEmpty: false, relaxationLevel: level, card: await toMatchCard(picked, { now, store, openid }) };
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

/** 卡片视图：带解锁态与免费复看标记，联系方式一律掩码 */
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
  };

  // ── server/lib/profile.js
  __registry["server/lib/profile.js"] = function (module, exports, require) {
'use strict';

/**
 * 档案登记与机审（《项目说明书》§2.1 流程 A、§6.2 虚假信息治理）
 *
 * 强约束：`1 openid = 1 档案 = 1 联系方式`。
 * 极简字段集：性别、年龄（入库存出生年份，展示时按年自动换算）、联系方式。
 */

const crypto = require('node:crypto');
const { CONTACT_TYPES, LIMITS, PROFILE_STATUS } = __req('miniapp/shared/client-constants.js');
const { ERROR_CODES, domainError } = __req('server/lib/errors.js');
const { maskContact, validateContact, hashContact, normalizeContact } = __req('server/lib/mask.js');

const GENDERS = ['male', 'female'];
const PROFILE_ID_PREFIX = 'MM-';
/** 联系方式归一后连续 6 位以上相同字符，视为可疑（防凑数注册） */
const SUSPECT_REPEAT = /(\d)\1{5,}/;

/** 展示用年龄：按出生年份在「当前自然年」下的周岁换算，避免年龄随填报时间过期 */
function ageOf(birthYear, now) {
  const year = new Date(now).getUTCFullYear();
  return Math.max(0, year - Number(birthYear));
}

function randomProfileId() {
  return `${PROFILE_ID_PREFIX}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

/**
 * 字段级机审（说明书 §6.2 事前环节）。
 * 校验不通过 → 参数错误直接驳回；规则命中 → 转人工复核（status: pending）。
 * @returns {{status:string, reason?:string}}
 */
function audit(input) {
  const age = ageOf(input.birthYear, input.now);
  const suspectReasons = [];

  if (age === LIMITS.AGE_MIN || age === LIMITS.AGE_MAX) suspectReasons.push('boundary_age');
  if (SUSPECT_REPEAT.test(input.normalized)) suspectReasons.push('repeated_digits');
  if (input.contactType === CONTACT_TYPES.DOUYIN && input.normalized.length < 6) suspectReasons.push('short_contact');

  if (suspectReasons.length) return { status: PROFILE_STATUS.PENDING, reason: suspectReasons.join(',') };
  return { status: PROFILE_STATUS.ACTIVE };
}

/** 对外档案视图：**只出掩码**，永不含明文（说明书 §6.4） */
function toPublicProfile(profile, now) {
  if (!profile) return null;
  const view = {
    profileId: profile.profileId,
    gender: profile.gender,
    age: ageOf(profile.birthYear, now),
    birthYear: profile.birthYear,
    contactType: profile.contactType,
    maskedContact: maskContact(profile.contactType, profile.normalizedContact || profile.contactEnc || ''),
    status: profile.status,
  };
  if (profile.rejectReason) view.rejectReason = profile.rejectReason;
  return view;
}

/** 提交/更新档案（同一入口承担首次登记与联系方式变更，说明书 §2.1 A8） */
async function submitProfile(store, { openid, input, now }) {
  if (!openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');
  const params = input || {};

  if (params.agreement !== true) throw domainError(ERROR_CODES.INVALID_PARAM, 'agreement_required');
  if (GENDERS.indexOf(params.gender) === -1) throw domainError(ERROR_CODES.INVALID_PARAM, 'gender_invalid');

  const birthYear = Number(params.birthYear);
  if (!Number.isInteger(birthYear)) throw domainError(ERROR_CODES.INVALID_PARAM, 'birth_year_invalid');
  const age = ageOf(birthYear, now);
  if (age < LIMITS.AGE_MIN || age > LIMITS.AGE_MAX) throw domainError(ERROR_CODES.INVALID_PARAM, 'age_out_of_range');

  const checked = validateContact(params.contactType, params.contact);
  if (!checked.ok) throw domainError(ERROR_CODES.INVALID_PARAM, checked.reason);

  const contactHash = hashContact(params.contactType, checked.normalized);
  const existing = await store.getProfileByOpenid(openid);
  const holder = await store.findByContactHash(contactHash);
  const isSameContact = existing && existing.contactHash === contactHash;

  if (existing && isSameContact) {
    // 已有档案且联系方式未变：明确告知「已登记」，客户端引导去「我的档案」
    throw domainError(ERROR_CODES.ALREADY_REGISTERED, undefined, { profile: toPublicProfile(existing, now) });
  }
  if (holder && holder.openid !== openid) {
    // 同一联系方式仅允许绑定一份档案（说明书 §6.3）
    throw domainError(ERROR_CODES.DUPLICATE_CONTACT);
  }

  const auditResult = audit({ birthYear, normalized: checked.normalized, contactType: params.contactType, now });
  const profileId = existing ? existing.profileId : randomProfileId();

  const profile = {
    profileId,
    openid,
    gender: params.gender,
    birthYear,
    contactType: params.contactType,
    normalizedContact: checked.normalized, // 明文仅存服务端，用于解锁时一次性下发
    contactHash,
    status: auditResult.status,
    rejectReason: auditResult.reason || '',
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    reaudited: !!existing,
  };

  await store.saveProfile(profile);

  return {
    profileId,
    status: profile.status,
    maskedContact: maskContact(profile.contactType, profile.normalizedContact),
    reaudited: profile.reaudited,
    reason: profile.rejectReason || undefined,
  };
}

/** 读取我的档案（未登记返回 null，不抛错） */
async function getMyProfile(store, { openid, now }) {
  if (!openid) return null;
  return toPublicProfile(await store.getProfileByOpenid(openid), now);
}

/** 上/下架（下架后自动移出匹配池，说明书 §2.1） */
async function setOffline(store, { openid, action, now }) {
  if (!openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');
  const profile = await store.getProfileByOpenid(openid);
  if (!profile) throw domainError(ERROR_CODES.PROFILE_NOT_FOUND);

  if (action === 'offline') {
    if (profile.status === PROFILE_STATUS.PENDING) throw domainError(ERROR_CODES.AUDIT_PENDING);
    profile.status = PROFILE_STATUS.OFFLINE;
  } else if (action === 'online') {
    // 重新上架需重新机审（防止下架期间修改内容绕过审核）
    const result = audit({
      birthYear: profile.birthYear,
      normalized: normalizeContact(profile.contactType, profile.normalizedContact),
      contactType: profile.contactType,
      now,
    });
    profile.status = result.status;
    profile.rejectReason = result.reason || '';
  } else {
    throw domainError(ERROR_CODES.INVALID_PARAM, 'action_invalid');
  }

  profile.updatedAt = now;
  await store.saveProfile(profile);
  return { status: profile.status };
}

/** 举报（说明书 §6.1 举报与拉黑、§6.5 惩罚阶梯的输入源） */
async function report(store, { openid, input, now }) {
  if (!openid) throw domainError(ERROR_CODES.NOT_REGISTERED, 'missing_openid');
  const params = input || {};
  const allowed = ['fake', 'harass', 'other'];
  if (allowed.indexOf(params.reasonType) === -1) throw domainError(ERROR_CODES.INVALID_PARAM, 'reason_type_invalid');

  const target = await store.getProfileById(params.profileId);
  if (!target) throw domainError(ERROR_CODES.PROFILE_NOT_FOUND);

  await store.saveReport({
    profileId: params.profileId,
    reporter: openid,
    reasonType: params.reasonType,
    note: typeof params.note === 'string' ? params.note.slice(0, 200) : '',
    createdAt: now,
  });
  return { ok: true };
}

module.exports = {
  GENDERS,
  ageOf,
  audit,
  toPublicProfile,
  submitProfile,
  getMyProfile,
  setOffline,
  report,
};
  };

  // ── server/lib/risk.js
  __registry["server/lib/risk.js"] = function (module, exports, require) {
'use strict';

/**
 * 风控与带量记账（《项目说明书》§5.3 频次限制、§5.4 风控规则）
 *
 * 铁律：**次数发放与消耗 100% 由服务端记账**，客户端计数仅用于 UI 提示，不作为发放依据。
 * 本模块只做「判定」与「记账」，全部返回结构化结果，不抛错（由 handlers 决定如何收敛成信封）。
 */

const { LIMITS } = __req('miniapp/shared/client-constants.js');

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

/** 当前配额快照（供客户端展示；服务端为准） */
async function quotaSnapshot(store, { openid, now, profile }) {
  const c = await counters(store, openid, now);
  const unlockLimit = isNewUser(profile, now) ? LIMITS.NEW_USER_DAILY_UNLOCK : LIMITS.DAILY_UNLOCK;
  return {
    day: dayKey(now),
    matchUsed: c.match,
    matchLimit: LIMITS.DAILY_MATCH,
    unlockUsed: c.unlock,
    unlockLimit,
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
  };

  // ── server/lib/store-cloud.js
  __registry["server/lib/store-cloud.js"] = function (module, exports, require) {
'use strict';

/**
 * 云数据库存储实现（《项目说明书》§3.2、§8.5）
 *
 * 依据：抖音云云数据库（文档型）的服务端唯一通道为官方 Node SDK
 * `@open-dy/node-server-sdk` → `dySDK.database()`。
 * ⚠️ 部署前置条件：部署前**必须在抖音云控制台对应环境开启云数据库组件**，
 * 否则服务会降级为内存存储（store-provider.js 走内存分支并告警）；
 * 云函数为多实例运行，内存实现**不保证跨实例状态可见，禁止用于生产**。
 *
 * 与内存实现（store.js）的关系：**方法签名一一对应**，差异只在载体语义：
 *   1) 全部方法返回 Promise（云库 IO 天然异步）。上层 lib / handlers 统一 `await`，
 *      因此同一套上层逻辑对两种 store 都成立（`await 同步值` 合法）。
 *   2) 文档 `_id` 承担唯一键：profiles 用 openid、contacts 用 contactHash、
 *      tasks 用 token、tickets 用 ticketId、unlocks 用 `openid:profileId`、
 *      counters 用 `openid:day`；reports 追加写入由 SDK 生成 `_id`。
 *   3) `set` 为**替换式写入**且不允许带 `_id`，故一律先 `stripId`。
 *   4) **没有内存里的「原地改字段即落库」语义**：任何对读出的计数 / 令牌 / 券的修改，
 *      都必须显式回写（`saveCounters` / `saveTask` / `saveTicket`），
 *      否则改动只停留在内存副本上、不会落库。
 *   5) 联系方式索引的「清理」用 `set({ profileId: null })` 表达（findByContactHash 视空
 *      profileId 为未登记），避免依赖 SDK 的文档删除接口。**不虚构 SDK 未提供的语义。**
 *
 * 集合（首次写入即创建；需先在抖音云控制台开启「云数据库」组件后生效）：
 *   - mm_profiles  _id = openid
 *   - mm_contacts  _id = contactHash
 *   - mm_tasks     _id = token
 *   - mm_tickets   _id = ticketId
 *   - mm_unlocks   _id = openid:profileId
 *   - mm_counters  _id = openid:day
 *   - mm_reports   _id = SDK 自动生成
 */

const { PROFILE_STATUS } = __req('miniapp/shared/client-constants.js');

const C_PROFILES = 'mm_profiles';
const C_CONTACTS = 'mm_contacts';
const C_TASKS = 'mm_tasks';
const C_TICKETS = 'mm_tickets';
const C_UNLOCKS = 'mm_unlocks';
const C_COUNTERS = 'mm_counters';
const C_REPORTS = 'mm_reports';

/** 去掉库侧 `_id`，使读出的记录字段口径与内存实现一致。 */
function stripId(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

/** `doc(id).get()` → 单条记录（已剔除 `_id`）或 null。 */
async function readDoc(collection, id) {
  const res = await collection.doc(id).get();
  const rows = (res && res.data) || [];
  return rows.length > 0 ? stripId(rows[0]) : null;
}

/** `collection.get()` / `where(...).get()` → 记录数组（已剔除 `_id`）。 */
function readRows(res) {
  const rows = (res && res.data) || [];
  return rows.map(stripId);
}

/** 新计数器的初值（与 store.js 的 emptyCounter 口径一致）。 */
function emptyCounter() {
  return {
    match: 0, // 当日匹配次数
    unlock: 0, // 当日解锁次数（= 完整观看并发放的次数）
    adFail: 0, // 连续广告失败次数
    exemptUsed: false, // 当日豁免通道是否已使用
    lastMatchAt: 0,
    lastAdAt: 0,
    recent: [], // 近期操作时间戳（用于单位时间异常频次判定）
  };
}

const keyOfUnlock = (openid, profileId) => `${openid}:${profileId}`;
const keyOfCounter = (openid, day) => `${openid}:${day}`;

/**
 * @param {{database:()=>object}} dySDK 官方 SDK 的 `dySDK`（`database()` 返回数据库实例）
 */
function createCloudStore(dySDK) {
  const database = dySDK.database();

  const profiles = () => database.collection(C_PROFILES);
  const contacts = () => database.collection(C_CONTACTS);
  const tasks = () => database.collection(C_TASKS);
  const tickets = () => database.collection(C_TICKETS);
  const unlocks = () => database.collection(C_UNLOCKS);
  const counters = () => database.collection(C_COUNTERS);
  const reports = () => database.collection(C_REPORTS);

  return {
    available: true,

    /* ---- 档案 ---- */
    async getProfileByOpenid(openid) {
      return readDoc(profiles(), openid);
    },
    async getProfileById(profileId) {
      const res = await profiles().where({ profileId }).limit(1).get();
      const rows = readRows(res);
      return rows.length > 0 ? rows[0] : null;
    },
    async findByContactHash(hash) {
      const link = await readDoc(contacts(), hash);
      const profileId = link && link.profileId;
      return profileId ? readDoc(profiles(), profileId) : null;
    },
    async saveProfile(profile) {
      const prev = await readDoc(profiles(), profile.openid);
      // 变更联系方式时清理旧哈希索引（置空 profileId，等价于内存实现的删除）
      if (prev && prev.contactHash && prev.contactHash !== profile.contactHash) {
        await contacts().doc(prev.contactHash).set({ profileId: null });
      }
      await profiles().doc(profile.openid).set(stripId(profile));
      if (profile.contactHash) await contacts().doc(profile.contactHash).set({ profileId: profile.profileId });
      return { ...profile };
    },
    async listActiveProfiles() {
      const res = await profiles().where({ status: PROFILE_STATUS.ACTIVE }).get();
      return readRows(res);
    },
    async allProfiles() {
      return readRows(await profiles().get());
    },

    /* ---- 广告任务与查看券 ---- */
    async saveTask(task) {
      await tasks().doc(task.token).set(stripId(task));
      return { ...task };
    },
    async getTask(token) {
      return readDoc(tasks(), token);
    },
    async saveTicket(ticket) {
      await tickets().doc(ticket.ticketId).set(stripId(ticket));
      return { ...ticket };
    },
    async getTicket(ticketId) {
      return readDoc(tickets(), ticketId);
    },

    /* ---- 已获取记录 ---- */
    async saveUnlock(openid, profileId, record) {
      await unlocks().doc(keyOfUnlock(openid, profileId)).set({ ...record, openid, profileId });
      return { ...record };
    },
    async getUnlock(openid, profileId) {
      const doc = await readDoc(unlocks(), keyOfUnlock(openid, profileId));
      return doc ? { unlockedAt: doc.unlockedAt, expiresAt: doc.expiresAt } : null;
    },
    async listUnlocks(openid) {
      const res = await unlocks().where({ openid }).get();
      // 与内存实现的输出口径一致：只回 unlockedAt / expiresAt / profileId
      return readRows(res).map((r) => ({
        profileId: r.profileId,
        unlockedAt: r.unlockedAt,
        expiresAt: r.expiresAt,
      }));
    },

    /* ---- 带量计数（服务端记账，说明书 §5.4） ---- */
    async countersOf(openid, day) {
      const doc = await readDoc(counters(), keyOfCounter(openid, day));
      return doc || emptyCounter();
    },
    /** 显式回写：云库对读出的计数不做原地更新，改动后必须调用本方法才落库。 */
    async saveCounters(openid, day, counter) {
      await counters().doc(keyOfCounter(openid, day)).set(stripId(counter));
      return counter;
    },

    /* ---- 举报 ---- */
    async saveReport(record) {
      await reports().add({ ...record });
      return { ...record };
    },
    async listReports() {
      return readRows(await reports().get());
    },
  };
}

module.exports = {
  createCloudStore,
  COLLECTIONS: {
    C_PROFILES,
    C_CONTACTS,
    C_TASKS,
    C_TICKETS,
    C_UNLOCKS,
    C_COUNTERS,
    C_REPORTS,
  },
};
  };

  // ── server/lib/store-provider.js
  __registry["server/lib/store-provider.js"] = function (module, exports, require) {
'use strict';

/**
 * 运行时存储选择（《项目说明书》§3.2）
 *
 * 云函数为**多实例**，必须用云数据库才能保证跨实例可见；内存实现仅用于本地与单测。
 * 策略：
 *   1) **懒加载**官方 SDK `@open-dy/node-server-sdk`：本地 / 单测环境通常未安装该依赖，
 *      顶层 `require` 会让 `npm test` 直接挂掉；改为入口首次调用时再加载。
 *   2) 云数据库可用 → 使用云库（store-cloud.js）。
 *   3) 不可用 → 降级 store.js（内存）并**显式告警**（禁止静默降级）。
 * 降级语义：内存实现不保证跨实例状态可见，**禁止用于生产**。
 */

const { createMemoryStore } = __req('server/lib/store.js');
const { createCloudStore } = __req('server/lib/store-cloud.js');

/** 默认 SDK 加载器。外部依赖，打包器不改写；由云端 package.json 声明并由平台安装。 */
function loadDefaultSDK() {
  return require('@open-dy/node-server-sdk');
}

/** 取告警输出通道：优先平台运行时的 context.warn，回落到 console.warn。 */
function pickWarn(context) {
  if (context && typeof context.warn === 'function') return context.warn.bind(context);
  if (context && typeof context.log === 'function') return context.log.bind(context);
  return console.warn.bind(console);
}

/**
 * @param {object} [context] 云函数运行时上下文（仅供告警输出）
 * @param {()=>object} [loadSDK] SDK 加载器，默认官方 SDK；单测注入以模拟「可用 / 不可用」
 * @returns {object} store 实例（云库为异步、内存为同步，上层统一 await）
 */
function createRuntimeStore(context, loadSDK = loadDefaultSDK) {
  try {
    const sdk = loadSDK();
    const dySDK = sdk.dySDK || sdk.default || sdk;
    if (!dySDK || typeof dySDK.database !== 'function') {
      throw new Error('SDK 未暴露 dySDK.database()');
    }
    return createCloudStore(dySDK);
  } catch (err) {
    pickWarn(context)(
      '[moonmatch] 云数据库不可用，已降级为内存存储：云函数为多实例，内存不保证跨实例状态可见，**禁止用于生产**。'
      + '请在抖音云控制台对应环境开启云数据库组件（《项目说明书》§3.2、§8.5）：'
      + (err && err.message)
    );
    return createMemoryStore({});
  }
}

module.exports = { createRuntimeStore };
  };

  // ── server/lib/store.js
  __registry["server/lib/store.js"] = function (module, exports, require) {
'use strict';

/**
 * 内存存储实现（《项目说明书》§3.2）
 *
 * 定位：Node 单测与本地调试的默认依赖，同时是**云数据库不可用时的降级实现**。
 * 注意：云函数为多实例，内存实现**不保证跨实例状态可见，不适用于生产**
 * —— 部署前必须在抖音云控制台对应环境开启云数据库组件，否则会静默降级并产生告警。
 *
 * 数据模型（与 store-cloud.js 同接口，便于互相替换）：
 *   profiles     档案（按 openid 唯一，1 openid = 1 档案）
 *   contacts     联系方式哈希 → profileId（去重比对，**不存明文**）
 *   tasks        广告任务令牌（一次性）
 *   tickets      查看券（一次性）
 *   unlocks      已获取记录（openid × profileId）
 *   counters     按自然日的带量计数（匹配/解锁/广告失败/异常频次时间戳）
 *   reports      举报工单
 */

const { PROFILE_STATUS } = __req('miniapp/shared/client-constants.js');

function createMemoryStore(options) {
  const config = options || {};

  const profilesByOpenid = new Map();
  const profilesById = new Map();
  const contacts = new Map();
  const tasks = new Map();
  const tickets = new Map();
  const unlocks = new Map();
  const counters = new Map();
  const reports = [];

  const keyOfUnlock = (openid, profileId) => `${openid}:${profileId}`;
  const keyOfCounter = (openid, day) => `${openid}:${day}`;

  function emptyCounter() {
    return {
      match: 0, // 当日匹配次数
      unlock: 0, // 当日解锁次数（= 完整观看并发放的次数）
      adFail: 0, // 连续广告失败次数
      exemptUsed: false, // 当日豁免通道是否已使用
      lastMatchAt: 0,
      lastAdAt: 0,
      recent: [], // 近期操作时间戳（用于单位时间异常频次判定）
    };
  }

  return {
    /* ---- 档案 ---- */
    getProfileByOpenid(openid) {
      return profilesByOpenid.get(openid) || null;
    },
    getProfileById(profileId) {
      return profilesById.get(profileId) || null;
    },
    findByContactHash(hash) {
      const profileId = contacts.get(hash);
      return profileId ? profilesById.get(profileId) || null : null;
    },
    saveProfile(profile) {
      const prev = profilesByOpenid.get(profile.openid);
      // 变更联系方式时同步更新哈希索引，避免旧哈希残留造成误判重复
      if (prev && prev.contactHash && prev.contactHash !== profile.contactHash) {
        contacts.delete(prev.contactHash);
      }
      profilesByOpenid.set(profile.openid, profile);
      profilesById.set(profile.profileId, profile);
      if (profile.contactHash) contacts.set(profile.contactHash, profile.profileId);
      return profile;
    },
    listActiveProfiles() {
      return [...profilesById.values()].filter((p) => p.status === PROFILE_STATUS.ACTIVE);
    },
    allProfiles() {
      return [...profilesById.values()];
    },

    /* ---- 广告任务与查看券 ---- */
    saveTask(task) {
      tasks.set(task.token, task);
      return task;
    },
    getTask(token) {
      return tasks.get(token) || null;
    },
    saveTicket(ticket) {
      tickets.set(ticket.ticketId, ticket);
      return ticket;
    },
    getTicket(ticketId) {
      return tickets.get(ticketId) || null;
    },

    /* ---- 已获取记录 ---- */
    saveUnlock(openid, profileId, record) {
      unlocks.set(keyOfUnlock(openid, profileId), record);
      return record;
    },
    getUnlock(openid, profileId) {
      return unlocks.get(keyOfUnlock(openid, profileId)) || null;
    },
    listUnlocks(openid) {
      const out = [];
      for (const [key, record] of unlocks.entries()) {
        if (key.startsWith(`${openid}:`)) out.push({ ...record, profileId: key.slice(openid.length + 1) });
      }
      return out;
    },

    /* ---- 带量计数（服务端记账，说明书 §5.4） ---- */
    countersOf(openid, day) {
      const key = keyOfCounter(openid, day);
      if (!counters.has(key)) counters.set(key, emptyCounter());
      return counters.get(key);
    },
    /** 显式回写计数器：内存实现为就地复用同一对象，云库实现（store-cloud.js）需据此落库。 */
    saveCounters(openid, day, counter) {
      counters.set(keyOfCounter(openid, day), counter);
      return counter;
    },

    /* ---- 举报 ---- */
    saveReport(record) {
      reports.push(record);
      return record;
    },
    listReports() {
      return reports.slice();
    },
  };
}

module.exports = { createMemoryStore };
  };

  // ── server/lib/ticket.js
  __registry["server/lib/ticket.js"] = function (module, exports, require) {
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
const { LIMITS, PROFILE_STATUS } = __req('miniapp/shared/client-constants.js');
const { ERROR_CODES, domainError } = __req('server/lib/errors.js');

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
  };

  // ── miniapp/shared/client-constants.js
  __registry["miniapp/shared/client-constants.js"] = function (module, exports, require) {
'use strict';

/**
 * 客户端常量（冻结契约）
 *
 * 依据：《项目说明书-月老办事处》§2（业务流程）、§5（广告策略与频次限制）、
 * §6.4（联系方式三态渲染）、§7（埋点事件清单）、§4（页面清单）。
 *
 * 本文件是**客户端与服务端共同遵守的契约**：
 *   - 错误码 ERROR_CODES 与 server/lib/errors.js 必须逐条一致；
 *   - 限额 LIMITS 与 server/lib/risk.js 的默认值必须一致（服务端为准，客户端仅用于展示）；
 *   - 文案 COPY 逐字取自说明书，研发不得自行改写（线稿说明 §合规文案专区）。
 * 客户端源码中不得出现明文联系方式（tools/check-structure.js 已设门禁）。
 */

/** 统一错误码：服务端信封 { code, msg, data } 的 code 取值 */
const ERROR_CODES = {
  OK: 0,
  INVALID_PARAM: 1001,
  NOT_REGISTERED: 1002,
  ALREADY_REGISTERED: 1003,
  DUPLICATE_CONTACT: 1004,
  PROFILE_NOT_FOUND: 1005,
  PROFILE_OFFLINE: 1006,
  DAILY_MATCH_LIMIT: 1007,
  DAILY_UNLOCK_LIMIT: 1008,
  MATCH_COOLDOWN: 1009,
  AD_COOLDOWN: 1010,
  TASK_NOT_FOUND: 1011,
  TASK_NOT_FINISHED: 1012,
  TICKET_NOT_FOUND: 1013,
  TICKET_EXPIRED: 1014,
  POOL_EMPTY: 1015,
  RISK_BLOCKED: 1016,
  AUDIT_PENDING: 1017,
  SERVER_ERROR: 1018,
};

/** 本地存储键（统一经 core/storage.js 读写） */
const STORE = {
  PROFILE: 'mm_profile', // 我的档案摘要（不含明文联系方式）
  QUOTA: 'mm_quota', // 今日次数展示缓存
  TRACK: 'mm_track_queue', // 埋点队列
  UNLOCKS: 'mm_unlocks', // 解锁记录摘要
  DEVICE: 'mm_device_id', // 本地匿名设备标识
  SESSION: 'mm_session', // 会话与启动环境
};

/** 页面埋点编号（说明书 §4 页面清单，与 doc/线稿说明一致） */
const PAGES = {
  HOME: 'P-01',
  REGISTER: 'P-02',
  PROFILE: 'P-03',
  FETCH: 'P-04',
  UNLOCKS: 'P-05',
  REPORT: 'P-06',
  LEGAL: 'P-07',
};

/** 路由（V1.0 全部入主包，不设分包：说明书 §3.2） */
const ROUTES = {
  [PAGES.HOME]: '/pages/home/index',
  [PAGES.REGISTER]: '/pages/register/index',
  [PAGES.PROFILE]: '/pages/profile/index',
  [PAGES.FETCH]: '/pages/fetch/index',
  [PAGES.UNLOCKS]: '/pages/unlocks/index',
  [PAGES.REPORT]: '/pages/report/index',
  [PAGES.LEGAL]: '/pages/legal/index',
};

/** 埋点事件名（说明书 §7.2 事件清单，逐条对应） */
const EVENTS = {
  APP_LAUNCH: 'app_launch',
  HOME_ENTRY_CLICK: 'home_entry_click',
  PROFILE_FORM_START: 'profile_form_start',
  PROFILE_SUBMIT: 'profile_submit',
  PROFILE_AUDIT_RESULT: 'profile_audit_result',
  PROFILE_EDIT: 'profile_edit',
  MATCH_REQUEST: 'match_request',
  MATCH_RESULT: 'match_result',
  MATCH_CARD_VIEW: 'match_card_view',
  AD_REWARD_REQUEST: 'ad_reward_request',
  AD_REWARD_SHOW: 'ad_reward_show',
  AD_REWARD_CLOSE: 'ad_reward_close',
  AD_REWARD_ERROR: 'ad_reward_error',
  AD_REWARD_COMPLETE: 'ad_reward_complete',
  CONTACT_UNLOCK: 'contact_unlock',
  CONTACT_COPY: 'contact_copy',
  DAILY_LIMIT_HIT: 'daily_limit_hit',
  REPORT_SUBMIT: 'report_submit',
  PROFILE_STATUS_CHANGE: 'profile_status_change',
  PAGE_VIEW: 'page_view',
  SESSION_END: 'session_end',
};

/** 联系方式类型白名单（说明书 §6.4；微信号/QQ 不开放） */
const CONTACT_TYPES = {
  PHONE: 'phone',
  DOUYIN: 'douyin',
};

/**
 * 限额与时限（客户端仅用于展示；**发放与消耗一律以服务端为准**，说明书 §5.4）。
 * 数值需与 server/lib/risk.js 保持一致。
 */
const LIMITS = {
  DAILY_UNLOCK: 20, // 每日解锁上限
  DAILY_MATCH: 30, // 每日匹配上限
  MATCH_COOLDOWN_MS: 3000, // 两次「获取」最小间隔
  AD_COOLDOWN_MS: 30000, // 两次广告触发最小间隔
  TASK_TTL_MS: 300000, // 广告任务令牌有效期 5 分钟
  TICKET_TTL_MS: 900000, // 查看券有效期 15 分钟
  NEW_USER_DAILY_UNLOCK: 5, // 新用户 24h 内解锁上限
  NEW_USER_WINDOW_MS: 86400000,
  FREE_REVISIT_MS: 2592000000, // 已解锁 30 天内免费复看
  AD_FAILURE_EXEMPT: 3, // 广告连续失败 N 次触发当日豁免一次
  AGE_MIN: 18,
  AGE_MAX: 60,
  MATCH_AGE_STEPS: [5, 8, 12, 99], // 年龄邻近梯度 = relaxationLevel 0..3
};

/** 匹配结果放宽层级语义（埋点 match_result.relaxation_level） */
const RELAXATION_LABEL = ['±5 岁', '±8 岁', '±12 岁', '不限年龄'];

/** 档案状态（客户端展示与 audit-badge 组件共用） */
const PROFILE_STATUS = {
  DRAFT: 'draft',
  PENDING: 'pending',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  OFFLINE: 'offline',
};

/** 广告位：客户端不硬编码 adUnitId，一律由服务端 createAdTask 下发（说明书 §5.1） */
const AD = {
  POOL_SIZE: 2, // 广告位轮询数量
  MIN_PLAY_MS: 0, // 完整观看以 isEndReached 为准，不做时长臆测
};

/** 文案（逐字取自说明书与线稿说明的合规文案专区） */
const COPY = {
  HOME_TAGLINE: '留个联系方式，看看谁在等你',
  BTN_REGISTER: '登记我的资料',
  BTN_FETCH: '获取一个联系方式',
  NOT_REGISTERED_TIP: '先登记自己的资料，才能获取他人联系方式',
  BTN_UNLOCK: '看广告解锁',
  BTN_COPY: '复制联系方式',
  UNLOCK_NOTICE: '完整观看 1 条激励视频，即可解锁对方联系方式',
  AD_PLAYING_TIP: '看完就能解锁，请勿中途退出',
  AD_GRANTING: '正在确认奖励…',
  COPY_OK: '已复制，请合规使用',
  UNLOCK_COMPLIANCE: '解锁后仅可复制，请勿用于骚扰或营销',
  DAILY_LIMIT: '今日获取次数已用完，明天再来',
  MATCH_COOLDOWN: '操作太快了，稍后再试',
  POOL_EMPTY: '今日可获取的资料已取完，明天再来',
  MATCHING: '正在为你寻找…',
  EXPIRED: '该资料已下线',
  AD_FAILED: '广告加载失败，请稍后重试',
  HOME_DISCLAIMER: '本小程序仅提供信息展示，不对用户资料真实性作担保，请谨慎核实',
  REGISTER_HINT: '填写 3 项，10 秒完成；联系方式仅在你主动解锁后才可复制',
  REPORT_DONE: '举报已提交，我们会尽快核实',
  AUDIT_PENDING: '资料审核中',
  REJECTED_PREFIX: '已驳回：',
  CHANGE_CONTACT_NOTICE: '变更联系方式需重新审核',
};

module.exports = {
  ERROR_CODES,
  STORE,
  PAGES,
  ROUTES,
  EVENTS,
  CONTACT_TYPES,
  LIMITS,
  RELAXATION_LABEL,
  PROFILE_STATUS,
  AD,
  COPY,
};
  };

  // ── server/functions/getProfile/index.js
  __registry["server/functions/getProfile/index.js"] = function (module, exports, require) {
'use strict';

/**
 * 云函数入口：getProfile（薄壳）
 *
 * 只做「事件 → 参数 → handler」的转接，业务逻辑全在 server/lib/handlers.js。
 * 部署：源文件按同名函数放在 server/functions/getProfile/；上线前经 `node tools/gen-cloud-functions.js`
 * 打包为自包含单文件 build/cloud-functions/moonmatch-api/getProfile.js（云端为平铺 .js，调用路径 = `/getProfile`）。
 *
 * 身份：服务端直接从请求头 `X-TT-OPENID` 读取（免 login 置换，见 lib/identity.js）。
 * 存储：由 store-provider.js 按环境选择 —— 云数据库优先，不可用降级内存并**显式告警**（禁止用于生产）。
 */

const { createRuntimeStore } = __req('server/lib/store-provider.js');
const { readOpenid } = __req('server/lib/identity.js');
const { handleGetProfile } = __req('server/lib/handlers.js');

// 懒初始化：首次调用时选 store（本地/单测无官方 SDK 时自动降级并告警）
let store = null;

/** 入口签名对齐平台契约：params 即 HTTP 请求体，返回值作为 Response Body。 */
module.exports = async function main(params, context) {
  if (!store) store = createRuntimeStore(context);
  const ctx = {
    openid: readOpenid(context, params),
    store,
    now: Date.now,
    random: (max) => Math.floor(Math.random() * max),
  };
  return handleGetProfile(params || {}, ctx);
};
  };

  module.exports = __req("server/functions/getProfile/index.js");
})();
