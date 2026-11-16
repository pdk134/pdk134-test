var Cloud = require('../../utils/cloud.js');
var Store = require('../../utils/store.js');
var PeriodCloud = require('../../utils/period-cloud.js');
var PeriodStore = require('../../utils/period-store.js');
var Remind = require('../../utils/remind.js');

Page({
  data: {
    theme: 'light',
    syncText: '正在检查…',
    periodSyncText: '',
    openidShort: '',
    taskCount: 0,
    periodCount: 0,
    cloudReady: false,
    remindEnabled: true,
    remindHint: ''
  },

  onLoad: function () {
    this.setData({ theme: getApp().globalData.theme, remindEnabled: Remind.enabled() });
    Cloud.onChange(function () { this.updateStatus(); }.bind(this));
    PeriodCloud.onChange(function () { this.updateStatus(); }.bind(this));
    Cloud.init().then(function () { this.updateStatus(); }.bind(this));
    PeriodCloud.init().then(function () { this.updateStatus(); }.bind(this));
    this.updateStatus();
  },

  onShow: function () {
    var t = getApp().globalData.theme;
    if (t !== this.data.theme) this.setData({ theme: t });
    this.updateStatus();
    if (Cloud.state().cloudReady) Cloud.pull(true);
    if (PeriodCloud.state().cloudReady) PeriodCloud.pull(true);
  },

  describe: function (s) {
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
    return parts.join(' · ');
  },

  updateStatus: function () {
    var s = Cloud.state(), ps = PeriodCloud.state();
    var openid = (s.openid && s.openid !== 'local') ? s.openid
      : (ps.scope && ps.scope.indexOf('local-') !== 0 ? ps.scope : '');
    this.setData({
      syncText: this.describe(s),
      periodSyncText: this.describe(ps),
      openidShort: openid ? '微信用户 ' + openid.slice(0, 8) : '未取到 openid（不影响使用）',
      cloudReady: s.cloudReady && ps.cloudReady,
      taskCount: Store.all().length,
      periodCount: PeriodStore.getPeriods().length,
      remindHint: this.remindHintText()
    });
  },

  remindHintText: function () {
    if (!this.data.remindEnabled) return '';
    var rs = Remind.status();
    if (rs.blocked) return '⚠️ 微信里已关闭本小程序的通知，需到「设置 → 订阅消息」里重新允许';
    if (!rs.count) return '今日尚未续期，操作任意任务或点一下日期即可';
    return '今日已自动续期 ' + rs.count + ' 次 · 累计授权 ' + rs.accepted + ' 次';
  },

  goAbout: function () {
    wx.navigateTo({ url: '/pages/about/about' });
  },

  sendTestRemind: function () {
    Remind.sendTest();
  },

  toggleRemind: function () {
    var next = !this.data.remindEnabled;
    Remind.setEnabled(next);
    this.setData({ remindEnabled: next });
    wx.showToast({ title: next ? '已开启提醒' : '已关闭提醒', icon: 'none', duration: 1200 });
    // 主动开启时立刻申请一次额度（点击上下文合法，跳过节流）
    if (next) Remind.ensureAuth(true);
    this.updateStatus();
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
