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

const { PROFILE_STATUS } = require('../../miniapp/shared/client-constants.js');

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
