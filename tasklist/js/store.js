/* =========================================================
 * 任务清单 - 本地数据层
 *
 * 设计要点：
 *   - 任务对象：{ id, title, note, due_date, status, priority,
 *                 defer_count, completed_at, deleted_at, created_at, updated_at }
 *   - id 优先用 crypto.randomUUID，兼容降级到时间戳随机串；
 *   - 删除一律软删除（deleted_at），否则另一台设备会把已删任务同步回来；
 *   - pending 记录「本机改过、还没推上云端」的任务 id，随数据一起持久化，
 *     刷新 / 断网都不会丢；
 *   - 与云端合并采用 last-write-wins：按 updated_at 取较新的一份。
 * ========================================================= */

window.TaskStore = (function () {
  'use strict';

  const BASE_KEY = 'taskList.v1';
  let tasks = {};     // id -> task（含软删除的）
  let pending = {};   // id -> true（待推送）
  let booted = false;
  let scope = '';     // 账号作用域：不同账号的本地缓存互不可见

  /** 当前账号对应的 localStorage 键 */
  function storageKey() { return BASE_KEY + (scope ? ':' + scope : ''); }

  /* ---------------- 日期工具 ---------------- */

  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayStr() { return fmtDate(new Date()); }

  function parseDate(s) {
    const p = String(s || '').split('-').map(Number);
    return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
  }

  function addDays(d, n) {
    const x = new Date(d.getTime());
    x.setDate(x.getDate() + n);
    return x;
  }

  function nowISO() { return new Date().toISOString(); }

  /* ---------------- 持久化 ---------------- */

  function persist() {
    try {
      localStorage.setItem(storageKey(), JSON.stringify({ tasks: tasks, pending: pending }));
    } catch (e) { console.warn('[Store] 本地保存失败', e); }
  }

  function readKey(k) {
    try {
      const raw = localStorage.getItem(k);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return { tasks: (data && data.tasks) || {}, pending: (data && data.pending) || {} };
    } catch (e) {
      console.warn('[Store] 本地数据损坏，已重置', e);
      return null;
    }
  }

  function load() {
    if (booted) return;
    booted = true;
    const data = readKey(storageKey());
    if (data) { tasks = data.tasks; pending = data.pending; }
  }

  /**
   * 切换账号：把本地缓存切到该账号独立的一份。
   * uid 为空表示未登录（回落到公共区，正常不会有人在这里写数据）。
   * 首次为某账号建立缓存时，若公共区里有旧数据（升级前的版本留下的），
   * 迁移过来并删掉公共区，避免之后换账号时又串给别人。
   */
  function bindUser(uid) {
    const next = String(uid || '');
    if (next === scope) return false;
    const legacy = next ? readKey(BASE_KEY) : null;
    scope = next;
    booted = false;
    tasks = {}; pending = {};
    load();
    if (legacy && !Object.keys(tasks).length) {
      tasks = legacy.tasks; pending = legacy.pending;
      persist();
      try { localStorage.removeItem(BASE_KEY); } catch (e) { /* 忽略 */ }
    }
    return true;
  }

  /* ---------------- 基础 ---------------- */

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // 降级：手写 uuid v4（表主键是 uuid 类型，格式必须合法，否则云端写入会被拒）
    const hex = '0123456789abcdef';
    let out = '';
    for (let i = 0; i < 36; i++) {
      if (i === 8 || i === 13 || i === 18 || i === 23) { out += '-'; continue; }
      if (i === 14) { out += '4'; continue; }
      const r = Math.floor(Math.random() * 16);
      out += i === 19 ? hex[(r & 0x3) | 0x8] : hex[r];
    }
    return out;
  }

  function normDate(s) {
    // 归一为 YYYY-MM-DD；非法输入回落到今天
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim());
    if (!m) return todayStr();
    return m[1] + '-' + pad2(+m[2]) + '-' + pad2(+m[3]);
  }

  function touch(t) {
    t.updated_at = nowISO();
    pending[t.id] = true;
    persist();
  }

  /* ---------------- CRUD ---------------- */

  function create(fields) {
    const t = {
      id: uid(),
      title: String((fields && fields.title) || '').trim().slice(0, 200),
      note: String((fields && fields.note) || '').trim().slice(0, 2000),
      due_date: normDate(fields && fields.due),
      status: 'todo',
      priority: Number((fields && fields.priority) || 0) || 0,
      defer_count: 0,
      completed_at: null,
      deleted_at: null,
      created_at: nowISO(),
      updated_at: nowISO()
    };
    if (!t.title) return null;
    tasks[t.id] = t;
    pending[t.id] = true;
    persist();
    return t;
  }

  function patch(id, changes) {
    const t = tasks[id];
    if (!t) return null;
    if (changes && typeof changes.title === 'string') {
      const v = changes.title.trim().slice(0, 200);
      if (v) t.title = v;
    }
    if (changes && typeof changes.note === 'string') t.note = changes.note.trim().slice(0, 2000);
    if (changes && changes.due) t.due_date = normDate(changes.due);
    if (changes && Number.isFinite(changes.priority)) t.priority = changes.priority;
    touch(t);
    return t;
  }

  function setDone(id, done) {
    const t = tasks[id];
    if (!t || t.deleted_at) return null;
    t.status = done ? 'done' : 'todo';
    t.completed_at = done ? nowISO() : null;
    touch(t);
    return t;
  }

  function deferTo(id, dateStr) {
    const t = tasks[id];
    if (!t || t.deleted_at) return null;
    const next = normDate(dateStr);
    if (next === t.due_date) return t;
    t.due_date = next;
    t.defer_count = (t.defer_count || 0) + 1;
    if (t.status === 'done') { t.status = 'todo'; t.completed_at = null; }
    touch(t);
    return t;
  }

  function softDelete(id) {
    const t = tasks[id];
    if (!t) return null;
    t.deleted_at = nowISO();
    touch(t);
    return t;
  }

  /* ---------------- 查询 ---------------- */

  function get(id) { return tasks[id] || null; }

  /** 有效任务（未软删除） */
  function all() {
    return Object.values(tasks).filter(function (t) { return !t.deleted_at; });
  }

  /** 含软删除，供同步用 */
  function raw() { return Object.values(tasks); }

  function onDate(dateStr) {
    const s = normDate(dateStr);
    return all().filter(function (t) { return t.due_date === s; });
  }

  function isOverdue(t, refStr) {
    if (t.deleted_at) return false;
    return t.status === 'todo' && t.due_date < (refStr || todayStr());
  }

  /** 需要推送的任务（本机改过、还没确认推上去的） */
  function pendingRows() {
    return Object.keys(pending)
      .map(function (id) { return tasks[id]; })
      .filter(Boolean);
  }

  function clearPending(ids) {
    (ids || []).forEach(function (id) { delete pending[id]; });
    persist();
  }

  /* ---------------- 云端合并（LWW） ---------------- */

  function rowToTask(r) {
    return {
      id: String(r.id),
      title: String(r.title || ''),
      note: String(r.note || ''),
      due_date: normDate(r.due_date),
      status: r.status === 'done' ? 'done' : 'todo',
      priority: Number(r.priority) || 0,
      defer_count: Number(r.defer_count) || 0,
      completed_at: r.completed_at || null,
      deleted_at: r.deleted_at || null,
      created_at: r.created_at || nowISO(),
      updated_at: r.updated_at || nowISO()
    };
  }

  /**
   * 把云端行合并进本地：updated_at 较新者胜。
   * 返回被远端覆盖/新增的任务 id 列表（这些不再需要推送）。
   */
  function mergeRemote(rows) {
    if (!Array.isArray(rows)) return [];
    const wonByRemote = [];
    rows.forEach(function (r) {
      if (!r || !r.id) return;
      const remote = rowToTask(r);
      const local = tasks[remote.id];
      if (!local) {
        tasks[remote.id] = remote;
        if (!remote.deleted_at) wonByRemote.push(remote.id);
        return;
      }
      const ru = new Date(remote.updated_at).getTime() || 0;
      const lu = new Date(local.updated_at).getTime() || 0;
      if (ru > lu) {
        tasks[remote.id] = remote;
        delete pending[remote.id];      // 远端较新，放弃本机待推版本
        wonByRemote.push(remote.id);
      }
    });
    persist();
    return wonByRemote;
  }

  /** 推送成功后调用 */
  function markSynced(ids) { clearPending(ids); }

  /** 清空本地（退出登录时可选使用；保留默认不清，避免误删） */
  function reset() { tasks = {}; pending = {}; persist(); }

  function stats(refStr) {
    const today = refStr || todayStr();
    const list = all();
    const todoToday = list.filter(function (t) {
      return t.status === 'todo' && t.due_date === today;
    }).length;
    const overdue = list.filter(function (t) { return isOverdue(t, today); }).length;
    const doneToday = list.filter(function (t) {
      return t.status === 'done' && t.completed_at &&
        t.completed_at.slice(0, 10) === today;
    }).length;
    // 本周（含今天起的 7 天）完成率
    const weekEnd = fmtDate(addDays(parseDate(today), 6));
    const inWeek = list.filter(function (t) { return t.due_date >= today && t.due_date <= weekEnd; });
    const doneInWeek = inWeek.filter(function (t) { return t.status === 'done'; }).length;
    const rate = inWeek.length ? Math.round(doneInWeek / inWeek.length * 100) : null;
    return { todoToday: todoToday, overdue: overdue, doneToday: doneToday, weekRate: rate };
  }

  load();

  return {
    create: create,
    patch: patch,
    setDone: setDone,
    deferTo: deferTo,
    softDelete: softDelete,
    get: get,
    all: all,
    raw: raw,
    onDate: onDate,
    isOverdue: isOverdue,
    pendingRows: pendingRows,
    markSynced: markSynced,
    mergeRemote: mergeRemote,
    bindUser: bindUser,
    storageKey: storageKey,
    reset: reset,
    stats: stats,
    todayStr: todayStr,
    fmtDate: fmtDate,
    parseDate: parseDate,
    addDays: addDays,
    persist: persist
  };
})();
