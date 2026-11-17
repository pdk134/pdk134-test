/**
 * 共享逻辑：术语索引、状态标签、学习队列、出题选项、统计口径。
 * 与 Web 纯净版 app.js 中的同名逻辑保持一致（算法原样移植）。
 */
const Store = require('./store.js');
const SRS = require('./srs.js');
const TERMS = require('../data/terms.js');

var byId = {};
var CATS = [];
TERMS.forEach(function (t) {
  byId[t.t] = t;
  if (CATS.indexOf(t.c) < 0) CATS.push(t.c);
});

function levelText(lv) { return ['', '基础', '进阶', '高阶'][lv] || '基础'; }

function statusLabel(id) {
  var s = SRS.statusOf(Store.raw(id));
  if (s === 'new') return { text: '未学习', cls: '' };
  if (s === 'mastered') return { text: '已掌握', cls: 'mastered' };
  return { text: '学习中', cls: 'learning' };
}

/** 今日学习队列：到期复习优先（按到期时间升序），再补新词；受每日配额限制 */
function buildQueue(extra) {
  var now = Date.now(), s = Store.data.settings;
  var due = [], fresh = [];
  TERMS.forEach(function (t) {
    var c = Store.raw(t.t);
    if (!c || c.reps === 0) fresh.push(t.t);
    else if ((c.due || 0) <= now) due.push({ id: t.t, due: c.due });
  });
  due.sort(function (a, b) { return a.due - b.due; });

  var limR = extra ? due.length : s.dailyReview;
  var limN = extra ? s.dailyNew + extra : s.dailyNew;
  var items = due.slice(0, limR).map(function (x) { return { id: x.id, kind: 'review' }; })
    .concat(fresh.slice(0, limN).map(function (id) { return { id: id, kind: 'new' }; }));
  return { items: items, dueTotal: due.length, newTotal: fresh.length };
}

/** 自测选项：同分类凑 3 个干扰项（不够则全库），与正确答案一起打乱 */
function pickOptions(t, type) {
  var others = TERMS.filter(function (x) { return x.t !== t.t; });
  var same = others.filter(function (x) { return x.c === t.c; });
  var src = same.length >= 3 ? same : others;
  var picked = [], used = {};
  while (picked.length < 3 && picked.length < src.length) {
    var k = Math.floor(Math.random() * src.length);
    if (used[k]) continue;
    used[k] = 1;
    picked.push(src[k]);
  }
  var opts = picked.map(function (x) { return { id: x.t, text: type === 0 ? (x.d || '') : x.t }; });
  opts.push({ id: t.t, text: type === 0 ? (t.d || '') : t.t });
  for (var i = opts.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = opts[i]; opts[i] = opts[j]; opts[j] = tmp;
  }
  return opts;
}

function countStatus() {
  var r = { total: TERMS.length, learned: 0, mastered: 0, due: 0, new: 0 };
  var now = Date.now();
  TERMS.forEach(function (t) {
    var c = Store.raw(t.t), s = SRS.statusOf(c);
    if (s === 'new') r.new++;
    else {
      r.learned++;
      if (s === 'mastered') r.mastered++;
      if ((c.due || 0) <= now) r.due++;
    }
  });
  return r;
}

/** 把当前主题同步到页面 data.theme（页面根视图 class 绑定 theme-{{theme}}，切换后 onShow 自动生效） */
function syncTheme(page) {
  var th = Store.data.settings.theme || 'dark';
  if (page.data.theme !== th) page.setData({ theme: th });
}

module.exports = {
  TERMS: TERMS, byId: byId, CATS: CATS,
  Store: Store, SRS: SRS,
  levelText: levelText, statusLabel: statusLabel,
  buildQueue: buildQueue, pickOptions: pickOptions, countStatus: countStatus,
  syncTheme: syncTheme
};
