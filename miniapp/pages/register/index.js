'use strict';

/**
 * P-02 登记（半屏表单，3 字段：性别 / 年龄 / 联系方式）
 *
 * 依据：说明书 §2.1（字段清单与规则）、§6.4（类型白名单）；线稿说明 §三（3 态：空表单 / 已填写 / 提交中）。
 * 铁律：PROFILE_SUBMIT 埋点不得上报联系方式内容；联系明文的输入与回显一律掩码处理。
 */

const { PAGES, ROUTES, COPY, EVENTS, CONTACT_TYPES, LIMITS, ERROR_CODES } = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');
const { track } = require('../../core/tracker.js');
const { maskContact } = require('../../core/mask.js');

const FAIL_TEXT = {
  [ERROR_CODES.DUPLICATE_CONTACT]: '该联系方式已被登记',
  [ERROR_CODES.INVALID_PARAM]: '请检查填写的资料',
  [ERROR_CODES.RISK_BLOCKED]: '当前操作受限，请稍后再试',
  [ERROR_CODES.SERVER_ERROR]: '提交失败，请稍后重试',
};

Page({
  data: {
    gender: '',
    genderOptions: [
      { value: 'male', label: '男' },
      { value: 'female', label: '女' },
    ],
    age: '',
    ageMin: LIMITS.AGE_MIN,
    ageMax: LIMITS.AGE_MAX,
    contactType: CONTACT_TYPES.PHONE,
    contactTypeOptions: [
      { value: CONTACT_TYPES.PHONE, label: '手机号' },
      { value: CONTACT_TYPES.DOUYIN, label: '抖音号' },
    ],
    contact: '',
    contactMasked: '',
    agreed: false,
    submitting: false,
    hint: COPY.REGISTER_HINT,
    title: '登记我的资料',
    agreeText: '我已阅读并同意《用户协议》《隐私政策》',
    submitText: '提交',
    submittingText: '提交中…',
  },

  onLoad() {
    getApp().reportPageView(PAGES.REGISTER);
    track(EVENTS.PROFILE_FORM_START, {});
  },

  onGender(e) {
    this.setData({ gender: e.currentTarget.dataset.value });
  },

  onAge(e) {
    const age = String(e.detail.value || '').replace(/\D/g, '');
    this.setData({ age });
  },

  onContactType(e) {
    const contactType = e.currentTarget.dataset.value;
    this.setData({ contactType, contact: '', contactMasked: '' });
  },

  onContact(e) {
    // 明文仅用于提交；视图层只出现掩码回显
    const contact = String(e.detail.value || '');
    this.setData({
      contact,
      contactMasked: contact ? maskContact(this.data.contactType, contact) : '',
    });
  },

  onAgree(e) {
    const values = e.detail.value || [];
    this.setData({ agreed: values.indexOf('agree') >= 0 });
  },

  goLegal() {
    tt.navigateTo({ url: ROUTES[PAGES.LEGAL] });
  },

  toast(title) {
    tt.showToast({ title, icon: 'none' });
  },

  async onSubmit() {
    if (this.data.submitting) return;

    const gender = this.data.gender;
    const age = parseInt(this.data.age, 10);
    const contactType = this.data.contactType;
    const contact = this.data.contact;

    if (!gender) return this.toast('请选择性别');
    if (!age || age < LIMITS.AGE_MIN || age > LIMITS.AGE_MAX) {
      return this.toast('年龄需在 ' + LIMITS.AGE_MIN + '–' + LIMITS.AGE_MAX + ' 岁之间');
    }
    if (!contact) return this.toast('请填写联系方式');
    if (contactType === CONTACT_TYPES.PHONE && !/^1\d{10}$/.test(contact)) {
      return this.toast('请填写正确的手机号');
    }
    if (!this.data.agreed) return this.toast('请先阅读并同意协议');

    this.setData({ submitting: true });

    // 埋点：仅上报 性别 / 年龄 / 类型，绝不上报联系方式内容
    track(EVENTS.PROFILE_SUBMIT, { gender, age, contact_type: contactType });

    const birthYear = new Date().getFullYear() - age;
    const res = await callActive('submitProfile', { gender, birthYear, contactType, contact });

    this.setData({ submitting: false });

    if (res.ok) {
      this.toast('提交成功，等待审核');
      tt.redirectTo({ url: ROUTES[PAGES.PROFILE] });
      return;
    }
    if (res.code === ERROR_CODES.ALREADY_REGISTERED) {
      tt.redirectTo({ url: ROUTES[PAGES.PROFILE] });
      return;
    }
    this.toast(FAIL_TEXT[res.code] || '提交失败，请稍后重试');
  },
});
