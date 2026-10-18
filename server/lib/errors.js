'use strict';

/**
 * 服务端错误码（《项目说明书》§8、客户端契约 client-constants.js）
 *
 * 事实来源：`miniapp/shared/client-constants.js` 的 ERROR_CODES —— 服务端与客户端**必须逐条同值**，
 * 否则前端无法把服务端错误收敛成合规文案（如 DAILY_UNLOCK_LIMIT → COPY.DAILY_LIMIT）。
 * 因此此处直接引用同一份契约，而非各自维护一份。
 */

const { ERROR_CODES } = require('../../miniapp/shared/client-constants.js');

/** 数值码 → 名称，便于日志排查；名称即信封 msg 的前缀 */
const ERROR_NAMES = Object.fromEntries(Object.entries(ERROR_CODES).map(([name, code]) => [code, name]));

/** 领域异常：携带错误码，由 envelope.fromError 收敛为失败信封，不泄漏内部堆栈 */
class DomainError extends Error {
  constructor(code, detail, meta) {
    super(detail ? `${ERROR_NAMES[code] || 'UNKNOWN_ERROR'}: ${detail}` : ERROR_NAMES[code] || 'UNKNOWN_ERROR');
    this.name = 'DomainError';
    this.code = code;
    this.detail = detail;
    this.meta = meta;
  }
}

/** 快捷构造：`throw domainError(ERROR_CODES.NOT_REGISTERED)` */
function domainError(code, detail, meta) {
  return new DomainError(code, detail, meta);
}

module.exports = { ERROR_CODES, ERROR_NAMES, DomainError, domainError };
