'use strict';

/**
 * P-02 留缘签（半屏表单）
 *
 * 依据：说明书 §2.1（字段清单与规则）。本页作为「我的缘签」编辑入口的落点，
 * 表单元件由 components/profile-form 承载 —— 与首页「留一个」内联浮层共用同一份实现。
 */

const { PAGES, ROUTES, EVENTS } = require('../../shared/client-constants.js');
const { track } = require('../../core/tracker.js');

Page({
  onLoad() {
    getApp().reportPageView(PAGES.REGISTER);
    track(EVENTS.PROFILE_FORM_START, {});
  },

  /** 表单提交成功 / 已登记：回「我的缘签」 */
  onDone() {
    tt.redirectTo({ url: ROUTES[PAGES.PROFILE] });
  },
});
