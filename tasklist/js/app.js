/* =========================================================
 * 任务清单 - 界面逻辑
 *
 * 结构：
 *   - 三个页面：日历（主）/ 清单总览 / 我的
 *   - 日历：只渲染当月；格子上是任务徽标（待办数 / 逾期红 / 全完成绿）
 *   - 点某天 → 当天面板；底部输入框回车即建任务
 *   - 清单：按 逾期/今天/明天/本周/以后/已完成 分组
 *   - 任务操作：行内勾选直接完成；整行或 ⋯ 打开操作菜单（完成/延期/编辑/删除）
 *   - 任何数据变更：renderAll() + 云端防抖推送
 * ========================================================= */

(function () {
  'use strict';

  const S = window.TaskStore;
  const Cloud = window.TaskCloud;

  const state = {
    viewMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    selectedDate: S.todayStr(),
    doneCollapsed: true,
    editingId: null,   // 编辑弹窗当前任务
    sheetId: null      // 操作菜单当前任务
  };

  const SETTINGS_KEY = 'taskList.settings';
  let settings = { theme: 'light' };
  try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) {}

  function $id(id) { return document.getElementById(id); }
  const els = {};

  /* ---------------- 工具 ---------------- */

  function pad2(n) { return String(n).padStart(2, '0'); }

  const WEEK_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  function fmtCN(dateStr) {
    const d = S.parseDate(dateStr);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  let toastTimer = null;
  function toast(msg) {
    const el = els.toast;
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 2000);
  }

  /* ---------------- 数据变更入口 ---------------- */

  function change() {
    S.persist();
    Cloud.schedulePush();
    renderAll();
  }

  /* ---------------- 主题 ---------------- */

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', settings.theme);
    const t = els.themeToggle;
    if (t) t.textContent = settings.theme === 'dark' ? '🌙' : '☀️';
  }

  function toggleTheme() {
    settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    applyTheme();
  }

  /* ---------------- Tab 切换 ---------------- */

  function switchPage(name) {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.page === name);
    });
    document.querySelectorAll('.page').forEach(function (p) {
      p.classList.toggle('active', p.id === 'page-' + name);
    });
    if (name === 'list') renderList();
    if (name === 'calendar') renderCalendar();
  }

  /* ---------------- 年月快速选择 ---------------- */

  const ym = { year: 0 };

  function renderYM() {
    els.ymYear.textContent = ym.year + ' 年';
    const curY = state.viewMonth.getFullYear();
    const curM = state.viewMonth.getMonth();
    const t = S.parseDate(S.todayStr());
    let html = '';
    for (let i = 0; i < 12; i++) {
      const cls = ['ym-month'];
      if (ym.year === curY && i === curM) cls.push('active');
      if (ym.year === t.getFullYear() && i === t.getMonth()) cls.push('is-now');
      html += '<button type="button" class="' + cls.join(' ') + '" data-month="' + i + '">' +
        (i + 1) + '月</button>';
    }
    els.ymMonths.innerHTML = html;
  }

  function openYM() {
    ym.year = state.viewMonth.getFullYear();
    renderYM();
    els.ymMask.classList.add('show');
  }

  function closeYM() {
    els.ymMask.classList.remove('show');
  }

  /**
   * 切换显示月份。选中日若不在目标月，自动落到该月（本月取今天，其它月取 1 号），
   * 免得日历换了月、下方当天面板还停在上个月。
   */
  function setViewMonth(y, m) {
    state.viewMonth = new Date(y, m, 1);
    const sel = S.parseDate(state.selectedDate);
    if (sel.getFullYear() !== y || sel.getMonth() !== m) {
      const todayStr = S.todayStr();
      const t = S.parseDate(todayStr);
      const sameMonth = (t.getFullYear() === y && t.getMonth() === m);
      state.selectedDate = sameMonth ? todayStr : S.fmtDate(new Date(y, m, 1));
    }
    renderCalendar();
  }

  /* ---------------- 日历 ---------------- */

  function dayBadge(dateStr) {
    const list = S.onDate(dateStr);
    const todo = list.filter(function (t) { return t.status === 'todo'; }).length;
    const done = list.length - todo;
    const overdue = list.filter(function (t) { return S.isOverdue(t); }).length;
    return { total: list.length, todo: todo, done: done, overdue: overdue };
  }

  function renderCalendar() {
    const y = state.viewMonth.getFullYear();
    const m = state.viewMonth.getMonth();
    if (els.monthTitle) {
      els.monthTitle.textContent = y + ' 年 ' + (m + 1) + ' 月';
    }

    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const first = new Date(y, m, 1);
    let startOffset = first.getDay() - 1;          // 周一为一周开始
    if (startOffset < 0) startOffset = 6;
    const tStr = S.todayStr();

    let html = '';
    for (let i = 0; i < startOffset; i++) {
      html += '<span class="cal-empty"></span>';
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(y, m, d);
      const s = S.fmtDate(date);
      const b = dayBadge(s);
      const classes = ['cal-cell'];
      if (s === tStr) classes.push('today');
      if (s === state.selectedDate) classes.push('selected');
      if (b.overdue > 0) classes.push('has-overdue');
      else if (b.todo > 0) classes.push('has-todo');
      else if (b.done > 0) classes.push('has-done');

      html += '<button type="button" class="' + classes.join(' ') + '" data-date="' + s + '">' +
        '<span class="cal-num">' + d + '</span>';
      if (b.total > 0) {
        html += b.todo > 0
          ? '<span class="cal-badge">' + b.todo + '</span>'
          : '<span class="cal-dot"></span>';
      }
      html += '</button>';
    }
    if (els.calGrid) els.calGrid.innerHTML = html;
    renderDayPanel();
  }

  function renderDayPanel() {
    const s = state.selectedDate;
    const d = S.parseDate(s);
    if (els.dayTitle) {
      els.dayTitle.textContent = fmtCN(s) + ' · ' + WEEK_CN[d.getDay()] +
        (s === S.todayStr() ? '（今天）' : '');
    }

    const list = S.onDate(s);
    const todo = list.filter(function (t) { return t.status === 'todo'; });
    const done = list.filter(function (t) { return t.status === 'done'; });
    todo.sort(function (a, b) { return a.created_at < b.created_at ? -1 : 1; });
    done.sort(function (a, b) { return (a.completed_at || '') < (b.completed_at || '') ? 1 : -1; });

    if (els.dayCount) {
      els.dayCount.textContent = list.length
        ? todo.length + ' 待办 · ' + done.length + ' 完成'
        : '';
    }
    if (els.dayTasks) {
      els.dayTasks.innerHTML =
        rowList(todo.concat(done)) ||
        '<li class="empty-hint">这一天还没有任务</li>';
    }
  }

  /* ---------------- 任务行 ---------------- */

  function rowHtml(t) {
    const overdue = S.isOverdue(t);
    const cls = ['task-row'];
    if (t.status === 'done') cls.push('done');
    if (overdue) cls.push('overdue');

    let tags = '';
    if (overdue) tags += '<span class="tag overdue">逾期</span>';
    if (t.defer_count > 0) tags += '<span class="tag defer">延' + t.defer_count + '次</span>';
    if (t.due_date !== S.todayStr() && t.status === 'todo') {
      tags += '<span class="tag due">' + fmtCN(t.due_date) + '</span>';
    }

    return '<li class="' + cls.join(' ') + '" data-id="' + t.id + '">' +
      '<button type="button" class="check" data-check="' + t.id + '" aria-label="完成">' +
      (t.status === 'done' ? '✓' : '') + '</button>' +
      '<div class="task-main" data-open="' + t.id + '">' +
      '<span class="task-title">' + escapeHtml(t.title) + '</span>' +
      (tags ? '<span class="task-tags">' + tags + '</span>' : '') +
      '</div>' +
      '<button type="button" class="more" data-open="' + t.id + '" aria-label="更多操作">⋯</button>' +
      '</li>';
  }

  function rowList(tasks) {
    return tasks.map(rowHtml).join('');
  }

  /* ---------------- 清单总览 ---------------- */

  function groupTasks() {
    const today = S.todayStr();
    const tomorrow = S.fmtDate(S.addDays(S.parseDate(today), 1));
    const weekEnd = S.fmtDate(S.addDays(S.parseDate(today), 6));
    const list = S.all();

    const g = {
      overdue: [], today: [], tomorrow: [], week: [], later: [], done: []
    };
    list.forEach(function (t) {
      if (t.status === 'done') { g.done.push(t); return; }
      if (t.due_date < today) g.overdue.push(t);
      else if (t.due_date === today) g.today.push(t);
      else if (t.due_date === tomorrow) g.tomorrow.push(t);
      else if (t.due_date <= weekEnd) g.week.push(t);
      else g.later.push(t);
    });
    const byDue = function (a, b) { return a.due_date < b.due_date ? -1 : 1; };
    const byDone = function (a, b) {
      return (a.completed_at || '') > (b.completed_at || '') ? -1 : 1;
    };
    g.overdue.sort(byDue);
    g.today.sort(byDue);
    g.tomorrow.sort(byDue);
    g.week.sort(byDue);
    g.later.sort(byDue);
    g.done.sort(byDone);
    return g;
  }

  function renderList() {
    const g = groupTasks();
    const st = S.stats();

    if (els.statTodo) els.statTodo.textContent = st.todoToday;
    if (els.statDone) els.statDone.textContent = st.doneToday;
    if (els.statRate) els.statRate.textContent = st.weekRate === null ? '–' : st.weekRate + '%';

    const defs = [
      { key: 'overdue', label: '⏰ 已逾期' },
      { key: 'today', label: '📌 今天' },
      { key: 'tomorrow', label: '明天' },
      { key: 'week', label: '本周稍后' },
      { key: 'later', label: '以后' },
      { key: 'done', label: '✅ 已完成' }
    ];

    let html = '';
    defs.forEach(function (def) {
      const tasks = g[def.key];
      if (!tasks.length) return;
      const collapsed = def.key === 'done' && state.doneCollapsed && tasks.length > 3;
      const shown = collapsed ? tasks.slice(0, 3) : tasks;
      html += '<div class="group-card">' +
        '<div class="group-head" data-group="' + def.key + '">' +
        '<span>' + def.label + '</span>' +
        '<span class="group-count">' + tasks.length + '</span>' +
        '</div>' +
        '<ul class="task-list">' + rowList(shown) + '</ul>';
      if (collapsed) {
        html += '<button type="button" class="expand-btn" data-group="done">展开全部 ' +
          tasks.length + ' 项 ▾</button>';
      }
      html += '</div>';
    });

    if (els.taskGroups) {
      els.taskGroups.innerHTML = html ||
        '<div class="group-card"><p class="empty-hint">还没有任务，去日历挑一天安排上吧</p></div>';
    }

    // 头部一句话概览
    if (els.headerSub) {
      const n = st.todoToday + st.overdue;
      els.headerSub.textContent = n > 0
        ? '今天还有 ' + n + ' 件事' + (st.overdue ? '（' + st.overdue + ' 件逾期）' : '')
        : '今天没有安排，享受吧 ✨';
    }
  }

  /* ---------------- 操作菜单 ---------------- */

  function openSheet(id) {
    const t = S.get(id);
    if (!t) return;
    state.sheetId = id;
    if (els.sheetTitle) {
      els.sheetTitle.textContent = t.title.length > 24 ? t.title.slice(0, 24) + '…' : t.title;
    }
    if (els.sheetToggle) {
      els.sheetToggle.textContent = t.status === 'done' ? '↩︎ 取消完成' : '✓ 标记完成';
    }
    if (els.actionSheet) els.actionSheet.classList.remove('hidden');
  }

  function closeSheet() {
    state.sheetId = null;
    if (els.actionSheet) els.actionSheet.classList.add('hidden');
  }

  function openDateModal(defaultDate) {
    if (els.datePick) els.datePick.value = defaultDate;
    if (els.dateModal) els.dateModal.classList.remove('hidden');
  }

  function closeDateModal() {
    if (els.dateModal) els.dateModal.classList.add('hidden');
  }

  function handleSheetAct(act) {
    const id = state.sheetId;
    const t = id && S.get(id);
    if (!t) { closeSheet(); return; }

    if (act === 'cancel') { closeSheet(); return; }

    if (act === 'toggle') {
      const done = t.status !== 'done';
      S.setDone(id, done);
      toast(done ? '已完成 🎉' : '已改回待办');
      closeSheet(); change(); return;
    }

    if (act === 'defer1' || act === 'defer3' || act === 'defer7') {
      const n = act === 'defer1' ? 1 : act === 'defer3' ? 3 : 7;
      S.deferTo(id, S.fmtDate(S.addDays(S.parseDate(t.due_date), n)));
      toast('已延期 ' + n + ' 天');
      closeSheet(); change(); return;
    }

    if (act === 'pick') {
      const next = S.fmtDate(S.addDays(S.parseDate(t.due_date), 1));
      closeSheet();
      openDateModal(next);
      return;
    }

    if (act === 'edit') {
      closeSheet();
      openEdit(id);
      return;
    }

    if (act === 'delete') {
      S.softDelete(id);
      toast('已删除');
      closeSheet(); change(); return;
    }
  }

  /* ---------------- 编辑弹窗 ---------------- */

  function openEdit(taskId, defaultDue) {
    state.editingId = taskId || null;
    const t = taskId && S.get(taskId);
    if (els.editModalTitle) {
      els.editModalTitle.textContent = t ? '编辑任务' : '新建任务';
    }
    if (els.editTitleInput) els.editTitleInput.value = t ? t.title : '';
    if (els.editNote) els.editNote.value = t ? t.note : '';
    if (els.editDate) {
      els.editDate.value = t ? t.due_date : (defaultDue || state.selectedDate || S.todayStr());
    }
    if (els.editError) els.editError.classList.add('hidden');
    if (els.editModal) els.editModal.classList.remove('hidden');
    if (els.editTitleInput) {
      setTimeout(function () { els.editTitleInput.focus(); }, 80);
    }
  }

  function closeEdit() {
    state.editingId = null;
    if (els.editModal) els.editModal.classList.add('hidden');
  }

  function submitEdit(ev) {
    ev.preventDefault();
    const title = (els.editTitleInput.value || '').trim();
    if (!title) {
      if (els.editError) {
        els.editError.textContent = '请填写标题';
        els.editError.classList.remove('hidden');
      }
      return;
    }
    const note = els.editNote.value || '';
    const due = els.editDate.value || S.todayStr();
    if (state.editingId) {
      S.patch(state.editingId, { title: title, note: note, due: due });
      toast('已保存');
    } else {
      S.create({ title: title, note: note, due: due });
      toast('已添加');
    }
    closeEdit();
    change();
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    // tab
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchPage(b.dataset.page); });
    });

    // 月份切换
    if (els.prevMonth) els.prevMonth.addEventListener('click', function () {
      const d = new Date(state.viewMonth.getFullYear(), state.viewMonth.getMonth() - 1, 1);
      setViewMonth(d.getFullYear(), d.getMonth());
    });
    if (els.nextMonth) els.nextMonth.addEventListener('click', function () {
      const d = new Date(state.viewMonth.getFullYear(), state.viewMonth.getMonth() + 1, 1);
      setViewMonth(d.getFullYear(), d.getMonth());
    });

    // 点月份标题 -> 年月快选
    if (els.monthTitle) els.monthTitle.addEventListener('click', openYM);
    if (els.ymPrevYear) els.ymPrevYear.addEventListener('click', function () { ym.year--; renderYM(); });
    if (els.ymNextYear) els.ymNextYear.addEventListener('click', function () { ym.year++; renderYM(); });
    if (els.ymCancel) els.ymCancel.addEventListener('click', closeYM);
    if (els.ymMask) els.ymMask.addEventListener('click', function (ev) {
      if (ev.target === els.ymMask) closeYM();
    });
    if (els.ymToday) els.ymToday.addEventListener('click', function () {
      const todayStr = S.todayStr();
      const t = S.parseDate(todayStr);
      state.selectedDate = todayStr;
      closeYM();
      setViewMonth(t.getFullYear(), t.getMonth());
      toast('已回到今天');
    });
    if (els.ymMonths) els.ymMonths.addEventListener('click', function (ev) {
      const btn = ev.target.closest('.ym-month');
      if (!btn) return;
      closeYM();
      setViewMonth(ym.year, Number(btn.dataset.month));
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && els.ymMask && els.ymMask.classList.contains('show')) closeYM();
    });

    // 日历点击（事件委托）
    if (els.calGrid) els.calGrid.addEventListener('click', function (ev) {
      const cell = ev.target.closest('.cal-cell');
      if (!cell || !cell.dataset.date) return;
      state.selectedDate = cell.dataset.date;
      renderCalendar();
    });

    // 任务列表点击（勾选 / 打开菜单）
    [els.dayTasks, els.taskGroups].forEach(function (box) {
      if (!box) return;
      box.addEventListener('click', function (ev) {
        const check = ev.target.closest('[data-check]');
        if (check) {
          const id = check.dataset.check;
          const t = S.get(id);
          if (!t) return;
          const done = t.status !== 'done';
          S.setDone(id, done);
          toast(done ? '已完成 🎉' : '已改回待办');
          change();
          return;
        }
        const open = ev.target.closest('[data-open]');
        if (open) openSheet(open.dataset.open);
      });
    });

    // 已完成分组折叠
    if (els.taskGroups) els.taskGroups.addEventListener('click', function (ev) {
      const head = ev.target.closest('[data-group]');
      if (!head) return;
      if (head.dataset.group === 'done') {
        state.doneCollapsed = !state.doneCollapsed;
        renderList();
      }
    });

    // 快速添加
    if (els.quickAddForm) els.quickAddForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const v = (els.quickAddInput.value || '').trim();
      if (!v) return;
      S.create({ title: v, due: state.selectedDate });
      els.quickAddInput.value = '';
      toast('已添加');
      change();
    });

    // 新建任务
    if (els.addTaskBtn) els.addTaskBtn.addEventListener('click', function () {
      openEdit(null, S.todayStr());
    });

    // 操作菜单
    if (els.actionSheet) els.actionSheet.addEventListener('click', function (ev) {
      if (ev.target === els.actionSheet) { closeSheet(); return; }
      const btn = ev.target.closest('[data-act]');
      if (btn) handleSheetAct(btn.dataset.act);
    });

    // 编辑弹窗
    if (els.editForm) els.editForm.addEventListener('submit', submitEdit);
    if (els.editCancel) els.editCancel.addEventListener('click', closeEdit);
    if (els.editModal) els.editModal.addEventListener('click', function (ev) {
      if (ev.target === els.editModal) closeEdit();
    });

    // 日期弹窗（延期）
    if (els.dateForm) els.dateForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const id = state.sheetId;
      const v = els.datePick.value;
      closeDateModal();
      if (!id || !v) return;
      S.deferTo(id, v);
      toast('已延期');
      change();
    });
    if (els.dateCancel) els.dateCancel.addEventListener('click', closeDateModal);
    if (els.dateModal) els.dateModal.addEventListener('click', function (ev) {
      if (ev.target === els.dateModal) closeDateModal();
    });

    // 主题
    if (els.themeToggle) els.themeToggle.addEventListener('click', toggleTheme);
  }

  /* ---------------- 渲染入口 ---------------- */

  function renderAll() {
    renderCalendar();
    renderList();
  }

  function init() {
    [
      'monthTitle', 'calGrid', 'dayTitle', 'dayCount', 'dayTasks', 'quickAddForm',
      'quickAddInput', 'prevMonth', 'nextMonth', 'statTodo', 'statDone', 'statRate',
      'addTaskBtn', 'taskGroups', 'headerSub', 'actionSheet', 'sheetTitle', 'sheetToggle',
      'editModal', 'editForm', 'editModalTitle', 'editTitleInput', 'editNote', 'editDate',
      'editError', 'editCancel', 'dateModal', 'dateForm', 'datePick', 'dateCancel',
      'ymMask', 'ymPrevYear', 'ymNextYear', 'ymYear', 'ymMonths', 'ymToday', 'ymCancel',
      'themeToggle', 'toast'
    ].forEach(function (id) { els[id] = $id(id); });

    applyTheme();
    bind();

    // 云端状态变化（登录 / 同步完成 / 出错）→ 刷新账号卡片并重渲染
    Cloud.onChange(function () { renderAll(); });

    renderAll();
    window.__TASK_APP_READY__ = true;

    // 注册 Service Worker：装到桌面后可离线打开（网络优先，不会卡住更新）
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function (e) {
          console.warn('[App] Service Worker 注册失败', e);
        });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
