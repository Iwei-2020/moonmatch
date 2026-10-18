'use strict';

/**
 * 运行时存储选择（《项目说明书》§3.2）
 *
 * 云函数为**多实例**，必须用云数据库才能保证跨实例可见；内存实现仅用于本地与单测。
 * 策略：
 *   1) **懒加载**官方 SDK `@open-dy/node-server-sdk`：本地 / 单测环境通常未安装该依赖，
 *      顶层 `require` 会让 `npm test` 直接挂掉；改为入口首次调用时再加载。
 *   2) 云数据库可用 → 使用云库（store-cloud.js）。
 *   3) 不可用 → 降级 store.js（内存）并**显式告警**（禁止静默降级）。
 * 降级语义：内存实现不保证跨实例状态可见，**禁止用于生产**。
 */

const { createMemoryStore } = require('./store.js');
const { createCloudStore } = require('./store-cloud.js');

/** 默认 SDK 加载器。外部依赖，打包器不改写；由云端 package.json 声明并由平台安装。 */
function loadDefaultSDK() {
  return require('@open-dy/node-server-sdk');
}

/** 取告警输出通道：优先平台运行时的 context.warn，回落到 console.warn。 */
function pickWarn(context) {
  if (context && typeof context.warn === 'function') return context.warn.bind(context);
  if (context && typeof context.log === 'function') return context.log.bind(context);
  return console.warn.bind(console);
}

/**
 * @param {object} [context] 云函数运行时上下文（仅供告警输出）
 * @param {()=>object} [loadSDK] SDK 加载器，默认官方 SDK；单测注入以模拟「可用 / 不可用」
 * @returns {object} store 实例（云库为异步、内存为同步，上层统一 await）
 */
function createRuntimeStore(context, loadSDK = loadDefaultSDK) {
  try {
    const sdk = loadSDK();
    const dySDK = sdk.dySDK || sdk.default || sdk;
    if (!dySDK || typeof dySDK.database !== 'function') {
      throw new Error('SDK 未暴露 dySDK.database()');
    }
    return createCloudStore(dySDK);
  } catch (err) {
    pickWarn(context)(
      '[moonmatch] 云数据库不可用，已降级为内存存储：云函数为多实例，内存不保证跨实例状态可见，**禁止用于生产**。'
      + '请在抖音云控制台对应环境开启云数据库组件（《项目说明书》§3.2、§8.5）：'
      + (err && err.message)
    );
    return createMemoryStore({});
  }
}

module.exports = { createRuntimeStore };
