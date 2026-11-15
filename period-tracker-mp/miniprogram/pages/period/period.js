/* =========================================================
 * 月记页：日历 / 记录 / 统计 三段
 * 复杂计算全部在 period-store.js 完成，这里只组装渲染数据
 * ========================================================= */

var Store = require('../../utils/period-store.js');
var Cloud = require('../../utils/period-cloud.js');

function pad2(n) { return n < 10 ? '0' + n : String(n); }

Page({
  data: {
    theme: 'light',
    tab: 'calendar',                 // calendar | stats

    // 日历
    viewYear: 0, viewMonth: 0, monthTitle: '',
    weekNames: ['一', '二', '三', '四', '五', '六', '日'],
    blanks: [], days: [],
    selectedDate: '',
    statusMain: '', statusSub: '', statusTag: '',

    // 记录
    isPeriod: false, periodBtnText: '',
    showEndBtn: false, endBtnText: '', endClosed: false,
    symptoms: [], moods: [], note: '',
    savedHint: false,

    // 统计
    avgCycle: '--', avgPeriodLen: '--', periodCount: 0,
    alertTitle: '', alertDesc: '', alertLevel: '',
    nextTitle: '🔮 下次经期预测', nextDate: '暂无数据',
    nextSub: '记录至少一次经期后，即可生成预测',
    bars: [], history: [], chartEmpty: '记录 2 次以上经期后显示图表'
  },

  onLoad: function () {
    this._noteDraft = '';
    this._saveTimer = null;
    this.setData({
      theme: getApp().globalData.theme,
      selectedDate: Store.todayStr(),
      symptoms: Store.SYMPTOMS.map(function (s) { return { id: s.id, label: s.label, on: false }; }),
      moods: Store.MOODS.map(function (m) { return { id: m.id, emoji: m.emoji, label: m.label, on: false }; })
    });
    Cloud.init().then(function () { this.renderAll(); }.bind(this));
    this.renderAll();
  },

  onShow: function () {
    var t = getApp().globalData.theme;
    if (t !== this.data.theme) this.setData({ theme: t });
    if (Cloud.state().cloudReady) Cloud.pull(true).then(function () { this.renderAll(); }.bind(this));
    this.renderAll();
  },

  onHide: function () { this.persistNote(); },
  onUnload: function () { this.persistNote(); },

  /* ---------------- 分段切换 ---------------- */
  switchTab: function (e) {
    this.flushNote();
    this.setData({ tab: e.currentTarget.dataset.tab });
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },

  /* ---------------- 渲染总入口 ---------------- */
  renderAll: function () {
    var y = this.data.viewYear || new Date().getFullYear();
    var m = this.data.viewMonth || (new Date().getMonth() + 1);
    this.renderCalendar(y, m);
    this.renderStatus();
    this.renderLog();
    this.renderStats();
  },

  /* ---------------- 日历 ---------------- */
  renderCalendar: function (y, m) {
    var daysInMonth = new Date(y, m, 0).getDate();
    var first = new Date(y, m - 1, 1);
    var offset = first.getDay() - 1;
    if (offset < 0) offset = 6;
    var blanks = [];
    for (var i = 0; i < offset; i++) blanks.push(i);

    var periods = Store.getPeriods();
    var pred = Store.getPrediction(periods);
    var avgPeriodLen = pred ? pred.avgPeriodLen : Store.DEFAULT_PERIOD;
    var ongoing = Store.getOngoingPeriods(periods, avgPeriodLen);
    var today = Store.todayStr(), selected = this.data.selectedDate || today;

    var days = [], d, s, dateObj, cls;
    for (d = 1; d <= daysInMonth; d++) {
      s = y + '-' + pad2(m) + '-' + pad2(d);
      dateObj = new Date(y, m - 1, d);
      cls = [];
      if (s === today) cls.push('today');
      if (s === selected) cls.push('selected');
      if (Store.isPeriodDay(s)) cls.push('is-period');
      else if (Store.findOngoing(dateObj, ongoing)) cls.push('is-ongoing');
      else if (pred) {
        if (s === Store.fmt(pred.ovulation)) cls.push('is-ovulation');
        else if (Store.isInRange(dateObj, pred.nextStart, pred.nextEnd)) cls.push('is-predicted');
        else if (Store.isInRange(dateObj, pred.fertileStart, pred.fertileEnd)) cls.push('is-fertile');
      }
      days.push({ num: d, date: s, cls: cls.join(' '), dot: Store.hasLog(s) });
    }
    this.setData({
      viewYear: y, viewMonth: m,
      monthTitle: y + '年' + m + '月',
      pickerValue: y + '-' + pad2(m),
      blanks: blanks, days: days
    });
  },

  /* 跳到某年某月：选中日若不在目标月，自动落到该月（本月取今天，其它月取 1 号） */
  jumpMonth: function (y, m) {
    var sel = Store.parseDate(this.data.selectedDate);
    if (sel.getFullYear() !== y || sel.getMonth() !== m - 1) {
      var t = Store.today();
      var same = (t.getFullYear() === y && t.getMonth() === m - 1);
      var nd = same ? t : new Date(y, m - 1, 1);
      this.setData({ selectedDate: Store.fmt(nd) });
    }
    this.renderCalendar(y, m);
    this.renderLog();
  },

  /* 顶部月份标题 -> 微信原生年月选择器 */
  onPickMonth: function (e) {
    var v = (e.detail.value || '').split('-');
    var y = parseInt(v[0], 10), m = parseInt(v[1], 10);
    if (!y || !m) return;
    this.jumpMonth(y, m);
  },

  prevMonth: function () {
    var y = this.data.viewYear, m = this.data.viewMonth - 1;
    if (m < 1) { m = 12; y--; }
    this.jumpMonth(y, m);
  },
  nextMonth: function () {
    var y = this.data.viewYear, m = this.data.viewMonth + 1;
    if (m > 12) { m = 1; y++; }
    this.jumpMonth(y, m);
  },
  selectDate: function (e) {
    this.flushNote();
    this.setData({ selectedDate: e.currentTarget.dataset.date, tab: 'calendar' });
    this.renderAll();
  },

  /* ---------------- 状态卡 ---------------- */
  renderStatus: function () {
    var periods = Store.getPeriods(), t = Store.today(), tStr = Store.fmt(t);
    if (!periods.length) {
      this.setData({ statusMain: '👋 欢迎使用', statusSub: '还没有经期记录，点日历里的日期把经期标记上吧～', statusTag: '' });
      return;
    }
    var pred = Store.getPrediction(periods), last = periods[periods.length - 1];
    var inPeriod = periods.some(function (p) {
      return Store.isInRange(t, Store.parseDate(p.start), Store.parseDate(p.end));
    });
    var ongoingList = Store.getOngoingPeriods(periods, Store.getAvgPeriodLen(periods));
    var ongoingToday = Store.findOngoing(t, ongoingList);
    var main, sub, tag;

    if (inPeriod) {
      var dayNum = Store.diffDays(Store.parseDate(last.start), t) + 1;
      main = '经期第 ' + dayNum + ' 天';
      sub = '本次经期从 ' + Store.fmtShort(Store.parseDate(last.start)) + ' 开始，注意保暖休息哦 🫖';
      tag = '经期中';
    } else if (ongoingToday) {
      var dayNum2 = Store.diffDays(ongoingToday.startDate, t) + 1;
      main = '经期第 ' + dayNum2 + ' 天';
      sub = '本次经期从 ' + Store.fmtShort(ongoingToday.startDate) + ' 开始，已按平均长度预测至 ' +
        Store.fmtShort(ongoingToday.endDate) + '，到记录页点确认即可';
      tag = '经期中（预测）';
    } else {
      var cycleDay = Store.diffDays(Store.parseDate(last.start), t) + 1;
      var untilNext = Store.diffDays(t, pred.nextStart);
      if (untilNext > 0) main = '距离下次经期约 ' + untilNext + ' 天';
      else if (untilNext === 0) main = '预计今天来经期';
      else main = '经期可能推迟 ' + (-untilNext) + ' 天';
      sub = '当前为周期第 ' + cycleDay + ' 天（周期约 ' + pred.avgCycle + ' 天）';
      if (Store.fmt(pred.ovulation) === tStr) tag = '排卵日';
      else if (Store.isInRange(t, pred.fertileStart, pred.fertileEnd)) tag = '易孕期';
      else if (t < pred.ovulation) tag = '卵泡期';
      else tag = '黄体期';
    }
    this.setData({ statusMain: main, statusSub: sub, statusTag: tag });
  },

  /* ---------------- 当天操作卡 ---------------- */
  renderLog: function () {
    var sel = this.data.selectedDate || Store.todayStr();
    var d = Store.parseDate(sel);

    var isPeriod = Store.isPeriodDay(sel);
    var periods = Store.getPeriods();
    var pred = Store.getPrediction(periods);
    var ongoing = Store.getOngoingPeriods(periods, pred ? pred.avgPeriodLen : Store.DEFAULT_PERIOD);
    var inOngoing = !isPeriod && !!Store.findOngoing(d, ongoing);
    var cur = Store.findPeriodOf(sel, periods, ongoing);
    var closed = !!(cur && Store.isClosed(cur.start));

    var btnText = isPeriod ? '🩸 已确认：这一天是经期（点击取消）'
      : (inOngoing ? '🩸 这一天在经期内，点击确认为经期' : '🩸 标记这一天为经期');

    var showEnd = !!cur, endText = '';
    if (cur && !closed) endText = '🛑 经期到此结束（' + Store.fmtShort(d) + '）';
    else if (cur && closed) endText = '✅ 经期已结束于 ' + Store.fmtShort(Store.parseDate(cur.end)) + '（点击恢复延续预测）';

    var log = Store.getLog(sel);
    var symptoms = Store.SYMPTOMS.map(function (s) {
      return { id: s.id, label: s.label, on: (log.symptoms || []).indexOf(s.id) >= 0 };
    });
    var moods = Store.MOODS.map(function (m) {
      return { id: m.id, emoji: m.emoji, label: m.label, on: log.mood === m.id };
    });

    this._noteDraft = log.note || '';
    this.setData({
      isPeriod: isPeriod, periodBtnText: btnText,
      showEndBtn: showEnd, endBtnText: endText, endClosed: closed,
      symptoms: symptoms, moods: moods, note: log.note || ''
    });
  },

  togglePeriod: function () {
    Store.togglePeriod(this.data.selectedDate);
    this.afterChange();
  },
  toggleEnd: function () {
    Store.toggleEndPeriod(this.data.selectedDate);
    this.afterChange();
  },
  toggleSymptom: function (e) {
    Store.toggleSymptom(this.data.selectedDate, e.currentTarget.dataset.id);
    this.afterChange();
  },
  setMood: function (e) {
    Store.setMood(this.data.selectedDate, e.currentTarget.dataset.id);
    this.afterChange();
  },
  onNoteInput: function (e) {
    // 不 setData(note)，避免小程序 textarea 光标跳动；防抖落盘
    this._noteDraft = e.detail.value;
    var self = this;
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(function () { self.flushNote(); }, 400);
  },
  /** 只落盘，不碰界面 —— 供 onHide/onUnload 调用 */
  persistNote: function () {
    clearTimeout(this._saveTimer);
    if (typeof this._noteDraft !== 'string') return false;
    var sel = this.data.selectedDate;
    var cur = Store.getLog(sel).note || '';
    if (this._noteDraft === cur) return false;
    Store.setNote(sel, this._noteDraft);
    Cloud.schedulePush();
    return true;
  },
  flushNote: function () {
    if (!this.persistNote()) return;
    this.showSaved();
    this.renderCalendar(this.data.viewYear, this.data.viewMonth);
  },
  showSaved: function () {
    var self = this;
    this.setData({ savedHint: true });
    clearTimeout(this._savedTimer);
    this._savedTimer = setTimeout(function () { self.setData({ savedHint: false }); }, 1200);
  },
  afterChange: function () {
    this.flushNote();          // 先把备注草稿落盘，避免 renderLog 重置未保存的输入
    Cloud.schedulePush();
    this.renderAll();
    this.showSaved();
  },

  /* ---------------- 统计页 ---------------- */
  renderStats: function () {
    var periods = Store.getPeriods();
    var avgCycle = Store.getAvgCycle(periods), avgPeriodLen = Store.getAvgPeriodLen(periods);
    var S = this;

    // 规律分析
    var alert = Store.analyzeCycle(periods);
    var alertTitle = '', alertDesc = '', alertLevel = '';
    if (alert) {
      var icons = { ok: '✅', info: 'ℹ️', warn: '⚠️' };
      alertTitle = icons[alert.level] + ' ' + alert.title;
      alertDesc = alert.desc; alertLevel = alert.level;
    }

    // 下次预测
    var pred = Store.getPrediction(periods);
    var nextDate = '暂无数据', nextSub = '记录至少一次经期后，即可生成预测';
    if (pred) {
      var untilNext = Store.diffDays(Store.today(), pred.nextStart);
      var countText = untilNext > 0 ? '约 ' + untilNext + ' 天后'
        : (untilNext === 0 ? '预计就是今天' : '已推迟约 ' + (-untilNext) + ' 天');
      nextDate = Store.fmtCN(pred.nextStart);
      nextSub = countText + ' · 预计持续 ' + pred.avgPeriodLen + ' 天 · 排卵日约 ' + Store.fmtShort(pred.ovulation);
    }

    // 近 6 次周期柱状图
    var gaps = [];
    for (var i = 1; i < periods.length; i++) {
      gaps.push({
        len: Store.diffDays(Store.parseDate(periods[i - 1].start), Store.parseDate(periods[i].start)),
        label: Store.fmtShort(Store.parseDate(periods[i].start))
      });
    }
    var recent = gaps.slice(-6), bars = [];
    if (recent.length) {
      var maxLen = 1;
      recent.forEach(function (g) { if (g.len > maxLen) maxLen = g.len; });
      bars = recent.map(function (g, i) {
        return { key: i + '_' + g.label, len: g.len, label: g.label,
                 h: Math.max(6, Math.round(g.len / maxLen * 100)) };
      });
    }

    // 经期历史（最近在前）
    var ongoingList = Store.getOngoingPeriods(periods, avgPeriodLen);
    var history = periods.slice().reverse().map(function (p, idx) {
      var markedLen = Store.diffDays(Store.parseDate(p.start), Store.parseDate(p.end)) + 1;
      var realIdx = periods.length - 1 - idx;
      var ong = null;
      for (var k = 0; k < ongoingList.length; k++) if (ongoingList[k].start === p.start) ong = ongoingList[k];
      var endText, lenText;
      if (ong) {
        endText = Store.fmtShort(ong.endDate) + '?';
        lenText = '已标 ' + markedLen + ' 天 · 预计 ' + (Store.diffDays(ong.startDate, ong.endDate) + 1) + ' 天';
      } else {
        endText = Store.fmtShort(Store.parseDate(p.end));
        lenText = '持续 ' + markedLen + ' 天';
      }
      var cycleText = '';
      if (realIdx > 0) {
        cycleText = ' · 距上次 ' + Store.diffDays(Store.parseDate(periods[realIdx - 1].start), Store.parseDate(p.start)) + ' 天';
      }
      return {
        key: p.start + '~' + p.end,
        dates: Store.fmtShort(Store.parseDate(p.start)) + ' ~ ' + endText,
        meta: lenText + cycleText
      };
    });

    this.setData({
      avgCycle: periods.length >= 2 ? String(avgCycle) : '--',
      avgPeriodLen: periods.length >= 1 ? String(avgPeriodLen) : '--',
      periodCount: periods.length,
      alertTitle: alertTitle, alertDesc: alertDesc, alertLevel: alertLevel,
      nextDate: nextDate, nextSub: nextSub,
      bars: bars, history: history
    });
  }
});
