'use strict';

/**
 * match-card · 匹配结果卡视觉承载（P-01 取签浮层 / P-05 缘签簿复用）
 *
 * 依据：说明书 §4「关键交互组件」、§6.4（卡片不含明文）；线稿说明 §9.2（锁定 / 已解签 / 失效）。
 *
 * properties: card:Object、mode:String（locked | unlocked | expired）
 *   card 约定字段：{ profileId, gender, masked, contactType, ticketId }
 *   —— 只消费服务端下发的**掩码**，卡片不持有任何缘签明文。
 * events: unlock / copy / report（交给页面处理，组件不直接调云函数）
 */

const { COPY, CONTACT_TYPES } = require('../../shared/client-constants.js');

const GENDER_TEXT = { male: '男', female: '女', m: '男', f: '女', 男: '男', 女: '女' };

const BADGE = {
  locked: { text: '待解签', cls: 'mm-badge mc-badge--locked' },
  unlocked: { text: '已解签', cls: 'mm-badge mm-badge--ok' },
  expired: { text: '已失效', cls: 'mm-badge mc-badge--lock' },
};

const SUB_TEXT = {
  locked: '未解签，看广告后可复制缘签',
  unlocked: '已解签，明文不进入视图层',
  expired: COPY.EXPIRED,
};

const CF_STATE = { locked: 'locked', unlocked: 'unlocked', expired: 'expired' };

Component({
  properties: {
    card: { type: Object, value: {} },
    mode: { type: String, value: 'locked' },
  },

  data: {
    title: '',
    subText: SUB_TEXT.locked,
    badgeText: BADGE.locked.text,
    badgeCls: BADGE.locked.cls,
    masked: '',
    contactType: CONTACT_TYPES.PHONE,
    cfState: 'locked',
    profileId: '',
    ticketId: '',
    unlockText: COPY.BTN_UNLOCK,
    expiredText: COPY.EXPIRED,
  },

  observers: {
    'card, mode': function (card, mode) {
      const c = card || {};
      const title = GENDER_TEXT[c.gender] || '';
      const badge = BADGE[mode] || BADGE.locked;

      this.setData({
        title,
        masked: c.masked || '',
        contactType: c.contactType || CONTACT_TYPES.PHONE,
        profileId: c.profileId || '',
        ticketId: c.ticketId || '',
        subText: SUB_TEXT[mode] || SUB_TEXT.locked,
        badgeText: badge.text,
        badgeCls: badge.cls,
        cfState: CF_STATE[mode] || 'locked',
      });
    },
  },

  methods: {
    onUnlock() {
      this.triggerEvent('unlock', { profileId: this.data.profileId });
    },
    onCopy(e) {
      this.triggerEvent('copy', e.detail || {});
    },
    onReport() {
      this.triggerEvent('report', { profileId: this.data.profileId });
    },
  },
});
