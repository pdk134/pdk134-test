var CFG = require('../../config.js');

var FEATURES = [
  { icon: '🗓️', title: '日历', sub: '按月查看每天的任务安排，点一下日期就能快速添加' },
  { icon: '✅', title: '清单', sub: '按逾期、今天、明天等自动分组，完成率一目了然' },
  { icon: '🌸', title: '月记', sub: '标记经期、记录症状心情，自动预测下次经期并分析规律' }
];

var FAQS = [
  {
    q: '经期预测是怎么算出来的？',
    a: '根据你已记录的经期历史计算平均周期和经期长度，记录越完整越贴近你的实际情况；刚开始使用时会先用通用默认值。预测仅供参考，不构成医疗诊断或建议。'
  }
];

function readVersion() {
  var online = '';
  try {
    var info = wx.getAccountInfoSync();
    online = (info && info.miniProgram && info.miniProgram.version) || '';
  } catch (e) {}
  return online || CFG.APP_VERSION;
}

Page({
  data: {
    theme: 'light',
    appName: CFG.APP_NAME,
    appDesc: CFG.APP_DESC,
    version: '',
    features: FEATURES,
    faqs: FAQS,
    activeIndex: -1
  },

  onLoad: function () {
    this.setData({ version: readVersion() });
    this.applyTheme();
  },

  onShow: function () {
    this.applyTheme();
  },

  applyTheme: function () {
    var theme = getApp().globalData.theme;
    if (theme !== this.data.theme) this.setData({ theme: theme });
    wx.setNavigationBarColor({
      frontColor: '#ffffff',
      backgroundColor: theme === 'dark' ? '#17292a' : '#2f9e8f'
    });
  },

  toggleFaq: function (e) {
    var idx = Number(e.currentTarget.dataset.idx);
    this.setData({ activeIndex: this.data.activeIndex === idx ? -1 : idx });
  },

  copyInfo: function () {
    var sys = {};
    try { sys = wx.getSystemInfoSync() || {}; } catch (e) {}
    var lines = [
      CFG.APP_NAME + ' v' + this.data.version,
      '微信 ' + (sys.version || '未知') + ' · 基础库 ' + (sys.SDKVersion || '未知'),
      '系统 ' + (sys.system || '未知'),
      '云开发 ' + (getApp().globalData.cloudReady ? '已就绪' : '离线')
    ];
    wx.setClipboardData({ data: lines.join('\n') });
    wx.showToast({ title: '已复制，可粘贴到反馈中', icon: 'none', duration: 1800 });
  }
});
