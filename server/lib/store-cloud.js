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

const { PROFILE_STATUS } = require('../../miniapp/shared/client-constants.js');

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
