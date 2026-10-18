'use strict';

/**
 * 客户端标识生成
 *
 * 依据：《项目说明书-月老办事处》§6.3（重复提交与刷号）、§7.1（埋点公共字段）。
 *
 * 抖音小程序运行环境不提供 Web Crypto，故此处**不依赖任何加密能力**：生成的标识仅用于
 * 「本地会话 / 设备条目不重复」，非安全用途（不做鉴权、不做加密）。身份链路（openid）由
 * 服务端从请求 header 读取（说明书 §3.2：云托管服务端可直接读 X-TT-OPENID，免登录），
 * 客户端只维护一个匿名设备标识用于本地去重与降级。
 */

const { STORE } = require('../shared/client-constants.js');

/** 生成一个形如 `dev-lx2k9-3f8a1c2d` 的本地唯一标识。 */
function newId(prefix) {
  const head = prefix ? `${prefix}-` : '';
  const part = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return `${head}${Date.now().toString(36)}-${part()}${part().slice(0, 4)}`;
}

/**
 * 取本地匿名设备标识；不存在则生成并持久化（存储键取自冻结契约 STORE.DEVICE）。
 * 存储不可用时仍返回本次生成的标识（仅本会话有效），绝不抛错。
 * @param {object} storage createStorage() 的返回值
 * @returns {string} 设备标识
 */
function getDeviceId(storage) {
  const held = storage.read(STORE.DEVICE, null);
  if (held && typeof held === 'object' && typeof held.device_id === 'string' && held.device_id) {
    return held.device_id;
  }
  const id = newId('dev');
  storage.write(STORE.DEVICE, { device_id: id, created_at: Date.now() });
  return id;
}

module.exports = { newId, getDeviceId };
