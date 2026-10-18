'use strict';

/**
 * unlock-popup · 广告解锁弹层
 *
 * 依据：说明书 §4「关键交互组件」、§5.2（触发铁律）；线稿说明 §9.1（5 态）。
 * 文案逐字取 COPY：UNLOCK_NOTICE / AD_PLAYING_TIP / AD_GRANTING / AD_FAILED。
 *
 * properties: visible / state(notice|loading|playing|granting|failed) / failureText
 * events: confirm / retry / close（均由页面驱动，组件不直接调云函数或广告 SDK）
 */

const { COPY } = require('../../shared/client-constants.js');

const STEP_OF = { notice: 0, loading: 1, playing: 2, granting: 3, failed: 4 };

Component({
  properties: {
    visible: { type: Boolean, value: false },
    state: { type: String, value: 'notice' },
    failureText: { type: String, value: '' },
  },

  data: {
    dots: [],
    noticeTitle: '解签须知',
    noticeText: COPY.UNLOCK_NOTICE,
    playingTip: COPY.AD_PLAYING_TIP,
    grantingTitle: '正在解签',
    grantingText: COPY.AD_GRANTING,
    failTitle: COPY.AD_FAILED,
    failText: COPY.AD_FAILED,
    loadingTitle: '广告加载中',
    loadingTip: '正在拉取激励视频素材，请稍候…',
    limitText: COPY.DAILY_LIMIT,
    confirmText: COPY.BTN_UNLOCK,
    cancelText: '暂不解签',
    retryText: '重试',
  },

  observers: {
    'state, failureText': function (state, failureText) {
      const step = STEP_OF[state] === undefined ? 0 : STEP_OF[state];
      const dots = [];
      for (let i = 0; i < 5; i += 1) {
        dots.push({ cls: i <= step ? 'up__dot up__dot--on' : 'up__dot' });
      }
      this.setData({ dots, failText: failureText || COPY.AD_FAILED });
    },
  },

  methods: {
    onConfirm() {
      if (this.data.state !== 'notice') return;
      this.triggerEvent('confirm');
    },
    onRetry() {
      this.triggerEvent('retry');
    },
    onClose() {
      this.triggerEvent('close');
    },
    noop() {},
  },
});
