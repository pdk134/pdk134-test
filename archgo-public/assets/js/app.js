/* 架构术语学习通 —— 交互逻辑 */
(function () {
  'use strict';

  var TERMS = [];
  var byId = {};
  var CATS = [];
  var $ = function (s) { return document.querySelector(s); };

  /**
   * 安全的事件绑定：元素不存在时打一条醒目警告并跳过，而不是抛 TypeError。
   *
   * 为什么需要它：Service Worker 是 cache-first，版本切换的那一瞬间可能出现
   * 「新 index.html + 旧 app.js」的错搭。此时本文件里对已删除元素的引用会抛错，
   * 中断整个 IIFE，导致该行之后的**所有**事件绑定静默失效——
   * 实际就表现为「学习页正常，但登录/注册按钮点了没反应」。
   * 改成安全绑定后，即使再出现错搭，也只是少绑一个按钮并留下 console 警告，不会连坐。
   */
  function bind(sel, evt, fn) {
    var el = $(sel);
    if (!el) { console.warn('[bind] 元素不存在，已跳过绑定：' + sel + '  事件：' + evt); return null; }
    el.addEventListener(evt, fn);
    return el;
  }

  /* ---------------- 登录门禁 ---------------- */
  /**
   * 未登录 = 不能进入应用。门禁整页盖住，应用本体 visibility:hidden。
   *
   * 四个状态：
   *   off      —— 页面里没有门禁节点（正常不会出现，见 ensureGate 的兜底），完全放行
   *   checking —— 启动就盖上，等 Supabase 的 getSession() 返回
   *   locked   —— 已确认未登录，等用户登录
   *   open     —— 已登录，放行
   *
   * 关键取舍：登录表单是「搬」进来的，不是复制一份。
   * 门禁与账号页共用同一个 #acctAuth 节点，于是校验、错误提示、防重复提交、
   * 邮箱/用户名双支持全都只有一套实现，不会出现两个入口行为不一致。
   * appendChild 会带着节点上已绑的事件监听一起搬走，不需要重新绑定。
   */
  var gateState = 'checking';

  var GATE_MARKUP =
    '<div class="gate-logo">架</div>' +
    '<h2 class="gate-title">架构术语学习通</h2>' +
    '<p class="gate-sub" id="gateSub"><span class="spin"></span>正在检查登录状态…</p>' +
    '<div class="gate-env hidden" id="gateEnv"></div>' +
    '<div class="gate-form" id="gateForm"></div>' +
    '<button class="btn ghost block hidden" id="gateRetry">重新加载</button>' +
    '<p class="gate-foot">登录后学习进度在手机与电脑之间自动同步</p>';

  /**
   * 页面里没有门禁节点时按需补一个。
   * SW 是 cache-first，发布过程中可能出现「新 app.js + 旧 index.html」的错搭；
   * 门禁若只存在于 HTML 里，那一刻就会整个失效 —— 而那正是最需要它生效的时刻。
   */
  function ensureGate() {
    var g = $('#gate');
    if (g) return g;
    g = document.createElement('div');
    g.className = 'gate';
    g.id = 'gate';
    g.innerHTML = GATE_MARKUP;
    document.body.insertBefore(g, document.body.firstChild);
    return g;
  }

  /** 把登录面板搬进目标容器（幂等）。搬回账号页时放回原位，保持两个面板的先后顺序 */
  function moveAuthPanel(slot) {
    var panel = $('#acctAuth'), home = $('#view-account');
    if (!panel || !slot || !home) return;
    if (slot === home) {
      if (panel !== home.firstChild) home.insertBefore(panel, home.firstChild);
      return;
    }
    if (panel.parentNode !== slot) slot.appendChild(panel);
  }

  function envForced() {
    try { return new URLSearchParams(location.search).get('env') != null; }
    catch (e) { return /[?&]env\b/.test(location.search); }
  }

  /** 门禁里的环境标识：门禁盖住 .app，此时顶部的 env-badge 看不到，这里补一份 */
  function renderGateEnv() {
    var el = $('#gateEnv');
    if (!el) return;
    var isDev = Sync.envName() !== 'prod';
    if (!isDev && !envForced()) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = isDev
      ? '⚠ 开发环境 · 数据存于开发库，与生产互不相通'
      : '生产环境 · ' + projectTag() + ' · 表 ' + Sync.tableName();
  }

  function paintGate(text, isErr) {
    var sub = $('#gateSub'), retry = $('#gateRetry'), noCfg = $('#acctNoCfg');
    if (sub) { sub.textContent = text; sub.classList.toggle('err', !!isErr); }
    if (retry) retry.classList.toggle('hidden', !isErr);
    if (noCfg) noCfg.classList.toggle('hidden', Sync.hasConfig());
  }

  function lockGate(text, isErr) {
    gateState = 'locked';
    moveAuthPanel($('#gateForm'));
    ensureGate().classList.remove('hidden');
    document.body.classList.add('gated');
    paintGate(text, isErr);
    renderGateEnv();
  }

  function openGate() {
    gateState = 'open';
    moveAuthPanel($('#view-account'));
    ensureGate().classList.add('hidden');
    document.body.classList.remove('gated');
    renderEnvBadge();
  }

  /**
   * 会话状态每次变化都过一遍这里，登录与退出登录都自动生效（含 token 过期、
   * 其它标签页退出后被同步过来的情况），不靠各自的按钮回调去切。
   * checking 阶段不落到 locked，免得刚显示「正在检查」就闪成「请登录」。
   */
  function applyGate() {
    var s = Sync.state();
    var want = s.email ? 'open' : 'locked';
    if (gateState === want) return;
    if (want === 'open') { openGate(); return; }
    if (!Sync.hasConfig()) lockGate('当前版本未内置云端服务，暂时无法登录', true);
    else if (s.status === 'error') lockGate(s.message || '登录服务暂时不可用，请检查网络', true);
    else lockGate('登录后即可开始学习');
  }

  /**
   * 启动即盖门禁。会话判定要等一次异步 getSession()，在那之前不能露出应用，
   * 所以先摆「正在检查」的姿势，而不是等结果出来再盖（那样会看到应用闪一下）。
   */
  function armGate() {
    ensureGate();
    moveAuthPanel($('#gateForm'));
    $('#gate').classList.remove('hidden');
    document.body.classList.add('gated');
  }
  armGate();

  function initTerms() {
    TERMS = (window.TERMS || []).slice();
    byId = {}; CATS = [];
    TERMS.forEach(function (t) {
      t.id = t.t;
      byId[t.id] = t;
      if (CATS.indexOf(t.c) < 0) CATS.push(t.c);
    });
  }

  /* ---------------- 按需懒加载数据脚本（首屏减负，离线仍可用） ---------------- */
  var _SCRIPTS = {};
  function loadScript(name) {
    if (_SCRIPTS[name]) return _SCRIPTS[name];
    _SCRIPTS[name] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'assets/js/' + name;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('加载失败: ' + name)); };
      document.head.appendChild(s);
    });
    return _SCRIPTS[name];
  }
  var _ready = {};
  function ensureTerms() { return loadScript('terms.js').then(function () { if (!_ready.terms) { initTerms(); _ready.terms = true; } }); }
  /* 纯净版：真题/案例/论文/教材考点数据已下线，以下函数仅保留空实现以防旧代码引用报错 */
  function ensureExam() { return Promise.resolve(); }
  function ensureCase() { return Promise.resolve(); }
  function ensureEssay() { return Promise.resolve(); }
  function ensurePoints() { return Promise.resolve(); }

  /* ---------------- 通用 ---------------- */
  var VIEWS = {
    learn: ['今日学习', '按间隔重复安排复习，稳步把这些术语变成本能'],
    library: ['术语词库', '浏览、检索全部术语，支持按分类与状态筛选'],
    quiz: ['术语自测', '术语卡片测验，检验记忆成果，错题自动进难词本'],
    stats: ['学习统计', '掌握进度、每日学习量与难词本'],
    settings: ['设置', '学习计划、数据备份与快捷键'],
    account: ['账号与同步', '学习进度在手机与电脑之间自动同步']
  };

  var currentViewName = 'learn';
  function switchView(name) {
    var list = document.querySelectorAll('.view');
    for (var i = 0; i < list.length; i++) list[i].classList.toggle('active', list[i].id === 'view-' + name);
    var items = document.querySelectorAll('.tab-item');
    for (var j = 0; j < items.length; j++) items[j].classList.toggle('active', items[j].getAttribute('data-view') === name);
    $('#pageTitle').textContent = VIEWS[name][0];
    $('#pageSub').textContent = VIEWS[name][1];
    if (name === 'learn') ensureTerms().then(function () { if (!session.items.length) startSession(); else renderCard(); });
    if (name === 'library') ensureTerms().then(renderLibrary);
    if (name === 'stats') ensureTerms().then(renderStats);
    if (name === 'account') renderAccount();
    if (name === 'settings') renderBackups();
    if (name === 'quiz') {
      ensureTerms();
      $('#quizTerm').classList.remove('hidden');
    }
    window.scrollTo(0, 0);
    currentViewName = name;
  }

  /* 手势护栏时间戳：滑动评分后 600ms 内忽略合成 click */
  var guardUntil = 0;

  var toastTimer;  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 1800);
  }

  function speak(text) {
    if (!window.speechSynthesis) return;
    var u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    u.rate = 0.95;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  function statusLabel(id) {
    var c = Store.raw(id), s = SRS.statusOf(c);
    if (s === 'new') return { text: '未学习', cls: '' };
    if (s === 'mastered') return { text: '已掌握', cls: 'mastered' };
    return { text: '学习中', cls: 'learning' };
  }

  /* 触觉反馈（iOS Safari 不支持时静默跳过） */
  function buzz(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {}
  }

  function levelText(lv) { return ['', '基础', '进阶', '高阶'][lv] || '基础'; }

  /* ---------------- 学习会话 ---------------- */
  var session = { items: [], idx: 0, newCount: 0, okCount: 0, total: 0 };

  function buildQueue(extra) {
    var now = Date.now(), s = Store.data.settings;
    var due = [], fresh = [];
    TERMS.forEach(function (t) {
      var c = Store.raw(t.id);
      if (!c || c.reps === 0) fresh.push(t.id);
      else if ((c.due || 0) <= now) due.push({ id: t.id, due: c.due });
    });
    due.sort(function (a, b) { return a.due - b.due; });

    var limR = extra ? due.length : s.dailyReview;
    var limN = extra ? s.dailyNew + extra : s.dailyNew;
    var items = due.slice(0, limR).map(function (x) { return { id: x.id, kind: 'review' }; })
      .concat(fresh.slice(0, limN).map(function (id) { return { id: id, kind: 'new' }; }));
    return { items: items, dueTotal: due.length, newTotal: fresh.length };
  }

  function startSession(extra) {
    var q = buildQueue(extra || 0);
    session.items = q.items;
    session.idx = 0;
    session.newCount = 0;
    session.okCount = 0;
    session.total = q.items.length;

    if (!q.items.length) {
      $('#flashcard').classList.add('gone');
      $('#controls').classList.add('hidden');
      $('#rateBar').classList.add('hidden');
      $('#summary').classList.add('hidden');
      $('#learnEmpty').classList.remove('hidden');
      $('#emptyTitle').textContent = q.dueTotal || q.newTotal ? '今天的配额用完了' : '今天的任务完成了';
      $('#emptyText').textContent = '待复习 ' + q.dueTotal + ' 个，未学习 ' + q.newTotal + ' 个。可以去词库预习，或临时加练。';
      $('#learnBar').style.width = '100%';
      $('#learnCounter').textContent = '0 / 0';
      $('#learnChips').innerHTML = '';
      return;
    }

    $('#learnEmpty').classList.add('hidden');
    $('#summary').classList.add('hidden');
    $('#flashcard').classList.remove('gone');
    $('#controls').classList.remove('hidden');
    $('#rateBar').classList.remove('hidden');
    renderCard();
  }

  function renderCard() {
    var i = session.idx;
    if (i >= session.items.length) { showSummary(); return; }

    var item = session.items[i], t = byId[item.id], c = Store.raw(item.id);
    var card = $('#flashcard');
    card.classList.remove('flipped');

    $('#fCat').textContent = t.c;
    $('#fLv').textContent = levelText(t.lv);
    $('#fTerm').textContent = t.t;
    $('#fEn').textContent = t.en || '';
    $('#fJa').textContent = t.ja || '';

    $('#bTerm').textContent = t.t + (t.en ? '　' + t.en : '');
    $('#bJa').textContent = t.ja || '';
    $('#bDef').textContent = t.d || '';
    $('#bPoints').innerHTML = (t.p || []).map(function (p) { return '<li>' + p + '</li>'; }).join('');
    $('#bEg').textContent = t.e || '—';
    $('#bRel').innerHTML = (t.r || []).map(function (r) {
      return byId[r] ? '<span class="tag" data-goto="' + r + '">' + r + '</span>' : '';
    }).join('');

    $('#rateBar').classList.add('disabled');
    var pct = Math.round(i / session.total * 100);
    $('#learnBar').style.width = pct + '%';
    $('#learnCounter').textContent = i + ' / ' + session.total;

    var st = statusLabel(item.id);
    $('#learnChips').innerHTML =
      '<span class="chip on">' + (item.kind === 'new' ? '新学' : '复习') + '</span>' +
      '<span class="chip">' + st.text + '</span>' +
      '<span class="chip">' + (c ? SRS.dueText(c) : '未学习') + '</span>';

    if (Store.data.settings.autoSpeak) speak(t.t);
    updateSide();
  }

  function flip(e) {
    if (Date.now() < guardUntil) return;                 // 滑动手势后的合成点击不翻卡
    if (e && e.target.closest && e.target.closest('[data-goto]')) return; // 点相关术语不翻卡
    var card = $('#flashcard');
    if (card.classList.contains('gone')) return;
    card.classList.toggle('flipped');
    var flipped = card.classList.contains('flipped');
    $('#rateBar').classList.toggle('disabled', !flipped);
    buzz(8);
    if (window.Sfx) Sfx.flip();
    if (flipped && !Store.data.settings.autoSpeak) { /* 翻到背面不自动朗读，避免打断阅读 */ }
  }

  function rate(r) {
    if ($('#rateBar').classList.contains('disabled')) return;
    var item = session.items[session.idx];
    if (!item) return;
    buzz(r === 2 ? 18 : 30);
    if (window.Sfx) { if (r === 2) Sfx.correct(); else if (r === 1) Sfx.fuzzy(); else Sfx.wrong(); }
    var c = Store.card(item.id);
    SRS.schedule(c, r);
    Store.record(item.kind, r === 2);
    if (r === 2) session.okCount++;
    if (item.kind === 'new') session.newCount++;
    session.idx++;
    renderCard();
  }

  function showSummary() {
    $('#flashcard').classList.add('gone');
    $('#controls').classList.add('hidden');
    $('#rateBar').classList.add('hidden');
    $('#summary').classList.remove('hidden');
    var total = session.total;
    $('#sumTotal').textContent = total;
    $('#sumNew').textContent = session.newCount;
    $('#sumOk').textContent = session.okCount;
    $('#sumAcc').textContent = total ? Math.round(session.okCount / total * 100) + '%' : '0%';
    $('#learnBar').style.width = '100%';
    $('#learnCounter').textContent = total + ' / ' + total;
    updateSide();
  }

  function updateSide() {
    var d = Store.dailyCounts();
    var n = $('#sideNew'), r = $('#sideRev'), k = $('#sideStreak');
    if (n) n.textContent = d.n;
    if (r) r.textContent = d.r;
    if (k) k.textContent = d.streak;
  }

  /* ---------------- 账号与同步 ---------------- */
  var STATUS_TEXT = { off: '未同步', ready: '已连接', syncing: '同步中', error: '异常' };
  var lastDataRef = null;

  /** 从 url 里取出 Supabase 项目 ref（如 jyytfphsldxmmxqltqvp），用于一眼区分环境 */
  function projectTag() {
    var cfg = Sync.config();
    if (!cfg || !cfg.url) return '未配置项目';
    var m = /https?:\/\/([a-z0-9]+)\.supabase\./i.exec(cfg.url);
    return m ? m[1] : cfg.url;
  }

  /**
   * 环境标识：开发构建在最顶部显示一条醒目的黄条，生产构建则完全不渲染。
   * 这样终端用户看不到任何内部信息，而你一眼就能确认自己在哪个环境。
   * 另支持 ?env 参数在生产站点上临时自查（带项目 ref 与表名）。
   */
  function renderEnvBadge() {
    var el = $('#envBadge');
    if (!el) return;
    var isDev = Sync.envName() !== 'prod';
    var force = envForced();

    if (!isDev && !force) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    if (isDev) {
      el.classList.remove('is-prod');
      el.innerHTML = '⚠ <b>开发环境</b> · 数据存于开发库，与生产互不相通';
    } else {
      el.classList.add('is-prod');
      el.innerHTML = '生产环境 · ' + escapeHtml(projectTag()) + ' · 表 ' + escapeHtml(Sync.tableName());
    }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderAccount() {
    var s = Sync.state();
    var logged = !!s.email;
    $('#acctNoCfg').classList.toggle('hidden', Sync.hasConfig());
    $('#acctAuth').classList.toggle('hidden', logged);
    $('#acctUser').classList.toggle('hidden', !logged);
    // 未登录时清掉上一次留下的提示，避免退出登录后还挂着旧文案
    if (!logged) authFeedback('');
    if (logged) {
      $('#acctEmailShow').textContent = Sync.displayId(s.email);
      $('#acctStatus').textContent = STATUS_TEXT[s.status] || s.status;
      // 项目 ref / 表名属于部署内部信息，不对终端用户暴露；排查时看控制台即可
      var info = s.message || '';
      if (s.lastSync) info += (info ? ' · ' : '') + '上次同步 ' + new Date(s.lastSync).toLocaleTimeString();
      console.info('[环境] 项目 ' + projectTag() + ' · 表 ' + Sync.tableName() + ' · ' + (Sync.state().email || '未登录'));
      $('#acctSyncInfo').textContent = info;
      renderEnvBadge();
    }
    updateSide();
  }

  function afterCloudChange() {
    applyGate();
    // 云端数据替换了本地对象时才重绘，避免每次同步消息都刷新界面
    if (Store.data !== lastDataRef) {
      lastDataRef = Store.data;
      applySettings();
      ensureTerms().then(function () { startSession(); renderLibrary(); renderStats(); });
    }
    if ($('#view-account').classList.contains('active')) renderAccount();
  }

  /* ---------------- 词库 ---------------- */
  var libState = { q: '', cat: 'all', status: 'all' };

  function renderLibrary() {
    var chips = '<button class="chip' + (libState.cat === 'all' ? ' on' : '') + '" data-cat="all">全部</button>';
    CATS.forEach(function (c) {
      chips += '<button class="chip' + (libState.cat === c ? ' on' : '') + '" data-cat="' + c + '">' + c + '</button>';
    });
    $('#libCats').innerHTML = chips;

    var q = libState.q.trim().toLowerCase();
    var list = TERMS.filter(function (t) {
      if (libState.cat !== 'all' && t.c !== libState.cat) return false;
      if (libState.status !== 'all' && SRS.statusOf(Store.raw(t.id)) !== libState.status) return false;
      if (!q) return true;
      var hay = (t.t + ' ' + (t.en || '') + ' ' + (t.ja || '') + ' ' + (t.d || '')).toLowerCase();
      return hay.indexOf(q) >= 0;
    });

    $('#libList').innerHTML = list.map(function (t) {
      var st = statusLabel(t.id);
      return '<div class="lib-item" data-open="' + t.id + '">' +
        '<div class="lib-top"><div><div class="lib-term">' + t.t + '</div>' +
        '<div class="lib-en">' + (t.en || '') + (t.ja ? '　·　' + t.ja : '') + '</div></div>' +
        '<span class="badge ' + st.cls + '">' + st.text + '</span></div>' +
        '<div class="lib-def">' + (t.d || '') + '</div></div>';
    }).join('') || '<p class="muted">没有匹配的术语</p>';
  }

  function openDetail(id) {
    var t = byId[id];
    if (!t) return;
    var c = Store.raw(id);
    var st = statusLabel(id);
    $('#modalBody').innerHTML =
      '<h3>' + t.t + '</h3>' +
      '<p class="sub">' + (t.en || '') + '　·　' + (t.ja || '') + '　·　' + t.c + '　·　' + levelText(t.lv) + '</p>' +
      '<div class="sec"><h4>定义</h4><p class="muted" style="font-size:14px;line-height:1.8">' + (t.d || '') + '</p></div>' +
      '<div class="sec"><h4>要点</h4><ul class="fc-points" style="color:var(--text)">' +
      (t.p || []).map(function (p) { return '<li>' + p + '</li>'; }).join('') + '</ul></div>' +
      '<div class="sec"><h4>典型场景</h4><p class="muted" style="font-size:14px;line-height:1.8">' + (t.e || '—') + '</p></div>' +
      '<div class="sec"><h4>相关术语</h4><div>' +
      (t.r || []).map(function (r) { return byId[r] ? '<span class="tag" data-goto="' + r + '" style="cursor:pointer">' + r + '</span>' : ''; }).join(' ') +
      '</div></div>' +
      '<div class="sec"><h4>学习状态</h4><p class="muted">' + st.text + '　·　' + (c ? SRS.dueText(c) : '未学习') +
      '　·　复习 ' + (c ? c.reps : 0) + ' 次，遗忘 ' + (c ? c.lapses : 0) + ' 次</p></div>';
    $('#modal').classList.remove('hidden');
  }

  /* ---------------- 测试 ---------------- */
  var quiz = { list: [], i: 0, right: 0, wrong: [] };

  function startQuiz(n) {
    var pool = TERMS.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    quiz.list = pool.slice(0, Math.min(n, pool.length)).map(function (t) {
      return { id: t.id, type: Math.random() < 0.5 ? 0 : 1 };
    });
    quiz.i = 0; quiz.right = 0; quiz.wrong = [];

    $('#quizStart').classList.add('hidden');
    $('#quizResult').classList.add('hidden');
    $('#quizPlay').classList.remove('hidden');
    renderQuestion();
  }

  function pickOptions(t, type) {
    var others = TERMS.filter(function (x) { return x.id !== t.id; });
    var same = others.filter(function (x) { return x.c === t.c; });
    var src = same.length >= 3 ? same : others;
    var picked = [], used = {};
    while (picked.length < 3 && picked.length < src.length) {
      var k = Math.floor(Math.random() * src.length);
      if (used[k]) continue;
      used[k] = 1;
      picked.push(src[k]);
    }
    var opts = picked.map(function (x) { return { id: x.id, text: type === 0 ? (x.d || '') : x.t }; });
    opts.push({ id: t.id, text: type === 0 ? (t.d || '') : t.t });
    for (var i = opts.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = opts[i]; opts[i] = opts[j]; opts[j] = tmp;
    }
    return opts;
  }

  function clip(s, n) { return s && s.length > n ? s.slice(0, n) + '…' : s; }

  function renderQuestion() {
    if (quiz.i >= quiz.list.length) { showQuizResult(); return; }
    var q = quiz.list[quiz.i], t = byId[q.id];
    $('#quizBar').style.width = Math.round(quiz.i / quiz.list.length * 100) + '%';
    $('#quizCounter').textContent = quiz.i + ' / ' + quiz.list.length;
    $('#quizQ').textContent = q.type === 0 ? t.t : (t.d || '');
    $('#quizTip').textContent = (t.ja ? t.ja + '　·　' : '') + (q.type === 0 ? '选出正确的释义' : '选出对应的术语');
    $('#quizFeedback').classList.add('hidden');
    $('#btnQuizNext').classList.add('hidden');

    $('#quizOptions').innerHTML = pickOptions(t, q.type).map(function (o, i) {
      return '<button class="opt" data-opt="' + i + '" data-id="' + o.id + '">' + clip(o.text, 90) + '</button>';
    }).join('');
  }

  function answer(btn) {
    var q = quiz.list[quiz.i], t = byId[q.id];
    var ok = btn.getAttribute('data-id') === q.id;
    if (window.Sfx) { if (ok) Sfx.correct(); else Sfx.wrong(); }
    var btns = document.querySelectorAll('#quizOptions .opt');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = true;
      if (btns[i].getAttribute('data-id') === q.id) btns[i].classList.add('right');
    }
    if (!ok) { btn.classList.add('wrong'); quiz.wrong.push(q.id); Store.card(q.id).wrong++; Store.touch(); } else { quiz.right++; }

    $('#quizFeedback').classList.remove('hidden');
    $('#quizFeedback').innerHTML = (ok ? '<b style="color:var(--good)">回答正确</b>' : '<b style="color:var(--bad)">回答错误</b>') +
      '<br>' + t.t + (t.ja ? '　' + t.ja : '') + '：' + (t.d || '');
    $('#btnQuizNext').classList.remove('hidden');
  }

  function showQuizResult() {
    $('#quizPlay').classList.add('hidden');
    $('#quizResult').classList.remove('hidden');
    var total = quiz.list.length;
    $('#qTotal').textContent = total;
    $('#qRight').textContent = quiz.right;
    $('#qAcc').textContent = total ? Math.round(quiz.right / total * 100) + '%' : '0%';
    $('#qWrong').textContent = quiz.wrong.length;
    $('#quizScore').textContent = quiz.right === total ? '全部正确，很稳' : '测试完成';
    updateSide();
  }

  /* ---------------- 统计 ---------------- */
  function countStatus() {
    var r = { total: TERMS.length, learned: 0, mastered: 0, due: 0, new: 0 };
    var now = Date.now();
    TERMS.forEach(function (t) {
      var c = Store.raw(t.id), s = SRS.statusOf(c);
      if (s === 'new') r.new++;
      else {
        r.learned++;
        if (s === 'mastered') r.mastered++;
        if ((c.due || 0) <= now) r.due++;
      }
    });
    return r;
  }

  function renderStats() {
    var r = countStatus();
    $('#stTotal').textContent = r.total;
    $('#stLearned').textContent = r.learned;
    $('#stMastered').textContent = r.mastered;
    $('#stDue').textContent = r.due;

    var pct = r.total ? r.mastered / r.total : 0;
    var C = 2 * Math.PI * 52;
    $('#donutFg').style.strokeDasharray = C;
    $('#donutFg').style.strokeDashoffset = C * (1 - pct);
    $('#donutPct').textContent = Math.round(pct * 100) + '%';
    $('#legend').innerHTML =
      '<span><i style="background:var(--good)"></i>已掌握 ' + r.mastered + '</span>' +
      '<span><i style="background:var(--warn)"></i>学习中 ' + (r.learned - r.mastered) + '</span>' +
      '<span><i style="background:var(--line)"></i>未学习 ' + r.new + '</span>';

    var days = Store.last7(), max = Math.max(1, Math.max.apply(null, days.map(function (d) { return d.total; })));
    $('#bars').innerHTML = days.map(function (d) {
      var h = Math.round(d.total / max * 130);
      return '<div class="bar-col"><div class="col" style="height:' + h + 'px" title="' + d.total + '"></div><span>' + d.label + '</span></div>';
    }).join('');

    $('#catProgress').innerHTML = CATS.map(function (cat) {
      var all = TERMS.filter(function (t) { return t.c === cat; });
      var m = all.filter(function (t) { return SRS.statusOf(Store.raw(t.id)) === 'mastered'; }).length;
      var p = all.length ? Math.round(m / all.length * 100) : 0;
      return '<div class="cat-row"><span>' + cat + '</span>' +
        '<div class="bar"><i style="width:' + p + '%"></i></div>' +
        '<b>' + m + '/' + all.length + '</b></div>';
    }).join('');

    var hard = TERMS.filter(function (t) {
      var c = Store.raw(t.id);
      return c && (c.lapses > 0 || c.wrong > 0);
    }).sort(function (a, b) {
      return (Store.raw(b.id).lapses + Store.raw(b.id).wrong) - (Store.raw(a.id).lapses + Store.raw(a.id).wrong);
    });
    $('#hardList').innerHTML = hard.length ? hard.map(function (t) {
      var c = Store.raw(t.id);
      return '<div class="lib-item" data-open="' + t.id + '"><div class="lib-top"><div class="lib-term">' + t.t + '</div>' +
        '<span class="badge learning">遗忘 ' + c.lapses + ' · 错 ' + c.wrong + '</span></div>' +
        '<div class="lib-def">' + (t.d || '') + '</div></div>';
    }).join('') : '<p class="muted">还没有难词，保持住</p>';
  }

  /* ---------------- 历年真题（软考架构师·综合知识） ---------------- */
  var EXAM_ALL = (window.EXAM_QUESTIONS || []).slice();
  // 真题错题本 / 完成题数：现挂在 Store.data.exam 下，随云端一起同步
  // （旧版本存在独立键 arch-term-exam-v1，已由 Store 的 migrateLegacy 自动迁入）
  var examStore = {
    data: function () { return Store.data.exam; },
    save: function () { Store.touch(); },
    wrongCount: function () { return Object.keys(Store.data.exam.wrong).length; },
    markWrong: function (id) {
      Store.data.exam.wrong[id] = (Store.data.exam.wrong[id] || 0) + 1;
      Store.touch();
    },
    clearWrong: function (id) {
      if (Store.data.exam.wrong[id]) { delete Store.data.exam.wrong[id]; Store.touch(); }
    },
    bumpDone: function () { Store.data.exam.totalDone++; Store.touch(); }
  };

  // 案例 / 论文 的「待巩固」错题（选择题错题由 examStore 管理）
  var wrongExtra = (function () {
    function d() { return Store.data.wrongExtra; }
    return {
      has: function (t, id) { return !!d()[t][id]; },
      toggle: function (t, id) { var o = d()[t]; if (o[id]) delete o[id]; else o[id] = 1; Store.touch(); },
      count: function (t) { return Object.keys(d()[t]).length; },
      ids: function (t) { return Object.keys(d()[t]); },
      clear: function (t) { d()[t] = {}; Store.touch(); }
    };
  })();

  var exam = { pool: [], i: 0, right: 0, wrong: [], filter: 'all', mode: 'random' };

  function examSessions() {
    var seen = [], list = [];
    EXAM_ALL.forEach(function (q) {
      var k = q.y + q.s;
      if (seen.indexOf(k) < 0) { seen.push(k); list.push({ key: k, y: q.y, s: q.s }); }
    });
    list.sort(function (a, b) { return b.y - a.y || (b.s === '下半年' ? 1 : 0) - (a.s === '下半年' ? 1 : 0); });
    return list;
  }

  function renderExamStart() {
    var total = EXAM_ALL.length;
    $('#examTotal').textContent = total;
    var sessions = examSessions();
    var chips = '<button class="chip' + (exam.filter === 'all' ? ' on' : '') + '" data-ef="all">全部 ' + total + ' 题</button>';
    sessions.forEach(function (s) {
      var n = EXAM_ALL.filter(function (q) { return q.y + q.s === s.key; }).length;
      chips += '<button class="chip' + (exam.filter === s.key ? ' on' : '') + '" data-ef="' + s.key + '">' + s.y + ' ' + s.s + ' · ' + n + '</button>';
    });
    $('#examYears').innerHTML = chips;
    var wc = examStore.wrongCount();
    var wb = $('#btnExamWrong');
    wb.textContent = wc > 0 ? '错题重练（' + wc + '）' : '错题重练（暂无错题）';
    wb.disabled = wc === 0;
    wb.style.opacity = wc === 0 ? '.5' : '1';
  }

  function startExam(withIds) {
    var pool;
    if (withIds) {
      pool = EXAM_ALL.filter(function (q) { return examStore.data().wrong[q.id]; });
    } else {
      pool = exam.filter === 'all' ? EXAM_ALL.slice()
        : EXAM_ALL.filter(function (q) { return q.y + q.s === exam.filter; });
      var limit = +$('#examCount').value;
      if (pool.length > limit) {
        // 随机抽 limit 题
        for (var i = pool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var t = pool[i]; pool[i] = pool[j]; pool[j] = t;
        }
        pool = pool.slice(0, limit);
      }
    }
    if (!pool.length) { toast('没有可练习的题目'); return; }
    exam.pool = pool;
    exam.i = 0; exam.right = 0; exam.wrong = [];
    $('#examStart').classList.add('hidden');
    $('#examResult').classList.add('hidden');
    $('#examPlay').classList.remove('hidden');
    renderExamQ();
  }

  function renderExamQ() {
    if (exam.i >= exam.pool.length) { showExamResult(); return; }
    var q = exam.pool[exam.i];
    $('#examBar').style.width = Math.round(exam.i / exam.pool.length * 100) + '%';
    $('#examCounter').textContent = exam.i + ' / ' + exam.pool.length;
    $('#examMeta').innerHTML =
      '<span class="tag">' + q.y + ' ' + q.s + '</span>' +
      '<span class="tag lv">第 ' + q.no + ' 题</span>' +
      (q.e ? '<span class="tag">含解析</span>' : '');
    $('#examQ').textContent = q.q;
    $('#examOptions').innerHTML = q.o.map(function (o, i) {
      return '<button class="opt" data-exam-opt="' + i + '"><b>' + 'ABCD'[i] + '.</b> ' + o.replace(/</g, '&lt;') + '</button>';
    }).join('');
    $('#examFeedback').classList.add('hidden');
    $('#examFeedback').innerHTML = '';
    $('#btnExamNext').classList.add('hidden');
  }

  function answerExam(btn) {
    var q = exam.pool[exam.i];
    var pick = +btn.getAttribute('data-exam-opt');
    var ok = pick === q.a;
    buzz(ok ? 15 : 30);
    if (window.Sfx) { if (ok) Sfx.correct(); else Sfx.wrong(); }
    var btns = document.querySelectorAll('#examOptions .opt');
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = true;
      if (i === q.a) btns[i].classList.add('right');
    }
    if (!ok) {
      btn.classList.add('wrong');
      exam.wrong.push(q.id);
      examStore.markWrong(q.id);
    } else {
      exam.right++;
      examStore.clearWrong(q.id);
    }
    examStore.bumpDone();

    var fb = (ok ? '<b style="color:var(--good)">回答正确</b>' : '<b style="color:var(--bad)">回答错误</b>') +
      '　正确答案 <span class="exam-ans">' + 'ABCD'[q.a] + '</span>';
    if (q.e) fb += '<div class="quiz-exp">' + q.e.replace(/</g, '&lt;') + '</div>';
    $('#examFeedback').innerHTML = fb;
    $('#examFeedback').classList.remove('hidden');
    $('#btnExamNext').classList.remove('hidden');
    $('#btnExamNext').textContent = exam.i + 1 >= exam.pool.length ? '查看结果' : '下一题';
  }

  function showExamResult() {
    $('#examPlay').classList.add('hidden');
    $('#examResult').classList.remove('hidden');
    var total = exam.pool.length;
    $('#eTotal').textContent = total;
    $('#eRight').textContent = exam.right;
    $('#eAcc').textContent = total ? Math.round(exam.right / total * 100) + '%' : '0%';
    $('#eWrong').textContent = exam.wrong.length;
    $('#examScore').textContent = exam.right === total ? '全部正确，很稳' : '本次练习完成';
    var rb = $('#btnExamReview');
    rb.disabled = exam.wrong.length === 0;
    rb.style.opacity = rb.disabled ? '.5' : '1';
  }

  function reviewWrong() {
    if (!exam.wrong.length) return;
    var html = '<h3>本次错题</h3>';
    exam.wrong.forEach(function (id, idx) {
      var q = null;
      for (var i = 0; i < EXAM_ALL.length; i++) if (EXAM_ALL[i].id === id) { q = EXAM_ALL[i]; break; }
      if (!q) return;
      html += '<div class="sec"><h4>' + (idx + 1) + '. ' + q.y + ' ' + q.s + ' 第' + q.no + '题</h4>' +
        '<p class="muted" style="font-size:14px;line-height:1.8">' + q.q.replace(/</g, '&lt;') + '</p>' +
        '<p class="muted" style="font-size:13.5px;line-height:1.8">' +
        q.o.map(function (o, i) { return 'ABCD'[i] + '. ' + o.replace(/</g, '&lt;'); }).join('<br>') + '</p>' +
        '<p style="font-size:14px">正确答案：<span class="exam-ans">' + 'ABCD'[q.a] + '</span></p>' +
        (q.e ? '<div class="quiz-exp">' + q.e.replace(/</g, '&lt;') + '</div>' : '') + '</div>';
    });
    $('#modalBody').innerHTML = html;
    $('#modal').classList.remove('hidden');
  }

  /* ---------------- 设置 / BGM ---------------- */
  function updateBgmBtn() {
    var b = $('#btnBgm');
    if (!b) return;
    var on = !!(window.Bgm && Bgm.isOn());
    b.textContent = on ? '♪ BGM 开' : '♪ BGM';
    b.classList.toggle('primary', on);
    b.classList.toggle('ghost', !on);
  }

  function setBgm(on, tip) {
    var s = Store.data.settings;
    s.bgm = !!on;
    Store.touch();
    if (window.Bgm) {
      if (s.bgm) { Bgm.setVolume((s.bgmVol || 35) / 100); Bgm.start(); }
      else Bgm.stop();
    }
    updateBgmBtn();
    if (tip) toast(s.bgm ? 'BGM 已开启' : 'BGM 已关闭');
  }

  function applySettings() {
    var s = Store.data.settings;
    $('#setNew').value = s.dailyNew;
    $('#setRev').value = s.dailyReview;
    $('#setSpeak').checked = !!s.autoSpeak;
    $('#setBgm').checked = !!s.bgm;
    $('#setBgmVol').value = s.bgmVol || 35;
    $('#setSfx').checked = s.sfx !== false;
    $('#setSfxVol').value = s.sfxVol || 60;
    if (window.Bgm) Bgm.setVolume((s.bgmVol || 35) / 100);
    if (window.Sfx) { Sfx.setEnabled(s.sfx !== false); Sfx.setVolume((s.sfxVol || 60) / 100); }
    document.documentElement.setAttribute('data-theme', s.theme);
    $('#themeBtn').textContent = s.theme === 'dark' ? '☾' : '☀';
    updateBgmBtn();
  }

  /* ---------------- 事件绑定 ---------------- */
  bind('#nav', 'click', function (e) {
    var btn = e.target.closest('.tab-item');
    if (btn) { buzz(6); if (window.Sfx) Sfx.click(); switchView(btn.getAttribute('data-view')); }
  });

  document.addEventListener('click', function (e) {
    var jump = e.target.closest('[data-view]');
    if (jump && !jump.classList.contains('tab-item')) { if (window.Sfx) Sfx.click(); switchView(jump.getAttribute('data-view')); }
  });

  bind('#flashcard', 'click', flip);

  /* ---- 触屏手势：未翻面横滑=翻卡；翻面后 右滑=认识 左滑=不认识 上滑=模糊 ---- */
  (function () {
    var card = $('#flashcard');
    var sx = 0, sy = 0, st = 0, scrolled = false;

    card.addEventListener('touchstart', function (e) {
      if (card.classList.contains('gone')) return;
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      st = Date.now();
      scrolled = false;
    }, { passive: true });

    card.addEventListener('touchmove', function () {
      // 背面内容被滚动过就视为「阅读中」，本次触摸不触发评分手势
      var face = card.querySelector('.fc-back');
      if (face && face.scrollTop > 2) scrolled = true;
    }, { passive: true });

    card.addEventListener('touchend', function (e) {
      if (card.classList.contains('gone') || scrolled) return;
      var dx = e.changedTouches[0].clientX - sx;
      var dy = e.changedTouches[0].clientY - sy;
      var adx = Math.abs(dx), ady = Math.abs(dy);
      var quick = Date.now() - st < 800;
      var flipped = card.classList.contains('flipped');

      if (adx > 60 && adx > ady * 1.4 && quick) {
        guardUntil = Date.now() + 600;
        if (!flipped) { flip(); return; }        // 未翻面：横滑先翻卡
        if (dx < 0) rate(0); else rate(2);       // 左滑不认识 / 右滑认识
        return;
      }
      if (flipped && dy < -70 && ady > adx * 1.6 && quick) {
        guardUntil = Date.now() + 600;
        rate(1);                                  // 上滑模糊
      }
    });
  })();

  bind('#btnFlip', 'click', flip);
  bind('#btnSpeak', 'click', function () {
    var item = session.items[session.idx];
    if (item) speak(byId[item.id].t);
  });
  bind('#rateBar', 'click', function (e) {
    var b = e.target.closest('[data-r]');
    if (b) rate(+b.getAttribute('data-r'));
  });
  bind('#btnMore', 'click', function () { startSession(); });
  bind('#btnExtra', 'click', function () { startSession(10); });

  bind('#libSearch', 'input', function (e) { libState.q = e.target.value; renderLibrary(); });
  bind('#libStatus', 'change', function (e) { libState.status = e.target.value; renderLibrary(); });
  bind('#libCats', 'click', function (e) {
    var c = e.target.closest('[data-cat]');
    if (!c) return;
    libState.cat = c.getAttribute('data-cat');
    renderLibrary();
  });
  bind('#libList', 'click', function (e) {
    var it = e.target.closest('[data-open]');
    if (it) openDetail(it.getAttribute('data-open'));
  });
  bind('#hardList', 'click', function (e) {
    var it = e.target.closest('[data-open]');
    if (it) openDetail(it.getAttribute('data-open'));
  });

  function showQuizPanel(seg) {
    $('#mockEntry').classList.add('hidden'); // 进入任一练习子模块时隐藏顶部"全真模拟考试"入口
    var panels = { term: '#quizTerm', exam: '#quizExam', case: '#quizCase', essay: '#quizEssay' };
    Object.keys(panels).forEach(function (k) { $(panels[k]).classList.toggle('hidden', k !== seg); });
    var items = document.querySelectorAll('#quizSeg .seg-item');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('active', items[i].getAttribute('data-seg') === seg);
  }
  function reviewWrongSubject(t) {
    switchView('quiz');
    if (t === 'exam') {
      ensureExam().then(function () { showQuizPanel('exam'); startExam(true); });
    } else if (t === 'case') {
      ensureCase().then(function () { showQuizPanel('case'); caseState.filter = '__wrong'; renderCaseStart(); startCase(); });
    } else if (t === 'essay') {
      ensureEssay().then(function () { showQuizPanel('essay'); renderEssayTpl(); renderEssayList(); });
    }
  }
  bind('#wrongList', 'click', function (e) {
    var row = e.target.closest('[data-wrong]'); if (!row) return;
    var btn = e.target.closest('.btn'); if (!btn || btn.disabled) return;
    reviewWrongSubject(row.getAttribute('data-wrong'));
  });

  document.addEventListener('click', function (e) {
    var g = e.target.closest('[data-goto]');
    if (g) openDetail(g.getAttribute('data-goto'));
  });
  bind('#modalClose', 'click', function () { $('#modal').classList.add('hidden'); });
  bind('#modal', 'click', function (e) { if (e.target === $('#modal')) $('#modal').classList.add('hidden'); });

  bind('#btnQuizStart', 'click', function () { startQuiz(+$('#quizCount').value); });
  bind('#quizOptions', 'click', function (e) {
    var b = e.target.closest('.opt');
    if (b && !b.disabled) answer(b);
  });
  bind('#btnQuizNext', 'click', function () { quiz.i++; renderQuestion(); });
  bind('#btnQuizAgain', 'click', function () { startQuiz(+$('#quizCount').value); });

  /* 真题模块（术语自测 / 选择题 / 案例 / 论文） */
  bind('#quizSeg', 'click', function (e) {
    var b = e.target.closest('.seg-item');
    if (!b) return;
    buzz(6);
    if (window.Sfx) Sfx.click();
    var seg = b.getAttribute('data-seg');
    var items = document.querySelectorAll('#quizSeg .seg-item');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('active', items[i] === b);
    var panels = { term: '#quizTerm', exam: '#quizExam', case: '#quizCase', essay: '#quizEssay' };
    Object.keys(panels).forEach(function (k) { $(panels[k]).classList.toggle('hidden', k !== seg); });
    // 切换分段时把其余分段重置回起始页，避免进度残留
    if (seg !== 'term') { $('#quizPlay').classList.add('hidden'); $('#quizResult').classList.add('hidden'); $('#quizStart').classList.remove('hidden'); }
    if (seg !== 'exam') { $('#examPlay').classList.add('hidden'); $('#examResult').classList.add('hidden'); $('#examStart').classList.remove('hidden'); }
    if (seg !== 'case') { $('#casePlay').classList.add('hidden'); $('#caseStart').classList.remove('hidden'); }
    if (seg === 'exam') ensureExam().then(renderExamStart);
    if (seg === 'case') ensureCase().then(renderCaseStart);
    if (seg === 'essay') ensureEssay().then(function () { renderEssayTpl(); renderEssayList(); });
    if (seg === 'term') ensureTerms();
  });
  bind('#examYears', 'click', function (e) {
    var c = e.target.closest('[data-ef]');
    if (!c) return;
    exam.filter = c.getAttribute('data-ef');
    renderExamStart();
  });
  bind('#btnExamStart', 'click', function () { startExam(false); });
  bind('#btnExamWrong', 'click', function () { startExam(true); });
  bind('#examOptions', 'click', function (e) {
    var b = e.target.closest('.opt');
    if (b && !b.disabled) answerExam(b);
  });
  bind('#btnExamNext', 'click', function () { exam.i++; renderExamQ(); });
  bind('#btnExamAgain', 'click', function () {
    $('#examResult').classList.add('hidden');
    $('#examStart').classList.remove('hidden');
    renderExamStart();
  });
  bind('#btnExamReview', 'click', reviewWrong);

  /* 中途退出（术语自测 / 历年真题） */
  bind('#btnQuizExit', 'click', function () {
    if (window.Sfx) Sfx.click();
    $('#quizPlay').classList.add('hidden');
    $('#quizResult').classList.add('hidden');
    $('#quizStart').classList.remove('hidden');
  });
  bind('#btnExamExit', 'click', function () {
    if (window.Sfx) Sfx.click();
    $('#examPlay').classList.add('hidden');
    $('#examResult').classList.add('hidden');
    $('#examStart').classList.remove('hidden');
    renderExamStart();
  });

  /* ================= 案例题（下午一） ================= */
  var CASE_ALL = (window.EXAM_CASES || []).slice();
  var caseState = { pool: [], i: 0, filter: 'all' };

  function caseSessions() {
    var seen = [], list = [];
    CASE_ALL.forEach(function (c) { var k = c.y + c.s; if (seen.indexOf(k) < 0) { seen.push(k); list.push({ key: k, y: c.y, s: c.s }); } });
    list.sort(function (a, b) { return b.y - a.y || (b.s === '下半年' ? 1 : 0) - (a.s === '下半年' ? 1 : 0); });
    return list;
  }
  function renderCaseStart() {
    $('#caseTotal').textContent = CASE_ALL.length;
    var f = caseState.filter;
    var chips = '<button class="chip' + (f === 'all' ? ' on' : '') + '" data-cf="all">全部 ' + CASE_ALL.length + ' 套</button>';
    caseSessions().forEach(function (s) {
      var n = CASE_ALL.filter(function (c) { return c.y + c.s === s.key; }).length;
      chips += '<button class="chip' + (f === s.key ? ' on' : '') + '" data-cf="' + s.key + '">' + s.y + ' ' + s.s + ' · ' + n + '</button>';
    });
    var wc = wrongExtra.count('case');
    if (wc > 0) chips += '<button class="chip' + (f === '__wrong' ? ' on' : '') + '" data-cf="__wrong">待巩固 ' + wc + '</button>';
    $('#caseYears').innerHTML = chips;
  }
  function startCase() {
    if (caseState.filter === '__wrong') caseState.pool = CASE_ALL.filter(function (c) { return wrongExtra.has('case', c.id); });
    else if (caseState.filter === 'all') caseState.pool = CASE_ALL.slice();
    else caseState.pool = CASE_ALL.filter(function (c) { return c.y + c.s === caseState.filter; });
    if (!caseState.pool.length) { toast('该场次暂无案例'); return; }
    caseState.i = 0;
    $('#caseStart').classList.add('hidden');
    $('#casePlay').classList.remove('hidden');
    renderCaseQ();
  }
  function renderCaseQ() {
    if (caseState.i >= caseState.pool.length) { showCaseResult(); return; }
    var c = caseState.pool[caseState.i];
    $('#caseBar').style.width = Math.round(caseState.i / caseState.pool.length * 100) + '%';
    $('#caseCounter').textContent = (caseState.i + 1) + ' / ' + caseState.pool.length;
    var meta = '<span class="tag">' + c.y + ' ' + c.s + '</span>'
      + (c.must ? '<span class="tag lv">必答题</span>' : '')
      + (c.src ? '<span class="tag"> ' + c.src + '</span>' : '');
    $('#caseMeta').innerHTML = meta;
    var html = '<div class="case-scene"><b>背景</b>' + (c.scene || '').replace(/</g, '&lt;') + '</div>';
    html += '<h4 class="case-topic">' + c.no + '、' + c.topic + '</h4>';
    (c.questions || []).forEach(function (q, idx) {
      html += '<div class="case-q"><div class="case-qh"><span class="case-no">问题' + (idx + 1) + '</span>'
        + (q.score ? '<span class="case-score">' + q.score + ' 分</span>' : '') + '</div>'
        + '<div class="case-qt">' + (q.q || '').replace(/</g, '&lt;') + '</div>'
        + '<button class="btn ghost case-reveal" data-ci="' + idx + '">显示参考答案</button>'
        + '<div class="case-a hidden" id="caseA' + idx + '">' + (q.a || '').replace(/</g, '&lt;') + '</div></div>';
    });
    html += '<button class="btn ghost case-mark" data-cmark="' + c.id + '">' + (wrongExtra.has('case', c.id) ? '已标记待巩固 ✓' : '标记待巩固') + '</button>';
    html += '<button class="btn primary block" id="btnCaseNext">下一题</button>';
    $('#caseBody').innerHTML = html;
  }
  function showCaseResult() {
    $('#casePlay').classList.add('hidden');
    $('#caseStart').classList.remove('hidden');
    renderCaseStart();
    toast('本套练习完成');
  }
  bind('#caseYears', 'click', function (e) {
    var c = e.target.closest('[data-cf]'); if (!c) return;
    caseState.filter = c.getAttribute('data-cf'); renderCaseStart();
  });
  bind('#btnCaseStart', 'click', startCase);
  bind('#btnCaseExit', 'click', function () {
    if (window.Sfx) Sfx.click();
    $('#casePlay').classList.add('hidden'); $('#caseStart').classList.remove('hidden'); renderCaseStart();
  });
  bind('#caseBody', 'click', function (e) {
    var rev = e.target.closest('.case-reveal');
    if (rev) {
      var a = $('#caseA' + rev.getAttribute('data-ci'));
      if (a) { a.classList.toggle('hidden'); rev.textContent = a.classList.contains('hidden') ? '显示参考答案' : '隐藏参考答案'; }
      return;
    }
    var mk = e.target.closest('.case-mark');
    if (mk) {
      var cid = mk.getAttribute('data-cmark');
      wrongExtra.toggle('case', cid);
      mk.textContent = wrongExtra.has('case', cid) ? '已标记待巩固 ✓' : '标记待巩固';
      toast(wrongExtra.has('case', cid) ? '已加入待巩固' : '已取消标记');
      return;
    }
    if (e.target.closest('#btnCaseNext')) { caseState.i++; renderCaseQ(); }
  });

  /* ================= 论文题（下午二） ================= */
  var ESSAY_ALL = (window.EXAM_ESSAYS || []).slice();
  var essayState = { filter: 'all' };

  function essaySessions() {
    var seen = [], list = [];
    ESSAY_ALL.forEach(function (e) { var k = e.y + e.s; if (seen.indexOf(k) < 0) { seen.push(k); list.push({ key: k, y: e.y, s: e.s }); } });
    list.sort(function (a, b) { return b.y - a.y || (b.s === '下半年' ? 1 : 0) - (a.s === '下半年' ? 1 : 0); });
    return list;
  }
  function renderEssayTpl() {
    var t = window.EXAM_ESSAY_TPL || {};
    $('#essayTpl').innerHTML = '<h3>论文写作通用模板</h3>'
      + '<div class="tpl-row"><b>摘要公式</b><p>' + (t.summary || '') + '</p></div>'
      + '<div class="tpl-row"><b>五段式</b><p>' + (t.structure || '') + '</p></div>'
      + '<div class="tpl-row"><b>万能项目背景</b><p>' + (t.background || '') + '</p></div>';
  }
  function renderEssayList() {
    var f = essayState.filter;
    var list;
    if (f === '__wrong') list = ESSAY_ALL.filter(function (e) { return wrongExtra.has('essay', e.id); });
    else if (f === 'all') list = ESSAY_ALL.slice();
    else list = ESSAY_ALL.filter(function (e) { return e.y + e.s === f; });
    list.sort(function (a, b) { return b.y - a.y || (b.s === '下半年' ? 1 : 0) - (a.s === '下半年' ? 1 : 0) || a.no - b.no; });
    var chips = '<button class="chip' + (f === 'all' ? ' on' : '') + '" data-ef2="all">全部 ' + ESSAY_ALL.length + ' 题</button>';
    essaySessions().forEach(function (s) {
      var n = ESSAY_ALL.filter(function (e) { return e.y + e.s === s.key; }).length;
      chips += '<button class="chip' + (f === s.key ? ' on' : '') + '" data-ef2="' + s.key + '">' + s.y + ' ' + s.s + ' · ' + n + '</button>';
    });
    var we = wrongExtra.count('essay');
    if (we > 0) chips += '<button class="chip' + (f === '__wrong' ? ' on' : '') + '" data-ef2="__wrong">待巩固 ' + we + '</button>';
    $('#essayYears').innerHTML = chips;
    var html = '';
    list.forEach(function (e) {
      html += '<div class="essay-card" data-eid="' + e.id + '">'
        + '<div class="ec-head"><span class="tag">' + e.y + ' ' + e.s + '</span><span class="tag lv">第 ' + e.no + ' 题</span></div>'
        + '<div class="ec-topic">' + e.topic + '</div>'
        + '<div class="ec-tips hidden">' + (e.tips || '').replace(/</g, '&lt;') + '</div>'
        + '<button class="btn ghost ec-toggle">查看写作要点</button>'
        + '<button class="btn ghost ec-mark" data-emark="' + e.id + '">' + (wrongExtra.has('essay', e.id) ? '已标记待巩固 ✓' : '标记待巩固') + '</button></div>';
    });
    $('#essayList').innerHTML = html;
  }
  bind('#essayYears', 'click', function (e) {
    var c = e.target.closest('[data-ef2]'); if (!c) return;
    essayState.filter = c.getAttribute('data-ef2'); renderEssayList();
  });
  bind('#essayList', 'click', function (e) {
    var card = e.target.closest('.essay-card'); if (!card) return;
    var tips = card.querySelector('.ec-tips');
    var btn = card.querySelector('.ec-toggle');
    if (tips) { tips.classList.toggle('hidden'); if (btn) btn.textContent = tips.classList.contains('hidden') ? '查看写作要点' : '隐藏写作要点'; }
    var mk = e.target.closest('.ec-mark');
    if (mk) {
      var eid = mk.getAttribute('data-emark');
      wrongExtra.toggle('essay', eid);
      mk.textContent = wrongExtra.has('essay', eid) ? '已标记待巩固 ✓' : '标记待巩固';
      toast(wrongExtra.has('essay', eid) ? '已加入待巩固' : '已取消标记');
    }
  });

  /* ================= 全真模拟考试 ================= */
  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  var mockState = { timer: null, deadline: 0, onExpire: null, onClick: null };
  function mockStartTimer(mins, label, onExpire) {
    mockState.deadline = Date.now() + mins * 60000; mockState.onExpire = onExpire;
    $('#mockLabel').textContent = label; $('#mockTimer').classList.remove('hidden');
    mockTick(); mockState.timer = setInterval(mockTick, 1000);
  }
  function mockTick() {
    var left = mockState.deadline - Date.now();
    if (left <= 0) { left = 0; clearInterval(mockState.timer); $('#mockClock').textContent = '00:00'; var fn = mockState.onExpire; mockState.onExpire = null; if (fn) fn(); return; }
    var m = Math.floor(left / 60000), s = Math.floor(left % 60000 / 1000);
    $('#mockClock').textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  function mockStopTimer() { clearInterval(mockState.timer); $('#mockTimer').classList.add('hidden'); }
  function mockEnter() {
    $('#mockEntry').classList.add('hidden'); $('#quizSeg').classList.add('hidden');
    $('#quizTerm').classList.add('hidden'); $('#quizExam').classList.add('hidden');
    $('#quizCase').classList.add('hidden'); $('#quizEssay').classList.add('hidden');
    $('#quizMock').classList.remove('hidden');
  }
  function mockExit() {
    mockStopTimer(); mockState.onClick = null;
    $('#quizMock').classList.add('hidden'); $('#quizMock').innerHTML = '';
    $('#mockEntry').classList.remove('hidden'); $('#quizSeg').classList.remove('hidden');
    var items = document.querySelectorAll('#quizSeg .seg-item');
    for (var i = 0; i < items.length; i++) items[i].classList.toggle('active', items[i].getAttribute('data-seg') === 'term');
    $('#quizTerm').classList.remove('hidden');
  }
  bind('#mockEntry', 'click', function (e) {
    var b = e.target.closest('[data-mock]'); if (!b) return;
    if (window.Sfx) Sfx.click();
    var k = b.getAttribute('data-mock');
    if (k === 'exam') startMockExam(); else if (k === 'case') startMockCase(); else if (k === 'essay') startMockEssay();
  });
  bind('#btnMockQuit', 'click', function () { mockExit(); toast('已退出模考'); });
  bind('#btnMockSubmit', 'click', function () { if (mockState.onExpire) { var fn = mockState.onExpire; mockState.onExpire = null; fn(); } });
  bind('#quizMock', 'click', function (e) { if (mockState.onClick) mockState.onClick(e); });

  function startMockExam() {
    ensureExam().then(function () {
      if (!EXAM_ALL.length) { toast('真题数据加载中，请稍候'); return; }
      var pool = shuffle(EXAM_ALL); if (pool.length > 75) pool = pool.slice(0, 75);
      mockEnter();
      var m = { i: 0, right: 0, wrong: [], pool: pool, total: pool.length };
      function render() {
        if (m.i >= m.total) return finish();
        var q = m.pool[m.i];
        $('#quizMock').innerHTML =
          '<div class="progress-line"><div class="bar"><i style="width:' + (m.i / m.total * 100) + '%"></i></div><span class="counter">' + (m.i + 1) + ' / ' + m.total + '</span></div>' +
          '<div class="quiz-q">' + (q.y + ' ' + q.s + ' 第' + q.no + '题 · ' + q.q).replace(/</g, '&lt;') + '</div>' +
          '<div class="quiz-options" id="mOpt"></div>' +
          '<div class="quiz-feedback hidden" id="mFb"></div>' +
          '<button class="btn primary block hidden" id="mNext">下一题</button>';
        $('#mOpt').innerHTML = q.o.map(function (o, i) { return '<button class="opt" data-i="' + i + '">' + 'ABCD'[i] + '. ' + o.replace(/</g, '&lt;') + '</button>'; }).join('');
      }
      function answer(b) {
        var i = +b.getAttribute('data-i'), q = m.pool[m.i], ok = i === q.a;
        b.classList.add(ok ? 'right' : 'wrong');
        var opts = $('#mOpt').querySelectorAll('.opt');
        for (var k = 0; k < opts.length; k++) { opts[k].disabled = true; if (+opts[k].getAttribute('data-i') === q.a) opts[k].classList.add('right'); }
        if (ok) m.right++; else m.wrong.push(q.id);
        var fb = (ok ? '<b style="color:var(--good)">回答正确</b>' : '<b style="color:var(--bad)">回答错误</b>') + '　正确答案 <span class="exam-ans">' + 'ABCD'[q.a] + '</span>';
        if (q.e) fb += '<div class="quiz-exp">' + q.e.replace(/</g, '&lt;') + '</div>';
        $('#mFb').innerHTML = fb; $('#mFb').classList.remove('hidden'); $('#mNext').classList.remove('hidden');
        $('#mNext').textContent = m.i + 1 >= m.total ? '查看成绩' : '下一题';
      }
      function finish() {
        mockState.onClick = null; mockStopTimer();
        var acc = m.total ? Math.round(m.right / m.total * 100) + '%' : '0%';
        $('#quizMock').innerHTML = '<div class="panel"><h3>模考完成 · 综合知识</h3>' +
          '<div class="sum-grid"><div><b>' + m.total + '</b><span>题目</span></div><div><b>' + m.right + '</b><span>答对</span></div><div><b>' + acc + '</b><span>正确率</span></div><div><b>' + m.wrong.length + '</b><span>错题</span></div></div>' +
          '<p class="muted">及格线 45 分（正确率≈60%）。时间到或交卷均按当前进度计分。</p>' +
          '<div class="sum-actions"><button class="btn primary" id="mBack">返回真题</button></div></div>';
        m.wrong.forEach(function (id) { examStore.markWrong(id); });
        bind('#mBack', 'click', mockExit);
      }
      mockState.onClick = function (e) {
        var b = e.target.closest('.opt'); if (b && !b.disabled) { answer(b); return; }
        if (e.target.closest('#mNext')) { m.i++; render(); }
      };
      mockStartTimer(150, '综合知识模考', finish);
      render();
    });
  }

  function startMockCase() {
    ensureCase().then(function () {
      if (!CASE_ALL.length) { toast('案例数据加载中，请稍候'); return; }
      var pool = shuffle(CASE_ALL); if (pool.length > 3) pool = pool.slice(0, 3);
      mockEnter();
      var c = { i: 0, pool: pool, total: pool.length };
      function render() {
        if (c.i >= c.total) return finish();
        var k = c.pool[c.i];
        var html = '<div class="progress-line"><div class="bar"><i style="width:' + (c.i / c.total * 100) + '%"></i></div><span class="counter">案例 ' + (c.i + 1) + ' / ' + c.total + '</span></div>';
        html += '<div class="case-meta">' + k.y + ' ' + k.s + (k.must ? ' · 必答题' : '') + (k.src ? ' · ' + k.src : '') + '</div>';
        html += '<div class="case-scene"><b>背景</b>' + (k.scene || '').replace(/</g, '&lt;') + '</div>';
        html += '<h4 class="case-topic">' + k.no + '、' + k.topic + '</h4>';
        (k.questions || []).forEach(function (q, idx) {
          html += '<div class="case-q"><div class="case-qh"><span class="case-no">问题' + (idx + 1) + '</span>' + (q.score ? '<span class="case-score">' + q.score + ' 分</span>' : '') + '</div>' +
            '<div class="case-qt">' + (q.q || '').replace(/</g, '&lt;') + '</div>' +
            '<button class="btn ghost case-reveal" data-ci="' + idx + '">显示参考答案</button>' +
            '<div class="case-a hidden" id="mCaseA' + idx + '">' + (q.a || '').replace(/</g, '&lt;') + '</div></div>';
        });
        html += '<button class="btn primary block" id="mCaseNext">下一套</button>';
        $('#quizMock').innerHTML = html;
      }
      function finish() {
        mockState.onClick = null; mockStopTimer();
        $('#quizMock').innerHTML = '<div class="panel"><h3>模考完成 · 案例分析</h3><p class="muted">已完成 ' + c.total + ' 套案例。交卷后请按评分点自评（每套约 75 分，及格 45）。</p><div class="sum-actions"><button class="btn primary" id="mBack">返回真题</button></div></div>';
        bind('#mBack', 'click', mockExit);
      }
      mockState.onClick = function (e) {
        var rev = e.target.closest('.case-reveal');
        if (rev) { var a = $('#mCaseA' + rev.getAttribute('data-ci')); if (a) { a.classList.toggle('hidden'); rev.textContent = a.classList.contains('hidden') ? '显示参考答案' : '隐藏参考答案'; } return; }
        if (e.target.closest('#mCaseNext')) { c.i++; render(); }
      };
      mockStartTimer(90, '案例分析模考', finish);
      render();
    });
  }

  function startMockEssay() {
    ensureEssay().then(function () {
      if (!ESSAY_ALL.length) { toast('论文数据加载中，请稍候'); return; }
      var e0 = shuffle(ESSAY_ALL)[0] || ESSAY_ALL[0];
      mockEnter();
      var tpl = window.EXAM_ESSAY_TPL || {};
      function render() {
        $('#quizMock').innerHTML = '<div class="case-meta">' + e0.y + ' ' + e0.s + ' · 第 ' + e0.no + ' 题</div>' +
          '<h3 class="case-topic">' + e0.topic + '</h3>' +
          '<p class="muted">请在下方撰写论文（建议 2500 字左右）。机考为电脑打字，先列提纲再展开，注意论点覆盖与项目真实性。</p>' +
          '<textarea id="mEssay" class="essay-area" placeholder="在此撰写论文…"></textarea>' +
          '<div class="essay-count">已写 <b id="mWord">0</b> 字（不计空格）</div>' +
          '<details class="tpl-card"><summary>写作模板与本题要点</summary>' +
          '<div class="tpl-row"><b>摘要公式</b><p>' + (tpl.summary || '') + '</p></div>' +
          '<div class="tpl-row"><b>五段式</b><p>' + (tpl.structure || '') + '</p></div>' +
          '<div class="tpl-row"><b>本题要点</b><p>' + (e0.tips || '').replace(/</g, '&lt;') + '</p></div></details>';
        bind('#mEssay', 'input', function () { $('#mWord').textContent = $('#mEssay').value.replace(/\s/g, '').length; });
      }
      function finish() {
        mockState.onClick = null; mockStopTimer();
        var w = $('#mEssay') ? $('#mEssay').value.replace(/\s/g, '').length : 0;
        $('#quizMock').innerHTML = '<div class="panel"><h3>模考完成 · 论文</h3><p class="muted">本题已写 ' + w + ' 字。论文评分看项目真实性、论点覆盖度与深度，交卷后对照上方「本题要点」自测。</p><div class="sum-actions"><button class="btn primary" id="mBack">返回真题</button></div></div>';
        bind('#mBack', 'click', mockExit);
      }
      mockState.onClick = function () {};
      mockStartTimer(120, '论文写作模考', finish);
      render();
    });
  }

  /* ================= 教材考点（第二版） ================= */
  var POINTS = (window.TEXTBOOK_POINTS || []).slice();
  var ptState = { filter: 'all' };
  var ptStore = (function () {
    var KEY = 'arch-term-points';
    var data = {};
    try { data = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) {}
    return {
      has: function (id) { return !!data[id]; },
      mark: function (id, on) { if (on) data[id] = 1; else delete data[id]; try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {} },
      count: function () { return Object.keys(data).length; }
    };
  })();
  function renderPoints() {
    var f = ptState.filter;
    var chips = '<button class="chip' + (f === 'all' ? ' on' : '') + '" data-pf="all">全部 ' + POINTS.length + ' 章</button>';
    POINTS.forEach(function (chp) {
      chips += '<button class="chip' + (f === ('c' + chp.ch) ? ' on' : '') + '" data-pf="c' + chp.ch + '">第' + chp.ch + '章 ' + chp.title + '</button>';
    });
    $('#ptCats').innerHTML = chips;
    var list = f === 'all' ? POINTS.slice() : POINTS.filter(function (c) { return 'c' + c.ch === f; });
    var html = '', total = 0, mastered = 0;
    list.forEach(function (chp) {
      html += '<div class="point-ch"><h4 class="point-ch-h">第' + chp.ch + '章 · ' + chp.title + '</h4>';
      chp.points.forEach(function (p) {
        var id = 'p' + chp.ch + '_' + p.t, on = ptStore.has(id);
        total++; if (on) mastered++;
        html += '<div class="point-card' + (on ? ' mastered' : '') + '" data-pid="' + id + '">'
          + '<div class="pc-head"><span class="pc-t">' + p.t.replace(/</g, '&lt;') + '</span><span class="pc-tag tag lv">难度 ' + p.tag + '</span></div>'
          + '<div class="pc-d">' + p.d.replace(/</g, '&lt;') + '</div>'
          + (p.rel && p.rel.length ? '<button class="btn ghost pc-rel" data-rel="' + p.rel.join(',') + '">相关真题 ' + p.rel.length + '</button>' : '')
          + '<button class="btn ghost pc-master">' + (on ? '已掌握 ✓' : '标记掌握') + '</button></div>';
      });
      html += '</div>';
    });
    $('#ptList').innerHTML = html;
    $('#ptTotal').textContent = total;
    $('#ptMastered').textContent = mastered;
  }
  bind('#ptCats', 'click', function (e) {
    var c = e.target.closest('[data-pf]'); if (!c) return;
    ptState.filter = c.getAttribute('data-pf'); renderPoints();
  });
  bind('#ptList', 'click', function (e) {
    var rel = e.target.closest('.pc-rel');
    if (rel) { openRelQuestions(rel.getAttribute('data-rel')); return; }
    var card = e.target.closest('.point-card'); if (!card) return;
    var id = card.getAttribute('data-pid');
    var on = !ptStore.has(id);
    ptStore.mark(id, on);
    card.classList.toggle('mastered', on);
    var btn = card.querySelector('.pc-master');
    if (btn) btn.textContent = on ? '已掌握 ✓' : '标记掌握';
    $('#ptMastered').textContent = ptStore.count();
  });
  function openRelQuestions(csv) {
    var ids = (csv || '').split(',').filter(Boolean);
    ensureExam().then(function () {
      var qs = ids.map(function (id) {
        for (var i = 0; i < EXAM_ALL.length; i++) if (EXAM_ALL[i].id === id) return EXAM_ALL[i];
        return null;
      }).filter(Boolean);
      if (!qs.length) { toast('相关真题加载中'); return; }
      var h = '<h3>考点相关真题（' + qs.length + ' 题）</h3>';
      qs.forEach(function (q) {
        h += '<div class="sec"><h4>' + q.y + ' ' + q.s + ' 第' + q.no + '题</h4>' +
          '<p class="muted" style="font-size:14px;line-height:1.8">' + q.q.replace(/</g, '&lt;') + '</p>' +
          '<p style="font-size:14px">正确答案：<span class="exam-ans">' + 'ABCD'[q.a] + '</span></p>' +
          (q.e ? '<div class="quiz-exp">' + q.e.replace(/</g, '&lt;') + '</div>' : '') + '</div>';
      });
      h += '<div class="sum-actions"><button class="btn primary" id="mRelPractice">去真题练习</button></div>';
      $('#modalBody').innerHTML = h;
      $('#modal').classList.remove('hidden');
      var bp = $('#mRelPractice');
      if (bp) bp.addEventListener('click', function () {
        $('#modal').classList.add('hidden');
        switchView('quiz');
        ensureExam().then(function () { showQuizPanel('exam'); startExam(false); });
      });
    });
  }

  bind('#setNew', 'change', function (e) { Store.data.settings.dailyNew = +e.target.value; Store.touch(); });
  bind('#setRev', 'change', function (e) { Store.data.settings.dailyReview = +e.target.value; Store.touch(); });
  bind('#setSpeak', 'change', function (e) { Store.data.settings.autoSpeak = e.target.checked; Store.touch(); });
  bind('#setBgm', 'change', function (e) { setBgm(e.target.checked, true); });
  bind('#setBgmVol', 'input', function (e) {
    Store.data.settings.bgmVol = +e.target.value;
    if (window.Bgm) Bgm.setVolume(+e.target.value / 100);
  });
  bind('#setBgmVol', 'change', function () { Store.touch(); });
  bind('#setSfx', 'change', function (e) {
    Store.data.settings.sfx = e.target.checked;
    Store.touch();
    if (window.Sfx) Sfx.setEnabled(e.target.checked);
    if (e.target.checked && window.Sfx) Sfx.click();
  });
  bind('#setSfxVol', 'input', function (e) {
    Store.data.settings.sfxVol = +e.target.value;
    if (window.Sfx) Sfx.setVolume(+e.target.value / 100);
  });
  bind('#setSfxVol', 'change', function () {
    Store.touch();
    if (window.Sfx && Store.data.settings.sfx !== false) Sfx.click(); // 松手时试听一下
  });
  bind('#btnBgm', 'click', function () { setBgm(!Store.data.settings.bgm, true); });
  bind('#themeBtn', 'click', function () {
    var s = Store.data.settings;
    s.theme = s.theme === 'dark' ? 'light' : 'dark';
    Store.touch();
    applySettings();
  });

  /* ---------------- 账号登录：等待态 + 行内反馈 ---------------- */

  /** Supabase 返回的是英文原话，映射成用户看得懂的中文。
   *  wasEmail=false 表示这次是用「用户名」登录/注册的 —— 错误提示要区别对待。 */
  function friendlyAuthError(msg, wasEmail) {
    var m = String(msg || '');
    if (/invalid login credentials/i.test(m)) {
      return wasEmail ? '邮箱或密码不正确，请重新输入'
                      : '用户名或密码不正确，请确认后重试（注意区分大小写不敏感，但用户名要拼对）';
    }
    if (/email not confirmed/i.test(m)) {
      return wasEmail ? '邮箱尚未验证，请先到邮箱点击确认链接'
                      : '该用户名需先完成邮箱验证才能登录 —— 用户名账号用的是无法收信的合成邮箱，'
                        + '请改用邮箱注册，或在 Supabase 后台关闭 Confirm email';
    }
    if (/user already registered/i.test(m)) {
      return wasEmail ? '该邮箱已注册，请直接登录' : '该用户名已被占用，换一个试试';
    }
    if (/password should be at least/i.test(m)) return '密码至少需要 6 位';
    if (/unable to validate email/i.test(m)) return '邮箱格式不正确';
    if (/rate limit|too many/i.test(m)) return '操作过于频繁，请稍后再试';
    if (/fetch|network|failed to fetch/i.test(m)) return '网络连接失败，请检查网络后重试';
    if (/supabase sdk|未加载/i.test(m)) return '云端服务未加载，请联网后刷新重试';
    if (/请先配置|未配置/i.test(m)) return '当前版本未内置云端服务，登录暂不可用';
    return m || '操作失败，请稍后重试';
  }

  /** 行内反馈条：常驻显示，不自动消失，保证用户来得及读完。
   *  登录成功后登录表单会被隐藏，所以同一条消息要同时写进「已登录」面板，否则成功提示一闪就没了。 */
  function authFeedback(msg, ok) {
    ['#acctErr', '#acctUserMsg'].forEach(function (sel) {
      var el = $(sel);
      if (!el) return;
      if (!msg) { el.className = 'hidden'; el.textContent = ''; return; }
      el.textContent = msg;
      el.className = ok ? 'form-ok' : 'form-err';   // 用 className 复位，避免残留 hidden
    });
  }

  /** 请求进行中：按钮变灰 + 转圈 + 文案切换，杜绝重复点击造成的重复注册 */
  var authBusy = false;
  function setAuthBusy(on, label) {
    authBusy = !!on;
    var bi = $('#btnSignIn'), bu = $('#btnSignUp');
    [bi, bu].forEach(function (b) {
      if (!b) return;
      b.disabled = authBusy;
      if (authBusy) {
        b.dataset.label = b.dataset.label || b.textContent;
        b.innerHTML = '<span class="spin"></span>' + (label || '处理中…');
      } else if (b.dataset.label) {
        b.textContent = b.dataset.label;
      }
    });
  }

  /** 标识符校验：邮箱或用户名都放行，分别给出各自的规则提示 */
  function checkIdentifier(raw) {
    var id = String(raw || '').trim();
    if (!id) return { ok: false, msg: '请填写邮箱或用户名' };
    if (Sync.isEmailInput(id)) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id)) return { ok: false, msg: '邮箱格式不正确' };
      return { ok: true, id: id, email: true };
    }
    // 用户名：3-32 位，字母或数字开头，只允许字母数字 . _ -
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(id)) {
      return { ok: false, msg: '用户名需 3–32 位，以字母或数字开头，只能含字母、数字、. _ -' };
    }
    return { ok: true, id: id, email: false };
  }

  function doAuth(isSignUp) {
    if (authBusy) return;
    // 从门禁进来的话，登录成功后门禁会被隐藏，写进面板里的常驻提示就看不见了，
    // 这种路径只给 toast；留在账号页登录/注册时才用常驻提示。
    var fromGate = gateState === 'locked';
    var chk = checkIdentifier($('#acctEmail').value);
    if (!chk.ok) { authFeedback(chk.msg); return; }
    var pwd = $('#acctPwd').value;
    if (pwd.length < 6) { authFeedback('密码至少 6 位'); return; }

    authFeedback('');
    setAuthBusy(true, isSignUp ? '注册中…' : '登录中…');

    var p = isSignUp ? Sync.signUp(chk.id, pwd) : Sync.signIn(chk.id, pwd);
    p.then(function (ok) {
      setAuthBusy(false);
      renderAccount();
      if (ok) {
        // 成功：toast 只是辅助，主反馈是下面这块常驻的成功提示
        var who = chk.email ? chk.id : '用户名 ' + chk.id;
        if (!fromGate) authFeedback('✓ ' + (isSignUp ? '注册成功，已自动登录' : '登录成功') + '（' + who + '），学习数据开始云端同步');
        toast(isSignUp ? '注册成功，已自动登录' : '登录成功');
      } else {
        authFeedback(friendlyAuthError(Sync.state().message, chk.email), false);
      }
    }).catch(function (e) {
      setAuthBusy(false);
      authFeedback(friendlyAuthError((e && e.message) || e, chk.email), false);
    });
  }

  bind('#btnSignIn', 'click', function () { doAuth(false); });
  bind('#btnSignUp', 'click', function () { doAuth(true); });
  bind('#gateRetry', 'click', function () { location.reload(); });

  bind('#btnSignOut', 'click', function () {
    Sync.signOut().then(function () { renderAccount(); authFeedback(''); toast('已退出登录，数据仍保留在本机'); });
  });
  bind('#btnSyncNow', 'click', function () {
    var b = $('#btnSyncNow');
    if (b) { b.disabled = true; b.innerHTML = '<span class="spin"></span>同步中…'; }
    Sync.pull().then(function () {
      if (b) { b.disabled = false; b.textContent = '立即同步'; }
      renderAccount();
      authFeedback(Sync.state().message || '已同步', true);
    });
  });

  bind('#btnExport', 'click', function () {
    var blob = new Blob([Store.exportText()], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arch-terms-' + Store.dayKey() + '.json';
    a.click();
    toast('已导出全部学习记录（含真题错题本）');
  });
  bind('#btnImport', 'click', function () { $('#importFile').click(); });
  bind('#importFile', 'change', function (e) {
    var f = e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        if (Store.load(JSON.parse(reader.result))) {
          applySettings();
          renderBackups();
          ensureTerms().then(function () { startSession(); renderLibrary(); renderStats(); });
          toast('导入成功（已合并，不影响已有进度）');
        } else toast('文件格式不正确');
      } catch (err) { toast('解析失败'); }
    };
    reader.readAsText(f);
    e.target.value = '';
  });

  /* ---------------- 本地快照 ---------------- */
  function renderBackups() {
    var el = $('#bakList');
    if (!el) return;
    var list = Store.listBackups();
    if (!list.length) { el.innerHTML = '<p class="muted">还没有快照。同步覆盖 / 导入 / 恢复 / 清空前都会自动创建。</p>'; return; }
    el.innerHTML = list.map(function (b) {
      return '<div class="lib-item" data-bak="' + b.t + '"><div class="lib-top">' +
        '<div class="lib-term">' + new Date(b.t).toLocaleString() + '</div>' +
        '<span class="badge learning">' + b.reason + ' · ' + b.cards + ' 词 / ' + b.reviewed + ' 次</span></div>' +
        '<div class="lib-def">点一下恢复到这份快照（恢复前会先自动备份当前状态）</div></div>';
    }).join('');
  }
  document.addEventListener('click', function (e) {
    var it = e.target.closest('[data-bak]');
    if (!it) return;
    var t = +it.getAttribute('data-bak');
    if (!confirm('恢复到 ' + new Date(t).toLocaleString() + ' 的快照？当前状态会先自动备份。')) return;
    if (Store.restoreBackup(t)) {
      applySettings();
      renderBackups();
      ensureTerms().then(function () { startSession(); renderLibrary(); renderStats(); });
      toast('已恢复该快照');
    } else toast('恢复失败');
  });

  bind('#btnResetLocal', 'click', function () {
    if (!confirm('确定清空本机学习记录？云端不受影响，重新登录后可从云端恢复。')) return;
    Store.snapshot('清空本机前自动备份');
    Store.reset();
    applySettings();
    renderBackups();
    ensureTerms().then(function () { startSession(); renderLibrary(); renderStats(); });
    toast('本机已清空');
  });
  bind('#btnResetAll', 'click', function () {
    if (!confirm('确定清空本机【和】云端的学习记录？不可恢复（仅会先自动留一份本地快照）。')) return;
    Store.snapshot('清空全部前自动备份');
    Store.reset();
    Sync.purge().then(function (ok) {
      applySettings();
      renderBackups();
      ensureTerms().then(function () { startSession(); renderLibrary(); renderStats(); });
      toast(ok ? '本机与云端均已清空' : (Sync.state().message || '本机已清空'));
    });
  });

  document.addEventListener('keydown', function (e) {
    // 门禁期间必须屏蔽：应用本体只是 visibility:hidden，键盘事件照样能打到
    // #view-learn 上，空格翻卡 / 123 评分会在未登录时改写本机记录。
    if (gateState === 'checking' || gateState === 'locked') return;
    var learnActive = $('#view-learn').classList.contains('active');
    if (e.key === 'Escape') { $('#modal').classList.add('hidden'); return; }
    if (!learnActive || $('#modal').classList.contains('hidden') === false) return;
    if (e.code === 'Space') { e.preventDefault(); flip(); }
    else if (e.key === '1') rate(0);
    else if (e.key === '2') rate(1);
    else if (e.key === '3') rate(2);
    else if (e.key === 'b' || e.key === 'B') setBgm(!Store.data.settings.bgm, true);
  });

  /* ---------------- 考前倒计时 ---------------- */
  // 考试日期：软考高级系统架构设计师（可在此修改）
  var EXAM_DATE = new Date(2026, 9, 24, 9, 0, 0); // 月份从 0 计，9 = 10 月
  var cdTimer = null;
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function renderCountdown() {
    var bar = $('#countdownBar'), dEl = $('#cdDays'), tEl = $('#cdTime'), uEl = $('#cdUnit');
    if (!bar || !dEl || !tEl) return;
    var diff = EXAM_DATE.getTime() - Date.now();
    if (diff <= 0) {
      clearInterval(cdTimer); cdTimer = null;
      dEl.textContent = '开考';
      if (uEl) uEl.textContent = '';
      tEl.textContent = '';
      bar.classList.remove('urgent', 'soon');
      bar.classList.add('now');
      bar.querySelector('.cd-label').textContent = '软考 · 系统架构设计师 进行中';
      bar.querySelector('.cd-date').textContent = '稳住，你能行！';
      return;
    }
    var s = Math.floor(diff / 1000);
    var days = Math.floor(s / 86400); s -= days * 86400;
    var h = Math.floor(s / 3600); s -= h * 3600;
    var m = Math.floor(s / 60); var sec = s - m * 60;

    // 大号只放「天」，时分秒走右侧时钟位 —— 整串塞进 30px 粗体在手机上必然挤爆
    if (days > 0) {
      dEl.textContent = days;
      if (uEl) uEl.textContent = '天';
      tEl.textContent = pad2(h) + ':' + pad2(m) + ':' + pad2(sec);
    } else {
      dEl.textContent = h;
      if (uEl) uEl.textContent = '时';
      tEl.textContent = pad2(m) + ':' + pad2(sec);
    }

    // 紧迫感分级：<7 天 urgent（红脉冲），<15 天 soon（暖色）
    bar.classList.toggle('urgent', days < 7);
    bar.classList.toggle('soon', days >= 7 && days < 15);
  }
  renderCountdown();
  cdTimer = setInterval(renderCountdown, 1000);

  /* ---------------- 启动 ---------------- */
  lastDataRef = Store.data;
  Sync.onChange(afterCloudChange);
  renderEnvBadge();
  applySettings();
  if (Store.data.settings.bgm && window.Bgm) Bgm.startWhenAllowed(); // 等首次点击/按键后才真正出声
  updateSide();
  // 词库数据按需加载，加载完成后再做依赖它的首屏渲染
  ensureTerms().then(function () {
    renderLibrary();
    renderStats();
    startSession();
    switchView('learn');
  });
  Sync.init().then(function () {
    afterCloudChange();
  }).catch(function (e) {
    // init 内部基本已兜住，这里只是保证门禁一定会落到终态，
    // 绝不会停在「正在检查登录状态…」让人干等
    console.warn('[启动] 同步初始化异常：', e);
    applyGate();
  });
})();
