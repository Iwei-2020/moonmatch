'use strict';

/**
 * P-01 首页（4 态：未留缘签 / 已留待审 / 已留 / 已驳回）
 *
 * 依据：说明书 §2.1（档案状态）、§4（页面清单与入口可达性）；线稿说明 §二。
 * 硬边界：全站仅两个业务入口——「取一个」（取签）与「拿一个」（留缘签）；免责提示常驻不折叠。
 * 产品口径：取签不再以先留缘签为前提，主按钮「取一个」恒可点。
 */

const { PAGES, ROUTES, COPY, EVENTS, PROFILE_STATUS, LIMITS } = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');
const { track } = require('../../core/tracker.js');

const SUMMARY = {
  unregistered: '签筒里还没有你的缘签 · 先留一个',
  pending: '你的缘签正在核验，通过后即可被他人取走',
  active: '你的缘签已在签筒里，等有缘人来取',
  rejected: '缘签未通过核验，改一改再放回签筒',
};

/** 次要入口文案：留缘签 / 查看我的缘签 / 修改重提 */
const KEEP_BTN = {
  unregistered: COPY.BTN_REGISTER,
  pending: '查看我的缘签',
  active: '查看我的缘签',
  rejected: '修改重提',
};

Page({
  data: {
    state: 'unregistered',
    summary: SUMMARY.unregistered,
    badgeStatus: PROFILE_STATUS.DRAFT,
    remain: 0,
    dailyLimit: LIMITS.DAILY_UNLOCK,
    takeBtnText: COPY.BTN_FETCH,
    keepBtnText: COPY.BTN_REGISTER,
    tagline: COPY.HOME_TAGLINE,
    trio: [
      { key: 'fate', label: COPY.HOME_FATE_LABEL, text: COPY.HOME_FATE_TEXT },
      { key: 'luck', label: COPY.HOME_LUCK_LABEL, text: COPY.HOME_LUCK_TEXT },
      { key: 'meet', label: COPY.HOME_MEET_LABEL, text: COPY.HOME_MEET_TEXT },
    ],
    disclaimer: COPY.HOME_DISCLAIMER,
  },

  onShow() {
    getApp().reportPageView(PAGES.HOME);
    this.loadProfile();
  },

  async loadProfile() {
    const res = await callActive('getProfile', {});
    const data = (res.ok && res.data) || {};
    // 无云能力降级：profile / quota 均为空，保持未留缘签态，不阻塞渲染
    this.applyProfile(data.profile || null, data.quota || null);
  },

  applyProfile(profile, quota) {
    const p = profile || {};
    const status = p.status || PROFILE_STATUS.DRAFT;
    let state = 'unregistered';
    if (status === PROFILE_STATUS.PENDING) state = 'pending';
    else if (status === PROFILE_STATUS.ACTIVE) state = 'active';
    else if (status === PROFILE_STATUS.REJECTED || status === PROFILE_STATUS.OFFLINE) state = 'rejected';

    // 剩余额度取自服务端配额快照（服务端为准）；取签不再要求先留缘签，故各态一并展示
    const q = quota || {};
    const remain = typeof q.remainUnlock === 'number' ? q.remainUnlock : 0;

    this.setData({
      state,
      summary: SUMMARY[state],
      badgeStatus: status,
      remain,
      keepBtnText: KEEP_BTN[state],
    });
  },

  /** 取一个：恒可点，直接进取签页（不再要求先留缘签） */
  onTapTake() {
    track(EVENTS.HOME_ENTRY_CLICK, { entry: 'fetch' });
    tt.navigateTo({ url: ROUTES[PAGES.FETCH] });
  },

  /** 拿一个：未留缘签去登记页，已留去我的缘签 */
  onTapKeep() {
    track(EVENTS.HOME_ENTRY_CLICK, { entry: 'register' });
    const url = this.data.state === 'unregistered' ? ROUTES[PAGES.REGISTER] : ROUTES[PAGES.PROFILE];
    tt.navigateTo({ url });
  },

  goLegal() {
    tt.navigateTo({ url: ROUTES[PAGES.LEGAL] });
  },
});
