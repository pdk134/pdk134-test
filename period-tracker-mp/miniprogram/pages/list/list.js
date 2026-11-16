var Store = require('../../utils/store.js');
var Cloud = require('../../utils/cloud.js');
var Actions = require('../../utils/actions.js');

var DEFS = [
  { key: 'overdue', label: '⏰ 已逾期' },
  { key: 'today', label: '📌 今天' },
  { key: 'tomorrow', label: '明天' },
  { key: 'week', label: '本周稍后' },
  { key: 'later', label: '以后' },
  { key: 'done', label: '✅ 已完成' }
];

Page(Object.assign({
  data: {
    theme: 'light',
    statTodo: 0, statDone: 0, statRate: '–', headerSub: '',
    groups: [], doneCollapsed: true,
    swipeOpenPath: '', deferForId: '', deferDays: 1,
    editorVisible: false, editorId: '', editorTask: null, editorDate: '', selectedDate: ''
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
    var today = Store.todayStr();
    var tomorrow = Store.fmtDate(Store.addDays(Store.parseDate(today), 1));
    var weekEnd = Store.fmtDate(Store.addDays(Store.parseDate(today), 6));
    var g = { overdue: [], today: [], tomorrow: [], week: [], later: [], done: [] };

    Store.all().forEach(function (t) {
      if (t.status === 'done') { g.done.push(t); return; }
      if (t.due_date < today) g.overdue.push(t);
      else if (t.due_date === today) g.today.push(t);
      else if (t.due_date === tomorrow) g.tomorrow.push(t);
      else if (t.due_date <= weekEnd) g.week.push(t);
      else g.later.push(t);
    });
    var byDue = function (a, b) { return a.due_date < b.due_date ? -1 : 1; };
    Object.keys(g).forEach(function (k) { g[k].sort(byDue); });
    g.done.sort(function (a, b) { return (a.completed_at || '') > (b.completed_at || '') ? -1 : 1; });

    var groups = [], self = this;
    DEFS.forEach(function (def) {
      var list = g[def.key];
      if (!list.length) return;
      var gi = groups.length;
      var collapsed = def.key === 'done' && self.data.doneCollapsed && list.length > 3;
      groups.push({
        key: def.key, label: def.label, count: list.length,
        tasks: (collapsed ? list.slice(0, 3) : list).map(function (t, ti) {
          var v = Actions.vm(t);
          v.x = 0;
          v.moving = false;
          v.path = 'groups[' + gi + '].tasks[' + ti + '].x';
          return v;
        }),
        collapsed: collapsed
      });
    });

    var st = Store.stats();
    var n = st.todoToday + st.overdue;
    this.setData({
      statTodo: st.todoToday, statDone: st.doneToday,
      statRate: st.weekRate === null ? '–' : st.weekRate + '%',
      headerSub: n > 0
        ? '今天还有 ' + n + ' 件事' + (st.overdue ? '（' + st.overdue + ' 件逾期）' : '')
        : '今天没有安排，享受吧 ✨',
      groups: groups,
      swipeOpenPath: '',
      selectedDate: today
    });
  },

  toggleGroup: function (e) {
    if (e.currentTarget.dataset.group !== 'done') return;
    this.setData({ doneCollapsed: !this.data.doneCollapsed });
    this.refresh();
  },
  expandDone: function () { this.setData({ doneCollapsed: false }); this.refresh(); }
}, Actions.createHandlers()));
