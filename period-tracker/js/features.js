/* =========================================================
 * 月记 - 增强功能模块
 * 依赖 app.js 暴露的 window.PT 接口
 * 包含：数据导出/导入、深色模式、经期提醒、清空数据、通用提示
 * ========================================================= */

'use strict';

(function () {
  const PT = window.PT;
  if (!PT) {
    console.error('未找到 window.PT，请确认 app.js 已先加载。');
    return;
  }

  const { state, saveState, renderAll, fmt, parseDate, addDays, diffDays, today, fmtCN } = PT;

  const SETTINGS_KEY = 'periodTracker.settings';
  const BACKUP_VERSION = 2;

  /* ================= 通用 UI ================= */

  // 轻提示
  let toastTimer = null;
  function toast(msg, type) {
    const el = PT.$('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = 'toast';
    }, 2200);
  }

  // 确认弹窗（Promise 化）
  function confirmDialog(title, text, confirmLabel) {
    return new Promise(resolve => {
      const mask = PT.$('modalMask');
      const btnCancel = PT.$('modalCancel');
      const btnConfirm = PT.$('modalConfirm');

      PT.$('modalTitle').textContent = title;
      PT.$('modalText').textContent = text;
      btnConfirm.textContent = confirmLabel || '确定';
      mask.classList.add('show');

      function cleanup(result) {
        mask.classList.remove('show');
        btnCancel.removeEventListener('click', onCancel);
        btnConfirm.removeEventListener('click', onConfirm);
        mask.removeEventListener('click', onMask);
        resolve(result);
      }
      function onCancel() { cleanup(false); }
      function onConfirm() { cleanup(true); }
      function onMask(e) { if (e.target === mask) cleanup(false); }

      btnCancel.addEventListener('click', onCancel);
      btnConfirm.addEventListener('click', onConfirm);
      mask.addEventListener('click', onMask);
    });
  }

  /* ================= 设置持久化 ================= */

  const settings = {
    theme: 'auto',       // auto | light | dark
    remind: false        // 经期提醒开关
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) Object.assign(settings, JSON.parse(raw));
    } catch (e) {
      console.warn('读取设置失败', e);
    }
  }
  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('保存设置失败', e);
    }
  }

  /* ================= 深色模式 ================= */

  const THEME_ORDER = ['auto', 'light', 'dark'];
  const THEME_ICON = { auto: '🌗', light: '☀️', dark: '🌙' };
  const THEME_LABEL = { auto: '跟随系统', light: '浅色模式', dark: '深色模式' };

  function applyTheme() {
    const root = document.documentElement;
    let actual = settings.theme;

    if (settings.theme === 'auto') {
      actual = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
        ? 'dark' : 'light';
    }

    root.setAttribute('data-theme', actual);

    // 同步浏览器状态栏颜色
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', actual === 'dark' ? '#1c1619' : '#e8638c');

    const btn = PT.$('themeBtn');
    if (btn) {
      btn.textContent = THEME_ICON[settings.theme];
      btn.title = THEME_LABEL[settings.theme] + '（点击切换）';
    }
  }

  function cycleTheme() {
    const idx = THEME_ORDER.indexOf(settings.theme);
    settings.theme = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
    saveSettings();
    applyTheme();
    toast('已切换到' + THEME_LABEL[settings.theme]);
  }

  /* ================= 数据导出 / 导入 ================= */

  function buildBackup() {
    const periods = PT.getPeriods();
    return {
      app: 'period-tracker',
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      summary: {
        periodCount: periods.length,
        markedDays: state.periodDays.size,
        closedCount: state.closedPeriods.size,
        logDays: Object.keys(state.dailyLogs).length
      },
      data: {
        periodDays: [...state.periodDays],
        closedPeriods: [...state.closedPeriods],
        dailyLogs: state.dailyLogs,
        settings: { theme: settings.theme, remind: settings.remind }
      }
    };
  }

  function exportData() {
    if (state.periodDays.size === 0 && Object.keys(state.dailyLogs).length === 0) {
      toast('还没有可导出的数据', 'warn');
      return;
    }

    const backup = buildBackup();
    const json = JSON.stringify(backup, null, 2);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });

    const d = today();
    const name = '经期记录备份_' + d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') + '.json';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    toast('已导出 ' + backup.summary.periodCount + ' 次经期记录');
  }

  // 校验并解析备份内容
  function parseBackup(text) {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      return { ok: false, error: '文件不是有效的 JSON，可能已损坏' };
    }

    // 兼容两种结构：带 data 包装的，或直接的裸数据
    let periodDays, dailyLogs, closedPeriods;
    if (obj && obj.data && (obj.data.periodDays || obj.data.dailyLogs)) {
      periodDays = obj.data.periodDays || [];
      closedPeriods = obj.data.closedPeriods || [];
      dailyLogs = obj.data.dailyLogs || {};
    } else if (obj && (obj.periodDays || obj.dailyLogs)) {
      periodDays = obj.periodDays || [];
      closedPeriods = obj.closedPeriods || [];
      dailyLogs = obj.dailyLogs || {};
    } else {
      return { ok: false, error: '文件中没有找到经期数据，请确认选择了正确的备份文件' };
    }

    if (!Array.isArray(periodDays)) {
      return { ok: false, error: '经期数据格式不正确' };
    }

    // 过滤掉非法日期
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const validDays = periodDays.filter(s => typeof s === 'string' && dateRe.test(s));
    if (validDays.length !== periodDays.length) {
      console.warn('已过滤 ' + (periodDays.length - validDays.length) + ' 条非法日期');
    }

    return { ok: true, periodDays: validDays, closedPeriods: closedPeriods, dailyLogs: dailyLogs, meta: obj };
  }

  function importData() {
    const input = PT.$('importFile');
    input.value = '';       // 允许重复选择同一文件
    input.click();
  }

  async function handleImportFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast('文件过大，可能不是备份文件', 'warn');
      return;
    }

    let text;
    try {
      text = await file.text();
    } catch (e) {
      toast('读取文件失败', 'warn');
      return;
    }

    const res = parseBackup(text);
    if (!res.ok) {
      await confirmDialog('导入失败', res.error, '知道了');
      return;
    }

    const incomingCount = new Set(res.periodDays).size;
    const incomingLogs = Object.keys(res.dailyLogs || {}).length;
    const hasExisting = state.periodDays.size > 0 || Object.keys(state.dailyLogs).length > 0;

    let mode = 'replace';
    if (hasExisting) {
      const merge = await confirmDialog(
        '导入备份',
        '备份中包含 ' + incomingCount + ' 天经期记录、' + incomingLogs + ' 天日记。\n\n' +
        '当前已有数据：' + state.periodDays.size + ' 天经期、' +
        Object.keys(state.dailyLogs).length + ' 天日记。\n\n' +
        '选择「合并」会保留双方数据；选择「取消」则不导入。',
        '合并导入'
      );
      if (!merge) return;
      mode = 'merge';
    }

    if (mode === 'merge') {
      res.periodDays.forEach(d => state.periodDays.add(d));
      if (res.closedPeriods) res.closedPeriods.forEach(d => state.closedPeriods.add(d));
      Object.keys(res.dailyLogs || {}).forEach(k => {
        const inc = res.dailyLogs[k];
        const cur = state.dailyLogs[k];
        if (!cur) {
          state.dailyLogs[k] = inc;
        } else {
          // 合并字段
          const merged = new Set([...(cur.symptoms || []), ...(inc.symptoms || [])]);
          state.dailyLogs[k] = {
            symptoms: [...merged],
            mood: cur.mood || inc.mood || '',
            note: cur.note && inc.note ? (cur.note + '\n' + inc.note) : (cur.note || inc.note || '')
          };
        }
      });
    } else {
      state.periodDays = new Set(res.periodDays);
      state.closedPeriods = new Set(res.closedPeriods || []);
      state.dailyLogs = res.dailyLogs || {};
    }

    // 顺带恢复设置
    if (res.meta && res.meta.data && res.meta.data.settings) {
      if (res.meta.data.settings.theme) settings.theme = res.meta.data.settings.theme;
    }

    saveSettings();
    saveState();
    applyTheme();
    renderAll();
    updateDataMeta();

    toast('导入成功：' + mode === 'merge' ? '已合并 ' + incomingCount + ' 天记录' : '已恢复 ' + incomingCount + ' 天记录');
  }

  /* ================= 数据摘要 ================= */

  function updateDataMeta() {
    const el = PT.$('dataMeta');
    if (!el) return;

    const periods = PT.getPeriods();
    const logDays = Object.keys(state.dailyLogs).length;

    if (periods.length === 0 && logDays === 0) {
      el.textContent = '当前暂无数据';
      return;
    }

    const first = periods.length ? parseDate(periods[0].start) : null;
    const last = periods.length ? parseDate(periods[periods.length - 1].start) : null;

    let text = '共 ' + periods.length + ' 次经期 · ' + state.periodDays.size +
      ' 天经期 · ' + logDays + ' 天日记';
    if (state.closedPeriods.size > 0) {
      text += ' · ' + state.closedPeriods.size + ' 次已结束';
    }
    if (first && last) {
      text += '（' + fmtCN(first) + ' 起）';
    }
    el.textContent = text;
  }

  /* ================= 经期提醒 ================= */

  function updateRemindStatus() {
    const el = PT.$('remindStatus');
    if (!el) return;

    if (!settings.remind) {
      el.textContent = '提醒已关闭';
      return;
    }

    const info = getRemindInfo();
    el.textContent = info
      ? '提醒已开启 · ' + info.shortText
      : '提醒已开启 · 记录经期后即可给出提示';
  }

  // 计算当前提醒内容
  function getRemindInfo() {
    const periods = PT.getPeriods();
    if (periods.length === 0) return null;

    const pred = PT.getPrediction(periods);
    if (!pred) return null;

    const t = today();
    const untilNext = diffDays(t, pred.nextStart);

    // 是否正处于经期
    const inPeriod = periods.some(p =>
      t >= parseDate(p.start) && t <= parseDate(p.end));

    // 经期延续预测中
    const ongoingList = PT.getOngoingPeriods(periods, pred.avgPeriodLen);
    const ongoingToday = PT.findOngoing(t, ongoingList);

    if (inPeriod || ongoingToday) {
      const start = inPeriod
        ? periods[periods.length - 1].start
        : ongoingToday.start;
      const dayNum = diffDays(parseDate(start), t) + 1;
      return {
        type: 'period',
        level: 'warn',
        title: '经期第 ' + dayNum + ' 天',
        text: '经期期间注意保暖，多喝温水，避免劳累 🫖',
        shortText: '经期第 ' + dayNum + ' 天'
      };
    }

    if (untilNext < 0) {
      return {
        type: 'late',
        level: 'warn',
        title: '经期推迟 ' + (-untilNext) + ' 天',
        text: '预测经期应在 ' + fmtCN(pred.nextStart) + '，目前推迟了 ' +
          (-untilNext) + ' 天。偶尔推迟属正常，若推迟较久建议留意身体状态。',
        shortText: '已推迟 ' + (-untilNext) + ' 天'
      };
    }

    if (untilNext === 0) {
      return {
        type: 'due',
        level: 'warn',
        title: '预计今天来经期',
        text: '根据你的周期推算，今天可能是经期第一天。记得及时记录 🩸',
        shortText: '预计今天来'
      };
    }

    if (untilNext <= 3) {
      return {
        type: 'soon',
        level: 'info',
        title: '经期还有 ' + untilNext + ' 天',
        text: '预计 ' + fmtCN(pred.nextStart) + ' 左右开始，提前做好准备吧～',
        shortText: '还有 ' + untilNext + ' 天'
      };
    }

    // 排卵期提示
    if (fmt(pred.ovulation) === fmt(t)) {
      return {
        type: 'ovulation',
        level: 'info',
        title: '今天是排卵日',
        text: '排卵日通常在下次经期前约 14 天，受孕概率较高。',
        shortText: '今天是排卵日'
      };
    }

    return {
      type: 'normal',
      level: 'ok',
      title: '距离下次经期约 ' + untilNext + ' 天',
      text: '预测下次经期在 ' + fmtCN(pred.nextStart) + ' 开始。',
      shortText: '还有 ' + untilNext + ' 天'
    };
  }

  // 首页顶部提醒条（打开应用时展示）
  function renderRemindBanner() {
    if (!settings.remind) return;

    const info = getRemindInfo();
    if (!info || info.level === 'ok') return;

    // 已完成经期记录时不重复提醒
    const t = today();
    if (info.type === 'period') {
      const alreadyLogged = state.periodDays.has(fmt(t)) || state.periodDays.has(fmt(addDays(t, -1)));
      if (alreadyLogged) return;
    }

    const card = PT.$('statusCard');
    if (!card) return;

    const banner = document.createElement('div');
    banner.className = 'remind-banner ' + info.level;
    banner.innerHTML =
      '<span class="remind-icon">' + (info.level === 'warn' ? '🔔' : 'ℹ️') + '</span>' +
      '<div class="remind-body">' +
        '<strong>' + info.title + '</strong>' +
        '<small>' + info.text + '</small>' +
      '</div>' +
      '<button class="remind-close" aria-label="关闭">✕</button>';

    banner.querySelector('.remind-close').addEventListener('click', () => {
      banner.remove();
    });

    card.parentNode.insertBefore(banner, card);
  }

  /* ================= 清空数据 ================= */

  async function clearAllData() {
    const hasData = state.periodDays.size > 0 || Object.keys(state.dailyLogs).length > 0;
    if (!hasData) {
      toast('当前没有数据');
      return;
    }

    const ok = await confirmDialog(
      '清空所有数据',
      '将删除全部 ' + state.periodDays.size + ' 天经期记录和 ' +
      Object.keys(state.dailyLogs).length + ' 天日记。\n\n' +
      '已登录时，云端记录也会一并清除。此操作不可撤销，确定要继续吗？',
      '确认清空'
    );
    if (!ok) return;

    // 二次确认，避免误删
    const sure = await confirmDialog(
      '再次确认',
      '数据删除后无法恢复。如果还没备份，建议先取消并导出备份。',
      '我已备份，清空'
    );
    if (!sure) return;

    state.periodDays = new Set();
    state.closedPeriods = new Set();
    state.dailyLogs = {};
    saveState();
    renderAll();
    updateDataMeta();
    toast('已清空所有数据');
  }

  /* ================= 事件绑定 ================= */

  function bindFeatureEvents() {
    // 深色模式切换
    const themeBtn = PT.$('themeBtn');
    if (themeBtn) themeBtn.addEventListener('click', cycleTheme);

    // 跟随系统主题变化
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const onChange = () => { if (settings.theme === 'auto') applyTheme(); };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }

    // 导出
    const exportBtn = PT.$('exportBtn');
    if (exportBtn) exportBtn.addEventListener('click', exportData);

    // 导入
    const importBtn = PT.$('importBtn');
    if (importBtn) importBtn.addEventListener('click', importData);

    const fileInput = PT.$('importFile');
    if (fileInput) {
      fileInput.addEventListener('change', e => {
        const file = e.target.files && e.target.files[0];
        handleImportFile(file);
      });
    }

    // 提醒开关
    const remindToggle = PT.$('remindToggle');
    if (remindToggle) {
      remindToggle.checked = settings.remind;
      remindToggle.addEventListener('change', () => {
        settings.remind = remindToggle.checked;
        saveSettings();
        updateRemindStatus();
        renderRemindBanner();
        toast(settings.remind ? '已开启经期提醒' : '已关闭经期提醒');
      });
    }

    // 清空数据
    const clearBtn = PT.$('clearBtn');
    if (clearBtn) clearBtn.addEventListener('click', clearAllData);

    // 切到统计页时刷新数据摘要
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.page === 'stats') {
          updateDataMeta();
          updateRemindStatus();
        }
      });
    });
  }

  /* ================= PWA ================= */

  function setupPWA() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(err => {
        console.warn('Service Worker 注册失败：', err);
      });
    });
  }

  /* ================= 启动 ================= */

  function init() {
    loadSettings();
    applyTheme();
    bindFeatureEvents();
    updateDataMeta();
    updateRemindStatus();
    renderRemindBanner();
    setupPWA();

    // 每天首次打开时重置提醒条的关闭状态（下次打开会再次提示）
    window.__PT_FEATURES_READY__ = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 暴露给其他脚本/调试
  window.PTFeatures = {
    analyzeCycle: () => PT.getPeriods() && null,  // 占位，实际分析在 app.js
    getRemindInfo,
    exportData,
    toast,
    confirmDialog
  };
})();
