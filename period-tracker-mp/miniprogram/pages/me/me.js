var CFG = require('../../config.js');
var Cloud = require('../../utils/cloud.js');
var Store = require('../../utils/store.js');

Page({
  data: {
    theme: 'light',
    syncText: '正在检查…',
    openidShort: '',
    taskCount: 0,
    cloudReady: false
  },

  onLoad: function () {
    this.setData({ theme: getApp().globalData.theme });
    Cloud.onChange(function () { this.updateStatus(); }.bind(this));
    Cloud.init().then(function () { this.updateStatus(); }.bind(this));
    this.updateStatus();
  },

  onShow: function () {
    var t = getApp().globalData.theme;
    if (t !== this.data.theme) this.setData({ theme: t });
    this.updateStatus();
    if (Cloud.state().cloudReady) Cloud.pull(true);
  },

  updateStatus: function () {
    var s = Cloud.state();
    var parts = [];
    if (!s.cloudReady) parts.push('离线模式（数据只存本机）');
    else if (s.status === 'error') parts.push('同步异常');
    else if (s.status === 'syncing') parts.push('正在同步…');
    else parts.push('云端已同步');
    if (s.lastSync) {
      var d = new Date(s.lastSync);
      var p = function (n) { return n < 10 ? '0' + n : String(n); };
      parts.push('上次 ' + p(d.getHours()) + ':' + p(d.getMinutes()));
    }
    if (s.message) parts.push(s.message);
    var openid = s.openid && s.openid !== 'local' ? s.openid : '';
    this.setData({
      syncText: parts.join(' · '),
      openidShort: openid ? '微信用户 ' + openid.slice(0, 8) : '未取到 openid（不影响使用）',
      cloudReady: s.cloudReady,
      taskCount: Store.all().length
    });
  },

  syncNow: function () {
    var self = this;
    wx.showLoading({ title: '同步中' });
    Cloud.pull(false).then(function () {
      wx.hideLoading();
      self.updateStatus();
      wx.showToast({ title: '同步完成', icon: 'none', duration: 1500 });
    });
  },

  copyLink: function (e) {
    var url = e.currentTarget.dataset.url === 'month' ? CFG.WEB_MONTH_URL : CFG.WEB_TASKLIST_URL;
    wx.setClipboardData({
      data: url,
      success: function () {
        wx.showModal({
          title: '链接已复制',
          content: '个人主体的小程序不能直接打开外部网页。请打开手机浏览器，粘贴访问；或把网页版添加到桌面。',
          showCancel: false
        });
      }
    });
  },

  toggleTheme: function () {
    var next = this.data.theme === 'dark' ? 'light' : 'dark';
    getApp().setTheme(next);
    this.setData({ theme: next });
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: next === 'dark' ? '#17292a' : '#2f9e8f'
    });
  }
});
