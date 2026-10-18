'use strict';

/**
 * 统一响应信封（《项目说明书》§8）
 *
 * 形态：`{ code, msg, data }`，code === 0 为成功。
 * 抖音云 `callContainer` 把响应体交给客户端时 `data` 是 **JSON 字符串**，客户端 core/cloud.js 自行 parse
 * 后归一为 `{ ok, code, msg, data }`，因此服务端只需保证信封结构一致。
 */

const { ERROR_CODES, ERROR_NAMES, DomainError } = require('./errors.js');

/** 成功信封。 */
function ok(data) {
  return { code: ERROR_CODES.OK, msg: 'ok', data: data === undefined ? {} : data };
}

/**
 * 失败信封。
 * @param {number} code 数值错误码
 * @param {string} [detail] 附加说明（面向日志，不面向用户）
 * @param {object} [meta] 结构化附加信息，挂到 data 上供客户端分支
 */
function fail(code, detail, meta) {
  const name = ERROR_NAMES[code] || 'UNKNOWN_ERROR';
  return {
    code,
    msg: detail ? `${name}: ${detail}` : name,
    data: meta === undefined ? null : meta,
  };
}

/**
 * 把任意异常收敛为失败信封：非 DomainError 一律归为 SERVER_ERROR，避免把内部细节泄漏给前端。
 */
function fromError(err) {
  if (err instanceof DomainError) return fail(err.code, err.detail, err.meta);
  return fail(ERROR_CODES.SERVER_ERROR, err && err.message ? String(err.message) : undefined);
}

/** 判断信封是否成功。 */
function isOk(envelope) {
  return !!envelope && envelope.code === ERROR_CODES.OK;
}

/** 序列化为 JSON 字符串（薄壳返回给平台的响应体形态）。 */
function serialize(envelope) {
  return JSON.stringify(envelope);
}

module.exports = { ok, fail, fromError, isOk, serialize };
