var CFG = require('../config.js');

var ENABLED_KEY = 'taskList.mp.remindEnabled';
var STATE_KEY = 'taskList.mp.remindAuth';

// 续期节奏：两次申请至少隔 90 分钟，每天最多 4 次；
// 累计授权成功 3 次以上（说明用户勾了「总是保持以上选择」，调用不再弹窗）放宽到 8 次。
var GAP_MS = 90 * 60 * 1000;
var CAP_DEFAULT = 4;
var CAP_TRUSTED = 8;
var TRUST_ACCEPT = 3;

/** 默认开启；关闭后不再申请订阅授权 */
function enabled() {
  try { return wx.getStorageSync(ENABLED_KEY) !== false; } catch (e) { return true; }
}
function setEnabled(v) {
  try { wx.setStorageSync(ENABLED_KEY, !!v); } catch (e) {}
}

function readState() {
  try { return wx.getStorageSync(STATE_KEY) || {}; } catch (e) { return {}; }
}
function writeState(s) {
  try { wx.setStorageSync(STATE_KEY, s); } catch (e) {}
}
function dayKey() {
  var d = new Date();
  var p = function (n) { return n < 10 ? '0' + n : String(n); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 一次性订阅：一次授权只能收一条提醒，额度用完微信就直接拒发。
 * 所以除了新建任务，用户点日期、完成/推迟/编辑任务等操作时也顺手补一次额度。
 * 微信要求必须由用户点击触发，因此只能在事件回调里同步调用（内部全部是同步读写）。
 *
 * 已勾选「总是保持以上选择」的用户不会看到弹窗，额度静默累积；
 * 没勾选的会按上面的节流节奏偶尔弹一次，不至于每次点击都打扰。
 *
 * @param {boolean} force 用户主动开启提醒时传 true，跳过节流
 * @returns {boolean} 本次是否真的发起了申请
 */
function ensureAuth(force) {
  if (!enabled() || !CFG.REMIND_TMPL_ID || !wx.requestSubscribeMessage) return false;

  var st = readState();
  if (st.blocked && !force) return false;   // 用户在微信里关掉了订阅消息总开关

  var now = Date.now();
  var today = dayKey();
  if (st.day !== today) { st.day = today; st.count = 0; }
  if (!force) {
    var cap = (st.accepted || 0) >= TRUST_ACCEPT ? CAP_TRUSTED : CAP_DEFAULT;
    if ((st.count || 0) >= cap) return false;
    if (st.last && now - st.last < GAP_MS) return false;
  }
  st.last = now;
  st.count = (st.count || 0) + 1;
  writeState(st);

  wx.requestSubscribeMessage({
    tmplIds: [CFG.REMIND_TMPL_ID],
    success: function (res) {
      var s = readState();
      var r = res && res[CFG.REMIND_TMPL_ID];
      if (r === 'accept') s.accepted = (s.accepted || 0) + 1;
      else if (r === 'ban') s.blocked = true;
      else s.denied = (s.denied || 0) + 1;
      writeState(s);
      if (r !== 'accept') console.warn('[remind] 未获得订阅授权', r);
    },
    fail: function (e) {
      // 20004 = 用户关闭了订阅消息总开关，之后别再反复弹
      if (e && e.errCode === 20004) {
        var s2 = readState();
        s2.blocked = true;
        writeState(s2);
      }
      console.warn('[remind] 订阅申请失败', e);
    }
  });
  return true;
}

/** 兼容旧调用点（新建任务） */
function requestAuth() {
  return ensureAuth();
}

/** 「我的」页展示用：今日已续期次数、累计授权成功次数、是否被系统屏蔽 */
function status() {
  var s = readState();
  return {
    count: s.day === dayKey() ? (s.count || 0) : 0,
    accepted: s.accepted || 0,
    blocked: !!s.blocked
  };
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
      var r = res && res[CFG.REMIND_TMPL_ID];
      if (r !== 'accept') {
        if (r === 'ban') {
          var sb = readState();
          sb.blocked = true;
          writeState(sb);
        }
        wx.showToast({ title: '需要先允许订阅', icon: 'none', duration: 1500 });
        return;
      }
      var s = readState();
      s.accepted = (s.accepted || 0) + 1;
      s.blocked = false;
      writeState(s);

      wx.showLoading({ title: '发送中' });
      wx.cloud.callFunction({ name: 'remind', data: { test: true } })
        .then(function (r2) {
          wx.hideLoading();
          var out = (r2 && r2.result) || {};
          var content = out.ok ? '去微信「服务通知」查看' : String(out.reason || '请查看云函数日志');
          if (out.logError) {
            content += '\n\n日志未写入：' + out.logError +
              '\n在云开发控制台新建集合 remind_log 即可记录每次发送结果';
          }
          wx.showModal({
            title: out.ok ? '发送成功' : '发送失败',
            content: content,
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
  ensureAuth: ensureAuth,
  requestAuth: requestAuth,
  status: status,
  sendTest: sendTest
};
