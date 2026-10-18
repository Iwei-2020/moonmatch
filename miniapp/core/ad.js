'use strict';

/**
 * 激励视频广告封装
 *
 * 依据：《项目说明书-月老办事处》§5.1（接入形态：`tt.createRewardedVideoAd`、实例复用、
 * `onClose` 读 `res.isEndReached` 判定、`onError` 处理异常）、§5.2（触发时机铁律：仅用户
 * 主动点击才触发，出卡不触发）、§5.3（频次限制：广告触发冷却 ≥30s、连续失败 3 次当日豁免 1 次、
 * 广告位轮询）、§2.2（状态机 B4–B6）、§5.4（风控：客户端冷却计时、按钮防连点）。
 *
 * 四条硬约束：
 *   1. **仅 onClose 判定**：`res.isEndReached === true` 才是「完整观看」，仅关闭不发放；
 *      不做任何时长臆测（冻结契约 AD.MIN_PLAY_MS = 0，§5.1 / §5.4）。
 *   2. **多广告位轮询**：池子大小取 AD.POOL_SIZE（冻结契约 AD 只有位数，说明书 §5.3 要求多广告位轮询）；
 *      拉取 / 播放失败自动换下一个广告位。
 *   3. **冷却拦截**：两次触发间隔 ≥ LIMITS.AD_COOLDOWN_MS，本地拦截防连点。
 *   4. **降级不抛错**：宿主无 `tt.createRewardedVideoAd`（或未配置广告位）时 `supported=false`，
 *      load / show 一律返回失败结果，绝不上抛。
 *
 * 频率阈值来源说明：冻结契约 `AD` 只定义了 `POOL_SIZE` / `MIN_PLAY_MS`；冷却与豁免阈值在
 * `LIMITS`（`AD_COOLDOWN_MS` / `AD_FAILURE_EXEMPT`）中，故这里按唯一事实来源读 `LIMITS`。
 *
 * 职责边界：本模块只负责「拉取 / 播放 / 判定 / 拦截」，**不负责发放** —— 次数发放与消耗
 * 100% 由服务端记账（§5.4）：完整观看后仍须上报任务令牌、由服务端校验并下发查看券。
 */

const { AD, LIMITS } = require('../shared/client-constants.js');

/** 自然日键（豁免按当日有效，跨日失效；说明书 §5.3）。 */
function dayKeyOf(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * @param {object} [options]
 * @param {object|null} [options.host] 宿主对象（抖音小程序为全局 tt），需提供 createRewardedVideoAd
 * @param {string[]} [options.adUnitIds] 广告位池（由服务端 createAdTask 下发，客户端不硬编码，§5.1）
 * @param {() => number} [options.now] 时钟注入（冷却与自然日判定），单测可注入
 * @param {(name:string, payload:object) => void} [options.onEvent] 埋点回调（ad_reward_show / close / error 等）
 * @returns {object} 广告封装实例
 */
function createAd(options) {
  const opts = options || {};
  const host = opts.host || null;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : function () {};
  const pool = Array.isArray(opts.adUnitIds)
    ? opts.adUnitIds.filter((id) => typeof id === 'string' && id !== '').slice(0, AD.POOL_SIZE)
    : [];

  /** 无 SDK 能力 / 未配置广告位 → 全程降级，绝不抛错。 */
  const supported = !!(host && typeof host.createRewardedVideoAd === 'function') && pool.length > 0;

  let cursor = 0; // 广告位轮询下标
  let instance = null; // 复用的广告实例 { ad, adUnitId }
  let loading = null; // 进行中的 load
  let lastTriggerAt = null; // 上次触发时间（null = 从未触发，首次不受冷却约束）
  let failureCount = 0; // 连续失败计数
  let exemptDay = ''; // 已发放豁免的自然日（空 = 当日未发放）
  let playing = false; // 是否播放中

  function emit(name, payload) {
    try {
      onEvent(name, payload || {});
    } catch (err) {
      /* 埋点异常不得影响广告链路 */
    }
  }

  /** 释放当前实例并解绑回调（下次 load 时按轮询结果重建）。 */
  function release() {
    const held = instance;
    instance = null;
    if (!held) return;
    try {
      if (held.ad && typeof held.ad.offClose === 'function') held.ad.offClose();
    } catch (err) {
      /* 静默 */
    }
    try {
      if (held.ad && typeof held.ad.offError === 'function') held.ad.offError();
    } catch (err) {
      /* 静默 */
    }
  }

  /** 按当前轮询下标取广告位并创建 / 复用实例；失败返回 null（降级）。 */
  function ensureInstance() {
    if (!supported) return null;
    if (instance) return instance;

    const adUnitId = pool[cursor % pool.length];
    let ad = null;
    try {
      ad = host.createRewardedVideoAd({ adUnitId });
    } catch (err) {
      emit('create_error', { adUnitId, error: err });
      return null;
    }
    if (!ad || typeof ad.show !== 'function') return null;

    instance = { ad, adUnitId };
    try {
      if (typeof ad.onClose === 'function') ad.onClose((res) => handleClose(res));
    } catch (err) {
      /* 静默 */
    }
    try {
      if (typeof ad.onError === 'function') ad.onError((err) => handleError('play', err));
    } catch (err) {
      /* 静默 */
    }
    return instance;
  }

  /**
   * 把平台回调转发给对外 onClose：**只有 `res.isEndReached === true` 才判定完整观看**。
   * 提前关闭（false / 字段缺失）不发放、不扣次数（§2.2 B5、§5.1）。
   */
  function handleClose(res) {
    playing = false;
    const isEndReached = !!(res && res.isEndReached === true);
    if (!isEndReached) {
      emit('close', { isEndReached: false, granted: false });
      return { ok: false, isEndReached: false, granted: false };
    }
    failureCount = 0; // 一次完整观看即清零连续失败
    emit('complete', { isEndReached: true, granted: true, adUnitId: instance ? instance.adUnitId : '' });
    return { ok: true, isEndReached: true, granted: true };
  }

  /**
   * 记录一次失败：递增连续失败计数 → 达阈值置「当日豁免」标记 → 轮询下一个广告位并释放实例。
   * 说明书 §5.3：连续失败 AD_FAILURE_EXEMPT 次触发豁免 1 次；§2.2：拉取失败不扣次数、不发放。
   */
  function markFailure(stage, error, adUnitId) {
    failureCount += 1;
    emit('error', { stage, adUnitId: adUnitId || '', failure_count: failureCount, error: error || null });

    if (failureCount >= LIMITS.AD_FAILURE_EXEMPT) {
      const day = dayKeyOf(Number(now()) || 0);
      if (exemptDay !== day) {
        exemptDay = day;
        emit('exempt', { day, failure_count: failureCount });
      }
    }

    // 轮询下一个广告位（§5.3 多广告位轮询）
    if (pool.length > 0) cursor = (cursor + 1) % pool.length;
    release();
    return failureCount;
  }

  function handleError(stage, error) {
    return markFailure(stage, error, instance ? instance.adUnitId : '');
  }

  /** 拉取素材。失败自动换广告位、不扣次数（§2.2 AD_FAILED）。 */
  function load() {
    if (!supported) return Promise.resolve({ ok: false, reason: 'unsupported' });
    if (loading) return loading;

    const entry = ensureInstance();
    if (!entry) return Promise.resolve({ ok: false, reason: 'create_failed' });

    loading = Promise.resolve()
      .then(() => (typeof entry.ad.load === 'function' ? entry.ad.load() : undefined))
      .then(
        () => {
          loading = null;
          emit('load', { adUnitId: entry.adUnitId });
          return { ok: true, adUnitId: entry.adUnitId };
        },
        (err) => {
          loading = null;
          markFailure('load', err, entry.adUnitId);
          return { ok: false, reason: 'load_failed', error: err };
        }
      );
    return loading;
  }

  /**
   * 触发播放。**先过冷却**（两次触发间隔 ≥ LIMITS.AD_COOLDOWN_MS，§5.3 / §5.4）。
   * 平台 show 失败一律降级，不抛错。
   */
  function show() {
    if (!supported) return Promise.resolve({ ok: false, reason: 'unsupported' });

    const at = Number(now()) || 0;
    if (lastTriggerAt !== null && at - lastTriggerAt < LIMITS.AD_COOLDOWN_MS) {
      const remain = LIMITS.AD_COOLDOWN_MS - (at - lastTriggerAt);
      emit('cooldown', { remain_ms: remain });
      return Promise.resolve({ ok: false, reason: 'cooldown', remain_ms: remain });
    }
    lastTriggerAt = at; // 触发即计时（无论后续成败）

    const entry = ensureInstance();
    if (!entry) return Promise.resolve({ ok: false, reason: 'create_failed' });

    playing = true;
    emit('show', { adUnitId: entry.adUnitId });

    let pending;
    try {
      pending = entry.ad.show();
    } catch (err) {
      playing = false;
      markFailure('show', err, entry.adUnitId);
      return Promise.resolve({ ok: false, reason: 'show_failed', error: err });
    }
    return Promise.resolve(pending).then(
      () => ({ ok: true, adUnitId: entry.adUnitId }),
      (err) => {
        playing = false;
        markFailure('show', err, entry.adUnitId);
        return { ok: false, reason: 'show_failed', error: err };
      }
    );
  }

  /** 是否可触发（冷却校验，供 UI 置灰按钮；不产生副作用）。 */
  function canTrigger() {
    if (!supported) return false;
    if (lastTriggerAt === null) return true;
    return (Number(now()) || 0) - lastTriggerAt >= LIMITS.AD_COOLDOWN_MS;
  }

  /** 距下次可触发的剩余毫秒（0 = 已可触发）。 */
  function cooldownRemaining() {
    if (lastTriggerAt === null) return 0;
    const remain = LIMITS.AD_COOLDOWN_MS - ((Number(now()) || 0) - lastTriggerAt);
    return remain > 0 ? remain : 0;
  }

  return {
    supported,
    pool: pool.slice(),
    load,
    show,
    canTrigger,
    cooldownRemaining,
    /** 平台 onClose 回调入口：仅 isEndReached===true 才 granted。 */
    onClose: handleClose,
    /** 错误入口（平台 onError / 手动上报）：降级 + 计数 + 满阈值置豁免。 */
    onError: (error) => ({ count: handleError('play', error) }),
    /** 当日豁免是否有效（连续失败达阈值且在当日；跨自然日失效，§5.3）。 */
    hasExempt: () => exemptDay !== '' && exemptDay === dayKeyOf(Number(now()) || 0),
    failureCount: () => failureCount,
    isPlaying: () => playing,
    currentAdUnitId: () => (instance ? instance.adUnitId : null),
    destroy: release,
  };
}

module.exports = { createAd };
