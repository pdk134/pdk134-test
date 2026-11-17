const CFG = require('./config.js');

App({
  globalData: {
    cloudReady: false,
    cloudError: '',
    openid: '',
    theme: 'light',
    pendingEditId: ''   // 清单页点编辑 → 切到日历页后要回填的任务
  },

  onLaunch: function () {
    // 主题
    try {
      var s = wx.getStorageSync(CFG.SETTINGS_KEY) || {};
      this.globalData.theme = s.theme === 'dark' ? 'dark' : 'light';
    } catch (e) {}

    // 云开发初始化
    if (!wx.cloud) {
      this.globalData.cloudError = '基础库版本过低，请把调试基础库调到 2.2.3 以上';
      return;
    }
    try {
      var opts = { traceUser: true };
      if (CFG.CLOUD_ENV) opts.env = CFG.CLOUD_ENV;   // 不填则用控制台的默认环境
      wx.cloud.init(opts);
      this.globalData.cloudReady = true;
    } catch (e) {
      this.globalData.cloudError = '云开发初始化失败：' + (e.message || e);
    }
  },

  setTheme: function (theme) {
    this.globalData.theme = theme;
    try {
      var s = wx.getStorageSync(CFG.SETTINGS_KEY) || {};
      s.theme = theme;
      wx.setStorageSync(CFG.SETTINGS_KEY, s);
    } catch (e) {}
  }
});
