'use strict';

/**
 * 激励视频封装单测
 *
 * 依据：《项目说明书-月老办事处》§5.1（接入形态）、§5.2（触发铁律）、§5.3（冷却与豁免）、
 * §2.2（B5：onClose 以 isEndReached 判定）。
 * 覆盖：宿主无 API 时 supported=false 且不抛错、仅完整观看（isEndReached=true）才发放、
 *      提前关闭不发放、触发冷却拦截、连续失败 3 次当日豁免、多广告位轮询。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { AD, LIMITS } = require('../miniapp/shared/client-constants.js');
const { createAd } = require('../miniapp/core/ad.js');

/** 伪造宿主：按平台形态提供 createRewardedVideoAd，记录每个广告位的创建与播放。 */
function fakeHost() {
  const created = [];
  const shown = [];
  const handlers = { close: null, error: null };
  const host = {
    createRewardedVideoAd(cfg) {
      created.push(cfg.adUnitId);
      return {
        load: () => Promise.resolve(),
        show: () => {
          shown.push(cfg.adUnitId);
          return Promise.resolve();
        },
        onClose: (fn) => {
          handlers.close = fn;
        },
        onError: (fn) => {
          handlers.error = fn;
        },
        offClose: () => {
          handlers.close = null;
        },
        offError: () => {
          handlers.error = null;
        },
      };
    },
  };
  return { host, created, shown, handlers };
}

test('宿主无 createRewardedVideoAd 时 supported=false，load/show 不抛错（降级）', async () => {
  const noApi = createAd({ host: {}, adUnitIds: ['u1'], now: () => 0 });
  assert.equal(noApi.supported, false, '宿主无 API 即无能力');

  const noHost = createAd({ adUnitIds: ['u1'], now: () => 0 });
  assert.equal(noHost.supported, false, '无宿主即无能力');

  const noPool = createAd({ host: fakeHost().host, adUnitIds: [], now: () => 0 });
  assert.equal(noPool.supported, false, '未配置广告位即无能力');

  const loaded = await noApi.load();
  assert.equal(loaded.ok, false);
  assert.equal(loaded.reason, 'unsupported');

  const shown = await noApi.show();
  assert.equal(shown.ok, false);
  assert.equal(shown.reason, 'unsupported');
  assert.equal(noApi.canTrigger(), false);
  assert.doesNotThrow(() => noApi.onError({ errMsg: 'no fill' }));
});

test('onClose：isEndReached=false（提前关闭）不发放', () => {
  const { host } = fakeHost();
  const ad = createAd({ host, adUnitIds: ['u1'], now: () => 0 });

  const closed = ad.onClose({ isEndReached: false });
  assert.equal(closed.granted, false);
  assert.equal(closed.isEndReached, false);
  assert.equal(ad.onClose({}).granted, false, '字段缺失同样视为未完整观看');
  assert.equal(ad.onClose(null).granted, false);
});

test('onClose：isEndReached=true（完整观看）才发放', () => {
  const { host } = fakeHost();
  const ad = createAd({ host, adUnitIds: ['u1'], now: () => 0 });

  const res = ad.onClose({ isEndReached: true });
  assert.equal(res.granted, true);
  assert.equal(res.ok, true);
  assert.equal(res.isEndReached, true);
});

test('show：播放入口冷却拦截（两次触发间隔 ≥ LIMITS.AD_COOLDOWN_MS）', async () => {
  const { host } = fakeHost();
  let clock = 1000;
  const ad = createAd({ host, adUnitIds: ['u1'], now: () => clock });

  const first = await ad.show();
  assert.equal(first.ok, true);
  assert.equal(first.adUnitId, 'u1');
  assert.equal(ad.canTrigger(), false, '刚触发应处于冷却');

  const second = await ad.show();
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'cooldown');
  assert.equal(second.remain_ms, LIMITS.AD_COOLDOWN_MS);

  clock += LIMITS.AD_COOLDOWN_MS;
  const third = await ad.show();
  assert.equal(third.ok, true, '冷却期满后可再次触发');
});

test('连续失败达 LIMITS.AD_FAILURE_EXEMPT(3) 次 → 当日豁免一次', () => {
  const { host } = fakeHost();
  let clock = 0;
  const ad = createAd({ host, adUnitIds: ['u1'], now: () => clock });
  assert.equal(ad.hasExempt(), false);

  ad.onError({ errMsg: 'no fill' });
  ad.onError({ errMsg: 'no fill' });
  assert.equal(ad.hasExempt(), false, '未达阈值不豁免');
  assert.equal(ad.failureCount(), 2);

  ad.onError({ errMsg: 'no fill' });
  assert.equal(ad.failureCount(), 3);
  assert.equal(ad.hasExempt(), true, '连续失败 3 次当日豁免一次（§5.3）');

  clock += 86400000;
  assert.equal(ad.hasExempt(), false, '豁免按自然日失效');
});

test('多广告位轮询：失败后自动换下一个广告位（AD.POOL_SIZE）', async () => {
  const { host, created } = fakeHost();
  const ad = createAd({ host, adUnitIds: ['u1', 'u2'], now: () => 0 });
  assert.equal(ad.pool.length, AD.POOL_SIZE);

  await ad.load();
  assert.deepEqual(created, ['u1']);
  assert.equal(ad.currentAdUnitId(), 'u1');

  ad.onError({ errMsg: 'no fill' });
  await ad.load();
  assert.deepEqual(created, ['u1', 'u2'], '失败后轮询到下一个广告位');
  assert.equal(ad.currentAdUnitId(), 'u2');
});
