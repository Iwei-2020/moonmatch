'use strict';

/**
 * 云适配器单测
 *
 * 依据：《项目说明书-月老办事处》§3.2（服务端载体抖音云、返回 data 为 JSON 字符串需自行解析；
 * 无 `callFunction` 类封装）、§8.2（低版本基础库无云能力需兜底）、冻结契约（统一信封与错误码）。
 * 覆盖：信封归一（callContainer 原始返回 / 直返信封 / 包 result）、data 为 JSON 字符串需 parse、
 *      非 0 code → ok:false、运行时环境选配（prod 兜底）、无能力时全部薄壳走降级且不抛错。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const client = require('../miniapp/shared/client-constants.js');
const { createCloud, resolveCloudEnv, unwrap } = require('../miniapp/core/cloud.js');

const OK = client.ERROR_CODES.OK;

/** 十个云函数薄壳名（与 server/functions/ 及 tools/check-structure.js 基线一致）。 */
const WRAPPERS = [
  'submitProfile',
  'getProfile',
  'offlineProfile',
  'getMatch',
  'createAdTask',
  'claimTicket',
  'revealContact',
  'listUnlocked',
  'reportProfile',
  'reportEvents',
];

test('unwrap：callContainer 原始返回的 data 为 JSON 字符串时需自行 parse', () => {
  const raw = {
    statusCode: 200,
    header: {},
    data: JSON.stringify({ code: OK, msg: 'ok', data: { profile_no: 'MM-1' } }),
  };
  assert.deepEqual(unwrap(raw), { code: OK, msg: 'ok', data: { profile_no: 'MM-1' } });

  // 网关已解析成对象时同样可用
  assert.deepEqual(unwrap({ statusCode: 200, data: { code: OK, msg: 'ok', data: 2 } }), { code: OK, msg: 'ok', data: 2 });
  // 非 JSON 字符串（如网关错误页）不可识别，交由上层收敛为 SERVER_ERROR
  assert.equal(unwrap({ statusCode: 502, data: '<html>bad gateway</html>' }), null);
});

test('unwrap：直返信封与包一层 result 都归一为 { code, msg, data }', () => {
  assert.deepEqual(unwrap({ code: 0, msg: 'ok', data: { x: 1 } }), { code: 0, msg: 'ok', data: { x: 1 } });
  assert.deepEqual(unwrap({ result: { code: 1015, msg: 'pool empty' } }), { code: 1015, msg: 'pool empty', data: null });
  assert.equal(unwrap(null), null);
  assert.equal(unwrap('nope'), null);
  assert.equal(unwrap({ msg: 'no code' }), null);
});

test('call：data 为 JSON 字符串端到端 parse 后 ok=true', async () => {
  const cloud = createCloud({
    invoker: () => Promise.resolve({ statusCode: 200, data: JSON.stringify({ code: OK, msg: 'ok', data: { unlocked: true } }) }),
  });
  assert.equal(cloud.available(), true);

  const res = await cloud.getMatch({});
  assert.equal(res.ok, true);
  assert.equal(res.code, OK);
  assert.deepEqual(res.data, { unlocked: true });
});

test('call：服务端返回非 0 code 时 ok=false，并保留 code 与 msg', async () => {
  const cloud = createCloud({
    invoker: () => Promise.resolve({ code: client.ERROR_CODES.POOL_EMPTY, msg: '池子已空', data: null }),
  });

  const res = await cloud.getMatch({});
  assert.equal(res.ok, false);
  assert.equal(res.code, client.ERROR_CODES.POOL_EMPTY);
  assert.equal(res.msg, '池子已空');
});

test('call：异常与非法返回一律收敛为 SERVER_ERROR，绝不 reject', async () => {
  const throwing = createCloud({ invoker: () => { throw new Error('boom'); } });
  const thrown = await throwing.submitProfile({});
  assert.equal(thrown.ok, false);
  assert.equal(thrown.code, client.ERROR_CODES.SERVER_ERROR);
  assert.equal(thrown.msg, 'boom');

  const rejecting = createCloud({ invoker: () => Promise.reject(new Error('net')) });
  const rejected = await rejecting.reportEvents({ events: [] });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, client.ERROR_CODES.SERVER_ERROR);

  const bogus = createCloud({ invoker: () => Promise.resolve('not-an-envelope') });
  const bogusRes = await bogus.listUnlocked({});
  assert.equal(bogusRes.ok, false);
  assert.equal(bogusRes.code, client.ERROR_CODES.SERVER_ERROR);
  assert.equal(bogusRes.msg, 'invalid_envelope');
});

test('resolveCloudEnv：线上走 prod、开发/预览走 dev，判据缺失或不认识一律 prod 兜底', () => {
  const targets = { dev: { envID: 'env-dev', serviceID: 's1' }, prod: { envID: 'env-prod', serviceID: 's1' } };
  const withEnv = (envType) => ({ getEnvInfoSync: () => ({ microapp: { envType } }) });

  assert.equal(resolveCloudEnv(withEnv('production'), targets).envID, 'env-prod');
  assert.equal(resolveCloudEnv(withEnv('development'), targets).envID, 'env-dev');
  assert.equal(resolveCloudEnv(withEnv('preview'), targets).envID, 'env-dev');
  assert.equal(resolveCloudEnv({}, targets).envID, 'env-prod', '无判据须 prod 兜底');
  assert.equal(resolveCloudEnv(null, targets).envID, 'env-prod');
  assert.equal(resolveCloudEnv(withEnv('unexpected'), targets).envID, 'env-prod');
  assert.equal(resolveCloudEnv(withEnv('production'), null), null);
});

test('无云能力时：available=false，十个薄壳全部降级为 cloud_unavailable 且不抛错', async () => {
  const cloud = createCloud({ invoker: null });
  assert.equal(cloud.available(), false);

  for (const name of WRAPPERS) {
    const res = await cloud[name]({});
    assert.equal(res.ok, false, `${name} 须 ok:false`);
    assert.equal(res.code, client.ERROR_CODES.SERVER_ERROR, `${name} 须 SERVER_ERROR`);
    assert.equal(res.msg, 'cloud_unavailable', `${name} 须 cloud_unavailable`);
    assert.equal(res.data, null);
  }
});

test('十个薄壳方法名与服务端薄壳基线一致（函数名即云托管路径）', async () => {
  const seen = [];
  const cloud = createCloud({
    invoker: (name) => {
      seen.push(name);
      return Promise.resolve({ code: OK, msg: 'ok', data: null });
    },
  });

  for (const name of WRAPPERS) {
    await cloud[name]({});
  }
  assert.deepEqual(seen, WRAPPERS);
});
