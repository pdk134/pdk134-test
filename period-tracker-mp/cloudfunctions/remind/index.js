const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/* ===================== 配置区（按后台模板改这里） ===================== */
// mp.weixin.qq.com → 功能 → 订阅消息 → 我的模板 →「日程提醒」（一次性订阅）
const TEMPLATE_ID = 'EPvaF7BUcvy5Pg5bseZBDJgtReOba0EMGvssnkkaoA8';
const COLLECTION = 'tasks';
const LOG_COLLECTION = 'remind_log';   // 每次运行的发送记录，排查问题时查这里
const LOG_KEEP_DAYS = 90;             // 日志保留天数，更早的自动清理
// 每天 8:00 扫描的天数偏移：0 = 今天到期，1 = 明天到期。只处理「没设具体时间」的任务。
const REMIND_DAYS = [0, 1];
const DAYS_BEFORE = 1;                 // 仅测试模式使用：测试文案里的目标日 = 明天
const REMIND_HOUR = 8;                 // 每日汇总的整点；也是 time 字段缺时间时的兜底显示
const PAGE = 'pages/list/list';       // 点通知打开清单页
// 开发阶段先用 developer，未发布正式版时也能下发；小程序发布后改回 formal
const MINIPROGRAM_STATE = 'developer';   // 开发版 developer / 体验版 trial / 正式版 formal

// 模板关键词顺序：日程时间、日程标题、提醒内容。
// 正常情况由 getFieldSets() 从微信接口读取真实字段名（如 date4 / thing1…）；
// 下面只是接口不可用时的兜底候选，参数不匹配（47003）会依次重试。
const FIELD_SETS = [
  { due: 'time1', title: 'thing2', tip: 'thing3' },
  { due: 'date1', title: 'thing2', tip: 'thing3' },
  { due: 'thing1', title: 'thing2', tip: 'thing3' }
];
/* ==================================================================== */

function parseKeys(text) {
  var keys = [], re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\.DATA\s*\}\}/g, m;
  while ((m = re.exec(text)) !== null) {
    if (keys.indexOf(m[1]) < 0) keys.push(m[1]);
  }
  return keys;
}

/**
 * 直接问微信要这个模板的真实字段名，不再猜编号。
 * getTemplateList 返回的 content 形如「日程提醒:{{thing1.DATA}} …」，
 * 角色由字段名类型识别（见 pickFields），字段顺序调整后无需改代码。
 * 接口不可用时回退到内置的 FIELD_SETS 候选组。
 */
async function getFieldSets() {
  try {
    var res = await cloud.openapi.subscribeMessage.getTemplateList({});
    var list = (res && res.data) || [];
    var tpl = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].priTmplId === TEMPLATE_ID) { tpl = list[i]; break; }
    }
    if (!tpl) {
      for (var j = 0; j < list.length; j++) {
        if (String(list[j].title || '').indexOf('日程') >= 0) { tpl = list[j]; break; }
      }
    }
    if (!tpl) return FIELD_SETS;
    console.log('[remind] 模板原始信息', JSON.stringify({
      id: tpl.priTmplId, title: tpl.title, content: tpl.content, example: tpl.example
    }));

    var keys = parseKeys(String(tpl.content || ''));
    if (keys.length < 3) keys = parseKeys(String(tpl.example || ''));
    if (keys.length < 3) return FIELD_SETS;

    var auto = pickFields(keys);
    if (!auto) return FIELD_SETS;
    console.log('[remind] 模板字段（自动读取）', JSON.stringify(auto));
    return [auto].concat(FIELD_SETS);
  } catch (e) {
    console.warn('[remind] 自动读取模板字段失败，改用候选组', e && (e.errMsg || e.errmsg || e.message));
    return FIELD_SETS;
  }
}

/**
 * 按字段名类型识别角色，不按位置：time 或 date 开头的是日程时间，
 * 其余 thing* 按出现顺序第一个当标题、第二个当内容。
 * 模板里三个字段的先后顺序随便调（卡片显示顺序由模板决定），映射都不会错位。
 */
function pickFields(keys) {
  var due = null, things = [];
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (!due && (/^time/.test(k) || /^date/.test(k))) due = k;
    else things.push(k);
  }
  if (due && things.length >= 2) return { due: due, title: things[0], tip: things[1] };
  return null;
}

function pad(n) { return n < 10 ? '0' + n : String(n); }

/** 云函数运行环境是 UTC，统一换算成北京时间（UTC+8）后再取日期 */
function beijingDate(offsetDays) {
  return new Date(Date.now() + (8 + (offsetDays || 0) * 24) * 60 * 60 * 1000);
}
function fmtISO(d) {
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}
function fmtCN(iso, hour) {
  var p = iso.split('-');
  return Number(p[0]) + '年' + Number(p[1]) + '月' + Number(p[2]) + '日 ' + pad(hour) + ':00';
}
/** thing 类型最多 20 个字符 */
function clipThing(s) {
  var str = String(s || '').replace(/\s+/g, ' ').trim();
  return str.length > 20 ? str.slice(0, 19) + '…' : str;
}
function fmtCNDate(iso) {
  var p = iso.split('-');
  return Number(p[0]) + '年' + Number(p[1]) + '月' + Number(p[2]) + '日';
}
/** 按字段类型决定日期值的格式：time 带真实时分、date 只要日期、thing 当短文本 */
function dueValue(key, target, timeHM) {
  if (String(key).indexOf('time') === 0) {
    if (timeHM) {
      var d = target.split('-'), t = String(timeHM).split(':');
      return Number(d[0]) + '年' + Number(d[1]) + '月' + Number(d[2]) + '日 ' + pad(t[0]) + ':' + pad(t[1]);
    }
    return fmtCN(target, REMIND_HOUR);
  }
  if (String(key).indexOf('date') === 0) return fmtCNDate(target);
  return clipThing(fmtCNDate(target) + (timeHM ? ' ' + timeHM : ''));
}

/** 把北京时间 Date 转成 'YYYY-MM-DD HH:mm'，与客户端 remind_at 完全对齐 */
function beijingMinute(d) {
  d = d || beijingDate(0);
  return fmtISO(d) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
}

/** 一次取出多天到期的待办（默认今天 + 明天），只要没设具体时间的 */
async function fetchDueTasks(targets) {
  var all = [], skip = 0;
  while (skip < 2000) {
    var r = await db.collection(COLLECTION)
      .where({ due_date: _.in(targets), status: 'todo', due_time: _.in(['', null]) })
      .skip(skip).limit(100).get();
    var rows = r.data || [];
    all = all.concat(rows);
    if (rows.length < 100) break;
    skip += 100;
  }
  return all;
}

/** 取出 remind_at 正好等于当前分钟、且未删除的待办 */
async function fetchAtTasks(minute) {
  var all = [], skip = 0;
  while (skip < 2000) {
    var r = await db.collection(COLLECTION)
      .where({ remind_at: minute, status: 'todo' })
      .skip(skip).limit(100).get();
    var rows = r.data || [];
    all = all.concat(rows);
    if (rows.length < 100) break;
    skip += 100;
  }
  return all;
}

/** 同一分钟重试时不重复下发；日志集合不存在时返回 false，不阻断发送 */
async function alreadySent(openid, minute) {
  try {
    var r = await db.collection(LOG_COLLECTION)
      .where({ type: 'at', openid: openid, remindAt: minute })
      .limit(1).get();
    return (r.data || []).length > 0;
  } catch (e) { return false; }
}

/** 标题行的概览文案：有今天用今天兜底，两天都有就合并口径 */
function buildTip(a, b) {
  if (a && b) return '今明两天共' + (a + b) + '件待办';
  if (a) return '今天有' + a + '件待办';
  return '明天有' + b + '件待办';
}

/**
 * 内容行：把任务名串成一条 ≤max 字的摘要。
 * 能列则逐条列（、分隔），列不完时以「等N件」收尾，让总数一目了然；
 * 第一条就放不下时退化为单条截断。
 */
function joinTitles(titles, max) {
  var parts = [], leftover = 0;
  for (var i = 0; i < titles.length; i++) {
    var t = clipThing(titles[i]);
    var next = parts.length ? parts.join('、') + '、' + t : t;
    if (next.length > max - 4) { leftover = titles.length - i; break; }  // 预留「等N件」的位置
    parts.push(t);
  }
  if (!parts.length) return clipThing(titles[0]);
  var s = parts.join('、');
  if (leftover) s += '等' + titles.length + '件';
  return s;
}
/** 没勾「总是保持以上选择」时，第二天大概率额度已空，给个可读的原因 */
function hintReason(reason) {
  var s = String(reason || '');
  if (s.indexOf('43101') >= 0 || s.indexOf('拒绝') >= 0) {
    return s + '（订阅额度已用完：小程序内新建/完成一次任务会自动续期）';
  }
  return s;
}

/**
 * 写一条发送记录到 remind_log。写失败（集合未建）只告警，不影响主流程。
 * 集合不存在时的错误码是 -502005，控制台建一下同名集合即可开始记录。
 */
async function writeLog(doc) {
  try {
    await db.collection(LOG_COLLECTION).add({
      data: Object.assign({ at: new Date().toISOString(), ts: Date.now() }, doc)
    });
    return '';
  } catch (e) {
    var msg = String((e && (e.errMsg || e.errmsg || e.message)) || e);
    console.warn('[remind] 写日志失败（集合 ' + LOG_COLLECTION + ' 可能未创建）', msg);
    return msg;
  }
}

/**
 * 清理过期日志；集合未建或为空时静默跳过。
 * 只在每天 8:00 的汇总里调用一次——触发器每分钟跑，跟着清会把删除请求放大 1440 倍。
 * 返回删除条数，便于在 run 日志里观察。
 */
async function pruneLog() {
  try {
    var cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
    var r = await db.collection(LOG_COLLECTION).where({ ts: _.lt(cutoff) }).remove();
    var n = (r && r.stats && r.stats.removed) || 0;
    if (n) console.log('[remind] 已清理过期日志', n, '条');
    return n;
  } catch (e) { return 0; }
}

function buildData(fields, values) {
  var data = {};
  Object.keys(fields).forEach(function (k) {
    data[fields[k]] = { value: values[k] };
  });
  return data;
}

async function sendWithFallback(openid, target, baseValues, timeHM) {
  var sets = await getFieldSets();
  var lastErr = null;
  for (var i = 0; i < sets.length; i++) {
    var fields = sets[i];
    var values = Object.assign({}, baseValues, { due: dueValue(fields.due, target, timeHM) });
    try {
      await cloud.openapi.subscribeMessage.send({
        touser: openid,
        templateId: TEMPLATE_ID,
        page: PAGE,
        miniprogramState: MINIPROGRAM_STATE,
        lang: 'zh_CN',
        data: buildData(fields, values)
      });
      return { ok: true, fields: fields };
    } catch (e) {
      lastErr = e;
      var code = e && (e.errCode || e.errcode);
      var msg = String((e && (e.errMsg || e.errmsg)) || '');
      // 云调用鉴权失败：控制台「云端测试」/CLI 没有微信侧上下文，必须从小程序端触发
      if (code === -501001 || code === -501007 ||
          msg.indexOf('access_token') >= 0 || msg.indexOf('wxCloudApiToken') >= 0) {
        return { ok: false, reason: '云调用鉴权失败：需从小程序端触发（云开发控制台「云端测试」没有用户上下文）' };
      }
      // 47003 = 模板参数不准确（字段名/类型/值格式不对），换一组字段名重试
      if (code !== 47003 && msg.indexOf('参数') < 0) {
        return { ok: false, reason: code + ' ' + msg };
      }
    }
  }
  return {
    ok: false,
    reason: '字段名或值格式不匹配：' + String(lastErr && (lastErr.errMsg || lastErr.errmsg || ''))
  };
}

/**
 * 每分钟由定时触发器调用：
 *   1) remind_at === 当前北京时间（精确到分钟）的任务，按 openid 合并后到点发一条；
 *   2) 仅每天 8:00 对「没设具体时间」的任务做今天 + 明天汇总（原来的行为）。
 * 一次性订阅：用户授权一次只能收一条，额度用完微信会拒发；同一分钟去重靠 remind_log。
 * 在云开发控制台传 { "dryRun": true } 只扫描不发送；{ "forceDaily": true } 强制跑一次汇总。
 */
exports.main = async (event) => {
  // 测试模式：从小程序端调用（带云调用上下文），直接给当前用户发一条，不依赖定时扫描
  if (event && event.test) {
    var testOpenid = cloud.getWXContext().OPENID;
    if (!testOpenid) {
      return { ok: false, reason: '请从小程序端调用；云开发控制台测试拿不到用户 openid' };
    }
    var testTarget = fmtISO(beijingDate(DAYS_BEFORE));
    var testResult = await sendWithFallback(testOpenid, testTarget, {
      title: clipThing('测试提醒'),
      tip: clipThing('这是一条测试提醒')
    });
    var testLogError = await writeLog({
      type: 'test',
      openid: testOpenid,
      target: testTarget,
      ok: testResult.ok,
      reason: testResult.ok ? '' : String(testResult.reason || ''),
      fields: testResult.fields || null
    });
    return {
      ok: testResult.ok,
      reason: testResult.reason || '',
      fields: testResult.fields || null,
      target: testTarget,
      openid: testOpenid,
      logError: testLogError
    };
  }

  var now = beijingDate(0);
  var minute = beijingMinute(now);
  var dry = !!(event && event.dryRun);
  var summary = {
    minute: minute, dryRun: dry,
    at: { users: 0, tasks: 0, sent: 0, failed: [] },
    daily: null, pruned: 0, logError: ''
  };

  /* ---------- 1. 到点提醒（设了具体时间的任务） ---------- */
  var atRows = [];
  try {
    atRows = await fetchAtTasks(minute);
  } catch (e) {
    summary.at.error = '查询失败：' + String(e && e.message);
    console.error('[remind] 到点任务查询失败', e);
  }
  var atGroups = {};
  atRows.forEach(function (t) {
    if (t.deleted_at) return;
    var oid = t._openid || t.openid;
    if (!oid) return;
    if (!atGroups[oid]) atGroups[oid] = [];
    atGroups[oid].push(t);
    summary.at.tasks++;
  });
  var atOpenids = Object.keys(atGroups);
  summary.at.users = atOpenids.length;

  if (!dry) {
    for (var a = 0; a < atOpenids.length; a++) {
      var oidA = atOpenids[a];
      if (await alreadySent(oidA, minute)) {
        summary.at.failed.push({ openid: oidA, reason: '本分钟已发过，跳过重复提醒' });
        continue;
      }
      var listA = atGroups[oidA];
      var firstA = listA[0];
      var timeA = String(firstA.due_time || '').slice(0, 5);
      var valuesA = {
        title: clipThing(firstA.title),
        tip: joinTitles(listA.map(function (x) { return x.title; }), 20)
      };
      var rA = await sendWithFallback(
        oidA, String(firstA.due_date || '').slice(0, 10), valuesA, timeA
      );
      var reasonA = rA.ok ? '' : hintReason(rA.reason);
      if (rA.ok) {
        summary.at.sent++;
        console.log('[remind] 到点提醒已发送', oidA, JSON.stringify(rA.fields));
      } else {
        summary.at.failed.push({ openid: oidA, reason: reasonA });
        console.warn('[remind] 到点提醒未送达', oidA, reasonA);
      }
      summary.logError = await writeLog({
        type: 'at', openid: oidA, remindAt: minute,
        taskIds: listA.map(function (x) { return x.id || x._id; }),
        target: firstA.due_date, time: timeA,
        title: valuesA.title, tip: valuesA.tip,
        ok: rA.ok, reason: reasonA, fields: rA.ok ? rA.fields : null
      }) || summary.logError;
    }
  }

  /* ---------- 2. 每天 8:00 汇总（没设具体时间的任务） ---------- */
  var isDaily = now.getUTCHours() === REMIND_HOUR && now.getUTCMinutes() === 0;
  if (event && event.forceDaily) isDaily = true;
  if (isDaily) {
    var today = fmtISO(beijingDate(0));
    var tomorrow = fmtISO(beijingDate(1));
    var targets = REMIND_DAYS.map(function (d) { return fmtISO(beijingDate(d)); });
    var daily = {
      today: today, tomorrow: tomorrow,
      users: 0, tasks: 0, tasksToday: 0, tasksTomorrow: 0,
      sent: 0, failed: []
    };
    summary.daily = daily;

    var rows = [];
    try {
      rows = await fetchDueTasks(targets);
    } catch (e) {
      console.error('[remind] 汇总任务查询失败', e);
      daily.error = '查询任务失败：' + String(e && e.message);
      rows = [];
    }
    var groups = {};
    rows.forEach(function (t) {
      if (t.deleted_at || t.due_time) return;
      var oid = t._openid || t.openid;
      if (!oid) return;
      if (!groups[oid]) groups[oid] = { today: [], tomorrow: [] };
      var bucket = t.due_date === today ? 'today' : 'tomorrow';
      groups[oid][bucket].push(t);
      daily.tasks++;
      if (bucket === 'today') daily.tasksToday++;
      else daily.tasksTomorrow++;
    });
    var openids = Object.keys(groups);
    daily.users = openids.length;

    if (!dry) {
      for (var i = 0; i < openids.length; i++) {
        var oid = openids[i];
        var g = groups[oid];
        // 有今天的任务就用今天做主日期；标题给概览，内容列具体事项
        var primary = g.today.length ? g.today : g.tomorrow;
        var primaryDate = g.today.length ? today : tomorrow;
        var values = {
          title: clipThing(buildTip(g.today.length, g.tomorrow.length)),
          tip: joinTitles(
            g.today.concat(g.tomorrow).map(function (x) { return x.title; }), 20)
        };
        var r = await sendWithFallback(oid, primaryDate, values, '');
        var reason = r.ok ? '' : hintReason(r.reason);
        if (r.ok) {
          daily.sent++;
          console.log('[remind] 汇总已发送', oid, JSON.stringify(r.fields));
        } else {
          daily.failed.push({ openid: oid, reason: reason });
          console.warn('[remind] 汇总未送达', oid, reason);
        }
        summary.logError = await writeLog({
          type: 'send',
          openid: oid,
          today: today, tomorrow: tomorrow,
          todayCount: g.today.length,
          tomorrowCount: g.tomorrow.length,
          target: primaryDate,
          title: primary[0].title,
          tip: values.tip,
          ok: r.ok,
          reason: reason,
          fields: r.ok ? r.fields : null
        }) || summary.logError;
      }
    }

    // 维护动作一天一次就够：清理过期日志固定跟着 8:00 这趟汇总跑，dryRun 时不动数据
    if (!dry) summary.pruned = await pruneLog();
  }

  // 每分钟都写 run 日志会产生大量无用数据，只在有动作或跑了汇总时记一条；dryRun 不留痕
  if (!dry && (summary.at.sent || summary.at.failed.length || summary.daily)) {
    summary.logError = await writeLog({
      type: 'run', ok: true, minute: minute,
      atTasks: summary.at.tasks, atSent: summary.at.sent,
      pruned: summary.pruned || 0,
      daily: summary.daily ? {
        tasks: summary.daily.tasks, users: summary.daily.users,
        sent: summary.daily.sent, failedCount: summary.daily.failed.length
      } : null
    }) || summary.logError;
  }

  console.log('[remind] 汇总', JSON.stringify(summary));
  return summary;
};
