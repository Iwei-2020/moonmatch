'use strict';

/**
 * 落地路由解析
 *
 * 依据：《项目说明书-月老办事处》§4（原型页面清单与入口可达性）、§2.1 A1–A2（进入小程序后读状态、
 * 点「拿一个」按有无档案分流）；页面与路由取自冻结契约 shared/client-constants.js（PAGES / ROUTES）。
 *
 * 形态：**纯函数**。骨架阶段只有「进入首页」一条路径 —— 全站仅两个业务入口（拿一个 / 取一个），
 * 无分享码、无深链参数；此处保留 `query` 解析与 `entry_source` 扩展位，后续若有落地参数
 * （如分享拉新 V1.1）在此扩展分支，不改调用方。
 *
 * 本模块不做任何存储读写（是否已留缘签由调用方经 session 查询后自行分流），职责单一。
 */

const { PAGES, ROUTES } = require('../shared/client-constants.js');

/** query 既支持对象（平台通常已解析），也支持原始 `a=1&b=2` 字符串（便于单测与兜底）。 */
function normalizeQuery(input) {
  if (!input) return {};
  if (typeof input === 'object') return input;
  if (typeof input !== 'string') return {};
  const out = {};
  for (const pair of input.replace(/^\?/, '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    if (!key) continue;
    try {
      out[decodeURIComponent(key)] = decodeURIComponent(value);
    } catch (err) {
      out[key] = value;
    }
  }
  return out;
}

/** 落地来源：显式 `entry_source` 优先，否则 direct（骨架阶段仅此两种）。 */
function resolveEntrySource(query) {
  const explicit = query && query.entry_source;
  return typeof explicit === 'string' && explicit ? explicit : 'direct';
}

/**
 * 解析启动参数 → 应进入的页面。
 * @param {object} input
 * @param {object|string} [input.query] 启动参数
 * @returns {{page:string, route:string, params:object, entrySource:string, code:null}}
 */
function resolveEntry(input) {
  const source = input || {};
  const query = normalizeQuery(source.query);

  return {
    page: PAGES.HOME,
    route: ROUTES[PAGES.HOME],
    params: {},
    entrySource: resolveEntrySource(query),
    code: null,
  };
}

module.exports = {
  PAGES,
  ROUTES,
  normalizeQuery,
  resolveEntrySource,
  resolveEntry,
};
