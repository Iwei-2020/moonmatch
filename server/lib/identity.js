'use strict';

/**
 * 身份解析（《项目说明书》§3.2 工程约定）
 *
 * 抖音云托管服务端**可直接从请求 header 读取用户身份**（`X-TT-OPENID` 等），
 * 无需 `tt.login` + `code2Session` 置换登录态，也不存在 `tt.cloud.callFunction` 形态。
 *
 * 三级取值，全部防御式（取不到不抛错，交由业务层返回 NOT_REGISTERED）：
 *   ① 容器请求头 `context.request.headers['x-tt-openid']`（真实部署路径）；
 *   ② 扁平头对象 `context.headers['x-tt-openid']`（不同装配形态的兼容）；
 *   ③ 参数上的 `params.__openid`（仅本地调试与单测注入使用，**生产不依赖**）。
 */

const OPENID_HEADER = 'x-tt-openid';

/** 从容器事件上下文中取出归一化后的 header 集合 */
function headersOf(context) {
  if (!context || typeof context !== 'object') return {};
  if (context.request && typeof context.request.headers === 'object') return context.request.headers || {};
  if (typeof context.headers === 'object' && context.headers) return context.headers;
  return {};
}

/**
 * 解析调用者 openid。
 * @param {object} [context] 云函数上下文（平台注入）
 * @param {object} [params] 业务参数（仅取调试用的 __openid）
 * @returns {string} 取不到时返回空串
 */
function readOpenid(context, params) {
  const headers = headersOf(context);
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === OPENID_HEADER) {
      const value = headers[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  const injected = params && params.__openid;
  return typeof injected === 'string' ? injected : '';
}

module.exports = { OPENID_HEADER, readOpenid };
