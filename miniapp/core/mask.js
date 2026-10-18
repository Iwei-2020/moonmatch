'use strict';

/**
 * 掩码层 —— 合规硬边界（纯函数、无副作用、可单测）
 *
 * 依据：《项目说明书-月老办事处》§6.4（联系方式三态渲染：保首尾、中间全掩码；明文不进入
 * 视图层文本节点）、§8.4（前端仅缓存掩码；禁止明文入日志、禁止明文落 localStorage）、
 * 《美术资产-全流程视觉P01-P07线稿说明》§9.3（contact-field 三态）。
 *
 * 三条不可回退的规则：
 *   1. 任何联系方式、任何状态，客户端一律以掩码形态承载（锁定 / 已解锁 / 失效共用同一掩码）；
 *   2. 本模块**只做字符串变换**：不读写存储、不触网、不访问宿主 API、不改动入参；
 *   3. 长度不足 / 类型未知 / 非法输入一律退化为全掩码（`****` 或 `d****`），**绝不回吐原值**。
 *
 * 掩码形态（与 tools/check-structure.js 的合规写法一致）：
 *   手机号   1XX****XXXX  → 例：138****8888（保前 3、后 4，中间全掩码）
 *   抖音号   dy_ab****yz   （保前 2、后 2）
 */

const { CONTACT_TYPES } = require('../shared/client-constants.js');

/** 通用全掩码：长度不足 / 类型未知时的兜底，不含任何有效信息。 */
const FULL_MASK = '****';

/** 明文手机号守卫：11 位、以 1[3-9] 开头（与结构门禁的判定口径一致）。 */
const PLAIN_PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/;

/**
 * 手机号掩码：保前 3 后 4。
 * @param {*} raw 任意输入（明文 / 已掩码 / 非字符串）
 * @returns {string} 掩码串；长度不足 / 非法输入退化为 `XXXX` / 前 3 + `****`
 */
function maskPhone(raw) {
  const digits = String(raw === undefined || raw === null ? '' : raw).replace(/\D/g, '');
  if (digits.length >= 7) return `${digits.slice(0, 3)}${FULL_MASK}${digits.slice(-4)}`;
  if (digits.length >= 4) return `${digits.slice(0, 3)}${FULL_MASK}`;
  return FULL_MASK;
}

/**
 * 抖音号掩码：保前 2 后 2，形如 `dy_ab****yz`。
 * 自带 `dy_` 前缀会被剥离后重新拼接；长度不足（<4）退化为 `d****`。
 * @param {*} raw 抖音号（可含 dy_ 前缀）
 * @returns {string}
 */
function maskDouyin(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  const id = text.replace(/^dy_/i, '').replace(/\s/g, '');
  if (id.length >= 4) return `dy_${id.slice(0, 2)}${FULL_MASK}${id.slice(-2)}`;
  return `d${FULL_MASK}`;
}

/**
 * 按联系方式类型分发掩码。类型不在白名单内（说明书 §6.4：V1.0 仅手机号 + 抖音号）一律全掩码。
 * @param {string} type CONTACT_TYPES.PHONE / CONTACT_TYPES.DOUYIN
 * @param {*} raw 原始值
 * @returns {string}
 */
function maskContact(type, raw) {
  if (type === CONTACT_TYPES.DOUYIN) return maskDouyin(raw);
  if (type === CONTACT_TYPES.PHONE) return maskPhone(raw);
  return FULL_MASK;
}

/**
 * 判断文本是否为（可安全进入视图层的）掩码形态：含星号掩码且不含明文手机号。
 * @param {*} text
 * @returns {boolean}
 */
function isMasked(text) {
  const value = String(text === undefined || text === null ? '' : text);
  if (value.indexOf(FULL_MASK) === -1) return false;
  return !PLAIN_PHONE.test(value);
}

/**
 * 合规断言：文本中**不含**明文联系方式 → true。
 * 供写入前（session 档案摘要缓存）、下发前（视图层文本节点）做最后一道自检。
 * 注意：语义为「无明文即通过」，空值与掩码均返回 true，明文手机号返回 false。
 * @param {*} text
 * @returns {boolean}
 */
function assertNoPlaintext(text) {
  const value = String(text === undefined || text === null ? '' : text);
  return !PLAIN_PHONE.test(value);
}

module.exports = {
  FULL_MASK,
  maskPhone,
  maskDouyin,
  maskContact,
  isMasked,
  assertNoPlaintext,
};
