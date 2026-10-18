'use strict';

/**
 * P-01 首页（4 态：未留缘签 / 已留待审 / 已留 / 已驳回）
 *
 * 依据：说明书 §2.1（档案状态）、§2.2（流程 B 状态机）、§4（页面清单与入口可达性）、§5（广告策略与频次）。
 * 硬边界：全站仅两个业务入口——「取一个」（取签）与「留一个」（留缘签）；免责提示常驻不折叠。
 * 产品口径：取签不再以先留缘签为前提，主按钮「取一个」恒可点；取签全流程内联于本页
 *   （取一个 → 选男/女签筒 → 看广告 → 展示缘签），**不跳转新页面**。
 * 铁律：出卡不触发广告；广告仅在用户「选定签筒」这一主动动作后触发；明文缘签永不进入视图层。
 */

const {
  PAGES,
  ROUTES,
  COPY,
  EVENTS,
  ERROR_CODES,
  PROFILE_STATUS,
  LIMITS,
} = require('../../shared/client-constants.js');
const { callActive } = require('../../core/cloud.js');
const { track } = require('../../core/tracker.js');
const { createAd } = require('../../core/ad.js');

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

    /* 取签浮层：pool → matching → card / empty / limit */
    overlay: false,
    stage: 'pool',
    poolTitle: COPY.POOL_TITLE,
    poolNote: COPY.POOL_NOTE,
    poolCancelText: COPY.POOL_CANCEL,
    poolOptions: [
      { value: 'male', label: COPY.POOL_MALE },
      { value: 'female', label: COPY.POOL_FEMALE },
    ],
    card: null,
    cardMode: 'locked',
    ticketId: '',
    matchingText: COPY.MATCHING,
    emptyText: COPY.POOL_EMPTY,
    limitText: COPY.DAILY_LIMIT,

    /* 广告解锁弹层（复用 unlock-popup 的 loading/playing/granting/failed 态） */
    popupVisible: false,
    popupState: 'loading',
    popupFailure: '',
  },

  onShow() {
    getApp().reportPageView(PAGES.HOME);
    this.loadProfile();
  },

  toast(title) {
    tt.showToast({ title, icon: 'none' });
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

  /** 取一个：恒可点，打开内联取签浮层（不再跳转新页面） */
  onTapTake() {
    track(EVENTS.HOME_ENTRY_CLICK, { entry: 'fetch' });
    this.pendingProfileId = '';
    this.taskToken = '';
    this.setData({
      overlay: true,
      stage: 'pool',
      card: null,
      cardMode: 'locked',
      ticketId: '',
      popupVisible: false,
      popupState: 'loading',
      popupFailure: '',
    });
  },

  /** 留一个：未留缘签去登记页，已留去我的缘签 */
  onTapKeep() {
    track(EVENTS.HOME_ENTRY_CLICK, { entry: 'register' });
    const url = this.data.state === 'unregistered' ? ROUTES[PAGES.REGISTER] : ROUTES[PAGES.PROFILE];
    tt.navigateTo({ url });
  },

  goLegal() {
    tt.navigateTo({ url: ROUTES[PAGES.LEGAL] });
  },

  /* ---------------- 取签浮层：选签筒 → 匹配 → 看广告 → 展示缘签 ---------------- */

  noop() {},

  closeOverlay() {
    if (this.data.stage === 'matching') return;
    this.setData({ overlay: false, stage: 'pool', popupVisible: false });
  },

  /** 选定男/女签筒后立即取签；命中锁定态时自动进入看广告解签 */
  onChoosePool(e) {
    const pool = (e && e.currentTarget && e.currentTarget.dataset.value) || '';
    if (pool !== 'male' && pool !== 'female') return;

    track(EVENTS.MATCH_REQUEST, { pool });
    this.setData({ stage: 'matching' });

    this.fetchByPool(pool);
  },

  async fetchByPool(pool) {
    const res = await callActive('getMatch', { pool });

    if (res.ok && res.data) {
      if (res.data.quota && typeof res.data.quota.remainUnlock === 'number') {
        this.setData({ remain: res.data.quota.remainUnlock });
      }
      if (res.data.poolEmpty) {
        track(EVENTS.MATCH_RESULT, { result: 'empty' });
        this.setData({ stage: 'empty' });
        return;
      }
      const card = res.data.card || res.data;
      track(EVENTS.MATCH_RESULT, { result: 'ok' });
      this.showCard(card);
      return;
    }

    if (res.code === ERROR_CODES.POOL_EMPTY) {
      track(EVENTS.MATCH_RESULT, { result: 'empty' });
      this.setData({ stage: 'empty' });
      return;
    }
    if (res.code === ERROR_CODES.MATCH_COOLDOWN) {
      this.setData({ stage: 'pool' });
      this.toast(COPY.MATCH_COOLDOWN);
      return;
    }
    if (res.code === ERROR_CODES.DAILY_MATCH_LIMIT) {
      track(EVENTS.DAILY_LIMIT_HIT, { limit_type: 'match' });
      this.setData({ stage: 'limit' });
      this.toast(COPY.DAILY_LIMIT);
      return;
    }
    this.setData({ stage: 'pool' });
    this.toast(COPY.FETCH_FAIL);
  },

  /** 展示缘签：已解签直接可复制；未解签自动进入看广告解签 */
  showCard(card) {
    const c = card || {};
    const mode = c.unlocked ? 'unlocked' : (c.closed || c.offline ? 'expired' : 'locked');
    this.setData({
      stage: 'card',
      card: c,
      cardMode: mode,
      ticketId: c.ticketId || '',
    });
    this.pendingProfileId = c.profileId || '';
    track(EVENTS.MATCH_CARD_VIEW, { profile_id: c.profileId || '', seen: !!(c.seen || c.revisited) });

    if (mode === 'locked') this.startAd();
    else if (mode === 'expired') this.toast(COPY.EXPIRED);
  },

  /** 「看广告解签」按钮（卡片内，用于广告关闭后的重试） */
  onUnlock(e) {
    const profileId = (e && e.detail && e.detail.profileId)
      || (this.data.card && this.data.card.profileId)
      || '';
    this.pendingProfileId = profileId;
    track(EVENTS.AD_REWARD_REQUEST, { profile_id: profileId, remain: this.data.remain });
    this.startAd();
  },

  onPopupRetry() {
    this.startAd();
  },

  onPopupClose() {
    this.setData({ popupVisible: false, popupState: 'loading', popupFailure: '' });
  },

  async startAd() {
    const profileId = this.pendingProfileId || (this.data.card && this.data.card.profileId) || '';
    if (!profileId) return;

    this.setData({ popupVisible: true, popupState: 'loading', popupFailure: '' });

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
        this.setData({ popupVisible: false, popupState: 'loading' });
        this.toast(COPY.AD_INCOMPLETE);
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
      popupState: 'loading',
      cardMode: 'unlocked',
      card,
      ticketId,
    });
    this.toast(COPY.UNLOCKED_OK);
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
    } else if (code === ERROR_CODES.PROFILE_OFFLINE || code === ERROR_CODES.TICKET_EXPIRED || code === ERROR_CODES.PROFILE_NOT_FOUND) {
      text = COPY.EXPIRED;
    } else if (code === ERROR_CODES.MATCH_COOLDOWN || code === ERROR_CODES.AD_COOLDOWN) {
      text = COPY.MATCH_COOLDOWN;
    }
    this.setData({ popupVisible: true, popupState: 'failed', popupFailure: text });
  },

  onCardReport(e) {
    const profileId = (e && e.detail && e.detail.profileId)
      || (this.data.card && this.data.card.profileId)
      || '';
    tt.navigateTo({ url: ROUTES[PAGES.REPORT] + '?profileId=' + profileId });
  },
});
