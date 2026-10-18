'use strict';

/**
 * 埋点 SDK
 *
 * 依据：《项目说明书-月老办事处》§7.1（命名 `{域}_{对象}_{动作}`、公共字段、本地队列 + 批量上报 +
 * 页面隐藏与崩溃前 flush、失败重试）、§7.2（事件清单，取自冻结契约 EVENTS）、
 * §8.5（关键链路失败需可回溯：日志 + 埋点双通道）。
 *
 * 设计要点：
 *   - 事件名与事件清单逐条对应 EVENTS（冻结契约），未登记事件名一律丢弃并计数；
 *   - 公共字段（§7.1）：`openid`（哈希值）、`session_id`、`page_id`、`ts`、`sdk_version`、
 *     `network_type`，由 SDK 自动补齐；`event_id` 客户端生成，供服务端去重；
 *   - 队列满 `BATCH_SIZE` 条或间隔 `FLUSH_INTERVAL_MS` 触发批量上报；队列上限 `QUEUE_LIMIT`，超出丢最旧；
 *   - **上报失败静默**：不抛错、不阻塞主流程；失败批次保留在队列头部等待下次重试；
 *   - **no_transport 短路**：未接上报通道（骨架阶段云能力不可用）时 flush 直接跳过，事件留在队列内。
 *
 * 说明：批量策略（BATCH_SIZE / QUEUE_LIMIT / FLUSH_INTERVAL_MS）与 SDK 版本号不属于业务常量，
 * 冻结契约 shared/client-constants.js 未收录，故在本模块内就地定义，不新增常量入口。
 * 埋点队列为内存态；跨重启补传需持久化，留待后续阶段。
 */

const { EVENTS } = require('../shared/client-constants.js');
const { newId } = require('./id.js');

/** SDK 版本（埋点公共字段 `sdk_version`）。 */
const SDK_VERSION = '0.1.0';

/** 批量上报策略（§7.1：本地队列 + 批量上报）。 */
const BATCH_SIZE = 10;
const QUEUE_LIMIT = 200;
const FLUSH_INTERVAL_MS = 5000;

/** 已登记事件名集合（对应 §7.2 事件清单）。 */
const EVENT_NAMES = Object.keys(EVENTS).map((key) => EVENTS[key]);

/**
 * @param {object} [options]
 * @param {(events:object[]) => any} [options.transport] 上报通道；省略则 flush 直接跳过（队列保留）
 * @param {() => number} [options.now]
 * @param {(prefix?:string) => string} [options.uuid]
 * @param {() => string} [options.getSessionId]
 * @param {() => string} [options.getOpenid] 已哈希的 openid（原始 openid 客户端不持有，§7.1）
 * @param {() => string} [options.getUserId]
 * @param {() => string} [options.getNetwork]
 * @param {{setInterval:Function, clearInterval:Function}} [options.timer]
 * @param {boolean} [options.autoFlush] 是否启用定时触发（默认启用）
 * @param {string} [options.sdkVersion]
 */
function createTracker(options) {
  const opts = options || {};
  const transport = opts.transport || null;
  const now = opts.now || Date.now;
  const uuid = opts.uuid || (() => newId('evt'));
  const getSessionId = opts.getSessionId || (() => '');
  const getOpenid = opts.getOpenid || (() => '');
  const getUserId = opts.getUserId || (() => '');
  const getNetwork = opts.getNetwork || (() => 'unknown');
  const timer = opts.timer || { setInterval, clearInterval };
  const autoFlush = opts.autoFlush !== false;
  const sdkVersion = opts.sdkVersion || SDK_VERSION;

  const queue = [];
  let currentPageId = '';
  let dropped = 0;
  let rejected = 0;
  let sent = 0;
  let flushing = null;
  let intervalId = null;

  /** 取公共字段。任何 provider 抛错都降级为空值，绝不冒泡。 */
  function commonFields() {
    const safe = (fn, fallback) => {
      try {
        const value = fn();
        return value === undefined || value === null || value === '' ? fallback : value;
      } catch (err) {
        return fallback;
      }
    };
    return {
      event_id: uuid(),
      openid: safe(getOpenid, ''),
      session_id: safe(getSessionId, ''),
      user_id: safe(getUserId, ''),
      page_id: currentPageId,
      ts: safe(now, 0),
      sdk_version: sdkVersion,
      network_type: safe(getNetwork, 'unknown'),
    };
  }

  function trim() {
    while (queue.length > QUEUE_LIMIT) {
      queue.shift();
      dropped++;
    }
  }

  /** 设置当前页面（P-01…P-07），作为后续事件的公共字段 page_id。 */
  function setPage(pageId) {
    currentPageId = typeof pageId === 'string' ? pageId : '';
    return currentPageId;
  }

  /**
   * 记录一条事件。
   * @returns {boolean} true 表示已入队；false 表示被丢弃（事件名未登记 / 内部异常）
   */
  function track(name, payload) {
    try {
      if (!EVENT_NAMES.includes(name)) {
        rejected++;
        return false;
      }
      const data = payload || {};
      const record = Object.assign({ event_name: name }, commonFields(), data);
      queue.push(record);
      trim();
      if (queue.length >= BATCH_SIZE) flush();
      return true;
    } catch (err) {
      // 埋点自身异常不得影响 UI
      rejected++;
      return false;
    }
  }

  /**
   * 批量上报。**永不抛错、永不 reject**。
   * @returns {Promise<{flushed:number, failed?:boolean, skipped?:string}>}
   */
  function flush() {
    if (!transport) return Promise.resolve({ flushed: 0, skipped: 'no_transport' });
    if (flushing) return flushing;
    if (queue.length === 0) return Promise.resolve({ flushed: 0 });

    const batch = queue.splice(0, BATCH_SIZE);
    let attempt;
    try {
      attempt = transport(batch);
    } catch (err) {
      // 同步抛错视为上报失败：批次原样退回队列头部，下次补传
      queue.unshift(...batch);
      trim();
      return Promise.resolve({ flushed: 0, failed: true });
    }

    flushing = Promise.resolve(attempt)
      .then((result) => {
        const failed = result === false || (result && typeof result === 'object' && Number(result.code) !== 0);
        if (failed) {
          queue.unshift(...batch);
          trim();
          return { flushed: 0, failed: true };
        }
        sent += batch.length;
        return { flushed: batch.length };
      })
      .catch(() => {
        queue.unshift(...batch);
        trim();
        return { flushed: 0, failed: true };
      })
      .then((outcome) => {
        flushing = null;
        return outcome;
      });

    return flushing;
  }

  function startTimer() {
    if (intervalId !== null) return intervalId;
    if (typeof timer.setInterval !== 'function') return null;
    intervalId = timer.setInterval(() => {
      flush();
    }, FLUSH_INTERVAL_MS);
    return intervalId;
  }

  function stopTimer() {
    if (intervalId === null) return;
    if (timer && typeof timer.clearInterval === 'function') timer.clearInterval(intervalId);
    intervalId = null;
  }

  function reset() {
    stopTimer();
    queue.length = 0;
    currentPageId = '';
    dropped = 0;
    rejected = 0;
    sent = 0;
    flushing = null;
  }

  if (autoFlush) startTimer();

  return {
    track,
    flush,
    /** 等待当前批次（含手动触发）落定，便于单测断言。 */
    flushNow: () => flush(),
    setPage,
    getPage: () => currentPageId,
    startTimer,
    stopTimer,
    reset,
    size: () => queue.length,
    pending: () => queue.slice(),
    stats: () => ({ queued: queue.length, sent, dropped, rejected }),
    events: EVENT_NAMES.slice(),
    batchPolicy: { BATCH_SIZE, QUEUE_LIMIT, FLUSH_INTERVAL_MS },
    sdkVersion,
  };
}

/**
 * 页面 / 组件层的统一上报入口：取装配层（app.js 的 `globalData.tracker`）已装配的实例。
 * tracker 未就绪（无云能力 / 异常启动路径）时静默返回 false，**绝不抛出、绝不打断页面渲染**。
 * 实例本身仍由 `createTracker` 在装配层创建，页面与组件只经本函数取用，不各自持有、不感知平台 API。
 * @param {string} name 事件名（取自冻结契约 EVENTS；未登记事件名由实例侧丢弃并计数）
 * @param {object} [payload]
 * @returns {boolean}
 */
function track(name, payload) {
  let tracker = null;
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    tracker = (app && app.globalData && app.globalData.tracker) || null;
  } catch (err) {
    tracker = null;
  }
  if (!tracker || typeof tracker.track !== 'function') return false;
  return tracker.track(name, payload);
}

module.exports = { createTracker, track, SDK_VERSION, BATCH_SIZE, QUEUE_LIMIT, FLUSH_INTERVAL_MS };
