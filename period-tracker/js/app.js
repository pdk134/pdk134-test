/* =========================================================
 * 月记 - 核心逻辑
 * 数据存储：localStorage（仅保存在本机浏览器）
 * ========================================================= */

'use strict';

/* ---------- 常量 ---------- */
const STORAGE_KEY = 'periodTracker.v2';
const DEFAULT_CYCLE = 28;   // 数据不足时的默认周期长度
const DEFAULT_PERIOD = 7;   // 数据不足时的默认经期长度（首次使用默认 7 天，之后按真实记录自动学习）
const LUTEAL_PHASE = 14;    // 黄体期（排卵到下次经期）固定约 14 天
const PERIOD_LEN_MIN = 2;   // 经期长度合理下限（避免异常值拉偏预测）
const PERIOD_LEN_MAX = 10;  // 经期长度合理上限

const SYMPTOMS = [
  { id: 'cramps',   label: '😖 腹痛' },
  { id: 'backache', label: '🙇‍♀️ 腰酸' },
  { id: 'headache', label: '🤕 头痛' },
  { id: 'breast',   label: '💢 乳房胀痛' },
  { id: 'fatigue',  label: '🥱 疲劳' },
  { id: 'acne',     label: '😩 痘痘' },
  { id: 'nausea',   label: '🤢 恶心' },
  { id: 'insomnia', label: '🌙 失眠' }
];

const MOODS = [
  { id: 'happy',     emoji: '😊', label: '开心' },
  { id: 'calm',      emoji: '😌', label: '平静' },
  { id: 'anxious',   emoji: '😟', label: '焦虑' },
  { id: 'irritable', emoji: '😤', label: '烦躁' },
  { id: 'sad',       emoji: '😢', label: '低落' },
  { id: 'tired',     emoji: '😪', label: '疲惫' }
];

/* ---------- 日期工具 ---------- */
function fmt(d) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}
function parseDate(s) {
  const parts = s.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]);
}
function addDays(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}
function diffDays(a, b) {
  return Math.round((b - a) / 86400000);
}
function today() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}
function fmtCN(d) {
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
function fmtShort(d) {
  return (d.getMonth() + 1) + '/' + d.getDate();
}

/* ---------- 状态与持久化 ---------- */
const state = {
  periodDays: new Set(),     // Set<'YYYY-MM-DD'> 所有被标记为经期的日期
  closedPeriods: new Set(), // Set<'YYYY-MM-DD'> 已被用户明确结束的经期开始日
  dailyLogs: {},             // { 'YYYY-MM-DD': { symptoms:[], mood:'', note:'' } }
  viewMonth: today(),        // 日历当前显示的月份
  selectedDate: fmt(today())
};

function loadState() {
  try {
    // 兼容旧版本（v1/v2）的数据，避免升级后现有记录丢失
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem('periodTracker.v1');
    if (!raw) return;
    const data = JSON.parse(raw);
    state.periodDays = new Set(data.periodDays || []);
    state.closedPeriods = new Set(data.closedPeriods || []);
    state.dailyLogs = data.dailyLogs || {};
  } catch (e) {
    console.warn('读取本地数据失败，已重置。', e);
  }
}

function saveState() {
  const data = {
    periodDays: [...state.periodDays],
    closedPeriods: [...state.closedPeriods],
    dailyLogs: state.dailyLogs
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  // 已登录时顺带把改动推到云端（cloud.js 未加载时静默跳过）
  if (window.PTCloud) window.PTCloud.schedulePush();
}

/* ---------- 周期计算 ---------- */
// 把离散的经期日合并为连续的经期段 [{start, end}]
function getPeriods() {
  const days = [...state.periodDays].sort();
  const periods = [];
  let cur = null;
  for (const s of days) {
    if (cur && diffDays(parseDate(cur.end), parseDate(s)) === 1) {
      cur.end = s;
    } else {
      cur = { start: s, end: s };
      periods.push(cur);
    }
  }
  return periods;
}

/**
 * 计算"延续经期"：对每个只标记了开始日（或未标满）的经期段，
 * 自动向后延伸 avgPeriodLen 天，供日历用虚线预测色展示。
 *
 * 一旦用户把某天点成实心经期，该天即进入 periodDays，
 * 该段 end 随之变长，不再是"待确认"状态。
 */
function getOngoingPeriods(periods, avgPeriodLen) {
  const result = [];

  for (const p of periods) {
    // 用户已明确结束这段经期，不再延续预测
    if (state.closedPeriods.has(p.start)) continue;

    const start = parseDate(p.start);
    const end = parseDate(p.end);
    const markedLen = diffDays(start, end) + 1;

    // 已经是完整长度的经期段，不需要延续
    if (markedLen >= avgPeriodLen) continue;

    // 完整延续到预测结束日（让用户一眼看到整个经期范围）
    const realEnd = addDays(start, avgPeriodLen - 1);

    if (realEnd <= end) continue;

    result.push({
      start: p.start,
      markedEnd: p.end,                 // 已确认的结束日
      predictedEnd: fmt(realEnd),       // 延续到的预测结束日
      startDate: start,
      endDate: realEnd,
      pendingDays: diffDays(end, realEnd)  // 待确认的天数
    });
  }
  return result;
}

// 找到某天所属的经期段（含已结束与延续中的）
function findPeriodOf(dateStr, periods, ongoing) {
  const d = parseDate(dateStr);
  // 先看是否落在已确认的经期日
  for (const p of periods) {
    if (d >= parseDate(p.start) && d <= parseDate(p.end)) return p;
  }
  // 再看是否在延续预测区间内
  const o = findOngoing(d, ongoing);
  if (o) return { start: o.start, end: fmt(o.endDate), predicted: true };
  return null;
}

// 某天是否落在"延续预测"区间内
function findOngoing(d, ongoing) {
  for (const o of ongoing) {
    if (d >= o.startDate && d <= o.endDate) return o;
  }
  return null;
}

// 平均周期长度（相邻经期开始日的间隔，最多取最近 6 个间隔）
function getAvgCycle(periods) {
  if (periods.length < 2) return DEFAULT_CYCLE;
  const gaps = [];
  for (let i = 1; i < periods.length; i++) {
    gaps.push(diffDays(parseDate(periods[i - 1].start), parseDate(periods[i].start)));
  }
  const recent = gaps.slice(-6);
  const sum = recent.reduce((a, b) => a + b, 0);
  return Math.round(sum / recent.length);
}

/**
 * 平均经期长度
 *
 * 关键点：只标了 1 天的经期段往往是"刚开了个头、还没标完"，
 * 若把它当真实长度参与平均，会把预测越算越短（1 天 -> 延续立刻结束）。
 * 因此这里只采纳【标记天数 ≥ PERIOD_LEN_CONFIRMED 天】的经期段来学习，
 * 未达标的段一律忽略，从而保持稳定的默认长度。
 */
const PERIOD_LEN_CONFIRMED = 3;  // 标记达到 3 天才认为是"可靠样本"

function getAvgPeriodLen(periods) {
  if (periods.length === 0) return DEFAULT_PERIOD;

  const lens = periods
    .map(p => diffDays(parseDate(p.start), parseDate(p.end)) + 1)
    .filter(len => len >= PERIOD_LEN_CONFIRMED && len <= PERIOD_LEN_MAX);

  // 还没有可靠样本时，保持默认长度，不用"只标了 1 天"的段去拉低预测
  if (lens.length === 0) return DEFAULT_PERIOD;

  const recent = lens.slice(-6);
  const sum = recent.reduce((a, b) => a + b, 0);
  return Math.max(PERIOD_LEN_MIN, Math.min(PERIOD_LEN_MAX, Math.round(sum / recent.length)));
}

// 预测：下次经期、排卵日、易孕期
function getPrediction(periods) {
  if (periods.length === 0) return null;
  const avgCycle = getAvgCycle(periods);
  const avgPeriodLen = getAvgPeriodLen(periods);
  const lastStart = parseDate(periods[periods.length - 1].start);
  const nextStart = addDays(lastStart, avgCycle);
  const nextEnd = addDays(nextStart, avgPeriodLen - 1);
  const ovulation = addDays(nextStart, -LUTEAL_PHASE);
  const fertileStart = addDays(ovulation, -5);
  const fertileEnd = addDays(ovulation, 1);
  return { avgCycle, avgPeriodLen, nextStart, nextEnd, ovulation, fertileStart, fertileEnd };
}

function isInRange(d, a, b) {
  return d >= a && d <= b;
}

/* ---------- DOM 引用 ---------- */
const $ = id => document.getElementById(id);
const els = {
  statusCard: $('statusCard'),
  monthLabel: $('monthLabel'),
  calendarGrid: $('calendarGrid'),
  dayCard: $('dayCard'),
  logDateLabel: $('logDateLabel'),
  logDateSub: $('logDateSub'),
  periodToggle: $('periodToggle'),
  periodEndBtn: $('periodEndBtn'),
  symptomChips: $('symptomChips'),
  moodRow: $('moodRow'),
  noteInput: $('noteInput'),
  saveHint: $('saveHint'),
  statAvgCycle: $('statAvgCycle'),
  statAvgPeriod: $('statAvgPeriod'),
  statCount: $('statCount'),
  nextCard: $('nextCard'),
  cycleChart: $('cycleChart'),
  historyList: $('historyList')
};

/* ---------- 渲染：状态卡片 ---------- */
function renderStatus() {
  const periods = getPeriods();
  const t = today();
  const tStr = fmt(t);

  if (periods.length === 0) {
    els.statusCard.innerHTML =
      '<div class="status-main">👋 欢迎使用</div>' +
      '<div class="status-sub">还没有经期记录，点击日历中的日期，把经期标记上吧～</div>';
    return;
  }

  const pred = getPrediction(periods);
  const last = periods[periods.length - 1];

  // 今天是否在经期内（已确认），或处于延续预测区间内
  const inPeriod = periods.some(p => isInRange(t, parseDate(p.start), parseDate(p.end)));
  const ongoingList = getOngoingPeriods(periods, getAvgPeriodLen(periods));
  const ongoingToday = findOngoing(t, ongoingList);

  let mainHtml, subHtml, tagHtml;

  if (inPeriod) {
    const dayNum = diffDays(parseDate(last.start), t) + 1;
    mainHtml = '经期第 <span class="big-num">' + dayNum + '</span> 天';
    subHtml = '本次经期从 ' + fmtShort(parseDate(last.start)) + ' 开始，注意保暖休息哦 🫖';
    tagHtml = '<span class="phase-tag">经期中</span>';
  } else if (ongoingToday) {
    // 处于延续预测区间：还没点确认，但按规律仍在经期内
    const dayNum = diffDays(ongoingToday.startDate, t) + 1;
    mainHtml = '经期第 <span class="big-num">' + dayNum + '</span> 天';
    subHtml = '本次经期从 ' + fmtShort(ongoingToday.startDate) + ' 开始，' +
      '已按平均经期长度预测至 ' + fmtShort(ongoingToday.endDate) +
      '，到记录页点击确认即可';
    tagHtml = '<span class="phase-tag">经期中（预测）</span>';
  } else {
    const cycleDay = diffDays(parseDate(last.start), t) + 1;
    const untilNext = diffDays(t, pred.nextStart);

    if (untilNext > 0) {
      mainHtml = '距离下次经期约 <span class="big-num">' + untilNext + '</span> 天';
    } else if (untilNext === 0) {
      mainHtml = '预计<span class="big-num">今天</span>来经期';
    } else {
      mainHtml = '经期可能推迟 <span class="big-num">' + (-untilNext) + '</span> 天';
    }
    subHtml = '当前为周期第 ' + cycleDay + ' 天（周期约 ' + pred.avgCycle + ' 天）';

    // 阶段标签
    if (fmt(pred.ovulation) === tStr) {
      tagHtml = '<span class="phase-tag purple">排卵日</span>';
    } else if (isInRange(t, pred.fertileStart, pred.fertileEnd)) {
      tagHtml = '<span class="phase-tag purple">易孕期</span>';
    } else if (t < pred.ovulation) {
      tagHtml = '<span class="phase-tag">卵泡期</span>';
    } else {
      tagHtml = '<span class="phase-tag">黄体期</span>';
    }
  }

  els.statusCard.innerHTML =
    '<div class="status-main">' + mainHtml + '</div>' +
    '<div class="status-sub">' + subHtml + '</div>' + tagHtml;
}

/* ---------- 渲染：日历 ---------- */
function renderCalendar() {
  const y = state.viewMonth.getFullYear();
  const m = state.viewMonth.getMonth();
  els.monthLabel.textContent = y + '年' + (m + 1) + '月';

  const periods = getPeriods();
  const pred = getPrediction(periods);
  const tStr = fmt(today());

  // 当前经期的"延续预测"区间（只标了开始日时，向后自动延伸）
  const ongoing = getOngoingPeriods(periods, pred ? pred.avgPeriodLen : DEFAULT_PERIOD);

  // 只渲染当前月份：周一为一周开始，1号之前的格子用空白占位保持列对齐（不显示其他月份）
  const first = new Date(y, m, 1);
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  let startOffset = first.getDay() - 1;
  if (startOffset < 0) startOffset = 6;

  let html = '';
  // 1号前的空白占位（不可点击、不可见，仅用于对齐周列）
  for (let i = 0; i < startOffset; i++) {
    html += '<div class="cal-empty"></div>';
  }
  // 仅当前月份的天数
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(y, m, day);
    const s = fmt(d);
    const classes = ['day-cell'];

    if (s === tStr) classes.push('today');
    if (s === state.selectedDate) classes.push('selected');

    if (state.periodDays.has(s)) {
      // 已确认的经期日（实心）
      classes.push('is-period');
    } else if (findOngoing(d, ongoing)) {
      // 本次经期的延续预测日（虚线待确认）
      classes.push('is-ongoing');
    } else if (pred) {
      if (s === fmt(pred.ovulation)) {
        classes.push('is-ovulation');
      } else if (isInRange(d, pred.nextStart, pred.nextEnd)) {
        classes.push('is-predicted');
      } else if (isInRange(d, pred.fertileStart, pred.fertileEnd)) {
        classes.push('is-fertile');
      }
    }

    const hasLog = !!state.dailyLogs[s];
    html += '<button class="' + classes.join(' ') + '" data-date="' + s + '">' +
      day +
      (hasLog ? '<span class="log-dot"></span>' : '') +
      '</button>';
  }
  els.calendarGrid.innerHTML = html;
}

/* ---------- 渲染：记录页 ---------- */
function getLog(dateStr) {
  if (!state.dailyLogs[dateStr]) {
    state.dailyLogs[dateStr] = { symptoms: [], mood: '', note: '' };
  }
  return state.dailyLogs[dateStr];
}

function cleanEmptyLog(dateStr) {
  const log = state.dailyLogs[dateStr];
  if (log && log.symptoms.length === 0 && !log.mood && !log.note.trim()) {
    delete state.dailyLogs[dateStr];
  }
}

function renderLog() {
  const d = parseDate(state.selectedDate);
  const isToday = state.selectedDate === fmt(today());
  els.logDateLabel.textContent = fmtCN(d);

  if (isToday) {
    els.logDateSub.textContent = '今天';
  } else {
    const diff = diffDays(today(), d);
    els.logDateSub.textContent = diff < 0 ? (-diff + ' 天前') : (diff + ' 天后');
  }

  // 经期开关 + 结束按钮
  const isPeriod = state.periodDays.has(state.selectedDate);
  const periods = getPeriods();
  const pred = getPrediction(periods);
  const ongoing = getOngoingPeriods(periods, pred ? pred.avgPeriodLen : DEFAULT_PERIOD);
  const inOngoing = !isPeriod && findOngoing(d, ongoing);

  // 找到当前日期所属的经期段
  const curPeriod = findPeriodOf(state.selectedDate, periods, ongoing);
  const isClosed = curPeriod && state.closedPeriods.has(curPeriod.start);

  els.periodToggle.classList.toggle('on', isPeriod);
  if (isPeriod) {
    els.periodToggle.textContent = '🩸 已确认：这一天是经期（点击取消）';
  } else if (inOngoing) {
    els.periodToggle.textContent = '🩸 这一天在经期内，点击确认为经期';
  } else {
    els.periodToggle.textContent = '🩸 标记这一天为经期';
  }

  // 经期结束按钮
  if (curPeriod && !isClosed) {
    // 该天处于经期中或延续预测内，且该段尚未结束 -> 显示"经期到此结束"
    els.periodEndBtn.hidden = false;
    els.periodEndBtn.className = 'period-end-btn';
    els.periodEndBtn.textContent = '🛑 经期到此结束（' + fmtShort(d) + '）';
  } else if (curPeriod && isClosed) {
    // 该段已被结束 -> 显示"恢复延续预测"
    els.periodEndBtn.hidden = false;
    els.periodEndBtn.className = 'period-end-btn closed';
    const closedEnd = parseDate(curPeriod.end);
    els.periodEndBtn.textContent = '✅ 经期已结束于 ' + fmtShort(closedEnd) + '（点击恢复延续预测）';
  } else {
    els.periodEndBtn.hidden = true;
  }

  // 延续提示
  if (!isPeriod && inOngoing && !isClosed) {
    els.logDateSub.textContent += ' · 预计经期内，待确认';
  }

  // 症状
  const log = state.dailyLogs[state.selectedDate] || { symptoms: [], mood: '', note: '' };
  els.symptomChips.innerHTML = SYMPTOMS.map(s =>
    '<button class="chip' + (log.symptoms.includes(s.id) ? ' on' : '') + '" data-symptom="' + s.id + '">' +
    s.label + '</button>'
  ).join('');

  // 心情
  els.moodRow.innerHTML = MOODS.map(mo =>
    '<button class="mood-btn' + (log.mood === mo.id ? ' on' : '') + '" data-mood="' + mo.id + '">' +
    mo.emoji + '<small>' + mo.label + '</small></button>'
  ).join('');

  // 备注
  els.noteInput.value = log.note || '';
}

let saveHintTimer = null;
function showSaved() {
  els.saveHint.classList.add('show');
  clearTimeout(saveHintTimer);
  saveHintTimer = setTimeout(() => els.saveHint.classList.remove('show'), 1200);
}

function afterLogChange() {
  cleanEmptyLog(state.selectedDate);
  saveState();
  renderCalendar();
  renderStatus();
  renderStats();
  showSaved();
}

/* ---------- 周期规律性分析 ---------- */
/**
 * 分析周期是否规律，并在统计页给出提示。
 *
 * 判定规则（需至少 3 个及以上周期数据）：
 *  - 波动 ≤ 5 天   -> 规律，正常展示
 *  - 波动 6~7 天   -> 略有不规律，蓝色提示
 *  - 波动 > 7 天   -> 明显不规律，橙色提醒建议关注
 *  - 周期 < 21 天 或 > 35 天 -> 周期过短/过长，建议咨询医生
 */
function analyzeCycle(periods) {
  if (periods.length < 3) return null;

  const gaps = [];
  for (let i = 1; i < periods.length; i++) {
    gaps.push({
      len: diffDays(parseDate(periods[i - 1].start), parseDate(periods[i].start)),
      from: periods[i - 1].start,
      to: periods[i].start
    });
  }
  if (gaps.length < 2) return null;

  // 第一步：剔除"异常短"的经期段（多为误标），避免其把两侧间隔都污染。
  // 例如：正常每月 1 号记录，中间突然冒出 8/11~8/12，会把 8/1->8/11、8/11->8/29 两条间隔都破坏。
  // 判定：该段与相邻段的开始日间隔 <15 天（远小于正常周期），且自身标记 <3 天。
  // 首段与末段不剔除（避免误删正在进行的经期）。
  const cleanPeriods = periods.filter((p, idx) => {
    if (idx === 0 || idx === periods.length - 1) return true;

    const myStart = parseDate(p.start);
    const markedLen = diffDays(parseDate(p.start), parseDate(p.end)) + 1;

    // 与前一段间隔过短 -> 可疑
    const gapToPrev = diffDays(parseDate(periods[idx - 1].start), myStart);
    // 与后一段间隔过短 -> 可疑
    const gapToNext = diffDays(myStart, parseDate(periods[idx + 1].start));

    const suspicious = gapToPrev < 15 || gapToNext < 15;
    const shortMarked = markedLen < 3;
    return !(suspicious && shortMarked);
  });

  if (cleanPeriods.length < 3) return null;

  const baseGaps = [];
  for (let i = 1; i < cleanPeriods.length; i++) {
    baseGaps.push({
      len: diffDays(parseDate(cleanPeriods[i - 1].start), parseDate(cleanPeriods[i].start)),
      from: cleanPeriods[i - 1].start,
      to: cleanPeriods[i].start
    });
  }

  // 第二步：保留 15~60 天的合理周期值（兜底过滤极端数据）
  const valid = baseGaps.filter(g => g.len >= 15 && g.len <= 60);
  if (valid.length < 2) return null;

  const lens = valid.map(g => g.len);
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  const max = Math.max(...lens);
  const min = Math.min(...lens);
  const spread = max - min;   // 极差，衡量波动幅度

  // 标准差
  const variance = lens.reduce((s, l) => s + (l - avg) * (l - avg), 0) / lens.length;
  const sd = Math.sqrt(variance);

  let level, title, desc;

  if (avg < 21) {
    level = 'warn';
    title = '周期偏短';
    desc = '你最近的平均周期为 ' + Math.round(avg) + ' 天，短于常见的 21 天。' +
      '若持续如此，建议咨询医生了解原因。';
  } else if (avg > 35) {
    level = 'warn';
    title = '周期偏长';
    desc = '你最近的平均周期为 ' + Math.round(avg) + ' 天，长于常见的 35 天。' +
      '若持续如此，建议咨询医生了解原因。';
  } else if (spread > 7) {
    level = 'warn';
    title = '周期波动较大';
    desc = '最近 ' + lens.length + ' 个周期在 ' + min + '~' + max + ' 天之间波动，' +
      '相差 ' + spread + ' 天（标准差 ' + sd.toFixed(1) + '）。' +
      '偶尔波动是正常的，若连续多个周期如此，建议留意作息与压力，必要时咨询医生。';
  } else if (spread > 5) {
    level = 'info';
    title = '周期略有不规律';
    desc = '最近 ' + lens.length + ' 个周期在 ' + min + '~' + max + ' 天之间，' +
      '波动 ' + spread + ' 天，属于正常范围内的轻微波动（标准差 ' + sd.toFixed(1) + '）。';
  } else {
    level = 'ok';
    title = '周期规律';
    desc = '最近 ' + lens.length + ' 个周期的波动仅 ' + spread + ' 天' +
      '（' + min + '~' + max + ' 天，标准差 ' + sd.toFixed(1) + '），非常规律，保持好状态 👍';
  }

  return { level, title, desc, avg: Math.round(avg), spread, sd, min, max, count: lens.length };
}

function renderCycleAlert(periods) {
  const area = $('alertArea');
  if (!area) return;

  const res = analyzeCycle(periods);
  if (!res) {
    area.innerHTML = '';
    return;
  }

  const icons = { ok: '✅', info: 'ℹ️', warn: '⚠️' };
  area.innerHTML =
    '<div class="alert-card ' + res.level + '">' +
      '<div class="alert-head">' +
        '<span class="alert-icon">' + icons[res.level] + '</span>' +
        '<span class="alert-title">' + res.title + '</span>' +
      '</div>' +
      '<p class="alert-desc">' + res.desc + '</p>' +
    '</div>';
}

/* ---------- 渲染：统计页 ---------- */
function renderStats() {
  const periods = getPeriods();
  const avgCycle = getAvgCycle(periods);
  const avgPeriodLen = getAvgPeriodLen(periods);

  els.statAvgCycle.textContent = periods.length >= 2 ? avgCycle : '--';
  els.statAvgPeriod.textContent = periods.length >= 1 ? avgPeriodLen : '--';
  els.statCount.textContent = periods.length;

  // 周期规律性分析提醒
  renderCycleAlert(periods);

  // 下次经期预测卡
  const pred = getPrediction(periods);
  if (pred) {
    const untilNext = diffDays(today(), pred.nextStart);
    let countText;
    if (untilNext > 0) countText = '约 ' + untilNext + ' 天后';
    else if (untilNext === 0) countText = '预计就是今天';
    else countText = '已推迟约 ' + (-untilNext) + ' 天';
    els.nextCard.innerHTML =
      '<div class="next-title">🔮 下次经期预测</div>' +
      '<div class="next-date">' + fmtCN(pred.nextStart) + '</div>' +
      '<div class="next-sub">' + countText + ' · 预计持续 ' + pred.avgPeriodLen + ' 天 · ' +
      '排卵日约 ' + fmtShort(pred.ovulation) + '</div>';
  } else {
    els.nextCard.innerHTML =
      '<div class="next-title">🔮 下次经期预测</div>' +
      '<div class="next-date">暂无数据</div>' +
      '<div class="next-sub">记录至少一次经期后，即可生成预测</div>';
  }

  // 周期长度柱状图（近 6 个间隔）
  const gaps = [];
  for (let i = 1; i < periods.length; i++) {
    gaps.push({
      len: diffDays(parseDate(periods[i - 1].start), parseDate(periods[i].start)),
      label: fmtShort(parseDate(periods[i].start))
    });
  }
  const recentGaps = gaps.slice(-6);
  if (recentGaps.length === 0) {
    els.cycleChart.innerHTML = '<div class="chart-empty">记录 2 次以上经期后显示图表</div>';
  } else {
    const maxLen = Math.max(...recentGaps.map(g => g.len), 1);
    els.cycleChart.innerHTML = recentGaps.map(g => {
      const h = Math.max(6, Math.round(g.len / maxLen * 100));
      return '<div class="bar-item">' +
        '<span class="bar-value">' + g.len + '</span>' +
        '<div class="bar" style="height:' + h + '%"></div>' +
        '<span class="bar-label">' + g.label + '</span>' +
        '</div>';
    }).join('');
  }

  // 经期历史（最近的在前）
  if (periods.length === 0) {
    els.historyList.innerHTML = '<div class="history-empty">还没有记录</div>';
  } else {
    const ongoingList = getOngoingPeriods(periods, avgPeriodLen);
    els.historyList.innerHTML = periods.slice().reverse().map((p, idx) => {
      const markedLen = diffDays(parseDate(p.start), parseDate(p.end)) + 1;
      const list = periods;
      const realIdx = list.length - 1 - idx;

      // 若该段还在延续预测中，标注它
      const ong = ongoingList.find(o => o.start === p.start);
      let lenText, endText;
      if (ong) {
        endText = fmtShort(ong.endDate) + '?';
        lenText = '已标 ' + markedLen + ' 天 · 预计 ' + (diffDays(ong.startDate, ong.endDate) + 1) + ' 天';
      } else {
        endText = fmtShort(parseDate(p.end));
        lenText = '持续 ' + markedLen + ' 天';
      }

      let cycleText = '';
      if (realIdx > 0) {
        const cyc = diffDays(parseDate(list[realIdx - 1].start), parseDate(p.start));
        cycleText = ' · 距上次 ' + cyc + ' 天';
      }
      return '<div class="history-item">' +
        '<span class="history-dates">' + fmtShort(parseDate(p.start)) + ' ~ ' + endText + '</span>' +
        '<span class="history-meta">' + lenText + cycleText + '</span>' +
        '</div>';
    }).join('');
  }
}

/* ---------- 渲染全部 ---------- */
function renderAll() {
  renderStatus();
  renderCalendar();
  renderLog();
  renderStats();
}

/* ---------- 年月快速选择 ---------- */
const ym = { year: 0 };

function renderYM() {
  $('ymYear').textContent = ym.year + ' 年';
  const curY = state.viewMonth.getFullYear();
  const curM = state.viewMonth.getMonth();
  const t = today();
  let html = '';
  for (let i = 0; i < 12; i++) {
    const cls = ['ym-month'];
    if (ym.year === curY && i === curM) cls.push('active');
    if (ym.year === t.getFullYear() && i === t.getMonth()) cls.push('is-now');
    html += '<button type="button" class="' + cls.join(' ') + '" data-month="' + i + '">' +
      (i + 1) + '月</button>';
  }
  $('ymMonths').innerHTML = html;
}

function openYM() {
  ym.year = state.viewMonth.getFullYear();
  renderYM();
  $('ymMask').classList.add('show');
}

function closeYM() {
  $('ymMask').classList.remove('show');
}

/**
 * 切换日历显示的月份。
 * 选中日期若不在目标月，自动落到该月（本月取今天，其它月取 1 号），
 * 保证下方当天操作卡始终与日历对得上。
 */
function setViewMonth(y, m) {
  state.viewMonth = new Date(y, m, 1);
  const sel = parseDate(state.selectedDate);
  if (sel.getFullYear() !== y || sel.getMonth() !== m) {
    const t = today();
    const sameMonth = (t.getFullYear() === y && t.getMonth() === m);
    state.selectedDate = fmt(sameMonth ? t : new Date(y, m, 1));
  }
  renderCalendar();
  renderLog();
}

/** 选中日期后，若当天操作卡还在屏幕外，轻滚过去 */
function revealPanel() {
  const card = els.dayCard;
  if (!card) return;
  const r = card.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.top > vh - 160) {
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  // 底部 Tab
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $('page-' + btn.dataset.page).classList.add('active');
      if (btn.dataset.page === 'stats') {
        renderStats();
        const main = document.querySelector('.app-main');
        if (main) main.scrollTop = 0;
      }
    });
  });

  // 月份切换
  $('prevMonth').addEventListener('click', () => {
    const d = new Date(state.viewMonth.getFullYear(), state.viewMonth.getMonth() - 1, 1);
    setViewMonth(d.getFullYear(), d.getMonth());
  });
  $('nextMonth').addEventListener('click', () => {
    const d = new Date(state.viewMonth.getFullYear(), state.viewMonth.getMonth() + 1, 1);
    setViewMonth(d.getFullYear(), d.getMonth());
  });

  // 点月份标题 -> 年月快选
  els.monthLabel.addEventListener('click', openYM);
  $('ymPrevYear').addEventListener('click', () => { ym.year--; renderYM(); });
  $('ymNextYear').addEventListener('click', () => { ym.year++; renderYM(); });
  $('ymCancel').addEventListener('click', closeYM);
  $('ymMask').addEventListener('click', e => {
    if (e.target === $('ymMask')) closeYM();
  });
  $('ymToday').addEventListener('click', () => {
    const t = today();
    state.selectedDate = fmt(t);
    closeYM();
    setViewMonth(t.getFullYear(), t.getMonth());
    renderStatus();
    revealPanel();
  });
  $('ymMonths').addEventListener('click', e => {
    const btn = e.target.closest('.ym-month');
    if (!btn) return;
    closeYM();
    setViewMonth(ym.year, Number(btn.dataset.month));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && $('ymMask').classList.contains('show')) closeYM();
  });

  // 日历点击 -> 选中该天，下方操作卡就地换内容（不跳页）
  els.calendarGrid.addEventListener('click', e => {
    const cell = e.target.closest('.day-cell');
    if (!cell) return;
    state.selectedDate = cell.dataset.date;
    renderCalendar();
    renderLog();
    revealPanel();
  });

  // 当天操作卡：日期前后切换
  $('logPrevDay').addEventListener('click', () => {
    const d = addDays(parseDate(state.selectedDate), -1);
    state.selectedDate = fmt(d);
    setViewMonth(d.getFullYear(), d.getMonth());
  });
  $('logNextDay').addEventListener('click', () => {
    const d = addDays(parseDate(state.selectedDate), 1);
    state.selectedDate = fmt(d);
    setViewMonth(d.getFullYear(), d.getMonth());
  });

  // 记录页：经期开关
  els.periodToggle.addEventListener('click', () => {
    if (state.periodDays.has(state.selectedDate)) {
      state.periodDays.delete(state.selectedDate);
      // 取消经期日的同时，若该段曾被结束，也一并恢复（避免数据不一致）
      const periods = getPeriods();
      const ongoing = getOngoingPeriods(periods, getAvgPeriodLen(periods));
      const cur = findPeriodOf(state.selectedDate, periods, ongoing);
      if (cur && state.closedPeriods.has(cur.start)) {
        state.closedPeriods.delete(cur.start);
      }
    } else {
      state.periodDays.add(state.selectedDate);
    }
    renderLog();
    afterLogChange();
  });

  // 记录页：经期结束 / 恢复延续
  els.periodEndBtn.addEventListener('click', () => {
    const periods = getPeriods();
    const ongoing = getOngoingPeriods(periods, getAvgPeriodLen(periods));
    const cur = findPeriodOf(state.selectedDate, periods, ongoing);
    if (!cur) return;

    if (state.closedPeriods.has(cur.start)) {
      // 已结束 -> 恢复延续预测
      state.closedPeriods.delete(cur.start);
    } else {
      // 未结束 -> 把开始日到选中日之间所有日子都标记为经期（保证合并成一段），
      // 再关闭该段，使后续日期的虚线延续消失
      const startD = parseDate(cur.start);
      const endD = parseDate(state.selectedDate);
      for (let d = startD; d <= endD; d = addDays(d, 1)) {
        state.periodDays.add(fmt(d));
      }
      state.closedPeriods.add(cur.start);
    }
    renderLog();
    afterLogChange();
  });

  // 记录页：症状多选
  els.symptomChips.addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const log = getLog(state.selectedDate);
    const id = chip.dataset.symptom;
    const idx = log.symptoms.indexOf(id);
    if (idx >= 0) log.symptoms.splice(idx, 1);
    else log.symptoms.push(id);
    renderLog();
    afterLogChange();
  });

  // 记录页：心情单选（再点一次取消）
  els.moodRow.addEventListener('click', e => {
    const btn = e.target.closest('.mood-btn');
    if (!btn) return;
    const log = getLog(state.selectedDate);
    log.mood = (log.mood === btn.dataset.mood) ? '' : btn.dataset.mood;
    renderLog();
    afterLogChange();
  });

  // 记录页：备注
  els.noteInput.addEventListener('input', () => {
    const log = getLog(state.selectedDate);
    log.note = els.noteInput.value;
    afterLogChange();
  });
}

/* ---------- 启动 ---------- */
loadState();
bindEvents();
renderAll();

/* ---------- 对外接口（供 features.js 复用核心逻辑） ---------- */
window.PT = {
  // 状态
  state,
  saveState,
  loadState,
  afterLogChange,
  renderAll,
  STORAGE_KEY,

  // 计算
  getPeriods,
  getOngoingPeriods,
  getAvgCycle,
  getAvgPeriodLen,
  getPrediction,
  findOngoing,
  isInRange,

  // 日期工具
  fmt,
  parseDate,
  addDays,
  diffDays,
  today,
  fmtCN,
  fmtShort,

  // 常量
  DEFAULT_CYCLE,
  DEFAULT_PERIOD,

  // DOM 助手
  $,
  els
};

