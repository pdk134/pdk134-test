Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    visible: { type: Boolean, value: false, observer: 'syncForm' },
    task: { type: Object, value: null, observer: 'syncForm' },
    defaultDate: { type: String, value: '', observer: 'syncForm' }
  },
  data: { title: '', note: '', due: '', isEdit: false },

  methods: {
    syncForm: function () {
      if (!this.data.visible) return;
      var t = this.data.task;
      this.setData({
        title: t ? t.title : '',
        note: t ? (t.note || '') : '',
        due: t ? t.due_date : (this.data.defaultDate || this.today()),
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
    onCancel: function () { this.triggerEvent('cancel'); },
    onSave: function () {
      var title = (this.data.title || '').trim();
      if (!title) { wx.showToast({ title: '请填写标题', icon: 'none' }); return; }
      this.triggerEvent('confirm', {
        title: title, note: this.data.note || '', due: this.data.due || this.today()
      });
    },
    noop: function () {}
  }
});
