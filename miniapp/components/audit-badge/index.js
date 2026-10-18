'use strict';

/**
 * audit-badge · 审核 / 状态徽标
 *
 * 依据：说明书 §4「关键交互组件」；线稿说明 §9.4（4 态：待审核 / 已通过 / 已驳回 / 已下架）。
 * 仅承载 PROFILE_STATUS 的 5 种档案状态；解签 / 失效态由 match-card 自理（语义不同，不复用本组件）。
 *
 * property: status（PROFILE_STATUS：draft | pending | active | rejected | offline）
 */

const { PROFILE_STATUS, COPY } = require('../../shared/client-constants.js');

const BADGE_TEXT = {
  [PROFILE_STATUS.DRAFT]: '草稿',
  [PROFILE_STATUS.PENDING]: COPY.AUDIT_PENDING,
  [PROFILE_STATUS.ACTIVE]: '已通过',
  [PROFILE_STATUS.REJECTED]: '已驳回',
  [PROFILE_STATUS.OFFLINE]: '已下架',
};

const BADGE_CLS = {
  [PROFILE_STATUS.PENDING]: 'mm-badge ab--pending',
  [PROFILE_STATUS.ACTIVE]: 'mm-badge mm-badge--ok',
  [PROFILE_STATUS.REJECTED]: 'mm-badge mm-badge--warn',
};

Component({
  properties: {
    status: { type: String, value: PROFILE_STATUS.DRAFT },
  },

  data: {
    text: BADGE_TEXT[PROFILE_STATUS.DRAFT],
    cls: 'mm-badge ab--lock',
  },

  observers: {
    status(status) {
      this.setData({
        text: BADGE_TEXT[status] || '',
        cls: BADGE_CLS[status] || 'mm-badge ab--lock',
      });
    },
  },
});
