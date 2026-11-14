/* =========================================================
 * 任务行公共交互（日历页 / 清单页复用）
 * 页面需要实现 refresh()，并注册 onRowTap / onCheck / onMore / onEditor* 等方法
 * ========================================================= */
var Store = require('./store.js');
var Cloud = require('./cloud.js');

function fmtCN(dateStr) {
  var p = String(dateStr).split('-');
  return Number(p[1]) + '月' + Number(p[2]) + '日';
}

/** 把 store 的任务转成模板能直接渲染的 view model */
function vm(t) {
  var today = Store.todayStr();
  var tags = [];
  if (Store.isOverdue(t)) tags.push({ text: '逾期', type: 'overdue' });
  if (t.defer_count > 0) tags.push({ text: '延' + t.defer_count + '次', type: 'defer' });
  if (t.due_date !== today && t.status === 'todo') {
    tags.push({ text: fmtCN(t.due_date), type: 'due' });
  }
  var cls = [];
  if (t.status === 'done') cls.push('done');
  if (Store.isOverdue(t)) cls.push('overdue');
  return {
    id: t.id, title: t.title, tags: tags,
    cls: cls.join(' '), checked: t.status === 'done'
  };
}

function change(ctx) {
  Store.persist();
  Cloud.schedulePush();
  if (ctx && typeof ctx.refresh === 'function') ctx.refresh();
}

function createHandlers() {
  return {
    onCheck: function (e) {
      var id = e.currentTarget.dataset.id;
      var t = Store.get(id);
      if (!t) return;
      var done = t.status !== 'done';
      Store.setDone(id, done);
      wx.showToast({ title: done ? '已完成' : '已改回待办', icon: 'none', duration: 1200 });
      change(this);
    },

    onRowTap: function (e) { this.onMore(e); },

    onMore: function (e) {
      var id = e.currentTarget.dataset.id;
      var t = Store.get(id);
      if (!t) return;
      var self = this;
      wx.showActionSheet({
        itemList: [
          t.status === 'done' ? '↩︎ 取消完成' : '✓ 标记完成',
          '延期 1 天', '延期 3 天', '延期 7 天', '编辑', '删除'
        ],
        success: function (res) {
          var i = res.tapIndex;
          if (i === 0) {
            Store.setDone(id, t.status !== 'done');
            change(self);
          } else if (i >= 1 && i <= 3) {
            var n = i === 1 ? 1 : i === 3 ? 3 : 7;
            Store.deferTo(id, Store.fmtDate(Store.addDays(Store.parseDate(t.due_date), n)));
            wx.showToast({ title: '已延期 ' + n + ' 天', icon: 'none', duration: 1200 });
            change(self);
          } else if (i === 4) {
            self.openEditor(id);
          } else if (i === 5) {
            wx.showModal({
              title: '删除任务', content: '确定删除「' + t.title + '」？',
              success: function (r) {
                if (!r.confirm) return;
                Store.softDelete(id);
                wx.showToast({ title: '已删除', icon: 'none', duration: 1200 });
                change(self);
              }
            });
          }
        },
        fail: function () {}
      });
    },

    openEditor: function (id) {
      var t = id ? Store.get(id) : null;
      this.setData({
        editorVisible: true,
        editorId: id || '',
        editorTask: t,
        editorDate: t ? t.due_date : (this.data.selectedDate || Store.todayStr())
      });
    },

    onEditorCancel: function () {
      this.setData({ editorVisible: false, editorId: '', editorTask: null });
    },

    onEditorConfirm: function (e) {
      var d = e.detail || {};
      var id = this.data.editorId;
      if (id) Store.patch(id, { title: d.title, note: d.note, due: d.due });
      else Store.create({ title: d.title, note: d.note, due: d.due });
      this.setData({ editorVisible: false, editorId: '', editorTask: null });
      wx.showToast({ title: id ? '已保存' : '已添加', icon: 'none', duration: 1200 });
      change(this);
    }
  };
}

module.exports = { vm: vm, change: change, createHandlers: createHandlers, fmtCN: fmtCN };
