/* =========================================================
 * 月记小程序 - 本地数据层（微信云开发版）
 *
 * 数据模型：按「字段 + 时间戳」存增量，而不是一整包覆盖。
 *   days   : { 'YYYY-MM-DD': { period: true/false, t: 时间戳 } }   经期标记（含取消）
 *   closed : { 'YYYY-MM-DD': { closed: true/false, t: 时间戳 } }    经期段开始日的结束状态
 *   logs   : { 'YYYY-MM-DD': { symptoms:[], mood:'', note:'', t:时间戳 } }
 *
 * 这样多设备各改各的也不会互相覆盖：合并时逐 key 比较 t，取较新的。
 * 取消经期标记写 period:false + 新时间戳，能被正确同步（整包 LWW 做不到）。
 *
 * 计算逻辑（周期合并 / 延续预测 / 平均值 / 规律分析）与网页版保持完全一致。
 * ========================================================= */

var CFG = require('../config.js');

var BASE_KEY = CFG.PERIOD_STORAGE_PREFIX;

/* ---------------- 常量 ---------------- */
var DEFAULT_CYCLE = 28;
var DEFAULT_PERIOD = 7;
var LUTEAL_PHASE = 14;
var PERIOD_LEN_MIN = 2;
var PERIOD_LEN_MAX = 10;
var PERIOD_LEN_CONFIRMED = 3;

var SYMPTOMS = [
  { id: 'cramps',   label: '腹痛' },
  { id: 'backache', label: '腰酸' },
  { id: 'headache', label: '头痛' },
  { id: 'breast',   label: '乳房胀痛' },
  { id: 'fatigue',  label: '疲劳' },
  { id: 'acne',     label: '痘痘' },
  { id: 'nausea',   label: '恶心' },
  { id: 'insomnia', label: '失眠' }
];

var MOODS = [
  { id: 'happy',     emoji: '😊', label: '开心' },
  { id: 'calm',      emoji: '😌', label: '平静' },
  { id: 'anxious',   emoji: '😟', label: '焦虑' },
  { id: 'irritable', emoji: '😤', label: '烦躁' },
  { id: 'sad',       emoji: '😢', label: '低落' },
  { id: 'tired',     emoji: '😪', label: '疲惫' }
];

/* ---------------- 日期工具 ---------------- */
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function fmt(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function parseDate(s) {
  var p = String(s || '').split('-').map(Number);
  return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
}
function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function diffDays(a, b) { return Math.round((b - a) / 86400000); }
function today() { var n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function todayStr() { return fmt(today()); }
function fmtCN(d) { return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
function fmtShort(d) { return (d.getMonth() + 1) + '/' + d.getDate(); }
function nowMs() { return Date.now(); }

/* ---------------- 状态 ---------------- */
var state = { days: {}, closed: {}, logs: {}, updated_at: 0 };
var scope = '';        // 按 openid 分键
var dirty = false;     // 有未推送到云端的改动
var booted = false;

function storageKey() { return BASE_KEY + (scope ? ':' + scope : ''); }

function persist() {
  try {
    wx.setStorageSync(storageKey(), {
      days: state.days, closed: state.closed, logs: state.logs,
      updated_at: state.updated_at, dirty: dirty
    });
  } catch (e) { console.warn('[PeriodStore] 本地保存失败', e); }
}
function readKey(k) {
  try {
    var raw = wx.getStorageSync(k);
    if (!raw) return null;
    return {
      days: raw.days || {}, closed: raw.closed || {}, logs: raw.logs || {},
      updated_at: raw.updated_at || 0, dirty: !!raw.dirty
    };
  } catch (e) { return null; }
}
function load() {
  if (booted) return;
  booted = true;
  var d = readKey(storageKey());
  if (d) { state.days = d.days; state.closed = d.closed; state.logs = d.logs; state.updated_at = d.updated_at; dirty = d.dirty; }
}
/** 切换微信账号：不同 openid 的本地缓存互不可见；旧公共区数据迁移一次 */
function bindUser(uid) {
  var next = String(uid || '');
  if (next === scope) return false;
  var legacy = next ? readKey(BASE_KEY) : null;
  scope = next; booted = false;
  state = { days: {}, closed: {}, logs: {}, updated_at: 0 }; dirty = false;
  load();
  if (legacy && !Object.keys(state.days).length && !Object.keys(state.logs).length) {
    state.days = legacy.days; state.closed = legacy.closed;
    state.logs = legacy.logs; state.updated_at = legacy.updated_at;
    dirty = legacy.dirty || dirty;
    persist();
    try { wx.removeStorageSync(BASE_KEY); } catch (e) {}
  }
  return true;
}

function touch() {
  state.updated_at = nowMs();
  dirty = true;
  persist();
}

/* ---------------- 读取 ---------------- */
function isPeriodDay(dateStr) { load(); return !!(state.days[dateStr] && state.days[dateStr].period); }
function isClosed(startStr) { load(); return !!(state.closed[startStr] && state.closed[startStr].closed); }
function periodDayList() {
  load();
  return Object.keys(state.days).filter(function (k) { return state.days[k].period; }).sort();
}
function getLog(dateStr) { load(); return state.logs[dateStr] || { symptoms: [], mood: '', note: '' }; }
function hasLog(dateStr) {
  load();
  var l = state.logs[dateStr];
  return !!(l && ((l.symptoms && l.symptoms.length) || l.mood || (l.note || '').trim()));
}

/* ---------------- 写入 ---------------- */
function setPeriodDay(dateStr, on) {
  load();
  state.days[dateStr] = { period: !!on, t: nowMs() };
  touch();
}
/** 经期开关（记录页主按钮）：取消时顺带恢复该段的 closed 状态 */
function togglePeriod(dateStr) {
  load();
  var next = !isPeriodDay(dateStr);
  setPeriodDay(dateStr, next);
  if (!next) {
    var periods = getPeriods();
    var ongoing = getOngoingPeriods(periods, getAvgPeriodLen(periods));
    var cur = findPeriodOf(dateStr, periods, ongoing);
    if (cur && isClosed(cur.start)) setClosed(cur.start, false);
  }
  return next;
}
function setClosed(startStr, on) {
  load();
  state.closed[startStr] = { closed: !!on, t: nowMs() };
  touch();
}
/** 「经期到此结束 / 恢复延续」：把开始日到选中日补齐成一段并关闭 */
function toggleEndPeriod(dateStr) {
  load();
  var periods = getPeriods();
  var ongoing = getOngoingPeriods(periods, getAvgPeriodLen(periods));
  var cur = findPeriodOf(dateStr, periods, ongoing);
  if (!cur) return false;
  if (isClosed(cur.start)) {
    setClosed(cur.start, false);
    return false;
  }
  var d = parseDate(cur.start), end = parseDate(dateStr), t = nowMs();
  for (; d <= end; d = addDays(d, 1)) {
    state.days[fmt(d)] = { period: true, t: t };
  }
  state.closed[cur.start] = { closed: true, t: t };
  touch();
  return true;
}
function cleanEmptyLog(dateStr) {
  load();
  var l = state.logs[dateStr];
  if (l && !(l.symptoms && l.symptoms.length) && !l.mood && !(l.note || '').trim()) {
    // 保留墓碑（写空值 + 新时间戳），否则另一台设备会把旧日志"复活"
    state.logs[dateStr] = { symptoms: [], mood: '', note: '', t: nowMs() };
  }
}
function saveLog(dateStr, log) {
  load();
  state.logs[dateStr] = {
    symptoms: (log.symptoms || []).slice(),
    mood: log.mood || '', note: log.note || '', t: nowMs()
  };
  cleanEmptyLog(dateStr);
  touch();
}
function toggleSymptom(dateStr, id) {
  var l = getLog(dateStr), arr = (l.symptoms || []).slice(), i = arr.indexOf(id);
  if (i >= 0) arr.splice(i, 1); else arr.push(id);
  saveLog(dateStr, { symptoms: arr, mood: l.mood, note: l.note });
  return arr;
}
function setMood(dateStr, id) {
  var l = getLog(dateStr);
  saveLog(dateStr, { symptoms: l.symptoms, mood: l.mood === id ? '' : id, note: l.note });
  return getLog(dateStr).mood;
}
function setNote(dateStr, text) {
  var l = getLog(dateStr);
  saveLog(dateStr, { symptoms: l.symptoms, mood: l.mood, note: text });
}

/* ---------------- 周期计算（与网页版一致） ---------------- */
function getPeriods() {
  var days = periodDayList(), periods = [], cur = null;
  for (var i = 0; i < days.length; i++) {
    var s = days[i];
    if (cur && diffDays(parseDate(cur.end), parseDate(s)) === 1) cur.end = s;
    else { cur = { start: s, end: s }; periods.push(cur); }
  }
  return periods;
}
function getOngoingPeriods(periods, avgPeriodLen) {
  var result = [];
  for (var i = 0; i < periods.length; i++) {
    var p = periods[i];
    if (isClosed(p.start)) continue;
    var start = parseDate(p.start), end = parseDate(p.end);
    var markedLen = diffDays(start, end) + 1;
    if (markedLen >= avgPeriodLen) continue;
    var realEnd = addDays(start, avgPeriodLen - 1);
    if (realEnd <= end) continue;
    result.push({
      start: p.start, markedEnd: p.end, predictedEnd: fmt(realEnd),
      startDate: start, endDate: realEnd, pendingDays: diffDays(end, realEnd)
    });
  }
  return result;
}
function findOngoing(d, ongoing) {
  for (var i = 0; i < ongoing.length; i++) {
    if (d >= ongoing[i].startDate && d <= ongoing[i].endDate) return ongoing[i];
  }
  return null;
}
function findPeriodOf(dateStr, periods, ongoing) {
  var d = parseDate(dateStr);
  for (var i = 0; i < periods.length; i++) {
    if (d >= parseDate(periods[i].start) && d <= parseDate(periods[i].end)) return periods[i];
  }
  var o = findOngoing(d, ongoing);
  if (o) return { start: o.start, end: fmt(o.endDate), predicted: true };
  return null;
}
function getAvgCycle(periods) {
  if (periods.length < 2) return DEFAULT_CYCLE;
  var gaps = [];
  for (var i = 1; i < periods.length; i++) {
    gaps.push(diffDays(parseDate(periods[i - 1].start), parseDate(periods[i].start)));
  }
  var recent = gaps.slice(-6), sum = 0;
  for (var j = 0; j < recent.length; j++) sum += recent[j];
  return Math.round(sum / recent.length);
}
function getAvgPeriodLen(periods) {
  if (periods.length === 0) return DEFAULT_PERIOD;
  var lens = [];
  for (var i = 0; i < periods.length; i++) {
    var len = diffDays(parseDate(periods[i].start), parseDate(periods[i].end)) + 1;
    if (len >= PERIOD_LEN_CONFIRMED && len <= PERIOD_LEN_MAX) lens.push(len);
  }
  if (!lens.length) return DEFAULT_PERIOD;
  var recent = lens.slice(-6), sum = 0;
  for (var j = 0; j < recent.length; j++) sum += recent[j];
  return Math.max(PERIOD_LEN_MIN, Math.min(PERIOD_LEN_MAX, Math.round(sum / recent.length)));
}
function getPrediction(periods) {
  if (!periods.length) return null;
  var avgCycle = getAvgCycle(periods), avgPeriodLen = getAvgPeriodLen(periods);
  var lastStart = parseDate(periods[periods.length - 1].start);
  var nextStart = addDays(lastStart, avgCycle);
  return {
    avgCycle: avgCycle, avgPeriodLen: avgPeriodLen,
    nextStart: nextStart, nextEnd: addDays(nextStart, avgPeriodLen - 1),
    ovulation: addDays(nextStart, -LUTEAL_PHASE),
    fertileStart: addDays(nextStart, -LUTEAL_PHASE - 5),
    fertileEnd: addDays(nextStart, -LUTEAL_PHASE + 1)
  };
}
function isInRange(d, a, b) { return d >= a && d <= b; }

/** 周期规律性分析（与网页版一致，含剔除误标短段） */
function analyzeCycle(periods) {
  if (periods.length < 3) return null;
  function gapsOf(list) {
    var g = [];
    for (var i = 1; i < list.length; i++) {
      g.push({ len: diffDays(parseDate(list[i - 1].start), parseDate(list[i].start)),
               from: list[i - 1].start, to: list[i].start });
    }
    return g;
  }
  if (gapsOf(periods).length < 2) return null;
  var clean = periods.filter(function (p, idx) {
    if (idx === 0 || idx === periods.length - 1) return true;
    var myStart = parseDate(p.start);
    var markedLen = diffDays(parseDate(p.start), parseDate(p.end)) + 1;
    var gapToPrev = diffDays(parseDate(periods[idx - 1].start), myStart);
    var gapToNext = diffDays(myStart, parseDate(periods[idx + 1].start));
    return !((gapToPrev < 15 || gapToNext < 15) && markedLen < 3);
  });
  if (clean.length < 3) return null;
  var valid = gapsOf(clean).filter(function (g) { return g.len >= 15 && g.len <= 60; });
  if (valid.length < 2) return null;
  var lens = valid.map(function (g) { return g.len; });
  var avg = lens.reduce(function (a, b) { return a + b; }, 0) / lens.length;
  var max = Math.max.apply(null, lens), min = Math.min.apply(null, lens), spread = max - min;
  var variance = lens.reduce(function (s, l) { return s + (l - avg) * (l - avg); }, 0) / lens.length;
  var sd = Math.sqrt(variance);
  var level, title, desc;
  if (avg < 21) {
    level = 'warn'; title = '周期偏短';
    desc = '你最近的平均周期为 ' + Math.round(avg) + ' 天，短于常见的 21 天。若持续如此，建议咨询医生了解原因。';
  } else if (avg > 35) {
    level = 'warn'; title = '周期偏长';
    desc = '你最近的平均周期为 ' + Math.round(avg) + ' 天，长于常见的 35 天。若持续如此，建议咨询医生了解原因。';
  } else if (spread > 7) {
    level = 'warn'; title = '周期波动较大';
    desc = '最近 ' + lens.length + ' 个周期在 ' + min + '~' + max + ' 天之间波动，相差 ' + spread +
      ' 天（标准差 ' + sd.toFixed(1) + '）。偶尔波动是正常的，若连续多个周期如此，建议留意作息与压力，必要时咨询医生。';
  } else if (spread > 5) {
    level = 'info'; title = '周期略有不规律';
    desc = '最近 ' + lens.length + ' 个周期在 ' + min + '~' + max + ' 天之间，波动 ' + spread +
      ' 天，属于正常范围内的轻微波动（标准差 ' + sd.toFixed(1) + '）。';
  } else {
    level = 'ok'; title = '周期规律';
    desc = '最近 ' + lens.length + ' 个周期的波动仅 ' + spread + ' 天（' + min + '~' + max +
      ' 天，标准差 ' + sd.toFixed(1) + '），非常规律，保持好状态 👍';
  }
  return { level: level, title: title, desc: desc, avg: Math.round(avg), spread: spread, sd: sd,
           min: min, max: max, count: lens.length };
}

/* ---------------- 云同步：整包收发 + 字段级合并 ---------------- */
function toRow() {
  load();
  return {
    key: 'period',
    days: state.days, closed: state.closed, logs: state.logs,
    updated_at: state.updated_at
  };
}
function mergeMap(a, b) {
  var out = {}, k;
  a = a || {}; b = b || {};
  for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) out[k] = a[k];
  for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) {
    if (!out[k] || (Number(b[k] && b[k].t) || 0) > (Number(out[k] && out[k].t) || 0)) out[k] = b[k];
  }
  return out;
}
/** 合并远端文档：逐字段取时间戳较新者，返回是否发生变化 */
function mergeRemote(row) {
  load();
  if (!row) return false;
  var before = JSON.stringify({ d: state.days, c: state.closed, l: state.logs });
  state.days = mergeMap(state.days, row.days);
  state.closed = mergeMap(state.closed, row.closed);
  state.logs = mergeMap(state.logs, row.logs);
  state.updated_at = Math.max(state.updated_at || 0, Number(row.updated_at) || 0);
  var after = JSON.stringify({ d: state.days, c: state.closed, l: state.logs });
  var changed = before !== after;
  if (changed) persist();
  return changed;
}
function isDirty() { load(); return dirty; }
function markSynced() { dirty = false; persist(); }
function markDirty() { touch(); }
function snapshot() {
  load();
  return { days: state.days, closed: state.closed, logs: state.logs, updated_at: state.updated_at, dirty: dirty };
}
function reset() {
  state = { days: {}, closed: {}, logs: {}, updated_at: 0 };
  dirty = false; persist();
}

load();

module.exports = {
  // 常量
  SYMPTOMS: SYMPTOMS, MOODS: MOODS,
  DEFAULT_CYCLE: DEFAULT_CYCLE, DEFAULT_PERIOD: DEFAULT_PERIOD, LUTEAL_PHASE: LUTEAL_PHASE,
  // 日期
  fmt: fmt, parseDate: parseDate, addDays: addDays, diffDays: diffDays,
  today: today, todayStr: todayStr, fmtCN: fmtCN, fmtShort: fmtShort,
  // 状态
  bindUser: bindUser, storageKey: storageKey, persist: persist, snapshot: snapshot, reset: reset,
  // 读写
  isPeriodDay: isPeriodDay, isClosed: isClosed, periodDayList: periodDayList,
  getLog: getLog, hasLog: hasLog, setPeriodDay: setPeriodDay, togglePeriod: togglePeriod,
  setClosed: setClosed, toggleEndPeriod: toggleEndPeriod, cleanEmptyLog: cleanEmptyLog,
  saveLog: saveLog, toggleSymptom: toggleSymptom, setMood: setMood, setNote: setNote,
  // 计算
  getPeriods: getPeriods, getOngoingPeriods: getOngoingPeriods, getAvgCycle: getAvgCycle,
  getAvgPeriodLen: getAvgPeriodLen, getPrediction: getPrediction, findOngoing: findOngoing,
  findPeriodOf: findPeriodOf, isInRange: isInRange, analyzeCycle: analyzeCycle,
  // 同步
  toRow: toRow, mergeRemote: mergeRemote, isDirty: isDirty,
  markSynced: markSynced, markDirty: markDirty
};
