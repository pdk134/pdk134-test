/* =========================================================
 * 任务清单 - 登录门禁 + 云端同步（Supabase）
 *
 * 设计要点：
 *   - 账号：与学习通 / 月记同一套（用户名或邮箱 + 密码，Supabase Auth）；
 *   - 数据：task_items 表每任务一行，RLS 保证只能读写自己的行；
 *   - 同步：全量拉取 + 按 updated_at 的 last-write-wins 合并；
 *           本机改动 2.5s 防抖 upsert，刷新 / 断网不丢（pending 持久化）；
 *   - 删除：软删除，同步到云端后其他设备自然消失；
 *   - 门禁：未登录时遮住整个应用；已登录过的设备断网也能进（本地 session）。
 * ========================================================= */

window.TaskCloud = (function () {
  'use strict';

  const CFG = window.TASK_SUPABASE_CONFIG || {};
  const TABLE = CFG.table || 'task_items';
  const DEFAULT_DOMAIN = 'archgo-user.invalid';
  const PUSH_DELAY = 2500;
  const PULL_INTERVAL = 120000;

  let client = null;
  let sessionUser = null;
  let pushTimer = null;
  let mode = 'signin';
  let busy = false;
  let booted = false;

  const listeners = [];
  const state = { status: 'checking', message: '', lastSync: 0, account: '' };

  function $(id) { return document.getElementById(id); }

  /* ---------------- 账号归一化 ---------------- */

  function domain() {
    return String(window.TASK_USERNAME_DOMAIN || DEFAULT_DOMAIN).trim();
  }

  function toAuthId(input) {
    const v = String(input == null ? '' : input).trim().toLowerCase();
    if (!v) return '';
    return v.indexOf('@') >= 0 ? v : v + '@' + domain();
  }

  function displayId(email) {
    const e = String(email || '');
    const suffix = '@' + domain();
    return (e.length > suffix.length && e.slice(-suffix.length) === suffix)
      ? e.slice(0, -suffix.length) : e;
  }

  /* ---------------- 状态通知 ---------------- */

  function emit(msg) {
    if (msg !== undefined) state.message = msg;
    for (let i = 0; i < listeners.length; i++) {
      try { listeners[i](state); } catch (e) { /* 忽略监听器异常 */ }
    }
    renderAccount();
  }

  function fail(e) {
    let msg = (e && (e.message || e.error_description)) || String(e || '请求失败');
    if (/failed to fetch|networkerror|network error|timed?\s?out|load failed/i.test(msg)) {
      msg = '无法连接云端服务，可能项目暂停或网络异常';
    }
    state.status = 'error';
    emit(msg);
  }

  /* ---------------- 门禁 UI ---------------- */

  function showGate(text, opts) {
    document.body.classList.add('locked');
    const gate = $('gate');
    if (gate) gate.classList.remove('hidden');
    if (text) { const s = $('gateSub'); if (s) s.textContent = text; }
    if (opts && opts.showForm) {
      const f = $('gateForm'); if (f) f.classList.remove('hidden');
    }
  }

  function hideGate() {
    document.body.classList.remove('locked');
    const gate = $('gate');
    if (gate) gate.classList.add('hidden');
  }

  function setError(msg) {
    const el = $('gateError');
    if (!el) return;
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function setMode(next) {
    mode = next;
    const submit = $('gateSubmit');
    const sw = $('gateSwitch');
    const pass = $('gatePass');
    if (submit) submit.textContent = mode === 'signup' ? '注册并登录' : '登录';
    if (sw) sw.textContent = mode === 'signup' ? '已有账号？去登录' : '没有账号？注册一个';
    if (pass) pass.setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
    setError('');
  }

  /* ---------------- 云端读写 ---------------- */

  function ensureClient() {
    if (!CFG.url || !CFG.anonKey) return null;
    if (!window.supabase || !window.supabase.createClient) return null;
    if (!client) client = window.supabase.createClient(CFG.url, CFG.anonKey);
    return client;
  }

  async function pull(silent) {
    if (!client || !sessionUser) return false;
    try {
      const res = await client.from(TABLE)
        .select('*')
        .eq('user_id', sessionUser.id);
      if (res.error) { fail(res.error); return false; }

      state.lastSync = Date.now();
      const changed = TaskStore.mergeRemote(res.data || []);

      // 拉取后仍待推送的本机改动（含断网期间积攒的），立即推上去
      if (TaskStore.pendingRows().length) {
        return await push(silent);
      }
      state.status = 'ready';
      if (!silent) emit(changed.length ? '已合并云端任务' : '');
      return true;
    } catch (e) { fail(e); return false; }
  }

  async function push(silent) {
    if (!client || !sessionUser) return false;
    const rows = TaskStore.pendingRows();
    if (!rows.length) { state.status = 'ready'; return true; }
    try {
      // 只提交表里存在的列，并补上 user_id（RLS 的 with check 依赖它）
      const payload = rows.map(function (t) {
        return {
          id: t.id,
          user_id: sessionUser.id,
          title: t.title,
          note: t.note || '',
          due_date: t.due_date,
          status: t.status === 'done' ? 'done' : 'todo',
          priority: Number(t.priority) || 0,
          defer_count: Number(t.defer_count) || 0,
          completed_at: t.completed_at || null,
          deleted_at: t.deleted_at || null,
          created_at: t.created_at,
          updated_at: t.updated_at
        };
      });
      const res = await client.from(TABLE).upsert(payload);
      if (res.error) { fail(res.error); return false; }
      TaskStore.markSynced(rows.map(function (r) { return r.id; }));
      state.lastSync = Date.now();
      state.status = 'ready';
      if (!silent) emit('已同步');
      return true;
    } catch (e) { fail(e); return false; }
  }

  function schedulePush() {
    if (!client || !sessionUser) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { push(true); }, PUSH_DELAY);
  }

  /* ---------------- 登录 / 注册 / 退出 ---------------- */

  async function afterLogin() {
    hideGate();
    setError('');
    // 本地缓存按账号隔离，避免换账号时把上一个账号的任务串过去
    if (sessionUser) TaskStore.bindUser(sessionUser.id);
    state.status = 'syncing';
    emit('正在同步…');
    const ok = await pull(true);
    if (ok) { state.status = 'ready'; emit(''); }
  }

  async function signIn(account, password) {
    if (!client) { fail('登录服务未就绪'); return false; }
    try {
      const res = await client.auth.signInWithPassword({
        email: toAuthId(account), password: password
      });
      if (res.error) { fail(res.error); return false; }
      sessionUser = res.data.user;
      state.account = displayId(sessionUser.email);
      await afterLogin();
      return true;
    } catch (e) { fail(e); return false; }
  }

  async function signUp(account, password) {
    if (!client) { fail('登录服务未就绪'); return false; }
    try {
      const res = await client.auth.signUp({
        email: toAuthId(account), password: password
      });
      if (res.error) { fail(res.error); return false; }
      if (!res.data.session) {
        state.status = 'ready';
        emit('注册成功，请先在邮箱完成验证再回来登录');
        return false;
      }
      sessionUser = res.data.user;
      state.account = displayId(sessionUser.email);
      await afterLogin();
      return true;
    } catch (e) { fail(e); return false; }
  }

  async function signOut() {
    if (client) { try { await client.auth.signOut(); } catch (e) { /* 忽略 */ } }
    sessionUser = null;
    state.account = '';
    state.status = 'off';
    emit('');
    setMode('signin');
    const f = $('gateForm'); if (f) f.classList.remove('hidden');
    showGate('登录后任务会在设备间同步');
    renderAccount();
  }

  /* ---------------- 账号卡片 ---------------- */

  function renderAccount() {
    const el = $('acctStatus');
    if (!el) return;
    const parts = [state.account ? ('已登录：' + state.account) : '未登录'];
    if (state.lastSync) {
      const d = new Date(state.lastSync);
      parts.push('上次同步 ' +
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'));
    }
    if (state.message) parts.push(state.message);
    el.textContent = parts.join(' · ');

    const out = $('acctSignOut'); if (out) out.disabled = !state.account;
    const sync = $('acctSync'); if (sync) sync.disabled = !state.account;
    const login = $('acctLogin');
    if (login) login.classList.toggle('hidden', !!state.account);
  }

  /* ---------------- 初始化 ---------------- */

  function bindUi() {
    const form = $('gateForm');
    if (form) {
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        if (busy) return;
        const account = ($('gateUser') || {}).value || '';
        const password = ($('gatePass') || {}).value || '';
        if (!account.trim()) { setError('请填写用户名或邮箱'); return; }
        if (!password || password.length < 6) { setError('密码至少 6 位'); return; }

        busy = true;
        setError('');
        const btn = $('gateSubmit');
        if (btn) { btn.disabled = true; btn.textContent = '处理中…'; }
        const ok = mode === 'signup'
          ? await signUp(account, password)
          : await signIn(account, password);
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = mode === 'signup' ? '注册并登录' : '登录'; }
        if (!ok) setError(state.message || '登录失败，请重试');
      });
    }

    const sw = $('gateSwitch');
    if (sw) sw.addEventListener('click', function () {
      setMode(mode === 'signup' ? 'signin' : 'signup');
    });

    const retry = $('gateRetry');
    if (retry) retry.addEventListener('click', function () { location.reload(); });

    const syncBtn = $('acctSync');
    if (syncBtn) syncBtn.addEventListener('click', async function () {
      syncBtn.disabled = true;
      await pull(false);
      syncBtn.disabled = false;
    });

    const outBtn = $('acctSignOut');
    if (outBtn) outBtn.addEventListener('click', function () { signOut(); });

    const loginBtn = $('acctLogin');
    if (loginBtn) loginBtn.addEventListener('click', function () {
      setMode('signin');
      const f = $('gateForm'); if (f) f.classList.remove('hidden');
      showGate('登录后任务会在设备间同步');
    });
  }

  async function init() {
    if (booted) return;
    booted = true;
    bindUi();

    if (!CFG.url || !CFG.anonKey) {
      state.status = 'error';
      showGate('未配置云端服务，暂时无法登录');
      const retry = $('gateRetry'); if (retry) retry.classList.remove('hidden');
      emit('未配置云端服务');
      return;
    }

    if (!window.supabase || !window.supabase.createClient) {
      state.status = 'error';
      showGate('登录服务加载失败，请检查网络后重试');
      const retry = $('gateRetry'); if (retry) retry.classList.remove('hidden');
      const f = $('gateForm'); if (f) f.classList.add('hidden');
      emit('登录服务加载失败');
      return;
    }

    client = window.supabase.createClient(CFG.url, CFG.anonKey);
    showGate('正在检查登录状态…');
    const f = $('gateForm'); if (f) f.classList.add('hidden');

    try {
      const res = await client.auth.getSession();
      const session = res.data && res.data.session;
      if (session && session.user) {
        sessionUser = session.user;
        state.account = displayId(session.user.email);
        await afterLogin();
      } else {
        state.status = 'ready';
        if (f) f.classList.remove('hidden');
        setMode('signin');
        showGate('登录后任务会在设备间同步');
        emit('');
      }
    } catch (e) {
      state.status = 'error';
      if (f) f.classList.remove('hidden');
      showGate('无法连接登录服务，请检查网络');
      setError('网络异常，可稍后重试');
    }

    client.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT') {
        sessionUser = null;
        state.account = '';
      }
    });

    // 回到前台 / 定时拉取一次，多设备切换时更快看到对方改动
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && client && sessionUser) pull(true);
    });
    setInterval(function () {
      if (document.visibilityState === 'visible' && client && sessionUser) pull(true);
    }, PULL_INTERVAL);
    window.addEventListener('pagehide', function () {
      if (client && sessionUser) push(true);
    });
  }

  init();

  return {
    state: function () { return state; },
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    pull: pull,
    push: push,
    schedulePush: schedulePush,
    toAuthId: toAuthId,
    displayId: displayId,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
