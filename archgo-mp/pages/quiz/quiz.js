/**
 * 自测页：术语 ↔ 释义双向随机出题，答错自动进难词本。
 * 出题 / 判分逻辑与 Web 纯净版 startQuiz / answer / showQuizResult 一致。
 */
const C = require('../../libs/common.js');
const Store = C.Store;

var COUNTS = [5, 10, 20];

Page({
  data: {
    theme: 'dark',
    phase: 'start',           // start | play | result
    counts: COUNTS,
    count: 5,
    // 答题中
    idx: 0,
    total: 0,
    pct: 0,
    q: '',                    // 题干
    tip: '',                  // 副标题（日语提示 + 题型说明）
    options: [],              // { id, text, state: '' | 'right' | 'wrong' }
    answered: false,
    feedback: '',             // 判分反馈（术语 + 释义）
    nextLabel: '下一题',
    // 结果
    right: 0,
    wrongCount: 0,
    acc: '0%',
    wrongList: [],
    modal: { visible: false, term: null }
  },

  quiz: { list: [], i: 0, right: 0, wrong: [] },

  onShow: function () { C.syncTheme(this); },

  onCount: function (e) {
    this.setData({ count: +e.currentTarget.dataset.n });
  },

  onStart: function () {
    this.startQuiz(this.data.count);
  },

  startQuiz: function (n) {
    var pool = C.TERMS.slice();
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    this.quiz.list = pool.slice(0, Math.min(n, pool.length)).map(function (t) {
      return { id: t.t, type: Math.random() < 0.5 ? 0 : 1 };
    });
    this.quiz.i = 0;
    this.quiz.right = 0;
    this.quiz.wrong = [];

    this.setData({ phase: 'play', total: this.quiz.list.length, wrongList: [] });
    this.renderQuestion();
  },

  renderQuestion: function () {
    if (this.quiz.i >= this.quiz.list.length) { this.showResult(); return; }
    var q = this.quiz.list[this.quiz.i];
    var t = C.byId[q.id];

    this.setData({
      idx: this.quiz.i,
      total: this.quiz.list.length,
      pct: Math.round(this.quiz.i / this.quiz.list.length * 100),
      q: q.type === 0 ? t.t : (t.d || ''),
      tip: (t.ja ? t.ja + '　·　' : '') + (q.type === 0 ? '选出正确的释义' : '选出对应的术语'),
      options: C.pickOptions(t, q.type).map(function (o) {
        return { id: o.id, text: o.text, state: '' };
      }),
      answered: false,
      feedback: '',
      nextLabel: this.quiz.i === this.quiz.list.length - 1 ? '看结果' : '下一题'
    });
  },

  onAnswer: function (e) {
    if (this.data.answered) return;
    var chosen = e.currentTarget.dataset.id;
    var q = this.quiz.list[this.quiz.i];
    var t = C.byId[q.id];
    var ok = chosen === q.id;
    wx.vibrateShort({ type: ok ? 'light' : 'medium' }).catch(function () {});

    var options = this.data.options.map(function (o) {
      if (o.id === q.id) o.state = 'right';
      else if (o.id === chosen) o.state = 'wrong';
      return o;
    });

    if (!ok) {
      this.quiz.wrong.push(q.id);
      Store.card(q.id).wrong++;
      Store.touch();
    } else {
      this.quiz.right++;
    }

    this.setData({
      options: options,
      answered: true,
      feedback: (ok ? '回答正确' : '回答错误') + '：' + t.t + (t.ja ? '　' + t.ja : '') + ' —— ' + (t.d || '')
    });
  },

  onNext: function () {
    this.quiz.i++;
    this.renderQuestion();
  },

  showResult: function () {
    var total = this.quiz.list.length;
    var wrongList = this.quiz.wrong.map(function (id) {
      return { t: C.byId[id].t, d: C.byId[id].d || '' };
    });
    this.setData({
      phase: 'result',
      right: this.quiz.right,
      wrongCount: this.quiz.wrong.length,
      acc: total ? Math.round(this.quiz.right / total * 100) + '%' : '0%',
      wrongList: wrongList
    });
  },

  onAgain: function () { this.setData({ phase: 'start' }); },

  onWrongTap: function (e) {
    this.setData({ modal: { visible: true, term: C.byId[e.currentTarget.dataset.name] || null } });
  },
  onModalClose: function () { this.setData({ 'modal.visible': false }); },
  onModalGoto: function (e) {
    this.setData({ 'modal.term': C.byId[e.detail.name] || null });
  }
});
