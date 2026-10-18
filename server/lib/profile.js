'use strict';

/**
 * 档案登记与机审（《项目说明书》§2.1 流程 A、§6.2 虚假信息治理）
 *
 * 强约束：`1 openid = 1 档案 = 1 联系方式`。
 * 极简字段集：性别、年龄（入库存出生年份，展示时按年自动换算）、联系方式。
 */

const crypto = require('node:crypto');
const { CONTACT_TYPES, LIMITS, PROFILE_STATUS } = require('../../miniapp/shared/client-constants.js');
const { ERROR_CODES, domainError } = require('./errors.js');
const { maskContact, validateContact, hashContact, normalizeContact } = require('./mask.js');

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
