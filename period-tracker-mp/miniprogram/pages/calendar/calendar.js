var Store = require('../../utils/store.js');
var Cloud = require('../../utils/cloud.js');
var Actions = require('../../utils/actions.js');
var Remind = require('../../utils/remind.js');

var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(n) { return n < 10 ? '0' + n : String(n); }

Page(Object.assign({
  data: {
    theme: 'light',
    viewYear: 0, viewMonth: 0,
    monthTitle: '', pickerValue: '',
    weekNames: ['一', '二', '三', '四', '五', '六', '日'],
    blanks: [], days: [],
    selectedDate: '', dayTitle: '', dayCount: '', dayTasks: [],
    quickValue: '', quickTime: '',
    beforeValues: [0, 5, 10, 15, 30, 60, 120, 1440],
    beforeLabels: ['到点提醒', '提前 5 分钟', '提前 10 分钟', '提前 15 分钟', '提前 30 分钟', '提前 1 小时', '提前 2 小时', '提前 1 天'],
    beforeIndex: 0,
    swipeOpenPath: '',
    deferForId: '', deferDays: 1,
    editorVisible: false, editorId: '', editorTask: null, editorDate: ''
  },

  onLoad: function () {
    this.setData({ theme: getApp().globalData.theme });
    Cloud.onChange(function () { this.refresh(); }.bind(this));
    Cloud.init().then(function () { this.refresh(); }.bind(this));
    this.refresh();
  },

  onShow: function () {
    var t = getApp().globalData.theme;
    if (t !== this.data.theme) this.setData({ theme: t });
    if (Cloud.state().cloudReady) Cloud.pull(true);
    this.setData({ deferForId: '', deferDays: 1 });
    this.refresh();
  },

  refresh: function () {
    var y = this.data.viewYear || new Date().getFullYear();
    var m = this.data.viewMonth || (new Date().getMonth() + 1);
    var selected = this.data.selectedDate || Store.todayStr();
    this.setData({ selectedDate: selected });
    this.renderCalendar(y, m, selected);
    this.renderDay(selected);
  },

  renderCalendar: function (y, m, selected) {
    var daysInMonth = new Date(y, m, 0).getDate();
    var first = new Date(y, m - 1, 1);
    var offset = first.getDay() - 1;
    if (offset < 0) offset = 6;
    var blanks = [];
    for (var i = 0; i < offset; i++) blanks.push(i);

    var today = Store.todayStr(), days = [], d, s, list, todo, overdue, cls;
    for (d = 1; d <= daysInMonth; d++) {
      s = y + '-' + pad2(m) + '-' + pad2(d);
      list = Store.onDate(s);
      todo = list.filter(function (t) { return t.status === 'todo'; }).length;
      overdue = list.filter(function (t) { return Store.isOverdue(t); }).length;
      cls = [];
      if (s === today) cls.push('today');
      if (s === selected) cls.push('selected');
      if (overdue > 0) cls.push('has-overdue');
      else if (todo > 0) cls.push('has-todo');
      else if (list.length > 0) cls.push('has-done');
      days.push({
        date: s, num: d, cls: cls.join(' '),
        badge: todo > 0 ? String(todo) : '',
        dot: todo === 0 && list.length > 0
      });
    }
    this.setData({
      viewYear: y, viewMonth: m,
      monthTitle: y + ' 年 ' + m + ' 月',
      pickerValue: y + '-' + pad2(m),
      blanks: blanks, days: days
    });
  },

  renderDay: function (s) {
    var d = Store.parseDate(s);
    var list = Store.onDate(s);
    var todo = list.filter(function (t) { return t.status === 'todo'; });
    var done = list.filter(function (t) { return t.status === 'done'; });
    todo.sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; });
    done.sort(function (a, b) { return (a.completed_at || '') < (b.completed_at || '') ? 1 : -1; });
    this.setData({
      dayTitle: (d.getMonth() + 1) + '月' + d.getDate() + '日 · ' + WEEK[d.getDay()] +
        (s === Store.todayStr() ? '（今天）' : ''),
      dayCount: list.length ? (todo.length + ' 待办 · ' + done.length + ' 完成') : '',
      dayTasks: todo.concat(done).map(function (t, i) {
        var v = Actions.vm(t);
        v.x = 0;
        v.moving = false;
        v.path = 'dayTasks[' + i + '].x';
        return v;
      }),
      swipeOpenPath: ''
    });
  },

  /* 跳到某年某月：选中日若不在目标月，自动落到该月（本月取今天，其它月取 1 号） */
  jumpMonth: function (y, m) {
    var sel = Store.parseDate(this.data.selectedDate);
    var same = (sel.getFullYear() === y && sel.getMonth() === m - 1);
    if (!same) {
      var t = Store.parseDate(Store.todayStr());
      var nd = (t.getFullYear() === y && t.getMonth() === m - 1) ? t : new Date(y, m - 1, 1);
      this.setData({ selectedDate: Store.fmtDate(nd) });
    }
    this.renderCalendar(y, m, this.data.selectedDate);
    this.renderDay(this.data.selectedDate);
  },

  /* 顶部月份标题 -> 微信原生年月选择器 */
  onPickMonth: function (e) {
    var raw = (e && e.detail && e.detail.value) || '';
    var v = String(raw).split('-');
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
    var s = e.currentTarget.dataset.date;
    this.setData({ selectedDate: s });
    this.renderCalendar(this.data.viewYear, this.data.viewMonth, s);
    this.renderDay(s);
    Remind.ensureAuth();
  },
  onQuickInput: function (e) { this.setData({ quickValue: e.detail.value }); },
  onQuickTime: function (e) { this.setData({ quickTime: e.detail.value }); },
  onQuickBefore: function (e) { this.setData({ beforeIndex: Number(e.detail.value) || 0 }); },
  quickAdd: function () {
    var v = (this.data.quickValue || '').trim();
    if (!v) return;
    var tm = this.data.quickTime;
    Store.create({
      title: v, due: this.data.selectedDate,
      time: tm,
      before: this.data.beforeValues[this.data.beforeIndex] || 0
    });
    this.setData({ quickValue: '', quickTime: '', beforeIndex: 0 });
    wx.showToast({ title: tm ? '已添加，将按时提醒' : '已添加', icon: 'none', duration: 1200 });
    Actions.change(this);
    if (this.data.selectedDate >= Store.todayStr()) Remind.ensureAuth();
  }
}, Actions.createHandlers()));
