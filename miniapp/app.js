'use strict';

/**
 * 小程序入口（装配层）
 *
 * 依据：《项目说明书-月老办事处》§3.2（工程约定：页面极少且无图片资源，全部入主包、不设分包）、
 * §2（流程与状态机）、§5（广告策略）、§7（埋点事件与公共字段）、§8.4/§8.5（降级与可观测）。
 *
 * 职责四件：
 *   1. 装配本地能力：存储 → 会话 → 云适配器 → 埋点；**依赖全部经适配器注入**，Node 下可直接 require 试跑；
 *   2. 解析落地路由：把启动 query 交给 core/route.js（骨架阶段恒回首页，保留 query 扩展位）；
 *   3. 提供统一的 page_view 上报入口 `reportPageView`；
 *   4. 暴露 `globalData.{storage, session, cloud, tracker, entry}` 供页面使用，页面不直接摸平台 API。
 *
 * 关于上报通道：`transport` 仅在宿主具备云调用能力时接上（core/cloud.js 的 `available()`）；
 * 取不到能力时保持 null —— 事件留在队列内（core/tracker.js 的 `no_transport` 短路），
 * 与「不接真实端点」的骨架阶段行为一致。
 *
 * 云环境接入位见下方 `CLOUD_TARGETS`：**envID 留空即视为无调用能力**（骨架阶段，不阻断编译）；
 * 注意抖音云需在控制台为该环境开启**云数据库组件**，否则服务端会自动降级为内存存储，
 * 跨实例状态不保持（说明书 §3.2 / §8.5），上线前须核对环境清单。
 */

const { createStorage } = require('./core/storage.js');
const { createSession } = require('./core/session.js');
const { createTracker } = require('./core/tracker.js');
const { createCloud, resolveCloudEnv } = require('./core/cloud.js');
const { resolveEntry } = require('./core/route.js');
const { EVENTS } = require('./shared/client-constants.js');

/** 宿主 API：抖音小程序为全局 tt；Node 测试 / 编译期取到 null，此时存储自动降级为内存实现。 */
const HOST = typeof tt !== 'undefined' ? tt : null;

/**
 * 抖音云托管接入配置：同一小程序的 dev / prod 两套云环境，由平台运行时环境自动切换
 * （线上 → prod，开发版 / 预览版 → dev；判据取不到时**按 prod 兜底**，见 core/cloud.js 的
 * `resolveCloudEnv`）。已填入控制台取得的 envID / serviceID：dev / prod **共用同一 serviceID**
 * （`1mh9lmjuoe1pe`，与 star-type 的实际形态一致）；留空即视为无调用能力，页面与埋点自动走降级分支。
 */
const CLOUD_TARGETS = {
  dev: { envID: 'env-LmRTDLRFhd', serviceID: '1mh9lmjuoe1pe' },
  prod: { envID: 'env-rQsmmF3bux', serviceID: '1mh9lmjuoe1pe' },
};

/** `getNetworkType` 为异步接口，启动时取一次并缓存，供埋点公共字段 `network_type` 读取。 */
let networkType = 'unknown';

function primeNetworkType() {
  if (!HOST || typeof HOST.getNetworkType !== 'function') return;
  try {
    HOST.getNetworkType({
      success(res) {
        if (res && res.networkType) networkType = res.networkType;
      },
    });
  } catch (err) {
    /* 静默：取不到网络类型不阻断启动，埋点公共字段退化为 unknown（tracker 侧已有兜底） */
  }
}

const app = {
  globalData: {
    storage: null,
    session: null,
    tracker: null,
    /** core/cloud.js 的适配器：{ available, call, submitProfile, getMatch, … } */
    cloud: null,
    /** core/route.js 的解析结果：{ page, route, params, entrySource, code } */
    entry: null,
  },

  onLaunch(options) {
    primeNetworkType();

    const storage = createStorage(HOST && typeof HOST.getStorageSync === 'function' ? HOST : null);
    const session = createSession(storage);

    // 接入配置按平台运行时环境自动选取（线上 → prod，开发 / 预览 → dev），取不到即无能力
    const cloudEnv = resolveCloudEnv(HOST, CLOUD_TARGETS) || { envID: '', serviceID: '' };
    const cloud = createCloud({ host: HOST, envID: cloudEnv.envID, serviceID: cloudEnv.serviceID });

    const tracker = createTracker({
      // 无云函数能力时保持 null：事件留在队列内（骨架阶段行为），不产生必然失败的空转请求
      transport: cloud.available() ? (events) => cloud.reportEvents({ events }) : null,
      getSessionId: () => session.status().session_id || '',
      getUserId: () => session.getUserId(),
      getNetwork: () => networkType,
    });

    const entry = resolveEntry({ query: options && options.query });

    this.globalData.storage = storage;
    this.globalData.session = session;
    this.globalData.cloud = cloud;
    this.globalData.tracker = tracker;
    this.globalData.entry = entry;

    this.beginForeground();

    // §7.2：`app_launch` 关键属性为场景值与来源
    tracker.track(EVENTS.APP_LAUNCH, {
      scene: (options && options.scene) || '',
      entry_source: entry.entrySource,
    });
  },

  /** 一次前台停留 = 一个埋点会话（onShow / onLaunch 起算，onHide 结算时长）。 */
  beginForeground() {
    this.foregroundAt = Date.now();
  },

  onShow() {
    this.beginForeground();
  },

  onHide() {
    const tracker = this.globalData.tracker;
    if (!tracker) return;
    tracker.track(EVENTS.SESSION_END, {
      duration_ms: Math.max(0, Date.now() - (this.foregroundAt || Date.now())),
    });
    // 退后台时尽力刷一次队列（平台可能随时挂起，失败也无妨 —— 事件仍在队列内）
    if (typeof tracker.flush === 'function') tracker.flush();
  },

  /**
   * 页面统一的 page_view 上报入口。
   * tracker 未就绪（如异常启动路径）时静默返回 false，绝不打断页面渲染。
   * @param {string} pageId 取自 shared/client-constants.js 的 PAGES（P-01…P-07）
   * @param {object} [extra] 追加字段（page_view 无额外专属字段，保留扩展位）
   */
  reportPageView(pageId, extra) {
    const tracker = this.globalData.tracker;
    if (!tracker) return false;
    if (typeof tracker.setPage === 'function') tracker.setPage(pageId);

    const payload = { page_id: pageId };
    if (extra) {
      for (const key of Object.keys(extra)) payload[key] = extra[key];
    }
    return tracker.track(EVENTS.PAGE_VIEW, payload);
  },
};

// 平台注册：Node / 编译期无 `App` 全局（typeof 判定安全），本文件可直接 require 而不抛错；
// 小程序运行时由平台注入 `App` 完成装配。
if (typeof App === 'function') App(app);
module.exports = app;
