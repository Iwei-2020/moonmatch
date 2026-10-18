'use strict';

/**
 * contact-field · 联系方式字段渲染（合规关键组件）
 *
 * 依据：说明书 §6.4「三态渲染规则」；线稿说明 §9.3。
 *
 * 硬约束（说明书 §6.4）：
 *   1. 明文**永不写入 data、不进入视图层文本节点**（本组件只渲染服务端下发的掩码）；
 *   2. 明文仅存在于复制动作的**局部变量**中，拿到后直接 tt.setClipboardData 写剪贴板；
 *   3. 明文不落本地存储、不打日志。
 *
 * properties: masked / contactType / state(locked|unlocked|expired) / profileId / ticketId
 *   - ticketId 为服务端发放的查看券（本组件复制时随 profileId 一并回传 revealContact）；
 *     它是一次性凭证、非敏感信息，不参与视图渲染。
 * events: copy（成功或失败均向父级回传，父级可据此刷新卡片态）
 */

const { ERROR_CODES, COPY, EVENTS, CONTACT_TYPES } = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');
const { track } = require('../../core/tracker.js');

/** 复制失败按 ERROR_CODES 收敛文案（client-constants 未覆盖的码收敛为简短提示） */
const FAIL_TEXT = {
  [ERROR_CODES.TICKET_EXPIRED]: COPY.EXPIRED,
  [ERROR_CODES.TICKET_NOT_FOUND]: COPY.EXPIRED,
  [ERROR_CODES.PROFILE_OFFLINE]: COPY.EXPIRED,
  [ERROR_CODES.PROFILE_NOT_FOUND]: COPY.EXPIRED,
  [ERROR_CODES.DAILY_UNLOCK_LIMIT]: COPY.DAILY_LIMIT,
  [ERROR_CODES.MATCH_COOLDOWN]: COPY.MATCH_COOLDOWN,
  [ERROR_CODES.AD_COOLDOWN]: COPY.MATCH_COOLDOWN,
  [ERROR_CODES.RISK_BLOCKED]: '当前操作受限，请稍后再试',
};
const FAIL_TEXT_DEFAULT = '复制失败，请稍后重试';

Component({
  properties: {
    masked: { type: String, value: '' },
    contactType: { type: String, value: CONTACT_TYPES.PHONE },
    state: { type: String, value: 'locked' },
    profileId: { type: String, value: '' },
    ticketId: { type: String, value: '' },
  },

  data: {
    icon: '🔒',
    copying: false,
    copyText: COPY.BTN_COPY,
    noticeText: COPY.UNLOCK_COMPLIANCE,
    deadText: COPY.EXPIRED,
  },

  observers: {
    state(state) {
      const icon = state === 'unlocked' ? '🔓' : state === 'expired' ? '✕' : '🔒';
      this.setData({ icon });
    },
  },

  methods: {
    /**
     * 复制：内部调 revealContact 取明文 → 直接写剪贴板 → toast。
     * 明文只活在本次调用的局部变量中，绝不经 setData。
     */
    async onCopy() {
      if (this.data.state !== 'unlocked' || this.data.copying) return;

      const profileId = this.data.profileId;
      this.setData({ copying: true });

      // 语义化云封装：无云能力时返回 { ok: false }，不抛错
      const res = await callActive('revealContact', { profileId, ticketId: this.data.ticketId });

      if (!res.ok || !res.data || !res.data.contact) {
        this.setData({ copying: false });
        const text = FAIL_TEXT[res.code] || FAIL_TEXT_DEFAULT;
        tt.showToast({ title: text, icon: 'none' });
        this.triggerEvent('copy', { profileId, ok: false, code: res.code });
        return;
      }

      // plaintext：仅存在于局部作用域，不进入 this.data / 视图层
      const plaintext = res.data.contact;

      tt.setClipboardData({
        data: plaintext,
        success: () => {
          tt.showToast({ title: COPY.COPY_OK, icon: 'none' });
          track(EVENTS.CONTACT_COPY, { profile_id: profileId });
          this.triggerEvent('copy', { profileId, ok: true });
        },
        fail: () => {
          tt.showToast({ title: FAIL_TEXT_DEFAULT, icon: 'none' });
          this.triggerEvent('copy', { profileId, ok: false });
        },
        complete: () => {
          this.setData({ copying: false });
        },
      });
    },
  },
});
