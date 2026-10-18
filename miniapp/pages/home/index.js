'use strict';

/**
 * P-01 首页（4 态：未登记 / 已登记待审 / 已登记 / 已驳回）
 *
 * 依据：说明书 §2.1（档案状态）、§4（页面清单与入口可达性）；线稿说明 §二。
 * 硬边界：全站仅两个业务入口——「登记」与「获取」；免责提示常驻不折叠。
 */

const { PAGES, ROUTES, COPY, EVENTS, PROFILE_STATUS, LIMITS } = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');
const { track } = require('../../core/tracker.js');

const SUMMARY = {
  unregistered: '尚未登记 · 登记后即可获取他人联系方式',
  pending: '资料审核中，通过后自动进入匹配池',
  active: '已登记 · 已进入匹配池',
  rejected: '资料未通过审核，修改后可重新提交',
};

const MAIN_BTN = {
  unregistered: COPY.BTN_REGISTER,
  pending: '查看我的资料',
  active: '查看我的资料',
  rejected: '修改重提',
};

const FETCH_TIP = {
  unregistered: COPY.NOT_REGISTERED_TIP,
  pending: '审核通过后才可获取他人联系方式',
  rejected: '修改并通过审核后才可获取他人联系方式',
  active: '',
};

Page({
  data: {
    state: 'unregistered',
    summary: SUMMARY.unregistered,
    badgeStatus: PROFILE_STATUS.DRAFT,
    remain: 0,
    dailyLimit: LIMITS.DAILY_UNLOCK,
    mainBtnText: COPY.BTN_REGISTER,
    registerBtnText: COPY.BTN_REGISTER,
    fetchBtnText: COPY.BTN_FETCH,
    fetchDisabled: true,
    fetchTip: COPY.NOT_REGISTERED_TIP,
    tagline: COPY.HOME_TAGLINE,
    disclaimer: COPY.HOME_DISCLAIMER,
  },

  onShow() {
    getApp().reportPageView(PAGES.HOME);
    this.loadProfile();
  },

  async loadProfile() {
    const res = await callActive('getProfile', {});
    if (res.ok && res.data) {
      this.applyProfile(res.data.profile || res.data);
      return;
    }
    if (res.code === undefined) {
      // 无云能力降级：保持未登记态，不阻塞渲染
      this.applyProfile(null);
      return;
    }
    this.applyProfile(null);
  },

  applyProfile(profile) {
    const p = profile || {};
    const status = p.status || PROFILE_STATUS.DRAFT;
    let state = 'unregistered';
    if (status === PROFILE_STATUS.PENDING) state = 'pending';
    else if (status === PROFILE_STATUS.ACTIVE) state = 'active';
    else if (status === PROFILE_STATUS.REJECTED || status === PROFILE_STATUS.OFFLINE) state = 'rejected';

    let remain = 0;
    if (typeof p.remainUnlock === 'number') remain = p.remainUnlock;
    else if (typeof p.remain === 'number') remain = p.remain;

    this.setData({
      state,
      summary: SUMMARY[state],
      badgeStatus: status,
      remain: state === 'active' || state === 'pending' ? remain : 0,
      mainBtnText: MAIN_BTN[state],
      fetchDisabled: state !== 'active',
      fetchTip: FETCH_TIP[state],
    });
  },

  onTapRegister() {
    track(EVENTS.HOME_ENTRY_CLICK, { entry: 'register' });
    const url = this.data.state === 'unregistered' ? ROUTES[PAGES.REGISTER] : ROUTES[PAGES.PROFILE];
    tt.navigateTo({ url });
  },

  onTapFetch() {
    track(EVENTS.HOME_ENTRY_CLICK, { entry: 'fetch' });
    if (this.data.state === 'active') {
      tt.navigateTo({ url: ROUTES[PAGES.FETCH] });
      return;
    }
    tt.showToast({ title: this.data.fetchTip || COPY.NOT_REGISTERED_TIP, icon: 'none' });
    if (this.data.state === 'unregistered') {
      tt.navigateTo({ url: ROUTES[PAGES.REGISTER] });
    }
  },

  goLegal() {
    tt.navigateTo({ url: ROUTES[PAGES.LEGAL] });
  },
});
