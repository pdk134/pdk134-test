/**
 * 本地存储层（小程序移植版）：学习记录保存在 wx.Storage，卸载前不丢。
 * 数据结构：
 * {
 *   v: 2,
 *   updatedAt: 0,
 *   cards: { [术语]: { box, iv, due, reps, lapses, wrong, ease, last } },
 *   stats: { reviewed, correct, streak, lastDay, daily: { 'YYYY-MM-DD': { n, r, ok } } },
 *   settings: { dailyNew, dailyReview, autoSpeak, theme, ... }
 * }
 *
 * 与 Web 版的差异：
 *   - localStorage 换成 wx 同步存储适配层（_ls），其余逻辑原样保留；
 *   - 真题错题本 / 案例论文标记（exam / wrongExtra）随纯净版一并移除；
 *   - 云端同步改为钩子形式，考后接微信云开发时实现。
 *
 * 合并规则不变：进度类字段只升不降，永不整份覆盖，防数据丢失。
 */
module.exports = (function () {
  var KEY = 'arch-term-trainer-v1';
  var BAK_KEY = 'arch-term-backups';
  var MAX_BAK = 5;
  var DAY = 86400000;

  /* 小程序无 localStorage：用 wx 同步存储做适配层，接口保持一致 */
  var _ls = {
    getItem: function (k) { var v = wx.getStorageSync(k); return (v === '' || v === undefined || v === null) ? null : v; },
    setItem: function (k, v) { wx.setStorageSync(k, v); },
    removeItem: function (k) { wx.removeStorageSync(k); }
  };

  function empty() {
    return {
      v: 2,
      updatedAt: 0,
      cards: {},
      stats: { reviewed: 0, correct: 0, streak: 0, lastDay: '', daily: {} },
      settings: { dailyNew: 10, dailyReview: 60, autoSpeak: false, theme: 'dark', bgm: false, bgmVol: 35, sfx: true, sfxVol: 60 }
    };
  }

  function fillSettings(s) {
    var def = empty().settings, k;
    for (k in def) if (s[k] === undefined) s[k] = def[k];
    return s;
  }

  function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : (d || 0);
  }

  function normalizeCard(c) {
    c = c || {};
    return {
      box: num(c.box), iv: num(c.iv), due: num(c.due), reps: num(c.reps),
      lapses: num(c.lapses), wrong: num(c.wrong),
      ease: (typeof c.ease === 'number' && isFinite(c.ease)) ? c.ease : 2.5,
      last: num(c.last)
    };
  }

  /** 补齐缺失字段，兼容 v1 旧数据与云端快照 */
  function normalize(d) {
    if (!d || typeof d !== 'object') d = {};
    var k, kk;
    d.v = 2;
    d.updatedAt = num(d.updatedAt);
    if (!d.cards || typeof d.cards !== 'object') d.cards = {};
    for (k in d.cards) d.cards[k] = normalizeCard(d.cards[k]);

    var s = (d.stats && typeof d.stats === 'object') ? d.stats : {};
    d.stats = {
      reviewed: num(s.reviewed), correct: num(s.correct), streak: num(s.streak),
      lastDay: (typeof s.lastDay === 'string') ? s.lastDay : '', daily: {}
    };
    var day = (s.daily && typeof s.daily === 'object') ? s.daily : {};
    for (kk in day) {
      var o = day[kk] || {};
      d.stats.daily[kk] = { n: num(o.n), r: num(o.r), ok: num(o.ok) };
    }

    d.settings = fillSettings((d.settings && typeof d.settings === 'object') ? d.settings : {});

    return d;
  }

  /** v1 遗留：真题错题本 / 案例论文标记曾存在独立键里，迁入主数据（只增不减） */
  function migrateLegacy() {
    // 小程序为全新安装，不存在 Web 版遗留键；保留空实现供旧调用点兼容
    return false;
  }

  /* ---------------- 快照备份 ---------------- */
  function readBackups() {
    try { var a = JSON.parse(_ls.getItem(BAK_KEY)); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function writeBackups(a) {
    try { _ls.setItem(BAK_KEY, JSON.stringify(a.slice(0, MAX_BAK))); } catch (e) {}
  }
  /** 存一份当前完整数据到快照队列（最多 MAX_BAK 份，新→旧） */
  function snapshot(reason) {
    var a = readBackups();
    try { a.unshift({ t: Date.now(), reason: reason || '手动备份', data: JSON.parse(JSON.stringify(data)) }); }
    catch (e) { return false; }
    writeBackups(a);
    return true;
  }
  /** 衡量一份数据的「学习进度」：reps>0 的卡片数 */
  function progressOf(d) {
    var n = 0, k;
    if (d && d.cards) for (k in d.cards) if (num(d.cards[k].reps) > 0) n++;
    return n;
  }
  function listBackups() {
    return readBackups().map(function (b) {
      return {
        t: b.t,
        reason: b.reason,
        cards: progressOf(b.data),
        reviewed: num(b.data && b.data.stats && b.data.stats.reviewed)
      };
    });
  }
  /** 整份恢复到某个快照；恢复前先把当前状态也存一份，保证可来回切 */
  function restoreBackup(t) {
    var a = readBackups(), hit = null, i;
    for (i = 0; i < a.length; i++) if (a[i].t === t) hit = a[i];
    if (!hit) return false;
    snapshot('恢复前自动备份');
    data = normalize(hit.data);
    data.updatedAt = Date.now();
    save();
    return true;
  }
  function clearBackups() { try { _ls.removeItem(BAK_KEY); } catch (e) {} }

  /* ---------------- 加载 / 保存 ---------------- */
  var data;
  try {
    data = normalize(JSON.parse(_ls.getItem(KEY)) || empty());
  } catch (e) {
    data = empty();
  }
  if (migrateLegacy(data)) { try { _ls.setItem(KEY, JSON.stringify(data)); } catch (e) {} }

  var saveTimer = null, notify = true;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { _ls.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    }, 120);
    // 云端同步钩子：考后接入微信云开发时在此调用 push（当前版本纯本地）
  }

  /** 数据发生变化时调用：刷新时间戳 + 落盘 + 通知云端同步 */
  function touch() {
    data.updatedAt = Date.now();
    save();
  }

  /** 用一整份数据替换本地（不触发反向推送）。仅用于「恢复快照」，日常同步一律走 merge() */
  function replace(remote) {
    var before = JSON.stringify(data);
    data = normalize(remote);
    migrateLegacy(data);
    notify = false;
    save();
    notify = true;
    return JSON.stringify(data) !== before;
  }

  /* ---------------- 合并（防数据丢失的核心） ---------------- */
  /**
   * 单张卡片合并：进度类字段只升不降；「下次复习时间」以最近一次学习的记录为准。
   * 这样无论哪一侧更旧，都不会出现 box / reps / lapses 被整体回退。
   */
  function mergeCard(a, b) {
    if (!a) return b ? normalizeCard(b) : null;
    if (!b) return normalizeCard(a);
    var c = normalizeCard(a), o = normalizeCard(b);
    var aNewer = c.last >= o.last;
    var newer = aNewer ? c : o, older = aNewer ? o : c;
    var due;
    if (c.reps === 0 && o.reps === 0) due = 0;
    else due = newer.due || older.due;
    return {
      box: Math.max(c.box, o.box),
      iv: Math.max(c.iv, o.iv),
      due: due,
      reps: Math.max(c.reps, o.reps),
      lapses: Math.max(c.lapses, o.lapses),
      wrong: Math.max(c.wrong, o.wrong),
      ease: newer.ease,
      last: Math.max(c.last, o.last)
    };
  }

  /**
   * 把 remote 合并进本地（原地修改 data），永不整份覆盖。
   * 返回 { changed, gained }：changed=本地数据有变化（需要回推云端），gained=新增的已学术语数。
   * 设置项以本机为准（主题/音量属设备偏好），云端只补齐缺失字段。
   */
  function merge(remote) {
    if (!remote || typeof remote !== 'object' || !remote.cards) return { changed: false, gained: 0 };
    var beforeJson = JSON.stringify(data);
    var beforeCards = progressOf(data);
    // 在深拷贝上合并，最后整体换掉 data —— 这样 app 侧的 lastDataRef 侦测得到变化并重绘界面
    var d = normalize(JSON.parse(JSON.stringify(data)));
    var k;

    for (k in remote.cards) d.cards[k] = mergeCard(d.cards[k], remote.cards[k]);

    var rs = (remote.stats && typeof remote.stats === 'object') ? remote.stats : {};
    var s = d.stats;
    s.reviewed = Math.max(s.reviewed, num(rs.reviewed));
    s.correct = Math.max(s.correct, num(rs.correct));
    s.streak = Math.max(s.streak, num(rs.streak));
    if (typeof rs.lastDay === 'string' && rs.lastDay > s.lastDay) s.lastDay = rs.lastDay;
    var rd = (rs.daily && typeof rs.daily === 'object') ? rs.daily : {};
    for (k in rd) {
      var cur = s.daily[k] || { n: 0, r: 0, ok: 0 }, o = rd[k] || {};
      s.daily[k] = {
        n: Math.max(num(cur.n), num(o.n)),
        r: Math.max(num(cur.r), num(o.r)),
        ok: Math.max(num(cur.ok), num(o.ok))
      };
    }

    // 设置以本机为准（主题/音量属设备偏好），云端只补齐缺失字段
    if (remote.settings && typeof remote.settings === 'object') {
      for (k in remote.settings) if (d.settings[k] === undefined) d.settings[k] = remote.settings[k];
    }

    migrateLegacy(d);
    data = d;
    return { changed: JSON.stringify(data) !== beforeJson, gained: progressOf(data) - beforeCards };
  }

  function dayKey(ts) {
    var d = ts ? new Date(ts) : new Date();
    var m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (dd < 10 ? '0' + dd : dd);
  }

  function card(id) {
    if (!data.cards[id]) {
      data.cards[id] = { box: 0, iv: 0, due: 0, reps: 0, lapses: 0, wrong: 0, ease: 2.5, last: 0 };
    }
    return data.cards[id];
  }

  function today() {
    var k = dayKey();
    if (!data.stats.daily[k]) data.stats.daily[k] = { n: 0, r: 0, ok: 0 };
    return data.stats.daily[k];
  }

  /** 记录一次学习结果：kind = 'new' | 'review'，ok = 是否判为认识 */
  function record(kind, ok) {
    var s = data.stats, t = today(), k = dayKey();
    s.reviewed++;
    if (ok) s.correct++;
    if (kind === 'new') t.n++; else t.r++;
    if (ok) t.ok++;

    if (s.lastDay !== k) {
      var y = dayKey(Date.now() - DAY);
      s.streak = s.lastDay === y ? s.streak + 1 : 1;
      s.lastDay = k;
    }
    touch();
  }

  function dailyCounts() {
    var t = today();
    return { n: t.n, r: t.r, ok: t.ok, streak: data.stats.streak };
  }

  function last7() {
    var arr = [];
    for (var i = 6; i >= 0; i--) {
      var k = dayKey(Date.now() - i * DAY);
      var d = data.stats.daily[k] || { n: 0, r: 0, ok: 0 };
      arr.push({ key: k, label: k.slice(5), total: d.n + d.r });
    }
    return arr;
  }

  /** 导出：带版本标记的完整包，术语学习进度全部包含 */
  function exportText() {
    return JSON.stringify({
      _app: 'archgo', _v: 2, exportedAt: Date.now(), data: data
    }, null, 2);
  }

  /**
   * 导入：兼容新版导出包（{ data: {...} }）、旧版直接导出的 Store.data、以及云端快照。
   * 一律走 merge —— 导入只会补进进度，不会抹掉你已有的卡片。
   */
  function load(obj) {
    if (!obj || typeof obj !== 'object') return false;
    var src = (obj.data && typeof obj.data === 'object' && obj.data.cards) ? obj.data : obj;
    if (!src.cards || typeof src.cards !== 'object') return false;
    snapshot('导入前自动备份');
    merge(src);
    data.updatedAt = Date.now();
    save();
    return true;
  }

  var api = {
    save: save,
    touch: touch,
    replace: replace,
    merge: merge,
    progressOf: progressOf,
    card: card,
    raw: function (id) { return data.cards[id] || null; },
    record: record,
    dailyCounts: dailyCounts,
    last7: last7,
    dayKey: dayKey,
    reset: function () { data = empty(); touch(); },
    load: load,
    exportText: exportText,
    snapshot: snapshot,
    listBackups: listBackups,
    restoreBackup: restoreBackup,
    clearBackups: clearBackups,
    flush: function () {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        try { _ls.setItem(KEY, JSON.stringify(data)); } catch (e) {}
      }
    }
  };

  // data 指向会随「云端数据替换/合并」变化，这里用 getter 保证外部始终拿到最新对象
  Object.defineProperty(api, 'data', { get: function () { return data; } });
  return api;
})();