/* =========================================================
 * 任务清单小程序 - 微信云开发同步
 *
 * 集合：tasks（权限「仅创建者可读写」）
 *   - 每条任务一个文档，_id 直接用业务 uuid；_openid 由平台自动写入
 *   - 读取自动按 openid 隔离，不需要写 where、也不需要自己管 user_id
 *   - 写入用 doc(id).set()，存在即覆盖、不存在即创建，天然适合 LWW
 *   - 客户端单次 get 最多 20 条，所以分页循环拉全量
 * ========================================================= */

var CFG = require('../config.js');
var Store = require('./store.js');

var COLL = CFG.COLLECTION;
var PAGE_SIZE = 20;
var db = null;
var pushTimer = null;
var booted = false;
var listeners = [];
var state = {
  status: 'checking',   // checking | ready | syncing | offline | error
  message: '',
  lastSync: 0,
  openid: '',
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

/* ---------------- openid ---------------- */
function resolveOpenId() {
  if (state.openid) return Promise.resolve(state.openid);
  var d = dbRef();
  if (!d) return Promise.resolve('');

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
    state.openid = id || 'local';
    Store.bindUser(state.openid);
    return state.openid;
  });
}

/* ---------------- 拉取 ---------------- */
function fetchAll(d) {
  var all = [], skip = 0;
  // 双保险：权限设为「仅创建者可读写」后平台本就会过滤，
  // 这里再显式按 _openid 过滤一次，避免后台权限配错导致串数据
  var q = d.collection(COLL);
  if (state.openid && state.openid !== 'local') q = q.where({ _openid: state.openid });
  function step() {
    return q.orderBy('updated_at', 'asc')
      .skip(skip).limit(PAGE_SIZE).get()
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
  return resolveOpenId().then(function () {
    return fetchAll(d);
  }).then(function (rows) {
    state.lastSync = Date.now();
    Store.mergeRemote(rows);
    if (Store.pendingRows().length) return push(silent);
    state.status = 'ready';
    if (!silent) emit('');
    return true;
  }).catch(function (e) { fail(e); return false; });
}

/* ---------------- 推送 ---------------- */
function push(silent) {
  var d = dbRef();
  if (!d) { state.status = 'offline'; return Promise.resolve(false); }
  var rows = Store.pendingRows();
  if (!rows.length) { state.status = 'ready'; return Promise.resolve(true); }

  // 顺序写，避免并发过高被限流；任务量是个人级，耗时可忽略
  var i = 0, synced = [];
  function step() {
    if (i >= rows.length) return Promise.resolve();
    var t = rows[i++];
    return d.collection(COLL).doc(t.id).set({ data: Store.toRow(t) })
      .then(function () { synced.push(t.id); return step(); });
  }
  return step().then(function () {
    Store.markSynced(synced);
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
  state.cloudReady = !!(app && app.globalData && app.globalData.cloudReady);
  if (!state.cloudReady) {
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
  resolveOpenId: resolveOpenId
};
