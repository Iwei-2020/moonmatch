'use strict';

/**
 * 本地存储适配层
 *
 * 依据：《项目说明书-月老办事处》§8.4（本地只缓存掩码、禁止明文落 localStorage）；
 * 形态参照既有工程 star-type/miniapp/core/storage.js。
 *
 * 页面不直接散用 `tt.getStorageSync` / `tt.removeStorageSync`，一律经本层读写，好处有二：
 *   ① 便于在 Node 下注入内存适配器做单测；② 存储异常被吞掉，不会冒泡打断用户操作。
 *
 * 适配器契约（与抖音小程序同步存储 API 形态一致）：
 *   { getStorageSync(key), setStorageSync(key, value), removeStorageSync(key) }
 * 未注入适配器时自动降级为内存实现（跨实例不保持，与云端未开云数据库组件时的降级一致）。
 */

const { STORE } = require('../shared/client-constants.js');

/** 内存适配器：无宿主 API 时的降级实现，同时是单测的默认依赖。 */
function createMemoryAdapter() {
  const map = new Map();
  return {
    getStorageSync: (key) => (map.has(key) ? map.get(key) : ''),
    setStorageSync: (key, value) => {
      map.set(key, value);
    },
    removeStorageSync: (key) => {
      map.delete(key);
    },
  };
}

/**
 * 由适配器构造存储层。
 * @param {object} [adapter] 宿主存储适配器；省略则用内存实现
 */
function createStorage(adapter) {
  const host = adapter || createMemoryAdapter();

  return {
    /** 读取并解析 JSON。键不存在或内容损坏一律返回 fallback。 */
    read(key, fallback) {
      try {
        const raw = host.getStorageSync(key);
        if (raw === '' || raw === null || raw === undefined) return fallback;
        if (typeof raw !== 'string') return raw;
        return JSON.parse(raw);
      } catch (err) {
        // 存储内容损坏（如被旧版本写坏）→ 视为不存在，由调用方按新会话处理
        return fallback;
      }
    },

    /** 写入并序列化。失败时返回 false，由调用方决定是否降级。 */
    write(key, value) {
      try {
        host.setStorageSync(key, JSON.stringify(value));
        return true;
      } catch (err) {
        return false;
      }
    },

    remove(key) {
      try {
        host.removeStorageSync(key);
      } catch (err) {
        /* 静默：清理失败不影响主流程 */
      }
    },

    isPersistent() {
      return host !== null && typeof host.setStorageSync === 'function';
    },

    keys: STORE,
  };
}

module.exports = { createStorage, createMemoryAdapter };
