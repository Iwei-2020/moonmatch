'use strict';

/**
 * 会话与「我的档案」摘要缓存
 *
 * 依据：《项目说明书-月老办事处》§2.1 A1–A8（进入小程序读状态、档案状态流转）、
 * §6.1（取签不再以先留缘签为前提）、§8.4（前端仅缓存掩码，**禁止明文落 localStorage**）。
 *
 * 存储键取自冻结契约 STORE，禁止散落定义：
 *   - `STORE.SESSION` 会话与启动环境（session_id）
 *   - `STORE.PROFILE` 我的档案摘要（**只存掩码**）
 *   - `STORE.DEVICE`  本地匿名设备标识（经 core/id.js 读写）
 *
 * 两条硬约束：
 *   1. **只缓存掩码**：写入档案摘要前一律经 core/mask.js 重新掩码，并对整条记录做
 *      `assertNoPlaintext` 自检，自检不通过则**拒绝落盘**（明文绝不落盘、绝不入日志）；
 *   2. **不抛错**：存储异常由 storage 层吞掉，本模块自身也静默降级 ——
 *      最坏结果是本次会话不可恢复，不影响用户操作。
 */

const { STORE, PROFILE_STATUS } = require('../shared/client-constants.js');
const { newId, getDeviceId } = require('./id.js');
const { maskContact, assertNoPlaintext } = require('./mask.js');

/** 档案状态枚举（冻结契约 PROFILE_STATUS），用于归一非法取值。 */
const STATUS_VALUES = Object.keys(PROFILE_STATUS).map((key) => PROFILE_STATUS[key]);

/**
 * @param {object} storage createStorage() 的返回值
 * @param {object} [options]
 * @param {() => number} [options.now]
 * @param {(prefix?:string) => string} [options.uuid]
 */
function createSession(storage, options) {
  const opts = options || {};
  const now = opts.now || Date.now;
  const uuid = opts.uuid || (() => newId('sess'));

  // ── 会话 ─────────────────────────────────────────────────────

  function readSessionId() {
    const record = storage.read(STORE.SESSION, null);
    if (record && typeof record === 'object' && typeof record.session_id === 'string' && record.session_id) {
      return record.session_id;
    }
    return null;
  }

  /** 取会话 id；不存在则开一条（一次启动一条会话记录）。 */
  function ensureSessionId() {
    const existing = readSessionId();
    if (existing) return existing;
    const id = uuid();
    storage.write(STORE.SESSION, { session_id: id, started_at: now() });
    return id;
  }

  /** 本地匿名设备标识（无注册体系；身份由服务端从 header 取 openid）。 */
  function getUserId() {
    return getDeviceId(storage);
  }

  // ── 档案摘要（只缓存掩码）────────────────────────────────────

  function readProfile() {
    const record = storage.read(STORE.PROFILE, null);
    if (!record || typeof record !== 'object') return null;
    return record;
  }

  /**
   * 写入档案摘要。**无论上游传入什么，缘签一律经 maskContact 重新掩码**，
   * 并对整条记录断言无明文，断言不通过则拒绝写入。
   * @param {object} input { profile_no?, gender?, age?, contact_type?, contact_masked|contact?, status?, reject_reason? }
   * @returns {boolean} 是否成功落盘
   */
  function setProfile(input) {
    if (!input || typeof input !== 'object') return false;

    const contactType = typeof input.contact_type === 'string' ? input.contact_type : '';
    const rawContact = input.contact_masked !== undefined ? input.contact_masked : input.contact;
    const status = STATUS_VALUES.indexOf(input.status) >= 0 ? input.status : PROFILE_STATUS.PENDING;

    const record = {
      profile_no: typeof input.profile_no === 'string' ? input.profile_no : '',
      gender: typeof input.gender === 'string' ? input.gender : '',
      age: Number(input.age) || 0,
      contact_type: contactType,
      contact_masked: maskContact(contactType, rawContact), // 只保留掩码形态
      status,
      reject_reason: typeof input.reject_reason === 'string' ? input.reject_reason : '',
      updated_at: now(),
    };

    // 合规自检：整条记录不得含明文缘签，否则拒绝落盘（§8.4）
    if (!assertNoPlaintext(JSON.stringify(record))) return false;
    return storage.write(STORE.PROFILE, record);
  }

  function getProfile() {
    return readProfile();
  }

  function clearProfile() {
    storage.remove(STORE.PROFILE);
  }

  /** 本地是否已有档案摘要（登记前置分流用，§2.1 A2）。 */
  function hasProfile() {
    return readProfile() !== null;
  }

  /**
   * 本地是否已有「结果」——骨架阶段即「是否已登记（已有档案摘要）」，
   * 供落地路由 / 首页状态分流使用。保留该命名以承接既有工程形态。
   */
  function hasResult() {
    return hasProfile();
  }

  // ── 状态视图 ─────────────────────────────────────────────────

  /** 统一状态视图：页面只读这个，不在页面里散读存储键。 */
  function status() {
    const profile = readProfile();
    return {
      session_id: ensureSessionId(),
      user_id: getUserId(),
      has_profile: profile !== null,
      profile_status: profile ? profile.status || '' : '',
      profile,
    };
  }

  return {
    status,
    getUserId,
    setProfile,
    getProfile,
    clearProfile,
    hasProfile,
    hasResult,
    getSessionId: ensureSessionId,
    keys: {
      session: STORE.SESSION,
      profile: STORE.PROFILE,
      device: STORE.DEVICE,
    },
  };
}

module.exports = { createSession };
