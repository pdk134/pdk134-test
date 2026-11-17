/**
 * 术语详情弹窗（学习 / 词库 / 统计页共用）
 * 属性：visible 是否显示；term 术语对象（null 时不渲染内容）
 * 事件：close 关闭；goto { name } 点击相关术语跳转
 */
const C = require('../../libs/common.js');

Component({
  properties: {
    visible: { type: Boolean, value: false },
    term: { type: Object, value: null }
  },
  data: {
    info: null
  },
  observers: {
    'visible, term': function (visible, term) {
      if (!visible || !term) { this.setData({ info: null }); return; }
      var c = C.Store.raw(term.t);
      var st = C.statusLabel(term.t);
      this.setData({
        info: {
          t: term.t,
          en: term.en || '',
          ja: term.ja || '',
          c: term.c,
          lv: C.levelText(term.lv),
          d: term.d || '',
          points: term.p || [],
          e: term.e || '—',
          rel: (term.r || []).filter(function (r) { return C.byId[r]; }),
          status: st.text,
          statusCls: st.cls,
          due: c ? C.SRS.dueText(c) : '未学习',
          reps: c ? c.reps : 0,
          lapses: c ? c.lapses : 0
        }
      });
    }
  },
  methods: {
    onClose: function () { this.triggerEvent('close'); },
    onGoto: function (e) {
      this.triggerEvent('goto', { name: e.currentTarget.dataset.name });
    },
    stopTap: function () {}
  }
});
