/**
 * 学习页：闪卡翻转 + 三档评分（手势 / 按钮）+ 今日到期队列 + 考前倒计时。
 * 逻辑与 Web 纯净版一致：到期复习优先、每日配额、翻面后才能评分。
 */
const C = require('../../libs/common.js');
const Store = C.Store;
const SRS = C.SRS;

// 考试日期：软考高级系统架构设计师（月份从 0 计，9 = 10 月）
var EXAM_DATE = new Date(2026, 9, 24, 9, 0, 0);

Page({
  data: {
    theme: 'dark',
    cd: { mode: 'normal', days: '--', unit: '天', time: '', label: '距软考 · 系统架构设计师', date: '10月24日 09:00 开考' },
    card: null,
    flipped: false,
    rateDisabled: true,
    chips: [],
    idx: 0,
    total: 0,
    pct: 0,
    empty: false,
    emptyTitle: '',
    emptyText: '',
    done: false,
    summary: { total: 0, newCount: 0, okCount: 0, acc: '0%' },
    side: { n: 0, r: 0, streak: 0 },
    modal: { visible: false, term: null }
  },

  session: { items: [], idx: 0, newCount: 0, okCount: 0, total: 0 },
  touch: null,
  cdTimer: null,

  onLoad: function () {
    this.startSession();
    this.renderCd();
    var self = this;
    this.cdTimer = setInterval(function () { self.renderCd(); }, 1000);
  },

  onShow: function () {
    C.syncTheme(this);
    this.updateSide();
  },

  onUnload: function () {
    if (this.cdTimer) { clearInterval(this.cdTimer); this.cdTimer = null; }
  },

  /* ---------------- 倒计时 ---------------- */
  renderCd: function () {
    var diff = EXAM_DATE.getTime() - Date.now();
    var cd = { mode: 'normal', days: '', unit: '', time: '', label: '距软考 · 系统架构设计师', date: '10月24日 09:00 开考' };
    function pad2(n) { return (n < 10 ? '0' : '') + n; }

    if (diff <= 0) {
      cd.mode = 'now';
      cd.days = '开考';
      cd.unit = '';
      cd.time = '';
      cd.label = '软考 · 系统架构设计师 进行中';
      cd.date = '稳住，你能行！';
    } else {
      var s = Math.floor(diff / 1000);
      var days = Math.floor(s / 86400); s -= days * 86400;
      var h = Math.floor(s / 3600); s -= h * 3600;
      var m = Math.floor(s / 60); var sec = s - m * 60;
      if (days > 0) { cd.days = String(days); cd.unit = '天'; cd.time = pad2(h) + ':' + pad2(m) + ':' + pad2(sec); }
      else { cd.days = String(h); cd.unit = '时'; cd.time = pad2(m) + ':' + pad2(sec); }
      cd.mode = days < 7 ? 'urgent' : (days < 15 ? 'soon' : 'normal');
    }
    this.setData({ cd: cd });
  },

  /* ---------------- 学习会话 ---------------- */
  startSession: function (extra) {
    var q = C.buildQueue(extra || 0);
    this.session.items = q.items;
    this.session.idx = 0;
    this.session.newCount = 0;
    this.session.okCount = 0;
    this.session.total = q.items.length;

    if (!q.items.length) {
      this.setData({
        empty: true, done: false, card: null,
        emptyTitle: (q.dueTotal || q.newTotal) ? '今天的配额用完了' : '今天的任务完成了',
        emptyText: '待复习 ' + q.dueTotal + ' 个，未学习 ' + q.newTotal + ' 个。可以去词库预习，或临时加练。',
        pct: 100, idx: 0, total: 0
      });
      return;
    }
    this.setData({ empty: false, done: false });
    this.renderCard();
  },

  renderCard: function () {
    var i = this.session.idx;
    if (i >= this.session.items.length) { this.showSummary(); return; }
    var item = this.session.items[i];
    var t = C.byId[item.id];
    var c = Store.raw(item.id);
    var st = C.statusLabel(item.id);

    this.setData({
      card: {
        cat: t.c, lv: C.levelText(t.lv), t: t.t, en: t.en || '', ja: t.ja || '',
        bTerm: t.t + (t.en ? '　' + t.en : ''), bJa: t.ja || '', def: t.d || '',
        points: t.p || [], eg: t.e || '—',
        rel: (t.r || []).filter(function (r) { return C.byId[r]; })
      },
      flipped: false,
      rateDisabled: true,
      idx: i,
      total: this.session.total,
      pct: Math.round(i / this.session.total * 100),
      chips: [
        { text: item.kind === 'new' ? '新学' : '复习', on: true },
        { text: st.text },
        { text: c ? SRS.dueText(c) : '未学习' }
      ]
    });
    this.updateSide();
  },

  flip: function () {
    var flipped = !this.data.flipped;
    this.setData({ flipped: flipped, rateDisabled: !flipped });
    wx.vibrateShort({ type: 'light' }).catch(function () {});
  },

  rate: function (r) {
    if (this.data.rateDisabled) return;
    var item = this.session.items[this.session.idx];
    if (!item) return;
    wx.vibrateShort({ type: r === 2 ? 'light' : 'medium' }).catch(function () {});
    var c = Store.card(item.id);
    SRS.schedule(c, r);
    Store.record(item.kind, r === 2);
    if (r === 2) this.session.okCount++;
    if (item.kind === 'new') this.session.newCount++;
    this.session.idx++;
    this.renderCard();
  },

  showSummary: function () {
    var total = this.session.total;
    this.setData({
      done: true, card: null, empty: false, pct: 100,
      idx: total, total: total,
      summary: {
        total: total,
        newCount: this.session.newCount,
        okCount: this.session.okCount,
        acc: total ? Math.round(this.session.okCount / total * 100) + '%' : '0%'
      }
    });
    this.updateSide();
  },

  updateSide: function () {
    var d = Store.dailyCounts();
    this.setData({ side: { n: d.n, r: d.r, streak: d.streak } });
  },

  /* ---------------- 交互 ---------------- */
  onRate0: function () { this.rate(0); },
  onRate1: function () { this.rate(1); },
  onRate2: function () { this.rate(2); },
  onStartToday: function () { this.startSession(); },
  onExtra: function () { this.startSession(20); },
  onAgain: function () { this.startSession(); },
  onRelTap: function (e) { this.openDetail(e.currentTarget.dataset.goto); },

  // 手势：右滑认识 / 上滑模糊 / 左滑不认识；轻触翻卡；点相关术语看详情
  onCardStart: function (e) {
    this.touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
  },
  onCardEnd: function (e) {
    var st = this.touch;
    this.touch = null;
    if (!st) return;
    var t = e.changedTouches[0];
    var dx = t.clientX - st.x, dy = t.clientY - st.y;
    var target = e.target;

    if (target && target.dataset && target.dataset.goto) {
      this.openDetail(target.dataset.goto);
      return;
    }
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      this.rate(dx > 0 ? 2 : 0);
      return;
    }
    if (dy < -60 && Math.abs(dy) > Math.abs(dx)) {
      this.rate(1);
      return;
    }
    if (Date.now() - st.t < 600 && Math.abs(dx) < 10 && Math.abs(dy) < 10) this.flip();
  },

  /* ---------------- 详情弹窗 ---------------- */
  openDetail: function (name) {
    this.setData({ modal: { visible: true, term: C.byId[name] || null } });
  },
  onModalClose: function () { this.setData({ 'modal.visible': false }); },
  onModalGoto: function (e) {
    this.setData({ 'modal.term': C.byId[e.detail.name] || null });
  }
});
