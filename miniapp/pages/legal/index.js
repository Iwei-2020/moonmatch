'use strict';

/**
 * P-07 协议与隐私（静态）
 *
 * 依据：说明书 §8.3 / §8.4（最小必要）；线稿说明 §八。
 * 硬性：个人信息收集清单必须显式列出「收集：性别、缘签；用途：小程序内展示与匹配；不采集：通讯录、定位」；
 *      注销入口常驻。全站统一「缘签」词表，不对用户区分号码类型。
 */

const { PAGES } = require('../../shared/client-constants.js');

Page({
  data: {
    title: '协议与隐私',
    collectLine: '收集：性别、缘签；用途：小程序内展示与匹配；不采集通讯录与定位',
    collectItems: [
      { label: '收集', value: '性别、缘签' },
      { label: '用途', value: '小程序内展示与匹配' },
      { label: '不采集', value: '通讯录、定位' },
    ],
    sections: [
      {
        key: 'terms',
        title: '用户协议',
        open: false,
        body: '本小程序仅提供缘签信息展示与匹配服务，不提供婚介履约、不提供站内聊天。用户须保证所填性别、缘签真实有效；提交即视为授权平台在小程序内展示。禁止将解签所得的缘签用于骚扰、营销等用途。',
      },
      {
        key: 'privacy',
        title: '隐私政策',
        open: false,
        body: '遵循最小必要原则：仅收集性别与 1 条缘签，不含通讯录、定位等敏感权限。缘签在服务端加密存储，前端仅缓存与展示掩码。',
      },
      {
        key: 'visibility',
        title: '可见性说明',
        open: false,
        body: '档案仅以「性别 + 掩码缘签」形式展示给其他用户；完整缘签须由对方完整观看 1 条激励视频解签后才可复制，且明文不进入页面视图层、不可被批量抓取。',
      },
    ],
    cancelTitle: '注销账号',
    cancelDesc: '注销后 30 天内完成数据清除，档案一并移出匹配池',
    disclaimer: '本小程序仅提供信息展示，不对用户资料真实性作担保，请谨慎核实',
  },

  onShow() {
    getApp().reportPageView(PAGES.LEGAL);
  },

  onToggle(e) {
    const index = Number(e.currentTarget.dataset.index);
    const key = 'sections[' + index + '].open';
    this.setData({ [key]: !this.data.sections[index].open });
  },

  goBack() {
    tt.navigateBack({ delta: 1 });
  },

  onCancelAccount() {
    tt.showModal({
      title: '注销账号',
      content: '确认注销账号？注销后档案将移出匹配池，30 天内完成数据清除。',
      confirmText: '确认注销',
      cancelText: '取消',
      success: (res) => {
        if (res.confirm) {
          tt.showToast({ title: '注销申请已提交', icon: 'none' });
        }
      },
    });
  },
});
