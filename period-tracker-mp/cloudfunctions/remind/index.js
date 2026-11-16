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
// 每天扫描的天数偏移：0 = 今天到期，1 = 明天到期。同一个人两类合并成一条通知。
const REMIND_DAYS = [0, 1];
const DAYS_BEFORE = 1;                 // 仅测试模式使用：测试文案里的目标日 = 明天
const REMIND_HOUR = 8;                 // 提醒文案里显示的时间，与定时触发器保持一致
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
 * getTemplateList 返回的 content 形如「日程时间:{{date4.DATA}} 日程标题:{{thing1.DATA}}…」，
 * 按出现顺序对应 日程时间 / 日程标题 / 提醒内容。
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

    var auto = { due: keys[0], title: keys[1], tip: keys[2] };
    console.log('[remind] 模板字段（自动读取）', JSON.stringify(auto));
    return [auto].concat(FIELD_SETS);
  } catch (e) {
    console.warn('[remind] 自动读取模板字段失败，改用候选组', e && (e.errMsg || e.errmsg || e.message));
    return FIELD_SETS;
  }
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
/** 按字段类型决定日期值的格式：time 带时分、date 只要日期、thing 当短文本 */
function dueValue(key, target) {
  if (String(key).indexOf('time') === 0) return fmtCN(target, REMIND_HOUR);
  if (String(key).indexOf('date') === 0) return fmtCNDate(target);
  return clipThing(fmtCNDate(target));
}

/** 一次取出多天到期的待办（默认今天 + 明天） */
async function fetchDueTasks(targets) {
  var all = [], skip = 0;
  while (skip < 2000) {
    var r = await db.collection(COLLECTION)
      .where({ due_date: _.in(targets), status: 'todo' })
      .skip(skip).limit(100).get();
    var rows = r.data || [];
    all = all.concat(rows);
    if (rows.length < 100) break;
    skip += 100;
  }
  return all;
}

/** 通知正文：两天的件数合并成一句，thing 类型限 20 字，超出由 clipThing 截断 */
function buildTip(a, b) {
  if (a && b) return '今天' + a + '件，明天' + b + '件';
  if (a) return '今天有' + a + '件待办';
  return '明天有' + b + '件待办';
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

/** 顺手清理过期日志；集合未建或为空时静默跳过 */
async function pruneLog() {
  try {
    var cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
    await db.collection(LOG_COLLECTION).where({ ts: _.lt(cutoff) }).remove();
  } catch (e) { /* 忽略 */ }
}

function buildData(fields, values) {
  var data = {};
  Object.keys(fields).forEach(function (k) {
    data[fields[k]] = { value: values[k] };
  });
  return data;
}

async function sendWithFallback(openid, target, baseValues) {
  var sets = await getFieldSets();
  var lastErr = null;
  for (var i = 0; i < sets.length; i++) {
    var fields = sets[i];
    var values = Object.assign({}, baseValues, { due: dueValue(fields.due, target) });
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
 * 每天定时扫描「今天到期 + 明天到期」的待办，按 openid 汇总后各发一条订阅消息。
 * 两类合并成一条，既照顾当天要做的事，也不多发一条浪费订阅额度。
 * 一次性订阅：用户授权一次只能收一条，额度用完时微信会拒绝，不会重复打扰；
 * 因此不需要额外的去重集合。每次运行结果写入 remind_log 便于回溯。
 * 在云开发控制台传 { "dryRun": true } 可只扫描不发送，用于自检。
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

  var today = fmtISO(beijingDate(0));
  var tomorrow = fmtISO(beijingDate(1));
  var targets = REMIND_DAYS.map(function (d) { return fmtISO(beijingDate(d)); });

  var summary = {
    today: today, tomorrow: tomorrow,
    users: 0, tasks: 0, tasksToday: 0, tasksTomorrow: 0,
    sent: 0, failed: [], logError: ''
  };

  var rows;
  try {
    rows = await fetchDueTasks(targets);
  } catch (e) {
    console.error('[remind] 查询失败', e);
    summary.error = '查询任务失败：' + String(e && e.message);
    summary.logError = await writeLog({ type: 'run', ok: false, error: summary.error, today: today, tomorrow: tomorrow });
    return summary;
  }

  var groups = {};
  rows.forEach(function (t) {
    if (t.deleted_at) return;
    var oid = t._openid || t.openid;
    if (!oid) return;
    if (!groups[oid]) groups[oid] = { today: [], tomorrow: [] };
    var bucket = t.due_date === today ? 'today' : 'tomorrow';
    groups[oid][bucket].push(t);
    summary.tasks++;
    if (bucket === 'today') summary.tasksToday++;
    else summary.tasksTomorrow++;
  });

  var openids = Object.keys(groups);
  summary.users = openids.length;
  if (event && event.dryRun) return summary;

  for (var i = 0; i < openids.length; i++) {
    var oid = openids[i];
    var g = groups[oid];
    // 有今天的任务就用今天做主日期（标题取第一条），否则退到明天
    var primary = g.today.length ? g.today : g.tomorrow;
    var primaryDate = g.today.length ? today : tomorrow;
    var values = {
      title: clipThing(primary[0].title),
      tip: clipThing(buildTip(g.today.length, g.tomorrow.length))
    };
    var r = await sendWithFallback(oid, primaryDate, values);
    var reason = r.ok ? '' : hintReason(r.reason);
    if (r.ok) {
      summary.sent++;
      console.log('[remind] 已发送', oid, JSON.stringify(r.fields));
    } else {
      summary.failed.push({ openid: oid, reason: reason });
      console.warn('[remind] 未送达', oid, reason);
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

  summary.logError = await writeLog({
    type: 'run',
    ok: true,
    today: today, tomorrow: tomorrow,
    users: summary.users, tasks: summary.tasks,
    tasksToday: summary.tasksToday, tasksTomorrow: summary.tasksTomorrow,
    sent: summary.sent, failedCount: summary.failed.length
  }) || summary.logError;

  await pruneLog();
  console.log('[remind] 汇总', JSON.stringify(summary));
  return summary;
};
