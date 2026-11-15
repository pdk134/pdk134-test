/* =========================================================
 * 月记小程序 - 微信云开发同步
 *
 * 集合：period_data（权限「仅创建者可读写」）
 *   - 一个微信用户一份数据，doc id = 'p_' + scope（scope 优先取 openid）
 *   - 写入用 doc(id).set() 整包覆盖本机文档；但整包内容来自「合并了云端
 *     所有文档后的最新状态」，因此不会覆盖掉别的设备新增的内容
 *   - 合并按字段时间戳（见 period-store.js），取消标记也能同步
 *   - 拉取时把当前用户名下所有文档都取出来合并（云函数没部署、每台设备
 *     各写一个文档时仍能汇聚数据）
 * ========================================================= */

var CFG = require('../config.js');
var Store = require('./period-store.js');

var COLL = CFG.PERIOD_COLLECTION;
var PAGE_SIZE = 20;
var db = null;
var pushTimer = null;
var booted = false;
var listeners = [];
var docId = '';
var state = {
  status: 'checking',   // checking | ready | syncing | offline | error
  message: '',
  lastSync: 0,
  scope: '',
  cloudReady: false
};

function emit(msg) {
  if (msg !== undefined) state.message = msg;
  for (var i = 0; i < listeners.length; i++) {
    try { listeners[i](state); } catch (e) {}
  }
}
function fail(e) {
  var msg = (e && (e.message || e.errMsg)) || String(e || '同步失败');
  if (/collection not exists|collection.*not.*exist|DATABASE_COLLECTION_NOT_EXIST/i.test(msg)) {
    msg = '请先在云开发控制台创建 ' + COLL + ' 集合';
  } else if (/permission denied|PERMISSION_DENIED|not authorized/i.test(msg)) {
    msg = '集合权限请设为「仅创建者可读写」';
  } else if (/cloud.*not.*init|env.*not.*exist|ENV_NOT_EXIST/i.test(msg)) {
    msg = '云开发未开通，请在开发者工具里开通并选好环境';
  }
  state.status = 'error';
  emit(msg);
}
function dbRef() {
  if (db) return db;
  if (!wx.cloud) return null;
  db = wx.cloud.database();
  return db;
}

/* ---------------- 本机 scope（用于本地缓存分键 + 云端 doc id） ---------------- */
function localScope() {
  var k = CFG.PERIOD_SCOPE_KEY;
  var v = '';
  try { v = wx.getStorageSync(k) || ''; } catch (e) {}
  if (!v) {
    v = 'local-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    try { wx.setStorageSync(k, v); } catch (e) {}
  }
  return v;
}
function resolveScope() {
  if (state.scope) return Promise.resolve(state.scope);
  var d = dbRef();
  if (!d) {
    state.scope = localScope();
    Store.bindUser(state.scope);
    return Promise.resolve(state.scope);
  }
  function fromCloudFunction() {
    return wx.cloud.callFunction({ name: 'login' })
      .then(function (r) { return r && r.result && r.result.openid ? r.result.openid : ''; })
      .catch(function () { return ''; });   // 云函数没部署也不影响使用
  }
  function fromExistingRow() {
    return d.collection(COLL).limit(1).get()
      .then(function (r) { return r.data[0] && r.data[0]._openid ? r.data[0]._openid : ''; })
      .catch(function () { return ''; });
  }
  return fromCloudFunction().then(function (id) {
    return id || fromExistingRow();
  }).then(function (id) {
    state.scope = id || localScope();
    docId = 'p_' + state.scope;
    Store.bindUser(state.scope);
    return state.scope;
  });
}

/* ---------------- 拉取：取当前用户全部文档并合并 ---------------- */
function fetchAll(d) {
  var all = [], skip = 0;
  function step() {
    return d.collection(COLL).skip(skip).limit(PAGE_SIZE).get()
      .then(function (r) {
        var rows = r.data || [];
        all = all.concat(rows);
        if (rows.length < PAGE_SIZE || skip > 3000) return all;
        skip += PAGE_SIZE;
        return step();
      });
  }
  return step();
}

function pull(silent) {
  var d = dbRef();
  if (!d) { state.status = 'offline'; if (!silent) emit('离线模式，数据只存在本机'); return Promise.resolve(false); }
  return resolveScope().then(function () { return fetchAll(d); })
    .then(function (rows) {
      var changed = false;
      for (var i = 0; i < rows.length; i++) {
        if (Store.mergeRemote(rows[i])) changed = true;
      }
      // 内容有合并，或本机有未推送改动 -> 写回，让其它设备也能拿到
      if (changed || Store.isDirty()) {
        return push(silent).then(function (ok) {
          state.lastSync = Date.now();
          if (ok) { state.status = 'ready'; if (!silent) emit(''); }
          return ok;
        });
      }
      state.lastSync = Date.now();
      state.status = 'ready';
      if (!silent) emit('');
      return true;
    })
    .catch(function (e) { fail(e); return false; });
}

/* ---------------- 推送：整包覆盖本机文档 ---------------- */
function push(silent) {
  var d = dbRef();
  if (!d) { state.status = 'offline'; return Promise.resolve(false); }
  return resolveScope().then(function () {
    if (!docId) docId = 'p_' + state.scope;
    return d.collection(COLL).doc(docId).set({ data: Store.toRow() });
  }).then(function () {
    Store.markSynced();
    state.lastSync = Date.now();
    state.status = 'ready';
    if (!silent) emit('已同步');
    return true;
  }).catch(function (e) { fail(e); return false; });
}

function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(function () { push(true); }, CFG.PUSH_DELAY);
}

/* ---------------- 初始化 ---------------- */
function init() {
  if (booted) return Promise.resolve(state);
  booted = true;
  var app = getApp();
  // 两重判断：基础库不提供 wx.cloud 时，即使 app.js 里标记过也要降级
  state.cloudReady = !!(app && app.globalData && app.globalData.cloudReady) && !!wx.cloud;
  if (!state.cloudReady) {
    resolveScope();   // 仍然分好本地缓存键
    state.status = 'offline';
    emit((app && app.globalData && app.globalData.cloudError) || '云开发不可用，已切换为离线模式');
    return Promise.resolve(state);
  }
  state.status = 'syncing';
  emit('正在同步…');
  return pull(true).then(function (ok) {
    if (ok) { state.status = 'ready'; emit(''); }
    return state;
  });
}

module.exports = {
  init: init, pull: pull, push: push, schedulePush: schedulePush,
  state: function () { return state; },
  onChange: function (fn) { listeners.push(fn); },
  resolveScope: resolveScope
};
