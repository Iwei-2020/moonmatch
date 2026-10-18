'use strict';

/**
 * P-06 举报与反馈（2 态：未提交 / 已提交）
 *
 * 依据：说明书 §4 P-06、§3.1（虚假信息 / 骚扰 / 其他）；线稿说明 §七。
 * 入口：P-04 结果卡举报按钮（带 profileId）、P-03 反馈入口（无 profileId，按反馈处理）。
 */

const { PAGES, ROUTES, COPY, EVENTS, ERROR_CODES } = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');
const { track } = require('../../core/tracker.js');

const FAIL_TEXT = {
  [ERROR_CODES.INVALID_PARAM]: '举报内容有误，请重新选择',
  [ERROR_CODES.RISK_BLOCKED]: '当前操作受限，请稍后再试',
  [ERROR_CODES.SERVER_ERROR]: '提交失败，请稍后重试',
};

Page({
  data: {
    profileId: '',
    reasonType: 'fake',
    reasons: [
      { value: 'fake', label: '虚假信息' },
      { value: 'harass', label: '骚扰' },
      { value: 'other', label: '其他' },
    ],
    note: '',
    notePlaceholder: '可补充具体情况，便于核实…',
    submitting: false,
    submitted: false,
    doneText: COPY.REPORT_DONE,
    doneDesc: '感谢你的反馈，我们会尽快核实；核实成立的档案将被隐藏或封禁',
    secretText: '举报将被严格保密，不会向被举报对象展示你的身份',
    submitText: '提交',
    backText: '返回',
    disclaimer: COPY.HOME_DISCLAIMER,
  },

  onLoad(query) {
    const profileId = (query && query.profileId) || '';
    this.setData({ profileId: decodeURIComponent(profileId) });
  },

  onShow() {
    getApp().reportPageView(PAGES.REPORT);
  },

  onReason(e) {
    this.setData({ reasonType: e.currentTarget.dataset.value });
  },

  onNote(e) {
    this.setData({ note: String(e.detail.value || '') });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    this.setData({ submitting: true });

    track(EVENTS.REPORT_SUBMIT, {
      reason_type: this.data.reasonType,
      profile_id: this.data.profileId,
    });

    const res = await callActive('reportProfile', {
      profileId: this.data.profileId,
      reasonType: this.data.reasonType,
      note: this.data.note,
    });

    this.setData({ submitting: false });

    if (res.ok) {
      this.setData({ submitted: true });
      return;
    }
    tt.showToast({ title: FAIL_TEXT[res.code] || '提交失败，请稍后重试', icon: 'none' });
  },

  goBack() {
    tt.navigateBack({ delta: 1 });
  },
});
