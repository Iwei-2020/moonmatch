'use strict';

/**
 * P-04 获取结果卡（核心页）
 *
 * 依据：说明书 §2.2（流程 B 状态机）、§5（广告策略与频次）、§6.4；线稿说明 §五（6 态 + 达上限）。
 * 状态：IDLE / MATCHING / EMPTY / CARD_LOCKED / CARD_UNLOCKED / DEAD / LIMIT
 * 铁律：出卡不触发广告；仅在用户主动点击「看广告解锁」后触发。
 */

const { PAGES, ROUTES, COPY, EVENTS, ERROR_CODES, LIMITS } = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');
const { track } = require('../../core/tracker.js');
const { createAd } = require('../../core/ad.js');

Page({
  data: {
    state: 'idle',
    registered: false,
    card: null,
    cardMode: 'locked',
    ticketId: '',
    remain: 0,
    dailyLimit: LIMITS.DAILY_UNLOCK,
    fetchDisabled: false,
    popupVisible: false,
    popupState: 'notice',
    popupFailure: '',

    matchingText: COPY.MATCHING,
    emptyText: COPY.POOL_EMPTY,
    limitText: COPY.DAILY_LIMIT,
    fetchBtnText: COPY.BTN_FETCH,
    unlocksEntry: '我获取过的',
    poolNote: '随机匹配 1 份你未获取过的资料，年龄相近优先；出卡免费，解锁才需看广告',
    disclaimer: COPY.HOME_DISCLAIMER,
  },

  onShow() {
    getApp().reportPageView(PAGES.FETCH);
    this.ensureRegistered();
  },

  toast(title) {
    tt.showToast({ title, icon: 'none' });
  },

  async ensureRegistered() {
    const res = await callActive('getProfile', {});
    if (res.ok) {
      const p = (res.data && (res.data.profile || res.data)) || {};
      const remain = typeof p.remainUnlock === 'number' ? p.remainUnlock : (p.remain || 0);
      this.setData({ registered: true, remain });
      return true;
    }
    if (res.code === ERROR_CODES.NOT_REGISTERED) {
      tt.showToast({ title: COPY.NOT_REGISTERED_TIP, icon: 'none' });
      tt.redirectTo({ url: ROUTES[PAGES.REGISTER] });
      return false;
    }
    // 无云能力降级：保留骨架，禁用获取按钮，绝不白屏
    this.setData({ registered: false, fetchDisabled: true });
    return false;
  },

  async onTapFetch() {
    if (this.data.state === 'matching') return;
    if (!this.data.registered) {
      this.toast(COPY.NOT_REGISTERED_TIP);
      tt.navigateTo({ url: ROUTES[PAGES.REGISTER] });
      return;
    }
    if (this.data.fetchDisabled) {
      this.toast(COPY.DAILY_LIMIT);
      return;
    }

    track(EVENTS.MATCH_REQUEST, { registered: true, daily_matched: this.data.dailyMatched || 0 });
    this.setData({ state: 'matching' });

    const res = await callActive('getMatch', {});

    if (res.ok && res.data) {
      const card = res.data.card || res.data;
      const relaxed = typeof res.data.relaxationLevel === 'number'
        ? res.data.relaxationLevel
        : (res.data.relaxation_level || 0);
      track(EVENTS.MATCH_RESULT, { result: 'ok', relaxation_level: relaxed });
      this.showCard(card);
      return;
    }

    if (res.code === ERROR_CODES.POOL_EMPTY) {
      track(EVENTS.MATCH_RESULT, { result: 'empty', relaxation_level: 0 });
      this.setData({ state: 'empty' });
      return;
    }
    if (res.code === ERROR_CODES.MATCH_COOLDOWN) {
      this.setData({ state: 'idle' });
      this.toast(COPY.MATCH_COOLDOWN);
      return;
    }
    if (res.code === ERROR_CODES.DAILY_MATCH_LIMIT) {
      track(EVENTS.DAILY_LIMIT_HIT, { limit_type: 'match' });
      this.setData({ state: 'limit', fetchDisabled: true });
      this.toast(COPY.DAILY_LIMIT);
      return;
    }
    if (res.code === ERROR_CODES.NOT_REGISTERED) {
      this.setData({ state: 'idle' });
      this.toast(COPY.NOT_REGISTERED_TIP);
      tt.navigateTo({ url: ROUTES[PAGES.REGISTER] });
      return;
    }
    this.setData({ state: 'idle' });
    this.toast('获取失败，请稍后重试');
  },

  showCard(card) {
    const c = card || {};
    const mode = c.unlocked ? 'unlocked' : (c.closed || c.offline ? 'expired' : 'locked');
    const state = mode === 'unlocked' ? 'unlocked' : (mode === 'expired' ? 'expired' : 'locked');
    this.setData({
      state,
      card: c,
      cardMode: mode,
      ticketId: c.ticketId || '',
    });
    track(EVENTS.MATCH_CARD_VIEW, { profile_id: c.profileId || '', seen: !!(c.seen || c.revisited) });
  },

  /* ---------------- 广告解锁链路 ---------------- */

  onUnlock(e) {
    const profileId = (e && e.detail && e.detail.profileId)
      || (this.data.card && this.data.card.profileId)
      || '';
    this.pendingProfileId = profileId;
    track(EVENTS.AD_REWARD_REQUEST, { profile_id: profileId, remain: this.data.remain });
    this.setData({ popupVisible: true, popupState: 'notice', popupFailure: '' });
  },

  onPopupConfirm() {
    this.startAd();
  },

  onPopupRetry() {
    this.startAd();
  },

  onPopupClose() {
    this.setData({ popupVisible: false, popupState: 'notice', popupFailure: '' });
  },

  async startAd() {
    const profileId = this.pendingProfileId || (this.data.card && this.data.card.profileId) || '';
    this.setData({ popupState: 'loading', popupFailure: '' });

    const task = await callActive('createAdTask', { profileId });
    if (!task.ok) {
      this.failUnlock(task.code, 'load');
      return;
    }

    const d = task.data || {};
    this.taskToken = d.taskToken || d.token || '';
    this.playedMs = 0;

    // 豁免通道：连续失败 3 次后当日免广告直接发券（说明书 §5.3），服务端不校验完整观看
    if (d.exempt === true) {
      this.claim();
      return;
    }

    const adUnitIds = d.adUnitIds || d.adUnitId || [];

    const ad = createAd({
      host: this,
      adUnitIds,
      now: Date.now(),
      onEvent: (evt) => this.onAdEvent(evt),
    });

    if (!ad || !ad.supported) {
      this.reportAdFailure('load');
      this.failUnlock(ERROR_CODES.SERVER_ERROR, 'load');
      return;
    }

    this.ad = ad;
    ad.load();
    ad.show();
    this.setData({ popupState: 'playing' });
    track(EVENTS.AD_REWARD_SHOW, {
      ad_unit_id: (adUnitIds && adUnitIds.length) ? adUnitIds[0] : adUnitIds,
    });
  },

  onAdEvent(evt) {
    const e = evt || {};
    const type = e.type || e.event;

    if (type === 'error') {
      this.reportAdFailure(e.stage || 'show');
      this.failUnlock(e.code, e.stage || 'show');
      return;
    }

    if (type === 'close') {
      const isEndReached = !!e.isEndReached;
      this.playedMs = e.playedMs || 0;
      track(EVENTS.AD_REWARD_CLOSE, { isEndReached, played_ms: this.playedMs });
      if (isEndReached) {
        this.claim();
      } else {
        this.setData({ popupVisible: false, popupState: 'notice' });
        this.toast('未完整观看，未发放、不扣次数');
      }
    }
  },

  async claim() {
    this.setData({ popupState: 'granting' });

    const res = await callActive('claimTicket', {
      taskToken: this.taskToken,
      adFinished: true,
      playedMs: this.playedMs || 0,
    });

    if (!res.ok) {
      this.failUnlock(res.code, 'claim');
      return;
    }

    const d = res.data || {};
    const ticketId = d.ticketId || '';
    const profileId = this.pendingProfileId || (this.data.card && this.data.card.profileId) || '';

    track(EVENTS.AD_REWARD_COMPLETE, { ticket_id: ticketId, profile_id: profileId });
    track(EVENTS.CONTACT_UNLOCK, { profile_id: profileId, source: 'ad_reward' });

    const card = Object.assign({}, this.data.card, { ticketId });
    this.setData({
      popupVisible: false,
      popupState: 'notice',
      state: 'unlocked',
      cardMode: 'unlocked',
      card,
      ticketId,
    });
    this.toast('已解锁，可复制联系方式');
  },

  /** 向服务端上报一次广告失败：连续 3 次触发当日豁免通道（说明书 §5.3）。令牌一次性，上报后清空避免重复计入。 */
  reportAdFailure(stage) {
    if (!this.taskToken) return;
    callActive('claimTicket', { taskToken: this.taskToken, adFinished: false, playedMs: this.playedMs || 0, stage: stage || '' });
    this.taskToken = '';
  },

  failUnlock(code, stage) {
    if (stage) {
      track(EVENTS.AD_REWARD_ERROR, { stage, error_code: code || 0 });
    }
    let text = COPY.AD_FAILED;
    if (code === ERROR_CODES.DAILY_UNLOCK_LIMIT) {
      text = COPY.DAILY_LIMIT;
      track(EVENTS.DAILY_LIMIT_HIT, { limit_type: 'unlock' });
      this.setData({ fetchDisabled: true });
    } else if (code === ERROR_CODES.PROFILE_OFFLINE || code === ERROR_CODES.TICKET_EXPIRED || code === ERROR_CODES.PROFILE_NOT_FOUND) {
      text = COPY.EXPIRED;
    } else if (code === ERROR_CODES.MATCH_COOLDOWN || code === ERROR_CODES.AD_COOLDOWN) {
      text = COPY.MATCH_COOLDOWN;
    }
    this.setData({ popupState: 'failed', popupFailure: text });
  },

  /* ---------------- 二级入口 ---------------- */

  onCardReport(e) {
    const profileId = (e && e.detail && e.detail.profileId)
      || (this.data.card && this.data.card.profileId)
      || '';
    tt.navigateTo({ url: ROUTES[PAGES.REPORT] + '?profileId=' + profileId });
  },

  goUnlocks() {
    tt.navigateTo({ url: ROUTES[PAGES.UNLOCKS] });
  },

  goHome() {
    tt.navigateBack({ delta: 1 });
  },
});
