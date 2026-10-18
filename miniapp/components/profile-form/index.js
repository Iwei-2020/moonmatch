'use strict';

/**
 * profile-form · 留缘签表单（P-02 与首页「留一个」内联浮层共用）
 *
 * 依据：说明书 §2.1（字段清单与规则）、§6.4（类型白名单）。
 * 字段仅 2 项：性别（男性 / 女性）/ 缘签（单一输入，自动判别类型、掩码回显）。
 * 铁律：PROFILE_SUBMIT 埋点不得上报缘签内容；缘签输入与回显一律掩码，明文不进入视图层。
 *
 * properties: title / hint / submitText
 * events: done（提交成功或已登记，携带 { profileId, status, already }）
 */

const { COPY, EVENTS, CONTACT_TYPES, ERROR_CODES, PAGES, ROUTES } = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');
const { track } = require('../../core/tracker.js');
const { maskContact } = require('../../core/mask.js');

const FAIL_TEXT = {
  [ERROR_CODES.DUPLICATE_CONTACT]: '这份缘签已被他人拿走',
  [ERROR_CODES.INVALID_PARAM]: '请检查填写的资料',
  [ERROR_CODES.RISK_BLOCKED]: '当前操作受限，请稍后再试',
  [ERROR_CODES.SERVER_ERROR]: '提交失败，请稍后重试',
};

/**
 * 自动判别缘签类型（仅用于选择掩码与提交时的类型信号，界面上不做区分）：
 * 以 1 开头的 11 位数字视为「号码」一类，其余一律按「字母数字标识」一类处理。
 */
function detectContactType(raw) {
  const digits = String(raw === undefined || raw === null ? '' : raw).replace(/[\s\-()]/g, '');
  return /^1\d{10}$/.test(digits) ? CONTACT_TYPES.PHONE : CONTACT_TYPES.DOUYIN;
}

/** 与 detectContactType 配套的格式校验（与服务端 mask.js 的校验口径一致） */
function isValidContact(type, raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (type === CONTACT_TYPES.PHONE) return /^1[3-9]\d{9}$/.test(text.replace(/[\s\-()]/g, ''));
  return /^[a-z0-9._-]{4,24}$/i.test(text);
}

Component({
  properties: {
    title: { type: String, value: '留下你的缘签' },
    hint: { type: String, value: COPY.REGISTER_HINT },
    submitText: { type: String, value: '提交' },
  },

  data: {
    gender: '',
    genderOptions: [
      { value: 'male', label: '男' },
      { value: 'female', label: '女' },
    ],
    contact: '',
    contactMasked: '',
    agreed: false,
    submitting: false,
    agreeText: '我已阅读并同意《用户协议》《隐私政策》',
    submittingText: '提交中…',
  },

  methods: {
    onGender(e) {
      this.setData({ gender: e.currentTarget.dataset.value });
    },

    onContact(e) {
      // 明文仅用于提交；视图层只出现掩码回显
      const contact = String(e.detail.value || '');
      this.setData({
        contact,
        contactMasked: contact ? maskContact(detectContactType(contact), contact) : '',
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
      const contact = this.data.contact;
      const contactType = detectContactType(contact);

      if (!gender) return this.toast('请选择性别');
      if (!contact) return this.toast('请填入你的缘签');
      if (!isValidContact(contactType, contact)) return this.toast('请填入正确的缘签');
      if (!this.data.agreed) return this.toast('请先阅读并同意协议');

      this.setData({ submitting: true });

      // 埋点：仅上报 性别 / 类型，绝不上报缘签内容
      track(EVENTS.PROFILE_SUBMIT, { gender, contact_type: contactType });

      const res = await callActive('submitProfile', {
        agreement: this.data.agreed,
        gender,
        contactType,
        contact,
      });

      this.setData({ submitting: false });

      if (res.ok) {
        this.toast('提交成功，等待审核');
        this.triggerEvent('done', { profileId: res.data && res.data.profileId, status: res.data && res.data.status });
        return;
      }
      if (res.code === ERROR_CODES.ALREADY_REGISTERED) {
        this.triggerEvent('done', { already: true });
        return;
      }
      this.toast(FAIL_TEXT[res.code] || '提交失败，请稍后重试');
    },
  },
});
