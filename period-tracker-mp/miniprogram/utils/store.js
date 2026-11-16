/* =========================================================
 * 任务清单小程序 - 本地数据层
 *
 * 与网页版保持同一套字段和 LWW 规则，方便以后互相迁移：
 *   { id, title, note, due_date, status, priority, defer_count,
 *     original_due_date, completed_at, deleted_at, created_at, updated_at }
 * 差异：localStorage -> wx.setStorageSync；window.TaskStore -> module.exports
 * ========================================================= */

var CFG = require('../config.js');

var BASE_KEY = CFG.STORAGE_PREFIX;
var tasks = {};      // id -> task（含软删除）
var pending = {};    // id -> true（本机改过、还没推上云端）
var booted = false;
var scope = '';      // 按 openid 分键

function storageKey() { return BASE_KEY + (scope ? ':' + scope : ''); }

/* ---------------- 日期工具 ---------------- */
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function todayStr() { return fmtDate(new Date()); }
function parseDate(s) {
  var p = String(s || '').split('-').map(Number);
  return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
}
function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function nowISO() { return new Date().toISOString(); }
function normDate(s) {
  var m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return todayStr();
  return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
}
function normTime(s) {
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return '';
  var h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return pad2(h) + ':' + pad2(mi);
}
/** 提醒时刻 = 到期日 + 具体时间 - 提前分钟；时间为空则不参与分钟级提醒 */
function calcRemindAt(dueDate, dueTime, before) {
  var tm = normTime(dueTime);
  if (!tm) return '';
  var p = tm.split(':');
  var mins = Number(p[0]) * 60 + Number(p[1]) - (Math.max(0, Number(before) || 0));
  var offset = 0;
  while (mins < 0) { mins += 1440; offset--; }
  while (mins >= 1440) { mins -= 1440; offset++; }
  var d = addDays(parseDate(normDate(dueDate)), offset);
  return fmtDate(d) + ' ' + pad2(Math.floor(mins / 60)) + ':' + pad2(mins % 60);
}

/* ---------------- 持久化 ---------------- */
function persist() {
  try { wx.setStorageSync(storageKey(), { tasks: tasks, pending: pending }); }
  catch (e) { console.warn('[Store] 本地保存失败', e); }
}
function readKey(k) {
  try {
    var raw = wx.getStorageSync(k);
    if (!raw) return null;
    return { tasks: raw.tasks || {}, pending: raw.pending || {} };
  } catch (e) { return null; }
}
function load() {
  if (booted) return;
  booted = true;
  var data = readKey(storageKey());
  if (data) { tasks = data.tasks; pending = data.pending; }
}
/** 切换 openid：不同微信账号的本地缓存互不可见；旧公共区数据迁移一次 */
function bindUser(uid) {
  var next = String(uid || '');
  if (next === scope) return false;
  var legacy = next ? readKey(BASE_KEY) : null;
  scope = next; booted = false; tasks = {}; pending = {};
  load();
  if (legacy && !Object.keys(tasks).length) {
    tasks = legacy.tasks; pending = legacy.pending;
    persist();
    try { wx.removeStorageSync(BASE_KEY); } catch (e) {}
  }
  return true;
}

function uid() {
  // 手写 uuid v4：小程序没有 crypto.randomUUID，且 _id 要合法
  var hex = '0123456789abcdef', out = '', r, i;
  for (i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue; }
    if (i === 14) { out += '4'; continue; }
    r = Math.floor(Math.random() * 16);
    out += i === 19 ? hex[(r & 0x3) | 0x8] : hex[r];
  }
  return out;
}
function touch(t) { t.updated_at = nowISO(); pending[t.id] = true; persist(); }

/* ---------------- CRUD ---------------- */
function create(fields) {
  fields = fields || {};
  var t = {
    id: uid(),
    title: String(fields.title || '').trim().slice(0, 200),
    note: String(fields.note || '').trim().slice(0, 2000),
    due_date: normDate(fields.due),
    due_time: normTime(fields.time),
    remind_before: Math.max(0, Math.min(1440, Number(fields.before) || 0)),
    remind_at: '',
    status: 'todo',
    priority: Number(fields.priority) || 0,
    defer_count: 0,
    original_due_date: null,
    completed_at: null,
    deleted_at: null,
    created_at: nowISO(),
    updated_at: nowISO()
  };
  if (!t.title) return null;
  t.remind_at = calcRemindAt(t.due_date, t.due_time, t.remind_before);
  tasks[t.id] = t; pending[t.id] = true; persist();
  return t;
}
function patch(id, changes) {
  var t = tasks[id]; if (!t) return null;
  changes = changes || {};
  if (typeof changes.title === 'string' && changes.title.trim()) t.title = changes.title.trim().slice(0, 200);
  if (typeof changes.note === 'string') t.note = changes.note.trim().slice(0, 2000);
  if (changes.due) t.due_date = normDate(changes.due);
  if (typeof changes.time === 'string') t.due_time = normTime(changes.time);
  if (typeof changes.before === 'number' && isFinite(changes.before)) {
    t.remind_before = Math.max(0, Math.min(1440, Math.round(changes.before)));
  }
  t.remind_at = calcRemindAt(t.due_date, t.due_time, t.remind_before);
  if (typeof changes.priority === 'number' && isFinite(changes.priority)) t.priority = changes.priority;
  touch(t); return t;
}
function setDone(id, done) {
  var t = tasks[id]; if (!t || t.deleted_at) return null;
  t.status = done ? 'done' : 'todo';
  t.completed_at = done ? nowISO() : null;
  touch(t); return t;
}
function deferTo(id, dateStr) {
  var t = tasks[id]; if (!t || t.deleted_at) return null;
  var next = normDate(dateStr);
  if (next === t.due_date) return t;
  if (!t.original_due_date) t.original_due_date = t.due_date;
  t.due_date = next;
  t.remind_at = calcRemindAt(t.due_date, t.due_time, t.remind_before);
  t.defer_count = (t.defer_count || 0) + 1;
  if (t.status === 'done') { t.status = 'todo'; t.completed_at = null; }
  touch(t); return t;
}
function softDelete(id) {
  var t = tasks[id]; if (!t) return null;
  t.deleted_at = nowISO(); touch(t); return t;
}

/* ---------------- 查询 ---------------- */
function get(id) { return tasks[id] || null; }
function values() { return Object.keys(tasks).map(function (k) { return tasks[k]; }); }
function all() { return values().filter(function (t) { return !t.deleted_at; }); }
function raw() { return values(); }
function onDate(dateStr) {
  var s = normDate(dateStr);
  return all().filter(function (t) { return t.due_date === s; });
}
function isOverdue(t, refStr) {
  if (t.deleted_at) return false;
  return t.status === 'todo' && t.due_date < (refStr || todayStr());
}
function pendingRows() {
  return Object.keys(pending).map(function (id) { return tasks[id]; }).filter(Boolean);
}
function clearPending(ids) {
  (ids || []).forEach(function (id) { delete pending[id]; });
  persist();
}

/* ---------------- 云端合并（LWW） ---------------- */
function rowToTask(r) {
  return {
    id: String(r.id || r._id),
    title: String(r.title || ''),
    note: String(r.note || ''),
    due_date: normDate(r.due_date),
    due_time: normTime(r.due_time),
    remind_before: Math.max(0, Math.min(1440, Number(r.remind_before) || 0)),
    remind_at: calcRemindAt(normDate(r.due_date), normTime(r.due_time), Number(r.remind_before) || 0),
    status: r.status === 'done' ? 'done' : 'todo',
    priority: Number(r.priority) || 0,
    defer_count: Number(r.defer_count) || 0,
    original_due_date: r.original_due_date ? normDate(r.original_due_date) : '',
    completed_at: r.completed_at || null,
    deleted_at: r.deleted_at || null,
    created_at: r.created_at || nowISO(),
    updated_at: r.updated_at || nowISO()
  };
}
function mergeRemote(rows) {
  if (!Array.isArray(rows)) return [];
  var wonByRemote = [];
  rows.forEach(function (r) {
    if (!r || !(r.id || r._id)) return;
    var remote = rowToTask(r), local = tasks[remote.id];
    if (!local) {
      tasks[remote.id] = remote;
      if (!remote.deleted_at) wonByRemote.push(remote.id);
      return;
    }
    var ru = new Date(remote.updated_at).getTime() || 0;
    var lu = new Date(local.updated_at).getTime() || 0;
    if (ru > lu) {
      tasks[remote.id] = remote;
      delete pending[remote.id];
      wonByRemote.push(remote.id);
    }
  });
  persist();
  return wonByRemote;
}
function markSynced(ids) { clearPending(ids); }
function toRow(t) {
  return {
    id: t.id, title: t.title, note: t.note || '', due_date: t.due_date,
    due_time: t.due_time || '', remind_before: Number(t.remind_before) || 0,
    remind_at: t.remind_at || '',
    status: t.status === 'done' ? 'done' : 'todo',
    priority: Number(t.priority) || 0, defer_count: Number(t.defer_count) || 0,
    original_due_date: t.original_due_date || '',
    completed_at: t.completed_at || null, deleted_at: t.deleted_at || null,
    created_at: t.created_at, updated_at: t.updated_at
  };
}
function reset() { tasks = {}; pending = {}; persist(); }

function stats(refStr) {
  var today = refStr || todayStr(), list = all();
  var todoToday = list.filter(function (t) { return t.status === 'todo' && t.due_date === today; }).length;
  var overdue = list.filter(function (t) { return isOverdue(t, today); }).length;
  var doneToday = list.filter(function (t) {
    return t.status === 'done' && t.completed_at && t.completed_at.slice(0, 10) === today;
  }).length;
  var weekEnd = fmtDate(addDays(parseDate(today), 6));
  var inWeek = list.filter(function (t) { return t.due_date >= today && t.due_date <= weekEnd; });
  var doneInWeek = inWeek.filter(function (t) { return t.status === 'done'; }).length;
  return {
    todoToday: todoToday, overdue: overdue, doneToday: doneToday,
    weekRate: inWeek.length ? Math.round(doneInWeek / inWeek.length * 100) : null
  };
}

load();

module.exports = {
  create: create, patch: patch, setDone: setDone, deferTo: deferTo,
  softDelete: softDelete, get: get, all: all, raw: raw, onDate: onDate,
  isOverdue: isOverdue, pendingRows: pendingRows, markSynced: markSynced,
  mergeRemote: mergeRemote, rowToTask: rowToTask, toRow: toRow,
  bindUser: bindUser, storageKey: storageKey, reset: reset,
  stats: stats, persist: persist,
  todayStr: todayStr, fmtDate: fmtDate, parseDate: parseDate,
  addDays: addDays, normDate: normDate
};
