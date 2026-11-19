const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

/* ===================== 配置区（按后台模板改这里） ===================== */
// mp.weixin.qq.com → 功能 → 订阅消息 → 我的模板 →「日程提醒」（一次性订阅）
const TEMPLATE_ID = 'EPvaF7BUcvy5Pg5bseZBDFLWE2jxNaMNYUz70YrfJsw';
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

// 只使用模板里的两个字段：日程时间 / 提醒内容（见 LABEL_RULES）。
// 「日程标题」不填，模板里留空即可；等后台把模板改成两字段后代码无需再动。
// 正常无需配置；若接口读不到模板（没权限、模板被删），在这里手填一次：
// const FIELD_MAP = { due: 'time1', tip: 'thing2' };
const FIELD_MAP = null;
/* ==================================================================== */

/** 从模板定义里拆出「标签 → 字段名」对，如 日程标题:{{thing1.DATA}} */
function parseFields(text) {
  var out = [], re = /([^:：{}\s]+)\s*[:：]\s*\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\.DATA\s*\}\}/g, m;
  while ((m = re.exec(String(text || ''))) !== null) {
    out.push({ label: m[1], key: m[2] });
  }
  return out;
}

/** 标签关键词：先时间、再内容。只认这两个角色，标题字段一律不碰 */
const LABEL_RULES = [
  { role: 'due', re: /时间|日期|时刻|time|date/i },
  { role: 'tip', re: /内容|说明|备注|详情|描述|content|detail/i }
];

/**
 * 按标签给字段分配角色，不做任何按位置的猜测。
 * 时间和内容都认出来才返回；缺一个就返回 null，由调用方明确报错。
 */
function pickFields(text) {
  var roles = { due: null, tip: null };
  parseFields(text).forEach(function (p) {
    for (var i = 0; i < LABEL_RULES.length; i++) {
      var r = LABEL_RULES[i];
      if (roles[r.role] || !r.re.test(p.label)) continue;
      roles[r.role] = p.key;
      break;
    }
  });
  if (!roles.due || !roles.tip) return null;
  if (roles.due === roles.tip) return null;
  return roles;
}

/**
 * 直接问微信要这个模板的真实字段名，不再猜编号。
 * getTemplateList 返回的 content 形如「日程时间:{{date4.DATA}} 日程标题:{{thing1.DATA}} …」，
 * 角色按字段的**中文标签**识别（见 pickFields），认不出就明确失败，不猜字段名。
 */
async function getFields() {
  if (FIELD_MAP && FIELD_MAP.due && FIELD_MAP.tip) return FIELD_MAP;
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
    if (!tpl) {
      console.warn('[remind] 模板列表里没找到', TEMPLATE_ID);
      return null;
    }
    console.log('[remind] 模板原始信息', JSON.stringify({
      id: tpl.priTmplId, title: tpl.title, content: tpl.content, example: tpl.example
    }));

    var fields = pickFields(tpl.content) || pickFields(tpl.example);
    if (!fields) {
      console.warn('[remind] 模板字段识别失败，未发送。content=', tpl.content);
      return null;
    }
    console.log('[remind] 模板字段（按标签识别）', JSON.stringify(fields));
    return fields;
  } catch (e) {
    console.warn('[remind] 读取模板字段失败', e && (e.errMsg || e.errmsg || e.message));
    return null;
  }
}

// 注意：'09' 这类字符串参与 < 10 比较会被转成数字，再补零就成了 '009'，所以先取整
function pad(n) { n = Number(n) || 0; return n < 10 ? '0' + n : String(n); }

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

/**
 * 提醒内容：纯粹罗列任务标题，用「、」连接，不加任何日期、件数或模糊描述。
 * 排序按到期日由近到远：今天的在前、明天的在后，先看到最该做的；
 * 超过 20 字（thing 上限）直接截断，不写「等N件」之类的统计。
 */
function buildTip(todayTitles, tomorrowTitles) {
  var titles = todayTitles.concat(tomorrowTitles);
  if (!titles.length) return '';
  return clipThing(titles.join('、'));
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

/**
 * 按模板字段发一条订阅消息。
 * 字段识别不出来就直接失败并给出原因，不再猜字段名重试——
 * 猜错会把标题和内容填反，比不发更糟，也不容易发现。
 */
async function sendOnce(openid, target, baseValues, timeHM) {
  var fields = await getFields();
  if (!fields) {
    return {
      ok: false,
      reason: '未识别到模板字段：确认模板含「日程时间」「提醒内容」两个关键词，或在云函数配置区填 FIELD_MAP'
    };
  }
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
    var code = e && (e.errCode || e.errcode);
    var msg = String((e && (e.errMsg || e.errmsg)) || '');
    // 云调用鉴权失败：控制台「云端测试」/CLI 没有微信侧上下文，必须从小程序端触发
    if (code === -501001 || code === -501007 ||
        msg.indexOf('access_token') >= 0 || msg.indexOf('wxCloudApiToken') >= 0) {
      return { ok: false, reason: '云调用鉴权失败：需从小程序端触发（云开发控制台「云端测试」没有用户上下文）' };
    }
    if (code === 47003 || msg.indexOf('参数') >= 0) {
      return { ok: false, reason: '47003 模板参数不匹配（字段类型/值格式与模板不符）：' + msg };
    }
    return { ok: false, reason: code + ' ' + msg };
  }
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
    var testResult = await sendOnce(testOpenid, testTarget, {
      tip: clipThing('测试提醒：收到说明时间与内容都对')
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
        tip: buildTip(listA.map(function (x) { return x.title; }), [])
      };
      var rA = await sendOnce(
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
        target: firstA.due_date, time: timeA, count: listA.length,
        tip: valuesA.tip,
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
        // 有今天的任务就用今天做主日期；内容只放事项，不再单独填标题字段
        var primaryDate = g.today.length ? today : tomorrow;
        var values = {
          tip: buildTip(
            g.today.map(function (x) { return x.title; }),
            g.tomorrow.map(function (x) { return x.title; })
          )
        };
        var r = await sendOnce(oid, primaryDate, values, '');
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
