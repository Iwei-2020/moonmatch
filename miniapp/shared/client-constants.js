'use strict';

/**
 * 客户端常量（冻结契约）
 *
 * 依据：《项目说明书-月老办事处》§2（业务流程）、§5（广告策略与频次限制）、
 * §6.4（缘签三态渲染）、§7（埋点事件清单）、§4（页面清单）。
 *
 * 本文件是**客户端与服务端共同遵守的契约**：
 *   - 错误码 ERROR_CODES 与 server/lib/errors.js 必须逐条一致；
 *   - 限额 LIMITS 与 server/lib/risk.js 的默认值必须一致（服务端为准，客户端仅用于展示）；
 *   - 文案 COPY 面向用户，统一「缘签」词表（本文件即文案唯一来源）。
 * 客户端源码中不得出现明文缘签（tools/check-structure.js 已设门禁）。
 */

/** 统一错误码：服务端信封 { code, msg, data } 的 code 取值 */
const ERROR_CODES = {
  OK: 0,
  INVALID_PARAM: 1001,
  NOT_REGISTERED: 1002,
  ALREADY_REGISTERED: 1003,
  DUPLICATE_CONTACT: 1004,
  PROFILE_NOT_FOUND: 1005,
  PROFILE_OFFLINE: 1006,
  DAILY_MATCH_LIMIT: 1007,
  DAILY_UNLOCK_LIMIT: 1008,
  MATCH_COOLDOWN: 1009,
  AD_COOLDOWN: 1010,
  TASK_NOT_FOUND: 1011,
  TASK_NOT_FINISHED: 1012,
  TICKET_NOT_FOUND: 1013,
  TICKET_EXPIRED: 1014,
  POOL_EMPTY: 1015,
  RISK_BLOCKED: 1016,
  AUDIT_PENDING: 1017,
  SERVER_ERROR: 1018,
};

/** 本地存储键（统一经 core/storage.js 读写） */
const STORE = {
  PROFILE: 'mm_profile', // 我的档案摘要（不含明文缘签）
  QUOTA: 'mm_quota', // 今日次数展示缓存
  TRACK: 'mm_track_queue', // 埋点队列
  UNLOCKS: 'mm_unlocks', // 解锁记录摘要
  DEVICE: 'mm_device_id', // 本地匿名设备标识
  SESSION: 'mm_session', // 会话与启动环境
};

/** 页面埋点编号（说明书 §4 页面清单，与 doc/线稿说明一致） */
const PAGES = {
  HOME: 'P-01',
  REGISTER: 'P-02',
  PROFILE: 'P-03',
  UNLOCKS: 'P-05',
  REPORT: 'P-06',
  LEGAL: 'P-07',
};

/** 路由（V1.0 全部入主包，不设分包：说明书 §3.2） */
const ROUTES = {
  [PAGES.HOME]: '/pages/home/index',
  [PAGES.REGISTER]: '/pages/register/index',
  [PAGES.PROFILE]: '/pages/profile/index',
  [PAGES.UNLOCKS]: '/pages/unlocks/index',
  [PAGES.REPORT]: '/pages/report/index',
  [PAGES.LEGAL]: '/pages/legal/index',
};

/** 埋点事件名（说明书 §7.2 事件清单，逐条对应） */
const EVENTS = {
  APP_LAUNCH: 'app_launch',
  HOME_ENTRY_CLICK: 'home_entry_click',
  PROFILE_FORM_START: 'profile_form_start',
  PROFILE_SUBMIT: 'profile_submit',
  PROFILE_AUDIT_RESULT: 'profile_audit_result',
  PROFILE_EDIT: 'profile_edit',
  MATCH_REQUEST: 'match_request',
  MATCH_RESULT: 'match_result',
  MATCH_CARD_VIEW: 'match_card_view',
  AD_REWARD_REQUEST: 'ad_reward_request',
  AD_REWARD_SHOW: 'ad_reward_show',
  AD_REWARD_CLOSE: 'ad_reward_close',
  AD_REWARD_ERROR: 'ad_reward_error',
  AD_REWARD_COMPLETE: 'ad_reward_complete',
  CONTACT_UNLOCK: 'contact_unlock',
  CONTACT_COPY: 'contact_copy',
  DAILY_LIMIT_HIT: 'daily_limit_hit',
  REPORT_SUBMIT: 'report_submit',
  PROFILE_STATUS_CHANGE: 'profile_status_change',
  PAGE_VIEW: 'page_view',
  SESSION_END: 'session_end',
};

/** 缘签类型白名单（说明书 §6.4；微信号/QQ 不开放）。仅供服务端校验与掩码分发，不再对用户展示区分 */
const CONTACT_TYPES = {
  PHONE: 'phone',
  DOUYIN: 'douyin',
};

/**
 * 限额与时限（客户端仅用于展示；**发放与消耗一律以服务端为准**，说明书 §5.4）。
 * 数值需与 server/lib/risk.js 保持一致。
 */
const LIMITS = {
  DAILY_UNLOCK: 20, // 每日解锁上限
  DAILY_MATCH: 30, // 每日匹配上限
  MATCH_COOLDOWN_MS: 3000, // 两次「获取」最小间隔
  AD_COOLDOWN_MS: 30000, // 两次广告触发最小间隔
  TASK_TTL_MS: 300000, // 广告任务令牌有效期 5 分钟
  TICKET_TTL_MS: 900000, // 查看券有效期 15 分钟
  NEW_USER_DAILY_UNLOCK: 5, // 新用户 24h 内解锁上限
  NEW_USER_WINDOW_MS: 86400000,
  FREE_REVISIT_MS: 2592000000, // 已解锁 30 天内免费复看
  AD_FAILURE_EXEMPT: 3, // 广告连续失败 N 次触发当日豁免一次
};

/** 档案状态（客户端展示与 audit-badge 组件共用） */
const PROFILE_STATUS = {
  DRAFT: 'draft',
  PENDING: 'pending',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  OFFLINE: 'offline',
};

/** 广告位：客户端不硬编码 adUnitId，一律由服务端 createAdTask 下发（说明书 §5.1） */
const AD = {
  POOL_SIZE: 2, // 广告位轮询数量
  MIN_PLAY_MS: 0, // 完整观看以 isEndReached 为准，不做时长臆测
};

/**
 * 文案（缘签隐喻统一词表）
 *
 * 词表：联系方式 → 「缘签」；登记入口 → 「留一个」；获取入口 → 「取一个」；广告揭开 → 「解签」。
 * 全站不再出现「联系方式」「手机号」「抖音号」这类直白描述，也不对用户做号码类型的区分。
 * 文案可读性优先，功能语义（字段名 / 状态键 / 错误码 / 埋点）一律保持原样不变。
 */
const COPY = {
  HOME_TAGLINE: '留一个缘签，看看谁在等你',
  BTN_REGISTER: '留一个',
  BTN_FETCH: '取一个',
  BTN_UNLOCK: '看广告解签',
  BTN_COPY: '复制缘签',
  UNLOCK_NOTICE: '完整观看 1 条激励视频，即可揭开对方的缘签',
  AD_PLAYING_TIP: '看完即可解签，请勿中途退出',
  AD_GRANTING: '正在为你解签…',
  COPY_OK: '已复制，请合规使用',
  UNLOCK_COMPLIANCE: '解签后仅可复制，请勿用于骚扰或营销',
  DAILY_LIMIT: '今日次数已用完，明天再来',
  MATCH_COOLDOWN: '操作太快了，稍后再试',
  POOL_EMPTY: '今日的缘签已取完，明天再来',
  MATCHING: '正在为你寻缘…',
  EXPIRED: '该缘签已失效',
  AD_FAILED: '广告加载失败，请稍后重试',
  FETCH_FAIL: '取签失败，请稍后重试',
  UNLOCKED_OK: '已解签，可复制缘签',
  AD_INCOMPLETE: '未完整观看，未发放、不扣次数',
  HOME_DISCLAIMER: '本小程序仅提供信息展示，不对用户资料真实性作担保，请谨慎核实',
  REGISTER_HINT: '填 2 项，10 秒完成；你的缘签在你亲手揭开前，谁都不会看到',
  REPORT_DONE: '举报已提交，我们会尽快核实',
  AUDIT_PENDING: '资料审核中',
  REJECTED_PREFIX: '已驳回：',
  CHANGE_CONTACT_NOTICE: '变更缘签需重新审核',
  /* 取签浮层：选签筒 → 看广告 → 展示缘签 */
  POOL_TITLE: '想取哪一签？',
  POOL_MALE: '男签',
  POOL_FEMALE: '女签',
  POOL_NOTE: '选定后随机为你取 1 份缘签；取签免费，完整观看 1 条激励视频即可解签',
  POOL_CANCEL: '再想想',
  /* 首页三味：缘分 / 运气 / 相遇 */
  HOME_FATE_LABEL: '缘分',
  HOME_FATE_TEXT: '月老已为你记下名字，一线牵起，只待相逢',
  HOME_LUCK_LABEL: '运气',
  HOME_LUCK_TEXT: '每一签皆由天意抽出，好运自会落定',
  HOME_MEET_LABEL: '相遇',
  HOME_MEET_TEXT: '取一签，便与某个人的缘分近了一分',
};

module.exports = {
  ERROR_CODES,
  STORE,
  PAGES,
  ROUTES,
  EVENTS,
  CONTACT_TYPES,
  LIMITS,
  PROFILE_STATUS,
  AD,
  COPY,
};
