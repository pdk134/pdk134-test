/**
 * 本地存储层：所有学习记录保存在 localStorage，刷新/关闭浏览器不丢。
 * 数据结构（v2）：
 * {
 *   v: 2,
 *   updatedAt: 0,
 *   cards: { [术语]: { box, iv, due, reps, lapses, wrong, ease, last } },
 *   stats: { reviewed, correct, streak, lastDay, daily: { 'YYYY-MM-DD': { n, r, ok } } },
 *   settings: { dailyNew, dailyReview, autoSpeak, theme, ... },
 *   exam: { wrong: { [真题id]: 错误次数 }, totalDone: 0 },
 *   wrongExtra: { case: { [id]: 1 }, essay: { [id]: 1 } }
 * }
 *
 * v2 的关键改动：exam / wrongExtra 原本存在两个独立的 localStorage 键里
 *（arch-term-exam-v1、arch-term-wrong-extra），换设备必丢。现在并入本对象，
 * 登录后会随云端一起同步；旧键的数据在首次加载时自动迁入（保留原键不删）。
 *
 * 所有「云端 vs 本地」的冲突一律走 merge()：进度类字段只升不降，
 * 避免出现「空白快照时间戳更新 → 把已有进度整份覆盖」的数据丢失。
 */
window.Store = (function () {
  var KEY = 'arch-term-trainer-v1';
  var BAK_KEY = 'arch-term-backups';
  var LEGACY_EXAM = 'arch-term-exam-v1';
  var LEGACY_EXTRA = 'arch-term-wrong-extra';
  var MAX_BAK = 5;
  var DAY = 86400000;

  function empty() {
    return {
      v: 2,
      updatedAt: 0,
      cards: {},
      stats: { reviewed: 0, correct: 0, streak: 0, lastDay: '', daily: {} },
      settings: { dailyNew: 10, dailyReview: 60, autoSpeak: false, theme: 'dark', bgm: false, bgmVol: 35, sfx: true, sfxVol: 60 },
      exam: { wrong: {}, totalDone: 0 },
      wrongExtra: { case: {}, essay: {} }
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

    d.exam = (d.exam && typeof d.exam === 'object') ? d.exam : {};
    if (!d.exam.wrong || typeof d.exam.wrong !== 'object') d.exam.wrong = {};
    d.exam.totalDone = num(d.exam.totalDone);

    d.wrongExtra = (d.wrongExtra && typeof d.wrongExtra === 'object') ? d.wrongExtra : {};
    if (!d.wrongExtra.case || typeof d.wrongExtra.case !== 'object') d.wrongExtra.case = {};
    if (!d.wrongExtra.essay || typeof d.wrongExtra.essay !== 'object') d.wrongExtra.essay = {};
    return d;
  }

  /** v1 遗留：真题错题本 / 案例论文标记曾存在独立键里，迁入主数据（只增不减） */
  function migrateLegacy(d) {
    var changed = false, k;
    try {
      var raw = localStorage.getItem(LEGACY_EXAM);
      if (raw) {
        var ex = JSON.parse(raw) || {};
        for (k in (ex.wrong || {})) {
          var n = num(ex.wrong[k]);
          if (n > num(d.exam.wrong[k])) { d.exam.wrong[k] = n; changed = true; }
        }
        if (num(ex.totalDone) > d.exam.totalDone) { d.exam.totalDone = num(ex.totalDone); changed = true; }
      }
    } catch (e) {}
    try {
      var raw2 = localStorage.getItem(LEGACY_EXTRA);
      if (raw2) {
        var we = JSON.parse(raw2) || {};
        ['case', 'essay'].forEach(function (t) {
          for (var k2 in (we[t] || {})) if (!d.wrongExtra[t][k2]) { d.wrongExtra[t][k2] = 1; changed = true; }
        });
      }
    } catch (e) {}
    return changed;
  }

  /* ---------------- 快照备份 ---------------- */
  function readBackups() {
    try { var a = JSON.parse(localStorage.getItem(BAK_KEY)); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function writeBackups(a) {
    try { localStorage.setItem(BAK_KEY, JSON.stringify(a.slice(0, MAX_BAK))); } catch (e) {}
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
  function clearBackups() { try { localStorage.removeItem(BAK_KEY); } catch (e) {} }

  /* ---------------- 加载 / 保存 ---------------- */
  var data;
  try {
    data = normalize(JSON.parse(localStorage.getItem(KEY)) || empty());
  } catch (e) {
    data = empty();
  }
  if (migrateLegacy(data)) { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {} }

  var saveTimer = null, notify = true;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    }, 120);
    if (notify && window.Sync && window.Sync.isReady()) window.Sync.schedulePush();
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

    // 真题错题本：错误次数取大
    var rw = (remote.exam && remote.exam.wrong) ? remote.exam.wrong : {};
    for (k in rw) {
      var n = num(rw[k]);
      if (n > num(d.exam.wrong[k])) d.exam.wrong[k] = n;
    }
    d.exam.totalDone = Math.max(d.exam.totalDone, num(remote.exam && remote.exam.totalDone));

    // 案例 / 论文待巩固：取并集
    var rwe = (remote.wrongExtra && typeof remote.wrongExtra === 'object') ? remote.wrongExtra : {};
    ['case', 'essay'].forEach(function (t) {
      var src = rwe[t] || {}, dst = d.wrongExtra[t];
      for (var k2 in src) if (!dst[k2]) dst[k2] = 1;
    });

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

  /** 导出：带版本标记的完整包，术语进度 / 真题错题 / 案例论文标记全部包含 */
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
    clearBackups: clearBackups
  };

  // data 指向会随「云端数据替换/合并」变化，这里用 getter 保证外部始终拿到最新对象
  Object.defineProperty(api, 'data', { get: function () { return data; } });
  return api;
})();