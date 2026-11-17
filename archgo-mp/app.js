/**
 * 架构术语学习通 · 小程序全局入口
 * 职责：初始化存储层 / SRS / 术语库，挂到全局供各页面使用。
 * 说明：Web 版的登录门禁在原生版取消——小程序以微信 openid 为身份，
 *       「账号」页只放微信一键登录与云同步入口（考后实现）。
 */
const Store = require('./libs/store.js');
const SRS = require('./libs/srs.js');
const TERMS = require('./data/terms.js');

App({
  onLaunch() {
    Store.load();
    this.globalData = { Store, SRS, TERMS };
  },
  // 小程序切后台 / 结束前立即落盘：save() 有 120ms 防抖，
  // 若在防抖窗口内被微信回收进程，最后一次学习记录会丢
  onAppHide() {
    Store.flush();
  },
  globalData: {}
});
