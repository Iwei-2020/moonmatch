'use strict';

/**
 * 云函数入口：submitProfile（薄壳）
 *
 * 只做「事件 → 参数 → handler」的转接，业务逻辑全在 server/lib/handlers.js。
 * 部署：源文件按同名函数放在 server/functions/submitProfile/；上线前经 `node tools/gen-cloud-functions.js`
 * 打包为自包含单文件 build/cloud-functions/moonmatch-api/submitProfile.js（云端为平铺 .js，调用路径 = `/submitProfile`）。
 *
 * 身份：服务端直接从请求头 `X-TT-OPENID` 读取（免 login 置换，见 lib/identity.js）。
 * 存储：由 store-provider.js 按环境选择 —— 云数据库优先，不可用降级内存并**显式告警**（禁止用于生产）。
 */

const { createRuntimeStore } = require('../../lib/store-provider.js');
const { readOpenid } = require('../../lib/identity.js');
const { handleSubmitProfile } = require('../../lib/handlers.js');

// 懒初始化：首次调用时选 store（本地/单测无官方 SDK 时自动降级并告警）
let store = null;

/** 入口签名对齐平台契约：params 即 HTTP 请求体，返回值作为 Response Body。 */
module.exports = async function main(params, context) {
  if (!store) store = createRuntimeStore(context);
  const ctx = {
    openid: readOpenid(context, params),
    store,
    now: Date.now,
    random: (max) => Math.floor(Math.random() * max),
  };
  return handleSubmitProfile(params || {}, ctx);
};
