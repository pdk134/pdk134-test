/* =========================================================
 * 任务行公共交互（日历页 / 清单页复用）
 * 页面需要实现 refresh()，并混入 createHandlers() 提供的左滑、推迟与编辑处理
 * ========================================================= */
var Store = require('./store.js');
var Cloud = require('./cloud.js');
var Remind = require('./remind.js');

function fmtCN(dateStr) {
  var p = String(dateStr).split('-');
  return Number(p[1]) + '月' + Number(p[2]) + '日';
}

/** 把 store 的任务转成模板能直接渲染的 view model */
function vm(t) {
  var today = Store.todayStr();
  var tags = [];
  if (Store.isOverdue(t)) tags.push({ text: '逾期', type: 'overdue' });
  var bits = [];
  if (t.original_due_date && t.original_due_date !== t.due_date) {
    bits.push('原定 ' + fmtCN(t.original_due_date));
  }
  if (t.defer_count > 0) bits.push('推迟' + t.defer_count + '次');
  if (bits.length) tags.push({ text: bits.join(' · '), type: 'defer' });
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

/* ---------------- 左滑任务行（日历页 / 清单页） ---------------- */
var SWIPE_WIDTH_RPX = 260;   // 两个操作按钮，各 130rpx

function swipeMax() {
  var w = 375;
  try { w = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).windowWidth || 375; } catch (e) {}
  return SWIPE_WIDTH_RPX * w / 750;
}
function movingPath(path) { return String(path).replace(/\.x$/, '.moving'); }
function setRow(ctx, path, x, moving) {
  if (!path) return;
  var d = {};
  d[path] = x;
  d[movingPath(path)] = !!moving;
  ctx.setData(d);
}
function closeRow(ctx, path) {
  if (!path) return;
  var d = {};
  d[path] = 0;
  d[movingPath(path)] = false;
  d.swipeOpenPath = '';
  d.deferForId = '';
  d.deferDays = 1;
  ctx.setData(d);
}

function createHandlers() {
  return {
    onSwipeStart: function (e) {
      var ds = e.currentTarget.dataset, t = e.touches[0];
      var s = this._swipe || (this._swipe = {});
      s.path = ds.path;
      s.startX = t.clientX;
      s.startY = t.clientY;
      s.baseX = Number(ds.x) || 0;
      s.lastX = s.baseX;
      s.moved = false;
      s.ignore = false;
      setRow(this, s.path, s.baseX, true);
    },

    onSwipeMove: function (e) {
      var s = this._swipe;
      if (!s || !s.path) return;
      var dx = e.touches[0].clientX - s.startX;
      var dy = e.touches[0].clientY - s.startY;
      if (!s.moved && Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { s.ignore = true; return; }
      if (s.ignore) return;
      if (Math.abs(dx) > 4) s.moved = true;
      var max = swipeMax();
      var x = Math.max(-max, Math.min(0, s.baseX + dx));
      if (Math.abs(x - s.lastX) < 2) return;
      s.lastX = x;
      setRow(this, s.path, x, true);
    },

    onSwipeEnd: function () {
      var s = this._swipe;
      if (!s || !s.path) return;
      var max = swipeMax(), open = s.lastX < -max / 2, d = {};
      if (s.moved && !s.ignore) {
        var prev = this.data.swipeOpenPath;
        if (prev && prev !== s.path) {
          d[prev] = 0;
          d.deferForId = ''; d.deferDays = 1;
        }
        d.swipeOpenPath = open ? s.path : '';
        if (!open) { d.deferForId = ''; d.deferDays = 1; }
      }
      d[s.path] = open ? -max : 0;
      d[movingPath(s.path)] = false;
      this.setData(d);
      if (s.moved && !s.ignore) {
        var self = this;
        this._swipeTapBlocked = true;
        clearTimeout(this._swipeTapTimer);
        this._swipeTapTimer = setTimeout(function () { self._swipeTapBlocked = false; }, 350);
      }
      s.path = '';
    },

    /** 点行：已展开则收起，不打开任务详情/编辑 */
    onSwipeTap: function (e) {
      if (this._swipeTapBlocked) { this._swipeTapBlocked = false; return; }
      var ds = e.currentTarget.dataset;
      if (Number(ds.x) < -5) closeRow(this, ds.path);
    },

    onCheck: function (e) {
      var id = e.currentTarget.dataset.id;
      var t = Store.get(id);
      if (!t) return;
      var done = t.status !== 'done';
      Store.setDone(id, done);
      wx.showToast({ title: done ? '已完成' : '已改回待办', icon: 'none', duration: 1200 });
      change(this);
      // 顺手补一次订阅额度（一次性订阅：授权一次只能发一条，额度会随使用消耗）
      Remind.ensureAuth();
    },

    onSwipeDefer: function (e) {
      var ds = e.currentTarget.dataset;
      if (!Store.get(ds.id)) return;
      this.setData({ deferForId: ds.id, deferDays: 1 });
    },

    onSwipeDelete: function (e) {
      var ds = e.currentTarget.dataset, t = Store.get(ds.id), self = this;
      if (!t) return;
      closeRow(this, ds.path);
      wx.showModal({
        title: '删除任务', content: '确定删除「' + t.title + '」？',
        success: function (r) {
          if (!r.confirm) return;
          Store.softDelete(t.id);
          wx.showToast({ title: '已删除', icon: 'none', duration: 1200 });
          change(self);
        }
      });
    },

    onDeferDaysInput: function (e) {
      var v = String(e.detail.value || '').replace(/[^\d]/g, '').slice(0, 3);
      this.setData({ deferDays: v });
    },
    onDeferMinus: function () {
      this.setData({ deferDays: Math.max(1, (Number(this.data.deferDays) || 1) - 1) });
    },
    onDeferPlus: function () {
      this.setData({ deferDays: Math.min(365, (Number(this.data.deferDays) || 1) + 1) });
    },
    onDeferCancel: function () {
      this.setData({ deferForId: '', deferDays: 1 });
    },
    onDeferConfirm: function (e) {
      var n = Math.max(1, Math.min(365, Number(this.data.deferDays) || 1));
      var t = Store.get(this.data.deferForId);
      if (!t) { this.onDeferCancel(); return; }
      Store.deferTo(t.id, Store.fmtDate(Store.addDays(Store.parseDate(t.due_date), n)));
      closeRow(this, e.currentTarget.dataset.path);
      wx.showToast({ title: '已推迟 ' + n + ' 天', icon: 'none', duration: 1200 });
      change(this);
      Remind.ensureAuth();
    },

    noop: function () {},

    onRowTap: function (e) { this.onMore(e); },

    onMore: function (e) {
      var id = e.currentTarget.dataset.id;
      var t = Store.get(id);
      if (!t) return;
      var self = this;
      wx.showActionSheet({
        itemList: [
          t.status === 'done' ? '↩︎ 取消完成' : '✓ 标记完成',
          '推迟 1 天', '推迟 3 天', '推迟 7 天', '编辑', '删除'
        ],
        success: function (res) {
          var i = res.tapIndex;
          if (i === 0) {
            Store.setDone(id, t.status !== 'done');
            change(self);
          } else if (i >= 1 && i <= 3) {
            var n = i === 1 ? 1 : i === 3 ? 3 : 7;
            Store.deferTo(id, Store.fmtDate(Store.addDays(Store.parseDate(t.due_date), n)));
            wx.showToast({ title: '已推迟 ' + n + ' 天', icon: 'none', duration: 1200 });
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
      Remind.ensureAuth();
    }
  };
}

module.exports = { vm: vm, change: change, createHandlers: createHandlers, fmtCN: fmtCN };
