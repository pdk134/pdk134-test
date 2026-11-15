var CFG = require('../config.js');

var ENABLED_KEY = 'taskList.mp.remindEnabled';

/** 默认开启；关闭后新建任务不再申请订阅授权 */
function enabled() {
  try { return wx.getStorageSync(ENABLED_KEY) !== false; } catch (e) { return true; }
}
function setEnabled(v) {
  try { wx.setStorageSync(ENABLED_KEY, !!v); } catch (e) {}
}

/**
 * 一次性订阅：一次授权只能收一条提醒，所以在每次新建任务时申请一次额度。
 * 必须由用户点击触发，只能在事件回调里同步调用（这里是 quickAdd）。
 */
function requestAuth() {
  if (!enabled() || !CFG.REMIND_TMPL_ID || !wx.requestSubscribeMessage) return;
  wx.requestSubscribeMessage({
    tmplIds: [CFG.REMIND_TMPL_ID],
    success: function (res) {
      if (res && res[CFG.REMIND_TMPL_ID] !== 'accept') {
        console.warn('[remind] 用户未授权订阅提醒', res);
      }
    },
    fail: function (e) { console.warn('[remind] 订阅授权失败', e); }
  });
}

/** 「我的」页测试入口：点击授权后从小程序端触发云函数，立即给自己发一条 */
function sendTest() {
  if (!wx.requestSubscribeMessage || !wx.cloud || !wx.cloud.callFunction) {
    wx.showToast({ title: '当前环境不支持订阅消息', icon: 'none', duration: 1500 });
    return;
  }
  wx.requestSubscribeMessage({
    tmplIds: [CFG.REMIND_TMPL_ID],
    success: function (res) {
      if (!res || res[CFG.REMIND_TMPL_ID] !== 'accept') {
        wx.showToast({ title: '需要先允许订阅', icon: 'none', duration: 1500 });
        return;
      }
      wx.showLoading({ title: '发送中' });
      wx.cloud.callFunction({ name: 'remind', data: { test: true } })
        .then(function (r) {
          wx.hideLoading();
          var out = (r && r.result) || {};
          wx.showModal({
            title: out.ok ? '发送成功' : '发送失败',
            content: out.ok ? '去微信「服务通知」查看' : String(out.reason || '请查看云函数日志'),
            showCancel: false
          });
        })
        .catch(function (e) {
          wx.hideLoading();
          wx.showModal({
            title: '调用失败',
            content: String((e && e.message) || e),
            showCancel: false
          });
        });
    },
    fail: function (e) {
      console.warn('[remind] 测试授权失败', e);
      wx.showToast({ title: '订阅授权失败', icon: 'none', duration: 1500 });
    }
  });
}

module.exports = {
  enabled: enabled,
  setEnabled: setEnabled,
  requestAuth: requestAuth,
  sendTest: sendTest
};
