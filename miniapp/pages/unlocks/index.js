'use strict';

/**
 * P-05 缘签簿（2 态：有记录 / 空）
 *
 * 依据：说明书 §4 P-05、§5.3（30 天内免费复看）；线稿说明 §六。
 * 边界：列表只保留掩码，不缓存明文、不落本地存储。
 */

const { PAGES, ROUTES, COPY, LIMITS } = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

Page({
  data: {
    list: [],
    empty: true,
    remain: 0,
    remainText: '今日剩余缘签',
    resetText: '24:00 重置',
    emptyTitle: '还没有解过签',
    emptyDesc: '去「取一个」看看谁在等你',
    fetchBtnText: COPY.BTN_FETCH,
    disclaimer: COPY.HOME_DISCLAIMER,
  },

  onShow() {
    getApp().reportPageView(PAGES.UNLOCKS);
    this.load();
  },

  async load() {
    const res = await callActive('listUnlocked', {});
    const data = (res.ok && res.data) || {};
    const raw = data.list || data.items || [];
    const quota = data.quota || {};
    const now = Date.now();

    const list = raw.map((it) => {
      const item = it || {};
      const expired = item.expired === true || item.available === false
        || item.state === 'expired' || item.offline === true;
      const freeRevisit = !expired && item.unlockedAt
        && (now - item.unlockedAt) < LIMITS.FREE_REVISIT_MS;
      return {
        profileId: item.profileId || '',
        gender: item.gender,
        masked: item.maskedContact || item.masked || '',
        contactType: item.contactType,
        ticketId: item.ticketId || '',
        mode: expired ? 'expired' : 'unlocked',
        unlockedAtText: formatTime(item.unlockedAt),
        freeRevisit,
        freeChip: freeRevisit ? '30 天内免重复消耗' : '',
      };
    });

    this.setData({
      list,
      empty: list.length === 0,
      remain: typeof quota.remainUnlock === 'number' ? quota.remainUnlock : 0,
    });
  },

  goFetch() {
    // 取签流程已内联于首页，此处仅回到首页发起取签
    tt.reLaunch({ url: ROUTES[PAGES.HOME] });
  },

  goBack() {
    tt.navigateBack({ delta: 1 });
  },
});
