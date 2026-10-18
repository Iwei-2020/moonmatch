'use strict';

/**
 * 档案登记与机审单测
 *
 * 依据：《项目说明书-月老办事处》§2.1（流程 A：留联系方式 + 1 openid = 1 档案 + 联系方式唯一）、
 * §6.2（虚假信息治理与事前机审）、§6.4（对外只出掩码）。
 * 覆盖：字段级校验、机审转人工、重复联系方式拦截、联系方式变更重审、上下架、举报、对外视图脱敏。
 *
 * 说明：手机号一律由字符数组运行时拼装，源码内不落 11 位连续明文数字。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryStore } = require('../server/lib/store.js');
const { ERROR_CODES } = require('../miniapp/shared/client-constants.js');
const { PROFILE_STATUS } = require('../miniapp/shared/client-constants.js');
const profileLib = require('../server/lib/profile.js');

const NOW = Date.UTC(2026, 0, 1); // 自然年 2026，年龄换算基准
const PHONE_A = ['1', '3', '8', '1', '2', '3', '4', '8', '8', '8', '8'].join('');
const PHONE_B = ['1', '3', '9', '9', '8', '7', '6', '5', '4', '3', '2'].join('');
const PHONE_REPEAT = ['1', '3', '8', '0', '0', '0', '0', '0', '0', '0', '0'].join('');

/** 断言抛出（同步或异步）指定错误码的领域异常 */
async function throwsCode(fn, code) {
  await assert.rejects(async () => fn(), (err) => err && err.code === code);
}

/** 捕获 fn 抛出的异常（同步或异步均可；用于读取 meta）；未抛出即视为失败 */
async function thrown(fn) {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected_to_throw');
}

function submit(store, openid, overrides) {
  const input = Object.assign(
    { agreement: true, gender: 'male', contactType: 'phone', contact: PHONE_A },
    overrides || {},
  );
  return profileLib.submitProfile(store, { openid, input, now: NOW });
}

test('submitProfile：合法登记落地为 active，返回掩码且不含明文', async () => {
  const store = createMemoryStore({});
  const result = await submit(store, 'u1');

  assert.equal(result.status, PROFILE_STATUS.ACTIVE);
  assert.equal(result.maskedContact, '138****8888');
  assert.equal(result.reaudited, false);
  assert.match(result.profileId, /^MM-[0-9A-F]{6}$/);

  const raw = store.getProfileByOpenid('u1');
  assert.equal(raw.normalizedContact, PHONE_A, '服务端保留明文，供 unlock 一次性下发');
  assert.ok(!JSON.stringify(profileLib.toPublicProfile(raw)).includes(PHONE_A), '对外视图不得含明文');
});

test('submitProfile：协议 / 性别 / 缘签类型的前置校验', async () => {
  const store = createMemoryStore({});
  await throwsCode(() => submit(store, 'u1', { agreement: false }), ERROR_CODES.INVALID_PARAM);
  await throwsCode(() => submit(store, 'u1', { gender: 'other' }), ERROR_CODES.INVALID_PARAM);
  await throwsCode(() => submit(store, 'u1', { contactType: 'wechat' }), ERROR_CODES.INVALID_PARAM); // 微信号不开放
});

test('audit：重复数字命中规则转人工复核（pending）', async () => {
  const store = createMemoryStore({});
  const repeated = await submit(store, 'u2', { contact: PHONE_REPEAT });
  assert.equal(repeated.status, PROFILE_STATUS.PENDING);
  assert.equal(repeated.reason, 'repeated_digits');
});

test('submitProfile：同一 openid 同联系方式 → ALREADY_REGISTERED，meta 带掩码档案', async () => {
  const store = createMemoryStore({});
  await submit(store, 'u1');

  const err = await thrown(() => submit(store, 'u1'));
  assert.equal(err.code, ERROR_CODES.ALREADY_REGISTERED);
  assert.equal(err.meta.profile.maskedContact, '138****8888');
  assert.ok(!JSON.stringify(err.meta).includes(PHONE_A), 'meta 不得泄漏明文');
});

test('submitProfile：他人已占用同一联系方式 → DUPLICATE_CONTACT', async () => {
  const store = createMemoryStore({});
  await submit(store, 'u1', { contact: PHONE_A });
  await throwsCode(() => submit(store, 'u2', { contact: PHONE_A }), ERROR_CODES.DUPLICATE_CONTACT);
});

test('submitProfile：变更联系方式 → profileId 不变且标记重审；旧哈希索引被清理', async () => {
  const store = createMemoryStore({});
  const first = await submit(store, 'u1', { contact: PHONE_A });
  const changed = await submit(store, 'u1', { contact: PHONE_B });

  assert.equal(changed.profileId, first.profileId, '同一用户档案号稳定');
  assert.equal(changed.reaudited, true);
  assert.equal(changed.maskedContact, '139****5432');
  assert.equal(store.findByContactHash(require('../server/lib/mask.js').hashContact('phone', PHONE_A)), null, '旧哈希不应残留');
});

test('getMyProfile：未登记返回 null；已登记只出掩码', async () => {
  const store = createMemoryStore({});
  assert.equal(await profileLib.getMyProfile(store, { openid: 'ghost', now: NOW }), null);

  await submit(store, 'u1');
  const view = await profileLib.getMyProfile(store, { openid: 'u1', now: NOW });
  assert.equal(view.maskedContact, '138****8888');
  assert.equal(view.gender, 'male');
  assert.equal(view.status, PROFILE_STATUS.ACTIVE);
});

test('setOffline：下架 / 重新上架（重审），非法动作与未登记均拒绝', async () => {
  const store = createMemoryStore({});
  await submit(store, 'u1');

  assert.equal((await profileLib.setOffline(store, { openid: 'u1', action: 'offline', now: NOW })).status, PROFILE_STATUS.OFFLINE);
  assert.equal((await profileLib.setOffline(store, { openid: 'u1', action: 'online', now: NOW })).status, PROFILE_STATUS.ACTIVE);
  await throwsCode(() => profileLib.setOffline(store, { openid: 'u1', action: 'hide', now: NOW }), ERROR_CODES.INVALID_PARAM);
  await throwsCode(() => profileLib.setOffline(store, { openid: 'ghost', action: 'offline', now: NOW }), ERROR_CODES.PROFILE_NOT_FOUND);
});

test('report：原因白名单、目标存在性校验，合法举报落库', async () => {
  const store = createMemoryStore({});
  const target = await submit(store, 'u1');

  await throwsCode(() => profileLib.report(store, { openid: 'u2', input: { profileId: target.profileId, reasonType: 'spam' }, now: NOW }), ERROR_CODES.INVALID_PARAM);
  await throwsCode(() => profileLib.report(store, { openid: 'u2', input: { profileId: 'MM-XXXXXX', reasonType: 'fake' }, now: NOW }), ERROR_CODES.PROFILE_NOT_FOUND);

  const result = await profileLib.report(store, { openid: 'u2', input: { profileId: target.profileId, reasonType: 'harass' }, now: NOW });
  assert.deepEqual(result, { ok: true });
  assert.equal(store.listReports().length, 1);
});
