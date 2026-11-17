/**
 * 云端同步层（Supabase）
 * - 账号：邮箱 + 密码（Supabase Auth）
 * - 数据：每个用户一行 { user_id, data(json), updated_at(bigint) }，靠 RLS 保证只能读写自己那一行
 * - 表名可配（config.js 的 table 字段），用于开发 / 生产隔离：
 *   生产 main → progress；开发 nanana → progress_dev。两者同项目、不同表，互不污染。
 *   不要再靠「账号页高级面板」的本地覆盖来区分环境 —— 它存在 localStorage 里，
 *   切分支不会失效，很容易出现「以为在 main 其实连着 dev」的错觉。
 * - 冲突策略：**只合并、绝不整份覆盖**。
 *   早期版本按 updated_at 做 last-write-wins，一旦某台新设备拿着空白快照（时间戳最新）推上去，
 *   其它设备就会被整份吃空。现在 pull 一律走 Store.merge()，push 前也会先看云端，
 *   云端更丰富时改为合并回本地，只升不降。
 * - 覆盖云端前自动在本地留快照（最多 5 份），可在设置页一键回退。
 */
window.Sync = (function () {
  var CFG_KEY = 'arch-term-supabase-config';
  var DEFAULT_TABLE = 'progress';
  var client = null;
  var cfg = null;
  var user = null;
  var listeners = [];
  var pushTimer = null;
  var state = { status: 'off', message: '', lastSync: 0, email: '', table: DEFAULT_TABLE };

  function emit(msg) {
    if (msg) state.message = msg;
    for (var i = 0; i < listeners.length; i++) listeners[i](state);
  }

  /** 当前使用的表名：优先本机覆盖 → 内置 config.js → 默认 progress */
  function tableName() {
    var t = cfg && cfg.table;
    if (!t) { var d = window.SUPABASE_CONFIG || {}; t = d.table; }
    return (t && String(t).trim()) || DEFAULT_TABLE;
  }

  /** 构建环境名。生产构建由流水线写成 'prod'，其余一律 'dev'（含未替换的兜底） */
  function envName() {
    return window.SUPABASE_ENV === 'prod' ? 'prod' : 'dev';
  }

  var DEFAULT_USER_DOMAIN = 'archgo-user.invalid';
  function usernameDomain() {
    return (window.SUPABASE_USERNAME_DOMAIN || DEFAULT_USER_DOMAIN).trim();
  }

  /**
   * 把用户填的「邮箱或用户名」归一化成 Supabase 能接受的邮箱。
   * 用户名不做查表映射，而是确定性拼成 name@域名 —— 因此换设备、换浏览器结果完全一致，
   * 也不会多出一张需要维护的映射表。
   */
  function toAuthId(input) {
    var v = String(input == null ? '' : input).trim().toLowerCase();
    if (!v) return '';
    if (v.indexOf('@') >= 0) return v;
    return v + '@' + usernameDomain();
  }

  /** 反向：把合成邮箱还原成用户当初填的东西，用于界面显示（避免显示 alice@archgo-user.invalid） */
  function displayId(email) {
    var e = String(email || '');
    var suffix = '@' + usernameDomain();
    if (e.length > suffix.length && e.slice(-suffix.length) === suffix) return e.slice(0, -suffix.length);
    return e;
  }

  /** 判断输入是邮箱还是用户名 */
  function isEmailInput(input) {
    return String(input || '').indexOf('@') >= 0;
  }

  function loadConfig() {
    // 旧版本在「账号页 → 高级」里把项目配置写进 localStorage 覆盖 config.js，
    // 而那个入口已经下线。这种残留配置切分支也不会失效，会让 App 一直连着旧项目，
    // 所以这里直接一次性清掉，config.js 成为唯一配置来源。
    try { localStorage.removeItem(CFG_KEY); } catch (e) {}
    var d = window.SUPABASE_CONFIG || {};
    cfg = (d.url && d.anonKey) ? { url: d.url, key: d.anonKey, table: d.table } : null;
    state.table = tableName();
    return cfg;
  }

  function clientNow() {
    if (!cfg) { state.status = 'off'; return null; }
    if (!window.supabase || !window.supabase.createClient) {
      state.status = 'error';
      state.message = 'Supabase SDK 未加载，请联网后重试';
      return null;
    }
    if (!client) client = window.supabase.createClient(cfg.url, cfg.key);
    return client;
  }

  function fail(e) {
    state.status = 'error';
    state.message = (e && (e.message || e.error_description || e)) || '请求失败';
    emit();
  }

  /* ---------------- 拉取 / 推送 ---------------- */

  /** 一份数据里 reps>0 的卡片数，用来判断哪一侧更「有进度」 */
  function progressOf(d) {
    var n = 0, k;
    if (d && d.cards) for (k in d.cards) if ((d.cards[k].reps || 0) > 0) n++;
    return n;
  }

  async function pull(fromInit) {
    var c = clientNow();
    if (!c || !user) return false;
    try {
      var res = await c.from(tableName()).select('*').eq('user_id', user.id).maybeSingle();
      if (res.error) { fail(res.error); return false; }
      var remote = res.data;
      state.lastSync = Date.now();

      if (!remote || !remote.data) {
        await push(true, true);
        state.status = 'ready';
        emit('云端还没有数据，已上传本机进度');
        return true;
      }

      // 一律合并，不用远端整份替换本地
      var r = Store.merge(remote.data);
      if (r.changed) {
        Store.touch();
        await push(false, true);           // 合并进来的新进度回推云端
        state.status = 'ready';
        emit('已合并云端数据' + (r.gained > 0 ? '（新增 ' + r.gained + ' 个已学术语）' : ''));
      } else {
        state.status = 'ready';
        emit('两端数据一致');
      }
      return true;
    } catch (e) { fail(e); return false; }
  }

  /**
   * 上传本地进度。
   * known = 已经在本次流程里读到过云端现状（如 pull 刚查过），跳过重复查询。
   * 上传前会比对云端：云端进度更丰富时，先把云端合并回本地（并留快照），再推上去。
   */
  async function push(force, known) {
    var c = clientNow();
    if (!c || !user) return false;
    try {
      if (!known) {
        var cur = await c.from(tableName()).select('data,updated_at').eq('user_id', user.id).maybeSingle();
        if (cur.error) { fail(cur.error); return false; }
        var rd = cur.data && cur.data.data;
        if (rd && progressOf(rd) > progressOf(Store.data)) {
          Store.snapshot('云端数据更丰富，已自动备份本机');
          var r = Store.merge(rd);
          Store.touch();
          state.message = '云端数据更丰富，已合并而非覆盖';
          emit(state.message);
          known = true;
          if (r.gained > 0) state.message += '（+' + r.gained + ' 个术语）';
          emit();
        }
      }
      var res = await c.from(tableName()).upsert(
        { user_id: user.id, data: Store.data, updated_at: Store.data.updatedAt || Date.now() },
        { onConflict: 'user_id' }
      );
      if (res.error) { fail(res.error); return false; }
      state.lastSync = Date.now();
      if (force) emit(state.message || '已上传到云端');
      else emit();
      return true;
    } catch (e) { fail(e); return false; }
  }

  function schedulePush() {
    if (!isReady()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { push(false); }, 2500);
  }

  /** 删除云端这一行（设置页「同时清除云端」用）。RLS 允许本人删除自己的行。 */
  async function purge() {
    var c = clientNow();
    if (!c || !user) { state.status = 'error'; state.message = '请先登录再清除云端数据'; emit(); return false; }
    try {
      Store.snapshot('清除云端前自动备份');
      var res = await c.from(tableName()).delete().eq('user_id', user.id);
      if (res.error) { fail(res.error); return false; }
      state.lastSync = Date.now();
      state.status = 'ready';
      emit('云端数据已删除，本机记录保持不变');
      return true;
    } catch (e) { fail(e); return false; }
  }

  /* ---------------- 账号 ---------------- */
  async function bootstrap() {
    var c = clientNow();
    if (!c) return;
    state.status = 'syncing';
    emit('正在同步…');
    await pull(true);
  }

  async function signUp(email, password) {
    var c = clientNow();
    if (!c) { state.status = 'error'; state.message = '请先填写 Supabase 配置'; emit(); return false; }
    try {
      var res = await c.auth.signUp({ email: toAuthId(email), password: password });
      if (res.error) { fail(res.error); return false; }
      if (!res.data.session) {
        state.status = 'ready';
        state.message = '注册成功，请先到邮箱点确认链接后再登录（也可在 Supabase 后台关闭邮箱验证）';
        emit();
        return false;
      }
      user = res.data.user;
      state.email = user.email;
      await bootstrap();
      return true;
    } catch (e) { fail(e); return false; }
  }

  async function signIn(email, password) {
    var c = clientNow();
    if (!c) { state.status = 'error'; state.message = '请先填写 Supabase 配置'; emit(); return false; }
    try {
      var res = await c.auth.signInWithPassword({ email: toAuthId(email), password: password });
      if (res.error) { fail(res.error); return false; }
      user = res.data.user;
      state.email = user.email;
      await bootstrap();
      return true;
    } catch (e) { fail(e); return false; }
  }

  async function signOut() {
    var c = clientNow();
    user = null;
    state.status = 'off';
    state.email = '';
    state.message = '已退出登录，数据仍保留在本机';
    if (c) { try { await c.auth.signOut(); } catch (e) {} }
    emit();
  }

  /* ---------------- 初始化 ---------------- */
  var inited = false;
  async function init() {
    if (inited) { loadConfig(); client = null; clientNow(); emit(); return; }
    inited = true;
    loadConfig();
    var c = clientNow();
    if (!c) { emit(state.message || '未配置 Supabase，当前为纯本地模式'); return; }
    try {
      var res = await c.auth.getSession();
      user = (res.data && res.data.session && res.data.session.user) || null;
      state.email = user ? user.email : '';
      if (user) { await bootstrap(); } else { state.status = 'ready'; emit('未登录，数据只存在本机'); }
    } catch (e) { fail(e); }
    c.auth.onAuthStateChange(function (_e, session) {
      user = session ? session.user : null;
      state.email = user ? user.email : '';
      if (user) bootstrap(); else { state.status = 'ready'; emit('未登录，数据只存在本机'); }
    });

    setInterval(function () {
      if (isReady() && document.visibilityState === 'visible') pull(false);
    }, 120000);
    document.addEventListener('visibilitychange', function () {
      if (isReady() && document.visibilityState === 'visible') pull(false);
    });
    window.addEventListener('pagehide', function () { if (isReady()) push(true); });
  }

  function isReady() { return !!(cfg && user && client); }

  return {
    init: init,
    state: function () { return state; },
    isReady: isReady,
    hasConfig: function () { return !!cfg; },
    config: function () { return cfg; },
    tableName: tableName,
    envName: envName,
    toAuthId: toAuthId,
    displayId: displayId,
    isEmailInput: isEmailInput,
    usernameDomain: usernameDomain,
    signIn: signIn,
    signUp: signUp,
    signOut: signOut,
    pull: function () { return pull(false); },
    push: function () { return push(true); },
    purge: purge,
    schedulePush: schedulePush,
    onChange: function (fn) { listeners.push(fn); }
  };
})();
