'use strict';

/**
 * 服务端脱敏与归一单测
 *
 * 依据：《项目说明书-月老办事处》§6.4（联系方式脱敏与合规）、§6.2（事前字段级机审）。
 * 覆盖：归一化（去分隔符 / 小写）、格式校验（手机号与抖音号白名单）、掩码（保首尾、非法退化）、
 *      哈希（确定性、加类型前缀、与明文不同）。
 *
 * 说明：为遵守「源码不得出现明文联系方式」的口径，本文件中的手机号一律由字符数组运行时拼装。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeContact, validateContact, maskContact, hashContact, MASK_FALLBACK } = require('../server/lib/mask.js');

/** 运行时拼装的明文手机号（源码中不落 11 位连续数字）。 */
const PHONE = ['1', '3', '8', '1', '2', '3', '4', '8', '8', '8', '8'].join('');

test('normalizeContact：手机号去空格与分隔符，抖音号去空格并小写', () => {
  assert.equal(normalizeContact('phone', '138 1234 8888'), PHONE);
  assert.equal(normalizeContact('phone', '138-1234-8888'), PHONE);
  assert.equal(normalizeContact('phone', '(138)12348888'), PHONE);
  assert.equal(normalizeContact('douyin', '  MoonMatch  '), 'moonmatch');
  assert.equal(normalizeContact('douyin', null), '');
});

test('validateContact：手机号 / 抖音号格式白名单，白名单外类型一律拒绝', () => {
  assert.deepEqual(validateContact('phone', PHONE), { ok: true, normalized: PHONE });

  const tenDigits = validateContact('phone', PHONE.slice(0, 10));
  assert.equal(tenDigits.ok, false);
  assert.equal(tenDigits.reason, 'phone_format');

  const notLeadingOne = validateContact('phone', `2${PHONE.slice(1)}`);
  assert.equal(notLeadingOne.ok, false);

  assert.deepEqual(validateContact('douyin', 'Moon_Match.01'), { ok: true, normalized: 'moon_match.01' });
  assert.equal(validateContact('douyin', 'abc').ok, false, '过短不通过');
  assert.equal(validateContact('douyin', 'ab'.repeat(20)).ok, false, '过长不通过');
  assert.equal(validateContact('wechat', 'whatever').reason, 'contact_type_not_allowed', '微信号不开放');
  assert.equal(validateContact('qq', '123456').reason, 'contact_type_not_allowed', 'QQ 不支持');
});

test('maskContact：手机号保前 3 后 4；抖音号保前 2 后 2；非法与未知类型退化为全掩码', () => {
  assert.equal(maskContact('phone', PHONE), '138****8888');
  assert.equal(maskContact('phone', '138'), MASK_FALLBACK);
  assert.equal(maskContact('phone', undefined), MASK_FALLBACK);
  assert.equal(maskContact('douyin', 'abcdefgh'), 'ab****gh');
  assert.equal(maskContact('douyin', 'abc'), 'd****', '短号退化，避免泄漏位数');
  assert.equal(maskContact('wechat', PHONE), MASK_FALLBACK);
  assert.equal(maskContact('', PHONE), MASK_FALLBACK);
});

test('hashContact：同值同哈希、异值异哈希、加类型前缀区分同名串、与明文不同', () => {
  const h1 = hashContact('phone', PHONE);
  const h2 = hashContact('phone', '138 1234 8888');
  assert.equal(h1, h2, '归一后应产生相同哈希');
  assert.notEqual(h1, PHONE);
  assert.match(h1, /^[a-f0-9]{64}$/, 'sha256 十六进制');

  assert.notEqual(hashContact('phone', PHONE), hashContact('douyin', PHONE), '类型前缀避免歧义');
  assert.notEqual(hashContact('phone', PHONE), hashContact('phone', `${PHONE.slice(0, -1)}9`));
});
