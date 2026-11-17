Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    visible: { type: Boolean, value: false, observer: 'syncForm' },
    task: { type: Object, value: null, observer: 'syncForm' },
    defaultDate: { type: String, value: '', observer: 'syncForm' }
  },
  data: {
    title: '', note: '', due: '', time: '', isEdit: false,
    beforeValues: [0, 5, 10, 15, 30, 60, 120, 1440],
    beforeLabels: ['到点提醒', '提前 5 分钟', '提前 10 分钟', '提前 15 分钟', '提前 30 分钟', '提前 1 小时', '提前 2 小时', '提前 1 天'],
    beforeIndex: 0
  },

  methods: {
    syncForm: function () {
      if (!this.data.visible) return;
      var t = this.data.task;
      var vals = this.data.beforeValues;
      var before = t ? (Number(t.remind_before) || 0) : 0;
      var idx = vals.indexOf(before);
      this.setData({
        title: t ? t.title : '',
        note: t ? (t.note || '') : '',
        due: t ? t.due_date : (this.data.defaultDate || this.today()),
        time: t ? (t.due_time || '') : '',
        beforeIndex: idx < 0 ? 0 : idx,
        isEdit: !!t
      });
    },
    today: function () {
      var d = new Date(), p = function (n) { return n < 10 ? '0' + n : String(n); };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },
    onTitle: function (e) { this.setData({ title: e.detail.value }); },
    onNote: function (e) { this.setData({ note: e.detail.value }); },
    onDue: function (e) { this.setData({ due: e.detail.value }); },
    onTime: function (e) { this.setData({ time: e.detail.value }); },
    onBefore: function (e) { this.setData({ beforeIndex: Number(e.detail.value) || 0 }); },
    onCancel: function () { this.triggerEvent('cancel'); },
    onSave: function () {
      var title = (this.data.title || '').trim();
      if (!title) { wx.showToast({ title: '请填写标题', icon: 'none' }); return; }
      this.triggerEvent('confirm', {
        title: title, note: this.data.note || '', due: this.data.due || this.today(),
        time: this.data.time || '',
        before: this.data.beforeValues[this.data.beforeIndex] || 0
      });
    },
    noop: function () {}
  }
});
