'use strict';

/**
 * 云函数调用适配器
 *
 * 依据：《项目说明书-月老办事处》§3.2（服务端载体为抖音云函数服务，客户端经
 * `tt.createCloud` + `cloud.callContainer` 调用；**返回的 data 为 JSON 字符串需自行解析**，
 * 平台无 `callFunction` 类封装；服务端可从 header 读 X-TT-OPENID，免 login 置换）、
 * §8.2（基础库 ≥2.70.0；低版本无云能力需兜底）、§8.5（云数据库组件未开启会降级为内存存储）。
 *
 * 为什么要有这一层：载体形态一旦变化，调用方式就不同；把调用方式散落到 P-04 / P-05 里，
 * 换载体就要改页面。故此处收敛两点：
 *   1. **调用器（invoker）**：默认按平台官方形态构造 —— 宿主具备 `tt.createCloud` 且注入了
 *      `envID` 时，经 `cloud.callContainer({ path, init })` 调用，函数名即路径（约定 `/函数名`）；
 *      亦支持外部注入 invoker（Node 单测 / 自建服务端）。两者都不可用时视为无能力；
 *   2. **信封解析**：服务端统一返回 `{ code, msg, data }`。`callContainer` 的 `data` 是
 *      **JSON 字符串**，此处负责 parse 后归一为 `{ ok, code, msg, data }`，页面只看到归一结果。
 *
 * 无调用能力时 `available()` 为 false，**每个语义化薄壳一律降级为
 * `{ ok:false, code:ERROR_CODES.SERVER_ERROR, msg:'cloud_unavailable' }`，绝不抛出、绝不 reject**，
 * 页面据此走兜底提示，不阻断渲染（§8.2）。
 */

const { ERROR_CODES } = require('../shared/client-constants.js');

/** 云托管路由约定：函数名 → `callContainer` 的 path（对应服务端薄壳见 server/functions/）。 */
function pathOf(name) {
  return `/${name}`;
}

/**
 * 按平台官方形态构造调用器（抖音云）：`tt.createCloud({ envID, serviceID })`
 * → `Cloud.callContainer({ path, init })`；小程序最低基础库 2.70.0。
 * 宿主无 `createCloud`、未注入 envID、或实例不提供 `callContainer` 时返回 null
 * —— 视为无调用能力，由调用方走降级分支，绝不抛错。
 * @param {object|null} host 抖音小程序为全局 tt
 * @param {{envID?:string, serviceID?:string}} [config] 云托管接入配置
 * @returns {null | ((name:string, params:object) => Promise<*|never>)}
 */
function resolveInvoker(host, config) {
  if (!host || typeof host.createCloud !== 'function') return null;
  const envID = (config && config.envID) || '';
  if (!envID) return null;

  let cloud;
  try {
    cloud = host.createCloud({ envID, serviceID: (config && config.serviceID) || '' });
  } catch (err) {
    return null;
  }
  if (!cloud || typeof cloud.callContainer !== 'function') return null;

  return (name, params) =>
    new Promise((resolve, reject) => {
      cloud.callContainer({
        path: pathOf(name),
        init: {
          method: 'POST',
          header: { 'content-type': 'application/json' },
          body: params || {},
        },
        success: (res) => resolve(res),
        fail: (err) => reject(new Error((err && err.errMsg) || 'callContainer_failed')),
      });
    });
}

/**
 * 依据平台运行时环境挑选云托管接入配置 —— 同一小程序有 dev / prod 两套云环境，须一次配置、自动切换。
 * 判据：`tt.getEnvInfoSync().microapp.envType`（合法值 `production` 线上版 / `development` 测试版 /
 * `preview` 预览版）。
 * **取不到该能力、或取值不认识时一律按 prod 兜底**：宁可连线上，也绝不让线上流量误连测试环境。
 * @param {object|null} host 抖音小程序为全局 tt
 * @param {{dev?:object, prod?:object}} targets 环境名 → 接入配置（`{ envID, serviceID }`）
 * @returns {object|null} 命中的接入配置；targets 缺失 prod 时返回 null
 */
function resolveCloudEnv(host, targets) {
  if (!targets || typeof targets !== 'object') return null;
  const NON_PROD = ['development', 'preview'];

  let envType = '';
  if (host && typeof host.getEnvInfoSync === 'function') {
    try {
      const info = host.getEnvInfoSync() || {};
      // 官方为 microapp.envType；此处兼容扁平写法，判据缺失即按 prod 兜底
      const app = info.microapp || info;
      envType = app.envType || app.envtype || '';
    } catch (err) {
      envType = '';
    }
  }

  if (NON_PROD.indexOf(envType) >= 0 && targets.dev) return targets.dev;
  return targets.prod || null;
}

/**
 * 把平台返回归一成统一信封 `{ code, msg, data }`；形态不可识别时返回 null。
 * 兼容三种包裹：
 *   1. 抖音云 `callContainer` 原始返回 `{ statusCode, header, data }`——`data` 为 JSON 字符串；
 *   2. 直返信封；
 *   3. 包一层 `result`。
 */
function unwrap(out) {
  let value = out;
  if (value && typeof value === 'object' && value.statusCode !== undefined && value.data !== undefined) {
    if (typeof value.data !== 'string') {
      value = value.data;
    } else {
      try {
        value = JSON.parse(value.data);
      } catch (err) {
        return null;
      }
    }
  }
  if (value && typeof value === 'object' && value.result !== undefined) value = value.result;
  if (!value || typeof value !== 'object') return null;
  if (value.code === undefined || value.code === null) return null;
  return {
    code: value.code,
    msg: value.msg === undefined || value.msg === null ? '' : String(value.msg),
    data: value.data === undefined ? null : value.data,
  };
}

/** 无云能力时的统一降级结果（语义化薄壳共用）。 */
function unavailable() {
  return { ok: false, code: ERROR_CODES.SERVER_ERROR, msg: 'cloud_unavailable', data: null };
}

/**
 * @param {{host?:object, envID?:string, serviceID?:string, invoker?:Function|null}} [options]
 *   - host：宿主对象，默认由调用方传入全局 tt；
 *   - envID / serviceID：抖音云接入配置，用于按平台官方形态构造调用器；
 *   - invoker：显式注入的调用器（优先于上述两者）；显式传 null 表示「强制无能力」，用于测试降级路径。
 */
function createCloud(options) {
  const opts = options || {};
  const invoker = opts.invoker !== undefined ? opts.invoker : resolveInvoker(opts.host, opts);

  /** 当前宿主是否具备真实调用能力；false 时各处须走降级分支。 */
  function available() {
    return typeof invoker === 'function';
  }

  /**
   * 调一次云函数。**永不抛出、永不 reject** —— 网络与平台异常一律收敛为失败结果。
   * @returns {Promise<{ok:boolean, code:(number|string), msg:string, data:*}>}
   */
  function call(name, params) {
    if (!available()) return Promise.resolve(unavailable());

    let pending;
    try {
      pending = invoker(name, params || {});
    } catch (err) {
      return Promise.resolve({
        ok: false,
        code: ERROR_CODES.SERVER_ERROR,
        msg: err && err.message ? String(err.message) : 'invoke_threw',
        data: null,
      });
    }

    return Promise.resolve(pending).then(
      (out) => {
        const envelope = unwrap(out);
        if (!envelope) {
          return { ok: false, code: ERROR_CODES.SERVER_ERROR, msg: 'invalid_envelope', data: null };
        }
        return {
          ok: envelope.code === ERROR_CODES.OK,
          code: envelope.code,
          msg: envelope.msg,
          data: envelope.data,
        };
      },
      (err) => ({
        ok: false,
        code: ERROR_CODES.SERVER_ERROR,
        msg: err && err.message ? String(err.message) : 'invoke_failed',
        data: null,
      })
    );
  }

  // 十个云函数语义化薄壳（对应 server/functions/，函数名即云托管路径）。入参直接透传，语义校验在服务端。
  return {
    available,
    call,
    submitProfile: (params) => call('submitProfile', params),
    getProfile: (params) => call('getProfile', params),
    offlineProfile: (params) => call('offlineProfile', params),
    getMatch: (params) => call('getMatch', params),
    createAdTask: (params) => call('createAdTask', params),
    claimTicket: (params) => call('claimTicket', params),
    revealContact: (params) => call('revealContact', params),
    listUnlocked: (params) => call('listUnlocked', params),
    reportProfile: (params) => call('reportProfile', params),
    reportEvents: (params) => call('reportEvents', params),
  };
}

/**
 * 取装配层（app.js 的 `globalData.cloud`）注入的云适配器并按语义化薄壳调用。
 * 取不到能力（Node / 异常启动路径 / envID 未配置）时降级为 `unavailable()`，
 * 与直接调用 `createCloud` 的降级口径一致；**绝不抛出、绝不 reject**。
 * @param {string} name 语义化方法名（同 createCloud 返回对象的方法名）
 * @param {object} [params]
 * @returns {Promise<{ok:boolean, code:(number|string), msg:string, data:*}>}
 */
function callActive(name, params) {
  let cloud = null;
  try {
    const app = typeof getApp === 'function' ? getApp() : null;
    cloud = (app && app.globalData && app.globalData.cloud) || null;
  } catch (err) {
    cloud = null;
  }
  if (!cloud || typeof cloud[name] !== 'function') return Promise.resolve(unavailable());
  return cloud[name](params || {});
}

module.exports = { createCloud, callActive, resolveInvoker, resolveCloudEnv, unwrap };
