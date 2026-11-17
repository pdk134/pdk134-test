/**
 * 账号页：本地模式说明 + 微信一键登录（考后联调占位）+ 数据隐私 + 免责声明。
 * 门禁已取消：所有功能开箱即用，本页只展示账号与数据状态。
 */
const C = require('../../libs/common.js');
const Store = C.Store;

Page({
  data: {
    theme: 'dark',
    cards: 0,
    reviewed: 0,
    streak: 0
  },

  onShow: function () {
    C.syncTheme(this);
    var s = Store.data.stats || {};
    this.setData({
      cards: C.countStatus().learned,
      reviewed: s.reviewed || 0,
      streak: s.streak || 0
    });
  },

  onLogin: function () {
    wx.showToast({ title: '云同步将在考后联调时开放', icon: 'none' });
  }
});
