'use strict';

/**
 * 服务端信封与错误码单测
 *
 * 依据：《项目说明书-月老办事处》§8（统一信封 `{ code, msg, data }`，code=0 成功）。
 * 覆盖：ok / fail 形态、msg 前缀取错误码名称、meta 挂到 data、DomainError 与非 DomainError
 *      的收敛差别（后者一律 SERVER_ERROR，不泄漏内部细节）、isOk、serialize 可被客户端 parse。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { ERROR_CODES } = require('../miniapp/shared/client-constants.js');
const { DomainError, domainError, ERROR_NAMES } = require('../server/lib/errors.js');
const { ok, fail, fromError, isOk, serialize } = require('../server/lib/envelope.js');

test('ERROR_NAMES：数值码反查名称，与客户端契约逐条同值', () => {
  assert.equal(ERROR_NAMES[ERROR_CODES.OK], 'OK');
  assert.equal(ERROR_NAMES[ERROR_CODES.TICKET_EXPIRED], 'TICKET_EXPIRED');
  assert.equal(ERROR_NAMES[ERROR_CODES.SERVER_ERROR], 'SERVER_ERROR');
  assert.equal(Object.keys(ERROR_NAMES).length, Object.keys(ERROR_CODES).length);
});

test('ok：code=0、msg=ok，data 缺省为空对象', () => {
  const envelope = ok({ a: 1 });
  assert.deepEqual(envelope, { code: 0, msg: 'ok', data: { a: 1 } });
  assert.deepEqual(ok().data, {});
});

test('fail：msg 前缀取错误码名称；meta 挂到 data 供客户端分支', () => {
  const plain = fail(ERROR_CODES.DAILY_UNLOCK_LIMIT);
  assert.equal(plain.code, ERROR_CODES.DAILY_UNLOCK_LIMIT);
  assert.equal(plain.msg, 'DAILY_UNLOCK_LIMIT');
  assert.equal(plain.data, null);

  const withDetail = fail(ERROR_CODES.TASK_NOT_FINISHED, 'played_ms=0');
  assert.equal(withDetail.msg, 'TASK_NOT_FINISHED: played_ms=0');

  const withMeta = fail(ERROR_CODES.AD_COOLDOWN, undefined, { retryAfterMs: 20000 });
  assert.deepEqual(withMeta.data, { retryAfterMs: 20000 });
});

test('fromError：DomainError 按其错误码收敛，普通异常归一为 SERVER_ERROR', () => {
  const domain = fromError(domainError(ERROR_CODES.NOT_REGISTERED));
  assert.equal(domain.code, ERROR_CODES.NOT_REGISTERED);
  assert.equal(domain.msg, 'NOT_REGISTERED');

  const withMeta = fromError(domainError(ERROR_CODES.AD_COOLDOWN, 'too_fast', { retryAfterMs: 1 }));
  assert.deepEqual(withMeta.data, { retryAfterMs: 1 });

  const crashed = fromError(new Error('db exploded'));
  assert.equal(crashed.code, ERROR_CODES.SERVER_ERROR);
  assert.equal(crashed.data, null, '内部细节不得进入 data');

  const nullish = fromError(undefined);
  assert.equal(nullish.code, ERROR_CODES.SERVER_ERROR);
});

test('DomainError：name/code/detail/meta 落地，message 取错误码名称', () => {
  const err = new DomainError(ERROR_CODES.DUPLICATE_CONTACT, 'same_contact');
  assert.equal(err.name, 'DomainError');
  assert.equal(err.code, ERROR_CODES.DUPLICATE_CONTACT);
  assert.equal(err.detail, 'same_contact');
  assert.equal(err.message, 'DUPLICATE_CONTACT: same_contact');
  assert.ok(err instanceof Error);
});

test('isOk：仅 code=0 判真', () => {
  assert.equal(isOk(ok()), true);
  assert.equal(isOk(fail(ERROR_CODES.SERVER_ERROR)), false);
  assert.equal(isOk(null), false);
});

test('serialize：输出可被 JSON.parse 还原（callContainer 的 data 为 JSON 字符串）', () => {
  const text = serialize(ok({ profileId: 'MM-1' }));
  assert.equal(typeof text, 'string');
  assert.deepEqual(JSON.parse(text), { code: 0, msg: 'ok', data: { profileId: 'MM-1' } });
});
