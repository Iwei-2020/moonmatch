'use strict';

/**
 * P-03 我的档案（4 态：待审核 / 已留 / 已驳回 / 已下架）
 *
 * 依据：说明书 §2.1 A2–A8、§4 P-03；线稿说明 §四。
 * 边界：不展示档案编号；不展示任何缘签明文（本页仅渲染掩码，不提供复制入口）。
 */

const { PAGES, ROUTES, COPY, PROFILE_STATUS, CONTACT_TYPES, EVENTS } = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');
const { track } = require('../../core/tracker.js');

const GENDER_TEXT = { male: '男', female: '女', m: '男', f: '女', 男: '男', 女: '女' };

const SUMMARY = {
  pending: '机审队列处理中，审核期间不进入匹配池',
  active: '已进入匹配池',
  rejected: '',
  offline: '档案已下架，不再展示给其他用户，也不占用匹配池',
};

Page({
  data: {
    state: 'pending',
    status: PROFILE_STATUS.PENDING,
    title: '',
    masked: '',
    contactType: CONTACT_TYPES.PHONE,
    summary: '',
    rejectReason: '',
    rejectedPrefix: COPY.REJECTED_PREFIX,
    changeNotice: COPY.CHANGE_CONTACT_NOTICE,
    disclaimer: COPY.HOME_DISCLAIMER,
    mainActionText: '编辑',
    offlineActionText: '下架',
    fetchedCount: 0,
  },

  onShow() {
    getApp().reportPageView(PAGES.PROFILE);
    this.loadProfile();
  },

  async loadProfile() {
    const res = await callActive('getProfile', {});
    if (!res.ok || !res.data) {
      // 无云能力降级：保持待审核态骨架，不白屏
      this.setData({ state: 'pending', summary: SUMMARY.pending });
      return;
    }
    this.applyProfile(res.data.profile || res.data);
  },

  applyProfile(profile) {
    const p = profile || {};
    const status = p.status || PROFILE_STATUS.PENDING;

    let state = 'pending';
    if (status === PROFILE_STATUS.ACTIVE) state = 'active';
    else if (status === PROFILE_STATUS.REJECTED) state = 'rejected';
    else if (status === PROFILE_STATUS.OFFLINE) state = 'offline';

    const gender = GENDER_TEXT[p.gender] || '';

    this.setData({
      state,
      status,
      title: gender,
      masked: p.maskedContact || p.masked || '',
      contactType: p.contactType || CONTACT_TYPES.PHONE,
      summary: SUMMARY[state],
      rejectReason: p.rejectReason || '',
      mainActionText: state === 'rejected' ? '修改重提' : '编辑',
      offlineActionText: state === 'offline' ? '重新上架' : '下架',
      fetchedCount: typeof p.fetchedCount === 'number' ? p.fetchedCount : 0,
    });
  },

  onEdit() {
    track(EVENTS.PROFILE_EDIT, { field: 'all' });
    tt.navigateTo({ url: ROUTES[PAGES.REGISTER] + '?mode=edit' });
  },

  async onToggleOffline() {
    const action = this.data.state === 'offline' ? 'online' : 'offline';
    const res = await callActive('offlineProfile', { action });
    if (res.ok) {
      tt.showToast({ title: action === 'offline' ? '已下架' : '已重新上架', icon: 'none' });
      this.loadProfile();
      return;
    }
    tt.showToast({ title: '操作失败，请稍后重试', icon: 'none' });
  },

  goReport() {
    tt.navigateTo({ url: ROUTES[PAGES.REPORT] });
  },
});
