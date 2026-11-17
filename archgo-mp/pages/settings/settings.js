/**
 * 设置页：每日配额 / 主题 / 导出导入 / 快照 / 清空 / 关于。
 * 数据读写全部走 Store（与 Web 版同一套 localStorage→Storage 适配层）。
 * 小程序无文件下载 API：导出走剪贴板，导入走粘贴文本框。
 */
const Store = require('../../libs/store.js');
const C = require('../../libs/common.js');

function fmtTime(t) {
  var d = new Date(t);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    theme: 'dark',
    dailyNew: 10,
    dailyReview: 60,
    backups: [],
    importText: ''
  },

  onShow: function () {
    C.syncTheme(this);
    this.refresh();
  },

  refresh: function () {
    var s = Store.data.settings;
    this.setData({
      dailyNew: s.dailyNew,
      dailyReview: s.dailyReview,
      backups: Store.listBackups().map(function (b) {
        return { t: b.t, time: fmtTime(b.t), reason: b.reason, cards: b.cards, reviewed: b.reviewed };
      })
    });
  },

  /* 滑杆拖动时只刷新数字，松手（change）才落库，避免频繁写存储 */
  onNewChanging: function (e) { this.setData({ dailyNew: e.detail.value }); },
  onRevChanging: function (e) { this.setData({ dailyReview: e.detail.value }); },
  onNewChange: function (e) {
    Store.data.settings.dailyNew = +e.detail.value;
    Store.touch();
  },
  onRevChange: function (e) {
    Store.data.settings.dailyReview = +e.detail.value;
    Store.touch();
  },

  onTheme: function (e) {
    var v = e.currentTarget.dataset.v;
    if (Store.data.settings.theme === v) return;
    Store.data.settings.theme = v;
    Store.touch();
    this.setData({ theme: v });
  },

  onExport: function () {
    wx.setClipboardData({
      data: Store.exportText(),
      success: function () {
        wx.showToast({ title: '已复制，粘贴保存即可', icon: 'none' });
      },
      fail: function () {
        wx.showToast({ title: '复制失败', icon: 'none' });
      }
    });
  },

  onImportInput: function (e) { this.setData({ importText: e.detail.value }); },

  onImport: function () {
    var raw = (this.data.importText || '').trim();
    if (!raw) {
      wx.showToast({ title: '先粘贴导出的 JSON 内容', icon: 'none' });
      return;
    }
    var obj;
    try { obj = JSON.parse(raw); }
    catch (e) {
      wx.showToast({ title: '不是有效的 JSON', icon: 'none' });
      return;
    }
    var self = this;
    wx.showModal({
      title: '导入将合并学习进度',
      content: '导入采用只增不减的合并策略，不会抹掉你已有的卡片；导入前会自动创建一份快照。',
      confirmText: '导入',
      success: function (res) {
        if (!res.confirm) return;
        if (Store.load(obj)) {
          self.setData({ importText: '' });
          self.refresh();
          wx.showToast({ title: '导入成功', icon: 'success' });
        } else {
          wx.showToast({ title: '导入失败：格式不正确', icon: 'none' });
        }
      }
    });
  },

  onBakTap: function (e) {
    var t = +e.currentTarget.dataset.t;
    var self = this;
    wx.showModal({
      title: '恢复快照',
      content: '恢复到 ' + fmtTime(t) + ' 的快照？当前状态会先自动备份一份。',
      confirmText: '恢复',
      success: function (res) {
        if (!res.confirm) return;
        if (Store.restoreBackup(t)) {
          self.refresh();
          wx.showToast({ title: '已恢复', icon: 'success' });
        } else {
          wx.showToast({ title: '恢复失败', icon: 'none' });
        }
      }
    });
  },

  onWipe: function () {
    var self = this;
    wx.showModal({
      title: '清空本机学习记录',
      content: '将删除本机全部学习进度（会自动留一份快照，之后仍可从快照恢复）。确定吗？',
      confirmText: '清空',
      confirmColor: '#d94156',
      success: function (res) {
        if (!res.confirm) return;
        Store.snapshot('清空本机前自动备份');
        Store.reset();
        self.refresh();
        wx.showToast({ title: '已清空', icon: 'success' });
      }
    });
  }
});
