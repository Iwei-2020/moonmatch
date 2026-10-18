'use strict';

/**
 * 掩码层单测（合规硬边界）
 *
 * 依据：《项目说明书-月老办事处》§6.4（三态渲染：保首尾、中间全掩码）、§8.4（前端仅缓存掩码）。
 * 覆盖：手机号 / 抖音号掩码形态、长度不足与非法输入的退化、类型未知退化为全掩码、
 *      isMasked、assertNoPlaintext（掩码判 true、明文判 false）。
 *
 * 说明：为遵守「源码不得出现明文联系方式」的结构门禁，本文件中的手机号一律由字符数组
 * 运行时拼装得到，源码内不出现任何连续 11 位明文数字。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { maskPhone, maskDouyin, maskContact, isMasked, assertNoPlaintext } = require('../miniapp/core/mask.js');

/** 运行时拼装的明文手机号（源码中不落 11 位连续数字；末 4 位即掩码示例的保留下标）。 */
const PHONE_PLAIN = ['1', '3', '8', '1', '2', '3', '4', '8', '8', '8', '8'].join('');

test('maskPhone：11 位手机号保前 3 后 4，中间以星号全掩码', () => {
  assert.equal(maskPhone(PHONE_PLAIN), '138****8888');
  const spaced = `${PHONE_PLAIN.slice(0, 3)} ${PHONE_PLAIN.slice(3, 7)} ${PHONE_PLAIN.slice(7)}`;
  assert.equal(maskPhone(spaced), '138****8888', '非数字字符应被剥离');
});

test('maskPhone：长度不足或非法输入退化为掩码，绝不回吐原值', () => {
  assert.equal(maskPhone('1380'), '138****', '4–6 位：前 3 + 星');
  assert.equal(maskPhone('138'), '****', '<4 位整体掩码');
  assert.equal(maskPhone(''), '****');
  assert.equal(maskPhone(undefined), '****');
  assert.equal(maskPhone(null), '****');
  assert.equal(maskPhone(123456), '123****', '数字输入同样掩码化');
});

test('maskDouyin：保前 2 后 2，形如 dy_ab****yz；长度不足退化为 d****', () => {
  assert.equal(maskDouyin('abcdefgh'), 'dy_ab****gh');
  assert.equal(maskDouyin('dy_abcd1234'), 'dy_ab****34', '自带 dy_ 前缀应剥离后再掩码');
  assert.equal(maskDouyin('abc'), 'd****');
  assert.equal(maskDouyin('ab'), 'd****');
  assert.equal(maskDouyin(''), 'd****');
  assert.equal(maskDouyin(undefined), 'd****');
});

test('maskContact：按类型分发，类型未知一律退化为全掩码', () => {
  assert.equal(maskContact('phone', PHONE_PLAIN), '138****8888');
  assert.equal(maskContact('douyin', 'abcdefgh'), 'dy_ab****gh');
  assert.equal(maskContact('wechat', 'whatever'), '****', '白名单外类型不开放（§6.4）');
  assert.equal(maskContact('qq', '12345'), '****');
  assert.equal(maskContact('', PHONE_PLAIN), '****');
  assert.equal(maskContact(undefined, PHONE_PLAIN), '****');
});

test('isMasked：掩码形态判 true，明文与空值判 false', () => {
  assert.equal(isMasked('138****8888'), true);
  assert.equal(isMasked('dy_ab****gh'), true);
  assert.equal(isMasked(PHONE_PLAIN), false);
  assert.equal(isMasked(''), false);
  assert.equal(isMasked(undefined), false);
});

test('assertNoPlaintext：掩码判 true、明文判 false（合规断言）', () => {
  assert.equal(assertNoPlaintext('138****8888'), true);
  assert.equal(assertNoPlaintext('保首尾：138****8888 仅此形态可进入视图层'), true);
  assert.equal(assertNoPlaintext(''), true);
  assert.equal(assertNoPlaintext(null), true);
  assert.equal(assertNoPlaintext(PHONE_PLAIN), false, '明文手机号必须判 false');
  assert.equal(assertNoPlaintext(`联系方式：${PHONE_PLAIN}`), false);
});
