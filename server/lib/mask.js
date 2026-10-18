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
const { CONTACT_TYPES } = require('../../miniapp/shared/client-constants.js');

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
