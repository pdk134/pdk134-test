/* =========================================================
 * 月记 - 登录门禁 + 云端同步（Supabase）
 *
 * 设计要点：
 *   - 账号：用户名或邮箱 + 密码（Supabase Auth），用户名确定性拼成邮箱；
 *   - 数据：每个用户一行 { user_id, data(jsonb), updated_at }，RLS 保证只能读写自己那一行；
 *   - 合并：只做并集，绝不用远端整份覆盖本机（避免新设备空白数据把记录吃空）；
 *   - 门禁：未登录时遮住整个应用，登录成功后才会同步并展示；
 *   - 离线：已登录过的设备即使断网，也能凭本地 session 进入，改动先存本机、联网后再推。
 * ========================================================= */

window.PTCloud = (function () {
  'use strict';

  const CFG = window.PT_SUPABASE_CONFIG || {};
  const TABLE = CFG.table || 'period_data';
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
    return String(window.PT_USERNAME_DOMAIN || DEFAULT_DOMAIN).trim();
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
      msg = '网络异常，请检查网络后重试';
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

  /* ---------------- 数据序列化 / 合并 ---------------- */

  function localData() {
    const s = PT.state;
    return {
      periodDays: [...s.periodDays].sort(),
      closedPeriods: [...s.closedPeriods].sort(),
      dailyLogs: s.dailyLogs || {}
    };
  }

  /** 把云端数据并进本机：只增不减，冲突时本机已有的字段优先 */
  function mergeRemote(remote) {
    if (!remote || typeof remote !== 'object') return false;
    const s = PT.state;
    let changed = false;

    (remote.periodDays || []).forEach(function (d) {
      if (typeof d === 'string' && !s.periodDays.has(d)) { s.periodDays.add(d); changed = true; }
    });
    (remote.closedPeriods || []).forEach(function (d) {
      if (typeof d === 'string' && !s.closedPeriods.has(d)) { s.closedPeriods.add(d); changed = true; }
    });

    const rl = remote.dailyLogs || {};
    Object.keys(rl).forEach(function (k) {
      const r = rl[k] || {};
      const l = s.dailyLogs[k];
      if (!l) { s.dailyLogs[k] = r; changed = true; return; }
      const before = JSON.stringify({
        symptoms: l.symptoms || [], mood: l.mood || '', note: l.note || ''
      });
      const merged = {
        symptoms: Array.from(new Set([].concat(l.symptoms || [], r.symptoms || []))),
        mood: l.mood || r.mood || '',
        note: l.note || r.note || ''
      };
      if (JSON.stringify(merged) !== before) { s.dailyLogs[k] = merged; changed = true; }
    });

    if (changed) {
      PT.saveState();
      PT.renderAll();
    }
    return changed;
  }

  /* ---------------- 云端读写 ---------------- */

  function ensureClient() {
    if (!CFG.url || !CFG.anonKey) return null;
    if (!window.supabase || !window.supabase.createClient) return null;
    if (!client) client = window.supabase.createClient(CFG.url, CFG.anonKey);
    return client;
  }

  async function pull() {
    if (!client || !sessionUser) return false;
    try {
      const res = await client.from(TABLE)
        .select('data,updated_at')
        .eq('user_id', sessionUser.id)
        .maybeSingle();
      if (res.error) { fail(res.error); return false; }

      state.lastSync = Date.now();
      const remote = res.data && res.data.data;
      if (!remote) {
        const ok = await push(true);
        state.status = ok ? 'ready' : 'error';
        if (ok) emit('');
        return ok;
      }

      const changed = mergeRemote(remote);
      if (changed) {
        await push(true);
        emit('已合并云端记录');
      } else {
        emit('');
      }
      state.status = 'ready';
      return true;
    } catch (e) { fail(e); return false; }
  }

  async function push(silent) {
    if (!client || !sessionUser) return false;
    try {
      const res = await client.from(TABLE).upsert({
        user_id: sessionUser.id,
        data: localData(),
        updated_at: Date.now()
      }, { onConflict: 'user_id' });
      if (res.error) { fail(res.error); return false; }
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
    state.status = 'syncing';
    emit('正在同步…');
    const ok = await pull();
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
    showGate('登录后记录会在设备间同步');
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
      await pull();
      syncBtn.disabled = false;
    });

    const outBtn = $('acctSignOut');
    if (outBtn) outBtn.addEventListener('click', function () { signOut(); });

    const loginBtn = $('acctLogin');
    if (loginBtn) loginBtn.addEventListener('click', function () {
      setMode('signin');
      const f = $('gateForm'); if (f) f.classList.remove('hidden');
      showGate('登录后记录会在设备间同步');
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
        showGate('登录后记录会在设备间同步');
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

    // 回到前台 / 定时拉取一次，手机上多设备切换时更快看到对方改动
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && client && sessionUser) pull();
    });
    setInterval(function () {
      if (document.visibilityState === 'visible' && client && sessionUser) pull();
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
